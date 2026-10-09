import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {startFixtureServer,openEditor} from './test-helpers.mjs';
import {startServer} from '../server.mjs';
import {materializePatchBytes} from '../working-deck-store.mjs';
import {compileActionGroups} from '../action-compiler.mjs';

test('固化候选残留后重启可恢复、重做并固化，保留用户两条修改', {timeout:45000},async t=>{
 const fixture=await startFixtureServer({bundle:true,preserveRoot:true});let app=fixture;
 let ui=await openEditor(app);t.after(async()=>{await ui.browser.close();await app.close();await fixture.cleanup()});
 const session=()=>fetch(`${app.url}/api/session?token=${app.token}`).then(r=>r.json());
 const post=async(path,body)=>{const r=await fetch(`${app.url}${path}?token=${app.token}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data};
 const target=await ui.page.frameLocator('#deck-frame').locator('h2').first().evaluate(el=>window.HuaweiDeckPatchRuntime.makeLocator(el));
 await post('/api/actions',{expectedRevision:0,taskId:null,actions:[{id:'first',taskId:null,target,kind:'setText',payload:{text:'第一条修改'}}]});
 await post('/api/actions',{expectedRevision:1,taskId:null,actions:[{id:'second',taskId:null,target,kind:'setText',payload:{text:'第二条修改'}}]});
 await ui.page.waitForFunction(()=>document.querySelector('.history-controls').dataset.busy==='false');
 await ui.page.locator('[data-history-undo]').click();
 await ui.page.waitForFunction(()=>document.querySelector('[data-revision]').textContent==='3');
 const saved=await session();assert.equal(saved.timeline.cursor,1);
 // 模拟旧实现验证/恢复失败留下的候选，权威历史尚未提交固化。
 const candidate=await materializePatchBytes(await readFile(app.workingDeckPath),compileActionGroups([{active:true,actions:saved.solidifiedActions??[]},...saved.groups]));
 const deckPath=app.deckPath,workingPath=app.workingDeckPath;
 await ui.browser.close();await app.close();await writeFile(workingPath,candidate);
 app=await startServer({deckPath,host:'127.0.0.1',port:0,openBrowser:false,token:'fixture-token',editorToken:'fixture-editor-token'});
 ui=await openEditor(app);
 let recovered=await session();assert.equal(recovered.timeline.cursor,1);assert.equal(recovered.startupRecovery.code,'STAGED_PATCHES_RECOVERED');
 assert.ok(!recovered.solidifiedActions.some(action=>action.id==='first'));
 await ui.page.locator('[data-history-redo]').click();
 await ui.page.waitForFunction(()=>document.querySelector('[data-revision]').textContent==='4');
 assert.equal(await ui.page.frameLocator('#deck-frame').locator('h2').first().textContent(),'第二条修改');
 await ui.page.locator('[data-solidify]').click();await ui.page.locator('[data-solidify-confirm]').click();
 await ui.page.waitForFunction(()=>document.querySelector('[data-revision]').textContent==='5');
 recovered=await session();assert.equal(recovered.groups.length,0);
 await ui.page.waitForFunction(()=>document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent==='第二条修改');
 assert.equal(await ui.page.frameLocator('#deck-frame').locator('h2').first().textContent(),'第二条修改');
});
