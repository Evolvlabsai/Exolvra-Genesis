/**
 * `exolvra-genesis work` — one pass over the issues a maintainer marked ready.
 *
 * This is the command every other piece of the issue runner was built for, and
 * almost all of what it does is *wiring*. The pieces it joins already refuse
 * what they are not allowed to do: `src/github.ts` is the only module that
 * reaches the network, `src/git.ts` is the only one that writes to a work tree
 * or a remote and will not write outside this runner's own branch namespace,
 * `src/issue-run.ts` owns the claim, the snapshot, the labels, the heartbeat and
 * the status comment, and `src/allowlist.ts` owns which repositories exist at
 * all for this invocation. Nothing here re-decides any of that.
 *
 * **The loop is not reimplemented here, and it is not reimplemented anywhere.**
 * The one thing this file must never grow is a second copy of how a run is
 * driven: how the lead prompt is rendered, what a round marker looks like, when
 * a run has won, what the ledger records, which exit code an ending carries. So
 * it does not have one. For each issue it *runs the `run` command* — the same
 * `Command.run` a person reaches by typing `exolvra-genesis run --auto <spec>`,
 * called in this process with the derived spec and the budget the issue was
 * given — and reads the machine stream `--json` publishes to learn what
 * happened. If `work` and `run` could disagree about a round, the design would
 * be wrong; they cannot, because there is one implementation and this is one of
 * its callers.
 *
 * Three rules shape the rest.
 *
 * - **A resolvable identity is a precondition for writing** (spec addendum
 *   v0.1.2). {@link requireRunnerLogin} settles the account this run posts as
 *   before an issue is read or a label is touched, and refuses the run when
 *   neither GitHub nor the operator will name it. Every context handed to
 *   `src/issue-run.ts` carries the login it produced.
 * - **`--dry-run` is not a promise, it is a shape.** It never asks for an
 *   identity, never claims, never labels, never comments and never touches the
 *   work tree. It lists what it would pick up and prints the spec it would
 *   derive from each issue, and every request it makes is a GET.
 * - **Budgets are mandatory and finite** (C9). `--max-rounds` and `--max-cost`
 *   have defaults rather than being optional, and they are per issue: a pass
 *   that works three issues is three budgets, because what is being limited is
 *   one run against one spec.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  LIFECYCLE_LABELS,
  REPOS_ENV,
  describeAllowlist,
  issueRef,
  type Lifecycle,
  lifecycleLabel,
  lifecycleOf,
  repeatedFlagValues,
  repoValue,
  reposValue,
  resolveAllowlist,
} from '../allowlist.js';
import { costValue } from '../budget.js';
import type { RunEvent, RunStatus, Verdict } from '../events.js';
import { ConfigError, EXIT, UsageError, usageFor } from '../exit.js';
import {
  type GitContext,
  type RepoGuard,
  assertCleanTree,
  branchChanges,
  commitAll,
  currentBranch,
  ensureIssueBranch,
  localBranchExists,
  normalizeCommitMessage,
  pushBranch,
  refSha,
  remoteBranchExists,
  remoteUrls,
  repoRoot,
} from '../git.js';
import {
  GitHubError,
  redactSecrets,
  type GitHubClient,
  type Issue,
  type IssueThread,
  type PullRequest,
  type Repo,
  type RepoInfo,
  createGitHubClient,
  isoSeconds,
  repoFault,
  repoSlug,
  TOKEN_ENV,
  until,
} from '../github.js';
import {
  DEFAULT_CLAIM_TTL_MS,
  type DerivedSpec,
  IdentityUnavailable,
  type IssueRunContext,
  RUNNER_LOGIN_ENV,
  RUNNER_LOGIN_FLAG,
  RUNS_SUBDIR,
  type RunPhase,
  type RunnerIdentity,
  SNAPSHOT_FILE,
  type SnapshotPin,
  type StickyBudget,
  type StickyPiece,
  type StickyRef,
  type StickyRound,
  type StickyState,
  beatHeartbeat,
  claimIssue,
  claimTtlFault,
  deriveIssueSpec,
  parseDurationMs,
  reclaimIssue,
  requireRunnerLogin,
  runDirDisplay,
  runDirPath,
  runnerLoginFault,
  sha256,
  shortSha,
  transitionIssue,
  triageIssue,
  verifyIssueSnapshot,
} from '../issue-run.js';
import { AGENT_MODELS, type AgentModel, assertAgentModel } from '../models.js';
import { type Reporter, createReporter } from '../output.js';
import { PLUGIN_DIR_ENV } from '../plugin-dir.js';
import {
  type Attestation,
  type PullRequestReport,
  type PullRequestRound,
  pullRequestTitle,
  renderPullRequestBody,
} from '../pr-body.js';
import {
  type ArgumentSpec,
  type BooleanFlagSpec,
  type Command,
  type Ctx,
  type EnvSpec,
  type FlagSpec,
  type ValueFlagSpec,
  type ValueType,
  countValue,
  directoryValue,
  modelValue,
  parseInvocation,
  registerCommand,
} from '../registry.js';
import { RUN_DIR, newRunId, readRuns, updateRun } from '../runs-store.js';
import {
  STANDARDS_PATH,
  type Standards,
  countOf,
  loadStandards,
  readStandardsText,
} from '../standards.js';
import {
  PROGRAM,
  type Progress,
  type Viewport,
  plainText,
  progressStream,
  renderCommandHelp,
  renderTable,
  startProgress,
  truncate,
  wrapList,
  wrapText,
} from '../usage.js';
import { positionalTokens } from './resume.js';
import { progressPage, runCommand } from './run.js';
import { cell } from './runs.js';

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How many issues one pass works (C10).
 *
 * One, because the constraint that actually binds is human review bandwidth: a
 * pass that opens six pull requests has not made six decisions easier to make.
 */
const DEFAULT_MAX_ISSUES = 1;

/** Rounds one issue may be judged over before its run is stopped (C9). */
const DEFAULT_MAX_ROUNDS = 12;

/** US dollars one issue may cost before its run is stopped (C9). */
const DEFAULT_MAX_COST = 10;

/** What the progress line says while a pass runs. */
const PROGRESS_MESSAGE = 'Working';

/**
 * The variables that carry authority over a repository, kept out of the loop.
 *
 * C3 says subagents never touch the remote or the GitHub API, and that the
 * write-safety rules are mechanisms in code rather than instructions in
 * prompts. A prompt saying "do not call GitHub" is an instruction. Not handing
 * the session a credential is a mechanism: a builder that went looking for the
 * API would find nothing to authenticate with, whatever it had been told.
 *
 * These are the names the token-resolution chain reads — `src/github.ts`'s own
 * `GITHUB_TOKEN`, and the three more that `gh` answers to, since `gh auth
 * token` is the other half of that chain. Everything else a builder
 * legitimately needs is left exactly as it was: PATH, HOME, the Anthropic
 * credential the SDK authenticates with, proxy settings, the lot.
 */
const CREDENTIAL_ENV: readonly string[] = [
  TOKEN_ENV,
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];

/**
 * The environment the loop runs in: this one, minus the runner's authority.
 *
 * Matched without regard to case, because Windows environment names are
 * case-insensitive and a variable that arrives as `Github_Token` is the same
 * variable.
 *
 * **The honest residual**, which `work --help` also states: this removes the
 * *environment* route to a credential and nothing else. A machine with `gh`
 * logged in, or a git credential helper configured, hands one out to anything
 * that asks — and that is the operator's configuration, outside what a process
 * can revoke for its own children.
 */
function withoutCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const secret = new Set(CREDENTIAL_ENV.map((name) => name.toLowerCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!secret.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

/**
 * What this runner's own bookkeeping lives in, which is not the repository's work.
 *
 * Handed to every git context this command builds, and it has to be every one:
 * the directory does not make the work tree unclean, and it is never staged.
 * Without the first, a fresh adopter whose repository has no `.gitignore` is
 * refused by the runner's own snapshot the moment it writes one — which is
 * exactly what a live pass found, and what every fixture here hid by carrying a
 * `.gitignore` that already excluded it. Without the second, the same
 * bookkeeping would ride into somebody's pull request.
 *
 * A repository that *does* ignore the directory is unaffected: git was never
 * going to report an ignored path either way.
 */
const IGNORED_BY_THE_RUNNER: readonly string[] = [RUN_DIR];

/** The label that makes an issue eligible: a maintainer's act, and nothing else. */
const READY = lifecycleLabel('ready');

/** The label a claimed issue carries, and the one recovery looks for (C7). */
const WORKING = lifecycleLabel('working');

/* -------------------------------------------------------------------------- */
/* Values the flags take                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A model family, which is all the Claude Agent SDK can pin a subagent to.
 *
 * The list and the check are `src/models.ts`'s, which is where `run` takes them
 * from as well, so what these flags accept and what the run they hand off to
 * accepts are the same set by construction. The rejection probe is a real model
 * id, because a versioned id is exactly what a family flag has to refuse.
 */
const familyValue: ValueType<AgentModel> = {
  arg: 'family',
  choices: AGENT_MODELS,
  invalid: 'claude-opus-5',
  parse: (raw, ctx) => assertAgentModel(raw, ctx.flag, ctx.usage),
};

/**
 * A claim TTL (C7): how long a claim may go without a heartbeat.
 *
 * The judgement is `src/issue-run.ts`'s, so a duration refused here is refused
 * for the same reason the module that acts on one refuses it. What this adds is
 * the shape a rejection takes on a command line — the value quoted back, the
 * flag as the user wrote it, and the usage line under it.
 */
const durationValue: ValueType<number> = {
  arg: 'duration',
  invalid: 'forever',
  parse(raw, ctx) {
    const why = claimTtlFault(raw);
    const ms = parseDurationMs(raw);
    if (why !== undefined || ms === undefined) {
      throw new UsageError(
        [
          'invalid value "' +
            plainText(raw) +
            '" for ' +
            ctx.flag +
            ': ' +
            (why ?? 'it is not a duration'),
          '  a claim whose heartbeat is older than this may be taken over',
        ].join('\n'),
        usageFor(ctx.flag, ctx.usage),
      );
    }
    return ms;
  },
};

/**
 * The account this runner posts as (addendum v0.1.2).
 *
 * Needed when GitHub will not name the token — an installation or Actions token
 * is refused `GET /user` outright — and refused when it is not something a
 * comment's author could ever be, because being compared against a comment's
 * author is the whole of what it is for.
 */
const loginValue: ValueType<string> = {
  arg: 'login',
  invalid: 'not a login',
  parse(raw, ctx) {
    const why = runnerLoginFault(raw);
    if (why !== undefined) {
      throw new UsageError(
        [
          'invalid value "' + plainText(raw) + '" for ' + ctx.flag + ': ' + why,
          '  it is compared against the author of every comment on the issue',
        ].join('\n'),
        usageFor(ctx.flag, ctx.usage),
      );
    }
    return raw.trim();
  },
};

/** One issue named on the command line (R2). */
export interface IssueTarget {
  /** The repository, when the reference named one. */
  repo: Repo | undefined;
  /** The host it was written against, when it was written as a URL. */
  host: string | undefined;
  number: number;
}

/**
 * The repository a git remote URL names, or one clause saying why it names none.
 *
 * Every way of spelling a remote ends the same way — `…/owner/name(.git)` — so
 * the answer is the last two path segments, whatever came before them:
 *
 *     https://github.com/cli/cli.git      git@github.com:cli/cli.git
 *     ssh://git@github.com/cli/cli        /srv/mirrors/cli/cli.git
 *
 * The scp-like form is the one that needs saying out loud: `git@host:cli/cli`
 * has no scheme and its colon is the separator, so what follows the last colon
 * is the path. Everything else is a matter of splitting on separators and
 * dropping what is empty.
 *
 * A local path answers too, from the directories it sits in, because that is
 * the best evidence there is about a clone nobody can ask a host about — and
 * because the alternative, refusing every checkout whose remote is not a URL,
 * would refuse mirrors and `insteadOf` rewrites that are perfectly ordinary.
 *
 * It lives here rather than in `src/git.ts` because this is the only caller and
 * the question is this command's: which repository is this checkout *of*. If a
 * second command ever needs it, that is the moment it belongs beside
 * {@link remoteUrls}, which is where the URL comes from.
 */
export function repoFromRemoteUrl(url: string): Repo | string {
  const trimmed = url.trim();
  if (trimmed === '') return 'the remote has no URL';

  /*
   * The path half, which is the only half that names anything.
   *
   * Three shapes, and each drops something different. A real URL drops its
   * scheme *and its authority* — `https://github.com/cli` names no repository,
   * and reading `github.com` as the owner would be this deciding that it did. A
   * scheme-less URL with a colon is git's scp-like spelling, where the colon
   * rather than a slash separates host from path — but `C:\mirrors\…` is a
   * Windows drive and not that. Anything else is already a path.
   */
  let path: string;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
    const authority = trimmed.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '');
    const slash = authority.indexOf('/');
    path = slash === -1 ? '' : authority.slice(slash + 1);
  } else if (/^[^/\\]*:/.test(trimmed) && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    path = trimmed.slice(trimmed.indexOf(':') + 1);
  } else {
    path = trimmed;
  }

  const segments = path
    .replace(/[?#].*$/, '')
    .split(/[/\\]/)
    .filter((segment) => segment !== '' && segment !== '.');
  const name = (segments.pop() ?? '').replace(/\.git$/i, '');
  const owner = segments.pop() ?? '';
  if (owner === '' || name === '') {
    return 'it names no owner and repository: a remote ends in owner/name';
  }

  const why = repoFault(owner + '/' + name);
  return why === undefined ? { owner, name } : 'the repository it names is not one: ' + why;
}

/**
 * Whether an issue URL was written against the host this run talks to.
 *
 * GitHub's API and its pages are different hostnames for one service, so the
 * `api.` is dropped before the comparison and `www.` with it; a GitHub
 * Enterprise appliance serves both from one host and needs neither. What this
 * refuses is the other thing entirely: a URL on somebody else's host that
 * happens to spell a path this run would recognise.
 */
export function sameHost(apiUrl: string, host: string): boolean {
  const bare = (name: string): string =>
    name.toLowerCase().replace(/^www\./, '').replace(/^api\./, '');
  try {
    return bare(new URL(apiUrl).hostname) === bare(host);
  } catch {
    return false;
  }
}

const ISSUE_URL = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/issues\/(\d{1,9})(?:[/?#].*)?$/;
const ISSUE_REF = /^([^/\s#]+)\/([^/\s#]+)#(\d{1,9})$/;
const ISSUE_NUMBER = /^#?(\d{1,9})$/;

/**
 * `text` as the issue it names, or one clause saying why it names none.
 *
 * Three spellings, because those are the three a person has to hand: the page
 * they are looking at, the reference GitHub writes in prose, and the number they
 * remember. A bare number needs the allowlist to name exactly one repository,
 * and that is settled where the allowlist is; this only reads the text.
 *
 * The host of a URL is not checked against anything. What a run may touch is the
 * allowlist (C5), and that is where the check belongs — refusing a URL for its
 * host as well would mean a GitHub Enterprise address had to be taught to this
 * regular expression before a repository the operator explicitly allowlisted
 * could be worked.
 */
export function readIssueTarget(text: string): IssueTarget | string {
  const written = text.trim();
  if (written === '') return 'it is empty';

  const url = written.match(ISSUE_URL);
  if (url !== null) {
    const why = repoFault((url[2] ?? '') + '/' + (url[3] ?? ''));
    if (why !== undefined) return 'the repository in that URL is not one: ' + why;
    // The host is carried rather than dropped. Which host a URL was written
    // against is the difference between this run's GitHub and somebody else's,
    // and the check belongs where the configured host is known.
    return {
      repo: { owner: url[2] ?? '', name: url[3] ?? '' },
      host: (url[1] ?? '').replace(/:\d+$/, ''),
      number: Number(url[4]),
    };
  }

  const ref = written.match(ISSUE_REF);
  if (ref !== null) {
    const why = repoFault((ref[1] ?? '') + '/' + (ref[2] ?? ''));
    if (why !== undefined) return 'the repository in that reference is not one: ' + why;
    return {
      repo: { owner: ref[1] ?? '', name: ref[2] ?? '' },
      host: undefined,
      number: Number(ref[3]),
    };
  }

  const bare = written.match(ISSUE_NUMBER);
  if (bare !== null) {
    const number = Number(bare[1]);
    if (number < 1) return 'an issue number is a whole number above zero';
    return { repo: undefined, host: undefined, number };
  }

  return 'an issue is written 801, owner/name#801, or as the URL of its page';
}

const issueValue: ValueType<IssueTarget> = {
  arg: 'issue',
  invalid: 'not-an-issue',
  parse(raw, ctx) {
    const read = readIssueTarget(raw);
    if (typeof read === 'string') {
      throw new UsageError(
        [
          'invalid value "' + plainText(raw) + '" for ' + ctx.flag + ': ' + read,
          '  the repository it names still has to be allowlisted for this run',
        ].join('\n'),
        usageFor(ctx.flag, ctx.usage),
      );
    }
    return read;
  },
};

/* -------------------------------------------------------------------------- */
/* Flags                                                                       */
/* -------------------------------------------------------------------------- */

const repoFlag: ValueFlagSpec<Repo> = {
  long: 'repo',
  short: 'R',
  value: repoValue,
  summary: 'Allowlist one repository; repeat it to allowlist more',
};

const directoryFlag: ValueFlagSpec<string> = {
  long: 'directory',
  short: 'C',
  value: directoryValue,
  summary: 'Work in dir instead of the current directory',
};

const runnerLoginFlag: ValueFlagSpec<string> = {
  long: RUNNER_LOGIN_FLAG.replace(/^--/, ''),
  value: loginValue,
  summary: 'The account this runner posts as, when GitHub will not name the token',
};

const claimTtlFlag: ValueFlagSpec<number> = {
  long: 'claim-ttl',
  value: durationValue,
  summary: 'Take a claim over once its heartbeat is older than duration',
  default: '24h',
};

const maxIssuesFlag: ValueFlagSpec<number> = {
  long: 'max-issues',
  value: countValue,
  summary: 'Work at most int issues in this pass',
  default: DEFAULT_MAX_ISSUES,
};

const maxRoundsFlag: ValueFlagSpec<number> = {
  long: 'max-rounds',
  value: countValue,
  summary: 'Stop each issue once int rounds have been judged',
  default: DEFAULT_MAX_ROUNDS,
};

const maxCostFlag: ValueFlagSpec<number> = {
  long: 'max-cost',
  value: costValue,
  summary: 'Stop each issue once it has cost usd dollars',
  default: DEFAULT_MAX_COST,
};

const maxTurnsFlag: ValueFlagSpec<number> = {
  long: 'max-turns',
  value: countValue,
  summary: 'Stop each issue after int agent turns',
};

const modelFlag: ValueFlagSpec<string> = {
  long: 'model',
  short: 'm',
  value: modelValue,
  summary: 'Model id for the lead agent',
  default: 'inherit',
};

const builderModelFlag: ValueFlagSpec<AgentModel> = {
  long: 'builder-model',
  value: familyValue,
  summary: 'Model family for builder subagents',
  default: 'inherit',
};

const criticModelFlag: ValueFlagSpec<AgentModel> = {
  long: 'critic-model',
  value: familyValue,
  summary: 'Model family for critic subagents',
  default: 'inherit',
};

const pluginDirFlag: ValueFlagSpec<string> = {
  long: 'plugin-dir',
  value: directoryValue,
  summary: 'Read the plugin markdown from dir, overriding ' + PLUGIN_DIR_ENV,
};

const dryRunFlag: BooleanFlagSpec = {
  long: 'dry-run',
  summary: 'Print the pickup plan and each derived spec, and touch nothing',
};

const verboseFlag: BooleanFlagSpec = {
  long: 'verbose',
  short: 'v',
  summary: 'Print what the agents wrote, in full',
};

const flags: FlagSpec[] = [
  builderModelFlag,
  claimTtlFlag,
  criticModelFlag,
  directoryFlag,
  dryRunFlag,
  maxCostFlag,
  maxIssuesFlag,
  maxRoundsFlag,
  maxTurnsFlag,
  modelFlag,
  pluginDirFlag,
  repoFlag,
  runnerLoginFlag,
  verboseFlag,
];

const issueArgument: ArgumentSpec<IssueTarget> = {
  name: 'issue-url-or-number',
  value: issueValue,
};

const reposEnv: EnvSpec<Repo[]> = {
  name: REPOS_ENV,
  value: reposValue,
  overriddenBy: repoFlag,
};

const runnerLoginEnv: EnvSpec<string> = {
  name: RUNNER_LOGIN_ENV,
  value: loginValue,
  overriddenBy: runnerLoginFlag,
};

const pluginDirEnv: EnvSpec<string> = {
  name: PLUGIN_DIR_ENV,
  value: directoryValue,
  overriddenBy: pluginDirFlag,
};

/* -------------------------------------------------------------------------- */
/* The command                                                                 */
/* -------------------------------------------------------------------------- */

const workCommand: Command = {
  name: 'work',
  summary: 'Work the ready issues in one pass, and open a pull request for each',
  usage: PROGRAM + ' work [<issue-url-or-number>] [flags]',
  group: 'core',
  description: [
    'Work the ready issues in one pass, and open a pull request for each.',
    'One pass, then exit. Scheduling belongs to cron or to a GitHub Actions workflow: a\nsingle pass on a timer is the whole deployment story, and there is no daemon, no\npoller and no --interval here.',
    'Only issues in an allowlisted repository are ever looked at, and only ones carrying\n' +
      READY +
      '. The allowlist is named per invocation — --repo owner/name, which may be\nrepeated, or ' +
      REPOS_ENV +
      ' as a comma-separated list — and naming none is an error\nrather than an invitation: an empty allowlist never means every repository the token\ncan see. Applying the ready label is a maintainer\'s act, and it is the whole of what\nauthorizes a run.',
    'Given an issue, work runs that one immediately and skips the queue. It is written\n801, owner/name#801, or as the URL of the issue\'s page, and its repository still has\nto be allowlisted.',
    'Per issue: the issue, its labels and its whole comment thread are snapshotted and\npinned by sha256 under ' +
      RUN_DIR +
      '/runs/, the label moves to ' +
      WORKING +
      ' and a\nstatus comment is posted, a branch is cut, and the loop runs against the snapshot as\nits spec with this repository\'s ' +
      STANDARDS_PATH +
      ' supplying the standing gates.\nThe status comment is edited in place every round — never repeated — and carries the\nphase, the pieces, the verdicts, the budget and a UTC heartbeat another runner can\nread.',
    'An issue with no checkable acceptance criteria is not guessed at. work posts a\ncomment naming exactly what is missing, moves the label to triage, and goes on to the\nnext issue without claiming anything.',
    'On a win the branch is pushed and a pull request is opened against the default\nbranch, carrying the issue link, the verdict history, the integrity attestations and\nthe budget; the label moves to review. On a block or a spent budget the work is never\ndiscarded: the branch is pushed anyway, a draft pull request carries the reason, the\nlabel moves to blocked, and the status comment says exactly what a human has to\ndecide. Nothing here merges, approves or closes anything.',
    'Every write needs an account this run can prove it is. A user token answers for\nitself; an installation or Actions token, which GitHub refuses GET /user, has to be\nnamed with ' +
      RUNNER_LOGIN_FLAG +
      ' or ' +
      RUNNER_LOGIN_ENV +
      '. Without one the pass exits\n2 at startup, before an issue is read or a label is touched.',
    '--dry-run prints the pickup plan and the spec it would derive from each issue, and\ntouches nothing: no labels, no comments, no branch, no pull request, and every request\nit makes is a GET. It needs no runner login, because it decides nothing.',
    'Budgets are per issue and are never unlimited: --max-rounds and --max-cost both have\ndefaults, and exhausting either stops that issue cleanly and reports it rather than\nretrying. --max-issues is the work-in-progress cap, and it defaults to one because the\nconstraint that binds is human review bandwidth.',
    'It exits 0 when every issue it worked reached a pull request or a clean triage, 1\nwhen at least one was blocked, stopped at its budget, or left for the next pass, and\n2 for a usage, configuration or authentication error. A pass that found nothing\neligible has done its job and exits 0 — but an issue named on the command line that\ncannot be worked exits 1, because somebody asked for that one thing and did not get\nit.',
    'A GitHub blip is never a 2. Nothing answering, a rate limit, or a 5xx from GitHub is\nnothing the invocation could fix, so the pass reports that it did not finish and the\nnext one picks up; a token that is rejected or lacks a permission is a 2, and says\nwhich permission a workflow has to grant.',
  ],
  flags,
  argument: issueArgument,
  env: [pluginDirEnv, reposEnv, runnerLoginEnv],
  cwdFlag: directoryFlag,
  sections: [
    {
      title: 'LABELS',
      lines: [
        ...wrapList(LIFECYCLE_LABELS, 2),
        '',
        ...wrapText(
          'The whole of the namespace this tool touches. ' +
            READY +
            ' is applied by a maintainer and is the only thing that makes an issue ' +
            'eligible; the other four are written by this command as it goes. No ' +
            'label outside the prefix is ever added or removed, and the issue body ' +
            'is never edited.',
          78,
          2,
        ),
      ],
    },
    {
      title: 'SAFETY',
      lines: [
        ...wrapText(
          'One branch per issue, named exolvra-genesis/issue-<number>-<slug>, cut ' +
            'from whatever is checked out. Nothing here pushes to a default or ' +
            'protected branch, force-pushes, merges, approves or closes anything, ' +
            'and no subagent ever reaches the remote or the GitHub API: every ' +
            'branch, commit, push, comment, label move and pull request is made by ' +
            'this command itself.',
          78,
          2,
        ),
        '',
        ...wrapText(
          'Issue text is untrusted input. It is snapshotted and judged against, ' +
            'never interpolated into a command, and anything shaped like a ' +
            'credential is removed before it reaches a comment, a pull request ' +
            'body, a run record or this terminal.',
          78,
          2,
        ),
        '',
        ...wrapText(
          'The work tree has to be clean before an issue is claimed, so whatever ' +
            'is in it when the loop finishes is what the loop did.',
          78,
          2,
        ),
        '',
        ...wrapText(
          'The loop runs without the GitHub credential: ' +
            CREDENTIAL_ENV.join(', ') +
            ' are removed from the environment the session is given, so a builder ' +
            'has nothing to authenticate to the API or a remote with. That covers ' +
            'the environment and nothing else — a machine where `gh` is logged in, ' +
            'or with a git credential helper configured, hands a credential to ' +
            'anything that asks, and that is the operator\'s configuration rather ' +
            'than something this process can revoke for its own children.',
          78,
          2,
        ),
      ],
    },
    {
      title: 'THE LOOP',
      lines: [
        ...wrapText(
          'Each issue is run by `' +
            PROGRAM +
            ' run` itself — the same command, the same plugin markdown, the same ' +
            'run ledger and the same exit-code contract — with the pinned snapshot ' +
            'as its spec and this pass\'s budget as its limits. So `' +
            PROGRAM +
            ' runs` and `' +
            PROGRAM +
            ' resume` work on an issue run unchanged, and there is no second ' +
            'implementation of the loop to keep in step with the first.',
          78,
          2,
        ),
        '',
        ...wrapText(
          'The saved config is neither read nor written: a scheduled runner\'s ' +
            'models come from its own flags, so two machines running the same ' +
            'workflow run the same thing.',
          78,
          2,
        ),
      ],
    },
  ],
  examples: [
    PROGRAM + ' work --repo cli/cli',
    PROGRAM + ' work --repo cli/cli --dry-run',
    PROGRAM + ' work cli/cli#801 --repo cli/cli --max-rounds 20 --max-cost 25',
    PROGRAM + ' work --repo cli/cli --runner-login exolvra-genesis[bot]',
  ],
  run: runWork,
};

registerCommand(workCommand);

export { workCommand };

/**
 * The same command with its argument taken off, for a pass over the queue.
 *
 * The registry's rule is that a declared argument is required, which is right: a
 * command that quietly accepts a missing argument cannot report a missing one.
 * Optional here means exactly two invocations — a pass, and one named issue —
 * and each is parsed against what it really takes, so the reference is still
 * validated at the same boundary every other value is.
 */
const withoutArgument: Command = { ...workCommand, argument: undefined };

/* -------------------------------------------------------------------------- */
/* Reading the machine stream the loop writes                                  */
/* -------------------------------------------------------------------------- */

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const VERDICT_WORDS: readonly string[] = ['WIN', 'LOSS', 'BLOCKED'];
const STATUS_WORDS: readonly string[] = ['win', 'loss', 'blocked', 'stopped'];

/**
 * One line of the stream `run --json` writes, as the event it stands for.
 *
 * That stream is a published interface — one JSON object per line, and a last
 * line of exactly four fields for a CI job to read the outcome off — so reading
 * it is what any other consumer of this CLI would do rather than a look inside
 * the run. Only the fields this command acts on are read, so a field added later
 * passes through without comment, and a line that is not an event this build
 * knows is skipped rather than guessed at.
 *
 * The summary is the one record written without a `type`, because it *is* the
 * summary; that is what identifies it here.
 */
export function readEvent(line: string): RunEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const fields = asObject(parsed);
  if (fields === undefined) return undefined;

  const type = str(fields['type']);
  if (type === undefined) {
    const status = str(fields['status']);
    if (status === undefined || !STATUS_WORDS.includes(status)) return undefined;
    const session = str(fields['session_id']);
    return {
      type: 'run_finished',
      status: status as RunStatus,
      rounds: num(fields['rounds']) ?? 0,
      costUsd: num(fields['cost_usd']) ?? 0,
      ...(session === undefined || session === '' ? {} : { sessionId: session }),
    };
  }

  if (type === 'run_started') {
    const goal = str(fields['goal']);
    if (goal === undefined) return undefined;
    return { type, goal, source: str(fields['source']) === 'spec' ? 'spec' : 'goal' };
  }
  if (type === 'bar_captured') {
    return {
      type,
      path: str(fields['path']) ?? '',
      artifacts: list(fields['artifacts']).map((item) => {
        const artifact = asObject(item);
        const detail = str(artifact?.['detail']);
        return {
          path: str(artifact?.['path']) ?? '',
          ...(detail === undefined ? {} : { detail }),
        };
      }),
    };
  }
  if (type === 'plan_ready') {
    return {
      type,
      pieces: list(fields['pieces']).map((item) => {
        const piece = asObject(item);
        return { id: str(piece?.['id']) ?? '', title: str(piece?.['title']) ?? '' };
      }),
    };
  }
  if (type === 'round') {
    const verdict = str(fields['verdict']);
    const round = num(fields['round']);
    if (verdict === undefined || !VERDICT_WORDS.includes(verdict) || round === undefined) {
      return undefined;
    }
    const gap = str(fields['gap']);
    const elapsed = num(fields['elapsed_ms']);
    return {
      type,
      piece: str(fields['piece']) ?? '',
      round,
      verdict: verdict as Verdict,
      ...(gap === undefined || gap === '' ? {} : { gap }),
      ...(elapsed === undefined ? {} : { elapsedMs: elapsed }),
    };
  }
  if (type === 'agent_output') {
    return { type, agent: str(fields['agent']) ?? '', text: str(fields['text']) ?? '' };
  }
  if (type === 'notice') {
    const level = str(fields['level']);
    return {
      type,
      level: level === 'warning' || level === 'error' ? level : 'note',
      message: str(fields['message']) ?? '',
    };
  }
  return undefined;
}

/** A stream, and the one extra thing this command needs from the one it makes. */
interface LineStream extends NodeJS.WritableStream {
  /** Hands over whatever was written without a newline after it. */
  end(): this;
}

/**
 * A stream that hands every complete line to `onLine`, synchronously.
 *
 * The loop's report has to be read as it happens — a heartbeat beaten after the
 * run is over is not a heartbeat — so each line is delivered inside the write
 * that produced it rather than on a later tick. It is an adapter between two
 * parts of this process and nothing more: no output is invented, dropped or
 * reordered, and what the run wrote is exactly what arrives.
 */
function lineStream(onLine: (line: string) => void): LineStream {
  let held = '';
  const sink = {
    write(chunk: unknown): boolean {
      held += typeof chunk === 'string' ? chunk : String(chunk);
      for (let at = held.indexOf('\n'); at !== -1; at = held.indexOf('\n')) {
        const line = held.slice(0, at).replace(/\r$/, '');
        held = held.slice(at + 1);
        if (line.trim() !== '') onLine(line);
      }
      return true;
    },
    end(): unknown {
      if (held.trim() !== '') onLine(held);
      held = '';
      return sink;
    },
  };
  return sink as unknown as LineStream;
}

/* -------------------------------------------------------------------------- */
/* What one issue came to                                                      */
/* -------------------------------------------------------------------------- */

/** How one issue ended, in the words the summary and R11 both use. */
type IssueResult = 'review' | 'triaged' | 'skipped' | 'blocked' | 'retry' | 'ineligible';

/**
 * What each ending means for the pass's exit code (R11).
 *
 * **One table, and the summary row is the same word.** The row a person reads
 * and the code a scheduler reads are two renderings of this single value, so
 * they cannot come to disagree — which they did: an issue whose claim failed
 * printed `blocked` on stdout while the process exited 2, telling a reader and
 * a cron job two different stories about one issue.
 *
 * - `review` — a pull request is open and waiting on a human. Done (R11: 0).
 * - `triaged` — the issue was underspecified and said so. Done (R11: 0).
 * - `skipped` — nothing was worked and nothing was left behind: another runner
 *   owns it, or the claim did not land (C6). Nothing to report, and nothing
 *   went wrong that this pass can act on.
 * - `blocked` — work exists and a human has to settle something (R11: 1).
 * - `retry` — the work is safe and the issue is back in the queue, but it did
 *   not reach a pull request. A scheduler that read 0 here would be told
 *   everything was fine (R11: 1).
 * - `ineligible` — an issue that may not be worked: one named on the command
 *   line that is not eligible, or one whose branch this runner may not write. A
 *   pass that finds nothing to do has done its job, but an issue it was pointed
 *   at and could not work is not nothing, and a runner reporting 0 for it would
 *   be green forever having worked nothing. Only a person changes it, which is
 *   the decision R11's 1 is for.
 *
 * A `satisfies` on the table is what keeps it total: an ending added to the
 * union and not to it does not compile.
 */
export const ISSUE_EXIT = {
  review: EXIT.WIN,
  triaged: EXIT.WIN,
  skipped: EXIT.WIN,
  blocked: EXIT.LOSS,
  retry: EXIT.LOSS,
  ineligible: EXIT.LOSS,
} as const satisfies Record<IssueResult, number>;

interface IssueOutcome {
  repo: Repo;
  issue: number;
  result: IssueResult;
  /**
   * The lifecycle label the repository actually holds afterwards.
   *
   * Read back rather than assumed. What this run *meant* to set is not a fact
   * about the repository, and a summary that printed the intention told a
   * reader the issue was in review while the server still had it claimed.
   */
  label?: Lifecycle;
  /**
   * Set when the public status comment could not be brought up to date.
   *
   * The comment is the only surface a person reads, so a run that could not
   * correct it is a run whose public account of itself is wrong. That fact
   * survives here, in the summary row and in the run record, rather than only
   * in two warnings on a terminal nobody kept.
   */
  stale?: string;
  /** One line for the summary: what was opened, or why nothing was. */
  detail: string;
  /** True when the pass must not go on to another issue. */
  halt?: boolean;
}

/**
 * The pass's code, off the endings it actually reached (R11).
 *
 * Nothing else feeds it. A fault that stops the pass is raised rather than
 * turned into a row, so it carries its own code out through the entry point and
 * no row is invented to describe it.
 */
export function passExitCode(outcomes: readonly IssueOutcome[]): number {
  return outcomes.some((outcome) => ISSUE_EXIT[outcome.result] !== EXIT.WIN)
    ? EXIT.LOSS
    : EXIT.WIN;
}

/**
 * The pass's code, given its rows and a fault that ended it.
 *
 * One rule with one documented override, so what a reader is shown and what a
 * scheduler acts on are never two independent decisions. A configuration or
 * authentication fault outranks the tally because it is about a different
 * subject: the rows say what became of each issue, and a 2 says the invocation
 * — the token, the workflow's permissions — has to change before any of it can
 * work. Both can be true at once, and both are printed.
 */
export function passExit(
  outcomes: readonly IssueOutcome[],
  fatal: unknown | undefined,
): number {
  return fatal === undefined ? passExitCode(outcomes) : EXIT.USAGE;
}

/* -------------------------------------------------------------------------- */
/* Small readings of the repository this pass runs in                          */
/* -------------------------------------------------------------------------- */

/** The bytes a hash is taken over: no byte-order mark, one kind of line ending. */
function normalizeText(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** What a standing bar is pinned as, for the attestations and the body. */
interface StandardsPin {
  path: string;
  sha256: string;
  gates: number;
  standingBar: number;
}

/** The repository's standing bar, its hash, and what it holds (R3). */
function readStandards(cwd: string): { standards: Standards | null; pin?: StandardsPin } {
  const standards = loadStandards(cwd);
  if (standards === null) return { standards: null };
  return {
    standards,
    pin: {
      path: STANDARDS_PATH,
      sha256: sha256(normalizeText(readStandardsText(cwd) ?? '')),
      gates: standards.gates.length,
      standingBar: standards.standingBar.length,
    },
  };
}

/** The bar the loop pinned for this run, when it left one behind. */
function readBarPin(cwd: string): { path: string; pins: number } | undefined {
  try {
    const text = readFileSync(join(cwd, RUN_DIR, 'bar', 'bar.sha256'), 'utf8');
    return {
      path: RUN_DIR + '/bar/bar.sha256',
      pins: text.split('\n').filter((line) => /^[0-9a-f]{64}\s/.test(line.trim())).length,
    };
  } catch {
    return undefined;
  }
}

/**
 * Copies the page the loop keeps up to date into this issue run's directory (R7).
 *
 * A copy rather than a second page. R7 asks for the same template and the same
 * JSON contract as an interactive run, and the surest way to have those is to
 * have the very bytes the loop wrote. It is taken after every round, so the
 * per-run page moves with the run instead of appearing once at the end.
 */
function copyProgressPage(cwd: string, runId: string): void {
  try {
    const to = join(runDirPath(cwd, runId), basename(progressPage(cwd, cwd)));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(cwd, progressPage(cwd, cwd)), to);
  } catch {
    // The loop writes the page when it has one to write; before then there is
    // nothing to copy, and a missing page is not a reason to stop a run.
  }
}

/** Where the per-run page sits, as prose and a status comment name it. */
function progressPagePath(cwd: string, runId: string): string {
  return runDirDisplay(runId) + '/' + basename(progressPage(cwd, cwd));
}

/**
 * A git context for the questions that are about the checkout rather than about
 * a repository.
 *
 * `repoRoot` and `assertCleanTree` read git and write nothing, so the guard —
 * which exists to refuse a write to the wrong branch — is never consulted by
 * either. It is still filled in, and filled in to refuse: `**` is GitHub's own
 * spelling for every branch there is, so anything that ever tried to write
 * through this context would be refused rather than quietly allowed. A context
 * that can only read says so in its value.
 */
function readOnlyCheckout(cwd: string): GitContext {
  return {
    cwd,
    repo: { defaultBranch: '', protectedBranches: ['**'], repo: 'this checkout' },
    ignorePaths: IGNORED_BY_THE_RUNNER,
  };
}

/**
 * The local preconditions, checked before the pass touches anything at all.
 *
 * Both are facts about the checkout that are true before a single request is
 * made: this is a work tree, and there is nothing uncommitted in it. Finding
 * that out *after* claiming an issue — which is where it used to be found — put
 * the issue on `exolvra:blocked` and asked a person to reset a tree the runner
 * could have looked at first, having already written three times to somebody's
 * repository for nothing.
 *
 * So it happens here: before the allowlist is even read from GitHub, before a
 * token is resolved, and therefore with no request made and no label touched.
 * The clean tree is also what makes the commit at the end honest — whatever is
 * in the tree when the loop finishes is what the loop did.
 */
function assertCheckoutReady(cwd: string): Repo {
  const git = readOnlyCheckout(cwd);
  repoRoot(git);
  assertCleanTree(git);

  /*
   * And HEAD has to be on a branch.
   *
   * Every issue branch is cut from wherever HEAD is standing, and it cannot be
   * cut from nowhere — so a detached HEAD is a pass that can do nothing, and it
   * used to do nothing quietly: the issues stayed eligible, the pass exited 0,
   * and a scheduled runner reported success forever while working nothing. It
   * is a local fact, knowable here, and it is named here with what to do about
   * it.
   */
  if (currentBranch(git) === undefined) {
    throw new ConfigError(
      [
        'refusing to start on a detached HEAD',
        '  every issue branch is cut from the branch that is checked out, and there',
        '  is none: HEAD is on a commit',
        '  check out the branch this work should start from, then run again',
      ].join('\n'),
    );
  }

  /*
   * And which repository this checkout *is*.
   *
   * The whole of a pass happens in one work tree: it commits there and pushes
   * to that tree's own remote. Nothing used to tie that to the issue it had
   * claimed, so a pass given `--repo octocat/hello-world` in a checkout of
   * cli/cli claimed octocat's issue, handed a builder cli/cli's tree, pushed
   * the branch into cli/cli's remote, and opened a pull request on octocat for
   * a branch that was never there. Every one of those steps was individually
   * correct; nothing asked whether they were about the same repository.
   *
   * `origin` is what answers that, and a checkout with no origin cannot answer
   * it at all — which is a refusal here, for the same reason a detached HEAD
   * is: local, knowable, and nothing to do with anybody's repository yet.
   */
  const origin = remoteUrls(git).fetch;
  const mine = repoFromRemoteUrl(origin);
  if (typeof mine === 'string') {
    throw new ConfigError(
      [
        'refusing to start in a checkout whose repository cannot be told',
        '  origin is ' + plainText(origin),
        '  ' + mine,
        '  a pass commits in this checkout and pushes to its own remote, so it',
        '  works the issues of the repository that remote names and no others',
      ].join('\n'),
    );
  }
  return mine;
}

/* -------------------------------------------------------------------------- */
/* The pull request a pass could not open, kept for the pass that can          */
/* -------------------------------------------------------------------------- */

/** What this file is called, beside the snapshot of the run that wrote it. */
const PENDING_FILE = 'pull-request.json';

/**
 * A pull request that is written but not yet opened.
 *
 * The one piece of state this command keeps between passes, and it exists to
 * stop the runner lying about a merge. When the work is committed and pushed
 * and only the pull request call fails, the honest next step is to *open that
 * pull request* — not to run the loop again, which would stack a second commit
 * on the branch and leave a body attesting one commit and one file while the
 * merge proposed two of each.
 *
 * So the finished evidence is kept exactly as it was rendered, and the next
 * pass opens the pull request from it without touching the branch. Because that
 * pass commits nothing, the head it opens against is the head this one pushed,
 * and the body still describes the whole of what the merge proposes.
 *
 * It lives in the run directory of the run that produced it — beside that run's
 * snapshot and progress page, which are the rest of the same evidence — rather
 * than in a store of its own.
 */
interface PendingPullRequest {
  version: 1;
  repo: string;
  issue: number;
  branch: string;
  base: string;
  draft: boolean;
  title: string;
  body: string;
  /** The commit the body describes: the head of the branch when it was pushed. */
  commit: string;
  runId: string;
  outcome: RunStatus;
  /** What the status comment should go on saying about the run that produced it. */
  budget: StickyBudget;
  rounds: StickyRound[];
  pieces: StickyPiece[];
  decision?: string;
  at: string;
}

/** Where one run keeps the pull request it could not open. */
function pendingPath(cwd: string, runId: string): string {
  return join(runDirPath(cwd, runId), PENDING_FILE);
}

function writePending(cwd: string, pending: PendingPullRequest): void {
  const path = pendingPath(cwd, pending.runId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(pending, null, 2) + '\n', 'utf8');
}

/**
 * The record as a reader may act on it, or `undefined`.
 *
 * Checked field by field. It is this tool's own file, but it is on disk where
 * anything can edit it, and what it decides is which body goes onto somebody's
 * pull request — so it is read as input rather than trusted as memory.
 */
function readPending(path: string): PendingPullRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  const fields = asObject(parsed);
  if (fields === undefined || fields['version'] !== 1) return undefined;

  const text = (key: string): string | undefined => {
    const value = str(fields[key]);
    return value === undefined || value.trim() === '' ? undefined : value;
  };
  const repo = text('repo');
  const branch = text('branch');
  const base = text('base');
  const title = text('title');
  const body = text('body');
  const commit = text('commit');
  const runId = text('runId');
  const at = text('at');
  const issue = num(fields['issue']);
  const outcome = str(fields['outcome']);
  if (
    repo === undefined ||
    branch === undefined ||
    base === undefined ||
    title === undefined ||
    body === undefined ||
    commit === undefined ||
    runId === undefined ||
    at === undefined ||
    issue === undefined ||
    outcome === undefined ||
    !STATUS_WORDS.includes(outcome)
  ) {
    return undefined;
  }

  const budget = asObject(fields['budget']) ?? {};
  const decision = text('decision');
  return {
    version: 1,
    repo,
    issue,
    branch,
    base,
    draft: fields['draft'] === true,
    title,
    body,
    commit,
    runId,
    outcome: outcome as RunStatus,
    budget: {
      rounds: num(budget['rounds']) ?? 0,
      ...(num(budget['maxRounds']) === undefined ? {} : { maxRounds: num(budget['maxRounds']) as number }),
      ...(num(budget['costUsd']) === undefined ? {} : { costUsd: num(budget['costUsd']) as number }),
      ...(num(budget['maxCostUsd']) === undefined
        ? {}
        : { maxCostUsd: num(budget['maxCostUsd']) as number }),
    },
    rounds: list(fields['rounds']).flatMap((entry) => {
      const round = asObject(entry);
      const number = num(round?.['number']);
      const verdict = str(round?.['verdict']);
      if (number === undefined || verdict === undefined) return [];
      const gap = str(round?.['gap']);
      const evidence = str(round?.['evidence']);
      const at_ = str(round?.['at']);
      return [
        {
          number,
          verdict: (VERDICT_WORDS.includes(verdict) ? verdict : 'pending') as StickyRound['verdict'],
          ...(gap === undefined ? {} : { gap }),
          ...(evidence === undefined ? {} : { evidence }),
          ...(at_ === undefined ? {} : { at: at_ }),
        },
      ];
    }),
    pieces: list(fields['pieces']).flatMap((entry) => {
      const piece = asObject(entry);
      const id = str(piece?.['id']);
      if (id === undefined) return [];
      return [{ id, title: str(piece?.['title']) ?? '', state: 'verified' as const }];
    }),
    ...(decision === undefined ? {} : { decision }),
    at,
  };
}

/**
 * The pull request waiting to be opened for this issue, if a pass left one.
 *
 * Every run directory is looked in rather than an index being kept: the runs
 * are already there, there are few of them, and an index is a second thing that
 * can be wrong about the first. The newest wins, which is the one whose branch
 * head was pushed last.
 */
function findPending(cwd: string, repo: Repo, issue: number): { path: string; pending: PendingPullRequest } | undefined {
  const runs = join(cwd, RUN_DIR, RUNS_SUBDIR);
  let entries: string[];
  try {
    entries = readdirSync(runs);
  } catch {
    return undefined;
  }
  const slug = repoSlug(repo).toLowerCase();
  let best: { path: string; pending: PendingPullRequest } | undefined;
  for (const entry of entries) {
    const path = join(runs, entry, PENDING_FILE);
    const pending = readPending(path);
    if (pending === undefined) continue;
    if (pending.repo.toLowerCase() !== slug || pending.issue !== issue) continue;
    if (best === undefined || pending.at > best.pending.at) best = { path, pending };
  }
  return best;
}

function forgetPending(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A record that outlives its pull request is read again and found stale,
    // which is the same answer a moment later.
  }
}

/* -------------------------------------------------------------------------- */
/* The pass                                                                    */
/* -------------------------------------------------------------------------- */

/** Everything one pass settled before it read an issue. */
interface Pass {
  ctx: Ctx;
  cwd: string;
  reporter: Reporter;
  progress: Progress;
  /** Where the inner run's own faults go, with the progress line taken down. */
  err: NodeJS.WritableStream;
  client: GitHubClient;
  /** What each repository says about itself, asked once per pass. */
  repos: Map<string, { info: RepoInfo; git: GitContext }>;
  /** The environment the loop runs in: this one, minus the runner's credential. */
  loopEnv: NodeJS.ProcessEnv;
  identity: RunnerIdentity;
  standards: Standards | null;
  standardsPin: StandardsPin | undefined;
  claimTtlMs: number;
  maxRounds: number;
  maxCostUsd: number;
  maxTurns: number | undefined;
  models: { lead?: string; builder?: string; critic?: string };
  pluginDir: string | undefined;
  verbose: boolean;
  /**
   * A fault that ends the pass, raised once it has finished reporting.
   *
   * Held rather than thrown so the finishing writes an issue is owed still
   * happen and the summary still prints: a person reading a 2 is owed the row
   * about the issue the 2 is about.
   */
  fatal?: ConfigError;
  /** True once a person has asked this pass to stop (R15). */
  interrupted: () => boolean;
  /** Marks the next interrupt as this command's own rather than a person's. */
  markStopping: () => void;
  doneStopping: () => void;
}

async function runWork(argv: string[], ctx: Ctx): Promise<number> {
  const named = positionalTokens(workCommand, argv).length > 0;
  const args = parseInvocation(named ? workCommand : withoutArgument, argv, ctx);

  if (args.help) {
    ctx.stdout.write(renderCommandHelp(workCommand));
    return EXIT.WIN;
  }

  const cwd = args.cwd;
  const view: Viewport = { tty: ctx.isTTY, width: ctx.width };
  const dryRun = args.bool(dryRunFlag);
  const verbose = args.bool(verboseFlag);
  const cap = args.get(maxIssuesFlag) ?? DEFAULT_MAX_ISSUES;

  const repos = resolveAllowlist({
    fromFlags: repeatedFlagValues(workCommand, argv, repoFlag, cwd),
    fromEnv: args.env(reposEnv),
    usage: workCommand.usage,
    flag: args.as(repoFlag),
  });


  // Before the token, before the first request, before anything is claimed: a
  // pass that cannot work in this checkout says so having touched nothing. A
  // dry run makes no local write either, so it is not held to it.
  const checkout = dryRun ? undefined : assertCheckoutReady(cwd);

  // The token is resolved here, before anything is read, so a pass without one
  // fails at the start rather than between two repositories.
  const client = createGitHubClient({ env: ctx.env });

  const target = named ? args.argument(issueArgument) : undefined;
  const wanted =
    target === undefined ? undefined : resolveTarget(target, repos, checkout, client.apiUrl);

  const progress: Progress = startProgress(ctx.stderr, PROGRESS_MESSAGE, ctx.isErrTTY);
  const out = progressStream(ctx.stdout, progress);
  const err = progressStream(ctx.stderr, progress);
  const reporter = createReporter({ json: false, verbose, stream: out, view });
  const { standards, pin: standardsPin } = readStandards(cwd);

  if (dryRun) {
    progress.update(PROGRESS_MESSAGE + ' · reading');
    const plan = await pickup(client, repos, wanted, cap, checkout);
    const derived: { candidate: Candidate; spec: DerivedSpec }[] = [];
    for (const candidate of plan.eligible) {
      const thread = await client.getIssueThread(candidate.repo, candidate.issue.number);
      derived.push({ candidate, spec: deriveIssueSpec(thread, standards) });
    }
    progress.done('Dry run complete');
    out.write(renderDryRun(view, repos, plan, standards, derived).join('\n') + '\n');
    return EXIT.WIN;
  }

  /*
   * The identity, before an issue is read (addendum v0.1.2).
   *
   * Not a courtesy ordering. Every write this pass makes is decided against a
   * status comment it has to recognise as its own, so a run that cannot name
   * itself has no safe decision available to it at all — and the place to say so
   * is here, where nothing has been claimed and the invocation is the only thing
   * that has to change.
   */
  let identity: RunnerIdentity;
  try {
    identity = await requireRunnerLogin({
      client,
      login: args.get(runnerLoginFlag),
      fromEnv: args.env(runnerLoginEnv),
      usage: workCommand.usage,
      flag: args.as(runnerLoginFlag),
    });
  } catch (error) {
    /*
     * Two ways of having no identity, and only one of them is anybody's fault.
     *
     * GitHub *answering* no — a token it rejects, an installation token it
     * refuses `GET /user` to — is a {@link UsageError}: it will keep answering
     * no, so the invocation has to change, and it leaves here carrying R11's 2.
     *
     * GitHub not being *reachable* to ask is an {@link IdentityUnavailable},
     * and none of that is true of it. Nothing was misconfigured, so there is
     * nothing to retype; letting it fall through to the unclassified-fault
     * renderer would tell somebody whose network blipped that they had found a
     * bug in this CLI and should go and report it. It is the same thing as any
     * other blip that stops a pass before it reaches an issue, so it is said in
     * the same words and carries the same code: a pass that did not run.
     */
    if (!(error instanceof IdentityUnavailable)) {
      progress.fail('Nothing was worked');
      throw error;
    }
    stoppedEarly(reporter, error.reason);
    progress.fail('Nothing was worked');
    return EXIT.LOSS;
  }

  let interruptions = 0;
  let stopping = false;
  const onInterrupt = (): void => {
    // A stop this command asked for is not a person asking for one. It is raised
    // the only way a running loop understands — see `stopLoop` — so the flag set
    // before it is what tells the two apart.
    if (stopping) return;
    interruptions += 1;
  };
  process.on('SIGINT', onInterrupt);

  const pass: Pass = {
    ctx,
    cwd,
    reporter,
    progress,
    err,
    client,
    repos: new Map(),
    loopEnv: withoutCredentials(ctx.env),
    identity,
    standards,
    standardsPin,
    claimTtlMs: args.get(claimTtlFlag) ?? DEFAULT_CLAIM_TTL_MS,
    maxRounds: args.get(maxRoundsFlag) ?? DEFAULT_MAX_ROUNDS,
    maxCostUsd: args.get(maxCostFlag) ?? DEFAULT_MAX_COST,
    maxTurns: args.get(maxTurnsFlag),
    models: {
      ...(args.get(modelFlag) === undefined ? {} : { lead: args.get(modelFlag) as string }),
      ...(args.get(builderModelFlag) === undefined
        ? {}
        : { builder: args.get(builderModelFlag) as string }),
      ...(args.get(criticModelFlag) === undefined
        ? {}
        : { critic: args.get(criticModelFlag) as string }),
    },
    pluginDir: args.get(pluginDirFlag) ?? args.env(pluginDirEnv),
    verbose,
    interrupted: () => interruptions > 0,
    markStopping: () => {
      stopping = true;
    },
    doneStopping: () => {
      stopping = false;
    },
  };

  const outcomes: IssueOutcome[] = [];
  /*
   * A blip that stopped the pass before it reached an issue.
   *
   * It is not 2. R11 gives 2 to usage, configuration and authentication —
   * things in the invocation somebody has to change — and the example workflow
   * this feature ships says so in as many words: a 2 is always something in
   * that file. GitHub answering 503 is nothing in that file, so the pass
   * reports that it did not finish and the next one picks up.
   */
  let blip: GitHubError | undefined;
  try {
    progress.update(PROGRESS_MESSAGE + ' · reading the queue');
    let plan = await pickup(client, repos, wanted, cap, checkout);

    /*
     * Recovery first, and then selection again if it changed anything (C7).
     *
     * A stale claim goes back to `exolvra:ready`, which is exactly the state
     * selection is looking for — so selecting *before* recovering produced a
     * pass that said "recovered cli/cli#807 to exolvra:ready" and then, in the
     * next line, "no open issue carrying exolvra:ready", which was false at the
     * moment it printed. The issue then idled until the next cron for no
     * reason. Listing again after a recovery costs one request and makes the
     * two sentences describe one world.
     *
     * Reclaiming still does not itself claim: the second look goes through the
     * ordinary path, so the recovered issue is raced for exactly as any other
     * ready issue is.
     */
    /*
     * Issues this checkout may not work, said rather than silently dropped.
     *
     * They are the operator's configuration talking: a runner is bound to one
     * checkout, and an allowlist naming more repositories than the checkout is
     * of will never work them. It carries R11's 1 unconditionally — a signal
     * that depended on whether *other* issues happened to be workable would
     * read green on a busy day and red on a quiet one for the same standing
     * mistake, which is the least useful thing it could do.
     */
    for (const candidate of plan.foreign) {
      const reason =
        issueRef(candidate.repo, candidate.issue.number) +
        ' belongs to ' +
        repoSlug(candidate.repo) +
        '; this checkout is of ' +
        repoSlug(checkout as Repo) +
        ' — run the pass from a checkout of that repository';
      reporter.emit({ type: 'notice', level: 'warning', message: 'not working ' + reason });
      outcomes.push({
        repo: candidate.repo,
        issue: candidate.issue.number,
        result: 'ineligible',
        ...(lifecycleOf(candidate.issue.labels) === undefined
          ? {}
          : { label: lifecycleOf(candidate.issue.labels) as Lifecycle }),
        detail: reason,
      });
    }

    let reclaimed = 0;
    for (const stale of plan.recoverable) {
      if (pass.interrupted()) break;
      if (await recover(pass, stale.repo, stale.issue.number)) reclaimed += 1;
    }
    if (reclaimed > 0 && !pass.interrupted()) {
      plan = await pickup(client, repos, wanted, cap, checkout);
    }

    if (plan.eligible.length === 0) {
      if (wanted === undefined) {
        // Said of the repository this checkout is of, not of the whole
        // allowlist: with a foreign issue sitting there, "no open issue
        // carrying exolvra:ready in cli/cli, octocat/hello-world" would be
        // false — there is one, and this pass may not work it. Its own row
        // above says so.
        if (plan.foreign.length === 0) {
          reporter.emit({
            type: 'notice',
            level: 'note',
            message:
              'no open issue carrying ' +
              READY +
              ' in ' +
              (checkout === undefined ? describeAllowlist(repos) : repoSlug(checkout)),
          });
          progress.done('Nothing to work');
          return EXIT.WIN;
        }
      } else {
        /*
         * A pass that finds nothing has done its job. Somebody who typed an
         * issue asked for one thing and did not get it, and a 0 would tell them
         * — and whatever ran them — that it happened.
         */
        reporter.emit({
          type: 'notice',
          level: 'warning',
          message: issueRef(wanted.repo, wanted.number) + ' cannot be worked: ' + plan.why,
        });
        outcomes.push({
          repo: wanted.repo,
          issue: wanted.number,
          result: 'ineligible',
          detail: plan.why,
        });
      }
    }

    // Every branch first, while the tree is clean and none of them has a commit
    // on it, so no issue's work can land on another issue's branch.
    const prepared = await prepareBranches(pass, plan.eligible);
    outcomes.push(...prepared.dropped);

    for (const candidate of prepared.ready) {
      if (pass.interrupted()) break;
      const outcome = await workIssue(pass, candidate);
      outcomes.push(outcome);
      if (outcome.halt === true) break;
    }
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    const kind = classifyFault(error);
    if (kind === 'authentication') throw authenticationFault(error);
    if (kind !== 'transient') throw error;
    blip = error;
    stoppedEarly(reporter, faultLine(error));
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    progress.suspend();
    if (outcomes.length > 0) out.write(renderSummary(view, outcomes).join('\n') + '\n');
  }

  if (pass.interrupted()) {
    reporter.emit({
      type: 'notice',
      level: 'warning',
      message: 'the pass was interrupted, and the claim it held was released',
    });
    progress.fail('Interrupted');
    return EXIT.LOSS;
  }

  // The summary is out; now the fault that ended the pass, if one did. Raising
  // it here rather than where it was caught is what let the issue it is about
  // be settled and reported first.
  if (pass.fatal !== undefined) {
    progress.fail('Nothing more was worked');
    throw pass.fatal;
  }

  const code = blip === undefined ? passExit(outcomes, undefined) : EXIT.LOSS;
  if (code === EXIT.WIN) progress.done('Pass complete');
  else progress.fail('Pass complete, with work outstanding');
  return code;
}

/* -------------------------------------------------------------------------- */
/* Asking again, once, and only ever for a read                                */
/* -------------------------------------------------------------------------- */

/**
 * A read, asked again once when nothing answered at all.
 *
 * This command's shape makes it necessary in a way no other surface's does. A
 * pass reads GitHub, then runs a whole loop — minutes, sometimes far longer —
 * and then reads GitHub again. Across a gap like that a pooled connection is
 * gone, and a connection that closes at the moment a request is written to it
 * fails as `unreachable` rather than as an answer. That is not GitHub declining
 * anything; nothing was asked.
 *
 * Three things keep this from being a retry policy, which `src/github.ts`
 * deliberately does not have and should not grow:
 *
 * - **Only `unreachable`.** A rate limit, a refusal, a 404 and a 500 are all
 *   answers, and an answer is not asked for twice. The kind is the network
 *   module's own judgement, exposed as a field for exactly this.
 * - **Only reads, and only once.** Nothing here re-sends a write: a POST that
 *   failed after the bytes left is a comment that may already exist, and
 *   posting it again is worse than reporting that it might not have. A write
 *   that fails is reported and the claim is handed back (see `standDown`).
 * - **Out loud.** It says so on the stream, so a run that is limping is a run
 *   somebody can see limping rather than one that looks healthy and slow.
 *
 * It costs no budget: C9 is about what a run spends on models, and nothing here
 * spends any.
 */
export async function reread<T>(
  reporter: Reporter,
  what: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof GitHubError) || error.kind !== 'unreachable') throw error;
    reporter.emit({
      type: 'notice',
      level: 'warning',
      message: 'nothing answered when asked to ' + what + '; asking once more: ' + firstLine(error),
    });
    return await read();
  }
}

