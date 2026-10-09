import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { copyFile, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { loadChromium } from '../../verify/load-playwright.mjs';
import { startAppServer } from '../app-server.mjs';
import { startServer } from '../server.mjs';
import { WorkCatalog } from '../work-catalog.mjs';

test('DSH 恢复旧空占位后，打开编辑器与项目会话切换可靠往返', {
  timeout:45_000,
}, async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-dsh-session-navigation-'));
  const deckPath = join(projectRoot, '会话切换测试.html');
  await copyFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'), deckPath);
  const seeded = await startServer({ deckPath, dshAgentBridge:true,
    workId:'11111111-1111-4111-8111-111111111111',
    dshWorkItemProvider:async () => null, dshWorkItemCommand:async () => null,
  });
  const legacyPath = join(seeded.sessionDir, 'agent-workspace.json');
  await seeded.close();
  const legacy = JSON.parse(await readFile(legacyPath, 'utf8'));
  legacy.activeProvider = 'dsh';
  legacy.providers = { dsh:{ activeConversationId:null, conversations:[] } };
  legacy.projectRoot = process.platform === 'win32' ? '/Users/old/project' : String.raw`C:\old\project`;
  await writeFile(legacyPath, JSON.stringify(legacy));
  const history = { creation:[], editing:[] };
  const workHistoryStore = {
    filePath:join(projectRoot, 'work-history.json'),
    async list() { return structuredClone({ version:1, ...history }); },
    async recordCreation({ projectRoot:root, draftId, provider }) {
      const entry = {
        kind:'creation', projectRoot:root, draftId, provider,
        title:'会话切换新建任务', projectName:'测试项目', phase:'brief', progress:'需求沟通中',
      };
      history.creation = [entry];
      return entry;
    },
    async resolveCreation({ projectRoot:root, draftId }) {
      return history.creation.find(entry => entry.projectRoot === root && entry.draftId === draftId)
        ?? null;
    },
    async recordDeck({ deckPath:recordedDeck, provider }) {
      const entry = {
        kind:'editing', deckPath:recordedDeck, deckName:'会话切换测试.html',
        directory:projectRoot, projectRoot, provider, progress:'继续编辑',
      };
      history.editing = [entry];
      return entry;
    },
    async resolveDeck(requestedDeck) { return requestedDeck === deckPath ? deckPath : null; },
    async completeCreation() {},
    async dismissCreation() {},
    async dismissDeck() {},
  };
  const workCatalog = new WorkCatalog({
    filePath:join(projectRoot, 'work-catalog.json'),
    legacyHistory:workHistoryStore,
  });

  let appUrl = '';
  const parent = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type':'text/html; charset=utf-8',
      'cache-control':'no-store',
    });
    response.end(`<!doctype html><html><body style="margin:0">
      <iframe id="workbench" title="AICO-PPT Editor" src=${JSON.stringify(appUrl)}
        style="display:block;width:100vw;height:100vh;border:0"></iframe>
      <script>
        const frame = document.querySelector('#workbench');
        const sessions = new Map();
        const sentPrompts = [];
        const registeredEditorOrigins = [];
        let currentSessionId = null;
        const summary = sessionId => sessions.get(sessionId) ?? null;
        const publish = () => frame.contentWindow.postMessage({
          type:'aico-ppt:dsh-session-changed',
          session:summary(currentSessionId),
        }, '*');
        window.selectSession = sessionId => {
          currentSessionId = sessionId;
          publish();
        };
        window.currentSessionId = () => currentSessionId;
        window.sentPrompts = () => sentPrompts.slice();
        window.registeredEditorOrigins = () => registeredEditorOrigins.slice();
        addEventListener('message', event => {
          if (event.source !== frame.contentWindow || !event.data) return;
          if (event.data.type === 'aico-ppt:dsh-frame-origin') {
            registeredEditorOrigins.push({
              sourceOrigin:event.origin,
              editorOrigin:event.data.origin,
            });
            return;
          }
          if (event.data.type === 'aico-ppt:dsh-ready') {
            publish();
            return;
          }
          if (event.data.type !== 'aico-ppt:dsh-request') return;
          const { requestId, command, payload } = event.data;
          let result;
          if (command === 'ensure-workspace') {
            result = { workspaceId:'workspace-project', path:payload.path, title:'测试项目' };
          } else if (command === 'create-session') {
            result = {
              sessionId:payload.sessionId, title:payload.title,
              cwd:${JSON.stringify(projectRoot)}, running:false,
            };
            sessions.set(payload.sessionId, result);
          } else if (command === 'describe-sessions') {
            // 模拟 DSH 会话列表仍在恢复或完全不响应。Editor 的任务页初始化、
            // 会话同步和项目切换都不能被这个仅用于标题增强的请求阻塞。
            return;
          } else if (command === 'open-session') {
            currentSessionId = payload.sessionId;
            result = summary(payload.sessionId) ?? { sessionId:payload.sessionId };
          } else if (command === 'send-to-session') {
            sentPrompts.push({ sessionId:payload.sessionId, prompt:payload.prompt });
            result = { accepted:true, sessionId:payload.sessionId };
          } else if (command === 'current-session') {
            result = summary(currentSessionId);
          } else {
            throw new Error('测试未实现 DSH 命令：' + command);
          }
          frame.contentWindow.postMessage({
            type:'aico-ppt:dsh-result', requestId, ok:true, result,
          }, '*');
          if (command === 'open-session') queueMicrotask(publish);
        });
      <\/script>
    </body></html>`);
  });
  parent.listen(0, '127.0.0.1');
  await once(parent, 'listening');
  const parentAddress = parent.address();
  assert.ok(parentAddress && typeof parentAddress === 'object');
  const parentOrigin = `http://127.0.0.1:${parentAddress.port}`;

  let editorStarts = 0;
  const app = await startAppServer({
    token:'dsh-session-navigation-secret',
    embeddedMode:'dsh',
    embeddedParentOrigin:parentOrigin,
    pickAgentProjectDirectory:async () => projectRoot,
    pickDeck:async () => deckPath,
    workHistoryStore,
    workCatalog,
    resolveAgentProject:async () => ({
      path:projectRoot, source:'explicit', needsConfirmation:false, warning:null,
      identity:{ originalPath:projectRoot, realPath:projectRoot, dev:'1', ino:'1' },
    }),
    assertAgentProject:async project => project.path,
    startEditor:async options => {
      editorStarts += 1;
      return startServer({ ...options, autoStartAgentTerminal:false });
    },
  });
  appUrl = app.appUrl;

  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(async () => {
    await browser.close().catch(() => {});
    await app.close().catch(() => {});
    await new Promise(resolvePromise => parent.close(resolvePromise));
    await rm(projectRoot, { recursive:true, force:true });
  });
  const page = await browser.newPage({ viewport:{ width:1440, height:900 } });
  await page.goto(parentOrigin);
  const workbench = page.frameLocator('#workbench');

  await workbench.getByRole('button', { name:/从0开始创建一个新的deck，新任务/ }).click();
  await workbench.getByRole('button', { name:/选择项目目录/ }).click();
  const confirmation = workbench.locator('[data-confirm-creation-project]');
  if (await confirmation.isVisible()) await confirmation.check();
  await workbench.getByRole('button', { name:/创建 Draft 并开始对话/ }).click();
  const creationSelect = workbench.locator('[data-dsh-task-session-label]');
  await creationSelect.waitFor({ state:'visible' });
  await page.waitForFunction(() => document.querySelector('#workbench')?.contentWindow !== null);
  await creationSelect.locator('option[value^="session-"]').waitFor({ state:'attached' });
  const creationSessionId = await creationSelect.inputValue();
  assert.equal(
    await page.evaluate(sessionId => (
      window.sentPrompts().filter(row => row.sessionId === sessionId).length
    ), creationSessionId),
    1,
    '首次创建 Creation 会话只发送一次初始任务上下文',
  );
  assert.match(
    (await creationSelect.locator('option:checked').textContent()) ?? '',
    /^创建 Deck：会话切换新建任务/u,
    'DSH 列表不响应时，新建任务仍应立即显示可识别的中文会话名',
  );
  assert.equal(
    await workbench.locator('[data-dsh-task-session]').getAttribute('data-state'),
    'active',
    '新建任务页必须收到当前 DSH 会话的 ready 重放',
  );

  await workbench.getByRole('button', { name:'初始页' }).click();
  await workbench.locator('[data-landing]').waitFor({ state:'visible' });
  await workbench.locator('html[data-app-ready="true"]').waitFor();
  await workbench.getByRole('button', { name:/修改已经写好的deck，新任务/ }).click();
  await workbench.getByRole('button', { name:/添加 Deck HTML/ }).click();
  await workbench.getByRole('button', { name:/打开编辑器/ }).click();
  const editingSelect = workbench.locator('[data-dsh-session-select]');
  await editingSelect.locator('option[value^="session-"]').waitFor({ state:'attached' });
  const repaired = JSON.parse(await readFile(legacyPath, 'utf8'));
  assert.equal(repaired.deckSessionId, legacy.deckSessionId);
  assert.equal(repaired.projectRoot, projectRoot);
  assert.equal(repaired.activeProvider, 'codex');
  assert.equal(
    await workbench.locator('[data-current-project-name]').textContent(),
    '会话切换测试.html',
    '修改任务顶栏必须显示当前 Deck HTML 文件名',
  );
  const editingSessionId = await editingSelect.inputValue();
  assert.notEqual(editingSessionId, creationSessionId);
  assert.match(
    (await editingSelect.locator('option:checked').textContent()) ?? '',
    /^修改 Deck：会话切换测试\.html/u,
    'DSH 列表不响应时，修改任务仍应立即显示可识别的中文会话名',
  );
  const registeredOrigins = await page.evaluate(() => window.registeredEditorOrigins());
  assert.ok(registeredOrigins.some(row => (
    /^http:\/\/127\.0\.0\.1:\d+$/u.test(row.sourceOrigin)
    && /^http:\/\/127\.0\.0\.1:\d+$/u.test(row.editorOrigin)
    && row.sourceOrigin !== row.editorOrigin
  )), '启动页必须在跨端口进入修改 Editor 前注册精确的本地 Origin');
  assert.equal(
    await workbench.locator('[data-dsh-session-control]').getAttribute('data-state'),
    'active',
    '修改任务页必须收到当前 DSH 会话的 ready 重放',
  );

  const selectParentSession = sessionId => page.evaluate(id => window.selectSession(id), sessionId);
  await selectParentSession(creationSessionId);
  await workbench.locator('[data-builder]').waitFor({ state:'visible', timeout:8_000 });
  assert.equal(await workbench.locator('[data-dsh-task-session-label]').inputValue(), creationSessionId);
  assert.equal(await workbench.locator('[data-dsh-task-session]').getAttribute('data-state'), 'active');

  await selectParentSession(editingSessionId);
  await workbench.locator('[data-dsh-session-select]').waitFor({ state:'visible', timeout:8_000 });
  assert.equal(await workbench.locator('[data-dsh-session-select]').inputValue(), editingSessionId);
  assert.equal(await workbench.locator('[data-dsh-session-control]').getAttribute('data-state'), 'active');

  await selectParentSession(creationSessionId);
  await workbench.locator('[data-builder]').waitFor({ state:'visible', timeout:8_000 });
  assert.equal(await workbench.locator('[data-dsh-task-session-label]').inputValue(), creationSessionId);
  assert.equal(await workbench.locator('[data-dsh-task-session]').getAttribute('data-state'), 'active');

  await workbench.getByRole('button', { name:'切换项目' }).click();
  await workbench.locator('[data-workspace-task="editing"]').click();
  await workbench.locator('[data-dsh-session-select]').waitFor({ state:'visible', timeout:8_000 });
  assert.equal(await page.evaluate(() => window.currentSessionId()), editingSessionId);

  await workbench.getByRole('button', { name:'切换项目' }).click();
  await workbench.locator('[data-workspace-task="creation"]').click();
  await workbench.locator('[data-builder]').waitFor({ state:'visible', timeout:8_000 });
  assert.equal(await page.evaluate(() => window.currentSessionId()), creationSessionId);
  assert.equal(
    await page.evaluate(sessionId => (
      window.sentPrompts().filter(row => row.sessionId === sessionId).length
    ), creationSessionId),
    1,
    '会话点击和项目切换只能恢复 Creation 页面，不得自动追加“继续”命令',
  );
  assert.equal(editorStarts, 1, '多次会话与项目往返必须复用同一个修改 Editor runtime');
});
