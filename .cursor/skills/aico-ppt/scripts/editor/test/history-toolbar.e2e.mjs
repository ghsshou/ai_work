import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { startFixtureServer, openEditor } from './test-helpers.mjs';

async function readSession(app) {
  return fetch(`${app.url}/api/session?token=${app.token}`).then(response => response.json());
}

async function postJson(app, pathname, body) {
  const response = await fetch(`${app.url}${pathname}?token=${app.token}`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(body),
  });
  return { response, body:await response.json() };
}

async function waitForRevision(page, revision) {
  await page.waitForFunction(expected => (
    document.querySelector('[data-revision]')?.textContent === String(expected)
  ), revision);
}

async function waitForHistoryReady(page) {
  await page.waitForFunction(() => (
    document.querySelector('.history-controls')?.dataset.busy === 'false'
  ));
}

async function openCompletedTasks(page) {
  const drawer = page.locator('[data-task-drawer]');
  if (await drawer.getAttribute('data-open') !== 'true') {
    await page.locator('[data-task-drawer-toggle]').click();
  }
  const group = page.locator('[data-task-completed-group]');
  await group.waitFor();
  if (!await group.evaluate(element => element.open)) {
    await group.locator('summary').click();
  }
}

async function createManualTextAction(page, text) {
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  await page.locator('[data-mode="edit"]').click();
  await heading.click();
  await heading.dblclick();
  await heading.fill(text);
  await heading.press('Meta+Enter');
}

async function createManualMoveAction(page) {
  const frame = page.frameLocator('#deck-frame');
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  await page.locator('[data-mode="edit"]').click();
  await heading.click({ position:{ x:20, y:10 } });
  const handle = frame.locator('[data-transform-move-handle="left"]');
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40,
    box.y + box.height / 2 + 20, { steps:8 });
  await page.mouse.up();
}

async function createManualResizeAction(page) {
  const frame = page.frameLocator('#deck-frame');
  await page.locator('[data-mode="edit"]').click();
  await frame.locator('.card').first().click();
  const handle = frame.locator('[data-resize-handle]');
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 30, box.y + box.height / 2 + 20, { steps:8 },
  );
  await page.mouse.up();
}

async function dispatchBeforeUnload(page) {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable:true });
    const dispatched = window.dispatchEvent(event);
    return { dispatched, defaultPrevented:event.defaultPrevented };
  });
}

async function reloadWithoutHistoryEvents(page) {
  await page.routeWebSocket(url => url.pathname === '/events', socket => {
    const server = socket.connectToServer();
    server.onMessage(message => {
      let event;
      try { event = JSON.parse(String(message)); } catch {}
      if (['actions-recorded', 'group-undone', 'group-redone'].includes(event?.type)) return;
      socket.send(message);
    });
  });
  await page.reload();
  await page.waitForSelector('[data-page-key]');
  await page.waitForFunction(() => document.querySelector('[data-ws-state]')?.dataset.wsState === 'online');
}

