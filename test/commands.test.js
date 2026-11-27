import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCommand, requireCommand } from '../.github/ai-bot/src/commands.js';
import { prepare, publish } from '../.github/ai-bot/src/main.js';
import { prepareFix, publishFix } from '../.github/ai-bot/src/fix.js';
const cfg=JSON.parse(await readFile(new URL('../.github/ai-bot/config.json',import.meta.url)));
const sha='a'.repeat(40);
const eventFor=command=>({repository:{full_name:'a/b'},action:'created',issue:{number:2},comment:{id:123,body:command,user:{login:'owner',type:'User'}}});
const envFor=dir=>({GITHUB_REPOSITORY:'a/b',GITHUB_ACTOR:'owner',GITHUB_REF:'refs/heads/main',GITHUB_SHA:sha,GITHUB_EVENT_NAME:'issue_comment',GITHUB_EVENT_PATH:join(dir,'event.json'),GITHUB_RUN_ID:'1'});
function github(command,{permission='write',body=command,login='owner',issueUrl='https://api.github.com/repos/a/b/issues/2'}={}){
  const calls=[];
  return {repo:'a/b',calls,path:(tail='')=>`/repos/a/b${tail}`,list:async()=>[],request:async(path,method='GET',payload)=>{
    calls.push({path,method,payload});if(method!=='GET')return{};
    if(path==='/repos/a/b')return{private:false,default_branch:'main'};
    if(path.includes('/permission'))return{permission};
    if(path==='/repos/a/b/issues/comments/123')return{body,user:{login,type:'User'},issue_url:issueUrl};
    if(path==='/repos/a/b/issues/2')return{number:2,state:'open',title:'Fix add',body:'Expected add(2,3) to return 5',labels:[]};
    if(path.includes('/git/ref/heads/'))return{object:{sha}};
    if(path.includes('/git/trees/'))return{tree:[]};
    throw new Error(`Unexpected mocked route: ${path}`);
  }};
}
async function fixture(fn){
  const original=process.cwd(),dir=await mkdtemp(join(tmpdir(),'ai-bot-command-'));
  await mkdir(join(dir,'.github/ai-bot'),{recursive:true});await mkdir(join(dir,'.work'));
  await writeFile(join(dir,'.github/ai-bot/config.json'),JSON.stringify(cfg));
  process.chdir(dir);try{await fn({dir,env:envFor(dir)});}finally{process.chdir(original);await rm(dir,{recursive:true,force:true});}
}
test('only an exact standalone command in a new human Issue comment is accepted',()=>{
  const env=envFor('/tmp');
  assert.equal(isCommand(eventFor(' /ai-fix\n'),env,'/ai-fix'),true);
  for(const body of ['/ai-fix now','text /ai-fix','> /ai-fix','```\n/ai-fix\n```','/ai-fix\n/ai-investigate','/ai-fixer','/AI-FIX'])assert.equal(isCommand(eventFor(body),env,'/ai-fix'),false,body);
  for(const event of [{...eventFor('/ai-fix'),action:'edited'},{...eventFor('/ai-fix'),issue:{number:2,pull_request:{}}},{...eventFor('/ai-fix'),comment:{body:'/ai-fix',user:{type:'Bot',login:'owner'}}},{...eventFor('/ai-fix'),comment:{body:'/ai-fix',user:{type:'User',login:'someone'}}}])assert.equal(isCommand(event,env,'/ai-fix'),false);
});
test('live comment must still match its author, Issue and exact command',async()=>{
  const env=envFor('/tmp'),event=eventFor('/ai-fix');
  assert.equal(await requireCommand(github('/ai-fix'),event,env,'/ai-fix'),2);
  for(const options of [{body:'edited'},{login:'other'},{issueUrl:'https://api.github.com/repos/a/b/issues/3'}])await assert.rejects(requireCommand(github('/ai-fix',options),event,env,'/ai-fix'),e=>e.code==='ACCESS');
  await assert.rejects(requireCommand(github('/ai-fix'),{...event,repository:{full_name:'other/repo'}},env,'/ai-fix'),e=>e.code==='ACCESS');
});
test('slash commands work without labels and with investigation mode manual',()=>fixture(async({env})=>{
  await writeFile('event.json',JSON.stringify(eventFor('/ai-investigate')));
  await prepare(env,github('/ai-investigate'));
  assert.equal(JSON.parse(await readFile('.work/bundle.json')).targets[0].number,2);
  await writeFile('event.json',JSON.stringify(eventFor('/ai-fix')));
  await prepareFix(env,github('/ai-fix'));
  assert.equal(JSON.parse(await readFile('.work/fix-bundle.json')).targets[0].number,2);
}));
test('unrelated comments never request source or create work',()=>fixture(async({env})=>{
  await writeFile('event.json',JSON.stringify(eventFor('normal comment')));
  const gh=github('normal comment');
  await prepare(env,gh);await prepareFix(env,gh);assert.equal(gh.calls.length,0);
  await assert.rejects(access('.work/bundle.json'));await assert.rejects(access('.work/fix-bundle.json'));
}));
test('both command paths reject read-only users before retrieving source',()=>fixture(async({env})=>{
  for(const [command,action] of [['/ai-fix',prepareFix],['/ai-investigate',prepare]]){
    await writeFile('event.json',JSON.stringify(eventFor(command)));
    const gh=github(command,{permission:'read'});
    await assert.rejects(action(env,gh),e=>e.code==='ACCESS');
    assert.ok(!gh.calls.some(c=>c.path.includes('/git/trees/')));
  }
}));
test('deleted or edited command cannot start AI work',()=>fixture(async({env})=>{
  for(const [command,action] of [['/ai-fix',prepareFix],['/ai-investigate',prepare]]){
    await writeFile('event.json',JSON.stringify(eventFor(command)));
    const gh=github(command,{body:'cancelled'});
    await assert.rejects(action(env,gh),e=>e.code==='ACCESS');
    assert.ok(!gh.calls.some(c=>c.path.includes('/git/trees/')));
  }
}));
test('investigation publication rechecks command and actor before posting',()=>fixture(async({env})=>{
  const event=eventFor('/ai-investigate');await writeFile('event.json',JSON.stringify(event));
  await prepare(env,github('/ai-investigate'));
  await writeFile('.work/result.json',JSON.stringify({results:[{ok:true,provider:cfg.provider,text:'調査結果'}]}));
  const gh=github('/ai-investigate');await publish(env,gh);
  assert.ok(gh.calls.some(c=>c.method==='POST' && c.path==='/repos/a/b/issues/2/comments'));
  for(const options of [{body:'cancelled'},{permission:'read'}]){
    const denied=github('/ai-investigate',options);await assert.rejects(publish(env,denied),e=>e.code==='ACCESS');
    assert.equal(denied.calls.filter(c=>c.method!=='GET').length,0);
  }
}));
test('fix publication rechecks slash command and rejects redirected Issue targets',()=>fixture(async({env})=>{
  await writeFile('event.json',JSON.stringify(eventFor('/ai-fix')));
  await prepareFix(env,github('/ai-fix'));
  await writeFile('.work/fix-plan.json',JSON.stringify({ok:false,reason:'模擬API失敗'}));
  await writeFile('.work/fix-verdict.json',JSON.stringify({ok:false,reason:'模擬API失敗'}));
  const gh=github('/ai-fix');await assert.rejects(publishFix(env,gh),e=>e.code==='OUTPUT'&&e.phase==='generation');
  assert.ok(gh.calls.some(c=>c.method==='POST' && c.path==='/repos/a/b/issues/2/comments'));
  const denied=github('/ai-fix',{body:'cancelled'});await assert.rejects(publishFix(env,denied),e=>e.code==='ACCESS');
  assert.equal(denied.calls.filter(c=>c.method!=='GET').length,0);
  await writeFile('event.json',JSON.stringify({...eventFor('/ai-fix'),issue:{number:3}}));
  const redirected=github('/ai-fix');await assert.rejects(publishFix(env,redirected),e=>e.code==='ACCESS');assert.equal(redirected.calls.length,0);
}));


