import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { splitFrontmatter } from '../dist/agents.js';
import { lifecycleLabel } from '../dist/allowlist.js';
import {
  ISSUE_EXIT,
  passExitCode,
  readEvent,
  readIssueTarget,
  repoFromRemoteUrl,
  reread,
  sameHost,
  workCommand,
} from '../dist/commands/work.js';
import { GitHubError } from '../dist/github.js';
import { sha256 } from '../dist/issue-run.js';
import { pullRequestTitle, renderPullRequestBody } from '../dist/pr-body.js';
import { NO_IDENTITY, startGitHubFake } from './github-fake.js';
import { PACKAGE_ROOT, REPO_ROOT, createSandbox } from './run-cli.js';

/*
 * `exolvra-genesis work`, driven end to end as a real process.
 *
 * Two things stand in for an external service here and nothing else does. The
 * Claude Agent SDK is replaced at the one seam this CLI already has for it, and
 * the GitHub API is a real local HTTP server that the real `src/github.ts` talks
 * to over a real socket through its configurable host. Everything on this side
 * of both boundaries is the compiled binary the package ships, started as a
 * child process: the flag boundary, the allowlist, the claim, the snapshot and
 * its pin, the label moves, the status comment, the branch, the commit, the
 * push, the pull request body, the run ledger, the signal handling and the exit
 * codes all run for real.
 *
 * git is not stood in for at all. Every checkout below is a real repository with
 * a real bare remote beside it, so a push is a push and a branch guard that
 * refused one would fail these tests rather than pass them.
 *
 * Every label, comment, pull request and exit code asserted on is read back from
 * the server, from disk, or off a process — never from the value a function
 * answered with.
 */

/* -------------------------------------------------------------------------- */
/* The labels, spelled by the module that owns the vocabulary                  */
/* -------------------------------------------------------------------------- */

const READY = lifecycleLabel('ready');
const WORKING = lifecycleLabel('working');
const REVIEW = lifecycleLabel('review');
const BLOCKED = lifecycleLabel('blocked');
const TRIAGE = lifecycleLabel('triage');

/** The account the fake server authors comments as, and names the token as. */
const RUNNER_LOGIN = 'exolvra-genesis';

/** One newline, named so a line-splitting assertion reads as one. */
const NL = String.fromCharCode(10);

/* -------------------------------------------------------------------------- */
/* The transport                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A scripted stand-in for the Claude Agent SDK.
 *
 * A script rather than a mock: each phase says what the agent writes into the
 * work tree, what it says on the stream, what it costs and how the turn ends.
 * One phase is consumed per issue the loop is run for, because `work` runs the
 * loop once per issue in this one process. Nothing in it knows what the CLI is
 * going to do with any of it.
 */
const FAKE_SDK = `import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

let phaseIndex = 0;

export function query({ prompt, options }) {
  const plan = JSON.parse(readFileSync(process.env.EXOLVRA_GENESIS_WORK_FAKE, 'utf8'));
  const phase = plan.phases[Math.min(phaseIndex, plan.phases.length - 1)] ?? {};
  phaseIndex += 1;

  const record = process.env.EXOLVRA_GENESIS_WORK_FAKE_PROMPTS;
  if (record !== undefined && record !== '') {
    const seen = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : [];
    seen.push({
      prompt,
      cwd: options.cwd,
      model: options.model ?? null,
      maxTurns: options.maxTurns ?? null,
      maxBudgetUsd: options.maxBudgetUsd ?? null,
      permissionMode: options.permissionMode ?? null,
      agents: Object.keys(options.agents ?? {}),
      // What the session was really handed, so a test can assert on the
      // environment a builder would run in rather than on an intention.
      env: Object.fromEntries(
        Object.entries(options.env ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : null]),
      ),
    });
    writeFileSync(record, JSON.stringify(seen, null, 2), 'utf8');
  }

  const put = (relative, text) => {
    const file = join(options.cwd, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
  };

  let release = () => {};
  const held = new Promise((resolve) => {
    release = resolve;
  });

  return {
    async interrupt() {
      release();
    },
    async *[Symbol.asyncIterator]() {
      for (const write of phase.writes ?? []) put(write.path, write.text);
      if (phase.progress !== undefined) put('.exolvra-genesis/progress.html', phase.progress);
      if (phase.barPins !== undefined) {
        const lines = [];
        for (let i = 0; i < phase.barPins; i += 1) {
          lines.push('a'.repeat(63) + i + '  artifact-' + i + '.txt');
        }
        put('.exolvra-genesis/bar/bar.sha256', lines.join('\\n') + '\\n');
      }
      // Editing the pinned snapshot is what C11 says every round re-verifies —
      // before the work starts, or in the moments after the last round, which
      // is where an edit could once outrun the per-round check.
      const tamper = () => {
        const runs = join(options.cwd, '.exolvra-genesis', 'runs');
        for (const entry of readdirSync(runs)) {
          const file = join(runs, entry, 'issue.md');
          if (existsSync(file)) {
            writeFileSync(file, readFileSync(file, 'utf8') + '\\nedited by a builder\\n', 'utf8');
          }
        }
      };
      if (phase.tamper === true) tamper();

      const interruptAt = Array.isArray(phase.interruptAfter)
        ? phase.interruptAfter
        : phase.interruptAfter === undefined
          ? []
          : [phase.interruptAfter];
      let sent = 0;
      for (const text of phase.messages ?? []) {
        yield {
          type: 'assistant',
          session_id: phase.sessionId ?? 'sesn_work',
          message: { content: [{ type: 'text', text }] },
        };
        sent += 1;
        if (interruptAt.includes(sent)) {
          // Windows cannot deliver a signal from one process to another, so the
          // signal is raised inside the process under test. It dispatches the
          // same listeners, in the same order, a real Ctrl+C dispatches.
          process.emit('SIGINT');
        }
      }
      if (phase.tamperAfterMessages === true) tamper();
      if (phase.state !== undefined) {
        put('.exolvra-genesis/state.json', JSON.stringify({ status: phase.state }, null, 2) + '\\n');
      }
      if (phase.hold === true) {
        await held;
        return;
      }
      const result = phase.result;
      if (result === undefined || result === null) return;
      yield {
        type: 'result',
        subtype: result.subtype ?? 'success',
        session_id: phase.sessionId ?? 'sesn_work',
        num_turns: 3,
        total_cost_usd: result.costUsd ?? 0,
        result: result.text ?? '',
        errors: result.errors ?? [],
      };
    },
  };
}
`;

/** The package's own dependencies, linked rather than copied into the sandbox. */
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

const TEMP = [];
const SERVERS = [];

after(async () => {
  for (const fake of SERVERS) await fake.close();
  sandbox.cleanup();
  for (const dir of TEMP) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Left for the operating system to reclaim.
    }
  }
});

function temp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), 'exolvra-genesis-' + prefix));
  TEMP.push(dir);
  return dir;
}

/* -------------------------------------------------------------------------- */
/* A real repository, with a real remote beside it                             */
/* -------------------------------------------------------------------------- */

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.error, undefined, 'git could not be started');
  assert.equal(
    result.status,
    0,
    'git ' + args.join(' ') + ' failed:\n' + (result.stderr ?? ''),
  );
  return result.stdout ?? '';
}

/** The ignore rules that let committed intent and ignored run state share a directory. */
const GITIGNORE = [
  '/.exolvra-genesis/*',
  '!/.exolvra-genesis/standards.md',
  '!/.exolvra-genesis/goals/',
  '',
].join('\n');

const STANDARDS = [
  '# Standards',
  '',
  'The repository this pass runs in, and the bar every change to it keeps.',
  '',
  '## Gates',
  '',
  '- G1. The suite passes: `npm test`.',
  '',
  '## Standing bar',
  '',
  '- `docs/bar.txt` — the shape every page here is judged against',
  '',
  '## Conventions',
  '',
  'Plain-text edits only, never a regex splice across lines.',
  '',
].join('\n');

/**
 * A checkout on `trunk`, with a bare remote it can really be pushed to.
 *
 * The remote lives at `<temp>/<owner>/<name>.git`, so `git remote get-url
 * origin` names a repository the way every real remote does — the last two path
 * segments — and the pass can tell which repository this checkout is *of*. A
 * remote that looked like a GitHub URL would not do: git rewrites `insteadOf`
 * before `get-url` answers, so a checkout dressed up that way reports the local
 * path anyway. This reports what it really is.
 */
function checkout({ standards = true, owner = 'cli', name = 'cli', gitignore = true } = {}) {
  const bare = join(temp('work-remote-'), owner, name + '.git');
  const work = temp('work-repo-');
  mkdirSync(bare, { recursive: true });
  git(['init', '--bare'], bare);
  git(['init'], work);
  git(['symbolic-ref', 'HEAD', 'refs/heads/trunk'], work);
  // A fresh adopter has no ignore rules at all — which is the case every
  // fixture here used to hide, and the one a live pass fell over on.
  if (gitignore) writeFileSync(join(work, '.gitignore'), GITIGNORE, 'utf8');
  mkdirSync(join(work, 'docs'), { recursive: true });
  writeFileSync(join(work, 'docs', 'bar.txt'), 'the shape a page is judged against\n', 'utf8');
  if (standards) {
    mkdirSync(join(work, '.exolvra-genesis'), { recursive: true });
    writeFileSync(join(work, '.exolvra-genesis', 'standards.md'), STANDARDS, 'utf8');
  }
  git(['add', '--all'], work);
  git(
    [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'initial',
    ],
    work,
  );
  git(['remote', 'add', 'origin', bare], work);
  git(['push', '-u', 'origin', 'trunk'], work);
  return { work, bare };
}

/** Every branch the bare remote holds, which is the proof a push happened. */
function remoteBranches(bare) {
  return git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], bare)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/* -------------------------------------------------------------------------- */
/* The fake GitHub, seeded                                                     */
/* -------------------------------------------------------------------------- */

const CRITERIA_BODY = [
  'The runner has to snapshot the issue before it starts.',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] the issue, its labels and its comments are on disk before the first round',
  '- [ ] the snapshot is pinned by sha256 and re-verified every round',
  '',
  '## Verification',
  '',
  '```sh',
  'npm test',
  '```',
].join('\n');

const VAGUE_BODY = [
  'Something is off with the exporter.',
  '',
  'It behaves strangely on large files and somebody should look into it at some point.',
].join('\n');

async function fakeHost({ protectAll = false, ...options } = {}) {
  const fake = await startGitHubFake({
    identity: { login: RUNNER_LOGIN, id: 4242, type: 'User' },
    ...options,
  });
  SERVERS.push(fake);
  fake.seedRepo({
    owner: 'cli',
    name: 'cli',
    defaultBranch: 'trunk',
    branches: ['trunk'],
    // `**` is GitHub's own spelling for every branch there is, so a repository
    // seeded with it protects the runner's namespace along with everything
    // else — a real configuration, and the one that leaves this runner with no
    // branch it may write.
    protectedBranches: protectAll ? ['**'] : ['trunk'],
  });
  return fake;
}

/** A host carrying the three issues one pass has to tell apart. */
async function threeIssues(options = {}) {
  const fake = await fakeHost(options);
  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 801,
    title: 'Snapshot the issue before the first round',
    body: CRITERIA_BODY,
    labels: [READY, 'bug'],
    minutes: 0,
  });
  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 802,
    title: 'Re-verify the pin every round',
    body: CRITERIA_BODY,
    labels: [READY],
    minutes: 10,
  });
  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 803,
    title: 'The exporter is strange',
    body: VAGUE_BODY,
    labels: [READY],
    minutes: 20,
  });
  return fake;
}

/* -------------------------------------------------------------------------- */
/* Running the built binary                                                    */
/* -------------------------------------------------------------------------- */

/** One assistant message carrying a round marker, in the loop's own shape. */
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
  'I captured the repository’s own standards as the bar.',
  '@exolvra-genesis bar .exolvra-genesis/bar',
  '@exolvra-genesis artifact .exolvra-genesis/bar/BAR.md | the merged gates',
  '@exolvra-genesis piece P1 | The snapshot and its pin',
].join('\n');

const PAGE = '<!doctype html><title>progress</title><p>a run in progress';

/** A phase that wins: writes a file, judges two rounds, records complete. */
function winningPhase(path = 'src/one.txt') {
  return {
    writes: [{ path, text: 'the work the loop did\n' }],
    progress: PAGE,
    barPins: 3,
    messages: [OPENING, round('P1', 1, 'LOSS', 'the pin is not re-verified'), round('P1', 2, 'WIN')],
    state: 'complete',
    result: { text: 'P1 won twice in a row.', costUsd: 0.42 },
  };
}

/** A phase that stops at its budget: writes a file, judges one losing round. */
function losingPhase(path = 'src/two.txt') {
  return {
    writes: [{ path, text: 'as far as the loop got\n' }],
    progress: PAGE,
    barPins: 3,
    messages: [OPENING, round('P1', 1, 'LOSS', 'the snapshot is never re-read')],
    state: 'stopped',
    result: { subtype: 'error_max_turns', costUsd: 0.11 },
  };
}

/** The same binary, the same environment, a different command. */
function queue(fake, args, options = {}) {
  return runCli('queue', fake, args, options);
}

function work(fake, args, options = {}) {
  return runCli('work', fake, args, options);
}

function runCli(command, fake, args, { cwd, phases = [], env = {}, scratch } = {}) {
  const home = scratch ?? temp('work-scratch-');
  const script = join(home, 'fake-sdk.json');
  writeFileSync(script, JSON.stringify({ phases }, null, 2), 'utf8');
  const prompts = join(home, 'sdk-prompts.json');

  const overrides = {
    GITHUB_API_URL: fake === undefined ? undefined : fake.origin,
    GITHUB_TOKEN: fake === undefined ? undefined : fake.token,
    EXOLVRA_GENESIS_REPOS: undefined,
    EXOLVRA_GENESIS_RUNNER_LOGIN: undefined,
    EXOLVRA_GENESIS_PLUGIN_DIR: undefined,
    EXOLVRA_GENESIS_FORCE_TTY: undefined,
    EXOLVRA_GENESIS_WORK_FAKE: script,
    EXOLVRA_GENESIS_WORK_FAKE_PROMPTS: prompts,
    ...env,
  };
  const childEnv = { ...process.env, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete childEnv[key];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [sandbox.bin, command, ...args], {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal !== null) {
        reject(new Error('the CLI process was killed by ' + signal));
        return;
      }
      resolve({
        code,
        stdout,
        stderr,
        prompts: () => (existsSync(prompts) ? JSON.parse(readFileSync(prompts, 'utf8')) : []),
      });
    });
  });
}

/** An environment whose PATH is exactly `dir`, whatever case this OS spells it. */
function pathOf(dir) {
  const stripped = {};
  for (const key of Object.keys(process.env)) {
    if (/^path$/i.test(key)) stripped[key] = undefined;
  }
  return { ...stripped, PATH: dir };
}

/** The suffixes an entry can carry and still resolve as a program on this OS. */
const PROGRAM_EXTENSIONS = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

/** Whether `dir` holds something that would resolve as `program`. */
function holds(dir, program) {
  return PROGRAM_EXTENSIONS.some((extension) => existsSync(join(dir, program + extension)));
}

/** The directories of a PATH string, in order, empties dropped. */
function pathEntries(search) {
  return search.split(process.platform === 'win32' ? ';' : ':').filter((entry) => entry !== '');
}

/** This host's own PATH, whatever case it spells the variable. */
function hostPath() {
  return process.env.PATH ?? process.env.Path ?? '';
}

