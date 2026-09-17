import { PREFLIGHT_FAKE } from './preflight-fake.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { TRACE_EVENT_KINDS, toRecord } from '../dist/trace-events.js';
import { readRuns, runsPath, readState, statePath } from '../dist/runs-store.js';
import { BIN, PACKAGE_ROOT, REPO_ROOT, createSandbox, runProcess, answerFile, planAnswer, SAMPLE_PLAN } from './run-cli.js';

/* -------------------------------------------------------------------------- */
/* Setup: A sandbox with a scripted fake SDK transport                        */
/* -------------------------------------------------------------------------- */

/**
 * A fake SDK that replays a scripted run with support for:
 * - Text messages
 * - tool_use/tool_result blocks for subagent dispatch testing
 * - Mid-run trace observation (reads trace from disk between yields)
 * - State file writing
 */
const FAKE_SDK = `import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Which turn of the run this is. One process, one counter. */
let phaseIndex = 0;

/**
 * Reads the trace from disk mid-run to observe what events exist at this moment.
 * Returns { records: [], processes: [] } where records are events and processes are process rows.
 */
function readTraceMidRun(cwd) {
  const runId = JSON.parse(readFileSync(join(cwd, '.exolvra-genesis', 'runs.json'), 'utf8')).at(-1).id;
  const traceDir = join(cwd, '.exolvra-genesis', 'runs', runId, 'trace');
  if (!existsSync(traceDir)) return { records: [], processes: [] };

  const files = readdirSync(traceDir);
  const records = [];
  const processMap = new Map();

  // Try NDJSON first
  for (const file of files) {
    if (file.endsWith('.ndjson')) {
      try {
        const content = readFileSync(join(traceDir, file), 'utf8');
        for (const line of content.split('\\n')) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'event' && parsed.data) {
              records.push(parsed.data);
            } else if (parsed.type === 'process' && parsed.data) {
              // Process rows: later entries for same taskId override earlier ones
              processMap.set(parsed.data.taskId, parsed.data);
            }
          } catch {}
        }
      } catch {}
    }
  }

  return { records, processes: Array.from(processMap.values()) };
}

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

  // A provider that never starts
  if (phase.fail === 'start') {
    throw new Error('Failed to spawn Claude Code process: spawn node ENOENT');
  }

  // A provider that fails mid-stream (SDK fault) - no content first
  if (phase.fail === 'midstream') {
    return {
      async interrupt() {},
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          session_id: phase.sessionId ?? 'sesn_trace_test',
          message: { content: [{ type: 'text', text: 'Starting work...' }] },
        };
        throw new Error('SDK stream fault');
      },
    };
  }

  // A provider that yields content THEN fails mid-stream
  // This allows tool_use blocks to be processed before the fault
  if (phase.fail === 'midstream_after_content') {
    const sessionId = phase.sessionId ?? 'sesn_trace_test';
    return {
      async interrupt() {},
      async *[Symbol.asyncIterator]() {
        // Yield all content items first
        if (phase.content !== undefined) {
          for (const item of phase.content) {
            yield {
              type: 'assistant',
              session_id: sessionId,
              message: { content: item.blocks ?? [{ type: 'text', text: item.text ?? '' }] },
            };
          }
        }
        // Then fault
        throw new Error('SDK stream fault');
      },
    };
  }

  // A provider that yields content THEN throws a TypeError (programmer fault)
  // TypeErrors are not caught by recovery - they propagate as uncaught exceptions
  // and trigger finalize('failed') via the outer exception handler
  if (phase.fail === 'programmer_fault_after_content') {
    const sessionId = phase.sessionId ?? 'sesn_trace_test';
    return {
      async interrupt() {},
      async *[Symbol.asyncIterator]() {
        // Yield all content items first (including tool_use to open processes)
        if (phase.content !== undefined) {
          for (const item of phase.content) {
            yield {
              type: 'assistant',
              session_id: sessionId,
              message: { content: item.blocks ?? [{ type: 'text', text: item.text ?? '' }] },
            };
          }
        }
        // Then throw a TypeError - this is a "programmer fault" that escapes recovery
        throw new TypeError('simulated programmer fault');
      },
    };
  }

  const sessionId = phase.sessionId ?? 'sesn_trace_test';
  let release = () => {};
  const held = new Promise((resolve) => {
    release = resolve;
  });

  return {
    async interrupt() {
      release();
    },
    async *[Symbol.asyncIterator]() {
      // Yield each content item in the phase
      // If phase.content is provided, use it (supports tool_use/tool_result)
      // Otherwise fall back to phase.messages (text-only)
      if (phase.content !== undefined) {
        for (const item of phase.content) {
          yield {
            type: item.messageType ?? 'assistant',
            session_id: sessionId,
            message: { content: item.blocks ?? [{ type: 'text', text: item.text ?? '' }] },
          };
          // Mid-run observation: read the trace and write findings to a marker file
          if (item.midRunObserve !== undefined) {
            const trace = readTraceMidRun(options.cwd);
            const verdicts = trace.records.filter(r => r.kind === 'verdict_recorded');
            const markerFile = join(options.cwd, '.exolvra-genesis', 'mid-run-observation.json');
            mkdirSync(dirname(markerFile), { recursive: true });
            writeFileSync(markerFile, JSON.stringify({
              afterRound: item.midRunObserve.afterRound,
              verdictsFound: verdicts.map(v => ({ round: v.round, piece: v.piece })),
              totalRecords: trace.records.length,
              // Include process state for R2 (criterion 3) testing
              processes: trace.processes.map(p => ({
                taskId: p.taskId,
                role: p.role,
                closedAt: p.closedAt,
                outcome: p.outcome,
              })),
            }), 'utf8');
          }
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
      if (phase.hold === true) {
        await held;
        return;
      }
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
 * Needed so the run command can find @clack/prompts.
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

const WORK = mkdtempSync(join(tmpdir(), 'exolvra-genesis-trace-wiring-'));
const sandbox = createSandbox();
linkDependencies(sandbox.root);
// Install the scripted fake SDK
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

/** A directory of its own for one test. */
function fresh() {
  const dir = join(WORK, 'wiring-' + (directories += 1));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** One assistant message carrying a round marker. */
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

/** The opening message of a run: the bar, its artifacts, and the pieces. */
const OPENING = [
  'I picked the gh transcripts captured on this machine as the bar.',
  '@exolvra-genesis bar .exolvra-genesis/bar',
  '@exolvra-genesis artifact .exolvra-genesis/bar/gh/root-help.txt | gh --help',
  '@exolvra-genesis piece P1 | The flag table and the leaf help',
  '@exolvra-genesis piece P2 | The exit-code contract',
].join('\n');

/** A run that judges three rounds and finishes complete. */
const WINNING_RUN = [
  {
    messages: [OPENING, round('P1', 1, 'LOSS', 'the flag table omits defaults'), round('P1', 2, 'WIN'), round('P2', 1, 'WIN')],
    state: 'complete',
    result: { text: 'Both pieces won twice in a row.', costUsd: 0.42 },
  },
];

/** A run that ends in loss. */
const LOSING_RUN = [
  {
    messages: [OPENING, round('P1', 1, 'LOSS', 'missing feature')],
    state: 'stopped',
    stateDetail: 'the run ended without reaching completion',
    result: { text: 'Stopped after max rounds.', costUsd: 0.10 },
  },
];

/** A run with subagent dispatch (builder and critic). */
const SUBAGENT_RUN = [
  {
    content: [
      { text: OPENING },
      // Builder dispatch
      {
        blocks: [
          { type: 'text', text: 'Dispatching builder for P1...' },
          {
            type: 'tool_use',
            id: 'toolu_builder_p1_r1',
            name: 'Task',
            input: { agent: 'exolvra-genesis-builder', prompt: 'Build piece P1' },
          },
        ],
      },
      // Builder result
      {
        blocks: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_builder_p1_r1',
            is_error: false,
          },
          { type: 'text', text: 'Builder completed.' },
        ],
      },
      // Critic dispatch
      {
        blocks: [
          { type: 'text', text: 'Dispatching critic...' },
          {
            type: 'tool_use',
            id: 'toolu_critic_p1_r1',
            name: 'Task',
            input: { agent: 'exolvra-genesis-critic', prompt: 'Judge this work' },
          },
        ],
      },
      // Critic result
      {
        blocks: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_critic_p1_r1',
            is_error: false,
          },
          { type: 'text', text: round('P1', 1, 'WIN') },
        ],
      },
    ],
    state: 'complete',
    result: { text: 'Run complete.', costUsd: 0.25 },
  },
];

/**
 * A run that fails with SDK fault (for testing finalize 'failed').
 * Includes a builder dispatch that will be left open when the fault occurs.
 * finalize('failed') will close this process with outcome 'failed'.
 *
 * Uses 'programmer_fault_after_content' which throws a TypeError - this is
 * classified as a "programmer fault" and escapes the recovery logic, triggering
 * finalize('failed') via the outer exception handler in run.ts.
 *
 * A regular stream fault (midstream_after_content) goes through recovery and
 * ends with finalize('complete') via finish(BLOCKED).
 */
const SDK_FAULT_RUN = [
  {
    content: [
      { text: OPENING },
      // Dispatch a builder that will never get a tool_result
      {
        blocks: [
          { type: 'text', text: 'Dispatching builder...' },
          {
            type: 'tool_use',
            id: 'toolu_builder_orphan',
            name: 'Task',
            input: { agent: 'exolvra-genesis-builder', prompt: 'Build' },
          },
        ],
      },
    ],
    // TypeError is a "programmer fault" that escapes recovery
    fail: 'programmer_fault_after_content',
    sessionId: 'sesn_fault_test',
  },
];

/**
 * A run with a process left open for finalize to close.
 * This tests that finalize('complete') actually sets the outcome.
 * The builder is dispatched but never receives a tool_result.
 */
const WINNING_RUN_WITH_ORPHAN_PROCESS = [
  {
    content: [
      { text: OPENING },
      { text: round('P1', 1, 'WIN') },
      { text: round('P1', 2, 'WIN') },
      // Dispatch a builder that will be left open (no tool_result follows)
      {
        blocks: [
          { type: 'text', text: 'Final dispatch (will be closed by finalize)' },
          {
            type: 'tool_use',
            id: 'toolu_orphan_for_finalize',
            name: 'Task',
            input: { agent: 'exolvra-genesis-builder', prompt: 'Final work' },
          },
        ],
      },
    ],
    state: 'complete',
    result: { text: 'Run complete.', costUsd: 0.25 },
  },
];

/**
 * A losing run with a process left open for finalize to close.
 * finalize('complete') should close this process (normal ending = complete).
 */
const LOSING_RUN_WITH_ORPHAN_PROCESS = [
  {
    content: [
      { text: OPENING },
      { text: round('P1', 1, 'LOSS', 'missing feature') },
      // Dispatch a builder that will be left open
      {
        blocks: [
          {
            type: 'tool_use',
            id: 'toolu_loss_orphan',
            name: 'Task',
            input: { agent: 'exolvra-genesis-builder', prompt: 'Build' },
          },
        ],
      },
    ],
    state: 'stopped',
    stateDetail: 'loss',
    result: { text: 'Stopped.', costUsd: 0.1 },
  },
];

/**
 * A run with mid-run process observation for criterion 3.
 * Builder is dispatched, then tool_result arrives and closes it.
 * Mid-run observation happens AFTER the tool_result to verify closeProcess worked.
 * A second builder is dispatched but no tool_result - still open at observation.
 */
const PROCESS_CLOSE_OBSERVATION_RUN = [
  {
    content: [
      { text: OPENING },
      // First builder dispatch
      {
        blocks: [
          {
            type: 'tool_use',
            id: 'toolu_builder_closed',
            name: 'Task',
            input: { agent: 'exolvra-genesis-builder', prompt: 'Build P1' },
          },
        ],
      },
      // First builder result - this should close the process via closeProcess
      {
        blocks: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_builder_closed',
            is_error: false,
          },
          { type: 'text', text: 'Builder completed.' },
        ],
      },
      // Second builder dispatch - will be left open
      {
        blocks: [
          {
            type: 'tool_use',
            id: 'toolu_builder_open',
            name: 'Task',
            input: { agent: 'exolvra-genesis-builder', prompt: 'Build P2' },
          },
        ],
      },
      // Mid-run observation: first builder should be closed, second should be open
      { text: round('P1', 1, 'WIN'), midRunObserve: { afterRound: 1 } },
    ],
    state: 'complete',
    result: { text: 'Done.', costUsd: 0.1 },
  },
];

/**
 * A run with a failed builder for mid-run observation.
 * The builder fails (is_error: true) and should be closed with outcome 'failed'.
 */
const FAILED_BUILDER_OBSERVATION_RUN = [
  {
    content: [
      { text: OPENING },
      // Builder dispatch
      {
        blocks: [
          {
            type: 'tool_use',
            id: 'toolu_builder_fails',
            name: 'Task',
            input: { agent: 'exolvra-genesis-builder', prompt: 'Build' },
          },
        ],
      },
      // Builder fails
      {
        blocks: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_builder_fails',
            is_error: true,
          },
          { type: 'text', text: 'Builder failed.' },
        ],
      },
      // Observe immediately after the failure
      { text: round('P1', 1, 'LOSS', 'builder failed'), midRunObserve: { afterRound: 1 } },
    ],
    state: 'stopped',
    stateDetail: 'loss',
    result: { text: 'Done.', costUsd: 0.1 },
  },
];

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
      return readTrace(cwd, runId).records;
    },
    traceProcesses: () => {
      const runs = JSON.parse(readFileSync(join(cwd, '.exolvra-genesis', 'runs.json'), 'utf8'));
      const runId = runs[0].id;
      const store = openTrace(cwd, runId, () => {});
      const procs = store.processes();
      store.close();
      return procs;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The nine event kinds this scenario produces (stated coverage)               */
/* -------------------------------------------------------------------------- */

/**
 * The nine event kinds produced by this test scenario (SUBAGENT_RUN):
 * - run_started: emitted when the run begins
 * - run_finished: emitted when the run ends
 * - piece_dispatched: one per piece when the plan is reported
 * - verdict_recorded: one per judged round
 * - builder_round_started: when a builder Task dispatch is observed
 * - builder_round_ended: when the builder Task result arrives
 * - critic_dispatched: when a critic Task dispatch is observed
 * - process_event: R2 process rows (opened/closed on Task dispatch/completion)
 * - budget_spend: emitted on result message with cost/token data
 *
 * The three kinds NOT produced by this scenario (no triggering conditions):
 * - gate_check: requires @exolvra-genesis integrity gate marker
 * - pin_check: requires @exolvra-genesis integrity pin marker
 * - error_path: requires error-level notice or SDK exception
 */
const PRODUCED_KINDS = [
  'run_started',
  'run_finished',
  'piece_dispatched',
  'verdict_recorded',
  'builder_round_started',
  'builder_round_ended',
  'critic_dispatched',
  'process_event',
  'budget_spend',
  'gate_check',
  'activity',
];

const NOT_PRODUCED_KINDS = {
  pin_check: 'requires integrity marker (not in this scenario)',
  error_path: 'requires error notice (not in this scenario)',
};

/* -------------------------------------------------------------------------- */
/* Criterion 1: Event kinds produced by real runs                              */
/* -------------------------------------------------------------------------- */

/**
 * This scenario produces nine event kinds.
 *
 * SABOTAGE: Delete the verdict_recorded case from appendTraceEvent. This test
 * will fail naming 'verdict_recorded' as absent.
 */
test('Criterion 1: this scenario produces nine event kinds', () => {
  const r = runRun(['run', '--auto', '--json', 'a CLI indistinguishable from gh'], {
    phases: SUBAGENT_RUN,
  });
  assert.equal(r.code, 0, 'run should exit 0: ' + r.stderr);

  const records = r.traceRecords();
  const kindsFound = new Set(records.map((rec) => rec.kind));

  // Assert the nine kinds this scenario produces are present
  for (const kind of PRODUCED_KINDS) {
    assert.ok(kindsFound.has(kind), kind + ' must be present in trace from real run');
  }

  // Verify the three kinds not produced by this scenario are absent
  for (const [kind, reason] of Object.entries(NOT_PRODUCED_KINDS)) {
    assert.ok(
      !kindsFound.has(kind),
      kind + ' should not be present (' + reason + ')'
    );
  }
});

/**
 * Each record has runId stamped.
 */
test('resume traces native SDK subagent fields, user tool results, verdicts and integrity checks', () => {
  const cwd = fresh();
  const initial = runRun(['run', '--auto', '--json', 'test'], { cwd, phases: [{ messages: [OPENING], state: 'stopped', result: { text: 'Stopped', costUsd: .1 } }] });
  assert.equal(initial.code, 1, initial.stderr);
  const id = initial.runs()[0].id;
  const metadata = '```genesis-task\n' + JSON.stringify({ piece: 'P7', round: 3, files: ['file'], verify: 'npm test' }) + '\n```';
  const resumed = runRun(['resume', id, '--json'], { cwd, phases: [{
    content: [
      { blocks: [{ type: 'tool_use', id: 'native-builder', name: 'Agent', input: { subagent_type: 'exolvra-genesis-builder', prompt: metadata } }] },
      { messageType: 'user', blocks: [{ type: 'tool_result', tool_use_id: 'native-builder', is_error: false, content: 'FILES CHANGED\n- file\nCOMMANDS RUN\n- npm test\nVERIFICATION\nTests: 1 passed\nexit code 0' }] },
      { text: round('P7', 3, 'WIN') + '\n@exolvra-genesis integrity gate | resumed-gate | pass | verified' },
    ], state: 'complete', result: { text: 'Done', costUsd: .2 },
  }] });
  assert.equal(resumed.code, 0, resumed.stderr);
  const events = resumed.traceRecords();
  for (const kind of ['builder_round_started', 'builder_round_ended', 'verdict_recorded']) {
    assert.ok(events.some((e) => e.kind === kind && e.piece === 'P7' && e.round === 3), kind);
  }
  assert.ok(events.some((e) => e.kind === 'gate_check' && e.payload.gate === 'resumed-gate' && e.piece === 'P7'));
  const worker = resumed.traceProcesses().find((p) => p.taskId === 'native-builder');
  assert.equal(worker.outcome, 'complete'); assert.ok(worker.closedAt !== null);
  assert.equal(events.filter((e) => e.kind === 'run_finished').length, 2);
  const ended = events.find((e) => e.kind === 'builder_round_ended' && e.piece === 'P7');
  assert.equal(ended.payload.verbatimVerification, true);
  assert.match(ended.payload.verificationOutput, /Tests: 1 passed/);
});

test('Criterion 1b: each record is stamped with runId', () => {
  const r = runRun(['run', '--auto', '--json', 'test'], { phases: WINNING_RUN });
  assert.equal(r.code, 0, r.stderr);

  const records = r.traceRecords();
  const runs = r.runs();
  const runId = runs[0].id;

  for (const rec of records) {
    assert.equal(rec.runId, runId, rec.kind + ' must have correct runId');
  }
});

/**
 * piece_dispatched and verdict_recorded records have piece field set.
 */
test('Criterion 1c: piece and round fields set where applicable', () => {
  const r = runRun(['run', '--auto', '--json', 'test'], { phases: WINNING_RUN });
  assert.equal(r.code, 0, r.stderr);

  const records = r.traceRecords();

  for (const rec of records.filter((r) => r.kind === 'piece_dispatched')) {
    assert.ok(rec.piece, 'piece_dispatched must have piece field');
  }

  for (const rec of records.filter((r) => r.kind === 'verdict_recorded')) {
    assert.ok(rec.piece, 'verdict_recorded must have piece field');
    assert.ok(typeof rec.round === 'number' && rec.round >= 1, 'verdict_recorded must have round');
  }
});

/* -------------------------------------------------------------------------- */
/* Criterion 2: Events appended as they happen (with absence half)             */
/* -------------------------------------------------------------------------- */

/**
 * Criterion 2: events are appended immediately, not batched.
 *
 * The fake SDK reads the trace from disk between yields and writes its findings
 * to a marker file. The test then verifies:
 * - Round 1's verdict_recorded WAS present at the mid-run observation point
 * - Round 2's verdict_recorded was NOT present at that point (the absence half)
 *
 * The absence half is what fails against a batched implementation: if events
 * were buffered until run end, the mid-run observation would find nothing.
 */
test('Criterion 2: events appended as they happen (absence half)', () => {
  // A run with two rounds on the same piece. After round 1's marker is yielded,
  // the fake SDK reads the trace and writes what it found to disk.
  const midRunPhases = [
    {
      content: [
        { text: OPENING },
        // After yielding round 1, observe the trace state
        { text: round('P1', 1, 'WIN'), midRunObserve: { afterRound: 1 } },
        // Round 2 comes later
        { text: round('P1', 2, 'WIN') },
      ],
      state: 'complete',
      result: { text: 'Done.', costUsd: 0.1 },
    },
  ];

  const cwd = fresh();

  // Force NDJSON engine so the fake SDK can read it
  const r = runRun(['run', '--auto', '--json', 'test'], {
    phases: midRunPhases,
    cwd,
    env: { EXOLVRA_GENESIS_TRACE_ENGINE: 'ndjson' },
  });
  assert.equal(r.code, 0, 'run must complete: ' + r.stderr);

  // Read the mid-run observation written by the fake SDK
  const observationPath = join(cwd, '.exolvra-genesis', 'mid-run-observation.json');
  assert.ok(existsSync(observationPath), 'mid-run observation file must exist');
  const observation = JSON.parse(readFileSync(observationPath, 'utf8'));

  // The observation was taken after round 1 was yielded (and processed)
  assert.equal(observation.afterRound, 1, 'observation was taken after round 1');

  // PRESENCE HALF: Round 1's verdict must have been present at observation time
  const round1AtMidRun = observation.verdictsFound.find((v) => v.round === 1);
  assert.ok(round1AtMidRun, 'round 1 verdict must be present at mid-run observation');

  // ABSENCE HALF: Round 2's verdict must NOT have been present at observation time
  // This is the critical assertion that fails against a batched implementation
  const round2AtMidRun = observation.verdictsFound.find((v) => v.round === 2);
  assert.ok(
    round2AtMidRun === undefined,
    'round 2 verdict must be ABSENT at mid-run observation (found: ' +
      JSON.stringify(observation.verdictsFound) + ')'
  );

  // Final check: both verdicts exist after the run completes
  const records = r.traceRecords();
  const verdicts = records.filter((rec) => rec.kind === 'verdict_recorded');
  assert.equal(verdicts.length, 2, 'both verdicts must exist after run completes');
});

/* -------------------------------------------------------------------------- */
/* Criterion 3: R2 - Process rows (mid-run observation)                        */
/* -------------------------------------------------------------------------- */

/**
 * R2: Process rows close on completion, observed MID-RUN.
 *
 * This is the critical test that distinguishes closeProcess from finalize.
 * finalize sweeps all open rows closed at the end of the run, so if we only
 * read after the run, we can't tell whether closeProcess did anything.
 *
 * The test uses mid-run observation (same mechanism as criterion 2):
 * - First builder is dispatched and gets a tool_result -> closeProcess closes it
 * - Second builder is dispatched but no tool_result yet -> still open
 * - Mid-run observation reads the trace and verifies:
 *   - First builder: closedAt !== null, outcome === 'complete'
 *   - Second builder: closedAt === null, outcome === null
 *
 * If closeProcess is neutered, the first builder will still be open at mid-run.
 */
test('Criterion 3 (R2): process rows close on completion (mid-run observation)', () => {
  const cwd = fresh();

  const r = runRun(['run', '--auto', '--json', 'test'], {
    phases: PROCESS_CLOSE_OBSERVATION_RUN,
    cwd,
    env: { EXOLVRA_GENESIS_TRACE_ENGINE: 'ndjson' },
  });
  assert.equal(r.code, 0, r.stderr);

  // Read the mid-run observation written by the fake SDK
  const observationPath = join(cwd, '.exolvra-genesis', 'mid-run-observation.json');
  assert.ok(existsSync(observationPath), 'mid-run observation file must exist');
  const observation = JSON.parse(readFileSync(observationPath, 'utf8'));

  // Find the processes in the mid-run observation
  const closedBuilder = observation.processes.find((p) => p.taskId === 'toolu_builder_closed');
  const openBuilder = observation.processes.find((p) => p.taskId === 'toolu_builder_open');

  // The closed builder must exist in the observation
  assert.ok(closedBuilder !== undefined, 'closed builder must be in mid-run observation');
  // The open builder must exist in the observation
  assert.ok(openBuilder !== undefined, 'open builder must be in mid-run observation');

  // CRITICAL: The closed builder must be CLOSED at mid-run (not just at end)
  // This is what fails when closeProcess is neutered
  assert.notEqual(closedBuilder.closedAt, null, 'closed builder must have closedAt at mid-run');
  assert.equal(closedBuilder.outcome, 'complete', 'closed builder must have outcome complete at mid-run');

  // ABSENCE HALF: The open builder must still be OPEN at mid-run
  assert.equal(openBuilder.closedAt, null, 'open builder must have closedAt null at mid-run');
  assert.equal(openBuilder.outcome, null, 'open builder must have outcome null at mid-run');
});

/**
 * R2: Failed subagent closes with outcome 'failed', observed MID-RUN.
 *
 * When a tool_result has is_error: true, closeProcess should set outcome 'failed'.
 * This is observed mid-run to distinguish from finalize.
 */
test('Criterion 3b (R2): failed subagent closes with failed outcome (mid-run)', () => {
  const cwd = fresh();

  const r = runRun(['run', '--auto', '--json', 'test'], {
    phases: FAILED_BUILDER_OBSERVATION_RUN,
    cwd,
    env: { EXOLVRA_GENESIS_TRACE_ENGINE: 'ndjson' },
  });
  assert.equal(r.code, 1, 'losing run exits 1');

  // Read the mid-run observation
  const observationPath = join(cwd, '.exolvra-genesis', 'mid-run-observation.json');
  assert.ok(existsSync(observationPath), 'mid-run observation file must exist');
  const observation = JSON.parse(readFileSync(observationPath, 'utf8'));

  // Find the failed builder in the mid-run observation
  const failedBuilder = observation.processes.find((p) => p.taskId === 'toolu_builder_fails');

  // It must exist
  assert.ok(failedBuilder !== undefined, 'failed builder must be in mid-run observation');

  // CRITICAL: Must be closed with outcome 'failed' at mid-run
  assert.notEqual(failedBuilder.closedAt, null, 'failed builder must be closed at mid-run');
  assert.equal(failedBuilder.outcome, 'failed', 'failed builder must have outcome failed at mid-run');
});

/* -------------------------------------------------------------------------- */
/* Criterion 4: R6 - trace failure never fails a run                          */
/* -------------------------------------------------------------------------- */

test('Criterion 4 (R6): trace failure never fails a run', () => {
  const dir = fresh();

  // Create a file where the trace directory should be - this makes it unwritable
  mkdirSync(join(dir, '.exolvra-genesis'), { recursive: true });
  writeFileSync(join(dir, '.exolvra-genesis', 'trace'), 'not a directory', 'utf8');

  const r = runRun(['run', '--auto', '--json', 'a test goal'], {
    phases: WINNING_RUN,
    cwd: dir,
  });

  // Run must still complete successfully (exit 0)
  assert.equal(r.code, 0, 'run must complete despite degraded trace: ' + r.stderr);

  // state.json must still be correct
  const state = r.state();
  assert.equal(state.status, 'complete');

  // stderr should contain a warning about the trace
  assert.ok(
    r.stderr.includes('trace') || r.stdout.includes('trace'),
    'should warn about trace issue'
  );
});

/* -------------------------------------------------------------------------- */
/* Criterion 5: C1 - nothing reads the trace to decide anything               */
/* -------------------------------------------------------------------------- */

test('Criterion 5 (C1): degraded trace produces identical run outcome', () => {
  // Run 1: normal run
  const dir1 = fresh();
  const r1 = runRun(['run', '--auto', '--json', 'a test goal'], {
    phases: WINNING_RUN,
    cwd: dir1,
  });
  assert.equal(r1.code, 0, r1.stderr);

  // Run 2: same run, but with trace directory blocked
  const dir2 = fresh();
  mkdirSync(join(dir2, '.exolvra-genesis'), { recursive: true });
  writeFileSync(join(dir2, '.exolvra-genesis', 'trace'), 'blocked', 'utf8');

  const r2 = runRun(['run', '--auto', '--json', 'a test goal'], {
    phases: WINNING_RUN,
    cwd: dir2,
  });
  assert.equal(r2.code, 0, r2.stderr);

  // Both runs must have same final state status
  const state1 = r1.state();
  const state2 = r2.state();
  assert.equal(state1.status, state2.status, 'state.json status must match');

  // Ledger records must have same status
  const runs1 = r1.runs();
  const runs2 = r2.runs();
  assert.equal(runs1[0].status, runs2[0].status, 'ledger status must match');
  assert.equal(runs1[0].rounds, runs2[0].rounds, 'ledger rounds must match');

  // Hash comparison for state.json (byte-identical)
  const hash1 = createHash('sha256').update(JSON.stringify({ ...state1, run: '<run>' })).digest('hex');
  const hash2 = createHash('sha256').update(JSON.stringify({ ...state2, run: '<run>' })).digest('hex');
  assert.equal(hash1, hash2, 'state.json must be byte-identical');
});

/* -------------------------------------------------------------------------- */
/* Criterion 6: Every exit path settles truthfully (finalized outcome)         */
/* -------------------------------------------------------------------------- */

/**
 * N3 property 6: Every exit path finalizes the trace.
 *
 * A winning run finalizes with 'complete'.
 * A losing run (that ended normally) also finalizes with 'complete'.
 * An SDK fault finalizes with 'failed'.
 *
 * We verify the finalized outcome by reading process rows that were left OPEN
 * when the run ended. These are closed by finalize(), not by closeProcess(),
 * so their outcome IS the finalized outcome.
 *
 * HARD GATE: No disjunctions, no try/catch around assertions, no conditionals.
 * Use assert.equal for specific expected values.
 */
test('Criterion 6a: winning run finalizes complete', () => {
  const r = runRun(['run', '--auto', '--json', 'a test goal'], {
    phases: WINNING_RUN_WITH_ORPHAN_PROCESS,
  });
  assert.equal(r.code, 0, r.stderr);

  // Read processes from the store
  const processes = r.traceProcesses();

  // Find the orphan process that was left open and closed by finalize
  const orphan = processes.find((p) => p.taskId === 'toolu_orphan_for_finalize');

  // The orphan must exist
  assert.ok(orphan !== undefined, 'orphan process must exist');

  // The orphan must be closed (finalize closes all open processes)
  assert.notEqual(orphan.closedAt, null, 'orphan process must be closed');

  // CRITICAL: The outcome must be exactly 'complete', not 'died' or anything else
  // If finalize('complete') -> finalize('died'), this assertion fails
  assert.equal(orphan.outcome, 'complete', 'finalized outcome must be complete');
});

test('Criterion 6b: losing run finalizes complete (normal ending)', () => {
  const r = runRun(['run', '--auto', '--json', 'a test goal'], {
    phases: LOSING_RUN_WITH_ORPHAN_PROCESS,
  });
  // Losing run exits 1
  assert.equal(r.code, 1);

  // Read processes from the store
  const processes = r.traceProcesses();

  // Find the orphan process that was left open and closed by finalize
  const orphan = processes.find((p) => p.taskId === 'toolu_loss_orphan');

  // The orphan must exist
  assert.ok(orphan !== undefined, 'orphan process must exist');

  // The orphan must be closed
  assert.notEqual(orphan.closedAt, null, 'orphan process must be closed');

  // A losing run is still a NORMAL ending, so finalize('complete') is called
  // If finalize('complete') -> finalize('died'), this assertion fails
  assert.equal(orphan.outcome, 'complete', 'finalized outcome must be complete for normal ending');
});

test('Criterion 6c: SDK fault path finalizes failed', () => {
  const r = runRun(['run', '--auto', '--json', 'a test goal'], {
    phases: SDK_FAULT_RUN,
  });

  // SDK fault should exit non-zero
  assert.notEqual(r.code, 0, 'SDK fault should not exit 0');

  // Read processes from the store
  const processes = r.traceProcesses();

  // Find the orphan builder that was dispatched before the fault
  const orphan = processes.find((p) => p.taskId === 'toolu_builder_orphan');

  // The orphan must exist (the tool_use was processed before the fault)
  assert.ok(orphan !== undefined, 'orphan process must exist');

  // The orphan must be closed (finalize closes all open processes)
  assert.notEqual(orphan.closedAt, null, 'orphan process must be closed');

  // CRITICAL: SDK fault path calls finalize('failed')
  // If finalize('failed') -> finalize('died'), this assertion fails
  assert.equal(orphan.outcome, 'failed', 'finalized outcome must be failed for SDK fault');
});

/* -------------------------------------------------------------------------- */
/* Criterion 7: Exit codes unchanged                                          */
/* -------------------------------------------------------------------------- */

test('Criterion 7a: winning run exits 0', () => {
  const r = runRun(['run', '--auto', '--json', 'a test goal'], {
    phases: WINNING_RUN,
  });
  assert.equal(r.code, 0, 'winning run must exit 0: ' + r.stderr);
});

test('Criterion 7b: losing run exits 1', () => {
  const r = runRun(['run', '--auto', '--json', 'a test goal'], {
    phases: LOSING_RUN,
  });
  assert.equal(r.code, 1, 'losing run must exit 1');
});

test('Criterion 7c: usage error exits 2', () => {
  const r = sandbox.run(['run', '--bogus-flag'], {});
  assert.equal(r.code, 2, 'usage error must exit 2');
});

/* -------------------------------------------------------------------------- */
/* Subagent events: builder_round_started, builder_round_ended, critic_dispatched */
/* -------------------------------------------------------------------------- */

test('builder_round_started and builder_round_ended produced on dispatch', () => {
  const r = runRun(['run', '--auto', '--json', 'test'], { phases: SUBAGENT_RUN });
  assert.equal(r.code, 0, r.stderr);

  const records = r.traceRecords();

  const builderStarted = records.filter((rec) => rec.kind === 'builder_round_started');
  const builderEnded = records.filter((rec) => rec.kind === 'builder_round_ended');

  assert.ok(builderStarted.length >= 1, 'builder_round_started must be produced');
  assert.ok(builderEnded.length >= 1, 'builder_round_ended must be produced');

  // Verify payload structure
  for (const evt of builderStarted) {
    assert.ok(typeof evt.payload.attempt === 'number', 'builder_round_started must have attempt');
    assert.equal(evt.round, null, 'a tool dispatch count cannot supply missing per-piece round metadata');
  }
  for (const evt of builderEnded) {
    assert.ok(typeof evt.payload.attempt === 'number', 'builder_round_ended must have attempt');
    assert.ok(typeof evt.payload.verbatimVerification === 'boolean', 'builder_round_ended must have verbatimVerification');
    assert.equal(evt.payload.verbatimVerification, false, 'a successful tool return without output is not verification evidence');
  }
});

test('critic_dispatched produced on critic dispatch', () => {
  const r = runRun(['run', '--auto', '--json', 'test'], { phases: SUBAGENT_RUN });
  assert.equal(r.code, 0, r.stderr);

  const records = r.traceRecords();
  const criticDispatched = records.filter((rec) => rec.kind === 'critic_dispatched');

  assert.ok(criticDispatched.length >= 1, 'critic_dispatched must be produced');

  // Verify payload structure
  for (const evt of criticDispatched) {
    assert.ok(typeof evt.payload.criticId === 'string', 'critic_dispatched must have criticId');
  }
});

/* -------------------------------------------------------------------------- */
/* Coverage summary: nine kinds by name, three scenario gaps                   */
/* -------------------------------------------------------------------------- */

test('Coverage: nine kinds produced, three scenario gaps', () => {
  const r = runRun(['run', '--auto', '--json', 'test'], { phases: SUBAGENT_RUN });
  assert.equal(r.code, 0, r.stderr);

  const records = r.traceRecords();
  const kindsFound = new Set(records.map((rec) => rec.kind));

  // Assert coverage of the nine kinds this scenario produces
  const expectedKinds = [
    'run_started',
    'run_finished',
    'piece_dispatched',
    'verdict_recorded',
    'builder_round_started',
    'builder_round_ended',
    'critic_dispatched',
    'process_event',
    'budget_spend',
  ];

  for (const kind of expectedKinds) {
    assert.ok(kindsFound.has(kind), 'coverage: ' + kind + ' must be present');
  }

  // Three kinds not produced by this scenario (no triggering conditions)
  const gaps = [
    'gate_check (requires integrity marker)',
    'pin_check (requires integrity marker)',
    'error_path (requires error notice)',
  ];

  // These must NOT be present in this scenario
  assert.ok(kindsFound.has('gate_check'), 'execution preflight check must be recorded');
  assert.ok(!kindsFound.has('pin_check'), 'scenario gap: pin_check not produced');
  assert.ok(!kindsFound.has('error_path'), 'scenario gap: error_path not produced');
});
