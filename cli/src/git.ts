/**
 * Local git writes: the one place this CLI touches a work tree or a remote.
 *
 * Everything the issue runner does to a repository — the branch, the commit,
 * the push — happens through here, and nothing here is advice. The rules that
 * matter are mechanisms:
 *
 * - **A fixed vocabulary.** {@link GIT_COMMANDS} is the complete list of git
 *   invocations this module can make. Every one is a literal argument vector
 *   with named holes; `buildGitArgv` is the only function that fills them, and
 *   the one spawn in this file is handed its output. Nothing exported takes a
 *   command name — the functions that do are private — so what a caller can ask
 *   for is an operation with a meaning, never a git command line, and no string
 *   arriving from an issue can reach a subcommand that is not on that list.
 * - **No shell, ever.** git is spawned with an argument array. A value is
 *   substituted as one whole element or not at all, so a hostile issue title
 *   becomes one long branch-shaped argument and never a second command.
 * - **Force is absent, not forbidden.** No parameter of any exported function
 *   produces a forced update. The one push entry pushes a plain
 *   `refs/heads/x:refs/heads/x` refspec, {@link pushRefspec} refuses the
 *   leading `+` that would make it forced, and {@link FORCE_TOKENS} is swept
 *   over the finished vector as the second lock on the same door.
 * - **The branch is checked in front of the spawn, not at the call sites.** The
 *   caller asks GitHub what the default branch is and which patterns are
 *   protected, hands the answer over as a {@link RepoGuard}, and
 *   {@link assertRunnerBranch} refuses to commit on or push to anything that
 *   matches — or to anything outside {@link BRANCH_NAMESPACE}, which is every
 *   branch this module did not create. The push guard sits inside the private
 *   function that starts the process, so it is not a step a future caller can
 *   forget to take.
 * - **A secret is removed before it can be disguised.** A branch name is
 *   published in more places than anything else here — the pushed ref, the
 *   pull request body, the sticky comment, the run record, the terminal — and
 *   it is built by lowercasing an issue title and replacing its punctuation,
 *   which is exactly the transform that turns a token nobody would miss into
 *   one no pattern matches. {@link issueSlug} therefore redacts *first*, before
 *   a character of the title has been changed (C12).
 *
 * Subagents never call any of this. A builder edits files; the runner is what
 * commits them, and the reason the safety rules live in code rather than in a
 * prompt is that a prompt can be talked out of them.
 */
import { spawnSync } from 'node:child_process';

import { ConfigError } from './exit.js';
import { REDACTED, redactSecrets as redactTokens } from './github.js';
import { newGoalNameFault } from './goals.js';

/* -------------------------------------------------------------------------- */
/* Identity, namespace, limits                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Who the commits are by.
 *
 * Fixed rather than configurable, and neutral rather than clever: a commit this
 * runner writes says the runner wrote it, in one name that reads the same in
 * every repository it works in. Nothing composes a trailer — no co-author line,
 * no generated-by line — because the author field already says everything true
 * about who made the commit, and {@link commitMessageFault} refuses a message
 * that tries to say more.
 */
export const COMMIT_IDENTITY = Object.freeze({
  name: 'Exolvra Genesis',
  email: 'exolvra-genesis@users.noreply.github.com',
});

/** The one prefix every branch this module creates or pushes lives under. */
export const BRANCH_NAMESPACE = 'exolvra-genesis/';

/** The remote pushed to when the caller names none. */
export const DEFAULT_REMOTE = 'origin';

/** How long any one git invocation may take before it is killed. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Longest the slug part of a branch name may be. */
export const MAX_SLUG_LENGTH = 48;

/** Longest branch name this module will build or accept. */
const MAX_BRANCH_LENGTH = 200;

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every git invocation this module can make.
 *
 * Data, not code, and deliberately short: a reader can check the whole of what
 * this CLI is able to do to a repository by reading thirteen lines. A `<name>`
 * element is a hole {@link buildGitArgv} fills with one caller value, and every
 * hole names a type in {@link VALUE_TYPES} that says what may go in it — the
 * same rule the command line already lives under, applied to git.
 *
 * `push` is the only entry that leaves the machine. Nothing here clones, pulls,
 * or lists a remote's refs, so a repository's own configured remote is the only
 * place any of this can reach, and only to add commits to one branch.
 */
export const GIT_COMMANDS = Object.freeze({
  /** Absolute path of the work tree root; also the proof that `cwd` is in one. */
  repoRoot: Object.freeze(['rev-parse', '--show-toplevel']),
  /** The branch HEAD points at; non-zero and silent when HEAD is detached. */
  headBranch: Object.freeze(['symbolic-ref', '--quiet', '--short', 'HEAD']),
  /** What a ref is an alias for; non-zero when it is an ordinary branch. */
  resolveSymref: Object.freeze(['symbolic-ref', '--quiet', '<ref>']),
  /** Resolves a ref, or exits non-zero without a word when there is none. */
  verifyRef: Object.freeze(['rev-parse', '--verify', '--quiet', '<ref>']),
  /** Everything the work tree has that HEAD does not, NUL-separated. */
  changes: Object.freeze(['status', '--porcelain', '--untracked-files=all', '-z']),
  /** Starts the issue branch at the current HEAD. */
  createBranch: Object.freeze(['checkout', '-b', '<branch>']),
  /** Moves onto a branch that already exists. */
  switchBranch: Object.freeze(['checkout', '<branch>']),
  /** Stages the whole work tree, ignored files excluded as git excludes them. */
  stageAll: Object.freeze(['add', '--all']),
  /** Commits what is staged, with the message exactly as it was composed. */
  commit: Object.freeze(['commit', '--cleanup=verbatim', '--message', '<message>']),
  /** How many commits one end of a range has that the other does not. */
  countRange: Object.freeze(['rev-list', '--count', '<range>']),
  /** What a merge of the branch into the base would change, NUL-separated. */
  diffNames: Object.freeze([
    'diff',
    '--name-status',
    '--find-renames',
    '-z',
    '<diff-range>',
  ]),
  /** The one command that reaches the network. */
  push: Object.freeze(['push', '--set-upstream', '<remote>', '<refspec>']),
  /** Where that remote reads from. */
  remoteUrl: Object.freeze(['remote', 'get-url', '<remote>']),
  /**
   * Where that remote writes to, which is not always where it reads from: a
   * `remote.<name>.pushurl` overrides the fetch URL for pushes only, so this is
   * the URL a push result has to name if it is to be true.
   */
  remotePushUrl: Object.freeze(['remote', 'get-url', '--push', '<remote>']),
});