/* -------------------------------------------------------------------------- */
/* Which issues this pass is about                                             */
/* -------------------------------------------------------------------------- */

/** One issue this pass may work, with the repository it is in. */
interface Candidate {
  repo: Repo;
  issue: Issue;
}

interface Pickup {
  /** In the order a pass works them: oldest first (R1), within the cap (C10). */
  eligible: Candidate[];
  /** Eligible issues this pass will not reach, because the cap was reached. */
  waiting: Candidate[];
  /** Claimed issues whose heartbeat may have stopped, for C7 recovery. */
  recoverable: Candidate[];
  /**
   * Eligible issues belonging to a repository this checkout is not of.
   *
   * Partitioned out before the cap rather than after it: a foreign issue that
   * consumed one of the work-in-progress slots would starve an issue this pass
   * could actually have worked.
   */
  foreign: Candidate[];
  /** Why a named issue is not eligible, when it is not. */
  why: string;
}

/**
 * A named issue as a repository and a number, or a raised refusal (R2, C5).
 *
 * A bare number needs the allowlist to name exactly one repository. Two
 * allowlisted repositories and a bare `801` is a question with two answers, and
 * picking one of them silently is how a pass ends up working somebody else's
 * issue.
 */
function resolveTarget(
  target: IssueTarget,
  repos: readonly Repo[],
  checkout: Repo | undefined,
  apiUrl: string,
): { repo: Repo; number: number } {
  /*
   * The host a URL was written against, checked rather than discarded.
   *
   * `work https://evil.example.com/cli/cli/issues/555` used to be read as
   * `cli/cli#555`: the host was parsed and thrown away, so a link that looked
   * like somebody else's repository quietly named one of this run's. The
   * allowlist still bounded what could happen, but a value that means one thing
   * and is read as another is a defect on its own.
   */
  if (target.host !== undefined && !sameHost(apiUrl, target.host)) {
    throw new UsageError(
      [
        'refusing to read an issue URL on another host as one of this run’s',
        '  the URL is on ' + plainText(target.host),
        '  this run talks to ' + plainText(apiUrl),
        '  write it as owner/name#' + target.number + ' if that is the issue you mean',
      ].join('\n'),
      workCommand.usage,
    );
  }

  if (target.repo === undefined) {
    const only = repos[0];
    if (repos.length !== 1 || only === undefined) {
      throw new UsageError(
        [
          'refusing to guess which repository issue #' + target.number + ' is in',
          '  the allowlist names ' + repos.length + ': ' + describeAllowlist(repos),
          '  write it as owner/name#' + target.number + ', or as the URL of its page',
        ].join('\n'),
        workCommand.usage,
      );
    }
    return { repo: only, number: target.number };
  }

  const slug = repoSlug(target.repo).toLowerCase();
  const allowed = repos.find((repo) => repoSlug(repo).toLowerCase() === slug);
  if (allowed === undefined) {
    throw new UsageError(
      [
        'refusing to work an issue in a repository this run is not allowlisted for',
        '  the issue is in ' + repoSlug(target.repo),
        '  the allowlist is ' + describeAllowlist(repos),
        '  add it with --repo ' + repoSlug(target.repo) + ', or set ' + REPOS_ENV,
      ].join('\n'),
      workCommand.usage,
    );
  }

  // And the checkout has to be of that repository, because the branch this run
  // would push goes to *this* checkout's remote whatever the issue says.
  if (checkout !== undefined && repoSlug(allowed).toLowerCase() !== repoSlug(checkout).toLowerCase()) {
    throw new UsageError(
      [
        'refusing to work an issue that belongs to another repository',
        '  ' + issueRef(allowed, target.number) + ' belongs to ' + repoSlug(allowed),
        '  this checkout is of ' + repoSlug(checkout),
        '  a pass commits here and pushes to this checkout’s own remote, so it would',
        '  push the work to ' + repoSlug(checkout) + ' and open the pull request on ' + repoSlug(allowed),
        '  run the pass from a checkout of ' + repoSlug(allowed),
      ].join('\n'),
      workCommand.usage,
    );
  }
  return { repo: allowed, number: target.number };
}

