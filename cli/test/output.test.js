import assert from 'node:assert/strict';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { RUN_EVENT_TYPES, RUN_STATUSES, VERDICTS } from '../dist/events.js';
import { createReporter } from '../dist/output.js';
import { displayWidth, graphemes } from '../dist/usage.js';

/*
 * The output layer, driven directly.
 *
 * The reporter is a sink: events in, text out, no SDK and no process anywhere
 * near it. So there is nothing here to stand in for — every line asserted below
 * came out of the real reporter, over a real stream, and the three transcripts
 * in .evidence/ are the bytes it wrote into three real files.
 *
 * It has three views to be wrong in. A terminal gets columns, and the tests for
 * it are about what is in which column. A pipe gets records, and the tests for
 * it are about arity and about fields arriving whole. `--json` gets the stream
 * as data, and the tests for it are about every line parsing and the last one
 * being the summary CI was promised.
 *
 * Every field on an event was written by an agent or a critic, or was read back
 * out of this reporter's own output, so every field is tested with what a
 * prompt cannot rule out: newlines, tabs, escape sequences, ideographs, an
 * emoji spelled out of six code points, an unpaired surrogate, a paragraph
 * where a sentence was asked for, numbers that are not numbers, and nulls where
 * a string was declared. One round is one line in every view, whatever arrives.
 */

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVIDENCE = join(PACKAGE_ROOT, '.evidence');
mkdirSync(EVIDENCE, { recursive: true });

/* -------------------------------------------------------------------------- */
/* Driving the reporter                                                        */
/* -------------------------------------------------------------------------- */

/** A stream that keeps what was written, and can claim to be a terminal. */
class Collector extends Writable {
  constructor({ isTTY, columns } = {}) {
    super();
    this.written = [];
    if (isTTY !== undefined) this.isTTY = isTTY;
    if (columns !== undefined) this.columns = columns;
  }

  _write(chunk, _encoding, done) {
    this.written.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    done();
  }

  get text() {
    return this.written.join('');
  }
}

/** Runs a sequence of events through a new reporter and returns what it wrote. */
function render(events, options = {}) {
  const stream = new Collector(options);
  const reporter = createReporter({
    json: options.json === true,
    verbose: options.verbose === true,
    stream,
    ...(options.view === undefined ? {} : { view: options.view }),
  });
  for (const event of events) reporter.emit(event);
  return stream.text;
}

/** The same, laid out for a terminal of `width` columns and no color. */
function renderTerminal(events, width = 80, options = {}) {
  return render(events, { ...options, view: { tty: true, width } });
}

/** The written lines, with the trailing newline of the last one removed. */
function lines(text) {
  return text === '' ? [] : text.replace(/\n$/, '').split('\n');
}

const ESCAPE = String.fromCharCode(0x1b);
const CRLF = String.fromCharCode(0x0d, 0x0a);
const ANSI = new RegExp(ESCAPE + '\\[[0-9;]*m');

function stripAnsi(text) {
  return text.replace(new RegExp(ESCAPE + '\\[[0-9;]*m', 'g'), '');
}

/** Whether a line carries anything a terminal would act on rather than draw. */
function hasControl(line, { allowTab = false } = {}) {
  return [...line].some((character) => {
    const code = character.codePointAt(0);
    if (allowTab && code === 0x09) return false;
    return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f) || code === 0x2028;
  });
}

/**
 * One entry per display column of `line`.
 *
 * A character two columns wide occupies two entries, the second empty, so
 * `cells[9]` is what a reader sees in column 9 no matter how many code points
 * or UTF-16 units the columns before it were spelled with. Column discipline is
 * a claim about what is where on the screen, and this is how that claim is
 * checked.
 */
function columnCells(line) {
  const cells = [];
  for (const cluster of graphemes(line)) {
    cells.push(cluster);
    for (let extra = displayWidth(cluster); extra > 1; extra -= 1) cells.push('');
  }
  return cells;
}

function columnSlice(line, from, to) {
  return columnCells(line).slice(from, to).join('');
}

/* -------------------------------------------------------------------------- */
/* The geometry the round line promises, written out independently             */
/* -------------------------------------------------------------------------- */

const GUTTER = 2;
const ROUND_WIDTH = 3;
const VERDICT_WIDTH = displayWidth('▲ BLOCKED');
const ELAPSED_WIDTH = displayWidth('999h59m');

/**
 * Where each column of a round line starts.
 *
 * Written from the geometry the round line documents rather than read out of
 * the renderer, so the two are independent statements of where a field belongs.
 * The piece column is as wide as the widest piece the plan named, floored and
 * capped at the widths the renderer documents.
 */
function layout(pieceWidth = 2) {
  const piece = 0;
  const round = piece + Math.min(24, Math.max(2, pieceWidth)) + GUTTER;
  const verdict = round + ROUND_WIDTH + GUTTER;
  const elapsed = verdict + VERDICT_WIDTH + GUTTER;
  const gap = elapsed + ELAPSED_WIDTH + GUTTER;
  return { piece, round, verdict, elapsed, gap };
}

const VERDICT_TOKENS = { WIN: '✓ WIN', LOSS: '✗ LOSS', BLOCKED: '▲ BLOCKED' };

/**
 * Reads one round line back as the fields it was laid out from.
 *
 * It also checks the two blank columns between every pair of fields, which is
 * the whole of the alignment claim: if a field ran into its gutter the columns
 * below it would no longer stack.
 */
function readRoundLine(line, where) {
  const cells = columnCells(line);
  for (const start of [where.round, where.verdict, where.elapsed, where.gap]) {
    for (let column = start - GUTTER; column < start; column += 1) {
      assert.equal(cells[column] ?? ' ', ' ', `column ${column} of "${line}" is not a gutter`);
    }
  }
  return {
    piece: columnSlice(line, where.piece, where.round - GUTTER).trimEnd(),
    round: columnSlice(line, where.round, where.verdict - GUTTER).trimEnd(),
    verdict: columnSlice(line, where.verdict, where.elapsed - GUTTER).trimEnd(),
    elapsed: columnSlice(line, where.elapsed, where.gap - GUTTER).trimEnd(),
    gap: columnSlice(line, where.gap, cells.length),
  };
}

