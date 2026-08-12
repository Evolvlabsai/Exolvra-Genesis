import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { MIN_WIDTH, displayWidth, graphemes } from '../dist/usage.js';
import { PACKAGE_ROOT, REPO_ROOT, createSandbox, run } from './run-cli.js';

/*
 * What `exolvra-genesis plan` actually prints, off a real process.
 *
 * The binary is the one the package ships, run as a child process from a temp
 * directory. The only substitution is the Claude Agent SDK, which the bar
 * allows: in its place the answer is replayed out of a file, so the CLI is
 * handed the same bytes a provider produced. Two of those files are verbatim
 * captures of real `exolvra-genesis plan` runs from before there was a renderer.
 *
 * The transcripts this writes to `.evidence/` are the process's own stdout.
 */

const FIXTURES = join(PACKAGE_ROOT, 'test', 'fixtures');
const EVIDENCE = join(PACKAGE_ROOT, '.evidence');
mkdirSync(EVIDENCE, { recursive: true });

const WORK = mkdtempSync(join(tmpdir(), 'exolvra-genesis-plan-out-'));
const sandbox = createSandbox();
after(() => {
  sandbox.cleanup();
  rmSync(WORK, { recursive: true, force: true });
});

/** An answer in the shape the CLI asks for, held in a file the fake SDK reads. */
const PAYLOAD_ANSWER = join(WORK, 'payload-answer.md');
writeFileSync(
  PAYLOAD_ANSWER,
  [
    "I've read the spec and captured the bar.",
    '',
    '```exolvra-genesis-plan',
    JSON.stringify(
      {
        bar: 'gh 2.88.1 transcripts captured on this machine: root help, leaf help, list output, and the unknown-command error.',
        comparison:
          'Run the built binary as a process, capture its output, and put it beside the gh transcript that covers the same surface.',
        artifacts: [
          { path: '.exolvra-genesis/bar/gh/root-help.txt', detail: 'gh --help: sectioning and alignment' },
          {
            path: '.exolvra-genesis/bar/gh/leaf-help-flags.txt',
            detail: 'gh run list --help: the flag table',
          },
          {
            path: '.exolvra-genesis/bar/gh/list-output.txt',
            detail: 'gh run list: tabular output, machine-pipeable',
          },
        ],
        specs: [
          {
            id: 'P1',
            title: 'Foundation, plugin loader, model overrides, and exolvra-genesis plan',
            covers: 'C1, C2, C3, R14',
            files: 'cli/package.json, cli/src/**, cli/test/**',
            verify: 'cd cli && npm run build && npm test',
          },
          {
            id: 'P2',
            title: 'Event stream and the runs store',
            covers: 'R5, R6',
            files: 'cli/src/events.ts, cli/src/runs-store.ts',
            verify: 'cd cli && npm test',
          },
          {
            id: 'P3',
            title: 'Interactive startup prompts',
            covers: 'R2, R3',
            files: 'cli/src/prompts.ts',
            verify: 'cd cli && npm test',
          },
        ],
      },
      null,
      2,
    ),
    '```',
  ].join('\n'),
  'utf8',
);

/** Runs the real binary against a replayed answer, from a temp directory. */
function planWith(answerFile, env = {}) {
  return sandbox.run(['plan', '--plugin-dir', REPO_ROOT, '-C', WORK, 'a goal'], {
    replay: answerFile,
    cwd: WORK,
    env,
  });
}

test('a preview prints the CLI frame, not the agent formatting, and exits 0', () => {
  const { code, stdout, stderr } = planWith(PAYLOAD_ANSWER);
  assert.equal(code, 0, 'a completed preview must exit 0: ' + stderr);
  writeFileSync(join(EVIDENCE, 'plan-output.txt'), stdout, 'utf8');

  // The sections, their names, and their order are the CLI's.
  const headings = stdout.split('\n').filter((line) => /^[A-Z]+( [A-Z]+)*$/.test(line));
  assert.deepEqual(headings, ['GOAL', 'BAR', 'COMPARISON', 'BAR ARTIFACTS', 'TASK SPECS']);

  // Nothing the agent wrapped around the payload reaches the terminal.
  assert.ok(!stdout.includes("I've read the spec"), 'agent prose leaked into the frame');
  assert.ok(!stdout.includes('```'), 'a fence reached the terminal');
  assert.ok(!stdout.includes('{'), 'raw payload JSON reached the terminal');
});

