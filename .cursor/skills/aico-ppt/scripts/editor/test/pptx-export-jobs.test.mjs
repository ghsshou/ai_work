import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pptx-export-job-')));
  const project = join(root, '项目目录');
  await mkdir(project);
  const deckPath = join(root, '演示.html');
  await writeFile(deckPath, '原始 Deck');
  const app = await startServer({ deckPath, token:'test', editorToken:'editor',
    agentProjectRoot:project, managedWorkingDeck:false, ...options });
  t.after(async () => { await app.close(); await rm(root, { recursive:true, force:true }); });
  const request = (method = 'GET', body) => fetch(`${app.url}/api/export/pptx/job?token=test&editorToken=editor`, {
    method, headers:{ origin:app.url, 'content-type':'application/json' },
    ...(body ? { body:JSON.stringify(body) } : {}),
  });
  return { app, root, project, deckPath, request };
}

async function waitForState(request, expected) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await (await request()).json();
    if (state.status === expected) return state;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`导出没有进入 ${expected}`);
}

test('后台导出默认当前项目目录，客户端断开后仍保存，并可恢复同一进度', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let selectedDefault;
  let calls = 0;
  const f = await fixture(t, {
    pickPptxFile:async ({ defaultPath }) => { selectedDefault = defaultPath; return defaultPath; },
    pptxExporter:async ({ htmlBytes }) => {
      calls += 1;
      assert.equal(htmlBytes.toString(), '原始 Deck');
      await pending;
      return Buffer.from('PK\u0003\u0004已导出');
    },
  });
  const accepted = await f.request('POST', { expectedRevision:0, mode:'editable' });
  assert.equal(accepted.status, 202);
  const initial = await accepted.json();
  const running = await waitForState(f.request, 'exporting');
  assert.equal(selectedDefault, join(f.project, '演示.pptx'));
  assert.equal(running.id, initial.id);
  assert.equal((await f.request('POST', { expectedRevision:0, mode:'image' })).status, 409);
  assert.equal((await fetch(`${f.app.url}/api/export/pptx?token=test`, {
    method:'POST', headers:{ origin:f.app.url, 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0 }),
  })).status, 409, '旧下载接口与后台保存共享并发限制');
  release();
  const completed = await waitForState(f.request, 'completed');
  assert.equal(completed.id, initial.id);
  assert.equal(completed.path, selectedDefault);
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(completed.path), Buffer.from('PK\u0003\u0004已导出'));
  assert.equal(await readFile(f.deckPath, 'utf8'), '原始 Deck');
  assert.equal((await (await f.request()).json()).status, 'completed');
});

test('取消保存不转换，导出失败可重试且不会覆盖已有文件', async t => {
  let mode = 'cancel';
  let path;
  const f = await fixture(t, {
    pickPptxFile:async ({ defaultPath }) => { path = defaultPath; return mode === 'cancel' ? null : path; },
    pptxExporter:async () => { throw new Error('模拟转换失败'); },
  });
  assert.equal((await f.request('POST', { expectedRevision:0 })).status, 202);
  await waitForState(f.request, 'cancelled');
  await writeFile(path, '已有 PPTX');
  mode = 'fail';
  assert.equal((await f.request('POST', { expectedRevision:0 })).status, 202);
  const failed = await waitForState(f.request, 'failed');
  assert.match(failed.message, /模拟转换失败/);
  assert.equal(await readFile(path, 'utf8'), '已有 PPTX');
});

test('后台保存只接受 Editor 能力，拒绝无效模式与旧版本', async t => {
  const f = await fixture(t, { pickPptxFile:async () => assert.fail('不应弹出选择器') });
  assert.equal((await fetch(`${f.app.url}/api/export/pptx/job?token=test`, {
    method:'POST', headers:{ origin:f.app.url, 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0 }),
  })).status, 403);
  assert.equal((await f.request('POST', { expectedRevision:0, mode:'invalid' })).status, 400);
  assert.equal((await f.request('POST', { expectedRevision:99 })).status, 409);
});

test('服务关闭会取消后台导出并等待结束，不写出半成品', async t => {
  let aborted = false;
  let destination;
  const f = await fixture(t, {
    pickPptxFile:async ({ defaultPath }) => { destination = defaultPath; return defaultPath; },
    pptxExporter:({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('已取消')); }, { once:true });
    }),
  });
  await f.request('POST', { expectedRevision:0 });
  await waitForState(f.request, 'exporting');
  await f.app.close();
  assert.equal(aborted, true);
  await assert.rejects(readFile(destination), { code:'ENOENT' });
});

test('保存选择器返回非 PPTX 路径时拒绝写入', async t => {
  let selected;
  const f = await fixture(t, {
    pickPptxFile:async () => selected,
    pptxExporter:async () => assert.fail('无效路径不启动转换'),
  });
  selected = f.deckPath;
  await f.request('POST', { expectedRevision:0 });
  const failed = await waitForState(f.request, 'failed');
  assert.match(failed.message, /\.pptx/);
  assert.equal(await readFile(f.deckPath, 'utf8'), '原始 Deck');
});
