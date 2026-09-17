import { PREFLIGHT_FAKE } from './preflight-fake.js';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { readTrace, openTrace } from '../dist/trace-store.js';
import { readMarkers } from '../dist/commands/run.js';
import { BIN, PACKAGE_ROOT, REPO_ROOT, createSandbox, runProcess, integrityCheckPhase } from './run-cli.js';

/* -------------------------------------------------------------------------- */
/* Setup: A sandbox with a scripted fake SDK transport                        */
/* -------------------------------------------------------------------------- */

/**
 * A fake SDK that replays a scripted run with support for integrity markers.
 */
const FAKE_SDK = `import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

let phaseIndex = 0;

export function query({ prompt, options }) {
${PREFLIGHT_FAKE}
  const plan = JSON.parse(readFileSync(process.env.EXOLVRA_GENESIS_RUN_FAKE, 'utf8'));
  const phase = plan.phases[Math.min(phaseIndex, plan.phases.length - 1)];
  phaseIndex += 1;

  const writeState = (status, detail) => {
    const file = join(options.cwd, '.exolvra-genesis', 'state.json');
    mkdirSync(dirname(file), { recursive: true });
    const obj = detail !== undefined ? { status, detail } : { status };
    writeFileSync(file, JSON.stringify(obj, null, 2) + '\\n', 'utf8');
  };

  if (phase.fail === 'start') {
    throw new Error('Failed to spawn Claude Code process: spawn node ENOENT');
  }

  const sessionId = phase.sessionId ?? 'sesn_integrity_test';

  return {
    async interrupt() {},
    async *[Symbol.asyncIterator]() {
      if (phase.content !== undefined) {
        for (const item of phase.content) {
          yield {
            type: 'assistant',
            session_id: sessionId,
            message: { content: item.blocks ?? [{ type: 'text', text: item.text ?? '' }] },
          };
        }
      } else {
        for (const text of phase.messages ?? []) {
          yield {
            type: 'assistant',
            session_id: sessionId,
            message: { content: [{ type: 'text', text }] },
          };
        }
      }
      if (phase.state !== undefined) writeState(phase.state, phase.stateDetail);
      const result = phase.result;
      if (result === undefined || result === null) return;
      yield {
        type: 'result',
        subtype: result.subtype ?? 'success',
        session_id: sessionId,
        num_turns: 3,
        total_cost_usd: result.costUsd ?? 0,
        result: result.text ?? '',
        errors: result.errors ?? [],
      };
    },
  };
}
`;

/**
 * Links node_modules dependencies from the package to the sandbox.
 */
function linkDependencies(root) {
  const from = join(PACKAGE_ROOT, 'node_modules');
  const to = join(root, 'node_modules');
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (entry === '@anthropic-ai' || entry === '.bin') continue;
    symlinkSync(join(from, entry), join(to, entry), 'junction');
  }
}

const WORK = mkdtempSync(join(tmpdir(), 'exolvra-genesis-trace-integrity-'));
const sandbox = createSandbox();
linkDependencies(sandbox.root);
writeFileSync(
  join(sandbox.root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'index.js'),
  FAKE_SDK,
  'utf8',
);

after(() => {
  sandbox.cleanup();
  rmSync(WORK, { recursive: true, force: true });
});

let directories = 0;

