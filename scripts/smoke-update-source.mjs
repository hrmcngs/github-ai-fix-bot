// Read-only delivery smoke test: no repository token or AI API is used.
import {Upstream,release} from '../.github/ai-bot/src/updates.js';
import assert from 'node:assert/strict';
const source=new Upstream(async(url,options)=>{
  const response=await fetch(url,options);
  console.log(JSON.stringify({status:response.status,remaining:response.headers.get('x-ratelimit-remaining'),route:new URL(url).pathname.split('/').slice(-2,-1)[0]}));
  return response;
});
const result=await release(source);
console.log(JSON.stringify({commit:result.commit,files:Object.keys(result.files).length}));
// Exercise the real Git fallback even on runners whose REST quota is available.
const fallback=new Upstream(async()=>new Response('{}',{status:429}));
const same=await release(fallback,result.commit);
assert.equal(same.commit,result.commit);
assert.deepEqual(same.files,result.files);
