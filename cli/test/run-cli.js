import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  return { code: proc.status, stdout: proc.stdout, stderr: proc.stderr };
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
          result: captured ?? 'FAKE PLAN BODY',
          errors: [],
        }
      : {
          type: 'result',
          subtype,
          session_id: 'sesn_fake',
          num_turns: 2,
          total_cost_usd: 0,
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
