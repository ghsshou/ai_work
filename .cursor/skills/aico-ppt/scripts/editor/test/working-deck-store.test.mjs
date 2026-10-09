import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  WorkingDeckStore, pageIdsFromBundle, verifyWorkingPatchReplay,
  writeVerifiedPatches,
} from '../working-deck-store.mjs';

function bundle(template) {
  const encoded = JSON.stringify(template).replaceAll('</', '<\\u002F');
  return Buffer.from('<script type="__bundler/manifest">\n{}\n</script>\n'
    + `<script type="__bundler/template">\n${encoded}\n</script>`);
}

const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');

test('补丁重放失败保留具体动作 ID 与可恢复提示', async () => {
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.end(JSON.stringify({
        state:'failed', expected:2, applied:0, adopted:0,
        error:{
          code:'TARGET_AMBIGUOUS', message:'TARGET_AMBIGUOUS',
          failedActionId:'action-stale-range',
        },
      }));
      child.emit('close', 1);
    });
    return child;
  };

  await assert.rejects(
    verifyWorkingPatchReplay('/tmp/not-read-by-fake.html', { spawnProcess }),
    error => {
      assert.equal(error.code, 'PATCH_REPLAY_FAILED');
      assert.equal(error.replayCode, 'TARGET_AMBIGUOUS');
      assert.equal(error.failedActionId, 'action-stale-range');
      assert.equal(error.stage, 'patch-replay');
      assert.match(error.message, /历史修改无法安全重放/);
      assert.match(error.recovery, /原 Deck 未被改动/);
      return true;
    },
  );
});

test('补丁验证器通过 stdin 一次返回全部可清理缺失动作', async () => {
  let request;
  const spawnProcess = (_executable, args, options) => {
    assert.equal(args.at(-1), '--repair-missing');
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    let input = '';
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', chunk => { input += chunk; });
    child.stdin.on('finish', () => {
      request = JSON.parse(input);
      child.stdout.end(JSON.stringify({
        state:'applied', expected:1, applied:1, adopted:1, error:null,
        droppedActionIds:['old-a', 'old-b'],
      }));
      child.emit('close', 0);
    });
    return child;
  };

  const result = await verifyWorkingPatchReplay('/tmp/not-read-by-fake.html', {
    spawnProcess,
    droppableActionIds:['old-a', 'old-b'],
  });

  assert.deepEqual(request, { droppableActionIds:['old-a', 'old-b'] });
  assert.deepEqual(result, { ok:true, droppedActionIds:['old-a', 'old-b'] });
});

test('固化时丢弃已被后续源码重构删除的旧动作并重试完整验证', async () => {
  const writes = [];
  const restores = [];
  const store = {
    path:'/tmp/legacy-working-deck.html',
    async writePatches(patches) {
      writes.push(patches.map(patch => patch.id));
      return {
        fingerprint:`written-${writes.length}`,
        previousFingerprint:`previous-${writes.length}`,
      };
    },
    async restore(previousFingerprint, writtenFingerprint) {
      restores.push([previousFingerprint, writtenFingerprint]);
    },
  };
  const patches = [
    { id:'valid-current-action' },
    { id:'old-deleted-target' },
  ];
  const result = await writeVerifiedPatches(store, patches, {
    droppableActionIds:['old-deleted-target'],
    verify:async () => {
      if (writes.at(-1).includes('old-deleted-target')) {
        throw Object.assign(new Error('历史修改无法安全重放'), {
          code:'PATCH_REPLAY_FAILED',
          replayCode:'TARGET_NOT_FOUND',
          failedActionId:'old-deleted-target',
        });
      }
    },
  });

  assert.deepEqual(writes, [
    ['valid-current-action', 'old-deleted-target'],
    ['valid-current-action'],
  ]);
  assert.deepEqual(restores, [['previous-1', 'written-1']]);
  assert.deepEqual(result.effectivePatches, [{ id:'valid-current-action' }]);
  assert.deepEqual(result.droppedActionIds, ['old-deleted-target']);
  assert.equal(result.fingerprint, 'written-2');
});

