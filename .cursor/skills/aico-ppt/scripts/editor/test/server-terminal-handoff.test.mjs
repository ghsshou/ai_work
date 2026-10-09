import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentTerminalSession } from '../agent-terminal-session.mjs';
import { startServer } from '../server.mjs';

class FakePty {
  constructor(executable, args, options, pid) {
    this.executable = executable;
    this.args = args;
    this.options = options;
    this.pid = pid;
    this.events = new EventEmitter();
  }
  onData(listener) { this.events.on('data', listener); return { dispose() {} }; }
  onExit(listener) { this.events.on('exit', listener); return { dispose() {} }; }
  write() {}
  resize() {}
  kill() { this.events.emit('exit', { exitCode:0, signal:null }); }
}

class HandoffTerminal {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.runtimeId = 'handoff-runtime';
    this.stateListeners = new Set();
    this.providerListeners = new Set();
    this.environment = {};
    this.prompts = [];
    this.closed = false;
  }
  snapshot() {
    return {
      runtimeId:this.runtimeId, projectRoot:this.projectRoot, provider:'codex',
      providerLabel:'Codex', state:'running', command:'codex', pid:123,
      startedAt:'2026-08-11T00:00:00.000Z', exit:null,
    };
  }
  attach(socket) { socket.send(JSON.stringify({ type:'snapshot', terminal:this.snapshot(), output:'之前的对话' })); return () => {}; }
  addStateListener(listener) { this.stateListeners.add(listener); return () => this.stateListeners.delete(listener); }
  addProviderChangeListener(listener) { this.providerListeners.add(listener); return () => this.providerListeners.delete(listener); }
  updateEnvironment(patch) { Object.assign(this.environment, patch); }
  submitPrompt(prompt) { this.prompts.push(prompt); }
  input() {}
  resize() {}
  async start() { return this.snapshot(); }
  async restart() { return this.snapshot(); }
  async close() { this.closed = true; }
}

test('Editor Server 接管同一个 AgentTerminalSession，不创建第二个 PTY', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-editor-handoff-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const projectRoot = await realpath(root);
  const deckPath = join(projectRoot, 'deck.html');
  await writeFile(deckPath, '<!doctype html><title>handoff</title>');
  const terminal = new HandoffTerminal(projectRoot);
  const draftDir = join(projectRoot, '.aico-ppt-editor', 'drafts', 'handoff-draft');
  const creationConversationId = '019ff3bd-3f52-7f91-8ee6-61da2977a39f';
  const app = await startServer({
    deckPath,
    host:'127.0.0.1',
    port:0,
    openBrowser:false,
    agentProjectRoot:root,
    agentThreadId:creationConversationId,
    agentTerminalSession:terminal,
    autoStartAgentTerminal:false,
    creationHandoff:{
      draft:{
        version:1, draftId:'handoff-draft', revision:8, phase:'ready',
        projectRoot, provider:'codex',
        brief:{ title:'继承上下文', materials:'原始素材库' },
        outline:{ sections:[{ chapterId:'one', title:'背景' }] },
        pagePlan:{ pages:[{ pageId:'p1', chapterId:'one', label:'封面' }] },
        generation:{ status:'published', publishedDeck:deckPath },
      },
      draftDir,
      conversationId:creationConversationId,
    },
  });
  assert.equal(app.agentTerminal, terminal);
  assert.equal(app.agentTerminal.snapshot().runtimeId, 'handoff-runtime');
  assert.equal(terminal.environment.AICO_PPT_EDITOR_URL, app.url);
  assert.equal(terminal.environment.AICO_PPT_EDITOR_TOKEN, app.token);
  assert.equal(terminal.environment.AICO_PPT_CREATION_CONTEXT, app.creationHandoff.path);
  assert.equal(terminal.environment.AICO_PPT_CREATION_MATERIALS, join(draftDir, 'materials'));
  assert.match(terminal.prompts[0], /同一个任务，不是新的制作项目/);
  assert.match(terminal.prompts[0], /不要再次完整读取 SKILL\.md/);
  assert.match(terminal.prompts[0], new RegExp(app.url.replaceAll('.', '\\.')));
  assert.match(terminal.prompts[0], new RegExp(app.token));
  const handoff = JSON.parse(await readFile(app.creationHandoff.path, 'utf8'));
  assert.equal(handoff.draft.brief.title, '继承上下文');
  assert.deepEqual(handoff.draft.outline.sections, [{ chapterId:'one', title:'背景' }]);
  assert.equal(handoff.artifacts.materialsDirectory, join(draftDir, 'materials'));
  assert.equal(terminal.closed, false);
  await app.close();
  assert.equal(terminal.closed, true);

  let newConversationPrompt = '';
  const reopened = await startServer({
    deckPath,
    host:'127.0.0.1',
    port:0,
    openBrowser:false,
    agentProjectRoot:root,
    autoStartAgentTerminal:false,
    resumeAgentTerminalConversation:async () => {
      throw Object.assign(new Error('旧会话不可用'), { code:'SESSION_NOT_FOUND' });
    },
    createAgentTerminalConversation:async (_provider, options) => {
      newConversationPrompt = options.initialPrompt;
      return {
        conversationId:'019ff3bd-3f52-7f91-8ee6-61da2977a39e',
        resume:true,
        initialPromptConsumed:true,
      };
    },
    spawnAgentTerminal:(executable, args, options) => new FakePty(executable, args, options, 8300),
  });
  try {
    await reopened.agentTerminal.start();
    assert.equal(reopened.creationHandoff.context.draftId, 'handoff-draft');
    assert.match(newConversationPrompt, /Creation 上下文清单：.*creation-context\.json/);
    assert.match(newConversationPrompt, /brief、大纲、页面规划、设计文稿与素材库/);
  } finally {
    await reopened.close();
  }
});

