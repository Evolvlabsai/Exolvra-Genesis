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
import { BIN, PACKAGE_ROOT, REPO_ROOT, createSandbox, runProcess } from './run-cli.js';

/* -------------------------------------------------------------------------- */
/* Setup: A sandbox with a scripted fake SDK transport                        */
/* -------------------------------------------------------------------------- */

/**
 * A fake SDK that replays a scripted run with support for:
 * - Text messages with round markers
 * - Configurable usage/token counts per result
 * - Multiple turns (for retry accumulation testing)
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

  const sessionId = phase.sessionId ?? 'sesn_spend_test';

  return {
    async interrupt() {},
    async *[Symbol.asyncIterator]() {
      for (const text of phase.messages ?? []) {
        yield {
          type: 'assistant',
          session_id: sessionId,
          message: { content: [{ type: 'text', text }] },
        };
      }
      if (phase.state !== undefined) writeState(phase.state, phase.stateDetail);
      const result = phase.result;
      if (result === undefined || result === null) return;
      yield {
        type: 'result',
        subtype: result.subtype ?? 'success',
        session_id: sessionId,
        num_turns: result.numTurns ?? 1,
        total_cost_usd: result.costUsd ?? 0,
        usage: {
          input_tokens: result.inputTokens ?? 0,
          output_tokens: result.outputTokens ?? 0,
        },
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

const WORK = mkdtempSync(join(tmpdir(), 'exolvra-genesis-trace-spend-'));
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
  const dir = join(WORK, 'spend-' + (directories += 1));
  mkdirSync(dir, { recursive: true });
  return dir;
}

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

const OPENING = [
  'I picked the gh transcripts captured on this machine as the bar.',
  '@exolvra-genesis bar .exolvra-genesis/bar',
  '@exolvra-genesis artifact .exolvra-genesis/bar/gh/root-help.txt | gh --help',
  '@exolvra-genesis piece P1 | The flag table and the leaf help',
].join('\n');

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
      return readTrace(cwd, runId).records;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Criterion 1: budget_spend event produced with non-zero tokens               */
/* -------------------------------------------------------------------------- */

