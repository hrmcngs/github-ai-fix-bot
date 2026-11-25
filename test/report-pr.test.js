import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepare,analyze,publish} from '../.github/ai-bot/src/main.js';
import {reportFile,reportDestination} from '../.github/ai-bot/src/report-pr.js';
import {createLinkedProposal} from '../.github/ai-bot/src/proposals.js';
import {revisionMarker} from '../.github/ai-bot/src/proposal-state.js';
const cfg=JSON.parse(await readFile(new URL('../.github/ai-bot/config.json',import.meta.url)));
const sha='a'.repeat(40),blob='b'.repeat(40);
const event={repository:{full_name:'a/b'},action:'created',issue:{number:2},comment:{id:123,body:'/ai-report-pr',user:{type:'User',login:'owner'}}};
const bot={type:'Bot',login:'github-actions[bot]'};
function github({prs=[],permission='write',head=sha,failNotify=false}={}){
  const calls=[];
  return {repo:'a/b',calls,path:(tail='')=>`/repos/a/b${tail}`,list:async path=>path.includes('/pulls?')?prs:[],request:async(path,method='GET',body)=>{
    calls.push({path,method,body});
    if(method!=='GET'){
      if(path.endsWith('/issues/2/comments')&&failNotify)throw new Error('mock failure');
      if(path.endsWith('/pulls'))return{number:9};
      return{sha:'c'.repeat(40)};
    }
    if(path==='/repos/a/b')return{default_branch:'main',private:false};
    if(path.includes('/permission'))return{permission};
    if(path.endsWith('/issues/comments/123'))return{body:'/ai-report-pr',user:{type:'User',login:'owner'},issue_url:'https://api.github.com/repos/a/b/issues/2'};
    if(path.endsWith('/issues/2'))return{number:2,state:'open',title:'調査して',body:'package.jsonの検証内容を文章で整理して'};
    if(path.includes('/git/ref/heads/'))return{object:{sha:head}};
    if(path.includes('/git/trees/'))return{tree:[]};
    if(path.includes('/git/commits/'))return{tree:{sha:blob}};
    throw new Error(`Unexpected mocked route: ${path}`);
  }};
}
async function fixture(fn){
  const original=process.cwd(),dir=await mkdtemp(join(tmpdir(),'ai-report-pr-'));
  await mkdir(join(dir,'.github/ai-bot'),{recursive:true});await mkdir(join(dir,'.work'));
  await writeFile(join(dir,'.github/ai-bot/config.json'),JSON.stringify(cfg));
  await writeFile(join(dir,'event.json'),JSON.stringify(event));
  const env={GITHUB_REPOSITORY:'a/b',GITHUB_REF:'refs/heads/main',GITHUB_ACTOR:'owner',GITHUB_EVENT_NAME:'issue_comment',GITHUB_EVENT_PATH:join(dir,'event.json'),GITHUB_RUN_ID:'123'};
  process.chdir(dir);try{await fn({env,dir});}finally{process.chdir(original);await rm(dir,{recursive:true,force:true});}
}
async function prepared(env,gh=github()){
  await prepare(env,gh);
  await writeFile('.work/result.json',JSON.stringify({results:[{ok:true,provider:cfg.provider,text:'## 調査結果\n\n- 構文を確認します。'}]}));
}
test('report command prepares in manual mode and publishes exactly one Markdown PR plus an Issue link',()=>fixture(async({env})=>{
  await prepared(env);const b=JSON.parse(await readFile('.work/bundle.json'));assert.equal(b.reportPR,true);
  const gh=github();await publish(env,gh);
  const writes=gh.calls.filter(c=>c.method!=='GET');
  const tree=writes.find(c=>c.path.endsWith('/git/trees'));
  assert.equal(tree.body.tree.length,1);assert.equal(tree.body.tree[0].path,'reports/ai/issue-2.md');
  assert.ok(tree.body.tree[0].content.includes('## 調査結果'));
  const pr=writes.find(c=>c.path.endsWith('/pulls'));assert.match(pr.body.head,/^ai-report\/issue-2-/);assert.match(pr.body.body,/Refs #2/);assert.ok(!pr.body.body.includes('Closes #2'));
  const reply=writes.find(c=>c.path.endsWith('/issues/2/comments'));
  assert.ok(reply.body.body.includes('[PR #9](https://github.com/a/b/pull/9)'));
  assert.ok(!writes.some(c=>c.path.endsWith('/merge')));
}));
test('existing report PR skips AI and repairs the missing reply without creating another PR',()=>fixture(async({env})=>{
  const existing={number:9,user:bot,body:`<!-- ai-report:issue:2 -->\n${revisionMarker({title:'調査して',body:'package.jsonの検証内容を文章で整理して'})}`,head:{ref:'ai-report/issue-2-0123456789ab-123',repo:{full_name:'a/b'}},base:{repo:{full_name:'a/b'}}};
  const gh=github({prs:[existing]});await prepare(env,gh);
  await analyze(env);const result=JSON.parse(await readFile('.work/result.json'));assert.equal(result.results[0].ok,true);
  await publish(env,gh);
  assert.deepEqual(gh.calls.filter(c=>c.method!=='GET').map(c=>c.path),['/repos/a/b/issues/2/comments']);
  assert.ok(gh.calls.at(-1).body.body.includes('https://github.com/a/b/pull/9'));
}));
test('failed analysis, changed source and revoked role cannot create a report PR',()=>fixture(async({env})=>{
  await prepared(env);await writeFile('.work/result.json',JSON.stringify({results:[{ok:false,provider:cfg.provider,text:'認証に失敗しました'}]}));
  let gh=github();await assert.rejects(publish(env,gh));assert.ok(!gh.calls.some(c=>c.method==='POST'&&c.path.endsWith('/pulls')));
  await prepared(env);gh=github({head:'f'.repeat(40)});await assert.rejects(publish(env,gh),e=>e.code==='STALE');
  assert.ok(!gh.calls.some(c=>c.method==='POST'&&c.path.endsWith('/git/trees')));
  gh=github({permission:'read'});await assert.rejects(publish(env,gh),e=>e.code==='ACCESS');assert.equal(gh.calls.filter(c=>c.method!=='GET').length,0);
}));
test('report mode cannot be forged by an unrelated command or target',()=>fixture(async({env})=>{
  await prepared(env);await writeFile('event.json',JSON.stringify({...event,comment:{...event.comment,body:'/ai-fix'}}));
  const gh=github();await assert.rejects(publish(env,gh),e=>e.code==='ACCESS');assert.equal(gh.calls.filter(c=>c.method!=='GET').length,0);
}));
test('report files have a fixed destination and keep prose rendered safely',()=>{
  const bundle={repo:'a/b',cfg,targets:[{number:2,sha}]};
  const file=reportFile(bundle,'## 要約\n\n@owner <img src="https://evil">\n\n```js\nconst x=1;');
  assert.equal(file.path,'reports/ai/issue-2.md');assert.ok(file.content.includes('## 要約'));assert.ok(!file.content.includes('@owner'));assert.ok(!file.content.includes('<img'));assert.ok(file.content.endsWith('```\n'));
});
test('report publication cannot traverse symlinks or overwrite unrelated files',async()=>{
  for(const entry of [{path:'reports',mode:'120000',type:'blob',sha:blob},{path:'reports/ai',mode:'100644',type:'blob',sha:blob},{path:'reports/ai/issue-2.md',mode:'100644',type:'blob',sha:blob}]){
    const gh={path:x=>x,request:async path=>path.includes('/trees/')?{tree:[entry]}:{encoding:'base64',content:Buffer.from('human report').toString('base64')}};
    await assert.rejects(reportDestination(gh,sha,2));
  }
});
test('notification failure keeps the created PR available for retry instead of deleting its branch',async()=>{
  const gh=github({failNotify:true});
  await assert.rejects(createLinkedProposal(gh,{kind:'report',issue:2,runId:123,sha,id:'d'.repeat(64),base:'main',title:'report',body:'report',files:[{path:'reports/ai/issue-2.md',content:'# report'}],notify:async()=>{throw new Error('mock notification failure');}}),e=>e.code==='NOTIFY'&&e.proposalNumber===9);
  assert.ok(gh.calls.some(c=>c.method==='POST'&&c.path.endsWith('/pulls')));assert.ok(!gh.calls.some(c=>c.method==='DELETE'));
});
test('report created for an updated Issue references the previous report without reusing it',()=>fixture(async({env})=>{
  const old={number:8,user:bot,body:`<!-- ai-report:issue:2 -->\n${revisionMarker({title:'Old',body:'Old'})}`,head:{ref:'ai-report/issue-2-0123456789ab-123',repo:{full_name:'a/b'}},base:{repo:{full_name:'a/b'}}};
  const gh=github({prs:[old]}),list=gh.list;
  gh.list=async path=>path.endsWith('/pulls/8/files')?[{filename:'reports/ai/issue-2.md',patch:'-old\n+report'}]:list(path);
  await prepared(env,gh);
  const bundle=JSON.parse(await readFile('.work/bundle.json'));
  assert.equal(bundle.existingReportPR,undefined);assert.equal(bundle.context.previousProposals[0].number,8);
  await publish(env,gh);
  const pr=gh.calls.find(c=>c.method==='POST'&&c.path.endsWith('/pulls'));
  assert.match(pr.body.body,/ai-issue-revision:[a-f0-9]{64}/);
  assert.ok(pr.body.body.includes('https://github.com/a/b/pull/8'));
}));
