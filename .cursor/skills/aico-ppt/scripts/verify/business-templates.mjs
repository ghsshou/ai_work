#!/usr/bin/env node
// 两套业务模板的离线浏览器回归：页面、证据资源与实际 layer 点击。
import assert from 'node:assert/strict';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {loadChromium, chromiumLaunchOptions} from './load-playwright.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const browser = await (await loadChromium()).launch(chromiumLaunchOptions());
try {
  for (const [kind, count] of [['qualification',22], ['project-review',54]]) {
    const page = await browser.newPage({viewport:{width:1920,height:1080}});
    const errors=[];
    page.on('pageerror', e=>errors.push(e.message));
    await page.route(/^https?:/, route=>route.abort());
    await page.goto(pathToFileURL(resolve(root,`assets/${kind}-deck.html`)).href);
    await page.waitForFunction(n=>document.querySelectorAll('.stage .slide-canvas section[data-label]').length===n, count);
    await page.evaluate(()=>document.fonts.ready);
    await page.addStyleTag({content:'.stage .slide-fit{width:1920px!important;height:1080px!important}.stage .slide-canvas{content-visibility:visible!important;transform:none!important;width:1920px!important;height:1080px!important}'});
    const slides=page.locator('.stage .slide-canvas section[data-label]');
    assert.equal(await slides.count(),count);
    let states=0;
    for (let i=0;i<count;i++) {
      const slide=slides.nth(i);
      await slide.scrollIntoViewIfNeeded();
      const buttons=slide.locator('[data-layer-btn]');
      for(let j=0;j<await buttons.count();j++) {
        const b=buttons.nth(j);
        await b.evaluate(el=>el.click());
        const state=await b.evaluate(el=>{
          const s=el.closest('section'), g=el.dataset.layerGroup, k=el.dataset.layerBtn;
          const panels=[...s.querySelectorAll('[data-layer-panel]')].filter(p=>p.dataset.layerGroup===g&&p.hasAttribute('data-active'));
          const css=getComputedStyle(el);
          return {active:el.hasAttribute('data-active'),keys:panels.map(p=>p.dataset.layerPanel),key:k,color:css.color,background:css.backgroundColor,overflow:panels.map(p=>Math.max(p.scrollHeight-p.clientHeight,p.scrollWidth-p.clientWidth)),empty:panels.some(p=>!p.innerText.trim())};
        });
        assert.equal(state.active,true,`${kind} 第${i+1}页按钮未切换`);
        assert.deepEqual(state.keys,[state.key]);
        assert.notEqual(state.color,state.background,`${kind} 第${i+1}页活动按钮文字不可见`);
        assert.equal(state.empty,false,`${kind} 第${i+1}页为空面板`);
        assert.ok(state.overflow.every(n=>n<=2),`${kind} 第${i+1}页面板溢出`);
        states++;
      }
      const invalid=await slide.evaluate(s=>({
        overflow:Math.max(s.scrollHeight-s.clientHeight,s.scrollWidth-s.clientWidth),
        images:[...s.querySelectorAll('img')].filter(i=>!i.complete||!i.naturalWidth).map(i=>i.alt),
      }));
      assert.ok(invalid.overflow<=2,`${kind} 第${i+1}页溢出`);
      assert.deepEqual(invalid.images,[],`${kind} 第${i+1}页图片未加载`);
    }
    assert.deepEqual(errors,[]);
    console.log(`${kind}: ${count} 页，${states} 个交互状态；离线资源、活动文字、溢出、脚本检查通过`);
    await page.close();
  }
} finally { await browser.close(); }
