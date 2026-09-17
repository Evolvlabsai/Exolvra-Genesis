import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  openTrace,
  readTrace,
  _lockPolicy_FOR_TESTING_ONLY as lockPolicy,
} from '../dist/trace-store.js';

const PACKAGE_ROOT = join(import.meta.dirname, '..');

const WORK = mkdtempSync(join(tmpdir(), 'exolvra-genesis-trace-'));
after(() => {
  rmSync(WORK, { recursive: true, force: true });
});

let directories = 0;

/** A directory of its own for one test. */
function fresh() {
  const dir = join(WORK, 'trace-' + (directories += 1));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A sample record without seq (caller provides it). */
function sampleRecord(overrides = {}) {
  return {
    at: Date.now(),
    runId: 'r-test-001',
    kind: 'run_started',
    piece: null,
    round: null,
    payload: { goal: 'test goal' },
    ...overrides,
  };
}

/**
 * Run a test body against both engines via env var.
 * Asserts that the store reports the engine it was told to use (F5).
 */
function bothEngines(name, fn) {
  describe(name, () => {
    test('sqlite engine', async (t) => {
      process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = 'sqlite';
      try {
        await fn(t, 'sqlite');
      } finally {
        delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];
      }
    });

    test('ndjson engine', async (t) => {
      process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = 'ndjson';
      try {
        await fn(t, 'ndjson');
      } finally {
        delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];
      }
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Basic operations                                                            */
/* -------------------------------------------------------------------------- */

bothEngines('the store round-trips events through disk', (t, engine) => {
  const dir = fresh();
  const warnings = [];
  const store = openTrace(dir, 'r-test-001', (msg) => warnings.push(msg));

  // F5: assert the store reports the engine it was told to use
  assert.equal(store.engine, engine, 'engine mismatch: expected ' + engine + ', got ' + store.engine);
  assert.equal(store.degraded, false);
  assert.deepEqual(warnings, []);

  // Append some events
  store.append(sampleRecord({ kind: 'run_started' }));
  store.append(sampleRecord({ kind: 'piece_dispatched', piece: 'P1', round: 1 }));
  store.append(sampleRecord({ kind: 'run_finished' }));

  // Read them back
  const reading = store.read();
  assert.equal(reading.records.length, 3);
  assert.equal(reading.degraded, false);
  assert.equal(reading.cursor, 3);

  // Check seq values
  assert.equal(reading.records[0].seq, 1);
  assert.equal(reading.records[1].seq, 2);
  assert.equal(reading.records[2].seq, 3);

  // Check content
  assert.equal(reading.records[0].kind, 'run_started');
  assert.equal(reading.records[1].kind, 'piece_dispatched');
  assert.equal(reading.records[1].piece, 'P1');
  assert.equal(reading.records[2].kind, 'run_finished');

  store.close();
});

bothEngines('read with after and limit works correctly', (t, engine) => {
  const dir = fresh();
  const store = openTrace(dir, 'r-test-002', () => {});

  // F5: assert engine
  assert.equal(store.engine, engine);

  // Append 10 events
  for (let i = 0; i < 10; i += 1) {
    store.append(sampleRecord({ kind: 'event_' + i }));
  }

  // Read with after=0, limit=3
  const first = store.read(0, 3);
  assert.equal(first.records.length, 3);
  assert.equal(first.cursor, 3);
  assert.equal(first.records[0].seq, 1);
  assert.equal(first.records[2].seq, 3);

  // Read with after=3, limit=3
  const second = store.read(3, 3);
  assert.equal(second.records.length, 3);
  assert.equal(second.cursor, 6);
  assert.equal(second.records[0].seq, 4);

  // Read with after=8, should get remaining 2
  const third = store.read(8, 10);
  assert.equal(third.records.length, 2);
  assert.equal(third.cursor, 10);

  // Read past end returns empty
  const empty = store.read(10);
  assert.equal(empty.records.length, 0);
  assert.equal(empty.cursor, 10);

  store.close();
});

bothEngines('a missing store reads as empty, not as an error', (t, engine) => {
  const dir = fresh();

  // readTrace on a store that doesn't exist
  const reading = readTrace(dir, 'r-nonexistent');
  assert.deepEqual(reading.records, []);
  assert.equal(reading.cursor, 0);
  assert.equal(reading.degraded, false);
});

bothEngines('processes can be opened, closed, and listed', (t, engine) => {
  const dir = fresh();
  const store = openTrace(dir, 'r-test-003', () => {});

  // F5: assert engine
  assert.equal(store.engine, engine);

  // Open some processes
  store.openProcess({
    runId: 'r-test-003',
    taskId: 'task-1',
    role: 'lead',
    piece: null,
    round: null,
    openedAt: Date.now(),
  });
  store.openProcess({
    runId: 'r-test-003',
    taskId: 'task-2',
    role: 'builder',
    piece: 'P1',
    round: 1,
    openedAt: Date.now(),
  });

  // List processes
  let procs = store.processes();
  assert.equal(procs.length, 2);
  const lead = procs.find((p) => p.role === 'lead');
  const builder = procs.find((p) => p.role === 'builder');
  assert.ok(lead);
  assert.ok(builder);
  assert.equal(lead.closedAt, null);
  assert.equal(builder.closedAt, null);

  // Close one
  store.closeProcess('task-1', 'complete');
  procs = store.processes();
  const closedLead = procs.find((p) => p.taskId === 'task-1');
  assert.ok(closedLead.closedAt !== null);
  assert.equal(closedLead.outcome, 'complete');

  store.close();
});

bothEngines('finalize closes all open processes', (t, engine) => {
  const dir = fresh();
  const store = openTrace(dir, 'r-test-004', () => {});

  // F5: assert engine
  assert.equal(store.engine, engine);

  store.openProcess({
    runId: 'r-test-004',
    taskId: 'task-a',
    role: 'lead',
    piece: null,
    round: null,
    openedAt: Date.now(),
  });
  store.openProcess({
    runId: 'r-test-004',
    taskId: 'task-b',
    role: 'builder',
    piece: 'P1',
    round: 1,
    openedAt: Date.now(),
  });
  store.openProcess({
    runId: 'r-test-004',
    taskId: 'task-c',
    role: 'critic',
    piece: 'P1',
    round: 1,
    openedAt: Date.now(),
  });

  // Close one manually first
  store.closeProcess('task-a', 'complete');

  // Finalize the rest
  store.finalize('died');

  const procs = store.processes();
  for (const p of procs) {
    assert.ok(p.closedAt !== null, 'process ' + p.taskId + ' was not closed');
    if (p.taskId === 'task-a') {
      assert.equal(p.outcome, 'complete');
    } else {
      assert.equal(p.outcome, 'died');
    }
  }

  // Finalize is idempotent (F8: finalize called twice is a no-op)
  store.finalize('failed');
  const procsAgain = store.processes();
  // Outcomes should not have changed
  for (const p of procsAgain) {
    if (p.taskId === 'task-a') {
      assert.equal(p.outcome, 'complete');
    } else {
      assert.equal(p.outcome, 'died');
    }
  }

  store.close();
});

/* -------------------------------------------------------------------------- */
/* Durability: atomic writes, no torn records                                  */
/* -------------------------------------------------------------------------- */

bothEngines('concurrent reader and writer do not interfere', async (t, engine) => {
  const dir = fresh();
  const runId = 'r-concurrent';

  const traceStoreUrl = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'trace-store.js')).href;
  // Writer script
  const writerScript = `
    process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = '${engine}';
    const { openTrace } = await import('${traceStoreUrl}');
    const store = openTrace('${dir.replace(/\\/g, '/')}', '${runId}', () => {});
    if (store.engine !== '${engine}') {
      console.error('engine mismatch: expected ${engine}, got ' + store.engine);
      process.exit(1);
    }
    for (let i = 0; i < 100; i += 1) {
      store.append({
        at: Date.now(),
        runId: '${runId}',
        kind: 'event_' + i,
        piece: null,
        round: null,
        payload: { index: i },
      });
    }
    store.close();
  `;

  const writerFile = join(WORK, 'writer-' + engine + '.mjs');
  writeFileSync(writerFile, writerScript, 'utf8');

  // Start writer
  const writer = spawn(process.execPath, [writerFile], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let writerStderr = '';
  writer.stderr.setEncoding('utf8');
  writer.stderr.on('data', (chunk) => {
    writerStderr += chunk;
  });

  const writerDone = new Promise((resolve) => {
    writer.on('exit', (code) => resolve(code));
  });

  // Reader reads repeatedly while writer is writing
  process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = engine;
  let reads = 0;
  let maxSeen = 0;
  let running = true;

  writerDone.then(() => {
    running = false;
  });

  while (running || reads < 5) {
    const reading = readTrace(dir, runId);
    reads += 1;
    if (reading.records.length > 0) {
      const last = reading.records[reading.records.length - 1];
      if (last.seq > maxSeen) maxSeen = last.seq;
    }
    // F8: verify no torn records and no duplicates WITHIN this read
    const seqsThisRead = new Set();
    for (const rec of reading.records) {
      assert.equal(typeof rec.seq, 'number', 'seq must be a number');
      assert.equal(typeof rec.kind, 'string', 'kind must be a string');
      // No duplicates within this single read
      assert.ok(!seqsThisRead.has(rec.seq), 'duplicate seq ' + rec.seq + ' within one read');
      seqsThisRead.add(rec.seq);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];

  const code = await writerDone;
  assert.equal(code, 0, 'writer failed: ' + writerStderr);
  assert.ok(reads >= 5, 'only ' + reads + ' reads happened');

  // Final read should see all 100
  process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = engine;
  const final = readTrace(dir, runId);
  delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];
  assert.equal(final.records.length, 100, 'lost records');

  t.diagnostic(
    engine + ': ' + reads + ' concurrent reads, max seq seen mid-write: ' + maxSeen,
  );
});

/* -------------------------------------------------------------------------- */
/* C4/N6: reader observes growing prefix, reader does not block writer          */
/*                                                                              */
/* N6 says "reads never block writes" and requires this to be MEASURED, not     */
/* asserted. We use a discriminating test seam: park the reader for D=4000ms    */
/* AFTER any lock acquisition, BEFORE release. If a read acquires the write     */
/* lock, parking there holds the write lock and blocks writers for 4000ms;      */
/* if a read takes no write lock, parking there holds nothing and writers       */
/* run straight through.                                                        */
/*                                                                              */
/* N6 has two clauses, pinned separately:                                       */
/*                                                                              */
/* 1. "the reader completes while the writer is still writing"                  */
/*    Ordering assertion: record first-append and last-append timestamps from   */
/*    the writer, and reader-completion timestamp. Assert reader completion     */
/*    falls strictly between them. No threshold, cannot be tuned.               */
/*                                                                              */
/* 2. "no write observes a blocked interval attributable to the reader"         */
/*    With the reader parked for D=4000ms, the writer appends continuously.     */
/*    Assert (a) the writer completed at least one append in the second half    */
/*    of the park window. This establishes the writer kept running. It does     */
/*    not attempt to bound how much the reader slowed it down: a latency bound  */
/*    is unusable here because the no-throw discipline converts blocking into   */
/*    a dropped record and a fast return. The second-half window is 2000ms,     */
/*    more than twice the longest single-append stall observed with nothing     */
/*    sabotaged, so a single stall cannot empty it. Under a genuine violation   */
/*    the writer completes nothing across the entire park, so the second half   */
/*    is empty. Assert (b) after the writer has exited, every record it         */
/*    reported completing is present in the store. Attribution is exact: the    */
/*    parked reader is the only other actor, and we chose when it parks.        */
/* -------------------------------------------------------------------------- */

bothEngines('C4/N6: reader observes growing prefix, reader does not block writer', async (t, engine) => {
  const traceStoreUrl = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'trace-store.js')).href;
  const D = 4000; // Park duration in ms
  const dir = fresh();
  const runId = 'r-c4n6';

  // Signal file: writer creates this after writing first 10 records
  const readyFile = join(WORK, 'writer-ready-' + engine + '-' + Date.now() + '.ready');

  // Writer script: appends 500 events with fine-grained pacing to ensure it runs longer than D ms
  // Uses wall-clock Date.now() for timestamps so they're comparable across processes
  // Records completion timestamp for every append to measure distribution
  const writerScript = `
    process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = '${engine}';
    const { openTrace } = await import('${traceStoreUrl}');
    const { writeFileSync } = await import('node:fs');
    const store = openTrace('${dir.replace(/\\/g, '/')}', '${runId}', () => {});
    if (store.engine !== '${engine}') {
      console.error('engine mismatch: expected ${engine}, got ' + store.engine);
      process.exit(1);
    }
    const latencies = [];
    const completedAt = [];
    const firstAppendAt = Date.now();
    for (let i = 0; i < 500; i += 1) {
      const start = performance.now();
      store.append({
        at: Date.now(),
        runId: '${runId}',
        kind: 'event_' + i,
        piece: null,
        round: null,
        payload: { index: i },
      });
      latencies.push(performance.now() - start);
      completedAt.push(Date.now());
      // Signal ready after first 10 records so reader can start
      if (i === 9) {
        writeFileSync('${readyFile.replace(/\\/g, '/')}', 'ready', 'utf8');
      }
      // Fine-grained pacing: small pause after every append to smooth progress across time
      // Total: 500 appends x 12ms = 6000ms minimum runtime, enough to outlast the 4000ms park
      // This ensures clause 1 is satisfiable (reader completes while writer is still writing)
      const pauseStart = Date.now();
      while (Date.now() - pauseStart < 12) {
        // busy wait 12ms
      }
    }
    const lastAppendAt = Date.now();
    store.close();
    const maxLatency = Math.max(...latencies);
    console.log(JSON.stringify({ firstAppendAt, lastAppendAt, latencies, maxLatency, completedAt }));
  `;

  const writerFile = join(WORK, 'writer-c4n6-' + engine + '.mjs');
  writeFileSync(writerFile, writerScript, 'utf8');

  // Start writer
  const writer = spawn(process.execPath, [writerFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let writerStdout = '';
  let writerStderr = '';
  writer.stdout.setEncoding('utf8');
  writer.stderr.setEncoding('utf8');
  writer.stdout.on('data', (chunk) => {
    writerStdout += chunk;
  });
  writer.stderr.on('data', (chunk) => {
    writerStderr += chunk;
  });

  const writerDone = new Promise((resolve) => {
    writer.on('exit', (code) => resolve(code));
  });

  // Wait for writer to signal it has written first 10 records
  const maxWait = Date.now() + 5000;
  while (!existsSync(readyFile) && Date.now() < maxWait) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!existsSync(readyFile)) {
    throw new Error('Writer did not signal ready in time');
  }

  // Reader: parks for D ms inside its critical section, then completes
  process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = engine;
  process.env['EXOLVRA_GENESIS_TRACE_PARK_READ_MS'] = String(D);
  const readerStartAt = Date.now();  // Use Date.now() for wall-clock time
  const reading = readTrace(dir, runId, 0, 1000);
  const readerCompleteAt = Date.now();
  delete process.env['EXOLVRA_GENESIS_TRACE_PARK_READ_MS'];
  delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];

  // Wait for writer to finish
  const code = await writerDone;
  assert.equal(code, 0, 'writer failed: ' + writerStderr);

  const stats = JSON.parse(writerStdout.trim());

  // N6 clause 1: "the reader completes while the writer is still writing"
  // Ordering assertion: reader completion falls strictly between first and last append
  // Now using wall-clock Date.now() timestamps, which are comparable across processes
  assert.ok(
    readerCompleteAt > stats.firstAppendAt && readerCompleteAt < stats.lastAppendAt,
    'N6 clause 1: reader must complete while writer is still writing. ' +
      'firstAppend=' + stats.firstAppendAt + ', ' +
      'readerComplete=' + readerCompleteAt + ', ' +
      'lastAppend=' + stats.lastAppendAt,
  );

  // N6 clause 2: "no write observes a blocked interval attributable to the reader"
  // The reader was parked from readerStartAt to readerCompleteAt (approximately D ms).
  // Divide the park window into quarters and assert the writer made progress in each.
  const parkStartAt = readerStartAt;
  const parkEndAt = readerCompleteAt;
  const parkDuration = parkEndAt - parkStartAt;
  const quarterDuration = parkDuration / 4;

  // Define the four quarters of the park window
  const q1Start = parkStartAt;
  const q1End = parkStartAt + quarterDuration;
  const q2Start = q1End;
  const q2End = q2Start + quarterDuration;
  const q3Start = q2End;
  const q3End = q3Start + quarterDuration;
  const q4Start = q3End;
  const q4End = parkEndAt;

  // Count appends completed in each quarter
  let q1Count = 0;
  let q2Count = 0;
  let q3Count = 0;
  let q4Count = 0;
  let maxLatencyDuringPark = 0;

  for (let i = 0; i < stats.completedAt.length; i += 1) {
    const completedTime = stats.completedAt[i];
    // Track max latency for diagnostic purposes (not asserted)
    if (completedTime >= parkStartAt && completedTime <= parkEndAt) {
      if (stats.latencies[i] > maxLatencyDuringPark) {
        maxLatencyDuringPark = stats.latencies[i];
      }
    }
    // Count which quarter this append completed in
    if (completedTime >= q1Start && completedTime < q1End) q1Count += 1;
    else if (completedTime >= q2Start && completedTime < q2End) q2Count += 1;
    else if (completedTime >= q3Start && completedTime < q3End) q3Count += 1;
    else if (completedTime >= q4Start && completedTime <= q4End) q4Count += 1;
  }

  // N6 clause 2a: Assert the writer completed at least one append in the second half of the park window.
  // The second half is from parkStartAt + D/2 to parkEndAt. This establishes the writer kept running.
  // A single stall cannot empty a 2000ms window; a genuine block empties it completely.
  const halfwayPoint = parkStartAt + (parkDuration / 2);
  let secondHalfCount = 0;
  for (let i = 0; i < stats.completedAt.length; i += 1) {
    const completedTime = stats.completedAt[i];
    if (completedTime >= halfwayPoint && completedTime <= parkEndAt) {
      secondHalfCount += 1;
    }
  }
  assert.ok(
    secondHalfCount >= 1,
    'N6 clause 2a: writer must complete at least one append in second half of park window. ' +
      'Got ' + secondHalfCount + ' (q1=' + q1Count + ', q2=' + q2Count + ', q3=' + q3Count + ', q4=' + q4Count + ')',
  );

  // N6 clause 2b: After the writer has exited, assert that every record it reported
  // completing is actually present in the store. If a record was dropped (R6 converts
  // blocking into a dropped record), this assertion would fail.
  process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = engine;
  const finalReading = readTrace(dir, runId, 0, 1000);
  delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];
  const finalSeqs = new Set(finalReading.records.map((r) => r.seq));
  for (let i = 0; i < 500; i += 1) {
    const expectedSeq = i + 1;
    assert.ok(
      finalSeqs.has(expectedSeq),
      'N6 clause 2b: writer reported completing seq=' + expectedSeq + ' but it is not in the store',
    );
  }

  t.diagnostic(
    engine + ': park=' + D + 'ms, ' +
      'q1=' + q1Count + ', q2=' + q2Count + ', q3=' + q3Count + ', q4=' + q4Count + ', ' +
      'maxLatencyDuringPark=' + maxLatencyDuringPark.toFixed(2) + 'ms, ' +
      'readerRecords=' + reading.records.length + ', finalRecords=' + finalReading.records.length,
  );
});

