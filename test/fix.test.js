import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, SafeError } from '../.github/ai-bot/src/core.js';
import { fixConfig, parsePlan, planHash } from '../.github/ai-bot/src/fix-core.js';
import { prepareFix, generateFix, validateFix, publishFix } from '../.github/ai-bot/src/fix.js';
const cfg=JSON.parse(await readFile(new URL('../.github/ai-bot/config.json',import.meta.url)));
const sha='a'.repeat(40),blobSha='b'.repeat(40);
const source='export const add = (a,b) => a-b;\n';
const fixed='export const add = (a,b) => a+b;\n';
const issue={number:2,state:'open',title:'Fix addition',body:'add(2,3) should return 5',labels:[{name:'ai-fix'}]};
const target={kind:'issue',number:2,title:issue.title,body:issue.body};
function bundle(){return {repo:'a/b',branch:'main',cfg,targets:[{...target,sha,fingerprint:fingerprint(target,sha,cfg)}],context:{files:[{path:'src/add.js',content:source}]}};}
function plan(){return {confidence:'high',summary:'加算を修正します。',changes:[{path:'src/add.js',content:fixed}]};}
async function fixture(fn){
  const dir=await mkdtemp(join(tmpdir(),'ai-fix-test-')),original=process.cwd();
  await mkdir(join(dir,'.github/ai-bot'),{recursive:true});await mkdir(join(dir,'.work'));
  await writeFile(join(dir,'.github/ai-bot/config.json'),JSON.stringify(cfg));
  await writeFile(join(dir,'event.json'),JSON.stringify({repository:{full_name:'a/b'},action:'labeled',label:{name:'ai-fix'},issue:{number:2}}));
  const env={GITHUB_REPOSITORY:'a/b',GITHUB_ACTOR:'owner',GITHUB_REF:'refs/heads/main',GITHUB_SHA:sha,GITHUB_EVENT_NAME:'issues',GITHUB_EVENT_PATH:join(dir,'event.json'),GITHUB_RUN_ID:'123',GITHUB_OUTPUT:join(dir,'output')};
  process.chdir(dir);
  try{await fn({dir,env});}finally{process.chdir(original);await rm(dir,{recursive:true,force:true});}
}
function github({permission='write',prs=[],head=sha,currentIssue=issue,failPR=false}={}){
  const calls=[];
  return {repo:'a/b',calls,path:(tail='')=>`/repos/a/b${tail}`,list:async path=>path.includes('/pulls?')?prs:[],request:async(path,method='GET',body)=>{
    calls.push({path,method,body});
    if(method!=='GET'){
      if(path.endsWith('/pulls') && failPR)throw new SafeError('ACCESS');
      if(path.endsWith('/pulls'))return{number:9,html_url:'https://github.com/a/b/pull/9'};
      return{sha:'c'.repeat(40),number:9};
    }
    if(path==='/repos/a/b')return{private:false,default_branch:'main'};
    if(path.includes('/permission'))return{permission};
    if(path.endsWith('/issues/2'))return currentIssue;
    if(path.includes('/git/ref/heads/'))return{object:{sha:head}};
    if(path.includes('/git/trees/'))return{tree:[{path:'src/add.js',type:'blob',mode:'100644',size:Buffer.byteLength(source),sha:blobSha}]};
    if(path.includes('/git/blobs/'))return{encoding:'base64',size:Buffer.byteLength(source),content:Buffer.from(source).toString('base64')};
    if(path.includes('/git/commits/'))return{tree:{sha:'d'.repeat(40)}};
    throw new Error(`Unexpected mocked path: ${path}`);
  }};
}
async function artifacts({verified=true,hash,changes=plan()}={}){
  const b=bundle();
  await writeFile('.work/fix-bundle.json',JSON.stringify(b));
  await writeFile('.work/fix-plan.json',JSON.stringify({ok:true,plan:changes}));
  await writeFile('.work/fix-verdict.json',JSON.stringify({ok:verified,hash:hash??planHash(changes),sha,commands:cfg.fix.commands,reason:'テスト失敗'}));
}
test('fix plans cannot escape allowed existing source or rewrite tests/config/secrets',()=>{
  assert.equal(fixConfig(cfg).enabled,true);
  assert.equal(fixConfig({...cfg,fix:undefined}).enabled,false);
  for(const change of [{path:'../src/add.js',content:fixed},{path:'.github/workflows/fix.yml',content:'x'},{path:'package.json',content:'{}'},{path:'src/add.test.js',content:fixed},{path:'src/new.js',content:fixed},{path:'src/add.js',content:source},{path:'src/add.js',content:'api_key="abcdefghijklmnop"'}])assert.throws(()=>parsePlan({...plan(),changes:[change]},bundle()),SafeError);
  assert.throws(()=>parsePlan({...plan(),confidence:'low'},bundle()),SafeError);
  assert.throws(()=>parsePlan({...plan(),changes:[...plan().changes,...plan().changes]},bundle()),SafeError);
  assert.throws(()=>parsePlan({...plan(),changes:[{path:'src/add.js',content:'x'.repeat(12001)}]},bundle()),SafeError);
  assert.throws(()=>fixConfig({...cfg,fix:{...cfg.fix,commands:[['sh','-c','echo pass']]}}),SafeError);
  assert.throws(()=>fixConfig({...cfg,fix:{...cfg.fix,commands:[['node','--version']]}}),SafeError);
  assert.deepEqual(parsePlan(plan(),bundle()),plan());
});
test('trusted label creates immutable preparation; foreign label and untrusted actor do not',()=>fixture(async({env})=>{
  await prepareFix(env,github());
  const prepared=JSON.parse(await readFile('.work/fix-bundle.json'));
  assert.equal(prepared.targets[0].sha,sha);assert.equal(prepared.context.files[0].path,'src/add.js');
  await assert.rejects(prepareFix(env,github({permission:'read'})),e=>e.code==='ACCESS');
  await assert.rejects(prepareFix({...env,GITHUB_REF:'refs/heads/other'},github()),e=>e.code==='ACCESS');
  const denied=github();await writeFile('event.json',JSON.stringify({action:'labeled',label:{name:'other'}}));
  await prepareFix(env,denied);assert.equal(denied.calls.length,0);
}));
test('existing open bot PR suppresses a new AI proposal',()=>fixture(async({env})=>{
  const gh=github({prs:[{number:9,user:{login:'github-actions[bot]',type:'Bot'},body:'<!-- ai-fix:issue:2 -->',head:{repo:{full_name:'a/b'}},base:{repo:{full_name:'a/b'}}}]});
  await prepareFix(env,gh);await assert.rejects(access('.work/fix-bundle.json'));
}));
test('generation accepts bounded JSON and masks failures without leaking provider errors',()=>fixture(async({env})=>{
  await artifacts();await generateFix(env,{tokyo:async()=>JSON.stringify(plan())});
  assert.deepEqual(JSON.parse(await readFile('.work/fix-plan.json')).plan,plan());
  await generateFix(env,{tokyo:async()=>{throw new Error('dummy-api-key must never be published');}});
  const result=await readFile('.work/fix-plan.json','utf8');assert.ok(!result.includes('dummy-api-key'));assert.equal(JSON.parse(result).ok,false);
  const b=bundle();b.context.files=[];await writeFile('.work/fix-bundle.json',JSON.stringify(b));
  await generateFix(env,{tokyo:async()=>assert.fail('No source: no API call')});
  assert.deepEqual(JSON.parse(await readFile('.work/fix-plan.json')).plan.changes,[]);
}));
test('validation only launches an offline secretless container and binds the verdict to the exact plan',()=>fixture(async({env})=>{
  await artifacts();const calls=[];
  const git=async(file,args)=>{
    if(args[0]==='ls-tree')return{stdout:`100644 blob ${blobSha} 34\tsrc/add.js\n`};
    await writeFile(args.find(a=>a.startsWith('--output=')).slice(9),'mock archive');return{stdout:''};
  };
  const run=async(args,options)=>{calls.push({args,options});return '';};
  await validateFix({...env,AI_API_KEY:'dummy-key',GH_TOKEN:'dummy-github-token'},{run,git});
  const verdict=JSON.parse(await readFile('.work/fix-verdict.json'));
  assert.equal(verdict.ok,true);assert.equal(verdict.hash,planHash(plan()));
  const docker=calls[0];assert.ok(docker.args.includes('--network=none'));assert.ok(docker.args.includes('--read-only'));assert.ok(docker.args.includes('--cap-drop=ALL'));
  assert.ok(!JSON.stringify(calls).includes('dummy-key'));assert.ok(!JSON.stringify(calls).includes('dummy-github-token'));assert.ok(!docker.args.includes('--privileged'));
  await validateFix(env,{git,run:async(args)=>{if(args[0]==='run')throw new SafeError('RUNTIME');return '';}});
  assert.equal(JSON.parse(await readFile('.work/fix-verdict.json')).ok,false);
  await validateFix(env,{git,run:async(args)=>args[0]==='run'?'OFFLINE_DEPENDENCIES':''});
  assert.match(JSON.parse(await readFile('.work/fix-verdict.json')).reason,/依存パッケージ/);
}));
test('successful validation creates a dedicated branch and PR, never changes main or merges',()=>fixture(async({env})=>{
  await artifacts();const gh=github();await publishFix(env,gh);
  const writes=gh.calls.filter(c=>c.method!=='GET');
  const ref=writes.find(c=>c.path.endsWith('/git/refs'));
  assert.match(ref.body.ref,/^refs\/heads\/ai-fix\/issue-2-/);assert.ok(!writes.some(c=>c.method==='PATCH' && c.path.includes('refs/heads/main')));
  const tree=writes.find(c=>c.path.endsWith('/git/trees'));
  assert.equal(tree.body.base_tree,'d'.repeat(40));assert.deepEqual(tree.body.tree,[{path:'src/add.js',mode:'100644',type:'blob',content:fixed}]);
  const pr=writes.find(c=>c.path.endsWith('/pulls'));
  assert.equal(pr.body.base,'main');assert.match(pr.body.body,/Closes #2/);assert.match(pr.body.body,/npm test/);
  assert.ok(!writes.some(c=>c.path.endsWith('/merge')));
}));
test('failed validation and stale source report only and create no branch or PR',()=>fixture(async({env})=>{
  await artifacts({verified:false});let gh=github();
  await assert.rejects(publishFix(env,gh),e=>e.code==='VALIDATION');
  assert.deepEqual(gh.calls.filter(c=>c.method!=='GET').map(c=>c.path),['/repos/a/b/issues/2/comments']);
  await artifacts();gh=github({head:'f'.repeat(40)});
  await assert.rejects(publishFix(env,gh),e=>e.code==='STALE');
  assert.ok(!gh.calls.some(c=>c.path.endsWith('/pulls') && c.method==='POST'));
  gh=github({currentIssue:{...issue,body:'changed'}});
  await assert.rejects(publishFix(env,gh),e=>e.code==='STALE');
}));
test('tampered plan, event routing and removed actor permission cannot publish',()=>fixture(async({env})=>{
  await artifacts({hash:'0'.repeat(64)});let gh=github();
  await assert.rejects(publishFix(env,gh),e=>e.code==='OUTPUT');assert.equal(gh.calls.filter(c=>c.method!=='GET').length,0);
  await artifacts();gh=github({permission:'read'});
  await assert.rejects(publishFix(env,gh),e=>e.code==='ACCESS');assert.equal(gh.calls.filter(c=>c.method!=='GET').length,0);
  await writeFile('event.json',JSON.stringify({repository:{full_name:'a/b'},action:'labeled',label:{name:'ai-fix'},issue:{number:3}}));
  gh=github();await assert.rejects(publishFix(env,gh),e=>e.code==='ACCESS');assert.equal(gh.calls.length,0);
}));
test('PR API failure removes its proposal branch and reports the error',()=>fixture(async({env})=>{
  await artifacts();const gh=github({failPR:true});
  await assert.rejects(publishFix(env,gh),e=>e.code==='PR');
  assert.ok(gh.calls.some(c=>c.method==='DELETE' && c.path.includes('/git/refs/heads/ai-fix/issue-2-')));
  assert.ok(gh.calls.some(c=>c.method==='POST' && c.path.endsWith('/issues/2/comments')));
}));
