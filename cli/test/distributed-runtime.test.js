import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RoundCoordinator } from '../dist/distributed.js';
import { exportRoundBundle, importRoundBundle } from '../dist/git.js';
import { executeRound, verifyBuiltRound, workerEnvironment } from '../dist/distributed-worker.js';
import { loadPluginSources } from '../dist/plugin-dir.js';
import { splitFrontmatter } from '../dist/agents.js';
import { loadFleetTemplate, renderFleetPage } from '../dist/fleet.js';
import { guardDistributedBuilder, recordDistributedFindings } from '../dist/distributed-guards.js';
import { candidateFingerprint } from '../dist/ownership.js';
import { runDirectory } from '../dist/runs-store.js';
import { createDistributedLead, trackVerificationCheckout } from '../dist/distributed-lead.js';
import { createBudget } from '../dist/budget.js';
import { openTrace } from '../dist/trace-store.js';

const pin = { sha:'a'.repeat(40),digest:'b'.repeat(64),ref:'refs/exolvra/rounds/run/piece/1' };
const payload = { role:'builder', task:'Task Spec: change file.txt only',files:['file.txt'],verify:'node -e "console.log(\'verified\')"',bar:'The output must say done.',base:pin,model:'inherit' };
function temporary(t) { const root=mkdtempSync(join(tmpdir(),'genesis-distributed-')); t.after(()=>rmSync(root,{recursive:true,force:true})); return root; }
function worker(queue,id,machine=id,now=Date.now()) { queue.register({id,name:id,machine,capabilities:['model:inherit','browser']},now); }
function job(queue,overrides={},now=Date.now()) { return queue.publish({run:'run',piece:'piece',round:1,requirements:['model:inherit'],payload,...overrides},now); }
function git(cwd,...args) { return execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(); }
function repository(root) { const cwd=join(root,'repo');mkdirSync(cwd);git(cwd,'init','--quiet');git(cwd,'config','user.email','test@example.invalid');git(cwd,'config','user.name','Test');writeFileSync(join(cwd,'file.txt'),'before\n');git(cwd,'add','.');git(cwd,'commit','-qm','initial');return cwd; }
function roundProcess(cwd,args) { return spawnSync(process.execPath,[fileURLToPath(new URL('../dist/cli.js',import.meta.url)),'round',...args,'-C',cwd],{cwd,encoding:'utf8'}); }

test('an existing distributed run refuses a replacement coordinator without losing its original claims',async t=>{
  const cwd=temporary(t),run='run',original=new RoundCoordinator(join(cwd,'original'));mkdirSync(runDirectory(cwd,run),{recursive:true});worker(original,'a');job(original);const claimed=original.claim('a');
  writeFileSync(join(runDirectory(cwd,run),'distributed.json'),JSON.stringify({coordinator:original.root}));
  const trace=openTrace(cwd,run,()=>{});
  try {
    assert.throws(()=>createDistributedLead({root:join(cwd,'replacement'),cwd,run,trace,budget:createBudget({}),onTrip:()=>{},onFault:()=>{}}),/keeps its recorded coordinator/);
    assert.equal(JSON.parse(readFileSync(join(runDirectory(cwd,run),'distributed.json'),'utf8')).coordinator,original.root);
    assert.equal(original.get(claimed.id).token,claimed.token);assert.equal(existsSync(join(cwd,'replacement')),false);
  } finally { trace.close(); }
});

test('round wait timeout exits one and preserves the actual pending job',t=>{
  const cwd=temporary(t),queue=new RoundCoordinator(join(cwd,'queue'));worker(queue,'a');const built=job(queue),claimed=queue.claim('a');
  queue.finish(claimed.id,claimed.token,{text:'report',pin,ownership:{passed:true,violations:[]},costUsd:0});queue.verified(built.id,pin.sha);
  const result=roundProcess(cwd,['--coordinator',queue.root,'--action','judge','--job',built.id,'--wait-seconds','1']);
  assert.equal(result.error,undefined);assert.equal(result.status,1,result.stderr+'\n'+result.stdout);assert.match(result.stderr,/wait expired; round remains queued/);
  const pending=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(pending.status,'queued');assert.equal(queue.get(pending.id).status,'queued');
});

