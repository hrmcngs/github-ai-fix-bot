// Read-only delivery smoke test: no repository token or AI API is used.
import {Upstream,release} from '../.github/ai-bot/src/updates.js';
const source=new Upstream(async(url,options)=>{
  const response=await fetch(url,options);
  console.log(JSON.stringify({status:response.status,remaining:response.headers.get('x-ratelimit-remaining'),route:new URL(url).pathname.split('/').slice(-2,-1)[0]}));
  return response;
});
const result=await release(source);
console.log(JSON.stringify({commit:result.commit,files:Object.keys(result.files).length}));
