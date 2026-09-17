import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PanelJobManager } from '../dist/panel-jobs.js';
import { readRuns } from '../dist/runs-store.js';
import { createSandbox, PACKAGE_ROOT, SAMPLE_PLAN, planAnswer } from './run-cli.js';
import { PREFLIGHT_FAKE } from './preflight-fake.js';

const SDK = `import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export function query({prompt,options}) {
  if (prompt.startsWith('GENESIS_EXECUTION_PREFLIGHT\\n') && process.env.PANEL_PREFLIGHT_HOLD==='1') {
    let stop=false; process.stdout.write('preflight waiting\\n');
    return {async interrupt(){stop=true;},async *[Symbol.asyncIterator](){while(!stop)await new Promise(r=>setTimeout(r,20));yield {type:'result',subtype:'success',session_id:'probe',num_turns:1,total_cost_usd:0.02,result:'interrupted',usage:{input_tokens:1,output_tokens:1}};}};
  }
  ${PREFLIGHT_FAKE}
  writeFileSync(join(options.cwd,'sdk-options.json'),JSON.stringify({prompt,argv:process.argv,model:options.model,agents:options.agents,maxTurns:options.maxTurns,maxBudgetUsd:options.maxBudgetUsd,permissionMode:options.permissionMode,resume:options.resume}));
  let stop=false;
  return {async interrupt(){if(process.env.PANEL_UNRESPONSIVE!=='1')stop=true;},async *[Symbol.asyncIterator](){
    if(process.env.PANEL_OUTPUT_SECRET){const secret=process.env.PANEL_OUTPUT_SECRET;process.stdout.write('secret='+secret.slice(0,9));await new Promise(r=>setTimeout(r,30));process.stdout.write(secret.slice(9)+'\\n');}
    if(process.env.PANEL_BURST==='1'){process.stdout.write('x'.repeat(40000)+'\\n');for(let n=0;n<450;n++)process.stdout.write('bounded output '+n+'\\n');}
    if(process.env.PANEL_HOLD==='1'){process.stdout.write('main waiting\\n');const deadline=Date.now()+17000;while(!stop&&(process.env.PANEL_UNRESPONSIVE!=='1'||Date.now()<deadline))await new Promise(r=>setTimeout(r,20));}
    const path=join(options.cwd,'.exolvra-genesis','state.json');
    if(existsSync(path)&&!stop){const state=JSON.parse(readFileSync(path,'utf8'));state.status='complete';writeFileSync(path,JSON.stringify(state));}
    yield {type:'result',subtype:'success',session_id:'panel-session',num_turns:1,total_cost_usd:0.25,result:${JSON.stringify(planAnswer(SAMPLE_PLAN))},is_error:false,usage:{input_tokens:2,output_tokens:3}};
  }};
}`;

function setup(t,env={}) {
  const root=mkdtempSync(join(tmpdir(),'genesis-panel-jobs-')),project={id:'project-a',name:'Project A',path:join(root,'project'),runCount:0,activeCount:0,goals:[],error:null};mkdirSync(project.path);
  const sandbox=createSandbox();writeFileSync(join(sandbox.root,'node_modules','@anthropic-ai','claude-agent-sdk','index.js'),SDK);
  for(const name of readdirSync(join(PACKAGE_ROOT,'node_modules')).filter(n=>n!=='.bin'&&n!=='@anthropic-ai'))symlinkSync(join(PACKAGE_ROOT,'node_modules',name),join(sandbox.root,'node_modules',name),'junction');
  const options={root,cliPath:sandbox.bin,env:{...process.env,EXOLVRA_GENESIS_AUTO_RESUMES:'0',...env}},manager=new PanelJobManager(options);
  t.after(async()=>{await manager.close().catch(()=>{});sandbox.cleanup();rmSync(root,{recursive:true,force:true});});
  return {root,project,manager,options};
}
async function until(read,accept,ms=12000){const deadline=Date.now()+ms;for(;;){const value=read();if(accept(value))return value;if(Date.now()>=deadline)throw new Error('condition did not arrive: '+JSON.stringify(value));await new Promise(r=>setTimeout(r,40));}}
const done=job=>job&&!['starting','running'].includes(job.status);

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
});

