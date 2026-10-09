import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer as createHttpServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { startAppServer } from '../app-server.mjs';
import { createRecentDeckStore } from '../recent-deck-store.mjs';
import { createWorkHistoryStore } from '../work-history-store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVER = join(ROOT, 'scripts/editor/server.mjs');
const CLI = join(ROOT, 'scripts/editor/cli.mjs');

const action = {
  id: 'action-cli-1',
  taskId: 'task-placeholder',
  target: { pageKey: 'page-001-cli', path: '0/1' },
  kind: 'setText',
  payload: { text: '新文案' },
  before: '旧文案',
  after: '新文案',
};

function collectProcess(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

function spawnCli(args) {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { child, result: collectProcess(child) };
}

function spawnCliWithEnv(args, environment) {
  const child = spawn(process.execPath, [CLI, ...args], {
    stdio:['ignore', 'pipe', 'pipe'],
    env:{ ...process.env, ...environment },
  });
  return { child, result:collectProcess(child) };
}

async function runCli(args) {
  return spawnCli(args).result;
}

function firstLine(stream, child) {
  stream.setEncoding('utf8');
  return new Promise((resolvePromise, reject) => {
    let buffered = '';
    // 首次 Python/侧车初始化在 Windows 挂载盘上可能超过 5 秒；
    // 与运行时启动预算一致，仍保留有界失败和监听器清理。
    const timer = setTimeout(() => { cleanup(); reject(new Error('等待 server ready JSON 超时')); }, 30_000);
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
      child.off('exit', onExit);
    };
    const onData = chunk => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      cleanup();
      resolvePromise(buffered.slice(0, newline));
    };
    const onExit = code => {
      cleanup();
      reject(new Error(`server 在 ready 前退出：${code}`));
    };
    stream.on('data', onData);
    child.once('exit', onExit);
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise(resolvePromise => {
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
}

async function startServerProcess(t) {
  const root = await mkdtemp(join(tmpdir(), 'deck-editor-cli-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, '<!doctype html><title>CLI test</title>');
  const child = spawn(process.execPath, [
    SERVER, deck, '--host', '127.0.0.1', '--port', '0', '--no-open', '--no-agent-autostart',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await waitForExit(child);
    }
    await rm(root, { recursive: true, force: true });
  });
  const ready = JSON.parse(await firstLine(child.stdout, child));
  return { child, ready, root };
}

function connect(url) {
  const socket = new WebSocket(url);
  return new Promise((resolvePromise, reject) => {
    socket.once('open', () => resolvePromise(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket) {
  return new Promise((resolvePromise, reject) => {
    const onMessage = data => {
      socket.off('error', onError);
      resolvePromise(JSON.parse(data));
    };
    const onError = error => {
      socket.off('message', onMessage);
      reject(error);
    };
    socket.once('message', onMessage);
    socket.once('error', onError);
  });
}

async function prepareAndCommit(socket, command) {
  socket.send(JSON.stringify({
    type: 'actions-prepared', commandId: command.commandId,
    applied: command.actions.length, results: command.actions,
  }));
  const commit = await nextMessage(socket);
  assert.equal(commit.type, 'commit-actions');
  assert.equal(commit.commandId, command.commandId);
  socket.send(JSON.stringify({
    type: 'actions-committed', commandId: command.commandId, committed: true,
  }));
}

function parseJsonOutput(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('creation CLI 从受控 capability 文件读取凭据并提交统一 CreationCommand', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-creation-cli-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const capability = join(root, 'capability.json');
  const payload = join(root, 'brief.json');
  await writeFile(capability, JSON.stringify({ version:1, scope:'creation-draft', token:'creation-secret' }));
  await writeFile(payload, JSON.stringify({
    expectedRevision:4,
    patch:{ title:'CLI 新建 Deck' },
  }));
  const received = [];
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({
      method:request.method,
      url:request.url,
      authorization:request.headers.authorization,
      body:chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
    });
    response.writeHead(200, { 'content-type':'application/json' });
    response.end(JSON.stringify(request.method === 'GET'
      ? request.url === '/api/creation-draft/templates'
        ? { version:2, templates:[{ templateId:'tech-share' }] }
        : { draftId:'draft-cli', revision:4, phase:'brief' }
      : { revision:5, snapshot:{ revision:5, brief:{ title:'CLI 新建 Deck' } } }));
  });
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => new Promise(resolvePromise => server.close(resolvePromise)));
  const address = server.address();
  const environment = {
    AICO_PPT_CREATION_URL:`http://127.0.0.1:${address.port}`,
    AICO_PPT_CREATION_CAPABILITY_FILE:capability,
  };
  const status = parseJsonOutput(await spawnCliWithEnv(['creation', 'status'], environment).result);
  assert.equal(status.revision, 4);
  const templates = parseJsonOutput(await spawnCliWithEnv(['creation', 'templates'], environment).result);
  assert.equal(templates.templates[0].templateId, 'tech-share');
  const updated = parseJsonOutput(await spawnCliWithEnv([
    'creation', 'update-brief', '--json', payload,
  ], environment).result);
  assert.equal(updated.revision, 5);
  assert.equal(received.length, 3);
  assert.equal(received[0].authorization, 'Bearer creation-secret');
  assert.equal(received[1].url, '/api/creation-draft/templates');
  assert.equal(received[2].body.type, 'update-brief');
  assert.equal(received[2].body.expectedRevision, 4);
  const explicit = await spawnCliWithEnv([
    'creation', 'status', '--url', environment.AICO_PPT_CREATION_URL, '--token', 'creation-secret',
  ], {}).result;
  assert.equal(parseJsonOutput(explicit).revision, 4);

});

test('DSH 创建 CLI 仅凭文件连接真实 Draft，并在恢复后使用新端口与凭据', async t => {
  const root = await mkdtemp(join(tmpdir(), "creation-capability-$`' 空格-"));
  t.after(() => rm(root, { recursive:true, force:true }));
  const recentDeckStore = createRecentDeckStore({ filePath:join(root, 'recent.json') });
  const workHistoryStore = createWorkHistoryStore({
    filePath:join(root, 'history.json'), discoveryRoots:[root], recentDeckStore,
  });
  const start = () => startAppServer({
    embeddedMode:'dsh', recentDeckStore, workHistoryStore,
    pickAgentProjectDirectory:async () => root,
  });
  let app = await start();
  t.after(() => app.close());
  const post = async (path, body = {}) => {
    const response = await fetch(app.url + path + '?token=' + encodeURIComponent(app.token), {
      method:'POST', headers:{ origin:app.url, 'content-type':'application/json' },
      body:JSON.stringify(body),
    });
    assert.equal(response.ok, true);
    return response.json();
  };
  const selected = await post('/api/choose-creation-project');
  const created = await post('/api/creation-drafts', {
    candidateNonce:selected.candidateNonce, selectionRevision:selected.selectionRevision, provider:'codex',
  });
  const capabilityPath = join(root, '.aico-ppt-editor', 'drafts', created.draft.draftId, 'agent-capability.json');
  const cleanEnvironment = Object.fromEntries(Object.keys(process.env)
    .filter(key => /^(AICO_PPT|HUAWEI_DECK)_CREATION_/.test(key)).map(key => [key, undefined]));
  const invoke = () => spawnCliWithEnv(['creation', 'status', '--capability-file', capabilityPath], cleanEnvironment).result;
  const initial = parseJsonOutput(await invoke());
  assert.equal(initial.draftId, created.draft.draftId);
  const statusCommand = created.dshPrompt.split('\n').find(line => line.startsWith('node ') && line.includes(' creation status'));
  assert.ok(statusCommand);
  const shellProcess = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-Command', statusCommand], { env:{ ...process.env, ...cleanEnvironment }, stdio:['ignore', 'pipe', 'pipe'] })
    : spawn('/bin/sh', ['-c', statusCommand], { env:{ ...process.env, ...cleanEnvironment }, stdio:['ignore', 'pipe', 'pipe'] });
  assert.equal(parseJsonOutput(await collectProcess(shellProcess)).draftId, created.draft.draftId);

  const before = JSON.parse(await readFile(capabilityPath, 'utf8'));
  assert.equal(before.url, app.url);
  assert.equal(created.dshPrompt.includes('--capability-file'), true);
  assert.equal(created.dshPrompt.includes(before.token), false);
  await app.close();
  app = await start();
  assert.notEqual(app.url, before.url);
  const resumed = await post('/api/resume-creation-draft', { projectRoot:root, draftId:created.draft.draftId });
  const after = JSON.parse(await readFile(capabilityPath, 'utf8'));
  assert.equal(after.url, app.url);
  assert.notEqual(after.token, before.token);
  if (process.platform !== 'win32') assert.equal((await stat(capabilityPath)).mode & 0o777, 0o600);
  assert.equal(resumed.dshPrompt.includes('--capability-file'), true);
  const result = await invoke();
  assert.equal(parseJsonOutput(result).draftId, created.draft.draftId);
  assert.equal((result.stdout + result.stderr).includes(after.token), false);
  await writeFile(capabilityPath, JSON.stringify({ ...after, url:'https://example.com' }));
  const rejected = await invoke();
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /loopback/);
  assert.equal((rejected.stdout + rejected.stderr).includes(after.token), false);
  await writeFile(capabilityPath, JSON.stringify(after));
  const override = await spawnCliWithEnv([
    'creation', 'status', '--capability-file', capabilityPath, '--url', 'https://example.com',
  ], cleanEnvironment).result;
  assert.notEqual(override.code, 0);
  assert.match(override.stderr, /loopback/);
  const redirectServer = createHttpServer((request, response) => {
    response.writeHead(302, { location:app.url + '/api/creation-draft' });
    response.end();
  });
  await new Promise(resolvePromise => redirectServer.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => new Promise(resolvePromise => redirectServer.close(resolvePromise)));
  await writeFile(capabilityPath, JSON.stringify({
    ...after, url:`http://127.0.0.1:${redirectServer.address().port}`,
  }));
  const redirected = await invoke();
  assert.notEqual(redirected.code, 0, '携带凭据的 CLI 不得跟随重定向');
  assert.equal((redirected.stdout + redirected.stderr).includes(after.token), false);

});

test('Managed Workspace CLI 支持环境变量、capability 与显式 verify/solidify/redo', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-workspace-cli-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const received = [];
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({
      method:request.method,
      url:request.url,
      authorization:request.headers.authorization,
      body:chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
    });
    response.writeHead(200, { 'content-type':'application/json' });
    if (request.method === 'GET') response.end(JSON.stringify({ revision:9, groups:[] }));
    else if (request.url === '/api/solidify-preflight') {
      response.end(JSON.stringify({
        revision:9, preflightToken:'preflight-cli', bindingRevision:4,
      }));
    } else response.end(JSON.stringify({ revision:10, ok:true }));
  });
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => new Promise(resolvePromise => server.close(resolvePromise)));
  const url = `http://127.0.0.1:${server.address().port}`;

  const fromEnvironment = parseJsonOutput(await spawnCliWithEnv(['status'], {
    AICO_PPT_EDITOR_URL:url,
    AICO_PPT_EDITOR_TOKEN:'environment-secret',
    AICO_PPT_WORKSPACE_CAPABILITY_FILE:'',
  }).result);
  assert.equal(fromEnvironment.revision, 9);
  assert.equal(received.at(-1).authorization, 'Bearer environment-secret');

  const capability = join(root, 'workspace-capability.json');
  await writeFile(capability, JSON.stringify({
    version:1, scope:'managed-deck-workspace', url, token:'capability-secret',
  }));
  parseJsonOutput(await spawnCliWithEnv([
    '--capability-file', capability, '--expected-revision', '7', 'verify',
  ], {
    AICO_PPT_EDITOR_URL:'', AICO_PPT_EDITOR_TOKEN:'',
    AICO_PPT_WORKSPACE_CAPABILITY_FILE:'',
  }).result);
  assert.equal(received.at(-1).url, '/api/verify');
  assert.deepEqual(received.at(-1).body, { expectedRevision:7 });
  assert.equal(received.at(-1).authorization, 'Bearer capability-secret');

  const beforeSolidify = received.length;
  parseJsonOutput(await spawnCliWithEnv(['solidify'], {
    AICO_PPT_EDITOR_URL:url,
    AICO_PPT_EDITOR_TOKEN:'environment-secret',
    AICO_PPT_WORKSPACE_CAPABILITY_FILE:'',
  }).result);
  assert.deepEqual(received.slice(beforeSolidify).map(item => item.url), [
    '/api/session', '/api/solidify-preflight', '/api/solidify-deck',
  ]);
  assert.deepEqual(received.at(-1).body, {
    expectedRevision:9, expectedBindingRevision:4, preflightToken:'preflight-cli',
  });

  parseJsonOutput(await spawnCliWithEnv([
    '--url', url, '--token', 'explicit-secret', '--expected-revision', '11',
    'redo', 'group-1',
  ], {}).result);
  assert.equal(received.at(-1).url, '/api/groups/group-1/redo');
  assert.deepEqual(received.at(-1).body, { expectedRevision:11 });

  parseJsonOutput(await spawnCliWithEnv([
    '--url', url, '--token', 'explicit-secret', '--expected-revision', '12',
    'begin-source-task', 'task-structure-1',
  ], {}).result);
  assert.equal(received.at(-1).url, '/api/source-edits');
  assert.deepEqual(received.at(-1).body, {
    expectedRevision:12, taskId:'task-structure-1',
  });

  parseJsonOutput(await spawnCliWithEnv([
    '--url', url, '--token', 'explicit-secret', '--expected-revision', '13',
    'begin-source-edit',
  ], {}).result);
  assert.equal(received.at(-1).url, '/api/source-edits');
  assert.deepEqual(received.at(-1).body, { expectedRevision:13, taskId:null });

  parseJsonOutput(await spawnCliWithEnv([
    '--url', url, '--token', 'explicit-secret', '--expected-revision', '14',
    'commit-source-edit', 'source-edit-1',
  ], {}).result);
  assert.equal(received.at(-1).url, '/api/source-edits/source-edit-1/commit');
  assert.deepEqual(received.at(-1).body, { expectedRevision:14 });

  parseJsonOutput(await spawnCliWithEnv([
    '--url', url, '--token', 'explicit-secret', '--expected-revision', '15',
    'cancel-source-edit', 'source-edit-1',
  ], {}).result);
  assert.equal(received.at(-1).url, '/api/source-edits/source-edit-1/cancel');
  assert.deepEqual(received.at(-1).body, { expectedRevision:15 });

  parseJsonOutput(await spawnCliWithEnv([
    '--url', url, '--token', 'explicit-secret', '--expected-revision', '12',
    'cancel-source-task', 'task-structure-1',
  ], {}).result);
  assert.equal(received.at(-1).url, '/api/tasks/task-structure-1/source-edit/cancel');
  assert.deepEqual(received.at(-1).body, { expectedRevision:12 });
});

