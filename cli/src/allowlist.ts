/**
 * The blast radius of one invocation.
 *
 * C5 of `docs/specs/issue-runner-spec.md` puts two things in one sentence: only
 * issues carrying the ready label, in a repository explicitly allowlisted for
 * this invocation, are eligible. Both halves live here, together, because they
 * are one question — *what may this run touch?* — and answering it in two places
 * is how the two answers start to disagree.
 *
 * Three names are settled here and nowhere else:
 *
 * - **Which repositories.** Named per invocation, as a repeatable flag or an
 *   environment variable; never read from a file, never inferred from a remote,
 *   and never empty. An empty allowlist is refused with the command's usage line
 *   under it, because the alternative reading — every repository this token can
 *   see — is the one thing C5 says it must never mean.
 * - **Which labels.** The lifecycle namespace is prefixed so it can never
 *   collide with a repository's own labels (R5), and this tool touches no label
 *   outside it (C8).
 * The third name a run owns — the branch one issue's work lives on (C4) — is
 * `src/git.ts`'s, because that is the module that refuses to write outside it.
 *
 * Nothing here reaches the network or the filesystem: it turns text into the
 * values the commands act on, and refuses the text that is not one of them.
 */
import { UsageError, usageFor } from './exit.js';
import { type Repo, repoFault, repoSlug } from './github.js';
import type { Command, FlagSpec, ValueFlagSpec, ValueType } from './registry.js';

/* -------------------------------------------------------------------------- */
/* The names this tool owns inside a repository                                */
/* -------------------------------------------------------------------------- */

/** What every label this tool applies starts with, so none can collide (R5). */
export const LABEL_PREFIX = 'exolvra:';

/** The states an issue moves through while this tool has it. */
export type Lifecycle = 'ready' | 'working' | 'review' | 'blocked' | 'triage';

/**
 * Every lifecycle state, in the order one wins when an issue carries two.
 *
 * An issue is meant to carry exactly one at a time, and mostly does. It carries
 * two for a moment during a transition, and can carry two for good if a human
 * relabels one by hand — so the tie is broken by which state a reader most needs
 * to be told about: something waiting on a person first, then the pull request
 * that exists, then the claim, then the two that mean nobody has started.
 */
export const LIFECYCLE: readonly Lifecycle[] = [
  'blocked',
  'review',
  'working',
  'triage',
  'ready',
];

/** The label that carries one state, spelled the one way it is ever spelled. */
export function lifecycleLabel(state: Lifecycle): string {
  return LABEL_PREFIX + state;
}

/** Every lifecycle label, in {@link LIFECYCLE} order. */
export const LIFECYCLE_LABELS: readonly string[] = LIFECYCLE.map(lifecycleLabel);

/** Which state `labels` puts an issue in, or undefined when none of them do. */
export function lifecycleOf(labels: readonly string[]): Lifecycle | undefined {
  const carried = new Set(labels);
  return LIFECYCLE.find((state) => carried.has(lifecycleLabel(state)));
}

/** One issue named in one token: `owner/name#123`, as GitHub writes it. */
export function issueRef(repo: Repo, number: number): string {
  return repoSlug(repo) + '#' + number;
}

/* -------------------------------------------------------------------------- */
/* Which repositories                                                          */
/* -------------------------------------------------------------------------- */

/** The environment variable that names the allowlist when no flag does (R1). */
export const REPOS_ENV = 'EXOLVRA_GENESIS_REPOS';

/** How the flag that names one repository is written. */
export const REPO_FLAG = '--repo';

/**
 * One `owner/name`, checked before it is ever half of a URL.
 *
 * The judgement is {@link repoFault}'s, so a value refused here is refused for
 * the same reason a value that arrives some other way is refused by the network
 * module — one rule, described in one place, applied at both ends. What this
 * adds is the shape a rejection takes on a command line: the value quoted back,
 * the input named as the user wrote it, and the usage line under it.
 */
export const repoValue: ValueType<Repo> = {
  arg: 'owner/name',
  // A repository that is really a path: two slashes is the mistake this exists
  // to refuse, so it is the value the gate suite drives it with.
  invalid: 'not/a/repository/path',
  parse(raw, ctx) {
    const why = repoFault(raw);
    if (why !== undefined) {
      throw new UsageError(
        [
          'invalid value "' + raw + '" for ' + ctx.flag + ': ' + why,
          '  a repository is written owner/name, as in cli/cli',
        ].join('\n'),
        usageFor(ctx.flag, ctx.usage),
      );
    }
    const parts = raw.split('/');
    return { owner: parts[0] ?? '', name: parts[1] ?? '' };
  },
};

/** What separates one repository from the next in {@link REPOS_ENV}. */
const SEPARATORS = /[\s,]+/;

/**
 * A list of repositories, as one environment variable holds them.
 *
 * Commas or whitespace, because an environment variable is written by hand as
 * often as by a workflow file, and `a/b, c/d` and `a/b c/d` are the same
 * intention. Every entry goes through {@link repoValue}, so a list is only ever
 * as valid as each repository in it.
 */
