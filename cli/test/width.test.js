import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  displayWidth,
  graphemes,
  plainProse,
  plainText,
  printable,
  renderTable,
  truncate,
  wrapText,
} from '../dist/usage.js';

/*
 * The renderer against input nobody promised anything about.
 *
 * Everything a table shows was written by a model. The prompt asks for plain
 * single-line values; a prompt is not a guarantee, so every field here is the
 * kind a prompt does not rule out — a newline, a tab, an escape sequence, an
 * ideograph, an emoji spelled out of six code points, an accent that is its own
 * character, a value longer than the terminal — and the renderer has to lay out
 * a correct table anyway.
 */

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ZWJ = String.fromCodePoint(0x200d);
const VS16 = String.fromCodePoint(0xfe0f);
const FAMILY = '\u{1f468}' + ZWJ + '\u{1f469}' + ZWJ + '\u{1f467}' + ZWJ + '\u{1f466}';
const FLAG_JP = '\u{1f1ef}\u{1f1f5}';
const KEYCAP = '1' + VS16 + String.fromCodePoint(0x20e3);
const HEART = '❤' + VS16;
/** An accent that is its own character, so the first `e` here is two code points. */
const ACCENTED = 'e' + String.fromCodePoint(0x301) + 'cole';
const CONTROL_CHAR = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]');

/* -------------------------------------------------------------------------- */
/* An independent width oracle                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Display columns, written from the Unicode charts rather than from the table
 * the renderer uses, so the two are independent readings of the same fact:
 * East Asian Wide and Fullwidth characters and emoji take two columns,
 * combining marks and joiners take none, and a variation selector asks for the
 * two-column emoji form of the character in front of it.
 *
 * Its scope is the characters this file uses. A sequence joined with ZWJ is
 * one emoji however it is spelled, which no per-character reading can see, so
 * those are asserted directly instead of through here.
 */
function chartColumns(text) {
  let total = 0;
  let previous = 0;
  for (const ch of [...text]) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f) {
      if (previous === 1) {
        total += 1;
        previous = 2;
      }
      continue;
    }
    // Combining marks, enclosing marks and joiners are drawn inside the
    // character in front of them.
    if ((cp >= 0x0300 && cp <= 0x036f) || cp === 0x20e3 || cp === 0x200d || cp === 0x200b) {
      continue;
    }
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x3000 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x30ff) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0x1f300 && cp <= 0x1faff);
    total += wide ? 2 : 1;
    previous = wide ? 2 : 1;
  }
  return total;
}

const SAMPLES = [
  '',
  'plain ascii',
  'docs/参考/設計仕様書.md',
  '全角文字は二列',
  'Ｈｅｌｌｏ',
  '한국어',
  ACCENTED,
  'ab\u{1f680}\u{1f680}\u{1f680}',
  KEYCAP,
  HEART,
  'mixed 設計 and \u{1f680} and ' + ACCENTED,
];

test('display width is measured in columns, not in UTF-16 code units', () => {
  for (const sample of SAMPLES) {
    assert.equal(
      displayWidth(sample),
      chartColumns(sample),
      'disagreed with the chart for ' + JSON.stringify(sample),
    );
  }

  // Where a code-unit count and a column count disagree, the layout follows
  // the column count. An ideograph is one code unit drawn in two columns; an
  // accent that is its own character is a code unit drawn in none; a rocket is
  // two code units that are one character, drawn in two columns.
  assert.equal(displayWidth('設計仕様書'), 10);
  assert.equal('設計仕様書'.length, 5);
  assert.equal(displayWidth(ACCENTED), 5, 'a combining accent is not a column');
  assert.equal(ACCENTED.length, 6);
  assert.equal(displayWidth('\u{1f680}'), 2);
  assert.equal(graphemes('\u{1f680}').length, 1);
  assert.equal('\u{1f680}'.length, 2);
});