test('rejected round publication and failed bar capture leave no orphan coordinator bundles',t=>{
  const root=temporary(t),cwd=repository(root),queue=new RoundCoordinator(join(root,'queue')),run='run';worker(queue,'a');queue.setBudget(run,0);
  mkdirSync(runDirectory(cwd,run),{recursive:true});writeFileSync(join(runDirectory(cwd,run),'ownership-plan.json'),JSON.stringify([{piece:'piece',files:payload.files,verify:payload.verify}]));
  const request=join(root,'request.json'),value={run,piece:'piece',round:1,requirements:[],task:payload.task,files:payload.files,verify:payload.verify,bar:payload.bar,model:'inherit'};
  writeFileSync(request,JSON.stringify(value));
  const rejected=roundProcess(cwd,['--coordinator',queue.root,'--action','build','--request',request]);
  assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/budget is exhausted/);assert.deepEqual(readdirSync(join(queue.root,'bundles')),[]);
  queue.setBudget(run,1);writeFileSync(request,JSON.stringify({...value,barDirectory:'missing-bar'}));
  const missing=roundProcess(cwd,['--coordinator',queue.root,'--action','build','--request',request]);
  assert.notEqual(missing.status,0);assert.match(missing.stderr,/missing-bar/);assert.deepEqual(readdirSync(join(queue.root,'bundles')),[]);
  assert.equal(JSON.parse(readFileSync(join(queue.root,'rounds.json'),'utf8')).jobs.length,0);
});

test('verification cleanup refuses a nested junction and preserves its target',async t=>{
  const cwd=temporary(t),run='run',queue=new RoundCoordinator(join(cwd,'queue')),target=join(cwd,'valuable');mkdirSync(target);
  const preserved=join(target,'genesis-verify-unrelated');mkdirSync(preserved);writeFileSync(join(preserved,'keep.txt'),'keep');
  const link=join(cwd,'linked');symlinkSync(target,link,'junction');mkdirSync(runDirectory(cwd,run),{recursive:true});
  trackVerificationCheckout(cwd,run,join(link,'genesis-verify-unrelated'));
  const trace=openTrace(cwd,run,()=>{}),faults=[];
  try {
    const lead=createDistributedLead({root:queue.root,cwd,run,trace,budget:createBudget({}),onTrip:()=>{},onFault:reason=>faults.push(reason)});
    assert.equal(await lead.settle('done'),false);assert.ok(faults.some(f=>/unsafe verification checkout cleanup/.test(f)));assert.equal(readFileSync(join(preserved,'keep.txt'),'utf8'),'keep');
  } finally { trace.close(); }
});

