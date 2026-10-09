import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { loadChromium } from '../../verify/load-playwright.mjs';
import { startAppServer } from '../app-server.mjs';
import { WorkCatalog } from '../work-catalog.mjs';
import { DeckCreationWorkspace } from '../deck-creation-workspace.mjs';
import { startServer } from '../server.mjs';

const execFileAsync = promisify(execFile);
const PYTHON_EXECUTABLE = process.env.PYTHON
  ?? (process.platform === 'win32' ? 'python.exe' : 'python3');

async function replaceBundleText(deckPath, before, after) {
  const program = [
    'import importlib.util, sys',
    'spec = importlib.util.spec_from_file_location("eb", sys.argv[1])',
    'eb = importlib.util.module_from_spec(spec); spec.loader.exec_module(eb)',
    'lines = eb.load(sys.argv[2])',
    'template = eb.get_template(lines)',
    'assert template.count(sys.argv[3]) == 1',
    'template = template.replace(sys.argv[3], sys.argv[4])',
    'eb.set_template(lines, template)',
    'eb.save(sys.argv[2], lines)',
    'eb.verify(sys.argv[2])',
  ].join('; ');
  await execFileAsync(PYTHON_EXECUTABLE, [
    '-c', program, resolve('scripts/edit-bundle.py'), deckPath, before, after,
  ]);
}

function creationCommand(app, body) {
  return fetch(`${app.url}/api/creation-draft/commands?token=${encodeURIComponent(app.token)}`, {
    method:'POST',
    headers:{ origin:app.url, 'content-type':'application/json' },
    body:JSON.stringify(body),
  }).then(async response => {
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify({ status:response.status, ...result }));
    return result;
  });
}

class CreationTerminalFixture {
  constructor(options) {
    this.options = options;
    this.runtimeId = 'creation-terminal-layout';
    this.state = 'stopped';
    this.interactionRequired = null;
    this.resizes = [];
    this.sockets = new Set();
    this.firstResize = new Promise(resolve => { this.resolveFirstResize = resolve; });
  }

  snapshot() {
    return {
      runtimeId:this.runtimeId,
      provider:this.options.provider,
      projectRoot:this.options.projectRoot,
      state:this.state,
      interactionRequired:this.interactionRequired,
    };
  }

  async start() { this.state = 'running'; }
  input() {}
  resize(cols, rows) {
    this.resizes.push([cols, rows]);
    this.resolveFirstResize?.([cols, rows]);
    this.resolveFirstResize = null;
  }
  async restart() { this.state = 'running'; }
  async close() { this.state = 'closed'; }

  emitInteractionRequired() {
    this.interactionRequired = {
      kind:'directory-trust',
      message:'请在右侧终端确认是否信任当前项目目录',
    };
    const terminal = this.snapshot();
    for (const socket of this.sockets) {
      socket.send(JSON.stringify({ type:'state', terminal }));
    }
    this.options.onStateChange?.(terminal);
  }

  attach(socket) {
    this.sockets.add(socket);
    const output = `${Array.from({ length:90 }, (_, index) => `终端输出 ${index + 1}`).join('\r\n')}\r\n❯ `;
    socket.send(JSON.stringify({ type:'snapshot', terminal:this.snapshot(), output }));
    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.type === 'resize' || message.type === 'start') {
        this.resize(message.cols, message.rows);
      }
    });
    return () => this.sockets.delete(socket);
  }
}

test('启动状态恢复完成前入口不可点击，完成后选择的流程不会被迟到响应覆盖', async t => {
  const app = await startAppServer({ token:'browser-bootstrap-race-secret' });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let reached;
  const restoring = new Promise(resolve => { reached = resolve; });
  await page.route('**/api/creation-draft?*', async route => {
    reached();
    await pending;
    await route.continue();
  });
  t.after(() => release());
  await page.goto(app.appUrl);
  await restoring;
  assert.equal(await page.locator('[data-new-deck]').isDisabled(), true);
  assert.equal(await page.locator('[data-existing-deck]').isDisabled(), true);
  release();
  await page.locator('[data-existing-deck]').click();
  await page.locator('[data-add-deck]').waitFor({ state:'visible', timeout:2_000 });
  assert.equal(await page.locator('[data-landing]').isHidden(), true);
});

test('DSH 窄工作台的起始页顶栏保持图标顺序与悬浮说明', async t => {
  const app = await startAppServer({ token:'dsh-start-toolbar-secret' });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:600, height:800 } });
  const url = new URL(app.appUrl);
  url.searchParams.set('embedded', 'dsh');
  url.searchParams.set('parentOrigin', app.url);

  await page.goto(url.href);
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  assert.equal(await page.locator('html').getAttribute('data-embedded'), 'dsh');
  assert.equal(await page.locator('html').getAttribute('data-runtime-profile'), 'dsh-product');
  assert.equal(await page.locator('.dev-shell-badge').isHidden(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 600);
  assert.deepEqual(
    await page.locator('[data-support-navigation] button, [data-exit-editor]')
      .evaluateAll(buttons => buttons.filter(button => button.offsetParent !== null).map(button => {
        const label = button.querySelector('.topbar-control-label');
        return {
          key:button.dataset.supportOpen ?? 'exit',
          width:button.getBoundingClientRect().width,
          labelDisplay:label ? getComputedStyle(label).display : 'none',
          hasIcon:Boolean(button.querySelector('.topbar-control-icon')),
        };
      })),
    [
      { key:'onboarding', width:36, labelDisplay:'none', hasIcon:true },
      { key:'help', width:36, labelDisplay:'none', hasIcon:true },
      { key:'diagnostics', width:36, labelDisplay:'none', hasIcon:true },
      { key:'exit', width:36, labelDisplay:'none', hasIcon:true },
    ],
  );
  assert.equal(
    await page.locator('[data-exit-editor]').getAttribute('aria-label'),
    '关闭 AICO-PPT 工作台',
  );
  await page.locator('[data-support-open="diagnostics"]').hover();
  await page.waitForFunction(() => (
    document.querySelector('[data-topbar-tooltip]')?.dataset.visible === 'true'
  ));
  assert.equal(await page.locator('[data-topbar-tooltip]').textContent(), '安装与诊断');
});

test('DSH 新建 Deck 任务把会话选择器放在与修改任务一致的顶栏位置', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-creation-dsh-session-control-'));
  const history = { creation:[], editing:[] };
  const workHistoryStore = {
    filePath:join(projectRoot, 'legacy-history.json'),
    async list() { return structuredClone({ version:1, ...history }); },
    async recordCreation({ projectRoot:root, draftId, provider }) {
      const entry = {
        kind:'creation', projectRoot:root, draftId, provider,
        title:'未命名 Deck', projectName:'测试项目', phase:'brief', progress:'需求沟通中',
      };
      history.creation = [entry];
      return entry;
    },
    async resolveCreation({ projectRoot:root, draftId }) {
      return history.creation.find(entry => entry.projectRoot === root && entry.draftId === draftId)
        ?? null;
    },
  };
  const workCatalog = new WorkCatalog({
    filePath:join(projectRoot, 'work-catalog.json'),
    legacyHistory:workHistoryStore,
  });
  const app = await startAppServer({
    token:'creation-dsh-session-control-secret',
    embeddedMode:'dsh',
    pickAgentProjectDirectory:async () => projectRoot,
    workHistoryStore,
    workCatalog,
  });
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(async () => {
    await browser.close();
    await app.close();
    await rm(projectRoot, { recursive:true, force:true });
  });
  const page = await browser.newPage({ viewport:{ width:900, height:800 } });
  await page.addInitScript(root => {
    const sessions = new Map();
    const archivedSessions = new Set();
    let currentSessionId = null;
    window.archiveDshSession = sessionId => {
      archivedSessions.add(sessionId);
      window.postMessage({
        type:'aico-ppt:dsh-session-changed',
        session:sessions.get(currentSessionId) ?? null,
      }, location.origin);
    };
    window.addEventListener('message', event => {
      if (event.data?.type === 'aico-ppt:dsh-work-context') {
        window.currentAicoPptWorkContext = event.data.context;
        return;
      }
      if (event.data?.type !== 'aico-ppt:dsh-request') return;
      const { requestId, command, payload } = event.data;
      let result;
      if (command === 'ensure-workspace') {
        result = { workspaceId:'workspace-creation', path:root, title:'测试项目' };
      } else if (command === 'create-session') {
        const session = {
          sessionId:payload.sessionId,
          title:payload.title,
          cwd:root,
          running:false,
        };
        sessions.set(payload.sessionId, session);
        result = session;
      } else if (command === 'describe-sessions') {
        // DSH 可能在中文标题尚未持久时把 sessionId 当作临时标题返回。
        // 任务页不能被这个占位值反向覆盖。
        result = payload.sessionIds.map(sessionId => (
          sessions.has(sessionId)
            ? { sessionId, title:sessionId, archived:archivedSessions.has(sessionId) }
            : null
        ));
      } else if (command === 'open-session') {
        currentSessionId = payload.sessionId;
        result = sessions.get(payload.sessionId) ?? { sessionId:payload.sessionId };
        queueMicrotask(() => window.postMessage({
          type:'aico-ppt:dsh-session-changed', session:result,
        }, location.origin));
      } else if (command === 'send-to-session') {
        result = { accepted:true, sessionId:payload.sessionId };
      } else {
        result = null;
      }
      window.postMessage({
        type:'aico-ppt:dsh-result', requestId, ok:true, result,
      }, location.origin);
    });
  }, projectRoot);
  const url = new URL(app.appUrl);
  url.searchParams.set('parentOrigin', app.url);
  await page.goto(url.href);
  await page.getByRole('button', { name:/从0开始创建一个新的deck，新任务/ }).click();
  await page.getByRole('button', { name:/选择项目目录/ }).click();
  const confirmation = page.locator('[data-confirm-creation-project]');
  if (await confirmation.isVisible()) await confirmation.check();
  await page.getByRole('button', { name:/创建 Draft 并开始对话/ }).click();
  const control = page.locator('[data-dsh-task-session]');
  await control.waitFor({ state:'visible' });
  await page.waitForFunction(() => (
    document.querySelector('[data-dsh-task-session-label]')?.value.startsWith('session-')
  ));
  assert.equal(await control.evaluate(node => node.parentElement?.classList.contains('topbar-actions')), true,
    'Creation 会话控件必须位于顶栏，不能留在左侧里程碑栏');
  assert.equal(await page.locator('.milestone-rail [data-dsh-task-session]').count(), 0);
  const select = control.getByRole('combobox');
  const initialSessionId = await select.inputValue();
  assert.match(initialSessionId, /^session-/u);
  assert.match(await select.locator('option:checked').textContent(), /创建 Deck：/u);
  assert.deepEqual(await control.evaluate(node => {
    const style = getComputedStyle(node);
    return { height:style.height, borderRadius:style.borderRadius };
  }), { height:'38px', borderRadius:'999px' });
  await page.waitForFunction(() => Boolean(window.currentAicoPptWorkContext?.contextKey));
  await page.evaluate(() => window.postMessage({
    type:'aico-ppt:create-work-session-request',
    requestId:'left-new-session-entry',
    workId:window.currentAicoPptWorkContext.workId,
    contextKey:window.currentAicoPptWorkContext.contextKey,
  }, location.origin));
  await page.waitForFunction(() => (
    document.querySelectorAll('[data-dsh-task-session-label] option').length === 2
  ));
  assert.match(await select.locator('option:checked').textContent(), /会话 2/u);
  const archivedSessionId = await select.inputValue();
  await select.selectOption(initialSessionId);
  await page.waitForFunction(sessionId => (
    document.querySelector('[data-dsh-task-session-label]')?.value === sessionId
    && document.querySelector('[data-dsh-task-session]')?.dataset.state === 'active'
  ), initialSessionId);
  await page.evaluate(sessionId => window.archiveDshSession(sessionId), archivedSessionId);
  await page.waitForTimeout(100);
  assert.equal(
    await select.locator('option').count(),
    1,
    '归档的 DSH 会话必须从右侧 Deck 任务会话选择器消失',
  );
  let persisted;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    persisted = (await workCatalog.list()).creation[0];
    if (persisted?.dshBinding.sessions.some(link => (
      link.sessionId === archivedSessionId && link.state === 'archived'
    ))) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(
    persisted.dshBinding.sessions.find(link => link.sessionId === archivedSessionId)?.state,
    'archived',
    '归档状态必须写回 WorkCatalog，刷新后不能重新出现',
  );
});

