import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { planCommand } from '../dist/commands/plan.js';
import { AGENT_MODELS, MODEL_INHERIT, listModels } from '../dist/models.js';
import { getCommands, loadCommands } from '../dist/registry.js';
import { HELP_TOPICS, ROOT_FLAGS } from '../dist/usage.js';
import {
  PACKAGE_ROOT,
  REPO_ROOT,
  VERSION,
  createSandbox,
  planAnswer,
  run,
} from './run-cli.js';

await loadCommands();

/**
 * Column at which `description` starts on the one line of `text` that contains
 * `label`. Exact rather than heuristic: both halves of the row are known.
 */
function columnOf(text, label, description) {
  // The row, not merely a mention: a flag named in a paragraph of prose above
  // the table is not the table row for that flag.
  const line = text
    .split('\n')
    .find((candidate) => candidate.includes(label) && candidate.includes(description));
  assert.ok(line !== undefined, 'no row carries both ' + label + ' and its description');
  const column = line.indexOf(description);
  assert.ok(column > 0, 'line for ' + label + ' does not carry its description: ' + line);
  return column;
}

test('--version prints the package version and exits 0', () => {
  const { code, stdout } = run(['--version']);
  assert.equal(code, 0);
  assert.equal(stdout.split('\n')[0], 'exolvra-genesis version ' + VERSION);
  assert.ok(stdout.includes(VERSION));
});

test('--help prints root help with every section and exits 0', () => {
  const { code, stdout, stderr } = run(['--help']);
  assert.equal(code, 0);
  assert.equal(stderr, '');
  for (const heading of ['USAGE', 'CORE COMMANDS', 'HELP TOPICS', 'FLAGS', 'EXAMPLES', 'LEARN MORE']) {
    assert.ok(stdout.includes('\n' + heading + '\n'), 'root help is missing ' + heading);
  }
  assert.match(stdout, /^Run adversarial build loops/);
  assert.match(stdout, /\n {2}exolvra-genesis <command> \[flags\]\n/);
  assert.ok(stdout.endsWith('\n\n'), 'help output ends with a blank line');
});

test('bare exolvra-genesis and exolvra-genesis help both print root help', () => {
  const bare = run([]);
  const viaHelp = run(['help']);
  assert.equal(bare.code, 0);
  assert.equal(viaHelp.code, 0);
  assert.equal(bare.stdout, viaHelp.stdout);
  assert.equal(bare.stdout, run(['--help']).stdout);
});

test('root help aligns commands and help topics to one shared column', () => {
  const { stdout } = run(['--help']);
  const rows = [
    ...getCommands().map((command) => [command.name + ':', command.summary]),
    ...HELP_TOPICS.map((topic) => [topic.name + ':', topic.summary]),
  ];
  assert.ok(rows.length >= 3, 'expected several aligned rows');
  const columns = rows.map(([label, summary]) => columnOf(stdout, label, summary));
  assert.equal(
    new Set(columns).size,
    1,
    'descriptions were ragged across sections: ' + columns.join(', '),
  );
});

test('plan --help documents every flag plan accepts', () => {
  const { code, stdout, stderr } = run(['plan', '--help']);
  assert.equal(code, 0);
  assert.equal(stderr, '');
  for (const flag of planCommand.flags) {
    assert.ok(stdout.includes('--' + flag.long), 'flag table is missing --' + flag.long);
    if (flag.short !== undefined) {
      assert.ok(stdout.includes('-' + flag.short + ', --' + flag.long), 'missing short -' + flag.short);
    }
    if (flag.value !== undefined) {
      assert.ok(
        stdout.includes('--' + flag.long + ' ' + flag.value.arg),
        'missing value placeholder for --' + flag.long,
      );
    }
  }
  for (const heading of ['USAGE', 'FLAGS', 'INHERITED FLAGS', 'MODELS', 'EXAMPLES', 'LEARN MORE']) {
    assert.ok(stdout.includes('\n' + heading + '\n'), 'plan help is missing ' + heading);
  }
  assert.ok(stdout.includes('--help'), 'inherited --help must be documented');
});

