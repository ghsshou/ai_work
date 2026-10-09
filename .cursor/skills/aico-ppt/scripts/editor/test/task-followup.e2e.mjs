import test from 'node:test';
import assert from 'node:assert/strict';
import {startFixtureServer,openEditor} from './test-helpers.mjs';
import {createDshAgentRunAdapter} from '../dsh-agent-run-adapter.mjs';
import {resolveEditingContext} from '../dsh-editing-context.mjs';
import {installEditingTools} from '../../../integrations/dsh/editing-tools.mjs';

test('真实编辑器：追问后独立修改不关旧任务，补充携带任务身份后完成原批次',async t=>{
 let app;
 const adapter=createDshAgentRunAdapter({getSession:()=>app.session,getAssignedSessionId:()=> 'session-a',
  publishRequest:request=>queueMicrotask(()=>adapter.acknowledge({requestId:request.requestId,accepted:true})),runTimeoutMs:30000});
 app=await startFixtureServer({agentRunAdapter:adapter,autoStartAgentTerminal:false});t.after(()=>app.close());
 const {browser,page}=await openEditor(app);t.after(()=>browser.close());
 const heading=page.frameLocator('#deck-frame').locator('h2').first();
 const locate=()=>heading.evaluate(el=>window.HuaweiDeckPatchRuntime.makeLocator(el));
 const target=await locate();
 const post=async(path,body)=>{
  const response=await fetch(new URL(path,app.url),{method:'POST',headers:{authorization:`Bearer ${app.token}`,'content-type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;
 };
 const create=instruction=>post('/api/tasks',{expectedRevision:app.session.revision,pageKey:target.pageKey,pageIndex:1,pageLabel:'封面',rect:{x:100,y:100,w:300,h:120},instruction});
 const a=(await create('ttt')).task.id;
 const b=(await create('另一个未提交标注')).task.id;
 await app.agentRuns.submit({expectedRevision:app.session.revision,taskIds:[a]});
 await new Promise(resolve=>setTimeout(resolve,50));
 const catalog={resolveByDshSession:async()=>({kind:'editing',workId:'work-a',deckPath:app.deckPath})};
 let tool;
 installEditingTools({tools:{register:value=>{tool=value;}},attachments:{saveImage:async()=>({id:'fixture-image'})}},'http://localhost:1234/?token=fixture',{
  request:async(url,options)=>new URL(url).pathname.includes('editing-context')
   ? {ok:true,json:()=>resolveEditingContext({sessionId:'session-a',workCatalog:catalog,findEditingRuntime:()=>({app})})}
   : fetch(url,options)});
 const exec={agent:{session:{id:'session-a'}},signal:AbortSignal.timeout(30000)};
 const edit=async(text,extra={})=>tool.execute({operation:'edit',workId:'work-a',expectedRevision:app.session.revision,
  actions:[{target:await locate(),kind:'setText',payload:{text}}],...extra},exec);
 const unchanged=app.session.revision;
 assert.equal((await edit('不应执行')).code,'TASK_RELATION_REQUIRED');assert.equal(app.session.revision,unchanged);
 const fresh=await edit('独立新修改',{taskRelation:'new'});assert.equal(fresh.committed,true);
 assert.equal(app.session.tasks.find(task=>task.id===a).status,'pending');assert.ok(app.agentRuns.snapshot().activeBatch);
 assert.equal(app.session.groups.at(-1).taskId,null);
 const failed=await edit('失败不得结束任务',{taskRelation:'supplement',taskId:a,expectedRevision:0});assert.notEqual(failed.committed,true);
 assert.equal(app.session.tasks.find(task=>task.id===a).status,'pending');
 const supplemented=await edit('用户对原任务补充的姓名',{taskRelation:'supplement',taskId:a});
 assert.equal(supplemented.committed,true);assert.equal(supplemented.task.status,'completed');
 await app.agentRuns.activePromise;
 assert.equal(await heading.textContent(),'用户对原任务补充的姓名');
 assert.equal(app.session.groups.at(-1).taskId,a);
 assert.equal(app.session.tasks.find(task=>task.id===b).status,'pending');
 assert.equal(app.agentRuns.snapshot().activeBatch,null);
 assert.deepEqual(app.agentRuns.snapshot().nextBatch.taskIds,[b]);
 assert.ok(app.session.agentBatches[0].settlement);
});

test('真实编辑器：批次失败后左侧补充原任务，右侧任务显示完成', async t => {
 let app;
 const adapter = createDshAgentRunAdapter({
  getSession:() => app.session,
  getAssignedSessionId:() => 'session-a',
  publishRequest:request => queueMicrotask(() => adapter.acknowledge({
   requestId:request.requestId, accepted:true,
  })),
  runTimeoutMs:300,
 });
 app = await startFixtureServer({agentRunAdapter:adapter,autoStartAgentTerminal:false});
 t.after(() => app.close());
 const {browser,page} = await openEditor(app);
 t.after(() => browser.close());
 const heading = page.frameLocator('#deck-frame').locator('h2').first();
 const target = await heading.evaluate(el => window.HuaweiDeckPatchRuntime.makeLocator(el));
 const response = await fetch(new URL('/api/tasks',app.url), {
  method:'POST',
  headers:{authorization:`Bearer ${app.token}`,'content-type':'application/json'},
  body:JSON.stringify({expectedRevision:app.session.revision,pageKey:target.pageKey,
   pageIndex:1,pageLabel:'封面',rect:{x:100,y:100,w:300,h:120},instruction:'修改封面标题'}),
 });
 assert.equal(response.status,201);
 const taskId = (await response.json()).task.id;
 await app.agentRuns.submit({expectedRevision:app.session.revision,taskIds:[taskId]});
 await app.agentRuns.activePromise;
 assert.equal(app.session.agentBatches[0].settlement.outcome,'failed');
 assert.equal(app.session.tasks.find(task => task.id === taskId).status,'pending');

 const catalog = {resolveByDshSession:async () => ({
  kind:'editing',workId:'work-a',deckPath:app.deckPath,
 })};
 let tool;
 installEditingTools({tools:{register:value => {tool=value;}},
  attachments:{saveImage:async () => ({id:'fixture-image'})}},
 'http://localhost:1234/?token=fixture',{
  request:async (url,options) => new URL(url).pathname.includes('editing-context')
   ? {ok:true,json:() => resolveEditingContext({sessionId:'session-a',
    workCatalog:catalog,findEditingRuntime:() => ({app})})}
   : fetch(url,options),
 });
 const context = await resolveEditingContext({sessionId:'session-a',
  workCatalog:catalog,findEditingRuntime:() => ({app})});
 assert.equal(context.feedbackTasks[0].batchSettled,true);
 const result = await tool.execute({operation:'edit',workId:'work-a',expectedRevision:app.session.revision,
  taskRelation:'supplement',taskId,
  actions:[{target,kind:'setText',payload:{text:'补充后完成的标题'}}]},
  {agent:{session:{id:'session-a'}},signal:AbortSignal.timeout(30000)});
 assert.equal(result.committed,true);
 assert.equal(result.task.status,'completed');
 await page.waitForFunction(id => (
  document.querySelector(`[data-task-row="${CSS.escape(id)}"] .task-status-completed`)
  && document.querySelector('[data-task-completed-count]')?.textContent?.includes('已完成 1')
 ),taskId);
 assert.equal(await heading.textContent(),'补充后完成的标题');
 assert.equal(app.session.agentBatches[0].settlement.outcome,'failed');
 assert.equal(app.session.groups.at(-1).taskId,taskId);
});
