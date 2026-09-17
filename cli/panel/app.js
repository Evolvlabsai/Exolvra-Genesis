/* Genesis control panel. All displayed records come from the local API. */
'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icons = {
  operations: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  runs: '<path d="m9 5 11 7-11 7Z"/><path d="M4 5v14"/>',
  plans: '<path d="M8 3H5v18h14V3h-3M9 3h6v4H9zM8 12h8M8 16h5"/>',
  projects: '<path d="M3 6h7l2 2h9v11H3zM3 6V4h7l2 2h7v2"/>',
  agents: '<rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 3v4M8 12h.01M16 12h.01M9 16h6M1 11v5M23 11v5"/>',
  telemetry: '<path d="M3 18h3l3-10 5 13 3-16 3 10h2"/>',
  events: '<path d="M4 6h2M10 6h10M4 12h2M10 12h10M4 18h2M10 18h10"/>',
  settings: '<path d="m10 3-.8 2.5-2.5 1L4.3 6 2.7 9l1.8 1.8v2.5L2.7 15 4.3 18l2.4-.5 2.5 1L10 21h4l.8-2.5 2.5-1 2.4.5 1.6-3-1.8-1.7v-2.5L21.3 9l-1.6-3-2.4.5-2.5-1L14 3z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>', back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
  export: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>', check: '<path d="m5 12 4 4L19 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  moon: '<path d="M20.9 13.3A9 9 0 0 1 10.7 3.1a9 9 0 1 0 10.2 10.2Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', warning: '<path d="M12 3 2 21h20ZM12 9v5M12 17h.01"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>', terminal: '<path d="m5 6 6 6-6 6M13 18h6"/>',
  file: '<path d="M14 3H5v18h14V8ZM14 3v5h5M8 12h8M8 16h6"/>', money: '<path d="M12 2v20M17 6H9a4 4 0 0 0 0 8h6a3 3 0 0 1 0 6H6"/>',
  external: '<path d="M14 3h7v7M21 3 10 14M10 3H3v18h18v-7"/>', trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
};
const icon = (name) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + (icons[name] || icons.file) + '</svg>';
const nav = [['operations', 'Operations'], ['runs', 'Runs'], ['plans', 'Plans'], ['projects', 'Projects'], ['agents', 'Agents'], ['telemetry', 'Telemetry'], ['events', 'Events'], ['settings', 'Settings']];
const storage = {
  get(key, fallback) { try { return localStorage.getItem('genesis.' + key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('genesis.' + key, value); } catch { /* Preferences remain session-local when storage is unavailable. */ } },
};
const state = { overview: null, csrf: null, lastUpdated: 0, error: null, route: '', filters: { search: '', status: '', project: '', kind: '' }, detail: null, detailEvents: new Map(), detailCursor: 0, hasEarlier: false, loadingEarlier: false, job: null, busy: false, tail: true, eventSnapshot: null, timer: null, theme: storage.get('theme', 'dark'), polling: storage.get('refresh', 'on') !== 'off' };
Object.assign(state, { authenticated: false, requiresLogin: false, sessionChecked: false, authEpoch: 0, loginBusy: false });
const money = (value) => value === null || value === undefined ? 'Unavailable' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
const count = (value) => new Intl.NumberFormat('en-US', { notation: Number(value) > 99999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value || 0);
const time = (value) => Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
const date = (value) => Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const ago = (value) => { const ms = Date.now() - new Date(value).getTime(); if (!Number.isFinite(ms)) return 'unknown'; if (ms < 60000) return Math.max(0, Math.floor(ms / 1000)) + 's ago'; if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago'; if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ago'; return Math.floor(ms / 86400000) + 'd ago'; };
const human = (value) => String(value ?? '').replace(/[_-]/g, ' ');
const decodePart = (value) => { try { return decodeURIComponent(value); } catch { return value; } };
const badge = (status) => '<span class="badge ' + escape(String(status).toLowerCase().replace(/[^a-z]/g, '')) + '">' + escape(human(status)) + '</span>';
const linkRun = (run) => '#runs/' + encodeURIComponent(run.projectId) + '/' + encodeURIComponent(run.id);
const linkJob = (job) => '#jobs/' + encodeURIComponent(job.id);
const runById = (projectId, id) => state.overview?.runs.find((run) => run.projectId === projectId && run.id === id);
const projectOptions = (selected = '') => (state.overview?.projects || []).map((project) => '<option value="' + escape(project.id) + '"' + (selected === project.id ? ' selected' : '') + '>' + escape(project.name) + '</option>').join('');
const actions = (items) => '<div class="actions">' + items.join('') + '</div>';
const button = (label, action, symbol, primary = false, extra = '') => '<button class="button' + (primary ? ' primary' : '') + '" data-action="' + escape(action) + '" ' + extra + '>' + (symbol ? icon(symbol) : '') + escape(label) + '</button>';
const empty = (title, body, symbol = 'runs', action = '', small = false) => '<div class="empty' + (small ? ' small' : '') + '"><div class="empty-icon">' + icon(symbol) + '</div><h3>' + escape(title) + '</h3><p>' + escape(body) + '</p>' + action + '</div>';
const panel = (title, content, options = {}) => '<section class="panel' + (options.className ? ' ' + options.className : '') + '"><div class="panel-head"><div class="title-group"><h2>' + escape(title) + '</h2>' + (options.count !== undefined ? '<span class="count">' + escape(options.count) + '</span>' : '') + '</div>' + (options.action || '') + '</div>' + content + (options.footer ? '<div class="panel-footer">' + options.footer + '</div>' : '') + '</section>';
function heading(title, description, right = '', eyebrow = 'Workspace') { return '<div class="page-heading"><div><div class="eyebrow">' + escape(eyebrow) + '</div><h1>' + escape(title) + '</h1><p>' + escape(description) + '</p></div>' + right + '</div>'; }
function patch(id, html) {
  const element = document.getElementById(id);
  if (!element || element._html === html) return;
  // A poll never steals focus or replaces selected text while the operator reads.
  const selection = window.getSelection();
  if (element.contains(document.activeElement) || (selection && !selection.isCollapsed && element.contains(selection.anchorNode))) return;
  const scroll = $$('[data-preserve-scroll]', element).map((node) => [node.id, node.scrollTop, node.scrollLeft]);
  element.innerHTML = html; element._html = html;
  $$('[data-width]', element).forEach((bar) => { const width = Number.parseFloat(bar.dataset.width); if (Number.isFinite(width)) bar.style.width = Math.max(0, Math.min(100, width)) + '%'; });
  for (const [key, top, left] of scroll) { const node = document.getElementById(key); if (node) { node.scrollTop = top; node.scrollLeft = left; } }
}
function authError(message) {
  $('#auth-error').textContent = message || '';
  $('#auth-error').hidden = !message;
  $('#auth-loading').hidden = true;
  $('#auth-retry').hidden = !message;
}
function lockWorkspace(message = '') {
  state.authEpoch++; state.authenticated = false; state.csrf = null;
  state.overview = null; state.detail = null; state.job = null; state.route = ''; state.lastUpdated = 0;
  state.detailEvents = new Map(); state.detailCursor = 0; state.eventSnapshot = null; state.error = null;
  document.body.classList.remove('auth-pending'); document.body.classList.add('auth-locked');
  $('#auth-screen').hidden = false; $('#auth-loading').hidden = true; $('#login-form').hidden = false;
  $('#auth-title').textContent = 'Your shared workspace';
  $('#auth-description').textContent = 'Sign in to view projects, follow runs and manage work on this Genesis server.';
  $('#access-key').value = ''; $('#logout').hidden = true;
  if ($('#modal').open) $('#modal').close();
  $('#modal-content').replaceChildren(); $('#toasts').replaceChildren();
  $('#main').innerHTML = '<div class="loading-state"><span class="loading-ring"></span><h1>Loading your workspace</h1><p>Reading server projects and run evidence.</p></div>';
  $$('[id^=nav-count-]').forEach((node) => { node.textContent = ''; });
  document.title = 'Genesis · Sign in'; authError(message);
  $('#access-key').focus();
}
function applySession(session, message = '') {
  state.requiresLogin = session.requiresLogin === true;
  const authenticated = session.authenticated === true || !state.requiresLogin;
  if (!authenticated) lockWorkspace(message);
  state.csrf = session.csrfToken; state.sessionChecked = true; state.authenticated = authenticated;
  if (!authenticated) return false;
  document.body.classList.remove('auth-pending', 'auth-locked'); $('#auth-screen').hidden = true;
  $('#login-form').reset(); authError('');
  $('#workspace-name').textContent = state.requiresLogin ? 'Shared workspace' : 'Local workspace';
  $('#workspace-avatar').textContent = state.requiresLogin ? 'S' : 'L';
  $('#workspace-description').textContent = state.requiresLogin ? 'Team projects on this server.' : 'Your projects. Your machine.';
  $('#workspace-connection').textContent = state.requiresLogin ? 'Server connection' : 'Local connection';
  $('#workspace-mode').textContent = state.requiresLogin ? 'SHARED' : 'LOCAL';
  $('#operator-avatar').textContent = state.requiresLogin ? 'S' : 'L';
  $('#operator-avatar').title = state.requiresLogin ? 'Shared workspace operator' : 'Local operator';
  $('#logout').hidden = !state.requiresLogin;
  return true;
}
async function readSession(message = '') { return applySession(await api('/api/session'), message); }
async function api(path, options = {}) {
  const epoch = state.authEpoch;
  const headers = { Accept: 'application/json', ...options.headers };
  if (options.method && options.method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-Genesis-CSRF'] = state.csrf || ''; }
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, { ...options, headers, signal: controller.signal, credentials: 'same-origin', cache: 'no-store' });
    let value; try { value = await response.json(); } catch { throw new Error('The local server returned an unreadable response.'); }
    if (!response.ok) {
      if (response.status === 401 && path !== '/api/login' && path !== '/api/session') {
        const message = 'Your session expired. Sign in to continue.';
        state.requiresLogin = true; lockWorkspace(message);
        try { await readSession(message); } catch { authError('Sign-in is required. Reconnect to the server before trying again.'); }
      }
      const error = new Error(typeof value.error === 'string' ? value.error : value.error?.message || value.message || 'Request failed (' + response.status + ').');
      error.status = response.status; throw error;
    }
    if (!['/api/session', '/api/login', '/api/logout'].includes(path) && epoch !== state.authEpoch) throw new Error('The workspace session changed. Sign in again to continue.');
    return value;
  } catch (error) { if (error.name === 'AbortError') throw new Error('The local server did not respond within 20 seconds.'); throw error; }
  finally { clearTimeout(timeout); }
}
function notify(message, failed = false) { const node = document.createElement('div'); node.className = 'toast' + (failed ? ' error' : ''); node.textContent = message; $('#toasts').append(node); setTimeout(() => node.remove(), 6000); }
function setTheme(theme) {
  state.theme = ['dark', 'light', 'system'].includes(theme) ? theme : 'dark';
  storage.set('theme', state.theme);
  const resolved = state.theme === 'system' ? matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark' : state.theme;
  document.documentElement.dataset.theme = resolved;
  $('meta[name="theme-color"]').content = resolved === 'light' ? '#f3f5f7' : '#080a0c';
  $$('[data-theme-toggle]').forEach((toggle) => {
    const label = resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    toggle.innerHTML = icon(resolved === 'dark' ? 'sun' : 'moon');
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  });
  const select = $('#theme-select');
  if (select) select.value = state.theme;
}
setTheme(state.theme);
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (state.theme === 'system') setTheme('system'); });
$$('[data-theme-toggle]').forEach((toggle) => toggle.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')));
$('#navigation').innerHTML = nav.map(([id, label], index) => (index === 7 ? '<div class="nav-separator"></div>' : '') + '<a class="nav-link" href="#' + id + '" data-nav="' + id + '">' + icon(id) + '<span>' + label + '</span><span class="nav-count" id="nav-count-' + id + '"></span></a>').join('');
$('#menu-toggle').innerHTML = icon('menu');
$('#menu-toggle').addEventListener('click', () => { const open = $('#sidebar').classList.toggle('open'); $('#menu-toggle').setAttribute('aria-expanded', String(open)); });
$('.skip-link').addEventListener('click', (event) => { event.preventDefault(); $('#main').focus(); });
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (state.loginBusy) return;
  state.loginBusy = true; $('#login-submit').disabled = true; $('#login-submit').textContent = 'Connecting…'; authError('');
  let token = $('#access-key').value; $('#access-key').value = '';
  try {
    if (!state.csrf) await readSession();
    const session = await api('/api/login', { method: 'POST', body: JSON.stringify({ token }) }); token = '';
    if (!applySession(session)) throw new Error('The server did not establish an authenticated session.');
    state.route = ''; await refresh(true);
  } catch (error) {
    token = '';
    try { await readSession(); } catch { /* Keep the login form available for an explicit retry. */ }
    authError(error.message || 'Unable to sign in.'); $('#access-key').focus();
  } finally { token = ''; state.loginBusy = false; $('#login-submit').disabled = false; $('#login-submit').textContent = 'Connect to workspace →'; }
});
$('#auth-retry').addEventListener('click', async () => {
  $('#auth-retry').disabled = true;
  try { authError(''); if (await readSession()) await refresh(true); }
  catch (error) { authError(error.message || 'Unable to reach the server.'); }
  finally { $('#auth-retry').disabled = false; }
});
$('#logout').addEventListener('click', async () => {
  $('#logout').disabled = true;
  try { await api('/api/logout', { method: 'POST', body: '{}' }); lockWorkspace(); await readSession(); }
  catch (error) { if (!state.authenticated) authError(error.message); else notify('Sign-out failed: ' + error.message, true); }
  finally { $('#logout').disabled = false; }
});

