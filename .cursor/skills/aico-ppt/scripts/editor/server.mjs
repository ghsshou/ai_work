import { connectionDiagnostics } from './connection-diagnostics.mjs';
import {recoverStagedPatches} from './staged-patch-recovery.mjs';
import {EditTimeline} from './edit-timeline.mjs';
import {createEditorViews} from './editor-view.mjs';
import {prepareLocalEdit,inspectLocalSource,LOCAL_EDIT_KINDS} from './local-edit.mjs';
import {verifyEffectiveDeck,withEffectiveDeck,writeVerifiedWorkingPatches} from './effective-deck.mjs';
import {actionKey,compileActionGroups,sourceRebaseActionIds} from './action-compiler.mjs';
import { reconcileSourceActions, reconcileLegacySourceHistory } from './source-action-reconciliation.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, unlinkSync, unwatchFile, watchFile } from 'node:fs';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { isMainModule } from './main-module.mjs';
import { WebSocket, WebSocketServer } from 'ws';
import {
  AgentBatchCoordinator, buildAgentPrompt, buildSessionInitializationPrompt,
} from './agent-runner.mjs';
import {
  createTerminalConversation,
  discoverTerminalConversation,
  resumeTerminalConversation,
} from './agent-terminal-conversation-store.mjs';
import {
  createWorkspaceFromLegacyConnection,
  resolveLegacyConnection,
} from './agent-workspace/legacy-migration.mjs';
import { AgentWorkspaceStore } from './agent-workspace/workspace-store.mjs';
import {
  resolveAgentTerminalCwd,
  resolveProjectRoot,
} from './agent-workspace/project-root.mjs';
import { AttachmentStore } from './attachment-store.mjs';
import { BridgeService } from './bridge-service.mjs';
import {
  buildCreationHandoffPrompt,
  loadCreationHandoffContext,
  persistCreationHandoffContext,
} from './creation-handoff-context.mjs';
import { parseTaskMultipart } from './multipart-task.mjs';
import { exportPptxSnapshot } from './pptx-exporter.mjs';
import { createPptxExportJob } from './pptx-export-job.mjs';
import { pickPptxSaveWithSystemPicker } from './system-picker.mjs';
import { defaultPythonExecutable, pythonUtf8SpawnOptions } from './python-utf8.mjs';
import { openDeckBinding } from './deck-binding-coordinator.mjs';
import { pickDeckWithSystemPicker } from './system-picker.mjs';
import { validateAction, validateTask } from './protocol.mjs';
import { RevisionConflict, SessionStore } from './session-store.mjs';
import { createPersistentSidecarIO } from './sidecar-io.mjs';
import {
  WorkingDeckStore, verifyWorkingPatchReplay,
} from './working-deck-store.mjs';
import { startHeadlessEditorRuntime } from './headless-editor-runtime.mjs';
import {
  removeWorkspaceCapability,
  writeWorkspaceCapability,
} from './workspace-capability.mjs';
import {
  agentProviderDefinition,
  isAgentProviderId,
} from './agent-provider-registry.mjs';
import { loadUiFontAssets } from './ui-font-assets.mjs';
import { createDshAgentRunAdapter } from './dsh-agent-run-adapter.mjs';
import { withLegacyAicoPptEnvironment } from './environment-aliases.mjs';

const DEFAULT_PYTHON_EXECUTABLE = defaultPythonExecutable();
const EDITOR_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(EDITOR_DIR, '../..');
const PUBLIC_DIR = join(EDITOR_DIR, 'public');
const MAX_BODY_BYTES = 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const PPTX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const EDITOR_ASSETS = new Map([
  ['/editor/editor.css', { path: join(PUBLIC_DIR, 'editor.css'), type: 'text/css; charset=utf-8' }],
  ['/editor/editor.mjs', { path: join(PUBLIC_DIR, 'editor.mjs'), type: 'text/javascript; charset=utf-8' }],
  ['/editor/launcher-lease-client.mjs', {
    path:join(PUBLIC_DIR, 'launcher-lease-client.mjs'),
    type:'text/javascript; charset=utf-8',
  }],
  ['/editor/native-controls.mjs', {
    path: join(PUBLIC_DIR, 'native-controls.mjs'), type: 'text/javascript; charset=utf-8',
  }],
  ['/editor/pill-nav.mjs', {
    path: join(PUBLIC_DIR, 'pill-nav.mjs'), type: 'text/javascript; charset=utf-8',
  }],
  ['/editor/toolbar-tooltip.mjs', {
    path: join(PUBLIC_DIR, 'toolbar-tooltip.mjs'), type: 'text/javascript; charset=utf-8',
  }],
  ['/editor/pill-nav.css', {
    path: join(PUBLIC_DIR, 'pill-nav.css'), type: 'text/css; charset=utf-8',
  }],
  ['/editor/guided-tour.mjs', {
    path: join(PUBLIC_DIR, 'guided-tour.mjs'), type: 'text/javascript; charset=utf-8',
  }],
  ['/editor/guided-tour.css', {
    path: join(PUBLIC_DIR, 'guided-tour.css'), type: 'text/css; charset=utf-8',
  }],
  ['/editor/workspace-switcher.mjs', {
    path: join(PUBLIC_DIR, 'workspace-switcher.mjs'), type: 'text/javascript; charset=utf-8',
  }],
  ['/editor/dsh-work-bridge.mjs', {
    path: join(PUBLIC_DIR, 'dsh-work-bridge.mjs'), type: 'text/javascript; charset=utf-8',
  }],
  ['/editor/dsh-project-choice.mjs', { path:join(PUBLIC_DIR, 'dsh-project-choice.mjs'), type:'text/javascript; charset=utf-8' }],
  ['/editor/deck-task-coordinator.mjs', {
    path: join(PUBLIC_DIR, 'deck-task-coordinator.mjs'), type: 'text/javascript; charset=utf-8',
  }],
  ['/editor/agent-terminal-panel.mjs', {
    path: join(PUBLIC_DIR, 'agent-terminal-panel.mjs'), type: 'text/javascript; charset=utf-8',
  }],
  ['/editor/terminal-keyboard.mjs', {
    path: join(PUBLIC_DIR, 'terminal-keyboard.mjs'), type: 'text/javascript; charset=utf-8',
  }],
  ['/editor/editor-shortcuts.mjs', {
    path: join(PUBLIC_DIR, 'editor-shortcuts.mjs'), type: 'text/javascript; charset=utf-8',
  }],
  ['/editor/agent-provider-registry.mjs', {
    path:join(EDITOR_DIR, 'agent-provider-registry.mjs'),
    type:'text/javascript; charset=utf-8',
  }],
  ['/editor/agent-terminal-panel.css', {
    path: join(PUBLIC_DIR, 'agent-terminal-panel.css'), type: 'text/css; charset=utf-8',
  }],
  ['/editor/inspector-panel.mjs', {
    path: join(PUBLIC_DIR, 'inspector-panel.mjs'), type: 'text/javascript; charset=utf-8',
  }],
  ['/editor/action-compiler.mjs', { path: join(EDITOR_DIR, 'action-compiler.mjs'), type: 'text/javascript; charset=utf-8' }],
  ['/editor/history-state.mjs', { path: join(EDITOR_DIR, 'history-state.mjs'), type: 'text/javascript; charset=utf-8' }],
  ['/editor/frame-bridge.mjs', { path: join(PUBLIC_DIR, 'frame-bridge.mjs'), type: 'text/javascript; charset=utf-8' }],
  ['/editor/task-drawer.mjs', { path: join(PUBLIC_DIR, 'task-drawer.mjs'), type: 'text/javascript; charset=utf-8' }],
  ['/editor/ws-client.mjs', { path: join(PUBLIC_DIR, 'ws-client.mjs'), type: 'text/javascript; charset=utf-8' }],
  ['/editor/protocol.mjs', { path: join(EDITOR_DIR, 'protocol.mjs'), type: 'text/javascript; charset=utf-8' }],
  ['/editor/attachment-protocol.mjs', { path: join(EDITOR_DIR, 'attachment-protocol.mjs'), type: 'text/javascript; charset=utf-8' }],
  ['/editor/html2canvas.min.js', {
    get path() { return fileURLToPath(import.meta.resolve('html2canvas/dist/html2canvas.min.js')); },
    type: 'text/javascript; charset=utf-8',
  }],
  ['/editor/xterm.js', {
    get path() { return fileURLToPath(import.meta.resolve('@xterm/xterm/lib/xterm.js')); },
    type: 'text/javascript; charset=utf-8',
  }],
  ['/editor/xterm.css', {
    get path() { return fileURLToPath(import.meta.resolve('@xterm/xterm/css/xterm.css')); },
    type: 'text/css; charset=utf-8',
  }],
  ['/editor/patch-runtime.js', {
    path: join(EDITOR_DIR, 'runtime/patch-runtime.js'),
    type: 'text/javascript; charset=utf-8',
  }],
  ['/editor/huawei-logo.png', {
    path: join(PROJECT_DIR, 'assets/huawei-refs/logos/huawei-横版logo-透明.png'),
    type: 'image/png',
  }],
  ['/editor/edit-deck-icon.png', {
    path: join(EDITOR_DIR, 'app-public/edit-deck-icon.png'),
    type: 'image/png',
  }],
]);

function migrateSessionToPersistentPageIds(state, workingDeck, fingerprintMap = {}) {
  const candidate = structuredClone(state);
  let changed = false;
  const mapKey = value => {
    const mapped = workingDeck.mapLegacyPageKey(value);
    if (mapped !== value) changed = true;
    return mapped;
  };
  const mapTarget = (target, mapper=mapKey) => {
    if (!target || typeof target.pageKey !== 'string') return target;
    return { ...target, pageKey:mapper(target.pageKey) };
  };
  const isRecoverablePageKey = value => (
    /^page-(?:[a-f0-9]{32}|\d{3}-[a-f0-9]{8})$/.test(String(value ?? ''))
  );
  const mapRecoverableKey = value => {
    try { return mapKey(value); }
    catch (error) {
      // 删除页在当前工作副本中不存在，但可能仍能通过 SourceMutation 的版本快照撤销。
      // 保留可信 pageKey 作为历史身份；任意格式的未知 key 仍然拒绝迁移。
      if (isRecoverablePageKey(value)) return value;
      throw error;
    }
  };
  const historyGroups = [...(candidate.groups ?? [])];
  const mapFingerprint = value => {
    const mapped = fingerprintMap[value] ?? value;
    if (mapped !== value) changed = true;
    return mapped;
  };
  const mapSource = source => {
    if (!source || typeof source !== 'object') return;
    source.beforeFingerprint = mapFingerprint(source.beforeFingerprint);
    source.afterFingerprint = mapFingerprint(source.afterFingerprint);
    for (const item of source.solidifiedPatchTransition?.droppedActions ?? []) {
      if (item?.action) {
        item.action.target = mapTarget(item.action.target, mapRecoverableKey);
      }
    }
  };
  for (const group of historyGroups) {
    if (group?.mutationType !== 'source' || !group.source) continue;
    mapSource(group.source);
  }
  for (const entry of candidate.timeline?.entries ?? []) {
    if (entry?.mutation?.kind === 'source' && entry.mutation.source) {
      mapSource(entry.mutation.source);
    }
    for (const action of entry?.mutation?.kind === 'actions'
      ? entry.mutation.actions ?? [] : []) {
      action.target = mapTarget(action.target, mapRecoverableKey);
    }
  }
  if (candidate.sourceEdit) {
    candidate.sourceEdit.beforeFingerprint = mapFingerprint(
      candidate.sourceEdit.beforeFingerprint,
    );
  }
  // 工作副本内嵌补丁是浏览器实际重放并经验证的固化基线，必须先对账再映射。
  // 否则旧 session 中已经失效的 action 会在权威补丁替换前阻断整个启动过程。
  if (!candidate.sourceEdit && Array.isArray(workingDeck.embeddedPatches)
    && !isDeepStrictEqual(candidate.solidifiedActions ?? [], workingDeck.embeddedPatches)) {
    candidate.solidifiedActions = structuredClone(workingDeck.embeddedPatches);
    changed = true;
  }
  for (const action of [
    ...(candidate.solidifiedActions ?? []),
    ...historyGroups.flatMap(group => group.actions ?? []),
  ]) action.target = mapTarget(action.target, mapRecoverableKey);
  for (const task of candidate.tasks ?? []) {
    task.pageKey = mapRecoverableKey(task.pageKey);
    for (const item of task.pageState?.elements ?? []) {
      item.target = mapTarget(item.target, mapRecoverableKey);
    }
    if (Array.isArray(task.candidates)) {
      task.candidates = task.candidates.map(target => mapTarget(target, mapRecoverableKey));
    }
    const targetMissing = !candidate.sourceEdit && workingDeck.managed
      && !workingDeck.pageIds.includes(task.pageKey);
    if (targetMissing && task.targetMissing !== true) {
      task.targetMissing = true;
      changed = true;
    } else if (!candidate.sourceEdit && !targetMissing && 'targetMissing' in task) {
      delete task.targetMissing;
      changed = true;
    }
  }
  if (changed || candidate.workingDeckPath !== workingDeck.path
    || candidate.workingDeckFingerprint !== workingDeck.fingerprint) {
    candidate.workingDeckPath = workingDeck.path;
    candidate.workingDeckFingerprint = workingDeck.fingerprint;
    // pageKey 命名空间改变后必须从工作副本重新采集诊断基线。
    candidate.diagnosticsBaseline = {};
    candidate.diagnosticsCurrent = {};
    candidate.diagnosticsRevision = null;
    changed = true;
  }
  return changed ? candidate : null;
}

async function snapshotEditorAssets(overrides = null, { includeAgentTerminal = true } = {}) {
  if (overrides !== null && !(overrides instanceof Map)) {
    throw new TypeError('editorAssets 必须是 Map 或 null');
  }
  const assets = new Map();
  for (const [pathname, asset] of EDITOR_ASSETS) {
    if (!includeAgentTerminal && ['/editor/xterm.js', '/editor/xterm.css'].includes(pathname)) {
      continue;
    }
    const override = overrides?.get(pathname);
    if (override !== undefined && (!override || typeof override !== 'object'
      || (!Buffer.isBuffer(override.contents) && typeof override.contents !== 'string')
      || typeof override.type !== 'string' || !override.type)) {
      throw new TypeError(`编辑器资源覆盖无效：${pathname}`);
    }
    assets.set(pathname, {
      type:override?.type ?? asset.type,
      contents:override === undefined ? await readFile(asset.path) : Buffer.from(override.contents),
    });
  }
  for (const [pathname, asset] of await loadUiFontAssets()) assets.set(pathname, asset);
  for (const pathname of overrides?.keys() ?? []) {
    if (!EDITOR_ASSETS.has(pathname)) throw new TypeError(`未知编辑器资源覆盖：${pathname}`);
  }
  return assets;
}

function httpError(code, statusCode, message = code) {
  return Object.assign(new Error(message), { code, statusCode });
}

function adapterError(code, statusCode, message) {
  return Object.assign(httpError(code, statusCode, message), {
    stage:'adapter',
    recovery:'检查适配器诊断、目录权限和磁盘空间后重试',
  });
}

function detailedHttpError(code, statusCode, message, details = {}) {
  return Object.assign(httpError(code, statusCode, message), details);
}

function restoreConflictError(expectedFingerprint, actualFingerprint, message, cause) {
  return detailedHttpError('RESTORE_CONFLICT', 409, message, {
    stage:'recovery',
    recovery:'保留磁盘外部版本，重新载入后在新基线上重放补丁',
    expectedFingerprint,
    actualFingerprint,
    cause,
  });
}

function unsafeSidecarError(message, cause) {
  return detailedHttpError('UNSAFE_SIDECAR', 500, message, {
    stage:'sidecar',
    recovery:'移除 sidecar 路径中的符号链接并使用 Deck 同目录下的真实目录后重试',
    diagnostic:typeof cause?.message === 'string'
      ? cause.message.slice(0, 1_024)
      : undefined,
    cause,
  });
}

