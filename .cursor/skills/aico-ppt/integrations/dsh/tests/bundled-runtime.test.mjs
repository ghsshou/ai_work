import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveBundledRuntime} from '../bundled-runtime.mjs';
test('完整发行资源缺失不回退系统环境，开发包保留源码入口',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ppt-bundle-'));
 try{
  await writeFile(join(root,'package.json'),JSON.stringify({aico:{bundledRuntime:true}}));
  await assert.rejects(resolveBundledRuntime(root),/运行时资源缺失/);
  await writeFile(join(root,'package.json'),'{}');
  assert.equal(await resolveBundledRuntime(root),null);
 }finally{await rm(root,{recursive:true,force:true})}
});
