import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./models/explorer.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { explore } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const names = ['OneLiveClaimant', 'NoUnattestedWrite', 'RecoveryAttested', 'RecoverableCrash'];
function model(attested = true) {
  return {
    init: [{ phase: 'ready', live: [], owner: 0, trusted: false, fresh: false, forged: false, recovery: 0, writes: false }],
    bounds: { runners: 2, attackers: 1, concurrentClaims: 1, ttlExpiries: 1 },
    actions: [
      ...[1, 2].map((a) => ({ name: 'Claim(' + a + ')', next: (s) => s.phase === 'ready' ? [{ ...s, phase: 'working', live: [a], owner: a, trusted: true, fresh: true, recovery: 0 }] : [] })),
      { name: 'Crash', next: (s) => s.live.length ? [{ ...s, live: [] }] : [] },
      { name: 'Expire', next: (s) => s.fresh ? [{ ...s, fresh: false }] : [] },
      { name: 'Forge', next: (s) => [{ ...s, forged: true }] },
      { name: 'Recover', next: (s) => s.phase === 'working' && !s.live.length && !s.fresh && (s.trusted || (!attested && s.forged)) ? [{ ...s, phase: 'ready', owner: 0, recovery: 1, writes: !s.trusted }] : [] },
      { name: 'FakeClaim', next: (s) => !attested && s.forged && s.phase === 'ready' ? [{ ...s, phase: 'working', owner: 0, trusted: false }] : [] },
      ...['review', 'blocked', 'triage'].map((phase) => ({ name: 'Finish(' + phase + ')', next: (s) => s.phase === 'working' && s.live.length ? [{ ...s, phase, live: [] }] : [] })),
    ],
    invariants: [
      { name: 'OneLiveClaimant', holds: (s) => s.live.length <= 1 },
      { name: 'NoUnattestedWrite', holds: (s) => !s.writes },
      { name: 'RecoveryAttested', holds: (s) => s.recovery === 0 || s.trusted },
      { name: 'RecoverableCrash', holds: (s) => s.phase !== 'working' || s.live.length > 0 || s.trusted },
    ],
  };
}
function modelNames(text) {
  const section = text.split('\\* Invariants\n')[1]?.split(/^Spec\s*==/m)[0] ?? '';
  return [...section.matchAll(/^(\w+)\s*==/gm)].map((m) => m[1]).sort();
}
test('claim protocol exhausts all reachable states within its printed bounds', (t) => {
  const result = explore(model());
  assert.equal(result.exhausted, true, JSON.stringify(result.trace));
  assert.equal(result.states, 44, 'reachable claim states changed; review the model bounds and transitions');
  assert.equal(explore(model()).states, result.states);
  t.diagnostic(JSON.stringify({ states: result.states, bounds: result.bounds }));
});
test('disabling attestation reproduces the unrecoverable forged-claim design', () => {
  const result = explore(model(false));
  assert.equal(result.exhausted, false);
  assert.equal(result.violation, 'RecoverableCrash');
  assert.deepEqual(result.trace.map((s) => s.action), ['Init', 'Forge', 'FakeClaim']);
});
test('model/explorer invariant names cannot drift in either direction', () => {
  const text = readFileSync(new URL('../../docs/models/ClaimProtocol.tla', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  assert.deepEqual(modelNames(text), model().invariants.map((i) => i.name).sort());
  assert.deepEqual(modelNames(text), [...names].sort());
  assert.notDeepEqual(modelNames(text.replace('OneLiveClaimant ==', 'Renamed ==')), [...names].sort());
  assert.notDeepEqual(modelNames(text.replace('Spec ==', 'AddedInvariant == TRUE\nSpec ==')), [...names].sort());
  assert.notDeepEqual(modelNames(text), names.filter((s) => s !== 'RecoveryAttested').sort());
});
test('explorer refuses an incomplete search and checks its cycle detector', async () => {
  assert.throws(() => explore({ ...model(), ceiling: 2 }), /ceiling/);
  const broken = compiled.replace('if (seen.has(key))', 'if (false)');
  assert.notEqual(broken, compiled);
  const mutant = await import('data:text/javascript;base64,' + Buffer.from(broken).toString('base64'));
  assert.throws(() => mutant.explore({ ...model(), ceiling: 500 }), /ceiling/);
});