test('server CLI 输出 ready JSON、保持运行并响应 SIGINT/SIGTERM', {
  skip:process.platform === 'win32' ? 'Windows 没有 POSIX SIGINT/SIGTERM 退出语义' : false,
}, async t => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    await t.test(signal, async t => {
      const { child, ready } = await startServerProcess(t);
      assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(typeof ready.token, 'string');
      assert.match(ready.editorUrl, /^http:\/\/127\.0\.0\.1:\d+\/editor\//);
      assert.equal(ready.mode, 'visible-editor');
      assert.equal(JSON.parse(await readFile(ready.capabilityPath, 'utf8')).scope,
        'managed-deck-workspace');
      const editorUrl = new URL(ready.editorUrl);
      assert.equal(editorUrl.searchParams.get('token'), ready.token);
      assert.ok(editorUrl.searchParams.get('editorToken'));
      assert.equal(child.exitCode, null);
      assert.equal((await fetch(`${ready.url}/api/session`, {
        headers: { authorization: `Bearer ${ready.token}` },
      })).status, 200);

      child.kill(signal);
      const exit = await waitForExit(child);
      assert.deepEqual(exit, { code: 0, signal: null });
      await assert.rejects(() => fetch(`${ready.url}/api/session`));
      await assert.rejects(() => readFile(ready.capabilityPath, 'utf8'), { code:'ENOENT' });
    });
  }
});

