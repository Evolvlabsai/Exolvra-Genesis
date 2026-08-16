/**
 * The one module that reaches the network.
 *
 * C2 of `docs/specs/issue-runner-spec.md` amends the standing no-network gate
 * deliberately and narrowly: GitHub access uses the platform's built-in fetch,
 * every request goes to the configured GitHub API host, and the gate test in
 * `test/gates.test.js` narrows from "no fetch anywhere in `src/`" to "no fetch
 * outside this file". The boundary is a file, and it is mechanically enforced:
 * if a second module ever grows a request, the suite says so.
 *
 * Four rules shape everything here.
 *
 * - **One host.** The API URL is resolved once, and every URL about to be
 *   requested — the ones built below, the `Link` header a listing pages
 *   through, the `Location` of a redirect — is checked against it first. A
 *   host that was not configured is refused by this module, before any bytes
 *   leave, rather than by whatever is on the other end.
 * - **The token is never said out loud.** It is held in a closure, so it is
 *   not a property `JSON.stringify` or an inspector can reach, and every
 *   string this module puts into a fault goes through {@link redactSecrets}
 *   first — because the host on the other end writes most of those strings,
 *   and it can echo the token back inside one. C12 says secrets never reach an
 *   artifact, and a thrown message becomes an artifact the moment a run
 *   record, a comment or a progress page quotes it.
 * - **What comes back is untrusted.** It is JSON from a remote host: every
 *   field is read defensively, an answer that is not the documented shape is a
 *   fault with a name rather than an `undefined` handed downstream, and every
 *   fragment of it that reaches a message is flattened to one printable line
 *   before it is laid out.
 * - **Nothing is retried, and nothing is printed.** A retry nobody asked for
 *   spends a budget somebody is accountable for (C9), and this module has no
 *   output stream: it answers with values and raises faults, and the command
 *   decides what a person sees.
 *
 * Issue and comment *data* comes back exactly as GitHub sent it, unflattened:
 * R3 pins a sha256 over the snapshot of an issue, so a body this module
 * "tidied" would be a body nobody could verify afterwards. Flattening happens
 * on the way into a message, and nowhere else.
 */
import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { ConfigError } from './exit.js';
import { PROGRAM, plainText, truncate } from './usage.js';

/* -------------------------------------------------------------------------- */
/* Where the API is, and what it is spoken to with                             */
/* -------------------------------------------------------------------------- */

/** github.com's REST API: where a run goes unless it is told otherwise. */
export const DEFAULT_API_URL = 'https://api.github.com';

/**
 * The environment variable that moves the API.
 *
 * GitHub Actions sets it on every runner and GitHub Enterprise Server points it
 * at the appliance, so this is a name a repository already knows. Because it is
 * a URL rather than a hostname, it is also what lets a test point this module
 * at a real local server and drive the real request path against it.
 */
export const API_URL_ENV = 'GITHUB_API_URL';

/** Where the token is read from before `gh auth token` is asked (C2). */
export const TOKEN_ENV = 'GITHUB_TOKEN';

/** The program asked for a token when the environment does not carry one. */
export const GH_COMMAND = 'gh';

/** The REST API version this module is written against. */
export const API_VERSION = '2022-11-28';

const ACCEPT = 'application/vnd.github+json';
const CONTENT_TYPE = 'application/json';

/** How long one request may take before it is abandoned. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** How many pages a listing may walk before it is called a loop. */
export const DEFAULT_MAX_PAGES = 100;

/** How long `gh auth token` may take before it is abandoned. */
const GH_TIMEOUT_MS = 10_000;

/** Items per page: the API's maximum, so a listing is as few requests as it can be. */
const PAGE_SIZE = 100;

/** How many redirects one request may follow, each re-checked against the host. */
const MAX_REDIRECTS = 5;

/** The largest answer that will be read, so a hostile host cannot fill memory. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/**
 * The shortest string that will be accepted as a token.
 *
 * Not a guess at GitHub's format — it is what makes {@link redactSecrets}
 * total. A one-character "token" would turn redaction into a search and replace
 * over every message this module writes, so a value too short to redact safely
 * is refused at the door instead. Real GitHub tokens are forty characters and
 * longer.
 */
const MIN_TOKEN_LENGTH = 8;

/** How much of an untrusted string may reach one line of a message. */
const DETAIL_WIDTH = 200;

/* -------------------------------------------------------------------------- */
/* Keeping the token out of everything                                         */
/* -------------------------------------------------------------------------- */

/**
 * The shapes GitHub issues its tokens in, as a last line of defence.
 *
 * The run's own token is redacted by value; this catches the *other* secrets —
 * a token belonging to some other account echoed back in a response body, one
 * pasted into an issue by a person who should not have. Neither this module nor
 * the run using it can tell those from noise, so they are removed on sight.
 */
const TOKEN_SHAPES =
  /gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{22,}|v[0-9]\.[0-9a-f]{40}/g;

/** What stands in place of a secret. */
export const REDACTED = '[redacted]';

/**
 * A character that is not there when a reader looks at the text.
 *
 * Unicode's format class, which is every one of them: the zero-width space, the
 * zero-width joiner and non-joiner, the word joiner, the soft hyphen, the
 * byte-order mark, and the bidirectional marks and isolates. Named as a class
 * rather than as a list because a list of invisible characters is a list that
 * will be missing one, and the one it is missing is the one somebody uses.
 */
const INVISIBLE = /\p{Cf}/u;

/** The text as it was seen, alongside where each character of it came from. */
interface Folded {
  /** Canonical, with the invisibles gone. Never returned to a caller. */
  text: string;
  /** Where each code unit of {@link text} starts in the original. */
  startAt: number[];
  /** …and where it ends. */
  endAt: number[];
}

/**
 * The text as a reader sees it, with a way back to the text as it was written.
 *
 * Two transformations, both of them things a person reading the string would do
 * without noticing:
 *
 * - **NFKC, one character at a time.** `ｇｈｐ＿` is four fullwidth code points
 *   that a terminal draws as `ghp_` and that any normalising round trip turns
 *   into `ghp_`. A pattern written in ASCII does not match it, and a token
 *   compared by value is not equal to it, so a token typed this way was
 *   invisible to both of the checks below.
 * - **Format characters removed.** A zero-width space in the middle of a token
 *   splits it into two strings, neither of which is the token and only one of
 *   which is long enough to match a pattern — which is how half a secret
 *   reached a published title beside the marker for the other half.
 *
 * The mapping is the point of the whole exercise. Scanning happens over this
 * text; *replacing* happens over the original, at the offsets a match maps back
 * to. Returning the folded text would be a different bug: it would rewrite
 * every legitimate fullwidth title, ligature and soft hyphen in the repository
 * on the way past, and a redactor that edits text containing no secrets is not
 * a redactor.
 */
function fold(text: string): Folded {
  let folded = '';
  const startAt: number[] = [];
  const endAt: number[] = [];
  let at = 0;
  for (const character of text) {
    const next = at + character.length;
    if (!INVISIBLE.test(character)) {
      const canonical = character.normalize('NFKC');
      folded += canonical;
      for (let i = 0; i < canonical.length; i += 1) {
        startAt.push(at);
        endAt.push(next);
      }
    }
    at = next;
  }
  return { text: folded, startAt, endAt };
}

/** One stretch of the original text that a secret was found in. */
type Span = [start: number, end: number];

