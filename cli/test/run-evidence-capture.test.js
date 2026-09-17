import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTrace } from '../dist/trace-store.js';
import { observeSubagentBlocks, createSubagentTracker } from '../dist/commands/run.js';
import { createRoundGuards } from '../dist/round-guards.js';
import { createSession } from '../dist/session.js';
import { DEFAULT_MODEL_CHOICE } from '../dist/models.js';
import { loadPluginSources } from '../dist/plugin-dir.js';

const runId = 'r-capture';
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'genesis-evidence-capture-'));
  const root = join(cwd, '.exolvra-genesis', 'runs', runId);
  mkdirSync(root, { recursive: true });
  const trace = openTrace(cwd, runId, () => {});
  t.after(() => { trace.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, root, trace, records: () => trace.read(0, 1000).records };
}
const dispatch = (id, role, metadata) => ({ type: 'tool_use', id, name: 'Agent', input: {
  subagent_type: 'exolvra-genesis-' + role,
  prompt: '```genesis-' + (role === 'builder' ? 'task' : 'critic') + '\n' + JSON.stringify(metadata) + '\n```',
} });

test('builder claims and raw critic evidence retain provenance without inventing judged rounds', (t) => {
  const f = fixture(t), tracker = createSubagentTracker();
  const secret = 'ghp_S3cretT0kenInTheTitle000000000000000';
  observeSubagentBlocks([dispatch('builder-1', 'builder', { piece: 'P1', files: ['a.txt'], verify: 'npm test' })], tracker, f.trace, runId);
  observeSubagentBlocks([{ type: 'tool_result', tool_use_id: 'builder-1', content:
    'FILES CHANGED\n- `a.txt` — changed\n- old.txt (deleted)\nCOMMANDS RUN\n- `npm test`\nVERIFICATION\nPASS, token=' + secret }], tracker, f.trace, runId);
  observeSubagentBlocks([dispatch('critic-1', 'critic', { piece: 'P1', round: 2 })], tracker, f.trace, runId);
  observeSubagentBlocks([{ type: 'tool_result', tool_use_id: 'critic-1', content: [
    { type: 'text', text: 'VERDICT: LOSS\nGAP: G2 keyboard focus missing\nEVIDENCE: focus stayed on body; token=' + secret },
  ] }], tracker, f.trace, runId);
  const records = f.records(), builder = records.find((row) => row.kind === 'builder_round_ended');
  assert.equal(builder.round, null, 'a dispatch attempt is not a known per-piece round');
  assert.equal(builder.payload.source, 'builder-report');
  assert.deepEqual(builder.payload.reportedFiles, ['a.txt', 'old.txt']);
  assert.deepEqual(builder.payload.verificationCommands, ['npm test']);
  assert.match(builder.payload.verificationOutput, /PASS/);
  assert.equal(builder.payload.exitCode, undefined);
  const critic = records.find((row) => row.payload.evidence?.type === 'critic_report');
  assert.equal(critic.round, 2);
  assert.equal(critic.payload.evidence.source, 'critic-report');
  assert.equal(critic.payload.evidence.verdict, 'LOSS');
  assert.match(critic.payload.evidence.gap, /keyboard focus/);
  assert.match(critic.payload.evidence.evidence, /focus stayed/);
  assert.equal(records.filter((row) => row.kind === 'verdict_recorded').length, 0, 'only existing lead markers count judged rounds');
  assert.ok(!JSON.stringify(records).includes(secret));
});

test('ownership observations distinguish actual touched files from restored violations', async (t) => {
  const f = fixture(t), git = (...args) => execFileSync('git', args, { cwd: f.cwd, stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  writeFileSync(join(f.cwd, 'owned'), 'before'); writeFileSync(join(f.cwd, 'other'), 'operator');
  git('add', 'owned', 'other'); git('commit', '-m', 'initial');
  const task = { piece: 'P1', files: ['owned'], verify: 'npm test' };
  writeFileSync(join(f.root, 'ownership-plan.json'), JSON.stringify([task]));
  const hooks = createRoundGuards(f.cwd, runId, 'sonnet', f.trace);
  const input = dispatch('b1', 'builder', task).input;
  await hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'b1', tool_input: input }, 'b1', { signal: new AbortController().signal });
  writeFileSync(join(f.cwd, 'owned'), 'built'); writeFileSync(join(f.cwd, 'other'), 'breach');
  const result = await hooks.PostToolUse[0].hooks[0]({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'b1', tool_input: input, tool_response: 'FILES CHANGED\n- claimed-only' }, 'b1', { signal: new AbortController().signal });
  assert.equal(result.continue, false);
  const observed = f.records().find((row) => row.payload.evidence?.type === 'file_changes');
  assert.equal(observed.piece, 'P1'); assert.equal(observed.round, 1);
  assert.equal(observed.payload.evidence.source, 'ownership-snapshot');
  assert.deepEqual(observed.payload.evidence.files, ['other', 'owned']);
  assert.deepEqual(observed.payload.evidence.restored, ['other']);
  assert.deepEqual(observed.payload.evidence.violations, ['other']);
  assert.equal(readFileSync(join(f.cwd, 'other'), 'utf8'), 'operator');
});

