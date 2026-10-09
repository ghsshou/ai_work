/** 通过当前桌面宿主的私有渲染会话读取页面；不接触主窗口或宿主凭据环境。 */
import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const expression = (fn, arg) => typeof fn === 'string' ? fn : `(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})`;

/** 创建与验证脚本共用的页面操作接口，连接断开即释放所属页面。 */
export async function connectDesktopRenderer(home = process.env.AICO_HOME) {
  if (!home) throw new Error('缺少 AICO_HOME，无法连接桌面渲染服务');
  let capability;
  try {
    const file = join(home, 'desktop-renderer.json');
    const info = await stat(file);
    if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('能力文件权限无效');
    capability = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) { throw new Error('桌面渲染服务不可用，请启动或升级 AICO 桌面版', { cause:error }); }
  if (capability.schema !== 1 || capability.host !== '127.0.0.1' || !Number.isInteger(capability.port)
    || capability.port < 1 || capability.port > 65535 || !/^[a-f0-9]{64}$/.test(capability.token)) throw new Error('桌面渲染服务描述无效');
  const socket = connect(capability.port, capability.host);
  const requests = new Map(), pages = new Map();
  let next = 0, chunks = [], bytes = 0, closed = false;
  const fail = () => {
    closed = true;
    chunks = []; bytes = 0;
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error('桌面渲染连接已关闭')); }
    requests.clear();
  };
  socket.on('error', fail);
  socket.on('close', fail);
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf('\n', offset);
      const part = chunk.slice(offset, end === -1 ? undefined : end);
      bytes += Buffer.byteLength(part);
      if (bytes > 64 * 1024 * 1024) { socket.destroy(); return; }
      chunks.push(part);
      if (end === -1) return;
      const line = chunks.join(''); chunks = []; bytes = 0;
      offset = end + 1;
      let result;
      try { result = JSON.parse(line); } catch { socket.destroy(); return; }
      if (result.event === 'pageerror') { pages.get(result.page)?.emit('pageerror', Object.assign(new Error(result.error.message), { name:result.error.name })); continue; }
      const request = requests.get(result.id);
      if (!request) continue;
      requests.delete(result.id); clearTimeout(request.timer);
      if (result.error) request.reject(new Error(result.error));
      else request.resolve(result.value);
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('连接桌面渲染服务超时')); }, 5000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const call = (method, args = {}, timeout = 180_000) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('桌面渲染连接已关闭')); return; }
    const id = ++next;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('桌面渲染操作超时')); socket.destroy(); }, timeout);
    requests.set(id, { resolve, reject, timer });
    socket.write(JSON.stringify({ id, token:capability.token, method, args }) + '\n');
  });
  const browser = {
    _connection:{ close:() => socket.destroy() },
    async newPage(options = {}) {
      const id = await call('newPage', options);
      const page = new EventEmitter();
      let pageClosed = false;
      const invoke = (method, args) => call(method, { page:id, ...args });
      Object.assign(page, {
        goto:(url, options) => invoke('goto', { url, options }),
        evaluate:(fn, arg) => invoke('evaluate', { code:expression(fn, arg) }),
        addStyleTag:({content}) => invoke('style', { content }),
        async addScriptTag({path, content}) { return invoke('evaluate', { code:content ?? await readFile(path, 'utf8') }); },
        waitForTimeout:ms => new Promise(resolve => setTimeout(resolve, ms)),
        async waitForFunction(fn, arg, options = {}) {
          const deadline = Date.now() + (options.timeout ?? 60_000);
          while (!await page.evaluate(fn, arg)) {
            if (Date.now() >= deadline) throw Object.assign(new Error('等待页面条件超时'), { name:'TimeoutError' });
            await page.waitForTimeout(50);
          }
        },
        waitForSelector:(selector, options = {}) => page.waitForFunction(value => Boolean(document.querySelector(value)), selector, options),
        async $$(selector) {
          const count = await page.evaluate(value => document.querySelectorAll(value).length, selector);
          return Array.from({ length:count }, (_, index) => ({
            evaluate:(fn, arg) => invoke('evaluate', { code:`(${fn.toString()})(document.querySelectorAll(${JSON.stringify(selector)})[${index}],${JSON.stringify(arg) ?? 'undefined'})` }),
            scrollIntoViewIfNeeded:() => page.evaluate(({selector,index}) => document.querySelectorAll(selector)[index].scrollIntoView({block:'center',inline:'center'}), {selector,index}),
            screenshot:options => page.screenshot({...options,selector,index}),
          }));
        },
        async screenshot(options = {}) {
          if (options.omitBackground && capability.features?.screenshotOmitBackground !== 1) {
            throw new Error('当前桌面版不支持可编辑 PPTX 所需的透明截图，请升级 AICO 桌面版；也可选择高清图片 PPTX');
          }
          const {path, ...settings} = options;
          const data = Buffer.from(await invoke('screenshot', {options:settings}), 'base64');
          if (path) await writeFile(path, data);
          return data;
        },
        isClosed:() => closed || pageClosed,
        async close() { if (closed || pageClosed) return; pageClosed = true; await invoke('closePage'); pages.delete(id); },
      });
      pages.set(id, page);
      return page;
    },
    async close() {
      if (closed) return;
      await Promise.allSettled([...pages.values()].map(page => page.close()));
      socket.end();
      await new Promise(resolve => { if (socket.destroyed) resolve(); else socket.once('close', resolve); });
    },
  };
  return browser;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--check') {
  let browser;
  try {
    browser = await connectDesktopRenderer();
    const page = await browser.newPage({ viewport:{ width:64, height:64 } });
    if (await page.evaluate(() => 6 * 7) !== 42) throw new Error('桌面渲染服务响应无效');
    console.log('桌面渲染服务可用（Electron 隔离页面）');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await browser?.close(); }
}
