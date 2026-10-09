// 用法：node extract-editable.mjs <input.html> <outDir> [scale=2]
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadChromium, chromiumLaunchOptions } from '../verify/load-playwright.mjs';
import { deckFileUrl } from './path-url.mjs';
import { collectEditableScene, prepareEditableCapture, restoreEditableCapture } from './editable-scene.mjs';
import { prepareExportPage } from './export-ready.mjs';

export async function extractEditable(input, output, { scale = 2, referenceDir } = {}) {
  if (!Number.isFinite(scale) || scale < 0.5 || scale > 4) throw new Error('截图倍率必须位于 0.5–4');
  await mkdir(output, { recursive: true });
  if (referenceDir) await mkdir(referenceDir, { recursive: true });
  const chromium = await loadChromium();
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale });
    await page.goto(deckFileUrl(resolve(input)), { waitUntil: 'load', timeout: 180000 });
    await prepareExportPage(page);
    const states = await page.evaluate(() => [...document.querySelectorAll('.stage .slide-canvas')].flatMap((canvas, index) => {
      const groups = new Map();
      for (const button of canvas.querySelectorAll('[data-layer-btn]')) {
        const group = button.getAttribute('data-layer-group') || '';
        const key = button.getAttribute('data-layer-btn');
        if (![...canvas.querySelectorAll('[data-layer-panel]')].some(p => (p.getAttribute('data-layer-group') || '') === group && p.getAttribute('data-layer-panel') === key)) continue;
        if (!groups.has(group)) groups.set(group, []);
        if (!groups.get(group).includes(key)) groups.get(group).push(key);
      }
      const defaults = Object.fromEntries([...groups].map(([group, keys]) => [group, keys[0]]));
      const variants = [{ index, active: defaults }];
      for (const [group, keys] of groups) for (const key of keys.slice(1)) variants.push({ index, active: { ...defaults, [group]: key } });
      return variants;
    }));
    const handles = await page.$$('.stage .slide-canvas');
    const manifest = { schema: 1, mode: 'editable', width: 1920, height: 1080, slides: [] };
    for (const state of states) {
      await page.evaluate(({ index, active }) => {
        const canvas = document.querySelectorAll('.stage .slide-canvas')[index];
        for (const el of canvas.querySelectorAll('[data-layer-btn],[data-layer-panel]')) {
          const group = el.getAttribute('data-layer-group') || '';
          if (Object.hasOwn(active, group)) el.toggleAttribute('data-active', (el.getAttribute('data-layer-btn') ?? el.getAttribute('data-layer-panel')) === active[group]);
        }
      }, state);
      await handles[state.index].scrollIntoViewIfNeeded();
      await page.evaluate(async index => {
        const canvas = document.querySelectorAll('.stage .slide-canvas')[index];
        await Promise.all([...canvas.querySelectorAll('img')].map(img => img.decode().catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, state.index);
      const scene = await page.evaluate(collectEditableScene, state.index);
      const number = String(manifest.slides.length + 1).padStart(3, '0');
      if (referenceDir) await handles[state.index].screenshot({ path: join(referenceDir, `slide-${number}.png`), type: 'png' });
      let imageIndex = 0;
      for (const element of scene.elements) {
        if (element.type !== 'image') continue;
        const file = `slide-${number}-image-${++imageIndex}.png`;
        await page.evaluate(prepareEditableCapture, element.target);
        try {
          const [target] = await page.$$('[data-aico-export-capture]');
          await target.screenshot({ path: join(output, file), type: 'png', omitBackground: true });
        } finally {
          await page.evaluate(restoreEditableCapture);
        }
        delete element.target; element.file = file;
      }
      manifest.slides.push(scene);
      console.error(`  可编辑导出 ${number}/${states.length}：${scene.name}（${scene.elements.length} 个对象）`);
    }
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , input, output, scale = '2'] = process.argv;
  if (!input || !output) {
    console.error('用法：node extract-editable.mjs <input.html> <outDir> [scale=2]'); process.exitCode = 1;
  } else {
    try { await extractEditable(input, output, { scale: Number(scale) }); }
    catch (error) { console.error(`${error.code ?? 'PPTX_EXTRACT_FAILED'}: ${error.message}`); process.exitCode = 1; }
  }
}
