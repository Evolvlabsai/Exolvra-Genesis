import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { after, test } from 'node:test';

import { splitFrontmatter } from '../dist/agents.js';
import { EXIT } from '../dist/exit.js';
import { PLUGIN_FILES, loadPluginSources } from '../dist/plugin-dir.js';
import { PACKAGE_ROOT, REPO_ROOT, createSandbox, run } from './run-cli.js';

const SRC = join(PACKAGE_ROOT, 'src');
const PKG = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
const TSCONFIG = readFileSync(join(PACKAGE_ROOT, 'tsconfig.json'), 'utf8');

function walk(dir, extension) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, extension));
    else if (extname(full) === extension) out.push(full);
  }
  return out;
}

const SOURCE_FILES = walk(SRC, '.ts').map((path) => ({
  path,
  text: readFileSync(path, 'utf8'),
}));

const collapse = (text) => text.replace(/\s+/g, ' ').trim();

test('C1: the package declares Node >= 18, an exolvra-genesis bin, and strict TypeScript', () => {
  assert.ok(PKG.engines.node.includes('18'), 'engines.node must pin >= 18');
  assert.equal(PKG.bin['exolvra-genesis'], 'dist/cli.js');
  assert.match(TSCONFIG, /"strict":\s*true/);
  assert.ok(SOURCE_FILES.length > 0, 'expected TypeScript sources under src/');
});

/**
 * G2, in the words the bar states it in: runtime `dependencies` are a subset of
 * the Claude Agent SDK plus **at most one** terminal-prompt library.
 *
 * The prompt libraries are named one at a time rather than recognised by the
 * shape of a package name. Nothing infers "this is a prompt library" from a
 * string, so a second runtime dependency cannot let itself in by being called
 * something plausible — adding one means editing this list, in a file a critic
 * reads, which is the point of the gate.
 */
const SDK = '@anthropic-ai/claude-agent-sdk';
const PROMPT_LIBRARIES = ['@clack/prompts', 'enquirer', 'inquirer', 'prompts'];

/** How `names` violates G2, or undefined when it satisfies G2. */
function violatesG2(names) {
  if (!names.includes(SDK)) return 'the Claude Agent SDK is not a runtime dependency';
  const prompts = names.filter((name) => PROMPT_LIBRARIES.includes(name));
  const others = names.filter((name) => name !== SDK && !prompts.includes(name));
  if (others.length > 0) {
    return 'neither the SDK nor a terminal-prompt library: ' + others.join(', ');
  }
  if (prompts.length > 1) {
    return 'more than one terminal-prompt library: ' + prompts.join(', ');
  }
  return undefined;
}

test('C2: runtime deps are the SDK plus at most one terminal-prompt library', () => {
  const names = Object.keys(PKG.dependencies ?? {});
  assert.equal(
    violatesG2(names),
    undefined,
    'package.json declares ' + names.join(', '),
  );

  // The manifest is a claim; what is on disk is the dependency. Every name it
  // declares is really installed, so a runtime dependency cannot be satisfied
  // by a line in a file.
  for (const name of names) {
    assert.ok(
      existsSync(join(PACKAGE_ROOT, 'node_modules', name, 'package.json')),
      name + ' is declared as a runtime dependency but is not installed',
    );
  }
});

test('C2: the check that guards G2 rejects what G2 forbids', () => {
  // The guard above is worth exactly what it refuses, so what it refuses is
  // exercised here rather than assumed — the same way every declared value type
  // is driven with a value it says can never be valid. Each list below is one
  // step from a list that passes.
  for (const names of [[SDK], [SDK, '@clack/prompts'], ['@clack/prompts', SDK]]) {
    assert.equal(
      violatesG2(names),
      undefined,
      names.join(', ') + ' satisfies G2 but the guard rejected it',
    );
  }

  for (const names of [
    [], // nothing at all: the SDK is required, not merely permitted
    ['@clack/prompts'], // a prompt library and no SDK
    [SDK, 'chalk'], // a second runtime dependency
    [SDK, 'string-width'], // the one the width table in usage.ts would have taken
    [SDK, '@clack/prompts', 'chalk'], // one alongside the permitted prompt library
    [SDK, '@clack/prompts', 'inquirer'], // two prompt libraries
  ]) {
    assert.notEqual(
      violatesG2(names),
      undefined,
      names.join(', ') + ' violates G2 but the guard accepted it',
    );
  }

  // And through the same path the real check takes: the shipped manifest,
  // parsed, with one dependency added that G2 does not allow. Nothing is
  // written — the copy exists only to be refused.
  const mutated = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  mutated.dependencies = { ...mutated.dependencies, chalk: '^5.4.1' };
  assert.notEqual(
    violatesG2(Object.keys(mutated.dependencies)),
    undefined,
    'an extra runtime dependency added to the real manifest was accepted',
  );
});

