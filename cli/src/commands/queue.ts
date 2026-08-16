import {
  LABEL_PREFIX,
  LIFECYCLE,
  LIFECYCLE_LABELS,
  type Lifecycle,
  REPOS_ENV,
  describeAllowlist,
  issueRef,
  lifecycleLabel,
  lifecycleOf,
  repeatedFlagValues,
  repoValue,
  reposValue,
  resolveAllowlist,
} from '../allowlist.js';
import { EXIT, type ExitCode } from '../exit.js';
import { type FleetRun, loadFleetTemplate, writeFleetPage } from '../fleet.js';
import { parseIssueBranch } from '../git.js';
import {
  type GitHubClient,
  GitHubError,
  type Issue,
  type PullRequest,
  type Repo,
  REDACTED,
  createGitHubClient,
  isoSeconds,
  redactSecrets,
  repoSlug,
} from '../github.js';
import {
  type BooleanFlagSpec,
  type Command,
  type Ctx,
  type EnvSpec,
  type FlagSpec,
  type ValueFlagSpec,
  countValue,
  directoryValue,
  parseInvocation,
  registerCommand,
} from '../registry.js';
import { type RunRecord, readRuns } from '../runs-store.js';
import {
  PROGRAM,
  type Viewport,
  renderCommandHelp,
  renderTable,
  renderUsageError,
  wrapList,
  wrapText,
} from '../usage.js';
import { cell, relativeTime } from './runs.js';

/** How many issues are listed when nothing says otherwise. */
const DEFAULT_LIMIT = 30;

/**
 * The states this lists when nothing asks for more.
 *
 * R12's two words: what is eligible, and what is already in flight. The three
 * that are left out are not part of the queue — a blocked or triaged issue is
 * waiting on a person, and one under review has a pull request open — and
 * `--all` is how a reader asks for them anyway.
 */
const DEFAULT_STATES: readonly Lifecycle[] = ['ready', 'working'];

/* -------------------------------------------------------------------------- */
/* Flags                                                                       */
/* -------------------------------------------------------------------------- */

const directoryFlag: ValueFlagSpec<string> = {
  long: 'directory',
  short: 'C',
  value: directoryValue,
  summary: 'Read the run ledger, and write the fleet page, under dir',
};

const repoFlag: ValueFlagSpec<Repo> = {
  long: 'repo',
  short: 'R',
  value: repoValue,
  summary: 'Allowlist one repository; repeat it to allowlist more',
};

const allFlag: BooleanFlagSpec = {
  long: 'all',
  summary: 'List every state, not just the ones waiting to be worked',
};

const fleetFlag: BooleanFlagSpec = {
  long: 'fleet',
  summary: 'Write the fleet page from this pass as well',
};

const jsonFlag: BooleanFlagSpec = {
  long: 'json',
  summary: 'Output the records themselves as JSON',
};

const limitFlag: ValueFlagSpec<number> = {
  long: 'limit',
  short: 'L',
  value: countValue,
  summary: 'Maximum number of issues to list',
  default: DEFAULT_LIMIT,
};

const flags: FlagSpec[] = [allFlag, directoryFlag, fleetFlag, jsonFlag, limitFlag, repoFlag];

const reposEnv: EnvSpec<Repo[]> = {
  name: REPOS_ENV,
  value: reposValue,
  overriddenBy: repoFlag,
};

/** Every field of a record, as `--json` writes them. */
const JSON_FIELDS: readonly string[] = [
  'createdAt',
  'issue',
  'labels',
  'repo',
  'state',
  'title',
  'updatedAt',
  'url',
];

/* -------------------------------------------------------------------------- */
/* What was found                                                              */
/* -------------------------------------------------------------------------- */

/** One issue, the repository it is in, and the state it is in. */
export interface Entry {
  repo: Repo;
  issue: Issue;
  state: Lifecycle;
}

/** `owner/name#123`, lowercased, as one issue's identity in a map. */
function keyOf(repo: Repo, number: number): string {
  return issueRef(repo, number).toLowerCase();
}

/**
 * Every issue in `repos` carrying one of `states`.
 *
 * One request per state per repository, because the API's label filter is an
 * `and` and a query for five labels at once would answer with the issues that
 * carry all five — which is none of them. An issue found twice is kept once, and
 * the state it is reported in comes from the labels the issue itself carries
 * rather than from the query that turned it up: labels move while a pass runs,
 * and the issue's own answer is the later of the two.
 */
