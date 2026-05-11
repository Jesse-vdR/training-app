// Phase 3: Today view + stage_pass logging.
// Shell renders login or signed-in app. Signed-in app fetches the
// current week's plan, the user's tracks, and all events from the API,
// then renders the today view with tap-to-log buttons. Stage passes
// land via the same /v1/training/events endpoint.

import { Shell, heatColor } from "/shell/shell.js";

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

const listPlans = (apiBase) => api(apiBase, "/v1/training/plans");
const listTracks = (apiBase) => api(apiBase, "/v1/training/tracks");
const listEvents = (apiBase) => api(apiBase, "/v1/training/events");
const listGoals = (apiBase) => api(apiBase, "/v1/training/goals");

// Singleton resources — 404 maps to null so we can render an empty state
// rather than a hard error.
async function getOptional(apiBase, path) {
  const res = await fetch(`${apiBase}${path}`, { credentials: "include" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}
const getProfile = (apiBase) => getOptional(apiBase, "/v1/training/profile");
const getLongTerm = (apiBase) => getOptional(apiBase, "/v1/training/long-term");

const postEvent = (apiBase, payload) =>
  api(apiBase, "/v1/training/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

const postAgentJob = (apiBase, payload) =>
  api(apiBase, "/v1/agents/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

const getAgentJob = (apiBase, id) => api(apiBase, `/v1/agents/jobs/${id}`);

const getGeneratePlanPreview = (apiBase, weekStart) =>
  api(apiBase, `/v1/agents/generate-plan/preview?week_start=${encodeURIComponent(weekStart)}`);

const putProfile = (apiBase, body) =>
  api(apiBase, "/v1/training/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });

const putLongTerm = (apiBase, body) =>
  api(apiBase, "/v1/training/long-term", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });

const patchPlan = (apiBase, planId, payload) =>
  api(apiBase, `/v1/training/plans/${planId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

const postGoal = (apiBase, payload) =>
  api(apiBase, "/v1/training/goals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

const patchGoal = (apiBase, id, payload) =>
  api(apiBase, `/v1/training/goals/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

const deleteGoal = (apiBase, id) =>
  api(apiBase, `/v1/training/goals/${id}`, { method: "DELETE" });

const postTrack = (apiBase, payload) =>
  api(apiBase, "/v1/training/tracks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

const patchTrack = (apiBase, id, payload) =>
  api(apiBase, `/v1/training/tracks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

const deleteTrack = (apiBase, id) =>
  api(apiBase, `/v1/training/tracks/${id}`, { method: "DELETE" });

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

function nextMonday(iso) {
  return isoAddDays(isoMonday(iso), 7);
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

function dayOfWeek(iso) {
  // Monday = 0, Sunday = 6 — matches isoMonday()
  return (new Date(iso + "T00:00:00").getDay() + 6) % 7;
}

function planEntriesForDOW(plan, dow) {
  // The current plan's day with the same day-of-week becomes the
  // template for past weeks too — your weekly structure is stable
  // enough that this is a fair grading. If no plan entry has that
  // DOW (rest day), there's nothing to grade against.
  if (!plan) return [];
  const days = plan.body.days || {};
  for (const [date, entries] of Object.entries(days)) {
    if (dayOfWeek(date) === dow) return entries;
  }
  return [];
}

function dayPercentage(events, plan, date) {
  const entries = planEntriesForDOW(plan, dayOfWeek(date));
  const dayEvents = events.filter((e) => e.local_date === date);
  if (entries.length === 0) {
    // No plan target for this DOW. If anything was logged, give a
    // small base tint so the day shows up; otherwise zero.
    return dayEvents.length > 0 ? 0.1 : 0;
  }
  let sum = 0;
  for (const entry of entries) {
    const done = entryDone(dayEvents, entry.slug, date, entry.unit);
    sum += Math.min(1, done / entry.target_total);
  }
  return sum / entries.length;
}

function buildWeeks(today, weeks, plan, events) {
  const todayMon = isoMonday(today);
  const rows = [];
  for (let w = 0; w < weeks; w++) {
    const mon = isoAddDays(todayMon, -7 * w);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = isoAddDays(mon, i);
      days.push({
        date,
        pct: dayPercentage(events, plan, date),
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

function renderDayHeader(state, render) {
  const plan = state.todayPlan;
  const days = plan ? Object.keys(plan.body.days || {}).sort() : [];
  const idx = days.indexOf(state.viewDate);
  const eyebrowText = plan
    ? `Week of ${plan.week_start}`
    : "no plan for this week";

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

  // Segmented gradient bar — 12 cells max, fewer if target_total is smaller.
  const cellCount = Math.min(12, Math.max(1, entry.target_total));
  const litCells = Math.round((done / entry.target_total) * cellCount);
  const cells = [];
  for (let i = 0; i < cellCount; i++) {
    cells.push(el("div", {
      class: `shell-bar-seg__cell${i < litCells ? " is-on" : ""}`,
    }));
  }
  const bar = el("div", { class: "shell-bar-seg" }, ...cells);

  // Dynamic TAP button — color matches the next cell about to light.
  const btnColor = heatColor(done, entry.target_total);

  return el("div", {
    class: "ex" + (isDone ? " done" : ""),
  },
    el("div", { class: "ex-header" },
      el("span", { class: "ex-title" }, entry.display),
      el("span", { class: "ex-spec" }, spec),
    ),
    bar,
    el("div", { class: "ex-footer" },
      el("span", { class: "ex-count" }, count),
      el("button", {
        class: "shell-btn-primary tap",
        style: {
          "--btn-color": btnColor,
          "--btn-glow": `${btnColor}73`,
        },
        onclick: onTap,
        disabled: !canLog || (entry.unit === "session" && isDone) ? "" : null,
      }, btnLabel),
    ),
  );
}

function renderPlanSection(state, render) {
  const plan = state.todayPlan;
  if (!plan) {
    const thisWeek = isoMonday(state.today);
    const inFlight = state.agentJob
      && state.agentJob.status !== "succeeded"
      && state.agentJob.status !== "failed";
    return el("section", { class: "empty" },
      el("p", {}, `No plan for the week of ${thisWeek}.`),
      el("button", {
        class: "btn-primary generate-btn",
        disabled: inFlight ? "" : null,
        onclick: () => generatePlan(state, render, thisWeek),
      }, inFlight ? "Generating…" : "Generate this week's plan"),
      state.agentJobError
        ? el("p", { class: "generate-error" }, state.agentJobError)
        : null,
    );
  }
  const entries = (plan.body.days || {})[state.viewDate] || [];
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
    { key: "stages", label: "Stages" },
    { key: "settings", label: "Settings" },
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

// ----- Settings views -----

function renderSettingsSubnav(state, render) {
  const items = [
    { key: "plan", label: "Plan" },
    { key: "goals", label: "Goals" },
    { key: "tracks", label: "Tracks" },
    { key: "profile", label: "Profile" },
    { key: "long-term", label: "Long-term" },
  ];
  return el("nav", { class: "subnav" },
    ...items.map((it) =>
      el("button", {
        class: "subnav-item" + (state.settingsSection === it.key ? " active" : ""),
        onclick: () => {
          state.settingsSection = it.key;
          try { localStorage.setItem("settings_section", it.key); } catch {}
          render();
        },
      }, it.label),
    ),
  );
}

function settingsEmpty(message, hint) {
  return el("section", { class: "empty" },
    el("p", {}, message),
    hint ? el("p", { class: "muted" }, hint) : null,
  );
}

function settingsHeader(eyebrow, title) {
  return el("header", { class: "settings-head" },
    el("div", { class: "eyebrow" },
      el("span", { class: "dot" }),
      el("span", {}, eyebrow),
    ),
    title ? el("h2", { class: "settings-title" }, title) : null,
  );
}

function jsonBlock(value) {
  return el("pre", { class: "json" }, JSON.stringify(value, null, 2));
}

function settingsPlan(state, render) {
  const target = nextMonday(state.today);
  const upToDate = state.plan && state.plan.week_start === target;

  const idx = state.settingsPlanIdx ?? 0;
  const list = state.plans || [];
  const viewed = list[idx] || null;
  const isCurrent = idx === 0;
  const hasNewer = idx > 0;
  const hasOlder = idx < list.length - 1;

  const header = viewed
    ? renderPlanWeekHeader(state, render, viewed, isCurrent, hasNewer, hasOlder)
    : settingsHeader("No plan yet", "Plan");

  return el("section", { class: "settings-body" },
    header,
    renderGeneratePlanCard(state, render, target, upToDate),
    viewed ? renderPlanSummary(viewed) : null,
    viewed ? renderPlanJsonEditor(state, render, viewed) : null,
  );
}

function renderPlanWeekHeader(state, render, viewed, isCurrent, hasNewer, hasOlder) {
  const stepPlan = (delta) => {
    const list = state.plans || [];
    const next = (state.settingsPlanIdx ?? 0) + delta;
    if (next < 0 || next >= list.length) return;
    state.settingsPlanIdx = next;
    render();
  };
  return el("header", { class: "settings-head plan-week-head" },
    el("div", { class: "eyebrow" },
      el("span", { class: "dot" }),
      el("span", {}, `Week of ${viewed.week_start} · ${viewed.generated_by}`),
    ),
    el("div", { class: "plan-week-nav" },
      el("button", {
        class: "plan-week-arrow",
        disabled: hasOlder ? null : "",
        onclick: () => stepPlan(1),
        "aria-label": "Previous week",
      }, "◀"),
      el("h2", { class: "settings-title plan-week-title" },
        isCurrent ? "Current plan" : "Past plan"),
      el("button", {
        class: "plan-week-arrow",
        disabled: hasNewer ? null : "",
        onclick: () => stepPlan(-1),
        "aria-label": "Next week",
      }, "▶"),
    ),
  );
}

function renderPlanJsonEditor(state, render, plan) {
  const initial = JSON.stringify(plan.body, null, 2);
  const taId = "plan-json-editor";
  const errId = "plan-json-error";

  const showErr = (msg) => {
    const errBox = document.getElementById(errId);
    if (!errBox) return;
    errBox.textContent = msg || "";
    errBox.style.display = msg ? "block" : "none";
  };

  const onSave = async (ev) => {
    const btn = ev.currentTarget;
    const ta = document.getElementById(taId);
    showErr("");
    let parsed;
    try {
      parsed = JSON.parse(ta.value);
    } catch (parseErr) {
      showErr(`Invalid JSON: ${parseErr.message}`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      showErr("Body must be a JSON object.");
      return;
    }
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const updated = await patchPlan(state.apiBase, plan.id, { body: parsed });
      const list = state.plans || [];
      const i = list.findIndex((p) => p.id === updated.id);
      if (i >= 0) list[i] = updated;
      state.plan = list[0] || updated;
      state.todayPlan = planForWeekContaining(list, state.today);
      render();
      toast("Plan saved", "success");
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Save";
      showErr(err.message);
    }
  };

  return el("details", { class: "settings-raw" },
    el("summary", {}, "Edit JSON"),
    el("p", { class: "muted" },
      "Tweak the plan body directly. Save replaces the JSON for this plan row."),
    el("textarea", {
      id: taId,
      class: "md-editor",
      rows: "20",
      spellcheck: "false",
    }, initial),
    el("p", { id: errId, class: "generate-error", style: { display: "none" } }),
    el("div", { class: "editor-actions" },
      el("button", { class: "shell-btn-primary", onclick: onSave }, "Save"),
      el("button", {
        class: "shell-btn-secondary",
        onclick: () => {
          const ta = document.getElementById(taId);
          if (ta) ta.value = initial;
          showErr("");
        },
      }, "Reset"),
    ),
  );
}

function renderPlanSummary(plan) {
  const days = plan.body.days || {};
  const dayKeys = Object.keys(days).sort();
  return el("div", { class: "plan-summary" },
    ...dayKeys.map((d) =>
      el("div", { class: "plan-day" },
        el("div", { class: "plan-day-h" }, dayLabel(d)),
        (days[d].length === 0)
          ? el("p", { class: "muted" }, "rest")
          : el("ul", { class: "plan-day-list" },
              ...days[d].map((entry) =>
                el("li", {},
                  el("span", { class: "plan-entry-name" }, entry.display),
                  el("span", { class: "plan-entry-spec" },
                    planEntrySpec(entry)),
                ),
              ),
            ),
      ),
    ),
  );
}

function renderGeneratePlanCard(state, render, target, upToDate) {
  const job = state.agentJob;
  const inFlight = !!job && job.status !== "succeeded" && job.status !== "failed";
  const elapsedS = job && job._local_started
    ? Math.round((Date.now() - job._local_started) / 1000)
    : 0;
  const statusLabel = !job
    ? null
    : job.status === "queued" ? `Queued · ${elapsedS}s`
    : job.status === "running" ? `Generating · ${elapsedS}s`
    : null;

  ensureGeneratePreview(state, render, target);
  const rationale = job && job.status === "succeeded" && job.output
    ? (job.output.rationale || "").trim()
    : "";

  return el("div", { class: "generate-card" },
    el("div", { class: "generate-card-h" },
      el("span", { class: "generate-card-title" },
        upToDate ? "Plan ready for next week" : "Generate next week's plan"),
      el("span", { class: "generate-card-target muted" }, `target: ${target}`),
    ),
    renderGenerateSummary(state, target),
    el("label", {
      class: "generate-context-label muted",
      for: "generate-context-ta",
    }, "Anything to consider this week? (optional)"),
    el("textarea", {
      id: "generate-context-ta",
      class: "generate-context",
      rows: "3",
      placeholder: "e.g. tweaked left elbow Friday, travel Wed-Thu",
      disabled: inFlight ? "" : null,
    }, state.generateContext || ""),
    el("button", {
      class: "btn-primary generate-btn",
      disabled: inFlight ? "" : null,
      onclick: () => generatePlan(state, render, target),
    }, statusLabel || (upToDate ? "Re-generate" : "Generate")),
    state.agentJobError
      ? el("p", { class: "generate-error" }, state.agentJobError)
      : null,
    job && job.status === "succeeded"
      ? el("div", { class: "generate-done" },
          el("p", { class: "generate-ok muted" },
            `Done in ${elapsedS}s. Plan refreshed.`),
          rationale ? el("p", { class: "generate-rationale" },
            el("span", { class: "generate-rationale-label muted" }, "Why "),
            rationale) : null,
        )
      : null,
  );
}

function ensureGeneratePreview(state, render, target) {
  const cur = state.generatePreview;
  if (cur && cur.weekStart === target && (cur.loading || cur.data || cur.error)) return;
  state.generatePreview = { weekStart: target, loading: true, data: null, error: null };
  getGeneratePlanPreview(state.apiBase, target)
    .then((data) => {
      if (state.generatePreview && state.generatePreview.weekStart === target) {
        state.generatePreview = { weekStart: target, loading: false, data, error: null };
        render();
      }
    })
    .catch((err) => {
      if (state.generatePreview && state.generatePreview.weekStart === target) {
        state.generatePreview = {
          weekStart: target, loading: false, data: null, error: err.message,
        };
        render();
      }
    });
}

function renderGenerateSummary(state, target) {
  const cur = state.generatePreview;
  if (!cur || cur.weekStart !== target) {
    return el("p", { class: "generate-summary muted" }, "Loading inputs…");
  }
  if (cur.loading) {
    return el("p", { class: "generate-summary muted" }, "Loading inputs…");
  }
  if (cur.error) {
    return el("p", { class: "generate-summary muted" },
      `Couldn't load preview: ${cur.error}`);
  }
  const d = cur.data;
  const goalCount = (d.goals || []).length;
  const trackCount = (d.tracks || []).length;
  const eventCount = (d.events || []).length;
  const profileTag = d.profile ? "profile ✓" : "profile —";
  const ltpTag = d.long_term ? "LTP ✓" : "LTP —";
  return el("div", { class: "generate-summary-wrap" },
    el("p", { class: "generate-summary muted" },
      `Using: ${goalCount} goals · ${trackCount} tracks · ${eventCount} events (4w) · ${profileTag} · ${ltpTag}`),
    el("details", { class: "generate-inputs" },
      el("summary", { class: "muted" }, "Show inputs"),
      renderGenerateInputs(d),
    ),
  );
}

function renderGenerateInputs(d) {
  const block = (title, body) => el("section", { class: "generate-inputs-section" },
    el("h5", { class: "generate-inputs-h" }, title),
    el("pre", { class: "generate-inputs-pre" }, body),
  );
  const goalsBody = (d.goals || []).length
    ? JSON.stringify(d.goals, null, 2)
    : "(none)";
  const tracksBody = (d.tracks || []).length
    ? (d.tracks || []).map((t) => `${t.slug} — ${t.display}`).join("\n")
    : "(none)";
  return el("div", {},
    block("Profile", formatMaybeMarkdown(d.profile)),
    block("Long-term plan", formatMaybeMarkdown(d.long_term)),
    block(`Goals (${(d.goals || []).length})`, goalsBody),
    block(`Tracks (${(d.tracks || []).length})`, tracksBody),
    block(`Recent events (last 4 weeks: ${(d.events || []).length})`,
      (d.events || []).length
        ? `Most recent: ${d.events[d.events.length - 1].local_date}`
        : "(none)"),
  );
}

function formatMaybeMarkdown(body) {
  if (!body) return "(none)";
  if (typeof body === "string") return body;
  if (typeof body.markdown === "string") return body.markdown;
  return JSON.stringify(body, null, 2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generatePlan(state, render, week_start) {
  const apiBase = state.apiBase;
  const start = Date.now();
  const ta = document.getElementById("generate-context-ta");
  state.generateContext = ta ? ta.value : (state.generateContext || "");
  state.agentJobError = null;
  state.agentJob = { status: "queued", _local_started: start };
  render();

  const context = state.generateContext.trim();
  const input = context ? { week_start, context } : { week_start };
  let job;
  try {
    job = await postAgentJob(apiBase, {
      kind: "generate_plan",
      input,
    });
  } catch (err) {
    state.agentJob = null;
    state.agentJobError = `Couldn't enqueue job: ${err.message}`;
    render();
    return;
  }
  state.agentJob = { ...job, _local_started: start };
  render();

  const TIMEOUT_MS = 120_000;
  const POLL_MS = 2000;

  while (Date.now() - start < TIMEOUT_MS) {
    await sleep(POLL_MS);
    let updated;
    try {
      updated = await getAgentJob(apiBase, job.id);
    } catch (err) {
      state.agentJob = null;
      state.agentJobError = `Lost contact with job ${job.id}: ${err.message}`;
      render();
      return;
    }
    state.agentJob = { ...updated, _local_started: start };
    render();

    if (updated.status === "succeeded") {
      try {
        const plans = await listPlans(apiBase);
        state.plans = plans;
        state.plan = plans[0] || null;
        state.todayPlan = planForWeekContaining(plans, state.today);
        state.settingsPlanIdx = 0;
        if (state.todayPlan) state.viewDate = pickViewDate(state.todayPlan, state.today);
      } catch {}
      render();
      toast(`Plan generated for week of ${week_start}`, "success");
      return;
    }
    if (updated.status === "failed") {
      state.agentJobError = updated.error || "Job failed without an error message.";
      state.agentJob = null;
      render();
      return;
    }
  }

  state.agentJobError =
    `Job ${job.id} still running after 2 min — refresh to check.`;
  state.agentJob = null;
  render();
}

function planEntrySpec(entry) {
  if (entry.unit === "reps") return `${entry.sets} × ${entry.per_set} reps`;
  if (entry.unit === "walks") return `${entry.target_total}× walks`;
  if (entry.unit === "duration_s") return `${entry.sets} × ${entry.per_set}s`;
  return entry.unit;
}

function settingsGoals(state, render) {
  const active = state.goals.filter((g) => g.status === "active");
  const adding = state.editingGoalId === 0;

  return el("section", { class: "settings-body" },
    settingsHeader(
      `${active.length} active · ${state.goals.length} total`,
      "Goals",
    ),
    el("div", { class: "list-actions" },
      adding
        ? null
        : el("button", {
            class: "shell-btn-primary add-btn",
            onclick: () => { state.editingGoalId = 0; render(); },
          }, "+ Add goal"),
    ),
    adding ? renderGoalForm(state, render, null) : null,
    ...state.goals.map((goal) =>
      state.editingGoalId === goal.id
        ? renderGoalForm(state, render, goal)
        : renderGoalCard(state, render, goal),
    ),
    !state.goals.length && !adding
      ? el("p", { class: "muted" }, "No goals yet. Tap + Add goal to start.")
      : null,
  );
}

function renderGoalCard(state, render, goal) {
  const isActive = goal.status === "active";
  const onToggleStatus = async () => {
    const newStatus = isActive ? "met" : "active";
    try {
      const updated = await patchGoal(state.apiBase, goal.id, { status: newStatus });
      Object.assign(goal, updated);
      render();
      toast(`${goal.display} → ${newStatus}`, "success");
    } catch (err) {
      toast(`Update failed: ${err.message}`);
    }
  };

  return el("article", { class: "goal-card" },
    el("header", { class: "goal-card-head" },
      el("span", { class: "goal-card-name" }, goal.display),
      el("span", { class: `goal-card-status status-${goal.status}` }, goal.status),
    ),
    el("div", { class: "goal-card-meta muted" },
      [
        goal.start_date ? `start ${goal.start_date}` : null,
        goal.deadline ? `deadline ${goal.deadline}` : null,
        `slug: ${goal.slug}`,
      ].filter(Boolean).join(" · "),
    ),
    Array.isArray(goal.tracks) && goal.tracks.length
      ? el("ul", { class: "goal-card-tracks" },
          ...goal.tracks.map((t) =>
            el("li", {},
              `${t.id || t.slug || "?"} → stage ${t.target_stage}`,
              t.weight != null
                ? el("span", { class: "muted" }, ` · weight ${t.weight}`)
                : null,
            ),
          ),
        )
      : el("p", { class: "muted" }, "no track weights"),
    el("div", { class: "card-actions" },
      el("button", {
        class: "shell-btn-secondary",
        onclick: () => { state.editingGoalId = goal.id; render(); },
      }, "Edit"),
      el("button", {
        class: "shell-btn-secondary",
        onclick: onToggleStatus,
      }, isActive ? "Mark met" : "Reactivate"),
    ),
  );
}

function renderGoalForm(state, render, goal) {
  const isNew = goal === null;
  const ids = {
    display: `goal-display-${goal ? goal.id : "new"}`,
    slug: `goal-slug-${goal ? goal.id : "new"}`,
    status: `goal-status-${goal ? goal.id : "new"}`,
    start: `goal-start-${goal ? goal.id : "new"}`,
    deadline: `goal-deadline-${goal ? goal.id : "new"}`,
    tracks: `goal-tracks-${goal ? goal.id : "new"}`,
    err: `goal-err-${goal ? goal.id : "new"}`,
  };
  const defaults = goal || {
    display: "",
    slug: "",
    status: "active",
    start_date: "",
    deadline: "",
    tracks: [],
  };

  const showErr = (msg) => {
    const errBox = document.getElementById(ids.err);
    if (!errBox) return;
    errBox.textContent = msg || "";
    errBox.style.display = msg ? "block" : "none";
  };

  const onSave = async (ev) => {
    const btn = ev.currentTarget;
    const get = (id) => document.getElementById(id);
    showErr("");
    const payload = {
      display: get(ids.display).value.trim(),
      slug: get(ids.slug).value.trim(),
      status: get(ids.status).value,
      start_date: get(ids.start).value || null,
      deadline: get(ids.deadline).value || null,
    };
    if (!payload.display) { showErr("Display is required."); return; }
    if (!payload.slug) { showErr("Slug is required."); return; }
    let tracks;
    try {
      tracks = JSON.parse(get(ids.tracks).value);
    } catch (e) {
      showErr(`Invalid tracks JSON: ${e.message}`);
      return;
    }
    if (!Array.isArray(tracks)) { showErr("Tracks must be a JSON array."); return; }
    payload.tracks = tracks;

    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      let updated;
      if (isNew) {
        updated = await postGoal(state.apiBase, payload);
        state.goals.push(updated);
      } else {
        updated = await patchGoal(state.apiBase, goal.id, payload);
        const idx = state.goals.findIndex((g) => g.id === goal.id);
        if (idx >= 0) state.goals[idx] = updated;
      }
      state.editingGoalId = null;
      render();
      toast(`${updated.display} ${isNew ? "created" : "saved"}`, "success");
    } catch (err) {
      btn.disabled = false;
      btn.textContent = isNew ? "Create" : "Save";
      showErr(err.message);
    }
  };

  const onDelete = async () => {
    if (!confirm(`Delete goal "${goal.display}"? This can't be undone.`)) return;
    try {
      await deleteGoal(state.apiBase, goal.id);
      state.goals = state.goals.filter((g) => g.id !== goal.id);
      state.editingGoalId = null;
      render();
      toast(`Deleted ${goal.display}`, "success");
    } catch (err) {
      toast(`Delete failed: ${err.message}`);
    }
  };

  return el("article", { class: "goal-card editing" },
    el("h3", { class: "form-title" }, isNew ? "New goal" : `Editing: ${goal.display}`),
    formField("Display", el("input", { id: ids.display, type: "text", value: defaults.display })),
    formField("Slug", el("input", { id: ids.slug, type: "text", value: defaults.slug })),
    formField("Status", el("select", { id: ids.status },
      el("option", { value: "active", ...(defaults.status === "active" ? { selected: "" } : {}) }, "active"),
      el("option", { value: "met", ...(defaults.status === "met" ? { selected: "" } : {}) }, "met"),
      el("option", { value: "archived", ...(defaults.status === "archived" ? { selected: "" } : {}) }, "archived"),
    )),
    el("div", { class: "form-row" },
      formField("Start", el("input", { id: ids.start, type: "date", value: defaults.start_date || "" })),
      formField("Deadline", el("input", { id: ids.deadline, type: "date", value: defaults.deadline || "" })),
    ),
    formField("Tracks (JSON array)",
      el("textarea", {
        id: ids.tracks,
        class: "md-editor json-editor",
        rows: "6",
        spellcheck: "false",
      }, JSON.stringify(defaults.tracks || [], null, 2)),
    ),
    el("p", { id: ids.err, class: "generate-error", style: { display: "none" } }),
    el("div", { class: "editor-actions" },
      el("button", { class: "shell-btn-primary", onclick: onSave },
        isNew ? "Create" : "Save"),
      el("button", {
        class: "shell-btn-secondary",
        onclick: () => { state.editingGoalId = null; render(); },
      }, "Cancel"),
      isNew ? null : el("button", {
        class: "shell-btn-secondary btn-danger",
        onclick: onDelete,
      }, "Delete"),
    ),
  );
}

function formField(label, control) {
  return el("label", { class: "form-field" },
    el("span", { class: "form-label" }, label),
    control,
  );
}

function settingsTracks(state, render) {
  const adding = state.editingTrackId === 0;
  return el("section", { class: "settings-body" },
    settingsHeader(`${state.tracks.length} tracks`, "Tracks"),
    el("div", { class: "list-actions" },
      adding
        ? null
        : el("button", {
            class: "shell-btn-primary add-btn",
            onclick: () => { state.editingTrackId = 0; render(); },
          }, "+ Add track"),
    ),
    adding ? renderTrackForm(state, render, null) : null,
    ...state.tracks.map((track) =>
      state.editingTrackId === track.id
        ? renderTrackForm(state, render, track)
        : renderTrackCard(state, render, track),
    ),
    !state.tracks.length && !adding
      ? el("p", { class: "muted" }, "No tracks yet. Tap + Add track to start.")
      : null,
  );
}

function renderTrackCard(state, render, track) {
  return el("article", { class: "track-card" },
    el("header", { class: "track-card-head" },
      el("span", { class: "track-card-name" }, track.display),
      el("span", { class: "track-card-slug muted" }, track.slug),
    ),
    el("p", { class: "muted track-card-meta" },
      `${(track.stages || []).length} stages`),
    el("details", { class: "track-stages" },
      el("summary", {}, "Stages"),
      el("ol", { class: "track-stage-list" },
        ...(track.stages || []).map((s) =>
          el("li", {},
            el("span", { class: "stage-test" }, s.test),
            Array.isArray(s.exercises) && s.exercises.length
              ? el("span", { class: "muted stage-ex" },
                  ` · ${s.exercises.join(", ")}`)
              : null,
          ),
        ),
      ),
    ),
    el("div", { class: "card-actions" },
      el("button", {
        class: "shell-btn-secondary",
        onclick: () => { state.editingTrackId = track.id; render(); },
      }, "Edit"),
    ),
  );
}

function renderTrackForm(state, render, track) {
  const isNew = track === null;
  const ids = {
    slug: `track-slug-${track ? track.id : "new"}`,
    display: `track-display-${track ? track.id : "new"}`,
    stages: `track-stages-${track ? track.id : "new"}`,
    err: `track-err-${track ? track.id : "new"}`,
  };
  const defaults = track || { slug: "", display: "", stages: [] };

  const showErr = (msg) => {
    const errBox = document.getElementById(ids.err);
    if (!errBox) return;
    errBox.textContent = msg || "";
    errBox.style.display = msg ? "block" : "none";
  };

  const onSave = async (ev) => {
    const btn = ev.currentTarget;
    const get = (id) => document.getElementById(id);
    showErr("");
    const payload = {
      slug: get(ids.slug).value.trim(),
      display: get(ids.display).value.trim(),
    };
    if (!payload.slug) { showErr("Slug is required."); return; }
    if (!payload.display) { showErr("Display is required."); return; }
    let stages;
    try {
      stages = JSON.parse(get(ids.stages).value);
    } catch (e) {
      showErr(`Invalid stages JSON: ${e.message}`);
      return;
    }
    if (!Array.isArray(stages)) { showErr("Stages must be a JSON array."); return; }
    payload.stages = stages;

    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      let updated;
      if (isNew) {
        updated = await postTrack(state.apiBase, payload);
        state.tracks.push(updated);
      } else {
        updated = await patchTrack(state.apiBase, track.id, payload);
        const idx = state.tracks.findIndex((t) => t.id === track.id);
        if (idx >= 0) state.tracks[idx] = updated;
      }
      state.editingTrackId = null;
      render();
      toast(`${updated.display} ${isNew ? "created" : "saved"}`, "success");
    } catch (err) {
      btn.disabled = false;
      btn.textContent = isNew ? "Create" : "Save";
      showErr(err.message);
    }
  };

  const onDelete = async () => {
    if (!confirm(`Delete track "${track.display}"? This can't be undone.`)) return;
    try {
      await deleteTrack(state.apiBase, track.id);
      state.tracks = state.tracks.filter((t) => t.id !== track.id);
      state.editingTrackId = null;
      render();
      toast(`Deleted ${track.display}`, "success");
    } catch (err) {
      toast(`Delete failed: ${err.message}`);
    }
  };

  return el("article", { class: "track-card editing" },
    el("h3", { class: "form-title" }, isNew ? "New track" : `Editing: ${track.display}`),
    formField("Slug", el("input", { id: ids.slug, type: "text", value: defaults.slug })),
    formField("Display", el("input", { id: ids.display, type: "text", value: defaults.display })),
    formField("Stages (JSON array)",
      el("textarea", {
        id: ids.stages,
        class: "md-editor json-editor",
        rows: "10",
        spellcheck: "false",
      }, JSON.stringify(defaults.stages || [], null, 2)),
    ),
    el("p", { id: ids.err, class: "generate-error", style: { display: "none" } }),
    el("div", { class: "editor-actions" },
      el("button", { class: "shell-btn-primary", onclick: onSave },
        isNew ? "Create" : "Save"),
      el("button", {
        class: "shell-btn-secondary",
        onclick: () => { state.editingTrackId = null; render(); },
      }, "Cancel"),
      isNew ? null : el("button", {
        class: "shell-btn-secondary btn-danger",
        onclick: onDelete,
      }, "Delete"),
    ),
  );
}

function markdownBody(record) {
  if (!record || !record.body) return null;
  if (typeof record.body.markdown === "string") return record.body.markdown;
  return null;
}

function settingsMarkdownEditor(state, render, opts) {
  const { record, eyebrow, title, emptyMsg, onSave } = opts;
  const md = record ? markdownBody(record) : "";
  const initial = md != null ? md : "";
  const textareaId = `editor-${title.replace(/\W/g, "-").toLowerCase()}`;

  const onSaveClick = async (ev) => {
    const btn = ev.currentTarget;
    const ta = document.getElementById(textareaId);
    const text = ta ? ta.value : "";
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const updated = await onSave(state.apiBase, { markdown: text });
      // Mutate the right state slot via the same onSave context.
      // The caller patched state for us before resolving.
      render();
      toast(`${title} saved`, "success");
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Save";
      toast(`${title} save failed: ${err.message}`);
    }
  };

  return el("section", { class: "settings-body" },
    settingsHeader(
      record ? `updated ${record.updated_at}` : eyebrow,
      title,
    ),
    !record && md == null
      ? el("section", { class: "empty" },
          el("p", { class: "muted" }, emptyMsg),
          el("p", { class: "muted" },
            "Type below and Save to create."),
        )
      : null,
    record && markdownBody(record) == null
      ? el("p", { class: "muted body-warn" },
          "Existing body has no `markdown` field — saving will replace it.")
      : null,
    el("textarea", {
      id: textareaId,
      class: "md-editor",
      rows: "16",
      spellcheck: "false",
      placeholder: emptyMsg,
    }, initial),
    el("div", { class: "editor-actions" },
      el("button", {
        class: "shell-btn-primary",
        onclick: onSaveClick,
      }, "Save"),
      el("button", {
        class: "shell-btn-secondary",
        onclick: () => {
          const ta = document.getElementById(textareaId);
          if (ta) ta.value = initial;
        },
      }, "Reset"),
    ),
  );
}

function settingsProfile(state, render) {
  return settingsMarkdownEditor(state, render, {
    record: state.profile,
    eyebrow: "Markdown body",
    title: "Profile",
    emptyMsg: "No profile saved yet.",
    onSave: async (apiBase, body) => {
      const updated = await putProfile(apiBase, body);
      state.profile = updated;
      return updated;
    },
  });
}

function settingsLongTerm(state, render) {
  return settingsMarkdownEditor(state, render, {
    record: state.longTerm,
    eyebrow: "Markdown body",
    title: "Long-term plan",
    emptyMsg: "No long-term plan saved yet.",
    onSave: async (apiBase, body) => {
      const updated = await putLongTerm(apiBase, body);
      state.longTerm = updated;
      return updated;
    },
  });
}

function renderSettingsMain(state, render) {
  const sections = {
    "plan": settingsPlan,
    "goals": settingsGoals,
    "tracks": settingsTracks,
    "profile": settingsProfile,
    "long-term": settingsLongTerm,
  };
  const fn = sections[state.settingsSection] || settingsPlan;
  return el("main", { class: "stage" },
    renderSettingsSubnav(state, render),
    fn(state, render),
  );
}

function renderLadder(track, cur) {
  const stages = track.stages || [];
  if (stages.length === 0) return null;
  const w = 240, gap = 6;
  const step = (w - gap * (stages.length - 1)) / stages.length;
  const r = Math.min(8, step * 0.42);
  const cy = r + 4;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "ladder");
  svg.setAttribute("viewBox", `0 0 ${w} ${r * 2 + 14}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const line = document.createElementNS(ns, "line");
  line.setAttribute("x1", step / 2);
  line.setAttribute("x2", w - step / 2);
  line.setAttribute("y1", cy);
  line.setAttribute("y2", cy);
  line.setAttribute("class", "ladder-line");
  svg.appendChild(line);

  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const cx = step / 2 + i * (step + gap);
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", cx);
    c.setAttribute("cy", cy);
    c.setAttribute("r", r);
    let cls = "ladder-dot";
    if (s.n <= cur) cls += " done";
    else if (s.n === cur + 1) cls += " next";
    c.setAttribute("class", cls);
    const title = document.createElementNS(ns, "title");
    title.textContent = `Stage ${s.n}: ${s.test}`;
    c.appendChild(title);
    svg.appendChild(c);

    const txt = document.createElementNS(ns, "text");
    txt.setAttribute("x", cx);
    txt.setAttribute("y", cy + r + 9);
    txt.setAttribute("text-anchor", "middle");
    txt.setAttribute("class", "ladder-num");
    txt.textContent = s.n;
    svg.appendChild(txt);
  }
  return svg;
}

function lastStagePass(events, trackSlug) {
  let last = null;
  for (const e of events) {
    if (e.kind === "stage_pass" && e.track === trackSlug) {
      if (!last || (e.ts || "") > (last.ts || "")) last = e;
    }
  }
  return last;
}

function renderStageBlock(state, track) {
  const cur = currentStage(state.events, track.slug);
  const total = (track.stages || []).length;
  const next = (track.stages || []).find((s) => s.n === cur + 1);
  const last = lastStagePass(state.events, track.slug);

  return el("article", { class: "stage-card" },
    el("header", { class: "stage-card-head" },
      el("span", { class: "stage-card-name" }, track.display),
      el("span", { class: "stage-card-pos" }, `stage ${cur} of ${total}`),
    ),
    renderLadder(track, cur),
    next
      ? el("p", { class: "stage-card-next muted" },
          `Next — stage ${next.n}: ${next.test}`)
      : el("p", { class: "stage-card-next muted" }, "All stages cleared."),
    last
      ? el("p", { class: "stage-card-last muted" },
          `Last pass: stage ${last.stage} · `
          + (last.local_date || (last.ts || "").slice(0, 10))
          + (last.note ? ` · ${last.note}` : ""))
      : null,
  );
}

function renderStagesMain(state) {
  if (!state.tracks.length) {
    return el("main", { class: "stage" },
      el("section", { class: "empty" },
        el("p", {}, "No tracks defined."),
        el("p", { class: "muted" }, "Tracks land via the import script or the (upcoming) settings view."),
      ),
    );
  }
  return el("main", { class: "stage" },
    el("header", { class: "day-header" },
      el("div", { class: "eyebrow" },
        el("span", { class: "dot" }),
        el("span", {}, `${state.tracks.length} tracks`),
      ),
    ),
    el("section", { class: "stages-list" },
      ...state.tracks.map((t) => renderStageBlock(state, t)),
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
  const rows = buildWeeks(state.today, 12, state.plan, state.events);
  const dayLetters = ["M", "T", "W", "T", "F", "S", "S"];
  const hasAny = rows.some((r) => r.days.some((d) => d.pct > 0));

  return el("main", { class: "stage" },
    el("header", { class: "day-header" },
      el("div", { class: "eyebrow" },
        el("span", { class: "dot" }),
        el("span", {}, "Last 12 weeks · % of plan"),
      ),
    ),
    hasAny
      ? null
      : el("section", { class: "empty" },
          el("p", {}, "Nothing logged yet."),
          el("p", { class: "muted" }, "Tap a + on the Today tab to start filling cells."),
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
            + (day.future ? " future" : ""),
          style: { "--pct": day.pct.toFixed(3) },
          title: day.pct > 0
            ? `${day.date} · ${Math.round(day.pct * 100)}% of plan`
            : day.date,
        })),
      )),
    ),
    el("section", { class: "legend" },
      el("span", { class: "muted" }, "0%"),
      el("div", { class: "legend-scale" }),
      el("span", { class: "muted" }, "100%"),
    ),
  );
}

function renderHome(root, state) {
  const render = () => renderHome(root, state);
  let main;
  if (state.view === "project") main = renderProjectMain(state);
  else if (state.view === "stages") main = renderStagesMain(state);
  else if (state.view === "settings") main = renderSettingsMain(state, render);
  else main = renderTodayMain(state, render);
  root.replaceChildren(
    renderTabs(state, render),
    main,
    el("footer", { class: "appfoot" }, meta(state.apiBase, state.sha)),
  );
  root.removeAttribute("aria-busy");
}

// ----- Toast -----

function toast(message, variant = "error") {
  const node = el("div", { class: `toast toast-${variant}` }, message);
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

function planForWeekContaining(plans, iso) {
  const ws = isoMonday(iso);
  return (plans || []).find((p) => p.week_start === ws) || null;
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

  // Shell.mount happens before the user check so the topbar appears
  // on the login screen too (with a SIGN IN link in the user widget).
  Shell.mount({
    mode: "subapp",
    apiBase,
    homeUrl: "https://jesselab.space/",
  });

  let user = null;
  try {
    const res = await fetch(`${apiBase}/v1/me`, { credentials: "include" });
    if (res.status !== 401 && res.ok) user = await res.json();
  } catch { /* offline — fall through to login screen */ }
  if (!user) {
    renderLogin(root, { apiBase, sha });
    return;
  }

  let plans, tracks, events, goals, profile, longTerm;
  try {
    [plans, tracks, events, goals, profile, longTerm] = await Promise.all([
      listPlans(apiBase),
      listTracks(apiBase),
      listEvents(apiBase),
      listGoals(apiBase),
      getProfile(apiBase),
      getLongTerm(apiBase),
    ]);
  } catch (err) {
    renderError(root, `Failed to load training data: ${err.message}`,
      { apiBase, sha });
    return;
  }

  const today = todayLocalISO();
  const plan = plans[0] || null;
  const todayPlan = planForWeekContaining(plans, today);
  const state = {
    user, apiBase, sha,
    plan, todayPlan, plans, tracks, events, goals, profile, longTerm,
    today,
    viewDate: pickViewDate(todayPlan, today),
    view: storedView(),
    settingsSection: storedSettingsSection(),
    settingsPlanIdx: 0,
    agentJob: null,
    agentJobError: null,
    generatePreview: null,
    generateContext: "",
    editingGoalId: null,
    editingTrackId: null,
  };
  renderHome(root, state);
}

const SETTINGS_SECTIONS = ["plan", "goals", "tracks", "profile", "long-term"];

function storedView() {
  try {
    const v = localStorage.getItem("view");
    if (v === "today" || v === "project" || v === "stages" || v === "settings") return v;
  } catch {}
  return "today";
}

function storedSettingsSection() {
  try {
    const v = localStorage.getItem("settings_section");
    if (SETTINGS_SECTIONS.includes(v)) return v;
  } catch {}
  return "plan";
}

bootstrap();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(() => {});
}
