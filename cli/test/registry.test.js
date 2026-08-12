import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { UsageError } from '../dist/exit.js';
import {
  choiceValue,
  countValue,
  directoryValue,
  getCommands,
  inputValue,
  loadCommands,
  modelValue,
  parseInvocation,
  registerCommand,
} from '../dist/registry.js';

const DIR = mkdtempSync(join(tmpdir(), 'exolvra-genesis-registry-'));
const SUB = join(DIR, 'sub');
mkdirSync(SUB);
writeFileSync(join(DIR, 'spec.md'), '# Spec\n\nR1. Do the thing.\n', 'utf8');

const modelFlag = { long: 'model', short: 'm', value: modelValue, summary: 'Model' };
const dirFlag = { long: 'directory', short: 'C', value: directoryValue, summary: 'Dir' };
const turnsFlag = { long: 'max-turns', value: countValue, summary: 'Turns' };
const modeFlag = {
  long: 'mode',
  value: choiceValue('mode', ['fast', 'slow']),
  summary: 'Mode',
};
const verboseFlag = { long: 'verbose', short: 'v', summary: 'Verbose' };

const argument = { name: 'goal-or-spec-path', value: inputValue };

const demo = {
  name: 'demo',
  summary: 'A demo command',
  usage: 'exolvra-genesis demo <goal-or-spec-path> [flags]',
  flags: [modelFlag, dirFlag, turnsFlag, modeFlag, verboseFlag],
  argument,
  cwdFlag: dirFlag,
  async run() {
    return 0;
  },
};

const ctx = {
  program: 'exolvra-genesis',
  cwd: DIR,
  env: {},
  stdout: process.stdout,
  stderr: process.stderr,
  isTTY: false,
  isErrTTY: false,
};

const parse = (argv, env = {}) => parseInvocation(demo, argv, { ...ctx, env });

/** Returns the error a call threw, failing the test when it threw nothing. */
function caught(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return assert.fail('expected the call to throw');
}

test('the positional argument is validated, not just collected', () => {
  const args = parse(['a goal']);
  assert.equal(args.help, false);
  assert.deepEqual(args.argument(argument), { kind: 'goal', goal: 'a goal' });

  const spec = parse(['spec.md']).argument(argument);
  assert.equal(spec.kind, 'spec');
  assert.equal(spec.path, join(DIR, 'spec.md'));
});

test('parses long flags in both space and equals form, validating the value', () => {
  assert.equal(parse(['--model', 'claude-opus-5', 'g']).get(modelFlag), 'claude-opus-5');
  assert.equal(parse(['--model=claude-opus-5', 'g']).get(modelFlag), 'claude-opus-5');
});

test('parses short flags in both space and equals form', () => {
  assert.equal(parse(['-m', 'claude-sonnet-5', 'g']).get(modelFlag), 'claude-sonnet-5');
  assert.equal(parse(['-m=claude-sonnet-5', 'g']).get(modelFlag), 'claude-sonnet-5');
});

test('boolean flags default to false and set to true', () => {
  assert.equal(parse(['g']).bool(verboseFlag), false);
  assert.equal(parse(['--verbose', 'g']).bool(verboseFlag), true);
  assert.equal(parse(['-v', 'g']).bool(verboseFlag), true);
});

test('an unset value flag reads as undefined', () => {
  assert.equal(parse(['g']).get(modelFlag), undefined);
  assert.equal(parse(['g']).get(turnsFlag), undefined);
});

test('flags and positionals interleave', () => {
  const args = parse(['--model', 'claude-opus-5', 'the goal', '-v']);
  assert.equal(args.get(modelFlag), 'claude-opus-5');
  assert.equal(args.bool(verboseFlag), true);
  assert.equal(args.argument(argument).goal, 'the goal');
});

test('-- stops flag parsing', () => {
  const args = parse(['--', '--model']);
  assert.equal(args.get(modelFlag), undefined);
  assert.equal(args.argument(argument).goal, '--model');
});

test('--help short-circuits without validating anything else', () => {
  const args = parse(['--bogus', '--help']);
  assert.equal(args.help, true);
  assert.equal(parse(['-h']).help, true);
});

test('an unknown flag is a UsageError carrying the usage line', () => {
  const error = caught(() => parse(['--bogus', 'g']));
  assert.ok(error instanceof UsageError);
  assert.equal(error.message, 'unknown flag: --bogus');
  assert.equal(error.usage, demo.usage);
  assert.throws(() => parse(['-z', 'g']), { message: 'unknown flag: -z' });
});

test('a value flag with no value is a UsageError', () => {
  assert.throws(() => parse(['--model']), {
    name: 'UsageError',
    message: 'flag needs an argument: --model',
  });
  assert.throws(() => parse(['--model', '--verbose']), {
    message: 'flag needs an argument: --model',
  });
});

test('a boolean flag given a value is a UsageError', () => {
  assert.throws(() => parse(['--verbose=yes', 'g']), {
    name: 'UsageError',
    message: 'flag --verbose takes no value',
  });
});

