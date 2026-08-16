/**
 * The pull request one issue's work arrives as: the title above it, and the
 * body under it.
 *
 * R9 says what a winning pull request has to carry — the issue link, the bar
 * summary, the verdict history, the integrity attestations, the budget — and
 * R10 says a blocked or budget-stopped run opens the same thing as a draft with
 * the reason on it. The bar for both is a real merged Dependabot body, and what
 * that body actually does is worth stating, because it is what this file is
 * shaped by:
 *
 * - **Evidence first.** The opening lines say what changed and how it was
 *   judged. Nothing greets the reader, nothing apologises, and nothing explains
 *   what a pull request is.
 * - **The same shape every time.** The summary, the table, the folded blocks
 *   and the closing note are in this order whether the run took one round or
 *   forty, and whether it won or stopped. A reviewer who has read one of these
 *   has read all of them, which is the whole value of a machine writing them.
 * - **Bulk folds, and does not disappear.** Forty rounds of verdicts, a list of
 *   changed files and the attestations all go inside `<details>`, so the body
 *   is short on the screen and complete on the page.
 *
 * Two rules this file does not get to relax. Everything derived from an issue
 * is untrusted (C5) and reaches the page through `src/issue-run.ts`'s own
 * chokepoints — {@link safeInline} for a cell, {@link safeFenced} for a block —
 * so a title cannot open a code span that swallows the table and a body cannot
 * forge one of the runner's hidden markers. And nothing shaped like a
 * credential is ever republished (C12): a pull request body is about as public
 * as an artifact gets.
 *
 * Nothing here reads a file, makes a request, or knows what a run is. It turns
 * a record into markdown, which is what makes it something a test can put beside
 * the bar and read.
 */
import { issueRef } from './allowlist.js';
import { formatUsd } from './budget.js';
import type { RunStatus, Verdict } from './events.js';
import { type Repo, redactSecrets } from './github.js';
import { safeFenced, safeInline, shortSha } from './issue-run.js';
import { PROGRAM, displayWidth, plainText, truncate } from './usage.js';

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The longest pull request title this writes.
 *
 * GitHub accepts 256 characters; the margin leaves room for the issue number
 * this always ends with, so the number is never the thing that gets cut off.
 */
export const MAX_TITLE = 200;

/**
 * The largest body this will send.
 *
 * GitHub accepts 65536 characters. The margin is what keeps a body that grew
 * one round too long from being refused by the API at the very end of a run
 * that otherwise succeeded.
 */
export const BODY_LIMIT = 60_000;

/** How many rounds the verdict table spells out before the rest are counted. */
const ROUNDS_SHOWN = 40;

/** How many changed files are listed before the rest are counted. */
const FILES_SHOWN = 60;

/** How wide one cell of the table may be. */
const CELL = 88;

/* -------------------------------------------------------------------------- */
/* What a body is rendered from                                                */
/* -------------------------------------------------------------------------- */

/** One judged round, as the verdict history shows it. */
export interface PullRequestRound {
  /** The Task Spec the round judged, as the run reported it. */
  piece: string;
  number: number;
  verdict: Verdict;
  /** The critic's gap, in their own words; empty on a win. */
  gap?: string;
}

/**
 * One thing that was checked rather than asserted.
 *
 * `ok` is the check's answer, and a failed one is printed as loudly as a passed
 * one: an attestation list that only ever says yes is decoration. `detail`
 * carries the evidence — a hash, a count, a path — because "verified" on its own
 * is a claim and a hash is a thing a reader can go and check.
 */
export interface Attestation {
  name: string;
  detail: string;
  ok: boolean;
}

/** One file the merge would change, as `src/git.ts` reports it. */
export interface ChangedFile {
  /**
   * git's own status letter, in either alphabet it writes them in: the diff's
   * `A`, `M`, `D`, `R100`, or the porcelain column `??`, ` M`, `A `.
   *
   * Carried in git's alphabet and translated on the way onto the page. A status
   * code is a fact about a command's output format, and a reviewer reading a
   * pull request is owed the fact it stands for.
   */
  status: string;
  path: string;
  /** Where a renamed or copied path came from. */
  from?: string;
}