test('a piped preview writes tab-delimited rows and nothing else', () => {
  const { stdout } = planWith(PAYLOAD_ANSWER);
  const rows = stdout.split('\n').filter((line) => line.includes('\t'));
  assert.equal(rows.length, 6, 'expected three artifacts and three specs: ' + rows.length);

  for (const row of rows) {
    assert.ok(!row.startsWith(' '), 'a piped row was indented: ' + JSON.stringify(row));
    assert.ok(!/ {2}/.test(row), 'a piped row was padded: ' + JSON.stringify(row));
    assert.ok(!/\t\t/.test(row), 'a piped row had an empty field: ' + JSON.stringify(row));
  }
  // Every record of one table has the same number of fields, as `gh` does.
  assert.deepEqual(rows.slice(0, 3).map((row) => row.split('\t').length), [2, 2, 2]);
  assert.deepEqual(rows.slice(3).map((row) => row.split('\t').length), [5, 5, 5]);
});

test('the same preview lays out aligned columns for a terminal', () => {
  const { code, stdout } = planWith(PAYLOAD_ANSWER, { EXOLVRA_GENESIS_FORCE_TTY: '100' });
  assert.equal(code, 0);
  writeFileSync(join(EVIDENCE, 'plan-output-tty.txt'), stdout, 'utf8');

  assert.ok(!stdout.includes('\t'), 'a terminal layout still emitted tabs');
  const lines = stdout.split('\n');
  // Two columns in, under its heading — the indent every other section body
  // sits at, so the table reads as the heading's content and not its peer.
  const header = lines.findIndex((line) => /^ {2}ID {2}TITLE/.test(line));
  assert.ok(header > 0, 'the task-spec table has no header row:\n' + stdout);

  const column = lines[header].indexOf('TITLE');
  for (const line of lines.slice(header, header + 4)) {
    assert.equal(line[column - 1], ' ', 'a cell ran into the gutter: ' + JSON.stringify(line));
    assert.notEqual(line[column], ' ', 'ragged column: ' + JSON.stringify(line));
    assert.ok(line.length <= 100, 'a row ran past the width: ' + JSON.stringify(line));
  }
});

test('the width floor help environment documents is the one a process applies', () => {
  // A floor a user only finds by watching output stop getting narrower is a
  // floor they had to discover. This measures the one the binary really has —
  // every narrower width lays out identically to it, and the width just above
  // it does not, which is what makes this a measurement of the floor rather
  // than of two runs that happened to agree — and then holds the topic to it.
  const at = planWith(PAYLOAD_ANSWER, { EXOLVRA_GENESIS_FORCE_TTY: String(MIN_WIDTH) }).stdout;
  assert.ok(at.length > 0, 'the preview at the floor printed nothing');

  for (const narrower of ['1', String(MIN_WIDTH - 1)]) {
    assert.equal(
      planWith(PAYLOAD_ANSWER, { EXOLVRA_GENESIS_FORCE_TTY: narrower }).stdout,
      at,
      'a width of ' + narrower + ' was not laid out at ' + MIN_WIDTH,
    );
  }
  assert.notEqual(
    planWith(PAYLOAD_ANSWER, { EXOLVRA_GENESIS_FORCE_TTY: String(MIN_WIDTH + 1) }).stdout,
    at,
    'the real floor is above ' + MIN_WIDTH + ', so the documented number is wrong',
  );

  const topic = run(['help', 'environment']).stdout;
  assert.ok(
    topic.includes('under ' + MIN_WIDTH + ' is laid out at ' + MIN_WIDTH),
    'help environment does not document the ' + MIN_WIDTH + '-column floor:\n' + topic,
  );
});