/** Overlapping and touching spans joined, so nothing is marked twice. */
function merge(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Span[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Removes secrets from text about to be shown, stored, or thrown.
 *
 * Exported because C12 is wider than this module: anything that shows, stores
 * or sends on text that came out of a repository — a listing, a page, a
 * comment, a run record — has to remove secrets the same way rather than each
 * surface inventing a rule. Every one of those surfaces is cured or broken
 * together, which is the reason there is one of these and not seven.
 *
 * Two ways a secret is recognised, and both of them look at the text as a
 * reader sees it (see {@link fold}) rather than as it was typed. The known
 * secret is matched by value rather than by pattern — a token is not a regular
 * expression, and treating one as a pattern would either miss it or match half
 * the message — and the shapes above catch the ones this run was never told
 * about. What comes back is the text exactly as it arrived, with only the
 * stretches a secret was found in replaced.
 */
export function redactSecrets(text: string, secret?: string): string {
  const seen = fold(text);
  const spans: Span[] = [];

  /** A match in the folded text, as the stretch of original it came from. */
  const found = (start: number, end: number): void => {
    const from = seen.startAt[start];
    const to = seen.endAt[end - 1];
    if (end > start && from !== undefined && to !== undefined) spans.push([from, to]);
  };

  if (secret !== undefined && secret.length >= MIN_TOKEN_LENGTH) {
    // Folded the same way, so a secret that itself arrived decorated still
    // matches the decorated copy of it in the text.
    const needle = fold(secret).text;
    // A "secret" that folds away to nothing is not one, and searching for the
    // empty string finds it everywhere and never advances.
    for (let at = needle === '' ? -1 : seen.text.indexOf(needle); at !== -1; ) {
      found(at, at + needle.length);
      at = seen.text.indexOf(needle, at + needle.length);
    }
  }
  for (const match of seen.text.matchAll(TOKEN_SHAPES)) {
    if (match.index !== undefined) found(match.index, match.index + match[0].length);
  }
  if (spans.length === 0) return text;

  let out = '';
  let at = 0;
  for (const [start, end] of merge(spans)) {
    out += text.slice(at, start) + REDACTED;
    at = end;
  }
  return out + text.slice(at);
}

/* -------------------------------------------------------------------------- */
/* Repositories                                                                */
/* -------------------------------------------------------------------------- */

/** One repository, already checked. */
export interface Repo {
  readonly owner: string;
  readonly name: string;
}

/** `owner/name`, the way GitHub and this tool's flags both spell it. */
export function repoSlug(repo: Repo): string {
  return repo.owner + '/' + repo.name;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_OWNER = 39;
const MAX_NAME = 100;

/**
 * Why `text` is not a repository, or `undefined` when it is one.
 *
 * A describer rather than a thrower, so a flag validator can reach the same
 * judgement this module reaches and report it as a usage error with a usage
 * line, while a value that arrived some other way is refused here.
 *
 * The rule is deliberately tighter than "no slashes": what a repository name
 * becomes is two path segments of a URL, and `..` in a path segment is a
 * request for a different endpoint. Those segments are percent-encoded when the
 * URL is built as well — one of the two is the control and the other is the
 * proof, and which is which should never have to be worked out under pressure.
 */
export function repoFault(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return 'it is empty';
  if (trimmed !== text) return 'it has whitespace around it';
  const parts = trimmed.split('/');
  if (parts.length !== 2) {
    return parts.length < 2 ? 'it has no owner' : 'it has more than one slash';
  }
  const [owner, name] = parts;
  if (owner === undefined || owner === '') return 'the owner is empty';
  if (name === undefined || name === '') return 'the name is empty';
  if (!SEGMENT.test(owner)) return 'the owner has a character GitHub does not allow';
  if (!SEGMENT.test(name)) return 'the name has a character GitHub does not allow';
  if (name === '.' || name === '..') return 'the name is a path, not a repository';
  if (owner.length > MAX_OWNER) return 'the owner is longer than ' + MAX_OWNER + ' characters';
  if (name.length > MAX_NAME) return 'the name is longer than ' + MAX_NAME + ' characters';
  return undefined;
}

/** `owner/name` as a {@link Repo}, or a raised fault saying why it is not one. */
export function parseRepo(text: string): Repo {
  const why = repoFault(text);
  if (why !== undefined) {
    throw new ConfigError(
      [
        '"' + detail(text) + '" is not a repository',
        '  ' + why,
        '  a repository is written owner/name, as in cli/cli',
      ].join('\n'),
    );
  }
  const parts = text.split('/');
  return { owner: parts[0] ?? '', name: parts[1] ?? '' };
}

/* -------------------------------------------------------------------------- */
/* What comes back                                                             */
/* -------------------------------------------------------------------------- */

/** One issue, in this tool's terms rather than the API's. */
export interface Issue {
  number: number;
  title: string;
  /** As GitHub stores it: never flattened, because R3 pins a hash over it. */
  body: string;
  state: string;
  labels: string[];
  /** GitHub's own placeholder for a deleted account is `ghost`. */
  author: string;
  createdAt: string;
  updatedAt: string;
  /** The page a person would open. */
  url: string;
  commentCount: number;
  /**
   * Whether this "issue" is really a pull request.
   *
   * The issues endpoint answers with both, which is why every listing here
   * filters on this field. A runner that took a pull request for an issue would
   * claim it, label it, and open a pull request about a pull request.
   */
  isPullRequest: boolean;
}

/** One comment on an issue. */
export interface IssueComment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

/** An issue and its comments: everything R3 snapshots. */
export interface IssueThread {
  issue: Issue;
  comments: IssueComment[];
}

/** What a repository says about itself. */
export interface RepoInfo {
  owner: string;
  name: string;
  /** The branch a pull request targets (R9), and one C4 forbids pushing to. */
  defaultBranch: string;
  isPrivate: boolean;
  url: string;
}

/** One pull request. */
export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  /** The branch the change is on. */
  head: string;
  /** The branch it would merge into. */
  base: string;
  url: string;
}

/** A pull request to open: R9 for a win, R10 as a draft for blocked work. */
export interface NewPullRequest {
  title: string;
  head: string;
  base: string;
  body: string;
  draft?: boolean;
}

/**
 * What to change about a pull request that is already open.
 *
 * Both fields are optional and only what is given is sent, because a field
 * left out of the request is a field GitHub leaves alone — a run replacing the
 * body must not blank the title on its way past. Neither may be given as
 * empty: an edit that erases what is there is a bug in the caller far more
 * often than it is an intention, and `{}` asks for nothing at all. What
 * *nothing to change* looks like is a caller that does not call this.
 */
export interface PullRequestEdit {
  title?: string;
  /** The whole body, replacing what is there. */
  body?: string;
}

/** Which issues to list. */
export interface IssueQuery {
  /** Every label an issue must carry to be listed. */
  labels?: readonly string[];
  state?: 'open' | 'closed' | 'all';
  sort?: 'created' | 'updated' | 'comments';
  /** R1 works the oldest first, which is `asc` — the default here. */
  direction?: 'asc' | 'desc';
}

/** Which pull requests to list. */
export interface PullRequestQuery {
  state?: 'open' | 'closed' | 'all';
  /** `owner:branch`, the way the API spells a head reference. */
  head?: string;
  base?: string;
}

/** Who this token is, when GitHub would say. */
export interface KnownIdentity {
  known: true;
  /**
   * Exactly what `user.login` carries on a comment this token wrote.
   *
   * Not a display name and not an id: the whole point of asking is to compare
   * it against the author of a comment, so it is stored in the spelling that
   * comparison uses. An installation token writes as `<app-slug>[bot]`, and
   * that suffix is part of the login here for the same reason.
   */
  login: string;
  /** `app` when the login is a bot login — an installation or app token. */
  kind: 'user' | 'app';
}

/**
 * Whether asking again could answer differently.
 *
 * The distinction a caller has to make, made once and here rather than by each
 * caller re-deriving it from prose or from a status code:
 *
 * - `refused` — GitHub was asked and the answer was no. A GitHub App
 *   installation token is refused `GET /user` outright, a rejected token is
 *   rejected, an answer naming nobody names nobody. Retrying changes nothing,
 *   so the invocation has to: this is a configuration fault in the existing
 *   sense, and the exit code for one is right.
 * - `transient` — nobody said no. The question could not be put, or could not
 *   be answered just now: a rate limit, a 5xx, a timeout, a connection that
 *   was not made. Nothing in the invocation is wrong, so nothing the operator
 *   could retype would help, and reporting it as a configuration fault tells
 *   somebody to go and fix a file that is already correct.
 */
export type IdentityCause = 'refused' | 'transient';

/** Who this token is, when GitHub would not say. */
export interface UnknownIdentity {
  known: false;
  /**
   * Which kind of "no" this was — see {@link IdentityCause}.
   *
   * Without it the two are one answer, and a caller that must exit on the first
   * has no way not to exit on the second. A GitHub outage is not a fault in
   * somebody's workflow file.
   */
  cause: IdentityCause;
  /**
   * Why it could not be determined: one flattened line, already redacted.
   *
   * It is shown to a person: inside the refusal that stops a `refused` run
   * before it writes anything, or inside whatever a caller reports for a
   * `transient` one. A resolvable identity is a precondition for writing, so a
   * run that has none — and no `--runner-login <login>` or
   * `EXOLVRA_GENESIS_RUNNER_LOGIN` naming the account instead — does not get to
   * write. {@link UnknownIdentity.cause} says which of the two situations it
   * is; this says what happened, in words, because naming the login is the
   * right answer to a GitHub App token that GitHub refuses `GET /user` to and
   * the wrong answer to a token that expired overnight. It is never the empty
   * string: a refusal that cannot say why is one nobody can act on.
   */
  reason: string;
}

/**
 * Who the token is, or an explicit statement that this could not be found out.
 *
 * A union rather than a login-or-empty-string. The two answers lead to two
 * different places — one is compared against the author of every status comment
 * the run has to recognise as its own, the other is a run that may not write
 * until somebody with repository access names the account — and a value that
 * can be silently empty collapses them into the first, comparing against
 * nothing and matching nobody.
 */
export type GitHubIdentity = KnownIdentity | UnknownIdentity;

/* -------------------------------------------------------------------------- */
/* Faults                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What kind of fault a GitHub call ran into.
 *
 * The kind is a field rather than a turn of phrase, because a caller has to be
 * able to act on it: a rate limit, a repository this token cannot see, and a
 * token GitHub rejected outright are three different situations, and only one
 * of them is worth trying again later. Reading that distinction back out of a
 * sentence would be a parser over this module's own prose.
 */
export type GitHubFaultKind =
  /** The token was rejected, or does not carry the scope the call needs. */
  | 'auth'
  /** The API asked for a wait. */
  | 'rate-limit'
  /** No such thing — or nothing this token is allowed to see. */
  | 'not-found'
  /** This module declined to make the request at all. */
  | 'refused'
  /** No answer arrived: no connection, no route, no reply in time. */
  | 'unreachable'
  /** An answer arrived that was not the documented shape. */
  | 'malformed'
  /** Any other status the API answered with. */
  | 'http';

/**
 * A GitHub call that did not come back with what was asked for.
 *
 * It extends {@link ConfigError} on purpose. The alternative is the
 * unclassified kind, and this CLI reports one of those as a bug in itself with
 * a link to its issue tracker — the wrong thing to say to somebody whose
 * repository name has a typo in it, or whose token expired overnight. As a
 * configuration fault it prints in the house shape, a complaint with indented
 * detail under it, and carries the code R11 gives configuration and
 * authentication faults. What a caller that catches one instead makes of it is
 * that caller's business — which is what {@link GitHubFaultKind} is for, and
 * why the kind is a field on the error rather than a turn of phrase inside it.
 */
export class GitHubError extends ConfigError {
  readonly kind: GitHubFaultKind;
  /** The HTTP status, or `undefined` when no answer arrived. */
  readonly status: number | undefined;
  /** What was being attempted, in words, e.g. `list issues in cli/cli`. */
  readonly operation: string;
  /** When the rate limit lifts: for `rate-limit`, and nothing else. */
  readonly resetAt: Date | undefined;
  /**
   * What GitHub itself said about the failure, already redacted and flattened;
   * `undefined` when there was nothing to hear.
   *
   * A field because a caller that wants GitHub's own words should not have to
   * parse them back out of this module's prose — and because a caller that
   * repeats them is repeating a remote host's text, which is exactly why what
   * lands here has been through {@link redactSecrets} already.
   */
  readonly said: string | undefined;

  constructor(init: {
    message: string;
    kind: GitHubFaultKind;
    operation: string;
    status?: number;
    resetAt?: Date;
    said?: string;
  }) {
    super(init.message);
    this.name = 'GitHubError';
    this.kind = init.kind;
    this.operation = init.operation;
    this.status = init.status;
    this.resetAt = init.resetAt;
    this.said = init.said;
  }
}

/** What a fault is about, before its lines are written. */
interface FaultSubject {
  kind: GitHubFaultKind;
  operation: string;
  complaint: string;
  status?: number;
  resetAt?: Date;
  said?: string;
}

/** One line of untrusted text, safe to lay out: flattened, and cut to a width. */
function detail(text: string, redact: (value: string) => string = redactSecrets): string {
  return truncate(plainText(redact(text)), DETAIL_WIDTH);
}

/** A fault in the house shape: the complaint, then the detail under it. */
function fault(subject: FaultSubject, lines: readonly string[]): GitHubError {
  return new GitHubError({
    kind: subject.kind,
    operation: subject.operation,
    status: subject.status,
    resetAt: subject.resetAt,
    said: subject.said,
    message: [subject.complaint, ...lines.map((line) => '  ' + line)].join('\n'),
  });
}

/* -------------------------------------------------------------------------- */
/* The host allowlist                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Whether a hostname is this machine.
 *
 * The only place plain HTTP is allowed. A token that crosses a network in the
 * clear has been given away, and loopback is not a network — which is also what
 * lets a test point this module at a real local server and exercise the real
 * request path instead of a stand-in for it.
 */
function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** Raises in an expression position, so each check below reads as one line. */
function raise(error: Error): never {
  throw error;
}

function apiUrlFault(source: string, value: string, reason: string): ConfigError {
  return new ConfigError(
    [
      'the GitHub API URL is not one this run can use',
      '  ' + source + ': ' + detail(value),
      '  ' + reason,
      '  it must be an https URL, or http on this machine (127.0.0.1, ::1, localhost)',
    ].join('\n'),
  );
}

/**
 * `value` as a normalised API base URL, or a raised fault saying why it is not
 * one.
 *
 * Normalised means no trailing slash, no query, no fragment, and no user
 * information: a URL carrying `user:password@` would put credentials into every
 * message this module ever names a URL in.
 */
function checkApiUrl(value: string, source: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return raise(apiUrlFault(source, value, 'it is not a URL'));
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return raise(
      apiUrlFault(source, value, 'its scheme is ' + url.protocol.replace(':', '')),
    );
  }
  if (url.hostname === '') return raise(apiUrlFault(source, value, 'it has no host'));
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    return raise(
      apiUrlFault(source, value, 'http would send the token across a network in the clear'),
    );
  }
  if (url.username !== '' || url.password !== '') {
    return raise(apiUrlFault(source, value, 'it carries user information'));
  }
  if (url.search !== '' || url.hash !== '') {
    return raise(apiUrlFault(source, value, 'it carries a query or a fragment'));
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/**
 * The API base URL for this run: the explicit one, else the environment's, else
 * github.com.
 */
export function resolveApiUrl(
  options: { apiUrl?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const given = options.apiUrl?.trim();
  if (given !== undefined && given !== '') {
    return checkApiUrl(given, 'the API URL this run was given');
  }
  const env = options.env ?? process.env;
  const fromEnv = env[API_URL_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return checkApiUrl(fromEnv, API_URL_ENV);
  return DEFAULT_API_URL;
}

/**
 * `candidate` as a URL this run is allowed to request, or a raised refusal.
 *
 * Every URL passes through here — the ones built from a path below, the `Link`
 * header a listing pages through, the `Location` of a redirect. The last two
 * are written by the host on the other end, which is exactly why the check is
 * on the URL about to be requested rather than on the URL this module composed.
 */
export function requireAllowedUrl(
  candidate: string,
  apiUrl: string,
  operation: string,
  redact: (value: string) => string = redactSecrets,
): URL {
  const refuse = (reason: string): never =>
    raise(
      fault(
        {
          kind: 'refused',
          operation,
          complaint: 'refusing to send a GitHub request to another host',
        },
        [
          'while trying to ' + operation,
          'the GitHub API this run is configured for is ' + detail(apiUrl, redact),
          reason,
          'every GitHub call goes to the configured host and nowhere else',
        ],
      ),
    );

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return refuse(
      'the request would have gone to ' + detail(candidate, redact) + ', which is not a URL',
    );
  }
  if (url.origin !== new URL(apiUrl).origin) {
    return refuse('the request would have gone to ' + detail(url.toString(), redact));
  }
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    return refuse('the request would have gone over http to ' + detail(url.host, redact));
  }
  return url;
}

/* -------------------------------------------------------------------------- */
/* The token                                                                   */
/* -------------------------------------------------------------------------- */

/** A token, and where it came from — which is what an auth failure has to say. */
export interface TokenSource {
  readonly token: string;
  readonly from: 'env' | 'gh' | 'given';
}

/** How a source is named in a sentence. */
function nameOf(from: TokenSource['from']): string {
  if (from === 'env') return TOKEN_ENV;
  if (from === 'gh') return '`' + GH_COMMAND + ' auth token`';
  return 'this run';
}

/** A control character, which a header value may never carry. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Refuses a token this module could not keep out of its own messages.
 *
 * The value is never named in the fault. Everything a person needs in order to
 * fix it — where it came from, and what is wrong with the shape — is here
 * without it.
 */
function checkToken(value: string, source: string): string {
  const complain = (reason: string): never =>
    raise(
      new ConfigError(
        [
          'the GitHub token from ' + source + ' is not usable',
          '  ' + reason,
          '  set ' + TOKEN_ENV + ', or run `' + GH_COMMAND + ' auth login` and try again',
        ].join('\n'),
      ),
    );
  if (/\s/.test(value)) return complain('it has whitespace in it, so it is not one token');
  if (CONTROL.test(value)) return complain('it has a control character in it');
  if (value.length < MIN_TOKEN_LENGTH) {
    return complain('it is shorter than ' + MIN_TOKEN_LENGTH + ' characters');
  }
  return value;
}

/**
 * A system variable out of an environment, whatever case it is written in.
 *
 * Windows treats environment names as case-insensitive, so the same variable
 * arrives as `Path`, `PATH` or `path` and as `ComSpec` or `COMSPEC` depending
 * on which shell exported it. `process.env` hides that; a plain object handed
 * in as {@link GitHubClientOptions.env} does not. Only the platform's own
 * variables are read this way — `GITHUB_TOKEN` is matched exactly, because on
 * Linux `github_token` is a different variable and must not stand in for it.
 */
function systemVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** Where an executable really is, searched the way the platform searches. */
function findExecutable(program: string, env: NodeJS.ProcessEnv): string | undefined {
  const windows = process.platform === 'win32';
  const search = systemVar(env, 'PATH') ?? '';
  const extensions = windows
    ? (systemVar(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter((ext) => ext !== '')
    : [''];
  for (const dir of search.split(delimiter)) {
    if (dir === '') continue;
    for (const extension of extensions) {
      const candidate = join(dir, program + extension);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!windows) accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not there, or not runnable: keep looking.
      }
    }
  }
  return undefined;
}

/**
 * Windows' command interpreter, by absolute path.
 *
 * The environment handed in may carry a PATH that no longer includes the system
 * directory, and the interpreter must not become whichever `cmd.exe` that PATH
 * happens to find first.
 */
function commandInterpreter(env: NodeJS.ProcessEnv): string {
  return (
    systemVar(env, 'ComSpec') ??
    join(systemVar(env, 'SystemRoot') ?? 'C:\\Windows', 'System32', 'cmd.exe')
  );
}

/** What `gh auth token` answered, or why it did not answer. */
interface GhAnswer {
  token: string | undefined;
  /** How the attempt ended, as a phrase that follows the command's name. */
  ending: string;
}

/**
 * Asks the GitHub CLI for the token it is signed in with.
 *
 * The program is located before it is started, rather than handed to a shell.
 * On Windows the CLI is often installed as a `.cmd` shim, which the process
 * spawner will not start on its own because it is a script and not a program,
 * so the command interpreter is named explicitly for that one case — with a
 * command line built entirely from constants in this file and a quoted path
 * this module resolved itself. No value from a repository, an issue, a comment
 * or a flag is anywhere near it.
 */
function ghAuthToken(env: NodeJS.ProcessEnv): GhAnswer {
  const program = findExecutable(GH_COMMAND, env);
  if (program === undefined) return { token: undefined, ending: 'was not found on PATH' };

  const lower = program.toLowerCase();
  const script = lower.endsWith('.cmd') || lower.endsWith('.bat');
  const shared: SpawnSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    env,
    // Nothing is read from this process: `gh` prompting for input would
    // otherwise wait for a person who is not there.
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GH_TIMEOUT_MS,
    windowsHide: true,
  };
  const result = script
    ? spawnSync(commandInterpreter(env), ['/d', '/s', '/c', '"' + program + '" auth token'], {
        ...shared,
        windowsVerbatimArguments: true,
      })
    : spawnSync(program, ['auth', 'token'], shared);

  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      token: undefined,
      ending: 'could not be run: ' + detail(code ?? result.error.message),
    };
  }
  if (result.signal !== null && result.signal !== undefined) {
    return { token: undefined, ending: 'was stopped by ' + detail(result.signal) };
  }
  if (result.status === null) return { token: undefined, ending: 'did not finish' };
  if (result.status !== 0) {
    const complaint = detail((result.stderr ?? '').split('\n')[0] ?? '');
    return {
      token: undefined,
      ending: 'exited ' + result.status + (complaint === '' ? '' : ': ' + complaint),
    };
  }
  const printed = ((result.stdout ?? '').split('\n')[0] ?? '').trim();
  if (printed === '') return { token: undefined, ending: 'printed nothing' };
  return { token: printed, ending: 'answered' };
}

