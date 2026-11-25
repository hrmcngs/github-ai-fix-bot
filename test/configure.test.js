import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {settings,configure} from '../.github/ai-bot/src/configure.js';
const raw=JSON.parse(await readFile(new URL('../.github/ai-bot/config.json',import.meta.url),'utf8'));
test('guided settings use script names without running them and disable privileged defaults',()=>{
  const next=settings(raw,{provider:'claude',mode:'automatic',scripts:{test:'some command',check:'any command'},sourcePaths:['frontend/']});
  assert.equal(next.provider,'claude');assert.equal(next.mode,'automatic');
  assert.deepEqual(next.fix.commands,[['npm','run','check'],['npm','test']]);
  assert.equal(next.fix.enabled,true);assert.deepEqual(next.fix.botFiles,[]);assert.equal(next.autoMerge.enabled,false);
  assert.ok(next.include.includes('frontend/'));assert.deepEqual(raw.fix.botFiles,['.github/ai-bot/src/markdown.js']);
});
test('missing and placeholder tests keep code fixes disabled',()=>{
  for(const scripts of [{},{test:''},{test:'echo "Error: no test specified" && exit 1'}]){
    const next=settings(raw,{provider:'tokyo',mode:'manual',scripts});
    assert.equal(next.fix.enabled,false);assert.deepEqual(next.fix.commands,[]);
  }
});
test('setup rejects invalid providers, modes and unsafe source paths',()=>{
  assert.throws(()=>settings(raw,{provider:'other',mode:'manual'}));
  assert.throws(()=>settings(raw,{provider:'codex',mode:'all'}));
  assert.throws(()=>settings(raw,{provider:'codex',mode:'manual',sourcePaths:['../']}));
});
test('configure updates config atomically, tolerates no package and refuses symlinks',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ai-setup-'));
  try{
    await mkdir(join(root,'.github/ai-bot'),{recursive:true});
    const file=join(root,'.github/ai-bot/config.json');await writeFile(file,JSON.stringify(raw));
    await configure(root,'codex','manual');
    assert.equal(JSON.parse(await readFile(file,'utf8')).fix.enabled,false);
    const outside=join(root,'outside.json');await writeFile(outside,JSON.stringify(raw));
    await rm(file);await symlink(outside,file);
    await assert.rejects(configure(root,'tokyo','manual'));
    assert.deepEqual(JSON.parse(await readFile(outside,'utf8')),raw);
  }finally{await rm(root,{recursive:true,force:true});}
});
