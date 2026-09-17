import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, rmSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readPanelProject, readPanelRuns, readPanelAgents, readPanelRunDetail, readPanelEvents, safePanelArtifactPath, panelProjectPath, scrubPanelText, scrubPanelValue } from '../dist/panel-data.js';
import { appendRun, runDirectory, writeState } from '../dist/runs-store.js';
import { openTrace } from '../dist/trace-store.js';
import { toRecord } from '../dist/trace-events.js';
import { splitFrontmatter } from '../dist/agents.js';
import { PLUGIN_FILES } from '../dist/plugin-dir.js';

process.env.EXOLVRA_GENESIS_TRACE_ENGINE = 'ndjson';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const models = { lead: 'inherit', builder: 'inherit', critic: 'inherit' };
function project(t, id = 'demo') {
  const path = mkdtempSync(join(tmpdir(), 'genesis-panel-data-'));
  t.after(() => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return { id, name: 'Project ' + id, path };
}
function run(project, id = 'r-first', fields = {}) {
  const record = { id, input: 'Build the project', sessionId: 'session-' + id, models, startedAt: '2026-09-17T01:00:00.000Z', status: 'stopped', ...fields };
  appendRun(project.path, record);
  mkdirSync(runDirectory(project.path, id), { recursive: true });
  return record;
}
function traceFile(project, id, records, processes = []) {
  const root = join(runDirectory(project.path, id), 'trace'); mkdirSync(root, { recursive: true });
  const events = records.map((record, index) => ({ type: 'event', data: { seq: index + 1, at: 1000 + index, runId: id, piece: null, round: null, payload: {}, ...record } }));
  writeFileSync(join(root, id + '.ndjson'), [...events, ...processes.map((data) => ({ type: 'process', data }))].map((line) => JSON.stringify(line)).join('\n') + '\n');
  return events.map((line) => line.data);
}
function snapshot(root) {
  const result = {};
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), stat = lstatSync(path), key = relative(root, path);
      result[key] = { mtime: stat.mtimeMs, kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : 'file', bytes: stat.isFile() ? readFileSync(path).toString('base64') : null };
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(path);
    }
  };
  visit(root); return result;
}

test('panel reads an empty project without creating state or pretending there are agents running', (t) => {
  const input = project(t), before = snapshot(input.path);
  const actual = readPanelProject(input);
  assert.equal(actual.runCount, 0); assert.equal(actual.activeCount, 0);
  assert.deepEqual(actual.goals, []);
  assert.deepEqual(readPanelRuns(actual), []);
  assert.deepEqual(readPanelEvents([actual]), []);
  assert.equal(panelProjectPath(actual), input.path);
  assert.deepEqual(snapshot(input.path), before);
});

