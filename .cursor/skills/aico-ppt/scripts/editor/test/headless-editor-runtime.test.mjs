import assert from 'node:assert/strict';
import test from 'node:test';

import { startHeadlessEditorRuntime } from '../headless-editor-runtime.mjs';

test('headless runtime 复用 Editor 页面并在关闭时跳过 beforeunload', async () => {
  const calls = [];
  const handlers = new Map();
  let pageClosed = false;
  const page = {
    on(type, handler) { handlers.set(type, handler); },
    async goto(url, options) { calls.push(['goto', url, options]); },
    async waitForSelector(selector, options) { calls.push(['wait', selector, options]); },
    isClosed() { return pageClosed; },
    async close(options) { calls.push(['page-close', options]); pageClosed = true; },
  };
  const browser = {
    async newPage(options) { calls.push(['new-page', options]); return page; },
    async close() { calls.push(['browser-close']); },
  };
  const runtime = await startHeadlessEditorRuntime({
    editorUrl:'http://127.0.0.1:3210/editor/?token=a&editorToken=b',
    readyTimeoutMs:1234,
    loadChromium:async () => ({
      async launch(options) { calls.push(['launch', options]); return browser; },
    }),
  });

  assert.deepEqual(calls.slice(0, 5), [
    ['launch', { channel:'chrome', headless:true }],
    ['new-page', { viewport:{ width:1440, height:900 } }],
    ['goto', 'http://127.0.0.1:3210/editor/?token=a&editorToken=b', {
      waitUntil:'domcontentloaded', timeout:1234,
    }],
    ['wait', '#deck-frame', { timeout:1234 }],
    ['wait', '[data-page-key]', { state:'attached', timeout:1234 }],
  ]);
  let accepted = false;
  handlers.get('dialog')({
    type:() => 'beforeunload',
    accept:async () => { accepted = true; },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(accepted, true);

  await runtime.close();
  await runtime.close();
  assert.deepEqual(calls.slice(-2), [
    ['page-close', { runBeforeUnload:false }],
    ['browser-close'],
  ]);
});

test('headless runtime 页面加载失败时有界关闭浏览器', async () => {
  let browserClosed = 0;
  const page = {
    on() {},
    async goto() { throw new Error('load failed'); },
    isClosed:() => false,
    async close() {},
  };
  await assert.rejects(() => startHeadlessEditorRuntime({
    editorUrl:'http://127.0.0.1:3210/editor/',
    loadChromium:async () => ({
      async launch() {
        return {
          newPage:async () => page,
          close:async () => { browserClosed += 1; },
        };
      },
    }),
  }), /load failed/);
  assert.equal(browserClosed, 1);
});
