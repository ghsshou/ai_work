import test from 'node:test';
import assert from 'node:assert/strict';
import { connectEvents } from '../public/ws-client.mjs';

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];
  static active = 0;
  static maxActive = 0;

  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.listeners = new Map();
    this.closeCalls = 0;
    FakeWebSocket.instances.push(this);
    FakeWebSocket.active += 1;
    FakeWebSocket.maxActive = Math.max(FakeWebSocket.maxActive, FakeWebSocket.active);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    if (type === 'open') this.readyState = FakeWebSocket.OPEN;
    if (type === 'close' && this.readyState !== 3) {
      this.readyState = 3;
      FakeWebSocket.active -= 1;
    }
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close() {
    this.closeCalls += 1;
    this.emit('close');
  }

  send() {}
}

function fakeScheduler() {
  const timers = [];
  return {
    timers,
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, ran: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      if (timer) timer.cleared = true;
    },
    run(timer) {
      assert.equal(timer.cleared, false);
      timer.ran = true;
      timer.callback();
    },
  };
}

function resetSockets() {
  FakeWebSocket.instances = [];
  FakeWebSocket.active = 0;
  FakeWebSocket.maxActive = 0;
}

test('connectEvents 按硬契约退避且任一时刻只有一个连接', () => {
  resetSockets();
  const scheduler = fakeScheduler();
  const states = [];
  connectEvents({
    url: 'ws://127.0.0.1/events?editorToken=editor',
    token: 'deck-token',
    onState: state => states.push(state),
    WebSocketImpl: FakeWebSocket,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });

  assert.deepEqual(states, ['offline']);
  assert.equal(FakeWebSocket.instances.length, 1);
  const expectedDelays = [250, 500, 1000, 2000, 5000];
  for (const [index, delay] of expectedDelays.entries()) {
    FakeWebSocket.instances.at(-1).emit('close');
    const timer = scheduler.timers.at(-1);
    assert.equal(timer.delay, delay, `第 ${index + 1} 次重连`);
    scheduler.run(timer);
  }
  assert.equal(FakeWebSocket.maxActive, 1);
  const connected = FakeWebSocket.instances.at(-1);
  connected.emit('open');
  assert.deepEqual(states, ['offline', 'online']);
  connected.emit('close');
  assert.deepEqual(states, ['offline', 'online', 'offline']);
  assert.equal(scheduler.timers.at(-1).delay, 250, '成功连接后重置退避序列');
});

test('connectEvents close 幂等清理 timer、关闭 socket 且永不重连', () => {
  resetSockets();
  const scheduler = fakeScheduler();
  const client = connectEvents({
    url: 'ws://127.0.0.1/events',
    token: 'deck-token',
    WebSocketImpl: FakeWebSocket,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });
  const socket = FakeWebSocket.instances[0];
  socket.emit('close');
  const timer = scheduler.timers[0];

  client.close();
  client.close();
  assert.equal(timer.cleared, true);
  assert.equal(socket.closeCalls, 1);
  timer.callback();
  assert.equal(FakeWebSocket.instances.length, 1);
});

test('连接诊断区分握手、断线和重连且不泄露 URL 或关闭文本', () => {
  resetSockets();
  const scheduler = fakeScheduler(), records = [];
  const client = connectEvents({ url:'ws://localhost/events?editorToken=secret', token:'secret',
    onDiagnostic:record => records.push(record), WebSocketImpl:FakeWebSocket,
    setTimer:scheduler.setTimer, clearTimer:scheduler.clearTimer });
  FakeWebSocket.instances.at(-1).emit('open');
  FakeWebSocket.instances.at(-1).emit('close', {code:1006, reason:'secret', wasClean:false});
  scheduler.run(scheduler.timers.at(-1));
  assert.deepEqual(records.map(x => x.event), ['connecting','open','close','reconnect-scheduled','connecting']);
  assert.equal(records.find(x => x.event === 'close').code,1006);
  assert.equal(records.find(x => x.event === 'reconnect-scheduled').delayMs,250);
  assert.ok(!JSON.stringify(records).includes('secret'));
  client.close();
});