test('full history totals use provider bills and cumulative resume checkpoints once, beyond every page limit', (t) => {
  const input = project(t); run(input, 'r-history', { status: 'complete', costUsd: 1500, rounds: 3 });
  const events = [{ kind: 'run_started' }];
  for (let i = 0; i < 1200; i += 1) events.push({ kind: 'budget_spend', piece: 'P1', round: 1, payload: { attribution: 'session', costUsd: 1, inputTokens: 2, outputTokens: 1 } });
  events.push({ kind: 'run_finished', payload: { costUsd: 1200 } }, { kind: 'run_started' },
    { kind: 'activity', payload: { phase: 'builder', budget: { spentUsd: 200, maxCostUsd: 400, rounds: 1, maxRounds: 4 }, tokens: { inputTokens: 2500, outputTokens: 1250 } } },
    { kind: 'budget_spend', piece: 'P1', payload: { attribution: 'session', costUsd: 200, inputTokens: 100, outputTokens: 50 } },
    { kind: 'budget_spend', piece: 'P2', round: 2, payload: { attribution: 'round', costUsd: 100, inputTokens: 20, outputTokens: 10 } },
    { kind: 'verdict_recorded', piece: 'P2', round: 2, payload: { verdict: 'WIN' } },
    { kind: 'run_finished', payload: { costUsd: 1500, rounds: 3 } });
  const stored = traceFile(input, 'r-history', events), before = snapshot(input.path);
  const rows = readPanelRuns(readPanelProject(input));
  assert.equal(rows[0].costUsd, 1500);
  assert.deepEqual(rows[0].tokens, { input: 2520, output: 1260 });
  assert.equal(rows[0].source, 'trace'); assert.equal(rows[0].canResume, false);
  const latest = readPanelRunDetail(input, 'r-history', undefined, 3);
  assert.deepEqual(latest.events.map((e) => e.seq), stored.slice(-3).map((e) => e.seq));
  assert.equal(latest.hasMore, false); assert.equal(latest.hasEarlier, true);
  assert.equal(latest.cursor, stored.length); assert.equal(latest.oldestCursor, stored.length - 2);
  assert.equal(latest.pieces.find((p) => p.id === 'P1').costUsd, null);
  assert.equal(latest.pieces.find((p) => p.id === 'P2').costUsd, 100);
  assert.equal(latest.run.maxCostUsd, 400); assert.equal(latest.run.maxRounds, 4);
  const earlier = readPanelRunDetail(input, 'r-history', undefined, 3, latest.oldestCursor);
  assert.deepEqual(earlier.events.map((e) => e.seq), stored.slice(-6, -3).map((e) => e.seq));
  assert.equal(earlier.hasMore, true);
  const first = readPanelRunDetail(input, 'r-history', 0, 3);
  assert.deepEqual(first.events.map((e) => e.seq), [1, 2, 3]); assert.equal(first.hasEarlier, false); assert.equal(first.hasMore, true);
  const next = readPanelRunDetail(input, 'r-history', first.cursor, 3);
  assert.deepEqual(next.events.map((e) => e.seq), [4, 5, 6]);
  assert.equal(readPanelRunDetail(input, 'r-history', 0, 50_000).events.length, 1000);
  assert.deepEqual(snapshot(input.path), before, 'a panel read changed project files');
});

test('legacy cumulative totals remain available without adding them to resumed session bills', (t) => {
  const input = project(t); run(input, 'r-legacy', { costUsd: 12 });
  traceFile(input, 'r-legacy', [{ kind: 'budget_spend', payload: { costUsd: 2, inputTokens: 4, outputTokens: 1 } }, { kind: 'run_finished', payload: { costUsd: 12 } }]);
  assert.equal(readPanelRuns(input)[0].costUsd, 12);
  assert.equal(readPanelRunDetail(input, 'r-legacy').run.costUsd, 12);
});

test('trace changes invalidate cached summaries and event feeds stay globally bounded', (t) => {
  const first = project(t, 'first'), second = project(t, 'second'); run(first); run(second);
  traceFile(first, 'r-first', [{ kind: 'budget_spend', at: 100, payload: { costUsd: 1 } }]);
  traceFile(second, 'r-first', [{ kind: 'activity', at: 300, payload: { detail: 'other project' } }]);
  assert.equal(readPanelRuns(first)[0].costUsd, 1);
  traceFile(first, 'r-first', [{ kind: 'budget_spend', at: 100, payload: { costUsd: 1 } }, { kind: 'budget_spend', at: 500, payload: { costUsd: 2 } }]);
  assert.equal(readPanelRuns(first)[0].costUsd, 3);
  const feed = readPanelEvents([first, second], 2);
  assert.deepEqual(feed.map((e) => [e.projectId, e.seq]), [['first', 2], ['second', 1]]);
});