/** A key of {@link GIT_COMMANDS}. */
export type GitCommandName = keyof typeof GIT_COMMANDS;

/** The one entry of {@link GIT_COMMANDS} that can reach beyond this machine. */
export const NETWORK_COMMANDS: readonly GitCommandName[] = Object.freeze(['push']);

/**
 * Argument shapes that force, delete, or hand a remote something to run.
 *
 * None of them can be produced by {@link GIT_COMMANDS} — that is the actual
 * guarantee, and this list is what makes the guarantee testable rather than
 * merely visible. {@link buildGitArgv} compares whole elements against it, so a
 * commit message that happens to contain the word is a message and not a flag.
 */
export const FORCE_TOKENS: readonly string[] = Object.freeze([
  '-f',
  '--force',
  '--force-with-lease',
  '--force-if-includes',
  '-d',
  '--delete',
  '--mirror',
  '--prune',
  '--no-verify',
  '--exec',
  '--receive-pack',
  '--upload-pack',
  '-o',
  '--push-option',
]);

/* -------------------------------------------------------------------------- */
/* What may go in a hole                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A branch name, narrower than git's own rule on purpose.
 *
 * git accepts a great deal this module has no use for. Starting at a letter or
 * a digit is the part that matters most: a value that cannot begin with `-`
 * cannot be read by git as an option, whatever else it says.
 */
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** A remote name: one path segment, no separator at all. */
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The trailer this module will not let a commit message carry. */
const CO_AUTHOR_TRAILER = /^co-authored-by:/i;

/** Why `branch` cannot be a branch name here, or undefined when it can. */
export function branchNameFault(branch: string): string | undefined {
  if (branch === '') return 'a branch name is required';
  if (branch.length > MAX_BRANCH_LENGTH) {
    return 'a branch name is at most ' + MAX_BRANCH_LENGTH + ' characters';
  }
  if (!BRANCH_NAME.test(branch)) {
    return (
      'a branch name starts with a letter or a digit, and carries only ' +
      'letters, digits, . _ - and /'
    );
  }
  if (branch.includes('..')) return 'a branch name may not contain ".."';
  if (branch.includes('//')) return 'a branch name may not contain "//"';
  if (branch.endsWith('/') || branch.endsWith('.')) {
    return 'a branch name may not end with "/" or "."';
  }
  if (branch.endsWith('.lock')) return 'a branch name may not end with ".lock"';
  if (branch.split('/').some((part) => part === '' || part.startsWith('.'))) {
    return 'no part of a branch name may be empty or start with "."';
  }
  return undefined;
}

function refFault(ref: string): string | undefined {
  return branchNameFault(ref);
}

/**
 * The two-dot range one count is taken over.
 *
 * Built here rather than by a caller so that `..` — the one piece of punctuation
 * this module's value rules otherwise refuse outright — exists in exactly one
 * place, between two refs that were each checked on their own.
 */
export function revRange(from: string, to: string): string {
  for (const ref of [from, to]) {
    const fault = refFault(ref);
    if (fault !== undefined) {
      throw new ConfigError('refusing to build a range from "' + ref + '"\n  ' + fault);
    }
  }
  return from + '..' + to;
}

function rangeFault(range: string): string | undefined {
  const parts = range.split('..');
  if (parts.length !== 2) return 'a range is written <from>..<to>';
  return refFault(parts[0] as string) ?? refFault(parts[1] as string);
}

/**
 * The three-dot range a merge is described by.
 *
 * Three dots, not two, and the difference is the whole point of the function.
 * `git diff base..branch` compares the two tips, so once the base has moved on,
 * every commit the base gained since the branch was cut shows up in the answer
 * backwards — a file somebody else added to the default branch is reported as a
 * file this branch deletes. `base...branch` starts at the merge base instead,
 * which is what a merge would actually bring in, and what a pull request shows.
 *
 * A separate value type from {@link revRange} rather than a wider one: two dots
 * and three dots mean different things, and a range that could be either is a
 * range whose meaning depends on how it was spelled somewhere else.
 */
export function mergeBaseRange(base: string, branch: string): string {
  for (const ref of [base, branch]) {
    const fault = refFault(ref);
    if (fault !== undefined) {
      throw new ConfigError(
        'refusing to build a diff range from "' + printableValue(ref) + '"\n  ' + fault,
      );
    }
  }
  return base + '...' + branch;
}

function diffRangeFault(range: string): string | undefined {
  const parts = range.split('...');
  if (parts.length !== 2) return 'a diff range is written <base>...<branch>';
  return refFault(parts[0] as string) ?? refFault(parts[1] as string);
}

/**
 * The refspec a push is made of, and the whole of why a push cannot be forced.
 *
 * `refs/heads/x:refs/heads/x` names the source and the destination in full, so
 * nothing in a repository's configuration can redirect it, and the shape is
 * checked rather than assumed: a leading `+` is git's own spelling of "force
 * this update", and it is the one thing this function exists to refuse.
 */
export function pushRefspec(branch: string): string {
  const refspec = 'refs/heads/' + branch + ':refs/heads/' + branch;
  const fault = branchNameFault(branch) ?? refspecFault(refspec);
  if (fault !== undefined) {
    throw new ConfigError(
      'refusing to push "' + printableValue(branch) + '"\n  ' + fault,
    );
  }
  return refspec;
}

/**
 * The branch a push refspec would move, whatever else it says.
 *
 * The source side, because the source and the destination of a refspec built
 * here are the same string — {@link refspecFault} is what makes that true, and
 * this is what the guard in front of the spawn asks so that it is looking at
 * the branch git will actually write.
 */
function pushedBranch(refspec: string): string {
  const source = refspec.split(':')[0] ?? '';
  return source.startsWith('refs/heads/')
    ? source.slice('refs/heads/'.length)
    : source;
}

/**
 * Why a refspec cannot be pushed, or undefined when it can.
 *
 * Three separate refusals in one place, and the last of them is the one that
 * matters most: the branch has to be an issue branch of this runner's own
 * making. A refspec is the only way `git push` learns what to write, so a type
 * that will not describe anything else is a push that cannot go anywhere else.
 */