test('用户在网页点击添加后才打开选择器，取消后仍可重试', async t => {
  let picks = 0;
  const app = await startAppServer({
    token:'browser-secret',
    pickDeck:async () => {
      picks += 1;
      await new Promise(resolve => setTimeout(resolve, 80));
      return null;
    },
  });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.goto(app.appUrl);
  await page.waitForFunction(() => (
    document.querySelector('[data-liquid-ether-background]')?.dataset.state === 'running'
  ));
  const liquidBackground = page.locator('[data-liquid-ether-background]');
  assert.equal(await liquidBackground.getAttribute('data-palette'), 'huawei-red');
  assert.equal(await liquidBackground.getAttribute('data-palette-samples'), '256');
  assert.equal(await liquidBackground.getAttribute('data-continuity'), 'interpolated');
  assert.equal(await liquidBackground.locator('canvas').count(), 1);
  assert.equal(
    await liquidBackground.evaluate(node => getComputedStyle(node).pointerEvents),
    'none',
    '流体层不能拦截启动页操作',
  );
  await page.mouse.move(180, 160);
  await page.mouse.move(720, 520, { steps:8 });
  await page.waitForFunction(() => (
    Number(document.querySelector('[data-liquid-ether-background]')?.dataset.maxPointerSplats) >= 2
  ));
  const entryStyles = await page.evaluate(() => {
    const snapshot = selector => {
      const style = getComputedStyle(document.querySelector(selector));
      return {
        backgroundColor:style.backgroundColor,
        backdropFilter:style.backdropFilter || style.webkitBackdropFilter,
        color:style.color,
        borderColor:style.borderColor,
        boxShadow:style.boxShadow,
      };
    };
    return {
      creationCard:snapshot('.work-card:first-child'),
      editingCard:snapshot('.work-card:last-child'),
      newDeck:snapshot('[data-new-deck]'),
      existing:snapshot('[data-existing-deck]'),
    };
  });
  assert.deepEqual(entryStyles.creationCard, entryStyles.editingCard, '两个工作区应使用同一套玻璃卡片样式');
  assert.equal(entryStyles.creationCard.backgroundColor, 'rgba(255, 255, 255, 0.88)');
  assert.match(entryStyles.creationCard.backdropFilter, /blur\(24px\)/);
  assert.deepEqual(entryStyles.newDeck, entryStyles.existing, '两个右下角新任务入口样式应对齐');
  assert.equal(picks, 0);
  await page.getByRole('button', { name:/修改已经写好的deck，新任务/ }).click();
  await page.getByRole('button', { name:/添加 Deck HTML/ }).click();
  await page.getByText('已取消，可以重新添加').waitFor();
  assert.equal(picks, 1);
  assert.equal(await page.getByRole('button', { name:/添加 Deck HTML/ }).isEnabled(), true);
});

test('启动页流体背景遵守减少动态效果，并在启动页隐藏时暂停', async t => {
  const app = await startAppServer({ token:'browser-liquid-background-secret' });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());

  const page = await browser.newPage({ viewport:{ width:1280, height:800 } });
  await page.goto(app.appUrl);
  await page.waitForFunction(() => (
    document.querySelector('[data-liquid-ether-background]')?.dataset.state === 'running'
  ));
  await page.locator('[data-start-shell]').evaluate(node => { node.hidden = true; });
  await page.waitForFunction(() => (
    document.querySelector('[data-liquid-ether-background]')?.dataset.state === 'paused'
  ));

  const reducedPage = await browser.newPage({ viewport:{ width:1280, height:800 } });
  await reducedPage.emulateMedia({ reducedMotion:'reduce' });
  await reducedPage.goto(app.appUrl);
  const reducedBackground = reducedPage.locator('[data-liquid-ether-background]');
  await reducedPage.waitForFunction(() => (
    document.querySelector('[data-liquid-ether-background]')?.dataset.state === 'reduced'
  ));
  assert.equal(await reducedBackground.getAttribute('data-state'), 'reduced');
  assert.equal(await reducedBackground.locator('canvas').count(), 0);
});

test('不支持 OffscreenCanvas 时保留主线程兼容动效', async t => {
  const app = await startAppServer({ token:'browser-liquid-fallback-secret' });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1280, height:800 } });
  await page.addInitScript(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
      configurable:true,
      value:undefined,
    });
  });
  await page.goto(app.appUrl);
  await page.waitForFunction(() => (
    document.querySelector('[data-liquid-ether-background]')?.dataset.state === 'running'
  ));
  const background = page.locator('[data-liquid-ether-background]');
  assert.equal(await background.getAttribute('data-renderer'), 'main-thread');
  assert.equal(await background.locator('canvas').count(), 1);
});

test('启动页流体背景保留动效且不以超长任务阻塞首次交互', async t => {
  const app = await startAppServer({ token:'browser-liquid-performance-secret' });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });

  await page.addInitScript(() => {
    window.__huaweiDeckLongTasks = [];
    new PerformanceObserver(entries => {
      for (const entry of entries.getEntries()) {
        window.__huaweiDeckLongTasks.push(entry.duration);
      }
    }).observe({ type:'longtask', buffered:true });
  });
  await page.goto(app.appUrl);
  await page.waitForFunction(() => (
    document.querySelector('[data-liquid-ether-background]')?.dataset.state === 'running'
  ));
  await page.mouse.move(240, 180);
  await page.mouse.move(1480, 820, { steps:16 });
  await page.waitForTimeout(120);

  const snapshot = await page.evaluate(() => ({
    canvasCount:document.querySelectorAll('[data-liquid-ether-background] canvas').length,
    renderer:document.querySelector('[data-liquid-ether-background]')?.dataset.renderer,
    longestTask:Math.max(0, ...window.__huaweiDeckLongTasks),
    longTasks:window.__huaweiDeckLongTasks,
  }));
  assert.equal(snapshot.canvasCount, 1, '性能优化后仍必须保留流体背景 canvas');
  assert.equal(snapshot.renderer, 'worker', '支持 OffscreenCanvas 时应在 Worker 中渲染流体背景');
  assert.ok(
    snapshot.longestTask < 220,
    `启动页首次交互出现 ${snapshot.longestTask.toFixed(1)}ms 长任务：${JSON.stringify(snapshot.longTasks)}`,
  );
});

test('Windows 可见 Chrome 的流体动效不拖慢页面合成帧', {
  skip:process.platform !== 'win32' || process.env.AICO_PPT_HEADED_PERF !== '1',
}, async t => {
  const app = await startAppServer({ token:'browser-liquid-headed-performance-secret' });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:false });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport:{ width:1920, height:1080 },
    deviceScaleFactor:1.5,
  });

  await page.goto(app.appUrl);
  await page.waitForFunction(() => (
    document.querySelector('[data-liquid-ether-background]')?.dataset.state === 'running'
  ));
  await page.mouse.move(180, 160);
  await page.mouse.move(1540, 860, { steps:24 });
  const intervals = await page.evaluate(() => new Promise(resolve => {
    const values = [];
    let previous = performance.now();
    const sample = now => {
      values.push(now - previous);
      previous = now;
      if (values.length === 180) resolve(values);
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));
  const snapshot = await page.evaluate(values => {
    const sorted = values.toSorted((left, right) => left - right);
    const background = document.querySelector('[data-liquid-ether-background]');
    return {
      renderer:background?.dataset.renderer,
      qualityProfile:background?.dataset.qualityProfile,
      frameP95:sorted[Math.floor(sorted.length * 0.95)],
      frameMax:sorted.at(-1),
    };
  }, intervals);
  assert.equal(snapshot.renderer, 'worker');
  assert.equal(snapshot.qualityProfile, 'windows-balanced');
  assert.ok(
    snapshot.frameP95 < 25,
    `Windows 可见 Chrome 流体背景帧间隔过高：${JSON.stringify(snapshot)}`,
  );
});

test('新建与修改入口的返回和主按钮使用 PillNav 悬停效果', async t => {
  const app = await startAppServer({ token:'browser-pill-action-secret' });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1440, height:900 } });

  const hoverSnapshot = async selector => {
    const button = page.locator(selector);
    assert.equal(await button.locator('.pill-nav-fill').count(), 1);
    assert.equal(await button.locator('.pill-nav-label-default').count(), 1);
    assert.equal(await button.locator('.pill-nav-label-hover').count(), 1);
    await button.hover();
    await page.waitForTimeout(420);
    return button.evaluate(node => {
      const fill = getComputedStyle(node.querySelector('.pill-nav-fill'));
      const hoverLabel = getComputedStyle(node.querySelector('.pill-nav-label-hover'));
      return {
        transform:fill.transform,
        fillColor:fill.backgroundColor,
        hoverColor:hoverLabel.color,
        hoverOpacity:hoverLabel.opacity,
      };
    });
  };

  await page.goto(app.appUrl);
  await page.getByRole('button', { name:/从0开始创建一个新的deck，新任务/ }).click();
  const creationPrimary = await hoverSnapshot('[data-choose-creation-project]');
  assert.notEqual(creationPrimary.transform, 'none');
  assert.equal(creationPrimary.fillColor, 'rgb(255, 255, 255)');
  assert.equal(creationPrimary.hoverColor, 'rgb(199, 0, 11)');
  assert.equal(creationPrimary.hoverOpacity, '1');
  const creationBack = await hoverSnapshot('[data-creation-back]');
  assert.equal(creationBack.fillColor, 'rgb(199, 0, 11)');
  assert.equal(creationBack.hoverColor, 'rgb(255, 255, 255)');
  await page.getByRole('button', { name:'返回' }).click();

  await page.getByRole('button', { name:/修改已经写好的deck，新任务/ }).click();
  const editingPrimary = await hoverSnapshot('[data-add-deck]');
  assert.equal(editingPrimary.fillColor, 'rgb(255, 255, 255)');
  assert.deepEqual(
    await page.locator('[data-button-label]').allTextContents(),
    ['添加 Deck HTML'],
    '动态文案只保留一个可更新的数据源',
  );
  assert.equal(
    await page.locator('[data-add-deck] .pill-nav-label-default').innerText(),
    await page.locator('[data-add-deck] .pill-nav-label-hover').innerText(),
    '共享组件应自动同步默认与悬停标签',
  );
  const editingBack = await hoverSnapshot('[data-back-home]');
  assert.equal(editingBack.fillColor, 'rgb(199, 0, 11)');
});

