import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { startRuntimeWorker } from '../runtime-host.mjs';
import { runtimeFixture } from './runtime-fixture.mjs';

async function installedFixture(t, appSource) {
  const runtime = await runtimeFixture(t);
  const integration = join(runtime.root, 'package', 'integrations', 'dsh');
  const editor = join(runtime.root, 'package', 'scripts', 'editor');
  await mkdir(integration, { recursive:true });
  await mkdir(editor, { recursive:true });
  for (const name of ['runtime-host.mjs', 'runtime-worker.mjs', 'runtime-env.mjs']) {
    await copyFile(new URL('../' + name, import.meta.url), join(integration, name));
  }
  await writeFile(join(editor, 'app-server.mjs'), appSource);
  // Worker 的模块加载边界包含桌面保存能力；本夹具不启动实际编辑器或文件选择器。
  await writeFile(join(editor, 'server.mjs'), 'export const startServer = () => { throw new Error("夹具不应启动编辑器"); };');
  await writeFile(join(editor, 'system-picker.mjs'), 'export const pickPptxSaveWithSystemPicker = () => { throw new Error("夹具不应打开文件选择器"); };');
  const { startRuntimeWorker:start } = await import(pathToFileURL(join(integration, 'runtime-host.mjs')));
  return { runtime, start };
}

test('Worker 启动原 Editor 并在关闭后释放实际监听端口', async t => {
  const runtime = await runtimeFixture(t);
  const worker = await startRuntimeWorker(runtime, {
    environment:{ ...process.env, AICO_PPT_EDITOR_STATE_ROOT:join(runtime.root, 'data') },
  });
  t.after(() => worker.close());
  assert.match(worker.appUrl, /^http:\/\/127\.0\.0\.1:\d+\/app\//);
  const views = await worker.transportViews();
  assert.equal(views.length, 1);
  assert.equal(views[0].origin, new URL(worker.appUrl).origin);
  assert.equal(views[0].kind, 'app');
  const lifecycle=await worker.restartStatus();
  assert.equal(lifecycle.safe,true);
  assert.match(lifecycle.version,/^0\.1\./);
  assert.deepEqual(lifecycle.reasons,[]);
  const response = await fetch(worker.appUrl);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  await worker.close();
  await worker.done;
  await assert.rejects(worker.transportViews(), /关闭/);
  await assert.rejects(worker.restartStatus(), /关闭/);
  await assert.rejects(fetch(worker.appUrl));
  await worker.close();
});

test('真实诊断请求使用 Worker 的私有 Python 与静态默认环境', { skip:process.platform === 'win32' }, async t => {
  const runtime = await runtimeFixture(t);
  await writeFile(runtime.paths.python, `#!${process.execPath}\nconsole.log(JSON.stringify({python:process.env.PYTHON,browser:process.env.AICO_BROWSER_EXECUTABLE,office:process.env.AICO_SOFFICE_EXECUTABLE,kind:process.env.AICO_RUNTIME_KIND,state:process.env.AICO_PPT_EDITOR_STATE_ROOT,pythonPath:process.env.PYTHONPATH,secret:process.env.AICO_PLUGIN_BRIDGE_TOKEN}));\n`, { mode:0o755 });
  const before = { ...process.env };
  const worker = await startRuntimeWorker(runtime, { environment:{
    ...process.env, PYTHON:'/host/python', PYTHONPATH:'/host/modules', AICO_SOFFICE_EXECUTABLE:'/old/soffice',
    AICO_PPT_EDITOR_STATE_ROOT:join(runtime.root, 'data'), AICO_PLUGIN_BRIDGE_TOKEN:'host-secret',
  } });
  t.after(() => worker.close());
  const url = new URL(worker.appUrl);
  url.pathname = '/api/diagnostics';
  const response = await fetch(url);
  const diagnostics = await response.json();
  assert.equal(response.status, 200, JSON.stringify(diagnostics));
  assert.deepEqual(diagnostics.environment, {
    python:runtime.paths.python,
    kind:'desktop', state:join(runtime.root, 'data'), delivery:'desktop',
  });
  assert.equal(diagnostics.installation.delivery, 'desktop');
  assert.deepEqual({ ...process.env }, before);
});

test('Worker 启动异常拒绝启动，启动后的崩溃通过 done 报告', async t => {
  const failed = await installedFixture(t, `export async function startAppServer() { throw Error('启动失败标记') }`);
  await assert.rejects(failed.start(failed.runtime), /启动失败标记/);
  const crashed = await installedFixture(t, `import {createServer} from 'node:http';
export async function startAppServer() {
  const server=createServer(()=>{queueMicrotask(()=>{throw Error('崩溃标记')})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {appUrl:'http://127.0.0.1:'+server.address().port+'/app/',close:()=>new Promise(resolve=>server.close(resolve))};
}`);
  const worker = await crashed.start(crashed.runtime);
  await assert.rejects(fetch(worker.appUrl));
  await assert.rejects(worker.done, /崩溃标记/);
  await assert.rejects(worker.close(), /崩溃标记/);
});

test('关闭期间的异常退出不能报告成功', async t => {
  const { runtime, start } = await installedFixture(t, `export async function startAppServer() {
    return {appUrl:'http://127.0.0.1:12345/app/',close:()=>process.exit(9)};
  }`);
  const worker = await start(runtime);
  await assert.rejects(worker.close(), /退出.*9/);
});

test('Editor 拒绝结束时，关闭在期限后等待 Worker 强制退出并释放端口', async t => {
  const { runtime, start } = await installedFixture(t, `import {createServer} from 'node:http';
export async function startAppServer() {
  const server=createServer((request,response)=>response.end('active'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {appUrl:'http://127.0.0.1:'+server.address().port+'/app/',close:()=>new Promise(()=>{})};
}`);
  const worker = await start(runtime);
  await assert.rejects(worker.close(), /关闭超时/);
  await worker.done;
  await assert.rejects(fetch(worker.appUrl));
});
