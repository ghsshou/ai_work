import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { startServer } from '../server.mjs';
import { openEditor } from './test-helpers.mjs';

const SOURCE_DECK = resolve('scripts/editor/test/fixtures/interactive-state-deck.html');
const EXPECTED_PAGE_COUNT = 5;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const materialResourceProblems = problems => problems.filter(problem => (
  !/^font blob:http:\/\/127\.0\.0\.1:\d+\/[^ ]+ net::ERR_ABORTED$/.test(problem)
));

async function openDsResourceEditor(t) {
  const sourceHash = sha256(await readFile(SOURCE_DECK));
  const root = await mkdtemp(join(tmpdir(), 'aico-ppt-ds-state-'));
  const deckPath = join(root, 'interactive-state-deck.html');
  await copyFile(SOURCE_DECK, deckPath);
  const app = await startServer({
    deckPath,
    host:'127.0.0.1',
    port:0,
    openBrowser:false,
    token:'ds-state-token',
    editorToken:'ds-state-editor-token',
  });
  const opened = await openEditor(app, {
    readyTimeoutMs:20_000,
    allowPilotDocumentBlobAbort:true,
  });
  opened.page.setDefaultTimeout(5_000);
  await opened.page.waitForFunction(count => (
    document.querySelectorAll('[data-page-key]').length === count
  ), EXPECTED_PAGE_COUNT);
  await opened.page.waitForFunction(() => {
    const frame = document.querySelector('#deck-frame');
    return !frame?.contentDocument.getElementById('__deck_loading_overlay');
  });
  t.after(async () => {
    await opened.browser.close().catch(() => {});
    await app.close().catch(() => {});
    await rm(root, { recursive:true, force:true });
    assert.equal(sha256(await readFile(SOURCE_DECK)), sourceHash, '内置测试 Deck 不得被修改');
  });
  return { app, ...opened };
}

async function visiblePageState(page, label) {
  return page.locator('#deck-frame').evaluate((frame, expectedLabel) => {
    const viewportCenter = frame.contentWindow.innerHeight / 2;
    const canvas = [...frame.contentDocument.querySelectorAll('.stage .slide-canvas')]
      .filter(candidate => candidate.querySelector('section[data-label]')?.dataset.label === expectedLabel)
      .find(candidate => {
        const rect = candidate.getBoundingClientRect();
        return rect.top <= viewportCenter && rect.bottom >= viewportCenter;
      });
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      visible:rect.top <= viewportCenter && rect.bottom >= viewportCenter,
      top:rect.top,
      bottom:rect.bottom,
    };
  }, label);
}

async function activeLayer(page) {
  return page.locator('#deck-frame').evaluate(frame => {
    const viewportCenter = frame.contentWindow.innerHeight / 2;
    const canvas = [...frame.contentDocument.querySelectorAll('.stage .slide-canvas')]
      .filter(candidate => candidate.querySelector('section[data-label]')?.dataset.label === '预测主链')
      .find(candidate => {
        const rect = candidate.getBoundingClientRect();
        return rect.top <= viewportCenter && rect.bottom >= viewportCenter;
      });
    return canvas?.querySelector('[data-layer-btn][data-active]')?.getAttribute('data-layer-btn') ?? null;
  });
}