/**
 * The token this run will use: the environment's, else the GitHub CLI's, else a
 * raised fault that names both (C2).
 */
export function resolveToken(options: { env?: NodeJS.ProcessEnv } = {}): TokenSource {
  const env = options.env ?? process.env;
  const fromEnv = env[TOKEN_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return { token: checkToken(fromEnv.trim(), TOKEN_ENV), from: 'env' };
  }
  const gh = ghAuthToken(env);
  if (gh.token !== undefined) {
    return { token: checkToken(gh.token, '`' + GH_COMMAND + ' auth token`'), from: 'gh' };
  }
  throw new ConfigError(
    [
      'no GitHub token is available',
      '  ' + TOKEN_ENV + (fromEnv === undefined ? ' is not set' : ' is set but empty'),
      '  `' + GH_COMMAND + ' auth token` ' + gh.ending,
      '  set ' + TOKEN_ENV + ', or run `' + GH_COMMAND + ' auth login` so it can answer',
    ].join('\n'),
  );
}

/* -------------------------------------------------------------------------- */
/* Reading an answer                                                           */
/* -------------------------------------------------------------------------- */

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A login, or the name GitHub itself shows for an account that is gone. */
function loginOf(value: unknown): string {
  return str(asObject(value)?.['login']) ?? 'ghost';
}

