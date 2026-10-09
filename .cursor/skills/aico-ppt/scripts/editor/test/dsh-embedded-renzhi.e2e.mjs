import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server.mjs';
import { createPilotTasks, openEditor } from './test-helpers.mjs';

const SOURCE_DECK = process.env.AICO_PPT_RENZHI_FIXTURE ? resolve(process.env.AICO_PPT_RENZHI_FIXTURE) : fileURLToPath(new URL(
  '../../../Deck-Projects/renzhi/renzhi-deck.html', import.meta.url,
));
const pageCount = Number(process.env.AICO_PPT_RENZHI_PAGE_COUNT ?? 21);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function waitRevision(page, expected) {
  await page.waitForFunction(value => (
    document.querySelector('[data-revision]')?.textContent === String(value)
  ), expected);
}

async function dragHandle(page, locator, { dx, dy }) {
  const box = await locator.boundingBox();
  assert.ok(box, '选区操作手柄必须可见');
  const start = { x:box.x + box.width / 2, y:box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps:8 });
  await page.mouse.up();
}

test('DSH 右侧工作台完整承载原版 renzhi Editor 操作与 Agent 消息桥', {
  timeout:90_000,
  skip:!process.env.AICO_PPT_RENZHI_FIXTURE && !existsSync(SOURCE_DECK)
    ? '未提供 renzhi 业务验收 Deck；可用 AICO_PPT_RENZHI_FIXTURE 指定' : false,
}, async t => {
  const sourceBefore = sha256(await readFile(SOURCE_DECK));
  const root = await mkdtemp(join(tmpdir(), 'aico-ppt-dsh-renzhi-'));
  const deckPath = join(root, 'renzhi-deck.html');
  await copyFile(SOURCE_DECK, deckPath);
  const workId = '51111111-1111-4111-8111-111111111111';
  const dshWorkItem = {
    kind:'editing',
    workId,
    projectRoot:root,
    dshBinding:{
      revision:2,
      workspaceId:'dsh-test-workspace',
      activeSessionId:'dsh-test-session',
      sessions:[{
        operationId:'52222222-2222-4222-8222-222222222222',
        sessionId:'dsh-test-session',
        workspaceId:'dsh-test-workspace',
        origin:'fresh',
        state:'available',
        createdAt:'2026-09-03T00:00:00.000Z',
      }],
      pendingOperation:null,
    },
  };

  const app = await startServer({
    deckPath,
    workId,
    host:'127.0.0.1',
    port:0,
    openBrowser:false,
    token:'dsh-renzhi',
    editorToken:'dsh-renzhi-editor',
    autoStartAgentTerminal:false,
    dshAgentBridge:true,
    dshWorkItemProvider:async () => structuredClone(dshWorkItem),
    dshWorkItemCommand:async (command, input) => {
      if (command === 'resolve-session') {
        return {
          status:input.sessionId === 'dsh-test-session' ? 'linked' : 'unlinked',
          workItem:input.sessionId === 'dsh-test-session'
            ? structuredClone(dshWorkItem) : null,
        };
      }
      if (command === 'activate-session') {
        assert.equal(input.workId, workId);
        assert.equal(input.sessionId, 'dsh-test-session');
        return { status:'active', workItem:structuredClone(dshWorkItem) };
      }
      throw new Error(`测试未实现的 DSH 工作项命令：${command}`);
    },
  });
  let opened;
  t.after(async () => {
    await opened?.browser.close().catch(() => {});
    await app.close().catch(() => {});
    assert.equal(sha256(await readFile(SOURCE_DECK)), sourceBefore, '真实源 Deck 不得被测试改写');
    await rm(root, { recursive:true, force:true });
  });

  opened = await openEditor(app, {
    embeddedMode:'dsh',
    parentOrigin:new URL(app.url).origin,
    workspaceUrl:`${app.url}/workbench?token=${encodeURIComponent(app.token)}`,
    readyTimeoutMs:20_000,
    allowPilotDocumentBlobAbort:true,
    initScript:({ root:projectRoot }) => {
      if (window.parent !== window) return;
      window.__dshAgentRequests = [];
      window.addEventListener('message', event => {
        if (event.data?.type === 'aico-ppt:dsh-request') {
          const { requestId, command, payload } = event.data;
          let result;
          if (command === 'describe-sessions') {
            result = payload.sessionIds.map(sessionId => sessionId === 'dsh-test-session' ? {
              sessionId,
              title:'Deck 测试会话',
              cwd:projectRoot,
              running:false,
            } : null);
          } else if (command === 'open-session') {
            result = { sessionId:payload.sessionId, title:'Deck 测试会话' };
          } else {
            result = { accepted:true, sessionId:payload.sessionId ?? null };
          }
          window.postMessage({
            type:'aico-ppt:dsh-result', requestId, ok:true, result,
          }, location.origin);
          return;
        }
        if (event.data?.type === 'aico-ppt:agent-request') {
          window.__dshAgentRequests.push(structuredClone(event.data));
        }
      });
    },
    initScriptArg:{ root },
  });
  const { page, browserProblems, resourceProblems } = opened;
  page.setDefaultTimeout(15_000);
  await page.setViewportSize({ width:1920, height:1080 });
  await page.waitForFunction(count => document.querySelectorAll('[data-page-key]').length === count, pageCount);
  await page.evaluate(projectRoot => window.postMessage({
    type:'aico-ppt:dsh-session-changed',
    session:{ sessionId:'dsh-test-session', title:'Deck 测试会话', cwd:projectRoot },
  }, location.origin), root);

  assert.equal(await page.locator('html').getAttribute('data-embedded'), 'dsh');
  assert.equal(await page.locator('html').getAttribute('data-runtime-profile'), 'dsh-product');
  assert.equal(await page.locator('.dev-shell-badge').isHidden(), true);
  assert.equal(await page.locator('.editor-shell').getAttribute('data-embedded'), 'dsh');
  assert.equal(await page.locator('[data-current-key]').isHidden(), true,
    'DSH 工作台不应显示内部 pageKey');
  for (const selector of ['.canvas-resolution', '.zoom-value', '.revision-value']) {
    assert.equal(await page.locator(selector).isHidden(), true,
      `DSH 工作台不应显示内部画布状态 ${selector}`);
  }
  const editorLocation = page.url();
  await page.evaluate(() => {
    window.__deckFrameWindow = document.querySelector('#deck-frame').contentWindow;
    window.postMessage({
      type:'aico-ppt:dsh-session-changed',
      session:{ sessionId:'ordinary-session', title:'普通会话', cwd:'/tmp/ordinary' },
    }, location.origin);
  });
  await page.waitForFunction(() => (
    document.querySelector('[data-dsh-session-control]')?.dataset.state === 'detached'
  ));
  assert.equal(page.url(), editorLocation, '普通 DSH 会话不得导航到其他 Editor 工作项');
  assert.equal(await page.evaluate(() => (
    document.querySelector('#deck-frame').contentWindow === window.__deckFrameWindow
  )), true, '普通 DSH 会话不得销毁或刷新 Deck iframe');
  await page.evaluate(() => window.postMessage({
    type:'aico-ppt:dsh-session-changed',
    session:{ sessionId:'dsh-test-session', title:'Deck 测试会话', cwd:'/tmp/deck' },
  }, location.origin));
  await page.waitForFunction(() => (
    document.querySelector('[data-dsh-session-control]')?.dataset.state === 'active'
  ));
  await page.setViewportSize({ width:720, height:900 });
  await page.locator('[data-workspace-navigation]').evaluate(element => { element.hidden = false; });
  const canvasToolbarContract = await page.locator('.canvas-toolbar').evaluate(toolbar => {
    const context = toolbar.querySelector('.canvas-context').getBoundingClientRect();
    const modes = toolbar.querySelector('.mode-tools').getBoundingClientRect();
    const tools = toolbar.querySelector('.canvas-tools').getBoundingClientRect();
    return {
      contextRight:context.right,
      modesLeft:modes.left,
      modesRight:modes.right,
      toolsWidth:tools.width,
      scrollWidth:toolbar.scrollWidth,
      clientWidth:toolbar.clientWidth,
    };
  });
  assert.ok(canvasToolbarContract.contextRight <= canvasToolbarContract.modesLeft,
    '页面标题与模式按钮不得重叠');
  assert.ok(canvasToolbarContract.toolsWidth <= 32,
    '隐藏状态文字后画布状态区只保留导出图标宽度');
  assert.equal(canvasToolbarContract.scrollWidth, canvasToolbarContract.clientWidth,
    'DSH 画布工具栏不得横向溢出');
  const topbarContract = await page.locator('.topbar').evaluate(element => {
    const selectors = [
      '[data-workspace-home]', '[data-workspace-switch]', '[data-history-undo]',
      '[data-history-redo]', '[data-solidify]', '[data-guided-tour="editing"]',
      '[data-exit-editor]',
    ];
    return {
      viewportWidth:innerWidth,
      scrollWidth:document.documentElement.scrollWidth,
      buttons:selectors.map(selector => {
        const button = element.querySelector(selector);
        const rect = button.getBoundingClientRect();
        const label = button.querySelector('.topbar-control-label');
        const icon = button.querySelector('.pill-nav-label-default .topbar-control-icon')
          ?? button.querySelector('.topbar-control-icon');
        return {
          selector,
          width:rect.width,
          left:rect.left,
          right:rect.right,
          labelDisplay:label ? getComputedStyle(label).display : 'none',
          iconDisplay:icon ? getComputedStyle(icon).display : null,
        };
      }),
    };
  });
  assert.equal(topbarContract.scrollWidth, topbarContract.viewportWidth,
    'DSH 窄面板不应产生横向溢出');
  for (const button of topbarContract.buttons) {
    assert.equal(button.width, 36, `${button.selector} 应固定为 36px 图标按钮`);
    assert.ok(button.left >= 0 && button.right <= topbarContract.viewportWidth,
      `${button.selector} 应完整落在窄面板内`);
    assert.equal(button.labelDisplay, 'none', `${button.selector} 不应在 DSH 顶栏显示长文本`);
    assert.notEqual(button.iconDisplay, 'none', `${button.selector} 必须保留可见 SVG 图标`);
  }
  assert.deepEqual(
    topbarContract.buttons.map(button => button.left),
    [...topbarContract.buttons].map(button => button.left).sort((a, b) => a - b),
    '顶栏焦点顺序与视觉顺序都应为项目导航、编辑操作、帮助、关闭',
  );
  assert.equal(
    await page.locator('[data-exit-editor]').getAttribute('aria-label'),
    '关闭 AICO-PPT 工作台',
  );
  assert.equal(
    await page.locator('[data-exit-editor]').getAttribute('data-toolbar-tooltip'),
    '关闭工作台',
  );
  await page.locator('[data-workspace-home]').hover();
  await page.waitForFunction(() => (
    document.querySelector('[data-topbar-tooltip]')?.dataset.visible === 'true'
  ));
  assert.equal(await page.locator('[data-topbar-tooltip]').textContent(), '返回初始页');
  assert.equal(
    await page.locator('[data-workspace-home]').getAttribute('aria-describedby'),
    'topbar-tooltip',
  );
  await page.mouse.move(8, 880);
  await page.locator('[data-workspace-switch]').hover();
  await page.waitForFunction(() => (
    document.querySelector('[data-topbar-tooltip]')?.dataset.visible === 'true'
  ));
  await page.locator('[data-workspace-switch]').click();
  const workspaceSwitcher = page.locator('[data-workspace-switcher]');
  await workspaceSwitcher.waitFor({ state:'visible' });
  const switcherBounds = await workspaceSwitcher.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { left:rect.left, right:rect.right, viewportWidth:innerWidth };
  });
  assert.ok(switcherBounds.left >= 8 && switcherBounds.right <= switcherBounds.viewportWidth - 8,
    '项目切换面板必须完整落在 DSH iframe 内');
  assert.equal(await page.locator('[data-topbar-tooltip]').isHidden(), true,
    '点击图标打开面板后不应继续悬浮显示按钮说明');
  await workspaceSwitcher.locator('.workspace-switcher-close').click();
  await page.setViewportSize({ width:1920, height:1080 });
  assert.deepEqual(await page.locator('[data-mode]').evaluateAll(buttons => buttons.map(button => ({
    mode:button.dataset.mode,
    disabled:button.disabled,
  }))), [
    { mode:'preview', disabled:false },
    { mode:'edit', disabled:false },
    { mode:'region', disabled:false },
  ]);

  const frame = page.frameLocator('#deck-frame');
  for (const mode of ['preview', 'edit', 'region']) {
    await page.locator(`[data-mode="${mode}"]`).click();
    await page.waitForFunction(expected => (
      document.querySelector('.mode-tools')?.dataset.activeMode === expected
      && document.querySelector('#deck-frame')?.contentDocument?.documentElement
        ?.dataset.deckEditorMode === expected
    ), mode);
    assert.equal(await page.locator(`[data-mode="${mode}"]`).getAttribute('aria-pressed'), 'true');
  }

  await page.locator('[data-mode="edit"]').click();
  await page.locator('[data-page-index="1"]').click();
  const title = frame.locator(
    '.slide-fit[data-idx="0"] .slide-canvas section > div:nth-child(3) > div:nth-child(1)',
  );
  await title.click();
  await page.waitForSelector('.inspector-body');
  assert.equal(await page.locator('.editor-shell').getAttribute('data-inspector-dock'), 'top');
  assert.equal(await page.locator('.inspector-panel').isVisible(), true);
  assert.equal(await page.locator('[data-inspector-group="text"] [data-value-property="font-size"]')
    .isVisible(), true);
  assert.equal(await frame.locator('[data-transform-selection]').count(), 1);

  // 这里实际执行原 Editor 的人工 Mutation，不只检查控件是否存在。
  const originalTitle = await title.textContent();
  const replacementTitle = 'DSH 嵌入模式操作回归';
  await title.fill(replacementTitle);
  await page.locator('[data-current-page]').click();
  await waitRevision(page, 1);
  assert.equal(await title.textContent(), replacementTitle);

  await page.locator('[data-history-undo]').click();
  await waitRevision(page, 2);
  assert.equal(await title.textContent(), originalTitle);
  await page.locator('[data-history-redo]').click();
  await waitRevision(page, 3);
  assert.equal(await title.textContent(), replacementTitle);

  await title.click();
  await title.evaluate(element => {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const selection = element.ownerDocument.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.ownerDocument.dispatchEvent(new Event('selectionchange'));
  });
  const fontWeightBefore = await title.evaluate(element => getComputedStyle(element).fontWeight);
  await page.locator('[data-style-property="font-weight"]').click();
  await waitRevision(page, 4);
  assert.notEqual(
    await title.evaluate(element => getComputedStyle(element).fontWeight),
    fontWeightBefore,
  );

  await title.click();
  await dragHandle(page, frame.locator('[data-transform-move-handle="left"]'), { dx:40, dy:20 });
  await waitRevision(page, 5);
  assert.notEqual(await title.evaluate(element => element.style.translate), '');

  const dimensionsBefore = await title.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { width:rect.width, height:rect.height };
  });
  await dragHandle(page, frame.locator('[data-resize-handle]'), { dx:36, dy:24 });
  await waitRevision(page, 6);
  const dimensionsAfter = await title.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { width:rect.width, height:rect.height };
  });
  assert.ok(dimensionsAfter.width > dimensionsBefore.width, { dimensionsBefore, dimensionsAfter });
  assert.ok(dimensionsAfter.height > dimensionsBefore.height, { dimensionsBefore, dimensionsAfter });

  await frame.locator('[data-transform-move-handle="left"]').click();
  await page.keyboard.press('Delete');
  await waitRevision(page, 7);
  await title.waitFor({ state:'hidden' });
  await page.locator('[data-history-undo]').click();
  await waitRevision(page, 8);
  await title.waitFor({ state:'visible' });
  await page.locator('[data-history-redo]').click();
  await waitRevision(page, 9);
  await title.waitFor({ state:'hidden' });
  await page.locator('[data-history-undo]').click();
  await waitRevision(page, 10);
  await title.waitFor({ state:'visible' });

  assert.equal(await page.locator('[data-agent-terminal-panel]').isHidden(), true);
  assert.equal(await page.locator('[data-agent-terminal-host] .xterm').count(), 0);
  assert.equal(await page.locator('[data-agent-status]').count(), 0,
    'DSH 已由左侧会话和右下角任务卡片展示 Agent 状态，不应保留无操作的机器人按钮');
  assert.equal(await page.locator('[data-history-undo]').count(), 1);
  assert.equal(await page.locator('[data-history-redo]').count(), 1);
  assert.equal(await page.locator('[data-solidify]').count(), 1);
  assert.equal(await page.locator('[data-export-pptx]').count(), 1);

  const pagePanel = page.locator('.page-panel');
  const collapsedWidth = await pagePanel.evaluate(node => node.getBoundingClientRect().width);
  await page.locator('[data-page-panel-toggle]').click();
  const expandedWidth = await pagePanel.evaluate(node => node.getBoundingClientRect().width);
  assert.ok(collapsedWidth <= 72 && expandedWidth >= 200, { collapsedWidth, expandedWidth });
  await page.locator('[data-page-panel-toggle]').click();

  const [task] = await createPilotTasks(app, page, [7]);
  assert.equal(await page.locator('[data-task-row]').count(), 1);
  assert.equal(await page.locator('[data-task-drawer]').evaluate(node => (
    getComputedStyle(node).position
  )), 'fixed');
  const drawerInset = await page.locator('[data-task-drawer]').evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { right:innerWidth - rect.right, bottom:innerHeight - rect.bottom };
  });
  assert.ok(drawerInset.right <= 24 && drawerInset.bottom <= 24, drawerInset);

  await page.locator('[data-process-all]').click();
  await page.waitForFunction(() => window.__dshAgentRequests.length === 1);
  const request = await page.evaluate(() => window.__dshAgentRequests[0]);
  assert.match(request.prompt, /^AICO-PPT 区域编辑任务：/u);
  assert.doesNotMatch(request.prompt, /^[/$]aico-ppt/u,
    '已有工作区的区域任务使用简洁编辑协议，不重新加载完整 Skill');
  assert.match(request.prompt, /aico_ppt\(\{operation:"inspect",taskId\}\)/u);
  assert.match(request.prompt, /operation:"edit"，expectedRevision 使用 inspect 返回值/u);
  assert.ok(request.prompt.includes(app.workingDeckPath), '任务必须绑定当前托管工作副本');
  assert.match(request.prompt, new RegExp(task.id, 'u'));
  assert.equal(request.sessionId, 'dsh-test-session');
  await page.evaluate(({ requestId }) => {
    window.postMessage({
      type:'aico-ppt:agent-result',
      requestId,
      accepted:false,
      message:'DSH 测试会话已验证收到任务',
    }, location.origin);
  }, request);
  await page.waitForFunction(() => document.querySelector('[data-process-note]')?.textContent
    .includes('DSH 测试会话已验证收到任务'));

  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});
