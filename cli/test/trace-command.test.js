import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { BIN, PACKAGE_ROOT, runProcess } from './run-cli.js';

/*
 * The `trace` command: showing a run's event stream.
 *
 * Tests exercise the real CLI binary, driven as child processes. The trace
 * store is stubbed only in test data — records are written to the file the
 * store would write, and the command reads them through the same readTrace
 * that production uses.
 */

const WORK = mkdtempSync(join(tmpdir(), 'exolvra-genesis-trace-'));
after(() => {
  rmSync(WORK, { recursive: true, force: true });
});

let directories = 0;

/** A directory of its own for one test. */
function fresh() {
  const dir = join(WORK, 'trace-' + (directories += 1));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Creates a .exolvra-genesis directory with runs.json. */
function seedRuns(dir, runs) {
  mkdirSync(join(dir, '.exolvra-genesis'), { recursive: true });
  writeFileSync(
    join(dir, '.exolvra-genesis', 'runs.json'),
    JSON.stringify(runs, null, 2) + '\n',
    'utf8',
  );
  return dir;
}

/** Creates a trace NDJSON file with the given records. */
function seedTrace(dir, runId, records) {
  const traceDir = join(dir, '.exolvra-genesis', 'trace');
  mkdirSync(traceDir, { recursive: true });
  const lines = records.map((record) =>
    JSON.stringify({ type: 'event', data: record }),
  );
  writeFileSync(join(traceDir, runId + '.ndjson'), lines.join('\n') + '\n', 'utf8');
  return dir;
}

/** A run record in the shape the ledger accepts. */
function runRecord(overrides = {}) {
  return {
    id: 'r-20260810-1712-a3f9c1',
    sessionId: 'sesn_01J9ZQ',
    input: 'a settings page indistinguishable from linear.app',
    models: { lead: 'claude-opus-5', builder: 'opus', critic: 'sonnet' },
    startedAt: '2026-08-10T17:12:04.000Z',
    status: 'running',
    ...overrides,
  };
}

/** A trace record in the shape the store writes. */
function traceRecord(overrides = {}) {
  return {
    seq: 1,
    at: 1723312324000,
    runId: 'r-20260810-1712-a3f9c1',
    kind: 'run_started',
    piece: null,
    round: null,
    payload: { goal: 'test goal', source: 'goal' },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Argument and flag validation (exit code 2)                                  */
/* -------------------------------------------------------------------------- */

test('trace with no run id exits 2 and shows usage', () => {
  const dir = seedRuns(fresh(), [runRecord()]);
  const { code, stdout, stderr } = runProcess(BIN, ['trace', '-C', dir], {});
  assert.equal(code, 2, stderr);
  assert.equal(stdout, '');
  assert.match(stderr, /accepts 1 arg/);
  assert.match(stderr, /Usage:/);
});

test('trace with an invalid run id shape exits 2', () => {
  const dir = seedRuns(fresh(), [runRecord()]);
  const { code, stdout, stderr } = runProcess(BIN, ['trace', 'not a run id', '-C', dir], {});
  assert.equal(code, 2, stderr);
  assert.equal(stdout, '');
  assert.match(stderr, /invalid value/);
  assert.match(stderr, /expected a run id/);
});

test('trace with unknown flag exits 2', () => {
  const dir = seedRuns(fresh(), [runRecord()]);
  const { code, stdout, stderr } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '--bogus', '-C', dir],
    {},
  );
  assert.equal(code, 2, stderr);
  assert.equal(stdout, '');
  assert.match(stderr, /unknown flag: --bogus/);
});

test('trace --limit 0 exits 2', () => {
  const dir = seedRuns(fresh(), [runRecord()]);
  const { code, stdout, stderr } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '--limit', '0', '-C', dir],
    {},
  );
  assert.equal(code, 2, stderr);
  assert.equal(stdout, '');
  assert.match(stderr, /invalid value/);
  assert.match(stderr, /--limit/);
});

test('trace --limit not-a-number exits 2', () => {
  const dir = seedRuns(fresh(), [runRecord()]);
  const { code, stdout, stderr } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '--limit', 'not-a-number', '-C', dir],
    {},
  );
  assert.equal(code, 2, stderr);
  assert.equal(stdout, '');
  assert.match(stderr, /invalid value/);
});

