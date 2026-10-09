/** Immutable, content-addressed runtime copies. Never run an executable from node_modules. */
import {createReadStream} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile,readdir,realpath,lstat,copyFile,rename,rm,unlink,open} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join,dirname,resolve,sep} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createGunzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
const exec=promisify(execFile),kind='aico-ppt-runtime',hex=/^[a-f0-9]{64}$/;
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return true;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function hash(path){const h=createHash('sha256');for await(const part of createReadStream(path))h.update(part);return h.digest('hex');}
async function json(path){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>4*1024*1024)throw Error('Invalid runtime record');return JSON.parse(await readFile(path,'utf8'));}
async function lock(base,work){
 const path=join(base,'.lock'),owner={pid:process.pid,id:randomUUID()};let held=false;
 for(let n=0;n<600;n++){
  try{await mkdir(path);held=true;await writeFile(join(path,'owner.json'),JSON.stringify(owner),{flag:'wx'});break;}
  catch(error){
   if(held){await rm(path,{recursive:true,force:true});throw error;}
   if(error.code!=='EEXIST')throw error;
   try{const previous=await json(join(path,'owner.json'));if(!alive(previous.pid)){
    const old=join(base,'.stale-'+randomUUID());await rename(path,old);await rm(old,{recursive:true,force:true});continue;
   }}catch(e){if(!['ENOENT','EEXIST'].includes(e.code))throw e;}
   await delay(100);
  }
 }
 if(!held)throw Error('PPT 运行资源正被另一个进程准备，请稍后重试');
 try{return await work();}finally{await rm(path,{recursive:true,force:true});}
}
function descriptor(value){
 if(value?.schema!==1||value.target!==process.platform+'-'+process.arch||!Array.isArray(value.files)||!value.files.length||value.files.length>20000)throw Error('Invalid runtime manifest');
 if(value.payload&&(value.payload.format!=='gzip-concatenated-v1'||value.payload.path!=='resources.gz'||!Number.isSafeInteger(value.payload.bytes)||value.payload.bytes<=0||value.payload.bytes>2*1024**3||!hex.test(value.payload.sha256)))throw Error('Invalid runtime payload');
 let total=0;const names=new Set();
 for(const f of value.files){
  if(typeof f.path!=='string'||! /^(python|browser)\//.test(f.path)||f.path.split('/').some(p=>!p||p==='.'||p==='..'||/[\\<>:"|?*\x00-\x1f]/.test(p)||/[. ]$/.test(p))||names.has(f.path.toLowerCase())||!Number.isSafeInteger(f.bytes)||f.bytes<0||!hex.test(f.sha256))throw Error('Invalid runtime inventory');
  names.add(f.path.toLowerCase());total+=f.bytes;
 }
 if(total>2*1024**3)throw Error('Runtime inventory exceeds limits');return value;
}
async function unpack(source,stage,manifest){
 const payload=await checkedFile(source,manifest.payload);
 let next=0,current=null;
 async function finish(){
  const done=current;current=null;await done.handle.close();
  if(done.hash.digest('hex')!==done.file.sha256)throw Error('Runtime file digest changed: '+done.file.path);
 }
 async function begin(){
  while(next<manifest.files.length){
   const file=manifest.files[next++],path=join(stage,file.path);await mkdir(dirname(path),{recursive:true});
   current={file,handle:await open(path,'wx'),written:0,hash:createHash('sha256')};
   if(file.bytes)return;await finish();
  }
 }
 try{
  await begin();
  await pipeline(createReadStream(payload),createGunzip(),async chunks=>{
   for await(const chunk of chunks){
    let offset=0;
    while(offset<chunk.length){
     if(!current)throw Error('Runtime payload exceeds its inventory');
     const length=Math.min(chunk.length-offset,current.file.bytes-current.written),part=chunk.subarray(offset,offset+length);
     await current.handle.writeFile(part);current.hash.update(part);current.written+=length;offset+=length;
     if(current.written===current.file.bytes){await finish();await begin();}
    }
   }
  });
  if(current||next!==manifest.files.length)throw Error('Runtime payload is truncated');
 }finally{await current?.handle.close();}
}
async function checkedFile(base,file){
 const path=join(base,file.path),actual=await realpath(path),info=await lstat(path);
 if(!actual.startsWith(base+sep)||!info.isFile()||info.isSymbolicLink()||info.size!==file.bytes||await hash(path)!==file.sha256)throw Error('Runtime file digest changed: '+file.path);
 return path;
}
async function verify(base,inventory){
 let next=0;const settled=await Promise.allSettled(Array.from({length:8},async()=>{while(next<inventory.length){const f=inventory[next++];await checkedFile(base,f);}}));
 const failure=settled.find(r=>r.status==='rejected');if(failure)throw failure.reason;
}
async function publish(stage,root){
 // Windows scanners can briefly hold freshly copied binaries. Retry only this
 // unpublished directory; never replace or remove an existing runtime version.
 const waits=process.platform==='win32'?[50,100,200,400,800,1000,1000,1000]:[];
 for(let attempt=0;;attempt++){
  try{await rename(stage,root);return;}
  catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=waits.length)throw error;await delay(waits[attempt]);}
 }
}
async function busyExecutables(base){
 if(process.platform==='win32'){
  const powershell=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const {stdout}=await exec(powershell,['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./runtime-processes.ps1',import.meta.url)),'-Root',base],{windowsHide:true,timeout:15000,maxBuffer:1024*1024});
  const paths=JSON.parse(stdout.replace(/^\uFEFF/,''));if(!Array.isArray(paths)||paths.some(p=>typeof p!=='string'))throw Error('Invalid runtime process observation');return paths;
 }
 if(process.platform==='linux'){
  const paths=[];for(const pid of await readdir('/proc'))if(/^\d+$/.test(pid)){try{paths.push(await realpath('/proc/'+pid+'/exe'));}catch{}}
  return paths;
 }
 throw Error('Runtime retention process inspection is unavailable');
}
async function prune(base){
 const rows=[];for(const entry of await readdir(base,{withFileTypes:true}))if(entry.isDirectory()&&/^r-[a-f0-9]{24}$/.test(entry.name)){
  const path=join(base,entry.name);try{const record=await json(join(path,'.aico-runtime.json'));
   if(record.kind===kind&&hex.test(record.sha256)&&entry.name==='r-'+record.sha256.slice(0,24)&&await realpath(path)===path)rows.push({path,record});
  }catch{}
 }
 if(rows.length<=2)return;
 const leases=[];for(const e of await readdir(join(base,'.leases'))){try{const v=await json(join(base,'.leases',e));if(v.kind!==kind||!hex.test(v.sha256))return;leases.push({path:join(base,'.leases',e),...v});}catch{return;}}
 let processes;try{processes=await busyExecutables(base);}catch{return;}
 const protectedIds=new Set(leases.filter(v=>alive(v.pid)).map(v=>v.sha256));
 const recent=rows.sort((a,b)=>b.record.createdAt-a.record.createdAt);let kept=0;
 for(const row of recent){
  const inUse=protectedIds.has(row.record.sha256)||processes.some(p=>p.toLowerCase().startsWith((row.path+sep).toLowerCase()));
  if(inUse||kept++<2)continue;
  // All leases and executable observations are inspected under the same acquire lock.
  for(const lease of leases)if(lease.sha256===row.record.sha256)await unlink(lease.path).catch(()=>{});
  const tomb=join(base,'.remove-'+randomUUID());
  try{await rename(row.path,tomb);await rm(tomb,{recursive:true,force:true,maxRetries:3,retryDelay:150});}catch{}
 }
}