test('固化批量清理多条已取代动作时只重写和复验一次', async () => {
  const writes = [];
  const restores = [];
  const verifyCalls = [];
  const staleIds = Array.from({ length:29 }, (_, index) => `old-${index + 1}`);
  const store = {
    path:'/tmp/batch-repair-working-deck.html',
    async writePatches(patches) {
      writes.push(patches.map(patch => patch.id));
      return {
        fingerprint:`written-${writes.length}`,
        previousFingerprint:`previous-${writes.length}`,
      };
    },
    async restore(previousFingerprint, writtenFingerprint) {
      restores.push([previousFingerprint, writtenFingerprint]);
    },
  };
  const patches = [{ id:'valid-current-action' }, ...staleIds.map(id => ({ id }))];
  const result = await writeVerifiedPatches(store, patches, {
    droppableActionIds:staleIds,
    verify:async (_path, options = {}) => {
      verifyCalls.push(options.droppableActionIds ?? []);
      return verifyCalls.length === 1
        ? { ok:true, droppedActionIds:staleIds }
        : { ok:true, droppedActionIds:[] };
    },
  });

  assert.equal(writes.length, 2, '29 条旧动作必须批量清理，不能触发 30 次全量写入');
  assert.deepEqual(writes[0], ['valid-current-action', ...staleIds]);
  assert.deepEqual(writes[1], ['valid-current-action']);
  assert.deepEqual(restores, [['previous-1', 'written-1']]);
  assert.deepEqual(verifyCalls, [staleIds, staleIds]);
  assert.deepEqual(result.effectivePatches, [{ id:'valid-current-action' }]);
  assert.deepEqual(result.droppedActionIds, staleIds);
});

function templateOf(bytes) {
  const match = Buffer.from(bytes).toString('utf8')
    .match(/<script type="__bundler\/template">\s*([\s\S]*?)\s*<\/script>/);
  if (!match) throw new Error('测试 bundle 缺少 template');
  return JSON.parse(match[1]);
}

test('工作副本结构校验兼容 slide-fit 与直接 slide-canvas 页面容器', () => {
  for (const wrapper of ['slide-fit', 'slide-canvas']) {
    const template = `<!doctype html><body><div class="stage">`
      + `<div class="${wrapper}"><section data-label="第一页" data-page-id="page-11111111111111111111111111111111"></section></div>`
      + `<div class="${wrapper}"><section data-label="第二页" data-page-id="page-22222222222222222222222222222222"></section></div>`
      + `</div><script>const nav = [\n      { i:0, code:'01', label:'第一页' },\n      { i:1, code:'02', label:'第二页' },\n    ];</script></body>`;
    assert.deepEqual(pageIdsFromBundle(bundle(template)), [
      'page-11111111111111111111111111111111',
      'page-22222222222222222222222222222222',
    ]);
  }
});

test('导出快照临时物化未固化补丁且不改写工作副本', async () => {
  const pageId = 'page-11111111111111111111111111111111';
  const current = bundle('<!doctype html><body><div class="stage">'
    + `<div class="slide-fit"><section data-label="第一页" data-page-id="${pageId}">`
    + '<h1 data-editor-id="element-22222222222222222222222222222222">旧文案</h1>'
    + '</section></div></div>'
    + `<script>const nav = [\n      { i:0, code:'01', label:'第一页' },\n    ];</script></body>`);
  const store = new WorkingDeckStore({
    deckPath:'/tmp/source-deck.html',
    workingPath:'/tmp/working-deck.html',
    sessionId:'123e4567-e89b-42d3-a456-426614174099',
    sidecarIO:{
      readWorkingDeck:async () => ({
        bytes:current.toString('base64'), fingerprint:fingerprint(current),
      }),
    },
    fingerprint:fingerprint(current),
    pageIds:[pageId],
    managed:true,
  });
  const snapshot = await store.materializePatches([{
    id:'action-export-snapshot',
    taskId:null,
    target:{ pageKey:pageId, path:'0', tag:'H1' },
    kind:'setText',
    payload:{ text:'导出快照文案' },
    before:'旧文案',
    after:'导出快照文案',
  }]);

  assert.match(templateOf(snapshot), /导出快照文案/);
  assert.doesNotMatch(templateOf(current), /导出快照文案/);
  assert.equal(store.fingerprint, fingerprint(current));
});