test('历史已恢复但画布尚未 ready 时仍可固化', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);

  await createManualTextAction(page, '重开后仍未固化的标题');
  await waitForRevision(page, 1);
  await waitForHistoryReady(page);
  assert.equal(await page.locator('[data-history-undo]').isEnabled(), true);
  assert.equal(await page.locator('[data-solidify]').isEnabled(), true);

  await page.locator('#deck-frame').dispatchEvent('load');
  assert.equal(await page.locator('[data-history-undo]').isEnabled(), true,
    '画布重连期间不能破坏已经恢复的撤销历史');
  assert.equal(await page.locator('[data-solidify]').isEnabled(), true,
    '固化只依赖权威历史与服务端写盘，不应被画布 ready 状态锁死');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('累计超过十条修改时只弹出一次固化提醒并可直接打开固化确认', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(8_000);

  const target = await page.locator('#deck-frame').evaluate(frame => (
    frame.contentWindow.HuaweiDeckPatchRuntime.makeLocator(
      frame.contentDocument.querySelector('h2'),
    )
  ));
  const reminder = page.locator('[data-solidify-reminder]');
  assert.equal(await reminder.isHidden(), true);

  for (let index = 1; index <= 10; index += 1) {
    const applied = await postJson(app, '/api/actions', {
      expectedRevision:index - 1,
      taskId:null,
      actions:[{
        id:`solidify-reminder-${index}`,
        taskId:null,
        target,
        kind:'setText',
        payload:{ text:`固化提醒阈值标题 ${index}` },
      }],
    });
    assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  }
  await waitForRevision(page, 10);
  await waitForHistoryReady(page);
  assert.equal(await reminder.isHidden(), true, '第十组修改仍不得打扰用户');

  const eleventh = await postJson(app, '/api/actions', {
    expectedRevision:10,
    taskId:null,
    actions:[{
      id:'solidify-reminder-11',
      taskId:null,
      target,
      kind:'setText',
      payload:{ text:'固化提醒阈值标题 11' },
    }],
  });
  assert.equal(eleventh.response.status, 200, JSON.stringify(eleventh.body));
  await waitForRevision(page, 11);
  await waitForHistoryReady(page);
  await reminder.waitFor({ state:'visible' });
  assert.match(await reminder.textContent(), /已有 11 条修改待固化/);
  if (process.env.SOLIDIFY_REMINDER_SCREENSHOT) {
    await page.waitForTimeout(220);
    await page.screenshot({ path:process.env.SOLIDIFY_REMINDER_SCREENSHOT, fullPage:true });
  }

  await reminder.locator('[data-solidify-reminder-action]').click();
  await expectDialogOpen(page.locator('[data-solidify-dialog]'));
  assert.equal(await reminder.isHidden(), true);
  await page.locator('[data-solidify-cancel]').click();

  const twelfth = await postJson(app, '/api/actions', {
    expectedRevision:11,
    taskId:null,
    actions:[{
      id:'solidify-reminder-12',
      taskId:null,
      target,
      kind:'setText',
      payload:{ text:'固化提醒阈值标题 12' },
    }],
  });
  assert.equal(twelfth.response.status, 200, JSON.stringify(twelfth.body));
  await waitForRevision(page, 12);
  await waitForHistoryReady(page);
  assert.equal(await reminder.isHidden(), true, '同一轮关闭后不得逐条重复提醒');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('固化修改永久写盘，退出编辑时显示自定义未固化清单且不触发原生离开确认', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const {
    browser, page, browserProblems, resourceProblems,
  } = await openEditor(app, {
    allowPilotDocumentBlobAbort:true,
    workspaceUrl:`${app.url}/workbench?token=${encodeURIComponent(app.token)}`,
  });
  t.after(() => browser.close());
  page.setDefaultTimeout(8_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const solidify = page.locator('[data-solidify]');
  await page.locator('#deck-frame').evaluate(frame => {
    frame.contentDocument.querySelector('#__deck_loading_overlay')?.remove();
  });

  assert.equal(await page.locator('.topbar-actions > [data-exit-editor]').count(), 1,
    '退出编辑器必须作为右上角末尾的独立入口');
  assert.deepEqual(
    await page.locator('.topbar-actions').evaluate(element => (
      [...element.querySelectorAll(
        '[data-workspace-home], [data-workspace-switch], [data-history-undo], [data-history-redo], '
        + '[data-solidify], [data-agent-status], [data-guided-tour="editing"], [data-exit-editor]',
      )].map(button => (
        button.hasAttribute('data-workspace-home') ? 'home'
          : button.hasAttribute('data-workspace-switch') ? 'switch'
            : button.hasAttribute('data-history-undo') ? 'undo'
              : button.hasAttribute('data-history-redo') ? 'redo'
                : button.hasAttribute('data-solidify') ? 'solidify'
                  : button.hasAttribute('data-agent-status') ? 'agent'
                    : button.hasAttribute('data-guided-tour') ? 'guide' : 'exit'
      ))
    )),
    ['home', 'switch', 'undo', 'redo', 'solidify', 'agent', 'guide', 'exit'],
  );
  assert.equal(
    await page.locator('[data-exit-editor] .pill-nav-label-default').innerText(),
    '退出编辑器',
  );
  assert.equal(await page.locator('[data-exit-editor] .exit-editor-icon').count(), 2,
    'PillNav 默认态和悬浮态都必须使用门框向右箭头退出图标');
  assert.equal(await page.locator('[data-exit-editor] .exit-editor-icon').first()
    .locator('path').count(), 5);
  assert.deepEqual(await page.locator('[data-exit-editor] .exit-editor-icon').first()
    .evaluate(element => ({
      color:getComputedStyle(element).color,
      background:getComputedStyle(element).backgroundColor,
    })), { color:'rgb(199, 0, 11)', background:'rgba(0, 0, 0, 0)' });
  assert.equal(await page.locator('[data-exit-editor] .pill-nav-label-default > :last-child')
    .evaluate(element => element.tagName), 'svg', '退出图标必须位于文字右侧');
  assert.equal(await page.locator('[data-exit-editor]').evaluate(button => (
    button.textContent.includes('←') || button.textContent.includes('×')
  )), false, '退出编辑器不再使用返回箭头或圆圈叉');
  assert.equal(
    await page.locator('[data-workspace-navigation] [data-workspace-home]').count(),
    1,
    '右上角工作台导航必须保留初始页入口',
  );

  assert.equal(await solidify.isDisabled(), true);
  assert.equal(await solidify.locator('.solidify-dot').first().evaluate(element => (
    getComputedStyle(element).backgroundColor
  )), 'rgb(22, 163, 74)');
  assert.deepEqual(await dispatchBeforeUnload(page), {
    dispatched:true, defaultPrevented:false,
  });

  await createManualTextAction(page, '已经固化的标题');
  await waitForRevision(page, 1);
  await waitForHistoryReady(page);
  assert.equal(await solidify.isEnabled(), true);
  assert.equal(await solidify.locator('.solidify-dot').first().evaluate(element => (
    getComputedStyle(element).backgroundColor
  )), 'rgb(199, 0, 11)');
  assert.deepEqual(await dispatchBeforeUnload(page), {
    dispatched:true, defaultPrevented:false,
  });
  const closeWarning = page.locator('[data-solidify-dialog]');
  assert.equal(await closeWarning.getAttribute('open'), null);
  await page.getByRole('button', { name:'退出编辑器' }).click();
  await expectDialogOpen(closeWarning);
  assert.match(await closeWarning.textContent(), /退出前还有修改没有固化/);
  assert.match(await closeWarning.locator('[data-solidify-task="direct"]').textContent(),
    /直接编辑与结构调整/);
  assert.equal(
    await closeWarning.locator('[data-solidify-task="direct"] .solidify-task-details').count(),
    0,
    '任务详情默认不得提前渲染',
  );
  await closeWarning.locator('[data-solidify-task="direct"] summary').click();
  await closeWarning.locator('[data-solidify-task="direct"] .solidify-task-details').waitFor();
  assert.match(await closeWarning.locator('[data-solidify-task="direct"]').textContent(),
    /文字修改/);
  assert.equal(
    await closeWarning.locator('[data-solidify-confirm] .pill-nav-label-default').innerText(),
    '固化并退出',
  );
  assert.equal(
    await closeWarning.locator('[data-solidify-exit-without] .pill-nav-label-default').innerText(),
    '暂不固化，退出',
  );
  await closeWarning.locator('[data-solidify-cancel]').click();

  await solidify.click();
  const dialog = page.locator('[data-solidify-dialog]');
  await expectDialogOpen(dialog);
  assert.match(await dialog.textContent(), /永久写入这个 Deck/);
  assert.match(await dialog.textContent(), /清空全部撤销和重做记录/);
  await page.locator('[data-solidify-cancel]').click();
  assert.equal(await dialog.getAttribute('open'), null);
  assert.equal(await solidify.isEnabled(), true);
  assert.equal(await page.locator('[data-history-undo]').isEnabled(), true);

  await solidify.click();
  let releaseSolidifyRequest;
  let markSolidifyRequestSeen;
  const solidifyRequestGate = new Promise(resolve => { releaseSolidifyRequest = resolve; });
  const solidifyRequestSeen = new Promise(resolve => { markSolidifyRequestSeen = resolve; });
  await page.route('**/api/solidify-deck*', async route => {
    markSolidifyRequestSeen();
    await solidifyRequestGate;
    await route.continue();
  }, { times:1 });
  await page.locator('[data-solidify-confirm]').click();
  await solidifyRequestSeen;
  const progress = page.locator('[data-solidify-progress]');
  const progressBar = page.locator('[data-solidify-progressbar]');
  assert.equal(await progress.isVisible(), true);
  assert.equal(await progress.getAttribute('data-state'), 'indeterminate');
  assert.match(await progress.textContent(), /正在清理历史并原子写入 Deck/);
  assert.equal(await progressBar.getAttribute('aria-valuenow'), null);
  assert.equal(await page.locator('[data-solidify-cancel]').isDisabled(), true);
  if (process.env.SOLIDIFY_PROGRESS_SCREENSHOT) {
    await page.screenshot({ path:process.env.SOLIDIFY_PROGRESS_SCREENSHOT, fullPage:true });
  }
  releaseSolidifyRequest();
  await waitForRevision(page, 2);
  await waitForHistoryReady(page);
  await page.waitForFunction(() => document.querySelector('[data-solidify]')?.disabled === true);
  assert.equal(await solidify.locator('.solidify-dot').first().evaluate(element => (
    getComputedStyle(element).backgroundColor
  )), 'rgb(22, 163, 74)');
  assert.equal(await page.locator('[data-history-undo]').isDisabled(), true);
  assert.equal(await page.locator('[data-history-redo]').isDisabled(), true);
  assert.deepEqual(await dispatchBeforeUnload(page), {
    dispatched:true, defaultPrevented:false,
  });

  const state = await readSession(app);
  assert.equal(state.revision, 2);
  assert.deepEqual(state.groups, []);
  assert.deepEqual(state.redo, []);
  assert.equal(state.solidifiedActions.length, 1);
  assert.equal(state.solidifiedActions[0].payload.text, '已经固化的标题');

  await page.reload();
  await waitForRevision(page, 2);
  await page.waitForSelector('[data-page-key]');
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent
      === '已经固化的标题'
  ));
  assert.equal(await solidify.isDisabled(), true);
  assert.equal(await heading.textContent(), '已经固化的标题');

  await page.locator('#deck-frame').evaluate(frame => {
    frame.contentDocument.querySelector('#__deck_loading_overlay')?.remove();
  });
  await createManualTextAction(page, '第二轮固化标题');
  await waitForRevision(page, 3);
  assert.deepEqual(await dispatchBeforeUnload(page), {
    dispatched:true, defaultPrevented:false,
  });
  await solidify.click();
  await page.locator('[data-solidify-confirm]').click();
  await waitForRevision(page, 4);
  await waitForHistoryReady(page);
  const secondState = await readSession(app);
  assert.deepEqual(secondState.groups, []);
  assert.equal(secondState.solidifiedActions.length, 1, '连续固化应折叠成唯一最终动作');
  assert.equal(secondState.solidifiedActions[0].payload.text, '第二轮固化标题');
  await page.reload();
  await waitForRevision(page, 4);
  await page.waitForSelector('[data-page-key]');
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent
      === '第二轮固化标题'
  ));
  await page.locator('#deck-frame').evaluate(frame => {
    frame.contentDocument.querySelector('#__deck_loading_overlay')?.remove();
  });
  await createManualTextAction(page, '固化后的未固化标题');
  await waitForRevision(page, 5);
  await page.reload();
  await waitForRevision(page, 5);
  await page.waitForSelector('[data-page-key]');
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent
      === '固化后的未固化标题'
  ));
  await waitForHistoryReady(page);
  assert.equal(await page.locator('[data-history-undo]').isEnabled(), true,
    '重开后仍可撤销的修改必须恢复全局撤销入口');
  assert.equal(await solidify.isEnabled(), true,
    '重开后仍可撤销的修改也必须恢复固化入口');
  await page.locator('[data-history-undo]').click();
  await waitForRevision(page, 6);
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent
      === '第二轮固化标题'
  ));
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);

  await page.getByRole('button', { name:'退出编辑器' }).click();
  await expectDialogOpen(page.locator('[data-solidify-dialog]'));
  await page.route('**/api/shutdown*', route => route.fulfill({
    status:202, contentType:'application/json', body:'{"status":"shutting-down"}',
  }), { times:1 });
  const exited = page.waitForRequest(request => request.url().includes('/api/shutdown'));
  await page.locator('[data-solidify-confirm]').click();
  await exited;
  const exitedState = await readSession(app);
  assert.deepEqual(exitedState.groups, []);
  assert.deepEqual(exitedState.redo, []);
});

