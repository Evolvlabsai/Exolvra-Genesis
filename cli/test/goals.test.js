import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { UsageError } from '../dist/exit.js';
import {
  findGoal,
  goalDescription,
  goalFileText,
  goalNameFault,
  goalPath,
  goalsDir,
  listGoals,
  newGoalNameFault,
  readProposal,
  restatesName,
  writeGoal,
} from '../dist/goals.js';
import {
  declaredGates,
  inputAsArgument,
  inputAsTyped,
  resolveInput,
} from '../dist/input.js';
import { asJson, firstPositionalIndex, goalsCommand, renderGoals } from '../dist/commands/goals.js';
import {
  BIN,
  PACKAGE_ROOT,
  REPO_ROOT,
  answerFile,
  createSandbox,
  planAnswer,
  runProcess,
} from './run-cli.js';
import { frames, screen } from './tty.js';

/*
 * `exolvra-genesis goals`, and the widened input resolution behind it.
 *
 * Everything about the listing, the errors and the exit codes is measured off a
 * real child process running the built `dist/`. The one thing stood in for is
 * the Claude Agent SDK, at the seam `src/session.ts` already has for it, and the
 * terminal — because writing a goal is a conversation, and a spawned process is
 * given pipes.
 */

const TEMP = [];

/**
 * A packed copy of the built CLI beside a scripted transport, for the two
 * commands that resolve an input and then go on to run: the SDK is the only
 * thing substituted, and the binary is the one the package ships.
 */
const planSandbox = createSandbox();

function workspace(prefix = 'exolvra-genesis-goals-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP.push(dir);
  return dir;
}

/** Writes `<cwd>/.exolvra-genesis/goals/<name>.md` and returns its path. */
function seedGoal(cwd, name, text) {
  const dir = goalsDir(cwd);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name + '.md');
  writeFileSync(path, text, 'utf8');
  return path;
}