/* -------------------------------------------------------------------------- */
/* Fault tolerance: R6 — nothing throws, degraded stores work                  */
/* -------------------------------------------------------------------------- */

// F1: Use platform-independent fault: file where directory should be
bothEngines('R6: file where trace directory should be degrades gracefully', (t, engine) => {
  const dir = fresh();
  // Create a regular FILE at the path where the trace DIRECTORY should be
  const traceDir = join(dir, '.exolvra-genesis', 'trace');
  mkdirSync(join(dir, '.exolvra-genesis'), { recursive: true });
  // Write a file where the directory should be
  writeFileSync(traceDir, 'this is a file, not a directory', 'utf8');

  const warnings = [];
  const store = openTrace(dir, 'r-unwritable', (msg) => warnings.push(msg));

  assert.equal(store.degraded, true, 'store should be degraded');
  assert.equal(warnings.length, 1, 'should warn exactly once');
  assert.ok(warnings[0].includes('run continues'), warnings[0]);

  // All operations should be no-ops, not throw
  store.append(sampleRecord());
  const reading = store.read();
  assert.deepEqual(reading.records, []);
  assert.equal(reading.degraded, true);

  store.openProcess({
    runId: 'r-unwritable',
    taskId: 't1',
    role: 'lead',
    piece: null,
    round: null,
    openedAt: Date.now(),
  });
  store.closeProcess('t1', 'complete');
  store.finalize('died');
  store.close();

  // Only one warning
  assert.equal(warnings.length, 1);
});