test('a piped record has the same fields whatever the answer contained', () => {
  // The reported defect: the covers column was dropped when no spec filled it
  // in, so field 3 was `covers` on a run made from a spec and `files` on a run
  // made from a goal. No script can be written against a record whose shape
  // depends on its content — `gh` emits its fields whether or not they are
  // empty, and so does this.
  const goalRun = join(WORK, 'no-covers-answer.md');
  writeFileSync(
    goalRun,
    [
      '```exolvra-genesis-plan',
      JSON.stringify({
        bar: 'the bar',
        comparison: 'the comparison',
        artifacts: [{ path: 'a.txt', detail: 'x' }],
        specs: [
          { id: 'P1', title: 'first', covers: '', files: 'src/a.ts', verify: 'npm test' },
          { id: 'P2', title: 'second', files: 'src/b.ts', verify: 'npm test' },
        ],
      }),
      '```',
    ].join('\n'),
    'utf8',
  );

  const fields = (stdout) =>
    stdout
      .split('\n')
      .filter((line) => /^P\d\t/.test(line))
      .map((line) => line.split('\t'));

  const fromSpec = fields(planWith(PAYLOAD_ANSWER).stdout);
  const fromGoal = fields(planWith(goalRun).stdout);
  assert.equal(fromSpec.length, 3);
  assert.equal(fromGoal.length, 2);

  for (const row of [...fromSpec, ...fromGoal]) {
    assert.equal(row.length, 5, 'a record changed shape: ' + JSON.stringify(row));
  }
  // Field 3 is the covers column in both, empty in the run that has none.
  assert.equal(fromSpec[0][2], 'C1, C2, C3, R14');
  assert.equal(fromGoal[0][2], '');
  assert.equal(fromGoal[1][2], '');
  // And the field after it is the files column in both, not shifted along.
  assert.equal(fromGoal[0][3], 'src/a.ts');
  assert.equal(fromSpec[0][3], 'cli/package.json, cli/src/**, cli/test/**');
});

test('two different agent answers produce the same headings in the same order', () => {
  const other = join(WORK, 'other-answer.md');
  writeFileSync(
    other,
    [
      'Summary for approval below.',
      '',
      '```exolvra-genesis-plan',
      JSON.stringify({
        bar: 'Linear.app settings page, captured at 1440x900.',
        comparison: 'Blind A/B against the captured screenshots.',
        artifacts: [{ path: '.exolvra-genesis/bar/linear.png', detail: 'the captured page' }],
        specs: [{ id: '01', title: 'Design tokens', files: 'styles/tokens.css', verify: 'npm test' }],
      }),
      '```',
    ].join('\n'),
    'utf8',
  );

  const first = planWith(PAYLOAD_ANSWER).stdout;
  const second = planWith(other).stdout;
  const headings = (text) => text.split('\n').filter((line) => /^[A-Z]+( [A-Z]+)*$/.test(line));

  assert.notEqual(first, second, 'the two answers carried different content');
  assert.deepEqual(headings(first), headings(second));
  // The columns do not depend on the content either: the field an answer left
  // empty is still a field, in the same place.
  assert.ok(first.includes('C1, C2, C3, R14'));
  const widths = (text) =>
    text
      .split('\n')
      .filter((line) => line.includes('\t'))
      .map((line) => line.split('\t').length);
  assert.deepEqual(widths(first), [2, 2, 2, 5, 5, 5]);
  assert.deepEqual(widths(second), [2, 5], 'a column disappeared with its content');
});

