import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { EXIT, exitCodeForOutput } from '../dist/exit.js';
import { PLUGIN_FILES } from '../dist/plugin-dir.js';
import {
  BIN,
  REPO_ROOT,
  SAMPLE_PLAN,
  answerFile,
  createSandbox,
  planAnswer,
  run,
} from './run-cli.js';

/*
 * C5 / G5, exercised as behaviour.
 *
 * Every assertion below reads the exit status of a real child process running
 * the built binary. Nothing here inspects the EXIT constant to decide what the
 * CLI does — the constant is checked against what the processes actually
 * returned, at the bottom of the file.
 */

const FIXTURES = mkdtempSync(join(tmpdir(), 'exolvra-genesis-exit-'));
const A_FILE = join(FIXTURES, 'not-a-directory.txt');
const EMPTY_DIR = join(FIXTURES, 'empty');
const MISSING = join(FIXTURES, 'no-such-directory');
const SPEC = join(FIXTURES, 'spec.md');
writeFileSync(A_FILE, 'this is a file, not a directory\n', 'utf8');
writeFileSync(SPEC, '# Spec\n\nR1. Ship it.\n', 'utf8');
mkdirSync(EMPTY_DIR);

const sandbox = createSandbox();
after(() => sandbox.cleanup());

/** Every observed exit status, so the constant can be checked against reality. */
const observed = new Set();

function record(result) {
  observed.add(result.code);
  return result;
}

/**
 * Invocations that cannot run until the user changes them. Each one must exit
 * 2, print nothing to stdout, and name what the user typed — the flag, and the
 * path or value it carried.
 */
