import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  LIFECYCLE,
  LIFECYCLE_LABELS,
  lifecycleLabel,
  lifecycleOf,
  repeatedFlagValues,
  repoValue,
  reposValue,
  resolveAllowlist,
} from '../dist/allowlist.js';
import { exitForFault, queueCommand } from '../dist/commands/queue.js';
import { UsageError } from '../dist/exit.js';
import { DATA_BEGIN, DATA_END, renderFleetPage } from '../dist/fleet.js';
import { GitHubError, REDACTED } from '../dist/github.js';
import { startGitHubFake } from './github-fake.js';
import { BIN, REPO_ROOT, runProcess } from './run-cli.js';

/*
 * `exolvra-genesis queue`, driven as a real process against a real server.
 *
 * Every listing below came out of the built binary, started as a child process,
 * talking over a socket to the local GitHub the harness runs. The two stand-ins
 * this run permits are the Claude Agent SDK and that server; nothing else here
 * is substituted. No module is patched, no `fetch` is replaced, and every exit
 * code asserted on came off a process rather than off a constant.
 *
 * The child is started asynchronously rather than through the suite's usual
 * synchronous runner, and that is a requirement rather than a preference: the
 * fake GitHub listens on this process's event loop, so a synchronous wait here
 * would stop it answering the very requests the child is making. What is being
 * driven is identical either way — the same built binary, the same argv, the
 * same environment, the same exit code off the same process.
 */

const READY = lifecycleLabel('ready');
const WORKING = lifecycleLabel('working');
const BLOCKED = lifecycleLabel('blocked');
const REVIEW = lifecycleLabel('review');
const TRIAGE = lifecycleLabel('triage');

const ESC = String.fromCharCode(0x1b);
const PDF = String.fromCharCode(0x202c);
const RLM = String.fromCharCode(0x200f);
const RLO = String.fromCharCode(0x202e);

/**
 * A title carrying everything a title should not be able to do: an escape
 * sequence that repaints a terminal, a newline that would split one record into
 * two, a right-to-left override that turns the rest of a row around, and a
 * closing script tag that would end an HTML page's data block early.
 */
const HOSTILE =
  'Hostile ' + ESC + '[31mtitle' + ESC + '[0m with </script> and\na newline' + RLO;

/**
 * True when text carries something a terminal would act on rather than draw.
 *
 * A tab separates fields and a newline separates records, so those two are what
 * the output is made of; everything else below 0x20, and the C1 range above it,
 * is a sequence nobody asked to have obeyed.
 */
function hasControl(text) {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    // 9 is a tab and 10 is a newline: the two the output is made of.
    if (cp === 9 || cp === 10 || cp === 13) continue;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
  }
  return false;
}

const TEMP = [];
const SERVERS = [];

after(async () => {
  for (const fake of SERVERS) await fake.close();
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

/** A server with two repositories on it, and issues across the lifecycle. */
async function seeded() {
  const fake = await startGitHubFake();
  SERVERS.push(fake);

  fake.seedRepo({ owner: 'cli', name: 'cli', defaultBranch: 'trunk' });
  fake.seedRepo({ owner: 'octocat', name: 'hello-world' });

  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 101,
    title: 'The oldest ready issue',
    labels: [READY, 'bug'],
    minutes: 0,
  });
  fake.seedIssue({
    owner: 'octocat',
    name: 'hello-world',
    number: 7,
    title: 'A ready issue in the other repository',
    labels: [READY],
    minutes: 5,
  });
  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 102,
    title: 'Claimed, and being worked',
    labels: [WORKING],
    minutes: 10,
  });
  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 103,
    title: 'Nothing to do with this tool',
    labels: ['bug'],
    minutes: 20,
  });
  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 104,
    title: 'A pull request wearing the ready label',
    labels: [READY],
    minutes: 30,
    isPullRequest: true,
  });
  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 105,
    title: 'Waiting on a person',
    labels: [BLOCKED],
    minutes: 40,
  });
  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 106,
    title: HOSTILE,
    labels: [READY],
    minutes: 50,
  });
  return fake;
}

/**
 * Two GitHub token shapes, built from parts so this file carries no run of
 * characters a secret scanner has to think about.
 *
 * Neither is a credential. Both are exactly what one looks like, which is all
 * redaction can go on: the pattern is the only thing that tells a token from
 * noise, because a token belonging to somebody else is indistinguishable from
 * noise in every other respect.
 */
const CLASSIC_TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const FINE_TOKEN = 'github_pat_' + '11ABCDE0Y0abcdefghijklmn' + '_' + 'oPqRsTuVwXyZ0123456789';

/** An issue whose title carries both, plainly. */
const PLAIN_LEAK = 'Auth fails with ' + CLASSIC_TOKEN + ' and ' + FINE_TOKEN + ' - please look';

/**
 * An issue whose title carries both with a character in the middle that is not
 * drawn: an escape sequence through one, a right-to-left override through the
 * other. Neither is a token any pattern matches until those are taken out,
 * which is what every surface here does before it draws the title.
 */
const SPLICED_CLASSIC = ['ghp_' + 'S1PL1CED0000', '99999999'];
const SPLICED_FINE = ['github_pat_' + '11ZZZZZ0Z0zzz', 'yYyYyYyYyY'];

const SPLICED_LEAK =
  'Spliced ' +
  SPLICED_CLASSIC[0] +
  ESC +
  '[0m' +
  SPLICED_CLASSIC[1] +
  ' and ' +
  SPLICED_FINE[0] +
  RLO +
  SPLICED_FINE[1] +
  ' in the log';

/**
 * The same two once the character in the middle is gone.
 *
 * Each half is deliberately too short to be a token on its own — twelve
 * characters after `ghp_`, thirteen after `github_pat_` — so a surface that
 * matched only what it was sent would find nothing to redact, and a surface that
 * cleans the text first finds a whole token. That is the difference this pins.
 */
const SPLICED_JOINED = [SPLICED_CLASSIC.join(''), SPLICED_FINE.join('')];

/** A server whose issues carry credentials somebody pasted into them. */
async function leaky() {
  const fake = await startGitHubFake();
  SERVERS.push(fake);
  fake.seedRepo({ owner: 'leaky', name: 'repo' });
  fake.seedIssue({
    owner: 'leaky',
    name: 'repo',
    number: 107,
    title: PLAIN_LEAK,
    labels: [READY],
    minutes: 0,
  });
  fake.seedIssue({
    owner: 'leaky',
    name: 'repo',
    number: 108,
    title: SPLICED_LEAK,
    labels: [WORKING],
    minutes: 10,
  });
  return fake;
}

/** A server with one repository and nothing this tool may touch on it. */
async function quiet() {
  const fake = await startGitHubFake();
  SERVERS.push(fake);
  fake.seedRepo({ owner: 'quiet', name: 'repo' });
  return fake;
}