test('Windows GBK 环境下 Python 适配器的中文错误仍按 UTF-8 返回', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-python-utf8-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '中文错误.html');
  await writeFile(deckPath, bundle('<!doctype html><body>缺少页面结构</body>'));
  const spawnWithHostileConsoleEncoding = (command, args, options = {}) => spawn(
    command,
    args,
    {
      ...options,
      env:{
        ...process.env,
        PYTHONIOENCODING:'gbk:replace',
        PYTHONUTF8:'0',
        LANG:'C',
        ...options.env,
      },
    },
  );

  await assert.rejects(
    WorkingDeckStore.open({
      deckPath,
      sessionDir:root,
      sessionId:'123e4567-e89b-42d3-a456-426614174099',
      sidecarIO:{ readWorkingDeck:async () => null },
      spawnProcess:spawnWithHostileConsoleEncoding,
    }),
    error => {
      assert.equal(
        error.message,
        '工作副本准备失败：未找到任何 section[data-label] 页面',
      );
      assert.equal(error.message.includes('�'), false);
      return true;
    },
  );
});

test('已有工作副本和 Agent 新增元素都在 SourceMutation 前补齐持久身份', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-editor-id-migrate-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, 'deck.html');
  const pageId = 'page-11111111111111111111111111111111';
  const legacyTemplate = '<!doctype html><body><div class="stage">'
    + `<div class="slide-fit"><div class="slide-canvas"><section data-label="第一页" data-page-id="${pageId}">`
    + '<div class="card"><h2>标题</h2></div></section></div></div></div>'
    + `<script>const nav = [\n      { i:0, code:'01', label:'第一页' },\n    ];</script></body>`;
  await writeFile(deckPath, bundle(legacyTemplate));
  let current = bundle(legacyTemplate);
  const writes = [];
  const archives = [];
  const sidecarIO = {
    async readWorkingDeck() {
      return { bytes:current.toString('base64'), fingerprint:fingerprint(current) };
    },
    async writeWorkingDeck({ bytes, expectedFingerprint }) {
      assert.equal(expectedFingerprint, fingerprint(current));
      current = Buffer.from(bytes);
      writes.push(current);
      return { fingerprint:fingerprint(current) };
    },
    async archiveWorkingDeck({ expectedFingerprint }) {
      assert.equal(expectedFingerprint, fingerprint(current));
      archives.push(expectedFingerprint);
    },
  };

  const { store } = await WorkingDeckStore.open({
    deckPath, sessionDir:root,
    sessionId:'123e4567-e89b-42d3-a456-426614174099', sidecarIO,
  });
  const initialIds = [...templateOf(current).matchAll(
    /data-editor-id="(element-[0-9a-f]{32})"/g,
  )].map(match => match[1]);
  assert.equal(writes.length, 1);
  assert.equal(initialIds.length, 2);
  assert.equal(new Set(initialIds).size, 2);

  current = bundle(templateOf(current).replace(
    '</section>', '<p>Agent 新增内容</p></section>',
  ));
  const rawAgentFingerprint = fingerprint(current);
  const change = await store.checkpointExternalChange();
  const normalizedTemplate = templateOf(current);
  const normalizedIds = [...normalizedTemplate.matchAll(
    /data-editor-id="(element-[0-9a-f]{32})"/g,
  )].map(match => match[1]);
  assert.equal(writes.length, 2);
  assert.equal(normalizedIds.length, 3);
  assert.deepEqual(normalizedIds.slice(0, 2), initialIds);
  assert.notEqual(change.afterFingerprint, rawAgentFingerprint);
  assert.equal(change.afterFingerprint, fingerprint(current));
  assert.equal(archives.at(-1), change.afterFingerprint);
});