function refspecFault(refspec: string): string | undefined {
  if (refspec.startsWith('+')) {
    return 'a leading "+" forces the update, and this module never forces one';
  }
  const parts = refspec.split(':');
  if (parts.length !== 2) return 'a refspec is written <source>:<destination>';
  const [source, destination] = parts as [string, string];
  if (source !== destination) {
    return 'the source and the destination of a push are the same branch here';
  }
  if (!source.startsWith('refs/heads/')) {
    return 'a push here names a branch in full, as refs/heads/<branch>';
  }
  const branch = source.slice('refs/heads/'.length);
  const fault = branchNameFault(branch);
  if (fault !== undefined) return fault;
  if (parseIssueBranch(branch) === undefined) {
    return (
      'a push here names one of this runner\'s own branches, ' +
      BRANCH_NAMESPACE +
      'issue-<number>-<slug>'
    );
  }
  return undefined;
}

function remoteFault(remote: string): string | undefined {
  if (remote === '') return 'a remote name is required';
  if (!REMOTE_NAME.test(remote)) {
    return (
      'a remote name starts with a letter or a digit, and carries only ' +
      'letters, digits, . _ and -'
    );
  }
  return undefined;
}

/**
 * The type of every hole in {@link GIT_COMMANDS}.
 *
 * The house rule for the command line is that a flag taking a value declares
 * what validates it or a gate test fails the flag. This is that rule pointed at
 * git: a placeholder with no entry here cannot be filled, so adding a command
 * with an unchecked hole is not something that can be done by accident.
 */
export const VALUE_TYPES: Readonly<Record<string, (value: string) => string | undefined>> =
  Object.freeze({
    '<branch>': branchNameFault,
    '<ref>': refFault,
    '<range>': rangeFault,
    '<diff-range>': diffRangeFault,
    '<refspec>': refspecFault,
    '<message>': commitMessageFault,
    '<remote>': remoteFault,
  });

const PLACEHOLDER = /^<[a-z-]+>$/;

/* -------------------------------------------------------------------------- */
/* Building an argument vector                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The argument vector for one entry of the vocabulary.
 *
 * The only way an argument vector is made in this module, and the reason a
 * value from an issue can never become a command: a hole is replaced by one
 * whole array element, so there is no string a value could be spliced into. A
 * name that is not in the vocabulary, a hole with no value, or a value its type
 * refuses all end the same way — nothing is spawned.
 */
export function buildGitArgv(
  name: string,
  values: Readonly<Record<string, string>> = {},
): string[] {
  if (!Object.prototype.hasOwnProperty.call(GIT_COMMANDS, name)) {
    throw new ConfigError(
      [
        "refusing to run a git command that is not in this module's vocabulary",
        '  asked for: ' + printableValue(name),
        '  the vocabulary is: ' + Object.keys(GIT_COMMANDS).join(', '),
      ].join('\n'),
    );
  }

  const template = GIT_COMMANDS[name as GitCommandName];
  const used = new Set<string>();
  const argv: string[] = [];

  for (const element of template) {
    if (!PLACEHOLDER.test(element)) {
      argv.push(element);
      continue;
    }
    const check = VALUE_TYPES[element];
    if (check === undefined) {
      throw new ConfigError(
        [
          'refusing to fill a git argument with no declared type',
          '  ' + name + ' asks for ' + element,
          '  every hole in a git command declares what may go in it',
        ].join('\n'),
      );
    }
    const value = Object.prototype.hasOwnProperty.call(values, element)
      ? (values[element] as string)
      : undefined;
    if (value === undefined) {
      throw new ConfigError(
        [
          'refusing to run git ' + name + ' with a hole left open',
          '  no value for ' + element,
        ].join('\n'),
      );
    }
    // Before the declared type, because a NUL is not a bad value of some kind:
    // it is the byte that ends an argument as the operating system reads it, so
    // everything after it in the string would be handed to git as something
    // nobody validated.
    const fault = value.includes('\0')
      ? 'an argument may not contain a NUL byte'
      : check(value);
    if (fault !== undefined) {
      throw new ConfigError(
        [
          'refusing to run git ' + name + ' with that ' + element,
          '  ' + printableValue(value),
          '  ' + fault,
        ].join('\n'),
      );
    }
    used.add(element);
    argv.push(value);
  }

  for (const key of Object.keys(values)) {
    if (!used.has(key)) {
      throw new ConfigError(
        [
          'refusing to run git ' + name + ' with an argument it has no hole for',
          '  ' + printableValue(key) + ' is not part of ' + template.join(' '),
        ].join('\n'),
      );
    }
  }

  assertNoForce(name, argv);
  return argv;
}

/**
 * The sweep over a finished vector.
 *
 * Stated plainly, because a lock is easier to trust when its limits are
 * written down: **on every shipped path this check is inert.** No entry of
 * {@link GIT_COMMANDS} contains one of these tokens, and no value type admits
 * one — a commit message reaches git through
 * {@link normalizeCommitMessage}, which ends it with a newline, so not even a
 * message of exactly `--force` arrives here as that string. It cannot fire
 * unless somebody edits the vocabulary, and firing then is the whole of what it
 * is for: "no force flag exists" is a claim about a list, and a claim about a
 * list is worth what the check over it is worth.
 *
 * Off the shipped paths it is mildly over-broad on purpose. Building the commit
 * vector by hand with a message of exactly `--force` is refused as a flag, and
 * that is the right way round: the argument that is indistinguishable from the
 * flag is the one to refuse. Elements are compared whole, so a message that
 * merely mentions `--force` is a message.
 */
function assertNoForce(name: string, argv: readonly string[]): void {
  for (const element of argv) {
    if (FORCE_TOKENS.includes(element)) {
      throw new ConfigError(
        [
          'refusing to run git ' + name + ' with ' + element,
          '  this module never forces, deletes, or hands a remote a command to run',
        ].join('\n'),
      );
    }
  }
}

/**
 * A value as an error may print it: one line, no control characters.
 *
 * A branch name, a remote, an issue title — everything this module names in a
 * message arrived from somewhere else, and a terminal reads an escape sequence
 * in a string as an instruction. Untrusted text is flattened before it is
 * drawn, here as everywhere else in this CLI.
 */
function printableValue(value: string): string {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? flat.slice(0, 117) + '...' : flat;
}

/* -------------------------------------------------------------------------- */
/* Secrets                                                                     */
/* -------------------------------------------------------------------------- */

/** The credential in a URL, which is the one shape git alone produces. */
const URL_CREDENTIAL = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]+@/g;

