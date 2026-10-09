import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DraftAgentConversationStore,
  createTerminalConversation,
  discoverTerminalConversation,
  resumeTerminalConversation,
} from '../agent-terminal-conversation-store.mjs';

test('Codex 新会话立即返回发现标识，不先执行隐藏 Agent turn', async () => {
  const discoveryToken = '019ff4b7-0622-7272-b0e2-394f6316b52a';
  const result = await createTerminalConversation('codex', {
    idFactory:() => discoveryToken,
  });
  assert.equal(result.conversationId, null);
  assert.equal(result.resume, false);
  assert.equal(result.initialPromptConsumed, false);
  assert.equal(result.discoveryToken, discoveryToken);
  assert.ok(Number.isFinite(Date.parse(result.discoveryStartedAt)));
  assert.ok(Array.isArray(result.knownConversationIds));
});

test('Windows WSL Codex 在 WSL 内建立 rollout 基线', async () => {
  const calls = [];
  const result = await createTerminalConversation('codex', {
    idFactory:() => '019ff4b7-0622-7272-b0e2-394f6316b52a',
    environment:{
      AICO_PPT_CODEX_RUNTIME:'wsl',
      AICO_PPT_WSL_DISTRO:'Ubuntu-26.04',
      AICO_PPT_WSL_USER:'root',
      AICO_PPT_WSL_NODE:'/usr/bin/node',
      AICO_PPT_WSL_CODEX_HOME:'/root/.codex',
      AICO_PPT_WSL_SESSION_HELPER:'/mnt/c/workspace/scripts/editor/wsl-codex-session-helper.mjs',
    },
    runWslCodexHelper:async (operation, args) => {
      calls.push({ operation, args });
      return { ids:['019ff4b7-0622-7272-b0e2-394f6316b52b'] };
    },
  });
  assert.deepEqual(result.knownConversationIds, ['019ff4b7-0622-7272-b0e2-394f6316b52b']);
  assert.deepEqual(calls, [{ operation:'list-rollouts', args:[] }]);
});

test('Codex 可见首轮落盘后按唯一标识发现真实 ID', async () => {
  let requests = 0;
  let closed = false;
  const id = '019ff4b7-0622-7272-b0e2-394f6316b52b';
  const discovered = await discoverTerminalConversation('codex', {
    discoveryToken:'019ff4b7-0622-7272-b0e2-394f6316b52a',
    pollMs:1,
    codexClientFactory:async () => ({
      async request(method) {
        assert.equal(method, 'thread/list');
        requests += 1;
        return requests === 1 ? { data:[] } : {
          data:[{ id, preview:'[AICO-PPT 会话标识：019ff4b7-0622-7272-b0e2-394f6316b52a]' }],
        };
      },
      async close() { closed = true; },
    }),
  });
  assert.equal(discovered, id);
  assert.equal(requests, 2);
  assert.equal(closed, true);
  assert.deepEqual(await resumeTerminalConversation('codex', { conversationId:id }), {
    conversationId:id, resume:true,
  });
});

test('Windows WSL Codex 只在 WSL 内发现会话且不启动 Windows App Server', async () => {
  const expected = '019ff4b7-0622-7272-b0e2-394f6316b52b';
  let polls = 0;
  const discovered = await discoverTerminalConversation('codex', {
    discoveryToken:'019ff4b7-0622-7272-b0e2-394f6316b52a',
    discoveryStartedAt:new Date().toISOString(),
    knownConversationIds:[],
    cwd:'/mnt/c/Users/测试 用户/演示 项目',
    environment:{
      AICO_PPT_CODEX_RUNTIME:'wsl',
      AICO_PPT_WSL_DISTRO:'Ubuntu-26.04',
      AICO_PPT_WSL_USER:'root',
      AICO_PPT_WSL_NODE:'/usr/bin/node',
      AICO_PPT_WSL_CODEX_HOME:'/root/.codex',
      AICO_PPT_WSL_SESSION_HELPER:'/mnt/c/workspace/scripts/editor/wsl-codex-session-helper.mjs',
    },
    pollMs:1,
    timeoutMs:1_000,
    runWslCodexHelper:async (operation, args) => {
      assert.equal(operation, 'find-rollout');
      assert.equal(args[2], '/mnt/c/Users/测试 用户/演示 项目');
      polls += 1;
      return { conversationId:polls === 1 ? null : expected };
    },
    codexClientFactory:async () => {
      throw new Error('WSL rollout 发现不应启动 Windows Codex App Server');
    },
  });
  assert.equal(discovered, expected);
  assert.equal(polls, 2);
});