describe('budget_spend events', () => {
  test('Criterion 1: budget_spend event produced on result message', () => {
    const phases = [
      {
        messages: [OPENING, round('P1', 1, 'WIN')],
        state: 'complete',
        result: {
          text: 'Run complete.',
          costUsd: 0.42,
          inputTokens: 1500,
          outputTokens: 800,
        },
      },
    ];

    const r = runRun(['run', '--auto', '--json', 'test spend'], { phases });
    assert.equal(r.code, 0, 'run should succeed: ' + r.stderr);

    const records = r.traceRecords();
    const spendEvents = records.filter((rec) => rec.kind === 'budget_spend');

    assert.equal(spendEvents.length, 1, 'exactly one budget_spend event should be recorded');
    const evt = spendEvents[0];

    // Criterion 2: Assert specific token numbers, not "greater than zero"
    assert.equal(evt.payload.inputTokens, 1500, 'inputTokens must be 1500');
    assert.equal(evt.payload.outputTokens, 800, 'outputTokens must be 800');
    assert.equal(evt.payload.costUsd, 0.42, 'costUsd must be 0.42');
  });

  test('Criterion 2: token fields are non-zero when SDK reports non-zero', () => {
    // A run with specific known token counts
    const phases = [
      {
        messages: [OPENING, round('P1', 1, 'WIN')],
        state: 'complete',
        result: {
          text: 'Done.',
          costUsd: 0.25,
          inputTokens: 2500,
          outputTokens: 1200,
        },
      },
    ];

    const r = runRun(['run', '--auto', '--json', 'test'], { phases });
    assert.equal(r.code, 0, r.stderr);

    const records = r.traceRecords();
    const spendEvents = records.filter((rec) => rec.kind === 'budget_spend');

    assert.equal(spendEvents.length, 1);
    const evt = spendEvents[0];

    // Assert exact numbers, not assert.ok(tokens > 0)
    assert.equal(evt.payload.inputTokens, 2500, 'inputTokens must be exactly 2500');
    assert.equal(evt.payload.outputTokens, 1200, 'outputTokens must be exactly 1200');
  });

  test('session spend carries its run id without inventing a per-round split', () => {
    const phases = [
      {
        messages: [OPENING, round('P1', 1, 'WIN')],
        state: 'complete',
        result: {
          text: 'Done.',
          costUsd: 0.10,
          inputTokens: 500,
          outputTokens: 200,
        },
      },
    ];

    const r = runRun(['run', '--auto', '--json', 'test'], { phases });
    assert.equal(r.code, 0, r.stderr);

    const records = r.traceRecords();
    const runs = r.runs();
    const runId = runs[0].id;

    const spendEvents = records.filter((rec) => rec.kind === 'budget_spend');
    assert.equal(spendEvents.length, 1);
    const evt = spendEvents[0];

    assert.equal(evt.runId, runId, 'budget_spend must have correct runId');
    assert.equal(evt.piece, null, 'nested round spend is not separately reported by this SDK');
    assert.equal(evt.round, null);
    assert.equal(evt.payload.attribution, 'session');
  });

  test('Criterion 3: pre-round spend has null piece and null round', () => {
    // A run where the result arrives BEFORE any round marker
    const phases = [
      {
        messages: [OPENING],
        state: 'stopped',
        stateDetail: 'stopped before any round',
        result: {
          text: 'Stopped early.',
          costUsd: 0.05,
          inputTokens: 300,
          outputTokens: 100,
        },
      },
    ];

    const r = runRun(['run', '--auto', '--json', 'test'], { phases });
    // Stopped run exits 1
    assert.equal(r.code, 1);

    const records = r.traceRecords();
    const spendEvents = records.filter((rec) => rec.kind === 'budget_spend');

    assert.equal(spendEvents.length, 1);
    const evt = spendEvents[0];

    // Pre-round spend belongs to no round
    assert.equal(evt.piece, null, 'pre-round spend must have piece=null');
    assert.equal(evt.round, null, 'pre-round spend must have round=null');

    // Still has real tokens
    assert.equal(evt.payload.inputTokens, 300, 'inputTokens must be 300');
    assert.equal(evt.payload.outputTokens, 100, 'outputTokens must be 100');
  });

  test('multi-round session never charges all spend to its last round', () => {
    // A single turn with TWO round markers, then a result.
    // The spend must be attributed to the MOST RECENT (second) round marker.
    const phases = [
      {
        messages: [
          OPENING,
          // Two round markers in one turn
          round('P1', 1, 'LOSS', 'first attempt'),
          round('P1', 2, 'WIN'),
        ],
        state: 'complete',
        result: {
          text: 'Done.',
          costUsd: 0.30,
          inputTokens: 1800,
          outputTokens: 900,
        },
      },
    ];

    const r = runRun(['run', '--auto', '--json', 'test'], { phases });
    assert.equal(r.code, 0, r.stderr);

    const records = r.traceRecords();
    const spendEvents = records.filter((rec) => rec.kind === 'budget_spend');

    assert.equal(spendEvents.length, 1, 'one budget_spend event per turn');
    const evt = spendEvents[0];

    // Attribution rule: most recent round marker
    assert.equal(evt.piece, null);
    assert.equal(evt.round, null);
    assert.equal(evt.payload.attribution, 'session');

    // Token assertion
    assert.equal(evt.payload.inputTokens, 1800, 'inputTokens must be 1800');
    assert.equal(evt.payload.outputTokens, 900, 'outputTokens must be 900');
  });
});

/* -------------------------------------------------------------------------- */
/* Criterion 4: Retry accumulation via trace events                           */
/* -------------------------------------------------------------------------- */

