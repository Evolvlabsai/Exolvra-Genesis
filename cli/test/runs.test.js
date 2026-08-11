import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { mostRecentFirst, relativeTime, renderRuns } from '../dist/commands/runs.js';
import { CTRL_C, DOWN, ENTER, fakeTty, frames, press, waitFor } from './tty.js';
import {
  pickRun,
  positionalTokens,
  resumeCommand,

} from '../dist/commands/resume.js';
import { ConfigError } from '../dist/exit.js';
import {
  appendRun,
  isRunId,
  lockPath,
  newRunId,
  readRuns,
  readState,
  runsPath,
  statePath,
  updateRun,
  writeState,
} from '../dist/runs-store.js';
import { displayWidth } from '../dist/usage.js';
import { BIN, PACKAGE_ROOT, REPO_ROOT, createSandbox, runProcess } from './run-cli.js';

/*
 * The run ledger, `gauntlet runs`, and `gauntlet resume`.
 *
 * The store is exercised directly, on real directories under the system's temp
 * directory; the two commands are exercised as real child processes running the
 * binary the package ships. The only substitution anywhere below is the Claude
 * Agent SDK, which the bar allows — and even there, what is asserted is what the
 * CLI handed it: the session id it was told to resume.
 *
 * The transcript written to `.evidence/` is one of those processes' own stdout.
 */

const EVIDENCE = join(PACKAGE_ROOT, '.evidence');
mkdirSync(EVIDENCE, { recursive: true });

const WORK = mkdtempSync(join(tmpdir(), 'gauntlet-runs-'));
const sandbox = createSandbox();
after(() => {
  sandbox.cleanup();
  rmSync(WORK, { recursive: true, force: true });
});

/** The escape character, built rather than typed, so this file stays readable. */
const ESC = String.fromCharCode(27);
const BELL = String.fromCharCode(7);

let directories = 0;

/** A directory of its own for one test, so no test can see another's ledger. */
function fresh() {
  const dir = join(WORK, 'run-' + (directories += 1));
  mkdirSync(dir, { recursive: true });
  return dir;
}

const MODELS = {
  lead: 'claude-opus-5',
  builder: 'opus',
  critic: 'sonnet',
};

/** A record in the shape the store accepts. */
function record(overrides = {}) {
  return {
    id: 'r-20260810-1712-a3f9c1',
    sessionId: 'sesn_01J9ZQ',
    input: 'a settings page indistinguishable from linear.app',
    models: { ...MODELS },
    startedAt: '2026-08-10T17:12:04.000Z',
    status: 'running',
    ...overrides,
  };
}

/** Writes the ledger with no help from the store, the way another tool would. */
function seed(dir, runs) {
  mkdirSync(join(dir, '.gauntlet'), { recursive: true });
  writeFileSync(runsPath(dir), JSON.stringify(runs, null, 2) + '\n', 'utf8');
  return dir;
}

/** Collects everything written to a stream, for the picker's questions. */
function capture() {
  const chunks = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, done) {
        chunks.push(String(chunk));
        done();
      },
    }),
    text: () => chunks.join(''),
  };
}

/** A stream that hands over `answers` and then ends, as a terminal would not. */
function typed(...answers) {
  const input = new Readable({ read() {} });
  for (const answer of answers) input.push(answer);
  input.push(null);
  return input;
}

/* -------------------------------------------------------------------------- */
/* The store                                                                   */
/* -------------------------------------------------------------------------- */

test('the store round-trips a run through a directory that was not there', () => {
  const dir = join(fresh(), 'nested', 'deeper');

  assert.deepEqual(readRuns(dir), [], 'a directory with no ledger has no runs');

  const first = record();
  appendRun(dir, first);
  assert.deepEqual(readRuns(dir), [first]);

  const second = record({ id: 'r-20260810-1719-ff0021', input: 'specs/checkout.md' });
  appendRun(dir, second);
  assert.deepEqual(
    readRuns(dir).map((run) => run.id),
    [first.id, second.id],
    'records are kept in the order they were recorded',
  );

  const updated = updateRun(dir, first.id, {
    status: 'complete',
    lastVerdict: 'WIN',
    rounds: 3,
    costUsd: 12.5,
  });
  assert.deepEqual(updated, {
    ...first,
    status: 'complete',
    lastVerdict: 'WIN',
    rounds: 3,
    costUsd: 12.5,
  });

  const [readFirst, readSecond] = readRuns(dir);
  assert.deepEqual(readFirst, updated, 'the patch survives a round trip through disk');
  assert.deepEqual(readSecond, second, 'the other record is written back untouched');
});

test('a run keeps its id, and a run that is not there cannot be updated', () => {
  const dir = fresh();
  appendRun(dir, record());
  assert.throws(() => updateRun(dir, record().id, { id: 'r-other' }), /keeps the id/);
  assert.throws(() => appendRun(dir, record()), /already recorded/);
  assert.throws(() => updateRun(dir, 'r-not-here', { status: 'complete' }), ConfigError);
});

test('a run id is the shape newRunId writes, and nothing wider', () => {
  const id = newRunId(new Date('2026-08-10T17:12:04.000Z'));
  assert.match(id, /^r-20260810-1712-[0-9a-f]{6}$/);
  assert.equal(isRunId(id), true, 'the format the store itself writes is rejected');
  assert.notEqual(newRunId(), newRunId(), 'two ids made in the same minute differ');

  for (const accepted of ['a', 'R1', 'r-20260810-1712-a3f9c1', 'run.2', 'a'.repeat(64)]) {
    assert.equal(isRunId(accepted), true, 'rejected: ' + JSON.stringify(accepted));
  }

  for (const refused of [
    '',
    'two words',
    'a'.repeat(65),
    '../../etc/passwd',
    '..',
    '.hidden',
    'runs/../../secret',
    'C:\\Windows\\System32',
    '-starts-with-a-dash',
    'r-' + ESC + '[31mred',
    'r-a\tb',
    'r-a' + String.fromCharCode(0x202e) + 'b',
  ]) {
    assert.equal(isRunId(refused), false, 'accepted: ' + JSON.stringify(refused));
  }
});

test('writeState writes the shape the shipped Stop hook greps for', () => {
  const dir = fresh();

  // The pattern is not written out here: it is read out of the hook the plugin
  // ships, so the two cannot drift apart without this failing.
  const hook = JSON.parse(
    readFileSync(join(REPO_ROOT, 'hooks', 'verification-gate.example.json'), 'utf8'),
  );
  const command = hook.hooks.Stop[0].hooks[0].command;
  const quoted = command.match(/grep -q '([^']+)' \.gauntlet\/state\.json/);
  assert.ok(quoted !== null, 'the hook no longer greps state.json: ' + command);
  const pattern = new RegExp(quoted[1]);

  writeState(dir, 'running');
  const written = readFileSync(statePath(dir), 'utf8');
  assert.match(written, pattern, 'the hook would not see this run as running');
  assert.deepEqual(JSON.parse(written), { status: 'running' });
  assert.deepEqual(readState(dir), { status: 'running', detail: 'it says "running"' });

  for (const status of ['complete', 'stopped', 'blocked']) {
    writeState(dir, status);
    const text = readFileSync(statePath(dir), 'utf8');
    assert.doesNotMatch(text, pattern, status + ' still reads as a running run');
    assert.equal(readState(dir).status, status);
  }

  assert.throws(() => writeState(dir, 'whatever'), /not a run status/);
});

