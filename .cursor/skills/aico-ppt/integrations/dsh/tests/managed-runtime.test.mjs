import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import * as managed from '../managed-runtime.mjs';
import {gzipSync} from 'node:zlib';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t){const root=await realpath(await mkdtemp(join(tmpdir(),'ppt-resource-')));t.after(()=>rm(root,{recursive:true,force:true}));const source=join(root,'package/runtime'),store=join(root,'state/runtime');await mkdir(join(source,'python'),{recursive:true});return {root,source,store};}
async function version(source,text){const bytes=Buffer.from(text);await writeFile(join(source,'python/python.exe'),bytes);const descriptor={schema:1,target:process.platform+'-'+process.arch,files:[{path:'python/python.exe',bytes:bytes.length,sha256:sha(bytes)}]};await writeFile(join(source,'manifest.json'),JSON.stringify(descriptor));}
test('runtime executes outside the package and identical resources reuse one directory across plugin upgrades',async t=>{
 const {source,store}=await fixture(t);await version(source,'one');
 const a=await managed.acquireManagedRuntime(source,store),b=await managed.acquireManagedRuntime(source,store);
 assert.equal(a.root,b.root);assert.ok(!a.root.startsWith(source));
 await rm(source,{recursive:true});assert.equal(await readFile(join(a.root,'python/python.exe'),'utf8'),'one');
 await a.release();await b.release();assert.equal((await readdir(store)).filter(n=>n.startsWith('r-')).length,1);
});
test('corrupt or incomplete resources never activate, and active old resources survive bounded retention',async t=>{
 const {source,store}=await fixture(t);await version(source,'one');const active=await managed.acquireManagedRuntime(source,store);
 for(const v of ['two','three','four']){await version(source,v);const current=await managed.acquireManagedRuntime(source,store);await current.release();}
 assert.equal(await readFile(join(active.root,'python/python.exe'),'utf8'),'one');
 assert.ok((await readdir(store)).filter(n=>n.startsWith('r-')).length<=3);
 await active.release();assert.ok((await readdir(store)).filter(n=>n.startsWith('r-')).length<=2);
 await version(source,'five');await writeFile(join(source,'python/python.exe'),'broken');await assert.rejects(managed.acquireManagedRuntime(source,store),/digest|changed|校验/);
});

test('a failed parallel copy settles all workers and leaves no reusable or partial runtime',async t=>{
 const {source,store}=await fixture(t);await version(source,'one');
 const descriptor=JSON.parse(await readFile(join(source,'manifest.json')));
 descriptor.files.push({...descriptor.files[0],path:'python/missing.dll'});await writeFile(join(source,'manifest.json'),JSON.stringify(descriptor));
 await assert.rejects(managed.acquireManagedRuntime(source,store));
 await new Promise(r=>setTimeout(r,100));
 assert.deepEqual((await readdir(store)).filter(n=>n.startsWith('r-')||n.startsWith('.stage-')),[]);
});

test('compressed distribution contains no installed executable and unpacks exact file boundaries',async t=>{
 const {source,store}=await fixture(t);
 const content=[Buffer.alloc(0),Buffer.alloc(70001,17),Buffer.alloc(33000,29)];
 const files=content.map((b,i)=>({path:'python/'+i+'.exe',bytes:b.length,sha256:sha(b)}));
 const bytes=gzipSync(Buffer.concat(content));await writeFile(join(source,'resources.gz'),bytes);
 const manifest={schema:1,target:process.platform+'-'+process.arch,files,payload:{format:'gzip-concatenated-v1',path:'resources.gz',bytes:bytes.length,sha256:sha(bytes)}};
 await writeFile(join(source,'manifest.json'),JSON.stringify(manifest));
 const a=await managed.acquireManagedRuntime(source,store);
 for(let i=0;i<files.length;i++)assert.deepEqual(await readFile(join(a.root,files[i].path)),content[i]);
 assert.deepEqual(await readdir(join(source,'python')),[]);
 // Changing distribution encoding alone does not duplicate immutable resources.
 for(let i=0;i<files.length;i++)await writeFile(join(source,files[i].path),content[i]);
 delete manifest.payload;await writeFile(join(source,'manifest.json'),JSON.stringify(manifest));
 const b=await managed.acquireManagedRuntime(source,store);assert.equal(a.root,b.root);
 await a.release();await b.release();
});

test('truncated, extra, corrupt or altered payload bytes never publish a partial runtime',async t=>{
 const {source,store}=await fixture(t);await version(source,'valid');
 const original=JSON.parse(await readFile(join(source,'manifest.json')));
 for(const [name,raw] of [['truncated',Buffer.from('val')],['extra',Buffer.from('valid-extra')],['wrong-digest',Buffer.from('other')],['invalid-gzip',null]]){
  const bytes=raw?gzipSync(raw):Buffer.from('not gzip');
  await writeFile(join(source,'resources.gz'),bytes);
  await writeFile(join(source,'manifest.json'),JSON.stringify({...original,payload:{format:'gzip-concatenated-v1',path:'resources.gz',bytes:bytes.length,sha256:sha(bytes)}}));
  const destination=join(store,name);
  await assert.rejects(managed.acquireManagedRuntime(source,destination));
  assert.deepEqual((await readdir(destination)).filter(n=>n.startsWith('r-')||n.startsWith('.stage-')),[],name);
 }
 const manifest={...original,payload:{format:'gzip-concatenated-v1',path:'../escape.gz',bytes:5,sha256:sha('other')}};
 await writeFile(join(source,'manifest.json'),JSON.stringify(manifest));
 await assert.rejects(managed.acquireManagedRuntime(source,join(store,'escape')),/Invalid runtime payload/);
});

test('Windows keeps orphaned native executables even after the parent lease is released',{skip:process.platform!=='win32',timeout:60000},async t=>{
 const {copyFile}=await import('node:fs/promises'),{spawn}=await import('node:child_process'),{once}=await import('node:events');
 let child;
 t.after(async()=>{if(child&&child.exitCode===null&&!child.signalCode){const exited=once(child,'exit');child.kill();await exited;}});
 const {source,store}=await fixture(t);await copyFile(process.execPath,join(source,'python/python.exe'));
 const bytes=await readFile(join(source,'python/python.exe'));await writeFile(join(source,'manifest.json'),JSON.stringify({schema:1,target:process.platform+'-'+process.arch,files:[{path:'python/python.exe',bytes:bytes.length,sha256:sha(bytes)}]}));
 const active=await managed.acquireManagedRuntime(source,store);
 child=spawn(join(active.root,'python/python.exe'),['-e',"console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);
 await Promise.race([once(child.stdout,'data'),once(child,'exit').then(([code])=>{throw Error('Native fixture exited '+code+': '+stderr)}),once(child,'error').then(([error])=>{throw error})]);
 await active.release();
 for(const v of ['two','three','four']){await version(source,v);const current=await managed.acquireManagedRuntime(source,store);await current.release();}
 assert.equal((await readFile(join(active.root,'python/python.exe'))).length,bytes.length);
 const exited=once(child,'exit');child.kill();await exited;
 await version(source,'five');const next=await managed.acquireManagedRuntime(source,store);await next.release();
 await assert.rejects(readFile(join(active.root,'python/python.exe')),e=>e.code==='ENOENT');
});

