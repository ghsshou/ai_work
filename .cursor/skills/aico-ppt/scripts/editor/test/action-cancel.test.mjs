import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeService} from '../bridge-service.mjs';

test('动作准备期间取消：回滚浏览器候选，不写历史、不发送提交',async t=>{
 const state={version:1,sessionId:'cancel-test',deckPath:'/tmp/deck.html',deckFingerprint:'deck',revision:0,tasks:[],groups:[],redo:[],diagnosticsBaseline:{},diagnosticsCurrent:{},diagnosticsRevision:null,conflict:null};
 let persisted=0;const abort=new AbortController(),commands=[];
 const bridge=new BridgeService({sessionStore:{state,sessionPath:'/tmp/session.json',persistState:async()=>{persisted++;}}});
 t.after(()=>bridge.close());
 const socket={readyState:1,send(data){
   const message=JSON.parse(data);commands.push(message.type);
   if(message.type==='apply-actions'){
     abort.abort(new Error('用户取消'));
     queueMicrotask(()=>bridge.handleMessage(socket,JSON.stringify({type:'actions-prepared',commandId:message.commandId,applied:1,results:message.actions})));
   }else if(message.type==='rollback-actions')queueMicrotask(()=>bridge.handleMessage(socket,JSON.stringify({type:'actions-rolled-back',commandId:message.commandId,rolledBack:true})));
 }};
 bridge.setEditorSocket(socket);
 await assert.rejects(bridge.applyActions({taskId:null,expectedRevision:0,signal:abort.signal,actions:[{id:'action-1',taskId:null,target:{pageKey:'page-1',path:'0/1'},kind:'setText',payload:{text:'新'},before:'旧',after:'新'}]}),/用户取消/);
 assert.deepEqual(commands,['apply-actions','rollback-actions']);assert.equal(persisted,0);assert.equal(state.revision,0);assert.deepEqual(state.groups,[]);
});
