/**
 * The issue lifecycle: everything between "an eligible issue exists" and "the
 * loop can run it".
 *
 * `docs/specs/issue-runner-spec.md` puts five obligations in this file, and
 * every one of them is a mechanism here rather than an instruction somewhere
 * else (C3):
 *
 * - **R3/C11 — the snapshot.** The issue, its labels and its whole comment
 *   thread are written to `.exolvra-genesis/runs/<id>/issue.md` and pinned by
 *   sha256 in `issue.sha256` beside it, in the same sha256sum format the bar is
 *   pinned in. That file is the spec the run works from, so it is written
 *   verbatim: a body this module "tidied" would be a body nobody could verify
 *   afterwards, and re-verifying the pin every round would then be checking
 *   this module's edit rather than GitHub's issue.
 * - **R4 — the triage gate.** A run needs a bar it can check. When one cannot
 *   be derived from the issue and the repo's standards, nothing is guessed:
 *   what is missing is named, specifically, in a comment, the label moves to
 *   `exolvra:triage`, and the pass steps aside.
 * - **R5/C8 — the labels.** Five names, one namespace, and nothing else is ever
 *   added or removed. The vocabulary itself belongs to `src/allowlist.ts`,
 *   which owns the rest of C5's blast radius; this module imports it and holds
 *   no copy. The rule is enforced where the request is made, not in the caller:
 *   {@link requireLifecycleState} stands in front of every label call in this
 *   file, so a sixth label cannot reach GitHub by being passed in.
 * - **C6 — the claim.** Removing `exolvra:ready` is the whole race. GitHub
 *   answers the delete with 404 when the label is not there, which makes it a
 *   compare-and-swap: exactly one runner is told it removed the label, and
 *   every other runner is told the label had already moved and stops without
 *   writing anything at all.
 * - **C7 — the heartbeat.** The sticky comment carries a UTC heartbeat in a
 *   hidden marker, updated every round. A claim whose heartbeat is older than
 *   the TTL may be flipped back through `exolvra:ready` with the takeover
 *   written into the sticky comment, so a runner that died never strands an
 *   issue; a claim younger than the TTL is untouchable, and the reclaim path
 *   makes no request that could change anything before it knows which it is.
 * - **R6 — the sticky comment.** One comment per issue, found by a hidden
 *   marker and edited in place forever. Its sections are the same on every
 *   render, in the same order, whether the run is one round old or forty: a
 *   reader who has read one has read them all, and the bulk that would drown
 *   the summary is folded into `<details>` instead of being dropped.
 *
 * Everything an issue carries is untrusted input (C5). It is data to snapshot
 * and to judge against — never interpolated into anything executable, and
 * everything written back goes through {@link untrusted} first: secrets
 * redacted (C12), markers neutralised, bidi controls removed, then flattened
 * and markdown-escaped for a cell or fenced wider than any backtick run inside
 * it for an excerpt. The snapshot on disk keeps the issue's own words, minus
 * anything shaped like a token.
 *
 * **Two boundaries in this file are about privilege rather than presentation,
 * and the pieces downstream inherit both.**
 *
 * - *Command provenance.* A verification command is derived from the issue body
 *   and the repository's committed `.exolvra-genesis/standards.md`, and from
 *   nowhere else — never from a comment, whoever wrote it. Editing the body and
 *   committing to the repository are acts the repository already trusts;
 *   leaving a comment is not, and a command is a thing that gets executed.
 * - *Identity.* A comment is this run's status comment only if it names this
 *   issue and was written by the account this run authenticates as. A heartbeat
 *   read out of a stranger's comment is a label move a stranger controls.
 *
 *   That account is a **precondition, not a mode** (spec addendum v0.1.2).
 *   GitHub will not always name a token — an installation token, which is what
 *   the shipped Actions workflow uses, is refused `GET /user` outright — and
 *   for one of those the operator names the account instead, with
 *   `--runner-login`. {@link requireRunnerLogin} settles it once, before the
 *   pass reads an issue, and refuses the run when neither answers; every
 *   context in this file carries the login it produced, and nothing here can be
 *   asked to act without one.
 *
 *   Seven adversarial passes established why there is no third option. A
 *   decision whose only evidence is a comment any stranger may author has
 *   exactly two answers — trust it, and a stranger causes a write; distrust it,
 *   and a stranger withholds the recovery C7 promises — and both were real
 *   defects here, twice each. So a status comment is either provably this
 *   account's or it is somebody else's writing, and every write below is gated
 *   on something a stranger cannot type:
 *
 *   - **The claim** is gated on the `ready` label, which is a maintainer's act.
 *     A comment cannot put it there.
 *   - **Triage** is gated the same way.
 *   - **Recovering a claim** is gated on `exolvra:working` — the label only
 *     this tool writes — or on this account's own status comment. It reads the
 *     label **set** rather than one precedence winner, because an issue
 *     carrying `working` is a claim to recover whatever else is on it, and
 *     reading the winner instead left `[working, review]` unrecoverable. A
 *     comment this account did not write may *delay* that recovery and never
 *     cause one, and only for a claim that is not this account's to begin with
 *     ({@link freshForeignClaim}) — which is how two runners under different
 *     logins stay out of each other's way.
 *   - **Landing on `ready`** puts the authorization label back, so it needs
 *     this account's own receipt, or a `ready` already on the issue.
 *
 *   Read-only surfaces — `queue`, `--dry-run`, the fleet page — make no writes,
 *   so no decision of theirs can be steered and none of them needs any of this.
 *
 * Nothing here prints. It answers with values and raises faults in the house
 * shape, and the command decides what a person sees.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  LABEL_PREFIX,
  LIFECYCLE,
  LIFECYCLE_LABELS,
  type Lifecycle,
  issueRef,
  lifecycleLabel,
  lifecycleOf,
} from './allowlist.js';
import { ConfigError, UsageError, usageFor } from './exit.js';
import {
  type GitHubClient,
  GitHubError,
  REDACTED,
  type IssueComment,
  type IssueThread,
  type Repo,
  isoSeconds,
  redactSecrets,
  repoSlug,
  until,
} from './github.js';
import { RUN_DIR, isRunId } from './runs-store.js';
import type { Standards } from './standards.js';
import {
  PROGRAM,
  displayWidth,
  graphemes,
  plainText,
  printableBlock,
  truncate,
} from './usage.js';

/* -------------------------------------------------------------------------- */
/* The five labels (R5, C8), as `src/allowlist.ts` settles them                */
/* -------------------------------------------------------------------------- */

/*
 * The vocabulary is not declared here. `src/allowlist.ts` owns it — the prefix,
 * the five states, the one spelling of each label, and which state a set of
 * labels puts an issue in — because it owns the other half of C5's sentence and
 * the two halves are one question. A second copy of a safety-relevant constant
 * is not a convenience; it is the point at which the queue and the runner start
 * to disagree about what an issue's state is, each of them correct against its
 * own copy.
 *
 * This module holds no label text at all. It works in {@link Lifecycle} states,
 * and a state becomes a label exactly once, in {@link requireLifecycleState},
 * on its way into a request.
 */

/**
 * Whether `name` is one of the five, compared exactly as GitHub stores it.
 *
 * Derived from the shared list rather than from a list here. Exactly, and not
 * case-insensitively: a repository may hold `Exolvra:Ready` as a label of its
 * own, and treating it as this tool's label would be this tool removing
 * somebody else's label. The near misses are refused for the same reason
 * `exolvra:readyish` is.
 */
export function isLifecycleLabel(name: string): boolean {
  return LIFECYCLE_LABELS.includes(name);
}

/**
 * Whether `name` is written under the shared prefix at all.
 *
 * Being in the namespace is not the same as being one of the five: charting's
 * `exolvra:map` and `exolvra:decide` share the prefix, and this module touches
 * neither. The distinction is what a refusal has to be able to say.
 */
export function inLabelNamespace(name: string): boolean {
  return name.startsWith(LABEL_PREFIX);
}

/**
 * `state` as the label that carries it, or a raised refusal.
 *
 * The only place in this module where a lifecycle label is spelled, and the
 * only place a label reaches a request. C8 is a sentence in a spec until
 * something refuses to make the call, and this is the thing that refuses —
 * for a state the shared vocabulary does not have, whatever a caller with no
 * types in front of it passed in.
 */
function requireLifecycleState(state: string, operation: string): string {
  if ((LIFECYCLE as readonly string[]).includes(state)) {
    return lifecycleLabel(state as Lifecycle);
  }
  const because = isLifecycleLabel(state)
    ? 'that is the label; this takes the state the label carries'
    : inLabelNamespace(state)
      ? 'it is in the ' + LABEL_PREFIX + ' namespace, but it is not one of the five'
      : 'this tool adds and removes no label outside the ' + LABEL_PREFIX + ' lifecycle';
  throw new ConfigError(
    [
      'refusing to ' + operation,
      '  the lifecycle state is ' + inlineValue(state),
      '  ' + because,
      '  the lifecycle is: ' + LIFECYCLE.join(', '),
      '  spelled: ' + LIFECYCLE_LABELS.join(', '),
    ].join('\n'),
  );
}

/** Every label on the issue that this module does not own, in order. */
export function foreignLabels(labels: readonly string[]): string[] {
  return labels.filter((label) => !isLifecycleLabel(label));
}

/** Whether the maintainer's authorization is live, and if not, why not. */
export interface Claimability {
  /** True when this issue may be claimed. */
  ok: boolean;
  /** One clause, reading after the issue reference. Empty when `ok`. */
  why: string;
}

/**
 * Whether a maintainer has authorized this issue right now (C5).
 *
 * Read off the label **set**, not off one precedence winner, and that is the
 * whole of the fix here. `lifecycleOf` answers "which state does a reader most
 * need to be told about", which ranks `ready` last — so an issue carrying both
 * `exolvra:triage` and `exolvra:ready` read as *triage* and was refused. That
 * pair is exactly what this tool's own triage comment asks a maintainer to
 * create: "add what is listed above and put `exolvra:ready` back on". The
 * instruction has to work.
 *
 * Three readings, and each is about what a *person* meant:
 *
 * - **`ready` beside a resting status** (`triage`, `review`) — the maintainer
 *   answered. The authorization is the newer act, so it wins, and the stale
 *   status is tidied away by the claim itself.
 * - **`ready` beside `working`** — a claim caught mid-move, or a runner that
 *   stalled between adding `working` and removing `ready`. Somebody may hold
 *   it, so it is not free to take: the compare-and-swap decides, not this.
 * - **`ready` beside `blocked`** — two human decisions in an order nobody here
 *   can know. Working it would overrule whichever came second, so it is left
 *   for a person, and the refusal says exactly that.
 */
export function claimability(labels: readonly string[]): Claimability {
  const held = new Set(labels.filter(isLifecycleLabel));
  if (!held.has(lifecycleLabel('ready'))) {
    const carried = lifecycleOf(labels);
    return {
      ok: false,
      why:
        carried === undefined
          ? 'does not carry ' + lifecycleLabel('ready')
          : 'is ' + lifecycleLabel(carried) + ', not ' + lifecycleLabel('ready'),
    };
  }
  if (held.has(lifecycleLabel('blocked'))) {
    return {
      ok: false,
      why:
        'carries ' +
        lifecycleLabel('ready') +
        ' and ' +
        lifecycleLabel('blocked') +
        ' at once — two human decisions in an order this cannot know, so a person has ' +
        'to settle which of them stands',
    };
  }
  if (held.has(lifecycleLabel('working'))) {
    return {
      ok: false,
      why: 'is ' + lifecycleLabel('working') + ': somebody may be holding it',
    };
  }
  return { ok: true, why: '' };
}

/* -------------------------------------------------------------------------- */
/* Times, and the claim TTL                                                    */
/* -------------------------------------------------------------------------- */

/** How long a claim lives without a heartbeat before it may be taken over. */
export const DEFAULT_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/** The shortest TTL that is a TTL rather than a way to fight over an issue. */
export const MIN_CLAIM_TTL_MS = 60 * 1000;

/** The longest TTL, past which a crashed runner has stranded the issue anyway. */
export const MAX_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DURATION = /^(\d{1,9})(?:\.(\d{1,3}))?(ms|s|m|h|d)?$/;

const UNIT_MS: Readonly<Record<string, number>> = Object.freeze({
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
});

/**
 * `24h`, `90m`, `1.5d` in milliseconds, or `undefined` when it is not one.
 *
 * A bare number is hours, because the flag this reads is a claim TTL and every
 * default in the spec is written in hours. Nothing else is guessed: a unit that
 * is not one of the five is not a duration.
 */
export function parseDurationMs(text: string): number | undefined {
  const match = text.trim().toLowerCase().match(DURATION);
  if (match === null) return undefined;
  const [, whole = '0', fraction, unit = 'h'] = match;
  const scale = UNIT_MS[unit];
  if (scale === undefined) return undefined;
  const value = Number(whole + (fraction === undefined ? '' : '.' + fraction));
  if (!Number.isFinite(value)) return undefined;
  return Math.round(value * scale);
}

/**
 * Why `text` is not a claim TTL, or `undefined` when it is one.
 *
 * A describer rather than a thrower, so the `--claim-ttl` flag can declare it
 * as the type that validates it and report a rejection as a usage error with a
 * usage line under it, exactly as every other value-taking flag does.
 */
export function claimTtlFault(text: string): string | undefined {
  const ms = parseDurationMs(text);
  if (ms === undefined) {
    return 'a claim TTL is written as 24h, 90m, 45s or 2d — a number and a unit';
  }
  if (ms < MIN_CLAIM_TTL_MS) return 'a claim TTL under a minute would take issues from live runs';
  if (ms > MAX_CLAIM_TTL_MS) return 'a claim TTL over 30 days never reclaims anything in practice';
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* The identity every write is a precondition of (addendum v0.1.2)             */
/* -------------------------------------------------------------------------- */

/** How the flag that names the account this runner posts as is written. */
export const RUNNER_LOGIN_FLAG = '--runner-login';

/** The environment variable that names it when no flag does. */
export const RUNNER_LOGIN_ENV = 'EXOLVRA_GENESIS_RUNNER_LOGIN';

/**
 * A GitHub login, in the one spelling a comment's author carries.
 *
 * Up to 39 of the characters GitHub allows in an account name, and an optional
 * `[bot]` suffix, which is what an installation token's comments are authored
 * as and therefore what an operator has to be able to type.
 */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/;

/**
 * Why `text` is not a login, or `undefined` when it is one.
 *
 * A describer rather than a thrower, for the same reason {@link claimTtlFault}
 * is one: the flag declares it as the type that validates it, and a rejected
 * value is reported as a usage error with a usage line under it.
 *
 * It is not merely tidiness. This value is compared against the author of every
 * comment on the issue, so a value that can never match one — a display name, a
 * profile URL, an empty string left by `--runner-login ""` — is a run that
 * reads none of its own status comments and posts a new one every round.
 */
export function runnerLoginFault(text: string): string | undefined {
  if (text.trim() === '') return 'a login is an account name, and this one is empty';
  if (!LOGIN.test(text)) {
    return (
      'a login is a GitHub account name — letters, digits and single hyphens, ' +
      'as in exolvra-genesis or my-app[bot]'
    );
  }
  return undefined;
}

/** The value types this module declares, for the flags that carry them (G5). */
export const VALUE_TYPES: Readonly<Record<string, (value: string) => string | undefined>> =
  Object.freeze({
    '<duration>': claimTtlFault,
    '<login>': runnerLoginFault,
  });

/** What settling the runner's own identity needs. */
export interface RunnerIdentityRequest {
  /** Asked who the token is, once per run; it remembers its own answer. */
  readonly client: GitHubClient;
  /** What {@link RUNNER_LOGIN_FLAG} was given, when it was given. */
  readonly login?: string | undefined;
  /** What {@link RUNNER_LOGIN_ENV} holds, when the flag did not override it. */
  readonly fromEnv?: string | undefined;
  /** The usage line echoed under a refusal. */
  readonly usage?: string | undefined;
  /** The flag as the user wrote it, so a refusal names their own spelling. */
  readonly flag?: string | undefined;
}

/** The account this run posts as, and how that was settled. */
export interface RunnerIdentity {
  /** Exactly what `user.login` carries on a comment this run writes. */
  readonly login: string;
  /** Where it came from, for the line a run record and a log both want. */
  readonly from: 'token' | 'flag' | 'environment';
  /** `app` when it is a bot login — an installation or Actions token. */
  readonly kind: 'user' | 'app';
}

/** Whether a login is one GitHub writes for an app rather than a person. */
function kindOf(login: string): 'user' | 'app' {
  return login.endsWith('[bot]') ? 'app' : 'user';
}

/**
 * GitHub could not be asked who this token is, and nothing said no.
 *
 * A rate limit, a 5xx, a timeout, a connection that was never made: the pass
 * has no identity and therefore may not write, which it has in common with the
 * refusal above — and it has nothing else in common with it. Nothing about the
 * invocation is wrong, so nothing about the invocation is the remedy: printing
 * `--runner-login` at somebody whose network blipped tells them to configure
 * their way out of an outage, and exiting 2 tells the scheduler the workflow
 * file is broken when the next pass would have worked.
 *
 * **Neither {@link UsageError} nor {@link ConfigError}, deliberately.** Those
 * two are the exit-2 family — "the invocation has to change" — and this is the
 * other kind of failure: the run did not get to happen. Left uncaught it
 * settles as exit 1, the code for a run that did not reach a verdict, which is
 * what a cron-driven pass should report so the next one picks the issue up.
 * The caller that means to report it as a pass outcome rather than as a fault
 * catches this class by name; {@link IdentityUnavailable.reason} is GitHub's
 * own words, already flattened and redacted, ready to print.
 */
export class IdentityUnavailable extends Error {
  /** What happened, in one line, as `src/github.ts` phrased it. */
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'IdentityUnavailable';
    this.reason = reason;
  }
}

/**
 * The account this run writes as, or a raised refusal (addendum v0.1.2).
 *
 * Every write this runner makes to a repository is decided against a status
 * comment it has to recognise as its own, so a run that cannot name itself is
 * stopped here — at startup, before an issue is read or a label is touched —
 * rather than discovered later as a hazard nobody can see.
 *
 * GitHub is asked first and its answer wins, because a token's own account is a
 * fact rather than a preference. An operator's login covers the case GitHub
 * refuses to answer at all — an installation or Actions token — and that is a
 * configuration act by somebody with repository access, which is the whole
 * reason it is allowed to settle anything. It answers whichever kind of "no"
 * GitHub gave, since what it settles is not a question about GitHub.
 *
 * **Two failures, and they are not the same failure** — which is what the
 * `cause` on an unknown identity says, in `src/github.ts`.
 * GitHub answering *no* — the 403 an installation token gets, a rejected token,
 * an answer naming nobody — is a {@link UsageError}: it will keep answering no,
 * so the invocation has to change, and both ways of changing it are named. Not
 * *reaching* GitHub — a rate limit, a 5xx, a timeout, a connection never made —
 * is an {@link IdentityUnavailable}, and none of that advice belongs anywhere
 * near it. Telling somebody to set `--runner-login` because GitHub had a bad
 * minute is answering a question they did not ask, and exiting 2 reports their
 * workflow file as broken when the next pass would have worked.
 *
 * The two answers disagreeing is refused rather than reconciled. One of them is
 * wrong, nothing here can tell which, and picking either silently produces the
 * failure this precondition exists to prevent: a run that recognises none of
 * its own comments, posts a fresh one every round, and recovers no claim it
 * ever made.
 *
 * Read-only surfaces do not call this. They write nothing, so no decision of
 * theirs turns on a comment's author.
 */