test('应用重启后 Creation 恢复以当前 Draft 项目根覆盖最终 Deck 的旧工作区目录', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-editor-creation-resume-root-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const projectRoot = join(root, 'Deck-Projects', 'creation-task');
  await mkdir(projectRoot, { recursive:true });
  const canonicalProjectRoot = await realpath(projectRoot);
  const deckPath = join(projectRoot, 'deck.html');
  await writeFile(deckPath, '<!doctype html><title>creation resume</title>');

  const oldEditor = await startServer({
    deckPath,
    host:'127.0.0.1',
    port:0,
    openBrowser:false,
    agentProjectRoot:root,
    autoStartAgentTerminal:false,
  });
  await oldEditor.close();

  const terminal = new HandoffTerminal(canonicalProjectRoot);
  const resumedEditor = await startServer({
    deckPath,
    host:'127.0.0.1',
    port:0,
    openBrowser:false,
    agentProjectRoot:canonicalProjectRoot,
    agentTerminalSession:terminal,
    autoStartAgentTerminal:false,
  });
  try {
    assert.equal(resumedEditor.agentTerminal, terminal);
    assert.equal(resumedEditor.agentWorkspace.snapshot().projectRoot, canonicalProjectRoot);
  } finally {
    await resumedEditor.close();
  }
});