test('默认启动使用系统文件选择器和自定义 Agent 下拉框', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-native-controls-e2e-'));
  const deckPath = join(root, 'native-picker-deck.html');
  await copyFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'), deckPath);
  const deckSelections = [null, deckPath];
  const app = await startAppServer({
    token:'browser-native-controls-secret',
    pickDeck:async () => deckSelections.shift() ?? null,
    pickAgentProjectDirectory:async () => root,
  });
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(async () => {
    await browser.close();
    await app.close();
    await rm(root, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  });
  const page = await browser.newPage({ viewport:{ width:1440, height:900 } });

  await page.goto(app.appUrl);
  assert.equal(await page.locator('html').getAttribute('data-file-picker-mode'), 'system');
  assert.equal(await page.locator('[data-local-file-picker]').count(), 0);
  await page.getByRole('button', { name:/修改已经写好的deck，新任务/ }).click();
  await page.getByRole('button', { name:/添加 Deck HTML/ }).click();
  await page.getByText('已取消，可以重新添加').waitFor();
  await page.getByRole('button', { name:/添加 Deck HTML/ }).click();
  await page.locator('[data-confirmation]').waitFor({ state:'visible' });

  const providerControl = page.getByRole('combobox', { name:'默认 Agent' });
  await providerControl.focus();
  await providerControl.press('ArrowDown');
  assert.equal(await providerControl.getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await providerControl.getAttribute('aria-expanded'), 'false');
  await providerControl.click();
  await page.getByRole('option', { name:'Claude Code' }).click();
  assert.equal(await page.locator('[data-provider]').inputValue(), 'claude-code');
  assert.equal(await page.locator('select:visible').count(), 0);

  await page.getByRole('button', { name:/返回/ }).click();
  await page.getByRole('button', { name:/从0开始创建一个新的deck，新任务/ }).click();
  await page.getByRole('button', { name:/选择项目目录/ }).click();
  await page.locator('[data-creation-confirmation]').waitFor({ state:'visible' });
  assert.equal(await page.getByRole('combobox', { name:'对话 Agent' }).isVisible(), true);
});

test('启动页刷新后仍连接同一个服务和同一份页面状态', async t => {
  const app = await startAppServer({
    token:'browser-refresh-secret',
    launcherClientCloseGraceMs:120,
    pickDeck:async () => '/tmp/refresh-deck.html',
    resolveAgentProject:async () => ({
      path:'/tmp/refresh-project', source:'git-root', needsConfirmation:false, warning:null,
      identity:{ originalPath:'/tmp/refresh-project', realPath:'/tmp/refresh-project', dev:'1', ino:'2' },
    }),
  });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.goto(app.appUrl);
  await page.getByRole('button', { name:/修改已经写好的deck，新任务/ }).click();
  await page.getByRole('button', { name:/添加 Deck HTML/ }).click();
  await page.getByText('refresh-deck.html').waitFor();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await page.waitForTimeout(30);
  await page.reload();
  await page.getByText('refresh-deck.html').waitFor();
  assert.equal(await page.locator('[data-confirmation]').isVisible(), true);
  await page.waitForTimeout(140);
  assert.equal((await fetch(app.appUrl)).status, 200, '刷新宽限期结束后服务仍应可用');
});

test('两个入口选过路径后都能返回首页并切换流程', async t => {
  const app = await startAppServer({
    token:'browser-flow-reset-secret',
    pickDeck:async () => '/tmp/reset-existing.html',
    resolveAgentProject:async () => ({
      path:'/tmp/existing-project', source:'git-root', needsConfirmation:false, warning:null,
      identity:{ originalPath:'/tmp/existing-project', realPath:'/tmp/existing-project', dev:'1', ino:'2' },
    }),
    pickAgentProjectDirectory:async () => '/tmp/creation-project',
    resolveCreationProject:async () => ({
      path:'/tmp/creation-project', source:'user-selected', needsConfirmation:false, warning:null,
      identity:{ originalPath:'/tmp/creation-project', realPath:'/tmp/creation-project', dev:'1', ino:'3' },
    }),
  });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const assertCompactAgentPicker = async label => {
    const select = page.locator(label === '默认 Agent'
      ? '[data-provider]' : '[data-creation-provider]');
    const snapshot = await select.evaluate(node => {
      const picker = node.closest('.agent-picker');
      const pickerStyle = getComputedStyle(picker);
      return {
        tagName:node.tagName,
        optionCount:node.options.length,
        hasCustomControl:Boolean(node.closest('.ui-select')),
        sourceDisplay:getComputedStyle(node).display,
        width:picker.getBoundingClientRect().width,
        height:picker.getBoundingClientRect().height,
        borderRadius:pickerStyle.borderRadius,
      };
    });
    assert.equal(snapshot.tagName, 'SELECT');
    assert.equal(snapshot.optionCount, 3);
    assert.equal(snapshot.hasCustomControl, true);
    assert.equal(snapshot.sourceDisplay, 'none');
    assert.ok(snapshot.width < 300, JSON.stringify(snapshot));
    assert.ok(snapshot.height <= 44, JSON.stringify(snapshot));
    assert.ok(Number.parseFloat(snapshot.borderRadius) >= 20, JSON.stringify(snapshot));
  };

  await page.goto(app.appUrl);
  await page.getByRole('button', { name:/修改已经写好的deck，新任务/ }).click();
  await page.getByRole('button', { name:/添加 Deck HTML/ }).click();
  await page.getByText('/tmp/existing-project').waitFor();
  await assertCompactAgentPicker('默认 Agent');
  await page.getByRole('button', { name:/返回/ }).click();
  await page.locator('[data-landing]').waitFor({ state:'visible' });
  assert.equal(await page.locator('[data-landing]').isVisible(), true, '选过 Deck 后应可返回首页');

  await page.getByRole('button', { name:/从0开始创建一个新的deck，新任务/ }).click();
  await page.getByRole('button', { name:/选择项目目录/ }).click();
  await page.getByText('/tmp/creation-project').waitFor();
  await assertCompactAgentPicker('对话 Agent');
  await page.getByRole('button', { name:/返回/ }).click();
  await page.locator('[data-landing]').waitFor({ state:'visible' });
  assert.equal(await page.locator('[data-landing]').isVisible(), true, '选过项目目录后应可返回首页');

  await page.getByRole('button', { name:/修改已经写好的deck，新任务/ }).click();
  assert.equal(await page.locator('[data-existing-flow]').isVisible(), true, '返回后应可重新进入另一条流程');
});

test('修改 Deck 从当前项目目录打开选择器，取消后可继续多次更改', async t => {
  const selectedPaths = [null, '/tmp/existing-project-b', '/tmp/existing-project-c'];
  const initialDirectories = [];
  const app = await startAppServer({
    token:'browser-project-reselect-secret',
    pickDeck:async () => '/tmp/reselect-existing.html',
    resolveAgentProject:async ({ explicitRoot }) => ({
      path:explicitRoot ?? '/tmp/existing-project-a',
      source:explicitRoot ? 'explicit' : 'git-root',
      needsConfirmation:false,
      warning:null,
      identity:{
        originalPath:explicitRoot ?? '/tmp/existing-project-a',
        realPath:explicitRoot ?? '/tmp/existing-project-a',
        dev:'1',
        ino:'2',
      },
    }),
    pickAgentProjectDirectory:async ({ defaultPath }) => {
      initialDirectories.push(defaultPath);
      return selectedPaths.shift() ?? null;
    },
  });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.goto(app.appUrl);
  await page.getByRole('button', { name:/修改已经写好的deck，新任务/ }).click();
  await page.getByRole('button', { name:/添加 Deck HTML/ }).click();
  await page.getByText('/tmp/existing-project-a').waitFor();

  await page.getByRole('button', { name:'更改目录' }).click();
  await page.getByText('已取消更改，仍使用当前项目目录').waitFor();
  assert.equal(await page.locator('[data-project-root]').textContent(), '/tmp/existing-project-a');

  await page.getByRole('button', { name:'更改目录' }).click();
  await page.getByText('/tmp/existing-project-b').waitFor();
  await page.getByRole('button', { name:'更改目录' }).click();
  await page.getByText('/tmp/existing-project-c').waitFor();
  assert.deepEqual(initialDirectories, ['/tmp/existing-project-a', '/tmp/existing-project-a', '/tmp/existing-project-b']);
});

test('嵌套 Git 仓库中的 HTML 在确认页默认显示自己的直接父目录', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deck-directory-default-')));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckDirectory = join(root, '材料', '中文 文稿');
  await mkdir(join(root, '.git'));
  await mkdir(deckDirectory, { recursive:true });
  await writeFile(join(root, 'package.json'), '{}');
  const deckPath = join(deckDirectory, '汇报.html');
  await writeFile(deckPath, '<!doctype html><title>汇报</title>');
  const app = await startAppServer({ token:'deck-directory-default-secret', pickDeck:async () => deckPath });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(app.appUrl);
  await page.getByRole('button', { name:/修改已经写好的deck，新任务/ }).click();
  await page.getByRole('button', { name:/添加 Deck HTML/ }).click();
  await page.getByText(deckDirectory, { exact:true }).waitFor();
  assert.equal(await page.locator('[data-project-root]').textContent(), deckDirectory);
  assert.equal(await page.locator('[data-project-source]').textContent(), 'Deck 所在目录');
});

test('修改 Deck 流程选中文件后仍可重新选择另一份 Deck', async t => {
  const decks = ['/tmp/first-deck.html', '/tmp/second-deck.html'];
  const app = await startAppServer({
    token:'browser-deck-reselect-secret',
    pickDeck:async () => decks.shift() ?? null,
    resolveAgentProject:async ({ deckPath }) => ({
      path:'/tmp/project', source:'git-root', needsConfirmation:false, warning:null,
      identity:{ originalPath:'/tmp/project', realPath:'/tmp/project', dev:'1', ino:'2' },
      deckPath,
    }),
  });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.goto(app.appUrl);
  await page.getByRole('button', { name:/修改已经写好的deck，新任务/ }).click();
  await page.getByRole('button', { name:/添加 Deck HTML/ }).click();
  await page.getByText('first-deck.html').waitFor();
  await page.getByRole('button', { name:'重新选择 Deck' }).click();
  await page.getByText('second-deck.html').waitFor();
  assert.equal(await page.locator('[data-deck-name]').textContent(), 'second-deck.html');
});

test('新建 Deck 项目目录取消后可重试，选中后也可取消和多次更改', async t => {
  const selectedPaths = [null, '/tmp/creation-project-a', null, '/tmp/creation-project-b'];
  const initialDirectories = [];
  const app = await startAppServer({
    token:'browser-creation-project-reselect-secret',
    pickAgentProjectDirectory:async ({ defaultPath }) => {
      initialDirectories.push(defaultPath);
      return selectedPaths.shift() ?? null;
    },
    resolveCreationProject:async ({ selectedPath }) => ({
      path:selectedPath,
      source:'user-selected',
      needsConfirmation:false,
      warning:null,
      identity:{ originalPath:selectedPath, realPath:selectedPath, dev:'1', ino:'3' },
    }),
  });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.goto(app.appUrl);
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  const supportNavigation = page.locator('.support-navigation');
  assert.equal(await supportNavigation.isVisible(), true, '使用与支持只在初始页显示');
  await page.getByRole('button', { name:/从0开始创建一个新的deck，新任务/ }).click();
  assert.equal(await supportNavigation.isHidden(), true, '进入新建 Deck 流程后应隐藏使用与支持');
  await page.getByRole('button', { name:/选择项目目录/ }).click();
  await page.getByText('已取消，可以重新选择').waitFor();
  assert.equal(await page.getByRole('button', { name:/选择项目目录/ }).isEnabled(), true);

  await page.getByRole('button', { name:/选择项目目录/ }).click();
  await page.getByText('/tmp/creation-project-a').waitFor();
  await page.getByRole('button', { name:'重新选择' }).click();
  await page.getByText('已取消更改，仍使用当前目录').waitFor();
  assert.equal(await page.locator('[data-creation-project-root]').textContent(), '/tmp/creation-project-a');

  await page.getByRole('button', { name:'重新选择' }).click();
  await page.getByText('/tmp/creation-project-b').waitFor();
  assert.deepEqual(initialDirectories, [undefined, undefined, '/tmp/creation-project-a', '/tmp/creation-project-a']);
});

