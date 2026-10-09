import test from 'node:test';
import assert from 'node:assert/strict';
import {startFixtureServer,openEditor} from './test-helpers.mjs';
test('真实 Editor 页面重载后重新连通并上报诊断，普通凭据不可伪造', async t => {
 const app=await startFixtureServer({autoStartAgentTerminal:false});t.after(()=>app.close());
 const {browser,page}=await openEditor(app);t.after(()=>browser.close());
 const records=[];page.on('request',request=>{if(new URL(request.url()).pathname==='/api/connection-diagnostics')records.push(request.postDataJSON())});
 await page.reload();
 await page.waitForFunction(()=>document.querySelector('[data-ws-state]')?.dataset.wsState==='online');
 await new Promise(resolve=>setTimeout(resolve,200));
 assert.ok(records.some(x=>x.event==='connecting'));assert.ok(records.some(x=>x.event==='open'));
 const response=await fetch(new URL(`/api/connection-diagnostics?token=${app.token}`,app.url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:'close',code:1006})});
 assert.equal(response.status,403);
});