function fresh() {
  const dir = join(WORK, 'integrity-' + (directories += 1));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The opening message of a run: the bar, its artifacts, and the pieces. */
const OPENING = [
  'I picked the gh transcripts captured on this machine as the bar.',
  '@exolvra-genesis bar .exolvra-genesis/bar',
  '@exolvra-genesis artifact .exolvra-genesis/bar/gh/root-help.txt | gh --help',
  '@exolvra-genesis piece P1 | The flag table and the leaf help',
].join('\n');

function round(piece, number, verdict, gap = '') {
  return (
    'Round ' +
    number +
    ' of ' +
    piece +
    ' has been judged.\n' +
    '@exolvra-genesis round ' +
    piece +
    ' | ' +
    number +
    ' | ' +
    verdict +
    ' | ' +
    gap
  );
}

/**
 * Runs the built binary against a scripted transport.
 */
function runRun(args, { phases, cwd = fresh(), env = {} } = {}) {
  const script = join(cwd, 'fake-sdk.json');
  writeFileSync(script, JSON.stringify({ phases }, null, 2), 'utf8');

  const result = runProcess(sandbox.bin, args, {
    cwd,
    env: {
      EXOLVRA_GENESIS_RUN_FAKE: script,
      EXOLVRA_GENESIS_PLUGIN_DIR: REPO_ROOT,
      HOME: cwd,
      USERPROFILE: cwd,
      APPDATA: cwd,
      XDG_CONFIG_HOME: cwd,
      ...env,
    },
  });

  return {
    ...result,
    cwd,
    runs: () => JSON.parse(readFileSync(join(cwd, '.exolvra-genesis', 'runs.json'), 'utf8')),
    state: () => JSON.parse(readFileSync(join(cwd, '.exolvra-genesis', 'state.json'), 'utf8')),
    traceRecords: () => {
      const runs = JSON.parse(readFileSync(join(cwd, '.exolvra-genesis', 'runs.json'), 'utf8'));
      const runId = runs[0].id;
      // Marker assertions exclude the separately covered permission receipt.
      const records = readTrace(cwd, runId).records;
      assert.equal(records.filter((r) => r.payload?.gate === 'execution-preflight').length, 1);
      return records.filter((r) => r.payload?.gate !== 'execution-preflight');
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Unit test: readMarker parses integrity markers correctly                   */
/* -------------------------------------------------------------------------- */

describe('readMarkers parses integrity markers', () => {
  test('gate pass marker parses correctly', () => {
    const text = '@exolvra-genesis integrity gate | bar-sha256 | pass | verified';
    const result = readMarkers(text);

    assert.equal(result.markers.length, 1);
    const marker = result.markers[0];
    assert.equal(marker.kind, 'integrity');
    assert.equal(marker.check, 'gate');
    assert.equal(marker.name, 'bar-sha256');
    assert.equal(marker.passed, true);
    assert.equal(marker.detail, 'verified');
  });

  test('gate fail marker parses correctly', () => {
    const text = '@exolvra-genesis integrity gate | bar-sha256 | fail | hash mismatch';
    const result = readMarkers(text);

    assert.equal(result.markers.length, 1);
    const marker = result.markers[0];
    assert.equal(marker.kind, 'integrity');
    assert.equal(marker.check, 'gate');
    assert.equal(marker.name, 'bar-sha256');
    assert.equal(marker.passed, false);
    assert.equal(marker.detail, 'hash mismatch');
  });

  test('pin pass marker parses correctly', () => {
    const text = '@exolvra-genesis integrity pin | spec-file | pass |';
    const result = readMarkers(text);

    assert.equal(result.markers.length, 1);
    const marker = result.markers[0];
    assert.equal(marker.kind, 'integrity');
    assert.equal(marker.check, 'pin');
    assert.equal(marker.name, 'spec-file');
    assert.equal(marker.passed, true);
    assert.equal(marker.detail, '');
  });

  test('pin fail marker parses correctly', () => {
    const text = '@exolvra-genesis integrity pin | spec-file | fail | file modified since capture';
    const result = readMarkers(text);

    assert.equal(result.markers.length, 1);
    const marker = result.markers[0];
    assert.equal(marker.kind, 'integrity');
    assert.equal(marker.check, 'pin');
    assert.equal(marker.name, 'spec-file');
    assert.equal(marker.passed, false);
    assert.equal(marker.detail, 'file modified since capture');
  });

  test('bad kind word is unreadable', () => {
    const text = '@exolvra-genesis integrity check | name | pass | detail';
    const result = readMarkers(text);

    assert.equal(result.markers.length, 0);
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].kind, 'unreadable');
  });

  test('bad verdict word is unreadable', () => {
    const text = '@exolvra-genesis integrity gate | name | ok | detail';
    const result = readMarkers(text);

    assert.equal(result.markers.length, 0);
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].kind, 'unreadable');
  });

  test('missing name is unreadable', () => {
    const text = '@exolvra-genesis integrity gate |  | pass | detail';
    const result = readMarkers(text);

    assert.equal(result.markers.length, 0);
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].kind, 'unreadable');
  });

  test('detail with pipe is preserved whole', () => {
    const text = '@exolvra-genesis integrity gate | bar | fail | expected sha256=abc | got sha256=def';
    const result = readMarkers(text);

    assert.equal(result.markers.length, 1);
    const marker = result.markers[0];
    assert.equal(marker.kind, 'integrity');
    assert.equal(marker.detail, 'expected sha256=abc | got sha256=def');
  });
});