test('C3: the plugin markdown is read from disk at runtime', () => {
  const sources = loadPluginSources({});
  for (const relative of Object.values(PLUGIN_FILES)) {
    assert.ok(
      readFileSync(join(sources.dir, relative), 'utf8').length > 0,
      relative + ' must exist on disk to be loaded',
    );
  }
  assert.ok(sources.runMd.includes('$ARGUMENTS'), 'run.md is loaded verbatim, placeholder included');
});

test('C3: no source file restates the loop from the plugin markdown', () => {
  const sources = loadPluginSources({});
  const haystack = collapse(SOURCE_FILES.map((file) => file.text).join('\n'));

  for (const [key, relative] of Object.entries(PLUGIN_FILES)) {
    const body = splitFrontmatter(sources[key]).body;
    const sentences = body
      .split('\n')
      .map(collapse)
      .filter((line) => line.length >= 45);
    assert.ok(sentences.length > 5, 'expected prose to compare against in ' + relative);

    for (const sentence of sentences) {
      assert.ok(
        !haystack.includes(sentence),
        relative + ' line is restated in cli/src: ' + sentence,
      );
    }
  }
});

test('C3: the built output does not inline the plugin markdown', () => {
  const sources = loadPluginSources({});
  const dist = walk(join(PACKAGE_ROOT, 'dist'), '.js')
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  const collapsedDist = collapse(dist);
  for (const key of Object.keys(PLUGIN_FILES)) {
    const longest = splitFrontmatter(sources[key])
      .body.split('\n')
      .map(collapse)
      .filter((line) => line.length >= 45)
      .sort((a, b) => b.length - a.length)[0];
    assert.ok(!collapsedDist.includes(longest), 'dist embeds plugin prose: ' + longest);
  }
});

/**
 * The one module allowed to reach the network.
 *
 * C2 of `docs/specs/issue-runner-spec.md` amends this gate deliberately and
 * narrowly. The CLI has to talk to the GitHub REST API, so "no fetch anywhere
 * in `src/`" becomes "no fetch outside `src/github.ts`" — the boundary moves
 * from *nothing* to *one file*, and stays mechanically enforced either way. A
 * request that grows in a second module is what this catches, and a critic
 * reading the gate can see the whole of the exemption on one line.
 */
const NETWORK_MODULE = join(SRC, 'github.ts');

