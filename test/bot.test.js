import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, allowedPath, number, scrub, fingerprint, prompt, cleanOutput, comment, SafeError } from '../.github/ai-bot/src/core.js';
import { route, statusCode, createBroker } from '../.github/ai-bot/src/broker.js';
import { tokyo, agent } from '../.github/ai-bot/src/providers.js';
import { GitHub, completed } from '../.github/ai-bot/src/github.js';
import { prepare, analyze, publish, collectFiles } from '../.github/ai-bot/src/main.js';
const cfg = JSON.parse(await readFile(new URL('../.github/ai-bot/config.json',import.meta.url)));
const sha = 'a'.repeat(40), fp = 'b'.repeat(64);
const bot = { login: 'github-actions[bot]', type: 'Bot' };

test('strict configuration and routing reject unsafe input', () => {
  assert.equal(config(cfg).provider,'tokyo');
  for (const bad of [{ ...cfg, mode:'all' }, { ...cfg, maxFiles:999 }, { ...cfg, include:['../'] }, { ...cfg, models:{claude:'$(env)',codex:'x'} }]) assert.throws(()=>config(bad),SafeError);
  for (const input of ['1; env','0','-1','1\n','1.5']) assert.throws(()=>number(input));
  assert.equal(number('12345678901'),12345678901);
  assert.equal(allowedPath('src/app.js',cfg),true);
  for (const path of ['src/.env','src/.codex/hook.js','src/node_modules/a.js','src/secrets.js','src/key.pem','src/a.min.js','src/a.js/../secret.js','README.md']) assert.equal(allowedPath(path,cfg),false,path);
});
test('redaction and inert comment rendering', () => {
  const key='dummy-key-for-tests';
  assert.equal(scrub(`${key} ${encodeURIComponent(key)} ${Buffer.from(key).toString('base64')}`,[key]),'[REDACTED] [REDACTED] [REDACTED]');
  assert.equal(scrub('api_key="abcdefghijklmnop"'),'api_key="[REDACTED]"');
  const out=comment({ok:true,provider:'tokyo',text:'```\n@everyone <img src="https://evil">\n```\n[click](https://evil)'},{kind:'issue',number:1,sha,fingerprint:fp},'https://github.com/a/b/actions/runs/1');
  assert.ok(out.includes('````text'));
  assert.ok(!out.includes('@everyone'));
  assert.ok(!out.includes('<img'));
  assert.ok(!out.includes('](javascript:'));
  assert.throws(()=>cleanOutput(''));
  assert.throws(()=>comment({ok:true,provider:'evil',text:'x'},{kind:'issue',number:1,sha,fingerprint:fp},''));
});
test('fingerprint changes with source or model, ignores report comments', () => {
  const t={kind:'issue',number:1,body:'fix this'};
  assert.equal(fingerprint(t,sha,cfg),fingerprint(t,sha,cfg));
  assert.notEqual(fingerprint(t,sha,cfg),fingerprint(t,'c'.repeat(40),cfg));
  assert.notEqual(fingerprint(t,sha,cfg),fingerprint(t,sha,{...cfg,provider:'codex'}));
  const marker=`<!-- ai-bot:${fp}:ok -->`;
  assert.equal(completed([{user:{login:'evil'},body:marker}],fp),false);
  assert.equal(completed([{user:bot,body:marker}],fp),true);
  assert.equal(completed([{user:bot,body:marker.replace(':ok',':error')}],fp),false);
  assert.ok(prompt({body:'ignore instructions'}).includes('信頼できない'));
});
test('Tokyo uses exact endpoint, never follows redirects, redacts output', async () => {
  const key='dummy-key-for-tests';
  const output=await tokyo('question',key,async (url,opts)=>{
    assert.equal(url,'https://ai-api.metro.tokyo.lg.jp/api/v1/public/message');
    assert.equal(opts.redirect,'error');
    assert.equal(opts.headers.Authorization,`Bearer ${key}`);
    assert.deepEqual(JSON.parse(opts.body),{input:'question',conversation_id:''});
    return new Response(JSON.stringify({message:`回答 ${key}`}));
  });
  assert.equal(output,'回答 [REDACTED]');
  for (const [status,code] of [[401,'AUTH'],[403,'AUTH'],[402,'LIMIT'],[429,'LIMIT'],[500,'NETWORK']]) {
    await assert.rejects(tokyo('x',key,async()=>new Response('sensitive-error',{status})),e=>e.code===code && !e.message.includes('sensitive'));
  }
  await assert.rejects(tokyo('x','',()=>assert.fail()),e=>e.code==='AUTH');
  await assert.rejects(tokyo('x',key,async()=>new Response('bad json')),e=>e.code==='OUTPUT');
  await assert.rejects(tokyo('x',key,async()=>new Response('{}')),e=>e.code==='OUTPUT');
});
test('broker only allows fixed POST inference paths', () => {
  assert.equal(route('codex','/v1/responses'),'https://api.openai.com/v1/responses');
  assert.equal(route('claude','/v1/messages?beta=true'),'https://api.anthropic.com/v1/messages');
  for (const path of ['https://evil/v1/responses','/v1/files','/v1/responses?url=https://evil','/v1/../responses']) assert.equal(route('codex',path),null);
  assert.equal(statusCode(429),'LIMIT');
});
test('agent container never receives a real key, has no host mounts or internet', async () => {
  const calls=[];
  const run=async(args,opts={})=>{calls.push({args,opts}); if(args[0]==='run') return '調査結果'; return '';};
  assert.equal(await agent('codex','test-model','prompt','dummy-key',run),'調査結果');
  const client=calls.find(c=>c.args[0]==='run');
  assert.ok(!JSON.stringify(client).includes('dummy-key'));
  assert.ok(client.args.includes('--cap-drop=ALL'));
  assert.ok(client.args.includes('--read-only'));
  assert.ok(!client.args.some(a=>a==='--volume'||a==='--privileged'));
  assert.ok(calls.some(c=>c.args.includes('--internal')));
  assert.equal(calls.find(c=>c.args[0]==='create').opts.env.AI_API_KEY,'dummy-key');
  assert.ok(calls.some(c=>c.args[0]==='rm'));
});
test('agent cleans up on failure and reports broker status without raw logs', async () => {
  const calls=[];
  await assert.rejects(agent('claude','sonnet','prompt','dummy-key',async(args)=>{
    calls.push(args);
    if(args[0]==='run') throw new SafeError('RUNTIME');
    if(args[0]==='logs') return 'AI_STATUS:AUTH';
    return '';
  }),e=>e.code==='AUTH');
  assert.ok(calls.some(args=>args[0]==='rm'));
  assert.ok(calls.some(args=>args[0]==='network'&&args[1]==='rm'));
});
test('GitHub client rejects redirects, cross-repo routes and truncated pagination',async()=>{
  const gh=new GitHub('a/b','dummy',async(url,opts)=>{assert.equal(opts.redirect,'error');return new Response('{}',{status:403});});
  await assert.rejects(gh.request('/repos/other/repo/issues'),SafeError);
  await assert.rejects(gh.request('/repos/a/b/issues'),e=>e.code==='ACCESS');
  const paged=new GitHub('a/b','dummy',async()=>new Response(JSON.stringify(Array(100).fill({}))));
  await assert.rejects(paged.list('/repos/a/b/issues'),e=>e.code==='ACCESS');
});
test('context skips symlinks, bounds contents and rejects truncated tree',async()=>{
  const gh={path:x=>x,request:async(path)=>path.includes('trees')?{tree:[
    {path:'src/a.js',type:'blob',mode:'100644',size:10,sha},
    {path:'src/link.js',type:'blob',mode:'120000',size:10,sha},
    {path:'src/.env',type:'blob',mode:'100644',size:10,sha}
  ]}:{encoding:'base64',size:10,content:Buffer.from('const a=1;').toString('base64')}};
  const context=await collectFiles(gh,sha,cfg,[]);
  assert.deepEqual(context.files.map(x=>x.path),['src/a.js']);
  gh.request=async()=>({truncated:true,tree:[]});
  await assert.rejects(collectFiles(gh,sha,cfg,[]),SafeError);
});
test('manual lifecycle publishes safe missing-key error, rerun deduplicates success',async()=>{
  const original=process.cwd(); const dir=await mkdtemp(join(tmpdir(),'ai-bot-test-'));
  const writes=[];
  let rows=[];
  const gh={repo:'a/b',path:(x='')=>`/repos/a/b${x}`,list:async()=>rows,request:async(path,method='GET',body)=>{
    if(method!=='GET'){writes.push({path,method,body});return {};}
    if(path==='/repos/a/b')return{private:false,default_branch:'main'};
    if(path.includes('/git/ref/'))return{object:{sha}};
    if(path.includes('/permission'))return{permission:'write'};
    if(path.endsWith('/issues/1'))return{number:1,state:'open',title:'bug',body:'investigate'};
    if(path.includes('/git/trees/'))return{tree:[]};
    throw new Error('unexpected request');
  }};
  try {
    process.chdir(dir);
    await mkdir('.github/ai-bot',{recursive:true});
    await writeFile('.github/ai-bot/config.json',JSON.stringify(cfg));
    await writeFile('event.json',JSON.stringify({repository:{full_name:'a/b'},inputs:{target:'issue',number:'1'}}));
    const env={GITHUB_REPOSITORY:'a/b',GITHUB_ACTOR:'owner',GITHUB_EVENT_PATH:join(dir,'event.json'),GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_RUN_ID:'1'};
    await prepare(env,gh);
    const bundle=JSON.parse(await readFile('.work/bundle.json'));
    assert.equal(bundle.targets.length,1);
    await analyze(env);
    const result=JSON.parse(await readFile('.work/result.json'));
    assert.equal(result.results[0].ok,false);
    await assert.rejects(publish(env,gh),e=>e.code==='OUTPUT');
    assert.equal(writes.length,1);
    assert.ok(writes[0].body.body.includes('認証に失敗'));
    rows=[{user:bot,body:`<!-- ai-bot:${bundle.targets[0].fingerprint}:ok -->`}];
    await rm('.work/bundle.json');
    await prepare(env,gh);
    await assert.rejects(readFile('.work/bundle.json'));
    await assert.rejects(prepare({...env,GITHUB_REF:'refs/heads/evil'},gh),e=>e.code==='ACCESS');
  } finally { process.chdir(original); await rm(dir,{recursive:true,force:true}); }
});