test('选择 Deck 后先确认项目目录和 provider，点击打开才启动 Editor', async t => {
  let startOptions = null;
  let releaseStarted;
  const started = new Promise(resolve => { releaseStarted = resolve; });
  let app;
  app = await startAppServer({
    token:'browser-confirm-secret',
    pickDeck:async () => '/tmp/renzhi-deck.html',
    resolveAgentProject:async () => ({
      path:'/tmp/aico-ppt', source:'git-root', needsConfirmation:false, warning:null,
      identity:{ originalPath:'/tmp/aico-ppt', realPath:'/tmp/aico-ppt', dev:'1', ino:'2' },
    }),
    assertAgentProject:async project => project.path,
    startEditor:async options => {
      startOptions = options;
      releaseStarted();
      return {
        url:app.url, token:'deck-token', editorToken:'editor-token', close:async () => {},
      };
    },
  });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.goto(app.appUrl);
  await page.getByRole('button', { name:/修改已经写好的deck，新任务/ }).click();
  await page.getByRole('button', { name:/添加 Deck HTML/ }).click();
  await page.getByText('/tmp/aico-ppt').waitFor();
  assert.equal(startOptions, null);
  const providerSelect = page.locator('[data-provider]');
  assert.equal(await providerSelect.locator('option').count(), 3);
  assert.equal(await providerSelect.locator('option[value="opencode"]').count(), 1);
  await page.getByRole('combobox', { name:'默认 Agent' }).click();
  await page.getByRole('option', { name:'Claude Code' }).click();
  await page.getByRole('button', { name:/打开编辑器/ }).click();
  await started;
  assert.equal(startOptions.agentProjectRoot, '/tmp/aico-ppt');
  assert.equal(startOptions.agentProvider, 'claude-code');
});

test('启动页在修改 Deck 卡片中显示历史任务并可一步恢复编辑器', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-recent-launch-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const recentPath = join(root, 'recent-launch.html');
  await writeFile(recentPath, '<!doctype html><title>recent</title>');
  let pickerCalls = 0;
  let startedOptions = null;
  let releaseStarted;
  const started = new Promise(resolve => { releaseStarted = resolve; });
  let app;
  const recentEntry = {
    deckPath:recentPath, deckName:'recent-launch.html', directory:root,
    modifiedAt:'2026-08-10T12:00:00.000Z', lastOpenedAt:'2026-08-10T11:00:00.000Z',
    provider:'codex',
  };
  app = await startAppServer({
    token:'browser-recent-secret',
    pickDeck:async () => { pickerCalls += 1; return null; },
    recentDeckStore:{
      async list() {
        return [recentEntry];
      },
      async resolve(value) { return value === recentPath ? recentPath : null; },
      async record() {},
    },
    workCatalog:new WorkCatalog({
      filePath:null,
      legacyHistory:{
        async list() { return { version:1, creation:[], editing:[recentEntry] }; },
      },
    }),
    resolveAgentProject:async () => ({
      path:root, source:'persisted', needsConfirmation:false, warning:null,
      identity:{ originalPath:root, realPath:root, dev:'1', ino:'2' },
    }),
    assertAgentProject:async project => project.path,
    startEditor:async options => {
      startedOptions = options;
      releaseStarted();
      return {
        url:app.url, token:'deck-token', editorToken:'editor-token', close:async () => {},
      };
    },
  });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.goto(app.appUrl);
  await page.locator('.work-item').filter({ hasText:'recent-launch.html' }).click();
  await started;
  assert.equal(startedOptions.deckPath, await realpath(recentPath));
  assert.equal(startedOptions.agentProjectRoot, root);
  assert.equal(pickerCalls, 0, '最近修改不应再打开系统文件选择器');
});

test('启动页左右卡片分别列出可继续的新建与修改任务，新任务入口位于右下角', async t => {
  const creationEntry = {
    kind:'creation', taskId:'draft-home', draftId:'draft-home',
    projectRoot:'/tmp/deck-project', projectName:'deck-project',
    title:'Agent 原生 Deck', provider:'codex', phase:'outline', progress:'大纲已确认',
    revision:3, updatedAt:'2026-08-11T10:00:00.000Z', locked:false,
  };
  const editingEntry = {
    deckPath:'/tmp/edit-home.html', deckName:'edit-home.html', directory:'/tmp',
    modifiedAt:'2026-08-11T11:00:00.000Z', provider:'claude-code',
    progress:'2 项待处理',
  };
  const app = await startAppServer({
    token:'browser-work-cards-secret',
    workHistoryStore:{
      async list() { return { version:1, creation:[creationEntry], editing:[editingEntry] }; },
    },
  });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1440, height:1000 } });

  await page.goto(app.appUrl);
  await page.getByText('Agent 原生 Deck').waitFor();
  await page.getByText('edit-home.html').waitFor();
  if (process.env.LANDING_GLASS_SCREENSHOT) {
    await page.screenshot({ path:process.env.LANDING_GLASS_SCREENSHOT, fullPage:true });
  }
  assert.equal(await page.getByText('从0开始创建一个新的deck', { exact:true }).count(), 1);
  assert.equal(await page.getByText('修改已经写好的deck', { exact:true }).count(), 1);
  assert.equal(await page.getByText('大纲已确认 · deck-project').count(), 1);
  assert.equal(await page.getByText(/2 项待处理/).count(), 1);
  assert.equal(await page.locator('.recent-decks').count(), 0, '首页不应再有独立最近修改区');
  const layout = await page.evaluate(() => {
    const card = document.querySelector('.work-card:first-child').getBoundingClientRect();
    const add = document.querySelector('[data-new-deck]').getBoundingClientRect();
    const titles = [...document.querySelectorAll('.work-card-header strong')].map(node => ({
      clientWidth:node.clientWidth, scrollWidth:node.scrollWidth,
    }));
    return {
      cardRight:card.right, cardBottom:card.bottom,
      addRight:add.right, addBottom:add.bottom, titles,
    };
  });
  assert.ok(layout.cardRight - layout.addRight < 30, JSON.stringify(layout));
  assert.ok(layout.cardBottom - layout.addBottom < 30, JSON.stringify(layout));
  assert.ok(layout.titles.every(title => title.scrollWidth <= title.clientWidth), JSON.stringify(layout));
  const cardIcons = page.locator('.work-card-icon');
  assert.equal(await cardIcons.count(), 2, '新建与修改卡片应各有一个独立图标');
  const iconStyles = await cardIcons.evaluateAll(icons => icons.map(icon => {
    const glyph = icon.querySelector('.work-card-icon-glyph');
    const iconRect = icon.getBoundingClientRect();
    const glyphRect = glyph.getBoundingClientRect();
    const style = getComputedStyle(glyph);
    return {
      maskImage:style.maskImage || style.webkitMaskImage,
      color:style.backgroundColor,
      centerDeltaX:(glyphRect.left + glyphRect.width / 2) - (iconRect.left + iconRect.width / 2),
      centerDeltaY:(glyphRect.top + glyphRect.height / 2) - (iconRect.top + iconRect.height / 2),
    };
  }));
  assert.match(iconStyles[0].maskImage, /create-deck-icon\.png/, '新建 Deck 应使用第 3 张图抠出的符号');
  assert.match(iconStyles[1].maskImage, /edit-deck-icon\.png/, '修改 Deck 应使用第 2 张图抠出的符号');
  assert.ok(iconStyles.every(icon => icon.color === 'rgb(199, 0, 11)'), JSON.stringify(iconStyles));
  assert.ok(iconStyles.every(icon => Math.abs(icon.centerDeltaX) < .5 && Math.abs(icon.centerDeltaY) < .5), JSON.stringify(iconStyles));
  const assetStatuses = await page.evaluate(async () => Promise.all(
    ['/app/create-deck-icon.png', '/app/edit-deck-icon.png'].map(async path => (await fetch(path)).status),
  ));
  assert.deepEqual(assetStatuses, [200, 200], '透明图标资源应可正常加载');
  await cardIcons.first().hover();
  assert.equal(
    await cardIcons.first().locator('.work-card-icon-glyph')
      .evaluate(node => getComputedStyle(node).animationName),
    'work-card-icon-spin',
    '鼠标进入卡片图标时应触发一圈旋转',
  );
});

test('启动页任务卡片可以用稳定工作项身份就地改名', async t => {
  const history = {
    async list() {
      return {
        version:1,
        creation:[{
          kind:'creation', draftId:'draft-rename', projectRoot:'/tmp/deck-project',
          projectName:'deck-project', title:'未命名 Deck', provider:'codex',
          phase:'brief', progress:'等待开始对话', updatedAt:'2026-08-11T10:00:00.000Z',
        }],
        editing:[],
      };
    },
  };
  const catalog = new WorkCatalog({ filePath:null, legacyHistory:history });
  const app = await startAppServer({
    token:'browser-work-rename-secret',
    workHistoryStore:history,
    workCatalog:catalog,
  });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.goto(app.appUrl);
  await page.getByRole('button', { name:'重命名 未命名 Deck' }).click();
  const input = page.getByRole('textbox', { name:'工作项名称' });
  await input.fill('季度复盘工作项');
  await page.getByRole('button', { name:'保存名称' }).click();
  await page.getByText('季度复盘工作项', { exact:true }).waitFor();

  await page.reload();
  await page.getByText('季度复盘工作项', { exact:true }).waitFor();
  assert.equal(
    await page.locator('[data-creation-work-list]').getByText('未命名 Deck', { exact:true }).count(),
    0,
  );
});

test('启动页可以分别移除新建与修改项目并保留恢复记录', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-history-removal-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, 'delete-me.html');
  await writeFile(deckPath, '<!doctype html>');
  const creation = [{
    kind:'creation', taskId:'draft-delete', draftId:'draft-delete',
    projectRoot:root, projectName:'deck-project',
    title:'待删除 Draft', provider:'codex', phase:'outline', progress:'大纲已确认',
    revision:3, updatedAt:'2026-08-11T10:00:00.000Z', locked:false,
  }];
  const editing = [{
    deckPath, deckName:'delete-me.html', directory:root,
    modifiedAt:'2026-08-11T11:00:00.000Z', provider:'codex', progress:'继续编辑',
  }];
  const history = {
    async list() { return { version:1, creation:[...creation], editing:[...editing] }; },
  };
  const catalog = new WorkCatalog({ filePath:join(root, 'catalog.json'), legacyHistory:history });
  const app = await startAppServer({
    token:'browser-history-delete-secret',
    workHistoryStore:history,
    workCatalog:catalog,
  });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.on('dialog', dialog => dialog.accept());

  await page.goto(app.appUrl);
  assert.equal(await page.locator('.work-item-arrow').count(), 0, '任务行不应再显示跳转箭头');
  const creationDelete = page.getByRole('button', { name:'移除项目 待删除 Draft' });
  await creationDelete.waitFor();
  assert.equal(await creationDelete.locator('.work-item-delete-icon').count(), 2,
    '删除入口应使用双层垃圾桶图标完成 PillNav 换色动效');
  assert.equal((await creationDelete.textContent()).trim(), '', '删除入口不再显示文字');
  const beforeHover = await creationDelete.locator('.pill-nav-fill')
    .evaluate(node => getComputedStyle(node).transform);
  await creationDelete.hover();
  await page.waitForTimeout(350);
  const afterHover = await creationDelete.locator('.pill-nav-fill')
    .evaluate(node => getComputedStyle(node).transform);
  assert.notEqual(afterHover, beforeHover, '悬停时红色圆形填充应扩张');
  await creationDelete.click();
  await page.getByText('还没有进行中的 Draft。').waitFor();
  await page.getByRole('button', { name:'移除项目 delete-me.html' }).click();
  await page.getByText('还没有可继续的 Deck。').waitFor();
  const removed = await catalog.listRemoved();
  assert.equal(removed.length, 2);
  assert.ok(removed.every(item => item.lifecycle === 'removed'));
  assert.equal(await readFile(deckPath, 'utf8'), '<!doctype html>', '移除项目保留源文件');
});