/* -------------------------------------------------------------------------- */
/* Run resolution (exit code 2)                                                */
/* -------------------------------------------------------------------------- */

test('trace for a run not in runs.json exits 2', () => {
  const dir = seedRuns(fresh(), [runRecord({ id: 'r-other' })]);
  const { code, stdout, stderr } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '-C', dir],
    {},
  );
  assert.equal(code, 2, stderr);
  assert.equal(stdout, '');
  assert.match(stderr, /no run is recorded as/);
  assert.match(stderr, /exolvra-genesis runs/);
});

test('trace with no .exolvra-genesis directory exits 2', () => {
  const dir = fresh();
  const { code, stdout, stderr } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '-C', dir],
    {},
  );
  assert.equal(code, 2, stderr);
  assert.equal(stdout, '');
  assert.match(stderr, /no run has been recorded here/);
});

test('trace with corrupt runs.json exits 2', () => {
  const dir = fresh();
  mkdirSync(join(dir, '.exolvra-genesis'), { recursive: true });
  writeFileSync(join(dir, '.exolvra-genesis', 'runs.json'), '[{"id":', 'utf8');
  const { code, stdout, stderr } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '-C', dir],
    {},
  );
  assert.equal(code, 2, stderr);
  assert.equal(stdout, '');
  assert.match(stderr, /could not read the run ledger/);
});

/* -------------------------------------------------------------------------- */
/* Empty and missing trace (exit code 0)                                       */
/* -------------------------------------------------------------------------- */

test('trace with no trace file exits 0 with stderr message', () => {
  const dir = seedRuns(fresh(), [runRecord()]);
  const { code, stdout, stderr } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '-C', dir],
    {},
  );
  assert.equal(code, 0, stderr);
  assert.equal(stdout, '', 'an empty trace must put nothing on stdout');
  assert.match(stderr, /no trace recorded/);
});

test('trace with empty trace file exits 0', () => {
  const dir = seedRuns(fresh(), [runRecord()]);
  seedTrace(dir, 'r-20260810-1712-a3f9c1', []);
  // Write an empty file
  writeFileSync(
    join(dir, '.exolvra-genesis', 'trace', 'r-20260810-1712-a3f9c1.ndjson'),
    '',
    'utf8',
  );
  const { code, stdout, stderr } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '-C', dir],
    {},
  );
  assert.equal(code, 0, stderr);
  assert.equal(stdout, '', 'an empty trace must put nothing on stdout');
});

/* -------------------------------------------------------------------------- */
/* Normal output (piped and terminal)                                          */
/* -------------------------------------------------------------------------- */

test('piped trace output is tab-separated with no header', () => {
  const dir = seedRuns(fresh(), [runRecord()]);
  seedTrace(dir, 'r-20260810-1712-a3f9c1', [
    traceRecord({ seq: 1 }),
    traceRecord({ seq: 2, kind: 'run_finished', payload: { status: 'win', rounds: 2, costUsd: 1.5 } }),
  ]);
  const { code, stdout, stderr } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '-C', dir],
    {},
  );
  assert.equal(code, 0, stderr);
  const lines = stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 2, 'piped output has no header');
  for (const line of lines) {
    const fields = line.split('\t');
    assert.equal(fields.length, 6, 'each record has 6 fields: ' + line);
  }
  // First field is seq
  assert.equal(lines[0].split('\t')[0], '1');
  assert.equal(lines[1].split('\t')[0], '2');
});

test('terminal trace output has aligned columns and header', () => {
  const dir = seedRuns(fresh(), [runRecord()]);
  seedTrace(dir, 'r-20260810-1712-a3f9c1', [
    traceRecord({ seq: 1 }),
    traceRecord({ seq: 2, kind: 'verdict_recorded', piece: 'P1', round: 1, payload: { verdict: 'WIN' } }),
  ]);
  const { code, stdout, stderr } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '-C', dir],
    { env: { EXOLVRA_GENESIS_FORCE_TTY: '100' } },
  );
  assert.equal(code, 0, stderr);
  const lines = stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 3, 'terminal output has header + 2 records');
  assert.match(lines[0], /^SEQ/i, 'header starts with SEQ');
  assert.ok(!stdout.includes('\t'), 'terminal output should not have tabs');
});

