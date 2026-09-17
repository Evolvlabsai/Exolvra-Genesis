import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSandbox, PACKAGE_ROOT } from './run-cli.js';
import { PREFLIGHT_FAKE } from './preflight-fake.js';
import { appendRun, readRuns, runDirectory, writeState } from '../dist/runs-store.js';
import { DEFAULT_MODEL_CHOICE } from '../dist/models.js';
import { RoundCoordinator } from '../dist/distributed.js';

const SDK = `import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RoundCoordinator } from '../../../dist/distributed.js';
export function query({prompt,options}) {
${PREFLIGHT_FAKE}
  const match=prompt.match(/Runtime metadata: (.*)$/m);
  if(!match) throw new Error('distributed metadata absent from actual lead session');
  const metadata=JSON.parse(match[1]);
  writeFileSync(join(options.cwd,'lead-prompt.txt'),prompt);
  const queue=new RoundCoordinator(metadata.coordinator);
  const worker='remote-'+process.pid;
  queue.register({id:worker,name:'remote',machine:'machine-b',capabilities:['model:inherit']});
  const pin={sha:'a'.repeat(40),digest:'b'.repeat(64),ref:'refs/exolvra/rounds/'+metadata.run+'/piece/1'};
  queue.publish({run:metadata.run,piece:'piece',round:1,requirements:['model:inherit'],payload:{role:'builder',task:'Task Spec',files:['file.txt'],verify:'node --version',bar:'bar',base:pin,model:'inherit'}});
  const claimed=queue.claim(worker);
  if(!(claimed.payload.maxBudgetUsd>0 && claimed.payload.maxBudgetUsd<=1)) throw new Error('worker cap not configured from run budget');
  queue.event(claimed.id,claimed.token,'budget_spend',{costUsd:0.3});
  if(options.env.TEST_DISTRIBUTED_HOLD==='1') writeFileSync(join(options.cwd,'held-claim.json'),JSON.stringify(claimed));
  else queue.finish(claimed.id,claimed.token,{text:'worker settled',pin,ownership:{passed:true,violations:[]},costUsd:0.3});
  if(options.env.TEST_DISTRIBUTED_HOLD!=='1') queue.publish({run:metadata.run,piece:'unstarted',round:1,requirements:['model:inherit'],payload:{role:'builder',task:'Task Spec',files:['other.txt'],verify:'node --version',bar:'bar',base:pin,model:'inherit'}});
  writeFileSync(join(options.cwd,'.exolvra-genesis','state.json'),JSON.stringify({status:'complete',run:metadata.run}));
  return {async interrupt(){},async *[Symbol.asyncIterator](){yield {type:'result',subtype:'success',session_id:'lead-session',num_turns:1,total_cost_usd:0.2,result:'Finished',is_error:false};}};
}`;
function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'genesis-lead-distributed-')),queue=join(root,'queue'),project=join(root,'project');mkdirSync(queue);mkdirSync(project);
  const sandbox=createSandbox();writeFileSync(join(sandbox.root,'node_modules','@anthropic-ai','claude-agent-sdk','index.js'),SDK);
  for (const name of readdirSync(join(PACKAGE_ROOT,'node_modules')).filter(name=>name!=='@anthropic-ai'&&name!=='.bin')) symlinkSync(join(PACKAGE_ROOT,'node_modules',name),join(sandbox.root,'node_modules',name),'junction');
  t.after(()=>{sandbox.cleanup();rmSync(root,{recursive:true,force:true});});return {root,queue,project,sandbox};
}
test('run dispatch metadata, worker budget, aggregate spend and cancellation are wired through the real command',t=>{
  const {queue,project,sandbox}=setup(t);
  const result=sandbox.run(['run','goal','--auto','--no-config','--json','--max-cost','1','--coordinator',queue,'-C',project],{cwd:project,env:{EXOLVRA_GENESIS_AUTO_RESUMES:'0'}});
  assert.equal(result.code,0,result.stderr+'\n'+result.stdout);
  const summary=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(summary.cost_usd,0.5);
  const rows=readRuns(project);assert.equal(rows.length,1);assert.equal(rows[0].costUsd,0.5);
  assert.equal(rows[0].distributedCostUsd,0.3);
  assert.match(readFileSync(join(project,'lead-prompt.txt'),'utf8'),/## Distributed-round transport/);
  assert.equal(JSON.parse(readFileSync(join(queue,'rounds.json'),'utf8')).jobs.length,0);
  assert.equal(new RoundCoordinator(queue).workers()[0].current,null);
  assert.equal(JSON.parse(readFileSync(join(runDirectory(project,rows[0].id),'distributed.json'),'utf8')).coordinator,queue);
});

test('blocked settlement resumes without counting retained spend twice and records a late final receipt',t=>{
  const {queue,project,sandbox}=setup(t);
  const first=sandbox.run(['run','goal','--auto','--no-config','--json','--max-cost','1','--coordinator',queue,'-C',project],{cwd:project,env:{EXOLVRA_GENESIS_AUTO_RESUMES:'0',TEST_DISTRIBUTED_HOLD:'1'}});
  assert.equal(first.code,1,first.stderr+'\n'+first.stdout);
  const saved=readRuns(project)[0];assert.equal(saved.status,'blocked');assert.equal(saved.costUsd,0.5);assert.equal(saved.distributedCostUsd,0.3);
  const coordinator=new RoundCoordinator(queue),claim=JSON.parse(readFileSync(join(project,'held-claim.json'),'utf8'));
  assert.deepEqual(coordinator.pendingCancellations(saved.id),[claim.id]);
  coordinator.event(claim.id,claim.token,'budget_spend',{costUsd:0.1});
  coordinator.acknowledgeCancellation(claim.id,claim.token);
  const resumed=sandbox.run(['resume',saved.id,'--json','--max-cost','1','-C',project],{cwd:project,env:{EXOLVRA_GENESIS_AUTO_RESUMES:'0'}});
  assert.equal(resumed.code,0,resumed.stderr+'\n'+resumed.stdout);
  const settled=readRuns(project)[0];assert.ok(Math.abs(settled.costUsd-1.1)<1e-9);assert.ok(Math.abs(settled.distributedCostUsd-0.7)<1e-9);
  assert.ok(Math.abs(coordinator.cost(saved.id)-0.7)<1e-9);
  coordinator.cleanup(saved.id);assert.ok(Math.abs(coordinator.cost(saved.id)-0.7)<1e-9,'repeated cleanup preserves one cumulative receipt');
  assert.equal(JSON.parse(readFileSync(join(queue,'rounds.json'),'utf8')).jobs.length,0);
  assert.equal(settled.input,saved.input);assert.equal(settled.startedAt,saved.startedAt);assert.deepEqual(settled.models,saved.models);
});
test('resume discovers the recorded coordinator and includes transport instructions and spend',t=>{
  const {queue,project,sandbox}=setup(t),id='r-distributed-resume';
  appendRun(project,{id,sessionId:'old-session',input:'goal',models:DEFAULT_MODEL_CHOICE,startedAt:new Date().toISOString(),status:'stopped',costUsd:0.1});
  writeState(project,'stopped',id);mkdirSync(runDirectory(project,id),{recursive:true});
  writeFileSync(join(runDirectory(project,id),'distributed.json'),JSON.stringify({coordinator:queue}));
  const result=sandbox.run(['resume',id,'--json','--max-cost','1','-C',project],{cwd:project,env:{EXOLVRA_GENESIS_AUTO_RESUMES:'0'}});
  assert.equal(result.code,0,result.stderr+'\n'+result.stdout);
  const summary=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.ok(Math.abs(summary.cost_usd-0.6)<1e-9);
  assert.match(readFileSync(join(project,'lead-prompt.txt'),'utf8'),/## Distributed-round transport/);
  assert.equal(JSON.parse(readFileSync(join(queue,'rounds.json'),'utf8')).jobs.length,0);
});
