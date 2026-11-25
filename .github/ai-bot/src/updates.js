import {readFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {GitHub,botOwned} from './github.js';
import {SafeError,number} from './core.js';
import {isCommand,requireCommand} from './commands.js';
import {createLinkedProposal,proposalLink} from './proposals.js';
export const SOURCE='hrmcngs/github-ai-fix-bot';
export const STATE='.github/ai-bot/installation.json';
export const MANIFEST='.github/ai-bot/distribution.json';
export const UPDATE_MARKER='<!-- ai-bot-update:v1 -->';
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
export function managedPath(path){
  return typeof path==='string'&&(/^\.github\/ai-bot\/(?:src\/[a-z][a-z-]*\.js|Dockerfile(?:\.verify)?|package\.json|config\.json|distribution\.json|\.dockerignore)$/.test(path)
    ||/^\.github\/workflows\/[a-z][a-z-]*\.yml$/.test(path));
}
export function manifest(data){
  if(data?.version!==1||!Array.isArray(data.files)||data.files.length<1||data.files.length>60
    ||new Set(data.files).size!==data.files.length||data.files.some(path=>!managedPath(path))||!data.files.includes(MANIFEST))throw new SafeError('UPDATE_SOURCE');
  return data.files;
}
export function installation(data){
  if(data?.version!==1||data.source!==SOURCE||!sha(data.commit)||!data.files||typeof data.files!=='object'||Array.isArray(data.files)
    ||Object.keys(data.files).length>60||Object.entries(data.files).some(([path,hash])=>!managedPath(path)||!sha(hash)))throw new SafeError('UPDATE_STATE');
  return data;
}
// Anonymous access to one fixed public upstream. The destination token is never sent upstream.
export class Upstream{
  constructor(fetcher=fetch){this.fetcher=fetcher;}
  async request(tail){
    if(!/^\/(?:commits\/main|git\/trees\/[a-f0-9]{40}\?recursive=1|git\/blobs\/[a-f0-9]{40})$/.test(tail))throw new SafeError('UPDATE_SOURCE');
    try{
      const res=await this.fetcher(`https://api.github.com/repos/${SOURCE}${tail}`,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},redirect:'error',signal:AbortSignal.timeout(30000)});
      if(!res.ok){await res.body?.cancel();throw new Error();}
      const length=Number(res.headers.get('content-length')||0);if(length>3000000)throw new Error();
      const chunks=[];let used=0;
      for await(const chunk of res.body){used+=chunk.length;if(used>3000000)throw new Error();chunks.push(chunk);}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch{throw new SafeError('UPDATE_SOURCE');}
  }
}
function treeMap(data){
  if(data.truncated||!Array.isArray(data.tree))throw new SafeError('UPDATE_SOURCE');
  return new Map(data.tree.map(file=>[file.path,file]));
}
async function blob(source,entry){
  if(entry?.type!=='blob'||entry.mode!=='100644'||!sha(entry.sha)||entry.size>128000)throw new SafeError('UPDATE_SOURCE');
  const data=await source.request(`/git/blobs/${entry.sha}`);
  if(data.encoding!=='base64'||typeof data.content!=='string')throw new SafeError('UPDATE_SOURCE');
  const bytes=Buffer.from(data.content,'base64');
  if(bytes.length>128000||bytes.includes(0)||!Buffer.from(bytes.toString('utf8')).equals(bytes)||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==entry.sha)throw new SafeError('UPDATE_SOURCE');
  return bytes.toString('utf8');
}
export async function release(source,commit){
  const target=commit||(await source.request('/commits/main')).sha;
  if(!sha(target))throw new SafeError('UPDATE_SOURCE');
  const tree=treeMap(await source.request(`/git/trees/${target}?recursive=1`));
  const paths=manifest(JSON.parse(await blob(source,tree.get(MANIFEST))));
  const files={};let total=0;
  for(const path of paths){
    const entry=tree.get(path);
    if(entry?.type!=='blob'||entry.mode!=='100644'||!sha(entry.sha)||entry.size>128000)throw new SafeError('UPDATE_SOURCE');
    total+=Number(entry.size||0);if(total>1000000)throw new SafeError('UPDATE_SOURCE');
    if(path!=='.github/ai-bot/config.json')files[path]=entry.sha;
  }
  return{commit:target,files,tree};
}
const targetMarker=commit=>`<!-- ai-bot-update-target:${commit} -->`;
export function updateTarget(issue){
  const found=issue.body?.split('\n')[1]?.match(/^<!-- ai-bot-update-target:([a-f0-9]{40}) -->$/);
  if(!botOwned(issue)||issue.pull_request||issue.state!=='open'||!issue.body?.startsWith(UPDATE_MARKER+'\n')||!found)throw new SafeError('ACCESS');
  return found[1];
}
export async function checkUpdate(gh,state,source=new Upstream()){
  installation(state);
  if(gh.repo===SOURCE)return;
  const latest=await release(source);
  if(JSON.stringify(Object.entries(state.files).sort())===JSON.stringify(Object.entries(latest.files).sort()))return;
  const issues=(await gh.list(gh.path('/issues?state=all&sort=created&direction=desc'))).filter(issue=>!issue.pull_request&&botOwned(issue)&&issue.body?.startsWith(UPDATE_MARKER+'\n'));
  if(issues.some(issue=>issue.body.split('\n')[1]===targetMarker(latest.commit)))return;
  const body=`${UPDATE_MARKER}\n${targetMarker(latest.commit)}\n## Botをアップデートしますか？\n\n新しいBotの更新があります。\n\n[変更内容を確認](https://github.com/${SOURCE}/compare/${state.commit}...${latest.commit})\n\n- 更新する: write以上の利用者がこのIssueに \`/ai-update\` とコメントしてください。更新PRを作成します。\n- 見送る: このIssueを閉じてください。同じ版は再通知しません。\n\n設定ファイル・APIキーは保持します。ローカルで変更されたBotファイルは上書きせず停止します。更新PRの差分・CIを確認してから人間がマージしてください。\n\n更新PRにはSecret \`AI_BOT_UPDATE_TOKEN\` が必要です。導入先だけのContents・Pull requests・Workflowsのwrite権限を持つトークンをActions Secretsに登録してください。Issueやコメントには貼らないでください。`;
  const open=issues.find(issue=>issue.state==='open');
  if(open)await gh.request(gh.path(`/issues/${number(open.number)}`),'PATCH',{title:'Botをアップデートしますか？',body});
  else await gh.request(gh.path('/issues'),'POST',{title:'Botをアップデートしますか？',body});
}
export async function authorizeUpdate(gh,event,env){
  if(!isCommand(event,env,'/ai-update'))return;
  const repo=await gh.request(gh.path());
  if(event.repository?.full_name!==gh.repo||env.GITHUB_REF!==`refs/heads/${repo.default_branch}`)throw new SafeError('ACCESS');
  const role=await gh.request(gh.path(`/collaborators/${encodeURIComponent(env.GITHUB_ACTOR)}/permission`));
  if(!['admin','maintain','write'].includes(role.permission))throw new SafeError('ACCESS');
  const n=await requireCommand(gh,event,env,'/ai-update');
  const approved=updateTarget(event.issue),current=updateTarget(await gh.request(gh.path(`/issues/${n}`)));
  if(approved!==current)throw new SafeError('STALE');
  return{number:n,commit:current,branch:repo.default_branch};
}
export async function updateFiles(gh,state,latest,source,baseSha){
  const tree=treeMap(await gh.request(gh.path(`/git/trees/${baseSha}?recursive=1`)));
  const changes=[];
  const paths=new Set([...Object.keys(state.files),...Object.keys(latest.files)]);
  for(const path of paths){
    if(path==='.github/ai-bot/config.json')continue;
    if(!managedPath(path))throw new SafeError('UPDATE_STATE');
    for(const parent of [STATE,path].flatMap(path=>{const parts=path.split('/');return parts.slice(0,-1).map((_,i)=>parts.slice(0,i+1).join('/'));})){
      const entry=tree.get(parent);if(entry&&(entry.type!=='tree'||entry.mode!=='040000'))throw new SafeError('UPDATE_CONFLICT');
    }
    const current=tree.get(path),installed=state.files[path],next=latest.files[path];
    if(current&&(current.type!=='blob'||current.mode!=='100644'))throw new SafeError('UPDATE_CONFLICT');
    if(!installed&&current)throw new SafeError('UPDATE_CONFLICT');
    if(current?.sha===next&&next)continue;
    if((installed&&current?.sha!==installed)||(!installed&&current))throw new SafeError('UPDATE_CONFLICT');
    if(!next){if(current)changes.push({path,sha:null});continue;}
    changes.push({path,content:await blob(source,latest.tree.get(path))});
  }
  if(tree.get(STATE)?.mode!=='100644')throw new SafeError('UPDATE_CONFLICT');
  changes.push({path:STATE,content:JSON.stringify({version:1,source:SOURCE,commit:latest.commit,files:latest.files},null,2)+'\n'});
  return changes;
}
export async function applyUpdate(gh,writer,event,env,state,source=new Upstream()){
  installation(state);
  const auth=await authorizeUpdate(gh,event,env);if(!auth)throw new SafeError('ACCESS');
  const notify=body=>gh.request(gh.path(`/issues/${auth.number}/comments`),'POST',{body});
  if(!writer){await notify('更新PRにはActions Secret `AI_BOT_UPDATE_TOKEN` が必要です。導入先だけのContents・Pull requests・Workflowsのwrite権限を設定し、新しい `/ai-update` コメントで再実行してください。キーはコメントに貼らないでください。');throw new SafeError('UPDATE_TOKEN');}
  const marker=`<!-- ai-bot-update-pr:${auth.commit} -->`;
  const existing=(await gh.list(gh.path('/pulls?state=open'))).find(pr=>pr.body?.startsWith(marker+'\n')&&pr.head?.repo?.full_name===gh.repo&&pr.base?.repo?.full_name===gh.repo&&pr.base.ref===auth.branch&&pr.head.ref?.startsWith(`ai-update/issue-${auth.number}-`));
  if(existing){await notify(`更新PRは ${proposalLink(gh,existing.number)} です。レビューしてからマージしてください。`);return;}
  const latest=await release(source,auth.commit);
  const ref=await gh.request(gh.path(`/git/ref/heads/${encodeURIComponent(auth.branch)}`));
  const base=ref.object?.sha;if(!sha(base))throw new SafeError('ACCESS');
  if(env.GITHUB_SHA&&env.GITHUB_SHA!==base)throw new SafeError('STALE');
  const files=await updateFiles(gh,state,latest,source,base);
  const fresh=await authorizeUpdate(gh,event,env);
  const freshRef=await gh.request(gh.path(`/git/ref/heads/${encodeURIComponent(auth.branch)}`));
  if(fresh.commit!==auth.commit||freshRef.object?.sha!==base)throw new SafeError('STALE');
  const id=createHash('sha256').update(auth.commit).digest('hex');
  await createLinkedProposal(writer,{kind:'update',issue:auth.number,runId:env.GITHUB_RUN_ID,sha:base,id,base:auth.branch,title:'chore: update GitHub AI Bot',body:`${marker}\nRefs #${auth.number}\n\n[配布元の変更](https://github.com/${SOURCE}/compare/${state.commit}...${auth.commit})\n\nBot専用ファイルを更新します。設定とAPIキーは保持します。取得ファイルのGit blobハッシュと導入済みファイルの一致を検査しました。上流コード・コマンド・インストーラーは実行していません。更新PRの差分とCIを人間がレビューしてください。自動マージは行いません。`,files,notify:pr=>notify(`更新PRを ${proposalLink(gh,pr.number)} に作成しました。差分とCIを確認してからマージしてください。`)});
}
export async function loadInstallation(gh,event,env,action){
  const auth=action==='apply'?await authorizeUpdate(gh,event,env):null;
  if(action==='apply'&&!auth)throw new SafeError('ACCESS');
  try{return installation(JSON.parse(await readFile(STATE,'utf8')));}catch{
    const text='導入記録がないか破損しています。新しいインストーラーで導入・移行し、差分を確認してから再実行してください。自動上書きはしていません。';
    if(auth){
      await gh.request(gh.path(`/issues/${auth.number}/comments`),'POST',{body:text});
      throw new SafeError('UPDATE_STATE');
    }
    console.log(text);return null;
  }
}
export async function updates(env=process.env){
  const gh=new GitHub(env.GITHUB_REPOSITORY,env.GH_TOKEN);
  const event=JSON.parse(await readFile(env.GITHUB_EVENT_PATH,'utf8'));
  const repo=await gh.request(gh.path());
  if(event.repository?.full_name!==gh.repo||env.GITHUB_REF!==`refs/heads/${repo.default_branch}`)throw new SafeError('ACCESS');
  if(gh.repo===SOURCE)return;
  const action=process.argv[2];
  if(action==='authorize'){
    if(await authorizeUpdate(gh,event,env))if(env.GITHUB_OUTPUT)await appendFile(env.GITHUB_OUTPUT,'ready=true\n');
    return;
  }
  const state=await loadInstallation(gh,event,env,action);if(!state)return;
  if(action==='check'){
    if(!['schedule','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME))throw new SafeError('ACCESS');
    await checkUpdate(gh,state);
  }else if(action==='apply'){
    const writer=env.AI_BOT_UPDATE_TOKEN?new GitHub(gh.repo,env.AI_BOT_UPDATE_TOKEN):null;
    try{await applyUpdate(gh,writer,event,env,state);}catch(error){
      if(error.code==='NOTIFY')throw error;
      if(error.code!=='UPDATE_TOKEN')await gh.request(gh.path(`/issues/${number(event.issue?.number)}/comments`),'POST',{body:error.code==='STALE'?'確認中にIssueまたはデフォルトブランチが更新されました。変更内容を確認して、新しい `/ai-update` コメントで再実行してください。':error.code==='UPDATE_CONFLICT'?'Botファイルに独自の変更または保存先の競合があります。上書きせず停止しました。差分を確認して手動で更新してください。':'更新PRを作成できませんでした。トークンの権限と配布元へのアクセスを確認してください。ファイルを直接上書きしていません。'});
      throw error;
    }
  }else throw new SafeError('CONFIG');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await updates();}catch{console.error('Botの更新確認・更新PR作成に失敗しました。設定とGitHub権限を確認してください。');process.exitCode=1;}
}
