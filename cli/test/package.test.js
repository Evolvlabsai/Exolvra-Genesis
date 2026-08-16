import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { gunzipSync } from 'node:zlib';

import { PACKAGE_ROOT, planAnswer, runProcess } from './run-cli.js';

/*
 * C3 / C1, checked against a package that was really published.
 *
 * The CLI loads the loop from `commands/run.md`, `agents/builder.md` and
 * `agents/critic.md` at runtime. Inside this repo those files are one directory
 * up, so every other test in this suite finds them whether or not the package
 * ships them — which is exactly why this file exists. Here the package is
 * packed with npm, the tarball is extracted into a `node_modules` tree, and the
 * binary is run from it as an installed package, with nothing above it to fall
 * back to.
 *
 * The one substitution is the Claude Agent SDK, installed beside the package
 * the way npm would install a dependency.
 */

const WORK = mkdtempSync(join(tmpdir(), 'exolvra-genesis-pack-'));
after(() => rmSync(WORK, { recursive: true, force: true }));

/** Runs npm, through the same executable that is running this suite. */
function npm(args) {
  const cli = process.env['npm_execpath'];
  const result =
    cli === undefined || cli === ''
      ? spawnSync('npm', args, { cwd: PACKAGE_ROOT, encoding: 'utf8', shell: true })
      : spawnSync(process.execPath, [cli, ...args], {
          cwd: PACKAGE_ROOT,
          encoding: 'utf8',
        });
  assert.equal(result.error, undefined, 'npm did not start: ' + result.error);
  assert.equal(
    result.status,
    0,
    'npm ' + args.join(' ') + ' failed:\n' + result.stdout + result.stderr,
  );
  return result.stdout;
}

/* -------------------------------------------------------------------------- */
/* A tar reader, so the tarball that is checked is the tarball npm wrote        */
/* -------------------------------------------------------------------------- */

const BLOCK = 512;

/** Reads a NUL-terminated field out of a tar header. */
function field(header, offset, length) {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8').trim();
}

/**
 * Extracts a gzipped tar into `into`, returning the paths it wrote, relative
 * to the archive's own root.
 *
 * Written out rather than shelled out to: `tar` is not on every machine, and a
 * ustar header is a fixed layout — a name, an octal size, a type — laid out in
 * 512-byte blocks.
 */