/**
 * A directory that resolves git and does not resolve `gh` — built, not found.
 *
 * The run this serves has to reach its checkout, which means real git, and
 * still have no way of being handed a token, which means `gh` must be
 * unreachable. Searching this host's PATH for a directory answering both cannot
 * be relied on: a Linux runner installs git and `gh` side by side in
 * `/usr/bin`, so the search succeeds and hands back a directory carrying the
 * one program the test needs missing. The directory is therefore made here, and
 * the property is asserted on what was made.
 *
 * POSIX can construct one outright: a two-line `exec` script named `git`, alone
 * in a fresh directory, forwarding to the real binary. No host layout reaches
 * it.
 *
 * Windows can only mirror one. A copied `git.exe` loses the DLLs and the
 * install root it expects to find beside itself; hard links and file symlinks
 * want rights a test process is not given; and a `git.cmd` never starts at all,
 * because `git.ts` spawns without a shell and Windows will not launch a script
 * that way. That leaves a directory junction onto a real git's own directory,
 * which carries that directory's neighbours along with it — so on Windows, and
 * only on Windows, the source has to be a directory that already holds no `gh`.
 */
function gitOnlyPath(search = hostPath()) {
  const dir = join(temp('git-shim-'), 'bin');
  const carrying = pathEntries(search).filter((entry) => holds(entry, 'git'));
  assert.ok(
    carrying.length > 0,
    'git is not on the PATH this was handed, so no PATH carrying git can be built from it',
  );

  if (process.platform !== 'win32') {
    const real = join(carrying[0], 'git');
    assert.ok(!real.includes("'"), 'this git cannot be quoted into a shim script: ' + real);
    mkdirSync(dir, { recursive: true });
    const shim = join(dir, 'git');
    writeFileSync(shim, '#!/bin/sh' + NL + "exec '" + real + "' \"$@\"" + NL, 'utf8');
    chmodSync(shim, 0o755);
  } else {
    const source = carrying.find((entry) => !holds(entry, 'gh'));
    assert.ok(
      source !== undefined,
      'every git on this PATH shares a directory with gh, and Windows gives a test no way ' +
        'to put a working git.exe anywhere else',
    );
    symlinkSync(source, dir, 'junction');
  }

  assert.ok(holds(dir, 'git'), 'the directory built for this test does not resolve git');
  assert.ok(!holds(dir, 'gh'), 'the directory built for this test resolves gh');
  const version = spawnSync('git', ['--version'], {
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, ...pathOf(dir) },
  });
  assert.equal(
    version.status,
    0,
    'git does not run from the directory built for this test: ' +
      (version.error?.code ?? version.stderr),
  );
  return dir;
}

/* -------------------------------------------------------------------------- */
/* Reading what really happened                                                */
/* -------------------------------------------------------------------------- */

/** Every request that could have changed anything, as method and path. */
function writeLog(fake) {
  return fake.requests
    .filter((request) => request.method !== 'GET')
    .map((request) => request.method + ' ' + request.path);
}

/** Every label operation the server was really sent, in order. */
function labelOps(fake) {
  const out = [];
  for (const request of fake.requests) {
    const match = request.path.match(
      /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels(?:\/(.+))?$/,
    );
    if (match === null) continue;
    if (request.method === 'POST') {
      for (const label of Array.isArray(request.json?.labels) ? request.json.labels : []) {
        out.push('#' + match[1] + ' +' + label);
      }
    }
    if (request.method === 'DELETE') out.push('#' + match[1] + ' -' + match[2]);
  }
  return out;
}

/** The comments on an issue that carry one of this tool's hidden markers. */
function markedComments(fake, number, kind) {
  return fake
    .commentsOn('cli', 'cli', number)
    .filter((comment) => comment.body.startsWith('<!-- exolvra-genesis:' + kind));
}

/** The rows of the summary table, as a pipe gets them: one record per line. */
function summaryRows(stdout) {
  return stdout
    .split('\n')
    .filter((line) => /^[^\t]+\/[^\t]+\t#\d+\t/.test(line))
    .map((line) => line.split('\t'));
}

/**
 * The exit code those rows add up to, read through the command's own table.
 *
 * This is the cross-check the whole finding turns on: the words a person is
 * shown and the code a scheduler acts on come from one value, so a test can
 * compute one from the other and demand they match.
 */
function exitFor(rows) {
  return passExitCode(rows.map((row) => ({ result: row[2] })));
}

function runDirs(cwd) {
  const runs = join(cwd, '.exolvra-genesis', 'runs');
  return existsSync(runs) ? readdirSync(runs).sort() : [];
}

function ledger(cwd) {
  const path = join(cwd, '.exolvra-genesis', 'runs.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
}

/* -------------------------------------------------------------------------- */
/* The pull request body, beside the bar it is judged against                  */
/* -------------------------------------------------------------------------- */

const SAMPLE_REPORT = {
  repo: { owner: 'cli', name: 'cli' },
  issue: 801,
  issueTitle: 'Snapshot the issue before the first round',
  issueUrl: 'https://github.com/cli/cli/issues/801',
  runId: 'r-20260814-1830-aaa111',
  ledgerRunId: 'r-20260814-1831-bbb222',
  branch: 'exolvra-genesis/issue-801-snapshot-the-issue',
  branchUrl: 'https://github.com/cli/cli/tree/exolvra-genesis/issue-801-snapshot-the-issue',
  baseBranch: 'trunk',
  head: '0123456789abcdef0123456789abcdef01234567',
  outcome: 'win',
  rounds: [
    { piece: 'P1', number: 1, verdict: 'LOSS', gap: 'the pin is never re-verified' },
    { piece: 'P1', number: 2, verdict: 'WIN' },
  ],
  budget: { rounds: 2, maxRounds: 12, costUsd: 0.42, maxCostUsd: 10 },
  attestations: [
    { name: 'Issue snapshot', detail: 'it still hashes to sha256:abc', ok: true },
    { name: 'Bar', detail: 'three artifacts are pinned', ok: true },
  ],
  snapshot: {
    path: '.exolvra-genesis/runs/r-20260814-1830-aaa111/issue.md',
    sha256: 'a'.repeat(64),
    verified: true,
  },
  standards: {
    path: '.exolvra-genesis/standards.md',
    sha256: 'b'.repeat(64),
    gates: 6,
    standingBar: 4,
  },
  bar: { path: '.exolvra-genesis/bar/bar.sha256', pins: 3 },
  runner: { login: 'exolvra-genesis', from: 'token' },
  progressPage: '.exolvra-genesis/runs/r-20260814-1830-aaa111/progress.html',
  files: [{ status: ' M', path: 'src/one.txt' }],
  generatedAt: '2026-08-14T18:30:00Z',
};

test('R9: a winning pull request body leads with the evidence and folds the bulk', () => {
  const body = renderPullRequestBody(SAMPLE_REPORT);
  const lines = body.split('\n');

  // Evidence first: the opening line says what it works and what happened,
  // before anything else on the page.
  assert.match(lines[0], /^Works \[`cli\/cli#801`\]\(https:\/\/github\.com\/cli\/cli\/issues\/801\)/);
  assert.match(body, /Won the blind comparison at round 2 of 12, for \$0\.42 of \$10\.00\./);
  assert.match(body, /merge decision is a human’s/);

  // The table a reviewer reads without opening anything.
  for (const row of ['| Issue', '| Branch', '| Result', '| Rounds', '| Cost', '| Spec', '| Standards', '| Bar', '| Head', '| Runner', '| Run']) {
    assert.ok(body.includes(row), 'the status table has no ' + row + ' row\n' + body);
  }
  assert.match(body, /\*\*WIN\*\* — last verdict \*\*WIN\*\*, on P1 round 2/);
  assert.match(body, /`sha256:aaaaaaaaaaaa…aaaa`/);

  // The bulk, folded rather than dropped.
  assert.match(body, /<summary>Verdict history \(2 rounds\)<\/summary>/);
  assert.match(body, /<summary>Integrity attestations \(2\)<\/summary>/);
  assert.match(body, /<summary>Files changed \(1 file\)<\/summary>/);
  // F6: a reader is shown what happened to the file, not the two-letter column
  // `git status --porcelain` writes it in.
  assert.match(body, /- `src\/one\.txt` — modified/);
  assert.ok(!body.includes('??'), 'a porcelain status code reached the body');
  assert.match(body, /\| 1 +\| P1 +\| \*\*LOSS\*\* \| the pin is never re-verified \|/);

  // Which numbers describe the merge and which describe the run, said rather
  // than left to be worked out.
  // The head whole, not shortened: it is the one value a reviewer may want to
  // check against the branch, and half of a sha checks against nothing.
  assert.match(
    body,
    /\| Head +\| `0123456789abcdef0123456789abcdef01234567` — the commit this would merge/,
  );
  assert.match(body, /\| Rounds +\| 2 of 12 rounds, this run/);
  assert.match(body, /\| Cost +\| \$0\.42 of \$10\.00, this run/);
  assert.match(
    body,
    /What merging `exolvra-genesis\/issue-801-snapshot-the-issue` into `trunk` would change/,
  );
  assert.match(body, /every commit on the branch, not only this run’s/);

  // And the closing note, which is the same on every one of these.
  assert.match(body, /Opened by `exolvra-genesis work` at 2026-08-14T18:30:00Z UTC/);
  assert.match(body, /no label outside `exolvra:` was touched/);

  // Rendering it twice gives the same bytes: the structure is not a function of
  // when it was drawn.
  assert.equal(renderPullRequestBody(SAMPLE_REPORT), body);
  assert.equal(
    pullRequestTitle(SAMPLE_REPORT),
    'Snapshot the issue before the first round (#801)',
  );
});

test('R10: a draft body leads with the reason and what a human has to decide', () => {
  const body = renderPullRequestBody({
    ...SAMPLE_REPORT,
    outcome: 'stopped',
    reason: 'the per-issue round budget was spent: 12 of 12',
    decision: 'raise the budget, or say in the issue what is missing',
    rounds: [{ piece: 'P1', number: 1, verdict: 'LOSS', gap: 'the pin is never re-verified' }],
    budget: { rounds: 12, maxRounds: 12, costUsd: 3.5, maxCostUsd: 10 },
  });

  assert.match(body.split('\n')[0], /^Stopped on \[`cli\/cli#801`\]/);
  assert.match(body, /the per-issue round budget was spent: 12 of 12\. It stopped at round 12 of 12/);
  assert.match(body, /\*\*What a human has to decide\*\* — raise the budget/);
  assert.match(body, /\| Result +\| \*\*STOPPED\*\*/);
  // Same sections, same order, however it ended.
  assert.match(body, /<summary>Verdict history \(1 round\)<\/summary>/);
  assert.match(body, /Opened by `exolvra-genesis work`/);
});

test('R9: the files block says what happened to each file, never a porcelain code', () => {
  const body = renderPullRequestBody({
    ...SAMPLE_REPORT,
    files: [
      { status: '??', path: 'src/added.js' },
      { status: ' M', path: 'src/modified.js' },
      { status: 'M ', path: 'src/staged.js' },
      { status: ' D', path: 'src/gone.js' },
      { status: 'R ', path: 'src/new-name.js', from: 'src/old-name.js' },
      { status: 'A ', path: 'src/created.js' },
      { status: 'UU', path: 'src/conflict.js' },
    ],
  });

  assert.match(body, /<summary>Files changed \(7 files\)<\/summary>/);
  for (const line of [
    '- `src/added.js` — added',
    '- `src/modified.js` — modified',
    '- `src/staged.js` — modified',
    '- `src/gone.js` — deleted',
    '- `src/new-name.js` — renamed from `src/old-name.js`',
    '- `src/created.js` — added',
    '- `src/conflict.js` — conflicted',
  ]) {
    assert.ok(body.includes(line), 'the files block never says: ' + line + '\n' + body);
  }

  // Nothing of git's own alphabet survives onto a page judged beside a body
  // that never shows its plumbing.
  for (const code of ['??', ' M ', 'R ', 'UU', '!!']) {
    assert.ok(
      !body.includes(code),
      'a porcelain status column reached the body: ' + JSON.stringify(code),
    );
  }
});

test('C5/C12: an issue title cannot break the body, and a token is never republished', () => {
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const hostile =
    'Fix |the| `table` <script>alert(1)</script> ' +
    String.fromCharCode(0x202e) +
    ' with ' +
    token;
  const body = renderPullRequestBody({ ...SAMPLE_REPORT, issueTitle: hostile });

  assert.ok(!body.includes(token), 'a token pasted into a title was republished');
  // Escaped, because a title is markdown-escaped on the way into a cell — but
  // said, rather than silently dropped.
  assert.ok(body.includes('\\[redacted\\]'), 'the token was removed without saying so');
  assert.ok(
    !body.includes(String.fromCharCode(0x202e)),
    'a right-to-left override survived into the body',
  );
  assert.ok(!body.includes('<script>'), 'a script tag survived into the body');
  // The pipe is escaped rather than left to invent a column.
  assert.ok(body.includes('\\|the\\|'), 'a pipe in a title was not escaped\n' + body);
  assert.ok(!pullRequestTitle({ ...SAMPLE_REPORT, issueTitle: hostile }).includes(token));
});

test('C5/C12: a pull request title is flattened as well as redacted', () => {
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const RLO = String.fromCharCode(0x202e);
  const PDF = String.fromCharCode(0x202c);
  const RLM = String.fromCharCode(0x200f);
  const ESC = String.fromCharCode(0x1b);
  const title =
    'Fix the ' + RLO + 'gnitroper' + PDF + ' path' + RLM + ' with ' + token + ESC + '[31m';

  const rendered = pullRequestTitle({ ...SAMPLE_REPORT, issueTitle: title });

  // A title is not markdown, so it never went through the escaping the body's
  // cells do — which is how the reordering controls survived on the one line a
  // reviewer reads before deciding anything.
  for (const [name, ch] of [['RLO', RLO], ['PDF', PDF], ['RLM', RLM], ['escape', ESC]]) {
    assert.ok(!rendered.includes(ch), name + ' survived into the pull request title: ' + rendered);
  }
  assert.ok(!rendered.includes(token), 'a credential survived into the title');
  assert.ok(rendered.includes('[redacted]'), 'the credential went without being said');
  assert.equal(rendered.split('\n').length, 1, 'a title became more than one line');
  assert.ok(rendered.endsWith(' (#801)'), 'the issue number was cut off the title');

  // A newline and a tab are flattened the same way, so a title is one line.
  const wrapped = pullRequestTitle({ ...SAMPLE_REPORT, issueTitle: 'one\nline\ttwo' });
  assert.equal(wrapped, 'one line two (#801)');
});

/* -------------------------------------------------------------------------- */
/* The issue reference                                                         */
/* -------------------------------------------------------------------------- */

test('R2: an issue is written as a number, a reference, or the URL of its page', () => {
  assert.deepEqual(readIssueTarget('801'), { repo: undefined, host: undefined, number: 801 });
  assert.deepEqual(readIssueTarget('#801'), { repo: undefined, host: undefined, number: 801 });
  assert.deepEqual(readIssueTarget('cli/cli#801'), {
    repo: { owner: 'cli', name: 'cli' },
    host: undefined,
    number: 801,
  });
  // The host is kept, not discarded: which host a URL was written against is
  // the difference between this run's GitHub and somebody else's.
  assert.deepEqual(readIssueTarget('https://github.com/cli/cli/issues/801'), {
    repo: { owner: 'cli', name: 'cli' },
    host: 'github.com',
    number: 801,
  });
  assert.deepEqual(readIssueTarget('https://ghe.example.com/cli/cli/issues/801#issuecomment-1'), {
    repo: { owner: 'cli', name: 'cli' },
    host: 'ghe.example.com',
    number: 801,
  });
  assert.deepEqual(readIssueTarget('http://127.0.0.1:8080/cli/cli/issues/801'), {
    repo: { owner: 'cli', name: 'cli' },
    host: '127.0.0.1',
    number: 801,
  });

  for (const written of [
    '',
    'not-an-issue',
    '0',
    'cli/cli',
    'https://github.com/cli/cli/pull/801',
    'cli/cli#0x1',
    'not/a/repository/path#1',
  ]) {
    assert.equal(
      typeof readIssueTarget(written),
      'string',
      JSON.stringify(written) + ' was read as an issue',
    );
  }
});

test('the machine stream `run --json` writes is read back as the events it stands for', () => {
  // The coupling between the two commands, exercised on its own. Everything
  // below is a line the reporter really writes — the summary among them, which
  // is the one record written without a `type` because it *is* the summary.
  assert.deepEqual(readEvent('{"type":"run_started","goal":"a.md","source":"spec"}'), {
    type: 'run_started',
    goal: 'a.md',
    source: 'spec',
  });
  assert.deepEqual(
    readEvent('{"type":"round","piece":"P1","round":2,"verdict":"WIN","gap":null,"elapsed_ms":40}'),
    { type: 'round', piece: 'P1', round: 2, verdict: 'WIN', elapsedMs: 40 },
  );
  assert.deepEqual(
    readEvent('{"type":"round","piece":"P1","round":1,"verdict":"LOSS","gap":"no","elapsed_ms":null}'),
    { type: 'round', piece: 'P1', round: 1, verdict: 'LOSS', gap: 'no' },
  );
  assert.deepEqual(readEvent('{"status":"win","rounds":3,"cost_usd":1.5,"session_id":"s1"}'), {
    type: 'run_finished',
    status: 'win',
    rounds: 3,
    costUsd: 1.5,
    sessionId: 's1',
  });
  assert.deepEqual(readEvent('{"status":"stopped","rounds":0,"cost_usd":0,"session_id":null}'), {
    type: 'run_finished',
    status: 'stopped',
    rounds: 0,
    costUsd: 0,
  });
  assert.deepEqual(readEvent('{"type":"notice","level":"warning","message":"a guard tripped"}'), {
    type: 'notice',
    level: 'warning',
    message: 'a guard tripped',
  });
  assert.deepEqual(readEvent('{"type":"plan_ready","pieces":[{"id":"P1","title":"one"}]}'), {
    type: 'plan_ready',
    pieces: [{ id: 'P1', title: 'one' }],
  });

  // A line that is not an event this build can act on is skipped rather than
  // guessed at: a verdict that is not one, a round that is not a number, a
  // status that is not an ending, and anything that is not a JSON object.
  for (const line of [
    'not json',
    '[]',
    '"a string"',
    '{"type":"round","piece":"P1","round":1,"verdict":"MAYBE"}',
    '{"type":"round","piece":"P1","round":"two","verdict":"WIN"}',
    '{"status":"finished","rounds":1,"cost_usd":0}',
    '{"rounds":1,"cost_usd":0}',
    '{"type":"something_new","a":1}',
  ]) {
    assert.equal(readEvent(line), undefined, 'read as an event: ' + line);
  }
});

test('a read that nothing answered is asked once more; an answer never is', async () => {
  const said = [];
  const reporter = { emit: (event) => said.push(event) };
  const unreachable = () =>
    new GitHubError({
      message: 'could not reach GitHub to list pull requests in cli/cli',
      kind: 'unreachable',
      operation: 'list pull requests in cli/cli',
    });

  // Nothing answered, then something did: asked twice, and said out loud.
  let asked = 0;
  const recovered = await reread(reporter, 'list pull requests', async () => {
    asked += 1;
    if (asked === 1) throw unreachable();
    return 'the answer';
  });
  assert.equal(recovered, 'the answer');
  assert.equal(asked, 2, 'the read was not asked again');
  assert.deepEqual(
    said.map((event) => event.level),
    ['warning'],
    'the second attempt was made silently',
  );

  // Nothing answered twice: it is raised, not asked a third time.
  let twice = 0;
  await assert.rejects(
    reread(reporter, 'list pull requests', async () => {
      twice += 1;
      throw unreachable();
    }),
    /could not reach GitHub/,
  );
  assert.equal(twice, 2, 'a second silence was asked about again');

  // Every other fault is an answer, and an answer is not asked for twice.
  for (const kind of ['auth', 'rate-limit', 'not-found', 'refused', 'malformed', 'http']) {
    let count = 0;
    await assert.rejects(
      reread(reporter, 'list pull requests', async () => {
        count += 1;
        throw new GitHubError({ message: kind + ' happened', kind, operation: 'list' });
      }),
      new RegExp(kind + ' happened'),
    );
    assert.equal(count, 1, 'a ' + kind + ' answer was asked for a second time');
  }

  // And a fault this module did not classify is not this module's to absorb.
  let plain = 0;
  await assert.rejects(
    reread(reporter, 'list pull requests', async () => {
      plain += 1;
      throw new TypeError('a bug in here');
    }),
    TypeError,
  );
  assert.equal(plain, 1);
});

test('the repository a checkout is of is read off its own remote', () => {
  for (const [url, owner, name] of [
    ['https://github.com/cli/cli.git', 'cli', 'cli'],
    ['https://github.com/cli/cli', 'cli', 'cli'],
    ['https://user@github.com/octocat/hello-world.git', 'octocat', 'hello-world'],
    ['git@github.com:cli/cli.git', 'cli', 'cli'],
    ['ssh://git@github.com/cli/cli.git', 'cli', 'cli'],
    ['git://github.com/cli/cli.git', 'cli', 'cli'],
    ['https://ghe.example.com/team/api.git', 'team', 'api'],
    ['/srv/mirrors/cli/cli.git', 'cli', 'cli'],
    ['C:\\\\mirrors\\\\cli\\\\cli.git', 'cli', 'cli'],
    ['https://github.com/cli/cli.git/', 'cli', 'cli'],
  ]) {
    assert.deepEqual(repoFromRemoteUrl(url), { owner, name }, url);
  }

  // And what it will not guess at.
  for (const url of ['', '   ', 'https://github.com/cli', 'cli.git', '/']) {
    assert.equal(typeof repoFromRemoteUrl(url), 'string', JSON.stringify(url) + ' named a repository');
  }
});

test('an issue URL is matched against the host this run talks to', () => {
  // GitHub serves its API and its pages from two names for one service.
  assert.equal(sameHost('https://api.github.com', 'github.com'), true);
  assert.equal(sameHost('https://api.github.com', 'www.github.com'), true);
  assert.equal(sameHost('https://api.github.com', 'api.github.com'), true);
  // An appliance serves both from one host.
  assert.equal(sameHost('https://ghe.example.com/api/v3', 'ghe.example.com'), true);
  assert.equal(sameHost('http://127.0.0.1:8080', '127.0.0.1'), true);
  // And somebody else's host is somebody else's.
  assert.equal(sameHost('https://api.github.com', 'evil.example.com'), false);
  assert.equal(sameHost('https://ghe.example.com/api/v3', 'github.com'), false);
  assert.equal(sameHost('not a url', 'github.com'), false);
});

/* -------------------------------------------------------------------------- */
/* R13 — the dry run touches nothing                                           */
/* -------------------------------------------------------------------------- */

test('R13: --dry-run prints the plan and each derived spec, and makes GETs only', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();

  const result = await work(fake, ['--repo', 'cli/cli', '--max-issues', '3', '--dry-run'], {
    cwd,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /dry run — nothing here was claimed, labelled/);
  assert.match(result.stdout, /allowlist {2}cli\/cli/);
  assert.match(
    result.stdout,
    /standards {2}\.exolvra-genesis\/standards\.md — 1 gate, 1 standing bar entry/,
  );
  assert.match(result.stdout, /eligible {3}3 carrying exolvra:ready, 3 within the work-in-progress cap/);

  // The derived spec for each issue, including the judgement that would triage
  // the third one before it was ever claimed.
  assert.match(result.stdout, /cli\/cli#801 — Snapshot the issue before the first round/);
  assert.match(result.stdout, /runnable {3}yes/);
  assert.match(result.stdout, /the snapshot is pinned by sha256 and re-verified every round/);
  assert.match(result.stdout, /npm test/);
  assert.match(result.stdout, /cli\/cli#803 — The exporter is strange/);
  assert.match(result.stdout, /runnable {3}no — it would be triaged, and not claimed/);
  assert.match(result.stdout, /missing {4}Acceptance criteria/);

  // The proof, off the server's own log rather than off the output.
  const methods = [...new Set(fake.requests.map((request) => request.method))];
  assert.deepEqual(methods, ['GET'], 'a dry run made a request that was not a GET');
  assert.equal(
    fake.requests.some((request) => request.path === '/user'),
    false,
    'a dry run asked GitHub who the token is, which only a run that writes needs',
  );
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), [READY, 'bug']);
  assert.deepEqual(fake.commentsOn('cli', 'cli', 803), []);
  assert.deepEqual(runDirs(cwd), [], 'a dry run wrote a run directory');
});

test('C12: a credential pasted into an issue never reaches the dry run’s output', async () => {
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const fine = 'github_pat_' + '11ABCDE0Y0abcdefghijklmn' + '_' + 'oPqRsTuVwXyZ0123456789';
  const fake = await fakeHost();
  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 850,
    title: 'Auth fails with ' + token + ' — please look',
    body: [
      'It breaks with ' + fine + ' as well.',
      '',
      '## Acceptance criteria',
      '',
      '- [ ] it stops leaking ' + token,
      '',
      '## Verification',
      '',
      '```sh',
      'npm test',
      '```',
    ].join('\n'),
    labels: [READY],
  });
  const { work: cwd } = checkout();

  const result = await work(fake, ['--repo', 'cli/cli', '--dry-run'], { cwd });

  assert.equal(result.code, 0, result.stderr);
  // The dry run is the one surface that draws the issue's own words in bulk —
  // the title, the body's criteria, the verification lines — and `work --help`
  // promises the same treatment there as anywhere else.
  for (const secret of [token, fine]) {
    assert.ok(!result.stdout.includes(secret), 'a credential reached the dry run:\n' + result.stdout);
    assert.ok(!result.stderr.includes(secret), 'a credential reached stderr');
  }
  assert.ok(result.stdout.includes('[redacted]'), 'the credential went without being said');
  // And what is left is still the issue: the redaction did not eat the report.
  assert.match(result.stdout, /cli\/cli#850 — Auth fails with \[redacted\] — please look/);
  assert.match(result.stdout, /it stops leaking \[redacted\]/);
});

/* -------------------------------------------------------------------------- */
/* The identity every write is a precondition of (addendum v0.1.2)             */
/* -------------------------------------------------------------------------- */

test('v0.1.2: a token GitHub will not name exits 2 before an issue is read', async () => {
  const fake = await threeIssues({ identity: NO_IDENTITY });
  const { work: cwd } = checkout();

  const result = await work(fake, ['--repo', 'cli/cli'], { cwd });

  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.equal(result.stdout, '', 'a refused run printed to stdout');
  assert.match(result.stderr, /this run has no identity it can prove/);
  assert.match(result.stderr, /--runner-login <login>, or set EXOLVRA_GENESIS_RUNNER_LOGIN/);
  assert.match(result.stderr, /Usage: {2}exolvra-genesis work/);

  // The central claim of the addendum, checked against the wire: it exits before
  // an issue is read and before a label is touched.
  assert.deepEqual(
    fake.requests.map((request) => request.method + ' ' + request.path),
    ['GET /user'],
    'the refused run reached GitHub for something other than its own identity',
  );
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), [READY, 'bug']);
  assert.deepEqual(runDirs(cwd), []);
});

