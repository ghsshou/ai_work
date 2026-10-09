import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { loadChromium } from '../../verify/load-playwright.mjs';
import { startAppServer } from '../app-server.mjs';
import { startServer } from '../server.mjs';
import { WorkCatalog } from '../work-catalog.mjs';

test('DSH 打开未关联项目时必须先作明确选择，不能悄悄沿用其他会话', {
  timeout:45_000,
}, async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-dsh-session-navigation-'));
  const deckPath = join(projectRoot, '会话切换测试.html');
  const otherDeckPath = join(projectRoot, 'other', '另一个未关联项目.html');
  await mkdir(join(projectRoot,'other'));
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
  const history = { creation:[], editing:[{kind:'editing',deckPath,deckName:'会话切换测试.html',directory:projectRoot,projectRoot,provider:'dsh',progress:'继续编辑'}] };
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
      history.editing = [entry, ...history.editing.filter(row=>row.deckPath!==recordedDeck)];
      return entry;
    },
    async resolveDeck(requestedDeck) { return [deckPath,otherDeckPath].includes(requestedDeck) ? requestedDeck : null; },
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
        const sessions = new Map([['ordinary-session',{sessionId:'ordinary-session',title:'其他普通对话',cwd:'C:/ordinary',running:false}]]);
        const sentPrompts = [];
        const registeredEditorOrigins = [];
        let currentSessionId = 'ordinary-session';
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

  await workbench.locator('[data-recent-deck]').click();
  const decision = workbench.getByRole('dialog', {name:'此项目尚未关联会话'});
  await decision.waitFor({state:'visible',timeout:3000});
  assert.equal(editorStarts,0,'未作选择之前不应启动或切换 Editor');
  assert.equal(await page.evaluate(()=>window.currentSessionId()),'ordinary-session');
  await decision.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(editorStarts,0);
  assert.deepEqual(await page.evaluate(()=>window.sentPrompts()),[]);
  await workbench.locator('[data-recent-deck]').click();
  await decision.getByRole('button',{name:'新建项目会话',exact:true}).click();
  const select = workbench.locator('[data-dsh-session-select]');
  await select.locator('option[value^="session-"]').waitFor({state:'attached',timeout:8000});
  const sessionId = await select.inputValue();
  assert.notEqual(sessionId,'ordinary-session');
  assert.equal(await page.evaluate(()=>window.currentSessionId()),sessionId);
  assert.equal(editorStarts,1);
  const prompts = await page.evaluate(()=>window.sentPrompts());
  assert.equal(prompts.length,1,'确认后只发一次项目初始化消息');
  assert.equal(prompts[0].sessionId,sessionId);
  const catalog = JSON.parse(await readFile(workCatalog.filePath,'utf8'));
  assert.equal(catalog.workItems[0].dshBinding.workspaceId,'workspace-project');
  assert.equal(catalog.workItems[0].dshBinding.activeSessionId,sessionId);
  assert.equal(catalog.workItems[0].dshBinding.sessions.length,1);
  await workbench.getByRole('button',{name:'初始页'}).click();
  await workbench.locator('[data-recent-deck]').click();
  await workbench.locator('[data-dsh-session-select]').waitFor({state:'visible',timeout:8000});
  assert.equal(await workbench.locator('[data-dsh-session-select]').inputValue(),sessionId);
  assert.equal(await page.evaluate(()=>window.sentPrompts().length),1,'已关联项目重开不得追加初始化消息');
  assert.equal(editorStarts,1,'已关联项目应复用 Editor');
  await writeFile(otherDeckPath,(await readFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'),'utf8')).replace('第一页标题','独立项目首页'));
  history.editing.push({kind:'editing',deckPath:otherDeckPath,deckName:'另一个未关联项目.html',directory:projectRoot,projectRoot,provider:'dsh',progress:'继续编辑'});
  await workbench.getByRole('button',{name:'切换项目'}).click();
  await workbench.locator('[data-workspace-task="editing"]').filter({hasText:'另一个未关联项目'}).click();
  await decision.waitFor({state:'visible'});
  await decision.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.currentSessionId()),sessionId);
  assert.equal(editorStarts,1,'Editor 中取消切换也应保持原项目');
  await workbench.getByRole('button',{name:'切换项目'}).click();
  await workbench.locator('[data-workspace-task="editing"]').filter({hasText:'另一个未关联项目'}).click();
  await decision.getByRole('button',{name:'新建项目会话',exact:true}).click();
  await workbench.locator('[data-current-project-name]').filter({hasText:'另一个未关联项目.html'}).waitFor({timeout:8000});
  const secondSessionId=await workbench.locator('[data-dsh-session-select]').inputValue();
  assert.notEqual(secondSessionId,sessionId);
  assert.equal(await page.evaluate(()=>window.currentSessionId()),secondSessionId);
  assert.equal(await page.evaluate(()=>window.sentPrompts().length),2,'跨页面确认只创建和初始化一次');
  assert.equal(editorStarts,2);

});
