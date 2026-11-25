import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const source=fileURLToPath(new URL('../',import.meta.url));
const script=await readFile(new URL('../install.sh',import.meta.url),'utf8');

async function fixture(fn) {
  const dir=await mkdtemp(join(tmpdir(),'ai-bot-installer-'));
  const root=join(dir,'target with spaces'),bin=join(dir,'bin');
  await mkdir(root);await mkdir(bin);await mkdir(join(dir,'home'));
  await writeFile(join(bin,'git'),`#!${process.execPath}
const fs=require('node:fs'),crypto=require('node:crypto'),args=process.argv.slice(2);
if(args[0]==='hash-object'){
  const bytes=fs.readFileSync(args.at(-1));
  process.stdout.write(crypto.createHash('sha1').update('blob '+bytes.length+'\\0').update(bytes).digest('hex')+'\\n');
}else if(args[0]==='-C')process.stdout.write(process.env.FIXTURE_ROOT+'\\n');
else process.stdout.write('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\trefs/heads/main\\n');
`,{mode:0o755});
  await writeFile(join(bin,'curl'),`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),url=args.find(x=>x.startsWith('https://'));
if(!url || !url.includes('/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'))process.exit(2);
const relative=url.split('/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/')[1];
if(relative===process.env.FAIL_DOWNLOAD)process.exit(22);
fs.copyFileSync(path.join(process.env.FIXTURE_SOURCE,relative),args[args.indexOf('--output')+1]);
`,{mode:0o755});
  const run=(extra={})=>spawnSync('bash',['-s','--','--directory',root],{input:script,encoding:'utf8',cwd:dir,env:{PATH:`${bin}:/usr/bin:/bin`,HOME:join(dir,'home'),TMPDIR:dir,FIXTURE_ROOT:root,FIXTURE_SOURCE:source,...extra}});
  try{await fn({root,dir,run});}finally{await rm(dir,{recursive:true,force:true});}
}
test('piped installer installs pinned files, preserves config and supports repeat runs',()=>fixture(async({root,run})=>{
  await mkdir(join(root,'.github/ai-bot'),{recursive:true});
  await writeFile(join(root,'.github/ai-bot/config.json'),'custom settings');
  await writeFile(join(root,'package.json'),'original project');
  const result=run();assert.equal(result.status,0,result.stderr);
  assert.equal(await readFile(join(root,'.github/ai-bot/config.json'),'utf8'),'custom settings');
  assert.equal(await readFile(join(root,'package.json'),'utf8'),'original project');
  assert.equal(await readFile(join(root,'.github/workflows/investigate.yml'),'utf8'),await readFile(join(source,'.github/workflows/investigate.yml'),'utf8'));
  const state=JSON.parse(await readFile(join(root,'.github/ai-bot/installation.json'),'utf8'));
  assert.equal(state.commit,'a'.repeat(40));assert.equal(state.source,'hrmcngs/github-ai-fix-bot');
  assert.ok(state.files['.github/ai-bot/src/updates.js']);assert.equal(state.files['.github/ai-bot/config.json'],undefined);
  assert.equal(run().status,0);
  assert.ok(!result.stderr.includes('unbound variable'));
}));
test('installer preflights conflicts without partial installation or overwrite',()=>fixture(async({root,run})=>{
  await mkdir(join(root,'.github/workflows'),{recursive:true});
  await writeFile(join(root,'.github/workflows/investigate.yml'),'existing workflow');
  const result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/Existing file differs/);
  await assert.rejects(access(join(root,'.github/ai-bot')));
  assert.equal(await readFile(join(root,'.github/workflows/investigate.yml'),'utf8'),'existing workflow');
}));
test('installer download failure leaves project untouched',()=>fixture(async({root,run})=>{
  const result=run({FAIL_DOWNLOAD:'.github/workflows/investigate.yml'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Download failed/);
  await assert.rejects(access(join(root,'.github')));
}));
test('installer refuses symlinked destinations',()=>fixture(async({root,dir,run})=>{
  const external=join(dir,'external');await mkdir(external);await symlink(external,join(root,'.github'));
  const result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/Symlinked destination/);
  await assert.rejects(access(join(external,'ai-bot')));
}));
