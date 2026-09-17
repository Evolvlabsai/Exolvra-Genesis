import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotOwnership, enforceOwnership, owns, assertDisjoint } from '../dist/ownership.js';
import { reportChecks, verdictChecks, fingerprintRound, findingSignals } from '../dist/consistency.js';

function repo(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'genesis-owned-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  writeFileSync(join(cwd, '.gitignore'), '.env\n');
  writeFileSync(join(cwd, 'owned'), 'a\n'); writeFileSync(join(cwd, 'other'), 'b\n');
  git('add', '.'); git('commit', '-m', 'initial');
  return { cwd, git };
}

test('ownership detects same-count and binary edits, preserves legitimate work, rolls back clean files', (t) => {
  const { cwd } = repo(t), snapshot = snapshotOwnership(cwd);
  writeFileSync(join(cwd, 'owned'), 'valid\n'); writeFileSync(join(cwd, 'other'), Buffer.from([0, 255]));
  const result = enforceOwnership(snapshot, ['owned']);
  assert.deepEqual(result.violations, ['other']);
  assert.equal(readFileSync(join(cwd, 'other'), 'utf8'), 'b\n');
  assert.equal(readFileSync(join(cwd, 'owned'), 'utf8'), 'valid\n');
});
test('gitignored introductions are removed and existing dirty operator work is never restored from HEAD', (t) => {
  const { cwd } = repo(t);
  writeFileSync(join(cwd, 'other'), 'operator');
  const snapshot = snapshotOwnership(cwd);
  writeFileSync(join(cwd, '.env'), 'secret'); writeFileSync(join(cwd, 'other'), 'b\n');
  const result = enforceOwnership(snapshot, ['owned']);
  assert.deepEqual(result.violations, ['.env', 'other']);
  assert.equal(existsSync(join(cwd, '.env')), false);
  assert.match(result.unrecoverable[0], /operator work/);
});
test('deletions restore original bytes and git failure refuses dispatch', (t) => {
  const { cwd } = repo(t), snapshot = snapshotOwnership(cwd);
  unlinkSync(join(cwd, 'other'));
  enforceOwnership(snapshot, ['owned']);
  assert.equal(readFileSync(join(cwd, 'other'), 'utf8'), 'b\n');
  const empty = mkdtempSync(join(tmpdir(), 'genesis-no-git-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  assert.throws(() => snapshotOwnership(empty), /git status/);
});
test('ownership glob semantics and overlap errors are explicit', () => {
  assert.equal(owns('src/*', 'src/deep/file'), false);
  assert.equal(owns('src/**/*.ts', 'src/a.ts'), true);
  assert.equal(owns('src/**/*.ts', 'src/deep/a.ts'), true);
  assert.throws(() => owns('../*', '../file'), /invalid/);
  assert.throws(() => assertDisjoint([{ id: 'a', files: ['src/**'] }, { id: 'b', files: ['src/test.ts'] }]), /overlapping/);
});
test('reports must name existing files, the actual command, and truthful verification', (t) => {
  const { cwd } = repo(t);
  const report = 'FILES CHANGED\n- owned\nCOMMANDS RUN\n- npm test\nVERIFICATION\npassed\nexit code 0';
  assert.ok(reportChecks(cwd, report, 'npm test', ['owned']).every((c) => c.passed));
  assert.ok(reportChecks(cwd, report.replace('owned', 'missing'), 'npm check', ['other']).filter((c) => !c.passed).length >= 3);
  assert.equal(reportChecks(cwd, report.replace('exit code 0', 'exit code 1'), 'npm test').find((c) => c.name === 'report.outcome').passed, false);
  assert.equal(reportChecks(cwd, report.replace('passed\nexit code 0', 'not ok 1 - broken'), 'npm test').find((c) => c.name === 'report.outcome').passed, false);
});
test('verdict contradictions are corrected before spending another round', () => {
  for (const text of ['VERDICT: WIN\nGAP: hard gate G1 failed', 'VERDICT: LOSS\nGAP: none', 'VERDICT: BLOCKED\nGAP: code is wrong']) assert.ok(verdictChecks(text).some((c) => !c.passed), text);
  assert.ok(verdictChecks('VERDICT: BLOCKED\nGAP: missing browser capability').every((c) => c.passed));
});
test('duplicate, recurring and see-saw findings have deterministic mechanical signals', () => {
  const a = fingerprintRound([{ criterion: 'G1', text: 'A broke' }], 'diff1');
  const b = fingerprintRound([{ criterion: 'G2', text: 'B broke' }], 'diff2');
  const c = fingerprintRound([{ criterion: 'g1', text: ' A   broke ' }], 'diff3');
  assert.deepEqual(findingSignals([a, a]), ['duplicate-round']);
  assert.deepEqual(findingSignals([a, c]), ['gap-survives']);
  assert.deepEqual(findingSignals([a, b, c]), ['see-saw']);
});
