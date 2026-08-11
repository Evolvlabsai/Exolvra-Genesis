import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { ConfigError } from './exit.js';

/**
 * The run ledger: what happened in this directory, and how to add to it.
 *
 * Every write is a temp file and a rename, so a reader sees the ledger either
 * as it was or as it now is, never half of a write. Every change is made under
 * a lock and reads the file again once it holds one, so two runs starting in
 * the same second queue up instead of overwriting each other: an atomic write
 * of a stale copy loses records exactly as thoroughly as a torn write does.
 *
 * What comes back out is checked field by field before any caller sees it — the
 * file is on disk where anything can edit it, so it is input like any other,
 * and a file this module cannot read is reported by name rather than quietly
 * started over.
 */

/* -------------------------------------------------------------------------- */
/* The record                                                                  */
/* -------------------------------------------------------------------------- */

export type RunStatus = 'running' | 'complete' | 'stopped' | 'blocked';

/** Every status, in the order they are listed back to the user. */
export const RUN_STATUSES: readonly RunStatus[] = [
  'running',
  'complete',
  'stopped',
  'blocked',
];

export interface RunRecord {
  id: string;
  sessionId: string | null;
  input: string;
  models: { lead: string; builder: string; critic: string };
  /** ISO 8601. */
  startedAt: string;
  status: RunStatus;
  lastVerdict?: string;
  rounds?: number;
  costUsd?: number;
}

/**
 * The statuses of a run that has not finished, so one that can be resumed.
 *
 * `blocked` is one of them. A blocked run is a run that stopped before it
 * reached a verdict — the provider failed, or something only the user can
 * settle stood in the way — and returning to its session is the remedy, which
 * is why `resume <id>` has always accepted one and why a run that ends blocked
 * prints the command to resume it. Leaving it out here made the picker disagree
 * with both: it would hide a run that resuming by name would have picked up,
 * and, with nothing but blocked runs recorded, would say there was nothing to
 * resume at all. Only `complete` is finished.
 */
export const UNFINISHED: readonly RunStatus[] = ['running', 'stopped', 'blocked'];

export function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value);
}

export function isUnfinished(record: RunRecord): boolean {
  return (UNFINISHED as readonly string[]).includes(record.status);
}

/**
 * The shape of a run id: what {@link newRunId} writes, and nothing wider.
 *
 * Letters, digits, dots, dashes and underscores, starting with a letter or a
 * digit, up to sixty-four of them. An id is typed on a command line, printed in
 * a column, and used to look a record up, so what it may not contain matters as
 * much as what it may: no whitespace, nothing a terminal would act on, no path
 * separator, and no leading dot — `../../etc/passwd` is not a run id, and this
 * is the one rule that says so.
 */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

/** A fresh id: the minute it started, and a random tail so two never collide. */
export function newRunId(at: Date = new Date()): string {
  const stamp = at.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return 'r-' + stamp + '-' + randomBytes(3).toString('hex');
}

/* -------------------------------------------------------------------------- */
/* Where it lives                                                              */
/* -------------------------------------------------------------------------- */

/** Where a run keeps what it records, under the directory it runs in. */
export const RUN_DIR = '.gauntlet';

export function runsPath(cwd: string): string {
  return join(cwd, RUN_DIR, 'runs.json');
}

export function statePath(cwd: string): string {
  return join(cwd, RUN_DIR, 'state.json');
}

/* -------------------------------------------------------------------------- */
/* Reading: the file is untrusted input                                        */
/* -------------------------------------------------------------------------- */