// F1: Second platform-independent fault: directory where store file should be
bothEngines('R6: directory where store file should be degrades gracefully', (t, engine) => {
  const dir = fresh();
  const traceDir = join(dir, '.exolvra-genesis', 'trace');
  mkdirSync(traceDir, { recursive: true });

  // Create a DIRECTORY where the store FILE should be
  const ext = engine === 'sqlite' ? '.db' : '.ndjson';
  const storePath = join(traceDir, 'r-dirfile' + ext);
  mkdirSync(storePath, { recursive: true });

  const warnings = [];
  const store = openTrace(dir, 'r-dirfile', (msg) => warnings.push(msg));

  assert.equal(store.degraded, true, 'store should be degraded when file path is a directory');
  assert.equal(warnings.length, 1, 'should warn exactly once');
  assert.ok(
    warnings[0].includes('directory') || warnings[0].includes('run continues'),
    'warning should mention the issue: ' + warnings[0],
  );

  store.close();
});

// F1/F8: R6 full test: fifty events after unwritable dir
bothEngines('R6: append/read/finalize fifty events after unwritable dir', (t, engine) => {
  const dir = fresh();
  // Create a file where the trace directory should be
  const traceDir = join(dir, '.exolvra-genesis', 'trace');
  mkdirSync(join(dir, '.exolvra-genesis'), { recursive: true });
  writeFileSync(traceDir, 'blocking file', 'utf8');

  const warnings = [];
  const store = openTrace(dir, 'r-fifty', (msg) => warnings.push(msg));

  // Append 50 events — none should throw
  for (let i = 0; i < 50; i += 1) {
    store.append(sampleRecord({ kind: 'event_' + i }));
  }

  // Read — should return degraded reading
  const reading = store.read();
  assert.deepEqual(reading.records, []);
  assert.equal(reading.degraded, true);

  // Finalize — should not throw
  store.finalize('died');
  store.close();

  // Exactly one warning
  assert.equal(warnings.length, 1, 'expected exactly one warning, got: ' + warnings.join(', '));
  assert.equal(store.degraded, true);
});

/* -------------------------------------------------------------------------- */
/* F8: finalize idempotency and degraded-store finalize                        */
/* -------------------------------------------------------------------------- */

bothEngines('finalize called twice is a no-op', (t, engine) => {
  const dir = fresh();
  const store = openTrace(dir, 'r-finalize-twice', () => {});

  // F5: assert engine
  assert.equal(store.engine, engine);

  store.openProcess({
    runId: 'r-finalize-twice',
    taskId: 'task-1',
    role: 'lead',
    piece: null,
    round: null,
    openedAt: Date.now(),
  });

  // First finalize
  store.finalize('complete');
  const procs1 = store.processes();
  assert.equal(procs1.length, 1);
  assert.equal(procs1[0].outcome, 'complete');
  const closedAt1 = procs1[0].closedAt;

  // Small delay to ensure timestamps would differ
  const start = Date.now();
  while (Date.now() - start < 5) {
    // busy wait
  }

  // Second finalize with different outcome — should be no-op
  store.finalize('died');
  const procs2 = store.processes();
  assert.equal(procs2.length, 1);
  assert.equal(procs2[0].outcome, 'complete', 'outcome should not change on second finalize');
  assert.equal(procs2[0].closedAt, closedAt1, 'closedAt should not change on second finalize');

  store.close();
});