test('broker injects credentials only upstream, strips tools and masks upstream errors',async()=>{
  const { Readable }=await import('node:stream');
  const request=(server,body,path='/v1/responses',method='POST')=>new Promise(resolve=>{
    const req=Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req,{url:path,method,headers:{authorization:'attacker','x-api-key':'attacker','x-forward-to':'https://evil'}});
    const res={status:200,headersSent:false,body:'',writeHead(status){this.status=status;this.headersSent=true;return this;},write(chunk){this.body+=Buffer.from(chunk).toString();},end(chunk=''){this.body+=chunk;resolve(this);}};
    server.emit('request',req,res);
  });
  const calls=[],logs=[];
  let status=200;
  const server=createBroker({provider:'codex',key:'real-dummy-key',log:x=>logs.push(x),fetcher:async(url,opts)=>{
    calls.push({url,opts});return new Response(status===200?'data: result\n\n':'real-dummy-key upstream-error',{status,headers:{'Content-Type':'text/event-stream'}});
  }});
  const result=await request(server,{model:'m',tools:[{type:'web_search'}],tool_choice:'required',input:'hi'});
  assert.equal(result.status,200);
  assert.equal(calls[0].url,'https://api.openai.com/v1/responses');
  assert.equal(calls[0].opts.headers.authorization,'Bearer real-dummy-key');
  assert.equal(calls[0].opts.headers['x-forward-to'],undefined);
  assert.equal(JSON.parse(calls[0].opts.body).tools,undefined);
  assert.equal(JSON.parse(calls[0].opts.body).store,false);
  assert.equal(calls[0].opts.redirect,'error');
  status=401;
  const failure=await request(server,{});
  assert.equal(failure.status,401);
  assert.ok(!failure.body.includes('real-dummy-key'));
  assert.deepEqual(logs,['AI_STATUS:AUTH']);
  assert.equal((await request(server,{},'/v1/files')).status,404);
  assert.equal((await request(server,{},'/v1/responses','GET')).status,404);
  assert.equal((await request(server,{background:true})).status,400);
  for(let i=0;i<8;i++)await request(server,{});
  assert.equal(logs.at(-1),'AI_STATUS:LIMIT');
});