/**
 * Runs the built binary, with nothing about GitHub inherited from this shell.
 *
 * The environment is built exactly as the suite's synchronous runner builds it:
 * this process's environment, then the overrides, with an override of undefined
 * removing the variable rather than setting it to the word.
 */
function queue(fake, args, { cwd = temp('queue-'), env = {} } = {}) {
  const overrides = {
    GITHUB_API_URL: fake.origin,
    GITHUB_TOKEN: fake.token,
    EXOLVRA_GENESIS_REPOS: undefined,
    EXOLVRA_GENESIS_PLUGIN_DIR: undefined,
    EXOLVRA_GENESIS_FORCE_TTY: undefined,
    ...env,
  };
  const childEnv = { ...process.env, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete childEnv[key];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'queue', ...args], {
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
      if (signal !== null) reject(new Error('the CLI process was killed by ' + signal));
      else resolve({ code, stdout, stderr });
    });
  });
}

/** The tab-delimited rows of a piped listing. */
function rows(stdout) {
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split('\t'));
}

/** `repo` and `issue` joined, which is how one row is named in an assertion. */
function refs(stdout) {
  return rows(stdout).map((row) => row[0] + row[1]);
}

/* -------------------------------------------------------------------------- */
/* The allowlist is the authorization boundary (C5)                            */
/* -------------------------------------------------------------------------- */

test('C5: an empty allowlist exits 2 and never reaches GitHub', async () => {
  const fake = await seeded();
  fake.clearRequests();

  const { code, stdout, stderr } = await queue(fake, []);

  assert.equal(code, 2, 'an empty allowlist must exit 2, got ' + code + '\n' + stderr);
  assert.equal(stdout, '', 'nothing may be listed without an allowlist');
  assert.equal(
    fake.requests.length,
    0,
    'the refusal was made after asking GitHub something: ' + JSON.stringify(fake.requests),
  );

  const lines = stderr.split('\n');
  assert.equal(lines[0], 'no repository is allowlisted for this run');
  assert.match(lines[1], /^ {2}\S/, 'the detail is not indented under it: ' + stderr);
  assert.ok(
    stderr.includes('never every repository the token can see'),
    'the refusal does not say what an empty allowlist is not:\n' + stderr,
  );
  assert.ok(stderr.includes('--repo owner/name'), stderr);
  assert.ok(stderr.includes('EXOLVRA_GENESIS_REPOS'), stderr);
  assert.ok(
    stderr.includes('Usage:  exolvra-genesis queue [flags]'),
    'the usage line it violated is missing:\n' + stderr,
  );
});

test('C5: a repository that is not one exits 2, naming the flag as typed', async () => {
  const fake = await seeded();
  for (const [flag, value] of [
    ['--repo', 'not-a-repository'],
    ['-R', 'not/a/repository/path'],
    ['--repo', 'owner/'],
  ]) {
    const { code, stdout, stderr } = await queue(fake, [flag, value]);
    assert.equal(code, 2, flag + ' ' + value + ' must exit 2, got ' + code);
    assert.equal(stdout, '');
    assert.ok(stderr.includes('invalid value "' + value + '" for ' + flag), stderr);
    assert.ok(stderr.includes('owner/name'), 'the shape is never stated:\n' + stderr);
  }
});

test('C5: only the allowlisted repository is asked about', async () => {
  const fake = await seeded();
  fake.clearRequests();

  const { code, stderr } = await queue(fake, ['--repo', 'octocat/hello-world']);
  assert.equal(code, 0, stderr);

  const asked = new Set(
    fake.requests.map((request) => request.path.split('/').slice(0, 4).join('/')),
  );
  assert.deepEqual(
    [...asked],
    ['/repos/octocat/hello-world'],
    'a repository outside the allowlist was asked about: ' + [...asked].join(', '),
  );
});

/* -------------------------------------------------------------------------- */
/* The listing (R12)                                                           */
/* -------------------------------------------------------------------------- */

test('R12: a piped listing is tab-delimited records, oldest first', async () => {
  const fake = await seeded();
  const { code, stdout, stderr } = await queue(fake, [
    '--repo',
    'cli/cli',
    '--repo',
    'octocat/hello-world',
  ]);

  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');

  const listed = rows(stdout);
  assert.deepEqual(
    refs(stdout),
    ['cli/cli#101', 'octocat/hello-world#7', 'cli/cli#102', 'cli/cli#106'],
    'the pickup order is not oldest first:\n' + stdout,
  );

  for (const row of listed) {
    assert.equal(row.length, 5, 'a record is not five fields: ' + JSON.stringify(row));
  }
  assert.ok(!stdout.includes('REPO'), 'a pipe was given a header row:\n' + stdout);

  // repo, issue, title, state, age — R12's fields, in R12's order.
  assert.deepEqual(listed[0], [
    'cli/cli',
    '#101',
    'The oldest ready issue',
    'ready',
    '2026-07-01T12:00:00Z',
  ]);
  assert.equal(listed[2]?.[3], 'working');
});

test('R12: an issue outside the lifecycle, and a pull request, are not the queue', async () => {
  const fake = await seeded();
  const { stdout } = await queue(fake, ['--repo', 'cli/cli', '--all']);

  assert.ok(!stdout.includes('#103'), 'an unlabelled issue was listed:\n' + stdout);
  assert.ok(!stdout.includes('#104'), 'a pull request was listed as an issue:\n' + stdout);
  assert.ok(stdout.includes('#105'), '--all did not reach the blocked issue:\n' + stdout);
});

test('R12: --all lists every state, and the default lists two', async () => {
  const fake = await seeded();
  const narrow = rows((await queue(fake, ['--repo', 'cli/cli'])).stdout).map((row) => row[3]);
  const wide = rows((await queue(fake, ['--repo', 'cli/cli', '--all'])).stdout).map(
    (row) => row[3],
  );

  assert.deepEqual([...new Set(narrow)].sort(), ['ready', 'working']);
  assert.ok(wide.includes('blocked'), 'blocked is missing from --all: ' + wide.join(', '));
  assert.ok(wide.length > narrow.length, 'that --all widened the listing is the claim');
});

test('R12: a terminal gets aligned columns, a header, and an age', async () => {
  const fake = await seeded();
  const { code, stdout, stderr } = await queue(fake, ['--repo', 'cli/cli'], {
    env: { EXOLVRA_GENESIS_FORCE_TTY: '100' },
  });

  assert.equal(code, 0, stderr);
  const lines = stdout.split('\n').filter((line) => line !== '');
  assert.match(lines[0], /^REPO\s+ISSUE\s+TITLE\s+STATE\s+AGE$/, lines[0]);
  assert.ok(!stdout.includes('\t'), 'a terminal was given tab-delimited rows:\n' + stdout);

  const issueColumn = lines[0].indexOf('ISSUE');
  for (const line of lines.slice(1)) {
    assert.equal(line.indexOf('#'), issueColumn, 'the issue column is ragged:\n' + stdout);
  }
  // An age, not a timestamp: the bar's own listing puts a timestamp down a pipe
  // and something a person reads on a terminal.
  assert.match(lines[1], /\s(just now|\d+(s|m|h|d|mo|y) ago)$/, lines[1]);
  for (const line of lines) {
    assert.ok(line.length <= 100, 'a row ran past the width it was laid out for: ' + line);
  }
});

