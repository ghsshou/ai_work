import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connectionDiagnostics} from '../connection-diagnostics.mjs';
test('诊断落盘脱敏、轮转且写入失败不影响调用', async t => {
 const directory=await mkdtemp(join(tmpdir(),'aico-diag-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const log=connectionDiagnostics('test',{directory,maxBytes:1});
 log.record('close',{code:1006,token:'secret',url:'secret',message:'secret',sessionId:'bad/secret'});await log.flush();
 const first=await readFile(log.file,'utf8');assert.ok(!first.includes('secret'));assert.equal(JSON.parse(first).code,1006);
 log.record('open',{attempt:1});await log.flush();
 assert.equal(await readFile(log.file+'.1','utf8'),first);
 assert.equal(JSON.parse(await readFile(log.file,'utf8')).event,'open');
 const failed=connectionDiagnostics('test',{directory:log.file});failed.record('close');await failed.flush();
});