/** The records of a piped run: the lines that are tab-delimited. */
/** Every tab-delimited record a piped run wrote, whatever it is about. */
function allRecords(text) {
  return lines(text)
    .filter((line) => line.includes('\t'))
    .map((line) => line.split('\t'));
}

/**
 * The round records: the five-field ones.
 *
 * Piped output is records throughout — the preamble and the result are records
 * too — and a round is the one with five fields, which is the shape it has
 * always had and the shape anything reading this stream keys on.
 */
function records(text) {
  return allRecords(text).filter((row) => row.length === 5);
}

/* -------------------------------------------------------------------------- */
/* The run every transcript below is a rendering of                            */
/* -------------------------------------------------------------------------- */

/**
 * A builder's report, as an agent would write one.
 *
 * Aligned with runs of spaces, structured by its indentation, tab-indented in
 * one place, and carrying a command long enough to run off an eighty-column
 * terminal — which is to say, everything that stops being true about it the
 * moment something re-wraps it.
 */
const REPORT_LINES = [
  'FILES CHANGED',
  '  cli/src/usage.ts',
  '  cli/test/width.test.js',
  '',
  'VERIFICATION',
  '  ID    TITLE              COVERS',
  '  P1    Foundation         C1, C2',
  '  P2    Round streaming    R5, R11',
  '',
  '  # tests  399',
  '  # pass   399',
  '  # fail     0',
  '\t\ttwo tabs of indent, kept as two tabs',
  `${' '.repeat(40)}forty spaces of indent, kept as forty`,
  '  $ EXOLVRA_GENESIS_PLUGIN_DIR=/opt/exolvra-genesis exolvra-genesis run specs/checkout-flow.md --json | jq -c .',
];

const BUILDER_REPORT = REPORT_LINES.join('\n');

/**
 * A run of the loop, as events.
 *
 * Nine rounds across three pieces, every verdict represented, durations from
 * eleven seconds to over an hour, gaps both short enough to fit a column and
 * far too long for one, one warning in the middle, and one builder report that
 * only a verbose run asks to see. The transcripts in .evidence/ are this
 * sequence, rendered three ways.
 */
const RUN_SCRIPT = [
  { type: 'run_started', goal: 'specs/checkout-flow.md', source: 'spec' },
  {
    type: 'bar_captured',
    path: '.exolvra-genesis/bar/',
    artifacts: [
      { path: '.exolvra-genesis/bar/gh/root-help.txt', detail: 'gh --help: sectioning and alignment' },
      {
        path: '.exolvra-genesis/bar/gh/leaf-help-flags.txt',
        detail: 'gh run list --help: the flag table',
      },
      { path: '.exolvra-genesis/bar/gh/list-output.txt', detail: 'gh run list: tabular output' },
      { path: '.exolvra-genesis/bar/clack/frames-plain.txt', detail: '@clack/prompts 1.7.0 frames' },
    ],
  },
  {
    type: 'plan_ready',
    pieces: [
      { id: 'P1', title: 'Foundation, plugin loader, and the help pages' },
      { id: 'P2', title: 'Round streaming and NDJSON output' },
      { id: 'P3', title: 'Interactive startup prompts' },
    ],
  },
  {
    type: 'round',
    piece: 'P1',
    round: 1,
    verdict: 'LOSS',
    gap: 'the flag table prints no value placeholder after each long flag, so a reader cannot tell which flags take an argument',
    elapsedMs: 252_000,
  },
  {
    type: 'agent_output',
    agent: 'exolvra-genesis-builder',
    piece: 'P1',
    round: 2,
    text: BUILDER_REPORT,
  },
  {
    type: 'round',
    piece: 'P1',
    round: 2,
    verdict: 'LOSS',
    gap: 'LEARN MORE is missing from the root help',
    elapsedMs: 181_000,
  },
  { type: 'round', piece: 'P1', round: 3, verdict: 'WIN', elapsedMs: 164_000 },
  {
    type: 'round',
    piece: 'P2',
    round: 1,
    verdict: 'LOSS',
    gap: 'the summary line carries five keys where CI was promised four',
    elapsedMs: 118_000,
  },
  {
    type: 'round',
    piece: 'P2',
    round: 2,
    verdict: 'LOSS',
    gap: 'a gap holding a newline split one round across two lines',
    elapsedMs: 126_000,
  },
  { type: 'round', piece: 'P2', round: 3, verdict: 'WIN', elapsedMs: 97_000 },
  {
    type: 'notice',
    level: 'warning',
    message:
      'the spec file changed on disk while the run was going; the run is still being judged against the copy captured at the start',
  },
  {
    type: 'round',
    piece: 'P3',
    round: 1,
    verdict: 'BLOCKED',
    gap: 'no capture command for the interactive frames without a terminal',
    elapsedMs: 11_000,
  },
  {
    type: 'round',
    piece: 'P3',
    round: 2,
    verdict: 'LOSS',
    gap: 'the note box rail is drawn with hyphens where clack draws a box rule',
    elapsedMs: 200_000,
  },
  { type: 'round', piece: 'P3', round: 3, verdict: 'WIN', elapsedMs: 3_723_000 },
  {
    type: 'run_finished',
    status: 'win',
    rounds: 9,
    costUsd: 4.8123,
    sessionId: '018f4c2b-9a3d-4b21-8f0e-2c7a1d5e6b90',
  },
];

const SCRIPT_ROUNDS = RUN_SCRIPT.filter((event) => event.type === 'round');

/* -------------------------------------------------------------------------- */
/* One sample of every event there is                                          */
/* -------------------------------------------------------------------------- */

/**
 * A sample per member of the union, keyed by tag.
 *
 * Checked against `RUN_EVENT_TYPES` below, so an event added to the union
 * without a sample here fails rather than going untested.
 */