test('新建 Deck 终端复用修改页密度，输入行始终位于窗口内', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-creation-terminal-layout-'));
  let terminal;
  const app = await startAppServer({
    token:'creation-terminal-layout-secret',
    pickAgentProjectDirectory:async () => projectRoot,
    createAgentTerminal:options => (terminal = new CreationTerminalFixture(options)),
  });
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(async () => {
    await browser.close();
    await app.close();
    await rm(projectRoot, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  });
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });

  await page.goto(app.appUrl);
  const supportNavigation = page.locator('.support-navigation');
  await page.getByRole('button', { name:/从0开始创建一个新的deck，新任务/ }).click();
  await page.getByRole('button', { name:/选择项目目录/ }).click();
  const confirmation = page.locator('[data-confirm-creation-project]');
  if (await confirmation.isVisible()) await confirmation.check();
  await page.getByRole('button', { name:/创建 Draft 并开始对话/ }).click();
  await page.locator('[data-builder]').waitFor({ state:'visible' });
  assert.equal(await supportNavigation.isHidden(), true, '新建 Deck 对话页不应重复显示使用与支持');
  const guidedTourTrigger = page.getByRole('button', { name:'新手引导', exact:true });
  assert.equal(await guidedTourTrigger.getAttribute('title'), '新手引导');
  assert.equal(await guidedTourTrigger.locator('.topbar-control-icon').count(), 1);
  assert.equal(await guidedTourTrigger.locator('circle').count(), 1);
  await guidedTourTrigger.click();
  await page.getByRole('heading', { name:'四个里程碑自动点亮' }).waitFor();
  assert.equal(await page.locator('[data-tour-dots] i').count(), 4);
  await page.waitForFunction(() => (
    document.querySelector('[data-tour-arrow-shape]')
      ?.getAttribute('transform')?.startsWith('translate(')
  ));
  assert.match(
    await page.locator('[data-tour-arrow-shape]').getAttribute('transform'),
    /^translate\(/,
  );
  await page.getByRole('button', { name:'跳过引导' }).click();
  await page.getByRole('button', { name:/重命名工作项 未命名 Deck/ }).click();
  const workItemName = page.getByRole('textbox', { name:'新建 Deck 工作项名称' });
  await workItemName.fill('客户评审工作项');
  await page.getByRole('button', { name:'保存新建 Deck 工作项名称' }).click();
  await page.getByRole('button', { name:'重命名工作项 客户评审工作项' }).waitFor();
  await creationCommand(app, {
    type:'update-brief', expectedRevision:0,
    patch:{ title:'Brief 内部标题', audience:'研发', durationMinutes:20, objective:'验证名称解耦' },
  });
  await page.waitForFunction(() => (
    document.querySelector('[data-draft-revision]')?.textContent?.includes('Revision 1')
  ));
  assert.equal(await page.locator('[data-draft-title]').textContent(), '客户评审工作项');
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-terminal-host] .xterm-screen')
    && document.querySelectorAll('[data-agent-terminal-host] .xterm-rows > div').length > 0
  ));
  await Promise.race([
    terminal.firstResize,
    new Promise((_, reject) => setTimeout(() => reject(new Error('终端未同步可见行列')), 1_500)),
  ]);

  const layout = await page.evaluate(() => {
    const panelNode = document.querySelector('[data-agent-terminal]');
    const hostNode = document.querySelector('[data-agent-terminal-host]');
    const viewportNode = hostNode.querySelector('.xterm-viewport');
    const screenNode = hostNode.querySelector('.xterm-screen');
    const measureNode = hostNode.querySelector('.xterm-char-measure-element');
    const plainTextRow = [...screenNode.querySelectorAll('.xterm-rows > div')]
      .find(row => row.textContent?.includes('终端输出'));
    const plainTextNode = plainTextRow?.querySelector('span') ?? plainTextRow;
    const panel = panelNode.getBoundingClientRect();
    const host = hostNode.getBoundingClientRect();
    const viewport = viewportNode.getBoundingClientRect();
    const screen = screenNode.getBoundingClientRect();
    const panelStyle = getComputedStyle(panelNode);
    const measureStyle = measureNode ? getComputedStyle(measureNode) : null;
    return {
      viewportHeight:window.innerHeight,
      bodyHeight:document.body.scrollHeight,
      panelWidth:panel.width,
      panelHeight:panel.height,
      panelBottom:panel.bottom,
      hostHeight:host.height,
      hostBottom:host.bottom,
      viewportBottom:viewport.bottom,
      screenBottom:screen.bottom,
      visibleRows:screenNode.querySelectorAll('.xterm-rows > div').length,
      scrollGap:viewportNode.scrollHeight - viewportNode.clientHeight - viewportNode.scrollTop,
      fontSize:measureStyle?.fontSize ?? '',
      terminalFontFamily:measureStyle?.fontFamily ?? '',
      terminalTextColor:plainTextNode ? getComputedStyle(plainTextNode).color : '',
      panelFontFamily:panelStyle.fontFamily,
      panelBorderRadius:panelStyle.borderRadius,
      sharedStyleLoaded:[...document.styleSheets].some(sheet => (
        sheet.href?.includes('/agent-terminal-panel.css')
      )),
    };
  });

  assert.ok(layout.panelWidth >= 1600, JSON.stringify(layout));
  assert.ok(layout.hostHeight < layout.panelHeight - 80, JSON.stringify(layout));
  assert.ok(layout.panelBottom <= layout.viewportHeight + 1, JSON.stringify(layout));
  assert.ok(layout.hostBottom <= layout.panelBottom + 1, JSON.stringify(layout));
  assert.ok(layout.viewportBottom <= layout.hostBottom + 1, JSON.stringify(layout));
  assert.ok(layout.screenBottom <= layout.hostBottom + 1, JSON.stringify(layout));
  assert.ok(layout.bodyHeight <= layout.viewportHeight, JSON.stringify(layout));
  assert.ok(layout.visibleRows >= 48, JSON.stringify(layout));
  assert.ok(layout.scrollGap <= 2, JSON.stringify(layout));
  assert.equal(layout.fontSize, '12px');
  assert.match(layout.terminalFontFamily, /SFMono-Regular/);
  assert.equal(layout.terminalTextColor, 'rgb(229, 231, 235)');
  assert.match(layout.panelFontFamily, /AICO-PPT UI/);
  assert.equal(layout.panelBorderRadius, '18px');
  assert.equal(layout.sharedStyleLoaded, true);
  assert.ok(terminal.resizes.at(-1)?.[1] >= 48, JSON.stringify(terminal.resizes));
  assert.equal(await page.locator('[data-brief-form]').count(), 0, '对话态不应再出现中间表单');
  assert.equal(await page.locator('[data-step]').count(), 0, '里程碑不是可点击的阶段导航');
  assert.equal(await page.locator('[data-milestone]').count(), 4);
  assert.equal(await page.locator('[data-deck-stage]').isHidden(), true);
});

test('新建 Deck 已收起终端时，目录信任提示会强制重新展开', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-creation-terminal-trust-'));
  let terminal;
  const app = await startAppServer({
    token:'creation-terminal-trust-secret',
    pickAgentProjectDirectory:async () => projectRoot,
    createAgentTerminal:options => (terminal = new CreationTerminalFixture(options)),
  });
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(async () => {
    await browser.close();
    await app.close();
    await rm(projectRoot, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  });
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });

  await page.goto(app.appUrl);
  await page.getByRole('button', { name:/从0开始创建一个新的deck，新任务/ }).click();
  await page.getByRole('button', { name:/选择项目目录/ }).click();
  const confirmation = page.locator('[data-confirm-creation-project]');
  if (await confirmation.isVisible()) await confirmation.check();
  await page.getByRole('button', { name:/创建 Draft 并开始对话/ }).click();
  const panel = page.locator('[data-agent-terminal]');
  await panel.waitFor({ state:'visible' });
  await page.locator('[data-builder]').evaluate(node => {
    node.dataset.hasDeck = 'true';
    node.querySelector('.agent-terminal-close')?.click();
  });
  await panel.waitFor({ state:'hidden' });
  await page.locator('[data-terminal-reopen]').waitFor({ state:'visible' });

  terminal.emitInteractionRequired();
  await panel.waitFor({ state:'visible' });
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-terminal]')?.dataset.interactionRequired
      === 'directory-trust'
      && document.querySelector('[data-builder]')?.dataset.terminalHidden === 'false'
  ));
  assert.match(await panel.locator('.agent-terminal-detail').innerText(), /确认是否信任/);
  assert.equal(await page.locator('[data-terminal-reopen]').isHidden(), true);
});