/** A standards file in the R1 shape, with the gates a test wants in it. */
function seedStandards(cwd, gates) {
  const dir = join(cwd, '.exolvra-genesis');
  mkdirSync(dir, { recursive: true });
  // The standing bar names an artifact, and a standing bar artifact has to
  // resolve, so the file it names is really there.
  mkdirSync(join(cwd, 'docs', 'bar'), { recursive: true });
  writeFileSync(join(cwd, 'docs', 'bar', 'list-output.txt'), 'name\tdescription\n', 'utf8');
  const path = join(dir, 'standards.md');
  writeFileSync(
    path,
    [
      '# Standards for this repository',
      '',
      'The standing quality bar every run in this repository inherits.',
      '',
      '## Gates',
      '',
      ...gates.map((gate) => '- ' + gate),
      '',
      '## Standing bar',
      '',
      '- `docs/bar/list-output.txt` — what every listing is judged against.',
      '',
      '## Conventions',
      '',
      'Small commits, no dead code, and the suite green before anything ships.',
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

/** Runs the built binary as a real process, from `cwd`. */
function cli(args, { cwd = PACKAGE_ROOT, env = {} } = {}) {
  return runProcess(BIN, args, { cwd, env });
}

/** The same, laid out as a terminal would show it. */
function ttyCli(args, options = {}) {
  return cli(args, {
    ...options,
    env: { EXOLVRA_GENESIS_FORCE_TTY: '80', ...(options.env ?? {}) },
  });
}

const ESC = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const RLO = String.fromCharCode(0x202e);

/* -------------------------------------------------------------------------- */
/* Names                                                                       */
/* -------------------------------------------------------------------------- */

test('a goal name is a file name, and never a path', () => {
  for (const name of ['release-notes', 'a', 'v1.2', 'Release_Notes', 'x-1_2.3']) {
    assert.equal(goalNameFault(name), undefined, name + ' must be a usable goal name');
  }
  for (const name of [
    '',
    '..',
    '../escape',
    'a/b',
    'a\\b',
    'C:notes',
    '.hidden',
    'trailing.',
    'has space',
    'ansi' + ESC + '[31m',
    'x'.repeat(65),
  ]) {
    assert.notEqual(goalNameFault(name), undefined, JSON.stringify(name) + ' was accepted');
  }
});

test('a name that is really a path can never be joined into one', () => {
  const cwd = workspace();
  // Every rejected name is refused before a path is built from it, so the
  // traversal never has a chance to be attempted.
  for (const name of ['../../etc/passwd', 'a/b', '..']) {
    assert.equal(findGoal(cwd, name), undefined);
  }
  assert.equal(goalPath(cwd, 'release-notes'), join(goalsDir(cwd), 'release-notes.md'));
});

test('a new goal is named as a slug, and never as a reserved device', () => {
  for (const name of ['release-notes', 'ship_it', 'v2', 'a1-b2_c3']) {
    assert.equal(newGoalNameFault(name), undefined, name + ' must be a usable new name');
  }
  for (const name of ['Release-Notes', 'v1.2', '-leading', 'trailing-', 'con', 'LPT1', 'a..b']) {
    assert.notEqual(newGoalNameFault(name), undefined, name + ' was accepted for creation');
  }
});

/* -------------------------------------------------------------------------- */
/* What a listing says about a file                                            */
/* -------------------------------------------------------------------------- */

test('the description is the file heading, then its first prose, then nothing', () => {
  assert.equal(goalDescription('# Release notes from a changelog\n\nBody.\n'), 'Release notes from a changelog');
  assert.equal(goalDescription('\n\n### Ship it ###\n'), 'Ship it');
  assert.equal(goalDescription('Just prose, no heading.\n\n# Later heading\n'), 'Just prose, no heading.');
  assert.equal(
    goalDescription('---\ntitle: fields are not a summary\n---\n\n# The real one\n'),
    'The real one',
  );
  assert.equal(goalDescription(''), '');
  assert.equal(goalDescription('\n\n   \n'), '');
});

test('listGoals reads names and descriptions, sorted, ignoring what is not a goal', () => {
  const cwd = workspace();
  assert.deepEqual(listGoals(cwd), [], 'a repository with no goals directory lists nothing');

  seedGoal(cwd, 'release-notes', '# Turn a changelog into release notes\n');
  seedGoal(cwd, 'audit', '# Audit the dependency tree\n');
  seedGoal(cwd, 'bare', 'no heading here\n');
  writeFileSync(join(goalsDir(cwd), 'notes.txt'), 'not a goal\n', 'utf8');
  writeFileSync(join(goalsDir(cwd), 'has space.md'), '# unusable name\n', 'utf8');
  mkdirSync(join(goalsDir(cwd), 'nested.md'), { recursive: true });

  const goals = listGoals(cwd);
  assert.deepEqual(
    goals.map((goal) => goal.name),
    ['audit', 'bare', 'release-notes'],
  );
  assert.equal(goals[0].description, 'Audit the dependency tree');
  assert.equal(goals[1].description, 'no heading here');
  assert.equal(goals[0].path, join(goalsDir(cwd), 'audit.md'));
});

test('a heading that only says the file name again is no description at all', () => {
  const cwd = workspace();
  seedGoal(cwd, 'release-notes', '# Release notes\n');
  seedGoal(cwd, 'audit_deps', '# audit-deps\n');
  seedGoal(cwd, 'ship-it', '# Ship it, and say what shipped\n');

  const byName = Object.fromEntries(listGoals(cwd).map((goal) => [goal.name, goal.description]));
  assert.equal(byName['release-notes'], '', 'a heading restating the name became a column');
  assert.equal(byName['audit_deps'], '', 'punctuation is not a difference between two names');
  assert.equal(byName['ship-it'], 'Ship it, and say what shipped');

  assert.equal(restatesName('release-notes', 'Release Notes'), true);
  assert.equal(restatesName('release-notes', 'Release notes, weekly'), false);
});

test('findGoal answers only for a file that is really there', () => {
  const cwd = workspace();
  assert.equal(findGoal(cwd, 'release-notes'), undefined);
  const path = seedGoal(cwd, 'release-notes', '# Release notes\n');
  assert.equal(findGoal(cwd, 'release-notes'), path);
  assert.equal(findGoal(cwd, 'release-notes.md'), undefined, 'the extension is not part of the name');
});

/* -------------------------------------------------------------------------- */
/* Writing one                                                                 */
/* -------------------------------------------------------------------------- */

test('an approved goal is written whole, with one trailing newline', () => {
  const cwd = workspace();
  const path = writeGoal(cwd, 'release-notes', '# Release notes\r\n\r\nR1. Do the thing.\r\n\n\n');
  assert.equal(path, goalPath(cwd, 'release-notes'));
  assert.equal(readFileSync(path, 'utf8'), '# Release notes\n\nR1. Do the thing.\n');
  assert.equal(goalFileText('one line'), 'one line\n');
});

test('writing never replaces a goal that is already there', () => {
  const cwd = workspace();
  seedGoal(cwd, 'release-notes', '# The committed one\n');
  assert.throws(() => writeGoal(cwd, 'release-notes', '# The new one\n'), {
    name: 'ConfigError',
  });
  assert.match(readFileSync(goalPath(cwd, 'release-notes'), 'utf8'), /The committed one/);
});

test('writing refuses a name it would not have created', () => {
  const cwd = workspace();
  assert.throws(() => writeGoal(cwd, '../escape', '# nope\n'), { name: 'ConfigError' });
  assert.throws(() => writeGoal(cwd, 'Not-A-Slug', '# nope\n'), { name: 'ConfigError' });
});

/* -------------------------------------------------------------------------- */
/* The scaffold's reporting shape                                              */
/* -------------------------------------------------------------------------- */

test('a proposal is read out from between its delimiters, prose and all', () => {
  const said = readProposal(
    [
      'Here is the goal as it stands.',
      '@exolvra-genesis goal-begin',
      '# Release notes',
      '',
      '```sh',
      'npm test',
      '```',
      '@exolvra-genesis goal-end',
      'Say the word and I will change it.',
    ].join('\n'),
  );
  assert.equal(said.proposal, '# Release notes\n\n```sh\nnpm test\n```');
  assert.equal(said.rest, 'Here is the goal as it stands.\nSay the word and I will change it.');
});

test('a fence wrapped around the whole proposal is habit, not content', () => {
  const said = readProposal(
    ['@exolvra-genesis goal-begin', '```markdown', '# Release notes', '```', '@exolvra-genesis goal-end'].join('\n'),
  );
  assert.equal(said.proposal, '# Release notes');
});

test('half a proposal is not a proposal', () => {
  const said = readProposal(['Still working on it.', '@exolvra-genesis goal-begin', '# Half'].join('\n'));
  assert.equal(said.proposal, undefined);
  assert.match(said.rest, /Still working on it\./);
  assert.match(said.rest, /# Half/);
});

test('a turn with no markers is all prose', () => {
  const said = readProposal('What should the goal be called?');
  assert.equal(said.proposal, undefined);
  assert.equal(said.rest, 'What should the goal be called?');
});

/* -------------------------------------------------------------------------- */
/* R6: the resolution matrix                                                   */
/* -------------------------------------------------------------------------- */

test('R6: a path to an existing file is a spec', () => {
  const cwd = workspace();
  writeFileSync(join(cwd, 'spec.md'), '# A spec\n', 'utf8');
  const input = resolveInput('spec.md', cwd);
  assert.equal(input.kind, 'spec');
  assert.equal(input.path, join(cwd, 'spec.md'));
  assert.equal(input.given, 'spec.md');
  assert.equal(input.goalName, undefined);
});

test('R6: a bare token naming a goal is that goal', () => {
  const cwd = workspace();
  const path = seedGoal(cwd, 'release-notes', '# Release notes\n\nR1. Ship them.\n');
  const input = resolveInput('release-notes', cwd);
  assert.equal(input.kind, 'spec', 'a named goal is a spec, in the same format');
  assert.equal(input.path, path);
  assert.equal(input.given, 'release-notes');
  assert.equal(input.goalName, 'release-notes');
  assert.match(input.text, /R1\. Ship them\./);

  // The agent is handed the file; the reader is handed the name they typed.
  assert.equal(inputAsArgument(input), path);
  assert.equal(inputAsTyped(input), 'release-notes');
});

test('R6: anything else is an inline goal, including a name with no file', () => {
  const cwd = workspace();
  seedGoal(cwd, 'release-notes', '# Release notes\n');
  for (const arg of [
    'a CLI indistinguishable from gh',
    'refactor',
    'release_notes',
    'goals/release-notes',
    '../release-notes',
    'src/app.tsx',
  ]) {
    const input = resolveInput(arg, cwd);
    assert.equal(input.kind, 'goal', arg + ' must resolve to a goal');
    assert.equal(input.goal, arg, arg + ' must survive as typed');
  }
});

test('R6: a token that is both a file and a goal is refused, naming both', () => {
  const cwd = workspace();
  const goal = seedGoal(cwd, 'release-notes', '# The goal\n');
  const file = join(cwd, 'release-notes');
  writeFileSync(file, '# The file\n', 'utf8');

  let error;
  try {
    resolveInput('release-notes', cwd, 'exolvra-genesis run <goal-or-spec-path>');
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof UsageError, 'an ambiguous token must be a usage error');
  assert.match(error.message, /ambiguous argument "release-notes"/);
  assert.ok(error.message.includes(file), 'the file candidate is not named');
  assert.ok(error.message.includes(goal), 'the goal candidate is not named');
  assert.match(error.message, /an existing path is read first/);
  assert.match(error.message, /write \.\/release-notes for the file/);
  assert.ok(
    error.message.includes('.exolvra-genesis/goals/release-notes.md for the goal'),
    'the spelling that picks the goal is not given: ' + error.message,
  );
  assert.equal(error.usage, 'exolvra-genesis run <goal-or-spec-path>');
});

test('R6: each spelling the refusal offers resolves to the one it names', () => {
  const cwd = workspace();
  const goal = seedGoal(cwd, 'release-notes', '# The goal\n');
  const file = join(cwd, 'release-notes');
  writeFileSync(file, '# The file\n', 'utf8');

  const asFile = resolveInput('./release-notes', cwd);
  assert.equal(asFile.kind, 'spec');
  assert.equal(asFile.path, file);
  assert.equal(asFile.goalName, undefined);

  const asGoal = resolveInput('.exolvra-genesis/goals/release-notes.md', cwd);
  assert.equal(asGoal.kind, 'spec');
  assert.equal(asGoal.path, goal);
});

test('R6: a directory named like a goal is still not a file, so nothing is ambiguous', () => {
  const cwd = workspace();
  seedGoal(cwd, 'release-notes', '# The goal\n');
  mkdirSync(join(cwd, 'release-notes'));
  const input = resolveInput('release-notes', cwd);
  assert.equal(input.kind, 'spec');
  assert.equal(input.goalName, 'release-notes');
});

test('R6: resolution follows the directory it is given, not the process cwd', () => {
  const here = workspace();
  const elsewhere = workspace();
  seedGoal(here, 'release-notes', '# Here\n');
  assert.equal(resolveInput('release-notes', here).kind, 'spec');
  assert.equal(resolveInput('release-notes', elsewhere).kind, 'goal');
});

/* -------------------------------------------------------------------------- */
/* C4: a run may add gates, and never drop or weaken one                       */
/* -------------------------------------------------------------------------- */

const STANDING = [
  'G1. Every public function has a test that fails without it.',
  'G2. The full suite is green before anything is reported as done.',
  'G3. No new runtime dependencies.',
];

/** A spec file in `cwd`, with the gate lines a test wants in it. */
function seedSpec(cwd, name, gates) {
  const path = join(cwd, name);
  writeFileSync(
    path,
    ['# A spec', '', 'One paragraph of purpose.', '', '## Gates', '', ...gates.map((gate) => '- ' + gate), ''].join('\n'),
    'utf8',
  );
  return path;
}

test('C4: an input that declares no gates inherits every standing one', () => {
  const cwd = workspace();
  seedStandards(cwd, STANDING);
  writeFileSync(join(cwd, 'spec.md'), '# A spec\n\nR1. Do the thing.\n', 'utf8');
  assert.equal(resolveInput('spec.md', cwd).kind, 'spec');
  assert.equal(resolveInput('a one-line goal', cwd).kind, 'goal');
});

test('C4: an input that only adds gates is free to', () => {
  // A run may add (C4), and inheritance is automatic (R2): a spec that writes
  // gates the standards do not number has added to the merge the lead performs,
  // and nothing about the standing gates has been said at all.
  const cwd = workspace();
  seedStandards(cwd, STANDING);
  seedSpec(cwd, 'spec.md', ['G8. The page loads in under a second.']);
  assert.equal(resolveInput('spec.md', cwd).kind, 'spec');

  seedSpec(cwd, 'both.md', [...STANDING, 'G8. The page loads in under a second.']);
  assert.equal(resolveInput('both.md', cwd).kind, 'spec', 'restating them and adding one was refused');
});

test('C4: an input that restates the standing gates verbatim is accepted', () => {
  const cwd = workspace();
  seedStandards(cwd, STANDING);
  seedSpec(cwd, 'spec.md', [...STANDING, 'G8. The page loads in under a second.']);
  assert.equal(resolveInput('spec.md', cwd).kind, 'spec');
});

test('C4: reusing some standing ids and omitting others is exit 2, naming the omitted', () => {
  // partial-G1-verbatim-G2-omitted: the input writes the standards' own
  // numbering, so it is writing about the standing gates — and it left one out.
  const cwd = workspace();
  seedStandards(cwd, STANDING);
  seedSpec(cwd, 'partial-G1-verbatim-G2-omitted.md', [STANDING[0], STANDING[2]]);

  let error;
  try {
    resolveInput(
      'partial-G1-verbatim-G2-omitted.md',
      cwd,
      'exolvra-genesis run <goal-or-spec-path>',
    );
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof UsageError, 'a dropped gate must be a usage error');
  assert.match(error.message, /partial-G1-verbatim-G2-omitted\.md drops G2/);
  assert.match(error.message, /G2\. The full suite is green/);
  assert.match(error.message, /\.exolvra-genesis\/standards\.md/);
  // The message describes only what it fired on: the ids this input reused.
  assert.match(error.message, /it restates G1 and G3 under the standards' own numbering/);
  assert.match(error.message, /a run may add\s+gates and never drop one/);
  assert.match(error.message, /restate G2 as well, or take the restatements out/);
});

test('C4: reusing a standing id in other words is exit 2, naming the gate', () => {
  // weak-reusing-G1-reworded: every id is there, and one of them no longer
  // says what the repo says it says.
  const cwd = workspace();
  seedStandards(cwd, STANDING);
  seedSpec(cwd, 'weak-reusing-G1-reworded.md', [
    'G1. Most public functions have a test.',
    STANDING[1],
    STANDING[2],
  ]);

  let error;
  try {
    resolveInput('weak-reusing-G1-reworded.md', cwd);
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof UsageError, 'a reworded gate must be a usage error');
  assert.match(error.message, /restates G1 in different words/);
  assert.match(error.message, /standards\s+G1\. Every public function has a test/);
  assert.match(error.message, /this input\s+G1\. Most public functions have a test\./);
});

test('C4: the gate a named goal drops is named as the goal it came from', () => {
  const cwd = workspace();
  seedStandards(cwd, STANDING);
  seedGoal(
    cwd,
    'release-notes',
    ['# Release notes', '', '## Gates', '', '- ' + STANDING[0], '- ' + STANDING[1], ''].join('\n'),
  );
  assert.throws(() => resolveInput('release-notes', cwd), (error) => {
    assert.ok(error instanceof UsageError);
    assert.match(error.message, /the goal "release-notes" drops G3/);
    return true;
  });
});

/* -------------------------------------------------------------------------- */
/* C4: what the check must never fire on                                       */
/* -------------------------------------------------------------------------- */

/*
 * Every one of these is purely additive.
 *
 * A run inherits the standing gates automatically (R2) and may add gates of
 * its own (C4); the merge of the two is written in commands/run.md and done
 * there with judgement (C6). So an input that never writes one of the
 * standards' own ids has said nothing about the standing gates, whatever else
 * it declares and however it numbers it. Reading such a list as *replacing*
 * the standing one is precedence logic, and precedence is the lead's.
 *
 * These are the shapes that were refused when this check reached too far, and
 * each is here so that reach cannot come back.
 */

/** A goal file in the shape `goals new` itself authors. */
const AUTHORED_GOAL = [
  '# Audit the dependency tree every week',
  '',
  'A standing weekly job: read every package the repo declares and report the',
  'ones nothing imports.',
  '',
  '## Constraints (hard gates)',
  '',
  '- C1. The report names every package in package.json exactly once.',
  '- C2. The audit runs with no network access.',
  '',
  '## Requirements',
  '',
  'R1. Write audit/unused.md, newest run first.',
  '',
].join('\n');

const ADDITIVE = {
  'addonly.md': [
    '# A spec that adds gates of its own',
    '',
    'One paragraph of purpose.',
    '',
    '## Constraints (hard gates)',
    '',
    '- C1. The page loads in under a second on a cold cache.',
    '- C2. No new runtime dependencies beyond the ones already declared.',
    '',
  ].join('\n'),

  'plainconstraints.md': [
    '# A spec whose constraints are prose',
    '',
    'One paragraph of purpose.',
    '',
    '## Constraints',
    '',
    'Everything ships behind a flag, and nothing reaches the provider unvalidated.',
    '',
  ].join('\n'),

  'oneC.md': [
    '# A spec with one lone constraint bullet',
    '',
    'One paragraph of purpose.',
    '',
    '## Requirements',
    '',
    'R1. Read CHANGELOG.md.',
    '- C1: the changelog is never rewritten, only appended to.',
    '',
  ].join('\n'),

  'gatetitle.md': [
    '# A goal with no gate list',
    '',
    'One paragraph. The gates are somewhere else entirely.',
    '',
    '## Requirements',
    '',
    'R1. Do the thing.',
    '',
  ].join('\n'),

  'requirements.md': [
    '# An ordinary spec',
    '',
    'One paragraph of purpose.',
    '',
    '## Requirements',
    '',
    'R1. Read CHANGELOG.md.',
    'R2. Write RELEASE.md.',
    '',
  ].join('\n'),

  'nosection.md': '# A spec with nothing but prose\n\nMake the thing work.\n',

  'authored-goal.md': AUTHORED_GOAL,
};

test('C4: an additive input passes to the merge untouched, however it is written', () => {
  const cwd = workspace();
  seedStandards(cwd, STANDING);
  for (const [name, text] of Object.entries(ADDITIVE)) {
    writeFileSync(join(cwd, name), text, 'utf8');
    const input = resolveInput(name, cwd);
    assert.equal(input.kind, 'spec', name + ' was refused, and it adds nothing');
  }
});

test('C4: this repo own specs, unchanged, run in a repo that declares standards', () => {
  // Not a fixture in their shape — the files themselves, both read-only under
  // their own hash gates. They are the two real documents this check was
  // measured against, and neither writes one of the standards' ids.
  const cwd = workspace();
  seedStandards(cwd, STANDING);

  for (const source of [
    join(REPO_ROOT, 'docs', 'specs', 'repo-standards-spec.md'),
    join(PACKAGE_ROOT, 'cli-spec.md'),
  ]) {
    assert.ok(existsSync(source), 'the spec under test is not there: ' + source);
    const name = 'copy-of-' + source.split(/[\\/]/).pop();
    writeFileSync(join(cwd, name), readFileSync(source, 'utf8'), 'utf8');
    assert.equal(
      resolveInput(name, cwd).kind,
      'spec',
      source + ' was refused, and it is purely additive',
    );
  }
});

test('C4: an inline goal that mentions constraints is still just a goal', () => {
  const cwd = workspace();
  seedStandards(cwd, STANDING);
  assert.equal(resolveInput('tighten the constraints on the parser', cwd).kind, 'goal');
  assert.equal(resolveInput('add a gate for bundle size', cwd).kind, 'goal');
});

test('C2: with no standards file, none of this logic runs at all', () => {
  // The same two inputs that are refused above, in a repo that declares
  // nothing: there is no standing gate to drop, so there is nothing to check
  // and nothing to say about it.
  const cwd = workspace();
  seedSpec(cwd, 'partial-G1-verbatim-G2-omitted.md', [STANDING[0], STANDING[2]]);
  seedSpec(cwd, 'weak-reusing-G1-reworded.md', [
    'G1. Most public functions have a test.',
    STANDING[1],
    STANDING[2],
  ]);
  writeFileSync(join(cwd, 'authored-goal.md'), AUTHORED_GOAL, 'utf8');

  for (const name of [
    'partial-G1-verbatim-G2-omitted.md',
    'weak-reusing-G1-reworded.md',
    'authored-goal.md',
  ]) {
    assert.equal(resolveInput(name, cwd).kind, 'spec', name + ' was refused with no standards');
  }
});

test('declaredGates reads ids and joins a wrapped line, and reads nothing else', () => {
  const gates = declaredGates(
    [
      '## Gates',
      '',
      '- G1. Every public function has a test',
      '  that fails without it.',
      '- G2. No new runtime dependencies.',
      '',
      'Prose that mentions G3 in passing is not a declaration.',
      'G10) A closing paren declares one too.',
    ].join('\n'),
  );
  assert.deepEqual([...gates.keys()], ['G1', 'G2', 'G10']);
  assert.equal(gates.get('G1'), 'Every public function has a test that fails without it.');
  assert.equal(gates.get('G2'), 'No new runtime dependencies.');
  assert.equal(gates.get('G10'), 'A closing paren declares one too.');
});

/* -------------------------------------------------------------------------- */
/* The listing, off a real process                                             */
/* -------------------------------------------------------------------------- */

test('R5: an empty repository lists nothing on stdout, says so on stderr, and exits 0', () => {
  const cwd = workspace();
  const { code, stdout, stderr } = cli(['goals', '-C', cwd]);
  assert.equal(code, 0, 'listing no goals is a complete answer: ' + stderr);
  assert.equal(stdout, '', 'an empty listing is empty, not a sentence');
  assert.equal(stderr, 'no goals found in ' + goalsDir(cwd) + '\n');
});

test('R5: a populated repository lists name and description, one record per line', () => {
  const cwd = workspace();
  seedGoal(cwd, 'release-notes', '# Turn a changelog into release notes\n');
  seedGoal(cwd, 'audit', '# Audit the dependency tree\n');
  seedGoal(cwd, 'bare', '');

  const piped = cli(['goals', '-C', cwd]);
  assert.equal(piped.code, 0, piped.stderr);
  assert.equal(piped.stderr, '');
  const rows = piped.stdout.trimEnd().split('\n');
  assert.deepEqual(rows, [
    'audit\tAudit the dependency tree',
    'bare\t-',
    'release-notes\tTurn a changelog into release notes',
  ]);

  const terminal = ttyCli(['goals', '-C', cwd]);
  assert.equal(terminal.code, 0, terminal.stderr);
  const lines = terminal.stdout.trimEnd().split('\n');
  assert.equal(lines[0], 'NAME' + ' '.repeat(11) + 'DESCRIPTION');
  assert.match(lines[1], /^audit {10}Audit the dependency tree$/);
  assert.ok(lines.every((line) => line.length <= 80), 'a row was drawn past the right edge');
});

test('R5: --json writes the records themselves, every field on every record', () => {
  const cwd = workspace();
  seedGoal(cwd, 'release-notes', '# Turn a changelog into release notes\n');
  seedGoal(cwd, 'bare', '');

  const piped = cli(['goals', '-C', cwd, '--json']);
  assert.equal(piped.code, 0, piped.stderr);
  assert.equal(piped.stdout.trimEnd().split('\n').length, 1, '--json down a pipe is one line');
  const records = JSON.parse(piped.stdout);
  assert.deepEqual(records, [
    { description: null, name: 'bare', path: goalPath(cwd, 'bare') },
    {
      description: 'Turn a changelog into release notes',
      name: 'release-notes',
      path: goalPath(cwd, 'release-notes'),
    },
  ]);
  assert.deepEqual(Object.keys(records[0]), ['description', 'name', 'path']);

  const empty = cli(['goals', '-C', workspace(), '--json']);
  assert.equal(empty.code, 0);
  assert.deepEqual(JSON.parse(empty.stdout), []);

  const terminal = ttyCli(['goals', '-C', cwd, '--json']);
  assert.ok(terminal.stdout.includes('\n  {'), '--json on a terminal is indented');
});

test('a goal named with an escape sequence cannot repaint the table', () => {
  const cwd = workspace();
  seedGoal(
    cwd,
    'hostile',
    '# ' + ESC + '[31mred' + ESC + '[0m\tone' + BELL + RLO + 'two\n\nBody.\n',
  );
  seedGoal(cwd, 'plain', '# Plain\n');

  const control = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]');
  for (const result of [cli(['goals', '-C', cwd]), ttyCli(['goals', '-C', cwd])]) {
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!control.test(result.stdout), 'a control character reached the terminal');
    assert.ok(!/\p{Bidi_Control}/u.test(result.stdout), 'a bidi override reached the terminal');
    assert.equal(
      result.stdout.trimEnd().split('\n').filter((line) => line.includes('hostile')).length,
      1,
      'one goal became more than one row',
    );
  }
});

/* -------------------------------------------------------------------------- */
/* goals show                                                                  */
/* -------------------------------------------------------------------------- */

test('R5: goals show prints the file, and a pipe gets it byte for byte', () => {
  const cwd = workspace();
  const body = '# Release notes\n\nR1. Turn the changelog into notes.\n\n\tindented with a tab\n';
  seedGoal(cwd, 'release-notes', body);

  const shown = cli(['goals', 'show', 'release-notes', '-C', cwd]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(shown.stderr, '');
  assert.equal(shown.stdout, body);
});

test('goals show neutralises what a terminal would obey rather than draw', () => {
  const cwd = workspace();
  seedGoal(cwd, 'hostile', '# Title' + ESC + '[2J\n\nBody' + BELL + '\n');
  const shown = ttyCli(['goals', 'show', 'hostile', '-C', cwd]);
  assert.equal(shown.code, 0, shown.stderr);
  const control = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]');
  assert.ok(!control.test(shown.stdout), 'an escape sequence reached the terminal');
  assert.match(shown.stdout, /# Title/);
  assert.match(shown.stdout, /Body/);
});

test('R5: an unknown goal is exit 2, naming the names there are', () => {
  const cwd = workspace();
  seedGoal(cwd, 'release-notes', '# Release notes\n');
  seedGoal(cwd, 'audit', '# Audit\n');

  const { code, stdout, stderr } = cli(['goals', 'show', 'shipit', '-C', cwd]);
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /unknown goal "shipit" in /);
  assert.match(stderr, /available goals:/);
  assert.match(stderr, /audit, release-notes/);
  assert.match(stderr, /Usage: {2}exolvra-genesis goals show <name> \[flags\]/);
});

test('an unknown goal in an empty repository says there are none yet', () => {
  const cwd = workspace();
  const { code, stderr } = cli(['goals', 'show', 'shipit', '-C', cwd]);
  assert.equal(code, 2);
  assert.match(stderr, /there are no goals here yet/);
  assert.match(stderr, /exolvra-genesis goals new <name>/);
});

test('a name that is really a path is refused before anything is read', () => {
  const cwd = workspace();
  const { code, stdout, stderr } = cli(['goals', 'show', '../../etc/passwd', '-C', cwd]);
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /invalid value "\.\.\/\.\.\/etc\/passwd" for <name>/);
  assert.match(stderr, /a goal name is a file name, not a path/);
});

/* -------------------------------------------------------------------------- */
/* The command line itself                                                     */
/* -------------------------------------------------------------------------- */

test('an unknown subcommand is exit 2, naming it and what exists', () => {
  const { code, stdout, stderr } = cli(['goals', 'list']);
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /unknown subcommand "list" for "exolvra-genesis goals": expected show or new/);
  assert.match(stderr, /Usage: {2}exolvra-genesis goals \[show <name> \| new <name>\] \[flags\]/);
});

test('a flag that belongs to another form is refused, named as it was typed', () => {
  const cwd = workspace();
  seedGoal(cwd, 'release-notes', '# Release notes\n');

  const shown = cli(['goals', 'show', 'release-notes', '--json', '-C', cwd]);
  assert.equal(shown.code, 2);
  assert.equal(shown.stdout, '');
  assert.match(shown.stderr, /flag --json is not available for "exolvra-genesis goals show"/);
  assert.match(shown.stderr, /it applies to: exolvra-genesis goals \[flags\]/);

  const listed = cli(['goals', '-C', cwd, '-m', 'claude-opus-5']);
  assert.equal(listed.code, 2);
  assert.match(listed.stderr, /flag -m is not available for "exolvra-genesis goals"/);
  assert.match(listed.stderr, /it applies to: exolvra-genesis goals new <name> \[flags\]/);
});

test('goals show with no name is exit 2, and with two is exit 2', () => {
  const none = cli(['goals', 'show']);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /accepts 1 arg, received 0/);

  const two = cli(['goals', 'show', 'a', 'b']);
  assert.equal(two.code, 2);
  assert.match(two.stderr, /accepts 1 arg, received 2/);
});

