import { PREFLIGHT_FAKE } from './preflight-fake.js';
/**
 * Tests for the lead process row (liveness anchor).
 *
 * The lead row exists so a reader can tell a running run from a dead one
 * without system calls: a run whose lead row has a closedAt is finished;
 * one whose lead row is still open is either running or was killed. The
 * pid lets a reader check which (kill -0), but the reader's code is not
 * in this CLI. What IS here is the invariant the reader depends on:
 *
 * 1. Every run opens exactly one lead row for its process.
 * 2. That row's pid equals the pid of the spawned CLI process.
 * 3. A resumed run opens its own lead row with the resuming process's pid.
 * 4. Every normal exit path closes the lead row (loss, budget stop, interrupt).
 * 5. An exception (fault) path closes the lead row with outcome 'failed'.
 * 6. readProcesses on a run id with no trace returns empty, not throw.
 * 7. A trace file written without pid column reads back with pid: null.
 * 8. Builder and critic rows also record pid.
 * 9. R6: trace failure never fails a winning run.
 *
 * Criterion 2 is the hardest: the test asserts that the recorded pid equals
 * the pid of the child process, not merely that it is a number or > 0.
 */

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

import { readProcesses, traceDirectory } from '../dist/trace-store.js';
import { BIN, PACKAGE_ROOT, REPO_ROOT, createSandbox, runProcess, runProcessWithInterrupt } from './run-cli.js';

/* -------------------------------------------------------------------------- */
/* Setup: A sandbox with a scripted fake SDK transport                        */
/* -------------------------------------------------------------------------- */

/**
 * A fake SDK that replays a scripted run for lead row testing.
 * It just needs to:
 * 1. Yield some messages
 * 2. Set state.json to 'complete' so the run wins
 * 3. Return a result
 */
