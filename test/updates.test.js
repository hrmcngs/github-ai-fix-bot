import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SOURCE,STATE,MANIFEST,UPDATE_MARKER,manifest,installation,Upstream,release,scopedRelease,updateContext,updateError,checkUpdate,authorizeUpdate,updateFiles,applyUpdate,loadInstallation,authorizeAutomaticUpdate,updateStatus} from '../.github/ai-bot/src/updates.js';
// Capture application logs: raw non-ASCII stdout can corrupt Node 22 test-runner frames.
beforeEach(t=>{t.mock.method(console,'log',()=>{});});
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
    if(method!=='GET'){if(p.endsWith('/pulls'))return{number:15};if(p.endsWith('/issues'))return{number:9};return{sha:base};}
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
test('update checks return the immutable changed version without reading or creating Issues',async()=>{
  const f=fixture();assert.deepEqual(await checkUpdate(f.gh,f.state,f.source),{commit:latest});
  assert.equal(f.gh.calls.length,0);
  const same=await release(f.source);assert.equal(await checkUpdate(f.gh,{...f.state,files:same.files},f.source),undefined);
  assert.equal(f.gh.calls.length,0);
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
test('anonymous REST exhaustion falls back to fixed-source Git data and keeps commit binding',async()=>{
  const f=sourceFixture(),blobs=new Map();
  for(const content of Object.values(f.contents))blobs.set(gitHash(content),{encoding:'base64',content:Buffer.from(content).toString('base64')});
  for(const status of [403,429]){
    const refs=[],requests=[];
    const source=new Upstream(async(url,options)=>{requests.push({url,options});return new Response('{}',{status,headers:{'x-ratelimit-remaining':'0'}});},async ref=>{refs.push(ref);return{commit:latest,tree:f.tree,blobs};});
    assert.equal((await release(source,latest)).commit,latest);
    assert.deepEqual(refs,[latest]);assert.equal(requests.length,1);
    assert.equal(requests[0].options.headers.Authorization,undefined);
    await assert.rejects(source.request('/../../evil'));
    await assert.rejects(source.request(`/git/trees/${old}?recursive=1`));
  }
});
test('ordinary source denial never invokes Git fallback',async()=>{
  let fallback=0;
  const source=new Upstream(async()=>new Response('{}',{status:403}),async()=>{fallback++;throw new Error();});
  await assert.rejects(source.request('/commits/main'),e=>e.code==='UPDATE_SOURCE');assert.equal(fallback,0);
});
test('removed upstream files produce deletions only on the dedicated update branch',async()=>{
  const f=fixture(),obsolete='.github/ai-bot/src/obsolete.js';
  f.state.files[obsolete]=old;f.tree.push({path:obsolete,type:'blob',mode:'100644',sha:old});
  await applyUpdate(f.gh,f.gh,f.event,f.env,f.state,f.source);
  const tree=f.gh.calls.find(c=>c.method==='POST'&&c.p.endsWith('/git/trees'));
  assert.equal(tree.body.tree.find(entry=>entry.path===obsolete).sha,null);
  assert.ok(!f.gh.calls.some(c=>c.method==='PATCH'&&c.p.includes('/git/refs')));
});
test('identical unowned workflows are not silently adopted into the update baseline',async()=>{
  const f=fixture(),releaseData=await release(f.source),path='.github/workflows/fix.yml';
  delete f.state.files[path];f.tree.find(entry=>entry.path===path).sha=releaseData.files[path];
  await assert.rejects(updateFiles(f.gh,f.state,releaseData,f.source,base),e=>e.code==='UPDATE_CONFLICT');
});
test('an already-managed file manually brought to the approved version remains acceptable',async()=>{
  const f=fixture(),releaseData=await release(f.source);
  f.tree.find(entry=>entry.path===file).sha=releaseData.files[file];
  const changes=await updateFiles(f.gh,f.state,releaseData,f.source,base);
  assert.ok(!changes.some(entry=>entry.path===file));assert.ok(changes.some(entry=>entry.path===STATE));
});

test('missing or malformed installation records reply safely to an authorized update request',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ai-update-state-')),original=process.cwd();
  await mkdir(join(dir,'.github/ai-bot'),{recursive:true});process.chdir(dir);
  try{
    for(const content of [null,'not json','{}']){
      if(content!==null)await writeFile(STATE,content);
      const f=fixture();await assert.rejects(loadInstallation(f.gh,f.event,f.env,'apply'),e=>e.code==='UPDATE_STATE');
      const writes=f.gh.calls.filter(call=>call.method!=='GET');
      assert.equal(writes.length,1);assert.ok(writes[0].p.endsWith('/issues/9/comments'));
      assert.ok(writes[0].body.body.includes('導入記録'));assert.ok(!writes[0].body.body.includes('not json'));
    }
    const denied=fixture({role:'read'});await assert.rejects(loadInstallation(denied.gh,denied.event,denied.env,'apply'),e=>e.code==='ACCESS');
    assert.ok(!denied.gh.calls.some(call=>call.method!=='GET'));
    const f=fixture();await writeFile(STATE,JSON.stringify(f.state));
    assert.deepEqual(await loadInstallation(f.gh,f.event,f.env,'apply'),f.state);
  }finally{process.chdir(original);await rm(dir,{recursive:true,force:true});}
});

function automatic(f,trigger='schedule'){
  return{...f.env,GITHUB_EVENT_NAME:trigger,AI_BOT_UPDATE_AUTOMATIC:'true',AI_BOT_UPDATE_COMMIT:latest};
}
test('scheduled detection is independent of old notification Issues',async()=>{
  let f=fixture();f=fixture({issues:[{...f.notice,state:'closed'}]});
  f.gh.list=async()=>assert.fail('No Issue lookup is needed');
  assert.deepEqual(await checkUpdate(f.gh,f.state,f.source),{commit:latest});
});
test('automatic update authorization binds trusted triggers, repository, branch and checked source SHA',async()=>{
  let f=fixture();const event={repository:{full_name:'a/b'}};
  assert.equal((await authorizeAutomaticUpdate(f.gh,event,automatic(f))).commit,latest);
  for(const overrides of [{GITHUB_EVENT_NAME:'issue_comment'},{GITHUB_REF:'refs/heads/feature'},{AI_BOT_UPDATE_AUTOMATIC:'false'},{AI_BOT_UPDATE_COMMIT:'not-a-sha'}]){
    f=fixture();await assert.rejects(authorizeAutomaticUpdate(f.gh,event,{...automatic(f),...overrides}));
    assert.ok(!f.gh.calls.some(c=>c.method!=='GET'));
  }
  f=fixture();await assert.rejects(authorizeAutomaticUpdate(f.gh,{repository:{full_name:'other/repo'}},automatic(f)));
  f=fixture({role:'read'});await assert.rejects(authorizeAutomaticUpdate(f.gh,event,automatic(f,'workflow_dispatch')));
});
test('a scheduled update creates a direct PR without any Issue or comment',async()=>{
  const f=fixture();await applyUpdate(f.gh,f.gh,{repository:{full_name:'a/b'}},automatic(f),f.state,f.source);
  assert.ok(f.gh.calls.some(c=>c.method==='POST'&&c.p.endsWith('/pulls')));
  const pr=f.gh.calls.find(c=>c.method==='POST'&&c.p.endsWith('/pulls'));
  assert.match(pr.body.head,/^ai-update\/bot-/);assert.ok(!pr.body.body.includes('Refs #'));
  assert.ok(!f.gh.calls.some(c=>c.p.includes('/issues')));
  assert.ok(!f.gh.calls.some(c=>c.p.endsWith('/issues/comments/123')));
  assert.ok(!f.gh.calls.some(c=>c.p.endsWith('/merge')));
});
test('automatic retries reuse open PRs and respect closed PRs without needing writer credentials',async()=>{
  for(const state of ['open','closed']){
    const f=fixture(),list=f.gh.list;
    f.gh.list=async path=>path.includes('/pulls?')?[{number:15,state,body:`<!-- ai-bot-update-pr:${latest} -->\nRefs #9`,head:{ref:'ai-update/issue-9-0123456789ab-123',repo:{full_name:'a/b'}},base:{ref:'main',repo:{full_name:'a/b'}}}]:list(path);
    await applyUpdate(f.gh,null,{repository:{full_name:'a/b'}},automatic(f),f.state,f.source);
    assert.ok(!f.gh.calls.some(c=>c.p.includes('/git/')));
    assert.ok(!f.gh.calls.some(c=>c.method==='POST'&&c.p.endsWith('/pulls')));
    assert.ok(!f.gh.calls.some(c=>c.p.includes('/issues')));
  }
});
test('repeated automatic status reports do not post duplicate comments',async()=>{
  const f=fixture();await updateStatus(f.gh,9,latest,'setup needed');
  const first=f.gh.calls.find(c=>c.method==='POST').body.body;
  f.gh.calls.length=0;
  f.gh.list=async()=>[{id:42,user:{type:'Bot',login:'github-actions[bot]'},body:first}];
  await updateStatus(f.gh,9,latest,'setup needed');assert.equal(f.gh.calls.length,0);
  await updateStatus(f.gh,9,latest,'PR created');assert.equal(f.gh.calls.length,1);
  assert.equal(f.gh.calls[0].method,'PATCH');assert.equal(f.gh.calls[0].p,'/repos/a/b/issues/comments/42');
});

test('runtime projection retains installed workflow hashes and identifies manual workflow updates',async()=>{
  const f=fixture(),latestRelease=await release(f.source),runtime=scopedRelease(latestRelease,f.state,'runtime');
  assert.equal(runtime.files['.github/workflows/fix.yml'],f.state.files['.github/workflows/fix.yml']);
  assert.deepEqual(runtime.manualWorkflows,['.github/workflows/fix.yml']);
  const changes=await updateFiles(f.gh,f.state,runtime,f.source,base);
  assert.ok(changes.every(c=>!c.path.startsWith('.github/workflows/')));
  const state=JSON.parse(changes.find(c=>c.path===STATE).content);
  assert.equal(state.updateScope,'runtime');assert.equal(state.files['.github/workflows/fix.yml'],f.state.files['.github/workflows/fix.yml']);
  assert.equal(await checkUpdate(f.gh,state,f.source,'runtime'),undefined);
  assert.deepEqual(await checkUpdate(f.gh,state,f.source,'full'),{commit:latest});
});
test('runtime update uses GITHUB_TOKEN without a separate writer and never writes workflows',async()=>{
  const f=fixture();await applyUpdate(f.gh,null,{repository:{full_name:'a/b'}},{...automatic(f),AI_BOT_UPDATE_SCOPE:'runtime'},f.state,f.source);
  const tree=f.gh.calls.find(c=>c.method==='POST'&&c.p.endsWith('/git/trees'));
  assert.ok(tree);assert.ok(tree.body.tree.every(c=>!c.path.startsWith('.github/workflows/')));
  const pr=f.gh.calls.find(c=>c.method==='POST'&&c.p.endsWith('/pulls'));
  assert.ok(pr.body.body.includes('本体のみ'));assert.ok(pr.body.body.includes('.github/workflows/fix.yml'));
});
test('runtime scope neither adopts nor overwrites locally changed workflows',async()=>{
  const f=fixture();f.tree.find(t=>t.path==='.github/workflows/fix.yml').sha=base;
  const latestRelease=await release(f.source),runtime=scopedRelease(latestRelease,f.state,'runtime');
  const changes=await updateFiles(f.gh,f.state,runtime,f.source,base);
  assert.ok(changes.every(c=>!c.path.startsWith('.github/workflows/')));
  await assert.rejects(updateFiles(f.gh,f.state,latestRelease,f.source,base));
});
test('workflow-only upstream changes do not repeatedly create runtime PRs',async()=>{
  const f=fixture(),latestRelease=await release(f.source);
  const state={...f.state,files:{...latestRelease.files,'.github/workflows/fix.yml':f.state.files['.github/workflows/fix.yml']}};
  for(const entry of f.tree)if(state.files[entry.path])entry.sha=state.files[entry.path];
  assert.equal(await checkUpdate(f.gh,state,f.source,'runtime'),undefined);
  await applyUpdate(f.gh,null,{repository:{full_name:'a/b'}},{...automatic(f),AI_BOT_UPDATE_SCOPE:'runtime'},state,f.source);
  assert.ok(!f.gh.calls.some(c=>c.method==='POST'&&c.p.endsWith('/pulls')));
  assert.throws(()=>scopedRelease(latestRelease,state,'unknown'));
});

test('update entry validates repository and ref separately and reports only safe categories',()=>{
  const gh={repo:'a/b'},event={repository:{full_name:'a/b'}},env={GITHUB_REF:'refs/heads/main'},repo={default_branch:'main'};
  updateContext(gh,event,env,repo);
  assert.throws(()=>updateContext(gh,{repository:{full_name:'other/repo'}},env,repo),e=>e.code==='UPDATE_REPOSITORY');
  assert.throws(()=>updateContext(gh,event,{GITHUB_REF:'refs/heads/feature'},repo),e=>e.code==='UPDATE_BRANCH');
  assert.ok(updateError({code:'UPDATE_BRANCH'}).includes('デフォルトブランチ'));
  assert.ok(!updateError(new Error('secret-api-key')).includes('secret-api-key'));
});

test('PR failure links the destination permission setting without exposing credentials or requiring a runtime PAT',()=>{
  const env={GITHUB_REPOSITORY:'owner/project',AI_BOT_UPDATE_SCOPE:'runtime',GH_TOKEN:'secret-token',AI_BOT_UPDATE_TOKEN:'other-secret'};
  const text=updateError({code:'PR',message:'private API response'},env);
  assert.ok(text.includes('https://github.com/owner/project/settings/actions#workflow-permissions'));
  assert.ok(text.includes('Allow GitHub Actions to create and approve pull requests'));
  assert.ok(text.includes('contents: write'));assert.ok(text.includes('pull-requests: write'));
  assert.ok(text.includes('scope=runtimeでは追加トークン・AIキーは不要'));
  for(const secret of ['secret-token','other-secret','private API response'])assert.ok(!text.includes(secret));
  assert.ok(!text.includes('AI_BOT_UPDATE_TOKEN'));
  assert.ok(!updateError({code:'PR'},{GITHUB_REPOSITORY:'../evil\nsecret'}).includes('../evil'));
  assert.ok(!updateError(new Error('secret-token'),env).includes('secret-token'));
});
test('standalone full updates reuse full App proposals with the legacy runtime-compatible marker',async()=>{
  const f=fixture();
  const pr={number:15,state:'open',body:`<!-- ai-bot-update-pr:${latest}:runtime -->\n<!-- ai-bot-app-scope:full -->\n`,head:{ref:'ai-update/bot-0123456789ab-123',repo:{full_name:'a/b'}},base:{ref:'main',repo:{full_name:'a/b'}}};
  f.gh.list=async path=>path.includes('/pulls?')?[pr]:[];
  await applyUpdate(f.gh,f.gh,f.event,f.env,f.state,f.source);
  assert.ok(!f.gh.calls.some(call=>call.method==='POST'&&call.p.endsWith('/pulls')));
  assert.ok(!f.gh.calls.some(call=>call.p.includes('/git/')));
});
test('full update PR failure explains the separate workflow token requirement',()=>{
  const text=updateError({code:'PR'},{GITHUB_REPOSITORY:'owner/project',AI_BOT_UPDATE_SCOPE:'full'});
  assert.ok(text.includes('AI_BOT_UPDATE_TOKEN'));assert.ok(text.includes('Contents / Pull requests / Workflows'));
  assert.ok(text.includes('https://github.com/owner/project/settings/secrets/actions'));
  assert.ok(!text.includes('scope=runtime'));
});

test('automatic runtime detection and PR creation need no AI secrets, provider configuration or model execution',async()=>{
  const original=process.cwd(),dir=await mkdtemp(join(tmpdir(),'ai-free-update-'));
  try{
    process.chdir(dir);const f=fixture();
    const env={...automatic(f),AI_BOT_UPDATE_SCOPE:'runtime'};
    for(const name of ['AI_API_KEY','TOKYO_AI_API_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY','AI_BOT_UPDATE_TOKEN'])assert.equal(env[name],undefined);
    assert.deepEqual(await checkUpdate(f.gh,f.state,f.source,'runtime'),{commit:latest});
    await applyUpdate(f.gh,null,{repository:{full_name:'a/b'}},env,f.state,f.source);
    const pr=f.gh.calls.find(c=>c.method==='POST'&&c.p.endsWith('/pulls'));assert.ok(pr);
    assert.match(pr.body.body,/AI使用: なし/);
    await assert.rejects(readFile('.github/ai-bot/config.json'),e=>e.code==='ENOENT');
    assert.ok(f.source.calls.every(p=>/^\/(commits\/main|git\/(trees|blobs)\/[a-f0-9]{40})/.test(p)));
  }finally{process.chdir(original);await rm(dir,{recursive:true,force:true});}
});
test('update workflows do not receive AI keys and update-only bypasses investigation selection',async()=>{
  const updates=await readFile(new URL('../.github/workflows/bot-updates.yml',import.meta.url),'utf8');
  assert.ok(updates.includes('schedule:'));assert.ok(updates.includes('updates.js check'));assert.ok(updates.includes('updates.js apply'));
  assert.ok(!/TOKYO_AI_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|\bAI_API_KEY\b|providers\.js|fix\.js|main\.js/.test(updates));
  const investigate=await readFile(new URL('../.github/workflows/investigate.yml',import.meta.url),'utf8');
  const updateJob=investigate.slice(investigate.indexOf('  bot-updates:'),investigate.indexOf('  select:'));
  const selectJob=investigate.slice(investigate.indexOf('  select:'),investigate.indexOf('  run:'));
  assert.ok(updateJob.includes("inputs.operation == 'update-only' || inputs.check_bot_updates"));
  assert.ok(!/secrets:|AI_API_KEY/.test(updateJob));
  assert.ok(selectJob.includes("inputs.operation != 'update-only'"));
});
