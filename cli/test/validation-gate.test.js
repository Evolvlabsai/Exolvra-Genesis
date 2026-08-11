import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { UsageError } from '../dist/exit.js';
import { listModels } from '../dist/models.js';
import { getCommands, loadCommands } from '../dist/registry.js';
import { ROOT_FLAGS } from '../dist/usage.js';
import { REPO_ROOT, answerFile, createSandbox, planAnswer } from './run-cli.js';

/*
 * G5 / C5, as a gate rather than a checklist.
 *
 * Nothing below names a flag. The suite walks what the commands themselves
 * declare and probes every input the CLI accepts — flags, the positional
 * argument, and the environment variables a command reads — with the value its
 * own type declares can never be valid. A flag added later without a validator
 * has no probe to pass and fails the structural tests here; one with a
 * validator that does not really reject fails the behavioural ones.
 *
 * Every exit code comes off a real child process, and each rejection is also
 * checked to have never reached the SDK: the fake transport records the options
 * it was handed, and for a rejected invocation that record must not exist.
 */

await loadCommands();

const COMMANDS = getCommands();

/** An empty directory: nothing a relative probe names can accidentally exist. */
const EMPTY = mkdtempSync(join(tmpdir(), 'gauntlet-gate-'));
const RECORD = join(EMPTY, 'sdk-options.json');

const sandbox = createSandbox();
after(() => {
  sandbox.cleanup();
  rmSync(EMPTY, { recursive: true, force: true });
});

/** Runs the sandboxed binary from the empty directory, recording SDK options. */
function probeRun(args, env = {}, replay) {
  if (existsSync(RECORD)) rmSync(RECORD);
  return sandbox.run(args, {
    cwd: EMPTY,
    record: RECORD,
    replay,
    env: { GAUNTLET_PLUGIN_DIR: undefined, ...env },
  });
}

/** Every value type any command declares, with where it was declared. */
function declaredValues() {
  const out = [];
  for (const command of COMMANDS) {
    for (const flag of command.flags) {
      if (flag.value !== undefined) {
        out.push({ where: `${command.name} --${flag.long}`, value: flag.value });
      }
    }
    if (command.argument !== undefined) {
      out.push({
        where: `${command.name} <${command.argument.name}>`,
        value: command.argument.value,
      });
    }
    for (const spec of command.env ?? []) {
      out.push({ where: `${command.name} ${spec.name}`, value: spec.value });
    }
  }
  return out;
}

/** One rejection probe per input the CLI accepts. */
function probes() {
  const out = [];
  for (const command of COMMANDS) {
    for (const flag of command.flags) {
      if (flag.value === undefined) continue;
      out.push({
        label: `${command.name} --${flag.long}`,
        args: [command.name, `--${flag.long}`, flag.value.invalid],
        names: [`--${flag.long}`, flag.value.invalid],
      });
      if (flag.short !== undefined) {
        out.push({
          label: `${command.name} -${flag.short}`,
          args: [command.name, `-${flag.short}`, flag.value.invalid],
          names: [`-${flag.short}`, flag.value.invalid],
        });
      }
    }
    if (command.argument !== undefined) {
      out.push({
        label: `${command.name} <${command.argument.name}>`,
        args: [command.name, command.argument.value.invalid],
        names: [command.argument.value.invalid],
      });
    }
    for (const spec of command.env ?? []) {
      out.push({
        label: `${command.name} ${spec.name}`,
        args: [command.name],
        env: { [spec.name]: spec.value.invalid },
        names: [spec.name, spec.value.invalid],
      });
    }
  }
  return out;
}

const PROBES = probes();

/* -------------------------------------------------------------------------- */
/* Structure: a new input cannot be declared without a way to reject it        */
/* -------------------------------------------------------------------------- */

test('the registry declares commands to walk', () => {
  assert.ok(COMMANDS.length > 0, 'expected at least one registered command');
  assert.ok(PROBES.length >= 8, 'expected a probe per input, got ' + PROBES.length);
});

test('every flag that takes a value declares the type that validates it', () => {
  for (const command of COMMANDS) {
    for (const flag of command.flags) {
      if (flag.value === undefined) {
        assert.equal(
          flag.default,
          undefined,
          `${command.name} --${flag.long} has a default but takes no value`,
        );
        continue;
      }
      assert.equal(
        typeof flag.value.parse,
        'function',
        `${command.name} --${flag.long} declares no parse step`,
      );
    }
  }
});