async function captureDirectoryIdentity(path, label, parentIdentity = null) {
  const absolutePath = resolve(path);
  const info = await lstat(absolutePath, { bigint:true });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} 必须是非符号链接的真实目录`);
  }
  const realPath = await realpath(absolutePath);
  if (parentIdentity && dirname(realPath) !== parentIdentity.realPath) {
    throw new Error(`${label} 真实路径逃逸预期父目录`);
  }
  return {
    path:absolutePath,
    realPath,
    dev:String(info.dev),
    ino:String(info.ino),
    label,
  };
}

async function safeBackupsDirectory(sessionDir, sidecarBoundary) {
  if (!sidecarBoundary) throw new Error('缺少可信 sidecar boundary');
  await sidecarBoundary.guard();
  if (resolve(sessionDir) !== sidecarBoundary.session.path) {
    throw new Error('session 路径与启动身份不一致');
  }
  const backupRoot = sidecarBoundary.backups.path;
  const backupReal = sidecarBoundary.backups.realPath;
  return { backupRoot, backupReal };
}

async function safeTransactionsDirectory(sessionDir, sidecarBoundary) {
  if (!sidecarBoundary) throw new Error('缺少可信 sidecar boundary');
  await sidecarBoundary.guard();
  if (resolve(sessionDir) !== sidecarBoundary.session.path) {
    throw new Error('session 路径与启动身份不一致');
  }
  const transactionRoot = sidecarBoundary.transactions.path;
  const transactionReal = sidecarBoundary.transactions.realPath;
  return { transactionRoot, transactionReal };
}

function requireTransactionId(transactionId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    transactionId,
  )) throw new Error('transactionId 不是规范 UUID v4');
  return transactionId;
}

async function readTransactionRecord(
  deckPath,
  sessionDir,
  transactionId,
  expectedFingerprint,
  backupRecord,
  sidecarBoundary,
) {
  requireTransactionId(transactionId);
  const { transactionRoot, transactionReal } = await safeTransactionsDirectory(
    sessionDir, sidecarBoundary,
  );
  const transactionPath = join(transactionRoot, `${transactionId}.json`);
  void transactionReal;
  const record = await sidecarBoundary.io.readTransaction({ transactionId });
  const expectedKeys = [
    'backup', 'candidateFingerprint', 'deckPath', 'oldFingerprint',
    'sessionDir', 'sessionId', 'transactionId', 'version',
  ];
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)
    || record.version !== 1
    || record.transactionId !== transactionId
    || record.sessionId !== sidecarBoundary.sessionId
    || resolve(record.deckPath ?? '') !== resolve(deckPath)
    || resolve(record.sessionDir ?? '') !== resolve(sessionDir)
    || record.oldFingerprint !== expectedFingerprint
    || !/^[a-f0-9]{64}$/.test(record.candidateFingerprint ?? '')
    || resolve(record.backup ?? '') !== backupRecord.backupPath) {
    throw new Error('事务记录未严格绑定当前 Deck、session 和保存基线');
  }
  await readTrustedBackup(
    sessionDir, record.backup, expectedFingerprint, sidecarBoundary,
  );
  return { transactionPath, record };
}

async function removeTransactionRecord(sessionDir, transactionId, sidecarBoundary) {
  const { transactionRoot } = await safeTransactionsDirectory(
    sessionDir, sidecarBoundary,
  );
  void transactionRoot;
  await sidecarBoundary.io.deleteTransaction({
    transactionId:requireTransactionId(transactionId),
  });
}

async function pruneTransactionRecords(sessionDir, maximum = 32, sidecarBoundary) {
  await safeTransactionsDirectory(sessionDir, sidecarBoundary);
  await sidecarBoundary.io.pruneTransactions({ maximum });
}

async function readTrustedBackup(
  sessionDir, backupPath, expectedFingerprint, sidecarBoundary,
) {
  const { backupRoot, backupReal } = await safeBackupsDirectory(
    sessionDir, sidecarBoundary,
  );
  const absoluteBackup = resolve(backupPath);
  if (dirname(absoluteBackup) !== backupRoot) {
    throw new Error('备份路径不在当前会话 backups 目录内');
  }
  void backupReal;
  await sidecarBoundary.io.verifyBackup({
    backupName:basename(absoluteBackup), expectedFingerprint,
  });
  return { backupPath:absoluteBackup };
}

async function syncDirectoryPath(path) {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function restoreDeckBackup(
  deckPath,
  sessionDir,
  backupRecord,
  expectedFingerprint,
  candidateFingerprint,
  sidecarBoundary,
) {
  try {
    await sidecarBoundary.io.restoreDeck({
      deckName:basename(deckPath),
      backupName:basename(backupRecord.backupPath),
      oldFingerprint:expectedFingerprint,
      candidateFingerprint,
    });
  } catch (error) {
    if (error?.stage !== 'restore-conflict') throw error;
    const currentFingerprint = await sidecarBoundary.io.hashDeck()
      .then(result => result.fingerprint).catch(() => 'unavailable');
    throw restoreConflictError(
      candidateFingerprint,
      currentFingerprint,
      error.message,
      error,
    );
  }
}

async function validateWriterResult(
  deckPath,
  sessionDir,
  result,
  backupRecord,
  transactionId,
  sidecarBoundary = null,
) {
  if (result?.ok !== true) throw adapterError('WRITE_FAILED', 500, '写入 Deck 未返回成功状态');
  if (typeof result.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(result.fingerprint)) {
    throw adapterError('WRITE_FAILED', 500, '写入 Deck 返回无效 fingerprint');
  }
  if (typeof result.backup !== 'string' || resolve(result.backup) !== backupRecord.backupPath) {
    throw adapterError('WRITE_FAILED', 500, '写入 Deck 返回不可信 backup');
  }
  const expectedTransactionPath = join(
    sessionDir, 'transactions', `${requireTransactionId(transactionId)}.json`,
  );
  if (typeof result.transaction !== 'string'
    || resolve(result.transaction) !== resolve(expectedTransactionPath)) {
    throw adapterError('WRITE_FAILED', 500, '写入 Deck 返回不可信 transaction');
  }
  await readTrustedBackup(
    sessionDir, result.backup, backupRecord.expectedFingerprint, sidecarBoundary,
  );
  const { record } = await readTransactionRecord(
    deckPath,
    sessionDir,
    transactionId,
    backupRecord.expectedFingerprint,
    backupRecord,
    sidecarBoundary,
  );
  if (record.candidateFingerprint !== result.fingerprint) {
    throw adapterError('WRITE_FAILED', 500, '事务记录 candidate 与 writer 回执不一致');
  }
  if ((await sidecarBoundary.io.hashDeck()).fingerprint !== result.fingerprint) {
    throw adapterError('WRITE_FAILED', 500, '写入 Deck 回执与官方文件指纹不一致');
  }
  return result;
}

function authCookieName(token) {
  const sessionId = createHash('sha256').update(token).digest('hex').slice(0, 16);
  return `aico_ppt_editor_${sessionId}`;
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

function authorize(request, url, token, serviceOrigin) {
  if (request.headers.origin !== undefined) {
    let suppliedOrigin;
    try { suppliedOrigin = new URL(request.headers.origin).origin; }
    catch { throw httpError('FORBIDDEN', 403, '请求 Origin 无效'); }
    if (suppliedOrigin !== serviceOrigin) {
      throw httpError('FORBIDDEN', 403, '请求 Origin 不属于当前本地编辑服务');
    }
  }
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  const cookieToken = cookieValue(request, authCookieName(token));
  if (url.searchParams.get('token') !== token && bearer !== token && cookieToken !== token) {
    throw httpError('FORBIDDEN', 403, '无权访问本地编辑服务');
  }
}

function isProtected(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/')
    || pathname === '/preview'
    || pathname === '/editor' || pathname.startsWith('/editor/')
    || pathname === '/events';
}

async function readJson(request) {
  const chunks = [];
  let bodyBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bodyBytes += bytes.length;
    if (bodyBytes > MAX_BODY_BYTES) {
      throw httpError('BODY_TOO_LARGE', 413, '请求体过大');
    }
    chunks.push(bytes);
  }
  if (bodyBytes === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, bodyBytes).toString('utf8'));
  } catch {
    throw httpError('INVALID_JSON', 400, '请求体不是有效 JSON');
  }
}

function requestMediaType(value) {
  if (typeof value !== 'string') return '';
  const separator = value.indexOf(';');
  return value.slice(0, separator < 0 ? value.length : separator).trim().toLowerCase();
}

function requireRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw httpError('INVALID_INPUT', 400, 'expectedRevision 必须为非负整数');
  }
  return value;
}

function requireTaskId(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw httpError('INVALID_INPUT', 400, 'taskId 必须为 null 或非空字符串');
  }
  return value;
}

function requireSourceEditId(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    String(value ?? ''),
  )) throw httpError('INVALID_SOURCE_EDIT_ID', 400, 'sourceEditId 必须是规范 UUID v4');
  return value;
}

function json(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function send(response, statusCode, body, contentType, headers = {}) {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(body);
}

function sendEditorIndex(request, response, url, token, editorToken, serviceOrigin, contents) {
  authorize(request, url, token, serviceOrigin);
  if (url.searchParams.get('editorToken') !== editorToken) {
    throw httpError('FORBIDDEN', 403, '缺少编辑器能力令牌');
  }
  send(response, 200, contents, 'text/html; charset=utf-8', {
    'set-cookie': `${authCookieName(token)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`,
  });
}

function injectPreviewBridge(contents) {
  let preview = contents.replace(
    /(<script\b[^>]*?\bsrc=)(["'])(?:\.\.\/)+runtime\/patch-runtime\.js\2/gi,
    '$1$2/editor/patch-runtime.js$2',
  );
  if (!/<script\b[^>]*\bsrc=["']\/editor\/patch-runtime\.js["'][^>]*>/i.test(preview)) {
    const runtimeTag = '<script src="/editor/patch-runtime.js"></script>\n';
    const headOpen = preview.match(/<head\b[^>]*>/i);
    preview = headOpen
      ? `${preview.slice(0, headOpen.index + headOpen[0].length)}\n${runtimeTag}${preview.slice(headOpen.index + headOpen[0].length)}`
      : `${runtimeTag}${preview}`;
  }
  if (!/<link\b[^>]*\bhref=["']\/editor\/ui-font\.css["'][^>]*>/i.test(preview)) {
    const fontTag = '<link rel="stylesheet" href="/editor/ui-font.css">\n';
    const headOpen = preview.match(/<head\b[^>]*>/i);
    preview = headOpen
      ? `${preview.slice(0, headOpen.index + headOpen[0].length)}\n${fontTag}${preview.slice(headOpen.index + headOpen[0].length)}`
      : `${fontTag}${preview}`;
  }
  if (!/<link\b[^>]*\bhref=["']\/editor\/pill-nav\.css["'][^>]*>/i.test(preview)) {
    const pillNavTag = '<link rel="stylesheet" href="/editor/pill-nav.css" data-deck-editor-ui>\n';
    const headOpen = preview.match(/<head\b[^>]*>/i);
    preview = headOpen
      ? `${preview.slice(0, headOpen.index + headOpen[0].length)}\n${pillNavTag}${preview.slice(headOpen.index + headOpen[0].length)}`
      : `${pillNavTag}${preview}`;
  }
  const tags = [];
  if (!/<script\b[^>]*\bsrc=["']\/editor\/html2canvas\.min\.js["'][^>]*>/i.test(preview)) {
    tags.push('<script src="/editor/html2canvas.min.js"></script>');
  }
  if (!/<script\b[^>]*\bsrc=["']\/editor\/frame-bridge\.mjs["'][^>]*>/i.test(preview)) {
    tags.push('<script type="module" src="/editor/frame-bridge.mjs"></script>');
  }
  if (!tags.length) return preview;
  const injection = `${tags.join('\n')}\n`;
  const bodyEnd = preview.toLowerCase().lastIndexOf('</body>');
  if (bodyEnd < 0) return `${preview}\n${injection}`;
  preview = `${preview.slice(0, bodyEnd)}${injection}${preview.slice(bodyEnd)}`;
  return preview;
}

function errorResponse(response, error) {
  let statusCode = error?.statusCode;
  let code = error?.code;
  if (error instanceof RevisionConflict) {
    statusCode = 409;
    code = 'REVISION_CONFLICT';
  } else if (error instanceof TypeError || error instanceof RangeError || error instanceof URIError) {
    statusCode ??= 400;
    code ??= 'INVALID_INPUT';
  }
  statusCode ??= 500;
  code ??= 'INTERNAL_ERROR';
  const safeMessages = new Set([
    'JOURNAL_PERSIST_FAILED', 'EDITOR_SYNC_REQUIRED', 'VERIFY_FAILED', 'WRITE_FAILED',
  ]);
  const message = statusCode === 500 && !safeMessages.has(code) ? '服务内部错误' : error.message;
  const details = {};
  if(error?.targetSummary)details.targetSummary=error.targetSummary;
  if(error?.replayCode)details.replayCode=error.replayCode;
  if (typeof error?.failedActionId === 'string') details.failedActionId = error.failedActionId;
  if (Array.isArray(error?.candidates)) details.candidates = error.candidates.slice(0, 5);
  if (typeof error?.committed === 'boolean') details.committed = error.committed;
  if (typeof error?.commitScope === 'string') details.commitScope = error.commitScope;
  if (typeof error?.commitConfirmed === 'boolean') details.commitConfirmed = error.commitConfirmed;
  if (typeof error?.recoveredBySync === 'boolean') details.recoveredBySync = error.recoveredBySync;
  if (Number.isSafeInteger(error?.revision)) details.revision = error.revision;
  if (typeof error?.groupId === 'string') details.groupId = error.groupId;
  if (typeof error?.stage === 'string') details.stage = error.stage;
  if (typeof error?.recovery === 'string') details.recovery = error.recovery;
  if (typeof error?.diagnostic === 'string') details.diagnostic = error.diagnostic;
  if ((process.env.AICO_PPT_DEBUG_ERRORS ?? process.env.HUAWEI_DECK_DEBUG_ERRORS) === '1'
    && !details.diagnostic
    && typeof error?.message === 'string') {
    details.diagnostic = error.message.slice(0, 1_024);
  }
  if (typeof error?.candidate === 'string') details.candidate = error.candidate;
  if (typeof error?.backup === 'string') details.backup = error.backup;
  if (typeof error?.expectedFingerprint === 'string') details.expectedFingerprint = error.expectedFingerprint;
  if (typeof error?.actualFingerprint === 'string') details.actualFingerprint = error.actualFingerprint;
  if (Array.isArray(error?.blockers)) details.blockers = error.blockers;
  if (error?.binding && typeof error.binding === 'object') details.binding = error.binding;
  json(response, statusCode, { error: code, code, message, ...details });
}

function runWritePatches(
  deckPath,
  sessionDir,
  patches,
  expectedFingerprint,
  transactionId,
  sessionId,
  sidecarIdentity,
  {
  pythonExecutable,
  spawnWriter,
  timeoutMs,
  killGraceMs,
  activeWriters,
  onActiveWritersChange,
}) {
  const adapterPath = join(EDITOR_DIR, 'bundle_adapter.py');
  const program = [
    'import importlib.util,json,sys',
    'spec=importlib.util.spec_from_file_location("bundle_adapter",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'patches=json.load(sys.stdin)',
    'identity=json.loads(sys.argv[5])',
    'print(json.dumps(module.write_patches_safe(sys.argv[2],patches,sys.argv[3],sys.argv[4],sys.argv[7],identity,sys.argv[6]),ensure_ascii=False))',
  ].join(';');
  return new Promise((resolvePromise, reject) => {
    const child = spawnWriter(pythonExecutable, [
      '-c', program, adapterPath, deckPath, sessionDir, expectedFingerprint,
      JSON.stringify(sidecarIdentity), sessionId, transactionId,
    ], pythonUtf8SpawnOptions({
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
    let stdout = '';
    let stderr = '';
    let requestSettled = false;
    let processFinalized = false;
    let cancelStarted = false;
    let resolveClosed;
    const closed = new Promise(resolveClosedPromise => { resolveClosed = resolveClosedPromise; });
    let requestTimer;
    let killGraceTimer;
    const absorbLateError = () => {};
    const notifyActiveWriters = () => {
      try {
        onActiveWritersChange(activeWriters.size);
      } catch {
        // 测试/诊断 hook 不得影响 writer 生命周期。
      }
    };
    const settleRequest = (error, value) => {
      if (requestSettled) return;
      requestSettled = true;
      clearTimeout(requestTimer);
      if (error) reject(error);
      else resolvePromise(value);
    };
    const finalizeProcess = ({ force = false } = {}) => {
      if (processFinalized) return;
      processFinalized = true;
      clearTimeout(requestTimer);
      clearTimeout(killGraceTimer);
      child.removeListener('error', onChildError);
      child.removeListener('close', onChildClose);
      child.stdout.removeListener('data', onStdoutData);
      child.stderr.removeListener('data', onStderrData);
      child.stdin.removeListener('error', onStdinError);
      child.on('error', absorbLateError);
      child.stdin.on('error', absorbLateError);
      if (force) {
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          try {
            stream.destroy?.();
          } catch {
            // 强制收敛阶段只做尽力清理。
          }
        }
        child.unref?.();
      }
      if (activeWriters.delete(child)) notifyActiveWriters();
      resolveClosed();
    };
    const cancel = error => {
      settleRequest(error);
      if (cancelStarted || processFinalized) return;
      cancelStarted = true;
      try {
        child.kill('SIGKILL');
      } catch {
        finalizeProcess({ force: true });
        return;
      }
      if (!processFinalized) {
        killGraceTimer = setTimeout(() => finalizeProcess({ force: true }), killGraceMs);
        killGraceTimer.unref?.();
      }
    };
    const onStdoutData = chunk => { stdout += chunk; };
    const onStderrData = chunk => { stderr += chunk; };
    const onStdinError = error => {
      if (!requestSettled) {
        cancel(adapterError(
          'WRITE_DECK_IO_ERROR', 502, `写入 Deck 输入失败：${error.code ?? 'IO_ERROR'}`,
        ));
      }
    };
    const onChildError = error => {
      settleRequest(adapterError(
        'WRITE_FAILED', 500, `无法启动 Deck 保存适配器：${error.code ?? error.message}`,
      ));
      finalizeProcess();
    };
    const onChildClose = code => {
      if (!requestSettled) {
        if (code !== 0) {
          settleRequest(adapterError(
            'WRITE_FAILED', 500, stderr.trim() || `写入 Deck 进程退出码 ${code}`,
          ));
        } else {
          try {
            const resultLine = stdout.trim().split(/\r?\n/).at(-1);
            const result = JSON.parse(resultLine);
            if (result?.ok === false) {
              const statuses = {
                DECK_CHANGED:409, VERIFY_FAILED:500, WRITE_FAILED:500,
                UNSAFE_SIDECAR:500,
              };
              settleRequest(Object.assign(
                httpError(result.code ?? 'WRITE_FAILED', statuses[result.code] ?? 500,
                  result.message ?? '写回 Deck 失败'),
                {
                  stage:result.stage ?? 'write',
                  recovery:result.recovery ?? '检查诊断信息后重试',
                  diagnostic:result.diagnostic,
                  candidate:result.candidate,
                },
              ));
            } else if (result?.ok === true) {
              settleRequest(null, result);
            } else {
              settleRequest(adapterError('WRITE_FAILED', 500, '写入 Deck 未返回明确成功状态'));
            }
          } catch {
            settleRequest(adapterError('WRITE_FAILED', 500, '写入 Deck 返回无效结果'));
          }
        }
      }
      finalizeProcess();
    };
    activeWriters.set(child, { cancel, closed });
    notifyActiveWriters();
    requestTimer = setTimeout(() => {
      cancel(adapterError('WRITE_DECK_TIMEOUT', 504, '写入 Deck 超时'));
    }, timeoutMs);
    requestTimer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onStdoutData);
    child.stderr.on('data', onStderrData);
    child.stdin.on('error', onStdinError);
    child.once('error', onChildError);
    child.once('close', onChildClose);
    try {
      child.stdin.end(JSON.stringify(patches));
    } catch (error) {
      cancel(httpError('WRITE_DECK_IO_ERROR', 502, `写入 Deck 输入失败：${error.code ?? 'IO_ERROR'}`));
    }
  });
}

async function runWriteTransaction({
  deckPath,
  sessionDir,
  expectedFingerprint,
  runWriter,
  sidecarBoundary,
  syncDirectory,
}) {
  const transactionId = randomUUID();
  const backupRecord = {
    backupPath:join(
      sidecarBoundary.backups.path,
      `${basename(deckPath, '.html')}-${expectedFingerprint}.html`,
    ),
    expectedFingerprint,
  };
  try {
    await sidecarBoundary?.guard();
    // 仅保留既有故障注入接口；生产备份由 adapter 在发布 record 前完成 durable fsync。
    if (syncDirectory !== syncDirectoryPath) {
      await syncDirectory(sidecarBoundary.backups.path);
    }
  } catch (error) {
    if (error?.code === 'UNSAFE_SIDECAR') throw error;
    if (error?.code === 'DECK_CHANGED') throw error;
    throw adapterError('WRITE_FAILED', 500, `无法建立可信事务备份：${error.message}`);
  }
  try {
    const result = await runWriter(transactionId);
    await validateWriterResult(
      deckPath, sessionDir, result, backupRecord, transactionId, sidecarBoundary,
    );
    await pruneTransactionRecords(sessionDir, 32, sidecarBoundary);
    return result;
  } catch (error) {
    if (error?.code === 'SERVICE_CLOSED') throw error;
    const actualFingerprint = await sidecarBoundary.io.hashDeck()
      .then(result => result.fingerprint).catch(readError => (
      `unavailable:${readError.code ?? 'READ_ERROR'}`
      ));
    let transaction;
    try {
      transaction = await readTransactionRecord(
        deckPath,
        sessionDir,
        transactionId,
        expectedFingerprint,
        backupRecord,
        sidecarBoundary,
      );
    } catch (recordError) {
      if (actualFingerprint === expectedFingerprint) throw error;
      if (error?.code === 'DECK_CHANGED') {
        Object.assign(error, { expectedFingerprint, actualFingerprint });
        throw error;
      }
      throw restoreConflictError(
        expectedFingerprint,
        actualFingerprint,
        'writer 失败且缺少可信 transaction，保留当前磁盘 Deck',
        recordError,
      );
    }
    if (actualFingerprint === expectedFingerprint) {
      await removeTransactionRecord(sessionDir, transactionId, sidecarBoundary);
      throw error;
    }
    if (actualFingerprint !== transaction.record.candidateFingerprint) {
      const conflict = restoreConflictError(
        transaction.record.candidateFingerprint,
        actualFingerprint,
        'writer 失败后磁盘 Deck 已是第三方版本，拒绝恢复旧文件',
        error,
      );
      conflict.transaction = transaction.transactionPath;
      throw conflict;
    }
    await restoreDeckBackup(
      deckPath,
      sessionDir,
      backupRecord,
      expectedFingerprint,
      transaction.record.candidateFingerprint,
      sidecarBoundary,
    );
    await removeTransactionRecord(sessionDir, transactionId, sidecarBoundary);
    throw error;
  }
}

async function finalizeWriteTransaction(value, sessionDir, sidecarBoundary) {
  if (typeof value?.transaction !== 'string') return;
  const transactionPath = resolve(value.transaction);
  const expectedRoot = resolve(sessionDir, 'transactions');
  if (dirname(transactionPath) !== expectedRoot) {
    throw unsafeSidecarError('拒绝清理当前 session 外的 transaction record');
  }
  const match = basename(transactionPath).match(
    /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/,
  );
  if (!match) throw unsafeSidecarError('transaction record 名称不可信');
  await removeTransactionRecord(sessionDir, match[1], sidecarBoundary);
}

const LEGACY_SESSION_KEYS = [
  'conflict', 'deckFingerprint', 'deckPath', 'diagnosticsBaseline',
  'diagnosticsCurrent', 'diagnosticsRevision', 'groups', 'redo', 'revision',
  'tasks', 'version',
];

function portableDeckName(path) {
  return String(path ?? '').replaceAll('\\', '/').split('/').at(-1);
}

function samePersistedDeck(left, right) {
  return resolve(left ?? '') === resolve(right)
    || portableDeckName(left) === portableDeckName(right);
}

function strictLegacySessionState(state, deckPath, fingerprint) {
  return Boolean(state && typeof state === 'object' && !Array.isArray(state)
    && JSON.stringify(Object.keys(state).sort()) === JSON.stringify(LEGACY_SESSION_KEYS)
    && state.version === 1
    && samePersistedDeck(state.deckPath, deckPath)
    && state.deckFingerprint === fingerprint
    && Number.isInteger(state.revision) && state.revision >= 0
    && Array.isArray(state.tasks) && Array.isArray(state.groups) && Array.isArray(state.redo)
    && state.diagnosticsBaseline && typeof state.diagnosticsBaseline === 'object'
    && state.diagnosticsCurrent && typeof state.diagnosticsCurrent === 'object');
}

function validateRegisteredSessionState(
  state, entry, deckPath, { preparing=false, allowReboundPath=false } = {},
) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || state.sessionId !== entry.sessionId
    || (!samePersistedDeck(state.deckPath, deckPath) && !allowReboundPath)
    || !/^[a-f0-9]{64}$/.test(state.deckFingerprint ?? '')
    || (preparing && state.deckFingerprint !== entry.initialFingerprint)
    || !Array.isArray(state.tasks) || !Array.isArray(state.groups) || !Array.isArray(state.redo)) {
    throw new Error('session.json 未严格绑定 registry sessionId/Deck/fingerprint');
  }
  return state;
}

function persistentBoundary(project, root, binding, io) {
  const boundary = {
    project:{ ...project, label:'Deck 项目目录' },
    root:{ ...root, label:'sidecar root' },
    ...Object.fromEntries(Object.entries(binding.identities).map(([key, value]) => (
      [key, { ...value, label:key }]
    ))),
    sidecarRoot:root.path,
    sessionDir:binding.identities.session.path,
    io,
  };
  boundary.guard = async () => {
    try { await io.assertBound(); }
    catch (error) { throw unsafeSidecarError('sidecar 身份已在服务运行期间变化，拒绝继续写入', error); }
  };
  boundary.pythonIdentity = Object.fromEntries(
    [
      'project', 'root', 'session', 'snapshots', 'backups', 'transactions', 'writeErrors',
      'attachments', 'attachmentStaging',
    ]
      .filter(name => boundary[name])
      .map(name => [name, Object.fromEntries(
        ['path', 'realPath', 'dev', 'ino'].map(key => [key, boundary[name][key]]),
      )]),
  );
  return boundary;
}

function canonicalAttachmentBoundary(sidecarBoundary) {
  const canonical = Object.fromEntries(
    ['session', 'attachments', 'attachmentStaging'].map(name => {
      const source = sidecarBoundary[name];
      const path = source?.realPath;
      if (typeof path !== 'string' || resolve(path) !== path) {
        throw new TypeError(`缺少可信 ${name} 真实路径`);
      }
      return [name, { ...source, path, realPath:path }];
    }),
  );
  return {
    ...sidecarBoundary,
    ...canonical,
    sessionDir:canonical.session.path,
    pythonIdentity:{
      ...sidecarBoundary.pythonIdentity,
      ...Object.fromEntries(Object.entries(canonical).map(([name, identity]) => [
        name,
        Object.fromEntries(
          ['path', 'realPath', 'dev', 'ino'].map(key => [key, identity[key]]),
        ),
      ])),
    },
  };
}

async function recoverRegisteredTransaction(deckPath, state, sidecarBoundary) {
  const transactionIds = await sidecarBoundary.io.listTransactions();
  if (!transactionIds.length) return state;
  if (transactionIds.length !== 1) {
    throw new Error('当前注册 session 存在多个未完成 transaction，拒绝猜测恢复顺序');
  }
  const [transactionId] = transactionIds;
  const record = await sidecarBoundary.io.readTransaction({ transactionId });
  const expectedKeys = [
    'backup', 'candidateFingerprint', 'deckPath', 'oldFingerprint',
    'sessionDir', 'sessionId', 'transactionId', 'version',
  ];
  const expectedBackup = join(
    sidecarBoundary.backups.path,
    `${basename(deckPath, '.html')}-${record?.oldFingerprint}.html`,
  );
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)
    || record.version !== 1
    || record.transactionId !== transactionId
    || record.sessionId !== sidecarBoundary.sessionId
    || resolve(record.deckPath ?? '') !== resolve(deckPath)
    || resolve(record.sessionDir ?? '') !== resolve(sidecarBoundary.sessionDir)
    || !/^[a-f0-9]{64}$/.test(record.oldFingerprint ?? '')
    || !/^[a-f0-9]{64}$/.test(record.candidateFingerprint ?? '')
    || resolve(record.backup ?? '') !== resolve(expectedBackup)) {
    throw new Error('未完成 transaction 未严格绑定 registry/Deck/session');
  }
  await sidecarBoundary.io.verifyBackup({
    backupName:basename(expectedBackup), expectedFingerprint:record.oldFingerprint,
  });
  if (![record.oldFingerprint, record.candidateFingerprint].includes(state.deckFingerprint)) {
    throw new Error('session fingerprint 与未完成 transaction 不一致');
  }
  const diskFingerprint = (await sidecarBoundary.io.hashDeck()).fingerprint;
  if (diskFingerprint === record.candidateFingerprint
    && state.deckFingerprint === record.oldFingerprint) {
    await sidecarBoundary.io.restoreDeck({
      backupName:basename(expectedBackup),
      oldFingerprint:record.oldFingerprint,
      candidateFingerprint:record.candidateFingerprint,
    });
    await sidecarBoundary.io.deleteTransaction({ transactionId });
    return state;
  }
  if ((diskFingerprint === record.candidateFingerprint
      && state.deckFingerprint === record.candidateFingerprint)
    || (diskFingerprint === record.oldFingerprint
      && state.deckFingerprint === record.oldFingerprint)) {
    await sidecarBoundary.io.deleteTransaction({ transactionId });
    return state;
  }
  const conflicted = {
    ...state,
    conflict:{
      code:'DECK_CHANGED',
      expectedFingerprint:state.deckFingerprint,
      actualFingerprint:diskFingerprint,
      detectedAt:new Date().toISOString(),
    },
  };
  await sidecarBoundary.io.writeSession({
    sessionId:sidecarBoundary.sessionId,
    bytes:Buffer.from(JSON.stringify(conflicted, null, 2)),
  });
  await sidecarBoundary.io.deleteTransaction({ transactionId });
  return conflicted;
}

async function initializePersistentSidecar(
  deckPath, { pythonExecutable=DEFAULT_PYTHON_EXECUTABLE } = {},
) {
  const project = await captureDirectoryIdentity(dirname(deckPath), 'Deck 项目目录');
  const io = await createPersistentSidecarIO({ project, pythonExecutable });
  try {
    const { identity:root } = await io.ensureRoot();
    const deckName = basename(deckPath);
    const discovery = await io.discover({ deckName });
    let { fingerprint:currentFingerprint } = await io.hashDeck();
    let entry;
    let persistedState;
    let binding;

    if (discovery.registry !== null && discovery.sessions.length > 1) {
      throw new Error('当前 Deck registry 存在多个 session，拒绝猜测');
    }
    if (discovery.sessions.length === 1) {
      [entry] = discovery.sessions;
      if (entry.kind === 'unsafe'
        || (entry.kind === 'missing' && !(entry.status === 'preparing' && entry.mode === 'fresh'))) {
        throw new Error('registry session 目录缺失或不安全');
      }
      binding = await io.bindSession({
        deckName, sessionId:entry.sessionId,
        sessionName:entry.sessionName, create:entry.kind === 'missing',
      });
      persistedState = await io.readSession({ missingOk:entry.status === 'preparing' });
      if (entry.status === 'active') {
        const allowReboundPath = discovery.registry?.version === 2
          && samePersistedDeck(entry.deckRealPath, deckPath);
        validateRegisteredSessionState(persistedState, entry, deckPath, { allowReboundPath });
        if (!samePersistedDeck(persistedState.deckPath, deckPath)) {
          persistedState = { ...persistedState, deckPath };
          await io.writeSession({
            sessionId:entry.sessionId,
            bytes:Buffer.from(JSON.stringify(persistedState, null, 2)),
          });
        }
      } else if (entry.mode === 'legacy') {
        if ((await io.listTransactions()).length) {
          throw new Error('preparing legacy session 出现 pending transaction');
        }
        if (persistedState?.sessionId === undefined) {
          if (!strictLegacySessionState(
            persistedState, deckPath, entry.initialFingerprint,
          )) throw new Error('preparing legacy session 不再满足迁移约束');
          persistedState = { ...persistedState, sessionId:entry.sessionId };
          await io.writeSession({
            sessionId:entry.sessionId,
            bytes:Buffer.from(JSON.stringify(persistedState, null, 2)),
          });
        } else {
          validateRegisteredSessionState(persistedState, entry, deckPath, { preparing:true });
        }
      } else if (persistedState !== null) {
        validateRegisteredSessionState(persistedState, entry, deckPath, { preparing:true });
      }
    } else {
      const legacy = await io.inspectLegacy({ deckName, currentFingerprint });
      if (legacy.candidates.some(candidate => candidate.transactionIds.length)) {
        throw new Error('无 registry 的 legacy session 含 pending transaction，拒绝迁移');
      }
      if (legacy.candidates.length > 1) {
        throw new Error('无 registry 时存在多个 legacy session，拒绝猜测');
      }
      const candidate = legacy.candidates[0] ?? null;
      if (candidate && (!candidate.expectedCurrentName
        || !strictLegacySessionState(candidate.sessionState, deckPath, currentFingerprint))) {
        throw new Error('未注册 session 不是可迁移的严格 legacy');
      }
      const mode = candidate ? 'legacy' : 'fresh';
      const sessionId = randomUUID();
      const sessionName = candidate?.sessionName
        ?? `${basename(deckPath, '.html')}-${currentFingerprint.slice(0, 8)}`;
      entry = await io.prepareSession({
        deckName, sessionId, initialFingerprint:currentFingerprint, sessionName, mode,
      });
      binding = await io.bindSession({
        deckName, sessionId, sessionName, create:mode === 'fresh',
      });
      if (candidate) {
        persistedState = { ...candidate.sessionState, sessionId };
        await io.writeSession({
          sessionId, bytes:Buffer.from(JSON.stringify(persistedState, null, 2)),
        });
      } else {
        persistedState = null;
      }
    }
    const recoveryBoundary = persistentBoundary(project, root, binding, io);
    recoveryBoundary.sessionId = entry.sessionId;
    if (entry.status === 'active') {
      persistedState = await recoverRegisteredTransaction(
        deckPath, persistedState, recoveryBoundary,
      );
      currentFingerprint = (await io.hashDeck()).fingerprint;
    }
    const attachmentBinding = await io.bindAttachments();
    binding = {
      ...binding,
      identities:{ ...binding.identities, ...attachmentBinding.identities },
    };
    const sidecarBoundary = persistentBoundary(project, root, binding, io);
    sidecarBoundary.sessionId = entry.sessionId;
    return {
      sidecarBoundary,
      entry,
      persistedState,
      currentFingerprint,
      needsActivation:entry.status === 'preparing',
    };
  } catch (error) {
    await io.close();
    throw error;
  }
}

async function prepareClosedEditorRename(
  deckPath, { deckId, deckBinding, pythonExecutable=DEFAULT_PYTHON_EXECUTABLE } = {},
) {
  if (!deckId || !deckBinding || !['renamed', 'moved'].includes(deckBinding.reason)
    || typeof deckBinding.previousPath !== 'string'
    || typeof deckBinding.currentPath !== 'string'
    || !deckBinding.witness) return false;
  const [currentRealPath, requestedRealPath, previousParent, currentParent] = await Promise.all([
    realpath(deckBinding.currentPath).catch(() => null),
    realpath(deckPath).catch(() => null),
    realpath(dirname(deckBinding.previousPath)).catch(() => null),
    realpath(dirname(deckPath)).catch(() => null),
  ]);
  if (!currentRealPath || currentRealPath !== requestedRealPath
    || !previousParent || previousParent !== currentParent) return false;
  const project = await captureDirectoryIdentity(dirname(deckPath), 'Deck 项目目录');
  const io = await createPersistentSidecarIO({ project, pythonExecutable });
  try {
    await io.ensureRoot();
    const discovery = await io.discover({ deckName:basename(deckBinding.previousPath) });
    if (discovery.registry === null || discovery.sessions.length === 0) return false;
    if (discovery.sessions.length !== 1) {
      throw unsafeSidecarError('外部改名前的 Deck 存在多个 session，拒绝猜测');
    }
    const [entry] = discovery.sessions;
    if (entry.kind !== 'directory' || entry.status !== 'active') {
      throw unsafeSidecarError('外部改名前的 Deck session 不可安全恢复');
    }
    await io.bindSession({
      deckName:basename(deckBinding.previousPath),
      sessionId:entry.sessionId,
      sessionName:entry.sessionName,
      create:false,
    });
    if ((await io.listTransactions()).length) {
      throw unsafeSidecarError('Deck 改名时存在未完成固化事务，必须先恢复旧路径');
    }
    const state = await io.readSession({ missingOk:false });
    if (state?.sessionId !== entry.sessionId || state?.deckId !== deckId) {
      throw unsafeSidecarError('外部改名绑定与原 Deck session 身份不一致');
    }
    const expectedWitness = deckBinding.witness.platform === 'windows'
      ? {
          dev:deckBinding.witness.volumeSerial,
          ino:deckBinding.witness.fileId,
        }
      : {
          dev:deckBinding.witness.device,
          ino:deckBinding.witness.inode,
        };
    await io.rebindDeck({ deckName:basename(deckPath), expectedWitness });
    await io.writeSession({
      sessionId:entry.sessionId,
      bytes:Buffer.from(JSON.stringify({ ...state, deckId, deckPath }, null, 2)),
    });
    return true;
  } finally {
    await io.close();
  }
}

function recoverablePublishedCheckpoint(state, { deckId, currentFingerprint }) {
  if (!state || state.deckId !== deckId || state.conflict !== null) return null;
  if (typeof state.deckFingerprint !== 'string'
    || !SHA256_HEX.test(state.deckFingerprint)
    || state.deckFingerprint !== currentFingerprint) return null;
  const checkpoint = Array.isArray(state.checkpoints) ? state.checkpoints.at(-1) : null;
  if (!checkpoint
    || typeof checkpoint.checkpointId !== 'string' || !checkpoint.checkpointId
    || checkpoint.fingerprint !== state.deckFingerprint
    || !Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 0
    || checkpoint.revision > state.revision
    || !Number.isSafeInteger(checkpoint.entryCount) || checkpoint.entryCount < 0) return null;
  return {
    checkpointId:checkpoint.checkpointId,
    fingerprint:`sha256:${state.deckFingerprint}`,
  };
}

export async function startServer({
  deckPath,
  workId = null,
  deckId = null,
  deckBinding = null,
  pickDeckFile = options => pickDeckWithSystemPicker({ pythonExecutable, ...options }),
  host = '127.0.0.1',
  port = 0,
  openBrowser = false,
  exitWhenEditorCloses = false,
  editorCloseGraceMs = 10_000,
  onClose = () => {},
  token = randomUUID(),
  editorToken = randomUUID(),
  bridgeTimeoutMs = 10_000,
  writerTimeoutMs = 10_000,
  writerKillGraceMs = 250,
  spawnWriter = spawn,
  attachmentWriterTimeoutMs = 30_000,
  spawnAttachmentWriter = spawn,
  onActiveWritersChange = () => {},
  beforeSessionPersist = async () => {},
  syncDirectory = syncDirectoryPath,
  agentProvider = 'codex',
  agentThreadId = null,
  agentProjectRoot = null,
  agentProjectRootSource = null,
  agentTerminalCwd = null,
  agentLaunchCwd = process.cwd(),
  agentRunAdapter = null,
  dshAgentBridge = false,
  spawnAgentTerminal = null,
  createAgentTerminal = null,
  createAgentTerminalConversation = createTerminalConversation,
  discoverAgentTerminalConversation = discoverTerminalConversation,
  resumeAgentTerminalConversation = resumeTerminalConversation,
  agentTerminalSession = null,
  closeAgentTerminalOnShutdown = true,
  autoStartAgentTerminal = false,
  creationHandoff = null,
  agentRunTimeoutMs = 20 * 60 * 1000,
  editorAssets = null,
  pythonExecutable = DEFAULT_PYTHON_EXECUTABLE,
  pptxExporter = exportPptxSnapshot,
  pickPptxFile = options => pickPptxSaveWithSystemPicker({ pythonExecutable, ...options }),
  pptxExportTimeoutMs = 5 * 60 * 1_000,
  managedWorkingDeck = true,
  workingPatchVerifier = verifyWorkingPatchReplay,
  workspaceHistoryProvider = async () => ({ version:1, creation:[], editing:[] }),
  renameWorkItem = null,
  updateWorkItemBinding = null,
  dshWorkItemProvider = null,
  dshWorkItemCommand = null,
} = {}) {
  void openBrowser;
  if (!deckPath) throw new TypeError('缺少 deckPath');
  if (!Number.isSafeInteger(editorCloseGraceMs) || editorCloseGraceMs < 0) {
    throw new TypeError('editorCloseGraceMs 必须为非负整数');
  }
  if (typeof onClose !== 'function') throw new TypeError('onClose 必须是函数');
  if (typeof autoStartAgentTerminal !== 'boolean') {
    throw new TypeError('autoStartAgentTerminal 必须是布尔值');
  }
  if (typeof dshAgentBridge !== 'boolean') {
    throw new TypeError('dshAgentBridge 必须是布尔值');
  }
  if (dshAgentBridge && agentRunAdapter !== null) {
    throw new TypeError('dshAgentBridge 与 agentRunAdapter 不能同时设置');
  }
  if (dshAgentBridge && agentTerminalSession !== null) {
    throw new TypeError('DSH bridge 不能接管独立 Agent Terminal Session');
  }
  if (dshAgentBridge && typeof dshWorkItemProvider !== 'function') {
    throw new TypeError('DSH bridge 必须提供 dshWorkItemProvider');
  }
  if (dshAgentBridge && typeof dshWorkItemCommand !== 'function') {
    throw new TypeError('DSH bridge 必须提供 dshWorkItemCommand');
  }
  if (createAgentTerminal === null && !dshAgentBridge) {
    ({ createAgentTerminalSession:createAgentTerminal } = await import('./agent-terminal-loader.mjs'));
  }
  if (createAgentTerminal === null && dshAgentBridge) {
    createAgentTerminal = async () => { throw new Error('DSH bridge 不启动独立 Agent Terminal'); };
  }
  if (typeof createAgentTerminal !== 'function') {
    throw new TypeError('createAgentTerminal 必须是函数');
  }
  if (creationHandoff !== null
    && (!creationHandoff || typeof creationHandoff !== 'object' || Array.isArray(creationHandoff))) {
    throw new TypeError('creationHandoff 必须是对象或 null');
  }
  if (typeof closeAgentTerminalOnShutdown !== 'boolean') {
    throw new TypeError('closeAgentTerminalOnShutdown 必须是布尔值');
  }
  if (typeof managedWorkingDeck !== 'boolean') {
    throw new TypeError('managedWorkingDeck 必须是布尔值');
  }
  if (typeof workingPatchVerifier !== 'function') {
    throw new TypeError('workingPatchVerifier 必须是函数');
  }
  if (typeof pptxExporter !== 'function') {
    throw new TypeError('pptxExporter 必须是函数');
  }
  if (!Number.isSafeInteger(pptxExportTimeoutMs) || pptxExportTimeoutMs <= 0) {
    throw new TypeError('pptxExportTimeoutMs 必须为正整数');
  }
  if (typeof workspaceHistoryProvider !== 'function') {
    throw new TypeError('workspaceHistoryProvider 必须是函数');
  }
  if (renameWorkItem !== null && typeof renameWorkItem !== 'function') {
    throw new TypeError('renameWorkItem 必须是函数或 null');
  }
  if (updateWorkItemBinding !== null && typeof updateWorkItemBinding !== 'function') {
    throw new TypeError('updateWorkItemBinding 必须是函数或 null');
  }
  const normalizedHost = String(host).toLowerCase();
  const ipv4Loopback = isIP(normalizedHost) === 4 && normalizedHost.startsWith('127.');
  if (!ipv4Loopback && normalizedHost !== '::1' && normalizedHost !== 'localhost') {
    throw httpError('INVALID_HOST', 400, '编辑服务只允许监听 loopback 地址');
  }
  host = normalizedHost;
  const urlHost = host.includes(':') ? `[${host}]` : host;
  const absoluteDeckPath = resolve(deckPath);
  let currentDeckPath = absoluteDeckPath;
  let defaultAgentProject = dirname(absoluteDeckPath);
  const pinnedEditorAssets = await snapshotEditorAssets(editorAssets, {
    includeAgentTerminal:!dshAgentBridge,
  });
  const rawEditorIndex = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8');
  const pinnedEditorIndex = rawEditorIndex.replace(
    dshAgentBridge
      ? /<!-- dev-shell-terminal:start -->[\s\S]*?<!-- dev-shell-terminal:end -->/gu
      : /<!-- dev-shell-terminal:(?:start|end) -->/gu,
    '',
  ).replace('__DSH_WORK_ITEM_COORDINATOR__', String(dshAgentBridge));
  let sidecarBoundary;
  let initialization;
  try {
    await prepareClosedEditorRename(absoluteDeckPath, {
      deckId, deckBinding, pythonExecutable,
    });
    initialization = await initializePersistentSidecar(
      absoluteDeckPath, { pythonExecutable },
    );
    sidecarBoundary = initialization.sidecarBoundary;
  } catch (error) {
    if (error?.code === 'SESSION_LOCKED') {
      throw httpError('SESSION_LOCKED', 409, '当前 Deck 已由另一编辑服务占用');
    }
    if (error?.code === 'UNSAFE_SIDECAR') throw error;
    throw unsafeSidecarError('sidecar 路径不可信，拒绝启动编辑服务', error);
  }
  let sessionStore;
  let workingDeckStore;
  let agentWorkspaceStore;
  let projectResolution;
  try {
    sessionStore = await SessionStore.open({
      deckPath:absoluteDeckPath,
      rootDir:sidecarBoundary.sidecarRoot,
      sessionDir:sidecarBoundary.sessionDir,
      sidecarGuard:sidecarBoundary.guard,
      sidecarIO:sidecarBoundary.io,
      directoriesPrepared:true,
      deckFingerprint:initialization.currentFingerprint,
      sessionId:initialization.entry.sessionId,
      persistedState:initialization.persistedState,
    });
    if (initialization.needsActivation) {
      await sidecarBoundary.io.activateSession({
        sessionId:initialization.entry.sessionId,
      });
    }
    const openedWorkingDeck = await WorkingDeckStore.open({
      deckPath:absoluteDeckPath,
      sessionDir:sidecarBoundary.sessionDir,
      sessionId:sessionStore.state.sessionId,
      sidecarIO:sidecarBoundary.io,
      pythonExecutable,
      manageBundle:managedWorkingDeck,
      expectedWorkingFingerprint:sessionStore.state.workingDeckFingerprint ?? null,
      reservedBeforeFingerprint:sessionStore.state.sourceEdit?.beforeFingerprint ?? null,
    });
    workingDeckStore = openedWorkingDeck.store;
    const stagedRecovery = await recoverStagedPatches(sessionStore.state, workingDeckStore, {
      verify:workingPatchVerifier, pythonExecutable,
    });
    if (stagedRecovery) openedWorkingDeck.recovery = stagedRecovery;
    let migratedSession = migrateSessionToPersistentPageIds(
      sessionStore.state, workingDeckStore, openedWorkingDeck.fingerprintMap,
    );
    if (openedWorkingDeck.recovery) {
      migratedSession ??= structuredClone(sessionStore.state);
      migratedSession.startupRecovery = {
        ...openedWorkingDeck.recovery,
        recoveredAt:new Date().toISOString(),
      };
    } else if (sessionStore.state.startupRecovery) {
      migratedSession ??= structuredClone(sessionStore.state);
      delete migratedSession.startupRecovery;
    }
    const reconciledHistory = workingDeckStore.managed
      ? await reconcileLegacySourceHistory(migratedSession ?? sessionStore.state, sidecarBoundary.io, pythonExecutable) : null;
    if(reconciledHistory) {
      const groups=[{active:true,actions:reconciledHistory.solidifiedActions??[]},...reconciledHistory.groups];
      const actions=compileActionGroups(groups);
      const checked=await verifyEffectiveDeck({bytes:await workingDeckStore.read(),actions,pythonExecutable},
        {verify:workingPatchVerifier,droppableActionIds:sourceRebaseActionIds(groups,actions)});
      const removed=new Set(checked.droppedActionIds??[]);
      if(removed.size) {
        const entry=reconciledHistory.timeline.entries.slice(0,reconciledHistory.timeline.cursor)
          .findLast(entry=>entry.mutation.kind==='source');
        if(entry) {
          const evidence=entry.mutation.source.actionReconciliation;
          evidence.supersededKeys=[...new Set([...evidence.supersededKeys,...actions.filter(a=>removed.has(a.id)).map(actionKey)])];
          EditTimeline.open(reconciledHistory);
        }
      }
    }
    migratedSession = reconciledHistory ?? migratedSession;
    if (migratedSession) await sessionStore.persistState(migratedSession);
    const persistedAgentWorkspace = await sidecarBoundary.io.readAgentWorkspace({ missingOk:true });
    projectResolution = await resolveProjectRoot({
      deckPath:absoluteDeckPath,
      persistedRoot:persistedAgentWorkspace?.projectRoot ?? null,
      explicitRoot:agentProjectRoot,
      launchCwd:agentLaunchCwd,
    });
    defaultAgentProject = projectResolution.path;
    const requestedProjectRootSource = agentProjectRootSource ?? projectResolution.source;
    const projectRootSource = persistedAgentWorkspace?.projectRoot === defaultAgentProject
      ? persistedAgentWorkspace.projectRootSource
      : requestedProjectRootSource;
    const projectRootChanged = Boolean(
      persistedAgentWorkspace
      && persistedAgentWorkspace.projectRoot !== defaultAgentProject
    );
    const legacyConnection = resolveLegacyConnection({
      provider:agentProvider,
      launchThreadId:agentThreadId,
      persistedConnection:sessionStore.state.agentConnection,
    });
    agentWorkspaceStore = await AgentWorkspaceStore.open({
      dshAgentBridge,
      deckSessionId:sessionStore.state.sessionId,
      projectRoot:defaultAgentProject,
      projectRootSource,
      sidecarIO:sidecarBoundary.io,
      initialState:createWorkspaceFromLegacyConnection({
        deckSessionId:sessionStore.state.sessionId,
        projectRoot:defaultAgentProject,
        projectRootSource,
        connection:legacyConnection,
      }),
    });
    const openedWorkspace = agentWorkspaceStore.snapshot();
    if (openedWorkspace.projectRoot !== defaultAgentProject
      || openedWorkspace.projectRootSource !== projectRootSource
      || openedWorkspace.activeProvider !== agentProvider) {
      await agentWorkspaceStore.update(draft => {
        draft.projectRoot = defaultAgentProject;
        draft.projectRootSource = projectRootSource;
        draft.activeProvider = agentProvider;
        if (projectRootChanged) {
          const timestamp = new Date().toISOString();
          for (const providerState of Object.values(draft.providers)) {
            const active = providerState.conversations.find(
              item => item.id === providerState.activeConversationId,
            );
            if (!active || active.projectRoot === defaultAgentProject) continue;
            if (requestedProjectRootSource === 'persisted') {
              // 历史任务的持久化根来自可验证的 Creation 交接/最近记录；
              // 用它修复旧版曾被启动器 cwd 污染的会话绑定。
              active.projectRoot = defaultAgentProject;
              active.updatedAt = timestamp;
            } else {
              // 用户显式换了项目根，旧会话仍保留在历史中，
              // 但不能在新 cwd 下 resume，否则 CLI 会再次弹出目录选择。
              providerState.activeConversationId = null;
            }
          }
        }
      }, openedWorkspace.workspaceRevision);
    }
  } catch (error) {
    await agentWorkspaceStore?.close().catch(() => {});
    await sidecarBoundary.io.close();
    throw unsafeSidecarError('session/registry 无法安全完成初始化', error);
  }
  try {
    agentTerminalCwd = await resolveAgentTerminalCwd({
      projectRoot:defaultAgentProject,
      preferredCwd:agentTerminalCwd ?? agentLaunchCwd,
      projectIdentity:projectResolution.identity,
    });
  } catch (error) {
    await agentWorkspaceStore.close().catch(() => {});
    await sidecarBoundary.io.close();
    throw error;
  }
  if (resolve(sessionStore.sessionDir) !== resolve(sidecarBoundary.sessionDir)) {
    await sidecarBoundary.io.close();
    throw unsafeSidecarError('Deck 在 sidecar 初始化期间发生变化，请重试');
  }
  if (agentTerminalSession
    && (typeof agentTerminalSession.snapshot !== 'function'
      || typeof agentTerminalSession.attach !== 'function'
      || agentTerminalSession.snapshot().projectRoot !== defaultAgentProject)) {
    await agentWorkspaceStore.close().catch(() => {});
    await sidecarBoundary.io.close();
    throw httpError('AGENT_TERMINAL_HANDOFF_FAILED', 409, 'Agent 终端与 Editor 项目目录不一致');
  }
  let viewContext = null;
  let creationHandoffState = null;
  try {
    creationHandoffState = creationHandoff
      ? await persistCreationHandoffContext(sessionStore.sessionDir, creationHandoff)
      : await loadCreationHandoffContext(sessionStore.sessionDir);
  } catch (error) {
    if (creationHandoff) {
      await agentWorkspaceStore.close().catch(() => {});
      await sidecarBoundary.io.close();
      throw unsafeSidecarError('Creation 交接上下文无法安全持久化', error);
    }
    // 历史交接文件只是增强上下文；损坏或迁移失败不得阻断 Deck 本身继续编辑。
    creationHandoffState = null;
  }
  let attachmentStore;
  try {
    attachmentStore = new AttachmentStore({
      sidecarBoundary:canonicalAttachmentBoundary(sidecarBoundary),
      sidecarIO:sidecarBoundary.io,
      spawnAttachmentWriter,
      pythonExecutable,
      timeoutMs:attachmentWriterTimeoutMs,
    });
    await sidecarBoundary.io.reconcileAttachments({
      referencedTaskIds:sessionStore.state.tasks
        .filter(task => Array.isArray(task.attachments) && task.attachments.length > 0)
        .map(task => task.id),
    });
  } catch (error) {
    await attachmentStore?.close().catch(() => {});
    await sidecarBoundary.io.close();
    throw unsafeSidecarError('附件目录无法安全完成启动对账', error);
  }
  const bridge = new BridgeService({
    sessionStore,
    timeoutMs:bridgeTimeoutMs,
    beforeSessionPersist,
    getPageIds:() => [...workingDeckStore.pageIds],
    reconcileSession:state => (
      migrateSessionToPersistentPageIds(state, workingDeckStore) ?? structuredClone(state)
    ),
  });
  const webSockets = new WebSocketServer({ noServer: true });
  const terminalSockets = new WebSocketServer({ noServer:true, maxPayload:128 * 1024 });
  const activeWriters = new Map();
  const activePptxExports = new Set();
  let pptxExportBusy = false;
  let watcherClosed = false;
  let watcherGeneration = 0;
  let watcherQueue = Promise.resolve();
  let workingWatcherQueue = Promise.resolve();
  let pendingWorkingCheckpoints = 0;
  let serviceOrigin;
  let editorConnectedOnce = false;
  let editorCloseTimer;
  let closePromise;
  let agentRuns;
  let dshRunAdapter = null;
  let agentTerminal;
  let detachTerminalState = null;
  let detachTerminalProvider = null;
  let detachTerminalInterrupt = null;
  let bindingCoordinator = null;
  let bindingPersistenceQueue = Promise.resolve();
  let restartDeckWatcher = () => {};

  const broadcast = (type, revision, payload) => {
    const message = JSON.stringify({ type, revision, payload });
    for (const client of webSockets.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  };

  const effectiveDeckId = deckId ?? sessionStore.state.deckId ?? sessionStore.state.sessionId;
  try {
    bindingCoordinator = await openDeckBinding({
      deckId:effectiveDeckId,
      initialBinding:deckBinding ?? {
        revision:0,
        currentPath:absoluteDeckPath,
        trustedRoot:dirname(absoluteDeckPath),
      },
      storageRoot:sidecarBoundary.sidecarRoot,
      onBeforeRebind:async ({ nextPath, witness }) => {
        const expectedWitness = witness.platform === 'windows'
          ? { dev:witness.volumeSerial, ino:witness.fileId }
          : { dev:witness.device, ino:witness.inode };
        await sidecarBoundary.io.rebindDeck({
          deckName:basename(nextPath), expectedWitness,
        });
        currentDeckPath = nextPath;
        sessionStore.deckPath = nextPath;
        await sessionStore.persistState({
          ...sessionStore.state,
          deckId:effectiveDeckId,
          deckPath:nextPath,
        });
      },
      onChange:event => {
        currentDeckPath = event.binding.currentPath;
        restartDeckWatcher();
        broadcast(event.type, event.revision, event.binding);
        if (updateWorkItemBinding) {
          bindingPersistenceQueue = bindingPersistenceQueue
            .then(() => updateWorkItemBinding(event.binding))
            .catch(() => {});
        }
      },
    });
    const openedBinding = bindingCoordinator.snapshot();
    const publishedCheckpoint = openedBinding.state === 'conflict'
      && openedBinding.reason === 'replaced'
      ? recoverablePublishedCheckpoint(sessionStore.state, {
          deckId:effectiveDeckId,
          currentFingerprint:initialization.currentFingerprint,
        })
      : null;
    if (publishedCheckpoint) {
      await bindingCoordinator.recoverPublishedCheckpoint({
        expectedPath:absoluteDeckPath,
        expectedFingerprint:publishedCheckpoint.fingerprint,
        expectedBindingRevision:openedBinding.revision,
      });
      await bindingPersistenceQueue;
    }
    if (sessionStore.state.deckId !== effectiveDeckId) {
      await sessionStore.persistState({ ...sessionStore.state, deckId:effectiveDeckId });
    }
  } catch (error) {
    bridge.close();
    await attachmentStore.close().catch(() => {});
    await agentWorkspaceStore.close().catch(() => {});
    await bindingCoordinator?.close?.().catch(() => {});
    await sidecarBoundary.io.close().catch(() => {});
    throw error;
  }

  const agentContext = () => ({
    deckPath:workingDeckStore.path,
    sourceDeckPath:currentDeckPath,
    projectPath:agentWorkspaceStore.snapshot().projectRoot,
    serviceUrl:serviceOrigin,
    token,
    creationContextPath:creationHandoffState?.path ?? null,
  });

  try {
    const terminalAdapter = {
        id:'agent-terminal',
        submissionAware:true,
        get mode() { return 'terminal'; },
        async run(context) {
          if (!agentTerminal) {
            throw httpError('AGENT_TERMINAL_UNAVAILABLE', 503, 'Agent 终端尚未完成初始化');
          }
          const persistedProvider = agentWorkspaceStore.snapshot().activeProvider;
          if (!isAgentProviderId(persistedProvider)) {
            throw httpError(
              'AGENT_PROVIDER_UNAVAILABLE', 503,
              `当前 Agent provider 不受支持：${String(persistedProvider)}`,
            );
          }
          const provider = persistedProvider;
          const firstTurn = agentTerminal.snapshot().state !== 'running'
            || agentTerminal.snapshot().provider !== provider;
          const prompt = buildAgentPrompt({
            ...context,
            sourceThreadId:null,
            loadSkill:firstTurn,
            skillInvocation:provider === 'codex'
              ? '$aico-ppt'
              : '请先读取并使用 aico-ppt Skill。',
            environmentCredentials:true,
          });
          context.onProgress?.({
            status:'queued',
            mode:'terminal',
            message:firstTurn
              ? `正在启动 ${agentProviderDefinition(provider).label} 终端并提交反馈`
              : '正在等待当前 Agent 终端空闲并提交本批反馈',
          });
          // 这个期限只约束终端启动、输入框就绪和提示词提交。提示词已被 Agent
          // 确认接收后，长任务可能合理地运行超过该时长；此时应依靠任务状态、
          // 终端退出/回到输入框或用户取消来结算，不能用提交期限误报失败。
          const submissionDeadline = Date.now() + agentRunTimeoutMs;
          let submittedPromptId = null;
          if (firstTurn) {
            await agentTerminal.start({ provider, initialPrompt:prompt });
            if (typeof agentTerminal.waitUntilStartupPromptSubmitted === 'function') {
              const submittedState = await agentTerminal.waitUntilStartupPromptSubmitted({
                timeoutMs:Math.max(1, submissionDeadline - Date.now()),
              });
              submittedPromptId = submittedState.promptSubmission?.id ?? null;
            } else {
              await agentTerminal.waitUntilReady?.({
                timeoutMs:Math.max(1, submissionDeadline - Date.now()),
              });
            }
          } else {
            await agentTerminal.waitUntilReady?.({
              timeoutMs:Math.max(1, submissionDeadline - Date.now()),
            });
            const submissionId = agentTerminal.submitPrompt(prompt);
            submittedPromptId = submissionId;
            if (typeof agentTerminal.waitUntilPromptSubmission === 'function') {
              await agentTerminal.waitUntilPromptSubmission(submissionId, {
                timeoutMs:Math.max(1, submissionDeadline - Date.now()),
              });
            }
          }
          context.onProgress?.({
            status:'running',
            mode:'terminal',
            message:'任务已确认提交到当前 Agent 终端，请在右侧查看实时过程',
          });
          let heartbeatAt = Date.now();
          for (;;) {
            if (context.signal?.aborted) {
              throw httpError('AGENT_RUN_CANCELLED', 409, 'Agent 任务已取消');
            }
            const remaining = new Set(context.taskIds);
            for (const task of sessionStore.state.tasks) {
              if (remaining.has(task.id) && !['pending', 'failed'].includes(task.status)) {
                remaining.delete(task.id);
              }
            }
            if (remaining.size === 0) {
              return { mode:'terminal', summary:'Agent 已在终端中完成本批处理，请检查页面结果' };
            }
            const terminalState = agentTerminal.snapshot();
            if (['failed', 'exited', 'closed'].includes(terminalState.state)) {
              throw httpError(
                'AGENT_TERMINAL_EXITED', 502,
                `${terminalState.providerLabel} 终端已退出，仍有 ${remaining.size} 个任务未完成`,
              );
            }
            const submittedTurnCompleted = submittedPromptId
              ? terminalState.completedPromptSubmissionId === submittedPromptId
              : terminalState.turnState === 'idle';
            if (submittedTurnCompleted) {
              const partial = remaining.size < context.taskIds.length;
              throw httpError(
                partial ? 'AGENT_TASKS_INCOMPLETE' : 'AGENT_TASKS_UNCHANGED',
                502,
                partial
                  ? `Agent 已返回输入框，但仍有 ${remaining.size} 个任务未处理，可直接重试`
                  : `Agent 已返回输入框，但 ${remaining.size} 个任务均未处理，可直接重试`,
              );
            }
            if (Date.now() - heartbeatAt >= 15_000) {
              heartbeatAt = Date.now();
              context.onProgress?.({
                mode:'terminal',
                message:`Agent 仍在终端中处理，剩余 ${remaining.size} 个任务`,
              });
            }
            await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
          }
        },
    };
    dshRunAdapter = dshAgentBridge ? createDshAgentRunAdapter({
      getSession:() => sessionStore.state,
      getAssignedSessionId:async () => (
        (await dshWorkItemProvider())?.dshBinding?.activeSessionId ?? null
      ),
      publishRequest:request => broadcast(
        'dsh-agent-request', sessionStore.state.revision, request,
      ),
      runTimeoutMs:agentRunTimeoutMs,
    }) : null;
    const runAdapter = agentRunAdapter ?? dshRunAdapter ?? terminalAdapter;
    agentRuns = new AgentBatchCoordinator({
      provider:runAdapter.id,
      adapter:runAdapter,
      getSession:() => sessionStore.state,
      getContext:agentContext,
      captureBatch:input => bridge.captureAgentBatch(input),
      settleBatch:input => bridge.settleAgentBatch(input),
      onUpdate:run => broadcast('agent-run-updated', sessionStore.state.revision, run),
    });
  } catch (error) {
    bridge.close();
    await attachmentStore.close().catch(() => {});
    await sidecarBoundary.io.close();
    throw error;
  }

  const serializeTaskOutput = async (task, revision, { committed=false } = {}) => {
    try {
      return await attachmentStore.serializeTaskVerified(task);
    } catch (error) {
      if (committed && error && typeof error === 'object') {
        error.committed = true;
        error.commitScope = 'session';
        error.revision = revision;
      }
      throw error;
    }
  };

  const serializeTaskResult = async (result, { committed=false } = {}) => {
    if (!result?.task) return result;
    return {
      ...result,
      task:await serializeTaskOutput(result.task, result.revision, { committed }),
    };
  };

  const watchListener = () => {
    const generation = watcherGeneration;
    watcherQueue = watcherQueue.then(async () => {
      if (watcherClosed || generation !== watcherGeneration) return;
      const changed = await bridge.noteDeckFingerprint(async () => {
        try { return (await sidecarBoundary.io.hashDeck()).fingerprint; }
        catch (error) {
          const binding = await bindingCoordinator.reconcile({ cause:'watcher' });
          if (binding.state !== 'bound') return sessionStore.state.deckFingerprint;
          try { return (await sidecarBoundary.io.hashDeck()).fingerprint; }
          catch { return `unavailable:${error.code ?? 'READ_ERROR'}`; }
        }
      });
      if (!watcherClosed && generation === watcherGeneration && changed) {
        broadcast('deck-conflict', sessionStore.state.revision, sessionStore.state.conflict);
      }
    }).catch(() => {});
  };

  const publishSourceMutation = async (change, {
    sourceEditId=null, expectedRevision=sessionStore.state.revision,
    solidifiedPatchRepair=null, actionReconciliation=null,
  } = {}) => {
    const source = {
      beforeFingerprint:change.beforeFingerprint,
      afterFingerprint:change.afterFingerprint,
      origin:'working-copy',
      summary:'终端或外部工具修改工作副本',
      recordedAt:new Date().toISOString(),
    };
    source.actionReconciliation = actionReconciliation;
    source.impact = actionReconciliation?.impact ?? {flow:'full-edit',pageKeys:[]};
    const transaction = {
      restore:(target, expected) => workingDeckStore.restore(target, expected),
    };
    const result = sourceEditId === null
      ? await bridge.recordSourceMutation(source, {
        ...transaction,
        solidifiedPatchRepair,
      })
      : await bridge.commitSourceEdit({
        sourceEditId,
        expectedRevision,
        source,
        ...transaction,
        solidifiedPatchRepair,
        finalize:afterFingerprint => workingDeckStore.confirmExternalChange(afterFingerprint),
      });
    if (sourceEditId === null) workingDeckStore.confirmExternalChange(change.afterFingerprint);
    const serializedResult = await serializeTaskResult(result, { committed:true });
    broadcast('source-mutation-recorded', result.revision, serializedResult);
    broadcast('working-deck-changed', result.revision, {
      groupId:result.groupId,
      reason:'source-mutation',
      workingDeckFingerprint:change.afterFingerprint,
    });
    return serializedResult;
  };

  const checkpointWorkingDeckChange = async ({
    allowSourceEdit=false,
    sourceEditId=null,
    expectedRevision=sessionStore.state.revision,
    beforePublish=async()=>{},
  } = {}) => {
    if (!workingDeckStore.managed) return;
    const generation = watcherGeneration;
    if (watcherClosed || generation !== watcherGeneration) return;
    if (!allowSourceEdit && bridge.sourceEditSnapshot()) return;
    const change = await workingDeckStore.checkpointExternalChange();
    if (!change) return;
    if (watcherClosed || generation !== watcherGeneration) return;
    const effectivePatches = structuredClone(workingDeckStore.embeddedPatches ?? []);
    const droppableActionIds = new Set(
      (sessionStore.state.solidifiedActions ?? []).map(action => action?.id),
    );
    const droppedActionIds = [];
    let actionReconciliation;
    try {
      actionReconciliation = await reconcileSourceActions(change, sessionStore.state.groups, sidecarBoundary.io, pythonExecutable);
      while (true) {
        try {
          await workingPatchVerifier(workingDeckStore.path);
          break;
        } catch (error) {
          const failedActionId = error?.failedActionId;
          const canDrop = error?.code === 'PATCH_REPLAY_FAILED'
            && ['PAGE_NOT_FOUND', 'TARGET_NOT_FOUND'].includes(error?.replayCode)
            && droppableActionIds.has(failedActionId);
          const failedIndex = canDrop
            ? effectivePatches.findIndex(patch => patch?.id === failedActionId)
            : -1;
          if (failedIndex < 0) throw error;
          effectivePatches.splice(failedIndex, 1);
          droppedActionIds.push(failedActionId);
          const rewritten = await workingDeckStore.rewritePendingExternalPatches(
            effectivePatches,
          );
          change.afterFingerprint = rewritten.change.afterFingerprint;
        }
      }
      // 新源码必须连同未固化动作验证，避免预览成功后到固化才发现旧动作失效。
      const groups=[{active:true,actions:effectivePatches},...sessionStore.state.groups,
        {id:'candidate-source',active:true,mutationType:'source',source:{...change,actionReconciliation},actions:[]}];
      const actions=compileActionGroups(groups);
      const checked=await verifyEffectiveDeck({bytes:await workingDeckStore.read(),actions,pythonExecutable},
        {verify:workingPatchVerifier,droppableActionIds:[...new Set([...droppableActionIds,...sourceRebaseActionIds(groups,actions)])]});
      const missing=new Set(checked.droppedActionIds ?? []);
      actionReconciliation.supersededKeys=[...new Set([...actionReconciliation.supersededKeys,
        ...actions.filter(a=>missing.has(a.id)).map(actionKey)])];
      await beforePublish();
    } catch (error) {
      try {
        await workingDeckStore.discardExternalChange(change.beforeFingerprint);
      } catch (restoreError) {
        throw detailedHttpError(
          'RECOVERY_REQUIRED', 503,
          '工作副本补丁重放失败且无法恢复，请重启 Editor 完成对账',
          { cause:restoreError, originalError:error },
        );
      }
      throw error;
    }
    return publishSourceMutation(change, {
      actionReconciliation,
      sourceEditId,
      expectedRevision,
      solidifiedPatchRepair:droppedActionIds.length > 0 ? {
        effectivePatches,
        droppedActionIds,
      } : null,
    });
  };

  const restoreVerifiedSourceVersion = async (targetFingerprint, expectedFingerprint, actions=null) => {
    const restored = await workingDeckStore.restore(targetFingerprint, expectedFingerprint);
    try {
      if(actions)await verifyEffectiveDeck({bytes:await workingDeckStore.read(),actions,pythonExecutable},{verify:workingPatchVerifier});
      else await workingPatchVerifier(workingDeckStore.path);
    } catch (error) {
      try {
        await workingDeckStore.restore(expectedFingerprint, targetFingerprint);
      } catch (restoreError) {
        throw detailedHttpError(
          'RECOVERY_REQUIRED', 503,
          '结构历史目标补丁重放失败且无法恢复，请重启 Editor 完成对账',
          { cause:restoreError, originalError:error },
        );
      }
      throw error;
    }
    return restored;
  };

  const queueWorkingDeckCheckpoint = () => {
    const generation = watcherGeneration;
    pendingWorkingCheckpoints += 1;
    const operation = workingWatcherQueue.then(checkpointWorkingDeckChange).finally(()=>{pendingWorkingCheckpoints -= 1;});
    workingWatcherQueue = operation.catch(error => {
      if (!watcherClosed && generation === watcherGeneration) {
        broadcast('source-mutation-failed', sessionStore.state.revision, {
          code:error?.code ?? 'SOURCE_MUTATION_FAILED',
          message:error?.message ?? '工作副本修改无法进入历史',
        });
      }
    });
    return operation;
  };

  // 文件系统通知只能说明“可能发生了变化”，不能作为 mutation 的提交顺序。
  // 所有带 revision 的写操作先穿过同一个检查点 seam：若 Agent 已经写盘，
  // SourceMutation 必须先增加 revision，随后旧请求以 REVISION_CONFLICT 安全重试。
  const editorView = createEditorViews();
  const localEdits=new Map();
  const guardWorkingRevision = async expectedRevision => {
    if (workingDeckStore.managed) await queueWorkingDeckCheckpoint();
    bridge.assertRevision(expectedRevision);
  };
  const guardEditRevision = async (expectedRevision, taskId=null) => {
    if (workingDeckStore.managed) await queueWorkingDeckCheckpoint();
    return bridge.assertEditRevision(expectedRevision, taskId);
  };

  const beginSourceEdit = async ({ expectedRevision, taskId=null, commandId=null, requestDigest=null }) => {
    if (!workingDeckStore.managed) {
      throw httpError('SOURCE_EDIT_UNAVAILABLE', 409, '当前 Deck 没有托管工作副本');
    }
    await guardEditRevision(expectedRevision, taskId);
    const result = await bridge.beginSourceEdit({
      expectedRevision,
      taskId,
      beforeFingerprint:workingDeckStore.fingerprint, commandId, requestDigest,
    });
    return { ...result, workingDeckPath:workingDeckStore.path };
  };

  const commitSourceEdit = async ({ sourceEditId, expectedRevision, beforePublish }) => {
    const active = bridge.sourceEditSnapshot();
    if (!active || active.id !== sourceEditId) {
      // 让 Bridge 生成稳定的 NOT_FOUND / MISMATCH 错误，同时不读取或改写工作副本。
      return bridge.commitSourceEdit({ sourceEditId, expectedRevision, source:null });
    }
    const result = await checkpointWorkingDeckChange({
      allowSourceEdit:true, sourceEditId, expectedRevision, beforePublish,
    });
    if (!result) {
      throw httpError('SOURCE_EDIT_NO_CHANGE', 409, '源码事务尚未写入工作副本');
    }
    return result;
  };

  const cancelSourceEdit = ({ sourceEditId, expectedRevision }) => bridge.cancelSourceEdit({
    sourceEditId,
    expectedRevision,
    discard:beforeFingerprint => workingDeckStore.discardExternalChange(beforeFingerprint),
  });

  const workingWatchListener = () => {
    void queueWorkingDeckCheckpoint().catch(() => {});
  };

  const pptxExportJob = createPptxExportJob({
    prepare:async expectedRevision => {
      await guardWorkingRevision(expectedRevision);
      const patches = bridge.compiledRuntimeWriteActions();
      return workingDeckStore.managed
        ? workingDeckStore.materializePatches(patches)
        : workingDeckStore.read();
    },
    pickPath:pickPptxFile,
    convert:input => pptxExporter({ ...input, pythonExecutable, timeoutMs:pptxExportTimeoutMs }),
  });

  const connectionLog = connectionDiagnostics('ppt-editor');
  const connectionRecord = (event, details = {}) => connectionLog.record(event, {sessionId:sessionStore.state.sessionId, ...details});
  connectionRecord('service-start');
  // 仅在启动恢复完成、或关闭时全部写入队列已排空后回收；不与编辑事务并发。
  const collectUnusedWorkingVersions = async () => {
    if (!workingDeckStore.managed) return;
    try {
      const result = await sidecarBoundary.io.pruneWorkingVersions();
      connectionRecord('working-version-gc', {
        removed:result.removed, removedBytes:result.removedBytes,
        kept:result.kept, skipped:result.skipped ?? null,
      });
    } catch (error) {
      // 缓存维护失败不改变原有恢复/发布结果，保留快照并记录诊断。
      connectionRecord('working-version-gc-skipped', {code:error?.code ?? 'UNKNOWN'});
    }
  };
  await collectUnusedWorkingVersions();
  let diagnosticWindow = 0, diagnosticCount = 0;
  let solidifying = false;
  const server = createServer(async (request, response) => {
    let ownsSolidification = false;
    response.once('finish', () => {
      if (response.statusCode >= 400 && request.url?.startsWith('/api/actions')) connectionRecord('action-rejected', {status:response.statusCode});
      if (watcherClosed) server.closeIdleConnections?.();
    });
    try {
      const url = new URL(request.url ?? '/', `http://${urlHost}`);
      const { pathname } = url;
      if (isProtected(pathname)) authorize(request, url, token, serviceOrigin);

      if (request.method === 'GET' && pathname === '/') {
        sendEditorIndex(
          request, response, url, token, editorToken, serviceOrigin, pinnedEditorIndex,
        );
        return;
      }

      if (request.method === 'POST' && pathname === '/api/connection-diagnostics') {
        if (url.searchParams.get('editorToken') !== editorToken) throw httpError('EDITOR_CAPABILITY_REQUIRED',403,'连接诊断需要编辑器能力令牌');
        const body = await readJson(request);
        if (Date.now() - diagnosticWindow > 60000) { diagnosticWindow = Date.now(); diagnosticCount = 0; }
        if (++diagnosticCount > 120) { json(response,429,{accepted:false}); return; }
        if (!['connecting','open','close','reconnect-scheduled','socket-error'].includes(body.event)) throw httpError('INVALID_INPUT',400,'无效连接事件');
        connectionRecord('browser-' + body.event, body);
        json(response,200,{accepted:true}); return;
      }
      if (request.method === 'POST' && pathname === '/api/view-context') {
        if (url.searchParams.get('editorToken') !== editorToken) throw httpError('EDITOR_CAPABILITY_REQUIRED',403,'视图上报需要编辑器能力令牌');
        const body = await readJson(request);
        if (typeof body.pageKey !== 'string' || body.pageKey.length > 200
          || JSON.stringify(body).length > 16000 || !Number.isSafeInteger(body.revision)
          || body.revision < 0 || body.revision > sessionStore.state.revision) {
          throw httpError('INVALID_VIEW_CONTEXT', 400, '当前视图信息无效');
        }
        viewContext = { pageKey:body.pageKey, pageIndex:Number.isSafeInteger(body.pageIndex) ? body.pageIndex : null,
          pageLabel:String(body.pageLabel ?? '').slice(0,200),
          selection:body.selection ?? null, scroll:body.scroll ?? null,
          revision:body.revision, observedAt:Date.now() };
        json(response,200,{accepted:true});
        return;
      }
      if (request.method === 'POST' && pathname === '/api/agent-runs/cancel') {
        const body = await readJson(request);
        requireRevision(body.expectedRevision);
        if (body.batchId !== agentRuns.snapshot().activeBatch?.id) {
          throw httpError('AGENT_BATCH_CHANGED',409,'当前批次已变化，请重新读取任务列表');
        }
        const cancelledTasks=new Set(agentRuns.snapshot().activeBatch?.taskIds??[]);
        for(const {abort,taskId} of localEdits.values())if(cancelledTasks.has(taskId))abort.abort(new Error('反馈批次已取消'));
        agentRuns.cancel('用户取消了本批任务等待；未完成任务可删除或重新提交');
        await agentRuns.activePromise;
        json(response,200,{revision:sessionStore.state.revision,run:agentRuns.snapshot()});
        return;
      }
      if (request.method === 'POST' && ['/api/inspect','/api/view','/api/verify'].includes(pathname)) {
        const body=await readJson(request);
        if(solidifying)throw httpError('EDITOR_SOLIDIFYING',409,'Deck 正在固化，请在完成后读取稳定版本');
        const task=body.taskId ? sessionStore.state.tasks.find(t=>t.id===body.taskId) : null;
        if(body.taskId&&!task)throw httpError('TASK_NOT_FOUND',404,'找不到区域反馈任务；普通查看不传 taskId，Work Item ID 不是 taskId');
        const revision=body.expectedRevision ?? sessionStore.state.revision;
        requireRevision(revision);
        await guardEditRevision(revision, body.taskId ?? null);
        if(bridge.sourceEditSnapshot())throw httpError('SOURCE_EDIT_ACTIVE',409,'源码事务尚未完成');
        const actions=bridge.compiledRuntimeWriteActions();
        const bytes=await workingDeckStore.read();
        bridge.assertEditRevision(revision, body.taskId ?? null);
        let result;
        if(pathname==='/api/verify') {
          result=await verifyEffectiveDeck({bytes,actions,pythonExecutable},
            {verify:workingPatchVerifier,droppableActionIds:bridge.sourceRebaseActionIds(actions)});
          result={...result,scope:'full-history-replay'};
        } else {
          if(body.query!==undefined&&(typeof body.query!=='string'||body.query.length>500))throw httpError('INVALID_INPUT',400,'检索文字无效');
          const targetPage=body.pageKey??task?.pageKey??(viewContext && Date.now()-viewContext.observedAt<15000 ? viewContext.pageKey : undefined);
          result=await editorView({bytes,actions,pythonExecutable},
            {pageKey:targetPage,catalogOnly:body.catalogOnly===true||!targetPage,query:body.query??'',rect:task?.rect??null,mode:pathname==='/api/view'?'view':'inspect',limit:body.limit,offset:body.offset,includePages:body.includePages===true});
          result={...result,task:task?structuredClone(task):null};
          if(body.detail==='source'){
            if(!body.target?.editorId||!body.target?.pageKey)throw httpError('INVALID_INPUT',400,'源码检查需要明确 target');
            result={...result,...await inspectLocalSource(bytes,body.target,{pythonExecutable})};
          }
        }
        bridge.assertEditRevision(revision, body.taskId ?? null);
        json(response,200,{...result,revision,contentRevision:sessionStore.state.editScope?.contentRevision ?? revision});
        return;
      }
      const commandMatch=pathname.match(/^\/api\/commands\/([a-f0-9-]+)$/);
      if(request.method==='GET'&&commandMatch) {
        const receipt=sessionStore.state.completedCommands?.[commandMatch[1]];
        json(response,200,{commandId:commandMatch[1],revision:sessionStore.state.revision,
          committed:receipt?true:null,...(receipt?{receipt}:{}),
          message:receipt?'修改已提交，请勿重新执行':'未找到提交回执；旧回执可能已过期，需核对任务和历史'});
        return;
      }
      if (request.method === 'GET' && pathname === '/api/session') {
        json(response, 200, sessionStore.state);
        return;
      }
      if (request.method === 'POST' && pathname === '/api/shutdown') {
        if (request.headers.origin === undefined) {
          throw httpError(
            'BROWSER_ORIGIN_REQUIRED', 403,
            '退出接口只接受当前 Editor 页面发起的请求',
          );
        }
        if (url.searchParams.get('editorToken') !== editorToken) {
          throw httpError(
            'EDITOR_CAPABILITY_REQUIRED', 403,
            '退出接口缺少编辑器能力令牌',
          );
        }
        json(response, 202, { status:'shutting-down' });
        setImmediate(() => void close().catch(() => {}));
        return;
      }
      if (pathname === '/api/export/pptx/job') {
        if (url.searchParams.get('editorToken') !== editorToken) {
          throw httpError('EDITOR_CAPABILITY_REQUIRED', 403, '导出保存需要编辑器能力令牌');
        }
        if (request.method === 'GET') {
          json(response, 200, pptxExportJob.snapshot());
          return;
        }
        if (request.method === 'POST') {
          if (request.headers.origin === undefined) {
            throw httpError('BROWSER_ORIGIN_REQUIRED', 403, '保存窗口只接受当前 Editor 页面发起的请求');
          }
          const { expectedRevision, mode = 'editable' } = await readJson(request);
          requireRevision(expectedRevision);
          if (expectedRevision !== sessionStore.state.revision) {
            throw httpError('REVISION_CONFLICT', 409, '编辑内容刚刚更新，请再次点击导出');
          }
          if (!['image', 'editable'].includes(mode)) {
            throw httpError('PPTX_EXPORT_MODE_INVALID', 400, 'PPTX 导出模式必须为 image 或 editable');
          }
          if (pptxExportBusy) throw httpError('PPTX_EXPORT_BUSY', 409, '已有一个 PPTX 正在导出，请稍候');
          const filename = `${basename(currentDeckPath, extname(currentDeckPath)) || 'deck'}.pptx`;
          const projectRoot = agentWorkspaceStore.snapshot().projectRoot;
          json(response, 202, pptxExportJob.start({ expectedRevision, mode,
            defaultPath:join(projectRoot, filename) }));
          return;
        }
      }
      if (request.method === 'POST' && pathname === '/api/export/pptx') {
        const { expectedRevision, mode = 'image' } = await readJson(request);
        requireRevision(expectedRevision);
        if (mode !== 'image' && mode !== 'editable') {
          throw httpError('PPTX_EXPORT_MODE_INVALID', 400, 'PPTX 导出模式必须为 image 或 editable');
        }
        await guardWorkingRevision(expectedRevision);
        if (pptxExportBusy || pptxExportJob.busy) {
          throw httpError('PPTX_EXPORT_BUSY', 409, '已有一个 PPTX 正在导出，请稍候');
        }
        pptxExportBusy = true;
        const controller = new AbortController();
        const operation = (async () => {
          const patches = bridge.compiledRuntimeWriteActions();
          const htmlBytes = workingDeckStore.managed
            ? await workingDeckStore.materializePatches(patches)
            : await workingDeckStore.read();
          return pptxExporter({
            htmlBytes,
            mode,
            pythonExecutable,
            timeoutMs:pptxExportTimeoutMs,
            signal:controller.signal,
          });
        })();
        const job = { controller, promise:operation };
        activePptxExports.add(job);
        try {
          const exported = await operation;
          const pptxBytes = Buffer.isBuffer(exported) ? exported : Buffer.from(exported ?? []);
          if (pptxBytes.length === 0) {
            throw httpError('PPTX_EXPORT_FAILED', 500, 'PPTX 导出结果为空');
          }
          const stem = basename(currentDeckPath, extname(currentDeckPath)) || 'deck';
          const downloadName = `${stem}.pptx`;
          send(response, 200, pptxBytes, PPTX_CONTENT_TYPE, {
            'content-disposition':`attachment; filename="deck.pptx"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
          });
        } finally {
          pptxExportBusy = false;
          activePptxExports.delete(job);
        }
        return;
      }
      if (request.method === 'GET' && pathname === '/api/deck-binding') {
        json(response, 200, bindingCoordinator.snapshot());
        return;
      }
      if (request.method === 'POST' && pathname === '/api/deck-binding/reconcile') {
        json(response, 200, await bindingCoordinator.reconcile({ cause:'manual' }));
        return;
      }
      if (request.method === 'POST' && pathname === '/api/deck-binding/choose-file') {
        const {
          expectedBindingRevision,
          confirmation = 'same-file',
          candidatePath:confirmedCandidatePath,
        } = await readJson(request);
        const candidatePath = confirmation === 'verified-copy'
          && typeof confirmedCandidatePath === 'string'
          ? confirmedCandidatePath
          : await pickDeckFile({});
        if (candidatePath === null) {
          json(response, 200, { status:'cancelled', binding:bindingCoordinator.snapshot() });
          return;
        }
        const binding = await bindingCoordinator.rebind({
          candidatePath,
          expectedBindingRevision,
          confirmation,
        });
        json(response, 200, { status:'rebound', binding });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/workspace-history') {
        json(response, 200, await workspaceHistoryProvider({
          bindings:url.searchParams.get('bindings') === 'metadata' ? 'metadata' : 'refresh',
        }));
        return;
      }
      if (request.method === 'GET' && pathname === '/api/dsh-work-item') {
        if (!dshAgentBridge) {
          throw httpError('DSH_AGENT_BRIDGE_UNAVAILABLE', 409, '当前 Editor 未启用 DSH 工作项协调器');
        }
        json(response, 200, { workItem:await dshWorkItemProvider() });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/dsh-work-item/commands') {
        if (!dshAgentBridge) {
          throw httpError('DSH_AGENT_BRIDGE_UNAVAILABLE', 409, '当前 Editor 未启用 DSH 工作项协调器');
        }
        const { command, ...input } = await readJson(request);
        if (typeof command !== 'string' || !command) {
          throw httpError('INVALID_DSH_COMMAND', 400, 'DSH 工作项命令无效');
        }
        json(response, 200, await dshWorkItemCommand(command, { ...input, workId }));
        return;
      }
      if (request.method === 'POST' && pathname === '/api/work-items/rename') {
        if (!renameWorkItem) {
          throw httpError('WORK_ITEM_RENAME_UNAVAILABLE', 409, '当前启动方式不支持修改工作项名称');
        }
        const body = await readJson(request);
        const workItem = await renameWorkItem({
          workId:body.workId,
          displayName:body.displayName,
          expectedRevision:body.expectedRevision,
        });
        json(response, 200, { status:'renamed', workItem });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/text-locations') {
        const text = url.searchParams.get('text') ?? '';
        const pageKey = url.searchParams.get('pageKey');
        if (!text || text.length > 500) {
          throw httpError('INVALID_TEXT_QUERY', 400, 'text 必须为 1 到 500 个字符');
        }
        json(response, 200, await bridge.locateText(text, { pageKey }));
        return;
      }
      if (request.method === 'GET' && pathname === '/api/agent-terminal') {
        json(response, 200, agentTerminal?.snapshot() ?? {
          provider:'codex',
          state:'stopped',
        });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/tasks') {
        const tasks = await Promise.all(sessionStore.state.tasks.map(task => (
          serializeTaskOutput(task, sessionStore.state.revision)
        )));
        json(response, 200, tasks);
        return;
      }
      if (request.method === 'GET' && pathname === '/api/agent-runs/current') {
        json(response, 200, agentRuns.snapshot());
        return;
      }
      if (request.method === 'POST' && pathname === '/api/agent-runs') {
        const { expectedRevision, taskIds } = await readJson(request);
        requireRevision(expectedRevision);
        await guardWorkingRevision(expectedRevision);
        const terminalState = agentTerminal?.snapshot();
        if (terminalState?.interactionRequired?.kind) {
          throw httpError(
            'AGENT_TERMINAL_INTERACTION_REQUIRED', 409,
            terminalState.interactionRequired.message || '请先完成 Agent 终端中的确认',
          );
        }
        if (terminalState?.resumePending === true) {
          throw httpError(
            'AGENT_TERMINAL_RESUMING', 409,
            'Codex 会话正在恢复，等待输入界面就绪后再提交任务',
          );
        }
        if (terminalState?.initialInputPending === true) {
          throw httpError(
            'AGENT_TERMINAL_INITIALIZING', 409,
            'Agent 终端正在启动，等待输入界面就绪后再提交任务',
          );
        }
        if (['active', 'submitting'].includes(terminalState?.turnState)) {
          throw httpError(
            'AGENT_TERMINAL_BUSY', 409,
            'Agent 当前回合仍在处理，等待真正返回空闲输入界面后再提交下一批任务',
          );
        }
        const run = await agentRuns.submit({ expectedRevision, taskIds });
        json(response, 202, run);
        return;
      }
      if (request.method === 'POST' && pathname === '/api/dsh-agent-requests/acknowledge') {
        if (!dshRunAdapter) {
          throw httpError('DSH_AGENT_BRIDGE_UNAVAILABLE', 409, '当前 Editor 未启用 DSH Agent 适配器');
        }
        const result = dshRunAdapter.acknowledge(await readJson(request));
        json(response, 200, result);
        return;
      }
      if (request.method === 'POST' && pathname === '/api/tasks') {
        let attachmentsLifecycle = null;
        let attachmentOwnershipTransferred = false;
        let primaryError = null;
        try {
          const contentType = request.headers['content-type'] ?? '';
          const mediaType = requestMediaType(contentType);
          let body;
          if (mediaType === 'multipart/form-data') {
            await attachmentStore.guard();
            const parsed = await parseTaskMultipart(request, { attachmentStore });
            attachmentsLifecycle = parsed.upload;
            body = { ...parsed.input, snapshot:parsed.snapshot };
          } else if (mediaType === 'application/json') {
            body = await readJson(request);
          } else {
            throw httpError(
              'UNSUPPORTED_MEDIA_TYPE', 415,
              '任务请求必须是 JSON 或 multipart/form-data',
            );
          }
          const { expectedRevision, ...input } = body;
          requireRevision(expectedRevision);
          validateTask(input);
          await guardWorkingRevision(expectedRevision);
          const result = await bridge.createTask(input, expectedRevision, {
            attachmentsLifecycle,
          });
          attachmentOwnershipTransferred = true;
          const task = await serializeTaskOutput(result.task, result.revision, {
            committed:true,
          });
          broadcast('task-created', result.revision, task);
          json(response, 201, { ...result, task });
        } catch (error) {
          primaryError = error;
          throw error;
        } finally {
          if (attachmentsLifecycle && !attachmentOwnershipTransferred
            && attachmentsLifecycle.published !== true) {
            try {
              await attachmentsLifecycle.discard();
            } catch (cleanupError) {
              if (cleanupError?.committed === true) {
                if (cleanupError.cause === undefined && primaryError !== null) {
                  try { cleanupError.cause = primaryError; } catch { /* 保留已冻结错误 */ }
                }
                throw cleanupError;
              }
              if (primaryError === null) throw cleanupError;
              try { primaryError.cleanupError = cleanupError; } catch { /* 保留首错 */ }
            }
          }
        }
        return;
      }
      const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch && ['PATCH', 'DELETE'].includes(request.method)) {
        const id = decodeURIComponent(taskMatch[1]);
        const body = await readJson(request);
        requireRevision(body.expectedRevision);
        await guardWorkingRevision(body.expectedRevision);
        const activeBatch = agentRuns.snapshot().activeBatch;
        if (activeBatch?.taskIds?.includes(id)) {
          if (request.method !== 'DELETE' || body.cancelActiveBatch !== true) {
            throw httpError('AGENT_BATCH_TASK_LOCKED',409,'此任务属于活动批次；删除时需明确取消本批等待');
          }
          if (bridge.sourceEditSnapshot()) throw httpError('SOURCE_EDIT_ACTIVE',409,'源码事务尚未结束，请先完成或取消源码事务');
          agentRuns.cancel('用户删除任务，已取消本批等待；其余未完成任务可重新提交');
          await agentRuns.activePromise;
          // 只接受取消结算造成的一次 revision 变化，不能吞掉并发编辑。
          requireRevision(body.expectedRevision + 1);
          if (agentRuns.snapshot().activeBatch) throw httpError('AGENT_BATCH_CHANGED',409,'已有新的批次，请重新确认');
          body.expectedRevision = sessionStore.state.revision;
        }
        if (request.method === 'PATCH') {
          const result = await bridge.updateTask(id, body.instruction, body.expectedRevision);
          const task = await serializeTaskOutput(result.task, result.revision, { committed:true });
          broadcast('task-updated', result.revision, task);
          json(response, 200, { ...result, task });
          return;
        }
        const result = await bridge.deleteTask(id, body.expectedRevision);
        broadcast('task-deleted', result.revision, { id });
        json(response, 200, result);
        return;
      }
      if (taskMatch && request.method === 'GET') {
        const id = decodeURIComponent(taskMatch[1]);
        const task = sessionStore.state.tasks.find(candidate => candidate.id === id);
        if (!task) throw httpError('TASK_NOT_FOUND', 404, '找不到任务');
        json(response, 200, await serializeTaskOutput(task, sessionStore.state.revision));
        return;
      }
      if (request.method === 'POST' && pathname === '/api/source-edits') {
        const { expectedRevision, taskId = null } = await readJson(request);
        requireRevision(expectedRevision);
        requireTaskId(taskId);
        const result = await beginSourceEdit({ expectedRevision, taskId });
        broadcast('source-edit-begun', result.revision, result);
        json(response, 201, result);
        return;
      }
      const sourceEditTransactionMatch = pathname.match(
        /^\/api\/source-edits\/([^/]+)\/(commit|cancel)$/,
      );
      if (sourceEditTransactionMatch && request.method === 'POST') {
        const sourceEditId = requireSourceEditId(decodeURIComponent(sourceEditTransactionMatch[1]));
        const operation = sourceEditTransactionMatch[2];
        const { expectedRevision } = await readJson(request);
        requireRevision(expectedRevision);
        const result = operation === 'commit'
          ? await commitSourceEdit({ sourceEditId, expectedRevision })
          : await cancelSourceEdit({ sourceEditId, expectedRevision });
        if (operation === 'cancel') broadcast('source-edit-cancelled', result.revision, result);
        json(response, 200, result);
        return;
      }
      const sourceEditMatch = pathname.match(
        /^\/api\/tasks\/([^/]+)\/source-edit\/(begin|cancel)$/,
      );
      if (sourceEditMatch && request.method === 'POST') {
        if (!workingDeckStore.managed) {
          throw httpError('SOURCE_EDIT_UNAVAILABLE', 409, '当前 Deck 没有托管工作副本');
        }
        const taskId = decodeURIComponent(sourceEditMatch[1]);
        const operation = sourceEditMatch[2];
        const { expectedRevision } = await readJson(request);
        requireRevision(expectedRevision);
        if (operation === 'begin') {
          const result = await beginSourceEdit({ expectedRevision, taskId });
          broadcast('source-edit-begun', result.revision, result);
          json(response, 200, result);
          return;
        }
        const active = bridge.sourceEditSnapshot();
        if (!active) {
          bridge.assertRevision(expectedRevision);
          json(response, 200, {
            taskId, revision:sessionStore.state.revision, cancelled:false,
          });
          return;
        }
        if (active.taskId !== taskId) {
          throw httpError('SOURCE_TASK_ACTIVE', 409, '另一个结构任务正在等待工作副本修改');
        }
        const result = await cancelSourceEdit({
          sourceEditId:active.id, expectedRevision,
        });
        broadcast('source-edit-cancelled', result.revision, result);
        json(response, 200, result);
        return;
      }
      if(request.method==='POST' && pathname==='/api/local-edits') {
        if(solidifying)throw httpError('EDITOR_SOLIDIFYING',409,'正在固化，请稍后重试');
        const {expectedRevision,taskId=null,commandId,operations}=await readJson(request);
        requireRevision(expectedRevision);requireTaskId(taskId);
        if(typeof commandId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(commandId)
          || !Array.isArray(operations)||!operations.length||operations.length>32
          ||operations.some(op=>!LOCAL_EDIT_KINDS.includes(op?.kind)||!op.target?.pageKey||!op.target?.editorId))
          throw httpError('INVALID_INPUT',400,'局部修改需要稳定命令号和有效目标操作');
        const digest=createHash('sha256').update(JSON.stringify({taskId,operations})).digest('hex');
        const duplicate=bridge.replayLocalEdit(commandId,digest);
        if(duplicate){json(response,200,duplicate);return;}
        if(localEdits.has(commandId))throw httpError('COMMAND_IN_PROGRESS',409,'同一修改正在执行，请查询回执');
        if(localEdits.size>=2)throw httpError('LOCAL_EDIT_BUSY',409,'其他局部修改正在准备，请稍后重试');
        const abort=new AbortController();
        const onClose=()=>{if(!response.writableEnded)abort.abort(new Error('局部修改请求已取消'));};
        response.on('close',onClose);localEdits.set(commandId,{abort,taskId});
        let transaction,locked=false,committed=false;
        const started=Date.now();
        try {
          await guardEditRevision(expectedRevision, taskId);
          if(bridge.sourceEditSnapshot())throw httpError('SOURCE_EDIT_ACTIVE',409,'已有结构事务');
          const reserved=await bridge.reserveEditorMutation(commandId,false,operations.map(op=>op.target));locked=true;
          const candidate=await prepareLocalEdit(await workingDeckStore.read(),operations,{pythonExecutable,signal:abort.signal,styles:reserved.styles});
          abort.signal.throwIfAborted();
          transaction=await beginSourceEdit({expectedRevision,taskId,commandId,requestDigest:digest});
          broadcast('source-edit-begun',transaction.revision,transaction);
          await sidecarBoundary.io.writeWorkingDeck({sessionId:sessionStore.state.sessionId,bytes:candidate,expectedFingerprint:workingDeckStore.fingerprint});
          const result=await commitSourceEdit({...transaction,beforePublish:async()=>{
            abort.signal.throwIfAborted();
            await bridge.reserveEditorMutation(commandId);
            abort.signal.throwIfAborted();
          },expectedRevision:transaction.revision});
          committed=true;
          json(response,200,{...result,committed:true,commandId,
            validation:{status:'passed',scope:'full-history-replay'},
            affectedPages:[...new Set(operations.map(op=>op.target.pageKey))],timings:{totalMs:Date.now()-started}});
        } catch(error) {
          if(!committed && error.committed!==true && transaction && bridge.sourceEditSnapshot()?.id===transaction.sourceEditId) {
            await cancelSourceEdit({sourceEditId:transaction.sourceEditId,expectedRevision:sessionStore.state.revision});
            broadcast('source-edit-cancelled',sessionStore.state.revision,{sourceEditId:transaction.sourceEditId});
          }
          throw error;
        } finally {
          if(locked)await bridge.reserveEditorMutation(commandId,true).catch(()=>{});
          response.off('close',onClose);localEdits.delete(commandId);
        }
        return;
      }
      if (request.method === 'POST' && pathname === '/api/actions') {
        const {
          expectedRevision, taskId, actions, coalesceKey, commandId=null,
        } = await readJson(request);
        requireRevision(expectedRevision);
        requireTaskId(taskId);
        if (!Array.isArray(actions) || actions.length === 0) {
          throw httpError('INVALID_INPUT', 400, 'actions 必须为非空数组');
        }
        actions.forEach(action=>{
          if(Object.hasOwn(action,'sourceResizeStyle'))throw httpError('INVALID_INPUT',400,'源码重放证据由编辑器生成');
          validateAction(action);
        });
        if (new Set(actions.map(action => action.id)).size !== actions.length) {
          throw httpError('DUPLICATE_ACTION_ID', 400, '同一批次 action id 不得重复');
        }
        if (coalesceKey !== undefined && (taskId !== null || typeof coalesceKey !== 'string'
          || coalesceKey.length === 0 || coalesceKey.length > 256)) {
          throw httpError('INVALID_INPUT', 400, 'coalesceKey 只允许人工动作使用非空短字符串');
        }
        const duplicate = bridge.replayCompletedAction({
          taskId, actions,
          coalesceKey:coalesceKey ?? null,
          commandId,
        });
        if (duplicate) {
          json(response, 200, await serializeTaskResult(duplicate, { committed:true }));
          return;
        }
        const abort=new AbortController();
        const onClose=()=>{if(!response.writableEnded)abort.abort(new Error('动作请求已取消'));};
        response.on('close',onClose);
        let result;
        try {
          await guardEditRevision(expectedRevision, taskId);
          result = await bridge.applyActions({
            taskId, actions, expectedRevision,
            commandId,signal:abort.signal,
            ...(coalesceKey === undefined ? {} : { coalesceKey }),
          });
        } catch (error) {
          if (error?.task?.id && Number.isSafeInteger(error?.revision)) {
            const task = await serializeTaskOutput(error.task, error.revision, {
              committed:true,
            });
            broadcast('task-updated', error.revision, task);
          }
          throw error;
        } finally {
          response.off('close',onClose);
        }
        const serializedResult = await serializeTaskResult(result, { committed:true });
        broadcast('actions-recorded', result.revision, serializedResult);
        json(response, 200, serializedResult);
        return;
      }
      const groupMatch = request.method === 'POST'
        && pathname.match(/^\/api\/groups\/([^/]+)\/(undo|redo)$/);
      if (groupMatch) {
        const groupId = decodeURIComponent(groupMatch[1]);
        const { expectedRevision } = await readJson(request);
        requireRevision(expectedRevision);
        await guardWorkingRevision(expectedRevision);
        const method = groupMatch[2];
        const sourceGroup = sessionStore.state.groups
          .find(group => group?.id === groupId && group?.mutationType === 'source');
        const result = sourceGroup
          ? await bridge.changeSourceGroup(method, groupId, expectedRevision, {
            restore:restoreVerifiedSourceVersion,
          })
          : (method === 'undo'
            ? await bridge.undoGroup(groupId, expectedRevision)
            : await bridge.redoGroup(groupId, expectedRevision));
        const serializedResult = await serializeTaskResult(result, { committed:true });
        broadcast(
          `group-${method === 'undo' ? 'undone' : 'redone'}`,
          result.revision,
          serializedResult,
        );
        if (sourceGroup) {
          broadcast('working-deck-changed', result.revision, {
            groupId, reason:`source-${method}`,
            workingDeckFingerprint:result.workingDeckFingerprint,
          });
        }
        json(response, 200, serializedResult);
        return;
      }
      if (request.method === 'POST' && pathname === '/api/solidify-preflight') {
        const { expectedRevision, expectedBindingRevision } = await readJson(request);
        requireRevision(expectedRevision);
        await guardWorkingRevision(expectedRevision);
        const binding = await bindingCoordinator.reconcile({ cause:'before-publish' });
        if (expectedBindingRevision !== undefined
          && expectedBindingRevision !== binding.revision) {
          throw detailedHttpError('DECK_BINDING_REVISION_CONFLICT', 409,
            'Deck 文件绑定已更新，请刷新后重试', { binding });
        }
        if (binding.state !== 'bound') {
          throw detailedHttpError('DECK_REBIND_REQUIRED', 409,
            'Editor 不能确认当前源文件，重新绑定前无法固化', { binding });
        }
        const result = await bridge.preflightSolidify(expectedRevision, {
          fingerprint:() => sidecarBoundary.io.hashDeck().then(value => value.fingerprint),
          bindingRevision:binding.revision,
        });
        json(response, 200, { ...result, binding });
        return;
      }
      if (request.method === 'POST'
        && ['/api/write-deck', '/api/solidify-deck'].includes(pathname)) {
        if(solidifying)throw httpError('EDITOR_SOLIDIFYING',409,'Deck 正在固化，请勿重复提交');
        if(pathname==='/api/solidify-deck') {
          solidifying=true;
          ownsSolidification=true;
        }
        const {
          expectedRevision, expectedBindingRevision, preflightToken=null,
        } = await readJson(request);
        requireRevision(expectedRevision);
        await guardWorkingRevision(expectedRevision);
        const solidify = pathname === '/api/solidify-deck';
        if (solidify) {
          const binding = await bindingCoordinator.reconcile({ cause:'before-publish' });
          if (expectedBindingRevision !== undefined
            && expectedBindingRevision !== binding.revision) {
            throw detailedHttpError(
              'DECK_BINDING_REVISION_CONFLICT', 409,
              'Deck 文件绑定已更新，请刷新后重试',
              { binding },
            );
          }
          if (binding.state !== 'bound') {
            throw detailedHttpError(
              'DECK_REBIND_REQUIRED', 409,
              'Editor 不能确认当前源文件，重新绑定前无法固化',
              { binding },
            );
          }
        }
        let result;
        try {
          result = await bridge.writeDeck(
            expectedRevision,
            {
              fingerprint:() => sidecarBoundary.io.hashDeck().then(result => result.fingerprint),
              writer:workingDeckStore.managed
                ? async (patches, expectedFingerprint) => {
                  if (!solidify) {
                    await verifyEffectiveDeck({bytes:await workingDeckStore.read(),actions:patches,pythonExecutable},
                      {verify:workingPatchVerifier,droppableActionIds:bridge.sourceRebaseActionIds(patches)});
                    return {
                      ok:true,
                      fingerprint:workingDeckStore.fingerprint,
                      previousFingerprint:workingDeckStore.fingerprint,
                    };
                  }
                  const workingResult = await writeVerifiedWorkingPatches(
                    workingDeckStore, patches, {
                      verify:workingPatchVerifier,
                      droppableActionIds:bridge.sourceRebaseActionIds(patches),
                    },
                  );
                  try {
                    const published = await runWriteTransaction({
                      deckPath:currentDeckPath,
                      sessionDir:sessionStore.sessionDir,
                      expectedFingerprint,
                      sidecarBoundary,
                      syncDirectory,
                      runWriter:transactionId => sidecarBoundary.io.publishWorkingDeck({
                        sessionId:sessionStore.state.sessionId,
                        transactionId,
                        expectedDeckFingerprint:expectedFingerprint,
                        expectedWorkingFingerprint:workingResult.fingerprint,
                      }),
                    });
                    return {
                      ...published,
                      previousWorkingFingerprint:workingResult.previousFingerprint,
                      workingFingerprint:workingResult.fingerprint,
                      effectivePatches:workingResult.effectivePatches,
                      droppedActionIds:workingResult.droppedActionIds,
                    };
                  } catch (error) {
                    if (error?.committed !== true) {
                      try {
                        await workingDeckStore.restore(
                          workingResult.previousFingerprint, workingResult.fingerprint,
                        );
                      } catch (restoreError) {
                        throw detailedHttpError(
                          'RECOVERY_REQUIRED', 503,
                          '固化发布失败且工作副本无法恢复，请重启 Editor 完成对账',
                          { cause:restoreError, originalError:error },
                        );
                      }
                    }
                    throw error;
                  }
                }
                : (patches, expectedFingerprint) => runWriteTransaction({
                  deckPath:currentDeckPath,
                  sessionDir:sessionStore.sessionDir,
                  expectedFingerprint,
                  sidecarBoundary,
                  syncDirectory,
                  runWriter:transactionId => runWritePatches(
                    currentDeckPath,
                    sessionStore.sessionDir,
                    patches,
                    expectedFingerprint,
                    transactionId,
                    sessionStore.state.sessionId,
                    sidecarBoundary.pythonIdentity,
                    {
                      pythonExecutable,
                      spawnWriter,
                      timeoutMs: writerTimeoutMs,
                      killGraceMs: writerKillGraceMs,
                      activeWriters,
                      onActiveWritersChange,
                    },
                  ),
                }),
              restore:workingDeckStore.managed
                ? (solidify
                  ? async (writerResult, expectedFingerprint) => {
                    await restoreDeckBackup(
                      currentDeckPath,
                      sessionStore.sessionDir,
                      { backupPath:resolve(writerResult.backup) },
                      expectedFingerprint,
                      writerResult.fingerprint,
                      sidecarBoundary,
                    );
                    await workingDeckStore.restore(
                      writerResult.previousWorkingFingerprint,
                      writerResult.workingFingerprint,
                    );
                  }
                  : async () => {})
                : (writerResult, expectedFingerprint) => restoreDeckBackup(
                  currentDeckPath,
                  sessionStore.sessionDir,
                  { backupPath:resolve(writerResult.backup) },
                  expectedFingerprint,
                  writerResult.fingerprint,
                  sidecarBoundary,
                ),
              finalize:workingDeckStore.managed && !solidify
                ? async () => {}
                : value => finalizeWriteTransaction(
                  value, sessionStore.sessionDir, sidecarBoundary,
                ),
              solidify,
              scope:workingDeckStore.managed && !solidify ? 'working' : 'deck',
              preflightToken,
              bindingRevision:solidify ? expectedBindingRevision ?? null : null,
            },
          );
        } catch (error) {
          if (error?.conflictCreated === true) {
            broadcast('deck-conflict', sessionStore.state.revision, sessionStore.state.conflict);
          }
          throw error;
        }
        if (solidify) {
          const acceptedBinding = await bindingCoordinator.acceptPublishedFile({
            expectedPath:currentDeckPath,
            expectedFingerprint:`sha256:${result.fingerprint}`,
          });
          await bindingPersistenceQueue;
          broadcast('deck-solidified', result.revision, {
            solidified:true,
            clearedGroupCount:result.clearedGroupCount,
            clearedRedoCount:result.clearedRedoCount,
            fingerprint:result.fingerprint,
            bindingRevision:acceptedBinding.revision,
          });
        }
        json(response, 200, { revision: sessionStore.state.revision, ...result });
        return;
      }
      if (request.method === 'GET' && pathname === '/preview') {
        const contents = (await workingDeckStore.read()).toString('utf8');
        const preview = injectPreviewBridge(contents);
        send(response, 200, preview, 'text/html; charset=utf-8');
        return;
      }
      if (request.method === 'GET' && (pathname === '/editor' || pathname === '/editor/')) {
        sendEditorIndex(
          request, response, url, token, editorToken, serviceOrigin, pinnedEditorIndex,
        );
        return;
      }
      if (request.method === 'GET' && pinnedEditorAssets.has(pathname)) {
        const asset = pinnedEditorAssets.get(pathname);
        send(response, 200, asset.contents, asset.type);
        return;
      }
      if (request.method === 'GET' && (pathname === '/editor' || pathname.startsWith('/editor/'))) {
        throw httpError('EDITOR_ASSET_NOT_FOUND', 404, `编辑器资源不存在：${pathname}`);
      }
      if (request.method === 'GET' && ['/events', '/agent-terminal'].includes(pathname)) {
        response.setHeader('upgrade', 'websocket');
        throw httpError('WEBSOCKET_UPGRADE_REQUIRED', 426, '请使用 WebSocket 连接');
      }
      throw httpError('NOT_FOUND', 404, '资源不存在');
    } catch (error) {
      if(error?.failedActionId) {
        const failed=bridge.compiledWriteActions().find(action=>action.id===error.failedActionId);
        if(failed)error.targetSummary={pageKey:failed.target.pageKey,kind:failed.kind,editorId:failed.target.editorId??null};
      }
      errorResponse(response, error);
    } finally {
      if(ownsSolidification)solidifying=false;
    }
  });

  server.on('upgrade', (request, socket, head) => {
    const connectionId = randomUUID();
    let url;
    const rejectConnection = status => connectionRecord('handshake-rejected', {connectionId,status});
    try {
      url = new URL(request.url ?? '/', `http://${urlHost}`);
    } catch {
      rejectConnection(400);
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!['/events', '/agent-terminal'].includes(url.pathname)
      || url.searchParams.get('token') !== token) {
      rejectConnection(403);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    if (request.headers.origin !== undefined) {
      let suppliedOrigin;
      try { suppliedOrigin = new URL(request.headers.origin).origin; }
      catch { suppliedOrigin = null; }
      if (suppliedOrigin !== serviceOrigin) {
        rejectConnection(403);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
    }
    const suppliedEditorToken = url.searchParams.get('editorToken');
    const isEditor = suppliedEditorToken === editorToken;
    if (suppliedEditorToken !== null && !isEditor) {
      rejectConnection(403);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    if (url.pathname === '/agent-terminal') {
      if (!isEditor) {
        rejectConnection(403);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      terminalSockets.handleUpgrade(request, socket, head, client => {
        terminalSockets.emit('connection', client, request);
      });
      return;
    }
    if (isEditor && bridge.hasEditorSocket()) {
      rejectConnection(409);
      socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
      return;
    }
    webSockets.handleUpgrade(request, socket, head, client => {
      client.connectionId = connectionId;
      client.isEditor = isEditor;
      webSockets.emit('connection', client, request);
    });
  });

  webSockets.on('connection', socket => {
    if (socket.isEditor) {
      connectionRecord('editor-connected', {connectionId:socket.connectionId});
      editorConnectedOnce = true;
      clearTimeout(editorCloseTimer);
      editorCloseTimer = undefined;
      bridge.setEditorSocket(socket);
    }
    socket.on('message', data => bridge.handleMessage(socket, data));
    socket.on('error', () => { if (socket.isEditor) connectionRecord('editor-socket-error', {connectionId:socket.connectionId}); });
    socket.on('close', code => {
      if (!socket.isEditor) return;
      connectionRecord('editor-disconnected', {connectionId:socket.connectionId,code});
      bridge.clearEditorSocket(socket);
      if (!exitWhenEditorCloses || !editorConnectedOnce || watcherClosed) return;
      clearTimeout(editorCloseTimer);
      editorCloseTimer = setTimeout(() => {
        editorCloseTimer = undefined;
        void close().catch(() => {});
      }, editorCloseGraceMs);
      editorCloseTimer.unref?.();
    });
  });

  terminalSockets.on('connection', socket => {
    if (!agentTerminal) {
      socket.close(1011, '当前运行模式不提供独立 Agent 终端');
      return;
    }
    const detach = agentTerminal.attach(socket);
    let commandChain = Promise.resolve();
    socket.on('message', data => {
      commandChain = commandChain.then(async () => {
        let message;
        try { message = JSON.parse(String(data)); }
        catch { throw httpError('INVALID_TERMINAL_MESSAGE', 400, '终端消息不是有效 JSON'); }
        if (message.type === 'start') {
          await agentTerminal.start({
            provider:message.provider,
            cols:message.cols,
            rows:message.rows,
          });
        } else if (message.type === 'restart') {
          await agentTerminal.restart({
            provider:message.provider,
            cols:message.cols,
            rows:message.rows,
            newConversation:message.newConversation === true,
          });
        } else if (message.type === 'input') {
          agentTerminal.input(message.data);
        } else if (message.type === 'resize') {
          agentTerminal.resize(message.cols, message.rows);
        } else {
          throw httpError('INVALID_TERMINAL_MESSAGE', 400, '未知终端命令');
        }
      }).catch(error => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type:'error',
            code:error?.code ?? 'AGENT_TERMINAL_FAILED',
            message:error?.message ?? 'Agent 终端操作失败',
          }));
        }
      });
    });
    socket.on('close', detach);
  });

  try {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolvePromise();
      });
    });
  } catch (error) {
    bridge.close();
    await agentRuns.close().catch(() => {});
    await agentTerminal?.close().catch(() => {});
    await attachmentStore.close().catch(() => {});
    await agentWorkspaceStore.close().catch(() => {});
    await bindingPersistenceQueue.catch(() => {});
    await bindingCoordinator?.close?.().catch(() => {});
    await sidecarBoundary.io.close();
    throw error;
  }
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${urlHost}:${actualPort}`;
  serviceOrigin = url;
  let deckWatcherStarted = false;
  let watchedDeckPath = null;
  let workingWatcherStarted = false;
  let wsUrl;
  let editorWsUrl;
  let terminalWsUrl;
  const cleanupFailedPostListen = async () => {
    watcherClosed = true;
    watcherGeneration += 1;
    if (deckWatcherStarted && watchedDeckPath) unwatchFile(watchedDeckPath, watchListener);
    if (workingWatcherStarted) unwatchFile(workingDeckStore.path, workingWatchListener);
    deckWatcherStarted = false;
    workingWatcherStarted = false;
    bridge.close();
    detachTerminalState?.();
    detachTerminalProvider?.();
    detachTerminalInterrupt?.();
    detachTerminalState = null;
    detachTerminalProvider = null;
    detachTerminalInterrupt = null;
    for (const client of webSockets.clients) client.terminate();
    for (const client of terminalSockets.clients) client.terminate();
    const httpClosed = new Promise(resolvePromise => {
      try { server.close(() => resolvePromise()); }
      catch { resolvePromise(); }
    });
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await Promise.allSettled([
      httpClosed,
      agentRuns?.close?.(),
      closeAgentTerminalOnShutdown ? agentTerminal?.close?.() : Promise.resolve(),
      attachmentStore.close(),
      agentWorkspaceStore.close(),
      bindingPersistenceQueue,
      bindingCoordinator?.close?.(),
    ]);
    await sidecarBoundary.io.close().catch(() => {});
  };
  try {
    const storedTerminalProvider = agentWorkspaceStore.snapshot().activeProvider;
    const persistTerminalConversation = async (provider, conversationId) => {
      const current = agentWorkspaceStore.snapshot();
      const providerState = current.providers[provider];
      const known = providerState?.conversations.some(item => item.id === conversationId);
      if (known && providerState.activeConversationId === conversationId
        && current.activeProvider === provider) return;
      const timestamp = new Date().toISOString();
      await agentWorkspaceStore.update(draft => {
        const nextProvider = draft.providers[provider];
        if (!nextProvider.conversations.some(item => item.id === conversationId)) {
          nextProvider.conversations.push({
            id:conversationId,
            ownership:'editor-created',
            title:'AICO-PPT 专用会话',
            projectRoot:draft.projectRoot,
            createdAt:timestamp,
            updatedAt:timestamp,
            skill:{ status:'uninitialized' },
          });
        }
        nextProvider.activeConversationId = conversationId;
        draft.activeProvider = provider;
      }, current.workspaceRevision);
    };
    const resolveTerminalConversation = async (
      provider, {
        newConversation = false,
        initialPrompt = '',
        environment = process.env,
      } = {},
    ) => {
      const current = agentWorkspaceStore.snapshot();
      const providerState = current.providers[provider];
      const active = providerState?.conversations.find(
        item => item.id === providerState.activeConversationId,
      );
      if (!newConversation && active) {
        try {
          return await resumeAgentTerminalConversation(provider, {
            projectRoot:current.projectRoot,
            conversationId:active.id,
          });
        } catch { /* 旧 ID 不存在时创建新的、真正可恢复的会话 */ }
      }
      const created = await createAgentTerminalConversation(provider, {
        projectRoot:current.projectRoot,
        initialPrompt,
        environment,
      });
      if (created.resume) await persistTerminalConversation(provider, created.conversationId);
      return created;
    };
    const handleTerminalConversationStarted = async (provider, conversationId) => {
      await persistTerminalConversation(provider, conversationId);
    };
    const terminalOptions = {
      projectRoot:agentWorkspaceStore.snapshot().projectRoot,
      cwd:agentTerminalCwd,
      runtimePathRoots:[PROJECT_DIR],
      provider:storedTerminalProvider,
      environment:withLegacyAicoPptEnvironment({
        ...process.env,
        AICO_PPT_EDITOR_URL:serviceOrigin,
        AICO_PPT_EDITOR_TOKEN:token,
        AICO_PPT_SOURCE_PATH:currentDeckPath,
        AICO_PPT_WORKING_PATH:workingDeckStore.path,
        ...(creationHandoffState ? {
          AICO_PPT_CREATION_CONTEXT:creationHandoffState.path,
          AICO_PPT_CREATION_MATERIALS:
            creationHandoffState.context.artifacts.materialsDirectory,
          ...(creationHandoffState.context.artifacts.planPath ? {
            AICO_PPT_CREATION_PLAN:creationHandoffState.context.artifacts.planPath,
          } : {}),
        } : {}),
      }),
      initialPrompt:provider => buildSessionInitializationPrompt({
        deckPath:workingDeckStore.path,
        sourceDeckPath:currentDeckPath,
        projectPath:agentWorkspaceStore.snapshot().projectRoot,
        skillInvocation:provider === 'codex'
          ? '$aico-ppt'
          : '请先读取并使用 aico-ppt Skill。',
        creationContextPath:creationHandoffState?.path ?? null,
      }),
      resolveConversation:resolveTerminalConversation,
      identifyConversation:discoverAgentTerminalConversation,
      onConversationStarted:handleTerminalConversationStarted,
      onProviderChange:async provider => {
        const current = agentWorkspaceStore.snapshot();
        if (current.activeProvider === provider) return;
        await agentWorkspaceStore.update(draft => { draft.activeProvider = provider; }, current.workspaceRevision);
      },
      onStateChange:terminal => {
        broadcast('agent-terminal-updated', sessionStore.state.revision, terminal);
      },
      ...(spawnAgentTerminal ? { spawnPty:spawnAgentTerminal } : {}),
    };
    if (agentTerminalSession) {
      agentTerminal = agentTerminalSession;
      agentTerminal.updateConversationLifecycle?.({
        resolveConversation:resolveTerminalConversation,
        identifyConversation:discoverAgentTerminalConversation,
        onConversationStarted:handleTerminalConversationStarted,
      });
      agentTerminal.updateEnvironment?.(terminalOptions.environment);
      detachTerminalProvider = agentTerminal.addProviderChangeListener?.(terminalOptions.onProviderChange) ?? null;
      detachTerminalState = agentTerminal.addStateListener?.(terminalOptions.onStateChange) ?? null;
      if (creationHandoffState && creationHandoff) {
        const prompt = buildCreationHandoffPrompt({
          ...creationHandoffState,
          editor:{
            workingDeckPath:workingDeckStore.path,
            sourceDeckPath:currentDeckPath,
            cliPath:join(EDITOR_DIR, 'cli.mjs'),
            serviceUrl:serviceOrigin,
            token,
          },
        });
        if (prompt) {
          const submitHandoffPrompt = async () => {
            try {
              const submissionId = agentTerminal.submitPrompt?.(prompt);
              if (submissionId && typeof agentTerminal.waitUntilPromptSubmission === 'function') {
                await agentTerminal.waitUntilPromptSubmission(submissionId, { timeoutMs:30_000 });
              }
            }
            catch { /* 终端已关闭或正在切换时，交接说明不能阻断 Editor 启动 */ }
          };
          if (typeof agentTerminal.waitUntilReady === 'function') {
            void agentTerminal.waitUntilReady({ timeoutMs:30_000 })
              .then(submitHandoffPrompt)
              .catch(() => {});
          } else {
            submitHandoffPrompt();
          }
        }
      }
    } else if (!dshAgentBridge) {
      agentTerminal = await createAgentTerminal(terminalOptions);
    }
    detachTerminalInterrupt = agentTerminal?.addInterruptListener?.(() => {
      agentRuns.cancel(
        '已在 Agent CLI 中按 Esc 中断本批任务，未完成任务可重新提交',
      );
    }) ?? null;
    if (autoStartAgentTerminal && !agentTerminalSession && agentTerminal) {
      void agentTerminal.start({ provider:terminalOptions.provider }).catch(() => {
        // 启动失败已进入 terminal snapshot，不能阻断 Editor 主服务。
      });
    }
    wsUrl = `ws://${urlHost}:${actualPort}/events`;
    editorWsUrl = `${wsUrl}?token=${encodeURIComponent(token)}&editorToken=${encodeURIComponent(editorToken)}`;
    terminalWsUrl = `ws://${urlHost}:${actualPort}/agent-terminal`
      + `?token=${encodeURIComponent(token)}&editorToken=${encodeURIComponent(editorToken)}`;
    restartDeckWatcher = () => {
      if (watcherClosed) return;
      if (deckWatcherStarted && watchedDeckPath) unwatchFile(watchedDeckPath, watchListener);
      watchedDeckPath = currentDeckPath;
      watchFile(watchedDeckPath, { interval:500 }, watchListener);
      deckWatcherStarted = true;
      agentTerminal?.updateEnvironment?.(withLegacyAicoPptEnvironment({
        ...terminalOptions.environment,
        AICO_PPT_SOURCE_PATH:currentDeckPath,
      }));
    };
    restartDeckWatcher();
    if (workingDeckStore.managed) {
      watchFile(workingDeckStore.path, { interval:250 }, workingWatchListener);
      workingWatcherStarted = true;
    }
  } catch (error) {
    await cleanupFailedPostListen();
    throw error;
  }

  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      connectionRecord('service-stopping');
      await connectionLog.flush();
      const finalWorkingCheckpoint = workingDeckStore.managed
        ? await Promise.allSettled([queueWorkingDeckCheckpoint()])
        : [];
      watcherClosed = true;
      watcherGeneration += 1;
      clearTimeout(editorCloseTimer);
      editorCloseTimer = undefined;
      if (watchedDeckPath) unwatchFile(watchedDeckPath, watchListener);
      if (workingDeckStore.managed) {
        unwatchFile(workingDeckStore.path, workingWatchListener);
      }
      bridge.close();
      for(const {abort} of localEdits.values())abort.abort(new Error('编辑器已关闭'));
      await editorView.close();
      detachTerminalState?.();
      detachTerminalProvider?.();
      detachTerminalInterrupt?.();
      detachTerminalState = null;
      detachTerminalProvider = null;
      detachTerminalInterrupt = null;
      const agentClosed = agentRuns.close();
      dshRunAdapter?.close();
      const terminalClosed = closeAgentTerminalOnShutdown
        ? agentTerminal?.close() ?? Promise.resolve()
        : Promise.resolve();
      const attachmentClosed = attachmentStore.close();
      const workspaceClosed = agentWorkspaceStore.close();
      const writerClosed = [];
      for (const writer of activeWriters.values()) {
        writerClosed.push(writer.closed);
        writer.cancel(httpError('SERVICE_CLOSED', 503, '服务已关闭'));
      }
      const exportClosed = [pptxExportJob.close()];
      for (const job of activePptxExports) {
        exportClosed.push(job.promise);
        job.controller.abort();
      }
      for (const client of webSockets.clients) client.terminate();
      for (const client of terminalSockets.clients) client.terminate();
      const webSocketClosed = new Promise(resolvePromise => webSockets.close(() => resolvePromise()));
      const terminalSocketClosed = new Promise(resolvePromise => (
        terminalSockets.close(() => resolvePromise())
      ));
      const httpClosed = new Promise(resolvePromise => server.close(() => resolvePromise()));
      await new Promise(resolvePromise => setImmediate(resolvePromise));
      server.closeIdleConnections?.();
      // 不完整请求仍占据活动连接；必须在等待 close 回调前断开，避免关闭永久等待。
      server.closeAllConnections?.();
      const writersSettled = Promise.allSettled(writerClosed);
      const exportsSettled = Promise.allSettled(exportClosed);
      const shutdown = await Promise.allSettled([
        watcherQueue,
        workingWatcherQueue,
        webSocketClosed,
        terminalSocketClosed,
        httpClosed,
        writersSettled,
        exportsSettled,
        agentClosed,
        terminalClosed,
        attachmentClosed,
        workspaceClosed,
        bindingPersistenceQueue,
        bindingCoordinator.close(),
      ]);
      if ([...finalWorkingCheckpoint, ...shutdown, ...await writersSettled, ...await exportsSettled]
        .every(result => result.status === 'fulfilled')) {
        await collectUnusedWorkingVersions();
      }
      await connectionLog.flush();
      const helperResult = await Promise.allSettled([sidecarBoundary.io.close()]);
      const failures = [...finalWorkingCheckpoint, ...shutdown, ...helperResult]
        .filter(result => result.status === 'rejected')
        .map(result => result.reason)
        // 无效的外部候选没有进入 session 历史；下次启动会按已持久化指纹
        // 从 working/versions 恢复，因此不能让一次写入中断拖垮正常关闭。
        .filter(error => error?.code !== 'INVALID_WORKING_DECK');
      if (failures.length) throw new AggregateError(
        failures,
        `编辑服务关闭时清理失败：${failures.map(error => (
          `${error?.code ?? error?.name ?? 'ERROR'}: ${error?.message ?? String(error)}`
        )).join('；')}`,
      );
    })().finally(() => {
      try {
        const pending = onClose();
        pending?.catch?.(() => {});
      } catch { /* 生命周期通知失败不能让已经关闭的 Editor 复活 */ }
    });
    return closePromise;
  };

  return {
    url,
    wsUrl,
    token,
    editorToken,
    editorWsUrl,
    terminalWsUrl,
    port: actualPort,
    // 仅暴露本实例仍存活时的传输地址；适配插件不得根据浏览器输入任意连接端口。
    get transportEndpoint() { return closePromise ? null : { origin:url, token, editorToken }; },
    get deckPath() { return currentDeckPath; },
    deckId:effectiveDeckId,
    binding:bindingCoordinator,
    workingDeckPath:workingDeckStore.path,
    sessionDir: sessionStore.sessionDir,
    session: sessionStore.state,
    creationHandoff:creationHandoffState,
    get viewContext() {
      if (!viewContext || Date.now()-viewContext.observedAt > 15000) return null;
      const {observedAt,...value} = viewContext;
      return {...value,selection:value.revision === sessionStore.state.revision ? value.selection : null};
    },
    agentWorkspace:agentWorkspaceStore,
    agentRuns,
    agentTerminal,
    /** 已持久化的未固化历史不阻止重启；输入、事务及状态未知才阻止。 */
    async restartStatus() {
      const busy=()=>Boolean(closePromise||solidifying||activeWriters.size||activePptxExports.size
        ||localEdits.size||pendingWorkingCheckpoints||bridge.pendingMutations||bridge.sourceEditSnapshot()
        ||bridge.recoveryRequired||agentRuns.snapshot().activeBatch
        ||['active','submitting'].includes(agentTerminal?.snapshot()?.turnState));
      if(busy())return {safe:false,reasons:['PPT 正在执行、保存、导出或恢复修改，请等待完成。']};
      const revision=sessionStore.state.revision;
      try {
        const frame=await bridge.inspectRestartStatus();
        if(frame.busy||busy()||revision!==sessionStore.state.revision)return {safe:false,reasons:['PPT 有尚未提交的输入或正在处理修改，请完成或取消后再重启。']};
        return {safe:true,reasons:[]};
      }catch{return {safe:false,reasons:['无法确认 PPT 画布状态，请返回工作页检查并保存后再重启。']};}
    },
    hasEditorConnection:() => bridge.hasEditorSocket(),
    waitUntilReady:options => bridge.waitUntilReady(options),
    flushWorkingDeckChanges:() => (
      workingDeckStore.managed ? queueWorkingDeckCheckpoint() : Promise.resolve()
    ),
    close,
  };
}

