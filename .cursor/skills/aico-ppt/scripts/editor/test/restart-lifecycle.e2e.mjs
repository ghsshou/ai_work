import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {startFixtureServer,openEditor} from './test-helpers.mjs';

async function idle(app){
 let status;
 for(let i=0;i<40;i++){status=await app.restartStatus();if(status.safe)return status;await delay(50);}
 assert.equal(status.safe,true,JSON.stringify(status));
}
test('重启状态只读：未提交输入阻止退出，已保存且可撤销的修改允许退出',async t=>{
 const app=await startFixtureServer({bundle:true});t.after(()=>app.close());
 const {browser,page}=await openEditor(app);t.after(()=>browser.close());
 await idle(app);
 const before=app.session.revision;
 await app.restartStatus();assert.equal(app.session.revision,before);
 await page.locator('#deck-frame').evaluate(frame=>frame.contentDocument.querySelector('#__deck_loading_overlay')?.remove());
 await page.locator('[data-mode="edit"]').click();
 const heading=page.frameLocator('#deck-frame').locator('h2').first();
 await heading.dblclick();await heading.fill('重启前的输入');
 assert.equal((await app.restartStatus()).safe,false);
 assert.equal(await heading.textContent(),'重启前的输入');
 assert.equal(app.session.revision,before);
 await heading.press('Control+Enter');
 await page.waitForFunction(()=>!document.querySelector('#deck-frame').contentDocument.querySelector('[contenteditable="true"]'));
 await idle(app);
 assert.ok(app.session.groups.length>0,'持久化的未固化修改仍可撤销');
 await browser.close();
 assert.equal((await app.restartStatus()).safe,false,'连接断开不能假定浏览器已保存');
});


test('源码验证进行时拒绝重启，完成后恢复空闲',async t=>{
 let block=false,release,entered;
 const gate=new Promise(resolve=>{release=resolve;});
 const started=new Promise(resolve=>{entered=resolve;});
 const app=await startFixtureServer({bundle:true,workingPatchVerifier:async()=>{if(block){entered();await gate;}return {ok:true};}});
 t.after(()=>app.close());t.after(()=>release());
 const {browser,page}=await openEditor(app);t.after(()=>browser.close());
 await idle(app);
 const target=await page.locator('#deck-frame').evaluate(frame=>frame.contentWindow.HuaweiDeckPatchRuntime.makeLocator(frame.contentDocument.querySelector('.card')));
 block=true;
 const request=fetch(`${app.url}/api/local-edits?token=${app.token}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:app.session.revision,commandId:'abcdabcd-abcd-4bcd-abcd-abcdef123456',operations:[{target,kind:'setShape',payload:{shape:'triangle'}}]})});
 await started;
 assert.equal((await app.restartStatus()).safe,false);
 release();const response=await request;assert.equal(response.status,200,await response.text());
 await idle(app);
});

test('外层任务说明草稿阻止重启，取消草稿后恢复空闲',async t=>{
 const app=await startFixtureServer({bundle:true});t.after(()=>app.close());
 const {browser,page}=await openEditor(app);t.after(()=>browser.close());
 const pageKey=await page.locator('#deck-frame').evaluate(frame=>frame.contentWindow.HuaweiDeckPatchRuntime.makeLocator(frame.contentDocument.querySelector('.card')).pageKey);
 const response=await fetch(`${app.url}/api/tasks?token=${app.token}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:app.session.revision,pageKey,pageIndex:1,pageLabel:'目录页',rect:{x:1,y:1,w:100,h:100},instruction:'原任务说明'})});
 assert.equal(response.status,201);const {task}=await response.json();
 await page.locator(`[data-task-edit="${task.id}"]`).waitFor({state:'attached'});
 const toggle=page.locator('[data-task-drawer-toggle]');
 if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
 await page.locator(`[data-task-edit="${task.id}"]`).click();
 await page.locator('[data-task-edit-input]').fill('尚未保存的说明');
 assert.equal((await app.restartStatus()).safe,false);
 await page.locator('[data-task-edit-cancel]').click();
 await idle(app);assert.equal(app.session.tasks[0].instruction,'原任务说明');
});
