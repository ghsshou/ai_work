import assert from 'node:assert/strict';
import test from 'node:test';
import { loadChromium } from '../../verify/load-playwright.mjs';
import { startFixtureServer } from './test-helpers.mjs';

test('DSH 窄工作台中画布完整可见，缩放随窗口宽度更新', { timeout:30000 }, async t => {
  const app = await startFixtureServer({ dshAgentBridge:true });
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(async () => { await browser.close(); await app.close(); });
  const page = await browser.newPage({ viewport:{ width:1440, height:900 } });
  await page.goto(`${app.url}/?token=${app.token}&editorToken=${app.editorToken}&embedded=dsh`);
  await page.locator('[data-frame-scene]').waitFor();
  for (const width of [1440, 820, 600, 420, 1440]) {
    await page.setViewportSize({ width, height:900 });
    // 等待 ResizeObserver 的下一帧缩放，避免并行浏览器负载下固定延时误报。
    await page.waitForFunction(() => {
      const scene = document.querySelector('[data-frame-scene]').getBoundingClientRect();
      return scene.width > 0 && scene.left >= 0 && scene.right <= innerWidth + 1;
    }, null, { timeout:3000 }).catch(() => {});
    const sizes = await page.evaluate(() => {
      const scene = document.querySelector('[data-frame-scene]').getBoundingClientRect();
      const canvas = document.querySelector('.canvas-column').getBoundingClientRect();
      const topbar = document.querySelector('.topbar');
      topbar.scrollLeft = topbar.scrollWidth;
      return { toolbarScrollable:topbar.scrollWidth <= topbar.clientWidth || topbar.scrollLeft > 0, left:scene.left, right:scene.right, canvasRight:canvas.right, viewport:innerWidth };
    });
    assert.equal(sizes.toolbarScrollable, true, '工具条溢出时必须可滚动');
    assert.ok(sizes.right <= width + 1 && sizes.left >= 0 && sizes.canvasRight <= width + 1,
      `${width}px 工作台裁切画布: ${JSON.stringify(sizes)}`);
  }
});