async function markTask(page, pageLabel, instruction, expectedCount) {
  const frame = page.frameLocator('#deck-frame');
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument?.documentElement
      ?.dataset.deckEditorMode === 'region'
  ));
  const frameBox = await page.locator('#deck-frame').boundingBox();
  const canvasBox = await page.locator('#deck-frame').evaluate((frame, expectedLabel) => {
    const viewportCenter = frame.contentWindow.innerHeight / 2;
    const canvas = [...frame.contentDocument.querySelectorAll('.stage .slide-canvas')]
      .filter(candidate => candidate.querySelector('section[data-label]')?.dataset.label === expectedLabel)
      .find(candidate => {
        const rect = candidate.getBoundingClientRect();
        return rect.top <= viewportCenter && rect.bottom >= viewportCenter;
      });
    const rect = canvas?.getBoundingClientRect();
    return rect ? {
      x:rect.x, y:rect.y, width:rect.width, height:rect.height,
      viewportWidth:frame.contentWindow.innerWidth,
      viewportHeight:frame.contentWindow.innerHeight,
    } : null;
  }, pageLabel);
  assert.ok(frameBox && canvasBox && canvasBox.width > 200 && canvasBox.height > 120, JSON.stringify({ frameBox, canvasBox }));
  const scaleX = frameBox.width / canvasBox.viewportWidth;
  const scaleY = frameBox.height / canvasBox.viewportHeight;
  const box = {
    x:frameBox.x + canvasBox.x * scaleX,
    y:frameBox.y + canvasBox.y * scaleY,
    width:canvasBox.width * scaleX,
    height:canvasBox.height * scaleY,
  };
  const hit = await page.locator('#deck-frame').evaluate((frame, point) => {
    const element = frame.contentDocument.elementFromPoint(point.x, point.y);
    return {
      label:element?.closest('.slide-canvas')
        ?.querySelector('section[data-label]')?.dataset.label,
      inStage:Boolean(element?.closest('.stage')),
      tag:element?.tagName,
      className:element?.getAttribute('class'),
      id:element?.id,
      ancestors:[...function* () {
        for (let current = element; current; current = current.parentElement) {
          yield `${current.tagName}#${current.id}.${current.getAttribute('class') ?? ''}`;
        }
      }()].slice(0, 6),
    };
  }, {
    x:canvasBox.x + canvasBox.width * .16,
    y:canvasBox.y + canvasBox.height * .36,
  });
  assert.equal(hit.label, pageLabel, JSON.stringify({ hit, canvasBox, frameBox }));
  assert.equal(hit.inStage, true, JSON.stringify({ hit, canvasBox, frameBox }));
  await page.mouse.move(box.x + box.width * .16, box.y + box.height * .36);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .36, box.y + box.height * .58);
  await page.mouse.up();
  await frame.locator('[data-region-popover] textarea').fill(instruction);
  await frame.locator('[data-region-submit]').click();
  try {
    await page.waitForFunction(count => (
      document.querySelectorAll('[data-task-row]').length === count
    ), expectedCount, { timeout:15_000 });
  } catch (error) {
    const diagnostics = await page.locator('#deck-frame').evaluate(frame => ({
      mode:frame.contentDocument.documentElement.dataset.deckEditorMode,
      popover:frame.contentDocument.querySelector('[data-region-popover]')?.textContent,
      status:frame.contentDocument.querySelector('[data-region-status]')?.textContent,
      taskRows:document.querySelectorAll('[data-task-row]').length,
    }));
    throw new Error(`区域任务提交未完成：${JSON.stringify(diagnostics)}`, { cause:error });
  }
}

test('内置交互 Deck 顶部目录导航与编辑器当前页保持同一个目标', async t => {
  const { page, browserProblems, resourceProblems } = await openDsResourceEditor(t);
  const frame = page.frameLocator('#deck-frame');

  await page.locator('[data-page-index="2"]').click();
  await page.waitForFunction(() => document.querySelector('[data-current-page]')?.textContent === '02 目录');

  await frame.locator('.navbar button.tab[data-idx="3"]').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-current-page]')?.textContent === '04 03·资源预测'
  ));
  await page.waitForFunction(() => {
    const frame = document.querySelector('#deck-frame');
    const center = frame?.contentWindow.innerHeight / 2;
    return [...(frame?.contentDocument.querySelectorAll('.stage .slide-canvas') ?? [])]
      .some(canvas => canvas.querySelector('section[data-label]')?.dataset.label === '03·资源预测'
        && canvas.getBoundingClientRect().top <= center
        && canvas.getBoundingClientRect().bottom >= center);
  });
  assert.equal((await visiblePageState(page, '03·资源预测'))?.visible, true);

  await frame.locator('.navbar button.tab[data-idx="2"]').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-current-page]')?.textContent === '03 01·模型结构'
  ));
  await page.waitForFunction(() => {
    const frame = document.querySelector('#deck-frame');
    const center = frame?.contentWindow.innerHeight / 2;
    return [...(frame?.contentDocument.querySelectorAll('.stage .slide-canvas') ?? [])]
      .some(canvas => canvas.querySelector('section[data-label]')?.dataset.label === '01·模型结构'
        && canvas.getBoundingClientRect().top <= center
        && canvas.getBoundingClientRect().bottom >= center);
  });
  assert.equal((await visiblePageState(page, '01·模型结构'))?.visible, true);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(materialResourceProblems(resourceProblems), []);
});