/* -------------------------------------------------------------------------- */
/* JSON output                                                                 */
/* -------------------------------------------------------------------------- */

test('--json outputs NDJSON with stable snake_case keys', () => {
  const dir = seedRuns(fresh(), [runRecord()]);
  seedTrace(dir, 'r-20260810-1712-a3f9c1', [
    traceRecord({ seq: 1 }),
    traceRecord({ seq: 2, kind: 'run_finished', piece: 'P1', round: 2, payload: { status: 'win' } }),
  ]);
  const { code, stdout, stderr } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '--json', '-C', dir],
    {},
  );
  assert.equal(code, 0, stderr);
  const lines = stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 2, 'NDJSON has one line per record');

  for (const line of lines) {
    const record = JSON.parse(line);
    // Check snake_case keys
    assert.ok('run_id' in record, 'should have run_id not runId');
    assert.ok(!('runId' in record), 'should not have runId');
    // Check all expected keys are present
    const keys = Object.keys(record).sort();
    assert.deepEqual(keys, ['at', 'kind', 'payload', 'piece', 'round', 'run_id', 'seq']);
  }

  // Check that piece and round can be null
  const firstRecord = JSON.parse(lines[0]);
  assert.equal(firstRecord.piece, null, 'null piece preserved');
  assert.equal(firstRecord.round, null, 'null round preserved');

  // Check that piece and round can have values
  const secondRecord = JSON.parse(lines[1]);
  assert.equal(secondRecord.piece, 'P1');
  assert.equal(secondRecord.round, 2);
});

test('--json does not emit literal U+2028 and U+2029 line separators', () => {
  // U+2028 and U+2029 in payload are stripped by flattening, ensuring
  // the output stays one line per record (NDJSON contract).
  const dir = seedRuns(fresh(), [runRecord()]);
  seedTrace(dir, 'r-20260810-1712-a3f9c1', [
    traceRecord({
      seq: 1,
      payload: { text: 'line\u2028separator\u2029end' },
    }),
  ]);
  const { code, stdout, stderr } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '--json', '-C', dir],
    {},
  );
  assert.equal(code, 0, stderr);
  // The output must not contain literal U+2028 or U+2029 characters
  // which would break NDJSON (one object per line)
  assert.ok(!stdout.includes('\u2028'), 'U+2028 must not appear literally');
  assert.ok(!stdout.includes('\u2029'), 'U+2029 must not appear literally');
  // The output should be valid NDJSON (one line per record)
  const lines = stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, 'output should be one line');
  // The line should parse as valid JSON
  const record = JSON.parse(lines[0]);
  assert.ok(record.payload.text.includes('line'), 'content preserved');
  assert.ok(record.payload.text.includes('separator'), 'content preserved');
  assert.ok(record.payload.text.includes('end'), 'content preserved');
});

/* -------------------------------------------------------------------------- */
/* --limit flag                                                                */
/* -------------------------------------------------------------------------- */

test('--limit restricts the number of records', () => {
  const dir = seedRuns(fresh(), [runRecord()]);
  seedTrace(dir, 'r-20260810-1712-a3f9c1', [
    traceRecord({ seq: 1 }),
    traceRecord({ seq: 2, kind: 'piece_dispatched' }),
    traceRecord({ seq: 3, kind: 'verdict_recorded' }),
  ]);
  const { code, stdout } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '--limit', '2', '-C', dir],
    {},
  );
  assert.equal(code, 0);
  const lines = stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 2, '--limit 2 should give 2 records');
});

/* -------------------------------------------------------------------------- */
/* Help output                                                                 */
/* -------------------------------------------------------------------------- */