test('a status file that is missing or unusable is an answer, not a crash', () => {
  const dir = fresh();
  assert.deepEqual(readState(dir), { status: undefined, detail: 'it was never written' });

  mkdirSync(join(dir, '.gauntlet'), { recursive: true });
  writeFileSync(statePath(dir), '{"status": ', 'utf8');
  assert.equal(readState(dir).status, undefined);
  assert.match(readState(dir).detail, /not readable JSON/);

  writeFileSync(statePath(dir), '{"status": "halfway"}', 'utf8');
  assert.deepEqual(readState(dir), {
    status: undefined,
    detail: "it does not say what the run's status is",
  });
});

test('every write is a rename, so a reader never sees a half-written ledger', async (t) => {
  const dir = fresh();
  const writer = join(WORK, 'writer.mjs');
  const store = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'runs-store.js')).href;
  const total = 120;

  // A hundred and twenty records, written one after another with nothing
  // between them, into a ledger well over a hundred kilobytes. Both halves
  // matter: a file that size is not written in one step, and a writer that
  // never pauses is writing for a large share of the time the reader below is
  // sampling — so a writer that truncated the file in place would be caught in
  // the act, repeatedly. Checked: it is (see the mutation run in the report).
  writeFileSync(
    writer,
    [
      "import { appendRun } from '" + store + "';",
      'const [dir, count] = process.argv.slice(2);',
      "const goal = 'a goal, long enough that no write of the ledger is one chunk. '.repeat(20);",
      'for (let i = 0; i < Number(count); i += 1) {',
      '  appendRun(dir, {',
      "    id: 'r-' + String(i).padStart(4, '0'),",
      "    sessionId: 'sesn_' + i,",
      '    input: goal,',
      '    models: ' + JSON.stringify(MODELS) + ',',
      '    startedAt: new Date().toISOString(),',
      "    status: 'running',",
      '  });',
      '}',
    ].join('\n'),
    'utf8',
  );

  const child = spawn(process.execPath, [writer, dir, String(total)], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let running = true;
  let code = null;
  let failure = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    failure += chunk;
  });
  child.on('exit', (status) => {
    running = false;
    code = status;
  });

  const path = runsPath(dir);
  let reads = 0;
  let torn = 0;
  while (running) {
    try {
      const text = readFileSync(path, 'utf8');
      reads += 1;
      if (!Array.isArray(JSON.parse(text))) torn += 1;
    } catch (error) {
      // A read before the first write, or the instant a rename holds the name
      // on Windows, is not a torn read. Unreadable JSON is.
      if (error instanceof SyntaxError) torn += 1;
    }
    // Sampled at a random phase, and often. Two loops that both wait a fixed
    // number of milliseconds on Windows tick on the same coarse timer and drift
    // into step, so a reader can end up sampling the same moment of every write
    // — and a reader that lands only between writes proves nothing about what
    // is visible during one.
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 3)));
  }

  assert.equal(code, 0, 'the writer failed: ' + failure);
  assert.equal(torn, 0, torn + ' of ' + reads + ' reads saw a half-written ledger');
  assert.ok(reads > 20, 'the ledger was read only ' + reads + ' times while it was written');
  assert.equal(readRuns(dir).length, total, 'records were lost');
  assert.deepEqual(leftovers(dir), [], 'the writer left something behind');

  // What makes the reads above worth counting: a file this size is written in
  // several chunks, so a writer that did not rename would have been caught.
  const size = readFileSync(path, 'utf8').length;
  assert.ok(size > 64 * 1024, 'the ledger was only ' + size + ' bytes, too small to tear');

  t.diagnostic(
    total +
      ' records (' +
      Math.round(size / 1024) +
      'KB) written while read ' +
      reads +
      ' times: ' +
      torn +
      ' torn reads',
  );
});

/** Anything a finished writer should have cleaned up after itself. */
function leftovers(dir) {
  return readdirSync(join(dir, '.gauntlet')).filter(
    (name) => name.endsWith('.tmp') || name === basename(lockPath(dir)),
  );
}

/**
 * The multi-process hammer: N runs recording into one ledger at once.
 *
 * Each worker appends its own records and updates each one straight after
 * writing it — the two halves of what a live run does. An atomic write is not
 * enough for this on its own: without a lock every worker reads the ledger,
 * adds its record to the copy it read, and writes a whole valid file back over
 * everyone else's, and the records that were in flight are gone.
 */
