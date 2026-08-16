import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { ConfigError, EXIT, exitCodeFor } from '../dist/exit.js';
import { renderUsageError } from '../dist/usage.js';
import {
  BRANCH_NAMESPACE,
  COMMIT_IDENTITY,
  FORCE_TOKENS,
  GIT_COMMANDS,
  NETWORK_COMMANDS,
  VALUE_TYPES,
  assertCleanTree,
  assertRunnerBranch,
  branchChanges,
  branchNameFault,
  branchWriteRefusal,
  buildGitArgv,
  commitAll,
  commitMessageFault,
  currentBranch,
  ensureIssueBranch,
  issueBranchName,
  issueSlug,
  localBranchExists,
  matchesBranchPattern,
  mergeBaseRange,
  normalizeCommitMessage,
  parseDiffNames,
  parseIssueBranch,
  parseStatus,
  pushBranch,
  pushRefspec,
  redactSecrets,
  refSha,
  remoteUrls,
  repoRoot,
  workingTreeChanges,
} from '../dist/git.js';
import * as git_module from '../dist/git.js';
import { REDACTED } from '../dist/github.js';
import { PACKAGE_ROOT } from './run-cli.js';

/*
 * `src/git.ts`, against real git.
 *
 * Nothing in this file is faked. Every repository below is one `git init`
 * created in a temporary directory, every "remote" is a real bare repository
 * beside it, and every push is a real push that really moves a ref — a local
 * path is still a remote as far as git and this module are concerned, and it is
 * the only kind of remote a test may have, because a test that reached GitHub
 * would be measuring GitHub.
 *
 * The refusals are the point of the file: two of them are what C4 asks for in
 * so many words, and each one is checked twice — once for what it says, and
 * once for what the repository looks like afterwards. A refusal that printed
 * the right sentence and pushed anyway would pass the first check and fail the
 * second.
 */

/* -------------------------------------------------------------------------- */
/* A git that does not depend on this machine                                  */
/* -------------------------------------------------------------------------- */

/** The byte that ends an argument, and the byte git separates paths with. */
const NUL = String.fromCharCode(0);

/**
 * One secret of each shape, none of them real.
 *
 * Three, because each is disguised by a different part of the slug transform:
 * the classic token by lowercasing, the fine-grained one by its underscores
 * becoming hyphens, and the opaque installation token by its dot doing the
 * same. A rule that only ran after that transform would miss all three.
 */
const SECRETS = Object.freeze({
  classic: 'ghp_S3cretT0kenInTheTitle000000000000000',
  fineGrained: 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrs',
  opaque: 'v1.0123456789abcdef0123456789abcdef01234567',
});

/**
 * A string with every difference the namer could have introduced taken out.
 *
 * The leak this guards against is not the secret appearing verbatim — it is the
 * secret appearing *transformed*, lowercased and hyphenated into something no
 * search for the literal would ever find. Both sides are flattened to letters
 * and digits before they are compared, so a match means the characters are
 * there however they were rearranged.
 */
const flatten = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

/*
 * One directory, two spellings.
 *
 * Windows keeps a DOS 8.3 name for every path alongside the long one, and the
 * `TEMP` environment variable on a GitHub Actions runner carries the short
 * form: `C:\Users\RUNNER~1\AppData\Local\Temp`. Everything built from
 * `os.tmpdir()` inherits that spelling, while git answers with the long form it
 * reads off the filesystem — so a fixture path and the path git reports for the
 * very same directory compare unequal, and a test that means "the same
 * directory" fails on a difference that is not one.
 *
 * `realpathSync.native` is the filesystem's own answer to "what is this called":
 * it resolves the short form to the long one on Windows, and resolves symlinks
 * everywhere else, so it is the right canonical form on both. Both sides of a
 * path comparison go through it, and fixtures are made canonical the moment
 * they are created, so nothing downstream carries the short spelling at all.
 */

/** A path as the filesystem spells it, in the platform's own separators. */
function realPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    // A path that is not there has no canonical form, and a comparison against
    // one is a comparison of the strings — which is what it was before.
    return path;
  }
}

/** The same, in the one separator a comparison and a git argument both take. */
function canonical(path) {
  return realPath(path).replace(/\\/g, '/');
}

const TEMP = [];

function tempDir(prefix) {
  // Canonical from the start: the fixture is the long form even when TEMP is
  // not, so every path derived from it is already the name git will use.
  const dir = realPath(mkdtempSync(join(tmpdir(), prefix)));
  TEMP.push(dir);
  return dir;
}

after(() => {
  for (const dir of TEMP) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // A temporary directory that outlives the run is the operating system's
      // to clean up; it is not a test result.
    }
  }
});

/*
 * The developer's own git configuration is taken out of the picture: a machine
 * that signs every commit, or rewrites line endings, or has no `user.email` at
 * all, would otherwise decide what these tests measure. The identity left in
 * the config below is a human's on purpose — the module is supposed to override
 * it, and one of the tests is that it does.
 */
const GIT_HOME = tempDir('exolvra-git-home-');
const GIT_CONFIG = join(GIT_HOME, 'gitconfig');
writeFileSync(
  GIT_CONFIG,
  [
    '[user]',
    '\tname = A Human Being',
    '\temail = human@example.invalid',
    '[init]',
    '\tdefaultBranch = main',
    '[commit]',
    '\tgpgsign = false',
    '[core]',
    '\tautocrlf = false',
    '',
  ].join('\n'),
  'utf8',
);
process.env.GIT_CONFIG_GLOBAL = GIT_CONFIG;
process.env.GIT_CONFIG_SYSTEM = GIT_CONFIG;
process.env.GIT_CONFIG_NOSYSTEM = '1';

/*
 * And the fixtures are sealed off from whatever is above the temporary
 * directory. On a machine where somebody once ran `git init` in their home
 * directory — or in the system temp directory, which is where this one was —
 * a directory with no repository in it is still inside a repository, and the
 * test for "this is not a checkout" would silently stop testing anything.
 *
 * Canonical, like everything else: git compares this against the directory it
 * has resolved, so a ceiling spelled the short way would be a ceiling that
 * never matches and silently does nothing.
 */
process.env.GIT_CEILING_DIRECTORIES = canonical(tmpdir());

/**
 * The DOS 8.3 spelling of a directory, when the volume still keeps one.
 *
 * Asked of Windows itself rather than constructed, because the short name is
 * assigned by the filesystem — `SHORTN~1` versus `SHORTN~2` depends on what
 * else is in the directory, and a guess would prove nothing. Undefined anywhere
 * the question does not apply.
 */
function shortPathOf(path) {
  if (process.platform !== 'win32') return undefined;
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      // The path is one this file just created out of a fixed prefix and
      // mkdtemp's random letters, so there is nothing in it to quote around.
      '(New-Object -ComObject Scripting.FileSystemObject).GetFolder("' +
        path +
        '").ShortPath',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) return undefined;
  const short = (result.stdout ?? '').trim();
  return short === '' ? undefined : short;
}

/** Real git, for building and inspecting a fixture. Never the module's path. */
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.error, undefined, 'git could not be run: ' + result.error);
  assert.equal(
    result.status,
    0,
    'git ' + args.join(' ') + ' failed: ' + (result.stderr || result.stdout),
  );
  return result.stdout.trim();
}

function commitFixture(cwd, message) {
  git(cwd, ['add', '--all']);
  git(cwd, ['commit', '--quiet', '--message', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

/** A work tree with one commit and a real bare remote called `origin`. */
function makeRepo() {
  const root = tempDir('exolvra-git-');
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  mkdirSync(work);
  mkdirSync(remote);
  git(remote, ['init', '--bare', '--quiet']);
  git(work, ['init', '--quiet']);
  git(work, ['remote', 'add', 'origin', remote.replace(/\\/g, '/')]);
  writeFileSync(join(work, 'README.md'), '# fixture\n', 'utf8');
  const base = commitFixture(work, 'base');
  return { root, work, remote, base };
}

const REPO = Object.freeze({
  defaultBranch: 'main',
  protectedBranches: Object.freeze(['release/*']),
  repo: 'Evolvlabsai/Exolvra-Genesis',
});

function context(work, extra = {}) {
  return { cwd: work, repo: REPO, ...extra };
}

/** The refs a bare repository really holds, as `<sha> <ref>` lines. */
function remoteRefs(remote) {
  const text = git(remote, ['for-each-ref', '--format=%(objectname) %(refname)']);
  return text === '' ? [] : text.split('\n');
}

/** The one message a thrown refusal carries. */
function refusal(run) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ConfigError, 'expected a ConfigError, saw ' + error);
    return error.message;
  }
  assert.fail('expected a refusal, but nothing was thrown');
}

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                              */
/* -------------------------------------------------------------------------- */

/*
 * The allowlist below is written out here rather than derived from the module,
 * so that the test is a second opinion and not an echo. Adding a git subcommand
 * to `GIT_COMMANDS` fails this file until somebody writes it down here too, and
 * writing it down here is the moment a reviewer is asked whether the CLI should
 * be able to do that to a repository at all.
 */
const LOCAL_SUBCOMMANDS = [
  'rev-parse',
  'symbolic-ref',
  'status',
  'checkout',
  'add',
  'commit',
  'rev-list',
  'diff',
  'remote',
];
const NETWORK_SUBCOMMANDS = ['push'];