/**
 * Text with anything that looks like a credential taken out.
 *
 * A push against an HTTPS remote carries the token in the URL, and git repeats
 * that URL back in its progress lines and in most of its failures. Every string
 * this module hands a caller — a result, an error, a branch name — comes
 * through here first, so a token cannot reach a run record, a comment, a page
 * or a ref by way of this module. Only the credential is replaced; the rest of
 * what was said is passed on exactly as it was said.
 *
 * What a token *looks like* is `src/github.ts`'s answer, not a second list kept
 * here: two lists of token shapes is one list that will be out of date, and the
 * one in the network module is the one every other surface in this CLI already
 * redacts by. This adds the shape that module has no reason to know — the
 * userinfo of a remote URL, which no token pattern matches because the password
 * in it can be anything at all.
 *
 * Nothing about that import reaches the network: it is a pure function of a
 * string, and the boundary gate is about what makes requests, not about who may
 * agree on what a secret looks like.
 */
export function redactSecrets(text: string): string {
  return redactTokens(text.replace(URL_CREDENTIAL, '$1' + REDACTED + '@'));
}

/* -------------------------------------------------------------------------- */
/* Running git                                                                 */
/* -------------------------------------------------------------------------- */

/** What the caller hands every operation in this module. */
export interface GitContext {
  /** Any directory inside the work tree. */
  cwd: string;
  /** The remote to push to; {@link DEFAULT_REMOTE} when absent. */
  remote?: string;
  /** What the caller asked GitHub, and what this module enforces. */
  repo: RepoGuard;
  /** Ceiling on one git invocation; {@link DEFAULT_TIMEOUT_MS} when absent. */
  timeoutMs?: number;
}

/** One finished git invocation. */
export interface GitResult {
  /** Exactly what was spawned, after `git`. */
  argv: readonly string[];
  status: number;
  /** Redacted, as everything leaving this module is. */
  stdout: string;
  /** Redacted, as everything leaving this module is. */
  stderr: string;
}

function remoteOf(ctx: GitContext): string {
  const remote = ctx.remote ?? DEFAULT_REMOTE;
  const fault = remoteFault(remote);
  if (fault !== undefined) {
    throw new ConfigError(
      [
        'refusing to use the remote "' + printableValue(remote) + '"',
        '  ' + fault,
      ].join('\n'),
    );
  }
  return remote;
}

function timeoutOf(ctx: GitContext): number {
  const timeout = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new ConfigError(
      [
        'refusing to run git with that time limit',
        '  ' + String(timeout) + ' is not a number of milliseconds above zero',
      ].join('\n'),
    );
  }
  return timeout;
}

/**
 * The environment git runs in.
 *
 * Three things are settled here rather than left to whatever the process
 * inherited. The identity, so a commit never depends on a machine having a
 * `user.email` configured and never picks up the human's. The prompt, disabled,
 * so a push against a remote this process cannot authenticate to fails in a
 * second instead of blocking a scheduled run forever on a password question
 * nobody is there to answer. And the ambient askpass helpers, removed, for the
 * same reason.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: COMMIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: COMMIT_IDENTITY.email,
    GIT_COMMITTER_NAME: COMMIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: COMMIT_IDENTITY.email,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
  delete env['GIT_ASKPASS'];
  delete env['SSH_ASKPASS'];
  return env;
}

/**
 * Spawns one git command and answers with what it said, whatever it exited.
 *
 * The only place in this CLI where a child process is started against a
 * repository. There is no shell: the vector built above is passed as a vector,
 * which is why a value carried in from an issue is an argument and can never be
 * a second command. stdin is closed, so nothing can wait on input that is not
 * coming.
 *
 * Not exported, and that is the point of it. A function that takes a command
 * name is a way to run any command in the vocabulary, and one of those commands
 * writes to a remote — so as long as such a function is reachable from outside,
 * the guard on the intent-level operation is a convention rather than a
 * mechanism. Two things make it one: this stays private, and the branch guard
 * below is *here*, in front of the spawn, rather than at the call sites. Every
 * push in this module passes that line, including the ones nobody has written
 * yet.
 */
function tryGit(
  ctx: GitContext,
  name: GitCommandName,
  values: Readonly<Record<string, string>> = {},
): GitResult {
  const argv = buildGitArgv(name, values);
  if (NETWORK_COMMANDS.includes(name)) {
    assertRunnerBranch(ctx.repo, pushedBranch(values['<refspec>'] ?? ''), 'push');
  }
  const result = spawnSync('git', argv, {
    cwd: ctx.cwd,
    encoding: 'utf8',
    env: gitEnv(),
    shell: false,
    windowsHide: true,
    timeout: timeoutOf(ctx),
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ConfigError(
        [
          'git is not on PATH',
          '  ' + describeArgv(argv),
          '  install git, or run this where git can be found',
        ].join('\n'),
      );
    }
    throw new ConfigError(
      [
        code === 'ETIMEDOUT'
          ? 'git did not finish within ' + timeoutOf(ctx) + 'ms'
          : 'git could not be run',
        '  ' + describeArgv(argv),
        '  ' + redactSecrets(result.error.message),
      ].join('\n'),
    );
  }

  return {
    argv,
    status: result.status ?? 1,
    stdout: redactSecrets(result.stdout ?? ''),
    stderr: redactSecrets(result.stderr ?? ''),
  };
}

/** The same, for the commands whose failure is this module's to report. */
function runGit(
  ctx: GitContext,
  name: GitCommandName,
  values: Readonly<Record<string, string>> = {},
  complaint?: string,
  notes: readonly string[] = [],
): GitResult {
  const result = tryGit(ctx, name, values);
  if (result.status !== 0) throw gitFailed(result, complaint, notes);
  return result;
}

function describeArgv(argv: readonly string[]): string {
  return printableValue(['git', ...argv].join(' '));
}

function gitFailed(
  result: GitResult,
  complaint: string | undefined,
  notes: readonly string[],
): ConfigError {
  const said = (result.stderr.trim() === '' ? result.stdout : result.stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 8);
  return new ConfigError(
    [
      complaint ?? 'git exited ' + result.status,
      '  ' + describeArgv(result.argv),
      ...said.map((line) => '  ' + printableValue(line)),
      ...notes.map((line) => '  ' + line),
    ].join('\n'),
  );
}

function output(result: GitResult): string {
  return result.stdout.trim();
}

