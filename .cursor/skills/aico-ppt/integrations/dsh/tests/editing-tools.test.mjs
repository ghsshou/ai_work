import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {installEditingTools} from '../editing-tools.mjs';
import {writeWorkspaceCapability} from '../../../scripts/editor/workspace-capability.mjs';

test('明确拒绝不要求查回执；断线和执行中的命令仍保留未知提交保护',async t=>{
 const root=await mkdtemp(join(tmpdir(),'aico-tool-rejection-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const capabilityPath=await writeWorkspaceCapability(root,{url:'http://localhost:1235',token:'private'});
 let tool,failure;const calls=[];
 installEditingTools({tools:{register:value=>{tool=value;}}},'http://localhost:1234/?token=x',{
  request:async url=>{
   const path=new URL(url).pathname;calls.push(path);
   if(path.includes('editing-context'))return {ok:true,json:async()=>({status:'ready',capabilityPath})};
   if(failure===null)throw new Error('连接中断');
   return {ok:false,status:409,json:async()=>({code:failure,message:'模拟编辑拒绝'})};
  }});
 const exec={agent:{session:{id:'s'}},signal:new AbortController().signal};
 for(failure of ['REVISION_CONFLICT','TASK_CHANGED','TASK_NOT_FOUND','COMMAND_IN_PROGRESS',null]) {
  const result=await tool.execute({operation:'structure',expectedRevision:0,operations:[{target:{pageKey:'p',editorId:'e'},kind:'setShape',payload:{shape:'rectangle'}}]},exec);
  const rejected=failure!==null&&failure!=='COMMAND_IN_PROGRESS';
  assert.equal(result.committed,rejected?false:null);assert.equal(result.commitStatus,rejected?'rejected':'unknown');
  assert.match(result.recovery,rejected?/无需 result 查询/:/result 查询同一 commandId/);
 }
 assert.equal(calls.filter(path=>path.startsWith('/api/commands/')).length,0);
});

test('编辑工具合并检查和图片、稳定命令重试，截图失败不冒充提交失败',async t=>{
 const root=await mkdtemp(join(tmpdir(),'aico-tool-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const capabilityPath=await writeWorkspaceCapability(root,{url:'http://127.0.0.1:1234',token:'private'});
 let tool,badPicture=false;const edits=[];
 installEditingTools({tools:{register(t){tool=t;}},attachments:{saveImage:async()=>({id:'image'})}},'http://127.0.0.1:1235/?token=secret',{
  request:async(url,options)=>{
   const path=new URL(url).pathname;
   let value;
   if(path.includes('editing-context'))value={status:'ready',capabilityPath};
   else if(path==='/api/actions'){edits.push(JSON.parse(options.body));value={committed:true,revision:4,diagnosticsPending:false};}
   else if(path==='/api/inspect'||path==='/api/view'){
    if(badPicture)return {ok:false,json:async()=>({code:'VIEW_FAILED',message:'截图失败'})};
    value={image:Buffer.from('png').toString('base64'),revision:4,page:{pageKey:'p'},stateId:'state'};
   }else value={committed:null};
   return {ok:true,json:async()=>value};
  }});
 const exec={agent:{session:{id:'s'}},signal:new AbortController().signal};
 const args={operation:'edit',expectedRevision:3,commandId:'11111111-1111-4111-a111-111111111111',actions:[{target:{pageKey:'p'},kind:'hide',payload:{}}]};
 const result=await tool.execute(args,exec);
 assert.equal(result.committed,true);assert.equal(result.visualStatus,'ready');
 assert.equal(tool.output.render({},result)[1].type,'image');
 badPicture=true;
 const retried=await tool.execute(args,exec);
 assert.deepEqual(edits[0],edits[1]);
 assert.equal(retried.committed,true);assert.equal(retried.visualStatus,'pending');
 assert.equal(edits.length,2,'截图错误不再次执行修改');
});

test('工作项身份不能当作区域 taskId；普通查看无需 taskId',async t=>{
 const root=await mkdtemp(join(tmpdir(),'aico-tool-id-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const capabilityPath=await writeWorkspaceCapability(root,{url:'http://localhost:1235',token:'private'});
 let tool,requests=0;
 installEditingTools({tools:{register:value=>{tool=value;}}},'http://localhost:1234/?token=x',{
  request:async url=>{requests++;return new URL(url).pathname.includes('editing-context')
   ? {ok:true,json:async()=>({status:'ready',workId:'work-a',capabilityPath})}
   : {ok:false,json:async()=>({code:'TASK_NOT_FOUND',message:'找不到任务'})};}});
 const result=await tool.execute({operation:'inspect',taskId:'work-a'},{agent:{session:{id:'s'}},signal:new AbortController().signal});
 assert.equal(result.code,'WORK_ID_NOT_TASK_ID');assert.match(result.recovery,/不传 taskId/);
 assert.equal(requests,1,'不得把工作项 ID 送进区域任务检查或加载 Deck');
 assert.match(tool.parameters.properties.taskId.description,/不是/);
});

test('有标注时未判断归属不得写入；补充显式绑定一条，新修改不完成任何标注',async t=>{
 const root=await mkdtemp(join(tmpdir(),'aico-task-choice-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const capabilityPath=await writeWorkspaceCapability(root,{url:'http://localhost:1235',token:'private'});
 let tool;const writes=[];const feedbackTasks=[{taskId:'a',status:'pending'},{taskId:'b',status:'pending'}];
 installEditingTools({tools:{register:value=>{tool=value;}}},'http://localhost:1234/?token=x',{
  request:async(url,options)=>{const path=new URL(url).pathname;
   if(path.includes('editing-context'))return {ok:true,json:async()=>({status:'ready',workId:'w',capabilityPath,feedbackTasks})};
   if(path==='/api/actions'){writes.push(JSON.parse(options.body));return {ok:true,json:async()=>({revision:4})};}
   return {ok:true,json:async()=>({image:'',revision:4})};}});
 const exec={agent:{session:{id:'s'}},signal:new AbortController().signal};
 const edit={operation:'edit',workId:'w',expectedRevision:3,actions:[{target:{pageKey:'p'},kind:'setText',payload:{text:'补充的姓名'}}]};
 assert.equal((await tool.execute(edit,exec)).code,'TASK_RELATION_REQUIRED');assert.equal(writes.length,0);
 assert.equal((await tool.execute({...edit,taskRelation:'supplement'},exec)).code,'TASK_RELATION_REQUIRED');assert.equal(writes.length,0);
 assert.equal((await tool.execute({...edit,taskRelation:'new',taskId:'a'},exec)).code,'TASK_RELATION_CONFLICT');assert.equal(writes.length,0);
 await tool.execute({...edit,taskRelation:'supplement',taskId:'a'},exec);
 assert.equal(writes[0].taskId,'a');assert.equal(writes[0].actions[0].taskId,'a');
 await tool.execute({...edit,taskRelation:'new'},exec);assert.equal(writes[1].taskId,null);
 assert.equal((await tool.execute({...edit,taskRelation:'supplement',taskId:'removed'},exec)).code,'TASK_RELATION_STALE');assert.equal(writes.length,2);
});

test('本轮首次视图固定目标，翻页不漂移；换工作项后拒绝旧目标写入',async t=>{
 const root=await mkdtemp(join(tmpdir(),'aico-anchor-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const capabilityPath=await writeWorkspaceCapability(root,{url:'http://localhost:1235',token:'private'});
 const events=[{type:'turn/start',seq:1}],bodies=[];
 let tool,workId='a',pageKey='p8';
 installEditingTools({tools:{register:t=>{tool=t;}}},'http://localhost:1234/?token=x',{
  request:async(url,options)=>{
   if(new URL(url).pathname.includes('editing-context'))return {ok:true,json:async()=>({status:'ready',workId,capabilityPath,view:{pageKey}})};
   bodies.push(JSON.parse(options.body??'{}'));return {ok:true,json:async()=>({revision:1,page:{pageKey}})};
  }});
 const exec={agent:{session:{id:'s',snapshotEvents:()=>events}},signal:new AbortController().signal};
 await tool.execute({operation:'inspect'},exec);pageKey='p9';
 await tool.execute({operation:'inspect'},exec);
 assert.equal(bodies[1].pageKey,'p8');
 events.push({type:'turn/start',seq:2});await tool.execute({operation:'inspect'},exec);
 assert.equal(bodies[2].pageKey,'p9');
 workId='b';const result=await tool.execute({operation:'edit',workId:'a',expectedRevision:1,actions:[{target:{pageKey:'p8'},kind:'hide',payload:{}}]},exec);
 assert.equal(result.code,'WORKSPACE_CHANGED');assert.equal(bodies.length,3);
});

test('局部结构走融合提交并返回全部受影响页的预览，停止信号向下传递',async t=>{
 const root=await mkdtemp(join(tmpdir(),'aico-structure-tool-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const capabilityPath=await writeWorkspaceCapability(root,{url:'http://localhost:1235',token:'private'});
 const calls=[];let tool;
 installEditingTools({tools:{register:t=>{tool=t;}},attachments:{saveImage:async()=>({id:'image'})}},'http://localhost:1234/?token=x',{
  request:async(url,options)=>{
   const path=new URL(url).pathname;calls.push({path,body:JSON.parse(options.body??'{}'),signal:options.signal});
   const value=path.includes('editing-context')?{status:'ready',workId:'w',capabilityPath,feedbackTasks:[]}
    :path==='/api/local-edits'?{committed:true,revision:3,validation:{status:'passed'}}
    :{image:Buffer.from('png').toString('base64'),revision:3};
   return {ok:true,json:async()=>value};
  }});
 const signal=new AbortController().signal;
 const result=await tool.execute({operation:'structure',workId:'w',expectedRevision:1,operations:['p1','p2'].map(pageKey=>({target:{pageKey,editorId:'e'},kind:'setShape',payload:{shape:'triangle'}}))},{agent:{session:{id:'s'}},signal});
 assert.equal(calls.filter(x=>x.path==='/api/local-edits').length,1);
 assert.equal(calls.filter(x=>x.path==='/api/view').length,2);
 assert.ok(calls.every(x=>x.signal===signal));assert.equal(result.imageRefs.length,2);
 assert.equal(result.currentViewMatchesCommit,true);
 assert.deepEqual(result.affectedPages,['p1','p2']);
});