test('an emoji joined out of several code points is one character, two columns', () => {
  assert.equal(graphemes(FAMILY).length, 1);
  assert.equal(displayWidth(FAMILY), 2);
  assert.equal(graphemes(FLAG_JP).length, 1);
  assert.equal(displayWidth(FLAG_JP), 2);
  assert.equal(displayWidth(KEYCAP), 2);
  assert.equal(displayWidth(HEART), 2);

  // Three regional indicators are a flag and a stray, not one and a half flags.
  assert.equal(graphemes(FLAG_JP + '\u{1f1e6}').length, 2);
  assert.deepEqual(graphemes('a' + FAMILY + FLAG_JP + ACCENTED.slice(0, 2)), [
    'a',
    FAMILY,
    FLAG_JP,
    ACCENTED.slice(0, 2),
  ]);
});

/** True when the text carries half of a surrogate pair. */
function hasBrokenPair(text) {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

test('truncation lands on a character boundary at every width', () => {
  const subjects = [
    'ab\u{1f680}\u{1f680}\u{1f680}\u{1f680}',
    FAMILY + FAMILY + FAMILY,
    FLAG_JP + FLAG_JP,
    ACCENTED + ' ' + ACCENTED,
    '設計仕様書のレビュー',
    KEYCAP + KEYCAP + KEYCAP,
    'plain ascii that is long enough to cut',
  ];

  for (const subject of subjects) {
    const whole = graphemes(subject);
    for (let width = 0; width <= displayWidth(subject) + 2; width += 1) {
      const cut = truncate(subject, width);
      assert.ok(
        displayWidth(cut) <= Math.max(0, width),
        JSON.stringify(subject) + ' at ' + width + ' produced ' + JSON.stringify(cut),
      );
      assert.ok(!hasBrokenPair(cut), 'a surrogate pair was split at ' + width);
      assert.ok(
        !cut.endsWith(ZWJ),
        'a joined sequence was cut after its joiner at ' + width,
      );
      // Whatever survives is whole characters of the original, in order.
      const kept = graphemes(cut.endsWith('...') ? cut.slice(0, -3) : cut);
      assert.deepEqual(kept, whole.slice(0, kept.length), 'at width ' + width);
    }
    // Anything that fits is left alone.
    assert.equal(truncate(subject, displayWidth(subject)), subject);
  }

  assert.equal(truncate('ab\u{1f680}\u{1f680}\u{1f680}', 7), 'ab\u{1f680}...');
  // A cut at one column keeps the accent with the letter it belongs to.
  assert.equal(truncate(ACCENTED, 1), ACCENTED.slice(0, 2));
});

test('printable strips what a terminal would obey rather than draw', () => {
  assert.equal(printable('a' + ESC + '[31mred' + ESC + '[0m'), 'ared');
  assert.equal(printable(ESC + ']0;window title' + BEL + 'after'), 'after');
  assert.equal(printable(ESC + '[2J' + ESC + '[H'), '');
  assert.equal(printable('x' + ESC + '(By'), 'xy');
  assert.equal(printable('one\ntwo'), 'one two');
  assert.equal(printable('one\ttwo'), 'one two');
  assert.equal(printable('one\r\ntwo'), 'one  two');
  assert.equal(printable('bell' + BEL + 'rung'), 'bell rung');
  assert.equal(printable('lone\ud83dsurrogate'), 'lonesurrogate');
  assert.equal(
    printable('line' + String.fromCodePoint(0x2028) + 'separator'),
    'line separator',
  );
  // What a terminal does draw is left exactly as it was.
  assert.equal(printable('設計 ' + FAMILY + ' ' + ACCENTED), '設計 ' + FAMILY + ' ' + ACCENTED);
  // A field is flattened and left otherwise alone; reading a value as
  // markdown happens where prose is rendered, and only there.
  assert.equal(plainText('**bold**\nacross\tlines'), '**bold** across lines');
  assert.equal(plainProse('**bold**\nacross\tlines'), 'bold across lines');
  assert.equal(plainText(ESC + '[31m`code`' + ESC + '[0m'), '`code`');
  assert.equal(plainProse(ESC + '[31m`code`' + ESC + '[0m'), 'code');
});

/* -------------------------------------------------------------------------- */
/* Tables                                                                      */
/* -------------------------------------------------------------------------- */

const HOSTILE_ROWS = [
  ['p2', 'first line\nsecond line', 'src/a.ts', 'npm run build'],
  ['p3', '設計仕様書のレビュー', 'docs/参考/設計.ts', 'npm test'],
  ['p4', 'ab\u{1f680}\u{1f680}\u{1f680} ' + FAMILY + ' ' + FLAG_JP, 'src/b.ts', 'npm test'],
  ['p5', 'tabs\there and a CR\rthere', '', ESC + '[31mnpm test' + ESC + '[0m'],
  [
    'p6',
    ACCENTED + ' with zero' + String.fromCodePoint(0x200b) + 'width',
    'y'.repeat(120),
    'z'.repeat(90),
  ],
];
const HOSTILE_HEADERS = ['id', 'title', 'files', 'verify'];

test('a newline in a field never splits a record', () => {
  const piped = renderTable(HOSTILE_HEADERS, HOSTILE_ROWS, { tty: false, width: 80 });
  assert.equal(piped.length, HOSTILE_ROWS.length, 'a record became more than one line');
  for (const row of piped) {
    assert.equal(row.split('\t').length, HOSTILE_HEADERS.length, JSON.stringify(row));
    assert.ok(!/[\r\n]/.test(row), 'a line break survived into a record');
  }
  // The reported repro: `cut -f1` reads the id of every record, and nothing else.
  assert.deepEqual(
    piped.map((row) => row.split('\t')[0]),
    ['p2', 'p3', 'p4', 'p5', 'p6'],
  );
  assert.equal(piped[0].split('\t')[1], 'first line second line');

  for (const width of [40, 80, 100]) {
    const aligned = renderTable(HOSTILE_HEADERS, HOSTILE_ROWS, { tty: true, width });
    assert.equal(aligned.length, HOSTILE_ROWS.length + 1, 'a row split at width ' + width);
  }
});

/**
 * Where each field of a laid-out row starts, in display columns.
 *
 * Cells never contain two spaces in a row — every field is flattened before it
 * is measured — so a run of two or more spaces is a gutter and nothing else.
 */
function fieldStarts(line) {
  const starts = [];
  let column = 0;
  let spaces = 0;
  for (const cluster of graphemes(line)) {
    if (cluster === ' ') {
      spaces += 1;
      column += 1;
      continue;
    }
    if (column === 0 || spaces >= 2) starts.push(column);
    spaces = 0;
    column += chartColumns(cluster) === 0 ? displayWidth(cluster) : chartColumns(cluster);
  }
  return starts;
}

test('cells are measured in display columns, so every column lines up', () => {
  // Only characters the oracle can read on its own, so the offsets below are
  // arithmetic done independently of the renderer.
  const rows = [
    ['p1', 'docs/参考/設計仕様書.md', 'ok'],
    ['p2', 'plain ascii detail', 'ok'],
    ['p3', 'ab\u{1f680}\u{1f680}\u{1f680}', 'ok'],
    ['p4', ACCENTED, 'ok'],
    ['p5', 'Ｈｅｌｌｏ fullwidth', 'ok'],
  ];

  for (const width of [40, 60, 80, 100, 120]) {
    const lines = renderTable(['id', 'detail', 'state'], rows, { tty: true, width });
    const header = fieldStarts(lines[0]);
    assert.equal(header.length, 3, 'the header lost a column at ' + width);
    for (const line of lines) {
      assert.ok(
        chartColumns(line) <= width,
        'ran past ' + width + ' columns: ' + JSON.stringify(line),
      );
      for (const start of fieldStarts(line)) {
        assert.ok(
          header.includes(start),
          'column ' + start + ' is ragged at width ' + width + ': ' + JSON.stringify(line),
        );
      }
    }
    // The last column really is reached, on the CJK row as on the ASCII one.
    const last = header[header.length - 1];
    assert.ok(fieldStarts(lines[1]).includes(last), 'the CJK row lost its last column');
    assert.ok(fieldStarts(lines[2]).includes(last), 'the ASCII row lost its last column');
  }
});

test('no row of a hostile table runs past the terminal width', () => {
  for (const width of [40, 56, 72, 80, 100, 132]) {
    for (const line of renderTable(HOSTILE_HEADERS, HOSTILE_ROWS, { tty: true, width })) {
      assert.ok(
        displayWidth(line) <= width,
        'ran past ' + width + ' columns: ' + JSON.stringify(line),
      );
      assert.ok(!hasBrokenPair(line), 'a surrogate pair was split at width ' + width);
      assert.ok(!CONTROL_CHAR.test(line), 'a control character survived');
    }
  }
});

test('short columns keep their width and the long one absorbs the shortfall', () => {
  // What `gh run list` does: the id, the state and the duration stay whole and
  // the title takes the cut, rather than every column being truncated to noise.
  const rows = [
    ['12345', 'a title far longer than the terminal is anywhere near wide enough for', 'ok', '3m20s'],
    ['12346', 'another title of similar length that also cannot possibly fit here', 'ok', '9s'],
  ];
  const lines = renderTable(['id', 'title', 'state', 'took'], rows, {
    tty: true,
    width: 80,
  });

  for (const line of lines) assert.ok(displayWidth(line) <= 80, JSON.stringify(line));
  for (const line of lines.slice(1)) {
    const fields = line.split(/ {2,}/);
    assert.equal(fields.length, 4, 'a column was lost: ' + JSON.stringify(line));
    assert.ok(!fields[0].includes('...'), 'the id was truncated: ' + JSON.stringify(line));
    assert.ok(!fields[2].includes('...'), 'the state was truncated: ' + JSON.stringify(line));
    assert.ok(!fields[3].includes('...'), 'the duration was truncated: ' + JSON.stringify(line));
    assert.ok(fields[1].endsWith('...'), 'the elastic column was not the one cut');
    // The title keeps everything the other columns did not need.
    assert.ok(
      displayWidth(fields[1]) >= 50,
      'the elastic column was starved: ' + JSON.stringify(fields[1]),
    );
  }
});

test('a table survives an empty field, a field of only markup, and a huge field', () => {
  const rows = [
    ['', 'an empty id', 'ok'],
    ['p2', '', 'ok'],
    ['p3', '**', 'ok'],
    ['p4', 'q'.repeat(400), 'ok'],
  ];
  const piped = renderTable(['id', 'title', 'state'], rows, { tty: false, width: 80 });
  assert.equal(piped.length, 4);
  for (const row of piped) assert.equal(row.split('\t').length, 3);
  assert.equal(piped[0], '\tan empty id\tok');

  for (const width of [40, 80]) {
    const aligned = renderTable(['id', 'title', 'state'], rows, { tty: true, width });
    assert.equal(aligned.length, 5);
    for (const line of aligned) assert.ok(displayWidth(line) <= width, JSON.stringify(line));
  }
});

test('prose wraps to the width whatever alphabet it is written in', () => {
  const subjects = [
    '端末幅を超える長い日本語の文章は空白で区切られていないので折り返しの対象になります。'.repeat(3),
    'https://example.com/' + 'segment/'.repeat(30),
    'ordinary prose that wraps on its spaces the way it always did, at any width',
    ACCENTED.repeat(40),
    ('ab\u{1f680}').repeat(50),
  ];

  for (const width of [40, 60, 80]) {
    for (const subject of subjects) {
      for (const line of wrapText(subject, width, 2)) {
        assert.ok(
          displayWidth(line) <= width,
          'ran past ' + width + ': ' + JSON.stringify(line),
        );
        assert.ok(!hasBrokenPair(line), 'a surrogate pair was split while wrapping');
      }
    }
  }

  // Breaking a word only happens to a word that cannot fit any line; ordinary
  // prose still comes back with all of its words intact.
  const prose = 'the quick brown fox jumps over the lazy dog and keeps on running';
  assert.equal(wrapText(prose, 40, 2).join(' ').replace(/\s+/g, ' ').trim(), prose);
});
