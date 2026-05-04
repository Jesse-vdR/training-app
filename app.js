(() => {
  'use strict';

  // ====== CONFIG ======
  const CFG = {
    owner: 'Jesse-vdR',
    repo: 'Jesse',
    branch: 'main',
    planPath: 'training/plan.json',
    eventsPath: 'training/log/events.jsonl',
    goalsPath: 'training/goals.json',
    tracksPath: 'training/tracks.json',
  };
  const API = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}`;
  const DOUBLE_TAP_MS = 350;
  const HEATMAP_WEEKS = 26;
  const TONNAGE_WEEKS = 8;

  // ====== STATE ======
  const state = {
    pat: localStorage.getItem('pat') || '',
    plan: null,
    goals: [],
    tracks: {},
    today: todayLocalDate(),
    viewDate: null,
    view: localStorage.getItem('view') || 'today', // 'today' | 'project'
    expandedGoalId: null,
    syncedEvents: [],
    eventsSha: null,
    pendingEvents: loadPending(),
    lastTap: {},
    status: 'loading',
    error: null,
  };

  // ====== LOCAL STORAGE ======
  function loadPending() {
    try { return JSON.parse(localStorage.getItem('pending') || '[]'); }
    catch { return []; }
  }
  function savePending() {
    localStorage.setItem('pending', JSON.stringify(state.pendingEvents));
  }
  function savePat(pat) {
    state.pat = pat;
    if (pat) localStorage.setItem('pat', pat);
    else localStorage.removeItem('pat');
  }
  function setView(v) {
    state.view = v;
    localStorage.setItem('view', v);
    render();
  }

  // ====== DATE HELPERS ======
  function todayLocalDate() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function dayLabel(iso) {
    const d = new Date(iso + 'T00:00:00');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `${days[d.getDay()]} · ${iso}`;
  }
  function sortedDayKeys() {
    if (!state.plan) return [];
    return Object.keys(state.plan.days).sort();
  }
  function isoDaysBetween(a, b) {
    const da = new Date(a + 'T00:00:00');
    const db = new Date(b + 'T00:00:00');
    return Math.round((db - da) / 86400000);
  }
  function isoAddDays(iso, n) {
    const d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function isoMonday(iso) {
    const d = new Date(iso + 'T00:00:00');
    const dow = (d.getDay() + 6) % 7; // Mon=0 .. Sun=6
    d.setDate(d.getDate() - dow);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function dayOf(iso) {
    return (new Date(iso + 'T00:00:00').getDay() + 6) % 7; // Mon=0..Sun=6
  }

  // ====== GITHUB API ======
  async function ghGet(path) {
    const r = await fetch(`${API}/contents/${path}?ref=${CFG.branch}`, {
      headers: {
        Authorization: `Bearer ${state.pat}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (r.status === 404) return null;
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`GET ${path}: ${r.status} — ${body.slice(0, 200)}`);
    }
    const j = await r.json();
    const bytes = Uint8Array.from(atob(j.content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
    const text = new TextDecoder('utf-8').decode(bytes);
    return { text, sha: j.sha };
  }

  async function ghPut(path, text, sha, message) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const b64 = btoa(bin);
    const body = { message, content: b64, branch: CFG.branch };
    if (sha) body.sha = sha;
    const r = await fetch(`${API}/contents/${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${state.pat}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const e = new Error(`PUT ${path}: ${r.status} — ${err.message || 'unknown'}`);
      e.status = r.status;
      throw e;
    }
    return r.json();
  }

  // ====== DATA FLOW ======
  async function boot() {
    if (!state.pat) {
      state.status = 'no-token';
      render();
      openSettings();
      return;
    }
    state.status = 'loading';
    render();
    try {
      const [planRes, eventsRes, goalsRes, tracksRes] = await Promise.all([
        ghGet(CFG.planPath),
        ghGet(CFG.eventsPath),
        ghGet(CFG.goalsPath),
        ghGet(CFG.tracksPath),
      ]);
      if (!planRes) throw new Error(`${CFG.planPath} not found — run \`make plan\` in the data repo.`);
      state.plan = JSON.parse(planRes.text);
      state.syncedEvents = parseEvents(eventsRes ? eventsRes.text : '');
      state.eventsSha = eventsRes ? eventsRes.sha : null;
      state.goals = goalsRes ? (JSON.parse(goalsRes.text).goals || []) : [];
      state.tracks = {};
      if (tracksRes) {
        for (const t of (JSON.parse(tracksRes.text).tracks || [])) {
          state.tracks[t.id] = t;
        }
      }
      const keys = sortedDayKeys();
      if (keys.includes(state.today)) state.viewDate = state.today;
      else if (keys.length) state.viewDate = keys[0];
      else state.viewDate = state.today;
      state.status = 'ready';
    } catch (e) {
      state.status = 'error';
      state.error = e.message;
    }
    render();
  }

  function parseEvents(text) {
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  function allEvents() {
    return [...state.syncedEvents, ...state.pendingEvents];
  }

  // ====== TODAY-VIEW PROGRESS ======
  function doneFor(entry, date) {
    const matching = allEvents().filter((ev) =>
      (ev.local_date || (ev.ts || '').slice(0, 10)) === date &&
      ev.exercise === entry.slug
    );
    if (entry.unit === 'reps' || entry.unit === 'walks') {
      return matching.reduce((s, ev) => s + (ev.reps || 1), 0);
    }
    if (entry.unit === 'duration_s') {
      return matching.reduce((s, ev) => s + (ev.duration_s || 0), 0);
    }
    if (entry.unit === 'session') {
      return matching.length > 0 ? 1 : 0;
    }
    return 0;
  }

  function pendingCountFor(slug, date) {
    return state.pendingEvents.filter((ev) =>
      (ev.local_date || (ev.ts || '').slice(0, 10)) === date && ev.exercise === slug
    ).length;
  }

  // ====== STAGE / GOAL COMPUTE ======
  function currentStageFor(trackId) {
    let max = 0;
    for (const ev of allEvents()) {
      if (ev.kind === 'stage_pass' && ev.track === trackId && typeof ev.stage === 'number') {
        if (ev.stage > max) max = ev.stage;
      }
    }
    return max;
  }

  function lastStagePassFor(trackId) {
    let last = null;
    for (const ev of allEvents()) {
      if (ev.kind === 'stage_pass' && ev.track === trackId) {
        if (!last || (ev.ts || '') > (last.ts || '')) last = ev;
      }
    }
    return last;
  }

  function trackProgress(trackId, targetStage) {
    const cur = currentStageFor(trackId);
    if (cur <= 0) return 0;
    if (cur >= targetStage) return 1;
    return cur / targetStage;
  }

  function goalProgress(goal) {
    let totalW = 0, sum = 0;
    for (const t of goal.tracks) {
      sum += t.weight * trackProgress(t.id, t.target_stage);
      totalW += t.weight;
    }
    return totalW > 0 ? sum / totalW : 0;
  }

  function expectedProgress(goal) {
    const total = isoDaysBetween(goal.start_date, goal.deadline);
    if (total <= 0) return 1;
    const elapsed = isoDaysBetween(goal.start_date, state.today);
    return Math.max(0, Math.min(1, elapsed / total));
  }

  function paceClass(delta) {
    if (delta >= 0.02) return 'pace-ahead';
    if (delta >= -0.05) return 'pace-on';
    return 'pace-behind';
  }

  function paceLabel(delta) {
    const pp = Math.round(delta * 100);
    if (pp > 0) return `+${pp}pp ahead`;
    if (pp < 0) return `${pp}pp behind`;
    return 'on pace';
  }

  // ====== INTENSITY / TONNAGE ======
  // Difficulty factors mirror catalog.py — keep in sync if catalog changes.
  const DIFFICULTY = {
    pullups: 1.0,
    wide_pushups: 0.6,
    pike_pushups: 1.0,
    dips: 1.0,
    wall_walk: 1.0,
    ctw_handstand: 1.0,
    pancake: 0.8,
    pike_compression: 1.0,
    run: 3.0,
    bouldering: 2.0,
  };
  // Per-set targets so duration holds normalize to "set-equivalents."
  const PER_SET_NORM = {
    ctw_handstand: 15,
    pancake: 60,
    pike_compression: 30,
  };

  function eventIntensity(ev) {
    if (!ev || ev.kind === 'stage_pass') return 0;
    const f = DIFFICULTY[ev.exercise] ?? 1.0;
    if (ev.kind === 'set') return (ev.reps || 1) * f;
    if (ev.kind === 'hold') {
      const norm = PER_SET_NORM[ev.exercise] || 30;
      return ((ev.duration_s || 0) / norm) * f;
    }
    if (ev.kind === 'run' || ev.kind === 'session') return 1 * f;
    if (ev.kind === 'bouldering') return 1 * f;
    return 0;
  }

  function intensityByDay() {
    const map = {};
    for (const ev of allEvents()) {
      const day = ev.local_date || (ev.ts || '').slice(0, 10);
      if (!day) continue;
      map[day] = (map[day] || 0) + eventIntensity(ev);
    }
    return map;
  }

  function trackExercises(trackId) {
    const t = state.tracks[trackId];
    if (!t) return new Set();
    const set = new Set();
    for (const s of (t.stages || [])) {
      for (const ex of (s.exercises || [])) set.add(ex);
    }
    return set;
  }

  function tonnageByWeek(trackId, weeks) {
    const exSet = trackExercises(trackId);
    const today = state.today;
    const monday = isoMonday(today);
    const startMonday = isoAddDays(monday, -7 * (weeks - 1));
    const buckets = new Array(weeks).fill(0);
    for (const ev of allEvents()) {
      if (!exSet.has(ev.exercise)) continue;
      const day = ev.local_date || (ev.ts || '').slice(0, 10);
      if (!day || day < startMonday) continue;
      const wk = Math.floor(isoDaysBetween(startMonday, day) / 7);
      if (wk < 0 || wk >= weeks) continue;
      buckets[wk] += eventIntensity(ev);
    }
    return buckets;
  }

  // ====== LOG + UNDO ======
  function createEvent(entry, date) {
    const ev = {
      v: 1,
      ts: new Date().toISOString(),
      local_date: date,
      exercise: entry.slug,
    };
    if (entry.unit === 'reps' || entry.unit === 'walks') {
      ev.kind = 'set';
      ev.reps = entry.per_set;
    } else if (entry.unit === 'duration_s') {
      ev.kind = 'hold';
      ev.duration_s = entry.per_set;
    } else if (entry.unit === 'session') {
      ev.kind = entry.slug === 'run' ? 'run' : 'session';
    }
    return ev;
  }

  function logOne(entry) {
    const ev = createEvent(entry, state.viewDate);
    state.pendingEvents.push(ev);
    savePending();
    return ev;
  }

  function logStagePass(trackId, stageN, note) {
    const ev = {
      v: 1,
      ts: new Date().toISOString(),
      local_date: state.today,
      kind: 'stage_pass',
      track: trackId,
      stage: stageN,
    };
    if (note) ev.note = note;
    state.pendingEvents.push(ev);
    savePending();
  }

  function undoMostRecentPending(slug, date) {
    for (let i = state.pendingEvents.length - 1; i >= 0; i--) {
      const ev = state.pendingEvents[i];
      const d = ev.local_date || (ev.ts || '').slice(0, 10);
      if (d === date && ev.exercise === slug) {
        state.pendingEvents.splice(i, 1);
        savePending();
        return ev;
      }
    }
    return null;
  }

  function undoByRef(eventRef) {
    const idx = state.pendingEvents.indexOf(eventRef);
    if (idx >= 0) {
      state.pendingEvents.splice(idx, 1);
      savePending();
      return true;
    }
    return false;
  }

  // ====== SYNC ======
  async function sync() {
    if (state.pendingEvents.length === 0) return;
    const btn = document.getElementById('sync-btn');
    btn.classList.add('syncing');
    btn.textContent = 'Syncing…';
    btn.disabled = true;
    try {
      const cur = await ghGet(CFG.eventsPath);
      let baseText = cur ? cur.text : '';
      const sha = cur ? cur.sha : null;
      if (baseText && !baseText.endsWith('\n')) baseText += '\n';
      const appended = state.pendingEvents.map((e) => JSON.stringify(e)).join('\n') + '\n';
      const full = baseText + appended;
      const n = state.pendingEvents.length;
      await ghPut(CFG.eventsPath, full, sha, `app: log ${n} event${n === 1 ? '' : 's'}`);
      state.syncedEvents = [...state.syncedEvents, ...state.pendingEvents];
      state.pendingEvents = [];
      state.lastTap = {};
      savePending();
      toast('Synced ✓', 'accent');
    } catch (e) {
      toast(`Sync failed: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
    render();
  }

  // ====== RENDER (root) ======
  function render() {
    const app = document.getElementById('app');
    const bar = document.getElementById('sync-bar');
    const tabs = document.getElementById('tabs');

    app.innerHTML = '';
    tabs.hidden = (state.status !== 'ready');
    if (!tabs.hidden) {
      for (const b of tabs.querySelectorAll('.tab')) {
        b.classList.toggle('active', b.dataset.view === state.view);
      }
    }

    if (state.status === 'no-token') {
      const d = document.createElement('div');
      d.className = 'empty';
      d.innerHTML = '<p>No GitHub token saved.</p><p style="margin-top:0.5rem">Open ⚙ and paste one to start.</p>';
      const b = document.createElement('button');
      b.textContent = 'Open settings';
      b.addEventListener('click', openSettings);
      d.appendChild(b);
      app.appendChild(d);
      bar.hidden = false;
      updateSyncBtn();
      return;
    }
    if (state.status === 'loading') {
      app.innerHTML = '<div class="loading">Loading…</div>';
      bar.hidden = true;
      return;
    }
    if (state.status === 'error') {
      const d = document.createElement('div');
      d.className = 'error';
      const p = document.createElement('p');
      p.textContent = state.error || 'Unknown error';
      d.appendChild(p);
      const retry = document.createElement('button');
      retry.textContent = 'Retry';
      retry.addEventListener('click', boot);
      d.appendChild(retry);
      app.appendChild(d);
      bar.hidden = false;
      updateSyncBtn();
      return;
    }

    if (state.view === 'project') renderProject(app);
    else renderToday(app);

    bar.hidden = false;
    updateSyncBtn();
  }

  // ====== TODAY VIEW ======
  function renderToday(app) {
    app.appendChild(renderHeader());
    const entries = (state.plan.days[state.viewDate] || []);
    if (entries.length === 0) {
      const em = document.createElement('div');
      em.className = 'empty';
      em.innerHTML = `<p>Nothing planned for ${state.viewDate}.</p><p style="margin-top:0.5rem;color:var(--dim)">Rest day, or rerun <code>make plan</code>.</p>`;
      app.appendChild(em);
      return;
    }
    for (const entry of entries) app.appendChild(renderEntry(entry));
  }

  function renderHeader() {
    const header = document.createElement('header');

    const eyebrow = document.createElement('div');
    eyebrow.className = 'eyebrow';
    const dot = document.createElement('span');
    dot.className = 'dot';
    eyebrow.appendChild(dot);
    const week = document.createElement('span');
    week.textContent = state.plan.week_start ? `Week of ${state.plan.week_start}` : 'Training Logger';
    eyebrow.appendChild(week);
    header.appendChild(eyebrow);

    const nav = document.createElement('div');
    nav.className = 'day-nav';

    const keys = sortedDayKeys();
    const idx = keys.indexOf(state.viewDate);

    const prev = document.createElement('button');
    prev.textContent = '‹';
    prev.disabled = idx <= 0;
    prev.setAttribute('aria-label', 'Previous day');
    prev.addEventListener('click', () => {
      if (idx > 0) { state.viewDate = keys[idx - 1]; render(); }
    });
    nav.appendChild(prev);

    const stack = document.createElement('div');
    stack.className = 'date-stack';
    const h1 = document.createElement('h1');
    h1.textContent = dayLabel(state.viewDate);
    stack.appendChild(h1);
    if (state.viewDate === state.today) {
      const tag = document.createElement('span');
      tag.className = 'today-tag';
      tag.textContent = '· Today ·';
      stack.appendChild(tag);
    } else if (state.viewDate > state.today) {
      const tag = document.createElement('span');
      tag.className = 'today-tag';
      tag.style.color = 'var(--dim)';
      tag.textContent = '· Future (read-only) ·';
      stack.appendChild(tag);
    }
    nav.appendChild(stack);

    const next = document.createElement('button');
    next.textContent = '›';
    next.disabled = idx < 0 || idx >= keys.length - 1;
    next.setAttribute('aria-label', 'Next day');
    next.addEventListener('click', () => {
      if (idx >= 0 && idx < keys.length - 1) { state.viewDate = keys[idx + 1]; render(); }
    });
    nav.appendChild(next);

    header.appendChild(nav);
    return header;
  }

  function renderEntry(entry) {
    const done = doneFor(entry, state.viewDate);
    const isDone = done >= entry.target_total;
    const pct = Math.min(100, (done / entry.target_total) * 100);
    const pending = pendingCountFor(entry.slug, state.viewDate);
    const canLog = state.viewDate <= state.today;

    const wrap = document.createElement('div');
    wrap.className = 'ex' + (isDone ? ' done' : '') + (pending > 0 ? ' has-pending' : '');
    wrap.style.setProperty('--pct', `${pct}%`);

    const head = document.createElement('div');
    head.className = 'ex-header';
    const title = document.createElement('span');
    title.className = 'ex-title';
    title.textContent = entry.display;
    const spec = document.createElement('span');
    spec.className = 'ex-spec';
    if (entry.unit === 'reps') spec.textContent = `${entry.sets} × ${entry.per_set}`;
    else if (entry.unit === 'walks') spec.textContent = `${entry.target_total}×`;
    else if (entry.unit === 'duration_s') spec.textContent = `${entry.sets} × ${entry.per_set}s`;
    else if (entry.unit === 'session') spec.textContent = 'session';
    head.appendChild(title);
    head.appendChild(spec);
    wrap.appendChild(head);

    const pb = document.createElement('div');
    pb.className = 'progress-bar';
    pb.style.setProperty('--pct', `${pct}%`);
    wrap.appendChild(pb);

    const foot = document.createElement('div');
    foot.className = 'ex-footer';
    const count = document.createElement('span');
    count.className = 'ex-count';
    if (entry.unit === 'reps') count.textContent = `${done} / ${entry.target_total} reps`;
    else if (entry.unit === 'walks') count.textContent = `${done} / ${entry.target_total}`;
    else if (entry.unit === 'duration_s') count.textContent = `${done}s / ${entry.target_total}s`;
    else if (entry.unit === 'session') count.textContent = isDone ? 'done' : '—';
    if (pending > 0) {
      const dot = document.createElement('span');
      dot.className = 'pending-dot';
      dot.setAttribute('title', `${pending} pending`);
      count.appendChild(dot);
    }
    foot.appendChild(count);

    const btn = document.createElement('button');
    btn.className = 'tap';
    if (entry.unit === 'session') btn.textContent = isDone ? '✓' : 'Done';
    else if (entry.unit === 'duration_s') btn.textContent = `+${entry.per_set}s`;
    else btn.textContent = `+${entry.per_set}`;
    btn.disabled = !canLog;

    btn.addEventListener('click', () => {
      if (!canLog) return;

      if (entry.unit === 'session') {
        if (isDone && pending > 0) {
          undoMostRecentPending(entry.slug, state.viewDate);
          toast(`${entry.display}: undone`);
        } else if (!isDone) {
          logOne(entry);
        }
        render();
        return;
      }

      const now = Date.now();
      const lt = state.lastTap[entry.slug];
      if (lt && now - lt.at < DOUBLE_TAP_MS && lt.eventRef) {
        const firstUndone = undoByRef(lt.eventRef);
        const secondUndone = undoMostRecentPending(entry.slug, state.viewDate);
        state.lastTap[entry.slug] = null;
        if (secondUndone) toast(`${entry.display} −1`, 'accent');
        else if (firstUndone) toast(`${entry.display}: nothing left to undo`);
      } else {
        const ev = logOne(entry);
        state.lastTap[entry.slug] = { at: now, eventRef: ev };
      }
      render();
    });
    foot.appendChild(btn);
    wrap.appendChild(foot);

    return wrap;
  }

  // ====== PROJECT VIEW ======
  function renderProject(app) {
    const header = document.createElement('header');
    const eyebrow = document.createElement('div');
    eyebrow.className = 'eyebrow';
    const dot = document.createElement('span');
    dot.className = 'dot';
    eyebrow.appendChild(dot);
    const lab = document.createElement('span');
    lab.textContent = 'Project status';
    eyebrow.appendChild(lab);
    header.appendChild(eyebrow);

    const h1 = document.createElement('h1');
    h1.className = 'project-title';
    h1.textContent = `${state.goals.filter((g) => (g.status || 'active') === 'active').length} active goals`;
    header.appendChild(h1);
    app.appendChild(header);

    if (state.goals.length === 0) {
      const em = document.createElement('div');
      em.className = 'empty';
      em.innerHTML = `<p>No goals defined.</p><p style="margin-top:0.5rem;color:var(--dim)">Add <code>training/goals.json</code> in the data repo.</p>`;
      app.appendChild(em);
      return;
    }

    const active = state.goals.filter((g) => (g.status || 'active') === 'active');
    const done = state.goals.filter((g) => g.status === 'met');
    for (const g of active) app.appendChild(renderGoalCard(g));
    if (done.length) {
      const h = document.createElement('div');
      h.className = 'section-h';
      h.textContent = 'Completed';
      app.appendChild(h);
      for (const g of done) app.appendChild(renderGoalCard(g));
    }

    app.appendChild(renderHeatmap());
  }

  function renderGoalCard(goal) {
    const expanded = state.expandedGoalId === goal.id;
    const card = document.createElement('div');
    card.className = 'goal' + (expanded ? ' open' : '');

    const head = document.createElement('div');
    head.className = 'goal-head';
    head.addEventListener('click', () => {
      state.expandedGoalId = expanded ? null : goal.id;
      render();
    });

    const titleRow = document.createElement('div');
    titleRow.className = 'goal-title-row';
    const title = document.createElement('div');
    title.className = 'goal-title';
    title.textContent = goal.display;
    titleRow.appendChild(title);

    const days = isoDaysBetween(state.today, goal.deadline);
    const meta = document.createElement('div');
    meta.className = 'goal-meta';
    if (goal.status === 'met') meta.textContent = 'met';
    else if (days < 0) meta.textContent = `${-days}d overdue`;
    else meta.textContent = `${days}d left`;
    titleRow.appendChild(meta);
    head.appendChild(titleRow);

    const prog = goalProgress(goal);
    const exp = expectedProgress(goal);
    const delta = prog - exp;

    const bar = document.createElement('div');
    bar.className = 'goal-bar';
    bar.style.setProperty('--pct', `${(prog * 100).toFixed(1)}%`);
    bar.style.setProperty('--exp', `${(exp * 100).toFixed(1)}%`);
    if (goal.status !== 'met') {
      const marker = document.createElement('div');
      marker.className = 'marker';
      bar.appendChild(marker);
    }
    head.appendChild(bar);

    const stats = document.createElement('div');
    stats.className = 'goal-stats';
    const pctLabel = document.createElement('span');
    pctLabel.className = 'goal-pct';
    pctLabel.textContent = `${Math.round(prog * 100)}%`;
    stats.appendChild(pctLabel);

    if (goal.status !== 'met') {
      const pace = document.createElement('span');
      pace.className = `goal-pace ${paceClass(delta)}`;
      pace.textContent = paceLabel(delta);
      stats.appendChild(pace);
    }

    const caret = document.createElement('span');
    caret.className = 'goal-caret';
    caret.textContent = expanded ? '▾' : '▸';
    stats.appendChild(caret);

    head.appendChild(stats);
    card.appendChild(head);

    if (expanded) {
      const body = document.createElement('div');
      body.className = 'goal-body';
      for (const t of goal.tracks) body.appendChild(renderTrackBlock(goal, t));
      body.appendChild(renderTonnageChart(goal));
      card.appendChild(body);
    }

    return card;
  }

  function renderTrackBlock(goal, goalTrack) {
    const t = state.tracks[goalTrack.id];
    const wrap = document.createElement('div');
    wrap.className = 'track';

    if (!t) {
      const warn = document.createElement('div');
      warn.className = 'track-warn';
      warn.textContent = `Unknown track: ${goalTrack.id}`;
      wrap.appendChild(warn);
      return wrap;
    }

    const head = document.createElement('div');
    head.className = 'track-head';
    const name = document.createElement('span');
    name.className = 'track-name';
    name.textContent = t.display;
    head.appendChild(name);

    const cur = currentStageFor(t.id);
    const stageLabel = document.createElement('span');
    stageLabel.className = 'track-stage';
    stageLabel.textContent = `stage ${cur} of ${goalTrack.target_stage}`;
    head.appendChild(stageLabel);

    const weight = document.createElement('span');
    weight.className = 'track-weight';
    weight.textContent = `${Math.round((goalTrack.weight || 1) * 100)}%`;
    head.appendChild(weight);
    wrap.appendChild(head);

    wrap.appendChild(renderLadder(t, cur, goalTrack.target_stage));

    const last = lastStagePassFor(t.id);
    if (last) {
      const meta = document.createElement('div');
      meta.className = 'track-last';
      const date = last.local_date || (last.ts || '').slice(0, 10);
      meta.textContent = `Last pass: stage ${last.stage} · ${date}${last.note ? ' · ' + last.note : ''}`;
      wrap.appendChild(meta);
    }

    if (cur < goalTrack.target_stage) {
      const next = cur + 1;
      const nextStage = (t.stages || []).find((s) => s.n === next);
      if (nextStage) {
        const btn = document.createElement('button');
        btn.className = 'pass-btn';
        btn.textContent = `Pass stage ${next}: ${nextStage.test}`;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const note = window.prompt(
            `Confirm: passed stage ${next} of ${t.display}?\n\n${nextStage.test}\n\nOptional note (Cancel to abort):`,
            ''
          );
          if (note === null) return;
          logStagePass(t.id, next, note.trim() || null);
          toast(`${t.display}: stage ${next} passed`, 'accent');
          render();
        });
        wrap.appendChild(btn);
      }
    }

    return wrap;
  }

  function renderLadder(track, cur, target) {
    const stages = track.stages || [];
    const w = 240, gap = 6;
    const step = (w - gap * (stages.length - 1)) / stages.length;
    const r = Math.min(8, step * 0.42);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('ladder');
    svg.setAttribute('viewBox', `0 0 ${w} ${r * 2 + 14}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    // connecting line
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', step / 2);
    line.setAttribute('x2', w - step / 2);
    line.setAttribute('y1', r + 4);
    line.setAttribute('y2', r + 4);
    line.setAttribute('class', 'ladder-line');
    svg.appendChild(line);

    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      const cx = step / 2 + i * (step + gap);
      const cy = r + 4;
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r);
      let cls = 'ladder-dot';
      if (s.n <= cur) cls += ' done';
      else if (s.n === cur + 1) cls += ' next';
      if (s.n === target) cls += ' target';
      c.setAttribute('class', cls);
      const ttl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      ttl.textContent = `Stage ${s.n}: ${s.test}`;
      c.appendChild(ttl);
      svg.appendChild(c);

      const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      lbl.setAttribute('x', cx);
      lbl.setAttribute('y', cy + r + 9);
      lbl.setAttribute('text-anchor', 'middle');
      lbl.setAttribute('class', 'ladder-num');
      lbl.textContent = s.n;
      svg.appendChild(lbl);
    }
    return svg;
  }

  function renderTonnageChart(goal) {
    const wrap = document.createElement('div');
    wrap.className = 'tonnage';

    const h = document.createElement('div');
    h.className = 'tonnage-h';
    h.textContent = `Last ${TONNAGE_WEEKS} weeks · volume per track`;
    wrap.appendChild(h);

    const max = Math.max(
      1,
      ...goal.tracks.flatMap((gt) => tonnageByWeek(gt.id, TONNAGE_WEEKS))
    );

    for (const gt of goal.tracks) {
      const t = state.tracks[gt.id];
      if (!t) continue;
      const buckets = tonnageByWeek(gt.id, TONNAGE_WEEKS);
      const row = document.createElement('div');
      row.className = 'tonnage-row';
      const lbl = document.createElement('span');
      lbl.className = 'tonnage-lbl';
      lbl.textContent = t.display;
      row.appendChild(lbl);

      const bars = document.createElement('div');
      bars.className = 'tonnage-bars';
      for (const v of buckets) {
        const b = document.createElement('span');
        b.className = 'tonnage-bar';
        const pct = (v / max) * 100;
        b.style.setProperty('--h', `${pct}%`);
        b.title = `${Math.round(v)}`;
        bars.appendChild(b);
      }
      row.appendChild(bars);
      wrap.appendChild(row);
    }
    return wrap;
  }

  function renderHeatmap() {
    const wrap = document.createElement('div');
    wrap.className = 'heatmap';

    const h = document.createElement('div');
    h.className = 'heatmap-h';
    h.textContent = `Last ${HEATMAP_WEEKS} weeks · daily intensity`;
    wrap.appendChild(h);

    const monday = isoMonday(state.today);
    const start = isoAddDays(monday, -7 * (HEATMAP_WEEKS - 1));
    const intensity = intensityByDay();

    let max = 0;
    for (let i = 0; i < HEATMAP_WEEKS * 7; i++) {
      const d = isoAddDays(start, i);
      if (d > state.today) continue;
      max = Math.max(max, intensity[d] || 0);
    }
    if (max === 0) max = 1;

    const cell = 11, cgap = 2;
    const W = HEATMAP_WEEKS * (cell + cgap);
    const H = 7 * (cell + cgap) + 14;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('heatmap-svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    let lastMonth = -1;
    for (let w = 0; w < HEATMAP_WEEKS; w++) {
      const colDate = isoAddDays(start, w * 7);
      const m = new Date(colDate + 'T00:00:00').getMonth();
      if (m !== lastMonth) {
        const tx = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        tx.setAttribute('x', w * (cell + cgap));
        tx.setAttribute('y', 8);
        tx.setAttribute('class', 'heatmap-month');
        tx.textContent = ['J','F','M','A','M','J','J','A','S','O','N','D'][m];
        svg.appendChild(tx);
        lastMonth = m;
      }
      for (let d = 0; d < 7; d++) {
        const date = isoAddDays(start, w * 7 + d);
        const x = w * (cell + cgap);
        const y = 12 + d * (cell + cgap);
        const v = intensity[date] || 0;
        const lvl = v <= 0 ? 0 : Math.min(4, 1 + Math.floor((v / max) * 4 - 0.001));
        const future = date > state.today;
        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        r.setAttribute('x', x);
        r.setAttribute('y', y);
        r.setAttribute('width', cell);
        r.setAttribute('height', cell);
        r.setAttribute('rx', 2);
        r.setAttribute('class', `hm-cell hm-l${lvl}${future ? ' hm-future' : ''}`);
        const ttl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        ttl.textContent = `${date}: ${v.toFixed(1)}`;
        r.appendChild(ttl);
        svg.appendChild(r);
      }
    }
    wrap.appendChild(svg);
    return wrap;
  }

  // ====== SYNC BAR ======
  function updateSyncBtn() {
    const btn = document.getElementById('sync-btn');
    const n = state.pendingEvents.length;
    btn.classList.remove('syncing');
    if (n === 0) {
      btn.textContent = 'All synced';
      btn.classList.add('clean');
    } else {
      btn.textContent = `Sync (${n})`;
      btn.classList.remove('clean');
    }
  }

  // ====== SETTINGS ======
  function openSettings() {
    document.getElementById('pat-input').value = state.pat;
    refreshPendingView();
    document.getElementById('settings').hidden = false;
  }
  function closeSettings() {
    document.getElementById('settings').hidden = true;
  }
  function refreshPendingView() {
    const el = document.getElementById('pending-view');
    el.textContent = state.pendingEvents.length === 0
      ? '—'
      : state.pendingEvents.map((e) => JSON.stringify(e)).join('\n');
  }

  // ====== TOAST ======
  function toast(msg, kind = '') {
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2400);
  }

  // ====== INIT ======
  function init() {
    document.getElementById('sync-btn').addEventListener('click', sync);
    document.getElementById('settings-btn').addEventListener('click', openSettings);
    document.getElementById('settings-close').addEventListener('click', closeSettings);
    document.getElementById('pat-save').addEventListener('click', () => {
      const val = document.getElementById('pat-input').value.trim();
      if (!val) return toast('Paste a token first.', 'error');
      savePat(val);
      toast('Token saved.', 'accent');
      closeSettings();
      boot();
    });
    document.getElementById('pat-clear').addEventListener('click', () => {
      if (!confirm('Remove the saved token from this browser?')) return;
      savePat('');
      toast('Token cleared.');
    });
    document.getElementById('pending-clear').addEventListener('click', () => {
      if (!confirm(`Discard ${state.pendingEvents.length} pending events without syncing?`)) return;
      state.pendingEvents = [];
      state.lastTap = {};
      savePending();
      refreshPendingView();
      toast('Pending discarded.');
      render();
    });
    for (const b of document.querySelectorAll('#tabs .tab')) {
      b.addEventListener('click', () => setView(b.dataset.view));
    }
    boot();
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);

  // ====== SERVICE WORKER ======
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
