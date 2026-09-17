import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('./models/explorer.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { explore } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
function model(broken = false) {
  return {
    init: [{ phase:'queued',owner:0,builder:0,generation:0,fresh:false,capable:[1,2],verified:false,accepted:false,credentialTransit:false,forged:false }],
    bounds: { machines:2,rounds:1,claimGenerations:2,concurrentClaims:1 },
    actions: [
      ...[1,2].map(w => ({name:`Claim(${w})`,next:s=>s.phase==='queued'&&s.capable.includes(w)&&s.generation<2?[{...s,phase:'building',owner:w,generation:s.generation+1,fresh:true}]:[]})),
      {name:'Crash',next:s=>['building','judging'].includes(s.phase)&&s.fresh?[{...s,fresh:false}]:[]},
      {name:'Expire',next:s=>s.phase==='building'&&!s.fresh?[{...s,phase:s.generation<2?'queued':'failed',owner:0}]:[]},
      {name:'FinishBuild',next:s=>s.phase==='building'&&s.fresh&&s.capable.includes(s.owner)?[{...s,phase:'reported',builder:s.owner,owner:0}]:[]},
      {name:'Verify',next:s=>s.phase==='reported'&&!s.forged?[{...s,phase:'verified',verified:true}]:[]},
      ...[1,2].map(w=>({name:`Judge(${w})`,next:s=>s.phase==='verified'&&s.capable.includes(w)&&(broken||w!==s.builder)?[{...s,phase:'judging',owner:w,fresh:true}]:[]})),
      {name:'Accept',next:s=>s.phase==='judging'&&s.fresh&&s.capable.includes(s.owner)&&!s.forged?[{...s,phase:'complete',accepted:true}]:[]},
      {name:'Corrupt',next:s=>[{...s,forged:true}]},
      ...[1,2].map(w=>({name:`LoseCapability(${w})`,next:s=>[{...s,capable:s.capable.filter(c=>c!==w)}]})),
      {name:'RejectStale',next:s=>[s]},
    ],
    invariants: [
      {name:'OneLiveClaimant',holds:s=>[0,1,2].includes(s.owner)},
      {name:'PinnedBeforeJudging',holds:s=>!['judging','complete'].includes(s.phase)||s.verified},
      {name:'PhysicalIndependence',holds:s=>!['judging','complete'].includes(s.phase)||s.owner!==s.builder},
      {name:'CredentialLocality',holds:s=>!s.credentialTransit},
      {name:'CapabilityScheduled',holds:s=>s.phase!=='complete'||s.accepted},
      {name:'StaleCannotPublish',holds:s=>s.phase!=='queued'||s.owner===0},
      {name:'RecoverableLease',holds:s=>s.phase!=='building'||s.fresh||s.generation<=2},
    ],
  };
}
test('distributed claim protocol exhausts before worker implementation', t=>{
  const result=explore(model());
  assert.equal(result.exhausted,true,JSON.stringify(result.trace));
  t.diagnostic(JSON.stringify({states:result.states,bounds:result.bounds}));
});
test('distributed protocol catches same-machine judging with a minimal trace',()=>{
  const result=explore(model(true));
  assert.equal(result.violation,'PhysicalIndependence');
  assert.deepEqual(result.trace.map(s=>s.action),['Init','Claim(1)','FinishBuild','Verify','Judge(1)']);
});
test('distributed model and explorer invariant names match',()=>{
  const tla=readFileSync(new URL('../../docs/models/DistributedRounds.tla',import.meta.url),'utf8');
  const block=tla.split('\\* INVARIANTS:')[1].split('\\* Weak fairness')[0];
  const declared=[...block.matchAll(/^(\w+)\s*==/gm)].map(m=>m[1]).filter(name=>name!=='Invariants').sort();
  const tuple=tla.match(/Invariants\s*==\s*<<([\s\S]*?)>>/)[1].split(',').map(s=>s.trim()).sort();
  const checked=model().invariants.map(i=>i.name).sort();
  assert.deepEqual(declared,checked);assert.deepEqual(tuple,checked);
  assert.notDeepEqual(declared.filter(name=>name!=='PhysicalIndependence'),checked);
  assert.notDeepEqual(declared,[...checked,'UncheckedInvariant'].sort());
});
