import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelEvidence } from '../dist/panel-evidence.js';
import { scrubPanelText } from '../dist/panel-data.js';

const run = (fields = {}) => ({ id: 'run-evidence', projectId: 'project', projectName: 'Evidence', input: 'Build the feature',
  status: 'running', phase: 'builder', live: 'live', stalled: false, startedAt: '2026-09-17T00:00:00Z', finishedAt: null,
  updatedAt: 1, costUsd: null, rounds: 0, lastVerdict: null, models: { lead: 'default', builder: 'inherit', critic: 'inherit' },
  tokens: null, source: 'trace', canResume: false, canStop: true, maxCostUsd: null, maxRounds: null, ...fields });
function fixture(env = {}) {
  const collector = createPanelEvidence('run-evidence', (value, maxLength) => scrubPanelText(value, env, maxLength));
  let seq = 0;
  return { collector, add(kind, payload = {}, fields = {}) {
    const event = { seq: ++seq, at: seq * 100, runId: 'run-evidence', piece: 'app', round: 1, kind, payload, ...fields };
    collector.record(event); return event;
  }, finish(fields = {}, options) { return collector.finish(run(fields), options); } };
}
const files = (paths, restored = []) => ({ evidence: { type: 'file_changes', source: 'ownership-snapshot', files: paths, restored } });
const tool = (fields = {}) => ({ evidence: { type: 'verification', source: 'sdk-tool-result', role: 'lead', tool: 'Bash',
  purpose: 'command', command: 'npm test', output: 'Tests finished', ...fields } });
const critic = (fields = {}) => ({ evidence: { type: 'critic_report', source: 'critic-report', verdict: 'LOSS',
  gap: 'C1: opening the menu fails', evidence: 'Clicked Menu; no menu appeared.', ...fields } });

test('round evidence keeps observed changes, reports, commands and critic evidence distinct with exact trace sources', () => {
  const f = fixture();
  f.add('builder_round_started');
  const changed = f.add('activity', files(['src/menu.ts', 'src/outside.ts'], ['src/outside.ts']));
  const reported = f.add('builder_round_ended', { reportedFiles: ['src/menu.ts'], verificationCommands: ['npm test'], verificationOutput: '42 tests passed' });
  const command = f.add('activity', tool({ isError: false }));
  const judged = f.add('activity', critic());
  const detail = f.finish(), round = detail.rounds[0];
  assert.deepEqual(round.files.map(({ path, kind, restored }) => ({ path, kind, restored })), [
    { path: 'src/menu.ts', kind: 'observed', restored: false }, { path: 'src/outside.ts', kind: 'observed', restored: true },
    { path: 'src/menu.ts', kind: 'reported', restored: null },
  ]);
  assert.equal(round.files[0].source.seq, changed.seq);
  assert.deepEqual(round.verification.map(({ authority, status, source }) => [authority, status, source.seq]), [
    ['builder', 'reported', reported.seq], ['lead', 'recorded', command.seq],
  ]);
  assert.equal(round.findings[0].source.seq, judged.seq);
  assert.equal(round.findings[0].evidence, 'Clicked Menu; no menu appeared.');
  assert.equal(detail.summary.blockingReason.source.seq, judged.seq);
});

test('only explicit verification command exit zero passes; generic commands and builder prose never prove verification', () => {
  const f = fixture();
  f.add('builder_round_ended', { verbatimVerification: true, verificationOutput: 'Everything passed, exit 0' });
  f.add('activity', tool({ isError: false, exitCode: 0 }));
  f.add('activity', tool({ purpose: 'verification', exitCode: 0 }));
  f.add('activity', tool({ purpose: 'verification', exitCode: 0, isError: true }));
  f.add('gate_check', { gate: 'report.outcome', passed: true, detail: 'No contradictory failure output' });
  const checks = f.finish().rounds[0].verification;
  assert.deepEqual(checks.map((check) => check.status), ['reported', 'recorded', 'passed', 'failed', 'passed']);
  assert.equal(checks.at(-1).authority, 'guard');
  assert.equal(checks[2].name, 'Bash verification');
});

test('older ownership gate JSON supplies actual touched paths and restoration without reading the worktree', () => {
  const f = fixture();
  const source = f.add('gate_check', { gate: 'ownership', passed: false, detail: JSON.stringify({ kind: 'ownership', touched: ['missing/file.ts'], restored: ['missing/file.ts'], violations: ['outside ownership'] }) });
  const round = f.finish().rounds[0];
  assert.deepEqual(round.files, [{ path: 'missing/file.ts', kind: 'observed', restored: true, source: { seq: source.seq, at: source.at, kind: 'gate_check' } }]);
  assert.ok(round.missing.some((message) => message.includes('No lead command')));
});