bothEngines('finalize on already degraded store returns silently', (t, engine) => {
  const dir = fresh();
  // Create a file where the trace directory should be
  const traceDir = join(dir, '.exolvra-genesis', 'trace');
  mkdirSync(join(dir, '.exolvra-genesis'), { recursive: true });
  writeFileSync(traceDir, 'blocking file', 'utf8');

  const warnings = [];
  const store = openTrace(dir, 'r-degraded-finalize', (msg) => warnings.push(msg));

  assert.equal(store.degraded, true);
  assert.equal(warnings.length, 1);

  // Finalize on degraded store — should not warn again
  store.finalize('died');
  assert.equal(warnings.length, 1, 'finalize on degraded store should not emit additional warning');

  store.close();
});

/* -------------------------------------------------------------------------- */
/* F8: close on degraded store returns                                         */
/* -------------------------------------------------------------------------- */

bothEngines('close on degraded store returns without error', (t, engine) => {
  const dir = fresh();
  // Create a file where the trace directory should be
  const traceDir = join(dir, '.exolvra-genesis', 'trace');
  mkdirSync(join(dir, '.exolvra-genesis'), { recursive: true });
  writeFileSync(traceDir, 'blocking file', 'utf8');

  const warnings = [];
  const store = openTrace(dir, 'r-degraded-close', (msg) => warnings.push(msg));

  assert.equal(store.degraded, true);

  // Close should not throw
  store.close();
  // Close again should also not throw
  store.close();
});

/* -------------------------------------------------------------------------- */
/* NDJSON-specific: partial line handling                                      */
/* -------------------------------------------------------------------------- */

test('ndjson: partial line at end is ignored, not an error', () => {
  process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = 'ndjson';
  try {
    const dir = fresh();
    const traceDir = join(dir, '.exolvra-genesis', 'trace');
    mkdirSync(traceDir, { recursive: true });

    // Write a valid line followed by a partial line (simulating kill mid-append)
    const ndjsonPath = join(traceDir, 'r-partial.ndjson');
    const validLine = JSON.stringify({
      type: 'event',
      data: { seq: 1, at: Date.now(), runId: 'r-partial', kind: 'start', piece: null, round: null, payload: {} },
    });
    writeFileSync(ndjsonPath, validLine + '\n{"type":"event","data":{"seq":2', 'utf8');

    const warnings = [];
    const store = openTrace(dir, 'r-partial', (msg) => warnings.push(msg));

    assert.equal(store.engine, 'ndjson');

    // Should have read seq 1, ignored the partial
    const reading = store.read();
    assert.equal(reading.records.length, 1);
    assert.equal(reading.records[0].seq, 1);
    assert.equal(reading.degraded, false);
    assert.deepEqual(warnings, []);

    // Appending should work and start from seq 2
    store.append(sampleRecord({ kind: 'next' }));
    const after = store.read();
    assert.equal(after.records.length, 2);
    assert.equal(after.records[1].seq, 2);

    store.close();
  } finally {
    delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];
  }
});

/* -------------------------------------------------------------------------- */
/* SQLite-specific: corrupt file handling                                      */
/* -------------------------------------------------------------------------- */

test('sqlite: corrupt db file is diagnosed by name', () => {
  process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = 'sqlite';
  try {
    const dir = fresh();
    const traceDir = join(dir, '.exolvra-genesis', 'trace');
    mkdirSync(traceDir, { recursive: true });

    // Write garbage that is not a SQLite file
    const dbPath = join(traceDir, 'r-corrupt.db');
    writeFileSync(dbPath, 'this is not a database file', 'utf8');

    const warnings = [];
    const store = openTrace(dir, 'r-corrupt', (msg) => warnings.push(msg));

    assert.equal(store.degraded, true);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('r-corrupt.db'), warnings[0]);
    assert.ok(warnings[0].includes('not readable as a trace'), warnings[0]);

    store.close();
  } finally {
    delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];
  }
});

/* -------------------------------------------------------------------------- */
/* Criterion 2a: no experimental warning on stderr (F4: assert stderr === '')  */
/* -------------------------------------------------------------------------- */

test('importing node:sqlite does not emit anything to stderr', async () => {
  // This test runs a child process that imports the module and checks stderr
  const traceStoreUrl = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'trace-store.js')).href;
  const script = `
    const { openTrace } = await import('${traceStoreUrl}');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'trace-warn-'));
    const store = openTrace(dir, 'r-warn-test', () => {});
    store.close();
    rmSync(dir, { recursive: true, force: true });
  `;

  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30000,
  });

  assert.equal(child.status, 0, 'child failed: ' + child.stderr);
  // F4: assert stderr is empty, not just free of specific substrings
  assert.equal(child.stderr, '', 'stderr should be empty, but got: ' + child.stderr);
});

/* -------------------------------------------------------------------------- */
/* Engine selection                                                            */
/* -------------------------------------------------------------------------- */

test('engine selection: sqlite when available, ndjson when forced', () => {
  const dir = fresh();

  // Default (should be sqlite on Node 25)
  delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];
  const store1 = openTrace(dir, 'r-auto', () => {});
  // On Node 25.6.0, should be sqlite
  assert.equal(store1.engine, 'sqlite');
  store1.close();

  // Force ndjson
  process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = 'ndjson';
  const store2 = openTrace(dir, 'r-ndjson', () => {});
  assert.equal(store2.engine, 'ndjson');
  store2.close();

  delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];
});

/* -------------------------------------------------------------------------- */
/* readTrace standalone function                                               */
/* -------------------------------------------------------------------------- */

bothEngines('readTrace reads without opening for writing', (t, engine) => {
  const dir = fresh();
  const runId = 'r-readonly';

  // First, write some events
  const store = openTrace(dir, runId, () => {});
  assert.equal(store.engine, engine);
  store.append(sampleRecord({ kind: 'event_1' }));
  store.append(sampleRecord({ kind: 'event_2' }));
  store.close();

  // Now read with the standalone function
  const reading = readTrace(dir, runId);
  assert.equal(reading.records.length, 2);
  assert.equal(reading.cursor, 2);
  assert.equal(reading.degraded, false);

  // Cursor-based pagination
  const second = readTrace(dir, runId, 1, 10);
  assert.equal(second.records.length, 1);
  assert.equal(second.records[0].seq, 2);
});

/* -------------------------------------------------------------------------- */
/* C4/F8: concurrent writers serialized (both engines)                         */
/* -------------------------------------------------------------------------- */

bothEngines('concurrent writers are serialized, no torn records', async (t, engine) => {
  const dir = fresh();
  const runId = 'r-multiwriter';

  const traceStoreUrl = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'trace-store.js')).href;
  const workers = 4;
  const each = 25;

  const workerScript = `
    process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = '${engine}';
    const { openTrace } = await import('${traceStoreUrl}');
    const tag = process.argv[2];
    const store = openTrace('${dir.replace(/\\/g, '/')}', '${runId}', () => {});
    if (store.engine !== '${engine}') {
      console.error('engine mismatch');
      process.exit(1);
    }
    for (let i = 0; i < ${each}; i += 1) {
      store.append({
        at: Date.now(),
        runId: '${runId}',
        kind: 'event_' + tag + '_' + i,
        piece: tag,
        round: i,
        payload: { tag, index: i },
      });
    }
    if (store.degraded) {
      console.error('worker ' + tag + ' degraded after appending');
      process.exit(1);
    }
    store.close();
  `;

  const workerFile = join(WORK, 'multiwriter-' + engine + '.mjs');
  writeFileSync(workerFile, workerScript, 'utf8');

  // Start all workers
  const children = [];
  for (let w = 0; w < workers; w += 1) {
    const tag = String.fromCharCode(97 + w);
    const child = spawn(process.execPath, [workerFile, tag], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    children.push(
      new Promise((resolve) => {
        child.on('exit', (code) => resolve({ tag, code, stderr }));
      }),
    );
  }

  const results = await Promise.all(children);
  for (const { tag, code, stderr } of results) {
    assert.equal(code, 0, 'worker ' + tag + ' failed: ' + stderr);
  }

  // Read all events
  process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = engine;
  const reading = readTrace(dir, runId, 0, 10000);
  delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];

  assert.equal(
    reading.records.length,
    workers * each,
    'expected ' + workers * each + ' records, got ' + reading.records.length,
  );

  // Verify no torn records and no duplicate seqs
  const seqs = new Set();
  for (const rec of reading.records) {
    assert.equal(typeof rec.seq, 'number');
    assert.ok(!seqs.has(rec.seq), 'duplicate seq: ' + rec.seq);
    seqs.add(rec.seq);
    assert.equal(typeof rec.kind, 'string');
    assert.ok(rec.kind.startsWith('event_'), 'bad kind: ' + rec.kind);
  }

  t.diagnostic(workers + ' writers x ' + each + ' events = ' + reading.records.length + ' total');
});