function stats(items) { return '<div class="stats">' + items.map(([label, value, description, symbol, color]) => '<div class="stat"><div class="stat-top"><span>' + escape(label) + '</span>' + icon(symbol) + '</div><div class="stat-number ' + (color || '') + (value === 'Unavailable' ? ' unavailable' : '') + '">' + escape(value) + '</div><div class="stat-meta">' + escape(description) + '</div></div>').join('') + '</div>'; }
function overallStats() { const data = state.overview; return stats([['Active runs', count(data.totals.running), 'Currently executing', 'runs', 'green'], ['Completed runs', count(data.totals.complete), 'Win condition reached', 'check'], ['Reported spend', money(data.totals.costUsd), 'Observed provider receipts', 'money'], ['Needs attention', count(data.totals.blocked), 'Blocked · operator input needed', 'warning', data.totals.blocked ? 'amber' : '']]); }
function runFilters() { return '<div class="toolbar"><label class="search">' + icon('search') + '<input type="search" data-filter="search" aria-label="Search runs" placeholder="Search runs, goals or IDs…" value="' + escape(state.filters.search) + '"></label><select data-filter="status" aria-label="Filter by status"><option value="">All statuses</option>' + ['running', 'complete', 'blocked', 'stopped'].map((value) => '<option value="' + value + '"' + (state.filters.status === value ? ' selected' : '') + '>' + human(value)[0].toUpperCase() + human(value).slice(1) + '</option>').join('') + '</select><select data-filter="project" aria-label="Filter by project"><option value="">All projects</option>' + projectOptions(state.filters.project) + '</select><span class="toolbar-label">' + icon('search') + '</span></div>'; }
function filteredRuns(runs) { const query = state.filters.search.toLowerCase(); return runs.filter((run) => (!state.filters.status || run.status === state.filters.status) && (!state.filters.project || run.projectId === state.filters.project) && (!query || [run.id, run.input, run.projectName].some((value) => String(value).toLowerCase().includes(query)))); }
function runsTable(runs, compact = false) {
  if (!runs.length) return empty(state.overview.runs.length ? 'No matching runs' : 'Your first run starts here', state.overview.runs.length ? 'Try another search or clear the filters.' : 'Start with a goal or specification. Genesis records each round and its evidence.', 'runs', state.overview.runs.length ? button('Clear filters', 'clear-filters', 'refresh') : button('Start a run', 'new-run', 'plus', true));
  return '<div class="table-scroll"><table><thead><tr><th>Run / goal</th><th>Status</th>' + (!compact ? '<th>Project</th>' : '') + '<th>Rounds</th><th>Spend</th><th>Started</th><th aria-label="Open"></th></tr></thead><tbody>' + runs.map((run) => '<tr class="run-link" data-route="' + escape(linkRun(run)) + '"><td><a class="row-title" href="' + escape(linkRun(run)) + '" title="' + escape(run.input || run.id) + '">' + escape(run.input || run.id) + '</a><span class="row-sub">' + escape(run.id) + '</span></td><td>' + badge(run.stalled ? 'stalled' : run.status) + '</td>' + (!compact ? '<td>' + escape(run.projectName) + '</td>' : '') + '<td class="mono">' + run.rounds + (run.maxRounds !== null ? '<span class="muted"> / ' + run.maxRounds + '</span>' : '') + '</td><td class="mono">' + money(run.costUsd) + '</td><td class="mono muted" title="' + escape(date(run.startedAt)) + '">' + ago(run.startedAt) + '</td><td>' + icon('arrow') + '</td></tr>').join('') + '</tbody></table></div>';
}
function activity(events, limit = 6) { return events.length ? '<div class="activity-list">' + events.slice(-limit).reverse().map((event) => '<a class="activity-item" href="#runs/' + encodeURIComponent(event.projectId) + '/' + encodeURIComponent(event.runId) + '"><span class="activity-symbol">' + icon(event.kind.includes('error') ? 'warning' : event.kind.includes('finished') ? 'check' : 'events') + '</span><div class="activity-copy"><h3>' + escape(event.summary || human(event.kind)) + '</h3><p>' + escape(event.piece || event.runId) + '</p></div><span class="activity-time">' + ago(event.at) + '</span></a>').join('') + '</div>' : empty('Quiet for now', 'Run events will appear here as work progresses.', 'events', '', true); }
function jobTable(jobs) { return jobs.length ? '<div class="table-scroll"><table><thead><tr><th>Job</th><th>Project</th><th>Status</th><th>Created</th><th>Exit</th><th></th></tr></thead><tbody>' + [...jobs].sort((a, b) => b.createdAt - a.createdAt).map((job) => '<tr class="run-link" data-route="' + linkJob(job) + '"><td><a class="row-title" href="' + linkJob(job) + '">' + escape(human(job.action)) + '</a><span class="row-sub">' + escape(job.id) + '</span></td><td>' + escape(job.projectName) + '</td><td>' + badge(job.status) + '</td><td class="mono muted">' + ago(job.createdAt) + '</td><td class="mono">' + (job.exitCode ?? '—') + '</td><td>' + icon('arrow') + '</td></tr>').join('') + '</tbody></table></div>' : empty('No planning sessions yet', 'Preview a goal before starting a build. Plans here are actual CLI jobs and their output.', 'plans', button('Create a plan', 'new-plan', 'plus', true)); }
function eventRows(events) { return events.map((event) => '<div class="event ' + (/error|fail|blocked/.test(event.kind) ? 'negative' : /complete|finished|win/.test(event.kind) ? 'positive' : '') + '"><span class="event-time" title="' + escape(date(event.at)) + '">' + time(event.at) + '</span><span class="event-kind">' + escape(human(event.kind)) + (event.round !== null ? '<br><span class="muted">round ' + event.round + '</span>' : '') + '</span><details><summary class="event-summary">' + escape(event.summary || human(event.kind)) + '</summary><pre>' + escape(JSON.stringify(event.payload, null, 2)) + '</pre></details></div>').join(''); }
function eventControls(detail = false) { return '<div class="event-toolbar"><select data-filter="kind" aria-label="Filter event kind"><option value="">All events</option>' + ['activity', 'budget_spend', 'gate_check', 'verdict_recorded', 'error', 'stalled', 'process_event', 'run_finished'].map((kind) => '<option value="' + kind + '"' + (state.filters.kind === kind ? ' selected' : '') + '>' + escape(human(kind)) + '</option>').join('') + '</select><label class="checkbox-label"><input type="checkbox" id="tail-events"' + (state.tail ? ' checked' : '') + '> Follow</label>' + (detail ? '' : button('Export', 'export-events', 'export')) + '</div>'; }
function eventFilter(events) { return events.filter((event) => (!state.filters.kind || event.kind === state.filters.kind) && (!state.filters.project || event.projectId === state.filters.project) && (!state.filters.search || [event.summary, event.kind, event.runId, event.piece].join(' ').toLowerCase().includes(state.filters.search.toLowerCase()))); }
function updateEvents(events, id = 'events-list') {
  const element = document.getElementById(id); if (!element) return;
  const select = $('select[data-filter=kind]');
  if (select && document.activeElement !== select) {
    const source = state.detail ? [...state.detailEvents.values()] : state.eventSnapshot || state.overview.events;
    const kinds = [...new Set([...source.map((event) => event.kind), ...(state.filters.kind ? [state.filters.kind] : [])])].sort();
    const choices = '<option value="">All events</option>' + kinds.map((kind) => '<option value="' + escape(kind) + '"' + (state.filters.kind === kind ? ' selected' : '') + '>' + escape(human(kind)) + '</option>').join('');
    if (select._choices !== choices) { select.innerHTML = choices; select._choices = choices; }
  }
  const wasAtEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
  patch(id, events.length ? eventRows(events) : empty('No events in this view', 'Recorded events will appear here. Adjust the filter to see other event types.', 'events', '', true));
  if (state.tail && wasAtEnd) element.scrollTop = element.scrollHeight;
}
function infoRows(rows) { return '<dl class="info-list">' + rows.map(([key, value]) => '<div class="info-row"><dt>' + escape(key) + '</dt><dd>' + escape(value ?? '—') + '</dd></div>').join('') + '</dl>'; }
function projectCards() { return state.overview.projects.length ? '<div class="cards-grid">' + state.overview.projects.map((project) => '<article class="panel project-card"><div class="card-top"><div class="card-icon">' + icon('projects') + '</div>' + button('Open', 'project', 'arrow', false, 'data-project="' + escape(project.id) + '"') + '</div><h2><a href="#projects/' + encodeURIComponent(project.id) + '">' + escape(project.name) + '</a></h2><div class="path">' + escape(project.path) + '</div>' + (project.error ? '<p class="small-note amber-text">' + escape(project.error) + '</p>' : '') + '<div class="card-details"><span><strong>' + project.runCount + '</strong> runs</span><span><strong>' + project.activeCount + '</strong> active</span><span><strong>' + project.goals.length + '</strong> goals</span></div></article>').join('') + '</div>' : panel('Registered projects', empty('Connect your first project', 'Add a local repository to see its runs, goals and operational evidence.', 'projects', button('Add project', 'add-project', 'plus', true))); }
function agentCards() { return state.overview.agents.length ? '<div class="cards-grid">' + state.overview.agents.map((agent) => '<article class="panel agent-card"><div class="card-top"><div class="card-icon">' + icon('agents') + '</div><span class="badge flat">' + escape(agent.role) + '</span></div><h2><a href="#agents/' + encodeURIComponent(agent.id) + '">' + escape(agent.name) + '</a></h2><p>' + escape(agent.description) + '</p><div class="tags">' + agent.tools.slice(0, 4).map((tool) => '<span class="tag">' + escape(tool) + '</span>').join('') + (agent.tools.length > 4 ? '<span class="tag">+' + (agent.tools.length - 4) + '</span>' : '') + '</div><div class="card-details"><span>' + escape(agent.model) + '</span><a href="#agents/' + encodeURIComponent(agent.id) + '" class="text-button">View instructions ↗</a></div></article>').join('') + '</div>' : panel('Agent definitions', empty('No agent definitions available', 'The local server could not load agent instructions. Check diagnostics for plugin configuration.', 'agents')); }