/**
 * What this pass would pick up, oldest first, within the cap (R1, C10).
 *
 * Reads only. Which issues carry which labels is GitHub's answer rather than
 * this command's guess, so an issue is eligible here exactly when it carries the
 * ready label — and whether it may really be claimed is settled where the claim
 * is made, by the compare-and-swap that decides it between runners.
 */
async function pickup(
  client: GitHubClient,
  repos: readonly Repo[],
  wanted: { repo: Repo; number: number } | undefined,
  cap: number,
  /** The repository this checkout is of; undefined only for a dry run. */
  checkout: Repo | undefined,
): Promise<Pickup> {
  const isMine = (repo: Repo): boolean =>
    checkout === undefined || repoSlug(repo).toLowerCase() === repoSlug(checkout).toLowerCase();
  if (wanted !== undefined) {
    const issue = await client.getIssue(wanted.repo, wanted.number);
    const nothing = (why: string, recoverable: Candidate[] = []): Pickup => ({
      eligible: [],
      waiting: [],
      recoverable,
      foreign: [],
      why,
    });
    if (issue.isPullRequest) return nothing('it is a pull request, not an issue');
    if (issue.state !== 'open') return nothing('it is ' + plainText(issue.state));
    if (!issue.labels.includes(READY)) {
      return nothing(
        'it does not carry ' + READY,
        issue.labels.includes(WORKING) ? [{ repo: wanted.repo, issue }] : [],
      );
    }
    return {
      eligible: [{ repo: wanted.repo, issue }],
      waiting: [],
      recoverable: [],
      foreign: [],
      why: '',
    };
  }

  const eligible: Candidate[] = [];
  const recoverable: Candidate[] = [];
  for (const repo of repos) {
    for (const issue of await client.listIssues(repo, { labels: [READY], state: 'open' })) {
      eligible.push({ repo, issue });
    }
    for (const issue of await client.listIssues(repo, { labels: [WORKING], state: 'open' })) {
      recoverable.push({ repo, issue });
    }
  }

  const opened = (candidate: Candidate): number => {
    const at = Date.parse(candidate.issue.createdAt);
    return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
  };
  const oldest = [...eligible].sort((a, b) => {
    if (opened(a) !== opened(b)) return opened(a) < opened(b) ? -1 : 1;
    const byRepo = repoSlug(a.repo).localeCompare(repoSlug(b.repo));
    return byRepo !== 0 ? byRepo : a.issue.number - b.issue.number;
  });
  const mine = oldest.filter((candidate) => isMine(candidate.repo));
  return {
    eligible: mine.slice(0, cap),
    waiting: mine.slice(cap),
    recoverable: recoverable.filter((candidate) => isMine(candidate.repo)),
    foreign: oldest.filter((candidate) => !isMine(candidate.repo)),
    why: '',
  };
}

