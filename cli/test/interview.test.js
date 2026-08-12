import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import { PLUGIN_FILES, substitutePluginRoot } from '../dist/plugin-dir.js';
import { PACKAGE_ROOT, REPO_ROOT, createSandbox } from './run-cli.js';
import { frames, screen } from './tty.js';

/*
 * `exolvra-genesis interview`, driven end to end.
 *
 * Two things are stood in for and nothing else is: the Claude Agent SDK, at the
 * seam `src/session.ts` already has for it, and the terminal — because an
 * interview is TTY-only and a spawned process is given pipes. The command runs
 * from the built `dist/`, inside a sandbox whose `node_modules` holds the
 * scripted transport, with `test/interview-driver.js` supplying the keystrokes.
 */

const { readHandoff } = await import('../dist/commands/interview.js');

/** A transport that answers each turn with the next line of a script. */
const FAKE_SDK = `import { readFileSync, writeFileSync, existsSync } from 'node:fs';

let turn = 0;

export function query({ prompt, options }) {
  const plan = JSON.parse(readFileSync(process.env.EXOLVRA_GENESIS_INTERVIEW_SCRIPT, 'utf8'));
  const text = plan.turns[Math.min(turn, plan.turns.length - 1)];
  turn += 1;

  const record = process.env.EXOLVRA_GENESIS_INTERVIEW_TURNS;
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
        session_id: 'sesn_interview',
        message: { content: [{ type: 'text', text }] },
      };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sesn_interview',
        num_turns: 1,
        total_cost_usd: 0.01,
        result: text,
        errors: [],
      };
    },
  };
}
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
copyFileSync(
  join(PACKAGE_ROOT, 'test', 'interview-driver.js'),
  join(sandbox.root, 'interview-driver.js'),
);

const TEMP = [];
after(() => {
  for (const dir of [...TEMP, sandbox.root]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Left for the operating system to reclaim.
    }
  }
});

function workspace(prefix = 'exolvra-genesis-interview-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP.push(dir);
  return dir;
}

/** Runs one scripted interview and answers back what the terminal was shown. */
function interview({ argv = [], turns, answers = [], cancel = false, cwd = workspace() } = {}) {
  const script = join(cwd, 'interview-script.json');
  const record = join(cwd, 'interview-turns.json');
  const out = join(cwd, 'interview-out.json');
  writeFileSync(script, JSON.stringify({ turns }, null, 2), 'utf8');

  const plan = join(cwd, 'interview-plan.json');
  writeFileSync(
    plan,
    JSON.stringify({ argv, answers, cancel, cwd, out, columns: 80 }, null, 2),
    'utf8',
  );

  const proc = spawnSync(process.execPath, ['interview-driver.js', plan], {
    cwd: sandbox.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      EXOLVRA_GENESIS_PLUGIN_DIR: REPO_ROOT,
      EXOLVRA_GENESIS_INTERVIEW_SCRIPT: script,
      EXOLVRA_GENESIS_INTERVIEW_TURNS: record,
    },
  });
  assert.equal(proc.error, undefined, 'the driver failed to start');
  assert.ok(
    readdirSync(cwd).includes('interview-out.json'),
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

/* -------------------------------------------------------------------------- */
/* The conversation                                                            */
/* -------------------------------------------------------------------------- */

const QUESTIONS = [
  'What are we building, and who is it for?',
  'What stack should it use?',
  'What should it be indistinguishable from?',
];

const HANDOFF = [
  'Both files are approved.',
  '',
  '@exolvra-genesis handoff specs/release-notes.md | specs/release-notes.mockup.html',
].join('\n');

test('R15: three questions, three answers, then the handoff', () => {
  const answers = [
    'a release-notes CLI, for maintainers',
    'node and typescript',
    'the gh release page',
  ];
  const result = interview({
    argv: ['a CLI that turns a changelog into release notes'],
    turns: [...QUESTIONS, HANDOFF],
    answers,
  });

  assert.equal(result.code, 0, 'a completed interview exits 0: ' + JSON.stringify(result.failure));

  // Every question was rendered, in order, on the rail.
  const drawn = result.screen();
  for (const question of QUESTIONS) {
    assert.ok(
      drawn.some((row) => row.includes(question)),
      'a question was never shown: ' + question + '\n' + drawn.join('\n'),
    );
  }
  for (const row of drawn.filter((line) => QUESTIONS.some((q) => line.includes(q)))) {
    assert.match(row, /^│/, 'a question was drawn off the rail: ' + row);
  }

  // Each answer resumed the same session, verbatim, as that turn's prompt.
  const turns = result.turns();
  assert.equal(turns.length, 4, 'expected the opening turn plus one per answer');
  assert.equal(turns[0].resume, null, 'the opening turn resumed something');
  for (const [index, answer] of answers.entries()) {
    assert.equal(turns[index + 1].prompt, answer, 'the answer did not reach the session verbatim');
    assert.equal(turns[index + 1].resume, 'sesn_interview', 'a turn started a new session');
  }

  // No subagents: an interview has one agent, which writes both files itself.
  assert.deepEqual(turns[0].agents, [], 'an interview spawned subagents');

  // The handoff prints the command to run, and the marker never reaches the
  // reader — it is addressed to this CLI.
  const text = drawn.join('\n');
  assert.ok(text.includes('exolvra-genesis run specs/release-notes.md'), text);
  assert.equal(text.includes('@exolvra-genesis'), false, 'the protocol reached the reader');
  assert.match(result.frames().at(-1), /^└ {2}Spec ready — specs\/release-notes\.md$/);
});

test('R15: the argument reaches the markdown, whatever kind it is', () => {
  const idea = interview({
    argv: ['a CLI that turns a changelog into release notes'],
    turns: [HANDOFF],
  });
  assert.equal(idea.code, 0, JSON.stringify(idea.failure));
  assert.ok(
    idea.turns()[0].prompt.includes('a CLI that turns a changelog into release notes'),
    'the idea never reached the prompt',
  );

  // An existing spec: the agent is handed a path it can resolve.
  const cwd = workspace();
  const spec = join(cwd, 'checkout.md');
  writeFileSync(spec, '# Checkout\n', 'utf8');
  const modifying = interview({ argv: [spec], turns: [HANDOFF], cwd });
  assert.equal(modifying.code, 0, JSON.stringify(modifying.failure));
  assert.ok(modifying.turns()[0].prompt.includes(spec), 'the spec path never reached the prompt');

  // Nothing at all: the markdown handles a fresh start, so the CLI sends none.
  const fresh = interview({ argv: [], turns: [HANDOFF] });
  assert.equal(fresh.code, 0, JSON.stringify(fresh.failure));
  assert.ok(
    fresh.turns()[0].prompt.includes('You are running an Exolvra Genesis interview'),
    'the interview markdown was not what was sent',
  );
});

test('R15: Ctrl+C at a question ends it, and settles nothing', () => {
  const result = interview({
    argv: ['an idea'],
    turns: [QUESTIONS[0], HANDOFF],
    cancel: true,
  });

  assert.equal(result.code, 1, 'a cancelled interview exits 1');
  assert.ok(result.frames().join('\n').includes('└'), 'the frame was left hanging open');

  // An interview is not a run: there is no ledger and no state file to settle.
  assert.equal(
    readdirSync(result.cwd).includes('.exolvra-genesis'),
    false,
    'an interview wrote run state',
  );
});

test('R15: without a terminal on both ends it exits 2, and says why', () => {
  // A real process, with real pipes: the ordinary way this command is reached
  // by something that cannot answer it.
  const result = sandbox.run(['interview', 'an idea'], {
    env: { EXOLVRA_GENESIS_PLUGIN_DIR: REPO_ROOT },
  });
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.equal(result.stdout, '', 'a conversation with nobody in it still drew a frame');
  assert.match(result.stderr, /needs a terminal on both ends/);
  assert.match(result.stderr, /nobody to ask/);
});

test('R15: there is no --json, because a question is not machine output', () => {
  const rejected = sandbox.run(['interview', '--json', 'an idea'], {
    env: { EXOLVRA_GENESIS_PLUGIN_DIR: REPO_ROOT },
  });
  assert.equal(rejected.code, 2, rejected.stdout + rejected.stderr);
  assert.match(rejected.stderr, /unknown flag: --json/);
});

test('R15: prose is wrapped, so no row runs past the terminal', () => {
  const paragraph =
    'A release-notes CLI reads a CHANGELOG.md, finds the section for one version, ' +
    'and writes the notes for it — which means it has to cope with the three or ' +
    'four heading conventions that are actually in the wild rather than the one ' +
    'the specification describes, and say which one it recognised.';

  const result = interview({
    argv: ['an idea'],
    turns: [
      [
        paragraph,
        '',
        'Here is the spec so far:',
        '',
        '  ## Requirements',
        '  R1. ' + paragraph,
        '',
        'Does that look right?',
      ].join('\n'),
      HANDOFF,
    ],
    answers: ['yes'],
  });

  assert.equal(result.code, 0, JSON.stringify(result.failure));

  const drawn = result.screen();
  const over = drawn.filter((row) => row.length > 80);
  assert.deepEqual(over, [], 'rows ran past the terminal:\n' + over.join('\n'));

  // Wrapped, not cut: every word of the paragraph survives somewhere.
  const text = drawn.map((row) => row.replace(/^│ {0,2}/, '')).join(' ');
  for (const word of ['CHANGELOG.md', 'conventions', 'recognised.']) {
    assert.ok(text.includes(word), 'wrapping lost ' + word);
  }

  // The indented block stays indented — its continuations hang under it rather
  // than unravelling into the prose around them.
  const indented = drawn.filter((row) => /^│ {4}/.test(row));
  assert.ok(indented.length >= 3, 'the indented block lost its shape:\n' + drawn.join('\n'));
  assert.ok(
    drawn.some((row) => /^│ {4}## Requirements$/.test(row)),
    'the block heading was reflowed away from its indent',
  );

  // And every row of it is on the rail, which is what a folded row loses.
  const body = drawn.slice(drawn.findIndex((row) => row.includes('A release-notes CLI')));
  for (const row of body.slice(0, body.findIndex((row) => row.includes('Your answer')))) {
    assert.ok(row === '' || row.startsWith('│') || row.startsWith('◆'), 'off the rail: ' + row);
  }
});

test('R15: a turn that was only a marker draws nothing at all', () => {
  // The whole content of the turn is addressed to this CLI, so there is nothing
  // in it for the reader — and an empty railed block is two rows of punctuation
  // reporting that nothing happened.
  const withMarkerOnly = interview({
    argv: ['an idea'],
    turns: ['@exolvra-genesis handoff specs/a.md |'],
  });
  assert.equal(withMarkerOnly.code, 0, JSON.stringify(withMarkerOnly.failure));

  const drawn = withMarkerOnly.screen();
  const opening = drawn.findIndex((row) => row.startsWith('┌'));
  const runLine = drawn.findIndex((row) => row.includes('exolvra-genesis run'));
  assert.ok(opening !== -1 && runLine > opening, drawn.join('\n'));

  // Between the frame opening and the command there is the rail and the
  // "Run it with:" block, and no block drawn for a turn that said nothing.
  const between = drawn.slice(opening + 1, runLine);
  const blanks = between.filter((row) => row.trim() === '│');
  assert.ok(
    blanks.length <= 2,
    'an empty turn drew a railed block:\n' + between.join('\n'),
  );
});

test('R15: the handoff line is runnable from where the reader is standing', async () => {
  const { runLine } = await import('../dist/commands/interview.js');
  const here = process.cwd();

  // Written where the command was typed: the bare path is what to type.
  assert.equal(runLine('specs/a.md', here, here), 'exolvra-genesis run specs/a.md');

  // Written somewhere else: without -C the path names a file the reader's
  // shell cannot see, and `run` reads a path it cannot find as a goal — so the
  // line this CLI printed would start a run against its own filename.
  const elsewhere = join(here, 'work');
  assert.equal(
    runLine('specs/a.md', elsewhere, here),
    'exolvra-genesis run -C ' + elsewhere + ' specs/a.md',
  );

  // A directory with a space in it is quoted, because it is going to be typed.
  const spaced = join(here, 'my work');
  assert.equal(
    runLine('specs/a.md', spaced, here),
    'exolvra-genesis run -C ' + JSON.stringify(spaced) + ' specs/a.md',
  );
});

test('R15: a run under -C prints a line that names the directory', () => {
  const typedIn = workspace();
  const wroteIn = workspace();
  const result = interview({
    argv: ['-C', wroteIn, 'an idea'],
    turns: [HANDOFF],
    cwd: typedIn,
  });

  assert.equal(result.code, 0, JSON.stringify(result.failure));
  const drawn = result.screen();

  // One row, whole. A command folded inside the frame is folded with the rail
  // down the middle of it, so copying it off two rows picks the rail up too and
  // the paste does not run — the terminal soft-wraps this instead, which costs
  // a ragged row and keeps the line one line to anything selecting it.
  const command = 'exolvra-genesis run -C ' + wroteIn + ' specs/release-notes.md';
  const rows = drawn.filter((row) => row.includes('exolvra-genesis run'));
  assert.equal(rows.length, 1, 'the command was drawn over several rows:\n' + rows.join('\n'));
  assert.equal(rows[0].replace(/^│\s*/, ''), command, rows[0]);
  assert.ok(rows[0].length > 80, 'this case is only interesting when it does not fit');

  // Everything else still wraps: the command is the one exception.
  for (const row of drawn.filter((row) => !row.includes('exolvra-genesis run'))) {
    assert.ok(row.length <= 80, 'a row ran past the terminal: ' + row);
  }
});

test('R15: cancelling after a turn does not claim nothing was written', () => {
  const result = interview({
    argv: ['an idea'],
    turns: [QUESTIONS[0], HANDOFF],
    cancel: true,
  });

  assert.equal(result.code, 1);
  const drawn = result.screen().join('\n');
  // The agent writes the spec and the mockup itself, and by the first question
  // it has already taken a turn. Saying nothing was saved is telling the user
  // their files are not there.
  assert.equal(
    drawn.includes('no run started, nothing saved'),
    false,
    'a cancelled interview claimed nothing had been written:\n' + drawn,
  );
  assert.match(drawn, /Cancelled — the files written so far are yours to keep\./);
});

test('R15: the handoff line is read for the CLI and kept from the reader', () => {
  assert.deepEqual(readHandoff('@exolvra-genesis handoff specs/a.md | specs/a.mockup.html'), {
    handoff: { spec: 'specs/a.md', mockup: 'specs/a.mockup.html' },
    rest: '',
  });
  // No mockup is a field left empty, not a missing field.
  assert.deepEqual(readHandoff('@exolvra-genesis handoff specs/a.md |'), {
    handoff: { spec: 'specs/a.md', mockup: '' },
    rest: '',
  });
  // A line with no spec is not a handoff, and stays where the reader can see it.
  assert.deepEqual(readHandoff('@exolvra-genesis handoff | x'), { rest: '@exolvra-genesis handoff | x' });
  assert.deepEqual(readHandoff('Prose.\n@exolvra-genesis handoff specs/a.md |\nMore prose.'), {
    handoff: { spec: 'specs/a.md', mockup: '' },
    rest: 'Prose.\nMore prose.',
  });
});

/* -------------------------------------------------------------------------- */
/* R16 — what the package ships, and what resolves inside it                   */
/* -------------------------------------------------------------------------- */

test('R16: the plugin root resolves to the directory the plugin came from', () => {
  const substituted = substitutePluginRoot(
    'cp ${CLAUDE_PLUGIN_ROOT}/templates/progress.html .exolvra-genesis/',
    'C:\\Users\\a b\\exolvra-genesis',
  );
  // Forward slashes, because what surrounds it is a path inside a command.
  assert.equal(substituted, 'cp C:/Users/a b/exolvra-genesis/templates/progress.html .exolvra-genesis/');

  // A directory containing what looks like a replacement pattern is a
  // directory, not a pattern.
  assert.equal(substitutePluginRoot('at ${CLAUDE_PLUGIN_ROOT}', '/tmp/$&$`x'), 'at /tmp/$&$`x');
  assert.equal(substitutePluginRoot('nothing to do', '/tmp'), 'nothing to do');
});

test('R16: a clean tarball install carries every file the CLI loads', () => {
  const into = workspace('exolvra-genesis-install-');
  // npm is a shell script on Windows, so it is run through one; every argument
  // is quoted because a temp directory may contain a space.
  const run = (args, cwd) => {
    const quoted = args.map((arg) => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg));
    const proc = spawnSync('npm ' + quoted.join(' '), {
      cwd,
      encoding: 'utf8',
      shell: true,
    });
    assert.equal(
      proc.status,
      0,
      'npm ' + args.join(' ') + ' failed:\n' + proc.stdout + proc.stderr,
    );
    return proc.stdout;
  };

  // The package as it would really be published, installed as it would really
  // be installed. Nothing below reads the working tree.
  const packed = run(['pack', '--pack-destination', into], PACKAGE_ROOT).trim().split('\n').at(-1);
  run(['init', '-y'], into);
  run(['install', '--no-audit', '--no-fund', join(into, packed)], into);

  const installed = join(into, 'node_modules', 'exolvra-genesis');
  const shipped = join(installed, 'dist', 'plugin');

  // Every file the widened C3 list names, shipped and byte-identical.
  for (const relative of Object.values(PLUGIN_FILES)) {
    assert.equal(
      readFileSync(join(shipped, relative), 'utf8'),
      readFileSync(join(REPO_ROOT, relative), 'utf8'),
      relative + ' is not what the repository holds',
    );
  }

  // And the loader really resolves them from there, with the placeholder
  // pointing at a file that is on disk.
  const loaded = execFileSync(
    process.execPath,
    [
      '-e',
      'import(process.argv[1]).then((m) => {' +
        ' const s = m.loadPluginSources({});' +
        ' process.stdout.write(JSON.stringify({ dir: s.dir, runMd: s.runMd }));' +
        '})',
      new URL('file://' + join(installed, 'dist', 'plugin-dir.js').replace(/\\/g, '/')).href,
    ],
    { cwd: into, encoding: 'utf8' },
  );

  const { dir, runMd } = JSON.parse(loaded);
  assert.equal(resolve(dir), resolve(shipped), 'the shipped copy was not what loaded');
  assert.equal(runMd.includes('${CLAUDE_PLUGIN_ROOT}'), false, 'the placeholder was left literal');

  // The markdown quotes the path in backticks; the path is what is inside them.
  const named = runMd.match(/([^\s`'"]+\/templates\/progress\.html)/);
  assert.ok(named !== null, 'run.md no longer names the template');
  assert.doesNotThrow(
    () => readFileSync(named[1], 'utf8'),
    'the substituted template path is not on disk: ' + named[1],
  );
});

