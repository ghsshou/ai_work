import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { startFixtureServer, openEditor, dragInFrame } from './test-helpers.mjs';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=',
  'base64',
);

async function openRegionPopover(page) {
  await page.click('[data-mode="region"]');
  await dragInFrame(page, { x:100, y:100 }, { x:320, y:250 });
  const popover = page.frameLocator('#deck-frame').locator('[data-region-popover]');
  await popover.waitFor({ state:'visible' });
  return popover;
}

test('区域任务可连续选择、删除并粘贴 PNG 附件后提交真实 multipart', async t => {
  const app = await startFixtureServer();
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(async () => {
    await browser.close();
    await app.close();
  });
  await writeFile(join(dirname(app.deckPath), '说明.txt'), 'reference');
  await writeFile(join(dirname(app.deckPath), '架构.png'), PNG_BYTES);
  await writeFile(join(dirname(app.deckPath), '补充.md'), '# extra');
  const popover = await openRegionPopover(page);

  await popover.locator('textarea').fill('参考附件修改');
  let fileChooserPromise = page.waitForEvent('filechooser');
  await popover.locator('[data-attachment-choose]').click();
  let fileChooser = await fileChooserPromise;
  await fileChooser.setFiles([
    join(dirname(app.deckPath), '说明.txt'),
    join(dirname(app.deckPath), '架构.png'),
  ]);
  await popover.locator('[data-attachment-item]').nth(1).waitFor();
  fileChooserPromise = page.waitForEvent('filechooser');
  await popover.locator('[data-attachment-choose]').click();
  fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(join(dirname(app.deckPath), '补充.md'));
  await popover.locator('[data-attachment-item]').nth(2).waitFor();
  assert.equal(await popover.locator('[data-attachment-item]').count(), 3);
  await popover.locator('[data-attachment-remove]').nth(1).click();
  assert.deepEqual(
    await popover.locator('[data-attachment-name]').allTextContents(),
    ['说明.txt', '补充.md'],
  );

  await popover.locator('textarea').evaluate(async textarea => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    canvas.getContext('2d').fillRect(0, 0, 1, 1);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'clipboard.png', { type:'image/png' }));
    textarea.dispatchEvent(new ClipboardEvent('paste', {
      bubbles:true, cancelable:true, clipboardData:transfer,
    }));
  });
  await assert.doesNotReject(() => popover.locator('[data-attachment-item]').nth(2).waitFor());
  assert.match(
    await popover.locator('[data-attachment-name]').nth(2).textContent(),
    /^pasted-image-\d{8}-\d{6}-\d{3}\.png$/,
  );

  await popover.locator('[data-region-submit]').evaluate(button => button.click());
  await popover.waitFor({ state:'detached', timeout:5_000 });
  const [task] = await fetch(`${app.url}/api/tasks?token=${app.token}`).then(response => response.json());
  assert.deepEqual(task.attachments.map(item => item.source), ['selected', 'selected', 'pasted']);
  assert.equal(await readFile(task.attachments[0].path, 'utf8'), 'reference');
  assert.equal(await readFile(task.attachments[1].path, 'utf8'), '# extra');
  assert.deepEqual([...await readFile(task.attachments[2].path)].slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);

  await page.waitForSelector('[data-task-attachments-toggle]');
  const attachmentsToggle = page.locator('[data-task-attachments-toggle]');
  assert.equal(await attachmentsToggle.getAttribute('aria-expanded'), 'false');
  await attachmentsToggle.click();
  assert.equal(await attachmentsToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('[data-task-attachment]').count(), 3);
  assert.deepEqual(
    await page.locator('[data-task-attachment] strong').allTextContents(),
    task.attachments.map(item => item.name),
  );
  assert.equal(await page.locator('[data-attachment-size]').first().textContent(), '9 B');
  assert.equal(await page.locator('[data-attachment-path]').first().textContent(), task.attachments[0].path);

  await page.evaluate(() => {
    window.__copiedAttachmentPaths = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable:true,
      value:{
        writeText:async path => { window.__copiedAttachmentPaths.push(path); },
      },
    });
  });
  const copyButtons = page.locator('[data-copy-attachment-path]');
  await copyButtons.first().click();
  assert.deepEqual(
    await page.evaluate(() => window.__copiedAttachmentPaths),
    [task.attachments[0].path],
  );
  assert.equal(
    await copyButtons.first().locator('.pill-nav-label-default').textContent(),
    '已复制',
  );

  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => { throw new Error('clipboard denied'); };
  });
  await copyButtons.nth(1).click();
  assert.equal(
    await copyButtons.nth(1).locator('.pill-nav-label-default').textContent(),
    '复制失败，请手动选择路径',
  );
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('附件限制在 frame 内即时校验且普通文字 paste 保持原生行为', async t => {
  const app = await startFixtureServer();
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(async () => {
    await browser.close();
    await app.close();
  });
  const popover = await openRegionPopover(page);
  const textarea = popover.locator('textarea');
  const nativePaste = await textarea.evaluate(element => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', '普通文字');
    const event = new ClipboardEvent('paste', {
      bubbles:true, cancelable:true, clipboardData:transfer,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(nativePaste, false);

  const input = popover.locator('[data-attachment-input]');
  await input.setInputFiles(Array.from({ length:8 }, (_, index) => ({
    name:`${index + 1}.txt`, mimeType:'text/plain', buffer:Buffer.from(String(index + 1)),
  })));
  assert.equal(await popover.locator('[data-attachment-item]').count(), 8);
  await input.setInputFiles({ name:'9.txt', mimeType:'text/plain', buffer:Buffer.from('9') });
  assert.equal(await popover.locator('[data-attachment-item]').count(), 8);
  assert.match(await popover.locator('[data-region-status]').textContent(), /最多 8 个附件/);

  for (let index = 0; index < 8; index += 1) {
    await popover.locator('[data-attachment-remove]').first().click();
  }
  await input.setInputFiles({ name:'empty.bin', mimeType:'application/octet-stream', buffer:Buffer.alloc(0) });
  assert.equal(await popover.locator('[data-attachment-item]').count(), 0);
  assert.match(await popover.locator('[data-region-status]').textContent(), /不能是空文件/);
  await input.setInputFiles({
    name:'large.bin', mimeType:'application/octet-stream',
    buffer:Buffer.alloc((25 * 1024 * 1024) + 1),
  });
  assert.equal(await popover.locator('[data-attachment-item]').count(), 0);
  assert.match(await popover.locator('[data-region-status]').textContent(), /不得超过 25 MiB/);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('提交锁定控件，服务失败后保留说明、选区与 File，重试不重复附件', async t => {
  const app = await startFixtureServer();
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(async () => {
    await browser.close();
    await app.close();
  });
  let releaseFailure;
  const failureGate = new Promise(resolve => { releaseFailure = resolve; });
  let taskPosts = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks') {
      taskPosts += 1;
    }
  });
  const taskPattern = '**/api/tasks?*';
  const failFirstTask = async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await failureGate;
    return route.fulfill({
      status:500,
      contentType:'application/json',
      body:JSON.stringify({ error:'TEST_FAILURE', code:'TEST_FAILURE', message:'模拟上传失败' }),
    });
  };
  await page.route(taskPattern, failFirstTask);

  const popover = await openRegionPopover(page);
  await popover.locator('textarea').fill('失败后必须保留');
  await popover.locator('[data-attachment-input]').setInputFiles({
    name:'retry.txt', mimeType:'text/plain', buffer:Buffer.from('retry-once'),
  });
  await popover.locator('[data-region-submit]').evaluate(button => button.click());
  await popover.locator('[data-region-submit]:disabled').waitFor({ state:'attached' });
  const locked = await popover.evaluate(form => ({
    textarea:form.querySelector('textarea').disabled,
    input:form.querySelector('[data-attachment-input]').disabled,
    choose:form.querySelector('[data-attachment-choose]').disabled,
    remove:form.querySelector('[data-attachment-remove]').disabled,
    cancel:form.querySelector('[data-region-cancel]').disabled,
    submit:form.querySelector('[data-region-submit]').disabled,
  }));
  assert.deepEqual(locked, {
    textarea:true, input:true, choose:true, remove:true, cancel:true, submit:true,
  });

  releaseFailure();
  await popover.locator('[data-region-status][data-state="error"]').waitFor();
  assert.equal(await popover.locator('textarea').inputValue(), '失败后必须保留');
  assert.equal(await popover.locator('[data-attachment-item]').count(), 1);
  assert.equal(await page.frameLocator('#deck-frame').locator('[data-region-selection]').count(), 1);
  assert.deepEqual(await popover.evaluate(form => ({
    textarea:form.querySelector('textarea').disabled,
    input:form.querySelector('[data-attachment-input]').disabled,
    choose:form.querySelector('[data-attachment-choose]').disabled,
    remove:form.querySelector('[data-attachment-remove]').disabled,
    cancel:form.querySelector('[data-region-cancel]').disabled,
    submit:form.querySelector('[data-region-submit]').disabled,
  })), {
    textarea:false, input:false, choose:false, remove:false, cancel:false, submit:false,
  });

  await page.unroute(taskPattern, failFirstTask);
  await popover.locator('[data-region-submit]').evaluate(button => button.click());
  await popover.waitFor({ state:'detached', timeout:5_000 });
  const tasks = await fetch(`${app.url}/api/tasks?token=${app.token}`).then(response => response.json());
  assert.equal(taskPosts, 2);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].attachments.length, 1);
  assert.equal(await readFile(tasks[0].attachments[0].path, 'utf8'), 'retry-once');
  assert.deepEqual(browserProblems, [
    'Failed to load resource: the server responded with a status of 500 (Internal Server Error)',
  ]);
  assert.deepEqual(resourceProblems, []);
});