/* -------------------------------------------------------------------------- */
/* The branches a pass will need, cut before any of them has a commit on it    */
/* -------------------------------------------------------------------------- */

/**
 * What a repository says about itself, and the guard every write to it is
 * measured against.
 *
 * Asked once per repository per pass. Asking is `src/github.ts`'s job and
 * enforcing is `src/git.ts`'s; this is where the answer is held between them.
 */
async function guardFor(pass: Pass, repo: Repo): Promise<{ info: RepoInfo; git: GitContext }> {
  const slug = repoSlug(repo);
  const known = pass.repos.get(slug.toLowerCase());
  if (known !== undefined) return known;

  const info = await reread(pass.reporter, 'read ' + slug, () => pass.client.getRepo(repo));
  const answer = {
    info,
    git: {
      cwd: pass.cwd,
      ignorePaths: IGNORED_BY_THE_RUNNER,
      repo: {
        defaultBranch: info.defaultBranch,
        protectedBranches: await reread(pass.reporter, 'read the protected branches of ' + slug, () =>
          pass.client.listProtectedBranches(repo),
        ),
        repo: slug,
      } satisfies RepoGuard,
    },
  };
  pass.repos.set(slug.toLowerCase(), answer);
  return answer;
}

/**
 * Cuts every branch this pass may need, before any of them has a commit on it.
 *
 * `git checkout -b` cuts from wherever HEAD is standing, and after one issue is
 * worked HEAD is standing on that issue's branch. Cutting the second issue's
 * branch at that moment gave it the first issue's commit — one issue's work in
 * another issue's pull request, which is the worst thing this command could
 * quietly do.
 *
 * Creating a branch moves HEAD and nothing else, so cutting them all now — with
 * the tree clean and no commit made — puts every one of them on the commit the
 * pass started from. From then on each issue's own `ensureIssueBranch` finds its
 * branch already there and checks it out rather than cutting a new one, and the
 * work lands where it belongs. A branch that already exists from an earlier pass
 * is reused exactly as before.
 *
 * A branch that cannot be prepared takes its issue out of the pass, and takes it
 * out *before* anything is claimed: there is no claim to release, no label to
 * put back, and nothing was written to the repository for an issue this pass
 * turned out to be unable to work. It is reported, not swallowed.
 */
async function prepareBranches(
  pass: Pass,
  candidates: readonly Candidate[],
): Promise<{ ready: Candidate[]; dropped: IssueOutcome[] }> {
  const ready: Candidate[] = [];
  const dropped: IssueOutcome[] = [];
  for (const candidate of candidates) {
    const { git } = await guardFor(pass, candidate.repo);
    try {
      ensureIssueBranch(git, {
        number: candidate.issue.number,
        title: candidate.issue.title,
      });
      ready.push(candidate);
    } catch (error) {
      /*
       * A row, not a silence.
       *
       * A branch this runner may not write — one the repository protects, one
       * outside its own namespace — is a refusal that will happen again on
       * every pass, and dropping the issue without a row left the pass with
       * nothing to report and therefore nothing to fail on: a scheduled runner
       * green forever while working nothing. `ineligible` is what it is — an
       * issue that may not be worked until a person changes something — and it
       * carries R11's 1.
       */
      const reason = 'its branch could not be prepared: ' + firstLine(error);
      pass.reporter.emit({
        type: 'notice',
        level: 'warning',
        message:
          'not working ' +
          issueRef(candidate.repo, candidate.issue.number) +
          ': ' +
          reason +
          ' — nothing was claimed for it',
      });
      dropped.push({
        repo: candidate.repo,
        issue: candidate.issue.number,
        result: 'ineligible',
        ...(lifecycleOf(candidate.issue.labels) === undefined
          ? {}
          : { label: lifecycleOf(candidate.issue.labels) as Lifecycle }),
        detail: reason,
      });
    }
  }
  return { ready, dropped };
}

/* -------------------------------------------------------------------------- */
/* Recovering a claim that stopped beating (C7)                                */
/* -------------------------------------------------------------------------- */