test('runs recording at the same time as each other lose nothing', async (t) => {
  const dir = fresh();
  const workers = 6;
  const each = 40;
  const hammer = join(WORK, 'hammer.mjs');
  const store = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'runs-store.js')).href;

  writeFileSync(
    hammer,
    [
      "import { appendRun, updateRun } from '" + store + "';",
      'const [dir, tag, count] = process.argv.slice(2);',
      'for (let i = 0; i < Number(count); i += 1) {',
      "  const id = 'r-' + tag + '-' + String(i).padStart(3, '0');",
      '  appendRun(dir, {',
      '    id,',
      "    sessionId: 'sesn_' + tag + i,",
      "    input: 'a goal recorded by worker ' + tag,",
      '    models: ' + JSON.stringify(MODELS) + ',',
      '    startedAt: new Date().toISOString(),',
      "    status: 'running',",
      '  });',
      '  // Straight after appending, and from another process than the one that',
      '  // wrote the record before it: the case that used to fail, loudly.',
      "  updateRun(dir, id, { status: 'complete', lastVerdict: 'WIN', rounds: 2 });",
      '}',
    ].join('\n'),
    'utf8',
  );

  const children = [];
  for (let worker = 0; worker < workers; worker += 1) {
    const tag = String.fromCharCode(97 + worker);
    const child = spawn(process.execPath, [hammer, dir, tag, String(each)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let failure = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      failure += chunk;
    });
    children.push(
      new Promise((resolve) => {
        child.on('exit', (code) => resolve({ tag, code, failure }));
      }),
    );
  }

  // Read the ledger while they all write to it, so this also says whether a
  // reader can be shown a half-written file under real contention.
  const path = runsPath(dir);
  let done = false;
  const finished = Promise.all(children).then((results) => {
    done = true;
    return results;
  });
  let reads = 0;
  let torn = 0;
  // And every so often, the real command, against the same ledger the six of
  // them are writing to: a listing that lands on a write must not report a
  // ledger it cannot read.
  const listings = [];
  while (!done) {
    try {
      const text = readFileSync(path, 'utf8');
      reads += 1;
      if (!Array.isArray(JSON.parse(text))) torn += 1;
    } catch (error) {
      if (error instanceof SyntaxError) torn += 1;
    }
    if (reads > 0 && reads % 25 === 0) {
      listings.push(runProcess(BIN, ['runs', '-C', dir, '--limit', '3'], {}));
    }
    await new Promise((resolve) => setTimeout(resolve, 4));
  }

  for (const { tag, code, failure } of await finished) {
    assert.equal(code, 0, 'worker ' + tag + ' failed: ' + failure);
  }

  const runs = readRuns(dir);
  assert.equal(
    runs.length,
    workers * each,
    'expected ' + workers * each + ' records, found ' + runs.length,
  );
  const ids = new Set(runs.map((run) => run.id));
  assert.equal(ids.size, runs.length, 'the ledger holds a repeated id');
  for (let worker = 0; worker < workers; worker += 1) {
    const tag = String.fromCharCode(97 + worker);
    for (let i = 0; i < each; i += 1) {
      const id = 'r-' + tag + '-' + String(i).padStart(3, '0');
      assert.ok(ids.has(id), 'lost the record ' + id);
    }
  }
  // Every update landed too, on the record its own process had just appended.
  assert.deepEqual(
    [...new Set(runs.map((run) => run.status))],
    ['complete'],
    'an update was overwritten by another process',
  );
  assert.equal(torn, 0, torn + ' of ' + reads + ' reads saw a half-written ledger');
  assert.ok(reads > 20, 'the ledger was read only ' + reads + ' times');
  assert.ok(listings.length > 0, 'the command was never run while they wrote');
  for (const listing of listings) {
    assert.equal(listing.code, 0, 'a listing during a write failed: ' + listing.stderr);
    assert.ok(listing.stdout !== '', 'a listing during a write printed nothing');
  }
  assert.deepEqual(leftovers(dir), [], 'a worker left something behind');

  t.diagnostic(
    workers +
      ' processes x ' +
      each +
      ' records: ' +
      runs.length +
      ' appended, ' +
      runs.length +
      ' updated, ' +
      reads +
      ' concurrent reads, ' +
      torn +
      ' torn, ' +
      listings.length +
      ' listings during the writes, all exit 0',
  );
});

test('a lock left behind by a run that died is taken over, not waited on', () => {
  const dir = fresh();
  appendRun(dir, record({ id: 'r-first' }));

  // A lock with nothing behind it: the directory is there, and nothing has
  // touched it for long enough that no live writer could still be holding it.
  const lock = lockPath(dir);
  mkdirSync(lock, { recursive: true });
  const old = Date.now() - 5 * 60_000;
  utimesSync(lock, new Date(old), new Date(old));

  const started = Date.now();
  appendRun(dir, record({ id: 'r-second' }));
  assert.ok(Date.now() - started < 10_000, 'a stale lock was waited on rather than broken');
  assert.deepEqual(
    readRuns(dir).map((run) => run.id),
    ['r-first', 'r-second'],
  );
  assert.deepEqual(leftovers(dir), []);
});

test('a record written by something else survives the next append', () => {
  const dir = fresh();
  appendRun(dir, record({ id: 'r-first' }));

  // Another writer, between this process's two calls: the ledger is re-read at
  // write time rather than kept in memory, so what it added is carried forward.
  const outside = record({ id: 'r-outside', status: 'complete' });
  seed(dir, [...readRuns(dir), outside]);

  appendRun(dir, record({ id: 'r-second' }));
  assert.deepEqual(
    readRuns(dir).map((run) => run.id),
    ['r-first', 'r-outside', 'r-second'],
  );

  updateRun(dir, 'r-first', { status: 'stopped' });
  assert.deepEqual(
    readRuns(dir).map((run) => run.id),
    ['r-first', 'r-outside', 'r-second'],
    'an update rewrote the ledger without the other writer',
  );
});

/* -------------------------------------------------------------------------- */
/* A ledger that cannot be read                                                */
/* -------------------------------------------------------------------------- */

const CORRUPT = [
  ['a write that was cut off', '[{"id": "r-a", "sessionId": null,'],
  ['an empty file', ''],
  ['whitespace', '\n\n'],
  ['a JSON object', '{"runs": []}'],
  ['a record that is a string', '["r-a"]'],
  ['a record with no id', '[{"sessionId": null, "input": "x"}]'],
  ['a record with a space in its id', JSON.stringify([record({ id: 'not an id' })])],
  ['a record with no models', JSON.stringify([{ ...record(), models: undefined }])],
  ['a record with an unknown status', JSON.stringify([record({ status: 'halfway' })])],
  ['a verdict that is not text', JSON.stringify([record({ lastVerdict: 12 })])],
  ['a start time that is not a time', JSON.stringify([record({ startedAt: 'whenever' })])],
  [
    'a start time no calendar has',
    JSON.stringify([record({ startedAt: '2026-13-45T99:99:99Z' })]),
  ],
  ['a start time that is empty', JSON.stringify([record({ startedAt: '' })])],
  [
    'two records under one id',
    JSON.stringify([record({ id: 'r-twice' }), record({ id: 'r-twice', status: 'complete' })]),
  ],
];

for (const [name, contents] of CORRUPT) {
  test('a ledger holding ' + name + ' is a configuration error naming the file', () => {
    const dir = seed(fresh(), []);
    writeFileSync(runsPath(dir), contents, 'utf8');

    assert.throws(
      () => readRuns(dir),
      (error) => {
        assert.ok(error instanceof ConfigError, 'not a configuration error: ' + error);
        assert.ok(
          error.message.includes(runsPath(dir)),
          'the fault does not name the file: ' + error.message,
        );
        return true;
      },
    );

    // And nothing writes over it: the records in it are not this CLI's to lose.
    assert.throws(() => appendRun(dir, record()), ConfigError);
    assert.equal(readFileSync(runsPath(dir), 'utf8'), contents);
  });
}

test('a repeated id is named, and neither command guesses which run it meant', () => {
  const dir = seed(fresh(), [
    { ...record(), id: 'r-twice', startedAt: '2026-08-10T10:00:00.000Z' },
    { ...record(), id: 'r-twice', startedAt: '2026-08-10T18:00:00.000Z', status: 'stopped' },
  ]);

  const listed = runProcess(BIN, ['runs', '-C', dir], {});
  assert.equal(listed.code, 2, listed.stdout + listed.stderr);
  assert.equal(listed.stdout, '');
  assert.match(listed.stderr, /repeats the id "r-twice"/);
  assert.match(listed.stderr, /record 2 repeats the id "r-twice", which record 1 already used/);

  const resumed = runProcess(BIN, ['resume', 'r-twice', '-C', dir], {});
  assert.equal(resumed.code, 2, resumed.stderr);
  assert.equal(resumed.stdout, '', 'a session was started on one of two records');
  assert.match(resumed.stderr, /repeats the id "r-twice"/);
});