/** Label names, whether the API sent objects or bare strings. */
function labelsOf(value: unknown): string[] {
  const names: string[] = [];
  for (const item of asArray(value) ?? []) {
    const name = str(item) ?? str(asObject(item)?.['name']);
    if (name !== undefined) names.push(name);
  }
  return names;
}

/* -------------------------------------------------------------------------- */
/* The client                                                                  */
/* -------------------------------------------------------------------------- */

/** Everything the runner asks GitHub for. */
export interface GitHubClient {
  /** The API this client talks to, normalised. Never carries a token. */
  readonly apiUrl: string;
  /** Where the token came from, for a person reading an authentication fault. */
  readonly tokenSource: TokenSource['from'];

  /**
   * Who this token is, as a comment would show it.
   *
   * Asked once and remembered for the life of the client: it is a property of
   * the token, not of the call, and a runner comparing it against every comment
   * on every round must not pay a request for each comparison.
   *
   * It does not raise. What a GitHub that will not name this token means is the
   * caller's decision and not this module's — a surface that writes needs the
   * identity, and a read-only one does not — so every failure comes back as
   * {@link UnknownIdentity}, carrying both the reason in words and
   * {@link IdentityCause}, which says whether asking again could answer
   * differently. The class travels with the answer because the caller cannot
   * recover it afterwards: a rate limit and a GitHub App refused `GET /user`
   * are the same shape and opposite decisions. Nothing is hidden by any of it —
   * the same fault is raised in full, in the house shape, by the very next call
   * that actually needs an answer.
   */
  whoAmI(): Promise<GitHubIdentity>;

  getRepo(repo: Repo): Promise<RepoInfo>;
  /** The branches GitHub reports protected — the ones C4 forbids pushing to. */
  listProtectedBranches(repo: Repo): Promise<string[]>;

  listIssues(repo: Repo, query?: IssueQuery): Promise<Issue[]>;
  getIssue(repo: Repo, number: number): Promise<Issue>;
  listIssueComments(repo: Repo, number: number): Promise<IssueComment[]>;
  /** An issue and its comments: what R3 snapshots and pins. */
  getIssueThread(repo: Repo, number: number): Promise<IssueThread>;