test('same-piece adjacent rounds compare evidence lists and link both recorded candidate fingerprints', () => {
  const f = fixture();
  f.add('activity', files(['src/old.ts', 'src/shared.ts', 'src/restored.ts'], ['src/restored.ts']));
  f.add('activity', critic());
  const priorPin = f.add('activity', { detail: JSON.stringify({ kind: 'finding-fingerprints', diff: 'a'.repeat(64) }) });
  f.add('activity', files(['other.ts']), { piece: 'other', round: 1 });
  f.add('activity', files(['src/new.ts', 'src/shared.ts']), { round: 2 });
  f.add('activity', critic(), { round: 2 });
  const nextPin = f.add('activity', { detail: JSON.stringify({ kind: 'finding-fingerprints', diff: 'b'.repeat(64) }) }, { round: 2 });
  const comparison = f.finish().rounds.find((entry) => entry.piece === 'app' && entry.round === 2).comparison;
  assert.equal(comparison.previousRound, 1);
  assert.deepEqual(comparison.addedFiles, ['src/new.ts']);
  assert.deepEqual(comparison.removedFiles, ['src/old.ts']);
  assert.deepEqual(comparison.repeatedFindings, ['C1: opening the menu fails']);
  assert.equal(comparison.candidateChanged, true);
  assert.deepEqual([comparison.candidateSources.previous.seq, comparison.candidateSources.current.seq], [priorPin.seq, nextPin.seq]);
});

test('disappearing findings are labelled no longer reported, and missing or different-authority lists are not compared', () => {
  const f = fixture();
  f.add('builder_round_ended', { reportedFiles: ['claimed.ts'] });
  f.add('activity', critic());
  f.add('activity', files(['observed.ts']), { round: 2 });
  f.add('verdict_recorded', { verdict: 'WIN', gap: 'none' }, { round: 2 });
  const comparison = f.finish().rounds[1].comparison;
  assert.equal(comparison.filesComparable, false);
  assert.deepEqual(comparison.addedFiles, []);
  assert.equal(comparison.findingsComparable, true);
  assert.deepEqual(comparison.noLongerReported, ['C1: opening the menu fails']);
  assert.equal(comparison.candidateChanged, null);
});

test('round comparison uses numeric adjacency even when groups first appear out of order; unknown rounds are never guessed', () => {
  const f = fixture();
  f.add('activity', files(['two.ts']), { round: 2 });
  f.add('activity', files(['one.ts']), { round: 1 });
  f.add('builder_round_ended', { attempt: 9, reportedFiles: ['unknown.ts'], verificationOutput: 'ok' }, { round: null });
  f.add('activity', files(['four.ts']), { round: 4 });
  const rounds = f.finish().rounds;
  assert.equal(rounds[0].comparison.previousRound, 1);
  assert.equal(rounds[2].round, null);
  assert.equal(rounds[2].comparison, null);
  assert.equal(rounds[3].comparison, null);
  assert.ok(rounds[2].missing.some((message) => message.includes('did not identify a round')));
});

test('recovered errors and prior round losses do not become current blockers during later progress', () => {
  const f = fixture();
  f.add('error_path', { fault: 'temporary', detail: 'retrying tool' });
  f.add('gate_check', { gate: 'report.output', passed: false, detail: 'output missing' });
  f.add('verdict_recorded', { verdict: 'LOSS', gap: 'C1: fix menu' });
  f.add('builder_round_started', {}, { round: 2 });
  assert.equal(f.finish().summary.blockingReason, null);
  f.add('gate_check', { gate: 'report.output', passed: true, detail: 'output present' }, { round: 2 });
  f.add('run_finished', { status: 'stopped' }, { piece: null, round: null });
  const detail = f.finish({ status: 'stopped', live: '-', canResume: true, canStop: false });
  assert.equal(detail.summary.blockingReason.source, null);
  assert.match(detail.summary.blockingReason.text, /No stop reason/);
  assert.equal(detail.summary.nextAction.action, 'resume');
  assert.equal(detail.rounds[0].findings[0].verdict, 'LOSS', 'historical findings remain accessible');
});

