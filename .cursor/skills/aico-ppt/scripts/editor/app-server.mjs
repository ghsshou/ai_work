import {runtimeVersion} from './runtime-version.mjs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { copyFile, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { buildOpenCommand, startServer } from './server.mjs';
import { isMainModule } from './main-module.mjs';
import {
  DraftAgentConversationStore,
  discoverTerminalConversation,
} from './agent-terminal-conversation-store.mjs';
import { createRecentDeckStore } from './recent-deck-store.mjs';
import { createWorkHistoryStore } from './work-history-store.mjs';
import { resolveEditingContext } from './dsh-editing-context.mjs';
import { createWorkCatalog } from './work-catalog.mjs';
import {
  DeckCreationWorkspace,
  buildCreationInitializationPrompt,
  buildCreationResumePrompt,
} from './deck-creation-workspace.mjs';
import { CreationManagedDeck } from './creation-managed-deck.mjs';
import {
  assertProjectRootIdentity,
  resolveProjectRoot,
  resolveSelectedProjectRoot,
} from './agent-workspace/project-root.mjs';
import { isAgentProviderId } from './agent-provider-registry.mjs';
import { defaultPythonExecutable } from './python-utf8.mjs';
import {
  pickDeckWithSystemPicker as pickDeckPathWithSystemPicker,
  pickProjectDirectoryWithSystemPicker as pickProjectPathWithSystemPicker,
} from './system-picker.mjs';
import { buildHelpCatalog } from './help-catalog.mjs';
import {
  inspectEnvironment as inspectEnvironmentWithPython,
  inspectInstallation as inspectInstallationWithPython,
} from './environment-doctor.mjs';
import { createDshPromptRelay } from './dsh-prompt-relay.mjs';
import { withLegacyAicoPptEnvironment } from './environment-aliases.mjs';

const EDITOR_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(EDITOR_DIR, '../..');
const DEFAULT_PYTHON_EXECUTABLE = defaultPythonExecutable();

async function canonicalDeckLocator(value) {
  try { return await realpath(value); }
  catch {
    const parent = await realpath(dirname(value)).catch(() => resolve(dirname(value)));
    return join(parent, basename(value));
  }
}
const APP_PUBLIC_DIR = join(EDITOR_DIR, 'app-public');
const APP_ASSETS = new Map([
  ['/app/app.css', { path:join(APP_PUBLIC_DIR, 'app.css'), type:'text/css; charset=utf-8' }],
  ['/app/app.mjs', { path:join(APP_PUBLIC_DIR, 'app.mjs'), type:'text/javascript; charset=utf-8' }],
  ['/app/support-center.mjs', {
    path:join(APP_PUBLIC_DIR, 'support-center.mjs'), type:'text/javascript; charset=utf-8',
  }],
  ['/app/launcher-lease-client.mjs', {
    path:join(EDITOR_DIR, 'public/launcher-lease-client.mjs'),
    type:'text/javascript; charset=utf-8',
  }],
  ['/app/liquid-ether-background.mjs', {
    path:join(APP_PUBLIC_DIR, 'liquid-ether-background.mjs'),
    type:'text/javascript; charset=utf-8',
  }],
  ['/app/liquid-ether-engine.mjs', {
    path:join(APP_PUBLIC_DIR, 'liquid-ether-engine.mjs'),
    type:'text/javascript; charset=utf-8',
  }],
  ['/app/liquid-ether-worker.mjs', {
    path:join(APP_PUBLIC_DIR, 'liquid-ether-worker.mjs'),
    type:'text/javascript; charset=utf-8',
  }],
  ['/app/three.module.min.js', {
    get path() { return join(dirname(fileURLToPath(import.meta.resolve('three'))), 'three.module.min.js'); },
    type:'text/javascript; charset=utf-8',
  }],
  ['/app/three.core.min.js', {
    get path() { return join(dirname(fileURLToPath(import.meta.resolve('three'))), 'three.core.min.js'); },
    type:'text/javascript; charset=utf-8',
  }],
  ['/app/native-controls.mjs', {
    path:join(EDITOR_DIR, 'public/native-controls.mjs'), type:'text/javascript; charset=utf-8',
  }],
  ['/app/pill-nav.mjs', {
    path:join(EDITOR_DIR, 'public/pill-nav.mjs'), type:'text/javascript; charset=utf-8',
  }],
  ['/app/toolbar-tooltip.mjs', {
    path:join(EDITOR_DIR, 'public/toolbar-tooltip.mjs'), type:'text/javascript; charset=utf-8',
  }],
  ['/app/pill-nav.css', {
    path:join(EDITOR_DIR, 'public/pill-nav.css'), type:'text/css; charset=utf-8',
  }],
  ['/app/guided-tour.css', {
    path:join(EDITOR_DIR, 'public/guided-tour.css'), type:'text/css; charset=utf-8',
  }],
  ['/app/create-deck-icon.png', {
    path:join(APP_PUBLIC_DIR, 'create-deck-icon.png'), type:'image/png',
  }],
  ['/app/edit-deck-icon.png', {
    path:join(APP_PUBLIC_DIR, 'edit-deck-icon.png'), type:'image/png',
  }],
  ['/app/agent-terminal-panel.mjs', {
    path:join(EDITOR_DIR, 'public/agent-terminal-panel.mjs'),
    type:'text/javascript; charset=utf-8',
  }],
  ['/app/terminal-keyboard.mjs', {
    path:join(EDITOR_DIR, 'public/terminal-keyboard.mjs'),
    type:'text/javascript; charset=utf-8',
  }],
  ['/app/agent-provider-registry.mjs', {
    path:join(EDITOR_DIR, 'agent-provider-registry.mjs'),
    type:'text/javascript; charset=utf-8',
  }],
  ['/app/agent-terminal-panel.css', {
    path:join(EDITOR_DIR, 'public/agent-terminal-panel.css'),
    type:'text/css; charset=utf-8',
  }],
  ['/app/workspace-switcher.mjs', {
    path:join(EDITOR_DIR, 'public/workspace-switcher.mjs'),
    type:'text/javascript; charset=utf-8',
  }],
  ['/app/dsh-work-bridge.mjs', {
    path:join(EDITOR_DIR, 'public/dsh-work-bridge.mjs'),
    type:'text/javascript; charset=utf-8',
  }],
  ['/app/dsh-project-choice.mjs', { path:join(EDITOR_DIR, 'public/dsh-project-choice.mjs'), type:'text/javascript; charset=utf-8' }],
  ['/app/deck-task-coordinator.mjs', {
    path:join(EDITOR_DIR, 'public/deck-task-coordinator.mjs'),
    type:'text/javascript; charset=utf-8',
  }],
  ['/app/xterm.js', {
    get path() { return fileURLToPath(import.meta.resolve('@xterm/xterm/lib/xterm.js')); },
    type:'text/javascript; charset=utf-8',
  }],
  ['/app/xterm.css', {
    get path() { return fileURLToPath(import.meta.resolve('@xterm/xterm/css/xterm.css')); },
    type:'text/css; charset=utf-8',
  }],
  ['/app/huawei-logo.png', {
    path:join(PROJECT_DIR, 'assets/huawei-refs/logos/huawei-横版logo-透明.png'),
    type:'image/png',
  }],
]);

function loopbackHost(host) {
  const normalized = String(host).toLowerCase();
  const ipv4Loopback = isIP(normalized) === 4 && normalized.startsWith('127.');
  if (!ipv4Loopback && normalized !== '::1' && normalized !== 'localhost') {
    throw new TypeError('导入页只允许监听 loopback 地址');
  }
  return normalized;
}

function loopbackHttpOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const ipv4Loopback = isIP(hostname) === 4 && hostname.startsWith('127.');
    const ipv6Loopback = hostname === '::1' || hostname === '[::1]';
    if (url.protocol !== 'http:'
      || url.origin !== value
      || (!ipv4Loopback && !ipv6Loopback && hostname !== 'localhost')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function tokenMatches(actual, expected) {
  const left = Buffer.from(String(actual ?? ''));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

function authCookieName(token) {
  const sessionId = createHash('sha256').update(token).digest('hex').slice(0, 16);
  return `aico_ppt_app_${sessionId}`;
}

function cookieValue(request, name) {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'cache-control':'no-store',
    'content-type':'application/json; charset=utf-8',
    'x-content-type-options':'nosniff',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request, maximum = 32 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximum) throw Object.assign(new Error('请求体过大'), { code:'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('请求体必须是 JSON 对象'), { code:'INVALID_BODY' });
  }
  return value;
}

export function pickDeckWithSystemPicker(options = {}) {
  return pickDeckPathWithSystemPicker({
    pythonExecutable:DEFAULT_PYTHON_EXECUTABLE, ...options,
  });
}

export function pickProjectDirectoryWithSystemPicker(options = {}) {
  return pickProjectPathWithSystemPicker({
    pythonExecutable:DEFAULT_PYTHON_EXECUTABLE, ...options,
  });
}

export async function createOnboardingSample({
  parentDirectory,
  sourceDeck = join(PROJECT_DIR, 'assets/training-deck.html'),
} = {}) {
  if (typeof parentDirectory !== 'string' || !parentDirectory) {
    throw Object.assign(new Error('示例项目目录无效'), { code:'INVALID_SAMPLE_DIRECTORY' });
  }
  const parent = await realpath(parentDirectory);
  const directory = await mkdtemp(join(parent, 'AICO-PPT 示例-'));
  const deckPath = join(directory, 'AICO-PPT 示例.html');
  await copyFile(sourceDeck, deckPath);
  return { projectRoot:directory, deckPath, deckName:basename(deckPath) };
}

export async function startAppServer({
  host = '127.0.0.1',
  port = 0,
  token = randomUUID(),
  pythonExecutable = DEFAULT_PYTHON_EXECUTABLE,
  pickDeck = options => pickDeckWithSystemPicker({ pythonExecutable, ...options }),
  pickAgentProjectDirectory = options => pickProjectDirectoryWithSystemPicker({
    pythonExecutable, ...options,
  }),
  resolveAgentProject = options => resolveProjectRoot(options),
  assertAgentProject = project => assertProjectRootIdentity(project),
  resolveCreationProject = options => resolveSelectedProjectRoot(options),
  createCreationWorkspace = options => DeckCreationWorkspace.create(options),
  openCreationWorkspace = options => DeckCreationWorkspace.open(options),
  createAgentTerminal = null,
  prewarmAgentRuntime = null,
  loadHelpCatalog = () => buildHelpCatalog({ projectRoot:PROJECT_DIR }),
  inspectEnvironment = options => inspectEnvironmentWithPython({
    pythonExecutable, ...options,
  }),
  inspectInstallation = options => inspectInstallationWithPython({
    pythonExecutable, ...options,
  }),
  createSampleDeck = options => createOnboardingSample(options),
  stateRoot = null,
  recentDeckStore = createRecentDeckStore({
    ...(stateRoot ? { filePath:join(stateRoot, 'recent-decks.json') } : {}),
    discoveryRoots:[join(PROJECT_DIR, 'Deck-Projects')],
  }),
  workHistoryStore = createWorkHistoryStore({
    ...(stateRoot ? { filePath:join(stateRoot, 'work-history.json') } : {}),
    discoveryRoots:[join(PROJECT_DIR, 'Deck-Projects')],
    recentDeckStore,
  }),
  workCatalog = null,
  startEditor = options => startServer(options),
  startCreationEditor = null,
  editorCloseGraceMs = 10_000,
  creationClientCloseGraceMs = 10_000,
  launcherClientCloseGraceMs = 5_000,
  launcherLeaseHandshakeMs = 15_000,
  agentProvider = 'codex',
  embeddedMode = null,
  embeddedParentOrigin = null,
} = {}) {
  host = loopbackHost(host);
  if (![null, 'dsh'].includes(embeddedMode)) {
    throw new TypeError('embeddedMode 只支持 null 或 dsh');
  }
  if (embeddedMode === 'dsh' && embeddedParentOrigin !== null) {
    try { embeddedParentOrigin = new URL(embeddedParentOrigin).origin; }
    catch { throw new TypeError('embeddedParentOrigin 必须是有效 Origin'); }
  }
  if (!isAgentProviderId(agentProvider)) {
    throw new TypeError(`Agent provider 不受支持：${agentProvider}`);
  }
  if (embeddedMode === 'dsh') {
    // 正式 DSH 插件不装载 PTY、xterm 或 WSL Agent 运行时。
    createAgentTerminal ??= async () => { throw new Error('DSH 嵌入模式由 Windows DSH 会话执行 Agent'); };
    prewarmAgentRuntime ??= () => {};
  } else if (createAgentTerminal === null || prewarmAgentRuntime === null) {
    const [{ createAgentTerminalSession }, { prewarmAgentTerminalRuntime }] = await Promise.all([
      import('./agent-terminal-loader.mjs'),
      import('./agent-terminal-runtime.mjs'),
    ]);
    createAgentTerminal ??= createAgentTerminalSession;
    prewarmAgentRuntime ??= prewarmAgentTerminalRuntime;
  }
  if (typeof prewarmAgentRuntime !== 'function') {
    throw new TypeError('prewarmAgentRuntime 必须是函数');
  }
  if (typeof createAgentTerminal !== 'function') {
    throw new TypeError('createAgentTerminal 必须是函数');
  }
  if (embeddedMode !== 'dsh') {
    try {
      const prewarm = prewarmAgentRuntime(agentProvider, {
        projectRoot:PROJECT_DIR,
        cwd:PROJECT_DIR,
        pathRoots:[PROJECT_DIR],
      });
      prewarm?.catch?.(() => {
        // 预热只隐藏 WSL 冷启动；失败由真正打开终端时的显式状态负责报告。
      });
    } catch {
      // 同上：启动页本身不能因可选预热失败而退出。
    }
  }
  const activeWorkCatalog = workCatalog ?? createWorkCatalog({
    legacyHistory:workHistoryStore,
    filePath:typeof workHistoryStore.filePath === 'string'
      ? join(dirname(workHistoryStore.filePath), 'work-catalog.json')
      : null,
  });
  const urlHost = host.includes(':') ? `[${host}]` : host;
  const appHtml = await readFile(join(APP_PUBLIC_DIR, 'index.html'), 'utf8');
  let state = 'idle';
  let serviceOrigin = '';
  let editorApp = null;
  let activePicker = null;
  let candidate = null;
  let creationCandidate = null;
  let creationWorkspace = null;
  let creationTerminal = null;
  let creationPickerPreviousState = null;
  let deckPickerPreviousState = null;
  let handoffEditorUrl = null;
  let selectionRevision = 0;
  let launcherClosePromise = null;
  let appClosePromise = null;
  let creationClientCloseTimer = null;
  let launcherClientCloseTimer = null;
  const launcherClientLeases = new Map();
  const activeLauncherClientLeases = new Map();
  const launcherLeaseSockets = new Map();
  const launcherLeaseHandshakeTimers = new Map();
  let activeLauncherClientLease = null;
  const creationRuntimes = new Map();
  const editingRuntimes = new Map();
  let activeCreationRuntimeKey = null;
  let activeEditingRuntimeKey = null;

  const eventSockets = new WebSocketServer({ noServer:true, maxPayload:64 * 1024 });
  const terminalSockets = new WebSocketServer({ noServer:true, maxPayload:128 * 1024 });
  const launcherSockets = new WebSocketServer({ noServer:true, maxPayload:1024 });

  if (!Number.isSafeInteger(launcherClientCloseGraceMs) || launcherClientCloseGraceMs < 0) {
    throw new TypeError('launcherClientCloseGraceMs 必须为非负整数');
  }
  if (!Number.isSafeInteger(launcherLeaseHandshakeMs) || launcherLeaseHandshakeMs < 1) {
    throw new TypeError('launcherLeaseHandshakeMs 必须为正整数');
  }

  const broadcastCreation = event => {
    const message = JSON.stringify(event);
    for (const client of eventSockets.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  };

  const cancelCreationClientClose = () => {
    clearTimeout(creationClientCloseTimer);
    creationClientCloseTimer = null;
  };
  const cancelLauncherClientClose = () => {
    clearTimeout(launcherClientCloseTimer);
    launcherClientCloseTimer = null;
  };
  const clientLeaseMatches = (left, right) => Boolean(
    left && right && left.clientId === right.clientId && left.sequence === right.sequence
  );
  const clientLeaseKey = ({ clientId, sequence }) => `${clientId}\0${sequence}`;
  const cancelLauncherLeaseHandshake = lease => {
    const key = clientLeaseKey(lease);
    clearTimeout(launcherLeaseHandshakeTimers.get(key));
    launcherLeaseHandshakeTimers.delete(key);
  };
  const registerLauncherClientLease = ({ clientId, sequence }) => {
    const previous = launcherClientLeases.get(clientId) ?? 0;
    if (sequence < previous) return { staleLease:true };
    launcherClientLeases.set(clientId, Math.max(previous, sequence));
    activeLauncherClientLeases.set(clientId, sequence);
    activeLauncherClientLease = { clientId, sequence };
    cancelCreationClientClose();
    cancelLauncherClientClose();
    const lease = { clientId, sequence };
    const key = clientLeaseKey(lease);
    if ((launcherLeaseSockets.get(key)?.size ?? 0) === 0) {
      cancelLauncherLeaseHandshake(lease);
      const timer = setTimeout(() => {
        launcherLeaseHandshakeTimers.delete(key);
        if ((launcherLeaseSockets.get(key)?.size ?? 0) === 0) {
          scheduleLauncherClientClose(lease);
        }
      }, launcherLeaseHandshakeMs);
      timer.unref?.();
      launcherLeaseHandshakeTimers.set(key, timer);
    }
    return { staleLease:false };
  };
  const scheduleLauncherClientClose = ({ clientId = null, sequence = null } = {}) => {
    if (launcherClosePromise || appClosePromise) return;
    const requestedLease = clientId && Number.isSafeInteger(sequence)
      ? { clientId, sequence } : activeLauncherClientLease;
    if (requestedLease
      && (launcherClientLeases.get(requestedLease.clientId) ?? -1) > requestedLease.sequence) return;
    if (requestedLease) {
      if (activeLauncherClientLeases.get(requestedLease.clientId) !== requestedLease.sequence) return;
      cancelLauncherLeaseHandshake(requestedLease);
      activeLauncherClientLeases.delete(requestedLease.clientId);
      if (clientLeaseMatches(requestedLease, activeLauncherClientLease)) {
        const fallback = [...activeLauncherClientLeases.entries()].at(-1);
        activeLauncherClientLease = fallback
          ? { clientId:fallback[0], sequence:fallback[1] } : null;
      }
    }
    if (activeLauncherClientLeases.size > 0) return;
    // 独立启动器由页面租约管理生命周期；DSH 嵌入运行时则由 Host
    // 插件的 effect 统一持有。工作台折叠、页面刷新或会话切换都可能短暂
    // 断开 iframe，此时不能把仍被 Host 持有的 Editor 服务误关掉。
    if (embeddedMode === 'dsh') return;
    cancelLauncherClientClose();
    launcherClientCloseTimer = setTimeout(() => {
      launcherClientCloseTimer = null;
      if (activeLauncherClientLeases.size > 0) return;
      void close().catch(() => {});
    }, launcherClientCloseGraceMs);
    launcherClientCloseTimer.unref?.();
  };
  const scheduleCreationClientClose = () => {
    if (state !== 'building' || appClosePromise) return;
    if (embeddedMode === 'dsh') return;
    cancelCreationClientClose();
    creationClientCloseTimer = setTimeout(() => {
      creationClientCloseTimer = null;
      const hasClient = [...eventSockets.clients].some(client => client.readyState === WebSocket.OPEN);
      if (!hasClient && activeLauncherClientLeases.size === 0 && state === 'building') {
        void close().catch(() => {});
      }
    }, creationClientCloseGraceMs);
    creationClientCloseTimer.unref?.();
  };

  const creationRuntimeKey = ({ projectRoot, draftId }) => (
    `${resolve(projectRoot)}\0${draftId}`
  );
  const deckRuntimeKey = async (deckPath, deckId = null) => (
    deckId ?? await realpath(deckPath).catch(() => resolve(deckPath))
  );
  const activeCreationRuntime = () => (
    activeCreationRuntimeKey ? creationRuntimes.get(activeCreationRuntimeKey) ?? null : null
  );
  const activateCreationRuntime = runtime => {
    activeCreationRuntimeKey = runtime.key;
    activeEditingRuntimeKey = null;
    creationWorkspace = runtime.workspace;
    creationTerminal = runtime.terminal;
    creationCandidate = runtime.candidate;
    editorApp = null;
    handoffEditorUrl = null;
  };
  const activateEditingRuntime = runtime => {
    runtime.editorUrl = editorUrlWithWorkspaceNavigation(
      runtime.app,
      'editing',
    );
    activeEditingRuntimeKey = runtime.key;
    activeCreationRuntimeKey = null;
    editorApp = runtime.app;
    candidate = runtime.candidate;
    creationWorkspace = null;
    creationTerminal = null;
    creationCandidate = null;
    handoffEditorUrl = runtime.editorUrl;
  };
  const parkWorkspace = () => {
    activeCreationRuntimeKey = null;
    activeEditingRuntimeKey = null;
    editorApp = null;
    creationWorkspace = null;
    creationTerminal = null;
    creationCandidate = null;
    handoffEditorUrl = null;
  };
  const findCreationRuntimeByCapability = bearer => {
    if (!bearer) return null;
    for (const runtime of creationRuntimes.values()) {
      if (runtime.workspace?.capabilityToken
        && tokenMatches(bearer, runtime.workspace.capabilityToken)) return runtime;
    }
    return null;
  };
  const findEditingRuntime = ({ deckId = null, deckPath = null } = {}) => {
    if (deckId && editingRuntimes.has(deckId)) return editingRuntimes.get(deckId);
    const normalizedPath = deckPath ? resolve(deckPath) : null;
    for (const runtime of editingRuntimes.values()) {
      if (deckId && runtime.candidate?.deckId === deckId) return runtime;
      if (normalizedPath && runtime.key === normalizedPath) return runtime;
      const runtimePath = runtime.app?.deckPath ?? runtime.deckPath ?? runtime.candidate?.deckPath;
      if (normalizedPath && runtimePath && resolve(runtimePath) === normalizedPath) return runtime;
    }
    return null;
  };
  const synchronizeEditingRuntimeBinding = async (entry, runtime) => {
    const coordinator = runtime?.app?.binding;
    if (!coordinator || typeof coordinator.snapshot !== 'function'
      || typeof coordinator.reconcile !== 'function') return entry;
    const runtimeDeckId = runtime.app.deckId ?? runtime.candidate?.deckId ?? null;
    if (!entry.deckId || runtimeDeckId !== entry.deckId) return entry;
    const cached = coordinator.snapshot();
    if (entry.binding?.state === 'bound' && cached.state === 'bound'
      && entry.binding.currentPath === cached.currentPath
      && entry.binding.sourceFingerprint === cached.sourceFingerprint
      && JSON.stringify(entry.binding.witness) === JSON.stringify(cached.witness)) return entry;
    let binding;
    try {
      binding = await coordinator.reconcile({ cause:'workspace-history' });
    } catch {
      return entry;
    }
    if (binding.deckId !== entry.deckId || binding.state !== 'bound') return entry;
    try {
      return await activeWorkCatalog.updateEditingBinding({
        workId:entry.workId,
        deckId:entry.deckId,
        binding,
      });
    } catch {
      return entry;
    }
  };
  const runtimeAwareHistory = async ({ bindings = 'refresh' } = {}) => {
    if (bindings === 'metadata') return activeWorkCatalog.listSessionTargets();
    const history = await activeWorkCatalog.list();
    const editing = await Promise.all(history.editing.map(async entry => {
      const runtime = findEditingRuntime(entry);
      if (!runtime) return entry;
      const synchronized = await synchronizeEditingRuntimeBinding(entry, runtime);
      return {
        ...synchronized,
        runtimeState:runtime.key === activeEditingRuntimeKey ? 'foreground' : 'background',
      };
    }));
    return {
      ...history,
      creation:history.creation.map(entry => {
        const key = creationRuntimeKey(entry);
        if (!creationRuntimes.has(key)) return entry;
        return {
          ...entry,
          locked:false,
          runtimeState:key === activeCreationRuntimeKey ? 'foreground' : 'background',
        };
      }),
      editing,
    };
  };
  const workItemForCreation = async snapshot => {
    const history = await activeWorkCatalog.list();
    return history.creation.find(entry => (
      entry.draftId === snapshot.draftId
      && resolve(entry.projectRoot) === resolve(snapshot.projectRoot)
    )) ?? null;
  };

  const synchronizeRuntimeDshBinding = workItem => {
    const sessionId = workItem?.dshBinding?.activeSessionId ?? null;
    if (workItem?.kind === 'creation') {
      const runtime = creationRuntimes.get(creationRuntimeKey(workItem));
      if (runtime) {
        runtime.dshSessionId = sessionId;
        runtime.candidate.workId = workItem.workId;
        runtime.candidate.workItem = workItem;
      }
    } else if (workItem?.kind === 'editing') {
      const runtime = findEditingRuntime(workItem);
      if (runtime) {
        runtime.dshSessionId = sessionId;
        runtime.candidate.workId = workItem.workId;
        runtime.candidate.workItem = workItem;
      }
    }
    return workItem;
  };
  const executeDshWorkItemCommand = async (command, input) => {
    if (embeddedMode !== 'dsh') throw Object.assign(new Error('当前不是 DSH 嵌入模式'), {
      code:'DSH_BRIDGE_UNAVAILABLE', statusCode:409,
    });
    switch (command) {
      case 'set-workspace':
        return {
          status:'updated',
          workItem:synchronizeRuntimeDshBinding(await activeWorkCatalog.setDshWorkspace(input)),
        };
      case 'begin-session':
        return {
          status:'pending',
          workItem:await activeWorkCatalog.beginDshSessionProvision(input),
        };
      case 'complete-session':
        return {
          status:'linked',
          workItem:synchronizeRuntimeDshBinding(
            await activeWorkCatalog.completeDshSessionProvision(input),
          ),
        };
      case 'fail-session':
        return {
          status:'recovered',
          workItem:synchronizeRuntimeDshBinding(
            await activeWorkCatalog.failDshSessionProvision(input),
          ),
        };
      case 'activate-session':
        return {
          status:'active',
          workItem:synchronizeRuntimeDshBinding(await activeWorkCatalog.activateDshSession(input)),
        };
      case 'archive-sessions':
        return {
          status:'archived',
          workItem:synchronizeRuntimeDshBinding(await activeWorkCatalog.archiveDshSessions(input)),
        };
      case 'resolve-session': {
        const workItem = await activeWorkCatalog.resolveByDshSession(input.sessionId);
        return { status:workItem ? 'linked' : 'unlinked', workItem };
      }
      default:
        throw Object.assign(new Error(`不支持的 DSH 工作项命令：${String(command)}`), {
          code:'INVALID_DSH_COMMAND', statusCode:400,
        });
    }
  };

  const attachCreationRuntime = async ({ workspace, project, provider, resumed = false }) => {
    if (embeddedMode === 'dsh') {
      const runtime = {
        key:creationRuntimeKey({ projectRoot:project.path, draftId:workspace.draftId }),
        workspace,
        terminal:null,
        unsubscribe:null,
        dshSessionId:null,
        candidate:{
          nonce:randomUUID(),
          revision:selectionRevision += 1,
          project,
          provider,
          workId:null,
        },
      };
      const existingWorkItem = await workItemForCreation(workspace.snapshot());
      runtime.candidate.workId = existingWorkItem?.workId ?? null;
      runtime.dshSessionId = existingWorkItem?.dshBinding?.activeSessionId ?? null;
      runtime.terminal = createDshPromptRelay({
        cwd:project.identity.originalPath,
        getSessionId:() => runtime.dshSessionId,
        publishRequest:request => broadcastCreation({
          type:'dsh-creation-request',
          revision:workspace.snapshot().revision,
          payload:request,
        }),
      });
      try {
        await workspace.attachTerminal(runtime.terminal);
        runtime.unsubscribe = workspace.subscribe(event => {
          if (activeCreationRuntimeKey === runtime.key) broadcastCreation(event);
        });
        creationRuntimes.set(runtime.key, runtime);
        activateCreationRuntime(runtime);
      } catch (error) {
        runtime.unsubscribe?.();
        await runtime.terminal.close().catch(() => {});
        throw error;
      }
      return runtime;
    }
    const runtime = {
      key:creationRuntimeKey({ projectRoot:project.path, draftId:workspace.draftId }),
      workspace,
      terminal:null,
      unsubscribe:null,
      candidate:{
      nonce:randomUUID(),
      revision:selectionRevision += 1,
      project,
      provider,
      },
    };
    const conversationStore = workspace.draftDir ? new DraftAgentConversationStore({
      draftDir:workspace.draftDir,
      taskId:workspace.draftId,
      projectRoot:project.path,
    }) : null;
    const terminal = await createAgentTerminal({
      projectRoot:project.path,
      cwd:project.identity.originalPath,
      runtimePathRoots:[PROJECT_DIR],
      provider,
      environment:withLegacyAicoPptEnvironment({
        ...process.env,
        AICO_PPT_CREATION_URL:serviceOrigin,
        AICO_PPT_CREATION_CAPABILITY_FILE:workspace.capabilityPath,
      }),
      initialPrompt:() => resumed
        ? buildCreationResumePrompt({
            snapshot:workspace.snapshot(), capabilityPath:workspace.capabilityPath,
          })
        : buildCreationInitializationPrompt({
            projectRoot:project.path, capabilityPath:workspace.capabilityPath,
          }),
      resolveConversation:conversationStore
        ? (selectedProvider, options) => conversationStore.resolve(selectedProvider, options)
        : async () => null,
      identifyConversation:discoverTerminalConversation,
      onConversationStarted:conversationStore
        ? (selectedProvider, conversationId) => conversationStore.markStarted(
            selectedProvider, conversationId,
          )
        : async () => {},
      onProviderChange:selectedProvider => {
        runtime.candidate.provider = selectedProvider;
      },
      onStateChange:terminalState => {
        if (activeCreationRuntimeKey !== runtime.key) return;
        broadcastCreation({
          type:'agent-terminal-updated',
          revision:workspace.snapshot().revision,
          payload:terminalState,
        });
      },
    });
    runtime.terminal = terminal;
    try {
      await workspace.attachTerminal(terminal);
      runtime.unsubscribe = workspace.subscribe(event => {
        if (activeCreationRuntimeKey === runtime.key) broadcastCreation(event);
      });
      creationRuntimes.set(runtime.key, runtime);
      activateCreationRuntime(runtime);
    } catch (error) {
      runtime.unsubscribe?.();
      await terminal.close?.().catch(() => {});
      throw error;
    }
    void terminal.start({ provider }).catch(() => {
      // 终端失败不能阻断可持久化的 Draft 工作区。
    });
    return runtime;
  };

  const workspaceAppUrl = () => {
    const url = new URL('/app/', serviceOrigin);
    url.searchParams.set('token', token);
    if (embeddedMode) url.searchParams.set('embedded', embeddedMode);
    if (embeddedParentOrigin) url.searchParams.set('parentOrigin', embeddedParentOrigin);
    if (activeLauncherClientLease) {
      url.searchParams.set('clientId', activeLauncherClientLease.clientId);
      url.searchParams.set('sequence', String(activeLauncherClientLease.sequence));
    }
    return url.href;
  };
  const editorUrlWithWorkspaceNavigation = (app, kind) => {
    const url = new URL(`${app.url}/editor/`);
    url.searchParams.set('token', app.token);
    url.searchParams.set('editorToken', app.editorToken);
    url.searchParams.set('workspaceUrl', workspaceAppUrl());
    url.searchParams.set('workspaceKind', kind);
    if (embeddedMode) url.searchParams.set('embedded', embeddedMode);
    if (embeddedParentOrigin) url.searchParams.set('parentOrigin', embeddedParentOrigin);
    return url.href;
  };
  const openCreationManagedDeck = async options => {
    const creationDraft = options.creationHandoff?.draft ?? options.creationDraft ?? null;
    const creationWorkItem = embeddedMode === 'dsh' && creationDraft
      ? await workItemForCreation(creationDraft)
      : null;
    return CreationManagedDeck.open({
      ...options,
      editorCloseGraceMs,
      startEditor:startCreationEditor ?? startEditor,
      workspaceHistoryProvider:runtimeAwareHistory,
      ...(creationWorkItem ? {
        dshAgentBridge:true,
        workId:creationWorkItem.workId,
        dshWorkItemProvider:() => activeWorkCatalog.resolve(creationWorkItem.workId),
        dshWorkItemCommand:(command, input) => executeDshWorkItemCommand(command, input),
      } : {}),
      onEditorClose:({ editor }) => {
        const runtime = [...editingRuntimes.values()].find(value => value.app === editor);
        if (!runtime) return;
        editingRuntimes.delete(runtime.key);
        void runtime.terminal?.close?.().catch(() => {});
        if (activeEditingRuntimeKey === runtime.key) {
          activeEditingRuntimeKey = null;
          editorApp = null;
        }
      },
    });
  };
  const startDeckEditor = async (selectedCandidate, provider) => {
    await workHistoryStore.recordDeck({
      deckPath:selectedCandidate.deckPath,
      ...(selectedCandidate.workId ? { workId:selectedCandidate.workId } : {}),
      provider,
      projectRoot:selectedCandidate.project.path,
    }).catch(() => {});
    await activeWorkCatalog.reopenEditing({
      deckPath:selectedCandidate.deckPath,
    });
    const history = await activeWorkCatalog.listSessionTargets();
    const canonicalDeckPath = await realpath(selectedCandidate.deckPath)
      .catch(() => resolve(selectedCandidate.deckPath));
    const found = history.editing.find(entry => (
      entry.deckPath === canonicalDeckPath
    )) ?? null;
    const workItem = found ? await activeWorkCatalog.resolve(found.workId) : null;
    if (workItem) {
      selectedCandidate.workId = workItem.workId;
      selectedCandidate.deckId = workItem.deckId;
      selectedCandidate.binding = workItem.binding;
      selectedCandidate.workItem = workItem;
    }
    const key = await deckRuntimeKey(selectedCandidate.deckPath, selectedCandidate.deckId);
    const existing = findEditingRuntime({
      deckId:selectedCandidate.deckId,
      deckPath:selectedCandidate.deckPath,
    });
    if (existing) {
      activateEditingRuntime(existing);
      return existing.editorUrl;
    }
    let runtime = null;
    const app = await startEditor({
      deckPath:selectedCandidate.deckPath,
      host,
      port:0,
      openBrowser:false,
      exitWhenEditorCloses:false,
      editorCloseGraceMs,
      agentProvider:provider,
      agentThreadId:null,
      agentProjectRoot:selectedCandidate.project.path,
      agentProjectRootSource:selectedCandidate.project.source,
      agentTerminalCwd:selectedCandidate.project.identity.originalPath,
      autoStartAgentTerminal:embeddedMode !== 'dsh',
      dshAgentBridge:embeddedMode === 'dsh',
      pythonExecutable,
      workspaceHistoryProvider:runtimeAwareHistory,
      workId:selectedCandidate.workId,
      deckId:selectedCandidate.deckId,
      deckBinding:selectedCandidate.binding,
      renameWorkItem:input => activeWorkCatalog.rename(input),
      dshWorkItemProvider:selectedCandidate.workId
        ? () => activeWorkCatalog.resolve(selectedCandidate.workId)
        : null,
      dshWorkItemCommand:embeddedMode === 'dsh'
        ? (command, input) => executeDshWorkItemCommand(command, input)
        : null,
      updateWorkItemBinding:selectedCandidate.workId && selectedCandidate.deckId
        ? binding => activeWorkCatalog.updateEditingBinding({
            workId:selectedCandidate.workId,
            deckId:selectedCandidate.deckId,
            binding,
          })
        : null,
      onClose:() => {
        if (!runtime) return;
        if (editingRuntimes.get(runtime.key) === runtime) editingRuntimes.delete(runtime.key);
        if (activeEditingRuntimeKey === runtime.key) {
          activeEditingRuntimeKey = null;
          editorApp = null;
        }
      },
    });
    selectedCandidate.provider = provider;
    runtime = {
      key,
      taskId:app.session?.sessionId ?? key,
      deckPath:selectedCandidate.deckPath,
      app,
      candidate:selectedCandidate,
      terminalHandedOff:false,
      editorUrl:editorUrlWithWorkspaceNavigation(app, 'editing'),
    };
    editingRuntimes.set(key, runtime);
    activateEditingRuntime(runtime);
    return runtime.editorUrl;
  };

  const leaveWorkspace = async () => {
    state = 'leaving-workspace';
    cancelCreationClientClose();
    parkWorkspace();
    candidate = null;
    creationPickerPreviousState = null;
    deckPickerPreviousState = null;
    selectionRevision += 1;
    state = 'idle';
  };

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', serviceOrigin || `http://${urlHost}`);
    const bearer = String(request.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
    const capabilityRuntime = findCreationRuntimeByCapability(bearer);
    const browserAuthorized = tokenMatches(requestUrl.searchParams.get('token'), token)
      || tokenMatches(cookieValue(request, authCookieName(token)), token);
    const agentAuthorized = Boolean(
      capabilityRuntime
      && requestUrl.pathname.startsWith('/api/creation-draft'),
    );
    const dshBridgeOrigin = embeddedMode === 'dsh'
      && (
        (request.method === 'POST'
          && ['/api/dsh-work-items/resolve-session', '/api/dsh-work-items/restore-session', '/api/dsh-work-items/complete-restore'].includes(requestUrl.pathname))
        || (request.method === 'GET' && requestUrl.pathname === '/api/work-history')
      )
      ? loopbackHttpOrigin(request.headers.origin)
      : null;
    const requestCreationWorkspace = agentAuthorized
      ? capabilityRuntime.workspace : creationWorkspace;
    if (!browserAuthorized && !agentAuthorized) {
      sendJson(response, 403, { code:'FORBIDDEN', message:'导入页令牌无效' });
      return;
    }
    if (dshBridgeOrigin !== null) {
      response.setHeader('access-control-allow-origin', dshBridgeOrigin);
      response.setHeader('vary', 'Origin');
    }

    if (request.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/app/')) {
      cancelCreationClientClose();
      cancelLauncherClientClose();
      const navigationPending = requestUrl.searchParams.get('leaveWorkspace') === '1'
        || requestUrl.searchParams.has('switchKind');
      const html = appHtml
        .replace(
          'data-file-picker-mode="system"',
          `data-file-picker-mode="system"${navigationPending
            ? ' data-workspace-navigation-state="pending"' : ''}`,
        )
        .replaceAll('__APP_TOKEN__', encodeURIComponent(token))
        .replace(
          embeddedMode === 'dsh'
            ? /<!-- dev-shell-terminal:start -->[\s\S]*?<!-- dev-shell-terminal:end -->/gu
            : /<!-- dev-shell-terminal:(?:start|end) -->/gu,
          '',
        );
      const frameAncestors = embeddedMode === 'dsh'
        ? "frame-ancestors http://127.0.0.1:* http://localhost:*"
        : "frame-ancestors 'none'";
      response.writeHead(200, {
        'cache-control':'no-store',
        'content-security-policy':[
          "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:", "connect-src 'self'", "worker-src 'self'",
          "frame-src 'self' http://127.0.0.1:* http://localhost:*",
          "base-uri 'none'",
          "form-action 'none'", frameAncestors,
        ].join('; '),
        'content-type':'text/html; charset=utf-8',
        'set-cookie':`${authCookieName(token)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`,
        'x-content-type-options':'nosniff',
      });
      response.end(html);
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/launcher-status') {
      sendJson(response, 200, {
        state,
        activePageCount:activeLauncherClientLeases.size,
        everConnected:launcherClientLeases.size > 0,
      });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/help-catalog') {
      try {
        sendJson(response, 200, await loadHelpCatalog());
      } catch (error) {
        sendJson(response, 500, {
          code:'HELP_CATALOG_UNAVAILABLE', message:error.message || '无法读取帮助内容',
        });
      }
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/diagnostics') {
      try {
        const [installation, environment] = await Promise.all([
          inspectInstallation({ repair:false }),
          inspectEnvironment({ profiles:['full'], repair:false }),
        ]);
        sendJson(response, 200, { schemaVersion:1, installation, environment });
      } catch (error) {
        sendJson(response, 500, {
          code:error.code || 'DIAGNOSTICS_UNAVAILABLE',
          message:error.message || '无法读取安装与环境状态',
        });
      }
      return;
    }

    const asset = APP_ASSETS.get(requestUrl.pathname);
    if (request.method === 'GET' && asset) {
      try {
        const bytes = await readFile(asset.path);
        response.writeHead(200, {
          'cache-control':'no-store',
          'content-type':asset.type,
          'x-content-type-options':'nosniff',
        });
        response.end(bytes);
      } catch {
        sendJson(response, 404, { code:'NOT_FOUND', message:'导入页资源不存在' });
      }
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/close') {
      response.writeHead(204, { 'cache-control':'no-store' });
      response.end();
      const clientId = requestUrl.searchParams.get('clientId');
      const sequence = Number(requestUrl.searchParams.get('sequence'));
      scheduleLauncherClientClose({
        clientId:typeof clientId === 'string' && clientId ? clientId : null,
        sequence:Number.isSafeInteger(sequence) ? sequence : null,
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/shutdown') {
      sendJson(response, 202, { status:'shutting-down' });
      setImmediate(() => void close().catch(() => {}));
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/client-connected'
      && requestUrl.searchParams.has('clientId')) {
      const clientId = requestUrl.searchParams.get('clientId');
      const sequence = Number(requestUrl.searchParams.get('sequence'));
      if (typeof clientId !== 'string' || !clientId
        || !Number.isSafeInteger(sequence) || sequence < 1) {
        sendJson(response, 400, { code:'INVALID_CLIENT_LEASE', message:'页面连接标识无效' });
        return;
      }
      const previous = launcherClientLeases.get(clientId) ?? 0;
      if (sequence < previous) {
        sendJson(response, 200, { status:state, staleLease:true });
        return;
      }
      registerLauncherClientLease({ clientId, sequence });
      sendJson(response, 200, state === 'selected' && handoffEditorUrl
        ? { status:state, editorUrl:handoffEditorUrl }
        : { status:state });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/creation-draft') {
      if (!requestCreationWorkspace) {
        sendJson(response, 404, { code:'CREATION_DRAFT_NOT_FOUND', message:'当前没有 Creation Draft' });
        return;
      }
      sendJson(response, 200, requestCreationWorkspace.snapshot());
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/creation-draft/templates') {
      if (!requestCreationWorkspace) {
        sendJson(response, 404, { code:'CREATION_DRAFT_NOT_FOUND', message:'当前没有 Creation Draft' });
        return;
      }
      sendJson(response, 200, requestCreationWorkspace.templates());
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/creation-deck-preview') {
      if (!requestCreationWorkspace) {
        sendJson(response, 404, { code:'CREATION_DRAFT_NOT_FOUND', message:'当前没有 Creation Draft' });
        return;
      }
      const snapshot = requestCreationWorkspace.snapshot();
      const deckPath = snapshot.previewDeck?.path
        ?? requestCreationWorkspace.previewDeckPath?.()
        ?? null;
      if (!deckPath) {
        sendJson(response, 404, { code:'CREATION_DECK_NOT_READY', message:'独立 Deck 尚未出现' });
        return;
      }
      try {
        const html = await readFile(deckPath, 'utf8');
        response.writeHead(200, {
          'cache-control':'no-store',
          'content-security-policy':[
            "default-src 'self' data: blob:",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
            "style-src 'self' 'unsafe-inline' data:",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            "connect-src 'none'",
            "frame-ancestors 'self'",
            "base-uri 'none'",
            "form-action 'none'",
          ].join('; '),
          'content-type':'text/html; charset=utf-8',
          'x-content-type-options':'nosniff',
        });
        response.end(html);
      } catch (error) {
        sendJson(response, 404, {
          code:'CREATION_DECK_UNAVAILABLE',
          message:error?.code === 'ENOENT' ? '独立 Deck 已移动或删除' : '无法读取独立 Deck',
        });
      }
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/recent-decks') {
      try {
        sendJson(response, 200, { version:1, decks:await recentDeckStore.list() });
      } catch (error) {
        sendJson(response, 500, {
          code:'RECENT_DECKS_UNAVAILABLE', message:error.message || '无法读取最近修改',
        });
      }
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/work-history') {
      try {
        const bindings = requestUrl.searchParams.get('bindings') === 'metadata' ? 'metadata' : 'refresh';
        sendJson(response, 200, { ...await runtimeAwareHistory({ bindings }), removed:await activeWorkCatalog.listRemoved() });
      } catch (error) {
        sendJson(response, 500, {
          code:'WORK_HISTORY_UNAVAILABLE', message:error.message || '无法读取可继续任务',
        });
      }
      return;
    }

    if (request.method === 'GET' && ['/creation-events', '/agent-terminal'].includes(requestUrl.pathname)) {
      response.setHeader('upgrade', 'websocket');
      sendJson(response, 426, { code:'WEBSOCKET_UPGRADE_REQUIRED', message:'请使用 WebSocket 连接' });
      return;
    }

    if (request.method !== 'POST') {
      sendJson(response, 404, { code:'NOT_FOUND', message:'接口不存在' });
      return;
    }
    if (!agentAuthorized
      && request.headers.origin !== serviceOrigin
      && dshBridgeOrigin === null) {
      sendJson(response, 403, { code:'FORBIDDEN', message:'只接受导入页自身发起的请求' });
      return;
    }
    if (state === 'closed') {
      sendJson(response, 410, { code:'APP_CLOSED', message:'导入页已经关闭' });
      return;
    }

    const publicCandidate = status => ({
      status,
      candidateNonce:candidate.nonce,
      selectionRevision:candidate.revision,
      deckName:candidate.deckName,
      projectRoot:{
        path:candidate.project.path,
        source:candidate.project.source,
        needsConfirmation:candidate.project.needsConfirmation,
        warning:candidate.project.warning,
      },
      provider:candidate.provider,
      workId:candidate.workId ?? null,
      deckId:candidate.deckId ?? null,
      workItem:candidate.workItem ?? null,
    });
    const publicCreationCandidate = status => ({
      status,
      candidateNonce:creationCandidate.nonce,
      selectionRevision:creationCandidate.revision,
      projectRoot:{
        path:creationCandidate.project.path,
        source:creationCandidate.project.source,
        needsConfirmation:creationCandidate.project.needsConfirmation,
        warning:creationCandidate.project.warning,
      },
      provider:creationCandidate.provider,
    });
    const requireCandidate = body => {
      if (!candidate
        || body.candidateNonce !== candidate.nonce
        || body.selectionRevision !== candidate.revision) {
        throw Object.assign(new Error('Deck 候选已变化，请重新选择'), {
          code:'STALE_DECK_CANDIDATE', statusCode:409,
        });
      }
      return candidate;
    };

    try {
      if (requestUrl.pathname === '/api/diagnostics/repair') {
        const body = await readJson(request);
        if (body.kind === 'skill') {
          sendJson(response, 200, {
            kind:'skill', result:await inspectInstallation({
              repair:true,
              adoptExisting:body.adoptExisting === true,
            }),
          });
          return;
        }
        if (body.kind === 'profile'
          && ['editor-core', 'dev-shell', 'verify', 'pptx-export', 'pptx-read', 'materials'].includes(body.profile)) {
          sendJson(response, 200, {
            kind:'profile', profile:body.profile,
            result:await inspectEnvironment({ profiles:[body.profile], repair:true }),
          });
          return;
        }
        throw Object.assign(new Error('诊断修复目标无效'), {
          code:'INVALID_DIAGNOSTIC_REPAIR', statusCode:400,
        });
      }

      if (requestUrl.pathname === '/api/onboarding/sample') {
        if (state !== 'idle') throw Object.assign(new Error('只能从首页创建示例项目'), {
          code:'INVALID_APP_STATE', statusCode:409,
        });
        state = 'choosing-onboarding-directory';
        const picker = new AbortController();
        activePicker = picker;
        let selectedPath;
        try {
          selectedPath = await pickAgentProjectDirectory({ signal:picker.signal });
        } finally {
          if (activePicker === picker) activePicker = null;
        }
        if (state === 'closed') {
          response.destroy();
          return;
        }
        if (selectedPath === null) {
          state = 'idle';
          sendJson(response, 200, { status:'cancelled' });
          return;
        }
        const sample = await createSampleDeck({ parentDirectory:selectedPath });
        const project = await resolveAgentProject({
          deckPath:sample.deckPath,
          explicitRoot:sample.projectRoot,
        });
        candidate = {
          nonce:randomUUID(),
          revision:selectionRevision += 1,
          deckPath:sample.deckPath,
          deckName:sample.deckName,
          project,
          provider:agentProvider,
        };
        state = 'deck-selected';
        sendJson(response, 200, { ...publicCandidate('deck-selected'), sample:true });
        return;
      }

      if (requestUrl.pathname === '/api/client-connected') {
        const body = await readJson(request);
        if (typeof body.clientId !== 'string' || !body.clientId
          || !Number.isSafeInteger(body.sequence) || body.sequence < 1) {
          throw Object.assign(new Error('页面连接标识无效'), {
            code:'INVALID_CLIENT_LEASE', statusCode:400,
          });
        }
        const registration = registerLauncherClientLease(body);
        if (registration.staleLease) {
          sendJson(response, 200, { status:state, staleLease:true });
          return;
        }
        if (state === 'deck-selected' && candidate) {
          sendJson(response, 200, publicCandidate('deck-selected'));
        } else if (state === 'creation-project-selected' && creationCandidate) {
          sendJson(response, 200, publicCreationCandidate('creation-project-selected'));
        } else if (state === 'selected' && handoffEditorUrl) {
          sendJson(response, 200, { status:'selected', editorUrl:handoffEditorUrl });
        } else {
          sendJson(response, 200, { status:state });
        }
        return;
      }

      if (requestUrl.pathname === '/api/reset-selection') {
        if (!['idle', 'deck-selected', 'creation-project-selected'].includes(state)) {
          throw Object.assign(new Error('当前操作完成前不能返回首页'), {
            code:'INVALID_APP_STATE', statusCode:409,
          });
        }
        candidate = null;
        creationCandidate = null;
        creationPickerPreviousState = null;
        deckPickerPreviousState = null;
        selectionRevision += 1;
        state = 'idle';
        sendJson(response, 200, { status:'idle' });
        return;
      }

      if (requestUrl.pathname === '/api/leave-workspace') {
        const body = await readJson(request);
        if (!['home', 'creation', 'editing'].includes(body.destination)) {
          throw Object.assign(new Error('工作台导航目标无效'), {
            code:'INVALID_WORKSPACE_DESTINATION', statusCode:400,
          });
        }
        if (!['idle', 'building', 'selected'].includes(state)) {
          throw Object.assign(new Error('当前操作完成前不能切换项目'), {
            code:'INVALID_APP_STATE', statusCode:409,
          });
        }
        if (state !== 'idle') await leaveWorkspace();
        sendJson(response, 200, { status:'idle', destination:body.destination });
        return;
      }

      if (requestUrl.pathname.startsWith('/api/project-lifecycle/')) {
        if (state !== 'idle') throw Object.assign(new Error('请返回项目首页后操作'), { code:'INVALID_APP_STATE', statusCode:409 });
        const action = requestUrl.pathname.split('/').at(-1);
        const commands = { begin:'beginRemoval', complete:'completeRemoval', cancel:'cancelRemoval', restore:'restoreProject' };
        if (!commands[action]) throw Object.assign(new Error('项目生命周期操作无效'), { statusCode:400 });
        const input = await readJson(request);
        // 仅当前 App 拥有的空闲 Draft 租约可由本流程移除，不能信任客户端声明所有权。
        input.ownsCreationLease = false;
        if (action === 'begin') {
          const item = (await activeWorkCatalog.list()).creation.find(entry => entry.workId === input.workId);
          input.ownsCreationLease = Boolean(item && creationRuntimes.has(creationRuntimeKey(item)));
        }
        const workItem = await activeWorkCatalog[commands[action]](input);
        sendJson(response, 200, { workItem });
        return;
      }

      if (requestUrl.pathname === '/api/work-history/dismiss') {
        if (embeddedMode === 'dsh') throw Object.assign(new Error('请通过项目移除流程归档关联会话'), { code:'PROJECT_LIFECYCLE_REQUIRED', statusCode:409 });
        if (state !== 'idle') throw Object.assign(new Error('只能在首页删除任务记录'), {
          code:'INVALID_APP_STATE', statusCode:409,
        });
        const body = await readJson(request);
        const catalog = await activeWorkCatalog.list();
        let workItem = [...catalog.creation, ...catalog.editing].find(
          entry => entry.workId === body.workId,
        );
        if (body.kind === 'creation') {
          if (typeof body.projectRoot !== 'string' || typeof body.draftId !== 'string') {
            throw Object.assign(new Error('Creation 任务记录标识不完整'), {
              code:'INVALID_WORK_HISTORY_ENTRY', statusCode:400,
            });
          }
          await workHistoryStore.dismissCreation({
            projectRoot:body.projectRoot,
            draftId:body.draftId,
          });
          workItem ??= catalog.creation.find(entry => (
            entry.projectRoot === resolve(body.projectRoot) && entry.draftId === body.draftId
          ));
        } else if (body.kind === 'editing') {
          if (typeof body.deckPath !== 'string') {
            throw Object.assign(new Error('Deck 任务记录路径不完整'), {
              code:'INVALID_WORK_HISTORY_ENTRY', statusCode:400,
            });
          }
          await workHistoryStore.dismissDeck(body.deckPath);
          workItem ??= catalog.editing.find(entry => entry.deckPath === resolve(body.deckPath));
        } else {
          throw Object.assign(new Error('任务记录类型无效'), {
            code:'INVALID_WORK_HISTORY_ENTRY', statusCode:400,
          });
        }
        if (workItem) {
          await activeWorkCatalog.dismiss({
            workId:workItem.workId,
            expectedRevision:body.expectedRevision ?? workItem.revision,
          });
        }
        sendJson(response, 200, { status:'dismissed', kind:body.kind });
        return;
      }

      if (requestUrl.pathname === '/api/work-items/rename') {
        const body = await readJson(request);
        const workItem = await activeWorkCatalog.rename({
          workId:body.workId,
          displayName:body.displayName,
          expectedRevision:body.expectedRevision,
        });
        sendJson(response, 200, { status:'renamed', workItem });
        return;
      }

      if (requestUrl.pathname === '/api/dsh-work-items/set-workspace') {
        if (embeddedMode !== 'dsh') throw Object.assign(new Error('当前不是 DSH 嵌入模式'), {
          code:'DSH_BRIDGE_UNAVAILABLE', statusCode:409,
        });
        const workItem = synchronizeRuntimeDshBinding(await activeWorkCatalog.setDshWorkspace(
          await readJson(request),
        ));
        sendJson(response, 200, { status:'updated', workItem });
        return;
      }

      if (requestUrl.pathname === '/api/dsh-work-items/begin-session') {
        if (embeddedMode !== 'dsh') throw Object.assign(new Error('当前不是 DSH 嵌入模式'), {
          code:'DSH_BRIDGE_UNAVAILABLE', statusCode:409,
        });
        const workItem = await activeWorkCatalog.beginDshSessionProvision(await readJson(request));
        sendJson(response, 200, { status:'pending', workItem });
        return;
      }

      if (requestUrl.pathname === '/api/dsh-work-items/complete-session') {
        if (embeddedMode !== 'dsh') throw Object.assign(new Error('当前不是 DSH 嵌入模式'), {
          code:'DSH_BRIDGE_UNAVAILABLE', statusCode:409,
        });
        const workItem = synchronizeRuntimeDshBinding(
          await activeWorkCatalog.completeDshSessionProvision(await readJson(request)),
        );
        sendJson(response, 200, { status:'linked', workItem });
        return;
      }

      if (requestUrl.pathname === '/api/dsh-work-items/fail-session') {
        if (embeddedMode !== 'dsh') throw Object.assign(new Error('当前不是 DSH 嵌入模式'), {
          code:'DSH_BRIDGE_UNAVAILABLE', statusCode:409,
        });
        const workItem = synchronizeRuntimeDshBinding(
          await activeWorkCatalog.failDshSessionProvision(await readJson(request)),
        );
        sendJson(response, 200, { status:'recovered', workItem });
        return;
      }

      if (requestUrl.pathname === '/api/dsh-work-items/activate-session') {
        if (embeddedMode !== 'dsh') throw Object.assign(new Error('当前不是 DSH 嵌入模式'), {
          code:'DSH_BRIDGE_UNAVAILABLE', statusCode:409,
        });
        const workItem = synchronizeRuntimeDshBinding(
          await activeWorkCatalog.activateDshSession(await readJson(request)),
        );
        sendJson(response, 200, { status:'active', workItem });
        return;
      }

      if (requestUrl.pathname === '/api/dsh-work-items/archive-sessions') {
        if (embeddedMode !== 'dsh') throw Object.assign(new Error('当前不是 DSH 嵌入模式'), {
          code:'DSH_BRIDGE_UNAVAILABLE', statusCode:409,
        });
        const workItem = synchronizeRuntimeDshBinding(
          await activeWorkCatalog.archiveDshSessions(await readJson(request)),
        );
        sendJson(response, 200, { status:'archived', workItem });
        return;
      }

      if (requestUrl.pathname === '/api/dsh-work-items/editing-context') {
        if (embeddedMode !== 'dsh') throw Object.assign(new Error('当前不是 DSH 嵌入模式'), {
          code:'DSH_BRIDGE_UNAVAILABLE', statusCode:409,
        });
        const { sessionId } = await readJson(request);
        const result = await resolveEditingContext({
          sessionId, workCatalog:activeWorkCatalog, findEditingRuntime,
          findCreationRuntime:workItem => creationRuntimes.get(creationRuntimeKey(workItem)),
        });
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/dsh-work-items/complete-restore') {
        if (embeddedMode !== 'dsh') throw Object.assign(new Error('当前不是 DSH 嵌入模式'), { statusCode:409 });
        const workItem = await activeWorkCatalog.completeDshRestore(await readJson(request));
        sendJson(response, 200, { workItem });
        return;
      }

      if (requestUrl.pathname === '/api/dsh-work-items/restore-session') {
        if (embeddedMode !== 'dsh') throw Object.assign(new Error('当前不是 DSH 嵌入模式'), { code:'DSH_BRIDGE_UNAVAILABLE', statusCode:409 });
        const workItem = await activeWorkCatalog.restoreDshSession(await readJson(request));
        sendJson(response, 200, { workItem });
        return;
      }

      if (requestUrl.pathname === '/api/dsh-work-items/resolve-session') {
        if (embeddedMode !== 'dsh') throw Object.assign(new Error('当前不是 DSH 嵌入模式'), {
          code:'DSH_BRIDGE_UNAVAILABLE', statusCode:409,
        });
        const { sessionId, includeRemoved } = await readJson(request);
        const workItem = await activeWorkCatalog.resolveByDshSession(sessionId, { includeRemoved:includeRemoved === true });
        sendJson(response, 200, { status:workItem ? 'linked' : 'unlinked', workItem });
        return;
      }

      if (requestUrl.pathname === '/api/creation-dsh-requests/acknowledge') {
        if (embeddedMode !== 'dsh' || !creationTerminal?.acknowledge) {
          throw Object.assign(new Error('当前没有可接收回执的 DSH Creation 请求'), {
            code:'DSH_CREATION_BRIDGE_UNAVAILABLE', statusCode:409,
          });
        }
        sendJson(response, 200, creationTerminal.acknowledge(await readJson(request)));
        return;
      }

      if (requestUrl.pathname === '/api/work-items/choose-rebind-file') {
        if (state !== 'idle') throw Object.assign(new Error('当前不能重新绑定 Deck 文件'), {
          code:'INVALID_APP_STATE', statusCode:409,
        });
        const body = await readJson(request);
        const current = await activeWorkCatalog.resolve(body.workId);
        if (current.kind !== 'editing') throw Object.assign(new Error('工作项不是可编辑 Deck'), {
          code:'INVALID_WORK_ITEM_KIND', statusCode:400,
        });
        state = 'choosing-rebind';
        const picker = new AbortController();
        activePicker = picker;
        let selectedPath;
        try {
          selectedPath = await pickDeck({ signal:picker.signal });
        } finally {
          if (activePicker === picker) activePicker = null;
          if (state === 'choosing-rebind') state = 'idle';
        }
        if (selectedPath === null) {
          sendJson(response, 200, { status:'cancelled', workItem:current });
          return;
        }
        const workItem = await activeWorkCatalog.rebindEditing({
          workId:current.workId,
          candidatePath:selectedPath,
          confirmation:'same-file',
          expectedBindingRevision:current.binding.revision,
        });
        sendJson(response, 200, { status:'rebound', workItem });
        return;
      }

      if (requestUrl.pathname === '/api/choose-recent-deck') {
        if (state !== 'idle') throw Object.assign(new Error('当前不能加载最近 Deck'), {
          code:'INVALID_APP_STATE', statusCode:409,
        });
        const body = await readJson(request);
        const deckPath = await recentDeckStore.resolve(body.deckPath);
        if (!deckPath) throw Object.assign(new Error('这份最近 Deck 已移动或删除'), {
          code:'RECENT_DECK_NOT_FOUND', statusCode:404,
        });
        const project = await resolveAgentProject({
          deckPath,
          launchCwd:process.cwd(),
        });
        candidate = {
          nonce:randomUUID(),
          revision:selectionRevision += 1,
          deckPath,
          deckName:basename(deckPath),
          project,
          provider:agentProvider,
        };
        state = 'deck-selected';
        sendJson(response, 200, publicCandidate('deck-selected'));
        return;
      }

      if (requestUrl.pathname === '/api/resume-deck') {
        if (!['idle', 'selected'].includes(state)) throw Object.assign(new Error('当前不能恢复 Deck 任务'), {
          code:'INVALID_APP_STATE', statusCode:409,
        });
        const body = await readJson(request);
        const resolvedWorkItem = typeof body.workId === 'string'
          ? await activeWorkCatalog.resolve(body.workId)
          : null;
        if (resolvedWorkItem && resolvedWorkItem.kind !== 'editing') {
          throw Object.assign(new Error('工作项不是可编辑 Deck'), {
            code:'INVALID_WORK_ITEM_KIND', statusCode:400,
          });
        }
        const resolvedRuntime = resolvedWorkItem ? findEditingRuntime({
          deckId:resolvedWorkItem.deckId,
          deckPath:resolvedWorkItem.deckPath,
        }) : null;
        if (resolvedRuntime) {
          activateEditingRuntime(resolvedRuntime);
          state = 'selected';
          sendJson(response, 200, {
            ...publicCandidate('selected'),
            editorUrl:resolvedRuntime.editorUrl,
            resumed:true,
            runtimeReused:true,
          });
          return;
        }
        const canOpenProtectedWorkingCopy = resolvedWorkItem?.binding.state === 'conflict'
          && resolvedWorkItem.binding.reason === 'replaced';
        if (resolvedWorkItem && resolvedWorkItem.binding.state !== 'bound'
          && !canOpenProtectedWorkingCopy) {
          throw Object.assign(new Error('这份 Deck 需要先重新绑定源文件'), {
            code:'DECK_REBIND_REQUIRED', statusCode:409,
            binding:resolvedWorkItem.binding,
          });
        }
        const deckPath = resolvedWorkItem?.deckPath
          ?? await workHistoryStore.resolveDeck(body.deckPath);
        if (!deckPath) throw Object.assign(new Error('这份 Deck 已移动或删除'), {
          code:'RECENT_DECK_NOT_FOUND', statusCode:404,
        });
        const catalogHistory = await activeWorkCatalog.list();
        const comparableDeckPath = await canonicalDeckLocator(deckPath);
        const catalogWorkItem = resolvedWorkItem
          ?? catalogHistory.editing.find(item => item.deckPath === comparableDeckPath)
          ?? null;
        const runtimeKey = await deckRuntimeKey(deckPath, catalogWorkItem?.deckId);
        const existingRuntime = findEditingRuntime({
          deckId:catalogWorkItem?.deckId,
          deckPath,
        });
        if (existingRuntime) {
          activateEditingRuntime(existingRuntime);
          state = 'selected';
          sendJson(response, 200, {
            ...publicCandidate('selected'),
            editorUrl:existingRuntime.editorUrl,
            resumed:true,
            runtimeReused:true,
          });
          return;
        }
        if (state === 'selected') await leaveWorkspace();
        const history = await runtimeAwareHistory();
        const entry = catalogWorkItem
          ?? history.editing.find(item => item.deckPath === comparableDeckPath) ?? {};
        const selectedProvider = isAgentProviderId(entry.provider)
          ? entry.provider : agentProvider;
        const project = await resolveAgentProject({
          deckPath,
          persistedRoot:entry.projectRoot ?? null,
          launchCwd:process.cwd(),
        });
        candidate = {
          nonce:randomUUID(),
          revision:selectionRevision += 1,
          deckPath,
          deckName:basename(deckPath),
          project,
          provider:selectedProvider,
          workId:entry.workId ?? null,
          deckId:entry.deckId ?? null,
        };
        if (project.needsConfirmation) {
          state = 'deck-selected';
          sendJson(response, 200, publicCandidate('deck-selected'));
          return;
        }
        await assertAgentProject(project);
        state = 'starting-editor';
        let editorUrl;
        try {
          editorUrl = await startDeckEditor(candidate, selectedProvider);
        } catch (error) {
          candidate = null;
          state = 'idle';
          throw error;
        }
        state = 'selected';
        sendJson(response, 200, { ...publicCandidate('selected'), editorUrl, resumed:true });
        return;
      }

      if (requestUrl.pathname === '/api/choose-creation-project') {
        if (state === 'choosing-creation-project') {
          sendJson(response, 409, {
            code:'PROJECT_SELECTION_IN_PROGRESS', message:'项目目录选择器已经打开',
          });
          return;
        }
        if (!['idle', 'creation-project-selected'].includes(state)) throw Object.assign(new Error('当前不能新建 Deck'), {
          code:'INVALID_APP_STATE', statusCode:409,
        });
        const previousCreationState = state;
        creationPickerPreviousState = previousCreationState;
        state = 'choosing-creation-project';
        const picker = new AbortController();
        activePicker = picker;
        let selectedPath;
        try {
          selectedPath = await pickAgentProjectDirectory({
            signal:picker.signal, defaultPath:creationCandidate?.project.path,
          });
        } finally {
          if (activePicker === picker) activePicker = null;
        }
        if (state === 'closed') {
          response.destroy();
          return;
        }
        if (selectedPath === null) {
          state = previousCreationState;
          creationPickerPreviousState = null;
          sendJson(response, 200, previousCreationState === 'creation-project-selected'
            ? publicCreationCandidate('cancelled')
            : { status:'cancelled' });
          return;
        }
        creationCandidate = {
          nonce:randomUUID(),
          revision:selectionRevision += 1,
          project:await resolveCreationProject({ selectedPath }),
          provider:agentProvider,
        };
        creationPickerPreviousState = null;
        state = 'creation-project-selected';
        sendJson(response, 200, publicCreationCandidate('creation-project-selected'));
        return;
      }

      if (requestUrl.pathname === '/api/creation-drafts') {
        const body = await readJson(request);
        if (!creationCandidate
          || body.candidateNonce !== creationCandidate.nonce
          || body.selectionRevision !== creationCandidate.revision) {
          throw Object.assign(new Error('项目目录候选已变化，请重新选择'), {
            code:'STALE_PROJECT_CANDIDATE', statusCode:409,
          });
        }
        if (state !== 'creation-project-selected') throw Object.assign(new Error('当前不能创建 Draft'), {
          code:'INVALID_APP_STATE', statusCode:409,
        });
        if (!isAgentProviderId(body.provider)) {
          throw Object.assign(new Error('Agent provider 不受支持'), {
            code:'INVALID_AGENT_PROVIDER', statusCode:400,
          });
        }
        if (creationCandidate.project.needsConfirmation && body.confirmProjectRoot !== true) {
          throw Object.assign(new Error('项目目录范围过宽，需要明确确认'), {
            code:'PROJECT_ROOT_CONFIRMATION_REQUIRED', statusCode:409,
          });
        }
        await assertAgentProject(creationCandidate.project);
        state = 'creating-draft';
        try {
          const workspace = await createCreationWorkspace({
            serviceUrl:serviceOrigin,
            projectRoot:creationCandidate.project.path,
            provider:body.provider,
            pythonExecutable,
            openManagedDeck:openCreationManagedDeck,
          });
          const project = creationCandidate.project;
          await attachCreationRuntime({
            workspace, project, provider:body.provider, resumed:false,
          });
          await workHistoryStore.recordCreation({
            projectRoot:project.path,
            draftId:workspace.snapshot().draftId,
            provider:body.provider,
          }).catch(() => {});
        } catch (error) {
          state = 'creation-project-selected';
          throw error;
        }
        creationCandidate.provider = body.provider;
        state = 'building';
        const workItem = await workItemForCreation(creationWorkspace.snapshot());
        sendJson(response, 201, {
          status:'building',
          draft:creationWorkspace.snapshot(),
          workItem,
          templates:creationWorkspace.templates(),
          terminal:creationTerminal.snapshot(),
          ...(embeddedMode === 'dsh' ? {
            dshPrompt:buildCreationInitializationPrompt({
              projectRoot:creationWorkspace.snapshot().projectRoot,
              capabilityPath:creationWorkspace.capabilityPath,
            }),
          } : {}),
        });
        scheduleCreationClientClose();
        return;
      }

      if (requestUrl.pathname === '/api/resume-creation-draft') {
        if (state !== 'idle') throw Object.assign(new Error('当前不能恢复 Creation Draft'), {
          code:'INVALID_APP_STATE', statusCode:409,
        });
        const body = await readJson(request);
        const entry = await workHistoryStore.resolveCreation({
          projectRoot:body.projectRoot,
          draftId:body.draftId,
        });
        if (!entry) throw Object.assign(new Error('这份 Creation Draft 已移动或删除'), {
          code:'CREATION_DRAFT_NOT_FOUND', statusCode:404,
        });
        const existingRuntime = creationRuntimes.get(creationRuntimeKey(entry));
        if (existingRuntime) {
          activateCreationRuntime(existingRuntime);
          state = 'building';
          await workHistoryStore.recordCreation({
            projectRoot:entry.projectRoot,
            draftId:entry.draftId,
            provider:existingRuntime.candidate.provider,
          }).catch(() => {});
          sendJson(response, 200, {
            status:'building',
            resumed:true,
            runtimeReused:true,
            draft:existingRuntime.workspace.snapshot(),
            workItem:await workItemForCreation(existingRuntime.workspace.snapshot()),
            templates:existingRuntime.workspace.templates(),
            terminal:existingRuntime.terminal.snapshot(),
            ...(embeddedMode === 'dsh' ? {
              dshPrompt:buildCreationResumePrompt({
                snapshot:existingRuntime.workspace.snapshot(),
                capabilityPath:existingRuntime.workspace.capabilityPath,
              }),
            } : {}),
          });
          return;
        }
        state = 'resuming-draft';
        let workspace = null;
        try {
          const project = await resolveCreationProject({ selectedPath:entry.projectRoot });
          await assertAgentProject(project);
          workspace = await openCreationWorkspace({
            serviceUrl:serviceOrigin,
            projectRoot:entry.projectRoot,
            draftId:entry.draftId,
            pythonExecutable,
            openManagedDeck:openCreationManagedDeck,
          });
          await attachCreationRuntime({
            workspace,
            project,
            provider:entry.provider,
            resumed:true,
          });
          await workHistoryStore.recordCreation({
            projectRoot:entry.projectRoot,
            draftId:entry.draftId,
            provider:entry.provider,
          }).catch(() => {});
        } catch (error) {
          await workspace?.close?.({ reason:'resume-failed' }).catch(() => {});
          creationWorkspace = null;
          creationTerminal = null;
          creationCandidate = null;
          state = 'idle';
          throw error;
        }
        state = 'building';
        const workItem = await workItemForCreation(creationWorkspace.snapshot());
        sendJson(response, 200, {
          status:'building',
          resumed:true,
          draft:creationWorkspace.snapshot(),
          workItem,
          templates:creationWorkspace.templates(),
          terminal:creationTerminal.snapshot(),
          ...(embeddedMode === 'dsh' ? {
            dshPrompt:buildCreationResumePrompt({
              snapshot:creationWorkspace.snapshot(),
              capabilityPath:creationWorkspace.capabilityPath,
            }),
          } : {}),
        });
        scheduleCreationClientClose();
        return;
      }

      if (requestUrl.pathname === '/api/creation-draft/commands') {
        if (!requestCreationWorkspace
          || (!agentAuthorized && !['building', 'handing-off'].includes(state))) {
          throw Object.assign(new Error('当前没有可修改的 Creation Draft'), {
            code:'CREATION_DRAFT_NOT_FOUND', statusCode:404,
          });
        }
        const command = await readJson(request);
        const receipt = await requestCreationWorkspace.dispatch(command);
        sendJson(response, 200, receipt);
        return;
      }

      if (requestUrl.pathname === '/api/creation-draft/open-editor') {
        if (handoffEditorUrl) {
          sendJson(response, 200, { status:'selected', editorUrl:handoffEditorUrl });
          return;
        }
        if (!creationWorkspace || creationWorkspace.snapshot().phase !== 'ready') {
          throw Object.assign(new Error('Deck 尚未生成并发布'), {
            code:'CREATION_GATE_UNMET', statusCode:409,
          });
        }
        state = 'handing-off';
        const draft = creationWorkspace.snapshot();
        const sourceRuntime = activeCreationRuntime();
        const creationWorkItem = await workItemForCreation(draft);
        let app;
        let runtimeKey;
        let publishedDeckPath;
        try {
          publishedDeckPath = await realpath(draft.generation.publishedDeck)
            .catch(() => resolve(draft.generation.publishedDeck));
          runtimeKey = await deckRuntimeKey(publishedDeckPath);
          app = creationWorkspace.takePublishedEditor();
        } catch (error) {
          state = 'building';
          throw error;
        }
        const handoffCandidate = {
          nonce:randomUUID(),
          revision:selectionRevision += 1,
          deckPath:publishedDeckPath,
          deckName:basename(publishedDeckPath),
          project:sourceRuntime?.candidate.project ?? {
            path:draft.projectRoot,
            source:'creation-draft',
            needsConfirmation:false,
            warning:null,
            identity:{ originalPath:draft.projectRoot, realPath:draft.projectRoot },
          },
          provider:draft.provider,
        };
        await workHistoryStore.recordDeck({
          deckPath:draft.generation.publishedDeck,
          ...(creationWorkItem ? { workId:creationWorkItem.workId } : {}),
          provider:draft.provider,
          projectRoot:draft.projectRoot,
        }).catch(() => {});
        await workHistoryStore.completeCreation({
          projectRoot:draft.projectRoot,
          draftId:draft.draftId,
        }).catch(() => {});
        let editingWorkItem = null;
        if (creationWorkItem && app?.deckId && typeof app.binding?.snapshot === 'function') {
          editingWorkItem = await activeWorkCatalog.promoteCreationToEditing({
            workId:creationWorkItem.workId,
            deckPath:publishedDeckPath,
            deckId:app.deckId,
            binding:app.binding.snapshot(),
            provider:draft.provider,
            projectRoot:draft.projectRoot,
          });
          handoffCandidate.workId = editingWorkItem.workId;
          handoffCandidate.deckId = editingWorkItem.deckId;
          handoffCandidate.binding = editingWorkItem.binding;
          handoffCandidate.workItem = editingWorkItem;
          runtimeKey = editingWorkItem.deckId;
        }
        const editingRuntime = {
          key:runtimeKey,
          taskId:app.session?.sessionId ?? runtimeKey,
          deckPath:publishedDeckPath,
          app,
          terminal:creationTerminal,
          dshSessionId:editingWorkItem?.dshBinding?.activeSessionId ?? null,
          candidate:handoffCandidate,
          terminalHandedOff:true,
          editorUrl:editorUrlWithWorkspaceNavigation(app, 'editing'),
        };
        editingRuntimes.set(runtimeKey, editingRuntime);
        sourceRuntime?.unsubscribe?.();
        if (sourceRuntime) creationRuntimes.delete(sourceRuntime.key);
        await sourceRuntime?.workspace.close({ reason:'handoff' });
        activateEditingRuntime(editingRuntime);
        state = 'selected';
        sendJson(response, 200, {
          status:'selected',
          editorUrl:editingRuntime.editorUrl,
          ...(editingWorkItem ? { workItem:editingWorkItem } : {}),
        });
        return;
      }

      if (requestUrl.pathname === '/api/choose-deck') {
        if (state === 'choosing-deck') {
          sendJson(response, 409, {
            code:'DECK_SELECTION_IN_PROGRESS', message:'系统文件选择器已经打开',
          });
          return;
        }
        if (!['idle', 'deck-selected'].includes(state)) {
          sendJson(response, 409, {
            code:'INVALID_APP_STATE', message:'当前不能重新选择 Deck',
          });
          return;
        }
        const previousDeckState = state;
        deckPickerPreviousState = previousDeckState;
        state = 'choosing-deck';
        const picker = new AbortController();
        activePicker = picker;
        let deckPath;
        try {
          deckPath = await pickDeck({ signal:picker.signal });
        } finally {
          if (activePicker === picker) activePicker = null;
        }
        if (state === 'closed') {
          response.destroy();
          return;
        }
        if (!deckPath) {
          state = previousDeckState;
          deckPickerPreviousState = null;
          sendJson(response, 200, { status:'cancelled' });
          return;
        }
        const project = await resolveAgentProject({
          deckPath,
          launchCwd:process.cwd(),
        });
        candidate = {
          nonce:randomUUID(),
          revision:selectionRevision += 1,
          deckPath,
          deckName:basename(deckPath),
          project,
          provider:agentProvider,
        };
        deckPickerPreviousState = null;
        state = 'deck-selected';
        sendJson(response, 200, publicCandidate('deck-selected'));
        return;
      }

      if (requestUrl.pathname === '/api/choose-agent-project') {
        if (state === 'choosing-project') {
          sendJson(response, 409, {
            code:'PROJECT_SELECTION_IN_PROGRESS', message:'项目目录选择器已经打开',
          });
          return;
        }
        const body = await readJson(request);
        const selectedCandidate = requireCandidate(body);
        if (state !== 'deck-selected') throw Object.assign(new Error('当前不能更改项目目录'), {
          code:'INVALID_APP_STATE', statusCode:409,
        });
        state = 'choosing-project';
        const picker = new AbortController();
        activePicker = picker;
        let selectedPath;
        try {
          selectedPath = await pickAgentProjectDirectory({
            signal:picker.signal, defaultPath:selectedCandidate.project.path,
          });
        } finally {
          if (activePicker === picker) activePicker = null;
        }
        if (state === 'closed') {
          response.destroy();
          return;
        }
        if (selectedPath === null) {
          state = 'deck-selected';
          sendJson(response, 200, publicCandidate('cancelled'));
          return;
        }
        selectedCandidate.project = await resolveAgentProject({
          deckPath:selectedCandidate.deckPath,
          explicitRoot:selectedPath,
        });
        selectedCandidate.revision = selectionRevision += 1;
        state = 'deck-selected';
        sendJson(response, 200, publicCandidate('project-selected'));
        return;
      }

      if (requestUrl.pathname === '/api/open-deck') {
        const body = await readJson(request);
        const selectedCandidate = requireCandidate(body);
        if (state !== 'deck-selected') throw Object.assign(new Error('当前不能打开编辑器'), {
          code:'INVALID_APP_STATE', statusCode:409,
        });
        if (!isAgentProviderId(body.provider)) {
          throw Object.assign(new Error('Agent provider 不受支持'), {
            code:'INVALID_AGENT_PROVIDER', statusCode:400,
          });
        }
        if (selectedCandidate.project.needsConfirmation && body.confirmProjectRoot !== true) {
          throw Object.assign(new Error('项目目录范围过宽，需要明确确认'), {
            code:'PROJECT_ROOT_CONFIRMATION_REQUIRED', statusCode:409,
          });
        }
        await assertAgentProject(selectedCandidate.project);
        state = 'starting-editor';
        let editorUrl;
        try {
          editorUrl = await startDeckEditor(selectedCandidate, body.provider);
        } catch (error) {
          state = 'deck-selected';
          throw error;
        }
        state = 'selected';
        sendJson(response, 200, {
          ...publicCandidate('selected'),
          editorUrl,
        });
        return;
      }

      sendJson(response, 404, { code:'NOT_FOUND', message:'接口不存在' });
    } catch (error) {
      activePicker = null;
      if (state === 'choosing-deck') state = deckPickerPreviousState ?? 'idle';
      if (state === 'choosing-rebind') state = 'idle';
      deckPickerPreviousState = null;
      if (state === 'choosing-project') state = 'deck-selected';
      if (state === 'choosing-creation-project') state = creationPickerPreviousState ?? 'idle';
      if (state === 'choosing-onboarding-directory') state = 'idle';
      creationPickerPreviousState = null;
      if (state === 'closed') {
        response.destroy();
        return;
      }
      sendJson(response, error.statusCode ?? 500, {
        code:error.code ?? 'APP_OPERATION_FAILED',
        message:error.message || '导入页操作失败',
        ...(typeof error.stage === 'string' ? { stage:error.stage } : {}),
        ...(typeof error.recovery === 'string' ? { recovery:error.recovery } : {}),
        ...(typeof error.diagnostic === 'string' ? { diagnostic:error.diagnostic } : {}),
      });
    }
  });

  const launcherLeaseOriginAllowed = origin => {
    if (origin === undefined || origin === serviceOrigin) return true;
    return [...editingRuntimes.values()].some(runtime => {
      try { return new URL(runtime.app?.url).origin === origin; }
      catch { return false; }
    });
  };

  server.on('upgrade', (request, socket, head) => {
    let requestUrl;
    try { requestUrl = new URL(request.url ?? '/', serviceOrigin || `http://${urlHost}`); }
    catch {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (requestUrl.pathname === '/launcher-lease') {
      if (!tokenMatches(requestUrl.searchParams.get('token'), token)
        || !launcherLeaseOriginAllowed(request.headers.origin)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      const clientId = requestUrl.searchParams.get('clientId');
      const sequence = Number(requestUrl.searchParams.get('sequence'));
      if (!clientId || !Number.isSafeInteger(sequence) || sequence < 1) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
      }
      launcherSockets.handleUpgrade(request, socket, head, client => {
        client.launcherLease = { clientId, sequence };
        launcherSockets.emit('connection', client, request);
      });
      return;
    }
    if (!['/creation-events', '/agent-terminal'].includes(requestUrl.pathname)
      || !tokenMatches(requestUrl.searchParams.get('token'), token)
      || !tokenMatches(requestUrl.searchParams.get('editorToken'), token)
      || !creationWorkspace) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    if (request.headers.origin !== undefined && request.headers.origin !== serviceOrigin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const target = requestUrl.pathname === '/agent-terminal' ? terminalSockets : eventSockets;
    target.handleUpgrade(request, socket, head, client => target.emit('connection', client, request));
  });

  launcherSockets.on('connection', socket => {
    const lease = socket.launcherLease;
    const registration = registerLauncherClientLease(lease);
    if (registration.staleLease) {
      socket.close(1008, '页面租约已过期');
      return;
    }
    const key = clientLeaseKey(lease);
    const clients = launcherLeaseSockets.get(key) ?? new Set();
    clients.add(socket);
    launcherLeaseSockets.set(key, clients);
    cancelLauncherLeaseHandshake(lease);
    socket.on('close', () => {
      clients.delete(socket);
      if (clients.size > 0) return;
      launcherLeaseSockets.delete(key);
      setImmediate(() => scheduleLauncherClientClose(lease));
    });
  });

  eventSockets.on('connection', socket => {
    cancelCreationClientClose();
    if (creationWorkspace) {
      socket.send(JSON.stringify({
        type:'creation-draft-snapshot',
        revision:creationWorkspace.snapshot().revision,
      }));
    }
    socket.on('close', () => setImmediate(scheduleCreationClientClose));
  });

  terminalSockets.on('connection', socket => {
    if (!creationTerminal) {
      socket.close(1011, 'Agent 终端尚未创建');
      return;
    }
    const detach = creationTerminal.attach(socket);
    let commandChain = Promise.resolve();
    socket.on('message', data => {
      commandChain = commandChain.then(async () => {
        let message;
        try { message = JSON.parse(String(data)); }
        catch { throw Object.assign(new Error('终端消息不是有效 JSON'), { code:'INVALID_TERMINAL_MESSAGE' }); }
        if (message.type === 'start') {
          await creationTerminal.start({ provider:message.provider, cols:message.cols, rows:message.rows });
        } else if (message.type === 'restart') {
          await creationTerminal.restart({
            provider:message.provider,
            cols:message.cols,
            rows:message.rows,
            newConversation:message.newConversation === true,
          });
        } else if (message.type === 'input') {
          creationTerminal.input(message.data);
        } else if (message.type === 'resize') {
          creationTerminal.resize(message.cols, message.rows);
        } else {
          throw Object.assign(new Error('未知终端命令'), { code:'INVALID_TERMINAL_MESSAGE' });
        }
      }).catch(error => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type:'error', code:error?.code ?? 'AGENT_TERMINAL_FAILED',
            message:error?.message ?? 'Agent 终端操作失败',
          }));
        }
      });
    });
    socket.on('close', detach);
  });

  const closeLauncher = () => {
    if (launcherClosePromise) return launcherClosePromise;
    cancelCreationClientClose();
    cancelLauncherClientClose();
    for (const timer of launcherLeaseHandshakeTimers.values()) clearTimeout(timer);
    launcherLeaseHandshakeTimers.clear();
    activePicker?.abort();
    activePicker = null;
    if (state !== 'selected') candidate = null;
    for (const client of eventSockets.clients) client.terminate();
    for (const client of terminalSockets.clients) client.terminate();
    for (const client of launcherSockets.clients) client.terminate();
    const eventClosed = new Promise(resolvePromise => eventSockets.close(() => resolvePromise()));
    const terminalClosed = new Promise(resolvePromise => terminalSockets.close(() => resolvePromise()));
    const launcherSocketsClosed = new Promise(resolvePromise => (
      launcherSockets.close(() => resolvePromise())
    ));
    const httpClosed = new Promise(resolvePromise => {
      if (!server.listening) {
        resolvePromise();
        return;
      }
      server.close(() => resolvePromise());
      server.closeIdleConnections?.();
    });
    launcherClosePromise = Promise.all([
      eventClosed, terminalClosed, launcherSocketsClosed, httpClosed,
    ]);
    return launcherClosePromise;
  };

  const close = () => {
    if (appClosePromise) return appClosePromise;
    cancelCreationClientClose();
    cancelLauncherClientClose();
    state = 'closed';
    const creationShutdown = [...creationRuntimes.values()].flatMap(runtime => {
      runtime.unsubscribe?.();
      return [
        runtime.workspace?.close?.({ reason:'server-stop' }) ?? Promise.resolve(),
        runtime.terminal?.close?.() ?? Promise.resolve(),
      ];
    });
    const editingShutdown = [...editingRuntimes.values()].flatMap(runtime => [
      runtime.app?.close?.() ?? Promise.resolve(),
      ...(runtime.terminalHandedOff && runtime.terminal
        ? [runtime.terminal.close?.() ?? Promise.resolve()]
        : []),
    ]);
    creationRuntimes.clear();
    editingRuntimes.clear();
    parkWorkspace();
    appClosePromise = Promise.allSettled([
      closeLauncher(),
      ...creationShutdown,
      ...editingShutdown,
    ]).then(results => {
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(
        failures.map(result => result.reason),
        `关闭桌面导入入口失败：${failures.map(result => (
          result.reason?.message ?? String(result.reason)
        )).join('；')}`,
      );
    });
    return appClosePromise;
  };

  try {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolvePromise();
      });
    });
  } catch (error) {
    await closeLauncher();
    throw error;
  }
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  serviceOrigin = `http://${urlHost}:${actualPort}`;
  return {
    url:serviceOrigin,
    appUrl:workspaceAppUrl(),
    port:actualPort,
    token,
    /** 返回当前归属的视图地址；关闭中的编辑器及整个应用不再接受新连接。 */
    transportViews() {
      if (appClosePromise || launcherClosePromise) return [];
      const editors = [
        ...[...editingRuntimes.values()].map(runtime => runtime.app),
        ...[...creationRuntimes.values()].map(runtime => runtime.workspace?.managedDeck?.editor),
      ];
      return [{ origin:serviceOrigin, token, kind:'app' },
        ...editors.map(editor => editor?.transportEndpoint).filter(Boolean).map(endpoint => ({ ...endpoint, kind:'editor' }))];
    },
    /** 查询自身生命周期及全部编辑工作项，不暴露工作区地址或认证信息。 */
    async restartStatus() {
      const busy=()=>Boolean(appClosePromise||launcherClosePromise||activePicker||creationRuntimes.size
        ||!['idle','selected'].includes(state));
      if(busy())return {version:runtimeVersion,safe:false,reasons:['PPT 正在导入、创建或切换工作项。请先保存并结束操作；创建流程尚未确认可退出时，请手动完全退出并重开 Desktop。']};
      const editors=[...editingRuntimes.values()].map(runtime=>runtime.app);
      const states=await Promise.all(editors.map(editor=>editor.restartStatus()));
      if(busy()||editors.length!==editingRuntimes.size||editors.some(editor=>![...editingRuntimes.values()].some(runtime=>runtime.app===editor)))return {version:runtimeVersion,safe:false,reasons:['PPT 工作项状态发生变化，请重新检查。']};
      const reasons=[...new Set(states.flatMap(value=>value.reasons))].slice(0,5);
      return {version:runtimeVersion,safe:states.every(value=>value.safe),reasons};
    },
    get state() { return state; },
    get editorApp() { return editorApp; },
    get creationTerminal() { return creationTerminal; },
    close,
  };
}

