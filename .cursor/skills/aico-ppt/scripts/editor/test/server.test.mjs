import nodeTest from 'node:test';
import assert from 'node:assert/strict';

// 本文件大量注入 POSIX dirfd、signal 与 symlink 替换；Windows 原生 helper
// 由 windows-sidecar-io.test.mjs 和真实 Claude E2E 覆盖，不能混用两套语义。
const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;
import { spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, createConnection } from 'node:net';
import { PassThrough, Writable } from 'node:stream';
import {
  mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import WebSocket from 'ws';
import { BridgeService } from '../bridge-service.mjs';
import { openDeckBinding } from '../deck-binding-coordinator.mjs';
import { startServer } from '../server.mjs';
import { createEmptyWorkspace } from '../agent-workspace/schema.mjs';

const taskInput = {
  expectedRevision: 0,
  pageKey: 'page-001-a',
  pageIndex: 1,
  pageLabel: 'A',
  rect: { x: 1, y: 2, w: 3, h: 4 },
  instruction: '修改',
};

const action = {
  id: 'action-1',
  taskId: null,
  target: { pageKey: 'page-001-a', path: '0/1' },
  kind: 'setText',
  payload: { text: '新文案' },
  before: '旧文案',
  after: '新文案',
};

async function makeApp(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deck-server-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, options.deckContents ?? 'deck');
  const app = await startServer({
    deckPath: deck,
    host: '127.0.0.1',
    port: 0,
    openBrowser: false,
    token: 'secret',
    editorToken: options.editorToken ?? 'editor-secret',
    bridgeTimeoutMs: options.bridgeTimeoutMs,
    writerTimeoutMs: options.writerTimeoutMs,
    writerKillGraceMs: options.writerKillGraceMs,
    pythonExecutable: options.pythonExecutable,
    spawnWriter: options.spawnWriter,
    attachmentWriterTimeoutMs: options.attachmentWriterTimeoutMs,
    spawnAttachmentWriter: options.spawnAttachmentWriter,
    onActiveWritersChange: options.onActiveWritersChange,
    beforeSessionPersist: options.beforeSessionPersist,
    syncDirectory: options.syncDirectory,
    agentThreadId: options.agentThreadId,
    agentProvider: options.agentProvider,
    agentRunAdapter: options.agentRunAdapter,
    dshAgentBridge: options.dshAgentBridge,
    ...(options.dshAgentBridge ? {
      workId:options.workId ?? '11111111-1111-4111-8111-111111111111',
      dshWorkItemProvider:options.dshWorkItemProvider ?? (async () => ({
        workId:options.workId ?? '11111111-1111-4111-8111-111111111111',
        dshBinding:{ activeSessionId:'dsh-test-session' },
      })),
      dshWorkItemCommand:options.dshWorkItemCommand ?? (async () => ({ workItem:null })),
    } : {}),
    spawnAgentTerminal: options.spawnAgentTerminal,
    createAgentTerminal: options.createAgentTerminal,
    createAgentTerminalConversation: options.createAgentTerminalConversation,
    resumeAgentTerminalConversation: options.resumeAgentTerminalConversation,
    agentRunTimeoutMs: options.agentRunTimeoutMs,
    pptxExporter:options.pptxExporter,
    pptxExportTimeoutMs:options.pptxExportTimeoutMs,
    managedWorkingDeck: options.managedWorkingDeck ?? false,
    workingPatchVerifier: options.workingPatchVerifier ?? (async () => ({ ok:true })),
  });
  t.after(() => app.close());
  return app;
}

test('关闭服务会断开未发送完整的 HTTP 请求并释放监听端口', async t => {
  const app = await makeApp(t);
  const socket = createConnection({ host:'127.0.0.1', port:app.port });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write('POST /api/actions?token=secret HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{');
  await new Promise(resolve => setTimeout(resolve, 30));
  const closing = app.close();
  let timer;
  try {
    await Promise.race([
      closing,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('未完成 HTTP 请求阻塞了服务关闭')), 2_000); }),
    ]);
  } finally {
    clearTimeout(timer);
    socket.destroy();
    await closing;
  }
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(app.port, '127.0.0.1', resolve);
  });
  await new Promise(resolve => probe.close(resolve));
});

test('DSH Editor Core 不创建 Agent PTY，也不暴露 xterm 页面资源', async t => {
  let terminalCreations = 0;
  const app = await makeApp(t, {
    dshAgentBridge:true,
    createAgentTerminal:async () => {
      terminalCreations += 1;
      throw new Error('DSH 不应创建 Agent Terminal');
    },
  });

  assert.equal(terminalCreations, 0);
  assert.equal(app.agentTerminal, undefined);
  const editorResponse = await fetch(
    `${app.url}/editor/?token=${encodeURIComponent(app.token)}`
      + `&editorToken=${encodeURIComponent(app.editorToken)}`,
  );
  assert.equal(editorResponse.status, 200);
  const html = await editorResponse.text();
  assert.doesNotMatch(html, /xterm\.(?:js|css)/u);
  assert.match(html, /DEV SHELL/u, 'DSH 复用同一页面模板，由运行模式隐藏开发标识');

  const xtermResponse = await fetch(
    `${new URL(app.url).origin}/editor/xterm.js?token=${encodeURIComponent(app.token)}`,
  );
  assert.equal(xtermResponse.status, 404);
});

test('显式退出接口关闭当前编辑服务', async t => {
  const app = await makeApp(t);
  const response = await fetch(
    `${app.url}/api/shutdown?token=${encodeURIComponent(app.token)}`
      + `&editorToken=${encodeURIComponent(app.editorToken)}`,
    {
    method:'POST', headers:{ origin:app.url },
    },
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status:'shutting-down' });
  const deadline = Date.now() + 1_000;
  let closed = false;
  while (!closed && Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
    closed = await fetch(`${app.url}/api/session?token=${encodeURIComponent(app.token)}`)
      .then(() => false, () => true);
  }
  assert.equal(closed, true);
});

test('Agent 终端凭据不能调用浏览器专用退出接口', async t => {
  const app = await makeApp(t);
  const response = await fetch(`${app.url}/api/shutdown`, {
    method:'POST',
    headers:{ authorization:`Bearer ${app.token}` },
  });
  const result = await response.json();

  assert.equal(response.status, 403, JSON.stringify(result));
  assert.equal(result.code, 'BROWSER_ORIGIN_REQUIRED');
  const forgedBrowserResponse = await fetch(`${app.url}/api/shutdown`, {
    method:'POST',
    headers:{ authorization:`Bearer ${app.token}`, origin:app.url },
  });
  const forgedBrowserResult = await forgedBrowserResponse.json();
  assert.equal(forgedBrowserResponse.status, 403, JSON.stringify(forgedBrowserResult));
  assert.equal(forgedBrowserResult.code, 'EDITOR_CAPABILITY_REQUIRED');
  const sessionResponse = await fetch(`${app.url}/api/session?token=secret`);
  assert.equal(sessionResponse.status, 200, '拒绝终端退出请求后服务必须继续运行');
});

test('PPTX 导出接口返回工作副本并使用源 Deck 文件名', async t => {
  let exportedHtml;
  const app = await makeApp(t, {
    pptxExporter:async ({ htmlBytes, signal, mode }) => {
      exportedHtml = Buffer.from(htmlBytes);
      assert.equal(signal.aborted, false);
      assert.equal(mode, 'image');
      return Buffer.from('PK\u0003\u0004pptx');
    },
  });
  const response = await fetch(`${app.url}/api/export/pptx?token=secret`, {
    method:'POST',
    headers:{ 'content-type':'application/json', origin:app.url },
    body:JSON.stringify({ expectedRevision:0 }),
  });
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('content-type'),
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  );
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''deck\.pptx/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from('PK\u0003\u0004pptx'));
  assert.deepEqual(exportedHtml, Buffer.from('deck'));
  assert.equal(await readFile(app.deckPath, 'utf8'), 'deck');
});

test('PPTX 导出接口传递可编辑模式并拒绝未知模式', async t => {
  const modes = [];
  const app = await makeApp(t, {
    pptxExporter:async ({ mode }) => {
      modes.push(mode);
      return Buffer.from('PK\u0003\u0004pptx');
    },
  });
  for (const mode of ['editable', 'image', 'unknown', '', null, {}]) {
    const response = await fetch(`${app.url}/api/export/pptx?token=secret`, {
      method:'POST',
      headers:{ 'content-type':'application/json', origin:app.url },
      body:JSON.stringify({ expectedRevision:0, mode }),
    });
    if (mode === 'editable' || mode === 'image') {
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    } else {
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'PPTX_EXPORT_MODE_INVALID');
    }
  }
  assert.deepEqual(modes, ['editable', 'image']);
});

test('可编辑 PPTX 与图片导出共享并发锁，失败后可重试且不固化源文件', async t => {
  let rejectExport;
  let markStarted;
  const started = new Promise(resolvePromise => { markStarted = resolvePromise; });
  const pending = new Promise((_resolve, reject) => { rejectExport = reject; });
  const modes = [];
  const app = await makeApp(t, {
    pptxExporter:async ({ htmlBytes, mode }) => {
      modes.push(mode);
      assert.deepEqual(htmlBytes, Buffer.from('deck'));
      if (modes.length === 1) { markStarted(); await pending; }
      return Buffer.from('PK\u0003\u0004pptx');
    },
  });
  const request = mode => fetch(`${app.url}/api/export/pptx?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json', origin:app.url },
    body:JSON.stringify({ expectedRevision:0, mode }),
  });
  const first = request('editable');
  await started;
  const busy = await request('image');
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).code, 'PPTX_EXPORT_BUSY');
  rejectExport(Object.assign(new Error('测试转换失败'), { statusCode:422 }));
  assert.equal((await first).status, 422);
  const retry = await request('image');
  assert.equal(retry.status, 200);
  await retry.arrayBuffer();
  assert.deepEqual(modes, ['editable', 'image']);
  assert.equal(await readFile(app.deckPath, 'utf8'), 'deck');
});

function connect(url, options) {
  const socket = new WebSocket(url, options);
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket, accepts = () => true) {
  return new Promise((resolve, reject) => {
    const onMessage = data => {
      const message = JSON.parse(data);
      if (!accepts(message)) return;
      socket.off('message', onMessage);
      socket.off('error', onError);
      resolve(message);
    };
    const onError = error => {
      socket.off('message', onMessage);
      reject(error);
    };
    socket.on('message', onMessage);
    socket.once('error', onError);
  });
}

async function connectDiagnosticsEditor(t, app) {
  const socket = await connect(app.editorWsUrl);
  t.after(() => socket.close());
  const page = {
    pageKey:'page-001-save-gate',
    sectionOverflow:{ x:0, y:0 },
    nestedClips:[],
  };
  socket.on('message', data => {
    const message = JSON.parse(data);
    if (message.type !== 'diagnose-pages') return;
    socket.send(JSON.stringify({
      type:'diagnostics-result',
      commandId:message.commandId,
      revision:message.revision,
      pages:message.pageKeys.map(pageKey => ({ ...page, pageKey })),
    }));
  });
  socket.send(JSON.stringify({
    type:'deck-ready',
    pages:[{ index:1, label:'测试页', pageKey:page.pageKey }],
    diagnostics:[page],
  }));
  const deadline = Date.now() + 1_000;
  while (!Object.keys(app.session.diagnosticsBaseline ?? {}).length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(Object.keys(app.session.diagnosticsBaseline ?? {}).length, 1);
  return socket;
}

async function connectCanonicalActionEditor(t, app) {
  const editor = await connectDiagnosticsEditor(t, app);
  editor.on('message', data => {
    const message = JSON.parse(data);
    if (message.type === 'apply-actions') {
      editor.send(JSON.stringify({
        type:'actions-prepared', commandId:message.commandId,
        applied:message.actions.length,
        results:message.actions.map(candidate => ({
          ...candidate,
          before:Object.hasOwn(candidate, 'before') ? candidate.before : '旧文案',
          after:Object.hasOwn(candidate, 'after') ? candidate.after : candidate.payload?.text,
          appliedAt:candidate.appliedAt ?? '2026-08-16T00:00:00.000Z',
        })),
      }));
    } else if (message.type === 'commit-actions') {
      editor.send(JSON.stringify({
        type:'actions-committed', commandId:message.commandId, committed:true,
      }));
    } else if (message.type === 'rollback-actions') {
      editor.send(JSON.stringify({
        type:'actions-rolled-back', commandId:message.commandId, rolledBack:true,
      }));
    } else if (message.type === 'sync-actions') {
      editor.send(JSON.stringify({ type:'actions-synced', commandId:message.commandId }));
    }
  });
  return editor;
}

async function prepareAndCommit(socket, command, results = command.actions) {
  socket.send(JSON.stringify({
    type: 'actions-prepared', commandId: command.commandId,
    applied: command.actions.length, results,
  }));
  const commit = await nextMessage(socket, message => (
    message.type === 'commit-actions' && message.commandId === command.commandId
  ));
  assert.equal(commit.type, 'commit-actions');
  assert.equal(commit.commandId, command.commandId);
  socket.send(JSON.stringify({
    type: 'actions-committed', commandId: command.commandId, committed: true,
  }));
}

async function sendInvalidPrepared(socket, command, acknowledgement) {
  socket.send(JSON.stringify({
    type: 'actions-prepared', commandId: command.commandId,
    results: command.actions, ...acknowledgement,
  }));
  const rollback = await nextMessage(socket);
  assert.equal(rollback.type, 'rollback-actions');
  assert.equal(rollback.commandId, command.commandId);
  socket.send(JSON.stringify({
    type: 'actions-rolled-back', commandId: command.commandId, rolledBack: true,
  }));
}

function rejectedWebSocketStatus(url, options) {
  const socket = new WebSocket(url, options);
  return new Promise(resolve => {
    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode));
    socket.once('open', () => {
      socket.terminate();
      resolve(0);
    });
    socket.once('error', () => resolve(0));
  });
}

function postJsonChunks(url, chunks) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method:'POST',
      headers:{ 'content-type':'application/json', 'transfer-encoding':'chunked' },
    }, response => {
      const responseChunks = [];
      response.on('data', chunk => responseChunks.push(chunk));
      response.once('end', () => resolve({
        status:response.statusCode,
        body:JSON.parse(Buffer.concat(responseChunks).toString('utf8')),
      }));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.write(chunks[0]);
    setTimeout(() => request.end(chunks[1]), 10);
  });
}

async function createTask(app, overrides = {}) {
  const response = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ ...taskInput, ...overrides }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function createAttachedTask(app, contents = 'trusted attachment', overrides = {}) {
  const form = new FormData();
  form.append('task', new Blob([JSON.stringify({
    ...taskInput, ...overrides, attachmentSources:['selected'],
  })], { type:'application/json' }), 'task.json');
  form.append('attachment', new Blob([Buffer.from(contents)]), 'reference.txt');
  const response = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', body:form,
  });
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  return result;
}

function validBundle() {
  const template = '<!doctype html><body><div class="stage"></div></body>';
  return '<script type="__bundler/manifest">\n{}\n</script>\n'
    + `<script type="__bundler/template">\n${JSON.stringify(template)}\n</script>`;
}

function managedBundle(text = '旧文案') {
  const template = `<!doctype html><body>\n`
    + `<div class="slide-fit"><div><section data-label="测试页"><h1>${text}</h1></section></div></div>\n`
    + `<script>\nconst nav = [\n      { i:0, code:'01', label:'测试页' },\n    ];\n`
    + `const chapters = [{name:'测试', start:0}];\n</script></body>`;
  return '<script type="__bundler/manifest">\n{}\n</script>\n'
    + `<script type="__bundler/template">\n${JSON.stringify(template)}\n</script>`;
}

function managedTwoPageBundle() {
  const template = `<!doctype html><body>\n`
    + `<div class="slide-fit"><div><section data-label="保留页"><h1>保留页</h1></section></div></div>\n`
    + `<div class="slide-fit"><div><section data-label="删除页"><h1>删除页</h1></section></div></div>\n`
    + `<script>\nconst nav = [\n      { i:0, code:'01', label:'保留页' },\n`
    + `      { i:1, code:'02', label:'删除页' },\n    ];\n`
    + `const chapters = [{name:'测试', start:0}];\n</script></body>`;
  return '<script type="__bundler/manifest">\n{}\n</script>\n'
    + `<script type="__bundler/template">\n${JSON.stringify(template)}\n</script>`;
}

function managedTwoPageBundleWithPatches(patches) {
  const firstPageKey = 'page-11111111111111111111111111111111';
  const secondPageKey = 'page-22222222222222222222222222222222';
  const patchBlock = '<!-- huawei-deck-editor:begin -->\n'
    + `<script type="application/json" id="huawei-deck-editor-patches">${JSON.stringify(patches)}</script>\n`
    + '<script></script>\n<!-- huawei-deck-editor:end -->';
  const template = `<!doctype html><body>\n`
    + `<div class="slide-fit"><div><section data-label="保留页" data-page-id="${firstPageKey}"><h1>保留页</h1></section></div></div>\n`
    + `<div class="slide-fit"><div><section data-label="删除页" data-page-id="${secondPageKey}"><h1>删除页</h1></section></div></div>\n`
    + `<script>\nconst nav = [\n      { i:0, code:'01', label:'保留页' },\n`
    + `      { i:1, code:'02', label:'删除页' },\n    ];\n`
    + `const chapters = [{name:'测试', start:0}];\n</script>${patchBlock}\n</body>`;
  return '<script type="__bundler/manifest">\n{}\n</script>\n'
    + `<script type="__bundler/template">\n${JSON.stringify(template)}\n</script>`;
}

function updateBundledTemplate(bundle, update) {
  const lines = String(bundle).split('\n');
  const marker = lines.findIndex(line => line.trim() === '<script type="__bundler/template">');
  if (marker < 0) throw new Error('测试 bundle 缺少 template');
  lines[marker + 1] = JSON.stringify(update(JSON.parse(lines[marker + 1])))
    .replaceAll('</', '<\\u002F');
  return lines.join('\n');
}

function managedPageBlock(template, pageKey) {
  const escapedPageKey = pageKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `<div class="slide-fit"><div><section(?=[^>]*\\bdata-page-id="${escapedPageKey}")[^>]*>`
      + '[\\s\\S]*?<\\/section><\\/div><\\/div>\\n',
  );
  const block = template.match(pattern)?.[0];
  assert.ok(block, `测试模板找不到页面 ${pageKey}`);
  return block;
}

function removeManagedPage(template, pageKey) {
  return template.replace(managedPageBlock(template, pageKey), '');
}

function managedBundleWithPatches(patches) {
  const pageKey = 'page-11111111111111111111111111111111';
  const patchBlock = '<!-- huawei-deck-editor:begin -->\n'
    + `<script type="application/json" id="huawei-deck-editor-patches">${JSON.stringify(patches)}</script>\n`
    + '<script></script>\n<!-- huawei-deck-editor:end -->';
  const template = `<!doctype html><body>\n`
    + `<div class="slide-fit"><div><section data-label="测试页" data-page-id="${pageKey}"><h1>旧文案</h1></section></div></div>\n`
    + `<script>\nconst nav = [\n      { i:0, code:'01', label:'测试页' },\n    ];\n`
    + `const chapters = [{name:'测试', start:0}];\n</script>${patchBlock}\n</body>`;
  return '<script type="__bundler/manifest">\n{}\n</script>\n'
    + `<script type="__bundler/template">\n${JSON.stringify(template)}\n</script>`;
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function writeTransactionRecord(app, transactionId, oldBytes, candidateBytes) {
  const transactions = join(app.sessionDir, 'transactions');
  await mkdir(transactions, { recursive:true });
  const oldFingerprint = sha256(oldBytes);
  const candidateFingerprint = sha256(candidateBytes);
  const transactionPath = join(transactions, `${transactionId}.json`);
  await writeFile(
    join(app.sessionDir, 'backups', `deck-${oldFingerprint}.html`),
    oldBytes,
  );
  await writeFile(transactionPath, JSON.stringify({
    version:1,
    sessionId:app.session.sessionId,
    transactionId,
    deckPath:app.deckPath,
    sessionDir:app.sessionDir,
    oldFingerprint,
    candidateFingerprint,
    backup:join(app.sessionDir, 'backups', `deck-${oldFingerprint}.html`),
  }));
  return transactionPath;
}

async function createPendingTransactionFixture({
  root, diskBytes, oldBytes, candidateBytes, sessionFingerprint, registered=true,
}) {
  const deckPath = join(root, 'deck.html');
  await writeFile(deckPath, diskBytes);
  const oldFingerprint = sha256(oldBytes);
  const candidateFingerprint = sha256(candidateBytes);
  const sidecarRoot = join(root, '.aico-ppt-editor');
  const sessionDir = join(sidecarRoot, `deck-${oldFingerprint.slice(0, 8)}`);
  const backup = join(sessionDir, 'backups', `deck-${oldFingerprint}.html`);
  const transactionId = '123e4567-e89b-42d3-a456-426614174000';
  const sessionId = '223e4567-e89b-42d3-a456-426614174000';
  const transaction = join(sessionDir, 'transactions', `${transactionId}.json`);
  await mkdir(join(sessionDir, 'snapshots'), { recursive:true });
  await mkdir(join(sessionDir, 'backups'), { recursive:true });
  await mkdir(join(sessionDir, 'transactions'), { recursive:true });
  await mkdir(join(sessionDir, 'write-errors'), { recursive:true });
  await writeFile(backup, oldBytes);
  await writeFile(join(sessionDir, 'session.json'), JSON.stringify({
    version:1,
    ...(registered ? { sessionId } : {}),
    deckPath,
    deckFingerprint:sessionFingerprint,
    revision:0,
    tasks:[],
    groups:[],
    redo:[],
    diagnosticsBaseline:{},
    diagnosticsCurrent:{},
    diagnosticsRevision:null,
    conflict:null,
  }, null, 2));
  await writeFile(transaction, JSON.stringify({
    version:1,
    ...(registered ? { sessionId } : {}),
    transactionId,
    deckPath,
    sessionDir,
    oldFingerprint,
    candidateFingerprint,
    backup,
  }));
  if (registered) {
    await writeFile(join(sidecarRoot, 'sessions.json'), JSON.stringify({
      version:1,
      sessions:{
        [sessionId]:{
          sessionId,
          deckRealPath:await realpath(deckPath),
          initialFingerprint:oldFingerprint,
          sessionName:`deck-${oldFingerprint.slice(0, 8)}`,
          mode:'fresh',
          status:'active',
        },
      },
    }, null, 2));
  }
  return {
    deckPath, sidecarRoot, sessionDir, backup, transaction,
    oldFingerprint, candidateFingerprint, sessionId,
  };
}

async function replaceSidecarIdentity(app, level) {
  const sidecarRoot = join(app.deckPath, '..', '.aico-ppt-editor');
  const sessionName = app.sessionDir.split('/').at(-1);
  const target = level === 'root' ? sidecarRoot : app.sessionDir;
  await rename(target, `${target}.trusted-original`);
  if (level === 'root') await mkdir(sidecarRoot);
  const replacementSession = level === 'root' ? join(sidecarRoot, sessionName) : app.sessionDir;
  await mkdir(join(replacementSession, 'snapshots'), { recursive:true });
  await mkdir(join(replacementSession, 'backups'), { recursive:true });
  await mkdir(join(replacementSession, 'transactions'), { recursive:true });
  return replacementSession;
}

async function sidecarTree(root) {
  return (await readdir(root, { recursive:true })).sort();
}

function emptySessionState(deckPath, deckFingerprint, extra = {}) {
  return {
    version:1,
    deckPath,
    deckFingerprint,
    revision:0,
    tasks:[],
    groups:[],
    redo:[],
    diagnosticsBaseline:{},
    diagnosticsCurrent:{},
    diagnosticsRevision:null,
    conflict:null,
    ...extra,
  };
}

async function makeCompleteSessionDirectory(sidecarRoot, sessionName) {
  const sessionDir = join(sidecarRoot, sessionName);
  await mkdir(join(sessionDir, 'snapshots'), { recursive:true });
  await mkdir(join(sessionDir, 'backups'));
  await mkdir(join(sessionDir, 'transactions'));
  await mkdir(join(sessionDir, 'write-errors'));
  return sessionDir;
}

function fakeWriterChild({ onEnd, onKill, closesOnKill = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.end = data => onEnd?.(child, data);
  child.killed = false;
  child.unrefCalled = false;
  child.unref = () => { child.unrefCalled = true; };
  child.kill = () => {
    child.killed = true;
    onKill?.(child);
    if (closesOnKill) queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
    return true;
  };
  return child;
}

function hangingChild() {
  return fakeWriterChild();
}

function epipe() {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
}

test('活动 Editor 检测同目录外部改名，更新绑定且重启仍恢复原 session', async t => {
  const app = await makeApp(t);
  const oldPath = app.deckPath;
  const newPath = join(dirname(oldPath), 'renamed.html');
  const sessionId = app.session.sessionId;
  await rename(oldPath, newPath);
  let binding = null;
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    binding = await fetch(`${app.url}/api/deck-binding?token=${app.token}`)
      .then(response => response.json());
    if (binding.currentPath === newPath && binding.state === 'bound') break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  assert.equal(binding.currentPath, newPath, JSON.stringify(binding));
  assert.equal(binding.reason, 'renamed');
  assert.equal(app.deckPath, newPath);
  await app.close();

  const reopened = await startServer({
    deckPath:newPath, host:'127.0.0.1', port:0, openBrowser:false,
  });
  t.after(() => reopened.close());
  assert.equal(reopened.session.sessionId, sessionId);
  assert.equal(reopened.deckPath, newPath);
});

test('Editor 关闭期间同目录外部改名，WorkCatalog 绑定可恢复原 session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-closed-rename-session-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const oldPath = join(root, 'closed-before.html');
  const newPath = join(root, 'closed-after.html');
  await writeFile(oldPath, validBundle());
  const deckId = '923e4567-e89b-42d3-a456-426614174000';
  const binding = await openDeckBinding({
    deckId,
    initialBinding:{ currentPath:oldPath, trustedRoot:root, revision:0 },
    storageRoot:root,
    watch:false,
  });
  t.after(() => binding.close());
  const first = await startServer({
    deckPath:oldPath, deckId, deckBinding:binding.snapshot(),
    host:'127.0.0.1', port:0, openBrowser:false,
    autoStartAgentTerminal:false, managedWorkingDeck:false,
  });
  const sessionId = first.session.sessionId;
  await first.close();
  await rename(oldPath, newPath);
  const rebound = await binding.reconcile({ cause:'resume' });
  assert.equal(rebound.reason, 'renamed');

  const reopened = await startServer({
    deckPath:newPath, deckId, deckBinding:rebound,
    host:'127.0.0.1', port:0, openBrowser:false,
    autoStartAgentTerminal:false, managedWorkingDeck:false,
  });
  try {
    assert.equal(reopened.session.sessionId, sessionId);
    assert.equal(reopened.deckPath, newPath);
  } finally {
    await reopened.close();
  }
});

test('session lock 跨 helper 进程互斥，失败方零副作用且 close 后可重启', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-lock-'));
  const deckPath = join(root, 'deck.html');
  await writeFile(deckPath, 'deck');
  const first = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false,
  });
  let contender;
  try {
    const sidecarRoot = join(root, '.aico-ppt-editor');
    const treeBefore = await sidecarTree(sidecarRoot);
    const registryBefore = await readFile(join(sidecarRoot, 'sessions.json'));
    const sessionBefore = await readFile(join(first.sessionDir, 'session.json'));
    const outcome = await startServer({
      deckPath, host:'127.0.0.1', port:0, openBrowser:false,
    }).then(app => ({ app }), error => ({ error }));
    contender = outcome.app;
    assert.equal(contender, undefined, '同一 Deck 的第二个 server 不得初始化成功');
    assert.equal(outcome.error?.code, 'SESSION_LOCKED');
    assert.equal(outcome.error?.statusCode, 409);
    assert.deepEqual(await sidecarTree(sidecarRoot), treeBefore);
    assert.deepEqual(await readFile(join(sidecarRoot, 'sessions.json')), registryBefore);
    assert.deepEqual(await readFile(join(first.sessionDir, 'session.json')), sessionBefore);
  } finally {
    await contender?.close();
    await first.close();
  }
  const restarted = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false,
  });
  await restarted.close();
});

test('listen 端口占用会释放 helper/lock，随后可重启', async () => {
  const holder = createNetServer();
  await new Promise((resolvePromise, reject) => {
    holder.once('error', reject);
    holder.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = holder.address().port;
  const root = await mkdtemp(join(tmpdir(), 'deck-session-lock-port-'));
  const deckPath = join(root, 'deck.html');
  await writeFile(deckPath, 'deck');
  await assert.rejects(
    () => startServer({ deckPath, host:'127.0.0.1', port, openBrowser:false }),
    error => error.code === 'EADDRINUSE',
  );
  await new Promise(resolvePromise => holder.close(resolvePromise));
  const restarted = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false,
  });
  await restarted.close();
});

test('空闲 server.close 并行回收活跃 helper，50ms 内收敛', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-helper-close-bound-'));
  const deckPath = join(root, 'deck.html');
  await writeFile(deckPath, 'deck');
  const app = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false,
  });
  const startedAt = performance.now();
  await app.close();
  assert.ok(performance.now() - startedAt < 50);
});

test('session registry 提供稳定身份，legacy 仅无 pending 时迁移，未注册新会话只读拒绝', async t => {
  await t.test('新会话发布 registry，重启复用同一随机 sessionId', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-registry-fresh-'));
    const deckPath = join(root, 'deck.html');
    await writeFile(deckPath, 'deck');
    let app = await startServer({ deckPath, host:'127.0.0.1', port:0, openBrowser:false });
    const firstSessionId = app.session.sessionId;
    const firstSessionDir = app.sessionDir;
    try {
      assert.match(firstSessionId, /^[0-9a-f-]{36}$/);
      const registry = JSON.parse(await readFile(join(root, '.aico-ppt-editor', 'sessions.json')));
      assert.equal(registry.sessions[firstSessionId].sessionId, firstSessionId);
      assert.equal(registry.sessions[firstSessionId].sessionName, firstSessionDir.split('/').at(-1));
      assert.equal(
        JSON.parse(await readFile(join(firstSessionDir, 'session.json'))).sessionId,
        firstSessionId,
      );
    } finally {
      await app.close();
    }
    app = await startServer({ deckPath, host:'127.0.0.1', port:0, openBrowser:false });
    try {
      assert.equal(app.sessionDir, firstSessionDir);
      assert.equal(app.session.sessionId, firstSessionId);
    } finally {
      await app.close();
    }
  });

  await t.test('macOS 与 Windows 的绝对路径表示不同仍复用同一注册 session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-registry-cross-platform-'));
    const deckPath = join(root, 'deck.html');
    await writeFile(deckPath, 'cross-platform-deck');
    const fingerprint = sha256('cross-platform-deck');
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const sessionName = `deck-${fingerprint.slice(0, 8)}`;
    const foreignDeckPath = 'Y:\\shared-project\\deck.html';
    const sidecarRoot = join(root, '.aico-ppt-editor');
    const sessionDir = await makeCompleteSessionDirectory(sidecarRoot, sessionName);
    await writeFile(join(sessionDir, 'session.json'), JSON.stringify(emptySessionState(
      foreignDeckPath, fingerprint, { sessionId },
    ), null, 2));
    await writeFile(join(sidecarRoot, 'sessions.json'), JSON.stringify({
      version:1,
      sessions:{
        [sessionId]:{
          sessionId,
          deckRealPath:foreignDeckPath,
          initialFingerprint:fingerprint,
          sessionName,
          mode:'fresh',
          status:'active',
        },
      },
    }, null, 2));
    const persistedWorkspace = createEmptyWorkspace({
      deckSessionId:sessionId,
      projectRoot:root,
      projectRootSource:'launch-cwd',
      now:() => '2026-08-09T12:00:00.000Z',
    });
    persistedWorkspace.projectRoot = '\\\\Mac\\Home\\zyq_workspace\\aico-ppt';
    await writeFile(
      join(sessionDir, 'agent-workspace.json'),
      JSON.stringify(persistedWorkspace, null, 2),
    );

    const app = await startServer({
      deckPath, host:'127.0.0.1', port:0, openBrowser:false,
    });
    try {
      const canonicalRoot = await realpath(root);
      assert.equal(app.session.sessionId, sessionId);
      assert.equal(app.sessionDir, sessionDir);
      assert.equal(app.agentWorkspace.snapshot().projectRoot, canonicalRoot);
      assert.equal(
        JSON.parse(await readFile(join(sessionDir, 'agent-workspace.json'))).projectRoot,
        canonicalRoot,
      );
    } finally {
      await app.close();
    }
  });

  await t.test('无 registry 的严格 legacy 且无 pending 时一次迁移', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-registry-legacy-'));
    const deckPath = join(root, 'deck.html');
    await writeFile(deckPath, 'legacy-deck');
    const fingerprint = sha256('legacy-deck');
    const sidecarRoot = join(root, '.aico-ppt-editor');
    const sessionName = `deck-${fingerprint.slice(0, 8)}`;
    const sessionDir = await makeCompleteSessionDirectory(sidecarRoot, sessionName);
    await writeFile(
      join(sessionDir, 'session.json'),
      JSON.stringify(emptySessionState(deckPath, fingerprint), null, 2),
    );
    const app = await startServer({ deckPath, host:'127.0.0.1', port:0, openBrowser:false });
    try {
      assert.equal(app.sessionDir, sessionDir);
      assert.match(app.session.sessionId, /^[0-9a-f-]{36}$/);
      const registry = JSON.parse(await readFile(join(sidecarRoot, 'sessions.json')));
      assert.equal(registry.sessions[app.session.sessionId].sessionName, sessionName);
      assert.equal(
        JSON.parse(await readFile(join(sessionDir, 'session.json'))).sessionId,
        app.session.sessionId,
      );
    } finally {
      await app.close();
    }
  });

  await t.test('无 registry 的 pending 即使完全自洽也只读拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-registry-pending-'));
    const oldBytes = Buffer.from('old');
    const candidateBytes = Buffer.from('candidate');
    const fixture = await createPendingTransactionFixture({
      root, diskBytes:candidateBytes, oldBytes, candidateBytes,
      sessionFingerprint:sha256(oldBytes), registered:false,
    });
    const treeBefore = await sidecarTree(fixture.sidecarRoot);
    const deckBefore = await readFile(fixture.deckPath);
    await assert.rejects(
      () => startServer({
        deckPath:fixture.deckPath, host:'127.0.0.1', port:0, openBrowser:false,
      }),
      error => error.code === 'UNSAFE_SIDECAR',
    );
    assert.deepEqual(await sidecarTree(fixture.sidecarRoot), treeBefore);
    assert.deepEqual(await readFile(fixture.deckPath), deckBefore);
  });

  await t.test('带 sessionId 但未注册的自洽目录不得按 legacy 收编', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-registry-unregistered-'));
    const deckPath = join(root, 'deck.html');
    await writeFile(deckPath, 'unregistered');
    const fingerprint = sha256('unregistered');
    const sidecarRoot = join(root, '.aico-ppt-editor');
    const sessionName = `deck-${fingerprint.slice(0, 8)}`;
    const sessionDir = await makeCompleteSessionDirectory(sidecarRoot, sessionName);
    await writeFile(join(sessionDir, 'session.json'), JSON.stringify(emptySessionState(
      deckPath, fingerprint, { sessionId:'123e4567-e89b-42d3-a456-426614174000' },
    )));
    const treeBefore = await sidecarTree(sidecarRoot);
    await assert.rejects(
      () => startServer({ deckPath, host:'127.0.0.1', port:0, openBrowser:false }),
      error => error.code === 'UNSAFE_SIDECAR',
    );
    assert.deepEqual(await sidecarTree(sidecarRoot), treeBefore);
  });
});

test('拒绝无令牌请求并向 WebSocket 推送新任务', async t => {
  const app = await makeApp(t);
  assert.equal((await fetch(`${app.url}/api/session`)).status, 403);

  const ws = await connect(`${app.wsUrl}?token=secret`);
  t.after(() => ws.close());
  const event = nextMessage(ws);
  const response = await fetch(`${app.url}/api/tasks?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(taskInput),
  });

  assert.equal(response.status, 201);
  assert.equal((await event).type, 'task-created');
});

