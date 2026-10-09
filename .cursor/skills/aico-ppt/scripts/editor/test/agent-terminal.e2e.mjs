import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { openEditor, startFixtureServer } from './test-helpers.mjs';

const terminalExecutable = name => process.platform === 'win32' ? `${name}.cmd` : name;

class FakePty {
  constructor(executable, args, options, pid) {
    this.executable = executable;
    this.args = args;
    this.options = options;
    this.pid = pid;
    this.events = new EventEmitter();
    this.writes = [];
    this.resizes = [];
    this.killed = false;
  }

  onData(listener) { this.events.on('data', listener); return { dispose() {} }; }
  onExit(listener) { this.events.on('exit', listener); return { dispose() {} }; }
  write(data) { this.writes.push(data); }
  resize(cols, rows) { this.resizes.push([cols, rows]); }
  kill() {
    this.killed = true;
    this.events.emit('exit', { exitCode:0, signal:null });
  }
}

async function postApi(app, pathname, body) {
  const response = await fetch(`${app.url}${pathname}?token=${encodeURIComponent(app.token)}`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

async function terminalLayout(page) {
  return page.evaluate(() => {
    const panelNode = document.querySelector('[data-agent-terminal-panel]');
    const hostNode = document.querySelector('[data-agent-terminal-host]');
    const viewportNode = hostNode?.querySelector('.xterm-viewport');
    const screenNode = hostNode?.querySelector('.xterm-screen');
    const panel = panelNode?.getBoundingClientRect();
    const host = hostNode?.getBoundingClientRect();
    const viewport = viewportNode?.getBoundingClientRect();
    const screen = screenNode?.getBoundingClientRect();
    return {
      panelBottom:panel?.bottom ?? 0,
      hostBottom:host?.bottom ?? 0,
      viewportBottom:viewport?.bottom ?? 0,
      screenBottom:screen?.bottom ?? 0,
      visibleRows:screenNode?.querySelectorAll('.xterm-rows > div').length ?? 0,
      scrollGap:viewportNode
        ? viewportNode.scrollHeight - viewportNode.clientHeight - viewportNode.scrollTop
        : Number.POSITIVE_INFINITY,
    };
  });
}

async function assertStableTerminalLayout(page, child, context) {
  await page.waitForTimeout(80);
  const layout = await terminalLayout(page);
  const ptySize = child.resizes.at(-1) ?? [child.options.cols, child.options.rows];
  assert.equal(ptySize[1], layout.visibleRows, `${context} PTY rows 与 xterm rows 不一致：${JSON.stringify({ ptySize, layout })}`);
  assert.ok(layout.hostBottom <= layout.panelBottom + 1, `${context} host 超出抽屉底部：${JSON.stringify(layout)}`);
  assert.ok(layout.viewportBottom <= layout.hostBottom + 1, `${context} viewport 超出 host：${JSON.stringify(layout)}`);
  assert.ok(layout.screenBottom <= layout.hostBottom + 1, `${context} screen 超出 host：${JSON.stringify(layout)}`);
  assert.ok(layout.scrollGap <= 1, `${context} 终端没有保持在输入区末端：${JSON.stringify(layout)}`);
  return layout;
}

test('WSL 初始化回车发出前始终用阶段遮罩覆盖首段终端输出', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  const result = await page.evaluate(async () => {
    const NativeWebSocket = globalThis.WebSocket;
    const sockets = [];
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      constructor() {
        this.readyState = FakeWebSocket.CONNECTING;
        this.listeners = new Map();
        sockets.push(this);
      }
      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }
      send() {}
      close() { this.readyState = 3; }
      emit(type, event = {}) {
        if (type === 'open') this.readyState = FakeWebSocket.OPEN;
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    globalThis.WebSocket = FakeWebSocket;
    const root = document.createElement('aside');
    root.className = 'agent-terminal-panel';
    document.body.append(root);
    const { AgentTerminalPanel } = await import('/editor/agent-terminal-panel.mjs');
    const panel = new AgentTerminalPanel(root, {
      token:'fixture-token', editorToken:'fixture-editor-token',
    });
    panel.open('codex');
    const socket = sockets[0];
    socket.emit('open');
    const loading = root.querySelector('[data-agent-terminal-loading]');
    const snapshot = () => ({
      visible:root.dataset.terminalLoading === 'true' && !loading.hidden,
      copy:loading.textContent,
    });
    const wslState = {
      provider:'codex',
      providerLabel:'Codex（WSL Ubuntu-26.04/root）',
      state:'starting',
      command:'wsl.exe -d Ubuntu-26.04 -u root --exec bash -lic codex',
      promptReady:false,
      startupPromptState:null,
      startupPhase:'wsl-preparing',
      startupPhaseDetail:{ user:'root', distribution:'Ubuntu-26.04' },
    };
    socket.emit('message', { data:JSON.stringify({ type:'state', terminal:wslState }) });
    const beforeOutput = snapshot();
    socket.emit('message', { data:JSON.stringify({ type:'output', data:'[proxy ON] US\r\n' }) });
    const afterOutput = snapshot();
    socket.emit('message', { data:JSON.stringify({
      type:'state',
      terminal:{
        ...wslState,
        state:'running',
        conversationResumed:true,
        initialInputPending:true,
        resumePending:true,
        startupPhase:'history-redraw',
      },
    }) });
    const resuming = snapshot();
    socket.emit('message', { data:JSON.stringify({
      type:'state',
      terminal:{
        ...wslState,
        state:'running',
        conversationResumed:true,
        initialInputPending:true,
        resumePending:true,
        startupPhase:'history-redraw',
        interactionRequired:{
          kind:'codex-update',
          message:'请在右侧终端处理 Codex 更新提示',
        },
      },
    }) });
    const updateInteraction = {
      ...snapshot(),
      detail:root.querySelector('.agent-terminal-detail')?.textContent ?? '',
    };
    socket.emit('message', { data:JSON.stringify({
      type:'state',
      terminal:{
        ...wslState,
        state:'running',
        startupPromptState:'pending',
        startupPhase:'codex-starting',
      },
    }) });
    const pending = snapshot();
    socket.emit('message', { data:JSON.stringify({
      type:'state',
      terminal:{
        ...wslState,
        state:'running',
        promptReady:true,
        startupPromptState:'submitting',
        startupPhase:'ready',
      },
    }) });
    const submitting = snapshot();
    socket.emit('message', { data:JSON.stringify({
      type:'state',
      terminal:{
        ...wslState,
        state:'running',
        promptReady:false,
        startupPromptState:'awaiting-confirmation',
        promptSubmission:{ state:'awaiting-confirmation' },
        startupPhase:'ready',
      },
    }) });
    const awaitingConfirmation = snapshot();
    socket.emit('message', { data:JSON.stringify({
      type:'state',
      terminal:{
        ...wslState,
        state:'running',
        promptReady:true,
        startupPromptState:'submitted',
        startupPhase:'ready',
      },
    }) });
    const submitted = snapshot();
    panel.dispose();
    root.remove();
    globalThis.WebSocket = NativeWebSocket;
    return {
      beforeOutput, afterOutput, resuming, pending,
      updateInteraction, submitting, awaitingConfirmation, submitted,
    };
  });

  assert.equal(result.beforeOutput.visible, true);
  assert.equal(result.afterOutput.visible, true, '代理输出不能在回车前提前露出空终端');
  assert.match(result.afterOutput.copy, /WSL 准备/);
  assert.equal(result.resuming.visible, true);
  assert.match(result.resuming.copy, /历史重绘/);
  assert.equal(result.updateInteraction.visible, false, '升级选择页不能被恢复遮罩挡住');
  assert.match(result.updateInteraction.detail, /处理 Codex 更新提示/);
  assert.equal(result.pending.visible, true);
  assert.match(result.pending.copy, /Codex 启动/);
  assert.equal(result.submitting.visible, true);
  assert.match(result.submitting.copy, /正在提交初始化指令/);
  assert.equal(result.awaitingConfirmation.visible, true);
  assert.match(result.awaitingConfirmation.copy, /正在确认初始化指令已发送/);
  assert.equal(result.submitted.visible, false, 'Agent 确认接收后应显示真实终端');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('bypass Agent 遇到目录信任提示时自动展开右侧终端并等待用户确认', async t => {
  const children = [];
  const app = await startFixtureServer({
    autoStartAgentTerminal:true,
    spawnAgentTerminal:(executable, args, options) => {
      const child = new FakePty(executable, args, options, 4900 + children.length);
      children.push(child);
      queueMicrotask(() => child.events.emit(
        'data',
        'Do you trust the contents of this directory?\r\n› 1. Yes, proceed\r\n  2. No, quit\u001b[?25h',
      ));
      return child;
    },
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  const panel = page.locator('[data-agent-terminal-panel]');
  await panel.waitFor({ state:'visible' });
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-status]')?.dataset.agentStatus === 'attention'
      && document.querySelector('[data-agent-terminal-panel]')?.dataset.interactionRequired
        === 'directory-trust'
  ));
  assert.match(await page.locator('[data-agent-status]').innerText(), /Codex 等待确认/);
  assert.match(await panel.locator('.agent-terminal-detail').innerText(), /确认是否信任/);
  assert.equal(await panel.getAttribute('data-terminal-loading'), 'false', '信任页不能被加载遮罩挡住');
  assert.deepEqual(children[0].writes, [], '显示信任页前不能误投初始化任务');

  await panel.locator('[data-agent-terminal-host]').click();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(40);
  assert.deepEqual(children[0].writes, ['\r']);
  children[0].events.emit('data', '\r\nCodex ready\r\n');
  for (let attempt = 0; attempt < 700
    && (!children[0].writes.some(value => value.includes('AICO-PPT'))
      || children[0].writes.at(-1) !== '\r'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  children[0].events.emit('data', '\r\n• Working\r\n');
  children[0].events.emit('data', '\r\nCodex ready\r\n');
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-status]')?.dataset.agentStatus === 'online'
  ));
  assert.ok(
    children[0].writes.some(value => value.includes('AICO-PPT')),
    '确认信任并进入正常输入框后才应提交初始化任务',
  );
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('Codex 恢复目录选择页自动展开终端、撤掉遮罩并接收键盘选择', async t => {
  const children = [];
  const app = await startFixtureServer({
    autoStartAgentTerminal:true,
    resolveAgentConversation:async () => ({
      conversationId:'codex-resume-directory-e2e',
      resume:true,
      initialPromptConsumed:true,
    }),
    spawnAgentTerminal:(executable, args, options) => {
      const child = new FakePty(executable, args, options, 4950 + children.length);
      children.push(child);
      queueMicrotask(() => child.events.emit(
        'data',
        '\u001b[1;1H\u001b[J'
          + '\u001b[2;1HChoose\u001b[2;8Hworking\u001b[2;16Hdirectory\u001b[2;26Hto'
          + '\u001b[2;29Hresume\u001b[2;36Hthis\u001b[2;41Hsession'
          + '\u001b[4;3HSession = latest cwd recorded in the resumed session'
          + '\u001b[5;3HCurrent = your current working directory'
          + '\u001b[7;1H› 1. Use session directory\u001b[8;6H(/tmp/old-aico-ppt)'
          + '\u001b[9;3H2.\u001b[9;6HUse current directory (/tmp/aico-ppt)'
          + '\u001b[10;3H3.\u001b[10;6HAlways use session directory'
          + '\u001b[11;3H4.\u001b[11;6HAlways use current directory'
          + '\u001b[13;3HPress enter to continue\u001b[?25l',
      ));
      return child;
    },
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  const panel = page.locator('[data-agent-terminal-panel]');
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-status]')?.dataset.agentStatus === 'attention'
      && document.querySelector('[data-agent-terminal-panel]')?.dataset.interactionRequired
        === 'working-directory-selection'
  ));
  assert.equal(await panel.isVisible(), true, '恢复目录选择必须自动展开终端');
  assert.equal(await panel.getAttribute('data-terminal-loading'), 'false', '目录选择不能被恢复遮罩挡住');
  assert.match(await panel.locator('.agent-terminal-detail').innerText(), /选择恢复会话使用的工作目录/);

  await panel.locator('[data-agent-terminal-host]').click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(40);
  assert.deepEqual(children[0].writes, ['\u001b[B', '\r']);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('恢复旧 Codex 会话进入输入框前保持遮罩并拒绝输入与 Agent 任务', async t => {
  const children = [];
  let releaseReady;
  const app = await startFixtureServer({
    autoStartAgentTerminal:true,
    createAgentTerminalConversation:async () => ({
      conversationId:'codex-resuming-gate-e2e',
      resume:true,
      initialPromptConsumed:true,
    }),
    spawnAgentTerminal:(executable, args, options) => {
      const child = new FakePty(executable, args, options, 4870);
      children.push(child);
      releaseReady = () => child.events.emit('data', '\r\ncodex READY\r\n');
      return child;
    },
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  await page.click('[data-agent-status]');
  const panel = page.locator('[data-agent-terminal-panel]');
  const loading = panel.locator('[data-agent-terminal-loading]');
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-terminal-panel]')?.dataset.terminalState === 'running'
  ), null, { timeout:2_000 });
  await loading.waitFor({ state:'visible', timeout:1_000 });
  assert.match(await loading.innerText(), /历史重绘/);

  children[0].events.emit('data', '\r\n仅服务端处理的恢复历史标记\r\n');
  await page.waitForTimeout(80);
  assert.doesNotMatch(
    await panel.locator('[data-agent-terminal-host]').innerText(),
    /仅服务端处理的恢复历史标记/,
    '恢复期间不得把历史 ANSI 增量写入浏览器 xterm',
  );

  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('恢复期间不能进入终端');
  await page.waitForTimeout(80);
  assert.deepEqual(children[0].writes, [], '恢复输入框就绪前不得把用户输入发给 PTY');

  const pageKey = await page.locator('[data-page-key]').first().getAttribute('data-page-key');
  const createdResponse = await fetch(
    `${app.url}/api/tasks?token=${encodeURIComponent(app.token)}`,
    {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        expectedRevision:0,
        pageKey,
        pageIndex:1,
        pageLabel:'01 目录页',
        instruction:'恢复完成后再交给 Agent',
        rect:{ x:80, y:80, w:500, h:160 },
      }),
    },
  );
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201, JSON.stringify(created));
  await page.waitForSelector(`[data-task-row="${created.task.id}"]`);
  assert.equal(await page.locator('[data-process-all]').isDisabled(), true);
  assert.match(
    await page.locator('[data-process-note]').innerText(),
    /正在恢复 Codex 会话|等待 Codex 输入界面/,
  );

  const runResponse = await fetch(
    `${app.url}/api/agent-runs?token=${encodeURIComponent(app.token)}`,
    {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        expectedRevision:created.revision,
        taskIds:[created.task.id],
      }),
    },
  );
  const rejectedRun = await runResponse.json();
  assert.equal(runResponse.status, 409, JSON.stringify(rejectedRun));
  assert.equal(rejectedRun.code, 'AGENT_TERMINAL_RESUMING');

  releaseReady();
  await loading.waitFor({ state:'hidden' });
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-terminal-host]')?.textContent
      ?.includes('仅服务端处理的恢复历史标记')
  ));
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-status]')?.dataset.agentStatus === 'online'
  ));
  assert.equal(await page.locator('[data-process-all]').isDisabled(), false);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('恢复完成后可以输入');
  await page.waitForTimeout(80);
  assert.match(children[0].writes.join(''), /恢复完成后可以输入/);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('Windows 终端的 Ctrl+V 只粘贴一次，选中文字后 Ctrl+C 只复制且不中断 Codex', {
  skip:process.platform !== 'win32',
}, async t => {
  const children = [];
  const app = await startFixtureServer({
    autoStartAgentTerminal:true,
    createAgentTerminalConversation:async provider => ({
      conversationId:`${provider}-clipboard-e2e`,
      resume:false,
      initialPromptConsumed:true,
    }),
    spawnAgentTerminal:(executable, args, options) => {
      const child = new FakePty(executable, args, options, 4950 + children.length);
      children.push(child);
      queueMicrotask(() => child.events.emit('data', '\r\nCodex ready\r\n'));
      return child;
    },
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin:new URL(app.url).origin,
  });
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-status]')?.dataset.agentStatus === 'online'
  ));
  await page.click('[data-agent-status]');
  const host = page.locator('[data-agent-terminal-host]');
  await host.waitFor({ state:'visible' });
  await page.evaluate(() => navigator.clipboard.writeText('只粘贴一次'));
  children[0].writes.length = 0;

  await host.click();
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(80);

  assert.deepEqual(children[0].writes, ['只粘贴一次']);

  children[0].events.emit('data', '\r\nCOPY_SENTINEL_TEXT\r\n');
  await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')]
    .some(row => row.textContent.includes('COPY_SENTINEL_TEXT')));
  const copyPoint = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.xterm-rows > div')]
      .find(candidate => candidate.textContent.includes('COPY_SENTINEL_TEXT'));
    const bounds = row.getBoundingClientRect();
    return { x:bounds.left + 60, y:bounds.top + bounds.height / 2 };
  });
  await page.evaluate(() => navigator.clipboard.writeText('旧剪贴板'));
  await page.mouse.dblclick(copyPoint.x, copyPoint.y);
  children[0].writes.length = 0;
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(80);

  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'COPY_SENTINEL_TEXT');
  assert.doesNotMatch(children[0].writes.join(''), /\u0003/, '复制选区不能向 Codex 发送 Ctrl+C');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('Editor 后台预启动 bypass 终端，右上角负责展开、重连、切换 provider 和新会话', async t => {
  const children = [];
  const createdPrompts = [];
  let conversations = 0;
  let releaseFreshOutput;
  let releaseFreshIdentity;
  const app = await startFixtureServer({
    autoStartAgentTerminal:true,
    createAgentTerminalConversation:async (provider, options) => {
      conversations += 1;
      createdPrompts.push(options.initialPrompt);
      if (provider === 'codex' && conversations === 2) {
        return {
          conversationId:null,
          resume:false,
          initialPromptConsumed:false,
          discoveryToken:'019ff4b7-0622-7272-b0e2-394f6316b52a',
        };
      }
      return {
        conversationId:`${provider}-terminal-e2e-${conversations}`,
        resume:provider === 'codex',
        initialPromptConsumed:provider === 'codex',
      };
    },
    discoverAgentTerminalConversation:async () => new Promise(resolve => {
      releaseFreshIdentity = () => resolve('codex-terminal-e2e-2');
    }),
    spawnAgentTerminal:(executable, args, options) => {
      const child = new FakePty(executable, args, options, 5000 + children.length);
      children.push(child);
      if (children.length === 2) {
        releaseFreshOutput = () => child.events.emit('data', '\r\ncodex READY\r\n');
        const write = child.write.bind(child);
        child.write = data => {
          write(data);
          if (data !== '\r') return;
          queueMicrotask(() => {
            child.events.emit('data', '\r\n• Working\r\n');
            queueMicrotask(() => child.events.emit('data', '\r\ncodex READY\r\n'));
          });
        };
      } else {
        queueMicrotask(() => child.events.emit('data', '\r\ncodex READY\r\n'));
      }
      return child;
    },
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  await page.waitForFunction(() => (
    document.querySelector('[data-agent-status]')?.dataset.agentStatus === 'online'
  ));
  assert.equal(children.length, 1, '打开抽屉前就应创建默认 Agent 会话');

  await page.click('[data-mode="edit"]');
  const initialTaskInset = await page.locator('[data-task-drawer]').evaluate(node => (
    window.innerWidth - node.getBoundingClientRect().right
  ));
  await page.click('[data-agent-status]');
  const panel = page.locator('[data-agent-terminal-panel]');
  await panel.waitFor({ state:'visible' });
  await page.waitForTimeout(260);
  await page.waitForFunction(() => {
    const terminal = document.querySelector('[data-agent-terminal-panel]')?.getBoundingClientRect();
    const inspector = document.querySelector('.inspector-panel')?.getBoundingClientRect();
    const canvas = document.querySelector('.canvas-column')?.getBoundingClientRect();
    const pages = document.querySelector('.page-panel')?.getBoundingClientRect();
    const tasks = document.querySelector('[data-task-drawer]')?.getBoundingClientRect();
    return terminal && inspector && canvas && pages && tasks
      && Math.abs(inspector.left - canvas.left) <= 1
      && canvas.top - inspector.bottom >= 7
      && terminal.left - inspector.right >= 7
      && Math.abs(terminal.top - pages.top) <= 1
      && Math.abs(terminal.bottom - pages.bottom) <= 1
      && terminal.left - tasks.right >= 7;
  });
  await page.waitForFunction(initialInset => {
    const tasks = document.querySelector('[data-task-drawer]')?.getBoundingClientRect();
    return tasks && window.innerWidth - tasks.right > initialInset + 200;
  }, initialTaskInset);
  const geometry = await page.evaluate(() => {
    const terminal = document.querySelector('[data-agent-terminal-panel]').getBoundingClientRect();
    const inspector = document.querySelector('.inspector-panel').getBoundingClientRect();
    const canvas = document.querySelector('.canvas-column').getBoundingClientRect();
    const pages = document.querySelector('.page-panel').getBoundingClientRect();
    const tasks = document.querySelector('[data-task-drawer]').getBoundingClientRect();
    return {
      terminal:{ x:terminal.x, y:terminal.y, width:terminal.width, height:terminal.height },
      inspector:{ x:inspector.x, y:inspector.y, width:inspector.width, height:inspector.height },
      canvas:{ x:canvas.x, y:canvas.y, width:canvas.width, height:canvas.height },
      pages:{ x:pages.x, y:pages.y, width:pages.width, height:pages.height },
      taskInset:window.innerWidth - tasks.right,
    };
  });
  assert.ok(Math.abs(geometry.inspector.x - geometry.canvas.x) <= 1, JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.inspector.width - geometry.canvas.width) <= 1, JSON.stringify(geometry));
  assert.ok(geometry.canvas.y - (geometry.inspector.y + geometry.inspector.height) >= 7,
    JSON.stringify(geometry));
  assert.ok(geometry.terminal.x - (geometry.inspector.x + geometry.inspector.width) >= 7,
    JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.terminal.y - geometry.pages.y) <= 1, JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.terminal.height - geometry.pages.height) <= 1, JSON.stringify(geometry));
  assert.ok(geometry.taskInset > initialTaskInset + 200, JSON.stringify(geometry));
  assert.equal(await panel.evaluate(node => getComputedStyle(node).animationName), 'agent-drawer-in');
  await page.waitForFunction(() => (
    /codex(?:\.cmd)? READY/.test(
      document.querySelector('[data-agent-terminal-host]')?.textContent ?? '',
    )
  ));
  await assertStableTerminalLayout(page, children[0], '首次打开且尚未拖动宽度');

  const canvasWidthBeforeResize = await page.locator('.canvas-column').evaluate(
    node => node.getBoundingClientRect().width,
  );
  const resizerBox = await panel.locator('[data-agent-terminal-resizer]').boundingBox();
  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizerBox.x - 120, resizerBox.y + resizerBox.height / 2, { steps:8 });
  await page.mouse.up();
  await page.waitForFunction(previousWidth => (
    document.querySelector('[data-agent-terminal-panel]')?.getBoundingClientRect().width
      >= previousWidth + 100
  ), geometry.terminal.width);
  await page.waitForFunction(() => {
    const terminal = document.querySelector('[data-agent-terminal-panel]')?.getBoundingClientRect();
    const tasks = document.querySelector('[data-task-drawer]')?.getBoundingClientRect();
    return terminal && tasks && window.innerWidth - tasks.right >= terminal.width;
  });
  const resizedGeometry = await page.evaluate(() => ({
    terminalWidth:document.querySelector('[data-agent-terminal-panel]').getBoundingClientRect().width,
    canvasWidth:document.querySelector('.canvas-column').getBoundingClientRect().width,
    taskInset:window.innerWidth
      - document.querySelector('[data-task-drawer]').getBoundingClientRect().right,
  }));
  assert.ok(resizedGeometry.terminalWidth >= geometry.terminal.width + 100, JSON.stringify(resizedGeometry));
  assert.ok(resizedGeometry.canvasWidth <= canvasWidthBeforeResize - 100, JSON.stringify(resizedGeometry));
  assert.ok(resizedGeometry.taskInset >= resizedGeometry.terminalWidth, JSON.stringify(resizedGeometry));

  await page.waitForFunction(() => (
    document.querySelector('[data-agent-terminal-panel]')?.dataset.terminalState === 'running'
  ));
  assert.equal(children.length, 1);
  assert.equal(children[0].executable, terminalExecutable('codex'));
  assert.deepEqual(children[0].args.slice(0, 3), [
    'resume', '--dangerously-bypass-approvals-and-sandbox', 'codex-terminal-e2e-1',
  ]);
  assert.equal(children[0].args.length, 3);
  assert.match(createdPrompts[0], /aico-ppt/);
  assert.equal(children[0].options.cwd, app.agentTerminal.cwd);
  assert.equal(app.agentTerminal.projectRoot, app.agentWorkspace.snapshot().projectRoot);
  assert.equal(await panel.locator('[data-agent-chat-input], .agent-chat-tabs, .agent-chat-composer').count(), 0);
  assert.equal(await panel.locator('[data-agent-terminal-provider] option').count(), 3);
  assert.equal(await panel.locator('[data-agent-terminal-provider] option[value="opencode"]').count(), 1);
  await page.waitForFunction(() => (
    /codex(?:\.cmd)? READY/.test(
      document.querySelector('[data-agent-terminal-host]')?.textContent ?? '',
    )
  ));
  const terminalBottomGeometry = await page.evaluate(() => {
    const hostNode = document.querySelector('[data-agent-terminal-host]');
    const screenNode = hostNode.querySelector('.xterm-screen');
    const host = hostNode.getBoundingClientRect();
    const screen = screenNode.getBoundingClientRect();
    const rowCount = screenNode.querySelectorAll('.xterm-rows > div').length;
    const hostStyle = getComputedStyle(hostNode);
    return {
      hostTop:host.top,
      hostBottom:host.bottom,
      hostHeight:host.height,
      hostClientHeight:hostNode.clientHeight,
      paddingTop:Number.parseFloat(hostStyle.paddingTop),
      paddingBottom:Number.parseFloat(hostStyle.paddingBottom),
      screenTop:screen.top,
      screenBottom:screen.bottom,
      bottomInset:host.bottom - screen.bottom,
      screenHeight:screen.height,
      rowCount,
      rowHeight:rowCount ? screen.height / rowCount : 0,
    };
  });
  assert.ok(
    terminalBottomGeometry.paddingBottom >= 10
      && terminalBottomGeometry.bottomInset + .5 >= terminalBottomGeometry.paddingBottom,
    `Codex 输入区必须完整位于终端底部安全区上方：${JSON.stringify(terminalBottomGeometry)}`,
  );
  await assertStableTerminalLayout(page, children[0], '首次打开');
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await panel.locator('.agent-terminal-close').click();
    await panel.waitFor({ state:'hidden' });
    await page.click('[data-agent-status]');
    await panel.waitFor({ state:'visible' });
    await assertStableTerminalLayout(page, children[0], `第 ${cycle} 次重开`);
  }
  if (process.env.AGENT_TERMINAL_SCREENSHOT) {
    await page.screenshot({ path:process.env.AGENT_TERMINAL_SCREENSHOT, fullPage:true });
  }

  await panel.locator('[data-agent-terminal-host]').click();
  await page.keyboard.type('hello');
  await page.waitForTimeout(100);
  assert.match(children[0].writes.join(''), /hello/);

  await panel.locator('[data-agent-terminal-command="new-session"]').click();
  await panel.locator('[data-agent-terminal-loading]').waitFor({ state:'visible' });
  assert.match(
    await panel.locator('[data-agent-terminal-loading]').innerText(),
    /正在创建会话并读取项目规则/,
  );
  assert.notEqual(
    await panel.locator('.agent-terminal-loading-spinner').evaluate(
      node => getComputedStyle(node).animationName,
    ),
    'none',
  );
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-terminal-panel]')?.dataset.terminalState === 'running'
  ));
  assert.equal(children.length, 2, '新 PTY 必须在会话 ID 发现前立即启动');
  assert.equal(await panel.getAttribute('data-conversation-id'), '');
  releaseFreshOutput();
  for (let attempt = 0; attempt < 700 && children[1].writes.at(-1) !== '\r'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(children[1].writes.at(-1), '\r', '新会话初始指令必须完成自动回车');
  await panel.locator('[data-agent-terminal-loading]').waitFor({ state:'hidden' });
  await page.waitForFunction(() => (
    /codex(?:\.cmd)? READY/.test(
      document.querySelector('[data-agent-terminal-host]')?.textContent ?? '',
    )
  ));
  assert.match(
    await panel.locator('[data-agent-terminal-host]').textContent(),
    /codex(?:\.cmd)? READY/,
  );
  while (!releaseFreshIdentity) await page.waitForTimeout(10);
  releaseFreshIdentity();
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-terminal-panel]')?.dataset.conversationId
      === 'codex-terminal-e2e-2'
  ));
  assert.equal(children.length, 2);
  assert.equal(children[0].killed, true);
  assert.equal(children[1].executable, terminalExecutable('codex'));
  assert.deepEqual(children[1].args.slice(0, 1), [
    '--dangerously-bypass-approvals-and-sandbox',
  ]);
  assert.match(children[1].writes[0], /019ff4b7-0622-7272-b0e2-394f6316b52a/);
  assert.match(children[1].writes[0], /aico-ppt/);
  assert.equal(children[1].writes.at(-1), '\r');
  assert.equal(
    await panel.getAttribute('data-conversation-id'),
    'codex-terminal-e2e-2',
  );
  assert.equal(
    app.agentWorkspace.snapshot().providers.codex.activeConversationId,
    'codex-terminal-e2e-2',
  );

  await page.reload();
  await page.waitForSelector('[data-page-key]');
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-status]')?.dataset.agentStatus === 'online'
      && document.querySelector('[data-agent-label]')?.textContent.includes('Codex')
  ));
  await page.click('[data-agent-status]');
  await page.waitForFunction(() => (
    /codex(?:\.cmd)? READY/.test(
      document.querySelector('[data-agent-terminal-host]')?.textContent ?? '',
    )
  ));
  assert.ok(Math.abs(
    await panel.evaluate(node => node.getBoundingClientRect().width)
      - resizedGeometry.terminalWidth,
  ) <= 1, '拖动后的终端宽度必须在刷新后恢复');
  assert.equal(children.length, 2, '浏览器刷新必须重连刚创建的新 PTY 会话');

  await panel.getByRole('combobox', { name:'选择终端 Agent' }).click();
  await page.getByRole('option', { name:'Claude Code' }).click();
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-terminal-panel]')?.dataset.terminalState === 'running'
      && document.querySelector('[data-agent-terminal-provider]')?.value === 'claude-code'
  ));
  assert.equal(
    children.length,
    3,
    JSON.stringify(children.map(child => ({
      executable:child.executable,
      args:child.args,
      killed:child.killed,
    }))),
  );
  assert.equal(children[1].killed, true);
  assert.equal(children[2].executable, terminalExecutable('claude'));
  assert.deepEqual(children[2].args.slice(0, 3), [
    '--dangerously-skip-permissions', '--session-id', 'claude-code-terminal-e2e-3',
  ]);
  assert.match(
    await panel.locator('.agent-terminal-commandbar').innerText(),
    /claude(?:\.cmd)? --dangerously-skip-permissions/,
  );
  await assertStableTerminalLayout(page, children[2], '切换 provider 后');

  const previousConversationId = await panel.getAttribute('data-conversation-id');
  await panel.locator('[data-agent-terminal-command="new-session"]').click();
  await page.waitForFunction(previous => {
    const terminal = document.querySelector('[data-agent-terminal-panel]');
    return terminal?.dataset.terminalState === 'running'
      && terminal.dataset.conversationId !== previous;
  }, previousConversationId);
  assert.equal(children.length, 4);
  assert.equal(children[2].killed, true);
  assert.equal(children[3].executable, terminalExecutable('claude'));
  assert.deepEqual(children[3].args.slice(0, 3), [
    '--dangerously-skip-permissions', '--session-id', 'claude-code-terminal-e2e-4',
  ]);
  await assertStableTerminalLayout(page, children[3], '新会话启动后');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('任务批次进入同一 bypass PTY，权威 action 完成后退出 pending', async t => {
  const children = [];
  const app = await startFixtureServer({
    agentRunTimeoutMs:5_000,
    createAgentTerminalConversation:async provider => ({
      conversationId:`${provider}-task-e2e`,
      resume:provider === 'codex',
    }),
    spawnAgentTerminal:(executable, args, options) => {
      const child = new FakePty(executable, args, options, 6000 + children.length);
      child.write = data => {
        child.writes.push(data);
        if (data === '\r') queueMicrotask(() => {
          child.events.emit('data', '\u001b[?25l\u001b[2K• Working');
          setTimeout(() => child.events.emit('data', '\r\ncodex READY\r\n'), 300);
        });
      };
      children.push(child);
      queueMicrotask(() => child.events.emit(
        'data',
        '\r\ncodex READY\r\n'
          + '\u001b[11;1H\u001b[1m›\u001b[11;3H\u001b[?25h\u001b[11;3H\u001b[?2026l',
      ));
      return child;
    },
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  const pageKey = await page.locator('[data-page-key]').first().getAttribute('data-page-key');
  const createdResponse = await fetch(
    `${app.url}/api/tasks?token=${encodeURIComponent(app.token)}`,
    {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        expectedRevision:0,
        pageKey,
        pageIndex:1,
        pageLabel:'01 目录页',
        instruction:'把第一页标题向右移动 24px',
        rect:{ x:80, y:80, w:500, h:160 },
      }),
    },
  );
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201, JSON.stringify(created));
  await page.waitForSelector('[data-task-row]');
  const target = await page.frameLocator('#deck-frame').locator('h2').first().evaluate(
    element => window.HuaweiDeckPatchRuntime.makeLocator(element),
  );

  await page.locator('[data-process-all]').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-process-note]')?.textContent.includes('终端')
  ));
  await page.waitForFunction(() => document.querySelector('[data-agent-status]')?.dataset.agentStatus === 'busy');
  await page.waitForFunction(() => document.querySelector('[data-agent-terminal-panel]')
    ?.dataset.terminalState === 'running');
  assert.equal(children.length, 1);
  assert.equal(children[0].executable, terminalExecutable('codex'));
  assert.deepEqual(children[0].args.slice(0, 3), [
    'resume', '--dangerously-bypass-approvals-and-sandbox', 'codex-task-e2e',
  ]);
  for (let attempt = 0; attempt < 800
    && !children[0].writes.some(value => value.includes(created.task.id)); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const startupPrompt = children[0].writes.find(value => value.includes(created.task.id));
  assert.match(startupPrompt, new RegExp(created.task.id));
  assert.match(startupPrompt, /aico-ppt/);

  const capturedRunResponse = await fetch(
    `${app.url}/api/agent-runs/current?token=${encodeURIComponent(app.token)}`,
  );
  const capturedRun = await capturedRunResponse.json();
  assert.ok(Number.isSafeInteger(capturedRun.sessionRevision), JSON.stringify(capturedRun));

  await postApi(app, '/api/actions', {
    expectedRevision:capturedRun.sessionRevision,
    taskId:created.task.id,
    actions:[{
      id:'terminal-agent-move',
      taskId:created.task.id,
      target,
      kind:'translate',
      payload:{ x:24, y:0 },
    }],
  });
  let run;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(
      `${app.url}/api/agent-runs/current?token=${encodeURIComponent(app.token)}`,
    );
    run = await response.json();
    if (!['queued', 'running'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(run.status, 'succeeded', JSON.stringify(run));
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-status]')?.dataset.agentStatus === 'online'
  ));
  assert.match(await page.locator('[data-process-note]').innerText(), /完成本批处理/);
  assert.equal(await page.locator('[data-task-row]').filter({ has:page.locator('.task-status-completed') }).count(), 1);
  assert.equal(children.length, 1, '任务完成前后必须复用同一个 PTY');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});