test('Agent CLI 经真实服务完成 revision/status/tasks/task/apply/undo', async t => {
  const { ready } = await startServerProcess(t);
  const common = ['--url', ready.url, '--token', ready.token];

  const form = new FormData();
  form.append('task', new Blob([JSON.stringify({
      expectedRevision: 0,
      pageKey: 'page-001-cli',
      pageIndex: 1,
      pageLabel: 'CLI',
      rect: { x: 1, y: 2, w: 3, h: 4 },
      instruction: '通过 CLI 修改',
      attachmentSources:['selected'],
    })], { type:'application/json' }), 'task.json');
  form.append('attachment', new Blob([Buffer.from('CLI attachment')], {
    type:'text/plain',
  }), '说明.txt');
  const createdResponse = await fetch(`${ready.url}/api/tasks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ready.token}` },
    body: form,
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const taskId = created.task.id;

  const status = parseJsonOutput(await runCli([...common, 'status']));
  assert.equal(status.revision, 1);
  assert.equal(Object.hasOwn(status.tasks[0].attachments[0], 'path'), false);
  assert.deepEqual(parseJsonOutput(await runCli([...common, 'revision'])), { revision:1 });
  const listedTask = parseJsonOutput(await runCli([...common, 'tasks']))[0];
  const detailedTask = parseJsonOutput(await runCli([...common, 'task', taskId]));
  assert.equal(listedTask.id, taskId);
  assert.equal(detailedTask.id, taskId);
  assert.equal(listedTask.attachments[0].path, detailedTask.attachments[0].path);
  assert.equal(await readFile(detailedTask.attachments[0].path, 'utf8'), 'CLI attachment');

  const editorUrl = new URL(ready.editorUrl);
  const editorSocketUrl = new URL('/events', ready.url);
  editorSocketUrl.protocol = 'ws:';
  editorSocketUrl.searchParams.set('token', ready.token);
  editorSocketUrl.searchParams.set('editorToken', editorUrl.searchParams.get('editorToken'));
  const editor = await connect(editorSocketUrl);
  t.after(() => editor.close());

  const root = await mkdtemp(join(tmpdir(), 'deck-editor-actions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actionsPath = join(root, 'actions.json');
  await writeFile(actionsPath, JSON.stringify({
    expectedRevision: 1,
    taskId,
    actions: [{ ...action, taskId }],
  }));

  const applyCommand = nextMessage(editor);
  const apply = spawnCli([...common, 'apply', actionsPath]);
  const applyMessage = await applyCommand;
  assert.equal(applyMessage.type, 'apply-actions');
  await prepareAndCommit(editor, applyMessage);
  const applied = parseJsonOutput(await apply.result);
  assert.equal(applied.revision, 2);
  assert.equal(typeof applied.groupId, 'string');

  const undoCommand = nextMessage(editor);
  const undo = spawnCli([...common, 'undo', applied.groupId]);
  const undoMessage = await undoCommand;
  assert.equal(undoMessage.type, 'apply-actions');
  await prepareAndCommit(editor, undoMessage);
  assert.equal(parseJsonOutput(await undo.result).revision, 3);
});

test('Agent CLI 对被 outside symlink 替换的附件目标 fail-closed', async t => {
  const { ready, root } = await startServerProcess(t);
  const common = ['--url', ready.url, '--token', ready.token];
  const form = new FormData();
  form.append('task', new Blob([JSON.stringify({
    expectedRevision:0,
    pageKey:'page-001-cli-symlink', pageIndex:1, pageLabel:'CLI',
    rect:{ x:1, y:2, w:3, h:4 }, instruction:'安全验证',
    attachmentSources:['selected'],
  })], { type:'application/json' }), 'task.json');
  form.append('attachment', new Blob([Buffer.from('trusted')]), 'trusted.txt');
  const response = await fetch(`${ready.url}/api/tasks`, {
    method:'POST', headers:{ authorization:`Bearer ${ready.token}` }, body:form,
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  const taskDirectory = dirname(created.task.attachments[0].path);
  const outside = join(root, 'outside-cli');
  await rename(taskDirectory, `${taskDirectory}.trusted`);
  await mkdir(outside);
  await writeFile(join(outside, basename(created.task.attachments[0].path)), 'outside');
  try {
    await symlink(outside, taskDirectory, 'dir');
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') {
      t.skip('Windows 未启用开发者模式，无法创建目录符号链接');
      return;
    }
    throw error;
  }

  for (const command of [
    [...common, 'tasks'],
    [...common, 'task', created.task.id],
  ]) {
    const result = await runCli(command);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    const error = JSON.parse(result.stderr);
    assert.equal(error.code, 'UNSAFE_SIDECAR_IO');
  }
  assert.equal(
    await readFile(join(outside, basename(created.task.attachments[0].path)), 'utf8'),
    'outside',
  );
});

test('apply 数组经真实服务以 taskId null 记录未关联动作组', async t => {
  const { ready } = await startServerProcess(t);
  const common = ['--url', ready.url, '--token', ready.token];
  const editorUrl = new URL(ready.editorUrl);
  const editorSocketUrl = new URL('/events', ready.url);
  editorSocketUrl.protocol = 'ws:';
  editorSocketUrl.searchParams.set('token', ready.token);
  editorSocketUrl.searchParams.set('editorToken', editorUrl.searchParams.get('editorToken'));
  const editor = await connect(editorSocketUrl);
  t.after(() => editor.close());

  const root = await mkdtemp(join(tmpdir(), 'deck-editor-array-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actionsPath = join(root, 'actions.json');
  await writeFile(actionsPath, JSON.stringify([{ ...action, taskId: null }]));

  const commandPromise = nextMessage(editor).then(message => ({ type: 'command', message }));
  const apply = spawnCli([...common, 'apply', actionsPath]);
  const resultPromise = apply.result.then(result => ({ type: 'result', result }));
  const first = await Promise.race([commandPromise, resultPromise]);
  assert.equal(first.type, 'command', first.result?.stderr);
  assert.equal(first.message.type, 'apply-actions');
  await prepareAndCommit(editor, first.message);
  const applied = parseJsonOutput((await resultPromise).result);
  assert.equal(applied.revision, 1);
  assert.equal(typeof applied.groupId, 'string');

  const session = parseJsonOutput(await runCli([...common, 'status']));
  assert.equal(session.revision, 1);
  assert.equal(session.groups[0].id, applied.groupId);
  assert.equal(session.groups[0].taskId, null);
});

test('actions API 拒绝缺失、空字符串或非字符串 taskId', async t => {
  const { ready } = await startServerProcess(t);
  const headers = {
    authorization: `Bearer ${ready.token}`,
    'content-type': 'application/json',
  };
  for (const taskId of [undefined, '', 0, false, {}, []]) {
    const body = { expectedRevision: 0, actions: [action] };
    if (taskId !== undefined) body.taskId = taskId;
    const response = await fetch(`${ready.url}/api/actions`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    assert.equal(response.status, 400, `taskId=${JSON.stringify(taskId)}`);
    assert.equal((await response.json()).error, 'INVALID_INPUT');
  }
});

test('replace-text 先唯一定位文字节点再提交同一 actions API', async t => {
  const received = [];
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ method:request.method, url:request.url, body:chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null });
    response.writeHead(200, { 'content-type':'application/json' });
    if (request.url.startsWith('/api/text-locations')) {
      response.end(JSON.stringify({
        revision:7,
        results:[{
          pageKey:'page-' + 'a'.repeat(32), pageIndex:1, pageLabel:'封面',
          target:{
            pageKey:'page-' + 'a'.repeat(32), path:'0/1', tag:'H1',
            fingerprint:'1234abcd', textPath:'0', rect:{ x:1, y:2, w:3, h:4 },
          },
          text:'旧标题文字', occurrences:1,
        }],
      }));
    } else {
      response.end(JSON.stringify({ revision:8, groupId:'group-text' }));
    }
  });
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => new Promise(resolvePromise => server.close(resolvePromise)));
  const common = [
    '--url', `http://127.0.0.1:${server.address().port}`, '--token', 'secret',
  ];
  const result = parseJsonOutput(await runCli([
    ...common, 'replace-text', '旧标题', '新标题',
  ]));
  assert.equal(result.revision, 8);
  assert.equal(received[0].method, 'GET');
  assert.equal(new URL(received[0].url, 'http://local').searchParams.get('text'), '旧标题');
  assert.equal(received[1].method, 'POST');
  assert.equal(received[1].body.expectedRevision, 7);
  assert.equal(received[1].body.taskId, null);
  assert.equal(received[1].body.actions[0].kind, 'setText');
  assert.equal(received[1].body.actions[0].payload.text, '新标题文字');
  assert.equal(received[1].body.actions[0].target.textPath, '0');
});

test('浏览器打开命令始终使用参数数组且 win32 不经过命令解释器', async () => {
  const { buildOpenCommand } = await import('../server.mjs');
  const editorUrl = 'http://127.0.0.1:3210/editor/?token=a&editorToken=b';
  assert.deepEqual(buildOpenCommand('darwin', editorUrl), {
    command: 'open', args: [editorUrl],
  });
  assert.deepEqual(buildOpenCommand('linux', editorUrl), {
    command: 'xdg-open', args: [editorUrl],
  });
  assert.deepEqual(buildOpenCommand('win32', editorUrl), {
    command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', editorUrl],
  });
});

test('Agent CLI 区分 HTTP 失败 exit 1 与参数/文件/JSON错误 exit 2', async t => {
  const { ready } = await startServerProcess(t);
  const common = ['--url', ready.url, '--token', ready.token];
  const notFound = await runCli([...common, 'task', 'missing']);
  assert.equal(notFound.code, 1);
  assert.equal(notFound.stdout, '');
  assert.equal(JSON.parse(notFound.stderr).error, 'TASK_NOT_FOUND');

  const root = await mkdtemp(join(tmpdir(), 'deck-editor-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const invalidJson = join(root, 'invalid.json');
  await writeFile(invalidJson, '{not-json');
  for (const args of [
    [...common, 'apply', join(root, 'missing.json')],
    [...common, 'apply', invalidJson],
    [...common, 'task'],
  ]) {
    const result = await runCli(args);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.equal(typeof JSON.parse(result.stderr).error, 'string');
  }
});

test('Agent CLI help 是 JSON 且列出固定命令', async () => {
  const help = parseJsonOutput(await runCli(['--help']));
  assert.deepEqual(help.commands, [
    'inspect TASK_ID OUT.png', 'view PAGE OUT.png', 'result COMMAND_ID', 'revision', 'status', 'tasks', 'task', 'locate-text', 'replace-text',
    'apply', 'begin-source-edit', 'begin-source-task',
    'commit-source-edit', 'cancel-source-edit', 'cancel-source-task',
    'undo', 'redo', 'verify', 'solidify', 'creation ...',
  ]);
});