const CONFIGURATION_ERRORS = [
  {
    name: 'an unknown command',
    args: ['bogus-command'],
    names: ['bogus-command', 'plan'],
  },
  {
    name: 'an unknown root flag',
    args: ['--bogus'],
    names: ['unknown flag: --bogus', 'exolvra-genesis <command> [flags]'],
  },
  { name: 'plan with no argument', args: ['plan'], names: ['exolvra-genesis plan'] },
  {
    name: 'plan with two arguments',
    args: ['plan', 'one', 'two'],
    names: ['accepts 1 arg, received 2'],
  },
  {
    name: 'an unknown plan flag',
    args: ['plan', '--spec', 'x', 'a goal'],
    names: ['unknown flag: --spec'],
  },
  {
    name: 'a flag missing its value',
    args: ['plan', '--model'],
    names: ['flag needs an argument: --model'],
  },
  {
    name: 'a flag given an empty value',
    args: ['plan', '--directory=', 'a goal'],
    names: ['flag needs a non-empty argument: --directory'],
  },
  {
    name: "another provider's model id",
    args: ['plan', '--builder-model', 'gpt-4', 'a goal'],
    names: ['invalid value "gpt-4" for --builder-model'],
  },
  {
    // "octopus" contains "opus". A substring test admits it and the provider is
    // the first thing to notice, as a lost run rather than a bad flag.
    name: 'a model id that merely contains a family name',
    args: ['plan', '--model', 'octopus', 'a goal'],
    names: ['invalid value "octopus" for --model', 'accepted:'],
  },
  {
    name: 'a model id that merely contains a family name, on --builder-model',
    args: ['plan', '--builder-model', 'octopus', 'a goal'],
    names: ['invalid value "octopus" for --builder-model'],
  },
  {
    name: 'a plausible but unoffered model id',
    args: ['plan', '--model', 'claude-sonnet-6', 'a goal'],
    names: ['invalid value "claude-sonnet-6" for --model'],
  },
  {
    name: 'a plausible but unoffered model id, on --critic-model',
    args: ['plan', '--critic-model', 'claude-opus-6', 'a goal'],
    names: ['invalid value "claude-opus-6" for --critic-model'],
  },
  {
    name: 'a non-numeric --max-turns',
    args: ['plan', '--max-turns', 'lots', 'a goal'],
    names: ['invalid value "lots" for --max-turns'],
  },
  {
    name: 'a zero --max-turns',
    args: ['plan', '--max-turns', '0', 'a goal'],
    names: ['invalid value "0" for --max-turns'],
  },
  {
    name: 'a --max-turns past the safe integer range',
    args: ['plan', '--max-turns', '99999999999999999999', 'a goal'],
    names: ['invalid value "99999999999999999999" for --max-turns'],
  },
  {
    name: 'an unlisted --permission-mode',
    args: ['plan', '--permission-mode', 'sideways', 'a goal'],
    names: ['invalid value "sideways" for --permission-mode'],
  },
  {
    name: '-C pointing at a directory that does not exist',
    args: ['plan', '-C', MISSING, 'a goal'],
    names: ['-C', 'no such directory', MISSING],
  },
  {
    name: '--directory pointing at a file',
    args: ['plan', '--directory', A_FILE, 'a goal'],
    names: ['--directory', 'not a directory', A_FILE, 'is a file'],
  },
  {
    name: '--plugin-dir pointing at a directory that does not exist',
    args: ['plan', '--plugin-dir', MISSING, 'a goal'],
    names: ['--plugin-dir', 'no such directory', MISSING],
  },
  {
    name: '--plugin-dir pointing at a file',
    args: ['plan', '--plugin-dir', A_FILE, 'a goal'],
    names: ['--plugin-dir', 'not a directory', A_FILE],
  },
  {
    name: '--plugin-dir pointing at a directory without the plugin markdown',
    args: ['plan', '--plugin-dir', EMPTY_DIR, 'a goal'],
    names: [EMPTY_DIR, 'missing commands/run.md'],
  },
  {
    name: 'EXOLVRA_GENESIS_PLUGIN_DIR pointing at a directory that does not exist',
    args: ['plan', 'a goal'],
    env: { EXOLVRA_GENESIS_PLUGIN_DIR: MISSING },
    names: [MISSING, 'no such directory', 'EXOLVRA_GENESIS_PLUGIN_DIR'],
  },
  {
    name: 'EXOLVRA_GENESIS_PLUGIN_DIR pointing at a file',
    args: ['plan', 'a goal'],
    env: { EXOLVRA_GENESIS_PLUGIN_DIR: A_FILE },
    names: [A_FILE, 'not a directory', 'EXOLVRA_GENESIS_PLUGIN_DIR'],
  },
  {
    name: 'EXOLVRA_GENESIS_PLUGIN_DIR without the plugin markdown',
    args: ['plan', 'a goal'],
    env: { EXOLVRA_GENESIS_PLUGIN_DIR: EMPTY_DIR },
    names: [EMPTY_DIR, 'missing commands/run.md', 'EXOLVRA_GENESIS_PLUGIN_DIR'],
  },
  {
    name: 'an argument with nothing in it',
    args: ['plan', '   '],
    names: ['a goal, or a path to an existing spec file, is required'],
  },
  {
    name: 'an unknown help topic',
    args: ['help', 'nope'],
    names: ['unknown help topic "nope"'],
  },
];

for (const entry of CONFIGURATION_ERRORS) {
  test('C5: ' + entry.name + ' exits 2 and names the input', () => {
    const { code, stdout, stderr } = record(run(entry.args, entry.env ?? {}));
    assert.equal(code, 2, entry.args.join(' ') + ' must exit 2, got ' + code);
    assert.equal(stdout, '', entry.args.join(' ') + ' must print nothing to stdout');
    for (const needle of entry.names) {
      assert.ok(
        stderr.includes(needle),
        entry.name + ': stderr never names ' + JSON.stringify(needle) + '\n' + stderr,
      );
    }
  });
}

