import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {repairContext,repairAccess,publishRepair} from '../.github/ai-bot/src/conflicts.js';
import {parsePlan,planHash,repairEditable,validationResult} from '../.github/ai-bot/src/fix-core.js';
import {isCommand} from '../.github/ai-bot/src/commands.js';
import {selectTargets} from '../.github/ai-bot/src/bulk.js';
const cfg=JSON.parse(await readFile(new URL('../.github/ai-bot/config.json',import.meta.url)));
const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40);
const event={repository:{full_name:'a/b'},action:'created',issue:{number:5,pull_request:{}},comment:{id:8,body:'/ai-fix',user:{type:'User',login:'owner'}}};
const env={GITHUB_EVENT_NAME:'issue_comment',GITHUB_REF:'refs/heads/main',GITHUB_ACTOR:'owner',GITHUB_RUN_ID:'99'};
function fixture({files=[{filename:'README.md',status:'modified'}],permission='write',privateRepo=false,mode='100644',move=false,fork=false}={}){
  const writes=[];let refReads=0;
  const pr={number:5,title:'Original',body:'Proposed change',state:'open',draft:false,mergeable:false,head:{sha:b,ref:'feature',repo:{full_name:fork?'fork/b':'a/b'}},base:{sha:a,ref:'main',repo:{full_name:'a/b'}}};
  const gh={repo:'a/b',writes,path:(s='')=>'/repos/a/b'+s,list:async()=>files,request:async(path,method='GET',body)=>{
    const p=path.replace('/repos/a/b','');
    if(method!=='GET'){
      writes.push({p,method,body});
      if(p==='/git/trees')return{sha:c};if(p==='/git/commits')return{sha:c};if(p==='/pulls')return{number:9};return{};
    }
    if(p==='')return{default_branch:'main',private:privateRepo};
    if(p.includes('/permission'))return{permission};
    if(p==='/issues/comments/8')return{...event.comment,issue_url:'https://api.github.com/repos/a/b/issues/5'};
    if(p==='/pulls/5')return pr;
    if(p==='/git/ref/heads/main'){refReads++;return{object:{sha:move&&refReads>1?c:a}};}
    if(p.startsWith('/compare/'))return{merge_base_commit:{sha:c}};
    if(p.startsWith('/git/trees/'))return{tree:files.map(f=>({path:f.filename,type:'blob',mode,sha:c}))};
    if(p.startsWith('/git/blobs/'))return{encoding:'base64',size:9,content:Buffer.from('Original\n').toString('base64')};
    if(p.startsWith('/git/commits/'))return{tree:{sha:c}};
    throw new Error('Unexpected route '+p);
  }};return{gh,pr};
}
async function publication(options={}){
  const {gh,pr}=fixture(options),context=await repairContext(gh,pr,a,cfg);
  const {createHash}=await import('node:crypto');const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
  const repair={number:5,head:b,headRef:'feature',headRepo:pr.head.repo.full_name,base:a,request:hash([pr.title,pr.body])};
  const bundle={cfg,repair,targets:[{kind:'issue',number:5,sha:a}],context};
  const plan={confidence:'high',summary:'Merged both changes',changes:[{path:'README.md',content:'Integrated\n'}]};
  const verdict={ok:true,hash:planHash(plan),sha:a,commands:cfg.fix.commands};
  return{gh,bundle,plan,verdict};
}
test('PR commands are explicitly enabled for fixes, not other commands or ordinary callers',async()=>{
  assert.equal(isCommand(event,env,'/ai-fix'),false);assert.equal(isCommand(event,env,'/ai-fix',true),true);
  assert.equal(isCommand({...event,comment:{...event.comment,body:'/ai-investigate'}},env,'/ai-investigate',true),false);
  assert.deepEqual(await selectTargets(fixture().gh,event,env,cfg,'fix'),[{kind:'pull',number:'5'}]);
  await assert.rejects(repairAccess(fixture({permission:'read'}).gh,event,env));
  await assert.rejects(repairAccess(fixture({privateRepo:true}).gh,event,env));
});
test('repair rejects mixed protected changes, additions and symlinks before publishing',async()=>{
  for(const options of [{files:[{filename:'package-lock.json',status:'modified'}]},{files:[{filename:'README.md',status:'added'}]},{mode:'120000'}]){
    const {gh,pr}=fixture(options);await assert.rejects(repairContext(gh,pr,a,cfg));assert.equal(gh.writes.length,0);
  }
  assert.equal(repairEditable('.github/workflows/test.md'),false);assert.equal(repairEditable('../README.md'),false);
});
test('Markdown repair plans must be scoped to PRs and contain no conflict markers',async()=>{
  const {bundle,plan}=await publication();assert.equal(parsePlan(plan,bundle).changes.length,1);
  assert.throws(()=>parsePlan(plan,{...bundle,repair:undefined}));
  assert.throws(()=>parsePlan({...plan,changes:[{path:'README.md',content:'<<<<<<< HEAD\nWrong\n=======\nOther\n>>>>>>> branch'}]},bundle));
  const commands=[['npm','test']];
  assert.equal(validationResult(JSON.stringify({version:1,ok:true,stage:'complete',checks:[{argv:commands[0],exitCode:0,detail:''}]}),plan,commands).ok,true);
});
test('same-repo repair makes a two-parent commit and never force pushes',async()=>{
  const {gh,bundle,plan,verdict}=await publication();await publishRepair(gh,event,env,bundle,{ok:true,plan},verdict);
  const commit=gh.writes.find(w=>w.p==='/git/commits');assert.deepEqual(commit.body.parents,[b,a]);
  const ref=gh.writes.find(w=>w.p.startsWith('/git/refs/heads/'));assert.equal(ref.body.force,false);assert.equal(ref.p,'/git/refs/heads/feature');
});
test('fork repair creates a separate PR and leaves the source branch untouched',async()=>{
  const {gh,bundle,plan,verdict}=await publication({fork:true});await publishRepair(gh,event,env,bundle,{ok:true,plan},verdict);
  assert.ok(gh.writes.some(w=>w.p==='/pulls'));assert.ok(!gh.writes.some(w=>w.p.startsWith('/git/refs/heads/')));
});
test('failed verification and moved base never update the original branch',async()=>{
  const first=await publication();await publishRepair(first.gh,event,env,first.bundle,{ok:true,plan:first.plan},{ok:false});
  assert.ok(first.gh.writes.every(w=>w.p.endsWith('/comments')));
  const second=await publication({move:true});await assert.rejects(publishRepair(second.gh,event,env,second.bundle,{ok:true,plan:second.plan},second.verdict));
  assert.ok(!second.gh.writes.some(w=>w.p.startsWith('/git/refs/heads/')));
});
