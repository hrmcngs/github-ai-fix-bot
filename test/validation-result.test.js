import test from 'node:test';
import assert from 'node:assert/strict';
import {validationResult,validationFailure} from '../.github/ai-bot/src/fix-core.js';
const plan={changes:[{path:'src/a.js',content:'export const a=1;'}]};
const commands=[['npm','run','check'],['npm','test']];
const rows=[['node','--check','src/a.js'],...commands].map(argv=>({argv,exitCode:0,detail:''}));
test('a successful verifier result must include every expected check in order',()=>{
  const good={version:1,ok:true,stage:'complete',checks:rows};
  assert.equal(validationResult(JSON.stringify(good),plan,commands).ok,true);
  for(const value of ['',JSON.stringify({...good,checks:[]}),JSON.stringify({...good,checks:rows.slice(0,2)}),JSON.stringify({...good,checks:[{argv:['echo','pass'],exitCode:0,detail:''}]}),JSON.stringify({...good,checks:rows.map((c,i)=>i===2?{...c,exitCode:1}:c)})])assert.throws(()=>validationResult(value,plan,commands));
});
test('failure details identify the trusted command without exposing target logs',()=>{
  const report=validationResult(JSON.stringify({version:1,ok:false,stage:'command',checks:[...rows.slice(0,2),{...rows[2],exitCode:1,detail:'PERMISSION_DENIED'}]}),plan,commands);
  assert.match(validationFailure(report),/npm test/);assert.match(validationFailure(report),/終了コード: 1/);assert.match(validationFailure(report),/実行権限/);
  assert.throws(()=>validationResult(JSON.stringify({...report,checks:[{...rows[0],detail:'raw sensitive test output'}]}),plan,commands));
});
test('setup, extraction and dependency failures remain failures with safe reasons',()=>{
  for(const stage of ['setup','extract','apply','dependencies']){
    const report=validationResult(JSON.stringify({version:1,ok:false,stage,checks:[]}),plan,commands);
    assert.equal(report.ok,false);assert.ok(validationFailure(report).length>0);
  }
});