const SAMPLES = {
  run_started: { type: 'run_started', goal: 'a settings page', source: 'goal' },
  bar_captured: {
    type: 'bar_captured',
    path: '.exolvra-genesis/bar/BAR.md',
    artifacts: [{ path: '.exolvra-genesis/bar/gh/root-help.txt', detail: 'gh --help' }],
  },
  plan_ready: { type: 'plan_ready', pieces: [{ id: 'P1', title: 'Foundation' }] },
  round: { type: 'round', piece: 'P1', round: 1, verdict: 'WIN', elapsedMs: 9000 },
  agent_output: { type: 'agent_output', agent: 'exolvra-genesis-critic', text: 'VERDICT\nWIN' },
  notice: { type: 'notice', level: 'note', message: 'resuming session 018f4c2b' },
  run_finished: {
    type: 'run_finished',
    status: 'loss',
    rounds: 4,
    costUsd: 0.9,
    sessionId: '018f4c2b',
  },
};

test('every event in the union renders in every view', () => {
  assert.deepEqual([...RUN_EVENT_TYPES].sort(), Object.keys(SAMPLES).sort());

  for (const type of RUN_EVENT_TYPES) {
    const event = SAMPLES[type];

    for (const [what, text] of [
      ['piped', render([event], { verbose: true })],
      ['terminal', renderTerminal([event], 80, { verbose: true })],
    ]) {
      assert.ok(text.endsWith('\n'), `${type} wrote a ${what} line without ending it`);
      assert.ok(text.trim() !== '', `${type} rendered nothing in the ${what} view`);
    }

    const machine = lines(render([event], { json: true }));
    assert.equal(machine.length, 1, `${type} was not exactly one JSON line`);
    assert.doesNotThrow(() => JSON.parse(machine[0]), `${type} did not parse`);
  }
});

