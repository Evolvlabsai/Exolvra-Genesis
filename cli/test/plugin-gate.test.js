import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'genesis-plugin-gate-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const id of ['r-old', 'r-live']) {
    const bar = join(cwd, '.exolvra-genesis', 'runs', id, 'bar'); mkdirSync(bar, { recursive: true });
    writeFileSync(join(bar, 'reference'), id);
    writeFileSync(join(bar, 'bar.sha256'), createHash('sha256').update(id).digest('hex') + '  reference\n');
  }
  writeFileSync(join(cwd, '.exolvra-genesis', 'state.json'), JSON.stringify({ status: 'running', run: 'r-live' }));
  return cwd;
}
const gate = (cwd, phase = 'bar', input) => spawnSync(process.execPath, [bin, 'gate', '--phase', phase, '-C', cwd], { encoding: 'utf8', timeout: 5000, input, windowsHide: true });

test('the real plugin hook checks only the active run bar pins', (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, '.exolvra-genesis', 'runs', 'r-old', 'bar', 'reference'), 'old tampered');
  const healthy = gate(cwd); assert.equal(healthy.status, 0, healthy.stderr);
  writeFileSync(join(cwd, '.exolvra-genesis', 'runs', 'r-live', 'bar', 'reference'), 'live tampered');
  const tampered = gate(cwd); assert.equal(tampered.status, 2); assert.match(tampered.stderr, /bar integrity check failed/);
});

test('hostile pin paths and malformed hook data refuse without hanging or crashing', (t) => {
  const cwd = fixture(t), pin = join(cwd, '.exolvra-genesis', 'runs', 'r-live', 'bar', 'bar.sha256');
  for (const path of ['.', '../reference', '../../../../../outside']) {
    writeFileSync(pin, 'a'.repeat(64) + '  ' + path + '\n');
    const result = gate(cwd); assert.equal(result.error, undefined); assert.equal(result.status, 2); assert.match(result.stderr, /bar pin escaped/);
  }
  const bad = gate(cwd, 'before', 'null'); assert.equal(bad.status, 2); assert.match(bad.stderr, /hook input must be an object/);
});