test('旧版 Agent 连接、会话扫描与结构化 runtime API 已移除', async t => {
  const app = await makeApp(t);
  for (const path of [
    '/api/agent-providers',
    '/api/agent-workspace',
    '/api/agent-events',
    '/api/agent-connection',
    '/api/agent-sessions',
  ]) {
    const response = await fetch(`${app.url}${path}?token=secret`);
    assert.equal(response.status, 404, path);
  }
  const command = await fetch(`${app.url}/api/agent-command?token=secret`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ type:'interrupt' }),
  });
  assert.equal(command.status, 404);
});

test('启动参数中的 Agent provider 覆盖旧 workspace 默认值', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-provider-selection-'));
  const deckPath = join(root, 'deck.html');
  await writeFile(deckPath, 'deck');
  const first = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false, agentProvider:'codex',
  });
  await first.close();
  const reopened = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false,
    agentProvider:'claude-code',
  });
  try {
    assert.equal(reopened.agentWorkspace.snapshot().activeProvider, 'claude-code');
    assert.equal(reopened.agentTerminal.snapshot().provider, 'claude-code');
  } finally {
    await reopened.close();
  }
});


test('默认 Codex 使用一个长期 bypass PTY，首次加载 Skill，后续批次写入同一终端', async t => {
  let app;
  let spawnCount = 0;
  const children = [];
  const completePendingTasks = prompt => {
    if (!/本批任务 ID/.test(prompt)) return;
    queueMicrotask(() => {
      for (const task of app.session.tasks) {
        if (task.status === 'pending') task.status = 'completed';
      }
    });
  };
  const spawnAgentTerminal = (executable, args, options) => {
    spawnCount += 1;
    const events = new EventEmitter();
    const child = {
      executable, args, options, pid:7000 + spawnCount,
      writes:[], killed:false,
      onData(listener) { events.on('data', listener); return { dispose() {} }; },
      onExit(listener) { events.on('exit', listener); return { dispose() {} }; },
      write(data) {
        this.writes.push(data);
        completePendingTasks(data);
        if (data === '\r') queueMicrotask(() => {
          events.emit('data', '\u001b[?25l\u001b[2K• Working');
          queueMicrotask(() => events.emit('data', '\r\ncodex READY\r\n'));
        });
      },
      resize() {},
      kill() { this.killed = true; },
    };
    children.push(child);
    queueMicrotask(() => events.emit('data', '\r\ncodex READY\r\n'));
    return child;
  };
  app = await makeApp(t, {
    spawnAgentTerminal,
    createAgentTerminalConversation:async () => ({
      conversationId:'persistent-codex-session', resume:true,
    }),
  });

  const runBatch = async instruction => {
    const revision = app.session.revision;
    const created = await fetch(`${app.url}/api/tasks?token=secret`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ ...taskInput, expectedRevision:revision, instruction }),
    }).then(response => response.json());
    const response = await fetch(`${app.url}/api/agent-runs?token=secret`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        expectedRevision:created.revision,
        taskIds:[created.task.id],
      }),
    });
    assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
    const deadline = Date.now() + 1_000;
    for (;;) {
      const run = await fetch(
        `${app.url}/api/agent-runs/current?token=secret`,
      ).then(value => value.json());
      if (!['queued', 'running'].includes(run.status)) {
        assert.equal(run.status, 'succeeded', JSON.stringify(run));
        while (['pending', 'submitting'].includes(
          app.agentTerminal.snapshot().startupPromptState,
        )) {
          if (Date.now() > deadline) assert.fail('等待初始指令自动回车超时');
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        return;
      }
      if (Date.now() > deadline) assert.fail('等待持久 Codex run 超时');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };

  await runBatch('第一批');
  await runBatch('第二批');
  assert.equal(spawnCount, 1);
  assert.equal(children[0].executable, 'codex');
  assert.deepEqual(children[0].args.slice(0, 3), [
    'resume', '--dangerously-bypass-approvals-and-sandbox', 'persistent-codex-session',
  ]);
  const submittedPrompts = children[0].writes.filter(value => /本批任务 ID/.test(value));
  assert.equal(submittedPrompts.length, 2);
  assert.match(submittedPrompts[0], /aico-ppt/);
  assert.doesNotMatch(submittedPrompts[1], /\$aico-ppt/);
  assert.equal(app.agentTerminal.snapshot().state, 'running');
  assert.equal(app.agentWorkspace.snapshot().workspaceRevision, 1);
  assert.equal(
    app.agentWorkspace.snapshot().providers.codex.activeConversationId,
    'persistent-codex-session',
  );
});

test('Agent 提示词提交超时不误杀已经开始执行的长任务', async t => {
  let app;
  const events = new EventEmitter();
  const child = {
    pid:7750, writes:[], killed:false,
    onData(listener) { events.on('data', listener); return { dispose() {} }; },
    onExit(listener) { events.on('exit', listener); return { dispose() {} }; },
    write(data) {
      this.writes.push(data);
      if (/本批任务 ID/.test(data)) {
        setTimeout(() => {
          for (const task of app.session.tasks) {
            if (task.status === 'pending') task.status = 'completed';
          }
        }, 900);
      }
      if (data === '\r') queueMicrotask(() => {
        events.emit('data', '\u001b[?25l\u001b[2K• Working');
      });
    },
    resize() {},
    kill() { this.killed = true; },
  };
  app = await makeApp(t, {
    agentRunTimeoutMs:500,
    spawnAgentTerminal:() => {
      queueMicrotask(() => events.emit('data', '\r\ncodex READY\r\n'));
      return child;
    },
    createAgentTerminalConversation:async () => ({
      conversationId:'long-running-codex-session', resume:true,
    }),
  });

  const created = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ ...taskInput, instruction:'执行超过提交超时的长任务' }),
  }).then(response => response.json());
  const response = await fetch(`${app.url}/api/agent-runs?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      expectedRevision:created.revision,
      taskIds:[created.task.id],
    }),
  });
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));

  await new Promise(resolve => setTimeout(resolve, 650));
  const active = await fetch(
    `${app.url}/api/agent-runs/current?token=secret`,
  ).then(value => value.json());
  assert.equal(active.status, 'running', JSON.stringify(active));

  const deadline = Date.now() + 1_000;
  for (;;) {
    const run = await fetch(
      `${app.url}/api/agent-runs/current?token=secret`,
    ).then(value => value.json());
    if (!['queued', 'running'].includes(run.status)) {
      assert.equal(run.status, 'succeeded', JSON.stringify(run));
      break;
    }
    if (Date.now() > deadline) assert.fail('等待长任务完成超时');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
});

test('Codex 长步骤中的 steer 输入框不提前结算批次或开放重复提交', async t => {
  let app;
  const events = new EventEmitter();
  const draftOutput = '\u001b[11;1H\u001b[1m›\u001b[11;3H\u001b[2mExplain this codebase'
    + '\u001b[?25h\u001b[11;3H\u001b[?2026l';
  const child = {
    pid:7760, writes:[], killed:false,
    onData(listener) { events.on('data', listener); return { dispose() {} }; },
    onExit(listener) { events.on('exit', listener); return { dispose() {} }; },
    write(data) {
      this.writes.push(data);
      if (data === '\r') queueMicrotask(() => {
        events.emit('data', '\u001b[?25l\u001b[2K• Working');
        queueMicrotask(() => {
          events.emit('data', `\r\n${'工具执行输出 '.repeat(420)}`);
          events.emit(
            'data',
            '\u001b[23;1Hgpt-5.6-sol xhigh · /tmp/aico-ppt' + draftOutput,
          );
        });
      });
    },
    resize() {},
    kill() { this.killed = true; },
  };
  app = await makeApp(t, {
    spawnAgentTerminal:() => {
      queueMicrotask(() => events.emit('data', '\r\ncodex READY\r\n'));
      return child;
    },
    createAgentTerminalConversation:async () => ({
      conversationId:'long-steer-codex-session', resume:true,
    }),
  });

  const created = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ ...taskInput, instruction:'长步骤期间不能误报失败' }),
  }).then(response => response.json());
  const response = await fetch(`${app.url}/api/agent-runs?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      expectedRevision:created.revision,
      taskIds:[created.task.id],
    }),
  });
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));

  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(app.agentTerminal.snapshot().turnState, 'active');
  assert.equal(app.agentTerminal.snapshot().promptReady, false);
  assert.equal(app.agentRuns.snapshot().status, 'running');
  const duplicateResponse = await fetch(`${app.url}/api/agent-runs?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      expectedRevision:app.session.revision,
      taskIds:[created.task.id],
    }),
  });
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicateResponse.status, 409, JSON.stringify(duplicate));
  assert.equal(duplicate.code, 'AGENT_TERMINAL_BUSY');

  app.session.tasks[0].status = 'completed';
  await app.agentRuns.activePromise;
  assert.equal(app.agentRuns.snapshot().status, 'succeeded');
});

test('批次一执行期间新增任务进入下一批，且只冻结批次一成员', async t => {
  const app = await makeApp(t, {
    agentRunAdapter:{
      id:'codex',
      async run({ signal }) {
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(
            new Error('测试结束'), { code:'AGENT_RUN_CANCELLED' },
          )), { once:true });
        });
      },
    },
  });
  const first = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ ...taskInput, instruction:'批次一任务' }),
  }).then(response => response.json());
  const startedResponse = await fetch(`${app.url}/api/agent-runs?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:first.revision, taskIds:[first.task.id] }),
  });
  const started = await startedResponse.json();
  assert.equal(startedResponse.status, 202, JSON.stringify(started));
  assert.deepEqual(started.activeBatch.taskIds, [first.task.id]);

  const secondResponse = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      ...taskInput,
      expectedRevision:started.sessionRevision,
      instruction:'批次二新标注',
    }),
  });
  const second = await secondResponse.json();
  assert.equal(secondResponse.status, 201, JSON.stringify(second));

  const active = await fetch(
    `${app.url}/api/agent-runs/current?token=secret`,
  ).then(response => response.json());
  assert.deepEqual(active.activeBatch.taskIds, [first.task.id]);
  assert.deepEqual(active.nextBatch.taskIds, [second.task.id]);
  assert.equal(active.canSubmitNext, false);

  const frozenResponse = await fetch(
    `${app.url}/api/tasks/${encodeURIComponent(first.task.id)}?token=secret`,
    {
      method:'PATCH', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ expectedRevision:second.revision, instruction:'不能修改在途任务' }),
    },
  );
  assert.equal(frozenResponse.status, 409);
  assert.equal((await frozenResponse.json()).error, 'AGENT_BATCH_TASK_LOCKED');

  const editableResponse = await fetch(
    `${app.url}/api/tasks/${encodeURIComponent(second.task.id)}?token=secret`,
    {
      method:'PATCH', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ expectedRevision:second.revision, instruction:'继续完善下一批标注' }),
    },
  );
  assert.equal(editableResponse.status, 200, JSON.stringify(await editableResponse.clone().json()));

  app.agentRuns.cancel('测试结束');
  await app.agentRuns.activePromise;
});

test('Agent CLI 按 Esc 取消当前批次、保留长期 PTY，并允许重新提交未完成任务', {
  timeout:5_000,
}, async t => {
  const children = [];
  const spawnAgentTerminal = (executable, args, options) => {
    const events = new EventEmitter();
    const child = {
      executable, args, options, pid:7800,
      writes:[], killed:false,
      onData(listener) { events.on('data', listener); return { dispose() {} }; },
      onExit(listener) { events.on('exit', listener); return { dispose() {} }; },
      write(data) {
        this.writes.push(data);
        if (data === '\r') queueMicrotask(() => {
          events.emit('data', '\u001b[?25l\u001b[2K• Working');
          queueMicrotask(() => events.emit('data', '\r\ncodex READY\r\n'));
        });
      },
      resize() {},
      kill() { this.killed = true; },
    };
    children.push(child);
    queueMicrotask(() => events.emit('data', '\r\ncodex READY\r\n'));
    return child;
  };
  const app = await makeApp(t, {
    spawnAgentTerminal,
    createAgentTerminalConversation:async () => ({
      conversationId:'escape-cancel-session', resume:true,
    }),
  });
  const created = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ ...taskInput, expectedRevision:0, instruction:'可被 Esc 中断' }),
  }).then(response => response.json());
  const startRun = async () => {
    const response = await fetch(`${app.url}/api/agent-runs?token=secret`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        expectedRevision:app.session.revision,
        taskIds:[created.task.id],
      }),
    });
    assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
    const deadline = Date.now() + 1_000;
    while (app.agentRuns.snapshot().status !== 'running'
      || app.agentTerminal.snapshot().state !== 'running'
      || ['pending', 'submitting'].includes(
        app.agentTerminal.snapshot().startupPromptState,
      )) {
      if (Date.now() > deadline) assert.fail('等待 Agent run 进入 running 超时');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };

  await startRun();
  app.agentTerminal.input('\u001b');
  await app.agentRuns.activePromise;
  assert.equal(app.agentRuns.snapshot().status, 'cancelled');
  assert.match(app.agentRuns.snapshot().message, /Esc|中断/);
  assert.equal(app.session.tasks[0].status, 'pending');
  assert.equal(app.agentTerminal.snapshot().state, 'running');
  assert.equal(children[0].killed, false);

  await startRun();
  assert.equal(app.agentRuns.snapshot().status, 'running');
  app.agentTerminal.input('\u001b');
  await app.agentRuns.activePromise;
});

test('已保存 Codex ID 不存在时创建可恢复替代会话而不是启动失败', async t => {
  const children = [];
  let resumedId = null;
  let initializationPrompt = null;
  const app = await makeApp(t, {
    agentThreadId:'019ff492-40fd-7383-b595-6d7440fe6172',
    resumeAgentTerminalConversation:async (_provider, options) => {
      resumedId = options.conversationId;
      throw Object.assign(new Error('No saved session found'), { code:'SESSION_NOT_FOUND' });
    },
    createAgentTerminalConversation:async (_provider, options) => {
      initializationPrompt = options.initialPrompt;
      return {
        conversationId:'019ff492-40fd-7383-b595-6d7440fe6173',
        resume:true,
        initialPromptConsumed:true,
      };
    },
    spawnAgentTerminal:(executable, args, options) => {
      const events = new EventEmitter();
      const child = {
        executable, args, options, pid:7999,
        onData(listener) { events.on('data', listener); return { dispose() {} }; },
        onExit(listener) { events.on('exit', listener); return { dispose() {} }; },
        write() {}, resize() {}, kill() {},
      };
      children.push(child);
      return child;
    },
  });
  await app.agentTerminal.start();
  assert.equal(resumedId, '019ff492-40fd-7383-b595-6d7440fe6172');
  assert.match(initializationPrompt, /aico-ppt/);
  assert.deepEqual(children[0].args, [
    'resume', '--dangerously-bypass-approvals-and-sandbox',
    '019ff492-40fd-7383-b595-6d7440fe6173',
  ]);
  assert.equal(
    app.agentWorkspace.snapshot().providers.codex.activeConversationId,
    '019ff492-40fd-7383-b595-6d7440fe6173',
  );
});

test('真实 multipart 创建附件任务，并仅在 API 与广播中派生绝对路径', async t => {
  const app = await makeApp(t);
  const ws = await connect(`${app.wsUrl}?token=secret`);
  t.after(() => ws.close());
  const eventPromise = nextMessage(ws);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const form = new FormData();
  form.append('task', new Blob([JSON.stringify({
    ...taskInput,
    attachmentSources:['selected', 'pasted'],
  })], { type:'application/json' }), 'task.json');
  form.append('snapshot', new Blob([png], { type:'image/png' }), 'region.png');
  form.append('attachment', new Blob([Buffer.from('reference')], {
    type:'text/plain',
  }), '说明.txt');
  form.append('attachment', new Blob([png], { type:'image/png' }), 'pasted.png');

  const response = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', body:form,
  });
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  assert.equal(result.task.attachments.length, 2);
  assert.ok(result.task.attachments.every(attachment => isAbsolute(attachment.path)));
  assert.equal(await readFile(result.task.attachments[0].path, 'utf8'), 'reference');
  assert.deepEqual(await readFile(result.task.attachments[1].path), png);

  const event = await eventPromise;
  assert.equal(event.type, 'task-created');
  assert.equal(event.payload.attachments[0].path, result.task.attachments[0].path);
  const listed = await fetch(`${app.url}/api/tasks?token=secret`).then(value => value.json());
  const detailed = await fetch(
    `${app.url}/api/tasks/${result.task.id}?token=secret`,
  ).then(value => value.json());
  assert.equal(listed[0].attachments[0].path, result.task.attachments[0].path);
  assert.equal(detailed.attachments[1].path, result.task.attachments[1].path);

  const persisted = JSON.parse(await readFile(join(app.sessionDir, 'session.json'), 'utf8'));
  assert.equal(Object.hasOwn(persisted.tasks[0].attachments[0], 'path'), false);
  assert.match(persisted.tasks[0].attachments[0].relativePath, /^attachments\//);
  const session = await fetch(`${app.url}/api/session?token=secret`).then(value => value.json());
  assert.equal(Object.hasOwn(session.tasks[0].attachments[0], 'path'), false);
});

test('任务附件输出拒绝 task 目录、文件、集合或 size 被替换', async t => {
  for (const target of ['task-directory', 'file', 'file-set', 'size']) {
    await t.test(target, async t => {
      const app = await makeApp(t);
      const created = await createAttachedTask(app);
      const attachment = created.task.attachments[0];
      const taskDirectory = dirname(attachment.path);
      const outside = join(app.sessionDir, '..', `outside-${target}`);
      await mkdir(outside);

      if (target === 'task-directory') {
        await rename(taskDirectory, `${taskDirectory}.trusted`);
        await writeFile(join(outside, basename(attachment.path)), 'outside directory target');
        await symlink(outside, taskDirectory, 'dir');
      } else if (target === 'file') {
        await rename(attachment.path, `${attachment.path}.trusted`);
        const outsideFile = join(outside, 'outside.txt');
        await writeFile(outsideFile, 'outside file target');
        await symlink(outsideFile, attachment.path);
      } else if (target === 'file-set') {
        await writeFile(
          join(taskDirectory, '33333333-3333-4333-8333-333333333333.txt'),
          'extra',
        );
      } else {
        await writeFile(attachment.path, 'wrong-size');
      }

      for (const endpoint of [
        '/api/tasks',
        `/api/tasks/${created.task.id}`,
      ]) {
        const response = await fetch(`${app.url}${endpoint}?token=secret`);
        const body = await response.json();
        assert.equal(response.status, 500, `${target} ${endpoint}: ${JSON.stringify(body)}`);
        assert.equal(body.code, 'UNSAFE_SIDECAR_IO');
        assert.equal(body.committed, false);
      }
      if (target === 'task-directory' || target === 'file') {
        assert.equal(
          await readFile(join(outside, target === 'task-directory'
            ? basename(attachment.path) : 'outside.txt'), 'utf8'),
          target === 'task-directory' ? 'outside directory target' : 'outside file target',
        );
      }
    });
  }
});