const FAKE_SDK = `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function query({ prompt, options }) {
${PREFLIGHT_FAKE}
  const plan = JSON.parse(readFileSync(process.env.EXOLVRA_GENESIS_RUN_FAKE, 'utf8'));
  const cwd = options.cwd;

  const writeState = (status, detail) => {
    const file = join(cwd, '.exolvra-genesis', 'state.json');
    mkdirSync(dirname(file), { recursive: true });
    const obj = detail !== undefined ? { status, detail } : { status };
    writeFileSync(file, JSON.stringify(obj, null, 2) + '\\n', 'utf8');
  };

  // If we should throw early (for exception path testing)
  if (plan.fail === 'start') {
    throw new Error('Failed to spawn Claude Code process: spawn node ENOENT');
  }
  if (plan.fail === 'midstream') {
    return {
      async interrupt() {},
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          session_id: 'sesn_liveness_test',
          message: { content: [{ type: 'text', text: 'Starting work...' }] },
        };
        // Throw TypeError to trigger isProgrammerFault path in session.ts
        // This causes the exception to be re-thrown (not wrapped as error result)
        // and caught by run.ts's catch block, which closes lead with 'failed'
        throw new TypeError('simulated SDK fault for liveness test');
      },
    };
  }
  // For interrupt testing: hang forever after yielding some messages
  // The test sends SIGINT and we verify the lead row is properly closed
  if (plan.hang === true) {
    let interruptCalled = false;
    return {
      async interrupt() {
        interruptCalled = true;
      },
      async *[Symbol.asyncIterator]() {
        // Yield messages first
        for (const msg of plan.messages ?? []) {
          yield {
            type: 'assistant',
            session_id: plan.sessionId ?? 'sesn_hang_test',
            message: { content: [{ type: 'text', text: msg }] },
          };
        }
        // Now hang until interrupted - check every 50ms
        while (!interruptCalled) {
          await new Promise(r => setTimeout(r, 50));
        }
        // After interrupt, yield a result to let the run finish
        yield {
          type: 'result',
          subtype: 'success',
          session_id: plan.sessionId ?? 'sesn_hang_test',
          num_turns: 1,
          total_cost_usd: 0.001,
          result: 'Interrupted.',
          errors: [],
        };
      },
    };
  }

  const sessionId = plan.sessionId ?? 'sesn_liveness_test';
  const state = plan.state ?? 'complete';
  const stateDetail = plan.stateDetail;

  // Support for emitting subagent tool_use/tool_result blocks (criterion 8)
  const phases = plan.phases ?? [];

  return {
    async interrupt() {},
    async *[Symbol.asyncIterator]() {
      // Emit the bar and pieces
      for (const msg of plan.messages ?? []) {
        yield {
          type: 'assistant',
          session_id: sessionId,
          message: { content: [{ type: 'text', text: msg }] },
        };
      }

      // Emit any phases (tool_use/tool_result blocks for subagent tests)
      for (const phase of phases) {
        yield phase;
      }

      // Set the final state
      writeState(state, stateDetail);

      // Return result
      yield {
        type: 'result',
        subtype: 'success',
        session_id: sessionId,
        num_turns: 2,
        total_cost_usd: 0.01,
        result: 'Done.',
        errors: [],
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
    const fromPath = join(from, entry);
    const toPath = join(to, entry);
    if (!existsSync(toPath)) {
      symlinkSync(fromPath, toPath, 'junction');
    }
  }
}

const WORK = mkdtempSync(join(tmpdir(), 'exolvra-genesis-liveness-'));
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
  const dir = join(WORK, 'liveness-' + (directories += 1));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Standard opening messages with bar and pieces */
const OPENING = [
  '@exolvra-genesis bar .exolvra-genesis/bar',
  '@exolvra-genesis artifact .exolvra-genesis/bar/test.txt | test artifact',
  '@exolvra-genesis piece P1 | Test piece',
].join('\n');

/** A run that completes successfully. */
const WINNING_RUN = {
  messages: [OPENING],
  state: 'complete',
};

/** A run that loses (stopped with detail). */
const LOSING_RUN = {
  messages: [OPENING, '@exolvra-genesis round P1 | 1 | LOSS | did not pass tests'],
  state: 'stopped',
  stateDetail: 'did not win',
};

/** A run that stops mid-way. */
const STOPPED_RUN = {
  messages: [OPENING],
  state: 'stopped',
  stateDetail: 'max-rounds reached',
  sessionId: 'sesn_stopped_test',
};

/**
 * A run that faults midstream - throws AFTER yielding some messages.
 * This triggers the catch block with started=true, resulting in exit 1 (blocked).
 * A startup exception (before any messages) would be a ConfigError (exit 2).
 */
const MIDSTREAM_FAULT_RUN = {
  fail: 'midstream',
};

/**
 * A run that gets as far as a live turn and then stays there.
 *
 * The interrupt test needs a run that is genuinely mid-turn when the signal
 * lands — a run that has already opened its lead row and registered its SIGINT
 * handler, and that will not settle on its own. The scripted transport yields
 * the opening messages and then polls until the CLI asks it to stop, which is
 * what `onInterrupt` does through `session.interrupt()`.
 */
const HANGING_RUN = {
  messages: [OPENING],
  hang: true,
  sessionId: 'sesn_interrupt_test',
};

/**
 * A run with builder and critic subagent dispatch (criterion 8).
 */
const SUBAGENT_RUN = {
  messages: [OPENING],
  state: 'complete',
  phases: [
    // builder tool_use
    {
      type: 'assistant',
      session_id: 'sesn_subagent_test',
      message: {
        content: [
          { type: 'text', text: 'Dispatching builder...' },
          {
            type: 'tool_use',
            id: 'toolu_builder_pid_test',
            name: 'Task',
            input: { agent: 'exolvra-genesis-builder', prompt: 'Build piece P1' },
          },
        ],
      },
    },
    // builder tool_result
    {
      type: 'assistant',
      session_id: 'sesn_subagent_test',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_builder_pid_test',
            is_error: false,
          },
          { type: 'text', text: 'Builder completed.' },
        ],
      },
    },
    // critic tool_use
    {
      type: 'assistant',
      session_id: 'sesn_subagent_test',
      message: {
        content: [
          { type: 'text', text: 'Dispatching critic...' },
          {
            type: 'tool_use',
            id: 'toolu_critic_pid_test',
            name: 'Task',
            input: { agent: 'exolvra-genesis-critic', prompt: 'Judge piece P1' },
          },
        ],
      },
    },
    // critic tool_result
    {
      type: 'assistant',
      session_id: 'sesn_subagent_test',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_critic_pid_test',
            is_error: false,
          },
          { type: 'text', text: '@exolvra-genesis round P1 | 1 | WIN |' },
        ],
      },
    },
  ],
};

/**
 * Reads a run's process rows in a child process, with the trace engine forced
 * for that child alone.
 *
 * The engine is an environment switch the store reads at call time, so forcing
 * it by assigning to `process.env` would flip it for the test runner itself —
 * a global left set around an assertion that can throw, and one every later
 * `runProcess` in this file would hand to its child. A child process carries
 * the switch and takes it away again when it exits, and the read still goes
 * through the shipped `dist/`, as a real process.
 */
function readProcessesInChild(cwd, runId, engine) {
  assert.equal(
    process.env['EXOLVRA_GENESIS_TRACE_ENGINE'],
    undefined,
    'the engine must be forced on the child alone, never on the test runner',
  );
  const store = join(sandbox.root, 'dist', 'trace-store.js').replace(/\\/g, '/');
  const script = join(cwd, 'read-processes-' + engine + '.mjs');
  writeFileSync(
    script,
    [
      "import { readProcesses } from 'file:///" + store + "';",
      'const reading = readProcesses(' +
        JSON.stringify(cwd) +
        ', ' +
        JSON.stringify(runId) +
        ');',
      'process.stdout.write(JSON.stringify(reading));',
      '',
    ].join('\n'),
    'utf8',
  );
  const result = runProcess(script, [], {
    cwd,
    env: {
      HOME: cwd,
      USERPROFILE: cwd,
      APPDATA: cwd,
      XDG_CONFIG_HOME: cwd,
      EXOLVRA_GENESIS_TRACE_ENGINE: engine,
    },
  });
  assert.equal(result.code, 0, 'readProcesses must not throw: ' + result.stderr);
  return JSON.parse(result.stdout);
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe('lead process row', () => {
  test('winning run opens and closes lead row with pid (criteria 1, 2)', () => {
    const cwd = fresh();
    const planFile = join(cwd, 'run-plan.json');
    writeFileSync(planFile, JSON.stringify(WINNING_RUN), 'utf8');

    const result = runProcess(join(sandbox.root, 'dist', 'cli.js'), ['run', '--auto', '--json', 'test goal'], {
      cwd,
      env: {
        EXOLVRA_GENESIS_RUN_FAKE: planFile,
        HOME: cwd,
        USERPROFILE: cwd,
        APPDATA: cwd,
        XDG_CONFIG_HOME: cwd,
      },
    });

    assert.equal(result.code, 0, 'expected run to succeed: ' + result.stderr);

    // Read runs.json to get the run id
    const runsPath = join(cwd, '.exolvra-genesis', 'runs.json');
    const runs = JSON.parse(readFileSync(runsPath, 'utf8'));
    assert.equal(runs.length, 1, 'expected exactly one run in ledger');
    const runId = runs[0].id;

    // Read processes
    const reading = readProcesses(cwd, runId);
    assert.equal(reading.degraded, false, 'expected trace read to succeed');

    // Find the lead process row
    const leadRows = reading.processes.filter(p => p.role === 'lead');
    assert.equal(leadRows.length, 1, 'expected exactly one lead row');

    const lead = leadRows[0];
    assert.equal(lead.role, 'lead', 'expected role to be lead');
    assert.equal(lead.piece, null, 'expected piece to be null');
    assert.equal(lead.round, null, 'expected round to be null');

    // Criterion 2: pid must equal the spawned child's pid
    // This is THE critical assertion - the recorded pid must match the actual child pid
    assert.equal(typeof lead.pid, 'number', 'expected pid to be a number');
    assert.equal(lead.pid, result.pid, 'recorded pid must equal the child process pid');

    // Criterion 1: lead row is closed with outcome 'complete'
    assert.equal(typeof lead.closedAt, 'number', 'expected closedAt to be a timestamp');
    assert.equal(lead.outcome, 'complete', 'expected outcome to be complete');
  });

  test('resumed run opens its own lead row with the resuming process pid (criterion 3)', () => {
    const cwd = fresh();
    const planFile = join(cwd, 'run-plan.json');

    // First run - stopped (not complete) so we can resume
    writeFileSync(planFile, JSON.stringify(STOPPED_RUN), 'utf8');
    const result1 = runProcess(join(sandbox.root, 'dist', 'cli.js'), ['run', '--auto', '--json', 'test goal'], {
      cwd,
      env: {
        EXOLVRA_GENESIS_RUN_FAKE: planFile,
        HOME: cwd,
        USERPROFILE: cwd,
        APPDATA: cwd,
        XDG_CONFIG_HOME: cwd,
      },
    });

    // A stopped run exits 1
    assert.equal(result1.code, 1, 'expected stopped run to exit 1');

    // Read runs.json to get the run id and session id
    const runsPath = join(cwd, '.exolvra-genesis', 'runs.json');
    const runs = JSON.parse(readFileSync(runsPath, 'utf8'));
    assert.equal(runs.length, 1, 'expected exactly one run in ledger');
    const runId = runs[0].id;
    const sessionId = runs[0].sessionId;
    assert.equal(typeof sessionId, 'string', 'expected session id to be recorded');

    // Get first run's lead row
    const reading1 = readProcesses(cwd, runId);
    const leadRows1 = reading1.processes.filter(p => p.role === 'lead');
    assert.equal(leadRows1.length, 1, 'expected exactly one lead row from first run');
    assert.equal(leadRows1[0].pid, result1.pid, 'first lead row pid should match first child pid');

    // Resume the run with a plan that completes
    writeFileSync(planFile, JSON.stringify({ ...WINNING_RUN, sessionId }), 'utf8');
    const result2 = runProcess(join(sandbox.root, 'dist', 'cli.js'), ['resume', runId], {
      cwd,
      env: {
        EXOLVRA_GENESIS_RUN_FAKE: planFile,
        HOME: cwd,
        USERPROFILE: cwd,
        APPDATA: cwd,
        XDG_CONFIG_HOME: cwd,
      },
    });

    assert.equal(result2.code, 0, 'expected resumed run to succeed: ' + result2.stderr);

    // Read processes again
    const reading2 = readProcesses(cwd, runId);
    const leadRows2 = reading2.processes.filter(p => p.role === 'lead');

    // Criterion 3: a resumed run has TWO lead rows with DIFFERENT pids
    assert.equal(leadRows2.length, 2, 'expected two lead rows after resume');

    const pids = leadRows2.map(r => r.pid);
    assert.equal(pids[0], result1.pid, 'first lead row pid should match first child pid');
    assert.equal(pids[1], result2.pid, 'second lead row pid should match second child pid');
    assert.notEqual(pids[0], pids[1], 'resumed run should have different pid from original');
  });

  test('losing run closes lead row with outcome complete (criterion 4 - loss path)', () => {
    const cwd = fresh();
    const planFile = join(cwd, 'run-plan.json');
    writeFileSync(planFile, JSON.stringify(LOSING_RUN), 'utf8');

    const result = runProcess(join(sandbox.root, 'dist', 'cli.js'), ['run', '--auto', '--json', 'test goal'], {
      cwd,
      env: {
        EXOLVRA_GENESIS_RUN_FAKE: planFile,
        HOME: cwd,
        USERPROFILE: cwd,
        APPDATA: cwd,
        XDG_CONFIG_HOME: cwd,
      },
    });

    // A losing run exits 1
    assert.equal(result.code, 1, 'expected losing run to exit 1');

    // Read runs.json to get the run id
    const runsPath = join(cwd, '.exolvra-genesis', 'runs.json');
    const runs = JSON.parse(readFileSync(runsPath, 'utf8'));
    assert.equal(runs.length, 1, 'expected exactly one run');
    const runId = runs[0].id;

    // Read processes
    const reading = readProcesses(cwd, runId);
    const leadRows = reading.processes.filter(p => p.role === 'lead');
    assert.equal(leadRows.length, 1, 'expected exactly one lead row');

    const lead = leadRows[0];
    assert.equal(lead.pid, result.pid, 'recorded pid must equal the child process pid');
    assert.equal(typeof lead.closedAt, 'number', 'lead row must be closed');
    // A loss is still a normal ending, so the lead row outcome is 'complete'
    assert.equal(lead.outcome, 'complete', 'expected outcome to be complete for loss path');
  });

  test('budget-stopped run closes lead row with outcome complete (criterion 4 - budget stop)', () => {
    const cwd = fresh();
    const planFile = join(cwd, 'run-plan.json');
    // A run that emits two rounds, but we limit to 1
    const TWO_ROUND_RUN = {
      messages: [
        OPENING,
        '@exolvra-genesis round P1 | 1 | WIN |',
        '@exolvra-genesis round P1 | 2 | WIN |',
      ],
      state: 'stopped',
      stateDetail: 'budget guard',
    };
    writeFileSync(planFile, JSON.stringify(TWO_ROUND_RUN), 'utf8');

    const result = runProcess(join(sandbox.root, 'dist', 'cli.js'), ['run', '--auto', '--json', '--max-rounds', '1', 'test goal'], {
      cwd,
      env: {
        EXOLVRA_GENESIS_RUN_FAKE: planFile,
        HOME: cwd,
        USERPROFILE: cwd,
        APPDATA: cwd,
        XDG_CONFIG_HOME: cwd,
      },
    });

    // A budget-stopped run exits 1
    assert.equal(result.code, 1, 'expected budget-stopped run to exit 1');

    // Read runs.json to get the run id
    const runsPath = join(cwd, '.exolvra-genesis', 'runs.json');
    const runs = JSON.parse(readFileSync(runsPath, 'utf8'));
    assert.equal(runs.length, 1, 'expected exactly one run');
    const runId = runs[0].id;

    // Read processes
    const reading = readProcesses(cwd, runId);
    const leadRows = reading.processes.filter(p => p.role === 'lead');
    assert.equal(leadRows.length, 1, 'expected exactly one lead row');

    const lead = leadRows[0];
    assert.equal(lead.pid, result.pid, 'recorded pid must equal the child process pid');
    assert.equal(typeof lead.closedAt, 'number', 'lead row must be closed');
    // A budget stop is still a normal ending
    assert.equal(lead.outcome, 'complete', 'expected outcome to be complete for budget stop');
  });

  test('SDK fault path closes lead row with outcome failed', () => {
    const cwd = fresh();
    const planFile = join(cwd, 'run-plan.json');
    // Use midstream fault - the SDK yields one message then throws
    writeFileSync(planFile, JSON.stringify(MIDSTREAM_FAULT_RUN), 'utf8');

    const result = runProcess(join(sandbox.root, 'dist', 'cli.js'), ['run', '--auto', '--json', 'test goal'], {
      cwd,
      env: {
        EXOLVRA_GENESIS_RUN_FAKE: planFile,
        HOME: cwd,
        USERPROFILE: cwd,
        APPDATA: cwd,
        XDG_CONFIG_HOME: cwd,
        // Disable auto-resume for this test
        EXOLVRA_GENESIS_AUTO_RESUMES: '0',
      },
    });

    // A midstream fault run exits 1 (blocked)
    assert.equal(result.code, 1, 'expected fault run to exit 1');

    // Read runs.json to get the run id
    const runsPath = join(cwd, '.exolvra-genesis', 'runs.json');
    const runs = JSON.parse(readFileSync(runsPath, 'utf8'));
    assert.equal(runs.length, 1, 'expected exactly one run');
    const runId = runs[0].id;

    // Read processes
    const reading = readProcesses(cwd, runId);
    const leadRows = reading.processes.filter(p => p.role === 'lead');
    assert.equal(leadRows.length, 1, 'expected exactly one lead row');

    const lead = leadRows[0];
    assert.equal(lead.pid, result.pid, 'recorded pid must equal the child process pid');
    assert.equal(typeof lead.closedAt, 'number', 'lead row must be closed on fault');
    assert.equal(lead.outcome, 'failed', 'expected outcome to be failed on SDK fault');
  });

  test('readProcesses on nonexistent run returns empty result (criterion 6)', () => {
    const cwd = fresh();

    // Read processes for a run id that does not exist
    const reading = readProcesses(cwd, 'r-nonexistent-run-id');

    // Must return empty array, not throw
    assert.equal(Array.isArray(reading.processes), true, 'expected processes to be an array');
    assert.equal(reading.processes.length, 0, 'expected empty processes array');
    assert.equal(reading.degraded, false, 'expected degraded to be false for missing trace');
  });

  test('older trace file without pid column reads back with pid: null (criterion 7)', () => {
    const cwd = fresh();
    const runId = 'r-old-format-test';

    // Create a trace file in the OLD format (without pid column)
    const traceDir = join(cwd, '.exolvra-genesis', 'trace');
    mkdirSync(traceDir, { recursive: true });
    const ndjsonPath = join(traceDir, runId + '.ndjson');

    // Write process rows WITHOUT the pid field - this is the old format
    const oldFormatProcesses = [
      {
        type: 'process',
        data: {
          runId,
          taskId: 'lead-old-format',
          role: 'lead',
          piece: null,
          round: null,
          openedAt: Date.now() - 1000,
          closedAt: Date.now(),
          outcome: 'complete',
          // Note: NO pid field - this is the old format
        },
      },
      {
        type: 'process',
        data: {
          runId,
          taskId: 'builder-old-format',
          role: 'builder',
          piece: 'P1',
          round: 1,
          openedAt: Date.now() - 500,
          closedAt: Date.now() - 100,
          outcome: 'complete',
          // Note: NO pid field
        },
      },
    ];
    writeFileSync(ndjsonPath, oldFormatProcesses.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf8');

    // Read it back through the NDJSON engine, forced on the reading process
    // and nowhere else.
    const reading = readProcessesInChild(cwd, runId, 'ndjson');

    assert.equal(reading.degraded, false, 'reading old format should not degrade');
    assert.equal(reading.processes.length, 2, 'expected two processes');

    const lead = reading.processes.find(p => p.role === 'lead');
    const builder = reading.processes.find(p => p.role === 'builder');

    assert.notEqual(lead, undefined, 'lead process must exist');
    assert.notEqual(builder, undefined, 'builder process must exist');

    // Criterion 7: pid reads back as null for old format
    assert.equal(lead.pid, null, 'lead pid must be null for old format');
    assert.equal(builder.pid, null, 'builder pid must be null for old format');
  });

  test('builder and critic rows record pid (criterion 8)', () => {
    const cwd = fresh();
    const planFile = join(cwd, 'run-plan.json');
    writeFileSync(planFile, JSON.stringify(SUBAGENT_RUN), 'utf8');

    const result = runProcess(join(sandbox.root, 'dist', 'cli.js'), ['run', '--auto', '--json', 'test goal'], {
      cwd,
      env: {
        EXOLVRA_GENESIS_RUN_FAKE: planFile,
        HOME: cwd,
        USERPROFILE: cwd,
        APPDATA: cwd,
        XDG_CONFIG_HOME: cwd,
      },
    });

    assert.equal(result.code, 0, 'expected run to succeed: ' + result.stderr);

    // Read runs.json to get the run id
    const runsPath = join(cwd, '.exolvra-genesis', 'runs.json');
    const runs = JSON.parse(readFileSync(runsPath, 'utf8'));
    assert.equal(runs.length, 1, 'expected exactly one run');
    const runId = runs[0].id;

    // Read processes
    const reading = readProcesses(cwd, runId);
    assert.equal(reading.degraded, false, 'expected trace read to succeed');

    // Find builder and critic rows
    const builderRows = reading.processes.filter(p => p.role === 'builder');
    const criticRows = reading.processes.filter(p => p.role === 'critic');

    assert.equal(builderRows.length, 1, 'expected exactly one builder row');
    assert.equal(criticRows.length, 1, 'expected exactly one critic row');

    const builder = builderRows[0];
    const critic = criticRows[0];

    // Criterion 8: builder and critic rows have pid, and it equals the CLI process pid
    // (since subagents run in the same process as the lead)
    assert.equal(typeof builder.pid, 'number', 'builder pid must be a number');
    assert.equal(builder.pid, result.pid, 'builder pid must equal CLI process pid');

    assert.equal(typeof critic.pid, 'number', 'critic pid must be a number');
    assert.equal(critic.pid, result.pid, 'critic pid must equal CLI process pid');
  });

  test('R6: unwritable trace does not fail a winning run (criterion 9)', () => {
    const cwd = fresh();
    const planFile = join(cwd, 'run-plan.json');
    writeFileSync(planFile, JSON.stringify(WINNING_RUN), 'utf8');

    // Create a FILE where the trace directory should be - makes it unwritable
    mkdirSync(join(cwd, '.exolvra-genesis'), { recursive: true });
    writeFileSync(join(cwd, '.exolvra-genesis', 'trace'), 'not a directory', 'utf8');

    const result = runProcess(join(sandbox.root, 'dist', 'cli.js'), ['run', '--auto', '--json', 'test goal'], {
      cwd,
      env: {
        EXOLVRA_GENESIS_RUN_FAKE: planFile,
        HOME: cwd,
        USERPROFILE: cwd,
        APPDATA: cwd,
        XDG_CONFIG_HOME: cwd,
      },
    });

    // A winning run MUST still exit 0 even with degraded trace
    assert.equal(result.code, 0, 'winning run must exit 0 despite degraded trace: ' + result.stderr);

    // state.json must still show complete
    const statePath = join(cwd, '.exolvra-genesis', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.status, 'complete', 'state must be complete despite degraded trace');
  });

  test('NDJSON engine records pid correctly (round 39 gap 1)', () => {
    const cwd = fresh();
    const planFile = join(cwd, 'run-plan.json');
    writeFileSync(planFile, JSON.stringify(WINNING_RUN), 'utf8');

    // Force NDJSON engine
    const result = runProcess(join(sandbox.root, 'dist', 'cli.js'), ['run', '--auto', '--json', 'test goal'], {
      cwd,
      env: {
        EXOLVRA_GENESIS_RUN_FAKE: planFile,
        HOME: cwd,
        USERPROFILE: cwd,
        APPDATA: cwd,
        XDG_CONFIG_HOME: cwd,
        EXOLVRA_GENESIS_TRACE_ENGINE: 'ndjson',
      },
    });

    assert.equal(result.code, 0, 'expected run to succeed: ' + result.stderr);

    // Read runs.json to get the run id
    const runsPath = join(cwd, '.exolvra-genesis', 'runs.json');
    const runs = JSON.parse(readFileSync(runsPath, 'utf8'));
    assert.equal(runs.length, 1, 'expected exactly one run in ledger');
    const runId = runs[0].id;

    // Verify the run-scoped trace file is NDJSON (not SQLite).
    const traceDir = traceDirectory(cwd, runId);
    const ndjsonPath = join(traceDir, runId + '.ndjson');
    assert.equal(existsSync(ndjsonPath), true, 'expected NDJSON trace file to exist');

    // Read processes using the NDJSON engine, forced on the reading process and
    // nowhere else.
    const reading = readProcessesInChild(cwd, runId, 'ndjson');
    assert.equal(reading.degraded, false, 'expected trace read to succeed');

    const leadRows = reading.processes.filter(p => p.role === 'lead');
    // The whole reading goes in the message: if this ever fails on a loaded
    // machine, the next reader needs the rows and not just the count.
    assert.equal(
      leadRows.length,
      1,
      'expected exactly one lead row, read back: ' + JSON.stringify(reading),
    );

    const lead = leadRows[0];
    // THE CRITICAL ASSERTION: pid must equal the spawned child's pid
    assert.equal(typeof lead.pid, 'number', 'expected pid to be a number');
    assert.equal(lead.pid, result.pid, 'NDJSON engine: recorded pid must equal the child process pid');
  });

  test('interrupted run closes its lead row (criterion 4 - interrupt path)', async () => {
    const cwd = fresh();
    const planFile = join(cwd, 'run-plan.json');
    writeFileSync(planFile, JSON.stringify(HANGING_RUN), 'utf8');

    // The interrupt is raised inside the child by a preload (see
    // runProcessWithInterrupt): on Windows an outside process.kill(pid,
    // 'SIGINT') destroys the child without running the handler, so it would
    // prove nothing about the CLI's own SIGINT path.
    //
    // It is raised when the child says it has reached a live turn, never on a
    // timer. `bar_captured` is the first line the run produces from reading a
    // provider message, so a run that has written it has a session to interrupt
    // and a SIGINT handler installed to do it with. Both halves of that are
    // pinned below and neither is taken on trust: an emit with no handler
    // registered would come back `delivered: false`, and an emit with no live
    // session would leave the scripted transport polling forever and trip
    // `timedOut`.
    const result = await runProcessWithInterrupt(
      join(sandbox.root, 'dist', 'cli.js'),
      ['run', '--auto', '--json', 'test goal'],
      {
        cwd,
        triggerOn: (line) => line.includes('"type":"bar_captured"'),
        env: {
          EXOLVRA_GENESIS_RUN_FAKE: planFile,
          HOME: cwd,
          USERPROFILE: cwd,
          APPDATA: cwd,
          XDG_CONFIG_HOME: cwd,
        },
      },
    );

    assert.equal(result.triggered, true, 'the child never reported a live turn');
    // The defect this replaced a timer to kill: a signal raised too early runs
    // no listener and is discarded in silence, and the run then ends by a path
    // that is not the interrupt path while the test reads as green.
    assert.equal(result.delivered, true, 'the raised SIGINT reached no listener');
    assert.equal(result.timedOut, false, 'the interrupted run must settle on its own');
    assert.equal(result.signal, null, 'the run must not be killed by a signal');
    // An interrupted run is a stopped run: exit 1, exactly.
    assert.equal(result.code, 1, 'expected interrupted run to exit 1: ' + result.stderr);

    // The exit code alone cannot tell an interrupt from a loss or a guard trip,
    // so the stream has to say which path settled this run.
    const events = result.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
    const notices = events.filter((event) => event.type === 'notice');
    assert.equal(
      notices.some(
        (event) => event.level === 'error' && event.message === 'the run was interrupted',
      ),
      true,
      'expected the interrupt notice, got: ' + JSON.stringify(notices),
    );
    const finished = events[events.length - 1];
    assert.equal(finished.status, 'stopped', 'expected the run to report stopped');

    // Read runs.json to get the run id
    const runsPath = join(cwd, '.exolvra-genesis', 'runs.json');
    const runs = JSON.parse(readFileSync(runsPath, 'utf8'));
    assert.equal(runs.length, 1, 'expected exactly one run in ledger');
    const runId = runs[0].id;

    // Read processes
    const reading = readProcesses(cwd, runId);
    assert.equal(reading.degraded, false, 'expected trace read to succeed');

    const leadRows = reading.processes.filter((p) => p.role === 'lead');
    assert.equal(leadRows.length, 1, 'expected exactly one lead row');

    const lead = leadRows[0];
    assert.equal(lead.pid, result.pid, 'recorded pid must equal the child process pid');
    // THE invariant this piece exists for: a Ctrl+C'd run is a *closed* row.
    // An open one would be indistinguishable from a SIGKILL, and the anchor
    // would report a false death on the commonest way a person stops a run.
    assert.equal(typeof lead.closedAt, 'number', 'lead row must be closed on interrupt');
    assert.equal(lead.outcome, 'complete', 'expected outcome to be complete for interrupt path');
  });

  // NOTE: cross-engine agreement (write with one engine, read with the other) is
  // not reachable. The SQLite engine uses .db files, the NDJSON engine uses .ndjson
  // files - they cannot read each other's formats. The EXOLVRA_GENESIS_TRACE_ENGINE
  // switch controls which engine is used, but there is no way to write with one
  // and read with the other. Item 2 from round 39 addendum: not reachable.
});

/* -------------------------------------------------------------------------- */
/* T4c-2: the liveness read side                                               */
/* -------------------------------------------------------------------------- */

import { spawn } from 'node:child_process';

import {
  RECYCLE_TOLERANCE_MS,
  _fileTimeToUnixMs_FOR_TESTING_ONLY as fileTimeToUnixMs,
  _parseElapsedSeconds_FOR_TESTING_ONLY as parseElapsedSeconds,
  deriveLiveness,
  pidExists,
  processStartTime,
} from '../dist/trace-store.js';

/** A lead row, in the shape `readProcesses` hands one back. */
function leadRow(overrides = {}) {
  return {
    runId: 'r-20260821-1200-aaaaaa',
    taskId: 'lead-r-20260821-1200-aaaaaa',
    role: 'lead',
    piece: null,
    round: null,
    openedAt: Date.now(),
    closedAt: null,
    outcome: null,
    pid: process.pid,
    ...overrides,
  };
}

/** A reading, in the shape `readProcesses` hands one back. */
function reading(processes, degraded = false) {
  return { processes, degraded };
}

/** A probe that answers, and remembers every pid it was asked about. */
function spy(answer) {
  const asked = [];
  const probe = (pid) => {
    asked.push(pid);
    return answer(pid);
  };
  probe.asked = asked;
  return probe;
}

/**
 * A process that is running and is not any run of ours.
 *
 * Nothing about it is simulated: a real child, a real pid the operating system
 * handed out, and a real start time the resolver reads for itself. This is what
 * a recycled pid looks like from the outside.
 */
function standInProcess() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return {
    pid: child.pid,
    stop: async () => {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.on('close', resolve));
    },
  };
}

/** A pid that is certainly not running: a child that has already exited. */
async function exitedPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'ignore', 'ignore'] });
  const pid = child.pid;
  await new Promise((resolve) => child.on('close', resolve));
  return pid;
}

/**
 * The errno `process.kill(pid, 0)` refuses a pid with, or null when it does not
 * refuse at all.
 *
 * The raw call on purpose. `pidExists` is the thing under test here, so the
 * search for a pid in the state the test needs must not be run through it, or
 * the test would be asking the code to nominate its own evidence.
 */
function signalRefusal(pid) {
  try {
    process.kill(pid, 0);
    return null;
  } catch (error) {
    return error.code ?? 'UNKNOWN';
  }
}

/**
 * A pid this user may not signal, or null when this machine offers none.
 *
 * Which numbers those are is a property of the machine and of who is running the
 * tests — the operating system's own processes on Windows, pid 1 under an
 * unprivileged POSIX user, possibly nothing at all for root — so it is searched
 * for rather than written down. Pid 0 is never probed: on POSIX it names the
 * caller's own process group rather than a process.
 */
function pidWeMayNotSignal(limit = 4096) {
  for (let pid = 1; pid <= limit; pid += 1) {
    if (signalRefusal(pid) === 'EPERM') return pid;
  }
  return null;
}

/**
 * The backstop on a spawn-and-wait, and the reason it is not a deadline.
 *
 * The wait below is causal: it ends when the run says it has reached a live
 * turn, or when the run exits without ever saying so, and the test asserts which
 * of those happened. This only keeps a genuinely wedged child from hanging the
 * suite for ever, and when it fires the test says so in those words rather than
 * reading as a failure of the thing under test.
 *
 * It is the same 60s `runProcessWithInterrupt` already uses in this file for the
 * same wait. The 15s it replaces was a deadline with nothing asserted about it:
 * this wait measures ~1.7s idle and ~5s with the packaging test saturating the
 * machine, so 15s left threefold headroom in a suite that runs nine files at
 * once — enough that machine speed, not a regression, decided the colour of the
 * result.
 */
const START_GUARD_MS = 60_000;

/**
 * Starts a run and settles as soon as it prints a line the caller is waiting
 * for — or as soon as it exits without printing one.
 *
 * The run is a hanging one: it does not end on its own, and its pipes keep this
 * test process's event loop alive for as long as it is there. So the kill is
 * registered as an `after` hook the moment the child exists, not written at the
 * end of the test where the first failing assertion would jump over it. That
 * ordering is not a tidiness preference: with the kill at the end, a test that
 * fails its assertion leaks a run that never ends and the whole file hangs
 * instead of reporting the failure.
 *
 * Both pipes are drained. An unread stderr fills at 64KB and the child then
 * blocks writing a warning instead of reaching the line being waited on, which
 * is a hang that looks exactly like a slow machine.
 */
function startRunUntil(t, cwd, planFile, triggerOn) {
  const child = spawn(
    process.execPath,
    [join(sandbox.root, 'dist', 'cli.js'), 'run', '--auto', '--json', 'test goal'],
    {
      cwd,
      env: {
        ...process.env,
        EXOLVRA_GENESIS_RUN_FAKE: planFile,
        HOME: cwd,
        USERPROFILE: cwd,
        APPDATA: cwd,
        XDG_CONFIG_HOME: cwd,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const closed = new Promise((resolve) => child.on('close', resolve));
  t.after(async () => {
    child.kill('SIGKILL');
    await closed;
  });

  const pid = child.pid;
  let stdout = '';
  let stderr = '';
  let unread = '';
  let triggered = false;
  let exited = false;
  let guardTripped = false;

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  return new Promise((settle, fail) => {
    const done = () =>
      settle({ child, closed, pid, triggered, exited, guardTripped, stdout, stderr });

    const guard = setTimeout(() => {
      guardTripped = true;
      child.kill('SIGKILL');
    }, START_GUARD_MS);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (triggered) return;
      // The predicate is only ever shown whole lines, so a chunk boundary
      // cannot split the trigger in two.
      unread += text;
      for (;;) {
        const cut = unread.indexOf('\n');
        if (cut < 0) break;
        const line = unread.slice(0, cut);
        unread = unread.slice(cut + 1);
        if (triggered || line.trim() === '' || !triggerOn(line)) continue;
        triggered = true;
        clearTimeout(guard);
        done();
      }
    });

    child.on('close', () => {
      exited = true;
      clearTimeout(guard);
      if (!triggered) done();
    });

    child.on('error', (error) => {
      clearTimeout(guard);
      fail(error);
    });
  });
}

/** The three causal facts a test needs before it may kill or read the run. */
function assertReachedLiveTurn(started) {
  assert.equal(started.guardTripped, false, 'the run did not reach a live turn inside the guard');
  assert.equal(started.exited, false, 'the run ended before a live turn: ' + started.stderr);
  assert.equal(started.triggered, true, 'the run never reported a live turn');
}

/** Waits until nothing holds `pid` any more, rather than assuming it by now. */
async function waitUntilGone(pid) {
  const deadline = Date.now() + 30_000;
  while (pidExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The environment a read-only command gets: this directory, nothing of ours. */
function readerEnv(cwd) {
  return { HOME: cwd, USERPROFILE: cwd, APPDATA: cwd, XDG_CONFIG_HOME: cwd };
}

/*
 * Criterion numbers below are T4c-2's, and are written out in full: the block
 * above numbers T4c-1's criteria in this same file, and the two sets are not
 * the same list.
 */
describe('liveness readout (T4c-2)', () => {
  /* ---- criterion 1: the resolver, and every branch of it ------------------ */

  test('the resolver answers settled, live and died from real rows (T4c-2 criterion 1)', async () => {
    const gone = await exitedPid();
    assert.equal(pidExists(gone), false, 'the pid of an exited child must not answer');

    const settled = reading([leadRow({ closedAt: Date.now(), outcome: 'complete' })]);
    const running = reading([leadRow({ pid: process.pid })]);
    const dead = reading([leadRow({ pid: gone })]);

    assert.deepEqual(
      [
        deriveLiveness(settled, 'running'),
        deriveLiveness(running, 'running'),
        deriveLiveness(dead, 'running'),
      ],
      ['-', 'live', 'died'],
    );
  });

  test('a status that is not running is not applicable (T4c-2 criterion 1a)', () => {
    for (const status of ['complete', 'stopped', 'blocked']) {
      assert.equal(deriveLiveness(undefined, status), '-', 'status ' + status + ', no reading');
      assert.equal(
        deriveLiveness(reading([leadRow()]), status),
        '-',
        'status ' + status + ', open lead row',
      );
    }
  });

  test('a running run with no reading is not known (T4c-2 criterion 1b)', () => {
    assert.equal(deriveLiveness(undefined, 'running'), '?');
  });

  test('a degraded reading is not known (T4c-2 criterion 1c)', () => {
    assert.equal(deriveLiveness(reading([], true), 'running'), '?');
  });

  test('a running run with no lead row is not known (T4c-2 criterion 1d)', () => {
    const builder = leadRow({ role: 'builder', taskId: 'builder-1', pid: 1234 });
    assert.equal(deriveLiveness(reading([builder]), 'running'), '?');
  });

  test('a closed lead row is not applicable, whatever the ledger says (T4c-2 criterion 1e)', () => {
    const closed = leadRow({ closedAt: Date.now(), outcome: 'complete', pid: 1234 });
    assert.equal(deriveLiveness(reading([closed]), 'running'), '-');
  });

  test('an open lead row with no pid recorded is not known, never died (T4c-2 criterion 1f)', () => {
    // The shape an older build wrote. Reading it as `died` would report every
    // run traced before the pid existed as stuck.
    assert.equal(deriveLiveness(reading([leadRow({ pid: null })]), 'running'), '?');
  });

  test('an open lead row whose process is this one is live (T4c-2 criterion 1g)', () => {
    assert.equal(deriveLiveness(reading([leadRow({ pid: process.pid })]), 'running'), 'live');
  });

  test('an open lead row whose pid nobody holds is died (T4c-2 criterion 1h)', () => {
    const cheap = spy(() => false);
    const expensive = spy(() => null);
    const row = reading([leadRow({ pid: 4242 })]);
    assert.equal(deriveLiveness(row, 'running', cheap, expensive), 'died');
    assert.deepEqual(cheap.asked, [4242], 'the cheap check is the one that answered');
    assert.deepEqual(expensive.asked, [], 'a pid that is gone must not be paid for');
  });

  test('the most recent lead row is the one that decides (T4c-2 criterion 1i)', async () => {
    // A resume opens a second lead row, and the naive read takes the wrong one.
    const gone = await exitedPid();
    assert.equal(pidExists(gone), false, 'the pid of an exited child must not answer');

    const older = leadRow({
      taskId: 'lead-first',
      openedAt: 1000,
      closedAt: 2000,
      outcome: 'complete',
      pid: gone,
    });
    const newer = leadRow({ taskId: 'lead-second', openedAt: Date.now(), pid: process.pid });
    assert.equal(deriveLiveness(reading([older, newer]), 'running'), 'live');
    assert.equal(
      deriveLiveness(reading([newer, older]), 'running'),
      'live',
      'the order rows sit in the file must not decide this',
    );

    const closedLast = leadRow({
      taskId: 'lead-third',
      openedAt: Date.now(),
      closedAt: Date.now(),
      outcome: 'complete',
      pid: process.pid,
    });
    const openFirst = leadRow({ taskId: 'lead-fourth', openedAt: 1000, pid: process.pid });
    assert.equal(deriveLiveness(reading([closedLast, openFirst]), 'running'), '-');
  });

  /* ---- criterion 2: a settled run never consults the pid ------------------ */

  test('a ledger of settled runs asks nothing of any process (T4c-2 criterion 2)', () => {
    const cheap = spy(() => true);
    const expensive = spy(() => 0);

    const states = [];
    for (let index = 0; index < 50; index += 1) {
      const closed = reading([
        leadRow({
          taskId: 'lead-' + index,
          openedAt: 1000 + index,
          closedAt: 2000 + index,
          outcome: 'complete',
          pid: 1000 + index,
        }),
      ]);
      states.push(deriveLiveness(closed, 'running', cheap, expensive));
    }

    assert.deepEqual(states, new Array(50).fill('-'), 'a closed row is authoritative on its own');
    assert.deepEqual(cheap.asked, [], 'a settled run asked whether a process was alive');
    assert.deepEqual(expensive.asked, [], 'a settled run paid for a process start time');
  });

  /* ---- criterion 3: a live run ------------------------------------------- */

  test('a run whose process is this very process is live (T4c-2 criterion 3)', () => {
    // The one pid whose liveness needs no argument: we are it.
    assert.equal(pidExists(process.pid), true, 'this process must answer for itself');
    assert.equal(
      deriveLiveness(reading([leadRow({ openedAt: Date.now(), pid: process.pid })]), 'running'),
      'live',
    );
  });

  /* ---- criterion 4: a dead run ------------------------------------------- */

  test('a run whose process has exited is died (T4c-2 criterion 4)', async () => {
    const openedAt = Date.now();
    const gone = await exitedPid();
    assert.equal(pidExists(gone), false, 'a child that has exited must not answer');
    assert.equal(deriveLiveness(reading([leadRow({ openedAt, pid: gone })]), 'running'), 'died');
  });

  /* ---- criterion 5: a pid is not an identity ----------------------------- */

  test('a live process that is not the run does not make it live (T4c-2 criterion 5)', async (t) => {
    const holder = standInProcess();
    t.after(holder.stop);

    assert.equal(pidExists(holder.pid), true, 'the stand-in process must be alive');
    const startedAt = processStartTime(holder.pid);
    assert.equal(typeof startedAt, 'number', 'the stand-in process must have a readable start time');

    // The row was opened an hour before the process now holding its pid existed.
    // The run that opened it is gone; the number has been handed on.
    const recycled = leadRow({ openedAt: startedAt - 60 * 60 * 1000, pid: holder.pid });
    assert.equal(
      deriveLiveness(reading([recycled]), 'running'),
      'died',
      'a dead run whose pid was reused must not report as live',
    );

    // The same live pid, on a row that same process could have written: still
    // live. The defence rejects the impostor, not the pid.
    const genuine = leadRow({ openedAt: startedAt + 5, pid: holder.pid });
    assert.equal(deriveLiveness(reading([genuine]), 'running'), 'live');
  });

  test('the recycling bound is two seconds, and both sides of it hold (T4c-2 criterion 5)', async (t) => {
    assert.equal(RECYCLE_TOLERANCE_MS, 2000, 'the bound this test is about');

    const holder = standInProcess();
    t.after(holder.stop);
    assert.equal(pidExists(holder.pid), true, 'the stand-in process must be alive');

    const openedAt = Date.now();
    const row = reading([leadRow({ openedAt, pid: holder.pid })]);
    const startedAt = (offset) => () => openedAt + offset;

    // A process that already existed when the row was written is the process
    // that wrote it. A slow start puts the start time further before `openedAt`,
    // which is further inside the bound, never nearer it.
    assert.equal(deriveLiveness(row, 'running', pidExists, startedAt(-60_000)), 'live');
    assert.equal(deriveLiveness(row, 'running', pidExists, startedAt(-1)), 'live');
    // Exactly on the bound is still the run: absorbing this is what it is for.
    assert.equal(
      deriveLiveness(row, 'running', pidExists, startedAt(RECYCLE_TOLERANCE_MS)),
      'live',
    );
    // One millisecond past it is another process wearing the number.
    assert.equal(
      deriveLiveness(row, 'running', pidExists, startedAt(RECYCLE_TOLERANCE_MS + 1)),
      'died',
    );
    assert.equal(deriveLiveness(row, 'running', pidExists, startedAt(60_000)), 'died');
  });

  test('runs reports a reused pid as died, not live (T4c-2 criterion 5 e2e)', async (t) => {
    const cwd = fresh();
    const holder = standInProcess();
    t.after(holder.stop);

    assert.equal(pidExists(holder.pid), true, 'the stand-in process must be alive');
    const startedAt = processStartTime(holder.pid);
    assert.equal(typeof startedAt, 'number', 'the stand-in process must have a readable start time');

    const openedAt = startedAt - 60 * 60 * 1000;
    const runId = 'r-20260821-1200-recyc1';
    const dir = join(cwd, '.exolvra-genesis');
    mkdirSync(join(dir, 'trace'), { recursive: true });
    writeFileSync(
      join(dir, 'runs.json'),
      JSON.stringify([
        {
          id: runId,
          input: 'a run that was killed an hour ago',
          status: 'running',
          models: { lead: 'claude-opus-4-5-20251101', builder: 'opus', critic: 'sonnet' },
          sessionId: 'sesn_recycled',
          startedAt: new Date(openedAt).toISOString(),
        },
      ]) + '\n',
      'utf8',
    );
    writeFileSync(
      join(dir, 'trace', runId + '.ndjson'),
      JSON.stringify({
        type: 'process',
        data: {
          runId,
          taskId: 'lead-' + runId,
          role: 'lead',
          piece: null,
          round: null,
          openedAt,
          closedAt: null,
          outcome: null,
          pid: holder.pid,
        },
      }) + '\n',
      'utf8',
    );

    const result = runProcess(join(sandbox.root, 'dist', 'cli.js'), ['runs', '-C', cwd, '--json'], {
      cwd,
      env: readerEnv(cwd),
    });

    assert.equal(result.code, 0, 'runs must succeed: ' + result.stderr);
    const runs = JSON.parse(result.stdout);
    assert.equal(runs.length, 1, 'expected one run in the ledger');
    assert.equal(runs[0].status, 'running', 'the ledger says what the ledger says');
    assert.equal(runs[0].live, 'died', 'the shipped binary reported a dead run as live');
  });

  /* ---- what the two probes can and cannot say ---------------------------- */

  test('a process we may not signal still counts as alive', () => {
    // EPERM is "it is there, and it is not yours", which is alive. This is a
    // real case and not the recycling hazard: it does not stand in for T4c-2
    // criterion 5, which is above with a real process holding a real pid.
    assert.equal(pidExists(process.pid), true, 'this process must answer for itself');

    const openedAt = Date.now();
    const row = reading([leadRow({ openedAt, pid: 4242 })]);
    const cannotSignal = () => true;
    const startedBefore = () => openedAt - 5;
    assert.equal(deriveLiveness(row, 'running', cannotSignal, startedBefore), 'live');
  });

  test('a pid the system refuses to let us signal is alive, on a real refusal', (t) => {
    // The test above injects a predicate that says "alive" and pins what the
    // resolver does with that answer. This one pins where the answer comes from:
    // `pidExists` catches the refusal and reads EPERM as alive, and nothing else
    // in the suite ever puts it in front of a pid that genuinely refuses. With
    // that branch gone, a run owned by a process this user may not signal — an
    // elevated one — reports `died`, which is the false stuck run this column
    // exists to prevent.
    const pid = pidWeMayNotSignal();
    if (pid === null) {
      t.skip(
        'no pid in 1..4096 answered process.kill(pid, 0) with EPERM on this machine: ' +
          'every process in that range is either this user\'s to signal or absent, ' +
          'so the refusal cannot be produced here without faking it',
      );
      return;
    }

    // Bracketed, because a pid that stopped refusing us part-way through is a
    // different fact from the one being pinned and must not be reported as it.
    const before = signalRefusal(pid);
    const alive = pidExists(pid);
    const after = signalRefusal(pid);
    assert.equal(before, 'EPERM', 'pid ' + pid + ' was chosen for refusing us with EPERM');
    assert.equal(after, 'EPERM', 'pid ' + pid + ' stopped refusing us mid-test: ' + after);
    assert.equal(alive, true, 'pid ' + pid + ' is there and is not ours to signal: that is alive');

    // And through the resolver on the real predicate, which is the shape the
    // column is actually read in: an open row whose process cannot be signalled
    // is live, not died.
    const openedAt = Date.now();
    const row = reading([leadRow({ openedAt, pid })]);
    assert.equal(
      deriveLiveness(row, 'running', pidExists, () => openedAt - 5),
      'live',
      'a run held by a process we may not signal read as anything but live',
    );
  });

  test('a pid that answers but cannot be identified is not known, never live (T4c-2 criterion 5)', () => {
    const openedAt = Date.now();
    const row = reading([leadRow({ openedAt, pid: 4242 })]);
    const unreadable = spy(() => null);
    assert.equal(deriveLiveness(row, 'running', () => true, unreadable), '?');
    assert.deepEqual(unreadable.asked, [4242], 'the start time must have been asked for');
  });

  test('a process start time is stable, and a pid that is gone has none', async () => {
    const first = processStartTime(process.pid);
    assert.equal(typeof first, 'number', 'this process must have a readable start time');
    // A start time is a fact about a process, not a measurement of now: asked
    // twice it must give the same answer, or the comparison it feeds is noise.
    assert.equal(processStartTime(process.pid), first);

    const gone = await exitedPid();
    assert.equal(pidExists(gone), false, 'a child that has exited must not answer');
    assert.equal(processStartTime(gone), null, 'a pid nobody holds has no start time');
  });

  test('a Windows FILETIME reads as the instant it names', () => {
    // A real reading from this machine: 100ns ticks since 1601, which is
    // 1787366346014 in unix milliseconds.
    assert.equal(fileTimeToUnixMs('134318399460141914'), 1787366346014);
    assert.equal(fileTimeToUnixMs('116444736000000000'), null, 'the unix epoch is not a start');
    assert.equal(fileTimeToUnixMs(''), null);
    assert.equal(fileTimeToUnixMs('Get-Process : Cannot find a process'), null);
    assert.equal(fileTimeToUnixMs('12.5'), null);
  });

  test('ps elapsed time reads as whole seconds, and refuses anything else', () => {
    // The POSIX route's `ps` call cannot be made on a Windows machine, so what
    // is pinned here is the reading it has to make sense of: [[dd-]hh:]mm:ss.
    assert.equal(parseElapsedSeconds('00:05'), 5);
    assert.equal(parseElapsedSeconds('   01:02:03  '), 3723);
    assert.equal(parseElapsedSeconds('2-03:04:05'), 183845);
    assert.equal(parseElapsedSeconds(''), null);
    assert.equal(parseElapsedSeconds('5'), null);
    assert.equal(parseElapsedSeconds('ps: no such process'), null);
  });

  /* ---- the same four answers, through the binary that ships -------------- */

  test('runs shows live for a run whose process is running (T4c-2 criterion 3 e2e)', async (t) => {
    const cwd = fresh();
    const planFile = join(cwd, 'run-plan.json');
    writeFileSync(planFile, JSON.stringify(HANGING_RUN), 'utf8');

    const started = await startRunUntil(t, cwd, planFile, (line) =>
      line.includes('"type":"bar_captured"'),
    );
    assertReachedLiveTurn(started);
    assert.equal(pidExists(started.pid), true, 'the run process must still be there');

    const result = runProcess(join(sandbox.root, 'dist', 'cli.js'), ['runs', '-C', cwd, '--json'], {
      cwd,
      env: readerEnv(cwd),
    });

    assert.equal(result.code, 0, 'runs must succeed: ' + result.stderr);
    const runs = JSON.parse(result.stdout);
    assert.equal(runs.length, 1, 'expected one run in the ledger');
    assert.equal(runs[0].status, 'running', 'the run has not settled');
    assert.equal(runs[0].live, 'live', 'a run whose process is running must read live');
  });

  test('runs shows died for a run whose process was killed (T4c-2 criterion 4 e2e)', async (t) => {
    const cwd = fresh();
    const planFile = join(cwd, 'run-plan.json');
    writeFileSync(planFile, JSON.stringify(HANGING_RUN), 'utf8');

    const started = await startRunUntil(t, cwd, planFile, (line) =>
      line.includes('"type":"bar_captured"'),
    );
    assertReachedLiveTurn(started);

    // Killed the way a crash kills: no chance to settle anything.
    started.child.kill('SIGKILL');
    await started.closed;
    await waitUntilGone(started.pid);
    assert.equal(pidExists(started.pid), false, 'the killed run must not still answer');

    const result = runProcess(join(sandbox.root, 'dist', 'cli.js'), ['runs', '-C', cwd, '--json'], {
      cwd,
      env: readerEnv(cwd),
    });

    assert.equal(result.code, 0, 'runs must succeed: ' + result.stderr);
    const runs = JSON.parse(result.stdout);
    assert.equal(runs.length, 1, 'expected one run in the ledger');
    assert.equal(runs[0].status, 'running', 'nothing settled it, so the ledger still says running');
    assert.equal(runs[0].live, 'died', 'a run whose process is gone must read died');
  });

  test('runs shows - for a run that settled (T4c-2 criterion 2 e2e)', () => {
    const cwd = fresh();
    const planFile = join(cwd, 'run-plan.json');
    writeFileSync(planFile, JSON.stringify(WINNING_RUN), 'utf8');

    const run = runProcess(
      join(sandbox.root, 'dist', 'cli.js'),
      ['run', '--auto', '--json', 'test goal'],
      {
        cwd,
        env: {
          EXOLVRA_GENESIS_RUN_FAKE: planFile,
          HOME: cwd,
          USERPROFILE: cwd,
          APPDATA: cwd,
          XDG_CONFIG_HOME: cwd,
        },
      },
    );
    assert.equal(run.code, 0, 'a winning run exits 0: ' + run.stderr);

    // The pid that run used is gone now, and the answer must not depend on that:
    // the closed row is what says the run settled.
    assert.equal(pidExists(run.pid), false, 'the finished run process must be gone');

    const result = runProcess(join(sandbox.root, 'dist', 'cli.js'), ['runs', '-C', cwd, '--json'], {
      cwd,
      env: readerEnv(cwd),
    });

    assert.equal(result.code, 0, 'runs must succeed: ' + result.stderr);
    const runs = JSON.parse(result.stdout);
    assert.equal(runs.length, 1, 'expected one run in the ledger');
    assert.equal(runs[0].status, 'complete');
    assert.equal(runs[0].live, '-', 'a settled run is not applicable, not dead');
  });

  test('runs shows ? for a run with no trace at all', () => {
    const cwd = fresh();

    const dir = join(cwd, '.exolvra-genesis');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'runs.json'),
      JSON.stringify([
        {
          id: 'r-20260821-1234-abc123',
          input: 'test goal',
          status: 'running',
          models: { lead: 'claude-opus-4-5-20251101', builder: 'opus', critic: 'sonnet' },
          sessionId: 'sesn_test',
          startedAt: new Date().toISOString(),
        },
      ]) + '\n',
      'utf8',
    );

    const result = runProcess(join(sandbox.root, 'dist', 'cli.js'), ['runs', '-C', cwd, '--json'], {
      cwd,
      env: readerEnv(cwd),
    });

    assert.equal(result.code, 0, 'runs must succeed: ' + result.stderr);
    const runs = JSON.parse(result.stdout);
    assert.equal(runs.length, 1, 'expected one run in the ledger');
    assert.equal(runs[0].status, 'running');
    assert.equal(runs[0].live, '?', 'a run with no trace must say it does not know');
  });

  test('the table carries the column, in the order the help promises', () => {
    const cwd = fresh();
    const planFile = join(cwd, 'run-plan.json');
    writeFileSync(planFile, JSON.stringify(WINNING_RUN), 'utf8');

    const run = runProcess(
      join(sandbox.root, 'dist', 'cli.js'),
      ['run', '--auto', '--json', 'test goal'],
      {
        cwd,
        env: {
          EXOLVRA_GENESIS_RUN_FAKE: planFile,
          HOME: cwd,
          USERPROFILE: cwd,
          APPDATA: cwd,
          XDG_CONFIG_HOME: cwd,
        },
      },
    );
    assert.equal(run.code, 0, 'a winning run exits 0: ' + run.stderr);

    const result = runProcess(join(sandbox.root, 'dist', 'cli.js'), ['runs', '-C', cwd], {
      cwd,
      env: { EXOLVRA_GENESIS_FORCE_TTY: '120', ...readerEnv(cwd) },
    });

    assert.equal(result.code, 0, 'runs must succeed: ' + result.stderr);
    const lines = result.stdout.split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 2, 'a header row and the one run:\n' + result.stdout);
    assert.match(lines[0], /^ID {2,}STARTED {2,}INPUT {2,}STATUS {2,}VERDICT {2,}LIVE$/);
    assert.equal(lines[1].split(/ {2,}/)[5], '-', 'the settled run reads as not applicable');
  });

  test('runs --help says what the LIVE column means and how it is decided', () => {
    const help = runProcess(join(sandbox.root, 'dist', 'cli.js'), ['runs', '--help'], {});
    assert.equal(help.code, 0, 'help must succeed: ' + help.stderr);

    assert.match(help.stdout, /LIVE COLUMN/);
    assert.match(help.stdout, /live {2}- the process is running/);
    assert.match(help.stdout, /died {2}- the process was killed/);

    // Read past the wrapping: the paragraph is laid out to a width, so a phrase
    // in it is one line here and two on a narrower one.
    const flowed = help.stdout.replace(/\s+/g, ' ');
    assert.match(flowed, /Pids are recycled by the operating system/);
    assert.match(flowed, /checked against when its process started/);
    assert.match(flowed, /the answer is "\?" rather than a guess/);
  });
});

describe('lead process row (continued)', () => {
  test('readProcesses on nonexistent run returns empty result via spawned process (criterion 6 spawned)', () => {
    const cwd = fresh();
    const traceStorePath = join(sandbox.root, 'dist', 'trace-store.js').replace(/\\/g, '/');

    // Write a script file that imports readProcesses and calls it on a nonexistent run
    const scriptPath = join(cwd, 'test-readprocesses.mjs');
    const scriptContent = `
import { readProcesses } from 'file:///${traceStorePath}';
const reading = readProcesses('${cwd.replace(/\\/g, '/')}', 'r-nonexistent-run-id');
if (!Array.isArray(reading.processes)) {
  console.error('processes is not an array');
  process.exit(1);
}
if (reading.processes.length !== 0) {
  console.error('expected empty array, got ' + reading.processes.length);
  process.exit(1);
}
if (reading.degraded !== false) {
  console.error('expected degraded to be false');
  process.exit(1);
}
// Success - empty result, no throw, not degraded
process.exit(0);
`;
    writeFileSync(scriptPath, scriptContent, 'utf8');

    // runProcess already uses process.execPath, so we pass scriptPath as first arg
    const result = runProcess(scriptPath, [], {
      cwd,
      env: {
        HOME: cwd,
        USERPROFILE: cwd,
        APPDATA: cwd,
        XDG_CONFIG_HOME: cwd,
      },
    });

    // readProcesses on nonexistent run must exit 0 (no error thrown)
    assert.equal(result.code, 0, 'readProcesses on nonexistent run must not throw: ' + result.stderr);
  });
});