test('v0.1.2: a login that disagrees with the token exits 2, having written nothing', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();

  const result = await work(
    fake,
    ['--repo', 'cli/cli', '--runner-login', 'somebody-else'],
    { cwd },
  );

  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /refusing to run as an account this token is not/);
  assert.match(result.stderr, /GitHub says the token is @exolvra-genesis/);
  assert.deepEqual(writeLog(fake), [], 'a refused run wrote to the repository');
});

/*
 * GitHub could not be *asked* who the token is — which is not the same failure
 * as GitHub answering no, and must not be reported as one.
 *
 * Nothing in the invocation is wrong, so there is nothing to retype, no advice
 * about `--runner-login`, and above all no suggestion that a network blip is a
 * bug in this CLI worth reporting to its issue tracker.
 */
test('v0.1.2: an identity GitHub could not be asked for is a pass that did not run', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();
  fake.reply({ method: 'GET', path: '/user', status: 503, body: { message: 'Server Error' }, times: 1 });

  const result = await work(fake, ['--repo', 'cli/cli'], { cwd });

  // The code for a run that did not reach a verdict, so the next pass picks up.
  assert.equal(result.code, 1, result.stdout + result.stderr);

  const said = result.stdout + result.stderr;
  assert.match(said, /the pass stopped early:/);
  assert.match(said, /ask who this token is/);
  assert.match(said, /503/);

  // None of the three sentences that would be false for an outage.
  assert.ok(!/unexpected error/.test(said), 'an outage was reported as a bug:\n' + said);
  assert.ok(!/report it at/.test(said), 'an outage sent the reader to the issue tracker:\n' + said);
  assert.ok(
    !/--runner-login/.test(said),
    'an outage was answered with configuration advice:\n' + said,
  );

  // And the claim it makes about the repository is intact: it asked once, and
  // wrote nothing.
  assert.deepEqual(
    fake.requests.map((request) => request.method + ' ' + request.path),
    ['GET /user'],
    'a pass with no identity read or wrote something',
  );
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), [READY, 'bug']);
  assert.deepEqual(runDirs(cwd), []);
});

test('v0.1.2: a GitHub that cannot be reached at all is the same pass that did not run', async () => {
  // A host nothing is listening on: the connection is never made, so there is
  // no answer to misread as one.
  const dead = await startGitHubFake();
  const origin = dead.origin;
  await dead.close();
  const { work: cwd } = checkout();

  const result = await work(undefined, ['--repo', 'cli/cli'], {
    cwd,
    env: { GITHUB_API_URL: origin, GITHUB_TOKEN: 'ghp_' + 'x'.repeat(36) },
  });

  assert.equal(result.code, 1, result.stdout + result.stderr);
  const said = result.stdout + result.stderr;
  assert.match(said, /the pass stopped early:/);
  assert.ok(!/unexpected error/.test(said), said);
  assert.ok(!/report it at/.test(said), said);
});

test('R12: queue under the same outage does not reach the generic fault renderer either', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();
  fake.reply({
    method: 'GET',
    path: '/repos/cli/cli/issues',
    status: 503,
    body: { message: 'Server Error' },
    times: 1,
  });

  const result = await queue(fake, ['--repo', 'cli/cli'], { cwd });

  // `queue` takes its own path and has its own voice; what is asserted here is
  // only that an outage is not dressed up as a bug in this CLI.
  assert.ok(
    !/unexpected error/.test(result.stderr),
    'queue reported an outage as a bug:\n' + result.stderr,
  );
  assert.ok(!/report it at/.test(result.stderr), result.stderr);
  assert.match(result.stderr, /could not list issues|503/);
});

test('v0.1.2: an installation token works once the operator names the account', async () => {
  const fake = await threeIssues({ identity: NO_IDENTITY });
  const { work: cwd, bare } = checkout();

  const result = await work(
    fake,
    ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT],
    { cwd, phases: [winningPhase()], env: { EXOLVRA_GENESIS_RUNNER_LOGIN: RUNNER_LOGIN } },
  );

  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801).sort(), [REVIEW, 'bug'].sort());
  assert.equal(fake.pullsOpened().length, 1);
  assert.ok(
    remoteBranches(bare).some((branch) => branch.startsWith('exolvra-genesis/issue-801-')),
    'the branch was never pushed',
  );
});