async function recover(pass: Pass, repo: Repo, number: number): Promise<boolean> {
  const ctx: IssueRunContext = {
    client: pass.client,
    repo,
    issue: number,
    cwd: pass.cwd,
    runId: newRunId(),
    login: pass.identity.login,
  };
  try {
    const outcome = await reclaimIssue(ctx, { ttlMs: pass.claimTtlMs });
    if (outcome.reclaimed) {
      pass.reporter.emit({ type: 'notice', level: 'note', message: outcome.reason });
    }
    return outcome.reclaimed;
  } catch (error) {
    // Recovery is repair, and a pass that could not repair one issue still has
    // work to do on the others. It is said rather than swallowed — and an
    // authentication fault is not a repair problem at all, so it goes out.
    if (error instanceof GitHubError && classifyFault(error) === 'authentication') {
      throw authenticationFault(error);
    }
    pass.reporter.emit({
      type: 'notice',
      level: 'warning',
      message: 'could not recover ' + issueRef(repo, number) + ': ' + firstLine(error),
    });
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* One issue, end to end                                                       */
/* -------------------------------------------------------------------------- */

async function workIssue(pass: Pass, candidate: Candidate): Promise<IssueOutcome> {
  const repo = candidate.repo;
  const number = candidate.issue.number;
  const ref = issueRef(repo, number);
  const reporter = pass.reporter;
  const runId = newRunId();

  const ctx: IssueRunContext = {
    client: pass.client,
    repo,
    issue: number,
    cwd: pass.cwd,
    runId,
    login: pass.identity.login,
  };

  pass.progress.update(PROGRESS_MESSAGE + ' · ' + ref);
  // The first read of an issue, which on every issue but the first of a pass
  // comes after a whole loop run: see {@link reread}.
  const thread: IssueThread = await reread(pass.reporter, 'read ' + ref, () =>
    pass.client.getIssueThread(repo, number),
  );
  const title = thread.issue.title;

  /* ---- R4: a bar that cannot be checked is not guessed at ---------------- */

  const derived = deriveIssueSpec(thread, pass.standards);
  if (!derived.runnable) {
    let triage;
    try {
      triage = await triageIssue(ctx, { thread, standards: pass.standards });
    } catch (error) {
      // The triage label moves through the same compare-and-swap the claim
      // does, so a write that did not land is read the same way here.
      return await issueFault(pass, repo, number, 'it was not triaged', error);
    }
    reporter.emit({ type: 'notice', level: 'note', message: triage.reason });
    return {
      repo,
      issue: number,
      result: triage.triaged ? 'triaged' : 'skipped',
      detail: triage.triaged
        ? derived.missing.map((element) => element.id).join(', ') + ' missing'
        : triage.reason,
    };
  }

  /* ---- the repository, and the branch cut for this issue before the pass --- */

  const { info, git } = await guardFor(pass, repo);

  /* ---- C6: the claim ----------------------------------------------------- */

  let claim;
  try {
    claim = await claimIssue(ctx, {
      thread,
      claimTtlMs: pass.claimTtlMs,
      budget: { rounds: 0, maxRounds: pass.maxRounds, maxCostUsd: pass.maxCostUsd },
    });
  } catch (error) {
    /*
     * C6 says a claim write that did not land means another runner owns the
     * issue — skip it silently. That reading is right for the evidence C6 was
     * written about, and wrong for the rest: a token that may not label an
     * issue is not a race, and skipping it silently would let a workflow whose
     * `permissions:` block is short a line run green forever having worked
     * nothing. So which of the two this is comes from the fault's own kind
     * ({@link issueFault}), and only the racing kinds are skipped.
     *
     * `claimIssue` puts the label back itself if it won the swap and then could
     * not finish, so there is nothing held here to release.
     */
    return await issueFault(pass, repo, number, 'it was not claimed', error);
  }

  if (
    !claim.claimed ||
    claim.state === undefined ||
    claim.sticky === undefined ||
    claim.snapshot === undefined
  ) {
    // A lost race is a silent skip (C6): another runner owns the issue, and two
    // runners announcing the same issue is noise a scheduled pass would produce
    // every few minutes.
    reporter.emit({ type: 'notice', level: 'note', message: claim.reason });
    return {
      repo,
      issue: number,
      result: 'skipped',
      ...(lifecycleOf(claim.labels) === undefined
        ? {}
        : { label: lifecycleOf(claim.labels) as Lifecycle }),
      detail: claim.reason,
    };
  }

  let state: StickyState = claim.state;
  let sticky: StickyRef = claim.sticky;
  const snapshot: SnapshotPin = claim.snapshot;
  reporter.emit({ type: 'notice', level: 'note', message: claim.reason });

  /* ---- a pull request an earlier pass wrote but could not open ------------ */

  const waiting = findPending(pass.cwd, repo, number);
  if (waiting !== undefined) {
    const finishedPull = await finishPending(pass, ctx, state, sticky, git, info, waiting);
    if (finishedPull !== undefined) return finishedPull;
  }

  /* ---- C4: one branch per issue ------------------------------------------ */

  let branch: string;
  try {
    branch = ensureIssueBranch(git, { number, title }).branch;
  } catch (error) {
    return await giveUp(pass, ctx, state, sticky, {
      repo,
      issue: number,
      reason: firstLine(error),
      decision:
        'the branch for this issue could not be made or reused: ' +
        firstLine(error) +
        '. Settle it in the checkout, then put ' +
        READY +
        ' back on',
    });
  }

  /*
   * The branch's *name*, and not yet a link to it.
   *
   * A branch that exists only in this checkout has no page on GitHub, and a
   * status comment that linked one would be handing a maintainer a 404 to click
   * — on exactly the paths where a person is the only audience: a run
   * interrupted before it committed anything, or one whose push was refused.
   * The link is added where the fact is established, after the push answers.
   * `src/issue-run.ts` renders a link when there is a URL and the bare name when
   * there is not, so this needs nothing of it but the truth.
   */
  state = {
    ...state,
    phase: 'planning',
    links: {
      ...state.links,
      branch,
      progress: progressPagePath(pass.cwd, runId),
    },
  };

  /* ---- the loop, run by the command that owns it -------------------------- */

  const rounds: PullRequestRound[] = [];
  const stickyRounds: StickyRound[] = [];
  let pieces: StickyPiece[] = [];
  let finished: { status: RunStatus; rounds: number; costUsd: number } | undefined;
  let heartbeatFault: string | undefined;
  let integrityFault: string | undefined;
  /**
   * Why the run stopped, in the run's own words.
   *
   * The loop says this itself — which guard tripped, on what figures, or what
   * the provider reported — and it says it as a warning or an error on the same
   * stream every other event arrives on. Taking it from there rather than
   * working it out again from the budget is the difference between one sentence
   * and two that have to be kept in step; the last one is the one that ended the
   * run, because everything after it is the run reporting rather than stopping.
   */
  let stopNotice: string | undefined;
  let beats: Promise<void> = Promise.resolve();

  const stopLoop = (why: string): void => {
    if (integrityFault !== undefined) return;
    integrityFault = why;
    reporter.emit({ type: 'notice', level: 'warning', message: why });
    /*
     * The loop is asked to stop the one way a running loop understands.
     *
     * `run` already treats an interrupt as "stop cleanly, report it, and record
     * the run as stopped", and the session under it already unwinds the
     * provider's stream on one. Raising it here is therefore not a trick: it is
     * this command using the stop path that exists rather than inventing a
     * second one `run` would have to be taught about. The flag set first is what
     * keeps it from being counted as a person asking.
     */
    pass.markStopping();
    process.emit('SIGINT', 'SIGINT');
    pass.doneStopping();
  };

  const onRound = (event: Extract<RunEvent, { type: 'round' }>): void => {
    rounds.push({
      piece: event.piece,
      number: event.round,
      verdict: event.verdict,
      ...(event.gap === undefined ? {} : { gap: event.gap }),
    });
    stickyRounds.push({
      number: stickyRounds.length + 1,
      verdict: event.verdict,
      ...(event.gap === undefined ? {} : { gap: event.gap }),
      ...(event.piece === '' ? {} : { evidence: event.piece + ' round ' + event.round }),
      at: isoSeconds(new Date()),
    });
    copyProgressPage(pass.cwd, runId);

    // C11 and C7 in one step, once a round: the pin is re-verified, the issue is
    // read again to see whether the spec moved under the run, and the status
    // comment's heartbeat is beaten where another runner can read it.
    beats = beats.then(async () => {
      const verified = verifyIssueSnapshot(pass.cwd, runId);
      if (!verified.verified) {
        stopLoop(
          'the pinned issue snapshot no longer verifies (' +
            verified.reason +
            '), so this run is no longer judged against the spec it claimed',
        );
        return;
      }
      try {
        const beat = await beatHeartbeat(
          ctx,
          {
            ...state,
            phase: 'judging',
            pieces,
            rounds: [...stickyRounds],
            budget: {
              rounds: stickyRounds.length,
              maxRounds: pass.maxRounds,
              costUsd: finished?.costUsd ?? 0,
              maxCostUsd: pass.maxCostUsd,
            },
          },
          sticky,
        );
        state = beat.state;
        sticky = beat.sticky;
        if (beat.blocked) {
          stopLoop(
            beat.drift?.summary ??
              'the issue changed after it was claimed, so this run is no longer judged ' +
                'against the spec it agreed to',
          );
        }
      } catch (error) {
        // A heartbeat that could not be sent is worth saying and is not worth
        // ending a run over: the claim it failed to refresh is exactly what the
        // TTL exists to recover.
        heartbeatFault = firstLine(error);
      }
    });
  };

  const sink = lineStream((line) => {
    const event = readEvent(line);
    if (event === undefined) return;
    reporter.emit(event);
    if (event.type === 'round') onRound(event);
    else if (event.type === 'plan_ready') {
      pieces = event.pieces.map((piece) => ({
        id: piece.id,
        title: piece.title,
        state: 'building',
      }));
    } else if (event.type === 'run_finished') {
      finished = { status: event.status, rounds: event.rounds, costUsd: event.costUsd };
    } else if (event.type === 'notice' && event.level !== 'note') {
      stopNotice = plainText(event.message);
    }
  });

  const before = new Set(readRuns(pass.cwd).map((record) => record.id));
  pass.progress.update(PROGRESS_MESSAGE + ' · ' + ref + ' · running the loop');
  const innerCode = await runCommand.run(innerArgv(pass, snapshot), {
    ...pass.ctx,
    cwd: pass.cwd,
    stdout: sink,
    stderr: pass.err,
    // C3: the loop is handed an environment with no authority over the
    // repository in it. This runner's own client resolved its token long before
    // this line and holds it in a closure, so scrubbing here costs the runner
    // nothing and leaves a builder nothing to reach GitHub with.
    env: pass.loopEnv,
    // Nothing draws on the inner run's behalf: this command already has a
    // progress line, and two of them on one stream is neither.
    isTTY: false,
    isErrTTY: false,
  });
  sink.end();
  await beats;
  copyProgressPage(pass.cwd, runId);

  const ledgerRunId = readRuns(pass.cwd)
    .map((record) => record.id)
    .find((id) => !before.has(id));

  /*
   * C11, once more, at the moment the result is settled.
   *
   * The per-round check runs inside the loop and can only catch what happens
   * while the loop is still running; an edit in the last moments — after the
   * final round, while the run is winding up — would slip between it and here.
   * This is the check that cannot be outrun, because nothing else happens
   * between it and the decision below.
   */
  const finalPin = verifyIssueSnapshot(pass.cwd, runId);
  if (!finalPin.verified && integrityFault === undefined) {
    integrityFault =
      'the pinned issue snapshot no longer verifies (' +
      finalPin.reason +
      '), so this run is no longer judged against the spec it claimed';
    reporter.emit({ type: 'notice', level: 'warning', message: integrityFault });
  }

  /*
   * **A broken pin is a gate, not a warning.**
   *
   * It used to be neither: the run said the snapshot no longer verified and
   * then, if the loop had already finished cleanly, shipped the work anyway —
   * a non-draft pull request, `exolvra:review`, exit 0, and the only trace of
   * the failure folded inside the pull request body. That is the tool
   * declaring a run unjudgeable and then presenting it as judged.
   *
   * So the win is conditioned on it here, once, where every path afterwards
   * reads the answer: the outcome is forced to the blocked one, the pull
   * request is a draft carrying the reason (R10 — the work is never
   * discarded), the label goes to `exolvra:blocked`, and the pass reports 1.
   * What the loop's own stream said is not consulted, because the loop was
   * judging against a spec that had already moved.
   */
  const won = innerCode === EXIT.WIN && integrityFault === undefined;
  const status: RunStatus =
    integrityFault !== undefined ? 'blocked' : won ? 'win' : (finished?.status ?? 'stopped');
  const spent = {
    rounds: finished?.rounds ?? rounds.length,
    maxRounds: pass.maxRounds,
    costUsd: finished?.costUsd ?? 0,
    maxCostUsd: pass.maxCostUsd,
  };
  state = {
    ...state,
    pieces: pieces.map((piece) => ({
      ...piece,
      state: lastVerdictOf(rounds, piece.id) === 'WIN' ? 'verified' : 'failed',
    })),
    rounds: [...stickyRounds],
    budget: spent,
  };

  /* ---- what came out of it ----------------------------------------------- */

  // The work tree only decides whether there is anything to commit. What the
  // pull request *says* comes from the branch afterwards, not from here.
  let commit;
  try {
    commit = commitAll(git, commitMessage(repo, thread.issue, snapshot, runId));
  } catch (error) {
    return await giveUp(pass, ctx, state, sticky, {
      repo,
      issue: number,
      reason: firstLine(error),
      decision:
        'what the loop left in the work tree could not be committed: ' +
        firstLine(error) +
        '. Settle it in the checkout, then put ' +
        READY +
        ' back on',
    });
  }

  if (pass.interrupted()) {
    return await releaseOnInterrupt(pass, ctx, state, sticky, git, {
      repo,
      issue: number,
      branch,
      ...(info.url === '' ? {} : { branchUrl: info.url + '/tree/' + branch }),
      committed: commit.committed,
    });
  }

  if (!commit.committed) {
    const why = 'the loop changed no files, so there is nothing to open a pull request from';
    return await giveUp(pass, ctx, state, sticky, {
      repo,
      issue: number,
      reason: why,
      decision:
        why +
        (integrityFault === undefined ? '' : ' (' + integrityFault + ')') +
        '. Read the run’s own report, then either put ' +
        READY +
        ' back on or say in the issue what is missing',
    });
  }

  pass.progress.update(PROGRESS_MESSAGE + ' · ' + ref + ' · pushing ' + branch);
  let push;
  try {
    push = pushBranch(git, branch);
  } catch (error) {
    return await giveUp(pass, ctx, state, sticky, {
      repo,
      issue: number,
      reason: firstLine(error),
      decision:
        'the work is committed on ' +
        branch +
        ' here but the push was refused: ' +
        firstLine(error) +
        '. Settle it, then put ' +
        READY +
        ' back on',
    });
  }
  reporter.emit({
    type: 'notice',
    level: 'note',
    message: 'pushed ' + branch + ' to ' + push.remote,
  });
  // Now there is a page to link to, so now the status comment may link one.
  state = {
    ...state,
    links: {
      ...state.links,
      ...(info.url === '' ? {} : { branchUrl: info.url + '/tree/' + branch }),
    },
  };

  const reason =
    integrityFault ?? stopNotice ?? 'the run ended without meeting the win condition';
  const decision =
    reason +
    '. The branch is pushed and the draft carries everything the run produced: raise ' +
    'the budget and put ' +
    READY +
    ' back on to carry it further, or settle in the issue what it is blocked on';
  const bar = readBarPin(pass.cwd);
  /*
   * What the merge proposes, asked of the branch rather than of this run.
   *
   * The two are the same thing on a first pass over an issue and differ on
   * every one after it: a branch that was pushed, blocked, and picked up again
   * carries every commit of every pass, and a body built from the run's own
   * work tree would attest one file and one commit while the merge proposed
   * two of each. The reviewer is deciding on the merge, so the body describes
   * the merge — and says which of its numbers are the run's instead.
   */
  const merges = branchChanges(git, info.defaultBranch, branch);
  const head = refSha(git, 'refs/heads/' + branch);
  const report: PullRequestReport = {
    repo,
    issue: number,
    issueTitle: title,
    issueUrl: thread.issue.url,
    runId,
    ...(ledgerRunId === undefined ? {} : { ledgerRunId }),
    branch,
    ...(info.url === '' ? {} : { branchUrl: info.url + '/tree/' + branch }),
    baseBranch: info.defaultBranch,
    ...(head === undefined ? {} : { head }),
    outcome: status,
    ...(won ? {} : { reason, decision }),
    rounds,
    budget: spent,
    attestations: attestationsFor(pass, runId, snapshot, branch, info.defaultBranch, heartbeatFault),
    snapshot: {
      path: snapshot.relativePath,
      sha256: snapshot.sha256,
      verified: verifyIssueSnapshot(pass.cwd, runId).verified,
    },
    ...(pass.standardsPin === undefined ? {} : { standards: pass.standardsPin }),
    ...(bar === undefined ? {} : { bar }),
    runner: { login: pass.identity.login, from: pass.identity.from },
    progressPage: progressPagePath(pass.cwd, runId),
    files: merges,
    generatedAt: isoSeconds(new Date()),
  };

  const opened = await openPullRequest(pass, repo, branch, info.defaultBranch, report, !won);
  if ('fault' in opened) {
    /*
     * Two very different failures wear the same sentence, and only one of them
     * is a person's to settle.
     *
     * GitHub being unreachable, rate-limiting this run, or answering 5xx is a
     * thing that will very likely work in ten minutes. Parking the issue on
     * `exolvra:blocked` for it would spend a human's attention on a network
     * blip and leave the issue there until somebody noticed — `blocked` is a
     * terminus, and C7 recovery does not touch it. So the claim is handed back
     * to `exolvra:ready` instead: the branch is already pushed, the next pass
     * reuses it, and the pull request is opened then.
     *
     * A refusal — the token cannot see the repository, the token was rejected,
     * GitHub would not accept the pull request — is not going to change on its
     * own, and that one really is a person's.
     */
    const kind = classifyFault(opened.fault);
    if (kind === 'transient') {
      // The evidence is finished and the branch is pushed; only the call
      // failed. Both are kept, so the next pass opens *this* pull request
      // rather than running the loop again and stacking a second commit under
      // a body that describes one.
      writePending(pass.cwd, {
        version: 1,
        repo: repoSlug(repo),
        issue: number,
        branch,
        base: info.defaultBranch,
        draft: !won,
        title: pullRequestTitle(report),
        body: renderPullRequestBody(report),
        commit: head ?? '',
        runId,
        outcome: status,
        budget: {
          rounds: spent.rounds,
          maxRounds: spent.maxRounds,
          costUsd: spent.costUsd,
          maxCostUsd: spent.maxCostUsd,
        },
        rounds: [...stickyRounds],
        pieces: state.pieces,
        ...(won ? {} : { decision }),
        at: isoSeconds(new Date()),
      });
      return await standDown(pass, ctx, state, sticky, {
        repo,
        issue: number,
        branch,
        reason: faultLine(opened.fault),
      });
    }
    /*
     * GitHub refused the pull request, and the run is over — but the writes
     * that tell a person so are not the write that failed.
     *
     * The branch is pushed and carries everything the run built. Ending here
     * without settling the issue left the claim on `exolvra:working` with a
     * fresh heartbeat — a finished run holding a live lock nothing else could
     * take for a day — and left the status comment saying critics were still
     * judging and no pull request had been opened "because the win condition
     * has not been met", when it had. So the finishing writes happen first, and
     * only then does an authentication fault carry the exit it has earned.
     */
    const refusal = 'the pull request could not be opened: ' + firstLine(opened.fault);
    const ending = await settle(pass, ctx, state, sticky, {
      won: false,
      to: 'blocked',
      phase: 'blocked',
      reason: refusal,
      decision:
        (won
          ? 'the win condition was met and the branch ' + branch + ' is pushed'
          : 'the branch ' + branch + ' is pushed and carries the work') +
        ', but GitHub refused the pull request: ' +
        firstLine(opened.fault) +
        (kind === 'authentication'
          ? '. That is a permission this token does not have: grant it, or open the pull ' +
            'request from the branch by hand'
          : '. Open one by hand, or settle what it refused') +
        ', then put ' +
        READY +
        ' back on to run it again',
    });
    if (kind === 'authentication') {
      // The exit is still R11's 2 — the invocation has to change — and it is
      // raised once the pass has finished reporting, so the summary a person
      // reads describes the issue the fault is about.
      pass.fatal = authenticationFault(opened.fault);
      return { ...ending, halt: true };
    }
    return ending;
  }
  const pull = opened.pull;

  state = {
    ...state,
    links: {
      ...state.links,
      pullRequest: pull.number,
      pullRequestUrl: pull.url,
      pullRequestDraft: pull.draft,
    },
  };

  const ending = await settle(pass, ctx, state, sticky, {
    won,
    to: won ? 'review' : 'blocked',
    phase: won ? 'review' : status === 'stopped' ? 'stopped' : 'blocked',
    reason,
    decision,
    pull,
  });
  recordIssueRun(pass, ledgerRunId, repo, number, runId, branch, pull.url, ending.stale);
  return ending;
}

/**
 * The ending every issue that reached a pull request shares: move the label,
 * say where it went, and report what it came to.
 *
 * **A win outranks every fault that follows it.** Once the pull request is
 * open, the run has done what it was started for; a status comment that could
 * not be edited or a label that would not move afterwards is worth a warning
 * and is not worth telling a scheduler the work failed. That rule is the
 * house's — the exit code is the outcome's, not the last thing that went
 * wrong — and this is where it is applied, because this is the first moment at
 * which the outcome exists.
 *
 * The one thing that does change the answer is losing the claim. A transition
 * that did not move means somebody took the issue while the run was going, and
 * `transitionIssue` has already corrected the label and said so; the issue is a
 * person's from there, whatever this run decided.
 */
async function settle(
  pass: Pass,
  ctx: IssueRunContext,
  state: StickyState,
  sticky: StickyRef,
  about: {
    won: boolean;
    to: Lifecycle;
    phase: RunPhase;
    reason: string;
    decision: string;
    /** The pull request, when one was opened. */
    pull?: PullRequest;
  },
): Promise<IssueOutcome> {
  const { won, pull, reason } = about;
  const repo = ctx.repo;
  const issue = ctx.issue;

  /*
   * What the sticky has to say, whichever of the writes below lands.
   *
   * Built before either is attempted, because it describes what *happened* —
   * the branch that is pushed, the pull request that was or was not opened, and
   * what a person has to do about it — and none of that is changed by which
   * endpoint answers.
   */
  const truth: StickyState = {
    ...state,
    phase: about.phase,
    decision: about.decision,
    links: {
      ...state.links,
      ...(pull === undefined
        ? {}
        : {
            pullRequest: pull.number,
            pullRequestUrl: pull.url,
            pullRequestDraft: pull.draft,
          }),
    },
  };

  /* ---- the label, and the sticky the label move carries with it ---------- */

  let moved = true;
  let moveReason = '';
  let held: Lifecycle | undefined;
  let toldTheStory = false;
  try {
    const move = await transitionIssue(ctx, truth, sticky, about.to, {
      // The run's own sentence, unwrapped: the label history has one cell for
      // it, and a prefix repeating what the sentence already says is half a
      // cell spent saying nothing.
      why: won ? 'the win condition was met and a pull request is open' : reason,
      phase: about.phase,
      decision: about.decision,
    });
    moved = move.moved;
    moveReason = move.reason;
    held = lifecycleOf(move.labels);
    sticky = move.sticky;
    // `transitionIssue` publishes the status comment as part of the move, and
    // on a move it did not make it publishes the losing-the-claim story. Either
    // way a person has been told.
    toldTheStory = true;
    pass.reporter.emit({
      type: 'notice',
      level: won && moved ? 'note' : 'warning',
      message: move.reason,
    });
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    moved = false;
    moveReason = faultLine(error);
    pass.reporter.emit({
      type: 'notice',
      level: 'warning',
      message:
        issueRef(repo, issue) +
        ' could not be moved to ' +
        lifecycleLabel(about.to) +
        ': ' +
        moveReason,
    });
  }

  /* ---- what the repository actually holds now ---------------------------- */

  if (!toldTheStory) {
    try {
      held = lifecycleOf(
        (await reread(pass.reporter, 'read ' + issueRef(repo, issue), () =>
          pass.client.getIssue(repo, issue),
        )).labels,
      );
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      held = undefined;
    }
  }

  /*
   * The status comment, attempted whatever the label did.
   *
   * These are independent writes to independent endpoints, and treating them as
   * one step is how a run came to leave a status comment saying "fresh critics
   * are judging" and "Pull request — none yet" long after the critics had
   * finished and the branch had been pushed. The comment is the only thing a
   * human reads; abandoning it because a *label* call failed abandons the one
   * audience that was ever going to look.
   *
   * It carries the label the repository actually holds, not the one this run
   * meant to set — a status comment asserting a claim the issue does not have
   * is the same lie in a different place.
   */
  let stale: string | undefined;
  if (!toldTheStory) {
    try {
      const beat = await beatHeartbeat(ctx, { ...truth, label: held }, sticky);
      sticky = beat.sticky;
      pass.reporter.emit({
        type: 'notice',
        level: 'note',
        message:
          'the status comment on ' +
          issueRef(repo, issue) +
          ' was brought up to date even though the label was not',
      });
    } catch (error) {
      /*
       * Two attempts, and then the discrepancy is recorded rather than lost.
       *
       * The comment is the only part of this a person reads, and it is the one
       * thing that cannot be corrected from here once GitHub keeps refusing.
       * What can be done is to stop the run from *looking* finished: the
       * warning names what the comment still wrongly says, the summary row
       * carries it, and so does the run record — three places that outlive this
       * terminal, because two warnings scrolled past on a CI log are not a
       * record of anything.
       */
      stale = 'the status comment could not be brought up to date';
      const says = staleSays(sticky);
      pass.reporter.emit({
        type: 'notice',
        level: 'warning',
        message:
          issueRef(repo, issue) +
          ': ' +
          stale +
          ', so it still says ' +
          says +
          ' — ' +
          firstLine(error),
      });
    }
  }

  if (pull !== undefined) {
    pass.reporter.emit({
      type: 'notice',
      level: 'note',
      message: (pull.draft ? 'draft pull request ' : 'pull request ') + pull.url,
      keepWhole: true,
    });
  }

  /*
   * The row, off what the repository holds rather than what was intended.
   *
   * The result word answers "what did this issue come to", which is what the
   * exit code is derived from — a win that reached its pull request is a win
   * however the labelling went afterwards. The label column answers "and where
   * is the issue now", which is a different question with its own answer, and
   * printing the intended one there is what made a pass claim `review` while
   * the server held `exolvra:working`.
   */
  const reached = won && pull !== undefined;
  const lagging = held !== about.to;
  return {
    repo,
    issue,
    result: reached ? 'review' : 'blocked',
    ...(held === undefined ? {} : { label: held }),
    ...(stale === undefined ? {} : { stale }),
    detail:
      (pull === undefined
        ? reason
        : (pull.draft ? 'draft #' : '#') + pull.number + ' · ' + (reached ? 'won' : reason)) +
      (stale === undefined ? '' : ' · ' + stale) +
      (lagging
        ? ' · the label is ' +
          (held === undefined ? 'none' : lifecycleLabel(held)) +
          ', not ' +
          lifecycleLabel(about.to) +
          ' (' +
          (moved ? 'taken by somebody else' : moveReason) +
          ')'
        : ''),
  };
}

/**
 * Opens the pull request an earlier pass wrote and could not send (F1/R9).
 *
 * The whole point is what this does *not* do: it does not run the loop, and it
 * does not commit. The branch it opens against is byte for byte the branch the
 * earlier pass pushed, so the body it sends — rendered then, kept since —
 * describes exactly what the merge proposes. Running the loop again instead
 * would put a second commit on the branch and leave that body attesting one.
 *
 * The record is checked against the checkout before it is used. A branch that
 * is no longer here, or was never pushed, means the record has outlived what it
 * describes; it is forgotten and the issue is worked from the beginning, which
 * is the honest answer when the evidence cannot be tied to anything.
 *
 * `undefined` means "there was nothing usable here" — the caller carries on and
 * works the issue normally.
 */
async function finishPending(
  pass: Pass,
  ctx: IssueRunContext,
  claimed: StickyState,
  sticky: StickyRef,
  git: GitContext,
  info: RepoInfo,
  waiting: { path: string; pending: PendingPullRequest },
): Promise<IssueOutcome | undefined> {
  const { path, pending } = waiting;
  const repo = ctx.repo;
  const ref = issueRef(repo, ctx.issue);

  /*
   * The record has to still describe the branch, and now that can be checked
   * rather than assumed: the body names a head, and the branch has one.
   *
   * Three ways it can have gone stale — the branch is gone, it was never
   * pushed, or something moved it since — and all three mean the same thing:
   * the body would attest a merge that is not the merge on offer. The record is
   * forgotten and the issue is worked from the beginning, which is the honest
   * answer when the evidence cannot be tied to what is there.
   */
  const head = refSha(git, 'refs/heads/' + pending.branch);
  const stale =
    !localBranchExists(git, pending.branch)
      ? pending.branch + ' is no longer in this checkout'
      : !remoteBranchExists(git, pending.branch)
        ? pending.branch + ' is not on the remote'
        : head !== pending.commit
          ? pending.branch +
            ' has moved: the kept body describes ' +
            pending.commit +
            ' and its head is now ' +
            (head ?? 'nothing')
          : undefined;
  if (stale !== undefined) {
    forgetPending(path);
    pass.reporter.emit({
      type: 'notice',
      level: 'warning',
      message:
        'a pull request was kept for ' +
        ref +
        ' from run ' +
        pending.runId +
        ', but ' +
        stale +
        ', so it no longer describes what a merge would bring in; the issue is ' +
        'worked from the beginning',
    });
    return undefined;
  }

  pass.reporter.emit({
    type: 'notice',
    level: 'note',
    message:
      'opening the pull request run ' +
      pending.runId +
      ' wrote for ' +
      ref +
      ' and could not send; the loop is not run again, so ' +
      pending.branch +
      ' is exactly what that run pushed',
  });

  // The branch, checked out and left alone.
  ensureIssueBranch(git, { number: ctx.issue, title: claimed.issueTitle });

  let pull: PullRequest;
  try {
    const open = await reread(pass.reporter, 'list the pull requests on ' + pending.branch, () =>
      pass.client.listPullRequests(repo, {
        state: 'open',
        head: repo.owner + ':' + pending.branch,
      }),
    );
    const existing = open.find((entry) => entry.head === pending.branch);
    pull =
      existing ??
      (await pass.client.createPullRequest(repo, {
        title: pending.title,
        head: pending.branch,
        base: pending.base,
        body: pending.body,
        draft: pending.draft,
      }));
  } catch (error) {
    // The record stays: the work is still pushed and still unopened, and the
    // pass after this one should try again rather than start over.
    return await issueFault(pass, repo, ctx.issue, 'the kept pull request was not opened', error);
  }

  forgetPending(path);

  const won = pending.outcome === 'win';
  const state: StickyState = {
    ...claimed,
    budget: pending.budget,
    rounds: pending.rounds,
    pieces: pending.pieces,
    links: {
      ...claimed.links,
      branch: pending.branch,
      ...(info.url === '' ? {} : { branchUrl: info.url + '/tree/' + pending.branch }),
      progress: progressPagePath(pass.cwd, pending.runId),
      pullRequest: pull.number,
      pullRequestUrl: pull.url,
      pullRequestDraft: pull.draft,
    },
  };

  return await settle(pass, ctx, state, sticky, {
    won,
    to: won ? 'review' : 'blocked',
    phase: won ? 'review' : pending.outcome === 'stopped' ? 'stopped' : 'blocked',
    reason: pending.decision ?? 'the run that produced this did not meet the win condition',
    decision: pending.decision ?? '',
    pull,
  });
}

/** The command line the loop is driven with: `run --auto`, per issue. */
function innerArgv(pass: Pass, snapshot: SnapshotPin): string[] {
  return [
    '--auto',
    '--json',
    '--no-config',
    '-C',
    pass.cwd,
    '--max-rounds',
    String(pass.maxRounds),
    '--max-cost',
    String(pass.maxCostUsd),
    ...(pass.maxTurns === undefined ? [] : ['--max-turns', String(pass.maxTurns)]),
    ...(pass.models.lead === undefined ? [] : ['--model', pass.models.lead]),
    ...(pass.models.builder === undefined ? [] : ['--builder-model', pass.models.builder]),
    ...(pass.models.critic === undefined ? [] : ['--critic-model', pass.models.critic]),
    ...(pass.pluginDir === undefined ? [] : ['--plugin-dir', pass.pluginDir]),
    ...(pass.verbose ? ['--verbose'] : []),
    // The repo-relative path, not the absolute one. It resolves to the same
    // file, and it is the spelling the status comment, the pull request body and
    // the run ledger all use for the snapshot — so a reader who sees it in the
    // run's own report sees the same token everywhere else.
    snapshot.relativePath,
  ];
}

/* -------------------------------------------------------------------------- */
/* The endings an issue can have                                               */
/* -------------------------------------------------------------------------- */

/** The last verdict a piece was given, when it was given one. */
function lastVerdictOf(
  rounds: readonly PullRequestRound[],
  piece: string,
): Verdict | undefined {
  let seen: Verdict | undefined;
  for (const round of rounds) {
    if (round.piece === piece) seen = round.verdict;
  }
  return seen;
}

/**
 * What one GitHub fault means for the issue being worked (R11, C6).
 *
 * Every catch around a GitHub call while an issue is in hand comes here, so the
 * four kinds are decided once rather than at each site. Two of them leave by
 * raising — an authentication fault carries R11's 2 out through the entry point,
 * and an unclassified one goes out as itself — and two become an ending this
 * pass reports: a race is a skip, and a blip is work outstanding.
 */
async function issueFault(
  pass: Pass,
  repo: Repo,
  issue: number,
  what: string,
  error: unknown,
): Promise<IssueOutcome> {
  if (!(error instanceof GitHubError)) throw error;
  const kind = classifyFault(error);
  if (kind === 'authentication') throw authenticationFault(error);
  if (kind === 'fault') throw error;

  /*
   * Where the issue actually is, asked rather than assumed.
   *
   * A write that failed may still have half landed — the label add can succeed
   * and the removal fail — so the label this pass last *saw* is not the label
   * the repository holds. It is one request on a path that is already failing,
   * and it is what keeps the row from reporting a state nobody is in.
   */
  let held: Lifecycle | undefined;
  try {
    held = lifecycleOf((await pass.client.getIssue(repo, issue)).labels);
  } catch {
    // Then the row says it does not know, which is better than guessing.
  }

  if (kind === 'race') {
    return skipped(pass.reporter, repo, issue, what + ': ' + firstLine(error), held);
  }

  pass.reporter.emit({
    type: 'notice',
    level: 'warning',
    message: issueRef(repo, issue) + ' — ' + what + ': ' + faultLine(error),
  });
  return {
    repo,
    issue,
    result: 'retry',
    ...(held === undefined ? {} : { label: held }),
    detail: what + ': ' + faultLine(error),
  };
}

/**
 * An issue this pass did not work, and left exactly as it found it.
 *
 * On the note channel and never the error one: nothing went wrong that this
 * pass can act on, and a scheduled runner that printed an error every time
 * another runner reached an issue first would cry wolf several times an hour.
 */
function skipped(
  reporter: Reporter,
  repo: Repo,
  issue: number,
  detail: string,
  label?: Lifecycle | undefined,
): IssueOutcome {
  reporter.emit({
    type: 'notice',
    level: 'note',
    message: 'skipping ' + issueRef(repo, issue) + ': ' + detail,
  });
  return { repo, issue, result: 'skipped', ...(label === undefined ? {} : { label }), detail };
}

/** One line of a fault, flattened, for a place that has room for one line. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return plainText(message.split('\n')[0] ?? '');
}

/**
 * Stops on this issue without a pull request: label blocked, say why, move on.
 *
 * Used wherever the work cannot be carried to a pull request at all — a branch
 * that could not be made, a loop that changed nothing, a pull request GitHub
 * refused. The claim is not simply dropped: an issue left carrying
 * `exolvra:working` by a runner that walked away is exactly the shape C7 has to
 * spend a day recovering, and saying so now costs one request.
 */
async function giveUp(
  pass: Pass,
  ctx: IssueRunContext,
  state: StickyState,
  sticky: StickyRef,
  about: { repo: Repo; issue: number; reason: string; decision: string },
): Promise<IssueOutcome> {
  pass.reporter.emit({ type: 'notice', level: 'warning', message: about.reason });
  // The same finishing step every other ending takes, so the label, the status
  // comment and the row are settled here exactly as they are anywhere else.
  return await settle(pass, ctx, state, sticky, {
    won: false,
    to: 'blocked',
    phase: 'blocked',
    reason: about.reason,
    decision: about.decision,
  });
}

/**
 * Hands the claim back for the next pass, the branch already pushed.
 *
 * For the faults that are about the moment rather than about the work: GitHub
 * unreachable, rate-limiting, or answering 5xx. The authorization label goes
 * back on, and that is this run *returning* the authorization it consumed
 * rather than granting itself one — the same move {@link releaseOnInterrupt}
 * makes, and the only kind of `exolvra:ready` this tool ever writes (C5).
 *
 * It is still not a success. The issue did not reach a pull request, so the
 * pass reports it as work outstanding and exits accordingly: a scheduled runner
 * that answered 0 here would be telling cron everything was fine.
 */
async function standDown(
  pass: Pass,
  ctx: IssueRunContext,
  state: StickyState,
  sticky: StickyRef,
  about: { repo: Repo; issue: number; branch: string; reason: string },
): Promise<IssueOutcome> {
  const why =
    'GitHub could not be reached to open the pull request: ' +
    about.reason +
    '. The work is committed and pushed to ' +
    about.branch +
    ', and the pull request is written and kept, so the next pass opens that one ' +
    'without running the loop again';
  const move = await transitionIssue(ctx, state, sticky, 'ready', {
    why: 'GitHub was unreachable; the claim goes back for the next pass',
    phase: 'claimed',
  });
  pass.reporter.emit({ type: 'notice', level: 'warning', message: why });
  pass.reporter.emit({ type: 'notice', level: 'note', message: move.reason });
  return {
    repo: about.repo,
    issue: about.issue,
    // Not `blocked`: nothing here is a human's to settle, and the issue does
    // not carry that label. The work is outstanding, which is its own word.
    result: 'retry',
    detail:
      'pushed, and the pull request is kept: it is back at ' +
      READY +
      ' for the next pass to open',
  };
}

/**
 * R15: an interrupt releases the claim rather than leaving it held.
 *
 * The two endings the requirement names, and what tells them apart is whether
 * there is work on the branch. Nothing committed means nothing was produced, so
 * the label goes back to ready and the issue is free for the next pass — this
 * runner's or another's. Work on the branch means something was produced that
 * must not be thrown away, so it is pushed and the issue is blocked on a person
 * deciding what to do with it.
 */
async function releaseOnInterrupt(
  pass: Pass,
  ctx: IssueRunContext,
  state: StickyState,
  sticky: StickyRef,
  git: GitContext,
  about: {
    repo: Repo;
    issue: number;
    branch: string;
    /** Where the branch would be readable — used only once it really is. */
    branchUrl?: string;
    committed: boolean;
  },
): Promise<IssueOutcome> {
  const ref = issueRef(about.repo, about.issue);
  const again = (): void => {
    pass.reporter.emit({
      type: 'notice',
      level: 'note',
      message: 'pick it up again with: ' + PROGRAM + ' work ' + ref,
      keepWhole: true,
    });
  };

  if (!about.committed) {
    const move = await transitionIssue(ctx, state, sticky, 'ready', {
      why: 'the run was interrupted before anything was committed',
      phase: 'claimed',
    });
    pass.reporter.emit({ type: 'notice', level: 'note', message: move.reason });
    again();
    return {
      repo: about.repo,
      issue: about.issue,
      result: 'skipped',
      detail: 'interrupted; nothing was committed, so it is back at ' + READY,
      halt: true,
    };
  }

  let pushed = false;
  try {
    pushBranch(git, about.branch);
    pushed = true;
  } catch (error) {
    pass.reporter.emit({
      type: 'notice',
      level: 'warning',
      message: 'the branch could not be pushed after the interrupt: ' + firstLine(error),
    });
  }

  // Linked only if it really is on the remote, for the same reason the ordinary
  // path waits for the push: a link to a branch nobody can fetch is a 404 with
  // this tool's name on it.
  const pushedState: StickyState = {
    ...state,
    phase: 'blocked',
    links: {
      ...state.links,
      ...(pushed && about.branchUrl !== undefined ? { branchUrl: about.branchUrl } : {}),
    },
  };
  const move = await transitionIssue(ctx, pushedState, sticky, 'blocked', {
    why: 'the run was interrupted with work on the branch',
    phase: 'blocked',
    decision:
      'the run was interrupted with work on ' +
      about.branch +
      (pushed ? ', which is pushed' : ', which is committed in the checkout but not pushed') +
      '. Carry it on, or put ' +
      READY +
      ' back on to start a fresh run against the issue',
  });
  pass.reporter.emit({ type: 'notice', level: 'note', message: move.reason });
  again();
  return {
    repo: about.repo,
    issue: about.issue,
    result: 'blocked',
    detail: 'interrupted with work on ' + about.branch,
    halt: true,
  };
}

/* -------------------------------------------------------------------------- */
/* The pull request                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Opens the pull request, or answers with the one already open for this branch.
 *
 * One branch per issue means one pull request per issue: a second pass over an
 * issue whose first pass opened a draft must not open a second draft beside it.
 * They are matched on the head branch, because the head is a fact about the
 * repository rather than something parsed out of a body.
 *
 * The one already open has its body replaced with this run's, from the same
 * renderer a new one gets, so the two paths cannot come to say different things
 * about the same kind of run. R9 asks the body to carry *this* run's verdict
 * history, attestations and budget, and a pull request still describing the
 * pass before it does not.
 */
/** A pull request, or the fault that stopped this run from having one. */
type PullOutcome = { pull: PullRequest } | { fault: GitHubError };

/**
 * What a GitHub fault *is*, for the two things that turn on it: whether the
 * pass may carry on, and which of R11's codes it ends up carrying.
 *
 * Read off `src/github.ts`'s own {@link GitHubFaultKind}, which exists because
 * "a rate limit, a repository this token cannot see, and a token GitHub
 * rejected outright are three different situations". Nothing here parses a
 * sentence to work that out.
 *
 * - `authentication` — the token was rejected, or does not carry the scope the
 *   call needs. R11 gives this 2: the invocation, or the workflow's permission
 *   block, has to change before any of this can work. It is the most common way
 *   the shipped Actions file is misconfigured, so it is the one fault that must
 *   never be quiet.
 * - `transient` — nothing answered, GitHub asked for a wait, or GitHub's own
 *   side failed. Nothing about the invocation is wrong, so it is never 2; the
 *   pass reports that it did not finish and the next one picks up.
 * - `race` — the evidence is that somebody else acted: the label was already
 *   gone (404), or the change was refused as one that no longer applies (422).
 *   This is the case C6 was written for, and it is a silent skip.
 * - `fault` — anything left, including a request this module refused to make.
 *   Unclassified means unclassified, and it goes out as it is.
 */
type FaultKind = 'authentication' | 'transient' | 'race' | 'fault';

function classifyFault(fault: GitHubError): FaultKind {
  if (fault.kind === 'auth') return 'authentication';
  if (fault.kind === 'rate-limit' || fault.kind === 'unreachable') return 'transient';
  if (fault.kind === 'malformed') return 'transient';
  if (fault.status !== undefined && fault.status >= 500) return 'transient';
  if (fault.kind === 'not-found') return 'race';
  // 422 the change no longer applies, 409 the state moved underneath, 410 it is
  // gone. All three are GitHub saying somebody else acted, which is exactly the
  // evidence C6's silent skip was written for — and falling through instead
  // aborted the whole pass and stranded every issue after this one.
  if (fault.status === 422 || fault.status === 409 || fault.status === 410) return 'race';
  return 'fault';
}

/**
 * The permissions a runner needs, said where the token was refused.
 *
 * `src/github.ts` names the scopes a personal access token needs. This adds the
 * half that belongs to the deployment this feature ships: an Actions workflow
 * grants permissions in the workflow file, and a runner that cannot label an
 * issue is almost always one whose `permissions:` block is missing a line.
 */
function authenticationFault(fault: GitHubError): ConfigError {
  return new ConfigError(
    [
      fault.message,
      '  a runner writes labels, comments, branches and pull requests, so a',
      '  GitHub Actions workflow needs `permissions:` with `issues: write`,',
      '  `pull-requests: write` and `contents: write`',
      '  a personal access token needs the `repo` scope, or `public_repo` on a',
      '  public repository',
    ].join('\n'),
  );
}

/**
 * What a status comment still wrongly says, off its own hidden marker.
 *
 * The marker is the machine-readable half of the comment `src/issue-run.ts`
 * writes, so this reads the phase and label it was last published with rather
 * than parsing that module's prose back out of the rendered body. With no
 * marker to read, the honest answer is that this does not know.
 */
function staleSays(sticky: StickyRef): string {
  const marker = sticky.marker;
  if (marker === undefined) return 'whatever it last said';
  const parts: string[] = [];
  if (marker.phase !== '') parts.push('phase ' + marker.phase);
  if (marker.label !== '' && marker.label !== 'none') parts.push('label ' + marker.label);
  return parts.length === 0 ? 'whatever it last said' : parts.join(' and ');
}

/**
 * A pass that stopped before it reached an issue, in the one voice they share.
 *
 * Nothing was claimed and nothing was written, so there is no verdict to report
 * and nothing for a person to fix — only a reason, and a next pass. Said the
 * same way whether GitHub could not be asked who the token is or could not be
 * asked for the queue, because to whoever reads it those are one event.
 */
function stoppedEarly(reporter: Reporter, reason: string): void {
  reporter.emit({
    type: 'notice',
    level: 'warning',
    message: 'the pass stopped early: ' + reason,
  });
}

/** A fault in one line, with when a rate limit lifts when that is what it is. */
function faultLine(fault: GitHubError): string {
  const lifts =
    fault.kind === 'rate-limit' && fault.resetAt !== undefined
      ? ' — the limit lifts at ' + isoSeconds(fault.resetAt) + ' (in ' + until(fault.resetAt) + ')'
      : '';
  return firstLine(fault) + lifts;
}

async function openPullRequest(
  pass: Pass,
  repo: Repo,
  branch: string,
  base: string,
  report: PullRequestReport,
  draft: boolean,
): Promise<PullOutcome> {
  try {
    // The read a whole loop run stands between: see {@link reread}.
    const open = await reread(pass.reporter, 'list the pull requests on ' + branch, () =>
      pass.client.listPullRequests(repo, { state: 'open', head: repo.owner + ':' + branch }),
    );
    const existing = open.find((pull) => pull.head === branch);
    if (existing !== undefined) {
      return { pull: await refreshPullRequest(pass, repo, branch, existing, report) };
    }
    return {
      pull: await pass.client.createPullRequest(repo, {
        title: pullRequestTitle(report),
        head: branch,
        base,
        body: renderPullRequestBody(report),
        draft,
      }),
    };
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    pass.reporter.emit({ type: 'notice', level: 'error', message: firstLine(error) });
    return { fault: error };
  }
}

/**
 * Replaces the body of the pull request an earlier pass opened.
 *
 * The body only. Two things are deliberately left alone:
 *
 * - **The title.** It is the issue's own, which this body carries anyway, and a
 *   maintainer reading the draft may well have edited it — silently writing
 *   over a person's edit is the class of thing this runner never does.
 * - **The draft flag**, because there is no way to change it here and it should
 *   not be changed anyway: taking a pull request out of draft is telling
 *   reviewers it is ready, and that is a decision. A won run says so in the
 *   body, in the label and in the status comment, and a person marks it ready.
 *   The body says this in as many words, so nobody has to wonder why a **WIN**
 *   is sitting on a draft.
 *
 * A refresh that fails is said out loud and not fatal. The pull request is
 * open, the branch carries the work, and the label and the status comment both
 * record what this run did — a body one pass out of date is worth a warning,
 * and is not worth blocking an issue a human would then have to unblock.
 */
async function refreshPullRequest(
  pass: Pass,
  repo: Repo,
  branch: string,
  existing: PullRequest,
  report: PullRequestReport,
): Promise<PullRequest> {
  const body = renderPullRequestBody({
    ...report,
    refreshed: { number: existing.number, draft: existing.draft },
  });
  try {
    const updated = await pass.client.updatePullRequest(repo, existing.number, { body });
    pass.reporter.emit({
      type: 'notice',
      level: 'note',
      message:
        '#' +
        existing.number +
        ' was already open from ' +
        branch +
        ', so it was refreshed rather than reopened: its body now carries this run’s ' +
        'evidence, and its title is left as it was',
    });
    return updated;
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    pass.reporter.emit({
      type: 'notice',
      level: 'warning',
      message:
        '#' +
        existing.number +
        ' is open from ' +
        branch +
        ' but its body could not be refreshed, so it still describes the pass before ' +
        'this one: ' +
        firstLine(error) +
        '. What this run did is in the status comment on the issue',
    });
    return existing;
  }
}

/**
 * What was checked rather than asserted, for the body of the pull request.
 *
 * Each of these is read back off disk at the moment the pull request is written
 * rather than remembered from when the run started, because the point of an
 * attestation is that somebody could go and check it.
 */
function attestationsFor(
  pass: Pass,
  runId: string,
  snapshot: SnapshotPin,
  branch: string,
  base: string,
  heartbeatFault: string | undefined,
): Attestation[] {
  const verified = verifyIssueSnapshot(pass.cwd, runId);
  const bar = readBarPin(pass.cwd);
  const out: Attestation[] = [
    {
      name: 'Issue snapshot',
      detail: verified.verified
        ? snapshot.relativePath +
          ' still hashes to sha256:' +
          shortSha(snapshot.sha256) +
          ', as pinned when the issue was claimed'
        : snapshot.relativePath + ' no longer verifies: ' + verified.reason,
      ok: verified.verified,
    },
    {
      name: 'Repo standards',
      detail:
        pass.standardsPin === undefined
          ? 'this repository declares no ' +
            STANDARDS_PATH +
            ', so the run was judged on the issue alone'
          : pass.standardsPin.path +
            ' at sha256:' +
            shortSha(pass.standardsPin.sha256) +
            ' supplied ' +
            countOf(pass.standardsPin.gates, 'standing gate', 'standing gates'),
      ok: true,
    },
    {
      name: 'Bar',
      detail:
        bar === undefined
          ? 'the run left no ' +
            RUN_DIR +
            '/bar/bar.sha256 behind, so the bar it captured is not pinned here'
          : bar.path + ' pins ' + bar.pins + ' artifacts by sha256',
      ok: bar !== undefined && bar.pins > 0,
    },
    {
      name: 'Runner identity',
      detail:
        '@' +
        pass.identity.login +
        ', settled from ' +
        (pass.identity.from === 'token'
          ? 'the token itself'
          : 'the operator’s own configuration') +
        ' before the first issue was read',
      ok: true,
    },
    {
      name: 'Branch',
      detail:
        branch +
        ' is this runner’s own branch for this issue: it is not ' +
        base +
        ', it was never force-pushed, and nothing here merged, approved or closed anything',
      ok: true,
    },
  ];
  if (heartbeatFault !== undefined) {
    out.push({
      name: 'Heartbeat',
      detail: 'at least one round’s heartbeat could not be written: ' + heartbeatFault,
      ok: false,
    });
  }
  return out;
}

/**
 * The commit message one issue's work lands under.
 *
 * The issue's own title, flattened, and then the facts that say where the work
 * came from. Nothing here says the pull request closes the issue: closing one is
 * a decision, and this tool makes none.
 */
function commitMessage(repo: Repo, issue: Issue, snapshot: SnapshotPin, runId: string): string {
  const subject = truncate(plainText(issue.title), 72);
  return normalizeCommitMessage(
    [
      subject === '' ? 'Work ' + issueRef(repo, issue.number) : subject,
      '',
      'Worked from ' + issueRef(repo, issue.number) + '.',
      'Spec: ' + snapshot.relativePath + ' (sha256:' + shortSha(snapshot.sha256) + ')',
      'Run: ' + runId,
    ].join('\n'),
  );
}

/**
 * Records the issue, the branch and the pull request against the run (R14).
 *
 * The ledger's shape is `src/runs-store.ts`'s, and what it keeps for a run is
 * what the run was given. An issue run was given the issue, so that is what goes
 * in — with the branch, the snapshot and the pull request beside it, which is
 * how `queue --fleet` ties a ledger row back to the issue it is about.
 */
function recordIssueRun(
  pass: Pass,
  ledgerRunId: string | undefined,
  repo: Repo,
  issue: number,
  runId: string,
  branch: string,
  pullUrl: string,
  /** Said here as well when the public status comment is out of date. */
  stale?: string,
): void {
  if (ledgerRunId === undefined) return;
  try {
    updateRun(pass.cwd, ledgerRunId, {
      input: [
        issueRef(repo, issue),
        branch,
        runDirDisplay(runId) + '/' + SNAPSHOT_FILE,
        pullUrl,
        ...(stale === undefined ? [] : [stale]),
      ]
        .filter((piece) => piece !== '')
        .join(' · '),
    });
  } catch (error) {
    pass.reporter.emit({
      type: 'notice',
      level: 'warning',
      message: 'the run ledger was not annotated with the issue: ' + firstLine(error),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* What a person sees                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One cell of text that came out of an issue.
 *
 * {@link cell} does what the terminal needs — one printable line, with the
 * characters that reorder a row taken out — and {@link redactSecrets} does what
 * C12 needs: a credential somebody pasted into an issue title is not printed
 * back out by the command that reads the issue. `work --help` promises exactly
 * that, in as many words, of "a comment, a pull request body, a run record or
 * this terminal", and the dry run is this terminal.
 *
 * It runs on both sides of the flattening, because a token interrupted by an
 * escape sequence or a right-to-left override is only recognisable once those
 * are gone — the same two passes `queue` makes, for the same reason.
 */
function issueText(text: string): string {
  return redactSecrets(cell(redactSecrets(text)));
}

const SUMMARY_COLUMNS: readonly string[] = ['repo', 'issue', 'result', 'label', 'detail'];

function renderSummary(view: Viewport, outcomes: readonly IssueOutcome[]): string[] {
  return renderTable(
    SUMMARY_COLUMNS,
    outcomes.map((outcome) => [
      issueText(repoSlug(outcome.repo)),
      '#' + outcome.issue,
      outcome.result,
      outcome.label === undefined ? '—' : lifecycleLabel(outcome.label),
      issueText(outcome.detail),
    ]),
    view,
    0,
    ['repo', 'issue'],
  );
}

const PLAN_COLUMNS: readonly string[] = ['repo', 'issue', 'title', 'criteria', 'verify'];

/**
 * The pickup plan and the spec each issue would produce (R13).
 *
 * Everything below was read and nothing was written: no label moved, no comment
 * was posted, no branch was cut, and no request that was not a GET left this
 * process. What it shows is the judgement that decides whether an issue is
 * runnable at all, so a maintainer can see why an issue would be triaged before
 * it is.
 */
function renderDryRun(
  view: Viewport,
  repos: readonly Repo[],
  plan: Pickup,
  standards: Standards | null,
  derived: readonly { candidate: Candidate; spec: DerivedSpec }[],
): string[] {
  const lines: string[] = [
    'dry run — nothing here was claimed, labelled, commented on, branched or pushed',
    '',
    'allowlist  ' + describeAllowlist(repos),
    'standards  ' +
      (standards === null
        ? 'this repository declares none'
        : STANDARDS_PATH +
          ' — ' +
          countOf(standards.gates.length, 'gate', 'gates') +
          ', ' +
          countOf(standards.standingBar.length, 'standing bar entry', 'standing bar entries')),
    'eligible   ' +
      (plan.eligible.length + plan.waiting.length) +
      ' carrying ' +
      READY +
      ', ' +
      plan.eligible.length +
      ' within the work-in-progress cap',
    'recover    ' +
      plan.recoverable.length +
      ' carrying ' +
      WORKING +
      ', which a stale claim would be taken back from',
  ];

  if (plan.eligible.length === 0) {
    lines.push('', 'nothing would be picked up' + (plan.why === '' ? '' : ': ' + plan.why) + '.');
    return lines;
  }

  lines.push('', 'would pick up, oldest first:', '');
  lines.push(
    ...renderTable(
      PLAN_COLUMNS,
      derived.map((entry) => [
        issueText(repoSlug(entry.candidate.repo)),
        '#' + entry.candidate.issue.number,
        issueText(entry.candidate.issue.title),
        entry.spec.criteria.length === 0 ? 'none' : String(entry.spec.criteria.length),
        entry.spec.commands.length === 0 ? 'none' : String(entry.spec.commands.length),
      ]),
      view,
      2,
      ['repo', 'issue'],
    ),
  );

  for (const entry of derived) {
    lines.push('', ...renderDerivedSpec(entry.candidate.repo, entry.candidate.issue, entry.spec, view));
  }
  if (plan.waiting.length > 0) {
    lines.push(
      '',
      'waiting for a later pass: ' +
        plan.waiting
          .map((candidate) => issueRef(candidate.repo, candidate.issue.number))
          .join(', '),
    );
  }
  return lines;
}

/**
 * One issue's derived spec, printed the way R13 asks for it.
 *
 * The whole judgement rather than a summary of it: what the goal is, every
 * criterion that was found and where it came from, every verification command
 * and which of the two places it was allowed to come from, and — when the issue
 * is not runnable — exactly what is missing and what would satisfy it.
 */
export function renderDerivedSpec(
  repo: Repo,
  issue: Issue,
  spec: DerivedSpec,
  view: Viewport,
): string[] {
  const lines: string[] = [
    issueRef(repo, issue.number) + ' — ' + issueText(issue.title),
    '  goal       ' + issueText(spec.goal),
    '  read       ' +
      spec.bodyCharacters +
      ' characters of body, ' +
      spec.commentCount +
      ' comments',
    '  runnable   ' + (spec.runnable ? 'yes' : 'no — it would be triaged, and not claimed'),
  ];

  if (spec.criteria.length === 0) {
    lines.push('  criteria   none');
  } else {
    lines.push('  criteria');
    lines.push(
      ...renderTable(
        ['criterion', 'from'],
        spec.criteria.map((criterion) => [
          issueText(criterion.text),
          issueText(criterion.source.where),
        ]),
        view,
        4,
        [],
      ),
    );
  }

  if (spec.commands.length === 0) {
    lines.push('  verify     none');
  } else {
    lines.push('  verify');
    lines.push(
      ...renderTable(
        ['command', 'from'],
        spec.commands.map((command) => [issueText(command.command), issueText(command.where)]),
        view,
        4,
        [],
      ),
    );
  }

  for (const missing of spec.missing) {
    lines.push(
      '  missing    ' + missing.name,
      '    looked for  ' + issueText(missing.why),
      '    to fix      ' + issueText(missing.remedy),
    );
  }
  return lines;
}