test('a ledger that cannot be read stops the commands with exit 2', () => {
  const dir = seed(fresh(), []);
  writeFileSync(runsPath(dir), '[{"id": "r-a",', 'utf8');

  const listed = runProcess(BIN, ['runs', '-C', dir], {});
  assert.equal(listed.code, 2, 'a corrupt ledger must exit 2: ' + listed.stderr);
  assert.equal(listed.stdout, '', 'nothing may be printed as though it were a ledger');
  assert.match(listed.stderr, /could not read the run ledger/);
  assert.ok(listed.stderr.includes(runsPath(dir)), listed.stderr);

  const resumed = runProcess(BIN, ['resume', 'r-a', '-C', dir], {});
  assert.equal(resumed.code, 2, resumed.stderr);
  assert.ok(resumed.stderr.includes(runsPath(dir)), resumed.stderr);
});

/* -------------------------------------------------------------------------- */
/* Relative time                                                               */
/* -------------------------------------------------------------------------- */

test('an age is the shortest form that still says how long ago it was', () => {
  const now = new Date('2026-08-10T17:12:04.000Z');
  const ago = (ms) => relativeTime(new Date(now.getTime() - ms).toISOString(), now);

  assert.equal(ago(0), 'just now');
  assert.equal(ago(4_000), 'just now');
  assert.equal(ago(5_000), '5s ago');
  assert.equal(ago(59_000), '59s ago');
  assert.equal(ago(60_000), '1m ago');
  assert.equal(ago(12 * 60_000), '12m ago');
  assert.equal(ago(59 * 60_000 + 59_000), '59m ago');
  assert.equal(ago(60 * 60_000), '1h ago');
  assert.equal(ago(3 * 3_600_000), '3h ago');
  assert.equal(ago(23 * 3_600_000), '23h ago');
  assert.equal(ago(24 * 3_600_000), '1d ago');
  assert.equal(ago(29 * 86_400_000), '29d ago');
  assert.equal(ago(30 * 86_400_000), '1mo ago');
  assert.equal(ago(364 * 86_400_000), '12mo ago');
  assert.equal(ago(365 * 86_400_000), '1y ago');
  assert.equal(ago(800 * 86_400_000), '2y ago');

  // Two machines, two clocks. A start time in the future is a real thing to
  // find in a ledger, and it reads as one rather than as an ordinary age.
  assert.equal(ago(-4_000), 'just now');
  assert.equal(ago(-30_000), 'in 30s');
  assert.equal(ago(-90_000), 'in 1m');
  assert.equal(ago(-3 * 3_600_000), 'in 3h');
  assert.equal(ago(-400 * 86_400_000), 'in 1y');

  // The ledger is a file, so the field may hold something that is not a time at
  // all. It is shown as it was recorded rather than as an invented date.
  assert.equal(relativeTime('halfway through', now), 'halfway through');
  assert.equal(relativeTime('', now), '');
});

test('runs are listed newest first, however the ledger is ordered', () => {
  const runs = [
    record({ id: 'r-old', startedAt: '2026-08-01T00:00:00.000Z' }),
    record({ id: 'r-new', startedAt: '2026-08-10T00:00:00.000Z' }),
    record({ id: 'r-undated', startedAt: 'whenever' }),
    record({ id: 'r-middle', startedAt: '2026-08-05T00:00:00.000Z' }),
  ];
  assert.deepEqual(
    mostRecentFirst(runs).map((run) => run.id),
    ['r-new', 'r-middle', 'r-old', 'r-undated'],
  );
  assert.deepEqual(mostRecentFirst([]), []);
});

/* -------------------------------------------------------------------------- */
/* The table                                                                   */
/* -------------------------------------------------------------------------- */

/** Six runs, mixed statuses, aged so the table shows every unit it can. */
function ledger(now = Date.now()) {
  const at = (minutes) => new Date(now - minutes * 60_000).toISOString();
  return [
    {
      ...record(),
      id: 'r-20260808-0904-9c21ab',
      sessionId: 'sesn_01HZQ4',
      input: 'specs/checkout.md',
      startedAt: at(2 * 24 * 60),
      status: 'complete',
      lastVerdict: 'WIN',
      rounds: 4,
      costUsd: 18.42,
    },
    {
      ...record(),
      id: 'r-20260809-1130-77aa02',
      sessionId: null,
      input: 'a CLI whose help output is indistinguishable from gh',
      startedAt: at(27 * 60),
      status: 'blocked',
    },
    {
      ...record(),
      id: 'r-20260810-0712-a3f9c1',
      sessionId: 'sesn_01J2FE',
      input: 'a settings page indistinguishable from linear.app',
      startedAt: at(3 * 60),
      status: 'stopped',
      lastVerdict: 'LOSS: the empty state is a bare div',
      rounds: 2,
    },
    {
      ...record(),
      id: 'r-20260810-1650-be44d0',
      sessionId: 'sesn_01J8KM',
      input: 'specs/api-gateway.md',
      startedAt: at(45),
      status: 'running',
    },
    {
      ...record(),
      id: 'r-20260810-1712-c10e5f',
      sessionId: 'sesn_01J9ZQ',
      input: 'a parser for the wire format in docs/protocol.md',
      startedAt: at(12),
      status: 'running',
      lastVerdict: 'LOSS',
      rounds: 1,
    },
    {
      ...record(),
      id: 'r-20260810-1719-ff0021',
      sessionId: 'sesn_01JA02',
      input: 'make the onboarding prompts feel like the ones clack draws',
      startedAt: at(3),
      status: 'running',
    },
  ];
}

test('the table is the real renderer, and it is written to .evidence', () => {
  const dir = seed(fresh(), ledger());
  const { code, stdout, stderr } = runProcess(BIN, ['runs', '-C', dir], {
    env: { GAUNTLET_FORCE_TTY: '100' },
  });
  assert.equal(code, 0, stderr);
  writeFileSync(join(EVIDENCE, 'runs-table.txt'), stdout, 'utf8');

  const lines = stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 7, 'a header row and six records:\n' + stdout);
  assert.match(lines[0], /^ID {2,}STARTED {2,}INPUT {2,}STATUS {2,}VERDICT$/);
  assert.ok(!stdout.includes('\t'), 'a terminal layout emitted tabs');

  // Newest first, with an age rather than a timestamp.
  assert.ok(lines[1].startsWith('r-20260810-1719-ff0021'), lines[1]);
  assert.ok(lines[6].startsWith('r-20260808-0904-9c21ab'), lines[6]);
  assert.match(lines[1], / 3m ago /);
  assert.match(lines[6], / 2d ago /);

  // Columns: every cell starts where its header does, and nothing runs past the
  // width the output was laid out for.
  for (const heading of ['STARTED', 'INPUT', 'STATUS', 'VERDICT']) {
    const column = lines[0].indexOf(heading);
    for (const line of lines) {
      assert.equal(line[column - 1], ' ', 'a cell ran into the gutter: ' + line);
      assert.notEqual(line[column], ' ', 'a column is not filled: ' + line);
    }
  }
  for (const line of lines) {
    assert.ok(displayWidth(line) <= 100, 'a row ran past the layout: ' + line);
  }
});

