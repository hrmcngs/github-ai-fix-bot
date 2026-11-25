import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {mergeConfig,botProposal,protectedPolicy,considerMerge,enableNativeMerge,protection} from '../.github/ai-bot/src/auto-merge.js';
import {revisionMarker} from '../.github/ai-bot/src/proposal-state.js';
const issue={number:1,state:'open',title:'Fix',body:'Fix addition'};
const cfg=JSON.parse(await readFile(new URL('../.github/ai-bot/config.json',import.meta.url)));
const sha='a'.repeat(40),base='b'.repeat(40);
function pr(){return{number:2,state:'open',draft:false,merged:false,mergeable:true,mergeable_state:'clean',user:{type:'Bot',login:'github-actions[bot]'},body:`<!-- ai-fix:issue:1 -->\n${revisionMarker(issue)}\nCloses #1`,labels:[{name:'ai-auto-merge'}],head:{ref:'ai-fix/issue-1-0123456789ab-123',sha,repo:{full_name:'a/b'}},base:{ref:'main',sha:base,repo:{full_name:'a/b'}}};}
function state(){return{head:sha,decision:'APPROVED',rule:{requiresApprovingReviews:true,requiredApprovingReviewCount:1,dismissesStaleReviews:true,requiresStatusChecks:true,requiresStrictStatusChecks:true,isAdminEnforced:true,requiredStatusCheckContexts:cfg.autoMerge.requiredChecks}};}
function fixture({pull=pr(),fresh=pull,repo={},reviews,files,check,run={}}={}){
  const calls=[];let reads=0;
  const gh={repo:'a/b',token:'dummy-github-token',path:(tail='')=>`/repos/a/b${tail}`,calls,request:async(path)=>{
    calls.push(path);
    if(path==='/repos/a/b')return{default_branch:'main',allow_auto_merge:true,allow_squash_merge:true,...repo};
    if(path==='/repos/a/b/issues/1')return issue;
    if(path==='/repos/a/b/pulls/2')return++reads===1?pull:fresh;
    if(path.includes('/permission'))return{permission:'write'};
    if(path.includes('/check-runs?'))return{check_runs:cfg.autoMerge.requiredChecks.map((name,i)=>({id:i+1,name,head_sha:sha,app:{slug:'github-actions'},status:'completed',conclusion:'success',details_url:`https://github.com/a/b/actions/runs/100/job/${i+1}`,...check}))};
    if(path.endsWith('/actions/runs/100'))return{path:'.github/workflows/check.yml',head_sha:sha,head_repository:{full_name:'a/b'},status:'completed',conclusion:'success',event:'pull_request',...run};
    throw new Error(`Unexpected route ${path}`);
  },list:async(path)=>{
    calls.push(path);
    if(path.endsWith('/reviews'))return reviews??[{id:1,user:{type:'User',login:'human'},state:'APPROVED',commit_id:sha}];
    if(path.endsWith('/files'))return files??[{filename:'src/add.js',status:'modified'}];
    throw new Error('Unexpected list');
  }};
  const enabled=[];
  return{gh,enabled,deps:{getProtection:async()=>state(),enable:async(gh,p,method)=>enabled.push({p,method})}};
}
test('all required gates permit only the expected bot head and squash method',async()=>{
  const {gh,enabled,deps}=fixture();const result=await considerMerge(gh,2,cfg,deps);
  assert.equal(result.merged,true);assert.equal(enabled.length,1);assert.equal(enabled[0].p.head.sha,sha);assert.equal(enabled[0].method,'squash');
});
test('disabled native auto-merge, human PRs, forks, drafts and missing labels cannot merge',async()=>{
  for(const options of [{repo:{allow_auto_merge:false}},{pull:{...pr(),user:{type:'User',login:'human'}}},{pull:{...pr(),labels:[]}},{pull:{...pr(),draft:true}},{pull:{...pr(),head:{...pr().head,repo:{full_name:'evil/fork'}}}},{pull:{...pr(),base:{...pr().base,ref:'release'}}}]){
    const {gh,enabled,deps}=fixture(options);assert.equal((await considerMerge(gh,2,cfg,deps)).merged,false);assert.equal(enabled.length,0);
  }
  assert.equal(mergeConfig({...cfg,autoMerge:undefined}).enabled,false);
  assert.throws(()=>mergeConfig({...cfg,autoMerge:{...cfg.autoMerge,requiredChecks:[]}}));
});
test('branch protection must enforce reviews, current checks, stale dismissal and no admin bypass',async()=>{
  for(const override of [{requiresApprovingReviews:false},{requiredApprovingReviewCount:0},{dismissesStaleReviews:false},{requiresStatusChecks:false},{requiresStrictStatusChecks:false},{isAdminEnforced:false},{requiredStatusCheckContexts:[]}]){
    const s=state();s.rule={...s.rule,...override};assert.equal(protectedPolicy(s,cfg.autoMerge,sha),false);
    const {gh,enabled,deps}=fixture();deps.getProtection=async()=>s;assert.equal((await considerMerge(gh,2,cfg,deps)).merged,false);assert.equal(enabled.length,0);
  }
  assert.equal(protectedPolicy({...state(),rule:null},cfg.autoMerge,sha),false);
});
test('Bot approvals, old approvals and change requests cannot substitute for human approval',async()=>{
  for(const reviews of [[],[{id:1,user:{type:'Bot',login:'review-bot'},state:'APPROVED',commit_id:sha}],[{id:1,user:{type:'User',login:'human'},state:'APPROVED',commit_id:base}],[{id:1,user:{type:'User',login:'human'},state:'CHANGES_REQUESTED',commit_id:sha}]]){
    const {gh,enabled,deps}=fixture({reviews});assert.equal((await considerMerge(gh,2,cfg,deps)).merged,false);assert.equal(enabled.length,0);
  }
});
test('pending or failed checks and checks from a different workflow never permit merging',async()=>{
  for(const options of [{check:{conclusion:'failure'}},{check:{status:'in_progress',conclusion:null}},{check:{app:{slug:'untrusted'}}},{check:{head_sha:base}},{run:{path:'.github/workflows/other.yml'}},{run:{head_sha:base}},{run:{event:'workflow_dispatch'}},{run:{head_repository:{full_name:'evil/fork'}}}]){
    const {gh,enabled,deps}=fixture(options);assert.equal((await considerMerge(gh,2,cfg,deps)).merged,false);assert.equal(enabled.length,0);
  }
});
test('protected code and renamed or removed files block auto-merge',async()=>{
  for(const files of [[{filename:'.github/workflows/fix.yml',status:'modified'}],[{filename:'.github/ai-bot/src/providers.js',status:'modified'}],[{filename:'src/add.js',status:'renamed'}],[{filename:'src/add.js',status:'removed'}]]){
    const {gh,enabled,deps}=fixture({files});assert.equal((await considerMerge(gh,2,cfg,deps)).merged,false);assert.equal(enabled.length,0);
  }
});
test('report PRs are limited to their generated report path',async()=>{
  const p=pr();p.body=`<!-- ai-report:issue:1 -->\n${revisionMarker(issue)}`;p.head.ref='ai-report/issue-1-0123456789ab-123';
  const good=fixture({pull:p,files:[{filename:'reports/ai/issue-1.md',status:'added'}]});assert.equal((await considerMerge(good.gh,2,cfg,good.deps)).merged,true);
  const bad=fixture({pull:p,files:[{filename:'reports/ai/issue-2.md',status:'added'}]});assert.equal((await considerMerge(bad.gh,2,cfg,bad.deps)).merged,false);
});
test('head or label changes during inspection stop the request',async()=>{
  for(const fresh of [{...pr(),head:{...pr().head,sha:base}},{...pr(),labels:[]}]){
    const {gh,enabled,deps}=fixture({fresh});assert.equal((await considerMerge(gh,2,cfg,deps)).merged,false);assert.equal(enabled.length,0);
  }
});
test('native request uses --auto and a head SHA lease without admin bypass or AI credentials',async()=>{
  let captured;
  await enableNativeMerge({repo:'a/b',token:'dummy-token'},pr(),'squash',async(file,args,options)=>{captured={file,args,options};});
  assert.equal(captured.file,'gh');assert.ok(captured.args.includes('--auto'));assert.ok(captured.args.includes('--match-head-commit'));assert.ok(captured.args.includes(sha));assert.ok(!captured.args.includes('--admin'));
  assert.equal(captured.options.env.GH_TOKEN,'dummy-token');assert.equal(captured.options.env.AI_API_KEY,undefined);await assert.rejects(access(captured.options.env.HOME));
});
test('protection query stays scoped to its repository and never prints remote errors',async()=>{
  const {gh}=fixture();
  gh.fetcher=async(url,options)=>{assert.equal(url,'https://api.github.com/graphql');assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body).variables,{owner:'a',name:'b',n:2});return new Response(JSON.stringify({errors:[{message:'remote-sensitive-text'}]}));};
  await assert.rejects(protection(gh,2),e=>e.code==='ACCESS'&&!e.message.includes('remote-sensitive-text'));
});
test('old Issue revisions and legacy proposals cannot enable auto-merge',async()=>{
  for(const body of ['<!-- ai-fix:issue:1 -->\nCloses #1',`<!-- ai-fix:issue:1 -->\n${revisionMarker({...issue,body:'old'})}`]){
    const {gh,enabled,deps}=fixture({pull:{...pr(),body}});
    assert.equal((await considerMerge(gh,2,cfg,deps)).merged,false);
    assert.equal(enabled.length,0);
  }
});
test('Issue changes while checking CI block auto-merge',async()=>{
  const {gh,enabled,deps}=fixture();const request=gh.request;let reads=0;
  gh.request=async path=>path.endsWith('/issues/1')&&++reads>1?{...issue,body:'new request'}:request(path);
  assert.equal((await considerMerge(gh,2,cfg,deps)).merged,false);assert.equal(enabled.length,0);
});