test('the human views hold a line back for nothing but agent output', () => {
  for (const type of RUN_EVENT_TYPES) {
    const quiet = render([SAMPLES[type]], { verbose: false });
    const loud = render([SAMPLES[type]], { verbose: true });
    if (type === 'agent_output') {
      assert.equal(quiet, '', 'agent output was printed without being asked for');
      assert.ok(loud.includes('exolvra-genesis-critic'), 'verbose did not print the agent output');
      assert.ok(loud.includes('VERDICT'), 'verbose lost the text of the report');
    } else {
      assert.equal(quiet, loud, `${type} changed with --verbose`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* The terminal view                                                           */
/* -------------------------------------------------------------------------- */

test('one round is one line, and the columns stack', () => {
  const written = lines(renderTerminal(RUN_SCRIPT));
  const where = layout(2);

  const rounds = written.filter((line) => /^P\d/.test(line));
  assert.equal(rounds.length, SCRIPT_ROUNDS.length, 'a round was not exactly one line');

  rounds.forEach((line, index) => {
    const event = SCRIPT_ROUNDS[index];
    const fields = readRoundLine(line, where);
    assert.equal(fields.piece, event.piece);
    assert.equal(fields.round, String(event.round));
    assert.equal(fields.verdict, VERDICT_TOKENS[event.verdict]);
    assert.ok(/^\d+[hms]/.test(fields.elapsed), `"${fields.elapsed}" is not a duration`);
    assert.equal(line, line.trimEnd(), 'a round line was padded past its last field');
  });

  // The claim in one sentence: every verdict begins in the same column.
  const verdictColumns = new Set(
    rounds.map((line) => columnCells(line).findIndex((cell) => '✓✗▲'.includes(cell))),
  );
  assert.deepEqual([...verdictColumns], [where.verdict]);
});

test('a loss carries its gap, and a win is not given one', () => {
  const written = lines(renderTerminal(RUN_SCRIPT));
  const where = layout(2);

  for (const line of written.filter((text) => /^P\d/.test(text))) {
    const fields = readRoundLine(line, where);
    if (fields.verdict === VERDICT_TOKENS.WIN) {
      assert.equal(fields.gap, '', 'a win was given a gap it never had');
    } else {
      assert.ok(fields.gap.length > 0, `${fields.verdict} lost its gap`);
    }
  }

  // A verdict is a word before it is anything else: the three read apart with
  // no color, no bold, and no terminal at all.
  const tokens = VERDICTS.map((verdict) => VERDICT_TOKENS[verdict]);
  assert.equal(new Set(tokens).size, VERDICTS.length);
  assert.equal(ANSI.test(renderTerminal(RUN_SCRIPT)), false, 'a capture carried an escape');
});

test('the terminal line fits the terminal, down to the width the CLI floors at', () => {
  for (const width of [200, 80, 60, 40, 20, 1]) {
    const laid = Math.max(40, width);
    const written = lines(renderTerminal(RUN_SCRIPT, width)).filter((line) => /^P\d/.test(line));
    assert.equal(written.length, SCRIPT_ROUNDS.length, `a round split at ${width} columns`);
    for (const line of written) {
      assert.ok(
        displayWidth(line) <= laid,
        `at ${width} columns a round ran to ${displayWidth(line)}: "${line}"`,
      );
    }
  }

  // A terminal with room does not cut what a narrow one had to.
  const wide = lines(renderTerminal(RUN_SCRIPT, 200)).filter((line) => /^P\d/.test(line));
  for (const line of wide) {
    assert.equal(line.includes('...'), false, 'a gap was cut on a terminal with room for it');
  }
  const narrow = lines(renderTerminal(RUN_SCRIPT, 40)).filter((line) => /^P\d/.test(line));
  assert.ok(
    narrow.some((line) => line.includes('...')),
    'a gap that could not fit forty columns was not cut',
  );
});

test('color is drawn on a terminal and nowhere else', () => {
  const round = { type: 'round', piece: 'P1', round: 1, verdict: 'LOSS', gap: 'too tight' };

  const captured = renderTerminal([round]);
  assert.equal(ANSI.test(captured), false, 'a file laid out for a terminal was sent color');

  const terminal = render([round], { isTTY: true, columns: 80 });
  const red = ESCAPE + '[31m' + '✗ LOSS' + ESCAPE + '[0m';
  assert.ok(terminal.includes(red), 'a terminal was not sent color');

  // Color cannot cost the layout a column: the two lines are the same line.
  assert.equal(stripAnsi(terminal), captured);

  // Not even when it is the machine view being written to a terminal.
  const machine = render([round], { json: true, isTTY: true, columns: 80 });
  assert.equal(ANSI.test(machine), false, 'the machine view was sent color');
});

test('the run reads as a run: what it was, what it cost, where to resume', () => {
  const written = lines(renderTerminal(RUN_SCRIPT));

  assert.ok(written[0].startsWith('spec     specs/checkout-flow.md'), written[0]);
  assert.ok(written.some((line) => line.startsWith('bar      .exolvra-genesis/bar/ (4 artifacts)')));
  assert.ok(written.some((line) => line.startsWith('plan     3 pieces: P1, P2, P3')));
  assert.ok(written.some((line) => line.startsWith('warning  the spec file changed on disk')));
  assert.ok(written.some((line) => line === 'result   ✓ WIN      9 rounds  $4.8123'));
  assert.ok(
    written.some((line) => line === 'session  018f4c2b-9a3d-4b21-8f0e-2c7a1d5e6b90'),
    'the session to resume from was wrapped or cut',
  );

  // A label keeps its column when its text does not fit one line.
  const notice = RUN_SCRIPT.find((event) => event.type === 'notice');
  const wrapped = lines(renderTerminal([notice]));
  assert.ok(wrapped.length > 1, 'a long notice was not wrapped');
  for (const line of wrapped.slice(1)) {
    assert.ok(line.startsWith(' '.repeat(9)), `"${line}" fell out of its column`);
  }
});

test('a cost too small for four places is reported as too small, not as nothing', () => {
  const cost = (costUsd) => {
    const line = lines(renderTerminal([{ type: 'run_finished', status: 'win', rounds: 1, costUsd }]));
    return line[0].split(/\s{2,}/).at(-1);
  };

  assert.equal(cost(4.8123), '$4.8123');
  assert.equal(cost(0), '$0.0000');
  assert.equal(cost(0.00004), '<$0.0001');
  assert.equal(cost(0.000000001), '<$0.0001');
  assert.equal(cost(0.0001), '$0.0001');

  // And the machine view keeps the number itself, unrounded.
  const record = JSON.parse(
    lines(render([{ type: 'run_finished', status: 'win', rounds: 1, costUsd: 0.00004 }], {
      json: true,
    }))[0],
  );
  assert.equal(record.cost_usd, 0.00004);
});

/* -------------------------------------------------------------------------- */
/* The piped view                                                              */
/* -------------------------------------------------------------------------- */

test('a pipe gets records: tab-delimited, five fields, nothing cut', () => {
  const text = render(RUN_SCRIPT);
  const rows = records(text);

  assert.equal(rows.length, SCRIPT_ROUNDS.length, 'a round was not exactly one record');
  rows.forEach((row, index) => {
    const event = SCRIPT_ROUNDS[index];
    assert.equal(row.length, 5, `record ${index + 1} has ${row.length} fields, not five`);
    assert.equal(row[0], event.piece);
    assert.equal(row[1], String(event.round));
    assert.equal(row[2], event.verdict, 'a piped verdict is the word, not a symbol');
    assert.equal(row[4], event.gap ?? '', 'a piped gap was not handed over whole');
  });

  assert.equal(text.includes('...'), false, 'a record was cut to fit a column that is not there');
  assert.equal(ANSI.test(text), false, 'a pipe was sent color');
  for (const line of lines(text)) {
    assert.equal(hasControl(line, { allowTab: true }), false, `"${line}" carries a control`);
  }
});

test('a pipe gets one record per event, glyph-free and never wrapped', () => {
  const longest =
    '/very/long/absolute/path/that/is/far/wider/than/eighty/columns/on/any/' +
    'terminal/anybody/has/.exolvra-genesis/progress.html';
  const text = render([
    { type: 'run_started', goal: longest, source: 'spec' },
    { type: 'notice', level: 'note', message: longest },
    { type: 'round', piece: 'P1', round: 1, verdict: 'WIN', elapsedMs: 1000 },
    { type: 'run_finished', status: 'win', rounds: 1, costUsd: 0.5, sessionId: 'sesn_x' },
  ]);

  // Every line is one record: nothing was folded onto a continuation line, and
  // nothing carries a hanging indent, so a path arrives in one piece.
  for (const line of lines(text)) {
    assert.ok(line.includes('\t'), `"${line}" is not a record`);
    assert.equal(line.startsWith(' '), false, `"${line}" was wrapped onto a new line`);
  }
  assert.ok(text.includes('spec\t' + longest), 'a long value was not handed over whole');
  assert.ok(text.includes('note\t' + longest), 'a long note was not handed over whole');

  // And no glyph anywhere: a mark in front of a status is a character the
  // reader has to strip before the status can be compared to anything.
  for (const glyph of ['✓', '✗', '▲', '◆', '◇', '│', '└']) {
    assert.equal(text.includes(glyph), false, 'a pipe was sent the glyph ' + glyph);
  }

  const byLabel = new Map(allRecords(text).map((row) => [row[0], row]));
  assert.deepEqual(byLabel.get('result'), ['result', 'WIN', '1', '$0.5000']);
  assert.deepEqual(byLabel.get('session'), ['session', 'sesn_x']);
});

test('a field that would invent a column or split a record cannot', () => {
  const rows = records(
    render([
      {
        type: 'round',
        piece: 'P1\tnot-a-field',
        round: 4,
        verdict: 'LOSS',
        gap: 'a gap\twith a tab\nand a newline in it',
        elapsedMs: 1000,
      },
    ]),
  );

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], [
    'P1 not-a-field',
    '4',
    'LOSS',
    '1s',
    'a gap with a tab and a newline in it',
  ]);
});

test('the piped and terminal views carry the same facts, cut differently', () => {
  const piped = records(render(RUN_SCRIPT));
  const terminal = lines(renderTerminal(RUN_SCRIPT)).filter((line) => /^P\d/.test(line));
  const where = layout(2);

  assert.equal(piped.length, terminal.length);
  piped.forEach((row, index) => {
    const fields = readRoundLine(terminal[index], where);
    assert.equal(fields.piece, row[0]);
    assert.equal(fields.round, row[1]);
    assert.equal(fields.verdict.endsWith(row[2]), true);
    assert.equal(fields.elapsed, row[3]);
    // The only difference: what the column had no room for.
    const shown = fields.gap.endsWith('...') ? fields.gap.slice(0, -3) : fields.gap;
    assert.ok(row[4].startsWith(shown), 'the terminal gap is not the start of the whole gap');
  });
});

/* -------------------------------------------------------------------------- */
/* Verbose: what an agent wrote, as it wrote it                                */
/* -------------------------------------------------------------------------- */

test('verbose streams the agent report, it does not rewrite it', () => {
  const event = RUN_SCRIPT.find((candidate) => candidate.type === 'agent_output');

  // A terminal gets the report under a line saying who wrote it.
  for (const [what, text] of [
    ['terminal at 80', renderTerminal([event], 80, { verbose: true })],
    ['terminal at 40', renderTerminal([event], 40, { verbose: true })],
  ]) {
    const written = lines(text);
    // The heading says who wrote it and about what. It is the one part of the
    // block that wraps, so at a narrow width it runs to more than one line —
    // which is why it is read back whole rather than as its first line.
    const heading = written.length - REPORT_LINES.length;
    assert.ok(heading >= 1, `${what} lost the heading`);
    assert.equal(
      written.slice(0, heading).join(' ').replace(/\s+/g, ' '),
      'output exolvra-genesis-builder on P1 round 2',
      what,
    );
    assert.deepEqual(
      written.slice(heading),
      REPORT_LINES,
      `${what} did not reproduce the report line for line`,
    );
  }

  // A pipe gets the same report, line for line, but as records: a block of
  // prose dropped into a stream of records is a stream nothing can read, so
  // each line is tagged with who wrote it and carries its own record.
  const piped = lines(render([event], { verbose: true }));
  assert.deepEqual(
    piped.map((line) => line.split('\t').slice(2).join('\t')),
    REPORT_LINES,
    'a piped report was not reproduced line for line',
  );
  for (const line of piped) {
    const fields = line.split('\t');
    assert.equal(fields[0], 'output', 'a report line is not an output record: ' + line);
    assert.equal(fields[1], 'exolvra-genesis-builder/P1', 'a record does not say who wrote it');
  }
});

test('nothing in a report is re-wrapped, re-indented, or squeezed', () => {
  const written = lines(renderTerminal([SAMPLES.agent_output], 80, { verbose: true }));
  assert.deepEqual(written.slice(1), ['VERDICT', 'WIN']);

  const body = lines(
    renderTerminal(
      [
        {
          type: 'agent_output',
          agent: 'exolvra-genesis-builder',
          text: [
            '  # pass  399',
            'a  b   c    d',
            `${' '.repeat(40)}deep`,
            '\tone tab',
            `$ ${'x'.repeat(300)}`,
            '',
            'trailing spaces kept   ',
          ].join('\n'),
        },
      ],
      40,
      { verbose: true },
    ),
  ).slice(1);

  assert.equal(body[0], '  # pass  399', 'a run of spaces inside a line was squeezed');
  assert.equal(body[1], 'a  b   c    d', 'an aligned line lost its alignment');
  assert.equal(body[2], `${' '.repeat(40)}deep`, 'an indent was re-derived');
  assert.equal(body[3], '\tone tab', 'a tab was turned into something else');
  assert.equal(body[4], `$ ${'x'.repeat(300)}`, 'a long line was folded for the terminal');
  assert.equal(body[5], '', 'a blank line was dropped');
  assert.equal(body[6], 'trailing spaces kept   ', 'trailing spaces were trimmed');
});

test('a report may not repaint the screen', () => {
  const body = lines(
    render(
      [
        {
          type: 'agent_output',
          agent: 'exolvra-genesis-builder',
          text: [
            'red ' + ESCAPE + '[31mand' + ESCAPE + '[0m back',
            'second line with two trailing spaces  ',
          ].join(CRLF),
        },
      ],
      { verbose: true },
    ),
  ).slice(1);

  assert.deepEqual(body, [
    'output\texolvra-genesis-builder\tsecond line with two trailing spaces  ',
  ]);
  for (const line of body) assert.equal(hasControl(line, { allowTab: true }), false);
});

/* -------------------------------------------------------------------------- */
/* The machine view                                                            */
/* -------------------------------------------------------------------------- */

test('every event is one line of JSON and nothing else is', () => {
  const text = render(RUN_SCRIPT, { json: true });
  const written = lines(text);

  assert.equal(written.length, RUN_SCRIPT.length, 'the stream is not one line per event');
  assert.ok(text.endsWith('\n'), 'the last line was left unterminated');

  written.forEach((line, index) => {
    const record = JSON.parse(line);
    assert.equal(typeof record, 'object');
    assert.notEqual(record, null);
    assert.equal(line.includes('\n'), false);
    if (index < written.length - 1) {
      assert.equal(record.type, RUN_SCRIPT[index].type, `line ${index + 1} is the wrong event`);
    }
  });

  // No human text is mixed in: the file is its lines and their newlines, and
  // every one of those lines is an object.
  assert.equal(written.map((line) => line + '\n').join(''), text);
});

test('the last line is the summary, and is the four keys CI was promised', () => {
  const written = lines(render(RUN_SCRIPT, { json: true }));
  const summary = JSON.parse(written.at(-1));

  assert.deepEqual(Object.keys(summary).sort(), ['cost_usd', 'rounds', 'session_id', 'status']);
  assert.deepEqual(summary, {
    status: 'win',
    rounds: 9,
    cost_usd: 4.8123,
    session_id: '018f4c2b-9a3d-4b21-8f0e-2c7a1d5e6b90',
  });

  for (const status of RUN_STATUSES) {
    const line = lines(
      render([{ type: 'run_finished', status, rounds: 0, costUsd: 0 }], { json: true }),
    )[0];
    const record = JSON.parse(line);
    assert.deepEqual(Object.keys(record).sort(), ['cost_usd', 'rounds', 'session_id', 'status']);
    assert.equal(record.status, status);
    assert.equal(record.session_id, null, 'a session that does not exist was invented');
  }
});

test('the machine view is the same stream whatever the human asked to see', () => {
  assert.equal(
    render(RUN_SCRIPT, { json: true, verbose: true }),
    render(RUN_SCRIPT, { json: true, verbose: false }),
  );
  assert.equal(
    render(RUN_SCRIPT, { json: true, view: { tty: true, width: 200 } }),
    render(RUN_SCRIPT, { json: true }),
  );
});

test('the machine view carries the facts the human views show', () => {
  const written = lines(render(RUN_SCRIPT, { json: true })).map((line) => JSON.parse(line));
  const rounds = written.filter((record) => record.type === 'round');

  assert.equal(rounds.length, SCRIPT_ROUNDS.length);
  rounds.forEach((record, index) => {
    const event = SCRIPT_ROUNDS[index];
    assert.equal(record.piece, event.piece);
    assert.equal(record.round, event.round);
    assert.equal(record.verdict, event.verdict);
    assert.equal(record.gap, event.gap ?? null);
    assert.equal(record.elapsed_ms, event.elapsedMs ?? null);
  });

  const report = written.find((record) => record.type === 'agent_output');
  assert.equal(report.text, BUILDER_REPORT, 'the machine view rewrote a report too');
});

/* -------------------------------------------------------------------------- */
/* Fields nobody promised anything about                                       */
/* -------------------------------------------------------------------------- */

const ZWJ = String.fromCodePoint(0x200d);
const VS16 = String.fromCodePoint(0xfe0f);
const FAMILY = '\u{1f468}' + ZWJ + '\u{1f469}' + ZWJ + '\u{1f467}' + ZWJ + '\u{1f466}';
const FLAG_JP = '\u{1f1ef}\u{1f1f5}';
const ACCENTED = 'e' + String.fromCodePoint(0x301) + 'cole';
const LONE_SURROGATE = String.fromCharCode(0xd83d);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);

const HOSTILE_GAP = [
  'first line' + ESCAPE + '[31m red' + ESCAPE + '[0m',
  '\tsecond\tline with 全角 characters and ' + FAMILY + FLAG_JP + VS16,
  ACCENTED +
    ' ' +
    LONE_SURROGATE +
    LINE_SEPARATOR +
    'and a tail long enough to run past any terminal '.repeat(4),
].join('\n');

const HOSTILE_EVENTS = [
  {
    type: 'plan_ready',
    pieces: [
      { id: 'P1', title: 'ordinary' },
      { id: '全角ピース', title: 'a piece named in ideographs' },
      { id: 'P' + FAMILY, title: 'a piece named with a joined emoji' },
    ],
  },
  { type: 'round', piece: 'P1', round: 1, verdict: 'LOSS', gap: HOSTILE_GAP, elapsedMs: 1000 },
  {
    type: 'round',
    piece: '全角ピース',
    round: 22,
    verdict: 'BLOCKED',
    gap: 'ends in a wide character 全',
    elapsedMs: 45_296_000,
  },
  { type: 'round', piece: 'P' + FAMILY, round: 333, verdict: 'WIN', elapsedMs: 0 },
  {
    type: 'notice',
    level: 'error',
    message: 'a message\nwith a newline\tand a tab and ' + ESCAPE + '[2J a screen clear',
  },
  {
    type: 'run_finished',
    status: 'blocked',
    rounds: 3,
    costUsd: 0.0001,
    sessionId: 'id' + ESCAPE + '[1m',
  },
];

test('a field nobody promised anything about cannot break the terminal view', () => {
  const written = lines(renderTerminal(HOSTILE_EVENTS));

  for (const line of written) {
    assert.equal(hasControl(line), false, `"${line}" carries something a terminal would obey`);
  }

  // Three rounds arrived and three lines were written, however the fields were
  // spelled — the piece column is as wide as the widest piece the plan named,
  // and the rest of the line stacks under it.
  const where = layout(displayWidth('全角ピース'));
  const rounds = written.filter((line) => line.startsWith('P') || line.startsWith('全'));
  assert.equal(rounds.length, 3);

  const fields = rounds.map((line) => readRoundLine(line, where));
  assert.deepEqual(
    fields.map((field) => field.round),
    ['1', '22', '333'],
  );
  assert.deepEqual(
    fields.map((field) => field.verdict),
    [VERDICT_TOKENS.LOSS, VERDICT_TOKENS.BLOCKED, VERDICT_TOKENS.WIN],
  );
  assert.deepEqual(
    fields.map((field) => field.elapsed),
    ['1s', '12h34m', '0s'],
  );
  assert.equal(fields[0].gap.startsWith('first line red second line with 全角'), true);
  for (const line of rounds) assert.ok(displayWidth(line) <= 80, `"${line}" ran past the terminal`);
});

test('a field nobody promised anything about cannot break the machine view', () => {
  const text = render(HOSTILE_EVENTS, { json: true });
  const written = lines(text);

  assert.equal(written.length, HOSTILE_EVENTS.length);
  assert.equal(text.includes(LINE_SEPARATOR), false, 'a line separator was left in a line');

  const parsed = written.map((line) => JSON.parse(line));

  // Faithful, not flattened: what went in comes back out, character for
  // character, escapes and ideographs and unpaired surrogate and all.
  assert.equal(parsed[1].gap, HOSTILE_GAP);
  assert.equal(parsed[1].gap.includes(LINE_SEPARATOR), true);
  assert.equal(parsed[2].piece, '全角ピース');
  assert.equal(parsed[4].message, HOSTILE_EVENTS[4].message);
  assert.equal(parsed.at(-1).session_id, HOSTILE_EVENTS.at(-1).sessionId);
});

test('the piece column is fixed by the plan and never moves under a printed line', () => {
  const events = [
    { type: 'plan_ready', pieces: [{ id: 'P1', title: 'one' }, { id: 'P2', title: 'two' }] },
    { type: 'round', piece: 'P1', round: 1, verdict: 'WIN', elapsedMs: 1000 },
    {
      type: 'round',
      piece: 'a-piece-the-plan-never-mentioned-and-far-too-long-for-any-column',
      round: 2,
      verdict: 'LOSS',
      gap: 'still a gap',
      elapsedMs: 2000,
    },
    { type: 'round', piece: 'P2', round: 3, verdict: 'WIN', elapsedMs: 3000 },
  ];

  const written = lines(renderTerminal(events)).filter((line) => /^[^ ]/.test(line) && !line.startsWith('plan'));
  const where = layout(2);
  assert.equal(written.length, 3);

  const fields = written.map((line) => readRoundLine(line, where));
  assert.deepEqual(
    fields.map((field) => field.piece),
    ['P1', 'a…', 'P2'],
  );
  assert.equal(fields[1].piece.endsWith('…'), true, 'a cut identifier does not say it was cut');

  // Whole in the record, where there is no column to cut it to.
  assert.equal(records(render(events))[1][0], events[2].piece);
});

test('a number is never cut, however absurd it gets', () => {
  const events = [
    { type: 'plan_ready', pieces: [{ id: 'P1', title: 'one' }] },
    {
      type: 'round',
      piece: 'P1',
      round: 1234567,
      verdict: 'LOSS',
      gap: 'a gap',
      elapsedMs: 3_600_000_000_000,
    },
  ];

  const line = lines(renderTerminal(events)).at(-1);
  const fields = line.split(/\s{2,}/);

  assert.equal(fields[0], 'P1');
  assert.equal(fields[1], '1234567', 'a round number was cut into a different number');
  assert.equal(fields[2], '✗ LOSS');
  assert.equal(fields[3], '1000000h0m', 'a duration was cut into a different duration');
  assert.equal(fields[4], 'a gap');
});

test('numbers that are not numbers stay numbers in every view', () => {
  const broken = [
    { type: 'round', piece: 'P1', round: Number.NaN, verdict: 'LOSS', gap: 'x', elapsedMs: -1 },
    {
      type: 'round',
      piece: 'P1',
      round: Number.POSITIVE_INFINITY,
      verdict: 'WIN',
      elapsedMs: Number.NaN,
    },
    {
      type: 'run_finished',
      status: 'stopped',
      rounds: Number.NaN,
      costUsd: Number.POSITIVE_INFINITY,
    },
  ];

  const human = renderTerminal(broken);
  assert.equal(human.includes('NaN'), false, 'NaN reached the terminal');
  assert.equal(human.includes('Infinity'), false, 'Infinity reached the terminal');
  assert.ok(human.includes('result   ▲ STOPPED  0 rounds  $0.0000'), human);

  // `JSON.stringify` writes NaN and Infinity as `null`, which would hand CI a
  // null in a field it was promised a number in.
  const parsed = lines(render(broken, { json: true })).map((line) => JSON.parse(line));
  for (const record of parsed) {
    for (const key of ['round', 'rounds', 'cost_usd']) {
      if (key in record) {
        assert.equal(typeof record[key], 'number', `${key} is not a number`);
        assert.equal(Number.isFinite(record[key]), true, `${key} is not finite`);
      }
    }
  }
  assert.equal(parsed[0].round, 0);
  assert.equal(parsed[0].elapsed_ms, null, 'a duration that was never measured was invented');
  assert.equal(parsed[1].elapsed_ms, null, 'a duration that was never measured was invented');
  assert.deepEqual(parsed.at(-1), {
    status: 'stopped',
    rounds: 0,
    cost_usd: 0,
    session_id: null,
  });
});

test('a field that is null, missing, or not a string is still just a field', () => {
  const events = [
    { type: 'run_started', goal: null, source: null },
    { type: 'bar_captured', path: null, artifacts: null },
    { type: 'plan_ready', pieces: null },
    { type: 'plan_ready', pieces: [null, { id: null, title: null }, 'not an object'] },
    { type: 'round', piece: null, round: null, verdict: null, gap: null, elapsedMs: null },
    { type: 'agent_output', agent: null, piece: null, round: null, text: null },
    { type: 'notice', level: null, message: null },
    { type: 'run_finished', status: null, rounds: null, costUsd: null, sessionId: null },
    {},
    null,
    'not an event at all',
  ];

  for (const view of [{}, { view: { tty: true, width: 80 } }, { json: true }]) {
    assert.doesNotThrow(() => render(events, { ...view, verbose: true }), JSON.stringify(view));
  }

  // The round still arrives, as the record it is, with the fields it has.
  assert.deepEqual(records(render(events, { verbose: true })), [['', '0', '', '', '']]);
  const parsed = lines(render(events, { json: true })).map((line) => JSON.parse(line));
  assert.equal(parsed.length, 8, 'a value that is not an event was reported as one');
  assert.equal(parsed[4].round, 0);
  assert.equal(parsed[4].gap, null);
});

test('the machine view replays back through the human ones', () => {
  const replayed = lines(render(RUN_SCRIPT, { json: true })).map((line) => {
    const record = JSON.parse(line);
    // The summary carries no type: it is the last line by contract, and this is
    // what a consumer reading the stream back has to do with it.
    return record.type === undefined ? { type: 'run_finished', ...record } : record;
  });

  for (const view of [{}, { view: { tty: true, width: 80 } }]) {
    const text = render(replayed, { ...view, verbose: true });
    assert.ok(text.includes('specs/checkout-flow.md'), 'the replay lost the goal');
    assert.ok(text.includes('BLOCKED'), 'the replay lost a verdict');
    assert.ok(text.includes(REPORT_LINES[0]), 'the replay lost the agent report');
  }

  const rows = records(render(replayed));
  assert.equal(rows.length, SCRIPT_ROUNDS.length);
  rows.forEach((row, index) => {
    assert.equal(row[0], SCRIPT_ROUNDS[index].piece);
    assert.equal(row[1], String(SCRIPT_ROUNDS[index].round));
    assert.equal(row[2], SCRIPT_ROUNDS[index].verdict);
    assert.equal(row[4], SCRIPT_ROUNDS[index].gap ?? '');
  });
});

/* -------------------------------------------------------------------------- */
/* A reader that goes away                                                     */
/* -------------------------------------------------------------------------- */

test('a broken pipe ends the reporting, not the run', () => {
  let attempts = 0;
  const broken = new Writable({ write: (_chunk, _encoding, done) => done() });
  broken.write = () => {
    attempts += 1;
    throw new Error('EPIPE: broken pipe, write');
  };

  const reporter = createReporter({ json: false, verbose: false, stream: broken });
  for (const event of RUN_SCRIPT) assert.doesNotThrow(() => reporter.emit(event));
  assert.equal(attempts, 1, 'the reporter kept writing to a sink that had gone');

  const brokenJson = new Writable({ write: (_chunk, _encoding, done) => done() });
  brokenJson.write = () => {
    throw new Error('EPIPE: broken pipe, write');
  };
  const machine = createReporter({ json: true, verbose: false, stream: brokenJson });
  for (const event of RUN_SCRIPT) assert.doesNotThrow(() => machine.emit(event));
});

test('a stream that fails after the fact takes nothing down with it', async () => {
  const failing = new Writable({
    write(_chunk, _encoding, done) {
      done(new Error('EPIPE: broken pipe'));
    },
  });

  const reporter = createReporter({ json: false, verbose: false, stream: failing });
  reporter.emit(RUN_SCRIPT[0]);

  // The stream reports the failure on its own turn. An unheard 'error' event
  // would take the process down here, which is what the reporter's own listener
  // is for; whatever is emitted afterwards is dropped rather than thrown.
  await new Promise((resolve) => setImmediate(resolve));
  for (const event of RUN_SCRIPT) assert.doesNotThrow(() => reporter.emit(event));
});

/* -------------------------------------------------------------------------- */
/* The transcripts                                                             */
/* -------------------------------------------------------------------------- */

/** Runs the script into a real file, through a real stream, and reads it back. */
async function writeTranscript(file, options) {
  const stream = createWriteStream(file);
  await new Promise((resolve, reject) => {
    stream.once('open', resolve);
    stream.once('error', reject);
  });
  const reporter = createReporter({
    json: options.json === true,
    verbose: options.verbose === true,
    stream,
    ...(options.view === undefined ? {} : { view: options.view }),
  });
  for (const event of RUN_SCRIPT) reporter.emit(event);
  await new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });
  return readFileSync(file, 'utf8');
}