test('--help exits 0 and shows usage', () => {
  const { code, stdout, stderr } = runProcess(BIN, ['trace', '--help'], {});
  assert.equal(code, 0, stderr);
  assert.match(stdout, /USAGE/);
  assert.match(stdout, /exolvra-genesis trace <run-id>/);
  assert.match(stdout, /FLAGS/);
  assert.match(stdout, /--json/);
  assert.match(stdout, /--follow/);
  assert.match(stdout, /--limit/);
  assert.match(stdout, /--verbose/);
});

test('trace appears in root help', () => {
  const { code, stdout } = runProcess(BIN, ['--help'], {});
  assert.equal(code, 0);
  assert.ok(stdout.includes('trace'), 'trace command should appear in root help');
});

/* -------------------------------------------------------------------------- */
/* Untrusted renderer input: flattening                                        */
/* -------------------------------------------------------------------------- */

/** The escape character. */
const ESC = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const RLO = String.fromCharCode(0x202e);
const PDF = String.fromCharCode(0x202c);

test('ANSI escapes in payload are stripped in non-verbose mode', () => {
  const dir = seedRuns(fresh(), [runRecord()]);
  seedTrace(dir, 'r-20260810-1712-a3f9c1', [
    traceRecord({
      seq: 1,
      at: 1723312324000,
      kind: 'note',
      piece: null,
      round: null,
      payload: { text: ESC + '[31mred' + ESC + '[0m' },
    }),
  ]);
  const { code, stdout } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '-C', dir],
    {},
  );
  assert.equal(code, 0);
  // The raw ESC byte cannot survive JSON.stringify anyway, but we keep this
  assert.ok(!stdout.includes(ESC), 'raw ESC byte should not appear');
  // The decisive assertions: flattening removes the escape sequences before
  // JSON.stringify, so the literal \u001b and [31m do not appear in output
  assert.ok(!stdout.includes('\\u001b'), 'escaped ESC sequence should not appear');
  assert.ok(!stdout.includes('[31m'), 'ANSI color code should not appear');
  // The payload field must be exactly {"text":"red"} - the flattened form
  const lines = stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, 'should have one record');
  const fields = lines[0].split('\t');
  assert.equal(fields.length, 6, 'should have 6 fields');
  assert.equal(fields[5], '{"text":"red"}', 'payload should be flattened to just "red"');
});

test('bidi controls in payload are stripped', () => {
  const dir = seedRuns(fresh(), [runRecord()]);
  seedTrace(dir, 'r-20260810-1712-a3f9c1', [
    traceRecord({
      seq: 1,
      payload: { text: 'harmless ' + RLO + 'siht gnidaer' + PDF },
    }),
  ]);
  const { code, stdout } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '-C', dir],
    {},
  );
  assert.equal(code, 0);
  const BIDI = /[\u202A-\u202E\u2066-\u2069]/;
  assert.ok(!BIDI.test(stdout), 'bidi controls should be stripped');
  assert.ok(stdout.includes('harmless'), 'text content should remain');
});

test('BELL character in payload is stripped in non-verbose mode', () => {
  const dir = seedRuns(fresh(), [runRecord()]);
  seedTrace(dir, 'r-20260810-1712-a3f9c1', [
    traceRecord({
      seq: 1,
      at: 1723312324000,
      kind: 'note',
      piece: null,
      round: null,
      payload: { text: 'alert' + BELL + 'sound' },
    }),
  ]);
  const { code, stdout } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '-C', dir],
    {},
  );
  assert.equal(code, 0);
  // The raw BELL byte cannot survive JSON.stringify anyway, but we keep this
  assert.ok(!stdout.includes(BELL), 'raw BELL byte should not appear');
  // The decisive assertion: flattening removes the BELL before JSON.stringify,
  // so the literal \u0007 does not appear in output
  assert.ok(!stdout.includes('\\u0007'), 'escaped BELL sequence should not appear');
  // The payload field must be exactly {"text":"alertsound"} - the flattened form
  const lines = stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, 'should have one record');
  const fields = lines[0].split('\t');
  assert.equal(fields.length, 6, 'should have 6 fields');
  assert.equal(fields[5], '{"text":"alert sound"}', 'payload should be flattened without BELL');
});