export const reposValue: ValueType<Repo[]> = {
  arg: 'owner/name,...',
  invalid: repoValue.invalid,
  parse(raw, ctx) {
    const pieces = raw.split(SEPARATORS).filter((piece) => piece !== '');
    if (pieces.length === 0) {
      throw new UsageError(
        'invalid value "' + raw + '" for ' + ctx.flag + ': it names no repository',
        usageFor(ctx.flag, ctx.usage),
      );
    }
    return pieces.map((piece) => repoValue.parse(piece, ctx));
  },
};

/* -------------------------------------------------------------------------- */
/* A flag written more than once                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every value `flag` was given, in the order they were written.
 *
 * The registry keeps one value per flag, which is the right shape for every flag
 * that has ever existed here: a second `--model` replaces the first, and the run
 * has one model. An allowlist is the exception — `--repo a/b --repo c/d` names
 * two repositories and losing the first would silently narrow what a run looked
 * at — so this reads the repetitions back out of the command line.
 *
 * Shape only, mirroring the registry parser's own first pass: which tokens
 * are flags, and which of them take the token after. Nothing is decided here
 * that the parser has not already decided — an unknown flag is left for it to
 * reject, and a value-taking flag consumes its value whether or not it is the
 * flag being collected, so `--model --repo` cannot be read as a repository. Each
 * value that is collected goes through the flag's own {@link ValueType}, so a
 * repetition is validated at exactly the boundary the first occurrence was.
 */
export function repeatedFlagValues<T>(
  command: Command,
  argv: readonly string[],
  flag: ValueFlagSpec<T>,
  cwd: string,
): T[] {
  const byLong = new Map<string, FlagSpec>();
  const byShort = new Map<string, FlagSpec>();
  for (const declared of command.flags) {
    byLong.set(declared.long, declared);
    if (declared.short !== undefined) byShort.set(declared.short, declared);
  }

  const out: T[] = [];
  let terminated = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (terminated || token === '-' || !token.startsWith('-')) continue;
    if (token === '--') {
      terminated = true;
      continue;
    }

    const isLong = token.startsWith('--');
    const body = isLong ? token.slice(2) : token.slice(1);
    const eq = body.indexOf('=');
    const name = eq === -1 ? body : body.slice(0, eq);
    const written = (isLong ? '--' : '-') + name;
    const declared = isLong ? byLong.get(name) : byShort.get(name);
    if (declared?.value === undefined) continue;

    let text = eq === -1 ? undefined : body.slice(eq + 1);
    if (text === undefined) {
      const next = argv[i + 1];
      // No value to take: the parser refuses this invocation, and refusing it
      // here as well would mean two different sentences about one mistake.
      if (next === undefined || (next.startsWith('-') && next !== '-')) continue;
      text = next;
      i += 1;
    }

    if (declared !== (flag as FlagSpec)) continue;
    out.push(flag.value.parse(text, { flag: written, usage: command.usage, cwd }));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The allowlist itself                                                        */
/* -------------------------------------------------------------------------- */

/** Where the repositories for one invocation came from. */
export interface AllowlistRequest {
  /** Repositories named on the command line, in the order they were written. */
  fromFlags: readonly Repo[];
  /** Repositories from {@link REPOS_ENV}, when no flag overrode it. */
  fromEnv?: readonly Repo[] | undefined;
  /** The usage line echoed under a refusal. */
  usage: string;
  /** The flag as the user wrote it, so a refusal names their own spelling. */
  flag?: string | undefined;
}

/**
 * The refusal an empty allowlist gets.
 *
 * It says what an empty allowlist is *not*, in as many words, because that is
 * the whole of C5's rule and the reading somebody reaches for when a scheduled
 * pass finds nothing: a run that was given no repository looked at none, and
 * never at "everything the token can see".
 */
function emptyAllowlist(request: AllowlistRequest): UsageError {
  const flag = request.flag ?? REPO_FLAG;
  return new UsageError(
    [
      'no repository is allowlisted for this run',
      '  nothing is eligible until a repository is named, and an empty allowlist',
      '  is never every repository the token can see',
      '  name one with ' + flag + ' owner/name, which may be repeated, or set',
      '  ' + REPOS_ENV + ' to a comma-separated list',
    ].join('\n'),
    request.usage,
  );
}

/**
 * The repositories this invocation may look at, or a raised refusal.
 *
 * Flags win over the environment outright rather than merging with it: a
 * workflow that exports {@link REPOS_ENV} and a person who types `--repo` on top
 * of it mean "just this one", and quietly adding the environment's repositories
 * back would widen a run past what was asked for.
 *
 * Duplicates collapse, keeping the spelling first written. GitHub matches owner
 * and repository names without regard to case, so `cli/cli` and `CLI/CLI` are
 * one repository, and listing it twice would work it twice.
 */
export function resolveAllowlist(request: AllowlistRequest): Repo[] {
  const named =
    request.fromFlags.length > 0 ? request.fromFlags : (request.fromEnv ?? []);

  const seen = new Map<string, Repo>();
  for (const repo of named) {
    const key = repoSlug(repo).toLowerCase();
    if (!seen.has(key)) seen.set(key, repo);
  }

  const allowed = [...seen.values()];
  if (allowed.length === 0) throw emptyAllowlist(request);
  return allowed;
}

/** The allowlist as one phrase, for a sentence that has to name it. */
export function describeAllowlist(repos: readonly Repo[]): string {
  return repos.map(repoSlug).join(', ');
}