test('the transcripts in .evidence are what the reporter wrote', async () => {
  const pipedFile = join(EVIDENCE, 'round-lines.txt');
  const terminalFile = join(EVIDENCE, 'round-lines-tty.txt');
  const verboseFile = join(EVIDENCE, 'round-lines-verbose.txt');
  const machineFile = join(EVIDENCE, 'events.ndjson');

  const piped = await writeTranscript(pipedFile, {});
  const terminal = await writeTranscript(terminalFile, { view: { tty: true, width: 80 } });
  const verbose = await writeTranscript(verboseFile, {
    verbose: true,
    view: { tty: true, width: 80 },
  });
  const machine = await writeTranscript(machineFile, { json: true });

  // Written by running the code, and by nothing else: the bytes in the files are
  // the bytes the reporter produced from the same events in this process.
  assert.equal(piped, render(RUN_SCRIPT));
  assert.equal(terminal, renderTerminal(RUN_SCRIPT));
  assert.equal(verbose, renderTerminal(RUN_SCRIPT, 80, { verbose: true }));
  assert.equal(machine, render(RUN_SCRIPT, { json: true }));

  // The verbose transcript holds the report the way the agent wrote it: the
  // lines are in it consecutively, and each is the line that went in.
  const written = lines(verbose);
  const start = written.indexOf(REPORT_LINES[0]);
  assert.ok(start > 0, 'the verbose transcript has no report in it');
  assert.deepEqual(written.slice(start, start + REPORT_LINES.length), REPORT_LINES);

  for (const [what, text] of [
    ['piped', piped],
    ['terminal', terminal],
  ]) {
    const rounds =
      what === 'piped'
        ? records(text)
        : lines(text)
            .filter((line) => /^P\d/.test(line))
            .map((line) => [line.slice(0, 2)]);
    assert.ok(rounds.length >= 8, `only ${rounds.length} rounds in the ${what} transcript`);
    assert.equal(new Set(rounds.map((row) => row[0])).size, 3, `${what}: not three pieces`);
    for (const verdict of VERDICTS) {
      assert.ok(text.includes(verdict), `no ${verdict} in the ${what} transcript`);
    }
    assert.equal(ANSI.test(text), false, `the ${what} transcript carries an escape sequence`);
  }

  // The piped transcript is the one that hands every field over whole.
  records(piped).forEach((row, index) => {
    assert.equal(row.length, 5);
    assert.equal(row[4], SCRIPT_ROUNDS[index].gap ?? '');
  });

  const parsed = lines(machine).map((line) => JSON.parse(line));
  assert.equal(parsed.length, RUN_SCRIPT.length);
  assert.deepEqual(Object.keys(parsed.at(-1)).sort(), [
    'cost_usd',
    'rounds',
    'session_id',
    'status',
  ]);
});