test('the vocabulary is the whole of what this module can run', () => {
  const entries = Object.entries(GIT_COMMANDS);
  assert.ok(entries.length > 0, 'the vocabulary must not be empty');

  for (const [name, template] of entries) {
    assert.ok(Array.isArray(template), name + ' must be an argument vector');
    assert.ok(template.length > 0, name + ' must name a git command');
    assert.ok(Object.isFrozen(template), name + ' must be frozen: it is a constant');

    const subcommand = template[0];
    const local = LOCAL_SUBCOMMANDS.includes(subcommand);
    const network = NETWORK_SUBCOMMANDS.includes(subcommand);
    assert.ok(
      local || network,
      name + ' runs "git ' + subcommand + '", which no one wrote down in this test',
    );
    assert.equal(
      network,
      NETWORK_COMMANDS.includes(name),
      name + ' disagrees with NETWORK_COMMANDS about whether it leaves the machine',
    );

    for (const element of template) {
      assert.ok(
        !FORCE_TOKENS.includes(element),
        name + ' carries the forbidden argument ' + element,
      );
      assert.ok(!element.startsWith('+'), name + ' carries a forced refspec: ' + element);
      // A hole takes one value or a list of them; either way it declares a type.
      if (/^<[a-z-]+(?:\.\.\.)?>$/.test(element)) {
        assert.equal(
          typeof VALUE_TYPES[element],
          'function',
          name + ' has a hole ' + element + ' with no declared value type',
        );
      }
    }
  }

  assert.deepEqual(
    NETWORK_COMMANDS.slice().sort(),
    ['push'],
    'exactly one entry may reach a remote',
  );

  // The two commands that touch the work tree take the same hole, so what one
  // is told to overlook is what the other is told not to stage. They are the
  // only two, and nothing else in the vocabulary is pointed at paths at all.
  const withPaths = Object.entries(GIT_COMMANDS)
    .filter(([, template]) => template.includes('<pathspec...>'))
    .map(([name]) => name);
  assert.deepEqual(withPaths.slice().sort(), ['changes', 'stageAll']);
  for (const name of withPaths) {
    const template = GIT_COMMANDS[name];
    assert.equal(
      template[template.length - 2],
      '--',
      name + ' must separate its pathspecs from its options',
    );
    assert.equal(template[template.length - 1], '<pathspec...>');
  }
});

test('every vocabulary entry builds with valid values, and only those', () => {
  const values = {
    '<branch>': 'exolvra-genesis/issue-12-fix-login',
    '<ref>': 'refs/heads/exolvra-genesis/issue-12-fix-login',
    '<range>': 'refs/heads/a..refs/remotes/origin/a',
    '<diff-range>': 'refs/heads/main...refs/heads/exolvra-genesis/issue-12-fix-login',
    '<refspec>': pushRefspec('exolvra-genesis/issue-12-fix-login'),
    '<message>': 'fix login\n\nthe body of the message',
    '<remote>': 'origin',
    '<pathspec...>': [':/', ':(exclude,top).exolvra-genesis'],
  };

  for (const [name, template] of Object.entries(GIT_COMMANDS)) {
    const supplied = {};
    for (const element of template) {
      if (Object.prototype.hasOwnProperty.call(values, element)) {
        supplied[element] = values[element];
      }
    }
    const argv = buildGitArgv(name, supplied);

    // Every element of the template becomes one element of the vector, except a
    // list hole, which becomes exactly as many as it was given — each of them
    // whole and alone, with nothing spliced into anything.
    const expected = template.flatMap((element) =>
      Object.prototype.hasOwnProperty.call(values, element)
        ? [values[element]].flat()
        : [element],
    );
    assert.deepEqual(argv, expected, name + ' did not fill as written');
  }
});

