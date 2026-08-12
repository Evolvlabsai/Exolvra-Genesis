import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

// The fake terminals below stand in for a UTF-8 terminal, the same way they
// stand in for one that is 80 columns wide. The prompt library reads TERM once,
// when it is imported, to choose between its box-drawing and ASCII glyph sets —
// so the declaration has to come before the import that pulls it in, which is
// why these are dynamic.
process.env.TERM = 'xterm-256color';

const {
  PromptCancelledError,
  askChoice,
  askConfirm,
  beginRun,
  createRunFrame,
  endRun,
  isInteractive,
  isPromptCancelled,
  logVerdict,
  noteRunPlan,
  promptStartup,
  resolveStartup,
  startupFromDefaults,
  trackStep,
} = await import('../dist/prompts.js');
const { configDir, configFromChoices, configPath, loadConfig, saveConfig } = await import(
  '../dist/config.js'
);
const { buildAgentDefinitions } = await import('../dist/agents.js');
const { loadPluginSources } = await import('../dist/plugin-dir.js');
const { ConfigError, UsageError } = await import('../dist/exit.js');
const { AGENT_MODELS, DEFAULT_MODEL_CHOICE, MODEL_INHERIT, asAgentModel, isKnownModel } =
  await import('../dist/models.js');

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = join(CLI_ROOT, '.evidence', 'startup-frames.txt');

const ENTER = '\r';
const DOWN = '\u001b[B';
const CTRL_C = '\u0003';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A terminal that is not one: a pair of streams that claim to be a TTY and keep
 * everything written to them. This is what makes the prompt flow testable —
 * the code under test is the real flow, driven by real keystrokes.
 */
function fakeTty({ columns = 80, rows = 24 } = {}) {
  const chunks = [];

  const output = new PassThrough();
  output.isTTY = true;
  output.columns = columns;
  output.rows = rows;
  output.on('data', (chunk) => chunks.push(chunk.toString('utf8')));

  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;

  return { input, output, raw: () => chunks.join('') };
}

/** A pair that is honest about not being a terminal. */
function pipes() {
  const chunks = [];
  const output = new PassThrough();
  output.on('data', (chunk) => chunks.push(chunk.toString('utf8')));
  const input = new PassThrough();
  return { input, output, raw: () => chunks.join('') };
}

/**
 * The redraw stream as a reader sees it: escape sequences removed, blank and
 * repeated lines collapsed. Same reduction the bar transcript was captured with.
 */
function frames(raw) {
  return stripVTControlCharacters(raw)
    .split(/\r?\n/)
    .map((line) => line.replace(/\r/g, '').trimEnd())
    .filter((line, index, all) => line.trim() !== '' && line !== all[index - 1]);
}

/**
 * Waits for the prompt to have drawn something before answering it.
 *
 * Keystrokes are only meaningful once the question they answer is on screen, so
 * the driver watches the output rather than guessing with sleeps.
 */
async function waitFor(io, needle, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    if (stripVTControlCharacters(io.raw()).includes(needle)) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        'timed out waiting for ' + JSON.stringify(needle) + '\n' + frames(io.raw()).join('\n'),
      );
    }
    await sleep(10);
  }
}

/** Sends one key and gives the prompt a moment to redraw. */
async function press(io, key) {
  io.input.write(key);
  await sleep(20);
}

/** A throwaway user-config location, on every platform's rules at once. */
function tempHome(t, prefix = 'exolvra-genesis-config-') {
  const home = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    home,
    env: {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
    },
  };
}

function collectWarnings() {
  const messages = [];
  return { warn: (message) => messages.push(message), messages };
}

/** A `warn` for the reads that must not have anything to say. */
const noNotices = (message) => assert.fail('unexpected config notice: ' + message);

// ---------------------------------------------------------------------------
// Where prompting is allowed
// ---------------------------------------------------------------------------

