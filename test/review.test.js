import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reviewAccess,reviewDiff,reviewSnapshot,prepareReview,analyzeReview,publishReview} from '../.github/ai-bot/src/review.js';
import {isCommand} from '../.github/ai-bot/src/commands.js';
const source=new URL('../.github/ai-bot/config.json',import.meta.url);
const a='a'.repeat(40),b='b'.repeat(40);
const event={repository:{full_name:'a/b'},action:'created',issue:{number:7,pull_request:{}},comment:{id:15,body:'/ai-review --ai tokyo',user:{type:'User',login:'owner'}}};
const baseEnv={GITHUB_EVENT_NAME:'issue_comment',GITHUB_REF:'refs/heads/main',GITHUB_ACTOR:'owner',GITHUB_REPOSITORY:'a/b',GITHUB_RUN_ID:'100'};
function github({permission='write',privateRepo=false,head=a,command=event.comment.body,existing=false}={}){
  const writes=[];
  const pr={number:7,state:'open',title:'Change',body:'Untrusted instructions',head:{sha:head,repo:{full_name:'fork/b'}},base:{sha:b,repo:{full_name:'a/b'}}};
  const gh={repo:'a/b',writes,pr,path:(p='')=>'/repos/a/b'+p,list:async p=>p.endsWith('/reviews')?(existing?[{user:{type:'Bot',login:'github-actions[bot]'},body:`<!-- ai-review:15:${a} -->\nAlready posted`}]:[]):[{filename:'src/app.js',status:'modified',patch:'@@ -1 +1 @@\n-bug\n+fix'},{filename:'.env',status:'modified',patch:'hidden-key'}],request:async(p,method='GET',body)=>{
    if(method!=='GET'){writes.push({p,method,body});return{};}
    if(p==='/repos/a/b')return{default_branch:'main',private:privateRepo};
    if(p.includes('/permission'))return{permission};
    if(p.endsWith('/issues/comments/15'))return{...event.comment,body:command,issue_url:'https://api.github.com/repos/a/b/issues/7'};
    if(p.endsWith('/pulls/7'))return pr;
    throw new Error('Unexpected request');
  }};return gh;
}
async function fixture(fn){
  const original=process.cwd(),dir=await mkdtemp(join(tmpdir(),'ai-review-'));
  try{
    await mkdir(join(dir,'.github/ai-bot'),{recursive:true});await writeFile(join(dir,'.github/ai-bot/config.json'),await readFile(source));
    const path=join(dir,'event.json');await writeFile(path,JSON.stringify(event));process.chdir(dir);
    await fn({...baseEnv,GITHUB_EVENT_PATH:path});
  }finally{process.chdir(original);await rm(dir,{recursive:true,force:true});}
}
test('PR review command requires opt-in PR routing, write role, current command and private permission',async()=>{
  assert.equal(isCommand(event,baseEnv,'/ai-review',true),true);assert.equal(isCommand(event,baseEnv,'/ai-review'),false);
  await reviewAccess(github(),event,baseEnv);
  for(const options of [{permission:'read'},{privateRepo:true},{command:'/ai-review --ai codex'}])await assert.rejects(reviewAccess(github(options),event,baseEnv));
  await assert.rejects(reviewAccess(github(),event,{...baseEnv,GITHUB_REF:'refs/heads/foreign'}));
});
test('review diffs omit secret paths and report truncation instead of pretending full coverage',async()=>{
  const diff=await reviewDiff(github(),7);assert.equal(diff.files.length,1);assert.equal(diff.omitted,1);assert.ok(!JSON.stringify(diff).includes('hidden-key'));
  const gh=github();gh.list=async()=>Array.from({length:35},(_,i)=>({filename:`src/file${i}.js`,status:'modified',patch:'a'.repeat(15000)}));
  const limited=await reviewDiff(gh,7);assert.ok(limited.files.length<=30);assert.ok(limited.omitted>0);assert.ok(limited.truncated>0);
});
test('review pipeline posts only a COMMENT tied to the reviewed SHA and never executes PR code',()=>fixture(async env=>{
  const gh=github();await prepareReview(env,gh);
  await analyzeReview(env,async(cfg,input)=>{assert.ok(input.includes('src/app.js'));assert.ok(!input.includes('hidden-key'));return '## 指摘\n差分の処理を確認してください。';});
  await publishReview(env,gh);
  assert.equal(gh.writes.length,1);assert.ok(gh.writes[0].p.endsWith('/pulls/7/reviews'));
  assert.equal(gh.writes[0].body.event,'COMMENT');assert.equal(gh.writes[0].body.commit_id,a);
  assert.ok(gh.writes[0].body.body.includes('東京都'));
}));
test('moved head, edited commands and removed permissions block publication',()=>fixture(async env=>{
  await prepareReview(env,github());await analyzeReview(env,async()=> 'Review result');
  for(const options of [{head:b},{permission:'read'},{command:'/ai-review --ai codex'}]){
    const gh=github(options);await assert.rejects(publishReview(env,gh));assert.equal(gh.writes.length,0);
  }
  assert.notEqual(reviewSnapshot(github().pr),reviewSnapshot(github({head:b}).pr));
}));
test('a retry reuses the successful review, while AI failures only post a safe failure comment',()=>fixture(async env=>{
  await prepareReview(env,github());await analyzeReview(env,async()=> 'Review result');
  const duplicate=github({existing:true});await publishReview(env,duplicate);assert.equal(duplicate.writes.length,0);
  await analyzeReview(env,async()=>{throw new Error('sensitive-provider-error');});
  const failed=github();await assert.rejects(publishReview(env,failed));assert.equal(failed.writes.length,1);
  assert.ok(failed.writes[0].p.endsWith('/issues/7/comments'));assert.ok(!failed.writes[0].body.body.includes('sensitive-provider-error'));
}));
