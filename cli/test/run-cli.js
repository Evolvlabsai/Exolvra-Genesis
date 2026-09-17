import { PREFLIGHT_FAKE } from './preflight-fake.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const BIN = join(PACKAGE_ROOT, 'dist', 'cli.js');
export const VERSION = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
).version;

/**
 * Runs a built CLI as a real child process, the way a user does.
 *
 * Everything asserted about exit codes goes through here: a code is only
 * evidence when it came off a process, not off a constant.
 */
export function runProcess(bin, args, { env = {}, cwd = PACKAGE_ROOT } = {}) {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
  }
  const proc = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: childEnv,
    cwd,
  });
  assert.equal(proc.error, undefined, 'the CLI process failed to start');
  assert.equal(proc.signal, null, 'the CLI process was killed by ' + proc.signal);
  return { code: proc.status, stdout: proc.stdout, stderr: proc.stderr, pid: proc.pid };
}

/** Runs the package's own `dist/cli.js`. */
export function run(args, env = {}) {
  return runProcess(BIN, args, { env });
}

/**
 * A plan in the shape the CLI asks for. Tests that are about something else —
 * exit codes, the validation boundary — replay this so the answer side is not
 * accidentally what they are measuring.
 */
export const SAMPLE_PLAN = {
  bar: 'gh 2.88.1 transcripts captured on this machine.',
  comparison: 'Run the binary and put its output beside the gh transcript.',
  artifacts: [{ path: '.exolvra-genesis/bar/gh/root-help.txt', detail: 'gh --help' }],
  specs: [
    {
      id: 'P1',
      title: 'Foundation and the plan command',
      covers: 'C1, C3',
      files: 'cli/src/**',
      verify: 'cd cli && npm test',
    },
  ],
};

/** The same plan as an agent answer: prose, then the block it was asked for. */
export function planAnswer(payload = SAMPLE_PLAN, prose = 'Here is the preview.') {
  return [prose, '', '```exolvra-genesis-plan', JSON.stringify(payload, null, 2), '```'].join('\n');
}

/** Writes an answer for the fake SDK to replay, and returns its path. */
export function answerFile(dir, name, text) {
  const path = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, text, 'utf8');
  return path;
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    const target = join(to, entry);
    if (statSync(source).isDirectory()) copyTree(source, target);
    else writeFileSync(target, readFileSync(source));
  }
}

/**
 * A stand-in for the Claude Agent SDK, installed where Node's resolver will
 * find it. The bar allows exactly this substitution — the SDK is an external
 * provider — and nothing else here is substituted: the sandbox runs the same
 * compiled `dist/` the package ships, as a real process.
 */