test('newlines and tabs in payload become spaces', () => {
  const dir = seedRuns(fresh(), [runRecord()]);
  seedTrace(dir, 'r-20260810-1712-a3f9c1', [
    traceRecord({
      seq: 1,
      at: 1723312324000,
      kind: 'note',
      piece: null,
      round: null,
      payload: { text: 'line1\nline2\ttab' },
    }),
  ]);
  // Use piped output (no TTY) to get the exact payload field
  const { code, stdout } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '-C', dir],
    {},
  );
  assert.equal(code, 0);
  // The decisive assertions: flattening replaces \n and \t with spaces before
  // JSON.stringify, so neither the literal two-character sequences nor the
  // raw control characters appear in output
  assert.ok(!stdout.includes('\\n'), 'escaped newline should not appear');
  assert.ok(!stdout.includes('\\t'), 'escaped tab should not appear');
  // The payload field must be exactly {"text":"line1 line2 tab"} - the flattened form
  const lines = stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, 'should have one record');
  const fields = lines[0].split('\t');
  assert.equal(fields.length, 6, 'should have 6 fields');
  assert.equal(fields[5], '{"text":"line1 line2 tab"}', 'payload should have spaces not escapes');
});

test('--verbose passes payload through without flattening', () => {
  const dir = seedRuns(fresh(), [runRecord()]);
  seedTrace(dir, 'r-20260810-1712-a3f9c1', [
    traceRecord({
      seq: 1,
      payload: { text: 'test\nwith\nnewlines' },
    }),
  ]);
  const { code, stdout } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '--verbose', '-C', dir],
    {},
  );
  assert.equal(code, 0);
  // In verbose mode, JSON payload should show the original text
  assert.ok(stdout.includes('\\n'), 'newlines should be preserved as \\n in JSON');
});

/* -------------------------------------------------------------------------- */
/* Payload cannot forge a row                                                  */
/* -------------------------------------------------------------------------- */

test('payload with tab cannot create extra field in piped output', () => {
  const dir = seedRuns(fresh(), [runRecord()]);
  seedTrace(dir, 'r-20260810-1712-a3f9c1', [
    traceRecord({
      seq: 1,
      payload: { text: 'field1\tfield2' },
    }),
  ]);
  const { code, stdout } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '-C', dir],
    {},
  );
  assert.equal(code, 0);
  const lines = stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, 'should be one record');
  // Tab inside payload should be flattened, not create extra field
  const fields = lines[0].split('\t');
  assert.equal(fields.length, 6, 'should have exactly 6 fields, not more');
  // The payload should show the tab replaced with space, not escaped as \\t
  const payloadField = fields[5];
  assert.ok(payloadField.includes('field1 field2'), 'tab should be replaced with space in flattened output');
  assert.ok(!payloadField.includes('\\t'), 'escaped tab should not appear after flattening');
});

test('payload with newline cannot create extra row in piped output', () => {
  const dir = seedRuns(fresh(), [runRecord()]);
  seedTrace(dir, 'r-20260810-1712-a3f9c1', [
    traceRecord({
      seq: 1,
      payload: { text: 'line1\nline2' },
    }),
  ]);
  const { code, stdout } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '-C', dir],
    {},
  );
  assert.equal(code, 0);
  const lines = stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, 'newline in payload should not create extra row');
});

/* -------------------------------------------------------------------------- */
/* Partial JSON lines in trace (exit code 0, graceful handling)                */
/* -------------------------------------------------------------------------- */

test('partial JSON lines in trace are skipped gracefully and exits 0', () => {
  // The trace store skips partial/corrupt lines rather than failing, returning
  // an empty record set. The command then exits 0 with "no trace recorded".
  const dir = seedRuns(fresh(), [runRecord()]);
  const traceDir = join(dir, '.exolvra-genesis', 'trace');
  mkdirSync(traceDir, { recursive: true });
  writeFileSync(join(traceDir, 'r-20260810-1712-a3f9c1.ndjson'), '{"type":', 'utf8');
  const { code, stdout, stderr } = runProcess(
    BIN,
    ['trace', 'r-20260810-1712-a3f9c1', '-C', dir],
    {},
  );
  // Partial JSON lines are skipped, so this returns empty records and exits 0
  assert.equal(code, 0, stderr);
  assert.equal(stdout, '');
});