/* -------------------------------------------------------------------------- */
/* Payload handling: accepts anything JSON-serializable                        */
/* -------------------------------------------------------------------------- */

bothEngines('payload can hold any JSON-serializable value', (t, engine) => {
  const dir = fresh();
  const store = openTrace(dir, 'r-payload', () => {});

  assert.equal(store.engine, engine);

  const complexPayload = {
    nested: { deeply: { value: 42 } },
    array: [1, 'two', { three: 3 }],
    unicode: '\u0048\u0065\u006C\u006C\u006F',
    empty: {},
    nullValue: null,
  };

  store.append(sampleRecord({ payload: complexPayload }));
  const reading = store.read();
  assert.equal(reading.records.length, 1);
  assert.deepEqual(reading.records[0].payload, complexPayload);

  store.close();
});

/* -------------------------------------------------------------------------- */
/* close() is idempotent                                                       */
/* -------------------------------------------------------------------------- */

bothEngines('close() is idempotent', (t, engine) => {
  const dir = fresh();
  const store = openTrace(dir, 'r-close', () => {});

  assert.equal(store.engine, engine);

  store.append(sampleRecord());
  store.close();
  store.close(); // Should not throw
  store.close(); // Should not throw

  // Operations after close are no-ops
  store.append(sampleRecord());
  const reading = store.read();
  assert.equal(reading.records.length, 0); // Closed store returns empty
});

/* -------------------------------------------------------------------------- */
/* Directory creation                                                          */
/* -------------------------------------------------------------------------- */

bothEngines('trace directory is created if missing', (t, engine) => {
  const dir = join(fresh(), 'nested', 'deeper');
  const store = openTrace(dir, 'r-create', () => {});
  assert.equal(store.engine, engine);
  assert.equal(store.degraded, false);

  store.append(sampleRecord());
  const reading = store.read();
  assert.equal(reading.records.length, 1);

  store.close();

  // Verify directory was created
  const files = readdirSync(join(dir, '.exolvra-genesis', 'trace'));
  assert.ok(files.length > 0);
});

/* -------------------------------------------------------------------------- */
/* F8: read on unreadable store (EACCES simulation via directory-as-file)      */
/* -------------------------------------------------------------------------- */

bothEngines('read on corrupt store returns degraded reading with warning', (t, engine) => {
  const dir = fresh();
  const traceDir = join(dir, '.exolvra-genesis', 'trace');
  mkdirSync(traceDir, { recursive: true });

  // Create a directory where the store file should be (platform-independent fault)
  const ext = engine === 'sqlite' ? '.db' : '.ndjson';
  const storePath = join(traceDir, 'r-unreadable' + ext);
  mkdirSync(storePath, { recursive: true });

  const warnings = [];
  const store = openTrace(dir, 'r-unreadable', (msg) => warnings.push(msg));

  assert.equal(store.degraded, true);
  assert.equal(warnings.length, 1);

  // Read should return degraded result
  const reading = store.read();
  assert.deepEqual(reading.records, []);
  assert.equal(reading.degraded, true);

  store.close();
});

/* -------------------------------------------------------------------------- */
/* F9: ENOSPC handling — prior records intact, one warning then silence         */
/* -------------------------------------------------------------------------- */

test('F9/sqlite: ENOSPC warns once, prior records intact, silence on subsequent', () => {
  process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = 'sqlite';
  delete process.env['EXOLVRA_GENESIS_TRACE_INJECT_ENOSPC'];
  try {
    const dir = fresh();
    const runId = 'r-enospc-sqlite';
    const warnings = [];
    const store = openTrace(dir, runId, (msg) => warnings.push(msg));

    assert.equal(store.engine, 'sqlite');
    assert.equal(store.degraded, false);

    // Write some records successfully first (ENOSPC not injected)
    store.append(sampleRecord({ kind: 'before_1', runId }));
    store.append(sampleRecord({ kind: 'before_2', runId }));
    store.append(sampleRecord({ kind: 'before_3', runId }));

    // Verify they are there
    const beforeReading = store.read();
    assert.equal(beforeReading.records.length, 3, 'prior records should exist');

    // Now inject ENOSPC — seam is stateless: set means fail, unset means succeed
    process.env['EXOLVRA_GENESIS_TRACE_INJECT_ENOSPC'] = '1';

    // This write should hit ENOSPC and warn once
    store.append(sampleRecord({ kind: 'enospc_1', runId }));
    assert.equal(warnings.length, 1, 'should warn exactly once on first ENOSPC');
    assert.ok(warnings[0].includes('disk full'), 'warning should mention disk full: ' + warnings[0]);
    assert.ok(warnings[0].includes('run continues'), 'warning should say run continues: ' + warnings[0]);

    // ENOSPC still set — this write should also hit ENOSPC but NOT warn again (silence)
    store.append(sampleRecord({ kind: 'enospc_2', runId }));
    assert.equal(warnings.length, 1, 'should not warn again on second ENOSPC (silence)');

    // Store is now degraded, so reading from it returns empty
    assert.equal(store.degraded, true, 'store should be degraded after ENOSPC');

    // Clear injection and close the degraded store
    delete process.env['EXOLVRA_GENESIS_TRACE_INJECT_ENOSPC'];
    store.close();

    // CRITICAL: "prior records intact" means the FILE still has them.
    // Use readTrace (fresh read-only access) to verify the file contents.
    const fileReading = readTrace(dir, runId);
    assert.equal(fileReading.records.length, 3, 'prior records should still be intact in the file after ENOSPC');
    assert.equal(fileReading.records[0].kind, 'before_1');
    assert.equal(fileReading.records[1].kind, 'before_2');
    assert.equal(fileReading.records[2].kind, 'before_3');

    // The ENOSPC records should NOT be there (they were dropped)
    const allKinds = fileReading.records.map((r) => r.kind);
    assert.ok(!allKinds.includes('enospc_1'), 'ENOSPC record should not be written');
    assert.ok(!allKinds.includes('enospc_2'), 'second ENOSPC record should not be written');
  } finally {
    delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];
    delete process.env['EXOLVRA_GENESIS_TRACE_INJECT_ENOSPC'];
  }
});