test('an agent that answers in chat markdown is rendered, but is not a win', () => {
  // The captured answers are what `exolvra-genesis plan` used to print verbatim. They
  // are prose, so they are not plans: the words survive, the exit code does not.
  for (const name of ['agent-plan-chat-markdown.md', 'agent-plan-chat-markdown-2.md']) {
    const { code, stdout, stderr } = planWith(join(FIXTURES, name));
    assert.equal(code, 1, name + ' produced no plan, so it must not exit 0');
    assert.match(stderr, /the preview produced no plan/);
    assert.ok(stdout.startsWith('GOAL\n'), name + ' lost the CLI frame:\n' + stdout);
    assert.ok(stdout.includes('\nANSWER\n'), name + ' lost the section it is shown under');
    assert.ok(!stdout.includes('\nPREVIEW\n'), name + ' framed an answer as a preview');
    assert.ok(!stdout.includes('**'), name + ' leaked bold markers:\n' + stdout);
    assert.ok(!/\|\s*-{2,}/.test(stdout), name + ' leaked a table separator row');
    assert.ok(!/(^|\n)\s*-{3,}\s*(\n|$)/.test(stdout), name + ' leaked a horizontal rule');
    assert.ok(!/(^|\n)[ \t]*#{1,6} [^ ]/.test(stdout), name + ' leaked an ATX heading');
    assert.ok(
      !/Reply\s+"?go/i.test(stdout),
      name + ' printed an instruction the reader cannot act on:\n' + stdout,
    );
    const stem = name.replace(/\.md$/, '');
    writeFileSync(join(EVIDENCE, 'plan-output-answer-' + stem + '.txt'), stdout, 'utf8');
  }
});

/* -------------------------------------------------------------------------- */
/* The same binary, fed what a prompt cannot rule out                          */
/* -------------------------------------------------------------------------- */

/*
 * Every value below was written by the agent, so every value below is
 * untrusted input to the renderer. The prompt asks for plain single-line
 * text; these are the answers a prompt does not prevent — line breaks, tabs,
 * carriage returns, escape sequences, ideographs, emoji spelled out of six
 * code points, accents that are their own character, empty fields, and values
 * longer than the terminal is wide.
 */

const ESC = String.fromCharCode(0x1b);
const ZWJ = String.fromCodePoint(0x200d);
const FAMILY = '\u{1f468}' + ZWJ + '\u{1f469}' + ZWJ + '\u{1f467}' + ZWJ + '\u{1f466}';
const FLAG_JP = '\u{1f1ef}\u{1f1f5}';
const ACCENTED = 'e' + String.fromCodePoint(0x301) + 'cole';
const ROCKETS = 'ab\u{1f680}\u{1f680}\u{1f680}\u{1f680}';
const CONTROL_CHAR = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]');

const HOSTILE_ARTIFACTS = [
  { path: 'docs/参考/設計仕様書.md', detail: '全角文字は二列を占める' },
  { path: ROCKETS, detail: FAMILY + ' ' + FLAG_JP + ' joined emoji' },
  { path: ACCENTED + '/notes.md', detail: '' },
  {
    path: ESC + '[2J' + ESC + '[H wiped-the-screen.txt',
    detail: 'a CR\rand a tab\tand a newline\nin one field',
  },
  { path: 'x'.repeat(180), detail: 'longer than any terminal' },
];

const HOSTILE_SPECS = [
  { id: 'p2', title: 'first line\nsecond line', files: 'src/a.ts', verify: 'npm run build' },
  {
    id: 'p3',
    title: '設計仕様書のレビューと全角の見出し',
    files: 'docs/参考/設計.ts',
    verify: 'npm test',
  },
  // The joined emoji sits in the last column on purpose: a terminal without
  // grapheme support draws it wider than the one character it is, and in the
  // last column that cannot push anything out of line in the transcript.
  {
    id: 'p4',
    title: ROCKETS + ' rockets',
    files: 'src/b.ts',
    verify: 'npm test ' + FAMILY + ' ' + FLAG_JP,
  },
  {
    id: 'p5',
    title: ACCENTED + ' and a tab\there',
    files: 'src/' + ACCENTED + '.ts',
    verify: ESC + '[31mnpm test',
  },
  { id: 'p6', title: 'y'.repeat(200), files: 'src/c.ts', verify: 'z'.repeat(120) },
];

