import test from 'node:test';
import assert from 'node:assert/strict';
import {GitHub,responseWithRetry} from '../.github/ai-bot/src/github.js';
import {Upstream,updateError} from '../.github/ai-bot/src/updates.js';
test('temporary read failures retry with bounded delays and fresh timeout signals',async()=>{
  const calls=[],delays=[];let i=0;
  const result=await responseWithRetry(async(url,options)=>{calls.push(options);return new Response(i++<2?'unavailable':'{}',{status:i<=2?503:200});},'https://example.invalid',{method:'GET'},async ms=>delays.push(ms));
  assert.equal(result.status,200);assert.equal(calls.length,3);assert.deepEqual(delays,[500,1000]);assert.notEqual(calls[0].signal,calls[1].signal);
});
test('authorization failures and all mutations are never retried',async()=>{
  for(const [method,status]of [['GET',403],['GET',404],['POST',500],['PATCH',503],['DELETE',504]]){
    let calls=0;const res=await responseWithRetry(async()=>{calls++;return new Response('{}',{status});},'https://example.invalid',{method},async()=>assert.fail('No delay expected'));
    assert.equal(res.status,status);assert.equal(calls,1);
  }
});
test('GitHub requests recover a transient read and classify repeated server errors safely',async()=>{
  let calls=0;const gh=new GitHub('a/b','dummy-token',async()=>new Response('{}',{status:++calls===1?502:200}));
  await gh.request(gh.path());assert.equal(calls,2);
  const unavailable=new GitHub('a/b','dummy-token',async()=>new Response('sensitive-server-response',{status:500}));
  await assert.rejects(unavailable.request(unavailable.path()),e=>e.code==='API_UNAVAILABLE'&&!updateError(e).includes('sensitive'));
});
test('public-source reads also retry without receiving destination credentials',async()=>{
  let calls=0;const upstream=new Upstream(async(url,options)=>{
    assert.equal(options.headers.Authorization,undefined);calls++;
    return new Response(calls===1?'unavailable':JSON.stringify({sha:'a'.repeat(40)}),{status:calls===1?504:200});
  });
  assert.equal((await upstream.request('/commits/main')).sha,'a'.repeat(40));assert.equal(calls,2);
});