test('C5: a usage line goes under a bad flag, and never under a bad variable', () => {
  // A usage line is an instruction — this is how the command line is spelled.
  // A flag and the positional argument are both in it, so a fault in either
  // ends with it. An environment variable is not in it anywhere, so printing it
  // under a bad EXOLVRA_GENESIS_PLUGIN_DIR sends the reader to a line that holds
  // nothing they have to change.
  const usage = /\nUsage: {2}exolvra-genesis plan <goal-or-spec-path> \[flags\]\n/;

  for (const args of [
    ['plan', '--plugin-dir', MISSING, 'a goal'],
    ['plan', '-C', MISSING, 'a goal'],
    ['plan', '--model', 'octopus', 'a goal'],
    ['plan', '   '],
  ]) {
    const { code, stderr } = record(run(args));
    assert.equal(code, 2, args.join(' ') + ' must exit 2, got ' + code);
    assert.match(stderr, usage, args.join(' ') + ' lost its usage line:\n' + stderr);
  }

  for (const env of [{ EXOLVRA_GENESIS_PLUGIN_DIR: MISSING }, { EXOLVRA_GENESIS_PLUGIN_DIR: A_FILE }]) {
    const { code, stderr } = record(run(['plan', 'a goal'], env));
    assert.equal(code, 2, 'a bad plugin directory must exit 2, got ' + code);
    assert.ok(stderr.includes('EXOLVRA_GENESIS_PLUGIN_DIR'), 'the variable is unnamed:\n' + stderr);
    assert.ok(
      !/\nUsage: {2}/.test(stderr),
      'a variable fault was answered with a usage line:\n' + stderr,
    );
  }
});

test('C5: malformed plugin markdown is a complaint with its remedy under it', () => {
  // The house shape every other error here has, rather than one line with a
  // semicolon in the middle of it: what is wrong, what an agent file has to
  // carry, and which of the candidate directories the file was really read
  // from — the last being the part a relative path cannot tell the reader.
  const dir = mkdtempSync(join(FIXTURES, 'malformed-plugin-'));
  mkdirSync(join(dir, 'commands'));
  mkdirSync(join(dir, 'agents'));
  mkdirSync(join(dir, 'templates'));
  writeFileSync(join(dir, 'commands', 'run.md'), '---\nname: run\n---\n\nBody.\n', 'utf8');
  writeFileSync(join(dir, 'commands', 'interview.md'), '---\nname: i\n---\n\nBody.\n', 'utf8');
  writeFileSync(join(dir, 'templates', 'progress.html'), '<!doctype html>\n', 'utf8');
  writeFileSync(join(dir, 'templates', 'fleet.html'), '<!doctype html>\n', 'utf8');
  // The one that is wrong: an agent file with no name.
  writeFileSync(join(dir, 'agents', 'builder.md'), '---\ndescription: b\n---\n\nBody.\n', 'utf8');
  writeFileSync(join(dir, 'agents', 'critic.md'), '---\nname: c\ndescription: d\n---\n\nBody.\n', 'utf8');

  const { code, stdout, stderr } = record(
    run(['plan', 'a goal'], { EXOLVRA_GENESIS_PLUGIN_DIR: dir }),
  );
  assert.equal(code, 2, 'malformed plugin markdown must exit 2, got ' + code + '\n' + stderr);
  assert.equal(stdout, '');

  const lines = stderr.split('\n');
  assert.equal(lines[0], 'agents/builder.md is missing a "name" frontmatter field');
  assert.match(lines[1], /^ {2}\S/, 'the remedy is not indented under it: ' + stderr);
  assert.equal(lines[2], '  read from ' + join(dir, 'agents', 'builder.md'));
  assert.ok(!lines[0].includes(';'), 'the complaint is still one joined line: ' + lines[0]);
});

/** Invocations that complete: help, version, and a preview that finishes. */
const SUCCESSES = [
  ['--version'],
  ['--help'],
  [],
  ['plan', '--help'],
  ['help', 'plan'],
  ['help', 'exit-codes'],
  ['help', 'environment'],
];