test('a prompt needs a terminal at both ends', () => {
  const tty = fakeTty();
  assert.equal(isInteractive({ input: tty.input, output: tty.output }), true);

  const piped = pipes();
  assert.equal(isInteractive({ input: piped.input, output: tty.output }), false);
  assert.equal(isInteractive({ input: tty.input, output: piped.output }), false);
  assert.equal(isInteractive({ input: piped.input, output: piped.output }), false);
});

test('promptStartup throws rather than ask a pipe a question', async () => {
  const piped = pipes();
  await assert.rejects(
    () => promptStartup({ input: 'specs/demo.md' }, { input: piped.input, output: piped.output }),
    ConfigError,
  );
  // Nothing was drawn: a half-rendered frame in a pipe is output the caller
  // never asked for, and the missing half is a prompt no one can answer.
  assert.equal(piped.raw(), '');
});

test('a non-TTY run resolves its answers from flags and config alone', async () => {
  const piped = pipes();
  // The vocabulary the flags take: an id for the lead, families for the two
  // roles that run as subagents.
  const models = { lead: 'claude-opus-5', builder: 'sonnet', critic: MODEL_INHERIT };
  const choices = await resolveStartup(
    { input: '  specs/demo.md  ', models },
    { input: piped.input, output: piped.output },
  );
  assert.deepEqual(choices, { input: 'specs/demo.md', models, auto: true });
  assert.equal(piped.raw(), '', 'resolving from defaults must not draw anything');
});

test('a piped run is always auto, whatever the config prefers', () => {
  // Review mode waits for a confirmation only a terminal can give. A saved
  // preference that survived into a pipe would be a run that never starts.
  const choices = startupFromDefaults({ input: 'specs/demo.md', auto: false });
  assert.equal(choices.auto, true);
});

test('startupFromDefaults fills in the models it was not given', () => {
  const choices = startupFromDefaults({ input: 'ship the checkout flow' });
  assert.deepEqual(choices.models, DEFAULT_MODEL_CHOICE);
});

test('a non-TTY run with no goal is a usage error, not a prompt', () => {
  assert.throws(() => startupFromDefaults({}), UsageError);
  assert.throws(() => startupFromDefaults({ input: '   ' }), UsageError);
});

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

test('Ctrl+C at a prompt closes the frame and leaves no config behind', async (t) => {
  const { env } = tempHome(t);
  const io = fakeTty();
  const streams = { input: io.input, output: io.output };

  const driver = (async () => {
    await waitFor(io, 'What are we building?');
    await press(io, CTRL_C);
  })();

  // The shape a caller uses: ask, then persist what came back.
  let saved = false;
  let thrown;
  try {
    const choices = await promptStartup({}, streams);
    saveConfig(configFromChoices(choices), { env });
    saved = true;
  } catch (error) {
    thrown = error;
  }
  await driver;

  assert.ok(thrown instanceof PromptCancelledError, 'expected a PromptCancelledError');
  assert.equal(isPromptCancelled(thrown), true);
  assert.equal(saved, false);
  assert.equal(
    existsSync(configPath({ env })),
    false,
    'a cancelled run must not have written a config',
  );

  const drawn = frames(io.raw());
  assert.ok(
    drawn.some((line) => line.startsWith('■')),
    'the cancelled question must be marked as cancelled:\n' + drawn.join('\n'),
  );
  assert.match(drawn[drawn.length - 1], /^└ {2}Cancelled/);
});

// ---------------------------------------------------------------------------
// Where the config lives
// ---------------------------------------------------------------------------