test('old ledger, goal, event and process strings are scrubbed again before the UI', (t) => {
  const input = project(t), token = 'ghp_' + 'A'.repeat(36), api = 'sk-ant-' + 'z'.repeat(30), password = 'opaque-private-value';
  const prior = process.env.PANEL_TEST_SECRET; process.env.PANEL_TEST_SECRET = password;
  t.after(() => { if (prior === undefined) delete process.env.PANEL_TEST_SECRET; else process.env.PANEL_TEST_SECRET = prior; });
  const decorated = token.slice(0, 8) + '\u202e\u001b[31m' + token.slice(8);
  run(input, 'r-secret', { input: decorated + '\n' + api + ' ' + password, lastVerdict: decorated, models: { lead: api, builder: 'inherit', critic: 'inherit' } });
  mkdirSync(join(input.path, '.exolvra-genesis/goals')); writeFileSync(join(input.path, '.exolvra-genesis/goals/release.md'), '# Release ' + decorated + '\n');
  traceFile(input, 'r-secret', [{ kind: 'activity', piece: decorated, payload: { detail: decorated + api + password, nested: { password: 'another-password', token }, inputTokens: 7 } }],
    [{ runId: 'r-secret', taskId: decorated, role: 'builder', piece: decorated, round: 1, openedAt: 1, closedAt: null, outcome: null, pid: null }]);
  const hydrated = readPanelProject(input), detail = readPanelRunDetail(hydrated, 'r-secret');
  const text = JSON.stringify({ hydrated, detail, feed: readPanelEvents([hydrated]) });
  for (const secret of [token, api, password, 'another-password', '\u202e', '\u001b']) assert.ok(!text.includes(secret), 'leaked ' + secret);
  assert.equal(detail.events[0].payload.inputTokens, 7);
  assert.equal(detail.events[0].payload.nested.password, '[redacted]');
  assert.match(text, /\[redacted\]/);
  const prototype = scrubPanelValue(JSON.parse('{"__proto__":{"password":"bad"}}'));
  assert.equal(Object.getPrototypeOf(prototype), null);
  assert.equal({}.password, undefined);
  assert.doesNotMatch(scrubPanelText('https://user:pass@example.test private API_KEY=abcd'), /user:pass|=abcd/);
});

test('resumability requires a saved session and respects live, dead and unknown owners', (t) => {
  const live = project(t, 'live'); run(live, 'r-live', { status: 'running' }); writeState(live.path, 'running', 'r-live', process.pid);
  const trace = openTrace(live.path, 'r-live', () => {});
  trace.openProcess({ runId: 'r-live', taskId: 'lead', role: 'lead', piece: null, round: null, openedAt: Date.now(), closedAt: null, outcome: null, pid: process.pid });
  trace.append(toRecord({ kind: 'activity', payload: { detail: 'active', phase: 'builder' } }, { runId: 'r-live' })); trace.close();
  const current = readPanelRuns(live)[0]; assert.equal(current.canResume, false); assert.equal(current.canStop, true);
  assert.ok(['live', '?'].includes(current.live)); assert.equal(current.phase, 'builder');
  traceFile(live, 'r-live', [], [{ runId: 'r-live', taskId: 'lead', role: 'lead', piece: null, round: null, openedAt: Date.now(), closedAt: Date.now(), outcome: 'complete', pid: process.pid }]);
  assert.equal(readPanelRuns(live)[0].canResume, false, 'a closed trace cannot authorize resume while the recorded owner is still settling');
  const dead = project(t, 'dead'); run(dead, 'r-dead', { status: 'running' }); writeState(dead.path, 'running', 'r-dead', 2147483647);
  traceFile(dead, 'r-dead', [], [{ runId: 'r-dead', taskId: 'lead', role: 'lead', piece: null, round: null, openedAt: Date.now(), closedAt: null, outcome: null, pid: 2147483647 }]);
  assert.equal(readPanelRuns(dead)[0].live, 'died'); assert.equal(readPanelRuns(dead)[0].canResume, true);
  const legacy = project(t, 'unknown'); run(legacy, 'r-unknown', { status: 'running' });
  const unknown = readPanelRuns(legacy)[0]; assert.equal(unknown.source, 'last written'); assert.equal(unknown.live, '?'); assert.equal(unknown.canResume, false); assert.equal(unknown.canStop, false);
  assert.equal(unknown.costUsd, null); assert.equal(unknown.tokens, null);
  const blocked = project(t, 'blocked'); run(blocked, 'r-no-session', { status: 'blocked', sessionId: null });
  assert.equal(readPanelRuns(blocked)[0].canResume, false);
  run(blocked, 'r-session', { status: 'blocked' }); assert.equal(readPanelRuns(blocked).find((r) => r.id === 'r-session').canResume, true);
});

