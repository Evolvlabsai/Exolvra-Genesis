import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { doctorCommand, inspectLocalEnvironment } from '../dist/commands/doctor.js';
import { configPath } from '../dist/config.js';
import { pipes } from './tty.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEMP = [];
after(() => { for (const dir of TEMP) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
function fixture(extra = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'genesis-doctor-')); TEMP.push(cwd);
  const env = { EXOLVRA_GENESIS_PLUGIN_DIR: ROOT, APPDATA: cwd, XDG_CONFIG_HOME: cwd, HOME: cwd, USERPROFILE: cwd, PATH: '', ...extra };
  const io = pipes();
  const ctx = { program: 'exolvra-genesis', cwd, env, stdout: io.output, stderr: io.output, isTTY: false, isErrTTY: false, width: 80 };
  return { cwd, env, io, ctx };
}

test('read-only doctor emits fixed JSON and creates no files or run artifacts', async () => {
  const { cwd, ctx, io } = fixture({ GITHUB_TOKEN: 'never-display-this-secret', ANTHROPIC_API_KEY: 'also-never-display-this-secret' });
  const before = readdirSync(cwd);
  assert.equal(await doctorCommand.run(['--read-only', '--json'], ctx), 0);
  const report = JSON.parse(io.raw());
  assert.equal(report.readOnly, true);
  assert.deepEqual(readdirSync(cwd), before);
  assert.equal(report.checks.find((c) => c.check === 'sdk').status, 'ok');
  assert.equal(report.checks.find((c) => c.check === 'execution permission').status, 'unknown');
  assert.equal(report.checks.find((c) => c.check === 'provider authentication').status, 'unknown');
  assert.ok(!io.raw().includes('never-display-this-secret'));
});

test('doctor reports broken standards and missing plugin with exit 2, preserving bytes', async () => {
  const { cwd, ctx, io } = fixture({ EXOLVRA_GENESIS_PLUGIN_DIR: join(tmpdir(), 'nonexistent-doctor-plugin') });
  mkdirSync(join(cwd, '.exolvra-genesis'));
  const path = join(cwd, '.exolvra-genesis/standards.md');
  writeFileSync(path, '# malformed standards\n');
  assert.equal(await doctorCommand.run(['--read-only', '--json'], ctx), 2);
  const checks = JSON.parse(io.raw()).checks;
  assert.equal(checks.find((c) => c.check === 'plugin').status, 'error');
  assert.equal(checks.find((c) => c.check === 'standards').status, 'error');
  assert.equal(readFileSync(path, 'utf8'), '# malformed standards\n');
});

test('doctor distinguishes unavailable observations from invalid configured shell and config', () => {
  const { cwd, env } = fixture({ CLAUDE_CODE_GIT_BASH_PATH: join(tmpdir(), 'missing-doctor-bash') });
  const path = configPath({ env });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{ invalid JSON');
  const checks = inspectLocalEnvironment(cwd, env);
  assert.equal(checks.find((c) => c.check === 'command shell').status, 'error');
  assert.equal(checks.find((c) => c.check === 'config').status, 'error');
  assert.equal(checks.find((c) => c.check === 'git').status, 'unknown');
  assert.equal(readFileSync(path, 'utf8'), '{ invalid JSON');
});

test('doctor piped output uses the house TSV table and never prompts', async () => {
  const { ctx, io } = fixture();
  assert.equal(await doctorCommand.run(['--read-only'], ctx), 0);
  assert.match(io.raw(), /execution permission\tunknown\t/);
  assert.doesNotMatch(io.raw(), /\u001b\[/);
});