test('the config lives where each OS keeps user config', () => {
  /*
   * Every case injects the whole environment and states the answer literally.
   *
   * Both halves matter. Joining the expected path with `node:path` would build
   * it by the rules of whichever machine is running the test, so a Windows box
   * would demand backslashes in a macOS path and agree with an answer that is
   * wrong everywhere. And an environment injected with holes in it lets the
   * real one show through: this is what put a Linux home under an `AppData`
   * suffix on CI, a location that exists on neither system.
   */
  assert.equal(
    configPath({ platform: 'win32', env: { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' } }),
    'C:\\Users\\ada\\AppData\\Roaming\\exolvra-genesis\\config.json',
  );
  // No APPDATA: the convention's own default, under the injected home.
  assert.equal(
    configPath({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\ada' } }),
    'C:\\Users\\ada\\AppData\\Roaming\\exolvra-genesis\\config.json',
  );
  assert.equal(
    configPath({ platform: 'darwin', env: { HOME: '/Users/ada' } }),
    '/Users/ada/Library/Application Support/exolvra-genesis/config.json',
  );
  assert.equal(
    configPath({ platform: 'linux', env: { HOME: '/home/ada' } }),
    '/home/ada/.config/exolvra-genesis/config.json',
  );
  assert.equal(
    configPath({ platform: 'linux', env: { HOME: '/home/ada', XDG_CONFIG_HOME: '/xdg' } }),
    '/xdg/exolvra-genesis/config.json',
  );
  // A relative XDG_CONFIG_HOME is not a location; the convention says ignore it.
  assert.equal(
    configPath({ platform: 'linux', env: { HOME: '/home/ada', XDG_CONFIG_HOME: 'relative' } }),
    '/home/ada/.config/exolvra-genesis/config.json',
  );
  assert.equal(
    configDir({ platform: 'linux', env: { HOME: '/home/ada' } }),
    '/home/ada/.config/exolvra-genesis',
  );

  // The answer is the same wherever it is asked from: nothing here reads the
  // machine running the test, so every case above holds on every runner.
  for (const platform of ['win32', 'darwin', 'linux']) {
    const answer = configDir({ platform, env: { HOME: '/home/ada', APPDATA: 'C:\\ada' } });
    assert.equal(
      answer.includes('AppData\\Roaming') || !answer.includes('AppData'),
      true,
      platform + ' mixed one convention into another: ' + answer,
    );
  }
});

test('a real environment lands where that OS keeps config, and nowhere else', () => {
  // The bug this pins: on Linux the answer must be XDG or ~/.config, never a
  // path with a Windows suffix bolted onto a Linux home.
  const linux = configDir({ platform: 'linux', env: { HOME: '/home/runner' } });
  assert.equal(linux, '/home/runner/.config/exolvra-genesis');
  assert.equal(linux.includes('AppData'), false, linux);
  assert.equal(linux.includes('\\'), false, 'a Linux path carried a backslash: ' + linux);

  const mac = configDir({ platform: 'darwin', env: { HOME: '/Users/runner' } });
  assert.equal(mac.includes('AppData'), false, mac);
  assert.equal(mac.includes('\\'), false, 'a macOS path carried a backslash: ' + mac);

  const windows = configDir({
    platform: 'win32',
    env: { APPDATA: 'C:\\Users\\runner\\AppData\\Roaming' },
  });
  assert.equal(windows, 'C:\\Users\\runner\\AppData\\Roaming\\exolvra-genesis');
  assert.equal(windows.includes('/'), false, 'a Windows path carried a forward slash: ' + windows);
});

// ---------------------------------------------------------------------------
// Reading and writing it
// ---------------------------------------------------------------------------

test('choices round-trip through a config file created on first save', (t) => {
  const { env } = tempHome(t);
  const path = configPath({ env });
  assert.equal(existsSync(path), false);

  const choices = {
    input: 'specs/demo.md',
    models: { lead: 'claude-opus-5', builder: 'sonnet', critic: 'haiku' },
    auto: true,
  };
  const written = saveConfig(configFromChoices(choices), { env });

  assert.equal(written, path);
  assert.equal(existsSync(path), true);
  assert.deepEqual(loadConfig({ env, warn: noNotices }), { models: choices.models, auto: true });

  // The goal is deliberately not among them: it belongs to one run, and a stale
  // one pre-filled into the next is an invitation to launch the wrong thing.
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort(), ['auto', 'models']);
});

test('loadConfig is a pure read', (t) => {
  const { env } = tempHome(t);
  const collected = collectWarnings();

  // Nothing there yet: defaults, no notice, and still nothing there.
  assert.deepEqual(loadConfig({ env, warn: collected.warn }), {});
  assert.deepEqual(collected.messages, []);
  assert.equal(existsSync(configPath({ env })), false);
  assert.equal(existsSync(configDir({ env })), false);

  saveConfig({ auto: false }, { env });
  const before = statSync(configPath({ env })).mtimeMs;
  const body = readFileSync(configPath({ env }), 'utf8');
  loadConfig({ env, warn: collected.warn });
  loadConfig({ env, warn: collected.warn });
  assert.equal(statSync(configPath({ env })).mtimeMs, before);
  assert.equal(readFileSync(configPath({ env }), 'utf8'), body);
});

test('a malformed config degrades to defaults with a notice', (t) => {
  const { env } = tempHome(t);
  const path = configPath({ env });
  mkdirSync(dirname(path), { recursive: true });

  for (const body of ['{ not json', '[]', 'null', '"a string"', '42']) {
    writeFileSync(path, body, 'utf8');
    const collected = collectWarnings();
    assert.deepEqual(loadConfig({ env, warn: collected.warn }), {}, 'for body ' + body);
    assert.equal(collected.messages.length, 1, 'expected one notice for ' + body);
    assert.match(collected.messages[0], /^exolvra-genesis: the config at /);
    assert.ok(collected.messages[0].includes(path));
    // Degraded, not repaired: the file the user can fix is still the file.
    assert.equal(readFileSync(path, 'utf8'), body);
  }
});

test('an unreadable config degrades to defaults with a notice', (t) => {
  const { env } = tempHome(t);
  // A directory where the file should be: readable location, unusable config.
  mkdirSync(configPath({ env }), { recursive: true });
  const collected = collectWarnings();
  assert.deepEqual(loadConfig({ env, warn: collected.warn }), {});
  assert.equal(collected.messages.length, 1);
  assert.match(collected.messages[0], /could not be read/);
});

test('a config naming something no role accepts keeps the rest of it', (t) => {
  const { env } = tempHome(t);
  const path = configPath({ env });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      models: { lead: 'claude-opus-3', builder: 'gpt-4', critic: 7 },
      auto: 'yes please',
    }),
    'utf8',
  );

  const collected = collectWarnings();
  const config = loadConfig({ env, warn: collected.warn });

  assert.deepEqual(config, {}, 'nothing in that file was usable');
  assert.equal(collected.messages.length, 4, collected.messages.join('\n'));
  assert.ok(collected.messages.some((m) => m.includes('"claude-opus-3"') && m.includes('lead')));
  assert.ok(collected.messages.some((m) => m.includes('"gpt-4"') && m.includes('not a model family')));
  assert.ok(collected.messages.some((m) => m.includes('critic')));
  assert.ok(collected.messages.some((m) => m.includes('non-boolean "auto"')));
});

test('a config from when both subagent roles took ids is read forward', (t) => {
  // The old shape said what the user wanted; it was only wrong about what the
  // provider can be told. Demoting both roles to inherit would throw the
  // preference away without ever saying it had one.
  const { env } = tempHome(t);
  const path = configPath({ env });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      models: { lead: 'claude-opus-5', builder: 'claude-sonnet-5', critic: 'CLAUDE-HAIKU-4-5' },
      auto: true,
    }),
    'utf8',
  );

  const collected = collectWarnings();
  assert.deepEqual(loadConfig({ env, warn: collected.warn }), {
    models: { lead: 'claude-opus-5', builder: 'sonnet', critic: 'haiku' },
    auto: true,
  });
  assert.equal(collected.messages.length, 2, collected.messages.join('\n'));
  assert.match(collected.messages[0], /"claude-sonnet-5" as the builder model.*reading it as "sonnet"/);
  assert.match(collected.messages[1], /"claude-haiku-4-5" as the critic model.*reading it as "haiku"/);

  // Read forward, not rewritten: loading still leaves the file exactly as found.
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).models.builder, 'claude-sonnet-5');
});