function kindOf(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a JSON array';
  if (typeof value === 'object') return 'a JSON object';
  return 'a JSON ' + typeof value;
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The ledger cannot be read, said the way every other fault here is said: the
 * complaint, the file it is about, and what to do next.
 *
 * Never a silent empty list: a ledger that cannot be parsed still holds runs,
 * and starting a new one over the top of it would lose them.
 */
function unreadable(path: string, detail: string): ConfigError {
  return new ConfigError(
    [
      'could not read the run ledger',
      '  ' + path,
      '  ' + detail,
      '  it is one JSON array of run records, written by gauntlet itself; move it',
      '  aside to start a new ledger, or repair it in place',
    ].join('\n'),
  );
}

function toModels(value: unknown): RunRecord['models'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const fields = value as Record<string, unknown>;
  const lead = fields['lead'];
  const builder = fields['builder'];
  const critic = fields['critic'];
  if (
    typeof lead !== 'string' ||
    typeof builder !== 'string' ||
    typeof critic !== 'string'
  ) {
    return undefined;
  }
  return { lead, builder, critic };
}

/** An optional field: absent and null both mean absent, anything else is typed. */
function optional<T>(
  value: unknown,
  is: (candidate: unknown) => candidate is T,
): { ok: true; value?: T } | { ok: false } {
  if (value === undefined || value === null) return { ok: true };
  if (is(value)) return { ok: true, value };
  return { ok: false };
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Turns one parsed entry into a record, or says in one phrase why it is not
 * one. The result is a fresh object: whatever else was in the file does not
 * travel on into a renderer.
 */
function toRecord(value: unknown): RunRecord | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'is ' + kindOf(value) + ', not a run record';
  }
  const fields = value as Record<string, unknown>;

  const id = fields['id'];
  if (typeof id !== 'string' || !isRunId(id)) {
    return 'has no usable "id": ' + kindOf(id);
  }
  const named = 'for "' + id + '"';

  const sessionId = fields['sessionId'];
  if (sessionId !== null && typeof sessionId !== 'string') {
    return '"sessionId" ' + named + ' is neither a string nor null';
  }
  const input = fields['input'];
  if (typeof input !== 'string') return '"input" ' + named + ' is not a string';

  const models = toModels(fields['models']);
  if (models === undefined) {
    return '"models" ' + named + ' does not name a lead, a builder and a critic';
  }
  const startedAt = fields['startedAt'];
  // Parsed, not merely present: an unreadable date is shown raw in a column
  // that says how long ago something was, and sorts by a comparison against
  // NaN, which quietly puts the ledger in an order nobody chose.
  if (typeof startedAt !== 'string' || !Number.isFinite(Date.parse(startedAt))) {
    return '"startedAt" ' + named + ' is not a time that can be read';
  }
  const status = fields['status'];
  if (typeof status !== 'string' || !isRunStatus(status)) {
    return '"status" ' + named + ' is not one of ' + RUN_STATUSES.join(', ');
  }

  const record: RunRecord = { id, sessionId, input, models, startedAt, status };

  const verdict = optional(fields['lastVerdict'], isString);
  if (!verdict.ok) return '"lastVerdict" ' + named + ' is not a string';
  if (verdict.value !== undefined) record.lastVerdict = verdict.value;

  const rounds = optional(fields['rounds'], isNumber);
  if (!rounds.ok) return '"rounds" ' + named + ' is not a number';
  if (rounds.value !== undefined) record.rounds = rounds.value;

  const cost = optional(fields['costUsd'], isNumber);
  if (!cost.ok) return '"costUsd" ' + named + ' is not a number';
  if (cost.value !== undefined) record.costUsd = cost.value;

  return record;
}

/**
 * How many times a read is tried while something else has the file, and how
 * long each wait is. A write holds the name for the length of one rename, so
 * this is far longer than any of them.
 */
const READ_ATTEMPTS = 40;
const READ_PAUSE_MS = 8;

/**
 * The ledger's text, or undefined when there is no ledger.
 *
 * Windows refuses to open a file at the instant it is being renamed over, so a
 * listing that happens to land on the moment a run records something would
 * otherwise be told the ledger cannot be read — which is a sentence about a
 * corrupt file, said about a perfectly good one. A refusal like that is waited
 * out; one that lasts is reported as what it is.
 */
