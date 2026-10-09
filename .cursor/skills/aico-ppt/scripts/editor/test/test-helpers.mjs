import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadChromium } from '../../verify/load-playwright.mjs';
import { startServer } from '../server.mjs';

export async function startFixtureServer(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deck-editor-fixture-'));
  const deckPath = join(root, 'minimal-deck.html');
  if (options.bundle) {
    const wrapper = await readFile(resolve('assets/training-deck.html'), 'utf8');
    let template = (await readFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'), 'utf8'))
      .replace('../../runtime/patch-runtime.js', '/editor/patch-runtime.js');
    if (typeof options.fixtureTransform === 'function') template = options.fixtureTransform(template);
    const lines = wrapper.split('\n');
    const manifest = lines.findIndex(line => line.trim() === '<script type="__bundler/manifest">');
    const bundledTemplate = lines.findIndex(line => line.trim() === '<script type="__bundler/template">');
    if (manifest < 0 || bundledTemplate < 0) throw new Error('测试 bundle 外壳缺少 manifest/template');
    lines[manifest + 1] = '{}';
    lines[bundledTemplate + 1] = JSON.stringify(template).replaceAll('</', '<\\u002F');
    await writeFile(deckPath, lines.join('\n'));
  } else {
    if (typeof options.fixtureTransform === 'function') {
      const fixture = await readFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'), 'utf8');
      await writeFile(deckPath, options.fixtureTransform(fixture));
    } else {
      await copyFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'), deckPath);
    }
  }
  try {
    const app = await startServer({
      deckPath,
      host: '127.0.0.1',
      port: 0,
      openBrowser: false,
      token: 'fixture-token',
      editorToken: 'fixture-editor-token',
      bridgeTimeoutMs: options.bridgeTimeoutMs,
      writerTimeoutMs: options.writerTimeoutMs,
      writerKillGraceMs: options.writerKillGraceMs,
      spawnWriter: options.spawnWriter,
      onActiveWritersChange: options.onActiveWritersChange,
      spawnAgentTerminal: options.spawnAgentTerminal,
      createAgentTerminalConversation: options.createAgentTerminalConversation,
      discoverAgentTerminalConversation: options.discoverAgentTerminalConversation,
      resumeAgentTerminalConversation: options.resumeAgentTerminalConversation,
      autoStartAgentTerminal: options.autoStartAgentTerminal,
      pptxExporter:options.pptxExporter,
      pickPptxFile:options.pickPptxFile,
      pptxExportTimeoutMs:options.pptxExportTimeoutMs,
      workingPatchVerifier: options.workingPatchVerifier ?? (async () => ({ ok:true })),
      pickDeckFile:options.pickDeckFile,
      agentRunTimeoutMs: options.agentRunTimeoutMs,
      agentRunAdapter: options.agentRunAdapter,
      dshAgentBridge: options.dshAgentBridge,
      ...(options.dshAgentBridge ? {
        workId:options.workId ?? '11111111-1111-4111-8111-111111111111',
        dshWorkItemProvider:options.dshWorkItemProvider ?? (async () => ({
          workId:options.workId ?? '11111111-1111-4111-8111-111111111111',
          dshBinding:{ activeSessionId:'dsh-test-session' },
        })),
        dshWorkItemCommand:options.dshWorkItemCommand ?? (async () => ({ workItem:null })),
      } : {}),
      editorAssets: options.editorAssets,
    });
    const closeServer = app.close;
    let closePromise;
    app.close = () => {
      closePromise ??= options.preserveRoot
        ? closeServer()
        : closeServer().finally(() => rm(root, {
          recursive:true, force:true, maxRetries:10, retryDelay:100,
        }));
      return closePromise;
    };
    app.cleanup = () => rm(root, {
      recursive:true, force:true, maxRetries:10, retryDelay:100,
    });
    return app;
  } catch (error) {
    await rm(root, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
    throw error;
  }
}

export function classifyResourceFailure(failure, options = {}) {
  const allowedPilotCancellations = Number.isInteger(options.maxPilotDocumentBlobAborts)
    ? Math.max(0, options.maxPilotDocumentBlobAborts)
    : options.allowPilotDocumentBlobAbort === true ? 1 : 0;
  const exactPilotCancellation = options.cancellationCount < allowedPilotCancellations
    && failure.resourceType === 'document'
    && failure.url.startsWith(`blob:${options.appUrl}/`)
    && failure.errorText === 'net::ERR_ABORTED';
  return exactPilotCancellation ? 'pilot-cancellation' : 'problem';
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  const settled = await Promise.race([
    Promise.resolve(promise).then(() => true, () => true),
    new Promise(resolvePromise => {
      timer = setTimeout(() => resolvePromise(false), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return settled;
}

export async function openEditor(app, options = {}) {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const browserProblems = [];
  const resourceProblems = [];
  const resourceCancellations = [];
  const resourceRequests = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const closeBrowser = browser.close.bind(browser);
    // 测试清理不模拟真实用户关窗，直接跳过页面退出生命周期。
    let closingBrowser;
    browser.close = (...args) => {
      closingBrowser ??= (async () => {
        if (!page.isClosed()) {
          const pageClosed = await settleWithin(
            page.close({ runBeforeUnload:false }), 3_000,
          );
          if (!pageClosed) {
            // synthetic pagehide 等测试场景偶发让 Playwright close RPC 永久等待；
            // 测试清理必须有界，断开 driver 会同时终止其启动的 Chrome。
            browser._connection?.close();
            return;
          }
        }
        const browserClosed = await settleWithin(closeBrowser(...args), 5_000);
        if (!browserClosed) browser._connection?.close();
      })();
      return closingBrowser;
    };
    page.on('console', message => {
      if (['error', 'warning'].includes(message.type())) browserProblems.push(message.text());
    });
    page.on('pageerror', error => browserProblems.push(error.message));
    page.on('request', request => resourceRequests.push(request.url()));
    page.on('requestfailed', request => {
      const failure = {
        resourceType:request.resourceType(),
        url:request.url(),
        errorText:request.failure()?.errorText ?? '',
      };
      const detail = `${failure.resourceType} ${failure.url} ${failure.errorText}`;
      if (classifyResourceFailure(failure, {
        appUrl:app.url,
        allowPilotDocumentBlobAbort:options.allowPilotDocumentBlobAbort,
        maxPilotDocumentBlobAborts:options.maxPilotDocumentBlobAborts,
        cancellationCount:resourceCancellations.length,
      }) === 'pilot-cancellation') {
        resourceCancellations.push(detail);
      } else {
        resourceProblems.push(detail);
      }
    });
    page.on('response', response => {
      const type = response.request().resourceType();
      if (['script', 'stylesheet', 'image'].includes(type) && !response.ok()) {
        resourceProblems.push(`${type} ${response.status()} ${response.url()}`);
      }
    });
    if (typeof options.initScript === 'function' || typeof options.initScript === 'string') {
      await page.addInitScript(options.initScript, options.initScriptArg);
    }
    const workspaceQuery = options.workspaceUrl
      ? `&workspaceUrl=${encodeURIComponent(options.workspaceUrl)}`
      : '';
    const embeddedQuery = options.embeddedMode
      ? `&embedded=${encodeURIComponent(options.embeddedMode)}`
        + (options.parentOrigin
          ? `&parentOrigin=${encodeURIComponent(options.parentOrigin)}` : '')
      : '';
    await page.goto(`${app.url}/?token=${encodeURIComponent(app.token)}`
      + `&editorToken=${encodeURIComponent(app.editorToken)}${workspaceQuery}${embeddedQuery}`);
    // 大型离线 bundle 在整套串行 E2E 中可能遇到磁盘/CPU 峰值；iframe 元素本身
    // 与 deck-ready 使用同一等待预算，避免已可见却刚好越过 3 秒硬阈值的假失败。
    await page.waitForSelector('#deck-frame', { timeout:options.readyTimeoutMs ?? 12_000 });
    // iframe 元素出现早于 frame bridge 完成稳定 canvas 发现；测试交互必须等 deck-ready
    // 已渲染页序，否则首个模式切换/拖拽可能在 bridge 注册监听器前丢失。
    await page.waitForSelector('[data-page-key]', { timeout:options.readyTimeoutMs ?? 12_000 });
    return {
      browser, page, browserProblems, resourceProblems, resourceCancellations, resourceRequests,
    };
  } catch (error) {
    error.browserProblems = browserProblems;
    error.resourceProblems = resourceProblems;
    await browser.close();
    throw error;
  }
}

export async function dragInFrame(page, start, end) {
  const frame = page.locator('#deck-frame');
  // 模式切换会改变属性面板和 iframe 缩放，不能在布局过渡中按旧坐标落下鼠标。
  await (await frame.elementHandle()).waitForElementState('stable');
  const delta = { x:end.x - start.x, y:end.y - start.y };
  const origin = await frame.evaluate((frameElement, point) => {
    const rect = frameElement.getBoundingClientRect();
    const owner = frameElement.ownerDocument;
    const requested = { x:rect.left + point.x, y:rect.top + point.y };
    if (owner.elementFromPoint(requested.x, requested.y) === frameElement) return requested;
    // 响应式布局可能把 iframe 的一部分裁到视口外。Playwright
    // 的 boundingBox 仍包含被裁部分；改用真正可命中的中心点。
    const candidate = {
      x:Math.min(innerWidth - 8, Math.max(8, rect.left + rect.width / 2)),
      y:Math.min(innerHeight - 8, Math.max(8, rect.top + rect.height / 2)),
    };
    if (owner.elementFromPoint(candidate.x, candidate.y) !== frameElement) {
      throw new Error('iframe 在当前视口没有可交互区域');
    }
    return candidate;
  }, start);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + delta.x, origin.y + delta.y, { steps:8 });
  await page.mouse.up();
}

async function pilotRequest(app, pathname, options = {}) {
  const separator = pathname.includes('?') ? '&' : '?';
  const response = await fetch(
    `${app.url}${pathname}${separator}token=${encodeURIComponent(app.token)}`,
    options,
  );
  let body;
  try { body = await response.json(); }
  catch { body = { message:await response.text() }; }
  if (!response.ok) {
    throw new Error(JSON.stringify({
      status:response.status,
      code:body.code ?? null,
      stage:body.stage ?? null,
      recovery:body.recovery ?? null,
      body,
    }));
  }
  return body;
}

async function pilotSession(app) {
  return pilotRequest(app, '/api/session');
}

async function waitForPilotSession(app, predicate, message, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  let state;
  while (Date.now() < deadline) {
    state = await pilotSession(app);
    if (predicate(state)) return state;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  throw new Error(`${message}：${JSON.stringify(state)}`);
}

async function pilotPost(app, pathname, input) {
  return pilotRequest(app, pathname, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(input),
  });
}

async function waitForPilotPage(page, pageKey) {
  await page.waitForFunction(key => {
    const frame = document.querySelector('#deck-frame');
    const runtime = frame?.contentWindow?.HuaweiDeckPatchRuntime;
    if (!runtime) return false;
    const canvas = [...frame.contentDocument.querySelectorAll('.stage .slide-canvas')]
      .find(candidate => runtime.pageKey(candidate) === key);
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const fit = canvas.closest('.slide-fit');
    const fitRect = fit?.getBoundingClientRect();
    const materialized = !fitRect
      || (rect.width >= fitRect.width * 0.95 && rect.height >= fitRect.height * 0.95);
    const pilotScaleReady = rect.width >= canvas.offsetWidth * 0.5
      && rect.height >= canvas.offsetHeight * 0.5;
    const hit = frame.contentDocument.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    const hitReady = hit?.closest?.('.slide-canvas') === canvas;
    return materialized && pilotScaleReady && hitReady
      && rect.bottom > 0 && rect.top < frame.contentWindow.innerHeight;
  }, pageKey, { timeout:12_000 });
}

async function pilotRegion(page, pageKey) {
  const region = await page.locator('#deck-frame').evaluate((frame, key) => {
    const { contentDocument:document, contentWindow:window } = frame;
    const runtime = window.HuaweiDeckPatchRuntime;
    const canvas = [...document.querySelectorAll('.stage .slide-canvas')]
      .find(candidate => runtime.pageKey(candidate) === key);
    if (!canvas) throw new Error(`试点页面不存在：${key}`);
    const canvasRect = canvas.getBoundingClientRect();
    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 12 || rect.height < 8) return false;
      for (let current=element; current && current!==canvas.parentElement; current=current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden'
          || Number(style.opacity || 1) <= 0) return false;
      }
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return hit?.closest?.('.slide-canvas') === canvas
        && rect.right > canvasRect.left && rect.left < canvasRect.right
        && rect.bottom > canvasRect.top && rect.top < canvasRect.bottom;
    };
    const elements = [...canvas.querySelectorAll('h1,h2,h3,h4,p,span,img,svg,table,[class]')]
      .filter(element => !element.closest('[data-deck-editor-ui]'))
      .filter(element => element.children.length === 0 || element.matches('img,svg,table'))
      .filter(isVisible)
      .map(element => ({ element, rect:element.getBoundingClientRect() }))
      .filter(item => item.rect.width * item.rect.height < canvasRect.width * canvasRect.height * 0.35)
      .sort((left, right) => {
        const leftText = (left.element.textContent ?? '').trim().length > 0 ? 1 : 0;
        const rightText = (right.element.textContent ?? '').trim().length > 0 ? 1 : 0;
        return rightText - leftText || left.rect.top - right.rect.top;
      });
    const chosen = elements.find(item => (
      item.rect.top >= canvasRect.top + 120
      && item.rect.bottom <= canvasRect.bottom - 80
    )) ?? elements[0];
    if (!chosen) throw new Error(`试点页面缺少可拉框内容：${key}`);
    const padding = 16;
    const left = Math.max(canvasRect.left + 1, chosen.rect.left - padding);
    const top = Math.max(canvasRect.top + 1, chosen.rect.top - padding);
    const right = Math.min(canvasRect.right - 1, chosen.rect.right + padding);
    const bottom = Math.min(canvasRect.bottom - 1, chosen.rect.bottom + padding);
    const frameRect = frame.getBoundingClientRect();
    const scaleX = frameRect.width / (frame.offsetWidth || window.innerWidth);
    const scaleY = frameRect.height / (frame.offsetHeight || window.innerHeight);
    const clampScreenX = value => Math.max(8, Math.min(frameRect.width - 8, value * scaleX));
    const clampScreenY = value => Math.max(8, Math.min(frameRect.height - 8, value * scaleY));
    return {
      start:{ x:clampScreenX(left), y:clampScreenY(top) },
      end:{ x:clampScreenX(right), y:clampScreenY(bottom) },
    };
  }, pageKey);
  await dragInFrame(page, region.start, region.end);
  return region;
}

export async function createPilotTasks(app, page, pageIndexes) {
  if (!Array.isArray(pageIndexes) || pageIndexes.length === 0) {
    throw new TypeError('试点页面索引必须为非空数组');
  }
  const created = [];
  await page.locator('[data-mode="region"]').click();
  for (const pageIndex of pageIndexes) {
    const navigation = page.locator(`[data-page-index="${pageIndex}"]`);
    const pageKey = await navigation.getAttribute('data-page-key');
    const pageLabel = await navigation.getAttribute('data-page-label');
    if (!pageKey || !pageLabel) {
      throw new Error(`页 ${pageIndex} 缺少 pageKey/pageLabel`);
    }
    const before = await pilotSession(app);
    await navigation.click();
    await waitForPilotPage(page, pageKey);
    const region = await pilotRegion(page, pageKey);
    const popover = page.frameLocator('#deck-frame').locator('[data-region-popover]');
    try {
      await popover.waitFor({ state:'visible' });
    } catch (error) {
      const diagnostics = await page.locator('#deck-frame').evaluate((frame, key) => {
        const runtime = frame.contentWindow.HuaweiDeckPatchRuntime;
        const canvas = [...frame.contentDocument.querySelectorAll('.stage .slide-canvas')]
          .find(candidate => runtime.pageKey(candidate) === key);
        return {
          frame:frame.getBoundingClientRect().toJSON(),
          canvas:canvas?.getBoundingClientRect().toJSON() ?? null,
          stageScrollTop:canvas?.closest('.stage')?.scrollTop ?? null,
        };
      }, pageKey);
      throw new Error(`页 ${pageIndex} 拉框未打开输入框：${JSON.stringify({ region, diagnostics })}`, {
        cause:error,
      });
    }
    await popover.locator('textarea').fill(`试点页 ${pageIndex} 修改`);
    await popover.locator('[data-region-submit]').click();
    await page.waitForFunction(count => (
      document.querySelectorAll('[data-task-row]').length === count
    ), before.tasks.length + 1, { timeout:12_000 });
    const next = await waitForPilotSession(
      app,
      state => state.revision === before.revision + 1 && state.tasks.length === before.tasks.length + 1,
      `等待页 ${pageIndex} 区域任务持久化超时`,
    );
    const task = next.tasks.at(-1);
    if (task.pageIndex !== pageIndex || task.pageKey !== pageKey || task.pageLabel !== pageLabel) {
      throw new Error(`页 ${pageIndex} 区域任务元数据不一致：${JSON.stringify(task)}`);
    }
    created.push(task);
    await popover.waitFor({ state:'detached', timeout:2_000 });
  }
  return created;
}

async function choosePilotActionTargets(page) {
  return page.locator('#deck-frame').evaluate(frame => {
    const { contentDocument:document, contentWindow:window } = frame;
    const runtime = window.HuaweiDeckPatchRuntime;
    const canvases = [...document.querySelectorAll('.stage .slide-canvas')];
    const canvas = canvases[8];
    if (!canvas) throw new Error('renzhi 试点缺少第 9 页');
    const section = canvas.querySelector('section[data-label]');
    const canvasRect = canvas.getBoundingClientRect();
    const forbidden = 'a,button,input,select,textarea,iframe,svg,[role="button"],[data-deck-editor-ui]';
    const visible = element => {
      if (element.matches(forbidden) || element.querySelector(forbidden)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 2) return false;
      for (let current=element; current && current!==canvas.parentElement; current=current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden'
          || Number(style.opacity || 1) <= 0) return false;
      }
      return rect.left >= canvasRect.left && rect.right <= canvasRect.right
        && rect.top >= canvasRect.top && rect.bottom <= canvasRect.bottom;
    };
    const textTargets = [...section.querySelectorAll('h1,h2,h3,h4,p,span,div')]
      .filter(element => element.children.length === 0 && visible(element))
      .map(element => ({ element, text:(element.textContent ?? '').trim() }))
      .filter(item => item.text.length >= 4 && item.text.length <= 32);
    if (textTargets.length < 2) throw new Error('第 9 页缺少两个安全文字目标');
    const setTextElement = textTargets[0].element;
    const translateElement = textTargets.find(item => item.element !== setTextElement)?.element;
    const resizeElement = [...section.querySelectorAll('div')]
      .filter(element => element.children.length === 0 && !(element.textContent ?? '').trim() && visible(element))
      .map(element => ({ element, rect:element.getBoundingClientRect() }))
      .find(item => item.rect.width >= 120 && item.rect.height >= 2 && item.rect.height <= 24)?.element;
    if (!translateElement || !resizeElement) throw new Error('第 9 页缺少安全位移/缩放目标');
    const originalText = setTextElement.textContent;
    const resizeStyle = getComputedStyle(resizeElement);
    const width = Number.parseFloat(resizeStyle.width);
    const height = Number.parseFloat(resizeStyle.height);
    if (![width, height].every(Number.isFinite) || width <= 5 || height <= 0) {
      throw new Error('第 9 页缩放目标尺寸无效');
    }
    return {
      setText:{
        target:runtime.makeLocator(setTextElement),
        payload:{ text:`试点·${originalText}` },
      },
      translate:{
        target:runtime.makeLocator(translateElement),
        payload:{ x:10, y:0 },
      },
      resize:{
        target:runtime.makeLocator(resizeElement),
        payload:{ width:Math.max(1, Math.round(width - 4)), height:Math.max(1, Math.round(height)) },
      },
    };
  });
}

export async function applyPilotActions(app, page, task) {
  const navigation = page.locator('[data-page-index="9"]');
  const pageKey = await navigation.getAttribute('data-page-key');
  if (!pageKey) throw new Error('第 9 页缺少 pageKey');
  if (!task?.id || task.pageKey !== pageKey) {
    throw new Error('试点动作必须关联第 9 页真实任务');
  }
  await navigation.click();
  await waitForPilotPage(page, pageKey);
  const specs = await choosePilotActionTargets(page);
  const kinds = ['setText', 'translate', 'resize'];
  const state = await pilotSession(app);
  const result = await pilotPost(app, '/api/actions', {
    expectedRevision:state.revision,
    taskId:task.id,
    actions:kinds.map(kind => ({
        id:`renzhi-pilot-${kind}`,
        taskId:task.id,
        target:specs[kind].target,
        kind,
        payload:specs[kind].payload,
        expectedRevision:state.revision,
      })),
  });
  const persisted = await waitForPilotSession(
    app,
    next => next.revision === state.revision + 1
      && next.groups.length === state.groups.length + 1
      && next.tasks.find(candidate => candidate.id === task.id)?.status === 'completed',
    '等待三类试点动作与任务生命周期持久化超时',
  );
  const group = persisted.groups.at(-1);
  if (group.id !== result.groupId
    || group.taskId !== task.id
    || group.actions.length !== kinds.length
    || group.actions.some((action, index) => action.kind !== kinds[index])) {
    throw new Error(`三类动作 canonical 不一致：${JSON.stringify({ result, group })}`);
  }
  const completedTask = persisted.tasks.find(candidate => candidate.id === task.id);
  if (completedTask.groupId !== group.id) throw new Error('试点任务未原子关联动作组');
  const groups = group.actions.map((action, index) => ({
    kind:kinds[index], groupId:group.id, action,
  }));

  const afterActions = await pilotSession(app);
  const undone = await pilotPost(app, `/api/groups/${encodeURIComponent(group.id)}/undo`, {
    expectedRevision:afterActions.revision,
  });
  const afterUndo = await waitForPilotSession(
    app,
    state => state.revision === afterActions.revision + 1
      && state.groups.find(candidate => candidate.id === group.id)?.active === false
      && state.tasks.find(candidate => candidate.id === task.id)?.status === 'completed'
      && state.tasks.find(candidate => candidate.id === task.id)?.groupId === group.id
      && state.tasks.find(candidate => candidate.id === task.id)?.effectState === 'undone',
    '等待试点 undo 持久化超时',
  );
  const redone = await pilotPost(app, `/api/groups/${encodeURIComponent(group.id)}/redo`, {
    expectedRevision:afterUndo.revision,
  });
  await waitForPilotSession(
    app,
    state => state.revision === afterUndo.revision + 1
      && state.groups.find(candidate => candidate.id === group.id)?.active === true
      && state.tasks.find(candidate => candidate.id === task.id)?.status === 'completed'
      && state.tasks.find(candidate => candidate.id === task.id)?.groupId === group.id
      && state.tasks.find(candidate => candidate.id === task.id)?.effectState === 'active',
    '等待试点 redo 持久化超时',
  );
  if (undone.groupId !== group.id || redone.groupId !== group.id) {
    throw new Error(`undo/redo groupId 不一致：${JSON.stringify({ undone, redone })}`);
  }

  const byKind = Object.fromEntries(groups.map(group => [group.kind, {
    target:group.action.target,
    before:group.action.before,
    after:group.action.after,
  }]));
  return { groups, ...byKind };
}