export async function requireRunnerLogin(
  request: RunnerIdentityRequest,
): Promise<RunnerIdentity> {
  const flag = request.flag ?? RUNNER_LOGIN_FLAG;
  const fromFlag = (request.login ?? '').trim();
  const fromEnv = (request.fromEnv ?? '').trim();
  const supplied = fromFlag !== '' ? fromFlag : fromEnv;
  const said = fromFlag !== '' ? flag : RUNNER_LOGIN_ENV;

  if (supplied !== '') {
    const why = runnerLoginFault(supplied);
    if (why !== undefined) {
      throw new UsageError(
        [
          'invalid value "' + inlineValue(supplied) + '" for ' + said + ': ' + why,
          '  it is compared against the author of every comment on the issue',
        ].join('\n'),
        usageFor(said, request.usage),
      );
    }
  }

  const who = await request.client.whoAmI();
  if (who.known) {
    if (supplied !== '' && supplied !== who.login) {
      throw new UsageError(
        [
          'refusing to run as an account this token is not',
          '  ' + said + ' names ' + inlineValue(supplied),
          '  GitHub says the token is @' + inlineValue(who.login),
          '  a comment this run writes is authored by the second, so the first would',
          '  never match one — correct the name, or use the token it belongs to',
        ].join('\n'),
        usageFor(said, request.usage),
      );
    }
    return { login: who.login, from: 'token', kind: who.kind };
  }

  // An operator's login answers whichever kind of "no" GitHub gave, because it
  // is not an answer *about* GitHub: somebody with repository access said what
  // account this runs as, and an outage does not make that less true.
  if (supplied !== '') {
    return {
      login: supplied,
      from: fromFlag !== '' ? 'flag' : 'environment',
      kind: kindOf(supplied),
    };
  }

  // Nobody said no — the call did not get through. Retrying is the remedy, so
  // the remedy is not printed: the next scheduled pass is the retry, and this
  // one reports that it did not run rather than that it was misconfigured.
  if (who.cause === 'transient') {
    throw new IdentityUnavailable(
      who.reason,
      [
        'could not settle the account this run posts as',
        '  ' + inlineValue(who.reason),
        '  nothing was read and nothing was written; the invocation is not the',
        '  problem, so the next pass asks again',
      ].join('\n'),
    );
  }

  // GitHub was asked and said no, and will keep saying it. The invocation is
  // the only thing that can change, so both ways of changing it are named.
  //
  // The reason line stands on its own, without a "GitHub would not name the
  // token" heading over it. That heading asserted a refusal, which made it a
  // false sentence over every fault that was not one — and it was over all of
  // them, because this branch used to be the only one there was.
  throw new UsageError(
    [
      'this run has no identity it can prove, so it may not write to a repository',
      '  ' + inlineValue(who.reason),
      '  every label, comment, branch and pull request is decided against a status',
      '  comment this runner has to recognise as its own',
      '  name the account with ' + flag + ' <login>, or set ' + RUNNER_LOGIN_ENV,
      '  an installation or Actions token is refused GET /user by GitHub, and the',
      '  login its comments carry is <app-slug>[bot]',
    ].join('\n'),
    usageFor(flag, request.usage),
  );
}

/**
 * The one timestamp shape this module writes: UTC, to the second.
 *
 * Used to read its own markers back. A heartbeat is evidence a takeover turns
 * on, so a marker whose heartbeat is not in the shape this module writes is not
 * read as one at all — it falls through to the next piece of evidence in
 * {@link claimAge} instead of being half-parsed into a time.
 */
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** A timestamp written the way this module writes them, or `''`. */
function stampField(value: string | undefined): string {
  return value !== undefined && ISO_STAMP.test(value) ? value : '';
}

/** A GitHub timestamp as a `Date`, or `undefined` when it is not one. */
export function parseStamp(text: string): Date | undefined {
  const value = Date.parse(text.trim());
  return Number.isFinite(value) ? new Date(value) : undefined;
}

/** A duration in milliseconds, said the way a heartbeat and a TTL are said. */
export function durationText(ms: number): string {
  return until(new Date(Math.max(0, ms)), new Date(0));
}

/* -------------------------------------------------------------------------- */
/* Neutralising what the issue says (C5)                                       */
/* -------------------------------------------------------------------------- */

/** What stands in place of text that tried to spell one of the markers below. */
export const MARKER_PLACEHOLDER = '[marker removed]';

/** How wide one table cell may be before it is cut. */
const CELL_WIDTH = 96;

/** How much of a body an excerpt shows before it says how much it did not. */
const EXCERPT_LINES = 40;
const EXCERPT_CHARS = 3000;

/**
 * The largest comment this module will send.
 *
 * GitHub accepts 65536 characters; the margin is what keeps a render that grew
 * one row too far from being refused by the API in the middle of a run.
 */
export const COMMENT_LIMIT = 60_000;

/** Every hidden marker this module writes, so untrusted text cannot spell one. */
const MARKER_TOKENS = [
  '<!-- ' + PROGRAM + ':sticky',
  '<!-- ' + PROGRAM + ':triage',
  '<!-- ' + PROGRAM + ':snapshot',
];

/**
 * The characters that reorder a line without appearing in it.
 *
 * `U+202E` and its relatives make `delete every branch` render as its own
 * mirror image, so what a person reads and what the bytes say are different
 * sentences. A status comment is read by a human deciding whether to merge
 * something, which is exactly the decision this is used to corrupt. They are
 * removed rather than escaped: there is no reading of an issue in which the
 * runner needs to reverse a line of somebody else's text.
 */
const BIDI_CONTROLS = /\p{Bidi_Control}/gu;

/**
 * Everything untrusted passes through here before it is written anywhere.
 *
 * Three removals, in one place so none of them can be forgotten at one call
 * site and remembered at the others:
 *
 * - **Secrets** (C12). `redactSecrets` is `src/github.ts`'s, and its contract is
 *   wider than that module: a token pasted into an issue by somebody who should
 *   not have is a token this runner would otherwise republish, in its own voice,
 *   into a comment on the same public issue. The runner authors those comments,
 *   so the shape the network module removes on sight is the shape this must
 *   never write.
 * - **Markers**, so no issue text can forge the hidden line a later round reads.
 * - **Bidi controls**, so what a person reads is what the bytes say.
 */
function untrusted(text: string): string {
  let out = redactSecrets(text).replace(BIDI_CONTROLS, '');
  for (const token of MARKER_TOKENS) out = out.split(token).join(MARKER_PLACEHOLDER);
  return out;
}

/** What would otherwise be markdown structure rather than the words somebody wrote. */
const MARKDOWN_SPECIALS = /[\\`*_~[\]<>&|]/g;

const ESCAPED: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
});

/**
 * One line of untrusted text, safe to put in a sentence or a table cell.
 *
 * Flattened first — a newline in a cell is two rows, and a tab is a column
 * nobody asked for — then escaped, so a backtick cannot open a code span that
 * swallows the rest of the table and a pipe cannot invent a column. `<` becomes
 * an entity, which is what makes forging an HTML comment impossible here rather
 * than merely unlikely.
 */
export function safeInline(text: string, width = CELL_WIDTH): string {
  return escapeInline(truncate(plainText(untrusted(text)), width));
}

function escapeInline(text: string): string {
  return text.replace(MARKDOWN_SPECIALS, (ch) => ESCAPED[ch] ?? '\\' + ch);
}

/**
 * The same, cut from the front instead of the back.
 *
 * For a path, the end is the half that says which one it is: five rounds' worth
 * of `.exolvra-genesis/runs/r-…/round-N/critic.md` cut from the right is five
 * identical cells, and the one character that differed is the one that went.
 */
export function safeTail(text: string, width = CELL_WIDTH): string {
  const flat = plainText(untrusted(text));
  if (displayWidth(flat) <= width) return escapeInline(flat);
  const kept: string[] = [];
  let used = 1;
  for (const cluster of graphemes(flat).reverse()) {
    const columns = displayWidth(cluster);
    if (used + columns > width) break;
    kept.push(cluster);
    used += columns;
  }
  return escapeInline('…' + kept.reverse().join(''));
}

/**
 * The same, for a value shown as code: a path, a label, a command, a hash.
 *
 * Markdown inside a code span is inert, so only two things have to go: the
 * backtick that would end the span early, and the pipe that a table reads as a
 * column boundary before it reads anything as a span at all.
 */
function code(text: string): string {
  const flat = truncate(plainText(untrusted(text)), CELL_WIDTH);
  return '`' + flat.replace(/`/g, '').replace(/\|/g, '\\|') + '`';
}

/**
 * A value named in a fault: flattened, cut, and never able to repaint a
 * terminal — or to carry a secret.
 *
 * A raised message becomes an artifact the moment a run record, a comment or a
 * progress page quotes it, which is the same reason `src/github.ts` redacts its
 * own faults (C12).
 */
function inlineValue(text: string): string {
  return truncate(plainText(redactSecrets(text)), 120);
}

/**
 * An excerpt of untrusted text, fenced so nothing in it can escape the fence.
 *
 * The fence is one backtick longer than the longest run inside, which is the
 * only rule that makes a fence total: a body carrying ```` ```` ```` gets a
 * longer one. Length is capped and the cap is stated rather than hidden, so a
 * 4MB body becomes forty lines and a sentence saying how many were left.
 */
export function safeFenced(text: string, info = 'text'): string {
  const cleaned = untrusted(printableBlock(text))
    .replace(/\r\n?/g, '\n')
    .replace(/\s+$/, '');
  const lines = cleaned.split('\n');
  let shown = lines.slice(0, EXCERPT_LINES).join('\n');
  let omitted = lines.length - Math.min(lines.length, EXCERPT_LINES);
  if (shown.length > EXCERPT_CHARS) {
    // By code point, not by unit: a cut through the middle of an astral
    // character leaves half of one behind, and half a character is the kind of
    // byte that makes a reader wonder what else was mangled.
    shown = [...shown].slice(0, EXCERPT_CHARS).join('');
    omitted = lines.length - shown.split('\n').length;
  }
  const longest = (shown.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const body = [fence + info, shown, fence].join('\n');
  return omitted > 0
    ? body + '\n\n' + countOf(omitted, 'further line', 'further lines') + ' not shown here.'
    : body;
}

/**
 * The half of a phrase that has to agree with a count, without the count.
 *
 * `was`/`were`, `says`/`say`, `it`/`they`. Separate from {@link countOf}
 * because a sentence often puts the number in one place and the word it governs
 * several words later — "the 1 standing gate in `standards.md` **says**" — and
 * writing that word out flat is how "The 1 standing gate … say what every
 * change must keep" reached a comment a maintainer reads. Every counted
 * sentence in this file gets its agreement from here, so there is one place to
 * be wrong rather than one per sentence.
 */
function forCount(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** `1 round` / `4 rounds`, so no line ever reads "1 rounds". */
function countOf(count: number, one: string, many: string): string {
  return count + ' ' + forCount(count, one, many);
}

/* -------------------------------------------------------------------------- */
/* Markdown a bot writes                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A table, with its columns padded so the comment reads as well in its source
 * as it does rendered.
 *
 * Padded by display width rather than by length, because a title in Chinese and
 * a title in English of the same length are not the same width, and a column
 * that lines up for one and not the other is a column that lines up by luck.
 */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((cell, index) =>
    rows.reduce(
      (max, row) => Math.max(max, displayWidth(row[index] ?? '')),
      Math.max(3, displayWidth(cell)),
    ),
  );
  const pad = (cell: string, index: number): string =>
    cell + ' '.repeat(Math.max(0, (widths[index] ?? 0) - displayWidth(cell)));
  const line = (cells: readonly string[]): string =>
    '| ' + cells.map((cell, index) => pad(cell, index)).join(' | ') + ' |';
  return [
    line(header),
    '| ' + widths.map((width) => '-'.repeat(width)).join(' | ') + ' |',
    ...rows.map((row) => line(header.map((_, index) => row[index] ?? ''))),
  ];
}

/** A `<details>` block, with the blank lines GitHub needs to read what is inside. */
function details(summary: string, body: readonly string[]): string[] {
  return ['<details>', '<summary>' + summary + '</summary>', '', ...body, '', '</details>'];
}

/** A markdown link, or the label alone when there is nowhere to point it. */
function link(label: string, url: string | undefined): string {
  return url === undefined || url === '' ? label : '[' + label + '](' + safeUrl(url) + ')';
}

/**
 * A URL safe to put in a link, or the text with the link taken off it.
 *
 * URLs in a sticky comment come from GitHub's own answers, but "comes from
 * GitHub" is a claim about a field in a JSON body a host wrote. A scheme this
 * tool did not expect is shown as text rather than made clickable.
 */
function safeUrl(url: string): string {
  const flat = plainText(url);
  return /^https:\/\/[^\s<>()]+$/.test(flat) ? flat : safeInline(flat);
}

/** The lines of a bullet in the status block: a bold key, then the value. */
function fact(key: string, value: string): string {
  return '- **' + key + '** — ' + value;
}

/* -------------------------------------------------------------------------- */
/* The snapshot (R3, C11)                                                      */
/* -------------------------------------------------------------------------- */

/** What the snapshot is called, under the run's own directory. */
export const SNAPSHOT_FILE = 'issue.md';

/** The pin beside it, in sha256sum format, as every other pin here is written. */
export const SNAPSHOT_PIN_FILE = 'issue.sha256';

/** Where per-run files live, under {@link RUN_DIR}. */
export const RUNS_SUBDIR = 'runs';

function requireRunId(runId: string): string {
  if (isRunId(runId)) return runId;
  throw new ConfigError(
    [
      'refusing to write a run directory for that run id',
      '  ' + inlineValue(runId),
      '  a run id is letters, digits, dots, dashes and underscores, and names a directory',
    ].join('\n'),
  );
}

/** The directory a run keeps its own files in. */
export function runDirPath(cwd: string, runId: string): string {
  return join(cwd, RUN_DIR, RUNS_SUBDIR, requireRunId(runId));
}

/** How that directory is named in prose: repo-relative, forward slashes. */
export function runDirDisplay(runId: string): string {
  return RUN_DIR + '/' + RUNS_SUBDIR + '/' + requireRunId(runId);
}

export function issueSnapshotPath(cwd: string, runId: string): string {
  return join(runDirPath(cwd, runId), SNAPSHOT_FILE);
}

export function issueSnapshotPinPath(cwd: string, runId: string): string {
  return join(runDirPath(cwd, runId), SNAPSHOT_PIN_FILE);
}

/** The sha256 of a text, over the bytes {@link normalizeText} settles on. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The bytes a hash is taken over: no byte-order mark, one kind of line ending.
 *
 * The same rule the standards file is pinned under, for the same reason. A
 * checkout that normalises line endings must not be able to report the snapshot
 * as edited by the act of checking it out, and a body GitHub sent with CRLF in
 * it must hash the same on both operating systems.
 */
function normalizeText(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** What was pinned, and where — everything a later round re-verifies against. */
/**
 * What the spec is made of, hashed — and hashed over the issue's *own* bytes.
 *
 * These two properties look contradictory until the split is named, so it is
 * named here. The snapshot **file** is redacted: it is read by people, handed to
 * agents and quoted in comments, and C12 says a secret never reaches an
 * artifact. These **digests** are taken over what GitHub actually holds, secrets
 * and all, because a hash of redacted text is blind exactly where it must not
 * be: a body edited from one token-shaped string to another redacts to the same
 * bytes, and a spec that changed would report as unchanged.
 *
 * A digest is not a disclosure. What is written to disk, to a comment and to a
 * page is sixty-four hex characters; the bytes that produced them are held for
 * the length of one comparison and never stored.
 *
 * Only what the bar is derived from is in here. Labels are not, because labels
 * are not the spec — a maintainer adding `P1` mid-run is triage, not a rewrite.
 * Comments are here only when they contributed an acceptance criterion, because
 * those are the only comments the bar was built out of.
 */
export interface SpecDigest {
  /** sha256 over the issue title, exactly as GitHub holds it. */
  title: string;
  /** sha256 over the issue body, exactly as GitHub holds it. */
  body: string;
  /**
   * Every comment on the issue that is not this tool's own, by id.
   *
   * All of them, and not only the ones that carried criteria, because an edit
   * has to be recognisable as one edit. Holding contributors separately from a
   * count of the rest made a comment that *stopped* carrying criteria read as a
   * deletion and an addition at once — two sentences about one change, neither
   * of them what happened.
   */
  comments: SpecCommentDigest[];
}

/** One comment, as the spec pinned it. */
export interface SpecCommentDigest {
  id: number;
  /** sha256 over the comment exactly as GitHub holds it. */
  sha256: string;
  /** Whether it carried an acceptance criterion when it was pinned. */
  criteria: boolean;
}

export interface SnapshotPin {
  /** Absolute path of the snapshot on disk. */
  path: string;
  /** `.exolvra-genesis/runs/<id>/issue.md`, for prose and for comments. */
  relativePath: string;
  /** Absolute path of the sha256sum-format pin beside it. */
  pinPath: string;
  relativePinPath: string;
  /** The pin: sha256 over the snapshot's bytes, as they are on disk. */
  sha256: string;
  bytes: number;
  /**
   * The body as the file shows it — redacted — hashed and counted.
   *
   * These two are about the file: they let a reader check the split inside it
   * against what is printed in its own header. What the *issue* said is
   * {@link SnapshotPin.spec}, and the difference between them is the whole of
   * why C11 and C12 can both hold.
   */
  bodySha256: string;
  bodyBytes: number;
  /** What the bar was derived from, over the issue's own bytes. */
  spec: SpecDigest;
  capturedAt: string;
  repo: string;
  issue: number;
  comments: number;
}

/** A short form of a hash, for a line that is about something else. */
export function shortSha(hex: string): string {
  return hex.length <= 16 ? hex : hex.slice(0, 12) + '…' + hex.slice(-4);
}

/**
 * The comments a snapshot is made of: everybody's but this runner's own.
 *
 * The sticky comment and the triage comment are this tool talking to itself.
 * Leaving them in would make the snapshot change every time the runner beat its
 * own heartbeat, which would turn the C11 comparison against the live issue
 * (the one in {@link readIssueDrift}) into an alarm that fires every round and
 * is therefore ignored. They are also not part of the spec: nobody wrote them
 * as a requirement.
 */
export function specComments(comments: readonly IssueComment[]): IssueComment[] {
  return comments.filter(
    (comment) => !MARKER_TOKENS.some((token) => comment.body.startsWith(token)),
  );
}

/**
 * The snapshot file's text: the issue as it was read, minus any secret in it.
 *
 * The header is this module's; everything under a heading is GitHub's, verbatim
 * and unescaped. A body that spells `## Comments` therefore looks like a
 * section break to a reader — which is why the header states the body's length
 * and its own sha256, so where the body ends is a checkable fact rather than a
 * matter of trusting the layout.
 *
 * The one thing that does not survive verbatim is a secret. C12 says secrets
 * never reach an artifact, and a file on disk that a critic reads, an agent is
 * handed and a comment quotes the hash of is an artifact. What was removed is
 * visible in the file — {@link REDACTED} is not a silent edit — and the pin is
 * taken over the redacted bytes, so what is verified each round is what is
 * actually there.
 */
export function renderIssueSnapshot(
  repo: Repo,
  thread: IssueThread,
  capturedAt: Date,
): string {
  const issue = thread.issue;
  const body = redactSecrets(normalizeText(issue.body));
  const comments = specComments(thread.comments);
  const slug = repoSlug(repo);
  const lines: string[] = [
    '<!-- ' +
      PROGRAM +
      ':snapshot v=1 repo=' +
      markerValue(slug) +
      ' issue=' +
      issue.number +
      ' captured=' +
      markerValue(isoSeconds(capturedAt)) +
      ' -->',
    '# ' + safeInline(slug + '#' + issue.number + ' — ' + issue.title, 160),
    '',
    'The issue as this run read it, and the spec the run works from. Line endings',
    'are LF here and anything shaped like a token reads ' +
      REDACTED +
      '; `' +
      SNAPSHOT_PIN_FILE +
      '` pins these bytes. The issue itself is never edited, and this run’s own',
    'status comments and lifecycle labels are left out — they are this run talking',
    'to itself, not part of what anybody asked for.',
    '',
    ...table(
      ['Field', 'Value'],
      [
        ['Repository', safeInline(slug)],
        ['Issue', '#' + issue.number],
        ['URL', safeUrl(issue.url)],
        ['Author', '@' + safeInline(issue.author, 64)],
        ['State', safeInline(issue.state, 32)],
        ['Opened', safeInline(issue.createdAt, 32)],
        ['Updated', safeInline(issue.updatedAt, 32)],
        [
          // The repository's own labels. The `exolvra:` ones are this run's
          // bookkeeping, and the run moves them itself — recording them here
          // would make the snapshot disagree with the issue the moment the
          // claim was made, and every drift check after that meaningless.
          'Labels',
          foreignLabels(issue.labels).length === 0
            ? 'none'
            : foreignLabels(issue.labels)
                .map((label) => safeInline(label, 48))
                .join(', '),
        ],
        ['Comments', String(comments.length)],
        [
          'Body',
          countOf(body.length, 'character', 'characters') + ', sha256 ' + sha256(body),
        ],
        ['Captured', isoSeconds(capturedAt) + ' (UTC)'],
      ],
    ),
    '',
    '## Title',
    '',
    redactSecrets(issue.title),
    '',
    '## Body',
    '',
    body === '' ? '_The issue has no body._' : body,
    '',
    '## Comments',
    '',
  ];

  if (comments.length === 0) {
    lines.push('_No comments._');
  } else {
    for (const [index, comment] of comments.entries()) {
      const said = redactSecrets(normalizeText(comment.body));
      lines.push(
        '### ' + (index + 1) + ' — @' + safeInline(comment.author, 64) + ', ' +
          safeInline(comment.createdAt, 32),
        '',
        said === '' ? '_Empty comment._' : said,
        '',
      );
    }
  }

  return normalizeText(lines.join('\n')).replace(/\n+$/, '') + '\n';
}

function writeFileIn(path: string, text: string, what: string): void {
  try {
    writeFileSync(path, text, 'utf8');
  } catch (error) {
    throw new ConfigError(
      [
        'could not write ' + what,
        '  ' + path,
        '  ' + (error instanceof Error ? inlineValue(error.message) : String(error)),
      ].join('\n'),
    );
  }
}

/**
 * Writes the snapshot and its pin, and answers with everything that was pinned.
 *
 * Two files rather than one: the markdown a person reads, and the sha256sum
 * line an integrity hook verifies without knowing anything about this tool.
 */
export function writeIssueSnapshot(
  cwd: string,
  runId: string,
  repo: Repo,
  thread: IssueThread,
  capturedAt: Date,
): SnapshotPin {
  const dir = runDirPath(cwd, runId);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new ConfigError(
      [
        'could not make the run directory for the issue snapshot',
        '  ' + dir,
        '  ' + (error instanceof Error ? inlineValue(error.message) : String(error)),
      ].join('\n'),
    );
  }

  const text = renderIssueSnapshot(repo, thread, capturedAt);
  const digest = sha256(text);
  const path = issueSnapshotPath(cwd, runId);
  const pinPath = issueSnapshotPinPath(cwd, runId);
  writeFileIn(path, text, 'the issue snapshot');
  writeFileIn(pinPath, digest + '  ' + SNAPSHOT_FILE + '\n', 'the issue snapshot pin');

  const body = redactSecrets(normalizeText(thread.issue.body));
  return {
    path,
    relativePath: runDirDisplay(runId) + '/' + SNAPSHOT_FILE,
    pinPath,
    relativePinPath: runDirDisplay(runId) + '/' + SNAPSHOT_PIN_FILE,
    sha256: digest,
    bytes: Buffer.byteLength(text),
    bodySha256: sha256(body),
    bodyBytes: Buffer.byteLength(body),
    spec: specDigest(thread),
    capturedAt: isoSeconds(capturedAt),
    repo: repoSlug(repo),
    issue: thread.issue.number,
    comments: specComments(thread.comments).length,
  };
}

