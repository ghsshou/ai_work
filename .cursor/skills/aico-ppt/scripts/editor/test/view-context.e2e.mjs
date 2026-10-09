import test from 'node:test';
import assert from 'node:assert/strict';
import {startFixtureServer,openEditor} from './test-helpers.mjs';
import {resolveEditingContext} from '../dsh-editing-context.mjs';
import {installEditingTools} from '../../../integrations/dsh/editing-tools.mjs';

test('切到第二页后自然语言工具默认读取第二页，未指定页时不回到封面',async t=>{
 const app=await startFixtureServer({bundle:true,autoStartAgentTerminal:false});t.after(()=>app.close());
 const {browser,page}=await openEditor(app);t.after(()=>browser.close());page.setDefaultTimeout(5000);
 const second=page.locator('[data-page-key]').nth(1);
 const key=await second.getAttribute('data-page-key');
 await second.click();
 await page.waitForFunction(key=>document.querySelector('[data-page-key][aria-current="page"]')?.dataset.pageKey===key,key);
 await new Promise(resolve=>setTimeout(resolve,600));
 assert.equal(app.viewContext.pageKey,key);
 const resolveContext=()=>resolveEditingContext({sessionId:'s',workCatalog:{resolveByDshSession:async()=>({kind:'editing',workId:'w',deckPath:app.deckPath,projectRoot:'/project'})},findEditingRuntime:()=>({app})});
 const context=await resolveContext();
 assert.equal(context.view.pageKey,key);
 assert.equal(context.project.projectRoot,'/project');
 let tool;
 installEditingTools({tools:{register:v=>{tool=v;}},attachments:{saveImage:async()=>({id:'image'})}},'http://localhost/?token=test',{
  request:(url,options)=>new URL(url).pathname.includes('editing-context')?Promise.resolve({ok:true,json:resolveContext}):fetch(url,options)});
 const result=await tool.execute({operation:'inspect'},{agent:{session:{id:'s'}},signal:AbortSignal.timeout(30000)});
 assert.equal(result.page.pageKey,key);
 assert.equal(result.page.index,2);
 assert.equal(result.visualStatus,'ready');
 const explicit=await tool.execute({operation:'inspect',pageKey:'1'},{agent:{session:{id:'s'}},signal:AbortSignal.timeout(30000)});
 assert.equal(explicit.page.index,1);
 });

test('右侧选区与滚动位置上报，普通 Agent 凭据不能伪造视图',async t=>{
 const app=await startFixtureServer({autoStartAgentTerminal:false});t.after(()=>app.close());
 const {browser,page}=await openEditor(app);t.after(()=>browser.close());page.setDefaultTimeout(5000);
 const second=page.locator('[data-page-key]').nth(1);
 const key=await second.getAttribute('data-page-key');
 await second.click();
 await page.locator('[data-mode="edit"]').click();
 const selected=page.frameLocator('#deck-frame').locator('.slide-canvas').nth(1).locator('h2');
 await selected.click({position:{x:20,y:10}});
 await new Promise(resolve=>setTimeout(resolve,600));
 assert.equal(app.viewContext.selection.target.pageKey,key);
 assert.ok(app.viewContext.selection.text.length>0);
 const scroll=await page.frameLocator('#deck-frame').locator('body').evaluate(()=>({x:document.scrollingElement.scrollLeft,y:document.scrollingElement.scrollTop}));
 assert.deepEqual(app.viewContext.scroll,scroll);
 const unauthorized=await fetch(new URL(`/api/view-context?token=${app.token}`,app.url),{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pageKey:'forged',revision:app.session.revision})});
 assert.equal(unauthorized.status,403);
 assert.equal(app.viewContext.pageKey,key);
});