test('--help wins over a subcommand that does not exist', () => {
  const { code, stdout } = cli(['goals', 'nonsense', '--help']);
  assert.equal(code, 0);
  assert.match(stdout, /USAGE\n {2}exolvra-genesis goals \[show <name> \| new <name>\] \[flags\]/);
  assert.match(stdout, /SUBCOMMANDS/);
  assert.match(stdout, /RESOLUTION ORDER/);
  assert.match(stdout, /JSON FIELDS/);
  assert.match(stdout, /LEARN MORE/);
});

test('the command declares a validator for the argument its usage line names', () => {
  assert.equal(goalsCommand.argument.name, 'name');
  assert.equal(goalsCommand.usage.match(/<([^>]+)>/)[1], 'name');
  assert.throws(
    () => goalsCommand.argument.value.parse(goalsCommand.argument.value.invalid, {
      flag: '<name>',
      usage: 'usage',
      cwd: PACKAGE_ROOT,
    }),
    UsageError,
  );
});

test('the subcommand word is found by the parser own reading of the line', () => {
  assert.equal(firstPositionalIndex(goalsCommand, ['show', 'x']), 0);
  assert.equal(firstPositionalIndex(goalsCommand, ['-C', 'dir', 'show', 'x']), 2);
  assert.equal(firstPositionalIndex(goalsCommand, ['--json']), -1);
  // A flag that takes a value swallows the next token, here as in the parser.
  assert.equal(firstPositionalIndex(goalsCommand, ['--model', 'show', 'new']), 2);
});