/** What the run spent, against what it was allowed. */
export interface PullRequestBudget {
  rounds: number;
  maxRounds?: number;
  costUsd: number;
  maxCostUsd?: number;
}

/** The account the run wrote as, and how that was settled (addendum v0.1.2). */
export interface PullRequestRunner {
  login: string;
  from: 'token' | 'flag' | 'environment';
}

/** Everything one pull request body is rendered from. */
export interface PullRequestReport {
  repo: Repo;
  issue: number;
  issueTitle: string;
  issueUrl: string;
  /** The issue run's own id, which names its directory under the run store. */
  runId: string;
  /** The id the loop recorded in the run ledger, for `runs` and `resume`. */
  ledgerRunId?: string;
  branch: string;
  branchUrl?: string;
  /** The branch the pull request targets: the repository's default (R9, C4). */
  baseBranch: string;
  /**
   * The head of the branch — the commit a reviewer would be merging.
   *
   * The branch's, not this run's. A branch that was pushed, blocked and picked
   * up again carries every commit of every pass over the issue, and a body that
   * named the last run's commit would be naming less than the merge.
   */
  head?: string;
  /** How the run ended, in the vocabulary the run reports in. */
  outcome: RunStatus;
  /** One line naming what stopped it. Set for everything but a win. */
  reason?: string;
  /** What a human has to settle before this can go anywhere (R10). */
  decision?: string;
  rounds: PullRequestRound[];
  budget: PullRequestBudget;
  attestations: Attestation[];
  /** The pinned issue snapshot the run was judged against (R3, C11). */
  snapshot: { path: string; sha256: string; verified: boolean };
  /** The repository's standing bar, when it has one. */
  standards?: { path: string; sha256: string; gates: number; standingBar: number };
  /** The bar the loop captured for this run, when it left one behind. */
  bar?: { path: string; pins: number };
  runner: PullRequestRunner;
  /**
   * Every file merging this branch would change.
   *
   * The merge's change set, taken from the branch against its base — not what
   * one run left in the work tree. The two are the same thing on a first pass
   * and differ on every one after it, and the second reading is the one a
   * reviewer is deciding on.
   */
  files?: ChangedFile[];
  /**
   * The pull request an earlier pass opened, when this body replaces the one
   * that pass wrote rather than opening a new one.
   *
   * Present only on that path, and carrying exactly what the sentence about it
   * needs: which pull request, and whether it is still a draft. A reviewer
   * looking at a body dated today on a pull request opened last week is owed
   * the explanation without having to reconstruct it from the timeline.
   */
  refreshed?: { number: number; draft: boolean };
  /** The per-run progress page (R7), repo-relative. */
  progressPage?: string;
  /** UTC, to the second. Passed in so a body is a function of its inputs. */
  generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Markdown a machine writes                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A table whose columns are padded, so the body reads as well in its source as
 * it does rendered.
 *
 * Padded by display width rather than by length: a title in Chinese and a title
 * in English of the same length are not the same width, and a column that lines
 * up for one and not the other lines up by luck.
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
 * A URL safe to make clickable, or the text with the link taken off it.
 *
 * Every URL here came out of a JSON body a host wrote, so "it came from GitHub"
 * is a claim rather than a guarantee. A scheme this tool did not expect is shown
 * as text.
 */
function safeUrl(url: string): string {
  const flat = plainText(url);
  return /^https:\/\/[^\s<>()]+$/.test(flat) ? flat : safeInline(flat);
}

/**
 * A value shown as code: a branch, a path, a hash, a login.
 *
 * Markdown inside a code span is inert, so only two characters have to go — the
 * backtick that would close the span early, and the pipe a table reads as a
 * column boundary before it reads anything as a span.
 */
function code(text: string): string {
  const flat = truncate(plainText(redactSecrets(text)), CELL);
  return '`' + flat.replace(/`/g, '').replace(/\|/g, '\\|') + '`';
}

/**
 * The characters that reorder a line without appearing in it.
 *
 * `U+202E` and its relatives make one string render as a different sentence
 * from the one its bytes spell, which is exactly the trick to play on a line a
 * reviewer reads before deciding whether to merge something. Every other
 * surface in this tool removes them; the pull request *title* is the one place
 * where redaction ran and flattening did not, because a title is not markdown
 * and so does not go through the escaping path the body's cells do.
 */
const BIDI_CONTROLS = /\p{Bidi_Control}/gu;

/**
 * Untrusted text as one printable line, with nothing live left in it.
 *
 * The three removals every other surface makes, in the order that makes them
 * total: the credential first and again last — a token split by a character
 * that is not drawn is only a token once that character is gone — the reordering
 * controls in between, and the flattening that leaves one line.
 */
function flatten(text: string): string {
  return redactSecrets(plainText(redactSecrets(text).replace(BIDI_CONTROLS, ''))).trim();
}

/** `1 round` / `4 rounds`, so no line ever reads "1 rounds". */
function countOf(count: number, one: string, many: string): string {
  return count + ' ' + (count === 1 ? one : many);
}

/** The bold key and the value under it, the shape the status comment uses. */
function fact(key: string, value: string): string {
  return '- **' + key + '** — ' + value;
}

/* -------------------------------------------------------------------------- */
/* The title                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The pull request's title: the issue's own, with the issue number after it.
 *
 * The issue's words rather than a sentence about the run, because the title is
 * what a reviewer reads in a list of twenty and the run is what the body is
 * for. The number is appended rather than prefixed so the words come first, and
 * it is the one part never cut.
 */
export function pullRequestTitle(report: PullRequestReport): string {
  const suffix = ' (#' + report.issue + ')';
  const written = flatten(report.issueTitle);
  const words = written === '' ? 'an issue with no title' : written;
  return truncate(words, MAX_TITLE - suffix.length) + suffix;
}

/* -------------------------------------------------------------------------- */
/* The body                                                                    */
/* -------------------------------------------------------------------------- */

/** The verb the opening line uses, per outcome. */
const OPENING: Readonly<Record<RunStatus, string>> = Object.freeze({
  win: 'Works',
  loss: 'Stopped on',
  blocked: 'Stopped on',
  stopped: 'Stopped on',
});

/** The word the table's result row carries. */
const RESULT: Readonly<Record<RunStatus, string>> = Object.freeze({
  win: '**WIN**',
  loss: '**LOSS**',
  blocked: '**BLOCKED**',
  stopped: '**STOPPED**',
});

function verdictText(verdict: Verdict): string {
  return '**' + verdict + '**';
}

function budgetRounds(budget: PullRequestBudget): string {
  return budget.maxRounds === undefined
    ? countOf(budget.rounds, 'round', 'rounds')
    : budget.rounds + ' of ' + countOf(budget.maxRounds, 'round', 'rounds');
}

function budgetCost(budget: PullRequestBudget): string {
  const spent = formatUsd(budget.costUsd);
  return budget.maxCostUsd === undefined
    ? spent
    : spent + ' of ' + formatUsd(budget.maxCostUsd);
}

/** The last verdict a round actually carried, when any round was judged. */
function lastVerdict(rounds: readonly PullRequestRound[]): PullRequestRound | undefined {
  return rounds[rounds.length - 1];
}

function summaryLine(report: PullRequestReport): string {
  const ref = issueRef(report.repo, report.issue);
  return (
    OPENING[report.outcome] +
    ' ' +
    link(code(ref), report.issueUrl) +
    ' — ' +
    safeInline(report.issueTitle, 96) +
    '.'
  );
}

/** `round 4 of 12`, or the phrase for a run that judged nothing at all. */
function roundReached(budget: PullRequestBudget): string {
  if (budget.rounds === 0) return 'before a round was judged';
  const of = budget.maxRounds === undefined ? '' : ' of ' + budget.maxRounds;
  return 'at round ' + budget.rounds + of;
}

function verdictSentence(report: PullRequestReport): string {
  const budget = report.budget;
  const at = roundReached(budget);
  if (report.outcome === 'win') {
    return (
      'Won the blind comparison ' +
      at +
      ', for ' +
      budgetCost(budget) +
      '. Nothing here merges, approves or closes anything: the merge decision is ' +
      'a human’s, and this is what there is to decide it on.'
    );
  }
  return (
    (report.reason === undefined || report.reason.trim() === ''
      ? 'The run did not reach the win condition'
      : safeInline(report.reason, 240)) +
    '. It stopped ' +
    at +
    ', for ' +
    budgetCost(budget) +
    '. The branch is pushed and this is a draft, so nothing that was built is ' +
    'lost while a human settles it.'
  );
}

function statusRows(report: PullRequestReport): string[][] {
  const ref = issueRef(report.repo, report.issue);
  const last = lastVerdict(report.rounds);
  const rows: string[][] = [
    ['Issue', link(code(ref), report.issueUrl) + ' — ' + safeInline(report.issueTitle, 64)],
    [
      'Branch',
      link(code(report.branch), report.branchUrl) + ' → ' + code(report.baseBranch),
    ],
    [
      'Result',
      RESULT[report.outcome] +
        (last === undefined
          ? ' — no round was judged'
          : ' — last verdict ' +
            verdictText(last.verdict) +
            ', on ' +
            safeInline(last.piece, 24) +
            ' round ' +
            last.number),
    ],
    // Scoped in as many words. The two rows above describe the merge — every
    // commit on the branch, however many passes put them there — and these two
    // describe the run that wrote this body. Leaving a reader to work out which
    // is which is how a body comes to be read as claiming more than it knows.
    ['Rounds', budgetRounds(report.budget) + ', this run'],
    ['Cost', budgetCost(report.budget) + ', this run'],
    [
      'Spec',
      code(report.snapshot.path) +
        ' · ' +
        code('sha256:' + shortSha(report.snapshot.sha256)) +
        (report.snapshot.verified ? '' : ' — **it no longer verifies**'),
    ],
  ];

  rows.push([
    'Standards',
    report.standards === undefined
      ? 'this repository declares none'
      : code(report.standards.path) +
        ' · ' +
        code('sha256:' + shortSha(report.standards.sha256)) +
        ' — ' +
        countOf(report.standards.gates, 'gate', 'gates') +
        ', ' +
        countOf(report.standards.standingBar, 'standing bar entry', 'standing bar entries'),
  ]);

  // Always a row, even when there is nothing to put in it. Every one of these
  // is a fact a reviewer may want, and a table whose rows come and go is one
  // where a missing row reads as an oversight rather than as an answer.
  rows.push([
    'Bar',
    report.bar === undefined
      ? 'the run left none pinned in this checkout'
      : code(report.bar.path) +
        ' — ' +
        countOf(report.bar.pins, 'artifact pinned by sha256', 'artifacts pinned by sha256'),
  ]);

  if (report.head !== undefined && report.head !== '') {
    rows.push(['Head', code(report.head) + ' — the commit this would merge']);
  }

  rows.push([
    'Runner',
    code('@' + report.runner.login) +
      ' — ' +
      (report.runner.from === 'token'
        ? 'the account GitHub says the token is'
        : report.runner.from === 'flag'
          ? 'named on the command line, because GitHub would not name the token'
          : 'named by the environment, because GitHub would not name the token'),
  ]);

  rows.push([
    'Run',
    code(report.runId) +
      (report.ledgerRunId === undefined || report.ledgerRunId === ''
        ? ''
        : ' · ledger ' + code(report.ledgerRunId)) +
      (report.progressPage === undefined ? '' : ' · ' + code(report.progressPage)),
  ]);

  return rows;
}

/**
 * Why a body dated today sits on a pull request opened days ago.
 *
 * A second pass over one issue reuses the branch and the pull request on it —
 * one issue, one branch, one pull request (C4) — and replaces this body rather
 * than opening a second one beside the first. That is invisible from the page
 * unless it is said, and a reviewer who cannot tell a refreshed body from a new
 * pull request cannot tell how much of what they are reading is current.
 *
 * The title is not touched, and the sentence says so. It is the issue's own
 * title, which the body carries anyway — and a maintainer may have edited it
 * while reading the draft, which is not a thing to overwrite on the way past.
 */
function refreshedBlock(report: PullRequestReport): string[] {
  const from = report.refreshed;
  if (from === undefined) return [];
  const stillDraft =
    from.draft && report.outcome === 'win'
      ? ' It is still a draft, because that is how the earlier pass opened it: marking one ' +
        'ready for review is a decision, and this makes none.'
      : '';
  // `#502` and not a link built here. GitHub resolves a bare reference against
  // the repository the body is in, and a URL composed by rewriting another one
  // is a guess about somebody else's address space.
  return [
    'Refreshed rather than reopened. #' +
      from.number +
      ' was opened by an earlier pass over this issue; everything below is this ' +
      'run’s, and the title is left as it was.' +
      stillDraft,
  ];
}

function decisionBlock(report: PullRequestReport): string[] {
  if (report.outcome === 'win') return [];
  const decision = report.decision ?? '';
  if (decision.trim() === '') return [];
  return ['**What a human has to decide** — ' + safeInline(decision, 400)];
}

function roundsBlock(report: PullRequestReport): string[] {
  if (report.rounds.length === 0) {
    return details('Verdict history (0 rounds)', ['No round was judged.']);
  }
  const shown = report.rounds.slice(-ROUNDS_SHOWN);
  const hidden = report.rounds.length - shown.length;
  const body = table(
    ['#', 'Piece', 'Verdict', 'Gap'],
    shown.map((round) => [
      String(round.number),
      safeInline(round.piece, 24),
      verdictText(round.verdict),
      round.gap === undefined || round.gap === '' ? '—' : safeInline(round.gap, 96),
    ]),
  );
  if (hidden > 0) {
    body.push('', countOf(hidden, 'earlier round is', 'earlier rounds are') + ' not shown.');
  }
  return details(
    'Verdict history (' + countOf(report.rounds.length, 'round', 'rounds') + ')',
    body,
  );
}

function attestationBlock(report: PullRequestReport): string[] {
  if (report.attestations.length === 0) return [];
  const failed = report.attestations.filter((entry) => !entry.ok).length;
  return details(
    'Integrity attestations (' +
      report.attestations.length +
      (failed === 0 ? '' : ', ' + failed + ' failed') +
      ')',
    report.attestations.map((entry) =>
      fact(
        safeInline(entry.name, 64) + (entry.ok ? '' : ' — **failed**'),
        safeInline(entry.detail, 300),
      ),
    ),
  );
}

/**
 * What one porcelain status column means, in a word.
 *
 * `git status --porcelain` writes two characters — what is staged, and what is
 * in the work tree — and they are the right thing for a program to read and the
 * wrong thing to print at somebody. The bar for this page is a body that never
 * shows its own plumbing, so neither does this.
 *
 * Either column counts: what matters to a reviewer is what happened to the
 * file, not which half of git noticed. An untracked file is `added`, because by
 * the time this body is written the run has staged and committed it.
 */
function changeWord(status: string): string {
  const columns = status.slice(0, 2);
  if (columns === '??' || columns === '!!') return 'added';
  const letters = columns.replace(/ /g, '');
  if (letters.includes('R')) return 'renamed';
  if (letters.includes('C')) return 'copied';
  if (letters.includes('D')) return 'deleted';
  if (letters.includes('A')) return 'added';
  if (letters.includes('M')) return 'modified';
  if (letters.includes('U')) return 'conflicted';
  if (letters.includes('T')) return 'retyped';
  return 'changed';
}

function filesBlock(report: PullRequestReport): string[] {
  const files = report.files ?? [];
  if (files.length === 0) return [];
  const shown = files.slice(0, FILES_SHOWN);
  const body: string[] = [
    'What merging ' +
      code(report.branch) +
      ' into ' +
      code(report.baseBranch) +
      ' would change — every commit on the branch, not only this run’s.',
    '',
  ];
  body.push(
    ...shown.map(
      (file) =>
        '- ' +
        code(file.path) +
        ' — ' +
        changeWord(file.status) +
        (file.from === undefined || file.from === '' ? '' : ' from ' + code(file.from)),
    ),
  );
  const rest = files.length - shown.length;
  if (rest > 0) {
    body.push('', countOf(rest, 'further file is', 'further files are') + ' not listed.');
  }
  return details('Files changed (' + countOf(files.length, 'file', 'files') + ')', body);
}

/**
 * The closing note: what opened this, and what it is not allowed to do.
 *
 * Every safety rule a reviewer would otherwise have to take on trust is stated
 * where they are deciding whether to trust it, and each of them is a mechanism
 * somewhere in this CLI rather than an intention.
 */
function footer(report: PullRequestReport): string[] {
  return [
    '---',
    '',
    'Opened by `' +
      PROGRAM +
      ' work` at ' +
      safeInline(report.generatedAt, 32) +
      ' UTC, from ' +
      link(code(issueRef(report.repo, report.issue)), report.issueUrl) +
      '. The issue body was never edited and no label outside `exolvra:` was ' +
      'touched. Every branch, commit, push, comment and label move was made by ' +
      'the CLI itself — no subagent reached the remote — and the branch is one ' +
      'per issue, never forced, never merged and never closed by anything here.',
  ];
}

/** Said when even the shortest render is longer than a body may be. */
const TRIM_NOTE =
  '\n\n_This body reached the size a GitHub pull request body may be and was cut here._';

/** How much of the body is spelled out, when it will not all fit. */
type DetailLevel = 'full' | 'trimmed' | 'minimal';

function renderAt(report: PullRequestReport, level: DetailLevel): string {
  // The status a reviewer came for is in every level. What a shorter level
  // drops is the folded detail, in a fixed order — the file listing first,
  // because it is the one thing the diff itself already shows.
  const blocks: string[][] = [
    [summaryLine(report)],
    [verdictSentence(report)],
    refreshedBlock(report),
    decisionBlock(report),
    table(['Field', 'Value'], statusRows(report)),
    level === 'minimal' ? [] : roundsBlock(report),
    level === 'minimal' ? [] : attestationBlock(report),
    level === 'full' ? filesBlock(report) : [],
    footer(report),
  ];
  return blocks
    .filter((block) => block.length > 0)
    .map((block) => block.join('\n'))
    .join('\n\n');
}

/**
 * The whole body (R9, R10).
 *
 * The same sections in the same order however the run ended: a reviewer who has
 * read one of these knows where to look in the next. If even the folded render
 * is longer than a body may be, what goes is the detail — in a fixed order —
 * and never the status somebody came to read.
 */
export function renderPullRequestBody(report: PullRequestReport): string {
  for (const level of ['full', 'trimmed', 'minimal'] as const) {
    const text = renderAt(report, level);
    if (text.length <= BODY_LIMIT) return text;
  }
  const text = renderAt(report, 'minimal');
  return [...text].slice(0, BODY_LIMIT - TRIM_NOTE.length).join('') + TRIM_NOTE;
}