function answerFile(name, payload) {
  const path = join(WORK, name);
  writeFileSync(
    path,
    [
      'Here is the preview.',
      '',
      '```exolvra-genesis-plan',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n'),
    'utf8',
  );
  return path;
}

const HOSTILE_ANSWER = answerFile('hostile-answer.md', {
  bar: 'Two lines\nin one field, a tab\there, a CR\rthere, and ' + ESC + '[31man escape' + ESC + '[0m.',
  comparison:
    '端末幅を超える長い日本語の文章は空白で区切られていないため折り返しの対象になる。'.repeat(2),
  artifacts: HOSTILE_ARTIFACTS,
  specs: HOSTILE_SPECS,
});

/** The same answer with the column that only a spec run fills in. */
const HOSTILE_COVERS_ANSWER = answerFile('hostile-covers-answer.md', {
  bar: 'The bar, with a covers column to place as well.',
  comparison: 'Run the binary and compare the transcript.',
  artifacts: HOSTILE_ARTIFACTS,
  specs: HOSTILE_SPECS.map((spec, index) => ({
    ...spec,
    covers: index === 0 ? 'C1, C2\nC3' : '要件' + (index + 1) + ', R' + index,
  })),
});

/** A goal typed by the user is echoed, so it is untrusted input as well. */
const HOSTILE_GOAL =
  'render ' + ESC + '[31mred' + ESC + '[0m 設計仕様書 \u{1f680} ' + ACCENTED;

function hostilePlan(answerFile, env = {}) {
  return sandbox.run(
    ['plan', '--plugin-dir', REPO_ROOT, '-C', WORK, HOSTILE_GOAL],
    { replay: answerFile, cwd: WORK, env },
  );
}

/** The lines of one section, from its heading to the blank line under it. */
function sectionLines(stdout, heading) {
  const lines = stdout.split('\n');
  const at = lines.indexOf(heading);
  assert.ok(at >= 0, heading + ' is missing from:\n' + stdout);
  const out = [];
  for (let i = at + 1; i < lines.length && lines[i] !== ''; i += 1) out.push(lines[i]);
  return out;
}

/**
 * Where each field of a laid-out row starts, in display columns.
 *
 * A field is flattened before it is measured, so it never holds two spaces in
 * a row: a run of two or more spaces is a gutter and nothing else.
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
    column += displayWidth(cluster);
  }
  return starts;
}

const HOSTILE_RUNS = [
  { label: 'piped, no terminal', env: {}, width: undefined, columns: 5 },
  { label: 'terminal, 100 columns', env: { EXOLVRA_GENESIS_FORCE_TTY: '100' }, width: 100, columns: 5 },
  { label: 'terminal, 80 columns', env: { EXOLVRA_GENESIS_FORCE_TTY: '80' }, width: 80, columns: 5 },
  { label: 'terminal, 40 columns', env: { EXOLVRA_GENESIS_FORCE_TTY: '40' }, width: 40, columns: 5 },
];

test('hostile field values still produce one record per row, at every width', () => {
  const transcripts = [];

  const check = ({ label, env, width, columns }, answer) => {
    const { code, stdout, stderr } = hostilePlan(answer, env);
    assert.equal(code, 0, label + ' did not exit 0: ' + stderr);
    transcripts.push({ label, env, stdout });

    // Nothing a terminal would obey rather than draw survived the renderer.
    assert.ok(!stdout.includes(ESC), label + ' let an escape sequence through');
    for (const line of stdout.split('\n')) {
      assert.ok(
        !CONTROL_CHAR.test(line.replace(/\t/g, '')),
        label + ' let a control character through: ' + JSON.stringify(line),
      );
    }
    assert.ok(!stdout.includes('```'), label + ' leaked a fence');

    const specs = sectionLines(stdout, 'TASK SPECS');
    const artifacts = sectionLines(stdout, 'BAR ARTIFACTS');

    if (width === undefined) {
      // A pipe: one tab-delimited record per line, whatever the fields held.
      assert.equal(specs.length, HOSTILE_SPECS.length, label + ' split a record');
      assert.equal(artifacts.length, HOSTILE_ARTIFACTS.length, label + ' split a record');
      for (const row of specs) {
        assert.equal(row.split('\t').length, columns, JSON.stringify(row));
      }
      for (const row of artifacts) assert.equal(row.split('\t').length, 2);
      // The reported defect: `cut -f1` reads the id of every record.
      assert.deepEqual(
        specs.map((row) => row.split('\t')[0]),
        HOSTILE_SPECS.map((spec) => spec.id),
      );
      assert.equal(specs[0].split('\t')[1], 'first line second line');
      return;
    }

    // A terminal: a header and one row per record, none of them ragged and
    // none of them past the width.
    assert.equal(specs.length, HOSTILE_SPECS.length + 1, label + ' split a record');
    assert.equal(artifacts.length, HOSTILE_ARTIFACTS.length + 1, label + ' split a record');
    assert.ok(!stdout.includes('\t'), label + ' emitted a tab into a laid-out table');

    for (const line of stdout.split('\n')) {
      assert.ok(
        displayWidth(line) <= width,
        label + ' ran past the width: ' + JSON.stringify(line),
      );
    }
    for (const table of [specs, artifacts]) {
      const header = fieldStarts(table[0]);
      assert.equal(header.length, table === specs ? columns : 2, label + ' lost a column');
      for (const row of table) {
        for (const start of fieldStarts(row)) {
          assert.ok(
            header.includes(start),
            label + ' laid out a ragged row: ' + JSON.stringify(row),
          );
        }
      }
      // The CJK row reaches the last column exactly where the header does.
      assert.ok(
        fieldStarts(table[1]).includes(header[header.length - 1]),
        label + ' lost the last column of a wide-character row',
      );
    }
  };

  for (const run of HOSTILE_RUNS) check(run, HOSTILE_ANSWER);
  check(
    {
      label: 'terminal, 80 columns, with a covers column',
      env: { EXOLVRA_GENESIS_FORCE_TTY: '80' },
      width: 80,
      columns: 5,
    },
    HOSTILE_COVERS_ANSWER,
  );

  // The transcript written to .evidence is the process output, verbatim.
  const evidence = [
    'exolvra-genesis plan, fed field values a prompt cannot rule out.',
    '',
    'Each block below is the stdout of one run of the built binary, byte for',
    'byte, produced by test/plan-output.test.js. The agent answer replayed into',
    'it carries newlines, tabs, carriage returns, ANSI escape sequences, CJK,',
    'emoji joined with ZWJ, regional-indicator flags, combining marks, empty',
    'fields, and values longer than the terminal.',
    '',
    'Widths are display columns: East Asian Wide and Fullwidth characters count',
    'two, combining marks and joiners count none, and an emoji joined out of',
    'several code points counts as the one two-column character a',
    'grapheme-aware terminal draws it as.',
    '',
  ];
  for (const { label, env, stdout } of transcripts) {
    const setting = Object.entries(env)
      .map(([key, value]) => key + '=' + value + ' ')
      .join('');
    evidence.push(
      '='.repeat(72),
      '$ ' + setting + 'exolvra-genesis plan "<goal>" | cat        # ' + label,
      '='.repeat(72),
      '',
      stdout,
    );
  }
  const file = join(EVIDENCE, 'plan-output-hostile.txt');
  writeFileSync(file, evidence.join('\n'), 'utf8');

  const written = readFileSync(file, 'utf8');
  for (const { label, stdout } of transcripts) {
    assert.ok(written.includes(stdout), label + ' was not recorded verbatim');
  }
});

test('the evidence transcripts are the process output, byte for byte', () => {
  const { stdout } = planWith(PAYLOAD_ANSWER);
  assert.equal(readFileSync(join(EVIDENCE, 'plan-output.txt'), 'utf8'), stdout);
  assert.ok(stdout.length > 0);
});
