import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginRun, appendRun, writeState, readState, prepareResume } from '../dist/runs-store.js';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'genesis-hygiene-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, '.exolvra-genesis');
  mkdirSync(root);
  return { cwd, root };
}
const record = (id, status = 'running') => ({ id, status, sessionId: null, input: 'test', models: { lead: 'inherit', builder: 'inherit', critic: 'inherit' }, startedAt: new Date().toISOString() });

test('settled legacy artifacts archive to their owner before a new run starts', (t) => {
  const { cwd, root } = fixture(t);
  appendRun(cwd, record('r-old', 'complete')); writeState(cwd, 'complete');
  mkdirSync(join(root, 'bar')); writeFileSync(join(root, 'bar', 'reference'), 'original');
  writeFileSync(join(root, 'progress.html'), 'COMPLETE');
  writeFileSync(join(root, 'standards.md'), 'untouchable');
  assert.deepEqual(beginRun(cwd, record('r-new')), ['bar', 'progress.html']);
  assert.equal(readFileSync(join(root, 'runs/r-old/bar/reference'), 'utf8'), 'original');
  assert.equal(existsSync(join(root, 'runs/r-new/progress.html')), false);
  assert.equal(readFileSync(join(root, 'standards.md'), 'utf8'), 'untouchable');
  assert.equal(readState(cwd).run, 'r-new');
});

for (const status of ['running', 'blocked']) test(status + ' refuses a new start without altering existing state', (t) => {
  const { cwd, root } = fixture(t);
  appendRun(cwd, record('r-old', status)); writeState(cwd, status, 'r-old');
  const before = readFileSync(join(root, 'state.json'), 'utf8');
  assert.throws(() => beginRun(cwd, record('r-new')), /resume.*r-old[\s\S]*stop.*r-old/);
  assert.equal(readFileSync(join(root, 'state.json'), 'utf8'), before);
  prepareResume(cwd, 'r-old');
  assert.equal(readState(cwd).run, 'r-old');
});

for (const hostile of ['{', '{"status":"complete","run":"../../outside"}', '{"status":"complete","run":"' + 'a'.repeat(100) + '"}']) test('hostile state is refused: ' + hostile.slice(0, 45), (t) => {
  const { cwd, root } = fixture(t);
  writeFileSync(join(root, 'state.json'), hostile);
  assert.throws(() => beginRun(cwd, record('r-new')), /run state/);
  assert.equal(readFileSync(join(root, 'state.json'), 'utf8'), hostile);
  assert.equal(existsSync(join(root, 'runs')), false);
});

test('a partial archive converges and preserves both sides of a conflict', (t) => {
  const { cwd, root } = fixture(t);
  appendRun(cwd, record('r-old', 'complete')); writeState(cwd, 'complete', 'r-old');
  mkdirSync(join(root, 'bar')); mkdirSync(join(root, 'runs/r-old/bar'), { recursive: true });
  writeFileSync(join(root, 'runs/r-old/bar/a'), 'already moved');
  writeFileSync(join(root, 'bar/b'), 'remaining');
  beginRun(cwd, record('r-new'));
  assert.equal(readFileSync(join(root, 'runs/r-old/bar/a'), 'utf8'), 'already moved');
  assert.equal(readFileSync(join(root, 'runs/r-old/bar/b'), 'utf8'), 'remaining');
});

test('two real process starts cannot share an active run or archive', async (t) => {
  const { cwd, root } = fixture(t);
  appendRun(cwd, record('r-old', 'complete')); writeState(cwd, 'complete', 'r-old');
  mkdirSync(join(root, 'bar')); writeFileSync(join(root, 'bar', 'artifact'), 'preserve me');
  const moduleUrl = new URL('../dist/runs-store.js', import.meta.url).href;
  const script = `import {beginRun} from ${JSON.stringify(moduleUrl)}; try { beginRun(process.argv[1], JSON.parse(process.argv[2])); } catch (e) { process.stderr.write(e.message); process.exitCode=2; }`;
  const start = (id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, cwd, JSON.stringify(record(id))], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (data) => { stderr += data; }); child.on('error', reject); child.on('close', (code) => resolve({ code, stderr }));
  });
  const results = await Promise.all([start('r-one'), start('r-two')]);
  assert.deepEqual(results.map((r) => r.code).sort(), [0, 2]);
  assert.match(results.find((r) => r.code === 2).stderr, /previous run is unfinished/);
  const rows = JSON.parse(readFileSync(join(root, 'runs.json'), 'utf8'));
  assert.equal(rows.length, 2); assert.equal(rows.filter((r) => r.status === 'running').length, 1);
  assert.equal(readFileSync(join(root, 'runs', 'r-old', 'bar', 'artifact'), 'utf8'), 'preserve me');
});
