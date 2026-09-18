import { SAMPLE_PLAN, planAnswer } from './run-cli.js';
import { PREFLIGHT_FAKE } from './preflight-fake.js';

/**
 * A fake Agent SDK for panel tests. PANEL_HOLD keeps the session open until
 * an interrupt; PANEL_PREFLIGHT_HOLD does the same for the execution probe;
 * PANEL_BURST floods stdout; PANEL_OUTPUT_SECRET splits a secret across writes.
 */
export const PANEL_SDK = `import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