test('粘贴图片转码期间快捷键不得提前提交，转码完成后才允许 POST', async t => {
  const app = await startFixtureServer();
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(async () => {
    await browser.close();
    await app.close();
  });
  let taskPosts = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks') {
      taskPosts += 1;
    }
  });
  const popover = await openRegionPopover(page);
  await popover.locator('textarea').fill('等待图片转码');
  await page.locator('#deck-frame').evaluate(frameElement => {
    const frameWindow = frameElement.contentWindow;
    const original = frameWindow.createImageBitmap.bind(frameWindow);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    frameWindow.__releaseAttachmentBitmap = release;
    frameWindow.createImageBitmap = async file => {
      const bitmap = await original(file);
      await gate;
      return bitmap;
    };
  });
  await popover.locator('textarea').evaluate(async textarea => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'delayed.png', { type:'image/png' }));
    textarea.dispatchEvent(new ClipboardEvent('paste', {
      bubbles:true, cancelable:true, clipboardData:transfer,
    }));
  });
  await popover.locator('[data-region-submit]:disabled').waitFor({ state:'attached' });
  await popover.locator('textarea').press('Control+Enter');
  await page.waitForTimeout(150);
  assert.equal(taskPosts, 0);
  assert.match(await popover.locator('[data-region-status]').textContent(), /正在处理粘贴图片/);

  await page.locator('#deck-frame').evaluate(frameElement => {
    frameElement.contentWindow.__releaseAttachmentBitmap();
  });
  await popover.locator('[data-attachment-item]').waitFor();
  await popover.locator('[data-region-submit]').evaluate(button => button.click());
  await popover.waitFor({ state:'detached', timeout:5_000 });
  assert.equal(taskPosts, 1);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('旧弹窗迟到的 change 与 cancel 事件不得写入或关闭新弹窗', async t => {
  const app = await startFixtureServer();
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(async () => {
    await browser.close();
    await app.close();
  });
  let popover = await openRegionPopover(page);
  await page.locator('#deck-frame').evaluate(frameElement => {
    const document = frameElement.contentDocument;
    const frameWindow = frameElement.contentWindow;
    frameWindow.__staleAttachmentInput = document.querySelector('[data-attachment-input]');
    frameWindow.__staleRegionCancel = document.querySelector('[data-region-cancel]');
  });
  await popover.locator('[data-region-cancel]').click();

  await dragInFrame(page, { x:380, y:120 }, { x:560, y:260 });
  popover = page.frameLocator('#deck-frame').locator('[data-region-popover]');
  await popover.waitFor({ state:'visible' });
  await page.locator('#deck-frame').evaluate(frameElement => {
    const frameWindow = frameElement.contentWindow;
    const transfer = new frameWindow.DataTransfer();
    transfer.items.add(new frameWindow.File(['stale'], 'stale.txt', { type:'text/plain' }));
    Object.defineProperty(frameWindow.__staleAttachmentInput, 'files', {
      value:transfer.files, configurable:true,
    });
    frameWindow.__staleAttachmentInput.dispatchEvent(new frameWindow.Event('change'));
    frameWindow.__staleRegionCancel.click();
  });
  assert.equal(await popover.count(), 1);
  assert.equal(await popover.locator('[data-attachment-item]').count(), 0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});