/* -------------------------------------------------------------------------- */
/* Branch names                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The slug half of a branch name, from whatever the issue is called.
 *
 * An issue title is untrusted text — somebody typed it, and anybody can open an
 * issue. What comes out of here is lowercase letters, digits and single
 * hyphens, and then it is put through the same rule a named goal is created
 * under, so the two ways this CLI turns prose into a name on disk cannot drift
 * apart. Everything else in the title is dropped rather than escaped: a name
 * that needs escaping is a name that will be mishandled by something eventually.
 *
 * A title written in a script this rule cannot spell — Japanese, Arabic, an
 * emoji — has **no slug**, and this answers with the empty string rather than a
 * word. There was a placeholder here once, and it was wrong twice over: every
 * such issue in a repository was called `untitled`, which is not what any of
 * them were called, and it was the same word for all of them, which made the
 * one part of the name meant to tell them apart tell the reader nothing. The
 * number already identifies the issue; {@link issueBranchName} leaves the slug
 * off when there is none, and says so.
 *
 * A title carrying a credential has no slug for that part of it either. See the
 * order of the steps below: redaction happens before the folding, because after
 * the folding there is nothing left to recognise.
 */
export function issueSlug(title: string): string {
  // Composed as one pipeline, and the order of the first three steps is the
  // whole of C12 here.
  //
  // Compatibility decomposition first, so a token typed in fullwidth or
  // otherwise decorated characters is an ordinary ASCII token by the time
  // anything looks for one, and the combining marks it leaves behind go with
  // it — dropping an accent rather than replacing it is also what makes
  // "résumé" one word.
  const plain = title.normalize('NFKD').replace(/\p{M}+/gu, '');

  // Then redaction, *before* a single character has been folded or replaced.
  // Lowercasing and hyphenation are a disguise: `ghp_S3cret…` becomes
  // `ghp-s3cret…`, which no token pattern will ever match again, and a branch
  // name is republished in more places than any other string this module
  // produces. A secret that survives this line survives onto the remote.
  const safe = redactSecrets(plain)
    // The marker is redaction's own word, not the issue's. Leaving it in would
    // make `issue-96-redacted` read as an issue about redaction, and would give
    // every title that is nothing but a token the same slug; taken out, such a
    // title has no slug at all, which is the truth about it.
    .split(REDACTED)
    .join(' ');

  const slug = safe
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const clipped = clipSlug(slug);
  return newGoalNameFault(clipped) === undefined ? clipped : '';
}

/** Cuts a slug to length at a hyphen when it can, mid-word when it must. */
function clipSlug(slug: string): string {
  if (slug.length <= MAX_SLUG_LENGTH) return slug;
  const cut = slug.slice(0, MAX_SLUG_LENGTH);
  const boundary = cut.lastIndexOf('-');
  const kept = boundary > 0 ? cut.slice(0, boundary) : cut;
  return kept.replace(/^-+|-+$/g, '');
}

/** Why `number` cannot number an issue, or undefined when it can. */
function issueNumberFault(value: number): string | undefined {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return 'an issue number is a whole number above zero';
  }
  return undefined;
}

/**
 * The branch for one issue: `exolvra-genesis/issue-<number>-<slug>`.
 *
 * One branch per issue, and the name says which issue without anybody having to
 * look it up. The namespace is what makes the rest of this module's refusals
 * possible: a branch outside it is a branch somebody else made.
 *
 * The slug is the readable half and the number is the identifying one, so when
 * a title yields no slug at all the branch is `exolvra-genesis/issue-<number>`
 * and nothing is invented to fill the gap. Every branch is still unique per
 * issue, still inside the namespace, still pushable through this module's own
 * guard, and {@link parseIssueBranch} reads both shapes back.
 */
export function issueBranchName(number: number, title: string): string {
  const fault = issueNumberFault(number);
  if (fault !== undefined) {
    throw new ConfigError(
      ['refusing to name a branch for issue ' + String(number), '  ' + fault].join('\n'),
    );
  }
  const slug = issueSlug(title);
  const branch =
    BRANCH_NAMESPACE + 'issue-' + number + (slug === '' ? '' : '-' + slug);
  const invalid = branchNameFault(branch);
  if (invalid !== undefined) {
    throw new ConfigError(
      [
        'refusing to name a branch "' + printableValue(branch) + '"',
        '  ' + invalid,
      ].join('\n'),
    );
  }
  return branch;
}

/**
 * The issue a branch name belongs to, or undefined when it names no issue.
 *
 * The slug is optional here because it is optional in the name: every string
 * {@link issueBranchName} can produce is read back by this, and the slug it
 * answers with is the slug that went in — the empty one included.
 */
export function parseIssueBranch(
  branch: string,
): { number: number; slug: string } | undefined {
  if (!branch.startsWith(BRANCH_NAMESPACE)) return undefined;
  const rest = branch.slice(BRANCH_NAMESPACE.length);
  const match = rest.match(/^issue-([1-9][0-9]*)(?:-(.+))?$/);
  if (match === null) return undefined;
  const number = Number(match[1]);
  if (issueNumberFault(number) !== undefined) return undefined;
  return { number, slug: match[2] ?? '' };
}

/* -------------------------------------------------------------------------- */
/* The write guard                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What the caller learned about the repository from GitHub.
 *
 * The split is deliberate: asking is the network module's job, and enforcing is
 * this one's. Nothing here goes and checks — a module that could ask could also
 * be talked into not asking, and this way the answer is a value on the stack
 * that every write is measured against.
 */
export interface RepoGuard {
  /** The branch a pull request will target, and the one never pushed to. */
  defaultBranch: string;
  /** Protection patterns as GitHub states them: `release/*`, `v?.*`, `**`. */
  protectedBranches?: readonly string[];
  /** `owner/name`, for errors that should say which repository they mean. */
  repo?: string;
}

/** What a write is, for the sentence the refusal opens with. */
export type GitWrite = 'branch' | 'commit' | 'push';

const WRITE_VERB: Readonly<Record<GitWrite, string>> = Object.freeze({
  branch: 'refusing to create the branch ',
  commit: 'refusing to commit on the branch ',
  push: 'refusing to push the branch ',
});

/**
 * The policy every refusal ends with.
 *
 * A refusal that only says no leaves the reader guessing what the tool would
 * have done instead. This says it, in the two lines it takes.
 */
const WRITE_POLICY: readonly string[] = Object.freeze([
  'this runner writes one ' + BRANCH_NAMESPACE + 'issue-<number>-<slug> branch',
  'per issue and never forces a push; everything else is a pull request',
]);

function repoLabel(repo: RepoGuard): string {
  return repo.repo === undefined || repo.repo.trim() === ''
    ? 'this repository'
    : printableValue(repo.repo);
}