for (const args of SUCCESSES) {
  test('C5: `exolvra-genesis ' + args.join(' ') + '` exits 0', () => {
    const { code, stdout, stderr } = record(run(args));
    assert.equal(code, 0, args.join(' ') + ' must exit 0, got ' + code);
    assert.equal(stderr, '', args.join(' ') + ' must print nothing to stderr');
    assert.ok(stdout.length > 0, args.join(' ') + ' must print something');
  });
}

test('C5: a preview that finishes exits 0 and prints the plan', () => {
  const recordPath = join(FIXTURES, 'sdk-options.json');
  const { code, stdout, stderr } = record(
    sandbox.run(
      [
        'plan',
        '--plugin-dir',
        REPO_ROOT,
        '-C',
        EMPTY_DIR,
        '--max-turns',
        '3',
        '--model',
        'claude-opus-5',
        '--builder-model',
        'sonnet',
        '--critic-model',
        'haiku',
        SPEC,
      ],
      {
        subtype: 'success',
        record: recordPath,
        replay: answerFile(FIXTURES, 'answer.md', planAnswer()),
      },
    ),
  );

  assert.equal(code, 0, 'a completed preview must exit 0, got ' + code + '\n' + stderr);
  assert.ok(stdout.includes(SAMPLE_PLAN.bar), 'the plan must reach stdout');
  assert.ok(stdout.includes(SAMPLE_PLAN.specs[0].id), 'the task specs must reach stdout');

  // The same run proves the validated flags are the ones handed to the SDK.
  const sent = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(sent.cwd, EMPTY_DIR, '-C must set the directory the session runs in');
  assert.equal(sent.maxTurns, 3);
  assert.equal(sent.model, 'claude-opus-5');
  assert.equal(sent.permissionMode, 'acceptEdits');
  assert.equal(sent.pluginDir, REPO_ROOT);
  assert.equal(sent.agents['exolvra-genesis-builder'].model, 'sonnet');
  assert.equal(sent.agents['exolvra-genesis-critic'].model, 'haiku');
  assert.ok(sent.prompt.includes(SPEC), 'the spec path must reach the lead prompt');
});

test('C5: a session that completes without a plan is not a win', () => {
  // The session ended in success; the answer was a question. Per C5 that is a
  // run that did not achieve its goal, not a win.
  const { code, stdout, stderr } = record(
    sandbox.run(['plan', '--plugin-dir', REPO_ROOT, 'make it better'], {
      subtype: 'success',
      replay: answerFile(
        FIXTURES,
        'a-question.md',
        'I need more information to plan this.\n\nPlease provide either:\n\n1. A path to a spec file\n2. A concrete goal',
      ),
    }),
  );

  assert.equal(code, 1, 'a completed session with no plan must exit 1, got ' + code);
  assert.match(stderr, /the preview produced no plan/);
  assert.match(stderr, /carried no exolvra-genesis-plan block/);
  // What it did say is still shown, under a heading that does not call it a plan.
  assert.ok(stdout.includes('A path to a spec file'), 'the answer was swallowed');
  assert.ok(!stdout.includes('PREVIEW'), 'a question was framed as a preview');
});

for (const subtype of [
  'error_max_turns',
  'error_during_execution',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
]) {
  test('C5: a preview that ends in ' + subtype + ' exits 1', () => {
    const { code, stderr } = record(
      sandbox.run(['plan', '--plugin-dir', REPO_ROOT, 'a goal'], { subtype }),
    );
    assert.equal(code, 1, subtype + ' must exit 1, got ' + code);
    assert.match(stderr, /the preview did not finish/);
    // The reason is said in this tool's words, not handed over as a raw code.
    assert.ok(
      !stderr.includes(subtype),
      'the SDK subtype leaked to the user: ' + stderr,
    );
  });
}

