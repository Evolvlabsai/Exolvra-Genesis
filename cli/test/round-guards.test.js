import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoundGuards, settleRoundGuards } from '../dist/round-guards.js';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'genesis-round-guards-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test'); git('config', 'core.autocrlf', 'false');
  writeFileSync(join(cwd, 'owned'), 'initial\n'); writeFileSync(join(cwd, 'other'), 'safe\n');
  git('add', '.'); git('commit', '-m', 'initial');
  const root = join(cwd, '.exolvra-genesis', 'runs', 'r-test'); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'ownership-plan.json'), JSON.stringify([{ piece: 'P1', files: ['owned'], verify: 'npm test' }]));
  let hooks = createRoundGuards(cwd, 'r-test', 'model-a');
  const invoke = (phase, id, input, response) => hooks[phase][0].hooks[0]({ hook_event_name: phase, tool_name: 'Task', tool_use_id: id, tool_input: input, ...(phase === 'PostToolUseFailure' ? { error: response } : { tool_response: response }) }, id, { signal: new AbortController().signal });
  return { cwd, root, invoke, reset() { hooks = createRoundGuards(cwd, 'r-test', 'model-a'); }, settle() { settleRoundGuards(hooks); } };
}
const builder = (piece = 'P1', model = 'model-a') => ({ subagent_type: 'exolvra-genesis-builder', model, prompt: '```genesis-task\n' + JSON.stringify({ piece, files: ['owned'], verify: 'npm test' }) + '\n```' });
const critic = (round) => ({ subagent_type: 'exolvra-genesis-critic', prompt: '```genesis-critic\n' + JSON.stringify({ piece: 'P1', round }) + '\n```' });
const report = 'FILES CHANGED\n- owned\nCOMMANDS RUN\n- npm test\nVERIFICATION\npassed\nexit code 0';

test('SDK hooks enforce rollback, poison the session, and preserve the owned edit', async (t) => {
  const f = fixture(t), task = builder();
  await f.invoke('PreToolUse', 'b1', task);
  writeFileSync(join(f.cwd, 'owned'), 'legitimate\n'); writeFileSync(join(f.cwd, 'other'), 'breach\n');
  const result = await f.invoke('PostToolUse', 'b1', task, { agentId: 'a1', content: report });
  assert.equal(result.continue, false); assert.match(result.stopReason, /Ownership breach/);
  assert.equal(readFileSync(join(f.cwd, 'other'), 'utf8'), 'safe\n');
  assert.equal(readFileSync(join(f.cwd, 'owned'), 'utf8'), 'legitimate\n');
  assert.equal(JSON.parse(readFileSync(join(f.root, 'builders.json'))).P1.poisoned, true);
});

test('a report-only correction keeps its original touched set and costs no new round', async (t) => {
  const f = fixture(t), task = builder();
  await f.invoke('PreToolUse', 'b1', task); writeFileSync(join(f.cwd, 'owned'), 'changed\n');
  const rejected = await f.invoke('PostToolUse', 'b1', task, { agentId: 'a1', content: report.replace('npm test', 'npm wrong') });
  assert.equal(rejected.decision, 'block');
  const premature = await f.invoke('PreToolUse', 'premature', critic(1));
  assert.equal(premature.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(premature.hookSpecificOutput.permissionDecisionReason, /Correct the builder report/);
  const resumed = await f.invoke('PreToolUse', 'b2', task);
  assert.equal(resumed.hookSpecificOutput.updatedInput.resume, 'a1');
  assert.deepEqual(await f.invoke('PostToolUse', 'b2', task, { agentId: 'a1', content: report }), {});
  assert.equal(JSON.parse(readFileSync(join(f.root, 'builders.json'))).P1.rounds, 1);
  f.reset();
  assert.equal((await f.invoke('PreToolUse', 'b3', task)).hookSpecificOutput.updatedInput.resume, 'a1');
  await f.invoke('PostToolUseFailure', 'b3', task, 'session expired');
  assert.equal((await f.invoke('PreToolUse', 'b4', task)).hookSpecificOutput.updatedInput.resume, undefined);
  f.settle();
});

test('unchanged duplicate findings suppress builder dispatch after process restart', async (t) => {
  const f = fixture(t);
  for (const n of [1, 2]) {
    const task = critic(n); await f.invoke('PreToolUse', 'c' + n, task);
    const result = await f.invoke('PostToolUse', 'c' + n, task, 'VERDICT: LOSS\nGAP: G1 missing behavior');
    if (n === 2) assert.match(result.hookSpecificOutput.additionalContext, /duplicate-round/);
  }
  f.reset();
  const denied = await f.invoke('PreToolUse', 'b1', builder());
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /Duplicate findings/);
});