async function collect(
  client: GitHubClient,
  repos: readonly Repo[],
  states: readonly Lifecycle[],
): Promise<Entry[]> {
  const found = new Map<string, Entry>();
  for (const repo of repos) {
    for (const state of states) {
      const issues = await client.listIssues(repo, {
        labels: [lifecycleLabel(state)],
        state: 'open',
      });
      for (const issue of issues) {
        const key = keyOf(repo, issue.number);
        if (found.has(key)) continue;
        const carried = lifecycleOf(issue.labels);
        // The label came off between the query and the answer: whatever this
        // issue is now, it is not part of the lifecycle.
        if (carried === undefined) continue;
        found.set(key, { repo, issue, state: carried });
      }
    }
  }
  return [...found.values()];
}

/**
 * Oldest first, which is the order a pass works them in (R1).
 *
 * By when the issue was opened, so the table reads as the pickup order rather
 * than as an arbitrary shuffle of two repositories' listings. A creation time
 * that cannot be read sorts last and is shown exactly as it arrived, rather than
 * being compared against NaN and landing wherever that leaves it.
 */
function oldestFirst(entries: readonly Entry[]): Entry[] {
  const at = (entry: Entry): number => {
    const parsed = Date.parse(entry.issue.createdAt);
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };
  return [...entries].sort((a, b) => {
    const first = at(a);
    const second = at(b);
    if (first !== second) return first < second ? -1 : 1;
    const byRepo = repoSlug(a.repo).localeCompare(repoSlug(b.repo));
    return byRepo !== 0 ? byRepo : a.issue.number - b.issue.number;
  });
}

/* -------------------------------------------------------------------------- */
/* The table                                                                   */
/* -------------------------------------------------------------------------- */

/** The columns, in order, always — R12's fields, in R12's order. */
const COLUMNS: readonly string[] = ['repo', 'issue', 'title', 'state', 'age'];

/**
 * One cell of text that came from an issue.
 *
 * {@link cell} does what the terminal needs — one printable line, with the
 * characters that reorder a row taken out — and {@link redactSecrets} does what
 * C12 needs: a credential somebody pasted into an issue title is not printed
 * back out by the command that lists the issue. It runs on both sides of the
 * flattening because a token interrupted by an escape sequence or an override is
 * only recognisable once those are gone.
 */
function issueText(text: string): string {
  return redactSecrets(cell(redactSecrets(text)));
}

/**
 * The queue as a table.
 *
 * A terminal gets aligned columns and an age; a pipe gets one tab-delimited
 * record per line and the creation time exactly as GitHub reported it, because
 * "3d ago" is worth reading and worthless to sort by. The repository and the
 * number keep their width while the title still has any to give: together they
 * are what somebody types back in, and half of either is not a shorter one.
 */
export function renderQueue(
  entries: readonly Entry[],
  view: Viewport,
  now: Date,
): string {
  const rows = entries.map((entry) => [
    issueText(repoSlug(entry.repo)),
    '#' + entry.issue.number,
    issueText(entry.issue.title),
    entry.state,
    issueText(view.tty ? relativeTime(entry.issue.createdAt, now) : entry.issue.createdAt),
  ]);
  return renderTable(COLUMNS, rows, view, 0, ['repo', 'issue']).join('\n') + '\n';
}

/* -------------------------------------------------------------------------- */
/* The machine-readable form                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One record as `--json` writes it: every documented field, on every record,
 * always.
 *
 * The values are what GitHub answered with, unflattened — with one exception,
 * and it is the exception rather than the rule for a reason. The table is a
 * display and neutralises what it draws; this is data, and data that has been
 * tidied is data that no longer matches the issue it came from, so nothing here
 * is flattened, wrapped, or cut.
 *
 * What is removed is anything shaped like a credential (C12). `--json` is a
 * machine surface, but it is also the surface a person pipes into a file, pastes
 * into an issue of their own, or hands to somebody who is helping them — which
 * is precisely how a token that was leaked once gets leaked again. A record that
 * says `[redacted]` where a token was is still a record of that issue; a record
 * that republishes the token is a second leak with this tool's name on it.
 *
 * Every *other* hostile character survives as a value and is inert as text,
 * because that is what JSON's own escaping is for: an escape sequence leaves
 * here as a six-character escape, a newline as one, a tab as one, a lone
 * surrogate as one. Decoding gives back exactly what the issue said; printing
 * the document gives a terminal nothing to obey. See {@link inertJson} for the
 * one class JSON does not escape on its own.
 */