/* -------------------------------------------------------------------------- */
/* Integration: gate_check trace event produced                               */
/* -------------------------------------------------------------------------- */

test('Criterion 2: well-formed gate marker produces gate_check trace event', () => {
  const phases = [
    {
      messages: [
        OPENING,
        'Verifying bar integrity...\n@exolvra-genesis integrity gate | bar-sha256 | pass | verified',
        round('P1', 1, 'WIN'),
      ],
      state: 'complete',
      result: { text: 'Run complete.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test integrity'], { phases });
  assert.equal(r.code, 0, 'run should succeed: ' + r.stderr);

  const records = r.traceRecords();
  const gateChecks = records.filter((rec) => rec.kind === 'gate_check');

  assert.equal(gateChecks.length, 1, 'exactly one gate_check event should be recorded');
  const evt = gateChecks[0];
  assert.equal(evt.payload.gate, 'bar-sha256');
  assert.equal(evt.payload.passed, true);
  assert.equal(evt.payload.detail, 'verified');
});

test('Criterion 2: well-formed pin marker produces pin_check trace event', () => {
  const phases = [
    {
      messages: [
        OPENING,
        'Verifying spec pin...\n@exolvra-genesis integrity pin | spec-file | pass |',
        round('P1', 1, 'WIN'),
      ],
      state: 'complete',
      result: { text: 'Run complete.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test integrity'], { phases });
  assert.equal(r.code, 0, 'run should succeed: ' + r.stderr);

  const records = r.traceRecords();
  const pinChecks = records.filter((rec) => rec.kind === 'pin_check');

  assert.equal(pinChecks.length, 1, 'exactly one pin_check event should be recorded');
  const evt = pinChecks[0];
  assert.equal(evt.payload.pin, 'spec-file');
  assert.equal(evt.payload.passed, true);
});

/* -------------------------------------------------------------------------- */
/* Criterion 3: Events stamped with runId                                     */
/* -------------------------------------------------------------------------- */

test('Criterion 3: gate_check and pin_check events stamped with runId', () => {
  const phases = [
    {
      messages: [
        OPENING,
        '@exolvra-genesis integrity gate | bar-sha256 | pass |\n@exolvra-genesis integrity pin | spec | pass |',
        round('P1', 1, 'WIN'),
      ],
      state: 'complete',
      result: { text: 'Run complete.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test integrity'], { phases });
  assert.equal(r.code, 0, r.stderr);

  const records = r.traceRecords();
  const runs = r.runs();
  const runId = runs[0].id;

  const gateChecks = records.filter((rec) => rec.kind === 'gate_check');
  const pinChecks = records.filter((rec) => rec.kind === 'pin_check');

  assert.equal(gateChecks.length, 1);
  assert.equal(pinChecks.length, 1);

  assert.equal(gateChecks[0].runId, runId, 'gate_check must have correct runId');
  assert.equal(pinChecks[0].runId, runId, 'pin_check must have correct runId');
});

/* -------------------------------------------------------------------------- */
/* Criterion 4: passed is true only for pass, false only for fail             */
/* -------------------------------------------------------------------------- */

test('Criterion 4a: passed is true only for pass (gate)', () => {
  const phases = [
    {
      messages: [
        OPENING,
        '@exolvra-genesis integrity gate | bar-sha256 | pass | verified',
        round('P1', 1, 'WIN'),
      ],
      state: 'complete',
      result: { text: 'Run complete.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test integrity'], { phases });
  assert.equal(r.code, 0, r.stderr);

  const records = r.traceRecords();
  const gateCheck = records.find((rec) => rec.kind === 'gate_check');
  assert.equal(gateCheck.payload.passed, true, 'pass must produce passed=true');
});

test('Criterion 4b: passed is false only for fail (gate)', () => {
  const phases = [
    {
      messages: [
        OPENING,
        '@exolvra-genesis integrity gate | bar-sha256 | fail | hash mismatch',
        round('P1', 1, 'LOSS', 'integrity failed'),
      ],
      state: 'stopped',
      result: { text: 'Run stopped.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test integrity'], { phases });
  assert.equal(r.code, 1, 'loss should exit 1');

  const records = r.traceRecords();
  const gateCheck = records.find((rec) => rec.kind === 'gate_check');
  assert.equal(gateCheck.payload.passed, false, 'fail must produce passed=false');
});

test('Criterion 4c: passed is true only for pass (pin)', () => {
  const phases = [
    {
      messages: [
        OPENING,
        '@exolvra-genesis integrity pin | spec-file | pass |',
        round('P1', 1, 'WIN'),
      ],
      state: 'complete',
      result: { text: 'Run complete.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test integrity'], { phases });
  assert.equal(r.code, 0, r.stderr);

  const records = r.traceRecords();
  const pinCheck = records.find((rec) => rec.kind === 'pin_check');
  assert.equal(pinCheck.payload.passed, true, 'pass must produce passed=true');
});

test('Criterion 4d: passed is false only for fail (pin)', () => {
  const phases = [
    {
      messages: [
        OPENING,
        '@exolvra-genesis integrity pin | spec-file | fail | file modified',
        round('P1', 1, 'LOSS', 'integrity failed'),
      ],
      state: 'stopped',
      result: { text: 'Run stopped.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test integrity'], { phases });
  assert.equal(r.code, 1, 'loss should exit 1');

  const records = r.traceRecords();
  const pinCheck = records.find((rec) => rec.kind === 'pin_check');
  assert.equal(pinCheck.payload.passed, false, 'fail must produce passed=false');
});

/* -------------------------------------------------------------------------- */
/* Criterion 5: Malformed integrity markers produce no trace event           */
/* -------------------------------------------------------------------------- */

test('Criterion 5a: bad kind word produces no trace event', () => {
  const phases = [
    {
      messages: [
        OPENING,
        '@exolvra-genesis integrity check | name | pass | detail',
        round('P1', 1, 'WIN'),
      ],
      state: 'complete',
      result: { text: 'Run complete.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test integrity'], { phases });
  assert.equal(r.code, 0, r.stderr);

  const records = r.traceRecords();
  const integrityEvents = records.filter(
    (rec) => rec.kind === 'gate_check' || rec.kind === 'pin_check'
  );
  assert.equal(integrityEvents.length, 0, 'bad kind word must produce no integrity trace event');
});

test('Criterion 5b: bad verdict word produces no trace event', () => {
  const phases = [
    {
      messages: [
        OPENING,
        '@exolvra-genesis integrity gate | name | ok | detail',
        round('P1', 1, 'WIN'),
      ],
      state: 'complete',
      result: { text: 'Run complete.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test integrity'], { phases });
  assert.equal(r.code, 0, r.stderr);

  const records = r.traceRecords();
  const integrityEvents = records.filter(
    (rec) => rec.kind === 'gate_check' || rec.kind === 'pin_check'
  );
  assert.equal(integrityEvents.length, 0, 'bad verdict word must produce no integrity trace event');
});

test('Criterion 5c: missing name produces no trace event', () => {
  const phases = [
    {
      messages: [
        OPENING,
        '@exolvra-genesis integrity gate |  | pass | detail',
        round('P1', 1, 'WIN'),
      ],
      state: 'complete',
      result: { text: 'Run complete.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test integrity'], { phases });
  assert.equal(r.code, 0, r.stderr);

  const records = r.traceRecords();
  const integrityEvents = records.filter(
    (rec) => rec.kind === 'gate_check' || rec.kind === 'pin_check'
  );
  assert.equal(integrityEvents.length, 0, 'missing name must produce no integrity trace event');
});

/* -------------------------------------------------------------------------- */
/* Criterion 2 (continued): no warning for well-formed integrity markers     */
/* -------------------------------------------------------------------------- */

test('Criterion 2: well-formed integrity marker does not trigger unreadable warning', () => {
  const phases = [
    {
      messages: [
        OPENING,
        '@exolvra-genesis integrity gate | bar-sha256 | pass | verified',
        round('P1', 1, 'WIN'),
      ],
      state: 'complete',
      result: { text: 'Run complete.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test integrity'], { phases });
  assert.equal(r.code, 0, r.stderr);

  const combined = r.stdout + r.stderr;
  const hasWarning = combined.includes('ignoring a report line this build cannot read');
  assert.equal(hasWarning, false, 'well-formed integrity marker must not trigger warning');
});

test('Criterion 5: malformed integrity marker still triggers unreadable warning', () => {
  const phases = [
    {
      messages: [
        OPENING,
        '@exolvra-genesis integrity badkind | name | pass | detail',
        round('P1', 1, 'WIN'),
      ],
      state: 'complete',
      result: { text: 'Run complete.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test integrity'], { phases });
  assert.equal(r.code, 0, r.stderr);

  const combined = r.stdout + r.stderr;
  const hasWarning = combined.includes('ignoring a report line this build cannot read');
  assert.equal(hasWarning, true, 'malformed integrity marker must trigger warning');
});

/* -------------------------------------------------------------------------- */
/* Criterion 6: existing marker kinds are untouched                           */
/* -------------------------------------------------------------------------- */

test('Criterion 6: bar marker still works alongside integrity', () => {
  const phases = [
    {
      messages: [
        '@exolvra-genesis bar .exolvra-genesis/bar\n@exolvra-genesis integrity gate | bar-sha256 | pass |',
        '@exolvra-genesis piece P1 | Test piece',
        round('P1', 1, 'WIN'),
      ],
      state: 'complete',
      result: { text: 'Run complete.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test'], { phases });
  assert.equal(r.code, 0, r.stderr);

  // Verify the run completed and trace has expected events
  const records = r.traceRecords();
  const runStarted = records.find((rec) => rec.kind === 'run_started');
  const runFinished = records.find((rec) => rec.kind === 'run_finished');
  const pieceDispatched = records.find((rec) => rec.kind === 'piece_dispatched');
  const verdictRecorded = records.find((rec) => rec.kind === 'verdict_recorded');
  const gateCheck = records.find((rec) => rec.kind === 'gate_check');

  assert.notEqual(runStarted, undefined, 'run_started must exist');
  assert.notEqual(runFinished, undefined, 'run_finished must exist');
  assert.notEqual(pieceDispatched, undefined, 'piece_dispatched must exist');
  assert.notEqual(verdictRecorded, undefined, 'verdict_recorded must exist');
  assert.notEqual(gateCheck, undefined, 'gate_check must exist');
});

/* -------------------------------------------------------------------------- */
/* Criterion 3: integrity events stamped with piece and round                 */
/* -------------------------------------------------------------------------- */

test('Criterion 3: integrity event after round marker stamped with that piece/round', () => {
  // A round marker for piece P, round N, then an integrity marker: the integrity
  // event must be stamped with piece=P and round=N.
  const phases = [
    {
      messages: [
        OPENING,
        round('P1', 1, 'LOSS', 'first attempt failed'),
        '@exolvra-genesis integrity gate | bar-sha256 | pass | verified after round',
        round('P1', 2, 'WIN'),
      ],
      state: 'complete',
      result: { text: 'Run complete.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test integrity'], { phases });
  assert.equal(r.code, 0, r.stderr);

  const records = r.traceRecords();
  const gateChecks = records.filter((rec) => rec.kind === 'gate_check');

  assert.equal(gateChecks.length, 1, 'exactly one gate_check event');
  const evt = gateChecks[0];
  assert.equal(evt.piece, 'P1', 'piece must be P1 from the preceding round marker');
  assert.equal(evt.round, 1, 'round must be 1 from the preceding round marker');
});

test('Criterion 3: integrity event before any round marker stamped with null piece/round', () => {
  // An integrity marker emitted BEFORE any round marker: piece and round must be null.
  const phases = [
    {
      messages: [
        OPENING,
        '@exolvra-genesis integrity gate | bar-sha256 | pass | checked early',
        round('P1', 1, 'WIN'),
      ],
      state: 'complete',
      result: { text: 'Run complete.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test integrity'], { phases });
  assert.equal(r.code, 0, r.stderr);

  const records = r.traceRecords();
  const gateChecks = records.filter((rec) => rec.kind === 'gate_check');

  assert.equal(gateChecks.length, 1, 'exactly one gate_check event');
  const evt = gateChecks[0];
  assert.equal(evt.piece, null, 'piece must be null before any round marker');
  assert.equal(evt.round, null, 'round must be null before any round marker');
});

test('Criterion 3: integrity event after second round marker tracks the most recent', () => {
  // After a round marker for piece P round N, then piece Q round M, an integrity
  // marker must be stamped with Q/M, not P/N. This proves tracking, not hardcoding.
  const phases = [
    {
      messages: [
        OPENING,
        round('P1', 1, 'LOSS', 'first piece first round'),
        round('P2', 3, 'LOSS', 'second piece third round'),
        '@exolvra-genesis integrity pin | spec-file | pass | verified after second round',
        round('P2', 4, 'WIN'),
      ],
      state: 'complete',
      result: { text: 'Run complete.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test integrity'], { phases });
  assert.equal(r.code, 0, r.stderr);

  const records = r.traceRecords();
  const pinChecks = records.filter((rec) => rec.kind === 'pin_check');

  assert.equal(pinChecks.length, 1, 'exactly one pin_check event');
  const evt = pinChecks[0];
  assert.equal(evt.piece, 'P2', 'piece must be P2 from the most recent round marker');
  assert.equal(evt.round, 3, 'round must be 3 from the most recent round marker');
});

/* -------------------------------------------------------------------------- */
/* Criterion 7: failed integrity check visible in default output              */
/* -------------------------------------------------------------------------- */

test('Criterion 7: failed gate check visible in default output', () => {
  // A failed integrity check must show the gate name in the run's output.
  const phases = [
    {
      messages: [
        OPENING,
        '@exolvra-genesis integrity gate | bar-sha256 | fail | hash mismatch detected',
        round('P1', 1, 'LOSS', 'integrity failed'),
      ],
      state: 'stopped',
      result: { text: 'Run stopped.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test integrity'], { phases });
  assert.equal(r.code, 1, 'loss should exit 1');

  const combined = r.stdout + r.stderr;
  assert.match(combined, /bar-sha256/, 'failed gate check must name the gate in output');
});

test('Criterion 7: failed gate check produces exactly one gate_check event (warning, not duplicate error_path)', () => {
  // The failed check notice is at warning level, so it must NOT create an error_path.
  // A stopped run naturally creates one error_path ("the run was stopped"), so we verify
  // exactly one exists and its detail is NOT about the integrity check.
  const phases = [
    {
      messages: [
        OPENING,
        '@exolvra-genesis integrity gate | bar-sha256 | fail | hash mismatch',
        round('P1', 1, 'LOSS', 'integrity failed'),
      ],
      state: 'stopped',
      result: { text: 'Run stopped.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test integrity'], { phases });
  assert.equal(r.code, 1, 'loss should exit 1');

  const records = r.traceRecords();
  const gateChecks = records.filter((rec) => rec.kind === 'gate_check');
  const errorPaths = records.filter((rec) => rec.kind === 'error_path');

  assert.equal(gateChecks.length, 1, 'exactly one gate_check event');
  assert.equal(gateChecks[0].payload.passed, false, 'gate_check must have passed=false');
  // The stopped run has exactly one error_path from the normal finish path. If the
  // integrity warning were at error level, there would be two. We check that none
  // of the error_path events mention the gate name.
  assert.equal(errorPaths.length, 1, 'exactly one error_path from the stopped finish');
  const integrityErrorPaths = errorPaths.filter((rec) => rec.payload.detail.includes('bar-sha256'));
  assert.equal(integrityErrorPaths.length, 0, 'no error_path events from the integrity warning');
});

test('Criterion 7: failed pin check visible in default output', () => {
  // Same as gate, but for pin checks.
  const phases = [
    {
      messages: [
        OPENING,
        '@exolvra-genesis integrity pin | spec-file | fail | file was modified',
        round('P1', 1, 'LOSS', 'integrity failed'),
      ],
      state: 'stopped',
      result: { text: 'Run stopped.', costUsd: 0.1 },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test integrity'], { phases });
  assert.equal(r.code, 1, 'loss should exit 1');

  const combined = r.stdout + r.stderr;
  assert.match(combined, /spec-file/, 'failed pin check must name the pin in output');
});