const FAKE_SDK = `import { readFileSync, writeFileSync } from 'node:fs';

export function query({ prompt, options }) {
${PREFLIGHT_FAKE}
  // Replays an answer captured from a real agent run, so the CLI renders the
  // same bytes a provider actually produced.
  const replay = process.env.EXOLVRA_GENESIS_TEST_SDK_RESULT_FILE;
  const captured =
    replay === undefined || replay === '' ? undefined : readFileSync(replay, 'utf8');
  const record = process.env.EXOLVRA_GENESIS_TEST_SDK_OPTIONS;
  if (record !== undefined && record !== '') {
    writeFileSync(
      record,
      JSON.stringify(
        {
          prompt,
          cwd: options.cwd,
          model: options.model ?? null,
          maxTurns: options.maxTurns ?? null,
          permissionMode: options.permissionMode ?? null,
          resume: options.resume ?? null,
          agents: options.agents,
          pluginDir: options.env?.EXOLVRA_GENESIS_PLUGIN_DIR ?? null,
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  const subtype = process.env.EXOLVRA_GENESIS_TEST_SDK_SUBTYPE ?? 'success';
  if (subtype === 'throw') {
    throw new Error('Failed to spawn Claude Code process: spawn node ENOENT');
  }
  if (subtype === 'throw_before_any_message') {
    return {
      async interrupt() {},
      async *[Symbol.asyncIterator]() {
        throw new Error('Failed to spawn Claude Code process: spawn node ENOENT');
      },
    };
  }
  if (subtype === 'throw_killed') {
    throw new Error('Claude Code process exited with signal SIGTERM');
  }
  if (subtype === 'throw_type_error') {
    // The provider entry point itself mis-shapen. Nothing the user configures
    // makes this go away, so it must not be reported as an environment.
    throw new TypeError('query is not a function');
  }
  if (subtype === 'null_message') {
    // A stream that yields something impossible: reading it faults inside the
    // consumer, mid-run, after the session started.
    return {
      async interrupt() {},
      async *[Symbol.asyncIterator]() {
        yield null;
      },
    };
  }
  if (subtype === 'json_tear_midstream') {
    // The provider process dies mid-write; the SDK's line parser throws the
    // raw SyntaxError. The session boundary must read this as a torn stream
    // (recoverable), never as a programmer fault to rethrow.
    return {
      async interrupt() {},
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          session_id: 'sesn_fake',
          message: { content: [{ type: 'text', text: 'started work' }] },
        };
        throw new SyntaxError('Unterminated string in JSON at position 167 (line 1 column 168)');
      },
    };
  }
  if (subtype === 'midstream_then_success') {
    // Stateful across createSession calls INSIDE one CLI process: the first
    // session drops its stream, every later one completes. This is the shape
    // auto-recovery exists for, and only a per-call fake can stage it.
    globalThis.__exolvraFakeCalls = (globalThis.__exolvraFakeCalls ?? 0) + 1;
    if (globalThis.__exolvraFakeCalls === 1) {
      return {
        async interrupt() {},
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'assistant',
            session_id: 'sesn_fake',
            message: { content: [{ type: 'text', text: 'started work' }] },
          };
          throw new Error('the provider dropped the stream');
        },
      };
    }
    // Later calls fall through to the plain success result below.
  }
  if (subtype === 'throw_midstream') {
    return {
      async interrupt() {},
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          session_id: 'sesn_fake',
          message: { content: [{ type: 'text', text: 'started work' }] },
        };
        throw new Error('the provider dropped the stream');
      },
    };
  }

  const result =
    subtype === 'success' || subtype === 'midstream_then_success'
      ? {
          type: 'result',
          subtype: 'success',
          session_id: 'sesn_fake',
          num_turns: 2,
          total_cost_usd: 0,
          usage: { input_tokens: 1000, output_tokens: 500 },
          result: captured ?? 'FAKE PLAN BODY',
          errors: [],
        }
      : {
          type: 'result',
          subtype,
          session_id: 'sesn_fake',
          num_turns: 2,
          total_cost_usd: 0,
          usage: { input_tokens: 1000, output_tokens: 500 },
          errors: subtype === 'error_during_execution' ? ['the provider blew up'] : [],
        };

  return {
    async interrupt() {},
    async *[Symbol.asyncIterator]() {
      // Two text blocks in one message, then a second message. None of them
      // ends in punctuation, so text run together is unmistakable.
      yield {
        type: 'assistant',
        session_id: 'sesn_fake',
        message: {
          content: [
            { type: 'text', text: 'thinking' },
            { type: 'text', text: 'out loud' },
          ],
        },
      };
      yield {
        type: 'assistant',
        session_id: 'sesn_fake',
        message: { content: [{ type: 'text', text: 'Now generate the outputs' }] },
      };
      yield result;
    },
  };
}
`;

/**
 * Copies the built package into a temp directory next to a fake SDK, so the
 * real binary can be driven end to end without reaching a provider.
 */
export function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'exolvra-genesis-sandbox-'));
  copyTree(join(PACKAGE_ROOT, 'dist'), join(root, 'dist'));
  writeFileSync(
    join(root, 'package.json'),
    readFileSync(join(PACKAGE_ROOT, 'package.json')),
  );

  const fakeDir = join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  mkdirSync(fakeDir, { recursive: true });
  writeFileSync(
    join(fakeDir, 'package.json'),
    JSON.stringify({
      name: '@anthropic-ai/claude-agent-sdk',
      version: '0.0.0-test-double',
      type: 'module',
      main: 'index.js',
      exports: { '.': './index.js' },
    }),
    'utf8',
  );
  writeFileSync(join(fakeDir, 'index.js'), FAKE_SDK, 'utf8');

  return {
    root,
    bin: join(root, 'dist', 'cli.js'),
    /**
     * Runs the sandboxed binary; `subtype` picks what the fake SDK reports and
     * `replay` names a file holding an answer captured from a real agent run.
     */
    run(args, { subtype = 'success', record, replay, env = {}, cwd = root } = {}) {
      return runProcess(join(root, 'dist', 'cli.js'), args, {
        cwd,
        env: {
          EXOLVRA_GENESIS_TEST_SDK_SUBTYPE: subtype,
          EXOLVRA_GENESIS_TEST_SDK_OPTIONS: record,
          EXOLVRA_GENESIS_TEST_SDK_RESULT_FILE: replay,
          ...env,
        },
      });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Trace wiring test support — phases that yield tool_use/tool_result blocks   */
/* -------------------------------------------------------------------------- */

/**
 * A phase that dispatches a builder subagent and receives its result.
 * Used to test builder_round_started, builder_round_ended, and process_event.
 */
export function builderDispatchPhase(toolId = 'toolu_builder_1') {
  return [
    // tool_use block dispatching the builder
    {
      type: 'assistant',
      session_id: 'sesn_trace_test',
      message: {
        content: [
          { type: 'text', text: 'Dispatching builder...' },
          {
            type: 'tool_use',
            id: toolId,
            name: 'Task',
            input: { agent: 'exolvra-genesis-builder', prompt: 'Build piece P1' },
          },
        ],
      },
    },
    // tool_result block with builder completion
    {
      type: 'assistant',
      session_id: 'sesn_trace_test',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolId,
            is_error: false,
          },
          { type: 'text', text: 'Builder completed successfully.' },
        ],
      },
    },
  ];
}

