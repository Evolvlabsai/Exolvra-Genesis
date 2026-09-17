/**
 * The run trace store: one event stream per run, persisted to disk.
 *
 * Two engines, one contract: SQLite when `node:sqlite` is available, NDJSON
 * when it is not. A caller cannot tell which engine was selected except by reading
 * `store.engine`. Nothing in this module throws to its caller, ever — a
 * failure warns once through `onWarning` and every later call is a no-op.
 *
 * The store lives under `.exolvra-genesis/trace/` in the target project. It
 * holds every durability property `runs-store.ts` already holds, with one
 * deliberate difference: where the ledger treats a write failure as fatal, the
 * trace warns once and carries on, because observability must never become a
 * new way to lose work.
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { isRunId, runDirectory } from './runs-store.js';

/* -------------------------------------------------------------------------- */
/* The contract — frozen in CONTRACT.md, copied verbatim                       */
/* -------------------------------------------------------------------------- */

/** One event, as it sits in the store. */
export interface TraceRecord {
  /** Position in this run's stream, starting at 1. The cursor is this number. */
  seq: number;
  /** Unix milliseconds when the event was recorded. */
  at: number;
  /** The run the event belongs to. */
  runId: string;
  /** The event kind, from the closed vocabulary T2 declares. */
  kind: string;
  /** The piece the event concerned, or null. */
  piece: string | null;
  /** The round the event concerned, counting from 1, or null. */
  round: number | null;
  /** Everything else. Already redacted and flattened. JSON-serialisable. */
  payload: Record<string, unknown>;
}

/** What a read hands back. */
export interface TraceReading {
  records: readonly TraceRecord[];
  /** Pass as `after` on the next read to continue. Equals the last seq read. */
  cursor: number;
  /** True when the store could not be read. `records` is then empty. */
  degraded: boolean;
}

/** One live or finished subagent, mapped to its run. */
export interface TraceProcess {
  runId: string;
  /** The subagent or task identifier, as the SDK reports it. */
  taskId: string;
  role: 'lead' | 'builder' | 'critic';
  piece: string | null;
  round: number | null;
  openedAt: number;
  /** Null while it is still open. */
  closedAt: number | null;
  /** Null while open. */
  outcome: 'complete' | 'failed' | 'died' | null;
  /**
   * The OS process id that opened this row, or null if not recorded.
   * Null means "not recorded" — a row written by an older build, or a row for
   * something that is not an OS process. It must never be confused with "dead".
   */
  pid: number | null;
}

export interface TraceStore {
  readonly engine: 'sqlite' | 'ndjson';
  /** True once a failure has been warned about. Nothing throws out of here. */
  readonly degraded: boolean;
  append(record: Omit<TraceRecord, 'seq'>): void;
  read(after?: number, limit?: number): TraceReading;
  openProcess(p: Omit<TraceProcess, 'closedAt' | 'outcome' | 'pid'> & { pid?: number | null }): void;
  closeProcess(taskId: string, outcome: NonNullable<TraceProcess['outcome']>): void;
  /** Every process still open is closed as `died`. Called on every exit path. */
  finalize(outcome: NonNullable<TraceProcess['outcome']>): void;
  processes(): readonly TraceProcess[];
  close(): void;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

const TRACE_DIR = '.exolvra-genesis/trace';

/** Existing stores remain readable; new ledger-backed runs own their trace. */
export function traceDirectory(cwd: string, runId: string): string {
  if (!isRunId(runId)) throw new Error('invalid trace run id');
  const legacy = join(cwd, TRACE_DIR);
  if (existsSync(legacy) && !statSync(legacy).isDirectory()) return legacy;
  if (existsSync(join(legacy, runId + '.db')) || existsSync(join(legacy, runId + '.ndjson'))) return legacy;
  const root = runDirectory(cwd, runId);
  return existsSync(root) ? join(root, 'trace') : legacy;
}

/**
 * TEST SEAM: Fault injection for ENOSPC.
 *
 * When EXOLVRA_GENESIS_TRACE_INJECT_ENOSPC is set, both engines' append
 * operations will throw ENOSPC instead of writing. This allows testing
 * the disk-full handler without actually filling the disk.
 *
 * The seam is stateless: set means "this write fails with ENOSPC",
 * unset means "write normally". Tests control behaviour by setting or
 * deleting the env var between append calls.
 *
 * This seam is internal and NOT exported. It has zero cost when unset.
 */
function checkEnospcInjection(): boolean {
  const envVal = process.env['EXOLVRA_GENESIS_TRACE_INJECT_ENOSPC'];
  return envVal !== undefined && envVal !== '' && envVal !== '0';
}

/**
 * TEST SEAM: Fault injection for EACCES on read.
 *
 * When EXOLVRA_GENESIS_TRACE_INJECT_READ_EACCES is set, NDJSON read
 * operations will throw EACCES instead of reading. This allows testing
 * the read EACCES handler without actually making files unreadable.
 */
function checkReadEaccesInjection(): boolean {
  const envVal = process.env['EXOLVRA_GENESIS_TRACE_INJECT_READ_EACCES'];
  return envVal !== undefined && envVal !== '' && envVal !== '0';
}

/**
 * TEST SEAM: Park a read partway through, inside its critical section.
 *
 * When EXOLVRA_GENESIS_TRACE_PARK_READ_MS is set to a number, NDJSON read
 * operations will pause for that duration AFTER acquiring any locks or entering
 * any critical section, but BEFORE releasing. This allows testing N6 ("reads
 * never block writes") with a discriminating delay: if a read acquires the
 * write lock, parking here holds the write lock and stops writers; if a read
 * takes no write lock, parking here holds nothing and writers run through.
 *
 * SQLite reads open a separate connection and never take a write lock (WAL mode),
 * so parking here holds nothing and writers continue.
 */
function checkReadParkMs(): number {
  const envVal = process.env['EXOLVRA_GENESIS_TRACE_PARK_READ_MS'];
  const parsed = envVal ? parseInt(envVal, 10) : 0;
  return parsed > 0 ? parsed : 0;
}

/** Lock age in ms when a lock is considered stale. */
const STALE_LOCK_MS = 30_000;

/** Maximum times a stale lock can be broken before giving up. */
const STALE_BREAK_CAP = 2;

/**
 * Lock acquisition policy: a pure function deciding what to do given the lock
 * state. This separates the decision from the I/O operations.
 *
 * @param lockAgeMs - The age of the existing lock in milliseconds, or null if
 *   the lock does not exist or could not be stat'd.
 * @param broken - How many times we have already broken a stale lock.
 * @returns 'acquire' if no lock exists, 'break' if the lock is stale and we
 *   have not hit the cap, 'wait' if we should retry later, 'give-up' if we
 *   have hit the cap after repeated stale-lock breaks.
 */
function lockPolicy(
  lockAgeMs: number | null,
  broken: number,
): 'acquire' | 'break' | 'wait' | 'give-up' {
  // No lock or lock was just removed by someone else: try to acquire
  if (lockAgeMs === null) {
    return 'acquire';
  }
  // Lock exists and is stale: break it if we have not hit the cap
  if (lockAgeMs > STALE_LOCK_MS) {
    if (broken < STALE_BREAK_CAP) {
      return 'break';
    }
    // We have broken the lock twice and it keeps reappearing stale
    // This is the cap: give up to avoid breaking other processes' locks forever
    return 'give-up';
  }
  // Lock exists but is not stale: wait and retry
  return 'wait';
}

/**
 * How many times a write or lock is retried while something else has the file.
 * Transient Windows file-lock faults (EPERM/EACCES/EBUSY) are retried.
 * SQLite concurrent writes need enough retries to wait out the lock.
 *
 * Why 200: With RETRY_PAUSE_MS = 8, the retry window is ~1.6 seconds. This is
 * long enough to outlast typical transient faults (antivirus scans, Windows
 * Search indexing, file-handle inheritance races) without blocking so long
 * that the CLI feels hung. Empirically, 40 retries (~320ms) was too short for
 * SQLite under heavy WAL checkpoint activity; 200 gives comfortable headroom.
 *
 * SQLite stale-lock recovery note: SQLite manages its own locking via WAL mode
 * and SQLITE_BUSY retries. The property "recovered, not waited on forever" is
 * satisfied differently here: the RETRY_ATTEMPTS * RETRY_PAUSE_MS window (~1.6s)
 * bounds the wait, and SQLite's internal busy handler handles lock contention.
 * NDJSON uses explicit directory locks with 30s stale-lock recovery; SQLite
 * uses bounded retry instead, which is parity with runs-store.ts behavior.
 */
const RETRY_ATTEMPTS = 200;
const RETRY_PAUSE_MS = 8;

/** A synchronous pause. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isTransient(code: string | undefined): boolean {
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

/**
 * Calls onWarning safely. A throwing onWarning must not propagate to the
 * caller — R6 says nothing in this module throws, and that includes callbacks
 * the caller passed in. If the callback throws, the throw is swallowed.
 */
function safeWarn(onWarning: (message: string) => void, message: string): void {
  try {
    onWarning(message);
  } catch {
    // Swallowed: a throwing onWarning must not break the store contract.
  }
}

/**
 * Checks if an error message indicates a transient SQLite lock condition.
 * SQLite throws "database is locked" (SQLITE_BUSY) or "database is busy"
 * when another connection holds a lock.
 */
function isSqliteBusy(msg: string): boolean {
  return msg.includes('database is locked') || msg.includes('database is busy') || msg.includes('SQLITE_BUSY');
}

/* -------------------------------------------------------------------------- */
/* Engine loading                                                              */
/* -------------------------------------------------------------------------- */

type DatabaseSync = {
  new (
    location: string,
    options?: { readOnly?: boolean },
  ): {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
    };
    close(): void;
  };
};