test('C5: running out of turns says so, and says which flag raises the limit', () => {
  const { code, stderr } = record(
    sandbox.run(['plan', '--plugin-dir', REPO_ROOT, '--max-turns', '1', 'a goal'], {
      subtype: 'error_max_turns',
    }),
  );
  assert.equal(code, 1);
  assert.match(stderr, /the preview did not finish: it ran out of agent turns/);
  assert.match(stderr, /raise the limit with --max-turns/);
});

test('C5: streamed agent text is never run together on the loss path', () => {
  const { code, stdout } = record(
    sandbox.run(['plan', '--plugin-dir', REPO_ROOT, '--verbose', 'a goal'], {
      subtype: 'error_during_execution',
    }),
  );
  assert.equal(code, 1);
  // The fake transport emits two separate text blocks and two messages; none of
  // the four ends with punctuation, so a missing separator is unambiguous.
  // Streamed text is laid out like every other line the CLI prints, so each
  // block arrives indented under its section rather than echoed raw.
  assert.ok(!/\S{2}Now\b/.test(stdout), 'agent text ran together: ' + stdout);
  assert.match(stdout, /^ {2}thinking\n\n {2}out loud\n\n/);
  assert.match(stdout, /Now generate the outputs/);
  assert.equal(
    stdout.match(/Now generate the outputs/g).length,
    1,
    'the same agent text was printed twice: ' + stdout,
  );
});

for (const subtype of ['throw', 'throw_before_any_message']) {
  test('C5: a session that cannot start (' + subtype + ') exits 2', () => {
    const { code, stdout, stderr } = record(
      sandbox.run(['plan', '--plugin-dir', REPO_ROOT, 'a goal'], { subtype }),
    );
    assert.equal(code, 2, 'a session that never starts must exit 2, got ' + code);
    assert.equal(stdout, '');
    assert.match(stderr, /could not start a Claude Agent SDK session/);
    assert.match(stderr, /spawn node ENOENT/);
    assert.match(stderr, /exolvra-genesis help environment/);
  });
}

for (const [subtype, needle] of [
  ['throw_type_error', /query is not a function/],
  ['null_message', /reading 'session_id'/],
]) {
  test('C5: the SDK faulting on its own (' + subtype + ') is a blocked run, exit 1', () => {
    // The reported defect: both of these were classified as the environment.
    // One was answered with "check that node is on PATH and that a credential
    // is available" — a remedy for a fault that was never the user's; the other
    // reached the terminal as a bare TypeError with no frame at all. Neither is
    // something a user could retype around, so neither is exit 2, and both wear
    // the frame an unclassified fault gets.
    const { code, stdout, stderr } = record(
      sandbox.run(['plan', '--plugin-dir', REPO_ROOT, 'a goal'], { subtype }),
    );
    assert.equal(code, 1, subtype + ' must exit 1, got ' + code + '\n' + stderr);
    assert.equal(stdout, '', 'nothing was produced, so nothing may be printed as output');
    assert.match(stderr, /^exolvra-genesis: unexpected error while running "plan"\n/, stderr);
    assert.match(stderr, needle, stderr);
    assert.match(stderr, /not a judgement of\n {2}the work/, stderr);
    assert.match(stderr, /report it at https:\/\/github\.com\/\S+\/issues/, stderr);
    assert.ok(
      !stderr.includes('node is on PATH'),
      'a fault in the integration was blamed on the environment: ' + stderr,
    );
    assert.ok(!/\n\s*at /.test(stderr), 'a stack trace reached the terminal: ' + stderr);
  });
}

test('C5: a session killed by a signal is a stopped run, exit 1', () => {
  const { code, stderr } = record(
    sandbox.run(['plan', '--plugin-dir', REPO_ROOT, 'a goal'], { subtype: 'throw_killed' }),
  );
  assert.equal(code, 1, 'a killed run must exit 1, got ' + code + '\n' + stderr);
  assert.match(stderr, /it was stopped by SIGTERM/);
  assert.ok(
    !stderr.includes('node is on PATH'),
    'a kill was blamed on the environment: ' + stderr,
  );
});