/* -------------------------------------------------------------------------- */
/* Evidence                                                                    */
/* -------------------------------------------------------------------------- */

test('evidence: an interview, drawn end to end', () => {
  const result = interview({
    argv: ['a CLI that turns a changelog into release notes'],
    turns: [
      'What is the one job it has to do, and who is it for?',
      'What stack should it use? Node with TypeScript is the obvious default.',
      [
        'Here is the spec, in full:',
        '',
        '  # Release notes',
        '',
        '  ## Constraints (hard gates)',
        '  C1. Node >= 18, TypeScript strict.',
        '',
        '  ## Requirements',
        '  R1. Reads CHANGELOG.md and writes the notes for one version.',
        '',
        'Does that look right?',
      ].join('\n'),
      [
        'Approved. The mockup is at specs/release-notes.mockup.html — open it and',
        'refresh as we iterate.',
        '',
        '@exolvra-genesis handoff specs/release-notes.md | specs/release-notes.mockup.html',
      ].join('\n'),
    ],
    answers: [
      'turn a changelog into release notes, for maintainers cutting a release',
      'node and typescript, yes',
      'yes, that is right',
    ],
  });

  assert.equal(result.code, 0, JSON.stringify(result.failure));

  const drawn = result.screen().join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  assert.match(drawn, /^┌ {2}exolvra-genesis interview$/m);
  assert.match(drawn, /exolvra-genesis run specs\/release-notes\.md/);

  const evidence = join(PACKAGE_ROOT, '.evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(
    join(evidence, 'interview-frame.txt'),
    [
      'exolvra-genesis interview on a terminal, captured from the shipped code.',
      '',
      'The frame, the questions and the typed answers are real: dist/ driving',
      '@clack/prompts 1.7.0, with two things stood in for and nothing else — the',
      'Claude Agent SDK, at the seam src/session.ts already has for it, and the',
      'terminal, because an interview is TTY-only and a spawned process is given',
      'pipes.',
      '',
      'Each answer below was typed at the prompt and became the next turn of the',
      'same session. Escape sequences are replayed rather than stripped, so this',
      'is what the screen ends up showing. Written by test/interview.test.js.',
      '',
      '='.repeat(72),
      '$ exolvra-genesis interview "a CLI that turns a changelog into release notes"',
      '='.repeat(72),
      '',
      drawn,
      '',
    ].join('\n'),
    'utf8',
  );
});
