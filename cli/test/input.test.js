import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { UsageError } from '../dist/exit.js';
import {
  expandHome,
  inputAsArgument,
  inputAsTyped,
  pathKind,
  requireDirectory,
  resolveInput,
} from '../dist/input.js';

const dir = mkdtempSync(join(tmpdir(), 'exolvra-genesis-input-'));
const specPath = join(dir, 'spec.md');
const subdir = join(dir, 'specs');
writeFileSync(specPath, '# Spec\n\nR1. Do the thing.\n', 'utf8');
mkdirSync(subdir);

/** Returns the error a call threw, failing the test when it threw nothing. */
function caught(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return assert.fail('expected the call to throw');
}

test('a path to an existing file resolves to a spec', () => {
  const input = resolveInput('spec.md', dir);
  assert.equal(input.kind, 'spec');
  assert.equal(input.path, specPath);
  assert.equal(input.given, 'spec.md');
  assert.match(input.text, /R1\. Do the thing\./);
});

test('an absolute path to an existing file resolves to a spec', () => {
  assert.equal(resolveInput(specPath, process.cwd()).kind, 'spec');
});

test('anything else resolves to a goal', () => {
  const input = resolveInput('a CLI indistinguishable from gh', dir);
  assert.equal(input.kind, 'goal');
  assert.equal(input.goal, 'a CLI indistinguishable from gh');
});

test('a goal is still a goal when it happens to contain a slash or a dot', () => {
  assert.equal(resolveInput('a settings page like linear.app', dir).kind, 'goal');
  assert.equal(resolveInput('a REST API for /users and /orders', dir).kind, 'goal');
  assert.equal(resolveInput('linear.app', dir).kind, 'goal');
  assert.equal(resolveInput('refactor', dir).kind, 'goal');
});

test('a bare word is a goal even when a directory happens to share its name', () => {
  // `specs/` exists in dir, but `specs` reads as prose, not as a path.
  assert.equal(resolveInput('specs', dir).kind, 'goal');
});

/*
 * The documented rule, pinned.
 *
 * `exolvra-genesis plan --help` says: a path to an existing file is read as a spec,
 * anything else is a one-line goal — and R1 says the CLI resolves the argument
 * exactly as the plugin does, whose Step 0 reads a path only when the file is
 * there. One rule, written in three places, so these tests exist to stop the
 * code drifting away from the two it does not compile.
 */

test('a path-shaped argument that does not exist is a goal, not an error', () => {
  for (const arg of [
    'src/app.tsx',
    'specs/not-here.md',
    './no-such-spec.md',
    join(dir, 'gone.md'),
    'C:\\nope\\spec.md',
  ]) {
    const input = resolveInput(arg, dir);
    assert.equal(input.kind, 'goal', arg + ' must resolve to a goal');
    assert.equal(input.goal, arg, arg + ' must survive as typed');
  }
});

test('a directory is a goal too: only an existing file is a spec', () => {
  const input = resolveInput(subdir, process.cwd());
  assert.equal(input.kind, 'goal');
  assert.equal(input.goal, subdir);
});

test('resolution is relative to the given cwd, not the process cwd', () => {
  assert.equal(resolveInput('spec.md', dir).kind, 'spec');
  assert.equal(resolveInput('spec.md', tmpdir()).kind, 'goal');
});

test('an empty or blank argument is a UsageError quoting what was passed', () => {
  assert.throws(() => resolveInput('', dir), UsageError);
  const error = caught(() => resolveInput('   ', dir, 'exolvra-genesis plan <x>'));
  assert.ok(error instanceof UsageError);
  assert.ok(error.message.includes('"   "'), 'the message must quote the argument');
  assert.match(error.message, /a goal, or a path to an existing spec file, is required/);
  assert.equal(error.usage, 'exolvra-genesis plan <x>');
});

test('a leading ~ is expanded, so a quoted home path is not looked for under cwd', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\someone' : '/home/someone';
  assert.equal(expandHome('~', home), home);
  assert.equal(expandHome('~/notes.md', home), join(home, 'notes.md'));
  assert.equal(expandHome('~\\notes.md', home), join(home, 'notes.md'));
  // Not an expansion: `~notes` is a filename, and a ~ inside the path is data.
  assert.equal(expandHome('~notes.md', home), '~notes.md');
  assert.equal(expandHome('docs/~/notes.md', home), 'docs/~/notes.md');
});

test('~ resolves to a spec when the home-relative file is really there', () => {
  // The home directory is faked by resolving against it explicitly: what is
  // checked is that the ~ is expanded at all, rather than looked for in a
  // directory literally named "~" under the current one.
  const home = mkdtempSync(join(tmpdir(), 'exolvra-genesis-home-'));
  writeFileSync(join(home, 'notes.md'), '# Notes\n', 'utf8');
  assert.equal(expandHome('~/notes.md', home), join(home, 'notes.md'));
  assert.equal(resolveInput(expandHome('~/notes.md', home), dir).kind, 'spec');
  assert.equal(
    pathKind(join(dir, '~', 'notes.md')),
    'missing',
    'the unexpanded form would have looked here',
  );
});

test('inputAsArgument hands the lead a path for specs and the text for goals', () => {
  assert.equal(inputAsArgument(resolveInput('spec.md', dir)), specPath);
  assert.equal(inputAsArgument(resolveInput('build a thing', dir)), 'build a thing');
});

test('inputAsTyped hands the user back exactly what they typed', () => {
  // The resolved path is for the agent; the typed one is for the reader.
  const spec = resolveInput('spec.md', dir);
  assert.equal(spec.path, specPath);
  assert.equal(inputAsTyped(spec), 'spec.md');
  assert.equal(inputAsTyped(resolveInput('  build a thing  ', dir)), 'build a thing');
});

test('pathKind tells files, directories, and absences apart', () => {
  assert.equal(pathKind(specPath), 'file');
  assert.equal(pathKind(dir), 'directory');
  assert.equal(pathKind(join(dir, 'nope')), 'missing');
});

test('requireDirectory returns the absolute path of a real directory', () => {
  assert.equal(requireDirectory('specs', '--directory', dir), subdir);
  assert.equal(requireDirectory(subdir, '--directory', process.cwd()), subdir);
});

test('requireDirectory rejects a path that does not exist, naming flag and path', () => {
  const error = caught(() => requireDirectory('nope', '-C', dir, 'usage line'));
  assert.ok(error instanceof UsageError);
  assert.match(error.message, /invalid value "nope" for -C: no such directory/);
  assert.ok(error.message.includes(join(dir, 'nope')));
  assert.equal(error.usage, 'usage line');
});

test('requireDirectory rejects a file, naming flag and path', () => {
  const error = caught(() => requireDirectory(specPath, '--plugin-dir', dir));
  assert.ok(error instanceof UsageError);
  assert.match(error.message, /for --plugin-dir: not a directory/);
  assert.ok(error.message.includes(specPath));
  assert.match(error.message, /is a file/);
});

test('requireDirectory rejects an empty value instead of silently meaning cwd', () => {
  assert.throws(() => requireDirectory('   ', '--directory', dir), {
    name: 'UsageError',
    message: 'flag needs a non-empty argument: --directory',
  });
});