function serverHelp() {
  return [
    '用法: node scripts/editor/server.mjs <deck> [选项]',
    '',
    '选项:',
    '  --host HOST   监听地址（默认 127.0.0.1）',
    '  --port PORT   监听端口（默认 0，自动分配）',
    '  --no-open     不自动打开浏览器',
    '  --headless-workspace  后台挂载受控页面，不打开 Editor 窗口或 Agent 终端',
    '  --exit-when-editor-closes  编辑器页面关闭后自动退出（桌面应用使用）',
    '  --no-agent-autostart  不自动启动右侧 Agent 终端',
    '  --agent-thread-id ID  绑定来源 Codex 任务（Skill 自动传入）',
    '  --agent-provider ID   新建会话的默认 Agent provider（默认 codex）',
    '  --python PATH  sidecar helper 使用的 Python 解释器',
    '  --help        显示帮助',
  ].join('\n');
}

function parseServerArguments(argv) {
  let deckPath;
  let host = '127.0.0.1';
  let port = 0;
  let openBrowser = true;
  let exitWhenEditorCloses = false;
  let autoStartAgentTerminal = true;
  let headlessWorkspace = false;
  let agentThreadId = null;
  let agentProvider = 'codex';
  let pythonExecutable = DEFAULT_PYTHON_EXECUTABLE;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--no-open') {
      openBrowser = false;
      continue;
    }
    if (argument === '--headless-workspace') {
      headlessWorkspace = true;
      openBrowser = false;
      autoStartAgentTerminal = false;
      exitWhenEditorCloses = false;
      continue;
    }
    if (argument === '--exit-when-editor-closes') {
      exitWhenEditorCloses = true;
      continue;
    }
    if (argument === '--no-agent-autostart') {
      autoStartAgentTerminal = false;
      continue;
    }
    if (argument === '--host' || argument === '--port'
      || argument === '--agent-thread-id' || argument === '--agent-provider'
      || argument === '--python') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new TypeError(`${argument} 缺少值`);
      if (argument === '--host') host = value;
      else if (argument === '--agent-thread-id') agentThreadId = value;
      else if (argument === '--agent-provider') agentProvider = value;
      else if (argument === '--python') pythonExecutable = value;
      else {
        port = Number(value);
        if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
          throw new TypeError('--port 必须是 0 到 65535 的整数');
        }
      }
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) throw new TypeError(`未知参数: ${argument}`);
    if (deckPath) throw new TypeError(`多余参数: ${argument}`);
    deckPath = argument;
  }
  if (!deckPath) throw new TypeError('缺少 deck 文件');
  if (!isAgentProviderId(agentProvider)) {
    throw new TypeError(`--agent-provider 不受支持：${agentProvider}`);
  }
  return {
    help:false, deckPath, host, port, openBrowser, exitWhenEditorCloses,
    agentThreadId, agentProvider, autoStartAgentTerminal, pythonExecutable,
    headlessWorkspace,
  };
}