test('新建 Deck 对话页按任务类型下拉并直接切换项目', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-creation-navigation-e2e-'));
  let terminalStarts = 0;
  let terminal;
  const app = await startAppServer({
    token:'creation-navigation-e2e-secret',
    pickAgentProjectDirectory:async () => projectRoot,
    createAgentTerminal:options => {
      terminalStarts += 1;
      terminal = new CreationTerminalFixture(options);
      return terminal;
    },
  });
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(async () => {
    await browser.close();
    await app.close();
    await rm(projectRoot, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  });
  const page = await browser.newPage({ viewport:{ width:1440, height:900 } });

  const enterBuilder = async () => {
    await page.getByRole('button', { name:/从0开始创建一个新的deck，新任务/ }).click();
    await page.getByRole('button', { name:/选择项目目录/ }).click();
    const confirmation = page.locator('[data-confirm-creation-project]');
    if (await confirmation.isVisible()) await confirmation.check();
    await page.getByRole('button', { name:/创建 Draft 并开始对话/ }).click();
    await page.locator('[data-builder]').waitFor({ state:'visible' });
    await page.locator('[data-workspace-navigation]').waitFor({ state:'visible' });
  };

  await page.goto(app.appUrl);
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  const exitEditor = page.getByRole('button', { name:'退出编辑器' });
  assert.equal(await exitEditor.isVisible(), true, '初始页右上角必须显示退出编辑器');
  assert.deepEqual(
    await page.locator('[data-support-navigation] button, [data-exit-editor]')
      .evaluateAll(buttons => buttons.filter(button => button.offsetParent !== null).map(button => (
        button.dataset.supportOpen ?? 'exit'
      ))),
    ['onboarding', 'help', 'diagnostics', 'exit'],
    '起始页辅助入口应从引导到帮助与诊断，最后才是退出',
  );
  await enterBuilder();
  assert.equal(await exitEditor.isVisible(), true);
  assert.equal(await exitEditor.locator('.pill-nav-label-default').innerText(), '退出编辑器');
  assert.equal(await exitEditor.evaluate(button => button.textContent.includes('←')), false);
  assert.deepEqual(await exitEditor.locator('.exit-editor-icon').first().evaluate(element => ({
    color:getComputedStyle(element).color,
    background:getComputedStyle(element).backgroundColor,
    pathCount:element.querySelectorAll('path').length,
  })), { color:'rgb(199, 0, 11)', background:'rgba(0, 0, 0, 0)', pathCount:5 });
  assert.equal(await exitEditor.locator('.pill-nav-label-default > :last-child')
    .evaluate(element => element.tagName), 'svg');
  assert.equal(await page.locator('[data-workspace-navigation]').evaluate(element => (
    getComputedStyle(element).backgroundColor
  )), 'rgb(227, 229, 233)');
  assert.equal(await page.locator('[data-workspace-navigation]').evaluate(element => (
    getComputedStyle(element).borderRadius
  )), '999px');
  assert.equal(await page.locator('.workspace-navigation-button').first().evaluate(element => (
    getComputedStyle(element).borderRadius
  )), '999px');
  assert.equal(await page.locator('.workspace-navigation .pill-nav-label-default').count(), 2);
  assert.equal(await page.locator('.workspace-navigation .pill-nav-label-hover').count(), 2);
  const creationToolbarOrder = await page.locator('.topbar-actions').evaluate(element => (
    [...element.querySelectorAll('button')]
      .filter(button => button.offsetParent !== null)
      .map(button => (
        button.hasAttribute('data-workspace-home') ? 'home'
          : button.hasAttribute('data-workspace-switch') ? 'switch'
            : button.dataset.guidedTour === 'creation' ? 'guide'
              : button.hasAttribute('data-exit-editor') ? 'exit' : 'other'
      ))
  ));
  assert.deepEqual(creationToolbarOrder, ['home', 'switch', 'guide', 'exit']);
  await page.getByRole('button', { name:'切换项目' }).hover();
  await page.waitForTimeout(360);
  assert.equal(await page.getByRole('button', { name:'切换项目' }).locator('.pill-nav-label-default').evaluate(element => (
    getComputedStyle(element).opacity
  )), '0');
  assert.equal(await page.getByRole('button', { name:'切换项目' }).locator('.pill-nav-label-hover').evaluate(element => (
    getComputedStyle(element).opacity
  )), '1');
  if (process.env.CREATION_NAVIGATION_SCREENSHOT) {
    await page.screenshot({ path:process.env.CREATION_NAVIGATION_SCREENSHOT, fullPage:true });
  }
  await page.getByRole('button', { name:'切换项目' }).click();
  const switcher = page.locator('[data-workspace-switcher]');
  await switcher.waitFor({ state:'visible' });
  const creationGroup = switcher.locator('[data-workspace-switcher-group="creation"]');
  const editingGroup = switcher.locator('[data-workspace-switcher-group="editing"]');
  const groupStyles = async group => group.evaluate(element => {
    const style = getComputedStyle(element);
    const indexStyle = getComputedStyle(element.querySelector('.workspace-switcher-group-index'));
    return {
      backgroundColor:style.backgroundColor,
      borderColor:style.borderColor,
      indexBackgroundColor:indexStyle.backgroundColor,
    };
  });
  assert.deepEqual(await groupStyles(creationGroup), await groupStyles(editingGroup));
  assert.equal(
    await switcher.locator('.workspace-switcher-item[data-current="true"]').evaluate(element => (
      getComputedStyle(element).backgroundColor
    )),
    'rgb(255, 255, 255)',
  );
  assert.equal(
    await switcher.locator('.workspace-switcher-item-badge[data-kind="current"]').evaluate(element => (
      getComputedStyle(element).color
    )),
    'rgb(95, 102, 112)',
  );
  assert.match(
    await creationGroup.textContent(),
    /新建 Deck/,
  );
  assert.match(
    await editingGroup.textContent(),
    /修改 Deck/,
  );
  assert.equal(
    await switcher.locator('.workspace-switcher-item-meta > span').count(),
    0,
    '项目切换列表的时间后不应再显示跳转箭头',
  );
  if (process.env.CREATION_SWITCHER_SCREENSHOT) {
    await page.screenshot({ path:process.env.CREATION_SWITCHER_SCREENSHOT, fullPage:true });
  }
  const previousBuilderUrl = page.url();
  await switcher.locator('[data-workspace-task="creation"][data-current="true"]').click();
  await page.waitForFunction(previous => location.href !== previous, previousBuilderUrl);
  await page.locator('[data-builder]').waitFor({ state:'visible' });
  assert.equal(app.state, 'building');
  assert.equal(terminalStarts, 1, '切回同一任务不得重新创建 Agent runtime');

  await page.getByRole('button', { name:'初始页' }).click();
  await page.locator('[data-landing]').waitFor({ state:'visible' });
  await page.waitForFunction(() => !document.documentElement.dataset.workspaceNavigationState);
  assert.equal(new URL(page.url()).searchParams.get('view'), 'home');
  assert.equal(app.state, 'idle');
  assert.equal(terminal.state, 'running', '返回首页后 Agent 应继续在后台运行');
});

test('修改 Deck 编辑页按任务类型下拉并直接切换项目', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-edit-navigation-e2e-'));
  const deckPath = join(root, 'navigation-deck.html');
  await copyFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'), deckPath);
  let editorStarts = 0;
  const app = await startAppServer({
    token:'editing-navigation-e2e-secret',
    pickDeck:async () => deckPath,
    resolveAgentProject:async () => ({
      path:root, source:'explicit', needsConfirmation:false, warning:null,
      identity:{ originalPath:root, realPath:root, dev:'1', ino:'2' },
    }),
    assertAgentProject:async project => project.path,
    startEditor:options => {
      editorStarts += 1;
      return startServer({ ...options, autoStartAgentTerminal:false });
    },
  });
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(async () => {
    await browser.close();
    await app.close();
    await rm(root, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  });
  const page = await browser.newPage({ viewport:{ width:1440, height:900 } });

  const openEditor = async () => {
    await page.getByRole('button', { name:/修改已经写好的deck，新任务/ }).click();
    await page.getByRole('button', { name:/添加 Deck HTML/ }).click();
    await page.getByRole('button', { name:/打开编辑器/ }).click();
    await page.waitForURL(/\/editor\//);
    await page.locator('[data-workspace-navigation]').waitFor({ state:'visible' });
  };

  await page.goto(app.appUrl);
  await openEditor();
  const reopenedPage = await browser.newPage({ viewport:{ width:1440, height:900 } });
  await reopenedPage.goto(app.appUrl);
  await reopenedPage.waitForURL(/\/editor\//);
  assert.equal(editorStarts, 1, '重新打开 App 应复用现有 Editor runtime');
  await reopenedPage.close();
  if (process.env.EDITING_NAVIGATION_SCREENSHOT) {
    await page.screenshot({ path:process.env.EDITING_NAVIGATION_SCREENSHOT, fullPage:true });
  }
  await page.getByRole('button', { name:'切换项目' }).click();
  const switcher = page.locator('[data-workspace-switcher]');
  await switcher.waitFor({ state:'visible' });
  await switcher.locator('.workspace-switcher-group').first().waitFor();
  const switcherGroupStyles = await switcher.locator('.workspace-switcher-group').evaluateAll(groups => (
    groups.map(element => {
      const style = getComputedStyle(element);
      const indexStyle = getComputedStyle(element.querySelector('.workspace-switcher-group-index'));
      return {
        backgroundColor:style.backgroundColor,
        borderColor:style.borderColor,
        indexBackgroundColor:indexStyle.backgroundColor,
      };
    })
  ));
  assert.equal(switcherGroupStyles.length, 2);
  assert.deepEqual(switcherGroupStyles[0], switcherGroupStyles[1]);
  const currentEditingTask = switcher.locator(
    '[data-workspace-task="editing"][data-current="true"]',
  );
  assert.equal(
    await currentEditingTask.count(),
    1,
    '修改 Deck 的当前任务必须显示当前状态',
  );
  assert.equal(
    await currentEditingTask.locator('.workspace-switcher-item-badge[data-kind="current"]').textContent(),
    '当前',
  );
  assert.match(
    await switcher.locator('[data-workspace-switcher-group="creation"]').textContent(),
    /新建 Deck/,
  );
  assert.match(
    await switcher.locator('[data-workspace-switcher-group="editing"]').textContent(),
    /修改 Deck/,
  );
  if (process.env.EDITING_SWITCHER_SCREENSHOT) {
    await page.screenshot({ path:process.env.EDITING_SWITCHER_SCREENSHOT, fullPage:true });
  }
  const previousEditorUrl = page.url();
  await currentEditingTask.click();
  await page.waitForFunction(previous => location.href !== previous, previousEditorUrl);
  await page.waitForURL(/\/editor\//);
  await page.locator('[data-workspace-navigation]').waitFor({ state:'visible' });
  assert.equal(app.state, 'selected');
  assert.equal(editorStarts, 1, '切回同一任务不得重新启动 Editor 或 Agent runtime');

  await page.getByRole('button', { name:'初始页' }).click();
  await page.locator('[data-landing]').waitFor({ state:'visible' });
  await page.waitForFunction(() => !document.documentElement.dataset.workspaceNavigationState);
  assert.equal(new URL(page.url()).searchParams.get('view'), 'home');
  assert.equal(app.state, 'idle');
  assert.equal(editorStarts, 1);
  assert.equal((await fetch(previousEditorUrl)).status, 200, '返回首页后 Editor 应继续后台运行');
});

test('任务切换等待目标运行时时不暴露启动初始页', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-direct-navigation-e2e-'));
  const deckPath = join(root, '直接切换.html');
  await copyFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'), deckPath);
  let releaseEditorStart;
  const editorStartGate = new Promise(resolvePromise => { releaseEditorStart = resolvePromise; });
  let editorStartReleased = false;
  let app;
  app = await startAppServer({
    token:'direct-navigation-e2e-secret',
    workHistoryStore:{
      async list() {
        return { version:1, creation:[], editing:[{
          deckPath, projectRoot:root, provider:'codex',
        }] };
      },
      async resolveDeck(value) { return value === deckPath ? deckPath : null; },
      async recordDeck() {},
    },
    resolveAgentProject:async () => ({
      path:root, source:'persisted', needsConfirmation:false, warning:null,
      identity:{ originalPath:root, realPath:root, dev:'1', ino:'2' },
    }),
    assertAgentProject:async project => project.path,
    startEditor:async options => {
      await editorStartGate;
      return startServer({ ...options, autoStartAgentTerminal:false });
    },
  });
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(async () => {
    if (!editorStartReleased) releaseEditorStart();
    await browser.close();
    await app.close();
    await rm(root, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  });
  const page = await browser.newPage({ viewport:{ width:1440, height:900 } });
  await page.goto(app.appUrl);
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');

  const target = new URL(app.appUrl);
  target.searchParams.set('view', 'editing');
  target.searchParams.set('leaveWorkspace', '1');
  target.searchParams.set('switchKind', 'editing');
  target.searchParams.set('deckPath', deckPath);
  const switchingHtml = await fetch(target).then(response => response.text());
  assert.match(switchingHtml,
    /<html[^>]+data-workspace-navigation-state="pending"/u,
    '切换文档必须在浏览器首次绘制前进入过渡态');
  await page.goto(target.href, { waitUntil:'commit' });
  await page.waitForFunction(() => (
    document.documentElement.dataset.workspaceNavigationState === 'pending'
  ));
  assert.equal(await page.locator('[data-landing]').isVisible(), false,
    '目标运行时尚未就绪时不得短暂显示初始页');

  editorStartReleased = true;
  releaseEditorStart();
  await page.waitForURL(/\/editor\//u);
  await page.locator('[data-workspace-navigation]').waitFor({ state:'visible' });
});

test('修改 Deck 在 Agent 执行和未固化修改并存时可多任务往返切换', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-edit-busy-navigation-e2e-'));
  const firstDirectory = join(root, 'first');
  const secondDirectory = join(root, 'second');
  const thirdDirectory = join(root, 'third');
  await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory), mkdir(thirdDirectory)]);
  const firstDeck = join(firstDirectory, 'busy-first.html');
  const secondDeck = join(secondDirectory, 'busy-second.html');
  const thirdDeck = join(thirdDirectory, 'busy-third.html');
  await Promise.all([
    copyFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'), firstDeck),
    copyFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'), secondDeck),
    copyFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'), thirdDeck),
  ]);
  await Promise.all([
    writeFile(secondDeck, `${await readFile(secondDeck, 'utf8')}\n<!-- busy-second -->\n`),
    writeFile(thirdDeck, `${await readFile(thirdDeck, 'utf8')}\n<!-- busy-third -->\n`),
  ]);
  const editors = new Map();
  let editorStarts = 0;
  const hangingAgent = {
    id:'codex',
    async run({ signal }) {
      return new Promise((resolvePromise, reject) => {
        signal?.addEventListener('abort', () => reject(Object.assign(
          new Error('测试结束'), { code:'AGENT_RUN_CANCELLED' },
        )), { once:true });
      });
    },
  };
  const editingEntries = [firstDeck, secondDeck, thirdDeck].map((deckPath, index) => ({
    deckPath,
    deckName:deckPath.split('/').at(-1),
    directory:root,
    projectRoot:root,
    provider:'codex',
    progress:index === 0 ? 'Agent 正在处理' : '继续编辑',
    modifiedAt:`2026-08-12T12:0${index}:00.000Z`,
  }));
  const workHistoryStore = {
    async list() { return { version:1, creation:[], editing:editingEntries }; },
    async recordDeck() {},
    async resolveDeck(deckPath) {
      return [firstDeck, secondDeck, thirdDeck].includes(deckPath) ? deckPath : null;
    },
  };
  const app = await startAppServer({
    token:'editing-busy-navigation-e2e-secret',
    pickDeck:async () => firstDeck,
    workHistoryStore,
    resolveAgentProject:async ({ deckPath }) => ({
      path:root, source:'explicit', needsConfirmation:false, warning:null,
      identity:{
        originalPath:root, realPath:root, dev:'1',
        ino:String([firstDeck, secondDeck, thirdDeck].indexOf(deckPath) + 1),
      },
    }),
    assertAgentProject:async project => project.path,
    startEditor:async options => {
      editorStarts += 1;
      const editor = await startServer({
        ...options,
        autoStartAgentTerminal:false,
        agentRunAdapter:hangingAgent,
      });
      editors.set(options.deckPath, editor);
      return editor;
    },
  });
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(async () => {
    await browser.close();
    await app.close();
    await rm(root, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  });
  const page = await browser.newPage({ viewport:{ width:1440, height:900 } });
  await page.goto(app.appUrl);
  await page.getByRole('button', { name:/修改已经写好的deck，新任务/ }).click();
  await page.getByRole('button', { name:/添加 Deck HTML/ }).click();
  await page.getByRole('button', { name:/打开编辑器/ }).click();
  await page.waitForURL(/\/editor\//);
  const firstEditor = editors.get(firstDeck);
  assert.ok(firstEditor);

  const pageKey = await page.locator('[data-page-key]').first().getAttribute('data-page-key');
  const createdResponse = await fetch(`${firstEditor.url}/api/tasks?token=${firstEditor.token}`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      expectedRevision:0,
      pageKey,
      pageIndex:1,
      pageLabel:'测试页',
      instruction:'保持 Agent 执行，测试任务切换',
      rect:{ x:80, y:80, w:500, h:160 },
    }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201, JSON.stringify(created));
  firstEditor.agentRuns.start({
    expectedRevision:created.revision,
    taskIds:[created.task.id],
  });
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-status]')?.dataset.agentStatus === 'busy'
  ));

  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const target = await heading.evaluate(
    element => window.HuaweiDeckPatchRuntime.makeLocator(element),
  );
  const actionResponse = await fetch(
    `${firstEditor.url}/api/actions?token=${firstEditor.token}`,
    {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        expectedRevision:created.revision,
        taskId:null,
        actions:[{
          id:'navigation-unsolidified-move', taskId:null, target, kind:'translate',
          payload:{ x:24, y:12 }, expectedRevision:created.revision,
        }],
      }),
    },
  );
  const actionResult = await actionResponse.json();
  assert.equal(actionResponse.status, 200, JSON.stringify(actionResult));
  await page.waitForFunction(() => (
    document.querySelector('[data-solidify]')?.dataset.unsolidified === 'true'
  ));

  const dialogs = [];
  page.on('dialog', async dialog => {
    dialogs.push(dialog.type());
    await dialog.dismiss();
  });
  const switchTo = async (deckName, expectedDeck) => {
    const previousUrl = page.url();
    await page.getByRole('button', { name:'切换项目' }).click();
    const switcher = page.locator('[data-workspace-switcher]');
    await switcher.waitFor({ state:'visible' });
    await switcher.locator('.workspace-switcher-item').filter({ hasText:deckName }).click();
    await page.waitForURL(url => url.pathname.endsWith('/editor/')
      && url.searchParams.get('workspaceKind') === 'editing'
      && url.href !== previousUrl, { timeout:5_000 });
    const expectedEditor = editors.get(expectedDeck) ?? editors.get(await realpath(expectedDeck));
    assert.equal(expectedEditor?.url, new URL(page.url()).origin);
    assert.deepEqual(dialogs, [], `切换到 ${deckName} 不得弹出关闭网页警告`);
  };

  await switchTo('busy-second.html', secondDeck);
  assert.equal(firstEditor.agentRuns.snapshot().status, 'running');
  assert.equal((await fetch(
    `${firstEditor.url}/editor/?token=${firstEditor.token}&editorToken=${firstEditor.editorToken}`,
  )).status, 200, '原 Editor 必须继续后台运行');
  await switchTo('busy-third.html', thirdDeck);
  assert.equal(editorStarts, 3);
  await switchTo('busy-first.html', firstDeck);
  await switchTo('busy-second.html', secondDeck);
  await switchTo('busy-first.html', firstDeck);
  assert.equal(editorStarts, 3, '往返切换时必须复用各自的 Editor 与 Agent runtime');
  assert.equal(firstEditor.agentRuns.snapshot().status, 'running');
  assert.equal(
    await page.locator('[data-solidify]').getAttribute('data-unsolidified'),
    'true',
    '切回原任务后未固化修改必须保留',
  );
});