test('已耐久的 action、task-updated 与 group 仅在可信附件验证后输出', async t => {
  const app = await makeApp(t);
  const completedTask = await createAttachedTask(app, 'completed task attachment');
  const ambiguousTask = await createAttachedTask(
    app, 'ambiguous task attachment', { expectedRevision:1 },
  );
  const taskId = completedTask.task.id;
  const ambiguousTaskId = ambiguousTask.task.id;
  const outside = join(app.sessionDir, '..', 'outside-task-bearing-output.txt');
  await writeFile(outside, 'outside task-bearing output');
  for (const attachmentPath of [
    completedTask.task.attachments[0].path,
    ambiguousTask.task.attachments[0].path,
  ]) {
    await rename(attachmentPath, `${attachmentPath}.trusted`);
    await symlink(outside, attachmentPath);
  }
  const editor = await connect(app.editorWsUrl);
  t.after(() => editor.close());
  const requested = { ...action, taskId };

  let commandPromise = nextMessage(editor);
  let responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:2, taskId, actions:[requested] }),
  });
  let command = await commandPromise;
  await prepareAndCommit(editor, command);
  let response = await responsePromise;
  let body = await response.json();
  assert.equal(response.status, 500, JSON.stringify(body));
  assert.equal(body.code, 'UNSAFE_SIDECAR_IO');
  assert.equal(body.committed, true);
  assert.equal(body.commitScope, 'session');
  assert.equal(body.revision, 3);
  assert.equal(app.session.revision, 3);
  assert.equal(
    app.session.tasks.find(task => task.id === taskId)?.status,
    'completed',
  );
  const groupId = app.session.groups[0].id;

  commandPromise = nextMessage(editor);
  responsePromise = fetch(`${app.url}/api/groups/${groupId}/undo?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:3 }),
  });
  command = await commandPromise;
  await prepareAndCommit(editor, command);
  response = await responsePromise;
  body = await response.json();
  assert.equal(response.status, 500, JSON.stringify(body));
  assert.equal(body.code, 'UNSAFE_SIDECAR_IO');
  assert.equal(body.committed, true);
  assert.equal(body.commitScope, 'session');
  assert.equal(body.revision, 4);
  assert.equal(app.session.revision, 4);
  assert.equal(app.session.groups[0].active, false);

  commandPromise = nextMessage(editor);
  responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      expectedRevision:4,
      taskId:ambiguousTaskId,
      actions:[{ ...requested, taskId:ambiguousTaskId }],
    }),
  });
  command = await commandPromise;
  editor.send(JSON.stringify({
    type:'actions-rejected', commandId:command.commandId,
    code:'TARGET_AMBIGUOUS', failedActionId:requested.id,
    candidates:[{ path:'0/1' }],
  }));
  response = await responsePromise;
  body = await response.json();
  assert.equal(response.status, 500, JSON.stringify(body));
  assert.equal(body.code, 'UNSAFE_SIDECAR_IO');
  assert.equal(body.committed, true);
  assert.equal(body.commitScope, 'session');
  assert.equal(body.revision, 5);
  assert.equal(app.session.revision, 5);
  assert.equal(
    app.session.tasks.find(task => task.id === ambiguousTaskId)?.status,
    'needs-confirmation',
  );
  assert.equal(await readFile(outside, 'utf8'), 'outside task-bearing output');
});

test('任务路由拒绝未知媒体类型，multipart 限额错误不创建 task', async t => {
  const app = await makeApp(t);
  for (const contentType of [
    'text/plain',
    'application/jsonp',
    'application/json-evil; charset=utf-8',
    'multipart/form-datax; boundary=forged',
  ]) {
    const unsupported = await fetch(`${app.url}/api/tasks?token=secret`, {
      method:'POST', headers:{ 'content-type':contentType }, body:'task',
    });
    assert.equal(unsupported.status, 415, contentType);
    assert.equal((await unsupported.json()).code, 'UNSUPPORTED_MEDIA_TYPE');
  }

  const parameterizedJson = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST',
    headers:{ 'content-type':' Application/JSON ; charset=utf-8' },
    body:JSON.stringify(taskInput),
  });
  assert.equal(parameterizedJson.status, 201);

  const empty = new FormData();
  empty.append('task', new Blob([JSON.stringify({
    ...taskInput, expectedRevision:1, attachmentSources:['selected'],
  })], { type:'application/json' }), 'task.json');
  empty.append('attachment', new Blob([Buffer.alloc(0)], {
    type:'application/octet-stream',
  }), 'empty.bin');
  const emptyResponse = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', body:empty,
  });
  assert.equal(emptyResponse.status, 400);
  assert.equal((await emptyResponse.json()).code, 'ATTACHMENT_EMPTY');

  const tooMany = new FormData();
  tooMany.append('task', new Blob([JSON.stringify({
    ...taskInput, expectedRevision:1, attachmentSources:Array(9).fill('selected'),
  })], { type:'application/json' }), 'task.json');
  for (let index = 0; index < 9; index += 1) {
    tooMany.append('attachment', new Blob([Buffer.from('x')]), `${index}.txt`);
  }
  const tooManyResponse = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', body:tooMany,
  });
  assert.equal(tooManyResponse.status, 413);
  assert.equal((await tooManyResponse.json()).code, 'TOO_MANY_ATTACHMENTS');

  const oversized = new FormData();
  oversized.append('task', new Blob([JSON.stringify({
    ...taskInput, expectedRevision:1, attachmentSources:['selected'],
  })], { type:'application/json' }), 'task.json');
  oversized.append('attachment', new Blob([Buffer.alloc((25 * 1024 * 1024) + 1)]), 'large.bin');
  const oversizedResponse = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', body:oversized,
  });
  assert.equal(oversizedResponse.status, 413);
  assert.equal((await oversizedResponse.json()).code, 'ATTACHMENT_TOO_LARGE');

  const boundary = 'truncated-service-boundary';
  const truncatedResponse = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST',
    headers:{ 'content-type':`multipart/form-data; boundary=${boundary}` },
    body:Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="task"; filename="task.json"\r\n`
      + 'Content-Type: application/json\r\n\r\n'
      + JSON.stringify({ ...taskInput, expectedRevision:1, attachmentSources:[] }),
    ),
  });
  assert.equal(truncatedResponse.status, 400);
  assert.equal((await truncatedResponse.json()).code, 'INVALID_MULTIPART');
  assert.equal(app.session.revision, 1);
  assert.equal(app.session.tasks.length, 1);
});

test('附件 writer 使用独立注入点，失败保留稳定事务错误字段', async t => {
  let deckWriterCalls = 0;
  let attachmentWriterCalls = 0;
  const app = await makeApp(t, {
    spawnWriter:() => { deckWriterCalls += 1; throw new Error('deck writer 不应启动'); },
    spawnAttachmentWriter:(command, args, options) => {
      attachmentWriterCalls += 1;
      const configIndex = args.indexOf('--config') + 1;
      const config = JSON.parse(args[configIndex]);
      config.session.ino = '0';
      const corruptedArgs = [...args];
      corruptedArgs[configIndex] = JSON.stringify(config);
      return spawnProcess(command, corruptedArgs, options);
    },
  });
  const form = new FormData();
  form.append('task', new Blob([JSON.stringify({
    ...taskInput, attachmentSources:['selected'],
  })], { type:'application/json' }), 'task.json');
  form.append('attachment', new Blob([Buffer.from('x')]), 'x.txt');
  const response = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', body:form,
  });
  const result = await response.json();
  assert.equal(response.status, 500);
  assert.equal(result.code, 'UNSAFE_SIDECAR_IO');
  assert.equal(result.stage, 'attachment-identity');
  assert.equal(result.committed, false);
  assert.equal(attachmentWriterCalls, 1);
  assert.equal(deckWriterCalls, 0);
  assert.equal(app.session.revision, 0);
});

test('重启 reconcile 保留权威任务附件并删除孤儿与 staging', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-attachment-reconcile-'));
  const deckPath = join(root, 'deck.html');
  await writeFile(deckPath, 'deck');
  let app = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false, token:'secret',
  });
  const form = new FormData();
  form.append('task', new Blob([JSON.stringify({
    ...taskInput, attachmentSources:['selected'],
  })], { type:'application/json' }), 'task.json');
  form.append('attachment', new Blob([Buffer.from('authoritative')]), 'kept.txt');
  const createdResponse = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', body:form,
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const keptPath = created.task.attachments[0].path;
  await app.close();

  const attachments = join(app.sessionDir, 'attachments');
  const orphanId = '11111111-1111-4111-8111-111111111111';
  const uploadId = '22222222-2222-4222-8222-222222222222';
  const orphanAttachmentId = '33333333-3333-4333-8333-333333333333';
  const stagedAttachmentId = '44444444-4444-4444-8444-444444444444';
  await mkdir(join(attachments, orphanId));
  await writeFile(join(attachments, orphanId, `${orphanAttachmentId}.txt`), 'orphan');
  await mkdir(join(attachments, '.staging', uploadId));
  await writeFile(
    join(attachments, '.staging', uploadId, `${stagedAttachmentId}.txt`),
    'partial',
  );

  app = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false, token:'secret',
  });
  t.after(() => app.close());
  assert.equal(await readFile(keptPath, 'utf8'), 'authoritative');
  assert.deepEqual((await readdir(attachments)).sort(), ['.staging', created.task.id].sort());
  assert.deepEqual(await readdir(join(attachments, '.staging')), []);
  const listed = await fetch(`${app.url}/api/tasks?token=secret`).then(value => value.json());
  assert.equal(listed[0].attachments[0].path, keptPath);
});

test('server.close 先取消附件 upload 与 writer，再关闭 sidecar', async t => {
  let spawnedResolve;
  const spawned = new Promise(resolve => { spawnedResolve = resolve; });
  let killed = 0;
  let active = 0;
  const spawnAttachmentWriter = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) { callback(); },
    });
    child.kill = () => {
      killed += 1;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      queueMicrotask(() => {
        active -= 1;
        child.emit('close', null, 'SIGKILL');
      });
      return true;
    };
    active += 1;
    spawnedResolve();
    return child;
  };
  const app = await makeApp(t, {
    spawnAttachmentWriter,
    attachmentWriterTimeoutMs:30_000,
  });
  const form = new FormData();
  form.append('task', new Blob([JSON.stringify({
    ...taskInput, attachmentSources:['selected'],
  })], { type:'application/json' }), 'task.json');
  form.append('attachment', new Blob([Buffer.from('pending')]), 'pending.txt');
  const responsePromise = fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', body:form,
  }).catch(error => error);
  await spawned;
  let closeTimeout;
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => {
        closeTimeout = setTimeout(
          () => reject(new Error('server.close 未在 2s 内收敛')),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(closeTimeout);
  }
  await responsePromise;
  assert.equal(killed, 1);
  assert.equal(active, 0);
});

test('服务运行期间 attachments 被替换为 symlink 时拒绝上传且不写 outside', async t => {
  const app = await makeApp(t);
  const attachments = join(app.sessionDir, 'attachments');
  const trusted = `${attachments}.trusted-original`;
  const outside = join(app.sessionDir, '..', 'outside-attachments');
  await rename(attachments, trusted);
  await mkdir(outside);
  await symlink(outside, attachments, 'dir');

  const form = new FormData();
  form.append('task', new Blob([JSON.stringify({
    ...taskInput, attachmentSources:['selected'],
  })], { type:'application/json' }), 'task.json');
  form.append('attachment', new Blob([Buffer.from('blocked')]), 'blocked.txt');
  const response = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', body:form,
  });
  const result = await response.json();
  assert.equal(response.status, 500);
  assert.equal(result.code, 'UNSAFE_SIDECAR');
  assert.equal(result.stage, 'sidecar');
  assert.deepEqual(await readdir(outside), []);
  assert.equal(app.session.revision, 0);
  assert.deepEqual(app.session.tasks, []);
});

test('任务快照仅接受限额内 PNG，落盘后响应与 session 均无 data URL', async t => {
  const app = await makeApp(t);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const response = await fetch(`${app.url}/api/tasks?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...taskInput,
      snapshot: `data:image/png;base64,${png.toString('base64')}`,
    }),
  });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.task.snapshot, undefined);
  assert.equal(result.task.snapshotPath, `snapshots/${result.task.id}.png`);
  assert.deepEqual(await readFile(join(app.sessionDir, result.task.snapshotPath)), png);
  assert.doesNotMatch(await readFile(join(app.sessionDir, 'session.json'), 'utf8'), /data:image\/png/);

  const bad = await fetch(`${app.url}/api/tasks?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...taskInput, expectedRevision: 1, snapshot: 'data:image/png;base64,bm90LXBuZw==' }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'INVALID_SNAPSHOT');

  const oversized = Buffer.concat([png.subarray(0, 8), Buffer.alloc(512 * 1024, 1)]).toString('base64');
  const tooLarge = await fetch(`${app.url}/api/tasks?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...taskInput,
      expectedRevision: 1,
      snapshot: `data:image/png;base64,${oversized}`,
    }),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error, 'SNAPSHOT_TOO_LARGE');
  assert.equal(app.session.revision, 1);
});

test('所有受保护路由都拒绝无令牌请求且 Bearer 可授权', async t => {
  const app = await makeApp(t);
  const routes = [
    ['GET', '/api/session'],
    ['GET', '/api/tasks'],
    ['POST', '/api/tasks'],
    ['GET', '/api/tasks/missing'],
    ['POST', '/api/tasks/missing/source-edit/begin'],
    ['POST', '/api/tasks/missing/source-edit/cancel'],
    ['POST', '/api/source-edits'],
    ['POST', '/api/source-edits/33333333-3333-4333-8333-333333333333/commit'],
    ['POST', '/api/source-edits/33333333-3333-4333-8333-333333333333/cancel'],
    ['POST', '/api/actions'],
    ['POST', '/api/groups/missing/undo'],
    ['POST', '/api/groups/missing/redo'],
    ['POST', '/api/write-deck'],
    ['POST', '/api/solidify-deck'],
    ['GET', '/preview'],
    ['GET', '/editor/index.html'],
    ['GET', '/events'],
  ];

  for (const [method, path] of routes) {
    const response = await fetch(`${app.url}${path}`, { method });
    assert.equal(response.status, 403, `${method} ${path}`);
  }

  const authorized = await fetch(`${app.url}/api/session`, {
    headers: { authorization: 'Bearer secret' },
  });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).revision, 0);

  const wrongToken = new WebSocket(`${app.wsUrl}?token=wrong`);
  const rejected = await new Promise(resolve => {
    wrongToken.once('unexpected-response', (_request, response) => resolve(response.statusCode));
    wrongToken.once('error', () => resolve(0));
  });
  assert.equal(rejected, 403);
  wrongToken.terminate();
});

test('服务只允许 loopback 监听地址', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-loopback-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck');

  for (const host of ['0.0.0.0', '::', '127.000.000.001']) {
    await t.test(`拒绝 ${host}`, async () => {
      let app;
      try {
        app = await startServer({ deckPath:deck, host, port:0, openBrowser:false });
        assert.fail(`不应监听非 loopback 地址 ${host}`);
      } catch (error) {
        if (error?.code === 'ERR_ASSERTION') throw error;
        assert.equal(error.code, 'INVALID_HOST');
      } finally {
        await app?.close();
      }
    });
  }

  for (const [name, options, expectedUrl] of [
    ['默认地址', {}, /^http:\/\/127\.0\.0\.1:/],
    ['localhost', { host:'localhost' }, /^http:\/\/localhost:/],
    ['127.0.0.1', { host:'127.0.0.1' }, /^http:\/\/127\.0\.0\.1:/],
    ['::1', { host:'::1' }, /^http:\/\/\[::1\]:/],
  ]) {
    await t.test(`接受 ${name}`, async () => {
      const app = await startServer({
        deckPath:deck, port:0, openBrowser:false, ...options,
      });
      assert.match(app.url, expectedUrl);
      await app.close();
    });
  }
});

test('携带 Origin 的 HTTP 与 WebSocket 只接受当前本地服务源', async t => {
  const app = await makeApp(t);
  const evilHttp = await fetch(`${app.url}/api/session?token=secret`, {
    headers:{ Origin:'https://evil.example' },
  });
  assert.equal(evilHttp.status, 403);

  const localHttp = await fetch(`${app.url}/api/session?token=secret`, {
    headers:{ Origin:app.url },
  });
  assert.equal(localHttp.status, 200);
  assert.equal((await fetch(`${app.url}/api/session?token=secret`)).status, 200);

  assert.equal(await rejectedWebSocketStatus(
    `${app.wsUrl}?token=secret`,
    { headers:{ Origin:'https://evil.example' } },
  ), 403);
  const localSocket = await connect(
    `${app.wsUrl}?token=secret`, { headers:{ Origin:app.url } },
  );
  localSocket.close();
  const cliSocket = await connect(`${app.wsUrl}?token=secret`);
  cliSocket.close();
});

test('sidecar root 或 session 祖先为 symlink 时 server 启动即拒绝且不写 outside', async t => {
  for (const level of ['root', 'session']) {
    await t.test(level, async () => {
      const project = await mkdtemp(join(tmpdir(), `deck-sidecar-${level}-`));
      const deck = join(project, 'deck.html');
      const deckBytes = Buffer.from(validBundle());
      await writeFile(deck, deckBytes);
      const outside = join(project, 'outside');
      await mkdir(outside);
      const sidecarRoot = join(project, '.aico-ppt-editor');
      if (level === 'root') {
        await symlink(outside, sidecarRoot);
      } else {
        await mkdir(sidecarRoot);
        const sessionName = `deck-${sha256(deckBytes).slice(0, 8)}`;
        await symlink(outside, join(sidecarRoot, sessionName));
      }

      let app;
      let startupError;
      try {
        app = await startServer({
          deckPath:deck, host:'127.0.0.1', port:0, openBrowser:false,
        });
      } catch (error) {
        startupError = error;
      } finally {
        await app?.close();
      }

      assert.equal(app, undefined, '不应在不可信 sidecar 上启动服务');
      assert.equal(startupError?.code, 'UNSAFE_SIDECAR');
      assert.deepEqual(await readdir(outside), []);
    });
  }
});

test('服务启动后 sidecar root 或 session 身份被替换时保存前拒绝且不写替换目录', async t => {
  for (const level of ['root', 'session']) {
    await t.test(level, async subtest => {
      let spawnCalls = 0;
      const child = fakeWriterChild({
        onEnd:current => queueMicrotask(() => {
          current.stdout.emit('data', `${JSON.stringify({
            ok:false, code:'WRITE_FAILED', stage:'write', message:'stop',
          })}\n`);
          current.emit('close', 0);
        }),
      });
      const app = await makeApp(subtest, {
        deckContents:validBundle(),
        spawnWriter:() => {
          spawnCalls += 1;
          return child;
        },
      });
      await connectDiagnosticsEditor(subtest, app);
      const deckBefore = await readFile(app.deckPath);
      const memoryBefore = structuredClone(app.session);
      const replacementSession = await replaceSidecarIdentity(app, level);

      const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ expectedRevision:0 }),
      });
      const body = await response.json();

      assert.equal(body.code, 'UNSAFE_SIDECAR', JSON.stringify(body));
      assert.equal(spawnCalls, 0, '身份 guard 必须先于 backup 和 writer');
      assert.deepEqual(await readdir(join(replacementSession, 'backups')), []);
      assert.deepEqual(await readdir(join(replacementSession, 'transactions')), []);
      assert.deepEqual(await readFile(app.deckPath), deckBefore);
      assert.deepEqual(app.session, memoryBefore);
    });
  }
});

test('server guard 后项目根目录被替换时 adapter 以启动 identity 拒绝且零写入', async t => {
  let swapped = false;
  let trustedProject;
  let trustedDeck;
  let replacementDeck;
  let outsideFile;
  const replacementBytes = Buffer.from('replacement deck must stay untouched');
  const outsideBytes = Buffer.from('outside sentinel must stay untouched');
  const originalBytes = Buffer.from(validBundle());
  const configuredPython = process.platform === 'darwin' ? '/usr/bin/python3' : 'python3';
  const app = await makeApp(t, {
    deckContents:originalBytes,
    pythonExecutable:configuredPython,
    spawnWriter:(command, args, options) => {
      assert.equal(command, configuredPython);
      assert.equal(options.env.PYTHONIOENCODING, 'utf-8');
      assert.equal(options.env.PYTHONUTF8, '1');
      if (!swapped) {
        swapped = true;
        const project = dirname(app.deckPath);
        trustedProject = `${project}-trusted`;
        trustedDeck = join(trustedProject, 'deck.html');
        replacementDeck = app.deckPath;
        outsideFile = `${project}-outside.txt`;
        renameSync(project, trustedProject);
        mkdirSync(project);
        writeFileSync(replacementDeck, replacementBytes);
        writeFileSync(outsideFile, outsideBytes);
      }
      return spawnProcess(command, args, options);
    },
  });
  await connectDiagnosticsEditor(t, app);

  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0 }),
  });
  const body = await response.json();

  assert.equal(swapped, true);
  assert.equal(response.status, 500);
  assert.equal(body.code, 'UNSAFE_SIDECAR', JSON.stringify(body));
  assert.deepEqual(await readFile(trustedDeck), originalBytes);
  assert.deepEqual(await readFile(replacementDeck), replacementBytes);
  assert.deepEqual(await readFile(outsideFile), outsideBytes);
  assert.deepEqual(await readdir(dirname(replacementDeck)), ['deck.html']);
});

test('sidecar writer identity 包含可信 attachments 与 staging 目录', async t => {
  let writerIdentity;
  const child = fakeWriterChild({
    onEnd:current => queueMicrotask(() => {
      current.stdout.emit('data', `${JSON.stringify({
        ok:false, code:'WRITE_FAILED', stage:'write', message:'stop after identity capture',
      })}\n`);
      current.emit('close', 0);
    }),
  });
  const app = await makeApp(t, {
    deckContents:validBundle(),
    spawnWriter:(_command, args) => {
      writerIdentity = JSON.parse(args.at(-3));
      return child;
    },
  });
  await connectDiagnosticsEditor(t, app);

  await fetch(`${app.url}/api/write-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0 }),
  });

  assert.deepEqual(Object.keys(writerIdentity).sort(), [
    'attachmentStaging', 'attachments', 'backups', 'project', 'root', 'session',
    'snapshots', 'transactions', 'writeErrors',
  ]);
  assert.equal(writerIdentity.attachments.path, join(app.sessionDir, 'attachments'));
  assert.equal(
    writerIdentity.attachmentStaging.path,
    join(app.sessionDir, 'attachments', '.staging'),
  );
});

test('SessionStore 每次 persist 前复核启动时 sidecar 身份', async t => {
  for (const level of ['root', 'session']) {
    await t.test(level, async subtest => {
      const app = await makeApp(subtest);
      const memoryBefore = structuredClone(app.session);
      const replacementSession = await replaceSidecarIdentity(app, level);

      const response = await fetch(`${app.url}/api/tasks?token=secret`, {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify(taskInput),
      });
      const body = await response.json();

      assert.equal(body.code, 'UNSAFE_SIDECAR', JSON.stringify(body));
      assert.deepEqual(await readdir(replacementSession), [
        'backups', 'snapshots', 'transactions',
      ]);
      assert.deepEqual(app.session, memoryBefore);
    });
  }
});

test('editor capability 隔离 observer 且拒绝错误或重复 editor', async t => {
  const app = await makeApp(t);
  const editorUrl = app.editorWsUrl
    ?? `${app.wsUrl}?token=secret&editorToken=editor-secret`;
  const editor = await connect(editorUrl);
  const observer = await connect(`${app.wsUrl}?token=secret`);
  t.after(() => editor.close());
  t.after(() => observer.close());

  const editorMessage = nextMessage(editor).then(message => ({ source: 'editor', message }));
  const observerMessage = nextMessage(observer).then(message => ({ source: 'observer', message }));
  const responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [action] }),
  });
  const received = await Promise.race([editorMessage, observerMessage]);
  assert.equal(received.source, 'editor');
  assert.equal(received.message.type, 'apply-actions');

  observer.send(JSON.stringify({
    type: 'actions-prepared',
    commandId: received.message.commandId,
    applied: 1,
    results: received.message.actions,
  }));
  const forgedSettled = await Promise.race([
    responsePromise.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 25)),
  ]);
  assert.equal(forgedSettled, false);
  assert.equal(app.session.revision, 0);

  await prepareAndCommit(editor, received.message);
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, 1);

  assert.equal(app.editorToken, 'editor-secret');
  assert.match(app.editorWsUrl, /editorToken=editor-secret/);
  const sessionBody = await fetch(`${app.url}/api/session?token=secret`).then(value => value.text());
  assert.doesNotMatch(sessionBody, /editor-secret/);
  assert.equal(
    await rejectedWebSocketStatus(`${app.wsUrl}?token=secret&editorToken=wrong`),
    403,
  );
  assert.equal(await rejectedWebSocketStatus(app.editorWsUrl), 409);
});

test('Action RPC 仅在编辑器回执后写入 Journal 并持久化 revision', async t => {
  const app = await makeApp(t);
  const offline = await fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [action] }),
  });
  assert.equal(offline.status, 409);
  assert.equal((await offline.json()).error, 'EDITOR_OFFLINE');

  const ws = await connect(app.editorWsUrl);
  t.after(() => ws.close());
  const commandPromise = nextMessage(ws);
  const responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [action] }),
  });
  const command = await commandPromise;
  assert.equal(command.type, 'apply-actions');
  assert.deepEqual(command.actions, [action]);

  const beforeAck = await fetch(`${app.url}/api/session?token=secret`).then(value => value.json());
  assert.equal(beforeAck.revision, 0);
  assert.deepEqual(beforeAck.groups, []);

  await prepareAndCommit(ws, command);
  const response = await responsePromise;
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.revision, 1);
  assert.equal(result.applied, 1);
  assert.ok(result.groupId);

  const persisted = JSON.parse(await readFile(join(app.sessionDir, 'session.json'), 'utf8'));
  assert.equal(persisted.revision, 1);
  assert.equal(persisted.groups[0].id, result.groupId);

  const conflict = await fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [action] }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'REVISION_CONFLICT');
});

test('close 已开始时 apply 的迟到持久化错误统一为 SERVICE_CLOSED，且不再回滚或 finalize', async () => {
  const state = {
    version:1, sessionId:'session-close-apply', deckPath:'/tmp/deck.html',
    deckFingerprint:'deck', revision:0, tasks:[], groups:[], redo:[],
    diagnosticsBaseline:{}, diagnosticsCurrent:{}, diagnosticsRevision:null, conflict:null,
  };
  let rejectPersist;
  let signalPersistStarted;
  const persistStarted = new Promise(resolve => { signalPersistStarted = resolve; });
  const sessionStore = {
    state, sessionPath:'/tmp/session.json',
    async persistState() {
      signalPersistStarted();
      return new Promise((resolve, reject) => { rejectPersist = reject; });
    },
  };
  const bridge = new BridgeService({ sessionStore });
  const commands = [];
  const socket = {
    readyState:1,
    send(data) {
      const message = JSON.parse(data);
      commands.push(message.type);
      if (message.type === 'apply-actions') {
        queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
          type:'actions-prepared', commandId:message.commandId,
          applied:message.actions.length, results:message.actions,
        })));
      }
    },
  };
  bridge.setEditorSocket(socket);

  const applying = bridge.applyActions({
    taskId:null, actions:[action], expectedRevision:0,
  });
  await persistStarted;
  bridge.close();
  rejectPersist(Object.assign(new Error('late session failure'), {
    committed:true, commitScope:'session', stage:'session-directory-fsync',
  }));

  await assert.rejects(
    applying,
    error => error.code === 'SERVICE_CLOSED' && error.statusCode === 503,
  );
  assert.deepEqual(commands, ['apply-actions']);
});