test('a piped table is tab-delimited records with the timestamps as recorded', () => {
  const dir = seed(fresh(), ledger());
  const { code, stdout } = runProcess(BIN, ['runs', '-C', dir], {});
  assert.equal(code, 0);

  const rows = stdout.split('\n').filter((line) => line !== '');
  assert.equal(rows.length, 6, 'a pipe gets no header row:\n' + stdout);
  for (const row of rows) {
    const fields = row.split('\t');
    assert.equal(fields.length, 5, 'a record with the wrong field count: ' + row);
    assert.ok(!fields.some((field) => field === ''), 'an empty field: ' + row);
    assert.doesNotMatch(row, / {2}/, 'a piped row was padded: ' + row);
  }
  assert.match(rows[0].split('\t')[1], /^\d{4}-\d{2}-\d{2}T/, 'a pipe should sort');
});

test('--limit takes the most recent runs, and --json writes the records', () => {
  const dir = seed(fresh(), ledger());

  const limited = runProcess(BIN, ['runs', '-C', dir, '--limit', '2'], {});
  assert.equal(limited.code, 0);
  assert.equal(limited.stdout.trim().split('\n').length, 2);

  const piped = runProcess(BIN, ['runs', '-C', dir, '--json', '-L', '3'], {});
  assert.equal(piped.code, 0, piped.stderr);
  assert.equal(piped.stdout.trim().split('\n').length, 1, 'piped JSON is one line');
  const records = JSON.parse(piped.stdout);
  assert.deepEqual(
    records.map((run) => run.id),
    ['r-20260810-1719-ff0021', 'r-20260810-1712-c10e5f', 'r-20260810-1650-be44d0'],
  );
  assert.deepEqual(records[2].models, MODELS, 'every field of the record is written');

  const terminal = runProcess(BIN, ['runs', '-C', dir, '--json'], {
    env: { GAUNTLET_FORCE_TTY: '100' },
  });
  assert.deepEqual(JSON.parse(terminal.stdout).length, 6);
  assert.ok(terminal.stdout.includes('\n  {'), 'a terminal gets JSON laid out');
});