/* -------------------------------------------------------------------------- */
/* R11 — the exit-code matrix, as real processes                               */
/* -------------------------------------------------------------------------- */

test('R11/C2: no token at all is a configuration error, and nothing is requested', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();

  const result = await work(fake, ['--repo', 'cli/cli'], {
    cwd,
    env: { GITHUB_TOKEN: undefined, ...pathOf(gitOnlyPath()) },
  });

  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /no GitHub token is available/);
  assert.match(result.stderr, /GITHUB_TOKEN is not set/);
  assert.deepEqual(fake.requests, [], 'a run with no token still reached GitHub');
});

test('the git-only PATH is built, so git and gh in one directory cannot defeat it', () => {
  const windows = process.platform === 'win32';
  const real = pathEntries(hostPath()).find((entry) => holds(entry, 'git'));
  assert.ok(real !== undefined, 'git is not on PATH, so this has nothing real to build from');

  /*
   * A directory in the shape of a Linux runner's `/usr/bin`: git and gh in one
   * place. This machine keeps the two apart, so the collision that broke CI is
   * staged here rather than waited for. Only the test above's need is staged —
   * the git in it forwards to the real one, so anything built from this PATH
   * has to be genuinely runnable.
   */
  const shared = join(temp('shared-tools-'), 'usr-bin');
  mkdirSync(shared, { recursive: true });
  if (windows) {
    writeFileSync(join(shared, 'git.exe'), '', 'utf8');
  } else {
    const shim = join(shared, 'git');
    writeFileSync(shim, '#!/bin/sh' + NL + "exec '" + join(real, 'git') + "' \"$@\"" + NL, 'utf8');
    chmodSync(shim, 0o755);
  }
  writeFileSync(join(shared, windows ? 'gh.exe' : 'gh'), '', 'utf8');

  const search = [shared, real].join(windows ? ';' : ':');

  // Finding a directory — what this replaced — lands on the collision and hands
  // back a PATH that resolves the very program the test needs unreachable.
  const found = pathEntries(search).find((entry) => holds(entry, 'git'));
  assert.equal(found, shared, 'the staged collision is not the first git on this PATH');
  assert.ok(holds(found, 'gh'), 'the staged collision does not hold gh, so it proves nothing');

  // Building one does not. `gitOnlyPath` asserts that git runs from the result.
  const built = gitOnlyPath(search);
  assert.notEqual(built, shared, 'the built directory is the collision itself');
  assert.ok(holds(built, 'git'), 'the built directory does not resolve git');
  assert.ok(!holds(built, 'gh'), 'the built directory resolves gh');
});

test('C5: an empty allowlist is exit 2, and says what an empty one is not', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();

  const result = await work(fake, [], { cwd });

  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /no repository is allowlisted for this run/);
  assert.match(result.stderr, /an empty allowlist\n {2}is never every repository the token can see/);
  assert.match(result.stderr, /Usage: {2}exolvra-genesis work/);
  assert.deepEqual(fake.requests, []);
});

test('C5: a named issue outside the allowlist is refused before anything is read', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();

  const result = await work(fake, ['octocat/hello-world#7', '--repo', 'cli/cli'], { cwd });

  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(
    result.stderr,
    /refusing to work an issue in a repository this run is not allowlisted for/,
  );
  assert.match(result.stderr, /the allowlist is cli\/cli/);
  assert.deepEqual(fake.requests, []);
});

test('R1/R11: a pass with nothing eligible says so and exits 0', async () => {
  const fake = await fakeHost();
  fake.seedIssue({ owner: 'cli', name: 'cli', number: 900, title: 'Nothing to do with this', labels: ['bug'] });
  const { work: cwd } = checkout();

  const result = await work(fake, ['--repo', 'cli/cli'], { cwd });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /no open issue carrying exolvra:ready in cli\/cli/);
  assert.deepEqual(writeLog(fake), []);
});

/* -------------------------------------------------------------------------- */
/* Local preconditions, checked before anything is written                     */
/* -------------------------------------------------------------------------- */

test('an unclean work tree is refused before a single request is made', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();
  // Something a person left behind. It is not gitignored, so it is exactly the
  // condition that used to be discovered after the issue had been claimed.
  writeFileSync(join(cwd, 'half-finished.txt'), 'a change somebody was midway through\n', 'utf8');

  const result = await work(fake, ['--repo', 'cli/cli', '--max-issues', '3'], { cwd });

  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /refusing to start on a work tree with uncommitted changes/);
  assert.match(result.stderr, /half-finished\.txt/);
  assert.match(result.stderr, /commit or stash them, then run again/);

  // The whole of the finding: it is a local, pre-existing, knowable condition,
  // so nothing of anybody's repository was touched — not a write, not a read.
  assert.deepEqual(fake.requests, [], 'a doomed pass still reached GitHub');
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), [READY, 'bug']);
  assert.deepEqual(fake.commentsOn('cli', 'cli', 801), []);
  assert.deepEqual(runDirs(cwd), []);
});

/*
 * The first pass a fresh adopter ever runs.
 *
 * A repository with no `.gitignore` is the ordinary starting point, and the
 * runner writes its own state *inside* that repository — the snapshot, the pin,
 * the progress page. Every fixture here carried an ignore rule that already
 * excluded it, so 1042 tests never saw what a live pass hit immediately: the
 * state directory made the tree unclean, and the cleanliness check refused. It
 * refused *after* the claim, too, because the directory only exists once the
 * snapshot has been written — so the issue was left blocked by the runner's own
 * bookkeeping.
 */