test('nothing outside the vocabulary can be spawned through this module', () => {
  const outside = [
    'fetch',
    'pull',
    'clone',
    'ls-remote',
    'reset',
    'clean',
    'rm',
    'config',
    'submodule',
    'filter-branch',
    'push --force',
    'push; rm -rf /',
    '',
    ' push',
    'PUSH',
    // Inherited properties are not entries: a lookup that walked the prototype
    // would answer for every one of these.
    '__proto__',
    'toString',
    'constructor',
    'hasOwnProperty',
  ];
  for (const name of outside) {
    const message = refusal(() => buildGitArgv(name, {}));
    assert.match(message, /not in this module's vocabulary/, 'for ' + JSON.stringify(name));
    assert.equal(exitCodeFor(new ConfigError(message)), EXIT.USAGE);
  }
});

test('a hole with no value, and a value with no hole, are both refused', () => {
  assert.match(
    refusal(() => buildGitArgv('createBranch', {})),
    /with a hole left open/,
  );
  assert.match(
    refusal(() => buildGitArgv('repoRoot', { '<branch>': 'exolvra-genesis/x' })),
    /an argument it has no hole for/,
  );
  assert.match(
    refusal(() =>
      buildGitArgv('stageAll', {
        '<pathspec...>': [':/'],
        '<branch>': 'exolvra-genesis/issue-1-a',
      }),
    ),
    /an argument it has no hole for/,
  );
});

test('every declared value type refuses what it must', () => {
  const hostile = {
    '<branch>': [
      '',
      '-f',
      '--force',
      '--upload-pack=touch pwned',
      'main branch',
      'exolvra-genesis/issue-1-a..b',
      'exolvra-genesis//issue-1-a',
      'exolvra-genesis/issue-1-a/',
      'exolvra-genesis/issue-1-a.lock',
      'exolvra-genesis/.hidden',
      'exolvra-genesis/issue-1-a\nrm -rf /',
      'a'.repeat(201),
    ],
    '<ref>': ['', '-f', 'refs/heads/a..b', 'refs heads a'],
    '<range>': ['a', 'a..b..c', '--force..b', 'a..-f'],
    // Two dots and three dots mean different things, so neither type takes the
    // other's spelling: a range that could be read either way is a range whose
    // meaning depends on where it was written.
    '<diff-range>': ['a', 'a..b', 'a...b...c', 'a....b', '--force...b', 'a...-f'],
    '<refspec>': [
      '+refs/heads/exolvra-genesis/issue-1-a:refs/heads/exolvra-genesis/issue-1-a',
      'refs/heads/exolvra-genesis/issue-1-a:refs/heads/exolvra-genesis/issue-1-b',
      'refs/heads/exolvra-genesis/issue-1-a',
      ':refs/heads/exolvra-genesis/issue-1-a',
      'refs/tags/a:refs/tags/a',
      'HEAD:refs/heads/exolvra-genesis/issue-1-a',
      // The payload the write-safety critic pushed a default branch with.
      'refs/heads/main:refs/heads/main',
      'refs/heads/release/2.x:refs/heads/release/2.x',
      // Inside the namespace, but not a branch this runner ever named.
      'refs/heads/exolvra-genesis/scratch:refs/heads/exolvra-genesis/scratch',
    ],
    '<message>': ['', '   \n\n  ', 'subject\n\nCo-authored-by: Someone <s@example.com>'],
    '<remote>': ['', 'or/igin', '-f', 'origin remote'],
    // A pathspec is git's own magic syntax, so the type is written over the
    // finished pathspec: a value that could introduce magic of its own is the
    // whole risk here.
    '<pathspec...>': [
      '',
      '.exolvra-genesis',
      ':(exclude).exolvra-genesis',
      ':(exclude,top)',
      ':(exclude,top)/etc/passwd',
      ':(exclude,top)../elsewhere',
      ':(exclude,top)a//b',
      ':(exclude,top)-f',
      ':(glob,exclude,top).exolvra-genesis',
      ':!.exolvra-genesis',
      ':',
      ':/etc',
    ],
  };

  for (const [placeholder, values] of Object.entries(hostile)) {
    const check = VALUE_TYPES[placeholder];
    assert.equal(typeof check, 'function', placeholder + ' has no declared type');
    for (const value of values) {
      assert.notEqual(
        check(value),
        undefined,
        placeholder + ' accepted ' + JSON.stringify(value),
      );
    }
  }

  // And the values each type exists to accept.
  assert.equal(VALUE_TYPES['<branch>']('exolvra-genesis/issue-12-fix-login'), undefined);
  assert.equal(VALUE_TYPES['<ref>']('refs/remotes/origin/main'), undefined);
  assert.equal(VALUE_TYPES['<range>']('refs/heads/a..refs/remotes/origin/a'), undefined);
  assert.equal(
    VALUE_TYPES['<diff-range>'](mergeBaseRange('main', 'exolvra-genesis/issue-1-a')),
    undefined,
  );
  assert.equal(
    VALUE_TYPES['<refspec>'](pushRefspec('exolvra-genesis/issue-12-fix-login')),
    undefined,
  );
  assert.equal(VALUE_TYPES['<message>']('fix login'), undefined);
  assert.equal(VALUE_TYPES['<remote>']('origin'), undefined);
  assert.equal(VALUE_TYPES['<pathspec...>'](':/'), undefined);
  assert.equal(VALUE_TYPES['<pathspec...>'](':(exclude,top).exolvra-genesis'), undefined);
  assert.equal(VALUE_TYPES['<pathspec...>'](':(exclude,top)a/b.c_d-e'), undefined);
});

test('a hole that takes a list refuses one value, and a hole that takes one refuses a list', () => {
  const paths = [':/', ':(exclude,top).exolvra-genesis'];
  assert.deepEqual(buildGitArgv('stageAll', { '<pathspec...>': paths }), [
    'add',
    '--all',
    '--',
    ...paths,
  ]);

  assert.match(
    refusal(() => buildGitArgv('stageAll', { '<pathspec...>': ':/' })),
    /<pathspec\.\.\.> takes a list of values/,
  );
  assert.match(
    refusal(() => buildGitArgv('stageAll', { '<pathspec...>': [] })),
    /a list of values with nothing in it is not an argument/,
  );
  assert.match(
    refusal(() => buildGitArgv('switchBranch', { '<branch>': ['exolvra-genesis/issue-1-a'] })),
    /<branch> takes one value/,
  );

  // Every item of the list is checked, not merely the first.
  assert.match(
    refusal(() =>
      buildGitArgv('stageAll', { '<pathspec...>': [':/', ':(exclude,top)../elsewhere'] }),
    ),
    /may not contain "\.\."/,
  );
});

test('a NUL byte ends an argument, so it is refused before the value type is asked', () => {
  const message = refusal(() =>
    buildGitArgv('commit', { '<message>': 'subject' + NUL + '--force' }),
  );
  assert.match(message, /NUL byte/);
  assert.notEqual(commitMessageFault('subject' + NUL), undefined);
});

test('the force sweep compares whole arguments, not substrings', () => {
  // Reachable because a commit message may legitimately be almost anything: it
  // is the one hole whose type would let a bare flag through, and the sweep is
  // what stops it.
  const message = refusal(() => buildGitArgv('commit', { '<message>': '--force' }));
  assert.match(message, /this module never forces/);

  // The same word inside a real message is a word.
  const argv = buildGitArgv('commit', { '<message>': 'say never to --force pushes\n' });
  assert.deepEqual(argv, [
    'commit',
    '--cleanup=verbatim',
    '--message',
    'say never to --force pushes\n',
  ]);
});

test('force is structurally absent: no vocabulary entry and no refspec can carry it', () => {
  for (const branch of ['exolvra-genesis/issue-1-a', 'exolvra-genesis/issue-99-x-y']) {
    const refspec = pushRefspec(branch);
    assert.equal(refspec, 'refs/heads/' + branch + ':refs/heads/' + branch);
    assert.ok(!refspec.startsWith('+'), 'a refspec built here is never forced');
    const argv = buildGitArgv('push', { '<remote>': 'origin', '<refspec>': refspec });
    assert.deepEqual(argv, ['push', '--set-upstream', 'origin', refspec]);
  }
  assert.match(
    refusal(() => pushRefspec('+refs/heads/a')),
    /branch name starts with a letter or a digit/,
  );
  assert.notEqual(VALUE_TYPES['<refspec>']('+refs/heads/a:refs/heads/a'), undefined);
});

/* -------------------------------------------------------------------------- */
/* Nothing exported reaches a push unguarded                                   */
/* -------------------------------------------------------------------------- */

/**
 * The public surface, written out.
 *
 * A list rather than a shape test, because the failure this is here to catch is
 * an *addition*: a helper that takes a command name and runs it was once
 * exported from this module, and a real push to a real default branch went
 * through it. Adding an export now fails this line, and the person adding it
 * has to say why it cannot be used that way.
 */
const PUBLIC_SURFACE = [
  'BRANCH_NAMESPACE',
  'COMMIT_IDENTITY',
  'DEFAULT_REMOTE',
  'DEFAULT_TIMEOUT_MS',
  'FORCE_TOKENS',
  'GIT_COMMANDS',
  'MAX_SLUG_LENGTH',
  'NETWORK_COMMANDS',
  'VALUE_TYPES',
  'assertCleanTree',
  'assertRunnerBranch',
  'branchChanges',
  'branchNameFault',
  'branchWriteRefusal',
  'buildGitArgv',
  'commitAll',
  'commitMessageFault',
  'currentBranch',
  'ensureIssueBranch',
  'issueBranchName',
  'issueSlug',
  'localBranchExists',
  'matchesBranchPattern',
  'mergeBaseRange',
  'normalizeCommitMessage',
  'parseDiffNames',
  'parseIssueBranch',
  'parseStatus',
  'pushBranch',
  'pushRefspec',
  'redactSecrets',
  'refSha',
  'remoteBranchExists',
  'remoteUrls',
  'repoRoot',
  'revRange',
  'workingTreeChanges',
];

test('the public surface is operations with meanings, never a git command line', () => {
  assert.deepEqual(Object.keys(git_module).slice().sort(), PUBLIC_SURFACE.slice().sort());
  for (const name of ['runGit', 'tryGit', 'spawnGit', 'gitEnv', 'assertNoForce']) {
    assert.equal(
      git_module[name],
      undefined,
      name + ' takes a command name or runs one; it must stay private',
    );
  }
});

test('C4: no exported symbol can push the default branch, the repro included', () => {
  const { work, remote } = makeRepo();
  const ctx = context(work);

  // A real default branch on a real remote, exactly as the repro had it.
  git(work, ['push', '--quiet', 'origin', 'main']);
  const before = git(remote, ['rev-parse', 'refs/heads/main']);
  writeFileSync(join(work, 'later.txt'), 'a commit the remote does not have\n', 'utf8');
  commitFixture(work, 'local work on main');
  assert.notEqual(git(work, ['rev-parse', 'HEAD']), before, 'there is something to push');

  // The repro's payload, refused by the value type wherever it is assembled.
  const payload = {
    '<remote>': 'origin',
    '<refspec>': 'refs/heads/main:refs/heads/main',
  };
  assert.match(
    refusal(() => buildGitArgv('push', payload)),
    /a push here names one of this runner's own branches/,
  );

  // And the whole public surface, driven with it and with everything else that
  // might carry a branch, in a repository where a push would show.
  const attempts = [
    [ctx, 'push', payload],
    [ctx, 'push', { '<remote>': 'origin', '<refspec>': '+refs/heads/main:refs/heads/main' }],
    [ctx, 'main'],
    [ctx, 'refs/heads/main:refs/heads/main'],
    [ctx, { number: 1, title: 'x' }],
    [ctx],
    ['push', payload],
    [REPO, 'main', 'push'],
    ['main'],
    [],
  ];

  let called = 0;
  for (const [name, value] of Object.entries(git_module)) {
    if (typeof value !== 'function') continue;
    for (const args of attempts) {
      called += 1;
      try {
        value(...args);
      } catch {
        // Refusing is the expected outcome for nearly all of these; what is
        // being measured is the remote, below, not which of them threw.
      }
    }
  }
  assert.ok(called > 0, 'the walk must actually call something');

  assert.equal(
    git(remote, ['rev-parse', 'refs/heads/main']),
    before,
    'the default branch on the remote never moved',
  );
  assert.deepEqual(remoteRefs(remote), [before + ' refs/heads/main'], 'and nothing else was written');
});

/* -------------------------------------------------------------------------- */
/* The one spawn                                                               */
/* -------------------------------------------------------------------------- */

const SOURCE = readFileSync(join(PACKAGE_ROOT, 'src', 'git.ts'), 'utf8');

function occurrences(pattern) {
  return (SOURCE.match(pattern) ?? []).length;
}

test('there is one spawn, it takes an argument array, and no shell is involved', () => {
  assert.equal(
    occurrences(/from 'node:child_process'/g),
    1,
    'child_process is imported once',
  );
  assert.match(SOURCE, /import \{ spawnSync \} from 'node:child_process';/);
  assert.equal(occurrences(/\bspawnSync\(/g), 1, 'exactly one process is ever started');
  assert.match(
    SOURCE,
    /const argv = buildGitArgv\(name, values\);/,
    'the vector handed to git comes from the vocabulary',
  );
  assert.match(SOURCE, /spawnSync\('git', argv, \{/, 'git is spawned with that vector');
  assert.match(SOURCE, /shell: false/, 'no shell interprets any of it');

  for (const banned of [
    /\bshell: true\b/,
    /\bexecSync\b/,
    /\bexecFileSync\b/,
    /\bexecFile\b/,
    /\bexec\(/,
    /\bspawn\(/,
    /\bfork\(/,
  ]) {
    assert.ok(!banned.test(SOURCE), 'src/git.ts must not use ' + banned);
  }

  // One producer of argument vectors: the definition and the single call.
  assert.equal(
    occurrences(/buildGitArgv\(/g),
    2,
    'buildGitArgv is defined once and called once',
  );
});

/* -------------------------------------------------------------------------- */
/* Names                                                                       */
/* -------------------------------------------------------------------------- */

test('a branch name is the issue number and a slug of its title', () => {
  assert.equal(
    issueBranchName(12, 'Fix login'),
    'exolvra-genesis/issue-12-fix-login',
  );
  assert.equal(issueSlug('Fix   the   Login!!'), 'fix-the-login');
  assert.equal(issueSlug('  --leading and trailing--  '), 'leading-and-trailing');
  assert.equal(issueSlug('Café résumé'), 'cafe-resume');
  assert.equal(issueSlug('CVE-2026-1234: heap overflow'), 'cve-2026-1234-heap-overflow');

  // A title this rule cannot spell has no slug, and the branch says so by not
  // having one — rather than by calling every such issue the same invented word.
  assert.equal(issueSlug('ドキュメントの日本語見出しを直す'), '');
  assert.equal(issueSlug('修复登录错误'), '');
  assert.equal(issueSlug('🔥🔥🔥'), '');
  assert.equal(issueBranchName(3, '🔥'), 'exolvra-genesis/issue-3');
  assert.equal(
    issueBranchName(12, 'ドキュメントの日本語見出しを直す'),
    'exolvra-genesis/issue-12',
  );
  for (const branch of ['untitled', 'Untitled', 'UNTITLED']) {
    assert.ok(
      !issueBranchName(12, 'ドキュメントの日本語見出しを直す').includes(branch),
      'no placeholder word stands in for a title',
    );
  }

  // A title that is partly spellable keeps the part that is.
  assert.equal(issueSlug('日本語の README を直す'), 'readme');

  // Long titles are clipped at a word boundary and stay inside the limit.
  const long = issueSlug(
    'Make the interactive startup flow remember the last model that was chosen',
  );
  assert.ok(long.length <= 48, 'slug is clipped: ' + long);
  assert.equal(long, 'make-the-interactive-startup-flow-remember-the');

  // One long word has no boundary to cut at, and is cut anyway.
  assert.equal(issueSlug('a'.repeat(80)), 'a'.repeat(48));

  // Whatever comes out is a name the rest of this CLI would also accept.
  for (const title of ['Fix login', '🔥', 'a'.repeat(80), '"; rm -rf / #']) {
    assert.equal(branchNameFault(issueBranchName(1, title)), undefined);
  }
});

test('a title with no slug in it still gets a unique branch this module will push', () => {
  const titles = [
    'ドキュメントの日本語見出しを直す',
    '修复登录错误',
    'الإصلاح',
    '🔥🔥🔥',
  ];
  const names = new Set();
  for (const [index, title] of titles.entries()) {
    const number = index + 1;
    const branch = issueBranchName(number, title);

    assert.equal(branch, 'exolvra-genesis/issue-' + number);
    assert.equal(branchNameFault(branch), undefined, branch + ' is a valid branch name');
    assert.equal(
      branchWriteRefusal(REPO, branch),
      undefined,
      branch + ' must pass this module\'s own write guard',
    );
    assert.equal(
      pushRefspec(branch),
      'refs/heads/' + branch + ':refs/heads/' + branch,
      'and must survive the refspec type the push is built from',
    );
    assert.deepEqual(parseIssueBranch(branch), { number, slug: '' });
    names.add(branch);
  }
  assert.equal(names.size, titles.length, 'one branch per issue, all different');

  // Two issues whose titles are equally unspellable are still two branches.
  assert.notEqual(issueBranchName(12, '日本語'), issueBranchName(13, '日本語'));
});

test('C12: a secret in an issue title never reaches the branch name', () => {
  for (const [shape, secret] of Object.entries(SECRETS)) {
    const branch = issueBranchName(96, 'Rotate ' + secret + ' now');

    // The whole point: the slug is built from the title with the secret already
    // gone, so the rest of the title still reads.
    assert.equal(branch, 'exolvra-genesis/issue-96-rotate-now', shape);
    assert.ok(!branch.includes(secret), shape + ' survived verbatim: ' + branch);

    // And in any casing or hyphenation the transform could have disguised it
    // as. Every eight characters of the secret is looked for in the branch,
    // both sides reduced to letters and digits.
    const flatBranch = flatten(branch);
    const flatSecret = flatten(secret);
    assert.ok(
      !flatBranch.includes(flatSecret),
      shape + ' survived a fold: ' + branch,
    );
    for (let at = 0; at + 8 <= flatSecret.length; at += 1) {
      const window = flatSecret.slice(at, at + 8);
      assert.ok(
        !flatBranch.includes(window),
        shape + ' left "' + window + '" in ' + branch,
      );
    }

    // A title that is nothing but a secret has nothing left to name it by,
    // which is the slug-less shape rather than a word standing in for one.
    const bare = issueBranchName(96, secret);
    assert.equal(bare, 'exolvra-genesis/issue-96', shape + ' alone: ' + bare);
    assert.equal(issueSlug(secret), '');
    assert.deepEqual(parseIssueBranch(bare), { number: 96, slug: '' });
  }

  // The disguises the transform would otherwise apply, spelled out: a token
  // decomposed out of fullwidth characters is a token by the time redaction
  // looks, and one inside a URL goes with the credential.
  const wide = SECRETS.classic.replace(/[A-Za-z0-9_]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) + 0xfee0),
  );
  assert.notEqual(wide, SECRETS.classic);
  assert.ok(
    !flatten(issueBranchName(97, 'Rotate ' + wide + ' now')).includes(
      flatten(SECRETS.classic),
    ),
    'a fullwidth token is normalised before it is redacted, not after',
  );
  assert.equal(
    issueBranchName(98, 'Clone https://x-access-token:' + SECRETS.classic + '@github.com/o/n'),
    'exolvra-genesis/issue-98-clone-https-github-com-o-n',
  );

  // The marker itself is not smuggled into the name as a word.
  for (const word of ['redacted', 'untitled']) {
    assert.ok(!issueBranchName(96, 'Rotate ' + SECRETS.classic + ' now').includes(word));
  }
});

test('an issue number is a whole number above zero', () => {
  for (const number of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
    assert.match(
      refusal(() => issueBranchName(number, 'x')),
      /whole number above zero/,
      'accepted ' + number,
    );
  }
});

test('a branch name says which issue it belongs to', () => {
  assert.deepEqual(parseIssueBranch('exolvra-genesis/issue-12-fix-login'), {
    number: 12,
    slug: 'fix-login',
  });
  assert.deepEqual(parseIssueBranch('exolvra-genesis/issue-12'), { number: 12, slug: '' });
  for (const branch of [
    'main',
    'exolvra-genesis/issue-0-x',
    'exolvra-genesis/issue-0',
    'exolvra-genesis/issue-',
    'exolvra-genesis/issue-12-',
    'exolvra-genesis/issue-x',
    'exolvra-genesis/scratch',
    'feature/exolvra-genesis/issue-12-x',
  ]) {
    assert.equal(parseIssueBranch(branch), undefined, branch + ' names no issue');
  }

  // Every name the namer can produce is read back by the parser, slug included.
  for (const [number, title] of [
    [1, 'Fix login'],
    [4096, '🔥'],
    [7, 'a'.repeat(80)],
    [12, 'ドキュメントの日本語見出しを直す'],
    [13, 'CVE-2026-1234: heap overflow'],
    [14, 'Café résumé'],
    [15, '"; rm -rf / #'],
    [16, '日本語の README を直す'],
    [17, 'Rotate ' + SECRETS.classic + ' now'],
    [18, SECRETS.fineGrained],
    [19, 'Revoke ' + SECRETS.opaque],
    [999999, ''],
  ]) {
    const branch = issueBranchName(number, title);
    assert.deepEqual(
      parseIssueBranch(branch),
      { number, slug: issueSlug(title) },
      branch + ' did not round-trip',
    );
  }
});

/* -------------------------------------------------------------------------- */
/* The write guard, on its own                                                 */
/* -------------------------------------------------------------------------- */

test("branch patterns read the way GitHub's do", () => {
  assert.ok(matchesBranchPattern('release/*', 'release/2.x'));
  assert.ok(!matchesBranchPattern('release/*', 'release/2/x'), '* stops at a separator');
  assert.ok(matchesBranchPattern('release/**', 'release/2/x'), '** crosses separators');
  assert.ok(matchesBranchPattern('v?.x', 'v2.x'));
  assert.ok(!matchesBranchPattern('v?.x', 'v22.x'));
  assert.ok(matchesBranchPattern('main', 'MAIN'), 'capitals are not a way past this');
  assert.ok(!matchesBranchPattern('main', 'maintenance'), 'a plain name matches itself');
  assert.ok(matchesBranchPattern('**', 'anything/at/all'));
  // The pattern is data, not a regular expression somebody may inject.
  assert.ok(!matchesBranchPattern('a.c', 'abc'));
  assert.ok(matchesBranchPattern('a.c', 'a.c'));
});

test('the guard refuses the default branch, a protected one, and anything foreign', () => {
  assert.deepEqual(branchWriteRefusal(REPO, 'main'), [
    'it is the default branch of Evolvlabsai/Exolvra-Genesis',
  ]);
  assert.deepEqual(branchWriteRefusal(REPO, 'MAIN'), [
    'it is the default branch of Evolvlabsai/Exolvra-Genesis',
  ]);
  assert.deepEqual(branchWriteRefusal(REPO, 'release/2.x'), [
    'it is protected by the pattern "release/*" of Evolvlabsai/Exolvra-Genesis',
  ]);
  assert.deepEqual(branchWriteRefusal(REPO, 'someone-elses-work'), [
    'it is outside exolvra-genesis/, so this runner did not create it',
  ]);
  assert.deepEqual(branchWriteRefusal(REPO, 'exolvra-genesis/scratch'), [
    'it is inside exolvra-genesis/ but is not an issue branch: ' +
      'exolvra-genesis/issue-<number>-<slug>',
  ]);
  assert.equal(branchWriteRefusal(REPO, 'exolvra-genesis/issue-12-fix-login'), undefined);
  assert.equal(
    branchWriteRefusal(REPO, 'exolvra-genesis/issue-12'),
    undefined,
    'a branch for a title with no slug in it is still an issue branch',
  );

  // A repository that protects this runner's own namespace is a repository it
  // cannot work in, and it says so instead of finding out at the push.
  const walled = { defaultBranch: 'main', protectedBranches: ['exolvra-genesis/*'] };
  assert.deepEqual(branchWriteRefusal(walled, 'exolvra-genesis/issue-12-x'), [
    'it is protected by the pattern "exolvra-genesis/*" of this repository',
  ]);
});

test('a refusal carries the house error shape and the usage exit code', () => {
  const message = refusal(() => assertRunnerBranch(REPO, 'main', 'push'));
  const lines = message.split('\n');
  assert.equal(lines[0], 'refusing to push the branch "main"');
  for (const line of lines.slice(1)) {
    assert.match(line, /^ {2}\S/, 'every detail line is indented under the complaint');
  }
  assert.equal(exitCodeFor(new ConfigError(message)), EXIT.USAGE);

  // Rendered the way the CLI prints it: the complaint, the indented detail,
  // and no usage line — nothing the reader could retype would change this.
  assert.equal(renderUsageError(message), message + '\n\n');
  assert.ok(!renderUsageError(message).includes('Usage:'));
});

/* -------------------------------------------------------------------------- */
/* Against a real repository                                                   */
/* -------------------------------------------------------------------------- */

test('a path is compared as a directory, not as whichever name it was reached by', () => {
  const dir = tempDir('exolvra-shortpath-');

  // True wherever this runs: canonicalising settles in one step, a trailing
  // separator is not a different directory, and a fixture is already canonical.
  assert.equal(canonical(dir), canonical(canonical(dir)));
  assert.equal(canonical(dir + '/'), canonical(dir));
  assert.equal(canonical(dir), dir.replace(/\\/g, '/'));

  const short = shortPathOf(dir);
  if (short === undefined || short === dir) {
    // Not Windows, or a volume with 8.3 names switched off: there is no second
    // spelling here to prove anything with, and the identities above are what
    // there is to check. The comparison is still the canonical one everywhere.
    return;
  }

  // The failure a Windows CI runner sees, in miniature: TEMP carries the short
  // form, git answers with the long one, and the two strings are not equal.
  assert.notEqual(short.replace(/\\/g, '/'), dir.replace(/\\/g, '/'));
  assert.match(short, /~\d/, 'the short form is really an 8.3 name: ' + short);

  // And what this file does about it.
  assert.equal(canonical(short), canonical(dir));

  // Including the path a fixture actually is: a directory under the one whose
  // name was short, which is the shape every repository here has.
  mkdirSync(join(dir, 'work'), { recursive: true });
  assert.equal(canonical(join(short, 'work')), canonical(join(dir, 'work')));
});

test('a branch is created, the tree is committed, and the branch is pushed', () => {
  const { work, remote } = makeRepo();
  const ctx = context(work);

  // Compared as directories, not as strings: git answers with the long form of
  // a path whatever spelling the fixture was built from.
  assert.equal(canonical(repoRoot(ctx)), canonical(work));
  assert.equal(currentBranch(ctx), 'main');

  const branch = ensureIssueBranch(ctx, { number: 12, title: 'Fix login' });
  assert.deepEqual(branch, {
    branch: 'exolvra-genesis/issue-12-fix-login',
    state: 'created',
    base: 'main',
  });
  assert.equal(currentBranch(ctx), branch.branch);

  writeFileSync(join(work, 'login.js'), 'export const login = () => true;\n', 'utf8');
  const commit = commitAll(ctx, 'Fix login\n\nCloses #12.\n');
  assert.equal(commit.committed, true);
  assert.equal(commit.branch, branch.branch);
  assert.match(commit.sha, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    commit.changes.map((change) => change.path),
    ['login.js'],
  );
  assert.deepEqual(workingTreeChanges(ctx), [], 'the tree is clean after the commit');

  const push = pushBranch(ctx, branch.branch);
  assert.equal(push.branch, branch.branch);
  assert.equal(push.remote, 'origin');

  // The ref really moved, in the real bare repository.
  assert.deepEqual(remoteRefs(remote), [
    commit.sha + ' refs/heads/' + branch.branch,
  ]);
  assert.equal(git(remote, ['rev-parse', 'refs/heads/' + branch.branch]), commit.sha);
  assert.equal(
    git(work, ['rev-parse', '--abbrev-ref', branch.branch + '@{upstream}']),
    'origin/' + branch.branch,
    'the push set the upstream, so a later round knows where the branch went',
  );
});

test('the commit is by the runner, and it claims no other author', () => {
  const { work } = makeRepo();
  const ctx = context(work);

  // The fixture's own commit was made under the configured human identity.
  assert.equal(git(work, ['log', '-1', '--format=%an']), 'A Human Being');

  ensureIssueBranch(ctx, { number: 5, title: 'Neutral authorship' });
  writeFileSync(join(work, 'a.txt'), 'a\n', 'utf8');
  commitAll(ctx, '# Neutral authorship\n\nThe body keeps its markdown heading.\n');

  const fields = git(work, ['log', '-1', '--format=%an%n%ae%n%cn%n%ce']).split('\n');
  assert.deepEqual(fields, [
    COMMIT_IDENTITY.name,
    COMMIT_IDENTITY.email,
    COMMIT_IDENTITY.name,
    COMMIT_IDENTITY.email,
  ]);

  const body = git(work, ['log', '-1', '--format=%B']);
  assert.match(body, /^# Neutral authorship/, 'a markdown heading survives verbatim');
  assert.ok(!/co-authored-by/i.test(body), 'no co-author trailer');
  assert.ok(!/claude|generated with|🤖/i.test(body), 'no machine attribution trailer');
});

test('a message that claims a second author is refused before anything is staged', () => {
  const { work } = makeRepo();
  const ctx = context(work);
  ensureIssueBranch(ctx, { number: 6, title: 'Trailers' });
  writeFileSync(join(work, 'a.txt'), 'a\n', 'utf8');

  const message = refusal(() =>
    commitAll(ctx, 'Fix login\n\nCo-Authored-By: Someone <s@example.com>\n'),
  );
  assert.match(message, /no Co-authored-by trailer/);
  assert.equal(git(work, ['rev-list', '--count', 'HEAD']), '1', 'nothing was committed');
  assert.deepEqual(
    workingTreeChanges(ctx).map((change) => change.path),
    ['a.txt'],
    'and nothing was staged either',
  );

  // The same words in the body of a message are prose, not a trailer.
  assert.equal(
    commitMessageFault('Explain that Co-authored-by: is a trailer\n\nSo it is.\n'),
    undefined,
  );
  assert.equal(normalizeCommitMessage('subject\r\n\r\n\r\n\r\nbody   \n'), 'subject\n\nbody\n');
});

test('an unclean starting point is refused, and it names what is in the way', () => {
  const { work } = makeRepo();
  const ctx = context(work);
  writeFileSync(join(work, 'left-behind.txt'), 'stray\n', 'utf8');
  writeFileSync(join(work, 'README.md'), '# edited\n', 'utf8');

  const message = refusal(() => ensureIssueBranch(ctx, { number: 12, title: 'Fix login' }));
  assert.equal(
    message,
    [
      'refusing to start on a work tree with uncommitted changes',
      // git's own porcelain column, kept as git writes it.
      '   M README.md',
      '  ?? left-behind.txt',
      '  commit or stash them, then run again',
    ].join('\n'),
  );
  assert.equal(currentBranch(ctx), 'main', 'no branch was created');
  assert.equal(
    localBranchExists(ctx, 'exolvra-genesis/issue-12-fix-login'),
    false,
  );

  assert.match(
    refusal(() => assertCleanTree(ctx)),
    /commit or stash them/,
  );
});

/*
 * The runner keeps its state inside the checkout it is working in. A fresh
 * adopter's repository does not gitignore that directory — every fixture in
 * this file used to, which is exactly why a whole suite missed the bug — so the
 * two sides below are tested in a repository with no `.gitignore` at all.
 */
const STATE_DIR = '.exolvra-genesis';

/** Writes a runner state directory into `work`, the way a real pass does. */
function writeRunState(work) {
  mkdirSync(join(work, STATE_DIR, 'runs', 'r-1'), { recursive: true });
  mkdirSync(join(work, STATE_DIR, 'bar'), { recursive: true });
  writeFileSync(join(work, STATE_DIR, 'state.json'), '{"status":"running"}\n', 'utf8');
  writeFileSync(join(work, STATE_DIR, 'runs', 'r-1', 'issue.md'), '# issue\n', 'utf8');
  writeFileSync(join(work, STATE_DIR, 'bar', 'BAR.md'), '# bar\n', 'utf8');
}

test('the runner\'s own state directory does not make the work tree unclean', () => {
  const { work } = makeRepo();
  assert.equal(existsSync(join(work, '.gitignore')), false, 'no gitignore, as adopters have');
  writeRunState(work);

  // Without the exclusion this is what the live smoke pass hit: the runner's
  // own bookkeeping counted as somebody else's uncommitted work.
  const blind = context(work);
  assert.deepEqual(
    workingTreeChanges(blind).map((change) => change.path).sort(),
    [
      '.exolvra-genesis/bar/BAR.md',
      '.exolvra-genesis/runs/r-1/issue.md',
      '.exolvra-genesis/state.json',
    ],
  );
  assert.match(
    refusal(() => ensureIssueBranch(blind, { number: 1, title: 'Blocked by its own state' })),
    /^refusing to start on a work tree with uncommitted changes/,
  );

  // With it, the same tree is clean and the run starts.
  const ctx = context(work, { ignorePaths: [STATE_DIR] });
  assert.deepEqual(workingTreeChanges(ctx), []);
  assert.equal(assertCleanTree(ctx), undefined);
  assert.deepEqual(ensureIssueBranch(ctx, { number: 1, title: 'Fix login' }), {
    branch: 'exolvra-genesis/issue-1-fix-login',
    state: 'created',
    base: 'main',
  });
});

test('what the clean check overlooks, the commit never stages', () => {
  const { work, remote } = makeRepo();
  const ctx = context(work, { ignorePaths: [STATE_DIR] });
  const branch = ensureIssueBranch(ctx, { number: 2, title: 'Real work' }).branch;

  // A round: the builders change the repository, and the runner writes its own
  // state beside them, in the same tree, at the same time.
  writeRunState(work);
  writeFileSync(join(work, 'login.js'), 'export const login = () => true;\n', 'utf8');
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(join(work, 'src', 'deep.js'), 'export const deep = 1;\n', 'utf8');

  const commit = commitAll(ctx, 'work for issue 2');
  assert.equal(commit.committed, true);
  assert.deepEqual(
    commit.changes.map((change) => change.path).sort(),
    ['login.js', 'src/deep.js'],
    'the change set names the work and not the bookkeeping',
  );

  // What the commit really contains, read back out of git rather than claimed.
  const tracked = git(work, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').sort();
  assert.deepEqual(tracked, ['README.md', 'login.js', 'src/deep.js']);
  for (const path of tracked) {
    assert.ok(!path.startsWith(STATE_DIR), path + ' reached the commit');
  }
  assert.equal(
    git(work, ['ls-files', '--', STATE_DIR]),
    '',
    'not one byte under the state directory is tracked',
  );

  // And it is still sitting there, untracked, for the next round to use.
  assert.equal(existsSync(join(work, STATE_DIR, 'state.json')), true);
  assert.deepEqual(workingTreeChanges(ctx), [], 'the tree is clean again');

  // Through the push, onto a real remote: the ref carries the work only.
  pushBranch(ctx, branch);
  assert.deepEqual(remoteRefs(remote), [commit.sha + ' refs/heads/' + branch]);
  assert.deepEqual(
    git(remote, ['ls-tree', '-r', '--name-only', 'refs/heads/' + branch])
      .split('\n')
      .sort(),
    ['README.md', 'login.js', 'src/deep.js'],
  );
});

test('a genuinely dirty tree still refuses, naming what is in the way and nothing else', () => {
  const { work } = makeRepo();
  const ctx = context(work, { ignorePaths: [STATE_DIR] });
  writeRunState(work);
  writeFileSync(join(work, 'left-behind.txt'), 'stray\n', 'utf8');
  writeFileSync(join(work, 'README.md'), '# edited\n', 'utf8');

  const message = refusal(() => ensureIssueBranch(ctx, { number: 3, title: 'Fix login' }));
  assert.equal(
    message,
    [
      'refusing to start on a work tree with uncommitted changes',
      '   M README.md',
      '  ?? left-behind.txt',
      '  commit or stash them, then run again',
    ].join('\n'),
  );
  assert.ok(!message.includes(STATE_DIR), 'the excluded path is not named as a problem');
  assert.equal(currentBranch(ctx), 'main', 'and no branch was created');
});

test('a path to leave alone is repository-relative, and refused when it is not', () => {
  const { work } = makeRepo();
  writeRunState(work);

  for (const path of ['', '../elsewhere', '/etc', 'a/../b', 'a//b', '-f', ':(exclude)x']) {
    assert.match(
      refusal(() => workingTreeChanges(context(work, { ignorePaths: [path] }))),
      /refusing to leave ".*" alone/,
      'accepted ' + JSON.stringify(path),
    );
  }

  // A Windows caller builds paths with backslashes; those are separators here.
  assert.deepEqual(
    workingTreeChanges(context(work, { ignorePaths: ['.exolvra-genesis\\'] })),
    [],
  );
  assert.deepEqual(
    workingTreeChanges(context(work, { ignorePaths: ['.exolvra-genesis/runs'] })).map(
      (change) => change.path,
    ).sort(),
    ['.exolvra-genesis/bar/BAR.md', '.exolvra-genesis/state.json'],
    'and an exclusion is only as wide as it is written',
  );
});

test('an exclusion means the same thing from anywhere in the work tree', () => {
  const { work } = makeRepo();
  writeRunState(work);
  mkdirSync(join(work, 'sub', 'deeper'), { recursive: true });
  writeFileSync(join(work, 'sub', 'deeper', 'a.txt'), 'a\n', 'utf8');

  // `ctx.cwd` is any directory inside the checkout, so a pathspec read relative
  // to it would exclude a different directory depending on where the runner was
  // started — and would stop seeing the rest of the repository at all.
  const fromRoot = workingTreeChanges(context(work, { ignorePaths: [STATE_DIR] }));
  const fromDeep = workingTreeChanges(
    context(join(work, 'sub', 'deeper'), { ignorePaths: [STATE_DIR] }),
  );
  assert.deepEqual(fromRoot.map((change) => change.path), ['sub/deeper/a.txt']);
  assert.deepEqual(fromDeep, fromRoot);
});

test('C4: pushing the default branch is refused, and the remote stays empty', () => {
  const { work, remote } = makeRepo();
  const ctx = context(work);

  const message = refusal(() => pushBranch(ctx, 'main'));
  assert.equal(
    message,
    [
      'refusing to push the branch "main"',
      '  it is the default branch of Evolvlabsai/Exolvra-Genesis',
      '  this runner writes one exolvra-genesis/issue-<number>-<slug> branch',
      '  per issue and never forces a push; everything else is a pull request',
    ].join('\n'),
  );
  assert.deepEqual(remoteRefs(remote), [], 'nothing reached the remote');
});

test('C4: pushing a protected branch is refused, and the remote stays empty', () => {
  const { work, remote } = makeRepo();
  const ctx = context(work);
  git(work, ['checkout', '--quiet', '-b', 'release/2.x']);

  const message = refusal(() => pushBranch(ctx, 'release/2.x'));
  assert.equal(
    message,
    [
      'refusing to push the branch "release/2.x"',
      '  it is protected by the pattern "release/*" of Evolvlabsai/Exolvra-Genesis',
      '  this runner writes one exolvra-genesis/issue-<number>-<slug> branch',
      '  per issue and never forces a push; everything else is a pull request',
    ].join('\n'),
  );
  assert.deepEqual(remoteRefs(remote), []);

  // And a branch nothing protects, that this runner simply did not make.
  git(work, ['checkout', '--quiet', '-b', 'someone-elses-work']);
  assert.match(
    refusal(() => pushBranch(ctx, 'someone-elses-work')),
    /it is outside exolvra-genesis\/, so this runner did not create it/,
  );
  assert.deepEqual(remoteRefs(remote), []);
});

test('C4: the guard is in front of the commit as well as the push', () => {
  const { work } = makeRepo();
  const ctx = context(work);
  writeFileSync(join(work, 'a.txt'), 'a\n', 'utf8');

  assert.match(
    refusal(() => commitAll(ctx, 'onto the default branch')),
    /^refusing to commit on the branch "main"/,
  );
  assert.equal(git(work, ['rev-list', '--count', 'HEAD']), '1');

  git(work, ['checkout', '--quiet', '-b', 'release/2.x']);
  assert.match(
    refusal(() => commitAll(ctx, 'onto a protected branch')),
    /it is protected by the pattern "release\/\*"/,
  );
  assert.equal(git(work, ['rev-list', '--count', 'HEAD']), '1');
});

test('a branch that is already there is reused, never duplicated', () => {
  const { work } = makeRepo();
  const ctx = context(work);
  const issue = { number: 12, title: 'Fix login' };

  const first = ensureIssueBranch(ctx, issue);
  assert.equal(first.state, 'created');
  writeFileSync(join(work, 'login.js'), 'a\n', 'utf8');
  const commit = commitAll(ctx, 'first round');
  git(work, ['checkout', '--quiet', 'main']);

  const second = ensureIssueBranch(ctx, issue);
  assert.deepEqual(second, { branch: first.branch, state: 'reused' });
  assert.equal(currentBranch(ctx), first.branch);
  assert.equal(git(work, ['rev-parse', 'HEAD']), commit.sha, 'the work is still there');
  assert.deepEqual(
    git(work, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n'),
    ['exolvra-genesis/issue-12-fix-login', 'main'],
    'no second branch was invented for the same issue',
  );
});

test('a ref under the namespace that is an alias for another branch is not reused', () => {
  const { work } = makeRepo();
  const ctx = context(work);
  const issue = { number: 30, title: 'Symbolic' };
  const branch = issueBranchName(issue.number, issue.title);

  // A branch that is not a branch: a symbolic ref onto the default one.
  // Checking it out lands HEAD on main, so a run that trusted the ref's name
  // would believe it was on the issue branch while standing on main.
  git(work, ['symbolic-ref', 'refs/heads/' + branch, 'refs/heads/main']);
  assert.equal(localBranchExists(ctx, branch), true, 'git says the ref resolves');

  const message = refusal(() => ensureIssueBranch(ctx, issue));
  assert.equal(
    message,
    [
      'refusing to reuse the branch "' + branch + '"',
      '  it is not a branch: it is a symbolic ref pointing at refs/heads/main',
      '  checking it out would land this run on refs/heads/main under the issue' +
        " branch's name",
      '  delete or repoint the ref, then run again',
    ].join('\n'),
  );
  assert.equal(currentBranch(ctx), 'main', 'and it was refused before any checkout');

  // The commit guard is the last line of defence, not the only one; with the
  // ref repointed at a commit of its own, the same call works.
  git(work, ['symbolic-ref', '--delete', 'refs/heads/' + branch]);
  git(work, ['branch', branch, 'main']);
  assert.deepEqual(ensureIssueBranch(ctx, issue), { branch, state: 'reused' });
  assert.equal(currentBranch(ctx), branch);
});

test('a branch that diverged from its remote is never reconciled silently', () => {
  const { root, work, remote } = makeRepo();
  const ctx = context(work);
  const issue = { number: 12, title: 'Fix login' };

  const branch = ensureIssueBranch(ctx, issue).branch;
  writeFileSync(join(work, 'login.js'), 'ours\n', 'utf8');
  commitAll(ctx, 'our round');
  pushBranch(ctx, branch);

  // Somebody else moves the branch on the remote: a maintainer's commit, a
  // second runner, a rebase — the module cannot tell, and does not have to.
  const other = join(root, 'other');
  git(root, ['clone', '--quiet', remote.replace(/\\/g, '/'), other]);
  git(other, ['checkout', '--quiet', branch]);
  writeFileSync(join(other, 'login.js'), 'theirs\n', 'utf8');
  const theirs = commitFixture(other, 'their round');
  git(other, ['push', '--quiet', 'origin', branch]);

  git(work, ['fetch', '--quiet', 'origin']);
  writeFileSync(join(work, 'more.js'), 'ours again\n', 'utf8');
  commitAll(ctx, 'our second round');

  const message = refusal(() => ensureIssueBranch(ctx, issue));
  assert.match(message, /^refusing to reuse the branch "exolvra-genesis\/issue-12-fix-login"/);
  assert.match(message, /origin\/exolvra-genesis\/issue-12-fix-login has 1 commit this/);
  assert.match(message, /nothing here merges, rebases, or forces a push/);

  // And the push that would have been the tempting way out fails, because
  // there is no force to fall back on: the remote still holds their commit.
  const rejected = refusal(() => pushBranch(ctx, branch));
  assert.match(rejected, /^could not push "exolvra-genesis\/issue-12-fix-login" to origin/);
  assert.match(rejected, /the push is never retried with force/);
  assert.equal(git(remote, ['rev-parse', 'refs/heads/' + branch]), theirs);
});

test('a hostile issue title becomes one branch name and nothing else', () => {
  const { work, remote } = makeRepo();
  const ctx = context(work);
  const title = '"; touch pwned; git push --force origin main #`whoami`$(id)';

  const branch = issueBranchName(66, title);
  assert.equal(
    branch,
    'exolvra-genesis/issue-66-touch-pwned-git-push-force-origin-main-whoami-id',
    'every metacharacter is dropped, not escaped',
  );

  // The whole flow, for real, on that title.
  assert.deepEqual(ensureIssueBranch(ctx, { number: 66, title }), {
    branch,
    state: 'created',
    base: 'main',
  });
  writeFileSync(join(work, 'safe.txt'), 'safe\n', 'utf8');
  const commit = commitAll(ctx, 'work for issue 66');
  pushBranch(ctx, branch);

  assert.deepEqual(remoteRefs(remote), [commit.sha + ' refs/heads/' + branch]);
  assert.equal(existsSync(join(work, 'pwned')), false, 'nothing ran a second command');
  assert.equal(existsSync(join(remote, 'pwned')), false);
  assert.deepEqual(
    workingTreeChanges(ctx),
    [],
    'and no stray file was left in the tree',
  );

  // The argument vector is where the safety lives: one element, entire.
  const argv = buildGitArgv('createBranch', { '<branch>': branch });
  assert.deepEqual(argv, ['checkout', '-b', branch]);
  assert.ok(!argv.some((element) => element.includes(';') || element.includes('$')));
});

test('C12: the ref pushed to the remote carries no part of a secret', () => {
  const { work, remote } = makeRepo();
  const ctx = context(work);

  const expected = [];
  for (const [index, secret] of Object.values(SECRETS).entries()) {
    const number = 96 + index;
    const branch = ensureIssueBranch(ctx, {
      number,
      title: 'Rotate ' + secret + ' now',
    }).branch;
    writeFileSync(join(work, 'rotate-' + number + '.txt'), 'done\n', 'utf8');
    const commit = commitAll(ctx, 'work for issue ' + number);
    pushBranch(ctx, branch);
    expected.push(commit.sha + ' refs/heads/' + branch);
    git(work, ['checkout', '--quiet', 'main']);
  }

  // The remote is the surface that outlives the run: whatever is written here
  // is public to everyone with read access, forever.
  const refs = remoteRefs(remote);
  assert.deepEqual(refs.slice().sort(), expected.slice().sort());

  const flatRefs = flatten(refs.join(' '));
  for (const [shape, secret] of Object.entries(SECRETS)) {
    const flatSecret = flatten(secret);
    assert.ok(!flatRefs.includes(flatSecret), shape + ' reached the remote');
    for (let at = 0; at + 8 <= flatSecret.length; at += 1) {
      assert.ok(
        !flatRefs.includes(flatSecret.slice(at, at + 8)),
        shape + ' left "' + flatSecret.slice(at, at + 8) + '" on the remote: ' + refs,
      );
    }
  }
});

test('git status is read NUL-separated, so a path is a path', () => {
  const { work } = makeRepo();
  const ctx = context(work);
  ensureIssueBranch(ctx, { number: 7, title: 'Renames and accents' });

  writeFileSync(join(work, 'café.txt'), 'accented\n', 'utf8');
  writeFileSync(join(work, 'old.txt'), 'content that stays the same\n', 'utf8');
  commitAll(ctx, 'add files');

  git(work, ['mv', 'old.txt', 'new.txt']);
  writeFileSync(join(work, 'café.txt'), 'edited\n', 'utf8');

  const changes = workingTreeChanges(ctx);
  const renamed = changes.find((change) => change.path === 'new.txt');
  assert.ok(renamed !== undefined, 'the rename is reported: ' + JSON.stringify(changes));
  assert.match(renamed.status, /^R/);
  assert.equal(renamed.from, 'old.txt');
  assert.ok(
    changes.some((change) => change.path === 'café.txt'),
    'the accented path is not escaped: ' + JSON.stringify(changes),
  );

  // The parser, on its own, over the shape git writes.
  const porcelain = ['R  new.txt', 'old.txt', ' M a.txt', '?? b.txt'].join(NUL) + NUL;
  assert.deepEqual(parseStatus(porcelain), [
    { status: 'R ', path: 'new.txt', from: 'old.txt' },
    { status: ' M', path: 'a.txt' },
    { status: '??', path: 'b.txt' },
  ]);
  assert.deepEqual(parseStatus(''), []);
});

test('the change set is what the merge proposes, not what the last round left', () => {
  const { work } = makeRepo();
  const ctx = context(work);

  // A base with something on it to modify, rename and delete.
  writeFileSync(join(work, 'keep.txt'), 'one\n', 'utf8');
  writeFileSync(join(work, 'old.txt'), 'renamed later\n', 'utf8');
  writeFileSync(join(work, 'base-only.txt'), 'deleted later\n', 'utf8');
  commitFixture(work, 'base content');

  const branch = ensureIssueBranch(ctx, { number: 40, title: 'Two rounds' }).branch;

  // Round one, and the run that made it ends here.
  writeFileSync(join(work, 'added.txt'), 'first round\n', 'utf8');
  const first = commitAll(ctx, 'first round');
  assert.deepEqual(
    first.changes.map((change) => change.path),
    ['added.txt'],
  );

  // A maintainer sends it back; a second run stacks a second commit.
  writeFileSync(join(work, 'keep.txt'), 'one\ntwo\n', 'utf8');
  git(work, ['mv', 'old.txt', 'new.txt']);
  rmSync(join(work, 'base-only.txt'));
  const second = commitAll(ctx, 'second round');
  assert.ok(
    !second.changes.some((change) => change.path === 'added.txt'),
    'the second run never saw the first run\'s file: ' + JSON.stringify(second.changes),
  );

  // And the default branch moved on while all that was happening.
  git(work, ['checkout', '--quiet', 'main']);
  writeFileSync(join(work, 'on-main.txt'), 'somebody else merged this\n', 'utf8');
  commitFixture(work, 'main moved on');
  git(work, ['checkout', '--quiet', branch]);

  const changes = branchChanges(ctx, 'main', branch)
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(changes, [
    { status: 'A', path: 'added.txt' },
    { status: 'D', path: 'base-only.txt' },
    { status: 'M', path: 'keep.txt' },
    { status: 'R100', path: 'new.txt', from: 'old.txt' },
  ]);

  // Both rounds are in it, which is the whole reason it is not read off one
  // run's working tree.
  assert.ok(changes.some((change) => change.path === 'added.txt'));
  assert.ok(changes.some((change) => change.path === 'new.txt'));

  // And the base's own new file is not in it. It would be, spelled with two
  // dots: git really does report it as a deletion, so the three-dot range is a
  // decision rather than a formality.
  assert.equal(mergeBaseRange('main', branch), 'main...' + branch);
  assert.ok(
    !changes.some((change) => change.path === 'on-main.txt'),
    'a file the base gained is not something this branch changed',
  );
  assert.match(
    git(work, ['diff', '--name-status', 'main..' + branch]),
    /^D\ton-main\.txt$/m,
    'the two-dot spelling is what the three-dot one is avoiding',
  );
});

test('a ref resolves to its commit, and to nothing when there is no such ref', () => {
  const { work } = makeRepo();
  const ctx = context(work);
  const branch = ensureIssueBranch(ctx, { number: 41, title: 'Head sha' }).branch;
  writeFileSync(join(work, 'a.txt'), 'a\n', 'utf8');
  const commit = commitAll(ctx, 'work for issue 41');

  assert.equal(refSha(ctx, 'refs/heads/' + branch), commit.sha);
  assert.equal(refSha(ctx, branch), commit.sha);
  assert.equal(refSha(ctx, 'HEAD'), commit.sha);
  assert.match(refSha(ctx, 'main'), /^[0-9a-f]{40}$/);
  assert.notEqual(refSha(ctx, 'main'), commit.sha);

  // A ref that is not there is an answer, not a fault.
  assert.equal(refSha(ctx, 'refs/heads/exolvra-genesis/issue-999-nowhere'), undefined);
  assert.equal(refSha(ctx, 'refs/remotes/origin/main'), undefined);

  // A ref name this module would not run is a mistake in the caller.
  assert.match(
    refusal(() => refSha(ctx, '--force')),
    /branch name starts with a letter or a digit/,
  );
});

test('a diff names its renames the other way round from git status', () => {
  // `git diff --name-status -z` writes the source first and the destination
  // second; porcelain writes the destination first. Both land in `path` as the
  // destination, so a caller never has to know which command it came from.
  const diff = ['R100', 'old.txt', 'new.txt', 'M', 'keep.txt', 'A', 'added.txt'];
  assert.deepEqual(parseDiffNames(diff.join(NUL) + NUL), [
    { status: 'R100', path: 'new.txt', from: 'old.txt' },
    { status: 'M', path: 'keep.txt' },
    { status: 'A', path: 'added.txt' },
  ]);
  assert.deepEqual(parseDiffNames(''), []);
  // A truncated record is dropped rather than half-read.
  assert.deepEqual(parseDiffNames(['M'].join(NUL)), []);
  assert.deepEqual(parseDiffNames(['R100', 'old.txt'].join(NUL) + NUL), [
    { status: 'R100', path: 'old.txt' },
  ]);
});

test('a tree with nothing in it is not an empty commit', () => {
  const { work } = makeRepo();
  const ctx = context(work);
  const branch = ensureIssueBranch(ctx, { number: 8, title: 'Nothing changed' }).branch;

  const result = commitAll(ctx, 'a round that changed nothing');
  assert.deepEqual(result, { branch, committed: false, changes: [] });
  assert.equal(git(work, ['rev-list', '--count', 'HEAD']), '1');
});

test('a credential never leaves this module in a string', () => {
  // The token shapes are the network module's, so this module cannot drift out
  // of agreement with the rest of the CLI about what a secret looks like.
  assert.equal(
    redactSecrets('remote: rejected, token ' + SECRETS.classic + ' is read-only'),
    'remote: rejected, token ' + REDACTED + ' is read-only',
  );
  assert.equal(redactSecrets(SECRETS.fineGrained + ' expired'), REDACTED + ' expired');
  assert.equal(redactSecrets('use ' + SECRETS.opaque), 'use ' + REDACTED);

  // And the shape only this module produces: the credential in a remote's URL,
  // which is any password at all and matches no token pattern.
  assert.equal(
    redactSecrets('https://x-access-token:' + SECRETS.classic + '@github.com/o/n.git'),
    'https://' + REDACTED + '@github.com/o/n.git',
  );
  assert.equal(
    redactSecrets('https://someone:hunter2@github.com/o/n.git'),
    'https://' + REDACTED + '@github.com/o/n.git',
  );
  assert.equal(redactSecrets('https://github.com/o/n.git'), 'https://github.com/o/n.git');
  assert.equal(redactSecrets('write to bob@example.com'), 'write to bob@example.com');

  // Through the real path: a remote configured with a credential in its URL,
  // read back by the module.
  const { work } = makeRepo();
  const ctx = context(work);
  git(work, [
    'remote',
    'set-url',
    'origin',
    'https://x-access-token:' +
      SECRETS.classic +
      '@github.com/Evolvlabsai/Exolvra-Genesis.git',
  ]);
  assert.deepEqual(remoteUrls(ctx), {
    fetch: 'https://' + REDACTED + '@github.com/Evolvlabsai/Exolvra-Genesis.git',
    push: 'https://' + REDACTED + '@github.com/Evolvlabsai/Exolvra-Genesis.git',
  });
});

test('a result names the URL the push used, not the one the remote reads from', () => {
  const { work, remote } = makeRepo();
  const ctx = context(work);

  // A remote that writes somewhere other than it reads: git's own `pushurl`.
  const elsewhere = join(work, '..', 'elsewhere.git');
  mkdirSync(elsewhere, { recursive: true });
  git(elsewhere, ['init', '--bare', '--quiet']);
  git(work, ['remote', 'set-url', '--push', 'origin', elsewhere.replace(/\\/g, '/')]);

  const urls = remoteUrls(ctx);
  assert.equal(canonical(urls.fetch), canonical(remote));
  assert.equal(canonical(urls.push), canonical(elsewhere));
  assert.notEqual(canonical(urls.fetch), canonical(urls.push));

  const branch = ensureIssueBranch(ctx, { number: 21, title: 'Push URL' }).branch;
  writeFileSync(join(work, 'a.txt'), 'a\n', 'utf8');
  const commit = commitAll(ctx, 'work for issue 21');
  const push = pushBranch(ctx, branch);

  assert.equal(
    canonical(push.url),
    canonical(elsewhere),
    'the result names where the commits really went',
  );
  assert.deepEqual(remoteRefs(elsewhere), [commit.sha + ' refs/heads/' + branch]);
  assert.deepEqual(remoteRefs(remote), [], 'and the fetch URL was never written to');
});

test('the module says plainly when the environment is not what it needs', () => {
  const outside = tempDir('exolvra-not-a-repo-');
  assert.match(
    refusal(() => repoRoot(context(outside))),
    /^not a git repository:/,
  );

  const { work } = makeRepo();
  const ctx = context(work);
  git(work, ['checkout', '--quiet', '--detach', 'HEAD']);
  assert.equal(currentBranch(ctx), undefined);
  assert.match(
    refusal(() => ensureIssueBranch(ctx, { number: 9, title: 'Detached' })),
    /refusing to branch from a detached HEAD/,
  );
  writeFileSync(join(work, 'a.txt'), 'a\n', 'utf8');
  assert.match(
    refusal(() => commitAll(ctx, 'on nothing')),
    /refusing to commit on a detached HEAD/,
  );

  const noRemote = makeRepo();
  const bare = context(noRemote.work);
  git(noRemote.work, ['remote', 'remove', 'origin']);
  ensureIssueBranch(bare, { number: 10, title: 'No remote' });
  writeFileSync(join(noRemote.work, 'a.txt'), 'a\n', 'utf8');
  commitAll(bare, 'work');
  const message = refusal(() =>
    pushBranch(bare, BRANCH_NAMESPACE + 'issue-10-no-remote'),
  );
  assert.match(message, /^no remote called "origin" in this repository/);
  assert.match(message, /never adds or repoints a remote/);

  assert.match(
    refusal(() => pushBranch(bare, BRANCH_NAMESPACE + 'issue-404-never-made')),
    /refusing to push a branch that is not here/,
  );
});

test('a bad remote name or time limit is refused before git is reached', () => {
  const { work } = makeRepo();
  assert.match(
    refusal(() =>
      pushBranch(context(work, { remote: 'or/igin' }), 'exolvra-genesis/issue-1-x'),
    ),
    /refusing to use the remote "or\/igin"/,
  );
  assert.match(
    refusal(() => repoRoot(context(work, { timeoutMs: 0 }))),
    /not a number of milliseconds above zero/,
  );
});