test('artifact links are a strict allowlist of existing regular files inside the owning project', (t) => {
  const input = project(t), outside = project(t, 'outside'); run(input);
  const root = runDirectory(input.path, 'r-first');
  writeFileSync(join(root, 'progress.html'), '<html>progress</html>');
  mkdirSync(join(root, 'bar')); writeFileSync(join(root, 'bar/BAR.md'), '# Bar'); writeFileSync(join(root, 'bar/bar.sha256'), 'hash');
  assert.deepEqual(readPanelRunDetail(input, 'r-first').artifacts.map((a) => a.name), ['progress.html', 'BAR.md', 'bar.sha256']);
  assert.equal(safePanelArtifactPath(input, 'r-first', '../runs.json'), undefined);
  assert.equal(safePanelArtifactPath(input, 'r-first', 'constructor'), undefined);
  assert.equal(safePanelArtifactPath(input, '../r-first', 'progress.html'), undefined);
  rmSync(join(root, 'bar'), { recursive: true }); writeFileSync(join(outside.path, 'BAR.md'), 'outside secret');
  symlinkSync(outside.path, join(root, 'bar'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(safePanelArtifactPath(input, 'r-first', 'BAR.md'), undefined);
  assert.deepEqual(readPanelRunDetail(input, 'r-first').artifacts.map((a) => a.name), ['progress.html']);
});

test('run evidence spans the whole trace and its source links survive event pagination and cached status changes', (t) => {
  const input = project(t); run(input, 'r-evidence', { status: 'blocked' });
  const events = [
    { kind: 'run_started' },
    { kind: 'gate_check', piece: 'P1', round: 1, payload: { gate: 'ownership', passed: true, detail: JSON.stringify({ kind: 'ownership', touched: ['src/a.ts'], violations: [] }) } },
    { kind: 'builder_round_ended', piece: 'P1', round: 1, payload: { attempt: 1, verbatimVerification: true, verificationOutput: '4 checks passed' } },
    { kind: 'verdict_recorded', piece: 'P1', round: 1, payload: { verdict: 'LOSS', gap: 'R2: keyboard focus is missing' } },
    ...Array.from({ length: 1100 }, (_, i) => ({ kind: 'activity', payload: { phase: 'lead', detail: 'Observation ' + i } })),
    { kind: 'run_finished', payload: { status: 'blocked', rounds: 1, costUsd: 0.1 } },
  ];
  traceFile(input, 'r-evidence', events);
  const before = snapshot(input.path);
  const detail = readPanelRunDetail(input, 'r-evidence', undefined, 2);
  assert.equal(detail.events.length, 2);
  const round = detail.evidence.rounds.find(row => row.piece === 'P1' && row.round === 1);
  assert.ok(round);
  assert.equal(round.files.find(file => file.path === 'src/a.ts').kind, 'observed');
  assert.equal(round.verification.find(check => check.authority === 'builder').status, 'reported');
  const finding = round.findings.find(row => row.verdict === 'LOSS');
  assert.equal(finding.gap, 'R2: keyboard focus is missing');
  const source = readPanelRunDetail(input, 'r-evidence', finding.source.seq - 1, 1);
  assert.equal(source.events[0].seq, finding.source.seq);
  assert.equal(source.events[0].payload.gap, finding.gap);
  assert.deepEqual(source.evidence.rounds, detail.evidence.rounds);
  const older = readPanelRunDetail(input, 'r-evidence', undefined, 2, detail.oldestCursor);
  assert.deepEqual(older.evidence.rounds, detail.evidence.rounds);
  assert.deepEqual(snapshot(input.path), before);
  writeState(input.path, 'complete', 'r-evidence');
  const settled = readPanelRunDetail(input, 'r-evidence', undefined, 2);
  assert.equal(settled.run.status, 'complete');
  assert.equal(settled.evidence.summary.blockingReason, null);
  assert.equal(settled.evidence.summary.nextAction.action, 'review');
  assert.deepEqual(settled.evidence.rounds, detail.evidence.rounds);
});

test('symlinked trace and metadata never escape the project, and one unreadable project does not hide other events', (t) => {
  const unsafe = project(t, 'unsafe'), outside = project(t, 'outside'), good = project(t, 'good');
  run(unsafe); run(good);
  writeFileSync(join(outside.path, 'r-first.ndjson'), JSON.stringify({ type: 'event', data: { runId: 'r-first', seq: 1, at: 1, kind: 'activity', payload: { detail: 'outside-content' } } }));
  symlinkSync(outside.path, join(runDirectory(unsafe.path, 'r-first'), 'trace'), process.platform === 'win32' ? 'junction' : 'dir');
  const detail = readPanelRunDetail(unsafe, 'r-first'); assert.equal(detail.degraded, true); assert.deepEqual(detail.events, []);
  assert.equal(detail.run.source, 'last written');
  traceFile(good, 'r-first', [{ kind: 'activity', payload: { detail: 'safe' } }]);
  writeFileSync(join(unsafe.path, '.exolvra-genesis/runs.json'), 'broken');
  assert.throws(() => readPanelRuns(unsafe), /could not read|not readable|not valid/);
  assert.equal(readPanelEvents([unsafe, good])[0].projectId, 'good');
  const linked = project(t, 'linked'); symlinkSync(join(good.path, '.exolvra-genesis'), join(linked.path, '.exolvra-genesis'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readPanelRuns(linked), /symbolic link/);
  assert.throws(() => readPanelRunDetail(linked, 'r-first'), /symbolic link/);
});

test('agent definitions come from selected plugin markdown, including only the auditor that exists there', (t) => {
  const agents = readPanelAgents({ EXOLVRA_GENESIS_PLUGIN_DIR: repo });
  assert.deepEqual(agents.map((agent) => agent.role), ['lead', 'builder', 'critic', 'auditor']);
  for (const agent of agents) {
    const source = splitFrontmatter(readFileSync(join(repo, agent.source), 'utf8'));
    assert.equal(agent.prompt, scrubPanelText(source.body, {}, 100_000));
    assert.equal(agent.description, source.fields.description);
    assert.ok(!agent.source.includes(repo));
  }
  assert.equal(agents[0].source, 'commands/run.md'); assert.equal(agents[3].source, 'agents/usability-auditor.md');
  const installed = project(t, 'installed');
  for (const path of Object.values(PLUGIN_FILES)) {
    const target = join(installed.path, path); mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, readFileSync(join(repo, path)));
  }
  assert.deepEqual(readPanelAgents({ EXOLVRA_GENESIS_PLUGIN_DIR: installed.path }).map((a) => a.role), ['lead', 'builder', 'critic']);
});

test('replacing a registered project root with a junction cannot redirect panel reads', (t) => {
  const holder = project(t, 'holder');
  const input = { id: 'registered', name: 'Registered', path: join(holder.path, 'project') };
  const outside = { id: 'outside', name: 'Outside', path: join(holder.path, 'outside') };
  mkdirSync(input.path); mkdirSync(outside.path);
  const hydrated = readPanelProject(input);
  run(outside); writeFileSync(join(runDirectory(outside.path, 'r-first'), 'progress.html'), 'must not be read');
  renameSync(input.path, join(holder.path, 'original'));
  symlinkSync(outside.path, input.path, process.platform === 'win32' ? 'junction' : 'dir');
  const before = snapshot(outside.path);
  assert.throws(() => readPanelProject(input), /symbolic link/);
  assert.throws(() => readPanelRuns(hydrated), /symbolic link/);
  assert.throws(() => readPanelRunDetail(hydrated, 'r-first'), /symbolic link/);
  assert.deepEqual(readPanelEvents([hydrated]), []);
  assert.equal(safePanelArtifactPath(hydrated, 'r-first', 'progress.html'), undefined);
  assert.deepEqual(snapshot(outside.path), before);
});