test('the model flags document two vocabularies, and each takes only its own', () => {
  // The reported defect, as a property: --builder-model and --critic-model used
  // to accept the versioned ids the page listed and hand the provider the
  // family instead, so two different invocations produced identical input with
  // nothing anywhere saying so. What the page claims and what the boundary does
  // are checked against each other here, in both directions.
  const { stdout } = run(['plan', '--help']);
  const flagOf = (long) => {
    const flag = planCommand.flags.find((candidate) => candidate.long === long);
    assert.ok(flag !== undefined, 'plan declares no --' + long);
    return flag;
  };
  const takes = (flag, value) => {
    try {
      flag.value.parse(value, {
        flag: '--' + flag.long,
        usage: planCommand.usage,
        cwd: PACKAGE_ROOT,
      });
      return true;
    } catch {
      return false;
    }
  };

  const ids = listModels().map((model) => model.value);
  const lead = flagOf('model');
  const subagents = [flagOf('builder-model'), flagOf('critic-model')];

  // The page carries both lists, and the flag table names the families again
  // inline, next to the flags that take them.
  const models = stdout.slice(stdout.indexOf('\nMODELS\n'), stdout.indexOf('\nEXAMPLES\n'));
  assert.ok(models.length > 0, 'plan help has no MODELS section');
  for (const id of ids) assert.ok(models.includes(id), 'MODELS never names ' + id);
  for (const family of AGENT_MODELS) {
    assert.ok(
      new RegExp('(^|[\\s,])' + family + '([\\s,]|$)', 'm').test(models),
      'MODELS never names the family ' + family,
    );
  }
  for (const flag of subagents) {
    assert.ok(
      stdout.includes('--' + flag.long + ' family'),
      '--' + flag.long + ' does not say it takes a family',
    );
    assert.ok(
      stdout.includes('{' + AGENT_MODELS.join('|') + '}'),
      'the flag table does not list the families for --' + flag.long,
    );
  }

  // A model id is accepted by the lead flag and refused by both subagent flags;
  // a family is the other way round. `inherit` is the one word in both lists,
  // and it means the same thing in each.
  for (const id of ids) {
    assert.equal(takes(lead, id), true, '--model refuses the id it documents: ' + id);
    for (const flag of subagents) {
      assert.equal(
        takes(flag, id),
        id === MODEL_INHERIT,
        '--' + flag.long + ' disagrees with the page about ' + id,
      );
    }
  }
  for (const family of AGENT_MODELS) {
    for (const flag of subagents) {
      assert.equal(takes(flag, family), true, '--' + flag.long + ' refuses ' + family);
    }
    assert.equal(
      takes(lead, family),
      family === MODEL_INHERIT,
      '--model takes a family it never documents: ' + family,
    );
  }
});

test('a model value is accepted in any casing and forwarded in exactly one', () => {
  // The reported defect: the allowlist matched after trimming and folding case,
  // and then the raw string was forwarded — so `--model INHERIT` was accepted
  // here and reached the provider as a literal request for a model named
  // INHERIT, which 404s. An invocation this CLI had everything it needed to
  // settle became a lost run instead. What the boundary accepts, it returns in
  // the one spelling MODELS publishes.
  const lead = planCommand.flags.find((flag) => flag.long === 'model');
  const builder = planCommand.flags.find((flag) => flag.long === 'builder-model');
  const parse = (flag, value) =>
    flag.value.parse(value, {
      flag: '--' + flag.long,
      usage: planCommand.usage,
      cwd: PACKAGE_ROOT,
    });

  for (const value of ['INHERIT', ' inherit ', 'Inherit']) {
    assert.equal(parse(lead, value), MODEL_INHERIT, value + ' was forwarded as typed');
  }
  for (const value of ['CLAUDE-OPUS-5', 'Claude-Opus-5', '  claude-opus-5  ']) {
    assert.equal(parse(lead, value), 'claude-opus-5', value + ' was forwarded as typed');
  }
  for (const value of ['OPUS', ' opus ']) {
    assert.equal(parse(builder, value), 'opus', value + ' was forwarded as typed');
  }

  // Whatever spelling goes in, what comes out is a value the help page lists.
  const offered = [...listModels().map((model) => model.value), ...AGENT_MODELS];
  for (const flag of [lead, builder]) {
    for (const value of offered) {
      for (const spelling of [value, value.toUpperCase(), '  ' + value + '  ']) {
        let parsed;
        try {
          parsed = parse(flag, spelling);
        } catch {
          continue; // the other vocabulary; refusal is tested above
        }
        assert.ok(
          offered.includes(parsed),
          '--' + flag.long + ' returned "' + parsed + '", which the page never lists',
        );
      }
    }
  }
});