/** Every field --json is documented to write, in the order it writes them. */
const JSON_FIELDS = [
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

test('every record --json writes has every field, whatever is in it', () => {
  const dir = seed(fresh(), ledger());
  const { code, stdout } = runProcess(BIN, ['runs', '-C', dir, '--json'], {});
  assert.equal(code, 0);

  const records = JSON.parse(stdout);
  assert.equal(records.length, 6);
  for (const written of records) {
    assert.deepEqual(
      Object.keys(written),
      JSON_FIELDS,
      'the shape of a record depends on its content: ' + JSON.stringify(written),
    );
  }

  // A run with no verdict, no rounds and no cost yet still carries all three,
  // as null — the same three keys a finished run carries.
  const running = records.find((run) => run.id === 'r-20260810-1650-be44d0');
  assert.deepEqual(
    { lastVerdict: running.lastVerdict, rounds: running.rounds, costUsd: running.costUsd },
    { lastVerdict: null, rounds: null, costUsd: null },
  );
  const finished = records.find((run) => run.id === 'r-20260808-0904-9c21ab');
  assert.deepEqual(
    { lastVerdict: finished.lastVerdict, rounds: finished.rounds, costUsd: finished.costUsd },
    { lastVerdict: 'WIN', rounds: 4, costUsd: 18.42 },
  );
  assert.equal(
    records.find((run) => run.id === 'r-20260809-1130-77aa02').sessionId,
    null,
    'a run with no session must say so rather than leave the field out',
  );
});

test('the fields the help lists are exactly the fields --json writes', () => {
  const help = runProcess(BIN, ['runs', '--help'], {}).stdout;
  const section = help.split('JSON FIELDS')[1].split('EXAMPLES')[0];
  // The list, which is the first paragraph; the prose under it explains why
  // this command's field names are spelled the way they are.
  const listed = section
    .trim()
    .split(/\n\s*\n/)[0]
    .split(/[,\s]+/)
    .filter((field) => field !== '');
  assert.deepEqual(listed, JSON_FIELDS, 'the help promises a different set of fields');

  // And it says which contract it is following, because there are two here and
  // they disagree on purpose.
  assert.match(section, /cost_usd and session_id/);
  assert.match(section, /gh follows for its own --json/);
});

test('a directory with no runs says so on stderr, and still exits 0', () => {
  const dir = fresh();
  const { code, stdout, stderr } = runProcess(BIN, ['runs', '-C', dir], {});

  // Nothing on stdout at all: a listing piped into something else is either a
  // listing or is empty, and never a sentence about the absence of one.
  assert.equal(stdout, '', 'a listing of nothing put something on stdout');
  assert.equal(stderr, 'no runs found in ' + runsPath(dir) + '\n');
  // Listing zero runs answers the question that was asked. Exit 1 is this
  // CLI's word for a verdict, and an empty directory is not one — so the
  // silent-success guard, which is there to catch work that went unreported,
  // must not turn a complete listing into a failing code.
  assert.equal(code, 0, 'an empty listing is a successful listing: ' + stderr);

  // --json is a shape, and an empty list is that shape: it stays on stdout.
  const asJson = runProcess(BIN, ['runs', '-C', dir, '--json'], {});
  assert.equal(asJson.code, 0);
  assert.deepEqual(JSON.parse(asJson.stdout), []);
});

test('only the commands that declare it may succeed having printed nothing', async () => {
  const { getCommands, loadCommands } = await import('../dist/registry.js');
  await loadCommands();

  const exempt = getCommands()
    .filter((command) => command.emptyIsSuccess === true)
    .map((command) => command.name);
  assert.deepEqual(exempt, ['runs'], 'the exemption spread beyond the listing command');

  // And the rule still holds for everything else, measured on a real process:
  // a command that claims success having written nothing is reported, not
  // quietly believed.
  const { code, stdout, stderr } = runProcess(BIN, ['plan', '--help'], {});
  assert.equal(code, 0);
  assert.ok(stdout.length > 0, 'the control case printed nothing');
  assert.equal(stderr, '');
});

/** The overrides and isolates that reorder a line rather than draw on it. */
const BIDI = /\p{Bidi_Control}/u;
const RLO = String.fromCharCode(0x202e);
const PDF = String.fromCharCode(0x202c);

test('a run named with an escape sequence cannot repaint the table', () => {
  const dir = seed(fresh(), [
    record({
      id: 'r-hostile',
      input: ESC + '[31mred' + ESC + '[0m\tone\nline' + BELL,
      lastVerdict: 'WIN' + ESC + '[2J',
    }),
  ]);
  const { code, stdout } = runProcess(BIN, ['runs', '-C', dir], {
    env: { GAUNTLET_FORCE_TTY: '100' },
  });
  assert.equal(code, 0);
  assert.ok(!stdout.includes(ESC), 'an escape sequence reached the terminal');
  assert.equal(stdout.trim().split('\n').length, 2, 'one record became two lines');
  assert.match(stdout, /red one line/);
});

test('a run named with a bidi override cannot turn the row around', () => {
  const dir = seed(fresh(), [
    record({
      id: 'r-bidi',
      input: 'harmless ' + RLO + 'gninnur si nur rehtona' + PDF,
      lastVerdict: 'WIN' + RLO + 'SSOL',
    }),
  ]);

  for (const env of [{ GAUNTLET_FORCE_TTY: '100' }, {}]) {
    const { code, stdout } = runProcess(BIN, ['runs', '-C', dir], { env });
    assert.equal(code, 0);
    assert.ok(!BIDI.test(stdout), 'a bidi control reached the terminal');
    assert.ok(stdout.includes('harmless'), stdout);
  }

  // The picker draws the same fields, from the same records.
  const { stderr } = runProcess(BIN, ['resume', '-C', dir], {});
  assert.ok(!BIDI.test(stderr), 'a bidi control reached the terminal from resume');
});

/* -------------------------------------------------------------------------- */
/* Resume: which run, and how it says it cannot tell                           */
/* -------------------------------------------------------------------------- */

test('an unknown run id exits 2 and lists the ids that are recorded', () => {
  const dir = seed(fresh(), ledger());
  const { code, stdout, stderr } = runProcess(BIN, ['resume', 'r-nope-123', '-C', dir], {});
  assert.equal(code, 2, stderr);
  assert.equal(stdout, '');
  assert.match(stderr, /no run is recorded as "r-nope-123"/);
  for (const run of ledger()) assert.ok(stderr.includes(run.id), stderr);
  assert.match(stderr, /Usage: {2}gauntlet resume \[<run-id>\] \[flags\]/);
});

test('a run id that is not the shape of one is rejected before the ledger', () => {
  const dir = fresh();
  const { code, stdout, stderr } = runProcess(BIN, ['resume', 'not a run id', '-C', dir], {});
  assert.equal(code, 2, stderr);
  assert.equal(stdout, '');
  assert.match(stderr, /invalid value "not a run id" for <run-id>/);
});

/**
 * A listing bigger than a pipe's buffer, read by something that stops after one
 * line — `gauntlet runs | head -1`.
 *
 * The one-line exit for a closed pipe is the CLI entry point's, over the stream
 * every command writes through. What this asserts is what a user sees, so it
 * covers both halves: that `runs` writes through that stream, and that a broken
 * pipe leaves a terminal with a line rather than a page of this CLI's internals.
 */
test('a listing piped into a reader that stops does not print a stack trace', async () => {
  const wide = 'a goal long enough that this listing is well past a pipe buffer '.repeat(2);
  const dir = seed(
    fresh(),
    Array.from({ length: 600 }, (unused, i) => ({
      ...record(),
      id: 'r-' + String(i).padStart(5, '0'),
      sessionId: 'sesn_' + i,
      input: wide,
      startedAt: new Date(Date.parse('2026-08-10T17:12:04.000Z') - i * 60_000).toISOString(),
    })),
  );

  const child = spawn(process.execPath, [BIN, 'runs', '-C', dir, '--limit', '100000'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exited = new Promise((resolve) => child.on('exit', resolve));
  // One line is all this consumer wants; then it closes the pipe under the
  // writer, exactly as `head -1` does.
  await new Promise((resolve) => {
    child.stdout.once('data', resolve);
    child.on('exit', resolve);
  });
  child.stdout.destroy();
  await exited;

  const lines = stderr.split('\n').filter((line) => line.trim() !== '');
  assert.ok(
    lines.length <= 2,
    'a broken pipe printed ' + lines.length + ' lines:\n' + stderr,
  );
  assert.ok(!/^\s+at /m.test(stderr), 'a stack frame reached the terminal:\n' + stderr);
  assert.ok(
    !/[A-Za-z]:[\\/]|\/dist\/|file:\/\//.test(stderr),
    'a path from this machine reached the terminal:\n' + stderr,
  );
});

test('a run that never started a session exits 2 saying so', () => {
  const dir = seed(fresh(), ledger());
  const { code, stdout, stderr } = runProcess(
    BIN,
    ['resume', 'r-20260809-1130-77aa02', '-C', dir],
    {},
  );
  assert.equal(code, 2, stderr);
  assert.equal(stdout, '');
  assert.match(stderr, /never started a session/);
  assert.ok(stderr.includes(runsPath(dir)), stderr);
});

test('a run that has already finished is not resumed', () => {
  const dir = seed(fresh(), ledger());
  const options = join(dir, 'sdk-options.json');
  const { code, stdout, stderr } = sandbox.run(
    ['resume', 'r-20260808-0904-9c21ab', '-C', dir, '--plugin-dir', REPO_ROOT],
    { record: options, cwd: dir },
  );

  assert.equal(code, 2, stderr);
  assert.equal(stdout, '');
  assert.match(stderr, /has already finished/);
  assert.match(stderr, /records it as complete/);
  assert.equal(
    readdirSync(dir).includes('sdk-options.json'),
    false,
    'a session was started on a run that was already over',
  );
});

test('with no id and no terminal, resume names the candidates and exits 2', () => {
  const dir = seed(fresh(), ledger());
  const { code, stdout, stderr } = runProcess(BIN, ['resume', '-C', dir], {});

  assert.equal(code, 2, stderr);
  assert.equal(stdout, '', 'nothing was printed as though a run had been resumed');
  assert.match(stderr, /stdin is not a terminal/);

  // Every unfinished run with a session to go back to, and none of the others.
  const offered = ['r-20260810-1719-ff0021', 'r-20260810-1712-c10e5f', 'r-20260810-1650-be44d0', 'r-20260810-0712-a3f9c1'];
  for (const id of offered) assert.ok(stderr.includes(id), 'not offered: ' + id);
  assert.ok(!stderr.includes('r-20260808-0904-9c21ab'), 'a finished run was offered');
  assert.ok(!stderr.includes('r-20260809-1130-77aa02'), 'a run with no session was offered');

  // And the line to type, which is the whole point of printing them.
  assert.match(stderr, /gauntlet resume r-20260810-1719-ff0021/);
});

test('a directory with nothing to resume says that instead, and still exits 2', () => {
  const finished = seed(fresh(), [record({ status: 'complete' })]);
  const { code, stderr } = runProcess(BIN, ['resume', '-C', finished], {});
  assert.equal(code, 2, stderr);
  assert.match(stderr, /can be resumed/);
  assert.match(stderr, /has finished, or never started a session/);

  const empty = fresh();
  const bare = runProcess(BIN, ['resume', '-C', empty], {});
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /no runs are recorded there yet/);
});

test('the optional argument is read the way the parser reads one', () => {
  const cases = [
    [[], []],
    [['r-a'], ['r-a']],
    [['--verbose'], []],
    [['-v', 'r-a'], ['r-a']],
    [['--max-turns', '5'], []],
    [['--max-turns', '5', 'r-a'], ['r-a']],
    [['--max-turns=5', 'r-a'], ['r-a']],
    [['-C', 'somewhere', '--permission-mode', 'plan', 'r-a'], ['r-a']],
    [['--', '--verbose'], ['--verbose']],
    [['-h'], []],
  ];
  for (const [argv, expected] of cases) {
    assert.deepEqual(positionalTokens(resumeCommand, argv), expected, argv.join(' '));
  }
});

test('a bad flag is a flag fault, not a missing argument', () => {
  const dir = fresh();
  const missing = runProcess(BIN, ['resume', '-C', dir, '--max-turns'], {});
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /flag needs an argument: --max-turns/);

  const unknown = runProcess(BIN, ['resume', '-C', dir, '--bogus'], {});
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown flag: --bogus/);
});