test('close 对 task、undo/redo 与 diagnostics 的迟到 helper 错误统一优先返回 SERVICE_CLOSED', async t => {
  await t.test('task', async () => {
    const state = { revision:0, tasks:[], groups:[], redo:[] };
    let rejectTask;
    let signalStarted;
    const started = new Promise(resolve => { signalStarted = resolve; });
    const bridge = new BridgeService({
      sessionStore:{
        state, sessionPath:'/tmp/session.json',
        async createTask() {
          signalStarted();
          return new Promise((resolve, reject) => { rejectTask = reject; });
        },
      },
    });
    const pending = bridge.createTask({ instruction:'改' }, 0);
    await started;
    bridge.close();
    rejectTask(new Error('late task helper failure'));
    await assert.rejects(pending, error => error.code === 'SERVICE_CLOSED');
    assert.equal(state.revision, 0);
    assert.deepEqual(state.tasks, []);
  });

  for (const method of ['undoGroup', 'redoGroup']) {
    await t.test(method, async () => {
      const active = method === 'undoGroup';
      const state = {
        revision:1, tasks:[],
        groups:[{
          id:'group-1', taskId:'task-1',
          actions:[{ ...action, taskId:'task-1' }], active,
        }],
        redo:active ? [] : ['group-1'],
      };
      let rejectPersist;
      let signalStarted;
      const started = new Promise(resolve => { signalStarted = resolve; });
      const bridge = new BridgeService({
        sessionStore:{
          state, sessionPath:'/tmp/session.json',
          async persistState() {
            signalStarted();
            return new Promise((resolve, reject) => { rejectPersist = reject; });
          },
        },
      });
      const commands = [];
      const socket = {
        readyState:1,
        send(data) {
          const message = JSON.parse(data);
          commands.push(message.type);
          if (message.type === 'apply-actions') {
            queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
              type:'actions-prepared', commandId:message.commandId,
              applied:message.actions.length, results:message.actions,
            })));
          }
        },
      };
      bridge.setEditorSocket(socket);
      const pending = bridge[method]('group-1', 1);
      await started;
      bridge.close();
      rejectPersist(new Error('late journal helper failure'));
      await assert.rejects(pending, error => error.code === 'SERVICE_CLOSED');
      assert.deepEqual(commands, ['apply-actions']);
      assert.equal(state.revision, 1);
      assert.equal(state.groups[0].active, active);
    });
  }

  await t.test('diagnostics', async () => {
    const page = {
      pageKey:'page-001-close-diagnostics', sectionOverflow:{ x:0, y:0 }, nestedClips:[],
    };
    const state = {
      revision:0, tasks:[], groups:[], redo:[], deckFingerprint:'deck',
      diagnosticsBaseline:{}, diagnosticsCurrent:{}, diagnosticsRevision:null, conflict:null,
    };
    let rejectPersist;
    let signalStarted;
    const started = new Promise(resolve => { signalStarted = resolve; });
    const bridge = new BridgeService({
      sessionStore:{
        state, sessionPath:'/tmp/session.json',
        async persistState() {
          signalStarted();
          return new Promise((resolve, reject) => { rejectPersist = reject; });
        },
      },
    });
    const socket = { readyState:1, send() {} };
    bridge.setEditorSocket(socket);
    bridge.handleMessage(socket, JSON.stringify({
      type:'deck-ready', pages:[{ index:1, label:'测试页', pageKey:page.pageKey }],
      diagnostics:[page],
    }));
    await started;
    let writerCalls = 0;
    const pending = bridge.writeDeck(0, {
      fingerprint:async () => 'deck',
      writer:async () => { writerCalls += 1; },
      restore:async () => {},
    });
    bridge.close();
    rejectPersist(new Error('late diagnostics helper failure'));
    await assert.rejects(pending, error => error.code === 'SERVICE_CLOSED');
    assert.equal(writerCalls, 0);
    assert.deepEqual(state.diagnosticsBaseline, {});
  });
});

test('action 的 session 写已 committed 后发布候选并冻结，且不回滚或 finalize', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-action-committed-session-'));
  const sessionPath = join(root, 'session.json');
  const createdAt = new Date(0).toISOString();
  const state = {
    version:1, sessionId:'session-action', deckPath:join(root, 'deck.html'),
    deckFingerprint:'deck', revision:0,
    tasks:[{
      id:'task-1', status:'pending', candidates:[], createdAt, updatedAt:createdAt,
    }],
    groups:[], redo:[],
    diagnosticsBaseline:{}, diagnosticsCurrent:{}, diagnosticsRevision:null, conflict:null,
  };
  let observedRevisionDuringWrite = null;
  let createTaskCalls = 0;
  const sessionStore = {
    state, sessionPath,
    async persistState(candidate = state) {
      observedRevisionDuringWrite = state.revision;
      await writeFile(sessionPath, JSON.stringify(candidate));
      throw Object.assign(new Error('session directory fsync failed after rename'), {
        committed:true,
        commitScope:'session',
      });
    },
    async createTask() { createTaskCalls += 1; },
  };
  const bridge = new BridgeService({ sessionStore });
  let rollbackCommands = 0;
  let finalizeCommands = 0;
  const socket = {
    readyState:1,
    send(data) {
      const message = JSON.parse(data);
      if (message.type === 'apply-actions') {
        queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
          type:'actions-prepared', commandId:message.commandId,
          applied:message.actions.length, results:message.actions,
        })));
      } else if (message.type === 'rollback-actions') {
        rollbackCommands += 1;
        queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
          type:'actions-rolled-back', commandId:message.commandId, rolledBack:true,
        })));
      } else if (message.type === 'commit-actions') {
        finalizeCommands += 1;
      }
    },
  };
  bridge.setEditorSocket(socket);

  await assert.rejects(
    bridge.applyActions({
      taskId:'task-1', actions:[{ ...action, taskId:'task-1' }], expectedRevision:0,
    }),
    error => error.code === 'RECOVERY_REQUIRED' && error.statusCode === 503
      && error.committed === true,
  );

  const disk = JSON.parse(await readFile(sessionPath, 'utf8'));
  assert.equal(observedRevisionDuringWrite, 0, 'journal 写成功前不得发布候选 revision');
  assert.equal(state.revision, 1);
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0].taskId, 'task-1');
  assert.equal(state.tasks[0].status, 'completed');
  assert.equal(state.tasks[0].groupId, state.groups[0].id);
  assert.equal(disk.revision, 1);
  assert.deepEqual(disk.groups, state.groups);
  assert.deepEqual(disk.tasks, state.tasks);
  assert.equal(rollbackCommands, 0);
  assert.equal(finalizeCommands, 0);
  await assert.rejects(
    bridge.createTask({ instruction:'later' }, 1),
    error => error.code === 'RECOVERY_REQUIRED' && error.statusCode === 503,
  );
  assert.equal(createTaskCalls, 0);
  await assert.rejects(
    bridge.writeDeck(1, {}),
    error => error.code === 'RECOVERY_REQUIRED' && error.statusCode === 503,
  );
});

test('undo/redo 的 session 写已 committed 后保留候选 journal 并冻结', async t => {
  for (const method of ['undo', 'redo']) {
    await t.test(method, async () => {
      const root = await mkdtemp(join(tmpdir(), `deck-${method}-committed-session-`));
      const sessionPath = join(root, 'session.json');
      const groupId = `group-${method}`;
      const initiallyActive = method === 'undo';
      const createdAt = new Date(0).toISOString();
      const state = {
        version:1, sessionId:`session-${method}`, deckPath:join(root, 'deck.html'),
        deckFingerprint:'deck', revision:1,
        tasks:[{
          id:'task-1', status:initiallyActive ? 'completed' : 'pending',
          ...(initiallyActive ? { groupId } : {}), candidates:[], createdAt, updatedAt:createdAt,
        }],
        groups:[{
          id:groupId, taskId:'task-1',
          actions:[{ ...action, taskId:'task-1' }], active:initiallyActive,
        }],
        redo:initiallyActive ? [] : [groupId], diagnosticsBaseline:{},
        diagnosticsCurrent:{}, diagnosticsRevision:null, conflict:null,
      };
      let observedRevisionDuringWrite = null;
      const sessionStore = {
        state, sessionPath,
        async persistState(candidate = state) {
          observedRevisionDuringWrite = state.revision;
          await writeFile(sessionPath, JSON.stringify(candidate));
          throw Object.assign(new Error('session committed'), {
            committed:true, commitScope:'session',
          });
        },
      };
      const bridge = new BridgeService({ sessionStore });
      let rollbackCommands = 0;
      let finalizeCommands = 0;
      const socket = {
        readyState:1,
        send(data) {
          const message = JSON.parse(data);
          if (message.type === 'apply-actions') {
            queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
              type:'actions-prepared', commandId:message.commandId,
              applied:message.actions.length, results:message.actions,
            })));
          } else if (message.type === 'rollback-actions') {
            rollbackCommands += 1;
          } else if (message.type === 'commit-actions') {
            finalizeCommands += 1;
          }
        },
      };
      bridge.setEditorSocket(socket);

      await assert.rejects(
        method === 'undo'
          ? bridge.undoGroup(groupId, 1)
          : bridge.redoGroup(groupId, 1),
        error => error.code === 'RECOVERY_REQUIRED' && error.committed === true,
      );

      const disk = JSON.parse(await readFile(sessionPath, 'utf8'));
      assert.equal(observedRevisionDuringWrite, 1);
      assert.equal(state.revision, 2);
      assert.equal(state.groups[0].active, method === 'redo');
      assert.deepEqual(state.redo, method === 'undo' ? [groupId] : []);
      assert.equal(state.tasks[0].status, 'completed');
      assert.equal(state.tasks[0].groupId, groupId);
      assert.equal(state.tasks[0].effectState, method === 'undo' ? 'undone' : 'active');
      assert.equal(disk.revision, state.revision);
      assert.deepEqual(disk.groups, state.groups);
      assert.deepEqual(disk.tasks, state.tasks);
      assert.equal(rollbackCommands, 0);
      assert.equal(finalizeCommands, 0);
    });
  }
});

test('diagnostics 的 session 写已 committed 后发布候选并冻结后续 mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-diagnostics-committed-session-'));
  const sessionPath = join(root, 'session.json');
  const page = {
    pageKey:'page-001-committed-diagnostics',
    sectionOverflow:{ x:0, y:0 }, nestedClips:[],
  };
  const state = {
    version:1, sessionId:'session-diagnostics', deckPath:join(root, 'deck.html'),
    deckFingerprint:'deck', revision:0, tasks:[], groups:[], redo:[],
    diagnosticsBaseline:{}, diagnosticsCurrent:{}, diagnosticsRevision:null, conflict:null,
  };
  let observedBaselineDuringWrite = null;
  let createTaskCalls = 0;
  const sessionStore = {
    state, sessionPath,
    async persistState(candidate = state) {
      observedBaselineDuringWrite = Object.keys(state.diagnosticsBaseline).length;
      await writeFile(sessionPath, JSON.stringify(candidate));
      throw Object.assign(new Error('session directory fsync failed after rename'), {
        committed:true,
        commitScope:'session',
      });
    },
    async createTask() { createTaskCalls += 1; },
  };
  const bridge = new BridgeService({ sessionStore });
  const socket = { readyState:1, send() {} };
  bridge.setEditorSocket(socket);
  bridge.handleMessage(socket, JSON.stringify({
    type:'deck-ready',
    pages:[{ index:1, label:'测试页', pageKey:page.pageKey }],
    diagnostics:[page],
  }));

  await assert.rejects(
    bridge.writeDeck(0, {
      fingerprint:async () => 'deck',
      writer:async () => assert.fail('RECOVERY_REQUIRED 不得调用 writer'),
    }),
    error => error.code === 'RECOVERY_REQUIRED' && error.statusCode === 503
      && error.committed === true,
  );

  const disk = JSON.parse(await readFile(sessionPath, 'utf8'));
  assert.equal(observedBaselineDuringWrite, 0);
  assert.deepEqual(state.diagnosticsBaseline, { [page.pageKey]:page });
  assert.deepEqual(state.diagnosticsCurrent, { [page.pageKey]:page });
  assert.equal(state.diagnosticsRevision, 0);
  assert.deepEqual(disk.diagnosticsBaseline, state.diagnosticsBaseline);
  await assert.rejects(
    bridge.createTask({ instruction:'later' }, 0),
    error => error.code === 'RECOVERY_REQUIRED' && error.statusCode === 503,
  );
  assert.equal(createTaskCalls, 0);
});

test('conflict 的 session 写已 committed 后保留冲突并冻结', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-conflict-committed-session-'));
  const sessionPath = join(root, 'session.json');
  const state = {
    version:1, sessionId:'session-conflict', deckPath:join(root, 'deck.html'),
    deckFingerprint:'expected', revision:0, tasks:[], groups:[], redo:[],
    diagnosticsBaseline:{}, diagnosticsCurrent:{}, diagnosticsRevision:null, conflict:null,
  };
  const sessionStore = {
    state, sessionPath,
    async persistState(candidate = state) {
      await writeFile(sessionPath, JSON.stringify(candidate));
      throw Object.assign(new Error('session committed'), {
        committed:true, commitScope:'session',
      });
    },
  };
  const bridge = new BridgeService({ sessionStore });

  await assert.rejects(
    bridge.noteDeckFingerprint('external'),
    error => error.code === 'RECOVERY_REQUIRED' && error.committed === true,
  );

  const disk = JSON.parse(await readFile(sessionPath, 'utf8'));
  assert.equal(state.conflict.code, 'DECK_CHANGED');
  assert.equal(state.conflict.actualFingerprint, 'external');
  assert.deepEqual(disk.conflict, state.conflict);
  await assert.rejects(
    bridge.noteDeckFingerprint('another'),
    error => error.code === 'RECOVERY_REQUIRED' && error.statusCode === 503,
  );
});

test('write-deck 的 session 写已 committed 后保留新基线、保留 record 并冻结', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-write-committed-session-'));
  const sessionPath = join(root, 'session.json');
  const page = {
    pageKey:'page-001-write-committed',
    sectionOverflow:{ x:0, y:0 }, nestedClips:[],
  };
  const state = {
    version:1, sessionId:'session-write', deckPath:join(root, 'deck.html'),
    deckFingerprint:'old', revision:0, tasks:[], groups:[], redo:[],
    diagnosticsBaseline:{ [page.pageKey]:page },
    diagnosticsCurrent:{ [page.pageKey]:page }, diagnosticsRevision:0, conflict:null,
  };
  const sessionStore = {
    state, sessionPath,
    async persistState(candidate = state) {
      await writeFile(sessionPath, JSON.stringify(candidate));
      throw Object.assign(new Error('session committed'), {
        committed:true, commitScope:'session',
      });
    },
  };
  const bridge = new BridgeService({ sessionStore });
  const socket = {
    readyState:1,
    send(data) {
      const message = JSON.parse(data);
      if (message.type !== 'diagnose-pages') return;
      queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
        type:'diagnostics-result', commandId:message.commandId,
        revision:message.revision, pages:[page],
      })));
    },
  };
  bridge.setEditorSocket(socket);
  bridge.handleMessage(socket, JSON.stringify({
    type:'deck-ready', pages:[{ index:1, label:'测试页', pageKey:page.pageKey }],
    diagnostics:[page],
  }));
  let restoreCalls = 0;
  let finalizeCalls = 0;

  await assert.rejects(
    bridge.writeDeck(0, {
      fingerprint:async () => 'old',
      writer:async () => ({ fingerprint:'new', backup:'/tmp/backup.html' }),
      restore:async () => { restoreCalls += 1; },
      finalize:async () => { finalizeCalls += 1; },
    }),
    error => error.code === 'RECOVERY_REQUIRED' && error.committed === true,
  );

  const disk = JSON.parse(await readFile(sessionPath, 'utf8'));
  assert.equal(state.deckFingerprint, 'new');
  assert.equal(disk.deckFingerprint, 'new');
  assert.equal(restoreCalls, 0);
  assert.equal(finalizeCalls, 0, 'committed 异常后必须保留 transaction record 供重启收敛');
  await assert.rejects(
    bridge.writeDeck(0, {}),
    error => error.code === 'RECOVERY_REQUIRED' && error.statusCode === 503,
  );
});

test('solidify write 原子固化累计动作、增加 revision 并清空历史 groupId', async () => {
  const page = {
    pageKey:'page-001-a', sectionOverflow:{ x:0, y:0 }, nestedClips:[],
  };
  const completedAt = new Date(0).toISOString();
  const group = {
    id:'group-solidify', taskId:'task-solidify', active:true,
    actions:[{ ...action, taskId:'task-solidify', expectedRevision:7 }],
  };
  const state = {
    version:1, sessionId:'session-solidify', deckPath:'/tmp/deck.html',
    deckFingerprint:'old', revision:7,
    tasks:[{
      id:'task-solidify', status:'completed', groupId:group.id,
      createdAt:completedAt, updatedAt:completedAt,
    }],
    groups:[group], redo:['old-undone-group'], solidifiedActions:[],
    diagnosticsBaseline:{ [page.pageKey]:page },
    diagnosticsCurrent:{ [page.pageKey]:page }, diagnosticsRevision:7, conflict:null,
  };
  const sessionStore = {
    state, sessionPath:'/tmp/session-solidify.json',
    async persistState() {},
  };
  const bridge = new BridgeService({ sessionStore });
  const socket = {
    readyState:1,
    send(data) {
      const message = JSON.parse(data);
      if (message.type !== 'diagnose-pages') return;
      queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
        type:'diagnostics-result', commandId:message.commandId,
        revision:message.revision, pages:[page],
      })));
    },
  };
  bridge.setEditorSocket(socket);
  bridge.handleMessage(socket, JSON.stringify({
    type:'deck-ready', pages:[{ index:1, label:'测试页', pageKey:page.pageKey }],
    diagnostics:[page],
  }));
  let writtenActions;
  const preflight = await bridge.preflightSolidify(7, {
    fingerprint:async () => 'old',
    bindingRevision:4,
  });
  assert.equal(preflight.revision, 7);
  assert.equal(preflight.bindingRevision, 4);
  assert.match(preflight.preflightToken, /^[0-9a-f-]{36}$/);
  await assert.rejects(
    bridge.writeDeck(7, {
      solidify:true,
      preflightToken:preflight.preflightToken,
      bindingRevision:5,
      fingerprint:async () => 'old',
      writer:async () => assert.fail('过期预检不得进入 writer'),
    }),
    error => error.code === 'SOLIDIFY_PREFLIGHT_STALE',
  );
  const refreshedPreflight = await bridge.preflightSolidify(7, {
    fingerprint:async () => 'old',
    bindingRevision:4,
  });
  const result = await bridge.writeDeck(7, {
    solidify:true,
    preflightToken:refreshedPreflight.preflightToken,
    bindingRevision:4,
    fingerprint:async () => 'old',
    writer:async patches => {
      writtenActions = patches;
      return {
        fingerprint:'new', backup:'/tmp/solidify-backup.html',
        effectivePatches:structuredClone(patches), droppedActionIds:[],
      };
    },
    restore:async () => {},
  });

  assert.equal(result.solidified, true);
  assert.equal(result.revision, 8);
  assert.equal(result.clearedGroupCount, 1);
  assert.equal('effectivePatches' in result, false,
    '内部补丁正文不得回传到固化 API 响应');
  assert.equal('droppedActionIds' in result, false,
    '内部修复字段只允许通过摘要返回');
  assert.equal(result.clearedRedoCount, 0,
    '严格时间线迁移会丢弃没有对应历史条目的孤立 redo 标识');
  assert.equal(writtenActions.length, 1);
  assert.equal(writtenActions[0].payload.text, '新文案');
  assert.equal(state.revision, 8);
  assert.deepEqual(state.groups, []);
  assert.deepEqual(state.redo, []);
  assert.equal(state.solidifiedActions.length, 1);
  assert.deepEqual(state.solidifiedActions, writtenActions,
    'session 固化基线必须与实际写入 Deck 的规范动作完全一致');
  assert.equal('expectedRevision' in state.solidifiedActions[0], false,
    '请求并发字段不得进入持久化动作基线');
  assert.equal(state.tasks[0].status, 'completed');
  assert.equal(state.tasks[0].groupId, undefined);
  assert.equal(state.tasks[0].effectState, 'solidified');
  assert.deepEqual(state.tasks[0].checkpointIds, [result.checkpointId]);
  assert.equal(state.checkpoints.at(-1).checkpointId, result.checkpointId);
  assert.deepEqual(bridge.compiledActions(), []);
});

test('solidify 以验证后有效补丁为 session 基线并只返回修复摘要', async () => {
  const page = {
    pageKey:'page-001-a', sectionOverflow:{ x:0, y:0 }, nestedClips:[],
  };
  const state = {
    version:2, sessionId:'session-solidify-repaired', deckPath:'/tmp/deck.html',
    deckFingerprint:'old', workingDeckFingerprint:'working', revision:3,
    tasks:[], groups:[{
      id:'legacy-group', taskId:null, active:true, actions:[action],
    }], redo:[], solidifiedActions:[],
    diagnosticsBaseline:{ [page.pageKey]:page },
    diagnosticsCurrent:{ [page.pageKey]:page }, diagnosticsRevision:3, conflict:null,
  };
  const sessionStore = {
    state, sessionPath:'/tmp/session-solidify-repaired.json',
    async persistState() {},
  };
  const bridge = new BridgeService({ sessionStore });
  const socket = {
    readyState:1,
    send(data) {
      const message = JSON.parse(data);
      if (message.type !== 'diagnose-pages') return;
      queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
        type:'diagnostics-result', commandId:message.commandId,
        revision:message.revision, pages:[page],
      })));
    },
  };
  bridge.setEditorSocket(socket);
  bridge.handleMessage(socket, JSON.stringify({
    type:'deck-ready', pages:[{ index:1, label:'测试页', pageKey:page.pageKey }],
    diagnostics:[page],
  }));
  const preflight = await bridge.preflightSolidify(3, {
    fingerprint:async () => 'old', bindingRevision:1,
  });
  const result = await bridge.writeDeck(3, {
    solidify:true, preflightToken:preflight.preflightToken, bindingRevision:1,
    fingerprint:async () => 'old',
    writer:async () => ({
      fingerprint:'new', backup:'/tmp/repaired-backup.html',
      effectivePatches:[], droppedActionIds:[action.id],
    }),
    restore:async () => {},
  });

  assert.deepEqual(state.solidifiedActions, []);
  assert.deepEqual(state.historyRepair.droppedActionIds, [action.id]);
  assert.deepEqual(result.droppedLegacyActionIds, [action.id]);
  assert.equal('effectivePatches' in result, false);
  assert.equal('droppedActionIds' in result, false);
});

test('actions-prepared 只接受与动作数一致的安全非负整数', async t => {
  const app = await makeApp(t);
  const ws = await connect(app.editorWsUrl);
  t.after(() => ws.close());
  const invalidAppliedValues = [undefined, -1, 0, 2, 1.5];

  for (const applied of invalidAppliedValues) {
    const commandPromise = nextMessage(ws);
    const responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [action] }),
    });
    const command = await commandPromise;
    const acknowledgement = {};
    if (applied !== undefined) acknowledgement.applied = applied;
    await sendInvalidPrepared(ws, command, acknowledgement);

    const response = await responsePromise;
    assert.equal(response.status, 502, `applied=${applied}`);
    assert.equal((await response.json()).error, 'INVALID_ACTION_ACK');
    assert.equal(app.session.revision, 0);
    assert.deepEqual(app.session.groups, []);
  }

  const commandPromise = nextMessage(ws);
  const responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [action] }),
  });
  const command = await commandPromise;
  await prepareAndCommit(ws, command);
  assert.equal((await responsePromise).status, 200);
  assert.equal(app.session.revision, 1);
});

test('缺 canonical、错配 canonical 与浏览器拒绝均不得写 Journal', async t => {
  const app = await makeApp(t);
  const ws = await connect(app.editorWsUrl);
  t.after(() => ws.close());
  const incomplete = { ...action };
  delete incomplete.before;
  delete incomplete.after;

  let commandPromise = nextMessage(ws);
  let responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [incomplete] }),
  });
  let command = await commandPromise;
  await sendInvalidPrepared(ws, command, { applied: 1, results: undefined });
  let response = await responsePromise;
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'INVALID_ACTION_ACK');

  commandPromise = nextMessage(ws);
  responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [incomplete] }),
  });
  command = await commandPromise;
  await sendInvalidPrepared(ws, command, {
    applied: 1,
    results: [{ ...action, id: 'wrong-id' }],
  });
  response = await responsePromise;
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'INVALID_ACTION_ACK');

  commandPromise = nextMessage(ws);
  responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [incomplete] }),
  });
  command = await commandPromise;
  ws.send(JSON.stringify({
    type: 'actions-rejected', commandId: command.commandId,
    code: 'TARGET_AMBIGUOUS', failedActionId: incomplete.id,
    candidates: Array.from({ length: 8 }, (_, index) => ({ path: String(index) })),
  }));
  response = await responsePromise;
  assert.equal(response.status, 409);
  const rejected = await response.json();
  assert.equal(rejected.error, 'TARGET_AMBIGUOUS');
  assert.equal(rejected.failedActionId, incomplete.id);
  assert.equal(rejected.candidates.length, 5);
  assert.equal(app.session.revision, 0);
  assert.deepEqual(app.session.groups, []);
});

test('TARGET_AMBIGUOUS 持久化关联任务为待确认并广播新 revision', async t => {
  const app = await makeApp(t);
  const form = new FormData();
  form.append('task', new Blob([JSON.stringify({
    ...taskInput, attachmentSources:['selected'],
  })], { type:'application/json' }), 'task.json');
  form.append('attachment', new Blob([Buffer.from('ambiguity reference')]), 'reference.txt');
  const createdResponse = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', body:form,
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const taskId = created.task.id;
  await new Promise(resolve => setTimeout(resolve, 5));
  const editor = await connect(app.editorWsUrl);
  t.after(() => editor.close());
  const requested = { ...action, taskId };

  const commandPromise = nextMessage(editor);
  const responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:1, taskId, actions:[requested] }),
  });
  const command = await commandPromise;
  const eventPromise = nextMessage(editor);
  editor.send(JSON.stringify({
    type:'actions-rejected', commandId:command.commandId,
    code:'TARGET_AMBIGUOUS', failedActionId:requested.id,
    candidates:Array.from({ length:8 }, (_, index) => ({ path:String(index) })),
  }));

  const response = await responsePromise;
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.error, 'TARGET_AMBIGUOUS');
  assert.equal(body.revision, 2);
  assert.equal(body.candidates.length, 5);
  const event = await eventPromise;
  assert.equal(event.type, 'task-updated');
  assert.equal(event.revision, 2);
  assert.equal(event.payload.id, taskId);
  assert.equal(event.payload.status, 'needs-confirmation');
  assert.equal(event.payload.attachments[0].path, created.task.attachments[0].path);

  const persisted = JSON.parse(await readFile(join(app.sessionDir, 'session.json'), 'utf8'));
  const task = persisted.tasks.find(candidate => candidate.id === taskId);
  assert.equal(persisted.revision, 2);
  assert.equal(task.status, 'needs-confirmation');
  assert.equal(task.candidates.length, 5);
  assert.equal(Object.hasOwn(task.attachments[0], 'path'), false);
  assert.ok(task.updatedAt > created.task.updatedAt);
  assert.deepEqual(persisted.groups, []);

  const retryCommandPromise = nextMessage(editor);
  const retryResponsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:2, taskId, actions:[requested] }),
  });
  const retryCommand = await retryCommandPromise;
  await prepareAndCommit(editor, retryCommand);
  const retryResponse = await retryResponsePromise;
  const retryBody = await retryResponse.json();
  assert.equal(retryResponse.status, 200);
  assert.equal(retryBody.revision, 3);
  assert.equal(retryBody.task.attachments[0].path, created.task.attachments[0].path);
  const completed = app.session.tasks.find(candidate => candidate.id === taskId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.groupId, retryBody.groupId);
  assert.deepEqual(completed.candidates, []);
  assert.equal(app.session.groups.length, 1);
  assert.equal(app.session.groups[0].taskId, taskId);
});