let sqliteModule: { DatabaseSync: DatabaseSync } | undefined;
let sqliteChecked = false;

/**
 * Reads EXOLVRA_GENESIS_TRACE_ENGINE at call time.
 * Values: 'sqlite' | 'ndjson' | undefined (auto-detect).
 */
function getEngineOverride(): 'sqlite' | 'ndjson' | undefined {
  const val = process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];
  if (val === 'sqlite' || val === 'ndjson') return val;
  return undefined;
}

/**
 * Attempt to load `node:sqlite`. We suppress the ExperimentalWarning scoped to
 * this import only by wrapping process.emitWarning.
 */
function tryLoadSqlite(): { DatabaseSync: DatabaseSync } | undefined {
  const override = getEngineOverride();
  if (override === 'ndjson') return undefined;

  // If forcing sqlite, reset cache so we try again
  if (override === 'sqlite') {
    sqliteChecked = false;
    sqliteModule = undefined;
  }

  if (sqliteChecked) return sqliteModule;
  sqliteChecked = true;

  // Save the original emitWarning
  const originalEmitWarning = process.emitWarning;

  // Replace with a wrapper that suppresses the SQLite ExperimentalWarning
  process.emitWarning = function (
    warning: string | Error,
    ...args: unknown[]
  ): void {
    // Check if this is the SQLite experimental warning
    const message = typeof warning === 'string' ? warning : warning.message;
    const typeArg = args[0];
    const isExperimental =
      (typeof typeArg === 'string' && typeArg === 'ExperimentalWarning') ||
      (typeof typeArg === 'object' &&
        typeArg !== null &&
        (typeArg as { type?: string }).type === 'ExperimentalWarning');

    if (isExperimental && message.includes('SQLite')) {
      // Suppress this specific warning
      return;
    }

    // Forward everything else to the original
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalEmitWarning as any).call(process, warning, ...args);
  };

  try {
    // Use createRequire for ESM compatibility
    const esmRequire = createRequire(import.meta.url);
    const mod = esmRequire('node:sqlite') as { DatabaseSync: DatabaseSync };
    sqliteModule = mod;
    return mod;
  } catch {
    return undefined;
  } finally {
    // Always restore the original, synchronously
    process.emitWarning = originalEmitWarning;
  }
}

/* -------------------------------------------------------------------------- */
/* SQLite engine                                                               */
/* -------------------------------------------------------------------------- */

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

