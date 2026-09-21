import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyContextPreconditions} from '../src/context_preconditions.js';

test('verifier refuses wrong-request, old, malformed and oversized responses without exposing output',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'warble-context-protocol-'));
 try {
  for(const expression of [
   'JSON.stringify({version:1,status:"pass",request_sha256:"other"})',
   'JSON.stringify({version:0,status:"pass",request_sha256:hash})',
   'JSON.stringify({version:1,status:"pass",request_sha256:hash,extra:true})',
   'JSON.stringify({version:1,status:"fail",request_sha256:hash})',
   '"PRIVATE_INVALID_JSON"', '"x".repeat(70000)',
  ]) {
   const executable=join(dir,'verify');
   await writeFile(executable,`#!${process.execPath}\nconst {readFileSync}=require('node:fs');const {createHash}=require('node:crypto');const input=readFileSync(0);const hash=createHash('sha256').update(input).digest('hex');process.stdout.write(${expression});`,{mode:0o700});
   assert.throws(()=>verifyContextPreconditions('{"context_version":2,"parseable":true}',[{predicate:'mdl_parseable'}],executable),error=>{
    assert.match(String(error),/context preconditions/);assert.doesNotMatch(String(error),/PRIVATE_INVALID_JSON/);return true;
   });
  }
  assert.throws(()=>verifyContextPreconditions('x'.repeat(2*1024*1024+1),[], '/missing'),/context preconditions/);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('hung verifier is bounded and reaped before any plan can be authorized',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'warble-context-timeout-'));
 try {
  const executable=join(dir,'verify'),pidFile=join(dir,'pid');
  await writeFile(executable,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`,{mode:0o700});
  const start=Date.now();
  assert.throws(()=>verifyContextPreconditions('{"context_version":2,"parseable":true}',[{predicate:'mdl_parseable'}],executable),/context preconditions/);
  assert.ok(Date.now()-start<15000);
  const pid=Number(await readFile(pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),/ESRCH/);
 } finally {await rm(dir,{recursive:true,force:true});}
});