function readLedger(path: string): string | undefined {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt >= READ_ATTEMPTS) {
        throw unreadable(path, reasonFor(error));
      }
      pause(1 + Math.floor(Math.random() * READ_PAUSE_MS));
    }
  }
}

/**
 * Every run recorded under `cwd`, in the order they were recorded.
 *
 * A directory with no ledger has no runs, which is not a fault. A ledger that
 * is there and cannot be read is one, and it is reported naming the file.
 */
export function readRuns(cwd: string): RunRecord[] {
  const path = runsPath(cwd);

  const text = readLedger(path);
  if (text === undefined) return [];

  // Nothing this module writes is empty, so an empty file is a write that was
  // cut off — which is exactly the case that must not read as "no runs".
  if (text.trim() === '') {
    throw unreadable(path, 'the file is empty, so a write of it did not finish');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw unreadable(path, reasonFor(error));
  }
  if (!Array.isArray(parsed)) {
    throw unreadable(path, 'it holds ' + kindOf(parsed) + ', not a JSON array');
  }

  const runs: RunRecord[] = [];
  // An id is how a run is named, resumed, and updated, so two records under one
  // id is not something to resolve by picking one: whichever were picked, the
  // other run's record would be the one silently acted on half the time.
  const seen = new Map<string, number>();

  parsed.forEach((entry, index) => {
    const record = toRecord(entry);
    if (typeof record === 'string') {
      throw unreadable(path, 'record ' + (index + 1) + ' ' + record);
    }
    const first = seen.get(record.id);
    if (first !== undefined) {
      throw unreadable(
        path,
        'record ' +
          (index + 1) +
          ' repeats the id "' +
          record.id +
          '", which record ' +
          first +
          ' already used',
      );
    }
    seen.set(record.id, index + 1);
    runs.push(record);
  });
  return runs;
}

/** What `.gauntlet/state.json` says, and how to say it back to the user. */
export interface StateReading {
  status: RunStatus | undefined;
  /** One phrase naming what was found, for printing under the file's path. */
  detail: string;
}

/**
 * Reads the status file the run itself writes.
 *
 * Tolerant on purpose, and never silent about it: this is a question about
 * another writer's file, asked after the work is done, so a missing or
 * unreadable one is an answer of "no status" with the reason attached rather
 * than a fault that throws away what the session produced.
 */
export function readState(cwd: string): StateReading {
  const path = statePath(cwd);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status: undefined,
      detail:
        code === 'ENOENT' ? 'it was never written' : 'it could not be read: ' + reasonFor(error),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { status: undefined, detail: 'it is not readable JSON: ' + reasonFor(error) };
  }
  const status =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)['status']
      : undefined;
  if (typeof status !== 'string' || !isRunStatus(status)) {
    return { status: undefined, detail: 'it does not say what the run\'s status is' };
  }
  return { status, detail: 'it says "' + status + '"' };
}

/* -------------------------------------------------------------------------- */
/* Writing: a temp file and a rename, every time                               */
/* -------------------------------------------------------------------------- */

/** Distinguishes temp files written by one process from each other. */
let sequence = 0;

/**
 * How long a rename is retried before the write is called a failure.
 *
 * Windows refuses to rename over a file that anything else has open, so a run
 * listing its own ledger while another writes to it can be told no for reasons
 * that have nothing to do with the write. Eight hundred tries of a few
 * milliseconds is a few seconds at worst, and nothing at all in the ordinary
 * case, where the first one succeeds. Waiting is right where failing is not:
 * the alternative to a slow write here is a lost record.
 */
const RENAME_ATTEMPTS = 800;
const RENAME_PAUSE_MS = 8;