test('a second manager cannot launch another paid command and closing it does not stop someone else’s child',async t=>{
  const {project,manager,options}=setup(t,{PANEL_HOLD:'1'}),launched=manager.start(project,{action:'run',projectId:project.id,input:'hold'});
  await until(()=>manager.get(launched.id),job=>job?.runId!==null&&job?.output.some(line=>line.text.includes('main waiting')));
  const second=new PanelJobManager(options);assert.equal(second.get(launched.id).status,'running');
  assert.throws(()=>second.start(project,{action:'plan',projectId:project.id,input:'race'}),/already active/);await second.close();
  assert.equal(manager.get(launched.id).status,'running');
  const stop=manager.start(project,{action:'stop',projectId:project.id});await until(()=>manager.get(stop.id),done);
  const result=await until(()=>manager.get(launched.id),done);assert.equal(result.status,'interrupted');assert.equal(readRuns(project.path)[0].status,'stopped');assert.equal(readRuns(project.path)[0].costUsd,0.25);
  const third=new PanelJobManager({...options,env:{...options.env,PANEL_HOLD:'0'}});assert.equal(third.get(launched.id).status,'interrupted');
  const resumed=third.start(project,{action:'resume',projectId:project.id,runId:result.runId,maxCostUsd:1,maxTurns:3});
  const continuation=await until(()=>third.get(resumed.id),done);assert.equal(continuation.status,'succeeded',JSON.stringify(continuation));assert.equal(continuation.runId,result.runId);
  assert.equal(JSON.parse(readFileSync(join(project.path,'sdk-options.json'),'utf8')).resume,'panel-session');assert.equal(readRuns(project.path)[0].costUsd,0.5);await third.close();
});

test('early stop waits for preflight interruption and never reports a nonexistent run as stopped',async t=>{
  const {project,manager}=setup(t,{PANEL_PREFLIGHT_HOLD:'1'}),launched=manager.start(project,{action:'run',projectId:project.id,input:'stop before a run exists'});
  const stopped=manager.start(project,{action:'stop',projectId:project.id});
  const result=await until(()=>manager.get(launched.id),done);const receipt=await until(()=>manager.get(stopped.id),done);
  assert.equal(result.status,'interrupted');assert.equal(result.runId,null);assert.equal(receipt.status,'succeeded');assert.deepEqual(readRuns(project.path),[]);
});

test('panel plan uses the shipped command and completed history survives controller recreation',async t=>{
  const {project,manager,options}=setup(t),launched=manager.start(project,{action:'plan',projectId:project.id,input:'--force stays a goal',model:'inherit',maxTurns:3,permissionMode:'acceptEdits'});
  const result=await until(()=>manager.get(launched.id),done);assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(result.runId,null);
  const sdk=JSON.parse(readFileSync(join(project.path,'sdk-options.json'),'utf8'));assert.ok(sdk.prompt.includes('--force stays a goal'));assert.equal(sdk.argv.at(-2),'--');
  await manager.close();const reopened=new PanelJobManager(options);assert.deepEqual(reopened.get(launched.id),result);await reopened.close();
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

test('shutdown has a bounded grace period and preserves an unresponsive command until actual settlement',async t=>{
  const {project,manager}=setup(t,{PANEL_HOLD:'1',PANEL_UNRESPONSIVE:'1'}),launched=manager.start(project,{action:'run',projectId:project.id,input:'Wait for provider settlement'});
  await until(()=>manager.get(launched.id),job=>job?.output.some(line=>line.text.includes('main waiting')));
  const began=Date.now();await assert.rejects(manager.close(),/have not settled/);assert.ok(Date.now()-began<16500);
  const pending=manager.get(launched.id);assert.equal(pending.status,'running');assert.match(pending.error,/billing may still be pending/);
  const settled=await until(()=>manager.get(launched.id),done,6000);assert.equal(settled.status,'interrupted');assert.equal(readRuns(project.path)[0].costUsd,0.25);
});

test('job output is bounded and a reused live PID cannot resurrect an abandoned command',async t=>{
  const {root,project,manager,options}=setup(t,{PANEL_BURST:'1'}),launched=manager.start(project,{action:'plan',projectId:project.id,input:'Bound output'});
  const finished=await until(()=>manager.get(launched.id),done);assert.ok(finished.output.length<=200);assert.ok(finished.output.every(line=>line.text.length<=4096));
  await manager.close();const path=join(root,'.exolvra-genesis','control-panel','jobs',launched.id+'.json'),saved=JSON.parse(readFileSync(path,'utf8'));
  saved.job.status='running';saved.job.finishedAt=null;saved.job.exitCode=null;saved.job.pid=process.pid;saved.processStartedAt=1;writeFileSync(path,JSON.stringify(saved));
  const reopened=new PanelJobManager(options),recovered=reopened.get(launched.id);assert.equal(recovered.status,'interrupted');assert.equal(recovered.exitCode,null);assert.match(recovered.error,/exit result was not observed/);await reopened.close();
});
