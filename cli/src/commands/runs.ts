import { EXIT } from '../exit.js';
import {
  type BooleanFlagSpec,
  type Command,
  type Ctx,
  type FlagSpec,
  type ValueFlagSpec,
  countValue,
  directoryValue,
  parseInvocation,
  registerCommand,
} from '../registry.js';
import {
  type RunRecord,
  type RunStatus,
  readRuns,
  runsPath,
} from '../runs-store.js';
import {
  PROGRAM,
  type Viewport,
  plainText,
  renderCommandHelp,
  renderTable,
  truncate,
  wrapList,
  wrapText,
} from '../usage.js';

/** How many runs are listed when nothing says otherwise. */
const DEFAULT_LIMIT = 10;

/* -------------------------------------------------------------------------- */
/* Flags                                                                       */
/* -------------------------------------------------------------------------- */

const directoryFlag: ValueFlagSpec<string> = {
  long: 'directory',
  short: 'C',
  value: directoryValue,
  summary: 'Read the ledger under dir instead of the current directory',
};

const limitFlag: ValueFlagSpec<number> = {
  long: 'limit',
  short: 'L',
  value: countValue,
  summary: 'Maximum number of runs to list',
  default: DEFAULT_LIMIT,
};

const jsonFlag: BooleanFlagSpec = {
  long: 'json',
  summary: 'Output the records themselves as JSON',
};

const flags: FlagSpec[] = [directoryFlag, jsonFlag, limitFlag];

/** Every field of a record, as `--json` writes them. */
const JSON_FIELDS: readonly string[] = [
  'costUsd',
  'id',
  'input',
  'lastVerdict',
  'models',
  'rounds',
  'sessionId',
  'startedAt',
  'status',
];

/* -------------------------------------------------------------------------- */
/* Relative time                                                               */
/* -------------------------------------------------------------------------- */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** A length of time, in the largest unit that still leaves a whole number. */
function span(ms: number): string {
  if (ms < MINUTE) return Math.floor(ms / SECOND) + 's';
  if (ms < HOUR) return Math.floor(ms / MINUTE) + 'm';
  if (ms < DAY) return Math.floor(ms / HOUR) + 'h';
  if (ms < MONTH) return Math.floor(ms / DAY) + 'd';
  if (ms < YEAR) return Math.floor(ms / MONTH) + 'mo';
  return Math.floor(ms / YEAR) + 'y';
}

/**
 * How long ago `timestamp` was, in the shortest form that still says it.
 *
 * A start time in the future is a real thing to see — two machines, two clocks,
 * one ledger — and it reads as `in 5m`, which is visibly odd, rather than being
 * rounded down to something that looks ordinary. A skewed clock is worth
 * noticing.
 *
 * A timestamp that is not one is returned exactly as it was recorded. The
 * ledger's own validator refuses to hand out a record whose start time cannot
 * be read, so this is the second of the two answers to the same question: a
 * renderer does not assume a validator ran in front of it.
 */
export function relativeTime(timestamp: string, now: Date): string {
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return timestamp;

  const elapsed = now.getTime() - at;
  if (Math.abs(elapsed) < 5 * SECOND) return 'just now';
  return elapsed < 0 ? 'in ' + span(-elapsed) : span(elapsed) + ' ago';
}

/* -------------------------------------------------------------------------- */
/* The table                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The columns, in order, always — the same discipline the plan tables keep. A
 * run that has no verdict yet still has the column, so the fifth field of a
 * piped row is the verdict on every run of this command rather than on some.
 */
const COLUMNS: readonly string[] = ['id', 'started', 'input', 'status', 'verdict'];

/** Stands in for a verdict that has not been reached. */
const NO_VERDICT = '-';

/** Widest a verdict may be before it starts eating the input column. */
const VERDICT_WIDTH = 24;

/**
 * The characters that reorder a line rather than draw on it.
 *
 * A right-to-left override in a goal turns the rest of the row — the id, the
 * status, the columns after it — around on the terminal, so a run can be made
 * to read as another one without a single character of it being false. They are
 * dropped here rather than escaped: nothing legible is lost, and a table is not
 * a place to be laying out mixed-direction text. Joiners are untouched, so an
 * emoji spelled with several code points is still one character two columns
 * wide.
 */
const BIDI = /\p{Bidi_Control}/gu;

/**
 * One cell, with what a terminal would obey taken out of it.
 *
 * The table itself already flattens a cell to one printable line and strips
 * escape sequences; this is the part it does not do, applied on the way in, so
 * every field of every column goes through it.
 */
export function cell(text: string): string {
  return plainText(text).replace(BIDI, '');
}

function verdictOf(record: RunRecord): string {
  const verdict = cell(record.lastVerdict ?? '');
  return verdict === '' ? NO_VERDICT : truncate(verdict, VERDICT_WIDTH);
}

/**
 * The runs, newest first.
 *
 * By the recorded start time, and by where they sit in the ledger when that
 * time cannot be read — a record whose timestamp was edited by hand still has
 * to land somewhere, and the order it was appended in is the honest answer.
 */
export function mostRecentFirst(runs: readonly RunRecord[]): RunRecord[] {
  const at = (record: RunRecord): number => {
    const parsed = Date.parse(record.startedAt);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  return runs
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const first = at(a.record);
      const second = at(b.record);
      if (first !== second) return second > first ? 1 : -1;
      return b.index - a.index;
    })
    .map((entry) => entry.record);
}

/**
 * The ledger as a table.
 *
 * A terminal gets aligned columns and an age; a pipe gets one tab-delimited
 * record per line and the timestamp exactly as it was recorded, because "12m
 * ago" is worth reading and worthless to sort by. Every cell is flattened and
 * stripped by the table itself, so nothing a run was named with can repaint the
 * screen on its way through here.
 */