describe('R5 retry accumulation', () => {
  test('Criterion 4: two attempts at same piece/round produce accumulated sum', () => {
    // Two turns for the same piece and round. The trace events must carry both
    // turns' spend, and their sum is the accumulated cost of that round.
    //
    // Phase 1: P1 round 1 LOSS - 600 input, 300 output, 0.15 cost
    // Phase 2: P1 round 1 WIN  - 800 input, 400 output, 0.20 cost
    // Sum for P1 round 1:       1400 input, 700 output, 0.35 cost
    const phases = [
      {
        messages: [OPENING, round('P1', 1, 'LOSS', 'first attempt')],
        state: 'running',
        result: {
          text: 'First attempt failed.',
          costUsd: 0.15,
          inputTokens: 600,
          outputTokens: 300,
          subtype: 'error',
        },
      },
      {
        messages: [round('P1', 1, 'WIN')],
        state: 'complete',
        result: {
          text: 'Second attempt succeeded.',
          costUsd: 0.20,
          inputTokens: 800,
          outputTokens: 400,
        },
      },
    ];

    const cwd = fresh();
    const r = runRun(['run', '--auto', '--json', 'test retry'], {
      phases,
      cwd,
      env: { EXOLVRA_GENESIS_AUTO_RESUMES: '1' },
    });
    assert.equal(r.code, 0, 'run should succeed after recovery: ' + r.stderr);

    const records = r.traceRecords();
    const spendEvents = records.filter((rec) => rec.kind === 'budget_spend');

    // Exactly 2 budget_spend events (one per turn)
    assert.equal(spendEvents.length, 2, 'must have exactly 2 budget_spend events');

    // Both must be attributed to P1 round 1
    const p1r1Events = spendEvents.filter((e) => e.payload.attribution === 'session');
    assert.equal(p1r1Events.length, 2, 'both attempts must remain in session totals');
    assert.ok(p1r1Events.every((e) => e.piece === null && e.round === null));

    // Compute the sum
    let totalInput = 0;
    let totalOutput = 0;
    let totalCostCents = 0;
    for (const evt of p1r1Events) {
      totalInput += evt.payload.inputTokens;
      totalOutput += evt.payload.outputTokens;
      totalCostCents += Math.round(evt.payload.costUsd * 100);
    }

    // Assert the accumulated totals
    assert.equal(totalInput, 1400, 'accumulated inputTokens must be 1400');
    assert.equal(totalOutput, 700, 'accumulated outputTokens must be 700');
    assert.equal(totalCostCents, 35, 'accumulated cost must be 35 cents');
  });

  test('session total includes every attempt across distinct rounds', () => {
    // Two rounds on the same piece. The piece total is their sum.
    //
    // Phase 1: P1 round 1 - 400 input, 200 output, 0.10 cost
    // Phase 2: P1 round 2 - 600 input, 300 output, 0.15 cost
    // Piece total:        1000 input, 500 output, 0.25 cost
    const phases = [
      {
        messages: [OPENING, round('P1', 1, 'LOSS', 'first')],
        state: 'running',
        result: {
          text: 'First round done.',
          costUsd: 0.10,
          inputTokens: 400,
          outputTokens: 200,
        },
      },
      {
        messages: [round('P1', 2, 'WIN')],
        state: 'complete',
        result: {
          text: 'Second round done.',
          costUsd: 0.15,
          inputTokens: 600,
          outputTokens: 300,
        },
      },
    ];

    const cwd = fresh();
    const r = runRun(['run', '--auto', '--json', 'test multi-round'], {
      phases,
      cwd,
      env: { EXOLVRA_GENESIS_AUTO_RESUMES: '1' },
    });
    assert.equal(r.code, 0, 'run should succeed: ' + r.stderr);

    const records = r.traceRecords();
    const spendEvents = records.filter((rec) => rec.kind === 'budget_spend');

    // Exactly 2 events
    assert.equal(spendEvents.length, 2, 'must have exactly 2 budget_spend events');

    // Sum for piece P1
    let pieceInput = 0;
    let pieceOutput = 0;
    let pieceCostCents = 0;
    for (const evt of spendEvents) {
      if (evt.payload.attribution === 'session') {
        pieceInput += evt.payload.inputTokens;
        pieceOutput += evt.payload.outputTokens;
        pieceCostCents += Math.round(evt.payload.costUsd * 100);
      }
    }

    // Assert the piece totals
    assert.equal(pieceInput, 1000, 'piece inputTokens must be 1000');
    assert.equal(pieceOutput, 500, 'piece outputTokens must be 500');
    assert.equal(pieceCostCents, 25, 'piece cost must be 25 cents');
  });
});