test('the renderers are the same ones the process used', () => {
  const goals = [
    { name: 'audit', path: '/tmp/audit.md', description: 'Audit the dependency tree' },
    { name: 'bare', path: '/tmp/bare.md', description: '' },
  ];
  assert.equal(
    renderGoals(goals, { tty: false, width: 80 }),
    'audit\tAudit the dependency tree\nbare\t-\n',
  );
  assert.deepEqual(asJson(goals)[1], { description: null, name: 'bare', path: '/tmp/bare.md' });
});

/* -------------------------------------------------------------------------- */
/* R6 and C4 as a user meets them: run and plan, off a real process            */
/* -------------------------------------------------------------------------- */

for (const command of ['run', 'plan']) {
  test(`R6: ${command} refuses a token that is both a file and a goal`, () => {
    const cwd = workspace();
    seedGoal(cwd, 'release-notes', '# The goal\n');
    writeFileSync(join(cwd, 'release-notes'), '# The file\n', 'utf8');

    const { code, stdout, stderr } = cli([command, '-C', cwd, 'release-notes']);
    assert.equal(code, 2, stderr);
    assert.equal(stdout, '');
    assert.match(stderr, /ambiguous argument "release-notes"/);
    assert.ok(stderr.includes(join(cwd, 'release-notes')), 'the file was not named');
    assert.ok(stderr.includes(goalPath(cwd, 'release-notes')), 'the goal was not named');
    assert.match(stderr, /Usage: {2}exolvra-genesis /);
  });

  test(`C4: ${command} refuses an input that drops a standing gate`, () => {
    const cwd = workspace();
    seedStandards(cwd, STANDING);
    seedSpec(cwd, 'spec.md', [STANDING[0], STANDING[2]]);

    const { code, stdout, stderr } = cli([command, '-C', cwd, 'spec.md']);
    assert.equal(code, 2, stderr);
    assert.equal(stdout, '');
    assert.match(stderr, /drops G2/);
    assert.match(stderr, /G2\. The full suite is green before anything is reported as done\./);
  });
}

