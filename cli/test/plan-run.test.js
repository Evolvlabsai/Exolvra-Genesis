import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { REPO_ROOT, answerFile, createSandbox, planAnswer } from './run-cli.js';

/*
 * `exolvra-genesis plan` as a process: what it is handed, what it writes where, and
 * what it draws while it works.
 *
 * Every run below is the built binary, spawned. The Claude Agent SDK is the one
 * substitution the bar allows, and it is used here to read back exactly what the
 * CLI handed it — the prompt, the working directory — rather than to stand in
 * for anything the CLI does.
 */

const WORK = mkdtempSync(join(tmpdir(), 'exolvra-genesis-plan-run-'));
const sandbox = createSandbox();
after(() => {
  sandbox.cleanup();
  rmSync(WORK, { recursive: true, force: true });
});

const ANSWER = answerFile(WORK, 'plan-answer.md', planAnswer());

/** Runs plan in `cwd`, recording what reached the SDK. */
function plan(args, { cwd = WORK, env = {} } = {}) {
  const record = join(WORK, 'sdk-options-' + Math.random().toString(36).slice(2) + '.json');
  const result = sandbox.run(['plan', '--plugin-dir', REPO_ROOT, ...args], {
    replay: ANSWER,
    record,
    cwd,
    env,
  });
  return {
    ...result,
    sent: () => JSON.parse(readFileSync(record, 'utf8')),
  };
}