test('a lead model given in another casing reaches the SDK canonicalized', () => {
  // Off a real process, through the real session module, into the options the
  // fake transport records: the one place the defect was observable.
  const record = join(mkdtempSync(join(tmpdir(), 'exolvra-genesis-canon-')), 'sdk-options.json');
  const work = mkdtempSync(join(tmpdir(), 'exolvra-genesis-canon-run-'));
  const answer = join(work, 'answer.md');
  writeFileSync(answer, planAnswer(), 'utf8');

  const sandbox = createSandbox();
  after(() => sandbox.cleanup());

  const sent = (model) => {
    rmSync(record, { force: true });
    const { code, stderr } = sandbox.run(
      ['plan', '--plugin-dir', REPO_ROOT, '-C', work, '--force', '--model', model, 'a goal'],
      { cwd: work, record, replay: answer },
    );
    assert.equal(code, 0, '--model ' + model + ' must exit 0, got ' + code + '\n' + stderr);
    return JSON.parse(readFileSync(record, 'utf8')).model;
  };

  assert.equal(sent('CLAUDE-OPUS-5'), 'claude-opus-5');
  assert.equal(sent('  claude-opus-5  '), 'claude-opus-5');
  // `inherit` is this CLI's own word for "send no model", so it is the one
  // accepted value that must never arrive as a model id at all.
  assert.equal(sent('INHERIT'), null, 'the inherit sentinel was sent as a model id');
});

test('refusing a model id on a subagent flag says why, off a real process', () => {
  const { code, stdout, stderr } = run(['plan', '--builder-model', 'claude-opus-5', 'a goal']);
  assert.equal(code, 2, 'a value the SDK cannot carry must exit 2, got ' + code);
  assert.equal(stdout, '');
  assert.match(stderr, /^invalid value "claude-opus-5" for --builder-model: not a model family\n/);
  assert.match(stderr, /pins a subagent to a model family rather than to a\n {2}version/);
  assert.match(stderr, /use "opus", the family claude-opus-5 belongs to/);
  assert.match(stderr, /accepted: inherit, opus, sonnet, haiku/);
  assert.ok(
    stderr.includes('Usage:  exolvra-genesis plan <goal-or-spec-path> [flags]'),
    'a usage error carries its usage line: ' + stderr,
  );
});

test('every spelling of help the CLI accepts is in a flag table', () => {
  // R14: the flag table is complete, so nothing the CLI accepts is missing
  // from it. Each spelling below is run as a process first, then looked for.
  const surfaces = [
    { args: ['--help'], table: run(['--help']).stdout },
    { args: ['-h'], table: run(['--help']).stdout },
    { args: ['plan', '--help'], table: run(['plan', '--help']).stdout },
    { args: ['plan', '-h'], table: run(['plan', '--help']).stdout },
  ];

  for (const { args, table } of surfaces) {
    const { code, stdout, stderr } = run(args);
    assert.equal(code, 0, args.join(' ') + ' must exit 0, got ' + code + stderr);
    assert.ok(stdout.length > 0, args.join(' ') + ' printed nothing');
    const spelling = args[args.length - 1];
    assert.ok(
      table.includes(spelling),
      args.join(' ') + ' is accepted but "' + spelling + '" is in no flag table',
    );
  }

  // -h and --help are the same flag, so they print the same page.
  assert.equal(run(['-h']).stdout, run(['--help']).stdout);
  assert.equal(run(['plan', '-h']).stdout, run(['plan', '--help']).stdout);
  assert.match(run(['--help']).stdout, /\n {2}-h, --help {6}Show help for command\n/);
  assert.match(run(['plan', '--help']).stdout, /\n {2}-h, --help {3}Show help for command\n/);
});

test('every root flag the help lists is accepted by the root parser', () => {
  for (const flag of ROOT_FLAGS) {
    const long = run(['--' + flag.long]);
    assert.equal(long.code, 0, '--' + flag.long + ' is documented but exits ' + long.code);
    if (flag.short !== undefined) {
      assert.equal(run(['-' + flag.short]).code, 0, '-' + flag.short + ' is documented but rejected');
    }
  }
});

test('plan --help aligns the flag table to one column', () => {
  const { stdout } = run(['plan', '--help']);
  assert.ok(planCommand.flags.length >= 5);
  const columns = planCommand.flags.map((flag) =>
    columnOf(stdout, '--' + flag.long, flag.summary),
  );
  assert.equal(new Set(columns).size, 1, 'flag descriptions were ragged: ' + columns.join(', '));
});