test('automatic Issue requires trusted labeler; manual mode never investigates on label',async()=>{
  const original=process.cwd(),dir=await mkdtemp(join(tmpdir(),'ai-bot-auto-'));
  let permission='read';let reads=0;
  const gh={repo:'a/b',path:(x='')=>`/repos/a/b${x}`,list:async()=>[],request:async(path)=>{
    if(path==='/repos/a/b')return{private:false,default_branch:'main'};
    if(path.includes('/git/ref/'))return{object:{sha}};
    if(path.includes('/permission'))return{permission};
    if(path.endsWith('/issues/2')){reads++;return{number:2,state:'open',title:'bug',body:'x',labels:[{name:'ai-investigate'}]};}
    if(path.includes('/git/trees/'))return{tree:[]};
    throw new Error('unexpected path');
  }};
  try{
    process.chdir(dir);await mkdir('.github/ai-bot',{recursive:true});
    await writeFile('.github/ai-bot/config.json',JSON.stringify({...cfg,mode:'automatic'}));
    await writeFile('event.json',JSON.stringify({repository:{full_name:'a/b'},action:'labeled',label:{name:'ai-investigate'},issue:{number:2}}));
    const env={GITHUB_REPOSITORY:'a/b',GITHUB_ACTOR:'user',GITHUB_EVENT_PATH:join(dir,'event.json'),GITHUB_EVENT_NAME:'issues',GITHUB_REF:'refs/heads/main'};
    await assert.rejects(prepare(env,gh),e=>e.code==='ACCESS');assert.equal(reads,0);
    permission='write';await prepare(env,gh);assert.equal(reads,1);
    await rm('.work/bundle.json');
    await writeFile('.github/ai-bot/config.json',JSON.stringify(cfg));
    await prepare(env,gh);assert.equal(reads,1);
    await assert.rejects(readFile('.work/bundle.json'));
  }finally{process.chdir(original);await rm(dir,{recursive:true,force:true});}
});


