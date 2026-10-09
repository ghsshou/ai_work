#!/usr/bin/env node
// shot.mjs — 给 deck 的某一页截一张 1920x1080 JPEG（build 元素全显）
//
// 用法:
//   node shot.mjs <deck.html> <label> <out.jpg>
//
// <label> 是页面 section 的 data-label；找不到时列出全部可用 label；
// 存在同名页时只截第一个并打印警告。
//
// 退出码契约: 0 = 成功；1 = 检测到问题（label 不存在）；2 = 工具或参数错误。
//
// 依赖: Node >= 18、本机安装 Google Chrome、playwright-core。
// playwright-core 查找顺序: 环境变量 PLAYWRIGHT_CORE → import('playwright-core') → openclaw 内置路径。

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadChromium, chromiumLaunchOptions } from './load-playwright.mjs';

const [deckFile, label, outFile] = process.argv.slice(2);
if (!deckFile || !label || !outFile) { console.error('用法: node shot.mjs <deck.html> <label> <out.jpg>'); process.exit(2); }
if (!existsSync(deckFile)) { console.error(`找不到 deck 文件: ${deckFile}`); process.exit(2); }

let chromium;
try { chromium = await loadChromium(); }
catch (error) { console.error(error.message); process.exit(2); }
let browser, exitCode = 0;
try {
  browser = await chromium.launch(chromiumLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(deckFile).href, { waitUntil: 'load', timeout: 180000 }); // 单文件 deck 很大，放宽超时
  await page.waitForFunction(() => document.querySelectorAll('.stage .slide-canvas').length > 0, { timeout: 60000 });
  await page.waitForTimeout(5000); // React mount + 字体/图片 settle
  await page.addStyleTag({ content: `
    .glassbar.railtoggle,.glassbar.navbar,.glassbar.modebar,.railpanel,.railfoot,.hint,.noteschip,#__deck_loading_overlay{display:none!important;}
    /* Deck 会按 stage 可用宽度给 1920×1080 画布加缩放 transform；
       element.screenshot 会把该视觉缩放写进像素尺寸，因此验证截图必须临时恢复 1:1。 */
    .stage .slide-fit{width:1920px!important;height:1080px!important;}
    .stage .slide-canvas{content-visibility:visible!important;transform:none!important;width:1920px!important;height:1080px!important;}
    img[alt="HUAWEI"], img[data-brand-logo] { right: 30px !important; }` }); // 不强制 content-visibility 会截到白页；
  // logo 水印是 position:fixed right:22px，比 canvas 元素框更靠右，element.screenshot 会裁掉右缘 → 左移 8px 收进框内
  // build 元素全显
  await page.evaluate(() => document.querySelectorAll('.build').forEach(el => {
    el.style.opacity = '1'; el.style.transform = 'none'; el.style.filter = 'none';
  }));
  await page.waitForTimeout(400); // 强显后的重绘 settle

  // 定位目标页（CSS.escape 防 label 含引号/特殊字符；同名页只取第一个）
  const idxs = await page.evaluate(lbl => {
    const out = [];
    document.querySelectorAll('.stage .slide-canvas').forEach((c, i) => {
      if (c.querySelector(`section[data-label="${CSS.escape(lbl)}"]`)) out.push(i);
    });
    return out;
  }, label);
  if (idxs.length === 0) {
    const all = await page.evaluate(() =>
      [...document.querySelectorAll('.stage .slide-canvas section[data-label]')].map(s => s.dataset.label));
    console.error(`找不到 data-label="${label}"。可用 label（${all.length} 个）:`);
    for (const l of all) console.error('  ' + l);
    exitCode = 1;
  } else {
    if (idxs.length > 1) console.warn(`警告: data-label="${label}" 有 ${idxs.length} 个同名页，只截第一个`);
    const el = (await page.$$('.stage .slide-canvas'))[idxs[0]];
    // 原位截图：scrollIntoView 后 element screenshot（不要 position:fixed 钉页，canvas 祖先有 transform）
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600); // 滚动/懒渲染稳定
    await el.screenshot({ path: outFile, type: 'jpeg', quality: 90 }); // 90 = 清晰度/体积平衡
    console.log(`shot "${label}" -> ${outFile}`);
  }
} catch (e) {
  console.error('执行失败（浏览器/页面基础设施错误）: ' + (e?.message ?? e));
  exitCode = 2;
} finally {
  if (browser) await browser.close().catch(() => {});
}
process.exit(exitCode);