test('what loads round-trips back out unchanged and silently', (t) => {
  const { env } = tempHome(t);
  const path = configPath({ env });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ models: { lead: 'claude-opus-5', builder: 'claude-sonnet-5', critic: 'haiku' } }),
    'utf8',
  );

  // Whatever the migration produced must be something saveConfig accepts —
  // otherwise the first run to save its answers dies on its own config.
  const migrated = loadConfig({ env, warn: collectWarnings().warn });
  saveConfig(migrated, { env });
  assert.deepEqual(loadConfig({ env, warn: noNotices }), migrated);
});

test('a config with a byte-order mark still loads', (t) => {
  // PowerShell's `>` and Notepad both write one, and a user who hand-edits their
  // config on Windows gets one for free. JSON.parse rejects it.
  const { env } = tempHome(t);
  const path = configPath({ env });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    '﻿' + JSON.stringify({ models: DEFAULT_MODEL_CHOICE, auto: true }),
    'utf8',
  );

  assert.equal(readFileSync(path, 'utf8').charCodeAt(0), 0xfeff, 'the fixture lost its BOM');
  assert.deepEqual(loadConfig({ env, warn: noNotices }), {
    models: DEFAULT_MODEL_CHOICE,
    auto: true,
  });
});

test('saveConfig persists only what the flags would accept', (t) => {
  const { env } = tempHome(t);

  // An id where the SDK can only carry a family: refused, loudly, rather than
  // written for a later run to choke on.
  let thrown;
  try {
    saveConfig(
      { models: { lead: 'claude-opus-5', builder: 'claude-sonnet-5', critic: MODEL_INHERIT } },
      { env },
    );
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ConfigError, 'expected a ConfigError');
  assert.match(thrown.message, /as the builder model: not a model family/);
  // The refusal names the family the user meant, in the flag boundary's words.
  assert.match(thrown.message, /use "sonnet", the family claude-sonnet-5 belongs to/);

  // A family where the session needs a versioned id: refused too.
  assert.throws(
    () => saveConfig({ models: { lead: 'opus', builder: 'opus', critic: 'opus' } }, { env }),
    ConfigError,
  );
  assert.throws(
    () => saveConfig({ models: { lead: 'gpt-4', builder: MODEL_INHERIT, critic: MODEL_INHERIT } }, { env }),
    ConfigError,
  );

  assert.equal(existsSync(configPath({ env })), false, 'a rejected config must create nothing');
});