test('R12: --limit caps the listing', async () => {
  const fake = await seeded();
  const { code, stdout, stderr } = await queue(fake, ['--repo', 'cli/cli', '--limit', '1']);
  assert.equal(code, 0, stderr);
  assert.deepEqual(refs(stdout), ['cli/cli#101'], 'the one kept is not the oldest:\n' + stdout);
});

test('R12: a hostile title cannot repaint the terminal or invent a column', async () => {
  const fake = await seeded();
  const { stdout } = await queue(fake, ['--repo', 'cli/cli']);

  const row = rows(stdout).find((fields) => fields[1] === '#106');
  assert.ok(row !== undefined, 'the hostile issue was not listed:\n' + stdout);
  assert.equal(row.length, 5, 'the newline invented a column: ' + JSON.stringify(row));
  assert.ok(!hasControl(stdout), 'an escape sequence reached the terminal');
  assert.ok(!stdout.includes(RLO), 'a right-to-left override reached the terminal');
  assert.ok(row[2].includes('a newline'), 'the title lost its content: ' + row[2]);
});

/* -------------------------------------------------------------------------- */
/* Machine output                                                              */
/* -------------------------------------------------------------------------- */

test('R12: --json writes every documented field on every record, always', async () => {
  const fake = await seeded();
  const { code, stdout, stderr } = await queue(fake, [
    '--repo',
    'cli/cli',
    '--repo',
    'octocat/hello-world',
    '--json',
  ]);

  assert.equal(code, 0, stderr);
  const records = JSON.parse(stdout);
  assert.equal(records.length, 4);

  for (const record of records) {
    assert.deepEqual(
      Object.keys(record).sort(),
      ['createdAt', 'issue', 'labels', 'repo', 'state', 'title', 'updatedAt', 'url'],
      'the shape of a record depends on what is in it: ' + JSON.stringify(record),
    );
  }

  const first = records[0];
  assert.equal(first.repo, 'cli/cli');
  assert.equal(first.issue, 101);
  assert.equal(first.state, 'ready');
  assert.deepEqual(first.labels, [READY, 'bug']);
  assert.equal(first.createdAt, '2026-07-01T12:00:00Z');
  assert.equal(first.url, 'https://github.com/cli/cli/issues/101');

  // The listing is a display and neutralises what it draws; this is data, and
  // data that has been tidied no longer matches the issue it came from.
  const hostile = records.find((record) => record.issue === 106);
  assert.equal(hostile.title, HOSTILE, 'the record no longer matches the issue');

  // Piped, it is one line, so it stays something a pipe can read.
  assert.equal(stdout.trimEnd().split('\n').length, 1);
});

test('R12: --json on a terminal is the same records, indented', async () => {
  const fake = await seeded();
  const piped = await queue(fake, ['--repo', 'cli/cli', '--json']);
  const drawn = await queue(fake, ['--repo', 'cli/cli', '--json'], {
    env: { EXOLVRA_GENESIS_FORCE_TTY: '100' },
  });

  assert.deepEqual(JSON.parse(drawn.stdout), JSON.parse(piped.stdout));
  assert.ok(drawn.stdout.split('\n').length > 5, 'a terminal was given one long line');
});

/* -------------------------------------------------------------------------- */
/* Nothing to list                                                             */
/* -------------------------------------------------------------------------- */

test('R12: an allowlist with no eligible issue prints nothing and still exits 0', async () => {
  const fake = await quiet();
  fake.seedIssue({
    owner: 'quiet',
    name: 'repo',
    number: 1,
    title: 'Untouched',
    labels: ['bug'],
  });

  const { code, stdout, stderr } = await queue(fake, ['--repo', 'quiet/repo']);

  assert.equal(code, 0, 'listing nothing is a complete answer, so it wins: ' + stderr);
  assert.equal(stdout, '', 'an empty listing must not be a header row over nothing');
  assert.equal(
    stderr,
    'no open issue carrying ' + READY + ' or ' + WORKING + ' in quiet/repo\n',
    stderr,
  );
});

test('R12: the empty note names the whole namespace under --all', async () => {
  const fake = await quiet();
  const { code, stderr } = await queue(fake, ['--repo', 'quiet/repo', '--all']);
  assert.equal(code, 0, stderr);
  assert.equal(stderr, 'no open issue carrying an exolvra: label in quiet/repo\n');
});

/* -------------------------------------------------------------------------- */
/* How the allowlist is written                                                */
/* -------------------------------------------------------------------------- */

test('R1: --repo is repeatable, in every spelling the parser accepts', async () => {
  const fake = await seeded();
  const expected = ['cli/cli#101', 'octocat/hello-world#7', 'cli/cli#102', 'cli/cli#106'];

  for (const args of [
    ['--repo', 'cli/cli', '--repo', 'octocat/hello-world'],
    ['-R', 'cli/cli', '-R', 'octocat/hello-world'],
    ['--repo=cli/cli', '--repo=octocat/hello-world'],
    ['-R=cli/cli', '--repo', 'octocat/hello-world'],
    // Written twice, and once more: the same repository is still one.
    ['--repo', 'cli/cli', '--repo', 'CLI/CLI', '--repo', 'octocat/hello-world'],
  ]) {
    const { code, stdout, stderr } = await queue(fake, args);
    assert.equal(code, 0, args.join(' ') + ' exited ' + code + '\n' + stderr);
    assert.deepEqual(refs(stdout), expected, args.join(' ') + ' listed something else:\n' + stdout);
  }
});

test('R1: EXOLVRA_GENESIS_REPOS names the allowlist, and --repo overrides it', async () => {
  const fake = await seeded();

  for (const value of [
    'cli/cli,octocat/hello-world',
    'cli/cli octocat/hello-world',
    'cli/cli, octocat/hello-world',
  ]) {
    const { code, stdout, stderr } = await queue(fake, [], {
      env: { EXOLVRA_GENESIS_REPOS: value },
    });
    assert.equal(code, 0, JSON.stringify(value) + ' exited ' + code + '\n' + stderr);
    assert.equal(rows(stdout).length, 4, JSON.stringify(value) + ':\n' + stdout);
  }

  // The flag wins outright rather than merging: "just this one" means that.
  const narrowed = await queue(fake, ['--repo', 'octocat/hello-world'], {
    env: { EXOLVRA_GENESIS_REPOS: 'cli/cli' },
  });
  assert.equal(narrowed.code, 0, narrowed.stderr);
  assert.deepEqual(
    rows(narrowed.stdout).map((row) => row[0]),
    ['octocat/hello-world'],
    'the environment widened a run past what was asked for:\n' + narrowed.stdout,
  );

  // And a variable that is not repositories is refused before anything is read.
  const bad = await queue(fake, [], { env: { EXOLVRA_GENESIS_REPOS: 'not-a-repository' } });
  assert.equal(bad.code, 2, bad.stderr);
  assert.equal(bad.stdout, '');
  assert.ok(bad.stderr.includes('EXOLVRA_GENESIS_REPOS'), bad.stderr);
  assert.ok(
    !/\nUsage: {2}/.test(bad.stderr),
    'a variable fault was answered with a usage line:\n' + bad.stderr,
  );
});

