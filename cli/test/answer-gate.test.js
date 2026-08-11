import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  PACKAGE_ROOT,
  REPO_ROOT,
  answerFile,
  createSandbox,
  planAnswer,
  run,
} from './run-cli.js';

/*
 * The answer boundary, exercised as behaviour.
 *
 * `validation-gate.test.js` probes everything going into the SDK. This is the
 * same gate on the way back: the answer an agent produces is untrusted input
 * too, and a session that completed is not the same thing as a preview that
 * produced a plan.
 *
 * Every exit code and every byte asserted below came off a real child process
 * running the built binary. The only substitution is the Claude Agent SDK,
 * which the bar allows: in its place each answer below is replayed verbatim,
 * so the CLI is handed exactly the bytes a provider would have handed it.
 */

const EVIDENCE = join(PACKAGE_ROOT, '.evidence');
mkdirSync(EVIDENCE, { recursive: true });

const WORK = mkdtempSync(join(tmpdir(), 'gauntlet-answer-'));
const sandbox = createSandbox();
after(() => {
  sandbox.cleanup();
  rmSync(WORK, { recursive: true, force: true });
});

const PLAN = {
  bar: 'The gh 2.88.1 transcripts captured in .gauntlet/bar/gh.',
  comparison: 'Run the binary, capture its output, put it beside the transcript.',
  artifacts: [{ path: '.gauntlet/bar/gh/root-help.txt', detail: 'gh --help' }],
  specs: [
    {
      id: 'P1',
      title: 'Foundation and the plan command',
      covers: 'C1, C3',
      files: 'cli/src/**',
      verify: 'cd cli && npm test',
    },
  ],
};

const GOAL = 'make it better';

let counter = 0;
function planWith(answer, args = [], env = {}) {
  counter += 1;
  const file = answerFile(WORK, 'answer-' + counter + '.md', answer);
  return sandbox.run(['plan', '--plugin-dir', REPO_ROOT, '-C', WORK, ...args, GOAL], {
    replay: file,
    cwd: WORK,
    env,
  });
}

/** Every run this file makes, kept so the exit-0 contract can be checked over all of them. */
const RUNS = [];

function record(label, args, result) {
  RUNS.push({ label, args, ...result });
  return result;
}

/* -------------------------------------------------------------------------- */
/* Answers that are not plans                                                  */
/* -------------------------------------------------------------------------- */

const fence = (body, tag = 'gauntlet-plan') => '```' + tag + '\n' + body + '\n```';

