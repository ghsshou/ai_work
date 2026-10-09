import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {startFixtureServer,openEditor} from './test-helpers.mjs';

async function post(app,path,body,method='POST') {
 const response=await fetch(new URL(path,app.url),{method,headers:{authorization:`Bearer ${app.token}`,'content-type':'application/json'},body:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
}

async function setup(t, options={}) {
 const app=await startFixtureServer({bundle:true,autoStartAgentTerminal:false,...options});t.after(()=>app.close());
 const {browser,page}=await openEditor(app);t.after(()=>browser.close());
 const target=await page.locator('#deck-frame').evaluate(frame=>frame.contentWindow.HuaweiDeckPatchRuntime.makeLocator(frame.contentDocument.querySelector('.card')));
 const task=async instruction=>{
  const result=await post(app,'/api/tasks',{expectedRevision:app.session.revision,pageKey:target.pageKey,pageIndex:1,pageLabel:'目录页',rect:{x:1,y:1,w:100,h:100},instruction});
  assert.equal(result.status,201,JSON.stringify(result.body));return result.body.task;
 };
 const edit=(revision,taskId=null,structure=false)=>post(app,structure?'/api/local-edits':'/api/actions',{
  expectedRevision:revision,taskId,commandId:crypto.randomUUID(),
  ...(structure?{operations:[{target,kind:'setShape',payload:{shape:'rectangle'}}]}
   :{actions:[{id:crypto.randomUUID(),taskId,target,kind:'setText',payload:{text:'修改卡片'}}]}),
 });
 return {app,page,target,task,edit};
}

test('Agent 读取后仅新增并删除其他区域任务，不应使 Deck 修改过期',async t=>{
 const app=await startFixtureServer({bundle:true,autoStartAgentTerminal:false});t.after(()=>app.close());
 const {browser,page}=await openEditor(app);t.after(()=>browser.close());
 const target=await page.locator('#deck-frame').evaluate(frame=>frame.contentWindow.HuaweiDeckPatchRuntime.makeLocator(frame.contentDocument.querySelector('.card')));
 const inspect=await post(app,'/api/inspect',{pageKey:target.pageKey});assert.equal(inspect.status,200);
 const bytes=await readFile(app.workingDeckPath);
 const task=await post(app,'/api/tasks',{expectedRevision:inspect.body.revision,pageKey:target.pageKey,pageIndex:1,pageLabel:'目录页',rect:{x:1,y:1,w:100,h:100},instruction:'只标注，随后删除'});
 assert.equal(task.status,201);
 const removed=await post(app,`/api/tasks/${task.body.task.id}`,{expectedRevision:task.body.revision},'DELETE');assert.equal(removed.status,200);
 assert.deepEqual(await readFile(app.workingDeckPath),bytes);assert.equal(app.session.groups.length,0);
 const edited=await post(app,'/api/local-edits',{expectedRevision:inspect.body.revision,commandId:crypto.randomUUID(),operations:[{target,kind:'setShape',payload:{shape:'rectangle'}}]});
 assert.equal(edited.status,200,JSON.stringify(edited.body));assert.equal(edited.body.committed,true);
 assert.equal(app.session.groups.length,1);
});

for(const structure of [false,true])test(`${structure?'结构':'普通'}编辑不被其他任务增删改打断，仍完成原任务`,async t=>{
 const {app,page,target,task,edit}=await setup(t);
 const original=await task('正在执行的任务');
 const inspect=await post(app,'/api/inspect',{taskId:original.id});assert.equal(inspect.status,200);
 const unrelated=await task('其他标注');
 const updated=await post(app,`/api/tasks/${unrelated.id}`,{expectedRevision:app.session.revision,instruction:'只改标注说明'},'PATCH');assert.equal(updated.status,200);
 assert.equal((await post(app,`/api/tasks/${unrelated.id}`,{expectedRevision:app.session.revision},'DELETE')).status,200);
 const view=await post(app,'/api/view',{expectedRevision:inspect.body.revision,pageKey:target.pageKey});
 assert.equal(view.status,200,JSON.stringify(view.body));assert.equal(view.body.stateId,inspect.body.stateId);
 assert.equal(app.session.editScope.contentRevision,0);
 const result=await edit(inspect.body.revision,original.id,structure);
 assert.equal(result.status,200,JSON.stringify(result.body));assert.ok(result.body.groupId);
 await page.waitForFunction(structure=>{
  const card=document.querySelector('#deck-frame')?.contentDocument?.querySelector('.card');
  return structure?card?.getAttribute('data-aico-shape')==='rectangle':card?.textContent==='修改卡片';
 },structure);
 assert.equal(app.session.tasks.length,1);assert.equal(app.session.tasks[0].status,'completed');assert.equal(app.session.groups.length,1);
});

for(const deleted of [false,true])test(`目标任务${deleted?'删除':'改写'}后拒绝旧编辑，并说明任务变化`,async t=>{
 const {app,task,edit}=await setup(t);
 const original=await task('原修改请求');const revision=app.session.revision;
 const bytes=await readFile(app.workingDeckPath);
 const changed=await post(app,`/api/tasks/${original.id}`,{expectedRevision:revision,...(deleted?{}:{instruction:'改变修改要求'})},deleted?'DELETE':'PATCH');
 assert.equal(changed.status,200);
 for(const structure of [false,true]) {
  const result=await edit(revision,original.id,structure);
  assert.equal(result.status,deleted?404:409);assert.equal(result.body.code,deleted?'TASK_NOT_FOUND':'TASK_CHANGED');
 }
 assert.equal(app.session.groups.length,0);assert.deepEqual(await readFile(app.workingDeckPath),bytes);
});

test('Deck 修改再撤销后，旧版本仍不能绕过内容冲突保护',async t=>{
 const {app,task,edit,target}=await setup(t);
 const first=await edit(0);assert.equal(first.status,200);
 const undo=await post(app,`/api/groups/${first.body.groupId}/undo`,{expectedRevision:app.session.revision});assert.equal(undo.status,200);
 const annotation=await task('无关标注');
 await post(app,`/api/tasks/${annotation.id}`,{expectedRevision:app.session.revision},'DELETE');
 for(const structure of [false,true]) {
  const stale=await edit(0,null,structure);assert.equal(stale.status,409);assert.equal(stale.body.code,'REVISION_CONFLICT');
 }
 const view=await post(app,'/api/view',{expectedRevision:0,pageKey:target.pageKey});assert.equal(view.status,409);
 const fresh=await edit(app.session.revision);assert.equal(fresh.status,200,JSON.stringify(fresh.body));
});

test('检查进行中增删无关任务不使结果失效，Deck 真修改仍使结果失效',async t=>{
 let entered,release,block=false;
 const {app,task,edit}=await setup(t,{workingPatchVerifier:async()=>{if(block){entered();await new Promise(resolve=>{release=resolve;});}return {ok:true};}});
 for(const contentChanged of [false,true]) {
  const reached=new Promise(resolve=>{entered=resolve;});block=true;
  const reading=post(app,'/api/verify',{});await reached;
  if(contentChanged){const result=await edit(app.session.revision);assert.equal(result.status,200);}
  else {const annotation=await task('检查期间新增');await post(app,`/api/tasks/${annotation.id}`,{expectedRevision:app.session.revision},'DELETE');}
  block=false;release();const result=await reading;
  assert.equal(result.status,contentChanged?409:200,JSON.stringify(result.body));
 }
});