/* -------------------------------------------------------------------------- */
/* The token (C2, C12)                                                         */
/* -------------------------------------------------------------------------- */

test('C2: no token anywhere is a configuration error, and exits 2', async () => {
  const fake = await seeded();
  const nowhere = temp('no-gh-');

  const { code, stdout, stderr } = await queue(fake, ['--repo', 'cli/cli'], {
    env: { GITHUB_TOKEN: undefined, PATH: nowhere, Path: nowhere },
  });

  assert.equal(code, 2, 'no token must exit 2, got ' + code + '\n' + stderr);
  assert.equal(stdout, '');
  assert.equal(stderr.split('\n')[0], 'no GitHub token is available');
  assert.ok(stderr.includes('GITHUB_TOKEN'), stderr);
  assert.ok(stderr.includes('gh auth login'), stderr);
});

test('C12: a rejected token is reported without ever being printed', async () => {
  const fake = await seeded();
  const wrong = 'ghp_' + 'Wr0ngT0kenValue' + '0'.repeat(20);
  fake.clearRequests();

  const { code, stdout, stderr } = await queue(fake, ['--repo', 'cli/cli'], {
    env: { GITHUB_TOKEN: wrong },
  });

  assert.equal(code, 2, 'a rejected token must exit 2, got ' + code + '\n' + stderr);
  assert.equal(stdout, '');
  assert.ok(stderr.includes('GitHub rejected the token'), stderr);
  assert.ok(!stderr.includes(wrong), 'the token was printed back:\n' + stderr);

  // And it really was sent, so the assertion above is about redaction rather
  // than about a request that never carried it.
  const sent = fake.requests.filter(
    (request) => request.headers.authorization === 'Bearer ' + wrong,
  );
  assert.ok(sent.length > 0, 'no request carried the token, so nothing was redacted');
});

/* -------------------------------------------------------------------------- */
/* Whose fault it was (R11)                                                    */
/* -------------------------------------------------------------------------- */

/** Seconds since the epoch, a minute from now, as a rate-limit reset header. */
function resetSoon() {
  return String(Math.floor(Date.now() / 1000) + 60);
}

/** The listing path for a repository, which is where a canned answer lands. */
const ISSUES = /\/issues$/;

test('R11: a fault on GitHub\'s side of the call exits 1, not 2', async () => {
  for (const [what, canned] of [
    ['a 503', { status: 503, body: { message: 'Server Error' } }],
    [
      'a rate limit',
      {
        status: 403,
        body: { message: 'API rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': resetSoon() },
      },
    ],
    ['an answer that is not JSON', { status: 200, body: 'not json at all' }],
  ]) {
    const fake = await seeded();
    fake.reply({ method: 'GET', path: ISSUES, times: 20, ...canned });

    const { code, stdout, stderr } = await queue(fake, ['--repo', 'cli/cli']);

    assert.equal(code, 1, what + ' must exit 1, got ' + code + '\n' + stderr);
    assert.equal(stdout, '', what + ' printed a listing anyway:\n' + stdout);
    // The house shape, not a stack and not a bug report: a complaint, then the
    // detail indented under it.
    const lines = stderr.split('\n');
    assert.match(lines[0], /^could not |^GitHub rate-limited /, what + ':\n' + stderr);
    assert.match(lines[1], /^ {2}\S/, what + ' has no indented detail:\n' + stderr);
    assert.ok(
      !stderr.includes('unexpected error'),
      what + ' was reported as a bug in this CLI:\n' + stderr,
    );
    assert.ok(!/\nUsage: {2}/.test(stderr), what + ' told the reader to retype it:\n' + stderr);
  }
});

test('R11: a fault the invocation has to fix still exits 2', async () => {
  // The other half of the rule. Each of these is settled by changing the
  // command line or the token, so each keeps the code that says so.
  for (const [what, args, canned] of [
    [
      'a token GitHub refused',
      ['--repo', 'cli/cli'],
      { status: 403, body: { message: 'Resource not accessible' } },
    ],
    [
      'a repository this token cannot see',
      ['--repo', 'cli/cli'],
      { status: 404, body: { message: 'Not Found' } },
    ],
    ['a repository that is not one', ['--repo', 'not-a-repository'], undefined],
  ]) {
    const fake = await seeded();
    if (canned !== undefined) {
      fake.reply({ method: 'GET', path: ISSUES, times: 20, ...canned });
    }

    const { code, stdout, stderr } = await queue(fake, args);
    assert.equal(code, 2, what + ' must exit 2, got ' + code + '\n' + stderr);
    assert.equal(stdout, '', what + ' printed a listing anyway');
  }

  // And an empty allowlist, which never reaches GitHub at all.
  const fake = await seeded();
  assert.equal((await queue(fake, [])).code, 2, 'an empty allowlist must still exit 2');
});

test('R11: a listing is all of the allowlist or none of it', async () => {
  const fake = await seeded();
  // The first repository answers; the second does not. Both are asked for, and
  // the one that answered must not be printed as though it were the whole
  // listing — a pipe cannot tell a short listing from a complete one.
  fake.reply({
    method: 'GET',
    path: /^\/repos\/octocat\/hello-world\/issues$/,
    status: 503,
    body: { message: 'Server Error' },
    times: 20,
  });

  const { code, stdout, stderr } = await queue(fake, [
    '--repo',
    'cli/cli',
    '--repo',
    'octocat/hello-world',
  ]);

  assert.equal(code, 1, 'a half-answered pass must exit 1, got ' + code + '\n' + stderr);
  assert.equal(stdout, '', 'the repositories that answered were printed as a listing:\n' + stdout);
  assert.ok(stderr.includes('octocat/hello-world'), 'the fault does not name the repository');

  // The control: without the canned fault, the same invocation does list.
  const healthy = await queue(await seeded(), [
    '--repo',
    'cli/cli',
    '--repo',
    'octocat/hello-world',
  ]);
  assert.equal(healthy.code, 0, healthy.stderr);
  assert.equal(rows(healthy.stdout).length, 4, healthy.stdout);
});