test('修改 Deck 与新建 Draft 可往返切换并复用各自运行时', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-cross-kind-navigation-e2e-'));
  const deckPath = join(projectRoot, 'cross-kind-editing.html');
  await copyFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'), deckPath);
  const history = { creation:[], editing:[] };
  const workHistoryStore = {
    async list() { return { version:1, creation:[...history.creation], editing:[...history.editing] }; },
    async recordCreation({ projectRoot:root, draftId, provider }) {
      const entry = {
        projectRoot:root, draftId, provider, title:'跨类型新建任务',
        projectName:root.split('/').at(-1), progress:'需求沟通中',
        updatedAt:'2026-08-12T12:10:00.000Z', locked:false,
      };
      history.creation = [entry];
      return entry;
    },
    async resolveCreation({ projectRoot:root, draftId }) {
      return history.creation.find(entry => (
        entry.projectRoot === root && entry.draftId === draftId
      )) ?? null;
    },
    async recordDeck({ deckPath:recordedDeck, provider }) {
      const entry = {
        deckPath:recordedDeck, deckName:recordedDeck.split('/').at(-1),
        directory:projectRoot, projectRoot, provider, progress:'继续编辑',
        modifiedAt:'2026-08-12T12:11:00.000Z',
      };
      history.editing = [entry];
      return entry;
    },
    async resolveDeck(requestedDeck) {
      return requestedDeck === deckPath ? deckPath : null;
    },
    async completeCreation() {},
    async dismissCreation() {},
    async dismissDeck() {},
  };
  let terminalStarts = 0;
  let editorStarts = 0;
  let editingRuntime;
  const app = await startAppServer({
    token:'cross-kind-navigation-e2e-secret',
    pickAgentProjectDirectory:async () => projectRoot,
    pickDeck:async () => deckPath,
    workHistoryStore,
    createAgentTerminal:options => {
      terminalStarts += 1;
      return new CreationTerminalFixture(options);
    },
    resolveAgentProject:async () => ({
      path:projectRoot, source:'explicit', needsConfirmation:false, warning:null,
      identity:{ originalPath:projectRoot, realPath:projectRoot, dev:'1', ino:'1' },
    }),
    assertAgentProject:async project => project.path,
    startEditor:async options => {
      editorStarts += 1;
      editingRuntime = await startServer({ ...options, autoStartAgentTerminal:false });
      return editingRuntime;
    },
  });
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(async () => {
    await browser.close();
    await app.close();
    await rm(projectRoot, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  });
  const page = await browser.newPage({ viewport:{ width:1440, height:900 } });

  await page.goto(app.appUrl);
  await page.getByRole('button', { name:/从0开始创建一个新的deck，新任务/ }).click();
  await page.getByRole('button', { name:/选择项目目录/ }).click();
  const confirmation = page.locator('[data-confirm-creation-project]');
  if (await confirmation.isVisible()) await confirmation.check();
  await page.getByRole('button', { name:/创建 Draft 并开始对话/ }).click();
  await page.locator('[data-builder]').waitFor({ state:'visible' });
  await page.getByRole('button', { name:'初始页' }).click();
  await page.locator('[data-landing]').waitFor({ state:'visible' });

  await page.getByRole('button', { name:/修改已经写好的deck，新任务/ }).click();
  await page.getByRole('button', { name:/添加 Deck HTML/ }).click();
  await page.getByRole('button', { name:/打开编辑器/ }).click();
  await page.waitForURL(/\/editor\//);
  assert.ok(editingRuntime);

  await page.getByRole('button', { name:'切换项目' }).click();
  const initialSwitcher = page.locator('[data-workspace-switcher]');
  await initialSwitcher.getByRole('button', { name:'重命名 cross-kind-editing.html' }).click();
  await initialSwitcher.getByRole('textbox', { name:'工作项名称' }).fill('跨类型修改任务');
  await initialSwitcher.getByRole('button', { name:'保存名称' }).click();
  await initialSwitcher.getByText('跨类型修改任务', { exact:true }).waitFor();
  await page.getByRole('button', { name:'切换项目' }).click();
  assert.equal(editingRuntime.deckPath, deckPath, '工作项改名不能修改 Deck 文件路径');

  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const target = await heading.evaluate(
    element => window.HuaweiDeckPatchRuntime.makeLocator(element),
  );
  const actionResponse = await fetch(
    `${editingRuntime.url}/api/actions?token=${editingRuntime.token}`,
    {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        expectedRevision:0,
        taskId:null,
        actions:[{
          id:'cross-kind-unsolidified-move', taskId:null, target, kind:'translate',
          payload:{ x:18, y:9 }, expectedRevision:0,
        }],
      }),
    },
  );
  const actionResult = await actionResponse.json();
  assert.equal(actionResponse.status, 200, JSON.stringify(actionResult));
  await page.waitForFunction(() => (
    document.querySelector('[data-solidify]')?.dataset.unsolidified === 'true'
  ));

  const dialogs = [];
  page.on('dialog', async dialog => {
    dialogs.push(dialog.type());
    await dialog.dismiss();
  });
  const chooseTask = async name => {
    await page.getByRole('button', { name:'切换项目' }).click();
    const switcher = page.locator('[data-workspace-switcher]');
    await switcher.waitFor({ state:'visible' });
    await switcher.locator('[data-workspace-task]').filter({ hasText:name }).click();
  };

  await chooseTask(/跨类型新建任务/);
  await page.locator('[data-builder]').waitFor({ state:'visible' });
  assert.equal(terminalStarts, 1, '切回新建任务必须复用原 Agent runtime');
  assert.deepEqual(dialogs, [], '修改任务切到新建任务不得弹出离页确认');

  await chooseTask(/跨类型修改任务/);
  await page.waitForURL(url => url.origin === editingRuntime.url, { timeout:5_000 });
  assert.equal(editorStarts, 1, '切回修改任务必须复用原 Editor runtime');
  assert.equal(
    await page.locator('[data-solidify]').getAttribute('data-unsolidified'),
    'true',
    '跨类型切换后未固化修改必须保留',
  );

  await chooseTask(/跨类型新建任务/);
  await page.locator('[data-builder]').waitFor({ state:'visible' });
  await chooseTask(/跨类型修改任务/);
  await page.waitForURL(url => url.origin === editingRuntime.url, { timeout:5_000 });
  assert.equal(terminalStarts, 1);
  assert.equal(editorStarts, 1);
  assert.deepEqual(dialogs, [], '多次跨类型往返都不得弹出离页确认');
});