  /** Adds labels and answers with every label the issue carries afterwards. */
  addLabels(repo: Repo, number: number, labels: readonly string[]): Promise<string[]>;
  /** Answers `false` when the label was not on the issue to begin with. */
  removeLabel(repo: Repo, number: number, label: string): Promise<boolean>;

  createComment(repo: Repo, number: number, body: string): Promise<IssueComment>;
  /** Edits a comment in place — R6's sticky comment, never a second one. */
  updateComment(repo: Repo, commentId: number, body: string): Promise<IssueComment>;

  createPullRequest(repo: Repo, input: NewPullRequest): Promise<PullRequest>;
  /**
   * Edits a pull request that is already open.
   *
   * R9 says the body carries *this* run's evidence — the verdict history, the
   * attestations, the budget consumed. A second run over the same issue finds
   * the branch and the pull request already there and reuses them, so without
   * this the pull request would keep describing the run before it.
   */
  updatePullRequest(
    repo: Repo,
    number: number,
    edit: PullRequestEdit,
  ): Promise<PullRequest>;
  listPullRequests(repo: Repo, query?: PullRequestQuery): Promise<PullRequest[]>;
}

export interface GitHubClientOptions {
  /** A token to use as given. Otherwise {@link resolveToken} finds one. */
  token?: string;
  /** The API base URL. Otherwise {@link resolveApiUrl} finds one. */
  apiUrl?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxPages?: number;
}

/** One request this module is about to make. */
interface RequestSpec {
  /** What is being attempted, in words, for the fault if it fails. */
  operation: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** An absolute API path, its segments already encoded. */
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Statuses that are an answer here rather than a fault. */
  tolerate?: readonly number[];
}

/** What an answer amounted to. */
interface Reply {
  status: number;
  url: URL;
  headers: Headers;
  /** The parsed body, or `undefined` when there was none. */
  json: unknown;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Builds a client.
 *
 * The token is resolved here, once, so a run without one fails before it claims
 * an issue rather than halfway through working it — and it is held in this
 * closure rather than on the object, where `JSON.stringify`, a run record or an
 * inspector would find it.
 */
export function createGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  const env = options.env ?? process.env;
  const source: TokenSource =
    options.token === undefined
      ? resolveToken({ env })
      : { token: checkToken(options.token, 'this run'), from: 'given' };
  const token = source.token;
  const apiUrl = resolveApiUrl({ apiUrl: options.apiUrl, env });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  /**
   * The identity question, asked at most once.
   *
   * The promise is what is kept, not the value: two callers that ask before the
   * first answer arrives share the one request rather than racing two.
   */
  let asking: Promise<GitHubIdentity> | undefined;

  /** Every untrusted string reaches a message through here. */
  const clean = (text: string): string => detail(text, (value) => redactSecrets(value, token));

  const allowed = (candidate: string, operation: string): URL =>
    requireAllowedUrl(candidate, apiUrl, operation, (value) => redactSecrets(value, token));

  /* ---------------------------------------------------------------------- */
  /* One request                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * A call that never came back, whichever half of it stalled.
   *
   * `reading` is the half that is easy to forget. A host can send its headers
   * promptly and then stop, and the request's own deadline fires while the body
   * is being read rather than while the connection is being made — the
   * commonest real blip after a 5xx. That rejection arrives from
   * `response.text()` rather than from `fetch`, and left uncaught it reaches
   * the terminal as `The operation was aborted due to timeout` under this CLI's
   * "unexpected error, please report it" banner: three untrue sentences about a
   * deadline this module set itself. It is a fault with a name, like every
   * other one here.
   */
  function unreachable(
    operation: string,
    url: URL,
    error: unknown,
    phase: 'asking' | 'reading' = 'asking',
  ): GitHubError {
    const named = error instanceof Error ? error : undefined;
    const cause = (error as { cause?: unknown } | null | undefined)?.cause;
    const because = cause instanceof Error ? cause.message : undefined;
    const timedOut = named?.name === 'TimeoutError' || named?.name === 'AbortError';
    // In the unit the number was set in: a deadline under a second reported as
    // "0s" would be this module misquoting its own limit.
    const seconds =
      timeoutMs < 1000 ? timeoutMs + 'ms' : Math.round(timeoutMs / 1000) + 's';
    return fault(
      { kind: 'unreachable', operation, complaint: 'could not reach GitHub to ' + operation },
      [
        clean(url.toString()),
        timedOut
          ? phase === 'reading'
            ? 'the answer began and then stopped; the rest of it never arrived within ' +
              seconds
            : 'nothing answered within ' + seconds
          : clean(because ?? named?.message ?? String(error)),
        'the GitHub API this run is configured for is ' + clean(apiUrl),
      ],
    );
  }

  async function call(url: URL, spec: RequestSpec): Promise<Response> {
    const headers: Record<string, string> = {
      accept: ACCEPT,
      authorization: 'Bearer ' + token,
      'user-agent': PROGRAM,
      'x-github-api-version': API_VERSION,
    };
    const body = spec.body === undefined ? undefined : JSON.stringify(spec.body);
    if (body !== undefined) headers['content-type'] = CONTENT_TYPE;
    try {
      return await fetch(url, {
        method: spec.method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw unreachable(spec.operation, url, error);
    }
  }

  /** The body as text, refusing an answer too large to hold. */
  async function bodyText(url: URL, response: Response, spec: RequestSpec): Promise<string> {
    const oversize = (size: string): GitHubError =>
      fault(
        {
          kind: 'malformed',
          operation: spec.operation,
          status: response.status,
          complaint: 'could not ' + spec.operation,
        },
        [
          spec.method + ' ' + clean(url.toString()) + ' answered with ' + size,
          'more than ' + MAX_BODY_BYTES + ' bytes is not an answer this reads',
        ],
      );

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      throw oversize(declared + ' bytes');
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // The deadline can fall here as easily as on the connection: headers
      // arrived, the body did not, and the abort surfaces on this read.
      throw unreachable(spec.operation, url, error, 'reading');
    }
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
      throw oversize('more bytes than it said it would');
    }
    return text;
  }

  /** What GitHub said about a failure, out of the body it sent. */
  function said(json: unknown, text: string): string | undefined {
    const message = str(asObject(json)?.['message']);
    if (message !== undefined && message.trim() !== '') return clean(message);
    const line = text.trim().split('\n')[0]?.trim();
    return line === undefined || line === '' ? undefined : clean(line);
  }

  /** The `errors` a 422 carries, which is where its real reason lives. */
  function validationLines(json: unknown): string[] {
    const lines: string[] = [];
    for (const item of (asArray(asObject(json)?.['errors']) ?? []).slice(0, 3)) {
      const object = asObject(item);
      const field = str(object?.['field']);
      const message =
        str(object?.['message']) ??
        (field === undefined ? undefined : field + ': ' + (str(object?.['code']) ?? 'invalid'));
      if (message !== undefined) lines.push(clean(message));
    }
    return lines;
  }

  /**
   * The documentation link, when what came back really is GitHub's.
   *
   * The body is written by whatever answered, so a link out of it is a link
   * this tool would be recommending on a stranger's behalf. Only the
   * documentation site is repeated.
   */
  function docsLine(json: unknown): string[] {
    const url = str(asObject(json)?.['documentation_url']);
    return url !== undefined && url.startsWith('https://docs.github.com/')
      ? ['see ' + clean(url)]
      : [];
  }

  /**
   * When the rate limit lifts, if the headers say so credibly.
   *
   * A header that is absent, blank, or not a plain count of seconds answers
   * nothing rather than a time: reading a missing header as zero would have
   * every rate limit lift exactly now, which is the one answer that is always
   * wrong.
   */
  function resetFrom(headers: Headers): Date | undefined {
    const seconds = (name: string): number | undefined => {
      const raw = headers.get(name)?.trim();
      return raw !== undefined && /^\d{1,12}$/.test(raw) ? Number(raw) : undefined;
    };
    // `retry-after` first, because it is the specific instruction and
    // `x-ratelimit-reset` is on nearly every answer. A secondary limit says
    // "wait sixty seconds" while the hourly window it did not exhaust still
    // ends fifty minutes out; reading the window would tell somebody to wait
    // fifty times too long for a throttle that is already over.
    const retry = seconds('retry-after');
    if (retry !== undefined && retry < 86_400) return new Date(Date.now() + retry * 1000);
    const reset = seconds('x-ratelimit-reset');
    if (reset !== undefined && reset > 0 && reset < 4_102_444_800) {
      return new Date(reset * 1000);
    }
    return undefined;
  }

