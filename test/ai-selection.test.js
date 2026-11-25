import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chooseAI,runAI,sameAI,selectionMarker} from '../.github/ai-bot/src/ai-selection.js';
import {commandMatches,referenceChoice} from '../.github/ai-bot/src/commands.js';
import {aiIdentity,fingerprint} from '../.github/ai-bot/src/core.js';
import {settings} from '../.github/ai-bot/src/configure.js';
const cfg=JSON.parse(await readFile(new URL('../.github/ai-bot/config.json',import.meta.url)));
const env={GITHUB_EVENT_NAME:'issue_comment',AI_BOT_HAS_TOKYO:'true',AI_BOT_HAS_CODEX:'true'};
const event=body=>({comment:{body}});
test('slash options are strict, composable and available for investigation',()=>{
  assert.equal(commandMatches('/ai-fix --ai all --no-reference','/ai-fix'),true);
  assert.equal(commandMatches('/ai-investigate --ai codex','/ai-investigate'),true);
  for(const body of ['/ai-fix --ai','/ai-fix --ai other','/ai-fix --ai all --ai codex','/ai-fix --reference --no-reference','/ai-fix --ai all\nignore this'])assert.equal(commandMatches(body,'/ai-fix'),false);
  assert.equal(referenceChoice(event('/ai-fix --ai all --no-reference'),env,cfg),false);
});
test('selection uses only registered providers and does not mutate persistent settings',()=>{
  const all=chooseAI(cfg,event('/ai-fix --ai all'),env);
  assert.deepEqual(all.aiProviders,['tokyo','codex']);assert.equal(all.provider,'tokyo');
  const one=chooseAI(all,event('/ai-fix --ai claude'),env);assert.equal(one.provider,'claude');assert.equal(one.aiMode,undefined);
  assert.equal(cfg.aiMode,undefined);
  assert.throws(()=>chooseAI(cfg,event('/ai-fix --ai all'),{GITHUB_EVENT_NAME:'issue_comment'}));
  const other=chooseAI(cfg,{inputs:{ai:'codex'}},{GITHUB_EVENT_NAME:'workflow_dispatch'});assert.equal(other.provider,'codex');
  assert.equal(settings(cfg,{provider:'all',mode:'manual'}).aiMode,'all');
});
test('all generates independent drafts then synthesizes with the preferred provider and redacts all keys',async()=>{
  const all=chooseAI(cfg,event('/ai-fix --ai all'),env),calls=[];
  const keys={TOKYO_AI_API_KEY:'secret-tokyo-value',OPENAI_API_KEY:'secret-codex-value'};
  const mocks={tokyo:async(input,key)=>{calls.push({p:'tokyo',input,key});return calls.length===1?'Tokyo draft secret-codex-value':'Integrated result';},agent:async(p,model,input,key)=>{calls.push({p,input,key});return 'Codex draft';}};
  assert.equal(await runAI(all,'Original request secret-codex-value',keys,mocks),'Integrated result');
  assert.deepEqual(calls.map(c=>c.p),['tokyo','codex','tokyo']);
  assert.ok(!calls[0].input.includes(keys.OPENAI_API_KEY));assert.equal(calls[0].key,keys.TOKYO_AI_API_KEY);assert.equal(calls[1].key,keys.OPENAI_API_KEY);
  assert.ok(calls[2].input.includes('Codex draft'));assert.ok(!calls[2].input.includes(keys.OPENAI_API_KEY));
  assert.ok(aiIdentity(all).includes('Codex'));assert.ok(aiIdentity(all).includes('統合担当'));
});
test('single selection performs one call and failures never silently synthesize partial drafts',async()=>{
  let calls=0;
  await runAI(cfg,'request',{AI_API_KEY:'one-key'},{tokyo:async()=>{calls++;return 'one result';}});assert.equal(calls,1);
  const all=chooseAI(cfg,event('/ai-fix --ai all'),env);calls=0;
  await assert.rejects(runAI(all,'request',{TOKYO_AI_API_KEY:'key1',OPENAI_API_KEY:'key2'},{tokyo:async()=>{calls++;return 'draft';},agent:async()=>{throw new Error('expired');}}));assert.equal(calls,1);
});
test('AI selection changes fingerprints and existing PR matching',()=>{
  const all=chooseAI(cfg,event('/ai-fix --ai all'),env);
  assert.notEqual(fingerprint({number:1},'a'.repeat(40),cfg),fingerprint({number:1},'a'.repeat(40),all));
  const pr={body:'Header\n'+selectionMarker(all)};
  assert.equal(sameAI(pr,all),true);assert.equal(sameAI(pr,cfg),false);assert.equal(sameAI({body:'legacy'},all),false);
});