export interface QueueJson {
  createdAt: string;
  issue: number;
  labels: string[];
  repo: string;
  state: Lifecycle;
  title: string;
  updatedAt: string;
  url: string;
}

/**
 * One value for `--json`: the bytes GitHub sent, minus any credential in them.
 *
 * A credential can hide from a pattern behind a character that is not drawn — an
 * escape sequence or a right-to-left override dropped into the middle of a token
 * splits it in two, and nothing matches across the gap. Removing those is what
 * reveals it, and that is what the table and the page do anyway.
 *
 * So this asks the question twice. If the text as it stands carries no
 * credential but the cleaned-up view of it does, then the bytes are not
 * something to publish and the cleaned, redacted line is published instead. It
 * is the one case where a record here is not byte-for-byte the issue's, and it
 * is the right trade: a value nobody can read as anything but a token is a
 * token, however it is spelled.
 */
function jsonValue(text: string): string {
  const direct = redactSecrets(text);
  if (direct.includes(REDACTED)) return direct;
  const revealed = redactSecrets(cell(text));
  return revealed.includes(REDACTED) ? revealed : direct;
}

/** The characters that reorder a line rather than draw on it. */
const BIDI = /\p{Bidi_Control}/gu;

/**
 * The one class of hostile character JSON does not escape on its own, escaped.
 *
 * `JSON.stringify` already writes every control character as an escape — an
 * escape sequence, a newline, a tab, a NUL, a lone surrogate all leave as six
 * inert characters, so a document printed to a terminal has nothing in it for
 * the terminal to obey. The bidirectional controls are the exception: they are
 * above U+007F, so they go out as themselves, live, and a right-to-left override
 * inside a title turns the rest of the line around — the url reading as the
 * title, the title as the url — in a terminal, a chat window, or the issue
 * somebody pastes this into.
 *
 * They are escaped here rather than dropped, and that is the whole choice. The
 * human table drops them, because a table cannot lay out mixed-direction text
 * and nothing legible is lost in a column. A record is not a column: half of
 * `\p{Bidi_Control}` is ordinary typesetting in Arabic and Hebrew — the marks
 * and the isolates — and dropping those would quietly corrupt real titles for
 * the people who write them. An escape keeps the value exactly, so a consumer
 * that parses this gets back the issue's own title, character for character,
 * while the document itself stays inert. It is the same move the fleet page
 * makes with `<`.
 *
 * Safe as a blanket replacement over the serialized document because JSON's
 * syntax has no bidirectional control in it: every one that could be there is
 * inside a string, which is exactly where `\uXXXX` means what it says.
 */
export function inertJson(document: string): string {
  return document.replace(
    BIDI,
    (ch) => '\\u' + (ch.codePointAt(0) as number).toString(16).padStart(4, '0'),
  );
}

export function asJson(entries: readonly Entry[]): QueueJson[] {
  // Every string field, rather than the ones that look risky: which fields a
  // stranger can write is a judgement that would have to be made again each
  // time a field is added, and "all of them" does not have to be.
  const scrub = jsonValue;
  return entries.map((entry) => ({
    createdAt: scrub(entry.issue.createdAt),
    issue: entry.issue.number,
    labels: entry.issue.labels.map(scrub),
    repo: scrub(repoSlug(entry.repo)),
    state: entry.state,
    title: scrub(entry.issue.title),
    updatedAt: scrub(entry.issue.updatedAt),
    url: scrub(entry.issue.url),
  }));
}

/* -------------------------------------------------------------------------- */
/* The fleet page                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Whether `input` names this issue.
 *
 * How a run recorded in the ledger is tied back to the issue it is about: the
 * ledger keeps what the run was given, and an issue run is given the issue. Both
 * spellings are accepted — the reference and the page — and a match has to end
 * where the number ends, so `cli/cli#10` is not found inside `cli/cli#101`.
 */
