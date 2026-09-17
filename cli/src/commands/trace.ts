import { statSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';

import { EXIT, ConfigError, UsageError } from '../exit.js';
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
  RUN_DIR,
  isRunId,
  readRuns,
  readState,
} from '../runs-store.js';
import { type TraceRecord, readTrace, readTraceEnding, traceDirectory } from '../trace-store.js';
import {
  type Viewport,
  PROGRAM,
  plainText,
  renderCommandHelp,
  renderTable,
} from '../usage.js';

/** How many records are shown when nothing says otherwise. */
const DEFAULT_LIMIT = 100;

/** How often --follow polls, in milliseconds. */
const FOLLOW_POLL_MS = 500;

/* -------------------------------------------------------------------------- */
/* Flags                                                                       */
/* -------------------------------------------------------------------------- */

const directoryFlag: ValueFlagSpec<string> = {
  long: 'directory',
  short: 'C',
  value: directoryValue,
  summary: 'Read the trace under dir instead of the current directory',
};

const limitFlag: ValueFlagSpec<number> = {
  long: 'limit',
  short: 'L',
  value: countValue,
  summary: 'Maximum number of events to show',
  default: DEFAULT_LIMIT,
};

const jsonFlag: BooleanFlagSpec = {
  long: 'json',
  summary: 'Output the events as NDJSON, one object per line',
};

const followFlag: BooleanFlagSpec = {
  long: 'follow',
  short: 'f',
  summary: 'Poll for new events until the run finishes or interrupted',
};

const verboseFlag: BooleanFlagSpec = {
  long: 'verbose',
  short: 'v',
  summary: 'Show payload text byte-verbatim without flattening',
};

const flags: FlagSpec[] = [directoryFlag, followFlag, jsonFlag, limitFlag, verboseFlag];

/** A run id: letters, digits, dots, dashes and underscores. */
const runIdValue = {
  arg: 'run-id',
  invalid: 'not a run id',
  parse(raw: string, ctx: { flag: string; usage: string }): string {
    const trimmed = raw.trim();
    if (trimmed === '' || !isRunId(trimmed)) {
      throw new UsageError(
        'invalid value "' + raw + '" for ' + ctx.flag + ': expected a run id',
        ctx.usage,
      );
    }
    return trimmed;
  },
};

const runIdArgument = {
  name: 'run-id',
  value: runIdValue,
};

/* -------------------------------------------------------------------------- */
/* Flattening: model output is untrusted renderer input                        */
/* -------------------------------------------------------------------------- */

/**
 * Bidi controls that could reorder what a line says.
 * U+202A-U+202E (LRE, RLE, PDF, LRO, RLO) and U+2066-U+2069 (LRI, RLI, FSI, PDI).
 */
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;

/**
 * A bare carriage return, not part of CRLF.
 * Would let a payload overwrite what came before it on the line.
 */
const BARE_CR = /\r(?!\n)/g;

/**
 * Flattens a payload string so it cannot forge a row or escape the column.
 *
 * - ANSI escapes are stripped (handled by plainText)
 * - Bidi controls are stripped
 * - Bare carriage returns become space
 * - Newlines and tabs become space (handled by plainText)
 *
 * For --verbose, the value is passed through without flattening.
 */
function flattenField(value: string, verbose: boolean): string {
  if (verbose) return value;
  // plainText already strips ANSI, lone surrogates, control chars, and collapses whitespace
  return plainText(value).replace(BIDI, '').replace(BARE_CR, ' ');
}

/**
 * Flattens all string values in a payload recursively.
 */
