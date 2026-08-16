import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { inspect } from 'node:util';

import { ConfigError } from '../dist/exit.js';
import {
  API_URL_ENV,
  API_VERSION,
  DEFAULT_API_URL,
  GitHubError,
  REDACTED,
  TOKEN_ENV,
  createGitHubClient,
  isoSeconds,
  parseRepo,
  redactSecrets,
  repoFault,
  repoSlug,
  requireAllowedUrl,
  resolveApiUrl,
  resolveToken,
  until,
} from '../dist/github.js';
import {
  FAKE_TOKEN,
  FAKE_USER,
  NO_IDENTITY,
  OPAQUE_TOKEN,
  startGitHubFake,
} from './github-fake.js';

/*
 * `src/github.ts`, driven the way it will be used.
 *
 * Every request below leaves this process over a socket and is answered by a
 * real HTTP server — the second stand-in the bar for this run permits, and the
 * only one here. `fetch` is not replaced, no `Response` is built in process, and
 * no method on the module is patched: the module resolves a URL, checks it
 * against the host it was configured with, opens a connection, sends its
 * headers and reads bytes back. The `gh auth token` path is the same idea with
 * a different kind of process: a real executable on a real PATH.
 */

const REPO = { owner: 'cli', name: 'cli' };
const READY = 'exolvra:ready';
const WORKING = 'exolvra:working';

const TEMP = [];
after(() => {
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

/** A fake with one repository and a handful of issues on it. */
async function seeded(options = {}) {
  const fake = await startGitHubFake(options);
  fake.seedRepo({
    owner: 'cli',
    name: 'cli',
    defaultBranch: 'trunk',
    branches: ['trunk', 'release', 'sketch'],
    protectedBranches: ['trunk', 'release'],
  });
  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 101,
    title: 'The oldest ready issue',
    body: 'Body of 101.\n\n- [ ] one thing\n',
    labels: [READY, 'bug'],
    minutes: 0,
    comments: ['first comment', { body: 'second comment', author: 'someone-else' }],
  });
  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 102,
    title: 'A newer ready issue',
    labels: [READY],
    minutes: 10,
  });
  fake.seedIssue({
    owner: 'cli',
    name: 'cli',
    number: 103,
    title: 'Not ready',
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
  return fake;
}

/** A client pointed at a fake, with nothing inherited from this environment. */
function clientFor(fake, extra = {}) {
  return createGitHubClient({
    token: fake.token,
    apiUrl: fake.origin,
    env: {},
    timeoutMs: 5_000,
    ...extra,
  });
}

/** Runs `act`, and answers with what it threw. Failing to throw is a failure. */
async function rejected(act, what) {
  try {
    await act();
  } catch (error) {
    return error;
  }
  assert.fail(what + ' did not fail');
}

/* -------------------------------------------------------------------------- */
/* The ways a token can be typed and still be the token                        */
/* -------------------------------------------------------------------------- */

/**
 * The text as a reader — or any NFKC round trip — sees it.
 *
 * What the C12 assertions are really about. `text.includes(token)` is the weak
 * form of the question: a token typed in fullwidth characters is not in the
 * string by that test and is on the screen by every other one. Every sweep
 * below asks it of this instead.
 */
function canonical(text) {
  let out = '';
  for (const character of text) {
    if (!/\p{Cf}/u.test(character)) out += character.normalize('NFKC');
  }
  return out;
}

/** The token typed in fullwidth forms: what a terminal draws as the token. */
function fullwidth(token) {
  return [...token]
    .map((character) => {
      const code = character.codePointAt(0);
      return code >= 0x21 && code <= 0x7e ? String.fromCodePoint(code + 0xfee0) : character;
    })
    .join('');
}

/** The token with a zero-width space through the middle of it. */
function splitByZeroWidth(token) {
  const at = Math.floor(token.length / 2);
  return token.slice(0, at) + '\u200b' + token.slice(at);
}

/**
 * How a token can arrive without arriving as itself.
 *
 * Every C12 sweep runs against all three. The first is the case the redaction
 * was written for; the other two are the cases it was not, each of which
 * carried a live token onto a published surface.
 */
const DISGUISES = [
  { name: 'plainly', apply: (token) => token },
  { name: 'in fullwidth characters', apply: fullwidth },
  { name: 'split by a zero-width space', apply: splitByZeroWidth },
];

/** The same, for something that is not a promise. */
function thrown(act, what) {
  try {
    act();
  } catch (error) {
    return error;
  }
  return assert.fail(what + ' did not fail');
}

/* -------------------------------------------------------------------------- */
/* Where the API is                                                            */
/* -------------------------------------------------------------------------- */

test('the API is github.com unless something says otherwise', () => {
  assert.equal(resolveApiUrl({ env: {} }), DEFAULT_API_URL);
  assert.equal(resolveApiUrl({ env: { [API_URL_ENV]: '   ' } }), DEFAULT_API_URL);
});

test('the environment moves the API, and an explicit URL outranks it', () => {
  assert.equal(
    resolveApiUrl({ env: { [API_URL_ENV]: 'https://ghe.example/api/v3' } }),
    'https://ghe.example/api/v3',
  );
  assert.equal(
    resolveApiUrl({
      apiUrl: 'http://127.0.0.1:8080',
      env: { [API_URL_ENV]: 'https://ghe.example/api/v3' },
    }),
    'http://127.0.0.1:8080',
  );
});

test('an API URL is normalised: no trailing slash, whatever was written', () => {
  assert.equal(resolveApiUrl({ apiUrl: 'https://api.github.com/', env: {} }), DEFAULT_API_URL);
  assert.equal(
    resolveApiUrl({ apiUrl: 'https://ghe.example/api/v3///', env: {} }),
    'https://ghe.example/api/v3',
  );
});

test('an API URL that would leak or mislead is refused', () => {
  const refused = [
    ['not-a-url', 'it is not a URL'],
    ['ftp://api.github.com', 'its scheme is ftp'],
    ['http://api.github.com', 'in the clear'],
    ['https://user:secret@api.github.com', 'user information'],
    ['https://api.github.com?token=x', 'a query or a fragment'],
  ];
  for (const [value, expected] of refused) {
    const error = thrown(() => resolveApiUrl({ apiUrl: value, env: {} }), value);
    assert.ok(error instanceof ConfigError, value + ' raised ' + error);
    assert.ok(
      error.message.includes(expected),
      value + ' was refused, but not for ' + expected + ': ' + error.message,
    );
    assert.match(error.message, /^the GitHub API URL is not one this run can use\n {2}/);
  }
});

test('http is allowed to this machine, and only to this machine', () => {
  for (const local of ['http://127.0.0.1:9', 'http://localhost:9', 'http://[::1]:9']) {
    assert.equal(resolveApiUrl({ apiUrl: local, env: {} }), local);
  }
  assert.throws(() => resolveApiUrl({ apiUrl: 'http://10.0.0.1:9', env: {} }), ConfigError);
});

/* -------------------------------------------------------------------------- */
/* The host allowlist                                                          */
/* -------------------------------------------------------------------------- */

test('C2: a URL off the configured host is refused by the module', () => {
  const error = thrown(
    () => requireAllowedUrl('https://evil.example/repos', DEFAULT_API_URL, 'list issues'),
    'an off-host URL',
  );
  assert.ok(error instanceof GitHubError, 'raised ' + error);
  assert.equal(error.kind, 'refused');
  assert.equal(error.status, undefined);
  assert.match(error.message, /^refusing to send a GitHub request to another host\n/);
  assert.ok(error.message.includes('the request would have gone to https://evil.example/repos'));
  assert.ok(error.message.includes('goes to the configured host and nowhere else'));
});

test('C2: the allowlist compares the whole origin, not the name in it', () => {
  const off = [
    'https://api.github.com.evil.example/x',
    'https://evil.example/api.github.com',
    'http://api.github.com/x',
    'https://api.github.com:8443/x',
    'not a url at all',
  ];
  for (const candidate of off) {
    const error = thrown(
      () => requireAllowedUrl(candidate, DEFAULT_API_URL, 'list issues'),
      candidate,
    );
    assert.ok(error instanceof GitHubError, candidate + ' raised ' + error);
    assert.equal(error.kind, 'refused', candidate + ' was refused for the wrong reason');
  }
  assert.equal(
    requireAllowedUrl('https://api.github.com/repos/cli/cli', DEFAULT_API_URL, 'read cli/cli')
      .pathname,
    '/repos/cli/cli',
  );
});

/* -------------------------------------------------------------------------- */
/* The token                                                                   */
/* -------------------------------------------------------------------------- */

/** A directory holding a `gh` that behaves as asked, in the platform's dialect. */
function ghShim({ stdout = '', stderr = '', status = 0 } = {}) {
  const dir = temp('gh-shim-');
  if (process.platform === 'win32') {
    const lines = ['@echo off'];
    if (stdout !== '') lines.push('echo ' + stdout);
    if (stderr !== '') lines.push('echo ' + stderr + ' 1>&2');
    lines.push('exit /b ' + status);
    writeFileSync(join(dir, 'gh.cmd'), lines.join('\r\n') + '\r\n', 'utf8');
  } else {
    const lines = ['#!/bin/sh'];
    if (stdout !== '') lines.push("printf '%s\\n' '" + stdout + "'");
    if (stderr !== '') lines.push("printf '%s\\n' '" + stderr + "' 1>&2");
    lines.push('exit ' + status);
    const path = join(dir, 'gh');
    writeFileSync(path, lines.join('\n') + '\n', 'utf8');
    chmodSync(path, 0o755);
  }
  return dir;
}

/** This environment with PATH replaced, and nothing about GitHub inherited. */
function envWith(dir, extra = {}) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^path$/i.test(name)) continue;
    if (name === TOKEN_ENV || name === API_URL_ENV) continue;
    env[name] = value;
  }
  env.PATH = dir;
  return { ...env, ...extra };
}

