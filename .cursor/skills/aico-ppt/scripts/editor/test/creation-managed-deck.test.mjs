import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { CreationManagedDeck } from '../creation-managed-deck.mjs';

test('CreationManagedDeck 复用 Editor Server，并在发布前 flush + solidify', async t => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url:request.url,
      authorization:request.headers.authorization,
      body:JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    response.writeHead(200, { 'content-type':'application/json' });
    response.end(JSON.stringify(request.url === '/api/solidify-preflight'
      ? { preflightToken:'preflight-1', bindingRevision:7 }
      : { revision:4, clearedGroupCount:1 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const calls = [];
  const session = { revision:3, groups:[{ id:'g1' }], redo:[] };
  let startOptions;
  const runtime = await CreationManagedDeck.open({
    sourceDeckPath:'/tmp/staging/deck.html',
    projectRoot:'/tmp/project',
    provider:'codex',
    terminal:{ snapshot:() => ({ conversationId:'c1' }) },
    creationHandoff:{ draft:{ draftId:'d1' }, draftDir:'/tmp/d1' },
    editorCloseGraceMs:4321,
    startEditor:async options => {
      startOptions = options;
      return {
        url:`http://127.0.0.1:${port}`, token:'editor-token', editorToken:'browser-token',
        workingDeckPath:'/tmp/staging/.aico-ppt-editor/session/working/deck.html',
        session,
        flushWorkingDeckChanges:async () => calls.push('flush'),
        waitUntilReady:async () => calls.push('ready'),
        close:async () => calls.push('close'),
      };
    },
  });
  assert.equal(startOptions.agentTerminalSession.snapshot().conversationId, 'c1');
  assert.equal(startOptions.closeAgentTerminalOnShutdown, false);
  assert.equal(startOptions.creationHandoff.draft.draftId, 'd1');
  assert.equal(startOptions.editorCloseGraceMs, 4321);
  assert.match(runtime.snapshot().editorUrl, /embedded=creation&mode=preview/);
  const result = await runtime.preparePublish();
  assert.equal(result.solidified, true);
  assert.deepEqual(calls, ['flush', 'ready']);
  assert.deepEqual(requests, [
    {
      url:'/api/solidify-preflight', authorization:'Bearer editor-token',
      body:{ expectedRevision:3 },
    },
    {
      url:'/api/solidify-deck', authorization:'Bearer editor-token',
      body:{
        expectedRevision:3, expectedBindingRevision:7, preflightToken:'preflight-1',
      },
    },
  ]);
  const transferred = runtime.transfer();
  assert.equal(transferred.url, `http://127.0.0.1:${port}`);
  await runtime.close();
  assert.equal(calls.includes('close'), false);
});

test('没有活动历史时发布沿用 staging 基线，不发送空固化请求', async () => {
  let requested = false;
  const runtime = await CreationManagedDeck.open({
    sourceDeckPath:'/tmp/staging/deck.html', projectRoot:'/tmp/project',
    terminal:{ snapshot:() => ({}) },
    startEditor:async () => ({
      url:'http://127.0.0.1:1', token:'token', editorToken:'browser-token',
      workingDeckPath:'/tmp/working/deck.html', session:{ revision:0, groups:[], redo:[] },
      flushWorkingDeckChanges:async () => {}, waitUntilReady:async () => {},
      close:async () => { requested = requested || false; },
    }),
  });
  const result = await runtime.preparePublish();
  assert.equal(result.solidified, false);
  assert.equal(requested, false);
  await runtime.close();
});

test('DSH Creation Managed Deck 复用 Work Item 协调器而不注入独立终端', async () => {
  const dshWorkItemProvider = async () => ({ workId:'work-dsh' });
  const dshWorkItemCommand = async () => ({ status:'ok' });
  let startOptions;
  const runtime = await CreationManagedDeck.open({
    sourceDeckPath:'/tmp/staging/deck.html',
    projectRoot:'/tmp/project',
    terminal:{ snapshot:() => ({ conversationId:'session-dsh' }) },
    dshAgentBridge:true,
    workId:'work-dsh',
    dshWorkItemProvider,
    dshWorkItemCommand,
    startEditor:async options => {
      startOptions = options;
      return {
        url:'http://127.0.0.1:1', token:'token', editorToken:'browser-token',
        workingDeckPath:'/tmp/working/deck.html', session:{ revision:0, groups:[], redo:[] },
        close:async () => {},
      };
    },
  });

  assert.equal(startOptions.dshAgentBridge, true);
  assert.equal(startOptions.workId, 'work-dsh');
  assert.equal(startOptions.dshWorkItemProvider, dshWorkItemProvider);
  assert.equal(startOptions.dshWorkItemCommand, dshWorkItemCommand);
  assert.equal('agentTerminalSession' in startOptions, false);
  assert.equal('closeAgentTerminalOnShutdown' in startOptions, false);
  await runtime.close();
});
