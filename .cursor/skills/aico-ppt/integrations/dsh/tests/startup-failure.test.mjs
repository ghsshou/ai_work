import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apply} from '../index.mjs';
test('初始化故障不影响宿主，保留可访问的错误状态',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aico-startup-'));
 try{
  const missing=join(root,'missing'),invalid=join(root,'file');await writeFile(invalid,'fixture');
  const events=new Map(),logs=[];
  await apply({get(){},on(n,fn){events.set(n,fn)},logger:{warn(e){logs.push(e)}}},{aicoRuntime:{root:missing,paths:{python:join(missing,'python.exe')}}});
  const table=[];events.get('webserver/index-inject')(table);
  assert.equal(table[0].name,'__AICO_PPT_BRAND__');assert.equal(table[0].value.status,'unavailable');
  assert.match(table[0].value.error,/重启/);assert.equal(logs.length,1);
 }finally{await rm(root,{recursive:true,force:true,maxRetries:3})}
});

test('显式空运行时配置不得悄悄进入源码回退',async()=>{
 const events=new Map();
 await apply({on(n,fn){events.set(n,fn)},logger:{warn(){}}},{aicoRuntime:null});
 const table=[];events.get('webserver/index-inject')(table);
 assert.equal(table[0].value.status,'unavailable');
 assert.match(table[0].value.error,/aicoRuntime/);
});
