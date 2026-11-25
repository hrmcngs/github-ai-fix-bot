import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {issueRevision,revisionMarker,sameRevision,currentProposal,previousProposals,previousLinks,closeOutdated,updateProposals} from '../.github/ai-bot/src/proposal-state.js';
import {issueTarget} from '../.github/ai-bot/src/main.js';
import {fixPrompt} from '../.github/ai-bot/src/fix-core.js';
const cfg=JSON.parse(await readFile(new URL('../.github/ai-bot/config.json',import.meta.url)));
const issue={number:2,state:'open',title:'Current request',body:'Fix addition'};
function proposal(n=9,kind='fix',version={...issue,body:'Old request'}){
  return{number:n,state:'open',user:{login:'github-actions[bot]',type:'Bot'},body:`<!-- ai-${kind}:issue:2 -->\n${revisionMarker(version)}\nCloses #2`,head:{ref:`ai-${kind}/issue-2-0123456789ab-123`,repo:{full_name:'a/b'}},base:{repo:{full_name:'a/b'}}};
}
function github(prs,{current=issue,permission='write',fresh,files=[]}={}){
  const calls=[];
  return{repo:'a/b',calls,path:(p='')=>`/repos/a/b${p}`,list:async p=>p.includes('/files')?files:prs,request:async(p,method='GET',body)=>{
    calls.push({p,method,body});
    if(method!=='GET')return{};
    if(p==='/repos/a/b')return{default_branch:'main'};
    if(p.includes('/permission'))return{permission};
    if(p.endsWith('/issues/2'))return current;
    if(p.includes('/pulls/'))return fresh||prs.find(pr=>p.endsWith(`/pulls/${pr.number}`));
    throw new Error('Unexpected test route');
  }};
}
test('revision includes complete title and body and survives bounded/redacted context',()=>{
  const long={...issue,body:'x'.repeat(20000)+'a'};
  assert.notEqual(issueRevision(long),issueRevision({...long,body:long.body+'b'}));
  assert.equal(issueRevision(issueTarget(long)),issueRevision(long));
  assert.notEqual(issueRevision(issue),issueRevision({...issue,title:'New title'}));
  assert.equal(sameRevision(proposal(9,'fix',issue),issue),true);
  assert.equal(sameRevision(proposal(),issue),false);
});
test('only a current same-repository bot proposal suppresses a new run',async()=>{
  const old=proposal(),current=proposal(10,'fix',issue);
  assert.equal((await currentProposal(github([old,current]),'fix',issue)).number,10);
  assert.equal(await currentProposal(github([old]),'fix',issue),undefined);
  const human={...current,user:{type:'User',login:'human'}};
  assert.equal(await currentProposal(github([human]),'fix',issue),undefined);
});
test('Issue edits close only outdated bot proposals and never delete branches or comments',async()=>{
  const old=proposal(),report=proposal(10,'report'),current=proposal(11,'fix',issue);
  const human={...proposal(12),user:{type:'User',login:'human'}};
  const fork=proposal(13);fork.head.repo.full_name='evil/fork';
  const unrelated=proposal(14);unrelated.body=unrelated.body.replace('issue:2','issue:3');
  const legacy=proposal(15);legacy.body='<!-- ai-fix:issue:2 -->\nCloses #2';
  const gh=github([old,report,current,human,fork,unrelated,legacy]);
  assert.deepEqual(await closeOutdated(gh,issue),[9,10,15]);
  assert.deepEqual(gh.calls.filter(c=>c.method==='PATCH').map(c=>c.p),['/repos/a/b/pulls/9','/repos/a/b/pulls/10','/repos/a/b/pulls/15']);
  assert.ok(!gh.calls.some(c=>c.method==='DELETE'||c.p.includes('/git/refs')));
  assert.ok(gh.calls.filter(c=>c.method==='POST').every(c=>c.body.body.includes('履歴')));
});
test('delayed events re-read current Issue and PR rather than closing a current or already closed PR',async()=>{
  const pr=proposal();
  assert.deepEqual(await closeOutdated(github([pr],{fresh:proposal(9,'fix',issue)}),issue),[]);
  assert.deepEqual(await closeOutdated(github([pr],{fresh:{...pr,state:'closed'}}),issue),[]);
});
test('previous proposals provide bounded scrubbed allowed patches with links and current-Issue priority',async()=>{
  const gh=github([proposal(),proposal(10),proposal(11)],{files:[{filename:'.github/workflows/fix.yml',patch:'FORBIDDEN'},{filename:'src/add.js',patch:'api_key="abcdefghijklmnop"\n'+'x'.repeat(10000)}]});
  const previous=await previousProposals(gh,'fix',issue,cfg);
  assert.equal(previous.length,2);
  assert.equal(previous[0].patches.length,1);
  assert.equal(previous[0].patches[0].patch.length,6000);
  assert.ok(!JSON.stringify(previous).includes('abcdefghijklmnop'));
  assert.ok(!JSON.stringify(previous).includes('FORBIDDEN'));
  assert.match(previousLinks(gh,previous),/https:\/\/github.com\/a\/b\/pull\/9/);
  const prompt=fixPrompt({repo:'a/b',cfg,targets:[issue],context:{files:[],previousProposals:previous}});
  assert.ok(prompt.includes('現在のIssueを優先'));
  assert.ok(prompt.includes('previousProposals'));
});
test('edit workflow requires title/body changes, trusted actor and default branch',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ai-issue-edit-'));
  const file=join(dir,'event.json');
  const event={repository:{full_name:'a/b'},action:'edited',changes:{body:{from:'old'}},issue};
  const env={GITHUB_EVENT_PATH:file,GITHUB_EVENT_NAME:'issues',GITHUB_REF:'refs/heads/main',GITHUB_ACTOR:'owner'};
  try{
    await writeFile(file,JSON.stringify(event));
    let gh=github([proposal()]);await updateProposals(env,gh);assert.equal(gh.calls.filter(c=>c.method==='PATCH').length,1);
    gh=github([proposal()],{permission:'read'});await assert.rejects(updateProposals(env,gh),e=>e.code==='ACCESS');
    assert.equal(gh.calls.filter(c=>c.method!=='GET').length,0);
    await assert.rejects(updateProposals({...env,GITHUB_REF:'refs/heads/untrusted'},github([])));
    await writeFile(file,JSON.stringify({...event,changes:{labels:{}}}));
    gh=github([proposal()]);await updateProposals(env,gh);assert.equal(gh.calls.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