test('成功 action 原子完成任务且 undo/redo 同步任务生命周期', async t => {
  const app = await makeApp(t);
  const created = await createTask(app);
  const taskId = created.task.id;
  await new Promise(resolve => setTimeout(resolve, 5));
  const editor = await connect(app.editorWsUrl);
  t.after(() => editor.close());
  const requested = { ...action, taskId };

  let commandPromise = nextMessage(editor, message => message.type === 'apply-actions');
  let responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:1, taskId, actions:[requested] }),
  });
  let command = await commandPromise;
  await prepareAndCommit(editor, command);
  let response = await responsePromise;
  let body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.revision, 2);
  const groupId = body.groupId;
  assert.equal(body.task.id, taskId);
  assert.equal(body.task.status, 'completed');
  assert.equal(body.task.groupId, groupId);

  let persisted = JSON.parse(await readFile(join(app.sessionDir, 'session.json'), 'utf8'));
  let task = persisted.tasks.find(candidate => candidate.id === taskId);
  assert.equal(persisted.revision, 2);
  assert.equal(persisted.groups[0].id, groupId);
  assert.equal(persisted.groups[0].taskId, taskId);
  assert.equal(task.status, 'completed');
  assert.equal(task.groupId, groupId);
  assert.ok(task.updatedAt > created.task.updatedAt);

  commandPromise = nextMessage(editor, message => message.type === 'apply-actions');
  responsePromise = fetch(`${app.url}/api/groups/${groupId}/undo?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:2 }),
  });
  command = await commandPromise;
  await prepareAndCommit(editor, command);
  // 暂停接收，稳定复现 HTTP 已完成但上一轮通知尚未被测试消费的顺序。
  editor.pause();
  response = await responsePromise;
  body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.revision, 3);
  task = app.session.tasks.find(candidate => candidate.id === taskId);
  assert.equal(task.status, 'completed');
  assert.equal(task.groupId, groupId);
  assert.equal(task.effectState, 'undone');
  assert.equal(app.session.groups[0].active, false);

  commandPromise = nextMessage(editor, message => message.type === 'apply-actions');
  responsePromise = fetch(`${app.url}/api/groups/${groupId}/redo?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:3 }),
  });
  editor.resume();
  command = await commandPromise;
  await prepareAndCommit(editor, command);
  response = await responsePromise;
  body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.revision, 4);
  task = app.session.tasks.find(candidate => candidate.id === taskId);
  assert.equal(task.status, 'completed');
  assert.equal(task.groupId, groupId);
  assert.equal(app.session.groups[0].active, true);

  await new Promise(resolve => {
    editor.once('close', resolve);
    editor.close();
  });
  const replacementEditor = await connect(app.editorWsUrl);
  t.after(() => replacementEditor.close());
  let extraCommands = 0;
  replacementEditor.on('message', () => { extraCommands += 1; });
  response = await fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:4, taskId, actions:[requested] }),
  });
  body = await response.json();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(response.status, 409);
  assert.equal(body.error, 'TASK_ALREADY_COMPLETED');
  assert.equal(extraCommands, 0);
  assert.equal(app.session.revision, 4);
  assert.equal(app.session.groups.length, 1);
});

test('重复 commandId 返回同一耐久结果且不会二次发送浏览器动作', async t => {
  const app = await makeApp(t);
  const editor = await connectCanonicalActionEditor(t, app);
  let applyCount = 0;
  editor.on('message', data => {
    if (JSON.parse(data).type === 'apply-actions') applyCount += 1;
  });
  const commandId = '11111111-1111-4111-8111-111111111111';
  const body = { expectedRevision:0, commandId, taskId:null, actions:[action] };

  let response = await fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body),
  });
  const first = await response.json();
  assert.equal(response.status, 200, JSON.stringify(first));
  assert.equal(first.revision, 1);

  response = await fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body),
  });
  const duplicate = await response.json();
  assert.equal(response.status, 200, JSON.stringify(duplicate));
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.groupId, first.groupId);
  assert.equal(app.session.groups.length, 1);
  assert.equal(applyCount, 1);

  const laterTask = await createTask(app, { expectedRevision:1 });
  assert.equal(laterTask.revision, 2);
  response = await fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body),
  });
  const delayedDuplicate = await response.json();
  assert.equal(response.status, 200, JSON.stringify(delayedDuplicate));
  assert.equal(delayedDuplicate.idempotent, true);
  assert.equal(delayedDuplicate.commandRevision, 1);
  assert.equal(delayedDuplicate.revision, 2,
    '延迟重试必须返回当前 revision，不能让客户端版本倒退');
  assert.equal(applyCount, 1);

  response = await fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      ...body, expectedRevision:2,
      actions:[{ ...action, payload:{ text:'另一份内容' }, after:'另一份内容' }],
    }),
  });
  const reused = await response.json();
  assert.equal(response.status, 409);
  assert.equal(reused.error, 'COMMAND_ID_REUSED');
});

test('非末尾 Agent 任务撤销追加补偿条目，后续人工修改不回退', async t => {
  const app = await makeApp(t);
  const created = await createTask(app);
  const taskId = created.task.id;
  const editor = await connectCanonicalActionEditor(t, app);
  const agentAction = {
    ...action, id:'agent-text', taskId,
    payload:{ text:'Agent 标题' }, before:'旧文案', after:'Agent 标题',
  };
  let response = await fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:1, taskId, actions:[agentAction],
    }),
  });
  const agentResult = await response.json();
  assert.equal(response.status, 200, JSON.stringify(agentResult));

  const styleAction = {
    ...action, id:'manual-size', taskId:null, kind:'setStyle',
    payload:{ property:'font-size', value:'48px' }, before:'32px', after:'48px',
  };
  response = await fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:2, taskId:null, actions:[styleAction],
    }),
  });
  assert.equal(response.status, 200, await response.text());

  response = await fetch(
    `${app.url}/api/groups/${agentResult.groupId}/undo?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:3,
    }) },
  );
  const compensated = await response.json();
  assert.equal(response.status, 200, JSON.stringify(compensated));
  assert.equal(compensated.compensatedGroupId, agentResult.groupId);
  assert.notEqual(compensated.groupId, agentResult.groupId);
  assert.equal(compensated.task.status, 'completed');
  assert.equal(compensated.task.groupId, agentResult.groupId);
  assert.equal(compensated.task.effectState, 'undone');
  assert.deepEqual(compensated.task.entryIds, [
    agentResult.groupId, compensated.groupId,
  ]);
  assert.equal(app.session.groups.length, 3);
  assert.equal(app.session.groups.every(group => group.active === true), true);
  const compiled = app.session.groups
    .flatMap(group => group.actions ?? [])
    .filter(candidate => candidate.id === 'manual-size'
      || candidate.id === app.session.groups.at(-1).actions[0].id);
  assert.equal(compiled.some(candidate => candidate.after === '48px'), true);

  response = await fetch(
    `${app.url}/api/groups/${compensated.groupId}/undo?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:4,
    }) },
  );
  const restored = await response.json();
  assert.equal(response.status, 200, JSON.stringify(restored));
  assert.equal(restored.task.status, 'completed');
  assert.equal(restored.task.groupId, agentResult.groupId);
  assert.equal(restored.task.effectState, 'active');
  assert.equal(app.session.tasks.find(task => task.id === taskId)?.status, 'completed');
});

test('不存在的 taskId 在发送浏览器 tentative action 前拒绝', async t => {
  const app = await makeApp(t);
  const editor = await connect(app.editorWsUrl);
  t.after(() => editor.close());
  let commands = 0;
  editor.on('message', () => { commands += 1; });

  const response = await fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      expectedRevision:0,
      taskId:'missing-task',
      actions:[{ ...action, taskId:'missing-task' }],
    }),
  });
  const body = await response.json();
  await new Promise(resolve => setTimeout(resolve, 25));

  assert.equal(response.status, 404);
  assert.equal(body.error, 'TASK_NOT_FOUND');
  assert.equal(commands, 0);
  assert.equal(app.session.revision, 0);
  assert.deepEqual(app.session.groups, []);
});

test('顶层 taskId 与 action.taskId 不一致时在 tentative 前原子拒绝', async t => {
  const app = await makeApp(t);
  const first = await createTask(app);
  const second = await createTask(app, {
    expectedRevision:1, pageKey:'page-002-b', pageIndex:2, pageLabel:'B',
  });
  const before = structuredClone(app.session);
  const editor = await connect(app.editorWsUrl);
  t.after(() => editor.close());
  let tentativeCommands = 0;
  editor.on('message', data => {
    const message = JSON.parse(data);
    if (message.type === 'apply-actions') {
      tentativeCommands += 1;
      editor.send(JSON.stringify({
        type:'actions-prepared', commandId:message.commandId,
        applied:message.actions.length, results:message.actions,
      }));
    } else if (message.type === 'commit-actions') {
      editor.send(JSON.stringify({
        type:'actions-committed', commandId:message.commandId, committed:true,
      }));
    } else if (message.type === 'rollback-actions') {
      editor.send(JSON.stringify({
        type:'actions-rolled-back', commandId:message.commandId, rolledBack:true,
      }));
    } else if (message.type === 'sync-actions') {
      editor.send(JSON.stringify({
        type:'actions-synced', commandId:message.commandId,
      }));
    }
  });

  const response = await fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      expectedRevision:2,
      taskId:first.task.id,
      actions:[{ ...action, taskId:second.task.id }],
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, 'INVALID_INPUT');
  assert.match(body.message, /taskId/);
  assert.equal(tentativeCommands, 0);
  assert.deepEqual(app.session, before);
});

test('canonical ACK 篡改 action.taskId 时回滚且不写 Journal', async t => {
  const app = await makeApp(t);
  const editor = await connect(app.editorWsUrl);
  t.after(() => editor.close());
  const requested = { ...action, taskId:null };
  const commandPromise = nextMessage(editor);
  const responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0, taskId:null, actions:[requested] }),
  });
  const command = await commandPromise;
  editor.send(JSON.stringify({
    type:'actions-prepared', commandId:command.commandId, applied:1,
    results:[{ ...command.actions[0], taskId:'forged-task' }],
  }));
  const followup = await nextMessage(editor);
  if (followup.type === 'rollback-actions') {
    editor.send(JSON.stringify({
      type:'actions-rolled-back', commandId:command.commandId, rolledBack:true,
    }));
  } else if (followup.type === 'commit-actions') {
    editor.send(JSON.stringify({
      type:'actions-committed', commandId:command.commandId, committed:true,
    }));
  }
  const response = await responsePromise;
  const body = await response.json();

  assert.equal(followup.type, 'rollback-actions');
  assert.equal(response.status, 502);
  assert.equal(body.error, 'INVALID_ACTION_ACK');
  assert.equal(app.session.revision, 0);
  assert.deepEqual(app.session.groups, []);
});

test('重复 action id 与伪造 payload/after 的 canonical ACK 均拒绝', async t => {
  const app = await makeApp(t);
  const ws = await connect(app.editorWsUrl);
  t.after(() => ws.close());
  const duplicate = await fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [action, action] }),
  });
  assert.equal(duplicate.status, 400);
  assert.equal((await duplicate.json()).error, 'DUPLICATE_ACTION_ID');

  const incomplete = { ...action };
  delete incomplete.before;
  delete incomplete.after;
  let commandPromise = nextMessage(ws);
  let responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [incomplete] }),
  });
  let command = await commandPromise;
  await sendInvalidPrepared(ws, command, {
    applied: 1,
    results: [{ ...action, payload: { text: '另一份 payload' } }],
  });
  let response = await responsePromise;
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'INVALID_ACTION_ACK');

  const resize = {
    id: 'resize-forged-branch', taskId: null, target: action.target,
    kind: 'resize', payload: { scale: 2 },
  };
  commandPromise = nextMessage(ws);
  responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [resize] }),
  });
  command = await commandPromise;
  await sendInvalidPrepared(ws, command, {
    applied: 1,
    results: [{ ...resize, before: { width: 100, height: 50 }, after: { scale: 2 } }],
  });
  response = await responsePromise;
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'INVALID_ACTION_ACK');

  const forgedLegacy = { ...action, after: 'FORGED' };
  commandPromise = nextMessage(ws);
  responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [forgedLegacy] }),
  });
  command = await commandPromise;
  await sendInvalidPrepared(ws, command, { applied: 1, results: [forgedLegacy] });
  response = await responsePromise;
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'INVALID_ACTION_ACK');
  assert.equal(app.session.revision, 0);
  assert.deepEqual(app.session.groups, []);
});

