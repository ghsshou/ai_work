import { loadChromium as loadDefaultChromium, chromiumLaunchOptions } from '../verify/load-playwright.mjs';

async function settleWithin(promise, timeoutMs) {
  let timer;
  const settled = await Promise.race([
    Promise.resolve(promise).then(() => true, () => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  clearTimeout(timer);
  return settled;
}

/**
 * 在无可见窗口的 Chrome 中挂载与 Editor 相同的 frame bridge。
 *
 * 这里刻意不复制 ActionMutation、诊断或固化逻辑：headless 与 visible
 * Editor 都连接同一个服务端 BridgeService，只是浏览器承载方式不同。
 */
export async function startHeadlessEditorRuntime({
  editorUrl,
  loadChromium = loadDefaultChromium,
  readyTimeoutMs = 20_000,
  viewport = { width:1440, height:900 },
} = {}) {
  if (typeof editorUrl !== 'string' || !editorUrl) {
    throw new TypeError('headless Editor 缺少 editorUrl');
  }
  if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1) {
    throw new TypeError('readyTimeoutMs 必须为正整数');
  }
  const chromium = await loadChromium();
  const browser = await chromium.launch(chromiumLaunchOptions());
  let page;
  let closePromise;
  const close = () => {
    closePromise ??= (async () => {
      if (page && !page.isClosed()) {
        const pageClosed = await settleWithin(
          page.close({ runBeforeUnload:false }), 3_000,
        );
        if (!pageClosed) {
          browser._connection?.close();
          return;
        }
      }
      const browserClosed = await settleWithin(browser.close(), 5_000);
      if (!browserClosed) browser._connection?.close();
    })();
    return closePromise;
  };
  try {
    page = await browser.newPage({ viewport });
    page.on('dialog', dialog => {
      if (dialog.type() === 'beforeunload') void dialog.accept().catch(() => {});
    });
    await page.goto(editorUrl, { waitUntil:'domcontentloaded', timeout:readyTimeoutMs });
    await page.waitForSelector('#deck-frame', { timeout:readyTimeoutMs });
    await page.waitForSelector('[data-page-key]', { state:'attached', timeout:readyTimeoutMs });
    return { browser, page, close };
  } catch (error) {
    await close();
    throw error;
  }
}
