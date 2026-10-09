import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import test from 'node:test';

import { loadChromium } from '../../verify/load-playwright.mjs';
import { startFixtureServer } from './test-helpers.mjs';

async function closeHttpServer(server) {
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function settleWithin(promise, timeoutMs = 2_000) {
  await Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise(resolve => setTimeout(resolve, timeoutMs)),
  ]);
}

test('DSH 嵌入态点击退出编辑器会收起父级工作台且保留 Host 运行时', {
  timeout:12_000,
}, async t => {
  const editor = await startFixtureServer({ dshAgentBridge:true });
  let editorUrl = '';
  const parent = createHttpServer((_request, response) => {
    response.writeHead(200, {
      'content-type':'text/html; charset=utf-8',
      'cache-control':'no-store',
    });
    response.end(`<!doctype html>
      <html data-workbench="open"><body>
        <iframe id="editor" src=${JSON.stringify(editorUrl)}></iframe>
        <script>
          const frame = document.querySelector('#editor');
          window.addEventListener('message', event => {
            if (event.source !== frame.contentWindow
              || event.data?.type !== 'aico-ppt:close-workbench') return;
            document.documentElement.dataset.workbench = 'closed';
            frame.remove();
          });
        <\/script>
      </body></html>`);
  });
  parent.listen(0, '127.0.0.1');
  await once(parent, 'listening');
  const address = parent.address();
  assert.ok(address && typeof address === 'object');
  const parentUrl = `http://127.0.0.1:${address.port}`;
  editorUrl = `${editor.url}/?token=${encodeURIComponent(editor.token)}`
    + `&editorToken=${encodeURIComponent(editor.editorToken)}`
    + `&embedded=dsh&parentOrigin=${encodeURIComponent(parentUrl)}`;

  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(async () => {
    await settleWithin(browser.close());
    await settleWithin(closeHttpServer(parent));
    await settleWithin(editor.close());
  });

  const page = await browser.newPage({ viewport:{ width:1440, height:900 } });
  const shutdownRequests = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/shutdown') {
      shutdownRequests.push(request.url());
    }
  });
  await page.goto(parentUrl);
  const embeddedEditor = page.frameLocator('#editor');
  await embeddedEditor.locator('#deck-frame').waitFor({ timeout:6_000 });
  await embeddedEditor.getByRole('button', { name:'关闭 AICO-PPT 工作台' })
    .evaluate(button => button.click());

  const workbenchClosed = await page.waitForFunction(() => (
    document.documentElement.dataset.workbench === 'closed'
    && document.querySelector('#editor') === null
  ), null, { timeout:2_000 }).then(() => true, () => false);
  assert.equal(workbenchClosed, true,
    `关闭工作台后父级没有收到 aico-ppt:close-workbench，右侧仍显示已断开的 iframe；`
      + `shutdown 请求数=${shutdownRequests.length}`);

  assert.equal(shutdownRequests.length, 0,
    'DSH 嵌入态只关闭工作台，不得请求关闭 Host 持有的 Editor Runtime');

  const sessionResponse = await fetch(
    `${editor.url}/api/session?token=${encodeURIComponent(editor.token)}`,
  );
  assert.equal(sessionResponse.ok, true, '关闭 DSH 工作台不能终止 Host 持有的 Editor Runtime');
});