export function renderRuns(
  records: readonly RunRecord[],
  view: Viewport,
  now: Date,
): string {
  const rows = records.map((record) => [
    cell(record.id),
    cell(view.tty ? relativeTime(record.startedAt, now) : record.startedAt),
    cell(record.input),
    cell(record.status),
    verdictOf(record),
  ]);
  // The id keeps its width while any other column still has some to give: it is
  // the one cell here that is meant to be typed back in, at `gauntlet resume`.
  return renderTable(COLUMNS, rows, view, 0, ['id']).join('\n') + '\n';
}

/* -------------------------------------------------------------------------- */
/* The machine-readable form                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One record as `--json` writes it: every documented field, on every record,
 * always.
 *
 * A field left out when a run has not produced one yet makes the record's shape
 * depend on its content — nine keys on one run and eight on the next — so
 * anything reading the output has to handle both, and the field list in the
 * help would be true only sometimes. Absent is `null`, which is a value, and
 * the keys are in the order the help lists them.
 */
export interface RunJson {
  costUsd: number | null;
  id: string;
  input: string;
  lastVerdict: string | null;
  models: { lead: string; builder: string; critic: string };
  rounds: number | null;
  sessionId: string | null;
  startedAt: string;
  status: RunStatus;
}

export function asJson(records: readonly RunRecord[]): RunJson[] {
  return records.map((record) => ({
    costUsd: record.costUsd ?? null,
    id: record.id,
    input: record.input,
    lastVerdict: record.lastVerdict ?? null,
    models: record.models,
    rounds: record.rounds ?? null,
    sessionId: record.sessionId,
    startedAt: record.startedAt,
    status: record.status,
  }));
}

/* -------------------------------------------------------------------------- */
/* The command                                                                 */
/* -------------------------------------------------------------------------- */

const runsCommand: Command = {
  name: 'runs',
  summary: 'List the runs recorded in this directory',
  usage: PROGRAM + ' runs [flags]',
  group: 'core',
  description: [
    'List the runs recorded in this directory.',
    'Every run is recorded in .gauntlet/runs.json as it starts: the goal or spec it was\ngiven, the model each role ran on, when it started, and how it ended. This lists the\nmost recent of them, newest first.',
    'On a terminal the table is laid out in aligned columns and the start time is shown\nas an age. Piped, it is one tab-delimited record per line with no header row, and\nthe start time is the timestamp exactly as it was recorded, so the output stays\nsomething cut and sort can read.',
    '--json writes the records themselves instead. Every field below is on every\nrecord, and a field a run has not produced yet is null rather than missing, so the\nshape of a record never depends on what is in it.',
    'A directory with no runs recorded in it prints nothing to stdout and says so on\nstderr, so a listing piped into something else is either a listing or is empty,\nand never a sentence about the absence of one. Listing no runs is still a\nsuccess: it exits 0.',
  ],
  flags,
  cwdFlag: directoryFlag,
  // A listing of nothing is a listing, so this one is allowed to succeed with
  // an empty stdout. Every other command is still held to the rule.
  emptyIsSuccess: true,
  sections: [
    {
      title: 'JSON FIELDS',
      lines: [
        ...wrapList(JSON_FIELDS, 2),
        '',
        ...wrapText(
          'These are the ledger records themselves, named as the ledger names ' +
            'them, which is the convention gh follows for its own --json. The ' +
            'stream a run reports on is a different contract with a different ' +
            'audience: gauntlet run --json and gauntlet resume --json end on a ' +
            'summary object whose keys are fixed as cost_usd and session_id. ' +
            'Both spellings are anchored outside this CLI, so neither is bent ' +
            'to match the other.',
          78,
          2,
        ),
      ],
    },
  ],
  examples: [
    PROGRAM + ' runs',
    PROGRAM + ' runs --limit 5',
    PROGRAM + ' runs --json | jq \'.[] | select(.status == "running") | .id\'',
  ],
  run: runRuns,
};

registerCommand(runsCommand);

export { runsCommand };

async function runRuns(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseInvocation(runsCommand, argv, ctx);

  if (args.help) {
    ctx.stdout.write(renderCommandHelp(runsCommand));
    return EXIT.WIN;
  }

  const cwd = args.cwd;
  const view: Viewport = { tty: ctx.isTTY, width: ctx.width };
  const limit = args.get(limitFlag) ?? DEFAULT_LIMIT;

  // A ledger that cannot be read is a configuration error raised from here,
  // naming the file; it is never quietly reported as a directory with no runs.
  const recent = mostRecentFirst(readRuns(cwd)).slice(0, limit);

  if (args.bool(jsonFlag)) {
    // Indented for a terminal, one line for a pipe: the same output either way,
    // laid out for whoever is reading it.
    const records = asJson(recent);
    const json = view.tty ? JSON.stringify(records, null, 2) : JSON.stringify(records);
    ctx.stdout.write(json + '\n');
    return EXIT.WIN;
  }

  // A directory with no runs is not a table with no rows: an empty table is a
  // header row over nothing, which reads as though something was lost. It is
  // said on the error stream, so that a listing piped into something else is a
  // listing or is empty, and never a sentence about the absence of one.
  //
  // It is still a success. Listing zero runs is a complete answer to the
  // question that was asked, and exit 1 is this CLI's word for a verdict —
  // a run that lost, was blocked, or ran out of budget. An empty directory is
  // none of those, and CI gating on that code must not fail because of one.
  if (recent.length === 0) {
    ctx.stderr.write('no runs found in ' + runsPath(cwd) + '\n');
    return EXIT.WIN;
  }

  ctx.stdout.write(renderRuns(recent, view, new Date()));
  return EXIT.WIN;
}