test('OpenCode 可见 TUI 使用固定标识发现并恢复真实 session', async () => {
  const discoveryToken = '019ff4b7-0622-7272-b0e2-394f6316b52e';
  const created = await createTerminalConversation('opencode', {
    idFactory:() => discoveryToken,
    projectRoot:'/tmp/project',
    listOpenCodeSessions:async () => [{ id:'ses_existing', title:'旧会话', cwd:'/tmp/project' }],
  });
  assert.equal(created.conversationId, null);
  assert.deepEqual(created.knownConversationIds, ['ses_existing']);

  let polls = 0;
  const id = await discoverTerminalConversation('opencode', {
    discoveryToken,
    knownConversationIds:created.knownConversationIds,
    cwd:'/tmp/project',
    pollMs:1,
    timeoutMs:100,
    listOpenCodeSessions:async () => {
      polls += 1;
      return polls === 1
        ? [{ id:'ses_existing', title:'旧会话', cwd:'/tmp/project' }]
        : [
          { id:'ses_existing', title:'旧会话', cwd:'/tmp/project' },
          { id:'ses_new', title:`[AICO-PPT 会话标识：${discoveryToken}]`, cwd:'/tmp/project' },
        ];
    },
  });
  assert.equal(id, 'ses_new');
  assert.deepEqual(await resumeTerminalConversation('opencode', { conversationId:id }), {
    conversationId:id, resume:true,
  });
});

test('同目录并发创建 Codex 时只认领包含本次唯一标识的 rollout', async t => {
  const configRoot = await mkdtemp(join(tmpdir(), 'deck-codex-discovery-'));
  t.after(() => rm(configRoot, { recursive:true, force:true }));
  const [year, month, day] = new Date().toISOString().slice(0, 10).split('-');
  const directory = join(configRoot, 'sessions', year, month, day);
  await mkdir(directory, { recursive:true });
  const expected = '019ff4b7-0622-7272-b0e2-394f6316b52c';
  const competing = '019ff4b7-0622-7272-b0e2-394f6316b52d';
  const timestamp = new Date().toISOString();
  const meta = id => JSON.stringify({
    timestamp, type:'session_meta',
    payload:{ id, session_id:id, timestamp, cwd:'/tmp/same-project', source:'cli' },
  });
  await writeFile(join(directory, `rollout-now-${competing}.jsonl`), `${meta(competing)}\n其他会话\n`);
  await writeFile(join(directory, `rollout-now-${expected}.jsonl`),
    `${meta(expected)}\n[AICO-PPT 会话标识：019ff4b7-0622-7272-b0e2-394f6316b52a]\n`);

  const discovered = await discoverTerminalConversation('codex', {
    discoveryToken:'019ff4b7-0622-7272-b0e2-394f6316b52a',
    discoveryStartedAt:new Date(Date.now() - 100).toISOString(),
    knownConversationIds:[],
    cwd:'/tmp/same-project',
    environment:{ CODEX_HOME:configRoot },
    pollMs:1,
    codexClientFactory:async () => { throw new Error('本地 rollout 发现成功时不应启动 App Server'); },
  });
  assert.equal(discovered, expected);
});

test('Creation Draft 为不同 provider 持久化独立会话 ID 并在继续任务时恢复', async t => {
  const draftDir = await mkdtemp(join(tmpdir(), 'deck-agent-conversations-'));
  t.after(() => rm(draftDir, { recursive:true, force:true }));
  let creations = 0;
  const options = {
    draftDir,
    taskId:'draft-unique',
    projectRoot:'/tmp/project',
    now:() => '2026-08-11T12:00:00.000Z',
    createConversation:async provider => {
      creations += 1;
      return {
        conversationId:`${provider}-conversation-${creations}`,
        resume:provider === 'codex',
      };
    },
    resumeConversation:async (provider, { conversationId }) => ({
      conversationId, resume:provider === 'codex' || provider === 'claude-code',
    }),
  };
  const store = new DraftAgentConversationStore(options);
  assert.deepEqual(await store.resolve('codex'), {
    conversationId:'codex-conversation-1', resume:true,
  });
  assert.deepEqual(await store.resolve('claude-code'), {
    conversationId:'claude-code-conversation-2', resume:false,
  });
  await store.markStarted('claude-code', 'claude-code-conversation-2');

  const reopened = new DraftAgentConversationStore(options);
  assert.deepEqual(await reopened.resolve('codex'), {
    conversationId:'codex-conversation-1', resume:true,
  });
  assert.deepEqual(await reopened.resolve('claude-code'), {
    conversationId:'claude-code-conversation-2', resume:true,
  });
  assert.equal(creations, 2);
  const persisted = JSON.parse(await readFile(join(draftDir, 'agent-conversations.json'), 'utf8'));
  assert.equal(persisted.taskId, 'draft-unique');
  assert.equal(persisted.providers['claude-code'].started, true);

  const fresh = await reopened.resolve('claude-code', { newConversation:true });
  assert.deepEqual(fresh, {
    conversationId:'claude-code-conversation-3', resume:false,
  });
  assert.equal(creations, 3);
  await reopened.markStarted('claude-code', fresh.conversationId);

  const afterFresh = new DraftAgentConversationStore(options);
  assert.deepEqual(await afterFresh.resolve('claude-code'), {
    conversationId:'claude-code-conversation-3', resume:true,
  });
  const freshCodex = await afterFresh.resolve('codex', { newConversation:true });
  assert.deepEqual(freshCodex, {
    conversationId:'codex-conversation-4', resume:true,
  });
  const finalReopen = new DraftAgentConversationStore(options);
  assert.deepEqual(await finalReopen.resolve('codex'), {
    conversationId:'codex-conversation-4', resume:true,
  });
  assert.equal(creations, 4);
});