export function buildOpenCommand(platform, editorUrl) {
  if (platform === 'darwin') return { command: 'open', args: [editorUrl] };
  if (platform === 'win32') {
    return {
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', editorUrl],
    };
  }
  return { command: 'xdg-open', args: [editorUrl] };
}

function openEditor(editorUrl) {
  const { command, args } = buildOpenCommand(process.platform, editorUrl);
  const opener = spawn(command, args, {
    detached:true, stdio:'ignore', windowsHide:true,
  });
  opener.once('error', () => {});
  opener.unref();
}

export async function runServerCli(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseServerArguments(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${serverHelp()}\n`);
    return 0;
  }

  let app;
  try {
    app = await startServer({
      deckPath: options.deckPath,
      host: options.host,
      port: options.port,
      openBrowser: false,
      exitWhenEditorCloses: options.exitWhenEditorCloses,
      agentThreadId: options.agentThreadId,
      agentProvider: options.agentProvider,
      autoStartAgentTerminal: options.autoStartAgentTerminal,
      pythonExecutable: options.pythonExecutable,
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const editorUrl = `${app.url}/editor/?token=${encodeURIComponent(app.token)}`
    + `&editorToken=${encodeURIComponent(app.editorToken)}`;
  let headlessRuntime = null;
  let capabilityPath = null;
  try {
    if (options.headlessWorkspace) {
      headlessRuntime = await startHeadlessEditorRuntime({ editorUrl });
      await app.waitUntilReady({ timeoutMs:20_000 });
    }
    capabilityPath = await writeWorkspaceCapability(app.sessionDir, {
      url:app.url,
      token:app.token,
      mode:options.headlessWorkspace ? 'headless' : 'visible',
      deckPath:app.deckPath,
      workingDeckPath:app.workingDeckPath,
      sessionDir:app.sessionDir,
      pid:process.pid,
      createdAt:new Date().toISOString(),
    });
  } catch (error) {
    await headlessRuntime?.close().catch(() => {});
    await app.close().catch(() => {});
    process.stderr.write(`Managed Workspace 启动失败: ${error.message}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify({
    mode:options.headlessWorkspace ? 'headless-workspace' : 'visible-editor',
    url:app.url,
    token:app.token,
    editorUrl,
    deckPath:app.deckPath,
    workingDeckPath:app.workingDeckPath,
    sessionDir:app.sessionDir,
    capabilityPath,
  })}\n`);
  // 桌面模式可能由“最后一个浏览器客户端离开”自然关闭服务，而不是收到
  // SIGINT/SIGTERM。exit 回调必须同步清掉短期 token，避免无效 capability
  // 长期留在 sidecar 中；显式 shutdown 仍走下面的异步清理。
  process.once('exit', () => {
    if (!capabilityPath) return;
    try { unlinkSync(capabilityPath); }
    catch (error) { if (error.code !== 'ENOENT') process.stderr.write(`${error.message}\n`); }
  });
  if (options.openBrowser) openEditor(editorUrl);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await removeWorkspaceCapability(capabilityPath).catch(() => {});
    await headlessRuntime?.close().catch(() => {});
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return 0;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  process.exitCode = await runServerCli();
}