test('saving twice leaves one config and no temporary files', (t) => {
  const { env } = tempHome(t);
  saveConfig({ auto: true }, { env });
  saveConfig({ auto: false }, { env });
  assert.deepEqual(loadConfig({ env, warn: noNotices }), { auto: false });
  // The write goes through a temp file and a rename, so a run that dies
  // mid-write leaves the previous config intact rather than a broken one.
  assert.deepEqual(readdirSync(configDir({ env })), ['config.json']);
});

// ---------------------------------------------------------------------------
// The saved config becomes the next run's defaults
// ---------------------------------------------------------------------------

test('every answer the pickers can give is one the run can act on', async (t) => {
  // The end of the road for these values is the agent builder, and it accepts
  // families only. Walking each row of each family picker and building the real
  // definitions is the check that the two pickers and the SDK agree — the check
  // that would have caught offering versions here in the first place.
  const { env } = tempHome(t);
  const sources = loadPluginSources({});

  for (let row = 0; row < AGENT_MODELS.length; row += 1) {
    const io = fakeTty();
    const driver = (async () => {
      await waitFor(io, 'What are we building?');
      io.input.write('specs/demo.md');
      await waitFor(io, 'specs/demo.md');
      await press(io, ENTER);
      await waitFor(io, 'Lead model');
      await press(io, ENTER);
      for (const message of ['Builder model family', 'Critic model family']) {
        await waitFor(io, message);
        for (let step = 0; step < row; step += 1) await press(io, DOWN);
        await press(io, ENTER);
      }
      await waitFor(io, 'Review the bar');
      await press(io, ENTER);
    })();

    const choices = await promptStartup({}, { input: io.input, output: io.output });
    await driver;

    const definitions = buildAgentDefinitions(sources, choices.models);
    assert.equal(definitions['exolvra-genesis-builder'].model, AGENT_MODELS[row]);
    assert.equal(definitions['exolvra-genesis-critic'].model, AGENT_MODELS[row]);

    // And the same answers survive a trip through the config file, which is how
    // they reach the run after this one.
    saveConfig(configFromChoices(choices), { env });
    const reloaded = loadConfig({ env, warn: noNotices });
    assert.deepEqual(reloaded.models, choices.models);
    buildAgentDefinitions(sources, reloaded.models);
  }
});