test('等待 Action 回执期间串行化其他 revision mutation', async t => {
  const app = await makeApp(t);
  const ws = await connect(app.editorWsUrl);
  t.after(() => ws.close());
  const commandPromise = nextMessage(ws);
  const actionResponsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [action] }),
  });
  const command = await commandPromise;

  const taskResponsePromise = fetch(`${app.url}/api/tasks?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(taskInput),
  });
  await new Promise(resolve => setTimeout(resolve, 25));
  await prepareAndCommit(ws, command);

  const actionResponse = await actionResponsePromise;
  const taskResponse = await taskResponsePromise;
  assert.equal(actionResponse.status, 200);
  assert.equal((await actionResponse.json()).revision, 1);
  assert.equal(taskResponse.status, 409);
  assert.equal((await taskResponse.json()).error, 'REVISION_CONFLICT');
});

test('createTask 持久化失败时回滚共享状态并清理临时文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-task-rollback-'));
  const sessionPath = join(root, 'session.json');
  const temporaryPath = `${sessionPath}.tmp`;
  const state = { revision: 0, tasks: [], groups: [], redo: [] };
  const sessionStore = {
    state,
    sessionPath,
    async createTask(input) {
      state.tasks.push(input);
      state.revision += 1;
      await writeFile(temporaryPath, 'partial');
      throw new Error('persist failed');
    },
  };
  const bridge = new BridgeService({ sessionStore });

  await assert.rejects(() => bridge.createTask({ instruction: '修改' }, 0), /persist failed/);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.tasks, []);
  await assert.rejects(() => readFile(temporaryPath), { code: 'ENOENT' });
});

test('Bridge createTask 在 mutation queue 内原样透传附件 lifecycle options', async () => {
  const state = { revision:0, tasks:[], groups:[], redo:[] };
  const calls = [];
  const attachmentsLifecycle = {
    async publish() { return []; },
    async discard() {},
  };
  const sessionStore = {
    state,
    sessionPath:'/tmp/session.json',
    async createTask(input, expectedRevision, options) {
      calls.push({ input, expectedRevision, options });
      state.revision = 1;
      return { task:{ ...input, id:'task-1', attachments:[] }, revision:1 };
    },
  };
  const bridge = new BridgeService({ sessionStore });
  const input = { instruction:'附件透传' };

  const result = await bridge.createTask(input, 0, { attachmentsLifecycle });

  assert.equal(result.revision, 1);
  assert.deepEqual(calls, [{ input, expectedRevision:0, options:{ attachmentsLifecycle } }]);
});

test('附件补偿需恢复时 Bridge 保留首个顶层错误并冻结后续 mutation', async () => {
  const state = { revision:0, tasks:[], groups:[], redo:[] };
  let createCalls = 0;
  const recoveryError = Object.assign(new Error('附件补偿失败'), {
    code:'ATTACHMENT_RECOVERY_REQUIRED', statusCode:503,
    stage:'attachment-compensation', committed:false,
    commitScope:'attachment', sessionCandidateCommitted:false,
  });
  const sessionStore = {
    state,
    sessionPath:'/tmp/session.json',
    async createTask() {
      createCalls += 1;
      throw recoveryError;
    },
  };
  const bridge = new BridgeService({ sessionStore });

  await assert.rejects(
    () => bridge.createTask({ instruction:'first' }, 0),
    error => error === recoveryError,
  );
  await assert.rejects(
    () => bridge.createTask({ instruction:'second' }, 0),
    error => error.code === 'RECOVERY_REQUIRED'
      && error.statusCode === 503
      && error.operation === 'task-attachment-compensation',
  );
  assert.equal(createCalls, 1);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.tasks, []);
});

test('task session 已耐久提交后 Bridge 确认失败标记 committed/syncPending 且不回滚', async () => {
  const task = { id:'task-durable', instruction:'durable', attachments:[{ id:'attachment-1' }] };
  const state = { revision:0, tasks:[], groups:[], redo:[] };
  let bridge;
  const sessionStore = {
    state,
    sessionPath:'/tmp/session.json',
    async createTask() {
      state.revision = 1;
      state.tasks = [task];
      bridge.close();
      return { task, revision:1 };
    },
  };
  bridge = new BridgeService({ sessionStore });

  await assert.rejects(
    () => bridge.createTask({ instruction:'durable' }, 0),
    error => error.code === 'SERVICE_CLOSED'
      && error.statusCode === 503
      && error.committed === true
      && error.commitScope === 'session'
      && error.syncPending === true
      && error.sessionCandidateCommitted === true
      && error.revision === 1,
  );
  assert.equal(state.revision, 1);
  assert.deepEqual(state.tasks, [task]);
});

test('task session committed 错误与 close 竞态不得降级为可重试的未提交错误', async () => {
  const task = { id:'task-committed-close', instruction:'durable', attachments:[] };
  const state = { revision:0, tasks:[], groups:[], redo:[] };
  const committedError = Object.assign(new Error('session directory fsync ack lost'), {
    code:'SESSION_WRITE_FAILED', committed:true, commitScope:'session',
    stage:'session-directory-fsync',
  });
  let bridge;
  const sessionStore = {
    state,
    sessionPath:'/tmp/session.json',
    async createTask() {
      state.revision = 1;
      state.tasks = [task];
      bridge.close();
      throw committedError;
    },
  };
  bridge = new BridgeService({ sessionStore });

  await assert.rejects(
    () => bridge.createTask({ instruction:'durable' }, 0),
    error => error.code === 'SERVICE_CLOSED'
      && error.statusCode === 503
      && error.committed === true
      && error.commitScope === 'session'
      && error.syncPending === true
      && error.sessionCandidateCommitted === true
      && error.revision === 1
      && error.cause === committedError,
  );
  assert.equal(state.revision, 1);
  assert.deepEqual(state.tasks, [task]);
});

test('任务查询、输入错误和已列路由都有明确响应', async t => {
  const app = await makeApp(t);
  const invalidJson = await fetch(`${app.url}/api/tasks?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(invalidJson.status, 400);

  const created = await fetch(`${app.url}/api/tasks?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(taskInput),
  }).then(value => value.json());
  const task = await fetch(`${app.url}/api/tasks/${created.task.id}?token=secret`).then(value => value.json());
  assert.equal(task.id, created.task.id);
  const tasks = await fetch(`${app.url}/api/tasks?token=secret`).then(value => value.json());
  assert.equal(tasks.length, 1);

  assert.equal((await fetch(`${app.url}/api/tasks/missing?token=secret`)).status, 404);
  assert.equal((await fetch(`${app.url}/api/missing?token=secret`)).status, 404);
  assert.equal((await fetch(`${app.url}/editor/index.html?token=secret`)).status, 404);
  assert.equal((await fetch(`${app.url}/events?token=secret`)).status, 426);
  assert.equal((await fetch(`${app.url}/preview?token=secret`)).status, 200);
});

test('JSON 请求体跨 chunk 拆分中文 UTF-8 时完整创建任务', async t => {
  const app = await makeApp(t);
  const instruction = '跨块中文修改';
  const body = Buffer.from(JSON.stringify({ ...taskInput, instruction }));
  const instructionStart = body.indexOf(Buffer.from(instruction));
  assert.notEqual(instructionStart, -1);
  const splitAt = instructionStart + 1;

  const response = await postJsonChunks(
    `${app.url}/api/tasks?token=secret`,
    [body.subarray(0, splitAt), body.subarray(splitAt)],
  );

  assert.equal(response.status, 201);
  assert.equal(response.body.task.instruction, instruction);
});

test('write-deck 调用安全适配器并解析验证诊断后的 JSON 结果', async t => {
  const app = await makeApp(t, { deckContents: validBundle() });
  await connectDiagnosticsEditor(t, app);
  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0 }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.revision, 0);
  assert.match(result.backup, /backups\/deck-[a-f0-9]{64}\.html$/);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
});

test('writer 成功但 session persist 前中断后进入 RECOVERY_REQUIRED，拒绝第二候选并由重启收敛', async t => {
  let app;
  let transactionId;
  let transactionPath;
  let writerStarts = 0;
  const candidateBytes = Buffer.from('candidate before session persist interruption');
  const child = fakeWriterChild({
    onEnd:current => queueMicrotask(async () => {
      const oldBytes = await readFile(app.deckPath);
      await writeFile(app.deckPath, candidateBytes);
      transactionPath = await writeTransactionRecord(
        app, transactionId, oldBytes, candidateBytes,
      );
      current.stdout.emit('data', `${JSON.stringify({
        ok:true,
        fingerprint:sha256(candidateBytes),
        backup:join(app.sessionDir, 'backups', `deck-${sha256(oldBytes)}.html`),
        transaction:transactionPath,
      })}\n`);
      current.emit('close', 0);
    }),
  });
  app = await makeApp(t, {
    deckContents:validBundle(),
    spawnWriter:(_command, args) => {
      writerStarts += 1;
      transactionId = args.at(-1);
      return child;
    },
    beforeSessionPersist:async () => {
      assert.ok((await readFile(transactionPath)).length > 0);
      throw Object.assign(new Error('模拟 session persist 前进程中断'), {
        code:'INJECTED_INTERRUPTION', statusCode:500,
      });
    },
  });
  await connectDiagnosticsEditor(t, app);
  const sessionBefore = await readFile(join(app.sessionDir, 'session.json'));

  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0 }),
  });

  assert.equal(response.status, 503);
  assert.equal((await response.clone().json()).code, 'RECOVERY_REQUIRED');
  assert.deepEqual(await readFile(app.deckPath), candidateBytes);
  assert.deepEqual(await readFile(join(app.sessionDir, 'session.json')), sessionBefore);
  assert.ok((await readFile(transactionPath)).length > 0);

  const taskResponse = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify(taskInput),
  });
  assert.equal(taskResponse.status, 503);
  assert.equal((await taskResponse.json()).code, 'RECOVERY_REQUIRED');
  for (const [path, body] of [
    ['/api/actions', {
      expectedRevision:0, taskId:null, actions:[{ ...action, taskId:null }],
    }],
    ['/api/groups/missing/undo', { expectedRevision:0 }],
    ['/api/groups/missing/redo', { expectedRevision:0 }],
  ]) {
    const mutation = await fetch(`${app.url}${path}?token=secret`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify(body),
    });
    assert.equal(mutation.status, 503, path);
    assert.equal((await mutation.json()).code, 'RECOVERY_REQUIRED', path);
  }
  const secondSave = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0 }),
  });
  assert.equal(secondSave.status, 503);
  assert.equal((await secondSave.json()).code, 'RECOVERY_REQUIRED');
  assert.equal(writerStarts, 1, 'fatal 状态不得启动第二个 writer candidate');

  await app.close();
  const restarted = await startServer({
    deckPath:app.deckPath, host:'127.0.0.1', port:0, openBrowser:false,
    managedWorkingDeck:false,
  });
  try {
    assert.deepEqual(await readFile(app.deckPath), Buffer.from(validBundle()));
    await assert.rejects(() => readFile(transactionPath), { code:'ENOENT' });
  } finally {
    await restarted.close();
  }
});

test('backup 父目录 fsync 失败时不得启动 writer 或发布 transaction record', async t => {
  const order = [];
  const child = fakeWriterChild({
    onEnd:current => queueMicrotask(() => {
      current.stdout.emit('data', `${JSON.stringify({
        ok:false, code:'WRITE_FAILED', stage:'write', message:'不应启动 writer',
      })}\n`);
      current.emit('close', 0);
    }),
  });
  const app = await makeApp(t, {
    deckContents:validBundle(),
    syncDirectory:async directory => {
      if (!directory.endsWith('/backups')) return;
      order.push('backup-directory-fsync');
      throw new Error('injected backup directory fsync failure');
    },
    spawnWriter:() => {
      order.push('writer');
      return child;
    },
  });
  await connectDiagnosticsEditor(t, app);
  const deckBefore = await readFile(app.deckPath);

  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0 }),
  });

  assert.equal(response.status, 500);
  assert.deepEqual(order, ['backup-directory-fsync']);
  assert.deepEqual(await readdir(join(app.sessionDir, 'transactions')), []);
  assert.deepEqual(await readFile(app.deckPath), deckBefore);
});

test('重启按 durable record 收敛 old、candidate 与 third 状态后才清理记录', async t => {
  const oldBytes = Buffer.from(validBundle());
  const candidateBytes = Buffer.from(validBundle().replace('stage', 'stage candidate'));
  const thirdBytes = Buffer.from(validBundle().replace('stage', 'stage external third'));
  const cases = [
    {
      name:'disk candidate + session old 回滚 old',
      diskBytes:candidateBytes,
      sessionFingerprint:sha256(oldBytes),
      expectedBytes:oldBytes,
      expectedSessionFingerprint:sha256(oldBytes),
      conflict:false,
    },
    {
      name:'disk candidate + session candidate 仅清陈旧记录',
      diskBytes:candidateBytes,
      sessionFingerprint:sha256(candidateBytes),
      expectedBytes:candidateBytes,
      expectedSessionFingerprint:sha256(candidateBytes),
      conflict:false,
    },
    {
      name:'disk old + session old 仅清陈旧记录',
      diskBytes:oldBytes,
      sessionFingerprint:sha256(oldBytes),
      expectedBytes:oldBytes,
      expectedSessionFingerprint:sha256(oldBytes),
      conflict:false,
    },
    {
      name:'disk third 保留第三方版本并持久化冲突',
      diskBytes:thirdBytes,
      sessionFingerprint:sha256(oldBytes),
      expectedBytes:thirdBytes,
      expectedSessionFingerprint:sha256(oldBytes),
      conflict:true,
    },
  ];

  for (const current of cases) {
    await t.test(current.name, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'deck-restart-transaction-'));
      t.after(() => rm(directory, { recursive:true, force:true }));
      const root = process.platform === 'darwin' ? join(directory, 'parent-alias', 'project') : directory;
      if (process.platform === 'darwin') {
        const actualParent = join(directory, 'parent');
        await mkdir(join(actualParent, 'project'), { recursive:true });
        // 与 /var → /private/var 相同：祖先目录存在别名，项目目录本身仍为真实目录。
        await symlink(actualParent, join(directory, 'parent-alias'), 'dir');
      }
      const fixture = await createPendingTransactionFixture({
        root,
        diskBytes:current.diskBytes,
        oldBytes,
        candidateBytes,
        sessionFingerprint:current.sessionFingerprint,
      });
      if (process.platform === 'darwin') {
        assert.notEqual(await realpath(root), root, 'macOS fixture 必须覆盖词法路径与 realpath 不同的目录别名');
        const registry = JSON.parse(await readFile(join(fixture.sidecarRoot, 'sessions.json')));
        const record = JSON.parse(await readFile(fixture.transaction));
        assert.equal(record.deckPath, fixture.deckPath, 'producer 保持项目词法路径');
        assert.equal(
          registry.sessions[fixture.sessionId].deckRealPath,
          await realpath(fixture.deckPath),
          'registry 独立保存 realpath 绑定',
        );
      }
      let app;
      try {
        app = await startServer({
          deckPath:fixture.deckPath,
          host:'127.0.0.1', port:0, openBrowser:false,
          managedWorkingDeck:false,
        });
        assert.equal(app.sessionDir, fixture.sessionDir);
        assert.deepEqual(await readFile(fixture.deckPath), current.expectedBytes);
        assert.equal(app.session.deckFingerprint, current.expectedSessionFingerprint);
        if (current.conflict) {
          assert.equal(app.session.conflict?.code, 'DECK_CHANGED');
          assert.equal(app.session.conflict?.actualFingerprint, sha256(thirdBytes));
        } else {
          assert.equal(app.session.conflict, null);
        }
        await assert.rejects(() => readFile(fixture.transaction), { code:'ENOENT' });
      } finally {
        await app?.close();
      }
    });
  }
});

test('启动拒绝 forged/stale transaction，除受控 working 目录外不改 sidecar', async t => {
  const oldBytes = Buffer.from(validBundle());
  const candidateBytes = Buffer.from(validBundle().replace('stage', 'stage candidate'));

  const runRejectedStartup = async fixture => {
    const deckBefore = await readFile(fixture.deckPath);
    const treeBefore = await sidecarTree(fixture.sidecarRoot);
    let app;
    let startupError;
    try {
      app = await startServer({
        deckPath:fixture.deckPath,
        host:'127.0.0.1', port:0, openBrowser:false,
        managedWorkingDeck:false,
      });
    } catch (error) {
      startupError = error;
    } finally {
      await app?.close();
    }
    assert.equal(app, undefined, '不可信 pending record 不得启动服务');
    assert.equal(startupError?.code, 'UNSAFE_SIDECAR');
    assert.deepEqual(await readFile(fixture.deckPath), deckBefore);
    const treeAfter = await sidecarTree(fixture.sidecarRoot);
    const withoutWorkingBootstrap = treeAfter.filter(path => (
      !path.endsWith('/working') && !path.endsWith('/working/versions')
    ));
    assert.deepEqual(withoutWorkingBootstrap, treeBefore);
    assert.equal(treeAfter.some(path => path.includes('/attachments')), false);
  };

  await t.test('错误 session 目录名即使 record 自洽也拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-forged-session-name-'));
    const fixture = await createPendingTransactionFixture({
      root, diskBytes:candidateBytes, oldBytes, candidateBytes,
      sessionFingerprint:sha256(oldBytes),
    });
    const forgedSession = join(fixture.sidecarRoot, 'deck-deadbeef');
    await rename(fixture.sessionDir, forgedSession);
    const transaction = join(forgedSession, 'transactions', '123e4567-e89b-42d3-a456-426614174000.json');
    const record = JSON.parse(await readFile(transaction, 'utf8'));
    record.sessionDir = forgedSession;
    record.backup = join(forgedSession, 'backups', `deck-${fixture.oldFingerprint}.html`);
    await writeFile(transaction, JSON.stringify(record));
    await runRejectedStartup({ ...fixture, sessionDir:forgedSession, transaction });
  });

  await t.test('session.json deckPath 与当前 Deck 不一致时拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-forged-session-state-'));
    const fixture = await createPendingTransactionFixture({
      root, diskBytes:candidateBytes, oldBytes, candidateBytes,
      sessionFingerprint:sha256(oldBytes),
    });
    const sessionPath = join(fixture.sessionDir, 'session.json');
    const state = JSON.parse(await readFile(sessionPath, 'utf8'));
    state.deckPath = join(root, 'other-deck.html');
    await writeFile(sessionPath, JSON.stringify(state));
    await runRejectedStartup(fixture);
  });

  await t.test('record-like symlink 不得被忽略后另建 session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-record-symlink-'));
    const fixture = await createPendingTransactionFixture({
      root, diskBytes:candidateBytes, oldBytes, candidateBytes,
      sessionFingerprint:sha256(oldBytes),
    });
    const outsideRecord = join(root, 'outside-record.json');
    await writeFile(outsideRecord, await readFile(fixture.transaction));
    await unlink(fixture.transaction);
    await symlink(outsideRecord, fixture.transaction);
    await runRejectedStartup(fixture);
  });

  await t.test('backup symlink 恢复验证失败前不得创建 attachments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-backup-symlink-readonly-'));
    const fixture = await createPendingTransactionFixture({
      root, diskBytes:candidateBytes, oldBytes, candidateBytes,
      sessionFingerprint:sha256(oldBytes),
    });
    const outsideBackup = join(root, 'outside-backup.html');
    await writeFile(outsideBackup, oldBytes);
    await unlink(fixture.backup);
    await symlink(outsideBackup, fixture.backup);
    const realDeckPath = await realpath(fixture.deckPath);
    const realSessionDir = await realpath(fixture.sessionDir);
    const realBackup = join(realSessionDir, 'backups', `deck-${fixture.oldFingerprint}.html`);
    const statePath = join(fixture.sessionDir, 'session.json');
    const state = JSON.parse(await readFile(statePath));
    state.deckPath = realDeckPath;
    await writeFile(statePath, JSON.stringify(state));
    const record = JSON.parse(await readFile(fixture.transaction));
    record.deckPath = realDeckPath;
    record.sessionDir = realSessionDir;
    record.backup = realBackup;
    await writeFile(fixture.transaction, JSON.stringify(record));
    await runRejectedStartup({ ...fixture, deckPath:realDeckPath });
  });

  await t.test('无效 record 验证前不得创建任何 session 子目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-invalid-record-readonly-'));
    const deckPath = join(root, 'deck.html');
    await writeFile(deckPath, candidateBytes);
    const sidecarRoot = join(root, '.aico-ppt-editor');
    const sessionDir = join(sidecarRoot, `deck-${sha256(oldBytes).slice(0, 8)}`);
    const transactions = join(sessionDir, 'transactions');
    const transaction = join(transactions, '123e4567-e89b-42d3-a456-426614174000.json');
    await mkdir(transactions, { recursive:true });
    await writeFile(transaction, '{invalid');
    await runRejectedStartup({ deckPath, sidecarRoot, sessionDir, transaction });
  });
});

test('writer 已替换 Deck 后无 ACK、坏 ACK、非零退出、EPIPE 或超时都必须恢复原子状态', async t => {
  const cases = [
    ['无 ACK', current => current.emit('close', 0)],
    ['坏 ACK', current => {
      current.stdout.emit('data', '{bad json\n');
      current.emit('close', 0);
    }],
    ['非零退出', current => {
      current.stderr.emit('data', 'writer failed');
      current.emit('close', 7);
    }],
    ['EPIPE', current => current.stdin.emit('error', epipe())],
    ['超时', () => {}],
  ];

  for (const [name, finish] of cases) {
    await t.test(name, async subtest => {
      let app;
      let transactionId;
      const child = fakeWriterChild({
        onEnd:current => queueMicrotask(async () => {
          const oldBytes = await readFile(app.deckPath);
          const candidateBytes = Buffer.from(`writer-mutated-${name}`);
          await writeFile(app.deckPath, candidateBytes);
          await writeTransactionRecord(app, transactionId, oldBytes, candidateBytes);
          finish(current);
        }),
      });
      app = await makeApp(subtest, {
        deckContents:validBundle(),
        writerTimeoutMs:100,
        spawnWriter:(_command, args) => {
          transactionId = args.at(-1);
          return child;
        },
      });
      await connectDiagnosticsEditor(subtest, app);
      const deckBefore = await readFile(app.deckPath);
      const sessionBefore = await readFile(join(app.sessionDir, 'session.json'));

      const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ expectedRevision:0 }),
      });

      assert.notEqual(response.status, 200);
      assert.deepEqual(await readFile(app.deckPath), deckBefore);
      assert.deepEqual(await readFile(join(app.sessionDir, 'session.json')), sessionBefore);
      assert.equal(app.session.deckFingerprint, sha256(deckBefore));
      assert.equal(app.session.revision, 0);
      assert.deepEqual(app.session.groups, []);
    });
  }
});

test('writer 成功回执必须完整、可信并与官方 Deck 指纹一致', async t => {
  const replies = [
    ['缺少字段', () => ({ ok:true })],
    ['非法指纹', () => ({ ok:true, fingerprint:'bad', backup:'/tmp/outside.html' })],
    ['会话外备份', (_app, deckBefore) => ({
      ok:true, fingerprint:sha256(deckBefore), backup:'/tmp/outside.html',
    })],
    ['磁盘指纹不匹配', (app, deckBefore) => ({
      ok:true,
      fingerprint:'0'.repeat(64),
      backup:join(app.sessionDir, 'backups', `deck-${sha256(deckBefore)}.html`),
    })],
  ];

  for (const [name, makeReply] of replies) {
    await t.test(name, async subtest => {
      let reply;
      const child = fakeWriterChild({
        onEnd:current => queueMicrotask(() => {
          current.stdout.emit('data', `${JSON.stringify(reply)}\n`);
          current.emit('close', 0);
        }),
      });
      const app = await makeApp(subtest, {
        deckContents:validBundle(),
        spawnWriter:() => child,
      });
      await connectDiagnosticsEditor(subtest, app);
      const deckBefore = await readFile(app.deckPath);
      reply = makeReply(app, deckBefore);
      const sessionBefore = await readFile(join(app.sessionDir, 'session.json'));

      const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ expectedRevision:0 }),
      });
      const body = await response.json();

      assert.equal(response.status, 500, `${name}: ${JSON.stringify(body)}`);
      assert.equal(body.code, 'WRITE_FAILED');
      assert.equal(body.stage, 'adapter');
      assert.match(body.recovery, /重试|恢复|检查/);
      assert.deepEqual(await readFile(app.deckPath), deckBefore);
      assert.deepEqual(await readFile(join(app.sessionDir, 'session.json')), sessionBefore);
    });
  }
});

test('adapter 在 replace 前发现真实外改时保留外部 bytes', async t => {
  let app;
  const externalBytes = Buffer.from('real external edit before replace');
  const child = fakeWriterChild({
    onEnd:current => queueMicrotask(async () => {
      await writeFile(app.deckPath, externalBytes);
      current.stdout.emit('data', `${JSON.stringify({
        ok:false,
        code:'DECK_CHANGED',
        stage:'fingerprint',
        message:'Deck 在 replace 前发生外部变化',
        recovery:'重新载入后重试',
      })}\n`);
      current.emit('close', 0);
    }),
  });
  app = await makeApp(t, {
    deckContents:validBundle(), spawnWriter:() => child,
  });
  await connectDiagnosticsEditor(t, app);
  const oldFingerprint = app.session.deckFingerprint;

  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0 }),
  });
  const body = await response.json();

  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'DECK_CHANGED');
  assert.deepEqual(await readFile(app.deckPath), externalBytes);
  assert.equal(app.session.deckFingerprint, oldFingerprint);
  assert.equal(app.session.revision, 0);
  assert.deepEqual(app.session.groups, []);
  assert.equal(app.session.conflict?.actualFingerprint, sha256(externalBytes));
});

test('candidate 已 replace 后无 ACK、坏 ACK 或超时仅凭 durable record 恢复并清理记录', async t => {
  const cases = [
    ['无 ACK', current => current.emit('close', 0)],
    ['坏 ACK', current => {
      current.stdout.emit('data', '{bad json\n');
      current.emit('close', 0);
    }],
    ['超时', () => {}],
  ];
  for (const [name, finish] of cases) {
    await t.test(name, async subtest => {
      let app;
      let transactionId;
      let transactionPath;
      const candidateBytes = Buffer.from(`candidate-${name}`);
      const child = fakeWriterChild({
        onEnd:current => queueMicrotask(async () => {
          const oldBytes = await readFile(app.deckPath);
          await writeFile(app.deckPath, candidateBytes);
          transactionPath = await writeTransactionRecord(
            app, transactionId, oldBytes, candidateBytes,
          );
          finish(current);
        }),
      });
      app = await makeApp(subtest, {
        deckContents:validBundle(), writerTimeoutMs:100,
        spawnWriter:(_command, args) => {
          transactionId = args.at(-1);
          return child;
        },
      });
      await connectDiagnosticsEditor(subtest, app);
      const deckBefore = await readFile(app.deckPath);

      const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ expectedRevision:0 }),
      });

      assert.notEqual(response.status, 200);
      assert.deepEqual(await readFile(app.deckPath), deckBefore);
      assert.ok(transactionPath, 'writer 必须先落 durable transaction record');
      await assert.rejects(() => readFile(transactionPath), { code:'ENOENT' });
    });
  }
});

test('candidate replace 后又出现第三方 hash 时绝不恢复旧 Deck', async t => {
  let app;
  let transactionId;
  const candidateBytes = Buffer.from('writer candidate bytes');
  const thirdPartyBytes = Buffer.from('third party external bytes');
  const child = fakeWriterChild({
    onEnd:current => queueMicrotask(async () => {
      const oldBytes = await readFile(app.deckPath);
      await writeFile(app.deckPath, candidateBytes);
      await writeTransactionRecord(app, transactionId, oldBytes, candidateBytes);
      await writeFile(app.deckPath, thirdPartyBytes);
      current.emit('close', 0);
    }),
  });
  app = await makeApp(t, {
    deckContents:validBundle(),
    spawnWriter:(_command, args) => {
      transactionId = args.at(-1);
      return child;
    },
  });
  await connectDiagnosticsEditor(t, app);

  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0 }),
  });
  const body = await response.json();

  assert.ok(['DECK_CHANGED', 'RESTORE_CONFLICT'].includes(body.code), JSON.stringify(body));
  assert.deepEqual(await readFile(app.deckPath), thirdPartyBytes);
});

test('Node 恢复边界拒绝当前 session backups 内的符号链接文件', async t => {
  let reply;
  const child = fakeWriterChild({
    onEnd:current => queueMicrotask(() => {
      current.stdout.emit('data', `${JSON.stringify(reply)}\n`);
      current.emit('close', 0);
    }),
  });
  const app = await makeApp(t, {
    deckContents:validBundle(), spawnWriter:() => child,
  });
  await connectDiagnosticsEditor(t, app);
  const deckBefore = await readFile(app.deckPath);
  const fingerprint = sha256(deckBefore);
  const outside = join(app.sessionDir, '..', 'outside-backup.html');
  const backup = join(app.sessionDir, 'backups', `deck-${fingerprint}.html`);
  await writeFile(outside, deckBefore);
  await symlink(outside, backup);
  reply = { ok:true, fingerprint, backup };

  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0 }),
  });
  const body = await response.json();

  assert.equal(response.status, 500, JSON.stringify(body));
  assert.equal(body.code, 'WRITE_FAILED');
  assert.equal(body.stage, 'adapter');
  assert.deepEqual(await readFile(app.deckPath), deckBefore);
  assert.deepEqual(await readFile(outside), deckBefore);
});

test('写入适配器保留可验证重放所需的规范动作元数据', async t => {
  let receivedPatches;
  const child = fakeWriterChild({
    onEnd:(current, data) => queueMicrotask(() => {
      receivedPatches = JSON.parse(data);
      current.stdout.emit('data', `${JSON.stringify({
        ok:false, code:'WRITE_FAILED', stage:'write', message:'stop after capture',
      })}\n`);
      current.emit('close', 0);
    }),
  });
  const app = await makeApp(t, {
    deckContents:validBundle(),
    spawnWriter:() => child,
  });
  const editor = await connectDiagnosticsEditor(t, app);
  const canonicalAction = {
    ...action,
    taskId:null,
    target:{ ...action.target, pageKey:'page-001-save-gate' },
    expectedRevision:0,
    instruction:'仅供 UI 展示',
    snapshot:'data:image/png;base64,ignored',
    appliedAt:'2026-08-02T00:00:00.000Z',
  };
  const commandPromise = nextMessage(editor);
  const applyPromise = fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0, taskId:null, actions:[canonicalAction] }),
  });
  const command = await commandPromise;
  await prepareAndCommit(editor, command, [canonicalAction]);
  assert.equal((await applyPromise).status, 200);

  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:1 }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(Object.keys(receivedPatches[0]).sort(), [
    'after', 'appliedAt', 'before', 'id', 'kind', 'payload', 'target', 'taskId',
  ]);
  assert.deepEqual(receivedPatches[0], {
    id:canonicalAction.id,
    taskId:null,
    target:canonicalAction.target,
    kind:canonicalAction.kind,
    payload:canonicalAction.payload,
    before:canonicalAction.before,
    after:canonicalAction.after,
    appliedAt:canonicalAction.appliedAt,
  });
});

test('文字定位通过唯一 editor capability 返回 CLI 可复用 locator', async t => {
  const app = await makeApp(t);
  const editor = await connectDiagnosticsEditor(t, app);
  const commandPromise = nextMessage(editor);
  const responsePromise = fetch(
    `${app.url}/api/text-locations?token=secret&text=${encodeURIComponent('旧标题')}`,
  );
  const command = await commandPromise;
  assert.equal(command.type, 'locate-text');
  assert.equal(command.text, '旧标题');
  const result = {
    pageKey:'page-001-save-gate', pageIndex:1, pageLabel:'测试页',
    target:{
      pageKey:'page-001-save-gate', path:'0/1', tag:'H1',
      fingerprint:'1234abcd', textPath:'0', rect:{ x:1, y:2, w:3, h:4 },
    },
    text:'旧标题文字', occurrences:1,
  };
  editor.send(JSON.stringify({
    type:'text-locations', commandId:command.commandId, results:[result],
  }));
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).results, [result]);
});

test('托管工作副本的外部结构修改进入统一历史且真实 Deck 保持不变', async t => {
  const source = managedBundle();
  const replayError = Object.assign(new Error('注入结构历史补丁重放失败'), {
    code:'PATCH_REPLAY_FAILED', statusCode:409, stage:'patch-replay',
  });
  let rejectReplay = false;
  let verifierCalls = 0;
  const app = await makeApp(t, {
    deckContents:source,
    managedWorkingDeck:true,
    workingPatchVerifier:async () => {
      verifierCalls += 1;
      if (rejectReplay) throw replayError;
      return { ok:true };
    },
  });
  const workingBefore = await readFile(app.workingDeckPath, 'utf8');
  assert.match(workingBefore, /data-page-id=\\"page-[0-9a-f]{32}\\"/);
  await writeFile(app.workingDeckPath, workingBefore.replace('旧文案', '结构修改文案'));

  const deadline = Date.now() + 3_000;
  let session;
  do {
    await new Promise(resolve => setTimeout(resolve, 40));
    session = await (await fetch(`${app.url}/api/session?token=secret`)).json();
  } while (session.groups.length === 0 && Date.now() < deadline);

  assert.equal(session.groups.length, 1);
  assert.equal(session.groups[0].mutationType, 'source');
  assert.equal(session.groups[0].actions.length, 0);
  assert.deepEqual(await readFile(app.deckPath, 'utf8'), source);

  let response = await fetch(
    `${app.url}/api/groups/${session.groups[0].id}/undo?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:session.revision,
    }) },
  );
  let result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.match(await readFile(app.workingDeckPath, 'utf8'), /旧文案/);
  const undoRevision = result.revision;
  rejectReplay = true;

  response = await fetch(
    `${app.url}/api/groups/${session.groups[0].id}/redo?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:result.revision,
    }) },
  );
  result = await response.json();
  assert.equal(response.status, 409, JSON.stringify(result));
  assert.equal(result.code, 'PATCH_REPLAY_FAILED');
  assert.equal(verifierCalls, 4);
  assert.equal(app.session.revision, undoRevision);
  assert.match(await readFile(app.workingDeckPath, 'utf8'), /旧文案/);
  assert.deepEqual(await readFile(app.deckPath, 'utf8'), source);
});

test('工作副本已经写盘时人工 action 必须先登记 SourceMutation 并拒绝过期 revision', async t => {
  const app = await makeApp(t, {
    deckContents:managedBundle(),
    managedWorkingDeck:true,
  });
  await connectCanonicalActionEditor(t, app);
  const workingBefore = await readFile(app.workingDeckPath, 'utf8');
  assert.match(workingBefore, /data-editor-id=\\"element-[0-9a-f]{32}\\"/);
  await writeFile(app.workingDeckPath, workingBefore.replace('旧文案', 'Agent 先写盘'));

  const response = await fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:0,
      taskId:null,
      actions:[{
        id:'action-after-source-write', taskId:null,
        target:{
          pageKey:'page-001-save-gate', path:'0', tag:'H1', fingerprint:'1234abcd',
          rect:{ x:0, y:0, w:200, h:80 },
        },
        kind:'setText', payload:{ text:'人工后提交' },
        before:'旧文案', after:'人工后提交',
        appliedAt:'2026-08-16T00:00:00.000Z', expectedRevision:0,
      }],
    }),
  });
  const result = await response.json();

  assert.equal(response.status, 409, JSON.stringify(result));
  assert.equal(result.code, 'REVISION_CONFLICT');
  assert.deepEqual(app.session.groups.map(group => group.mutationType), ['source']);
  assert.equal(app.session.revision, 1);
});

test('源码事务预留 revision，写盘期间拒绝人工动作并在显式提交时登记历史', async t => {
  const app = await makeApp(t, {
    deckContents:managedBundle(),
    managedWorkingDeck:true,
  });
  let response = await fetch(`${app.url}/api/source-edits?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:0, taskId:null,
    }),
  });
  let result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  assert.match(result.sourceEditId, /^[0-9a-f-]{36}$/);
  assert.equal(result.revision, 1);
  assert.equal(result.beforeFingerprint, app.session.workingDeckFingerprint);
  const { sourceEditId } = result;

  response = await fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:1,
      taskId:null,
      actions:[{
        id:'manual-during-source-edit', taskId:null,
        target:{ pageKey:'page-001-save-gate', path:'0', tag:'H1', fingerprint:'1234abcd' },
        kind:'setText', payload:{ text:'不得抢在源码事务中间' },
      }],
    }),
  });
  result = await response.json();
  assert.equal(response.status, 409, JSON.stringify(result));
  assert.equal(result.code, 'SOURCE_EDIT_ACTIVE');

  const workingBefore = await readFile(app.workingDeckPath, 'utf8');
  await writeFile(app.workingDeckPath, workingBefore.replace('旧文案', '源码事务修改'));
  response = await fetch(
    `${app.url}/api/source-edits/${sourceEditId}/commit?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:1,
    }) },
  );
  const committed = await response.json();
  assert.equal(response.status, 200, JSON.stringify(committed));
  assert.equal(committed.revision, 2);
  assert.equal(app.session.sourceEdit, undefined);
  assert.deepEqual(app.session.groups.map(group => group.mutationType), ['source']);
  assert.match(await readFile(app.workingDeckPath, 'utf8'), /源码事务修改/);
});

test('源码事务候选无法回放旧补丁时恢复事务前工作副本且不登记历史', async t => {
  const verifierError = Object.assign(new Error('注入补丁重放失败'), {
    code:'PATCH_REPLAY_FAILED', statusCode:409, stage:'patch-replay',
  });
  let verifierCalls = 0;
  const app = await makeApp(t, {
    deckContents:managedBundle(),
    managedWorkingDeck:true,
    workingPatchVerifier:async workingDeckPath => {
      verifierCalls += 1;
      assert.equal(workingDeckPath, app.workingDeckPath);
      assert.match(await readFile(workingDeckPath, 'utf8'), /破坏旧补丁目标的源码修改/);
      throw verifierError;
    },
  });
  const workingBefore = await readFile(app.workingDeckPath);
  let response = await fetch(`${app.url}/api/source-edits?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:0, taskId:null,
    }),
  });
  let result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  const { sourceEditId } = result;

  await writeFile(
    app.workingDeckPath,
    workingBefore.toString('utf8').replace('旧文案', '破坏旧补丁目标的源码修改'),
  );
  response = await fetch(
    `${app.url}/api/source-edits/${sourceEditId}/commit?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:1,
    }) },
  );
  result = await response.json();

  assert.equal(response.status, 409, JSON.stringify(result));
  assert.equal(result.code, 'PATCH_REPLAY_FAILED');
  assert.equal(verifierCalls, 1);
  assert.deepEqual(await readFile(app.workingDeckPath), workingBefore);
  assert.equal(app.session.revision, 1);
  assert.equal(app.session.sourceEdit?.id, sourceEditId);
  assert.deepEqual(app.session.groups, []);
});

test('源码事务删除已固化动作所在页面时剔除被取代补丁并完成任务', async t => {
  const deletedPageKey = 'page-22222222222222222222222222222222';
  const solidifiedAction = {
    id:'solidified-action-on-deleted-page', taskId:null,
    target:{
      pageKey:deletedPageKey,
      path:'0', tag:'H1', fingerprint:'1234abcd', textPath:'0',
    },
    kind:'setText', payload:{ text:'已修改' },
    before:'删除页', after:'已修改', appliedAt:'2026-08-23T00:00:00.000Z',
  };
  let verifierCalls = 0;
  const app = await makeApp(t, {
    deckContents:managedTwoPageBundleWithPatches([solidifiedAction]),
    managedWorkingDeck:true,
    workingPatchVerifier:async workingDeckPath => {
      verifierCalls += 1;
      const candidate = await readFile(workingDeckPath, 'utf8');
      const lines = candidate.split('\n');
      const templateMarker = lines.findIndex(
        line => line.trim() === '<script type="__bundler/template">',
      );
      const template = JSON.parse(lines[templateMarker + 1]);
      const pageExists = template.includes(`data-page-id="${deletedPageKey}"`);
      if (!pageExists && template.includes(solidifiedAction.id)) {
        throw Object.assign(new Error('旧固化动作的页面已被源码事务删除'), {
          code:'PATCH_REPLAY_FAILED', statusCode:409, stage:'patch-replay',
          replayCode:'PAGE_NOT_FOUND', failedActionId:solidifiedAction.id,
        });
      }
      return { ok:true };
    },
  });
  assert.deepEqual(app.session.solidifiedActions, [solidifiedAction]);

  let response = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:0,
      pageKey:deletedPageKey, pageIndex:2, pageLabel:'删除页',
      rect:{ x:1, y:2, w:3, h:4 }, instruction:'删除这一页',
    }),
  });
  let result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  const taskId = result.task.id;

  response = await fetch(
    `${app.url}/api/tasks/${taskId}/source-edit/begin?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:result.revision,
    }) },
  );
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  const { sourceEditId } = result;
  const workingBefore = await readFile(app.workingDeckPath, 'utf8');
  await writeFile(app.workingDeckPath, updateBundledTemplate(
    workingBefore,
    template => removeManagedPage(template, deletedPageKey)
      .replace("      { i:1, code:'02', label:'删除页' },\n", ''),
  ));

  response = await fetch(
    `${app.url}/api/source-edits/${sourceEditId}/commit?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:result.revision,
    }) },
  );
  result = await response.json();

  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(verifierCalls, 3, '剔除旧补丁后还应验证包含未固化动作的完整候选');
  assert.equal(app.session.tasks.find(task => task.id === taskId)?.status, 'completed');
  assert.deepEqual(app.session.solidifiedActions, []);
  assert.deepEqual(app.session.historyRepair?.droppedActionIds, [solidifiedAction.id]);
  assert.equal(app.session.groups.at(-1)?.mutationType, 'source');
  const sourceGroupId = result.groupId;
  const workingAfter = await readFile(app.workingDeckPath, 'utf8');
  assert.doesNotMatch(workingAfter, new RegExp(deletedPageKey));
  assert.doesNotMatch(workingAfter, new RegExp(solidifiedAction.id));

  response = await fetch(
    `${app.url}/api/groups/${sourceGroupId}/undo?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:app.session.revision,
    }) },
  );
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.deepEqual(app.session.solidifiedActions, [solidifiedAction]);
  assert.equal(app.session.tasks.find(task => task.id === taskId)?.status, 'completed');
  assert.equal(app.session.tasks.find(task => task.id === taskId)?.effectState, 'undone');
  assert.match(await readFile(app.workingDeckPath, 'utf8'), new RegExp(deletedPageKey));

  response = await fetch(
    `${app.url}/api/groups/${sourceGroupId}/redo?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:app.session.revision,
    }) },
  );
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.deepEqual(app.session.solidifiedActions, []);
  assert.equal(app.session.tasks.find(task => task.id === taskId)?.status, 'completed');
  assert.doesNotMatch(await readFile(app.workingDeckPath, 'utf8'), new RegExp(deletedPageKey));
  assert.equal(await readFile(app.deckPath, 'utf8'), managedTwoPageBundleWithPatches([
    solidifiedAction,
  ]));
});

test('源码事务写盘后重启仍保留旧基线并可显式提交', async t => {
  const app = await makeApp(t, {
    deckContents:managedBundle(),
    managedWorkingDeck:true,
  });
  let response = await fetch(`${app.url}/api/source-edits?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:0, taskId:null,
    }),
  });
  let result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  const { sourceEditId, beforeFingerprint } = result;
  const workingBefore = await readFile(app.workingDeckPath, 'utf8');
  await writeFile(app.workingDeckPath, workingBefore.replace('旧文案', '重启后提交'));
  await app.close();

  const reopened = await startServer({
    deckPath:app.deckPath,
    host:'127.0.0.1', port:0, openBrowser:false,
    token:'reopen-secret', editorToken:'reopen-editor-secret',
    managedWorkingDeck:true,
    autoStartAgentTerminal:false,
    workingPatchVerifier:async () => ({ ok:true }),
  });
  t.after(() => reopened.close());
  assert.equal(reopened.session.sourceEdit?.id, sourceEditId);
  assert.equal(reopened.session.sourceEdit?.beforeFingerprint, beforeFingerprint);
  assert.equal(reopened.session.workingDeckFingerprint, beforeFingerprint);

  response = await fetch(
    `${reopened.url}/api/source-edits/${sourceEditId}/commit?token=reopen-secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:1,
    }) },
  );
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.revision, 2);
  assert.equal(reopened.session.sourceEdit, undefined);
  assert.deepEqual(reopened.session.groups.map(group => group.mutationType), ['source']);
  assert.match(await readFile(reopened.workingDeckPath, 'utf8'), /重启后提交/);
});

test('源码事务开始与等待浏览器 ACK 的人工 action 共用同一串行队列', async t => {
  const app = await makeApp(t, {
    deckContents:managedBundle(),
    managedWorkingDeck:true,
  });
  const editor = await connectDiagnosticsEditor(t, app);
  const commandPromise = nextMessage(editor);
  const actionResponsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:0,
      taskId:null,
      actions:[{
        id:'manual-before-source-begin', taskId:null,
        target:{
          pageKey:'page-001-save-gate', path:'0', tag:'H1', fingerprint:'1234abcd',
        },
        kind:'setText', payload:{ text:'先完成人工修改' },
        before:'旧文案', after:'先完成人工修改',
        appliedAt:'2026-08-16T00:00:00.000Z', expectedRevision:0,
      }],
    }),
  });
  const command = await commandPromise;
  assert.equal(command.type, 'apply-actions');

  let beginSettled = false;
  const beginResponsePromise = fetch(`${app.url}/api/source-edits?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:0, taskId:null,
    }),
  }).then(response => {
    beginSettled = true;
    return response;
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(beginSettled, false, '人工 action 未确认前不得越过队列创建源码事务');

  await prepareAndCommit(editor, command);
  const actionResponse = await actionResponsePromise;
  assert.equal(actionResponse.status, 200, await actionResponse.text());
  const beginResponse = await beginResponsePromise;
  const beginResult = await beginResponse.json();
  assert.equal(beginResponse.status, 409, JSON.stringify(beginResult));
  assert.equal(beginResult.code, 'REVISION_CONFLICT');
  assert.equal(app.session.sourceEdit, undefined);
  assert.equal(app.session.revision, 1);
});

