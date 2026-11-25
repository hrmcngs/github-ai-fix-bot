// Reproduce real project tests under the old and corrected sandbox; no AI call or secrets.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validateFix} from '../.github/ai-bot/src/fix.js';
import {command} from '../.github/ai-bot/src/providers.js';
const exec=promisify(execFile);
const cfg=JSON.parse(await readFile('.github/ai-bot/config.json','utf8'));
const file='.github/ai-bot/src/markdown.js';
const original=await readFile(file,'utf8');
const content=original.includes('|sql)')?original+'\n// Offline validation fixture.\n':original.replace('|toml)?','|toml|sql)?');
assert.notEqual(content,original);
const sha=(await exec('git',['rev-parse','HEAD'])).stdout.trim();
await mkdir('.work',{recursive:true});
try{
  await writeFile('.work/fix-bundle.json',JSON.stringify({repo:'fixture/repo',branch:'main',cfg,targets:[{kind:'issue',number:2,sha}],context:{files:[{path:file,content:original}]}}));
  await writeFile('.work/fix-plan.json',JSON.stringify({ok:true,plan:{confidence:'high',summary:'SQL fixture',changes:[{path:file,content}]}}));
  const env={GITHUB_REPOSITORY:'fixture/repo'};
  await validateFix(env,{run:(args,options)=>command(args.map(arg=>arg.startsWith('/tmp:')?arg.replace('/tmp:rw,','/tmp:rw,noexec,'):arg),options)});
  const old=JSON.parse(await readFile('.work/fix-verdict.json','utf8'));
  assert.equal(old.ok,false,'Old noexec scratch must reproduce the actual project test failure');
  assert.ok(old.checks?.some(check=>JSON.stringify(check.argv)==='["npm","test"]'&&check.exitCode!==0),'Failure must be identified as npm test');
  console.log('Reproduced old sandbox failure:',old.reason);
  await validateFix(env);
  const fixed=JSON.parse(await readFile('.work/fix-verdict.json','utf8'));
  console.log('Corrected sandbox:',JSON.stringify(fixed));
  assert.equal(fixed.ok,true,'The same SQL change must pass the complete project check/test commands in the corrected sandbox');
}finally{
  for(const name of ['fix-bundle.json','fix-plan.json','fix-verdict.json'])await rm(`.work/${name}`,{force:true});
}
