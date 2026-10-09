import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { CodexAppServerClient } from '../agent-workspace/codex-app-server-client.mjs';

function fakeChild(onRequest) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdin.end = () => queueMicrotask(() => child.emit('close', 0));
  child.stdin.write = data => {
    for (const line of String(data).trim().split('\n')) {
      if (line) onRequest?.(child, JSON.parse(line));
    }
    return true;
  };
  child.kill = () => queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  return child;
}

function respond(child, request, result) {
  child.stdout.emit('data', `${JSON.stringify({ id:request.id, result })}\n`);
}

test('initialize 只执行一次，随后发送 initialized 通知', async () => {
  const messages = [];
  const child = fakeChild((target, request) => {
    messages.push(request);
    if (request.method === 'initialize') respond(target, request, { userAgent:'fake' });
  });
  const client = await CodexAppServerClient.start({ spawnProcess:() => child });
  assert.equal(messages.filter(message => message.method === 'initialize').length, 1);
  assert.ok(messages.some(message => message.method === 'initialized' && !('id' in message)));
  await client.close();
});

test('并发请求乱序返回仍按 ID 匹配，notification 不占用 pending', async () => {
  const requests = [];
  const notifications = [];
  const child = fakeChild((target, request) => {
    if (request.method === 'initialize') return respond(target, request, {});
    if ('id' in request) requests.push(request);
  });
  const client = await CodexAppServerClient.start({ spawnProcess:() => child });
  client.onNotification(notification => notifications.push(notification));
  const first = client.request('thread/read', { threadId:'a' });
  const second = client.request('thread/read', { threadId:'b' });
  child.stdout.emit('data', `${JSON.stringify({ method:'turn/started', params:{ turn:{ id:'t' } } })}\n`);
  respond(child, requests[1], { value:'second' });
  respond(child, requests[0], { value:'first' });

  assert.deepEqual(await first, { value:'first' });
  assert.deepEqual(await second, { value:'second' });
  assert.equal(notifications[0].method, 'turn/started');
  await client.close();
});

test('单请求超时不关闭 client，协议损坏才拒绝全部 pending', async () => {
  const requests = [];
  const child = fakeChild((target, request) => {
    if (request.method === 'initialize') return respond(target, request, {});
    requests.push(request);
    if (request.method === 'thread/list') {
      queueMicrotask(() => respond(target, request, { data:[] }));
    }
  });
  const client = await CodexAppServerClient.start({
    spawnProcess:() => child,
    requestTimeoutMs:20,
  });
  await assert.rejects(
    () => client.request('thread/read', { threadId:'missing' }),
    error => error.code === 'CODEX_APP_SERVER_TIMEOUT',
  );
  assert.deepEqual(await client.request('thread/list', {}), { data:[] });

  const pending = client.request('thread/read', { threadId:'pending' });
  child.stdout.emit('data', 'not-json\n');
  await assert.rejects(pending, error => error.code === 'CODEX_APP_SERVER_PROTOCOL');
  await client.close();
});

test('server request 单独分发并可回应，close 幂等拒绝后续请求', async () => {
  const writes = [];
  const child = fakeChild((target, request) => {
    writes.push(request);
    if (request.method === 'initialize') respond(target, request, {});
  });
  const client = await CodexAppServerClient.start({ spawnProcess:() => child });
  client.onServerRequest(async request => {
    assert.equal(request.method, 'item/tool/requestUserInput');
    return { answers:{} };
  });
  child.stdout.emit('data', `${JSON.stringify({
    id:99, method:'item/tool/requestUserInput', params:{ questions:[] },
  })}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes.find(message => message.id === 99), { id:99, result:{ answers:{} } });

  await Promise.all([client.close(), client.close()]);
  await assert.rejects(
    () => client.request('thread/list', {}),
    error => error.code === 'CODEX_APP_SERVER_CLOSED',
  );
});
