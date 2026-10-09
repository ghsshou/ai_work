import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createPersistentSidecarIO} from '../sidecar-io.mjs';
import {materializePatchBytes} from '../working-deck-store.mjs';

function childFixture(reply) {
  const child=new EventEmitter();
  for(const name of ['stdin','stdout','stderr'])child[name]=new EventEmitter();
  child.stdout.setEncoding=child.stderr.setEncoding=()=>{};
  child.stdin.write=data=>{queueMicrotask(()=>reply(child,JSON.parse(data)));return true;};
  child.stdin.end=data=>{if(data)child.stdin.write(data);};
  child.kill=()=>queueMicrotask(()=>child.emit('close',0));
  return child;
}

// 统计扫描量而不是依赖机器速度；分块越小也不能反复扫描完整累计内容。
function fragmentedReply(child, value) {
  const line=JSON.stringify(value)+'\n',original=Buffer.byteLength;
  let scanned=0;
  Buffer.byteLength=(value,...args)=>{if(typeof value==='string')scanned+=value.length;return original(value,...args);};
  try{for(let offset=0;offset<line.length;offset+=1024)child.stdout.emit('data',line.slice(offset,offset+1024));}
  finally{Buffer.byteLength=original;}
  return {scanned,length:line.length};
}

test('大型工作副本 JSONL 的分块接收只线性扫描且保留完整数据',async()=>{
  let metrics;
  const bytes='a'.repeat(2*1024*1024);
  const child=childFixture((current,request)=>{metrics=fragmentedReply(current,{id:request.id,ok:true,result:{bytes}});});
  const io=await createPersistentSidecarIO({project:{path:'/tmp/test',realPath:'/tmp/test',dev:'1',ino:'2'},spawnHelper:()=>child,skipReadyHandshake:true});
  try{
    assert.equal((await io.readWorkingDeck({missingOk:false})).bytes,bytes);
    assert.ok(metrics.scanned<metrics.length*4,`累计扫描 ${metrics.scanned}，实际数据 ${metrics.length}`);
  }finally{await io.close();}
});

test('大型补丁适配器输出只线性计数，不反复扫描累计 JSON',async()=>{
  let metrics;
  const bytes=Buffer.alloc(2*1024*1024,97);
  const child=childFixture(current=>{
    metrics=fragmentedReply(current,{bytes:bytes.toString('base64')});
    current.emit('close',0);
  });
  const result=await materializePatchBytes(bytes,[],{spawnProcess:()=>child});
  assert.deepEqual(result,bytes);
  assert.ok(metrics.scanned<metrics.length*4,`累计扫描 ${metrics.scanned}，实际数据 ${metrics.length}`);
});
