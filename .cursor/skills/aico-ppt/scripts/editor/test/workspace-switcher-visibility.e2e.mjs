import test from 'node:test';
import assert from 'node:assert/strict';
import {loadChromium} from '../../verify/load-playwright.mjs';
import {startFixtureServer} from './test-helpers.mjs';
test('嵌入工具栏项目菜单不被滚动容器裁切，项目可点击', {timeout:30000}, async t=>{
 const app=await startFixtureServer({autoStartAgentTerminal:false});
 const chromium=await loadChromium(),browser=await chromium.launch({channel:'chrome',headless:true});
 t.after(async()=>{await browser.close();await app.close()});
 const page=await browser.newPage({viewport:{width:820,height:700}});
 await page.goto(`${app.url}/?token=${app.token}&editorToken=${app.editorToken}&embedded=dsh`);
 await page.evaluate(async()=>{
  const {WorkspaceSwitcher}=await import('/editor/workspace-switcher.mjs');
  const root=document.createElement('div');root.className='workspace-navigation';
  const trigger=document.createElement('button');trigger.textContent='测试切换项目';root.append(trigger);
  const topbar=document.querySelector('.topbar');topbar.prepend(root);
  new WorkspaceSwitcher({root,trigger,loadHistory:async()=>({editing:[{deckName:'目标项目'}]}),onSelect:()=>{window.selectedProject=true}});
 });
 await page.getByRole('button',{name:'测试切换项目',exact:true}).click();
 const item=page.locator('[data-workspace-task="editing"]');await item.waitFor();
 const hit=await item.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))});
 assert.equal(hit,true,'项目条目必须可见并可接收点击，不能被 topbar 裁切');
 await page.setViewportSize({width:420,height:500});
 const bounds=await page.locator('[data-workspace-switcher]').evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom}});
 assert.ok(bounds.left>=0 && bounds.right<=420 && bounds.bottom<=500);
 await page.keyboard.press('Escape');await page.locator('[data-workspace-switcher]').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'测试切换项目',exact:true}).click();
 await item.click();assert.equal(await page.evaluate(()=>window.selectedProject),true);
});
