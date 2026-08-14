import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

import { ConfigError } from '../dist/exit.js';
import {
  IGNORE_PATTERN,
  STANDARDS_PATH,
  describeStandardsIssues,
  gateProblem,
  loadStandards,
  needsIgnorePattern,
  normalizeSubject,
  parseStandards,
  planIgnorePattern,
  readStandardsText,
  renderStandards,
  standardsPath,
  subjectKind,
  validateStandards,
  wholeDirectoryIgnores,
  withIgnorePattern,
} from '../dist/standards.js';
import {
  checkCommand,
  initCommand,
  renderStandardsHelp,
  titleFor,
} from '../dist/commands/standards.js';
import { renderCommandHelp } from '../dist/usage.js';
import { BIN, PACKAGE_ROOT, runProcess } from './run-cli.js';
import { ENTER, screen } from './tty.js';

/*
 * `exolvra-genesis standards`, end to end.
 *
 * Nothing here is simulated except the terminal: `standards` reaches no
 * provider, so the module is exercised in process and both subcommands are run
 * as real child processes. `init` is TTY-only and a spawned process is given
 * pipes, so it is driven through a pair of streams that claim to be a terminal
 * and take real keystrokes — the flag boundary, the prompt flow, the file it
 * composes and the exit code are all the shipped `dist/`.
 */

const TEMP = [];
after(() => {
  for (const dir of TEMP) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Left for the operating system to reclaim.
    }
  }
});

/** A repo to run against: an empty one, with the artifact the fixtures name. */
function repo(standards) {
  const dir = mkdtempSync(join(tmpdir(), 'exolvra-genesis-standards-'));
  TEMP.push(dir);
  mkdirSync(join(dir, 'bars'), { recursive: true });
  writeFileSync(join(dir, 'bars', 'root-help.txt'), 'a captured help page\n', 'utf8');
  if (standards !== undefined) {
    mkdirSync(join(dir, '.exolvra-genesis'), { recursive: true });
    writeFileSync(standardsPath(dir), standards, 'utf8');
  }
  return dir;
}

const file = (...lines) => lines.join('\n') + '\n';

/** A complete, ordinary standards file. Line numbers are load-bearing below. */
const VALID = file(
  '# Standards', //                                                        1
  '', //                                                                   2
  'Exolvra Genesis is an adversarial orchestration loop for Claude Code,', // 3
  'shipped as a plugin and as a TypeScript CLI that runs the same loop.', //  4
  '', //                                                                   5
  '## Gates', //                                                           6
  '', //                                                                   7
  '- G1. The full suite passes: `cd cli && npm test`.', //                 8
  '- G2. Runtime dependencies never grow beyond the Claude Agent SDK and', // 9
  '  one terminal-prompt library.', //                                    10
  '', //                                                                  11
  '## Standing bar', //                                                   12
  '', //                                                                  13
  '- `bars/root-help.txt` — the page every help surface is judged against', // 14
  '- 80 columns — no help page wraps in an 80-column terminal', //         15
  '', //                                                                  16
  '## Conventions', //                                                    17
  '', //                                                                  18
  'Commands self-register from src/commands/, so adding one adds a file.', // 19
);

/* -------------------------------------------------------------------------- */
/* The shape                                                                   */
/* -------------------------------------------------------------------------- */

test('the fixed shape parses into its four parts', () => {
  const { standards, issues } = parseStandards(VALID);
  assert.deepEqual(issues, []);
  assert.equal(standards.title, 'Standards');
  assert.match(standards.purpose, /^Exolvra Genesis is an adversarial/);
  assert.match(standards.purpose, /runs the same loop\.$/);

  assert.deepEqual(
    standards.gates.map((gate) => [gate.id, gate.line]),
    [
      ['G1', 8],
      ['G2', 9],
    ],
  );
  // The wrapped gate is one gate: the indented line continues it.
  assert.equal(
    standards.gates[1].text,
    'Runtime dependencies never grow beyond the Claude Agent SDK and one terminal-prompt library.',
  );

  assert.deepEqual(
    standards.standingBar.map((entry) => [entry.subject, entry.kind, entry.line]),
    [
      ['bars/root-help.txt', 'path', 14],
      ['80 columns', 'value', 15],
    ],
  );
  assert.equal(
    standards.standingBar[0].description,
    'the page every help surface is judged against',
  );
  assert.match(standards.conventions, /^Commands self-register/);
});

test('a valid file has nothing wrong with it, artifacts included', () => {
  assert.deepEqual(validateStandards(VALID, { cwd: repo() }), []);
});

test('a hyphen and an en dash divide an entry as well as an em dash', () => {
  for (const dash of ['—', '–', '-']) {
    const text = VALID.replace('— the page every', dash + ' the page every');
    const { standards, issues } = parseStandards(text);
    assert.deepEqual(issues, [], 'a ' + dash + ' entry did not parse');
    assert.equal(standards.standingBar[0].subject, 'bars/root-help.txt');
    assert.equal(
      standards.standingBar[0].description,
      'the page every help surface is judged against',
    );
  }
});