/** What re-verifying a pin found. */
export interface SnapshotVerification {
  verified: boolean;
  path: string;
  relativePath: string;
  /** The hash the pin file holds, or `undefined` when there is no readable pin. */
  expected: string | undefined;
  /** The hash of what is on disk now, or `undefined` when nothing is there. */
  actual: string | undefined;
  /** Why it did not verify, in one line. Empty when it did. */
  reason: string;
}

function readTextOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Re-reads the snapshot and its pin and says whether they still agree (C11).
 *
 * A reading rather than a raised fault, because the round that calls it decides
 * what a disagreement means; {@link assertIssueSnapshot} is the same check for
 * the callers that only need it to stop.
 */
export function verifyIssueSnapshot(cwd: string, runId: string): SnapshotVerification {
  const path = issueSnapshotPath(cwd, runId);
  const relativePath = runDirDisplay(runId) + '/' + SNAPSHOT_FILE;
  const snapshot = readTextOrUndefined(path);
  const pinLine = readTextOrUndefined(issueSnapshotPinPath(cwd, runId));
  const expected = pinLine?.trim().split(/\s+/)[0];
  const actual = snapshot === undefined ? undefined : sha256(normalizeText(snapshot));

  if (snapshot === undefined) {
    return { verified: false, path, relativePath, expected, actual, reason: 'the snapshot is not there' };
  }
  if (expected === undefined || !/^[0-9a-f]{64}$/.test(expected)) {
    return {
      verified: false,
      path,
      relativePath,
      expected,
      actual,
      reason: 'the pin beside it is missing or is not a sha256',
    };
  }
  if (expected !== actual) {
    return {
      verified: false,
      path,
      relativePath,
      expected,
      actual,
      reason: 'the snapshot no longer hashes to what was pinned',
    };
  }
  return { verified: true, path, relativePath, expected, actual, reason: '' };
}

/** The same check, raised as a fault in the house shape. */
export function assertIssueSnapshot(cwd: string, runId: string): SnapshotVerification {
  const reading = verifyIssueSnapshot(cwd, runId);
  if (reading.verified) return reading;
  throw new ConfigError(
    [
      'the issue snapshot no longer verifies',
      '  ' + reading.relativePath,
      '  ' + reading.reason,
      '  pinned: ' + (reading.expected ?? 'nothing'),
      '  on disk: ' + (reading.actual ?? 'nothing'),
      '  the snapshot is the spec this run is judged against; it is read-only for the run',
    ].join('\n'),
  );
}

/** What the issue looks like now, against what was pinned when it was claimed. */
export interface IssueDrift {
  /** True when nothing at all is different — neither the spec nor the noise. */
  same: boolean;
  /**
   * True when what the bar is derived from moved, which stops the run.
   *
   * Separate from {@link IssueDrift.same} on purpose: an issue can be different
   * without the spec being different, and treating those two as one thing is
   * what turns a passer-by's "+1" into a stop button.
   */
  blocking: boolean;
  /** What moved in the spec, named, for a person deciding what to do. */
  changed: string[];
  /** What changed around it without moving the spec. Worth saying, not stopping. */
  noted: string[];
  /** One line, ready for the sticky comment and a run record. */
  summary: string;
}

/** Whether a comment contributed anything the bar is judged on. */
function contributesCriteria(body: string): boolean {
  const scan: Scan = { criteria: [], commands: [], headings: [] };
  scanText(body, 'a comment', scan, false);
  return scan.criteria.length > 0;
}

/**
 * What the bar was derived from, hashed over the issue's own bytes.
 *
 * See {@link SpecDigest} for why these are not redacted and the file is.
 */
export function specDigest(thread: IssueThread): SpecDigest {
  return {
    title: sha256(normalizeText(thread.issue.title)),
    body: sha256(normalizeText(thread.issue.body)),
    comments: specComments(thread.comments).map((comment) => {
      const body = normalizeText(comment.body);
      return { id: comment.id, sha256: sha256(body), criteria: contributesCriteria(body) };
    }),
  };
}

/**
 * Reads the issue again and asks whether the *spec* is still the pinned spec.
 *
 * The local pin catches somebody editing the snapshot on disk; this catches the
 * thing the local pin cannot see at all — the issue being edited on GitHub after
 * the run started. That is the direction that matters: an issue whose body grew
 * a line after it was claimed is a different spec, and a run that kept going
 * would be judged against a bar nobody agreed to.
 *
 * What counts as the spec is the whole of the judgement here, and it is
 * narrower than "the issue":
 *
 * - **The body and the title always count.** They are what a maintainer wrote
 *   and what the ready label vouched for, and an edit to either is the drift
 *   C11 exists for.
 * - **Labels never count.** A maintainer adding `P1` in the middle of triage is
 *   doing triage, not rewriting a spec, and stopping a run for it would make
 *   ordinary repository housekeeping a kill switch.
 * - **A comment counts only if it contributed an acceptance criterion.** Those
 *   comments are part of the bar, so editing one moves the bar. Anything else —
 *   a "+1", a question, a link — changes the thread without changing what the
 *   run is judged on, and on a public repository anyone can leave one. It is
 *   reported and the run goes on.
 *
 * The runner's own status comments are excluded on both sides
 * ({@link specComments}), which is what stops its own heartbeat from reading as
 * drift.
 */
export function readIssueDrift(thread: IssueThread, pin: SnapshotPin): IssueDrift {
  const now = specDigest(thread);
  const was = pin.spec;

  const changed: string[] = [];
  const evidence: string[] = [];
  /** The proof of one change is the hash of *that* thing, before and after. */
  const proof = (what: string, from: string, to: string): void => {
    evidence.push(what + ' was pinned at ' + shortSha(from) + ' and now reads ' + shortSha(to));
  };

  if (now.title !== was.title) {
    changed.push('the title');
    proof('the title', was.title, now.title);
  }
  if (now.body !== was.body) {
    changed.push('the body');
    proof('the body', was.body, now.body);
  }

  // Every comment is classified once, by id. An edit is an edit whether or not
  // it changed whether the comment carried criteria — describing one as a
  // deletion *and* an addition was two sentences about one change.
  const before = new Map(was.comments.map((entry) => [entry.id, entry]));
  const after = new Map(now.comments.map((entry) => [entry.id, entry]));
  const editedBar: number[] = [];
  const goneBar: number[] = [];
  const addedBar: number[] = [];
  let editedNoise = 0;
  let goneNoise = 0;
  let addedNoise = 0;

  for (const [id, was_] of before) {
    const now_ = after.get(id);
    if (now_ === undefined) {
      if (was_.criteria) goneBar.push(id);
      else goneNoise += 1;
      continue;
    }
    if (now_.sha256 === was_.sha256) continue;
    // An edit to a comment that carried criteria, or that carries them now,
    // moves the bar either way: one took something out of it, the other put
    // something in.
    if (was_.criteria || now_.criteria) {
      editedBar.push(id);
      proof('comment ' + id, was_.sha256, now_.sha256);
    } else editedNoise += 1;
  }
  for (const [id, now_] of after) {
    if (before.has(id)) continue;
    if (now_.criteria) addedBar.push(id);
    else addedNoise += 1;
  }

  if (editedBar.length > 0) {
    changed.push(
      countOf(editedBar.length, 'comment', 'comments') +
        ' the bar was derived from ' +
        forCount(editedBar.length, 'was', 'were') +
        ' edited',
    );
  }
  if (goneBar.length > 0) {
    changed.push(
      countOf(goneBar.length, 'comment', 'comments') +
        ' the bar was derived from ' +
        forCount(goneBar.length, 'was', 'were') +
        ' deleted',
    );
  }
  if (addedBar.length > 0) {
    changed.push(countOf(addedBar.length, 'comment', 'comments') + ' added acceptance criteria');
  }

  const noted: string[] = [];
  if (addedNoise > 0) {
    noted.push(
      countOf(addedNoise, 'comment', 'comments') +
        ' ' +
        forCount(addedNoise, 'was', 'were') +
        ' added that ' +
        forCount(addedNoise, 'changes', 'change') +
        ' no acceptance criteria',
    );
  }
  if (editedNoise > 0) {
    noted.push(
      countOf(editedNoise, 'comment', 'comments') +
        ' ' +
        forCount(editedNoise, 'was', 'were') +
        ' edited without changing any acceptance criteria',
    );
  }
  if (goneNoise > 0) {
    noted.push(
      countOf(goneNoise, 'comment', 'comments') +
        ' carrying no acceptance criteria ' +
        forCount(goneNoise, 'was', 'were') +
        ' deleted',
    );
  }

  const blocking = changed.length > 0;
  return {
    same: !blocking && noted.length === 0,
    blocking,
    changed,
    noted,
    summary: blocking
      ? 'the issue changed after it was claimed: ' +
        changed.join(', ') +
        (evidence.length === 0 ? '' : ' (' + evidence.join('; ') + ')')
      : noted.join(', '),
  };
}

/* -------------------------------------------------------------------------- */
/* Deriving a checkable bar (R4)                                               */
/* -------------------------------------------------------------------------- */

/** Where one derived criterion came from. */
export interface CriterionSource {
  /** A `- [ ]` item, or a bullet under a heading that says what "done" is. */
  kind: 'checkbox' | 'section';
  /** `the issue body`, or `a comment by @someone`. */
  where: string;
}

/** One thing a run could check when it is finished. */
export interface DerivedCriterion {
  text: string;
  source: CriterionSource;
}

/** One command that says whether the work holds up. */
export interface DerivedCommand {
  command: string;
  where: string;
}

/** One element a runnable spec needs and this issue does not have. */
export interface MissingElement {
  id: 'goal' | 'acceptance-criteria' | 'verification';
  name: string;
  /** Exactly what was looked for, and exactly what was found instead. */
  why: string;
  /** What adding would satisfy it. */
  remedy: string;
}

/** What could be derived from an issue and the repo's standing standards. */
export interface DerivedSpec {
  /** The issue title, flattened. GitHub never lets it be empty. */
  goal: string;
  bodyCharacters: number;
  commentCount: number;
  criteria: DerivedCriterion[];
  commands: DerivedCommand[];
  /** Every heading the body carries, in order, for the evidence block. */
  headings: string[];
  standards: { present: boolean; gates: number; standingBar: number };
  missing: MissingElement[];
  /** True when a run has both something to check and a way to check it. */
  runnable: boolean;
}