const UNUSABLE = [
  {
    label: 'an empty answer',
    answer: '',
    names: ['the preview produced no plan', 'without answering'],
  },
  {
    label: 'an answer of only whitespace',
    answer: '   \n\n\t  \n  ',
    names: ['without answering'],
  },
  {
    label: 'prose with no block at all',
    answer: 'I read the spec and captured the bar. The decomposition follows next.',
    names: ['carried no gauntlet-plan block', 'run it again'],
  },
  {
    label: 'the agent asking the user a question instead of planning',
    answer: [
      'I need more information before I can plan this.',
      '',
      'Please provide either:',
      '',
      '1. A path to a spec file describing what to build',
      '2. A concrete goal with a quality bar I can capture',
    ].join('\n'),
    names: ['carried no gauntlet-plan block'],
  },
  {
    label: 'a block that is not JSON',
    answer: fence('Bar: the gh transcripts\nSpecs: P1, P2'),
    names: ['not readable JSON'],
  },
  {
    label: 'a block cut off in the middle of the plan',
    answer: '```gauntlet-plan\n{ "bar": "the gh transcripts", "specs": [ { "id": "P1",',
    names: ['cut off before it ended', '--max-turns'],
  },
  {
    label: 'a closed block whose plan was cut off inside it',
    answer: fence('{ "bar": "the gh transcripts", "specs": [ { "id": "P1",'),
    names: ['cut off before it ended'],
  },
  {
    label: 'a block holding a JSON array',
    answer: fence('[1, 2, 3]'),
    names: ['held a JSON array, not an object'],
  },
  {
    label: 'a block holding a JSON string',
    answer: fence('"the plan is coming"'),
    names: ['held a JSON string, not an object'],
  },
  {
    label: 'a block holding null',
    answer: fence('null'),
    names: ['held null, not an object'],
  },
  {
    label: 'a plan with no bar',
    answer: fence(JSON.stringify({ ...PLAN, bar: '' })),
    names: ['missing required fields', 'missing: bar'],
  },
  {
    label: 'a plan with no task specs',
    answer: fence(JSON.stringify({ ...PLAN, specs: [] })),
    names: ['named no task specs'],
  },
  {
    label: 'a plan whose specs are a string',
    answer: fence(JSON.stringify({ ...PLAN, specs: 'P1, P2, P3' })),
    names: ['"specs" is a JSON string', 'not a list of task specs'],
  },
  {
    label: 'a plan whose specs are an object',
    answer: fence(JSON.stringify({ ...PLAN, specs: { P1: 'foundation' } })),
    names: ['"specs" is a JSON object'],
  },
  {
    label: 'a plan whose bar is an object',
    answer: fence(JSON.stringify({ ...PLAN, bar: { file: 'bar.png' } })),
    names: ['"bar" is a JSON object', 'not one line of text'],
  },
  {
    label: 'a spec that names no files and no verification command',
    answer: fence(JSON.stringify({ ...PLAN, specs: [{ id: 'P1', title: 'Foundation' }] })),
    names: ['missing required fields', 'specs[0].files', 'specs[0].verify'],
  },
  {
    label: 'a spec that is a bare string',
    answer: fence(JSON.stringify({ ...PLAN, specs: ['P1: foundation'] })),
    names: ['"specs[0]" is a JSON string', 'not a task spec object'],
  },
  {
    label: 'a bar artifact with no path',
    answer: fence(JSON.stringify({ ...PLAN, artifacts: [{ detail: 'the captured page' }] })),
    names: ['missing required fields', 'artifacts[0].path'],
  },
  {
    label: 'a json block carrying something else entirely',
    answer: fence(JSON.stringify({ status: 'ok', notes: ['captured the bar'] }), 'json'),
    names: ['missing required fields'],
  },
];

