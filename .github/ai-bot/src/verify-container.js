// Trusted verifier. Source and AI changes execute only inside a secretless offline container.
import { readFile, writeFile, lstat, mkdir, readdir, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const env={ PATH:'/usr/local/bin:/usr/bin:/bin', HOME:'/tmp/home', TMPDIR:'/tmp', CI:'true', npm_config_cache:'/tmp/npm', npm_config_userconfig:'/dev/null', npm_config_globalconfig:'/dev/null', npm_config_offline:'true', npm_config_ignore_scripts:'true', npm_config_update_notifier:'false' };
async function readonly(dir) {
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const file=path.join(dir,entry.name);
    if(entry.isSymbolicLink())continue;
    if(entry.isDirectory())await readonly(file);
    else if(entry.isFile()){const info=await lstat(file);await chmod(file,info.mode & 0o111 ? 0o555 : 0o444);}
    else throw new Error();
  }
  await chmod(dir,0o555);
}
function run(argv) {
  const result=spawnSync(argv[0],argv.slice(1),{cwd:'/workspace',env,timeout:90000,maxBuffer:1000000,stdio:['ignore','pipe','pipe']});
  return result.status===0 && !result.error;
}
try {
  await mkdir('/tmp/home',{recursive:true});
  if(!run(['tar','--no-same-owner','--no-same-permissions','-xf','/input/source.tar','-C','/workspace','--exclude=.git','--exclude=.work','--exclude=node_modules'])) throw new Error();
  const data=JSON.parse(await readFile('/input/validation.json','utf8'));
  for(const change of data.plan.changes) {
    const pieces=change.path.split('/');let current='/workspace';
    for(const piece of pieces) {
      if(!piece || piece==='.' || piece==='..')throw new Error();
      current=path.join(current,piece);
      const entry=await lstat(current);
      if(entry.isSymbolicLink())throw new Error();
    }
    const original=await readFile(current,'utf8');
    const expected=data.originals.find(f=>f.path===change.path);
    if(!expected || original!==expected.content)throw new Error();
    await writeFile(current,change.content);
  }
  // Dependencies cannot be fetched in the offline validator. Fail closed instead of skipping tests.
  try {
    const pkg=JSON.parse(await readFile('/workspace/package.json','utf8'));
    if(Object.keys({...pkg.dependencies,...pkg.devDependencies,...pkg.optionalDependencies}).length) {
      process.stdout.write('OFFLINE_DEPENDENCIES');process.exit(0);
    }
  } catch(error) { if(error.code!=='ENOENT')throw error; }
  await chmod('/tmp/home',0o777);
  await readonly('/workspace');
  // Only trusted extraction/patch application runs as container root. Test code cannot rewrite tests.
  process.setgroups([]);process.setgid(1000);process.setuid(1000);
  for(const change of data.plan.changes) if(!run(['node','--check',change.path]))throw new Error();
  for(const command of data.commands) if(!run(command))throw new Error();
} catch { process.exitCode=1; }