test('a saved config pre-selects the pickers and the mode', async (t) => {
  const { env } = tempHome(t);
  const saved = { lead: 'claude-opus-5', builder: 'sonnet', critic: 'haiku' };
  saveConfig(configFromChoices({ models: saved, auto: true }), { env });

  const io = fakeTty();
  const streams = { input: io.input, output: io.output };

  const driver = (async () => {
    await waitFor(io, 'What are we building?');
    io.input.write('specs/demo.md');
    await waitFor(io, 'specs/demo.md');
    await press(io, ENTER);
    // Every answer below is Enter, and nothing else: whatever comes back was
    // already selected when the question appeared.
    await waitFor(io, 'Lead model');
    await press(io, ENTER);
    await waitFor(io, 'Builder model');
    await press(io, ENTER);
    await waitFor(io, 'Critic model');
    await press(io, ENTER);
    await waitFor(io, 'Review the bar');
    await press(io, ENTER);
  })();

  const choices = await promptStartup(loadConfig({ env, warn: noNotices }), streams);
  await driver;

  assert.deepEqual(choices, { input: 'specs/demo.md', models: saved, auto: true });

  const drawn = frames(io.raw()).join('\n');
  assert.ok(drawn.includes('◇  Lead model\n│  Claude Opus 5'), drawn);
  assert.ok(drawn.includes('◇  Builder model family\n│  Sonnet'), drawn);
  assert.ok(drawn.includes('◇  Critic model family\n│  Haiku'), drawn);
  // auto:true means the review pause is off, so "No" is the answer on offer.
  assert.ok(drawn.includes('│  ○ Yes / ● No'), drawn);
});

test('each picker offers exactly what its own flag accepts', async () => {
  // The failure this guards against is quiet: a picker that offers an id for a
  // subagent role hands back a value the CLI itself rejects, and the run dies
  // after the questions were answered rather than before they were asked.
  const io = fakeTty();
  const driver = (async () => {
    await waitFor(io, 'What are we building?');
    io.input.write('specs/demo.md');
    await waitFor(io, 'specs/demo.md');
    await press(io, ENTER);
    for (const message of ['Lead model', 'Builder model family', 'Critic model family']) {
      await waitFor(io, message);
      await press(io, DOWN);
      await press(io, ENTER);
    }
    await waitFor(io, 'Review the bar');
    await press(io, ENTER);
  })();

  const choices = await promptStartup({}, { input: io.input, output: io.output });
  await driver;

  // One row down from inherit in each picker: an id for the lead, a family for
  // the two roles the SDK can only pin to one.
  assert.equal(isKnownModel(choices.models.lead), true, choices.models.lead);
  assert.equal(asAgentModel(choices.models.lead), undefined, 'the lead takes a version');
  for (const role of ['builder', 'critic']) {
    assert.equal(asAgentModel(choices.models[role]), choices.models[role], role);
  }

  // And the rows themselves: the family pickers list the families and nothing
  // else, so no keystroke down the list can reach a version.
  const drawn = frames(io.raw()).join('\n');
  const expected = AGENT_MODELS.map((family) => family[0].toUpperCase() + family.slice(1)).sort();
  for (const role of ['Builder', 'Critic']) {
    const picker = drawn.slice(
      drawn.indexOf('◆  ' + role + ' model family'),
      drawn.indexOf('◇  ' + role + ' model family'),
    );
    const offered = picker
      .split('\n')
      .filter((line) => /^│ {2}[●○] /.test(line))
      .map((line) => line.slice(5).replace(/ \(.*\)$/, ''));
    assert.ok(offered.length > 0, 'found no option rows for ' + role + ':\n' + picker);
    assert.deepEqual([...new Set(offered)].sort(), expected, role + ' picker:\n' + picker);
  }
});