/**
 * Whether one of GitHub's branch patterns covers `branch`.
 *
 * GitHub's own spelling: `*` stands for any run of characters inside one path
 * segment, `**` crosses segments, `?` is one character. A pattern with none of
 * them is a plain name and matches only itself. Comparison is
 * case-insensitive — a branch that differs from a protected one only in its
 * capitals is close enough to a protected branch to refuse.
 */
export function matchesBranchPattern(pattern: string, branch: string): boolean {
  const parts = pattern.split(/(\*\*|\*|\?)/);
  let source = '';
  for (const part of parts) {
    if (part === '**') source += '.*';
    else if (part === '*') source += '[^/]*';
    else if (part === '?') source += '[^/]';
    else source += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + source + '$', 'i').test(branch);
}

/**
 * Why `branch` may not be written to, or undefined when it may.
 *
 * Three rules, in the order a reader would ask them. The default branch first,
 * because that is the one a mistake here would damage. Then the repository's
 * protection patterns, exactly as GitHub states them. Then the namespace: a
 * branch this module did not create is somebody's work, and this module has no
 * business adding commits to it even when nothing protects it.
 */
export function branchWriteRefusal(
  repo: RepoGuard,
  branch: string,
): string[] | undefined {
  const fault = branchNameFault(branch);
  if (fault !== undefined) return [fault];

  if (branch.toLowerCase() === repo.defaultBranch.trim().toLowerCase()) {
    return ['it is the default branch of ' + repoLabel(repo)];
  }

  for (const pattern of repo.protectedBranches ?? []) {
    const trimmed = pattern.trim();
    if (trimmed === '') continue;
    if (matchesBranchPattern(trimmed, branch)) {
      return [
        'it is protected by the pattern "' +
          printableValue(trimmed) +
          '" of ' +
          repoLabel(repo),
      ];
    }
  }

  if (!branch.startsWith(BRANCH_NAMESPACE)) {
    return ['it is outside ' + BRANCH_NAMESPACE + ', so this runner did not create it'];
  }

  if (parseIssueBranch(branch) === undefined) {
    return [
      'it is inside ' +
        BRANCH_NAMESPACE +
        ' but is not an issue branch: ' +
        BRANCH_NAMESPACE +
        'issue-<number>-<slug>',
    ];
  }

  return undefined;
}

/**
 * The refusal itself: the mechanism C4 asks for, in front of every write.
 *
 * Called before a branch is created, before a commit is made on it, and before
 * it is pushed — three times rather than once, because each of those is a
 * separate chance for a caller to have the wrong branch in hand.
 */
export function assertRunnerBranch(
  repo: RepoGuard,
  branch: string,
  write: GitWrite,
): void {
  const reasons = branchWriteRefusal(repo, branch);
  if (reasons === undefined) return;
  throw new ConfigError(
    [
      WRITE_VERB[write] + '"' + printableValue(branch) + '"',
      ...reasons.map((line) => '  ' + line),
      ...WRITE_POLICY.map((line) => '  ' + line),
    ].join('\n'),
  );
}

/* -------------------------------------------------------------------------- */
/* Reading the repository                                                      */
/* -------------------------------------------------------------------------- */

/** The work tree root, and the check that `ctx.cwd` is inside one. */
export function repoRoot(ctx: GitContext): string {
  const result = tryGit(ctx, 'repoRoot');
  if (result.status !== 0) {
    throw gitFailed(result, 'not a git repository: ' + printableValue(ctx.cwd), [
      'this runner works in a checkout; clone the repository first',
    ]);
  }
  return output(result);
}

/**
 * The branch HEAD is on.
 *
 * A detached HEAD answers undefined rather than raising, because two callers
 * want different things from it: one has to refuse, and one only has to say
 * what the branch was cut from.
 */
export function currentBranch(ctx: GitContext): string | undefined {
  const result = tryGit(ctx, 'headBranch');
  if (result.status !== 0) return undefined;
  const branch = output(result);
  return branch === '' ? undefined : branch;
}

/**
 * What `refs/heads/<branch>` is an alias for, when it is an alias at all.
 *
 * A branch can be a symbolic ref: `refs/heads/x` pointing at `refs/heads/main`
 * rather than at a commit. Checking one out puts HEAD on the target, so a
 * runner that only asked "does the branch exist" would believe it was on the
 * issue branch while standing on the default one — with nothing but the commit
 * guard between it and a write to `main`.
 */
function symrefTarget(ctx: GitContext, branch: string): string | undefined {
  const result = tryGit(ctx, 'resolveSymref', { '<ref>': 'refs/heads/' + branch });
  if (result.status !== 0) return undefined;
  const target = output(result);
  return target === '' ? undefined : target;
}

/** Both URLs of the remote, redacted: the one it reads from, the one it writes to. */
export function remoteUrls(ctx: GitContext): { fetch: string; push: string } {
  const remote = remoteOf(ctx);
  const read = tryGit(ctx, 'remoteUrl', { '<remote>': remote });
  if (read.status !== 0) {
    throw gitFailed(read, 'no remote called "' + remote + '" in this repository', [
      'this module never adds or repoints a remote; configure it, then run again',
    ]);
  }
  const write = tryGit(ctx, 'remotePushUrl', { '<remote>': remote });
  return {
    fetch: output(read),
    push: write.status === 0 ? output(write) : output(read),
  };
}

/** One changed path, from `git status` or from a diff. */
export interface Change {
  /**
   * git's own code for what happened, verbatim.
   *
   * Two columns from `git status --porcelain` — `??`, ` M`, `A `, `R ` — and a
   * single letter with an optional similarity score from a diff: `A`, `M`, `D`,
   * `R100`. Verbatim rather than translated into one alphabet, because the
   * similarity score is information a renderer may want and inventing a shared
   * vocabulary would throw it away.
   */
  status: string;
  path: string;
  /** Where a renamed or copied path came from. */
  from?: string;
}

/**
 * `git status --porcelain -z`, parsed.
 *
 * NUL-separated rather than line-separated so that a path is a path: git quotes
 * and escapes non-ASCII names in its line-oriented output, and a runner that
 * unescaped them wrongly would report the wrong file in a pull request body.
 */
export function parseStatus(text: string): Change[] {
  const fields = text.split('\0').filter((field) => field !== '');
  const changes: Change[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] as string;
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = fields[index + 1];
      index += 1;
      changes.push(from === undefined ? { status, path } : { status, path, from });
    } else {
      changes.push({ status, path });
    }
  }
  return changes;
}

/** Everything the work tree has that HEAD does not. */
export function workingTreeChanges(ctx: GitContext): Change[] {
  return parseStatus(runGit(ctx, 'changes', {}, 'could not read the work tree').stdout);
}