const SHIM_TOKEN = 'gho_ShimIssuedT0ken0000000000000000000000';

test('C2: the token comes from the environment first', () => {
  const source = resolveToken({
    env: envWith(ghShim({ stdout: SHIM_TOKEN }), { [TOKEN_ENV]: OPAQUE_TOKEN }),
  });
  assert.deepEqual(source, { token: OPAQUE_TOKEN, from: 'env' });
});

test('C2: with no environment token, `gh auth token` is asked — as a real process', () => {
  const source = resolveToken({ env: envWith(ghShim({ stdout: SHIM_TOKEN })) });
  assert.deepEqual(source, { token: SHIM_TOKEN, from: 'gh' });
});

test('C2: an empty environment token is not a token, so `gh` is still asked', () => {
  const source = resolveToken({
    env: envWith(ghShim({ stdout: SHIM_TOKEN }), { [TOKEN_ENV]: '   ' }),
  });
  assert.equal(source.from, 'gh');
});

test('C2: no token anywhere is a configuration fault naming both places', () => {
  const error = thrown(() => resolveToken({ env: envWith(temp('no-gh-')) }), 'no token');
  assert.ok(error instanceof ConfigError, 'raised ' + error);
  assert.equal(
    error.message,
    [
      'no GitHub token is available',
      '  GITHUB_TOKEN is not set',
      '  `gh auth token` was not found on PATH',
      '  set GITHUB_TOKEN, or run `gh auth login` so it can answer',
    ].join('\n'),
  );
});

test('C2: what `gh auth token` said about failing is carried into the fault', () => {
  const error = thrown(
    () =>
      resolveToken({
        env: envWith(ghShim({ stderr: 'You are not logged into any GitHub hosts', status: 1 })),
      }),
    'a gh that refused',
  );
  assert.ok(error instanceof ConfigError, 'raised ' + error);
  assert.ok(
    error.message.includes('`gh auth token` exited 1: You are not logged into any GitHub hosts'),
    error.message,
  );
});

test('C2: a `gh` that answers nothing is reported as answering nothing', () => {
  const error = thrown(() => resolveToken({ env: envWith(ghShim({})) }), 'a silent gh');
  assert.ok(error instanceof ConfigError, 'raised ' + error);
  assert.ok(error.message.includes('`gh auth token` printed nothing'), error.message);
});

test('C12: a token that could not be redacted is refused, and never quoted', () => {
  for (const [value, reason] of [
    ['tiny', 'it is shorter than 8 characters'],
    ['qqqqqqqq wwwwwwww', 'it has whitespace in it, so it is not one token'],
  ]) {
    const error = thrown(
      () => resolveToken({ env: envWith(temp('no-gh-'), { [TOKEN_ENV]: value }) }),
      value,
    );
    assert.ok(error instanceof ConfigError, value + ' raised ' + error);
    assert.equal(
      error.message,
      [
        'the GitHub token from GITHUB_TOKEN is not usable',
        '  ' + reason,
        '  set GITHUB_TOKEN, or run `gh auth login` and try again',
      ].join('\n'),
    );
    assert.ok(!error.message.includes(value), 'the rejected value was quoted back');
  }
});