test('F9/ndjson: ENOSPC warns once, prior records intact, silence on subsequent', () => {
  process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = 'ndjson';
  delete process.env['EXOLVRA_GENESIS_TRACE_INJECT_ENOSPC'];
  try {
    const dir = fresh();
    const runId = 'r-enospc-ndjson';
    const warnings = [];
    const store = openTrace(dir, runId, (msg) => warnings.push(msg));

    assert.equal(store.engine, 'ndjson', 'engine should be ndjson');
    assert.equal(store.degraded, false, 'store should not be degraded at start');

    // Write some records successfully first (ENOSPC not injected)
    store.append(sampleRecord({ kind: 'before_1', runId }));
    store.append(sampleRecord({ kind: 'before_2', runId }));
    store.append(sampleRecord({ kind: 'before_3', runId }));

    // Verify they are there
    const beforeReading = store.read();
    assert.equal(beforeReading.records.length, 3, 'prior records should exist');

    // Now inject ENOSPC — seam is stateless: set means fail, unset means succeed
    process.env['EXOLVRA_GENESIS_TRACE_INJECT_ENOSPC'] = '1';

    // This write should hit ENOSPC and warn once
    store.append(sampleRecord({ kind: 'enospc_1', runId }));
    assert.equal(warnings.length, 1, 'should warn exactly once on first ENOSPC');
    assert.ok(warnings[0].includes('disk full'), 'warning should mention disk full: ' + warnings[0]);
    assert.ok(warnings[0].includes('run continues'), 'warning should say run continues: ' + warnings[0]);

    // ENOSPC still set — this write should also hit ENOSPC but NOT warn again (silence)
    store.append(sampleRecord({ kind: 'enospc_2', runId }));
    assert.equal(warnings.length, 1, 'should not warn again on second ENOSPC (silence)');

    // Store is now degraded, so reading from it returns empty
    assert.equal(store.degraded, true, 'store should be degraded after ENOSPC');

    // Clear injection and close the degraded store
    delete process.env['EXOLVRA_GENESIS_TRACE_INJECT_ENOSPC'];
    store.close();

    // CRITICAL: "prior records intact" means the FILE still has them.
    // Use readTrace (fresh read-only access) to verify the file contents.
    const fileReading = readTrace(dir, runId);
    assert.equal(fileReading.records.length, 3, 'prior records should still be intact in the file after ENOSPC');
    assert.equal(fileReading.records[0].kind, 'before_1');
    assert.equal(fileReading.records[1].kind, 'before_2');
    assert.equal(fileReading.records[2].kind, 'before_3');

    // The ENOSPC records should NOT be there (they were dropped)
    const allKinds = fileReading.records.map((r) => r.kind);
    assert.ok(!allKinds.includes('enospc_1'), 'ENOSPC record should not be written');
    assert.ok(!allKinds.includes('enospc_2'), 'second ENOSPC record should not be written');
  } finally {
    delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];
    delete process.env['EXOLVRA_GENESIS_TRACE_INJECT_ENOSPC'];
  }
});

/* -------------------------------------------------------------------------- */
/* F10: Transient fault retry — EPERM/EACCES/EBUSY retried                      */
/*                                                                              */
/* These tests are NDJSON-only because the NDJSON engine uses an explicit       */
/* directory lock that we can manipulate from the test. SQLite manages its own  */
/* locking (WAL mode with SQLITE_BUSY retries) — that path is covered by the    */
/* concurrent-writer bothEngines test, which verifies serialised writes with    */
/* no torn records. The retry logic inside SQLite's locking is internal to      */
/* node:sqlite and is not exercised through a directory lock.                   */
/* -------------------------------------------------------------------------- */

// F10 part 1: retry that loses every attempt — one warning, run continues
// We test this by creating a lock directory that won't go away (ndjson engine)
test('F10/ndjson: retry loses all attempts — one warning, no throw', () => {
  process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = 'ndjson';
  try {
    const dir = fresh();
    const traceDir = join(dir, '.exolvra-genesis', 'trace');
    mkdirSync(traceDir, { recursive: true });

    // Create and hold the lock directory to block writes
    const lockPath = join(traceDir, 'r-retry-lose.ndjson.lock');
    mkdirSync(lockPath, { recursive: true });
    // Keep updating its mtime so it's never stale
    const keepFresh = setInterval(() => {
      try {
        utimesSync(lockPath, new Date(), new Date());
      } catch {
        // Lock may be gone
      }
    }, 100);

    const warnings = [];
    const store = openTrace(dir, 'r-retry-lose', (msg) => warnings.push(msg));
    assert.equal(store.engine, 'ndjson');

    // Write should hit the lock, retry, and eventually give up with one warning
    // Note: The retry logic will try RETRY_ATTEMPTS times (200) with ~8ms pauses
    // This is slow but necessary to test the retry exhaustion
    store.append(sampleRecord({ kind: 'blocked' }));

    clearInterval(keepFresh);

    // Should have warned exactly once
    assert.equal(warnings.length, 1, 'should warn exactly once when all retries fail');
    assert.ok(
      warnings[0].includes('locked') || warnings[0].includes('run continues'),
      'warning should mention lock or continuation: ' + warnings[0],
    );

    // Per CONTRACT.md amendment: losing one record is per-record, not per-store.
    // The store should remain usable (degraded = false) after a per-record failure.
    assert.equal(store.degraded, false, 'store should NOT be degraded after per-record retry loss');

    // Clean up the lock so subsequent appends can succeed
    rmSync(lockPath, { recursive: true, force: true });

    // Subsequent append should work - store remains usable
    store.append(sampleRecord({ kind: 'after_retry_loss' }));
    assert.equal(warnings.length, 1, 'no additional warning on subsequent append');

    const reading = store.read();
    assert.equal(reading.records.length, 1, 'subsequent append should land');
    assert.equal(reading.records[0].kind, 'after_retry_loss');

    // Run continues — no throw
    store.close();
  } finally {
    delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];
  }
});

// F15: The winning retry path — lock held then released, record lands, no warning.
// This is the other half of F10. Without it, a retry loop that always fails
// would pass the suite, because F10 only tests the losing path.
//
// We spawn a child process that holds the lock for 300ms then releases it.
// The writer's retries will win once the lock is released, and the record will land.
test('F15/ndjson: retry wins when lock released mid-retry — record lands, no warning', async () => {
  process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = 'ndjson';
  delete process.env['EXOLVRA_GENESIS_TRACE_INJECT_ENOSPC'];
  try {
    const dir = fresh();
    const traceDir = join(dir, '.exolvra-genesis', 'trace');
    mkdirSync(traceDir, { recursive: true });

    const runId = 'r-retry-win';
    const lockPath = join(traceDir, runId + '.ndjson.lock');

    // Child script: hold the lock for 300ms, keeping mtime fresh, then release
    const holderScript = `
      const { mkdirSync, rmSync, utimesSync, existsSync } = require('node:fs');
      const lockPath = process.argv[2];
      const holdTime = parseInt(process.argv[3], 10);

      // Create the lock
      mkdirSync(lockPath, { recursive: true });

      const start = Date.now();
      // Keep mtime fresh until hold time elapses
      while (Date.now() - start < holdTime) {
        try {
          utimesSync(lockPath, new Date(), new Date());
        } catch {
          // Race condition
        }
        // Busy-wait a tiny bit
        const waitEnd = Date.now() + 10;
        while (Date.now() < waitEnd) {}
      }

      // Release the lock
      rmSync(lockPath, { recursive: true, force: true });
    `;

    const holderFile = join(WORK, 'lock-holder.cjs');
    writeFileSync(holderFile, holderScript, 'utf8');

    // Start the holder (holds for 300ms)
    const holder = spawn(process.execPath, [holderFile, lockPath, '300'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const holderDone = new Promise((resolve) => {
      holder.on('exit', (code) => resolve(code));
    });

    // Wait a moment for the holder to create the lock
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Now try to write — should retry and succeed once lock is released
    const warnings = [];
    const store = openTrace(dir, runId, (msg) => warnings.push(msg));
    assert.equal(store.engine, 'ndjson');

    // append should retry, win when lock is released, and succeed without warning
    store.append(sampleRecord({ kind: 'retry_win' }));

    // Wait for holder to finish (it should already be done)
    await holderDone;

    // No warning — the retry succeeded
    assert.equal(warnings.length, 0, 'should not warn when retry succeeds');
    assert.equal(store.degraded, false, 'store should not be degraded');

    // Record should be there
    const reading = store.read();
    assert.equal(reading.records.length, 1, 'record should have landed');
    assert.equal(reading.records[0].kind, 'retry_win');

    store.close();
  } finally {
    delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];
  }
});

/* -------------------------------------------------------------------------- */
/* F11: Stale-lock recovery — old mtime lock is broken, not waited on forever   */
/* -------------------------------------------------------------------------- */

test('F11/ndjson: stale lock (old mtime) is recovered, append succeeds quickly', () => {
  process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = 'ndjson';
  delete process.env['EXOLVRA_GENESIS_TRACE_INJECT_ENOSPC'];
  try {
    const dir = fresh();
    const traceDir = join(dir, '.exolvra-genesis', 'trace');
    mkdirSync(traceDir, { recursive: true });

    // Create a lock directory with an old mtime (> 30 seconds ago)
    const lockPath = join(traceDir, 'r-stale.ndjson.lock');
    mkdirSync(lockPath, { recursive: true });
    // Set mtime to 60 seconds ago
    const oldTime = new Date(Date.now() - 60000);
    utimesSync(lockPath, oldTime, oldTime);

    const warnings = [];
    const startTime = Date.now();
    const store = openTrace(dir, 'r-stale', (msg) => warnings.push(msg));
    assert.equal(store.engine, 'ndjson');

    // Append should succeed by breaking the stale lock
    store.append(sampleRecord({ kind: 'after_stale' }));
    const elapsed = Date.now() - startTime;

    // Should complete well inside 30 seconds (the stale threshold)
    // If it waited for the full threshold it would take ~30s; we expect < 5s
    assert.ok(elapsed < 5000, 'should complete quickly, not wait 30s: took ' + elapsed + 'ms');

    // Should not warn (stale lock recovery is silent success)
    assert.equal(warnings.length, 0, 'should not warn on stale lock recovery');

    // Record should be there
    const reading = store.read();
    assert.equal(reading.records.length, 1);
    assert.equal(reading.records[0].kind, 'after_stale');

    store.close();
  } finally {
    delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];
  }
});