/* -------------------------------------------------------------------------- */
/* The picker                                                                  */
/* -------------------------------------------------------------------------- */

test('a narrow table cuts the goal before it cuts the id', () => {
  const runs = [
    record({
      id: 'r-20260811-0845-170e5c',
      input: 'a CLI whose help output is indistinguishable from gh in every respect',
      lastVerdict: 'LOSS',
    }),
  ];

  // Wide enough that every column but one fits, which is where the choice of
  // what to cut is actually made.
  const narrow = renderRuns(runs, { tty: true, width: 56 }, new Date());
  assert.ok(
    narrow.includes('r-20260811-0845-170e5c'),
    'the id was cut, and half an id cannot be typed back in:\n' + narrow,
  );
  assert.ok(narrow.includes('...'), 'nothing was cut at all, so nothing was traded');
  assert.equal(
    narrow.includes('indistinguishable from gh in every respect'),
    false,
    'the goal is the elastic column and should have absorbed the shortfall',
  );
  for (const line of narrow.split('\n').filter((line) => line !== '')) {
    assert.ok(line.length <= 56, 'a row ran past the terminal: ' + line);
  }
});

test('the picker is asked in the same language every other question is', async () => {
  const runs = mostRecentFirst(ledger()).filter((run) => run.status !== 'complete');
  const io = fakeTty();

  const driver = (async () => {
    await waitFor(io, 'Resume which run?');
    await press(io, DOWN);
    await press(io, ENTER);
  })();

  const chosen = await pickRun(runs, { input: io.input, output: io.output });
  await driver;

  assert.equal(chosen.id, runs[1].id, 'the second row was not the one handed back');

  // One product, one visual language: the rails, the marks and the keys are the
  // ones the startup pickers draw, not a number typed at a bare prompt.
  const drawn = frames(io.raw()).join('\n');
  assert.ok(drawn.includes('Resume which run?'), drawn);
  assert.match(drawn, /[◆◇] {2}Resume which run\?/);
  assert.ok(drawn.includes('↑/↓ to navigate • Enter: confirm'), drawn);
  for (const glyph of ['│', '●', '○']) {
    assert.ok(drawn.includes(glyph), 'the picker is missing ' + glyph + '\n' + drawn);
  }
  for (const run of runs) assert.ok(drawn.includes(run.id), 'not listed: ' + run.id);
  // Every row says what the run was and how it ended, so the id is not the only
  // thing separating two runs of the same goal.
  assert.ok(drawn.includes('ago'), 'no row said how long ago the run started');
});

test('the picker offers a way out, and quitting chooses nothing', async () => {
  const runs = [record({ id: 'r-a' }), record({ id: 'r-b' })];
  const io = fakeTty();

  const driver = (async () => {
    await waitFor(io, 'Resume which run?');
    // Past both runs, onto the row that resumes nothing.
    await press(io, DOWN);
    await press(io, DOWN);
    await press(io, ENTER);
  })();

  assert.equal(
    await pickRun(runs, { input: io.input, output: io.output }),
    undefined,
    'quitting must resume nothing',
  );
  await driver;
  assert.ok(frames(io.raw()).join('\n').includes('Quit'), 'no way out was offered');
});

test('cancelling the picker is a cancellation, not a choice', async () => {
  const runs = [record({ id: 'r-a' })];
  const io = fakeTty();

  const driver = (async () => {
    await waitFor(io, 'Resume which run?');
    await press(io, CTRL_C);
  })();

  await assert.rejects(
    () => pickRun(runs, { input: io.input, output: io.output }),
    (error) => error.name === 'PromptCancelledError',
    'Ctrl+C at the picker must not come back as a chosen run',
  );
  await driver;
  // The frame is closed on the way out rather than left hanging open.
  assert.ok(frames(io.raw()).join('\n').includes('└'), frames(io.raw()).join('\n'));
});

/* -------------------------------------------------------------------------- */
/* Resume: the session                                                         */
/* -------------------------------------------------------------------------- */