test('fix replies follow each new command; rerunning one command updates only its own reply',()=>fixture(async({env})=>{
  await writeFile('event.json',JSON.stringify(eventFor('/ai-fix')));
  await prepareFix(env,github('/ai-fix'));
  await writeFile('.work/fix-plan.json',JSON.stringify({ok:false,reason:'模擬失敗'}));
  await writeFile('.work/fix-verdict.json',JSON.stringify({ok:false,reason:'模擬失敗'}));
  const old={id:456,user:{login:'github-actions[bot]',type:'Bot'},body:'<!-- ai-fix:issue:2 -->\n古いラベル実行の結果'};
  const gh=github('/ai-fix');gh.list=async()=>[old];
  await assert.rejects(publishFix(env,gh),e=>e.code==='OUTPUT'&&e.phase==='generation');
  const created=gh.calls.find(c=>c.method==='POST');
  assert.equal(created.path,'/repos/a/b/issues/2/comments');
  assert.ok(created.payload.body.startsWith('<!-- ai-fix:issue:2 --><!-- ai-command:123 -->'));
  const own={...old,id:789,body:created.payload.body};
  const rerun=github('/ai-fix');rerun.list=async()=>[old,own];
  await assert.rejects(publishFix(env,rerun),e=>e.code==='OUTPUT'&&e.phase==='generation');
  assert.equal(rerun.calls.find(c=>c.method==='PATCH').path,'/repos/a/b/issues/comments/789');
}));
test('reference options accept only exact standalone syntax and preserve live-comment authorization',async()=>{
  const env=envFor('/tmp');
  for(const command of ['/ai-fix','/ai-report-pr']){
    for(const flag of ['--reference','--no-reference']){
      const text=`${command} ${flag}`,event=eventFor(text);
      assert.equal(isCommand(event,env,command),true);
      assert.equal(await requireCommand(github(text),event,env,command),2);
      await assert.rejects(requireCommand(github(text,{body:command}),event,env,command),e=>e.code==='ACCESS');
    }
    for(const suffix of ['--reference --no-reference','--reference now','--unknown','\n--reference'])assert.equal(isCommand(eventFor(`${command} ${suffix}`),env,command),false);
  }
  assert.equal(isCommand(eventFor('/ai-investigate --reference'),env,'/ai-investigate'),false);
});
test('no-reference command and configured default are persisted without reading prior PR patches',()=>fixture(async({env})=>{
  for(const [command,action,file] of [['/ai-fix',prepareFix,'.work/fix-bundle.json'],['/ai-report-pr',prepare,'.work/bundle.json']]){
    for(const explicit of [true,false]){
      const text=explicit?`${command} --no-reference`:command;
      await writeFile('event.json',JSON.stringify(eventFor(text)));
      await writeFile('.github/ai-bot/config.json',JSON.stringify({...cfg,referencePreviousPRs:explicit}));
      const gh=github(text);let oldReads=0;
      gh.list=async path=>{if(path.includes('state=all')||path.endsWith('/files'))oldReads++;return[];};
      await action(env,gh);
      const bundle=JSON.parse(await readFile(file));
      assert.equal(bundle.cfg.referencePreviousPRs,false);
      assert.deepEqual(bundle.context.previousProposals,[]);assert.equal(oldReads,0);
    }
  }
}));
test('matrix worker routing uses the selected target rather than the blank parent input',()=>fixture(async({env})=>{
  await writeFile('event.json',JSON.stringify({repository:{full_name:'a/b'},inputs:{target:'all',number:''}}));
  const worker={...env,GITHUB_EVENT_NAME:'workflow_dispatch',AI_BOT_WORKER:'true',AI_BOT_NUMBER:'2',AI_BOT_TARGET:'issue',AI_BOT_RESULT:'comment',AI_BOT_REFERENCE:'off'};
  await prepare(worker,github('/unused'));
  let bundle=JSON.parse(await readFile('.work/bundle.json'));assert.equal(bundle.targets[0].number,2);assert.equal(bundle.cfg.referencePreviousPRs,false);
  await prepareFix(worker,github('/unused'));
  bundle=JSON.parse(await readFile('.work/fix-bundle.json'));assert.equal(bundle.targets[0].number,2);assert.equal(bundle.cfg.referencePreviousPRs,false);
}));
test('ordinary investigation publication rechecks dispatch authority, consent and current source before writing',()=>fixture(async({env})=>{
  const dispatch={...env,GITHUB_EVENT_NAME:'workflow_dispatch'};
  await writeFile('event.json',JSON.stringify({repository:{full_name:'a/b'},inputs:{target:'issue',number:'2'}}));
  await prepare(dispatch,github('/unused'));
  await writeFile('.work/result.json',JSON.stringify({results:[{ok:true,provider:cfg.provider,text:'Safe investigation'}]}));
  const allowed=github('/unused');await publish(dispatch,allowed);
  assert.equal(allowed.calls.filter(call=>call.method!=='GET').length,1);
  for(const [kind,code]of [['role','ACCESS'],['issue','STALE'],['base','STALE'],['private','PRIVATE']]){
    const denied=github('/unused'),request=denied.request;
    denied.request=async(path,method='GET',payload)=>{
      if(method==='GET'){
        if(kind==='role'&&path.includes('/permission'))return{permission:'read'};
        if(kind==='private'&&path==='/repos/a/b')return{private:true,default_branch:'main'};
        if(kind==='issue'&&path.endsWith('/issues/2'))return{number:2,state:'open',title:'Updated',body:'New requirement'};
        if(kind==='base'&&path.includes('/git/ref/'))return{object:{sha:'f'.repeat(40)}};
      }
      return request(path,method,payload);
    };
    await assert.rejects(publish(dispatch,denied),error=>error.code===code,kind);
    assert.ok(!denied.calls.some(call=>call.method!=='GET'),kind);
  }
}));