test('with nothing saved, every picker starts on inherit', async () => {
  const io = fakeTty();
  const driver = (async () => {
    await waitFor(io, 'What are we building?');
    io.input.write('ship the checkout flow');
    await waitFor(io, 'ship the checkout flow');
    await press(io, ENTER);
    for (const message of [
      'Lead model',
      'Builder model family',
      'Critic model family',
      'Review the bar',
    ]) {
      await waitFor(io, message);
      await press(io, ENTER);
    }
  })();

  const choices = await promptStartup({}, { input: io.input, output: io.output });
  await driver;

  assert.deepEqual(choices, {
    input: 'ship the checkout flow',
    models: DEFAULT_MODEL_CHOICE,
    auto: false,
  });
  assert.ok(frames(io.raw()).join('\n').includes('│  ● Yes / ○ No'));
});

// ---------------------------------------------------------------------------
// The frames a run draws
// ---------------------------------------------------------------------------

test('a step that fails says so and lets the failure through', async () => {
  const io = fakeTty();
  const streams = { input: io.input, output: io.output };
  const boom = new Error('the SDK went away');

  await assert.rejects(
    () =>
      trackStep(
        'Capturing the bar',
        'Bar captured',
        async () => {
          throw boom;
        },
        streams,
      ),
    (error) => error === boom,
  );

  const drawn = frames(io.raw()).join('\n');
  assert.ok(drawn.includes('Capturing the bar — failed'), drawn);
  // A spinner that simply stopped would read as success.
  assert.ok(!drawn.includes('Bar captured'), drawn);
});

// ---------------------------------------------------------------------------
// The evidence: the real flow, rendered
// ---------------------------------------------------------------------------