/** Reaching the network: banned in every source file but {@link NETWORK_MODULE}. */
const NETWORK_PATTERNS = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /from\s+['"]node:https?['"]/,
  /require\(\s*['"]node:https?['"]\s*\)/,
  /from\s+['"](node:)?(net|dgram|http|https)['"]/,
];

/**
 * The single thing the network module is exempted for: the platform's own
 * fetch, which is what C2 says GitHub access uses. The exemption is not "this
 * file may do anything" — a socket opened by hand, or a client library pulled
 * in, is refused there exactly as it is everywhere else.
 */
const PERMITTED_AT_THE_BOUNDARY = [/\bfetch\s*\(/];

/** Banned in every source file, the network module included. */
const BANNED_EVERYWHERE = [
  /\b(axios|node-fetch|undici|got)\b/,
  /\btelemetry\b/i,
  /\banalytics\b/i,
];

const permitted = (pattern) =>
  PERMITTED_AT_THE_BOUNDARY.some((allowed) => String(allowed) === String(pattern));

/** How `text` at `path` breaks the gate, or `undefined` when it does not. */
function networkViolation(path, text) {
  for (const pattern of BANNED_EVERYWHERE) {
    if (pattern.test(text)) return 'matches a banned pattern: ' + pattern;
  }
  for (const pattern of NETWORK_PATTERNS) {
    if (!pattern.test(text)) continue;
    if (path !== NETWORK_MODULE) {
      return 'reaches the network outside src/github.ts: ' + pattern;
    }
    if (!permitted(pattern)) {
      return 'the network module reaches the network with more than fetch: ' + pattern;
    }
  }
  return undefined;
}

test('C4/C2: network access lives in one module, and telemetry in none', () => {
  for (const file of SOURCE_FILES) {
    assert.equal(
      networkViolation(file.path, file.text),
      undefined,
      'cli/' + file.path.slice(PACKAGE_ROOT.length + 1),
    );
  }
});

test('C4/C2: the check that guards the boundary rejects what the boundary forbids', () => {
  // The gate is worth exactly what it refuses, so what it refuses is exercised
  // rather than assumed — the same way the G2 guard above is. Each line below
  // is one step from a line that passes.
  const elsewhere = join(SRC, 'commands', 'run.ts');

  assert.notEqual(
    networkViolation(elsewhere, 'const r = await fetch(url);'),
    undefined,
    'a fetch planted in another module was accepted',
  );
  assert.notEqual(
    networkViolation(elsewhere, "import { request } from 'node:https';"),
    undefined,
    'an https import planted in another module was accepted',
  );
  assert.equal(
    networkViolation(NETWORK_MODULE, 'const r = await fetch(url);'),
    undefined,
    'the one module allowed to fetch was refused for fetching',
  );
  assert.notEqual(
    networkViolation(NETWORK_MODULE, "import { createConnection } from 'node:net';"),
    undefined,
    'the network module was allowed a socket, which C2 does not exempt',
  );
  assert.notEqual(
    networkViolation(NETWORK_MODULE, "import got from 'got';"),
    undefined,
    'the network module was allowed a client library, which G3 forbids anywhere',
  );
  assert.notEqual(
    networkViolation(NETWORK_MODULE, 'const telemetry = true;'),
    undefined,
    'the network module was allowed telemetry, which is banned everywhere',
  );

  // And the module really is the file the exemption names, so a rename cannot
  // leave the exemption pointing at nothing while the suite still passes.
  assert.ok(
    SOURCE_FILES.some((file) => file.path === NETWORK_MODULE),
    'src/github.ts is the exempted module and must exist',
  );
});

test('C5: every command writes through the context, so its output is counted', () => {
  // The success contract — nothing exits 0 having printed nothing — is checked
  // in front of the process exit, over what was written to ctx.stdout. A module
  // that reached around it would not be counted, so no module does: only the
  // entry point names the process streams, and only to build the context.
  const entry = join(SRC, 'cli.ts');
  for (const file of SOURCE_FILES) {
    if (file.path === entry) continue;
    for (const pattern of [/\bconsole\.\w+\s*\(/, /\bprocess\.(stdout|stderr)\b/]) {
      assert.ok(
        !pattern.test(file.text),
        file.path + ' writes around the context stream: ' + pattern,
      );
    }
  }
  const cli = SOURCE_FILES.find((file) => file.path === entry);
  assert.ok(cli !== undefined, 'src/cli.ts must exist');
  assert.ok(!/\bconsole\.\w+\s*\(/.test(cli.text), 'src/cli.ts logs outside the context');
});

test('C5: real processes return 0 for a win, 1 for a loss, 2 for a bad invocation', () => {
  // The gate is the behaviour, not the constant: each code below came off a
  // child process, and the constant is then checked against them.
  const sandbox = createSandbox();
  after(() => sandbox.cleanup());

  const win = run(['--help']);
  assert.equal(win.code, 0, 'a command that succeeded must exit 0');

  const loss = sandbox.run(['plan', '--plugin-dir', REPO_ROOT, 'a goal'], {
    subtype: 'error_max_turns',
  });
  assert.equal(loss.code, 1, 'a budget-stopped run must exit 1: ' + loss.stderr);

  const usage = run(['plan', '-C', join(PACKAGE_ROOT, 'no-such-directory'), 'a goal']);
  assert.equal(usage.code, 2, 'a configuration error must exit 2: ' + usage.stderr);

  assert.deepEqual(EXIT, { WIN: win.code, LOSS: loss.code, USAGE: usage.code });
  assert.deepEqual(EXIT, { WIN: 0, LOSS: 1, USAGE: 2 });
});

test('G6: cli-spec.md is untouched', async () => {
  const { createHash } = await import('node:crypto');
  // Hashed over the content, not over the line endings.
  //
  // `.gitattributes` says `* text=auto`, so a checkout normalises them: a Linux
  // runner gets LF and a Windows runner gets CRLF for the very same commit. A
  // hash of the raw bytes therefore says the spec was edited every time it is
  // checked out on the other operating system, which is the one thing this gate
  // must never say by accident. The pin is the LF hash, and every checkout is
  // read back to it.
  const spec = readFileSync(join(PACKAGE_ROOT, 'cli-spec.md'), 'utf8').replace(
    /\r\n?/g,
    '\n',
  );
  assert.equal(
    createHash('sha256').update(spec, 'utf8').digest('hex'),
    '595276af32362726f16f24a538eb53511ad4bfe04b77bab483deb637eca15bdc',
  );
});