/**
 * `git diff --name-status -z`, parsed.
 *
 * A different shape from `git status`, and the difference is easy to get
 * backwards: a rename here is three fields, `R100`, then the path it came
 * *from*, then the path it went *to* — the opposite order from porcelain, which
 * writes the destination first. The destination is what lands in `path` either
 * way, so a caller reading a {@link Change} never has to know which command
 * produced it.
 */
export function parseDiffNames(text: string): Change[] {
  const fields = text.split('\0').filter((field) => field !== '');
  const changes: Change[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index] as string;
    const renamed = status.startsWith('R') || status.startsWith('C');
    const first = fields[index + 1];
    if (first === undefined) break;
    if (renamed) {
      const second = fields[index + 2];
      index += 2;
      if (second === undefined) {
        changes.push({ status, path: first });
        break;
      }
      changes.push({ status, path: second, from: first });
    } else {
      index += 1;
      changes.push({ status, path: first });
    }
  }
  return changes;
}

/**
 * What merging `branch` into `base` would change.
 *
 * The change set a pull request proposes, which is not the same thing as what
 * one round of work left in the tree: a branch that was pushed, blocked, and
 * picked up again carries every commit of every round, and a body that
 * described only the last of them would be describing less than the merge.
 *
 * Taken from the merge base ({@link mergeBaseRange}), so a default branch that
 * moved on in the meantime contributes nothing to the answer.
 */
export function branchChanges(ctx: GitContext, base: string, branch: string): Change[] {
  const range = mergeBaseRange(base, branch);
  const result = runGit(
    ctx,
    'diffNames',
    { '<diff-range>': range },
    'could not read what "' + printableValue(branch) + '" changes',
  );
  return parseDiffNames(result.stdout);
}

/**
 * The commit a ref resolves to, or undefined when it resolves to nothing.
 *
 * Undefined is an answer, not a fault: asking for the head of a branch that is
 * not there is a reasonable question with a reasonable answer. A ref *name*
 * this module would not run is a different matter, and raises — that is a
 * mistake in the caller, not a fact about the repository.
 */
export function refSha(ctx: GitContext, ref: string): string | undefined {
  const result = tryGit(ctx, 'verifyRef', { '<ref>': ref });
  if (result.status !== 0) return undefined;
  const sha = output(result);
  return sha === '' ? undefined : sha;
}

/**
 * Changes as a refusal lists them: git's own two-letter column, then the path.
 *
 * The path is flattened, the status column is not — those two characters are
 * porcelain's alphabet, and a leading space in ` M` is what distinguishes a
 * change in the tree from one already staged.
 */
function listPaths(changes: readonly Change[], limit = 10): string[] {
  const shown = changes
    .slice(0, limit)
    .map((change) => change.status + ' ' + printableValue(change.path));
  const rest = changes.length - shown.length;
  return rest > 0 ? [...shown, '… and ' + rest + ' more'] : shown;
}

/**
 * Refuses to start on a work tree that already has changes in it.
 *
 * The clean starting point is what makes the commit at the end honest: whatever
 * is in the tree when the builders finish is what they did, and nothing that
 * was lying around before they started rides along into the pull request.
 */
export function assertCleanTree(ctx: GitContext): void {
  const changes = workingTreeChanges(ctx);
  if (changes.length === 0) return;
  throw new ConfigError(
    [
      'refusing to start on a work tree with uncommitted changes',
      ...listPaths(changes).map((line) => '  ' + line),
      '  commit or stash them, then run again',
    ].join('\n'),
  );
}

/** Whether a local branch of that name exists. */
export function localBranchExists(ctx: GitContext, branch: string): boolean {
  return tryGit(ctx, 'verifyRef', { '<ref>': 'refs/heads/' + branch }).status === 0;
}

/** Whether the remote-tracking ref for that branch exists in this checkout. */
export function remoteBranchExists(ctx: GitContext, branch: string): boolean {
  const ref = 'refs/remotes/' + remoteOf(ctx) + '/' + branch;
  return tryGit(ctx, 'verifyRef', { '<ref>': ref }).status === 0;
}