  /**
   * Whether a 403 is the API asking for a wait rather than refusing the token.
   *
   * GitHub has two rate limits and they do not look alike. The **primary** one
   * spends a quota: `x-ratelimit-remaining` reaches `0` and the answer is a 403.
   * The **secondary** one throttles a burst — too many writes too quickly, which
   * is exactly what a scheduled pass over several issues produces — and it comes
   * back as a 403 with a `retry-after` header and a primary quota that is *not*
   * spent. Recognising only the first classed the second as an authorisation
   * failure and told somebody to go and check the `repo` scope on a token whose
   * scopes were never the problem.
   *
   * Three signals, any of which is enough, in the order they are trustworthy: a
   * 429 is a wait by definition; a spent quota or a `retry-after` is GitHub
   * saying so in a header; and GitHub's own sentence says "rate limit" in both
   * kinds. A genuine refusal carries none of them and stays an authorisation
   * fault.
   */
  function rateLimited(status: number, headers: Headers, heard: string | undefined): boolean {
    if (status === 429) return true;
    if (status !== 403) return false;
    if (headers.get('x-ratelimit-remaining')?.trim() === '0') return true;
    if (headers.get('retry-after') !== null) return true;
    return heard !== undefined && /\brate limit\b/i.test(heard);
  }

  function httpFault(
    url: URL,
    response: Response,
    json: unknown,
    text: string,
    spec: RequestSpec,
  ): GitHubError {
    const status = response.status;
    const reason = response.statusText === '' ? '' : ' ' + clean(response.statusText);
    const first = spec.method + ' ' + clean(url.toString()) + ' answered ' + status + reason;
    const heard = said(json, text);
    const heardLines = heard === undefined ? [] : ['GitHub said: ' + heard];
    const from = 'the token came from ' + nameOf(source.from);

    if (rateLimited(status, response.headers, heard)) {
      const at = resetFrom(response.headers);
      return fault(
        {
          kind: 'rate-limit',
          operation: spec.operation,
          status,
          resetAt: at,
          said: heard,
          complaint: 'GitHub rate-limited this run while trying to ' + spec.operation,
        },
        [
          first,
          ...heardLines,
          at === undefined
            ? 'the answer did not say when the limit lifts'
            : 'the limit lifts at ' + isoSeconds(at) + ' (in ' + until(at) + ')',
        ],
      );
    }

    if (status === 401) {
      return fault(
        {
          kind: 'auth',
          operation: spec.operation,
          status,
          said: heard,
          complaint: 'GitHub rejected the token while trying to ' + spec.operation,
        },
        [
          first,
          ...heardLines,
          from,
          'it may have expired or been revoked; `' +
            GH_COMMAND +
            ' auth login` issues a new one',
        ],
      );
    }

    if (status === 403) {
      return fault(
        {
          kind: 'auth',
          operation: spec.operation,
          status,
          said: heard,
          complaint: 'GitHub refused the token while trying to ' + spec.operation,
        },
        [
          first,
          ...heardLines,
          from,
          'reading a private repository needs the `repo` scope, and so do labels,',
          'comments and pull requests; `public_repo` covers a public repository',
          ...docsLine(json),
        ],
      );
    }

    if (status === 404) {
      return fault(
        {
          kind: 'not-found',
          operation: spec.operation,
          status,
          said: heard,
          complaint: 'could not ' + spec.operation,
        },
        [
          first,
          ...heardLines,
          'a repository the token cannot see answers 404 exactly as a missing one does',
          from,
        ],
      );
    }

    return fault(
      {
        kind: 'http',
        operation: spec.operation,
        status,
        said: heard,
        complaint: 'could not ' + spec.operation,
      },
      [
        first,
        ...heardLines,
        ...validationLines(json),
        ...(status >= 500 ? ['this is GitHub’s side of the call; nothing here retried it'] : []),
        ...docsLine(json),
      ],
    );
  }

  /** Sends one request, following only redirects that stay on the host. */
  async function send(start: URL, spec: RequestSpec): Promise<Reply> {
    let url = start;
    for (let hop = 0; ; hop += 1) {
      const response = await call(url, spec);

      if (!REDIRECT_STATUS.has(response.status)) {
        const text = await bodyText(url, response, spec);
        let json: unknown;
        let readable = true;
        try {
          json = text.trim() === '' ? undefined : JSON.parse(text);
        } catch {
          readable = false;
        }
        const tolerated = (spec.tolerate ?? []).includes(response.status);
        if (!response.ok && !tolerated) throw httpFault(url, response, json, text, spec);
        if (!readable && response.ok) {
          throw fault(
            {
              kind: 'malformed',
              operation: spec.operation,
              status: response.status,
              complaint: 'could not read what GitHub answered when asked to ' + spec.operation,
            },
            [
              spec.method + ' ' + clean(url.toString()) + ' answered ' + response.status,
              'the body is not JSON: ' + clean(text.trim().split('\n')[0] ?? ''),
            ],
          );
        }
        return { status: response.status, url, headers: response.headers, json };
      }

      // A redirect. Only a read is followed: turning a POST into a GET at a new
      // address would quietly make a different request than the caller asked
      // for, and following it as a POST would repeat a write somewhere else.
      const location = response.headers.get('location');
      if (spec.method !== 'GET' || location === null || hop >= MAX_REDIRECTS) {
        throw fault(
          {
            kind: 'http',
            operation: spec.operation,
            status: response.status,
            complaint: 'could not ' + spec.operation,
          },
          [
            spec.method + ' ' + clean(url.toString()) + ' answered ' + response.status,
            location === null
              ? 'a redirect with no location is not somewhere to go'
              : hop >= MAX_REDIRECTS
                ? 'more than ' + MAX_REDIRECTS + ' redirects is a loop, not a route'
                : 'a ' + spec.method + ' is not followed to another address',
          ],
        );
      }
      url = allowed(new URL(location, url).toString(), spec.operation);
    }
  }

  function urlFor(spec: RequestSpec): URL {
    const url = new URL(apiUrl + spec.path);
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    return allowed(url.toString(), spec.operation);
  }

  const request = (spec: RequestSpec): Promise<Reply> => send(urlFor(spec), spec);

  /** The `next` page a listing points at, when it points at one. */
  function nextPage(headers: Headers): string | undefined {
    const link = headers.get('link');
    if (link === null) return undefined;
    for (const piece of link.split(',')) {
      const match = piece.match(/^\s*<([^>]+)>\s*;\s*(.+)$/);
      if (match === null) continue;
      const [, href, parameters] = match;
      if (href !== undefined && parameters !== undefined && /rel="?next"?/.test(parameters)) {
        return href;
      }
    }
    return undefined;
  }

