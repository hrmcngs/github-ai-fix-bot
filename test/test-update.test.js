import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createTestUpdate,testUpdateContent} from '../scripts/create-test-update.mjs';
import {SOURCE} from '../.github/ai-bot/src/updates.js';
const base='a'.repeat(40),path='.github/ai-bot/src/guidance.js';
const text='// Runtime update delivery smoke marker: 2026-11-27-01.\nexport const guidance="unchanged";\n';
const blob=createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
function fixture({role='write',revoked=false,stale=false,existing=[],symlink=false}={}){
  const calls=[];let roles=0,refs=0;
  const env={GITHUB_REPOSITORY:SOURCE,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_SHA:base,GITHUB_RUN_ID:'123',GITHUB_ACTOR:'owner'};
  const event={repository:{full_name:SOURCE}};
  const gh={repo:SOURCE,path:(p='')=>`/repos/${SOURCE}${p}`,list:async()=>existing,request:async(p,method='GET',body)=>{
    calls.push({p,method,body});
    if(method==='POST')return p.endsWith('/pulls')?{number:42}:{sha:base};
    if(p===`/repos/${SOURCE}`)return{default_branch:'main'};
    if(p.endsWith('/permission'))return{permission:revoked&&++roles>1?'read':role};
    if(p.includes('/git/ref/'))return{object:{sha:stale&&++refs>1?'b'.repeat(40):base}};
    if(p.includes('/git/trees/'))return{tree:[...['.github','.github/ai-bot','.github/ai-bot/src'].map(path=>({path,type:'tree',mode:'040000'})),{path,type:'blob',mode:symlink?'120000':'100644',sha:blob,size:Buffer.byteLength(text)}]};
    if(p.includes('/git/blobs/'))return{encoding:'base64',content:Buffer.from(text).toString('base64')};
    if(p.includes('/git/commits/'))return{tree:{sha:base}};
    throw new Error('Unexpected request');
  }};
  return{gh,calls,event,env};
}
test('test update changes exactly one comment and keeps real guidance unchanged',async()=>{
  const actual=await readFile(new URL('../.github/ai-bot/src/guidance.js',import.meta.url),'utf8');
  const updated=testUpdateContent(actual,'123');
  const oldLines=actual.split('\n'),newLines=updated.split('\n');
  assert.equal(oldLines.length,newLines.length);
  assert.equal(oldLines.filter((line,i)=>line!==newLines[i]).length,1);
  assert.ok(updated.includes('// Runtime update delivery smoke marker: run-123.'));
  for(const invalid of ['export const guidance=1;',text+text])assert.throws(()=>testUpdateContent(invalid,'123'));
  assert.throws(()=>testUpdateContent(text,'1\nmalicious'));
});
test('manual source action proposes only the marker file on a dedicated branch',async()=>{
  const f=fixture(),pr=await createTestUpdate(f.gh,f.event,f.env);assert.equal(pr.number,42);
  const writes=f.calls.filter(c=>c.method==='POST');
  const files=writes.find(c=>c.p.endsWith('/git/trees')).body.tree;
  assert.deepEqual(files,[{path,mode:'100644',type:'blob',content:testUpdateContent(text,'123')}]);
  const ref=writes.find(c=>c.p.endsWith('/git/refs')).body.ref;assert.match(ref,/^refs\/heads\/ai-update\/bot-/);
  assert.ok(!f.calls.some(c=>c.method==='PATCH'||c.p.endsWith('/merge')));
});
test('untrusted events, repositories, refs and revoked rights cannot publish test updates',async()=>{
  for(const changes of [{GITHUB_EVENT_NAME:'issue_comment'},{GITHUB_REPOSITORY:'other/repo'},{GITHUB_REF:'refs/heads/feature'},{GITHUB_SHA:'b'.repeat(40)}]){
    const f=fixture();await assert.rejects(createTestUpdate(f.gh,f.event,{...f.env,...changes}));assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  }
  for(const options of [{role:'read'},{revoked:true},{stale:true},{symlink:true}]){
    const f=fixture(options);await assert.rejects(createTestUpdate(f.gh,f.event,f.env));assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  }
});
test('repeated runs reuse the existing trusted test update PR',async()=>{
  const pr={number:42,user:{login:'github-actions[bot]',type:'Bot'},body:'<!-- ai-bot-test-update:v1 -->\n',head:{ref:'ai-update/bot-0123456789ab-123',repo:{full_name:SOURCE}},base:{ref:'main',repo:{full_name:SOURCE}}};
  const f=fixture({existing:[pr]});assert.equal((await createTestUpdate(f.gh,f.event,f.env)).number,42);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
