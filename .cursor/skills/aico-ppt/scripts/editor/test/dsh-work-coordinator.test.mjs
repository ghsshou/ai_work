import assert from 'node:assert/strict';
import test from 'node:test';

import { DeckTaskCoordinator } from '../public/deck-task-coordinator.mjs';
import {
  DshWorkBridge,
  describeDshWorkSessionTarget,
  listDshWorkSessionTargets,
} from '../public/dsh-work-bridge.mjs';

class FakeWindow {
  constructor() {
    this.listeners = new Set();
  }

  addEventListener(type, listener) {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === 'message') this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }
}

function emptyBinding(overrides = {}) {
  return {
    revision:0,
    workspaceId:null,
    activeSessionId:null,
    sessions:[],
    pendingOperation:null,
    ...overrides,
  };
}

function workItem(dshBinding = emptyBinding(), overrides = {}) {
  return {
    kind:'editing',
    workId:'61111111-1111-4111-8111-111111111111',
    displayName:'技术解析.html',
    projectRoot:'/project/deck',
    deckPath:'/project/deck/deck.html',
    ...overrides,
    dshBinding,
  };
}

test('DSH 浏览器桥只接受精确父窗口、Origin 和 requestId 的结果', async () => {
  const hostWindow = new FakeWindow();
  const targetWindow = {
    sent:[],
    postMessage(message, origin) { this.sent.push({ message, origin }); },
  };
  const bridge = new DshWorkBridge({
    hostWindow,
    targetWindow,
    targetOrigin:'https://dsh.example.test/workbench',
    timeoutMs:1_000,
  });
  assert.deepEqual(targetWindow.sent[0], {
    message:{ type:'aico-ppt:dsh-ready' },
    origin:'https://dsh.example.test',
  });
  const sessions = [];
  const unsubscribe = bridge.subscribeCurrentSession(session => sessions.push(session));
  assert.deepEqual(targetWindow.sent[1], {
    message:{ type:'aico-ppt:dsh-ready' },
    origin:'https://dsh.example.test',
  }, '首个业务订阅安装后应重放 ready，避免 iframe 导航竞态丢失当前会话');
  hostWindow.emit({
    source:targetWindow, origin:'https://dsh.example.test',
    data:{ type:'aico-ppt:dsh-session-changed', session:{ sessionId:'session-current' } },
  });
  assert.deepEqual(sessions, [{ sessionId:'session-current' }]);
  const resultPromise = bridge.request('open-session', { sessionId:'session-a' });
  const request = targetWindow.sent[2].message;
  assert.equal(targetWindow.sent[2].origin, 'https://dsh.example.test');

  hostWindow.emit({
    source:{}, origin:'https://dsh.example.test',
    data:{ type:'aico-ppt:dsh-result', requestId:request.requestId, ok:true, result:'wrong' },
  });
  hostWindow.emit({
    source:targetWindow, origin:'https://other.example.test',
    data:{ type:'aico-ppt:dsh-result', requestId:request.requestId, ok:true, result:'wrong' },
  });
  hostWindow.emit({
    source:targetWindow, origin:'https://dsh.example.test',
    data:{ type:'aico-ppt:dsh-result', requestId:'other', ok:true, result:'wrong' },
  });
  hostWindow.emit({
    source:targetWindow, origin:'https://dsh.example.test',
    data:{
      type:'aico-ppt:dsh-result', requestId:request.requestId, ok:true,
      result:{ sessionId:'session-a' },
    },
  });

  assert.deepEqual(await resultPromise, { sessionId:'session-a' });
  unsubscribe();
  bridge.close();
  assert.equal(hostWindow.listeners.size, 0);
});