test('重启活动源码事务时保留 session 起始指纹并把磁盘候选留给显式提交', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-source-edit-restart-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, 'deck.html');
  const pageId = 'page-11111111111111111111111111111111';
  const before = bundle('<!doctype html><body><div class="stage">'
    + `<div class="slide-fit"><section data-label="第一页" data-page-id="${pageId}" `
    + 'data-editor-id="element-11111111111111111111111111111111">'
    + '<h1 data-editor-id="element-22222222222222222222222222222222">事务前</h1>'
    + '</section></div></div>'
    + `<script>const nav = [\n      { i:0, code:'01', label:'第一页' },\n    ];</script></body>`);
  const after = Buffer.from(before.toString('utf8').replace('事务前', '事务后'));
  await writeFile(deckPath, before);
  let current = after;
  const sidecarIO = {
    async readWorkingDeck() {
      return { bytes:current.toString('base64'), fingerprint:fingerprint(current) };
    },
    async writeWorkingDeck({ bytes, expectedFingerprint }) {
      assert.equal(expectedFingerprint, fingerprint(current));
      current = Buffer.from(bytes);
      return { fingerprint:fingerprint(current) };
    },
    async archiveWorkingDeck({ expectedFingerprint }) {
      assert.equal(expectedFingerprint, fingerprint(current));
    },
  };
  const beforeFingerprint = fingerprint(before);
  const { store } = await WorkingDeckStore.open({
    deckPath,
    sessionDir:root,
    sessionId:'123e4567-e89b-42d3-a456-426614174099',
    sidecarIO,
    expectedWorkingFingerprint:beforeFingerprint,
    reservedBeforeFingerprint:beforeFingerprint,
  });

  assert.equal(store.fingerprint, beforeFingerprint);
  const change = await store.checkpointExternalChange();
  assert.equal(change.beforeFingerprint, beforeFingerprint);
  assert.equal(change.afterFingerprint, fingerprint(current));
});

test('验证与恢复同时失败时保留两阶段错误码供界面诊断', async () => {
  const store = {
    path:'/tmp/working.html',
    async writePatches() { return { previousFingerprint:'before', fingerprint:'after' }; },
    async restore() { throw Object.assign(new Error('超时'), { code:'SIDECAR_HELPER_TIMEOUT' }); },
  };
  await assert.rejects(writeVerifiedPatches(store, [], {
    verify:async () => { throw Object.assign(new Error('验证不可用'), { code:'PATCH_REPLAY_UNAVAILABLE' }); },
  }), error => {
    assert.equal(error.code, 'RECOVERY_REQUIRED');
    assert.match(error.message, /PATCH_REPLAY_UNAVAILABLE/);
    assert.match(error.message, /SIDECAR_HELPER_TIMEOUT/);
    assert.equal(error.committed, true);
    return true;
  });
});

test('Electron 宿主清除运行标记后验证子进程仍使用 Node 模式', {skip:!process.versions.electron}, async () => {
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  delete process.env.ELECTRON_RUN_AS_NODE;
  try {
    await verifyWorkingPatchReplay('unused.html', {spawnProcess:(_executable,_args,options)=>{
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
      assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined, '不能改写宿主环境');
      assert.equal(options.windowsHide, true);
      const child = new EventEmitter();
      child.stdout = new PassThrough();child.stderr = new PassThrough();child.kill=()=>{};
      queueMicrotask(()=>{child.stdout.end('{"ok":true}');child.emit('close',0)});
      return child;
    }});
  } finally {
    if(previous===undefined)delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE=previous;
  }
});