test('R11: --json and --fleet are all-or-nothing on a fault too', async () => {
  const cwd = temp('fault-fleet-');
  const fake = await seeded();
  fake.reply({
    method: 'GET',
    path: ISSUES,
    status: 503,
    body: { message: 'Server Error' },
    times: 20,
  });

  const json = await queue(fake, ['--repo', 'cli/cli', '--json'], { cwd });
  assert.equal(json.code, 1, json.stderr);
  assert.equal(json.stdout, '', '--json printed an empty array as though it were an answer');

  const other = await seeded();
  other.reply({
    method: 'GET',
    path: ISSUES,
    status: 503,
    body: { message: 'Server Error' },
    times: 20,
  });
  const fleet = await queue(other, ['--repo', 'cli/cli', '--fleet'], { cwd });
  assert.equal(fleet.code, 1, fleet.stderr);
  assert.equal(fleet.stdout, '');
  assert.equal(
    existsSync(join(cwd, '.exolvra-genesis', 'fleet.html')),
    false,
    'a fleet page was written from a pass that never finished reading',
  );
});

test('R11: queue agrees with the exit-code contract in process', () => {
  // The classifier itself, over every kind the network module can raise, so a
  // kind added later has to be placed deliberately rather than defaulting into
  // whichever answer the tests happened to cover.
  const fault = (kind, status) =>
    new GitHubError({ message: 'no', kind, operation: 'list issues', status });

  assert.equal(exitForFault(fault('rate-limit')), 1);
  assert.equal(exitForFault(fault('unreachable')), 1);
  assert.equal(exitForFault(fault('malformed')), 1);
  assert.equal(exitForFault(fault('http', 500)), 1);
  assert.equal(exitForFault(fault('http', 503)), 1);

  assert.equal(exitForFault(fault('auth', 401)), 2);
  assert.equal(exitForFault(fault('auth', 403)), 2);
  assert.equal(exitForFault(fault('not-found', 404)), 2);
  assert.equal(exitForFault(fault('refused')), 2);
  assert.equal(exitForFault(fault('http', 422)), 2);
});

/* -------------------------------------------------------------------------- */
/* The fleet page (R8)                                                         */
/* -------------------------------------------------------------------------- */

const TEMPLATE = readFileSync(join(REPO_ROOT, 'templates', 'fleet.html'), 'utf8');

/** The page split at its markers, with line endings normalised. */
function parts(html) {
  const text = html.replace(/\r\n?/g, '\n');
  const begin = text.indexOf(DATA_BEGIN);
  const end = text.indexOf(DATA_END);
  assert.ok(begin !== -1 && end > begin, 'the page has no data block:\n' + text.slice(0, 400));
  return {
    head: text.slice(0, begin),
    block: text.slice(begin + DATA_BEGIN.length, end),
    tail: text.slice(end),
  };
}

/** Just the JSON out of the data block. */
function blockJson(html) {
  const block = parts(html).block;
  const open = block.indexOf('>');
  const close = block.lastIndexOf('</script>');
  assert.ok(open !== -1 && close > open, 'the data block is not a script element:\n' + block);
  return block.slice(open + 1, close);
}

/** The data the page carries. */
function pageData(html) {
  return JSON.parse(blockJson(html));
}

/** A run ledger holding one record. */
function ledgerWith(cwd, record) {
  mkdirSync(join(cwd, '.exolvra-genesis'), { recursive: true });
  writeFileSync(
    join(cwd, '.exolvra-genesis', 'runs.json'),
    JSON.stringify([record], null, 2) + '\n',
    'utf8',
  );
}