function extract(tarball, into) {
  const buffer = gunzipSync(readFileSync(tarball));
  const written = [];
  let at = 0;

  while (at + BLOCK <= buffer.length) {
    const header = buffer.subarray(at, at + BLOCK);
    at += BLOCK;
    const name = field(header, 0, 100);
    if (name === '') continue; // the two empty blocks that end an archive

    const size = parseInt(field(header, 124, 12) || '0', 8);
    const type = field(header, 156, 1);
    const prefix = field(header, 345, 155);
    const full = prefix === '' ? name : prefix + '/' + name;
    const body = buffer.subarray(at, at + size);
    at += Math.ceil(size / BLOCK) * BLOCK;

    // A regular file; anything else in an npm tarball (directories, pax
    // headers) carries no content this test needs.
    if (type !== '' && type !== '0') continue;

    const relative = full.replace(/^package\//, '');
    const target = join(into, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    written.push(relative);
  }
  return written;
}

/* -------------------------------------------------------------------------- */
/* The check                                                                   */
/* -------------------------------------------------------------------------- */

test('the published package carries the plugin markdown and loads it', () => {
  // Packed without lifecycle scripts, because the suite is already running
  // against the build `pretest` produced and a second `tsc` writing into dist/
  // underneath the other test files would be a race, not a check. That the
  // build runs before a real publish is a separate, structural claim, made
  // below.
  const output = npm(['pack', '--pack-destination', WORK, '--ignore-scripts', '--silent']);
  const tarball = join(
    WORK,
    (output.trim().split('\n').pop() ?? '').trim() ||
      readdirSync(WORK).find((name) => name.endsWith('.tgz')),
  );

  const home = join(WORK, 'project');
  const installed = join(home, 'node_modules', 'exolvra-genesis');
  const files = extract(tarball, installed);

  // 1. The three files are in the tarball at all.
  for (const relative of [
    'dist/plugin/commands/run.md',
    'dist/plugin/agents/builder.md',
    'dist/plugin/agents/critic.md',
    'dist/plugin/templates/progress.html',
    'dist/plugin/templates/fleet.html',
  ]) {
    assert.ok(
      files.includes(relative),
      relative + ' is not in the published package:\n' + files.join('\n'),
    );
    assert.equal(
      readFileSync(join(installed, relative), 'utf8'),
      readFileSync(join(PACKAGE_ROOT, '..', relative.replace('dist/plugin/', '')), 'utf8'),
      relative + ' shipped as something other than the repository file',
    );
  }

  // 2. Nothing above the installed package can stand in for them: the repo
  //    root is not there to be found from inside node_modules.
  assert.deepEqual(
    readdirSync(join(home, 'node_modules')).sort(),
    ['exolvra-genesis'],
    'the installed tree must hold nothing but the package under test',
  );

  // 3. The SDK, where npm would have put it, with the test double in it.
  const sdk = join(home, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  mkdirSync(sdk, { recursive: true });
  writeFileSync(
    join(sdk, 'package.json'),
    JSON.stringify({
      name: '@anthropic-ai/claude-agent-sdk',
      version: '0.0.0-test-double',
      type: 'module',
      main: 'index.js',
      exports: { '.': './index.js' },
    }),
    'utf8',
  );
  writeFileSync(
    join(sdk, 'index.js'),
    "import { readFileSync } from 'node:fs';\n" +
      'export function query() {\n' +
      '  const answer = readFileSync(process.env.EXOLVRA_GENESIS_TEST_SDK_RESULT_FILE, "utf8");\n' +
      '  return {\n' +
      '    async interrupt() {},\n' +
      '    async *[Symbol.asyncIterator]() {\n' +
      '      yield { type: "result", subtype: "success", session_id: "s", num_turns: 1,\n' +
      '        total_cost_usd: 0, result: answer, errors: [] };\n' +
      '    },\n' +
      '  };\n' +
      '}\n',
    'utf8',
  );

  // 4. A command that needs the markdown, run from the installed package.
  const workdir = join(home, 'work');
  mkdirSync(workdir, { recursive: true });
  const answer = join(WORK, 'answer.md');
  writeFileSync(answer, planAnswer(), 'utf8');

  const bin = join(installed, 'dist', 'cli.js');
  const { code, stdout, stderr } = runProcess(bin, ['plan', 'a bash script'], {
    cwd: workdir,
    env: {
      EXOLVRA_GENESIS_PLUGIN_DIR: undefined,
      EXOLVRA_GENESIS_TEST_SDK_RESULT_FILE: answer,
    },
  });

  assert.equal(
    code,
    0,
    'the installed package could not run a command that needs the markdown:\n' + stderr,
  );
  assert.ok(stdout.startsWith('GOAL\n'), stdout);
  assert.ok(stdout.includes('a bash script'), stdout);
  assert.equal(stderr, '');
});

/**
 * An installed `node_modules/exolvra-genesis` holding the built package, with
 * `package.json` overridden by `manifest`.
 */
function installWith(name, manifest) {
  const home = join(WORK, name);
  const installed = join(home, 'node_modules', 'exolvra-genesis');
  mkdirSync(installed, { recursive: true });
  cpSync(join(PACKAGE_ROOT, 'dist'), join(installed, 'dist'), { recursive: true });
  writeFileSync(join(installed, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const probe = join(home, 'probe.mjs');
  writeFileSync(
    probe,
    "try { await import('exolvra-genesis'); } catch (error) {\n" +
      "  if (!String(error.code).startsWith('ERR_')) throw error;\n" +
      "  process.stdout.write('<import failed: ' + error.code + '>');\n" +
      '}\n',
    'utf8',
  );
  return spawnSync(process.execPath, [probe], { cwd: home, encoding: 'utf8' });
}

test('importing the package does not run the CLI as a side effect', () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.main, undefined, 'main must not point at the executable');
  assert.equal(pkg.bin['exolvra-genesis'], 'dist/cli.js', 'the bin is how the CLI is run');

  const quiet = installWith('import-project', pkg);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.ok(
    !quiet.stdout.includes('USAGE'),
    'importing the package ran the command line:\n' + quiet.stdout,
  );

  // The control, so the check above is not passing for the wrong reason: with
  // the entry point named as the package main, the same import does run it.
  const loud = installWith('import-project-main', { ...pkg, main: 'dist/cli.js' });
  assert.ok(
    loud.stdout.includes('USAGE'),
    'the probe cannot tell the difference, so it proves nothing:\n' + loud.stdout,
  );
});

test('the packed file list is what the package means to ship', () => {
  const listed = JSON.parse(npm(['pack', '--dry-run', '--ignore-scripts', '--json']));
  const names = (listed[0]?.files ?? []).map((entry) => entry.path);
  assert.ok(names.includes('package.json'));
  assert.ok(
    names.some((name) => name.startsWith('dist/plugin/')),
    'a dry run does not list the plugin markdown:\n' + names.join('\n'),
  );
  for (const name of names) {
    assert.ok(
      name === 'package.json' || name === 'LICENSE' || name.startsWith('dist/'),
      'an unexpected file is shipped: ' + name,
    );
  }
});

test('publishing builds first, so the shipped copy cannot go stale', () => {
  // The copy is a build output. What keeps it current in a tarball is that
  // `npm pack` and `npm publish` build before they read the working tree.
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.prepack, /\bbuild\b/, 'prepack must build the package');
  assert.match(pkg.scripts.build, /\bbuild:plugin\b/, 'the build must copy the markdown');
  assert.deepEqual(
    pkg.files,
    ['dist', 'LICENSE'],
    'the copy lives under dist/, and the licence the manifest claims ships beside it',
  );
  assert.equal(resolve(PACKAGE_ROOT, 'dist'), dirname(join(PACKAGE_ROOT, 'dist', 'cli.js')));
});