test('every declared value type carries a placeholder and a rejection probe', () => {
  for (const { where, value } of declaredValues()) {
    assert.equal(typeof value.arg, 'string', `${where} has no value placeholder`);
    assert.ok(value.arg.length > 0, `${where} has an empty value placeholder`);
    assert.equal(typeof value.invalid, 'string', `${where} declares no probe`);
    assert.ok(value.invalid.length > 0, `${where} declares an empty probe`);
    if (value.choices !== undefined) {
      assert.ok(
        !value.choices.includes(value.invalid),
        `${where} probes with one of its own accepted choices`,
      );
    }
  }
});

test('every declared value type rejects its own probe in process', () => {
  for (const { where, value } of declaredValues()) {
    assert.throws(
      () => value.parse(value.invalid, { flag: '--probe', usage: 'usage', cwd: EMPTY }),
      UsageError,
      `${where} accepted the value it declares can never be valid`,
    );
  }
});

test('a command that takes a positional argument declares a validator for it', () => {
  for (const command of COMMANDS) {
    const named = command.usage.match(/<([^>]+)>/);
    if (named === null) {
      assert.equal(
        command.argument,
        undefined,
        `${command.name} validates an argument its usage line does not take`,
      );
      continue;
    }
    assert.ok(
      command.argument !== undefined,
      `${command.name} takes <${named[1]}> but declares no validator for it`,
    );
    assert.equal(
      command.argument.name,
      named[1],
      `${command.name} validates a different argument than its usage line names`,
    );
  }
});

test('a declared cwd redirect is one of the command own flags', () => {
  for (const command of COMMANDS) {
    if (command.cwdFlag === undefined) continue;
    assert.ok(
      command.flags.includes(command.cwdFlag),
      `${command.name} redirects on a flag it does not declare`,
    );
    assert.ok(command.cwdFlag.value !== undefined);
  }
});

test('root flags take no values, so none of them bypasses the boundary', () => {
  // The root parser in cli.ts handles --help and --version itself. A root flag
  // that took a value would be read outside parseInvocation entirely.
  for (const flag of ROOT_FLAGS) {
    assert.equal(
      flag.value,
      undefined,
      `--${flag.long} takes a value but is parsed outside the boundary`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Behaviour: every probe exits 2, and never reaches the SDK                   */
/* -------------------------------------------------------------------------- */

for (const probe of PROBES) {
  test(`G5: an invalid value for ${probe.label} exits 2`, () => {
    const { code, stdout, stderr } = probeRun(probe.args, probe.env ?? {});

    assert.equal(
      code,
      2,
      `${probe.label} must exit 2, got ${code}\n${stdout}\n${stderr}`,
    );
    assert.equal(stdout, '', `${probe.label} must print nothing to stdout`);
    for (const needle of probe.names) {
      assert.ok(
        stderr.includes(needle),
        `${probe.label}: stderr never names ${JSON.stringify(needle)}\n${stderr}`,
      );
    }
    assert.equal(
      existsSync(RECORD),
      false,
      `${probe.label}: the rejected value still reached the SDK`,
    );
  });
}

test('G5 control: a fully valid invocation does reach the SDK', () => {
  // Without this, "no record was written" would prove nothing. The answer is a
  // well-formed plan, so what is measured here is the invocation, not it.
  const { code, stdout, stderr } = probeRun(
    [
      'plan',
      '--plugin-dir',
      REPO_ROOT,
      '-C',
      EMPTY,
      '--max-turns',
      '1',
      '--model',
      'claude-opus-5',
      '--builder-model',
      'sonnet',
      '--permission-mode',
      'plan',
      'a goal',
    ],
    {},
    answerFile(EMPTY, 'valid-answer.md', planAnswer()),
  );

  assert.equal(code, 0, 'a valid preview must exit 0, got ' + code + '\n' + stderr);
  assert.ok(stdout.length > 0, 'a preview that exits 0 must have printed a plan');
  assert.ok(existsSync(RECORD), 'the valid invocation never reached the SDK');

  // And everything that arrived there is a value the boundary would accept.
  const sent = JSON.parse(readFileSync(RECORD, 'utf8'));
  const offered = listModels().map((model) => model.value);
  assert.ok(offered.includes(sent.model), 'an unoffered model id reached the SDK');
  assert.equal(sent.cwd, EMPTY);
  assert.equal(sent.maxTurns, 1);
  assert.equal(sent.permissionMode, 'plan');
  assert.equal(sent.pluginDir, REPO_ROOT);
  for (const [name, definition] of Object.entries(sent.agents)) {
    assert.ok(
      ['inherit', 'opus', 'sonnet', 'haiku'].includes(definition.model),
      name + ' was sent a model alias the SDK does not accept: ' + definition.model,
    );
  }
});
