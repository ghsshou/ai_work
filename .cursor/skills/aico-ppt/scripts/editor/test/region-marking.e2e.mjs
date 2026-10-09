import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startFixtureServer, openEditor, dragInFrame } from './test-helpers.mjs';

function inertAgentPty() {
  return {
    pid:4321,
    onData() { return { dispose() {} }; },
    onExit() { return { dispose() {} }; },
    write() {}, resize() {}, kill() {},
  };
}

test('鼠标位于 Deck 时 R 快捷键优先于仍持有焦点的 Agent 终端', async t => {
  const terminalWrites = [];
  let terminalOutput;
  const app = await startFixtureServer({
    spawnAgentTerminal:() => ({
      pid:4322,
      onData(listener) {
        terminalOutput = listener;
        queueMicrotask(() => listener('\r\ncodex READY\r\n'));
        return { dispose() {} };
      },
      onExit() { return { dispose() {} }; },
      write(data) {
        terminalWrites.push(data);
        if (data === '\r') queueMicrotask(() => terminalOutput?.('• Working'));
      },
      resize() {}, kill() {},
    }),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(8_000);
  const frame = page.frameLocator('#deck-frame');

  await page.locator('[data-mode="region"]').click();
  await page.locator('[data-agent-status]').click();
  await page.locator('[data-agent-terminal-panel]').waitFor({ state:'visible' });
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-terminal-panel]')?.dataset.terminalState === 'running'
  ));
  const terminalHost = page.locator('[data-agent-terminal-host]');
  const terminalInput = page.locator('[data-agent-terminal-host] .xterm-helper-textarea');
  await page.waitForTimeout(260);
  await terminalHost.click();
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));

  await frame.locator('h2').first().hover();
  const writesBeforeShortcut = terminalWrites.join('');
  await page.keyboard.down('r');
  await page.waitForFunction(() => (
    document.querySelector('.mode-tools')?.dataset.temporaryMode === 'preview'
      && document.querySelector('.mode-tools')?.dataset.activeMode === 'preview'
      && document.querySelector('#deck-frame')?.contentDocument?.documentElement
        ?.dataset.deckEditorMode === 'preview'
  ));
  assert.equal(await frame.locator('html').getAttribute('data-deck-editor-mode'), 'preview');
  await page.waitForTimeout(100);
  assert.equal(terminalWrites.join(''), writesBeforeShortcut);

  await page.keyboard.up('r');
  await page.waitForFunction(() => (
    !document.querySelector('.mode-tools')?.dataset.temporaryMode
      && document.querySelector('.mode-tools')?.dataset.activeMode === 'region'
      && document.querySelector('#deck-frame')?.contentDocument?.documentElement
        ?.dataset.deckEditorMode === 'region'
  ));
  assert.equal(await frame.locator('html').getAttribute('data-deck-editor-mode'), 'region');

  await terminalHost.click();
  const writesBeforeTerminalInput = terminalWrites.join('');
  await page.keyboard.down('r');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.mode-tools').getAttribute('data-temporary-mode'), null);
  assert.equal(terminalWrites.join(''), `${writesBeforeTerminalInput}r`);
  await page.keyboard.up('r');
  assert.equal(await page.locator('.mode-tools').getAttribute('data-active-mode'), 'region');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('中文输入法组合态下物理 R 键仍可从 Agent 终端临时切换模式', async t => {
  const terminalWrites = [];
  const app = await startFixtureServer({
    spawnAgentTerminal:() => ({
      pid:4323,
      onData(listener) {
        queueMicrotask(() => listener('\r\ncodex READY\r\n'));
        return { dispose() {} };
      },
      onExit() { return { dispose() {} }; },
      write(data) { terminalWrites.push(data); },
      resize() {}, kill() {},
    }),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(8_000);
  const frame = page.frameLocator('#deck-frame');

  await page.locator('[data-mode="edit"]').click();
  await page.locator('[data-agent-status]').click();
  await page.locator('[data-agent-terminal-panel]').waitFor({ state:'visible' });
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-terminal-panel]')?.dataset.terminalState === 'running'
  ));
  const terminalHost = page.locator('[data-agent-terminal-host]');
  const terminalInput = page.locator('[data-agent-terminal-host] .xterm-helper-textarea');
  await page.waitForTimeout(260);
  await terminalHost.hover();
  await terminalInput.focus();
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
  await frame.locator('h2').first().hover();

  const writesBeforeShortcut = terminalWrites.join('');
  await page.evaluate(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
      key:'Process', code:'KeyR', isComposing:true, bubbles:true, cancelable:true,
    }));
  });
  await page.waitForFunction(() => (
    document.querySelector('.mode-tools')?.dataset.temporaryMode === 'region'
      && document.querySelector('#deck-frame')?.contentDocument?.documentElement
        ?.dataset.deckEditorMode === 'region'
  ));
  assert.equal(terminalWrites.join(''), writesBeforeShortcut);

  await page.evaluate(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keyup', {
      key:'Process', code:'KeyR', isComposing:true, bubbles:true, cancelable:true,
    }));
  });
  await page.waitForFunction(() => (
    !document.querySelector('.mode-tools')?.dataset.temporaryMode
      && document.querySelector('#deck-frame')?.contentDocument?.documentElement
        ?.dataset.deckEditorMode === 'edit'
  ));
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('编辑模式按住 R 临时拉框，松开后返回编辑并保留标注输入框', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(8_000);
  const frame = page.frameLocator('#deck-frame');

  await page.click('[data-mode="edit"]');
  await page.keyboard.down('r');
  await page.waitForFunction(() => (
    document.querySelector('.mode-tools')?.dataset.temporaryMode === 'region'
    && document.querySelector('.mode-tools')?.dataset.activeMode === 'region'
  ));
  assert.equal(await frame.locator('html').getAttribute('data-deck-editor-mode'), 'region');
  await page.waitForTimeout(100);

  await dragInFrame(page, { x:100, y:100 }, { x:320, y:240 });
  await frame.locator('[data-region-popover]').waitFor({ state:'visible' });
  await page.keyboard.up('r');
  await page.waitForFunction(() => (
    !document.querySelector('.mode-tools')?.dataset.temporaryMode
    && document.querySelector('.mode-tools')?.dataset.activeMode === 'edit'
  ));
  assert.equal(await frame.locator('html').getAttribute('data-deck-editor-mode'), 'edit');
  await frame.locator('[data-region-popover]').waitFor({ state:'visible' });

  const textarea = frame.locator('[data-region-popover] textarea');
  await textarea.press('r');
  assert.equal(await textarea.inputValue(), 'r');
  assert.equal(await page.locator('.mode-tools').getAttribute('data-active-mode'), 'edit');
  await textarea.press('Escape');

  const heading = frame.locator('h2').first();
  await heading.dblclick();
  await heading.press('r');
  assert.match(await heading.textContent(), /r/);
  assert.equal(await page.locator('.mode-tools').getAttribute('data-active-mode'), 'edit');
  await heading.press('Escape');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('区域标记模式按住 R 临时预览，松开后恢复且模式按钮没有红色焦点框', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(8_000);
  const frame = page.frameLocator('#deck-frame');

  await page.locator('[data-mode="region"]').click();
  await page.keyboard.down('r');
  await page.waitForFunction(() => (
    document.querySelector('.mode-tools')?.dataset.temporaryMode === 'preview'
    && document.querySelector('.mode-tools')?.dataset.activeMode === 'preview'
    && document.querySelector('#deck-frame')?.contentDocument?.documentElement
      ?.dataset.deckEditorMode === 'preview'
  ));
  assert.equal(await frame.locator('html').getAttribute('data-deck-editor-mode'), 'preview');
  assert.equal(await page.locator('[data-mode="region"]').evaluate(button => (
    getComputedStyle(button).outlineStyle
  )), 'none');

  await page.keyboard.up('r');
  await page.waitForFunction(() => (
    !document.querySelector('.mode-tools')?.dataset.temporaryMode
    && document.querySelector('.mode-tools')?.dataset.activeMode === 'region'
    && document.querySelector('#deck-frame')?.contentDocument?.documentElement
      ?.dataset.deckEditorMode === 'region'
  ));
  assert.equal(await frame.locator('html').getAttribute('data-deck-editor-mode'), 'region');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('区域标记悬停小手时提示按 R 点击，临时预览后隐藏', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture.replace(
      '<h2>第一页标题</h2>',
      `<h2>第一页标题</h2>
        <button data-pointer-hint-test type="button"
          style="position:absolute;left:460px;top:280px;cursor:pointer">交互按钮</button>`,
    ),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(8_000);
  const frame = page.frameLocator('#deck-frame');

  await page.locator('[data-mode="region"]').click();
  await frame.locator('[data-pointer-hint-test]').hover();
  await frame.locator('[data-region-click-hint][data-visible]').waitFor({ state:'visible' });
  assert.equal(
    (await frame.locator('[data-region-click-hint]').textContent()).replace(/\s+/g, ''),
    '按R键，即可点击',
  );

  await page.keyboard.down('r');
  await frame.locator('[data-region-click-hint]').waitFor({ state:'detached' });
  await page.keyboard.up('r');
  await frame.locator('h2').first().hover();
  assert.equal(await frame.locator('[data-region-click-hint]').count(), 0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('同页 layer 画面分别写入任务状态，定位任务时恢复对应画面', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture
      .replace('<h2>第一页标题</h2>', `<h2>第一页标题</h2>
        <div data-test-layers style="position:absolute;left:120px;top:260px">
          <button data-layer-btn="capacity" data-layer-group="test-state" data-active>容量</button>
          <button data-layer-btn="performance" data-layer-group="test-state">性能</button>
          <div data-layer-panel="capacity" data-layer-group="test-state" data-active>容量画面</div>
          <div data-layer-panel="performance" data-layer-group="test-state">性能画面</div>
        </div>`)
      .replace('</body>', `<script>
        document.querySelector('[data-test-layers]').addEventListener('click', event => {
          const button = event.target.closest('[data-layer-btn]');
          if (!button) return;
          const key = button.dataset.layerBtn;
          document.querySelectorAll('[data-layer-btn]').forEach(node => {
            node.toggleAttribute('data-active', node.dataset.layerBtn === key);
          });
          document.querySelectorAll('[data-layer-panel]').forEach(node => {
            node.toggleAttribute('data-active', node.dataset.layerPanel === key);
          });
        });
      </script></body>`),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const frame = page.frameLocator('#deck-frame');
  const mark = async (instruction, count) => {
    await page.locator('[data-mode="region"]').click();
    await dragInFrame(page, { x:160, y:380 }, { x:420, y:560 });
    await frame.locator('[data-region-popover] textarea').fill(instruction);
    await frame.locator('[data-region-submit]').click();
    await page.waitForFunction(expected => (
      document.querySelectorAll('[data-task-row]').length === expected
      || document.querySelector('#deck-frame')?.contentDocument
        .querySelector('[data-region-status][data-state="error"]')
    ), count);
    assert.equal(
      await page.locator('[data-task-row]').count(),
      count,
      await frame.locator('[data-region-status]').textContent().catch(() => '任务未创建'),
    );
  };

  await mark('容量状态任务', 1);
  await page.locator('[data-mode="preview"]').click();
  await frame.locator('[data-layer-btn="performance"]').click();
  assert.equal(await frame.locator('[data-layer-btn="performance"]').getAttribute('data-active'), '');
  await mark('性能状态任务', 2);

  const tasks = await fetch(`${app.url}/api/tasks?token=${app.token}`).then(response => response.json());
  assert.ok(tasks.every(task => task.pageState?.schema === 1), JSON.stringify(tasks));
  assert.notDeepEqual(tasks[0].pageState, tasks[1].pageState);

  if (await page.locator('[data-task-drawer]').getAttribute('data-open') !== 'true') {
    await page.locator('[data-task-drawer-toggle]').click();
  }
  await page.locator('[data-task-row]').filter({ hasText:'容量状态任务' })
    .locator('[data-task-locate]').click();
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument
      .querySelector('[data-layer-btn="capacity"]')?.hasAttribute('data-active') === true
  ));

  if (await page.locator('[data-task-drawer]').getAttribute('data-open') !== 'true') {
    await page.locator('[data-task-drawer-toggle]').click();
  }
  await page.locator('[data-task-row]').filter({ hasText:'性能状态任务' })
    .locator('[data-task-locate]').click();
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument
      .querySelector('[data-layer-btn="performance"]')?.hasAttribute('data-active') === true
  ));
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('Agent 终端不加载历史会话目录或高级设置', async t => {
  const app = await startFixtureServer({
    spawnAgentTerminal:inertAgentPty,
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  await page.click('[data-agent-status]');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-agent-chat-advanced]').count(), 0);
  assert.equal(await page.locator('[data-agent-connection-panel]').count(), 0);
  assert.equal(await page.locator('[data-agent-terminal-panel]').isVisible(), true);
  assert.equal(await page.locator('[data-agent-chat-input], .agent-chat-tabs').count(), 0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('已移除的历史会话面板不再出现在默认页面', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  assert.equal(await page.locator('[data-agent-connection-panel]').count(), 0);
  assert.equal(await page.locator('[data-agent-chat-advanced]').count(), 0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('Editor 不提供历史会话绑定、外部会话跳转或对话输入入口', async t => {
  const app = await startFixtureServer({ spawnAgentTerminal:inertAgentPty });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  await page.click('[data-agent-status]');
  assert.equal(await page.locator('[data-agent-connection-panel]').count(), 0);
  assert.equal(await page.locator('[data-agent-chat-advanced]').count(), 0);
  assert.equal(await page.locator('[data-agent-open-thread], .task-open-thread').count(), 0);
  assert.equal(await page.locator('[data-agent-chat-input], .agent-chat-tabs').count(), 0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('拉框弹输入框并跨页持久化两条任务', async t => {
  let submittedTaskIds = [];
  const app = await startFixtureServer({
    agentRunAdapter:{
      id:'codex',
      async run({ taskIds }) {
        submittedTaskIds = taskIds;
        return { summary:'Agent 已完成测试批次' };
      },
    },
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  const frame = page.frameLocator('#deck-frame');

  await page.locator('#deck-frame').evaluate(frameElement => {
    const section = frameElement.contentDocument.querySelector('section[data-label]');
    for (let index = 0; index < 20; index += 1) {
      const candidate = frameElement.contentDocument.createElement('span');
      candidate.className = `candidate-${index}`;
      candidate.textContent = `候选 ${index}`;
      Object.assign(candidate.style, {
        position: 'absolute', left: `${300 + index}px`, top: `${300 + index}px`,
        display: 'block', width: '100px', height: '40px',
      });
      section.append(candidate);
    }
  });

  await page.click('[data-mode="region"]');
  await dragInFrame(page, { x: 100, y: 100 }, { x: 400, y: 300 });
  await frame.locator('[data-region-popover] textarea').fill('第一页修改');
  await frame.locator('[data-region-submit]').evaluate(button => {
    button.click();
    button.click();
  });
  await page.waitForSelector('[data-task-row]');
  assert.equal(await page.locator('[data-task-row]').count(), 1, '重复提交不得创建重复任务');

  await page.click('[data-page-index="2"]');
  await dragInFrame(page, { x: 180, y: 110 }, { x: 480, y: 300 });
  await frame.locator('[data-region-popover] textarea').fill('第二页修改');
  await frame.locator('[data-region-submit]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 2);

  assert.equal(await page.locator('[data-task-row]').count(), 2);
  assert.deepEqual(await page.locator('[data-page-badge]').allTextContents(), ['1', '1']);
  const persistedTasks = await fetch(`${app.url}/api/tasks?token=${app.token}`).then(response => response.json());
  assert.equal(persistedTasks.length, 2);
  assert.equal(persistedTasks[0].candidates.length, 12, '相交候选必须截断到 12 个');
  for (const task of persistedTasks) {
    assert.ok(task.candidates.length <= 12);
    assert.ok(task.rect.x >= 0 && task.rect.y >= 0);
    assert.ok(task.rect.w > 0 && task.rect.h > 0);
    assert.ok(task.rect.x + task.rect.w <= 1920);
    assert.ok(task.rect.y + task.rect.h <= 1080);
    assert.equal(task.snapshot, undefined);
  }
  const snapshotNames = await readdir(join(app.sessionDir, 'snapshots'));
  assert.equal(snapshotNames.filter(name => name.endsWith('.png')).length, 2);
  for (const name of snapshotNames) {
    const bytes = await readFile(join(app.sessionDir, 'snapshots', name));
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }

  await page.reload();
  await page.waitForFunction(() => (
    document.querySelectorAll('[data-task-row]').length === 2
    && document.querySelectorAll('[data-page-badge]').length === 2
  ));
  assert.equal(await page.locator('[data-task-row]').count(), 2);
  assert.deepEqual(await page.locator('[data-page-badge]').allTextContents(), ['1', '1']);

  await page.locator('[data-task-locate]').last().click();
  await page.waitForFunction(() => document.querySelector('[data-current-page]')?.textContent === '02 目录页');
  await frame.locator('[data-task-highlight]').waitFor({ state: 'visible' });
  await page.waitForTimeout(1_100);
  assert.equal(await frame.locator('[data-task-highlight]').count(), 1);
  await frame.locator('[data-task-highlight]').waitFor({ state: 'detached', timeout: 1_200 });
  assert.equal(
    await page.locator('[data-process-all] .pill-nav-label-default').innerText(),
    '交给 Agent 处理下一批 2 条',
  );
  await page.locator('[data-process-all]').click();
  await page.waitForFunction(() => (
    document.querySelector('.editor-shell')?.dataset.agentTerminalOpen === 'true'
  ));
  assert.equal(await page.locator('[data-agent-terminal-panel]').isVisible(), true);
  await page.waitForFunction(() => (
    document.querySelector('[data-process-note]')?.textContent.includes('2 个任务仍未处理')
  ));
  assert.equal(submittedTaskIds.length, 2);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('待处理任务可二次编辑说明并确认删除', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const frame = page.frameLocator('#deck-frame');

  await page.click('[data-mode="region"]');
  await dragInFrame(page, { x:100, y:100 }, { x:320, y:240 });
  await frame.locator('[data-region-popover] textarea').fill('原始修改说明');
  await frame.locator('[data-region-submit]').click();
  const row = page.locator('[data-task-row]');
  await row.waitFor();

  await row.locator('[data-task-edit]').click();
  await row.locator('[data-task-edit-input]').fill('更新后的修改说明');
  await row.locator('[data-task-edit-save]').click();
  await page.waitForFunction(() => document.querySelector('[data-task-row]')?.textContent.includes('更新后的修改说明'));
  let tasks = await fetch(`${app.url}/api/tasks?token=${app.token}`).then(response => response.json());
  assert.equal(tasks[0].instruction, '更新后的修改说明');

  await row.locator('[data-task-delete]').click();
  await row.locator('[data-task-delete-confirm]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 0);
  tasks = await fetch(`${app.url}/api/tasks?token=${app.token}`).then(response => response.json());
  assert.deepEqual(tasks, []);
  assert.equal(await page.locator('[data-page-badge]').count(), 0);
});

test('区域弹窗可继续累计任务或直接执行全部待完成任务', async t => {
  let submittedTaskIds = [];
  const app = await startFixtureServer({
    agentRunAdapter:{
      id:'codex',
      async run({ taskIds }) {
        submittedTaskIds = taskIds;
        await new Promise(resolve => setTimeout(resolve, 800));
        return { summary:'Agent 已接收测试批次' };
      },
    },
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  const frame = page.frameLocator('#deck-frame');

  await page.locator('[data-mode="region"]').click();
  await dragInFrame(page, { x:100, y:100 }, { x:320, y:240 });
  await frame.locator('[data-region-popover] textarea').fill('第一条继续累计');
  assert.equal(
    await frame.locator('[data-region-submit] .pill-nav-label-default').innerText(),
    '继续添加任务',
  );
  assert.equal(
    await frame.locator('[data-region-submit-now] .pill-nav-label-default').innerText(),
    '直接执行',
  );
  assert.deepEqual(await frame.locator('[data-region-actions]').evaluate(actions => (
    [...actions.children].map(button => (
      button.querySelector('.pill-nav-label-default')?.textContent ?? button.textContent
    ))
  )), ['取消', '直接执行', '继续添加任务']);
  assert.deepEqual(await frame.locator('[data-region-actions]').evaluate(actions => (
    [...actions.children].map(button => {
      const stack = button.querySelector('.pill-nav-label-stack');
      const defaultLabel = button.querySelector('.pill-nav-label-default');
      const hoverLabel = button.querySelector('.pill-nav-label-hover');
      return {
        stack:getComputedStyle(stack).display,
        defaultOpacity:getComputedStyle(defaultLabel).opacity,
        hoverOpacity:getComputedStyle(hoverLabel).opacity,
      };
    })
  )), Array.from({ length:3 }, () => ({
    stack:'grid', defaultOpacity:'1', hoverOpacity:'0',
  })), 'PillNav 默认态只能显示一层文案');
  assert.deepEqual(await frame.locator('[data-region-submit]').evaluate(button => ({
    background:getComputedStyle(button).backgroundColor,
    color:getComputedStyle(button).color,
  })), { background:'rgb(199, 0, 11)', color:'rgb(255, 255, 255)' });
  assert.deepEqual(await frame.locator('[data-region-actions]').evaluate(actions => {
    const style = button => ({
      background:getComputedStyle(button).backgroundColor,
      border:getComputedStyle(button).borderColor,
      color:getComputedStyle(button).color,
    });
    return {
      cancel:style(actions.querySelector('[data-region-cancel]')),
      execute:style(actions.querySelector('[data-region-submit-now]')),
    };
  }), {
    cancel:{
      background:'rgba(255, 255, 255, 0.88)', border:'rgba(20, 22, 28, 0.12)',
      color:'rgb(95, 98, 104)',
    },
    execute:{
      background:'rgba(255, 255, 255, 0.88)', border:'rgba(20, 22, 28, 0.12)',
      color:'rgb(95, 98, 104)',
    },
  });
  await frame.locator('[data-region-submit]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 1);
  await frame.locator('[data-region-popover]').waitFor({ state:'detached' });
  assert.deepEqual(submittedTaskIds, [], '继续添加不得提前启动 Agent');

  await dragInFrame(page, { x:360, y:120 }, { x:580, y:260 });
  await frame.locator('[data-region-popover] textarea').fill('第二条并直接执行');
  await frame.locator('[data-region-submit-now]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 2);
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-status]')?.dataset.agentStatus === 'busy'
  ));
  await page.waitForFunction(() => (
    document.querySelector('.editor-shell')?.dataset.agentTerminalOpen === 'true'
  ));
  assert.equal(await page.locator('[data-agent-terminal-panel]').isVisible(), true);
  const deadline = Date.now() + 3_000;
  while (submittedTaskIds.length !== 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(submittedTaskIds.length, 2);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('单文件 bundle 重建文档后区域弹窗仍保留 PillNav 样式', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app, {
    allowPilotDocumentBlobAbort:true,
  });
  t.after(() => browser.close());
  const frame = page.frameLocator('#deck-frame');

  await page.locator('#deck-frame').evaluate(node => {
    node.contentDocument.querySelector('#__deck_loading_overlay')?.remove();
  });
  await page.locator('[data-mode="region"]').click();
  await dragInFrame(page, { x:100, y:100 }, { x:320, y:240 });
  const actions = frame.locator('[data-region-actions]');
  await actions.waitFor({ state:'visible' });
  const layout = await actions.evaluate(node => ({
    styleLinks:[...document.querySelectorAll('link[rel="stylesheet"]')]
      .map(link => link.getAttribute('href')),
    buttons:[...node.querySelectorAll('button')].map(button => ({
      radius:getComputedStyle(button).borderRadius,
      stack:getComputedStyle(button.querySelector('.pill-nav-label-stack')).display,
      defaultOpacity:getComputedStyle(button.querySelector('.pill-nav-label-default')).opacity,
      hoverOpacity:getComputedStyle(button.querySelector('.pill-nav-label-hover')).opacity,
    })),
  }));
  assert.ok(layout.styleLinks.includes('/editor/pill-nav.css'), JSON.stringify(layout));
  assert.deepEqual(layout.buttons, Array.from({ length:3 }, () => ({
    radius:'999px', stack:'grid', defaultOpacity:'1', hoverOpacity:'0',
  })));
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('区域截图失败时以 snapshot=null 非阻断提交任务', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  const frame = page.frameLocator('#deck-frame');
  await page.click('[data-mode="region"]');
  await page.locator('#deck-frame').evaluate(frameElement => {
    frameElement.contentWindow.html2canvas = async () => { throw new Error('tainted canvas'); };
  });
  await dragInFrame(page, { x: 100, y: 100 }, { x: 300, y: 230 });
  await frame.locator('[data-region-popover] textarea').fill('无快照也要提交');
  await frame.locator('[data-region-submit]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 1);
  const [task] = await fetch(`${app.url}/api/tasks?token=${app.token}`).then(response => response.json());
  assert.equal(task.snapshotPath, null);
  assert.deepEqual(await readdir(join(app.sessionDir, 'snapshots')), []);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('1440×900 缩放下按可见屏幕像素判断阈值且输入 UI 保持可达尺寸', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  const frame = page.frameLocator('#deck-frame');
  await page.click('[data-mode="region"]');

  await dragInFrame(page, { x: 100, y: 100 }, { x: 104, y: 104 });
  await page.waitForTimeout(100);
  assert.equal(await frame.locator('[data-region-popover]').count(), 0, '4×4 屏幕像素必须视为误操作');

  await dragInFrame(page, { x: 100, y: 100 }, { x: 106, y: 106 });
  await frame.locator('[data-region-popover]').waitFor({ state: 'visible' });
  const popoverBox = await frame.locator('[data-region-popover]').boundingBox();
  const submitBox = await frame.locator('[data-region-submit]').boundingBox();
  const frameBox = await page.locator('#deck-frame').boundingBox();
  const typography = await frame.locator('[data-region-popover] textarea').evaluate(textarea => ({
    fontSize: Number.parseFloat(getComputedStyle(textarea).fontSize),
    lineHeight: Number.parseFloat(getComputedStyle(textarea).lineHeight),
  }));
  assert.ok(popoverBox.width >= 330 && popoverBox.width <= 342, JSON.stringify(popoverBox));
  assert.ok(submitBox.height >= 32, JSON.stringify(submitBox));
  assert.ok(typography.fontSize >= 13 && typography.lineHeight >= 18, JSON.stringify(typography));
  assert.ok(popoverBox.x >= frameBox.x && popoverBox.x + popoverBox.width <= frameBox.x + frameBox.width + 1);
  assert.ok(popoverBox.y >= frameBox.y && popoverBox.y + popoverBox.height <= frameBox.y + frameBox.height + 1);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('候选排除 opacity 祖先隐藏子元素和全页布局容器但保留内容元素', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  const frame = page.frameLocator('#deck-frame');
  const locatorPaths = await page.locator('#deck-frame').evaluate(frameElement => {
    const { contentDocument: document, contentWindow: window } = frameElement;
    const section = document.querySelector('section[data-label]');
    const visible = document.createElement('img');
    visible.alt = '可见内容图';
    visible.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    Object.assign(visible.style, {
      position: 'absolute', left: '300px', top: '300px', width: '120px', height: '80px',
    });
    const hiddenParent = document.createElement('div');
    hiddenParent.className = 'hidden-parent';
    hiddenParent.style.opacity = '0';
    const hiddenChild = document.createElement('span');
    hiddenChild.className = 'hidden-child';
    hiddenChild.textContent = '不可见候选';
    Object.assign(hiddenChild.style, {
      position: 'absolute', left: '320px', top: '320px', width: '120px', height: '80px',
    });
    hiddenParent.append(hiddenChild);
    const wholePage = document.createElement('div');
    wholePage.className = 'whole-page-layout';
    Object.assign(wholePage.style, {
      position: 'absolute', left: '8px', top: '0px', width: '1920px', height: '1080px',
      pointerEvents: 'none',
    });
    section.append(visible, hiddenParent, wholePage);
    return {
      visible: window.HuaweiDeckPatchRuntime.makeLocator(visible).path,
      hidden: window.HuaweiDeckPatchRuntime.makeLocator(hiddenChild).path,
      wholePage: window.HuaweiDeckPatchRuntime.makeLocator(wholePage).path,
    };
  });
  await page.click('[data-mode="region"]');
  await dragInFrame(page, { x: 100, y: 100 }, { x: 300, y: 260 });
  await frame.locator('[data-region-popover] textarea').fill('候选过滤');
  await frame.locator('[data-region-submit]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 1);
  const [task] = await fetch(`${app.url}/api/tasks?token=${app.token}`).then(response => response.json());
  const paths = task.candidates.map(candidate => candidate.path);
  assert.ok(paths.includes(locatorPaths.visible), JSON.stringify(paths));
  assert.ok(!paths.includes(locatorPaths.hidden), JSON.stringify(paths));
  assert.ok(!paths.includes(locatorPaths.wholePage), JSON.stringify(paths));
  assert.ok(paths.length <= 12);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('PNG 快照超限时提交前仅降级一次 snapshot=null 并成功创建任务', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  const frame = page.frameLocator('#deck-frame');
  const taskPosts = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks') {
      taskPosts.push(request.url());
    }
  });
  await page.click('[data-mode="region"]');
  await page.locator('#deck-frame').evaluate(frameElement => {
    const { contentDocument: document, contentWindow: window } = frameElement;
    const bytes = new Uint8Array(512 * 1024 + 9);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    const oversized = `data:image/png;base64,${window.btoa(binary)}`;
    window.html2canvas = async () => document.createElement('canvas');
    window.HTMLCanvasElement.prototype.toDataURL = () => oversized;
  });
  await dragInFrame(page, { x: 100, y: 100 }, { x: 300, y: 230 });
  await frame.locator('[data-region-popover] textarea').fill('超限快照降级提交');
  await frame.locator('[data-region-submit]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 1, null, { timeout: 3_000 });
  const [task] = await fetch(`${app.url}/api/tasks?token=${app.token}`).then(response => response.json());
  assert.equal(task.snapshotPath, null);
  assert.equal(taskPosts.length, 1, '提交前预检后只发送一次无快照请求');
  assert.deepEqual(await readdir(join(app.sessionDir, 'snapshots')), []);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('小于 6×6 屏幕像素的误操作不打开输入框', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  await page.click('[data-mode="region"]');
  await dragInFrame(page, { x: 100, y: 100 }, { x: 101, y: 101 });
  await page.waitForTimeout(100);
  assert.equal(await page.frameLocator('#deck-frame').locator('[data-region-popover]').count(), 0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('邻近输入框按右侧、左侧、选区内右下顺序降级且 pagehide 清理注入 UI', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  const frame = page.frameLocator('#deck-frame');
  await page.click('[data-mode="region"]');
  const frameBox = await page.locator('#deck-frame').boundingBox();
  assert.ok(frameBox?.width > 700);

  await dragInFrame(page, { x: 100, y: 100 }, { x: 250, y: 200 });
  assert.equal(await frame.locator('[data-region-popover]').getAttribute('data-placement'), 'right');
  await frame.locator('[data-region-popover] textarea').press('Escape');

  await dragInFrame(page,
    { x: frameBox.width - 210, y: 100 },
    { x: frameBox.width - 40, y: 200 });
  assert.equal(await frame.locator('[data-region-popover]').getAttribute('data-placement'), 'left');
  await frame.locator('[data-region-popover] textarea').press('Escape');

  await dragInFrame(page, { x: 10, y: 40 }, { x: frameBox.width - 10, y: 400 });
  assert.equal(await frame.locator('[data-region-popover]').getAttribute('data-placement'), 'inside');
  const selectionBox = await frame.locator('[data-region-selection]').boundingBox();
  const insideBox = await frame.locator('[data-region-popover]').boundingBox();
  assert.ok(Math.abs((insideBox.x + insideBox.width) - (selectionBox.x + selectionBox.width)) < 3);
  assert.ok(Math.abs((insideBox.y + insideBox.height) - (selectionBox.y + selectionBox.height)) < 3);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await page.waitForTimeout(100);
  assert.equal(await frame.locator('[data-deck-editor-ui]').count(), 0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});