test('R1: a repository with no .gitignore is worked, and its state stays out of the commit', async () => {
  const fake = await threeIssues();
  const { work: cwd, bare } = checkout({ gitignore: false });
  assert.ok(!existsSync(join(cwd, '.gitignore')), 'the fixture is meant to have no ignore rules');

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [winningPhase('src/adopter.txt')],
  });

  // It completes — which means neither the startup check nor the one before the
  // branch was cut ever saw the runner's own directory.
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.ok(
    !/uncommitted changes/.test(result.stdout + result.stderr),
    'the runner was refused by its own state:\n' + result.stdout + result.stderr,
  );
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', REVIEW]);
  assert.equal(fake.pullsOpened().length, 1);

  // The state really is there, untracked and unignored: the premise holds.
  assert.ok(existsSync(join(cwd, '.exolvra-genesis', 'runs')), 'no run state was written');

  // And none of it is in what the merge proposes.
  const branch = fake.pullsOpened()[0].head;
  const proposed = git(['diff', '--name-only', 'trunk...' + branch], bare)
    .trim()
    .split(NL)
    .filter((line) => line !== '');
  assert.deepEqual(proposed, ['src/adopter.txt'], 'the runner shipped its own bookkeeping');

  // Said of the commit itself as well as of the diff, because the two are
  // different questions and the staging is what answers this one.
  const committed = git(['show', '--name-only', '--format=', branch], bare)
    .trim()
    .split(NL)
    .filter((line) => line !== '');
  assert.deepEqual(committed, ['src/adopter.txt']);
  for (const path of [...proposed, ...committed]) {
    assert.ok(!path.startsWith('.exolvra-genesis'), 'run state was staged: ' + path);
  }
  // The body lists the one file and no run state. It still *names* the snapshot
  // in its Spec row, which is the point of that row — what must not appear is a
  // run-state path among the files a merge would bring in.
  const body = fake.pullsOpened()[0].body;
  assert.match(body, /- `src\/adopter\.txt` — added/);
  assert.match(body, /<summary>Files changed \(1 file\)<\/summary>/);
  assert.doesNotMatch(body, /- `\.exolvra-genesis[^`]*` — /, 'run state is listed as a change');
});

test('R1: a genuinely dirty tree still refuses, naming only the real change', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout({ gitignore: false });

  // State left by an earlier pass, which is not the repository's work…
  mkdirSync(join(cwd, '.exolvra-genesis', 'runs', 'r-earlier'), { recursive: true });
  writeFileSync(join(cwd, '.exolvra-genesis', 'runs.json'), '[]\n', 'utf8');
  writeFileSync(join(cwd, '.exolvra-genesis', 'progress.html'), PAGE, 'utf8');
  writeFileSync(join(cwd, '.exolvra-genesis', 'runs', 'r-earlier', 'issue.md'), 'old\n', 'utf8');
  // …and an edit somebody left behind, which is.
  writeFileSync(join(cwd, 'docs', 'bar.txt'), 'a change somebody was midway through\n', 'utf8');

  const result = await work(fake, ['--repo', 'cli/cli'], { cwd });

  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /refusing to start on a work tree with uncommitted changes/);
  assert.match(result.stderr, /docs\/bar\.txt/);
  // The exclusion is not a blindfold: it hides the runner's own directory and
  // nothing else, so the refusal names what a person actually has to settle.
  assert.ok(
    !result.stderr.includes('.exolvra-genesis'),
    'the refusal blamed the runner’s own state:\n' + result.stderr,
  );
  assert.deepEqual(fake.requests, [], 'a doomed pass still reached GitHub');
});

test('a detached HEAD is refused before a single request, and names the fix', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();
  // Standing on the commit rather than the branch: every issue branch is cut
  // from the branch that is checked out, and there is none.
  git(['checkout', '--detach', 'HEAD'], cwd);

  const result = await work(fake, ['--repo', 'cli/cli', '--max-issues', '3'], { cwd });

  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /refusing to start on a detached HEAD/);
  assert.match(result.stderr, /check out the branch this work should start from/);
  // The same discipline as the unclean tree: local, knowable, and settled
  // before anybody's repository is touched.
  assert.deepEqual(fake.requests, [], 'a pass that could do nothing still reached GitHub');
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), [READY, 'bug']);
});

test('R11: an issue whose branch may never be written is reported, not silently skipped', async () => {
  const fake = await fakeHost({ protectAll: true });
  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 860,
    title: 'A branch this runner may not write',
    body: CRITERIA_BODY,
    labels: [READY],
  });
  const { work: cwd } = checkout();

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [winningPhase('src/never-reached.txt')],
  });

  // The refusal will happen again on every pass, so a 0 here would be a
  // scheduled runner reporting success forever while working nothing.
  assert.equal(result.code, 1, result.stdout + result.stderr);
  const rows = summaryRows(result.stdout);
  assert.deepEqual(rows.map((row) => [row[1], row[2], row[3]]), [['#860', 'ineligible', READY]]);
  assert.match(rows[0][4], /its branch could not be prepared/);
  assert.equal(exitFor(rows), result.code);
  assert.match(result.stdout, /not working cli\/cli#860/);
  assert.match(result.stdout, /nothing was claimed for it/);
  // And nothing was: the issue is exactly as it was found.
  assert.deepEqual(writeLog(fake), []);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 860), [READY]);
});

test('a checkout that is not a git repository is refused the same way', async () => {
  const fake = await threeIssues();
  const cwd = temp('work-notrepo-');

  const result = await work(fake, ['--repo', 'cli/cli'], {
    cwd,
    // A temp directory can sit inside somebody else's checkout, and git walks
    // upwards until it finds one. The ceiling stops that walk, so the directory
    // under test really is the thing being tested.
    env: { GIT_CEILING_DIRECTORIES: dirname(cwd) },
  });

  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /not a git repository/);
  assert.match(result.stderr, /this runner works in a checkout; clone the repository first/);
  assert.deepEqual(fake.requests, []);
});

/* -------------------------------------------------------------------------- */
/* R1/C4/C5 — a pass works the repository its checkout is of, and no other     */
/* -------------------------------------------------------------------------- */

/**
 * The judge's scenario: a checkout of cli/cli, an allowlist naming two.
 *
 * The pass used to claim octocat's issue, hand a builder cli/cli's tree, commit
 * there, push the branch into *cli/cli's* remote, and open the pull request on
 * octocat — where the branch does not exist — and exit 0. Every step was
 * individually right; nothing asked whether they were about one repository.
 */
test('R1: an issue in another repository is not worked, and nothing local is written', async () => {
  const fake = await threeIssues();
  fake.seedRepo({ owner: 'octocat', name: 'hello-world', defaultBranch: 'main' });
  fake.seedIssue({
    owner: 'octocat',
    name: 'hello-world',
    number: 77,
    title: 'Belongs to octocat',
    body: CRITERIA_BODY,
    labels: [READY],
    // Older than cli/cli's, so oldest-first would reach it first and it would
    // consume the work-in-progress cap if it were ever a candidate.
    minutes: -30,
  });
  const { work: cwd, bare } = checkout();

  const result = await work(
    fake,
    ['--repo', 'cli/cli', '--repo', 'octocat/hello-world', '--plugin-dir', REPO_ROOT],
    { cwd, phases: [winningPhase('src/mine.txt')] },
  );

  // The foreign issue is named, refused, and explained.
  assert.match(
    result.stdout,
    /not working octocat\/hello-world#77 belongs to octocat\/hello-world; this checkout is of cli\/cli — run the pass from a checkout of that repository/,
  );

  // Nothing of octocat's was touched, and nothing of octocat's reached this
  // checkout's remote.
  assert.deepEqual(fake.labelsOf('octocat', 'hello-world', 77), [READY]);
  assert.deepEqual(
    fake.requests.filter((r) => r.method !== 'GET' && r.path.includes('hello-world')),
    [],
    'a foreign issue was written to',
  );
  assert.deepEqual(fake.commentsOn('octocat', 'hello-world', 77), []);
  for (const branch of remoteBranches(bare)) {
    assert.ok(
      !/issue-77/.test(branch),
      'a foreign issue’s branch was pushed to this checkout’s remote: ' + branch,
    );
  }

  // And the pass still did its own work: the cap was not spent on the issue it
  // could never have worked.
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', REVIEW]);
  assert.equal(fake.pullsOpened().length, 1);
  assert.equal(fake.pullsOpened()[0].repo, 'cli/cli');

  const rows = summaryRows(result.stdout);
  assert.deepEqual(
    rows.map((row) => [row[0], row[1], row[2]]),
    [['octocat/hello-world', '#77', 'ineligible'], ['cli/cli', '#801', 'review']],
  );
  assert.equal(result.code, 1, 'a standing misconfiguration reported success');
  assert.equal(exitFor(rows), result.code);
});

test('R2: a named issue in another repository is a loud refusal naming both', async () => {
  const fake = await threeIssues();
  fake.seedRepo({ owner: 'octocat', name: 'hello-world', defaultBranch: 'main' });
  fake.seedIssue({
    owner: 'octocat',
    name: 'hello-world',
    number: 77,
    title: 'Belongs to octocat',
    body: CRITERIA_BODY,
    labels: [READY],
  });
  const { work: cwd } = checkout();

  const result = await work(
    fake,
    ['octocat/hello-world#77', '--repo', 'cli/cli', '--repo', 'octocat/hello-world'],
    { cwd },
  );

  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /refusing to work an issue that belongs to another repository/);
  assert.match(result.stderr, /octocat\/hello-world#77 belongs to octocat\/hello-world/);
  assert.match(result.stderr, /this checkout is of cli\/cli/);
  assert.match(result.stderr, /run the pass from a checkout of octocat\/hello-world/);
  assert.deepEqual(fake.requests, [], 'a refused invocation still reached GitHub');
});

test('R1: a checkout with no origin is refused at startup', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();
  git(['remote', 'remove', 'origin'], cwd);

  const result = await work(fake, ['--repo', 'cli/cli'], { cwd });

  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /no remote called "origin" in this repository/);
  assert.deepEqual(fake.requests, [], 'a pass that could not be bound still reached GitHub');
});

test('R1: a checkout whose origin names no repository is refused at startup', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();
  // A remote that is a host and nothing else: there is no owner/name in it.
  git(['remote', 'set-url', 'origin', 'https://github.com/'], cwd);

  const result = await work(fake, ['--repo', 'cli/cli'], { cwd });

  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /refusing to start in a checkout whose repository cannot be told/);
  assert.match(result.stderr, /origin is https:\/\/github\.com\//);
  assert.match(result.stderr, /it names no owner and repository/);
  assert.deepEqual(fake.requests, []);
});

test('R2: an issue URL on another host is refused, naming both hosts', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();

  const result = await work(
    fake,
    ['https://evil.example.com/cli/cli/issues/801', '--repo', 'cli/cli'],
    { cwd },
  );

  // It used to be read as cli/cli#801 — the host was parsed and thrown away.
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /refusing to read an issue URL on another host/);
  assert.match(result.stderr, /the URL is on evil\.example\.com/);
  assert.match(result.stderr, /this run talks to http:\/\/127\.0\.0\.1:\d+/);
  assert.match(result.stderr, /write it as owner\/name#801 if that is the issue you mean/);
  assert.deepEqual(fake.requests, []);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), [READY, 'bug']);
});

test('R2: an issue URL on the host this run talks to is worked', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();
  const host = new URL(fake.origin).host;

  const result = await work(
    fake,
    ['http://' + host + '/cli/cli/issues/801', '--repo', 'cli/cli', '--plugin-dir', REPO_ROOT],
    { cwd, phases: [winningPhase('src/by-url.txt')] },
  );

  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', REVIEW]);
});

/* -------------------------------------------------------------------------- */
/* C6 — a claim write that did not land is a skip, not a verdict               */
/* -------------------------------------------------------------------------- */

/**
 * A claim write refused for a reason that is evidence somebody else acted.
 *
 * This is the case C6 was written about — the label had already moved — so it
 * is the case the silent skip belongs to, and nothing else is.
 */
for (const status of [404, 409, 410, 422]) {
  test('C6: a claim answered ' + status + ' is another runner’s, and is skipped', async () => {
    const fake = await threeIssues();
    const { work: cwd, bare } = checkout();
    fake.reply({
      method: 'POST',
      path: '/repos/cli/cli/issues/801/labels',
      status,
      body: { message: 'no' },
      times: 1,
    });

    const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
      cwd,
      phases: [winningPhase('src/never.txt')],
    });

    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, '', 'a skip was reported on the error channel');
    assert.ok(!/\bblocked\b/.test(result.stdout), 'a skip was reported as blocked:\n' + result.stdout);

    const rows = summaryRows(result.stdout);
    assert.deepEqual(rows.map((row) => [row[1], row[2]]), [['#801', 'skipped']]);
    assert.match(rows[0][4], /it was not claimed:/);
    assert.equal(rows[0][3], lifecycleLabel('ready'), 'the row misreports the label');
    assert.equal(exitFor(rows), result.code, 'the summary row and the exit code disagree');

    assert.deepEqual(writeLog(fake), ['POST /repos/cli/cli/issues/801/labels']);
    assert.deepEqual(fake.labelsOf('cli', 'cli', 801), [READY, 'bug']);
    assert.deepEqual(fake.commentsOn('cli', 'cli', 801), []);
    assert.equal(fake.pullsOpened().length, 0);
    assert.deepEqual(remoteBranches(bare), ['trunk']);
  });
}

/**
 * A token that may not do the thing is the most common way the workflow this
 * feature ships is misconfigured, and it must never be quiet: R11 gives it 2,
 * and the message has to say which permission is missing.
 */
test('R11: a claim GitHub refuses for permission is an authentication error, and says which', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();
  fake.reply({
    method: 'POST',
    path: '/repos/cli/cli/issues/801/labels',
    status: 403,
    body: { message: 'Resource not accessible by integration' },
    times: 1,
  });

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [winningPhase('src/never.txt')],
  });

  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /GitHub refused the token/);
  assert.match(result.stderr, /Resource not accessible by integration/);
  assert.match(result.stderr, /`permissions:` with `issues: write`/);
  assert.match(result.stderr, /`pull-requests: write` and `contents: write`/);
  assert.match(result.stderr, /a personal access token needs the `repo` scope/);
  assert.ok(
    !/\bskipped\b/.test(result.stdout),
    'a token without permission was skipped over:\n' + result.stdout,
  );
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), [READY, 'bug']);
});

/** GitHub's own side failing is nothing in the workflow file, so it is never 2. */
for (const status of [500, 502, 503]) {
  test('R11: a claim GitHub answered ' + status + ' leaves work outstanding, not a 2', async () => {
    const fake = await threeIssues();
    const { work: cwd } = checkout();
    fake.reply({
      method: 'POST',
      path: '/repos/cli/cli/issues/801/labels',
      status,
      body: { message: 'Server Error' },
      times: 1,
    });

    const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
      cwd,
      phases: [winningPhase('src/never.txt')],
    });

    assert.equal(result.code, 1, result.stdout + result.stderr);
    const rows = summaryRows(result.stdout);
    assert.deepEqual(rows.map((row) => [row[1], row[2]]), [['#801', 'retry']]);
    assert.equal(exitFor(rows), result.code, 'the summary row and the exit code disagree');
    assert.deepEqual(fake.labelsOf('cli', 'cli', 801), [READY, 'bug']);
  });
}

test('R11: a rate limit leaves work outstanding, and says when it lifts', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();
  const lifts = Math.floor(Date.UTC(2026, 7, 15, 19, 30, 0) / 1000);
  fake.reply({
    method: 'POST',
    path: '/repos/cli/cli/issues/801/labels',
    status: 403,
    body: { message: 'API rate limit exceeded' },
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(lifts) },
    times: 1,
  });

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [winningPhase('src/never.txt')],
  });

  // A wait GitHub asked for is not an authentication fault, however it is spelled.
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /rate-limited this run/);
  assert.match(result.stdout, /the limit lifts at 2026-08-15T19:30:00Z/);
  assert.deepEqual(
    summaryRows(result.stdout).map((row) => [row[1], row[2]]),
    [['#801', 'retry']],
  );
});

test('R11: a transient fault while listing the queue is reported, and is never a 2', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();
  fake.reply({ method: 'GET', path: '/repos/cli/cli/issues', status: 503, body: { message: 'no' }, times: 1 });

  const result = await work(fake, ['--repo', 'cli/cli'], { cwd });

  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /the pass stopped early/);
  assert.deepEqual(writeLog(fake), [], 'a pass that could not read the queue wrote something');
});

test('R11: a transient fault reading the repository is reported, and is never a 2', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();
  fake.reply({ method: 'GET', path: '/repos/cli/cli', status: 502, body: { message: 'no' }, times: 2 });

  const result = await work(fake, ['--repo', 'cli/cli'], { cwd });

  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /the pass stopped early/);
  assert.deepEqual(writeLog(fake), []);
});

test('C6: a claim that fails on one issue does not stop the pass working the next', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();
  fake.reply({
    method: 'POST',
    path: '/repos/cli/cli/issues/801/labels',
    status: 404,
    body: { message: 'no' },
    times: 1,
  });

  const result = await work(
    fake,
    ['--repo', 'cli/cli', '--max-issues', '3', '--plugin-dir', REPO_ROOT],
    { cwd, phases: [winningPhase('src/second-issue.txt')] },
  );

  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(
    summaryRows(result.stdout).map((row) => [row[1], row[2]]),
    [['#801', 'skipped'], ['#802', 'review'], ['#803', 'triaged']],
  );
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), [READY, 'bug'], 'the skipped issue moved');
  assert.deepEqual(fake.labelsOf('cli', 'cli', 802), [REVIEW]);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 803), [TRIAGE]);
  assert.equal(exitFor(summaryRows(result.stdout)), result.code);
});

test('R11: a win outranks a fault that lands after the pull request is open', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();
  // The sticky edit that follows the pull request, refused. The work is done,
  // the pull request is open, and the bookkeeping about it is what failed.
  fake.reply({
    method: 'PATCH',
    path: /^\/repos\/cli\/cli\/issues\/comments\/\d+$/,
    status: 500,
    body: { message: 'Server Error' },
    times: 4,
  });

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [winningPhase('src/won.txt')],
  });

  assert.equal(result.code, 0, 'a win did not outrank a later fault\n' + result.stdout + result.stderr);
  assert.equal(fake.pullsOpened().length, 1);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', REVIEW]);
  assert.deepEqual(
    summaryRows(result.stdout).map((row) => [row[1], row[2]]),
    [['#801', 'review']],
  );
  assert.equal(exitFor(summaryRows(result.stdout)), result.code);
});

/*
 * The two paths where a human is the only audience.
 *
 * On both of them one endpoint failed and the rest were abandoned with it —
 * leaving a status comment saying critics were still judging and no pull
 * request had been opened, long after the branch was pushed. The writes are
 * independent, so each is attempted, and the last one tells the truth about
 * whatever actually happened.
 */
test('R10: a pull request refused for permission still settles the issue before exiting 2', async () => {
  const fake = await threeIssues();
  const { work: cwd, bare } = checkout();
  fake.reply({
    method: 'POST',
    path: '/repos/cli/cli/pulls',
    status: 403,
    body: { message: 'Resource not accessible by integration' },
    times: 1,
  });

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [winningPhase('src/refused.txt')],
  });

  // The invocation has to change, so the code is R11's 2 — and it is raised
  // after the pass has reported, so the row about the issue still prints.
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /`permissions:` with `issues: write`/);

  // The claim is not left as a live lock nothing else may touch for a day.
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', BLOCKED]);
  assert.deepEqual(labelOps(fake), [
    '#801 +' + WORKING,
    '#801 -' + READY,
    '#801 +' + BLOCKED,
    '#801 -' + WORKING,
  ]);

  // And the sticky read back off the server tells the truth about all of it.
  const sticky = markedComments(fake, 801, 'sticky')[0].body;
  assert.match(sticky, /- \*\*Label\*\* — `exolvra:blocked`/);
  assert.ok(
    !sticky.includes('fresh critics are judging'),
    'the sticky still says critics are judging:\n' + sticky,
  );
  assert.ok(
    !sticky.includes('one is opened only when the win condition is met'),
    'the sticky still says the win condition was not met:\n' + sticky,
  );
  assert.match(sticky, /- \*\*Branch\*\* — \[`exolvra-genesis\/issue-801-/);
  assert.match(sticky, /\*\*What a human has to decide\*\* — the win condition was met/);
  assert.match(sticky, /a permission this token does not have: grant it, or open the pull request/);

  // The work is not lost, and the row says where the issue really is.
  assert.ok(remoteBranches(bare).some((b) => b.startsWith('exolvra-genesis/issue-801-')));
  const rows = summaryRows(result.stdout);
  assert.deepEqual(rows.map((row) => [row[1], row[2], row[3]]), [['#801', 'blocked', BLOCKED]]);
  assert.equal(fake.pullsOpened().length, 0);
});

/*
 * The label move failing after the win, staged where the harness can stage it.
 *
 * The judge's case failed the review `POST`; the harness matches a canned answer
 * on method and path alone, and the claim's own `POST` goes to that same path
 * first, so the second one cannot be singled out. The `DELETE` that finishes the
 * same move can be, and it exercises the whole of what the finding is about: one
 * endpoint of the finishing writes fails, and the independent comment write must
 * not be abandoned with it.
 */
test('R11: a label move that fails after the win still leaves a truthful sticky, and exits 0', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();
  fake.reply({
    method: 'DELETE',
    path: '/repos/cli/cli/issues/801/labels/' + WORKING,
    status: 500,
    body: { message: 'Server Error' },
    times: 1,
  });

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [winningPhase('src/won.txt')],
  });

  // A win outranks the fault that followed it.
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(fake.pullsOpened().length, 1);
  assert.match(result.stdout, /could not be moved to exolvra:review/);

  // The issue is left carrying both, which is a real state a reader can see,
  // and the row reports what the server holds rather than what was intended.
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', WORKING, REVIEW]);
  const rows = summaryRows(result.stdout);
  assert.deepEqual(rows.map((row) => [row[1], row[2]]), [['#801', 'review']]);
  assert.equal(rows[0][3], REVIEW, 'the row does not report the label the server holds');
  assert.equal(exitFor(rows), result.code);

  // The comment is a different endpoint, and it was not abandoned with the
  // label: it names the pull request that really is open, and the phase it
  // really is in.
  const sticky = markedComments(fake, 801, 'sticky')[0].body;
  assert.match(sticky, /- \*\*Pull request\*\* — \[#501\]/);
  assert.ok(
    !sticky.includes('none yet'),
    'the sticky says no pull request while one is open:\n' + sticky,
  );
  assert.ok(
    !sticky.includes('fresh critics are judging'),
    'the sticky still says critics are judging:\n' + sticky,
  );
  assert.match(sticky, /- \*\*Phase\*\* — a pull request is open and waiting on a human/);
  assert.match(result.stdout, /the status comment on cli\/cli#801 was brought up to date/);
});

/*
 * The status comment is the only surface a person reads, and the only one this
 * cannot correct once GitHub keeps refusing it. So it is retried, and when the
 * retry fails too the discrepancy is recorded where it outlives the terminal.
 */
test('R6: a status comment refused once is retried, and ends up truthful', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();
  /*
   * Refused up to and including the edit the label move carries: two round
   * heartbeats and then the finishing write. The attempt after that one — the
   * retry — succeeds, so the public comment ends up telling the truth.
   */
  fake.reply({
    method: 'PATCH',
    path: /^\/repos\/cli\/cli\/issues\/comments\/\d+$/,
    status: 500,
    body: { message: 'Server Error' },
    times: 3,
  });

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [winningPhase('src/retried.txt')],
  });

  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /the status comment on cli\/cli#801 was brought up to date/);

  const sticky = markedComments(fake, 801, 'sticky')[0].body;
  assert.match(sticky, /- \*\*Phase\*\* — a pull request is open and waiting on a human/);
  assert.match(sticky, /- \*\*Label\*\* — `exolvra:review`/);
  assert.match(sticky, /- \*\*Pull request\*\* — \[#501\]/);
  assert.ok(!sticky.includes('none yet'), 'the comment still says no pull request:\n' + sticky);
  assert.ok(
    !sticky.includes('the first round has not started'),
    'the comment still reads as claim-time text:\n' + sticky,
  );

  // Nothing is out of date, so nothing says anything is.
  const rows = summaryRows(result.stdout);
  assert.ok(!/status comment/.test(rows[0][4]), 'a truthful comment was reported as stale');
  const record = ledger(cwd)[0];
  assert.ok(!/status comment/.test(record.input), record.input);
});

test('R6: a status comment GitHub keeps refusing is recorded, not lost with the terminal', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();
  // Every edit refused, including both attempts at the finishing one.
  fake.reply({
    method: 'PATCH',
    path: /^\/repos\/cli\/cli\/issues\/comments\/\d+$/,
    status: 500,
    body: { message: 'Server Error' },
    times: 20,
  });

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [winningPhase('src/stale.txt')],
  });

  // The win still outranks it: the label moved and the pull request is open.
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', REVIEW]);
  assert.equal(fake.pullsOpened().length, 1);

  // The comment really is stale — which is the premise of the rest.
  const sticky = markedComments(fake, 801, 'sticky')[0].body;
  assert.match(sticky, /- \*\*Label\*\* — `exolvra:working`/);
  assert.match(sticky, /none yet/);

  // And the run says so, in the three places that outlive this terminal.
  assert.match(
    result.stdout,
    /cli\/cli#801: the status comment could not be brought up to date, so it still says phase \w+ and label exolvra:working/,
  );
  const rows = summaryRows(result.stdout);
  assert.match(rows[0][4], /the status comment could not be brought up to date/);
  assert.match(ledger(cwd)[0].input, /the status comment could not be brought up to date/);
});

