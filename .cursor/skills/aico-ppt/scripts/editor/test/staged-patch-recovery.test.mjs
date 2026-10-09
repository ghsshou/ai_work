import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {recoverStagedPatches} from '../staged-patch-recovery.mjs';
import {writeVerifiedWorkingPatches} from '../effective-deck.mjs';
import {materializePatchBytes} from '../working-deck-store.mjs';

const action={id:'pending',kind:'setText',target:{pageKey:'page-11111111111111111111111111111111',editorId:'element-11111111111111111111111111111111',path:'0',tag:'H2',fingerprint:'00000000'},payload:{text:'新标题'}};
const template='<body><div class="stage"><div class="slide-canvas"><section data-label="第一页" data-page-id="page-11111111111111111111111111111111"><h2 data-editor-id="element-11111111111111111111111111111111">原标题</h2></section></div></div></body>';
const bytes=Buffer.from('<script type="__bundler/manifest">\n{}\n</script>\n<script type="__bundler/template">\n'+JSON.stringify(template).replaceAll('</','<\\u002F')+'\n</script>');
const state=()=>({timeline:{cursor:1,entries:[{mutation:{kind:'actions',actions:[structuredClone(action)]}}]}});
async function storeWithCandidate() {
 let current=await materializePatchBytes(bytes,[action]);
 return {managed:true,embeddedPatches:[structuredClone(action)],fingerprint:'before',writes:0,
   async read(){return current},async replace(next,expected){assert.equal(expected,'before');this.writes++;current=next;this.fingerprint='after';return {fingerprint:'after'}}};
}

test('失败候选与未固化历史重叠时只清理候选，保留时间线及游标',async()=>{
 const store=await storeWithCandidate(),session=state(),saved=structuredClone(session);
 const result=await recoverStagedPatches(session,store,{verify:async path=>{assert.ok((await readFile(path)).length>0)}});
 assert.deepEqual(result.actionIds,['pending']);assert.equal(store.writes,1);assert.deepEqual(session,saved);
});
test('同 ID 不同修改拒绝恢复，不覆盖工作副本',async()=>{
 const store=await storeWithCandidate();const session=state();session.timeline.entries[0].mutation.actions[0].payload.text='不同内容';
 await assert.rejects(recoverStagedPatches(session,store),{code:'RECOVERY_REQUIRED'});assert.equal(store.writes,0);
});
test('验证器失败或恢复候选验证失败都不触碰工作副本',async()=>{
 for(const run of [store=>writeVerifiedWorkingPatches(store,[action],{verify:async()=>{throw Object.assign(new Error('验证不可用'),{code:'PATCH_REPLAY_UNAVAILABLE'})}}),store=>recoverStagedPatches(state(),store,{verify:async()=>{throw new Error('验证失败')}})]) {
  const store=await storeWithCandidate();const before=await store.read();await assert.rejects(run(store));assert.equal(store.writes,0);assert.deepEqual(await store.read(),before);
 }
});
test('验证全部成功之后才写一次工作副本',async()=>{
 const store=await storeWithCandidate();let verified=false;
 const result=await writeVerifiedWorkingPatches(store,[action],{verify:async path=>{assert.equal(store.writes,0);assert.ok((await readFile(path)).length>0);verified=true;return {ok:true}}});
 assert.ok(verified);assert.equal(store.writes,1);assert.equal(result.previousFingerprint,'before');assert.deepEqual(result.effectivePatches,[action]);
});