test('重开任务修复可信项目根，用户显式换根时不跨目录恢复旧会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-editor-conversation-root-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot);
  const deckPath = join(projectRoot, 'deck.html');
  await writeFile(deckPath, '<!doctype html><title>conversation root</title>');
  const oldId = '019ff3bd-3f52-7f91-8ee6-61da2977a390';
  const newId = '019ff3bd-3f52-7f91-8ee6-61da2977a391';

  const original = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false,
    agentProjectRoot:root, agentThreadId:oldId, autoStartAgentTerminal:false,
  });
  await original.close();

  let repairedResumeId = null;
  const repaired = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false,
    agentProjectRoot:projectRoot,
    agentProjectRootSource:'persisted',
    autoStartAgentTerminal:false,
    resumeAgentTerminalConversation:async (_provider, { conversationId }) => {
      repairedResumeId = conversationId;
      return { conversationId, resume:true };
    },
    createAgentTerminalConversation:async () => assert.fail('可信根修复后应继续原会话'),
    spawnAgentTerminal:(executable, args, options) => new FakePty(
      executable, args, options, 8400,
    ),
  });
  await repaired.agentTerminal.start();
  assert.equal(repairedResumeId, oldId);
  assert.equal(
    repaired.agentWorkspace.snapshot().providers.codex.conversations[0].projectRoot,
    await realpath(projectRoot),
  );
  await repaired.close();

  let staleResumeAttempted = false;
  const switched = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false,
    agentProjectRoot:root,
    agentProjectRootSource:'explicit',
    autoStartAgentTerminal:false,
    resumeAgentTerminalConversation:async () => {
      staleResumeAttempted = true;
      return { conversationId:oldId, resume:true };
    },
    createAgentTerminalConversation:async () => ({
      conversationId:newId, resume:true, initialPromptConsumed:true,
    }),
    spawnAgentTerminal:(executable, args, options) => new FakePty(
      executable, args, options, 8401,
    ),
  });
  try {
    await switched.agentTerminal.start();
    assert.equal(staleResumeAttempted, false);
    assert.equal(switched.agentTerminal.snapshot().conversationId, newId);
  } finally {
    await switched.close();
  }
});

test('应用重启恢复已发布 Draft 时先启动终端，再按顺序发送 Creation 交接说明', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-editor-stopped-handoff-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const projectRoot = await realpath(root);
  const deckPath = join(projectRoot, 'deck.html');
  await writeFile(deckPath, '<!doctype html><title>stopped handoff</title>');
  const draftDir = join(projectRoot, '.aico-ppt-editor', 'drafts', 'stopped-draft');
  const children = [];
  const scheduledSubmits = [];
  const terminal = new AgentTerminalSession({
    projectRoot,
    initialPrompt:() => 'Creation 恢复说明',
    resolveConversation:async () => ({
      conversationId:'019ff3bd-3f52-7f91-8ee6-61da2977a39a',
      resume:true,
      initialPromptConsumed:false,
    }),
    scheduleSubmit:(callback, delayMs) => {
      scheduledSubmits.push({ callback, delayMs });
      return scheduledSubmits.length;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options, 8400 + children.length);
      child.writes = [];
      child.write = value => child.writes.push(value);
      children.push(child);
      return child;
    },
  });

  const app = await startServer({
    deckPath,
    host:'127.0.0.1',
    port:0,
    openBrowser:false,
    agentProjectRoot:projectRoot,
    agentTerminalSession:terminal,
    closeAgentTerminalOnShutdown:false,
    autoStartAgentTerminal:false,
    creationHandoff:{
      draft:{
        version:1, draftId:'stopped-draft', revision:8, phase:'ready',
        projectRoot, provider:'codex', brief:{ title:'恢复已发布任务' },
        outline:{ sections:[] }, pagePlan:{ pages:[] },
        generation:{ status:'published', publishedDeck:deckPath },
      },
      draftDir,
      conversationId:'019ff3bd-3f52-7f91-8ee6-61da2977a39a',
    },
  });
  try {
    assert.equal(terminal.snapshot().state, 'stopped');
    await terminal.start();
    children[0].events.emit('data', 'Codex ready');
    assert.match(children[0].writes[0], /Creation 恢复说明/);
    scheduledSubmits.shift().callback();
    children[0].events.emit('data', '\u001b[?25l\u001b[2K• Working');
    children[0].events.emit('data', 'Codex ready');
    await new Promise(resolve => setImmediate(resolve));
    assert.match(children[0].writes[2], /同一个任务，不是新的制作项目/);
    while (children[0].writes.filter(value => value === '\r').length < 2) {
      scheduledSubmits.shift().callback();
    }
    children[0].events.emit('data', '\u001b[?25l\u001b[2K• Working');
  } finally {
    await app.close();
    await terminal.close();
  }
});

