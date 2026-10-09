import test from 'node:test';
import assert from 'node:assert/strict';
import {startFixtureServer,openEditor} from './test-helpers.mjs';

test('固化候选尚未发布时检查快速返回忙碌，不读取中间工作副本', {timeout:30000},async()=>{
 let release,entered,hold=false;
 const gate=new Promise(resolve=>{release=resolve;});
 const seen=new Promise(resolve=>{entered=resolve;});
 const app=await startFixtureServer({bundle:true,workingPatchVerifier:async()=>{if(hold){entered();await gate;}return {ok:true};}});
 let opened;
 try{
  opened=await openEditor(app,{allowPilotDocumentBlobAbort:true});
  const {page}=opened;
  await page.locator('#deck-frame').evaluate(frame=>frame.contentDocument.querySelector('#__deck_loading_overlay')?.remove());
  await page.locator('[data-mode="edit"]').click();
  const heading=page.frameLocator('#deck-frame').locator('h2').first();
  await heading.click();await heading.dblclick();await heading.fill('固化并发测试');await page.locator('[data-current-page]').click();
  await page.waitForFunction(()=>document.querySelector('[data-revision]')?.textContent==='1');
  hold=true;
  const failed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/solidify-deck').then(async response=>{throw new Error(`验证器启动前固化已返回：${response.status()} ${await response.text()}`);});
  failed.catch(()=>{});
  await page.locator('[data-solidify]').click();await page.locator('[data-solidify-confirm]').click();await Promise.race([seen,failed]);
  const response=await fetch(`${app.url}/api/inspect?token=${app.token}`,{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(1500)});
  assert.equal(response.status,409);assert.equal((await response.json()).code,'EDITOR_SOLIDIFYING');
  release();await page.locator('[data-solidify-dialog]').waitFor({state:'hidden'});
 }finally{release();await opened?.browser.close();await app.close();}
});
