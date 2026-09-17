import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { appendRun, beginRun, readRuns, readState, runDirectory, writeState } from '../dist/runs-store.js';
import { createLiveMonitor, projectStatus, DEFAULT_STALL_MS } from '../dist/live-status.js';
import { openTrace } from '../dist/trace-store.js';
import { toRecord } from '../dist/trace-events.js';
import { stopCommand } from '../dist/commands/stop.js';
import { createSandbox, PACKAGE_ROOT } from './run-cli.js';
import { PREFLIGHT_FAKE } from './preflight-fake.js';

// Use the same durable fallback on every Node version, avoiding platform file
// locks during fixture cleanup; the store engine itself has its own parity suite.
process.env.EXOLVRA_GENESIS_TRACE_ENGINE = 'ndjson';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(check, timeout = 10_000) {
  const until = Date.now() + timeout;
  while (!check()) { assert.ok(Date.now() < until, 'timed out waiting for the real process'); await delay(20); }
}
const record = (id = 'r-live', status = 'running') => ({ id, status, sessionId: 'session', input: 'test', models: { lead: 'inherit', builder: 'inherit', critic: 'inherit' }, startedAt: new Date().toISOString() });
function fixture(t, started = true) {
  const cwd = mkdtempSync(join(tmpdir(), 'genesis-live-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }));
  if (started) beginRun(cwd, record());
  return cwd;
}
function context(cwd) {
  let stdout = '', stderr = '';
  return { ctx: { cwd, env: {}, program: 'exolvra-genesis', isTTY: false, isErrTTY: false, width: 80,
    stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } } },
  stdout: () => stdout, stderr: () => stderr };
}
function sandbox(t) {
  const box = createSandbox();
  for (const entry of readdirSync(join(PACKAGE_ROOT, 'node_modules'))) {
    if (entry.startsWith('.') || entry === '@anthropic-ai') continue;
    symlinkSync(join(PACKAGE_ROOT, 'node_modules', entry), join(box.root, 'node_modules', entry), 'junction');
  }
  t.after(() => box.cleanup());
  return box;
}
function child(bin, args, cwd, extra = [], env = {}) {
  const process = spawn(globalThis.process.execPath, [...extra, bin, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...globalThis.process.env, EXOLVRA_GENESIS_FORCE_TTY: '', ANTHROPIC_MODEL: '', APPDATA: cwd, HOME: cwd, USERPROFILE: cwd, XDG_CONFIG_HOME: cwd, ...env } });
  let stdout = '', stderr = '';
  process.stdout.on('data', (chunk) => { stdout += chunk; }); process.stderr.on('data', (chunk) => { stderr += chunk; });
  const ended = new Promise((resolve) => process.on('close', (code) => resolve(code)));
  return { process, ended, stdout: () => stdout, stderr: () => stderr };
}

test('status with no trace explicitly falls back to ledger and unknown liveness', (t) => {
  const cwd = fixture(t);
  const row = projectStatus(cwd)[0];
  assert.equal(row.source, 'last written');
  assert.equal(row.live, '?');
  assert.equal(row.max_cost_usd, null);
  assert.deepEqual(row.pieces, []);
  assert.deepEqual(row.processes, []);
});

test('live budget includes earlier spend, warns on cost and rounds, and renders hostile text inertly', (t) => {
  const cwd = fixture(t), root = runDirectory(cwd, 'r-live');
  const path = join(root, 'progress.html');
  writeFileSync(path, '<!-- EXOLVRA-GENESIS-DATA-BEGIN -->\n<script type="application/json">{"rounds":[]}</script>\n<!-- EXOLVRA-GENESIS-DATA-END -->');
  const trace = openTrace(cwd, 'r-live', () => {}); t.after(() => trace.close());
  const budget = { spentUsd: .79, maxCostUsd: 1, rounds: 7, maxRounds: 10 };
  const monitor = createLiveMonitor(cwd, 'r-live', trace, undefined, 60_000, () => budget);
  monitor.activity('</script><img src=x onerror=alert(1)> <!-- EXOLVRA-GENESIS-DATA-END --> \u202e ghp_' + 'a'.repeat(25), 'builder');
  budget.spentUsd = .81; budget.rounds = 8;
  monitor.refresh(); monitor.refresh(); monitor.close();
  const events = trace.read().records;
  assert.deepEqual(events.filter((event) => event.kind === 'budget_warning').map((event) => event.payload.detail).sort(), ['80% of cost cap reached', '80% of round cap reached']);
  const page = readFileSync(path, 'utf8');
  assert.equal(page.split('<!-- EXOLVRA-GENESIS-DATA-END -->').length, 2);
  assert.doesNotMatch(page, /<img|ghp_|\u202e/);
  const data = JSON.parse(page.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.live.cost_usd, .81);
  assert.equal(data.live.max_cost_usd, 1);
  assert.equal(data.live.max_rounds, 10);
  assert.equal(data.live.budget_warning, true);
  const row = projectStatus(cwd)[0];
  assert.equal(row.budget_spent_usd, .81);
  assert.equal(row.max_rounds, 10);
  assert.equal(row.budget_warning, true);
});

