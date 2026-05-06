// Phase 3: Today view + stage_pass logging.
// Shell renders login or signed-in app. Signed-in app fetches the
// current week's plan, the user's tracks, and all events from the API,
// then renders the today view with tap-to-log buttons. Stage passes
// land via the same /v1/training/events endpoint.

// ----- API -----

async function loadConfig() {
  const res = await fetch("/data/api_base.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
  return res.json();
}

async function loadSha() {
  const res = await fetch("/version.txt", { cache: "no-store" });
  return res.ok ? (await res.text()).trim() : "dev";
}

async function api(apiBase, path, opts = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    ...opts,
  });
  if (!res.ok) {
    throw new Error(`${opts.method || "GET"} ${path}: ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

async function getMe(apiBase) {
  const res = await fetch(`${apiBase}/v1/me`, { credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`/v1/me failed: ${res.status}`);
  return res.json();
}

async function logout(apiBase) {
  await fetch(`${apiBase}/v1/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

const listPlans = (apiBase) => api(apiBase, "/v1/training/plans");
const listTracks = (apiBase) => api(apiBase, "/v1/training/tracks");
const listEvents = (apiBase) => api(apiBase, "/v1/training/events");

const postEvent = (apiBase, payload) =>
  api(apiBase, "/v1/training/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

// ----- Helpers -----

function isoFromDate(d) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function todayLocalISO() {
  return isoFromDate(new Date());
}

function dayLabel(iso) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const d = new Date(iso + "T00:00:00");
  return `${days[d.getDay()]} · ${iso}`;
}

function isoAddDays(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return isoFromDate(d);
}

function isoMonday(iso) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoFromDate(d);
}

function monthDay(iso) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const d = new Date(iso + "T00:00:00");
  return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2, "0")}`;
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style") {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith("--")) node.style.setProperty(sk, sv);
        else node.style[sk] = sv;
      }
    }
    else if (k === "onclick") node.addEventListener("click", v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// ----- Domain -----

function entryDone(events, slug, date, unit) {
  const matching = events.filter(
    (e) => e.local_date === date && e.exercise === slug,
  );
  if (unit === "reps" || unit === "walks") {
    return matching.reduce((s, e) => s + (e.reps || 1), 0);
  }
  if (unit === "duration_s") {
    return matching.reduce((s, e) => s + (e.duration_s || 0), 0);
  }
  if (unit === "session") return matching.length > 0 ? 1 : 0;
  return 0;
}

function currentStage(events, trackSlug) {
  let max = 0;
  for (const e of events) {
    if (e.kind === "stage_pass" && e.track === trackSlug && typeof e.stage === "number") {
      if (e.stage > max) max = e.stage;
    }
  }
  return max;
}

const HIGHLIGHT_KINDS = ["stage_pass", "run", "session"];

function highlightsByDate(events) {
  const byDate = {};
  for (const e of events) {
    if (!HIGHLIGHT_KINDS.includes(e.kind)) continue;
    if (!byDate[e.local_date]) byDate[e.local_date] = new Set();
    byDate[e.local_date].add(e.kind);
  }
  return byDate;
}

function buildWeeks(today, weeks, byDate) {
  const todayMon = isoMonday(today);
  const rows = [];
  for (let w = 0; w < weeks; w++) {
    const mon = isoAddDays(todayMon, -7 * w);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = isoAddDays(mon, i);
      days.push({
        date,
        kinds: byDate[date] || new Set(),
        future: date > today,
        today: date === today,
      });
    }
    rows.push({ mon, days });
  }
  return rows;
}

function buildEventPayload(entry, viewDate) {
  const ts = new Date().toISOString();
  const base = { ts, local_date: viewDate, exercise: entry.slug };
  if (entry.unit === "reps" || entry.unit === "walks") {
    return { ...base, kind: "set", reps: entry.per_set };
  }
  if (entry.unit === "duration_s") {
    return { ...base, kind: "hold", duration_s: entry.per_set };
  }
  if (entry.unit === "session") {
    return { ...base, kind: entry.slug === "run" ? "run" : "session" };
  }
  return null;
}

// ----- Render: meta, login, error -----

const meta = (apiBase, sha) =>
  el("p", { class: "meta" }, apiBase, " · ", sha);

function renderLogin(root, { apiBase, sha }) {
  const next = encodeURIComponent(window.location.origin + "/");
  const href = `${apiBase}/v1/auth/google/login?next=${next}`;
  root.replaceChildren(
    el("section", { class: "auth-screen" },
      el("h1", {}, "training"),
      el("p", { class: "muted" }, "Log today's plan, review the week."),
      el("a", { class: "btn-primary", href }, "Continue with Google"),
      meta(apiBase, sha),
    ),
  );
  root.removeAttribute("aria-busy");
}

function renderError(root, message, ctx = {}) {
  root.replaceChildren(
    el("section", { class: "auth-screen" },
      el("h1", {}, "training"),
      el("p", { class: "muted" }, message),
      ctx.apiBase ? meta(ctx.apiBase, ctx.sha) : null,
    ),
  );
  root.removeAttribute("aria-busy");
}

// ----- Render: signed-in shell -----

function renderTopbar(state) {
  const onSignOut = async () => {
    await logout(state.apiBase);
    window.location.reload();
  };
  return el("header", { class: "topbar" },
    el("div", { class: "brand" }, "training"),
    el("div", { class: "user" },
      state.user.avatar_url
        ? el("img", { src: state.user.avatar_url, alt: "", class: "avatar" })
        : null,
      el("span", { class: "user-name" }, state.user.name || state.user.email),
      el("button", { class: "btn-link", onclick: onSignOut }, "Sign out"),
    ),
  );
}

function renderDayHeader(state, render) {
  const days = state.plan
    ? Object.keys(state.plan.body.days || {}).sort()
    : [];
  const idx = days.indexOf(state.viewDate);
  const eyebrowText = state.plan
    ? `Week of ${state.plan.week_start}`
    : "training";

  return el("header", { class: "day-header" },
    el("div", { class: "eyebrow" },
      el("span", { class: "dot" }),
      el("span", {}, eyebrowText),
    ),
    el("div", { class: "day-nav" },
      el("button", {
        class: "nav-btn",
        "aria-label": "Previous day",
        disabled: idx <= 0 ? "" : null,
        onclick: () => {
          if (idx > 0) {
            state.viewDate = days[idx - 1];
            render();
          }
        },
      }, "‹"),
      el("div", { class: "date-stack" },
        el("h1", {}, state.viewDate ? dayLabel(state.viewDate) : "—"),
        state.viewDate === state.today
          ? el("span", { class: "today-tag" }, "· Today ·")
          : state.viewDate > state.today
            ? el("span", { class: "today-tag muted" }, "· Future (read-only) ·")
            : null,
      ),
      el("button", {
        class: "nav-btn",
        "aria-label": "Next day",
        disabled: idx < 0 || idx >= days.length - 1 ? "" : null,
        onclick: () => {
          if (idx >= 0 && idx < days.length - 1) {
            state.viewDate = days[idx + 1];
            render();
          }
        },
      }, "›"),
    ),
  );
}

function renderEntry(state, entry, render) {
  const done = entryDone(state.events, entry.slug, state.viewDate, entry.unit);
  const isDone = done >= entry.target_total;
  const pct = Math.min(100, (done / entry.target_total) * 100);
  const canLog = state.viewDate <= state.today;

  let spec;
  if (entry.unit === "reps") spec = `${entry.sets} × ${entry.per_set}`;
  else if (entry.unit === "walks") spec = `${entry.target_total}×`;
  else if (entry.unit === "duration_s") spec = `${entry.sets} × ${entry.per_set}s`;
  else spec = "session";

  let count;
  if (entry.unit === "reps") count = `${done} / ${entry.target_total} reps`;
  else if (entry.unit === "walks") count = `${done} / ${entry.target_total}`;
  else if (entry.unit === "duration_s") count = `${done}s / ${entry.target_total}s`;
  else count = isDone ? "done" : "—";

  let btnLabel;
  if (entry.unit === "session") btnLabel = isDone ? "✓" : "Done";
  else if (entry.unit === "duration_s") btnLabel = `+${entry.per_set}s`;
  else btnLabel = `+${entry.per_set}`;

  const onTap = async (event) => {
    if (!canLog) return;
    if (entry.unit === "session" && isDone) return;
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const payload = buildEventPayload(entry, state.viewDate);
      const created = await postEvent(state.apiBase, payload);
      state.events.push(created);
      render();
    } catch (err) {
      btn.disabled = false;
      toast(`Log failed: ${err.message}`);
    }
  };

  return el("div", {
    class: "ex" + (isDone ? " done" : ""),
    style: { "--pct": `${pct}%` },
  },
    el("div", { class: "ex-header" },
      el("span", { class: "ex-title" }, entry.display),
      el("span", { class: "ex-spec" }, spec),
    ),
    el("div", { class: "progress-bar" }),
    el("div", { class: "ex-footer" },
      el("span", { class: "ex-count" }, count),
      el("button", {
        class: "tap",
        disabled: !canLog ? "" : null,
        onclick: onTap,
      }, btnLabel),
    ),
  );
}

function renderPlanSection(state, render) {
  if (!state.plan) {
    return el("section", { class: "empty" },
      el("p", {}, "No plan yet."),
      el("p", { class: "muted" }, "Generate one in settings (coming soon)."),
    );
  }
  const entries = (state.plan.body.days || {})[state.viewDate] || [];
  if (entries.length === 0) {
    return el("section", { class: "empty" },
      el("p", {}, `Nothing planned for ${state.viewDate}.`),
      el("p", { class: "muted" }, "Rest day."),
    );
  }
  return el("section", { class: "plan-items" },
    ...entries.map((e) => renderEntry(state, e, render)),
  );
}

function renderStageRow(state, track, render) {
  const cur = currentStage(state.events, track.slug);
  const next = cur + 1;
  const nextStage = (track.stages || []).find((s) => s.n === next);

  const onPass = async () => {
    if (!nextStage) return;
    const note = window.prompt(
      `Confirm: passed stage ${next} of ${track.display}?\n\n${nextStage.test}\n\nOptional note (Cancel to abort):`,
      "",
    );
    if (note === null) return;
    const payload = {
      ts: new Date().toISOString(),
      local_date: state.today,
      kind: "stage_pass",
      track: track.slug,
      stage: next,
    };
    if (note.trim()) payload.note = note.trim();
    try {
      const created = await postEvent(state.apiBase, payload);
      state.events.push(created);
      render();
    } catch (err) {
      toast(`Stage pass failed: ${err.message}`);
    }
  };

  return el("div", { class: "track-row" },
    el("div", { class: "track-info" },
      el("div", { class: "track-name" }, track.display),
      el("div", { class: "track-stage muted" }, `stage ${cur}`),
    ),
    nextStage
      ? el("button", { class: "pass-btn", onclick: onPass },
          `Pass stage ${next}: ${nextStage.test}`)
      : el("span", { class: "muted" }, "All stages cleared."),
  );
}

function renderStageSection(state, render) {
  if (!state.tracks.length) return null;
  return el("section", { class: "stage-section" },
    el("h2", {}, "Track stages"),
    ...state.tracks.map((t) => renderStageRow(state, t, render)),
  );
}

function renderTabs(state, render) {
  const tabs = [
    { key: "today", label: "Today" },
    { key: "project", label: "Project" },
  ];
  return el("nav", { class: "tabs" },
    ...tabs.map((t) =>
      el("button", {
        class: "tab" + (state.view === t.key ? " active" : ""),
        onclick: () => {
          if (state.view === t.key) return;
          state.view = t.key;
          try { localStorage.setItem("view", t.key); } catch {}
          render();
        },
      }, t.label),
    ),
  );
}

function renderTodayMain(state, render) {
  return el("main", { class: "stage" },
    renderDayHeader(state, render),
    renderPlanSection(state, render),
    renderStageSection(state, render),
  );
}

function renderProjectMain(state) {
  const byDate = highlightsByDate(state.events);
  const rows = buildWeeks(state.today, 12, byDate);
  const dayLetters = ["M", "T", "W", "T", "F", "S", "S"];
  const hasAny = rows.some((r) => r.days.some((d) => d.kinds.size > 0));

  return el("main", { class: "stage" },
    el("header", { class: "day-header" },
      el("div", { class: "eyebrow" },
        el("span", { class: "dot" }),
        el("span", {}, "Last 12 weeks"),
      ),
    ),
    hasAny
      ? null
      : el("section", { class: "empty" },
          el("p", {}, "No stage passes, runs, or sessions yet."),
          el("p", { class: "muted" }, "Log on the Today tab and they'll show up here."),
        ),
    el("section", { class: "grid" },
      el("div", { class: "grid-row grid-head" },
        el("div", { class: "grid-date" }),
        ...dayLetters.map((d) => el("div", { class: "grid-day" }, d)),
      ),
      ...rows.map((row) => el("div", { class: "grid-row" },
        el("div", { class: "grid-date" }, monthDay(row.mon)),
        ...row.days.map((day) => el("div", {
          class: "grid-cell"
            + (day.today ? " today" : "")
            + (day.future ? " future" : "")
            + (day.kinds.size > 0 ? " has" : ""),
          title: day.kinds.size
            ? `${day.date} · ${[...day.kinds].join(", ")}`
            : day.date,
        },
          day.kinds.has("stage_pass") ? el("span", { class: "tick tick-pass" }) : null,
          day.kinds.has("run") ? el("span", { class: "tick tick-run" }) : null,
          day.kinds.has("session") ? el("span", { class: "tick tick-session" }) : null,
        )),
      )),
    ),
    el("section", { class: "legend" },
      el("div", { class: "legend-item" },
        el("span", { class: "tick tick-pass" }), "Stage pass"),
      el("div", { class: "legend-item" },
        el("span", { class: "tick tick-run" }), "Run"),
      el("div", { class: "legend-item" },
        el("span", { class: "tick tick-session" }), "Session"),
    ),
  );
}

function renderHome(root, state) {
  const render = () => renderHome(root, state);
  const main = state.view === "project"
    ? renderProjectMain(state)
    : renderTodayMain(state, render);
  root.replaceChildren(
    renderTopbar(state),
    renderTabs(state, render),
    main,
    el("footer", { class: "appfoot" }, meta(state.apiBase, state.sha)),
  );
  root.removeAttribute("aria-busy");
}

// ----- Toast -----

function toast(message) {
  const node = el("div", { class: "toast" }, message);
  document.body.append(node);
  setTimeout(() => node.classList.add("show"), 10);
  setTimeout(() => {
    node.classList.remove("show");
    setTimeout(() => node.remove(), 250);
  }, 2400);
}

// ----- Bootstrap -----

function pickViewDate(plan, today) {
  if (!plan) return today;
  const days = Object.keys(plan.body.days || {}).sort();
  if (days.includes(today)) return today;
  return days[0] || today;
}

async function bootstrap() {
  const root = document.getElementById("app");
  let config, sha;
  try {
    [config, sha] = await Promise.all([loadConfig(), loadSha()]);
  } catch (err) {
    renderError(root, `Failed to load config: ${err.message}`);
    return;
  }
  const apiBase = config.api_base;

  let user;
  try {
    user = await getMe(apiBase);
  } catch (err) {
    renderError(root, `Couldn't reach API: ${err.message}`, { apiBase, sha });
    return;
  }
  if (!user) {
    renderLogin(root, { apiBase, sha });
    return;
  }

  let plans, tracks, events;
  try {
    [plans, tracks, events] = await Promise.all([
      listPlans(apiBase),
      listTracks(apiBase),
      listEvents(apiBase),
    ]);
  } catch (err) {
    renderError(root, `Failed to load training data: ${err.message}`,
      { apiBase, sha });
    return;
  }

  const today = todayLocalISO();
  const plan = plans[0] || null;
  const state = {
    user, apiBase, sha,
    plan, tracks, events,
    today,
    viewDate: pickViewDate(plan, today),
    view: storedView(),
  };
  renderHome(root, state);
}

function storedView() {
  try {
    const v = localStorage.getItem("view");
    if (v === "today" || v === "project") return v;
  } catch {}
  return "today";
}

bootstrap();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(() => {});
}
