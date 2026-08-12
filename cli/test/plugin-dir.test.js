import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ConfigError } from '../dist/exit.js';
import {
  PACKAGED_PLUGIN_SUBDIR,
  PLUGIN_DIR_ENV,
  PLUGIN_FILES,
  loadPluginSources,
  pluginDirCandidates,
} from '../dist/plugin-dir.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Returns the error a call threw, failing the test when it threw nothing. */
function caught(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return assert.fail('expected the call to throw');
}

/** Writes a plugin directory holding `present` files only. */
function makePluginDir(present = Object.values(PLUGIN_FILES)) {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-plugin-'));
  for (const relative of present) {
    const file = join(dir, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'body of ' + relative + '\n', 'utf8');
  }
  return dir;
}

/** Where the built package carries its own copy of the three files. */
const PACKAGED = resolve(PACKAGE_ROOT, 'dist', PACKAGED_PLUGIN_SUBDIR);

test('candidates are the package root, the repo root, then the shipped copy', () => {
  const candidates = pluginDirCandidates({});
  assert.deepEqual(candidates, [resolve(PACKAGE_ROOT), resolve(REPO_ROOT), PACKAGED]);
});

test('the shipped copy is really there, and is the repository files verbatim', () => {
  // What makes an installed package able to load the markdown at all: the
  // build puts the three files inside dist/, which is what the package ships.
  for (const relative of Object.values(PLUGIN_FILES)) {
    assert.equal(
      readFileSync(join(PACKAGED, relative), 'utf8'),
      readFileSync(join(REPO_ROOT, relative), 'utf8'),
      relative + ' shipped as something other than the file it was copied from',
    );
  }
});

test('GAUNTLET_PLUGIN_DIR replaces the candidate list entirely', () => {
  const dir = makePluginDir();
  assert.deepEqual(pluginDirCandidates({ [PLUGIN_DIR_ENV]: dir }), [resolve(dir)]);
});

test('an empty GAUNTLET_PLUGIN_DIR falls back to the default candidates', () => {
  assert.deepEqual(pluginDirCandidates({ [PLUGIN_DIR_ENV]: '   ' }), [
    resolve(PACKAGE_ROOT),
    resolve(REPO_ROOT),
    PACKAGED,
  ]);
});

test('the override is honoured and the files are read from it', () => {
  const dir = makePluginDir();
  const sources = loadPluginSources({ [PLUGIN_DIR_ENV]: dir });
  assert.equal(sources.dir, resolve(dir));
  assert.equal(sources.runMd, 'body of ' + PLUGIN_FILES.runMd + '\n');
  assert.equal(sources.builderMd, 'body of ' + PLUGIN_FILES.builderMd + '\n');
  assert.equal(sources.criticMd, 'body of ' + PLUGIN_FILES.criticMd + '\n');
});

test('the repo root resolves when running from source', () => {
  const sources = loadPluginSources({});
  assert.equal(sources.dir, resolve(REPO_ROOT));
  assert.match(sources.runMd, /Step 0/);
  assert.match(sources.builderMd, /name: gauntlet-builder/);
  assert.match(sources.criticMd, /name: gauntlet-critic/);
});

test('a missing file under the override is a ConfigError naming the path', () => {
  // Everything but one, so the message has exactly one file to name.
  const dir = makePluginDir(
    Object.values(PLUGIN_FILES).filter((file) => file !== PLUGIN_FILES.criticMd),
  );
  const error = caught(() => loadPluginSources({ [PLUGIN_DIR_ENV]: dir }));
  assert.ok(error instanceof ConfigError);
  assert.match(error.message, /could not load the Gauntlet plugin markdown/);
  assert.ok(
    error.message.includes(resolve(dir)),
    'expected the message to name the directory it looked in',
  );
  assert.ok(
    error.message.includes('missing ' + PLUGIN_FILES.criticMd),
    'expected the message to name the missing file',
  );
  assert.match(error.message, new RegExp('Point ' + PLUGIN_DIR_ENV + ', or --plugin-dir'));
});

test('an override that names a file says so, rather than blaming a missing file', () => {
  const dir = makePluginDir([PLUGIN_FILES.runMd]);
  const file = join(dir, PLUGIN_FILES.runMd);
  const error = caught(() => loadPluginSources({ [PLUGIN_DIR_ENV]: file }));
  assert.ok(error instanceof ConfigError);
  assert.ok(error.message.includes(resolve(file)));
  assert.match(error.message, /is not a directory/);
});

test('an override that does not exist says so', () => {
  const dir = join(tmpdir(), 'gauntlet-absent-' + Date.now());
  const error = caught(() => loadPluginSources({ [PLUGIN_DIR_ENV]: dir }));
  assert.match(error.message, /does not exist/);
});

test('a directory with none of the files is a ConfigError', () => {
  const dir = makePluginDir([]);
  assert.throws(() => loadPluginSources({ [PLUGIN_DIR_ENV]: dir }), {
    name: 'ConfigError',
  });
});

test('a directory that does not exist at all is a ConfigError', () => {
  const dir = join(tmpdir(), 'gauntlet-does-not-exist-' + Date.now());
  const error = caught(() => loadPluginSources({ [PLUGIN_DIR_ENV]: dir }));
  assert.ok(error instanceof ConfigError);
  assert.ok(error.message.includes(resolve(dir)));
});

/* -------------------------------------------------------------------------- */
/* A file that is there and cannot be read                                     */
/* -------------------------------------------------------------------------- */

/** Denies read on `file` for this user, and says whether that worked. */
function denyRead(file) {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME ?? process.env.USER ?? '';
    spawnSync('icacls', [file, '/inheritance:r'], { encoding: 'utf8' });
    spawnSync('icacls', [file, '/deny', user + ':(R)'], { encoding: 'utf8' });
  } else {
    chmodSync(file, 0o000);
  }
  try {
    readFileSync(file, 'utf8');
    return false;
  } catch {
    return true;
  }
}

/** Undoes {@link denyRead}, so the temp tree can be cleaned up. */
function allowRead(file) {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME ?? process.env.USER ?? '';
    spawnSync('icacls', [file, '/remove:d', user], { encoding: 'utf8' });
    spawnSync('icacls', [file, '/grant', user + ':(F)'], { encoding: 'utf8' });
  } else {
    chmodSync(file, 0o600);
  }
}

test('a file that exists but cannot be read is a ConfigError, not a raw errno', (t) => {
  // The distinction that decides the exit code: existence was already checked,
  // so a failure here is a fault the loader has to name itself. Left unguarded
  // it escapes as a Node error, and an unclassified error is not a
  // configuration error — it would exit 1, telling CI a run lost when no run
  // ever started.
  const dir = makePluginDir();
  const file = join(dir, PLUGIN_FILES.runMd);
  if (!denyRead(file)) {
    t.skip('this user can read the file regardless of its permissions');
    return;
  }
  after(() => allowRead(file));

  const error = caught(() => loadPluginSources({ [PLUGIN_DIR_ENV]: dir }));
  assert.ok(error instanceof ConfigError, 'an unreadable file must be a ConfigError');
  assert.match(error.message, /could not read the Gauntlet plugin markdown/);
  assert.ok(
    error.message.includes(PLUGIN_FILES.runMd),
    'the error must name which file could not be read: ' + error.message,
  );
  assert.ok(
    error.message.includes(resolve(dir)),
    'the error must name where it looked: ' + error.message,
  );
  assert.match(error.message, new RegExp(PLUGIN_DIR_ENV));
});