test('R8: --fleet writes the page, and edits nothing but the data block', async () => {
  const fake = await seeded();
  fake.seedPull({
    owner: 'cli',
    name: 'cli',
    number: 900,
    head: 'exolvra-genesis/issue-102-claimed-and-being-worked',
    base: 'trunk',
  });
  const cwd = temp('fleet-');
  ledgerWith(cwd, {
    id: 'r-20260814-1200-abc123',
    sessionId: 'sesn_1',
    input: 'cli/cli#102',
    models: { lead: 'claude-opus-5', builder: 'opus', critic: 'opus' },
    startedAt: '2026-08-14T12:00:00.000Z',
    status: 'running',
    rounds: 3,
    lastVerdict: 'LOSS - the table is ragged',
    costUsd: 1.25,
  });

  const { code, stdout, stderr } = await queue(fake, ['--repo', 'cli/cli', '--fleet'], { cwd });
  assert.equal(code, 0, stderr);
  assert.ok(stdout.length > 0, 'the listing itself is still printed');
  assert.match(
    stderr,
    /^fleet page written to .*fleet\.html\n$/,
    'the page was written without saying where:\n' + stderr,
  );

  const page = readFileSync(join(cwd, '.exolvra-genesis', 'fleet.html'), 'utf8');
  const written = parts(page);
  const shipped = parts(TEMPLATE);
  assert.equal(written.head, shipped.head, 'the fill edited the markup above the block');
  assert.equal(written.tail, shipped.tail, 'the fill edited the renderer below the block');

  const data = pageData(page);
  assert.deepEqual(data.repos, ['cli/cli']);
  assert.match(data.generated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  // Every state, whatever the listing was narrowed to: a dashboard that hid the
  // blocked runs would be worse than no dashboard.
  assert.deepEqual(
    data.runs.map((run) => run.issue).sort((a, b) => a - b),
    [101, 102, 105, 106],
  );

  const claimed = data.runs.find((run) => run.issue === 102);
  assert.equal(claimed.status, 'working');
  assert.equal(claimed.round, 3, 'the ledger record was not joined to the issue');
  assert.equal(claimed.verdict, 'LOSS - the table is ragged');
  assert.equal(claimed.costUsd, 1.25);
  assert.equal(claimed.pr, 'https://github.com/cli/cli/pull/900');
  assert.equal(claimed.url, 'https://github.com/cli/cli/issues/102');

  const untouched = data.runs.find((run) => run.issue === 101);
  assert.equal(untouched.round, null, 'a run that has not started reports null, not zero');
  assert.equal(untouched.verdict, null);
  assert.equal(untouched.costUsd, null);
  assert.equal(untouched.pr, null);
});

test('R8: a run for another issue is not read as this one', async () => {
  const fake = await seeded();
  const cwd = temp('fleet-ref-');
  // The reference of a different issue whose number starts with this one's.
  ledgerWith(cwd, {
    id: 'r-20260814-1300-def456',
    sessionId: null,
    input: 'https://github.com/cli/cli/issues/1021',
    models: { lead: 'claude-opus-5', builder: 'opus', critic: 'opus' },
    startedAt: '2026-08-14T13:00:00.000Z',
    status: 'complete',
    rounds: 9,
  });

  const { code, stderr } = await queue(fake, ['--repo', 'cli/cli', '--fleet'], { cwd });
  assert.equal(code, 0, stderr);

  const data = pageData(readFileSync(join(cwd, '.exolvra-genesis', 'fleet.html'), 'utf8'));
  assert.equal(data.runs.find((run) => run.issue === 102).round, null, 'issue 1021 was read as 102');
});

test('R8: a hostile title cannot break out of the data block', async () => {
  const fake = await seeded();
  const cwd = temp('fleet-hostile-');

  const { code, stderr } = await queue(fake, ['--repo', 'cli/cli', '--fleet'], { cwd });
  assert.equal(code, 0, stderr);

  const page = readFileSync(join(cwd, '.exolvra-genesis', 'fleet.html'), 'utf8');
  const inner = blockJson(page);

  assert.ok(!inner.includes('</'), 'a value can close the element it sits in:\n' + inner);
  assert.ok(!hasControl(inner), 'a control character reached the page');
  assert.ok(!inner.includes(RLO), 'a right-to-left override reached the page');

  const hostile = pageData(page).runs.find((run) => run.issue === 106);
  assert.ok(hostile.title.includes('a newline'), 'the title lost its content: ' + hostile.title);
  assert.ok(!hostile.title.includes('\n'), 'the title is still two lines');
  assert.ok(hostile.title.includes('</script>'), 'the title lost what it really said');
});

test('R8: a fleet of no runs renders the empty state, not an empty table', async () => {
  const fake = await quiet();
  const cwd = temp('fleet-empty-');

  const { code, stdout, stderr } = await queue(fake, ['--repo', 'quiet/repo', '--fleet'], { cwd });
  assert.equal(code, 0, stderr);
  assert.equal(stdout, '', 'nothing was eligible, so nothing is listed');

  const page = readFileSync(join(cwd, '.exolvra-genesis', 'fleet.html'), 'utf8');
  const data = pageData(page);
  assert.deepEqual(data.runs, []);
  assert.deepEqual(data.repos, ['quiet/repo']);

  // The empty state is drawn from the same page every other fleet is drawn
  // from: what changed is the data, and nothing else.
  const written = parts(page);
  const shipped = parts(TEMPLATE);
  assert.equal(written.head, shipped.head);
  assert.equal(written.tail, shipped.tail);
  assert.ok(
    written.tail.includes('Nothing claimed or queued yet'),
    'the page carries no empty state',
  );
});

test('R8: the fill refuses a template whose data block is not there exactly once', () => {
  const data = { generated: '2026-08-14T00:00:00Z', repos: [], runs: [] };

  assert.throws(() => renderFleetPage('<html></html>', data), /carries no/);
  assert.throws(() => renderFleetPage(DATA_BEGIN + DATA_END + DATA_END, data), /more than one/);
  assert.throws(() => renderFleetPage(DATA_END + DATA_BEGIN, data), /before the opening one/);

  const filled = renderFleetPage(TEMPLATE, data);
  assert.notEqual(filled, TEMPLATE, 'nothing was filled in');
  assert.equal(parts(filled).head, parts(TEMPLATE).head);
  assert.equal(parts(filled).tail, parts(TEMPLATE).tail);
});

/* -------------------------------------------------------------------------- */
/* Credentials in issue text (C12)                                             */
/* -------------------------------------------------------------------------- */

test('C12: a credential pasted into an issue is not republished by any surface', async () => {
  const fake = await leaky();
  const cwd = temp('leak-');

  /** Which of the credentials `text` carries. Empty is the only passing answer. */
  const carries = (text) =>
    [CLASSIC_TOKEN, FINE_TOKEN, ...SPLICED_JOINED].filter((secret) =>
      text.includes(secret),
    );

  // The control: the issues really do carry them, so what follows is about
  // redaction rather than about titles that never had a credential in them.
  assert.deepEqual(carries(PLAIN_LEAK), [CLASSIC_TOKEN, FINE_TOKEN]);
  assert.deepEqual(carries(SPLICED_LEAK.replace(ESC + '[0m', '').replace(RLO, '')), [
    ...SPLICED_JOINED,
  ]);

  const piped = await queue(fake, ['--repo', 'leaky/repo'], { cwd });
  assert.equal(piped.code, 0, piped.stderr);
  assert.equal(rows(piped.stdout).length, 2, piped.stdout);
  assert.deepEqual(carries(piped.stdout), [], 'a credential reached the piped listing');
  assert.ok(
    piped.stdout.includes(REDACTED),
    'nothing was redacted, so the listing passed by losing the text instead:\n' +
      piped.stdout,
  );

  // Wide enough that nothing is truncated: a token that vanished because the
  // column ran out would be a pass this test has not earned.
  const drawn = await queue(fake, ['--repo', 'leaky/repo'], {
    cwd,
    env: { EXOLVRA_GENESIS_FORCE_TTY: '200' },
  });
  assert.equal(drawn.code, 0, drawn.stderr);
  assert.deepEqual(carries(drawn.stdout), [], 'a credential reached the terminal listing');
  assert.ok(drawn.stdout.includes('please look'), 'the title was cut, not redacted');

  const json = await queue(fake, ['--repo', 'leaky/repo', '--json'], { cwd });
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(carries(json.stdout), [], 'a credential reached --json');

  const records = JSON.parse(json.stdout);
  const plain = records.find((record) => record.issue === 107);
  // Byte for byte the issue's own title, with the two credentials replaced and
  // nothing else touched: --json is data, and redaction is the one exception.
  assert.equal(
    plain.title,
    'Auth fails with ' + REDACTED + ' and ' + REDACTED + ' - please look',
  );
  const spliced = records.find((record) => record.issue === 108);
  assert.ok(
    spliced.title.includes(REDACTED),
    'a credential only a cleaned-up view reveals stayed in --json: ' + spliced.title,
  );
  assert.ok(spliced.title.includes('in the log'), 'the record lost the rest of the title');

  const fleet = await queue(fake, ['--repo', 'leaky/repo', '--fleet'], { cwd });
  assert.equal(fleet.code, 0, fleet.stderr);
  const page = readFileSync(join(cwd, '.exolvra-genesis', 'fleet.html'), 'utf8');
  assert.deepEqual(carries(page), [], 'a credential reached the fleet page');

  const data = pageData(page);
  for (const number of [107, 108]) {
    const run = data.runs.find((entry) => entry.issue === number);
    assert.ok(
      run.title.includes(REDACTED),
      'issue ' + number + ' reached the page without being redacted: ' + run.title,
    );
  }
  assert.ok(
    data.runs.find((run) => run.issue === 107).title.startsWith('Auth fails with'),
    'the page lost the part of the title worth reading',
  );
});

test('C12: a credential in a run record is not republished by the fleet page', async () => {
  const fake = await leaky();
  const cwd = temp('leak-ledger-');
  // A verdict quoting a log line, the way one does — and the log line carrying
  // a token, the way they do.
  ledgerWith(cwd, {
    id: 'r-20260814-1500-aa11bb',
    sessionId: null,
    input: 'leaky/repo#107',
    models: { lead: 'claude-opus-5', builder: 'opus', critic: 'opus' },
    startedAt: '2026-08-14T15:00:00.000Z',
    status: 'blocked',
    rounds: 2,
    lastVerdict: 'LOSS - the fixture still hardcodes ' + CLASSIC_TOKEN,
    costUsd: 0.5,
  });

  const { code, stderr } = await queue(fake, ['--repo', 'leaky/repo', '--fleet'], { cwd });
  assert.equal(code, 0, stderr);

  const page = readFileSync(join(cwd, '.exolvra-genesis', 'fleet.html'), 'utf8');
  assert.ok(!page.includes(CLASSIC_TOKEN), 'a credential reached the page through a verdict');

  const run = pageData(page).runs.find((entry) => entry.issue === 107);
  assert.equal(run.verdict, 'LOSS - the fixture still hardcodes ' + REDACTED);
});

/**
 * One template's `vclass`, flattened so indentation is not the thing compared.
 */
function vclassOf(html, where) {
  const at = html.indexOf('function vclass(s) {');
  assert.ok(at !== -1, where + ' defines no vclass');
  const end = html.indexOf('\n  }', at);
  assert.ok(end !== -1, where + ' does not close vclass where it was expected');
  return html
    .slice(at, end + 4)
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

test('R8: the fleet page reads a verdict exactly as the progress page does', () => {
  // The defect this pins: the fleet page had copied in .v-win and .v-loss and
  // then spent vclass on the lifecycle status instead, so every verdict on the
  // one page whose job is finding what lost came out the same muted grey. The
  // two pages share the vocabulary or they are two designs (R8).
  const progress = readFileSync(join(REPO_ROOT, 'templates', 'progress.html'), 'utf8');

  assert.equal(
    vclassOf(TEMPLATE, 'templates/fleet.html'),
    vclassOf(progress, 'templates/progress.html'),
    'the two pages read a verdict differently',
  );

  // And it is really applied to a verdict, which is what was missing: a shared
  // function nothing calls is a shared function in name only.
  assert.match(TEMPLATE, /vclass\(parts\.word\)/, 'no verdict is drawn with vclass');
  assert.doesNotMatch(
    TEMPLATE,
    /vclass\(r\.status\)/,
    'the lifecycle status is drawn in the verdict vocabulary again',
  );
  assert.match(TEMPLATE, /sclass\(r\.status\)/, 'the status has no vocabulary of its own');
});

/* -------------------------------------------------------------------------- */
/* Bidirectional controls: one rule, three media                               */
/* -------------------------------------------------------------------------- */

/**
 * A title that reorders the line it is drawn on, and one that does not.
 *
 * #201 is the attack: an override with no terminating pop, so its effect runs
 * past the end of the field and turns the columns after it around. #202 is the
 * case that makes dropping the wrong answer for a record — a right-to-left mark
 * doing the job it exists for in a Hebrew title.
 */
const OVERRIDE_TITLE = 'Report ' + RLO + 'fdp.exe' + PDF + ' is attached';
const MARKED_TITLE = 'Fix the ' + RLM + 'שלום' + RLM + ' label';

/** A server whose issues carry bidirectional controls. */
async function directional() {
  const fake = await startGitHubFake();
  SERVERS.push(fake);
  fake.seedRepo({ owner: 'rtl', name: 'repo' });
  fake.seedIssue({
    owner: 'rtl',
    name: 'repo',
    number: 201,
    title: OVERRIDE_TITLE,
    labels: [READY],
    minutes: 0,
  });
  fake.seedIssue({
    owner: 'rtl',
    name: 'repo',
    number: 202,
    title: MARKED_TITLE,
    labels: [WORKING],
    minutes: 10,
  });
  return fake;
}

/** Every bidirectional control in `text`, as code points. */
function bidiIn(text) {
  return [...text]
    .filter((ch) => /\p{Bidi_Control}/u.test(ch))
    .map((ch) => 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'));
}

test('R12: no surface prints a live bidirectional control', async () => {
  const fake = await directional();
  const cwd = temp('bidi-');

  // The control: the titles really do carry them, so what follows is about the
  // surfaces rather than about titles that never had one.
  assert.deepEqual(bidiIn(OVERRIDE_TITLE), ['U+202E', 'U+202C']);
  assert.deepEqual(bidiIn(MARKED_TITLE), ['U+200F', 'U+200F']);

  const piped = await queue(fake, ['--repo', 'rtl/repo'], { cwd });
  assert.equal(piped.code, 0, piped.stderr);
  assert.deepEqual(bidiIn(piped.stdout), [], 'a live override reached the piped listing');

  const drawn = await queue(fake, ['--repo', 'rtl/repo'], {
    cwd,
    env: { EXOLVRA_GENESIS_FORCE_TTY: '200' },
  });
  assert.deepEqual(bidiIn(drawn.stdout), [], 'a live override reached the terminal listing');

  const json = await queue(fake, ['--repo', 'rtl/repo', '--json'], { cwd });
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(bidiIn(json.stdout), [], 'a live override reached --json');

  const fleet = await queue(fake, ['--repo', 'rtl/repo', '--fleet'], { cwd });
  assert.equal(fleet.code, 0, fleet.stderr);
  const page = readFileSync(join(cwd, '.exolvra-genesis', 'fleet.html'), 'utf8');
  assert.deepEqual(bidiIn(page), [], 'a live override reached the fleet page');
});

test('R12: --json escapes them, so the record is still the issue exactly', async () => {
  const fake = await directional();
  const cwd = temp('bidi-json-');

  const { code, stdout, stderr } = await queue(fake, ['--repo', 'rtl/repo', '--json'], { cwd });
  assert.equal(code, 0, stderr);

  // Escaped, not dropped: the document carries the six characters that spell
  // the code point, and a terminal has nothing to obey in any of them.
  assert.ok(stdout.includes('\\u202e'), 'the override was not escaped:\n' + stdout);
  assert.ok(stdout.includes('\\u202c'), 'the pop was not escaped:\n' + stdout);
  assert.ok(stdout.includes('\\u200f'), 'the mark was not escaped:\n' + stdout);

  // And what a parser gets back is the issue's own title, character for
  // character — which is what dropping them would have cost.
  const records = JSON.parse(stdout);
  assert.equal(records.find((record) => record.issue === 201).title, OVERRIDE_TITLE);
  assert.equal(records.find((record) => record.issue === 202).title, MARKED_TITLE);
});

test('R12: the table drops them, because a column cannot lay them out', async () => {
  const fake = await directional();
  const cwd = temp('bidi-table-');

  const { stdout } = await queue(fake, ['--repo', 'rtl/repo'], { cwd });
  const row = rows(stdout).find((fields) => fields[1] === '#201');
  assert.ok(row !== undefined, stdout);
  assert.equal(row.length, 5);
  // The words survive; only what would have reordered them is gone.
  assert.equal(row[2], 'Report fdp.exe is attached');
});

test('R12: every other hostile character is escaped by JSON itself', async () => {
  // Why the escaping above is one line rather than a policy: JSON already does
  // this for every class but the bidirectional one, which is the only reason
  // that one needed doing by hand.
  const fake = await seeded();
  const cwd = temp('inert-');
  const { code, stdout, stderr } = await queue(fake, ['--repo', 'cli/cli', '--json'], { cwd });
  assert.equal(code, 0, stderr);

  // #106's title carries an escape sequence, a newline and an override.
  const live = [...stdout].filter((ch) => {
    const cp = ch.codePointAt(0);
    if (cp === 10) return false; // the newline this command ends its output with
    return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || /\p{Bidi_Control}/u.test(ch);
  });
  assert.deepEqual(live, [], 'the document is not inert: ' + JSON.stringify(live));

  // Inert as text, exact as a value.
  const record = JSON.parse(stdout).find((entry) => entry.issue === 106);
  assert.equal(record.title, HOSTILE);
});

/* -------------------------------------------------------------------------- */
/* The module the next command shares                                          */
/* -------------------------------------------------------------------------- */

test('the allowlist module refuses an empty allowlist in process too', () => {
  const usage = 'exolvra-genesis work [flags]';
  assert.throws(() => resolveAllowlist({ fromFlags: [], usage }), UsageError);
  assert.throws(() => resolveAllowlist({ fromFlags: [], fromEnv: [], usage }), {
    message: /never every repository the token can see/,
  });

  assert.deepEqual(resolveAllowlist({ fromFlags: [{ owner: 'cli', name: 'cli' }], usage }), [
    { owner: 'cli', name: 'cli' },
  ]);
  // The same repository, spelled twice, is one repository.
  assert.deepEqual(
    resolveAllowlist({
      fromFlags: [
        { owner: 'cli', name: 'cli' },
        { owner: 'CLI', name: 'CLI' },
      ],
      usage,
    }),
    [{ owner: 'cli', name: 'cli' }],
  );
  // Flags win outright rather than merging with the environment.
  assert.deepEqual(
    resolveAllowlist({
      fromFlags: [{ owner: 'a', name: 'b' }],
      fromEnv: [{ owner: 'c', name: 'd' }],
      usage,
    }),
    [{ owner: 'a', name: 'b' }],
  );
  assert.deepEqual(
    resolveAllowlist({ fromFlags: [], fromEnv: [{ owner: 'c', name: 'd' }], usage }),
    [{ owner: 'c', name: 'd' }],
  );
});

test('the lifecycle namespace is prefixed, closed, and ordered', () => {
  for (const label of LIFECYCLE_LABELS) {
    assert.ok(label.startsWith('exolvra:'), label + ' is outside the namespace');
  }
  assert.equal(LIFECYCLE_LABELS.length, LIFECYCLE.length);
  assert.deepEqual([...LIFECYCLE].sort(), ['blocked', 'ready', 'review', 'triage', 'working']);

  assert.equal(lifecycleOf([READY, 'bug']), 'ready');
  assert.equal(lifecycleOf(['bug']), undefined);
  // Two at once is a transition, or an issue somebody relabelled by hand: the
  // one a reader most needs told about wins.
  assert.equal(lifecycleOf([READY, WORKING]), 'working');
  assert.equal(lifecycleOf([WORKING, BLOCKED]), 'blocked');
  assert.equal(lifecycleOf([WORKING, REVIEW]), 'review');
  assert.equal(lifecycleOf([TRIAGE, READY]), 'triage');
});

test('a repeated flag is read back out of the command line, and validated there', () => {
  const repoFlag = queueCommand.flags.find((flag) => flag.long === 'repo');
  assert.ok(repoFlag !== undefined, 'queue declares no --repo');

  const collect = (argv) =>
    repeatedFlagValues(queueCommand, argv, repoFlag, REPO_ROOT).map(
      (repo) => repo.owner + '/' + repo.name,
    );

  assert.deepEqual(collect(['--repo', 'a/b', '--repo', 'c/d']), ['a/b', 'c/d']);
  assert.deepEqual(collect(['-R', 'a/b', '--repo=c/d']), ['a/b', 'c/d']);
  assert.deepEqual(collect([]), []);

  // A value-taking flag consumes its value whether or not it is the one being
  // collected, so a repository is never read out of another flag's argument.
  assert.deepEqual(collect(['--limit', 'a/b', '--repo', 'c/d']), ['c/d']);
  // And nothing after -- is a flag at all.
  assert.deepEqual(collect(['--repo', 'a/b', '--', '--repo', 'c/d']), ['a/b']);

  // Every occurrence goes through the same boundary the first one does.
  assert.throws(() => collect(['--repo', 'a/b', '--repo', 'nope']), UsageError);
});

test('the value types reject what they say can never be valid', () => {
  const ctx = { flag: '--repo', usage: 'usage', cwd: REPO_ROOT };
  assert.throws(() => repoValue.parse(repoValue.invalid, ctx), UsageError);
  assert.throws(() => reposValue.parse(reposValue.invalid, ctx), UsageError);
  assert.throws(() => reposValue.parse('a/b, nope', ctx), UsageError);

  assert.deepEqual(repoValue.parse('cli/cli', ctx), { owner: 'cli', name: 'cli' });
  assert.deepEqual(reposValue.parse('a/b, c/d', ctx), [
    { owner: 'a', name: 'b' },
    { owner: 'c', name: 'd' },
  ]);
});

/* -------------------------------------------------------------------------- */
/* The help page                                                               */
/* -------------------------------------------------------------------------- */

test('queue --help documents every flag, every field, and every label', () => {
  const { code, stdout, stderr } = runProcess(BIN, ['queue', '--help'], {});
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');

  for (const flag of queueCommand.flags) {
    assert.ok(stdout.includes('--' + flag.long), 'the flag table is missing --' + flag.long);
    if (flag.short !== undefined) {
      assert.ok(
        stdout.includes('-' + flag.short + ', --' + flag.long),
        'the short form of --' + flag.long + ' is undocumented',
      );
    }
    if (flag.value !== undefined) {
      assert.ok(
        stdout.includes('--' + flag.long + ' ' + flag.value.arg),
        'the value placeholder for --' + flag.long + ' is missing',
      );
    }
  }
  for (const heading of [
    'USAGE',
    'FLAGS',
    'INHERITED FLAGS',
    'LABELS',
    'JSON FIELDS',
    'EXAMPLES',
    'LEARN MORE',
  ]) {
    assert.ok(stdout.includes('\n' + heading + '\n'), 'the page is missing ' + heading);
  }
  for (const label of LIFECYCLE_LABELS) {
    assert.ok(stdout.includes(label), 'the page does not name ' + label);
  }
  assert.ok(stdout.includes('EXOLVRA_GENESIS_REPOS'), 'the page never names the variable');
  for (const line of stdout.split('\n')) {
    assert.ok(line.length <= 88, 'a help line runs past the page width: ' + line);
  }
});