test('Editor 监听端口后初始化失败也会释放 sidecar 锁并允许立即重试', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-editor-post-listen-cleanup-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const projectRoot = await realpath(root);
  const deckPath = join(projectRoot, 'deck.html');
  await writeFile(deckPath, '<!doctype html><title>post-listen cleanup</title>');
  const brokenTerminal = new HandoffTerminal(projectRoot);
  brokenTerminal.updateConversationLifecycle = () => {
    throw new Error('模拟监听完成后的终端初始化失败');
  };

  await assert.rejects(
    () => startServer({
      deckPath,
      host:'127.0.0.1',
      port:0,
      openBrowser:false,
      agentProjectRoot:projectRoot,
      agentTerminalSession:brokenTerminal,
      autoStartAgentTerminal:false,
    }),
    /模拟监听完成后的终端初始化失败/,
  );
  assert.equal(brokenTerminal.closed, true);

  const retry = await startServer({
    deckPath,
    host:'127.0.0.1',
    port:0,
    openBrowser:false,
    agentProjectRoot:projectRoot,
    autoStartAgentTerminal:false,
  });
  await retry.close();
});

test('临时 Managed Workspace 关闭时可只释放 Editor，不关闭交接中的 PTY', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-editor-shared-terminal-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, 'deck.html');
  await writeFile(deckPath, '<!doctype html><title>shared</title>');
  const terminal = new HandoffTerminal(await realpath(root));
  const app = await startServer({
    deckPath,
    host:'127.0.0.1',
    port:0,
    openBrowser:false,
    agentProjectRoot:root,
    agentTerminalSession:terminal,
    closeAgentTerminalOnShutdown:false,
  });
  await app.close();
  assert.equal(terminal.closed, false);
  await terminal.close();
});

test('新建 Deck 交接后点击新会话会更新 Editor 活动 ID，重开继续同一新会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-editor-handoff-conversation-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, 'deck.html');
  await writeFile(deckPath, '<!doctype html><title>handoff conversation</title>');
  const oldId = '019ff3bd-3f52-7f91-8ee6-61da2977a39f';
  const staleCreationId = '019ff3bd-3f52-7f91-8ee6-61da2977a39e';
  const newEditorId = '019ff3bd-3f52-7f91-8ee6-61da2977a39d';
  const children = [];
  const terminal = new AgentTerminalSession({
    projectRoot:await realpath(root),
    resolveConversation:async (_provider, { newConversation }) => ({
      conversationId:newConversation ? staleCreationId : oldId,
      resume:true,
      initialPromptConsumed:newConversation,
    }),
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options, 8100 + children.length);
      children.push(child);
      return child;
    },
  });
  await terminal.start();
  assert.equal(terminal.snapshot().conversationId, oldId);

  const first = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false,
    agentProjectRoot:root, agentThreadId:oldId,
    agentTerminalSession:terminal, autoStartAgentTerminal:false,
    createAgentTerminalConversation:async () => ({
      conversationId:newEditorId, resume:true, initialPromptConsumed:true,
    }),
  });
  t.after(() => first.close());
  await terminal.restart({ provider:'codex', newConversation:true });
  assert.equal(terminal.snapshot().conversationId, newEditorId);
  assert.equal(
    first.agentWorkspace.snapshot().providers.codex.activeConversationId,
    newEditorId,
  );
  await first.close();

  let resumedId = null;
  const reopenedChildren = [];
  const reopened = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false,
    agentProjectRoot:root, autoStartAgentTerminal:false,
    resumeAgentTerminalConversation:async (_provider, { conversationId }) => {
      resumedId = conversationId;
      return { conversationId, resume:true };
    },
    spawnAgentTerminal:(executable, args, options) => {
      const child = new FakePty(executable, args, options, 8200 + reopenedChildren.length);
      reopenedChildren.push(child);
      return child;
    },
  });
  try {
    await reopened.agentTerminal.start();
    assert.equal(resumedId, newEditorId);
    assert.equal(reopened.agentTerminal.snapshot().conversationId, newEditorId);
    assert.deepEqual(reopenedChildren[0].args.slice(0, 3), [
      'resume', '--dangerously-bypass-approvals-and-sandbox', newEditorId,
    ]);
  } finally {
    await reopened.close();
  }
});