test('DSH 浏览器桥发布精确 Work Context，并幂等处理统一入口的创建请求', async () => {
  const hostWindow = new FakeWindow();
  const targetWindow = {
    sent:[],
    postMessage(message, origin) { this.sent.push({ message, origin }); },
  };
  const bridge = new DshWorkBridge({
    hostWindow,
    targetWindow,
    targetOrigin:'https://dsh.example.test/workbench',
    timeoutMs:1_000,
  });
  const current = {
    workId:'work-1', contextKey:'work-1:3', kind:'editing',
    displayName:'技术解析', projectRoot:'/project/deck', projectName:'deck',
  };
  const alternative = {
    workId:'work-2', contextKey:'work-2:7', kind:'creation',
    displayName:'季度汇报', projectRoot:'/project/report', projectName:'report',
  };
  bridge.publishWorkContext(current, [current, alternative]);
  assert.deepEqual(targetWindow.sent.at(-1), {
    message:{
      type:'aico-ppt:dsh-work-context',
      context:current,
      targets:[current, alternative],
    },
    origin:'https://dsh.example.test',
  });

  let calls = 0;
  bridge.registerWorkSessionCreator(async target => {
    calls += 1;
    assert.deepEqual(target, { workId:'work-1', contextKey:'work-1:3' });
    return { workId:'work-1', sessionId:'session-2' };
  });
  const request = {
    type:'aico-ppt:create-work-session-request', requestId:'request-1',
    workId:'work-1', contextKey:'work-1:3',
  };
  hostWindow.emit({ source:targetWindow, origin:'https://dsh.example.test', data:request });
  hostWindow.emit({ source:targetWindow, origin:'https://dsh.example.test', data:request });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls, 1, '重复投递同一个 requestId 不能创建两个任务会话');
  assert.equal(targetWindow.sent.at(-1).message.type, 'aico-ppt:create-work-session-result');
  assert.equal(targetWindow.sent.at(-1).message.ok, true);
  assert.equal(targetWindow.sent.at(-1).message.result.sessionId, 'session-2');

  let navigationCalls = 0;
  bridge.registerWorkSessionTargetNavigator(async target => {
    navigationCalls += 1;
    assert.deepEqual(target, { workId:'work-2', contextKey:'work-2:7' });
  });
  const navigationRequest = {
    type:'aico-ppt:navigate-work-session-target-request', requestId:'navigate-1',
    workId:'work-2', contextKey:'work-2:7',
  };
  hostWindow.emit({
    source:targetWindow, origin:'https://dsh.example.test', data:navigationRequest,
  });
  hostWindow.emit({
    source:targetWindow, origin:'https://dsh.example.test', data:navigationRequest,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(navigationCalls, 1, '重复导航请求不得让同一页面执行两次项目切换');
  hostWindow.emit({
    source:targetWindow, origin:'https://dsh.example.test', data:navigationRequest,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(navigationCalls, 1, '导航完成后迟到的重复请求也不得再次切换项目');
  bridge.close();
  assert.deepEqual(targetWindow.sent.at(-1).message, {
    type:'aico-ppt:dsh-work-context', context:null, targets:[],
  });
});

test('会话目标以当前任务优先，修改任务显示 Deck HTML 文件名', () => {
  const current = workItem(emptyBinding({ revision:4 }), {
    workId:'work-edit',
    displayName:'不应显示的目录名',
    deckName:'技术解析.html',
    deckPath:'/project/deck/技术解析.html',
  });
  const creation = {
    kind:'creation', workId:'work-create', revision:2,
    displayName:'季度汇报', projectRoot:'/project/report', projectName:'report',
  };
  assert.equal(describeDshWorkSessionTarget(current).displayName, '技术解析.html');
  assert.deepEqual(
    listDshWorkSessionTargets({ creation:[creation], editing:[current] }, 'work-edit')
      .map(target => target.workId),
    ['work-edit', 'work-create'],
  );
});

test('新会话先持久化 Link，DSH 打开成功后才激活', async () => {
  const calls = [];
  let current = workItem();
  const bridge = {
    async request(command, payload) {
      calls.push(['bridge', command, structuredClone(payload)]);
      if (command === 'ensure-workspace') {
        return { workspaceId:'workspace-project', path:'/project/deck', title:'deck' };
      }
      if (command === 'create-session' || command === 'open-session') {
        return { sessionId:payload.sessionId };
      }
      throw new Error(`未实现的 bridge 命令：${command}`);
    },
  };
  const catalogCommand = async (command, payload) => {
    calls.push(['catalog', command, structuredClone(payload)]);
    if (command === 'set-workspace') {
      current = workItem(emptyBinding({ revision:1, workspaceId:payload.workspaceId }));
    } else if (command === 'begin-session') {
      current = workItem(emptyBinding({
        revision:2,
        workspaceId:payload.workspaceId,
        pendingOperation:{
          operationId:payload.operationId,
          workspaceId:payload.workspaceId,
          sessionId:payload.sessionId,
          origin:'fresh',
          sourceSessionId:null,
          startedAt:'2026-09-03T00:00:00.000Z',
        },
      }));
    } else if (command === 'complete-session') {
      const pending = current.dshBinding.pendingOperation;
      current = workItem(emptyBinding({
        revision:3,
        workspaceId:pending.workspaceId,
        sessions:[{
          operationId:pending.operationId,
          sessionId:pending.sessionId,
          workspaceId:pending.workspaceId,
          origin:'fresh',
          state:'available',
          createdAt:pending.startedAt,
        }],
      }));
    } else if (command === 'activate-session') {
      current = workItem(emptyBinding({
        revision:4,
        workspaceId:current.dshBinding.workspaceId,
        activeSessionId:payload.sessionId,
        sessions:current.dshBinding.sessions,
      }));
    }
    return { workItem:structuredClone(current) };
  };
  const coordinator = new DeckTaskCoordinator({ bridge, catalogCommand });

  const result = await coordinator.createSession({ workItem:current });

  assert.equal(result.workItem.dshBinding.activeSessionId, result.sessionId);
  assert.deepEqual(calls.map(([side, command]) => `${side}:${command}`), [
    'bridge:ensure-workspace',
    'catalog:set-workspace',
    'catalog:begin-session',
    'bridge:create-session',
    'catalog:complete-session',
    'bridge:open-session',
    'catalog:activate-session',
  ]);
  const begun = calls.find(([, command]) => command === 'begin-session')[2];
  const created = calls.find(([, command]) => command === 'create-session')[2];
  assert.equal(created.sessionId, begun.sessionId, 'DSH 必须采用目录中预分配的 Session 身份');
  assert.equal(created.title, '修改 Deck：技术解析.html');
});

test('检测到 fresh pending 时只幂等补建原 Session，不再分配第二个身份', async () => {
  const calls = [];
  const pending = {
    operationId:'62222222-2222-4222-8222-222222222222',
    workspaceId:'workspace-project',
    sessionId:'session-preallocated',
    origin:'fresh',
    sourceSessionId:null,
    startedAt:'2026-09-03T00:00:00.000Z',
  };
  const initial = workItem(emptyBinding({
    revision:1,
    workspaceId:'workspace-project',
    pendingOperation:pending,
  }));
  const completed = workItem(emptyBinding({
    revision:2,
    workspaceId:'workspace-project',
    sessions:[{
      operationId:pending.operationId,
      sessionId:pending.sessionId,
      workspaceId:pending.workspaceId,
      origin:'fresh',
      state:'available',
      createdAt:pending.startedAt,
    }],
  }));
  const activated = workItem(emptyBinding({
    ...completed.dshBinding,
    revision:3,
    activeSessionId:'session-preallocated',
  }));
  const coordinator = new DeckTaskCoordinator({
    bridge:{
      async request(command, payload) {
        calls.push(['bridge', command, structuredClone(payload)]);
        if (command === 'ensure-workspace') return { workspaceId:'workspace-project' };
        return { sessionId:payload.sessionId };
      },
    },
    catalogCommand:async (command, payload) => {
      calls.push(['catalog', command, structuredClone(payload)]);
      if (command === 'complete-session') {
        assert.equal(payload.operationId, pending.operationId);
        return { workItem:structuredClone(completed) };
      }
      assert.equal(command, 'activate-session');
      assert.equal(payload.sessionId, pending.sessionId);
      return { workItem:structuredClone(activated) };
    },
  });

  const result = await coordinator.createSession({ workItem:initial });

  assert.equal(result.session.sessionId, 'session-preallocated');
  assert.deepEqual(calls.map(([side, command]) => `${side}:${command}`), [
    'bridge:ensure-workspace',
    'bridge:create-session',
    'catalog:complete-session',
    'bridge:open-session',
    'catalog:activate-session',
  ]);
  assert.equal(calls[1][2].title, '修改 Deck：技术解析.html');
});

test('已有 Workspace 关联时仍核验登记但不重复创建身份', async () => {
  const calls = [];
  const longDisplayName = '客户技术评审'.repeat(16);
  let current = workItem(emptyBinding({
    revision:1,
    workspaceId:'workspace-project',
    activeSessionId:'session-existing',
    sessions:[{
      operationId:'63333333-3333-4333-8333-333333333333',
      sessionId:'session-existing',
      workspaceId:'workspace-project',
      origin:'fresh',
      state:'available',
      createdAt:'2026-09-03T00:00:00.000Z',
    }],
  }), { displayName:longDisplayName });
  const coordinator = new DeckTaskCoordinator({
    bridge:{
      async request(command, payload) {
        calls.push(['bridge', command, structuredClone(payload)]);
        if (command === 'ensure-workspace') {
          return { workspaceId:'workspace-project' };
        }
        if (command === 'ensure-workspace') return { workspaceId:'workspace-project' };
        return { sessionId:payload.sessionId };
      },
    },
    catalogCommand:async (command, payload) => {
      calls.push(['catalog', command, structuredClone(payload)]);
      if (command === 'begin-session') {
        current = workItem(emptyBinding({
          revision:2,
          workspaceId:'workspace-project',
          activeSessionId:'session-existing',
          sessions:current.dshBinding.sessions,
          pendingOperation:{
            operationId:payload.operationId,
            workspaceId:payload.workspaceId,
            sessionId:payload.sessionId,
            origin:'fresh',
            sourceSessionId:null,
            startedAt:'2026-09-03T00:01:00.000Z',
          },
        }), { displayName:longDisplayName });
      } else if (command === 'complete-session') {
        const pending = current.dshBinding.pendingOperation;
        current = workItem(emptyBinding({
          revision:3,
          workspaceId:'workspace-project',
          activeSessionId:'session-existing',
          sessions:[...current.dshBinding.sessions, {
            operationId:pending.operationId,
            sessionId:pending.sessionId,
            workspaceId:pending.workspaceId,
            origin:'fresh',
            state:'available',
            createdAt:pending.startedAt,
          }],
        }), { displayName:longDisplayName });
      } else if (command === 'activate-session') {
        current = workItem(emptyBinding({
          ...current.dshBinding,
          revision:4,
          activeSessionId:payload.sessionId,
        }), { displayName:longDisplayName });
      }
      return { workItem:structuredClone(current) };
    },
  });

  const result = await coordinator.createSession({ workItem:current });

  assert.equal(result.workItem.dshBinding.sessions.length, 2);
  assert.deepEqual(calls.map(([side, command]) => `${side}:${command}`), [
    'bridge:ensure-workspace',
    'catalog:begin-session',
    'bridge:create-session',
    'catalog:complete-session',
    'bridge:open-session',
    'catalog:activate-session',
  ]);
  const created = calls.find(([, command]) => command === 'create-session')[2];
  assert.match(created.title, /^修改 Deck：客户技术评审/u);
  assert.match(created.title, / · 会话 2$/u);
  assert.ok(new TextEncoder().encode(created.title).byteLength <= 80);
});

test('激活旧关联会话时携带中文任务标题，但由 DSH 只补尚未命名的会话', async () => {
  const calls = [];
  const current = workItem(emptyBinding({
    revision:1,
    workspaceId:'workspace-project',
    activeSessionId:'session-existing',
    sessions:[{
      operationId:'64444444-4444-4444-8444-444444444444',
      sessionId:'session-existing',
      workspaceId:'workspace-project',
      origin:'fresh',
      state:'available',
      createdAt:'2026-09-03T00:00:00.000Z',
    }],
  }));
  const coordinator = new DeckTaskCoordinator({
    bridge:{
      async request(command, payload) {
        calls.push([command, structuredClone(payload)]);
        if (command === 'ensure-workspace') return { workspaceId:'workspace-project' };
        return { sessionId:payload.sessionId };
      },
    },
    catalogCommand:async () => { throw new Error('活动会话不应重复写目录'); },
  });

  await coordinator.activate({ workItem:current });

  assert.deepEqual(calls, [['ensure-workspace', { path:current.projectRoot }], [
    'open-session',
    { sessionId:'session-existing', workspaceId:'workspace-project', title:'修改 Deck：技术解析.html' },
  ]]);
});

test('目标会话打开失败时保留原活动会话', async () => {
  const calls = [];
  let current = workItem(emptyBinding({
    revision:2,
    workspaceId:'workspace-project',
    activeSessionId:'session-a',
    sessions:[
      {
        operationId:'66111111-1111-4111-8111-111111111111',
        sessionId:'session-a', workspaceId:'workspace-project', origin:'fresh',
        state:'available', createdAt:'2026-09-03T00:00:00.000Z',
      },
      {
        operationId:'66222222-2222-4222-8222-222222222222',
        sessionId:'session-b', workspaceId:'workspace-project', origin:'fresh',
        state:'available', createdAt:'2026-09-03T00:01:00.000Z',
      },
    ],
  }));
  const coordinator = new DeckTaskCoordinator({
    bridge:{
      async request(command, payload) {
        calls.push(['bridge', command, structuredClone(payload)]);
        if (command === 'ensure-workspace') return { workspaceId:'workspace-project' };
        throw new Error('DSH 会话打开失败');
      },
    },
    catalogCommand:async (command, payload) => {
      calls.push(['catalog', command, structuredClone(payload)]);
      current = workItem(emptyBinding({
        ...current.dshBinding,
        revision:current.dshBinding.revision + 1,
        activeSessionId:payload.sessionId,
      }));
      return { workItem:structuredClone(current) };
    },
  });

  await assert.rejects(
    () => coordinator.activate({ workItem:current, sessionId:'session-b' }),
    /DSH 会话打开失败/u,
  );

  assert.equal(current.dshBinding.activeSessionId, 'session-a');
  assert.deepEqual(calls.map(([side, command]) => `${side}:${command}`), [
    'bridge:ensure-workspace',
    'bridge:open-session',
  ]);
});

test('旧关联会话缺少 DSH 列表行时仍可立即生成中文展示标题', () => {
  const current = workItem(emptyBinding({
    revision:1,
    workspaceId:'workspace-project',
    activeSessionId:'session-existing',
    sessions:[{
      operationId:'65555555-5555-4555-8555-555555555555',
      sessionId:'session-existing',
      workspaceId:'workspace-project',
      origin:'fresh',
      state:'available',
      createdAt:'2026-09-03T00:00:00.000Z',
    }],
  }), { displayName:'示例 Deck' });
  const coordinator = new DeckTaskCoordinator({
    bridge:{ request:async () => { throw new Error('生成展示标题不应请求 DSH'); } },
    catalogCommand:async () => { throw new Error('生成展示标题不应修改 WorkCatalog'); },
  });

  const result = coordinator.sessionTitle({ workItem:current });

  assert.equal(result, '修改 Deck：示例 Deck');
});