test('claims are exclusive, expired workers are fenced, and retry exhaustion settles',t=>{
  const root=temporary(t),queue=new RoundCoordinator(root,60000),now=Date.now();worker(queue,'a','machine-a',now);worker(queue,'b','machine-b',now);
  const published=job(queue,{},now),a=queue.claim('a',now);assert.equal(a.id,published.id);assert.equal(queue.claim('b',now),undefined);
  queue.heartbeat('b',undefined,now+60001);const b=queue.claim('b',now+60001);assert.equal(b.attempt,2);assert.notEqual(a.token,b.token);
  assert.throws(()=>queue.finish(a.id,a.token,'late',now+60002),/stale round claim/);
  assert.equal(queue.get(a.id,now+120002).status,'failed');
  assert.match(queue.get(a.id,now+120002).error,/retry limit/);
  assert.equal(new RoundCoordinator(root).ttl,60000);
});
test('capability loss is blocked and stale queued work cannot silently execute',t=>{
  const queue=new RoundCoordinator(temporary(t),60000);worker(queue,'a');const published=job(queue,{requirements:['browser']});const claimed=queue.claim('a');
  assert.equal(queue.heartbeat('a',['model:inherit']),false);assert.equal(queue.get(published.id).status,'blocked');
  assert.match(queue.get(published.id).error,/browser/);assert.throws(()=>queue.finish(claimed.id,claimed.token,'late'),/stale/);
  assert.equal(job(queue,{requirements:['screen']}).status,'blocked');
  queue.event(claimed.id,claimed.token,'budget_spend',{costUsd:0.2});assert.equal(queue.cost('run'),0.2);
  assert.throws(()=>queue.cleanup('run'),/unacknowledged/);queue.acknowledgeCancellation(claimed.id,claimed.token);
  queue.cleanup('run');assert.equal(queue.cost('run'),0.2);
});
test('an expired attempt can settle its bill without publishing work or releasing its replacement',t=>{
  const queue=new RoundCoordinator(temporary(t),60000),now=Date.now();worker(queue,'a','machine-a',now);
  job(queue,{},now);const expired=queue.claim('a',now);
  worker(queue,'a','machine-a',now+60001);const replacement=queue.claim('a',now+60001);
  assert.equal(replacement.attempt,2);assert.notEqual(expired.token,replacement.token);
  queue.event(expired.id,expired.token,'budget_spend',{costUsd:0.2},now+60002);
  assert.throws(()=>queue.finish(expired.id,expired.token,'late',now+60002),/stale/);
  queue.acknowledgeCancellation(expired.id,expired.token);
  assert.equal(queue.workers(now+60002)[0].current,replacement.id);
  queue.event(replacement.id,replacement.token,'budget_spend',{costUsd:0.3},now+60003);
  queue.finish(replacement.id,replacement.token,{text:'settled',pin,ownership:{passed:true,violations:[]},costUsd:0.3},now+60003);
  queue.cleanup('run');assert.equal(queue.cost('run'),0.5);
  assert.throws(()=>queue.event(expired.id,expired.token,'budget_spend',{costUsd:0.2},now+60004),/stale/);
});
test('judge dispatch requires verification and another physical machine',t=>{
  const queue=new RoundCoordinator(temporary(t));worker(queue,'a','machine-a');worker(queue,'b','machine-b');
  const built=job(queue),claim=queue.claim('a');queue.finish(claim.id,claim.token,{text:'report',pin,ownership:{passed:true,violations:[]},costUsd:0});
  const request={run:'run',piece:'piece',round:1,requirements:['model:inherit'],excludeMachine:'machine-a',payload:{role:'critic',bar:'bar only',base:pin,model:'inherit'}};
  assert.throws(()=>queue.publish(request),/lead-verified/);queue.verified(built.id,pin.sha);
  const critic=queue.publish(request);assert.equal(queue.claim('a'),undefined);assert.equal(queue.claim('b').id,critic.id);
  assert.deepEqual(Object.keys(critic.payload).sort(),['bar','base','model','role']);
});
test('single-machine distribution retains same-machine fallback',t=>{
  const queue=new RoundCoordinator(temporary(t));worker(queue,'a','only-machine');const built=job(queue),claim=queue.claim('a');
  queue.finish(claim.id,claim.token,{text:'report',pin,ownership:{passed:true,violations:[]},costUsd:0});queue.verified(built.id,pin.sha);
  queue.publish({run:'run',piece:'piece',round:1,requirements:['model:inherit'],excludeMachine:'only-machine',payload:{role:'critic',bar:'bar',base:pin,model:'inherit'}});
  assert.equal(queue.claim('a').payload.role,'critic');
});
test('content-addressed bundles preserve the exact tree, hide history, clean refs, and reject corruption',t=>{
  const root=temporary(t),cwd=repository(root),bundle=join(root,'tree.bundle');
  mkdirSync(join(cwd,'.exolvra-genesis'));writeFileSync(join(cwd,'.exolvra-genesis','secret.txt'),'run-private');
  writeFileSync(join(cwd,'file.txt'),'done\n');const beforeIndex=git(cwd,'diff','--cached');
  const exported=exportRoundBundle(cwd,bundle,'run','piece',1);
  assert.equal(git(cwd,'for-each-ref','--format=%(refname)','refs/exolvra'), '');assert.equal(git(cwd,'diff','--cached'),beforeIndex);
  const target=join(root,'received');importRoundBundle(bundle,target,exported);
  assert.equal(readFileSync(join(target,'file.txt'),'utf8'),'done\n');assert.equal(existsSync(join(target,'.exolvra-genesis')),false);
  assert.equal(git(target,'rev-list','--count','HEAD'),'1');assert.equal(git(target,'remote'),'');assert.equal(git(target,'rev-parse','HEAD'),exported.sha);
  assert.throws(()=>importRoundBundle(bundle,join(root,'wrong-sha'),{...exported,sha:'0'.repeat(40)}),/sha mismatch/);
  writeFileSync(bundle,Buffer.concat([readFileSync(bundle),Buffer.from('corrupt')]));
  assert.throws(()=>importRoundBundle(bundle,join(root,'corrupt'),exported),/hash mismatch/);
});
test('real builder/lead/critic transport uses plugin sessions, ownership, verification and credential locality',async t=>{
  const root=temporary(t),cwd=repository(root),queue=new RoundCoordinator(join(root,'queue'));worker(queue,'builder','machine-a');worker(queue,'critic','machine-b');
  const bundle=join(root,'base.bundle'),base=exportRoundBundle(cwd,bundle,'run','piece',1);queue.putBundle(bundle,base);
  const initial=job(queue,{payload:{...payload,base}}),claimed=queue.claim('builder');let builderPrompt;
  const fake=async ({prompt,options})=>{
    builderPrompt=prompt;assert.equal(options.env.GH_TOKEN,undefined);assert.equal(options.env.Github_Token,undefined);assert.equal(options.env.ANTHROPIC_API_KEY,'worker-local-login');
    writeFileSync(join(options.cwd,'file.txt'),'done\n');
    return Object.assign((async function*(){yield {type:'result',subtype:'success',session_id:'builder-session',num_turns:1,total_cost_usd:0.01,result:'FILES CHANGED\n- file.txt\nCOMMANDS RUN\n- '+payload.verify+'\nVERIFICATION\nverified',is_error:false};})(),{interrupt:async()=>{}});
  };
  const result=await executeRound({coordinator:queue,job:claimed,workRoot:join(root,'worker-a'),env:{...process.env,GH_TOKEN:'runner-secret',Github_Token:'other-secret',ANTHROPIC_API_KEY:'worker-local-login'},transport:fake});
  assert.ok(builderPrompt.startsWith(splitFrontmatter(loadPluginSources().builderMd).body));assert.match(result.text,/BUILT SHA: [a-f0-9]{40}/);
  queue.finish(claimed.id,claimed.token,result);const verified=await verifyBuiltRound(queue,initial.id,root);assert.equal(verified.output.trim(),'verified');assert.equal(queue.get(initial.id).verified,true);
  const criticJob=queue.publish({run:'run',piece:'piece',round:1,requirements:['model:inherit'],excludeMachine:'machine-a',payload:{role:'critic',bar:payload.bar,base:result.pin,model:'inherit'}}),criticClaim=queue.claim('critic');
  assert.equal(criticJob.id,criticClaim.id);
  const verdict=await executeRound({coordinator:queue,job:criticClaim,workRoot:join(root,'worker-b'),transport:async({prompt,options})=>{
    assert.ok(prompt.startsWith(splitFrontmatter(loadPluginSources().criticMd).body));assert.equal(options.resume,undefined);
    assert.ok(!prompt.includes(payload.task));assert.ok(!prompt.includes('FILES CHANGED'));assert.equal(readFileSync(join(options.cwd,'file.txt'),'utf8'),'done\n');
    return Object.assign((async function*(){yield {type:'result',subtype:'success',session_id:'critic-fresh',num_turns:1,total_cost_usd:0.01,result:'VERDICT: WIN\nGAP: none\nEVIDENCE: file.txt says done',is_error:false};})(),{interrupt:async()=>{}});
  }});
  queue.finish(criticClaim.id,criticClaim.token,verdict);queue.cleanup('run');assert.throws(()=>queue.get(initial.id),/unknown round/);assert.equal(existsSync(queue.bundlePath(result.pin)),false);
});
test('payload tampering fails closed and fleet fields are redacted as ordinary template data',t=>{
  const root=temporary(t),queue=new RoundCoordinator(root);worker(queue,'a');const round=job(queue);
  const state=JSON.parse(readFileSync(join(root,'rounds.json'),'utf8'));state.jobs[0].payload.task='mutated';writeFileSync(join(root,'rounds.json'),JSON.stringify(state));
  assert.equal(queue.get(round.id).status,'failed');assert.match(queue.get(round.id).error,/hash mismatch/);
  const html=renderFleetPage(loadFleetTemplate(),{generated:new Date().toISOString(),repos:[],runs:[],workers:[{name:'</script><script>alert(1)</script>',machine:'m',capabilities:['browser'],live:true,seen:1,current:'round'}]});
  assert.ok(html.includes('\\u003c/script>'));assert.ok(html.includes('workers-section'));
  assert.deepEqual(workerEnvironment({GH_TOKEN:'x',Github_Token:'x',ANTHROPIC_API_KEY:'own'}),{ANTHROPIC_API_KEY:'own'});
});
test('lead cancellation fences the claim, stops worker heartbeat, and retains all attempted spend before cleanup',t=>{
  const queue=new RoundCoordinator(temporary(t));worker(queue,'a');const initial=job(queue),claim=queue.claim('a');
  queue.event(claim.id,claim.token,'budget_spend',{costUsd:0.4});assert.equal(queue.cost('run'),0.4);
  queue.cancelRun('run','lead interrupted');assert.equal(queue.get(initial.id).status,'failed');assert.equal(queue.heartbeat('a'),false);
  assert.throws(()=>queue.finish(claim.id,claim.token,'late'),/stale/);
  assert.throws(()=>queue.cleanup('run'),/unacknowledged/);
  queue.event(claim.id,claim.token,'budget_spend',{costUsd:0.1});assert.equal(queue.cost('run'),0.5);
  queue.acknowledgeCancellation(claim.id,claim.token);queue.cleanup('run');
});
test('failed lead verification records a failed round and never authorizes a critic',async t=>{
  const root=temporary(t),cwd=repository(root),queue=new RoundCoordinator(join(root,'queue'));worker(queue,'a');
  const bundle=join(root,'base.bundle'),base=exportRoundBundle(cwd,bundle,'run','piece',1);queue.putBundle(bundle,base);
  const initial=job(queue,{payload:{...payload,base,verify:'node -e "process.exit(3)"'}}),claim=queue.claim('a');
  queue.finish(claim.id,claim.token,{text:'report',pin:base,ownership:{passed:true,violations:[]},costUsd:0});
  await assert.rejects(()=>verifyBuiltRound(queue,initial.id,root),/exited 3/);
  assert.equal(queue.get(initial.id).status,'failed');assert.equal(queue.get(initial.id).verified,false);
});
test('remote dispatch checks the full ownership plan and suppresses unchanged duplicate findings',t=>{
  const root=temporary(t),cwd=repository(root),run='run',directory=runDirectory(cwd,run);mkdirSync(directory,{recursive:true});
  const task={piece:'piece',files:['file.txt'],verify:payload.verify};
  writeFileSync(join(directory,'ownership-plan.json'),JSON.stringify([task]));
  assert.deepEqual(guardDistributedBuilder(cwd,run,task),{coldStart:false,signals:[]});
  assert.throws(()=>guardDistributedBuilder(cwd,run,{...task,files:['outside.txt']}),/differs from the decomposition/);
  const candidate=candidateFingerprint(cwd),verdict='VERDICT: LOSS\nGAP: C1 output is missing\nEVIDENCE: file has before';
  recordDistributedFindings(cwd,run,'piece',1,verdict,candidate);
  assert.deepEqual(recordDistributedFindings(cwd,run,'piece',2,verdict,candidate),['duplicate-round']);
  assert.throws(()=>guardDistributedBuilder(cwd,run,task),/Duplicate findings/);
});
test('the same worker is preferred, continuation sends deltas, and a returned dead-session result restarts cold',async t=>{
  const root=temporary(t),cwd=repository(root),queue=new RoundCoordinator(join(root,'queue'));worker(queue,'a');worker(queue,'b');
  const bundle=join(root,'base.bundle'),base=exportRoundBundle(cwd,bundle,'run','piece',1);queue.putBundle(bundle,base);
  let calls=0;
  const transport=async({prompt,options})=>{
    calls++;
    if(calls===1){assert.equal(options.resume,undefined);writeFileSync(join(options.cwd,'file.txt'),'done\n');}
    if(calls===2){assert.equal(options.resume,'session-1');assert.ok(!prompt.includes(payload.task));assert.match(prompt,/Fix the batched gap/);}
    if(calls===3){assert.equal(options.resume,undefined);assert.ok(prompt.startsWith(splitFrontmatter(loadPluginSources().builderMd).body));}
    const report='FILES CHANGED\n'+(calls===1?'- file.txt':'none')+'\nCOMMANDS RUN\n- '+payload.verify+'\nVERIFICATION\nverified';
    return Object.assign((async function*(){yield {type:'result',subtype:calls===2?'error_during_execution':'success',session_id:'session-'+calls,num_turns:1,total_cost_usd:0.01,result:report,is_error:calls===2,errors:calls===2?['session unavailable']:[]};})(),{interrupt:async()=>{}});
  };
  job(queue,{payload:{...payload,base,maxBudgetUsd:0.2}});const first=queue.claim('a');
  const built=await executeRound({coordinator:queue,job:first,workRoot:join(root,'worker'),transport});queue.finish(first.id,first.token,built);
  job(queue,{round:2,payload:{...payload,base:built.pin,feedback:'Fix the batched gap',maxBudgetUsd:0.2}});
  assert.equal(queue.claim('b'),undefined);const next=queue.claim('a');
  const corrected=await executeRound({coordinator:queue,job:next,workRoot:join(root,'worker'),transport});queue.finish(next.id,next.token,corrected);
  assert.equal(calls,3);const map=JSON.parse(readFileSync(join(root,'worker','runs','run','builders','piece.json'),'utf8'));
  assert.equal(map.rounds,2);assert.equal(map.sessionRounds,1);assert.equal(map.session,'session-3');
});
test('settlement waits for the final worker spend receipt before cleaning and traces it exactly once',async t=>{
  const root=temporary(t),cwd=repository(root),queue=new RoundCoordinator(join(root,'queue')),run='run';
  mkdirSync(runDirectory(cwd,run),{recursive:true});worker(queue,'a');
  const trace=openTrace(cwd,run,()=>{}),budget=createBudget({maxCostUsd:1}),faults=[];
  const lead=createDistributedLead({root:queue.root,cwd,run,trace,budget,maxCostUsd:1,onTrip:()=>{},onFault:reason=>faults.push(reason)});
  job(queue);const claim=queue.claim('a');
  const settling=lead.settle('lead finished');assert.equal(lead.settle('same shutdown'),settling);
  const receipt=setTimeout(()=>{queue.event(claim.id,claim.token,'budget_spend',{costUsd:0.2});queue.acknowledgeCancellation(claim.id,claim.token);},25);
  t.after(()=>clearTimeout(receipt));
  assert.equal(await settling,true);assert.equal(budget.costUsd,0.2);assert.deepEqual(faults,[]);
  assert.equal(trace.read().records.filter(r=>r.kind==='budget_spend').length,1);trace.close();
  assert.equal(JSON.parse(readFileSync(join(queue.root,'rounds.json'),'utf8')).jobs.length,0);
});
test('tracked standards, goals and map survive transport while committed runtime secrets do not',async t=>{
  const root=temporary(t),cwd=repository(root),standing=join(cwd,'.exolvra-genesis');
  for(const name of ['goals','map','runs'])mkdirSync(join(standing,name),{recursive:true});
  writeFileSync(join(standing,'standards.md'),'standing-policy\n');writeFileSync(join(standing,'goals','job.md'),'committed goal\n');
  writeFileSync(join(standing,'map','MAP.md'),'committed map\n');writeFileSync(join(standing,'runs','private.txt'),'runtime-secret\n');
  git(cwd,'add','.exolvra-genesis');git(cwd,'commit','-qm','standing artifacts and legacy run state');
  const bundle=join(root,'standing.bundle'),base=exportRoundBundle(cwd,bundle,'run','piece',1),queue=new RoundCoordinator(join(root,'queue'));queue.putBundle(bundle,base);worker(queue,'a');
  const verify='node -e "const f=require(\'node:fs\');if(f.readFileSync(\'.exolvra-genesis/standards.md\',\'utf8\').trim()!==\'standing-policy\'||!f.existsSync(\'.exolvra-genesis/goals/job.md\')||!f.existsSync(\'.exolvra-genesis/map/MAP.md\')||f.existsSync(\'.exolvra-genesis/runs/private.txt\'))process.exit(3);console.log(\'standing policy verified\')"';
  const published=job(queue,{payload:{...payload,base,verify}}),claimed=queue.claim('a');
  queue.finish(claimed.id,claimed.token,{text:'report',pin:base,ownership:{passed:true,violations:[]},costUsd:0});
  const checked=await verifyBuiltRound(queue,published.id,root);assert.match(checked.output,/standing policy verified/);
});
