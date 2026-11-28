import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,createVerify} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {appJwt,DeliveryApp,authorizeDelivery,remoteInstallation,deliverOne,deliverUpdates,deliveryError} from '../scripts/deliver-updates.mjs';
import {SOURCE,STATE,MANIFEST,release} from '../.github/ai-bot/src/updates.js';
const old='a'.repeat(40),latest='b'.repeat(40),base='c'.repeat(40);
const hash=content=>createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
const key=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
function fixture(name='owner/private-destination'){
  const main='.github/ai-bot/src/main.js',workflow='.github/workflows/investigate.yml';
  const contents={[MANIFEST]:JSON.stringify({version:1,files:[MANIFEST,main,workflow,'.github/ai-bot/config.json']}),[main]:'export const version=2;\n',[workflow]:'name: Updated\n','.github/ai-bot/config.json':'{}'};
  const blobs=new Map(Object.values(contents).map(content=>[hash(content),content]));
  const tree=Object.entries(contents).map(([path,content])=>({path,type:'blob',mode:'100644',sha:hash(content),size:Buffer.byteLength(content)}));
  const source={request:async path=>{
    if(path===`/git/trees/${latest}?recursive=1`)return{tree};
    if(path.startsWith('/git/blobs/'))return{encoding:'base64',content:Buffer.from(blobs.get(path.split('/').at(-1))).toString('base64')};
    throw new Error('Unexpected source route');
  }};
  const state={version:1,source:SOURCE,commit:old,files:{[MANIFEST]:hash(contents[MANIFEST]),[main]:hash('export const version=1;\n'),[workflow]:hash('name: Old\n')}};
  const stateText=JSON.stringify(state),entries=[...['.github','.github/ai-bot','.github/ai-bot/src','.github/workflows'].map(path=>({path,type:'tree',mode:'040000'})),...Object.entries(state.files).map(([path,sha])=>({path,sha,type:'blob',mode:'100644'})),{path:STATE,sha:hash(stateText),type:'blob',mode:'100644',size:Buffer.byteLength(stateText)}];
  const current={base,prs:[],entries,corrupt:false,failPR:false,calls:[]};
  const gh={repo:name,path:(path='')=>`/repos/${name}${path}`,list:async()=>current.prs,request:async(path,method='GET',body)=>{
    current.calls.push({path,method,body});
    if(method!=='GET'){
      if(path.endsWith('/pulls')){if(current.failPR)throw new Error('private-token-error');return{number:7};}
      return{sha:base};
    }
    if(path===`/repos/${name}`)return{full_name:name,default_branch:'main',private:true};
    if(path.includes('/git/ref/'))return{object:{sha:current.base}};
    if(path.includes('/git/trees/'))return{tree:current.entries};
    if(path.includes('/git/blobs/'))return{encoding:'base64',content:Buffer.from(current.corrupt?'tampered':stateText).toString('base64')};
    if(path.includes('/git/commits/'))return{tree:{sha:base}};
    throw new Error('Unexpected target route');
  }};
  const event={repository:{full_name:SOURCE},ref:'refs/heads/main',after:latest};
  const env={GITHUB_REPOSITORY:SOURCE,GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',GITHUB_SHA:latest,GITHUB_RUN_ID:'123'};
  const sourceGH={repo:SOURCE,path:(p='')=>`/repos/${SOURCE}${p}`,request:async path=>path===`/repos/${SOURCE}`?{default_branch:'main'}:{object:{sha:latest}}};
  const appCalls=[];const app={targets:async()=>({login:'delivery[bot]',targets:[{id:1,name,installation:2}]}),token:async(...args)=>{appCalls.push({token:args});return'ephemeral-token';},revoke:async token=>{appCalls.push({revoke:token});}};
  return{source,gh,current,event,env,sourceGH,app,appCalls,main,workflow};
}
test('App JWT uses a bounded RSA signature and never embeds the private key',()=>{
  const jwt=appJwt('42',key.privateKey,1000),[header,payload,signature]=jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(payload,'base64url')),{iat:940,exp:1540,iss:'42'});
  assert.equal(createVerify('RSA-SHA256').update(header+'.'+payload).verify(key.publicKey,signature,'base64url'),true);
  assert.ok(!jwt.includes('PRIVATE KEY'));
  for(const [id,pem]of [['../evil',key.privateKey],['42','not-a-key']])assert.throws(()=>appJwt(id,pem),e=>e.code==='APP_SETUP');
});
test('App discovery is fixed-host, read-only, paginated and revokes enumeration tokens',async()=>{
  const calls=[];const app=new DeliveryApp('42',key.privateKey,async(url,options)=>{
    calls.push({url,options});assert.equal(new URL(url).origin,'https://api.github.com');assert.equal(options.redirect,'error');
    const path=new URL(url).pathname;
    if(options.method==='DELETE')return new Response(null,{status:204});
    if(path==='/app')return Response.json({id:42,slug:'delivery'});
    if(path==='/app/installations')return Response.json([{id:2,app_id:42},{id:3,app_id:42,suspended_at:'now'}]);
    if(path.endsWith('/access_tokens')){assert.deepEqual(JSON.parse(options.body),{permissions:{contents:'read'}});return Response.json({token:'read-token'});}
    if(path==='/installation/repositories')return Response.json({repositories:[{id:1,full_name:'owner/private'},{id:2,full_name:SOURCE}]});
    throw new Error('Unexpected route');
  });
  assert.deepEqual(await app.targets(),{login:'delivery[bot]',targets:[{id:1,name:'owner/private',installation:2}]});
  assert.equal(calls.filter(c=>c.options.method==='DELETE').length,1);
  const before=calls.length;await assert.rejects(app.request('/../../evil','GET','token'));assert.equal(calls.length,before);
  const denied=new DeliveryApp('42',key.privateKey,async()=>new Response('private-secret',{status:403}));
  await assert.rejects(denied.request('/app'),e=>e.code==='APP_PERMISSIONS'&&!e.message.includes('private-secret'));
  app.request=async()=>Array(100).fill({});await assert.rejects(app.pages('/app/installations',x=>x),e=>e.code==='APP_LIMIT');
});
test('only the latest default-branch source push may use the App',async()=>{
  const f=fixture();assert.equal(await authorizeDelivery(f.sourceGH,f.event,f.env),true);
  for(const change of [{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_EVENT_NAME:'workflow_dispatch'},{GITHUB_REF:'refs/heads/feature'},{GITHUB_REPOSITORY:'other/repo'}]){
    await assert.rejects(deliverUpdates(f.event,{...f.env,...change},{sourceGH:f.sourceGH,app:{targets:async()=>assert.fail('Unauthorized App use')}}));
  }
  f.sourceGH.request=async path=>path.endsWith('/main')?{object:{sha:old}}:{default_branch:'main'};
  assert.deepEqual(await deliverUpdates(f.event,f.env,{sourceGH:f.sourceGH,app:{targets:async()=>assert.fail('Superseded push')}}),{superseded:1});
});
test('full App delivery proposes managed Bot and workflow files without default-branch commits or private names in stats',async()=>{
  const f=fixture();
  const stats=await deliverUpdates(f.event,f.env,{app:f.app,sourceGH:f.sourceGH,upstream:f.source,github:()=>f.gh});
  assert.equal(stats.created,1);assert.equal(stats.failed,0);assert.ok(!JSON.stringify(stats).includes('private-destination'));
  assert.deepEqual(f.appCalls[0].token,[2,{contents:'write',pull_requests:'write',workflows:'write'},1]);
  assert.deepEqual(f.appCalls.at(-1),{revoke:'ephemeral-token'});
  const writes=f.current.calls.filter(c=>c.method==='POST'),files=writes.find(c=>c.path.endsWith('/git/trees')).body.tree;
  assert.ok(files.some(file=>file.path===f.workflow));assert.ok(files.some(file=>file.path===STATE));
  assert.ok(!files.some(file=>file.path==='.github/ai-bot/config.json'));
  const branch=writes.find(c=>c.path.endsWith('/git/refs')).body.ref;assert.match(branch,/^refs\/heads\/ai-update\/bot-/);
  const body=writes.find(c=>c.path.endsWith('/pulls')).body.body;
  assert.ok(body.startsWith(`<!-- ai-bot-update-pr:${latest}:runtime -->\n<!-- ai-bot-app-scope:full -->\n`));
  assert.ok(!f.current.calls.some(c=>c.method==='PATCH'||c.path.endsWith('/merge')));
});
test('runtime delivery requests no workflow permission and keeps workflow hashes',async()=>{
  const f=fixture();await deliverUpdates(f.event,{...f.env,AI_BOT_DELIVERY_SCOPE:'runtime'},{app:f.app,sourceGH:f.sourceGH,upstream:f.source,github:()=>f.gh});
  assert.deepEqual(f.appCalls[0].token[1],{contents:'write',pull_requests:'write'});
  const files=f.current.calls.find(c=>c.method==='POST'&&c.path.endsWith('/git/trees')).body.tree;
  assert.ok(!files.some(file=>file.path===f.workflow));
});
test('delivery skips non-installations, reuses owned proposals and respects closed versions',async()=>{
  const f=fixture(),latestRelease=await release(f.source,latest),options={scope:'full',runId:123,appLogin:'delivery[bot]',beforeWrite:async()=>{}};
  const own={number:7,state:'open',user:{type:'Bot',login:'delivery[bot]'},body:`<!-- ai-bot-update-pr:${latest}:runtime -->\n<!-- ai-bot-app-scope:full -->\n`,head:{ref:'ai-update/bot-0123456789ab-123',repo:{full_name:f.gh.repo}},base:{ref:'main',repo:{full_name:f.gh.repo}}};
  f.current.prs=[own];assert.equal(await deliverOne(f.gh,f.source,latestRelease,options),'existing');
  own.state='closed';assert.equal(await deliverOne(f.gh,f.source,latestRelease,options),'closed');
  f.current.prs=[];f.current.entries=f.current.entries.filter(entry=>entry.path!==STATE);
  assert.equal(await deliverOne(f.gh,f.source,latestRelease,options),'not-installed');
  assert.equal(f.current.calls.filter(c=>c.method==='POST').length,0);
});
test('tampered installation records, local changes, symlinks and changed source stop writes',async()=>{
  for(const mode of ['corrupt','modified','symlink','stale']){
    const f=fixture();if(mode==='corrupt')f.current.corrupt=true;
    if(mode==='modified')f.current.entries.find(entry=>entry.path===f.main).sha='e'.repeat(40);
    if(mode==='symlink')f.current.entries.find(entry=>entry.path==='.github/ai-bot').mode='120000';
    const options={scope:'full',runId:123,appLogin:'delivery[bot]',beforeWrite:async()=>{if(mode==='stale')f.current.base=old;}};
    await assert.rejects(deliverOne(f.gh,f.source,await release(f.source,latest),options));
    assert.equal(f.current.calls.filter(c=>c.method==='POST').length,0);
  }
});
test('one destination failure does not block other App installations and every write token is revoked',async()=>{
  const bad=fixture('owner/first-private'),good=fixture('owner/second-private');bad.current.failPR=true;
  bad.app.targets=async()=>({login:'delivery[bot]',targets:[{id:1,name:bad.gh.repo,installation:2},{id:2,name:good.gh.repo,installation:2}]});
  const stats=await deliverUpdates(bad.event,bad.env,{app:bad.app,sourceGH:bad.sourceGH,upstream:bad.source,github:name=>name===bad.gh.repo?bad.gh:good.gh});
  assert.equal(stats.created,1);assert.equal(stats.failed,1);assert.equal(stats.PR,1);
  assert.equal(bad.appCalls.filter(call=>call.revoke).length,2);
  for(const secret of ['private-token-error','first-private','second-private','ephemeral-token'])assert.ok(!JSON.stringify(stats).includes(secret));
  assert.ok(!deliveryError(new Error('private-token-error')).includes('private-token-error'));
});
test('publisher is source-only and never receives AI keys or executes installed code',async()=>{
  const workflow=await readFile(new URL('../.github/workflows/deliver-updates.yml',import.meta.url),'utf8');
  for(const key of ['TOKYO_AI_API_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY','AI_API_KEY'])assert.ok(!workflow.includes(key));
  assert.ok(!workflow.includes('workflow_dispatch:'));assert.ok(workflow.includes("github.repository == 'hrmcngs/github-ai-fix-bot'"));
  assert.ok(!JSON.parse(await readFile(new URL('../.github/ai-bot/distribution.json',import.meta.url))).files.includes('.github/workflows/deliver-updates.yml'));
});