test('C12: a client built from the environment says where its token came from', async () => {
  const fake = await seeded();
  try {
    const client = createGitHubClient({
      apiUrl: fake.origin,
      env: envWith(temp('no-gh-'), { [TOKEN_ENV]: fake.token }),
    });
    assert.equal(client.tokenSource, 'env');
    assert.equal(client.apiUrl, fake.origin);
    const repo = await client.getRepo(REPO);
    assert.equal(repo.defaultBranch, 'trunk');
  } finally {
    await fake.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

test('a repository answers with the branch a pull request would target', async () => {
  const fake = await seeded();
  try {
    const info = await clientFor(fake).getRepo(REPO);
    assert.deepEqual(info, {
      owner: 'cli',
      name: 'cli',
      defaultBranch: 'trunk',
      isPrivate: false,
      url: 'https://github.com/cli/cli',
    });
    const sent = fake.lastRequest();
    assert.equal(sent.method, 'GET');
    assert.equal(sent.path, '/repos/cli/cli');
  } finally {
    await fake.close();
  }
});

test('C4: the protected branches come back, and only those', async () => {
  const fake = await seeded();
  try {
    assert.deepEqual(await clientFor(fake).listProtectedBranches(REPO), ['trunk', 'release']);
    assert.equal(fake.lastRequest().query.protected, 'true');
  } finally {
    await fake.close();
  }
});

test('C5: issues are listed by label, oldest first, pull requests dropped', async () => {
  const fake = await seeded();
  try {
    const issues = await clientFor(fake).listIssues(REPO, { labels: [READY] });
    assert.deepEqual(
      issues.map((issue) => issue.number),
      [101, 102],
      'issue 103 has no ready label and 104 is a pull request',
    );
    assert.equal(issues[0].title, 'The oldest ready issue');
    assert.equal(issues[0].author, 'a-maintainer');
    assert.deepEqual(issues[0].labels, [READY, 'bug']);
    assert.equal(issues[0].commentCount, 2);
    assert.equal(issues[0].url, 'https://github.com/cli/cli/issues/101');

    const sent = fake.lastRequest();
    assert.equal(sent.path, '/repos/cli/cli/issues');
    assert.deepEqual(sent.query, {
      labels: READY,
      state: 'open',
      sort: 'created',
      direction: 'asc',
      per_page: '100',
    });
  } finally {
    await fake.close();
  }
});

test('R3: the body comes back byte for byte, because a hash is pinned over it', async () => {
  const fake = await seeded();
  try {
    const issue = await clientFor(fake).getIssue(REPO, 101);
    assert.equal(issue.body, 'Body of 101.\n\n- [ ] one thing\n');
  } finally {
    await fake.close();
  }
});

test('R3: an issue and its comments come back together, in order', async () => {
  const fake = await seeded();
  try {
    const thread = await clientFor(fake).getIssueThread(REPO, 101);
    assert.equal(thread.issue.number, 101);
    assert.deepEqual(
      thread.comments.map((comment) => comment.body),
      ['first comment', 'second comment'],
    );
    assert.deepEqual(
      thread.comments.map((comment) => comment.author),
      ['a-maintainer', 'someone-else'],
    );
    assert.ok(thread.comments.every((comment) => Number.isInteger(comment.id)));
  } finally {
    await fake.close();
  }
});

test('every request carries the Accept, version, agent and Authorization headers', async () => {
  const fake = await seeded();
  try {
    await clientFor(fake).getRepo(REPO);
    const sent = fake.lastRequest();
    assert.equal(sent.headers.accept, 'application/vnd.github+json');
    assert.equal(sent.headers['x-github-api-version'], API_VERSION);
    assert.equal(sent.headers['user-agent'], 'exolvra-genesis');
    assert.equal(sent.headers.authorization, 'Bearer ' + fake.token);
  } finally {
    await fake.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

test('R5: labels are added, and the issue’s labels come back', async () => {
  const fake = await seeded();
  try {
    const labels = await clientFor(fake).addLabels(REPO, 101, [WORKING]);
    assert.deepEqual(labels, [READY, 'bug', WORKING]);
    assert.deepEqual(fake.labelsOf('cli', 'cli', 101), [READY, 'bug', WORKING]);
    const sent = fake.lastRequest();
    assert.equal(sent.method, 'POST');
    assert.equal(sent.path, '/repos/cli/cli/issues/101/labels');
    assert.deepEqual(sent.json, { labels: [WORKING] });
  } finally {
    await fake.close();
  }
});

test('C6: removing a label answers whether it was there to remove', async () => {
  const fake = await seeded();
  try {
    const client = clientFor(fake);
    assert.equal(await client.removeLabel(REPO, 101, READY), true);
    assert.deepEqual(fake.labelsOf('cli', 'cli', 101), ['bug']);
    assert.equal(
      await client.removeLabel(REPO, 101, READY),
      false,
      'a label that already moved is not a fault; it is the answer',
    );
  } finally {
    await fake.close();
  }
});

test('C5: a label is one path segment, whatever is in it', async () => {
  const fake = await seeded();
  try {
    await clientFor(fake).addLabels(REPO, 101, ['area/cli']);
    await clientFor(fake).removeLabel(REPO, 101, 'area/cli');
    const sent = fake.lastRequest();
    assert.equal(sent.rawPath, '/repos/cli/cli/issues/101/labels/area%2Fcli');
    assert.equal(sent.path, '/repos/cli/cli/issues/101/labels/area/cli');
    assert.deepEqual(fake.labelsOf('cli', 'cli', 101), [READY, 'bug']);
  } finally {
    await fake.close();
  }
});

test('R6: a comment is made once and then edited in place', async () => {
  const fake = await seeded();
  try {
    const client = clientFor(fake);
    const made = await client.createComment(REPO, 101, 'round 1 · running');
    assert.equal(made.body, 'round 1 · running');
    const edited = await client.updateComment(REPO, made.id, 'round 2 · running');
    assert.equal(edited.id, made.id);
    assert.equal(edited.body, 'round 2 · running');
    assert.deepEqual(
      fake.commentsOn('cli', 'cli', 101).map((comment) => comment.body),
      ['first comment', 'second comment', 'round 2 · running'],
      'the sticky comment is one comment, edited',
    );
    assert.equal(fake.lastRequest().method, 'PATCH');
  } finally {
    await fake.close();
  }
});

test('R9: a pull request is opened against the branch it was told to target', async () => {
  const fake = await seeded();
  try {
    const pull = await clientFor(fake).createPullRequest(REPO, {
      title: 'Fix the thing',
      head: 'exolvra-genesis/issue-101-fix-the-thing',
      base: 'trunk',
      body: 'Closes #101',
      draft: true,
    });
    assert.equal(pull.base, 'trunk');
    assert.equal(pull.head, 'exolvra-genesis/issue-101-fix-the-thing');
    assert.equal(pull.draft, true);
    assert.equal(pull.url, 'https://github.com/cli/cli/pull/501');
    assert.deepEqual(fake.lastRequest().json, {
      title: 'Fix the thing',
      head: 'exolvra-genesis/issue-101-fix-the-thing',
      base: 'trunk',
      body: 'Closes #101',
      draft: true,
    });
  } finally {
    await fake.close();
  }
});

test('R9: open pull requests are listed, and can be narrowed to one branch', async () => {
  const fake = await seeded();
  try {
    fake.seedPull({ owner: 'cli', name: 'cli', number: 7, head: 'other-work', base: 'trunk' });
    const client = clientFor(fake);
    await client.createPullRequest(REPO, {
      title: 'Fix the thing',
      head: 'exolvra-genesis/issue-101',
      base: 'trunk',
      body: '',
    });
    const all = await client.listPullRequests(REPO);
    assert.deepEqual(
      all.map((pull) => pull.number),
      [7, 501],
    );
    const mine = await client.listPullRequests(REPO, {
      head: 'cli:exolvra-genesis/issue-101',
    });
    assert.deepEqual(
      mine.map((pull) => pull.head),
      ['exolvra-genesis/issue-101'],
    );
  } finally {
    await fake.close();
  }
});

test('R9: a pull request already open is edited to carry this run’s evidence', async () => {
  const fake = await seeded();
  try {
    fake.seedPull({
      owner: 'cli',
      name: 'cli',
      number: 7,
      title: 'Fix the thing',
      head: 'exolvra-genesis/issue-101-fix-the-thing',
      base: 'trunk',
    });
    const client = clientFor(fake);
    const body = '### Evidence\n\nRound 2 · WIN, WIN\n';
    const pull = await client.updatePullRequest(REPO, 7, { body });

    assert.equal(pull.number, 7);
    assert.equal(pull.body, body);
    assert.equal(pull.title, 'Fix the thing', 'a body-only edit left the title alone');
    assert.equal(pull.base, 'trunk');

    const sent = fake.lastRequest();
    assert.equal(sent.method, 'PATCH');
    assert.equal(sent.path, '/repos/cli/cli/pulls/7');
    assert.deepEqual(
      sent.json,
      { body },
      'a field the caller did not name is a field GitHub must leave alone',
    );
    assert.deepEqual(
      fake.pullsOpened().map((entry) => [entry.number, entry.title, entry.body]),
      [[7, 'Fix the thing', body]],
    );
  } finally {
    await fake.close();
  }
});

test('R9: a title and a body are each sent only when they are given', async () => {
  const fake = await seeded();
  try {
    fake.seedPull({ owner: 'cli', name: 'cli', number: 7, head: 'a-branch', base: 'trunk' });
    const client = clientFor(fake);

    await client.updatePullRequest(REPO, 7, { title: 'A better title' });
    assert.deepEqual(fake.lastRequest().json, { title: 'A better title' });

    const both = await client.updatePullRequest(REPO, 7, { title: 'Newer', body: 'Newest' });
    assert.deepEqual(fake.lastRequest().json, { title: 'Newer', body: 'Newest' });
    assert.equal(both.title, 'Newer');
    assert.equal(both.body, 'Newest');
  } finally {
    await fake.close();
  }
});

test('a pull request that is not there is a fault in the house shape', async () => {
  const fake = await seeded();
  try {
    const error = await rejected(
      () => clientFor(fake).updatePullRequest(REPO, 4242, { body: 'evidence' }),
      'an edit of a pull request that does not exist',
    );
    assert.equal(error.kind, 'not-found');
    assert.equal(error.status, 404);
    assert.equal(error.operation, 'update pull request #4242 in cli/cli');
    assertHouseShape(error);
    assert.match(error.message, /^could not update pull request #4242 in cli\/cli\n/);
    assert.ok(error.message.includes('PATCH ' + fake.origin + '/repos/cli/cli/pulls/4242'));
    assert.ok(error.message.includes('GitHub said: Not Found'));
  } finally {
    await fake.close();
  }
});

test('arguments this module will not send are refused before any request', async () => {
  const fake = await seeded();
  try {
    const client = clientFor(fake);
    fake.clearRequests();
    const cases = [
      () => client.getIssue(REPO, 0),
      () => client.getIssue(REPO, 1.5),
      () => client.addLabels(REPO, 101, []),
      () => client.addLabels(REPO, 101, ['  ']),
      () => client.removeLabel(REPO, 101, ''),
      () => client.createComment(REPO, 101, '   '),
      () => client.updateComment(REPO, -1, 'body'),
      () => client.createPullRequest(REPO, { title: '', head: 'x', base: 'y', body: '' }),
      () => client.createPullRequest(REPO, { title: 't', head: '', base: 'y', body: '' }),
      () => client.createPullRequest(REPO, { title: 't', head: 'x', base: '', body: '' }),
      () => client.updatePullRequest(REPO, 0, { body: 'evidence' }),
      () => client.updatePullRequest(REPO, 7, {}),
      () => client.updatePullRequest(REPO, 7, { title: '' }),
      () => client.updatePullRequest(REPO, 7, { body: '   ' }),
    ];
    for (const act of cases) {
      const error = await rejected(act, 'a refused argument');
      assert.ok(error instanceof GitHubError, 'expected a GitHubError: ' + error);
      assert.equal(error.kind, 'refused');
      assert.match(error.message, /^refusing to /);
      assert.ok(error.message.includes('the request was not made'));
    }
    assert.deepEqual(fake.requests, [], 'nothing reached the network');
  } finally {
    await fake.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

test('a listing walks every page GitHub offers', async () => {
  const fake = await seeded({ pageSize: 1 });
  try {
    const issues = await clientFor(fake).listIssues(REPO, { labels: [READY] });
    assert.deepEqual(
      issues.map((issue) => issue.number),
      [101, 102],
    );
    assert.equal(
      fake.requests.filter((request) => request.path === '/repos/cli/cli/issues').length,
      3,
      'two pages of issues and the empty page the pull request left behind',
    );
  } finally {
    await fake.close();
  }
});

test('a listing that never ends is stopped rather than followed forever', async () => {
  const fake = await seeded({ pageSize: 1 });
  try {
    const error = await rejected(
      () => clientFor(fake, { maxPages: 2 }).listIssues(REPO, { labels: [READY] }),
      'an endless listing',
    );
    assert.equal(error.kind, 'http');
    assert.ok(error.message.includes('still offering pages after 2'), error.message);
  } finally {
    await fake.close();
  }
});

test('C2: a next page on another host is refused', async () => {
  const fake = await seeded();
  try {
    fake.reply({
      method: 'GET',
      path: '/repos/cli/cli/issues',
      status: 200,
      body: [],
      headers: { link: '<https://evil.example/issues?page=2>; rel="next"' },
    });
    const error = await rejected(() => clientFor(fake).listIssues(REPO), 'an off-host next page');
    assert.equal(error.kind, 'refused');
    assert.ok(error.message.includes('https://evil.example/issues?page=2'), error.message);
  } finally {
    await fake.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Redirects                                                                   */
/* -------------------------------------------------------------------------- */

test('C2: a redirect that stays on the host is followed', async () => {
  const fake = await seeded();
  try {
    fake.reply({
      method: 'GET',
      path: '/repos/cli/cli',
      status: 301,
      headers: { location: fake.origin + '/repos/cli/cli' },
    });
    const info = await clientFor(fake).getRepo(REPO);
    assert.equal(info.defaultBranch, 'trunk');
    assert.equal(
      fake.requests.filter((request) => request.path === '/repos/cli/cli').length,
      2,
      'the redirect and the request it pointed at',
    );
  } finally {
    await fake.close();
  }
});

test('C2: a redirect to another host is refused before it is followed', async () => {
  const fake = await seeded();
  try {
    fake.reply({
      method: 'GET',
      path: '/repos/cli/cli',
      status: 302,
      headers: { location: 'https://evil.example/repos/cli/cli' },
    });
    const error = await rejected(() => clientFor(fake).getRepo(REPO), 'an off-host redirect');
    assert.equal(error.kind, 'refused');
    assert.ok(error.message.includes('https://evil.example/repos/cli/cli'), error.message);
  } finally {
    await fake.close();
  }
});

test('C3: a write is never followed to another address', async () => {
  const fake = await seeded();
  try {
    fake.reply({
      method: 'POST',
      path: '/repos/cli/cli/issues/101/comments',
      status: 307,
      headers: { location: fake.origin + '/repos/cli/cli/issues/102/comments' },
    });
    const error = await rejected(
      () => clientFor(fake).createComment(REPO, 101, 'a claim'),
      'a redirected write',
    );
    assert.equal(error.kind, 'http');
    assert.ok(error.message.includes('a POST is not followed to another address'), error.message);
    assert.deepEqual(fake.commentsOn('cli', 'cli', 102), [], 'nothing was written elsewhere');
  } finally {
    await fake.close();
  }
});

test('C2: a redirect loop ends, and says it was a loop', async () => {
  const fake = await seeded();
  try {
    fake.reply({
      method: 'GET',
      path: '/repos/cli/cli',
      status: 302,
      headers: { location: fake.origin + '/repos/cli/cli' },
      times: 20,
    });
    const error = await rejected(() => clientFor(fake).getRepo(REPO), 'a redirect loop');
    assert.equal(error.kind, 'http');
    assert.ok(error.message.includes('is a loop, not a route'), error.message);
  } finally {
    await fake.close();
  }
});

/* -------------------------------------------------------------------------- */
/* What a failure reads like                                                   */
/* -------------------------------------------------------------------------- */

/** Every message here: a complaint on line one, indented detail under it. */
function assertHouseShape(error) {
  const [complaint, ...rest] = error.message.split('\n');
  assert.ok(complaint.length > 0, 'the complaint is empty');
  assert.ok(!complaint.startsWith(' '), 'the complaint is indented: ' + complaint);
  assert.ok(rest.length > 0, 'there is no detail under the complaint: ' + error.message);
  for (const line of rest) {
    assert.match(line, /^ {2}\S/, 'detail is not indented by two: ' + JSON.stringify(line));
  }
}

test('a 404 names the call, the status, and what GitHub said', async () => {
  const fake = await seeded();
  try {
    const error = await rejected(
      () => clientFor(fake).getRepo({ owner: 'cli', name: 'nothing-here' }),
      'a missing repository',
    );
    assert.equal(error.kind, 'not-found');
    assert.equal(error.status, 404);
    assert.equal(error.operation, 'read cli/nothing-here');
    assertHouseShape(error);
    assert.match(error.message, /^could not read cli\/nothing-here\n/);
    assert.ok(error.message.includes('GET ' + fake.origin + '/repos/cli/nothing-here'));
    assert.ok(error.message.includes('answered 404'));
    assert.ok(error.message.includes('GitHub said: Not Found'));
    assert.ok(error.message.includes('a repository the token cannot see answers 404'));
  } finally {
    await fake.close();
  }
});

test('a 401 says the token was rejected and where it came from', async () => {
  const fake = await seeded();
  try {
    const client = createGitHubClient({
      token: 'ghp_a-token-this-server-does-not-accept',
      apiUrl: fake.origin,
      env: {},
    });
    const error = await rejected(() => client.getRepo(REPO), 'a rejected token');
    assert.equal(error.kind, 'auth');
    assert.equal(error.status, 401);
    assertHouseShape(error);
    assert.match(error.message, /^GitHub rejected the token while trying to read cli\/cli\n/);
    assert.ok(error.message.includes('GitHub said: Bad credentials'));
    assert.ok(error.message.includes('the token came from this run'));
    assert.ok(error.message.includes('`gh auth login` issues a new one'));
  } finally {
    await fake.close();
  }
});

test('a 403 explains the scopes the call needs', async () => {
  const fake = await seeded();
  try {
    fake.reply({
      method: 'GET',
      path: '/repos/cli/cli/issues',
      status: 403,
      body: {
        message: 'Resource not accessible by integration',
        documentation_url: 'https://docs.github.com/rest/issues/issues',
      },
    });
    const error = await rejected(() => clientFor(fake).listIssues(REPO), 'a forbidden listing');
    assert.equal(error.kind, 'auth');
    assert.equal(error.status, 403);
    assertHouseShape(error);
    assert.ok(error.message.includes('GitHub said: Resource not accessible by integration'));
    assert.ok(error.message.includes('needs the `repo` scope'));
    assert.ok(error.message.includes('see https://docs.github.com/rest/issues/issues'));
  } finally {
    await fake.close();
  }
});

test('a documentation link that is not GitHub’s is not repeated', async () => {
  const fake = await seeded();
  try {
    fake.reply({
      method: 'GET',
      path: '/repos/cli/cli/issues',
      status: 403,
      body: { message: 'no', documentation_url: 'https://evil.example/click-here' },
    });
    const error = await rejected(() => clientFor(fake).listIssues(REPO), 'a forbidden listing');
    assert.ok(!error.message.includes('evil.example'), error.message);
  } finally {
    await fake.close();
  }
});

test('a rate limit names when it lifts', async () => {
  const fake = await seeded();
  try {
    const reset = Math.floor(Date.UTC(2026, 7, 14, 18, 30, 0) / 1000);
    fake.reply({
      method: 'GET',
      path: '/repos/cli/cli/issues',
      status: 403,
      body: { message: 'API rate limit exceeded for user ID 1.' },
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(reset),
      },
    });
    const error = await rejected(() => clientFor(fake).listIssues(REPO), 'a rate limit');
    assert.equal(error.kind, 'rate-limit');
    assert.equal(error.status, 403);
    assert.equal(error.resetAt.getTime(), reset * 1000);
    assertHouseShape(error);
    assert.match(error.message, /^GitHub rate-limited this run while trying to list issues in cli\/cli\n/);
    assert.ok(error.message.includes('the limit lifts at 2026-08-14T18:30:00Z (in '), error.message);
  } finally {
    await fake.close();
  }
});

test('a 429 with no reset header still reads as a rate limit', async () => {
  const fake = await seeded();
  try {
    fake.reply({ method: 'GET', path: '/repos/cli/cli/issues', status: 429, body: {} });
    const error = await rejected(() => clientFor(fake).listIssues(REPO), 'a rate limit');
    assert.equal(error.kind, 'rate-limit');
    assert.equal(error.resetAt, undefined);
    assert.ok(error.message.includes('did not say when the limit lifts'), error.message);
  } finally {
    await fake.close();
  }
});

test('a retry-after header is read when there is no reset', async () => {
  const fake = await seeded();
  try {
    fake.reply({
      method: 'GET',
      path: '/repos/cli/cli/issues',
      status: 429,
      body: { message: 'You have exceeded a secondary rate limit' },
      headers: { 'retry-after': '60' },
    });
    const error = await rejected(() => clientFor(fake).listIssues(REPO), 'a rate limit');
    assert.equal(error.kind, 'rate-limit');
    assert.ok(error.resetAt instanceof Date);
    assert.ok(error.message.includes('the limit lifts at '), error.message);
  } finally {
    await fake.close();
  }
});

/*
 * GitHub throttles twice, and the second one does not look like the first.
 *
 * A *primary* limit spends a quota: `x-ratelimit-remaining` reaches 0. A
 * *secondary* limit throttles a burst of writes — what a scheduled pass over
 * several issues produces — and answers 403 with `retry-after` and a primary
 * quota that is nowhere near spent. Reading only the first classed the second
 * as an authorisation failure: exit 2, and advice to check the `repo` scope on
 * a token whose scopes were never the problem.
 */
const SECONDARY = 'You have exceeded a secondary rate limit and have been temporarily blocked';

test('a secondary rate limit is a wait, at a read and at a write alike', async () => {
  const calls = [
    {
      name: 'a read',
      method: 'GET',
      path: '/repos/cli/cli/issues',
      act: (client) => client.listIssues(REPO, { labels: [READY] }),
    },
    {
      name: 'a write',
      method: 'POST',
      path: '/repos/cli/cli/issues/101/comments',
      act: (client) => client.createComment(REPO, 101, 'round 1 · running'),
    },
    {
      name: 'a label move',
      method: 'POST',
      path: '/repos/cli/cli/issues/101/labels',
      act: (client) => client.addLabels(REPO, 101, [WORKING]),
    },
  ];

  for (const call of calls) {
    const fake = await seeded();
    try {
      // The primary quota is nowhere near spent, which is exactly what makes
      // this a secondary limit rather than an exhausted one.
      const far = Math.floor(Date.now() / 1000) + 3000;
      fake.reply({
        method: call.method,
        path: call.path,
        status: 403,
        body: { message: SECONDARY, documentation_url: 'https://docs.github.com/rest' },
        headers: {
          'retry-after': '60',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': String(far),
        },
      });

      const error = await rejected(() => call.act(clientFor(fake)), call.name + ' throttled');
      assert.equal(error.kind, 'rate-limit', call.name + ' was classed as ' + error.kind);
      assert.equal(error.status, 403);
      assertHouseShape(error);
      assert.match(error.message, /^GitHub rate-limited this run while trying to /);
      assert.ok(error.message.includes('GitHub said: ' + SECONDARY), error.message);
      assert.ok(error.message.includes('the limit lifts at '), error.message);

      // The wait is the one GitHub named, not the hourly window it did not
      // exhaust — fifty minutes of waiting for a throttle already over.
      const waited = error.resetAt.getTime() - Date.now();
      assert.ok(
        waited > 50_000 && waited <= 61_000,
        call.name + ' waited ' + Math.round(waited / 1000) + 's instead of 60s',
      );
      assert.ok(
        !error.message.includes(isoSeconds(new Date(far * 1000))),
        'the message named the primary window instead of the retry-after: ' + error.message,
      );

      // And none of the remediation a real authorisation failure earns.
      assert.ok(
        !error.message.includes('`repo` scope'),
        call.name + ' told somebody to check their scopes: ' + error.message,
      );
      assert.ok(!error.message.includes('the token came from'), error.message);
    } finally {
      await fake.close();
    }
  }
});

test('a secondary rate limit is recognised from what GitHub said alone', async () => {
  // Belt and braces: no retry-after, a quota that is not spent, and only the
  // sentence to go on.
  const fake = await seeded();
  try {
    fake.reply({
      method: 'POST',
      path: '/repos/cli/cli/issues/101/comments',
      status: 403,
      body: { message: SECONDARY },
      headers: { 'x-ratelimit-remaining': '4999' },
    });
    const error = await rejected(
      () => clientFor(fake).createComment(REPO, 101, 'a claim'),
      'a throttled write',
    );
    assert.equal(error.kind, 'rate-limit');
    assert.equal(error.resetAt, undefined, 'nothing said when it lifts, so nothing is claimed');
    assert.ok(error.message.includes('did not say when the limit lifts'), error.message);
    assert.ok(!error.message.includes('`repo` scope'), error.message);
  } finally {
    await fake.close();
  }
});

test('a 403 that is a real refusal is still a refusal', async () => {
  // The other half of the classifier: a quota with room in it, no retry-after,
  // and nothing about a limit in the sentence. This one really is the scopes.
  const fake = await seeded();
  try {
    fake.reply({
      method: 'GET',
      path: '/repos/cli/cli/issues',
      status: 403,
      body: { message: 'Resource not accessible by integration' },
      headers: { 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000' },
    });
    const error = await rejected(() => clientFor(fake).listIssues(REPO), 'a forbidden listing');
    assert.equal(error.kind, 'auth');
    assert.equal(error.status, 403);
    assert.equal(error.resetAt, undefined);
    assert.match(error.message, /^GitHub refused the token while trying to /);
    assert.ok(error.message.includes('needs the `repo` scope'), error.message);
    assert.ok(!error.message.includes('the limit lifts'), error.message);
  } finally {
    await fake.close();
  }
});

test('a 5xx says whose side it is, and that nothing was retried', async () => {
  const fake = await seeded();
  try {
    fake.reply({
      method: 'GET',
      path: '/repos/cli/cli',
      status: 502,
      body: { message: 'Server Error' },
    });
    const error = await rejected(() => clientFor(fake).getRepo(REPO), 'a server error');
    assert.equal(error.kind, 'http');
    assert.equal(error.status, 502);
    assertHouseShape(error);
    assert.ok(error.message.includes('nothing here retried it'), error.message);
    assert.equal(
      fake.requests.filter((request) => request.path === '/repos/cli/cli').length,
      1,
      'nothing was retried',
    );
  } finally {
    await fake.close();
  }
});

test('a 422 carries the field GitHub objected to', async () => {
  const fake = await seeded();
  try {
    fake.reply({
      method: 'POST',
      path: '/repos/cli/cli/pulls',
      status: 422,
      body: {
        message: 'Validation Failed',
        errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }],
      },
    });
    const error = await rejected(
      () =>
        clientFor(fake).createPullRequest(REPO, {
          title: 'x',
          head: 'a-branch-that-is-not-pushed',
          base: 'trunk',
          body: '',
        }),
      'a rejected pull request',
    );
    assert.equal(error.status, 422);
    assert.ok(error.message.includes('GitHub said: Validation Failed'), error.message);
    assert.ok(error.message.includes('head: invalid'), error.message);
  } finally {
    await fake.close();
  }
});

test('an answer that is not JSON is a fault with a name', async () => {
  const fake = await seeded();
  try {
    fake.reply({ method: 'GET', path: '/repos/cli/cli', status: 200, body: '<html>nope</html>' });
    const error = await rejected(() => clientFor(fake).getRepo(REPO), 'a non-JSON answer');
    assert.equal(error.kind, 'malformed');
    assertHouseShape(error);
    assert.ok(error.message.includes('the body is not JSON: <html>nope</html>'), error.message);
  } finally {
    await fake.close();
  }
});

test('an answer missing the field that was asked for is a fault with a name', async () => {
  const fake = await seeded();
  try {
    fake.reply({ method: 'GET', path: '/repos/cli/cli', status: 200, body: { name: 'cli' } });
    const error = await rejected(() => clientFor(fake).getRepo(REPO), 'a repository with no branch');
    assert.equal(error.kind, 'malformed');
    assert.ok(error.message.includes('the answer has no default branch'), error.message);
  } finally {
    await fake.close();
  }
});

test('a listing that is not a list is a fault with a name', async () => {
  const fake = await seeded();
  try {
    fake.reply({
      method: 'GET',
      path: '/repos/cli/cli/issues',
      status: 200,
      body: { message: 'not a list' },
    });
    const error = await rejected(() => clientFor(fake).listIssues(REPO), 'a listing that is not one');
    assert.equal(error.kind, 'malformed');
    assert.ok(error.message.includes('a listing is a JSON array'), error.message);
  } finally {
    await fake.close();
  }
});

test('an answer larger than this reads is refused rather than held', async () => {
  const fake = await seeded();
  try {
    fake.reply({
      method: 'GET',
      path: '/repos/cli/cli',
      status: 200,
      hang: true,
      headers: { 'content-length': String(17 * 1024 * 1024) },
    });
    const error = await rejected(
      () => clientFor(fake, { timeoutMs: 4_000 }).getRepo(REPO),
      'an oversized answer',
    );
    assert.equal(error.kind, 'malformed');
    assert.ok(error.message.includes('17825792 bytes'), error.message);
  } finally {
    await fake.close();
  }
});

test('nothing listening is reported as not reaching GitHub', async () => {
  const closed = await startGitHubFake();
  const origin = closed.origin;
  await closed.close();
  const client = createGitHubClient({ token: FAKE_TOKEN, apiUrl: origin, env: {} });
  const error = await rejected(() => client.getRepo(REPO), 'a closed port');
  assert.equal(error.kind, 'unreachable');
  assert.equal(error.status, undefined);
  assertHouseShape(error);
  assert.match(error.message, /^could not reach GitHub to read cli\/cli\n/);
  assert.ok(error.message.includes('the GitHub API this run is configured for is ' + origin));
});

test('F2: an answer that begins and then stalls is a fault with a name', async () => {
  // Headers sent, body never. The deadline this module set falls while the body
  // is being read rather than while the connection is being made, so the
  // rejection arrives from the body read and not from `fetch`. Uncaught it
  // reaches a terminal as `The operation was aborted due to timeout` under the
  // "unexpected error, please report it" banner — a fault with no name, about a
  // limit this module chose. Every call has to classify it.
  const stall = { status: 200, hang: true };
  const calls = [
    {
      name: 'a listing',
      path: '/repos/cli/cli/issues',
      method: 'GET',
      act: (client) => client.listIssues(REPO, { labels: [READY] }),
      operation: 'list issues labelled ' + READY + ' in cli/cli',
    },
    {
      name: 'a claim',
      path: '/repos/cli/cli/issues/101/labels',
      method: 'POST',
      act: (client) => client.addLabels(REPO, 101, [WORKING]),
      operation: 'label issue #101 in cli/cli with ' + WORKING,
    },
    {
      name: 'a comment',
      path: '/repos/cli/cli/issues/101/comments',
      method: 'POST',
      act: (client) => client.createComment(REPO, 101, 'a claim'),
      operation: 'comment on issue #101 in cli/cli',
    },
  ];

  for (const call of calls) {
    const fake = await seeded();
    try {
      fake.reply({ method: call.method, path: call.path, ...stall });
      const client = clientFor(fake, { timeoutMs: 500 });
      const error = await rejected(() => call.act(client), call.name + ' that stalled');
      assert.ok(error instanceof GitHubError, call.name + ' raised ' + error);
      assert.equal(error.kind, 'unreachable', call.name + ' was the wrong kind');
      assert.equal(error.status, undefined);
      assert.equal(error.operation, call.operation);
      assertHouseShape(error);
      assert.match(error.message, /^could not reach GitHub to /);
      assert.ok(
        error.message.includes('the answer began and then stopped; the rest of it never arrived within 500ms'),
        error.message,
      );
      assert.ok(
        !error.message.includes('aborted due to timeout'),
        'the abort reached the message raw: ' + error.message,
      );
    } finally {
      await fake.close();
    }
  }
});

test('F2: an identity call that stalls is transient, not a configuration fault', async () => {
  const fake = await seeded();
  try {
    fake.reply({ method: 'GET', path: '/user', status: 200, hang: true });
    const me = await clientFor(fake, { timeoutMs: 500 }).whoAmI();
    assert.equal(me.known, false);
    assert.equal(
      me.cause,
      'transient',
      'a stalled answer is not somebody’s workflow file being wrong',
    );
    assert.ok(me.reason.includes('could not reach GitHub to ask who this token is'), me.reason);
    assert.ok(!me.reason.includes('aborted due to timeout'), me.reason);
  } finally {
    await fake.close();
  }
});

test('an answer that never comes is abandoned, and says how long it waited', async () => {
  const fake = await seeded();
  try {
    fake.reply({ method: 'GET', path: '/repos/cli/cli', status: 200, body: {}, delayMs: 5_000 });
    const error = await rejected(
      () => clientFor(fake, { timeoutMs: 250 }).getRepo(REPO),
      'a slow answer',
    );
    assert.equal(error.kind, 'unreachable');
    assert.ok(error.message.includes('nothing answered within'), error.message);
  } finally {
    await fake.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Who the token is                                                            */
/* -------------------------------------------------------------------------- */

/** A client pointed at an origin nothing is listening on. */
async function deadOrigin() {
  const fake = await startGitHubFake();
  const origin = fake.origin;
  await fake.close();
  return origin;
}

test('a user token is named by the login a comment would show', async () => {
  const fake = await seeded();
  try {
    const me = await clientFor(fake).whoAmI();
    assert.deepEqual(me, { known: true, login: FAKE_USER.login, kind: 'user' });

    const sent = fake.lastRequest();
    assert.equal(sent.method, 'GET');
    assert.equal(sent.path, '/user');
    assert.equal(sent.headers.authorization, 'Bearer ' + fake.token);
    assert.equal(sent.headers.accept, 'application/vnd.github+json');
    assert.equal(sent.headers['x-github-api-version'], API_VERSION);
  } finally {
    await fake.close();
  }
});

test('the identity is asked once for the life of a client', async () => {
  const fake = await seeded();
  try {
    const client = clientFor(fake);
    const [first, second, third] = await Promise.all([
      client.whoAmI(),
      client.whoAmI(),
      client.whoAmI(),
    ]);
    assert.deepEqual(first, second);
    assert.deepEqual(second, third);
    await client.whoAmI();
    assert.equal(
      fake.requests.filter((request) => request.path === '/user').length,
      1,
      'a property of the token was asked for more than once',
    );
  } finally {
    await fake.close();
  }
});

test('a bot token is named the way its comments are signed', async () => {
  for (const [answer, login] of [
    [{ login: 'github-actions[bot]', type: 'Bot' }, 'github-actions[bot]'],
    // GitHub writes the suffix in some answers and not in others; a comment
    // always carries it, and a comment is what this is compared against.
    [{ login: 'my-app', type: 'Bot' }, 'my-app[bot]'],
    // The app's own record: a slug, and no login at all.
    [{ slug: 'my-app', id: 7, name: 'My App' }, 'my-app[bot]'],
  ]) {
    const fake = await seeded({ identity: answer });
    try {
      assert.deepEqual(await clientFor(fake).whoAmI(), { known: true, login, kind: 'app' });
    } finally {
      await fake.close();
    }
  }
});

test('an installation token that cannot ask is unknown, not a failure', async () => {
  const fake = await seeded({ identity: NO_IDENTITY });
  try {
    const me = await clientFor(fake).whoAmI();
    assert.equal(me.known, false);
    assert.ok(me.reason.includes('(403)'), me.reason);
    assert.ok(me.reason.includes('Resource not accessible by integration'), me.reason);
    assert.equal(me.reason.includes('\n'), false, 'the reason is one line');

    // And the client still works: not knowing who the token is stops nothing.
    assert.equal((await clientFor(fake).getRepo(REPO)).defaultBranch, 'trunk');
  } finally {
    await fake.close();
  }
});

test('an answer with no name in it is unknown, and says so', async () => {
  const fake = await seeded({ identity: { id: 1, type: 'User' } });
  try {
    const me = await clientFor(fake).whoAmI();
    assert.equal(me.known, false);
    assert.ok(me.reason.includes('without a login'), me.reason);
    assert.notEqual(me.reason, '', 'an empty reason is the thing this type exists to prevent');
  } finally {
    await fake.close();
  }
});

test('C12: a host that answers the identity call with the token names nobody', async () => {
  // The hostile-host case: `GET /user` answers `{"login": "<the token>"}`. The
  // token must reach neither the identity nor anything a caller would store,
  // and the answer must be the unknown one — which stops a run that would
  // write — rather than a known identity holding a secret.
  for (const token of [OPAQUE_TOKEN, FAKE_TOKEN]) {
    for (const answer of [
      { login: token, type: 'User' },
      { login: 'a-runner-' + token, type: 'User' },
      { slug: token },
      { login: token + '[bot]', type: 'Bot' },
    ]) {
      const fake = await seeded({ token, identity: answer });
      try {
        const me = await clientFor(fake).whoAmI();
        assert.equal(me.known, false, JSON.stringify(answer) + ' was read as an identity');
        assert.equal(me.login, undefined, 'an unknown identity carries no login');
        assert.ok(me.reason.includes('is not a login'), me.reason);
        for (const [where, text] of Object.entries({
          reason: me.reason,
          json: JSON.stringify(me),
          inspected: inspect(me, { depth: null, showHidden: true }),
        })) {
          assert.ok(!text.includes(token), 'the token is in the ' + where + ': ' + text);
        }
      } finally {
        await fake.close();
      }
    }
  }
});

test('an answer that is not a login is unknown, whatever it is', async () => {
  const refused = [
    { login: '   ' },
    { login: 'not a login' },
    { login: '-leading-hyphen' },
    { login: 'trailing-hyphen-' },
    { login: 'a'.repeat(40) },
    { login: 'has/slash' },
    { login: 'has_underscore' },
    { login: '[bot]', type: 'Bot' },
    { slug: 'not a slug either' },
  ];
  for (const answer of refused) {
    const fake = await seeded({ identity: answer });
    try {
      const me = await clientFor(fake).whoAmI();
      assert.equal(me.known, false, JSON.stringify(answer) + ' was read as an identity');
      assert.notEqual(me.reason, '');
    } finally {
      await fake.close();
    }
  }
});

test('a login is cleaned the way every other derived string is', async () => {
  // Flattened, not rejected: what a terminal would obey rather than draw is
  // removed, and what is left is judged on its own.
  const fake = await seeded({ identity: { login: 'a-runner\u001b[31m', type: 'User' } });
  try {
    assert.deepEqual(await clientFor(fake).whoAmI(), {
      known: true,
      login: 'a-runner',
      kind: 'user',
    });
  } finally {
    await fake.close();
  }
});

test('F1: an unknown identity says whether asking again could answer differently', async () => {
  // The distinction the caller cannot make for itself. A run that must refuse
  // to write when GitHub *refused* to name its token must not refuse in the
  // same breath when GitHub merely *could not be asked* — that turns every
  // GitHub outage into a configuration error about a workflow file that is
  // perfectly correct.
  const refused = [
    {
      name: 'a GitHub App installation token',
      arrange: (fake) => fake.setIdentity(NO_IDENTITY),
      says: 'Resource not accessible by integration',
    },
    {
      name: 'a token GitHub rejected',
      arrange: (fake) =>
        fake.reply({
          method: 'GET',
          path: '/user',
          status: 401,
          body: { message: 'Bad credentials' },
        }),
      says: 'Bad credentials',
    },
    {
      name: 'an answer naming nobody',
      arrange: (fake) => fake.setIdentity({ id: 1, type: 'User' }),
      says: 'without a login',
    },
    {
      name: 'an answer that is not a login',
      arrange: (fake) => fake.setIdentity({ login: 'not a login' }),
      says: 'is not a login',
    },
    {
      name: 'a redirect off the configured host',
      arrange: (fake) =>
        fake.reply({
          method: 'GET',
          path: '/user',
          status: 302,
          headers: { location: 'https://evil.example/user' },
        }),
      says: 'refusing to send a GitHub request to another host',
    },
  ];

  const transient = [
    {
      name: 'a 500',
      arrange: (fake) =>
        fake.reply({
          method: 'GET',
          path: '/user',
          status: 500,
          body: { message: 'Server Error' },
        }),
      says: '(500)',
    },
    {
      name: 'a 503',
      arrange: (fake) =>
        fake.reply({
          method: 'GET',
          path: '/user',
          status: 503,
          body: { message: 'Service Unavailable' },
        }),
      says: '(503)',
    },
    {
      name: 'a rate limit',
      arrange: (fake) =>
        fake.reply({
          method: 'GET',
          path: '/user',
          status: 403,
          body: { message: 'API rate limit exceeded' },
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1786000000' },
        }),
      says: 'rate-limited',
    },
    {
      name: 'an answer that never comes',
      arrange: (fake) =>
        fake.reply({ method: 'GET', path: '/user', status: 200, body: {}, delayMs: 5_000 }),
      says: 'could not reach GitHub',
    },
  ];

  for (const [cause, cases] of [
    ['refused', refused],
    ['transient', transient],
  ]) {
    for (const one of cases) {
      const fake = await seeded();
      try {
        one.arrange(fake);
        const me = await clientFor(fake, { timeoutMs: 500 }).whoAmI();
        assert.equal(me.known, false, one.name + ' was read as a known identity');
        assert.equal(me.cause, cause, one.name + ' was classed wrong: ' + me.reason);
        assert.ok(me.reason.includes(one.says), one.name + ' said: ' + me.reason);
      } finally {
        await fake.close();
      }
    }
  }
});

test('F1: a host that cannot be reached at all is transient too', async () => {
  const origin = await deadOrigin();
  const client = createGitHubClient({
    token: FAKE_TOKEN,
    apiUrl: origin,
    env: {},
    timeoutMs: 500,
  });
  const me = await client.whoAmI();
  assert.deepEqual(
    { known: me.known, cause: me.cause },
    { known: false, cause: 'transient' },
    'nothing listening is not a fault in an invocation',
  );
});

test('a GitHub that cannot be reached leaves the identity unknown, once', async () => {
  const origin = await deadOrigin();
  const client = createGitHubClient({
    token: FAKE_TOKEN,
    apiUrl: origin,
    env: {},
    timeoutMs: 400,
  });
  const me = await client.whoAmI();
  assert.equal(me.known, false);
  assert.ok(me.reason.includes('could not reach GitHub to ask who this token is'), me.reason);
  assert.deepEqual(await client.whoAmI(), me, 'the unknown answer is remembered too');
});

test('C2: the identity call goes through the same host allowlist', async () => {
  const fake = await seeded();
  try {
    fake.reply({
      method: 'GET',
      path: '/user',
      status: 302,
      headers: { location: 'https://evil.example/user' },
    });
    const me = await clientFor(fake).whoAmI();
    assert.equal(me.known, false);
    assert.ok(
      me.reason.includes('refusing to send a GitHub request to another host'),
      me.reason,
    );
  } finally {
    await fake.close();
  }
});

/* -------------------------------------------------------------------------- */
/* C12: the token reaches none of it                                           */
/* -------------------------------------------------------------------------- */

/**
 * Every way a call through this module can fail.
 *
 * Each one is arranged so the server sends the token back inside its own
 * answer, which is the case a redaction that only trusted GitHub would miss.
 * The list is the point: the claim is not "the token stays out of this error",
 * it is "the token stays out of every error", so every kind is here and each is
 * driven over the socket.
 */
function everyErrorPath(token, disguise) {
  const echoed = 'the credentials ' + disguise(token) + ' were rejected';
  return [
    {
      name: 'a 401 that echoes the token',
      kind: 'auth',
      echoes: true,
      arrange: (fake) =>
        fake.reply({
          method: 'GET',
          path: '/repos/cli/cli',
          status: 401,
          body: { message: echoed },
        }),
      act: (client) => client.getRepo(REPO),
    },
    {
      name: 'a 403 that echoes the token',
      kind: 'auth',
      echoes: true,
      arrange: (fake) =>
        fake.reply({
          method: 'GET',
          path: '/repos/cli/cli/issues',
          status: 403,
          body: { message: echoed },
        }),
      act: (client) => client.listIssues(REPO),
    },
    {
      name: 'a rate limit that echoes the token',
      kind: 'rate-limit',
      echoes: true,
      arrange: (fake) =>
        fake.reply({
          method: 'GET',
          path: '/repos/cli/cli/issues',
          status: 403,
          body: { message: echoed },
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1786000000' },
        }),
      act: (client) => client.listIssues(REPO),
    },
    {
      name: 'a 404 that echoes the token',
      kind: 'not-found',
      echoes: true,
      arrange: (fake) =>
        fake.reply({
          method: 'GET',
          path: '/repos/cli/cli/issues/101',
          status: 404,
          body: { message: echoed },
        }),
      act: (client) => client.getIssue(REPO, 101),
    },
    {
      name: 'a 500 that echoes the token',
      kind: 'http',
      echoes: true,
      arrange: (fake) =>
        fake.reply({
          method: 'POST',
          path: '/repos/cli/cli/issues/101/comments',
          status: 500,
          body: { message: echoed },
        }),
      act: (client) => client.createComment(REPO, 101, 'a claim'),
    },
    {
      name: 'a 422 whose validation errors echo the token',
      kind: 'http',
      echoes: true,
      arrange: (fake) =>
        fake.reply({
          method: 'POST',
          path: '/repos/cli/cli/pulls',
          status: 422,
          body: { message: 'Validation Failed', errors: [{ message: echoed }] },
        }),
      act: (client) =>
        client.createPullRequest(REPO, { title: 't', head: 'h', base: 'trunk', body: '' }),
    },
    {
      name: 'a 500 on a pull request edit that echoes the token',
      kind: 'http',
      echoes: true,
      arrange: (fake) =>
        fake.reply({
          method: 'PATCH',
          path: '/repos/cli/cli/pulls/7',
          status: 500,
          body: { message: echoed },
        }),
      act: (client) => client.updatePullRequest(REPO, 7, { body: 'evidence' }),
    },
    {
      name: 'a body that is not JSON and echoes the token',
      kind: 'malformed',
      echoes: true,
      arrange: (fake) =>
        fake.reply({ method: 'GET', path: '/repos/cli/cli', status: 200, body: '<b>' + echoed }),
      act: (client) => client.getRepo(REPO),
    },
    {
      name: 'a listing that is not a list and echoes the token',
      kind: 'malformed',
      echoes: false,
      arrange: (fake) =>
        fake.reply({
          method: 'GET',
          path: '/repos/cli/cli/issues',
          status: 200,
          body: { message: echoed },
        }),
      act: (client) => client.listIssues(REPO),
    },
    {
      name: 'a redirect that carries the token to another host',
      kind: 'refused',
      echoes: true,
      arrange: (fake) =>
        fake.reply({
          method: 'GET',
          path: '/repos/cli/cli',
          status: 302,
          headers: { location: 'https://evil.example/collect?t=' + token },
        }),
      act: (client) => client.getRepo(REPO),
    },
    {
      name: 'a next page that carries the token to another host',
      kind: 'refused',
      echoes: true,
      arrange: (fake) =>
        fake.reply({
          method: 'GET',
          path: '/repos/cli/cli/issues',
          status: 200,
          body: [],
          headers: { link: '<https://evil.example/next?t=' + token + '>; rel="next"' },
        }),
      act: (client) => client.listIssues(REPO),
    },
    {
      name: 'an argument this module refuses',
      kind: 'refused',
      echoes: false,
      arrange: () => {},
      act: (client) => client.getIssue(REPO, 0),
    },
    {
      name: 'an answer too large to read',
      kind: 'malformed',
      echoes: false,
      arrange: (fake) =>
        fake.reply({
          method: 'GET',
          path: '/repos/cli/cli',
          status: 200,
          hang: true,
          headers: { 'content-length': String(17 * 1024 * 1024) },
        }),
      act: (client) => client.getRepo(REPO),
    },
    {
      name: 'an answer that never comes',
      kind: 'unreachable',
      echoes: false,
      arrange: (fake) =>
        fake.reply({ method: 'GET', path: '/repos/cli/cli', status: 200, body: {}, delayMs: 5_000 }),
      act: (client) => client.getRepo(REPO),
    },
    {
      name: 'nothing listening at all',
      kind: 'unreachable',
      echoes: false,
      arrange: () => {},
      act: (_client, dead) => dead.getRepo(REPO),
    },
  ];
}

/** Everywhere a thrown value can be read back out of. */
function renderings(error) {
  return {
    message: error.message,
    stack: error.stack ?? '',
    string: String(error),
    inspected: inspect(error, { depth: null, showHidden: true }),
    json: JSON.stringify(error) ?? '',
    spread: JSON.stringify({ ...error }),
  };
}

for (const token of [OPAQUE_TOKEN, FAKE_TOKEN]) {
  const shaped = token === FAKE_TOKEN ? 'a token shaped like GitHub’s' : 'an opaque token';

  for (const disguise of DISGUISES) {
  test('C12: ' + shaped + ', written ' + disguise.name + ', reaches no error this module raises', async () => {
    const fake = await seeded({ token });
    const dead = await startGitHubFake();
    const deadOrigin = dead.origin;
    await dead.close();
    try {
      const client = createGitHubClient({
        token,
        apiUrl: fake.origin,
        env: {},
        timeoutMs: 400,
      });
      const unreachable = createGitHubClient({
        token,
        apiUrl: deadOrigin,
        env: {},
        timeoutMs: 400,
      });

      for (const path of everyErrorPath(token, disguise.apply)) {
        path.arrange(fake, token);
        const error = await rejected(() => path.act(client, unreachable), path.name);
        assert.ok(error instanceof GitHubError, path.name + ' raised ' + error);
        assert.equal(error.kind, path.kind, path.name + ' was the wrong kind');
        assertHouseShape(error);

        for (const [where, text] of Object.entries(renderings(error))) {
          // Asked of the text as it is read, not as it is stored: a token in
          // fullwidth characters is absent from the second and present in the
          // first, and the first is the one on somebody's screen.
          assert.ok(
            !canonical(text).includes(token),
            'the token is in the ' + where + ' of ' + path.name + ': ' + text,
          );
        }
        if (path.echoes) {
          assert.ok(
            error.message.includes(REDACTED),
            path.name + ' echoed the token but nothing was redacted: ' + error.message,
          );
        }
      }

      // And the other half of the claim: the token was really being sent. An
      // error with no token in it proves nothing if no token ever left.
      assert.ok(
        fake.requests.some((request) => request.headers.authorization === 'Bearer ' + token),
        'no request carried the token, so keeping it out of the errors proved nothing',
      );
    } finally {
      await fake.close();
    }
  });
  }
}

/**
 * Every way the identity call can fail.
 *
 * It answers rather than raises, so the sweep above cannot cover it: what has
 * to be free of the token here is the `reason`, which a caller quotes in the
 * refusal it prints when a run has no identity it can prove.
 */
function everyIdentityFailure(token, disguise) {
  const echoed = 'the credentials ' + disguise(token) + ' were rejected';
  return [
    {
      name: 'a 401 that echoes the token',
      echoes: true,
      arrange: (fake) =>
        fake.reply({ method: 'GET', path: '/user', status: 401, body: { message: echoed } }),
    },
    {
      name: 'a 403 that echoes the token',
      echoes: true,
      arrange: (fake) =>
        fake.reply({ method: 'GET', path: '/user', status: 403, body: { message: echoed } }),
    },
    {
      name: 'a rate limit that echoes the token',
      echoes: true,
      arrange: (fake) =>
        fake.reply({
          method: 'GET',
          path: '/user',
          status: 403,
          body: { message: echoed },
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1786000000' },
        }),
    },
    {
      name: 'a body that is not JSON and echoes the token',
      echoes: false,
      arrange: (fake) =>
        fake.reply({ method: 'GET', path: '/user', status: 200, body: '<b>' + echoed }),
    },
    {
      name: 'a redirect carrying the token to another host',
      echoes: false,
      arrange: (fake) =>
        fake.reply({
          method: 'GET',
          path: '/user',
          status: 302,
          headers: { location: 'https://evil.example/collect?t=' + token },
        }),
    },
    {
      name: 'an answer that never comes',
      echoes: false,
      arrange: (fake) =>
        fake.reply({ method: 'GET', path: '/user', status: 200, body: {}, delayMs: 5_000 }),
    },
    { name: 'nothing listening at all', echoes: false, dead: true },
  ];
}

for (const token of [OPAQUE_TOKEN, FAKE_TOKEN]) {
  const shaped = token === FAKE_TOKEN ? 'a token shaped like GitHub’s' : 'an opaque token';

  for (const disguise of DISGUISES) {
  test('C12: ' + shaped + ', written ' + disguise.name + ', reaches no answer the identity call gives', async () => {
    const fake = await seeded({ token });
    const gone = await deadOrigin();
    try {
      for (const path of everyIdentityFailure(token, disguise.apply)) {
        if (path.arrange !== undefined) path.arrange(fake);
        // One client per failure, because the answer is remembered per client.
        const client = createGitHubClient({
          token,
          apiUrl: path.dead === true ? gone : fake.origin,
          env: {},
          timeoutMs: 400,
        });
        const me = await client.whoAmI();

        assert.equal(me.known, false, path.name + ' was read as a known identity');
        assert.notEqual(me.reason, '', path.name + ' gave an empty reason');
        assert.ok(
          me.cause === 'refused' || me.cause === 'transient',
          path.name + ' gave an unknown identity with no class on it',
        );
        for (const [where, text] of Object.entries({
          reason: me.reason,
          json: JSON.stringify(me),
        })) {
          assert.ok(
            !canonical(text).includes(token),
            'the token is in the ' + where + ' of ' + path.name + ': ' + text,
          );
        }
        if (path.echoes) {
          assert.ok(
            me.reason.includes(REDACTED),
            path.name + ' echoed the token but nothing was redacted: ' + me.reason,
          );
        }
      }

      assert.ok(
        fake.requests.some(
          (request) =>
            request.path === '/user' && request.headers.authorization === 'Bearer ' + token,
        ),
        'no identity request carried the token, so keeping it out of the answers proved nothing',
      );
    } finally {
      await fake.close();
    }
  });
  }
}

test('C12: editing a pull request puts the token nowhere but the Authorization header', async () => {
  for (const token of [OPAQUE_TOKEN, FAKE_TOKEN]) {
    const fake = await seeded({ token });
    try {
      fake.seedPull({ owner: 'cli', name: 'cli', number: 7, head: 'a-branch', base: 'trunk' });
      fake.clearRequests();
      await clientFor(fake).updatePullRequest(REPO, 7, {
        title: 'Fix the thing',
        body: 'Round 2 · WIN, WIN',
      });

      const sent = fake.lastRequest();
      assert.equal(
        sent.headers.authorization,
        'Bearer ' + token,
        'the edit was not authenticated, so keeping the token out of it proves nothing',
      );
      const elsewhere = Object.fromEntries(
        Object.entries(sent.headers).filter(([name]) => name !== 'authorization'),
      );
      for (const [where, text] of Object.entries({
        body: sent.body,
        path: sent.rawPath,
        url: sent.url,
        query: JSON.stringify(sent.query),
        'every other header': JSON.stringify(elsewhere),
      })) {
        assert.ok(!text.includes(token), 'the token is in the ' + where + ': ' + text);
      }
    } finally {
      await fake.close();
    }
  }
});

test('C12: a client carries no token into anything that serialises it', async () => {
  const fake = await seeded({ token: OPAQUE_TOKEN });
  try {
    const client = clientFor(fake);
    const written = {
      json: JSON.stringify(client),
      spread: JSON.stringify({ ...client }),
      inspected: inspect(client, { depth: null, showHidden: true }),
      keys: Object.getOwnPropertyNames(client).join(' '),
      values: JSON.stringify(Object.values(client).map(String)),
    };
    for (const [where, text] of Object.entries(written)) {
      assert.ok(!text.includes(OPAQUE_TOKEN), 'the token is in the client’s ' + where + ': ' + text);
    }
    assert.equal(client.apiUrl, fake.origin);
    assert.equal(client.tokenSource, 'given');
  } finally {
    await fake.close();
  }
});

test('C12: a secret typed in fullwidth characters is still a secret', () => {
  // `ｇｈｐ＿…` is what a terminal draws as `ghp_…` and what any normalising
  // round trip turns back into it. An ASCII pattern does not match it and an
  // equality test says it is a different string, so it used to survive verbatim
  // onto every surface that redacts through here.
  for (const token of [FAKE_TOKEN, OPAQUE_TOKEN]) {
    const typed = fullwidth(token);
    assert.equal(typed.normalize('NFKC'), token, 'the disguise is the token, normalised');
    assert.notEqual(typed, token, 'the disguise is not the token, compared as bytes');

    assert.equal(redactSecrets('title: ' + typed, token), 'title: ' + REDACTED);
    assert.equal(
      canonical(redactSecrets('title: ' + typed, token)).includes(token),
      false,
      'a remnant survived the round trip',
    );
  }
  // And by shape alone, with no secret named: the case of somebody else's token
  // pasted into an issue.
  assert.equal(redactSecrets('see ' + fullwidth(FAKE_TOKEN) + ' here'), 'see ' + REDACTED + ' here');
});

test('C12: a secret split by an invisible character is redacted whole', () => {
  // Half-redaction is the worst outcome of the three: it publishes the rest of
  // the token beside the marker that says the token was handled.
  const invisibles = {
    'a zero-width space': '\u200b',
    'a zero-width non-joiner': '\u200c',
    'a zero-width joiner': '\u200d',
    'a word joiner': '\u2060',
    'a soft hyphen': '\u00ad',
    'a byte-order mark': '\ufeff',
    'a right-to-left override': '\u202e',
  };
  for (const [what, character] of Object.entries(invisibles)) {
    const at = Math.floor(FAKE_TOKEN.length / 2);
    const split = FAKE_TOKEN.slice(0, at) + character + FAKE_TOKEN.slice(at);

    const byShape = redactSecrets('title: ' + split);
    const byValue = redactSecrets('title: ' + split, FAKE_TOKEN);
    for (const [how, out] of Object.entries({ 'by shape': byShape, 'by value': byValue })) {
      assert.equal(out, 'title: ' + REDACTED, split + ' through ' + what + ', ' + how);
      assert.equal(
        canonical(out).includes(FAKE_TOKEN),
        false,
        'a remnant survived ' + what + ', ' + how,
      );
      assert.equal(
        out.includes(FAKE_TOKEN.slice(at)),
        false,
        'the second half was published beside the marker for the first: ' + out,
      );
    }
  }
});

test('C12: redaction rewrites nothing it found no secret in', () => {
  // The other half of the requirement. Scanning happens over the text as a
  // reader sees it; replacing happens over the text as it was written. A
  // redactor that normalised what it returned would quietly rewrite every
  // fullwidth title, ligature and joined emoji in the repository on the way
  // past — and it would do it to strings containing no secret at all.
  const untouched = [
    'ｆｕｌｌｗｉｄｔｈ　ｔｉｔｌｅ',
    'the ﬁle is soft\u00adhyphenated',
    'an emoji family: \u{1f468}\u200d\u{1f469}\u200d\u{1f467}',
    'עברית \u202bwith a bidi mark\u202c',
    'ordinary ASCII with no secret in it',
    '',
  ];
  for (const text of untouched) {
    assert.equal(redactSecrets(text), text, 'rewrote ' + JSON.stringify(text));
    assert.equal(redactSecrets(text, FAKE_TOKEN), text, 'rewrote ' + JSON.stringify(text));
  }
});

test('C12: only the stretch the secret was found in is replaced', () => {
  const at = Math.floor(FAKE_TOKEN.length / 2);
  const split = FAKE_TOKEN.slice(0, at) + '\u200b' + FAKE_TOKEN.slice(at);

  // What sits around it survives exactly, including the fullwidth word.
  assert.equal(
    redactSecrets('ｔｉｔｌｅ ' + fullwidth(FAKE_TOKEN) + ' ｅｎｄ'),
    'ｔｉｔｌｅ ' + REDACTED + ' ｅｎｄ',
  );

  // An invisible *inside* the secret goes with it; one *after* it does not,
  // because the span ends where the last matched character ends.
  assert.equal(redactSecrets('a ' + split + ' b'), 'a ' + REDACTED + ' b');
  assert.equal(redactSecrets('a ' + FAKE_TOKEN + '\u200b b'), 'a ' + REDACTED + '\u200b b');

  // Two secrets, two markers, and the text between them untouched.
  assert.equal(
    redactSecrets(fullwidth(FAKE_TOKEN) + ' and ' + split),
    REDACTED + ' and ' + REDACTED,
  );
});

test('C12: redaction removes the secret by value and by shape', () => {
  const secret = 'opaque-token-value-9f3b21c4d5e6';
  assert.equal(redactSecrets('carrying ' + secret + '!', secret), 'carrying ' + REDACTED + '!');
  assert.equal(
    redactSecrets('two ' + secret + ' and ' + secret, secret),
    'two ' + REDACTED + ' and ' + REDACTED,
  );
  assert.equal(
    redactSecrets('ghp_0123456789abcdefghijklmnop is somebody else’s'),
    REDACTED + ' is somebody else’s',
  );
  assert.equal(
    redactSecrets('github_pat_11ABCDEFG0123456789_abcdefghijklmnop'),
    REDACTED,
  );
  assert.equal(redactSecrets('nothing to remove here'), 'nothing to remove here');
  assert.equal(
    redactSecrets('a token: ' + secret, 'ab'),
    'a token: ' + secret,
    'a secret too short to redact safely is not used as a search term',
  );
});

/* -------------------------------------------------------------------------- */
/* Repository names                                                            */
/* -------------------------------------------------------------------------- */

test('a repository is owner/name, and nothing else is one', () => {
  assert.equal(repoFault('cli/cli'), undefined);
  assert.equal(repoFault('some-owner/some.repo_name'), undefined);
  assert.deepEqual(parseRepo('cli/cli'), { owner: 'cli', name: 'cli' });
  assert.equal(repoSlug({ owner: 'cli', name: 'cli' }), 'cli/cli');

  const refused = [
    ['', 'it is empty'],
    ['   ', 'it is empty'],
    ['cli', 'it has no owner'],
    ['a/b/c', 'it has more than one slash'],
    ['/cli', 'the owner is empty'],
    ['cli/', 'the name is empty'],
    ['cli /cli', 'the owner has a character GitHub does not allow'],
    ['cli/..', 'the name is a path, not a repository'],
    ['cli/a b', 'the name has a character GitHub does not allow'],
    ['cli/cli ', 'it has whitespace around it'],
    ['c'.repeat(40) + '/cli', 'the owner is longer than 39 characters'],
    ['cli/' + 'c'.repeat(101), 'the name is longer than 100 characters'],
  ];
  for (const [value, reason] of refused) {
    assert.equal(repoFault(value), reason, value + ' was refused for the wrong reason');
    const error = thrown(() => parseRepo(value), value);
    assert.ok(error instanceof ConfigError, value + ' raised ' + error);
    assert.ok(error.message.includes(reason), error.message);
    assert.ok(error.message.includes('a repository is written owner/name'), error.message);
  }
});

test('C5: a repository name cannot climb out of the path it is put in', async () => {
  const fake = await seeded();
  try {
    const error = await rejected(
      () => clientFor(fake).getRepo({ owner: 'cli', name: '../../../etc' }),
      'a repository that is a path',
    );
    assert.equal(error.kind, 'not-found');
    assert.equal(
      fake.lastRequest().rawPath,
      '/repos/cli/..%2F..%2F..%2Fetc',
      'every segment is encoded, so the path stays the path that was built',
    );
  } finally {
    await fake.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Times                                                                       */
/* -------------------------------------------------------------------------- */

test('a reset time reads as UTC to the second, and as a wait', () => {
  const at = new Date(Date.UTC(2026, 7, 14, 18, 30, 0));
  assert.equal(isoSeconds(at), '2026-08-14T18:30:00Z');
  assert.equal(until(at, new Date(at.getTime() - 9_000)), '9s');
  assert.equal(until(at, new Date(at.getTime() - 852_000)), '14m 12s');
  assert.equal(until(at, new Date(at.getTime() - 7_500_000)), '2h 05m');
  assert.equal(until(at, new Date(at.getTime() + 1_000)), '0s');
});