test('a fenced block in the conventions cannot start a section', () => {
  const text = VALID.replace(
    'Commands self-register from src/commands/, so adding one adds a file.',
    ['Write gates like this:', '', '```markdown', '## Gates', '', '- G1. x', '```'].join('\n'),
  );
  const { standards, issues } = parseStandards(text);
  assert.deepEqual(issues, []);
  assert.equal(standards.gates.length, 2, 'the fenced example was read as a section');
  assert.match(standards.conventions, /```markdown/);
});

/* -------------------------------------------------------------------------- */
/* Every fault, named by its line                                              */
/* -------------------------------------------------------------------------- */

/**
 * One defect at a time, each in an otherwise complete file.
 *
 * Every case asserts the whole list rather than a member of it: a checker that
 * reports the fault plus two it invented is not a checker anybody would keep
 * running, and one line is what the reader has to be sent to.
 */
const BROKEN = [
  {
    name: 'no purpose paragraph',
    file: file(
      '# Standards',
      '',
      '## Gates',
      '',
      '- G1. `npm test` passes.',
      '',
      '## Standing bar',
      '',
      '- `bars/root-help.txt` — the captured page',
      '',
      '## Conventions',
      '',
      'Nothing unusual.',
    ),
    line: 1,
    needle: 'no purpose paragraph',
  },
  {
    name: 'a gate numbered out of sequence',
    file: file(
      'Purpose.',
      '',
      '## Gates',
      '',
      '- G1. `npm test` passes.',
      '- G3. `npm run build` passes.',
      '',
      '## Standing bar',
      '',
      '- `bars/root-help.txt` — the captured page',
      '',
      '## Conventions',
      '',
      'Nothing unusual.',
    ),
    line: 6,
    needle: 'numbered G3, but this is gate 2',
  },
  {
    name: 'a list item that is not a gate',
    file: file(
      'Purpose.',
      '',
      '## Gates',
      '',
      '- G1. `npm test` passes.',
      '- The suite must stay green.',
      '',
      '## Standing bar',
      '',
      '- `bars/root-help.txt` — the captured page',
      '',
      '## Conventions',
      '',
      'Nothing unusual.',
    ),
    line: 6,
    needle: 'not a gate',
  },
  {
    name: 'a gate written out of adjectives',
    file: file(
      'Purpose.',
      '',
      '## Gates',
      '',
      '- G1. The interface should be clean.',
      '',
      '## Standing bar',
      '',
      '- `bars/root-help.txt` — the captured page',
      '',
      '## Conventions',
      '',
      'Nothing unusual.',
    ),
    line: 5,
    needle: '"clean" is an adjective',
  },
  {
    name: 'a gate that never says what has to hold',
    file: file(
      'Purpose.',
      '',
      '## Gates',
      '',
      '- G1. Reviews happen on Tuesdays.',
      '',
      '## Standing bar',
      '',
      '- `bars/root-help.txt` — the captured page',
      '',
      '## Conventions',
      '',
      'Nothing unusual.',
    ),
    line: 5,
    needle: 'name a command, a path, a number',
  },
  {
    name: 'a Gates section with no gates in it',
    file: file(
      'Purpose.',
      '',
      '## Gates',
      '',
      '## Standing bar',
      '',
      '- `bars/root-help.txt` — the captured page',
      '',
      '## Conventions',
      '',
      'Nothing unusual.',
    ),
    line: 3,
    needle: 'no gates',
  },
  {
    name: 'a stray line under Gates',
    file: file(
      'Purpose.',
      '',
      '## Gates',
      '',
      '- G1. `npm test` passes.',
      'And another thing.',
      '',
      '## Standing bar',
      '',
      '- `bars/root-help.txt` — the captured page',
      '',
      '## Conventions',
      '',
      'Nothing unusual.',
    ),
    line: 6,
    needle: 'stray line under ## Gates',
  },
  {
    name: 'a missing section',
    file: file(
      'Purpose.',
      '',
      '## Gates',
      '',
      '- G1. `npm test` passes.',
      '',
      '## Conventions',
      '',
      'Nothing unusual.',
    ),
    line: 7,
    needle: 'no ## Standing bar section — it belongs here',
  },
  {
    name: 'a section that appears twice',
    file: file(
      'Purpose.',
      '',
      '## Gates',
      '',
      '- G1. `npm test` passes.',
      '',
      '## Standing bar',
      '',
      '- `bars/root-help.txt` — the captured page',
      '',
      '## Gates',
      '',
      '- G1. `npm run build` passes.',
      '',
      '## Conventions',
      '',
      'Nothing unusual.',
    ),
    line: 11,
    needle: 'a second ## Gates section',
  },
  {
    name: 'sections out of order',
    file: file(
      'Purpose.',
      '',
      '## Gates',
      '',
      '- G1. `npm test` passes.',
      '',
      '## Conventions',
      '',
      'Nothing unusual.',
      '',
      '## Standing bar',
      '',
      '- `bars/root-help.txt` — the captured page',
    ),
    line: 11,
    // The fault, in the file's own terms: what this file does, and then what a
    // standards file does. The old wording stated only the rule, which read as
    // a claim about the file in front of the reader and was the one thing that
    // was not true of it.
    needle:
      '## Standing bar is after ## Conventions here — the sections come in the ' +
      'order ## Gates, ## Standing bar, ## Conventions',
  },
  {
    name: 'a section nobody reads',
    file: file(
      'Purpose.',
      '',
      '## Gates',
      '',
      '- G1. `npm test` passes.',
      '',
      '## Deployment',
      '',
      'Ship it on Fridays.',
      '',
      '## Standing bar',
      '',
      '- `bars/root-help.txt` — the captured page',
      '',
      '## Conventions',
      '',
      'Nothing unusual.',
    ),
    line: 7,
    needle: 'unknown section "## Deployment"',
  },
  {
    name: 'a standing bar entry with no description',
    file: file(
      'Purpose.',
      '',
      '## Gates',
      '',
      '- G1. `npm test` passes.',
      '',
      '## Standing bar',
      '',
      '- bars/root-help.txt the captured page',
      '',
      '## Conventions',
      '',
      'Nothing unusual.',
    ),
    line: 9,
    needle: 'not a standing bar entry',
  },
  {
    name: 'a standing bar artifact that is not there',
    file: file(
      'Purpose.',
      '',
      '## Gates',
      '',
      '- G1. `npm test` passes.',
      '',
      '## Standing bar',
      '',
      '- `bars/nobody-committed.png` — a screenshot that never landed',
      '',
      '## Conventions',
      '',
      'Nothing unusual.',
    ),
    line: 9,
    needle: '"bars/nobody-committed.png" does not resolve',
  },
  {
    name: 'a standing bar artifact only this machine has',
    file: file(
      'Purpose.',
      '',
      '## Gates',
      '',
      '- G1. `npm test` passes.',
      '',
      '## Standing bar',
      '',
      '- `/etc/hosts` — a file with an absolute path',
      '',
      '## Conventions',
      '',
      'Nothing unusual.',
    ),
    line: 9,
    needle: 'is an absolute path',
  },
  {
    name: 'a standing bar entry that is an adjective',
    file: file(
      'Purpose.',
      '',
      '## Gates',
      '',
      '- G1. `npm test` passes.',
      '',
      '## Standing bar',
      '',
      '- polish — how the thing ought to feel',
      '',
      '## Conventions',
      '',
      'Nothing unusual.',
    ),
    line: 9,
    needle: '"polish" is neither a path in this repo nor a number',
  },
  {
    name: 'an empty Conventions section',
    file: file(
      'Purpose.',
      '',
      '## Gates',
      '',
      '- G1. `npm test` passes.',
      '',
      '## Standing bar',
      '',
      '- `bars/root-help.txt` — the captured page',
      '',
      '## Conventions',
    ),
    line: 11,
    needle: 'no conventions',
  },
];

for (const broken of BROKEN) {
  test('rejected, and named by line: ' + broken.name, () => {
    const dir = repo(broken.file);
    const issues = validateStandards(broken.file, { cwd: dir });
    assert.equal(
      issues.length,
      1,
      'expected exactly one problem, saw:\n' +
        issues.map((issue) => 'line ' + issue.line + ': ' + issue.message).join('\n'),
    );
    assert.equal(issues[0].line, broken.line);
    assert.ok(
      issues[0].message.includes(broken.needle),
      'message never says ' + JSON.stringify(broken.needle) + ': ' + issues[0].message,
    );

    // And off a real process, which is the only place an exit code is evidence.
    const { code, stdout, stderr } = runProcess(BIN, ['standards', 'check', '-C', dir], {});
    assert.equal(code, 2, 'a file with a problem must exit 2: ' + stderr);
    assert.equal(stdout, '', 'nothing belongs on stdout when nothing checked out');
    assert.ok(
      stderr.includes('line ' + broken.line + ': '),
      'stderr never names line ' + broken.line + ':\n' + stderr,
    );
    assert.ok(stderr.includes(broken.needle), stderr);
  });
}

test('every problem in a broken file is reported, not just the first', () => {
  const dir = repo();
  const issues = validateStandards(
    file(
      '# Standards',
      '',
      '## Gates',
      '',
      '- G1. The interface should be clean.',
      '',
      '## Standing bar',
      '',
      '- polish — how the thing ought to feel',
      '',
      '## Conventions',
    ),
    { cwd: dir },
  );
  assert.deepEqual(
    issues.map((issue) => issue.line),
    [1, 5, 9, 11],
    issues.map((issue) => 'line ' + issue.line + ': ' + issue.message).join('\n'),
  );

  // The raised complaint keeps them in that order and adds the shape they were
  // measured against, so a reader can act on the list without leaving it.
  const report = describeStandardsIssues('/repo/' + STANDARDS_PATH, issues);
  assert.match(report, /^4 problems in \/repo\/\.exolvra-genesis\/standards\.md\n/);
  assert.ok(report.includes('\n  line 5: '));
  assert.ok(report.includes('a standards file is a purpose paragraph'));
  assert.equal(describeStandardsIssues('x', [issues[0]]).split('\n')[0], '1 problem in x');
});

test('a figure in the line does not buy an adjective its way past the lint', () => {
  /*
   * The short-circuit this replaces: any digit, backtick or slash made the
   * whole line checkable, so a gate could ask for a feeling as long as it
   * counted something while it did. A number settles whether a line says
   * anything measurable; it was never the same question as whether the line
   * also asks for something no two readers would score alike.
   */
  const withNumber = gateProblem('the UI must be beautiful, with 2 accent colours');
  assert.notEqual(withNumber, undefined, 'a digit still excused an adjective');
  assert.match(withNumber, /"beautiful" is an adjective; phrase the checkable core without it/);

  // A word inside a command is a name, not a claim about how the work feels.
  assert.equal(
    gateProblem('`npm run clean` exits 0'),
    undefined,
    'an adjective inside a code span was read as prose',
  );
  assert.equal(gateProblem('`npm run lint` reports no warning'), undefined);

  // And a path is masked the same way, so what is left is the prose — here,
  // two adjectives, and the message names both of them.
  const two = gateProblem('code should be clean and idiomatic in src/');
  assert.notEqual(two, undefined, 'a path excused two adjectives');
  assert.match(two, /"clean" and "idiomatic" are adjectives/);
  assert.match(two, /phrase the checkable core without them/);
  assert.equal(
    gateProblem('every file in src/ is formatted'),
    undefined,
    'masking a path lost the rest of the line',
  );
});

test('a gate is checkable when it names something, and not when it names a feeling', () => {
  for (const gate of [
    'The full suite passes: `cd cli && npm test`.',
    'Every help page fits in 80 columns.',
    'No new runtime dependency is added.',
    'Errors must name the flag the user typed.',
    'bars/root-help.txt is the page every help surface is judged against.',
    'Finishes in under 2s, and reads cleanly.',
  ]) {
    assert.equal(gateProblem(gate), undefined, 'refused a real gate: ' + gate);
  }
  for (const gate of [
    'The interface should be clean.',
    'Code is readable and maintainable.',
    'Make it feel modern.',
    'Reviews happen on Tuesdays.',
  ]) {
    assert.notEqual(gateProblem(gate), undefined, 'accepted a non-gate: ' + gate);
  }
});

test('a standing bar subject is a path or a number, decided by shape', () => {
  for (const path of ['bars/home.png', 'README.md', '.gitignore', 'docs\\spec.md']) {
    assert.equal(subjectKind(path), 'path', path + ' is a path');
  }
  // A figure that happens to carry a dot is still a figure: an extension starts
  // with a letter, and `0.5s` is a budget rather than a file to open.
  for (const value of ['80 columns', 'p95 under 200ms', '0.5s', 'v1.2.3', '99.9%']) {
    assert.equal(subjectKind(value), 'value', value + ' is a number');
  }
  assert.equal(normalizeSubject('`bars/home.png`'), 'bars/home.png');
});

const ESC = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
/** The overrides that turn the rest of a line around on a terminal. */
const RLO = String.fromCharCode(0x202e);
const PDF = String.fromCharCode(0x202c);

test('nothing read out of the file can repaint the terminal', () => {
  const hostile = file(
    'Purpose.',
    '',
    '## Gates',
    '',
    '- G1. The ' + ESC + '[31mred' + ESC + '[0m interface should be clean.',
    '',
    '## Standing bar',
    '',
    '- ' + RLO + 'polish' + PDF + BELL + ' — how it ought to feel',
    '',
    '## Conventions',
    '',
    'Nothing unusual.',
  );
  const report = describeStandardsIssues('/repo/standards.md', validateStandards(hostile));

  assert.ok(!report.includes(ESC), 'an escape sequence survived into the report');
  assert.ok(!report.includes(BELL), 'a control character survived into the report');
  assert.ok(!report.includes(RLO) && !report.includes(PDF), 'a bidi override survived');
  // Every line after the header is one indented detail, so nothing the file
  // carried invented a line of its own.
  for (const line of report.split('\n').slice(1)) {
    assert.ok(line.startsWith('  '), 'a message broke out of its line: ' + line);
  }
});

/* -------------------------------------------------------------------------- */
/* Absent is not a fault (C2)                                                  */
/* -------------------------------------------------------------------------- */

test('a repo with no standards file answers null, silently, and stays untouched', () => {
  const dir = repo();
  assert.equal(readStandardsText(dir), null);
  assert.equal(loadStandards(dir), null);
  assert.equal(
    existsSync(join(dir, '.exolvra-genesis')),
    false,
    'reading standards created state in a repo that has none',
  );
});

test('a file that is there and does not parse raises rather than vanishing', () => {
  const dir = repo(file('# Standards', '', 'Purpose.', '', '## Gates', ''));
  assert.throws(() => loadStandards(dir), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /^3 problems in /);
    return true;
  });
});

/* -------------------------------------------------------------------------- */
/* Composing one                                                               */
/* -------------------------------------------------------------------------- */

const DRAFT = {
  purpose:
    'A TypeScript CLI that runs Exolvra Genesis loops from a terminal, plus the ' +
    'Claude Code plugin the loop itself lives in.',
  gates: [
    'The full suite passes: `cd cli && npm test`.',
    'Runtime dependencies never grow beyond the Claude Agent SDK and one terminal-prompt library, which is a rule long enough to wrap.',
  ],
  standingBar: [
    { subject: 'bars/root-help.txt', description: 'the page every help surface is judged against' },
    { subject: '80 columns', description: 'no help page wraps in an 80-column terminal' },
  ],
  conventions:
    'Commands self-register from src/commands/, so adding one is adding a file.\n\n' +
    'Errors carry the complaint, an indented detail, and the usage line.',
};

test('what the interview composes is what the checker accepts, unchanged', () => {
  const dir = repo();
  const text = renderStandards(DRAFT);
  assert.deepEqual(validateStandards(text, { cwd: dir }), [], text);

  const { standards, issues } = parseStandards(text);
  assert.deepEqual(issues, []);
  assert.equal(standards.title, 'Standards');
  assert.equal(standards.purpose.replace(/\s+/g, ' '), DRAFT.purpose);
  assert.deepEqual(standards.gates.map((gate) => gate.text), DRAFT.gates);
  assert.deepEqual(standards.gates.map((gate) => gate.id), ['G1', 'G2']);
  assert.deepEqual(
    standards.standingBar.map((entry) => ({
      subject: entry.subject,
      description: entry.description,
    })),
    DRAFT.standingBar,
  );
  assert.equal(standards.conventions, DRAFT.conventions);

  // A path is spelled in backticks and a number is not, and no line runs past
  // the width the file is written to.
  assert.ok(text.includes('- `bars/root-help.txt` — '), text);
  assert.ok(text.includes('- 80 columns — '), text);
  for (const line of text.split('\n')) {
    assert.ok(line.length <= 76, 'a composed line is ' + line.length + ' columns: ' + line);
  }
  // The long gate wrapped, and came back as one gate anyway.
  assert.ok(text.includes('\n  '), 'nothing wrapped, so the continuation is untested');
});

/* -------------------------------------------------------------------------- */
/* The C7 ignore pattern                                                       */
/* -------------------------------------------------------------------------- */

test('the pattern is offered only where the whole state directory is ignored', () => {
  for (const rule of [
    '.exolvra-genesis',
    '.exolvra-genesis/',
    '/.exolvra-genesis/',
    '.exolvra-genesis/*',
    '/.exolvra-genesis/**',
    '**/.exolvra-genesis/',
  ]) {
    assert.equal(
      needsIgnorePattern('node_modules/\n' + rule + '\ndist/\n'),
      true,
      rule + ' ignores the standards file, and was not spotted',
    );
  }
  for (const ignore of [
    'node_modules/\ndist/\n',
    '# .exolvra-genesis/\n',
    IGNORE_PATTERN.join('\n') + '\n',
    'node_modules/\n' + IGNORE_PATTERN.join('\n') + '\n',
  ]) {
    assert.equal(
      needsIgnorePattern(ignore),
      false,
      'offered the pattern to a file that does not need it: ' + JSON.stringify(ignore),
    );
  }
});

test('the pattern replaces the blanket rule where it stands', () => {
  const before = 'node_modules/\n.exolvra-genesis/\ndist/\n';
  assert.deepEqual(wholeDirectoryIgnores(before), [2]);
  assert.equal(
    withIgnorePattern(before),
    ['node_modules/', ...IGNORE_PATTERN, 'dist/'].join('\n') + '\n',
  );
  assert.equal(needsIgnorePattern(withIgnorePattern(before)), false);

  // A second blanket rule further down would ignore the directory all over
  // again, so it goes rather than being left to win.
  assert.equal(
    withIgnorePattern('.exolvra-genesis/\ndist/\n/.exolvra-genesis/**\n'),
    [...IGNORE_PATTERN, 'dist/'].join('\n') + '\n',
  );

  // And a Windows checkout keeps its own line endings rather than showing up as
  // a diff that touched every line.
  assert.equal(
    withIgnorePattern('node_modules/\r\n.exolvra-genesis/\r\n'),
    ['node_modules/', ...IGNORE_PATTERN].join('\r\n') + '\r\n',
  );
});

/* -------------------------------------------------------------------------- */
/* The command surface                                                         */
/* -------------------------------------------------------------------------- */

test('standards check on a valid file exits 0 with one line and no complaint', () => {
  const dir = repo(VALID);
  const { code, stdout, stderr } = runProcess(BIN, ['standards', 'check', '-C', dir], {});
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
  assert.equal(stdout, standardsPath(dir) + ': 2 gates, 2 standing bar entries, nothing wrong\n');
});

test('standards check in a repo with no standards file exits 2, naming both the path and the fix', () => {
  const dir = repo();
  const { code, stdout, stderr } = runProcess(BIN, ['standards', 'check', '-C', dir], {});
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.ok(stderr.includes('no standards file at ' + standardsPath(dir)), stderr);
  assert.ok(stderr.includes('exolvra-genesis standards init'), stderr);
  // No usage line: the command line was typed correctly, and sending the reader
  // back to retype it would point them at nothing they have to change.
  assert.ok(!stderr.includes('Usage:'), stderr);
});

test('the group and both leaves document themselves', () => {
  const group = runProcess(BIN, ['standards', '--help'], {});
  assert.equal(group.code, 0);
  assert.equal(group.stderr, '');
  for (const heading of [
    'USAGE',
    'AVAILABLE COMMANDS',
    'FLAGS',
    'INHERITED FLAGS',
    'EXAMPLES',
    'LEARN MORE',
  ]) {
    assert.ok(group.stdout.includes('\n' + heading + '\n'), 'group help is missing ' + heading);
  }
  // Commands before flags, the order the root help of this CLI uses too.
  assert.ok(
    group.stdout.indexOf('\nAVAILABLE COMMANDS\n') < group.stdout.indexOf('\nFLAGS\n'),
    'the flag table came before the commands it applies to',
  );
  for (const leaf of [checkCommand, initCommand]) {
    assert.ok(group.stdout.includes('  ' + leaf.name + ':'), 'no row for ' + leaf.name);
    assert.ok(group.stdout.includes(leaf.summary), 'no summary for ' + leaf.name);
  }

  for (const leaf of [checkCommand, initCommand]) {
    const help = runProcess(BIN, ['standards', leaf.name, '--help'], {});
    assert.equal(help.code, 0, help.stderr);
    assert.equal(help.stderr, '');
    assert.equal(help.stdout, renderCommandHelp(leaf));
    assert.ok(help.stdout.includes('\n  ' + leaf.usage + '\n'), 'no usage line for ' + leaf.name);
    for (const flag of leaf.flags) {
      assert.ok(
        help.stdout.includes('-' + flag.short + ', --' + flag.long + ' ' + flag.value.arg),
        leaf.name + ' help is missing --' + flag.long,
      );
    }
    assert.ok(help.stdout.includes('--help'), 'inherited --help must be documented');
  }
});

test('the group page carries the same LEARN MORE block every other page does', () => {
  // It is laid out here rather than by the shared page renderer, so the copy is
  // held against the original instead of being left to drift out of sync.
  const tail = (page) => page.slice(page.indexOf('LEARN MORE'));
  assert.equal(tail(renderStandardsHelp()), tail(renderCommandHelp(checkCommand)));
});

test('a missing or unknown subcommand is refused in the shape every other input is', () => {
  const missing = runProcess(BIN, ['standards'], {});
  assert.equal(missing.code, 2);
  assert.equal(missing.stdout, '');
  assert.ok(missing.stderr.startsWith('accepts 1 arg, received 0\n'), missing.stderr);
  assert.ok(
    missing.stderr.includes('Usage:  exolvra-genesis standards <command> [flags]'),
    missing.stderr,
  );

  const unknown = runProcess(BIN, ['standards', 'lint'], {});
  assert.equal(unknown.code, 2);
  assert.equal(unknown.stdout, '');
  assert.ok(
    unknown.stderr.startsWith('invalid value "lint" for <command>: must be one of check, init\n'),
    unknown.stderr,
  );
});

test('an argument a leaf does not take is refused against the leaf usage line', () => {
  const dir = repo(VALID);
  const { code, stdout, stderr } = runProcess(
    BIN,
    ['standards', 'check', '-C', dir, 'standards.md'],
    {},
  );
  assert.equal(code, 2);
  assert.equal(stdout, '');
  // Not "accepts 1 arg, received 2": counting the subcommand back at a reader
  // under a usage line that shows no argument would explain nothing.
  assert.ok(stderr.startsWith('accepts no arguments, received 1\n'), stderr);
  assert.ok(stderr.includes('Usage:  exolvra-genesis standards check [flags]'), stderr);

  // And asking for help still wins over the stray argument, as it does at every
  // other boundary in this CLI.
  const help = runProcess(BIN, ['standards', 'check', 'stray', '--help'], {});
  assert.equal(help.code, 0, help.stderr);
  assert.equal(help.stdout, renderCommandHelp(checkCommand));
});

test('a bad flag value is refused before anything is read', () => {
  const dir = repo(VALID);
  const { code, stdout, stderr } = runProcess(
    BIN,
    ['standards', 'check', '-C', join(dir, 'no-such-directory')],
    {},
  );
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.ok(stderr.includes('invalid value'), stderr);
  assert.ok(stderr.includes('-C'), stderr);
  assert.ok(stderr.includes('Usage:  exolvra-genesis standards check [flags]'), stderr);
});

test('standards init without a terminal exits 2 rather than hanging on a question', () => {
  const dir = repo();
  const { code, stdout, stderr } = runProcess(BIN, ['standards', 'init', '-C', dir], {});
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.ok(stderr.includes('needs a terminal on both ends'), stderr);
  assert.equal(existsSync(standardsPath(dir)), false, 'a run with nobody to ask wrote a file');
});

/* -------------------------------------------------------------------------- */
/* standards init, driven through a terminal that is not one                   */
/* -------------------------------------------------------------------------- */

const DRIVER = `import { readFileSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));

const chunks = [];
const output = new PassThrough();
output.isTTY = true;
output.columns = plan.columns ?? 80;
output.rows = 24;
output.on('data', (chunk) => chunks.push(chunk.toString('utf8')));

const input = new PassThrough();
input.isTTY = true;
input.setRawMode = () => input;

const raw = () => chunks.join('');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A cursor, because the same question is asked again after a rejected answer:
// a search from the top would match the copy that has already been answered.
let cursor = 0;
async function waitFor(needle, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    const seen = stripVTControlCharacters(raw());
    const at = seen.indexOf(needle, cursor);
    if (at !== -1) {
      cursor = at + needle.length;
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting for ' + JSON.stringify(needle) + '\\n' + seen);
    }
    await sleep(10);
  }
}

Object.defineProperty(process, 'stdin', { value: input, configurable: true });

const { standardsCommand } = await import(plan.module);

const errors = [];
const ctx = {
  program: 'exolvra-genesis',
  cwd: plan.cwd,
  env: process.env,
  stdout: output,
  stderr: { write: (chunk) => errors.push(String(chunk)) },
  isTTY: true,
  isErrTTY: true,
  width: plan.columns ?? 80,
};

const typing = (async () => {
  for (const step of plan.script) {
    await waitFor(step.wait);
    await sleep(60);
    if (step.text !== undefined) {
      input.write(step.text);
      await waitFor(step.text.slice(0, 24));
      input.write('\\r');
    } else if (step.key !== '') {
      input.write(step.key);
    }
    await sleep(60);
  }
})();

let code;
let failure;
try {
  code = await standardsCommand.run(plan.argv, ctx);
} catch (error) {
  failure = { name: error?.name ?? 'Error', message: String(error?.message ?? error) };
  code = null;
}
await typing.catch((error) => {
  failure = failure ?? { name: 'driver', message: String(error?.message ?? error) };
});

writeFileSync(plan.out, JSON.stringify({ code, failure, raw: raw(), errors }, null, 2), 'utf8');
process.exit(0);
`;

const DRIVER_DIR = mkdtempSync(join(tmpdir(), 'exolvra-genesis-standards-driver-'));
TEMP.push(DRIVER_DIR);
const DRIVER_PATH = join(DRIVER_DIR, 'standards-driver.mjs');
writeFileSync(DRIVER_PATH, DRIVER, 'utf8');

const MODULE_URL = pathToFileURL(
  join(PACKAGE_ROOT, 'dist', 'commands', 'standards.js'),
).href;

/** Runs one scripted `standards init` and answers back what the terminal saw. */
function init({ cwd, script, argv = ['init'] }) {
  const plan = join(cwd, 'init-plan.json');
  const out = join(cwd, 'init-out.json');
  writeFileSync(
    plan,
    JSON.stringify({ argv, cwd, script, out, module: MODULE_URL, columns: 80 }, null, 2),
    'utf8',
  );

  const proc = spawnSync(process.execPath, [DRIVER_PATH, plan], {
    cwd: DRIVER_DIR,
    encoding: 'utf8',
  });
  assert.equal(proc.error, undefined, 'the driver failed to start');
  assert.ok(
    existsSync(out),
    'the driver wrote nothing:\n' + proc.stdout + proc.stderr,
  );
  const result = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(result.failure, undefined, 'the driver reported ' + JSON.stringify(result.failure));
  return { ...result, screen: () => screen(result.raw).join('\n') };
}

/** The answers that produce a complete file, in the order they are asked for. */
const ANSWERS = [
  { wait: 'What does this repo build', text: 'A CLI that runs judged build loops.' },
  { wait: 'Gate G1', text: 'The suite passes: `npm test`' },
  { wait: 'Add gate G2?', key: 'n' },
  { wait: 'Standing bar 1', text: 'bars/root-help.txt' },
  { wait: 'What is bars/root-help.txt?', text: 'the page help is judged against' },
  { wait: 'Add another standing bar entry?', key: 'n' },
  { wait: 'What should a builder here know', text: 'Commands self-register.' },
  // Conventions take paragraphs until an empty answer finishes them.
  { wait: 'Another paragraph?', key: ENTER },
];

test('init asks, shows the whole file, and writes it once it is approved', () => {
  const cwd = repo();
  const result = init({
    cwd,
    script: [...ANSWERS, { wait: 'Write it?', key: 'y' }],
  });

  assert.equal(result.code, 0, result.screen());
  const written = readFileSync(standardsPath(cwd), 'utf8');
  assert.deepEqual(validateStandards(written, { cwd }), [], written);

  const { standards } = parseStandards(written);
  assert.equal(standards.purpose, 'A CLI that runs judged build loops.');
  assert.deepEqual(standards.gates.map((gate) => gate.text), ['The suite passes: `npm test`']);
  assert.deepEqual(
    standards.standingBar.map((entry) => [entry.subject, entry.description]),
    [['bars/root-help.txt', 'the page help is judged against']],
  );
  assert.equal(standards.conventions, 'Commands self-register.');

  // The whole file was on screen before the question that wrote it, and the
  // frame opened and closed around the conversation.
  const shown = result.screen();
  assert.ok(shown.includes('exolvra-genesis standards init'), shown);
  assert.ok(shown.includes('This is ' + standardsPath(cwd) + ':'), shown);
  assert.ok(shown.includes('- G1. The suite passes: `npm test`'), shown);
  assert.ok(shown.includes('Standards written — ' + standardsPath(cwd)), shown);

  // And the file it wrote is one `standards check` accepts, off a real process.
  const check = runProcess(BIN, ['standards', 'check', '-C', cwd], {});
  assert.equal(check.code, 0, check.stderr);
});

test('init writes nothing when the file it showed is not approved', () => {
  const cwd = repo();
  const result = init({ cwd, script: [...ANSWERS, { wait: 'Write it?', key: 'n' }] });

  assert.equal(result.code, 1, result.screen());
  assert.equal(existsSync(standardsPath(cwd)), false, 'a declined file was written anyway');
  assert.ok(result.screen().includes('Nothing written'), result.screen());
});

test('an answer that is not checkable comes back with the reason, and the question again', () => {
  const cwd = repo();
  const result = init({
    cwd,
    script: [
      ANSWERS[0],
      { wait: 'Gate G1', text: 'The interface should be clean' },
      { wait: 'That gate is not checkable', key: '' },
      { wait: 'Gate G1', text: 'The suite passes: `npm test`' },
      ...ANSWERS.slice(2),
      { wait: 'Write it?', key: 'y' },
    ],
  });

  assert.equal(result.code, 0, result.screen());
  const shown = result.screen();
  assert.ok(shown.includes('"clean" is an adjective'), shown);
  const written = readFileSync(standardsPath(cwd), 'utf8');
  assert.ok(!written.includes('clean'), 'the refused answer reached the file: ' + written);
  assert.ok(written.includes('- G1. The suite passes: `npm test`'), written);
});

test('a standing bar artifact that does not resolve is refused at the question', () => {
  const cwd = repo();
  const result = init({
    cwd,
    script: [
      ANSWERS[0],
      ANSWERS[1],
      ANSWERS[2],
      { wait: 'Standing bar 1', text: 'bars/nobody-committed.png' },
      { wait: 'does not resolve', key: '' },
      { wait: 'Standing bar 1', text: 'bars/root-help.txt' },
      ...ANSWERS.slice(4),
      { wait: 'Write it?', key: 'y' },
    ],
  });

  assert.equal(result.code, 0, result.screen());
  const written = readFileSync(standardsPath(cwd), 'utf8');
  assert.ok(written.includes('`bars/root-help.txt`'), written);
  assert.ok(!written.includes('nobody-committed'), written);
});

test('the ignore pattern is offered when the whole state directory is ignored, and applied on a yes', () => {
  const cwd = repo();
  writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n.exolvra-genesis/\ndist/\n', 'utf8');

  const result = init({
    cwd,
    script: [
      ...ANSWERS,
      { wait: 'Write it?', key: 'y' },
      { wait: 'Make that change?', key: 'y' },
    ],
  });

  assert.equal(result.code, 0, result.screen());
  assert.equal(
    readFileSync(join(cwd, '.gitignore'), 'utf8'),
    ['node_modules/', ...IGNORE_PATTERN, 'dist/'].join('\n') + '\n',
  );
  assert.ok(result.screen().includes('!/.exolvra-genesis/standards.md'), result.screen());
});

test('the ignore pattern is not applied when it is declined, and the file still lands', () => {
  const cwd = repo();
  const before = 'node_modules/\n.exolvra-genesis/\ndist/\n';
  writeFileSync(join(cwd, '.gitignore'), before, 'utf8');

  const result = init({
    cwd,
    script: [
      ...ANSWERS,
      { wait: 'Write it?', key: 'y' },
      { wait: 'Make that change?', key: 'n' },
    ],
  });

  assert.equal(result.code, 0, result.screen());
  assert.equal(readFileSync(join(cwd, '.gitignore'), 'utf8'), before);
  assert.ok(existsSync(standardsPath(cwd)), 'declining the pattern lost the standards file');
  assert.ok(result.screen().includes('.gitignore left as it was'), result.screen());
});

test('a repo whose .gitignore already keeps standards tracked is not asked about it', () => {
  const cwd = repo();
  const before = 'node_modules/\n' + IGNORE_PATTERN.join('\n') + '\n';
  writeFileSync(join(cwd, '.gitignore'), before, 'utf8');

  const result = init({ cwd, script: [...ANSWERS, { wait: 'Write it?', key: 'y' }] });

  assert.equal(result.code, 0, result.screen());
  assert.equal(readFileSync(join(cwd, '.gitignore'), 'utf8'), before);
  assert.ok(
    !result.screen().includes('Make that change?'),
    'a repo already carrying the pattern was offered it again',
  );
});

/* -------------------------------------------------------------------------- */
/* The .gitignore edit is exactly the edit that was approved (C5, C7)          */
/* -------------------------------------------------------------------------- */

test('the plan names every blanket rule it touches, and touches nothing else', () => {
  // Two blanket rules, a comment, mixed line endings, and a blank line at the
  // end: everything the edit must leave exactly as it found it.
  const before =
    '# deps\r\n' + // 1
    'node_modules/\r\n' + // 2
    '.exolvra-genesis/\n' + // 3  <- replaced
    '# build\r\n' + // 4
    'dist/\n' + // 5
    '.exolvra-genesis/**\r\n' + // 6  <- removed
    '\r\n'; //                        7

  const edit = planIgnorePattern(before);
  assert.deepEqual(edit.replaced, [
    { number: 3, text: '.exolvra-genesis/' },
    { number: 6, text: '.exolvra-genesis/**' },
  ]);

  assert.equal(
    edit.text,
    '# deps\r\n' +
      'node_modules/\r\n' +
      IGNORE_PATTERN.join('\n') +
      '\n' +
      '# build\r\n' +
      'dist/\n' +
      '\r\n',
  );

  // Said another way, and this is the property that matters: put the touched
  // lines back and the file is the byte-for-byte original.
  assert.equal(
    edit.text.replace(IGNORE_PATTERN.join('\n') + '\n', '.exolvra-genesis/\n'),
    before.replace('.exolvra-genesis/**\r\n', ''),
  );
});

test('a line ending nowhere near the edit is not rewritten by it', () => {
  const before = 'a/\r\n.exolvra-genesis/\r\nb/\nc/\r\nd/';
  const after = planIgnorePattern(before).text;

  assert.ok(after.startsWith('a/\r\n'), 'the CRLF above the edit was rewritten: ' + JSON.stringify(after));
  assert.ok(after.endsWith('b/\nc/\r\nd/'), 'the tail was rewritten: ' + JSON.stringify(after));
  // Three CRLFs in the file to start with, and the one that ended the replaced
  // line becomes the three the replacement needs. Every other ending is the one
  // it always was.
  assert.equal((after.match(/\r\n/g) ?? []).length, 5, 'a line ending outside the edit moved');
  assert.equal((after.match(/(?<!\r)\n/g) ?? []).length, 1, 'an LF outside the edit moved');
  // The replacement inherits the ending of the line it replaced.
  assert.ok(after.includes(IGNORE_PATTERN.join('\r\n') + '\r\n'), after);
});

test('a file with no trailing newline still has none afterwards', () => {
  const after = planIgnorePattern('node_modules/\n.exolvra-genesis/').text;
  assert.equal(after, 'node_modules/\n' + IGNORE_PATTERN.join('\n'));
});

test('two blanket rules are both named in the question, and both handled', () => {
  const cwd = repo();
  const before = 'node_modules/\n.exolvra-genesis/\ndist/\n.exolvra-genesis/**\n\n';
  writeFileSync(join(cwd, '.gitignore'), before, 'utf8');

  const result = init({
    cwd,
    script: [...ANSWERS, { wait: 'Write it?', key: 'y' }, { wait: 'Make that change?', key: 'y' }],
  });
  assert.equal(result.code, 0, result.screen());

  // The question said what it would do to each line, before it did any of it.
  const drawn = result.screen();
  assert.ok(drawn.includes('the first of these 2 lines'), drawn);
  assert.ok(drawn.includes('The other one is removed'), drawn);
  assert.ok(drawn.includes('2  .exolvra-genesis/'), 'line 2 was never named:\n' + drawn);
  assert.ok(drawn.includes('4  .exolvra-genesis/**'), 'line 4 was never named:\n' + drawn);
  assert.ok(drawn.includes('line 2 replaced by the three lines above'), drawn);
  assert.ok(drawn.includes('line 4 removed'), drawn);

  // And did exactly that: the second rule gone, the blank line at the end kept.
  assert.equal(
    readFileSync(join(cwd, '.gitignore'), 'utf8'),
    'node_modules/\n' + IGNORE_PATTERN.join('\n') + '\ndist/\n\n',
  );
});

/* -------------------------------------------------------------------------- */
/* The heading                                                                 */
/* -------------------------------------------------------------------------- */

test('conventions take as many paragraphs as are offered, and land as prose', () => {
  /*
   * R1 calls this section free prose, and the parser reads a multi-paragraph
   * one back unchanged — the only thing that ever held it to one line was the
   * question. A terminal prompt takes one line, so the question is asked again
   * after each paragraph, and an empty answer finishes.
   */
  const cwd = repo();
  const paragraphs = [
    'Plain-text edits on source files, never regex splices across lines.',
    'Commands self-register from src/commands/, so adding one is adding a file.',
    'Model output is untrusted renderer input: flatten it before it is drawn.',
  ];

  const result = init({
    cwd,
    script: [
      ...ANSWERS.slice(0, -2),
      { wait: 'What should a builder here know', text: paragraphs[0] },
      { wait: 'Another paragraph?', text: paragraphs[1] },
      { wait: 'Another paragraph?', text: paragraphs[2] },
      { wait: 'Another paragraph?', key: ENTER },
      { wait: 'Write it?', key: 'y' },
    ],
  });
  assert.equal(result.code, 0, result.screen());

  const written = readFileSync(standardsPath(cwd), 'utf8');
  const { standards } = parseStandards(written);
  assert.deepEqual(
    standards.conventions.split('\n\n').map((line) => line.replace(/\n/g, ' ')),
    paragraphs,
    'three paragraphs did not land as three:\n' + written,
  );

  // It round-trips: the file this composed is a file the checker accepts.
  assert.deepEqual(validateStandards(written, { cwd }), [], written);
  // And the whole of it was on screen before the question that wrote it.
  const shown = result.screen();
  for (const paragraph of paragraphs) {
    assert.ok(
      shown.includes(paragraph.slice(0, 40)),
      'a paragraph was never shown before approval:\n' + shown,
    );
  }
  // The hint says what an empty answer does, where the person typing can read it.
  assert.ok(shown.includes('Enter on an empty answer finishes'), shown);
});

test('the composed file is headed for the repo it belongs to, not for nobody', () => {
  const cwd = repo();
  const result = init({ cwd, script: [...ANSWERS, { wait: 'Write it?', key: 'y' }] });

  assert.equal(result.code, 0, result.screen());
  const written = readFileSync(standardsPath(cwd), 'utf8');
  const expected = '# Standards for ' + basename(cwd);
  assert.equal(written.split('\n')[0], expected);
  assert.equal(parseStandards(written).standards.title, 'Standards for ' + basename(cwd));
  // And the reader saw the heading in the preview before approving it.
  assert.ok(result.screen().includes(expected), result.screen());
});

test('a directory with no name to give falls back to the plain heading', () => {
  assert.equal(titleFor('C:\\'.replace('C:\\', process.platform === 'win32' ? 'C:\\' : '/')), undefined);
  assert.equal(titleFor(join(tmpdir(), 'exolvra-genesis-title-demo')), 'Standards for exolvra-genesis-title-demo');
});

test('a standards file already there is replaced only when that is approved too', () => {
  const cwd = repo(VALID);
  const result = init({ cwd, script: [{ wait: 'Write a new one over it?', key: 'n' }] });

  assert.equal(result.code, 1, result.screen());
  assert.equal(readFileSync(standardsPath(cwd), 'utf8'), VALID, 'the existing file was touched');
  assert.ok(result.screen().includes('is as it was'), result.screen());
});
