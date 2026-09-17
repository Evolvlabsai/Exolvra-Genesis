import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startPanelServer } from '../dist/panel-server.js';
import { PanelProjects } from '../dist/panel-projects.js';
import { appendRun, runDirectory, writeState } from '../dist/runs-store.js';
import { openTrace } from '../dist/trace-store.js';
import { panelAccess, panelChildEnvironment, panelPublicUrl } from '../dist/panel-config.js';
import { BIN, PACKAGE_ROOT } from './run-cli.js';

process.env.EXOLVRA_GENESIS_TRACE_ENGINE = 'ndjson';

async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'genesis-panel-http-'));
  const panel = await startPanelServer({ root, port: 0, ...options });
  t.after(async () => { await panel.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }); });
  const get = (path, options = {}) => fetch(panel.localUrl + path, { signal: AbortSignal.timeout(10000), ...options });
  const csrfToken = (await (await get('/api/session')).json()).csrfToken;
  const send = (path, value, method = 'POST') => get(path, { method, headers: { 'Content-Type': 'application/json', 'X-Genesis-CSRF': csrfToken }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return { root, panel, get, send, csrfToken };
}

test('panel serves packaged assets and real empty workspace without creating a run', async t => {
  const { root, get } = await fixture(t);
  for (const [route, file, type] of [['/', 'index.html', 'text/html'], ['/styles.css', 'styles.css', 'text/css'], ['/app.js', 'app.js', 'text/javascript']]) {
    const response = await get(route);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.equal(await response.text(), readFileSync(join(PACKAGE_ROOT, 'panel', file), 'utf8'));
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  const overview = await (await get('/api/overview')).json();
  assert.equal(overview.projects.length, 1);
  assert.deepEqual(overview.runs, []);
  assert.deepEqual(overview.jobs, []);
  assert.equal(overview.totals.costUsd, null);
  assert.ok(overview.agents.some(a => a.role === 'builder'));
  assert.equal(existsSync(join(root, '.exolvra-genesis', 'runs.json')), false);
  assert.equal((await get('/package.json')).status, 404);
});

test('loopback API rejects foreign hosts, origins, tokenless writes and invalid bodies', async t => {
  const { panel, get, send, csrfToken } = await fixture(t);
  // Fetch owns its Host header; use a real raw HTTP client for the rebinding case.
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const req = request(panel.url + '/api/session', { headers: { Host: 'evil.example:4317' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await get('/api/session', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await get('/api/session', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await get('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await get('/api/projects', { method: 'POST', headers: { 'X-Genesis-CSRF': csrfToken, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await send('/api/projects', { path: 'x'.repeat(70000) })).status, 413);
  assert.equal((await send('/api/projects', [])).status, 400);
  assert.equal((await get('/api/projects', { method: 'POST', headers: { 'X-Genesis-CSRF': csrfToken, 'Content-Type': 'application/json' }, body: '{oops' })).status, 400);
  assert.equal((await get('/api/projects', { method: 'PUT' })).status, 405);
  assert.equal((await get('/api/jobs/missing')).status, 404);
});

test('project registration persists, deduplicates, and removal preserves all project files', async t => {
  const { root, get, send } = await fixture(t);
  const other = join(root, 'other'); mkdirSync(other); writeFileSync(join(other, 'keep.txt'), 'keep');
  const response = await send('/api/projects', { path: other, name: 'Other project' }); assert.equal(response.status, 201);
  const added = (await response.json()).project;
  assert.equal(added.name, 'Other project');
  const again = await (await send('/api/projects', { path: other })).json(); assert.equal(again.project.id, added.id);
  assert.equal(new PanelProjects(root).list().length, 2);
  assert.equal((await (await get('/api/overview')).json()).projects.length, 2);
  assert.equal((await send('/api/projects/' + added.id, undefined, 'DELETE')).status, 200);
  assert.equal(readFileSync(join(other, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(new PanelProjects(root).list().length, 1);
  assert.equal((await send('/api/projects', { path: join(root, 'missing') })).status, 400);
});

test('real trace pages, recorded cost and artifact downloads cross the HTTP boundary', async t => {
  const { root, get } = await fixture(t);
  const id = 'r.http-test', startedAt = new Date().toISOString();
  appendRun(root, { id, startedAt, status: 'complete', sessionId: 'receipt', input: '<script>inert input</script>', models: { lead: 'inherit', builder: 'inherit', critic: 'inherit' }, costUsd: 0.125 });
  mkdirSync(runDirectory(root, id), { recursive: true });
  writeState(root, 'complete', id);
  const trace = openTrace(root, id, () => {});
  for (let i = 1; i <= 8; i++) trace.append({ at: Date.now() + i, runId: id, kind: 'activity', piece: null, round: null, payload: { detail: 'event ' + i } });
  trace.close();
  const artifact = join(runDirectory(root, id), 'progress.html');
  writeFileSync(artifact, '<script>fetch("/api/session")</script>');
  const overview = await (await get('/api/overview')).json();
  const projectId = overview.projects[0].id;
  assert.equal(overview.runs[0].costUsd, 0.125);
  const base = '/api/runs/' + id + '?projectId=' + projectId;
  const newest = await (await get(base + '&limit=3')).json();
  assert.deepEqual(newest.events.map(e => e.seq), [6, 7, 8]); assert.equal(newest.hasEarlier, true);
  const older = await (await get(base + '&before=6&limit=3')).json(); assert.deepEqual(older.events.map(e => e.seq), [3, 4, 5]);
  const forward = await (await get(base + '&after=2&limit=2')).json(); assert.deepEqual(forward.events.map(e => e.seq), [3, 4]); assert.equal(forward.hasMore, true);
  assert.equal((await get(base + '&limit=501')).status, 400);
  assert.equal((await get(base + '&after=2&before=3')).status, 400);
  const download = await get('/api/artifacts/' + projectId + '/' + id + '/progress.html');
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.match(download.headers.get('content-security-policy'), /sandbox; default-src 'none'/);
  assert.equal(await download.text(), readFileSync(artifact, 'utf8'));
  assert.equal((await get('/api/artifacts/' + projectId + '/' + id + '/control.json')).status, 404);
});

test('launch API executes the real read-only doctor and surfaces its terminal result', async t => {
  const { root, get, send } = await fixture(t);
  const projectId = (await (await get('/api/overview')).json()).projects[0].id;
  assert.equal((await send('/api/jobs', { action: 'exec', projectId, input: 'echo no' })).status, 400);
  const response = await send('/api/jobs', { action: 'doctor', projectId }); assert.equal(response.status, 202);
  const started = (await response.json()).job;
  let job = started; const deadline = Date.now() + 15000;
  while (['starting', 'running'].includes(job.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    job = (await (await get('/api/jobs/' + started.id)).json()).job;
  }
  assert.ok(['succeeded', 'failed'].includes(job.status));
  assert.notEqual(job.exitCode, null);
  assert.ok(job.output.some(line => line.text.includes('checks')));
  assert.equal(existsSync(join(root, '.exolvra-genesis', 'runs.json')), false);
  const checks = (await (await get('/api/diagnostics?projectId=' + projectId)).json()).checks;
  assert.ok(checks.length > 0);
});

test('project storage refuses directory junctions and a closing listener releases its port', async t => {
  const root = mkdtempSync(join(tmpdir(), 'genesis-panel-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }));
  const project = join(root, 'project'), outside = join(root, 'outside'); mkdirSync(project); mkdirSync(outside);
  symlinkSync(outside, join(project, '.exolvra-genesis'), 'junction');
  assert.throws(() => new PanelProjects(project), /symbolic links/);
  const panel = await startPanelServer({ root, port: 0 }); const port = Number(new URL(panel.url).port);
  await panel.close(); await panel.close();
  const second = await startPanelServer({ root, port }); await second.close();
});

test('independent registries merge changes and reject a root redirected after startup', t => {
  const root = mkdtempSync(join(tmpdir(), 'genesis-panel-registry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['initial', 'other', 'third', 'outside']) mkdirSync(join(root, name));
  const a = new PanelProjects(join(root, 'initial')), b = new PanelProjects(join(root, 'initial'));
  a.add(join(root, 'other')); b.add(join(root, 'third'));
  assert.equal(a.list().length, 3);
  assert.equal(b.list().length, 3);
  renameSync(join(root, 'initial'), join(root, 'moved'));
  symlinkSync(join(root, 'outside'), join(root, 'initial'), 'junction');
  assert.throws(() => a.list(), /root changed|symbolic link/);
  assert.equal(existsSync(join(root, 'outside', '.exolvra-genesis')), false);
});

test('failed registrations leave no state and later corrupt projects remain removable without secret leakage', async t => {
  const { root, get, send } = await fixture(t);
  const bad = join(root, 'bad'); mkdirSync(join(bad, '.exolvra-genesis'), { recursive: true });
  writeFileSync(join(bad, '.exolvra-genesis', 'runs.json'), 'broken');
  assert.equal((await send('/api/projects', { path: bad })).status, 400);
  assert.equal(new PanelProjects(root).list().length, 1);
  writeFileSync(join(bad, '.exolvra-genesis', 'runs.json'), '[]');
  const token = 'ghp_' + 'a'.repeat(36);
  const added = (await (await send('/api/projects', { path: bad, name: token })).json()).project;
  writeFileSync(join(bad, '.exolvra-genesis', 'runs.json'), 'broken');
  const response = await get('/api/overview'); const text = await response.text();
  assert.equal(response.status, 200); assert.equal(text.includes(token), false);
  assert.ok(JSON.parse(text).projects.find(p => p.id === added.id).error);
  assert.equal((await send('/api/projects/' + added.id, undefined, 'DELETE')).status, 200);
  assert.equal(readFileSync(join(bad, '.exolvra-genesis', 'runs.json'), 'utf8'), 'broken');
});

test('dashboard CLI prints its bound URL, serves the UI and exits successfully on interrupt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'genesis-dashboard-cli-'));
  // IPC delivers Node's SIGINT event portably on Windows, as the session tests do.
  const driver = `process.argv = [process.execPath, ${JSON.stringify(BIN)}, 'dashboard', '-C', ${JSON.stringify(root)}, '--port', '0']; process.on('message', () => process.emit('SIGINT')); process.channel.unref(); await import(${JSON.stringify(pathToFileURL(BIN).href)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', driver], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }); });
  const deadline = Date.now() + 15000;
  while (!stdout.includes('Press Ctrl+C') && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  const url = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(url, stdout + stderr);
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200); assert.match(await response.text(), /Genesis/);
  child.send('interrupt');
  const [code] = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
});

test('shared sessions protect evidence and commands, bind CSRF to each member, and revoke logout', async t => {
  const token = 'shared-workspace-key-' + 'x'.repeat(32);
  const { get, csrfToken } = await fixture(t, { token });
  const anonymous = await (await get('/api/session')).json();
  assert.equal(anonymous.authenticated, false); assert.equal(anonymous.requiresLogin, true);
  assert.equal((await get('/api/overview')).status, 401);
  assert.equal((await get('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Genesis-CSRF': csrfToken }, body: '{}' })).status, 401);
  const login = key => get('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Genesis-CSRF': csrfToken }, body: JSON.stringify({ token: key }) });
  assert.equal((await login('incorrect access key')).status, 401);
  const one = await login(token), oneBody = await one.json();
  assert.equal(one.status, 200);
  const cookie = one.headers.get('set-cookie').split(';')[0];
  assert.match(one.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(one.headers.get('set-cookie').includes(token), false);
  assert.notEqual(oneBody.csrfToken, csrfToken);
  const two = await login(token), twoBody = await two.json(), secondCookie = two.headers.get('set-cookie').split(';')[0];
  const snapshot = await (await get('/api/overview', { headers: { Cookie: cookie } })).json();
  assert.ok(snapshot.projects.length > 0); assert.equal(JSON.stringify(snapshot).includes(token), false);
  assert.equal((await get('/api/logout', { method: 'POST', headers: { Cookie: cookie, 'X-Genesis-CSRF': twoBody.csrfToken } })).status, 403);
  const run = await get('/api/jobs', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Genesis-CSRF': oneBody.csrfToken }, body: JSON.stringify({ action: 'doctor', projectId: snapshot.projects[0].id }) });
  assert.equal(run.status, 202);
  const logout = await get('/api/logout', { method: 'POST', headers: { Cookie: cookie, 'X-Genesis-CSRF': oneBody.csrfToken } });
  assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await get('/api/overview', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await get('/api/overview', { headers: { Cookie: secondCookie } })).status, 200);
});

test('remote deployment requires a key and exact HTTPS origin, without trusting forwarded host headers', async t => {
  const token = 'remote-team-key-' + 'y'.repeat(32);
  for (const options of [{ host: '0.0.0.0' }, { publicUrl: 'https://genesis.example.test' }, { host: '0.0.0.0', token }]) assert.throws(() => panelAccess(options));
  for (const url of ['http://remote.example.test', 'https://user:password@example.test', 'https://example.test/path', 'https://example.test?key=value', 'file:///etc/passwd']) assert.throws(() => panelPublicUrl(url));
  const { panel, get, csrfToken } = await fixture(t, { host: '0.0.0.0', publicUrl: 'https://genesis.example.test', token });
  assert.equal(panel.url, 'https://genesis.example.test');
  assert.equal((await get('/api/session', { headers: { Origin: 'https://evil.example.test', 'X-Forwarded-Host': 'genesis.example.test' } })).status, 403);
  const proxyRequest = (path, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(panel.localUrl + path, { method: payload ? 'POST' : 'GET', headers: { Host: 'genesis.example.test', Origin: 'https://genesis.example.test', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Genesis-CSRF': csrfToken } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', data => { text += data; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(payload);
  });
  assert.equal((await proxyRequest('/api/session')).status, 200);
  const loggedIn = await proxyRequest('/api/login', { token });
  assert.equal(loggedIn.status, 200); assert.match(loggedIn.headers['set-cookie'][0], /; Secure/);
  assert.equal((await get('/api/health')).status, 200);
});

test('child processes never inherit panel credentials under Windows environment-name casing', () => {
  const original = { ...process.env, EXOLVRA_GENESIS_PANEL_TOKEN: 'upper-case-private-key', exolvra_genesis_panel_token: 'lower-case-private-key', Exolvra_Genesis_Panel_Token: 'mixed-case-private-key', GENESIS_TEST_MARKER: 'kept' };
  const output = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({keys:Object.keys(process.env).filter(k=>k.toUpperCase()==="EXOLVRA_GENESIS_PANEL_TOKEN"),marker:process.env.GENESIS_TEST_MARKER}))'], { windowsHide: true, encoding: 'utf8', env: panelChildEnvironment(original) });
  assert.deepEqual(JSON.parse(output), { keys: [], marker: 'kept' });
  assert.equal(original.EXOLVRA_GENESIS_PANEL_TOKEN, 'upper-case-private-key');
});