  /** Walks every page of a listing, checking each `next` against the host. */
  async function paginate(spec: RequestSpec): Promise<unknown[]> {
    const items: unknown[] = [];
    let url = urlFor(spec);
    for (let page = 1; ; page += 1) {
      const reply = await send(url, spec);
      const batch = asArray(reply.json);
      if (batch === undefined) {
        throw fault(
          {
            kind: 'malformed',
            operation: spec.operation,
            status: reply.status,
            complaint: 'could not read what GitHub answered when asked to ' + spec.operation,
          },
          [
            spec.method + ' ' + clean(reply.url.toString()) + ' answered ' + reply.status,
            'a listing is a JSON array, and this answer is not one',
          ],
        );
      }
      items.push(...batch);

      const next = nextPage(reply.headers);
      if (next === undefined) return items;
      if (page >= maxPages) {
        throw fault(
          { kind: 'http', operation: spec.operation, complaint: 'could not ' + spec.operation },
          [
            'GitHub is still offering pages after ' + maxPages,
            'a listing that never ends is not read to the end',
          ],
        );
      }
      url = allowed(new URL(next, reply.url).toString(), spec.operation);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Turning answers into values                                             */
  /* ---------------------------------------------------------------------- */

  function malformed(operation: string, missing: string): GitHubError {
    return fault(
      {
        kind: 'malformed',
        operation,
        complaint: 'could not read what GitHub answered when asked to ' + operation,
      },
      ['the answer has no ' + missing, 'this reads the REST API version ' + API_VERSION],
    );
  }

  function toIssue(value: unknown, operation: string): Issue {
    const object = asObject(value);
    const number = num(object?.['number']);
    if (object === undefined || number === undefined) throw malformed(operation, 'issue number');
    return {
      number,
      title: str(object['title']) ?? '',
      body: str(object['body']) ?? '',
      state: str(object['state']) ?? '',
      labels: labelsOf(object['labels']),
      author: loginOf(object['user']),
      createdAt: str(object['created_at']) ?? '',
      updatedAt: str(object['updated_at']) ?? '',
      url: str(object['html_url']) ?? '',
      commentCount: num(object['comments']) ?? 0,
      isPullRequest: asObject(object['pull_request']) !== undefined,
    };
  }

  function toComment(value: unknown, operation: string): IssueComment {
    const object = asObject(value);
    const id = num(object?.['id']);
    if (object === undefined || id === undefined) throw malformed(operation, 'comment id');
    return {
      id,
      body: str(object['body']) ?? '',
      author: loginOf(object['user']),
      createdAt: str(object['created_at']) ?? '',
      updatedAt: str(object['updated_at']) ?? '',
      url: str(object['html_url']) ?? '',
    };
  }

  function toPullRequest(value: unknown, operation: string): PullRequest {
    const object = asObject(value);
    const number = num(object?.['number']);
    if (object === undefined || number === undefined) {
      throw malformed(operation, 'pull request number');
    }
    return {
      number,
      title: str(object['title']) ?? '',
      body: str(object['body']) ?? '',
      state: str(object['state']) ?? '',
      draft: object['draft'] === true,
      head: str(asObject(object['head'])?.['ref']) ?? '',
      base: str(asObject(object['base'])?.['ref']) ?? '',
      url: str(object['html_url']) ?? '',
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Who this token is                                                       */
  /* ---------------------------------------------------------------------- */

  /** A bot's login as a comment carries it: the slug, with the suffix on it. */
  const botLogin = (name: string): string =>
    name.endsWith('[bot]') ? name : name + '[bot]';

  /**
   * A login as an account name is allowed to be: letters, digits and hyphens,
   * never starting or ending with one, and never longer than GitHub allows.
   *
   * An app slug is drawn from the same alphabet, so one shape covers both.
   */
  const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

  /**
   * A login off the wire, or `undefined` when what came back is not a login.
   *
   * The two steps are in this order on purpose. It is *cleaned first* — the
   * same redaction and flattening every other string derived from an answer
   * goes through — so a host that answers `{"login": "<the token>"}` has
   * already had the token replaced before anything looks at the value; and it
   * is *bounded second*, so what survives is something a login could actually
   * be. `[redacted]` is not a login, which is what makes those two steps
   * together a refusal rather than a laundering: the value cannot come back as
   * the token, and it cannot come back as the redaction marker either.
   */
  function readLogin(value: unknown): { base: string; bot: boolean } | undefined {
    const raw = str(value);
    if (raw === undefined) return undefined;
    const cleaned = clean(raw).trim();
    const bot = cleaned.endsWith('[bot]');
    const base = bot ? cleaned.slice(0, -'[bot]'.length) : cleaned;
    return LOGIN.test(base) ? { base, bot } : undefined;
  }

  /**
   * What `GET /user` amounts to, across the shapes different tokens produce.
   *
   * A personal access token or a user-to-server token answers with a user, and
   * `login` is the whole answer. A GitHub App token answers differently: some
   * answer as the bot, whose `type` is `Bot` and whose login GitHub sometimes
   * writes with the `[bot]` suffix and sometimes without, and some answer with
   * the app's own record, which carries `slug` and no login at all. What a
   * comment shows as its author is the suffixed form in every one of those
   * cases, so that is what is stored — the caller compares, it does not guess.
   *
   * An answer with nothing usable in it is {@link UnknownIdentity}, never a
   * known identity holding whatever arrived. A run comparing comment authors
   * against a value that is not a login is worse off than one that knows it has
   * no identity: the first matches nobody — or worse, the wrong body — and
   * writes anyway; the second does not start until somebody with repository
   * access names the account.
   */
  function readIdentity(value: unknown): GitHubIdentity {
    const object = asObject(value);
    const login = readLogin(object?.['login']);
    if (login !== undefined) {
      return login.bot || object?.['type'] === 'Bot'
        ? { known: true, login: botLogin(login.base), kind: 'app' }
        : { known: true, login: login.base, kind: 'user' };
    }
    const slug = readLogin(object?.['slug']);
    if (slug !== undefined) return { known: true, login: botLogin(slug.base), kind: 'app' };

    // Nothing there at all, or something there that is not a name. The two read
    // differently to somebody debugging, and neither one repeats the value:
    // whatever arrived is the very thing that could not be trusted.
    const offered = str(object?.['login']) ?? str(object?.['slug']);
    return {
      known: false,
      // GitHub was asked and answered; the answer simply named nobody. Asking
      // again gets the same answer, so this is the permanent kind.
      cause: 'refused',
      reason:
        offered === undefined || offered.trim() === ''
          ? 'GitHub answered without a login, so this token has no name to compare against'
          : 'GitHub answered with something that is not a login, so there is nothing safe to compare against',
    };
  }

  /**
   * Which kind of "no" a fault on the identity call amounts to.
   *
   * A rate limit lifts, a 5xx passes, and a connection that was not made can be
   * made later — none of those is somebody's workflow file being wrong. A
   * refusal, a rejection, and a 4xx that is not either of those are answers
   * GitHub will keep giving, and the invocation is what has to change.
   */
  function causeOf(error: GitHubError): IdentityCause {
    if (error.kind === 'rate-limit' || error.kind === 'unreachable') return 'transient';
    return error.status !== undefined && error.status >= 500 ? 'transient' : 'refused';
  }

  /**
   * A fault as the one line a refusal can quote.
   *
   * The complaint, the status when there was one, and GitHub's own words when
   * it said any — all of which have already been redacted and flattened on
   * their way onto the error. The rest of the fault's detail is guidance about
   * scopes and retries, which is the right thing to print when a call failed
   * and the wrong thing to print inside a refusal that carries its own remedy:
   * name the account with `--runner-login <login>`, or set
   * `EXOLVRA_GENESIS_RUNNER_LOGIN`.
   */
  function whyUnknown(error: GitHubError): string {
    const complaint = error.message.split('\n')[0] ?? 'GitHub would not name this token';
    const answered = error.status === undefined ? '' : ' (' + error.status + ')';
    const heard = error.said === undefined ? '' : ': ' + error.said;
    return complaint + answered + heard;
  }

  async function askWhoAmI(): Promise<GitHubIdentity> {
    const operation = 'ask who this token is';
    try {
      const reply = await request({ operation, method: 'GET', path: '/user' });
      return readIdentity(reply.json);
    } catch (error) {
      // Only a fault this module classified. Anything else is a bug in here,
      // and a bug in here is not an answer about somebody's token.
      if (error instanceof GitHubError) {
        return {
          known: false,
          cause: causeOf(error),
          reason: plainText(redactSecrets(whyUnknown(error), token)),
        };
      }
      throw error;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Arguments this module will not send                                     */
  /* ---------------------------------------------------------------------- */

  function refuse(operation: string, reason: string): never {
    return raise(
      fault(
        { kind: 'refused', operation, complaint: 'refusing to ' + operation },
        [reason, 'the request was not made'],
      ),
    );
  }

  function requireNumber(value: number, operation: string, what: string): void {
    if (!Number.isInteger(value) || value <= 0) {
      refuse(operation, 'the ' + what + ' is ' + clean(String(value)) + ', which is not one');
    }
  }

  function requireText(value: string, operation: string, what: string): void {
    if (value.trim() === '') refuse(operation, 'the ' + what + ' is empty');
  }

  /** A repository path, with every segment encoded before it is a path at all. */
  function repoPath(repo: Repo, rest = ''): string {
    return (
      '/repos/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.name) + rest
    );
  }

  const issuePath = (repo: Repo, number: number, rest = ''): string =>
    repoPath(repo, '/issues/' + encodeURIComponent(String(number)) + rest);

  /* ---------------------------------------------------------------------- */
  /* The operations                                                          */
  /* ---------------------------------------------------------------------- */

  return {
    apiUrl,
    tokenSource: source.from,

    whoAmI(): Promise<GitHubIdentity> {
      asking ??= askWhoAmI();
      return asking;
    },

    async getRepo(repo: Repo): Promise<RepoInfo> {
      const operation = 'read ' + repoSlug(repo);
      const reply = await request({ operation, method: 'GET', path: repoPath(repo) });
      const object = asObject(reply.json);
      const defaultBranch = str(object?.['default_branch']);
      if (object === undefined || defaultBranch === undefined) {
        throw malformed(operation, 'default branch');
      }
      return {
        owner: str(asObject(object['owner'])?.['login']) ?? repo.owner,
        name: str(object['name']) ?? repo.name,
        defaultBranch,
        isPrivate: object['private'] === true,
        url: str(object['html_url']) ?? '',
      };
    },

    async listProtectedBranches(repo: Repo): Promise<string[]> {
      const operation = 'list the protected branches of ' + repoSlug(repo);
      const items = await paginate({
        operation,
        method: 'GET',
        path: repoPath(repo, '/branches'),
        query: { protected: 'true', per_page: PAGE_SIZE },
      });
      const names: string[] = [];
      for (const item of items) {
        const name = str(asObject(item)?.['name']);
        if (name === undefined) throw malformed(operation, 'branch name');
        names.push(name);
      }
      return names;
    },

    async listIssues(repo: Repo, query: IssueQuery = {}): Promise<Issue[]> {
      const labels = (query.labels ?? []).filter((label) => label.trim() !== '');
      const operation =
        'list issues' +
        (labels.length === 0 ? '' : ' labelled ' + labels.join(', ')) +
        ' in ' +
        repoSlug(repo);
      const items = await paginate({
        operation,
        method: 'GET',
        path: repoPath(repo, '/issues'),
        query: {
          labels: labels.length === 0 ? undefined : labels.join(','),
          state: query.state ?? 'open',
          sort: query.sort ?? 'created',
          direction: query.direction ?? 'asc',
          per_page: PAGE_SIZE,
        },
      });
      // The issues endpoint answers with pull requests as well, and a pull
      // request is not an issue this runner may claim.
      return items
        .map((item) => toIssue(item, operation))
        .filter((issue) => !issue.isPullRequest);
    },

    async getIssue(repo: Repo, number: number): Promise<Issue> {
      const operation = 'read issue #' + number + ' in ' + repoSlug(repo);
      requireNumber(number, operation, 'issue number');
      const reply = await request({
        operation,
        method: 'GET',
        path: issuePath(repo, number),
      });
      return toIssue(reply.json, operation);
    },

    async listIssueComments(repo: Repo, number: number): Promise<IssueComment[]> {
      const operation = 'read the comments on issue #' + number + ' in ' + repoSlug(repo);
      requireNumber(number, operation, 'issue number');
      const items = await paginate({
        operation,
        method: 'GET',
        path: issuePath(repo, number, '/comments'),
        query: { per_page: PAGE_SIZE },
      });
      return items.map((item) => toComment(item, operation));
    },

    async getIssueThread(repo: Repo, number: number): Promise<IssueThread> {
      const issue = await this.getIssue(repo, number);
      const comments = await this.listIssueComments(repo, number);
      return { issue, comments };
    },

    async addLabels(repo: Repo, number: number, labels: readonly string[]): Promise<string[]> {
      const operation =
        'label issue #' + number + ' in ' + repoSlug(repo) + ' with ' + labels.join(', ');
      requireNumber(number, operation, 'issue number');
      if (labels.length === 0) refuse(operation, 'no labels were given');
      for (const label of labels) requireText(label, operation, 'label');
      const reply = await request({
        operation,
        method: 'POST',
        path: issuePath(repo, number, '/labels'),
        body: { labels: [...labels] },
      });
      if (asArray(reply.json) === undefined) throw malformed(operation, 'list of labels');
      return labelsOf(reply.json);
    },

    async removeLabel(repo: Repo, number: number, label: string): Promise<boolean> {
      const operation =
        'remove the label ' + label + ' from issue #' + number + ' in ' + repoSlug(repo);
      requireNumber(number, operation, 'issue number');
      requireText(label, operation, 'label');
      const reply = await request({
        operation,
        method: 'DELETE',
        path: issuePath(repo, number, '/labels/' + encodeURIComponent(label)),
        // A label that is not there is the state this asked for rather than a
        // fault: C6 has to tell "it moved" from "it would not move".
        tolerate: [404],
      });
      return reply.status !== 404;
    },

    async createComment(repo: Repo, number: number, body: string): Promise<IssueComment> {
      const operation = 'comment on issue #' + number + ' in ' + repoSlug(repo);
      requireNumber(number, operation, 'issue number');
      requireText(body, operation, 'comment body');
      const reply = await request({
        operation,
        method: 'POST',
        path: issuePath(repo, number, '/comments'),
        body: { body },
      });
      return toComment(reply.json, operation);
    },

    async updateComment(repo: Repo, commentId: number, body: string): Promise<IssueComment> {
      const operation = 'edit comment ' + commentId + ' in ' + repoSlug(repo);
      requireNumber(commentId, operation, 'comment id');
      requireText(body, operation, 'comment body');
      const reply = await request({
        operation,
        method: 'PATCH',
        path: repoPath(repo, '/issues/comments/' + encodeURIComponent(String(commentId))),
        body: { body },
      });
      return toComment(reply.json, operation);
    },

    async createPullRequest(repo: Repo, input: NewPullRequest): Promise<PullRequest> {
      const operation =
        'open a pull request from ' +
        input.head +
        ' into ' +
        input.base +
        ' in ' +
        repoSlug(repo);
      requireText(input.title, operation, 'title');
      requireText(input.head, operation, 'head branch');
      requireText(input.base, operation, 'base branch');
      const reply = await request({
        operation,
        method: 'POST',
        path: repoPath(repo, '/pulls'),
        body: {
          title: input.title,
          head: input.head,
          base: input.base,
          body: input.body,
          draft: input.draft === true,
        },
      });
      return toPullRequest(reply.json, operation);
    },

    async updatePullRequest(
      repo: Repo,
      number: number,
      edit: PullRequestEdit,
    ): Promise<PullRequest> {
      const operation = 'update pull request #' + number + ' in ' + repoSlug(repo);
      requireNumber(number, operation, 'pull request number');
      if (edit.title === undefined && edit.body === undefined) {
        refuse(operation, 'neither a title nor a body was given');
      }
      if (edit.title !== undefined) requireText(edit.title, operation, 'title');
      if (edit.body !== undefined) requireText(edit.body, operation, 'body');
      const reply = await request({
        operation,
        method: 'PATCH',
        path: repoPath(repo, '/pulls/' + encodeURIComponent(String(number))),
        // Only what was asked for. A key that is absent here is a field GitHub
        // leaves as it found it, which is what makes a body-only edit safe.
        body: {
          ...(edit.title === undefined ? {} : { title: edit.title }),
          ...(edit.body === undefined ? {} : { body: edit.body }),
        },
      });
      return toPullRequest(reply.json, operation);
    },

    async listPullRequests(repo: Repo, query: PullRequestQuery = {}): Promise<PullRequest[]> {
      const operation = 'list pull requests in ' + repoSlug(repo);
      const items = await paginate({
        operation,
        method: 'GET',
        path: repoPath(repo, '/pulls'),
        query: {
          state: query.state ?? 'open',
          head: query.head,
          base: query.base,
          per_page: PAGE_SIZE,
        },
      });
      return items.map((item) => toPullRequest(item, operation));
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Times, as a person reads them                                               */
/* -------------------------------------------------------------------------- */

/** `2026-08-14T18:30:00Z`: UTC, to the second, as every timestamp here reads. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** How long until `date`, as `2h 05m`, `14m 12s`, or `9s`. */
export function until(date: Date, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((date.getTime() - now.getTime()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  if (hours > 0) return hours + 'h ' + pad(minutes) + 'm';
  if (minutes > 0) return minutes + 'm ' + pad(rest) + 's';
  return rest + 's';
}
