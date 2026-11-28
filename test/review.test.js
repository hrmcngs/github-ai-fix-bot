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

async function automatic(env,gh){
  const cfg=JSON.parse(await readFile('.github/ai-bot/config.json','utf8'));cfg.autoReview={enabled:true};
  await writeFile('.github/ai-bot/config.json',JSON.stringify(cfg));
  gh.pr.head.repo.full_name='a/b';gh.pr.base.ref='main';gh.pr.draft=false;
  const ev={repository:{full_name:'a/b'},action:'opened',number:7,pull_request:structuredClone(gh.pr)};
  await writeFile(env.GITHUB_EVENT_PATH,JSON.stringify(ev));
  return{cfg,ev,auto:{...env,GITHUB_EVENT_NAME:'pull_request_target'}};
}
test('automatic reviews apply bundled skill guidance and post only a COMMENT without a slash command',()=>fixture(async env=>{
  const gh=github(),{auto}=await automatic(env,gh);
  await prepareReview(auto,gh);
  await analyzeReview(auto,async(cfg,input)=>{
    assert.ok(input.includes('修正案'));assert.ok(input.includes('既存の防御'));assert.ok(input.includes('確定・要検証・反証'));
    return '## 修正案\n入力を検証する案です。未確認の懸念です。';
  });
  await publishReview(auto,gh);
  assert.equal(gh.writes.length,1);assert.equal(gh.writes[0].body.event,'COMMENT');
  assert.ok(gh.writes[0].body.body.startsWith('<!-- ai-review-auto:'));
  assert.equal(gh.writes[0].body.commit_id,a);
}));
test('automatic review requires explicit opt-in and rejects forks, drafts, stale events and read-only actors',()=>fixture(async env=>{
  const gh=github(),{cfg,ev,auto}=await automatic(env,gh);
  assert.equal(await reviewAccess(gh,ev,auto,{...cfg,autoReview:{enabled:false}}),null);
  for(const change of [
    {...ev,action:'edited'},
    {...ev,pull_request:{...ev.pull_request,draft:true}},
    {...ev,pull_request:{...ev.pull_request,head:{...ev.pull_request.head,repo:{full_name:'fork/b'}}}},
    {...ev,pull_request:{...ev.pull_request,head:{...ev.pull_request.head,sha:b}}},
  ])await assert.rejects(reviewAccess(gh,change,auto,cfg));
  const denied=github({permission:'read'});denied.pr=gh.pr;await assert.rejects(reviewAccess(denied,ev,auto,cfg));
  const disabled={...cfg,autoReview:{enabled:false}};await writeFile('.github/ai-bot/config.json',JSON.stringify(disabled));
  await prepareReview(auto,gh);await assert.rejects(readFile('.work/review-bundle.json'));
}));
test('successful automatic reviews deduplicate across runs before new AI calls and revoked opt-in blocks publication',()=>fixture(async env=>{
  const gh=github(),{cfg,auto}=await automatic(env,gh);
  await prepareReview(auto,gh);await analyzeReview(auto,async()=> 'Review result');await publishReview(auto,gh);
  const prior={user:{type:'Bot',login:'github-actions[bot]'},body:gh.writes[0].body.body};
  const list=gh.list;gh.list=async p=>p.endsWith('/reviews')?[prior]:list(p);
  await rm('.work/review-bundle.json');
  await prepareReview({...auto,GITHUB_RUN_ID:'101'},gh);await assert.rejects(readFile('.work/review-bundle.json'));
  gh.list=list;await prepareReview(auto,gh);
  await writeFile('.github/ai-bot/config.json',JSON.stringify({...cfg,autoReview:{enabled:false}}));
  await assert.rejects(publishReview(auto,gh));assert.equal(gh.writes.length,1);
}));