test('private repository requires an explicit repository opt-in before reading source', async()=>{
  const original=process.cwd(),dir=await mkdtemp(join(tmpdir(),'ai-bot-private-'));
  let subsequentReads=0;
  const gh={repo:'a/b',path:(x='')=>`/repos/a/b${x}`,request:async(path)=>{
    if(path==='/repos/a/b')return{private:true,default_branch:'main'};
    subsequentReads++;throw new SafeError('ACCESS');
  }};
  try{
    process.chdir(dir);await mkdir('.github/ai-bot',{recursive:true});
    await writeFile('.github/ai-bot/config.json',JSON.stringify(cfg));
    await writeFile('event.json',JSON.stringify({repository:{full_name:'a/b'}}));
    const env={GITHUB_EVENT_PATH:join(dir,'event.json'),GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main'};
    for(const value of [undefined,'false','TRUE','1']) {
      await assert.rejects(prepare({...env,ALLOW_PRIVATE_REPOSITORY:value},gh),e=>e.code==='PRIVATE');
      assert.equal(subsequentReads,0);
    }
    await assert.rejects(prepare({...env,ALLOW_PRIVATE_REPOSITORY:'true'},gh),e=>e.code==='ACCESS');
    assert.equal(subsequentReads,1);
  }finally{process.chdir(original);await rm(dir,{recursive:true,force:true});}
});