function createSqliteStore(
  db: SqliteDb,
  dbPath: string,
  _runId: string,
  onWarning: (message: string) => void,
): TraceStore {
  let degraded = false;
  let warned = false;
  let closed = false;
  let finalized = false;

  /**
   * Warns once and marks the store as degraded (genuinely unusable).
   * Used for structural failures: corrupt db, unwritable directory.
   */
  function degrade(message: string): void {
    if (!warned) {
      warned = true;
      degraded = true;
      safeWarn(onWarning, message);
    }
  }

  /**
   * Warns once but does NOT degrade the store.
   * Used for per-record failures: disk full, retry exhausted on one write.
   */
  function warnOnce(message: string): void {
    if (!warned) {
      warned = true;
      safeWarn(onWarning, message);
    }
  }

  // Initialize schema with retry logic for concurrent access
  let schemaInitialized = false;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS && !schemaInitialized; attempt += 1) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          runId TEXT NOT NULL,
          kind TEXT NOT NULL,
          piece TEXT,
          round INTEGER,
          payload TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS processes (
          taskId TEXT PRIMARY KEY,
          runId TEXT NOT NULL,
          role TEXT NOT NULL,
          piece TEXT,
          round INTEGER,
          openedAt INTEGER NOT NULL,
          closedAt INTEGER,
          outcome TEXT,
          pid INTEGER
        )
      `);
      db.exec('PRAGMA journal_mode = WAL');
      // Set busy timeout: wait up to 10 seconds for locks
      // This handles concurrent writer contention at the SQLite level
      db.exec('PRAGMA busy_timeout = 10000');
      schemaInitialized = true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // "file is not a database" from SQLite means the file exists but is corrupt - no retry
      if (msg.includes('not a database')) {
        degrade(dbPath + ' is not readable as a trace: ' + msg);
        break;
      }
      // Retry on SQLite busy (database is locked)
      if (isSqliteBusy(msg) && attempt < RETRY_ATTEMPTS) {
        pause(1 + Math.floor(Math.random() * RETRY_PAUSE_MS));
        continue;
      }
      degrade('could not initialize trace store ' + dbPath + ': ' + msg + '; the run continues');
    }
  }

  return {
    get engine(): 'sqlite' {
      return 'sqlite';
    },
    get degraded(): boolean {
      return degraded;
    },

    append(record: Omit<TraceRecord, 'seq'>): void {
      if (degraded || closed) return;
      for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
        try {
          // TEST SEAM: inject ENOSPC if configured
          if (checkEnospcInjection()) {
            const err = new Error('SQLITE_FULL: database or disk is full') as NodeJS.ErrnoException;
            err.code = 'ENOSPC';
            throw err;
          }
          const stmt = db.prepare(
            'INSERT INTO events (at, runId, kind, piece, round, payload) VALUES (?, ?, ?, ?, ?, ?)',
          );
          stmt.run(
            record.at,
            record.runId,
            record.kind,
            record.piece,
            record.round,
            JSON.stringify(record.payload),
          );
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          const msg = error instanceof Error ? error.message : String(error);
          // ENOSPC: disk full - structural failure, degrade
          if (code === 'ENOSPC' || msg.includes('database or disk is full')) {
            degrade('disk full writing to trace store ' + dbPath + '; the run continues');
            return;
          }
          // Retry on transient file locks or SQLite busy
          const shouldRetry = isTransient(code) || isSqliteBusy(msg);
          if (shouldRetry && attempt < RETRY_ATTEMPTS) {
            pause(1 + Math.floor(Math.random() * RETRY_PAUSE_MS));
            continue;
          }
          // Retry exhausted: per-record failure, warn but don't degrade
          warnOnce('could not write to trace store ' + dbPath + ': ' + msg + '; the run continues');
          return;
        }
      }
    },

    read(after = 0, limit = 1000): TraceReading {
      if (degraded || closed) {
        return { records: [], cursor: after, degraded };
      }
      try {
        const stmt = db.prepare(
          'SELECT seq, at, runId, kind, piece, round, payload FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?',
        );
        const rows = stmt.all(after, limit) as Array<{
          seq: number;
          at: number;
          runId: string;
          kind: string;
          piece: string | null;
          round: number | null;
          payload: string;
        }>;
        // TEST SEAM: park after read, inside the critical section (which for SQLite
        // is a separate read-only connection — holds nothing a writer needs).
        const parkMs = checkReadParkMs();
        if (parkMs > 0) {
          pause(parkMs);
        }
        const records: TraceRecord[] = rows.map((row) => ({
          seq: row.seq,
          at: row.at,
          runId: row.runId,
          kind: row.kind,
          piece: row.piece,
          round: row.round,
          payload: JSON.parse(row.payload) as Record<string, unknown>,
        }));
        const last = records[records.length - 1];
        return {
          records,
          cursor: last !== undefined ? last.seq : after,
          degraded: false,
        };
      } catch (error) {
        degrade(
          'could not read trace store ' +
            dbPath +
            ': ' +
            (error instanceof Error ? error.message : String(error)),
        );
        return { records: [], cursor: after, degraded: true };
      }
    },

    openProcess(p: Omit<TraceProcess, 'closedAt' | 'outcome' | 'pid'> & { pid?: number | null }): void {
      if (degraded || closed) return;
      try {
        const stmt = db.prepare(
          'INSERT OR REPLACE INTO processes (taskId, runId, role, piece, round, openedAt, closedAt, outcome, pid) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)',
        );
        stmt.run(p.taskId, p.runId, p.role, p.piece, p.round, p.openedAt, p.pid ?? null);
      } catch (error) {
        warnOnce(
          'could not write process to trace store ' +
            dbPath +
            ': ' +
            (error instanceof Error ? error.message : String(error)) +
            '; the run continues',
        );
      }
    },

    closeProcess(taskId: string, outcome: NonNullable<TraceProcess['outcome']>): void {
      if (degraded || closed) return;
      try {
        const stmt = db.prepare(
          'UPDATE processes SET closedAt = ?, outcome = ? WHERE taskId = ? AND closedAt IS NULL',
        );
        stmt.run(Date.now(), outcome, taskId);
      } catch (error) {
        warnOnce(
          'could not update process in trace store ' +
            dbPath +
            ': ' +
            (error instanceof Error ? error.message : String(error)) +
            '; the run continues',
        );
      }
    },

    finalize(outcome: NonNullable<TraceProcess['outcome']>): void {
      // Idempotent: second call is a no-op
      if (finalized) return;
      finalized = true;
      // If already degraded, return silently (no second warning)
      if (degraded || closed) return;
      try {
        const stmt = db.prepare(
          'UPDATE processes SET closedAt = ?, outcome = ? WHERE closedAt IS NULL',
        );
        stmt.run(Date.now(), outcome);
      } catch {
        // Finalize must not throw or warn again if already degraded
      }
    },

    processes(): readonly TraceProcess[] {
      if (degraded || closed) return [];
      try {
        const stmt = db.prepare(
          'SELECT taskId, runId, role, piece, round, openedAt, closedAt, outcome, pid FROM processes',
        );
        const rows = stmt.all() as Array<{
          taskId: string;
          runId: string;
          role: string;
          piece: string | null;
          round: number | null;
          openedAt: number;
          closedAt: number | null;
          outcome: string | null;
          pid: number | null;
        }>;
        return rows.map((row) => ({
          taskId: row.taskId,
          runId: row.runId,
          role: row.role as TraceProcess['role'],
          piece: row.piece,
          round: row.round,
          openedAt: row.openedAt,
          closedAt: row.closedAt,
          outcome: row.outcome as TraceProcess['outcome'],
          pid: row.pid,
        }));
      } catch {
        return [];
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } catch {
        // Best effort
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* NDJSON engine                                                               */
/* -------------------------------------------------------------------------- */

interface NdjsonLine {
  type: 'event' | 'process';
  data: TraceRecord | TraceProcess;
}

function createNdjsonStore(
  eventsPath: string,
  _runId: string,
  onWarning: (message: string) => void,
): TraceStore {
  let degraded = false;
  let warned = false;
  let closed = false;
  let finalized = false;
  let seq = 0;
  const processes = new Map<string, TraceProcess>();

  // Lock path: directory-based lock for concurrent writer serialization
  const lockPath = eventsPath + '.lock';

  /**
   * Warns once and marks the store as degraded (genuinely unusable).
   * Used for structural failures: unwritable directory, unacquirable lock.
   */
  function degrade(message: string): void {
    if (!warned) {
      warned = true;
      degraded = true;
      safeWarn(onWarning, message);
    }
  }

  /**
   * Warns once but does NOT degrade the store.
   * Used for per-record failures: disk full, retry exhausted on one write.
   */
  function warnOnce(message: string): void {
    if (!warned) {
      warned = true;
      safeWarn(onWarning, message);
    }
  }

  /**
   * Acquires a directory lock, runs the callback, then releases.
   * Implements stale-lock recovery using lockPolicy for decisions.
   */
  function withLock<T>(fn: () => T): T | undefined {
    if (degraded) return undefined;

    const dir = dirname(lockPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOTDIR: a file exists where we need a directory - structural failure
      if (code === 'ENOTDIR') {
        degrade('could not create trace directory ' + dir + ' (a file exists at that path); the run continues');
        return undefined;
      }
      if (!isTransient(code)) {
        degrade('could not create trace directory ' + dir + '; the run continues');
        return undefined;
      }
    }

    let broken = 0;

    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
      try {
        mkdirSync(lockPath);
        // Lock acquired successfully
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          // Lock exists - check age and ask policy what to do
          let lockAgeMs: number | null = null;
          try {
            lockAgeMs = Date.now() - statSync(lockPath).mtimeMs;
          } catch {
            // Lock was removed between mkdirSync and statSync - treat as no lock
            lockAgeMs = null;
          }

          const decision = lockPolicy(lockAgeMs, broken);
          if (decision === 'acquire') {
            // Lock was removed - try to acquire on next iteration
            continue;
          } else if (decision === 'break') {
            broken += 1;
            rmSync(lockPath, { recursive: true, force: true });
            continue;
          } else if (decision === 'give-up') {
            // Per-record failure: warn once but store remains usable
            warnOnce('trace store stayed locked by another process; the run continues');
            return undefined;
          }
          // decision === 'wait': fall through to retry
        } else if (!isTransient(code)) {
          // Structural failure: cannot create lock at all
          degrade('could not take lock on trace store ' + lockPath + '; the run continues');
          return undefined;
        }

        if (attempt >= RETRY_ATTEMPTS) {
          // Per-record failure: retry exhausted for this append
          warnOnce('trace store stayed locked by another process; the run continues');
          return undefined;
        }
        pause(1 + Math.floor(Math.random() * RETRY_PAUSE_MS));
      }
    }

    try {
      return fn();
    } finally {
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // Best effort release
      }
    }
  }

  /** Tracks whether the file ends with a newline, so we know to prefix writes. */
  let fileEndsWithNewline = true;

  /**
   * Atomic append: write one complete line ending in \n in a single write call.
   * A trailing partial line (from a kill mid-append) is ignored by readers.
   * If the file doesn't end with a newline (partial line from crash), we prefix
   * with \n to ensure our new line starts fresh.
   */
  function appendLine(line: NdjsonLine): void {
    if (degraded || closed) return;

    withLock(() => {
      // If file doesn't end with newline, prefix to start on new line
      const prefix = fileEndsWithNewline ? '' : '\n';
      const text = prefix + JSON.stringify(line) + '\n';
      for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
        try {
          appendFileSync(eventsPath, text, { encoding: 'utf8' });
          fileEndsWithNewline = true; // We just wrote a \n at the end
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // ENOSPC: disk full - structural failure, degrade
          if (code === 'ENOSPC') {
            degrade(
              'disk full writing to trace store ' + eventsPath + '; the run continues',
            );
            return;
          }
          // Retry on transient file locks
          if (isTransient(code) && attempt < RETRY_ATTEMPTS) {
            pause(1 + Math.floor(Math.random() * RETRY_PAUSE_MS));
            continue;
          }
          // Retry exhausted: per-record failure, warn but don't degrade
          warnOnce(
            'could not write to trace store ' +
              eventsPath +
              ': ' +
              (error instanceof Error ? error.message : String(error)) +
              '; the run continues',
          );
          return;
        }
      }
    });
  }

  // Initialize: ensure directory exists and read any existing file to get seq
  const dir = dirname(eventsPath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOTDIR: a file exists where we need a directory - structural failure
    if (code === 'ENOTDIR') {
      degrade('could not create trace directory ' + dir + ' (a file exists at that path); the run continues');
    } else if (!isTransient(code) && code !== 'EEXIST') {
      degrade('could not create trace directory ' + dir + '; the run continues');
    }
  }

  // Read existing file to determine starting seq and load processes
  if (!degraded) {
    try {
      const content = readFileSync(eventsPath, 'utf8');
      // Check if file ends with newline - if not, we have a partial line
      fileEndsWithNewline = content.length === 0 || content.endsWith('\n');
      const lines = content.split('\n');
      for (const line of lines) {
        if (line.trim() === '') continue;
        try {
          const parsed = JSON.parse(line) as NdjsonLine;
          if (parsed.type === 'event') {
            const rec = parsed.data as TraceRecord;
            if (rec.seq > seq) seq = rec.seq;
          } else if (parsed.type === 'process') {
            const proc = parsed.data as TraceProcess;
            // Handle older files that don't have pid: read as null
            if (proc.pid === undefined) proc.pid = null;
            processes.set(proc.taskId, proc);
          }
        } catch {
          // Partial line at the end — ignore it
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        degrade('could not read trace store ' + eventsPath);
      } else if (code !== 'ENOENT') {
        // Some other error reading the file
      }
    }
  }

  return {
    get engine(): 'ndjson' {
      return 'ndjson';
    },
    get degraded(): boolean {
      return degraded;
    },

    append(record: Omit<TraceRecord, 'seq'>): void {
      if (degraded || closed) return;

      // We must determine seq inside the lock to avoid races with other writers.
      withLock(() => {
        // Re-read file to get current max seq (another writer may have appended)
        try {
          const content = readFileSync(eventsPath, 'utf8');
          fileEndsWithNewline = content.length === 0 || content.endsWith('\n');
          const lines = content.split('\n');
          for (const line of lines) {
            if (line.trim() === '') continue;
            try {
              const parsed = JSON.parse(line) as NdjsonLine;
              if (parsed.type === 'event') {
                const rec = parsed.data as TraceRecord;
                if (rec.seq > seq) seq = rec.seq;
              }
            } catch {
              // Partial line — ignore
            }
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') {
            // File unreadable — already degraded or will be on write attempt
          }
        }

        seq += 1;
        const full: TraceRecord = { ...record, seq };

        // Write directly instead of via appendLine (we already hold the lock)
        const prefix = fileEndsWithNewline ? '' : '\n';
        const text = prefix + JSON.stringify({ type: 'event', data: full }) + '\n';
        for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
          try {
            // TEST SEAM: inject ENOSPC if configured
            if (checkEnospcInjection()) {
              const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
              err.code = 'ENOSPC';
              throw err;
            }
            appendFileSync(eventsPath, text, { encoding: 'utf8' });
            fileEndsWithNewline = true;
            return;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            // ENOSPC: disk full - structural failure, degrade
            if (code === 'ENOSPC') {
              degrade(
                'disk full writing to trace store ' + eventsPath + '; the run continues',
              );
              return;
            }
            // Retry on transient file locks
            if (isTransient(code) && attempt < RETRY_ATTEMPTS) {
              pause(1 + Math.floor(Math.random() * RETRY_PAUSE_MS));
              continue;
            }
            // Retry exhausted: per-record failure, warn but don't degrade
            warnOnce(
              'could not write to trace store ' +
                eventsPath +
                ': ' +
                (error instanceof Error ? error.message : String(error)) +
                '; the run continues',
            );
            return;
          }
        }
      });
    },

    read(after = 0, limit = 1000): TraceReading {
      if (closed) {
        return { records: [], cursor: after, degraded };
      }

      let content: string;
      try {
        // TEST SEAM: inject EACCES if configured
        if (checkReadEaccesInjection()) {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        content = readFileSync(eventsPath, 'utf8');
        // TEST SEAM: park after read, inside the critical section. For NDJSON,
        // reads take no lock — this park holds nothing a writer needs.
        const parkMs = checkReadParkMs();
        if (parkMs > 0) {
          pause(parkMs);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return { records: [], cursor: after, degraded: false };
        }
        if (code === 'EACCES' || code === 'EPERM') {
          degrade('could not read trace store ' + eventsPath);
          return { records: [], cursor: after, degraded: true };
        }
        return { records: [], cursor: after, degraded: true };
      }

      const records: TraceRecord[] = [];
      const lines = content.split('\n');
      for (const line of lines) {
        if (line.trim() === '') continue;
        try {
          const parsed = JSON.parse(line) as NdjsonLine;
          if (parsed.type === 'event') {
            const rec = parsed.data as TraceRecord;
            if (rec.seq > after) {
              records.push(rec);
              if (records.length >= limit) break;
            }
          }
        } catch {
          // Partial line — skip it
        }
      }

      const last = records[records.length - 1];
      return {
        records,
        cursor: last !== undefined ? last.seq : after,
        degraded: false,
      };
    },

    openProcess(p: Omit<TraceProcess, 'closedAt' | 'outcome' | 'pid'> & { pid?: number | null }): void {
      if (degraded || closed) return;
      const full: TraceProcess = { ...p, closedAt: null, outcome: null, pid: p.pid ?? null };
      processes.set(p.taskId, full);
      appendLine({ type: 'process', data: full });
    },

    closeProcess(taskId: string, outcome: NonNullable<TraceProcess['outcome']>): void {
      if (degraded || closed) return;
      const existing = processes.get(taskId);
      if (existing !== undefined && existing.closedAt === null) {
        const updated: TraceProcess = {
          ...existing,
          closedAt: Date.now(),
          outcome,
        };
        processes.set(taskId, updated);
        appendLine({ type: 'process', data: updated });
      }
    },

    finalize(outcome: NonNullable<TraceProcess['outcome']>): void {
      // Idempotent: second call is a no-op
      if (finalized) return;
      finalized = true;
      // If already degraded, return silently (no second warning)
      if (degraded || closed) return;
      const now = Date.now();
      for (const [taskId, proc] of processes.entries()) {
        if (proc.closedAt === null) {
          const updated: TraceProcess = {
            ...proc,
            closedAt: now,
            outcome,
          };
          processes.set(taskId, updated);
          appendLine({ type: 'process', data: updated });
        }
      }
    },

    processes(): readonly TraceProcess[] {
      if (degraded || closed) return [];
      // Return the latest state for each process
      const result: TraceProcess[] = [];
      for (const proc of processes.values()) {
        result.push(proc);
      }
      return result;
    },

    close(): void {
      closed = true;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Degraded store (when nothing can be opened)                                 */
/* -------------------------------------------------------------------------- */

function createDegradedStore(): TraceStore {
  let finalized = false;
  return {
    get engine(): 'ndjson' {
      return 'ndjson';
    },
    get degraded(): boolean {
      return true;
    },
    append(): void {},
    read(after = 0): TraceReading {
      return { records: [], cursor: after, degraded: true };
    },
    openProcess(): void {},
    closeProcess(): void {},
    finalize(): void {
      // Idempotent
      if (finalized) return;
      finalized = true;
    },
    processes(): readonly TraceProcess[] {
      return [];
    },
    close(): void {},
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Opens the store for one run. `onWarning` is called at most once per store,
 * ever, with a sentence for the user; after that the store is degraded and
 * silent. Never throws.
 */
export function openTrace(
  cwd: string,
  runId: string,
  onWarning: (message: string) => void,
): TraceStore {
  let traceDir: string;
  try { traceDir = traceDirectory(cwd, runId); }
  catch { safeWarn(onWarning, 'invalid trace path; the run continues'); return createDegradedStore(); }

  // Try to create the trace directory
  try {
    mkdirSync(traceDir, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      safeWarn(onWarning, 'could not create trace directory ' + traceDir + '; the run continues');
      return createDegradedStore();
    }
    // ENOTDIR: a file exists where we need a directory
    if (code === 'ENOTDIR') {
      safeWarn(onWarning, 'could not create trace directory ' + traceDir + ' (a file exists at that path); the run continues');
      return createDegradedStore();
    }
    // Note: mkdirSync with recursive:true does NOT throw EEXIST for existing directories.
    // EEXIST here means something exists at the path that is NOT a directory.
    if (code === 'EEXIST') {
      safeWarn(onWarning, 'could not create trace directory ' + traceDir + ' (a file exists at that path); the run continues');
      return createDegradedStore();
    }
  }

  // Verify the trace directory is actually a directory (not a file)
  try {
    const stats = statSync(traceDir);
    if (!stats.isDirectory()) {
      safeWarn(onWarning, 'could not create trace directory ' + traceDir + ' (a file exists at that path); the run continues');
      return createDegradedStore();
    }
  } catch {
    // If we can't stat it after creating, something is wrong
    safeWarn(onWarning, 'could not create trace directory ' + traceDir + '; the run continues');
    return createDegradedStore();
  }

  // Try SQLite first
  const sqlite = tryLoadSqlite();
  if (sqlite !== undefined) {
    const dbPath = join(traceDir, runId + '.db');

    // Check if a directory exists where the db file should be
    try {
      const fileStats = statSync(dbPath);
      if (fileStats.isDirectory()) {
        safeWarn(onWarning, 'trace file ' + dbPath + ' is a directory, not a file; the run continues');
        return createDegradedStore();
      }
      // File exists, try to open it
      try {
        const db = new sqlite.DatabaseSync(dbPath);
        return createSqliteStore(db, dbPath, runId, onWarning);
      } catch (error) {
        // Existing file is not a valid database
        safeWarn(
          onWarning,
          'trace file ' +
            dbPath +
            ' is not readable as a trace: ' +
            (error instanceof Error ? error.message : String(error)),
        );
        return createDegradedStore();
      }
    } catch {
      // File doesn't exist, create new
      try {
        const db = new sqlite.DatabaseSync(dbPath);
        return createSqliteStore(db, dbPath, runId, onWarning);
      } catch (error) {
        safeWarn(
          onWarning,
          'could not create trace store ' +
            dbPath +
            ': ' +
            (error instanceof Error ? error.message : String(error)) +
            '; the run continues',
        );
        return createDegradedStore();
      }
    }
  }

  // Fall back to NDJSON
  const ndjsonPath = join(traceDir, runId + '.ndjson');

  // Check if a directory exists where the ndjson file should be
  try {
    const fileStats = statSync(ndjsonPath);
    if (fileStats.isDirectory()) {
      safeWarn(onWarning, 'trace file ' + ndjsonPath + ' is a directory, not a file; the run continues');
      return createDegradedStore();
    }
  } catch {
    // File doesn't exist, that's fine
  }

  return createNdjsonStore(ndjsonPath, runId, onWarning);
}

/**
 * Opening flags for every read path in this module.
 *
 * `readOnly` is load-bearing, not tidiness. A SQLite database in WAL mode
 * carries two sidecars, `-wal` and `-shm`, and a *read-write* connection
 * checkpoints and removes them when it closes. Measured on a run killed with
 * SIGKILL, two read-write reads rewrote the `.db` and deleted both sidecars;
 * two read-only reads left the `.db` and the `-wal` byte for byte identical.
 * That is the difference between {@link readTraceEnding}'s premise holding and
 * it being false the first time anybody looked.
 *
 * The `-shm` still changes under a read-only connection, and cannot be made not
 * to: it is SQLite's shared-memory index *over* the `-wal`, rebuilt from it and
 * discarded with it, and every reader registers a read mark there. It holds no
 * trace record and no process row. What the premise claims, and what holds, is
 * that nothing the run recorded is written after the run dies.
 *
 * Two things this does not change, both measured rather than assumed: a
 * read-only connection tracks a live writer's appends exactly as a read-write
 * one does, and a corrupt or schema-less file fails identically ("file is not a
 * database", "no such table: events") in both modes. It also removes a smaller
 * write nobody asked for — a read-write open *creates* an empty database file
 * at a path that has none — though every caller here stats the path first, so
 * that one was never reachable.
 */
const READ_ONLY = { readOnly: true } as const;

/** Reads a run's trace without opening it for writing. Never throws. */
export function readTrace(
  cwd: string,
  runId: string,
  after = 0,
  limit = 1000,
): TraceReading {
  let traceDir: string;
  try { traceDir = traceDirectory(cwd, runId); }
  catch { return { records: [], cursor: after, degraded: true }; }

  // Try SQLite first
  const sqlite = tryLoadSqlite();
  if (sqlite !== undefined) {
    const dbPath = join(traceDir, runId + '.db');
    try {
      const fileStats = statSync(dbPath);
      if (fileStats.isDirectory()) {
        // It's a directory, not a file - treat as corrupt
        return { records: [], cursor: after, degraded: true };
      }
      const db = new sqlite.DatabaseSync(dbPath, READ_ONLY);
      try {
        const stmt = db.prepare(
          'SELECT seq, at, runId, kind, piece, round, payload FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?',
        );
        const rows = stmt.all(after, limit) as Array<{
          seq: number;
          at: number;
          runId: string;
          kind: string;
          piece: string | null;
          round: number | null;
          payload: string;
        }>;
        // TEST SEAM: park after read, inside the critical section
        const parkMs = checkReadParkMs();
        if (parkMs > 0) {
          pause(parkMs);
        }
        const records: TraceRecord[] = rows.map((row) => ({
          seq: row.seq,
          at: row.at,
          runId: row.runId,
          kind: row.kind,
          piece: row.piece,
          round: row.round,
          payload: JSON.parse(row.payload) as Record<string, unknown>,
        }));
        const last = records[records.length - 1];
        db.close();
        return {
          records,
          cursor: last !== undefined ? last.seq : after,
          degraded: false,
        };
      } catch {
        db.close();
        return { records: [], cursor: after, degraded: true };
      }
    } catch {
      // File doesn't exist or can't be opened, try NDJSON
    }
  }

  // Try NDJSON
  const ndjsonPath = join(traceDir, runId + '.ndjson');
  try {
    const fileStats = statSync(ndjsonPath);
    if (fileStats.isDirectory()) {
      // It's a directory, not a file - treat as corrupt
      return { records: [], cursor: after, degraded: true };
    }
    const content = readFileSync(ndjsonPath, 'utf8');
    // TEST SEAM: park after read, inside the critical section
    const parkMs = checkReadParkMs();
    if (parkMs > 0) {
      pause(parkMs);
    }
    const records: TraceRecord[] = [];
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as NdjsonLine;
        if (parsed.type === 'event') {
          const rec = parsed.data as TraceRecord;
          if (rec.seq > after) {
            records.push(rec);
            if (records.length >= limit) break;
          }
        }
      } catch {
        // Partial line
      }
    }
    const last = records[records.length - 1];
    return {
      records,
      cursor: last !== undefined ? last.seq : after,
      degraded: false,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { records: [], cursor: 0, degraded: false };
    }
    return { records: [], cursor: after, degraded: true };
  }
}

/* -------------------------------------------------------------------------- */
/* Process reading — the read-side twin of processes()                         */
/* -------------------------------------------------------------------------- */

/** What a process read hands back. */
export interface ProcessReading {
  processes: readonly TraceProcess[];
  /** True when the store could not be read. `processes` is then empty. */
  degraded: boolean;
}

/**
 * Reads a run's process rows without opening it for writing. Never throws.
 *
 * Same contract as readTrace: an absent trace is a normal empty result, not an
 * error. Nothing outside this module opens the store (C3).
 */
export function readProcesses(cwd: string, runId: string): ProcessReading {
  let traceDir: string;
  try { traceDir = traceDirectory(cwd, runId); }
  catch { return { processes: [], degraded: true }; }

  // Try SQLite first
  const sqlite = tryLoadSqlite();
  if (sqlite !== undefined) {
    const dbPath = join(traceDir, runId + '.db');
    try {
      const fileStats = statSync(dbPath);
      if (fileStats.isDirectory()) {
        // It's a directory, not a file - treat as corrupt
        return { processes: [], degraded: true };
      }
      const db = new sqlite.DatabaseSync(dbPath, READ_ONLY);
      try {
        const stmt = db.prepare(
          'SELECT taskId, runId, role, piece, round, openedAt, closedAt, outcome, pid FROM processes',
        );
        const rows = stmt.all() as Array<{
          taskId: string;
          runId: string;
          role: string;
          piece: string | null;
          round: number | null;
          openedAt: number;
          closedAt: number | null;
          outcome: string | null;
          pid: number | null;
        }>;
        db.close();
        const processes: TraceProcess[] = rows.map((row) => ({
          taskId: row.taskId,
          runId: row.runId,
          role: row.role as TraceProcess['role'],
          piece: row.piece,
          round: row.round,
          openedAt: row.openedAt,
          closedAt: row.closedAt,
          outcome: row.outcome as TraceProcess['outcome'],
          pid: row.pid,
        }));
        return { processes, degraded: false };
      } catch {
        db.close();
        return { processes: [], degraded: true };
      }
    } catch {
      // File doesn't exist or can't be opened, try NDJSON
    }
  }

  // Try NDJSON
  const ndjsonPath = join(traceDir, runId + '.ndjson');
  try {
    const fileStats = statSync(ndjsonPath);
    if (fileStats.isDirectory()) {
      // It's a directory, not a file - treat as corrupt
      return { processes: [], degraded: true };
    }
    const content = readFileSync(ndjsonPath, 'utf8');
    const processMap = new Map<string, TraceProcess>();
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as NdjsonLine;
        if (parsed.type === 'process') {
          const proc = parsed.data as TraceProcess;
          // Handle older files that don't have pid: read as null
          if (proc.pid === undefined) proc.pid = null;
          processMap.set(proc.taskId, proc);
        }
      } catch {
        // Partial line
      }
    }
    return { processes: Array.from(processMap.values()), degraded: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { processes: [], degraded: false };
    }
    return { processes: [], degraded: true };
  }
}

/* -------------------------------------------------------------------------- */
/* Internal export for testing — not part of the public CONTRACT.md surface   */
/* -------------------------------------------------------------------------- */

/**
 * TEST-ONLY EXPORT. Not part of the public API (CONTRACT.md).
 *
 * The lock acquisition policy as a pure function, exported only so tests can
 * verify its decision logic directly without filesystem races. The cap at
 * STALE_BREAK_CAP prevents infinite lock-breaking loops.
 */
export const _lockPolicy_FOR_TESTING_ONLY = lockPolicy;

/* -------------------------------------------------------------------------- */
/* Liveness derivation — the read-side twin of the lead row                    */
/* -------------------------------------------------------------------------- */

/**
 * The four liveness states a run can be in when viewed from the outside.
 *
 * This is a derived view, never a ledger field (Decision 1 in T4c-2). The
 * ledger stays `RunStatus`, and this column sits beside it.
 */
export type LivenessState = 'live' | 'died' | '-' | '?';

/**
 * Checks whether a process with the given pid exists.
 *
 * Uses `process.kill(pid, 0)` which sends no signal but throws if the process
 * is gone. Note: `EPERM` means the process exists but is not ours — that is
 * still alive.
 *
 * This answers liveness and nothing else. A pid that answers here may belong to
 * an unrelated process that was handed the number after the run died; that is
 * what `processStartTime` is for.
 */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we cannot signal it — still alive.
    // ESRCH means no such process — dead.
    return code === 'EPERM';
  }
}

/**
 * A predicate that checks whether a pid is alive. Defaults to `pidExists`.
 * Injected so a branch can be driven without owning a process in that state.
 */
export type PidChecker = (pid: number) => boolean;

/**
 * Reads when the process holding `pid` started, in unix milliseconds, or null
 * when that cannot be established. Defaults to `processStartTime`.
 */
export type StartTimeReader = (pid: number) => number | null;

/**
 * How far a process's start time may follow a row's `openedAt` and still be
 * believed to be the process that wrote the row.
 *
 * The invariant underneath the whole recycling check is one-sided: a process
 * cannot write a row before it exists, so for the process that genuinely opened
 * a lead row, `startTime <= openedAt` always. A recycled pid is the other way
 * round — the replacement process was given the number after the original died,
 * which is after the original opened its row, so its start time *follows*
 * `openedAt`. Nothing here is a staleness heuristic: the comparison is between
 * two recorded instants, not between now and a deadline.
 *
 * The tolerance therefore absorbs only the disagreement between the two clock
 * sources, never process startup latency — a run that takes a minute to get its
 * row written sits a minute on the safe side of the bound and is unaffected.
 * Measured on this machine, a Windows process-creation FILETIME landed before
 * the first `Date.now()` inside that same process on every reading taken, by
 * tens of milliseconds: fifteen samples spanned 29 to 181 ms, all on the safe
 * side of zero. So the quantity the bound has to cover is not that gap, which
 * costs nothing, but the two sources ever disagreeing the other way. The POSIX
 * route reads `ps -o etime=` as whole seconds (`parseElapsedSeconds` below), and
 * that one-second granularity is the coarsest error either route can contribute.
 * Two seconds is twice that, and an order of magnitude above the largest
 * divergence measured here, so ordinary clock jitter, a sub-second NTP slew and
 * the POSIX rounding cannot manufacture a `died`; and it is far below any window
 * a pid can realistically be recycled in, since the run would have to die within
 * two seconds of opening its own lead row and the OS hand the same number back
 * inside that same window.
 */
export const RECYCLE_TOLERANCE_MS = 2000;

/** Unix epoch in FILETIME units: 100ns ticks between 1601-01-01 and 1970-01-01. */
const FILETIME_EPOCH_OFFSET_MS = 11644473600000n;

/**
 * A Windows FILETIME, as `ToFileTimeUtc()` prints it, in unix milliseconds.
 *
 * Anything that is not a run of digits is refused rather than coerced: the text
 * comes from a subprocess, and `NaN` compared against a timestamp is silently
 * false in both directions.
 */
function fileTimeToUnixMs(text: string): number | null {
  if (!/^\d{1,20}$/.test(text)) return null;
  const ms = BigInt(text) / 10000n - FILETIME_EPOCH_OFFSET_MS;
  if (ms <= 0n) return null;
  return Number(ms);
}

/**
 * `ps -o etime=` output — `[[dd-]hh:]mm:ss` — as whole seconds.
 *
 * Returns null for anything else, including the empty string `ps` prints for a
 * pid it cannot see.
 */
function parseElapsedSeconds(text: string): number | null {
  const match = text.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (match === null) return null;
  const days = match[1] === undefined ? 0 : Number(match[1]);
  const hours = match[2] === undefined ? 0 : Number(match[2]);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

/**
 * When the process holding `pid` started, in unix milliseconds, or null when
 * that cannot be read.
 *
 * Two routes, no new dependency (C2): on Windows the process-creation FILETIME
 * through PowerShell, which is exact; elsewhere `ps -o etime=`, which gives
 * elapsed seconds and is subtracted from `now`. Neither runs through a shell,
 * and the only interpolated value is a number. Null is returned for a pid that
 * is gone, for a process this user may not inspect, and for a machine with
 * neither helper on PATH — all of which are "cannot know", never "alive".
 *
 * This costs a subprocess, so `deriveLiveness` pays it at most once per run and
 * only for a lead row that is still open with a pid that answered the cheap
 * check first. A ledger of settled runs never reaches here at all.
 */
export function processStartTime(pid: number, now: number = Date.now()): number | null {
  try {
    if (process.platform === 'win32') {
      const probe = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-Process -Id ' + String(pid) + ' -ErrorAction Stop).StartTime.ToFileTimeUtc()',
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      if (probe.status !== 0) return null;
      return fileTimeToUnixMs((probe.stdout ?? '').trim());
    }
    const probe = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' });
    if (probe.status !== 0) return null;
    const seconds = parseElapsedSeconds(probe.stdout ?? '');
    return seconds === null ? null : now - seconds * 1000;
  } catch {
    return null;
  }
}

/**
 * Derives the liveness state of a run from its ledger status and its trace.
 *
 * This is a pure function over its inputs. Both probes may be injected; they
 * default to the real `pidExists` and `processStartTime`.
 *
 * Four states:
 * - `live`: ledger `running` AND row open AND the pid answers AND the process
 *   holding it started no later than the row was opened
 * - `died`: ledger `running` AND row open AND either the pid is gone or the
 *   process holding it started after the row — THIS is the stuck run
 * - `-`: not applicable; the run settled (row closed or ledger not `running`)
 * - `?`: unknown; no trace, degraded read, `pid` is null, or the pid answers
 *   but its start time cannot be read, so identity cannot be established
 *
 * Two tiers, in cost order, and the cheap ones are exhaustive for a settled
 * ledger: a closed row is answered without consulting the pid at all; an open
 * row takes `process.kill(pid, 0)`, which is microseconds, and a pid that has
 * gone is `died` immediately. Only a pid that survives that check pays for a
 * start time, and it is what stops a recycled pid being read as a running run.
 *
 * @param reading - The process reading for this run, or undefined if not available
 * @param ledgerStatus - The `status` field from the run record
 * @param checkPid - The predicate to test if a pid is alive (default: pidExists)
 * @param startTimeOf - When the process holding a pid started (default: processStartTime)
 */
export function deriveLiveness(
  reading: ProcessReading | undefined,
  ledgerStatus: string,
  checkPid: PidChecker = pidExists,
  startTimeOf: StartTimeReader = processStartTime,
): LivenessState {
  // If ledger does not say 'running', liveness is not applicable
  if (ledgerStatus !== 'running') {
    return '-';
  }

  // No trace at all, or degraded read — we cannot know
  if (reading === undefined || reading.degraded) {
    return '?';
  }

  // Find the most recent lead row (there may be multiple from resumes)
  // Take the one with the highest openedAt — the latest lead
  const leadRows = reading.processes.filter((p) => p.role === 'lead');
  if (leadRows.length === 0) {
    // No lead row means no trace for this run yet
    return '?';
  }

  // Sort by openedAt descending to get the most recent
  const latest = leadRows.reduce((best, row) =>
    row.openedAt > best.openedAt ? row : best,
  );

  // If the row is closed, the run settled — not applicable
  if (latest.closedAt !== null) {
    return '-';
  }

  // Row is open. Check the pid.
  if (latest.pid === null) {
    // Older-build shape: pid was not recorded. Must not be confused with dead.
    return '?';
  }

  // The row is open and has a pid. The cheap check first: a pid nobody holds is
  // a run that died without settling, and no further question needs asking.
  if (!checkPid(latest.pid)) {
    return 'died';
  }

  // Something holds the pid. A pid is not an identity — the operating system
  // hands numbers back out — so being alive is not yet evidence that the run is.
  // The process that opened this row existed before it wrote `openedAt`; a
  // process that started after the row was opened is a different one wearing the
  // same number, and the run it belonged to is gone.
  const startedAt = startTimeOf(latest.pid);
  if (startedAt === null) {
    // The pid answers but its owner cannot be identified. That is not a licence
    // to call the run live: unknown is a state of its own and this is it.
    return '?';
  }
  return startedAt > latest.openedAt + RECYCLE_TOLERANCE_MS ? 'died' : 'live';
}

/* -------------------------------------------------------------------------- */
/* Ending derivation — the answer a killed run cannot write for itself         */
/* -------------------------------------------------------------------------- */

/**
 * What the trace says about how a run ended.
 *
 * - `settled` — the lead row is closed. The run finalized itself, whatever the
 *   outcome was.
 * - `failed` — the lead row is open and nothing at all holds the pid that
 *   opened it. **This is a statement about the process, not about the run.** It
 *   says the process that opened this trace is gone and never closed its row;
 *   a SIGKILL leaves exactly that, and so does a store that degraded mid-run,
 *   because a degraded store drops `closeProcess` and `finalize` the same way a
 *   dead process does. The two are indistinguishable from inside the trace, so
 *   a caller that wants to say *the run* failed has to combine this with the
 *   ledger, which is the source of truth for whether a run settled (C1).
 * - `open` — the lead row is open and something still holds its pid.
 * - `unknown` — no trace, no lead row, no pid recorded, or a degraded read.
 */
export type TraceEndingState = 'settled' | 'failed' | 'open' | 'unknown';

/**
 * How a run ended, with the lead-row pid the answer was derived from.
 *
 * `failed` carries its pid as a `number` because that is the whole evidence for
 * the answer: a reader that reports a run as failed can say which process it
 * looked for and did not find.
 */
export type TraceEnding =
  | { state: 'failed'; pid: number }
  | { state: 'settled' | 'open' | 'unknown'; pid: number | null };

/**
 * Reads how a run ended, resolving an abandoned run at read time.
 *
 * ### Why this resolves rather than repairs
 *
 * `finalize()` runs in-process. A run killed with SIGKILL never reaches it, so
 * its lead row stays open forever and no later write *by that run* is possible.
 * There are two honest ways to close that: resolve the state when somebody
 * reads, or repair the file when somebody next writes. This is the first.
 *
 * Nothing the run recorded is written after the run dies. Every record and
 * every process row stays exactly as the dead process left it, so no reader
 * invents a `run_finished` at an instant the run never reached, and no reader
 * has to take an earlier reader's word for when the death was noticed. The
 * answer is recomputed from the pid every time it is asked for, so a run that
 * is merely slow is never mislabelled and never has to be un-mislabelled —
 * where a repair, once written, could only be undone by another write.
 *
 * That first sentence is a claim about bytes, so it is enforced rather than
 * asserted: every read path in this module opens SQLite with {@link READ_ONLY},
 * whose comment says exactly which files that does and does not hold still.
 * `trace-adversarial.test.js` pins it by hashing the trace directory of a
 * killed run before and after reading it.
 *
 * ### C1
 *
 * This is a derived view for a reader to print, exactly as {@link deriveLiveness}
 * is. It reads the trace and the operating system and nothing else, and no exit
 * code, ledger field or `state.json` value depends on what it returns.
 * `runs.json` and `state.json` keep their exact meaning: a run killed mid-round
 * still says `running` in both, because it genuinely never settled and the Stop
 * hook greps that string.
 *
 * ### Why the cheap probe, and only the cheap probe
 *
 * {@link deriveLiveness} pays for a process start time because it may answer
 * `live`, and a recycled pid read as `live` would hide the stuck run it exists
 * to find. This function never answers `live`. The only thing it turns an open
 * row into is `failed`, and only when *nobody at all* holds the pid — a state a
 * running process cannot be in. A recycled pid therefore costs a delayed
 * `failed`, never a false one, and that is worth not spawning a subprocess on
 * every `trace -f` poll.
 *
 * The visible consequence is that `runs` and `trace` can disagree about the
 * same recycled pid — `runs` reads it as `died`, this reads it as `open` — and
 * that divergence is deliberate, not an oversight to be tidied away: `runs`
 * prints one row once and can afford a `ps`, while `trace -f` asks this
 * question twice a second for as long as somebody is watching, and a
 * subprocess per poll is not a price a live view may charge.
 *
 * Never throws: a store that cannot be read is `unknown`, not an error.
 */
export function readTraceEnding(
  cwd: string,
  runId: string,
  checkPid: PidChecker = pidExists,
): TraceEnding {
  const reading = readProcesses(cwd, runId);
  if (reading.degraded) return { state: 'unknown', pid: null };

  // The same rule deriveLiveness uses: a resume opens a second lead row, and
  // the run's ending is the ending of the latest process to lead it.
  const leadRows = reading.processes.filter((p) => p.role === 'lead');
  if (leadRows.length === 0) return { state: 'unknown', pid: null };
  const latest = leadRows.reduce((best, row) =>
    row.openedAt > best.openedAt ? row : best,
  );

  if (latest.closedAt !== null) return { state: 'settled', pid: latest.pid };
  // A row written by an older build recorded no pid. That is "cannot know",
  // and it must never be read as "dead".
  if (latest.pid === null) return { state: 'unknown', pid: null };

  return checkPid(latest.pid)
    ? { state: 'open', pid: latest.pid }
    : { state: 'failed', pid: latest.pid };
}

/**
 * TEST-ONLY EXPORTS. Not part of the public API (CONTRACT.md).
 *
 * The two readings `processStartTime` has to make sense of, as pure functions.
 * The Windows route is exercised for real by the tests that resolve a live pid;
 * the POSIX route's `ps` call cannot be exercised on a Windows machine, so its
 * parser is pinned here instead of being taken on trust.
 */
export const _fileTimeToUnixMs_FOR_TESTING_ONLY = fileTimeToUnixMs;
export const _parseElapsedSeconds_FOR_TESTING_ONLY = parseElapsedSeconds;