function renderRoute() {
  if (!state.authenticated || !state.overview) return;
  const route = location.hash.slice(1) || 'operations';
  if (route === state.route) return;
  state.route = route; state.detail = null; state.detailEvents = new Map(); state.detailCursor = 0; state.hasEarlier = false; state.job = null; state.filters = { search: '', status: '', project: '', kind: '' }; state.eventSnapshot = null; state.tail = true;
  const [page, first, second] = route.split('/').map(decodePart);
  const active = page === 'jobs' ? 'plans' : page;
  $$('.nav-link').forEach((node) => { const selected = node.dataset.nav === active; node.classList.toggle('active', selected); if (selected) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
  $('#breadcrumb').textContent = (nav.find(([id]) => id === active)?.[1] || 'Workspace') + (first ? ' / Details' : '');
  document.title = 'Genesis · ' + $('#breadcrumb').textContent;
  $('#sidebar').classList.remove('open'); $('#menu-toggle').setAttribute('aria-expanded', 'false');
  let html;
  if (page === 'operations') html = heading('Operations', 'A live view of your builds, agents and execution evidence.', actions([button('Create plan', 'new-plan', 'plans'), button('Start a run', 'new-run', 'plus', true)]), 'Control plane') + '<div id="overview-stats"></div><div class="grid-main"><div><section class="panel"><div class="panel-head"><div class="title-group"><h2>Recent runs</h2><span class="count" id="recent-count"></span></div><a class="text-button" href="#runs">View all runs ↗</a></div>' + runFilters() + '<div id="runs-table"></div><div class="panel-footer"><span>Latest local run records</span><span id="recent-source"></span></div></section><div id="active-jobs" class="stack-space"></div></div><aside class="right-column"><div id="recent-activity"></div><div id="workspace-card"></div></aside></div>';
  else if (page === 'runs' && first && second) html = '<a class="back-link" href="#runs">' + icon('back') + 'All runs</a><div id="run-heading"></div><div id="run-warnings"></div><div class="detail-layout"><div class="detail-main"><div id="run-lifecycle"></div><section class="panel"><div class="panel-head"><div class="title-group"><h2>Execution events</h2><span id="event-count" class="count">0</span></div>' + eventControls(true) + '</div><div class="panel-footer"><button class="text-button" data-action="older-events" id="older-events" disabled>Load older events</button><span id="event-evidence">Reading trace…</span></div><div class="events" id="events-list" data-preserve-scroll></div></section><div id="run-pieces" class="stack-space"></div></div><aside class="right-column"><div id="run-budget"></div><div id="run-context"></div><div id="run-processes"></div><div id="run-artifacts"></div></aside></div>';
  else if (page === 'runs') html = heading('Runs', 'Every build, its outcome and the evidence behind it.', actions([button('Export JSON', 'export-runs', 'export'), button('Start a run', 'new-run', 'plus', true)]), 'Execution') + '<div id="overview-stats"></div><section class="panel"><div class="panel-head"><div class="title-group"><h2>Run history</h2><span class="count" id="recent-count"></span></div><span class="subheading">ALL REGISTERED PROJECTS</span></div>' + runFilters() + '<div id="runs-table"></div><div class="panel-footer"><span id="run-results"></span><span>Provider-reported spend</span></div></section>';
  else if (page === 'plans') html = heading('Plans', 'Preview the quality bar and decomposition before building.', actions([button('Create a plan', 'new-plan', 'plus', true)]), 'Intent → execution') + '<div id="plans-list"></div><div id="other-jobs" class="stack-space"></div>';
  else if (page === 'jobs' && first) html = '<a class="back-link" href="#plans">' + icon('back') + 'Command jobs</a><div id="job-heading"></div><div class="detail-layout"><div id="job-output"></div><aside id="job-info"></aside></div>';
  else if (page === 'projects' && first) html = '<a class="back-link" href="#projects">' + icon('back') + 'All projects</a><div id="project-heading"></div><div id="project-detail"></div>';
  else if (page === 'projects') html = heading('Projects', state.requiresLogin ? 'Server repositories connected to this shared workspace.' : 'Local repositories connected to this workspace.', actions([button('Add project', 'add-project', 'plus', true)]), 'Workspace') + '<div id="projects-grid"></div>';
  else if (page === 'agents' && first) html = '<a class="back-link" href="#agents">' + icon('back') + 'Agent definitions</a><div id="agent-detail"></div>';
  else if (page === 'agents') html = heading('Agents', 'The instructions and capabilities behind each role.', '', 'Execution roles') + '<div id="agents-grid"></div><p class="small-note">Definitions loaded from the installed plugin. Live task instances appear in each run’s detail view.</p>';
  else if (page === 'telemetry') html = heading('Telemetry', 'Observed consumption and outcomes across registered projects.', actions([button('Export JSON', 'export-overview', 'export')]), 'Evidence & utilization') + '<div id="telemetry-stats"></div><div class="chart-grid"><div id="spend-chart"></div><div id="outcome-chart"></div></div><div id="project-spend" class="stack-space"></div><p class="small-note">Local session totals and distributed round costs use provider receipts. Nested local piece and round dollar splits are unavailable; missing values are never estimates.</p>';
  else if (page === 'events') html = heading('Events', 'A live, inspectable stream of operational evidence.', actions([button('Export JSON', 'export-events', 'export')]), 'Activity stream') + '<section class="panel"><div class="panel-head"><h2>Workspace events</h2>' + eventControls() + '</div><div class="toolbar"><label class="search">' + icon('search') + '<input type="search" data-filter="search" aria-label="Search events" placeholder="Search event text…"></label><select data-filter="project" aria-label="Filter project"><option value="">All projects</option>' + projectOptions() + '</select><span class="toolbar-label">LATEST RECORDED EVENTS</span></div><div class="events workspace-events" id="events-list" data-preserve-scroll></div><div class="panel-footer"><span id="workspace-event-count"></span><span>Open a run for its complete history</span></div></section>';
  else if (page === 'settings') html = heading('Settings', 'Local panel preferences and environment diagnostics.', '', 'Workspace configuration') + '<div class="settings-layout"><div>' + panel('Appearance & refresh', '<div class="panel-body"><div class="setting-row"><div><h3>Color theme</h3><p>Choose a palette or follow your system preference.</p></div><select id="theme-select" aria-label="Color theme">' + ['dark', 'light', 'system'].map((value) => '<option value="' + value + '"' + (state.theme === value ? ' selected' : '') + '>' + value[0].toUpperCase() + value.slice(1) + '</option>').join('') + '</select></div><div class="setting-row"><div><h3>Live refresh</h3><p>Read fresh workspace evidence every two seconds. Forms and selected text stay in place.</p></div><label class="checkbox-label"><input id="refresh-toggle" type="checkbox"' + (state.polling ? ' checked' : '') + '> Enabled</label></div></div>') + panel('Environment diagnostics', '<div class="panel-body"><p class="small-note intro-note">Inspect configuration, plugin files and local run records. These checks do not call a model or prove execution permission.</p><div class="actions"><select id="diagnostic-project" aria-label="Project to diagnose">' + projectOptions() + '</select>' + button('Run diagnostics', 'diagnostics', 'terminal', false, state.overview.projects.length ? '' : 'disabled') + '</div><div id="diagnostics-result"></div></div>') + '</div><aside>' + panel('About this panel', '<div class="panel-body">' + infoRows([['Version', state.overview.version], ['Connection', state.requiresLogin ? 'Shared server' : 'Local HTTP'], ['Projects', state.overview.projects.length], ['Started', date(state.overview.startedAt)]]) + '<p class="small-note">The panel runs existing Genesis commands and reads their durable evidence. Model credentials stay in the server?s CLI environment.</p></div>') + panel('Project access', '<div class="panel-body"><p class="small-note no-top-margin">Only registered project directories are visible here. Removing one from the panel leaves its files and run history on disk.</p><div class="actions spaced-actions"><a class="button" href="#projects">Manage projects ' + icon('arrow') + '</a></div></div>') + '</aside></div>';
  else html = empty('This page does not exist', 'Choose a page from the sidebar to return to your workspace.', 'operations', '<a class="button primary" href="#operations">Open operations</a>');
  $('#main').innerHTML = html; window.scrollTo(0, 0); refreshView();
  if (page === 'runs' && first && second) void fetchDetail(first, second, true);
  if (page === 'jobs' && first) void fetchJob(first);
}

function refreshView() {
  if (!state.authenticated || !state.overview) return;
  const data = state.overview, [page, first] = state.route.split('/').map(decodePart);
  $('#version').textContent = 'v' + data.version;
  $('#nav-count-runs').textContent = data.totals.running ? String(data.totals.running) : '';
  $('#nav-count-plans').textContent = data.jobs.filter((job) => job.action === 'plan' && ['running', 'starting'].includes(job.status)).length || '';
  if (page === 'operations' || (page === 'runs' && !first)) {
    patch('overview-stats', overallStats()); const runs = filteredRuns(data.runs); patch('runs-table', runsTable(page === 'operations' ? runs.slice(0, 8) : runs, page === 'operations'));
    if ($('#recent-count')) $('#recent-count').textContent = String(data.runs.length);
    if ($('#run-results')) $('#run-results').textContent = runs.length + ' of ' + data.runs.length + ' runs';
    if ($('#recent-source')) $('#recent-source').textContent = state.polling ? 'AUTO-REFRESH · 2s' : 'REFRESH PAUSED';
    patch('recent-activity', panel('Recent activity', activity(data.events), { action: '<a class="text-button" href="#events">View all ↗</a>' }));
    patch('workspace-card', panel('Workspace', '<div class="panel-body">' + infoRows([['Projects', data.projects.length + ' registered'], ['Agent roles', data.agents.length], ['Active jobs', data.jobs.filter((job) => ['starting', 'running'].includes(job.status)).length], ['Mode', state.requiresLogin ? 'Server execution' : 'Local execution']]) + '<div class="actions spaced-actions">' + button('Add project', 'add-project', 'plus') + '</div></div>'));
    const activeJobs = data.jobs.filter((job) => ['running', 'starting'].includes(job.status)); patch('active-jobs', activeJobs.length ? panel('Command jobs in progress', jobTable(activeJobs), { count: activeJobs.length }) : '');
  } else if (page === 'plans') { const plans = data.jobs.filter((job) => job.action === 'plan'); patch('plans-list', panel('Planning sessions', jobTable(plans), { count: plans.length })); const others = data.jobs.filter((job) => job.action !== 'plan'); patch('other-jobs', others.length ? panel('Other command jobs', jobTable(others), { count: others.length }) : ''); }
  else if (page === 'projects' && !first) patch('projects-grid', projectCards());
  else if (page === 'projects' && first) renderProject(first);
  else if (page === 'agents' && !first) patch('agents-grid', agentCards());
  else if (page === 'agents' && first) renderAgent(first);
  else if (page === 'telemetry') renderTelemetry();
  else if (page === 'events') { if (state.tail || !state.eventSnapshot) state.eventSnapshot = data.events; const events = eventFilter(state.eventSnapshot); updateEvents(events); $('#workspace-event-count').textContent = events.length + ' events · ' + (state.tail ? 'Following live updates' : 'Follow paused'); }
  if (page === 'runs' && first && state.detail) renderRunDetail();
}
function renderProject(id) {
  const project = state.overview.projects.find((value) => value.id === id);
  if (!project) { patch('project-heading', empty('Project is no longer registered', 'Add it again to view its local evidence.', 'projects', button('Add project', 'add-project', 'plus'))); return; }
  patch('project-heading', heading(project.name, project.path, actions([button('Remove', 'remove-project', 'trash', false, 'data-project="' + escape(id) + '"'), button('Create plan', 'new-plan', 'plans', false, 'data-project="' + escape(id) + '"'), button('Research decisions', 'research-decisions', 'search', false, 'data-project="' + escape(id) + '"'), button('Start a run', 'new-run', 'plus', true, 'data-project="' + escape(id) + '"')]), 'Project'));
  const goals = project.goals.length ? '<div class="panel-body">' + project.goals.map((goal) => '<div class="setting-row"><div><h3>' + escape(goal.name) + '</h3><p>' + escape(goal.description) + '</p></div>' + button('Run goal', 'goal-run', 'runs', false, 'data-project="' + escape(id) + '" data-goal="' + escape(goal.name) + '"') + '</div>').join('') + '</div>' : empty('No named goals', 'Create reusable goals with the Genesis CLI. They will appear here automatically.', 'plans', '', true);
  patch('project-detail', (project.error ? '<div class="warning-note">' + escape(project.error) + '</div>' : '') + '<div class="grid-main"><div>' + panel('Run history', runsTable(state.overview.runs.filter((run) => run.projectId === id), true)) + '</div><aside>' + panel('Named goals', goals, { count: project.goals.length }) + panel('Project details', '<div class="panel-body">' + infoRows([['Registered ID', id], ['Recorded runs', project.runCount], ['Active runs', project.activeCount]]) + '</div>') + '</aside></div>');
}
function renderAgent(id) {
  const agent = state.overview.agents.find((value) => value.id === id); if (!agent) { patch('agent-detail', empty('Agent definition unavailable', 'The plugin may have changed. Return to the agent list.', 'agents')); return; }
  patch('agent-detail', heading(agent.name, agent.description, '<span class="badge flat">' + escape(agent.role) + '</span>', 'Agent definition') + '<div class="detail-layout"><div>' + panel('Instructions', '<div class="panel-body"><pre>' + escape(agent.prompt) + '</pre></div>') + '</div><aside>' + panel('Configuration', '<div class="panel-body">' + infoRows([['Model', agent.model], ['Source', agent.source], ['Role', agent.role]]) + '</div>') + panel('Available tools', '<div class="panel-body"><div class="tags">' + (agent.tools.map((tool) => '<span class="tag">' + escape(tool) + '</span>').join('') || '<span class="muted">No explicit tool list.</span>') + '</div></div>') + '</aside></div>');
}
function renderTelemetry() {
  const data = state.overview;
  patch('telemetry-stats', stats([['Reported spend', money(data.totals.costUsd), 'Available provider receipts', 'money', 'green'], ['Input tokens', count(data.totals.inputTokens), 'Reported input consumption', 'telemetry'], ['Output tokens', count(data.totals.outputTokens), 'Reported output consumption', 'telemetry'], ['Total runs', count(data.runs.length), data.projects.length + ' registered projects', 'runs']]));
  const projectSpend = data.projects.map((project) => { const runs = data.runs.filter((run) => run.projectId === project.id), known = runs.filter((run) => run.costUsd !== null); return { ...project, runs, cost: known.length ? known.reduce((sum, run) => sum + run.costUsd, 0) : null }; });
  const max = Math.max(1, ...projectSpend.map((project) => project.cost || 0));
  patch('spend-chart', panel('Spend by project', projectSpend.length ? '<div class="panel-body bar-chart">' + projectSpend.map((project) => '<div class="bar-row"><span title="' + escape(project.name) + '">' + escape(project.name) + '</span><div class="progress-track"><div class="progress-fill" data-width="' + Math.max(0, Math.min(100, (project.cost || 0) / max * 100)) + '%"></div></div><strong>' + money(project.cost) + '</strong></div>').join('') + '</div>' : empty('No spend recorded', 'Costs appear when a provider reports usage.', 'money', '', true)));
  patch('outcome-chart', panel('Run outcomes', '<div class="panel-body">' + ['running', 'complete', 'blocked', 'stopped'].map((status) => '<div class="bar-row"><span>' + escape(human(status)) + '</span><div class="progress-track"><div class="progress-fill' + (status === 'blocked' ? ' amber' : '') + '" data-width="' + (data.runs.length ? data.totals[status] / data.runs.length * 100 : 0) + '%"></div></div><strong>' + data.totals[status] + '</strong></div>').join('') + '</div>'));
  patch('project-spend', panel('Project accounting', projectSpend.length ? '<div class="table-scroll"><table><thead><tr><th>Project</th><th>Runs</th><th>Active</th><th>Observed spend</th><th>Coverage</th></tr></thead><tbody>' + projectSpend.map((project) => '<tr><td><a class="row-title" href="#projects/' + encodeURIComponent(project.id) + '">' + escape(project.name) + '</a></td><td class="mono">' + project.runs.length + '</td><td class="mono">' + project.activeCount + '</td><td class="mono">' + money(project.cost) + '</td><td class="mono muted">' + project.runs.filter((run) => run.costUsd !== null).length + ' / ' + project.runs.length + ' with receipts</td></tr>').join('') + '</tbody></table></div>' : empty('No projects connected', 'Add a project to see its recorded accounting.', 'projects', '', true)));
}

async function fetchDetail(projectId, id, initial = false, older = false) {
  const route = state.route;
  try {
    const values = [...state.detailEvents.values()];
    const query = new URLSearchParams({ projectId, limit: '200' });
    if (older && values.length) query.set('before', String(Math.min(...values.map((event) => event.seq))));
    else if (!initial && state.detailCursor) query.set('after', String(state.detailCursor));
    const detail = await api('/api/runs/' + encodeURIComponent(id) + '?' + query);
    if (route !== state.route) return;
    const element = $('#events-list'), height = element?.scrollHeight || 0, top = element?.scrollTop || 0;
    for (const event of detail.events) state.detailEvents.set(event.seq, event);
    state.detail = detail; state.detailCursor = Math.max(state.detailCursor, detail.cursor || 0);
    if (initial || older) state.hasEarlier = Boolean(detail.hasEarlier);
    renderRunDetail();
    if (initial && element && state.tail) element.scrollTop = element.scrollHeight;
    else if (older && element) element.scrollTop = top + element.scrollHeight - height;
  } catch (error) { if (route === state.route) { patch('run-warnings', '<div class="warning-note">' + escape(error.message) + ' ' + button('Retry', 'retry-detail', 'refresh') + '</div>'); if (!state.detail) patch('run-heading', heading('Run unavailable', 'Its local record could not be read.')); } }
  finally { state.loadingEarlier = false; }
}
function renderRunDetail() {
  const detail = state.detail; if (!detail) return;
  const run = detail.run, options = 'data-project="' + escape(run.projectId) + '" data-run="' + escape(run.id) + '"';
  patch('run-heading', '<div class="page-heading detail-heading"><div><div class="eyebrow">' + escape(run.projectName) + ' / execution</div><div class="detail-title"><h1>' + escape(run.input || run.id) + '</h1>' + badge(run.stalled ? 'stalled' : run.status) + '</div><div class="run-id">' + escape(run.id) + '</div></div>' + actions([button('Export', 'export-run', 'export'), ...(run.canResume ? [button('Resume', 'resume-run', 'runs', true, options)] : []), ...(run.canStop ? [button('Stop run', 'stop-run', 'stop', false, options)] : [])]) + '</div>');
  patch('run-warnings', [...detail.warnings, ...(detail.degraded ? ['Some trace data is unavailable. This view may show only the last written state.'] : [])].map((text) => '<div class="warning-note">' + escape(text) + '</div>').join(''));
  const phase = run.phase.toLowerCase(), activeStage = run.status === 'complete' ? 4 : /critic|judg|verdict/.test(phase) ? 3 : /verif|gate/.test(phase) ? 2 : /build|round/.test(phase) ? 1 : /initial|start|preflight|planning/.test(phase) ? 0 : -1;
  const phaseLabel = activeStage < 0 ? human(run.status) + ' ? latest execution phase unavailable' : human(run.phase);
  patch('run-lifecycle', panel('Run lifecycle', '<div class="lifecycle">' + ['Initialize', 'Build', 'Verify', 'Judge', 'Complete'].map((name, index) => '<div class="stage' + (index <= activeStage ? ' reached' : '') + (index === activeStage ? ' current' : '') + '"><span>' + (index < activeStage ? '✓' : index + 1) + '</span>' + name + '</div>').join('') + '</div>', { action: '<span class="subheading">' + escape(phaseLabel) + '</span>' }));
  const events = [...state.detailEvents.values()].sort((a, b) => a.seq - b.seq).filter((event) => !state.filters.kind || event.kind === state.filters.kind);
  updateEvents(events); $('#event-count').textContent = count(state.detailEvents.size); $('#event-evidence').textContent = run.source === 'trace' ? 'TRACE EVIDENCE' : 'LAST WRITTEN';
  $('#older-events').disabled = !state.hasEarlier || state.loadingEarlier; $('#older-events').textContent = state.loadingEarlier ? 'Loading…' : state.hasEarlier ? 'Load older events' : 'Beginning of recorded trace';
  const percentage = run.maxCostUsd && run.costUsd !== null ? Math.min(100, run.costUsd / run.maxCostUsd * 100) : 0;
  patch('run-budget', panel('Budget & usage', '<div class="panel-body"><div class="budget-row"><span class="budget-amount">' + money(run.costUsd) + '</span><span class="budget-limit">' + (run.maxCostUsd !== null ? '/ ' + money(run.maxCostUsd) : 'no recorded cap') + '</span></div>' + (run.maxCostUsd !== null ? '<div class="progress-track" role="meter" aria-label="Cost budget used" aria-valuenow="' + Math.round(percentage) + '" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill' + (percentage >= 80 ? ' amber' : '') + '" data-width="' + percentage + '%"></div></div>' : '') + '<div class="budget-info">' + infoRows([['Rounds', run.rounds + (run.maxRounds !== null ? ' / ' + run.maxRounds : '')], ['Input tokens', run.tokens ? count(run.tokens.input) : 'Unavailable'], ['Output tokens', run.tokens ? count(run.tokens.output) : 'Unavailable']]) + '</div><p class="small-note">Provider receipts may arrive after execution. Unattributed piece costs stay unavailable.</p></div>'));
  patch('run-context', panel('Run context', '<div class="panel-body">' + infoRows([['Project', run.projectName], ['Started', date(run.startedAt)], ['Finished', run.finishedAt ? date(run.finishedAt) : '—'], ['Liveness', run.live], ['Last verdict', run.lastVerdict], ['Lead', run.models.lead], ['Builder', run.models.builder], ['Critic', run.models.critic], ['Evidence', run.source]]) + '</div>'));
  patch('run-processes', panel('Task processes', detail.processes.length ? '<div class="panel-body">' + detail.processes.map((process) => '<div class="info-row"><dt>' + escape(process.role) + '<span class="row-sub">' + escape(process.piece || process.taskId) + '</span></dt><dd>' + escape(process.closedAt ? process.outcome || 'closed' : 'open') + '<span class="row-sub">' + ago(process.openedAt) + '</span></dd></div>').join('') + '</div>' : empty('No process evidence', 'No task process records are available for this run.', 'agents', '', true), { count: detail.processes.filter((process) => !process.closedAt).length }));
  patch('run-artifacts', panel('Download artifacts', detail.artifacts.length ? '<div class="panel-body">' + detail.artifacts.filter((artifact) => artifact.url.startsWith('/api/artifacts/')).map((artifact) => '<a class="artifact" href="' + escape(artifact.url) + '" target="_blank" rel="noopener noreferrer">' + icon(artifact.kind === 'progress' ? 'operations' : 'file') + '<span>' + escape(artifact.name) + '</span><span>↗</span></a>').join('') + '</div>' : empty('No artifacts yet', 'Available run files will appear here when written.', 'file', '', true)));
  patch('run-pieces', panel('Piece evidence', detail.pieces.length ? '<div class="table-scroll"><table><thead><tr><th>Piece</th><th>Round</th><th>Verdict</th><th>Attributed spend</th></tr></thead><tbody>' + detail.pieces.map((piece) => '<tr><td class="mono">' + escape(piece.id) + '</td><td class="mono">' + piece.round + '</td><td>' + (piece.verdict ? badge(piece.verdict) : '<span class="muted">—</span>') + '</td><td class="mono">' + money(piece.costUsd) + '</td></tr>').join('') + '</tbody></table></div>' : empty('No piece evidence yet', 'Dispatched pieces and verdicts will appear as the run records them.', 'plans', '', true), { count: detail.pieces.length }));
}
async function fetchJob(id) {
  const route = state.route;
  try { const result = await api('/api/jobs/' + encodeURIComponent(id)); if (route !== state.route) return; state.job = result.job; renderJob(); }
  catch (error) { if (route === state.route) patch('job-heading', heading('Job unavailable', error.message, actions([button('Retry', 'retry-job', 'refresh')]))); }
}
function renderJob() {
  const job = state.job; if (!job) return;
  const previousOutput = $('#job-output-scroll');
  const atEnd = !previousOutput || previousOutput.scrollHeight - previousOutput.scrollTop - previousOutput.clientHeight < 40;
  patch('job-heading', heading(human(job.action)[0].toUpperCase() + human(job.action).slice(1) + ' session', job.projectName + ' · ' + job.id, actions([badge(job.status), button('Export JSON', 'export-job', 'export'), ...(['starting', 'running'].includes(job.status) ? [button('Stop command', 'stop-job', 'stop', false, 'data-project="' + escape(job.projectId) + '"' + (job.runId ? ' data-run="' + escape(job.runId) + '"' : ''))] : [])]), 'Command execution'));
  const output = job.output.map((entry) => '<div class="output-line ' + (entry.stream === 'stderr' ? 'stderr' : '') + '">' + escape(entry.text) + '</div>').join('');
  patch('job-output', panel('Command output', (job.error ? '<div class="warning-note inset-warning">' + escape(job.error) + '</div>' : '') + (output ? '<div class="output" id="job-output-scroll" data-preserve-scroll>' + output + '</div>' : empty('Waiting for command output', 'The command is starting. Its actual output will appear here.', 'terminal', '', true)), { action: '<span class="subheading">STDOUT / STDERR</span>' }));
  const currentOutput = $('#job-output-scroll');
  if (atEnd && currentOutput) currentOutput.scrollTop = currentOutput.scrollHeight;
  patch('job-info', panel('Job details', '<div class="panel-body">' + infoRows([['Action', job.action], ['Project', job.projectName], ['Started', date(job.createdAt)], ['Finished', job.finishedAt ? date(job.finishedAt) : '—'], ['Exit code', job.exitCode], ['Process ID', job.pid]]) + (job.runId ? '<div class="actions spaced-actions"><a class="button primary" href="#runs/' + encodeURIComponent(job.projectId) + '/' + encodeURIComponent(job.runId) + '">Open run ' + icon('arrow') + '</a></div>' : '') + '<p class="small-note">This is the command’s recorded output. A successful plan previews work; it does not mean a build has completed.</p></div>'));
}

function modal(title, description, body, footer, formId) {
  const dialog = $('#modal');
  $('#modal-content').innerHTML = (formId ? '<form id="' + formId + '">' : '') + '<div class="modal-head"><div><h2 id="modal-title">' + escape(title) + '</h2><p>' + escape(description) + '</p></div><button type="button" class="icon-button" data-action="close-modal" aria-label="Close dialog">' + icon('close') + '</button></div><div class="modal-body"><div id="form-error" class="form-error" role="alert" hidden></div>' + body + '</div><div class="modal-footer">' + footer + '</div>' + (formId ? '</form>' : '');
  if (!dialog.open) dialog.showModal();
  const first = $('input:not([type=hidden]),textarea,select', dialog); first?.focus();
}
function formError(error) { const node = $('#form-error'); if (node) { node.textContent = error.message || String(error); node.hidden = false; } else notify(error.message || String(error), true); }
function modelOptions(values, selected = 'inherit') { return values.map((value) => { const item = typeof value === 'string' ? { value, label: value } : value; return '<option value="' + escape(item.value) + '"' + (item.value === selected ? ' selected' : '') + '>' + escape(item.label) + '</option>'; }).join(''); }
function openJob(action = 'run', projectId = '', input = '', runId = '') {
  if (!state.overview.projects.length) { openAddProject(); return; }
  const resume = action === 'resume', planning = action === 'plan';
  const models = state.overview.models.length ? state.overview.models : [{ value: 'inherit', label: 'Inherit CLI default' }];
  const agentModels = state.overview.agentModels.length ? state.overview.agentModels : ['inherit'];
  const body = '<input type="hidden" name="action" value="' + action + '">' + (runId ? '<input type="hidden" name="runId" value="' + escape(runId) + '">' : '') + '<div class="field"><label for="job-project">Project</label><select id="job-project" name="projectId" required' + (resume ? ' disabled' : '') + '>' + projectOptions(projectId || state.overview.projects[0].id) + '</select>' + (resume ? '<input type="hidden" name="projectId" value="' + escape(projectId) + '">' : '') + '</div>' + (!resume ? '<div class="field"><label for="job-input">Goal or specification path</label><textarea id="job-input" name="input" placeholder="What should Genesis accomplish? Or enter a project-relative spec path." required maxlength="16384">' + escape(input) + '</textarea><small>A concrete outcome gives the loop a checkable quality bar.</small></div><div class="field"><label for="job-model">Lead model</label><select id="job-model" name="model">' + modelOptions(models) + '</select></div>' : '<p class="small-note resume-note">Continue run <span class="mono">' + escape(runId) + '</span> with its saved context and models.</p>') + (!planning ? '<div class="field-grid"><div class="field"><label for="job-cost">Cost cap (USD)</label><input id="job-cost" name="maxCostUsd" type="number" min="0.01" step="0.01" placeholder="CLI default"><small>' + (resume ? 'Leave blank to retain the saved cap.' : 'Leave blank to use the CLI default.') + '</small></div><div class="field"><label for="job-rounds">Round cap</label><input id="job-rounds" name="maxRounds" type="number" min="1" step="1" placeholder="CLI default"></div></div>' : '') + (!resume ? '<details class="disclosure"><summary>Model roles & execution options</summary><div class="field-grid"><div class="field"><label for="job-builder">Builder model</label><select id="job-builder" name="builderModel"><option value="">CLI default</option>' + modelOptions(agentModels, '') + '</select></div><div class="field"><label for="job-critic">Critic model</label><select id="job-critic" name="criticModel"><option value="">CLI default</option>' + modelOptions(agentModels, '') + '</select></div></div><div class="field-grid"><div class="field"><label for="job-turns">Maximum turns</label><input id="job-turns" name="maxTurns" type="number" min="1" step="1" placeholder="CLI default"></div><div class="field"><label for="job-permission">Permission mode</label><select id="job-permission" name="permissionMode"><option value="">CLI default</option><option value="bypassPermissions">bypassPermissions</option><option value="acceptEdits">acceptEdits</option><option value="default">default</option></select></div></div><p class="small-note">' + (planning ? 'Planning previews the bar and decomposition without building.' : 'Unattended builds execute verification commands. The CLI checks execution permission before building.') + '</p>' + (planning ? '<label class="checkbox-label plan-overwrite"><input type="checkbox" name="force"> Replace an existing captured bar (--force)</label>' : '') + '</details>' : '');
  modal(resume ? 'Resume run' : planning ? 'Create a plan' : 'Start a run', resume ? 'Continue the existing run through the Genesis CLI.' : planning ? 'Inspect the proposed approach before committing to a build.' : 'Turn a concrete goal into a verified result.', body, '<button type="button" class="button" data-action="close-modal">Cancel</button><button type="submit" class="button primary">' + icon(resume ? 'runs' : planning ? 'plans' : 'plus') + (resume ? 'Resume run' : planning ? 'Create plan' : 'Start run') + '</button>', 'job-form');
}
function openAddProject() { modal('Add a project', state.requiresLogin ? 'Connect an existing directory on the Genesis server.' : 'Connect an existing directory on this machine.', '<div class="field"><label for="project-path">Absolute directory path</label><input id="project-path" name="path" placeholder="C:\\projects\\my-project or /home/me/project" required autocomplete="off"><small>The server validates and registers this directory. Files are not moved or copied.</small></div><div class="field"><label for="project-name">Display name <span class="muted">(optional)</span></label><input id="project-name" name="name" placeholder="Use directory name" maxlength="120"></div>', '<button type="button" class="button" data-action="close-modal">Cancel</button><button type="submit" class="button primary">' + icon('plus') + 'Add project</button>', 'project-form'); }
function openResearch(projectId = '') {
  const models = state.overview.models.length ? state.overview.models : [{ value: 'inherit', label: 'Inherit CLI default' }];
  modal('Research decisions', 'Resolve an eligible ticket in the project’s local decision map.', '<input type="hidden" name="action" value="chart"><div class="field"><label for="job-project">Project</label><select id="job-project" name="projectId" required>' + projectOptions(projectId || state.overview.projects[0]?.id) + '</select></div><div class="field"><label for="job-input">Decision ticket</label><input id="job-input" name="input" placeholder="Existing research or AFK task ticket name / ID" maxlength="16384" required><small>Choose an existing research or AFK task ticket. Create a new destination’s map with the interactive chart command first.</small></div><div class="field"><label for="job-model">Lead model</label><select id="job-model" name="model">' + modelOptions(models) + '</select></div><p class="small-note">This command uses local storage and AFK mode with read-only research tools. Human decisions remain pending; resolve them through a live charting conversation in the terminal.</p>', '<button type="button" class="button" data-action="close-modal">Cancel</button><button type="submit" class="button primary">' + icon('search') + 'Research ticket</button>', 'job-form');
}
function openStop(projectId, runId, command = false) { modal(command ? 'Stop this command?' : 'Stop this run?', 'Request a graceful stop and let Genesis settle its state.', '<input type="hidden" name="projectId" value="' + escape(projectId) + '">' + (runId ? '<input type="hidden" name="runId" value="' + escape(runId) + '">' : '') + '<p class="wide-copy">' + (runId ? 'The CLI waits for the run and any owned claim to settle.' : 'The panel interrupts its active command for this project, including planning or a build that is still in preflight.') + ' Existing evidence and work stay on disk.</p>' + (runId ? '<label class="checkbox-label"><input type="checkbox" name="force"> Force after the graceful timeout</label><p class="small-note">A forced stop may leave remote claims needing recovery. The command records and reports that aftermath.</p>' : ''), '<button type="button" class="button" data-action="close-modal">Keep running</button><button type="submit" class="button danger">' + icon('stop') + (command ? 'Stop command' : 'Stop run') + '</button>', 'stop-form'); }
function openRemoveProject(id) { const project = state.overview.projects.find((entry) => entry.id === id); if (!project) return; modal('Remove project from panel?', project.name, '<input type="hidden" name="projectId" value="' + escape(id) + '"><p class="wide-copy">This removes the project from this panel’s registry. Its repository files, run records and artifacts remain on disk.</p><div class="path">' + escape(project.path) + '</div>', '<button type="button" class="button" data-action="close-modal">Cancel</button><button type="submit" class="button danger">Remove project</button>', 'remove-project-form'); }
function download(name, value) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' })), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

document.addEventListener('submit', async (event) => {
  if (!['job-form', 'project-form', 'stop-form', 'remove-project-form'].includes(event.target.id)) return;
  event.preventDefault(); const form = event.target, submit = $('button[type=submit]', form), values = Object.fromEntries(new FormData(form));
  submit.disabled = true; $('#form-error').hidden = true;
  try {
    if (form.id === 'project-form') { const body = { path: values.path.trim() }; if (values.name.trim()) body.name = values.name.trim(); const result = await api('/api/projects', { method: 'POST', body: JSON.stringify(body) }); $('#modal').close(); notify('Project connected.'); await refresh(true); location.hash = 'projects/' + encodeURIComponent(result.project.id); }
    else if (form.id === 'remove-project-form') { await api('/api/projects/' + encodeURIComponent(values.projectId), { method: 'DELETE' }); $('#modal').close(); notify('Project removed from the panel.'); location.hash = 'projects'; await refresh(true); }
    else {
      const body = form.id === 'stop-form' ? { action: 'stop', projectId: values.projectId, ...(values.runId ? { runId: values.runId } : {}), ...(values.force ? { force: true } : {}) } : { action: values.action, projectId: values.projectId };
      if (form.id === 'job-form') for (const [key, value] of Object.entries(values)) { if (key === 'action' || key === 'projectId' || !String(value).trim()) continue; body[key] = key === 'force' ? true : ['maxCostUsd', 'maxRounds', 'maxTurns'].includes(key) ? Number(value) : String(value).trim(); }
      const result = await api('/api/jobs', { method: 'POST', body: JSON.stringify(body) }); $('#modal').close(); notify(human(body.action) + ' command started.'); await refresh(true); location.hash = 'jobs/' + encodeURIComponent(result.job.id);
    }
  } catch (error) { formError(error); }
  finally { submit.disabled = false; }
});
document.addEventListener('input', (event) => { if (event.target.dataset.filter === 'search') { state.filters.search = event.target.value; refreshView(); } });
document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.dataset.filter) { state.filters[target.dataset.filter] = target.value; refreshView(); }
  else if (target.id === 'tail-events') { state.tail = target.checked; if (state.tail) { state.eventSnapshot = null; refreshView(); } }
  else if (target.id === 'theme-select') setTheme(target.value);
  else if (target.id === 'refresh-toggle') { state.polling = target.checked; storage.set('refresh', state.polling ? 'on' : 'off'); if (state.polling) void refresh(true); }
});
document.addEventListener('click', async (event) => {
  const element = event.target.closest('[data-action]');
  if (!element) { const row = event.target.closest('[data-route]'); if (row && !event.target.closest('a,button,input,select,details') && !window.getSelection()?.toString()) location.hash = row.dataset.route; return; }
  const action = element.dataset.action, projectId = element.dataset.project, runId = element.dataset.run;
  if (action === 'close-modal') $('#modal').close();
  else if (action === 'new-run' || action === 'new-plan') openJob(action === 'new-plan' ? 'plan' : 'run', projectId);
  else if (action === 'goal-run') openJob('run', projectId, element.dataset.goal);
  else if (action === 'research-decisions') openResearch(projectId);
  else if (action === 'resume-run') openJob('resume', projectId, '', runId);
  else if (action === 'stop-run') openStop(projectId, runId);
  else if (action === 'stop-job') openStop(projectId, runId, true);
  else if (action === 'add-project') openAddProject();
  else if (action === 'remove-project') openRemoveProject(projectId);
  else if (action === 'project') location.hash = 'projects/' + encodeURIComponent(projectId);
  else if (action === 'clear-filters') { state.filters.search = ''; state.filters.status = ''; state.filters.project = ''; $$('[data-filter]').forEach((input) => { input.value = ''; }); refreshView(); }
  else if (action === 'export-runs') download('genesis-runs.json', filteredRuns(state.overview.runs));
  else if (action === 'export-overview') download('genesis-overview.json', state.overview);
  else if (action === 'export-events') download('genesis-events.json', eventFilter(state.eventSnapshot || state.overview.events));
  else if (action === 'export-run' && state.detail) download('genesis-' + state.detail.run.id + '.json', { ...state.detail, events: [...state.detailEvents.values()].sort((a, b) => a.seq - b.seq) });
  else if (action === 'export-job' && state.job) download('genesis-job-' + state.job.id + '.json', state.job);
  else if (action === 'older-events' || action === 'retry-detail') { const [, project, id] = state.route.split('/').map(decodePart); if (state.loadingEarlier) return; state.loadingEarlier = true; element.disabled = true; await fetchDetail(project, id, action === 'retry-detail', action === 'older-events'); }
  else if (action === 'retry-job') await fetchJob(decodeURIComponent(state.route.split('/')[1]));
  else if (action === 'diagnostics') {
    element.disabled = true; patch('diagnostics-result', '<p class="small-note">Checking local prerequisites…</p>');
    try { const result = await api('/api/diagnostics?projectId=' + encodeURIComponent($('#diagnostic-project').value)); patch('diagnostics-result', result.checks.map((check) => '<div class="diagnostic">' + badge(check.status === 'ok' ? 'complete' : check.status === 'error' ? 'failed' : check.status || 'unknown') + '<div><strong>' + escape(check.name || check.check || check.id || 'Check') + '</strong><p>' + escape(check.detail || check.message || '') + '</p></div></div>').join('')); }
    catch (error) { patch('diagnostics-result', '<p class="small-note red-text">' + escape(error.message) + '</p>'); }
    finally { element.disabled = false; }
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { $('#sidebar').classList.remove('open'); $('#menu-toggle').setAttribute('aria-expanded', 'false'); }
  if (event.key === '/' && !event.metaKey && !event.ctrlKey && !$('#modal').open && !event.target.matches('input,textarea,select,[contenteditable]')) { const search = $('input[type=search]'); if (search) { event.preventDefault(); search.focus(); } }
});
$('#modal').addEventListener('click', (event) => { if (event.target === $('#modal')) { const rect = $('#modal').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('#modal').close(); } });
window.addEventListener('hashchange', () => { renderRoute(); });
function refreshConnection() {
  const node = $('#connection'); node.classList.toggle('offline', Boolean(state.error));
  node.innerHTML = '<span class="status-dot"></span>' + (state.error ? 'Connection lost' : !state.overview ? 'Connecting' : state.polling ? state.requiresLogin ? 'Server connected' : 'System connected' : 'Refresh paused');
  $('#updated-at').textContent = state.lastUpdated ? 'Last observed ' + ago(state.lastUpdated) : 'Waiting for first observation';
  const warnings = state.overview?.errors || [];
  $('#error-banner').hidden = !state.error && warnings.length === 0;
  if (state.error) $('#error-message').textContent = state.error + (state.lastUpdated ? ' Showing evidence from ' + ago(state.lastUpdated) + '.' : '');
  else if (warnings.length) $('#error-message').textContent = warnings.join(' · ');
  $('#retry').textContent = state.error ? 'Retry connection' : 'Refresh evidence';
}
async function refresh(force = false) {
  if (state.busy || state.loginBusy && !force || (!force && (!state.polling || document.hidden))) return;
  state.busy = true;
  try {
    if (!state.sessionChecked || !state.csrf) await readSession();
    if (!state.authenticated) return;
    state.overview = await api('/api/overview'); state.lastUpdated = Date.now(); state.error = null;
    renderRoute(); refreshView();
    const [page, first, second] = state.route.split('/').map(decodePart);
    if (page === 'runs' && first && second && state.detail && !state.loadingEarlier) await fetchDetail(first, second);
    if (page === 'jobs' && first && state.job) await fetchJob(first);
  } catch (error) {
    state.error = error.message || 'Unable to reach the server.';
    if (!state.sessionChecked) { $('#auth-title').textContent = 'Server unavailable'; $('#auth-description').textContent = 'Genesis could not read this server’s session settings.'; authError(state.error); }
  }
  finally { state.busy = false; refreshConnection(); }
}
$('#retry').addEventListener('click', () => { state.csrf = null; void refresh(true); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
void refresh(true);
state.timer = setInterval(() => { refreshConnection(); void refresh(); }, 2000);
