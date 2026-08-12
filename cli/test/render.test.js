import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  dropUnactionable,
  readPlan,
  renderPlan,
  withoutPlanBlocks,
} from '../dist/commands/plan.js';
import {
  plainProse,
  plainText,
  renderMarkdown,
  renderTable,
  startProgress,
  wrapText,
} from '../dist/usage.js';
import { PACKAGE_ROOT } from './run-cli.js';

/*
 * The rendering layer, driven over answers captured from real agent runs.
 *
 * `test/fixtures/*.md` are verbatim transcripts of what `exolvra-genesis plan` printed
 * before there was a renderer: chat markdown piped straight to the terminal.
 * Nothing here is hand-written to be easy to render.
 */

const FIXTURES = join(PACKAGE_ROOT, 'test', 'fixtures');
const CAPTURED = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.md'))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(FIXTURES, name), 'utf8') }));

const PIPE = { tty: false, width: 80 };
const TTY = { tty: true, width: 80 };

/** Markup that means something in a chat window and nothing in a terminal. */
const SYNTAX = [
  { label: 'bold markers', pattern: /\*\*/ },
  // A heading marker is `#` and exactly one space. A `#` column header in a
  // table is content, and the column gutter is never one space wide.
  { label: 'an ATX heading', pattern: /(^|\n)[ \t]*#{1,6} [^ ]/ },
  { label: 'a pipe-table separator row', pattern: /(^|\n)\s*\|?\s*:?-{2,}:?\s*\|/ },
  { label: 'a horizontal rule', pattern: /(^|\n)\s*(-{3,}|\*{3,}|_{3,})\s*(\n|$)/ },
  { label: 'a table pipe', pattern: /\S\s*\|\s*\S/ },
  { label: 'a fence', pattern: /```/ },
];

function assertNoSyntax(rendered, where) {
  for (const { label, pattern } of SYNTAX) {
    assert.ok(
      !pattern.test(rendered),
      where + ' leaked ' + label + ' to the terminal:\n' + rendered,
    );
  }
}

test('there are captured agent answers to render', () => {
  assert.ok(CAPTURED.length >= 2, 'expected captured transcripts to render');
  for (const { name, text } of CAPTURED) {
    assert.ok(text.includes('**'), name + ' is not chat markdown');
    assert.ok(/\n\|/.test(text), name + ' carries no pipe table to render');
  }
});

for (const { name, text } of CAPTURED) {
  test('no chat markdown survives rendering of ' + name, () => {
    for (const view of [PIPE, TTY]) {
      const rendered = renderMarkdown(text, view, 2).join('\n');
      assertNoSyntax(rendered, name + (view.tty ? ' (terminal)' : ' (pipe)'));
      assert.ok(rendered.length > 0, name + ' rendered to nothing');
    }
  });

  test('rendering ' + name + ' keeps the words it carried', () => {
    // Content, stripped of its markup, is still content — between the two
    // forms nothing is lost. A terminal keeps the column headers and truncates
    // over-wide cells; a pipe drops the headers and keeps every cell whole.
    // Headings are laid out in the case the help pages use, so the comparison
    // is case-insensitive.
    const rendered = [
      ...renderMarkdown(text, PIPE, 0),
      ...renderMarkdown(text, TTY, 0),
    ]
      .join('\n')
      .toLowerCase();
    const words = plainText(text.replace(/\|/g, ' '))
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => /^[a-z]{6,}$/.test(word));
    assert.ok(words.length > 20, 'expected prose to check');
    for (const word of new Set(words)) {
      assert.ok(rendered.includes(word), name + ' dropped the word "' + word + '"');
    }
  });

  test('every rendered line of ' + name + ' fits the width it was given', () => {
    // Table rows are truncated to fit; prose is wrapped to fit. Neither runs
    // past the column the layout was asked for.
    for (const line of renderMarkdown(text, TTY, 2)) {
      assert.ok(line.length <= 80, 'line past 80 columns: ' + JSON.stringify(line));
    }
  });

  test('rendering ' + name + ' is deterministic', () => {
    assert.deepEqual(renderMarkdown(text, TTY, 2), renderMarkdown(text, TTY, 2));
  });
}

test('a pipe table becomes aligned columns for a terminal', () => {
  const [first] = CAPTURED;
  const rendered = renderMarkdown(first.text, TTY, 0);
  // At the body indent, the same column the prose and the list items under a
  // heading start at — a table at the heading's own indent reads as another
  // heading rather than as what this one introduces.
  const start = rendered.findIndex((line) => /^ {2}#\s+TASK\b/.test(line));
  assert.ok(start >= 0, 'the captured table produced no header row:\n' + rendered.join('\n'));

  const rows = [];
  for (let i = start; i < rendered.length && rendered[i] !== ''; i += 1) {
    rows.push(rendered[i]);
  }
  assert.ok(rows.length > 3, 'expected the captured table rows');

  // Every cell of the second column starts where the TASK header starts, and
  // the gutter in front of it is blank on every row.
  const column = rows[0].indexOf('TASK');
  assert.ok(column > 0);
  for (const row of rows) {
    assert.equal(row[column - 1], ' ', 'a cell ran into the gutter: ' + JSON.stringify(row));
    assert.notEqual(row[column], ' ', 'ragged second column: ' + JSON.stringify(row));
  }
});

test('a table inside prose keeps its header and its indent under a pipe', () => {
  // The reported defect: redirected, a table embedded in an agent's prose lost
  // its header row and printed tab-delimited at column zero, in the middle of
  // paragraphs still indented under their heading — half a page for a person,
  // half a feed for a script, and no column names left on either half. The
  // machine-readable form belongs to the sections this CLI composes itself,
  // where the columns are fixed and a caller asked for records.
  const [first] = CAPTURED;
  const piped = renderMarkdown(first.text, PIPE, 0);
  const start = piped.findIndex((line) => /^ {2}#\s+TASK\b/.test(line));
  assert.ok(start >= 0, 'the header row is gone when redirected:\n' + piped.join('\n'));

  const rows = [];
  for (let i = start; i < piped.length && piped[i] !== ''; i += 1) rows.push(piped[i]);
  assert.ok(rows.length > 3, 'expected the captured table rows');
  for (const row of rows) {
    assert.ok(!row.includes('\t'), 'prose became a data feed: ' + JSON.stringify(row));
    assert.match(row, /^ {2}\S/, 'a row sat outside its section: ' + JSON.stringify(row));
  }

  // Same columns as a terminal gets, and no cell cut: the budget a terminal
  // imposes is its right edge, and a file has none.
  const shown = renderMarkdown(first.text, TTY, 0);
  const ttyStart = shown.findIndex((line) => /^ {2}#\s+TASK\b/.test(line));
  assert.deepEqual(
    piped[start].trim().split(/\s{2,}/),
    shown[ttyStart].trim().split(/\s{2,}/),
    'the two forms disagree about the columns',
  );
  assert.ok(
    rows.every((row) => !row.includes('...')),
    'a redirected table truncated a cell: ' + rows.join('\n'),
  );
});

test('two captured answers that named their sections differently render alike', () => {
  // The defect this replaces: one run called it "Preview Summary", the next
  // called the same thing "Summary for Approval". Under the payload the frame
  // is the CLI's, so the section names cannot drift.
  const [a, b] = CAPTURED;
  assert.notEqual(a.text, b.text);
  const headingsOf = (payload) =>
    renderPlan(payload, { kind: 'goal', goal: 'a goal' }, TTY)
      .split('\n')
      // A section heading, not a table header row: single spaces, column 0.
      .filter((line) => /^[A-Z]+( [A-Z]+)*$/.test(line));

  const first = headingsOf({
    bar: 'one thing',
    comparison: 'one way',
    artifacts: [{ path: 'a.txt', detail: 'x' }],
    specs: [{ id: 'P1', title: 't', covers: '', files: 'f', verify: 'v' }],
  });
  const second = headingsOf({
    bar: 'a different thing entirely',
    comparison: 'a different way',
    artifacts: [{ path: 'b.png', detail: 'y' }],
    specs: [{ id: 'Q9', title: 'u', covers: '', files: 'g', verify: 'w' }],
  });
  assert.deepEqual(first, second);
  assert.deepEqual(first, ['GOAL', 'BAR', 'COMPARISON', 'BAR ARTIFACTS', 'TASK SPECS']);
});

test('the frame renders content the agent wrote as markdown as plain text', () => {
  const rendered = renderPlan(
    {
      bar: '**Linear.app**\'s dark-mode `settings` page — see [spec](https://linear.app)',
      comparison: 'Renders at 1920x1080 and scores *seven* categories',
      artifacts: [{ path: '`bar/shot.png`', detail: '**1920x1080** capture' }],
      specs: [
        {
          id: '**01**',
          title: 'Foundation & `tokens`',
          covers: '',
          files: '`index.html`, `styles/tokens.css`',
          verify: '`npm test`',
        },
      ],
    },
    { kind: 'goal', goal: 'a goal' },
    TTY,
  );
  assertNoSyntax(rendered, 'the frame');
  assert.ok(rendered.includes('Linear.app'));
  assert.ok(rendered.includes('spec (https://linear.app)'));
  assert.ok(rendered.includes('index.html, styles/tokens.css'));
});

test('the covers column is there whether or not a spec supplies one', () => {
  // A record whose field count depends on its content cannot be parsed. The
  // column stays; the cell is empty.
  const spec = (covers) => ({
    bar: 'b',
    comparison: 'c',
    artifacts: [],
    specs: [{ id: 'P1', title: 't', covers, files: 'f', verify: 'v' }],
  });
  const input = { kind: 'goal', goal: 'g' };
  assert.ok(renderPlan(spec('R1, R2'), input, TTY).includes('COVERS'));
  assert.ok(renderPlan(spec(''), input, TTY).includes('COVERS'));

  const row = renderPlan(spec(''), input, PIPE)
    .split('\n')
    .find((line) => line.startsWith('P1\t'));
  assert.equal(row.split('\t').length, 5, 'a piped record lost a field: ' + row);
  assert.equal(row.split('\t')[2], '', 'the empty field is still the third one');
});

test('a spec run names the spec the way the user typed it, under SPEC', () => {
  const rendered = renderPlan(
    { bar: 'b', comparison: 'c', artifacts: [], specs: [] },
    {
      kind: 'spec',
      path: '/tmp/specs/checkout.md',
      given: 'specs/checkout.md',
      text: '# Spec',
    },
    TTY,
  );
  // Labelled for what it is, the way a run labels the same input.
  assert.match(rendered, /SPEC\n {2}specs\/checkout\.md\n/);
  assert.ok(
    !rendered.includes('/tmp/specs/checkout.md'),
    'a resolved path the user never typed was echoed back',
  );
});

const SPEC = { id: 'P1', title: 't', covers: 'R1', files: 'f', verify: 'v' };

function block(payload, tag = 'exolvra-genesis-plan') {
  return ['```' + tag, JSON.stringify(payload), '```'].join('\n');
}

test('readPlan reads the fenced block and ignores the prose around it', () => {
  const answer = [
    'Here is the plan.',
    '',
    block({
      bar: 'the bar',
      comparison: 'the comparison',
      artifacts: [{ path: 'p', detail: 'd' }],
      specs: [SPEC],
    }),
  ].join('\n');

  const reading = readPlan(answer);
  assert.ok(reading.ok, 'a well-formed answer must read as a plan');
  assert.equal(reading.payload.bar, 'the bar');
  assert.equal(reading.payload.specs.length, 1);
  assert.equal(reading.payload.specs[0].covers, 'R1');
  assert.equal(reading.rest, 'Here is the plan.');
  assert.equal(withoutPlanBlocks(answer), 'Here is the plan.');
  assert.deepEqual(reading.repairs, [], 'nothing had to be repaired');
});

test('the last plan wins, so a shown-then-filled shape still renders', () => {
  const answer = [
    block({ bar: 'the shape', specs: [SPEC] }),
    'and now the real one',
    block({ bar: 'the answer', specs: [SPEC] }),
  ].join('\n');
  const reading = readPlan(answer);
  assert.ok(reading.ok);
  assert.equal(reading.payload.bar, 'the answer');
});

test('a correctly tagged block beats one that only looks like a plan', () => {
  const answer = [
    block({ bar: 'the example', specs: [SPEC] }, 'json'),
    block({ bar: 'the plan', specs: [SPEC] }),
  ].join('\n');
  const reading = readPlan(answer);
  assert.ok(reading.ok);
  assert.equal(reading.payload.bar, 'the plan');
  assert.deepEqual(reading.repairs, []);
});

test('an answer with no plan, or a broken one, says which', () => {
  const codeOf = (text) => {
    const reading = readPlan(text);
    assert.equal(reading.ok, false, JSON.stringify(text) + ' read as a plan');
    assert.ok(reading.fault.message.length > 0, 'a fault with no message');
    return reading.fault.code;
  };
  assert.equal(codeOf(''), 'no-answer');
  assert.equal(codeOf('just prose'), 'no-plan');
  assert.equal(codeOf('```exolvra-genesis-plan\nnot json\n```'), 'unreadable');
  assert.equal(codeOf('```exolvra-genesis-plan\n[1,2,3]\n```'), 'not-an-object');
  assert.equal(codeOf('```exolvra-genesis-plan\n{"bar":"b","specs":[]}\n```'), 'no-specs');
  assert.equal(codeOf('```exolvra-genesis-plan\n{"bar":"b","specs":"P1"}\n```'), 'wrong-type');
  assert.equal(codeOf('```exolvra-genesis-plan\n{"bar":"only the bar"}\n```'), 'no-specs');
  assert.equal(codeOf('```exolvra-genesis-plan\n{"specs":[{"id":"P1"}]}\n```'), 'missing-fields');
  for (const { name, text } of CAPTURED) {
    assert.equal(codeOf(text), 'no-plan', name + ' read as a plan');
  }
});

test('what a fault says is what was wrong, not a code handed to the user', () => {
  const reading = readPlan('```exolvra-genesis-plan\n{"bar":"b","specs":[{"id":"P1","title":"t"}]}\n```');
  assert.equal(reading.ok, false);
  assert.match(reading.fault.message, /^the preview produced no plan: /);
  assert.ok(
    reading.fault.detail.some((line) => line.includes('specs[0].files')),
    'the missing fields are not named: ' + reading.fault.detail.join(' / '),
  );
  for (const line of [reading.fault.message, ...reading.fault.detail]) {
    assert.ok(!line.includes(reading.fault.code), 'the fault code leaked to the user');
  }
});

test('a payload missing fields renders the sections it can and drops the rest', () => {
  // renderPlan lays out whatever it is given; whether a payload is complete
  // enough to be a plan is readPlan's judgment, made before this is reached.
  const rendered = renderPlan(
    { bar: 'only the bar', comparison: '', artifacts: [], specs: [] },
    { kind: 'goal', goal: 'g' },
    TTY,
  );
  assert.match(rendered, /BAR\n {2}only the bar\n/);
  assert.ok(!rendered.includes('TASK SPECS'), 'an empty table still printed a heading');
});

test('a value that is a list is joined rather than printed as [object Object]', () => {
  const reading = readPlan(
    block({ bar: 'b', specs: [{ id: 'P1', title: 't', files: ['a.ts', 'b.ts'], verify: 'v' }] }),
  );
  assert.ok(reading.ok, 'a list of files is still a list of files');
  assert.equal(reading.payload.specs[0].files, 'a.ts, b.ts');
  const rendered = renderPlan(reading.payload, { kind: 'goal', goal: 'g' }, PIPE);
  assert.ok(!rendered.includes('[object'), 'a structured value leaked its type');
});

test('an instruction to reply is dropped, because the preview has already ended', () => {
  for (const { name, text } of CAPTURED) {
    assert.match(text, /Reply \*\*"go"\*\*/, name + ' carried no closing invitation');
    const kept = dropUnactionable(text);
    assert.ok(!/Reply\s+\*?\*?"go"/.test(kept), name + ' kept an instruction to reply');
    // Only the closing invitation goes; the preview itself stays.
    assert.ok(kept.includes('Bar'), name + ' lost its content');
    assert.ok(kept.length > text.length - 60, name + ' dropped more than the invitation');
  }
});

test('dropUnactionable leaves content that only looks like an instruction', () => {
  const prose = 'Reply latency is the bar: the settings page answers in under 80ms, measured over 50 runs, and that is what a critic checks first.';
  assert.equal(dropUnactionable(prose), prose);
  assert.equal(dropUnactionable('The plan is above.'), 'The plan is above.');
  assert.equal(dropUnactionable('Body here.\n\nReply "go" to start.'), 'Body here.');
});

/* -------------------------------------------------------------------------- */
/* Layout primitives                                                           */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* The progress line                                                           */
/* -------------------------------------------------------------------------- */

/** A stream that keeps what was written to it. */
function collector() {
  const chunks = [];
  return {
    write: (chunk) => {
      chunks.push(String(chunk));
      return true;
    },
    text: () => chunks.join(''),
  };
}

test('a disabled progress line writes nothing at all, ever', () => {
  const out = collector();
  const progress = startProgress(out, 'working', false);
  progress.update('still working');
  progress.clear();
  progress.done('finished');
  progress.fail('did not finish');
  assert.equal(out.text(), '', 'a pipe was written to: ' + JSON.stringify(out.text()));
});

test('an enabled progress line redraws in place and closes on one line', () => {
  const ESC = String.fromCharCode(0x1b);
  const out = collector();
  const progress = startProgress(out, 'Previewing the plan', true);
  progress.update('Previewing the plan · 3 messages');
  progress.done('Plan ready');

  const text = out.text();
  assert.ok(text.startsWith(ESC + '[?25l'), 'the cursor was left visible over a redraw');
  assert.ok(text.includes('\r' + ESC + '[2K'), 'frames were appended rather than redrawn');
  assert.match(text, /[◒◐◓◑] {2}Previewing the plan/);
  assert.ok(text.includes('3 messages'), 'the message never changed');
  assert.match(text, /\x1B\[2KPlan ready\n/);
  assert.ok(text.endsWith(ESC + '[?25h'), 'the cursor was left hidden');
  // One line: everything before the close is redrawn over itself.
  assert.equal(text.split('\n').length, 2, JSON.stringify(text));
});

test('a progress line that failed says so, and closes only once', () => {
  const out = collector();
  const progress = startProgress(out, 'working', true);
  progress.fail('No plan');
  progress.done('Plan ready');
  progress.update('still working');
  const text = out.text();
  assert.match(text, /\x1B\[2KNo plan\n/);
  assert.ok(!text.includes('Plan ready'), 'a closed line was written to again');
  assert.ok(!text.includes('still working'), 'a closed line was written to again');
});

test('a progress message cannot drive the terminal itself', () => {
  const ESC = String.fromCharCode(0x1b);
  const out = collector();
  const progress = startProgress(out, 'working', true);
  progress.update(ESC + '[2J' + ESC + '[H wiped the screen');
  progress.done('done\nand a second line');
  const text = out.text();
  assert.ok(!text.includes('[2J'), 'an escape sequence went through the progress line');
  assert.equal(text.split('\n').length, 2, 'a message split the line in two');
});

test('plainProse strips markup and keeps the content', () => {
  assert.equal(plainProse('**bold** and *italic* and `code`'), 'bold and italic and code');
  assert.equal(plainProse('~~gone~~ and __also__'), 'gone and also');
  assert.equal(plainProse('[gh](https://cli.github.com)'), 'gh (https://cli.github.com)');
  assert.equal(plainProse('[a file](./notes.md)'), 'a file');
  assert.equal(plainProse('![shot](a.png)'), 'shot');
  assert.equal(plainProse('a \\* literal star'), 'a * literal star');
  assert.equal(plainProse('  spaced   out  '), 'spaced out');
  // An identifier is not emphasis, and neither is a glob: a marker glued to
  // the middle of a word is part of the word.
  assert.equal(plainProse('some_file_name.ts'), 'some_file_name.ts');
  assert.equal(plainProse('cli/src/**, cli/test/**'), 'cli/src/**, cli/test/**');
  assert.equal(plainProse('a**b'), 'a**b');
  assert.equal(plainProse('2 * 3 * 4'), '2 * 3 * 4');
  // Real emphasis, in the places it really appears.
  assert.equal(plainProse('Reply **"go"** to begin'), 'Reply "go" to begin');
  assert.equal(plainProse('(**Hard Gates**)'), '(Hard Gates)');
  assert.equal(plainProse('**Linear.app**’s page'), 'Linear.app’s page');
});

test('plainText flattens a field and changes nothing else about it', () => {
  // The whole contract: one printable line, and the same characters. A field is
  // data, and a renderer that reads data as markdown prints something the user
  // never stored — most often to the values they are about to copy.
  for (const value of [
    'C:\\dir\\.hidden\\file.txt',
    'C:\\Users\\w30\\target\\.exolvra-genesis\\progress.html',
    '/home/a/*star*/notes.md',
    'a \\* literal star',
    'cli/src/**, cli/test/**',
    '**bold** and `code` and [gh](https://cli.github.com)',
    'grep -q \'"status": *"running"\' .exolvra-genesis/state.json',
    'cd cli && npm test -- --grep "a\\.b"',
    '~~not~~ struck through',
    'a_b_c ***everything*** {braces} (parens) #hash +plus -dash !bang |pipe >gt',
  ]) {
    assert.equal(plainText(value), value, 'plainText rewrote a field: ' + value);
  }

  // What it does do: one line, and nothing a terminal would obey.
  assert.equal(plainText('two\nlines\there'), 'two lines here');
  assert.equal(plainText('  spaced   out  '), 'spaced out');
  assert.equal(plainText('bell and escape[31m'), 'bell and escape');
});

test('wrapText breaks on spaces and never past the width', () => {
  const text = 'the quick brown fox jumps over the lazy dog and keeps on running';
  for (const width of [20, 32, 40, 79]) {
    const lines = wrapText(text, width, 2);
    for (const line of lines) {
      assert.ok(line.length <= width, width + ': ' + JSON.stringify(line));
      assert.match(line, /^ {2}\S/);
    }
    assert.equal(lines.join(' ').replace(/\s+/g, ' ').trim(), text);
  }
});

test('renderTable aligns for a terminal and tab-delimits for a pipe', () => {
  const rows = [
    ['P1', 'foundation', 'cd cli && npm test'],
    ['P10', 'a much longer title than the first', 'npm run build'],
  ];
  const aligned = renderTable(['id', 'title', 'verify'], rows, TTY);
  assert.equal(aligned[0], 'ID   TITLE                               VERIFY');
  // The widest id is three characters, so every second column starts at 5.
  for (const line of aligned) {
    assert.equal(line[4], ' ', 'a row ran into the gutter: ' + JSON.stringify(line));
    assert.notEqual(line[5], ' ', 'ragged second column: ' + JSON.stringify(line));
  }
  const third = aligned.map((line) => line.indexOf(line.slice(5).trimStart().slice(0, 1), 5));
  assert.equal(new Set(third).size, 1, 'ragged column starts: ' + aligned.join('\n'));

  const piped = renderTable(['id', 'title', 'verify'], rows, PIPE);
  assert.deepEqual(piped, [
    'P1\tfoundation\tcd cli && npm test',
    'P10\ta much longer title than the first\tnpm run build',
  ]);
});

test('renderTable truncates rather than overflowing a narrow terminal', () => {
  const rows = [['P1', 'a title far longer than the terminal is wide', 'x'.repeat(60)]];
  for (const width of [40, 60, 80]) {
    for (const line of renderTable(['id', 'title', 'verify'], rows, { tty: true, width })) {
      assert.ok(line.length <= width, width + ': ' + JSON.stringify(line));
    }
  }
  assert.ok(
    renderTable(['id', 'title'], rows, { tty: true, width: 40 })[1].includes('...'),
    'a truncated cell must say it was truncated',
  );
});

test('an empty table renders nothing at all', () => {
  assert.deepEqual(renderTable(['id'], [], TTY), []);
  assert.deepEqual(renderTable(['id'], [], PIPE), []);
});

test('renderMarkdown drops the markup that only means something in a chat window', () => {
  const rendered = renderMarkdown(
    ['---', '', '## Heading', '', 'Some **bold** prose.', '', '***', ''].join('\n'),
    TTY,
  ).join('\n');
  assert.equal(rendered, 'HEADING\n  Some bold prose.');
});

test('renderMarkdown keeps a fenced block as content without its fence', () => {
  const rendered = renderMarkdown(
    ['Run it:', '', '```bash', 'npm test', '```'].join('\n'),
    TTY,
  );
  assert.deepEqual(rendered, ['  Run it:', '', '  npm test']);
});

test('renderMarkdown lays out nested lists with hanging indents', () => {
  const rendered = renderMarkdown(
    ['- one', '  - nested item that is long enough to need a second line of text here', '- two'].join(
      '\n',
    ),
    { tty: true, width: 60 },
  );
  assert.equal(rendered[0], '  - one');
  assert.equal(rendered[1].slice(0, 6), '    - ');
  assert.match(rendered[2], /^ {6}\S/);
  assert.equal(rendered[3], '  - two');
});

test('renderMarkdown renders a blockquote as text rather than as a marker', () => {
  const rendered = renderMarkdown('> quoted advice\n> continued', TTY);
  assert.deepEqual(rendered, ['    quoted advice continued']);
});