test('C2: the same spec, in a repository with no standards, previews as it always did', () => {
  // The control for the two refusals above, on a real process: the same gate
  // list, the same command, and nothing to inherit — so the preview runs to the
  // end. Only the Claude Agent SDK is stood in for, at the seam it already has.
  const cwd = workspace();
  seedSpec(cwd, 'spec.md', ['G1. Something else entirely.']);
  const { code, stdout, stderr } = planSandbox.run(
    ['plan', '--plugin-dir', REPO_ROOT, '-C', cwd, '--max-turns', '1', 'spec.md'],
    { replay: answerFile(cwd, 'answer.md', planAnswer()) },
  );
  assert.equal(code, 0, 'the preview did not finish: ' + stderr);
  assert.ok(stdout.length > 0, 'a preview that exits 0 must have printed a plan');
  assert.doesNotMatch(stderr, /gate/i);
});

/* -------------------------------------------------------------------------- */
/* R8: goals new, driven through a terminal that is not one                    */
/* -------------------------------------------------------------------------- */

/** A transport that answers each turn with the next line of a script. */
const FAKE_SDK = `import { readFileSync, writeFileSync, existsSync } from 'node:fs';

let turn = 0;

export function query({ prompt, options }) {
  const plan = JSON.parse(readFileSync(process.env.EXOLVRA_GENESIS_GOAL_SCRIPT, 'utf8'));
  const text = plan.turns[Math.min(turn, plan.turns.length - 1)];
  turn += 1;

  const record = process.env.EXOLVRA_GENESIS_GOAL_TURNS;
  const seen = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : [];
  seen.push({
    prompt,
    cwd: options.cwd,
    model: options.model ?? null,
    maxTurns: options.maxTurns ?? null,
    permissionMode: options.permissionMode ?? null,
    resume: options.resume ?? null,
    agents: Object.keys(options.agents ?? {}),
  });
  writeFileSync(record, JSON.stringify(seen, null, 2), 'utf8');

  return {
    async interrupt() {},
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'assistant',
        session_id: 'sesn_goal',
        message: { content: [{ type: 'text', text }] },
      };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sesn_goal',
        num_turns: 1,
        total_cost_usd: 0.01,
        result: text,
        errors: [],
      };
    },
  };
}
`;