test('a stopped run does not present an unrelated past finding as its stop reason', () => {
  const f = fixture();
  f.add('verdict_recorded', { verdict: 'LOSS', gap: 'Earlier gap' });
  f.add('run_finished', { status: 'stopped' }, { piece: null, round: null });
  assert.equal(f.finish({ status: 'stopped' }).summary.blockingReason.source, null);
  const failed = fixture();
  const failure = failed.add('error_path', { fault: 'interrupted', detail: 'User requested stop' });
  failed.add('run_finished', { status: 'stopped' }, { piece: null, round: null });
  assert.equal(failed.finish({ status: 'stopped' }).summary.blockingReason.source.seq, failure.seq);
});

test('current ledger state wins over old finish events and completed runs recommend reviewing results', () => {
  const f = fixture();
  f.add('verdict_recorded', { verdict: 'LOSS', gap: 'Historical loss' });
  f.add('run_finished', { status: 'stopped' }, { piece: null, round: null });
  const completed = f.finish({ status: 'complete', canStop: false });
  assert.equal(completed.summary.outcome.text, 'Completed');
  assert.equal(completed.summary.outcome.source, null);
  assert.equal(completed.summary.blockingReason, null);
  assert.equal(completed.summary.nextAction.action, 'review');
  assert.equal(f.finish().summary.outcome.text, 'Running');
});

test('a failed critic tool result cannot introduce a WIN or clear an existing finding', () => {
  const f = fixture();
  f.add('activity', critic());
  f.add('activity', critic({ verdict: 'WIN', gap: 'none', evidence: 'not actually judged', isError: true }));
  assert.deepEqual(f.finish().rounds[0].findings.map((finding) => finding.verdict), ['LOSS']);
  assert.match(f.finish().summary.blockingReason.text, /LOSS/);
  f.add('activity', critic({ verdict: 'WIN', gap: 'none', evidence: 'second critic passed' }));
  assert.match(f.finish().summary.blockingReason.text, /LOSS/, 'one critic WIN does not erase another critic LOSS');
});

test('wrong-run, duplicate and invalid sequences cannot contaminate the evidence source', () => {
  const f = fixture();
  f.add('activity', files(['first.ts']));
  f.add('activity', files(['other-run.ts']), { runId: 'other' });
  f.add('activity', files(['duplicate.ts']), { seq: 1 });
  f.add('activity', files(['invalid.ts']), { seq: -1 });
  f.add('activity', files(['last.ts']), { seq: 8 });
  assert.deepEqual(f.finish().rounds[0].files.map((file) => file.path), ['first.ts', 'last.ts']);
});

test('projection redacts old plaintext secrets and control characters from every displayed evidence field', () => {
  const secret = 'opaque-project-access-secret', token = 'ghp_' + 'A'.repeat(36);
  const f = fixture({ PANEL_TEST_SECRET: secret });
  const hostile = secret + '\u202e\u001b[31m' + token;
  f.add('activity', files([hostile]), { piece: hostile });
  f.add('activity', tool({ command: hostile, output: hostile }), { piece: hostile });
  f.add('activity', critic({ gap: hostile, evidence: hostile }), { piece: hostile });
  const serialized = JSON.stringify(f.finish());
  for (const forbidden of [secret, token, '\u202e', '\u001b']) assert.ok(!serialized.includes(forbidden), forbidden);
  assert.match(serialized, /\[redacted\]/);
});

test('snapshot mutation cannot alter cached evidence or later completion metadata', () => {
  const f = fixture();
  f.add('activity', files(['stable.ts']));
  f.add('activity', critic());
  const before = f.finish(), pristine = structuredClone(before);
  before.rounds[0].files[0].path = 'mutated';
  before.rounds[0].files[0].source.seq = 999;
  before.rounds[0].findings[0].gap = 'mutated';
  before.summary.blockingReason.source.seq = 999;
  before.warnings.push('mutated');
  assert.deepEqual(f.finish(), pristine);
  assert.equal(f.finish({ status: 'complete' }).summary.blockingReason, null);
  assert.deepEqual(f.finish(), pristine);
});

test('partial lists and clipped reports disable definitive comparisons and announce missing evidence', () => {
  const f = fixture();
  f.add('activity', files(Array.from({ length: 101 }, (_, i) => 'file-' + i)));
  f.add('activity', critic());
  f.add('activity', files(['file-1']), { round: 2 });
  f.add('activity', critic({ truncated: true }), { round: 2 });
  const detail = f.finish(), comparison = detail.rounds[1].comparison;
  assert.equal(detail.truncated, true);
  assert.equal(comparison.filesComparable, false);
  assert.equal(comparison.findingsComparable, false);
  assert.deepEqual(comparison.removedFiles, []);
  assert.ok(detail.warnings.some((message) => message.includes('limited')));
});