/**
 * A phase that dispatches a critic subagent.
 * Used to test critic_dispatched and process_event.
 */
export function criticDispatchPhase(toolId = 'toolu_critic_1') {
  return [
    {
      type: 'assistant',
      session_id: 'sesn_trace_test',
      message: {
        content: [
          { type: 'text', text: 'Dispatching critic...' },
          {
            type: 'tool_use',
            id: toolId,
            name: 'Task',
            input: { agent: 'exolvra-genesis-critic', prompt: 'Judge this work' },
          },
        ],
      },
    },
    {
      type: 'assistant',
      session_id: 'sesn_trace_test',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolId,
            is_error: false,
          },
          { type: 'text', text: 'Critic returned verdict.' },
        ],
      },
    },
  ];
}

/**
 * A phase where the builder dispatch fails (is_error: true).
 * Used to test process_event with outcome 'failed'.
 */
export function builderFailedPhase(toolId = 'toolu_builder_fail') {
  return [
    {
      type: 'assistant',
      session_id: 'sesn_trace_test',
      message: {
        content: [
          {
            type: 'tool_use',
            id: toolId,
            name: 'Task',
            input: { agent: 'exolvra-genesis-builder', prompt: 'Build piece' },
          },
        ],
      },
    },
    {
      type: 'assistant',
      session_id: 'sesn_trace_test',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolId,
            is_error: true,
          },
          { type: 'text', text: 'Builder failed.' },
        ],
      },
    },
  ];
}

/**
 * Runs a built CLI as a real child process and interrupts it mid-run, so the
 * SIGINT path can be driven through the shipped binary rather than described.
 *
 * The interrupt is raised from *inside* the child by a `--import` preload. That
 * indirection is a Windows necessity, not a preference: `process.kill(pid,
 * 'SIGINT')` from the parent tears the child down without ever running the
 * handler it registered, so a test built on it would prove nothing about the
 * handler. Emitting inside the child dispatches to the very listener the CLI
 * installed with `process.on('SIGINT', ...)` — the same function a console
 * Ctrl+C reaches.
 *
 * *When* it is raised is decided by the child, not by a clock. Every complete
 * line the child writes to stdout is offered to `triggerOn`, and the first line
 * it accepts releases the preload, which is waiting on a sentinel file. A
 * wall-clock delay would be a guess at how long startup takes, and a busy
 * machine invalidates the guess: an emit that lands before the CLI has
 * registered its handler runs no listener at all, and the run then settles by
 * some path that is not the interrupt path. So the caller names a line only a
 * live turn can have produced, and the signal goes out once the child has said
 * it is there.
 *
 * `delivered` is what the emit itself returned — true only if a listener ran —
 * so a swallowed signal is a failed assertion rather than a test that quietly
 * measured nothing.
 *
 * What this does *not* reproduce: the console-wide CTRL_C_EVENT a real Ctrl+C
 * broadcasts to the whole process group, and Node's default "terminate on an
 * unhandled SIGINT" behaviour (an emit with no listener is simply a no-op).
 * Both are outside the CLI. Everything the CLI itself does on interrupt runs
 * exactly as it does in a person's terminal.
 *
 * Resolves with `{ code, signal, stdout, stderr, pid, timedOut, triggered,
 * delivered }`. `code` is the child's real exit code — never a substituted
 * default — and `timedOut` says whether the guard had to kill a child that
 * outlived `killAfterMs`, which turns a hang into a visible failure instead of
 * a stalled suite.
 */