test('an empty value is a UsageError rather than a silent default', () => {
  assert.throws(() => parse(['--directory=', 'g']), {
    name: 'UsageError',
    message: 'flag needs a non-empty argument: --directory',
  });
});

test('a value outside the declared choices is a UsageError', () => {
  assert.equal(parse(['--mode', 'fast', 'g']).get(modeFlag), 'fast');
  assert.throws(() => parse(['--mode', 'sideways', 'g']), {
    name: 'UsageError',
    message: 'invalid value "sideways" for --mode: must be one of fast, slow',
  });
});

test('a model from another provider is a UsageError naming the flag as typed', () => {
  const error = caught(() => parse(['-m', 'gpt-4', 'g']));
  assert.ok(error instanceof UsageError);
  assert.match(error.message, /invalid value "gpt-4" for -m/);
});

test('a non-positive or non-numeric count is a UsageError', () => {
  assert.equal(parse(['--max-turns', '3', 'g']).get(turnsFlag), 3);
  assert.throws(() => parse(['--max-turns', '0', 'g']), UsageError);
  assert.throws(() => parse(['--max-turns', 'lots', 'g']), UsageError);
});

test('wrong arity is a UsageError', () => {
  assert.throws(() => parse([]), { message: 'accepts 1 arg, received 0' });
  assert.throws(() => parse(['a', 'b']), { message: 'accepts 1 arg, received 2' });
});

test('a command with no declared argument rejects positionals', () => {
  const bare = { ...demo, usage: 'exolvra-genesis demo [flags]', argument: undefined };
  assert.throws(() => parseInvocation(bare, ['stray'], ctx), {
    message: 'accepts no arguments, received 1',
  });
});

test('the cwd redirect resolves before every other path in the invocation', () => {
  const args = parse(['-C', 'sub', 'g']);
  assert.equal(args.cwd, SUB);
  assert.equal(args.get(dirFlag), SUB);

  // The spec path is looked for in the redirected directory, not the process
  // one: spec.md is in DIR, so under -C sub there is no such file, and the
  // documented rule makes what is left a goal.
  assert.equal(parse(['spec.md']).argument(argument).kind, 'spec');
  assert.equal(parse(['-C', 'sub', 'spec.md']).argument(argument).kind, 'goal');
  assert.equal(parse(['g']).cwd, resolve(DIR));
});

test('a cwd redirect that does not exist is a UsageError naming it as typed', () => {
  const error = caught(() => parse(['-C', 'nope', 'g']));
  assert.ok(error instanceof UsageError);
  assert.match(error.message, /invalid value "nope" for -C: no such directory/);
});

test('as() reports the flag exactly as the user typed it', () => {
  assert.equal(parse(['-m', 'claude-opus-5', 'g']).as(modelFlag), '-m');
  assert.equal(parse(['--model', 'claude-opus-5', 'g']).as(modelFlag), '--model');
  assert.equal(parse(['g']).as(modelFlag), '--model');
});

test('a declared environment variable is validated before the command runs', () => {
  const env = { name: 'DEMO_DIR', value: directoryValue, overriddenBy: dirFlag };
  const withEnv = { ...demo, env: [env] };
  const at = (vars) => parseInvocation(withEnv, ['g'], { ...ctx, env: vars });

  assert.equal(at({}).env(env), undefined);
  assert.equal(at({ DEMO_DIR: 'sub' }).env(env), SUB);

  const error = caught(() => at({ DEMO_DIR: 'nope' }));
  assert.ok(error instanceof UsageError);
  assert.match(error.message, /invalid value "nope" for DEMO_DIR: no such directory/);

  // The flag that overrides it makes the variable unused, so it is not checked.
  const overridden = parseInvocation(withEnv, ['-C', 'sub', 'g'], {
    ...ctx,
    env: { DEMO_DIR: 'nope' },
  });
  assert.equal(overridden.cwd, SUB);
});

test('an environment fault is reported however the rest of the line was written', () => {
  const env = { name: 'DEMO_DIR', value: directoryValue };
  const withEnv = { ...demo, env: [env] };
  assert.throws(
    () => parseInvocation(withEnv, [], { ...ctx, env: { DEMO_DIR: 'nope' } }),
    /invalid value "nope" for DEMO_DIR/,
  );
});

test('loadCommands discovers command modules without a central list', async () => {
  await loadCommands();
  const names = getCommands().map((command) => command.name);
  assert.ok(names.includes('plan'), 'expected plan to self-register, got ' + names.join(', '));
});

test('getCommands is sorted by name', async () => {
  await loadCommands();
  const names = getCommands().map((command) => command.name);
  assert.deepEqual(names, [...names].sort());
});

test('re-registering the same command object is a no-op', async () => {
  await loadCommands();
  const [command] = getCommands();
  const before = getCommands().length;
  registerCommand(command);
  assert.equal(getCommands().length, before);
});

test('registering a different command under a taken name throws', async () => {
  await loadCommands();
  const [command] = getCommands();
  assert.throws(() => registerCommand({ ...command }), {
    message: 'a different command is already registered as "' + command.name + '"',
  });
});