test('the startup flow renders, end to end, into a transcript', async (t) => {
  const { env } = tempHome(t, 'g-');
  const io = fakeTty();
  const streams = { input: io.input, output: io.output };

  // The frame belongs to the run rather than to the questionnaire, so the run
  // is what opens it — including on the runs that go on to ask nothing.
  beginRun('exolvra-genesis run', streams);

  const driver = (async () => {
    await waitFor(io, 'What are we building?');
    io.input.write('specs/checkout-flow.md');
    await waitFor(io, 'specs/checkout-flow.md');
    await press(io, ENTER);

    await waitFor(io, 'Lead model');
    await press(io, DOWN); // Claude Opus 5
    await press(io, ENTER);

    await waitFor(io, 'Builder model family');
    await press(io, DOWN);
    await press(io, DOWN); // Sonnet
    await press(io, ENTER);

    await waitFor(io, 'Critic model family');
    await press(io, DOWN);
    await press(io, DOWN);
    await press(io, DOWN); // Haiku
    await press(io, ENTER);

    await waitFor(io, 'Review the bar');
    await press(io, ENTER); // Yes — review the bar first
  })();

  const choices = await promptStartup(loadConfig({ env, warn: noNotices }), streams);
  await driver;

  assert.deepEqual(choices, {
    input: 'specs/checkout-flow.md',
    models: { lead: 'claude-opus-5', builder: 'sonnet', critic: 'haiku' },
    auto: false,
  });

  noteRunPlan(
    [
      { label: 'goal', value: choices.input },
      { label: 'lead', value: choices.models.lead },
      { label: 'builder', value: choices.models.builder },
      { label: 'critic', value: choices.models.critic },
      { label: 'mode', value: choices.auto ? 'auto' : 'review the bar first' },
    ],
    'Run plan',
    streams,
  );

  // Real work under the spinner: the answers above are written to the real
  // config file and read back, so the next run starts from them.
  const path = await trackStep(
    'Saving your choices',
    'Choices saved',
    async () => saveConfig(configFromChoices(choices), { env }),
    streams,
  );
  assert.equal(path, configPath({ env }));
  assert.deepEqual(loadConfig({ env, warn: noNotices }), { models: choices.models, auto: false });

  // What a run does next is capture the bar, and that is an SDK call — the one
  // boundary the bar's anti-simulation rule lets a test stand in for. The
  // spinner below is the real one; only the work behind it is substituted, and
  // it runs long enough that the animation itself reaches the transcript.
  await trackStep('Capturing the bar', 'Bar captured', () => sleep(320), streams);

  // Two rounds' worth of the line a round gets, one of each verdict.
  logVerdict('piece 1/6  round 1  WIN   no gap', 'win', streams);
  logVerdict('piece 2/6  round 1  LOSS  spacing is 4px tighter than the bar', 'loss', streams);
  endRun('Done — ' + choices.input, streams);

  const drawn = frames(io.raw());
  mkdirSync(dirname(EVIDENCE), { recursive: true });
  writeFileSync(EVIDENCE, drawn.join('\n') + '\n', 'utf8');

  // The transcript is worth nothing if it was drawn in the ASCII fallback set,
  // so the frames it must contain are named here rather than eyeballed later.
  const transcript = drawn.join('\n');
  assert.equal(drawn[0], '┌  exolvra-genesis run');
  for (const glyph of ['◆', '◇', '│', '└', '●', '○', '▲', '╮', '╯', '├']) {
    assert.ok(transcript.includes(glyph), 'the transcript is missing ' + glyph);
  }
  assert.ok(transcript.includes('↑/↓ to navigate • Enter: confirm'));
  assert.ok(transcript.includes('◆  What are we building?'));
  assert.ok(transcript.includes('◆  Lead model'));
  assert.ok(transcript.includes('◆  Builder model family'));
  assert.ok(transcript.includes('◆  Critic model family'));
  // The transcript has to show the two vocabularies, because that is the thing
  // a reader would otherwise assume is a mistake.
  assert.ok(transcript.includes('◇  Lead model\n│  Claude Opus 5'));
  assert.ok(transcript.includes('◇  Builder model family\n│  Sonnet'));
  assert.ok(transcript.includes('◇  Critic model family\n│  Haiku'));
  assert.ok(transcript.includes('◆  Review the bar before the loop starts?'));
  assert.ok(transcript.includes('◇  Run plan '));
  assert.ok(transcript.includes('◇  Choices saved'));
  assert.match(transcript, /[◒◐◓◑] {2}Capturing the bar/, 'the spinner never animated');
  assert.ok(transcript.includes('◇  Bar captured'));
  assert.equal(drawn[drawn.length - 1], '└  Done — specs/checkout-flow.md');
  // Nothing may run off the edge of the terminal it claimed to be drawn on.
  // Lines carrying the text cursor are the exception: they are one line redrawn
  // per keystroke, which collapsing a redraw stream to text runs together.
  for (const line of drawn.filter((candidate) => !candidate.includes('█'))) {
    assert.ok(line.length <= 80, 'line wider than the terminal: ' + line);
  }
});