test('取消源码事务原子恢复开始前工作副本且不创建历史', async t => {
  const app = await makeApp(t, {
    deckContents:managedBundle(),
    managedWorkingDeck:true,
  });
  const workingBefore = await readFile(app.workingDeckPath);
  let response = await fetch(`${app.url}/api/source-edits?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:0, taskId:null,
    }),
  });
  let result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  await writeFile(
    app.workingDeckPath,
    Buffer.from(workingBefore.toString('utf8').replace('旧文案', '取消掉的修改')),
  );

  response = await fetch(
    `${app.url}/api/source-edits/${result.sourceEditId}/cancel?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:1,
    }) },
  );
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.revision, 2);
  assert.equal(app.session.sourceEdit, undefined);
  assert.deepEqual(app.session.groups, []);
  assert.deepEqual(await readFile(app.workingDeckPath), workingBefore);
});

test('工作副本已经写盘时撤销必须先登记 SourceMutation 并拒绝旧历史操作', async t => {
  const app = await makeApp(t, {
    deckContents:managedBundle(),
    managedWorkingDeck:true,
  });
  await connectCanonicalActionEditor(t, app);
  const workingBefore = await readFile(app.workingDeckPath, 'utf8');
  const pageKey = workingBefore.match(/data-page-id=\\"(page-[0-9a-f]{32})\\"/)?.[1];
  assert.ok(pageKey);

  let response = await fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:0,
      taskId:null,
      actions:[{
        id:'action-before-source-write', taskId:null,
        target:{
          pageKey, path:'0', tag:'H1', fingerprint:'1234abcd',
          rect:{ x:0, y:0, w:200, h:80 },
        },
        kind:'setText', payload:{ text:'人工先提交' },
        before:'旧文案', after:'人工先提交',
        appliedAt:'2026-08-16T00:00:00.000Z', expectedRevision:0,
      }],
    }),
  });
  let result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  const actionGroupId = result.groupId;

  await writeFile(app.workingDeckPath, workingBefore.replace('旧文案', 'Agent 后写盘'));
  response = await fetch(
    `${app.url}/api/groups/${actionGroupId}/undo?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:result.revision,
    }) },
  );
  result = await response.json();

  assert.equal(response.status, 409, JSON.stringify(result));
  assert.equal(result.code, 'REVISION_CONFLICT');
  assert.deepEqual(app.session.groups.map(group => group.mutationType), ['action', 'source']);
  assert.equal(app.session.groups[0].active, true);
  assert.equal(app.session.groups[1].active, true);
  assert.equal(app.session.revision, 2);
});

test('工作副本已经写盘时固化必须先登记 SourceMutation 并拒绝过期 revision', async t => {
  const source = managedBundle();
  const app = await makeApp(t, {
    deckContents:source,
    managedWorkingDeck:true,
  });
  const workingBefore = await readFile(app.workingDeckPath, 'utf8');
  await writeFile(app.workingDeckPath, workingBefore.replace('旧文案', 'Agent 待固化写盘'));

  const response = await fetch(`${app.url}/api/solidify-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0 }),
  });
  const result = await response.json();

  assert.equal(response.status, 409, JSON.stringify(result));
  assert.equal(result.code, 'REVISION_CONFLICT');
  assert.deepEqual(app.session.groups.map(group => group.mutationType), ['source']);
  assert.equal(app.session.revision, 1);
  assert.deepEqual(await readFile(app.deckPath, 'utf8'), source);
});

test('工作副本写入中断时关闭不报错且重开恢复最后有效版本', async t => {
  const source = managedBundle();
  const app = await makeApp(t, {
    deckContents:source,
    managedWorkingDeck:true,
  });
  const workingBefore = await readFile(app.workingDeckPath);
  const validFingerprint = app.session.workingDeckFingerprint;
  await writeFile(
    app.workingDeckPath,
    '<script type="__bundler/template">\n"写入中断',
  );
  await new Promise(resolve => setTimeout(resolve, 350));
  await app.close();

  const reopened = await startServer({
    deckPath:app.deckPath,
    host:'127.0.0.1', port:0, openBrowser:false,
    token:'reopen-secret', editorToken:'reopen-editor-secret',
    managedWorkingDeck:true,
    autoStartAgentTerminal:false,
    workingPatchVerifier:async () => ({ ok:true }),
  });
  t.after(() => reopened.close());
  assert.deepEqual(await readFile(reopened.workingDeckPath), workingBefore);
  assert.equal(reopened.session.workingDeckFingerprint, validFingerprint);
  assert.equal(reopened.session.startupRecovery?.code, 'WORKING_DECK_RECOVERED');
  assert.equal(reopened.session.startupRecovery?.restoredFingerprint, validFingerprint);
  assert.deepEqual(await readFile(reopened.deckPath, 'utf8'), source);
});

test('旧工作副本补齐元素身份后同步迁移 SourceMutation 指纹并保持撤销重做', async t => {
  const app = await makeApp(t, {
    deckContents:managedBundle(),
    managedWorkingDeck:true,
  });
  const normalizedBefore = await readFile(app.workingDeckPath, 'utf8');
  const beforeFingerprint = app.session.workingDeckFingerprint;
  assert.match(normalizedBefore, /data-editor-id=\\"element-[0-9a-f]{32}\\"/);
  await app.close();

  const legacyWorking = updateBundledTemplate(normalizedBefore, template => (
    template.replace(/\s+data-editor-id="element-[0-9a-f]{32}"/g, '')
  ));
  const legacyFingerprint = sha256(legacyWorking);
  await writeFile(app.workingDeckPath, legacyWorking);
  const sessionPath = join(app.sessionDir, 'session.json');
  const session = JSON.parse(await readFile(sessionPath, 'utf8'));
  session.revision = 1;
  session.workingDeckFingerprint = legacyFingerprint;
  session.groups = [{
    id:'11111111-1111-4111-8111-111111111111',
    mutationType:'source', taskId:null, actions:[], active:true,
    source:{
      beforeFingerprint, afterFingerprint:legacyFingerprint,
      summary:'旧版工作副本结构修改',
    },
  }];
  session.redo = [];
  await writeFile(sessionPath, JSON.stringify(session, null, 2));

  const reopened = await startServer({
    deckPath:app.deckPath,
    host:'127.0.0.1', port:0, openBrowser:false,
    token:'identity-reopen-secret', editorToken:'identity-reopen-editor-secret',
    managedWorkingDeck:true,
    autoStartAgentTerminal:false,
    workingPatchVerifier:async () => ({ ok:true }),
  });
  t.after(() => reopened.close());
  const migratedAfter = reopened.session.workingDeckFingerprint;
  assert.notEqual(migratedAfter, legacyFingerprint);
  assert.equal(reopened.session.groups[0].source.beforeFingerprint, beforeFingerprint);
  assert.equal(reopened.session.groups[0].source.afterFingerprint, migratedAfter);
  assert.match(await readFile(reopened.workingDeckPath, 'utf8'),
    /data-editor-id=\\"element-[0-9a-f]{32}\\"/);

  let response = await fetch(
    `${reopened.url}/api/groups/${session.groups[0].id}/undo?token=identity-reopen-secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:reopened.session.revision,
    }) },
  );
  let result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(reopened.session.workingDeckFingerprint, beforeFingerprint);

  response = await fetch(
    `${reopened.url}/api/groups/${session.groups[0].id}/redo?token=identity-reopen-secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:result.revision,
    }) },
  );
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(reopened.session.workingDeckFingerprint, migratedAfter);
});

test('启动托管工作副本时从内嵌补丁恢复中文固化基线', async t => {
  const patches = [{
    id:'中文固化动作', taskId:null,
    target:{
      pageKey:'page-11111111111111111111111111111111',
      path:'0', tag:'H1', fingerprint:'1234abcd', textPath:'0',
    },
    kind:'setText', payload:{ text:'我是帅哥' },
    before:'从模型适配到强化学习资源预测', after:'我是帅哥',
    appliedAt:'2026-08-15T00:00:00.000Z',
  }];
  const app = await makeApp(t, {
    deckContents:managedBundleWithPatches(patches),
    managedWorkingDeck:true,
  });

  assert.deepEqual(app.session.solidifiedActions, patches);
});

test('Agent 结构任务绑定下一次工作副本修改，并随撤销重做切换任务状态', async t => {
  const source = managedBundle();
  const app = await makeApp(t, {
    deckContents:source,
    managedWorkingDeck:true,
  });
  const workingBefore = await readFile(app.workingDeckPath, 'utf8');
  const pageKey = workingBefore.match(/data-page-id=\\"(page-[0-9a-f]{32})\\"/)?.[1];
  assert.ok(pageKey);

  let response = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:0,
      pageKey, pageIndex:1, pageLabel:'测试页',
      rect:{ x:1, y:2, w:3, h:4 }, instruction:'删除这一页',
    }),
  });
  let result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  const taskId = result.task.id;

  response = await fetch(
    `${app.url}/api/tasks/${taskId}/source-edit/begin?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:result.revision,
    }) },
  );
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.taskId, taskId);
  assert.equal(result.revision, 2);
  const { sourceEditId } = result;

  await writeFile(app.workingDeckPath, workingBefore.replace('旧文案', '结构任务文案'));
  response = await fetch(
    `${app.url}/api/source-edits/${sourceEditId}/commit?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:result.revision,
    }) },
  );
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  const session = app.session;

  assert.equal(session.tasks[0].status, 'completed');
  assert.equal(session.groups.length, 1);
  assert.equal(session.groups[0].mutationType, 'source');
  assert.equal(session.groups[0].taskId, taskId);
  assert.equal(session.tasks[0].groupId, session.groups[0].id);

  response = await fetch(
    `${app.url}/api/groups/${session.groups[0].id}/undo?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:session.revision,
    }) },
  );
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.task.status, 'completed');
  assert.equal(result.task.effectState, 'undone');

  response = await fetch(
    `${app.url}/api/groups/${session.groups[0].id}/redo?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:result.revision,
    }) },
  );
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.task.status, 'completed');
});

test('结构任务租约拒绝并发绑定，取消后允许下一任务接管', async t => {
  const app = await makeApp(t, {
    deckContents:managedBundle(),
    managedWorkingDeck:true,
  });
  const working = await readFile(app.workingDeckPath, 'utf8');
  const pageKey = working.match(/data-page-id=\\"(page-[0-9a-f]{32})\\"/)?.[1];
  assert.ok(pageKey);
  const createTask = async (instruction, expectedRevision) => {
    const response = await fetch(`${app.url}/api/tasks?token=secret`, {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
        expectedRevision, pageKey, pageIndex:1, pageLabel:'测试页',
        rect:{ x:1, y:2, w:3, h:4 }, instruction,
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 201, JSON.stringify(result));
    return result;
  };
  const first = await createTask('删除第一页', 0);
  const second = await createTask('移动第一页', first.revision);
  const postLease = (taskId, operation, expectedRevision) => fetch(
    `${app.url}/api/tasks/${taskId}/source-edit/${operation}?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision,
    }) },
  );

  let response = await postLease(first.task.id, 'begin', second.revision);
  let result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.revision, 3);
  response = await postLease(second.task.id, 'begin', result.revision);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'SOURCE_EDIT_ACTIVE');
  response = await postLease(first.task.id, 'cancel', result.revision);
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.revision, 4);
  response = await postLease(second.task.id, 'begin', result.revision);
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.revision, 5);
});

test('固化结构历史才会原子发布托管工作副本并清空撤销队列', async t => {
  const source = managedBundle();
  const app = await makeApp(t, {
    deckContents:source,
    managedWorkingDeck:true,
  });
  const workingBefore = await readFile(app.workingDeckPath, 'utf8');
  const pageKey = workingBefore.match(/data-page-id=\\"(page-[0-9a-f]{32})\\"/)?.[1];
  assert.ok(pageKey);
  const editor = await connect(app.editorWsUrl);
  t.after(() => editor.close());
  const sendReady = revision => editor.send(JSON.stringify({
    type:'deck-ready', revision,
    pages:[{ index:1, label:'测试页', pageKey }],
    diagnostics:[{
      pageKey, sectionOverflow:{ x:0, y:0 }, nestedClips:[],
    }],
  }));
  editor.on('message', data => {
    const message = JSON.parse(data);
    if (message.type !== 'diagnose-pages') return;
    editor.send(JSON.stringify({
      type:'diagnostics-result', commandId:message.commandId,
      revision:message.revision,
      pages:message.pageKeys.map(requested => ({
        pageKey:requested, sectionOverflow:{ x:0, y:0 }, nestedClips:[],
      })),
    }));
  });
  sendReady(0);
  await writeFile(app.workingDeckPath, workingBefore.replace('旧文案', '已固化结构文案'));
  const deadline = Date.now() + 3_000;
  while (app.session.groups.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(app.session.groups[0]?.mutationType, 'source');
  sendReady(app.session.revision);
  const diagnosticsDeadline = Date.now() + 1_000;
  while (!Object.keys(app.session.diagnosticsBaseline ?? {}).length
    && Date.now() < diagnosticsDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  const response = await fetch(`${app.url}/api/solidify-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:app.session.revision }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.solidified, true);
  assert.deepEqual(app.session.groups, []);
  assert.deepEqual(app.session.redo, []);
  assert.match(await readFile(app.deckPath, 'utf8'), /已固化结构文案/);
});

test('固化成功但目录见证未持久化时重启按会话检查点自动恢复绑定', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-binding-checkpoint-recovery-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, 'deck.html');
  const deckId = '623e4567-e89b-42d3-a456-426614174000';
  await writeFile(deckPath, managedBundle());
  const initialCoordinator = await openDeckBinding({
    deckId,
    initialBinding:{ currentPath:deckPath, trustedRoot:root, revision:0 },
    storageRoot:root,
    watch:false,
  });
  const staleCatalogBinding = initialCoordinator.snapshot();
  await initialCoordinator.close();

  const first = await startServer({
    deckPath, deckId, deckBinding:staleCatalogBinding,
    host:'127.0.0.1', port:0, openBrowser:false,
    token:'checkpoint-first-secret', editorToken:'checkpoint-first-editor-secret',
    managedWorkingDeck:true, autoStartAgentTerminal:false,
    workingPatchVerifier:async () => ({ ok:true }),
    updateWorkItemBinding:null,
  });
  const editor = await connect(first.editorWsUrl);
  const workingBefore = await readFile(first.workingDeckPath, 'utf8');
  const pageKey = workingBefore.match(/data-page-id=\\"(page-[0-9a-f]{32})\\"/)?.[1];
  assert.ok(pageKey);
  editor.on('message', data => {
    const message = JSON.parse(data);
    if (message.type !== 'diagnose-pages') return;
    editor.send(JSON.stringify({
      type:'diagnostics-result', commandId:message.commandId,
      revision:message.revision,
      pages:message.pageKeys.map(requested => ({
        pageKey:requested, sectionOverflow:{ x:0, y:0 }, nestedClips:[],
      })),
    }));
  });
  const sendReady = revision => editor.send(JSON.stringify({
    type:'deck-ready', revision,
    pages:[{ index:1, label:'测试页', pageKey }],
    diagnostics:[{ pageKey, sectionOverflow:{ x:0, y:0 }, nestedClips:[] }],
  }));
  sendReady(0);
  await writeFile(first.workingDeckPath, workingBefore.replace('旧文案', '检查点恢复文案'));
  const groupDeadline = Date.now() + 3_000;
  while (first.session.groups.length === 0 && Date.now() < groupDeadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 40));
  }
  assert.equal(first.session.groups[0]?.mutationType, 'source');
  sendReady(first.session.revision);
  const diagnosticsDeadline = Date.now() + 1_000;
  while (!Object.keys(first.session.diagnosticsBaseline ?? {}).length
    && Date.now() < diagnosticsDeadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  const solidified = await fetch(
    `${first.url}/api/solidify-deck?token=${encodeURIComponent(first.token)}`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:first.session.revision,
    }) },
  );
  const solidifiedResult = await solidified.json();
  assert.equal(solidified.status, 200, JSON.stringify(solidifiedResult));
  const publishedFingerprint = first.session.deckFingerprint;
  assert.equal(first.session.checkpoints.at(-1)?.fingerprint, publishedFingerprint);
  editor.close();
  await first.close();

  const publishedBytes = await readFile(deckPath);
  const externalReplacement = deckPath + '.external';
  await writeFile(externalReplacement, managedBundle('外部替换文案'));
  await rename(externalReplacement, deckPath);
  const rejected = await startServer({
    deckPath, deckId, deckBinding:staleCatalogBinding,
    host:'127.0.0.1', port:0, openBrowser:false,
    managedWorkingDeck:true, autoStartAgentTerminal:false,
    workingPatchVerifier:async () => ({ ok:true }),
  });
  assert.equal(rejected.binding.snapshot().state, 'conflict',
    '当前源文件不匹配已固化检查点时必须继续阻断');
  await rejected.close();

  const restoredPublished = deckPath + '.published';
  await writeFile(restoredPublished, publishedBytes);
  await rename(restoredPublished, deckPath);

  let recoveredBinding = null;
  const reopened = await startServer({
    deckPath, deckId, deckBinding:staleCatalogBinding,
    host:'127.0.0.1', port:0, openBrowser:false,
    token:'checkpoint-reopen-secret', editorToken:'checkpoint-reopen-editor-secret',
    managedWorkingDeck:true, autoStartAgentTerminal:false,
    workingPatchVerifier:async () => ({ ok:true }),
    updateWorkItemBinding:async binding => { recoveredBinding = binding; },
  });
  try {
    assert.equal(reopened.binding.snapshot().state, 'bound');
    assert.equal(reopened.binding.snapshot().reason, 'recovered-published-checkpoint');
    assert.equal(reopened.binding.snapshot().sourceFingerprint, `sha256:${publishedFingerprint}`);
    assert.equal(recoveredBinding?.sourceFingerprint, `sha256:${publishedFingerprint}`);
  } finally {
    await reopened.close();
  }
});

test('未固化删除任务目标页后可安全重开并撤销恢复', async t => {
  const app = await makeApp(t, {
    deckContents:managedTwoPageBundle(),
    managedWorkingDeck:true,
  });
  const workingBefore = await readFile(app.workingDeckPath, 'utf8');
  const pageKeys = [...workingBefore.matchAll(/data-page-id=\\"(page-[0-9a-f]{32})\\"/g)]
    .map(match => match[1]);
  const deletedPageKey = pageKeys[1];
  let response = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:0,
      pageKey:deletedPageKey, pageIndex:2, pageLabel:'删除页',
      rect:{ x:1, y:2, w:3, h:4 }, instruction:'删掉这一页',
    }),
  });
  let result = await response.json();
  const taskId = result.task.id;
  response = await fetch(
    `${app.url}/api/tasks/${taskId}/source-edit/begin?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:result.revision,
    }) },
  );
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  const { sourceEditId } = result;
  await writeFile(app.workingDeckPath, updateBundledTemplate(
    workingBefore,
    template => removeManagedPage(template, deletedPageKey)
      .replace("      { i:1, code:'02', label:'删除页' },\n", ''),
  ));
  response = await fetch(
    `${app.url}/api/source-edits/${sourceEditId}/commit?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:result.revision,
    }) },
  );
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  await app.close();

  const reopened = await startServer({
    deckPath:app.deckPath,
    host:'127.0.0.1', port:0, openBrowser:false,
    token:'reopen-secret', editorToken:'reopen-editor-secret',
    managedWorkingDeck:true,
    autoStartAgentTerminal:false,
    workingPatchVerifier:async () => ({ ok:true }),
  });
  t.after(() => reopened.close());
  const reopenedTask = reopened.session.tasks.find(task => task.id === taskId);
  assert.equal(reopenedTask?.status, 'completed');
  assert.equal(reopenedTask?.targetMissing, true);
  const [group] = reopened.session.groups;
  response = await fetch(
    `${reopened.url}/api/groups/${group.id}/undo?token=reopen-secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:reopened.session.revision,
    }) },
  );
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.task.status, 'completed');
  assert.equal(result.task.effectState, 'undone');
  assert.equal(result.task.targetMissing, undefined);
  assert.match(await readFile(reopened.workingDeckPath, 'utf8'), new RegExp(deletedPageKey));
});

test('新增改名和重排页面的未固化任务均可安全重开', async t => {
  const mutations = new Map([
    ['改名', template => template.replaceAll('删除页', '改名页')],
    ['新增', template => template
      .replace(
        '<script>\nconst nav',
        '<div class="slide-fit"><div><section data-label="新增页" '
          + 'data-page-id="page-33333333333333333333333333333333">'
          + '<h1>新增页</h1></section></div></div>\n<script>\nconst nav',
      )
      .replace(
        "      { i:1, code:'02', label:'删除页' },\n",
        "      { i:1, code:'02', label:'删除页' },\n"
          + "      { i:2, code:'03', label:'新增页' },\n",
      )],
    ['重排', (template, pageKeys) => {
      const first = managedPageBlock(template, pageKeys[0]);
      const second = managedPageBlock(template, pageKeys[1]);
      return template.replace(first + second, second + first).replace(
        "      { i:0, code:'01', label:'保留页' },\n"
          + "      { i:1, code:'02', label:'删除页' },\n",
        "      { i:0, code:'02', label:'删除页' },\n"
          + "      { i:1, code:'01', label:'保留页' },\n",
      );
    }],
  ]);
  for (const [name, mutate] of mutations) {
    await t.test(name, async subtest => {
      const app = await makeApp(subtest, {
        deckContents:managedTwoPageBundle(),
        managedWorkingDeck:true,
      });
      const workingBefore = await readFile(app.workingDeckPath, 'utf8');
      const pageKeys = [...workingBefore.matchAll(/data-page-id=\\"(page-[0-9a-f]{32})\\"/g)]
        .map(match => match[1]);
      let response = await fetch(`${app.url}/api/tasks?token=secret`, {
        method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
          expectedRevision:0,
          pageKey:pageKeys[1], pageIndex:2, pageLabel:'删除页',
          rect:{ x:1, y:2, w:3, h:4 }, instruction:`${name}页面`,
        }),
      });
      let result = await response.json();
      response = await fetch(
        `${app.url}/api/tasks/${result.task.id}/source-edit/begin?token=secret`,
        { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
          expectedRevision:result.revision,
        }) },
      );
      result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      const { sourceEditId } = result;
      await writeFile(
        app.workingDeckPath,
        updateBundledTemplate(workingBefore, template => mutate(template, pageKeys)),
      );
      response = await fetch(
        `${app.url}/api/source-edits/${sourceEditId}/commit?token=secret`,
        { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
          expectedRevision:result.revision,
        }) },
      );
      result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      await app.close();
      const reopened = await startServer({
        deckPath:app.deckPath,
        host:'127.0.0.1', port:0, openBrowser:false,
        token:`${name}-reopen`, editorToken:`${name}-editor`,
        managedWorkingDeck:true,
        autoStartAgentTerminal:false,
        workingPatchVerifier:async () => ({ ok:true }),
      });
      subtest.after(() => reopened.close());
      assert.equal(reopened.session.groups.length, 1);
      assert.equal(reopened.session.tasks[0]?.targetMissing, undefined);
    });
  }
});

test('固化删除页面后保留归档任务并隔离同页残留任务', async t => {
  const app = await makeApp(t, {
    deckContents:managedTwoPageBundle(),
    managedWorkingDeck:true,
  });
  const workingBefore = await readFile(app.workingDeckPath, 'utf8');
  const pageKeys = [...workingBefore.matchAll(/data-page-id=\\"(page-[0-9a-f]{32})\\"/g)]
    .map(match => match[1]);
  assert.equal(pageKeys.length, 2);
  const [remainingPageKey, deletedPageKey] = pageKeys;

  const editor = await connect(app.editorWsUrl);
  t.after(() => editor.close());
  editor.on('message', data => {
    const message = JSON.parse(data);
    if (message.type !== 'diagnose-pages') return;
    editor.send(JSON.stringify({
      type:'diagnostics-result', commandId:message.commandId,
      revision:message.revision,
      pages:message.pageKeys.map(pageKey => ({
        pageKey, sectionOverflow:{ x:0, y:0 }, nestedClips:[],
      })),
    }));
  });
  const sendReady = (revision, keys) => editor.send(JSON.stringify({
    type:'deck-ready', revision,
    pages:keys.map((pageKey, index) => ({
      index:index + 1, label:index === 0 ? '保留页' : '删除页', pageKey,
    })),
    diagnostics:keys.map(pageKey => ({
      pageKey, sectionOverflow:{ x:0, y:0 }, nestedClips:[],
    })),
  }));
  sendReady(0, pageKeys);

  let response = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:0,
      pageKey:deletedPageKey, pageIndex:2, pageLabel:'删除页',
      rect:{ x:1, y:2, w:3, h:4 }, instruction:'删掉这一页',
    }),
  });
  let result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  const taskId = result.task.id;
  response = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:result.revision,
      pageKey:deletedPageKey, pageIndex:2, pageLabel:'删除页',
      rect:{ x:10, y:20, w:30, h:40 }, instruction:'把这一页标题改短',
    }),
  });
  result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  const residualTaskId = result.task.id;
  response = await fetch(
    `${app.url}/api/tasks/${taskId}/source-edit/begin?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:result.revision,
    }) },
  );
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  const { sourceEditId } = result;

  const workingAfterDelete = updateBundledTemplate(workingBefore, template => removeManagedPage(
    template,
    deletedPageKey,
  )
    .replace("      { i:1, code:'02', label:'删除页' },\n", ''));
  await writeFile(app.workingDeckPath, workingAfterDelete);
  response = await fetch(
    `${app.url}/api/source-edits/${sourceEditId}/commit?token=secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:result.revision,
    }) },
  );
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(app.session.tasks[0]?.status, 'completed');
  assert.equal(app.session.tasks[0]?.pageKey, deletedPageKey);
  assert.equal(app.session.groups[0]?.mutationType, 'source');
  sendReady(app.session.revision, [remainingPageKey]);

  response = await fetch(`${app.url}/api/solidify-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:app.session.revision }),
  });
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.deepEqual(app.session.groups, []);
  assert.deepEqual(app.session.redo, []);
  assert.equal(app.session.tasks[0]?.pageKey, deletedPageKey);

  await app.close();
  const reopened = await startServer({
    deckPath:app.deckPath,
    host:'127.0.0.1', port:0, openBrowser:false,
    token:'reopen-secret', editorToken:'reopen-editor-secret',
    managedWorkingDeck:true,
    autoStartAgentTerminal:false,
    workingPatchVerifier:async () => ({ ok:true }),
  });
  t.after(() => reopened.close());
  assert.equal(reopened.session.tasks[0]?.status, 'completed');
  assert.equal(reopened.session.tasks[0]?.pageKey, deletedPageKey);
  assert.equal(reopened.session.tasks[0]?.targetMissing, true);
  const residualTask = reopened.session.tasks.find(task => task.id === residualTaskId);
  assert.equal(residualTask?.status, 'pending');
  assert.equal(residualTask?.targetMissing, true);
  response = await fetch(`${reopened.url}/api/agent-runs?token=reopen-secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:reopened.session.revision, taskIds:[residualTaskId],
    }),
  });
  result = await response.json();
  assert.equal(response.status, 409, JSON.stringify(result));
  assert.equal(result.code, 'TASK_TARGET_MISSING');
});

test('删除已有固化动作的页面后仍可重开撤销且拒绝再次固化', async t => {
  const deletedPageKey = 'page-22222222222222222222222222222222';
  const patches = [{
    id:'固化动作', taskId:null,
    target:{
      pageKey:deletedPageKey,
      path:'0', tag:'H1', fingerprint:'1234abcd', textPath:'0',
    },
    kind:'setText', payload:{ text:'已修改' },
    before:'删除页', after:'已修改', appliedAt:'2026-08-15T00:00:00.000Z',
  }];
  const app = await makeApp(t, {
    deckContents:managedTwoPageBundleWithPatches(patches),
    managedWorkingDeck:true,
  });
  const workingBefore = await readFile(app.workingDeckPath, 'utf8');
  await writeFile(app.workingDeckPath, updateBundledTemplate(
    workingBefore,
    template => removeManagedPage(template, deletedPageKey)
      .replace("      { i:1, code:'02', label:'删除页' },\n", ''),
  ));
  const deadline = Date.now() + 3_000;
  while (app.session.groups.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  await app.close();

  const reopened = await startServer({
    deckPath:app.deckPath,
    host:'127.0.0.1', port:0, openBrowser:false,
    token:'reopen-secret', editorToken:'reopen-editor-secret',
    managedWorkingDeck:true,
    autoStartAgentTerminal:false,
    workingPatchVerifier:async () => ({ ok:true }),
  });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.session.solidifiedActions, patches);
  let response = await fetch(`${reopened.url}/api/solidify-deck?token=reopen-secret`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:reopened.session.revision,
    }),
  });
  let result = await response.json();
  assert.equal(response.status, 409, JSON.stringify(result));
  assert.equal(result.code, 'MISSING_PAGE_TARGETS');

  const [group] = reopened.session.groups;
  response = await fetch(
    `${reopened.url}/api/groups/${group.id}/undo?token=reopen-secret`,
    { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({
      expectedRevision:reopened.session.revision,
    }) },
  );
  result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.match(await readFile(reopened.workingDeckPath, 'utf8'), new RegExp(deletedPageKey));
});

test('固化补丁重放失败时真实 Deck 不变且工作副本恢复到固化前版本', async t => {
  const source = managedBundle();
  const verifierError = Object.assign(new Error('注入补丁重放失败'), {
    code:'PATCH_REPLAY_FAILED', statusCode:409, stage:'patch-replay',
  });
  let rejectReplay = false;
  const app = await makeApp(t, {
    deckContents:source,
    managedWorkingDeck:true,
    workingPatchVerifier:async () => {
      if (rejectReplay) throw verifierError;
      return { ok:true };
    },
  });
  const initialWorking = await readFile(app.workingDeckPath, 'utf8');
  const pageKey = initialWorking.match(/data-page-id=\\"(page-[0-9a-f]{32})\\"/)?.[1];
  assert.ok(pageKey);
  const editor = await connect(app.editorWsUrl);
  t.after(() => editor.close());
  editor.on('message', data => {
    const message = JSON.parse(data);
    if (message.type !== 'diagnose-pages') return;
    editor.send(JSON.stringify({
      type:'diagnostics-result', commandId:message.commandId,
      revision:message.revision,
      pages:message.pageKeys.map(requested => ({
        pageKey:requested, sectionOverflow:{ x:0, y:0 }, nestedClips:[],
      })),
    }));
  });
  const sendReady = revision => editor.send(JSON.stringify({
    type:'deck-ready', revision,
    pages:[{ index:1, label:'测试页', pageKey }],
    diagnostics:[{ pageKey, sectionOverflow:{ x:0, y:0 }, nestedClips:[] }],
  }));
  sendReady(0);
  await writeFile(app.workingDeckPath, initialWorking.replace('旧文案', '待固化结构文案'));
  const deadline = Date.now() + 3_000;
  while (app.session.groups.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(app.session.groups[0]?.mutationType, 'source');
  rejectReplay = true;
  sendReady(app.session.revision);
  const diagnosticsDeadline = Date.now() + 1_000;
  while (!Object.keys(app.session.diagnosticsBaseline ?? {}).length
    && Date.now() < diagnosticsDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const beforeSolidify = await readFile(app.workingDeckPath);
  const response = await fetch(`${app.url}/api/solidify-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:app.session.revision }),
  });
  const result = await response.json();
  assert.equal(response.status, 409, JSON.stringify(result));
  assert.equal(result.code, 'PATCH_REPLAY_FAILED');
  assert.deepEqual(await readFile(app.deckPath), Buffer.from(source));
  assert.deepEqual(await readFile(app.workingDeckPath), beforeSolidify);
  assert.equal(app.session.groups.length, 1);
  assert.equal(app.session.groups[0].mutationType, 'source');
});

