import assert from 'node:assert/strict';
import test from 'node:test';

import { createDshAgentRunAdapter } from '../dsh-agent-run-adapter.mjs';

const context = overrides => ({
  deckPath:'/tmp/working/deck.html',
  sourceDeckPath:'/tmp/source/deck.html',
  projectPath:'/tmp/project',
  serviceUrl:'http://127.0.0.1:4100',
  token:'secret',
  creationContextPath:null,
  taskIds:['task-1'],
  signal:new AbortController().signal,
  onProgress() {},
  ...overrides,
});

test('DSH 适配器发布规范提示词，并以原任务状态完成批次', async () => {
  const session = { tasks:[{ id:'task-1', status:'pending' }] };
  let published;
  const adapter = createDshAgentRunAdapter({
    getSession:() => session,
    getAssignedSessionId:() => 'session-deck',
    publishRequest:value => { published = value; },
    acknowledgementTimeoutMs:1_000,
    runTimeoutMs:1_000,
  });
  const running = adapter.run(context());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof published.requestId, 'string');
  assert.equal(published.assignedSessionId, 'session-deck');
  assert.match(published.prompt, /^AICO-PPT 区域编辑任务/u);
  assert.doesNotMatch(published.prompt,/首次处理必须|先完整读取/);
  assert.doesNotMatch(published.prompt, /^\$aico-ppt/u);
  assert.match(published.prompt, /task-1/u);
  assert.match(published.prompt, /http:\/\/127\.0\.0\.1:4100/u);
  assert.deepEqual(adapter.acknowledge({
    requestId:published.requestId, accepted:true,
  }), { accepted:true });
  session.tasks[0].status = 'completed';
  assert.deepEqual(await running, {
    mode:'dsh', summary:'DSH Agent 已完成本批处理，请检查页面结果',
  });
  adapter.close();
});

test('DSH 适配器把父页面提交失败返回为稳定错误', async () => {
  let published;
  const adapter = createDshAgentRunAdapter({
    getSession:() => ({ tasks:[{ id:'task-1', status:'pending' }] }),
    getAssignedSessionId:() => 'session-deck',
    publishRequest:value => { published = value; },
    acknowledgementTimeoutMs:1_000,
    runTimeoutMs:1_000,
  });
  const running = adapter.run(context());
  await new Promise(resolve => setImmediate(resolve));
  adapter.acknowledge({
    requestId:published.requestId, accepted:false, message:'当前会话忙',
  });
  await assert.rejects(running, error => (
    error.code === 'DSH_AGENT_SUBMISSION_FAILED' && /当前会话忙/u.test(error.message)
  ));
  assert.throws(() => adapter.acknowledge({
    requestId:published.requestId, accepted:true,
  }), error => error.code === 'DSH_REQUEST_NOT_FOUND');
  adapter.close();
});

test('DSH 适配器关闭时结算仍在等待的请求', async () => {
  const adapter = createDshAgentRunAdapter({
    getSession:() => ({ tasks:[] }),
    getAssignedSessionId:() => 'session-deck',
    publishRequest() {},
    acknowledgementTimeoutMs:1_000,
    runTimeoutMs:1_000,
  });
  const running = adapter.run(context());
  adapter.close();
  await assert.rejects(running, /适配器已关闭/u);
  adapter.close();
});

test('DSH 适配器发布失败时立即清理等待项并透传错误', async () => {
  const failure = new Error('父页面消息通道不可用');
  const adapter = createDshAgentRunAdapter({
    getSession:() => ({ tasks:[] }),
    getAssignedSessionId:() => 'session-deck',
    publishRequest() { throw failure; },
    acknowledgementTimeoutMs:1_000,
    runTimeoutMs:1_000,
  });
  await assert.rejects(adapter.run(context()), error => error === failure);
  adapter.close();
});