/**
 * A synchronous pause, so a write stays one step from the caller's point of
 * view even when the rename has to be tried again.
 */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Renames over the destination, retrying the refusals Windows raises while
 * something else has the file open — a reader, an indexer, a virus scanner. The
 * rename is what makes the write atomic; a transient refusal of it is not a
 * reason to leave the ledger half written.
 *
 * The wait is jittered rather than fixed. A reader polling on one timer and a
 * writer retrying on another settle into step with each other, and two loops in
 * step retry at exactly the moment that failed last time, for as long as either
 * of them keeps it up.
 */
function replace(from: string, to: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt >= RENAME_ATTEMPTS) throw error;
      pause(1 + Math.floor(Math.random() * RENAME_PAUSE_MS));
    }
  }
}

/**
 * Writes `text` to `path` as one step: a temp file beside it, then a rename
 * over it. A reader never sees a partial file, and a write that fails leaves
 * the previous contents exactly as they were.
 */
function writeAtomic(path: string, text: string): void {
  const directory = dirname(path);
  const temp = join(
    directory,
    '.' + basename(path) + '.' + process.pid + '.' + (sequence += 1) + '.tmp',
  );
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temp, text, 'utf8');
    replace(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new ConfigError(
      [
        'could not write ' + basename(path),
        '  ' + path,
        '  ' + reasonFor(error),
        '  check that the directory is writable, and that nothing else is holding',
        '  the file open',
      ].join('\n'),
    );
  }
}

function serialize(runs: readonly RunRecord[]): string {
  return JSON.stringify(runs, null, 2) + '\n';
}

/* -------------------------------------------------------------------------- */
/* The lock: one writer at a time, from read to write                          */
/* -------------------------------------------------------------------------- */

/** Where a writer's claim on the ledger sits while it holds one. */
export function lockPath(cwd: string): string {
  return join(cwd, RUN_DIR, 'runs.json.lock');
}

/**
 * How long a writer waits for its turn. A turn is a read, a write and a rename
 * — a few milliseconds — so this is many turns' worth of waiting, and a run is
 * told it cannot record rather than made to wait past it.
 */
const LOCK_ATTEMPTS = 1500;
const LOCK_PAUSE_MS = 8;

/**
 * How old a lock has to be before it is taken as abandoned.
 *
 * Three orders of magnitude longer than any turn takes, so a lock this old is
 * one a process died holding, not one still in use. Only two are ever broken in
 * a single wait: a lock that keeps coming back is a live writer, not litter.
 */
const LOCK_STALE_MS = 30_000;
const LOCKS_BROKEN_LIMIT = 2;

/**
 * How many refusals that are not "somebody has it" are absorbed before the
 * directory is called unwritable.
 *
 * Windows answers a `mkdir` of a name another process is at that instant
 * deleting with a refusal rather than with "it exists" — the same lock, from
 * the far side of its release. Those pass in microseconds; a directory that
 * really cannot be written to answers the same way every time, and is reported
 * after a fifth of a second rather than after the whole wait.
 */
const LOCK_REFUSAL_LIMIT = 50;

function ageOf(path: string): number | undefined {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Removes a lock, tolerating another process having removed it first. */
function release(lock: string): void {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      rmSync(lock, { recursive: true, force: true });
      return;
    } catch {
      pause(1 + Math.floor(Math.random() * LOCK_PAUSE_MS));
    }
  }
  // Left behind rather than thrown over the result of the work it guarded: a
  // lock nobody holds is the case the staleness check above exists to clear.
}

/**
 * Runs `change` with the ledger locked to this process.
 *
 * A directory is the lock: creating one is a single atomic step on every
 * filesystem this runs on — it either exists already or this call is what made
 * it — so no two processes can both believe they have it. An atomic write alone
 * would not be enough, because the losing writer's file is a whole, valid,
 * atomically written ledger that is simply missing the other's record.
 */