/** A directory of its own, so what one test writes cannot reach another. */
function workdir(name) {
  const dir = join(WORK, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/* -------------------------------------------------------------------------- */
/* R1: what counts as a spec, and what counts as a goal                        */
/* -------------------------------------------------------------------------- */

test('a path-shaped argument that does not exist runs as a goal', () => {
  // The rule `plan --help` states and R1 requires: only an existing file is a
  // spec. A path that is not there is a goal, and spending the run on it is the
  // documented behaviour, not an error.
  const cwd = workdir('goal-shaped-like-a-path');
  const { code, stdout, stderr, sent } = plan(['-C', cwd, 'src/app.tsx']);

  assert.equal(code, 0, 'a path-shaped goal must not be an error: ' + stderr);
  assert.match(stdout, /^GOAL\n {2}src\/app\.tsx\n/, stdout);
  assert.ok(
    sent().prompt.includes('src/app.tsx'),
    'the goal must reach the lead exactly as it was typed',
  );
});

test('an existing file is read as a spec, and echoed the way it was typed', () => {
  const cwd = workdir('spec-echo');
  const spec = join(cwd, 'checkout.md');
  writeFileSync(spec, '# Spec\n\nR1. Ship it.\n', 'utf8');

  const { code, stdout, sent } = plan(['-C', cwd, 'checkout.md'], { cwd });
  assert.equal(code, 0);
  // The agent is handed a path it can resolve; the user is shown their own.
  assert.ok(sent().prompt.includes(spec), 'the lead needs the resolved path');
  assert.match(stdout, /^SPEC\n {2}checkout\.md\n/, stdout);
  assert.ok(!stdout.includes(cwd), 'a path the user never typed was echoed back');
});

test('a long path is echoed whole, never split across two lines', () => {
  const cwd = workdir('long-path');
  const deep = join(cwd, 'a-very-long-directory-name-for-one-spec');
  mkdirSync(deep, { recursive: true });
  const typed =
    'a-very-long-directory-name-for-one-spec/an-even-longer-spec-file-name-that-will-not-fit.md';
  writeFileSync(join(cwd, typed), '# Spec\n', 'utf8');

  const { code, stdout } = plan(['-C', cwd, typed], {
    cwd,
    env: { EXOLVRA_GENESIS_FORCE_TTY: '40' },
  });
  assert.equal(code, 0);
  assert.ok(
    stdout.includes('\n  ' + typed + '\n'),
    'the path was broken up at 40 columns:\n' + stdout,
  );
});

/* -------------------------------------------------------------------------- */
/* What reaches the agent is what the user typed                               */
/* -------------------------------------------------------------------------- */

test('a goal carrying $-patterns reaches the agent literally', () => {
  // `String.replaceAll` reads $&, $`, $' and $$ in a replacement string as
  // patterns. Substituting the goal that way rewrites it on the way in: `$&`
  // becomes the placeholder, and `$\`` splices the whole file before it into
  // the goal. The user's text has to arrive as the user's text.
  const cwd = workdir('dollar-goal');
  const goal = "repeat the exact token between the brackets [$&], then stop. [$`] [$'] [$$]";

  const { code, stdout, stderr, sent } = plan(['-C', cwd, goal]);
  assert.equal(code, 0, stderr);

  const prompt = sent().prompt;
  assert.ok(prompt.includes(goal), 'the goal was rewritten on its way to the agent');
  assert.ok(!prompt.includes('$ARGUMENTS'), 'the placeholder survived the substitution');
  assert.equal(
    prompt.split(goal).length,
    2,
    'the goal reached the prompt more than once: something was spliced',
  );
  // And what the transcript shows is the same text, so a corrupted prompt could
  // never hide behind a correct-looking echo.
  assert.ok(stdout.includes('[$&]'), stdout);
});

/* -------------------------------------------------------------------------- */
/* A capture already on disk is never written over                             */
/* -------------------------------------------------------------------------- */

/** Writes a bar as an earlier run would have left it, and returns the dir. */
function withCapturedBar(name) {
  const cwd = workdir(name);
  const bar = join(cwd, '.exolvra-genesis', 'bar');
  mkdirSync(bar, { recursive: true });
  writeFileSync(join(bar, 'BAR.md'), '# The bar\n\nCaptured by the first run.\n', 'utf8');
  writeFileSync(join(bar, 'shot.png'), 'not really a png', 'utf8');
  return { cwd, bar };
}

test('a second preview refuses to capture over the first run bar, exit 2', () => {
  const { cwd, bar } = withCapturedBar('bar-in-the-way');
  const before = readFileSync(join(bar, 'BAR.md'), 'utf8');

  const { code, stdout, stderr } = plan(['-C', cwd, 'a second goal']);
  assert.equal(code, 2, 'writing over a capture must be a configuration error');
  assert.equal(stdout, '');
  assert.match(stderr, /a bar captured by an earlier run is already here/);
  assert.ok(stderr.includes(bar), 'the error must name the directory: ' + stderr);
  assert.ok(stderr.includes('2 entries'), stderr);
  assert.match(stderr, /--directory/);
  assert.match(stderr, /--force/);

  assert.equal(
    readFileSync(join(bar, 'BAR.md'), 'utf8'),
    before,
    'the earlier capture was touched anyway',
  );
});

test('--force is the only way to capture over it, and it still runs', () => {
  const { cwd } = withCapturedBar('bar-forced');
  const { code, stdout, stderr } = plan(['-C', cwd, '--force', 'a second goal']);
  assert.equal(code, 0, 'with --force the preview runs: ' + stderr);
  assert.ok(stdout.startsWith('GOAL\n'), stdout);
});

test('an empty bar directory is not in the way', () => {
  const cwd = workdir('bar-empty');
  mkdirSync(join(cwd, '.exolvra-genesis', 'bar'), { recursive: true });
  const { code, stderr } = plan(['-C', cwd, 'a goal']);
  assert.equal(code, 0, 'nothing was captured there, so nothing can be lost: ' + stderr);
});

test('plan --help says what it writes, and how to say yes to it', () => {
  const { code, stdout } = sandbox.run(['plan', '--help']);
  assert.equal(code, 0);
  assert.ok(
    stdout.includes('.exolvra-genesis/'),
    'the help must say the preview writes under .exolvra-genesis/:\n' + stdout,
  );
  assert.ok(
    !/changes no deliverable files/.test(stdout),
    'the help still claims the preview writes nothing',
  );
  assert.match(stdout, /\n {6}--force {3,}Capture over a bar an earlier run left in the directory\n/);
});

/* -------------------------------------------------------------------------- */
/* Progress: a moving line on a terminal, nothing at all in a pipe             */
/* -------------------------------------------------------------------------- */

const SPINNER = /[◒◐◓◑]/;
const ESC = String.fromCharCode(0x1b);

test('a piped run draws no progress at all, on either stream', () => {
  const cwd = workdir('progress-piped');
  const { code, stdout, stderr } = plan(['-C', cwd, 'a goal']);
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '', 'a pipe was written to while the command worked');
  assert.ok(!SPINNER.test(stdout), 'a spinner frame reached stdout');
  assert.ok(!stdout.includes(ESC), 'an escape sequence reached stdout');
});

test('a terminal gets a moving line on stderr, and stdout stays clean', () => {
  const cwd = workdir('progress-tty');
  const { code, stdout, stderr } = plan(['-C', cwd, 'a goal'], {
    cwd,
    env: { EXOLVRA_GENESIS_FORCE_TTY: '100' },
  });
  assert.equal(code, 0, stderr);

  assert.ok(SPINNER.test(stderr), 'no progress was drawn:\n' + JSON.stringify(stderr));
  assert.ok(stderr.includes('Previewing the plan'), stderr);
  assert.ok(stderr.includes(ESC + '[2K'), 'the line is redrawn in place, not appended');
  assert.ok(stderr.trimEnd().endsWith(ESC + '[?25h'), 'the cursor was left hidden');
  assert.match(stderr, /(^|\x1B\[2K)Plan ready\n/, stderr);
  // No frame glyph: the line is on stderr, outside any frame, and a lone
  // corner of a box that was never drawn is a claim about a frame.
  assert.ok(!/[◇▲]/.test(stderr), 'the progress line signed off with a frame glyph');

  // The output itself is untouched by any of it.
  assert.ok(!SPINNER.test(stdout), 'a spinner frame reached stdout');
  assert.ok(!stdout.includes(ESC), 'an escape sequence reached stdout');
  assert.ok(stdout.startsWith('GOAL\n'), stdout);
});

test('a preview that produced no plan closes the line as unfinished', () => {
  const cwd = workdir('progress-loss');
  const noPlan = answerFile(WORK, 'no-plan.md', 'I need more information first.');
  const { code, stderr } = sandbox.run(['plan', '--plugin-dir', REPO_ROOT, '-C', cwd, 'a goal'], {
    replay: noPlan,
    cwd,
    env: { EXOLVRA_GENESIS_FORCE_TTY: '100' },
  });
  assert.equal(code, 1);
  assert.match(stderr, /(^|\x1B\[2K)No plan\n/, stderr);
  assert.ok(!/[◇▲]/.test(stderr), 'the progress line signed off with a frame glyph');
});