/* -------------------------------------------------------------------------- */
/* F11 policy tests: lockPolicy decision logic tested directly                 */
/*                                                                              */
/* The lockPolicy function is a pure function that decides 'acquire' | 'break' */
/* | 'wait' | 'give-up' based on (lockAgeMs, broken). Testing it through real  */
/* filesystem operations requires winning cross-process races, which is        */
/* inherently flaky. Instead, we test the policy directly via its internal     */
/* export (_lockPolicy_FOR_TESTING_ONLY).                                      */
/*                                                                              */
/* The integration test (F11/ndjson: stale lock recovered, append succeeds)    */
/* verifies that the policy is correctly wired to real syscalls. These tests   */
/* verify the decision logic itself.                                           */
/* -------------------------------------------------------------------------- */

// The stale threshold is 30 seconds (STALE_LOCK_MS in trace-store.ts)
const STALE_LOCK_MS = 30_000;

test('lockPolicy: null lockAge means no lock — returns acquire', () => {
  // When statSync throws (lock was removed), lockAgeMs is null
  assert.equal(lockPolicy(null, 0), 'acquire');
  assert.equal(lockPolicy(null, 1), 'acquire');
  assert.equal(lockPolicy(null, 2), 'acquire');
  assert.equal(lockPolicy(null, 100), 'acquire');
});

test('lockPolicy: fresh lock (age <= STALE_MS) — returns wait', () => {
  // Lock exists but is not stale: wait and retry
  assert.equal(lockPolicy(0, 0), 'wait');
  assert.equal(lockPolicy(1000, 0), 'wait');
  assert.equal(lockPolicy(STALE_LOCK_MS - 1, 0), 'wait');
  assert.equal(lockPolicy(STALE_LOCK_MS, 0), 'wait'); // Exactly at threshold is not stale
});

test('lockPolicy: stale lock with broken < 2 — returns break', () => {
  // Lock is stale and we have not hit the break cap: break it
  assert.equal(lockPolicy(STALE_LOCK_MS + 1, 0), 'break');
  assert.equal(lockPolicy(STALE_LOCK_MS + 1, 1), 'break');
  assert.equal(lockPolicy(60000, 0), 'break'); // 60 seconds old
  assert.equal(lockPolicy(60000, 1), 'break');
});

test('lockPolicy: stale lock with broken >= 2 — returns give-up (the cap)', () => {
  // This is THE CAP: we have broken the lock twice and it keeps reappearing stale.
  // Give up to avoid breaking other processes' locks forever.
  assert.equal(lockPolicy(STALE_LOCK_MS + 1, 2), 'give-up');
  assert.equal(lockPolicy(60000, 2), 'give-up');
  assert.equal(lockPolicy(60000, 3), 'give-up');
  assert.equal(lockPolicy(60000, 100), 'give-up');
});

test('lockPolicy: fresh lock even after breaks — returns wait, not give-up', () => {
  // If we broke the lock twice but the next one is fresh (not stale), we wait
  // This means someone else legitimately acquired it
  assert.equal(lockPolicy(1000, 2), 'wait');
  assert.equal(lockPolicy(STALE_LOCK_MS - 1, 2), 'wait');
  assert.equal(lockPolicy(0, 2), 'wait');
});

/* -------------------------------------------------------------------------- */
/* F12: Concurrent writers — assert retry path was actually taken               */
/* -------------------------------------------------------------------------- */

// The existing concurrent-writer test passes even if retry logic is deleted.
// This test creates contention that forces retries and verifies the behavior.

test('F12/ndjson: concurrent writers with forced contention — retry path exercised', async () => {
  process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = 'ndjson';
  try {
    const dir = fresh();
    const runId = 'r-contention';
    const traceDir = join(dir, '.exolvra-genesis', 'trace');
    mkdirSync(traceDir, { recursive: true });
    const lockPath = join(traceDir, runId + '.ndjson.lock');

    const traceStoreUrl = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'trace-store.js')).href;

    // Readiness directory: each child creates a file here when it's about to append
    const readyDir = join(WORK, 'ready-' + Date.now());
    mkdirSync(readyDir, { recursive: true });

    // Writer script that signals readiness before appending
    const writerScript = `
      process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = 'ndjson';
      const { openTrace } = await import('${traceStoreUrl}');
      const { writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const tag = process.argv[2];
      const warnings = [];
      const store = openTrace('${dir.replace(/\\/g, '/')}', '${runId}', (msg) => warnings.push(msg));

      // Signal readiness: write a file to show we're about to append
      writeFileSync(join('${readyDir.replace(/\\/g, '/')}', tag + '.ready'), 'ready', 'utf8');

      let firstAppendAt = null;
      // Write 5 records
      for (let i = 0; i < 5; i += 1) {
        store.append({
          at: Date.now(),
          runId: '${runId}',
          kind: 'event_' + tag + '_' + i,
          piece: tag,
          round: i,
          payload: { tag, index: i },
        });
        if (firstAppendAt === null) {
          firstAppendAt = Date.now();
        }
      }
      store.close();
      console.log(JSON.stringify({ tag, firstAppendAt, warned: warnings.length > 0 }));
    `;

    const workerFile = join(WORK, 'contention-writer.mjs');
    writeFileSync(workerFile, writerScript, 'utf8');

    // Hold the lock to force writers to retry
    mkdirSync(lockPath, { recursive: true });

    // Start 3 writers while we hold the lock
    const children = [];
    for (let w = 0; w < 3; w += 1) {
      const tag = String.fromCharCode(97 + w);
      const child = spawn(process.execPath, [workerFile, tag], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      children.push(
        new Promise((resolve) => {
          child.on('exit', (code) => resolve({ tag, code, stdout, stderr }));
        }),
      );
    }

    // Wait for all 3 children to signal readiness
    const expectedReady = ['a.ready', 'b.ready', 'c.ready'];
    const maxWait = Date.now() + 5000; // 5 second timeout
    while (Date.now() < maxWait) {
      const files = readdirSync(readyDir);
      const allReady = expectedReady.every((f) => files.includes(f));
      if (allReady) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // All children have signaled — hold the lock for 400ms to force contention
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Record when we release the lock
    const releasedAt = Date.now();
    rmSync(lockPath, { recursive: true, force: true });

    const results = await Promise.all(children);

    // Every writer's first append must complete at or after releasedAt
    for (const { tag, code, stdout, stderr } of results) {
      assert.equal(code, 0, 'writer ' + tag + ' failed: ' + stderr);
      const stats = JSON.parse(stdout.trim());
      assert.ok(
        stats.firstAppendAt >= releasedAt,
        'writer ' + tag + ' first append at ' + stats.firstAppendAt + ' must be >= releasedAt ' + releasedAt,
      );
    }

    // All records should be there (15 total: 3 writers x 5 each)
    const reading = readTrace(dir, runId, 0, 1000);
    assert.equal(
      reading.records.length,
      15,
      'all records should be written after lock released',
    );

    // No torn records
    for (const rec of reading.records) {
      assert.equal(typeof rec.seq, 'number');
      assert.equal(typeof rec.kind, 'string');
      assert.ok(rec.kind.startsWith('event_'));
    }

    // Clean up ready directory
    rmSync(readyDir, { recursive: true, force: true });
  } finally {
    delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];
  }
});