test('watchdog accepts a healthy slow builder, flags silence once, and never settles the run', async (t) => {
  const cwd = fixture(t), trace = openTrace(cwd, 'r-live', () => {}); t.after(() => trace.close());
  const monitor = createLiveMonitor(cwd, 'r-live', trace, undefined, { ...DEFAULT_STALL_MS, builder: 80, verification: 10 });
  for (let i = 0; i < 3; i += 1) { monitor.activity('working', 'builder'); await delay(25); monitor.refresh(); }
  assert.equal(trace.read().records.filter((event) => event.kind === 'stalled').length, 0);
  monitor.activity('verifying', 'verification'); await delay(25); monitor.refresh(); monitor.refresh();
  assert.equal(trace.read().records.filter((event) => event.kind === 'stalled').length, 1);
  assert.equal(readState(cwd).status, 'running');
  monitor.close();
});

test('status exposes piece spend and each open subagent last-event age', (t) => {
  const cwd = fixture(t), trace = openTrace(cwd, 'r-live', () => {}); t.after(() => trace.close());
  const now = Date.now();
  trace.openProcess({ runId: 'r-live', taskId: 'builder-1', role: 'builder', piece: 'P1', round: 2, openedAt: now - 3000, pid: null });
  trace.append(toRecord({ kind: 'budget_spend', piece: 'P1', round: 2, payload: { attribution: 'round', inputTokens: 10, outputTokens: 2, costUsd: .5 } }, { runId: 'r-live', at: now - 500 }));
  const row = projectStatus(cwd, 1000, now)[0];
  assert.equal(row.cursor, 1);
  assert.equal(row.pieces[0].cost_usd, .5);
  assert.equal(row.processes[0].age_ms, 3000);
  assert.equal(row.processes[0].last_event_age_ms, 500);
  assert.equal(row.processes[0].stalled, false);
});

test('lead chatter cannot hide a stalled builder and unbilled piece cost stays unavailable', async (t) => {
  const cwd = fixture(t), trace = openTrace(cwd, 'r-live', () => {}); t.after(() => trace.close());
  trace.openProcess({ runId: 'r-live', taskId: 'silent-builder', role: 'builder', piece: 'P1', round: 1, openedAt: Date.now(), pid: null });
  trace.append(toRecord({ kind: 'piece_dispatched', payload: { pieceId: 'P1', title: 'build' } }, { runId: 'r-live' }));
  const monitor = createLiveMonitor(cwd, 'r-live', trace, undefined, { ...DEFAULT_STALL_MS, builder: 10 });
  await delay(25);
  monitor.activity('the lead is still talking', 'lead'); monitor.refresh();
  const flagged = trace.read().records.filter((event) => event.kind === 'stalled');
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].piece, 'P1');
  const row = projectStatus(cwd, { ...DEFAULT_STALL_MS, builder: 10 })[0];
  assert.equal(row.stalled, false);
  assert.equal(row.processes[0].stalled, true);
  assert.equal(row.pieces[0].cost_usd, null);
  monitor.activity('builder resumed', 'builder', 'P1', 1); monitor.refresh();
  const resumed = trace.read().records.findLast((event) => event.kind === 'activity' && event.payload.detail === 'builder resumed');
  assert.ok(resumed);
  // Reading durable files under parallel load can exceed the deliberately tiny
  // threshold. Judge recovery at its recorded event time, not after that I/O.
  assert.equal(projectStatus(cwd, { ...DEFAULT_STALL_MS, builder: 10 }, resumed.at)[0].processes[0].stalled, false);
  monitor.close();
});