/** Runs `goals new` inside the sandbox, with a terminal that keeps every byte. */
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

async function waitFor(needle, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    if (stripVTControlCharacters(raw()).includes(needle)) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting for ' + JSON.stringify(needle));
    }
    await sleep(10);
  }
}

Object.defineProperty(process, 'stdin', { value: input, configurable: true });

const { goalsCommand } = await import(
  new URL('./dist/commands/goals.js', import.meta.url).href
);

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
  for (const step of plan.steps ?? []) {
    await waitFor(step.await);
    await sleep(80);
    if (step.type === 'text') {
      input.write(step.value);
      await waitFor(step.value);
      input.write('\\r');
    } else if (step.type === 'approve') {
      input.write('\\r');
    } else if (step.type === 'decline') {
      input.write(String.fromCharCode(27) + '[B');
      await sleep(60);
      input.write('\\r');
    } else if (step.type === 'cancel') {
      input.write(String.fromCharCode(3));
    }
    await sleep(80);
  }
})();

let code;
let failure;
try {
  code = await goalsCommand.run(plan.argv, ctx);
} catch (error) {
  failure = { name: error?.name ?? 'Error', message: String(error?.message ?? error) };
  code = null;
}
await typing.catch(() => undefined);

writeFileSync(plan.out, JSON.stringify({ code, failure, raw: raw(), errors }, null, 2), 'utf8');
process.exit(0);
`;

/** The package's own dependencies, linked; only the SDK is substituted. */
function linkDependencies(root) {
  const from = join(PACKAGE_ROOT, 'node_modules');
  const to = join(root, 'node_modules');
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (entry === '@anthropic-ai' || entry === '.bin') continue;
    symlinkSync(join(from, entry), join(to, entry), 'junction');
  }
}

const sandbox = createSandbox();
linkDependencies(sandbox.root);
writeFileSync(
  join(sandbox.root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'index.js'),
  FAKE_SDK,
  'utf8',
);
writeFileSync(join(sandbox.root, 'goals-driver.mjs'), DRIVER, 'utf8');

after(() => {
  planSandbox.cleanup();
  for (const dir of [...TEMP, sandbox.root]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Left for the operating system to reclaim.
    }
  }
});

/** Runs one scripted `goals new` and answers back what the terminal was shown. */
function scaffold({ argv, turns, steps = [], cwd = workspace() }) {
  const script = join(cwd, 'goal-script.json');
  const record = join(cwd, 'goal-turns.json');
  const out = join(cwd, 'goal-out.json');
  writeFileSync(script, JSON.stringify({ turns }, null, 2), 'utf8');

  const plan = join(cwd, 'goal-plan.json');
  writeFileSync(plan, JSON.stringify({ argv, steps, cwd, out, columns: 80 }, null, 2), 'utf8');

  const proc = spawnSync(process.execPath, ['goals-driver.mjs', plan], {
    cwd: sandbox.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      EXOLVRA_GENESIS_PLUGIN_DIR: REPO_ROOT,
      EXOLVRA_GENESIS_GOAL_SCRIPT: script,
      EXOLVRA_GENESIS_GOAL_TURNS: record,
    },
  });
  assert.equal(proc.error, undefined, 'the driver failed to start');
  assert.ok(
    readdirSync(cwd).includes('goal-out.json'),
    'the driver wrote nothing:\n' + proc.stdout + proc.stderr,
  );

  const result = JSON.parse(readFileSync(out, 'utf8'));
  return {
    ...result,
    cwd,
    screen: () => screen(result.raw),
    frames: () => frames(result.raw),
    turns: () => JSON.parse(readFileSync(record, 'utf8')),
  };
}

const PROPOSAL = [
  '# Turn a changelog into release notes',
  '',
  'One paragraph of purpose.',
  '',
  '## Requirements',
  '',
  'R1. Read CHANGELOG.md and write RELEASE.md.',
].join('\n');

const PROPOSED = ['Here is the whole file.', '@exolvra-genesis goal-begin', PROPOSAL, '@exolvra-genesis goal-end'].join(
  '\n',
);

test('R8: a question, an answer, the whole file, and the file is written on approval', () => {
  const result = scaffold({
    argv: ['new', 'release-notes'],
    turns: ['What should this goal produce?', PROPOSED],
    steps: [
      { await: 'Your answer', type: 'text', value: 'release notes from the changelog' },
      { await: 'Write it?', type: 'approve' },
    ],
  });

  assert.equal(result.code, 0, 'an approved goal exits 0: ' + JSON.stringify(result.failure));

  const drawn = result.screen();
  assert.ok(
    drawn.some((row) => row.includes('What should this goal produce?')),
    'the question was never shown:\n' + drawn.join('\n'),
  );
  assert.ok(
    drawn.some((row) => row.includes('R1. Read CHANGELOG.md and write RELEASE.md.')),
    'the file was never shown whole before approval:\n' + drawn.join('\n'),
  );
  assert.ok(
    drawn.some((row) => row.includes('exolvra-genesis run release-notes')),
    'the line to run it was never printed:\n' + drawn.join('\n'),
  );

  // C5: the file exists because this command wrote it, after approval.
  assert.equal(readFileSync(goalPath(result.cwd, 'release-notes'), 'utf8'), PROPOSAL + '\n');

  // And it is a goal the resolver now finds by name.
  const input = resolveInput('release-notes', result.cwd);
  assert.equal(input.goalName, 'release-notes');

  // The conversation was one agent, read-only, resuming its own session.
  const turns = result.turns();
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0].agents, [], 'a scaffold has no subagents to delegate to');
  assert.equal(turns[0].permissionMode, 'plan', 'the scaffold session was not read-only');
  assert.equal(turns[0].resume, null);
  assert.equal(turns[1].resume, 'sesn_goal');
  assert.equal(turns[1].prompt, 'release notes from the changelog');
  assert.match(turns[0].prompt, /goal-begin/, 'the reporting shape was never asked for');
  assert.match(turns[0].prompt, /"release-notes"/, 'the scope never named the goal');
});

test('R8 / C5: a proposal that is declined is not written, and the talk carries on', () => {
  const result = scaffold({
    argv: ['new', 'release-notes'],
    turns: [PROPOSED, 'What would you like changed?'],
    steps: [
      { await: 'Write it?', type: 'decline' },
      { await: 'What should change?', type: 'text', value: 'add a gate about tests' },
      { await: 'Your answer', type: 'cancel' },
    ],
  });

  assert.equal(result.code, 1, 'a conversation stopped at a question exits 1');
  assert.equal(
    existsSync(goalPath(result.cwd, 'release-notes')),
    false,
    'a declined proposal was written anyway',
  );
  const drawn = result.screen();
  assert.ok(
    drawn.some((row) => row.includes('Cancelled')),
    'the cancel was never drawn:\n' + drawn.join('\n'),
  );
});

test('R8: the path to write to is on its own line, never folded into the question', () => {
  /*
   * A deep path at eighty columns.
   *
   * Asked as "Write this to <path>?" the question is longer than the terminal,
   * so the prompt folds it — with the rail drawn down the middle of the fold,
   * through the middle of a path token. The path goes above the question
   * instead, where a long line is soft-wrapped by the terminal and stays one
   * line to anything selecting it.
   */
  const deep = join(
    workspace(),
    'packages',
    'platform-services',
    'release-tooling',
    'workspace',
  );
  mkdirSync(deep, { recursive: true });

  const result = scaffold({
    argv: ['new', 'release-notes'],
    turns: [PROPOSED],
    steps: [{ await: 'Write it?', type: 'approve' }],
    cwd: deep,
  });
  assert.equal(result.code, 0, JSON.stringify(result.failure));

  const path = goalPath(deep, 'release-notes');
  assert.ok(path.length > 80, 'the path under test has to be longer than the terminal');

  const drawn = result.screen();
  assert.equal(
    drawn.filter((row) => row.includes('This is ' + path + ':')).length,
    1,
    'the path was not drawn whole, on a line of its own:\n' + drawn.join('\n'),
  );
  // Wherever else it is written, it is written whole — never half a path on one
  // row and the rest, behind a rail, on the next.
  assert.ok(
    drawn.some((row) => row.trim().endsWith(path)),
    'the closing line lost the path:\n' + drawn.join('\n'),
  );

  const asked = drawn.filter((row) => row.includes('Write it?'));
  assert.ok(asked.length > 0, 'the question was never drawn:\n' + drawn.join('\n'));
  for (const row of asked) {
    assert.ok(row.length <= 80, 'the question ran past the terminal: ' + row);
    assert.ok(!row.includes(deep), 'the path was folded into the question: ' + row);
  }
});

test('R8: a repo with standing gates tells the scaffold to carry them word for word', () => {
  const cwd = workspace();
  seedStandards(cwd, STANDING);

  const result = scaffold({
    argv: ['new', 'release-notes'],
    turns: [PROPOSED],
    steps: [{ await: 'Write it?', type: 'approve' }],
    cwd,
  });
  assert.equal(result.code, 0, JSON.stringify(result.failure));

  const prompt = result.turns()[0].prompt;
  assert.match(prompt, /declares standing gates in \.exolvra-genesis\/standards\.md/);
  assert.match(prompt, /Do not paraphrase/);
  for (const gate of STANDING) {
    assert.ok(prompt.includes('  ' + gate), 'the standing gate was not handed over: ' + gate);
  }
});

test('C2: a repo with no standards says nothing about gates to the scaffold', () => {
  const result = scaffold({
    argv: ['new', 'release-notes'],
    turns: [PROPOSED],
    steps: [{ await: 'Write it?', type: 'approve' }],
  });
  assert.equal(result.code, 0, JSON.stringify(result.failure));
  assert.doesNotMatch(result.turns()[0].prompt, /standing gates/);
});

test('R8: goals new refuses a name that is already there, before any session', () => {
  const cwd = workspace();
  seedGoal(cwd, 'release-notes', '# The committed one\n');
  const { code, stdout, stderr } = cli(['goals', 'new', 'release-notes', '-C', cwd]);
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /the goal "release-notes" is already there/);
  assert.match(stderr, /exolvra-genesis goals show release-notes/);
});

test('R8: goals new refuses a name that is not a slug', () => {
  const cwd = workspace();
  const { code, stderr } = cli(['goals', 'new', 'Release.Notes', '-C', cwd]);
  assert.equal(code, 2);
  assert.match(stderr, /invalid value "Release\.Notes" for <name>/);
  assert.match(stderr, /a new goal is named as a slug/);
});

test('R8: goals new needs a terminal on both ends, and says so without one', () => {
  const cwd = workspace();
  const { code, stdout, stderr } = cli(['goals', 'new', 'release-notes', '-C', cwd]);
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /writing a goal is a conversation, so it needs a terminal on both ends/);
  assert.equal(
    readdirSync(cwd).includes('.exolvra-genesis'),
    false,
    'a refused scaffold created state anyway',
  );
});
