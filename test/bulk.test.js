import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {selectTargets,workerEvent,selectionError} from '../.github/ai-bot/src/bulk.js';
const cfg=JSON.parse(await readFile(new URL('../.github/ai-bot/config.json',import.meta.url)));
const env={GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_ACTOR:'owner'};
const event={repository:{full_name:'a/b'},inputs:{target:'all',number:''}};
function github({issues=[],alerts=[],permission='write',privateRepo=false,alertFailure=false}={}){
  const calls=[];return{repo:'a/b',calls,path:(p='')=>`/repos/a/b${p}`,request:async p=>{
    calls.push(p);if(p==='/repos/a/b')return{default_branch:'main',private:privateRepo};
    if(p.includes('/permission'))return{permission};throw new Error('Unexpected route');
  },list:async p=>{calls.push(p);if(p.includes('/dependabot/')){if(alertFailure)throw new Error('Forbidden');return alerts;}return issues;}};
}
test('blank number selects all open Issues and alerts but excludes PRs and Bot housekeeping',async()=>{
  const gh=github({issues:[{number:1,state:'open'},{number:2,state:'open',pull_request:{}},{number:3,state:'closed'},{number:4,state:'open',user:{type:'Bot',login:'github-actions[bot]'}}],alerts:[{number:8,state:'open'},{number:9,state:'dismissed'}]});
  assert.deepEqual(await selectTargets(gh,event,env,cfg,'investigate'),[{kind:'issue',number:'1'},{kind:'dependabot',number:'8'}]);
  assert.deepEqual(await selectTargets(gh,event,env,cfg,'fix'),[{kind:'issue',number:'1'}]);
});
test('explicit number selects one target without enumerating, and invalid combinations fail',async()=>{
  const gh=github();assert.deepEqual(await selectTargets(gh,{...event,inputs:{target:'issue',number:'12'}},env,cfg,'investigate'),[{kind:'issue',number:'12'}]);
  assert.ok(!gh.calls.some(p=>p.includes('?state=')));
  await assert.rejects(selectTargets(gh,{...event,inputs:{target:'all',number:'12'}},env,cfg,'investigate'));
  await assert.rejects(selectTargets(gh,{...event,inputs:{target:'all',result:'report-pr'}},env,cfg,'investigate'));
});
test('bulk selection fails visibly on access or matrix limits rather than silently omitting targets',async()=>{
  await assert.rejects(selectTargets(github({permission:'read'}),event,env,cfg,'fix'));
  await assert.rejects(selectTargets(github({privateRepo:true}),event,env,cfg,'fix'));
  await assert.rejects(selectTargets(github(),event,{...env,GITHUB_REF:'refs/heads/foreign'},cfg,'fix'));
  await assert.rejects(selectTargets(github({alertFailure:true}),event,env,cfg,'investigate'));
  await assert.rejects(selectTargets(github({issues:Array.from({length:257},(_,i)=>({number:i+1,state:'open'}))}),event,env,cfg,'fix'),e=>e.code==='BULK_LIMIT');
});
test('schedule retains existing bounded alert processing and manual mode stays off',async()=>{
  assert.deepEqual(await selectTargets(github(),event,{...env,GITHUB_EVENT_NAME:'schedule'},cfg,'investigate'),[]);
  assert.deepEqual(await selectTargets(github(),event,{...env,GITHUB_EVENT_NAME:'schedule'},{...cfg,mode:'automatic'},'investigate'),[{kind:'dependabot',number:'schedule'}]);
});
test('workers route only dispatch inputs and preserve original Issue-comment authorization',()=>{
  const routed=workerEvent({...env,AI_BOT_WORKER:'true',AI_BOT_NUMBER:'7',AI_BOT_TARGET:'issue',AI_BOT_RESULT:'report-pr',AI_BOT_REFERENCE:'off'},event);
  assert.equal(routed.inputs.number,'7');assert.equal(routed.inputs.reference_previous,'off');
  assert.deepEqual(workerEvent({...env,AI_BOT_WORKER:'true',GITHUB_EVENT_NAME:'issue_comment'},event),event);
  assert.deepEqual(workerEvent(env,event),event);
});
test('reusable workers isolate artifact names between target jobs and keep keys separate from validation',async()=>{
  for(const name of ['fix','investigate']){
    const text=await readFile(new URL(`../.github/workflows/${name}-one.yml`,import.meta.url),'utf8');
    assert.ok(text.includes('workflow_call:'));
    assert.ok(!text.includes('ref: ${{ needs.prepare.outputs.sha }}'));
    assert.equal([...text.matchAll(/uses: actions\/checkout@/g)].length,[...text.matchAll(/ref: \$\{\{ github.event.repository.default_branch \}\}/g)].length);
    for(const match of text.matchAll(/name: ((?:fix|investigation)-(?:bundle|plan|verdict|result)[^\n]*)/g))assert.ok(match[1].includes('inputs.number'));
  }
  const fix=await readFile(new URL('../.github/workflows/fix-one.yml',import.meta.url),'utf8');
  const validation=fix.slice(fix.indexOf('  validate:'),fix.indexOf('  publish:'));
  assert.ok(!validation.includes('secrets.'));assert.ok(validation.includes('offline'));
});
test('unrelated comments return without requesting repository metadata or permissions',async()=>{
  for(const mode of ['fix','investigate']){
    const gh={repo:'a/b',request:async()=>assert.fail('No API work for unrelated text')};
    const comment={...event,action:'created',issue:{number:1},comment:{body:'normal conversation',user:{type:'User',login:'owner'}}};
    assert.deepEqual(await selectTargets(gh,comment,{...env,GITHUB_EVENT_NAME:'issue_comment'},cfg,mode),[]);
  }
});
test('shared scheduling admission belongs to authorized jobs rather than untrusted workflow events',async()=>{
  for(const name of ['fix','investigate','bot-updates','auto-merge','proposal-updates']){
    const text=await readFile(new URL(`../.github/workflows/${name}.yml`,import.meta.url),'utf8');
    assert.ok(!/^concurrency:/m.test(text),name);
    if(['fix','investigate'].includes(name)){
      assert.ok(text.includes('needs.select.outputs.ready'));assert.ok(text.includes('matrix.number'));
      assert.ok(text.includes('    concurrency:'));
      if(name==='fix'){
        // cancel-in-progress:false alone still replaces pending runs under GitHub's single-slot default.
        assert.match(text,/^      queue: max$/m);
        assert.match(text,/^      cancel-in-progress: false$/m);
        assert.ok(text.includes('group: ai-fix-${{ github.repository }}-${{ matrix.kind }}-${{ matrix.number }}'));
      }
    }
  }
});

test('selection reports safe, actionable reasons for invalid inputs and unavailable alert lists',async()=>{
  for(const [inputs,code]of [[{target:'all',number:'1'},'BULK_NUMBER'],[{target:'all',result:'report-pr'},'BULK_REPORT']]){
    await assert.rejects(selectTargets(github(),{...event,inputs},env,cfg,'investigate'),e=>e.code===code);
    assert.ok(!selectionError({code}).includes('権限・Dependabot'));
  }
  await assert.rejects(selectTargets(github({alertFailure:true}),event,env,cfg,'investigate'),e=>e.code==='BULK_ALERTS');
  assert.ok(selectionError({code:'BULK_ALERTS'}).includes('target=issue'));
  assert.ok(!selectionError({message:'secret-api-key'}).includes('secret-api-key'));
});