test('two successive see-saw rounds cold-start the poisoned builder, while critics remain fresh', async (t) => {
  const f = fixture(t);
  for (let n = 1; n <= 4; n++) {
    const task = builder(); await f.invoke('PreToolUse', 'b' + n, task);
    writeFileSync(join(f.cwd, 'owned'), 'candidate ' + n + '\n');
    await f.invoke('PostToolUse', 'b' + n, task, { agentId: 'same-session', content: report });
    const judge = critic(n); await f.invoke('PreToolUse', 'c' + n, judge);
    await f.invoke('PostToolUse', 'c' + n, judge, 'VERDICT: LOSS\nGAP: ' + (n % 2 ? 'G1 defect A' : 'G2 defect B'));
  }
  const start = await f.invoke('PreToolUse', 'b5', builder());
  assert.equal(start.hookSpecificOutput.updatedInput.resume, undefined);
  assert.match(readFileSync(join(f.root, 'round-log.ndjson'), 'utf8'), /poisoned-context/);
  const rejected = await f.invoke('PreToolUse', 'c5', { ...critic(5), resume: 'critic-session' });
  assert.equal(rejected.hookSpecificOutput.permissionDecision, 'deny');
  f.settle();
});

test('persisted ownership refuses conflicting pieces and finalizer catches an interrupted breach', async (t) => {
  const f = fixture(t), task = builder();
  await f.invoke('PreToolUse', 'b1', task); await f.invoke('PostToolUseFailure', 'b1', task, 'transport lost');
  f.reset();
  assert.match((await f.invoke('PreToolUse', 'b2', builder('P2'))).hookSpecificOutput.permissionDecisionReason, /differs from the decomposition plan/);
  await f.invoke('PreToolUse', 'b3', task); writeFileSync(join(f.cwd, 'other'), 'breach');
  assert.throws(() => f.settle(), /ownership breach/);
  assert.equal(readFileSync(join(f.cwd, 'other'), 'utf8'), 'safe\n');
});

test('overlap anywhere in the plan refuses even the first builder dispatch', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'ownership-plan.json'), JSON.stringify([
    { piece: 'P1', files: ['owned'], verify: 'npm test' },
    { piece: 'P2', files: ['*'], verify: 'npm test' },
  ]));
  const result = await f.invoke('PreToolUse', 'first', builder());
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /overlapping ownership/);
});

test('builder cannot rewrite the trusted ownership plan or persistent session map', async (t) => {
  const f = fixture(t), task = builder();
  await f.invoke('PreToolUse', 'b1', task);
  writeFileSync(join(f.root, 'ownership-plan.json'), '[{"piece":"P1","files":["**"]}]');
  writeFileSync(join(f.root, 'builders.json'), '{}');
  writeFileSync(join(f.root, 'findings.json'), '{"P1":[]}');
  const result = await f.invoke('PostToolUse', 'b1', task, report);
  assert.equal(result.continue, false); assert.match(result.stopReason, /trusted run contract changed/);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'ownership-plan.json')))[0].files, ['owned']);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'builders.json'))).P1.poisoned, true);
  assert.equal(existsSync(join(f.root, 'findings.json')), false, 'a forged new contract must also be removed');
});

test('a contradictory verdict must be corrected before a builder can change its candidate', async (t) => {
  const f = fixture(t), judge = critic(1);
  await f.invoke('PreToolUse', 'c1', judge);
  const rejected = await f.invoke('PostToolUse', 'c1', judge, 'VERDICT: WIN\nGAP: G1 hard gate failed');
  assert.equal(rejected.decision, 'block');
  assert.equal((await f.invoke('PreToolUse', 'b1', builder())).hookSpecificOutput.permissionDecision, 'deny');
  await f.invoke('PreToolUse', 'c2', judge);
  await f.invoke('PostToolUse', 'c2', judge, 'VERDICT: LOSS\nGAP: G1 hard gate failed');
  assert.ok((await f.invoke('PreToolUse', 'b2', builder())).hookSpecificOutput.updatedInput);
  f.settle();
});