test('R11: the word in a summary row and the pass exit code are one value', async () => {
  // The table itself, so the two renderings of it cannot drift: every ending
  // maps to one of the two codes a pass can carry, and nothing else.
  assert.deepEqual(Object.keys(ISSUE_EXIT).sort(), [
    'blocked',
    'ineligible',
    'retry',
    'review',
    'skipped',
    'triaged',
  ]);
  for (const [result, code] of Object.entries(ISSUE_EXIT)) {
    assert.ok(code === 0 || code === 1, result + ' maps to ' + code);
    assert.equal(passExitCode([{ result }]), code, result + ' does not carry its own code');
  }
  // And one bad ending is enough, whatever else went well.
  assert.equal(passExitCode([{ result: 'review' }, { result: 'blocked' }]), 1);
  assert.equal(passExitCode([{ result: 'review' }, { result: 'skipped' }]), 0);
  assert.equal(passExitCode([]), 0);
});

/* -------------------------------------------------------------------------- */
/* The three-issue pass, end to end                                            */
/* -------------------------------------------------------------------------- */

test('R1/R4/R9/R10/R11: three issues — a win, a block, and a triage', async () => {
  const fake = await threeIssues();
  const { work: cwd, bare } = checkout();

  const result = await work(
    fake,
    ['--repo', 'cli/cli', '--max-issues', '3', '--plugin-dir', REPO_ROOT, '--max-rounds', '4'],
    { cwd, phases: [winningPhase('src/one.txt'), losingPhase('src/two.txt')] },
  );

  /* ---- R11: one issue was blocked, so the pass exits 1 -------------------- */

  assert.equal(result.code, 1, result.stdout + result.stderr);

  /* ---- every remote write, in the order it was really made ---------------- */

  const comment = (n) => '/repos/cli/cli/issues/comments/' + markedComments(fake, n, 'sticky')[0].id;
  assert.deepEqual(writeLog(fake), [
    // #801 — claimed, snapshotted, beaten once a round, then won.
    'POST /repos/cli/cli/issues/801/labels',
    'DELETE /repos/cli/cli/issues/801/labels/' + READY,
    'POST /repos/cli/cli/issues/801/comments',
    'PATCH ' + comment(801),
    'PATCH ' + comment(801),
    'POST /repos/cli/cli/pulls',
    'POST /repos/cli/cli/issues/801/labels',
    'DELETE /repos/cli/cli/issues/801/labels/' + WORKING,
    'PATCH ' + comment(801),
    // #802 — the same shape, one round, and a draft at the end of it.
    'POST /repos/cli/cli/issues/802/labels',
    'DELETE /repos/cli/cli/issues/802/labels/' + READY,
    'POST /repos/cli/cli/issues/802/comments',
    'PATCH ' + comment(802),
    'POST /repos/cli/cli/pulls',
    'POST /repos/cli/cli/issues/802/labels',
    'DELETE /repos/cli/cli/issues/802/labels/' + WORKING,
    'PATCH ' + comment(802),
    // #803 — triaged, and never claimed: no comment edit, no branch, no pull.
    'POST /repos/cli/cli/issues/803/labels',
    'DELETE /repos/cli/cli/issues/803/labels/' + READY,
    'POST /repos/cli/cli/issues/803/comments',
  ]);

  /* ---- R5: every label move, in the order it was really made -------------- */

  assert.deepEqual(labelOps(fake), [
    '#801 +' + WORKING,
    '#801 -' + READY,
    '#801 +' + REVIEW,
    '#801 -' + WORKING,
    '#802 +' + WORKING,
    '#802 -' + READY,
    '#802 +' + BLOCKED,
    '#802 -' + WORKING,
    '#803 +' + TRIAGE,
    '#803 -' + READY,
  ]);

  // And what the issues carry afterwards, read back off the server.
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', REVIEW]);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 802), [BLOCKED]);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 803), [TRIAGE]);

  /* ---- C8: no label outside the lifecycle was ever touched ---------------- */

  for (const operation of labelOps(fake)) {
    assert.match(operation, /[+-]exolvra:/, 'a label outside the namespace was moved: ' + operation);
  }

  /* ---- R6: one sticky comment per issue, edited in place ------------------ */

  assert.equal(markedComments(fake, 801, 'sticky').length, 1, 'the status comment was repeated');
  assert.equal(markedComments(fake, 802, 'sticky').length, 1);
  assert.equal(markedComments(fake, 803, 'sticky').length, 0, 'a triaged issue was claimed');
  assert.equal(markedComments(fake, 803, 'triage').length, 1, 'no triage comment was posted');

  const won = markedComments(fake, 801, 'sticky')[0].body;
  assert.match(won, /### Exolvra Genesis opened \[#\d+\]/);
  assert.match(won, /\*\*Rounds\*\*/);
  assert.match(won, /\| 2 +\| \*\*WIN\*\*/);
  assert.match(won, /phase=review/);

  const blocked = markedComments(fake, 802, 'sticky')[0].body;
  assert.match(blocked, /### Exolvra Genesis stopped on `cli\/cli#802`/);
  assert.match(blocked, /\*\*What a human has to decide\*\* — /, 'the sticky asks nothing of a human');
  assert.match(blocked, /raise the budget and put exolvra:ready back on/);

  const triaged = markedComments(fake, 803, 'triage')[0].body;
  assert.match(triaged, /no checkable bar/);
  assert.match(triaged, /Acceptance criteria/);
  assert.match(triaged, /Nothing was claimed, no branch was made and the issue is unchanged/);

  /* ---- R9/R10: one pull request each, the second a draft ------------------ */

  const pulls = fake.pullsOpened();
  assert.equal(pulls.length, 2, 'expected one pull request per worked issue');
  // Opened, not edited: a first pass over an issue has nothing to refresh, and
  // the write log above pins that there was no PATCH on a pull request at all.
  assert.equal(
    fake.requests.filter((r) => r.method === 'PATCH' && /\/pulls\/\d+$/.test(r.path)).length,
    0,
    'a first pass edited a pull request instead of opening one',
  );
  assert.equal(pulls[0].draft, false, 'a winning pull request was opened as a draft');
  assert.equal(pulls[1].draft, true, 'a blocked run did not open a draft');
  assert.equal(pulls[0].base, 'trunk');
  assert.equal(pulls[1].base, 'trunk');
  assert.match(pulls[0].head, /^exolvra-genesis\/issue-801-/);
  assert.match(pulls[1].head, /^exolvra-genesis\/issue-802-/);
  assert.equal(pulls[0].title, 'Snapshot the issue before the first round (#801)');

  assert.match(pulls[0].body, /^Works \[`cli\/cli#801`\]/);
  assert.match(pulls[0].body, /Won the blind comparison at round 2 of 4/);
  assert.match(pulls[0].body, /<summary>Integrity attestations \(5\)<\/summary>/);
  assert.match(pulls[0].body, /pins 3 artifacts by sha256/);
  assert.match(pulls[0].body, /\.exolvra-genesis\/standards\.md at sha256:/);
  assert.match(pulls[1].body, /^Stopped on \[`cli\/cli#802`\]/);
  // The reason is the loop's own sentence, not a second judgement about it.
  assert.match(pulls[1].body, /the run was stopped: it ran out of agent turns/);
  assert.match(pulls[1].body, /\*\*What a human has to decide\*\*/);

  /* ---- R10/C4: the work is on the remote, on one branch per issue --------- */

  const branches = remoteBranches(bare).filter((branch) => branch !== 'trunk');
  assert.equal(branches.length, 2, 'expected one pushed branch per worked issue');
  assert.ok(branches.every((branch) => branch.startsWith('exolvra-genesis/issue-')));

  /*
   * One issue's work, and only that issue's work, on its own branch.
   *
   * `git checkout -b` cuts from wherever HEAD is standing, so a pass that
   * branched for the second issue after committing the first gave the second
   * branch the first issue's commit — one issue's changes in another issue's
   * pull request. Every branch of a pass is cut before any of them has a commit
   * on it, and this is what that is worth: one commit each, from the same base,
   * and neither carrying the other's file.
   */
  for (const [branch, file, other] of [
    [branches[0], 'src/one.txt', 'src/two.txt'],
    [branches[1], 'src/two.txt', 'src/one.txt'],
  ]) {
    const log = git(['log', '--format=%s', branch], bare).trim().split('\n');
    assert.equal(log.length, 2, branch + ' does not carry exactly its own commit:\n' + log.join('\n'));
    assert.equal(log[1], 'initial', branch + ' was not cut from the base commit');
    const tree = git(['ls-tree', '--name-only', '-r', branch], bare).trim().split('\n');
    assert.ok(tree.includes(file), branch + ' is missing its own work');
    assert.ok(!tree.includes(other), branch + ' carries the other issue’s work');
  }

  /* ---- R3/C11: the snapshot is on disk, pinned, and still verifies -------- */

  const dirs = runDirs(cwd);
  assert.equal(dirs.length, 3, 'expected a run directory per issue, got ' + dirs.join(', '));
  let pages = 0;
  for (const id of dirs) {
    const snapshot = readFileSync(join(cwd, '.exolvra-genesis', 'runs', id, 'issue.md'), 'utf8');
    const pin = readFileSync(join(cwd, '.exolvra-genesis', 'runs', id, 'issue.sha256'), 'utf8');
    assert.equal(pin.trim().split(/\s+/)[0], sha256(snapshot.replace(/\r\n?/g, '\n')));
    assert.match(snapshot, /^<!-- exolvra-genesis:snapshot v=1 repo=cli\/cli issue=\d+ /);
    if (existsSync(join(cwd, '.exolvra-genesis', 'runs', id, 'progress.html'))) pages += 1;
  }

  /* ---- R7: the per-run page is the page the loop kept, byte for byte ------ */

  assert.equal(pages, 2, 'expected a per-run progress page for each issue that ran');
  for (const id of dirs) {
    const page = join(cwd, '.exolvra-genesis', 'runs', id, 'progress.html');
    if (!existsSync(page)) continue;
    assert.equal(readFileSync(page, 'utf8'), PAGE);
  }

  /* ---- R14: the ledger names the issue, the branch and the pull request --- */

  const records = ledger(cwd);
  assert.equal(records.length, 2, 'expected one ledger row per run');
  assert.match(records[0].input, /^cli\/cli#801 · exolvra-genesis\/issue-801-/);
  assert.match(records[0].input, /issue\.md · https:\/\/github\.com\/cli\/cli\/pull\//);
  assert.equal(records[0].status, 'complete');
  assert.equal(records[0].lastVerdict, 'WIN');
  assert.match(records[1].input, /^cli\/cli#802 · exolvra-genesis\/issue-802-/);
  assert.equal(records[1].status, 'stopped');

  /* ---- what a person was shown ------------------------------------------- */

  assert.match(result.stdout, /P1\t1\tLOSS\t\d+s\tthe pin is not re-verified/);
  assert.match(result.stdout, /P1\t2\tWIN/);
  assert.match(result.stdout, /^result\tWIN\t2\t\$0\.4200$/m);
  assert.match(result.stdout, /cli\/cli\s+#801\s+review/);
  assert.match(result.stdout, /cli\/cli\s+#802\s+blocked/);
  assert.match(result.stdout, /cli\/cli\s+#803\s+triaged/);

  /* ---- the loop really ran, on the snapshot, inside its budget ------------ */

  const prompts = result.prompts();
  assert.equal(prompts.length, 2, 'the loop was not driven once per worked issue');
  assert.equal(prompts[0].cwd, cwd);
  assert.equal(prompts[0].maxBudgetUsd, 10);
  assert.deepEqual(prompts[0].agents.sort(), [
    'exolvra-genesis-builder',
    'exolvra-genesis-critic',
  ]);
  assert.ok(
    prompts[0].prompt.includes('.exolvra-genesis/runs/'),
    'the loop was not handed the pinned snapshot as its spec',
  );
  assert.ok(
    prompts[0].prompt.includes('@exolvra-genesis round'),
    'the loop was not asked to report in the shape this CLI reads',
  );

  /*
   * C3/G4: the loop is the markdown on disk, and `work` is one of its callers.
   *
   * The longest sentence of commands/run.md is read off the repository right
   * here and looked for in the prompt the session was really started with. If
   * `work` had grown its own copy of how a run is driven, this would be the
   * thing it could not produce — and it is computed rather than quoted, so it
   * cannot fall out of step with the file it comes from.
   */
  const runMd = splitFrontmatter(
    readFileSync(join(REPO_ROOT, 'commands', 'run.md'), 'utf8'),
  ).body;
  const sentence = runMd
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 60 && !line.includes('${'))
    .sort((a, b) => b.length - a.length)[0];
  assert.ok(sentence !== undefined, 'commands/run.md has no prose to compare against');
  assert.ok(
    prompts[0].prompt.includes(sentence),
    'the lead prompt is not the commands/run.md on disk:\n' + sentence,
  );
});

/*
 * C3: subagents never touch the remote or the GitHub API — as a mechanism.
 *
 * A prompt saying "do not call GitHub" is an instruction, and C3 asks for
 * something a builder cannot be talked out of. The session is handed an
 * environment with no credential in it, so there is nothing to authenticate
 * with whatever a builder decides to do.
 */
test('C3: the loop session is handed no GitHub credential, and still works', async () => {
  const fake = await threeIssues();
  const { work: cwd, bare } = checkout();

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [winningPhase('src/scrubbed.txt')],
    env: {
      // Every name the token-resolution chain reads, set, so their absence
      // downstream is this command's doing and not the harness's.
      GH_TOKEN: 'ghp_' + 'g'.repeat(36),
      GH_ENTERPRISE_TOKEN: 'ghp_' + 'e'.repeat(36),
      GITHUB_ENTERPRISE_TOKEN: 'ghp_' + 'n'.repeat(36),
      ANTHROPIC_API_KEY: 'sk-ant-test',
    },
  });

  assert.equal(result.code, 0, result.stdout + result.stderr);

  const sent = result.prompts();
  assert.equal(sent.length, 1, 'the loop was not driven once');
  const sessionEnv = sent[0].env;
  assert.ok(sessionEnv !== undefined, 'the session was handed no environment at all');

  // Nothing that carries authority over a repository.
  for (const name of Object.keys(sessionEnv)) {
    assert.ok(
      !/^(github_token|gh_token|gh_enterprise_token|github_enterprise_token)$/i.test(name),
      'the loop session was handed ' + name,
    );
  }
  for (const value of Object.values(sessionEnv)) {
    assert.ok(
      typeof value !== 'string' || !value.startsWith('ghp_'),
      'a credential reached the loop session under another name',
    );
  }

  // And everything a builder legitimately needs is still there.
  assert.equal(sessionEnv.ANTHROPIC_API_KEY, 'sk-ant-test', 'the SDK credential was scrubbed too');
  assert.ok(
    Object.keys(sessionEnv).some((name) => /^path$/i.test(name)),
    'PATH was scrubbed, so a builder could not run anything',
  );

  /*
   * The control: the runner's own authority is untouched.
   *
   * Its client resolved the token before the session existed and holds it in a
   * closure, so a pass that reaches a pull request is the proof that scrubbing
   * the session cost the runner nothing.
   */
  assert.equal(fake.pullsOpened().length, 1, 'the runner lost its own credential');
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', REVIEW]);
  assert.ok(remoteBranches(bare).some((b) => b.startsWith('exolvra-genesis/issue-801-')));
});

test('C3: the help page states what the scrub covers, and what it does not', () => {
  const result = spawnSync(process.execPath, [sandbox.bin, 'work', '--help'], {
    encoding: 'utf8',
    env: { ...process.env },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /The loop runs without the GitHub credential/);
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
    assert.ok(result.stdout.includes(name), 'the help page never names ' + name);
  }
  // The residual, stated rather than implied.
  assert.match(result.stdout, /`gh` is logged in/);
  assert.match(result.stdout, /git credential helper/);
  assert.match(result.stdout, /operator's configuration/);
});

/* -------------------------------------------------------------------------- */
/* R2 — one named issue                                                        */
/* -------------------------------------------------------------------------- */

test('R2: work <issue> runs the named issue and never looks at the queue', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();

  const result = await work(
    fake,
    ['cli/cli#802', '--repo', 'cli/cli', '--plugin-dir', REPO_ROOT],
    { cwd, phases: [winningPhase('src/named.txt')] },
  );

  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(labelOps(fake), [
    '#802 +' + WORKING,
    '#802 -' + READY,
    '#802 +' + REVIEW,
    '#802 -' + WORKING,
  ]);
  // The older issue was never touched, because the queue was skipped.
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), [READY, 'bug']);
  assert.equal(
    fake.requests.some((request) => request.path === '/repos/cli/cli/issues' ),
    false,
    'a named run listed the queue anyway',
  );
});

test('C4/R9: a second pass reuses the branch and the pull request already open on it', async () => {
  const fake = await threeIssues();
  const { work: cwd, bare } = checkout();
  const args = ['cli/cli#801', '--repo', 'cli/cli', '--plugin-dir', REPO_ROOT];

  const first = await work(fake, args, { cwd, phases: [losingPhase('src/first.txt')] });
  assert.equal(first.code, 1, first.stdout + first.stderr);
  assert.equal(fake.pullsOpened().length, 1);
  assert.equal(fake.pullsOpened()[0].draft, true);

  // A maintainer answers the draft by taking the blocked label off and putting
  // the authorization label back on — which is the only act that re-authorizes
  // an issue, and the only thing that makes it eligible again.
  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 801,
    title: 'Snapshot the issue before the first round',
    body: CRITERIA_BODY,
    labels: [READY, 'bug'],
    minutes: 0,
  });

  const second = await work(fake, args, { cwd, phases: [winningPhase('src/second.txt')] });
  assert.equal(second.code, 0, second.stdout + second.stderr);

  // One branch, one pull request, and the reuse said out loud rather than left
  // to be discovered.
  assert.equal(fake.pullsOpened().length, 1, 'a second pass opened a second pull request');
  assert.equal(
    remoteBranches(bare).filter((branch) => branch.startsWith('exolvra-genesis/')).length,
    1,
  );
  assert.match(second.stdout, /was already open from exolvra-genesis\/issue-801-/);
  assert.match(second.stdout, /refreshed rather than reopened/);
  assert.equal(markedComments(fake, 801, 'sticky').length, 1, 'the status comment was repeated');
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', REVIEW]);

  /* ---- R9: the body carries this run's evidence, not the last one's ------- */

  // Asserted off the request the server was really sent, and then off the
  // record it kept, so neither the payload nor the stored body is taken on
  // trust from the other.
  const patched = fake.requests.filter(
    (request) => request.method === 'PATCH' && /\/pulls\/\d+$/.test(request.path),
  );
  assert.equal(patched.length, 1, 'the open pull request was not edited exactly once');
  assert.deepEqual(
    Object.keys(patched[0].json).sort(),
    ['body'],
    'the refresh sent something other than the body',
  );

  const body = fake.pullsOpened()[0].body;
  assert.equal(body, patched[0].json.body, 'the stored body is not what was sent');
  assert.match(body, /^Works \[`cli\/cli#801`\]/, 'the body still describes the losing pass');
  assert.match(body, /Won the blind comparison at round 2 of 12/);
  assert.match(body, /Refreshed rather than reopened\. #501 was opened by an earlier pass/);
  assert.match(body, /the title is left as it was/);
  // It won, and the pull request is still the draft the first pass opened, so
  // the body says why rather than leaving a reviewer to wonder.
  assert.equal(fake.pullsOpened()[0].draft, true);
  assert.match(body, /It is still a draft, because that is how the earlier pass opened it/);
  // This run's verdict history and budget, not the first pass's.
  assert.match(body, /<summary>Verdict history \(2 rounds\)<\/summary>/);
  assert.match(body, /\| 2 +\| P1 +\| \*\*WIN\*\*/);
  assert.match(body, /\| Cost +\| \$0\.42 of \$10\.00/);
  assert.ok(
    !body.includes('the snapshot is never re-read'),
    'the refreshed body still carries the first pass’s gap',
  );

  // The title is the one the first pass wrote, untouched.
  assert.equal(fake.pullsOpened()[0].title, 'Snapshot the issue before the first round (#801)');

  // Both runs' work is on the one branch, on top of the commit it was cut from.
  const branch = remoteBranches(bare).find((name) => name.startsWith('exolvra-genesis/'));
  assert.deepEqual(git(['log', '--format=%s', branch], bare).trim().split('\n'), [
    'Snapshot the issue before the first round',
    'Snapshot the issue before the first round',
    'initial',
  ]);
});

/**
 * The last route: a maintainer answers a blocked draft, the second run stacks a
 * commit, and the refreshed body has to attest the *merge* — both commits, both
 * files, the head sha — not just the run that rewrote it.
 */
test('R9: a refreshed body attests the whole merge, not the run that rewrote it', async () => {
  const fake = await threeIssues();
  const { work: cwd, bare } = checkout();
  const args = ['cli/cli#801', '--repo', 'cli/cli', '--plugin-dir', REPO_ROOT];

  const first = await work(fake, args, { cwd, phases: [losingPhase('src/first-pass.txt')] });
  assert.equal(first.code, 1, first.stdout + first.stderr);
  assert.equal(fake.pullsOpened().length, 1);
  assert.equal(fake.pullsOpened()[0].draft, true);
  assert.match(fake.pullsOpened()[0].body, /- `src\/first-pass\.txt` — added/);

  // The maintainer answers the draft.
  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 801,
    title: 'Snapshot the issue before the first round',
    body: CRITERIA_BODY,
    labels: [READY, 'bug'],
    minutes: 0,
  });

  const second = await work(fake, args, { cwd, phases: [winningPhase('src/second-pass.txt')] });
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.equal(fake.pullsOpened().length, 1, 'a second pull request was opened');

  const pull = fake.pullsOpened()[0];
  const body = pull.body;
  const branch = pull.head;

  /* ---- the body against what the merge actually proposes ----------------- */

  const files = git(['diff', '--name-only', 'trunk...' + branch], bare)
    .trim()
    .split('\n')
    .filter((line) => line !== '');
  assert.deepEqual(
    files.sort(),
    ['src/first-pass.txt', 'src/second-pass.txt'],
    'the staged scenario did not stack a second commit',
  );
  for (const file of files) {
    assert.ok(body.includes('`' + file + '`'), 'the body never names ' + file + '\n' + body);
  }
  assert.match(body, /<summary>Files changed \(2 files\)<\/summary>/);

  const head = git(['rev-parse', branch], bare).trim();
  assert.ok(body.includes('`' + head + '`'), 'the body attests a commit that is not the head');
  assert.equal(git(['rev-list', '--count', 'trunk..' + branch], bare).trim(), '2');

  // The rounds and the cost are this run's, and say so, so the two scopes on
  // one page cannot be read as one.
  assert.match(body, /\| Rounds +\| 2 of 12 rounds, this run/);
  assert.match(body, /Refreshed rather than reopened/);
});