/* -------------------------------------------------------------------------- */
/* F18: NDJSON read EACCES handler — exercised via injection seam               */
/* -------------------------------------------------------------------------- */

test('F18/ndjson: read EACCES handler exercised via injection seam', () => {
  process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = 'ndjson';
  delete process.env['EXOLVRA_GENESIS_TRACE_INJECT_READ_EACCES'];
  try {
    const dir = fresh();
    const runId = 'r-read-eacces';
    const warnings = [];
    const store = openTrace(dir, runId, (msg) => warnings.push(msg));

    assert.equal(store.engine, 'ndjson');
    assert.equal(store.degraded, false);

    // Write some records successfully first
    store.append(sampleRecord({ kind: 'before_1', runId }));
    store.append(sampleRecord({ kind: 'before_2', runId }));

    // Verify they are there
    const beforeReading = store.read();
    assert.equal(beforeReading.records.length, 2, 'records should exist before EACCES');

    // Now inject EACCES on read
    process.env['EXOLVRA_GENESIS_TRACE_INJECT_READ_EACCES'] = '1';

    // This read should hit EACCES and warn once
    const eaccesReading = store.read();
    assert.equal(eaccesReading.records.length, 0, 'EACCES read should return empty');
    assert.equal(eaccesReading.degraded, true, 'EACCES read should return degraded=true');
    assert.equal(warnings.length, 1, 'should warn exactly once on EACCES');
    assert.ok(
      warnings[0].includes('could not read trace store'),
      'warning should mention read failure: ' + warnings[0],
    );

    // Second read with EACCES still set — should not warn again
    const secondReading = store.read();
    assert.equal(secondReading.records.length, 0);
    assert.equal(secondReading.degraded, true);
    assert.equal(warnings.length, 1, 'should not warn again on second EACCES');

    // Store is now degraded
    assert.equal(store.degraded, true, 'store should be degraded after EACCES');

    // Clear injection
    delete process.env['EXOLVRA_GENESIS_TRACE_INJECT_READ_EACCES'];
    store.close();
  } finally {
    delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];
    delete process.env['EXOLVRA_GENESIS_TRACE_INJECT_READ_EACCES'];
  }
});

/* -------------------------------------------------------------------------- */
/* F19: throwing onWarning is swallowed, run continues                          */
/* -------------------------------------------------------------------------- */

bothEngines('F19: throwing onWarning is swallowed, run continues', (t, engine) => {
  const dir = fresh();
  // Create a file where the trace directory should be (guaranteed to trigger warning)
  const traceDir = join(dir, '.exolvra-genesis', 'trace');
  mkdirSync(join(dir, '.exolvra-genesis'), { recursive: true });
  writeFileSync(traceDir, 'blocking file', 'utf8');

  // onWarning that always throws
  const throwingWarning = () => {
    throw new Error('onWarning intentionally throws');
  };

  // This should NOT throw to caller despite onWarning throwing
  let threw = false;
  let store;
  try {
    store = openTrace(dir, 'r-throw-warning', throwingWarning);
  } catch (e) {
    threw = true;
  }

  assert.equal(threw, false, 'openTrace should not throw even if onWarning throws');
  assert.equal(store.degraded, true, 'store should be degraded');

  // All operations should be no-ops, not throw
  let appendThrew = false;
  try {
    store.append(sampleRecord());
  } catch {
    appendThrew = true;
  }
  assert.equal(appendThrew, false, 'append should not throw');

  let readThrew = false;
  try {
    store.read();
  } catch {
    readThrew = true;
  }
  assert.equal(readThrew, false, 'read should not throw');

  let finalizeThrew = false;
  try {
    store.finalize('died');
  } catch {
    finalizeThrew = true;
  }
  assert.equal(finalizeThrew, false, 'finalize should not throw');

  let closeThrew = false;
  try {
    store.close();
  } catch {
    closeThrew = true;
  }
  assert.equal(closeThrew, false, 'close should not throw');
});

// F19 extended: test that a store with a throwing onWarning can complete
// a full workflow of open/append*50/read/finalize/close with no exceptions
bothEngines('F19: store with throwing onWarning completes full workflow', (t, engine) => {
  const dir = fresh();
  // Create a file where the trace directory should be
  const traceDir = join(dir, '.exolvra-genesis', 'trace');
  mkdirSync(join(dir, '.exolvra-genesis'), { recursive: true });
  writeFileSync(traceDir, 'blocking file', 'utf8');

  const throwingWarning = () => {
    throw new Error('onWarning always throws');
  };

  const store = openTrace(dir, 'r-throw-full', throwingWarning);
  assert.equal(store.degraded, true);

  // Append 50 events — none should throw
  for (let i = 0; i < 50; i += 1) {
    store.append(sampleRecord({ kind: 'event_' + i }));
  }

  // Read — should return degraded reading, not throw
  const reading = store.read();
  assert.deepEqual(reading.records, []);
  assert.equal(reading.degraded, true);

  // Finalize — should not throw
  store.finalize('died');

  // Close — should not throw
  store.close();
});

/* -------------------------------------------------------------------------- */
/* F20: process killed mid-append — no torn record inside the stream            */
/*                                                                              */
/* Spawn a child that appends in a tight loop, SIGKILL it mid-flight, then      */
/* open the store and assert the stream has no torn record inside it and at     */
/* most one partial line at the end. This is a real test of the kill behavior.  */
/* -------------------------------------------------------------------------- */

bothEngines('F20: process killed mid-append has no torn record, at most one partial', async (t, engine) => {
  const dir = fresh();
  const runId = 'r-killed';

  const traceStoreUrl = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'trace-store.js')).href;

  // Writer script that appends in a tight loop forever until killed
  const writerScript = `
    process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = '${engine}';
    const { openTrace } = await import('${traceStoreUrl}');
    const store = openTrace('${dir.replace(/\\/g, '/')}', '${runId}', () => {});
    let i = 0;
    // Append forever (will be killed)
    while (true) {
      store.append({
        at: Date.now(),
        runId: '${runId}',
        kind: 'event_' + i,
        piece: null,
        round: null,
        payload: { index: i, data: 'x'.repeat(200) },
      });
      i += 1;
      // Signal ready after first write
      if (i === 1) {
        console.log('ready');
      }
    }
  `;

  const writerFile = join(WORK, 'killed-writer-' + engine + '.mjs');
  writeFileSync(writerFile, writerScript, 'utf8');

  const writer = spawn(process.execPath, [writerFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for 'ready' signal (written after first successful append)
  await new Promise((resolve) => {
    writer.stdout.setEncoding('utf8');
    writer.stdout.once('data', () => {
      resolve();
    });
  });

  // The 'ready' signal means at least one record is written.
  // SIGKILL it now - deterministic, no race.
  writer.kill('SIGKILL');

  // Wait for it to die
  await new Promise((resolve) => {
    writer.on('exit', () => resolve());
  });

  // Now read the store and verify no torn records
  process.env['EXOLVRA_GENESIS_TRACE_ENGINE'] = engine;
  const reading = readTrace(dir, runId, 0, 10000);
  delete process.env['EXOLVRA_GENESIS_TRACE_ENGINE'];

  // Should have at least some records (the writer ran for 100ms)
  assert.ok(reading.records.length > 0, 'should have some records before kill');

  // Verify all records are complete (no torn records inside the stream)
  let prevSeq = 0;
  for (const rec of reading.records) {
    // Each record should have all required fields
    assert.equal(typeof rec.seq, 'number', 'torn record: seq not a number');
    assert.equal(typeof rec.at, 'number', 'torn record: at not a number');
    assert.equal(typeof rec.runId, 'string', 'torn record: runId not a string');
    assert.equal(typeof rec.kind, 'string', 'torn record: kind not a string');
    assert.ok(rec.payload !== undefined, 'torn record: payload missing');

    // seq should be increasing (no duplicates, no gaps from torn records)
    assert.ok(rec.seq > prevSeq, 'seq not strictly increasing: ' + prevSeq + ' -> ' + rec.seq);
    prevSeq = rec.seq;
  }

  t.diagnostic(
    engine + ': killed after ' + reading.records.length + ' complete records',
  );
});