test('保存回滚后 watcher 必须在串行边界重新读取权威指纹', async () => {
  const page = {
    pageKey:'page-001-watch-race', sectionOverflow:{ x:0, y:0 }, nestedClips:[],
  };
  let diskFingerprint = 'old-fingerprint';
  let persistCalls = 0;
  const state = {
    revision:0, tasks:[], groups:[], redo:[], deckFingerprint:'old-fingerprint', conflict:null,
    diagnosticsBaseline:{ [page.pageKey]:page },
    diagnosticsCurrent:{ [page.pageKey]:page }, diagnosticsRevision:0,
  };
  const sessionStore = {
    state, sessionPath:'/tmp/session.json',
    async persistState() {
      persistCalls += 1;
      if (persistCalls === 1) throw new Error('session persist failed');
    },
  };
  const bridge = new BridgeService({ sessionStore });
  const socket = {
    readyState:1,
    send(data) {
      const message = JSON.parse(data);
      if (message.type !== 'diagnose-pages') return;
      queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
        type:'diagnostics-result', commandId:message.commandId,
        revision:message.revision, pages:[page],
      })));
    },
  };
  bridge.setEditorSocket(socket);
  bridge.handleMessage(socket, JSON.stringify({
    type:'deck-ready', pages:[{ index:1, label:'测试页', pageKey:page.pageKey }], diagnostics:[page],
  }));

  const write = bridge.writeDeck(0, {
    fingerprint:async () => diskFingerprint,
    writer:async () => {
      diskFingerprint = 'new-fingerprint';
      return { ok:true, fingerprint:'new-fingerprint', backup:'/tmp/backup.html' };
    },
    restore:async () => { diskFingerprint = 'old-fingerprint'; },
  });
  const watcher = bridge.noteDeckFingerprint(async () => diskFingerprint);

  await assert.rejects(write, error => error.code === 'WRITE_FAILED' && error.stage === 'session');
  assert.equal(await watcher, false);
  assert.equal(diskFingerprint, 'old-fingerprint');
  assert.equal(state.deckFingerprint, 'old-fingerprint');
  assert.equal(state.conflict, null);
});

test('Deck 已替换但 session 基线持久化失败时恢复原文件与内存基线', async () => {
  const page = {
    pageKey:'page-001-save-rollback',
    sectionOverflow:{ x:0, y:0 },
    nestedClips:[],
  };
  const state = {
    revision:0,
    tasks:[],
    groups:[],
    redo:[],
    deckFingerprint:'old-fingerprint',
    diagnosticsBaseline:{ [page.pageKey]:page },
    diagnosticsCurrent:{ [page.pageKey]:page },
    diagnosticsRevision:0,
    conflict:null,
  };
  const sessionStore = {
    state,
    sessionPath:'/tmp/session.json',
    async persistState() { throw new Error('session persist failed'); },
  };
  const bridge = new BridgeService({ sessionStore });
  const socket = {
    readyState:1,
    send(data) {
      const message = JSON.parse(data);
      if (message.type !== 'diagnose-pages') return;
      queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
        type:'diagnostics-result',
        commandId:message.commandId,
        revision:message.revision,
        pages:[page],
      })));
    },
  };
  bridge.setEditorSocket(socket);
  bridge.handleMessage(socket, JSON.stringify({
    type:'deck-ready',
    pages:[{ index:1, label:'测试页', pageKey:page.pageKey }],
    diagnostics:[page],
  }));
  let restored = false;

  await assert.rejects(
    bridge.writeDeck(0, {
      fingerprint:async () => 'old-fingerprint',
      writer:async () => ({ fingerprint:'new-fingerprint', backup:'/tmp/backup.html' }),
      restore:async result => {
        assert.equal(result.fingerprint, 'new-fingerprint');
        restored = true;
      },
    }),
    error => error.code === 'WRITE_FAILED' && error.stage === 'session',
  );
  assert.equal(restored, true);
  assert.equal(state.deckFingerprint, 'old-fingerprint');
  assert.deepEqual(state.diagnosticsBaseline, { [page.pageKey]:page });
});

test('writer success 后 session persist 失败且 Deck 再次外改时保留第三值并冻结恢复', async () => {
  const page = {
    pageKey:'page-001-session-third-party',
    sectionOverflow:{ x:0, y:0 }, nestedClips:[],
  };
  let diskFingerprint = 'old-fingerprint';
  let persistCalls = 0;
  const state = {
    revision:0, tasks:[], groups:[], redo:[],
    deckFingerprint:'old-fingerprint', conflict:null,
    diagnosticsBaseline:{ [page.pageKey]:page },
    diagnosticsCurrent:{ [page.pageKey]:page }, diagnosticsRevision:0,
  };
  const sessionStore = {
    state, sessionPath:'/tmp/session.json',
    async persistState() {
      persistCalls += 1;
      if (persistCalls === 1) throw new Error('session persist failed');
    },
  };
  const bridge = new BridgeService({ sessionStore });
  const socket = {
    readyState:1,
    send(data) {
      const message = JSON.parse(data);
      if (message.type !== 'diagnose-pages') return;
      queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
        type:'diagnostics-result', commandId:message.commandId,
        revision:message.revision, pages:[page],
      })));
    },
  };
  bridge.setEditorSocket(socket);
  bridge.handleMessage(socket, JSON.stringify({
    type:'deck-ready', pages:[{ index:1, label:'测试页', pageKey:page.pageKey }], diagnostics:[page],
  }));

  await assert.rejects(
    bridge.writeDeck(0, {
      fingerprint:async () => diskFingerprint,
      writer:async () => {
        diskFingerprint = 'candidate-fingerprint';
        return {
          ok:true, fingerprint:'candidate-fingerprint', backup:'/tmp/backup.html',
        };
      },
      restore:async () => {
        diskFingerprint = 'third-party-fingerprint';
        throw Object.assign(new Error('Deck 恢复前已再次外改'), {
          code:'RESTORE_CONFLICT',
          statusCode:409,
          expectedFingerprint:'candidate-fingerprint',
          actualFingerprint:'third-party-fingerprint',
        });
      },
    }),
    error => error.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(diskFingerprint, 'third-party-fingerprint');
  assert.equal(state.deckFingerprint, 'old-fingerprint');
  assert.equal(state.conflict, null);
  assert.equal(persistCalls, 1);
  await assert.rejects(
    bridge.writeDeck(0, {
      fingerprint:async () => diskFingerprint,
      writer:async () => assert.fail('RECOVERY_REQUIRED 不得产生第二 candidate'),
      restore:async () => assert.fail('RECOVERY_REQUIRED 不得再次恢复'),
    }),
    error => error.code === 'RECOVERY_REQUIRED',
  );
});

test('初始诊断基线持久化失败不得在内存伪装成可保存基线', async () => {
  const page = {
    pageKey:'page-001-baseline-failure',
    sectionOverflow:{ x:0, y:0 },
    nestedClips:[],
  };
  const state = {
    revision:0, tasks:[], groups:[], redo:[], deckFingerprint:'old',
    diagnosticsBaseline:{}, diagnosticsCurrent:{}, diagnosticsRevision:null, conflict:null,
  };
  const sessionStore = {
    state,
    sessionPath:'/tmp/session.json',
    async persistState() { throw new Error('baseline persist failed'); },
  };
  const bridge = new BridgeService({ sessionStore });
  const socket = { readyState:1, send() {} };
  bridge.setEditorSocket(socket);
  bridge.handleMessage(socket, JSON.stringify({
    type:'deck-ready',
    pages:[{ index:1, label:'测试页', pageKey:page.pageKey }],
    diagnostics:[page],
  }));

  await assert.rejects(
    bridge.writeDeck(0, {
      fingerprint:async () => 'old',
      writer:async () => assert.fail('不得调用 writer'),
      restore:async () => {},
    }),
    error => error.code === 'DIAGNOSTICS_UNAVAILABLE' && error.stage === 'diagnostics',
  );
  assert.deepEqual(state.diagnosticsBaseline, {});
  assert.deepEqual(state.diagnosticsCurrent, {});
  assert.equal(state.diagnosticsRevision, null);
});

test('保存诊断超时、断线与显式拒绝统一返回 DIAGNOSTICS_UNAVAILABLE', async t => {
  for (const mode of ['timeout', 'disconnect', 'reject']) {
    await t.test(mode, async subtest => {
      const app = await makeApp(subtest, {
        deckContents:validBundle(), bridgeTimeoutMs:20,
      });
      const socket = await connect(app.editorWsUrl);
      subtest.after(() => socket.close());
      const page = {
        pageKey:'page-001-diagnostics-failure',
        sectionOverflow:{ x:0, y:0 }, nestedClips:[],
      };
      socket.on('message', data => {
        const message = JSON.parse(data);
        if (message.type !== 'diagnose-pages') return;
        if (mode === 'disconnect') socket.close();
        if (mode === 'reject') socket.send(JSON.stringify({
          type:'diagnostics-rejected', commandId:message.commandId, code:'NOT_READY',
        }));
      });
      socket.send(JSON.stringify({
        type:'deck-ready',
        pages:[{ index:1, label:'测试页', pageKey:page.pageKey }], diagnostics:[page],
      }));
      const deadline = Date.now() + 500;
      while (!Object.keys(app.session.diagnosticsBaseline ?? {}).length && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const deckBefore = await readFile(app.deckPath);
      const sessionBefore = await readFile(join(app.sessionDir, 'session.json'));

      const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ expectedRevision:0 }),
      });
      const body = await response.json();

      assert.equal(response.status, 409, `${mode}: ${JSON.stringify(body)}`);
      assert.equal(body.code, 'DIAGNOSTICS_UNAVAILABLE');
      assert.equal(body.stage, 'diagnostics');
      assert.match(body.recovery, /打开|重连|诊断/);
      assert.deepEqual(await readFile(app.deckPath), deckBefore);
      assert.deepEqual(await readFile(join(app.sessionDir, 'session.json')), sessionBefore);
      assert.equal(app.session.revision, 0);
      assert.deepEqual(app.session.groups, []);
    });
  }
});

test('动作命令超时仍保留 COMMAND_TIMEOUT 语义', async t => {
  const app = await makeApp(t, { bridgeTimeoutMs:20 });
  const socket = await connect(app.editorWsUrl);
  t.after(() => socket.close());
  socket.on('message', data => {
    const message = JSON.parse(data);
    if (message.type === 'rollback-actions') {
      socket.send(JSON.stringify({
        type:'actions-rolled-back', commandId:message.commandId, rolledBack:true,
      }));
    }
  });

  const response = await fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0, taskId:null, actions:[action] }),
  });
  const body = await response.json();

  assert.equal(response.status, 504, JSON.stringify(body));
  assert.equal(body.code, 'COMMAND_TIMEOUT');
  assert.equal(body.stage, undefined);
  assert.equal(app.session.revision, 0);
  assert.deepEqual(app.session.groups, []);
});

test('write-deck 超时终止子进程并映射稳定 504', async t => {
  const child = hangingChild();
  const app = await makeApp(t, {
    deckContents: validBundle(),
    writerTimeoutMs: 20,
    spawnWriter: () => child,
  });
  await connectDiagnosticsEditor(t, app);
  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0 }),
  });
  assert.equal(response.status, 504);
  const error = await response.json();
  assert.equal(error.error, 'WRITE_DECK_TIMEOUT');
  assert.equal(error.stage, 'adapter');
  assert.match(error.recovery, /重试|检查/);
  assert.equal(child.killed, true);
});

test('write-deck stdin 未 settle 的异步 EPIPE 映射稳定 5xx', async t => {
  const child = fakeWriterChild({
    onEnd: current => queueMicrotask(() => current.stdin.emit('error', epipe())),
  });
  const app = await makeApp(t, {
    deckContents: validBundle(),
    writerTimeoutMs: 1_000,
    spawnWriter: () => child,
  });
  await connectDiagnosticsEditor(t, app);
  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0 }),
  });
  assert.equal(response.status, 502);
  const error = await response.json();
  assert.equal(error.error, 'WRITE_DECK_IO_ERROR');
  assert.equal(error.stage, 'adapter');
  assert.match(error.recovery, /重试|检查/);
  assert.equal(child.killed, true);
});

test('write-deck timeout settle 后吸收 kill 引发的异步 EPIPE', async t => {
  const child = fakeWriterChild({
    onKill: current => queueMicrotask(() => current.stdin.emit('error', epipe())),
  });
  const app = await makeApp(t, {
    deckContents: validBundle(),
    writerTimeoutMs: 20,
    spawnWriter: () => child,
  });
  await connectDiagnosticsEditor(t, app);
  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0 }),
  });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error, 'WRITE_DECK_TIMEOUT');
  assert.equal(child.killed, true);
});

test('write-deck 卡住时 close 取消 child 和请求并在有界时间收敛', async t => {
  const child = hangingChild();
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const app = await makeApp(t, {
    deckContents: validBundle(),
    writerTimeoutMs: 10_000,
    spawnWriter: () => {
      signalStarted();
      return child;
    },
  });
  await connectDiagnosticsEditor(t, app);
  const responsePromise = fetch(`${app.url}/api/write-deck?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0 }),
  });
  const didStart = await Promise.race([
    started.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 50)),
  ]);
  assert.equal(didStart, true);

  const beforeClose = performance.now();
  await app.close();
  assert.ok(performance.now() - beforeClose < 500);
  const response = await responsePromise;
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'SERVICE_CLOSED');
  assert.equal(child.killed, true);
});

test('kill 后无 close 仍强制 finalize 并清空 active writer', async t => {
  const child = fakeWriterChild({ closesOnKill: false });
  const activeCounts = [];
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const app = await makeApp(t, {
    deckContents: validBundle(),
    writerTimeoutMs: 10_000,
    writerKillGraceMs: 20,
    onActiveWritersChange: count => activeCounts.push(count),
    spawnWriter: () => {
      signalStarted();
      return child;
    },
  });
  await connectDiagnosticsEditor(t, app);
  const responsePromise = fetch(`${app.url}/api/write-deck?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0 }),
  });
  await started;

  const beforeClose = performance.now();
  await app.close();
  assert.ok(performance.now() - beforeClose < 500);
  const response = await responsePromise;
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'SERVICE_CLOSED');
  assert.equal(child.killed, true);
  assert.equal(child.unrefCalled, true);
  assert.deepEqual(activeCounts, [1, 0]);
  assert.doesNotThrow(() => child.stdin.emit('error', epipe()));
});

test('close 关闭 WebSocket、HTTP 端口并拒绝未完成命令', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-server-close-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck');
  const app = await startServer({ deckPath: deck, host: '127.0.0.1', port: 0, token: 'secret' });
  const ws = await connect(app.editorWsUrl);
  const commandPromise = nextMessage(ws);
  const responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [action] }),
  });
  await commandPromise;

  const closedSocket = new Promise(resolve => ws.once('close', resolve));
  await app.close();
  await closedSocket;
  const response = await responsePromise;
  assert.equal(response.status, 503);
  await assert.rejects(() => fetch(`${app.url}/api/session?token=secret`));

  const restarted = await startServer({
    deckPath:deck, host:'127.0.0.1', port:0, openBrowser:false, token:'secret',
  });
  try {
    const session = await fetch(`${restarted.url}/api/session?token=secret`).then(value => value.json());
    assert.equal(session.revision, 0);
    assert.deepEqual(session.groups, []);
  } finally {
    await restarted.close();
  }
});

test('桌面模式在编辑器页面关闭后自动回收本地服务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-server-app-close-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck');
  const app = await startServer({
    deckPath:deck,
    host:'127.0.0.1',
    port:0,
    token:'secret',
    editorToken:'editor-secret',
    exitWhenEditorCloses:true,
    editorCloseGraceMs:10,
  });
  const editor = await connect(app.editorWsUrl);
  await new Promise(resolve => {
    editor.once('close', resolve);
    editor.close();
  });
  const deadline = Date.now() + 1_000;
  let stopped = false;
  while (!stopped && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
    stopped = await fetch(`${app.url}/api/session?token=secret`)
      .then(() => false, () => true);
  }
  assert.equal(stopped, true);
  await app.close();
});

test('历史冲突覆盖任务上残留的目标待确认提示，并广播实际失败原因', async t => {
  const app = await makeApp(t);
  const created = await createTask(app);
  const taskId = created.task.id;
  // 恢复已有待确认任务，随后精确定位成功但实际页面值与时间线不一致。
  app.session.tasks[0].status = 'needs-confirmation';
  app.session.tasks[0].candidates = [{path:'旧候选'}];
  await connectCanonicalActionEditor(t,app);
  const submit = body => fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
  });
  const first = await submit({expectedRevision:1,taskId:null,actions:[action]});
  assert.equal(first.status,200);
  const revision=(await first.json()).revision;
  const failed = await submit({expectedRevision:revision,taskId,actions:[{
    ...action,id:'history-conflict',taskId,payload:{text:'再修改'},after:'再修改',
  }]});
  assert.equal(failed.status,409);
  assert.equal((await failed.json()).error,'HISTORY_DIVERGED');
  const task=app.session.tasks.find(item=>item.id===taskId);
  assert.equal(task.status,'failed');
  assert.deepEqual(task.candidates,[]);
  assert.equal(task.lastError.code,'HISTORY_DIVERGED');
  assert.equal(app.session.groups.length,1);
  assert.equal(app.session.revision,revision+1);
});

test('真实源码提交记录文字覆盖证据，旧样式保留且结构撤销恢复旧动作', async t => {
  const {compileActionGroups}=await import('../action-compiler.mjs');
  const app=await makeApp(t,{deckContents:managedBundle(),managedWorkingDeck:true,workingPatchVerifier:async()=>({ok:true})});
  await connectCanonicalActionEditor(t,app);
  const before=await readFile(app.workingDeckPath,'utf8');
  const template=JSON.parse(before.match(/<script type="__bundler\/template">\s*([\s\S]*?)\s*<\/script>/)[1]);
  const editorId=template.match(/<h1[^>]*data-editor-id="([^"]+)"/)[1];
  const pageKey=template.match(/data-page-id="([^"]+)"/)[1];
  const target={pageKey,editorId,tag:'H1',path:'0',fingerprint:'1234abcd'};
  const post=(path,body)=>fetch(`${app.url}${path}?token=secret`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  let response=await post('/api/actions',{expectedRevision:0,taskId:null,actions:[
    {...action,id:'old-title',target},
    {id:'independent-style',taskId:null,target,kind:'setStyle',payload:{property:'color',value:'black'},before:'',after:'black'},
  ]});
  assert.equal(response.status,200);
  response=await post('/api/source-edits',{expectedRevision:app.session.revision});
  assert.equal(response.status,201);
  const reserved=await response.json();
  await writeFile(app.workingDeckPath,before.replace('旧文案','源码里的新标题'));
  response=await post(`/api/source-edits/${reserved.sourceEditId}/commit`,{expectedRevision:reserved.revision});
  const committed=await response.json();
  assert.equal(response.status,200,JSON.stringify(committed));
  assert.equal(app.session.groups.at(-1).source.actionReconciliation.supersededKeys.length,1);
  assert.deepEqual(compileActionGroups(app.session.groups).map(a=>a.id),['independent-style']);
  response=await post(`/api/groups/${committed.groupId}/undo`,{expectedRevision:committed.revision});
  assert.equal(response.status,200,await response.text());
  assert.deepEqual(compileActionGroups(app.session.groups).map(a=>a.id),['old-title','independent-style']);
});

test('源码提交会重放未固化动作；失败时恢复工作副本且不增加历史', async t=>{
  let rejectCandidate=false;
  const app=await makeApp(t,{deckContents:managedBundle(),managedWorkingDeck:true,
    workingPatchVerifier:async path=>{
      const bytes=await readFile(path,'utf8');
      if(rejectCandidate && bytes.includes('pending-resize'))throw Object.assign(new Error('尺寸目标冲突'),{
        code:'PATCH_REPLAY_FAILED',statusCode:409,replayCode:'TARGET_AMBIGUOUS',failedActionId:'pending-resize',stage:'patch-replay'});
      return {ok:true};
    }});
  await connectCanonicalActionEditor(t,app);
  const before=await readFile(app.workingDeckPath,'utf8');
  const template=JSON.parse(before.match(/<script type="__bundler\/template">\s*([\s\S]*?)\s*<\/script>/)[1]);
  const editorId=template.match(/<h1[^>]*data-editor-id="([^"]+)"/)[1];
  const pageKey=template.match(/data-page-id="([^"]+)"/)[1];
  const post=(path,body)=>fetch(`${app.url}${path}?token=secret`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  let response=await post('/api/actions',{expectedRevision:0,taskId:null,actions:[{
    id:'pending-resize',taskId:null,target:{pageKey,editorId,tag:'H1',path:'0',fingerprint:'1234abcd'},kind:'resize',
    payload:{width:400,height:100},before:{width:300,height:100},after:{width:400,height:100}}]});
  assert.equal(response.status,200,await response.text());
  response=await post('/api/source-edits',{expectedRevision:app.session.revision});
  const reserved=await response.json();
  const count=app.session.groups.length;
  rejectCandidate=true;
  await writeFile(app.workingDeckPath,before.replace('旧文案','结构改写'));
  response=await post(`/api/source-edits/${reserved.sourceEditId}/commit`,{expectedRevision:reserved.revision});
  const failure=await response.json();
  assert.equal(response.status,409,JSON.stringify(failure));
  assert.equal(failure.failedActionId,'pending-resize');
  assert.equal(failure.targetSummary.kind,'resize');
  assert.equal(app.session.groups.length,count);
  assert.equal(await readFile(app.workingDeckPath,'utf8'),before);
  assert.equal(await readFile(app.deckPath,'utf8'),managedBundle());
});

test('纯 verify 不写历史或 Deck；命令查询复用回执，伪造源码证据被拒绝',async t=>{
  const inspected=[];
  const app=await makeApp(t,{deckContents:managedBundle(),managedWorkingDeck:true,
    workingPatchVerifier:async path=>{inspected.push(await readFile(path,'utf8'));return {ok:true};}});
  await connectCanonicalActionEditor(t,app);
  const post=(path,body)=>fetch(`${app.url}${path}?token=secret`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const commandId='11111111-1111-4111-a111-111111111111';
  let response=await post('/api/actions',{expectedRevision:0,commandId,taskId:null,actions:[action]});
  assert.equal(response.status,200,await response.text());
  const session=JSON.stringify(app.session), bytes=await readFile(app.workingDeckPath,'utf8');
  response=await post('/api/verify',{});
  const verified=await response.json();
  assert.equal(response.status,200,JSON.stringify(verified));
  assert.equal(verified.scope,'full-history-replay');
  assert.ok(inspected.at(-1).includes('action-1'));
  assert.equal(JSON.stringify(app.session),session);
  assert.equal(await readFile(app.workingDeckPath,'utf8'),bytes);
  assert.equal(await readFile(app.deckPath,'utf8'),managedBundle());
  const receipt=await(await fetch(`${app.url}/api/commands/${commandId}?token=secret`)).json();
  assert.equal(receipt.committed,true);
  response=await post('/api/actions',{expectedRevision:app.session.revision,taskId:null,actions:[{...action,id:'forged',sourceResizeStyle:''}]});
  assert.equal(response.status,400);
});