function appHelp() {
  return [
    '用法: node scripts/editor/app-server.mjs [选项]',
    '',
    '选项:',
    '  --host HOST      监听地址（默认 127.0.0.1）',
    '  --port PORT      导入页端口（默认 0，自动分配）',
    '  --python PATH    Python 启动器路径',
    '  --agent-provider ID  新建会话的默认 Agent provider（默认 codex）',
    '  --no-open        不自动打开浏览器',
    '  --help           显示帮助',
  ].join('\n');
}

function parseArguments(argv) {
  let host = '127.0.0.1';
  let port = 0;
  let pythonExecutable = DEFAULT_PYTHON_EXECUTABLE;
  let openBrowser = true;
  let agentProvider = 'codex';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help:true };
    if (argument === '--no-open') {
      openBrowser = false;
      continue;
    }
    if (argument === '--host' || argument === '--port' || argument === '--python'
      || argument === '--agent-provider') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new TypeError(`${argument} 缺少值`);
      if (argument === '--host') host = value;
      else if (argument === '--python') pythonExecutable = value;
      else if (argument === '--agent-provider') agentProvider = value;
      else {
        port = Number(value);
        if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
          throw new TypeError('--port 必须是 0 到 65535 的整数');
        }
      }
      index += 1;
      continue;
    }
    throw new TypeError(`未知参数: ${argument}`);
  }
  if (!isAgentProviderId(agentProvider)) {
    throw new TypeError(`--agent-provider 不受支持：${agentProvider}`);
  }
  return { help:false, host, port, pythonExecutable, openBrowser, agentProvider };
}

function openPage(url) {
  const { command, args } = buildOpenCommand(process.platform, url);
  const opener = spawn(command, args, {
    detached:true, stdio:'ignore', windowsHide:true,
  });
  opener.once('error', () => {});
  opener.unref();
}

export async function runAppServerCli(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${appHelp()}\n`);
    return 0;
  }

  let app;
  try {
    app = await startAppServer(options);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify({ url:app.url, appUrl:app.appUrl })}\n`);
  if (options.openBrowser) openPage(app.appUrl);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return 0;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  process.exitCode = await runAppServerCli();
}