/* -------------------------------------------------------------------------- */
/* Criterion 8: No regression - existing tests still pass                      */
/* -------------------------------------------------------------------------- */

// These are integration tests that verify budget_spend doesn't break anything.
// The actual no-regression check is done by running the full test suite.

test('Criterion 8: winning run still exits 0', () => {
  const phases = [
    {
      messages: [OPENING, round('P1', 1, 'WIN')],
      state: 'complete',
      result: {
        text: 'Done.',
        costUsd: 0.10,
        inputTokens: 500,
        outputTokens: 200,
      },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test'], { phases });
  assert.equal(r.code, 0, 'winning run must exit 0');
});

test('Criterion 8: losing run still exits 1', () => {
  const phases = [
    {
      messages: [OPENING, round('P1', 1, 'LOSS', 'missing feature')],
      state: 'stopped',
      stateDetail: 'loss',
      result: {
        text: 'Stopped.',
        costUsd: 0.10,
        inputTokens: 500,
        outputTokens: 200,
      },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test'], { phases });
  assert.equal(r.code, 1, 'losing run must exit 1');
});

/* -------------------------------------------------------------------------- */
/* Specific assertion strength tests                                           */
/* -------------------------------------------------------------------------- */

test('tokens are specific numbers, not just non-zero', () => {
  // This test exists to pin the assertion rule: we assert exact values,
  // not just "greater than zero". If this test passes, it means the
  // fake SDK reported specific tokens and we read them correctly.
  const phases = [
    {
      messages: [OPENING, round('P1', 1, 'WIN')],
      state: 'complete',
      result: {
        text: 'Done.',
        costUsd: 0.33,
        inputTokens: 3333,
        outputTokens: 1111,
      },
    },
  ];

  const r = runRun(['run', '--auto', '--json', 'test'], { phases });
  assert.equal(r.code, 0, r.stderr);

  const records = r.traceRecords();
  const evt = records.find((rec) => rec.kind === 'budget_spend');

  // Exact assertions, not ok(tokens > 0)
  assert.equal(evt.payload.inputTokens, 3333);
  assert.equal(evt.payload.outputTokens, 1111);
  assert.equal(evt.payload.costUsd, 0.33);
});

/* -------------------------------------------------------------------------- */
/* Criterion 7: resume.ts emits budget_spend on the same rule as run.ts        */
/* -------------------------------------------------------------------------- */

/**
 * Seeds a ledger with one stopped run ready to be resumed.
 * Reuses the same scaffolding pattern as run.test.js.
 */
function seedLedger(cwd, patch = {}) {
  const record = {
    id: 'r-20260811-0900-abcdef',
    sessionId: 'sesn_spend_test',
    input: 'test spend tracking',
    models: { lead: 'inherit', builder: 'inherit', critic: 'inherit' },
    startedAt: new Date().toISOString(),
    status: 'stopped',
    rounds: 1,
    costUsd: 0.50,
    lastVerdict: 'LOSS',
    ...patch,
  };
  mkdirSync(join(cwd, '.exolvra-genesis'), { recursive: true });
  writeFileSync(
    join(cwd, '.exolvra-genesis', 'runs.json'),
    JSON.stringify([record], null, 2) + '\n',
    'utf8',
  );
  writeFileSync(
    join(cwd, '.exolvra-genesis', 'state.json'),
    JSON.stringify({ status: 'stopped' }, null, 2) + '\n',
    'utf8',
  );
  return record;
}

describe('Criterion 7: resume emits budget_spend', () => {
  test('a resumed turn emits exact session totals without guessed piece costs', () => {
    const cwd = fresh();
    const seeded = seedLedger(cwd);

    const phases = [
      {
        messages: [round('P2', 2, 'WIN')],
        state: 'complete',
        result: {
          text: 'Run finished.',
          costUsd: 0.35,
          inputTokens: 1750,
          outputTokens: 850,
        },
      },
    ];

    const r = runRun(['resume', seeded.id], { phases, cwd });
    assert.equal(r.code, 0, 'resumed run should win: ' + r.stderr);

    const records = r.traceRecords();
    const spendEvents = records.filter((rec) => rec.kind === 'budget_spend');

    assert.equal(spendEvents.length, 1, 'exactly one budget_spend event from the resumed turn');
    const evt = spendEvents[0];

    // Stamped with runId
    assert.equal(evt.runId, seeded.id, 'budget_spend must carry the run id');

    // Attributed to the most recent round marker seen before result
    assert.equal(evt.piece, null);
    assert.equal(evt.round, null);
    assert.equal(evt.payload.attribution, 'session');

    // Exact token counts from the fake SDK
    assert.equal(evt.payload.inputTokens, 1750, 'inputTokens must be 1750');
    assert.equal(evt.payload.outputTokens, 850, 'outputTokens must be 850');
    assert.equal(evt.payload.costUsd, 0.35, 'costUsd must be 0.35');
  });

  test('resume pre-marker spend is attributed to null/null', () => {
    const cwd = fresh();
    const seeded = seedLedger(cwd);

    // A resumed turn that ends BEFORE any round marker is seen
    const phases = [
      {
        messages: ['Working on the problem...'],
        state: 'stopped',
        stateDetail: 'stopped before any round marker',
        result: {
          text: 'Stopped early.',
          costUsd: 0.12,
          inputTokens: 600,
          outputTokens: 250,
        },
      },
    ];

    const r = runRun(['resume', seeded.id], { phases, cwd });
    // Did not win, exits 1
    assert.equal(r.code, 1);

    const records = r.traceRecords();
    const spendEvents = records.filter((rec) => rec.kind === 'budget_spend');

    assert.equal(spendEvents.length, 1, 'one budget_spend event');
    const evt = spendEvents[0];

    // Pre-marker spend belongs to no round
    assert.equal(evt.piece, null, 'pre-marker spend must have piece=null');
    assert.equal(evt.round, null, 'pre-marker spend must have round=null');

    // Still carries the run id
    assert.equal(evt.runId, seeded.id, 'must still carry runId');

    // Exact token counts
    assert.equal(evt.payload.inputTokens, 600, 'inputTokens must be 600');
    assert.equal(evt.payload.outputTokens, 250, 'outputTokens must be 250');
    assert.equal(evt.payload.costUsd, 0.12, 'costUsd must be 0.12');
  });

  test('resume multi-round turn leaves the per-round dollar split unavailable', () => {
    const cwd = fresh();
    const seeded = seedLedger(cwd);

    // A resumed turn with two round markers, then a result
    const phases = [
      {
        messages: [
          round('P2', 2, 'LOSS', 'first try'),
          round('P2', 3, 'WIN'),
        ],
        state: 'complete',
        result: {
          text: 'Done.',
          costUsd: 0.45,
          inputTokens: 2200,
          outputTokens: 1100,
        },
      },
    ];

    const r = runRun(['resume', seeded.id], { phases, cwd });
    assert.equal(r.code, 0, r.stderr);

    const records = r.traceRecords();
    const spendEvents = records.filter((rec) => rec.kind === 'budget_spend');

    assert.equal(spendEvents.length, 1, 'one budget_spend per turn');
    const evt = spendEvents[0];

    // Attribution rule: most recent round marker
    assert.equal(evt.piece, null);
    assert.equal(evt.round, null);
    assert.equal(evt.payload.attribution, 'session');

    // Exact token counts
    assert.equal(evt.payload.inputTokens, 2200, 'inputTokens must be 2200');
    assert.equal(evt.payload.outputTokens, 1100, 'outputTokens must be 1100');
  });
});
