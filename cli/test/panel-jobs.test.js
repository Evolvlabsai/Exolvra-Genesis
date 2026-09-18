import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PanelJobManager } from '../dist/panel-jobs.js';
import { readRuns } from '../dist/runs-store.js';
import { createSandbox, PACKAGE_ROOT } from './run-cli.js';
import { PANEL_SDK } from './panel-sdk-fake.js';

function setup(t,env={}) {
  const root=mkdtempSync(join(tmpdir(),'genesis-panel-jobs-')),project={id:'project-a',name:'Project A',path:join(root,'project'),runCount:0,activeCount:0,goals:[],error:null};mkdirSync(project.path);
  const sandbox=createSandbox();writeFileSync(join(sandbox.root,'node_modules','@anthropic-ai','claude-agent-sdk','index.js'),PANEL_SDK);
  for(const name of readdirSync(join(PACKAGE_ROOT,'node_modules')).filter(n=>n!=='.bin'&&n!=='@anthropic-ai'))symlinkSync(join(PACKAGE_ROOT,'node_modules',name),join(sandbox.root,'node_modules',name),'junction');
  const options={root,cliPath:sandbox.bin,env:{...process.env,EXOLVRA_GENESIS_AUTO_RESUMES:'0',...env}},manager=new PanelJobManager(options);
  // Detached commands outlive a closed panel, so every manager a test opens settles its own children before cleanup.
  const managers=[manager];const open=(extra={})=>{const next=new PanelJobManager({...options,...extra});managers.push(next);return next;};
  t.after(async()=>{for(const m of managers.reverse())await m.close({settle:true}).catch(()=>{});sandbox.cleanup();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  return {root,project,manager,options,open};
}
async function until(read,accept,ms=12000){const deadline=Date.now()+ms;for(;;){const value=read();if(accept(value))return value;if(Date.now()>=deadline)throw new Error('condition did not arrive: '+JSON.stringify(value));await new Promise(r=>setTimeout(r,40));}}
const done=job=>job&&!['queued','starting','running'].includes(job.status);

test('panel runs the real CLI, preserves literal goal arguments, records its own run and redacts split output',async t=>{
  const secret='ghp_'+('a'.repeat(36)),{root,project,manager}=setup(t,{PANEL_OUTPUT_SECRET:secret});
  const launched=manager.start(project,{action:'run',projectId:project.id,input:'--model invalid; this is literal goal text',model:'claude-sonnet-5',builderModel:'opus',criticModel:'haiku',maxCostUsd:1,maxTurns:3,maxRounds:2});
  assert.ok(['starting','running'].includes(launched.status));const finished=await until(()=>manager.get(launched.id),done);
  assert.equal(finished.status,'succeeded',JSON.stringify(finished));assert.equal(finished.exitCode,0);assert.equal(readRuns(project.path)[0].id,finished.runId);
  const sdk=JSON.parse(readFileSync(join(project.path,'sdk-options.json'),'utf8'));assert.ok(sdk.prompt.includes('--model invalid; this is literal goal text'));assert.equal(sdk.model,'claude-sonnet-5');assert.equal(sdk.maxTurns,3);assert.equal(sdk.maxBudgetUsd,1);
  assert.ok(sdk.argv.includes('--auto'));assert.ok(sdk.argv.includes('--json'));assert.ok(sdk.argv.includes('--no-config'));assert.equal(sdk.argv.at(-2),'--');
  assert.equal(finished.output.some(line=>line.text.includes(secret)),false);assert.ok(finished.output.some(line=>line.text.includes('[redacted]')));
  assert.equal(readFileSync(join(root,'.exolvra-genesis','control-panel','jobs',launched.id+'.json'),'utf8').includes(secret),false);
});

test('panel validates every action input and does not silently accept irrelevant options',async t=>{
  const {project,manager}=setup(t);
  for(const request of [
    {action:'work'}, {action:'run',input:'x',model:'sonnet'}, {action:'run',input:'x',builderModel:'claude-opus-5'},
    {action:'run',input:'x',maxCostUsd:0}, {action:'run',input:'x',maxTurns:1.2}, {action:'run',input:'x',maxRounds:Infinity},
    {action:'run',input:'x',permissionMode:'allowAll'}, {action:'run',input:'x\0y'}, {action:'plan',input:'x',maxCostUsd:2},
    {action:'resume',runId:'../bad'}, {action:'stop',force:true}, {action:'doctor',input:'x'}, {action:'chart',input:'x',force:true},
  ]) assert.throws(()=>manager.start(project,{projectId:project.id,...request}));
  assert.equal(manager.list().length,0);
  assert.throws(()=>new PanelJobManager({root:join(project.path),cliPath:process.execPath,concurrency:0}),/concurrency/);
});

test('a second manager queues behind someone else’s paid command, can cancel its own queued work, and closing it leaves the child alone',async t=>{
  const {project,manager,options,open}=setup(t,{PANEL_HOLD:'1'}),launched=manager.start(project,{action:'run',projectId:project.id,input:'hold'});
  await until(()=>manager.get(launched.id),job=>job?.runId!==null&&job?.output.some(line=>line.text.includes('main waiting')));
  const second=open();assert.equal(second.get(launched.id).status,'running');
  const queued=second.start(project,{action:'plan',projectId:project.id,input:'waits its turn'});assert.equal(queued.status,'queued');
  assert.equal(second.cancel(queued.id).status,'cancelled');assert.throws(()=>second.cancel(queued.id),/only a queued/);
  assert.deepEqual(await second.close(),[]);
  assert.equal(manager.get(launched.id).status,'running');assert.equal(manager.get(queued.id).status,'cancelled');
  const stop=manager.start(project,{action:'stop',projectId:project.id});await until(()=>manager.get(stop.id),done);
  const result=await until(()=>manager.get(launched.id),done);assert.equal(result.status,'interrupted');assert.equal(readRuns(project.path)[0].status,'stopped');assert.equal(readRuns(project.path)[0].costUsd,0.25);
  const third=open({env:{...options.env,PANEL_HOLD:'0'}});assert.equal(third.get(launched.id).status,'interrupted');
  const resumed=third.start(project,{action:'resume',projectId:project.id,runId:result.runId,maxCostUsd:1,maxTurns:3});
  const continuation=await until(()=>third.get(resumed.id),done);assert.equal(continuation.status,'succeeded',JSON.stringify(continuation));assert.equal(continuation.runId,result.runId);
  assert.equal(JSON.parse(readFileSync(join(project.path,'sdk-options.json'),'utf8')).resume,'panel-session');assert.equal(readRuns(project.path)[0].costUsd,0.5);
});

test('early stop waits for preflight interruption and never reports a nonexistent run as stopped',async t=>{
  const {project,manager}=setup(t,{PANEL_PREFLIGHT_HOLD:'1'}),launched=manager.start(project,{action:'run',projectId:project.id,input:'stop before a run exists'});
  const stopped=manager.start(project,{action:'stop',projectId:project.id});
  const result=await until(()=>manager.get(launched.id),done);const receipt=await until(()=>manager.get(stopped.id),done);
  assert.equal(result.status,'interrupted');assert.equal(result.runId,null);assert.equal(receipt.status,'succeeded');assert.deepEqual(readRuns(project.path),[]);
});

test('panel plan uses the shipped command and completed history survives controller recreation',async t=>{
  const {project,manager,open}=setup(t),launched=manager.start(project,{action:'plan',projectId:project.id,input:'--force stays a goal',model:'inherit',maxTurns:3,permissionMode:'acceptEdits'});
  const result=await until(()=>manager.get(launched.id),done);assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(result.runId,null);
  const sdk=JSON.parse(readFileSync(join(project.path,'sdk-options.json'),'utf8'));assert.ok(sdk.prompt.includes('--force stays a goal'));assert.equal(sdk.argv.at(-2),'--');
  await manager.close();const reopened=open();assert.deepEqual(reopened.get(launched.id),result);
});

test('doctor and chart use their actual commands, with chart constrained to local unattended work',async t=>{
  const {project,manager}=setup(t);
  const doctor=manager.start(project,{action:'doctor',projectId:project.id});const observed=await until(()=>manager.get(doctor.id),done);
  assert.equal(observed.runId,null);assert.ok(observed.output.some(line=>line.text.includes('"readOnly":true')));
  const map=join(project.path,'.exolvra-genesis','map');mkdirSync(join(map,'tickets'),{recursive:true});
  writeFileSync(join(map,'MAP.md'),'# Map\n\n## Destination\nA build-ready local tool\n\n## Notes\nnone\n\n## Decisions so far\nnone\n\n## Not yet specified\nRepository limits\n\n## Out of scope\nRemote changes\n');
  writeFileSync(join(map,'tickets','research.md'),'# Find repository limits\n\nType: research\nStatus: open\nMode: AFK\nBlocked by: none\nClaim: none\n\n## Question\nWhich repository limits apply?\n\n## Answer\nnone\n');
  const chart=manager.start(project,{action:'chart',projectId:project.id,input:'Find repository limits',model:'inherit'});const charted=await until(()=>manager.get(chart.id),done);
  assert.equal(charted.status,'failed','invalid external proposal must remain a truthful command failure');
  assert.ok(existsSync(join(project.path,'sdk-options.json')),JSON.stringify(charted));
  const sdk=JSON.parse(readFileSync(join(project.path,'sdk-options.json'),'utf8'));assert.ok(sdk.argv.includes('--afk'));assert.equal(sdk.argv[sdk.argv.indexOf('--tracker')+1],'local');assert.equal(charted.runId,null);
});

test('a closed panel leaves its command running; the next panel adopts it, reads its later output, stops it and records its real exit',async t=>{
  const {root,project,manager,open}=setup(t,{PANEL_HOLD:'1'}),launched=manager.start(project,{action:'run',projectId:project.id,input:'Survive a panel restart'});
  await until(()=>manager.get(launched.id),job=>job?.runId!==null&&job?.output.some(line=>line.text.includes('main waiting')));
  const continuing=await manager.close();assert.equal(continuing.length,1);assert.equal(continuing[0].id,launched.id);assert.equal(continuing[0].status,'running');
  const saved=JSON.parse(readFileSync(join(root,'.exolvra-genesis','control-panel','jobs',launched.id+'.json'),'utf8'));assert.match(saved.job.error,/Continues after the panel/);
  const reopened=open();const adopted=await until(()=>reopened.get(launched.id),job=>job?.status==='running');
  assert.match(adopted.error,/continues from an earlier panel session/);assert.equal(adopted.pid,launched.pid);
  const stop=reopened.start(project,{action:'stop',projectId:project.id});await until(()=>reopened.get(stop.id),done);
  const result=await until(()=>reopened.get(launched.id),done);
  assert.equal(result.status,'interrupted',JSON.stringify(result));assert.equal(typeof result.exitCode,'number','the exit receipt carries the real code');
  assert.ok(result.output.at(-1).seq>adopted.output.at(-1).seq,'output written after the restart was folded in');
  assert.equal(readRuns(project.path)[0].status,'stopped');assert.equal(readRuns(project.path)[0].costUsd,0.25);
  assert.ok(existsSync(join(root,'.exolvra-genesis','control-panel','jobs',launched.id+'.exit.json')));
});

test('paid commands wait per project and per execution slot, keep their place across a panel restart, and cancel only while queued',async t=>{
  const {root,project,manager,options,open}=setup(t,{PANEL_HOLD:'1'});
  const other={id:'project-b',name:'Project B',path:join(root,'project-b'),runCount:0,activeCount:0,goals:[],error:null};mkdirSync(other.path);
  const first=manager.start(project,{action:'run',projectId:project.id,input:'first'});
  const second=manager.start(project,{action:'plan',projectId:project.id,input:'second, same project'});
  const third=manager.start(other,{action:'plan',projectId:other.id,input:'third, other project'});
  assert.equal(second.status,'queued');assert.equal(third.status,'queued','the default limit is one paid command at a time');
  const doctor=manager.start(other,{action:'doctor',projectId:other.id});assert.notEqual(doctor.status,'queued','read-only checks never wait');
  await until(()=>manager.get(doctor.id),done);
  await until(()=>manager.get(first.id),job=>job?.output.some(line=>line.text.includes('main waiting')));
  assert.equal(manager.get(second.id).status,'queued');assert.equal(manager.get(third.id).status,'queued');
  assert.equal((await manager.close()).length,1);
  assert.equal(JSON.parse(readFileSync(join(root,'.exolvra-genesis','control-panel','jobs',third.id+'.json'),'utf8')).job.status,'queued');
  const reopened=open({concurrency:2,env:{...options.env,PANEL_HOLD:'0'}});
  const planB=await until(()=>reopened.get(third.id),done);assert.equal(planB.status,'succeeded',JSON.stringify(planB));
  assert.equal(reopened.get(second.id).status,'queued','the same project still has an active run');
  assert.equal(reopened.cancel(second.id).status,'cancelled');assert.throws(()=>reopened.cancel(first.id),/only a queued/);
  const stop=reopened.start(project,{action:'stop',projectId:project.id});await until(()=>reopened.get(stop.id),done);
  assert.equal((await until(()=>reopened.get(first.id),done)).status,'interrupted');
  assert.equal(reopened.list().filter(job=>job.status==='queued').length,0);
});

test('job output is bounded and a reused live PID cannot resurrect an abandoned command',async t=>{
  const {root,project,manager,open}=setup(t,{PANEL_BURST:'1'}),launched=manager.start(project,{action:'plan',projectId:project.id,input:'Bound output'});
  const finished=await until(()=>manager.get(launched.id),done);assert.ok(finished.output.length<=200);assert.ok(finished.output.every(line=>line.text.length<=4096));
  await manager.close();const path=join(root,'.exolvra-genesis','control-panel','jobs',launched.id+'.json'),saved=JSON.parse(readFileSync(path,'utf8'));
  saved.job.status='running';saved.job.finishedAt=null;saved.job.exitCode=null;saved.job.pid=process.pid;saved.processStartedAt=1;writeFileSync(path,JSON.stringify(saved));
  const reopened=open(),recovered=reopened.get(launched.id);assert.equal(recovered.status,'interrupted');assert.equal(recovered.exitCode,null);assert.match(recovered.error,/exit result was not observed/);
});