function flattenPayload(
  payload: Record<string, unknown>,
  verbose: boolean,
): Record<string, unknown> {
  if (verbose) return payload;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') {
      result[key] = flattenField(value, false);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === 'string'
          ? flattenField(item, false)
          : typeof item === 'object' && item !== null
            ? flattenPayload(item as Record<string, unknown>, false)
            : item,
      );
    } else if (typeof value === 'object' && value !== null) {
      result[key] = flattenPayload(value as Record<string, unknown>, false);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* JSON output                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One record as NDJSON writes it: every field, stable keys, optionals as null.
 *
 * U+2028 and U+2029 are escaped so the line stays one line when parsed by
 * anything that treats them as line terminators.
 */
interface TraceJson {
  at: number;
  kind: string;
  payload: Record<string, unknown>;
  piece: string | null;
  round: number | null;
  run_id: string;
  seq: number;
}

function asJson(record: TraceRecord, verbose: boolean): TraceJson {
  return {
    at: record.at,
    kind: record.kind,
    payload: flattenPayload(record.payload, verbose),
    piece: record.piece,
    round: record.round,
    run_id: record.runId,
    seq: record.seq,
  };
}

/**
 * Escapes U+2028 and U+2029 so JSON stays on one line.
 */
function escapeJsonLineSeparators(json: string): string {
  return json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/* -------------------------------------------------------------------------- */
/* Table output                                                                */
/* -------------------------------------------------------------------------- */

/** The columns, in order, always. */
const COLUMNS = ['seq', 'at', 'kind', 'piece', 'round', 'payload'] as const;

/**
 * Formats a timestamp as ISO 8601 in UTC.
 */
function formatTime(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Formats the payload as a single-line summary.
 */
function formatPayload(payload: Record<string, unknown>, verbose: boolean): string {
  const flattened = flattenPayload(payload, verbose);
  // For the table, show a compact JSON representation
  const json = JSON.stringify(flattened);
  // Already flattened, but plainText to collapse any remaining whitespace
  return verbose ? json : plainText(json);
}

/**
 * Renders the trace as a table.
 */
function renderTraceTable(
  records: readonly TraceRecord[],
  view: Viewport,
  verbose: boolean,
): string[] {
  const rows = records.map((record) => [
    String(record.seq),
    formatTime(record.at),
    flattenField(record.kind, verbose),
    record.piece === null ? '' : flattenField(record.piece, verbose),
    record.round === null ? '' : String(record.round),
    formatPayload(record.payload, verbose),
  ]);
  return renderTable(COLUMNS as unknown as readonly string[], rows, view, 0, ['seq']);
}

/**
 * Renders the trace as tab-separated values (piped output).
 */
function renderTraceTsv(records: readonly TraceRecord[], verbose: boolean): string[] {
  return records.map((record) => {
    const fields = [
      String(record.seq),
      formatTime(record.at),
      flattenField(record.kind, verbose),
      record.piece === null ? '' : flattenField(record.piece, verbose),
      record.round === null ? '' : String(record.round),
      formatPayload(record.payload, verbose),
    ];
    return fields.join('\t');
  });
}

/* -------------------------------------------------------------------------- */
/* Run resolution                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Finds the run record by id, or throws a UsageError/ConfigError naming the problem.
 */
function resolveRun(cwd: string, runId: string, usage: string): RunRecord {
  // Check if .exolvra-genesis/ exists at all
  const runDir = join(cwd, RUN_DIR);
  try {
    statSync(runDir);
  } catch {
    throw new ConfigError(
      [
        'no run has been recorded here',
        '  ' + runDir,
        '  run `' + PROGRAM + ' runs` to see the runs that have been recorded',
      ].join('\n'),
    );
  }

  // readRuns throws ConfigError for corrupt ledger, let it propagate
  const runs = readRuns(cwd);

  // An empty list means no runs recorded yet
  if (runs.length === 0) {
    throw new UsageError(
      [
        'no run is recorded as "' + runId + '"',
        '  run `' + PROGRAM + ' runs` to see the ids the ledger holds',
      ].join('\n'),
      usage,
    );
  }

  const record = runs.find((r) => r.id === runId);
  if (record === undefined) {
    throw new UsageError(
      [
        'no run is recorded as "' + runId + '"',
        '  run `' + PROGRAM + ' runs` to see the ids the ledger holds',
      ].join('\n'),
      usage,
    );
  }

  return record;
}

/* -------------------------------------------------------------------------- */
/* Trace reading helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Determines the trace file path for a run.
 * Returns null if no trace file exists.
 */
function findTraceFile(cwd: string, runId: string): string | null {
  const traceDir = traceDirectory(cwd, runId);
  const dbPath = join(traceDir, runId + '.db');
  const ndjsonPath = join(traceDir, runId + '.ndjson');

  try {
    statSync(dbPath);
    return dbPath;
  } catch {
    // Not found, try ndjson
  }

  try {
    statSync(ndjsonPath);
    return ndjsonPath;
  } catch {
    // Neither exists
  }

  return null;
}

/**
 * Checks if a trace file is readable and throws ConfigError if not.
 */
function checkTraceReadable(tracePath: string): void {
  try {
    accessSync(tracePath, constants.R_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new ConfigError(
        [
          'could not read the trace',
          '  ' + tracePath,
        ].join('\n'),
      );
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* The ending a killed run could not write for itself                          */
/* -------------------------------------------------------------------------- */

/**
 * What the reader says about a run whose process died without finalizing.
 *
 * One line, on stderr, in every mode. Stderr because stdout is the record
 * stream and a machine reading `--json` must keep getting NDJSON and nothing
 * else; the command already says `the run has no trace recorded` there, so this
 * is the channel a reader's own statements about the trace go out on.
 */
function abandonedLine(pid: number): string {
  return (
    'this run is finalized as failed: the process that opened it (pid ' +
    String(pid) +
    ') is gone\n'
  );
}

/**
 * The pid to name in {@link abandonedLine}, or null for "say nothing".
 *
 * Two facts have to agree before this reader may call a run failed, and the
 * order they are asked in is the point.
 *
 * `readTraceEnding` answers about a *process*: `failed` means the process that
 * opened the lead row is gone and never closed it. A SIGKILL leaves that shape
 * — and so does a store that degraded mid-run, because a degraded store drops
 * `closeProcess` and `finalize` exactly as a dead process does. From inside the
 * trace the two are the same picture, so the trace alone said "finalized as
 * failed" over runs that had won and exited 0.
 *
 * The ledger is what tells them apart, and asking it is the direction C1
 * prescribes rather than a breach of it: `runs.json` is the source of truth and
 * the trace is the mirror, so where the mirror is silent and the ledger has
 * spoken, the ledger wins. Nothing flows the other way — no ledger field, no
 * `state.json` value and no exit code depends on what the trace returns, and
 * this command already had to read the ledger to resolve the run id at all.
 *
 * A ledger status this reader could not obtain is not permission to claim a
 * death: `undefined` answers null, the same as a settled run.
 */
function reportableEnding(
  cwd: string,
  runId: string,
  ledgerStatus: string | undefined,
): number | null {
  if (ledgerStatus !== 'running') return null;
  const ending = readTraceEnding(cwd, runId);
  return ending.state === 'failed' ? ending.pid : null;
}

/**
 * The run's ledger status, or undefined when the ledger cannot be read.
 *
 * This never throws, whatever the ledger holds. It is called on every poll of a
 * follow, and a ledger that becomes unreadable while somebody is watching a run
 * must not turn a live view into a crash — the same posture the store takes,
 * where a read failure never becomes a command failure. What that costs is
 * spelled out at the one caller that can act on it: "could not read" is not
 * "the run settled", so {@link reportableEnding} answers null for `undefined`
 * and this reader says nothing rather than guessing.
 */
function ledgerStatusOf(cwd: string, runId: string): string | undefined {
  try {
    return readRuns(cwd).find((record) => record.id === runId)?.status;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Follow mode                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Polls for new events until the run finishes, dies, or SIGINT.
 * Returns 0 on clean exit, handles EPIPE gracefully.
 *
 * `endingReported` says whether the caller already printed the abandoned line
 * for a run that was dead before the follow began, so it is printed once per
 * invocation however the death was noticed.
 */
async function followTrace(
  cwd: string,
  runId: string,
  ctx: Ctx,
  view: Viewport,
  json: boolean,
  verbose: boolean,
  endingReported: boolean,
): Promise<number> {
  let reported = endingReported;
  let cursor = 0;
  let degraded = false;
  let interrupted = false;
  let headerPrinted = false;

  // Handle SIGINT gracefully
  const onSigint = (): void => {
    interrupted = true;
  };
  process.on('SIGINT', onSigint);

  // Handle EPIPE gracefully (stdout closed early)
  let pipeError = false;
  const onError = (error: NodeJS.ErrnoException): void => {
    if (error.code === 'EPIPE') {
      pipeError = true;
    }
  };
  ctx.stdout.on('error', onError);

  try {
    while (!interrupted && !pipeError) {
      const reading = readTrace(cwd, runId, cursor);

      if (reading.degraded && !degraded) {
        degraded = true;
        ctx.stderr.write('trace store degraded while following\n');
      }

      if (reading.records.length > 0) {
        for (const record of reading.records) {
          if (pipeError) break;
          try {
            if (json) {
              const line = escapeJsonLineSeparators(JSON.stringify(asJson(record, verbose)));
              ctx.stdout.write(line + '\n');
            } else if (view.tty) {
              const lines = renderTraceTable([record], view, verbose);
              // Print header only for the first batch
              if (!headerPrinted) {
                ctx.stdout.write(lines.join('\n') + '\n');
                headerPrinted = true;
              } else {
                // Skip header for subsequent records
                ctx.stdout.write(lines.slice(1).join('\n') + '\n');
              }
            } else {
              const lines = renderTraceTsv([record], verbose);
              ctx.stdout.write(lines.join('\n') + '\n');
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
              pipeError = true;
              break;
            }
            throw error;
          }
        }
        cursor = reading.cursor;
      }

      // Check if run finished by looking at state
      const state = readState(cwd);
      if (state.status === 'complete' || state.status === 'stopped' || state.status === 'blocked') {
        break;
      }

      // A run killed outright never moves `state.json` off `running`: the
      // process that would have rewritten it is gone. The check above is
      // therefore the one exit this loop had, and it is the one exit a killed
      // run can never reach — so a follow against a dead run polled forever,
      // saying `running` at the exact screen somebody watches a stuck run on.
      // The ending closes it: the records above have already been drained, so
      // the reader has seen everything the dead run wrote before this breaks.
      const pid = reportableEnding(cwd, runId, ledgerStatusOf(cwd, runId));
      if (pid !== null) {
        if (!reported) {
          ctx.stderr.write(abandonedLine(pid));
          reported = true;
        }
        break;
      }

      // Wait before polling again
      await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
    }
  } finally {
    process.off('SIGINT', onSigint);
    ctx.stdout.off('error', onError);
  }

  return EXIT.WIN;
}

/* -------------------------------------------------------------------------- */
/* The command                                                                 */
/* -------------------------------------------------------------------------- */

const traceCommand: Command = {
  name: 'trace',
  summary: 'Show the event stream for a run',
  usage: PROGRAM + ' trace <run-id> [flags]',
  group: 'additional',
  description: [
    'Show the event stream for a run.',
    'Every event recorded during the run is printed: dispatches, round starts and ends,\nverdicts, gate checks, budget spend, and errors. On a terminal the table is laid\nout in aligned columns; piped, it is one tab-delimited record per line with no\nheader row.',
    '--json writes one JSON object per line (NDJSON), with stable snake_case keys and\nevery optional field present as null. U+2028 and U+2029 are escaped so each line\nstays one line.',
    'Local model spend is exact at the reported session scope; nested piece/round\ndollar splits are unavailable with the current SDK. Distributed round queries\nhave exact reported piece/round spend. Retries retain every attempt receipt.',
    '-f/--follow polls for new events until the run finishes, until the process that was\nwriting it is gone, or until you interrupt with Ctrl+C. It reads through the same\nquery the non-following mode uses, at a different cadence; there is no socket, no\nserver, no second transport.',
    'An empty trace is a normal state: nothing on stdout, exit 0. The run may not have\nrecorded anything yet, or may have run with tracing off.',
    'A run killed outright cannot close its own trace, so a run the ledger still records as\nrunning whose lead process is gone is reported on stderr as finalized as failed, and a\nfollow stops there rather than waiting for an ending nobody is left to write. That is\nworked out from the pid at the moment you ask, never written back to the trace, and it\nchanges no exit code: the ledger and .exolvra-genesis/state.json still say what the run\nitself last said.',
    'Payload text is model-derived and treated as untrusted input: it is flattened\nbefore it is measured or drawn. --verbose shows it byte-verbatim instead.',
  ],
  flags,
  argument: runIdArgument,
  cwdFlag: directoryFlag,
  // An empty trace is a normal state, not an error
  emptyIsSuccess: true,
  examples: [
    PROGRAM + ' trace r-20260810-1712-a3f9c1',
    PROGRAM + ' trace r-20260810-1712-a3f9c1 --json',
    PROGRAM + ' trace r-20260810-1712-a3f9c1 -f',
    PROGRAM + ' trace r-20260810-1712-a3f9c1 --limit 10',
  ],
  run: runTrace,
};

registerCommand(traceCommand);

export { traceCommand };

async function runTrace(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseInvocation(traceCommand, argv, ctx);

  if (args.help) {
    ctx.stdout.write(renderCommandHelp(traceCommand));
    return EXIT.WIN;
  }

  const cwd = args.cwd;
  const runId = args.argument(runIdArgument);
  const limit = args.get(limitFlag) ?? DEFAULT_LIMIT;
  const json = args.bool(jsonFlag);
  const follow = args.bool(followFlag);
  const verbose = args.bool(verboseFlag);
  const view: Viewport = { tty: ctx.isTTY, width: ctx.width };

  // Resolve the run - throws UsageError if not found, ConfigError if corrupt
  const run = resolveRun(cwd, runId, traceCommand.usage);

  // A run killed mid-round cannot finalize its own trace: finalize() runs
  // in-process, and SIGKILL leaves no in-process anything. So the trace is
  // finalized as failed here, at read time, from the lead row the dead run left
  // open, the pid that no longer answers, and the ledger status that says the
  // run never settled. Nothing is written, and nothing but this reader's own
  // output depends on the answer: the exit code below is the same either way,
  // and neither the ledger nor state.json is touched (C1).
  const abandonedPid = reportableEnding(cwd, runId, run.status);
  if (abandonedPid !== null) {
    ctx.stderr.write(abandonedLine(abandonedPid));
  }

  // Handle EPIPE gracefully (stdout closed early, e.g., | head)
  let pipeError = false;
  const onError = (error: NodeJS.ErrnoException): void => {
    if (error.code === 'EPIPE') {
      pipeError = true;
    }
  };
  ctx.stdout.on('error', onError);

  try {
    if (follow) {
      return await followTrace(cwd, runId, ctx, view, json, verbose, abandonedPid !== null);
    }

    // Read the trace
    const reading = readTrace(cwd, runId, 0, limit);

    // Handle degraded (corrupt/unreadable) trace
    if (reading.degraded) {
      // Find the trace file to diagnose
      const tracePath = findTraceFile(cwd, runId);
      if (tracePath === null) {
        // No trace file exists - this is "no trace" not "corrupt"
        ctx.stderr.write('the run has no trace recorded\n');
        return EXIT.WIN;
      }

      // Check if it's a permission issue
      try {
        checkTraceReadable(tracePath);
        // Readable but corrupt
        throw new ConfigError(
          [
            'could not read the trace',
            '  ' + tracePath,
            '  the file exists but is not readable as a trace',
          ].join('\n'),
        );
      } catch (error) {
        if (error instanceof ConfigError) throw error;
        // checkTraceReadable threw for EACCES
        throw new ConfigError(
          [
            'could not read the trace',
            '  ' + tracePath,
          ].join('\n'),
        );
      }
    }

    // Empty trace is normal
    if (reading.records.length === 0) {
      ctx.stderr.write('the run has no trace recorded\n');
      return EXIT.WIN;
    }

    // Output the records
    if (json) {
      for (const record of reading.records) {
        if (pipeError) break;
        try {
          const line = escapeJsonLineSeparators(JSON.stringify(asJson(record, verbose)));
          ctx.stdout.write(line + '\n');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
            pipeError = true;
            break;
          }
          throw error;
        }
      }
    } else if (view.tty) {
      const lines = renderTraceTable(reading.records, view, verbose);
      for (const line of lines) {
        if (pipeError) break;
        try {
          ctx.stdout.write(line + '\n');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
            pipeError = true;
            break;
          }
          throw error;
        }
      }
    } else {
      const lines = renderTraceTsv(reading.records, verbose);
      for (const line of lines) {
        if (pipeError) break;
        try {
          ctx.stdout.write(line + '\n');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
            pipeError = true;
            break;
          }
          throw error;
        }
      }
    }

    return EXIT.WIN;
  } finally {
    ctx.stdout.off('error', onError);
  }
}
