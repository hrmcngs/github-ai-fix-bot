import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {config,allowedPath,BOT_EDITABLE_FILES,fingerprint} from '../.github/ai-bot/src/core.js';
import {editable,parsePlan,fixPrompt} from '../.github/ai-bot/src/fix-core.js';
import {collectFiles} from '../.github/ai-bot/src/main.js';
const cfg=JSON.parse(await readFile(new URL('../.github/ai-bot/config.json',import.meta.url)));
const path='.github/ai-bot/src/markdown.js';
const original='export const markdown = text => text;\n';
const bundle=(settings=cfg)=>({repo:'a/b',cfg:settings,targets:[{kind:'issue',number:1}],context:{files:[{path,content:original}]}});
const plan={confidence:'high',summary:'表示処理の最小修正',changes:[{path,content:'export const markdown = text => String(text);\n'}]};
test('Bot presentation module needs exact explicit opt-in and remains opt-out by default',()=>{
  assert.equal(allowedPath(path,cfg),true);assert.equal(editable(path,cfg),true);
  assert.deepEqual(parsePlan(plan,bundle()),plan);
  for(const botFiles of [undefined,[]]){
    const disabled={...cfg,fix:{...cfg.fix,botFiles}};
    assert.equal(allowedPath(path,disabled),false);assert.equal(editable(path,disabled),false);
    assert.throws(()=>parsePlan(plan,bundle(disabled)));
  }
  assert.ok(Object.isFrozen(BOT_EDITABLE_FILES));
});
test('configuration cannot opt into protected Bot controllers, tests, workflows or credentials',()=>{
  for(const blocked of ['.github/workflows/fix.yml','.github/ai-bot/src/core.js','.github/ai-bot/src/fix-core.js','.github/ai-bot/src/fix.js','.github/ai-bot/src/main.js','.github/ai-bot/src/commands.js','.github/ai-bot/src/providers.js','.github/ai-bot/src/github.js','.github/ai-bot/src/broker.js','.github/ai-bot/src/cli.js','.github/ai-bot/src/verify-container.js','.github/ai-bot/config.json','test/markdown.test.js','.env','../markdown.js','.github/ai-bot/src/']){
    const settings={...cfg,fix:{...cfg.fix,botFiles:[blocked]}};
    assert.throws(()=>config(settings),undefined,blocked);
    assert.equal(allowedPath(blocked,settings),false,blocked);
    assert.throws(()=>parsePlan({...plan,changes:[{path:blocked,content:'x'}]},bundle(settings)));
  }
  for(const botFiles of ['all',[path,path],[null]])assert.throws(()=>config({...cfg,fix:{...cfg.fix,botFiles}}));
  assert.throws(()=>config({...cfg,include:[...cfg.include,'.github/ai-bot/src/']}));
});
test('source collection includes only approved Bot leaf files and the prompt lists the actual edit scope',async()=>{
  const sha='a'.repeat(40);
  const gh={path:x=>x,request:async url=>url.includes('/trees/')?{tree:[{path,type:'blob',mode:'100644',size:original.length,sha},{path:'.github/ai-bot/src/providers.js',type:'blob',mode:'100644',size:10,sha}]}:{encoding:'base64',size:original.length,content:Buffer.from(original).toString('base64')}};
  const context=await collectFiles(gh,sha,cfg,[]);
  assert.deepEqual(context.files,[{path,content:original}]);
  const off={...cfg,fix:{...cfg.fix,botFiles:[]}};
  assert.deepEqual((await collectFiles(gh,sha,off,[])).files,[]);
  assert.ok(fixPrompt(bundle()).includes(`変更可能パス: ["${path}"]`));
  assert.notEqual(fingerprint({},sha,cfg),fingerprint({},sha,off));
});
