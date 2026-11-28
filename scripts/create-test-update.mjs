import {createHash} from 'node:crypto';
import {readFile,appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {GitHub,botOwned} from '../.github/ai-bot/src/github.js';
import {SafeError,number} from '../.github/ai-bot/src/core.js';
import {SOURCE} from '../.github/ai-bot/src/updates.js';
import {createLinkedProposal,proposalLink} from '../.github/ai-bot/src/proposals.js';

const path='.github/ai-bot/src/guidance.js',marker='<!-- ai-bot-test-update:v1 -->';
const hash=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
export function testUpdateContent(text,run){
  number(run);
  const lines=text.split('\n'),prefix='// Runtime update delivery smoke marker: ';
  const indices=lines.flatMap((line,i)=>line.startsWith(prefix)?[i]:[]);
  if(indices.length!==1||!/^\/\/ Runtime update delivery smoke marker: [\w.-]+\.$/.test(lines[indices[0]]))throw new SafeError('OUTPUT');
  lines[indices[0]]=`${prefix}run-${run}.`;
  return lines.join('\n');
}
export async function createTestUpdate(gh,event,env){
  if(gh.repo!==SOURCE||env.GITHUB_REPOSITORY!==SOURCE||event.repository?.full_name!==SOURCE||env.GITHUB_EVENT_NAME!=='workflow_dispatch')throw new SafeError('ACCESS');
  number(env.GITHUB_RUN_ID);
  const repo=await gh.request(gh.path());
  if(env.GITHUB_REF!==`refs/heads/${repo.default_branch}`)throw new SafeError('ACCESS');
  const authorize=async()=>{
    const role=await gh.request(gh.path(`/collaborators/${encodeURIComponent(env.GITHUB_ACTOR)}/permission`));
    if(!['admin','maintain','write'].includes(role.permission))throw new SafeError('ACCESS');
  };
  await authorize();
  const existing=(await gh.list(gh.path('/pulls?state=open'))).find(pr=>botOwned(pr)&&pr.body?.startsWith(marker+'\n')&&pr.head?.repo?.full_name===SOURCE&&pr.base?.repo?.full_name===SOURCE&&pr.base.ref===repo.default_branch&&/^ai-update\/bot-[a-f0-9]{12}-[1-9]\d*$/.test(pr.head.ref||''));
  if(existing)return existing;
  const refPath=gh.path(`/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
  const base=(await gh.request(refPath)).object?.sha;
  if(!/^[a-f0-9]{40}$/.test(base||'')||base!==env.GITHUB_SHA)throw new SafeError('STALE');
  const tree=await gh.request(gh.path(`/git/trees/${base}?recursive=1`));
  if(tree.truncated||!Array.isArray(tree.tree))throw new SafeError('OUTPUT');
  for(const parent of ['.github','.github/ai-bot','.github/ai-bot/src']){
    const entry=tree.tree.find(row=>row.path===parent);
    if(entry?.type!=='tree'||entry.mode!=='040000')throw new SafeError('OUTPUT');
  }
  const entry=tree.tree.find(row=>row.path===path);
  if(entry?.type!=='blob'||entry.mode!=='100644'||entry.size>128000||!/^[a-f0-9]{40}$/.test(entry.sha||''))throw new SafeError('OUTPUT');
  const data=await gh.request(gh.path(`/git/blobs/${entry.sha}`));
  if(data.encoding!=='base64'||typeof data.content!=='string')throw new SafeError('OUTPUT');
  const bytes=Buffer.from(data.content,'base64');
  if(bytes.length>128000||hash(bytes)!==entry.sha||!Buffer.from(bytes.toString('utf8')).equals(bytes))throw new SafeError('OUTPUT');
  const content=testUpdateContent(bytes.toString('utf8'),env.GITHUB_RUN_ID);
  if(content===bytes.toString('utf8'))throw new SafeError('STALE');
  await authorize();
  if((await gh.request(refPath)).object?.sha!==base)throw new SafeError('STALE');
  return createLinkedProposal(gh,{kind:'update',runId:env.GITHUB_RUN_ID,sha:base,id:createHash('sha256').update('test-update:'+env.GITHUB_RUN_ID).digest('hex'),base:repo.default_branch,
    title:'test: Bot自動更新の配送テスト',body:`${marker}\n\nBot本体のコメント1行だけを変更するテスト更新です。AI API・追加トークンは使用していません。\n\nこのPRをレビューしてマージすると、導入先の定期更新確認で更新PRが作成されます。即時配送ではありません。Botの動作・AIへの指示は変更しません。自動マージは行いません。`,files:[{path,content}],notify:async()=>{}});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const env=process.env,event=JSON.parse(await readFile(env.GITHUB_EVENT_PATH,'utf8'));
    const pr=await createTestUpdate(new GitHub(env.GITHUB_REPOSITORY,env.GH_TOKEN),event,env);
    const text=`テスト更新: ${proposalLink({repo:SOURCE},pr.number)}。レビューしてマージすると導入先への配送を試せます。AI使用なし。`;
    console.log(text);if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,text+'\n');
  }catch{console.error('テスト更新PRを作成できませんでした。Bot本体のデフォルトブランチ・実行権限・ActionsのPR作成許可を確認してください。');process.exitCode=1;}
}