test('resume hands the recorded session id back to the SDK', () => {
  const dir = seed(fresh(), ledger());
  const options = join(dir, 'sdk-options.json');
  const id = 'r-20260810-1712-c10e5f';

  const { code, stdout, stderr } = sandbox.run(
    ['resume', id, '-C', dir, '--plugin-dir', REPO_ROOT],
    { record: options, cwd: dir },
  );

  const sent = JSON.parse(readFileSync(options, 'utf8'));
  assert.equal(sent.resume, 'sesn_01J9ZQ', 'the session id was not the one recorded');
  assert.equal(sent.cwd, dir);
  assert.equal(sent.maxTurns, 100);
  assert.equal(sent.permissionMode, 'acceptEdits');
  assert.deepEqual(Object.keys(sent.agents).sort(), ['gauntlet-builder', 'gauntlet-critic']);

  // Piped, a resumed run is the same stream a run writes: records, one per
  // line, and no block of the agent's own prose glued onto the end of them.
  for (const line of stdout.split('\n').filter((line) => line !== '')) {
    assert.ok(line.includes('\t'), 'a resumed run wrote something that is not a record: ' + line);
  }
  assert.ok(stdout.includes('goal\t'), stdout);
  assert.ok(stdout.includes('result\t'), stdout);
  assert.ok(stdout.includes('session\t'), stdout);
  assert.equal(stdout.includes('FAKE PLAN BODY'), false, 'the agent prose was printed');
  assert.equal(stdout.includes('RESULT'), false, 'the old prose block is still printed');

  // The session finished; the run did not say it had won, so this is not a win.
  assert.equal(code, 1, stderr);
  assert.match(stdout, /still unfinished/);
  assert.ok(stdout.includes(statePath(dir)), stdout);
  assert.ok(stdout.includes('resume it with: gauntlet resume ' + id), stdout);

  const after = readRuns(dir).find((run) => run.id === id);
  // The turn ended; the run did not. Recording it as complete would make the
  // command it just printed — `gauntlet resume <id>` — refuse that exact run a
  // moment later, because nothing resumes a run the ledger calls finished.
  assert.equal(after.status, 'stopped', 'a run that did not finish was recorded as one that did');
  assert.equal(after.sessionId, 'sesn_fake', 'the session the SDK reported is recorded');
  assert.equal(readState(dir).status, 'stopped', 'the two files disagree about the same run');

  // And the advice really works: the run it told the user to resume is a run
  // the very next invocation is willing to pick up.
  const again = sandbox.run(['resume', id, '-C', dir, '--plugin-dir', REPO_ROOT], {
    cwd: dir,
  });
  assert.notEqual(again.code, 2, 'the run it told the user to resume was refused:\n' + again.stderr);
  assert.equal(
    again.stderr.includes('nothing left of it to continue'),
    false,
    'the advice printed by one command was refused by the next:\n' + again.stderr,
  );
});

test('a complete left over from before the turn is not this turn s verdict', () => {
  const dir = seed(fresh(), ledger());
  // Whatever was in the file before the turn started — an earlier run in the
  // same directory, a hand edit — is not a report about the turn about to run.
  writeState(dir, 'complete');

  const { code, stdout, stderr } = sandbox.run(
    ['resume', 'r-20260810-1650-be44d0', '-C', dir, '--plugin-dir', REPO_ROOT],
    { cwd: dir },
  );

  // The turn ran and never reported the run complete, so it did not win: the
  // file is the turn's own, written `running` before it starts and settled
  // when it ends, exactly as a run keeps it.
  assert.equal(code, 1, stdout + stderr);
  assert.match(stdout, /^result\tLOSS\t/m, stdout);
  assert.equal(readState(dir).status, 'stopped');
  assert.equal(readRuns(dir).find((run) => run.id === 'r-20260810-1650-be44d0').status, 'stopped');
});

test('a resumed run that stops exits 1 and is recorded as stopped', () => {
  const dir = seed(fresh(), ledger());
  writeState(dir, 'complete');
  const id = 'r-20260810-1650-be44d0';

  const { code, stdout, stderr } = sandbox.run(
    ['resume', id, '-C', dir, '--plugin-dir', REPO_ROOT],
    { cwd: dir, subtype: 'error_max_turns' },
  );
  assert.equal(code, 1, stderr);
  assert.ok(stdout.includes(id), 'the run it stopped in the middle of is still named');
  assert.match(stdout, /did not finish: it ran out of agent turns/);
  assert.match(stdout, /raise the limit with --max-turns/);
  assert.equal(readRuns(dir).find((run) => run.id === id).status, 'stopped');
});

test('a session that fails is recorded as blocked', () => {
  const dir = seed(fresh(), ledger());
  const id = 'r-20260810-1650-be44d0';
  const { code, stderr } = sandbox.run(
    ['resume', id, '-C', dir, '--plugin-dir', REPO_ROOT],
    { cwd: dir, subtype: 'error_during_execution' },
  );
  assert.equal(code, 1, stderr);
  assert.equal(readRuns(dir).find((run) => run.id === id).status, 'blocked');
});

test('a model the ledger names but this build does not offer never reaches the SDK', () => {
  const dir = seed(fresh(), [
    record({ id: 'r-strange', models: { ...MODELS, critic: 'octopus' } }),
  ]);
  const options = join(dir, 'sdk-options.json');
  const { code, stdout, stderr } = sandbox.run(
    ['resume', 'r-strange', '-C', dir, '--plugin-dir', REPO_ROOT],
    { record: options, cwd: dir },
  );
  assert.equal(code, 2, stderr);
  assert.equal(stdout, '');
  assert.match(stderr, /"octopus" for the critic/);
  assert.equal(
    readdirSync(dir).includes('sdk-options.json'),
    false,
    'the run reached the SDK anyway',
  );
});

test('a turn that ended is not a run that finished', async () => {
  const { BLOCKED, LOST, STOPPED, WON, outcomeOf } = await import(
    '../dist/commands/run.js'
  );

  // One mapping, and it is the run that decides, not the turn. A session that
  // returns normally has ended its turn; whether the run is finished is what
  // state.json says, and nothing else.
  assert.equal(outcomeOf({ status: 'complete' }, true), WON);
  assert.equal(outcomeOf({ status: 'complete' }, false), LOST);
  assert.equal(outcomeOf({ status: 'stopped' }, false), STOPPED);
  assert.equal(outcomeOf({ status: 'error' }, false), BLOCKED);
  assert.equal(outcomeOf(undefined, false), STOPPED);

  // And one precedence outranks the rest: a run that met its win condition won,
  // however the turn carrying it ended. Anything else charges the user twice —
  // once for an exit code that says the work failed when it did not, and again
  // for the resume it invites over work that was already good enough.
  assert.equal(outcomeOf({ status: 'error' }, true), WON);
  assert.equal(outcomeOf({ status: 'stopped' }, true), WON);
  assert.equal(outcomeOf(undefined, true), WON);

  // And the ledger word each one carries is the one that decides whether the
  // run can be picked up again. `complete` is the only one that cannot.
  assert.equal(WON.ledger, 'complete');
  assert.equal(LOST.ledger, 'stopped');
  assert.equal(STOPPED.ledger, 'stopped');
  assert.equal(BLOCKED.ledger, 'blocked');
  assert.deepEqual(
    [WON.exit, LOST.exit, STOPPED.exit, BLOCKED.exit],
    [0, 1, 1, 1],
  );
});

test('renderRuns is what the process printed, from the same records', () => {
  const runs = mostRecentFirst(ledger());
  const now = new Date();
  const terminal = renderRuns(runs, { tty: true, width: 100 }, now);
  const piped = renderRuns(runs, { tty: false, width: 80 }, now);

  assert.equal(terminal.split('\n').length, 8, terminal);
  assert.ok(!terminal.includes('\t'));
  assert.equal(piped.split('\n').filter((line) => line !== '').length, 6);
  assert.ok(piped.includes('\t'));
  assert.ok(piped.includes(runs[0].startedAt), 'a pipe gets the timestamp as recorded');
});