test('a fresh builder never inherits the prior round silence on its piece', (t) => {
  const cwd = fixture(t), trace = openTrace(cwd, 'r-live', () => {}); t.after(() => trace.close());
  const now = Date.now();
  trace.append(toRecord({ kind: 'activity', piece: 'P1', round: 1, payload: { detail: 'previous round ended' } }, { runId: 'r-live', at: now - 5000 }));
  trace.openProcess({ runId: 'r-live', taskId: 'fresh-builder', role: 'builder', piece: 'P1', round: 2, openedAt: now - 50, pid: null });
  const process = projectStatus(cwd, 1000, now)[0].processes[0];
  assert.equal(process.last_event_age_ms, 50);
  assert.equal(process.stalled, false);
});

test('bare stop refuses ambiguity and a recycled PID is never targeted', async (t) => {
  const cwd = fixture(t), io = context(cwd);
  appendRun(cwd, record('r-second'));
  await assert.rejects(stopCommand.run([], io.ctx), /more than one run/);
  const root = runDirectory(cwd, 'r-live');
  writeFileSync(join(root, 'control.json'), JSON.stringify({ run: 'r-live', pid: process.pid, startedAt: 0 }));
  await assert.rejects(stopCommand.run(['r-live', '--force'], io.ctx), /belongs to another process/);
  assert.equal(existsSync(join(root, 'stop-request.json')), false);
});

test('a dead issue owner is blocked for claim recovery, including the inner loop run', async (t) => {
  const cwd = fixture(t), root = runDirectory(cwd, 'r-live'), io = context(cwd);
  writeFileSync(join(root, 'control.json'), JSON.stringify({ run: 'r-live', pid: 2147483647 }));
  writeFileSync(join(root, 'issue-owner.json'), JSON.stringify({ issueRun: 'r-outer' }));
  assert.equal(await stopCommand.run(['r-live'], io.ctx), 1);
  assert.equal(readRuns(cwd)[0].status, 'blocked');
  assert.match(io.stdout(), /recover its remote claim/);
});

test('a changed state file alone does not prove graceful settlement when the ledger is running', async (t) => {
  const cwd = fixture(t), io = context(cwd);
  writeState(cwd, 'stopped', 'r-live', process.pid);
  await assert.rejects(stopCommand.run(['r-live', '--grace-seconds', '1'], io.ctx), /did not settle/);
  assert.equal(readRuns(cwd)[0].status, 'running');
});

test('stop interrupts a real CLI owner through its process signal handlers and verifies both stores', async (t) => {
  const box = sandbox(t), cwd = fixture(t, false);
  writeFileSync(join(box.root, 'node_modules/@anthropic-ai/claude-agent-sdk/index.js'), `
    import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
    export function query({prompt,options}) { ${PREFLIGHT_FAKE}
      let release; const held = new Promise(resolve => release = resolve);
      const alive = setInterval(() => {}, 1000);
      process.on('SIGINT', () => writeFileSync(join(options.cwd, 'signal-seen'), 'yes'));
      writeFileSync(join(options.cwd, 'owner-ready'), 'yes');
      return { async interrupt(){ clearInterval(alive); release(); }, async *[Symbol.asyncIterator](){
        yield {type:'assistant',session_id:'real-owner',message:{content:[{type:'text',text:'Building'}]}};
        await held;
        yield {type:'result',subtype:'success',session_id:'real-owner',num_turns:1,total_cost_usd:0,result:'stopped',errors:[]};
      }};
    }`);
  const run = child(box.bin, ['run', 'a verified build', '--auto', '--no-config', '--json'], cwd);
  t.after(() => { if (run.process.exitCode === null) run.process.kill(); });
  await waitUntil(() => existsSync(join(cwd, 'owner-ready')));
  const id = readState(cwd).run, io = context(cwd);
  assert.equal(await stopCommand.run([id, '--grace-seconds', '5'], io.ctx), 0, io.stderr());
  assert.equal(await run.ended, 1, run.stderr());
  assert.equal(readFileSync(join(cwd, 'signal-seen'), 'utf8'), 'yes');
  assert.equal(readState(cwd).status, 'stopped');
  assert.equal(readRuns(cwd)[0].status, 'stopped');
});

