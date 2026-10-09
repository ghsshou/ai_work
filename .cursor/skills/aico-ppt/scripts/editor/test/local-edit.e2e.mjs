import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {startFixtureServer,openEditor} from './test-helpers.mjs';

const post=async(app,path,body)=>{
 const response=await fetch(`${app.url}${path}?token=${app.token}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
};
const session=app=>fetch(`${app.url}/api/session?token=${app.token}`).then(r=>r.json());
const id='12345678-1234-4123-8123-123456789abc';
async function setup(t){
 const app=await startFixtureServer({bundle:true});t.after(()=>app.close());
 const browser=await openEditor(app);t.after(()=>browser.browser.close());
 browser.page.setDefaultTimeout(6000);
 await browser.page.locator('#deck-frame').evaluate(frame=>frame.contentDocument.querySelector('#__deck_loading_overlay')?.remove());
 const target=await browser.page.locator('#deck-frame').evaluate(frame=>frame.contentWindow.HuaweiDeckPatchRuntime.makeLocator(frame.contentDocument.querySelector('.card')));
 const operations=[{target,kind:'setShape',payload:{shape:'triangle'}}];
 return {app,...browser,target,operations};
}

test('局部形状修改一次提交、返回验证凭据、重复命令不重写并可撤销重做',async t=>{
 const {app,page,operations}=await setup(t);
 const before=await readFile(app.deckPath);
 const geometry=()=>page.frameLocator('#deck-frame').locator('.card').first().evaluate(el=>{
   const css=getComputedStyle(el);return {position:css.position,left:css.left,top:css.top,width:el.offsetWidth,height:el.offsetHeight};
 });
 const initialGeometry=await geometry();
 const result=await post(app,'/api/local-edits',{expectedRevision:0,taskId:null,commandId:id,operations});
 assert.equal(result.status,200,JSON.stringify(result.body));
 assert.equal(result.body.committed,true);
 assert.equal(result.body.validation.status,'passed');
 const state=await session(app);
 assert.equal(state.groups.length,1);assert.equal(state.sourceEdit,undefined);
 assert.equal(state.completedCommands[id].groupId,result.body.groupId);
 const repeated=await post(app,'/api/local-edits',{expectedRevision:0,taskId:null,commandId:id,operations});
 assert.equal(repeated.status,200);assert.equal(repeated.body.idempotent,true);
 assert.equal((await session(app)).revision,state.revision);
 assert.equal((await post(app,'/api/local-edits',{expectedRevision:0,commandId:id,operations:[{...operations[0],payload:{shape:'ellipse'}}]})).status,409);
 await page.waitForFunction(()=>document.querySelector('#deck-frame')?.contentDocument?.querySelector('[data-aico-shape="triangle"]'));
 assert.deepEqual(await geometry(),initialGeometry,'替换轮廓保留位置和外部样式确定的尺寸');
 const undo=await post(app,`/api/groups/${result.body.groupId}/undo`,{expectedRevision:(await session(app)).revision});
 assert.equal(undo.status,200,JSON.stringify(undo.body));
 await page.waitForFunction(()=>!document.querySelector('#deck-frame')?.contentDocument?.querySelector('[data-aico-shape]'));
 const redo=await post(app,`/api/groups/${result.body.groupId}/redo`,{expectedRevision:(await session(app)).revision});
 assert.equal(redo.status,200,JSON.stringify(redo.body));
 await page.waitForFunction(()=>document.querySelector('#deck-frame')?.contentDocument?.querySelector('[data-aico-shape="triangle"]'));
 assert.deepEqual(await readFile(app.deckPath),before,'真实 Deck 未固化前保持原状');
});

test('局部片段按目标读取；验证失败恢复工作副本并允许后续修改',async t=>{
 let reject=false;
 const app=await startFixtureServer({bundle:true,workingPatchVerifier:async()=>{if(reject)throw new Error('注入验证失败');return {ok:true};}});
 t.after(()=>app.close());const {browser,page}=await openEditor(app);t.after(()=>browser.close());
 const target=await page.locator('#deck-frame').evaluate(frame=>frame.contentWindow.HuaweiDeckPatchRuntime.makeLocator(frame.contentDocument.querySelector('.card')));
 const source=await post(app,'/api/inspect',{pageKey:target.pageKey,detail:'source',target});
 assert.equal(source.status,200);assert.match(source.body.sourceHtml,/卡片 A/);assert.doesNotMatch(source.body.sourceHtml,/第二页标题/);
 const before=await readFile(app.workingDeckPath);
 const operations=[{target,kind:'setShape',payload:{shape:'triangle'}}];
 reject=true;
 const failed=await post(app,'/api/local-edits',{expectedRevision:0,commandId:id,operations});
 assert.equal(failed.status,500);assert.deepEqual(await readFile(app.workingDeckPath),before);
 const state=await session(app);assert.equal(state.groups.length,0);assert.equal(state.sourceEdit,undefined);
 reject=false;
 const retry=await post(app,'/api/local-edits',{expectedRevision:state.revision,commandId:id,operations});
 assert.equal(retry.status,200,JSON.stringify(retry.body));
});

test('陈旧版本和错页目标不能写入；右侧文字输入不被结构编辑覆盖',async t=>{
 const {app,page,operations}=await setup(t);
 const stale=await post(app,'/api/local-edits',{expectedRevision:99,commandId:id,operations});
 assert.equal(stale.status,409);
 const wrong=await post(app,'/api/local-edits',{expectedRevision:0,commandId:id,operations:[{...operations[0],target:{...operations[0].target,pageKey:'another-page'}}]});
 assert.equal(wrong.status,409);
 await page.locator('[data-mode="edit"]').click();
 const heading=page.frameLocator('#deck-frame').locator('h2').first();
 await heading.dblclick();await heading.fill('尚未提交的输入');
 const blocked=await post(app,'/api/local-edits',{expectedRevision:0,commandId:id,operations});
 assert.equal(blocked.status,409,JSON.stringify(blocked.body));
 assert.equal(blocked.body.error,'EDITOR_INTERACTION_ACTIVE');
 assert.equal(await heading.textContent(),'尚未提交的输入');
 assert.equal((await session(app)).groups.length,0);
 assert.equal((await session(app)).sourceEdit,undefined);
});

test('取消正在验证的局部修改会回滚并释放事务，迟到结果不登记历史',async t=>{
 let unblock,mark;
 const blocked=new Promise(resolve=>{mark=resolve;});
 const wait=new Promise(resolve=>{unblock=resolve;});
 let shouldBlock=false;
 const app=await startFixtureServer({bundle:true,workingPatchVerifier:async()=>{if(shouldBlock){mark();await wait;}return {ok:true};}});
 t.after(()=>app.close());
 const {browser,page}=await openEditor(app);t.after(()=>browser.close());
 const target=await page.locator('#deck-frame').evaluate(frame=>frame.contentWindow.HuaweiDeckPatchRuntime.makeLocator(frame.contentDocument.querySelector('.card')));
 shouldBlock=true;
 const abort=new AbortController();
 const request=fetch(`${app.url}/api/local-edits?token=${app.token}`,{method:'POST',signal:abort.signal,headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:0,commandId:id,operations:[{target,kind:'setShape',payload:{shape:'triangle'}}]})}).catch(error=>error);
 await blocked;assert.ok((await session(app)).sourceEdit);
 const duplicate=await post(app,'/api/local-edits',{expectedRevision:0,commandId:id,operations:[{target,kind:'setShape',payload:{shape:'triangle'}}]});
 assert.equal(duplicate.status,409);assert.equal(duplicate.body.error,'COMMAND_IN_PROGRESS');
 abort.abort();await request;unblock();
 for(let i=0;i<100 && (await session(app)).sourceEdit;i++)await new Promise(resolve=>setTimeout(resolve,50));
 const state=await session(app);assert.equal(state.groups.length,0);assert.equal(state.completedCommands[id],undefined);
 assert.equal(state.sourceEdit,undefined);
 assert.doesNotMatch(await readFile(app.workingDeckPath,'utf8'),/data-aico-shape=/);
});

test('局部结构服务在完整浏览器重放验证下提交并保留文字',async t=>{
 const {verifyWorkingPatchReplay}=await import('../working-deck-store.mjs');
 const app=await startFixtureServer({bundle:true,workingPatchVerifier:verifyWorkingPatchReplay});t.after(()=>app.close());
 const {browser,page}=await openEditor(app);t.after(()=>browser.close());
 const target=await page.locator('#deck-frame').evaluate(frame=>frame.contentWindow.HuaweiDeckPatchRuntime.makeLocator(frame.contentDocument.querySelector('.card')));
 const result=await post(app,'/api/local-edits',{expectedRevision:0,commandId:id,operations:[{target,kind:'setShape',payload:{shape:'triangle'}}]});
 assert.equal(result.status,200,JSON.stringify(result.body));
 await page.waitForFunction(()=>document.querySelector('#deck-frame')?.contentDocument?.querySelector('[data-aico-shape="triangle"]'));
 assert.equal(await page.frameLocator('#deck-frame').locator('.card').first().textContent(),'卡片 A');
 assert.equal((await session(app)).sourceEdit,undefined);
});


test('无反馈任务的局部结构撤销重做也跨页定位',async t=>{
 const {app,page,operations}=await setup(t);
 const result=await post(app,'/api/local-edits',{expectedRevision:0,commandId:id,operations});
 assert.equal(result.status,200);
 for(const [method,revision] of [['undo',3],['redo',4]]){
   await page.waitForFunction(()=>document.querySelector('.history-controls')?.dataset.busy==='false');
   await page.locator('.page-item[data-page-index="2"]').click();
   await page.waitForFunction(()=>document.querySelector('.page-item[aria-current="page"]')?.dataset.pageIndex==='2');
   await page.locator(`[data-history-${method}]`).click();
   await page.waitForFunction(expected=>document.querySelector('[data-revision]')?.textContent===String(expected),revision);
   await page.waitForFunction(()=>document.querySelector('.page-item[aria-current="page"]')?.dataset.pageIndex==='1');
 }
});