export function runProcessWithInterrupt(
  bin,
  args,
  { env = {}, cwd = PACKAGE_ROOT, triggerOn, killAfterMs = 60_000 } = {},
) {
  assert.equal(
    typeof triggerOn,
    'function',
    'runProcessWithInterrupt needs a triggerOn predicate to raise the signal on',
  );

  const preloadDir = mkdtempSync(join(tmpdir(), 'exolvra-genesis-interrupt-'));
  const preloadPath = join(preloadDir, 'raise-sigint.mjs');
  const releasePath = join(preloadDir, 'release');
  const emitPath = join(preloadDir, 'emit.json');
  writeFileSync(
    preloadPath,
    [
      "import { existsSync, writeFileSync } from 'node:fs';",
      'const release = ' + JSON.stringify(releasePath) + ';',
      'const record = ' + JSON.stringify(emitPath) + ';',
      // Unref'd, so this poll can never be what keeps the child alive: a run
      // that would have ended on its own still ends, and a trigger that never
      // arrives becomes an assertion rather than a hang.
      'const poll = setInterval(() => {',
      '  if (!existsSync(release)) return;',
      '  clearInterval(poll);',
      "  const listeners = process.listenerCount('SIGINT');",
      "  const delivered = process.emit('SIGINT');",
      "  writeFileSync(record, JSON.stringify({ delivered, listeners }), 'utf8');",
      '}, 5);',
      'poll.unref();',
      '',
    ].join('\n'),
    'utf8',
  );
  const preloadFlag = '--import file:///' + preloadPath.replace(/\\/g, '/');

  return new Promise((settle, reject) => {
    const childEnv = { ...process.env, ...env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete childEnv[key];
    }
    const inherited = childEnv.NODE_OPTIONS;
    childEnv.NODE_OPTIONS =
      inherited === undefined || inherited === ''
        ? preloadFlag
        : inherited + ' ' + preloadFlag;

    const proc = spawn(process.execPath, [bin, ...args], {
      env: childEnv,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let triggered = false;
    // Whatever has arrived since the last newline. The predicate is only ever
    // shown whole lines, so a chunk boundary cannot split the trigger in two.
    let unread = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      if (triggered) return;
      unread += text;
      for (;;) {
        const cut = unread.indexOf('\n');
        if (cut < 0) break;
        const line = unread.slice(0, cut);
        unread = unread.slice(cut + 1);
        if (triggered || line.trim() === '' || !triggerOn(line)) continue;
        triggered = true;
        writeFileSync(releasePath, 'go', 'utf8');
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const pid = proc.pid;

    const guard = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, killAfterMs);

    proc.on('error', (error) => {
      clearTimeout(guard);
      rmSync(preloadDir, { recursive: true, force: true });
      reject(error);
    });

    proc.on('close', (code, signal) => {
      clearTimeout(guard);
      // What the preload recorded, read before the directory holding it goes.
      let raised;
      try {
        raised = existsSync(emitPath)
          ? JSON.parse(readFileSync(emitPath, 'utf8'))
          : undefined;
      } catch (error) {
        rmSync(preloadDir, { recursive: true, force: true });
        reject(error);
        return;
      }
      rmSync(preloadDir, { recursive: true, force: true });
      settle({
        code,
        signal,
        stdout,
        stderr,
        pid,
        timedOut,
        triggered,
        delivered: raised === undefined ? null : raised.delivered,
      });
    });
  });
}

/**
 * A phase that includes integrity markers (gate and pin checks).
 * Used to test gate_check and pin_check trace events.
 */
export function integrityCheckPhase({
  gatePass = true,
  pinPass = true,
  gateName = 'bar-sha256',
  pinName = 'spec-file',
  gateDetail = '',
  pinDetail = '',
} = {}) {
  const gateMarker =
    '@exolvra-genesis integrity gate | ' +
    gateName +
    ' | ' +
    (gatePass ? 'pass' : 'fail') +
    (gateDetail ? ' | ' + gateDetail : ' |');
  const pinMarker =
    '@exolvra-genesis integrity pin | ' +
    pinName +
    ' | ' +
    (pinPass ? 'pass' : 'fail') +
    (pinDetail ? ' | ' + pinDetail : ' |');
  return [
    {
      type: 'assistant',
      session_id: 'sesn_integrity_test',
      message: {
        content: [
          { type: 'text', text: 'Verifying integrity...\n' + gateMarker + '\n' + pinMarker },
        ],
      },
    },
  ];
}