test('同页不同交互画面的区域任务可分别恢复标记时的完整页面状态', async t => {
  const { app, page, browserProblems, resourceProblems } = await openDsResourceEditor(t);
  const frame = page.frameLocator('#deck-frame');

  await page.locator('[data-page-index="5"]').click();
  await page.waitForFunction(() => document.querySelector('[data-current-page]')?.textContent === '05 预测主链');
  assert.equal(await activeLayer(page), 'capacity');

  await page.locator('[data-mode="region"]').click();
  await markTask(page, '预测主链', '容量画面任务', 1);

  await page.locator('[data-mode="preview"]').click();
  await page.locator('#deck-frame').evaluate(frame => {
    const viewportCenter = frame.contentWindow.innerHeight / 2;
    const canvas = [...frame.contentDocument.querySelectorAll('.stage .slide-canvas')]
      .filter(candidate => candidate.querySelector('section[data-label]')?.dataset.label === '预测主链')
      .find(candidate => {
        const rect = candidate.getBoundingClientRect();
        return rect.top <= viewportCenter && rect.bottom >= viewportCenter;
      });
    canvas?.querySelector('[data-layer-btn="performance"]')?.click();
  });
  assert.equal(await activeLayer(page), 'performance');
  await page.locator('[data-mode="region"]').click();
  await markTask(page, '预测主链', '性能画面任务', 2);

  const tasks = await fetch(`${app.url}/api/tasks?token=${app.token}`).then(response => response.json());
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every(task => task.pageState?.schema === 1), JSON.stringify(tasks));
  assert.notDeepEqual(tasks[0].pageState, tasks[1].pageState);

  const drawer = page.locator('[data-task-drawer]');
  if (await drawer.getAttribute('data-open') !== 'true') {
    await page.locator('[data-task-drawer-toggle]').click();
  }
  await page.locator('[data-task-row]').filter({ hasText:'容量画面任务' })
    .locator('[data-task-locate]').click();
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument
      .querySelector('.stage section[data-label="预测主链"] [data-layer-btn="capacity"]')
      ?.hasAttribute('data-active') === true
  ));

  if (await drawer.getAttribute('data-open') !== 'true') {
    await page.locator('[data-task-drawer-toggle]').click();
  }
  await page.locator('[data-task-row]').filter({ hasText:'性能画面任务' })
    .locator('[data-task-locate]').click();
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument
      .querySelector('.stage section[data-label="预测主链"] [data-layer-btn="performance"]')
      ?.hasAttribute('data-active') === true
  ));
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(materialResourceProblems(resourceProblems), []);
});

test('目录页重绘不触发页面重定位，不同标题状态可随区域任务恢复', async t => {
  const { app, page, browserProblems, resourceProblems } = await openDsResourceEditor(t);
  const frame = page.frameLocator('#deck-frame');

  await page.locator('[data-page-index="2"]').click();
  await page.waitForFunction(() => document.querySelector('[data-current-page]')?.textContent === '02 目录');
  await page.locator('[data-mode="preview"]').click();

  const beforeScroll = await page.locator('#deck-frame').evaluate(frame => {
    const stage = frame.contentDocument.querySelector('.stage');
    stage.scrollTop += 36;
    return stage.scrollTop;
  });
  await frame.locator('#tocList [data-mod="1"]').click();
  await page.waitForTimeout(450);
  const afterScroll = await page.locator('#deck-frame').evaluate(frame => (
    frame.contentDocument.querySelector('.stage').scrollTop
  ));
  assert.ok(Math.abs(afterScroll - beforeScroll) <= 1, JSON.stringify({ beforeScroll, afterScroll }));

  await page.locator('[data-mode="region"]').click();
  await markTask(page, '目录', '训推适配目录画面', 1);

  await page.locator('[data-mode="preview"]').click();
  await frame.locator('#tocList [data-mod="2"]').click();
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument.querySelector('#tocVisual')
      ?.textContent.includes('CHAPTER 03') === true
  ));
  await page.locator('[data-mode="region"]').click();
  await markTask(page, '目录', '资源预测目录画面', 2);

  const tasks = await fetch(`${app.url}/api/tasks?token=${app.token}`).then(response => response.json());
  assert.equal(tasks.length, 2);
  assert.notDeepEqual(tasks[0].pageState, tasks[1].pageState);

  const drawer = page.locator('[data-task-drawer]');
  if (await drawer.getAttribute('data-open') !== 'true') {
    await page.locator('[data-task-drawer-toggle]').click();
  }
  await page.locator('[data-task-row]').filter({ hasText:'训推适配目录画面' })
    .locator('[data-task-locate]').click();
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument.querySelector('#tocVisual')
      ?.textContent.includes('CHAPTER 02') === true
  ));

  if (await drawer.getAttribute('data-open') !== 'true') {
    await page.locator('[data-task-drawer-toggle]').click();
  }
  await page.locator('[data-task-row]').filter({ hasText:'资源预测目录画面' })
    .locator('[data-task-locate]').click();
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument.querySelector('#tocVisual')
      ?.textContent.includes('CHAPTER 03') === true
  ));

  assert.deepEqual(browserProblems, []);
  assert.deepEqual(materialResourceProblems(resourceProblems), []);
});