test('an unknown command exits 2 with a gh-shaped error naming what exists', () => {
  const { code, stdout, stderr } = run(['bogus-command']);
  assert.equal(code, 2);
  assert.equal(stdout, '');
  const lines = stderr.split('\n');
  assert.equal(lines[0], 'unknown command "bogus-command" for "exolvra-genesis"');
  assert.equal(lines[1], '');
  assert.equal(lines[2], 'Usage:  exolvra-genesis <command> [flags]');
  assert.equal(lines[3], '');
  assert.equal(lines[4], 'Available commands:');

  /*
   * The whole list, pinned, rather than the first row of it.
   *
   * What this error offers is part of the CLI's surface, so a command added
   * later changes it — and that is worth being told about rather than
   * absorbing silently. Pinned here, adding one fails this test loudly and the
   * fix is to write the new name into the list below, which is also the moment
   * to notice it is now what somebody who mistypes a command is shown.
   */
  const listed = lines.slice(5).filter((line) => line !== '');
  assert.deepEqual(listed, [
    '  goals',
    '  interview',
    '  plan',
    '  queue',
    '  resume',
    '  run',
    '  runs',
    '  standards',
    '  work',
  ]);

  // And the pin is the registry's own list, in the registry's own order, so
  // the two can never disagree about what exists — only about whether somebody
  // noticed something was added.
  assert.deepEqual(
    listed,
    getCommands().map((command) => '  ' + command.name),
    'the error lists something other than the registered commands',
  );
});

test('help <command> and <command> --help are one page, for every command', () => {
  /*
   * Two spellings of one request, so one page.
   *
   * A reader shown two different pages for one command has been told by the
   * CLI itself that one of them is incomplete — and it was: the generic
   * renderer knows nothing about a section a command lays out for itself, so a
   * group with subcommands lost its AVAILABLE COMMANDS block down one of the
   * two routes. Byte-equality across every registered command is the assertion
   * because it is the only one a command added later cannot slip past.
   */
  for (const command of getCommands()) {
    const viaHelp = run(['help', command.name]);
    const viaFlag = run([command.name, '--help']);

    assert.equal(viaHelp.code, 0, 'help ' + command.name + ' exited ' + viaHelp.code);
    assert.equal(viaFlag.code, 0, command.name + ' --help exited ' + viaFlag.code);
    assert.ok(viaFlag.stdout.length > 0, command.name + ' --help printed nothing');
    assert.equal(viaHelp.stderr, '', 'help ' + command.name + ' wrote to stderr');
    assert.equal(
      viaHelp.stdout,
      viaFlag.stdout,
      'help ' + command.name + ' and ' + command.name + ' --help printed different pages',
    );
  }
});

test('help carries the rest of the line to the command, so a leaf gets its own page', () => {
  // `gh help run list` renders the leaf. Dropping the token rendered the group
  // page and called it the answer — a page about something the reader did not
  // ask about, with no sign that the question was ignored.
  const viaHelp = run(['help', 'standards', 'check']);
  const viaFlag = run(['standards', 'check', '--help']);

  assert.equal(viaHelp.code, 0, viaHelp.stderr);
  assert.equal(viaHelp.stdout, viaFlag.stdout, 'help <group> <leaf> is not the leaf page');
  assert.match(viaHelp.stdout, /^Validate the standards file this repo declares\.\n/);
  assert.match(viaHelp.stdout, /USAGE\n {2}exolvra-genesis standards check \[flags\]\n/);
  assert.doesNotMatch(viaHelp.stdout, /AVAILABLE COMMANDS/, 'the leaf page is the group page');
});

test('help names a subcommand that does not exist exactly as the command does', () => {
  const viaHelp = run(['help', 'standards', 'bogus']);
  const direct = run(['standards', 'bogus']);

  assert.equal(viaHelp.code, 2, 'an unknown subcommand answered with a page');
  assert.equal(viaHelp.stdout, '');
  assert.equal(viaHelp.stderr, direct.stderr, 'the two spellings gave different reasons');
  assert.match(viaHelp.stderr, /invalid value "bogus" for <command>: must be one of check, init/);
});

test('help with a stray token after a plain command still prints that command', () => {
  // No leaves to choose between, so the argument boundary answers help first —
  // which is what it does for `run extra --help` too.
  const { code, stdout } = run(['help', 'run', 'extra']);
  assert.equal(code, 0);
  assert.equal(stdout, run(['run', '--help']).stdout);
});

