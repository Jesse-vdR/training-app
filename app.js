(() => {
  'use strict';

  // ====== CONFIG ======
  const CFG = {
    owner: 'Jesse-vdR',
    repo: 'Jesse',
    branch: 'main',
    planPath: 'training/plan.json',
    eventsPath: 'training/log/events.jsonl',
  };
  const API = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}`;
  const DOUBLE_TAP_MS = 350;

  // ====== STATE ======
  const state = {
    pat: localStorage.getItem('pat') || '',
    plan: null,
    today: todayLocalDate(),
    viewDate: null,
    syncedEvents: [],
    eventsSha: null,
    pendingEvents: loadPending(),
    lastTap: {}, // { [slug]: { at: number, eventRef: object } }
    status: 'loading', // 'loading' | 'ready' | 'no-token' | 'error'
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
      const [planRes, eventsRes] = await Promise.all([
        ghGet(CFG.planPath),
        ghGet(CFG.eventsPath),
      ]);
      if (!planRes) throw new Error(`${CFG.planPath} not found — run \`make plan\` in the data repo.`);
      state.plan = JSON.parse(planRes.text);
      state.syncedEvents = parseEvents(eventsRes ? eventsRes.text : '');
      state.eventsSha = eventsRes ? eventsRes.sha : null;
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

  // ====== PROGRESS ======
  function doneFor(entry, date) {
    const all = [...state.syncedEvents, ...state.pendingEvents];
    const matching = all.filter((ev) =>
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

  // ====== LOG + UNDO ======
  function createEvent(entry, date) {
    const ev = {
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

  function undoMostRecentPending(slug, date) {
    // Remove the most recently added pending event for this slug+date.
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

  // ====== RENDER ======
  function render() {
    const app = document.getElementById('app');
    const bar = document.getElementById('sync-bar');

    app.innerHTML = '';

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

    // ===== ready =====
    app.appendChild(renderHeader());

    const entries = (state.plan.days[state.viewDate] || []);
    if (entries.length === 0) {
      const em = document.createElement('div');
      em.className = 'empty';
      em.innerHTML = `<p>Nothing planned for ${state.viewDate}.</p><p style="margin-top:0.5rem;color:var(--dim)">Rest day, or rerun <code>make plan</code>.</p>`;
      app.appendChild(em);
    } else {
      for (const entry of entries) app.appendChild(renderEntry(entry));
    }

    bar.hidden = false;
    updateSyncBtn();
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

      // Session toggle: simple — tap to log if not done, tap to undo if done via pending.
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

      // Reps / walks / holds:
      //   - single tap: +1 pending
      //   - double-tap (second tap within DOUBLE_TAP_MS): net -1 from pre-pair state.
      //     Removes the event just logged by the first tap AND one more pending event
      //     for this slug+date (if any exist). Synced events are never touched.
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
