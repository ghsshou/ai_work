/** 固定解释器执行内置局部转换，模型只提供声明式操作。 */
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {pythonUtf8SpawnOptions} from './python-utf8.mjs';
export const LOCAL_EDIT_KINDS=['setShape','replaceFragment','insertFragment','deleteElement','duplicateElement','replaceImage'];
function runLocalEdit(bytes,payload,{pythonExecutable,signal}={}) {
  return new Promise((resolve,reject)=>{
    signal?.throwIfAborted();
    const child=spawn(pythonExecutable,[fileURLToPath(new URL('./local-edit.py',import.meta.url))],pythonUtf8SpawnOptions({stdio:['pipe','pipe','pipe']}));
    const chunks=[];let length=0,stderr='';
    const abort=()=>child.kill('SIGKILL');
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,30_000);
    child.stdout.on('data',chunk=>{length+=chunk.length;if(length>96*1024*1024)abort();else chunks.push(chunk);});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2048);});
    child.stdin.on('error',()=>{});
    child.once('error',reject);
    child.once('close',code=>{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(signal?.aborted)return reject(signal.reason);
      if(code!==0)return reject(Object.assign(new Error(stderr?`局部修改准备失败：${stderr}`:'局部修改准备失败或超时'),{code:'LOCAL_EDIT_REJECTED',statusCode:409}));
      try{resolve(JSON.parse(Buffer.concat(chunks).toString()));}catch(error){reject(error);}
    });
    child.stdin.end(JSON.stringify({bytes:bytes.toString('base64'),...payload}));
  });
}

export async function prepareLocalEdit(bytes,operations,options) {
  const result=await runLocalEdit(bytes,{operations,styles:options?.styles??{}},options);
  return Buffer.from(result.bytes,'base64');
}
export function inspectLocalSource(bytes,target,options) {
  return runLocalEdit(bytes,{mode:'inspect',target},options);
}