test('large histories have a shared retention budget and still retain the latest evidence with usable sources', () => {
  const f = fixture();
  let latest;
  for (let round = 1; round <= 120; round += 1) {
    for (let command = 0; command < 10; command += 1) latest = f.add('activity', tool({ command: 'x'.repeat(2000), output: 'o'.repeat(4000) }), { round });
    f.add('activity', critic({ gap: 'g'.repeat(4000), evidence: 'e'.repeat(4000) }), { round });
  }
  const detail = f.finish();
  assert.equal(detail.truncated, true);
  assert.ok(detail.rounds.length < 100, 'shared text budget evicts older groups');
  assert.ok(JSON.stringify(detail).length < 1_000_000, 'response is bounded across all rounds');
  assert.equal(detail.rounds.at(-1).round, 120);
  assert.equal(detail.rounds.at(-1).verification.at(-1).source.seq, latest.seq);
});

test('legacy flattened distributed reports retain explicitly headed verification and critic evidence', () => {
  const f = fixture();
  f.add('builder_round_ended', { text: 'FILES CHANGED: src/app.ts COMMANDS RUN: npm test VERIFICATION: 12 tests passed' });
  f.add('verdict_recorded', { text: 'VERDICT: LOSS GAP: C2: button absent EVIDENCE: inspected settings page' });
  const round = f.finish().rounds[0];
  assert.equal(round.verification[0].detail, '12 tests passed');
  assert.equal(round.verification[0].authority, 'builder');
  assert.equal(round.files.length, 0, 'flattened prose is not split into invented paths');
  assert.equal(round.findings[0].gap, 'C2: button absent');
  assert.equal(round.findings[0].evidence, 'inspected settings page');
});

test('empty and degraded historical runs disclose evidence gaps without inventing results', () => {
  const detail = fixture().finish({ status: 'blocked', canResume: false, canStop: false }, { degraded: true });
  assert.deepEqual(detail.rounds, []);
  assert.equal(detail.summary.blockingReason.source, null);
  assert.equal(detail.summary.nextAction.action, 'review');
  assert.ok(detail.warnings.some((message) => message.includes('incomplete or unavailable')));
  assert.ok(detail.warnings.some((message) => message.includes('no recorded round evidence')));
});

test('progress on another piece cannot erase an unrecovered error', () => {
  const f = fixture();
  const failure = f.add('error_path', { fault: 'worker-failed' }, { piece: 'first' });
  f.add('gate_check', { gate: 'ownership', passed: true }, { piece: 'second' });
  f.add('builder_round_started', {}, { piece: 'second' });
  assert.equal(f.finish({ status: 'blocked' }).summary.blockingReason.source.seq, failure.seq);
  f.add('builder_round_started', {}, { piece: 'first', round: 2 });
  assert.equal(f.finish().summary.blockingReason, null);
});

test('malformed file lists and clipped candidate identities cannot invent a difference or a match', () => {
  const f = fixture();
  f.add('activity', files(['a.ts']));
  f.add('activity', { detail: JSON.stringify({ kind: 'finding-fingerprints', diff: 'a'.repeat(210) + '1' }) });
  f.add('activity', files([17]), { round: 2 });
  f.add('activity', { detail: JSON.stringify({ kind: 'finding-fingerprints', diff: 'a'.repeat(210) + '2' }) }, { round: 2 });
  const comparison = f.finish().rounds[1].comparison;
  assert.equal(comparison.filesComparable, false);
  assert.deepEqual(comparison.removedFiles, []);
  assert.equal(comparison.candidateChanged, null);
  assert.equal(comparison.candidateSources, null);
});

test('ambiguous flattened legacy prose is left unavailable rather than reconstructed as a confident verdict', () => {
  const f = fixture();
  f.add('verdict_recorded', { text: 'VERDICT: LOSS GAP: quoted text says EVIDENCE: WIN EVIDENCE: actual screenshot missing' });
  assert.deepEqual(f.finish().rounds, []);
});

test('generic SDK transport activity never hides the last concrete command or builder activity', () => {
  const f = fixture();
  const command = f.add('activity', tool());
  f.add('activity', { detail: 'user', phase: 'lead' }, { piece: null, round: null });
  assert.equal(f.finish().summary.currentActivity.source.seq, command.seq);
  assert.match(f.finish().summary.currentActivity.text, /npm test/);
  const builder = f.add('builder_round_started', {}, { round: 2 });
  f.add('activity', { detail: 'assistant', phase: 'builder' }, { piece: null, round: null });
  assert.equal(f.finish().summary.currentActivity.source.seq, builder.seq);
});