/** Acquire a verified copy and a process lease; release only after every owned backend has exited. */
export async function acquireManagedRuntime(source,store){
 source=await realpath(source);await mkdir(store,{recursive:true});const base=await realpath(store);
 if(base===source||base.startsWith(source+sep))throw Error('Managed resources must be outside the plugin runtime');
 const manifest=descriptor(await json(join(source,'manifest.json'))),sha256=digest(JSON.stringify({schema:manifest.schema,target:manifest.target,files:manifest.files}));
 await mkdir(join(base,'.leases'),{recursive:true});
 return lock(base,async()=>{
  for(const entry of await readdir(base,{withFileTypes:true}))if(entry.isDirectory()&&/^\.stage-[A-Za-z0-9]{6}$/.test(entry.name)){
   const path=join(base,entry.name);try{const marker=await json(join(path,'.aico-staging.json'));if(marker.kind===kind&&!alive(marker.pid)&&await realpath(path)===path)await rm(path,{recursive:true,force:true});}catch{}
  }
  const root=join(base,'r-'+sha256.slice(0,24));let exists=false;
  try{const record=await json(join(root,'.aico-runtime.json'));if(record.kind!==kind||record.sha256!==sha256||await realpath(root)!==root)throw Error('Runtime cache identity mismatch');await verify(root,manifest.files);exists=true;}
  catch(e){if(e.code!=='ENOENT')throw e;}
  if(!exists){
   const stage=await mkdtemp(join(base,'.stage-'));
   try{
    await writeFile(join(stage,'.aico-staging.json'),JSON.stringify({kind,pid:process.pid}),{flag:'wx'});
    if(manifest.payload)await unpack(source,stage,manifest);
    else {
     let next=0,failed=false;
     const copied=await Promise.allSettled(Array.from({length:8},async()=>{try{while(!failed&&next<manifest.files.length){const f=manifest.files[next++],path=await checkedFile(source,f),target=join(stage,f.path);await mkdir(dirname(target),{recursive:true});await copyFile(path,target);}}catch(error){failed=true;throw error;}}));
     const failure=copied.find(r=>r.status==='rejected');if(failure)throw failure.reason;
    }
    await verify(stage,manifest.files);
    await writeFile(join(stage,'.aico-runtime.json'),JSON.stringify({kind,schema:1,sha256,createdAt:Date.now(),manifest}),{flag:'wx'});
    await publish(stage,root);
   }finally{await rm(stage,{recursive:true,force:true,maxRetries:3,retryDelay:150});}
  }
  const leasePath=join(base,'.leases',randomUUID()+'.json');await writeFile(leasePath,JSON.stringify({kind,sha256,pid:process.pid}),{flag:'wx'});
  await prune(base);
  let released=false;
  return {root,sha256,async release(){if(released)return;released=true;await lock(base,async()=>{await unlink(leasePath).catch(e=>{if(e.code!=='ENOENT')throw e;});await prune(base);});}};
 });
}