test('R9: a body that could not be refreshed is said out loud and does not block the issue', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();
  const args = ['cli/cli#801', '--repo', 'cli/cli', '--plugin-dir', REPO_ROOT];

  const first = await work(fake, args, { cwd, phases: [losingPhase('src/first.txt')] });
  assert.equal(first.code, 1, first.stdout + first.stderr);
  const opened = fake.pullsOpened()[0].body;

  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 801,
    title: 'Snapshot the issue before the first round',
    body: CRITERIA_BODY,
    labels: [READY, 'bug'],
    minutes: 0,
  });
  fake.reply({
    method: 'PATCH',
    path: /^\/repos\/cli\/cli\/pulls\/\d+$/,
    status: 500,
    body: { message: 'Server Error' },
    times: 1,
  });

  const second = await work(fake, args, { cwd, phases: [winningPhase('src/second.txt')] });

  // The run still reached a pull request, so it is still a win: a body one pass
  // out of date is not a thing to make a human unblock an issue over.
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', REVIEW]);
  assert.equal(fake.pullsOpened().length, 1);
  assert.equal(fake.pullsOpened()[0].body, opened, 'the body changed after GitHub refused the edit');
  assert.match(second.stdout, /its body could not be refreshed, so it still describes the pass before this one/);
  assert.match(second.stdout, /What this run did is in the status comment on the issue/);
  // And the status comment really does carry this run, which is what that line
  // sends the reader to.
  assert.match(markedComments(fake, 801, 'sticky')[0].body, /phase=review/);
});

test('R10: a loop that changed nothing blocks the issue rather than opening a pull request', async () => {
  const fake = await threeIssues();
  const { work: cwd, bare } = checkout();

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [
      {
        progress: PAGE,
        messages: [OPENING, round('P1', 1, 'BLOCKED', 'the API this needs does not exist yet')],
        state: 'blocked',
        result: { subtype: 'error_during_execution', errors: ['it cannot be built as asked'] },
      },
    ],
  });

  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', BLOCKED]);
  assert.equal(fake.pullsOpened().length, 0, 'a run that changed nothing opened a pull request');
  assert.deepEqual(remoteBranches(bare), ['trunk'], 'a branch with no work on it was pushed');
  assert.match(result.stdout, /the loop changed no files, so there is nothing to open a pull request from/);
  const sticky = markedComments(fake, 801, 'sticky')[0].body;
  assert.match(sticky, /\*\*What a human has to decide\*\* — the loop changed no files/);
});

test('R10: GitHub answering 5xx hands the claim back rather than parking it on a human', async () => {
  const fake = await threeIssues();
  const { work: cwd, bare } = checkout();
  // The listing that finds an existing pull request, refused the way a busy
  // GitHub refuses it. Nothing about the work is wrong, and nothing about it
  // needs a person.
  fake.reply({
    method: 'GET',
    path: '/repos/cli/cli/pulls',
    status: 503,
    body: { message: 'Server Error' },
    times: 1,
  });

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [winningPhase('src/unreachable.txt')],
  });

  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.equal(fake.pullsOpened().length, 0);
  // The work is not lost: it is committed and on the remote.
  assert.ok(
    remoteBranches(bare).some((branch) => branch.startsWith('exolvra-genesis/issue-801-')),
    'the branch was not pushed before GitHub was asked for a pull request',
  );
  // And the issue is where the next pass will find it, not where a human has to.
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', READY]);
  assert.match(result.stdout, /GitHub could not be reached to open the pull request/);
  assert.match(result.stdout, /the next pass opens that one without running the loop again/);
  // The row says the work is outstanding, not that a human must settle it: the
  // issue carries exolvra:ready, and `blocked` would be a word about a label it
  // does not have.
  const row = summaryRows(result.stdout)[0];
  assert.deepEqual([row[1], row[2]], ['#801', 'retry']);
  assert.equal(exitFor(summaryRows(result.stdout)), result.code);

  // The promise is kept on disk, not merely printed: the finished pull request
  // is beside the run that produced it.
  const kept = runDirs(cwd)
    .map((id) => join(cwd, '.exolvra-genesis', 'runs', id, 'pull-request.json'))
    .filter((path) => existsSync(path));
  assert.equal(kept.length, 1, 'no pull request was kept for the next pass');
  const pending = JSON.parse(readFileSync(kept[0], 'utf8'));
  assert.equal(pending.issue, 801);
  assert.match(pending.branch, /^exolvra-genesis\/issue-801-/);
  assert.equal(pending.outcome, 'win');
  assert.match(pending.body, /^Works \[`cli\/cli#801`\]/);
  assert.match(pending.commit, /^[0-9a-f]{40}$/);
});

/**
 * F1: the pull request a pass could not open is opened by the next one, from
 * the evidence that pass wrote — not by running the loop again.
 *
 * The scenario the critic staged, and the property that was wrong: the body a
 * reviewer reads has to describe what the merge actually proposes.
 */
test('R9: a kept pull request is opened as written, and its body matches the diff', async () => {
  const fake = await threeIssues();
  const { work: cwd, bare } = checkout();
  const args = ['cli/cli#801', '--repo', 'cli/cli', '--plugin-dir', REPO_ROOT];

  fake.reply({
    method: 'GET',
    path: '/repos/cli/cli/pulls',
    status: 500,
    body: { message: 'Server Error' },
    times: 1,
  });
  const first = await work(fake, args, { cwd, phases: [winningPhase('src/only-one.txt')] });
  assert.equal(first.code, 1, first.stdout + first.stderr);
  assert.equal(fake.pullsOpened().length, 0);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', READY]);

  // A healthy pass, with a phase that would write a *second* file if the loop
  // ran again. It must not run.
  const second = await work(fake, args, { cwd, phases: [winningPhase('src/would-be-second.txt')] });

  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /opening the pull request run r-.* wrote for cli\/cli#801/);
  assert.match(second.stdout, /the loop is not run again/);
  assert.ok(
    !/^P1\t/m.test(second.stdout),
    'the loop was run again for a pull request that was already written:\n' + second.stdout,
  );

  const pulls = fake.pullsOpened();
  assert.equal(pulls.length, 1, 'expected exactly one pull request');
  const body = pulls[0].body;
  const branch = pulls[0].head;

  /* ---- body against what the merge actually proposes --------------------- */

  const files = git(['diff', '--name-only', 'trunk..' + branch], bare)
    .trim()
    .split('\n')
    .filter((line) => line !== '');
  assert.deepEqual(files, ['src/only-one.txt'], 'the branch carries something the body cannot know');
  for (const file of files) {
    assert.ok(body.includes('`' + file + '`'), 'the body never names ' + file + '\n' + body);
  }
  assert.match(body, /<summary>Files changed \(1 file\)<\/summary>/);
  assert.ok(
    !body.includes('would-be-second'),
    'the second pass ran the loop and changed what the merge proposes',
  );

  const head = git(['rev-parse', branch], bare).trim();
  assert.ok(body.includes('`' + head + '`'), 'the body attests a commit that is not the head');
  assert.equal(
    git(['rev-list', '--count', 'trunk..' + branch], bare).trim(),
    '1',
    'a second commit was stacked under a body that describes one',
  );

  // And the record is spent, so a third pass does not open it again.
  assert.deepEqual(
    runDirs(cwd)
      .map((id) => join(cwd, '.exolvra-genesis', 'runs', id, 'pull-request.json'))
      .filter((path) => existsSync(path)),
    [],
    'the kept pull request was not forgotten once it was opened',
  );
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', REVIEW]);
});

