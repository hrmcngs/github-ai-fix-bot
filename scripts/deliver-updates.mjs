// Source-side publisher only. Never distributed to installed repositories.
import {createPrivateKey,createSign,createHash} from 'node:crypto';
import {readFile,appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {GitHub,responseWithRetry,temporaryStatus} from '../.github/ai-bot/src/github.js';
import {SafeError,number} from '../.github/ai-bot/src/core.js';
import {SOURCE,STATE,Upstream,installation,release,scopedRelease,updateFiles} from '../.github/ai-bot/src/updates.js';
import {createLinkedProposal} from '../.github/ai-bot/src/proposals.js';
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const repoName=value=>typeof value==='string'&&/^[\w.-]+\/[\w.-]+$/.test(value)&&value.split('/').every(part=>part!=='.'&&part!=='..');
const hash=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

export function appJwt(appId,key,now=Math.floor(Date.now()/1000)){
  if(!/^[1-9]\d{0,14}$/.test(String(appId))||typeof key!=='string'||key.length>32000)throw new SafeError('APP_SETUP');
  try{
    const privateKey=createPrivateKey(key);
    if(privateKey.asymmetricKeyType!=='rsa'||privateKey.asymmetricKeyDetails?.modulusLength<2048)throw new Error();
    const encode=data=>Buffer.from(JSON.stringify(data)).toString('base64url');
    const payload=encode({alg:'RS256',typ:'JWT'})+'.'+encode({iat:now-60,exp:now+540,iss:String(appId)});
    return payload+'.'+createSign('RSA-SHA256').update(payload).sign(privateKey,'base64url');
  }catch{throw new SafeError('APP_SETUP');}
}
export class DeliveryApp{
  constructor(id,key,fetcher=fetch){this.id=id;this.key=key;this.fetcher=fetcher;}
  async request(tail,method='GET',token,body){
    const allowed=method==='GET'&&/^\/(?:app|app\/installations\?per_page=100&page=(?:[1-9]|10|11)|installation\/repositories\?per_page=100&page=(?:[1-9]|10|11))$/.test(tail)
      ||method==='POST'&&/^\/app\/installations\/[1-9]\d{0,14}\/access_tokens$/.test(tail)||method==='DELETE'&&tail==='/installation/token';
    if(!allowed)throw new SafeError('ACCESS');
    try{
      const response=await responseWithRetry(this.fetcher,'https://api.github.com'+tail,{method,headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'github-ai-fix-bot-delivery',Authorization:'Bearer '+(token||appJwt(this.id,this.key)),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error'});
      if(!response.ok){await response.body?.cancel();throw new SafeError(response.status===401?'APP_AUTH':response.status===403?'APP_PERMISSIONS':response.status===429?'APP_LIMIT':temporaryStatus(response.status)?'API_UNAVAILABLE':'ACCESS');}
      if(response.status===204)return null;
      const chunks=[];let size=0;
      for await(const chunk of response.body){size+=chunk.length;if(size>2000000)throw new SafeError('APP_LIMIT');chunks.push(chunk);}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch(error){throw error instanceof SafeError?error:new SafeError('APP_NETWORK');}
  }
  async pages(path,select,token){
    const all=[];
    for(let page=1;page<=11;page++){
      const rows=select(await this.request(`${path}?per_page=100&page=${page}`,'GET',token));
      if(!Array.isArray(rows)||rows.length>100)throw new SafeError('APP_LIMIT');
      all.push(...rows);if(all.length>1000)throw new SafeError('APP_LIMIT');
      if(rows.length<100)return all;
    }
    throw new SafeError('APP_LIMIT');
  }
  async token(installationId,permissions,repositoryId){
    const body={permissions,...(repositoryId?{repository_ids:[number(repositoryId)]}:{})};
    const result=await this.request(`/app/installations/${number(installationId)}/access_tokens`,'POST',undefined,body);
    if(typeof result.token!=='string'||!result.token||result.token.length>16384)throw new SafeError('APP_AUTH');
    return result.token;
  }
  async revoke(token){await this.request('/installation/token','DELETE',token);}
  async targets(){
    const info=await this.request('/app');
    if(String(info.id)!==String(this.id)||typeof info.slug!=='string'||!/^[a-z0-9][a-z0-9-]{0,99}$/.test(info.slug))throw new SafeError('APP_AUTH');
    const installations=await this.pages('/app/installations',data=>data),targets=[],seen=new Set();
    for(const item of installations){
      if(item.suspended_at)continue;
      if(String(item.app_id)!==String(this.id))throw new SafeError('APP_AUTH');
      const id=number(item.id),token=await this.token(id,{contents:'read'});
      try{
        const repos=await this.pages('/installation/repositories',data=>data.repositories,token);
        for(const repo of repos){
          if(!repoName(repo.full_name))throw new SafeError('APP_AUTH');
          number(repo.id);
          if(repo.full_name.toLowerCase()===SOURCE.toLowerCase()||repo.archived||repo.disabled||seen.has(repo.id))continue;
          seen.add(repo.id);targets.push({id:repo.id,name:repo.full_name,installation:id});
          if(targets.length>1000)throw new SafeError('APP_LIMIT');
        }
      }finally{await this.revoke(token);}
    }
    return{login:info.slug+'[bot]',targets};
  }
}
export async function authorizeDelivery(gh,event,env){
  if(gh.repo!==SOURCE||env.GITHUB_REPOSITORY!==SOURCE||event.repository?.full_name!==SOURCE||env.GITHUB_EVENT_NAME!=='push'||event.deleted||!sha(env.GITHUB_SHA)||event.after!==env.GITHUB_SHA)throw new SafeError('ACCESS');
  const meta=await gh.request(gh.path());
  if(event.ref!==env.GITHUB_REF||env.GITHUB_REF!==`refs/heads/${meta.default_branch}`)throw new SafeError('ACCESS');
  return(await gh.request(gh.path(`/git/ref/heads/${encodeURIComponent(meta.default_branch)}`))).object?.sha===env.GITHUB_SHA;
}
export async function remoteInstallation(gh,base){
  const data=await gh.request(gh.path(`/git/trees/${base}?recursive=1`));
  if(data.truncated||!Array.isArray(data.tree))throw new SafeError('UPDATE_STATE');
  const entry=data.tree.find(row=>row.path===STATE);if(!entry)return null;
  for(const parent of ['.github','.github/ai-bot']){
    const row=data.tree.find(file=>file.path===parent);if(row?.type!=='tree'||row.mode!=='040000')throw new SafeError('UPDATE_STATE');
  }
  if(entry.type!=='blob'||entry.mode!=='100644'||!sha(entry.sha)||entry.size>64000)throw new SafeError('UPDATE_STATE');
  const result=await gh.request(gh.path(`/git/blobs/${entry.sha}`));
  if(result.encoding!=='base64'||typeof result.content!=='string')throw new SafeError('UPDATE_STATE');
  const bytes=Buffer.from(result.content,'base64');
  if(bytes.length>64000||hash(bytes)!==entry.sha||!Buffer.from(bytes.toString('utf8')).equals(bytes))throw new SafeError('UPDATE_STATE');
  try{return installation(JSON.parse(bytes.toString('utf8')));}catch{throw new SafeError('UPDATE_STATE');}
}
function matchingProposal(pr,repo,branch,commit,scope,appLogin){
  const own=pr.user?.type==='Bot'&&[appLogin,'github-actions[bot]'].includes(pr.user?.login);
  const runtime=`<!-- ai-bot-update-pr:${commit}:runtime -->\n`,full=`<!-- ai-bot-update-pr:${commit} -->\n`;
  const matching=pr.body?.startsWith(full)||(pr.body?.startsWith(runtime)&&(scope==='runtime'||pr.body.startsWith(runtime+'<!-- ai-bot-app-scope:full -->\n')));
  return own&&matching&&pr.head?.repo?.full_name===repo&&pr.base?.repo?.full_name===repo&&pr.base.ref===branch&&/^ai-update\/(?:bot|issue-[1-9]\d*)-[a-f0-9]{12}-[1-9]\d*$/.test(pr.head.ref||'');
}
export async function deliverOne(gh,source,latest,{scope,runId,appLogin,beforeWrite}){
  if(!['runtime','full'].includes(scope)||!sha(latest.commit)||!repoName(gh.repo)||gh.repo.toLowerCase()===SOURCE.toLowerCase())throw new SafeError('ACCESS');
  const meta=await gh.request(gh.path());
  if(meta.full_name!==gh.repo||meta.archived||meta.disabled)return 'skipped';
  const branch=meta.default_branch;if(typeof branch!=='string'||!branch||branch.length>255)throw new SafeError('ACCESS');
  const refPath=gh.path(`/git/ref/heads/${encodeURIComponent(branch)}`),base=(await gh.request(refPath)).object?.sha;
  if(!sha(base))throw new SafeError('ACCESS');
  const state=await remoteInstallation(gh,base);if(!state)return 'not-installed';
  const next=scopedRelease(latest,state,scope);
  if(JSON.stringify(Object.entries(state.files).sort())===JSON.stringify(Object.entries(next.files).sort()))return 'unchanged';
  const prior=(await gh.list(gh.path('/pulls?state=all'))).filter(pr=>matchingProposal(pr,gh.repo,branch,next.commit,scope,appLogin));
  if(prior.some(pr=>pr.state==='open'))return 'existing';
  if(prior.some(pr=>pr.state==='closed'))return 'closed';
  const files=await updateFiles(gh,state,next,source,base);
  await beforeWrite();
  const fresh=await gh.request(gh.path());
  if(fresh.default_branch!==branch||fresh.archived||fresh.disabled||(await gh.request(refPath)).object?.sha!==base)throw new SafeError('STALE');
  // Legacy runtime pollers must reuse a full App proposal rather than opening a
  // second PR. The next line records its actual, potentially broader scope.
  const marker=`<!-- ai-bot-update-pr:${next.commit}:runtime -->\n<!-- ai-bot-app-scope:${scope} -->`;
  const id=createHash('sha256').update(next.commit+':app:'+scope).digest('hex');
  await createLinkedProposal(gh,{kind:'update',runId,sha:base,id,base:branch,title:scope==='full'?'chore: update GitHub AI Bot':'chore: update GitHub AI Bot runtime',body:`${marker}\n\nBot本体のmainへのpushを受け、GitHub Appが自動作成しました。AI使用: なし。\n\n[配布元の変更](https://github.com/${SOURCE}/compare/${state.commit}...${next.commit})\n\n更新範囲: ${scope==='full'?'Bot本体と配布対象のActions定義':'Bot本体のみ'}。config.jsonとAPIキーは保持します。独自の変更は上書きしません。\n\n配布対象・導入記録・Git blobハッシュ・元ブランチを照合しています。上流コードやインストーラーは実行していません。人間による差分・CIのレビューが必要です。自動マージは行いません。`,files,notify:async()=>{}});
  return 'created';
}
export async function deliverUpdates(event,env=process.env,{app,sourceGH,upstream=new Upstream(),github}={}){
  sourceGH??=new GitHub(SOURCE,env.GH_TOKEN);
  if(!await authorizeDelivery(sourceGH,event,env))return{superseded:1};
  const scope=env.AI_BOT_DELIVERY_SCOPE||'full';if(!['runtime','full'].includes(scope))throw new SafeError('CONFIG');
  const runId=number(env.GITHUB_RUN_ID);
  app??=new DeliveryApp(env.AI_BOT_APP_ID,env.AI_BOT_APP_PRIVATE_KEY);
  const {login,targets}=await app.targets();
  const latest=await release(upstream,env.GITHUB_SHA),stats={created:0,existing:0,closed:0,unchanged:0,'not-installed':0,skipped:0,failed:0};
  for(const target of targets){
    let token;
    try{
      if(!await authorizeDelivery(sourceGH,event,env)){stats.superseded=1;break;}
      token=await app.token(target.installation,{contents:'write',pull_requests:'write',...(scope==='full'?{workflows:'write'}:{})},target.id);
      const gh=github?github(target.name,token):new GitHub(target.name,token,app.fetcher);
      const status=await deliverOne(gh,upstream,latest,{scope,runId,appLogin:login,beforeWrite:async()=>{if(!await authorizeDelivery(sourceGH,event,env))throw new SafeError('STALE');}});
      stats[status]++;
    }catch(error){stats.failed++;const code=['UPDATE_CONFLICT','UPDATE_STATE','PR','STALE','APP_AUTH','APP_PERMISSIONS','APP_NETWORK','APP_LIMIT','ACCESS','API_UNAVAILABLE'].includes(error.code)?error.code:'INTERNAL';stats[code]=(stats[code]||0)+1;}
    finally{if(token)try{await app.revoke(token);}catch{stats.failed++;stats.APP_REVOKE=(stats.APP_REVOKE||0)+1;}}
  }
  // Public source logs never include private destination names, URLs or tokens.
  return stats;
}
export function deliveryError(error){
  return({APP_SETUP:'GitHub Appの初期設定が必要です。本体のSettings → Secrets and variables → Actionsで、Variable AI_BOT_APP_IDとSecret AI_BOT_APP_PRIVATE_KEYを登録してください。手順: https://github.com/'+SOURCE+'/blob/main/docs/push-updates.md',APP_AUTH:'GitHub AppのID・秘密鍵・有効期限を確認してください。秘密鍵はログやコメントへ貼らないでください。',APP_PERMISSIONS:'GitHub Appの導入対象とContents / Pull requestsのRead and write権限を確認してください。full配信にはWorkflowsのRead and writeも必要です。',APP_LIMIT:'配信対象数またはGitHub APIの上限に達したため停止しました。',APP_NETWORK:'GitHub AppのAPI通信に失敗しました。',ACCESS:'配信元のイベント・ブランチ、またはGitHub権限を確認してください。',CONFIG:'配信範囲はfullまたはruntimeを指定してください。',UPDATE_SOURCE:'配布元の取得・形式・ハッシュの検証に失敗しました。'})[error?.code]||'Bot更新の自動配信に失敗しました。設定・GitHub権限・配布対象を確認してください。';
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const bytes=await readFile(process.env.GITHUB_EVENT_PATH);if(bytes.length>2000000)throw new SafeError('ACCESS');
    const stats=await deliverUpdates(JSON.parse(bytes.toString('utf8')));
    const text='Bot更新の自動配信結果（AI使用なし）: '+JSON.stringify(stats)+'\n導入先のPull requestsを確認してください。非公開リポジトリの名前・URLはここに表示しません。';
    console.log(text);if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,text+'\n');if(stats.failed)process.exitCode=1;
  }catch(error){const text=deliveryError(error);console.error(text);if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,text+'\n').catch(()=>{});process.exitCode=1;}
}