test('status --watch emits only on cursor or health changes and handles a real process interrupt', async (t) => {
  const box = sandbox(t), cwd = fixture(t), trace = openTrace(cwd, 'r-live', () => {}); t.after(() => trace.close());
  const sentinel = join(cwd, 'stop-watching'), preload = join(cwd, 'interrupt.mjs');
  writeFileSync(preload, `import {existsSync} from 'node:fs'; const tick=setInterval(()=>{if(existsSync(${JSON.stringify(sentinel)})){clearInterval(tick);process.emit('SIGINT');}},20);tick.unref();`);
  const watcher = child(box.bin, ['status', '--watch', '--json'], cwd, ['--import', pathToFileURL(preload).href]);
  t.after(() => { if (watcher.process.exitCode === null) watcher.process.kill(); });
  await waitUntil(() => watcher.stdout().includes('\n'));
  await delay(1200);
  assert.equal(watcher.stdout().trim().split('\n').length, 1);
  trace.append(toRecord({ kind: 'activity', payload: { detail: 'new activity', phase: 'builder' } }, { runId: 'r-live' }));
  await waitUntil(() => watcher.stdout().trim().split('\n').length === 2);
  writeFileSync(sentinel, 'stop');
  assert.equal(await watcher.ended, 0, watcher.stderr());
  assert.equal(JSON.parse(watcher.stdout().trim().split('\n')[1]).runs[0].phase, 'builder');
});

for (const command of ['run', 'resume']) {
  test(command + ' honors stop during retry backoff without another model call or waiting for the timer', async (t) => {
    const box = sandbox(t), cwd = fixture(t, false);
    if (command === 'resume') appendRun(cwd, record('r-live', 'stopped'));
    writeFileSync(join(box.root, 'node_modules/@anthropic-ai/claude-agent-sdk/index.js'), `
      import {writeFileSync,readFileSync,existsSync} from 'node:fs'; import {join} from 'node:path';
      export function query({prompt,options}) { ${PREFLIGHT_FAKE}
        const path=join(options.cwd,'model-calls');
        writeFileSync(path,String((existsSync(path)?Number(readFileSync(path,'utf8')):0)+1));
        return { async interrupt(){}, async *[Symbol.asyncIterator](){
          yield {type:'assistant',session_id:'backoff-owner',message:{content:[{type:'text',text:'Trying the build'}]}};
          yield {type:'result',subtype:'error_during_execution',session_id:'backoff-owner',num_turns:1,total_cost_usd:.07,errors:['temporary server overload']};
        }};
      }`);
    const args = command === 'run' ? ['run','test retry cancellation','--auto','--no-config','--json'] : ['resume','r-live','--json'];
    const owner = child(box.bin, args, cwd, [], { EXOLVRA_GENESIS_AUTO_RESUMES: '2', EXOLVRA_GENESIS_AUTO_RESUME_DELAY_MS: '30000' });
    t.after(() => { if (owner.process.exitCode === null) owner.process.kill(); });
    await waitUntil(() => owner.stdout().includes('resuming automatically'));
    const io = context(cwd), began = Date.now();
    assert.equal(await stopCommand.run([readState(cwd).run,'--grace-seconds','5'], io.ctx), 0, owner.stdout() + owner.stderr() + io.stderr());
    assert.equal(readState(cwd).status, 'stopped', 'stop must observe the active resumed owner, not its former terminal ledger status');
    assert.equal(await owner.ended, 1, owner.stderr());
    assert.ok(Date.now() - began < 6000, 'retry sleep kept the stopped process alive');
    assert.equal(readFileSync(join(cwd,'model-calls'),'utf8'), '1');
    assert.equal(readState(cwd).status, 'stopped');
    assert.equal(readRuns(cwd)[0].costUsd, .07);
  });
}