test('R10: a pull request GitHub refuses outright is a person’s to settle', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();
  fake.reply({
    method: 'POST',
    path: '/repos/cli/cli/pulls',
    status: 422,
    body: {
      message: 'Validation Failed',
      errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }],
    },
    times: 1,
  });

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [winningPhase('src/refused.txt')],
  });

  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.equal(fake.pullsOpened().length, 0);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', BLOCKED]);
  const sticky = markedComments(fake, 801, 'sticky')[0].body;
  assert.match(
    sticky,
    /\*\*What a human has to decide\*\* — the win condition was met and the branch exolvra-genesis\/issue-801-/,
  );
  assert.match(sticky, /Open one by hand, or settle what it refused/);
  // The sticky no longer says critics are judging, or that no pull request was
  // opened because the condition was not met.
  assert.match(sticky, /- \*\*Label\*\* — `exolvra:blocked`/);
  assert.match(sticky, /which one can still be opened from/);
  assert.ok(!sticky.includes('fresh critics are judging'), 'the sticky still says critics are judging');
});

/* -------------------------------------------------------------------------- */
/* C10 — the work-in-progress cap                                              */
/* -------------------------------------------------------------------------- */

test('C10: the cap is one issue by default, and the rest are left for a later pass', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [winningPhase('src/capped.txt')],
  });

  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', REVIEW]);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 802), [READY], 'the cap was exceeded');
  assert.deepEqual(fake.labelsOf('cli', 'cli', 803), [READY]);
});

/* -------------------------------------------------------------------------- */
/* R15 — an interrupt releases the claim                                       */
/* -------------------------------------------------------------------------- */

test('R15: an interrupt before anything was committed puts the label back to ready', async () => {
  const fake = await threeIssues();
  const { work: cwd, bare } = checkout();

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [
      {
        progress: PAGE,
        messages: [OPENING],
        interruptAfter: 1,
        hold: true,
      },
    ],
  });

  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.deepEqual(labelOps(fake), [
    '#801 +' + WORKING,
    '#801 -' + READY,
    '#801 +' + READY,
    '#801 -' + WORKING,
  ]);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', READY]);
  assert.equal(fake.pullsOpened().length, 0, 'an interrupted run opened a pull request');
  assert.deepEqual(
    remoteBranches(bare),
    ['trunk'],
    'an interrupted run with nothing committed pushed a branch',
  );

  /*
   * F4: the status comment names the branch and does not link it.
   *
   * Nothing was committed, so nothing was pushed, so there is no page on GitHub
   * to open — and a link to one is a 404 a maintainer will click. The Pull
   * request bullet beside it has always been careful; this makes Branch match.
   */
  const sticky = markedComments(fake, 801, 'sticky')[0].body;
  const branchLine = sticky.split(NL).find((line) => line.startsWith('- **Branch**'));
  assert.ok(branchLine !== undefined, 'the sticky has no Branch line: ' + sticky);
  assert.match(branchLine, /- \*\*Branch\*\* — `exolvra-genesis\/issue-801-/);
  assert.ok(
    !branchLine.includes(']('),
    'the sticky links a branch that was never pushed: ' + branchLine,
  );
  assert.ok(!branchLine.includes('/tree/'), branchLine);

  // The exact way back in, printed rather than left to be worked out.
  assert.match(result.stdout, /resume it with: exolvra-genesis resume r-/);
  assert.match(result.stdout, /pick it up again with: exolvra-genesis work cli\/cli#801/);

  // And the ledger is truthful about it.
  const records = ledger(cwd);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'stopped');
  assert.equal(
    JSON.parse(readFileSync(join(cwd, '.exolvra-genesis', 'state.json'), 'utf8')).status,
    'stopped',
  );
});

test('R15: an interrupt with work on the branch pushes it and blocks the issue', async () => {
  const fake = await threeIssues();
  const { work: cwd, bare } = checkout();

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [
      {
        writes: [{ path: 'src/partial.txt', text: 'as far as it got\n' }],
        progress: PAGE,
        messages: [OPENING, round('P1', 1, 'LOSS', 'not yet')],
        interruptAfter: 2,
        hold: true,
      },
    ],
  });

  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', BLOCKED]);
  assert.ok(
    remoteBranches(bare).some((branch) => branch.startsWith('exolvra-genesis/issue-801-')),
    'an interrupt with work on the branch discarded it',
  );
  const sticky = markedComments(fake, 801, 'sticky')[0].body;
  assert.match(sticky, /\*\*What a human has to decide\*\* — the run was interrupted with work on/);
  assert.match(result.stdout, /pick it up again with: exolvra-genesis work cli\/cli#801/);
  // This one *was* pushed, so here the link is the truth and is drawn.
  const branchLine = sticky.split(NL).find((line) => line.startsWith('- **Branch**'));
  assert.match(branchLine, /\]\(https:\/\/github\.com\/cli\/cli\/tree\/exolvra-genesis\/issue-801-/);
});

/* -------------------------------------------------------------------------- */
/* C11 — the pin is re-verified every round                                    */
/* -------------------------------------------------------------------------- */

test('C11: a snapshot edited under the run stops the loop and blocks the issue', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [
      {
        writes: [{ path: 'src/tampered.txt', text: 'work done against a moved spec\n' }],
        progress: PAGE,
        barPins: 3,
        tamper: true,
        messages: [OPENING, round('P1', 1, 'WIN')],
        hold: true,
      },
    ],
  });

  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /the pinned issue snapshot no longer verifies/);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', BLOCKED]);
  const pulls = fake.pullsOpened();
  assert.equal(pulls.length, 1);
  assert.equal(pulls[0].draft, true, 'a run judged against a moved spec opened a real pull request');
  assert.match(pulls[0].body, /no longer verifies/);
  assert.match(pulls[0].body, /Integrity attestations \(5, 1 failed\)/);
});

/*
 * The same tamper, and the stream shape that used to slip past it.
 *
 * A held stream is stopped by the interrupt the check raises, so the run ends
 * blocked by that route. A stream that *completes cleanly* is not stopped by
 * anything — the loop declares a win, `run` exits 0 — and the check's finding
 * used to reach nothing but a line in the terminal and a folded block in the
 * pull request body: non-draft, `exolvra:review`, exit 0. The tool said the run
 * was unjudgeable and shipped it as judged.
 *
 * A broken pin is a gate. Both shapes end the same way, whatever the loop said.
 */
test('C11: a snapshot edited under a run that wins cleanly still blocks the issue', async () => {
  const fake = await threeIssues();
  const { work: cwd, bare } = checkout();

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [
      {
        writes: [{ path: 'src/tampered.txt', text: 'work done against a moved spec\n' }],
        progress: PAGE,
        barPins: 3,
        tamper: true,
        // No hold: the loop runs to the end, declares its win, and the session
        // finishes of its own accord.
        messages: [OPENING, round('P1', 1, 'LOSS', 'not yet'), round('P1', 2, 'WIN')],
        state: 'complete',
        result: { text: 'P1 won twice in a row.', costUsd: 0.42 },
      },
    ],
  });

  // The loop won. The run did not.
  assert.match(result.stdout, /^result\tWIN\t2/m, 'the loop did not report a clean win');
  assert.equal(result.code, 1, 'a run judged against a moved spec exited 0\n' + result.stdout);

  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', BLOCKED]);
  const rows = summaryRows(result.stdout);
  assert.deepEqual(rows.map((row) => [row[1], row[2], row[3]]), [['#801', 'blocked', BLOCKED]]);
  assert.ok(!/\bwon\b/.test(rows[0][4]), 'the summary row still reads as a win: ' + rows[0][4]);
  assert.equal(exitFor(rows), result.code);

  // R10: the work is not discarded, and the pull request says what it is.
  const pulls = fake.pullsOpened();
  assert.equal(pulls.length, 1);
  assert.equal(pulls[0].draft, true, 'a run judged against a moved spec opened a real pull request');
  assert.match(pulls[0].body, /^Stopped on \[`cli\/cli#801`\]/);
  assert.match(pulls[0].body, /no longer verifies/);
  assert.match(pulls[0].body, /Integrity attestations \(5, 1 failed\)/);
  assert.ok(remoteBranches(bare).some((b) => b.startsWith('exolvra-genesis/issue-801-')));

  // And the status comment — the surface a person actually reads — says it in
  // its own phase and decision lines, not only inside a folded block.
  const sticky = markedComments(fake, 801, 'sticky')[0].body;
  assert.match(sticky, /- \*\*Label\*\* — `exolvra:blocked`/);
  assert.match(sticky, /- \*\*Phase\*\* — stopped on something only a human can settle/);
  assert.match(sticky, /\*\*What a human has to decide\*\* — the pinned issue snapshot no longer verifies/);
});

test('C11: a snapshot edited after the last round is still caught', async () => {
  const fake = await threeIssues();
  const { work: cwd } = checkout();

  const result = await work(fake, ['--repo', 'cli/cli', '--plugin-dir', REPO_ROOT], {
    cwd,
    phases: [
      {
        writes: [{ path: 'src/late.txt', text: 'work done against a moved spec\n' }],
        progress: PAGE,
        barPins: 3,
        messages: [OPENING, round('P1', 1, 'WIN')],
        // The edit lands after the last round has been judged, in the moments
        // the per-round check can no longer see.
        tamperAfterMessages: true,
        state: 'complete',
        result: { text: 'P1 won.', costUsd: 0.42 },
      },
    ],
  });

  assert.equal(result.code, 1, 'a tamper in the final moments slipped through\n' + result.stdout);
  assert.match(result.stdout, /the pinned issue snapshot no longer verifies/);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 801), ['bug', BLOCKED]);
  assert.equal(fake.pullsOpened()[0].draft, true);
});

/* -------------------------------------------------------------------------- */
/* C7 — a stale claim is recovered                                             */
/* -------------------------------------------------------------------------- */

test('C7: a claim whose heartbeat stopped is put back before the pass works anything', async () => {
  const fake = await fakeHost();
  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 810,
    title: 'A claim somebody walked away from',
    body: CRITERIA_BODY,
    labels: [WORKING],
    minutes: 0,
    comments: [
      {
        author: RUNNER_LOGIN,
        body:
          '<!-- exolvra-genesis:sticky v=1 run=r-old repo=cli/cli issue=810 phase=building ' +
          'label=exolvra:working heartbeat=2020-01-01T00:00:00Z claimed=2020-01-01T00:00:00Z ' +
          'snapshot=none -->\n### Exolvra Genesis is working `cli/cli#810`',
      },
    ],
  });
  const { work: cwd } = checkout();

  const result = await work(
    fake,
    ['--repo', 'cli/cli', '--claim-ttl', '1h', '--plugin-dir', REPO_ROOT],
    { cwd, phases: [winningPhase('src/recovered.txt')] },
  );

  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /recovered cli\/cli#810 to exolvra:ready/);

  /*
   * F7: selection sees what this same pass's recovery just did.
   *
   * The pass used to say "recovered … to exolvra:ready" and then, in the next
   * line, "no open issue carrying exolvra:ready" — false at the moment it
   * printed, and the issue idled until the next cron for no reason.
   */
  assert.ok(
    !result.stdout.includes('no open issue carrying'),
    'the pass denied the recovery it had just made:\n' + result.stdout,
  );
  assert.deepEqual(labelOps(fake), [
    '#810 +' + READY,
    '#810 -' + WORKING,
    // Reclaiming is still not claiming: the issue goes back to ready and is
    // then raced for through the ordinary claim path, like any other.
    '#810 +' + WORKING,
    '#810 -' + READY,
    '#810 +' + REVIEW,
    '#810 -' + WORKING,
  ]);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 810), [REVIEW]);
  assert.equal(fake.pullsOpened().length, 1, 'the recovered issue was not worked');
  assert.deepEqual(
    summaryRows(result.stdout).map((row) => [row[1], row[2]]),
    [['#810', 'review']],
  );
});

test('C7: a recovered issue still respects the work-in-progress cap', async () => {
  const fake = await fakeHost();
  for (const [number, minutes] of [[820, 0], [821, 10]]) {
    fake.seedIssue({
      owner: 'cli',
      name: 'cli',
      number,
      title: 'A claim somebody walked away from',
      body: CRITERIA_BODY,
      labels: [WORKING],
      minutes,
      comments: [
        {
          author: RUNNER_LOGIN,
          body:
            '<!-- exolvra-genesis:sticky v=1 run=r-old repo=cli/cli issue=' +
            number +
            ' phase=building label=exolvra:working heartbeat=2020-01-01T00:00:00Z ' +
            'claimed=2020-01-01T00:00:00Z snapshot=none -->\n### working',
        },
      ],
    });
  }
  const { work: cwd } = checkout();

  const result = await work(
    fake,
    ['--repo', 'cli/cli', '--claim-ttl', '1h', '--plugin-dir', REPO_ROOT],
    { cwd, phases: [winningPhase('src/one-of-two.txt')] },
  );

  assert.equal(result.code, 0, result.stdout + result.stderr);
  // Both recovered — recovery is repair and does not consume the cap — and only
  // the older one worked, because working is what the cap counts.
  assert.deepEqual(fake.labelsOf('cli', 'cli', 820), [REVIEW]);
  assert.deepEqual(fake.labelsOf('cli', 'cli', 821), [READY]);
  assert.equal(fake.pullsOpened().length, 1);
});

/* -------------------------------------------------------------------------- */
/* A named issue that cannot be worked                                         */
/* -------------------------------------------------------------------------- */

test('R2/R11: work <issue> on an issue that cannot be worked says so in the exit code', async () => {
  const fake = await fakeHost();
  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 830,
    title: 'Nobody has marked this ready',
    body: CRITERIA_BODY,
    labels: ['bug'],
  });
  const { work: cwd } = checkout();

  const result = await work(fake, ['cli/cli#830', '--repo', 'cli/cli'], { cwd });

  // A pass that finds nothing has done its job; somebody who typed this issue
  // asked for one thing and did not get it.
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /cli\/cli#830 cannot be worked: it does not carry exolvra:ready/);
  const rows = summaryRows(result.stdout);
  assert.deepEqual(rows.map((row) => [row[1], row[2]]), [['#830', 'ineligible']]);
  assert.equal(exitFor(rows), result.code);
  assert.deepEqual(writeLog(fake), [], 'an ineligible issue was written to');
  assert.deepEqual(fake.labelsOf('cli', 'cli', 830), ['bug']);
});

test('R1: a pass that simply finds nothing still exits 0', async () => {
  const fake = await fakeHost();
  fake.seedIssue({ owner: 'cli', name: 'cli', number: 840, title: 'Not for this tool', labels: ['bug'] });
  const { work: cwd } = checkout();

  const result = await work(fake, ['--repo', 'cli/cli'], { cwd });

  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /no open issue carrying exolvra:ready in cli\/cli/);
});

/* -------------------------------------------------------------------------- */
/* The command surface                                                         */
/* -------------------------------------------------------------------------- */

test('the help page names every flag, both environment variables, and the safety rules', () => {
  const result = spawnSync(process.execPath, [sandbox.bin, 'work', '--help'], {
    encoding: 'utf8',
    env: { ...process.env },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  for (const flag of workCommand.flags) {
    assert.ok(
      result.stdout.includes('--' + flag.long),
      'the help page never names --' + flag.long,
    );
  }
  for (const heading of ['USAGE', 'FLAGS', 'INHERITED FLAGS', 'LABELS', 'SAFETY', 'THE LOOP', 'EXAMPLES', 'LEARN MORE']) {
    assert.ok(result.stdout.includes('\n' + heading + '\n'), 'the help page has no ' + heading);
  }
  assert.match(result.stdout, /EXOLVRA_GENESIS_REPOS/);
  assert.match(result.stdout, /EXOLVRA_GENESIS_RUNNER_LOGIN/);
  assert.match(result.stdout, /exit(s)? 0 when every issue it worked reached a pull request/);
  assert.match(result.stdout, /never force-pushes|force-pushes/);
});