test('a group page keeps its own sections down both routes', () => {
  // The case the rule above exists for, named: a command that renders its own
  // page has a section no generic renderer would draw.
  for (const argv of [['help', 'standards'], ['standards', '--help']]) {
    const { code, stdout } = run(argv);
    assert.equal(code, 0);
    assert.match(stdout, /AVAILABLE COMMANDS/, argv.join(' ') + ' dropped the command list');
    assert.match(stdout, /\n {2}check: Validate the standards file this repo declares\n/);
    assert.match(stdout, /\n {2}init: {2}Write one, one question at a time\n/);
  }
});

test('an error quotes what the user typed without letting it drive the terminal', () => {
  // argv is untrusted input too: an error message quotes it back, so it quotes
  // it back printable.
  const esc = String.fromCharCode(0x1b);
  const control = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]');

  const unknown = run([esc + '[31mbogus' + esc + '[0m']);
  assert.equal(unknown.code, 2);
  assert.ok(!control.test(unknown.stderr), 'an escape sequence reached the terminal');
  assert.equal(unknown.stderr.split('\n')[0], 'unknown command "bogus" for "exolvra-genesis"');

  const bad = run(['plan', '--model', esc + ']0;owned' + String.fromCharCode(7), 'a goal']);
  assert.equal(bad.code, 2);
  assert.ok(!control.test(bad.stderr), 'an escape sequence reached the terminal');
  assert.ok(bad.stderr.includes('invalid value'), bad.stderr);

  // A complaint with an indented detail under it stays two lines: stripping
  // what a terminal would obey is not licence to reflow what it would draw.
  const missing = run(['plan', '-C', './no-such-directory', 'a goal']);
  assert.equal(missing.code, 2);
  const lines = missing.stderr.split('\n');
  assert.equal(lines[0], 'invalid value "./no-such-directory" for -C: no such directory');
  assert.match(lines[1], /^ {2}looked in \S/);
});

test('malformed usage exits 2 and echoes the usage line it violated', () => {
  for (const args of [['plan'], ['plan', '--bogus', 'x'], ['plan', 'a', 'b'], ['plan', '--model']]) {
    const { code, stdout, stderr } = run(args);
    assert.equal(code, 2, args.join(' ') + ' should exit 2');
    assert.equal(stdout, '', args.join(' ') + ' should print nothing to stdout');
    assert.ok(
      stderr.includes('Usage:  exolvra-genesis plan <goal-or-spec-path> [flags]'),
      args.join(' ') + ' should echo the plan usage line',
    );
  }
});

test('a model id from another provider exits 2', () => {
  const { code, stderr } = run(['plan', '--builder-model', 'gpt-4', 'a goal']);
  assert.equal(code, 2);
  assert.match(stderr, /invalid value "gpt-4" for --builder-model/);
});

test('a plugin directory that does not exist exits 2, naming the variable', () => {
  const missing = join(PACKAGE_ROOT, 'no-such-plugin-dir');
  const { code, stdout, stderr } = run(['plan', 'a goal'], { EXOLVRA_GENESIS_PLUGIN_DIR: missing });
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /invalid value .* for EXOLVRA_GENESIS_PLUGIN_DIR: no such directory/);
  assert.ok(stderr.includes(missing), 'the error must name the path it looked in');
});

test('a plugin directory without the markdown is a configuration error, exit 2', () => {
  const empty = mkdtempSync(join(tmpdir(), 'exolvra-genesis-empty-plugin-'));
  const { code, stdout, stderr } = run(['plan', 'a goal'], { EXOLVRA_GENESIS_PLUGIN_DIR: empty });
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /could not load the Exolvra Genesis plugin markdown/);
  assert.ok(stderr.includes(empty), 'the error must name the path it looked in');
  assert.match(stderr, /missing commands\/run\.md/);
  assert.match(stderr, /EXOLVRA_GENESIS_PLUGIN_DIR/);
});

test('help topics are first-class and exit 0', () => {
  const exitCodes = run(['help', 'exit-codes']);
  assert.equal(exitCodes.code, 0);
  assert.match(exitCodes.stdout, /exit code will be 0/);
  assert.match(exitCodes.stdout, /will be 1/);
  assert.match(exitCodes.stdout, /exit code will be 2/);

  const environment = run(['help', 'environment']);
  assert.equal(environment.code, 0);
  assert.match(environment.stdout, /EXOLVRA_GENESIS_PLUGIN_DIR/);
});

test('exolvra-genesis help <command> renders that command help', () => {
  assert.equal(run(['help', 'plan']).stdout, run(['plan', '--help']).stdout);
});

test('an unknown help topic exits 2', () => {
  const { code, stderr } = run(['help', 'nope']);
  assert.equal(code, 2);
  assert.match(stderr, /unknown help topic "nope"/);
});