test('C5: a session that fails after it started is a lost run, exit 1', () => {
  const { code, stderr } = record(
    sandbox.run(['plan', '--plugin-dir', REPO_ROOT, 'a goal'], {
      subtype: 'throw_midstream',
    }),
  );
  assert.equal(code, 1, 'a run that broke mid-stream must exit 1, got ' + code);
  assert.match(stderr, /dropped the stream/);
});

test('C5: a reader that goes away is one line, never a stack', async () => {
  // `exolvra-genesis ... | head -1` is a normal thing to type, and what it must not
  // produce is a Node stack about a stream the user never asked to know exists.
  // The reader here is destroyed before the child has booted, so the very first
  // write to stdout finds nothing on the other end.
  const child = spawn(process.execPath, [BIN, 'help', 'environment'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.destroy();
  const code = await new Promise((resolve) => child.on('close', resolve));
  observed.add(code);

  assert.equal(code, 1, 'a run cut off by its reader must exit 1, got ' + code);
  assert.equal(
    stderr,
    'write /dev/stdout: the pipe is being closed\n',
    'a closed pipe must be exactly one line: ' + JSON.stringify(stderr),
  );
  assert.ok(!/\n\s*at /.test(stderr), 'a stack trace reached the terminal: ' + stderr);
});

test('C5: a command that produced nothing has not won', () => {
  // The rule the entry point applies to every command, stated once. The
  // behaviour it produces is checked over real processes in answer-gate.test.js.
  assert.equal(exitCodeForOutput(EXIT.WIN, true), EXIT.WIN);
  assert.equal(exitCodeForOutput(EXIT.WIN, false), EXIT.LOSS);
  assert.equal(exitCodeForOutput(EXIT.LOSS, true), EXIT.LOSS);
  assert.equal(exitCodeForOutput(EXIT.LOSS, false), EXIT.LOSS);
  assert.equal(exitCodeForOutput(EXIT.USAGE, false), EXIT.USAGE);
});

test('C5: a plugin file that cannot be read exits 2, like any other bad setup', (t) => {
  // The reported defect: existence was checked and the read was not, so a file
  // that is there and unreadable escaped as a raw Node error — which nothing
  // classified, and which therefore exited 1. Exit 1 tells CI a run lost; no
  // run had started.
  const dir = mkdtempSync(join(FIXTURES, 'unreadable-plugin-'));
  // Every file the loader needs, so what is under test is the unreadable one
  // rather than a missing one.
  for (const relative of Object.values(PLUGIN_FILES)) {
    const file = join(dir, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '# ' + relative + '\n', 'utf8');
  }

  const target = join(dir, 'commands', 'run.md');
  const user = process.env.USERNAME ?? process.env.USER ?? '';
  if (process.platform === 'win32') {
    spawnSync('icacls', [target, '/inheritance:r'], { encoding: 'utf8' });
    spawnSync('icacls', [target, '/deny', user + ':(R)'], { encoding: 'utf8' });
  } else {
    chmodSync(target, 0o000);
  }
  const stillReadable = (() => {
    try {
      readFileSync(target, 'utf8');
      return true;
    } catch {
      return false;
    }
  })();
  after(() => {
    if (process.platform === 'win32') {
      spawnSync('icacls', [target, '/remove:d', user], { encoding: 'utf8' });
      spawnSync('icacls', [target, '/grant', user + ':(F)'], { encoding: 'utf8' });
    } else {
      chmodSync(target, 0o600);
    }
  });
  if (stillReadable) {
    t.skip('this user can read the file regardless of its permissions');
    return;
  }

  const { code, stdout, stderr } = record(
    run(['plan', 'a bash script'], { EXOLVRA_GENESIS_PLUGIN_DIR: dir }),
  );
  assert.equal(code, 2, 'an unreadable plugin file must exit 2, got ' + code + '\n' + stderr);
  assert.equal(stdout, '');
  assert.match(stderr, /could not read the Exolvra Genesis plugin markdown/);
  assert.ok(stderr.includes('commands/run.md'), stderr);
  assert.ok(stderr.includes(dir), 'the error must name where it looked: ' + stderr);
});

test('C5: an error nothing classified is a blocked run, exit 1, and says so', () => {
  // The catch-all, exercised rather than assumed. A corrupt installation — a
  // module in the command directory that throws when it is loaded — is a fault
  // no part of this CLI expects, which is exactly the class being checked: it
  // must not exit 0, must not claim to be a usage error, and must not reach the
  // terminal as a bare errno that reads like a verdict.
  const broken = createSandbox();
  after(() => broken.cleanup());
  writeFileSync(
    join(broken.root, 'dist', 'commands', 'broken.js'),
    "throw new Error('a command module could not be loaded');\n",
    'utf8',
  );

  const { code, stdout, stderr } = record(broken.run(['plan', 'a goal']));
  assert.equal(code, 1, 'a blocked run must exit 1, got ' + code + '\n' + stderr);
  assert.equal(stdout, '', 'nothing was produced, so nothing may be printed as output');
  assert.match(stderr, /^exolvra-genesis: unexpected error while running "plan"\n/, stderr);
  // A flag is not a command, so it is not named as one.
  assert.match(broken.run(['--help']).stderr, /^exolvra-genesis: unexpected error\n/);
  assert.ok(
    stderr.includes('a command module could not be loaded'),
    'the fault itself must be reported: ' + stderr,
  );
  assert.match(stderr, /not a judgement of\n {2}the work/, stderr);
  assert.match(stderr, /report it at https:\/\/github\.com\/\S+\/issues/, stderr);
  // And no usage line. Every other error here ends with one, because retyping
  // the command is the remedy; this one has just said the opposite, so an
  // instruction to retype would send the user to fix an invocation that was
  // never wrong. A bad invocation still gets one, right below.
  assert.ok(
    !/\nUsage: {2}/.test(stderr),
    'an internal fault must not tell the user to retype the command: ' + stderr,
  );
  assert.match(
    run(['plan']).stderr,
    /\nUsage: {2}exolvra-genesis plan <goal-or-spec-path> \[flags\]\n/,
    'a usage error must still carry its usage line',
  );

  // The published contract says the same thing, in the same words.
  const topic = run(['help', 'exit-codes']).stdout;
  assert.match(topic, /blocked before a verdict was ever reached/);
  assert.match(topic, /An internal error in exolvra-genesis blocks the run, so it exits 1/);
  assert.match(topic, /these three are the only codes exolvra-genesis exits with/);
});

test('C5: the EXIT constant matches what the processes returned', () => {
  assert.deepEqual(
    [...observed].sort(),
    [0, 1, 2],
    'the suite must have observed all three codes, saw ' + [...observed].join(', '),
  );
  assert.deepEqual(EXIT, { WIN: 0, LOSS: 1, USAGE: 2 });
});

test('C5: the documented contract matches the observed behaviour', () => {
  const topic = run(['help', 'exit-codes']).stdout;
  assert.match(topic, /exit code will be 0/);
  assert.match(topic, /will be 1/);
  assert.match(topic, /exit code will be 2/);
  assert.match(
    topic,
    /invocation itself has to change/,
    'the topic promises that 2 means the invocation must change',
  );

  // The promise the topic makes, checked against a process: an invocation the
  // user has to change never returns the code CI gates a lost run on.
  const badFlag = run(['plan', '-C', MISSING, 'a goal']);
  assert.equal(badFlag.code, 2);
  assert.notEqual(badFlag.code, 1);
});