function countCommits(ctx: GitContext, from: string, to: string): number {
  const range = revRange(from, to);
  const result = runGit(
    ctx,
    'countRange',
    { '<range>': range },
    'could not count the commits in ' + range,
  );
  const count = Number(output(result));
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

/* -------------------------------------------------------------------------- */
/* The operations                                                              */
/* -------------------------------------------------------------------------- */

/** Whether the branch was made now or picked back up. */
export type BranchState = 'created' | 'reused';

export interface BranchResult {
  branch: string;
  state: BranchState;
  /** The branch it was cut from; absent when it was reused. */
  base?: string;
}

/**
 * The issue's branch, ready to be committed on.
 *
 * The one decision worth stating: a branch that is already there is **reused**,
 * not replaced and not renamed. A second pass at an issue — a resumed run, a
 * budget that ran out, a crash — is the ordinary case, and the alternative to
 * reuse is a repository slowly filling with `-2` branches nobody can tell apart.
 *
 * Reuse has two conditions. If the remote-tracking branch holds commits this
 * one does not, the two have diverged, and reconciling them is a merge or a
 * rebase or a forced push — one of which this module cannot do and two of which
 * are a person's decision. It refuses and says so. Divergence is never silently
 * resolved, in either direction.
 *
 * And the branch has to be a branch. A ref under this runner's namespace that
 * is a symbolic ref pointing somewhere else is not the issue's branch wearing
 * the issue's name; checking it out lands HEAD on the target, which may be the
 * default branch. That is refused before anything is reused, and the branch
 * that was asked for is confirmed to be the branch HEAD is on before this
 * answers `reused` — a result that says where the caller is standing is worth
 * nothing if it was not checked.
 */
export function ensureIssueBranch(
  ctx: GitContext,
  issue: { number: number; title: string },
): BranchResult {
  repoRoot(ctx);
  const branch = issueBranchName(issue.number, issue.title);
  assertRunnerBranch(ctx.repo, branch, 'branch');
  assertCleanTree(ctx);

  if (!localBranchExists(ctx, branch)) {
    const base = currentBranch(ctx);
    if (base === undefined) {
      throw new ConfigError(
        [
          'refusing to branch from a detached HEAD',
          '  check out the branch this work should start from, then run again',
        ].join('\n'),
      );
    }
    runGit(
      ctx,
      'createBranch',
      { '<branch>': branch },
      'could not create the branch "' + branch + '"',
    );
    return { branch, state: 'created', base };
  }

  const alias = symrefTarget(ctx, branch);
  if (alias !== undefined) {
    throw new ConfigError(
      [
        'refusing to reuse the branch "' + branch + '"',
        '  it is not a branch: it is a symbolic ref pointing at ' + printableValue(alias),
        '  checking it out would land this run on ' +
          printableValue(alias) +
          ' under the issue branch\'s name',
        '  delete or repoint the ref, then run again',
      ].join('\n'),
    );
  }

  if (currentBranch(ctx) !== branch) {
    runGit(
      ctx,
      'switchBranch',
      { '<branch>': branch },
      'could not switch to the branch "' + branch + '"',
    );
  }

  // A confirmation rather than a guard, and worth saying so: with symbolic refs
  // refused above, no way of tripping this is known. It is here because the
  // sentence this function returns — "you are on the issue branch" — is one the
  // caller acts on without looking, and reading HEAD back costs one process.
  const standing = currentBranch(ctx);
  if (standing !== branch) {
    throw new ConfigError(
      [
        'refusing to reuse the branch "' + branch + '"',
        '  after checking it out, HEAD is on ' +
          (standing === undefined ? 'no branch at all' : '"' + printableValue(standing) + '"'),
        '  this run will not report a branch it is not standing on',
      ].join('\n'),
    );
  }

  if (remoteBranchExists(ctx, branch)) {
    const remote = remoteOf(ctx);
    const behind = countCommits(
      ctx,
      'refs/heads/' + branch,
      'refs/remotes/' + remote + '/' + branch,
    );
    if (behind > 0) {
      throw new ConfigError(
        [
          'refusing to reuse the branch "' + branch + '"',
          '  ' +
            remote +
            '/' +
            branch +
            ' has ' +
            behind +
            (behind === 1 ? ' commit ' : ' commits ') +
            'this checkout does not',
          '  nothing here merges, rebases, or forces a push, so the two cannot be',
          '  reconciled without a decision; make it, then run again',
        ].join('\n'),
      );
    }
  }

  return { branch, state: 'reused' };
}

/** Why `message` cannot be a commit message, or undefined when it can. */
export function commitMessageFault(message: string): string | undefined {
  if (message.includes('\0')) return 'a commit message may not contain a NUL byte';
  const text = normalizeCommitMessage(message);
  if (text.trim() === '') return 'a commit message is required';
  const trailers = text.trim().split('\n\n').pop() ?? '';
  for (const line of trailers.split('\n')) {
    if (CO_AUTHOR_TRAILER.test(line.trim())) {
      return (
        'a commit here carries no Co-authored-by trailer: the author field ' +
        'already names who wrote it'
      );
    }
  }
  return undefined;
}

/**
 * The message as it is written: one kind of line ending, no trailing blanks.
 *
 * git is told `--cleanup=verbatim`, so what this returns is exactly what the
 * commit will carry. Verbatim is the point: an issue body is markdown, its
 * headings start with `#`, and git's default cleanup would delete every one of
 * those lines as a comment on the way in.
 */
export function normalizeCommitMessage(message: string): string {
  return (
    message
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+|\n+$/g, '') + '\n'
  );
}

export interface CommitResult {
  branch: string;
  /** False when the work tree held nothing to commit. */
  committed: boolean;
  /** The commit, when one was made. */
  sha?: string;
  /** What went into it, or what was there to go into it. */
  changes: Change[];
}

/**
 * Stages the whole work tree and commits it on the branch that is checked out.
 *
 * A tree with nothing in it is not a failure and not an empty commit: it
 * answers `committed: false` and lets the caller decide what a round that
 * changed nothing means. Hooks are left alone — a repository that verifies its
 * own commits is entitled to verify this one, and there is no flag here to skip
 * them.
 */
export function commitAll(ctx: GitContext, message: string): CommitResult {
  const branch = currentBranch(ctx);
  if (branch === undefined) {
    throw new ConfigError(
      ['refusing to commit on a detached HEAD', '  check out the issue branch first'].join(
        '\n',
      ),
    );
  }
  assertRunnerBranch(ctx.repo, branch, 'commit');

  const fault = commitMessageFault(message);
  if (fault !== undefined) {
    throw new ConfigError(['refusing to commit with that message', '  ' + fault].join('\n'));
  }

  const changes = workingTreeChanges(ctx);
  if (changes.length === 0) return { branch, committed: false, changes };

  runGit(ctx, 'stageAll', {}, 'could not stage the work tree');
  runGit(
    ctx,
    'commit',
    { '<message>': normalizeCommitMessage(message) },
    'could not commit on "' + branch + '"',
  );

  const head = tryGit(ctx, 'verifyRef', { '<ref>': 'HEAD' });
  const result: CommitResult = { branch, committed: true, changes };
  if (head.status === 0 && output(head) !== '') result.sha = output(head);
  return result;
}

export interface PushResult {
  branch: string;
  remote: string;
  /**
   * Where the push went, with any credential taken out of it.
   *
   * The push URL, not the fetch URL: a remote may carry a `pushurl` that sends
   * writes somewhere else entirely, and a result that named the URL git read
   * from would be pointing a reader — and a pull request body — at the wrong
   * repository.
   */
  url: string;
  /** Exactly what git said, redacted. */
  output: string;
}

/**
 * Pushes one branch to the repository's own remote, and nothing else.
 *
 * The refspec names one branch as both source and destination, the update is
 * not forced, and it is not forced because there is no parameter here that
 * could force it. A remote branch that moved therefore makes this fail —
 * loudly, with git's own words — instead of overwriting somebody's commits;
 * what happens next is a person's call.
 */
export function pushBranch(ctx: GitContext, branch: string): PushResult {
  assertRunnerBranch(ctx.repo, branch, 'push');
  const remote = remoteOf(ctx);

  if (!localBranchExists(ctx, branch)) {
    throw new ConfigError(
      [
        'refusing to push a branch that is not here',
        '  no local branch called "' + printableValue(branch) + '"',
      ].join('\n'),
    );
  }

  const urls = remoteUrls(ctx);

  const push = runGit(
    ctx,
    'push',
    { '<remote>': remote, '<refspec>': pushRefspec(branch) },
    'could not push "' + branch + '" to ' + remote,
    [
      'the push is never retried with force; if the remote branch moved, what',
      'happens to it is a decision for a person',
    ],
  );

  return {
    branch,
    remote,
    url: urls.push,
    output: (push.stdout + push.stderr).trim(),
  };
}