function withLedgerLock<T>(cwd: string, change: () => T): T {
  const lock = lockPath(cwd);
  mkdirSync(dirname(lock), { recursive: true });

  let broken = 0;
  let refusals = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        refusals = 0;
      } else if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
        refusals += 1;
        if (refusals >= LOCK_REFUSAL_LIMIT) throw unwritableLock(lock, error);
      } else {
        throw unwritableLock(lock, error);
      }

      const age = ageOf(lock);
      if (age !== undefined && age > LOCK_STALE_MS && broken < LOCKS_BROKEN_LIMIT) {
        broken += 1;
        release(lock);
        continue;
      }
      if (attempt >= LOCK_ATTEMPTS) {
        throw new ConfigError(
          [
            'the run ledger stayed locked by another run',
            '  ' + lock,
            '  nothing was written, so no record was lost',
            '  if no run is using it, remove that directory and try again',
          ].join('\n'),
        );
      }
      pause(1 + Math.floor(Math.random() * LOCK_PAUSE_MS));
    }
  }

  try {
    return change();
  } finally {
    release(lock);
  }
}

function unwritableLock(lock: string, error: unknown): ConfigError {
  return new ConfigError(
    [
      'could not take the lock on the run ledger',
      '  ' + lock,
      '  ' + reasonFor(error),
      '  check that the directory is writable',
    ].join('\n'),
  );
}

/** The record a caller handed over, checked against what a reader will accept. */
function accepted(value: unknown): RunRecord {
  const record = toRecord(value);
  if (typeof record === 'string') {
    throw new Error('not a run record: it ' + record);
  }
  return record;
}

/**
 * Adds one run to the ledger under `cwd`, creating it if it is not there yet.
 *
 * The ledger is read again inside the lock rather than kept in memory, so
 * whatever was recorded between this call and its turn — by another run, or by
 * the agent itself — is carried forward instead of being written over.
 */
export function appendRun(cwd: string, rec: RunRecord): void {
  const record = accepted(rec);
  withLedgerLock(cwd, () => {
    const runs = readRuns(cwd);
    if (runs.some((existing) => existing.id === record.id)) {
      throw new Error('a run is already recorded as "' + record.id + '"');
    }
    writeAtomic(runsPath(cwd), serialize([...runs, record]));
  });
}

/**
 * Applies `patch` to the run recorded as `id` and returns the record as it now
 * stands. Every other record is read and written back untouched.
 *
 * Read and write are one step, under the same lock an append takes: a record
 * this process has just added cannot have gone missing by the time it updates
 * it, and an update never carries someone else's record back to how it was.
 */
export function updateRun(
  cwd: string,
  id: string,
  patch: Partial<RunRecord>,
): RunRecord {
  if (patch.id !== undefined && patch.id !== id) {
    throw new Error('a run keeps the id it was recorded under');
  }
  return withLedgerLock(cwd, () => {
    const runs = readRuns(cwd);
    const index = runs.findIndex((record) => record.id === id);
    if (index === -1) {
      throw new ConfigError(
        [
          'no run is recorded as "' + id + '"',
          '  ' + runsPath(cwd),
          '  run `gauntlet runs` to see the ids the ledger holds',
        ].join('\n'),
      );
    }

    // A field explicitly set to undefined is a field the caller left alone, not
    // one they asked to remove; removing it would drop it out of the record.
    const changes = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    const merged = accepted({ ...runs[index], ...changes, id });
    const next = [...runs];
    next[index] = merged;
    writeAtomic(runsPath(cwd), serialize(next));
    return merged;
  });
}

/**
 * Writes `.gauntlet/state.json`.
 *
 * The one file outside this CLI's own output that something else reads: the
 * Stop hook the plugin ships greps it for a running status, so the shape it is
 * written in — one object, one `"status"` key, one space after the colon — is
 * part of the contract and not a formatting choice.
 */
export function writeState(cwd: string, status: RunStatus): void {
  if (!isRunStatus(status)) {
    throw new Error('"' + String(status) + '" is not a run status');
  }
  writeAtomic(statePath(cwd), JSON.stringify({ status }, null, 2) + '\n');
}