test('直接关闭工作台标签页后统一停止后台 Editor 和 Agent 进程', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-workspace-close-e2e-'));
  const deckPath = join(root, 'close-workspace.html');
  await copyFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'), deckPath);
  const app = await startAppServer({
    token:'workspace-close-e2e-secret',
    launcherClientCloseGraceMs:500,
    pickDeck:async () => deckPath,
    resolveAgentProject:async () => ({
      path:root, source:'explicit', needsConfirmation:false, warning:null,
      identity:{ originalPath:root, realPath:root, dev:'1', ino:'2' },
    }),
    assertAgentProject:async project => project.path,
    startEditor:options => startServer({ ...options, autoStartAgentTerminal:false }),
  });
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(async () => {
    await browser.close();
    await app.close();
    await rm(root, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  });
  const page = await browser.newPage({ viewport:{ width:1440, height:900 } });

  await page.goto(app.appUrl);
  await page.getByRole('button', { name:/修改已经写好的deck，新任务/ }).click();
  await page.getByRole('button', { name:/添加 Deck HTML/ }).click();
  await page.getByRole('button', { name:/打开编辑器/ }).click();
  await page.waitForURL(/\/editor\//);
  await page.locator('[data-workspace-navigation]').waitFor({ state:'visible' });
  assert.equal(app.state, 'selected');

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable:true,
      value:() => false,
    });
  });
  await browser.close();
  const deadline = Date.now() + 2_000;
  while (app.state !== 'closed' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(app.state, 'closed');
});

test('浏览器关闭时即使 close beacon 丢失也由持续租约回收全部服务', async t => {
  const app = await startAppServer({
    token:'workspace-crash-reap-e2e-secret',
    launcherClientCloseGraceMs:80,
    launcherLeaseHandshakeMs:1_000,
  });
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(async () => {
    await browser.close().catch(() => {});
    await app.close();
  });
  const page = await browser.newPage();
  await page.goto(app.appUrl);
  await page.waitForFunction(() => document.readyState === 'complete');
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable:true,
      value:() => false,
    });
  });

  await browser.close();
  const deadline = Date.now() + 2_000;
  while (app.state !== 'closed' && Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  assert.equal(app.state, 'closed');
});

test('Agent 写入里程碑并创建独立 Deck 后，画布自动出现且终端停靠右侧', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-creation-auto-layout-'));
  const templatePath = join(projectRoot, 'template.html');
  await copyFile(resolve('assets/tech-share-deck.html'), templatePath);
  const catalog = {
    catalogPath:resolve('scripts/editor/template-catalog.json'),
    resolve:() => ({
      templateId:'tech-share', name:'技术分享', description:'测试模板', sourcePath:templatePath,
      pageCount:37,
      pageTypes:[{
        pageTypeId:'cover', name:'技术封面', sourcePage:1, sourceLabel:'技术分享封面',
        repeatable:false, role:'cover', position:'first', preserveLayout:true,
      }],
    }),
    snapshot:() => ({ version:1, templates:[] }),
  };
  const app = await startAppServer({
    token:'creation-auto-layout-secret',
    pythonExecutable:PYTHON_EXECUTABLE,
    pickAgentProjectDirectory:async () => projectRoot,
    createAgentTerminal:options => new CreationTerminalFixture(options),
    // 该用例只验证创建页布局、实时画布与 Editor 交接；质量契约由 DeckFactory
    // 单元与 Python 契约测试覆盖，避免让真实模板内容绑死界面 E2E fixture。
    createCreationWorkspace:options => DeckCreationWorkspace.create({
      ...options,
      catalog,
      commandRunner:async () => ({ code:0, stdout:'fixture-ok', stderr:'' }),
    }),
  });
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  t.after(async () => {
    await browser.close();
    await app.close();
    await rm(projectRoot, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  });

  await page.goto(app.appUrl);
  await page.getByRole('button', { name:/从0开始创建一个新的deck，新任务/ }).click();
  await page.getByRole('button', { name:/选择项目目录/ }).click();
  const confirmation = page.locator('[data-confirm-creation-project]');
  if (await confirmation.isVisible()) await confirmation.check();
  await page.getByRole('button', { name:/创建 Draft 并开始对话/ }).click();
  await page.locator('[data-builder]').waitFor({ state:'visible' });

  await creationCommand(app, {
    type:'update-brief', expectedRevision:0,
    patch:{ title:'自动布局 Deck', audience:'研发', durationMinutes:20, objective:'验证自动切换' },
  });
  await creationCommand(app, { type:'confirm-brief', expectedRevision:1 });
  await creationCommand(app, {
    type:'propose-outline', expectedRevision:2,
    outline:{ sections:[{
      chapterId:'one', title:'第一章', objective:'讲清楚', pageBudget:1, timeBudgetMinutes:10,
    }] },
  });
  await creationCommand(app, { type:'confirm-outline', expectedRevision:3 });
  await creationCommand(app, {
    type:'propose-page-plan', expectedRevision:4,
    pagePlan:{ pages:[{
      pageId:'p1', chapterId:'one', pageTypeId:'cover', label:'封面',
      coreClaim:'核心观点', layoutRationale:'封面', artwork:'无', steps:0,
    }] },
  });
  await creationCommand(app, { type:'confirm-page-plan', expectedRevision:5 });
  await creationCommand(app, {
    type:'set-output', expectedRevision:6,
    output:{
      fileName:'auto-layout.html', templateId:'tech-share', includePlan:true,
      trialPptx:false, autoOpenEditor:true,
    },
  });
  await creationCommand(app, { type:'start-generation', expectedRevision:7 });

  await page.locator('[data-deck-stage]').waitFor({ state:'visible' });
  await page.frameLocator('[data-deck-preview]').frameLocator('#deck-frame')
    .getByText(/技术分享主标题/).first().waitFor();
  await page.waitForFunction(() => (
    document.querySelector('[data-milestone="deck"]')?.dataset.state === 'complete'
  ));
  const layout = await page.evaluate(() => ({
    hasDeck:document.querySelector('[data-builder]').dataset.hasDeck,
    stageWidth:document.querySelector('[data-deck-stage]').getBoundingClientRect().width,
    terminalWidth:document.querySelector('[data-agent-terminal]').getBoundingClientRect().width,
    milestoneStates:[...document.querySelectorAll('[data-milestone]')].map(node => node.dataset.state),
  }));
  assert.equal(layout.hasDeck, 'true');
  assert.ok(layout.stageWidth >= 700, JSON.stringify(layout));
  assert.ok(layout.terminalWidth >= 600 && layout.terminalWidth <= 660, JSON.stringify(layout));
  assert.deepEqual(layout.milestoneStates, ['complete', 'complete', 'complete', 'complete']);

  const beforeMutation = await fetch(
    `${app.url}/api/creation-draft?token=${encodeURIComponent(app.token)}`,
  ).then(response => response.json());
  await replaceBundleText(
    beforeMutation.managedDeck.workingDeckPath,
    '技术分享主标题（占位）：一句话点明本次分享的技术主题',
    '创建页实时修改已经生效',
  );
  await page.waitForFunction(async ({ url, token, revision }) => {
    const current = await fetch(`${url}/api/creation-draft?token=${encodeURIComponent(token)}`)
      .then(response => response.json());
    return current.managedDeck?.revision > revision;
  }, { url:app.url, token:app.token, revision:beforeMutation.managedDeck.revision });
  await page.frameLocator('[data-deck-preview]').frameLocator('#deck-frame')
    .locator('#stage').getByText('创建页实时修改已经生效').waitFor();

  const current = await fetch(
    `${app.url}/api/creation-draft?token=${encodeURIComponent(app.token)}`,
  ).then(response => response.json());
  const published = await creationCommand(app, {
    type:'generation-ready', expectedRevision:current.revision,
    diagnostics:{ summary:'实时初版完成' },
  });
  assert.equal(published.snapshot.phase, 'ready');
  assert.match(
    await (await import('node:fs/promises')).readFile(published.snapshot.generation.publishedDeck, 'utf8'),
    /创建页实时修改已经生效/,
  );

  await page.getByRole('button', { name:/进入微调编辑器/ }).click();
  await page.waitForURL(/\/editor\//);
  await page.frameLocator('#deck-frame').getByText('创建页实时修改已经生效').first().waitFor();
  const handedOffTerminal = await page.evaluate(async () => (
    fetch('/api/agent-terminal').then(response => response.json())
  ));
  assert.equal(handedOffTerminal.runtimeId, 'creation-terminal-layout');
});

test('Creation 发布后的中间画布与微调页复用同一个最终 Editor 运行时', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-published-editor-reuse-'));
  const publishedDeck = join(projectRoot, 'published.html');
  await writeFile(publishedDeck, '<!doctype html><title>最终 Deck</title>');
  const editorServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type':'text/html; charset=utf-8' });
    response.end('<!doctype html><html><body><h1>同一个最终 Editor 运行时</h1></body></html>');
  });
  await new Promise(resolvePromise => editorServer.listen(0, '127.0.0.1', resolvePromise));
  const editorOrigin = `http://127.0.0.1:${editorServer.address().port}`;
  const editorUrl = `${editorOrigin}/editor/?token=final-token&editorToken=final-editor-token`;
  const finalEditor = {
    url:editorOrigin, token:'final-token', editorToken:'final-editor-token',
    session:{ sessionId:'published-editor-session' }, close:async () => {},
  };
  const snapshot = {
    version:1, draftId:'published-editor-reuse', revision:9, phase:'ready', provider:'codex',
    projectRoot, brief:{ title:'统一显示机制' },
    generation:{ status:'published', publishedDeck, fingerprint:'published-v1' },
    milestones:{
      brief:{ complete:true, state:'complete' },
      outline:{ complete:true, state:'complete' },
      pagePlan:{ complete:true, state:'complete' },
      deck:{ complete:true, state:'complete' },
    },
    previewDeck:{
      path:join(projectRoot, '.aico-ppt-editor', 'working', 'deck.html'),
      revision:0, status:'published', managed:true, editorUrl,
    },
  };
  let handoffCount = 0;
  const workspace = {
    capabilityToken:'published-editor-token',
    capabilityPath:join(projectRoot, 'agent-capability.json'),
    draftDir:projectRoot,
    draftId:snapshot.draftId,
    snapshot:() => structuredClone(snapshot),
    previewDeckPath:() => publishedDeck,
    templates:() => ({ version:1, templates:[] }),
    subscribe:() => () => {},
    attachTerminal:async () => {},
    takePublishedEditor:() => { handoffCount += 1; return finalEditor; },
    close:async () => {},
  };
  let unexpectedEditorStarts = 0;
  const app = await startAppServer({
    token:'published-editor-secret',
    pickAgentProjectDirectory:async () => projectRoot,
    createCreationWorkspace:async () => workspace,
    createAgentTerminal:options => new CreationTerminalFixture(options),
    startEditor:async () => {
      unexpectedEditorStarts += 1;
      throw new Error('页面切换不得创建第二个 Editor');
    },
  });
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  const page = await browser.newPage({ viewport:{ width:1440, height:900 } });
  t.after(async () => {
    await browser.close();
    await app.close();
    await new Promise(resolvePromise => editorServer.close(resolvePromise));
    await rm(projectRoot, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  });

  await page.goto(app.appUrl);
  await page.getByRole('button', { name:/从0开始创建一个新的deck，新任务/ }).click();
  await page.getByRole('button', { name:/选择项目目录/ }).click();
  const confirmation = page.locator('[data-confirm-creation-project]');
  if (await confirmation.isVisible()) await confirmation.check();
  await page.getByRole('button', { name:/创建 Draft 并开始对话/ }).click();
  await page.locator('[data-deck-stage]').waitFor({ state:'visible' });
  await page.frameLocator('[data-deck-preview]')
    .getByText('同一个最终 Editor 运行时').waitFor();
  const embeddedOrigin = new URL(await page.locator('[data-deck-preview]').getAttribute('src')).origin;

  await page.getByRole('button', { name:/进入微调编辑器/ }).click();
  await page.waitForURL(/\/editor\//);
  assert.equal(new URL(page.url()).origin, embeddedOrigin);
  assert.equal(handoffCount, 1);
  assert.equal(unexpectedEditorStarts, 0);
});
