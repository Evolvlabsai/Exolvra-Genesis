import assert from 'node:assert/strict';
import {
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
import { after, test } from 'node:test';

import { splitFrontmatter } from '../dist/agents.js';
import { configPath } from '../dist/config.js';
import { loadPluginSources } from '../dist/plugin-dir.js';
import { PACKAGE_ROOT, REPO_ROOT, createSandbox, runProcess } from './run-cli.js';
import {
  CTRL_C,
  ENTER,
  cursorVisible,
  fakeTty,
  frames,
  press,
  screen,
  sleep,
  waitFor,
} from './tty.js';

/*
 * `gauntlet run`, driven end to end as a real process.
 *
 * The Claude Agent SDK is the only thing substituted — the bar allows exactly
 * that and nothing else — and it is substituted at the same seam the CLI already
 * has for it, `src/session.ts`. Everything on this side of that seam is the
 * compiled binary the package ships: the flag boundary, the startup decision,
 * the reporter, the run ledger, the budget guards, the signal handling, and the
 * exit codes all run for real, in a child process, against a temp directory.
 *
 * The fake below is a script rather than a mock: each phase says what the agent
 * says, what it costs, and how the turn ends. Nothing in it knows what the CLI
 * is going to do with any of that.
 */

/* -------------------------------------------------------------------------- */
/* The fake transport                                                          */
/* -------------------------------------------------------------------------- */

const FAKE_SDK = `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Which turn of the run this is. One process, one counter. */
let phaseIndex = 0;

export function query({ prompt, options }) {
  const plan = JSON.parse(readFileSync(process.env.GAUNTLET_RUN_FAKE, 'utf8'));
  const phase = plan.phases[Math.min(phaseIndex, plan.phases.length - 1)];
  phaseIndex += 1;

  const record = process.env.GAUNTLET_RUN_FAKE_OPTIONS;
  if (record !== undefined && record !== '') {
    const seen = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : [];
    seen.push({
      prompt,
      cwd: options.cwd,
      model: options.model ?? null,
      maxTurns: options.maxTurns ?? null,
      maxBudgetUsd: options.maxBudgetUsd ?? null,
      permissionMode: options.permissionMode ?? null,
      resume: options.resume ?? null,
      agents: options.agents,
    });
    writeFileSync(record, JSON.stringify(seen, null, 2), 'utf8');
  }

  // A provider that never starts: no interpreter, no credential. The CLI reads
  // this as an environment the user has to fix, and exits 2.
  if (phase.fail === 'start') {
    throw new Error('Failed to spawn Claude Code process: spawn node ENOENT');
  }

  const sessionId = phase.sessionId ?? 'sesn_fake_run';
  let release = () => {};
  const held = new Promise((resolve) => {
    release = resolve;
  });

  const writeState = (status) => {
    const file = join(options.cwd, '.gauntlet', 'state.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ status }, null, 2) + '\\n', 'utf8');
  };

  return {
    async interrupt() {
      release();
    },
    async *[Symbol.asyncIterator]() {
      // A number or a list of them: which messages are followed by a Ctrl+C.
      const interruptAt = Array.isArray(phase.interruptAfter)
        ? phase.interruptAfter
        : phase.interruptAfter === undefined
          ? []
          : [phase.interruptAfter];
      let sent = 0;
      for (const text of phase.messages ?? []) {
        yield {
          type: 'assistant',
          session_id: sessionId,
          message: { content: [{ type: 'text', text }] },
        };
        sent += 1;
        if (interruptAt.includes(sent)) {
          // Windows cannot deliver a signal from one process to another: a
          // process.kill of SIGINT terminates the target outright and no
          // handler ever runs. So the signal is raised inside the process
          // under test, which dispatches the same listeners, in the same
          // order, that a real Ctrl+C dispatches on every platform.
          process.emit('SIGINT');
        }
        if (phase.failAfter === sent) {
          // A fault in the integration itself, mid-stream: nothing the user
          // configures makes it go away, so the CLI reports it as its own bug
          // and exits 1 rather than dressing it up as an environment.
          throw new TypeError('reading session_id of undefined');
        }
        if (phase.holdAfter === sent) {
          await held;
          return;
        }
      }
      if (phase.state !== undefined) writeState(phase.state);
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
 * The package's own dependencies, linked rather than copied into the sandbox.
 *
 * The SDK is left alone: the sandbox already holds the fake in its place, and
 * that one substitution is the whole of what is faked here.
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

const sandbox = createSandbox();
linkDependencies(sandbox.root);
writeFileSync(
  join(sandbox.root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'index.js'),
  FAKE_SDK,
  'utf8',
);

const WORKSPACES = [];
after(() => {
  sandbox.cleanup();
  for (const dir of WORKSPACES) {
    // Tidying up, and only that. A detached handler that a run opened may still
    // hold its working directory on Windows, and a temp directory that outlives
    // the suite is not a result worth failing over.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Left for the operating system to reclaim.
    }
  }
});

/** A fresh directory for one run to work in, and to write its ledger under. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-run-'));
  WORKSPACES.push(dir);
  return dir;
}

/**
 * Runs the built binary against a scripted transport.
 *
 * Every option the run was started with is recorded by the fake, so what
 * reached the SDK can be read back rather than assumed.
 */
function runRun(args, { phases, cwd = workspace(), env = {} } = {}) {
  const script = join(cwd, 'fake-sdk.json');
  writeFileSync(script, JSON.stringify({ phases }, null, 2), 'utf8');
  const record = join(cwd, 'sdk-options.json');

  const result = runProcess(sandbox.bin, args, {
    cwd,
    env: {
      GAUNTLET_RUN_FAKE: script,
      GAUNTLET_RUN_FAKE_OPTIONS: record,
      GAUNTLET_PLUGIN_DIR: REPO_ROOT,
      // A config of the machine's own would make these runs depend on whoever
      // ran them, so every run below is given an empty one to read.
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
    sent: () => JSON.parse(readFileSync(record, 'utf8')),
    runs: () => JSON.parse(readFileSync(join(cwd, '.gauntlet', 'runs.json'), 'utf8')),
    stateText: () => readFileSync(join(cwd, '.gauntlet', 'state.json'), 'utf8'),
    state: () => JSON.parse(readFileSync(join(cwd, '.gauntlet', 'state.json'), 'utf8')),
  };
}

/** One assistant message carrying a round marker. */
function round(piece, number, verdict, gap = '') {
  return (
    'Round ' +
    number +
    ' of ' +
    piece +
    ' has been judged.\n' +
    '@gauntlet round ' +
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
  '@gauntlet bar .gauntlet/bar',
  '@gauntlet artifact .gauntlet/bar/gh/root-help.txt | gh --help',
  '@gauntlet artifact .gauntlet/bar/gh/leaf-help-flags.txt | gh run list --help',
  '@gauntlet piece P1 | The flag table and the leaf help',
  '@gauntlet piece P2 | The exit-code contract',
].join('\n');

/** A run that judges three rounds and finishes complete. */
const WINNING_RUN = [
  {
    messages: [OPENING, round('P1', 1, 'LOSS', 'the flag table omits defaults'), round('P1', 2, 'WIN'), round('P2', 1, 'WIN')],
    state: 'complete',
    result: { text: 'Both pieces won twice in a row.', costUsd: 0.42 },
  },
];

/** The lines of stdout that parse as JSON, for a --json run. */
function ndjson(stdout) {
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/* -------------------------------------------------------------------------- */
/* R1 — what the argument is                                                   */
/* -------------------------------------------------------------------------- */

test('R1: a goal is a goal, and an existing file is a spec', () => {
  const goal = runRun(['run', '--auto', '--json', 'a CLI indistinguishable from gh'], {
    phases: WINNING_RUN,
  });
  assert.equal(goal.code, 0, goal.stderr);
  const started = ndjson(goal.stdout)[0];
  assert.deepEqual(started, {
    type: 'run_started',
    goal: 'a CLI indistinguishable from gh',
    source: 'goal',
  });

  const cwd = workspace();
  const spec = join(cwd, 'checkout.md');
  writeFileSync(spec, '# Checkout\n\nR1. It works.\n', 'utf8');
  const fromSpec = runRun(['run', '--auto', '--json', spec], {
    phases: WINNING_RUN,
    cwd,
  });
  assert.equal(fromSpec.code, 0, fromSpec.stderr);
  assert.equal(ndjson(fromSpec.stdout)[0].source, 'spec');
  // The agent is handed the path, so the spec it reads is the file that was named.
  assert.ok(fromSpec.sent()[0].prompt.includes(spec));
});

test('R1: a path that does not exist is a goal, not a missing file', () => {
  const result = runRun(['run', '--auto', '--json', 'src/does-not-exist.tsx'], {
    phases: WINNING_RUN,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(ndjson(result.stdout)[0].source, 'goal');
});

test('R1: a missing goal with no terminal to ask is a usage error', () => {
  const result = runRun(['run'], { phases: WINNING_RUN });
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /accepts 1 arg, received 0/);
  assert.match(result.stderr, /gauntlet run \[<goal-or-spec-path>\] \[flags\]/);
  assert.match(result.stderr, /only when both ends are a terminal/);
});

test('R1: a missing goal under --json names --json as the reason', () => {
  const result = runRun(['run', '--json'], { phases: WINNING_RUN });
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /accepts 1 arg, received 0/);
  // --json puts no questions even with a terminal on both ends, so it is the
  // reason nothing was asked. Telling somebody at a terminal that they need a
  // terminal points them at the one thing that is not wrong.
  assert.match(result.stderr, /--json is a stream for a machine to read/);
  assert.equal(
    result.stderr.includes('only when both ends are a terminal'),
    false,
    'the message blamed the terminal for a decision --json made',
  );
});

/* -------------------------------------------------------------------------- */
/* R4 — the review pause, and who never gets one                               */
/* -------------------------------------------------------------------------- */

test('R4: a run with no terminal never pauses, and never asks anything', () => {
  const result = runRun(['run', '--json', 'a goal'], { phases: WINNING_RUN });

  assert.equal(result.code, 0, result.stderr);
  const sent = result.sent();
  assert.equal(sent.length, 1, 'a run that did not pause takes exactly one turn');
  // The pause is skipped the way the loaded markdown skips it, by the word it
  // documents for exactly that — not by the CLI deciding to do less.
  assert.match(sent[0].prompt, /\nauto a goal\n|auto a goal/);
  assert.equal(sent[0].resume, null, 'nothing was resumed, so nothing was paused');
});

test('R4: --auto reaches the same turn as a piped run does', () => {
  const result = runRun(['run', '--auto', '--json', 'a goal'], { phases: WINNING_RUN });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.sent()[0].prompt.includes('auto a goal'));
});

/* -------------------------------------------------------------------------- */
/* R7 — the models each role runs on                                           */
/* -------------------------------------------------------------------------- */

const AGENT_NAMES = (() => {
  const sources = loadPluginSources({ GAUNTLET_PLUGIN_DIR: REPO_ROOT });
  return {
    builder: splitFrontmatter(sources.builderMd).fields.name,
    critic: splitFrontmatter(sources.criticMd).fields.name,
  };
})();

test('R7: every model flag reaches the session and the agent definitions', () => {
  const result = runRun(
    [
      'run',
      '--auto',
      '--json',
      '--model',
      'claude-opus-5',
      '--builder-model',
      'sonnet',
      '--critic-model',
      'haiku',
      'a goal',
    ],
    { phases: WINNING_RUN },
  );

  assert.equal(result.code, 0, result.stderr);
  const [sent] = result.sent();
  assert.equal(sent.model, 'claude-opus-5', 'the lead runs on the id it was given');
  assert.equal(sent.agents[AGENT_NAMES.builder].model, 'sonnet');
  assert.equal(sent.agents[AGENT_NAMES.critic].model, 'haiku');
});

test('R7: a role left unset inherits, and is never sent a model', () => {
  const result = runRun(['run', '--auto', '--json', 'a goal'], { phases: WINNING_RUN });
  assert.equal(result.code, 0, result.stderr);
  const [sent] = result.sent();
  assert.equal(sent.model, null, 'inherit means no model reaches the SDK at all');
  assert.equal(sent.agents[AGENT_NAMES.builder].model, 'inherit');
  assert.equal(sent.agents[AGENT_NAMES.critic].model, 'inherit');
});

test('R7: the ledger records the models the run was started with', () => {
  const result = runRun(
    ['run', '--auto', '--json', '--builder-model', 'sonnet', 'a goal'],
    { phases: WINNING_RUN },
  );
  assert.equal(result.code, 0, result.stderr);
  const [record] = result.runs();
  assert.deepEqual(record.models, {
    lead: 'inherit',
    builder: 'sonnet',
    critic: 'inherit',
  });
});

/* -------------------------------------------------------------------------- */
/* R13 — flag over config, config over inherit                                 */
/* -------------------------------------------------------------------------- */

/** Writes a saved config where this platform's convention puts one. */
function saveConfigIn(cwd, config) {
  const path = configPath({
    env: { HOME: cwd, USERPROFILE: cwd, APPDATA: cwd, XDG_CONFIG_HOME: cwd },
    platform: process.platform,
  });
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return path;
}

test('R13: a saved config supplies what no flag did', () => {
  const cwd = workspace();
  saveConfigIn(cwd, { models: { lead: 'claude-sonnet-5', builder: 'haiku', critic: 'haiku' } });

  const result = runRun(['run', '--auto', '--json', 'a goal'], {
    phases: WINNING_RUN,
    cwd,
  });
  assert.equal(result.code, 0, result.stderr);
  const [sent] = result.sent();
  assert.equal(sent.model, 'claude-sonnet-5');
  assert.equal(sent.agents[AGENT_NAMES.builder].model, 'haiku');
});

test('R13: a flag beats the saved config', () => {
  const cwd = workspace();
  saveConfigIn(cwd, { models: { lead: 'claude-sonnet-5', builder: 'haiku', critic: 'haiku' } });

  const result = runRun(
    ['run', '--auto', '--json', '--model', 'claude-opus-5', '--builder-model', 'sonnet', 'a goal'],
    { phases: WINNING_RUN, cwd },
  );
  assert.equal(result.code, 0, result.stderr);
  const [sent] = result.sent();
  assert.equal(sent.model, 'claude-opus-5', 'the flag, not the config, reached the SDK');
  assert.equal(sent.agents[AGENT_NAMES.builder].model, 'sonnet');
  // The role no flag named still comes from the config.
  assert.equal(sent.agents[AGENT_NAMES.critic].model, 'haiku');
});

test('R13: --no-config skips the saved answers entirely', () => {
  const cwd = workspace();
  saveConfigIn(cwd, { models: { lead: 'claude-sonnet-5', builder: 'haiku', critic: 'haiku' } });

  const result = runRun(['run', '--auto', '--json', '--no-config', 'a goal'], {
    phases: WINNING_RUN,
    cwd,
  });
  assert.equal(result.code, 0, result.stderr);
  const [sent] = result.sent();
  assert.equal(sent.model, null);
  assert.equal(sent.agents[AGENT_NAMES.builder].model, 'inherit');
});

/* -------------------------------------------------------------------------- */
/* R10 — the budget guards                                                     */
/* -------------------------------------------------------------------------- */

test('R10: --max-rounds stops at the limit, in both files, resumably', () => {
  const result = runRun(['run', '--auto', '--max-rounds', '2', 'a goal'], {
    phases: [
      {
        messages: [
          OPENING,
          round('P1', 1, 'LOSS', 'the columns are ragged'),
          round('P1', 2, 'LOSS', 'the flag table omits defaults'),
          round('P1', 3, 'WIN'),
        ],
        holdAfter: 3,
        result: { text: 'never reached', costUsd: 5 },
      },
    ],
  });

  assert.equal(result.code, 1, 'a budget-stopped run exits 1: ' + result.stderr);
  assert.match(result.stdout, /--max-rounds guard stopped the run: 2 rounds judged/);

  const [record] = result.runs();
  assert.equal(record.status, 'stopped', 'runs.json must record it as stopped');
  assert.equal(record.rounds, 2, 'it stopped at the limit, not past it');
  assert.equal(record.sessionId, 'sesn_fake_run', 'a stopped run keeps its session');
  assert.equal(result.state().status, 'stopped', 'state.json must record it as stopped');
  assert.match(result.stdout, /gauntlet resume r-/);
});

test('R10: --max-cost stops an unfinished run on the provider figure', () => {
  const result = runRun(['run', '--auto', '--json', '--max-cost', '1', 'a goal'], {
    phases: [
      {
        messages: [OPENING, round('P1', 1, 'LOSS', 'not yet')],
        result: { text: 'stopping here', costUsd: 1.5 },
      },
    ],
  });

  assert.equal(result.code, 1, 'a cost-stopped run exits 1: ' + result.stderr);
  const events = ndjson(result.stdout);
  const warned = events.find(
    (event) => event.type === 'notice' && event.level === 'warning',
  );
  assert.match(warned.message, /--max-cost guard stopped the run: \$1\.50 spent/);

  const summary = events[events.length - 1];
  assert.equal(summary.status, 'stopped');
  assert.equal(summary.cost_usd, 1.5, 'the summary carries the provider figure');

  assert.equal(result.runs()[0].status, 'stopped');
  assert.equal(result.runs()[0].costUsd, 1.5);
  assert.equal(result.state().status, 'stopped');
});

test('R10: --max-cost is handed to the provider, so it can stop at the limit', () => {
  const capped = runRun(['run', '--auto', '--json', '--max-cost', '2.50', 'a goal'], {
    phases: WINNING_RUN,
  });
  assert.equal(capped.code, 0, capped.stderr);
  // The CLI only learns what a turn cost when the turn reports it, which is
  // after the money is spent. The provider is told the limit so it can end the
  // query at it; the CLI's own check is what catches the gap between turns.
  assert.equal(capped.sent()[0].maxBudgetUsd, 2.5, 'the limit never reached the SDK');

  const uncapped = runRun(['run', '--auto', '--json', 'a goal'], { phases: WINNING_RUN });
  assert.equal(uncapped.sent()[0].maxBudgetUsd, null, 'a limit nobody set was sent');
});

test('R10: resume hands its own limit to the provider too', () => {
  const cwd = workspace();
  const seeded = seedLedger(cwd);
  const result = runRun(['resume', seeded.id, '--max-cost', '3'], {
    cwd,
    phases: [
      {
        messages: [round('P2', 2, 'WIN')],
        state: 'complete',
        result: { text: 'done', costUsd: 0.25 },
      },
    ],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.sent()[0].maxBudgetUsd, 3);
});

test('R10: going over budget never un-wins a run that won', () => {
  // The same script twice, one flag apart. A guard is a limit on spending, not
  // a verdict on the work: if it were, the flag alone would turn a win into a
  // loss, and the run would then be offered for resuming — spending more money
  // re-doing work that already met the win condition.
  const script = [
    {
      messages: [OPENING, round('P1', 1, 'WIN'), round('P2', 1, 'WIN')],
      state: 'complete',
      result: { text: 'both pieces won', costUsd: 1.5 },
    },
  ];

  const plain = runRun(['run', '--auto', '--json', 'a goal'], { phases: script });
  const capped = runRun(['run', '--auto', '--json', '--max-cost', '1', 'a goal'], {
    phases: script,
  });

  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(capped.code, 0, 'the flag alone turned a win into a loss: ' + capped.stdout);

  const summary = ndjson(capped.stdout).at(-1);
  assert.equal(summary.status, 'win');
  assert.equal(summary.cost_usd, 1.5);
  assert.equal(capped.runs()[0].status, 'complete', 'a won run was left resumable');
  assert.equal(capped.state().status, 'complete');

  // The overrun is still said — it is worth knowing what the run cost — it is
  // just not a verdict.
  const warned = ndjson(capped.stdout).find(
    (event) => event.type === 'notice' && event.level === 'warning',
  );
  assert.match(warned.message, /--max-cost guard stopped the run: \$1\.50 spent/);
  assert.equal(
    ndjson(plain.stdout).some(
      (event) => event.type === 'notice' && event.level === 'warning',
    ),
    false,
    'the uncapped run warned about a limit it never had',
  );
});

test('R10: a guard that was not set never trips', () => {
  const result = runRun(['run', '--auto', '--json', 'a goal'], { phases: WINNING_RUN });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    !ndjson(result.stdout).some(
      (event) => event.type === 'notice' && /guard stopped/.test(event.message ?? ''),
    ),
    'no guard may trip when none was set',
  );
});

/* -------------------------------------------------------------------------- */
/* R10 — Ctrl+C                                                                */
/* -------------------------------------------------------------------------- */

test('R10: SIGINT stops the run, records it, and prints how to resume it', () => {
  const result = runRun(['run', '--auto', 'a goal'], {
    phases: [
      {
        messages: [OPENING, round('P1', 1, 'LOSS', 'the gap survived a round')],
        interruptAfter: 2,
        holdAfter: 2,
        result: { text: 'never reached', costUsd: 9 },
      },
    ],
  });

  assert.equal(result.code, 1, 'an interrupted run exits 1: ' + result.stderr);

  const [record] = result.runs();
  assert.equal(record.status, 'stopped');
  assert.equal(record.sessionId, 'sesn_fake_run');
  assert.equal(result.state().status, 'stopped');

  // The exact command, with the id the ledger recorded — not a description of it.
  assert.ok(
    result.stdout.includes('gauntlet resume ' + record.id),
    'the resume command was never printed:\n' + result.stdout,
  );
});

test('R10: an interrupted run is left resumable, with its rounds intact', () => {
  const result = runRun(['run', '--auto', '--json', 'a goal'], {
    phases: [
      {
        messages: [OPENING, round('P1', 1, 'WIN'), round('P2', 1, 'LOSS', 'no evidence')],
        interruptAfter: 3,
        holdAfter: 3,
      },
    ],
  });

  assert.equal(result.code, 1);
  const summary = ndjson(result.stdout).at(-1);
  assert.equal(summary.status, 'stopped');
  assert.equal(summary.rounds, 2, 'the rounds it did judge are still reported');
  assert.equal(summary.session_id, 'sesn_fake_run');
  assert.equal(result.runs()[0].lastVerdict, 'LOSS');
});

test('R10: a second interrupt ends it at once, and reports the run only once', () => {
  const result = runRun(['run', '--auto', '--json', 'a goal'], {
    phases: [
      {
        messages: [OPENING, round('P1', 1, 'WIN'), 'Still working on P2.'],
        // Two Ctrl+Cs, and a transport that never ends the turn on its own: the
        // second one is what the process has to exit on.
        interruptAfter: [2, 3],
        hold: true,
      },
    ],
  });

  assert.equal(result.code, 1, 'a twice-interrupted run still exits 1');
  const summaries = ndjson(result.stdout).filter(
    (event) => event.status !== undefined && event.type === undefined,
  );
  assert.ok(
    summaries.length <= 1,
    'the run was summarised ' + summaries.length + ' times',
  );
  for (const line of result.stdout.split('\n').filter((line) => line !== '')) {
    assert.doesNotThrow(
      () => JSON.parse(line),
      'the second interrupt cut a line in half: ' + JSON.stringify(line),
    );
  }
});

/* -------------------------------------------------------------------------- */
/* R12 — the machine view                                                      */
/* -------------------------------------------------------------------------- */

test('R12: --json puts nothing but JSON on stdout', () => {
  const result = runRun(['run', '--auto', '--json', '--verbose', 'a goal'], {
    phases: WINNING_RUN,
  });

  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.split('\n').filter((line) => line !== '');
  assert.ok(lines.length >= 6, 'expected a line per event, got ' + lines.length);
  for (const line of lines) {
    assert.doesNotThrow(
      () => JSON.parse(line),
      'a line of --json output did not parse: ' + JSON.stringify(line),
    );
  }
});

test('R12: the last line is the summary, and is exactly four fields', () => {
  const result = runRun(['run', '--auto', '--json', 'a goal'], { phases: WINNING_RUN });
  const summary = ndjson(result.stdout).at(-1);
  assert.deepEqual(Object.keys(summary).sort(), [
    'cost_usd',
    'rounds',
    'session_id',
    'status',
  ]);
  assert.deepEqual(summary, {
    status: 'win',
    rounds: 3,
    cost_usd: 0.42,
    session_id: 'sesn_fake_run',
  });
});

test('R12: every round reaches the machine view whole', () => {
  const result = runRun(['run', '--auto', '--json', 'a goal'], { phases: WINNING_RUN });
  const rounds = ndjson(result.stdout).filter((event) => event.type === 'round');
  assert.equal(rounds.length, 3);

  const { elapsed_ms: elapsed, ...first } = rounds[0];
  assert.deepEqual(first, {
    type: 'round',
    piece: 'P1',
    round: 1,
    verdict: 'LOSS',
    gap: 'the flag table omits defaults',
  });
  // Measured rather than declared, so the value is a real duration and not a
  // number this test could have supplied.
  assert.equal(typeof elapsed, 'number');
  assert.ok(elapsed >= 0 && elapsed < 60_000, 'a round took ' + elapsed + 'ms');
  for (const event of rounds) assert.equal(typeof event.elapsed_ms, 'number');

  assert.equal(rounds[1].gap, null, 'a win carries no gap');
});

test('R12: a gap keeps everything in it, delimiter and all', () => {
  // A gap is one sentence a critic wrote about work that failed, and a sentence
  // is entitled to contain the character this protocol separates fields with.
  const gap =
    String.raw`the flag table omits defaults | the usage line says "gauntlet run" | the path C:\a\b is cut`;
  const result = runRun(['run', '--auto', '--json', 'a goal'], {
    phases: [
      {
        messages: [OPENING, round('P1', 1, 'LOSS', gap)],
        state: 'complete',
        result: { text: 'done', costUsd: 0.1 },
      },
    ],
  });

  assert.equal(result.code, 0, result.stderr);
  const judged = ndjson(result.stdout).find((event) => event.type === 'round');
  assert.equal(judged.gap, gap, 'the gap was cut at a delimiter inside it');

  // And the piece, the number and the verdict are still their own fields: the
  // last field takes the rest, and the ones before it do not.
  assert.equal(judged.piece, 'P1');
  assert.equal(judged.round, 1);
  assert.equal(judged.verdict, 'LOSS');

  // The piped view hands it over whole as well; only a terminal cuts it, and
  // only to fit a column.
  const piped = runRun(['run', '--auto', 'a goal'], {
    phases: [
      {
        messages: [OPENING, round('P1', 1, 'LOSS', gap)],
        state: 'complete',
        result: { text: 'done', costUsd: 0.1 },
      },
    ],
  });
  assert.ok(piped.stdout.includes(gap), 'the piped record cut the gap:\n' + piped.stdout);
});

test('R12: a bar captured before the stream dropped is still reported', () => {
  // The turn never produces a result, so nothing about it went well — and the
  // bar it did capture is a fact about the run either way.
  const result = runRun(['run', '--auto', '--json', 'a goal'], {
    phases: [{ messages: [OPENING], holdAfter: 1, interruptAfter: 1 }],
  });

  assert.equal(result.code, 1);
  const events = ndjson(result.stdout);
  const bar = events.find((event) => event.type === 'bar_captured');
  assert.ok(bar !== undefined, 'the captured bar was never reported:\n' + result.stdout);
  assert.equal(bar.path, '.gauntlet/bar');
  assert.equal(bar.artifacts.length, 2);
  assert.ok(events.some((event) => event.type === 'plan_ready'), result.stdout);
});

test('R12: a report line this build cannot read is said out loud, once', () => {
  const result = runRun(['run', '--auto', '--json', 'a goal'], {
    phases: [
      {
        messages: [
          OPENING,
          '@gauntlet round P1 | not-a-number | WIN |',
          '@gauntlet nonsense whatever',
          round('P1', 1, 'WIN'),
        ],
        state: 'complete',
        result: { text: 'done', costUsd: 0.1 },
      },
    ],
  });

  assert.equal(result.code, 0, result.stderr);
  const warnings = ndjson(result.stdout).filter(
    (event) => event.type === 'notice' && /cannot read/.test(event.message ?? ''),
  );
  // Once: a run that says it forty times has buried the verdicts it was meant
  // to be reporting.
  assert.equal(warnings.length, 1, 'expected exactly one warning, got ' + warnings.length);
  assert.match(warnings[0].message, /@gauntlet round P1 \| not-a-number \| WIN \|/);

  // And the round that was readable is still judged.
  assert.equal(
    ndjson(result.stdout).filter((event) => event.type === 'round').length,
    1,
  );
});

test('R12: the plan is reported when it arrives, not held back', () => {
  const result = runRun(['run', '--auto', '--json', '--verbose', 'a goal'], {
    phases: [
      {
        messages: [
          OPENING,
          'Fanning out builders for P1 and P2 now that the plan is settled.',
          round('P1', 1, 'WIN'),
        ],
        state: 'complete',
        result: { text: 'done', costUsd: 0.1 },
      },
    ],
  });

  assert.equal(result.code, 0, result.stderr);
  const events = ndjson(result.stdout);
  const at = (predicate) => events.findIndex(predicate);

  // The pieces arrive in one message, so the plan is known at the end of that
  // message — not held back until the first verdict, which printed the work
  // done against the plan above the plan itself.
  const plan = at((event) => event.type === 'plan_ready');
  const fanOut = at((event) => /^Fanning out builders/.test(event.text ?? ''));
  const round1 = at((event) => event.type === 'round');

  assert.ok(plan !== -1, 'the plan was never reported');
  assert.ok(fanOut !== -1, 'the later report was never printed');
  assert.ok(plan < fanOut, 'a later report printed above the piece list it was about');
  assert.ok(plan < round1, 'the plan was held back until a verdict');

  // The prose that came before the markers in the same message still comes
  // first, because that is the order the agent wrote it in.
  const opening = at((event) => /^I picked the gh transcripts/.test(event.text ?? ''));
  assert.ok(opening !== -1 && opening < plan, 'document order was not preserved');
});

test('R12: a report is shown above the verdict it produced, not below it', () => {
  const result = runRun(['run', '--auto', '--json', '--verbose', 'a goal'], {
    phases: [
      {
        messages: [
          OPENING,
          [
            'P1 is done; the flag table now carries every default.',
            round('P1', 1, 'WIN'),
            'Moving on to P2.',
            round('P2', 1, 'LOSS', 'exit 2 is documented but never produced'),
          ].join('\n'),
        ],
        state: 'complete',
        result: { text: 'done', costUsd: 0.1 },
      },
    ],
  });

  assert.equal(result.code, 0, result.stderr);
  // The order the agent wrote them in is the order they are reported in: a
  // verdict above the report that produced it reads as though the work came
  // after the judgement.
  const order = ndjson(result.stdout)
    .filter((event) => event.type === 'agent_output' || event.type === 'round')
    .map((event) => (event.type === 'round' ? 'round ' + event.piece : event.text.split('\n')[0]));

  const p1Report = order.indexOf('P1 is done; the flag table now carries every default.');
  const p1Round = order.indexOf('round P1');
  const p2Report = order.indexOf('Moving on to P2.');
  const p2Round = order.indexOf('round P2');
  assert.ok(p1Report !== -1 && p2Report !== -1, order.join(' | '));
  assert.ok(p1Report < p1Round, 'the P1 verdict came before its report: ' + order.join(' | '));
  assert.ok(p1Round < p2Report, 'the reports were drained after the verdicts');
  assert.ok(p2Report < p2Round, 'the P2 verdict came before its report');
});

test('R12: the bar and the pieces are reported before the first round', () => {
  const result = runRun(['run', '--auto', '--json', 'a goal'], { phases: WINNING_RUN });
  const events = ndjson(result.stdout);
  const types = events.map((event) => event.type);
  assert.ok(types.indexOf('bar_captured') < types.indexOf('plan_ready'));
  assert.ok(types.indexOf('plan_ready') < types.indexOf('round'));

  const bar = events.find((event) => event.type === 'bar_captured');
  assert.equal(bar.path, '.gauntlet/bar');
  assert.equal(bar.artifacts.length, 2);
  assert.deepEqual(bar.artifacts[0], {
    path: '.gauntlet/bar/gh/root-help.txt',
    detail: 'gh --help',
  });

  const plan = events.find((event) => event.type === 'plan_ready');
  assert.deepEqual(plan.pieces.map((piece) => piece.id), ['P1', 'P2']);
});

test('R12: the human view prints a column per round and no marker lines', () => {
  const result = runRun(['run', '--auto', 'a goal'], {
    phases: WINNING_RUN,
    env: { GAUNTLET_FORCE_TTY: '80' },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(!result.stdout.includes('@gauntlet'), 'a marker line reached the reader');
  // piece, round, verdict, elapsed, gap — five columns, in that order, with the
  // gap last because it is the only one that may be cut to fit.
  assert.match(result.stdout, /^P1 +1 +. LOSS +\d+s +the flag table omits defaults$/m);
  assert.match(result.stdout, /^P1 +2 +. WIN +\d+s$/m);
  assert.match(result.stdout, /^result +. WIN +3 rounds +\$0\.42/m);
  assert.match(result.stdout, /^session +sesn_fake_run$/m);
});

/* -------------------------------------------------------------------------- */
/* The progress page                                                           */
/* -------------------------------------------------------------------------- */

test('the progress page path prints at the start of every run', () => {
  const result = runRun(['run', '--auto', '--json', 'a goal'], { phases: WINNING_RUN });
  const notices = ndjson(result.stdout).filter((event) => event.type === 'notice');
  assert.ok(
    notices.some((notice) => notice.message === '.gauntlet/progress.html'),
    'the progress page was never named:\n' + result.stdout,
  );
});

test('the progress page is named in full once --directory points elsewhere', () => {
  const elsewhere = workspace();
  const result = runRun(['run', '--auto', '--json', '-C', elsewhere, 'a goal'], {
    phases: WINNING_RUN,
  });
  assert.equal(result.code, 0, result.stderr);
  const notices = ndjson(result.stdout).filter((event) => event.type === 'notice');
  assert.ok(
    notices.some(
      (notice) => notice.message === join(elsewhere, '.gauntlet', 'progress.html'),
    ),
    'a redirected run must name the page it really writes:\n' + result.stdout,
  );
  // And the ledger it wrote is the one in the directory it was pointed at.
  assert.equal(
    JSON.parse(readFileSync(join(elsewhere, '.gauntlet', 'runs.json'), 'utf8'))[0].status,
    'complete',
  );
});

test('--open failing to open is a notice, and never the end of the run', () => {
  const result = runRun(['run', '--auto', '--json', '--open', 'a goal'], {
    phases: WINNING_RUN,
    // Nothing this platform opens files with can be found: no PATH for the
    // handler Unix uses, and an interpreter path that is not there for the one
    // Windows uses. That is the failure a headless or stripped-down box has.
    // Windows spells it COMSPEC in the block it hands a child, whatever casing
    // is used to read it back, so both spellings are set here.
    env: {
      PATH: '',
      Path: '',
      COMSPEC: join(sandbox.root, 'no-such-interpreter.exe'),
      ComSpec: join(sandbox.root, 'no-such-interpreter.exe'),
    },
  });

  assert.equal(result.code, 0, 'the run still won: ' + result.stderr);
  const warned = ndjson(result.stdout).find(
    (event) => event.type === 'notice' && event.level === 'warning',
  );
  assert.match(warned.message, /could not be opened/);
  assert.match(warned.message, /open it yourself at .*progress\.html/);
});

test('--open reaches for the handler each platform actually has', async () => {
  const { openerFor } = await import('../dist/open.js');

  assert.deepEqual(openerFor('darwin', {}), { command: 'open', args: [] });
  assert.deepEqual(openerFor('linux', {}), { command: 'xdg-open', args: [] });
  assert.deepEqual(openerFor('freebsd', {}), { command: 'xdg-open', args: [] });

  // `start` is a builtin of the interpreter rather than a program, and the
  // empty argument after it is the window title it would otherwise read the
  // path as — a page whose path is quoted opens nothing at all.
  assert.deepEqual(openerFor('win32', {}), {
    command: 'cmd.exe',
    args: ['/c', 'start', ''],
  });
  assert.deepEqual(openerFor('win32', { ComSpec: 'D:\\os\\cmd.exe' }), {
    command: 'D:\\os\\cmd.exe',
    args: ['/c', 'start', ''],
  });
});

/* -------------------------------------------------------------------------- */
/* C5 — the exit codes, and what the two files say on each path                */
/* -------------------------------------------------------------------------- */

const HOOK_SHAPE = /"status": *"(running|complete|stopped|blocked)"/;

/** Every ending a run has, driven as a real process. */
const ENDINGS = [
  {
    label: 'a run that met its win condition',
    args: ['run', '--auto', '--json', 'a goal'],
    phases: WINNING_RUN,
    code: 0,
    status: 'win',
    ledger: 'complete',
    state: 'complete',
  },
  {
    label: 'a session that ended with the run unfinished',
    args: ['run', '--auto', '--json', 'a goal'],
    phases: [
      {
        messages: [OPENING, round('P1', 1, 'LOSS', 'the gap survived')],
        result: { text: 'I stopped short.', costUsd: 0.1 },
      },
    ],
    code: 1,
    status: 'loss',
    ledger: 'stopped',
    state: 'stopped',
  },
  {
    label: 'a provider that failed part way through',
    args: ['run', '--auto', '--json', 'a goal'],
    phases: [
      {
        messages: [OPENING],
        result: { subtype: 'error_during_execution', errors: ['the provider blew up'] },
      },
    ],
    code: 1,
    status: 'blocked',
    ledger: 'blocked',
    state: 'blocked',
  },
  {
    label: 'a run stopped by a budget guard',
    args: ['run', '--auto', '--json', '--max-rounds', '1', 'a goal'],
    phases: [
      {
        messages: [OPENING, round('P1', 1, 'LOSS', 'not yet'), round('P1', 2, 'WIN')],
        holdAfter: 2,
      },
    ],
    code: 1,
    status: 'stopped',
    ledger: 'stopped',
    state: 'stopped',
  },
  {
    label: 'a run interrupted at the keyboard',
    args: ['run', '--auto', '--json', 'a goal'],
    phases: [
      { messages: [OPENING, round('P1', 1, 'WIN')], interruptAfter: 2, holdAfter: 2 },
    ],
    code: 1,
    status: 'stopped',
    ledger: 'stopped',
    state: 'stopped',
  },
];

for (const ending of ENDINGS) {
  test('C5: ' + ending.label + ' exits ' + ending.code, () => {
    const result = runRun(ending.args, { phases: ending.phases });

    assert.equal(
      result.code,
      ending.code,
      ending.label + ' exited ' + result.code + '\n' + result.stdout + result.stderr,
    );

    const summary = ndjson(result.stdout).at(-1);
    assert.equal(summary.status, ending.status, 'the summary disagreed with the exit');
    assert.equal(result.runs()[0].status, ending.ledger, 'runs.json disagreed');
    assert.equal(result.state().status, ending.state, 'state.json disagreed');

    // The Stop hook the plugin ships greps this file rather than parsing it, so
    // the shape it is written in is part of the contract on every path.
    assert.match(result.stateText(), HOOK_SHAPE);
    assert.doesNotThrow(() => JSON.parse(result.stateText()));
  });
}

/*
 * The Stop hook the plugin ships greps this exact pattern, and blocks a Claude
 * session from ending while it matches. A run that never began must not leave
 * it armed.
 */
const HOOK_ARMED = /"status": *"running"/;

test('a run that could not start a session leaves nothing saying it is running', () => {
  const result = runRun(['run', '--auto', '--json', 'a goal'], {
    phases: [{ fail: 'start' }],
  });

  // The environment is what has to change, so this is a configuration error.
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /could not start a Claude Agent SDK session/);

  // Neither file may be left claiming a run is under way. The hook is the
  // reason this matters: armed, it refuses to let a session end, for a run
  // that never took a turn.
  const state = result.stateText();
  assert.doesNotMatch(state, HOOK_ARMED, 'the Stop hook was left armed:\n' + state);
  assert.equal(result.state().status, 'blocked');
  assert.match(state, /"status": *"blocked"/);

  // And the ledger agrees with it, and with what the other commands will do
  // about it: a row with no session is one there is nothing to go back to.
  const [record] = result.runs();
  assert.equal(record.status, 'blocked');
  assert.equal(record.sessionId, null, 'a session that never started was recorded');
  assert.equal(record.rounds, 0);
});

test('a run stopped by a fault in this CLI settles both files too', () => {
  const result = runRun(['run', '--auto', '--json', 'a goal'], {
    phases: [{ messages: [OPENING, round('P1', 1, 'WIN')], failAfter: 2 }],
  });

  // Nothing classified it, so it is reported as a bug in this CLI and exits 1.
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /unexpected error while running "run"/);

  const state = result.stateText();
  assert.doesNotMatch(state, HOOK_ARMED, 'the Stop hook was left armed:\n' + state);
  assert.equal(result.state().status, 'blocked');

  const [record] = result.runs();
  assert.equal(record.status, 'blocked');
  // This one did reach a session, so it keeps it and stays resumable.
  assert.equal(record.sessionId, 'sesn_fake_run');
  assert.equal(record.rounds, 1, 'the round it did judge is still recorded');
});

test('the three commands agree about a run that never started a session', () => {
  const cwd = workspace();
  const failed = runRun(['run', '--auto', '--json', 'a goal'], {
    cwd,
    phases: [{ fail: 'start' }],
  });
  assert.equal(failed.code, 2);
  const [record] = failed.runs();

  // `runs` lists it, and lists it as over.
  const listed = runRun(['runs', '-C', cwd], { cwd, phases: [{ fail: 'start' }] });
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp('^' + record.id + '\\t.*\\tblocked\\t', 'm'));

  // The picker will not offer it, because there is nothing to go back to — and
  // says so in the words that are true of it.
  const bare = runRun(['resume'], { cwd, phases: [{ fail: 'start' }] });
  assert.equal(bare.code, 2, bare.stdout + bare.stderr);
  assert.match(bare.stderr, /never started a session/);

  // And naming it refuses for the same reason, rather than starting a session
  // on a run that has none.
  const byName = runRun(['resume', record.id], { cwd, phases: [{ fail: 'start' }] });
  assert.equal(byName.code, 2, byName.stdout + byName.stderr);
  assert.match(byName.stderr, /never started a session/);
  assert.match(byName.stderr, /start it again rather than resuming it/);
});

test('C5: a bad flag exits 2 before anything is recorded', () => {
  const result = runRun(['run', '--auto', '--max-cost', 'free', 'a goal'], {
    phases: WINNING_RUN,
  });
  assert.equal(result.code, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /invalid value "free" for --max-cost/);
  assert.throws(() => result.runs(), 'nothing may be recorded for a run that never started');
});

test('C5: state.json says running while the run is still going', () => {
  // Held open by the transport, then interrupted: the file is read from the
  // ledger the run wrote before it ended, so what a hook would have seen
  // mid-run is what is checked here.
  const result = runRun(['run', '--auto', '--json', 'a goal'], {
    phases: [{ messages: [OPENING], interruptAfter: 1, holdAfter: 1 }],
  });
  assert.equal(result.code, 1);
  const [record] = result.runs();
  assert.equal(record.input, 'a goal');
  assert.equal(record.status, 'stopped');
  assert.match(result.stateText(), HOOK_SHAPE);
});

/* -------------------------------------------------------------------------- */
/* Leaf help                                                                   */
/* -------------------------------------------------------------------------- */

test('run --help documents every flag run accepts', async () => {
  const { runCommand } = await import('../dist/commands/run.js');
  const result = runProcess(sandbox.bin, ['run', '--help'], { cwd: sandbox.root });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  for (const flag of runCommand.flags) {
    assert.ok(
      result.stdout.includes('--' + flag.long),
      'the flag table is missing --' + flag.long,
    );
    if (flag.short !== undefined) {
      assert.ok(
        result.stdout.includes('-' + flag.short + ', --' + flag.long),
        'the flag table is missing -' + flag.short,
      );
    }
    if (flag.value !== undefined) {
      assert.ok(
        result.stdout.includes('--' + flag.long + ' ' + flag.value.arg),
        'the flag table is missing the value placeholder for --' + flag.long,
      );
    }
  }
  for (const heading of ['USAGE', 'FLAGS', 'INHERITED FLAGS', 'MODELS', 'BUDGET', 'EXAMPLES']) {
    assert.ok(result.stdout.includes('\n' + heading + '\n'), 'leaf help is missing ' + heading);
  }
});

/* -------------------------------------------------------------------------- */
/* Resume reads the same stream the same way                                   */
/* -------------------------------------------------------------------------- */

/** A ledger holding one stopped run, ready to be resumed. */
function seedLedger(cwd, patch = {}) {
  const record = {
    id: 'r-20260811-0900-abcdef',
    sessionId: 'sesn_fake_run',
    input: 'a CLI indistinguishable from gh',
    models: { lead: 'inherit', builder: 'inherit', critic: 'inherit' },
    startedAt: new Date().toISOString(),
    status: 'stopped',
    rounds: 2,
    costUsd: 1.5,
    lastVerdict: 'LOSS',
    ...patch,
  };
  mkdirSync(join(cwd, '.gauntlet'), { recursive: true });
  writeFileSync(
    join(cwd, '.gauntlet', 'runs.json'),
    JSON.stringify([record], null, 2) + '\n',
    'utf8',
  );
  writeFileSync(
    join(cwd, '.gauntlet', 'state.json'),
    JSON.stringify({ status: 'stopped' }, null, 2) + '\n',
    'utf8',
  );
  return record;
}

test('resume reports rounds and never prints the protocol at the reader', () => {
  const cwd = workspace();
  const seeded = seedLedger(cwd);

  const result = runRun(['resume', seeded.id], {
    cwd,
    phases: [
      {
        messages: [round('P2', 2, 'WIN'), round('P3', 1, 'WIN')],
        state: 'complete',
        result: {
          text: 'Run finished.\n@gauntlet round P3 | 1 | WIN |',
          costUsd: 0.75,
        },
      },
    ],
  });

  assert.equal(result.code, 0, result.stderr);
  // The markers are addressed to this CLI. They have already become the round
  // lines above; printing them as well would be showing the envelope.
  assert.equal(
    result.stdout.includes('@gauntlet'),
    false,
    'resume printed the protocol at the reader:\n' + result.stdout,
  );
  assert.match(result.stdout, /^P2\t2\tWIN/m, 'resume reported no rounds');

  // The ledger carries what the resumed turn actually did, not what it was
  // left saying before it.
  const [record] = result.runs();
  assert.equal(record.status, 'complete');
  assert.equal(record.lastVerdict, 'WIN', 'the ledger still shows the old verdict');
  assert.equal(record.rounds, 4, 'the two new rounds were not added to the two before');
  assert.equal(record.costUsd, 2.25, 'the turn cost was not added to the run total');
});

test('R6: a resumed run that did not finish stays resumable', () => {
  const cwd = workspace();
  const seeded = seedLedger(cwd, { rounds: 3, costUsd: 4.75, lastVerdict: 'LOSS' });

  // The turn ends normally, but the run never says it is complete.
  const first = runRun(['resume', seeded.id, '--json'], {
    cwd,
    phases: [
      {
        messages: [round('P2', 2, 'LOSS', 'the columns are still ragged')],
        result: { text: 'stopping here', costUsd: 0.25 },
      },
    ],
  });

  assert.equal(first.code, 1, first.stderr);
  const summary = ndjson(first.stdout).at(-1);
  assert.equal(summary.status, 'loss');

  // Every surface says the same thing about the same run.
  const [record] = first.runs();
  assert.equal(record.status, 'stopped', 'a run that did not finish was recorded as one that did');
  assert.equal(record.lastVerdict, 'LOSS');
  assert.equal(first.state().status, 'stopped', 'the two files disagree');
  assert.ok(
    first.stdout.includes('resume it with: gauntlet resume ' + seeded.id),
    first.stdout,
  );

  // And the command it printed is one the next invocation honours, rather than
  // refusing what it had just recommended.
  const again = runRun(['resume', seeded.id, '--json'], {
    cwd,
    phases: [
      {
        messages: [round('P2', 3, 'WIN')],
        state: 'complete',
        result: { text: 'done', costUsd: 0.25 },
      },
    ],
  });
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.equal(again.runs()[0].status, 'complete');
  assert.equal(again.state().status, 'complete');
  assert.equal(again.runs()[0].lastVerdict, 'WIN');
});

test('R6: `runs` never shows a complete run with a losing verdict', () => {
  const cwd = workspace();
  const seeded = seedLedger(cwd, { rounds: 1, lastVerdict: 'LOSS' });

  runRun(['resume', seeded.id], {
    cwd,
    phases: [
      {
        messages: [round('P2', 2, 'LOSS', 'not yet')],
        result: { text: 'stopping here', costUsd: 0.1 },
      },
    ],
  });

  const listed = runRun(['runs', '-C', cwd], { cwd, phases: WINNING_RUN });
  assert.equal(listed.code, 0, listed.stderr);
  for (const line of listed.stdout.split('\n').filter((line) => line !== '')) {
    const fields = line.split('\t');
    assert.equal(
      fields[3] === 'complete' && fields[4] === 'LOSS',
      false,
      'the ledger says a run both finished and lost: ' + line,
    );
  }
  assert.match(listed.stdout, /\tstopped\tLOSS$/m, listed.stdout);
});

test('resume --json is the same stream a run writes', () => {
  const cwd = workspace();
  const seeded = seedLedger(cwd);

  const result = runRun(['resume', seeded.id, '--json'], {
    cwd,
    phases: [
      {
        messages: [round('P2', 2, 'WIN')],
        state: 'complete',
        result: { text: 'done', costUsd: 0.25 },
      },
    ],
  });

  assert.equal(result.code, 0, result.stderr);
  const events = ndjson(result.stdout);
  for (const line of result.stdout.split('\n').filter((line) => line !== '')) {
    assert.doesNotThrow(() => JSON.parse(line), 'not JSON: ' + line);
  }
  assert.deepEqual(Object.keys(events.at(-1)).sort(), [
    'cost_usd',
    'rounds',
    'session_id',
    'status',
  ]);
  assert.equal(events.at(-1).status, 'win');
  assert.equal(events.at(-1).rounds, 3, 'the summary counts every round of the run');
  assert.ok(events.some((event) => event.type === 'round'));
});

test('resume stops on a budget guard, and says which one', () => {
  const cwd = workspace();
  const seeded = seedLedger(cwd);

  const result = runRun(['resume', seeded.id, '--max-rounds', '1'], {
    cwd,
    phases: [
      {
        messages: [round('P2', 2, 'LOSS', 'still ragged'), round('P2', 3, 'WIN')],
        holdAfter: 2,
      },
    ],
  });

  assert.equal(result.code, 1, 'a guard-stopped resume exits 1: ' + result.stdout);
  // On the reported stream, exactly where a run puts it — resume is the same
  // run, so it says so in the same place and the same words.
  assert.match(result.stdout, /--max-rounds guard stopped the run/);
  assert.equal(result.runs()[0].status, 'stopped');
  assert.equal(result.state().status, 'stopped');
  assert.match(result.stateText(), /"status": *"stopped"/);
});

test('a blocked run is offered by the picker, not only by name', async () => {
  const { isUnfinished, UNFINISHED } = await import('../dist/runs-store.js');
  const { resumeCommand } = await import('../dist/commands/resume.js');

  // A run that stopped before a verdict is a run to go back to. Only a run that
  // finished is finished.
  assert.deepEqual([...UNFINISHED].sort(), ['blocked', 'running', 'stopped']);
  for (const status of ['running', 'stopped', 'blocked']) {
    assert.equal(isUnfinished({ status }), true, status + ' should be resumable');
  }
  assert.equal(isUnfinished({ status: 'complete' }), false);

  // And the three routes agree. By name, a blocked run resumes: what `run`
  // prints when it blocks is `gauntlet resume <id>`, and that has to work.
  const cwd = workspace();
  const seeded = seedLedger(cwd, { status: 'blocked', rounds: 1, lastVerdict: 'BLOCKED' });
  const byName = runRun(['resume', seeded.id], {
    cwd,
    phases: [
      { messages: [round('P2', 2, 'WIN')], state: 'complete', result: { text: 'done', costUsd: 0.1 } },
    ],
  });
  assert.equal(byName.code, 0, byName.stderr);
  assert.equal(byName.runs()[0].status, 'complete');

  // With nothing but a blocked run recorded, bare `resume` no longer claims
  // there is nothing to resume. It has no terminal here, so it names the
  // candidate and says how to run it — which is the non-TTY answer, not the
  // "everything has finished" one.
  const only = workspace();
  const blocked = seedLedger(only, { status: 'blocked' });
  const bare = runRun(['resume'], { cwd: only, phases: WINNING_RUN });
  assert.equal(bare.code, 2, bare.stdout + bare.stderr);
  assert.ok(
    bare.stderr.includes(blocked.id),
    'the blocked run was not offered as a candidate:\n' + bare.stderr,
  );
  assert.equal(
    bare.stderr.includes('every run recorded there has finished'),
    false,
    'a blocked run was reported as finished:\n' + bare.stderr,
  );
  assert.match(bare.stderr, /resume needs a run id when stdin is not a terminal/);

  // The line that is left is only said when it is true: what is excluded now is
  // a run that finished, or one that never started a session.
  const finished = workspace();
  seedLedger(finished, { status: 'complete' });
  const none = runRun(['resume'], { cwd: finished, phases: WINNING_RUN });
  assert.equal(none.code, 2, none.stdout + none.stderr);
  assert.match(none.stderr, /every run recorded there has finished, or never started a session/);
  assert.ok(resumeCommand.usage.includes('resume'), 'the usage line is echoed under it');
});

test('cancelling the resume picker is not a crash', async () => {
  const { pickRun } = await import('../dist/commands/resume.js');
  const io = fakeTty();
  const candidates = [
    {
      id: 'r-20260811-0701-9dd663',
      sessionId: 'sesn_01J9ZQ',
      input: 'specs/checkout-flow.md',
      models: { lead: 'inherit', builder: 'inherit', critic: 'inherit' },
      startedAt: new Date().toISOString(),
      status: 'stopped',
    },
  ];

  beginRun('gauntlet resume', { input: io.input, output: io.output });
  const driver = (async () => {
    await waitFor(io, 'Resume which run?');
    await press(io, CTRL_C);
  })();

  // The picker throws the cancellation rather than answering with a run, and
  // the command is the thing that has to catch it. Letting it escape is what
  // produced the internal-error frame — the CLI accusing itself of crashing
  // over somebody deciding not to resume anything.
  await assert.rejects(
    () => pickRun(candidates, { input: io.input, output: io.output }),
    (error) => error.name === 'PromptCancelledError',
  );
  await driver;

  const drawn = frames(io.raw()).join('\n');
  assert.ok(drawn.includes('└'), 'the frame was left hanging open');
  assert.equal(drawn.includes('unexpected error'), false, drawn);
});

test('resume under --json says --json is why it asked nothing', () => {
  const cwd = workspace();
  seedLedger(cwd);
  const result = runRun(['resume', '--json'], { cwd, phases: WINNING_RUN });

  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /resume needs a run id under --json, which puts no questions/);
  assert.equal(
    result.stderr.includes('stdin is not a terminal'),
    false,
    'the message blamed the terminal for a decision --json made',
  );
});

test('resume and run report the same way on the same stream', () => {
  const runCwd = workspace();
  const ran = runRun(['run', '--auto', 'a goal'], { cwd: runCwd, phases: WINNING_RUN });

  const resumeCwd = workspace();
  const seeded = seedLedger(resumeCwd, { rounds: 0, costUsd: 0, lastVerdict: undefined });
  const resumed = runRun(['resume', seeded.id], {
    cwd: resumeCwd,
    phases: WINNING_RUN,
  });

  const shapes = (stdout) =>
    stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const fields = line.split('\t');
        return fields.length === 5 ? 'round' : fields[0];
      });

  // Piped, both are records, and both are the same records in the same order.
  assert.deepEqual(
    shapes(resumed.stdout),
    shapes(ran.stdout),
    'a resumed run reported a different shape from a run:\n' +
      resumed.stdout +
      '\n---\n' +
      ran.stdout,
  );
  for (const stdout of [ran.stdout, resumed.stdout]) {
    for (const line of stdout.split('\n').filter((line) => line !== '')) {
      assert.ok(line.includes('\t'), 'not a record: ' + line);
    }
    for (const glyph of ['✓', '✗', '▲', '◆', '│', '└']) {
      assert.equal(stdout.includes(glyph), false, 'a pipe was sent ' + glyph);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* A field is data, and data is never rewritten                                */
/* -------------------------------------------------------------------------- */

test('a value survives the ledger and every human view byte for byte', () => {
  const cwd = workspace();
  // Every character a markdown renderer would have taken to be markup, in a
  // value of exactly the kind a run is started with.
  const goal = String.raw`C:\dir\.hidden\file.txt \* \(x\) **b** _u_ `+ '`c`' + String.raw` a\.b`;

  const result = runRun(['run', '--auto', '--json', goal], { cwd, phases: WINNING_RUN });
  assert.equal(result.code, 0, result.stderr);

  // The machine view, which is the value as it was stored.
  const started = ndjson(result.stdout)[0];
  assert.equal(started.goal, goal, '--json rewrote the goal');

  // The ledger.
  const [record] = result.runs();
  assert.equal(record.input, goal, 'the ledger rewrote the goal');

  // The human views: piped records, and the aligned terminal layout. Both are
  // the same bytes, because a field is data wherever it is shown.
  const piped = runRun(['runs', '-C', cwd], { cwd, phases: WINNING_RUN });
  assert.equal(piped.code, 0, piped.stderr);
  assert.ok(
    piped.stdout.split('\n').some((line) => line.split('\t')[2] === goal),
    'the piped table rewrote the goal:\n' + piped.stdout,
  );

  const wide = runRun(['runs', '-C', cwd], {
    cwd,
    phases: WINNING_RUN,
    env: { GAUNTLET_FORCE_TTY: '200' },
  });
  assert.ok(wide.stdout.includes(goal), 'the terminal table rewrote the goal:\n' + wide.stdout);

  // And the path the CLI itself prints for a redirected run is the path.
  const elsewhere = workspace();
  const redirected = runRun(['run', '--auto', '--json', '-C', elsewhere, 'a goal'], {
    phases: WINNING_RUN,
  });
  const page = join(elsewhere, '.gauntlet', 'progress.html');
  assert.ok(
    ndjson(redirected.stdout).some(
      (event) => event.type === 'notice' && event.message === page,
    ),
    'the progress-page path was rewritten:\n' + redirected.stdout,
  );
});

/* -------------------------------------------------------------------------- */
/* The interactive surface                                                     */
/* -------------------------------------------------------------------------- */

/*
 * Everything below drives the real frame, the real progress line and the real
 * prompt library against a fake terminal.
 *
 * It is not run through a child process for one reason: a spawned process has
 * pipes, not a terminal, and nothing short of a pty — a dependency this package
 * is not allowed — can give it one. So the terminal is the stand-in and every
 * other part is the shipped code: `startProgress` on its own timer,
 * `progressStream` in front of the writes, `createRunFrame` drawing the frame,
 * and clack itself putting the questions.
 */

const { beginRun, createRunFrame, questionsFor, startProgress, progressStream } =
  await (async () => {
    const [prompts, usage, run] = await Promise.all([
      import('../dist/prompts.js'),
      import('../dist/usage.js'),
      import('../dist/commands/run.js'),
    ]);
    return {
      beginRun: prompts.beginRun,
      createRunFrame: prompts.createRunFrame,
      questionsFor: run.questionsFor,
      startProgress: usage.startProgress,
      progressStream: usage.progressStream,
    };
  })();

/** The frame, the spinner in front of it, and the stream that knows about both. */
function surface({ verbose = false, open = false } = {}) {
  const io = fakeTty();
  const progress = startProgress(io.output, 'Running', true);
  const out = progressStream(io.output, progress);
  const frameIo = { input: io.input, output: out };
  // Opened by the run rather than by the questionnaire, exactly as run.ts does.
  if (open) beginRun('gauntlet run', frameIo);
  const frame = createRunFrame(frameIo, { verbose, progress });
  return { io, progress, frame };
}

const PLAN_EVENTS = [
  { type: 'run_started', goal: 'specs/checkout-flow.md', source: 'spec' },
  {
    type: 'bar_captured',
    path: '.gauntlet/bar',
    artifacts: [
      { path: '.gauntlet/bar/gh/root-help.txt', detail: 'gh --help' },
      { path: '.gauntlet/bar/gh/leaf-help-flags.txt', detail: 'gh run list --help' },
    ],
  },
  { type: 'plan_ready', pieces: [{ id: 'P1', title: 'Leaf help' }, { id: 'P2', title: 'Exit codes' }] },
];

test('the review question survives the spinner, and the cursor comes back', async () => {
  const { io, frame, progress } = surface();
  for (const event of PLAN_EVENTS) frame.emit(event);

  // Every byte the terminal had been sent at the moment the answer was given:
  // the screen the person was actually looking at while they were asked.
  let waiting = '';
  const driver = (async () => {
    await waitFor(io, 'Start the loop?');
    // Long enough that a spinner still on its timer would have redrawn over the
    // question a dozen times before the answer arrives.
    await sleep(400);
    waiting = io.raw();
    await press(io, ENTER);
  })();

  const started = await frame.confirm('Start the loop?');
  await driver;
  assert.equal(started, true);

  const visible = screen(waiting);
  assert.ok(
    visible.join('\n').includes('Start the loop?'),
    'the question had been erased from the screen it was asked on:\n' + visible.join('\n'),
  );
  assert.equal(
    /Running/.test(visible.find((line) => line.includes('Start the loop?')) ?? ''),
    false,
    'a spinner frame was drawn onto the question line',
  );
  assert.ok(
    visible.every((line) => !/^[◒◐◓◑] {2}Running/.test(line)),
    'the spinner kept drawing while the question waited:\n' + visible.join('\n'),
  );

  // And the cursor is handed back by the time the run is over. A prompt of its
  // own takes the cursor while it is drawing its rows, which is the prompt
  // library's business; what must never happen is a run that ends with the
  // cursor still gone, which is what an unclosed progress line leaves behind.
  progress.done('Run complete');
  frame.close('Won — 3 rounds');
  assert.ok(cursorVisible(io.raw()), 'the run ended with the cursor still hidden');
});

test('a suspended progress line stops drawing and gives the cursor back', async () => {
  const io = fakeTty();
  const progress = startProgress(io.output, 'Running', true);
  await sleep(250);
  assert.ok(
    screen(io.raw()).some((line) => /^[◒◐◓◑] {2}Running/.test(line)),
    'the progress line never drew in the first place',
  );

  progress.suspend();
  const at = io.raw();
  await sleep(400);

  // This is the whole of the defect, stated as a property: while a question is
  // being asked, the timer is stopped, the line is gone, and the cursor is
  // back. Any one of the three missing and the user types into a wiped line.
  assert.equal(io.raw(), at, 'the spinner kept drawing after it was suspended');
  assert.ok(cursorVisible(at), 'a suspended progress line kept the cursor');
  assert.ok(
    screen(at).every((line) => !/Running/.test(line)),
    'the progress line was left on screen while suspended',
  );

  progress.resume();
  await sleep(250);
  assert.notEqual(io.raw(), at, 'the progress line never came back');
  progress.done('Run complete');
  assert.ok(cursorVisible(io.raw()), 'a closed progress line kept the cursor');
});

test('nothing the frame writes has a spinner frame glued to it', async () => {
  const { io, frame } = surface({ verbose: true });
  for (const event of PLAN_EVENTS) frame.emit(event);
  // Long enough for the spinner to have drawn many times between the writes.
  await sleep(300);
  frame.emit({ type: 'round', piece: 'P1', round: 1, verdict: 'LOSS', gap: 'ragged columns' });
  await sleep(300);
  frame.emit({ type: 'round', piece: 'P2', round: 1, verdict: 'WIN' });
  await sleep(150);
  frame.close('Won — 2 rounds');

  for (const line of screen(io.raw())) {
    // A spinner glyph may only ever be the first thing on its own line.
    const glued = /.[◒◐◓◑]/.test(line);
    assert.equal(glued, false, 'a spinner frame is stuck to a report line: ' + line);
    assert.equal(
      /Running.*(round|bar|pieces|Won)/.test(line),
      false,
      'the spinner and a report line share a line: ' + line,
    );
  }
  // And no frame was left behind in the scrollback where nothing can erase it.
  const leftovers = screen(io.raw()).filter((line) => /^[◒◐◓◑] {2}Running/.test(line));
  assert.equal(leftovers.length, 0, 'dead spinner frames were left on screen: ' + leftovers);
});

test('the frame closes with the rail on a win, on a stop, and on a cancel', async () => {
  const won = surface();
  won.frame.emit(PLAN_EVENTS[0]);
  won.frame.close('Won — 4 rounds for $4.75');
  assert.match(frames(won.io.raw()).at(-1), /^└ {2}Won — 4 rounds/);

  const stopped = surface();
  stopped.frame.emit(PLAN_EVENTS[0]);
  stopped.frame.emit({
    type: 'notice',
    level: 'warning',
    message: 'the --max-cost guard stopped the run',
  });
  stopped.frame.close('Stopped — 2 rounds for $4.75');
  assert.match(frames(stopped.io.raw()).at(-1), /^└ {2}Stopped — 2 rounds/);

  // Cancelling at a question that has a run behind it leaves the closing to the
  // caller, which has a run to record and a way back in to print first.
  const cancelled = surface();
  cancelled.frame.emit(PLAN_EVENTS[0]);
  const driver = (async () => {
    await waitFor(cancelled.io, 'Start the loop?');
    await press(cancelled.io, CTRL_C);
  })();
  await assert.rejects(
    () => cancelled.frame.confirm('Start the loop?'),
    (error) => error.name === 'PromptCancelledError',
  );
  await driver;
  assert.equal(
    cancelled.io.raw().includes('no run started, nothing saved'),
    false,
    'a run that had already been started was reported as never having begun',
  );
  cancelled.frame.emit({
    type: 'notice',
    level: 'note',
    message: 'resume it with: gauntlet resume r-x',
  });
  cancelled.frame.close('Stopped — 0 rounds for $0.15');
  assert.match(frames(cancelled.io.raw()).at(-1), /^└ {2}Stopped — 0 rounds/);
});

test('the closing line fits, so nothing on it is ever cut in half', () => {
  for (const columns of [80, 60, 40]) {
    const io = fakeTty({ columns });
    const progress = startProgress(io.output, 'Running', true);
    const out = progressStream(io.output, progress);
    const frame = createRunFrame(
      { input: io.input, output: out },
      { verbose: false, progress },
    );

    frame.emit({ type: 'run_started', goal: 'a goal', source: 'goal' });
    // The sequence a finishing run really draws: the plan, then the closing
    // notices as news, then the rail.
    frame.showPlan();
    frame.emit({
      type: 'notice',
      level: 'note',
      message: 'resume it with: gauntlet resume r-20260811-1259-9dd663',
    });
    progress.suspend();
    frame.close('Stopped — 12 rounds for $148.75');

    const drawn = screen(io.raw());
    const closing = drawn.find((row) => row.startsWith('└'));
    assert.ok(closing !== undefined, 'the frame never closed at ' + columns);
    assert.equal(
      closing.includes('...'),
      false,
      'the closing line was cut at ' + columns + ': ' + closing,
    );
    // The command to resume with is on the note above, where it can be copied.
    // Narrow enough, it folds onto the next line at a space — but the id itself
    // is never broken and never cut, because half an id cannot be typed back
    // in. That is why the closing line does not have to carry it at all.
    assert.ok(
      drawn.some((row) => row.includes('r-20260811-1259-9dd663')),
      'the run id was lost at ' + columns + ':\n' + drawn.join('\n'),
    );
    for (const row of drawn) {
      assert.equal(
        /r-2026\S*\.\.\./.test(row),
        false,
        'the run id was cut at ' + columns + ': ' + row,
      );
    }
    assert.ok(
      drawn.some((row) => row.includes('gauntlet resume')),
      'the command to resume with was lost at ' + columns,
    );
  }
});

test('a run is drawn in one frame, with rails and a verdict per round', async () => {
  const { io, frame } = surface();
  for (const event of PLAN_EVENTS) frame.emit(event);
  frame.emit({ type: 'round', piece: 'P1', round: 1, verdict: 'LOSS', gap: 'the flag table omits defaults' });
  frame.emit({ type: 'round', piece: 'P1', round: 2, verdict: 'WIN' });
  frame.emit({ type: 'round', piece: 'P2', round: 1, verdict: 'BLOCKED', gap: 'the bar hash changed' });
  frame.close('Stopped — 3 rounds for $1.20');

  // What the terminal ends up showing, with every erase and carriage return
  // replayed — which is the only reading of a redrawn line that means anything.
  const drawn = screen(io.raw()).join('\n');
  // The plan is one box, not a line per fact, and every verdict is a mark in
  // the left margin an eye can run down.
  assert.ok(drawn.includes('◇  Run plan '), drawn);
  assert.ok(drawn.includes('spec'), drawn);
  assert.ok(drawn.includes('.gauntlet/bar (2 artifacts)'), drawn);
  assert.ok(drawn.includes('P1, P2'), drawn);
  assert.match(drawn, /^◆ {2}P1 +round 2 +WIN$/m);
  assert.match(drawn, /^▲ {2}P1 +round 1 +LOSS +the flag table omits defaults$/m);
  assert.match(drawn, /^■ {2}P2 +round 1 +BLOCKED +the bar hash changed$/m);
  for (const glyph of ['│', '╮', '╯', '├', '└']) {
    assert.ok(drawn.includes(glyph), 'the frame is missing ' + glyph + '\n' + drawn);
  }
});

test('a verbose report keeps its lines, and every one of them keeps its rail', async () => {
  const { io, frame } = surface({ verbose: true, open: true });
  const report = [
    'FILES CHANGED',
    '',
    '- cli/src/commands/run.ts',
    '- cli/src/open.ts',
    '',
    'COMMANDS RUN',
    '',
    '  cd cli && npm test',
    '',
    'VERIFICATION',
    '\tindented\twith\ttabs',
    '  two trailing spaces  ',
  ].join('\n');

  frame.emit({ type: 'run_started', goal: 'a goal', source: 'goal' });
  frame.emit({ type: 'agent_output', agent: 'gauntlet-builder', piece: 'P1', round: 2, text: report });
  frame.close('Won — 1 round');

  const drawn = screen(io.raw());

  // Every line the agent wrote is a line on screen, in order, and none of them
  // was re-flowed into its neighbour.
  for (const line of report.split('\n').filter((line) => line.trim() !== '')) {
    // Compared without the trailing space a terminal cannot show anyway; that
    // it is really written is checked against the raw bytes below.
    assert.ok(
      drawn.some((row) => row.includes(line.trimEnd().trimStart())),
      'a report line was lost or re-flowed: ' + JSON.stringify(line) + '\n' + drawn.join('\n'),
    );
  }
  assert.equal(
    drawn.some((row) => row.includes('FILES CHANGED') && row.includes('COMMANDS RUN')),
    false,
    'the report was flattened into one line:\n' + drawn.join('\n'),
  );

  // And every row of it is drawn against the rail, which is what a single long
  // line loses the moment the terminal wraps it.
  const start = drawn.findIndex((row) => row.includes('FILES CHANGED'));
  const end = drawn.findIndex((row) => row.includes('two trailing spaces'));
  assert.ok(start !== -1 && end > start, drawn.join('\n'));
  for (const row of drawn.slice(start, end + 1)) {
    assert.match(row, /^│/, 'a report line lost its rail: ' + JSON.stringify(row));
  }

  // The spacing the agent wrote is the spacing that is drawn: tabs survive, and
  // so do trailing spaces.
  assert.ok(
    drawn.some((row) => row.includes('\tindented\twith\ttabs')),
    'tabs were rewritten:\n' + JSON.stringify(drawn.join('\n')),
  );
  // Against the bytes, not the replayed screen: the replay trims each row to
  // the last column a terminal would draw on, and the question here is what was
  // written, which is the agent's spacing exactly as it wrote it.
  assert.ok(
    io.raw().includes('  two trailing spaces  '),
    'the spacing the agent wrote was rewritten on its way to the frame',
  );
});

test('a value too long for the box is cut once, and never wrapped as well', async () => {
  const { noteRunPlan } = await import('../dist/prompts.js');
  const io = fakeTty({ columns: 80 });
  const long = String.raw`C:\Users\eight\AppData\Local\Temp\gauntlet\w30target\.gauntlet\progress.html`;
  const short = String.raw`C:\dir\.hidden\file.txt`;

  noteRunPlan(
    [
      { label: 'spec', value: long },
      { label: 'note', value: short },
    ],
    'Run plan',
    { input: io.input, output: io.output },
  );

  const drawn = screen(io.raw());
  // One discipline, not two: the value is on one row, cut once, and the
  // ellipsis is what says it was cut. It is never folded onto a second row and
  // then cut there as well, which leaves the reader with neither the whole
  // value nor a clean end to it.
  const rows = drawn.filter((row) => row.includes('C:\\Users'));
  assert.equal(rows.length, 1, 'a long value was spread over rows:\n' + drawn.join('\n'));
  assert.ok(rows[0].includes('...'), 'a cut value does not say it was cut: ' + rows[0]);
  assert.ok(rows[0].trimEnd().endsWith('│'), 'the box lost its right edge: ' + rows[0]);

  // And a value that fits is untouched, backslashes and all.
  assert.ok(
    drawn.some((row) => row.includes(short)),
    'a value that fits was rewritten:\n' + drawn.join('\n'),
  );
  for (const row of drawn) {
    assert.ok(row.length <= 80, 'the box ran past the terminal: ' + row);
  }
});

test('a run asks only for what it was not already told', () => {
  const nothing = { given: undefined, flagged: {}, config: {}, wantsAuto: false };
  assert.deepEqual(questionsFor(nothing), {
    input: true,
    lead: true,
    builder: true,
    critic: true,
    mode: true,
  });

  // --auto is the questionnaire declined; only the goal outlives it.
  assert.deepEqual(questionsFor({ ...nothing, wantsAuto: true }), {
    input: true,
    lead: false,
    builder: false,
    critic: false,
    mode: false,
  });
  assert.deepEqual(
    questionsFor({ ...nothing, given: 'specs/api.md', wantsAuto: true }),
    { input: false, lead: false, builder: false, critic: false, mode: false },
    '--auto with a goal has been told everything, so it must ask nothing',
  );

  // A flag answers its own question, and a saved config answers all three.
  assert.equal(questionsFor({ ...nothing, flagged: { lead: 'claude-opus-5' } }).lead, false);
  assert.equal(questionsFor({ ...nothing, flagged: { lead: 'claude-opus-5' } }).builder, true);
  const saved = questionsFor({
    ...nothing,
    given: 'a goal',
    config: { models: { lead: 'inherit', builder: 'sonnet', critic: 'haiku' }, auto: false },
  });
  assert.deepEqual(saved, {
    input: false,
    lead: false,
    builder: false,
    critic: false,
    mode: false,
  });
});

test('a questionnaire with nothing to ask draws nothing at all', async () => {
  const { promptStartup } = await import('../dist/prompts.js');
  const io = fakeTty();

  const choices = await promptStartup(
    {
      input: 'specs/api.md',
      models: { lead: 'claude-opus-5', builder: 'sonnet', critic: 'haiku' },
      auto: true,
    },
    { input: io.input, output: io.output },
    { input: false, lead: false, builder: false, critic: false, mode: false },
  );

  assert.deepEqual(choices, {
    input: 'specs/api.md',
    models: { lead: 'claude-opus-5', builder: 'sonnet', critic: 'haiku' },
    auto: true,
  });
  assert.equal(io.raw(), '', 'a run that was told everything still drew a question');
});

/* -------------------------------------------------------------------------- */
/* Evidence                                                                    */
/* -------------------------------------------------------------------------- */

const EVIDENCE = join(PACKAGE_ROOT, '.evidence');

/** One captured run, in the shape every other transcript here is written in. */
function block(title, command, result) {
  return [
    '='.repeat(72),
    '$ ' + command,
    '='.repeat(72),
    '',
    '--- ' + title + ' ---',
    '',
    '--- EXIT ---',
    String(result.code),
    '',
    '--- STDOUT (' + Buffer.byteLength(result.stdout) + ' bytes) ---',
    result.stdout === '' ? '(nothing)' : result.stdout.replace(/\n$/, ''),
    '',
    '--- STDERR (' + Buffer.byteLength(result.stderr) + ' bytes) ---',
    result.stderr === '' ? '(nothing)' : result.stderr.replace(/\n$/, ''),
    '',
  ].join('\n');
}

/**
 * The run both transcripts are taken from: the review pause skipped, four
 * rounds judged across two pieces, and a cost guard that stops it before the
 * fifth. One script, run twice — once for a person, once for a machine.
 */
const TRANSCRIPT_RUN = [
  {
    messages: [
      OPENING,
      'Fanning out builders for P1 and P2.',
      round('P1', 1, 'LOSS', 'the flag table omits every default, so the README is still needed'),
      round('P2', 1, 'LOSS', 'exit 2 is documented but never produced by a real invocation'),
      round('P1', 2, 'WIN'),
      round('P2', 2, 'LOSS', 'the usage error names the flag but not the accepted values'),
    ],
    result: { text: 'Stopped before the next round.', costUsd: 4.75 },
  },
];

const TRANSCRIPT_ARGS = [
  'run',
  '--auto',
  '--max-cost',
  '4',
  '--model',
  'claude-opus-5',
  '--builder-model',
  'sonnet',
  '--critic-model',
  'opus',
  'a CLI whose help output is indistinguishable from gh',
];

test('evidence: the interactive frame, drawn end to end', async () => {
  const { io, frame, progress } = surface({ open: true });

  frame.emit({ type: 'run_started', goal: 'specs/checkout-flow.md', source: 'spec' });
  frame.emit({ type: 'notice', level: 'note', message: '.gauntlet/progress.html' });
  frame.emit({
    type: 'bar_captured',
    path: '.gauntlet/bar',
    artifacts: [
      { path: '.gauntlet/bar/gh/root-help.txt', detail: 'gh --help' },
      { path: '.gauntlet/bar/gh/leaf-help-flags.txt', detail: 'gh run list --help' },
      { path: '.gauntlet/bar/gh/list-output.txt', detail: 'gh run list' },
      { path: '.gauntlet/bar/clack/frames-plain.txt', detail: 'clack 1.7.0' },
    ],
  });
  frame.emit({
    type: 'plan_ready',
    pieces: [
      { id: 'P1', title: 'The flag table and the leaf help' },
      { id: 'P2', title: 'The exit-code contract' },
      { id: 'P3', title: 'The interactive startup' },
    ],
  });

  // The bar and the pieces are shown before the pause, because they are what
  // the pause is for; then the question, answered the way a person answers it,
  // with the spinner running underneath the whole time.
  frame.showPlan();
  const driver = (async () => {
    await waitFor(io, 'Start the loop?');
    await sleep(250);
    await press(io, ENTER);
  })();
  assert.equal(await frame.confirm('Start the loop?'), true);
  await driver;

  await sleep(200);
  frame.emit({
    type: 'round',
    piece: 'P1',
    round: 1,
    verdict: 'LOSS',
    gap: 'the flag table omits every default, so the README is still needed',
    elapsedMs: 42_000,
  });
  await sleep(200);
  frame.emit({
    type: 'round',
    piece: 'P2',
    round: 1,
    verdict: 'LOSS',
    gap: 'exit 2 is documented but never produced by a real invocation',
    elapsedMs: 51_000,
  });
  await sleep(200);
  frame.emit({ type: 'round', piece: 'P1', round: 2, verdict: 'WIN', elapsedMs: 38_000 });
  frame.emit({
    type: 'notice',
    level: 'warning',
    message: 'the --max-cost guard stopped the run: $4.75 spent, and the limit is $4.00',
  });
  frame.emit({
    type: 'notice',
    level: 'note',
    message: 'resume it with: gauntlet resume r-20260811-0701-9dd663',
  });
  // Inside a frame the closing rail is the last word, so the progress line only
  // gets out of the way — exactly what finish() does when there is a frame.
  progress.suspend();
  frame.close('Stopped — 3 rounds for $4.75');

  const drawn = screen(io.raw())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

  // It really is one frame: opened once, closed once, rails in between.
  assert.ok(drawn.includes('◇  Run plan '), drawn);
  assert.match(drawn, /└ {2}Stopped — 3 rounds/);
  assert.match(drawn, /^◆ {2}P1 +round 2 +WIN$/m);
  assert.match(drawn, /^▲ {2}P1 +round 1 +LOSS/m);

  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(
    join(EVIDENCE, 'run-frame.txt'),
    [
      'gauntlet run on a terminal, captured from the shipped code.',
      '',
      'The frame, the progress line and the questions are the real ones —',
      'src/prompts.ts, src/usage.ts and @clack/prompts 1.7.0 — driven against a',
      'pair of streams that claim to be a terminal, because a spawned process is',
      'given pipes and no amount of asking turns a pipe into a terminal.',
      '',
      'Every escape sequence has been replayed rather than stripped, so what is',
      'below is what the screen ends up showing: a line the spinner drew and',
      'then erased is not in it, and the question the spinner used to erase is.',
      'The run pauses for review, is answered, judges three rounds, and is',
      'stopped by --max-cost. Written by test/run.test.js.',
      '',
      '='.repeat(72),
      '$ gauntlet run specs/checkout-flow.md',
      '='.repeat(72),
      '',
      drawn,
      '',
    ].join('\n'),
    'utf8',
  );
});

test('evidence: --verbose inside the frame, railed line by line', async () => {
  const { io, frame, progress } = surface({ verbose: true, open: true });

  frame.emit({ type: 'run_started', goal: 'specs/checkout-flow.md', source: 'spec' });
  frame.emit({
    type: 'plan_ready',
    pieces: [{ id: 'P1', title: 'The flag table and the leaf help' }],
  });
  frame.showPlan();

  frame.emit({
    type: 'agent_output',
    agent: 'gauntlet-builder',
    piece: 'P1',
    round: 1,
    text: [
      'FILES CHANGED',
      '',
      '- cli/src/usage.ts',
      '- cli/src/commands/plan.ts',
      '',
      'COMMANDS RUN',
      '',
      '  cd cli && npm run build',
      '  cd cli && npm test',
      '',
      'VERIFICATION',
      '',
      '  ℹ tests 508',
      '  ℹ pass 508',
      '  ℹ fail 0',
    ].join('\n'),
  });
  await sleep(150);
  frame.emit({
    type: 'round',
    piece: 'P1',
    round: 1,
    verdict: 'WIN',
    elapsedMs: 51_000,
  });
  frame.emit({
    type: 'agent_output',
    agent: 'gauntlet-critic',
    piece: 'P1',
    round: 1,
    text: ['VERDICT', 'WIN', '', 'GAP', 'none: the flag table carries every default.'].join('\n'),
  });
  progress.suspend();
  frame.close('Won — 1 round for $0.31');

  const drawn = screen(io.raw()).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  // Every line of both reports is drawn against the rail, and none of them was
  // re-flowed into its neighbour.
  assert.match(drawn, /^│ {2}FILES CHANGED$/m, drawn);
  assert.match(drawn, /^│ {4}cd cli && npm test$/m, drawn);
  assert.match(drawn, /^│ {2}VERDICT$/m, drawn);
  assert.equal(drawn.includes('FILES CHANGED  '), false, 'the report was flattened');

  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(
    join(EVIDENCE, 'run-frame-verbose.txt'),
    [
      'gauntlet run --verbose on a terminal, captured from the shipped code.',
      '',
      'What the agents wrote, inside the frame. A report is many lines and its',
      'structure is carried by its indentation, so the lines are handed to',
      '@clack/prompts 1.7.0 as lines and the library rails each one — the same',
      'rule the piped and --json views already followed. Nothing is re-flowed,',
      'nothing is re-indented, and the only thing taken out of a line is what a',
      'terminal would act on rather than draw.',
      '',
      'Escape sequences are replayed rather than stripped, so this is what the',
      'screen ends up showing. Written by test/run.test.js.',
      '',
      '='.repeat(72),
      '$ gauntlet run --verbose specs/checkout-flow.md',
      '='.repeat(72),
      '',
      drawn,
      '',
    ].join('\n'),
    'utf8',
  );
});

test('evidence: resume, drawn in the same frame a run is', async () => {
  const { pickRun } = await import('../dist/commands/resume.js');
  const io = fakeTty();

  const candidates = [
    {
      id: 'r-20260811-0701-9dd663',
      sessionId: 'sesn_01J9ZQ',
      input: 'specs/checkout-flow.md',
      models: { lead: 'claude-opus-5', builder: 'sonnet', critic: 'opus' },
      startedAt: new Date(Date.now() - 42 * 60 * 1000).toISOString(),
      status: 'stopped',
      rounds: 3,
      lastVerdict: 'LOSS',
    },
    {
      id: 'r-20260810-1712-a3f9c1',
      sessionId: 'sesn_01J8AA',
      input: 'a CLI whose help output is indistinguishable from gh',
      models: { lead: 'inherit', builder: 'inherit', critic: 'inherit' },
      startedAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
      status: 'running',
    },
  ];

  // The pick and the run it leads to are one frame, opened once.
  beginRun('gauntlet resume', { input: io.input, output: io.output });
  const driver = (async () => {
    await waitFor(io, 'Resume which run?');
    await sleep(150);
    await press(io, ENTER);
  })();
  const chosen = await pickRun(candidates, { input: io.input, output: io.output });
  await driver;
  assert.equal(chosen.id, candidates[0].id);

  const progress = startProgress(io.output, 'Resuming ' + chosen.id, true);
  const out = progressStream(io.output, progress);
  const frame = createRunFrame({ input: io.input, output: out }, { verbose: false, progress });

  frame.emit({ type: 'run_started', goal: chosen.input, source: 'spec' });
  frame.emit({ type: 'notice', level: 'note', message: '.gauntlet/progress.html' });
  frame.emit({
    type: 'plan_ready',
    pieces: [{ id: 'P2', title: 'The exit-code contract' }, { id: 'P3', title: 'Startup' }],
  });
  await sleep(200);
  frame.emit({ type: 'round', piece: 'P2', round: 3, verdict: 'WIN', elapsedMs: 44_000 });
  await sleep(200);
  frame.emit({ type: 'round', piece: 'P3', round: 1, verdict: 'WIN', elapsedMs: 39_000 });
  frame.emit({
    type: 'run_finished',
    status: 'win',
    rounds: 5,
    costUsd: 6.2,
    sessionId: chosen.sessionId,
  });
  progress.suspend();
  frame.close('Won — 5 rounds for $6.20');

  const drawn = screen(io.raw()).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  assert.match(drawn, /^┌ {2}gauntlet resume$/m, drawn);
  assert.match(drawn, /└ {2}Won — 5 rounds/, drawn);
  assert.match(drawn, /^◆ {2}P2 +round 3 +WIN$/m, drawn);
  assert.equal(drawn.includes('✓'), false, 'resume drew a glyph a run never draws');

  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(
    join(EVIDENCE, 'resume-frame.txt'),
    [
      'gauntlet resume on a terminal, captured from the shipped code.',
      '',
      'The same frame, the same picker and the same verdict lines a run draws —',
      'src/commands/resume.ts routes through src/prompts.ts exactly as',
      'src/commands/run.ts does. Escape sequences are replayed rather than',
      'stripped, so this is what the screen ends up showing.',
      '',
      'The pick and the run it leads to are one frame: opened once at the top,',
      'closed once at the bottom. Written by test/run.test.js.',
      '',
      '='.repeat(72),
      '$ gauntlet resume',
      '='.repeat(72),
      '',
      drawn,
      '',
    ].join('\n'),
    'utf8',
  );
});

test('evidence: resume piped is records, and only records', () => {
  const cwd = workspace();
  const seeded = seedLedger(cwd, { rounds: 3, costUsd: 4.75, lastVerdict: 'LOSS' });

  const piped = runRun(['resume', seeded.id], {
    cwd,
    phases: [
      {
        messages: [
          'Picking P2 back up where it stopped.',
          round('P2', 2, 'WIN'),
          round('P3', 1, 'LOSS', 'the startup questionnaire asks for what it was already told'),
          round('P3', 2, 'WIN'),
        ],
        state: 'complete',
        result: { text: 'Both pieces won.\n@gauntlet round P3 | 2 | WIN |', costUsd: 1.45 },
      },
    ],
  });

  assert.equal(piped.code, 0, piped.stderr);
  for (const line of piped.stdout.split('\n').filter((line) => line !== '')) {
    assert.ok(line.includes('\t'), 'a resumed run wrote something that is not a record: ' + line);
  }
  assert.equal(piped.stdout.includes('@gauntlet'), false, 'the protocol reached the reader');

  // `cut -f1` on this stream returns record labels and piece ids, and never a
  // fragment of a sentence — which is the whole point of the discipline.
  const first = piped.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split('\t')[0]);
  for (const field of first) {
    assert.ok(/^[A-Za-z][\w.-]*$/.test(field), 'cut -f1 returned prose: ' + JSON.stringify(field));
  }

  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(
    join(EVIDENCE, 'resume-session.txt'),
    [
      'gauntlet resume with stdout on a pipe, captured from the built binary as',
      'a child process against a scripted transport.',
      '',
      'No terminal, so no frame and no marks: one tab-delimited record per event,',
      'the same records a run writes, and no block of the agent’s own prose glued',
      'onto the end of them. The markers the run reports with are read by this CLI',
      'and never printed at the reader. Written by test/run.test.js.',
      '',
      block('a resumed run that finished', 'gauntlet resume ' + seeded.id + ' | cat', piped),
      '',
      'And the first field of every line, which is what `cut -f1` returns:',
      '',
      first.map((field) => '  ' + field).join('\n'),
      '',
    ].join('\n'),
    'utf8',
  );
});

test('evidence: a captured run transcript, human and machine', () => {
  mkdirSync(EVIDENCE, { recursive: true });

  const human = runRun(TRANSCRIPT_ARGS, {
    phases: TRANSCRIPT_RUN,
    env: { GAUNTLET_FORCE_TTY: '80' },
  });
  const piped = runRun(TRANSCRIPT_ARGS, { phases: TRANSCRIPT_RUN });
  const machine = runRun([...TRANSCRIPT_ARGS, '--json'], { phases: TRANSCRIPT_RUN });

  // All three really ran, and all three really stopped on the guard.
  assert.equal(human.code, 1, human.stderr);
  assert.equal(piped.code, 1, piped.stderr);
  assert.equal(machine.code, 1, machine.stderr);
  assert.equal(human.runs()[0].status, 'stopped');
  assert.equal(ndjson(machine.stdout).at(-1).status, 'stopped');

  // The piped transcript is the one that has to be machine-clean: records only,
  // nothing wrapped, and not a glyph anywhere.
  for (const line of piped.stdout.split('\n').filter((line) => line !== '')) {
    assert.ok(line.includes('\t'), 'a piped line is not a record: ' + line);
    assert.equal(line.startsWith(' '), false, 'a piped line was wrapped: ' + line);
  }
  for (const glyph of ['✓', '✗', '▲', '◆', '│', '└']) {
    assert.equal(piped.stdout.includes(glyph), false, 'a pipe was sent ' + glyph);
  }

  const command =
    'gauntlet run --auto --max-cost 4 --model claude-opus-5 \\\n' +
    '      --builder-model sonnet --critic-model opus \\\n' +
    '      "a CLI whose help output is indistinguishable from gh"';

  writeFileSync(
    join(EVIDENCE, 'run-session.txt'),
    [
      'gauntlet run, captured from the built binary as a child process.',
      '',
      'The Claude Agent SDK is replaced by a scripted transport at the seam',
      'src/session.ts already has for it; everything else below — the flag',
      'boundary, the reporter, the run ledger, the budget guards and the exit',
      'code — is the shipped binary running for real, in a temp directory.',
      '',
      'The run below skips the review pause, judges four rounds across two',
      'pieces, and is stopped by --max-cost before the fifth. Written by',
      'test/run.test.js; laid out for an 80-column terminal via',
      'GAUNTLET_FORCE_TTY, which is why the columns are aligned in a file.',
      '',
      'That same variable is what draws the progress indicator, so the escape',
      'sequences below are on STDERR and only there: STDOUT is the report, and',
      'is byte for byte what a pipe would have been given.',
      '',
      block('laid out for a terminal, stopped by --max-cost', command, human),
      '',
      'The same run again with stdout on a pipe. No terminal, so no columns and',
      'no marks: one tab-delimited record per event, every field whole, nothing',
      'wrapped and nothing cut, which is what cut, sort and awk need.',
      '',
      block('the same run, piped', command + ' | cat', piped),
    ].join('\n'),
    'utf8',
  );

  writeFileSync(
    join(EVIDENCE, 'run-session.ndjson'),
    machine.stdout,
    'utf8',
  );

  // The file on disk is the stream a CI job would read: every line parses, and
  // the last one is the summary.
  const written = readFileSync(join(EVIDENCE, 'run-session.ndjson'), 'utf8');
  const events = ndjson(written);
  assert.ok(events.length >= 8, 'expected a line per event, got ' + events.length);
  assert.deepEqual(Object.keys(events.at(-1)).sort(), [
    'cost_usd',
    'rounds',
    'session_id',
    'status',
  ]);
  assert.equal(events.at(-1).rounds, 4);
  assert.equal(events.at(-1).cost_usd, 4.75);

  const transcript = readFileSync(join(EVIDENCE, 'run-session.txt'), 'utf8');
  assert.ok(transcript.includes('--- EXIT ---\n1'), 'the transcript lost the exit code');
  assert.ok(transcript.includes('P1'), 'the transcript lost the round lines');
});