test('暂不固化退出会保留工作副本与修改历史', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const { browser, page } = await openEditor(app, {
    allowPilotDocumentBlobAbort:true,
    workspaceUrl:`${app.url}/workbench?token=${encodeURIComponent(app.token)}`,
  });
  t.after(() => browser.close());
  page.setDefaultTimeout(8_000);
  await page.locator('#deck-frame').evaluate(frame => {
    frame.contentDocument.querySelector('#__deck_loading_overlay')?.remove();
  });

  await createManualTextAction(page, '暂不固化仍会保留');
  await waitForRevision(page, 1);
  await waitForHistoryReady(page);
  await page.getByRole('button', { name:'退出编辑器' }).click();
  await expectDialogOpen(page.locator('[data-solidify-dialog]'));
  await page.route('**/api/shutdown*', route => route.fulfill({
    status:202, contentType:'application/json', body:'{"status":"shutting-down"}',
  }), { times:1 });
  const exited = page.waitForRequest(request => request.url().includes('/api/shutdown'));
  await page.locator('[data-solidify-exit-without]').click();
  await exited;

  const state = await readSession(app);
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0].active, true);
});

test('退出编辑器按任务分组展示全部未固化修改', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const { browser, page } = await openEditor(app, {
    allowPilotDocumentBlobAbort:true,
    workspaceUrl:`${app.url}/workbench?token=${encodeURIComponent(app.token)}`,
  });
  t.after(() => browser.close());
  page.setDefaultTimeout(8_000);
  await page.locator('#deck-frame').evaluate(frame => {
    frame.contentDocument.querySelector('#__deck_loading_overlay')?.remove();
  });
  const targets = await page.locator('#deck-frame').evaluate(frame => (
    [...frame.contentDocument.querySelectorAll('h2')].slice(0, 2).map(node => (
      frame.contentWindow.HuaweiDeckPatchRuntime.makeLocator(node)
    ))
  ));
  const instructions = ['缩短第一页标题', '调整第二页标题颜色'];
  let expectedRevision = 0;
  for (let index = 0; index < instructions.length; index += 1) {
    const created = await postJson(app, '/api/tasks', {
      expectedRevision,
      pageKey:targets[index].pageKey,
      pageIndex:index + 1,
      pageLabel:'目录页',
      rect:{ x:20, y:20, w:400, h:120 },
      instruction:instructions[index],
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    expectedRevision += 1;
    const taskId = created.body.task.id;
    const { textPath:unusedTextPath, ...styleTarget } = targets[index];
    const applied = await postJson(app, '/api/actions', {
      expectedRevision,
      taskId,
      actions:[index === 0 ? {
        id:'grouped-exit-text', taskId, target:targets[index],
        kind:'setText', payload:{ text:'简短标题' },
      } : {
        id:'grouped-exit-style', taskId, target:styleTarget,
        kind:'setStyle', payload:{ property:'color', value:'rgb(0, 0, 0)' },
      }],
    });
    assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
    expectedRevision += 1;
  }
  await waitForRevision(page, expectedRevision);
  await waitForHistoryReady(page);
  await page.getByRole('button', { name:'退出编辑器' }).click();
  const dialog = page.locator('[data-solidify-dialog]');
  await expectDialogOpen(dialog);
  assert.match(await dialog.textContent(), /2 个任务存在未固化修改/);
  const sections = dialog.locator('[data-solidify-task-list] [data-solidify-task]');
  assert.equal(await sections.count(), 2);
  assert.equal(await sections.locator('.solidify-task-details').count(), 0,
    '所有任务详情默认保持懒加载');
  const sectionTexts = await sections.allTextContents();
  assert.ok(sectionTexts.some(text => text.includes(instructions[0])));
  assert.ok(sectionTexts.some(text => text.includes(instructions[1])));
  assert.equal(sectionTexts.some(text => /文字修改|样式修改/.test(text)), false);
  const textTask = sections.filter({ hasText:instructions[0] });
  await textTask.locator('summary').click();
  await textTask.locator('.solidify-task-details').waitFor();
  assert.match(await textTask.textContent(), /文字修改/);
  assert.equal(await textTask.locator('.solidify-task-details').count(), 1);
  assert.equal(await sections.filter({ hasText:instructions[1] })
    .locator('.solidify-task-details').count(), 0);
});

test('固化验证失败会显示具体原因并明确原 Deck 未被改动', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const { browser, page } = await openEditor(app, {
    allowPilotDocumentBlobAbort:true,
  });
  t.after(() => browser.close());
  page.setDefaultTimeout(8_000);
  await page.locator('#deck-frame').evaluate(frame => {
    frame.contentDocument.querySelector('#__deck_loading_overlay')?.remove();
  });
  await createManualTextAction(page, '会触发固化验证失败');
  await waitForRevision(page, 1);
  await waitForHistoryReady(page);
  await page.route('**/api/solidify-deck*', route => route.fulfill({
    status:409,
    contentType:'application/json',
    body:JSON.stringify({
      error:'PATCH_REPLAY_FAILED',
      code:'PATCH_REPLAY_FAILED',
      message:'历史修改无法安全重放，已停止固化且原 Deck 未被改动',
      stage:'patch-replay',
      recovery:'原 Deck 未被改动；撤销或重新执行冲突修改后再固化',
      failedActionId:'action-stale-range',
    }),
  }), { times:1 });

  await page.locator('[data-solidify]').click();
  await page.locator('[data-solidify-confirm]').click();
  const progress = page.locator('[data-solidify-progress]');
  await progress.waitFor({ state:'visible' });
  await page.waitForFunction(() => (
    document.querySelector('[data-solidify-progress]')?.dataset.state === 'error'
  ));
  assert.match(await progress.textContent(), /历史修改无法安全重放/);
  assert.match(await progress.textContent(), /原 Deck 未被改动/);
  assert.equal(await page.locator('[data-solidify-dialog]').isVisible(), true);
  assert.equal(await page.locator('[data-solidify-confirm]').isEnabled(), true);
});

test('重开恢复只跳过被后续源码修改取代的缺失动作', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const { browser, page } = await openEditor(app, {
    allowPilotDocumentBlobAbort:true,
  });
  t.after(() => browser.close());
  page.setDefaultTimeout(8_000);
  const frame = page.locator('#deck-frame');
  await frame.evaluate(element => {
    element.contentDocument.querySelector('#__deck_loading_overlay')?.remove();
  });
  const actions = await frame.evaluate(element => {
    const runtime = element.contentWindow.HuaweiDeckPatchRuntime;
    const heading = element.contentDocument.querySelector('h2');
    const target = runtime.makeLocator(heading);
    return {
      valid:{
        id:'restore-valid', target, kind:'setText', payload:{ text:'恢复后的有效修改' },
      },
      missing:{
        id:'restore-replaced',
        target:{
          ...target,
          editorId:'element-ffffffffffffffffffffffffffffffff',
          path:'999',
        },
        kind:'setText', payload:{ text:'已被结构修改删除' },
      },
    };
  });

  await frame.evaluate((element, value) => {
    element.contentWindow.postMessage({
      type:'sync-actions', actions:[value.valid, value.missing],
      rebaseActionIds:[value.missing.id],
    }, location.origin);
  }, actions);
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent
      === '恢复后的有效修改'
  ));
  assert.equal(await frame.evaluate(element => (
    element.contentDocument.querySelector('[data-direct-status][data-state="error"]')?.textContent
      ?? null
  )), null);

  await frame.evaluate((element, value) => {
    element.contentWindow.postMessage({
      type:'sync-actions', actions:[value.valid, { ...value.missing, id:'restore-real-conflict' }],
      rebaseActionIds:[],
    }, location.origin);
  }, actions);
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument
      ?.querySelector('[data-direct-status][data-state="error"]')?.textContent
      ?.includes('TARGET_NOT_FOUND')
  ));
});