test('bounded report excerpts redact before cutting and preserve failed critic provenance', (t) => {
  const f = fixture(t), tracker = createSubagentTracker();
  const secret = 'ghp_S3cretT0kenInTheTitle000000000000000';
  observeSubagentBlocks([dispatch('critic-failed', 'critic', { piece: 'P1', round: 1 })], tracker, f.trace, runId);
  observeSubagentBlocks([{ type: 'tool_result', tool_use_id: 'critic-failed', is_error: true,
    content: 'VERDICT: WIN\nGAP: none\nEVIDENCE: ' + 'x'.repeat(15980) + secret + ' ' + 'x'.repeat(100) }], tracker, f.trace, runId);
  const evidence = f.records().find((row) => row.payload.evidence?.type === 'critic_report').payload.evidence;
  assert.equal(evidence.isError, true, 'a failed tool result cannot become a valid WIN');
  assert.equal(evidence.truncated, true);
  assert.equal(evidence.evidence.length, 16000);
  assert.ok(!evidence.evidence.includes('ghp_'));
  assert.ok(evidence.evidence.includes('[redacted]'));
});

test('SDK command receipts match tool and parent identity, preserve role, and never infer success from output', async (t) => {
  const f = fixture(t), tracker = createSubagentTracker();
  const assistant = (content, parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content } });
  const user = (content, parent = null) => ({ type: 'user', parent_tool_use_id: parent, message: { content } });
  const command = (id, text) => ({ type: 'tool_use', name: 'Bash', id, input: { command: text } });
  const receipt = (id, text, isError) => ({ type: 'tool_result', tool_use_id: id, content: text, ...(isError === undefined ? {} : { is_error: isError }) });
  const secret = 'ghp_S3cretT0kenInTheTitle000000000000000';
  const messages = [
    assistant([command('lead-command', 'git status')]),
    user([receipt('unobserved', 'PASS', false)]),
    assistant([receipt('lead-command', 'model-authored result', false)]),
    user([receipt('lead-command', 'PASS, exit code 0', false)]),
    user([receipt('lead-command', 'duplicate', false)]),
    assistant([dispatch('builder-1', 'builder', { piece: 'P1', round: 3 })]),
    assistant([command('nested-command', 'npm test')], 'builder-1'),
    user([receipt('nested-command', 'wrong parent', false)]),
    user([receipt('nested-command', 'failed\n' + secret, true)], 'builder-1'),
    assistant([command('unknown-owner', 'pwd')], 'untracked-task'),
    user([receipt('unknown-owner', 'done')], 'untracked-task'),
    assistant([command('large-output', 'echo report')]),
    user([receipt('large-output', 'x'.repeat(15980) + secret + ' tail'.repeat(20))]),
    assistant([command('large-command', 'x'.repeat(3980) + secret + ' ' + 'x'.repeat(100))]),
    user([receipt('large-command', 'done')]),
    { type: 'result', subtype: 'success', session_id: 'session-evidence', num_turns: 2, total_cost_usd: 0, result: 'finished', errors: [] },
  ];
  const session = createSession({ cwd: f.cwd, runId, trace: f.trace, prompt: 'test', sources: loadPluginSources({}), models: DEFAULT_MODEL_CHOICE,
    hooks: { onMessage(message) { if (Array.isArray(message.message?.content)) observeSubagentBlocks(message.message.content, tracker, f.trace, runId); } },
    transport() { return { async interrupt() {}, async *[Symbol.asyncIterator]() { yield* messages; } }; },
  });
  await session.start();
  const observations = f.records().filter((row) => row.payload.evidence?.type === 'verification');
  assert.equal(observations.length, 5);
  const lead = observations[0].payload.evidence;
  assert.equal(lead.source, 'sdk-tool-result'); assert.equal(lead.purpose, 'command'); assert.equal(lead.role, 'lead');
  assert.equal(lead.command, 'git status'); assert.equal(lead.isError, false); assert.equal(lead.exitCode, undefined);
  assert.equal(observations[1].piece, 'P1'); assert.equal(observations[1].round, 3);
  assert.equal(observations[1].payload.evidence.role, 'builder'); assert.equal(observations[1].payload.evidence.isError, true);
  assert.equal(observations[2].payload.evidence.role, 'unknown'); assert.equal(observations[2].payload.evidence.isError, undefined);
  assert.equal(observations[3].payload.evidence.truncated, true);
  assert.equal(observations[3].payload.evidence.output.length, 16000);
  assert.equal(observations[4].payload.evidence.command.length, 4000);
  assert.equal(observations[4].payload.evidence.truncated, true);
  assert.ok(observations[4].payload.evidence.command.includes('[redacted]'));
  assert.ok(!JSON.stringify(observations).includes(secret));
  assert.ok(!JSON.stringify(observations).includes('model-authored result'));
  assert.ok(!JSON.stringify(observations).includes('wrong parent'));
});
