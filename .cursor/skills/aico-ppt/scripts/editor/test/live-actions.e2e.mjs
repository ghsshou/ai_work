import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { dragInFrame, startFixtureServer, openEditor } from './test-helpers.mjs';
import { PatchJournal } from '../patch-journal.mjs';
import { verifyWorkingPatchReplay } from '../working-deck-store.mjs';

const execFileAsync = promisify(execFile);

async function session(app) {
  return fetch(`${app.url}/api/session?token=${app.token}`).then(response => response.json());
}

async function dragSelectionBorder(page, frame, { dx, dy, side = 'left', release = true }) {
  const handle = frame.locator(`[data-transform-move-handle="${side}"]`);
  await handle.waitFor();
  const box = await handle.boundingBox();
  const start = { x:box.x + box.width / 2, y:box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps:8 });
  if (release) await page.mouse.up();
  return { handle, start };
}

async function frameTextScreenRect(page, selector) {
  return page.locator('#deck-frame').evaluate((frame, targetSelector) => {
    const element = frame.contentDocument.querySelector(targetSelector);
    const range = frame.contentDocument.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const scaleX = frameRect.width / frame.offsetWidth;
    const scaleY = frameRect.height / frame.offsetHeight;
    return {
      left:frameRect.left + rect.left * scaleX,
      right:frameRect.left + rect.right * scaleX,
      top:frameRect.top + rect.top * scaleY,
      bottom:frameRect.top + rect.bottom * scaleY,
    };
  }, selector);
}