for (const entry of UNUSABLE) {
  test('an answer that is ' + entry.label + ' is not a win', () => {
    const result = record(entry.label, 'plan "' + GOAL + '"', planWith(entry.answer));
    const { code, stdout, stderr } = result;

    assert.notEqual(code, 0, entry.label + ' exited 0 without a plan');
    assert.equal(code, 1, entry.label + ' must exit 1, got ' + code + '\n' + stderr);
    assert.ok(stderr.trim().length > 0, entry.label + ' failed in silence');
    for (const needle of entry.names) {
      assert.ok(
        stderr.includes(needle),
        entry.label + ': stderr never names ' + JSON.stringify(needle) + '\n' + stderr,
      );
    }
    // Whatever is shown is laid out, never dumped: no raw JSON, no fences.
    assert.ok(!stdout.includes('```'), entry.label + ' put a fence on the terminal');
    assert.ok(!/^\s*[{[]/m.test(stdout), entry.label + ' dumped raw JSON:\n' + stdout);
    assert.ok(!stdout.includes('PREVIEW'), entry.label + ' framed a non-plan as a preview');
    // The complaint is one line plus indented detail, the shape gh uses.
    const lines = stderr.split('\n').filter((line) => line !== '');
    assert.match(lines[0], /^the preview produced no plan: \S/, entry.label);
    for (const line of lines.slice(1)) {
      assert.match(line, /^ {2}\S/, entry.label + ' detail line is not indented: ' + line);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Answers that are recovered rather than rejected                             */
/* -------------------------------------------------------------------------- */

/** The same plan every time, so what differs between the runs is the defect. */
const PRETTY = JSON.stringify(PLAN, null, 2);

const RECOVERED = [
  {
    label: 'a trailing comma before every closing bracket',
    answer: fence(PRETTY.replace(/(\n\s*)([}\]])/g, ',$1$2')),
  },
  {
    label: 'a // comment inside the plan',
    answer: fence(PRETTY.replace('{\n', '{\n  // the bar, captured in step 0\n')),
  },
  {
    label: 'a /* */ comment inside the plan',
    answer: fence(PRETTY.replace('  "specs"', '  /* one entry per piece */\n  "specs"')),
  },
  {
    label: 'a json fence instead of a gauntlet-plan fence',
    answer: 'Here is the preview.\n\n' + fence(JSON.stringify(PLAN, null, 2), 'json'),
  },
  {
    label: 'a JSON fence written in capitals',
    answer: fence(JSON.stringify(PLAN, null, 2), 'JSON'),
  },
  {
    label: 'an untagged fence',
    answer: fence(JSON.stringify(PLAN, null, 2), ''),
  },
  {
    label: 'no fence at all',
    answer: 'Here is the preview.\n\n' + JSON.stringify(PLAN, null, 2),
  },
  {
    label: 'a fence that was never closed',
    answer: '```gauntlet-plan\n' + JSON.stringify(PLAN, null, 2),
  },
  {
    label: 'a note written after the plan inside the block',
    answer: fence(JSON.stringify(PLAN, null, 2) + '\n\nThat is the decomposition.'),
  },
  {
    label: 'a plan whose covers are left empty',
    answer: fence(
      JSON.stringify({ ...PLAN, specs: PLAN.specs.map((s) => ({ ...s, covers: '' })) }),
    ),
  },
];

for (const entry of RECOVERED) {
  test('an answer carrying ' + entry.label + ' still renders a plan', () => {
    const { code, stdout, stderr } = record(
      entry.label,
      'plan "' + GOAL + '"',
      planWith(entry.answer),
    );

    assert.equal(code, 0, entry.label + ' must exit 0, got ' + code + '\n' + stderr);
    assert.equal(stderr, '', entry.label + ' repaired the answer noisily: ' + stderr);
    assert.ok(stdout.startsWith('GOAL\n'), entry.label + ' lost the frame:\n' + stdout);
    for (const heading of ['BAR', 'BAR ARTIFACTS', 'TASK SPECS']) {
      assert.ok(
        stdout.includes('\n' + heading + '\n'),
        entry.label + ' lost the ' + heading + ' section:\n' + stdout,
      );
    }
    assert.ok(stdout.includes(PLAN.specs[0].verify), entry.label + ' lost the plan content');
    assert.ok(!stdout.includes('```'), entry.label + ' put a fence on the terminal');
    assert.ok(!stdout.includes('"bar"'), entry.label + ' dumped raw JSON:\n' + stdout);
  });
}

test('a recovered answer says so when the transcript is being watched', () => {
  const { code, stderr } = record(
    'a repaired answer, --verbose',
    'plan --verbose "' + GOAL + '"',
    planWith(
      fence(JSON.stringify(PLAN, null, 2), 'json'),
      ['--verbose'],
    ),
  );
  assert.equal(code, 0);
  assert.match(stderr, /note: the plan arrived in a "json" block/);
});

test('every repair the reader can make is named, not applied in silence', () => {
  const answers = {
    'the plan arrived in an untagged block': fence(JSON.stringify(PLAN), ''),
    'the plan arrived with no block around it': JSON.stringify(PLAN),
    'the block was never closed': '```gauntlet-plan\n' + JSON.stringify(PLAN),
    'trailing commas in the plan block were dropped': fence(
      JSON.stringify(PLAN).replace(/}]}$/, '},]}'),
    ),
  };
  for (const [note, answer] of Object.entries(answers)) {
    const { code, stderr } = planWith(answer, ['--verbose']);
    assert.equal(code, 0, note + ' was not recovered: ' + stderr);
    assert.ok(stderr.includes('note: ' + note), note + ' was applied in silence: ' + stderr);
  }
});

/* -------------------------------------------------------------------------- */
/* The contract itself                                                         */
/* -------------------------------------------------------------------------- */

test('no invocation of the binary exits 0 having written nothing to stdout', () => {
  // Every run this file made, plus the surfaces that do not involve an answer
  // at all: help, version, help topics, a bad invocation, and a session that
  // ends in each way the SDK can end one.
  const extra = [
    ['--help'],
    ['--version'],
    [],
    ['plan', '--help'],
    ['help', 'exit-codes'],
    ['help', 'nope'],
    ['bogus-command'],
    ['plan'],
  ].map((args) => ({ label: args.join(' '), args: args.join(' '), ...run(args) }));

  const sessions = ['error_max_turns', 'error_during_execution', 'throw_midstream'].map(
    (subtype) => ({
      label: 'a session that ends in ' + subtype,
      args: 'plan "' + GOAL + '"',
      ...sandbox.run(['plan', '--plugin-dir', REPO_ROOT, GOAL], { subtype, cwd: WORK }),
    }),
  );

  const all = [...RUNS, ...extra, ...sessions];
  assert.ok(all.length >= 30, 'expected the whole surface, got ' + all.length);
  for (const outcome of all) {
    assert.ok(
      !(outcome.code === 0 && outcome.stdout === ''),
      outcome.label + ' exited 0 having printed nothing',
    );
    assert.ok([0, 1, 2].includes(outcome.code), outcome.label + ' exited ' + outcome.code);
  }
  // And the win is not vacuous: some of those runs did exit 0 with output.
  assert.ok(
    all.some((outcome) => outcome.code === 0 && outcome.stdout.length > 0),
    'nothing in the matrix succeeded, so the contract proved nothing',
  );
});

test('a plan that arrives after the session broke is printed, and still exit 1', () => {
  const { code, stdout, stderr } = sandbox.run(
    ['plan', '--plugin-dir', REPO_ROOT, '-C', WORK, GOAL],
    {
      subtype: 'error_max_turns',
      replay: answerFile(WORK, 'late-plan.md', planAnswer(PLAN)),
      cwd: WORK,
    },
  );
  // error_max_turns carries no result text, so the answer is not read at all;
  // what matters is that the unfinished run is never reported as a win.
  assert.equal(code, 1, 'an unfinished run must exit 1: ' + stderr);
  assert.match(stderr, /the preview did not finish/);
  assert.ok(!stdout.includes('```'));
});

/* -------------------------------------------------------------------------- */
/* Evidence                                                                    */
/* -------------------------------------------------------------------------- */

test('the answer-gate transcript is the process output, byte for byte', () => {
  const out = [
    'gauntlet plan, fed answers a prompt cannot rule out.',
    '',
    'Each block below is one run of the built binary as a child process, with',
    'the Claude Agent SDK replaced by a replay of the answer shown. EXIT, STDOUT',
    'and STDERR are that process’s own, verbatim, produced by',
    'test/answer-gate.test.js.',
    '',
    'The contract under test: a session that completes without producing a',
    'renderable plan is not a win, and nothing exits 0 having printed nothing.',
    '',
  ];

  const show = (title, entries) => {
    out.push('#'.repeat(72), '# ' + title, '#'.repeat(72), '');
    for (const { label, answer } of entries) {
      const { code, stdout, stderr } = planWith(answer);
      out.push(
        '='.repeat(72),
        '$ gauntlet plan "' + GOAL + '"   # ' + label,
        '='.repeat(72),
        '',
        '--- the answer the SDK was replaced with ---',
        answer === '' ? '(nothing)' : answer,
        '',
        '--- EXIT ---',
        String(code),
        '',
        '--- STDOUT (' + Buffer.byteLength(stdout) + ' bytes) ---',
        stdout === '' ? '(nothing)' : stdout.replace(/\n$/, ''),
        '',
        '--- STDERR (' + Buffer.byteLength(stderr) + ' bytes) ---',
        stderr === '' ? '(nothing)' : stderr.replace(/\n$/, ''),
        '',
      );
      assert.ok(
        !(code === 0 && stdout === ''),
        label + ' exited 0 having printed nothing',
      );
    }
  };

  show('Answers that are not plans: exit 1, and a message that names why', UNUSABLE);
  show('Answers recovered deliberately: exit 0, and the plan', RECOVERED);

  const file = join(EVIDENCE, 'plan-answer-gate.txt');
  writeFileSync(file, out.join('\n'), 'utf8');

  // The file holds process output, not a summary of it.
  const written = readFileSync(file, 'utf8');
  const again = planWith(UNUSABLE[3].answer);
  assert.ok(written.includes(again.stderr.trim()), 'the transcript was not recorded verbatim');
  assert.ok(written.includes('--- EXIT ---\n1\n'));
  assert.ok(written.includes('--- EXIT ---\n0\n'));
});