const HEADING = /^\s{0,3}#{1,6}\s+(\S.*?)\s*$/;
const CHECKBOX = /^\s{0,8}[-*+]\s+\[[ xX]\]\s+(\S.*)$/;
const BULLET = /^\s{0,8}(?:[-*+]|\d{1,3}[.)])\s+(\S.*)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`~]*)/;
const CRITERIA_HEADING =
  /\b(acceptance criteria|acceptance|definition of done|done when|success criteria)\b/i;
const VERIFICATION_LINE =
  /^\s{0,8}(?:[-*+]\s+)?(?:\*{0,2})(?:run|verify|verified by|verification|to verify|check(?:ed)? with)(?:\*{0,2})\s*:\s*`([^`\n]{2,200})`/i;
const SHELL_INFO = /^(sh|bash|zsh|shell|console|shell-session|terminal|cmd|powershell|ps1?|bat)$/i;
const COMMENT_LINE = /^\s*(#|\/\/|rem\b)/i;

/** How many criteria and commands one issue may contribute before it is enough. */
const MAX_DERIVED = 40;

interface Scan {
  criteria: DerivedCriterion[];
  commands: DerivedCommand[];
  headings: string[];
}

/**
 * Walks one markdown text for the things a run can check.
 *
 * Mechanical from end to end, and that is the point of R4: a checkbox is a
 * criterion because somebody wrote a checkbox, a fenced shell block holds a
 * command because it says it does. Nothing here reads intent out of prose, so
 * an issue with none of these shapes produces nothing and gets told so, rather
 * than being handed a bar this module made up.
 *
 * `commands` says whether this text is allowed to contribute a command at all.
 * See {@link deriveIssueSpec}: it is false for every comment, and that is a
 * safety boundary rather than a preference.
 */
function scanText(text: string, where: string, into: Scan, commands: boolean): void {
  const lines = normalizeText(text).split('\n');
  let fence: string | undefined;
  let fenceInfo = '';
  let underCriteria = false;

  for (const raw of lines) {
    const fenced = raw.match(FENCE);
    if (fenced !== null) {
      const marker = fenced[1] ?? '';
      if (fence === undefined) {
        fence = marker[0] === '`' ? '`' : '~';
        fenceInfo = (fenced[2] ?? '').toLowerCase();
        continue;
      }
      if (marker[0] === fence) {
        fence = undefined;
        fenceInfo = '';
        continue;
      }
    }

    if (fence !== undefined) {
      if (!commands || !SHELL_INFO.test(fenceInfo)) continue;
      const command = raw.replace(/^\s*\$\s+/, '').trim();
      if (command === '' || COMMENT_LINE.test(command)) continue;
      if (into.commands.length < MAX_DERIVED) {
        into.commands.push({ command, where: where + ', in a ' + fenceInfo + ' block' });
      }
      continue;
    }

    const heading = raw.match(HEADING);
    if (heading !== null) {
      const title = heading[1] ?? '';
      into.headings.push(title);
      underCriteria = CRITERIA_HEADING.test(title);
      continue;
    }

    const named = raw.match(VERIFICATION_LINE);
    if (commands && named !== null && into.commands.length < MAX_DERIVED) {
      into.commands.push({ command: (named[1] ?? '').trim(), where });
    }

    const checkbox = raw.match(CHECKBOX);
    if (checkbox !== null) {
      if (into.criteria.length < MAX_DERIVED) {
        into.criteria.push({
          text: (checkbox[1] ?? '').trim(),
          source: { kind: 'checkbox', where },
        });
      }
      continue;
    }

    if (!underCriteria) continue;
    const bullet = raw.match(BULLET);
    if (bullet !== null && into.criteria.length < MAX_DERIVED) {
      into.criteria.push({
        text: (bullet[1] ?? '').trim(),
        source: { kind: 'section', where },
      });
    }
  }
}

/** Whether the thread had any comment worth saying "and not from those" about. */
function hasReadableComments(thread: IssueThread): boolean {
  return specComments(thread.comments).length > 0;
}

/** The command inside a standing gate, when the gate names one in backticks. */
function gateCommand(text: string): string | undefined {
  const match = text.match(/`([^`\n]{2,200})`/);
  const command = match?.[1]?.trim();
  return command === undefined || command === '' ? undefined : command;
}

/**
 * What can be derived from the issue thread and the repo's standing standards.
 *
 * **Commands come from two places and no others: the issue body, and the
 * repository's own `.exolvra-genesis/standards.md`.** That is a safety boundary
 * (C5), not a preference, and the piece that eventually executes what is
 * derived here inherits it. The ready label is the authorization, a maintainer
 * applies it having read the body, and the standards file is committed to the
 * repository by people with write access to it — so both are vouched for by
 * somebody who could have made the change themselves. A comment is not: anybody
 * with a GitHub account can leave one on a public issue, and a runner that
 * accepted `curl … | sh` out of a stranger's comment would be a service for
 * running strangers' commands on a maintainer's machine, wearing a maintainer's
 * token. Comments still inform the *criteria* — what "done" means is a thing a
 * discussion settles — because a criterion is judged by a critic and a command
 * is executed by a shell, and only one of those is a privilege.
 *
 * The standing gates are a *verification* source and never an acceptance
 * criterion. What every change in the repo must keep is not what this issue
 * asks for, and treating the two as the same would mean no issue was ever
 * underspecified — which would make R4 unreachable.
 *
 * This runner's own status comments are excluded from both, because a comment
 * this module wrote is not evidence about what anybody asked for.
 */
export function deriveIssueSpec(thread: IssueThread, standards: Standards | null): DerivedSpec {
  const scan: Scan = { criteria: [], commands: [], headings: [] };
  scanText(thread.issue.body, 'the issue body', scan, true);
  for (const comment of specComments(thread.comments)) {
    scanText(comment.body, 'a comment by @' + plainText(comment.author), scan, false);
  }

  for (const gate of standards?.gates ?? []) {
    const command = gateCommand(gate.text);
    if (command !== undefined && scan.commands.length < MAX_DERIVED) {
      scan.commands.push({ command, where: '.exolvra-genesis/standards.md ' + gate.id });
    }
  }

  const body = normalizeText(thread.issue.body).trim();
  const said = specComments(thread.comments).length;
  const missing: MissingElement[] = [];

  if (body === '' && scan.criteria.length === 0) {
    missing.push({
      id: 'goal',
      name: 'A description of the change',
      why:
        'the issue has a title and an empty body' +
        (said === 0
          ? ', and no comments to read'
          : ', and its ' +
            countOf(said, 'comment', 'comments') +
            ' added nothing checkable'),
      remedy:
        'say what should be different when this is done — one paragraph is enough, ' +
        'as long as it names the behaviour that changes',
    });
  }

  if (scan.criteria.length === 0) {
    missing.push({
      id: 'acceptance-criteria',
      name: 'Acceptance criteria',
      why:
        'the thread has no `- [ ]` items and no heading matching “acceptance criteria”, ' +
        '“definition of done”, “done when” or “success criteria” — ' +
        (scan.headings.length === 0
          ? 'the body carries no headings at all'
          : countOf(scan.headings.length, 'heading was', 'headings were') +
            ' read: ' +
            scan.headings.slice(0, 6).join(', ')),
      remedy:
        'add a checklist of outcomes a reader could check one at a time, either as ' +
        '`- [ ]` items or under an `## Acceptance criteria` heading' +
        (standards === null
          ? ''
          : '. The ' +
            countOf(standards.gates.length, 'standing gate', 'standing gates') +
            ' in `.exolvra-genesis/standards.md` ' +
            forCount(standards.gates.length, 'says', 'say') +
            ' what every change here must keep, and not what this issue asks for'),
    });
  }

  if (scan.commands.length === 0) {
    missing.push({
      id: 'verification',
      name: 'A way to verify it',
      why:
        'the issue body names no command: no `sh`/`bash`/`console` block and no ' +
        '`Verification:` line' +
        (standards === null
          ? ', and this repository has no `.exolvra-genesis/standards.md` to supply one' +
            (hasReadableComments(thread)
              ? '. Comments were read for criteria, and never for commands'
              : '')
          : ', and ' +
            (standards.gates.length === 0
              ? '`.exolvra-genesis/standards.md` holds no standing gate to take one from'
              : 'the ' +
                countOf(standards.gates.length, 'standing gate', 'standing gates') +
                ' in `.exolvra-genesis/standards.md` ' +
                forCount(standards.gates.length, 'carries', 'carry') +
                ' no command in backticks')),
      remedy:
        'a maintainer can put the command in the issue body, in backticks after ' +
        '`Verification:` or in a fenced `sh` block, or add a gate to this repository’s ' +
        '`.exolvra-genesis/standards.md`. Those two are the only places a command is ' +
        'read from: editing the issue and committing to the repository are both acts ' +
        'this repository already trusts, and a comment is not',
    });
  }

  return {
    goal: plainText(thread.issue.title),
    bodyCharacters: normalizeText(thread.issue.body).length,
    commentCount: said,
    criteria: scan.criteria,
    commands: scan.commands,
    headings: scan.headings,
    standards: {
      present: standards !== null,
      gates: standards?.gates.length ?? 0,
      standingBar: standards?.standingBar.length ?? 0,
    },
    missing,
    runnable: missing.length === 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Markers: the hidden line that makes a comment findable                      */
/* -------------------------------------------------------------------------- */

const MARKER_VALUE = /^[A-Za-z0-9:@._#/,+-]+$/;

/**
 * A value about to go into a hidden marker, or a raised refusal.
 *
 * Everything in a marker is written by this module — a run id, a repo slug, a
 * label out of the fixed five, a timestamp — so a value with a space or an
 * angle bracket in it means something upstream is not what this module thinks
 * it is. Refusing is what keeps `-->` from ever appearing inside the marker
 * that a later round parses.
 */
function markerValue(value: string): string {
  if (MARKER_VALUE.test(value)) return value;
  throw new ConfigError(
    [
      'refusing to write a status marker with that value in it',
      '  ' + inlineValue(value),
      '  a marker carries run ids, repository slugs, labels and UTC timestamps only',
    ].join('\n'),
  );
}

/** The machine-readable half of the sticky comment. */
export interface StickyMarker {
  version: string;
  run: string;
  repo: string;
  issue: number;
  phase: string;
  label: string;
  /** The C7 heartbeat, as this module wrote it: UTC, to the second. */
  heartbeat: string;
  claimed: string;
  /** The snapshot pin, or `none` before there is one. */
  snapshot: string;
}

function markerOf(kind: string, fields: Readonly<Record<string, string>>): string {
  const pairs = Object.entries(fields).map(([key, value]) => key + '=' + markerValue(value));
  return '<!-- ' + PROGRAM + ':' + kind + ' ' + pairs.join(' ') + ' -->';
}

function parseMarkerFields(
  body: string,
  kind: string,
): Record<string, string> | undefined {
  const head = body.split('\n', 1)[0] ?? '';
  const opening = '<!-- ' + PROGRAM + ':' + kind + ' ';
  if (!head.startsWith(opening) || !head.trimEnd().endsWith('-->')) return undefined;
  const inner = head.trimEnd().slice(opening.length, -3).trim();
  const fields: Record<string, string> = {};
  for (const piece of inner.split(/\s+/)) {
    const at = piece.indexOf('=');
    if (at <= 0) continue;
    fields[piece.slice(0, at)] = piece.slice(at + 1);
  }
  return fields;
}

/**
 * The sticky marker a comment carries, or `undefined` when it carries none.
 *
 * The marker has to be the first thing in the comment. A comment that merely
 * *contains* one is a comment quoting this tool — an issue body pasted back, a
 * person showing somebody else what the bot writes — and adopting it would mean
 * editing a stranger's words.
 */
export function parseStickyMarker(body: string): StickyMarker | undefined {
  const fields = parseMarkerFields(body, 'sticky');
  if (fields === undefined) return undefined;
  const issue = Number(fields['issue']);
  return {
    version: fields['v'] ?? '',
    run: fields['run'] ?? '',
    repo: fields['repo'] ?? '',
    issue: Number.isInteger(issue) ? issue : 0,
    phase: fields['phase'] ?? '',
    label: fields['label'] ?? '',
    heartbeat: stampField(fields['heartbeat']),
    claimed: stampField(fields['claimed']),
    snapshot: fields['snapshot'] ?? 'none',
  };
}

/** The one comment this run edits, and what it said when it was found. */
export interface StickyRef {
  id: number;
  url: string;
  author: string;
  updatedAt: string;
  body: string;
  marker: StickyMarker | undefined;
}

/** What identifies the issue a sticky comment is allowed to be about. */
export interface StickySubject {
  repo: Repo;
  issue: number;
  /**
   * The account this run writes as, settled by {@link requireRunnerLogin}.
   *
   * Required, because every use of a status comment here is a use that decides
   * a write, and a comment somebody else wrote is a comment somebody else
   * controls — including the heartbeat inside it. There is no reading of an
   * unrecognised comment that is safe to make, so there is no shape of this
   * value that leaves the comparison out.
   */
  login: string;
}

/**
 * The login to compare authors against, or a raised refusal.
 *
 * The invariant enforced where the comparison happens rather than only at
 * startup: a caller that reached here with nothing to compare against cannot be
 * given the weakest reading of the evidence instead, because there is no weaker
 * reading that is safe (addendum v0.1.2).
 *
 * `undefined` is taken as widely as the empty string, and the parameter admits
 * it on purpose. The types make every caller inside this module pass a string,
 * so the only caller this guard can ever answer is one the compiler never saw —
 * a JavaScript caller, a value out of JSON, an object built by hand — and for
 * one of those the likeliest spelling of "no login" is a field that was left
 * out. Refusing that with a `TypeError` from `.trim()` would be the same
 * decision reported as a crash rather than as the house's refusal. The test is
 * `typeof` rather than a comparison for the same reason it exists at all: to a
 * caller the compiler never checked, `null` and a number are spellings of the
 * same mistake, and none of them is a login.
 */
function requireRunnerIdentity(login: string | undefined): string {
  if (typeof login === 'string' && login.trim() !== '') return login;
  throw new ConfigError(
    [
      'refusing to read a status comment with no login to compare it against',
      '  every write this runner makes is decided against a comment it has to',
      '  recognise as its own, and an unrecognised one decides nothing',
      '  name the account with ' + RUNNER_LOGIN_FLAG + ' <login>, or set ' + RUNNER_LOGIN_ENV,
    ].join('\n'),
  );
}

function stickyRefOf(comment: IssueComment, marker: StickyMarker): StickyRef {
  return {
    id: comment.id,
    url: comment.url,
    author: comment.author,
    updatedAt: comment.updatedAt,
    body: comment.body,
    marker,
  };
}

/**
 * Every comment that is this run's status comment, in the order the issue
 * carries them.
 *
 * Every one of them, and not the first: which is the newest is a question the
 * callers ask, and answering it over one comment picked by position is how a
 * comment posted before the runner's own came to speak for it.
 *
 * Three gates, and the third is the one the rest of this file is built on. A
 * comment qualifies when:
 *
 * 1. it *opens* with the marker — a comment quoting one is a person showing
 *    somebody what the bot writes, not the bot;
 * 2. the marker names **this repository and this issue**. Markers are public:
 *    anybody can copy one off another issue, and a copied marker naming
 *    `other/repo#999` was being read as this issue's status because those
 *    fields were parsed and never compared;
 * 3. it was written by the account this run posts as. That login is settled
 *    before the pass starts ({@link requireRunnerLogin}) and it closes the
 *    whole class: a comment somebody else wrote is not read for a heartbeat, a
 *    run id, a phase, or anything else. There is no third case — no comment
 *    that is neither this account's nor a stranger's — so nothing downstream
 *    has to reason about what an unrecognised comment may be trusted for.
 */
export function stickyCandidates(
  comments: readonly IssueComment[],
  subject: StickySubject,
): StickyRef[] {
  const slug = repoSlug(subject.repo);
  const login = requireRunnerIdentity(subject.login);
  const out: StickyRef[] = [];
  for (const comment of comments) {
    if (comment.author !== login) continue;
    const marker = parseStickyMarker(comment.body);
    if (marker === undefined) continue;
    if (marker.repo !== slug || marker.issue !== subject.issue) continue;
    out.push(stickyRefOf(comment, marker));
  }
  return out;
}

/**
 * The comment this run's status belongs in, or `undefined` when there is none.
 *
 * The most recently edited of this account's own status comments for this
 * issue. A live runner edits its sticky every round, so the freshest is the
 * live one — and a second only exists when an edit was refused and this tool
 * posted its own instead ({@link publishSticky}), which is exactly the case
 * where the newer one is the one to go on editing.
 */
export function findSticky(
  comments: readonly IssueComment[],
  subject: StickySubject,
): StickyRef | undefined {
  let best: StickyRef | undefined;
  for (const candidate of stickyCandidates(comments, subject)) {
    if (best === undefined || candidate.updatedAt > best.updatedAt) best = candidate;
  }
  return best;
}

/**
 * The triage comment on an issue, if this run has ever posted one.
 *
 * Held to the same three gates as the sticky. A triage comment carries no
 * heartbeat and moves no label, so the worst a stranger's decoy can do here is
 * be edited-instead-of-created — but "the worst it can do is small" is not a
 * reason to read a stranger's comment as this tool's own.
 */
export function findTriageComment(
  comments: readonly IssueComment[],
  subject: StickySubject,
): StickyRef | undefined {
  const slug = repoSlug(subject.repo);
  const login = requireRunnerIdentity(subject.login);
  for (const comment of comments) {
    if (comment.author !== login) continue;
    const fields = parseMarkerFields(comment.body, 'triage');
    if (fields === undefined) continue;
    if (fields['repo'] !== slug || Number(fields['issue']) !== subject.issue) continue;
    return {
      id: comment.id,
      url: comment.url,
      author: comment.author,
      updatedAt: comment.updatedAt,
      body: comment.body,
      marker: undefined,
    };
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* The sticky comment (R6)                                                     */
/* -------------------------------------------------------------------------- */

/** Where the run is, in the fixed vocabulary the heading and the marker share. */
export type RunPhase =
  | 'claimed'
  | 'planning'
  | 'building'
  | 'judging'
  | 'review'
  | 'blocked'
  | 'stopped'
  | 'reclaimed';

/**
 * The phases a run *ends* in, as opposed to the ones it passes through.
 *
 * A status comment recording one of these describes a run that arrived somewhere:
 * a pull request opened, a stop declared, a budget spent. Recovery reads this
 * to tell a finished run from a failed one, and the difference matters because
 * after a run finishes, where the issue sits is whatever a person decided.
 */
const TERMINAL_PHASES: readonly RunPhase[] = Object.freeze(['review', 'blocked', 'stopped']);

/** One line for each phase, so the same state always reads the same way. */
const PHASE_TEXT: Readonly<Record<RunPhase, string>> = Object.freeze({
  claimed: 'claimed; the snapshot is pinned and the first round has not started',
  planning: 'reading the snapshot and decomposing it into pieces',
  building: 'builders are implementing their pieces',
  judging: 'fresh critics are judging the assembled work against the bar',
  review: 'a pull request is open and waiting on a human',
  blocked: 'stopped on something only a human can settle',
  stopped: 'stopped: the per-issue budget was spent',
  reclaimed: 'reclaimed from a claim that went stale',
});

export type PieceState = 'planned' | 'building' | 'verified' | 'failed';

/** One Task Spec, as the sticky comment shows it. */
export interface StickyPiece {
  id: string;
  title: string;
  covers?: string;
  files?: string;
  verification?: string;
  state: PieceState;
}

export type Verdict = 'WIN' | 'LOSS' | 'BLOCKED' | 'pending';

/** One judged round. */
export interface StickyRound {
  number: number;
  verdict: Verdict;
  /** The critic's gap, verbatim from the round; neutralised on the way in here. */
  gap?: string;
  /** What the verdict was read off: a path, a command, a transcript. */
  evidence?: string;
  at?: string;
}

/** One lifecycle move, for the label history (R5). */
export interface LabelTransition {
  at: string;
  from?: Lifecycle;
  to: Lifecycle;
  why: string;
}

/** A claim taken over from a runner that stopped beating (C7). */
export interface Takeover {
  at: string;
  byRun: string;
  fromRun?: string;
  /** The heartbeat the decision was made on — set only when one was read. */
  lastHeartbeat?: string;
  /**
   * When the issue itself was last touched, when that was all there was.
   *
   * The alternative to this field is one field holding either, which is how a
   * takeover note came to say a run "last beat at" a time no run had beaten at.
   * Whoever's issue this was reads this note to find out what was decided and
   * on what, so the two are named apart.
   */
  lastTouched?: string;
  ageMs?: number;
  ttlMs: number;
  /**
   * True when the issue was carrying no lifecycle label at all, rather than a
   * stale claim: a move that did not finish, recovered from the receipt its own
   * status comment left behind.
   */
  stranded?: boolean;
}

export interface StickyBudget {
  rounds: number;
  maxRounds?: number;
  costUsd?: number;
  maxCostUsd?: number;
}

export interface StickyLinks {
  branch?: string;
  branchUrl?: string;
  pullRequest?: number;
  pullRequestUrl?: string;
  pullRequestDraft?: boolean;
  /** The per-run progress page (R7), as a repo-relative path. */
  progress?: string;
}

/**
 * Everything the sticky comment says, as a plain record.
 *
 * Plain and serializable on purpose: the command that runs the loop holds one
 * of these across rounds, writes it into its run record, and hands it back here
 * to be rendered. Nothing in it is a live object, so nothing about the comment
 * depends on a session still being open.
 */
export interface StickyState {
  runId: string;
  repo: Repo;
  issue: number;
  issueTitle: string;
  issueUrl: string;
  phase: RunPhase;
  /**
   * The state the issue is in, spelled as a label only when one is written.
   *
   * `undefined` when the issue carries no lifecycle label — which is a real
   * state and has to be sayable, because the alternative is a status comment
   * asserting a claim this run no longer holds. It is what a run reports after
   * somebody took `exolvra:working` off it: the label is GitHub's answer, not
   * this run's wish.
   */
  label: Lifecycle | undefined;
  claimedAt: string;
  heartbeat: string;
  snapshot?: SnapshotPin;
  budget: StickyBudget;
  pieces: StickyPiece[];
  rounds: StickyRound[];
  transitions: LabelTransition[];
  takeovers: Takeover[];
  links: StickyLinks;
  /** What a human has to decide, when the run is blocked or stopped (R10). */
  decision?: string;
  /** How long a claim may go without a heartbeat, as this run was told (C7). */
  claimTtlMs: number;
  /**
   * What changed on the issue without changing what the run is judged on.
   *
   * A "+1", a label a maintainer added, a question. Worth a line in the status
   * comment — somebody did something, and a reader should not have to diff the
   * thread to find out — and not worth stopping a run for.
   */
  notes?: string[];
  /**
   * True once somebody took this run's claim off the issue.
   *
   * Separate from {@link StickyState.label}, which says where the *issue* is: a
   * run whose transition was corrected to `blocked` has a label again, and
   * still holds nothing. Without this the run could move that label a second
   * time, which is a move with no claim behind it.
   */
  claimLost?: boolean;
}

/** How much of the sticky comment is spelled out, when it will not all fit. */
type DetailLevel = 'full' | 'trimmed' | 'minimal';

/** How many rounds the table shows before the rest go into a `<details>`. */
const ROUNDS_SHOWN: Readonly<Record<DetailLevel, number>> = Object.freeze({
  full: 20,
  trimmed: 10,
  minimal: 5,
});

function verdictText(verdict: Verdict): string {
  return verdict === 'pending' ? 'pending' : '**' + verdict + '**';
}

function budgetText(budget: StickyBudget): string {
  const rounds =
    budget.maxRounds === undefined
      ? countOf(budget.rounds, 'round', 'rounds')
      : budget.rounds + ' of ' + countOf(budget.maxRounds, 'round', 'rounds');
  if (budget.costUsd === undefined) return rounds;
  const spent = '$' + budget.costUsd.toFixed(2);
  return (
    rounds +
    ' · ' +
    (budget.maxCostUsd === undefined
      ? spent
      : spent + ' of $' + budget.maxCostUsd.toFixed(2))
  );
}

function headingFor(state: StickyState): string {
  const issue = code(issueRef(state.repo, state.issue));
  const rounds =
    state.budget.maxRounds === undefined
      ? 'round ' + state.budget.rounds
      : 'round ' + state.budget.rounds + ' of ' + state.budget.maxRounds;
  // The last verdict, not the last round: a round that is still being judged
  // has no verdict to report, and reporting "pending" as one would put the
  // word where a reader is looking for WIN or LOSS.
  const judged = state.rounds.filter((round) => round.verdict !== 'pending');
  const verdict = judged[judged.length - 1]?.verdict;

  if (state.phase === 'claimed') return '### Exolvra Genesis claimed ' + issue;
  if (state.phase === 'reclaimed') {
    return '### Exolvra Genesis reclaimed ' + issue + ' — the previous claim went stale';
  }
  if (state.phase === 'review') {
    const pr =
      state.links.pullRequest === undefined
        ? 'a pull request'
        : link('#' + state.links.pullRequest, state.links.pullRequestUrl);
    return '### Exolvra Genesis opened ' + pr + ' for ' + issue + ' — won at ' + rounds;
  }
  if (state.phase === 'blocked') {
    return '### Exolvra Genesis stopped on ' + issue + ' — blocked at ' + rounds;
  }
  if (state.phase === 'stopped') {
    return '### Exolvra Genesis stopped on ' + issue + ' — budget spent at ' + rounds;
  }
  return (
    '### Exolvra Genesis is working ' +
    issue +
    ' — ' +
    rounds +
    (verdict === undefined ? '' : ', last verdict ' + verdict)
  );
}

/**
 * What the pull request line says when there is no pull request.
 *
 * "One is opened only when the win condition is met" is true while a run is
 * still going and false the moment the condition *was* met and the push or the
 * pull request call failed — which is a run that ends `blocked` with a **WIN**
 * three lines below in its own round table. A maintainer reading that read one
 * sentence saying no round had won and one table saying one had.
 *
 * So the line is read off the run's own record rather than written flat: what
 * happened, where the work is, and what can still be done with it. The verdict
 * consulted is the *last* round's, because that is the one the run ended on — a
 * win followed by a loss is not a run that won, and claiming it was would be
 * the same defect pointing the other way.
 */
function pullRequestText(state: StickyState): string {
  const links = state.links;
  if (links.pullRequest !== undefined) {
    return (
      link('#' + links.pullRequest, links.pullRequestUrl) +
      (links.pullRequestDraft === true ? ' (draft)' : '')
    );
  }
  if (!(TERMINAL_PHASES as readonly string[]).includes(state.phase)) {
    return 'none yet — one is opened only when the win condition is met';
  }
  const last = state.rounds.at(-1);
  const where =
    links.branch === undefined
      ? '; nothing was pushed'
      : '; the work is pushed to ' + code(links.branch) + ', which one can still be opened from';
  return last?.verdict === 'WIN'
    ? 'none — round ' + last.number + ' won and no pull request was opened' + where
    : 'none — this run ended before the win condition was met' + where;
}

function statusBullets(state: StickyState): string[] {
  const pin = state.snapshot;
  const pull = pullRequestText(state);

  return [
    fact('Phase', PHASE_TEXT[state.phase]),
    fact(
      'Label',
      state.label === undefined
        ? 'none — this run no longer holds a claim on this issue'
        : code(lifecycleLabel(state.label)),
    ),
    // The title, because a comment arrives in a notification with none of the
    // page around it, and "#801" on its own says nothing there.
    fact(
      'Issue',
      link(code(issueRef(state.repo, state.issue)), state.issueUrl) +
        ' — ' +
        safeInline(state.issueTitle, 72),
    ),
    fact(
      'Branch',
      state.links.branch === undefined
        ? 'none yet'
        : link(code(state.links.branch), state.links.branchUrl),
    ),
    fact('Pull request', pull),
    fact(
      'Progress',
      state.links.progress === undefined ? 'not written yet' : code(state.links.progress),
    ),
    fact(
      'Snapshot',
      pin === undefined
        ? 'not pinned yet'
        : code(pin.relativePath) + ' · ' + code('sha256:' + shortSha(pin.sha256)),
    ),
    fact('Budget', budgetText(state.budget)),
    fact(
      'Heartbeat',
      // The bound is unqualified because it is now true as written: the TTL
      // runs from this run's own last heartbeat, since a comment this account
      // did not write is not read for one. It used to carry a sentence saying
      // otherwise, for the case where anybody's comment could reset the clock,
      // and that case no longer exists.
      code(state.heartbeat) +
        ' UTC, updated every round; a claim is reclaimable after ' +
        durationText(state.claimTtlMs),
    ),
  ];
}

function piecesBlock(state: StickyState): string[] {
  if (state.pieces.length === 0) {
    return ['**Pieces**', '', 'Not decomposed yet.'];
  }
  return [
    '**Pieces**',
    '',
    ...table(
      ['Piece', 'Covers', 'Files', 'Verification', 'State'],
      state.pieces.map((piece) => [
        safeInline(piece.id, 12),
        safeInline(piece.covers ?? '—', 32),
        piece.files === undefined ? '—' : code(piece.files),
        piece.verification === undefined ? '—' : code(piece.verification),
        piece.state,
      ]),
    ),
  ];
}

function roundsBlock(state: StickyState, level: DetailLevel): string[] {
  if (state.rounds.length === 0) {
    return ['**Rounds**', '', 'No round has been judged yet.'];
  }
  const shown = ROUNDS_SHOWN[level];
  const visible = state.rounds.slice(-shown);
  const hidden = state.rounds.length - visible.length;
  const lines = [
    '**Rounds**',
    '',
    ...table(
      ['#', 'Verdict', 'Gap', 'Evidence'],
      visible.map((round) => [
        String(round.number),
        verdictText(round.verdict),
        round.gap === undefined || round.gap === '' ? '—' : safeInline(round.gap, 72),
        round.evidence === undefined || round.evidence === ''
          ? '—'
          : safeTail(round.evidence, 44),
      ]),
    ),
  ];
  if (hidden > 0) {
    lines.push('', countOf(hidden, 'earlier round is', 'earlier rounds are') + ' not shown.');
  }
  return lines;
}

function roundDetail(state: StickyState): string[] {
  const withGaps = state.rounds.filter(
    (round) => (round.gap ?? '') !== '' || (round.evidence ?? '') !== '',
  );
  if (withGaps.length === 0) return [];
  const body: string[] = [];
  for (const round of withGaps) {
    body.push(
      '**Round ' +
        round.number +
        '** — ' +
        verdictText(round.verdict) +
        (round.at === undefined ? '' : ' at ' + code(round.at)),
      '',
    );
    if ((round.gap ?? '') !== '') body.push(safeFenced(round.gap ?? '', 'text'), '');
    if ((round.evidence ?? '') !== '') {
      body.push('Evidence: ' + code(round.evidence ?? ''), '');
    }
  }
  return details('Round detail (' + withGaps.length + ')', body.slice(0, -1));
}

function historyBlock(state: StickyState): string[] {
  if (state.transitions.length === 0) return [];
  return details(
    'Label history (' + state.transitions.length + ')',
    table(
      ['When (UTC)', 'From', 'To', 'Why'],
      state.transitions.map((move) => [
        code(move.at),
        move.from === undefined ? '—' : code(lifecycleLabel(move.from)),
        code(lifecycleLabel(move.to)),
        safeInline(move.why, 64),
      ]),
    ),
  );
}

/**
 * The takeover note (C7), written as far as the takeover has actually gone.
 *
 * A reclaim puts the label back to ready and stops there; claiming from ready
 * is a separate act, and the sentence says which of the two the reader is
 * looking at rather than describing the whole journey the moment the first half
 * of it happened.
 */
function takeoverBlock(state: StickyState): string[] {
  if (state.takeovers.length === 0) return [];
  // Where the label actually is, and nowhere else. A takeover note is attached
  // to a state that can outlive the takeover — a run that was reclaimed, then
  // claimed, then lost the claim carries this block still — so the sentence has
  // to read off the label rather than assume the half of the journey it was
  // written for.
  const path =
    state.label === 'working'
      ? 'The label went ' +
        code(lifecycleLabel('working')) +
        ' → ' +
        code(lifecycleLabel('ready')) +
        ' → ' +
        code(lifecycleLabel('working')) +
        '.'
      : state.label === 'ready'
        ? 'The label is back at ' +
          code(lifecycleLabel('ready')) +
          ', where any runner may claim it.'
        : state.label === undefined
          ? 'The issue now carries no ' + code(LABEL_PREFIX) + ' label at all.'
          : 'The label is now ' + code(lifecycleLabel(state.label)) + '.';
  const lines: string[] = [];
  for (const takeover of state.takeovers) {
    if (takeover.stranded === true) {
      lines.push(
        '**Recovered** — run ' +
          code(takeover.byRun) +
          ' found this issue at ' +
          code(takeover.at) +
          ' carrying no ' +
          code(LABEL_PREFIX) +
          ' label at all, and a status comment' +
          (takeover.fromRun === undefined ? '' : ' from run ' + code(takeover.fromRun)) +
          ' saying it had been claimed. A label move did not finish. ' +
          path,
      );
      continue;
    }
    // What the decision rested on, named for what it was. A takeover whose age
    // came off the issue's own timestamp says so: "the previous claim last beat
    // at …" over a time nothing ever beat at is the one sentence in this note
    // somebody would dispute, and they would be right.
    const evidence =
      takeover.lastHeartbeat !== undefined
        ? 'The previous claim' +
          (takeover.fromRun === undefined ? '' : ' (run ' + code(takeover.fromRun) + ')') +
          ' last beat at ' +
          code(takeover.lastHeartbeat)
        : 'No status comment of this run’s account was on the issue, so the age was read ' +
          'off the issue itself, last touched ' +
          (takeover.lastTouched === undefined ? 'at no recorded time' : 'at ' + code(takeover.lastTouched));
    lines.push(
      '**Takeover** — run ' +
        code(takeover.byRun) +
        ' took this issue over at ' +
        code(takeover.at) +
        '. ' +
        evidence +
        (takeover.ageMs === undefined ? '' : ', ' + durationText(takeover.ageMs) + ' earlier') +
        ', and the claim TTL is ' +
        durationText(takeover.ttlMs) +
        '. ' +
        path,
    );
  }
  return lines;
}

/**
 * What a human has to settle, and only while they still have to settle it.
 *
 * Tied to the phase rather than to whether the field was ever filled in: a run
 * that was blocked on Tuesday and is in review on Wednesday must not still be
 * asking for a decision that was made, and a caller that forgot to clear the
 * field is the ordinary case rather than a mistake worth punishing a reader for.
 */
function decisionBlock(state: StickyState): string[] {
  if (state.phase !== 'blocked' && state.phase !== 'stopped') return [];
  if (state.decision === undefined || state.decision.trim() === '') return [];
  return ['**What a human has to decide** — ' + safeInline(state.decision, 400)];
}

/**
 * What happened on the issue that did not move the bar.
 *
 * Said rather than blocked on. A reader who sees the run carry on past three
 * new comments should be able to see that the run noticed them and why it kept
 * going, without diffing the thread themselves.
 */
function notesBlock(state: StickyState): string[] {
  const notes = state.notes ?? [];
  if (notes.length === 0) return [];
  return [
    '**Since it was claimed** — ' +
      notes.map((note) => safeInline(note, 160)).join('; ') +
      '. None of it changes what this run is judged on, so it is still running.',
  ];
}

function stickyMarkerLine(state: StickyState): string {
  return markerOf('sticky', {
    v: '1',
    run: state.runId,
    repo: repoSlug(state.repo),
    issue: String(state.issue),
    phase: state.phase,
    label: state.label === undefined ? 'none' : lifecycleLabel(state.label),
    heartbeat: state.heartbeat,
    claimed: state.claimedAt,
    snapshot: state.snapshot === undefined ? 'none' : 'sha256:' + state.snapshot.sha256,
  });
}

function renderStickyAt(state: StickyState, level: DetailLevel): string {
  const blocks: string[][] = [
    [stickyMarkerLine(state)],
    [headingFor(state)],
    statusBullets(state),
    takeoverBlock(state),
    decisionBlock(state),
    notesBlock(state),
    piecesBlock(state),
    roundsBlock(state, level),
    level === 'full' ? roundDetail(state) : [],
    level === 'minimal' ? [] : historyBlock(state),
    [
      '---',
      '',
      'Posted once and edited in place by `' +
        PROGRAM +
        ' work` (run ' +
        code(state.runId) +
        '). The issue body is never edited, and no label outside `' +
        LABEL_PREFIX +
        '` is touched.',
    ],
  ];
  return blocks
    .filter((block) => block.length > 0)
    .map((block) => block.join('\n'))
    .join('\n\n');
}

/** Said when even the shortest render is longer than a comment may be. */
const TRIM_NOTE =
  '\n\n_This comment reached the size a GitHub comment may be and was cut here._';

/**
 * The sticky comment's whole text (R6).
 *
 * The same sections in the same order every time, whatever the run is doing:
 * what a reader learned from one issue's comment they know for every issue's.
 * Bulk folds into `<details>` rather than disappearing, and if even the folded
 * render is longer than a comment may be, what goes is the detail — in a fixed
 * order — and never the status a person came to read.
 */
export function renderSticky(state: StickyState): string {
  for (const level of ['full', 'trimmed', 'minimal'] as const) {
    const text = renderStickyAt(state, level);
    if (text.length <= COMMENT_LIMIT) return text;
  }
  const text = renderStickyAt(state, 'minimal');
  return [...text].slice(0, COMMENT_LIMIT - TRIM_NOTE.length).join('') + TRIM_NOTE;
}

/* -------------------------------------------------------------------------- */
/* The triage comment (R4)                                                     */
/* -------------------------------------------------------------------------- */

/** What a triage comment is rendered from. */
export interface TriageReport {
  repo: Repo;
  issue: number;
  issueUrl: string;
  spec: DerivedSpec;
  snapshot?: SnapshotPin;
  at: string;
  /** The body, as evidence for the reader who disagrees with the verdict. */
  body: string;
}

/**
 * The comment R4 posts: exactly what is missing, and what would satisfy it.
 *
 * Evidence before the ask. What was read comes first — how much body there was,
 * how many comments, how many checkable items came out of them, what the repo's
 * standards contributed — so the list of missing elements is a conclusion the
 * reader has already been shown the working for, and the body itself is one
 * click away underneath.
 */
export function renderTriageComment(report: TriageReport): string {
  const spec = report.spec;
  const ref = issueRef(report.repo, report.issue);
  const marker = markerOf('triage', {
    v: '1',
    repo: repoSlug(report.repo),
    issue: String(report.issue),
    at: report.at,
    missing: spec.missing.map((element) => element.id).join(',') || 'none',
  });

  const read: string[] = [
    fact(
      'Issue',
      link(code(ref), report.issueUrl) + ' — ' + safeInline(spec.goal, 72),
    ),
    fact(
      'Read',
      countOf(spec.bodyCharacters, 'character', 'characters') +
        ' of body and ' +
        countOf(spec.commentCount, 'comment', 'comments'),
    ),
    fact(
      'Checkable criteria found',
      spec.criteria.length === 0 ? '**none**' : String(spec.criteria.length),
    ),
    fact(
      'Verification commands found',
      spec.commands.length === 0
        ? '**none**'
        : spec.commands.map((entry) => code(entry.command)).join(', '),
    ),
    fact(
      'Repo standards',
      spec.standards.present
        ? code('.exolvra-genesis/standards.md') +
          ' — ' +
          countOf(spec.standards.gates, 'gate', 'gates') +
          ', ' +
          countOf(spec.standards.standingBar, 'standing bar entry', 'standing bar entries')
        : 'no ' + code('.exolvra-genesis/standards.md') + ' in this repository',
    ),
  ];
  if (report.snapshot !== undefined) {
    read.push(
      fact(
        'Snapshot',
        code(report.snapshot.relativePath) +
          ' · ' +
          code('sha256:' + shortSha(report.snapshot.sha256)),
      ),
    );
  }

  // A list rather than a table. Each element carries two sentences of prose,
  // and prose in a table cell is a column three hundred characters wide that
  // nobody can read in the source and that wraps into a wall when rendered.
  const missing: string[] = [];
  for (const [index, element] of spec.missing.entries()) {
    missing.push(
      index + 1 + '. **' + element.name + '**',
      '   - *Looked for* — ' + element.why,
      '   - *To fix* — ' + element.remedy,
    );
  }

  const found =
    spec.criteria.length === 0
      ? []
      : details(
          'Criteria that were found (' + spec.criteria.length + ')',
          table(
            ['Criterion', 'From'],
            spec.criteria.map((criterion) => [
              safeInline(criterion.text, 88),
              safeInline(criterion.source.where, 40),
            ]),
          ),
        );

  const blocks: string[][] = [
    [marker],
    ['### Exolvra Genesis stepped aside on ' + code(ref) + ' — no checkable bar'],
    [
      'Nothing was claimed, no branch was made and the issue is unchanged. A run is judged ' +
        'against a bar it can check, and ' +
        (spec.missing.length === 1
          ? 'one element of that bar is'
          : spec.missing.length + ' elements of that bar are') +
        ' not in the thread yet.',
    ],
    ['**What was read**', '', ...read],
    ['**What is missing**', '', ...missing],
    found,
    details('The body this was read from', [safeFenced(report.body, 'markdown')]),
    [
      '---',
      '',
      'Add what is listed above and put ' +
        code(lifecycleLabel('ready')) +
        ' back on; the next pass reads the issue again from scratch. The label is now ' +
        code(lifecycleLabel('triage')) +
        '. This comment is edited in place rather than repeated.',
    ],
  ];

  const text = blocks
    .filter((block) => block.length > 0)
    .map((block) => block.join('\n'))
    .join('\n\n');
  return text.length <= COMMENT_LIMIT
    ? text
    : [...text].slice(0, COMMENT_LIMIT - TRIM_NOTE.length).join('') + TRIM_NOTE;
}

/* -------------------------------------------------------------------------- */
/* Talking to the issue                                                        */
/* -------------------------------------------------------------------------- */

/** Everything an operation on one issue needs. */
export interface IssueRunContext {
  readonly client: GitHubClient;
  readonly repo: Repo;
  readonly issue: number;
  /** The checkout this run writes under. */
  readonly cwd: string;
  readonly runId: string;
  /**
   * The account this run posts as, from {@link requireRunnerLogin}.
   *
   * Required, and required *here*, because this is the value that makes every
   * operation below able to tell its own status comment from anybody else's. A
   * context is the thing a caller has to hold to act on an issue at all, so an
   * identity that cannot be left out of one is an identity no write can be made
   * without (addendum v0.1.2).
   */
  readonly login: string;
  /** Injected so a heartbeat and a TTL are exercised without waiting for one. */
  readonly now?: () => Date;
}

function nowOf(ctx: IssueRunContext): Date {
  return ctx.now?.() ?? new Date();
}

/**
 * Which issue a status comment has to be about, and whose it has to be.
 *
 * No request and no fallback. The login was settled once, before the pass began
 * ({@link requireRunnerLogin}), so asking again here would be a request per
 * comparison for an answer that cannot have changed — and there is nothing to
 * fall back *to*: a run with no identity may not write, which is why this
 * raises rather than degrading.
 *
 * **Every operation below calls this before its first request.** That is what
 * makes the precondition total rather than advisory: an operation that checked
 * halfway through would already have moved a label by the time it refused.
 */
function subjectFor(ctx: IssueRunContext): StickySubject {
  return { repo: ctx.repo, issue: ctx.issue, login: requireRunnerIdentity(ctx.login) };
}

/**
 * The thread to act on: the one handed in, or the one read here.
 *
 * A caller that already listed the issues has already read them, and reading
 * every issue twice is a rate limit spent on nothing. What is checked is that
 * the thread is about the issue this context names — otherwise the labels would
 * move on one issue while the eligibility was decided on another, and both
 * halves would look right in isolation.
 */
async function threadFor(
  ctx: IssueRunContext,
  given: IssueThread | undefined,
): Promise<IssueThread> {
  if (given === undefined) return ctx.client.getIssueThread(ctx.repo, ctx.issue);
  if (given.issue.number !== ctx.issue) {
    throw new ConfigError(
      [
        'refusing to act on an issue with another issue’s thread',
        '  this run is working ' + issueRef(ctx.repo, ctx.issue),
        '  the thread it was handed is #' + inlineValue(String(given.issue.number)),
      ].join('\n'),
    );
  }
  return given;
}

/** What one lifecycle move did. */
export interface LabelMove {
  /** False only when the label to remove had already moved (C6). */
  moved: boolean;
  labels: string[];
  removed: Lifecycle[];
  added: Lifecycle[];
}

/**
 * Moves the issue from one lifecycle state to another, adding before removing.
 *
 * The **order is the safety property**. The removal is the whole race — GitHub
 * answers a delete of a label the issue does not carry with 404, which
 * {@link GitHubClient.removeLabel} reports as `false`, so exactly one runner is
 * ever told it removed the label — and the add happens first so that no failure
 * between the two calls can leave the issue carrying no lifecycle label at all.
 *
 * Remove-then-add has a window in which the issue carries nothing, and one
 * failed request is enough to leave it there: nothing lists it and nothing
 * claims it. Add-then-remove has a window too, but the opposite one: the issue
 * briefly carries two labels, which is a state something can still see.
 *
 * **This function never takes the added label off again.** Four rounds of
 * findings came out of trying to be clever here, and the shape of the mistake
 * was always the same: on a lost race there is no state this function can put
 * the issue in that is both true and its business to choose. The add stands,
 * the caller is told the move did not happen, and the caller — which knows what
 * it was trying to do — decides what is true instead. {@link transitionIssue}
 * corrects to `blocked`; {@link reclaimIssue} recovers whatever is left over.
 *
 * Afterwards the other lifecycle labels are taken off, because the five are one
 * state and not five flags: an issue that was triaged and then re-labelled
 * ready by a maintainer would otherwise sit in two states at once. Labels
 * outside the five are never read and never touched (C8).
 *
 * A move from a state to itself removes nothing. There is no state change to
 * race over, and taking the label off to put it straight back would be two
 * entries in the issue's timeline saying nothing happened.
 */
async function moveLifecycleLabel(
  ctx: IssueRunContext,
  to: Lifecycle,
  from: Lifecycle | undefined,
): Promise<LabelMove> {
  const target = requireLifecycleState(to, 'move this issue to a state it does not own');
  const source =
    from === undefined || from === to
      ? undefined
      : requireLifecycleState(from, 'take a label off that this tool does not own');
  const removed: Lifecycle[] = [];

  let labels = await ctx.client.addLabels(ctx.repo, ctx.issue, [target]);

  if (source !== undefined && from !== undefined) {
    const wasThere = await ctx.client.removeLabel(ctx.repo, ctx.issue, source);
    if (!wasThere) {
      return { moved: false, labels, removed: [], added: [to] };
    }
    removed.push(from);
    labels = labels.filter((name) => name !== source);
  }

  for (const state of LIFECYCLE) {
    const label = lifecycleLabel(state);
    if (state === to || !labels.includes(label)) continue;
    // **The tidy never removes `ready`.** It is the authorization label, and a
    // maintainer putting it on is the act this whole tool waits for (C5). The
    // only thing that may take it off is the compare-and-swap above, which
    // consumes it by name to make a claim — every other removal here would be
    // this tool quietly un-applying a human's decision. An issue that is
    // `triage` *and* `ready` is a maintainer answering the triage comment; if
    // the tidy stripped `ready` there, the remedy this tool prints would be one
    // it deletes a day later.
    if (state === 'ready') continue;
    const wasThere = await ctx.client.removeLabel(ctx.repo, ctx.issue, label);
    if (wasThere) removed.push(state);
    labels = labels.filter((name) => name !== label);
  }
  return { moved: true, labels, removed, added: [to] };
}

/** Whether a fault means "that comment is not yours to edit". */
function notOurs(error: unknown): boolean {
  return (
    error instanceof GitHubError && (error.kind === 'auth' || error.kind === 'not-found')
  );
}

/**
 * Posts the sticky comment, or edits the one that is already there (R6).
 *
 * **Only ever a comment this account wrote.** The one it is handed came from
 * {@link findSticky}, which returns nothing else, so this cannot be pointed at
 * a stranger's words: not because GitHub would refuse the edit — it does, and
 * the fallback below catches that refusal — but because relying on the refusal
 * would make this tool's safety a property of the host's permission check
 * rather than of the tool. Against a host that answered 200, a runner that
 * decided this for itself would rewrite a stranger's words into its own status.
 *
 * The fallback covers the case identity cannot: a comment this account really
 * did write and can no longer change — locked, converted, a permission that
 * moved. Rather than raise, it posts the run's own comment, because a run that
 * cannot edit the comment it found must not end up with its status recorded
 * nowhere, which is what would happen to a takeover note if this threw. From
 * then on the run's own comment is the newest one carrying the marker, so the
 * next round finds it first.
 */
async function publishSticky(
  ctx: IssueRunContext,
  state: StickyState,
  existing: StickyRef | undefined,
): Promise<StickyRef> {
  const body = renderSticky(state);
  let comment: IssueComment | undefined;
  if (existing !== undefined) {
    try {
      comment = await ctx.client.updateComment(ctx.repo, existing.id, body);
    } catch (error) {
      if (!notOurs(error)) throw error;
    }
  }
  comment ??= await ctx.client.createComment(ctx.repo, ctx.issue, body);
  return {
    id: comment.id,
    url: comment.url,
    author: comment.author,
    updatedAt: comment.updatedAt,
    body: comment.body,
    marker: parseStickyMarker(comment.body),
  };
}

/* -------------------------------------------------------------------------- */
/* Claiming (C6)                                                               */
/* -------------------------------------------------------------------------- */

/** Why a claim was not made. Every one of them is a silent skip, not a fault. */
export type ClaimRefusal =
  | 'not-ready'
  | 'closed'
  | 'pull-request'
  | 'lost-race';

export interface ClaimOptions {
  /** The thread, when the caller has already read it. Otherwise it is read here. */
  thread?: IssueThread;
  /** Carried into the sticky comment when this claim follows a reclaim (C7). */
  takeover?: Takeover;
  budget?: StickyBudget;
  links?: StickyLinks;
  claimTtlMs?: number;
}

export interface ClaimOutcome {
  claimed: boolean;
  /** Set only when `claimed` is false. */
  refusal?: ClaimRefusal;
  /** One line for a log or a run record. Nothing here prints it. */
  reason: string;
  labels: string[];
  snapshot?: SnapshotPin;
  sticky?: StickyRef;
  state?: StickyState;
}

/** Puts the issue back where it was found, as far as it still can be. */
async function releaseClaim(ctx: IssueRunContext): Promise<void> {
  try {
    await moveLifecycleLabel(ctx, 'ready', 'working');
  } catch {
    // The rollback is a courtesy on a path that is already failing; the fault
    // that started it is the one the caller has to see, so this one is dropped
    // rather than raised over the top of it. A claim left behind is exactly
    // what the C7 heartbeat and its TTL exist to recover.
  }
}

/**
 * Claims the issue, or steps aside without a word (C6).
 *
 * In order, and the order is the whole of the safety: the issue is read, it is
 * checked for being the kind of thing that may be claimed at all, the working
 * label goes on, and then the ready label comes off. That last step is the
 * compare-and-swap — GitHub tells exactly one runner it removed the label — and
 * everything after it is done by a runner that knows it holds the claim.
 *
 * A claimant that loses leaves behind the one thing it wrote: the working
 * label, which is the same label the winner writes. It cannot take it back off,
 * because it cannot tell its own add from the winner's, and the issue's state
 * is the winner's either way. It posts nothing, snapshots nothing, and stops.
 *
 * A claim that cannot be *finished* is put back: if the snapshot or the comment
 * fails, the label is returned to ready before the fault is raised, so a fault
 * never leaves an issue claimed by nobody.
 */
export async function claimIssue(
  ctx: IssueRunContext,
  options: ClaimOptions = {},
): Promise<ClaimOutcome> {
  const who = subjectFor(ctx);
  const thread = await threadFor(ctx, options.thread);
  const issue = thread.issue;
  const ref = issueRef(ctx.repo, issue.number);

  if (issue.isPullRequest) {
    return {
      claimed: false,
      refusal: 'pull-request',
      reason: ref + ' is a pull request, not an issue',
      labels: issue.labels,
    };
  }
  if (issue.state !== 'open') {
    return {
      claimed: false,
      refusal: 'closed',
      reason: ref + ' is ' + plainText(issue.state),
      labels: issue.labels,
    };
  }
  // The state the issue is in, not merely whether the ready label is on it
  // somewhere. An issue carrying `exolvra:blocked` as well as `exolvra:ready`
  // is waiting on a person, and the shared vocabulary says which of two labels
  // wins — so the runner and the queue read the same issue the same way.
  const eligible = claimability(issue.labels);
  if (!eligible.ok) {
    return {
      claimed: false,
      refusal: 'not-ready',
      reason: ref + ' ' + eligible.why,
      labels: issue.labels,
    };
  }

  const at = nowOf(ctx);
  const move = await moveLifecycleLabel(ctx, 'working', 'ready');
  if (!move.moved) {
    return {
      claimed: false,
      refusal: 'lost-race',
      reason:
        lifecycleLabel('ready') + ' had already moved on ' + ref + '; another runner owns it',
      labels: issue.labels,
    };
  }

  try {
    const snapshot = writeIssueSnapshot(ctx.cwd, ctx.runId, ctx.repo, thread, at);
    const stamp = isoSeconds(at);
    const state: StickyState = {
      runId: ctx.runId,
      repo: ctx.repo,
      issue: issue.number,
      issueTitle: issue.title,
      issueUrl: issue.url,
      phase: 'claimed',
      label: 'working',
      claimedAt: stamp,
      heartbeat: stamp,
      snapshot,
      budget: options.budget ?? { rounds: 0 },
      pieces: [],
      rounds: [],
      transitions: [
        ...(options.takeover === undefined
          ? []
          : [
              {
                at: options.takeover.at,
                from: 'working',
                to: 'ready',
                why: 'the claim went stale and was reclaimed',
              } satisfies LabelTransition,
            ]),
        { at: stamp, from: 'ready', to: 'working', why: 'claimed by this run' },
      ],
      takeovers: options.takeover === undefined ? [] : [options.takeover],
      links: options.links ?? {},
      claimTtlMs: options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS,
    };

    return {
      claimed: true,
      reason: 'claimed ' + ref + ' as run ' + ctx.runId,
      labels: move.labels,
      snapshot,
      sticky: await publishSticky(ctx, state, findSticky(thread.comments, who)),
      state,
    };
  } catch (error) {
    await releaseClaim(ctx);
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* The heartbeat and the reclaim (C7)                                          */
/* -------------------------------------------------------------------------- */

/** What one round's heartbeat did, and whether the run may go on. */
export interface HeartbeatOutcome {
  state: StickyState;
  sticky: StickyRef;
  /**
   * True when this run must stop: the issue it is building against has moved.
   *
   * It says the run is over, not that a label moved. The label move is
   * attempted and reported, but a run whose issue was rewritten has to stop
   * whether or not it still holds the label to say so with.
   */
  blocked: boolean;
  /** Set when `blocked`: what changed on the issue since it was claimed. */
  drift?: IssueDrift;
}

/**
 * Beats the heartbeat, having first checked that the spec has not moved (C11).
 *
 * Called once a round, which is what makes the TTL mean anything: a runner that
 * is alive says so on the issue itself, where another runner — on another
 * machine, with no shared state but the issue — can read it.
 *
 * Both halves of the pin are re-verified here, and they answer different
 * questions. The file on disk answers "is the spec this run is building against
 * the one it pinned?" — a local edit, which raises. The *issue* answers "is the
 * pinned spec still what the issue says?" — and that one cannot be answered
 * without reading GitHub again, which is exactly why it was worth nothing when
 * it was not being asked. An issue edited after it was claimed is a different
 * bar than the one the run agreed to, and a run that beat on regardless would
 * be reporting progress against a spec that had been rewritten underneath it —
 * which is the shape of the attack as much as of the accident.
 *
 * A moved spec is `blocked`, not a fault: the label moves, the sticky comment
 * says what changed and what a human has to decide, and the caller is told. The
 * run stops having said so, rather than stopping silently or carrying on.
 *
 * A thread that changed *around* the spec — somebody said "+1", a maintainer
 * added a priority label — is noted in the sticky comment and beaten through.
 * Stopping for those would hand anybody with a GitHub account a stop button on
 * every issue this tool is working, which is a worse failure than the one the
 * check exists to catch.
 */
export async function beatHeartbeat(
  ctx: IssueRunContext,
  state: StickyState,
  sticky: StickyRef,
): Promise<HeartbeatOutcome> {
  // The identity gate, before the pin check and before any request. This one
  // edits a comment rather than searching for one, so it has no other use for
  // the subject — and skipping the gate for that reason is how an operation
  // ends up writing without one.
  subjectFor(ctx);
  const pin = state.snapshot;
  if (pin === undefined) {
    const beaten: StickyState = { ...state, heartbeat: isoSeconds(nowOf(ctx)) };
    return { state: beaten, sticky: await publishSticky(ctx, beaten, sticky), blocked: false };
  }

  assertIssueSnapshot(ctx.cwd, ctx.runId);
  const thread = await ctx.client.getIssueThread(ctx.repo, ctx.issue);
  const drift = readIssueDrift(thread, pin);

  if (drift.blocking) {
    const stopped = await transitionIssue(ctx, state, sticky, 'blocked', {
      why: drift.summary,
      phase: 'blocked',
      // The summary rather than the list of names: it carries the proof — the
      // hash of the thing that changed, before and after — and the decision
      // line is where a person reads it. The label history quotes the same
      // sentence, cut to a table cell.
      decision:
        drift.summary +
        '. Nothing here is judged against the new text: re-apply ' +
        lifecycleLabel('ready') +
        ' to start a run against the issue as it now reads, or revert the edit',
    });
    return { state: stopped.state, sticky: stopped.sticky, blocked: true, drift };
  }

  const beaten: StickyState = {
    ...state,
    heartbeat: isoSeconds(nowOf(ctx)),
    notes: drift.noted.length === 0 ? undefined : drift.noted,
  };
  return {
    state: beaten,
    sticky: await publishSticky(ctx, beaten, sticky),
    blocked: false,
    ...(drift.same ? {} : { drift }),
  };
}

/** What one transition did, and what the issue actually says afterwards. */
export interface TransitionOutcome {
  moved: boolean;
  state: StickyState;
  sticky: StickyRef;
  labels: string[];
  /** One line for a log. Nothing here prints it. */
  reason: string;
}

/**
 * Moves the issue to another lifecycle state and says so in the sticky (R5).
 *
 * One call, so a transition can never be half made: the label moves, the move
 * is written into the label history, the heartbeat is refreshed, and the
 * comment is edited. A caller that moved the label itself and then forgot the
 * comment is a shape this file does not offer.
 *
 * **A transition that does not move means this run has lost its claim.** Only
 * the holder makes these moves, so the label being gone means somebody took it
 * — another runner, or a person. Three things follow, and each of them was
 * wrong here once:
 *
 * - The label this move added comes back off. Leaving `exolvra:review` on an
 *   issue with no pull request would have this tool asserting something about
 *   the repository that is not true, to every human who reads the queue.
 * - The state that comes back is the one GitHub holds, not the one this run
 *   was holding — including "no lifecycle label at all", which is why
 *   {@link StickyState.label} can say so. A run reporting `working` while the
 *   issue says otherwise is two sources of truth, permanently disagreeing.
 * - The run stops, and says so in its own status comment.
 */
export async function transitionIssue(
  ctx: IssueRunContext,
  state: StickyState,
  sticky: StickyRef,
  to: Lifecycle,
  options: { why: string; phase?: RunPhase; decision?: string } = { why: '' },
): Promise<TransitionOutcome> {
  // The identity gate, before the label move. Same reason as {@link
  // beatHeartbeat}: this moves a label and edits a comment without searching
  // for one, and an operation that writes is an operation that needs a login.
  subjectFor(ctx);
  const at = isoSeconds(nowOf(ctx));
  const ref = issueRef(ctx.repo, ctx.issue);

  // A run that already knows it holds nothing does not get to move a label. The
  // move would have no `from` to swap against, which would make it an
  // uncontested add — the one shape the compare-and-swap exists to prevent.
  if (state.label === undefined || state.claimLost === true) {
    return {
      moved: false,
      state,
      sticky,
      labels: [],
      reason: 'this run holds no claim on ' + ref + ', so it moved nothing',
    };
  }

  const move = await moveLifecycleLabel(ctx, to, state.label);
  if (!move.moved) {
    // The label this move added stands — nothing here takes it off, because
    // there is no shape this function can leave the issue in that is both true
    // and safe. `blocked` is: it means "a human must decide", which is exactly
    // what has happened. So the wrong-but-visible label is corrected to it.
    //
    // If the correction itself fails the issue is left carrying the target of a
    // move that did not happen, which is wrong — and it is *visible*, and
    // {@link reclaimIssue} recovers exactly that shape on the next pass. That
    // failure is reported rather than swallowed: a request that leaves the
    // repository in a state this run did not intend is never a courtesy.
    let corrected = to === 'blocked';
    let correctionFault: string | undefined;
    if (!corrected) {
      try {
        corrected = (await moveLifecycleLabel(ctx, 'blocked', to)).moved;
        if (!corrected) correctionFault = 'the label moved again before it could be corrected';
      } catch (error) {
        correctionFault =
          error instanceof Error ? plainText(error.message.split('\n')[0] ?? '') : String(error);
      }
    }

    const now = await ctx.client.getIssue(ctx.repo, ctx.issue);
    const carried = lifecycleOf(now.labels);
    const wrong = correctionFault !== undefined;
    const lost: StickyState = {
      ...state,
      label: carried,
      claimLost: true,
      phase: 'blocked',
      heartbeat: at,
      decision:
        'this run lost its claim: ' +
        lifecycleLabel(state.label) +
        ' was taken off ' +
        ref +
        ' by somebody else, so nothing here moved it to ' +
        lifecycleLabel(to) +
        '. The issue now carries ' +
        (carried === undefined ? 'no lifecycle label' : lifecycleLabel(carried)) +
        (wrong
          ? ', which is wrong and could not be corrected (' +
            correctionFault +
            '); the next pass recovers it'
          : '') +
        '. Whoever holds it now decides what happens to it',
      transitions: [
        ...state.transitions,
        {
          at,
          from: state.label,
          to: carried ?? 'blocked',
          why: 'the claim was taken by somebody else',
        },
      ],
    };
    return {
      moved: false,
      state: lost,
      sticky: await publishSticky(ctx, lost, sticky),
      labels: now.labels,
      reason:
        lifecycleLabel(state.label) +
        ' had already been taken off ' +
        ref +
        '; this run has lost its claim and stopped' +
        (wrong
          ? '. The issue was left carrying ' +
            lifecycleLabel(to) +
            ', which could not be corrected to ' +
            lifecycleLabel('blocked') +
            ': ' +
            correctionFault
          : ''),
    };
  }
  const next: StickyState = {
    ...state,
    label: to,
    phase: options.phase ?? state.phase,
    decision: options.decision ?? state.decision,
    heartbeat: at,
    transitions: [...state.transitions, { at, from: state.label, to, why: options.why }],
  };
  return {
    moved: true,
    state: next,
    sticky: await publishSticky(ctx, next, sticky),
    labels: move.labels,
    reason: 'moved ' + ref + ' to ' + lifecycleLabel(to),
  };
}

/** What a status comment says about being alive, and whether it can be believed. */
type Liveness =
  | { believed: true; at: Date; from: 'marker' | 'comment' }
  | { believed: false; claimed: Date; edited: Date };

/**
 * When a status comment last said it was alive — or that it cannot be believed.
 *
 * **The marker governs, and one thing disqualifies it.** The heartbeat is the
 * `heartbeat=` field, because that is the field a live runner rewrites every
 * round and the only one that means "a round happened". The comment's own
 * `updated_at` is not a second opinion about that: it is the *check* on it.
 * GitHub bumps `updated_at` on every edit and nobody else can, so a genuine
 * heartbeat can never be newer than the last edit that carried it. A marker
 * that postdates its own comment is therefore impossible, therefore forged or
 * mangled, and a comment carrying one is not evidence of a live claim at all.
 *
 * Two clocks read as one answer, and it matters which:
 *
 * - **`heartbeat=` ≤ `updated_at`** — believed. The claim is as old as the
 *   marker says, whatever the comment was edited for since, and that is the
 *   number every decision and every sentence uses.
 * - **`heartbeat=` > `updated_at`** — not believed, and the fallback is *not*
 *   `updated_at`. Taking the edit time instead read a claim the marker called
 *   an hour old as forty-eight hours old, reclaimed it, and printed the edit
 *   time as "its last heartbeat" — deciding on one clock and quoting the other.
 *   Nothing here is read; the caller falls through to what else there is, and
 *   says the marker was disbelieved.
 * - **No readable `heartbeat=`** — the comment's own edit time, which is a real
 *   thing that happened but is not a heartbeat and is never called one.
 */
function heartbeatOf(
  comment: { readonly updatedAt: string },
  marker: StickyMarker | undefined,
): Liveness | undefined {
  const edited = parseStamp(comment.updatedAt);
  const beat = parseStamp(marker?.heartbeat ?? '');
  if (beat !== undefined && edited !== undefined && beat.getTime() > edited.getTime()) {
    return { believed: false, claimed: beat, edited };
  }
  if (beat !== undefined) return { believed: true, at: beat, from: 'marker' };
  return edited === undefined ? undefined : { believed: true, at: edited, from: 'comment' };
}

/** What a claim's heartbeat says about how old it is. */
export interface ClaimAge {
  /**
   * The time the age was measured from, and **not always a heartbeat**.
   *
   * {@link ClaimAge.from} says which it is, and every sentence built out of
   * this has to consult it. A run that printed "its last heartbeat was 1085h
   * ago" over a `from: 'issue'` fallback was quoting the moment somebody last
   * touched the issue as though a runner had beaten then — a figure with the
   * authority of a heartbeat and none of the provenance.
   */
  heartbeat: string | undefined;
  /** Where it came from: the marker, the comment's own timestamp, or the issue. */
  from: 'marker' | 'comment' | 'issue' | 'none';
  ageMs: number | undefined;
  stale: boolean;
  runId: string | undefined;
  /**
   * How many of this account's own status comments name this issue.
   *
   * Normally one. Two means an edit was refused once and this tool posted its
   * own comment rather than lose a status ({@link publishSticky}) — worth a
   * line in a log, and never a reason to decide anything differently.
   */
  candidates: number;
  /**
   * A marker that claimed a heartbeat its own comment cannot have carried.
   *
   * Set when one was found and left out of the reckoning ({@link heartbeatOf}).
   * It travels out because the decision it changes is a decision about somebody
   * else's work: a reader told only "recovered, the issue was last touched 48h
   * ago" cannot see that a comment on that issue claimed to be an hour old, or
   * why that claim was refused.
   */
  disbelieved?: { claimed: string; edited: string };
}

/**
 * How old the claim on an issue is — this run's account's newest heartbeat.
 *
 * This function's answer decides whether one runner takes an issue away from
 * another, so what it will read is narrow on purpose.
 *
 * - **Only this account's own status comments.** Nothing else is a heartbeat.
 *   A comment somebody else wrote is not read for a time, so no comment anybody
 *   can post makes a live claim look dead or a dead one look alive.
 * - **The newest of them wins, not the first.** Position is not recency, and
 *   reading the first marker-carrying comment let an older comment of this
 *   account's own — the one a refused edit left behind — speak for a run that
 *   had beaten since.
 * - **The marker governs, and one thing disqualifies it** ({@link heartbeatOf}).
 *   A `heartbeat=` newer than the `updated_at` of the comment carrying it is a
 *   thing GitHub cannot produce, so that comment is left out of the reckoning
 *   entirely rather than half-read at its edit time — which is how a claim
 *   decided on one clock came to be reported in the units of the other.
 *
 * With no usable comment the issue's own last update is the evidence, which is
 * weaker but is GitHub's. That fallback is reached whenever this account has no
 * status comment here — including on an issue where somebody else's comment
 * carries a copied marker, since that is not a candidate and so cannot displace
 * it — and whenever the only comments here claim heartbeats they cannot have.
 */
export function claimAge(
  thread: IssueThread,
  now: Date,
  ttlMs: number,
  // Required, and deliberately not defaulted. It carries both halves of what a
  // status comment has to be — this issue's, and this account's — and a default
  // for either would be a caller silently reading somebody else's comment as a
  // heartbeat instead of getting a compile error.
  where: StickySubject,
): ClaimAge {
  const candidates = stickyCandidates(thread.comments, where);

  let best: { at: Date; from: ClaimAge['from']; ref: StickyRef } | undefined;
  // The newest of the ones that cannot be believed, so the sentence quotes the
  // boldest claim rather than whichever came first in the thread.
  let refused: { claimed: Date; edited: Date } | undefined;
  for (const candidate of candidates) {
    const beat = heartbeatOf(candidate, candidate.marker);
    if (beat === undefined) continue;
    if (!beat.believed) {
      if (refused === undefined || beat.claimed.getTime() > refused.claimed.getTime()) {
        refused = { claimed: beat.claimed, edited: beat.edited };
      }
      continue;
    }
    if (best === undefined || beat.at.getTime() > best.at.getTime()) {
      best = { at: beat.at, from: beat.from, ref: candidate };
    }
  }
  const disbelieved =
    refused === undefined
      ? {}
      : {
          disbelieved: {
            claimed: isoSeconds(refused.claimed),
            edited: isoSeconds(refused.edited),
          },
        };

  if (best !== undefined) {
    const ageMs = now.getTime() - best.at.getTime();
    return {
      heartbeat: isoSeconds(best.at),
      from: best.from,
      ageMs,
      stale: ageMs > ttlMs,
      runId: best.ref.marker?.run,
      candidates: candidates.length,
      ...disbelieved,
    };
  }

  const updated = parseStamp(thread.issue.updatedAt);
  if (updated !== undefined) {
    const ageMs = now.getTime() - updated.getTime();
    return {
      heartbeat: isoSeconds(updated),
      from: 'issue',
      ageMs,
      stale: ageMs > ttlMs,
      runId: undefined,
      candidates: candidates.length,
      ...disbelieved,
    };
  }
  return {
    heartbeat: undefined,
    from: 'none',
    ageMs: undefined,
    stale: false,
    runId: undefined,
    candidates: candidates.length,
    ...disbelieved,
  };
}

export interface ReclaimOptions {
  thread?: IssueThread;
  ttlMs?: number;
}

export interface ReclaimOutcome {
  reclaimed: boolean;
  /** One line for a log; nothing here prints it. */
  reason: string;
  age: ClaimAge;
  labels: string[];
  /** Ready to hand to {@link claimIssue}, so the takeover is on the record. */
  takeover?: Takeover;
  sticky?: StickyRef;
}

/** What a stale issue should be moved to, and why — or why it is left alone. */
interface RecoveryPlan {
  /** The state to move it to, or `undefined` to leave it exactly as it is. */
  to: Lifecycle | undefined;
  /** One clause, for the reason line. Reads after the issue reference. */
  why: string;
  /** True when the issue was carrying no lifecycle label at all. */
  stranded: boolean;
}

/**
 * What recovery does with an issue, in whatever shape a failure left it.
 *
 * Four rounds of findings came from recovering exactly one shape — a stale
 * `exolvra:working` — and leaving every other shape unreachable. The rule that
 * widens it without giving anything away comes from reading C5 precisely:
 * **`exolvra:ready` is the authorization label and applying it is a
 * maintainer's act. Every other lifecycle label is status.** So repairing a
 * wrong *status* needs no authority; only landing on `ready` does.
 *
 * **What is recoverable at all** is a run that stopped beating without ever
 * reaching a terminal phase. That is the discriminator, and it is the second
 * one this function has had: the first compared the status comment's recorded
 * label against the issue's current label, which made every human relabel after
 * a finished run look like a failure. A run that published a pull request,
 * declared a block or recorded a stop is *finished*, and where a person moves
 * the issue afterwards is the person's business.
 *
 * **What it may land on** follows C5 read precisely: `exolvra:ready` is the
 * authorization label and applying it is a maintainer's act; every other
 * lifecycle label is status. Repairing a wrong status needs no authority, and
 * landing on `ready` needs either this account's own status comment or the fact
 * that `ready` is already on the issue — keeping a label the maintainer applied
 * is not applying it.
 *
 * **Every question below is asked of the label *set*.** Not of
 * {@link lifecycleOf}, which answers "which state does a reader most need to be
 * told about" and ranks `review` above `working`: read through that, an issue
 * carrying both looked like a resting `review` and was left alone for good,
 * though `working` was right there on it — and `[working, review]` is one 5xx
 * on a correction's delete away, with nobody attacking anything. The set is
 * also how {@link claimability} reads an issue on the way in, so both ends
 * agree about what a pair of labels means.
 *
 * In order, and each of these is a case that was wrong once:
 *
 * - **`ready` with no `working` and no `blocked`** → left alone. A maintainer
 *   has authorized it; the claim path takes it from here, and reads the same
 *   set the same way ({@link claimability}).
 * - **`ready` with `blocked`** → left alone. Two human decisions in an order
 *   nobody here can know.
 * - **No lifecycle label** → `ready` on this account's own receipt, otherwise
 *   left alone: any label added there would be a claim about an issue nothing
 *   of this tool's says it ever touched.
 * - **`blocked` among several labels** → tidied to `blocked`, which is the
 *   terminus and asserts nothing new.
 * - **`ready` or `blocked` alone** → left alone; both are a person's.
 * - **A finished run's issue, with no `working` on it** → left alone, whatever
 *   the label.
 * - **`working`, or a run that stopped mid-flight** → `ready` when this
 *   account's own status comment is there or `ready` already is, and `blocked`
 *   otherwise.
 *
 * Every plan is still subject to the TTL, which is what keeps all of this away
 * from a run that is simply in progress.
 */
function recoveryPlan(labels: readonly string[], sticky: StickyRef | undefined): RecoveryPlan {
  const carried = lifecycleOf(labels);
  const held = labels.filter(isLifecycleLabel);
  const has = (state: Lifecycle): boolean => held.includes(lifecycleLabel(state));
  // Ours by construction: `findSticky` returns this account's own comments and
  // nothing else, so its presence is the receipt and there is no second
  // question to ask about it.
  const ours = sticky !== undefined;
  const claimed = sticky?.marker?.claimed !== undefined && sticky.marker.claimed !== '';
  /**
   * A run that never reached a terminus, and stopped saying anything.
   *
   * This is the discriminator, and the one it replaced was wrong. That one
   * compared the status comment's recorded label against the issue's current
   * label and called any difference a failed run — but only this tool writes
   * that comment, so *any* human relabelling after a run ended looked like
   * disagreement. A maintainer parking a finished piece of work in `triage` by
   * hand was read as a failure and dragged back into the queue.
   *
   * What a failed run actually is: a heartbeat that stopped on a run that never
   * reached a terminal phase. A sticky that reached one — a pull request
   * published, a stop recorded, a block declared — is a *finished* run, and
   * what a person does with the issue afterwards is the person's business.
   */
  const phase = sticky?.marker?.phase ?? '';
  const finished = (TERMINAL_PHASES as readonly string[]).includes(phase);
  const midFlight = ours && phase !== '' && !finished;

  // The maintainer's authorization is live. Whatever else is on the issue, this
  // is not a broken state to repair — it is an issue waiting to be claimed, and
  // the claim path reads it the same way ({@link claimability}).
  if (has('ready') && !has('working') && !has('blocked')) {
    return {
      to: undefined,
      why:
        'carries ' +
        lifecycleLabel('ready') +
        ', so a maintainer has authorized it and the claim path takes it from here',
      stranded: false,
    };
  }
  if (has('ready') && has('blocked')) {
    return {
      to: undefined,
      why:
        'carries ' +
        lifecycleLabel('ready') +
        ' and ' +
        lifecycleLabel('blocked') +
        ' at once — two human decisions in an order this cannot know, so it is left ' +
        'for a person',
      stranded: false,
    };
  }

  if (carried === undefined) {
    if (!claimed) {
      return {
        to: undefined,
        why: 'carries no lifecycle label, and no status comment of this tool’s claims it',
        stranded: true,
      };
    }
    return {
      to: 'ready',
      why: 'carries no lifecycle label and this run’s own status comment claims it',
      stranded: true,
    };
  }

  // More than one lifecycle label at once is never a resting state: an issue at
  // rest carries exactly one. Where `blocked` is among them it is the answer —
  // it is this tool's terminus and a person's to move, so tidying to it asserts
  // nothing and creates nothing. Every other combination is left to the
  // reasoning below, which reads the status comment and can tell a stale claim
  // from a run that stopped mid-flight; re-asserting the precedence winner
  // there would put `exolvra:review` back on an issue with no pull request.
  //
  // `ready` can never be named here — every set containing it was answered
  // above — so this branch cannot reach for the authorization label.
  if (held.length > 1 && carried === 'blocked') {
    return {
      to: 'blocked',
      why: 'carries ' + held.length + ' lifecycle labels at once: ' + held.join(', '),
      stranded: false,
    };
  }

  if (carried === 'ready') {
    return { to: undefined, why: 'is ' + lifecycleLabel('ready'), stranded: false };
  }

  // `blocked` is where recovery *ends*, so it is never where recovery starts.
  // It means a human must decide, and a person who blocked a live claim by hand
  // meant to stop it — moving it on after a day would take the decision back
  // off them. It is also the terminus this tool aims at, so recovering it would
  // be recovering its own answer.
  if (carried === 'blocked') {
    return {
      to: undefined,
      why: 'is ' + lifecycleLabel('blocked') + ', which is a person’s to move',
      stranded: false,
    };
  }

  // A run that reached a terminus is a finished run, and where the issue sits
  // now is whatever a person decided afterwards.
  //
  // **Only when the issue is not still claimed.** A terminal phase means a run
  // arrived somewhere; if `working` is still on the issue then the claim
  // outlived whatever that comment describes, and an older run's own "review"
  // is enough to say so — no stranger required. Read through the precedence
  // winner instead of the set, `[working, review]` answered here and was never
  // recovered at all.
  if (finished && !has('working')) {
    return {
      to: undefined,
      why:
        'is ' +
        lifecycleLabel(carried) +
        ', and the last run on it finished (' +
        plainText(phase) +
        ') — where it sits now is a person’s decision',
      stranded: false,
    };
  }

  // What is left: a claim that stopped beating, or a run that never reached a
  // terminus and left the issue somewhere it should not be.
  //
  // Without `working` on it, the *only* evidence that anything went wrong is
  // this account's own status comment, so there has to be one saying a run was
  // in flight. `working` needs no such corroboration: the label is evidence
  // that this tool claimed the issue, and only this tool writes it.
  if (!has('working') && !midFlight) {
    return {
      to: undefined,
      why:
        'is ' +
        lifecycleLabel(carried) +
        ', and nothing of this tool’s says a run was in flight when it arrived there',
      stranded: false,
    };
  }

  // Landing on `ready` needs this account's own receipt, or a `ready` already
  // on the issue — keeping a label a maintainer applied is not applying it.
  if (ours || has('ready')) {
    return {
      to: 'ready',
      why: midFlight ? 'is a run that stopped mid-flight' : 'is a stale claim',
      stranded: false,
    };
  }
  return {
    to: 'blocked',
    why:
      'is a stale claim with no status comment of this run’s account on it, so it goes to ' +
      lifecycleLabel('blocked') +
      ' rather than back into the queue',
    stranded: false,
  };
}

/**
 * The one thing about the evidence worth a clause in a reason line.
 *
 * Only that this account has more than one status comment on the issue, which
 * happens when an edit was refused once and this tool posted its own rather
 * than lose a status. Silent otherwise: with one comment there is nothing to
 * disambiguate, and a clause printed every time is one a reader learns to skip.
 */
function evidenceNote(age: ClaimAge): string {
  if (age.candidates <= 1) return '';
  return (
    ' (' +
    countOf(age.candidates, 'status comment', 'status comments') +
    ' of this run’s account on the issue; the newest is the evidence)'
  );
}

/**
 * How old the evidence is, named for what it actually came from.
 *
 * The whole of the fix for a line that read "its last heartbeat was 1085h 08m
 * ago" about an issue no runner of this account had ever beaten on: the figure
 * came from `issue.updated_at` and was printed with the word that belongs to a
 * heartbeat. A number is only as good as the noun in front of it, and a
 * maintainer deciding whether a runner died reads the noun.
 */
function ageClause(age: ClaimAge): string {
  if (age.ageMs === undefined) return 'nothing on it carries a time to measure from';
  const ago = durationText(age.ageMs) + ' ago';
  switch (age.from) {
    case 'marker':
      return 'its last heartbeat was ' + ago;
    case 'comment':
      return (
        'its status comment was last edited ' + ago + ', and its marker carries no heartbeat to read'
      );
    default:
      return (
        'the issue itself was last touched ' +
        ago +
        ' (no status comment of this run’s account carries a heartbeat)'
      );
  }
}

/** The same, in the shape the freshness line wants. */
function freshnessClause(age: ClaimAge): string {
  if (age.ageMs === undefined) return 'nothing on it carries a time to measure from';
  const ago = durationText(age.ageMs) + ' ago';
  switch (age.from) {
    case 'marker':
      return 'last heartbeat ' + ago;
    case 'comment':
      return 'status comment last edited ' + ago + ', with no heartbeat in its marker';
    default:
      return 'no status comment of this run’s account is on it, and the issue was last touched ' + ago;
  }
}

/**
 * The marker that was refused, and why, when one was.
 *
 * Said out loud because it is the difference between "nothing here claimed to
 * be alive" and "something here claimed to be alive and was not believed". A
 * decision about somebody else's work that turned on the second must not read
 * like the first.
 */
function disbeliefNote(age: ClaimAge): string {
  const refused = age.disbelieved;
  if (refused === undefined) return '';
  return (
    ' (a status comment claims a heartbeat at ' +
    refused.claimed +
    ', newer than its own last edit at ' +
    refused.edited +
    ' — a heartbeat cannot postdate the comment that carries it, so it is not believed)'
  );
}

/** A status comment somebody else's runner is still beating on. */
interface ForeignClaim {
  /** The heartbeat, clamped to the comment carrying it. */
  at: string;
  ageMs: number;
  /** Who wrote it. Untrusted, and only ever a reason to wait. */
  author: string;
  /** The run it names, when it names one. */
  runId: string | undefined;
}

/**
 * A marker-bearing heartbeat this account did not write, when it is still fresh.
 *
 * **This is the only place a comment from another author is read, and it can
 * only ever withhold a write.** Every decision that *acts* is made on this
 * account's own evidence; this one answers "is somebody else visibly working
 * here?" for a claim this run cannot attribute to itself — an `exolvra:working`
 * label with no status comment of ours under it, which is what two runners
 * under different logins look like to each other.
 *
 * Recovering that would be taking a live claim off another runner, which is
 * exactly what C7's TTL exists *not* to do. So a fresh foreign heartbeat delays,
 * and nothing else: the direction is the module's standing rule, that an
 * unauthenticated comment may make a recovery less likely and never more.
 *
 * The delay is bounded, which is what keeps this from re-admitting the
 * stranding defect. It is scoped to claims that are not ours — a crashed run of
 * *this* account is recovered on its own heartbeat, which nobody else can touch
 * — and the heartbeat is clamped to the comment's own `updated_at`, so a
 * stranger holds an issue only for as long as they keep editing, and never by
 * typing a date. Returning nothing rather than a stale value is deliberate:
 * there is no "the foreign claim is dead" answer for a caller to act on.
 */
function freshForeignClaim(
  thread: IssueThread,
  now: Date,
  ttlMs: number,
  mine: StickySubject,
): ForeignClaim | undefined {
  const slug = repoSlug(mine.repo);
  const login = requireRunnerIdentity(mine.login);
  let best: { at: Date; comment: IssueComment; marker: StickyMarker } | undefined;
  for (const comment of thread.comments) {
    if (comment.author === login) continue;
    const marker = parseStickyMarker(comment.body);
    if (marker === undefined) continue;
    if (marker.repo !== slug || marker.issue !== mine.issue) continue;
    // A marker claiming a heartbeat its own comment cannot have carried is not
    // evidence of a live claim, and so is not a reason to wait for one either:
    // the delay has to cost somebody a real edit, which GitHub timestamps.
    const beat = heartbeatOf(comment, marker);
    if (beat === undefined || !beat.believed) continue;
    if (best === undefined || beat.at.getTime() > best.at.getTime()) {
      best = { at: beat.at, comment, marker };
    }
  }
  if (best === undefined) return undefined;
  const ageMs = now.getTime() - best.at.getTime();
  if (ageMs > ttlMs) return undefined;
  return {
    at: isoSeconds(best.at),
    ageMs,
    author: best.comment.author,
    runId: best.marker.run === '' ? undefined : best.marker.run,
  };
}

/**
 * Takes a stale claim back to ready, and writes the takeover into the sticky.
 *
 * Nothing is written until the age is known, so an issue somebody else is
 * actively working is never touched: the freshness check reads, decides, and
 * answers without a single write. When the claim really is stale the label goes
 * back through ready — the same state a maintainer's own hand would leave it
 * in — and the note goes into the comment that carried the dead heartbeat, so
 * the history of the issue says what happened rather than merely ending.
 *
 * Two things it will recover, and one it will not:
 *
 * - **A stale `working` claim**, which is C7 as written.
 * - **An issue carrying no lifecycle label at all, when this account's own
 *   status comment says it claimed one and has stopped beating.** Nothing in
 *   this module can produce that state — the move adds before it removes — but
 *   a half-applied write, another tool, or a hand can, and an issue with no
 *   label is invisible to every other path, including this one. The sticky
 *   comment is the receipt: it is only ever posted after winning the
 *   compare-and-swap on a `ready` label that a maintainer applied, so putting
 *   `ready` back is restoring what the maintainer granted rather than this tool
 *   granting itself anything (C5). The TTL still has to have passed, because a
 *   run whose label vanished is still a run.
 * - **An issue a maintainer simply un-labelled**, which has no such receipt and
 *   is left exactly as it is.
 *
 * The reclaim does not then claim the issue. Flipping to ready and claiming
 * from ready are two different runners' business, and keeping them apart is
 * what makes the second one race exactly as any other claim does.
 */
export async function reclaimIssue(
  ctx: IssueRunContext,
  options: ReclaimOptions = {},
): Promise<ReclaimOutcome> {
  const who = subjectFor(ctx);
  const ttlMs = options.ttlMs ?? DEFAULT_CLAIM_TTL_MS;
  const thread = await threadFor(ctx, options.thread);
  const ref = issueRef(ctx.repo, thread.issue.number);
  const now = nowOf(ctx);
  const age = claimAge(thread, now, ttlMs, who);
  const existing = findSticky(thread.comments, who);

  const carried = lifecycleOf(thread.issue.labels);
  const plan = recoveryPlan(thread.issue.labels, existing);
  const stranded = plan.stranded;

  if (plan.to === undefined) {
    return {
      reclaimed: false,
      reason: ref + ' ' + plan.why,
      age,
      labels: thread.issue.labels,
    };
  }
  // The TTL applies whatever shape the issue is in. A run whose label went
  // wrong under it is still a run: recovering while its heartbeat is fresh
  // would hand a second runner an issue the first one is working, which is
  // worse than the issue looking wrong until the first one stops beating.
  if (!age.stale) {
    return {
      reclaimed: false,
      reason:
        'the claim on ' +
        ref +
        ' is fresh: ' +
        freshnessClause(age) +
        ', TTL ' +
        durationText(ttlMs) +
        disbeliefNote(age) +
        evidenceNote(age),
      age,
      labels: thread.issue.labels,
    };
  }

  // A claim this run cannot attribute to itself, with somebody else's status
  // comment still beating on it. That is what a second runner under a different
  // login looks like from here, and taking the issue off it is the one thing
  // C7's TTL exists not to do — so the recovery waits, on evidence that can
  // only ever make it wait. See {@link freshForeignClaim}: nothing here acts on
  // a comment this account did not write, and the delay lasts only as long as
  // somebody keeps that comment edited.
  const elsewhere =
    age.candidates === 0 && thread.issue.labels.includes(lifecycleLabel('working'))
      ? freshForeignClaim(thread, now, ttlMs, who)
      : undefined;
  if (elsewhere !== undefined) {
    return {
      reclaimed: false,
      reason:
        'the claim on ' +
        ref +
        ' is not this run’s and is still beating: no status comment of this run’s ' +
        'account is on it, and @' +
        plainText(elsewhere.author) +
        '’s status comment' +
        (elsewhere.runId === undefined ? '' : ' (run ' + plainText(elsewhere.runId) + ')') +
        ' beat ' +
        durationText(elsewhere.ageMs) +
        ' ago, inside the TTL of ' +
        durationText(ttlMs),
      age,
      labels: thread.issue.labels,
    };
  }

  const at = isoSeconds(now);
  const move = await moveLifecycleLabel(ctx, plan.to, carried);
  if (!move.moved) {
    return {
      reclaimed: false,
      reason:
        lifecycleLabel('working') +
        ' had already moved on ' +
        ref +
        '; another runner reclaimed it first',
      age,
      labels: thread.issue.labels,
    };
  }

  // `lastHeartbeat` only when one was read. The fallback time goes in the field
  // that says what it is, because the takeover note is where the person whose
  // issue was taken finds out what the decision rested on.
  const beaten = age.from === 'marker' || age.from === 'comment';
  const takeover: Takeover = {
    at,
    byRun: ctx.runId,
    fromRun: age.runId === undefined || age.runId === '' ? undefined : age.runId,
    ...(beaten ? { lastHeartbeat: age.heartbeat } : { lastTouched: age.heartbeat }),
    ageMs: age.ageMs,
    ttlMs,
    stranded,
  };

  const previous = existing?.marker;
  const state: StickyState = {
    runId: ctx.runId,
    repo: ctx.repo,
    issue: thread.issue.number,
    issueTitle: thread.issue.title,
    issueUrl: thread.issue.url,
    phase: 'reclaimed',
    label: plan.to,
    claimedAt: previous?.claimed !== undefined && previous.claimed !== '' ? previous.claimed : at,
    heartbeat: at,
    budget: { rounds: 0 },
    pieces: [],
    rounds: [],
    transitions: [
      {
        at,
        ...(carried === undefined ? {} : { from: carried }),
        to: plan.to,
        why: stranded
          ? 'the issue was left carrying no lifecycle label; its status comment says it was claimed'
          : plan.to === 'blocked'
            ? 'the claim went stale, and no status comment of this run’s account is on it'
            : 'the claim went stale and was reclaimed',
      },
    ],
    takeovers: [takeover],
    links: {},
    claimTtlMs: ttlMs,
  };

  return {
    reclaimed: true,
    reason:
      'recovered ' +
      ref +
      ' to ' +
      lifecycleLabel(plan.to) +
      ': it ' +
      plan.why +
      ', and ' +
      ageClause(age) +
      ' against a TTL of ' +
      durationText(ttlMs) +
      disbeliefNote(age) +
      evidenceNote(age),
    age,
    labels: move.labels,
    takeover,
    sticky: await publishSticky(ctx, state, existing),
  };
}

/* -------------------------------------------------------------------------- */
/* Triage (R4)                                                                 */
/* -------------------------------------------------------------------------- */

export interface TriageOptions {
  thread?: IssueThread;
  standards?: Standards | null;
}

export interface TriageOutcome {
  triaged: boolean;
  /** One line for a log; nothing here prints it. */
  reason: string;
  spec: DerivedSpec;
  labels: string[];
  snapshot?: SnapshotPin;
  comment?: StickyRef;
}

/**
 * The triage gate: derive a bar, or say exactly what is missing and step aside.
 *
 * The label moves before the comment is posted, which is the one place this
 * departs from the order R4 lists. The reason is C6's: removing ready is the
 * only compare-and-swap there is, so doing it first means two runners meeting
 * on the same underspecified issue produce one comment between them instead of
 * one each. The end state a reader sees is the state R4 describes.
 *
 * The snapshot is written either way. A verdict of "there was nothing here to
 * check" is worth exactly as much as the evidence for it, and the pin is what
 * lets somebody who disagrees read what was actually read.
 */
export async function triageIssue(
  ctx: IssueRunContext,
  options: TriageOptions = {},
): Promise<TriageOutcome> {
  const who = subjectFor(ctx);
  const thread = await threadFor(ctx, options.thread);
  const ref = issueRef(ctx.repo, thread.issue.number);
  const spec = deriveIssueSpec(thread, options.standards ?? null);

  if (spec.runnable) {
    return {
      triaged: false,
      reason:
        'a checkable bar was derived from ' +
        ref +
        ': ' +
        countOf(spec.criteria.length, 'criterion', 'criteria') +
        ' and ' +
        countOf(spec.commands.length, 'command', 'commands'),
      spec,
      labels: thread.issue.labels,
    };
  }

  // The same reading the claim takes: an issue a maintainer re-authorized after
  // a triage is eligible again, and an underspecified one is triaged again.
  const eligible = claimability(thread.issue.labels);
  if (!eligible.ok) {
    return {
      triaged: false,
      reason: ref + ' ' + eligible.why,
      spec,
      labels: thread.issue.labels,
    };
  }

  const at = nowOf(ctx);
  const move = await moveLifecycleLabel(ctx, 'triage', 'ready');
  if (!move.moved) {
    return {
      triaged: false,
      reason:
        lifecycleLabel('ready') + ' had already moved on ' + ref + '; another runner owns it',
      spec,
      labels: thread.issue.labels,
    };
  }

  // The label and the comment are one act. A triage label with no comment
  // under it is the worst of both: the issue is out of the queue and nobody
  // has been told what to add. If the comment cannot be posted the label goes
  // back to ready, and the next pass reads the issue again from scratch.
  let posted: IssueComment;
  let snapshot: SnapshotPin;
  try {
    snapshot = writeIssueSnapshot(ctx.cwd, ctx.runId, ctx.repo, thread, at);
    const body = renderTriageComment({
      repo: ctx.repo,
      issue: thread.issue.number,
      issueUrl: thread.issue.url,
      spec,
      snapshot,
      at: isoSeconds(at),
      body: thread.issue.body,
    });
    const existing = findTriageComment(thread.comments, who);
    let edited: IssueComment | undefined;
    // Only ever this account's own, for the same reason the sticky is:
    // overwriting a comment this run did not write would be safe only because
    // GitHub happens to refuse it.
    if (existing !== undefined) {
      try {
        edited = await ctx.client.updateComment(ctx.repo, existing.id, body);
      } catch (error) {
        // A triage comment this account cannot edit is somebody else's comment
        // wearing the marker. Saying what is missing matters more than saying
        // it in that particular comment, so this run posts its own.
        if (!notOurs(error)) throw error;
      }
    }
    posted = edited ?? (await ctx.client.createComment(ctx.repo, ctx.issue, body));
  } catch (error) {
    try {
      await moveLifecycleLabel(ctx, 'ready', 'triage');
    } catch {
      // The rollback is a courtesy on a path that is already failing; the
      // fault that started it is the one the caller has to see.
    }
    throw error;
  }

  return {
    triaged: true,
    reason:
      'triaged ' +
      ref +
      ': ' +
      spec.missing.map((element) => element.id).join(', ') +
      ' missing',
    spec,
    labels: move.labels,
    snapshot,
    comment: {
      id: posted.id,
      url: posted.url,
      author: posted.author,
      updatedAt: posted.updatedAt,
      body: posted.body,
      marker: undefined,
    },
  };
}
