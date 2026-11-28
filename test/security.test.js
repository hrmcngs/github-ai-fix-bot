import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareSecurity,generateSecurity,validateSecurity,publishSecurity,auditAccess,securityDestination} from '../.github/ai-bot/src/security.js';
import {botProposal} from '../.github/ai-bot/src/auto-merge.js';
beforeEach(t=>{t.mock.method(console,'log',()=>{});});
const source=new URL('../.github/ai-bot/config.json',import.meta.url),sha='a'.repeat(40),text='export const value=1;\n';
const blob=createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const proposed={confidence:'high',summary:'入力経路を確認した最小修正案。独立再現は未実施です。',changes:[{path:'src/add.js',content:'export const value=2;\n'}]};
async function fixture(fn){
  const original=process.cwd(),dir=await mkdtemp(join(tmpdir(),'ai-security-'));
  try{
    const cfg=JSON.parse(await readFile(source,'utf8'));cfg.securityAudit={enabled:true};cfg.fix={enabled:true,label:'ai-fix',commands:[['node','--test']],botFiles:[]};
    await mkdir(join(dir,'.github/ai-bot'),{recursive:true});await writeFile(join(dir,'.github/ai-bot/config.json'),JSON.stringify(cfg));
    const env={GITHUB_REPOSITORY:'a/b',GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',GITHUB_SHA:sha,GITHUB_ACTOR:'owner',GITHUB_RUN_ID:'123',GITHUB_EVENT_PATH:join(dir,'event.json'),AI_API_KEY:'fake-api-key'};
    const event={repository:{full_name:'a/b'}};await writeFile(env.GITHUB_EVENT_PATH,JSON.stringify(event));process.chdir(dir);
    const state={role:'write',private:false,head:sha,prs:[],tree:[{path:'src',mode:'040000',type:'tree'},{path:'src/add.js',mode:'100644',type:'blob',sha:blob,size:Buffer.byteLength(text)}],calls:[]};
    const gh={repo:'a/b',path:(p='')=>'/repos/a/b'+p,list:async()=>state.prs,request:async(p,method='GET',body)=>{
      state.calls.push({p,method,body});
      if(method==='POST'){
        if(p.endsWith('/pulls')){const pr={number:8,state:'open',user:{type:'Bot',login:'github-actions[bot]'},body:body.body,head:{ref:body.head,repo:{full_name:'a/b'}},base:{ref:body.base,repo:{full_name:'a/b'}}};state.prs.push(pr);return pr;}
        return{sha};
      }
      if(p==='/repos/a/b')return{default_branch:'main',private:state.private};
      if(p.endsWith('/permission'))return{permission:state.role};
      if(p.includes('/git/ref/'))return{object:{sha:state.head}};
      if(p.includes('/git/trees/'))return{tree:state.tree};
      if(p.includes('/git/blobs/'))return{encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')};
      if(p.includes('/git/commits/'))return{tree:{sha}};
      throw new Error('Unexpected route');
    }};
    const generate=async plan=>generateSecurity(env,{tokyo:async(input,key)=>{assert.equal(key,'fake-api-key');assert.ok(input.includes('セキュリティ監査'));assert.ok(input.includes('既存の防御'));return JSON.stringify(plan);}});
    const validate=async(ok)=>validateSecurity(env,{git:async(_cmd,args)=>{if(args[0]==='archive')await writeFile(args.find(a=>a.startsWith('--output=')).slice(9),'fixture');return{stdout:`100644 blob ${blob} ${Buffer.byteLength(text)}\tsrc/add.js\n`};},run:async args=>args[0]==='run'?JSON.stringify({version:1,ok,stage:ok?'complete':'command',checks:[{argv:['node','--check','src/add.js'],exitCode:0,detail:''},{argv:['node','--test'],exitCode:ok?0:1,detail:''}]}):''});
    await fn({env,event,cfg,gh,state,generate,validate});
  }finally{process.chdir(original);await rm(dir,{recursive:true,force:true});}
}
test('security audits create a code PR only after the existing offline verifier succeeds',()=>fixture(async f=>{
  await prepareSecurity(f.env,f.gh);await f.generate(proposed);await f.validate(true);await publishSecurity(f.env,f.gh);
  const changes=f.state.calls.find(c=>c.method==='POST'&&c.p.endsWith('/git/trees')).body.tree;
  assert.deepEqual(changes,[{path:'src/add.js',mode:'100644',type:'blob',content:proposed.changes[0].content}]);
  assert.match(f.state.prs[0].head.ref,/^ai-security\/bot-/);
  assert.equal(botProposal({...f.state.prs[0],labels:[{name:'ai-auto-merge'}]},'a/b','ai-auto-merge'),null);
  assert.ok(!f.state.calls.some(c=>c.method==='PATCH'||c.p.endsWith('/merge')));
}));
test('failed validation publishes only a report containing actual failed command information',()=>fixture(async f=>{
  await prepareSecurity(f.env,f.gh);await f.generate(proposed);await f.validate(false);await publishSecurity(f.env,f.gh);
  const files=f.state.calls.find(c=>c.method==='POST'&&c.p.endsWith('/git/trees')).body.tree;
  assert.equal(files.length,1);assert.equal(files[0].path,'reports/ai/security-audit.md');
  assert.ok(files[0].content.includes('"exitCode":1'));assert.ok(files[0].content.includes('検証は成功していません'));
}));
test('no-change audits require no test execution and completed contexts are not audited again',()=>fixture(async f=>{
  await prepareSecurity(f.env,f.gh);await f.generate({confidence:'low',summary:'資料不足のため要検証です。',changes:[]});
  await validateSecurity(f.env,{run:async()=>assert.fail('No changes must not execute Docker')});
  await publishSecurity(f.env,f.gh);f.state.prs[0].state='closed';await rm('.work/fix-bundle.json');
  await prepareSecurity(f.env,f.gh);await assert.rejects(readFile('.work/fix-bundle.json'));
}));
test('disabled audits, untrusted triggers, forks of event metadata, private consent and revoked roles cannot publish',()=>fixture(async f=>{
  assert.equal(await auditAccess(f.gh,f.event,f.env,{...f.cfg,securityAudit:{enabled:false}}),null);
  for(const changes of [{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_REF:'refs/heads/feature'},{GITHUB_REPOSITORY:'other/repo'}])await assert.rejects(auditAccess(f.gh,f.event,{...f.env,...changes},f.cfg));
  f.state.private=true;await assert.rejects(auditAccess(f.gh,f.event,f.env,f.cfg));f.state.private=false;
  await prepareSecurity(f.env,f.gh);await f.generate(proposed);await f.validate(true);f.state.role='read';
  await assert.rejects(publishSecurity(f.env,f.gh));assert.equal(f.state.calls.filter(c=>c.method==='POST').length,0);
}));
test('changed source, changed consent and tampered verifier results block code publication',()=>fixture(async f=>{
  await prepareSecurity(f.env,f.gh);await f.generate(proposed);await f.validate(true);
  const verdict=JSON.parse(await readFile('.work/fix-verdict.json','utf8'));await writeFile('.work/fix-verdict.json',JSON.stringify({...verdict,hash:'forged'}));
  await assert.rejects(publishSecurity(f.env,f.gh));
  await writeFile('.work/fix-verdict.json',JSON.stringify(verdict));f.state.head='b'.repeat(40);await assert.rejects(publishSecurity(f.env,f.gh));f.state.head=sha;
  await writeFile('.github/ai-bot/config.json',JSON.stringify({...f.cfg,securityAudit:{enabled:false}}));await assert.rejects(publishSecurity(f.env,f.gh));
  assert.equal(f.state.calls.filter(c=>c.method==='POST').length,0);
}));
test('AI failures do not become successful reports and report paths cannot overwrite human files or traverse links',()=>fixture(async f=>{
  await prepareSecurity(f.env,f.gh);await generateSecurity(f.env,{tokyo:async()=>{throw new Error('sensitive-provider-error');}});await validateSecurity(f.env);
  await assert.rejects(publishSecurity(f.env,f.gh));assert.equal(f.state.calls.filter(c=>c.method==='POST').length,0);
  assert.ok(!(await readFile('.work/fix-plan.json','utf8')).includes('sensitive-provider-error'));
  for(const entry of [{path:'reports',type:'blob',mode:'120000'},{path:'reports/ai/security-audit.md',type:'blob',mode:'100644',sha:blob,size:10}]){
    f.state.tree.push(entry);await assert.rejects(securityDestination(f.gh,sha));f.state.tree.pop();
  }
}));