function mentionsIssue(input: string, repo: Repo, number: number): boolean {
  const slug = repoSlug(repo).toLowerCase();
  const text = input.toLowerCase();
  for (const needle of [slug + '#' + number, slug + '/issues/' + number]) {
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      const after = text[at + needle.length];
      if (after === undefined || after < '0' || after > '9') return true;
    }
  }
  return false;
}

/** The most recently recorded run for this issue, when there is one. */
function runFor(
  records: readonly RunRecord[],
  repo: Repo,
  number: number,
): RunRecord | undefined {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i] as RunRecord;
    if (mentionsIssue(record.input, repo, number)) return record;
  }
  return undefined;
}

/**
 * The pull request opened from this issue's branch, when there is one.
 *
 * By the head reference and nothing else. One branch per issue, named for that
 * issue (C4), is what makes the attribution a fact rather than a guess — there
 * is no comment to parse and no body to trust — and the name is read back by the
 * same module that refuses to write outside the namespace.
 */
function pullFor(pulls: readonly PullRequest[], number: number): PullRequest | undefined {
  return pulls.find((pull) => parseIssueBranch(pull.head)?.number === number);
}

function fleetRun(
  entry: Entry,
  records: readonly RunRecord[],
  pulls: readonly PullRequest[],
): FleetRun {
  const record = runFor(records, entry.repo, entry.issue.number);
  const pull = pullFor(pulls, entry.issue.number);
  return {
    repo: repoSlug(entry.repo),
    issue: entry.issue.number,
    title: entry.issue.title,
    status: entry.state,
    round: record?.rounds ?? null,
    verdict: record?.lastVerdict ?? null,
    costUsd: record?.costUsd ?? null,
    pr: pull?.url ?? null,
    url: entry.issue.url,
    updated: entry.issue.updatedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Whose fault it was                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The code a GitHub fault ends this command on.
 *
 * Exit 2 is a sentence about the command line: `exolvra-genesis help exit-codes`
 * says it "always means the invocation itself has to change before the command
 * can run — it never reports on the work". A rate limit, a stalled connection
 * and a 503 are none of that. Nothing the reader could retype would avoid them,
 * they are very likely gone in ten minutes, and answering them with the code
 * that means "you typed it wrong" sends somebody to edit an invocation that was
 * correct. They end on 1, the code for work that did not finish.
 *
 * The transient set is `work`'s, deliberately: a rate limit means the same thing
 * to both commands, and two commands disagreeing about that would be two answers
 * to one question. Where they differ is `not-found`, and they should — a label
 * that moved out from under `work` mid-run is a race it recovers from, while a
 * repository this listing was pointed at and cannot see is a repository somebody
 * named wrongly, or a token that needs a scope. That one is the invocation, so
 * it keeps 2.
 */
export function exitForFault(fault: GitHubError): ExitCode {
  if (fault.kind === 'rate-limit' || fault.kind === 'unreachable') return EXIT.LOSS;
  if (fault.kind === 'malformed') return EXIT.LOSS;
  if (fault.status !== undefined && fault.status >= 500) return EXIT.LOSS;
  return EXIT.USAGE;
}

/* -------------------------------------------------------------------------- */
/* The command                                                                 */
/* -------------------------------------------------------------------------- */

const queueCommand: Command = {
  name: 'queue',
  summary: 'List the issues waiting to be worked, and the ones in flight',
  usage: PROGRAM + ' queue [flags]',
  group: 'core',
  description: [
    'List the issues waiting to be worked, and the ones in flight.',
    'Only issues in an allowlisted repository are ever looked at. The allowlist is named\nper invocation — --repo owner/name, which may be repeated, or ' +
      REPOS_ENV +
      '\nas a comma-separated list — and naming none is an error rather than an invitation:\nan empty allowlist never means every repository the token can see.',
    'Eligibility is a label a maintainer applies. This lists the issues carrying\n' +
      lifecycleLabel('ready') +
      ' or ' +
      lifecycleLabel('working') +
      ', oldest first, which is the order a pass\nwould pick them up in. --all lists the other three states beside them.',
    'On a terminal the table is laid out in aligned columns and the age is how long ago\nthe issue was opened. Piped, it is one tab-delimited record per line with no header\nrow, and the age is the creation time exactly as GitHub reported it, so the output\nstays something cut and sort can read.',
    '--json writes the records themselves instead. Every field below is on every record,\nand the values are what GitHub answered with rather than what a terminal would be\nshown.',
    'Issue text is untrusted input, and one rule covers every surface here: nothing this\nprints is live in a terminal. A title is flattened to one line and stripped of what\na terminal would obey before it is drawn; --json escapes the same characters rather\nthan dropping them, so the document is inert and a parser still gets the title\nexactly. Anything shaped like a credential is replaced with ' +
      REDACTED +
      ' in the table,\nin --json and on the fleet page alike: a token pasted into an issue is not\nrepublished by the tool that reports on the issue.',
    '--fleet also writes .exolvra-genesis/fleet.html: every issue run across the\nallowlist on one page, in the same template the per-run progress page uses. The page\ncovers every state whatever the listing was narrowed to, and joins each issue to\nwhat the local run ledger knows about it — rounds, last verdict, budget — and to the\npull request open from its branch.',
    'An allowlist with no issues in it prints nothing to stdout and says so on stderr, so\na listing piped into something else is either a listing or is empty. That is still a\nsuccess: it exits 0.',
    'A token is read from GITHUB_TOKEN, or from `gh auth token` when that is unset. No\ntoken, an unreadable one, or a repository this token cannot see is a configuration\nerror and exits 2, because the invocation has to change before this can run.',
    'A fault on GitHub\'s side of the call exits 1 instead — a rate limit, a 5xx, or\nnothing answering in time. Nothing you could retype would avoid one, so it is a\nrun that did not finish rather than a command that was written wrongly, and it is\nusually worth simply running again. Either way nothing is listed: the repositories\nthat did answer are not printed on their own, because a partial listing and a\ncomplete one look identical to whatever is reading it.',
  ],
  flags,
  env: [reposEnv],
  cwdFlag: directoryFlag,
  // A listing of nothing is a listing, so this one is allowed to succeed with an
  // empty stdout, exactly as the run ledger's listing is.
  emptyIsSuccess: true,
  sections: [
    {
      title: 'LABELS',
      lines: [
        ...wrapList(LIFECYCLE_LABELS, 2),
        '',
        ...wrapText(
          'The lifecycle namespace, and the whole of it, listed in the order ' +
            'one wins when an issue somehow carries two. Every label here is ' +
            'prefixed so it can never collide with a label the repository ' +
            'already uses, and no command touches a label outside it. Applying ' +
            'the ready label is a maintainer\'s act and the only thing that makes ' +
            'an issue eligible.',
          78,
          2,
        ),
      ],
    },
    {
      title: 'JSON FIELDS',
      lines: [
        ...wrapList(JSON_FIELDS, 2),
        '',
        ...wrapText(
          'state is the one lifecycle state the issue is in, and labels is every ' +
            'label it carries, GitHub\'s own included. An issue that somehow ' +
            'carries two lifecycle labels is reported in the one a reader most ' +
            'needs told about, in the order the LABELS section lists them.',
          78,
          2,
        ),
        '',
        ...wrapText(
          'Every string field above is written as GitHub answered it, with one ' +
            'thing taken out: a run of characters shaped like a GitHub token is ' +
            'replaced with ' +
            REDACTED +
            '. title and labels are the fields a stranger can write, so they are ' +
            'the ones this is likely to change; it is applied to all of them ' +
            'because which fields a stranger can write is not a judgement worth ' +
            'making again every time a field is added.',
          78,
          2,
        ),
        '',
        ...wrapText(
          'Everything else survives exactly, escaped rather than removed. A ' +
            'newline, a tab, an escape sequence and a bidirectional override are ' +
            'all written as \\uXXXX, so parsing a record gives back the issue\'s ' +
            'own title character for character, while printing this document to a ' +
            'terminal gives it nothing to act on. Unlike the table, which drops ' +
            'those characters, nothing is lost here: an Arabic or Hebrew title ' +
            'keeps the marks that make it read correctly.',
          78,
          2,
        ),
      ],
    },
  ],
  examples: [
    PROGRAM + ' queue --repo cli/cli',
    PROGRAM + ' queue -R cli/cli -R octocat/hello-world --all',
    PROGRAM + ' queue --repo cli/cli --fleet',
    PROGRAM + " queue --repo cli/cli --json | jq -r '.[].url'",
  ],
  run: runQueue,
};

registerCommand(queueCommand);

export { queueCommand };

async function runQueue(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseInvocation(queueCommand, argv, ctx);

  if (args.help) {
    ctx.stdout.write(renderCommandHelp(queueCommand));
    return EXIT.WIN;
  }

  const repos = resolveAllowlist({
    fromFlags: repeatedFlagValues(queueCommand, argv, repoFlag, args.cwd),
    fromEnv: args.env(reposEnv),
    usage: queueCommand.usage,
    flag: args.as(repoFlag),
  });

  const view: Viewport = { tty: ctx.isTTY, width: ctx.width };
  const limit = args.get(limitFlag) ?? DEFAULT_LIMIT;
  const listing = args.bool(allFlag) ? LIFECYCLE : DEFAULT_STATES;
  const fleet = args.bool(fleetFlag);
  // The page is about the whole lifecycle whatever the listing was narrowed to:
  // a dashboard that hid the blocked runs would be worse than no dashboard.
  const queried = fleet ? LIFECYCLE : listing;

  // The token is resolved here, before anything is read, so a pass without one
  // fails at the start rather than between two repositories.
  const client = createGitHubClient({ env: ctx.env });

  /*
   * Every request this command makes, and nothing that prints.
   *
   * All of it or none of it: a listing that showed the repositories that
   * answered and said nothing about the one that did not would be a complete
   * listing as far as its reader — or the pipe on the other end of it — could
   * tell, and the missing repository is exactly the one worth knowing about.
   * Because nothing is written until every repository has answered, a fault here
   * leaves stdout untouched, and the reader gets a fault instead of a listing
   * that quietly is not one.
   */
  let found: Entry[];
  let page: string | undefined;
  try {
    found = oldestFirst(await collect(client, repos, queried));

    if (fleet) {
      const records = readRuns(args.cwd);
      const runs: FleetRun[] = [];
      for (const repo of repos) {
        const pulls = await client.listPullRequests(repo, { state: 'open' });
        for (const entry of found) {
          if (repoSlug(entry.repo) !== repoSlug(repo)) continue;
          runs.push(fleetRun(entry, records, pulls));
        }
      }
      page = writeFleetPage(args.cwd, loadFleetTemplate(ctx.env), {
        generated: isoSeconds(new Date()),
        repos: repos.map(repoSlug),
        runs,
      });
    }
  } catch (error) {
    // The message is the network module's, printed in the shape every other
    // fault here is printed in — the complaint, the detail indented under it.
    // Only the code is this command's to decide.
    if (!(error instanceof GitHubError)) throw error;
    ctx.stderr.write(renderUsageError(error.message));
    return exitForFault(error);
  }

  if (page !== undefined) ctx.stderr.write('fleet page written to ' + page + '\n');

  const shown = found.filter((entry) => listing.includes(entry.state)).slice(0, limit);

  if (args.bool(jsonFlag)) {
    // Indented for a terminal, one line for a pipe: the same output either way,
    // laid out for whoever is reading it.
    const records = asJson(shown);
    const json = view.tty ? JSON.stringify(records, null, 2) : JSON.stringify(records);
    ctx.stdout.write(inertJson(json) + '\n');
    return EXIT.WIN;
  }

  // An allowlist with nothing in it is not a table with no rows: an empty table
  // is a header row over nothing, which reads as though something was lost. It
  // is said on the error stream, so a listing piped into something else is a
  // listing or is empty, and never a sentence about the absence of one.
  //
  // It is still a success. Finding no eligible issue is a complete answer to the
  // question that was asked, and exit 1 is this CLI's word for a verdict.
  if (shown.length === 0) {
    const carrying =
      listing === LIFECYCLE
        ? 'an ' + LABEL_PREFIX + ' label'
        : listing.map(lifecycleLabel).join(' or ');
    ctx.stderr.write(
      'no open issue carrying ' + carrying + ' in ' + describeAllowlist(repos) + '\n',
    );
    return EXIT.WIN;
  }

  ctx.stdout.write(renderQueue(shown, view, new Date()));
  return EXIT.WIN;
}