test('已固化 Agent 任务可删除记录且不改变 Deck 固化结果', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app, {
    allowPilotDocumentBlobAbort:true,
    workspaceUrl:`${app.url}/workbench?token=${encodeURIComponent(app.token)}`,
  });
  t.after(() => browser.close());
  page.setDefaultTimeout(8_000);
  await page.locator('#deck-frame').evaluate(frame => {
    frame.contentDocument.querySelector('#__deck_loading_overlay')?.remove();
  });
  const target = await page.locator('#deck-frame').evaluate(frame => (
    frame.contentWindow.HuaweiDeckPatchRuntime.makeLocator(
      frame.contentDocument.querySelector('h2'),
    )
  ));
  const created = await postJson(app, '/api/tasks', {
    expectedRevision:0,
    pageKey:target.pageKey,
    pageIndex:1,
    pageLabel:'目录页',
    rect:{ x:20, y:20, w:400, h:120 },
    instruction:'调整推理框内的排版，不要把外部的框缩小，并保持完整的布局层级',
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const taskId = created.body.task.id;
  const applied = await postJson(app, '/api/actions', {
    expectedRevision:1,
    taskId,
    actions:[{
      id:'solidified-task-delete-text', taskId, target,
      kind:'setText', payload:{ text:'Agent 已固化标题' },
    }],
  });
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  await waitForRevision(page, 2);
  await waitForHistoryReady(page);

  assert.deepEqual(await dispatchBeforeUnload(page), {
    dispatched:true, defaultPrevented:false,
  });
  const closeWarning = page.locator('[data-solidify-dialog]');
  assert.equal(await closeWarning.getAttribute('open'), null);
  await page.getByRole('button', { name:'退出编辑器' }).click();
  await expectDialogOpen(closeWarning);
  assert.match(await closeWarning.textContent(), /退出前还有 1 个任务存在未固化修改/);
  const pendingTask = closeWarning.locator(`[data-solidify-task="${taskId}"]`);
  assert.equal(
    await pendingTask.locator('.solidify-task-name').innerText(),
    '调整推理框内的排版，不要把外部的框缩小，并保持完整的布局层级',
  );
  assert.equal(await pendingTask.locator('.solidify-task-details').count(), 0);
  await pendingTask.locator('summary').click();
  await pendingTask.locator('.solidify-task-details').waitFor();
  assert.match(await pendingTask.textContent(), /01 · 目录页/);
  assert.match(await pendingTask.textContent(), /文字修改/);
  assert.equal(
    await closeWarning.locator('[data-solidify-cancel] .pill-nav-label-default').innerText(),
    '继续编辑',
  );
  assert.equal(
    await closeWarning.locator('[data-solidify-confirm] .pill-nav-label-default').innerText(),
    '固化并退出',
  );
  assert.equal(
    await closeWarning.locator('[data-solidify-confirm] .pill-nav-label-hover').innerText(),
    '固化并退出',
  );
  assert.equal(
    await closeWarning.locator('[data-solidify-exit-without] .pill-nav-label-default').innerText(),
    '暂不固化，退出',
  );
  if (process.env.SOLIDIFY_CLOSE_SCREENSHOT) {
    await page.screenshot({ path:process.env.SOLIDIFY_CLOSE_SCREENSHOT, fullPage:true });
  }
  await closeWarning.locator('[data-solidify-cancel]').click();

  await page.locator('[data-solidify]').click();
  await page.locator('[data-solidify-confirm]').click();
  await waitForRevision(page, 3);
  await waitForHistoryReady(page);
  await openCompletedTasks(page);
  const row = page.locator(`[data-task-row="${taskId}"]`);
  assert.equal(await row.locator('[data-task-undo]').count(), 0);
  assert.equal(
    await row.locator('[data-task-delete] .pill-nav-label-default').textContent(),
    '删除记录',
  );
  const layout = await row.evaluate(node => {
    const rect = target => {
      const { left, right, top, bottom, width, height } = target.getBoundingClientRect();
      return { left, right, top, bottom, width, height };
    };
    const locate = rect(node.querySelector('[data-task-locate]'));
    const remove = rect(node.querySelector('[data-task-delete]'));
    const card = rect(node);
    return { locate, remove, card };
  });
  assert.ok(layout.remove.left >= layout.locate.right - 1, JSON.stringify(layout));
  const removeCenter = (layout.remove.top + layout.remove.bottom) / 2;
  const locateCenter = (layout.locate.top + layout.locate.bottom) / 2;
  assert.ok(Math.abs(removeCenter - locateCenter) <= 1,
    `删除记录应在任务卡右侧垂直居中：${JSON.stringify(layout)}`);
  assert.ok(layout.remove.right <= layout.card.right + 1, JSON.stringify(layout));
  assert.ok(layout.remove.width >= layout.remove.height * 1.5,
    `删除记录应是横向胶囊按钮：${JSON.stringify(layout)}`);
  assert.ok(layout.remove.height <= 34,
    `删除记录不应随任务卡纵向拉伸：${JSON.stringify(layout)}`);
  await row.locator('[data-task-delete]').click();
  assert.match(
    await row.locator('[data-task-delete-confirmation]').textContent(),
    /Deck 中已固化的修改不会改变/,
  );
  await row.locator('[data-task-delete-confirm]').click();
  await waitForRevision(page, 4);
  await row.waitFor({ state:'detached' });
  const deletedState = await readSession(app);
  assert.deepEqual(deletedState.tasks, []);
  assert.deepEqual(deletedState.groups, []);
  assert.equal(
    await page.frameLocator('#deck-frame').locator('h2').first().textContent(),
    'Agent 已固化标题',
  );

  await page.reload();
  await waitForRevision(page, 4);
  await page.waitForSelector('[data-page-key]');
  assert.equal(
    await page.frameLocator('#deck-frame').locator('h2').first().textContent(),
    'Agent 已固化标题',
  );
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

async function expectDialogOpen(dialog) {
  await dialog.waitFor({ state:'visible' });
  await dialog.page().waitForFunction(() => (
    document.querySelector('[data-solidify-dialog]')?.open === true
  ));
}

test('键盘快捷键跨 parent 与画布撤销重做，文字输入保留原生撤销', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const canvas = page.frameLocator('#deck-frame').locator('.stage .slide-canvas').first();

  await createManualTextAction(page, '快捷键标题');
  await waitForRevision(page, 1);
  await waitForHistoryReady(page);

  await page.locator('[data-current-page]').click();
  await page.keyboard.press('Meta+z');
  await waitForRevision(page, 2);
  assert.equal(await heading.textContent(), '第一页标题');

  // 单击文字现在会进入原生文字编辑；此处只需把键盘焦点送入画布，
  // 因此点击不属于任何文本框的空白位置。
  await canvas.click({ position:{ x:1000, y:900 } });
  await page.keyboard.press('Meta+Shift+z');
  await waitForRevision(page, 3);
  assert.equal(await heading.textContent(), '快捷键标题');

  await heading.dblclick();
  await heading.fill('输入中的临时文字');
  await heading.press('Meta+z');
  await page.waitForTimeout(120);
  assert.equal(await page.locator('[data-revision]').textContent(), '3');
  await heading.press('Escape');
  assert.equal(await heading.textContent(), '快捷键标题');

  await page.locator('[data-current-page]').click();
  await page.keyboard.press('Control+z');
  await waitForRevision(page, 4);
  assert.equal(await heading.textContent(), '第一页标题');

  await canvas.click({ position:{ x:1000, y:900 } });
  await page.keyboard.press('Control+y');
  await waitForRevision(page, 5);
  assert.equal(await heading.textContent(), '快捷键标题');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('打开已有历史后第一次 Ctrl+Z 会等待权威会话就绪并直接撤销', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();

  await createManualTextAction(page, '首次快捷键标题');
  await waitForRevision(page, 1);
  await waitForHistoryReady(page);

  let releaseSession;
  const sessionGate = new Promise(resolve => { releaseSession = resolve; });
  let blockedSessionRequest;
  const sessionRequestStarted = new Promise(resolve => { blockedSessionRequest = resolve; });
  let blocked = false;
  await page.route('**/api/session*', async route => {
    if (blocked) return route.continue();
    blocked = true;
    blockedSessionRequest();
    await sessionGate;
    return route.continue();
  });

  await page.reload({ waitUntil:'domcontentloaded' });
  await sessionRequestStarted;
  await page.waitForSelector('[data-page-key]');
  await heading.click();
  await heading.press('Control+z');
  releaseSession();

  await waitForRevision(page, 2);
  assert.equal(await heading.textContent(), '第一页标题');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('撤销与重做移动后选中框和缩放控制点跟随元素位置', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();

  await createManualMoveAction(page);
  await waitForRevision(page, 1);
  await waitForHistoryReady(page);

  const selectionAlignment = () => page.locator('#deck-frame').evaluate(frameElement => {
    const document = frameElement.contentDocument;
    const element = document.querySelector('h2').getBoundingClientRect();
    const overlay = document.querySelector('[data-transform-selection]').getBoundingClientRect();
    const handle = document.querySelector('[data-resize-handle]').getBoundingClientRect();
    return {
      overlay:Math.abs(overlay.left - element.left) < 1
        && Math.abs(overlay.top - element.top) < 1
        && Math.abs(overlay.width - element.width) < 1
        && Math.abs(overlay.height - element.height) < 1,
      handle:handle.left <= element.right && handle.right >= element.right
        && handle.top <= element.bottom && handle.bottom >= element.bottom
        && !(handle.left < element.left + element.width / 2
          && handle.right > element.left + element.width / 2
          && handle.top < element.top + element.height / 2
          && handle.bottom > element.top + element.height / 2),
    };
  });
  assert.deepEqual(await selectionAlignment(), { overlay:true, handle:true });

  await page.locator('[data-history-undo]').click();
  await waitForRevision(page, 2);
  await waitForHistoryReady(page);
  assert.equal(await heading.evaluate(element => element.style.translate), '');
  assert.deepEqual(await selectionAlignment(), { overlay:true, handle:true });

  await page.locator('[data-history-redo]').click();
  await waitForRevision(page, 3);
  await waitForHistoryReady(page);
  assert.notEqual(await heading.evaluate(element => element.style.translate), '');
  assert.deepEqual(await selectionAlignment(), { overlay:true, handle:true });
});

test('顶栏从权威 session 撤销重做人工与 Agent 历史并拒绝自动重试陈旧候选', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);

  const undo = page.locator('[data-history-undo]');
  const redo = page.locator('[data-history-redo]');
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();
  const card = frame.locator('.card').first();
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await redo.isDisabled(), true);
  assert.equal(await undo.getAttribute('title'), '撤销 · Cmd/Ctrl+Z');
  assert.equal(await redo.getAttribute('title'), '重做 · Cmd/Ctrl+Shift+Z');

  await createManualTextAction(page, '人工新标题');
  await waitForRevision(page, 1);
  await waitForHistoryReady(page);
  assert.equal(await undo.isEnabled(), true);
  assert.match(await undo.getAttribute('title'), /撤销文字修改/);
  await page.locator('[data-current-page]').click();
  await page.keyboard.press('Control+z');
  await waitForRevision(page, 2);
  await waitForHistoryReady(page);
  assert.equal(await heading.textContent(), '第一页标题');
  assert.equal(await redo.isEnabled(), true);
  assert.match(await redo.getAttribute('title'), /重做文字修改/);
  await redo.click();
  await waitForRevision(page, 3);
  assert.equal(await heading.textContent(), '人工新标题');

  await createManualMoveAction(page);
  await waitForRevision(page, 4);
  await waitForHistoryReady(page);
  assert.match(await undo.getAttribute('title'), /撤销移动/);
  assert.notEqual(await heading.evaluate(element => element.style.translate), '');
  await undo.click();
  await waitForRevision(page, 5);
  assert.equal(await heading.evaluate(element => element.style.translate), '');

  const originalCardSize = await card.evaluate(element => ({
    width:Number.parseFloat(getComputedStyle(element).width),
    height:Number.parseFloat(getComputedStyle(element).height),
  }));
  await createManualResizeAction(page);
  await waitForRevision(page, 6);
  await waitForHistoryReady(page);
  assert.match(await undo.getAttribute('title'), /撤销缩放/);
  assert.ok(await card.evaluate((element, original) => (
    Number.parseFloat(element.style.width) > original.width
      && Number.parseFloat(element.style.height) > original.height
  ), originalCardSize));
  await undo.click();
  await waitForRevision(page, 7);
  assert.deepEqual(await card.evaluate(element => ({
    width:Number.parseFloat(getComputedStyle(element).width),
    height:Number.parseFloat(getComputedStyle(element).height),
  })), originalCardSize);

  const targets = await page.locator('#deck-frame').evaluate(frameElement => {
    const document = frameElement.contentDocument;
    const runtime = frameElement.contentWindow.HuaweiDeckPatchRuntime;
    return {
      heading:runtime.makeLocator(document.querySelector('h2')),
      card:runtime.makeLocator(document.querySelector('.card')),
      secondHeading:runtime.makeLocator(document.querySelectorAll('h2')[1]),
    };
  });
  const created = await postJson(app, '/api/tasks', {
    expectedRevision:7,
    pageKey:targets.heading.pageKey,
    pageIndex:1,
    pageLabel:'目录页',
    rect:{ x:20, y:20, w:400, h:180 },
    instruction:'整体替换标题并移动卡片',
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const taskId = created.body.task.id;
  const applied = await postJson(app, '/api/actions', {
    expectedRevision:8,
    taskId,
    actions:[
      { id:'history-agent-text', taskId, target:targets.heading, kind:'setText', payload:{ text:'Agent 批次标题' } },
      { id:'history-agent-move', taskId, target:targets.card, kind:'translate', payload:{ x:60, y:30 } },
    ],
  });
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  await waitForRevision(page, 9);
  await waitForHistoryReady(page);
  await page.waitForFunction(() => {
    const deckDocument = document.querySelector('#deck-frame').contentDocument;
    return deckDocument.querySelector('h2').textContent === 'Agent 批次标题'
      && deckDocument.querySelector('.card').style.translate === '60px 30px';
  });
  assert.match(await undo.getAttribute('title'), /撤销 Agent 任务：整体替换标题并移动卡片/);
  await undo.click();
  await waitForRevision(page, 10);
  await waitForHistoryReady(page);
  assert.equal(await heading.textContent(), '人工新标题');
  assert.equal(await card.evaluate(element => element.style.translate), '');
  assert.equal(await redo.getAttribute('data-group-id'), applied.body.groupId);
  await redo.click();
  await waitForRevision(page, 11);
  assert.equal(await heading.textContent(), 'Agent 批次标题');
  assert.equal(await card.evaluate(element => element.style.translate), '60px 30px');

  await openCompletedTasks(page);
  await page.locator(`[data-task-undo="${taskId}"]`).click();
  await waitForRevision(page, 12);
  await waitForHistoryReady(page);
  assert.equal(await heading.textContent(), '人工新标题');
  assert.equal(await redo.getAttribute('data-group-id'), applied.body.groupId);
  assert.match(await redo.getAttribute('title'), /重做 Agent 任务：整体替换标题并移动卡片/);
  await redo.click();
  await waitForRevision(page, 13);
  await page.waitForSelector(`[data-task-row="${taskId}"] .task-status-completed`, {
    state:'attached',
  });
  assert.equal(await heading.textContent(), 'Agent 批次标题');

  await page.reload();
  await waitForRevision(page, 13);
  await page.waitForSelector('[data-page-key]');
  await waitForHistoryReady(page);
  assert.equal(await undo.getAttribute('data-group-id'), applied.body.groupId);
  assert.match(await undo.getAttribute('title'), /撤销 Agent 任务：整体替换标题并移动卡片/);
  assert.equal(await redo.isDisabled(), true);

  await createManualTextAction(page, '冲突前标题');
  await waitForRevision(page, 14);
  await waitForHistoryReady(page);
  const staleGroupId = await undo.getAttribute('data-group-id');
  let interceptedUndoRequests = 0;
  let releaseUndo;
  const undoReleased = new Promise(resolve => { releaseUndo = resolve; });
  let markUndoIntercepted;
  const undoIntercepted = new Promise(resolve => { markUndoIntercepted = resolve; });
  await page.route('**/api/groups/**/undo*', async route => {
    interceptedUndoRequests += 1;
    markUndoIntercepted();
    await undoReleased;
    await route.continue();
  });
  const clickPromise = undo.click();
  await undoIntercepted;
  assert.equal(await undo.isDisabled(), true, '请求期间撤销按钮必须锁定');
  assert.equal(await redo.isDisabled(), true, '请求期间重做按钮必须锁定');
  assert.equal(await undo.locator('xpath=..').getAttribute('data-busy'), 'true');

  const concurrent = await postJson(app, '/api/actions', {
    expectedRevision:14,
    taskId:null,
    actions:[{
      id:'history-concurrent-text', taskId:null, target:targets.secondHeading,
      kind:'setText', payload:{ text:'并发新候选' },
    }],
  });
  assert.equal(concurrent.response.status, 200, JSON.stringify(concurrent.body));
  releaseUndo();
  await clickPromise;
  await waitForRevision(page, 15);
  await page.waitForFunction(id => (
    document.querySelector('[data-history-undo]')?.dataset.groupId === id
  ), concurrent.body.groupId);
  assert.equal(interceptedUndoRequests, 1, '陈旧 revision 不得自动重试新的候选');
  assert.notEqual(staleGroupId, concurrent.body.groupId);
  assert.equal(await heading.textContent(), '冲突前标题');
  assert.equal(await frame.locator('h2').nth(1).textContent(), '并发新候选');
  const finalState = await readSession(app);
  assert.equal(finalState.revision, 15);
  assert.equal(finalState.groups.at(-2).active, true);
  assert.equal(finalState.groups.at(-1).active, true);
  assert.deepEqual(
    browserProblems.splice(0),
    ['Failed to load resource: the server responded with a status of 409 (Conflict)'],
    '仅允许测试刻意制造的 revision conflict 资源日志',
  );
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('外部历史事件刷新权威 session 前锁定旧候选', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const undo = page.locator('[data-history-undo]');

  await createManualTextAction(page, '已有人工标题');
  await waitForRevision(page, 1);
  await page.waitForFunction(() => document.querySelector('[data-history-undo]')?.disabled === false);
  const previousGroupId = await undo.getAttribute('data-group-id');
  const secondHeadingTarget = await page.locator('#deck-frame').evaluate(frameElement => (
    frameElement.contentWindow.HuaweiDeckPatchRuntime.makeLocator(
      frameElement.contentDocument.querySelectorAll('h2')[1],
    )
  ));

  let releaseSession;
  const sessionReleased = new Promise(resolve => { releaseSession = resolve; });
  let markSessionIntercepted;
  const sessionIntercepted = new Promise(resolve => { markSessionIntercepted = resolve; });
  await page.route('**/api/session*', async route => {
    markSessionIntercepted();
    await sessionReleased;
    await route.continue();
  });

  try {
    const concurrent = await postJson(app, '/api/actions', {
      expectedRevision:1,
      taskId:null,
      actions:[{
        id:'history-refresh-race', taskId:null, target:secondHeadingTarget,
        kind:'setText', payload:{ text:'外部最新标题' },
      }],
    });
    assert.equal(concurrent.response.status, 200, JSON.stringify(concurrent.body));
    await sessionIntercepted;
    await waitForRevision(page, 2);
    assert.equal(await undo.isDisabled(), true, '权威 group 尚未刷新时必须锁定旧候选');
    assert.equal(await undo.getAttribute('data-group-id'), '');
    assert.equal(await undo.locator('xpath=..').getAttribute('aria-busy'), 'true');
    assert.notEqual(previousGroupId, concurrent.body.groupId);
  } finally {
    releaseSession();
  }

  await page.waitForFunction(() => document.querySelector('[data-history-undo]')?.disabled === false);
  const state = await readSession(app);
  assert.equal(await undo.getAttribute('data-group-id'), state.groups.at(-1).id);
  assert.equal(await page.frameLocator('#deck-frame').locator('h2').nth(1).textContent(), '外部最新标题');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('group API 已保存但 session 刷新失败时保持同步待确认语义', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const undo = page.locator('[data-history-undo]');

  await createManualTextAction(page, '等待同步的标题');
  await waitForRevision(page, 1);
  await page.waitForFunction(() => document.querySelector('[data-history-undo]')?.disabled === false);
  let sessionRequests = 0;
  await page.route('**/api/session*', async route => {
    sessionRequests += 1;
    await route.fulfill({
      status:503,
      contentType:'application/json',
      body:JSON.stringify({ error:'TEMPORARY_UNAVAILABLE', message:'测试中的 session 暂时不可用' }),
    });
  });

  await page.locator('[data-current-page]').click();
  await page.keyboard.press('Control+z');
  await waitForRevision(page, 2);
  await page.waitForFunction(() => /撤销已保存/.test(
    document.querySelector('[data-history-notice]')?.textContent ?? '',
  ));
  assert.match(await page.locator('[data-history-notice]').textContent(), /同步待确认|同步待重试/);
  assert.equal(await page.locator('[data-task-drawer]').getAttribute('data-open'), 'false',
    '全局撤销的同步提示不应自动展开 Agent 任务面板');
  assert.equal(sessionRequests, 1, '已保存后的 session 刷新失败不得进入通用失败分支重试');
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await undo.getAttribute('data-group-id'), '');
  const state = await readSession(app);
  assert.equal(state.revision, 2);
  assert.equal(state.groups[0].active, false);
  assert.equal(await page.frameLocator('#deck-frame').locator('h2').first().textContent(), '第一页标题');
  assert.deepEqual(browserProblems.splice(0), [
    'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
  ]);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('HTTP 先于 history WebSocket 时人工动作与任务行撤销都先锁定旧候选', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(6_000);
  const undo = page.locator('[data-history-undo]');
  const redo = page.locator('[data-history-redo]');

  await createManualTextAction(page, '第一组人工标题');
  await waitForRevision(page, 1);
  await page.waitForFunction(() => document.querySelector('[data-history-undo]')?.disabled === false);
  await reloadWithoutHistoryEvents(page);
  await waitForRevision(page, 1);
  const firstGroupId = await undo.getAttribute('data-group-id');

  let releaseManualSession;
  const manualSessionReleased = new Promise(resolve => { releaseManualSession = resolve; });
  let markManualSession;
  const manualSessionIntercepted = new Promise(resolve => { markManualSession = resolve; });
  await page.route('**/api/session*', async route => {
    markManualSession();
    await manualSessionReleased;
    await route.continue();
  });
  try {
    await createManualTextAction(page, '第二组人工标题');
    await manualSessionIntercepted;
    await waitForRevision(page, 2);
    assert.equal(await undo.isDisabled(), true, '人工动作 HTTP 成功后必须立刻锁定旧候选');
    assert.equal(await undo.getAttribute('data-group-id'), '');
    assert.notEqual(firstGroupId, '');
  } finally {
    releaseManualSession();
  }
  await page.waitForFunction(id => (
    document.querySelector('[data-history-undo]')?.dataset.groupId !== ''
      && document.querySelector('[data-history-undo]')?.dataset.groupId !== id
  ), firstGroupId);
  await page.unroute('**/api/session*');

  const target = await page.locator('#deck-frame').evaluate(frameElement => (
    frameElement.contentWindow.HuaweiDeckPatchRuntime.makeLocator(
      frameElement.contentDocument.querySelector('h2'),
    )
  ));
  const created = await postJson(app, '/api/tasks', {
    expectedRevision:2,
    pageKey:target.pageKey,
    pageIndex:1,
    pageLabel:'目录页',
    rect:{ x:20, y:20, w:400, h:180 },
    instruction:'定点撤销门控测试',
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const taskId = created.body.task.id;
  const applied = await postJson(app, '/api/actions', {
    expectedRevision:3,
    taskId,
    actions:[{
      id:'history-task-gate', taskId, target, kind:'setText', payload:{ text:'任务完成标题' },
    }],
  });
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  await page.reload();
  await waitForRevision(page, 4);
  await openCompletedTasks(page);
  await page.waitForSelector(`[data-task-undo="${taskId}"]`);
  assert.equal(await undo.getAttribute('data-group-id'), applied.body.groupId);

  let releaseUndoSession;
  const undoSessionReleased = new Promise(resolve => { releaseUndoSession = resolve; });
  let markUndoSession;
  const undoSessionIntercepted = new Promise(resolve => { markUndoSession = resolve; });
  await page.route('**/api/session*', async route => {
    markUndoSession();
    await undoSessionReleased;
    await route.continue();
  });
  try {
    await page.locator(`[data-task-undo="${taskId}"]`).click();
    await undoSessionIntercepted;
    await waitForRevision(page, 5);
    assert.equal(await undo.isDisabled(), true, '任务行撤销 HTTP 成功后必须锁定旧候选');
    assert.equal(await redo.isDisabled(), true);
    assert.equal(await undo.getAttribute('data-group-id'), '');
    assert.equal(await redo.getAttribute('data-group-id'), '');
  } finally {
    releaseUndoSession();
  }
  await page.waitForFunction(id => (
    document.querySelector('[data-history-redo]')?.dataset.groupId === id
  ), applied.body.groupId);
  assert.equal(await redo.isEnabled(), true);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('409 无 revision 且 session 503 时持续锁定并在后续快照成功后恢复', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(6_000);
  const undo = page.locator('[data-history-undo]');

  await createManualTextAction(page, '冲突前已有标题');
  await waitForRevision(page, 1);
  await page.waitForFunction(() => document.querySelector('[data-history-undo]')?.disabled === false);
  const secondHeadingTarget = await page.locator('#deck-frame').evaluate(frameElement => (
    frameElement.contentWindow.HuaweiDeckPatchRuntime.makeLocator(
      frameElement.contentDocument.querySelectorAll('h2')[1],
    )
  ));
  let groupRequests = 0;
  await page.route('**/api/groups/**/undo*', async route => {
    groupRequests += 1;
    await route.fulfill({
      status:409,
      contentType:'application/json',
      body:JSON.stringify({ error:'REVISION_CONFLICT', message:'测试中的无 revision 冲突' }),
    });
  });
  let allowSession = false;
  await page.route('**/api/session*', async route => {
    if (allowSession) return route.continue();
    return route.fulfill({
      status:503,
      contentType:'application/json',
      body:JSON.stringify({ error:'TEMPORARY_UNAVAILABLE', message:'测试中的 session 暂不可用' }),
    });
  });

  await undo.click();
  await page.waitForFunction(() => /历史已更新/.test(
    document.querySelector('[data-history-notice]')?.textContent ?? '',
  ));
  assert.equal(groupRequests, 1, '409 不得自动重发 group 请求');
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await undo.getAttribute('data-group-id'), '');
  assert.equal((await readSession(app)).revision, 1);

  allowSession = true;
  const concurrent = await postJson(app, '/api/actions', {
    expectedRevision:1,
    taskId:null,
    actions:[{
      id:'history-conflict-recovery', taskId:null, target:secondHeadingTarget,
      kind:'setText', payload:{ text:'冲突后的权威候选' },
    }],
  });
  assert.equal(concurrent.response.status, 200, JSON.stringify(concurrent.body));
  await page.waitForFunction(id => (
    document.querySelector('[data-history-undo]')?.dataset.groupId === id
      && document.querySelector('[data-history-undo]')?.disabled === false
  ), concurrent.body.groupId);
  assert.equal(groupRequests, 1);
  assert.ok(browserProblems.every(problem => /409 \(Conflict\)|503 \(Service Unavailable\)/.test(problem)),
    JSON.stringify(browserProblems));
  browserProblems.splice(0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('committed 错误响应不重发 group 请求并等待后续权威快照恢复', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(6_000);
  const undo = page.locator('[data-history-undo]');

  await createManualTextAction(page, 'committed 分支标题');
  await waitForRevision(page, 1);
  const secondHeadingTarget = await page.locator('#deck-frame').evaluate(frameElement => (
    frameElement.contentWindow.HuaweiDeckPatchRuntime.makeLocator(
      frameElement.contentDocument.querySelectorAll('h2')[1],
    )
  ));
  let groupRequests = 0;
  await page.route('**/api/groups/**/undo*', async route => {
    groupRequests += 1;
    const response = await route.fetch();
    const body = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(body));
    await route.fulfill({
      status:503,
      contentType:'application/json',
      body:JSON.stringify({
        ...body,
        error:'RECOVERY_REQUIRED',
        message:'测试中的已提交回执异常',
        committed:true,
      }),
    });
  });
  let allowSession = false;
  await page.route('**/api/session*', async route => {
    if (allowSession) return route.continue();
    return route.fulfill({
      status:503,
      contentType:'application/json',
      body:JSON.stringify({ error:'TEMPORARY_UNAVAILABLE', message:'测试中的 session 暂不可用' }),
    });
  });

  await undo.click();
  await waitForRevision(page, 2);
  await page.waitForFunction(() => /撤销已保存.*同步待确认/.test(
    document.querySelector('[data-history-notice]')?.textContent ?? '',
  ));
  assert.equal(groupRequests, 1);
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await undo.getAttribute('data-group-id'), '');
  const committedState = await readSession(app);
  assert.equal(committedState.revision, 2);
  assert.equal(committedState.groups[0].active, false);

  allowSession = true;
  const concurrent = await postJson(app, '/api/actions', {
    expectedRevision:2,
    taskId:null,
    actions:[{
      id:'history-committed-recovery', taskId:null, target:secondHeadingTarget,
      kind:'setText', payload:{ text:'committed 后权威候选' },
    }],
  });
  assert.equal(concurrent.response.status, 200, JSON.stringify(concurrent.body));
  await page.waitForFunction(id => (
    document.querySelector('[data-history-undo]')?.dataset.groupId === id
      && document.querySelector('[data-history-undo]')?.disabled === false
  ), concurrent.body.groupId);
  assert.equal(groupRequests, 1);
  assert.ok(browserProblems.every(problem => /503 \(Service Unavailable\)/.test(problem)),
    JSON.stringify(browserProblems));
  browserProblems.splice(0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('真实 syncPending 响应在权威 session 收敛前锁定且不重发 group 请求', async t => {
  const app = await startFixtureServer({ bridgeTimeoutMs:100 });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(6_000);
  const undo = page.locator('[data-history-undo]');
  const redo = page.locator('[data-history-redo]');

  await createManualTextAction(page, 'syncPending 分支标题');
  await waitForRevision(page, 1);
  const groupId = await undo.getAttribute('data-group-id');
  await page.evaluate(() => {
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedSend(data) {
      let message;
      try { message = JSON.parse(String(data)); } catch { return originalSend.call(this, data); }
      if (message.type === 'actions-committed' || message.type === 'actions-synced') return;
      return originalSend.call(this, data);
    };
  });
  let releaseSession;
  const sessionReleased = new Promise(resolve => { releaseSession = resolve; });
  let markSession;
  const sessionIntercepted = new Promise(resolve => { markSession = resolve; });
  await page.route('**/api/session*', async route => {
    markSession();
    await sessionReleased;
    await route.continue();
  });
  let groupRequests = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/groups\/[^/]+\/undo$/.test(new URL(request.url()).pathname)) {
      groupRequests += 1;
    }
  });
  const responsePromise = page.waitForResponse(response => (
    response.request().method() === 'POST'
      && /\/api\/groups\/[^/]+\/undo$/.test(new URL(response.url()).pathname)
  ));

  await undo.click();
  const response = await responsePromise;
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  assert.equal(body.syncPending, true, JSON.stringify(body));
  await sessionIntercepted;
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await redo.isDisabled(), true);
  assert.equal(await undo.getAttribute('data-group-id'), '');
  assert.equal(await redo.getAttribute('data-group-id'), '');
  assert.equal(groupRequests, 1);
  releaseSession();

  await page.waitForFunction(() => /撤销已保存.*浏览器同步待重试/.test(
    document.querySelector('[data-history-notice]')?.textContent ?? '',
  ));
  await page.waitForFunction(id => (
    document.querySelector('[data-history-redo]')?.dataset.groupId === id
      && document.querySelector('[data-history-redo]')?.disabled === false
  ), groupId);
  assert.equal(groupRequests, 1);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('任务行撤销已保存但 session 刷新失败时不误报未提交失败', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(6_000);
  const undo = page.locator('[data-history-undo]');
  const target = await page.locator('#deck-frame').evaluate(frameElement => (
    frameElement.contentWindow.HuaweiDeckPatchRuntime.makeLocator(
      frameElement.contentDocument.querySelector('h2'),
    )
  ));
  const created = await postJson(app, '/api/tasks', {
    expectedRevision:0,
    pageKey:target.pageKey,
    pageIndex:1,
    pageLabel:'目录页',
    rect:{ x:20, y:20, w:400, h:180 },
    instruction:'任务行 durable 语义测试',
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const taskId = created.body.task.id;
  const applied = await postJson(app, '/api/actions', {
    expectedRevision:1,
    taskId,
    actions:[{
      id:'history-task-durable', taskId, target, kind:'setText', payload:{ text:'任务 durable 标题' },
    }],
  });
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  await waitForRevision(page, 2);
  await openCompletedTasks(page);
  await page.waitForSelector(`[data-task-undo="${taskId}"]`);
  let sessionRequests = 0;
  await page.route('**/api/session*', async route => {
    sessionRequests += 1;
    await route.fulfill({
      status:503,
      contentType:'application/json',
      body:JSON.stringify({ error:'TEMPORARY_UNAVAILABLE', message:'任务行测试中的 session 暂不可用' }),
    });
  });

  await page.locator(`[data-task-undo="${taskId}"]`).click();
  await waitForRevision(page, 3);
  await page.waitForFunction(() => /撤销已保存/.test(
    document.querySelector('[data-process-note]')?.textContent ?? '',
  ));
  assert.doesNotMatch(await page.locator('[data-process-note]').textContent(), /撤销失败/);
  assert.match(await page.locator('[data-process-note]').textContent(), /会话同步待重试/);
  assert.equal(sessionRequests, 1);
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await undo.getAttribute('data-group-id'), '');
  const state = await readSession(app);
  assert.equal(state.revision, 3);
  assert.equal(state.groups[0].active, false);
  assert.ok(browserProblems.every(problem => /503 \(Service Unavailable\)/.test(problem)),
    JSON.stringify(browserProblems));
  browserProblems.splice(0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('源码改动让旧定位指纹变化后，后续文字修改仍可撤销', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app, {
    maxPilotDocumentBlobAborts:2,
  });
  t.after(() => browser.close());
  page.setDefaultTimeout(8_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();

  await page.locator('#deck-frame').evaluate(frame => {
    frame.contentDocument.querySelector('#__deck_loading_overlay')?.remove();
  });
  await createManualTextAction(page, '第一轮文字修改');
  await waitForRevision(page, 1);

  const workingBefore = await readFile(app.workingDeckPath, 'utf8');
  const workingLines = workingBefore.split('\n');
  const templateMarker = workingLines.findIndex(line => (
    line.trim() === '<script type="__bundler/template">'
  ));
  assert.ok(templateMarker >= 0, '测试 bundle 缺少 template');
  const workingTemplate = JSON.parse(workingLines[templateMarker + 1]);
  const workingTemplateAfter = workingTemplate.replace(
    /<h2([^>]*)>第一页标题<\/h2>/,
    '<h2$1 style="font-family:serif">第一页标题</h2>',
  );
  assert.notEqual(
    workingTemplateAfter, workingTemplate,
    '测试前提失败：未修改工作副本中的标题样式',
  );
  workingLines[templateMarker + 1] = JSON.stringify(workingTemplateAfter).replaceAll(
    '</', '<\\u002F',
  );
  await writeFile(app.workingDeckPath, workingLines.join('\n'));
  await waitForRevision(page, 2);
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument
    ?.querySelector('h2')?.getAttribute('style')?.includes('font-family'));
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument
    ?.querySelector('h2')?.textContent === '第一轮文字修改');
  await page.locator('#deck-frame').evaluate(frame => {
    frame.contentDocument.querySelector('#__deck_loading_overlay')?.remove();
  });

  await createManualTextAction(page, '第二轮删字');
  await waitForRevision(page, 3);
  await page.locator('[data-history-undo]').click();
  await waitForRevision(page, 4);
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument
    ?.querySelector('h2')?.textContent === '第一轮文字修改');

  const state = await readSession(app);
  assert.deepEqual(state.groups.map(group => [group.mutationType, group.active]), [
    ['action', true],
    ['source', true],
    ['action', false],
  ]);
  assert.doesNotMatch(
    (await page.frameLocator('#deck-frame').locator('[data-direct-status]').allTextContents()).join(' '),
    /恢复失败|TARGET_AMBIGUOUS/,
  );
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('runtime 重放冲突会从 frame 明确投影到全局历史提示', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);

  await page.frameLocator('#deck-frame').locator('body').evaluate(body => {
    body.ownerDocument.dispatchEvent(new CustomEvent(
      'huawei-deck-patch-replay-error',
      { detail:{
        code:'TARGET_AMBIGUOUS',
        actionId:'replay-conflict',
        failedActionId:'replay-conflict',
      } },
    ));
  });

  await page.waitForFunction(() => /历史重放冲突：TARGET_AMBIGUOUS/.test(
    document.querySelector('[data-history-notice]')?.textContent ?? '',
  ));
  assert.equal(await page.locator('[data-history-notice]').getAttribute('data-state'), 'error');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('跨页撤销和重做会定位到修改所在页', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  await createManualTextAction(page, '跨页修改标题');
  await waitForRevision(page, 1);
  await waitForHistoryReady(page);
  for (const [method, revision, title] of [
    ['undo', 2, '第一页标题'], ['redo', 3, '跨页修改标题'],
    ['undo', 4, '第一页标题'], ['redo', 5, '跨页修改标题'],
  ]) {
    await page.locator('.page-item[data-page-index="2"]').click();
    await page.waitForFunction(() => document.querySelector('.page-item[aria-current="page"]')?.dataset.pageIndex === '2');
    if (revision < 4) await page.locator(`[data-history-${method}]`).click();
    else await page.keyboard.press(method === 'undo' ? 'Control+z' : 'Control+Shift+z');
    await waitForRevision(page, revision);
    await waitForHistoryReady(page);
    assert.equal(await page.frameLocator('#deck-frame').locator('h2').first().textContent(), title);
    await page.waitForFunction(() => document.querySelector('.page-item[aria-current="page"]')?.dataset.pageIndex === '1');
  }
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});


test('任务行跨页撤销和重做会定位到任务页', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const target = await page.locator('#deck-frame').evaluate(frame => (
    frame.contentWindow.HuaweiDeckPatchRuntime.makeLocator(frame.contentDocument.querySelector('h2'))
  ));
  const created = await postJson(app, '/api/tasks', {
    expectedRevision:0, pageKey:target.pageKey, pageIndex:1, pageLabel:'目录页',
    rect:{ x:20, y:20, w:400, h:180 }, instruction:'跨页任务修改',
  });
  assert.equal(created.response.status, 201);
  const taskId = created.body.task.id;
  const applied = await postJson(app, '/api/actions', {
    expectedRevision:1, taskId,
    actions:[{ id:'cross-page-task', taskId, target, kind:'setText', payload:{ text:'任务修改标题' } }],
  });
  assert.equal(applied.response.status, 200);
  await waitForRevision(page, 2);
  await openCompletedTasks(page);
  for (const [method, revision, title] of [
    ['undo', 3, '第一页标题'], ['redo', 4, '任务修改标题'],
  ]) {
    await waitForHistoryReady(page);
    await page.locator('.page-item[data-page-index="2"]').click();
    await page.waitForFunction(() => document.querySelector('.page-item[aria-current="page"]')?.dataset.pageIndex === '2');
    await openCompletedTasks(page);
    await page.locator(`[data-task-${method}="${taskId}"]`).click();
    await waitForRevision(page, revision);
    await waitForHistoryReady(page);
    assert.equal(await page.frameLocator('#deck-frame').locator('h2').first().textContent(), title);
    await page.waitForFunction(() => document.querySelector('.page-item[aria-current="page"]')?.dataset.pageIndex === '1');
  }
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});