async function postJson(app, pathname, body) {
  const response = await fetch(`${app.url}${pathname}?token=${app.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function connectObserver(app) {
  const socket = new WebSocket(`${app.wsUrl}?token=${encodeURIComponent(app.token)}`);
  return new Promise((resolvePromise, reject) => {
    socket.once('open', () => resolvePromise(socket));
    socket.once('error', reject);
  });
}

function nextSocketMessage(socket) {
  return new Promise((resolvePromise, reject) => {
    const onMessage = data => {
      socket.off('error', onError);
      resolvePromise(JSON.parse(data));
    };
    const onError = error => {
      socket.off('message', onMessage);
      reject(error);
    };
    socket.once('message', onMessage);
    socket.once('error', onError);
  });
}

async function reloadDeckFrame(page) {
  await page.evaluate(() => {
    const frame=document.querySelector('#deck-frame');
    window.__previousDeckDocument=frame.contentDocument;
    frame.contentWindow.location.reload();
  });
  await page.waitForFunction(() => {
    const frame=document.querySelector('#deck-frame');
    return frame.contentDocument !== window.__previousDeckDocument
      && frame.contentDocument?.readyState === 'complete';
  });
}

function sessionRequestCount(resourceRequests) {
  return resourceRequests.filter(value => new URL(value).pathname === '/api/session').length;
}

function updateBundleTemplate(bundle, update) {
  const lines = String(bundle).split('\n');
  const marker = lines.findIndex(line => line.trim() === '<script type="__bundler/template">');
  if (marker < 0) throw new Error('测试 bundle 缺少 template');
  lines[marker + 1] = JSON.stringify(update(JSON.parse(lines[marker + 1])))
    .replaceAll('</', '<\\u002F');
  return lines.join('\n');
}

test('真实 parent/frame 通道让 CLI 完成文字定位与替换而不是超时', async t => {
  const app = await startFixtureServer({ bridgeTimeoutMs:250 });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  const response = await fetch(
    `${app.url}/api/text-locations?token=${app.token}`
      + `&text=${encodeURIComponent('第一页标题')}`,
  );
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.revision, 0);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].text, '第一页标题');
  assert.equal(body.results[0].occurrences, 1);

  const cli = await execFileAsync(process.execPath, [
    'scripts/editor/cli.mjs', '--url', app.url, '--token', app.token,
    'replace-text', '第一页标题', 'CLI 新标题',
  ], { cwd:process.cwd(), timeout:5_000 });
  const replaced = JSON.parse(cli.stdout);
  assert.equal(replaced.revision, 1);
  await page.waitForFunction(() => document.querySelector('#deck-frame')
    ?.contentDocument?.querySelector('h2')?.textContent === 'CLI 新标题');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
  assert.equal(await page.locator('[data-page-key]').count(), 2);
});

test('人工改字与 Agent 位移共享 canonical 日志并实时撤销重做', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();
  const target = await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));

  await page.click('[data-mode="edit"]');
  await heading.dblclick();
  await heading.fill('人工新标题');
  await heading.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');

  const afterManual = await session(app);
  assert.equal(afterManual.revision, 1);
  assert.equal(afterManual.groups.length, 1);
  assert.equal(afterManual.groups[0].taskId, null);
  assert.deepEqual(
    afterManual.groups[0].actions.map(action => ({ kind: action.kind, before: action.before, after: action.after })),
    [{ kind: 'setText', before: '第一页标题', after: '人工新标题' }],
  );

  const moved = await postJson(app, '/api/actions', {
    expectedRevision: afterManual.revision,
    taskId: null,
    actions: [{
      id: 'agent-move-1', taskId: null, target, kind: 'translate', payload: { x: 20, y: 10 },
      expectedRevision: afterManual.revision,
    }],
  });
  assert.equal(moved.response.status, 200, JSON.stringify(moved.body));
  await heading.evaluate(element => new Promise(resolve => {
    const done = () => element.style.translate === '20px 10px' && resolve();
    const observer = new MutationObserver(done);
    observer.observe(element, { attributes: true, attributeFilter: ['style'] });
    done();
  }));
  assert.equal(await heading.textContent(), '人工新标题');

  const afterAgent = await session(app);
  assert.equal(afterAgent.revision, 2);
  assert.equal(afterAgent.groups.length, 2);
  assert.deepEqual(afterAgent.groups[1].actions[0].before, { x: 0, y: 0 });
  assert.deepEqual(afterAgent.groups[1].actions[0].after, { x: 20, y: 10 });

  const undoAgent = await postJson(app, `/api/groups/${moved.body.groupId}/undo`, {
    expectedRevision: 2,
  });
  assert.equal(undoAgent.response.status, 200, JSON.stringify(undoAgent.body));
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame').contentDocument.querySelector('h2').style.translate === ''
  ));
  const manualGroupId = afterManual.groups[0].id;
  const undoManual = await postJson(app, `/api/groups/${manualGroupId}/undo`, {
    expectedRevision: 3,
  });
  assert.equal(undoManual.response.status, 200, JSON.stringify(undoManual.body));
  await heading.waitFor({ state: 'visible' });
  assert.equal(await heading.textContent(), '第一页标题');

  const redoManual = await postJson(app, `/api/groups/${manualGroupId}/redo`, {
    expectedRevision: 4,
  });
  assert.equal(redoManual.response.status, 200, JSON.stringify(redoManual.body));
  const redoAgent = await postJson(app, `/api/groups/${moved.body.groupId}/redo`, {
    expectedRevision: 5,
  });
  assert.equal(redoAgent.response.status, 200, JSON.stringify(redoAgent.body));
  await page.waitForFunction(() => {
    const element = document.querySelector('#deck-frame').contentDocument.querySelector('h2');
    return element.textContent === '人工新标题' && element.style.translate === '20px 10px';
  });

  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '6');
  await page.waitForFunction(() => {
    const element = document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2');
    return element?.textContent === '人工新标题' && element.style.translate === '20px 10px';
  });
  await page.waitForFunction(() => document.querySelector('[data-ws-state]')?.dataset.wsState === 'online');

  const beforeRejected = await session(app);
  const rejected = await postJson(app, '/api/actions', {
    expectedRevision: beforeRejected.revision,
    taskId: null,
    actions: [
      { id: 'batch-first', taskId: null, target, kind: 'translate', payload: { x: 200, y: 100 } },
      {
        id: 'batch-missing', taskId: null,
        target: { ...target, path: '999/999', fingerprint: 'missing' },
        kind: 'setText', payload: { text: '不应出现' },
      },
    ],
  });
  assert.equal(rejected.response.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error, 'TARGET_NOT_FOUND');
  assert.equal(rejected.body.failedActionId, 'batch-missing');
  const afterRejected = await session(app);
  assert.equal(afterRejected.revision, beforeRejected.revision);
  assert.deepEqual(afterRejected.groups, beforeRejected.groups);
  assert.equal(await heading.evaluate(element => element.style.translate), '20px 10px');
  assert.equal(await heading.textContent(), '人工新标题');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('持久元素身份让人工样式跨 Agent DOM 重包后继续撤销重做', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(6_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const target = await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  assert.match(target.editorId, /^element-[0-9a-f]{32}$/);

  const applied = await postJson(app, '/api/actions', {
    expectedRevision:0, taskId:null,
    actions:[{
      id:'stable-id-human-style', taskId:null, target,
      kind:'setStyle', payload:{ property:'color', value:'red' },
    }],
  });
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  await page.waitForFunction(() => getComputedStyle(
    document.querySelector('#deck-frame').contentDocument.querySelector('h2'),
  ).color === 'rgb(255, 0, 0)');

  const working = await readFile(app.workingDeckPath, 'utf8');
  const changed = updateBundleTemplate(working, template => template.replace(
    /(<h2\b[^>]*data-editor-id="element-[0-9a-f]{32}"[^>]*>第一页标题<\/h2>)/,
    '<div class="agent-layout-wrapper">$1</div>',
  ));
  assert.notEqual(changed, working, '测试前提失败：没有命中带持久身份的标题');
  const candidate = `${app.workingDeckPath}.agent-change`;
  await writeFile(candidate, changed);
  await rename(candidate, app.workingDeckPath);

  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  await page.waitForFunction(() => {
    const element = document.querySelector('#deck-frame')?.contentDocument
      ?.querySelector('.agent-layout-wrapper > h2');
    return element && getComputedStyle(element).color === 'rgb(255, 0, 0)';
  });
  const afterSource = await session(app);
  assert.deepEqual(afterSource.groups.map(group => group.mutationType), ['action', 'source']);
  const [manualGroup, sourceGroup] = afterSource.groups;

  let result = await postJson(app, `/api/groups/${sourceGroup.id}/undo`, {
    expectedRevision:2,
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  await page.waitForFunction(() => {
    const documentRoot = document.querySelector('#deck-frame')?.contentDocument;
    const element = documentRoot?.querySelector('h2');
    return !documentRoot?.querySelector('.agent-layout-wrapper')
      && element && getComputedStyle(element).color === 'rgb(255, 0, 0)';
  });

  result = await postJson(app, `/api/groups/${manualGroup.id}/undo`, {
    expectedRevision:3,
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  await page.waitForFunction(() => getComputedStyle(
    document.querySelector('#deck-frame').contentDocument.querySelector('h2'),
  ).color !== 'rgb(255, 0, 0)');

  result = await postJson(app, `/api/groups/${manualGroup.id}/redo`, {
    expectedRevision:4,
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  result = await postJson(app, `/api/groups/${sourceGroup.id}/redo`, {
    expectedRevision:5,
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  await page.waitForFunction(() => {
    const element = document.querySelector('#deck-frame')?.contentDocument
      ?.querySelector('.agent-layout-wrapper > h2');
    return element && getComputedStyle(element).color === 'rgb(255, 0, 0)';
  });
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('任务 drawer 撤销已完成任务并同步权威任务与页面效果', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const target = await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  const originalText = await heading.textContent();

  const created = await postJson(app, '/api/tasks', {
    expectedRevision:0,
    pageKey:target.pageKey,
    pageIndex:1,
    pageLabel:'目录页',
    rect:{ x:100, y:100, w:300, h:120 },
    instruction:'通过 drawer 撤销标题修改',
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const taskId = created.body.task.id;
  await page.waitForSelector(`[data-task-row="${taskId}"]`);
  assert.equal(await page.locator('[data-task-pending-count]').innerText(), '下一批 1');
  assert.equal(await page.locator('[data-task-completed-count]').innerText(), '已完成 0');
  assert.deepEqual(await page.locator('[data-page-badge]').allTextContents(), ['1']);

  const applied = await postJson(app, '/api/actions', {
    expectedRevision:1,
    taskId,
    actions:[{
      id:'drawer-task-text', taskId, target, kind:'setText',
      payload:{ text:'任务已完成标题' }, expectedRevision:1,
    }],
  });
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  await heading.evaluate(element => new Promise(resolvePromise => {
    const done = () => element.textContent === '任务已完成标题' && resolvePromise();
    const observer = new MutationObserver(done);
    observer.observe(element, { childList:true, characterData:true, subtree:true });
    done();
  }));
  await page.waitForFunction(id => {
    const row = document.querySelector(`[data-task-row="${CSS.escape(id)}"]`);
    return row?.querySelector('.task-status-completed')
      && row.querySelector(`[data-task-undo="${CSS.escape(id)}"]`);
  }, taskId);
  const completedGroup = page.locator('[data-task-completed-group]');
  assert.equal(await completedGroup.count(), 1);
  assert.equal(await completedGroup.evaluate(node => node.open), false);
  assert.match(await completedGroup.locator('summary').innerText(), /已完成 1 条/);
  assert.equal(await page.locator('[data-task-pending-count]').innerText(), '下一批 0');
  assert.equal(await page.locator('[data-task-completed-count]').innerText(), '已完成 1');
  assert.equal(await page.locator('[data-page-badge]').count(), 0);

  await completedGroup.locator('summary').click();
  await page.locator(`[data-task-undo="${taskId}"]`).click();
  await page.waitForFunction(expected => (
    document.querySelector('#deck-frame').contentDocument.querySelector('h2').textContent === expected
  ), originalText);
  await page.waitForFunction(id => {
    const row = document.querySelector(`[data-task-row="${CSS.escape(id)}"]`);
    return row?.querySelector('.task-status-completed')
      && row.querySelector(`[data-task-redo="${CSS.escape(id)}"]`);
  }, taskId);
  assert.equal(await page.locator('[data-task-completed-group]').count(), 1);
  assert.equal(await page.locator('[data-task-pending-count]').innerText(), '下一批 0');
  assert.equal(await page.locator('[data-task-completed-count]').innerText(), '已完成 1');
  assert.equal(await page.locator('[data-page-badge]').count(), 0);
  let state = await session(app);
  let task = state.tasks.find(candidate => candidate.id === taskId);
  assert.equal(state.revision, 3);
  assert.equal(task.status, 'completed');
  assert.equal(task.groupId, applied.body.groupId);
  assert.equal(task.effectState, 'undone');
  assert.equal(state.groups[0].active, false);

  await page.locator(`[data-task-redo="${taskId}"]`).click();
  await page.waitForFunction(expected => (
    document.querySelector('#deck-frame').contentDocument.querySelector('h2').textContent === expected
  ), '任务已完成标题');
  await page.waitForFunction(id => {
    const row = document.querySelector(`[data-task-row="${CSS.escape(id)}"]`);
    return row?.querySelector('.task-status-completed')
      && row.querySelector(`[data-task-undo="${CSS.escape(id)}"]`);
  }, taskId);
  state = await session(app);
  task = state.tasks.find(candidate => candidate.id === taskId);
  assert.equal(state.revision, 4);
  assert.equal(task.status, 'completed');
  assert.equal(task.groupId, applied.body.groupId);
  assert.equal(task.effectState, 'active');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('文字取消、空白和无变化均不创建动作组', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();
  await page.click('[data-mode="edit"]');
  assert.deepEqual(await page.locator('[data-mode][aria-pressed="true"]').evaluateAll(
    buttons => buttons.map(button => button.dataset.mode),
  ), ['edit']);

  await heading.dblclick();
  await heading.fill('取消的文字');
  await page.waitForTimeout(180);
  await page.screenshot({
    path: resolve(app.deckPath, '..', 'task-11-direct-edit.png'),
  });
  await heading.press('Escape');
  assert.equal(await heading.textContent(), '第一页标题');

  await heading.dblclick();
  await heading.fill('   ');
  await heading.press('Meta+Enter');
  assert.equal(await heading.textContent(), '第一页标题');

  await heading.dblclick();
  await heading.fill('第一页标题');
  await heading.press('Meta+Enter');

  const state = await session(app);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.groups, []);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('文字选区事件迟到时删除后点击外层工具栏仍提交文字修改', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  await page.click('[data-mode="edit"]');
  await heading.dblclick();
  await heading.evaluate(element => {
    const selection = element.ownerDocument.getSelection();
    const range = element.ownerDocument.createRange();
    range.setStart(element.firstChild, 0);
    range.setEnd(element.firstChild, element.firstChild.textContent.length);
    selection.removeAllRanges();
    selection.addRange(range);
    element.ownerDocument.dispatchEvent(new Event('selectionchange'));
    // 模拟浏览器尚未交付后续 selectionchange，不能让旧选区吞掉失焦提交。
    element.ownerDocument.addEventListener('selectionchange', event => event.stopImmediatePropagation(), true);
  });
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.textContent === '选中文字');
  await heading.press('Backspace');
  assert.equal(await heading.textContent(), '');
  await page.locator('[data-current-page]').click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  const state = await session(app);
  assert.equal(state.groups[0].actions[0].kind, 'setText');
  assert.equal(state.groups[0].actions[0].payload.text, '');
});

test('文字编辑全选删除会提交空字符串且刷新后不恢复原文', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();

  await page.click('[data-mode="edit"]');
  await heading.dblclick();
  await heading.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await heading.press('Backspace');
  assert.equal(await heading.textContent(), '');
  await frame.locator('.card').first().click();

  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  assert.equal(await heading.textContent(), '');
  const state = await session(app);
  const textAction = new PatchJournal(state).compile().find(action => action.kind === 'setText');
  assert.equal(textAction?.after, '');
  assert.equal(textAction?.payload?.text, '');

  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent === ''
  ));
  assert.equal(await page.frameLocator('#deck-frame').locator('h2').first().textContent(), '');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('文字编辑交互：单击文字放置光标而不自动全选', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  await page.click('[data-mode="edit"]');
  await heading.click({ position:{ x:20, y:10 } });
  assert.deepEqual(await heading.evaluate(element => {
    const selection = element.ownerDocument.getSelection();
    return {
      editable:element.getAttribute('contenteditable'),
      collapsed:selection.isCollapsed,
      text:selection.toString(),
      inside:element.contains(selection.anchorNode),
    };
  }), { editable:'plaintext-only', collapsed:true, text:'', inside:true });
});

test('文字内部拖选文本且只有选框边缘能移动文字盒', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  await page.setViewportSize({ width:1920, height:1080 });
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const frame = page.frameLocator('#deck-frame');

  await page.click('[data-mode="edit"]');
  await heading.hover();
  assert.equal(await heading.evaluate(element => getComputedStyle(element).cursor), 'text');
  await heading.click({ position:{ x:20, y:10 } });
  assert.equal(await heading.getAttribute('contenteditable'), 'plaintext-only');

  const textRect = await frameTextScreenRect(page, 'h2');
  const start = { x:textRect.right - 2, y:(textRect.top + textRect.bottom) / 2 };
  const end = { x:textRect.left + 2, y:start.y };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps:8 });
  await page.mouse.up();
  assert.ok((await heading.evaluate(element => element.ownerDocument.getSelection().toString())).length > 0);
  assert.deepEqual({ revision:(await session(app)).revision,
    translate:await heading.evaluate(element => element.style.translate) },
  { revision:0, translate:'' });

  const moveHandle = frame.locator('[data-transform-move-handle="left"]');
  await moveHandle.waitFor();
  await moveHandle.hover();
  assert.equal(await moveHandle.evaluate(element => getComputedStyle(element).cursor), 'grab');
  const handleBox = await moveHandle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 40,
    handleBox.y + handleBox.height / 2 + 20, { steps:8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  assert.notEqual(await heading.evaluate(element => element.style.translate), '');
});

test('文字修改后直接拖动选框边缘会依次保存文字与位移', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  await page.setViewportSize({ width:1920, height:1080 });
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();

  await page.click('[data-mode="edit"]');
  await heading.click({ position:{ x:20, y:10 } });
  await heading.fill('边缘移动前修改');
  await dragSelectionBorder(page, frame, { dx:36, dy:18 });
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');

  const state = await session(app);
  assert.deepEqual(state.groups.map(group => group.actions[0].kind), ['setText', 'translate']);
  assert.equal(await heading.textContent(), '边缘移动前修改');
  assert.notEqual(await heading.evaluate(element => element.style.translate), '');
});

test('文字编辑交互：白字进入编辑态仍保留原背景且只显示光标', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const before = await heading.evaluate(element => {
    element.style.color = 'rgb(255, 255, 255)';
    element.style.backgroundColor = 'rgb(31, 31, 31)';
    element.style.outline = 'none';
    const style = getComputedStyle(element);
    return {
      color:style.color,
      backgroundColor:style.backgroundColor,
      outlineStyle:style.outlineStyle,
    };
  });
  await page.click('[data-mode="edit"]');
  await heading.dblclick();
  const editing = await heading.evaluate(element => {
    const style = getComputedStyle(element);
    const selection = element.ownerDocument.getSelection();
    return {
      color:style.color,
      backgroundColor:style.backgroundColor,
      outlineStyle:style.outlineStyle,
      collapsed:selection.isCollapsed,
    };
  });
  assert.deepEqual(editing, { ...before, collapsed:true });
});

test('文字编辑交互：点击别处自动提交修改', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();
  await page.click('[data-mode="edit"]');
  await heading.dblclick();
  await heading.fill('失焦后仍然生效');
  await frame.locator('.card').first().click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  assert.equal(await heading.textContent(), '失焦后仍然生效');
});

test('统一编辑模式直接移动与缩放，单击抖动不误提交且控制点保持可点尺寸', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  // Windows/Parallels 下 1440px 测试视口会把缩放后的 Deck iframe 左缘裁到
  // 屏幕外，Playwright 的跨 frame 鼠标坐标随后可能落到宿主层。此用例验证的是
  // 连续直接变换，使用完整 1920px 画布可确保两次命中同一个真实元素。
  await page.setViewportSize({ width:1920, height:1080 });
  await page.waitForTimeout(100);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();

  await page.click('[data-mode="edit"]');
  await heading.click({ position:{ x:20, y:10 } });
  await dragSelectionBorder(page, frame, { dx:2, dy:1 });
  assert.equal((await session(app)).revision, 0);
  assert.equal(await frame.locator('[data-resize-handle]').count(), 1);

  await dragSelectionBorder(page, frame, { dx:40, dy:20 });
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  let state = await session(app);
  const move = state.groups[0].actions[0];
  assert.equal(move.kind, 'translate');
  assert.deepEqual(move.before, { x: 0, y: 0 });
  assert.ok(move.after.x !== 0 || move.after.y !== 0, JSON.stringify(move.after));
  assert.equal(
    await heading.evaluate(element => element.style.translate),
    `${move.after.x}px ${move.after.y}px`,
  );

  await dragSelectionBorder(page, frame, { dx:20, dy:10 });
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  state = await session(app);
  const repeatedMove = state.groups[1].actions[0];
  assert.deepEqual(repeatedMove.before, move.after);
  assert.ok(repeatedMove.after.x > move.after.x && repeatedMove.after.y > move.after.y);

  const card = frame.locator('.card').first();
  await card.click();
  const handle = frame.locator('[data-resize-handle]');
  const handleBox = await handle.boundingBox();
  assert.ok(handleBox.width >= 10 && handleBox.height >= 10, JSON.stringify(handleBox));
  await page.waitForTimeout(180);
  await page.screenshot({
    path: resolve(app.deckPath, '..', 'task-11-transform.png'),
  });
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 30, handleBox.y + handleBox.height / 2 + 20);
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '3');
  state = await session(app);
  const resize = state.groups[2].actions[0];
  assert.equal(resize.kind, 'resize');
  assert.ok(resize.after.width > resize.before.width, JSON.stringify(resize));
  assert.ok(resize.after.height > resize.before.height, JSON.stringify(resize));
  assert.equal(await card.evaluate(element => Number.parseFloat(element.style.width)), resize.after.width);
  assert.equal(await card.evaluate(element => Number.parseFloat(element.style.height)), resize.after.height);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('拖动松手到服务端确认期间保持最终位置，确认后可撤销', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  await page.setViewportSize({ width:1920, height:1080 });
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();
  await page.locator('#deck-frame').evaluate(frameElement => {
    frameElement.contentDocument.querySelector('#__deck_loading_overlay')?.remove();
  });

  let releaseRequest;
  let markRequestSeen;
  const requestGate = new Promise(resolvePromise => { releaseRequest = resolvePromise; });
  const requestSeen = new Promise(resolvePromise => { markRequestSeen = resolvePromise; });
  await page.route('**/api/actions*', async route => {
    markRequestSeen();
    await requestGate;
    await route.continue();
  });

  await page.click('[data-mode="edit"]');
  await heading.click({ position:{ x:20, y:10 } });
  await dragSelectionBorder(page, frame, { dx:0, dy:20 });
  await requestSeen;
  const pending = await page.locator('#deck-frame').evaluate(frameElement => {
    const document = frameElement.contentDocument;
    const preview = document.querySelector('[data-transform-commit-preview]');
    const selection = document.querySelector('[data-transform-selection]');
    if (!preview || !selection) return { preview:false };
    const previewRect = preview.getBoundingClientRect();
    const selectionRect = selection.getBoundingClientRect();
    return {
      preview:true,
      sourceHidden:Boolean(document.querySelector('[data-transform-commit-source]')),
      delta:{
        x:previewRect.left - selectionRect.left,
        y:previewRect.top - selectionRect.top,
      },
    };
  });
  assert.equal(pending.preview, true);
  assert.equal(pending.sourceHidden, true);
  assert.ok(Math.abs(pending.delta.x) < 1 && Math.abs(pending.delta.y) < 1,
    JSON.stringify(pending));

  releaseRequest();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  assert.equal(await frame.locator('[data-transform-commit-preview]').count(), 0);
  assert.equal(await heading.getAttribute('data-transform-commit-source'), null);
  await page.click('[data-history-undo]');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  assert.equal(await heading.evaluate(element => element.style.translate), '');
  await page.click('[data-history-redo]');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '3');
  const solidified = await postJson(app, '/api/solidify-deck', { expectedRevision:3 });
  assert.equal(solidified.response.status, 200, JSON.stringify(solidified.body));
  assert.equal(solidified.body.solidified, true);
  assert.deepEqual((await session(app)).groups, []);
});

test('表格内容修改后调整尺寸仍可安全重放并固化', async t => {
  const app = await startFixtureServer({
    bundle:true,
    workingPatchVerifier:path => verifyWorkingPatchReplay(path),
    fixtureTransform:source => source.replace(
      '<div class="card" style="width:300px;height:100px;overflow:hidden">卡片 A</div>',
      '<table style="position:absolute;left:100px;top:120px;width:720px;border-collapse:collapse">'
        + '<tbody><tr><td style="height:120px;border:1px solid #999;padding:12px">'
        + '<div class="table-copy">原始单元格文字</div>'
        + '</td></tr><tr><td style="height:120px;border:1px solid #999;padding:12px">'
        + '<div>第二行</div></td></tr></tbody></table>',
    ),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  await page.setViewportSize({ width:1920, height:1080 });
  const frame = page.frameLocator('#deck-frame');
  const copy = frame.locator('.table-copy');
  const cell = frame.locator('td').first();
  await page.locator('#deck-frame').evaluate(frameElement => {
    frameElement.contentDocument.querySelector('#__deck_loading_overlay')?.remove();
  });

  const copyTarget = await copy.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  let applied = await postJson(app, '/api/actions', {
    expectedRevision:0, taskId:null,
    actions:[{
      id:'table-copy-update', taskId:null, target:copyTarget,
      kind:'setText', payload:{ text:'更新后的单元格文字' }, expectedRevision:0,
    }],
  });
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  await copy.getByText('更新后的单元格文字').waitFor();
  await reloadDeckFrame(page);
  await copy.getByText('更新后的单元格文字').waitFor();
  await page.locator('#deck-frame').evaluate(frameElement => {
    frameElement.contentDocument.querySelector('#__deck_loading_overlay')?.remove();
  });

  await page.click('[data-mode="edit"]');
  await cell.click({ position:{ x:300, y:100 } });
  const handle = frame.locator('[data-resize-handle]');
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 18,
    handleBox.y + handleBox.height / 2 + 36, { steps:8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');

  const state = await session(app);
  assert.equal(state.groups[1].actions[0].kind, 'resize');
  assert.equal(state.groups[1].actions[0].target.tag, 'TR');
  assert.ok(Math.abs(
    state.groups[1].actions[0].after.width - state.groups[1].actions[0].before.width,
  ) < 1, JSON.stringify(state.groups[1].actions[0]));
  assert.ok(state.groups[1].actions[0].after.height > state.groups[1].actions[0].before.height);
  await copy.click({ position:{ x:100, y:10 } });
  assert.equal(await copy.getAttribute('contenteditable'), 'plaintext-only');
  assert.equal(await frame.locator('tr').first().getAttribute('contenteditable'), null);
  await copy.press('Escape');
  assert.doesNotMatch(
    (await page.locator('[data-history-notice]').allTextContents()).join(' '),
    /TARGET_AMBIGUOUS/,
  );
  const solidified = await postJson(app, '/api/solidify-deck', { expectedRevision:2 });
  assert.equal(solidified.response.status, 200, JSON.stringify(solidified.body));
  assert.equal(solidified.body.solidified, true);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('编辑模式用 Delete 或 Backspace 删除整个选中元素并可撤销', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const frame = page.frameLocator('#deck-frame');
  const card = frame.locator('.card').first();
  const heading = frame.locator('h2').first();

  await page.click('[data-mode="edit"]');
  await card.click();
  await frame.locator('[data-transform-selection]').waitFor();
  await frame.locator('[data-transform-move-handle="left"]').click();
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.dataset.selected === 'true');
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  await card.waitFor({ state:'hidden' });
  assert.equal(await frame.locator('[data-transform-selection]').count(), 0);
  let state = await session(app);
  assert.deepEqual(
    state.groups[0].actions.map(action => ({
      kind:action.kind, payload:action.payload, before:action.before, after:action.after,
    })),
    [{ kind:'hide', payload:{}, before:'', after:'none' }],
  );

  await page.locator('[data-history-undo]').click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  await card.waitFor({ state:'visible' });
  assert.equal(await card.evaluate(element => element.style.display), '');

  await heading.click();
  await frame.locator('[data-transform-selection]').waitFor();
  await frame.locator('[data-transform-move-handle="left"]').click();
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.dataset.selected === 'true');
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '3');
  await heading.waitFor({ state:'hidden' });
  state = await session(app);
  assert.equal(state.groups.length, 1, '撤销后新增修改会截断旧重做分支');
  assert.equal(state.groups[0].actions[0].kind, 'hide');
  assert.deepEqual(state.groups[0].actions[0].payload, {});
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

for (const scenario of [
  { mode:'move', target:'h2', kind:'translate', handle:true },
  { mode:'resize', target:'.card', kind:'resize', handle:true },
]) {
  test(`${scenario.mode} 静态点选遇到 canvas rehydrate 会清理旧 selection 并可在新节点执行动作`, async t => {
    const app = await startFixtureServer();
    t.after(() => app.close());
    const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
    t.after(() => browser.close());
    page.setDefaultTimeout(3_000);
    const frame = page.frameLocator('#deck-frame');

    await page.locator('[data-page-index="1"]').evaluate(button => {
      window.__navBeforeSelectionRehydrate = button;
      window.__selectionRehydrateReadyCount = 0;
      window.addEventListener('message', event => {
        if (event.data?.type === 'deck-ready') window.__selectionRehydrateReadyCount += 1;
      });
    });
    await page.click('[data-mode="edit"]');
    const originalSpellcheck = await frame.locator(scenario.target).first().getAttribute('spellcheck');
    await frame.locator(scenario.target).first().click();
    assert.equal(await frame.locator('[data-transform-selection]').count(), 1);
    assert.equal(await frame.locator('[data-resize-handle]').count(), scenario.handle ? 1 : 0);
    await frame.locator('[data-transform-move-handle="left"]').click();
    assert.equal(await frame.locator(scenario.target).first().getAttribute('spellcheck'), originalSpellcheck,
      '结束直接文本编辑必须原样恢复 spellcheck 属性，避免重建后的页面标识漂移');

    await page.waitForTimeout(900);
    await page.locator('#deck-frame').evaluate(frameElement => {
      const stage = frameElement.contentDocument.querySelector('.stage');
      stage.replaceChildren(...[...stage.children].map(canvas => canvas.cloneNode(true)));
    });
    await page.waitForFunction(() => window.__selectionRehydrateReadyCount > 0);
    assert.equal(await page.locator('[data-page-index="1"]')
      .evaluate(button => button === window.__navBeforeSelectionRehydrate), true);
    assert.equal(await frame.locator('[data-transform-selection]').count(), 0);
    assert.equal(await frame.locator('[data-resize-handle]').count(), 0);
    assert.equal((await session(app)).revision, 0, '断开的旧 selection 不得提交动作');

    const nextTarget = frame.locator(scenario.target).first();
    if (scenario.mode === 'move') {
      await nextTarget.click({ position:{ x:20, y:10 } });
      await dragSelectionBorder(page, frame, { dx:32, dy:16 });
    } else {
      await nextTarget.click();
      const handleBox = await frame.locator('[data-resize-handle]').boundingBox();
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + handleBox.width / 2 + 28, handleBox.y + handleBox.height / 2 + 18);
      await page.mouse.up();
    }
    await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
    const state = await session(app);
    assert.equal(state.groups[0].actions[0].kind, scenario.kind);
    assert.deepEqual(browserProblems, []);
    assert.deepEqual(resourceProblems, []);
  });
}

test('directEdit 未提交内容被 clone 后通过权威 reload 清除且仍可再次编辑', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const frame = page.frameLocator('#deck-frame');
  const authoritativeBefore = await session(app);
  await page.click('[data-page-index="2"]');
  await page.waitForFunction(() => document.querySelector('[data-current-page]')?.textContent === '02 目录页');
  let heading = frame.locator('h2').nth(1);
  await page.click('[data-mode="edit"]');
  await heading.dblclick();
  await heading.fill('未提交污染文字');
  await page.locator('#deck-frame').evaluate(frameElement => {
    window.__documentBeforeTransientClone = frameElement.contentDocument;
    window.__authoritativeReloadCount = 0;
    frameElement.addEventListener('load', () => { window.__authoritativeReloadCount += 1; });
    const stage = frameElement.contentDocument.querySelector('.stage');
    stage.replaceChildren(...[...stage.children].map(canvas => canvas.cloneNode(true)));
  });
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument !== window.__documentBeforeTransientClone
  ));
  await frame.locator('html[data-deck-editor-mode="edit"]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-current-page]')?.textContent === '02 目录页');
  heading = frame.locator('h2').nth(1);
  assert.equal(await heading.textContent(), '第二页标题');
  assert.equal(await heading.getAttribute('contenteditable'), null);
  const authoritativeAfter = await session(app);
  assert.equal(authoritativeAfter.sessionId, authoritativeBefore.sessionId);
  assert.deepEqual(authoritativeAfter.tasks, authoritativeBefore.tasks);
  assert.deepEqual(authoritativeAfter.groups, []);
  assert.equal(authoritativeAfter.revision, 0);
  assert.equal(await page.locator('[data-current-page]').textContent(), '02 目录页');
  assert.equal(await frame.locator('html').getAttribute('data-deck-editor-mode'), 'edit');
  await frame.locator('[data-direct-status]').waitFor();
  assert.match(await frame.locator('[data-direct-status]').innerText(), /页面重建.*未提交编辑已取消/);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.__authoritativeReloadCount), 1);

  await heading.dblclick();
  await heading.fill('重建后可编辑');
  await heading.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  assert.equal((await session(app)).groups[0].actions[0].after, '重建后可编辑');
});

test('tentative prepared clone 污染在 rollback 后通过权威 reload 清除', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const frame = page.frameLocator('#deck-frame');
  let heading = frame.locator('h2').first();
  const target = await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  await page.evaluate(actionTarget => {
    const frameElement = document.querySelector('#deck-frame');
    window.__tentativeMessages = [];
    window.addEventListener('message', event => {
      if (event.source === frameElement.contentWindow && event.data?.commandId === 'clone-tentative') {
        window.__tentativeMessages.push(event.data.type);
      }
    });
    frameElement.contentWindow.postMessage({
      type:'apply-actions', commandId:'clone-tentative', tentative:true,
      actions:[{ id:'clone-tentative-action', taskId:null, target:actionTarget,
        kind:'translate', payload:{ x:70, y:35 } }],
    }, location.origin);
  }, target);
  await page.waitForFunction(() => window.__tentativeMessages?.includes('actions-prepared'));
  assert.equal(await heading.evaluate(element => element.style.translate), '70px 35px');
  await page.locator('#deck-frame').evaluate(frameElement => {
    window.__documentBeforeTransientClone = frameElement.contentDocument;
    const stage = frameElement.contentDocument.querySelector('.stage');
    stage.replaceChildren(...[...stage.children].map(canvas => canvas.cloneNode(true)));
  });
  assert.equal(await frame.locator('h2').first().evaluate(element => element.style.translate), '70px 35px');
  await page.evaluate(() => {
    document.querySelector('#deck-frame').contentWindow.postMessage({
      type:'rollback-actions', commandId:'clone-tentative',
    }, location.origin);
  });
  await page.waitForFunction(() => window.__tentativeMessages?.includes('actions-rolled-back'));
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument !== window.__documentBeforeTransientClone
  ));
  heading = frame.locator('h2').first();
  assert.equal(await heading.evaluate(element => element.style.translate), '');
  assert.deepEqual((await session(app)).groups, []);
  assert.equal((await session(app)).revision, 0);

  const nextTarget = await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  const applied = await postJson(app, '/api/actions', {
    expectedRevision:0, taskId:null,
    actions:[{ id:'after-tentative-reload', taskId:null, target:nextTarget,
      kind:'translate', payload:{ x:20, y:10 } }],
  });
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  assert.equal((await session(app)).revision, 1);
});

test('transformDrag preview 被 clone 后安全取消并通过权威 reload 清除', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const frame = page.frameLocator('#deck-frame');
  let heading = frame.locator('h2').first();
  await page.click('[data-mode="edit"]');
  await heading.click({ position:{ x:20, y:10 } });
  await dragSelectionBorder(page, frame, { dx:40, dy:20, release:false });
  await page.locator('#deck-frame').evaluate(frameElement => {
    window.__documentBeforeTransientClone = frameElement.contentDocument;
    const stage = frameElement.contentDocument.querySelector('.stage');
    stage.replaceChildren(...[...stage.children].map(canvas => canvas.cloneNode(true)));
  });
  assert.notEqual(await frame.locator('h2').first().evaluate(element => element.style.translate), '');
  await page.mouse.up();
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument !== window.__documentBeforeTransientClone
  ));
  heading = frame.locator('h2').first();
  assert.equal(await heading.evaluate(element => element.style.translate), '');
  assert.deepEqual((await session(app)).groups, []);
  assert.equal((await session(app)).revision, 0);

  await frame.locator('html[data-deck-editor-mode="edit"]').waitFor();
  await heading.click({ position:{ x:20, y:10 } });
  await dragSelectionBorder(page, frame, { dx:30, dy:15 });
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  assert.equal((await session(app)).groups[0].actions[0].kind, 'translate');
});

for (const scenario of [
  { mode:'move', target:'h2', kind:'translate', handle:true },
  { mode:'resize', target:'.card', kind:'resize', handle:true },
]) {
  test(`${scenario.mode} connected selection 在 section 结构变化 rehydrate 后保留并可继续动作`, async t => {
    const app = await startFixtureServer();
    t.after(() => app.close());
    const { browser, page } = await openEditor(app);
    t.after(() => browser.close());
    page.setDefaultTimeout(4_000);
    const frame = page.frameLocator('#deck-frame');
    await page.click('[data-page-index="2"]');
    await page.waitForFunction(() => document.querySelector('[data-current-page]')?.textContent === '02 目录页');
    await page.locator('[data-page-index="2"]').evaluate(button => {
      window.__navBeforeConnectedSelection = button;
      window.__connectedSelectionReadyCount = 0;
      window.addEventListener('message', event => {
        if (event.data?.type === 'deck-ready') window.__connectedSelectionReadyCount += 1;
      });
    });
    await page.click('[data-mode="edit"]');
    const target = frame.locator(scenario.target).nth(1);
    await target.click();
    assert.equal(await frame.locator('[data-transform-selection]').count(), 1);
    await frame.locator('[data-transform-move-handle="left"]').click();
    await target.evaluate(element => {
      const marker = document.createElement('span');
      marker.dataset.connectedStructureMarker = '';
      element.closest('section[data-label]').append(marker);
    });
    await page.waitForFunction(() => window.__connectedSelectionReadyCount > 0);
    assert.equal(await page.locator('[data-page-index="2"]')
      .evaluate(button => button === window.__navBeforeConnectedSelection), true);
    await page.locator('[data-page-key][aria-current="page"]').waitFor();
    assert.equal(await page.locator('[data-current-page]').textContent(), '02 目录页');
    assert.equal(await frame.locator('[data-transform-selection]').count(), 1);
    assert.equal(await frame.locator('[data-resize-handle]').count(), scenario.handle ? 1 : 0);
    const alignment = await page.locator('#deck-frame').evaluate((frameElement, scenario) => {
      const document = frameElement.contentDocument;
      const selected = document.querySelector('[data-transform-selection]').getBoundingClientRect();
      const element = document.querySelectorAll(scenario.target)[1].getBoundingClientRect();
      const handle = document.querySelector('[data-resize-handle]')?.getBoundingClientRect();
      return {
        overlayAligned:Math.abs(selected.left - element.left) < 1
          && Math.abs(selected.top - element.top) < 1
          && Math.abs(selected.width - element.width) < 1
          && Math.abs(selected.height - element.height) < 1,
        // 小文字控制点允许向外避让；仍须覆盖右下角且不能挡住文字中心。
        handleAligned:!scenario.handle || (handle.left <= element.right && handle.right >= element.right
          && handle.top <= element.bottom && handle.bottom >= element.bottom
          && !(handle.left < element.left + element.width / 2
            && handle.right > element.left + element.width / 2
            && handle.top < element.top + element.height / 2
            && handle.bottom > element.top + element.height / 2)),
      };
    }, scenario);
    assert.deepEqual(alignment, { overlayAligned:true, handleAligned:true });
    const pageKey = await page.locator('[data-page-index="2"]').getAttribute('data-page-key');
    await page.evaluate(key => {
      const frameElement = document.querySelector('#deck-frame');
      window.__connectedDiagnostics = null;
      const listener = event => {
        if (event.source === frameElement.contentWindow
          && event.data?.commandId === 'connected-selection-diagnostics') {
          window.__connectedDiagnostics = event.data;
          window.removeEventListener('message', listener);
        }
      };
      window.addEventListener('message', listener);
      frameElement.contentWindow.postMessage({
        type:'diagnose-pages', commandId:'connected-selection-diagnostics', revision:0,
        pageKeys:[key],
      }, location.origin);
    }, pageKey);
    await page.waitForFunction(() => window.__connectedDiagnostics !== null);
    assert.equal(await page.evaluate(() => window.__connectedDiagnostics.type), 'diagnostics-result');

    if (scenario.mode === 'move') {
      await dragSelectionBorder(page, frame, { dx:30, dy:15 });
    } else {
      const handleBox = await frame.locator('[data-resize-handle]').boundingBox();
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + handleBox.width / 2 + 28, handleBox.y + handleBox.height / 2 + 18);
      await page.mouse.up();
    }
    await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
    assert.equal((await session(app)).groups[0].actions[0].kind, scenario.kind);
  });
}

test('复杂 SVG 使用 scale 且模式切换与 pagehide 清理预览和覆盖 UI', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();

  await page.click('[data-mode="edit"]');
  await heading.click({ position:{ x:20, y:10 } });
  await dragSelectionBorder(page, frame, { dx:40, dy:20, release:false });
  await page.evaluate(() => {
    const iframe = document.querySelector('#deck-frame');
    iframe.contentWindow.postMessage({ type: 'set-editor-mode', mode: 'preview' }, location.origin);
  });
  await page.waitForTimeout(50);
  await page.mouse.up();
  assert.equal(await heading.evaluate(element => element.style.translate), '');
  assert.equal((await session(app)).revision, 0);

  const svg = frame.locator('[data-test-complex-svg]');
  await page.locator('#deck-frame').evaluate(frameElement => {
    const document = frameElement.contentDocument;
    const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    element.dataset.testComplexSvg = '';
    element.setAttribute('viewBox', '0 0 200 100');
    Object.assign(element.style, {
      position: 'absolute', left: '600px', top: '300px', width: '200px', height: '100px',
      zIndex: '2', pointerEvents: 'auto',
    });
    element.innerHTML = '<g><rect width="200" height="100" fill="#c7000b"></rect></g>';
    document.querySelector('section[data-label]').append(element);
  });
  await page.click('[data-mode="edit"]');
  await frame.locator('html[data-deck-editor-mode="edit"]').waitFor();
  const clickPoint = await page.locator('#deck-frame').evaluate(frameElement => {
    const rect = frameElement.contentDocument.querySelector('[data-test-complex-svg]').getBoundingClientRect();
    const frameRect = frameElement.getBoundingClientRect();
    return {
      x: frameRect.left + (rect.left + rect.width / 2) * frameRect.width / frameElement.offsetWidth,
      y: frameRect.top + (rect.top + rect.height / 2) * frameRect.height / frameElement.offsetHeight,
    };
  });
  await page.mouse.click(clickPoint.x, clickPoint.y);
  const handle = frame.locator('[data-resize-handle]');
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 36, handleBox.y + handleBox.height / 2 + 18);
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  const state = await session(app);
  const resize = state.groups[0].actions[0];
  assert.equal(resize.kind, 'resize');
  assert.deepEqual(Object.keys(resize.payload), ['scale']);
  assert.ok(resize.after.scale > resize.before.scale, JSON.stringify(resize));
  assert.equal(await svg.evaluate(element => Number(element.style.scale)), resize.after.scale);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await page.waitForTimeout(80);
  assert.equal(await frame.locator('[data-deck-editor-ui]').count(), 0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('Journal 持久化失败时 apply/undo/redo 均回滚浏览器 tentative 状态', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const target = await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  const movedSessionDir = `${app.sessionDir}-persist-failure`;
  const moveSessionAway = () => rename(app.sessionDir, movedSessionDir);
  const restoreSession = () => rename(movedSessionDir, app.sessionDir);

  await moveSessionAway();
  let failed;
  try {
    failed = await postJson(app, '/api/actions', {
      expectedRevision: 0, taskId: null,
      actions: [{ id:'persist-apply', taskId:null, target, kind:'translate', payload:{ x:40,y:20 } }],
    });
  } finally {
    await restoreSession();
  }
  assert.equal(failed.response.status, 500, JSON.stringify(failed.body));
  assert.equal(failed.body.error, 'JOURNAL_PERSIST_FAILED');
  assert.match(failed.body.message,/已回滚/);
  assert.equal(await heading.evaluate(element => element.style.translate), '');
  assert.equal(await heading.evaluate(() => window.HuaweiDeckPatchRuntime.pendingTransactionCount()), 0);
  assert.deepEqual((await session(app)).groups, []);

  const applied = await postJson(app, '/api/actions', {
    expectedRevision: 0, taskId: null,
    actions: [{ id:'persist-base', taskId:null, target, kind:'translate', payload:{ x:40,y:20 } }],
  });
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  await moveSessionAway();
  try {
    failed = await postJson(app, `/api/groups/${applied.body.groupId}/undo`, { expectedRevision: 1 });
  } finally {
    await restoreSession();
  }
  assert.equal(failed.response.status, 500, JSON.stringify(failed.body));
  assert.equal(failed.body.error, 'JOURNAL_PERSIST_FAILED');
  assert.equal(await heading.evaluate(element => element.style.translate), '40px 20px');
  let state = await session(app);
  assert.equal(state.revision, 1);
  assert.equal(state.groups[0].active, true);

  const undone = await postJson(app, `/api/groups/${applied.body.groupId}/undo`, { expectedRevision: 1 });
  assert.equal(undone.response.status, 200, JSON.stringify(undone.body));
  await moveSessionAway();
  try {
    failed = await postJson(app, `/api/groups/${applied.body.groupId}/redo`, { expectedRevision: 2 });
  } finally {
    await restoreSession();
  }
  assert.equal(failed.response.status, 500, JSON.stringify(failed.body));
  assert.equal(failed.body.error, 'JOURNAL_PERSIST_FAILED');
  assert.equal(await heading.evaluate(element => element.style.translate), '');
  state = await session(app);
  assert.equal(state.revision, 2);
  assert.equal(state.groups[0].active, false);
  assert.equal(await heading.evaluate(() => window.HuaweiDeckPatchRuntime.pendingTransactionCount()), 0);
});

test('同一文字连续编辑两次并按组逐次撤销', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  await page.click('[data-mode="edit"]');
  await heading.dblclick(); await heading.fill('第一次'); await heading.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  await heading.dblclick();
  await heading.fill('第二次');
  await page.waitForTimeout(160);
  assert.equal(await heading.textContent(), '第二次');
  await heading.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  let state = await session(app);
  assert.equal(state.groups.length, 2);
  assert.deepEqual(state.groups.map(group => group.actions[0].after), ['第一次', '第二次']);
  let result = await postJson(app, `/api/groups/${state.groups[1].id}/undo`, { expectedRevision:2 });
  assert.equal(result.response.status, 200);
  assert.equal(await heading.textContent(), '第一次');
  result = await postJson(app, `/api/groups/${state.groups[0].id}/undo`, { expectedRevision:3 });
  assert.equal(result.response.status, 200);
  assert.equal(await heading.textContent(), '第一页标题');
});

test('刷新恢复后同一文字仍可暂停 replay 并形成第二组', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  let heading = page.frameLocator('#deck-frame').locator('h2').first();
  await page.click('[data-mode="edit"]');
  await heading.dblclick(); await heading.fill('刷新前第一次'); await heading.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent === '刷新前第一次');
  heading = page.frameLocator('#deck-frame').locator('h2').first();
  await page.click('[data-mode="edit"]');
  await heading.dblclick();
  await heading.fill('刷新后第二次');
  await page.waitForTimeout(240);
  assert.equal(await heading.textContent(), '刷新后第二次');
  assert.deepEqual(await heading.evaluate(() => ({
    active:window.HuaweiDeckPatchRuntime.activeActionCount?.(),
    suspended:window.HuaweiDeckPatchRuntime.suspendedTargetCount?.(),
    pending:window.HuaweiDeckPatchRuntime.pendingTransactionCount(),
  })), { active:1,suspended:1,pending:0 });
  await heading.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  let state=await session(app);
  assert.deepEqual(state.groups.map(group => group.actions[0].after), ['刷新前第一次','刷新后第二次']);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent === '刷新后第二次');
  heading=page.frameLocator('#deck-frame').locator('h2').first();
  let result=await postJson(app,`/api/groups/${state.groups[1].id}/undo`,{expectedRevision:2});
  assert.equal(result.response.status,200,JSON.stringify(result.body));
  assert.equal(await heading.textContent(),'刷新前第一次');
  result=await postJson(app,`/api/groups/${state.groups[0].id}/undo`,{expectedRevision:3});
  assert.equal(result.response.status,200,JSON.stringify(result.body));
  assert.equal(await heading.textContent(),'第一页标题');
  assert.deepEqual(await heading.evaluate(() => ({
    active:window.HuaweiDeckPatchRuntime.activeActionCount?.(),
    suspended:window.HuaweiDeckPatchRuntime.suspendedTargetCount?.(),
    pending:window.HuaweiDeckPatchRuntime.pendingTransactionCount(),
  })), { active:0,suspended:0,pending:0 });
});

test('重开后拒绝跳过较新文字修改，并沿历史定位器顺序撤销重做', async t => {
  const app=await startFixtureServer();
  t.after(() => app.close());
  const {browser,page}=await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  let heading=page.frameLocator('#deck-frame').locator('h2').first();
  await page.click('[data-mode="edit"]');
  await heading.dblclick(); await heading.fill('历史第一次'); await heading.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent==='1');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent==='历史第一次');
  heading=page.frameLocator('#deck-frame').locator('h2').first();
  await page.click('[data-mode="edit"]');
  await heading.dblclick(); await heading.fill('历史第二次'); await heading.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent==='2');
  const state=await session(app);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent==='历史第二次');
  heading=page.frameLocator('#deck-frame').locator('h2').first();

  let changed=await postJson(app,`/api/groups/${state.groups[0].id}/undo`,{expectedRevision:2});
  assert.equal(changed.response.status,409,JSON.stringify(changed.body));
  assert.equal(changed.body.code,'HISTORY_ORDER');
  assert.equal((await session(app)).revision,2);
  assert.equal(await heading.textContent(),'历史第二次');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent==='历史第二次');
  heading=page.frameLocator('#deck-frame').locator('h2').first();
  changed=await postJson(app,`/api/groups/${state.groups[1].id}/undo`,{expectedRevision:2});
  assert.equal(changed.response.status,200,JSON.stringify(changed.body));
  assert.equal(await heading.textContent(),'历史第一次');
  changed=await postJson(app,`/api/groups/${state.groups[0].id}/undo`,{expectedRevision:3});
  assert.equal(changed.response.status,200,JSON.stringify(changed.body));
  assert.equal(await heading.textContent(),'第一页标题');
  changed=await postJson(app,`/api/groups/${state.groups[0].id}/redo`,{expectedRevision:4});
  assert.equal(changed.response.status,200,JSON.stringify(changed.body));
  assert.equal(await heading.textContent(),'历史第一次');
  changed=await postJson(app,`/api/groups/${state.groups[1].id}/redo`,{expectedRevision:5});
  assert.equal(changed.response.status,200,JSON.stringify(changed.body));
  assert.equal(await heading.textContent(),'历史第二次');
});

test('同一 target 的 setText 与 translate 跨 kind 共享首个 locator 并可刷新恢复', async t => {
  const app=await startFixtureServer();
  t.after(() => app.close());
  const {browser,page}=await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  let heading=page.frameLocator('#deck-frame').locator('h2').first();
  const firstTarget=await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  let result=await postJson(app,'/api/actions',{
    expectedRevision:0,taskId:null,
    actions:[{id:'cross-kind-text',taskId:null,target:firstTarget,kind:'setText',payload:{text:'跨 kind 标题'}}],
  });
  assert.equal(result.response.status,200,JSON.stringify(result.body));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent==='跨 kind 标题');
  heading=page.frameLocator('#deck-frame').locator('h2').first();
  const modifiedTarget=await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  assert.notEqual(modifiedTarget.fingerprint,firstTarget.fingerprint);
  result=await postJson(app,'/api/actions',{
    expectedRevision:1,taskId:null,
    actions:[{id:'cross-kind-move',taskId:null,target:modifiedTarget,kind:'translate',payload:{x:35,y:15}}],
  });
  assert.equal(result.response.status,200,JSON.stringify(result.body));
  const compiled=new PatchJournal(await session(app)).compile();
  assert.deepEqual(compiled.map(action => action.kind),['setText','translate']);
  assert.deepEqual(compiled.map(action => action.target),[firstTarget,firstTarget]);

  await page.reload();
  await page.waitForFunction(() => {
    const element=document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2');
    return element?.textContent==='跨 kind 标题' && element.style.translate==='35px 15px';
  });
});

test('undo/redo 以完整 authoritative compiled 集合替换浏览器状态', async t => {
  const app=await startFixtureServer();
  t.after(() => app.close());
  const {browser,page}=await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const frame=page.frameLocator('#deck-frame');
  const heading=frame.locator('h2').first();
  const card=frame.locator('.card').first();
  const [headingTarget,cardTarget]=await Promise.all([
    heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element)),
    card.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element)),
  ]);
  const apply = (expectedRevision,id,target,kind,payload) => postJson(app,'/api/actions',{
    expectedRevision,taskId:null,actions:[{id,taskId:null,target,kind,payload}],
  });
  const first=await apply(0,'older-move',headingTarget,'translate',{x:20,y:10});
  const second=await apply(1,'newer-move',headingTarget,'translate',{x:40,y:20});
  assert.equal(first.response.status,200,JSON.stringify(first.body));
  assert.equal(second.response.status,200,JSON.stringify(second.body));
  let changed=await postJson(app,`/api/groups/${first.body.groupId}/undo`,{expectedRevision:2});
  assert.equal(changed.response.status,409,JSON.stringify(changed.body));
  assert.equal(changed.body.code,'HISTORY_ORDER');
  assert.equal(await heading.evaluate(element => element.style.translate),'40px 20px');
  changed=await postJson(app,`/api/groups/${second.body.groupId}/undo`,{expectedRevision:2});
  assert.equal(changed.response.status,200,JSON.stringify(changed.body));
  assert.equal(await heading.evaluate(element => element.style.translate),'20px 10px');
  changed=await postJson(app,`/api/groups/${second.body.groupId}/redo`,{expectedRevision:3});
  assert.equal(changed.response.status,200,JSON.stringify(changed.body));
  assert.equal(await heading.evaluate(element => element.style.translate),'40px 20px');

  const size=await apply(4,'older-size',cardTarget,'resize',{width:500,height:200});
  const scale=await apply(5,'newer-scale',cardTarget,'resize',{scale:1.5});
  assert.equal(size.response.status,200,JSON.stringify(size.body));
  assert.equal(scale.response.status,200,JSON.stringify(scale.body));
  changed=await postJson(app,`/api/groups/${scale.body.groupId}/undo`,{expectedRevision:6});
  assert.equal(changed.response.status,200,JSON.stringify(changed.body));
  assert.deepEqual(await card.evaluate(element => ({
    width:element.style.width,height:element.style.height,scale:element.style.scale,
  })),{width:'500px',height:'200px',scale:''});
  changed=await postJson(app,`/api/groups/${scale.body.groupId}/redo`,{expectedRevision:7});
  assert.equal(changed.response.status,200,JSON.stringify(changed.body));
  assert.deepEqual(await card.evaluate(element => ({
    width:element.style.width,height:element.style.height,scale:element.style.scale,
  })),{width:'500px',height:'200px',scale:'1.5'});
});

test('双击局部格式文字仍以单击红框圈定的整个文字盒编辑', async t => {
  const app = await startFixtureServer({
    fixtureTransform:html => html.replace(
      '<h2>第一页标题</h2>',
      '<h2 data-unified-text-box>第一段局部格式第二段</h2>',
    ),
  });
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('[data-unified-text-box]');
  const formatted = frame.locator('[data-deck-text-range-style]');
  const target = await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  const styled = await postJson(app, '/api/actions', {
    expectedRevision:0,
    taskId:null,
    actions:[{
      id:'format-local-run', taskId:null, target, kind:'setStyle',
      payload:{ property:'color', value:'#c7000b', textRange:{ start:3, end:7 } },
    }],
  });
  assert.equal(styled.response.status, 200, JSON.stringify(styled.body));
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  await formatted.waitFor();

  await page.click('[data-mode="edit"]');
  await formatted.click();
  await frame.locator('[data-transform-selection]').waitFor();
  const selectedBounds = await heading.evaluate(element => {
    const selected = document.querySelector('[data-transform-selection]').getBoundingClientRect();
    const textBox = element.getBoundingClientRect();
    return {
      sameLeft:Math.abs(selected.left - textBox.left) < 1,
      sameTop:Math.abs(selected.top - textBox.top) < 1,
      sameWidth:Math.abs(selected.width - textBox.width) < 1,
      sameHeight:Math.abs(selected.height - textBox.height) < 1,
    };
  });
  assert.deepEqual(selectedBounds, {
    sameLeft:true, sameTop:true, sameWidth:true, sameHeight:true,
  });

  await formatted.dblclick();
  const editing = frame.locator('[data-direct-editing]');
  assert.equal(await editing.count(), 1);
  assert.equal(await editing.evaluate(element => element.tagName), 'H2');
  assert.equal(await heading.locator('[data-deck-text-range-style]').count(), 1,
    '进入整框编辑时应保留局部格式结构');

  await heading.evaluate(element => {
    const textNode = element.lastChild;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.length);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.type('统一编辑');
  await editing.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  assert.equal(await heading.textContent(), '第一段局部格式统一编辑');
  assert.equal(await formatted.textContent(), '局部格式');
  assert.equal(await formatted.evaluate(element => element.style.color), 'rgb(199, 0, 11)');
  const state = await session(app);
  assert.equal(state.groups[1].actions[0].target.tag, 'H2');
  assert.equal(state.groups[1].actions[0].target.textPath, '2');

  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument
    ?.querySelector('[data-unified-text-box]')?.textContent === '第一段局部格式统一编辑');
  assert.equal(await page.frameLocator('#deck-frame')
    .locator('[data-deck-text-range-style]').textContent(), '局部格式');
});

test('文字识别兼容：富文本中的普通文字可修改且保留加粗与换行结构', async t => {
  const app = await startFixtureServer({
    fixtureTransform:html => html.replace(
      '<h2>第一页标题</h2>',
      '<h2>第一页标题</h2><p data-rich-text style="position:absolute;left:40px;top:260px;font-size:28px">普通文字 <strong>加粗文字</strong><br>换行文字</p>',
    ),
  });
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const frame = page.frameLocator('#deck-frame');
  const richText = frame.locator('[data-rich-text]');

  await page.click('[data-mode="edit"]');
  await richText.dblclick({ position:{ x:8, y:12 } });
  assert.equal(await richText.getAttribute('data-direct-editing'), '',
    '富文本应由红框对应的整个文字盒统一编辑');
  await richText.evaluate(element => {
    const textNode = element.firstChild;
    // Playwright 在 Windows 的嵌套 contenteditable 中会把 insertText 事件偶发
    // 投递两次；这里直接模拟浏览器完成输入后的 DOM，专注验证富文本分段提交、
    // 持久化与撤销/重做。普通键盘输入另有独立交互用例覆盖。
    textNode.data = '更新后的普通文字 ';
    element.dispatchEvent(new InputEvent('input', {
      bubbles:true, inputType:'insertText', data:'更新后的普通文字 ',
    }));
  });
  await frame.locator('.card').first().click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  assert.equal(
    await richText.evaluate(element => element.innerHTML),
    '更新后的普通文字 <strong>加粗文字</strong><br>换行文字',
  );
  const state = await session(app);
  assert.equal(state.groups[0].actions[0].target.textPath, '0');

  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument
      ?.querySelector('[data-rich-text]')?.innerHTML
      === '更新后的普通文字 <strong>加粗文字</strong><br>换行文字'
  ));
  assert.equal(
    await page.frameLocator('#deck-frame').locator('[data-rich-text]').evaluate(element => element.innerHTML),
    '更新后的普通文字 <strong>加粗文字</strong><br>换行文字',
  );
  await page.click('[data-history-undo]');
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument
      ?.querySelector('[data-rich-text]')?.innerHTML
      === '普通文字 <strong>加粗文字</strong><br>换行文字'
  ));
  await page.click('[data-history-redo]');
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument
      ?.querySelector('[data-rich-text]')?.innerHTML
      === '更新后的普通文字 <strong>加粗文字</strong><br>换行文字'
  ));
});

test('文字识别兼容：classless 文字块可直接修改和拖动', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const frame = page.frameLocator('#deck-frame');
  await frame.locator('.slide-canvas').first().evaluate(canvas => {
    const plain = document.createElement('div');
    plain.dataset.plainText = '';
    plain.textContent = '没有 class 的文字块';
    Object.assign(plain.style, { position:'absolute', left:'320px', top:'260px' });
    canvas.querySelector('section').append(plain);
  });
  const plain = frame.locator('[data-plain-text]');
  await page.click('[data-mode="edit"]');
  await plain.click();
  assert.equal(await plain.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
  }), true, '小字号文字中心不能被拖动热区遮挡');
  await plain.dblclick();
  await plain.fill('已识别的 classless 文字块');
  await plain.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');

  await page.click('[data-mode="edit"]');
  await plain.click();
  await frame.locator('[data-transform-selection]').waitFor();
  await dragSelectionBorder(page, frame, { dx:30, dy:20 });
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  assert.notEqual(await plain.evaluate(element => element.style.translate), '');
});

test('编辑到区域标记的消息窗口只分派区域拉框', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const frame = page.frameLocator('#deck-frame');
  await page.click('[data-mode="edit"]');
  await frame.locator('html[data-deck-editor-mode="edit"]').waitFor();
  // 必须走真实模式切换消息，单改 aria-pressed 只改变宿主按钮外观，无法证明
  // iframe 已从统一编辑态进入区域态；裁切视口下还会让鼠标偶发点中宿主层。
  await page.click('[data-mode="region"]');
  await frame.locator('html[data-deck-editor-mode="region"]').waitFor();
  await dragInFrame(page, { x:100, y:100 }, { x:320, y:240 });
  await frame.locator('[data-region-popover]').waitFor();
  assert.equal((await session(app)).revision, 0);
  assert.equal(await frame.locator('[data-transform-selection]').count(), 0);
});

test('CSS translate/scale 是移动与交互组件缩放的真实基值', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();
  await page.locator('#deck-frame').evaluate(frameElement => {
    const document=frameElement.contentDocument;
    const style=document.createElement('style');
    style.textContent='.css-shift{translate:30px 20px}.css-scale{scale:1.4}';
    document.head.append(style);
    document.querySelector('h2').classList.add('css-shift');
    const link=document.createElement('a');
    link.className='css-scale'; link.href='#';
    link.innerHTML='<span data-interactive-child>交互链接</span>';
    Object.assign(link.style,{position:'absolute',left:'500px',top:'250px',display:'block',width:'180px',height:'60px'});
    document.querySelector('section').append(link);
  });
  await page.click('[data-mode="edit"]');
  await heading.click({ position:{ x:20, y:10 } });
  await dragSelectionBorder(page, frame, { dx:20, dy:10 });
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent==='1');
  let state=await session(app);
  assert.deepEqual(state.groups[0].actions[0].before,{x:30,y:20});
  assert.notDeepEqual(state.groups[0].actions[0].after,{x:30,y:20});

  await page.click('[data-mode="edit"]');
  const link=frame.locator('a.css-scale');
  await frame.locator('[data-interactive-child]').click();
  const handle=frame.locator('[data-resize-handle]');
  const handleBox=await handle.boundingBox();
  await page.mouse.move(handleBox.x+5,handleBox.y+5); await page.mouse.down();
  await page.mouse.move(handleBox.x+35,handleBox.y+25,{steps:6}); await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent==='2');
  state=await session(app);
  const resize=state.groups[1].actions[0];
  assert.deepEqual(resize.before,{scale:1.4});
  assert.deepEqual(Object.keys(resize.payload),['scale']);
  assert.equal(resize.target.tag,'A');
  assert.equal(await link.evaluate(element => element.style.width),'180px');
});

test('prepared 后连接断开会重连同步并返回已提交成功语义', async t => {
  const app = await startFixtureServer({ bridgeTimeoutMs: 600 });
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const target = await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));

  await page.evaluate(() => {
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedSend(data) {
      originalSend.call(this, data);
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message.type === 'actions-prepared' && !window.__closedAfterPrepared) {
        window.__closedAfterPrepared = true;
        this.close();
      }
    };
  });

  const result = await postJson(app, '/api/actions', {
    expectedRevision: 0, taskId: null,
    actions: [{ id:'disconnect-prepared', taskId:null, target, kind:'translate', payload:{x:55,y:25} }],
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.commitConfirmed, false);
  assert.equal(result.body.recoveredBySync, true);
  assert.equal((await session(app)).revision, 1);
  await page.waitForFunction(() => document.querySelector('[data-ws-state]')?.dataset.wsState === 'online');
  await page.waitForFunction(() => {
    const frame = document.querySelector('#deck-frame');
    const element = frame?.contentDocument?.querySelector('h2');
    return element?.style.translate === '55px 25px'
      && frame.contentWindow.HuaweiDeckPatchRuntime.pendingTransactionCount() === 0;
  });
});

test('undo prepared 后断线重连会移除 sidecar 已撤销的旧 DOM 效果', async t => {
  const app = await startFixtureServer({ bridgeTimeoutMs: 600 });
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const target = await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  const applied = await postJson(app, '/api/actions', {
    expectedRevision: 0, taskId: null,
    actions: [{ id:'disconnect-undo-base', taskId:null, target, kind:'translate', payload:{x:45,y:20} }],
  });
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  assert.equal(await heading.evaluate(element => element.style.translate), '45px 20px');

  await page.evaluate(() => {
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedSend(data) {
      originalSend.call(this, data);
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message.type === 'actions-prepared' && !window.__closedDuringUndo) {
        window.__closedDuringUndo = true;
        this.close();
      }
    };
  });
  const undone = await postJson(app, `/api/groups/${applied.body.groupId}/undo`, {
    expectedRevision: 1,
  });
  assert.equal(undone.response.status, 200, JSON.stringify(undone.body));
  assert.equal(undone.body.commitConfirmed, false);
  assert.equal(undone.body.recoveredBySync, true);
  const state = await session(app);
  assert.equal(state.revision, 2);
  assert.equal(state.groups[0].active, false);
  await page.waitForFunction(() => document.querySelector('[data-ws-state]')?.dataset.wsState === 'online');
  await page.waitForFunction(() => {
    const frame = document.querySelector('#deck-frame');
    const element = frame?.contentDocument?.querySelector('h2');
    return element?.style.translate === ''
      && frame.contentWindow.HuaweiDeckPatchRuntime.pendingTransactionCount() === 0;
  });
});

test('commit ACK 丢失经 sidecar 恢复后返回成功并广播 revision', async t => {
  const app = await startFixtureServer({ bridgeTimeoutMs: 100 });
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const target = await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  const observer=await connectObserver(app);
  t.after(() => observer.close());
  const recorded=nextSocketMessage(observer);

  await page.evaluate(() => {
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedSend(data) {
      let message;
      try { message = JSON.parse(String(data)); } catch { return originalSend.call(this, data); }
      if (message.type === 'actions-committed' && !window.__droppedCommitAck) {
        window.__droppedCommitAck = true;
        return;
      }
      return originalSend.call(this, data);
    };
  });

  const result = await postJson(app, '/api/actions', {
    expectedRevision: 0, taskId: null,
    actions: [{ id:'lost-commit-ack', taskId:null, target, kind:'translate', payload:{x:65,y:35} }],
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.commitConfirmed, false);
  assert.equal(result.body.recoveredBySync, true);
  const state = await session(app);
  assert.equal(state.revision, 1);
  assert.equal(state.groups.length, 1);
  assert.equal(await heading.evaluate(element => element.style.translate), '65px 35px');
  assert.equal(await heading.evaluate(() => window.HuaweiDeckPatchRuntime.pendingTransactionCount()), 0);
  assert.equal(await page.locator('[data-revision]').textContent(),'1');
  const event=await recorded;
  assert.equal(event.type,'actions-recorded');
  assert.equal(event.revision,1);
});

test('人工动作 commit ACK 丢失恢复后显示非错误成功提示', async t => {
  const app=await startFixtureServer({bridgeTimeoutMs:100});
  t.after(() => app.close());
  const {browser,page}=await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const heading=page.frameLocator('#deck-frame').locator('h2').first();
  await page.evaluate(() => {
    const originalSend=WebSocket.prototype.send;
    WebSocket.prototype.send=function patchedSend(data) {
      let message;
      try { message=JSON.parse(String(data)); } catch { return originalSend.call(this,data); }
      if (message.type==='actions-committed' && !window.__droppedManualCommitAck) {
        window.__droppedManualCommitAck=true;
        return;
      }
      return originalSend.call(this,data);
    };
  });
  await page.click('[data-mode="edit"]');
  await heading.dblclick(); await heading.fill('恢复后成功'); await heading.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent==='1');
  const status=page.frameLocator('#deck-frame').locator('[data-direct-status]');
  await status.waitFor();
  assert.notEqual(await status.getAttribute('data-state'),'error');
  assert.match(await status.innerText(),/已保存并恢复同步/);
  assert.equal((await session(app)).groups.length,1);
});

test('普通人工动作成功后 iframe-only reload 仍按最新 sessionGroups 恢复', async t => {
  const app=await startFixtureServer();
  t.after(() => app.close());
  const {browser,page,browserProblems,resourceProblems,resourceRequests}=await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  let heading=page.frameLocator('#deck-frame').locator('h2').first();
  await page.click('[data-mode="edit"]');
  await heading.dblclick(); await heading.fill('普通成功后刷新 iframe'); await heading.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent==='1');
  await reloadDeckFrame(page);
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent==='普通成功后刷新 iframe');
  heading=page.frameLocator('#deck-frame').locator('h2').first();
  assert.equal(await heading.textContent(),'普通成功后刷新 iframe');
  assert.equal(sessionRequestCount(resourceRequests),2,JSON.stringify(resourceRequests));
  assert.deepEqual(browserProblems,[]);
  assert.deepEqual(resourceProblems,[]);
});

test('durable manual 成功后 session refresh 瞬时失败仍回成功并由 deck-ready 重试', async t => {
  for (const scenario of [
    { name:'normal', syncPending:false },
    { name:'syncPending', syncPending:true },
  ]) {
    await t.test(scenario.name, async t => {
      // 此处注入的是 ACK 丢失；为正常 prepare 留出浏览器调度预算，避免先误报超时。
      const app=await startFixtureServer({bridgeTimeoutMs:1_000});
      t.after(() => app.close());
      const {browser,page,browserProblems,resourceProblems,resourceRequests}=await openEditor(app);
      t.after(() => browser.close());
      page.setDefaultTimeout(8_000);
      for (let attempt=0; attempt<50 && sessionRequestCount(resourceRequests)<1; attempt+=1) {
        await page.waitForTimeout(20);
      }
      assert.equal(sessionRequestCount(resourceRequests),1,JSON.stringify(resourceRequests));
      let actionPosts=0;
      page.on('request',request => {
        if (request.method()==='POST' && new URL(request.url()).pathname==='/api/actions') actionPosts+=1;
      });
      let abortedSessionRequests=0;
      await page.route('**/api/session*',route => {
        if (route.request().method()==='GET' && abortedSessionRequests===0) {
          abortedSessionRequests+=1;
          return route.abort('connectionreset');
        }
        return route.continue();
      });
      let heading=page.frameLocator('#deck-frame').locator('h2').first();
      await heading.evaluate(() => {
        window.__manualActionResults=[];
        window.addEventListener('message',event => {
          if (event.data?.type==='manual-actions-result') window.__manualActionResults.push(event.data);
        });
      });
      if (scenario.syncPending) {
        await page.evaluate(() => {
          const originalSend=WebSocket.prototype.send;
          WebSocket.prototype.send=function patchedSend(data) {
            let message;
            try { message=JSON.parse(String(data)); } catch { return originalSend.call(this,data); }
            if (message.type==='actions-committed' || message.type==='actions-synced') return;
            return originalSend.call(this,data);
          };
        });
      }
      const text=`${scenario.name} durable 后会话待重试`;
      await page.click('[data-mode="edit"]');
      await heading.dblclick(); await heading.fill(text); await heading.press('Meta+Enter');
      await page.waitForFunction(() => {
        const frame=document.querySelector('#deck-frame');
        return frame?.contentWindow.__manualActionResults?.length===1;
      });
      const manualResult=await heading.evaluate(() => window.__manualActionResults[0]);
      assert.equal(manualResult.ok,true,JSON.stringify(manualResult));
      assert.equal(manualResult.sessionRefreshPending,true,JSON.stringify(manualResult));
      assert.equal(manualResult.revision,1);
      assert.equal(manualResult.syncPending,scenario.syncPending);
      const status=page.frameLocator('#deck-frame').locator('[data-direct-status]');
      await status.waitFor();
      assert.notEqual(await status.getAttribute('data-state'),'error');
      assert.match(await status.innerText(),/已保存.*会话同步待重试/);
      assert.equal(await page.locator('[data-revision]').textContent(),'1');
      const durableState=await session(app);
      assert.equal(durableState.revision,1);
      assert.equal(durableState.groups.length,1);
      assert.equal(await heading.textContent(),text);
      assert.equal(actionPosts,1);
      assert.equal(abortedSessionRequests,1);

      await reloadDeckFrame(page);
      await page.waitForFunction(expected => (
        document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent===expected
      ),text);
      heading=page.frameLocator('#deck-frame').locator('h2').first();
      assert.equal(await heading.textContent(),text);
      assert.equal(actionPosts,1);
      assert.equal(sessionRequestCount(resourceRequests),3,JSON.stringify(resourceRequests));
      const injectedBrowserFailures=browserProblems.filter(problem => problem.includes('ERR_CONNECTION_RESET'));
      assert.equal(injectedBrowserFailures.length,1,JSON.stringify(browserProblems));
      assert.equal(browserProblems.filter(problem => !problem.includes('ERR_CONNECTION_RESET')).length,0,
        JSON.stringify(browserProblems));
      assert.equal(resourceProblems.filter(problem => !problem.includes('/api/session')).length,0,
        JSON.stringify(resourceProblems));
    });
  }
});

test('sidecar 已提交但 sync ACK 也丢失时 apply/undo/redo 均成功且各广播一次', async t => {
  const app=await startFixtureServer({bridgeTimeoutMs:100});
  t.after(() => app.close());
  const {browser,page}=await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const heading=page.frameLocator('#deck-frame').locator('h2').first();
  const target=await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  const observer=await connectObserver(app);
  t.after(() => observer.close());
  const events=[];
  observer.on('message',data => events.push(JSON.parse(data)));
  await page.evaluate(() => {
    const originalSend=WebSocket.prototype.send;
    WebSocket.prototype.send=function patchedSend(data) {
      let message;
      try { message=JSON.parse(String(data)); } catch { return originalSend.call(this,data); }
      if (message.type==='actions-committed' || message.type==='actions-synced') return;
      return originalSend.call(this,data);
    };
  });
  const applied=await postJson(app,'/api/actions',{
    expectedRevision:0,taskId:null,
    actions:[{id:'sync-pending-apply',taskId:null,target,kind:'translate',payload:{x:70,y:30}}],
  });
  assert.equal(applied.response.status,200,JSON.stringify(applied.body));
  assert.deepEqual({
    revision:applied.body.revision,groupId:applied.body.groupId,
    commitConfirmed:applied.body.commitConfirmed,recoveredBySync:applied.body.recoveredBySync,
    syncPending:applied.body.syncPending,
  },{
    revision:1,groupId:applied.body.groupId,
    commitConfirmed:false,recoveredBySync:false,syncPending:true,
  });
  const undone=await postJson(app,`/api/groups/${applied.body.groupId}/undo`,{expectedRevision:1});
  assert.equal(undone.response.status,200,JSON.stringify(undone.body));
  assert.equal(undone.body.revision,2); assert.equal(undone.body.syncPending,true);
  const redone=await postJson(app,`/api/groups/${applied.body.groupId}/redo`,{expectedRevision:2});
  assert.equal(redone.response.status,200,JSON.stringify(redone.body));
  assert.equal(redone.body.revision,3); assert.equal(redone.body.syncPending,true);
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent==='3');
  await new Promise(resolvePromise => setTimeout(resolvePromise,180));
  assert.deepEqual(events.map(event => ({type:event.type,revision:event.revision,groupId:event.payload?.groupId})),[
    {type:'actions-recorded',revision:1,groupId:applied.body.groupId},
    {type:'group-undone',revision:2,groupId:applied.body.groupId},
    {type:'group-redone',revision:3,groupId:applied.body.groupId},
  ]);
  const state=await session(app);
  assert.equal(state.revision,3);
  assert.equal(state.groups.length,1);
  assert.equal(await heading.evaluate(element => element.style.translate),'70px 30px');
  assert.equal(await heading.evaluate(() => window.HuaweiDeckPatchRuntime.pendingTransactionCount()),0);
});

test('人工动作 syncPending 走成功结果且 iframe-only reload 后仍恢复', async t => {
  const app=await startFixtureServer({bridgeTimeoutMs:100});
  t.after(() => app.close());
  const {browser,page,browserProblems,resourceProblems,resourceRequests}=await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const heading=page.frameLocator('#deck-frame').locator('h2').first();
  await page.evaluate(() => {
    const originalSend=WebSocket.prototype.send;
    WebSocket.prototype.send=function patchedSend(data) {
      let message;
      try { message=JSON.parse(String(data)); } catch { return originalSend.call(this,data); }
      if (message.type==='actions-committed' || message.type==='actions-synced') return;
      return originalSend.call(this,data);
    };
  });
  await page.click('[data-mode="edit"]');
  await heading.dblclick(); await heading.fill('已保存但待确认同步'); await heading.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent==='1');
  const status=page.frameLocator('#deck-frame').locator('[data-direct-status]');
  await status.waitFor();
  assert.notEqual(await status.getAttribute('data-state'),'error');
  assert.match(await status.innerText(),/已保存.*同步待确认/);
  const state=await session(app);
  assert.equal(state.revision,1);
  assert.equal(state.groups.length,1);
  assert.equal(await heading.textContent(),'已保存但待确认同步');
  await reloadDeckFrame(page);
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent==='已保存但待确认同步');
  assert.equal(sessionRequestCount(resourceRequests),2,JSON.stringify(resourceRequests));
  assert.deepEqual(browserProblems,[]);
  assert.deepEqual(resourceProblems,[]);
});

test('Agent apply/undo/redo 广播后 iframe-only reload 始终匹配权威编译集合', async t => {
  const app=await startFixtureServer();
  t.after(() => app.close());
  const {browser,page,browserProblems,resourceProblems,resourceRequests}=await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  let heading=page.frameLocator('#deck-frame').locator('h2').first();
  const target=await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  const applied=await postJson(app,'/api/actions',{
    expectedRevision:0,taskId:null,
    actions:[{id:'agent-frame-reload',taskId:null,target,kind:'setText',payload:{text:'Agent 广播恢复'}}],
  });
  assert.equal(applied.response.status,200,JSON.stringify(applied.body));
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent==='1');
  await reloadDeckFrame(page);
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent==='Agent 广播恢复');

  let changed=await postJson(app,`/api/groups/${applied.body.groupId}/undo`,{expectedRevision:1});
  assert.equal(changed.response.status,200,JSON.stringify(changed.body));
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent==='2');
  await reloadDeckFrame(page);
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent==='第一页标题');

  changed=await postJson(app,`/api/groups/${applied.body.groupId}/redo`,{expectedRevision:2});
  assert.equal(changed.response.status,200,JSON.stringify(changed.body));
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent==='3');
  await reloadDeckFrame(page);
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent==='Agent 广播恢复');
  heading=page.frameLocator('#deck-frame').locator('h2').first();
  const state=await session(app);
  assert.equal(state.revision,3);
  assert.equal(new PatchJournal(state).compile()[0].after,'Agent 广播恢复');
  assert.equal(await heading.textContent(),'Agent 广播恢复');
  assert.equal(sessionRequestCount(resourceRequests),4,JSON.stringify(resourceRequests));
  assert.deepEqual(browserProblems,[]);
  assert.deepEqual(resourceProblems,[]);
});

test('任务与顶部历史入口在请求处理中共同禁用，连点不重发也不反向执行', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  const target = await page.frameLocator('#deck-frame').locator('h2').first()
    .evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  const created = await postJson(app, '/api/tasks', {
    expectedRevision:0, pageKey:target.pageKey, pageIndex:1, pageLabel:'封面',
    rect:{ x:100,y:100,w:300,h:120 }, instruction:'检查连点',
  });
  const taskId = created.body.task.id;
  await postJson(app, '/api/actions', { expectedRevision:1, taskId,
    actions:[{ id:'busy-task', taskId,target,kind:'setText',payload:{text:'连点测试'} }] });
  await page.waitForSelector('[data-task-undo]', { state:'attached' });
  let release;
  let entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const requestSeen = new Promise(resolve => { entered = resolve; });
  let count = 0;
  await page.route('**/api/groups/*/undo*', async route => {
    count++; entered(); await blocked; await route.continue();
  });
  t.after(() => release());
  await page.evaluate(() => document.querySelector('[data-task-undo]').click());
  await requestSeen;
  try {
    assert.equal(await page.locator('[data-task-undo]').isDisabled(), true, '任务入口必须立即禁用');
    assert.equal(await page.locator('[data-history-undo]').isDisabled(), true, '顶部入口必须共享忙状态');
    await page.evaluate(() => {
      for (let i=0;i<5;i++) {
        document.querySelector('[data-task-undo]').click();
        document.querySelector('[data-history-undo]').click();
      }
    });
  } finally { release(); }
  await page.waitForFunction(() => {
    const redo = document.querySelector('[data-task-redo]');
    return redo && !redo.disabled;
  });
  assert.equal(count, 1);
  assert.equal((await session(app)).revision, 3);
  // 模拟另一写入方已完成重做，原请求收到旧 revision 冲突。
  await page.route('**/api/groups/*/redo*', async route => {
    const response = await fetch(route.request().url(), {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ expectedRevision:3 }),
    });
    assert.equal(response.status, 200);
    await route.fulfill({ status:409, contentType:'application/json',
      body:JSON.stringify({ code:'REVISION_CONFLICT', revision:4, message:'测试版本冲突' }) });
  });
  await page.evaluate(() => document.querySelector('[data-task-redo]').click());
  await page.waitForFunction(() => {
    const undo = document.querySelector('[data-task-undo]');
    return undo && !undo.disabled;
  });
  assert.equal((await session(app)).revision, 4, '冲突刷新后不能自动反向撤销');
  assert.equal(count, 1);
});
