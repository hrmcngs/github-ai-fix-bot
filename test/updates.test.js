import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {SOURCE,STATE,MANIFEST,UPDATE_MARKER,manifest,installation,Upstream,release,checkUpdate,authorizeUpdate,updateFiles,applyUpdate} from '../.github/ai-bot/src/updates.js';
const old='a'.repeat(40),latest='b'.repeat(40),base='c'.repeat(40);
const file='.github/ai-bot/src/main.js';
const gitHash=content=>createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
function sourceFixture(){
  const contents={[MANIFEST]:JSON.stringify({version:1,files:[MANIFEST,file,'.github/workflows/fix.yml','.github/ai-bot/config.json']}),[file]:'export const version=2;\n','.github/workflows/fix.yml':'name: Updated\n','.github/ai-bot/config.json':'{"keep":"settings"}'};
  const blobs=new Map(),tree=[];
  for(const [path,content]of Object.entries(contents)){const hash=gitHash(content);tree.push({path,type:'blob',mode:'100644',sha:hash,size:Buffer.byteLength(content)});blobs.set(hash,content);}
  const calls=[];return{calls,tree,contents,request:async p=>{calls.push(p);if(p==='/commits/main')return{sha:latest};if(p.startsWith('/git/trees/'))return{tree};if(p.startsWith('/git/blobs/'))return{encoding:'base64',content:Buffer.from(blobs.get(p.split('/').at(-1))).toString('base64')};throw new Error('Unexpected source route');}};
}
function fixture({issues=[],role='write',closed=false,changedNotice=false,modified=false}={}){
  const source=sourceFixture();
  const state={version:1,source:SOURCE,commit:old,files:{[MANIFEST]:gitHash(source.contents[MANIFEST]),[file]:gitHash('export const version=1;\n'),'.github/workflows/fix.yml':gitHash('name: Old\n')}};
  const notice={number:9,state:'open',user:{type:'Bot',login:'github-actions[bot]'},body:`${UPDATE_MARKER}\n<!-- ai-bot-update-target:${latest} -->\nUpdate?`};
  const event={repository:{full_name:'a/b'},action:'created',issue:notice,comment:{id:123,body:'/ai-update',user:{type:'User',login:'owner'}}};
  const env={GITHUB_REPOSITORY:'a/b',GITHUB_EVENT_NAME:'issue_comment',GITHUB_REF:'refs/heads/main',GITHUB_ACTOR:'owner',GITHUB_RUN_ID:'123'};
  const tree=Object.entries(state.files).map(([path,hash])=>({path,type:'blob',mode:'100644',sha:modified&&path===file?base:hash}));
  tree.push({path:STATE,type:'blob',mode:'100644',sha:gitHash(JSON.stringify(state))});
  const calls=[];const gh={repo:'a/b',calls,path:(p='')=>`/repos/a/b${p}`,list:async p=>p.includes('/pulls?')?[]:issues,request:async(p,method='GET',body)=>{
    calls.push({p,method,body});
    if(method!=='GET'){if(p.endsWith('/pulls'))return{number:15};return{sha:base};}
    if(p==='/repos/a/b')return{default_branch:'main'};
    if(p.includes('/permission'))return{permission:role};
    if(p.endsWith('/issues/comments/123'))return{body:'/ai-update',user:event.comment.user,issue_url:'https://api.github.com/repos/a/b/issues/9'};
    if(p.endsWith('/issues/9'))return{...notice,state:closed?'closed':'open',body:changedNotice?notice.body.replace(latest,old):notice.body};
    if(p.includes('/git/ref/heads/'))return{object:{sha:base}};
    if(p.includes('/git/trees/'))return{tree};
    if(p.includes('/git/commits/'))return{tree:{sha:base}};
    throw new Error('Unexpected destination route');
  }};
  return{gh,source,state,notice,event,env,tree};
}
test('distribution manifest agrees with installer and rejects arbitrary paths',async()=>{
  const data=JSON.parse(await readFile(new URL('../.github/ai-bot/distribution.json',import.meta.url)));
  const installer=await readFile(new URL('../install.sh',import.meta.url),'utf8');
  for(const path of manifest(data))assert.ok(installer.includes('    '+path+'\n'));
  for(const bad of ['src/app.js','.github/ai-bot/../config.json','.github/workflows/../../app.js',STATE])assert.throws(()=>manifest({version:1,files:[MANIFEST,bad]}));
  assert.throws(()=>installation({version:1,source:'evil/repo',commit:old,files:{}}));
});
test('update checks ask in an Issue once per version and respect dismissal',async()=>{
  let f=fixture();await checkUpdate(f.gh,f.state,f.source);
  const create=f.gh.calls.find(c=>c.method==='POST');assert.equal(create.p,'/repos/a/b/issues');assert.ok(create.body.body.includes('/ai-update'));assert.ok(create.body.title.includes('アップデートしますか'));
  f=fixture({issues:[{...f.notice,state:'closed'}]});await checkUpdate(f.gh,f.state,f.source);assert.equal(f.gh.calls.length,0);
  f=fixture();const same=await release(f.source);await checkUpdate(f.gh,{...f.state,files:same.files},f.source);assert.equal(f.gh.calls.length,0);
});
test('a newer version updates an existing open notification instead of creating duplicate Issues',async()=>{
  const f=fixture();f.gh.list=async()=>[{...f.notice,body:f.notice.body.replace(latest,old)}];
  await checkUpdate(f.gh,f.state,f.source);
  assert.equal(f.gh.calls[0].method,'PATCH');assert.equal(f.gh.calls[0].p,'/repos/a/b/issues/9');
});
test('only authorized exact commands on the unchanged bot notice can create updates',async()=>{
  const f=fixture();assert.equal((await authorizeUpdate(f.gh,f.event,f.env)).commit,latest);
  for(const options of [{role:'read'},{closed:true},{changedNotice:true}]){
    const bad=fixture(options);await assert.rejects(authorizeUpdate(bad.gh,bad.event,bad.env));assert.ok(!bad.gh.calls.some(c=>c.method!=='GET'));
  }
  await assert.rejects(authorizeUpdate(f.gh,{...f.event,issue:{...f.notice,user:{type:'User',login:'owner'}}},f.env));
});
test('update files preserve config and reject locally changed files and symlink ancestors',async()=>{
  let f=fixture();const releaseData=await release(f.source);
  const files=await updateFiles(f.gh,f.state,releaseData,f.source,base);
  assert.ok(files.some(c=>c.path===file));assert.ok(files.some(c=>c.path===STATE));assert.ok(!files.some(c=>c.path.endsWith('/config.json')));
  f=fixture({modified:true});await assert.rejects(updateFiles(f.gh,f.state,releaseData,f.source,base),e=>e.code==='UPDATE_CONFLICT');
  f=fixture();f.tree.push({path:'.github/ai-bot',type:'blob',mode:'120000',sha:old});await assert.rejects(updateFiles(f.gh,f.state,releaseData,f.source,base));
});
test('approved update creates a dedicated PR and replies without changing main or executing upstream',async()=>{
  const f=fixture();await applyUpdate(f.gh,f.gh,f.event,f.env,f.state,f.source);
  const writes=f.gh.calls.filter(c=>c.method!=='GET');
  const pr=writes.find(c=>c.p.endsWith('/pulls'));assert.match(pr.body.head,/^ai-update\/issue-9-/);assert.equal(pr.body.base,'main');
  assert.ok(writes.some(c=>c.p.endsWith('/issues/9/comments')&&c.body.body.includes('/pull/15')));
  assert.ok(!writes.some(c=>c.p.endsWith('/merge')||c.p.includes('/dispatches')||c.method==='PATCH'));
  assert.ok(f.source.calls.every(p=>!p.includes('contents')));
});
test('missing update token reports safely and performs no branch or PR writes',async()=>{
  const f=fixture();await assert.rejects(applyUpdate(f.gh,null,f.event,f.env,f.state,f.source),e=>e.code==='UPDATE_TOKEN');
  assert.ok(f.gh.calls.some(c=>c.body?.body?.includes('AI_BOT_UPDATE_TOKEN')));assert.ok(!f.gh.calls.some(c=>c.p.includes('/git/')));
});
test('upstream downloads use a fixed host with no destination credentials and validate blob hashes',async()=>{
  const requests=[];const upstream=new Upstream(async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify({sha:latest}));});
  await upstream.request('/commits/main');assert.ok(requests[0].url.startsWith(`https://api.github.com/repos/${SOURCE}/`));assert.equal(requests[0].options.headers.Authorization,undefined);
  await assert.rejects(upstream.request('/../../evil'));
  const f=fixture(),original=f.source.request;
  f.source.request=async path=>path.startsWith('/git/blobs/')?{encoding:'base64',content:Buffer.from('tampered').toString('base64')}:original(path);
  await assert.rejects(release(f.source),e=>e.code==='UPDATE_SOURCE');
});
test('removed upstream files produce deletions only on the dedicated update branch',async()=>{
  const f=fixture(),obsolete='.github/ai-bot/src/obsolete.js';
  f.state.files[obsolete]=old;f.tree.push({path:obsolete,type:'blob',mode:'100644',sha:old});
  await applyUpdate(f.gh,f.gh,f.event,f.env,f.state,f.source);
  const tree=f.gh.calls.find(c=>c.method==='POST'&&c.p.endsWith('/git/trees'));
  assert.equal(tree.body.tree.find(entry=>entry.path===obsolete).sha,null);
  assert.ok(!f.gh.calls.some(c=>c.method==='PATCH'&&c.p.includes('/git/refs')));
});
