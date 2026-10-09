import { createHash, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { PatchJournal } from './patch-journal.mjs';
import { sourceRebaseActionIds } from './action-compiler.mjs';
import { hasCanonicalValues, validateAction } from './protocol.mjs';
import { RevisionConflict } from './session-store.mjs';

function serviceError(code, statusCode, message = code, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

const isCommittedSession = error => error?.committed === true
  && error?.commitScope === 'session';
const MANUAL_COALESCE_WINDOW_MS = 3_000;
const COMPLETED_COMMAND_LIMIT = 128;

function commandDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeSolidifiedPatchRepair(state, repair) {
  if (repair === null || repair === undefined) return null;
  if (!repair || typeof repair !== 'object' || Array.isArray(repair)
    || !Array.isArray(repair.effectivePatches)
    || !Array.isArray(repair.droppedActionIds)) {
    throw serviceError('INVALID_PATCH_REPAIR', 500, '源码修改的固化补丁修复结果无效');
  }
  const droppedIds = new Set(repair.droppedActionIds);
  if (droppedIds.size === 0 || droppedIds.size !== repair.droppedActionIds.length
    || [...droppedIds].some(id => typeof id !== 'string' || !id)) {
    throw serviceError('INVALID_PATCH_REPAIR', 500, '源码修改的失效补丁标识无效');
  }
  const before = structuredClone(state.solidifiedActions ?? []);
  const droppedActions = [];
  const expectedEffective = [];
  for (const [index, action] of before.entries()) {
    if (droppedIds.has(action?.id)) droppedActions.push({ index, action });
    else expectedEffective.push(action);
  }
  if (droppedActions.length !== droppedIds.size
    || !isDeepStrictEqual(expectedEffective, repair.effectivePatches)) {
    throw serviceError(
      'INVALID_PATCH_REPAIR', 500,
      '源码修改清理的补丁与当前固化基线不一致',
    );
  }
  return {
    effectivePatches:structuredClone(repair.effectivePatches),
    droppedActionIds:[...repair.droppedActionIds],
    transition:{
      beforeDigest:commandDigest(before),
      afterDigest:commandDigest(expectedEffective),
      droppedActions:structuredClone(droppedActions),
    },
  };
}

function applySolidifiedPatchTransition(actions, transition, method) {
  if (!transition) return structuredClone(actions ?? []);
  if (!transition || typeof transition !== 'object' || Array.isArray(transition)
    || typeof transition.beforeDigest !== 'string'
    || typeof transition.afterDigest !== 'string'
    || !Array.isArray(transition.droppedActions)) {
    throw serviceError('INVALID_PATCH_REPAIR', 500, '结构历史的固化补丁转换无效');
  }
  const current = structuredClone(actions ?? []);
  const expectedDigest = method === 'undo'
    ? transition.afterDigest : transition.beforeDigest;
  if (commandDigest(current) !== expectedDigest) {
    throw serviceError(
      'SOLIDIFIED_PATCH_HISTORY_CONFLICT', 409,
      '结构历史对应的固化补丁基线已经改变，无法安全撤销或重做',
    );
  }
  if (method === 'undo') {
    for (const item of [...transition.droppedActions].sort((a, b) => a.index - b.index)) {
      if (!Number.isSafeInteger(item?.index) || item.index < 0 || !item.action
        || typeof item.action.id !== 'string'
        || current.some(action => action?.id === item.action.id)) {
        throw serviceError('INVALID_PATCH_REPAIR', 500, '结构历史缺少可恢复的固化动作');
      }
      current.splice(Math.min(item.index, current.length), 0, structuredClone(item.action));
    }
  } else {
    for (const item of transition.droppedActions) {
      const index = current.findIndex(action => action?.id === item?.action?.id);
      if (index < 0 || !isDeepStrictEqual(current[index], item.action)) {
        throw serviceError('INVALID_PATCH_REPAIR', 500, '结构历史缺少待剔除的固化动作');
      }
      current.splice(index, 1);
    }
  }
  const resultDigest = method === 'undo'
    ? transition.beforeDigest : transition.afterDigest;
  if (commandDigest(current) !== resultDigest) {
    throw serviceError('INVALID_PATCH_REPAIR', 500, '结构历史的固化补丁转换结果不一致');
  }
  return current;
}

function completedCommand(state, commandId, requestDigest) {
  if (commandId === null) return null;
  const completed = state.completedCommands?.[commandId];
  if (!completed) return null;
  if (completed.requestDigest !== requestDigest) {
    throw serviceError('COMMAND_ID_REUSED', 409, '同一个 commandId 不能用于不同的编辑内容', {
      stage:'command-idempotency',
    });
  }
  return completed;
}

function recordCompletedCommand(state, commandId, requestDigest, receipt) {
  if (commandId === null) return;
  state.completedCommands ??= {};
  state.completedCommands[commandId] = {
    requestDigest,
    ...structuredClone(receipt),
    committedAt:new Date().toISOString(),
  };
  const ids = Object.keys(state.completedCommands);
  for (const expired of ids.slice(0, Math.max(0, ids.length - COMPLETED_COMMAND_LIMIT))) {
    delete state.completedCommands[expired];
  }
}

function copyJournalState(state) {
  return {
    version:state.version,
    deckFingerprint:state.deckFingerprint,
    workingDeckFingerprint:state.workingDeckFingerprint,
    solidifiedActions:structuredClone(state.solidifiedActions ?? []),
    timeline:state.timeline ? structuredClone(state.timeline) : undefined,
    groups: structuredClone(state.groups ?? []),
    redo: structuredClone(state.redo ?? []),
  };
}

function sourceGroupById(state, groupId) {
  const group = state.groups?.find(candidate => candidate?.id === groupId);
  return group?.mutationType === 'source' ? group : null;
}

function taskById(state, taskId) {
  return state.tasks?.find(task => task.id === taskId);
}

function impactSummary(group) {
  if (!group) return null;
  if (group.mutationType === 'source') {
    return {
      kind:'source',
      summary:typeof group.source?.summary === 'string'
        ? group.source.summary : '结构修改',
      pageEffects:[],
    };
  }
  const byPage = new Map();
  const labels = {
    setText:'text-changed', setStyle:'style-changed', translate:'element-moved',
    resize:'element-resized', hide:'element-hidden', show:'element-shown',
  };
  for (const action of group.actions ?? []) {
    const pageKey = action?.target?.pageKey;
    if (typeof pageKey !== 'string' || !pageKey) continue;
    const effects = byPage.get(pageKey) ?? new Set();
    effects.add(labels[action.kind] ?? 'element-changed');
    byPage.set(pageKey, effects);
  }
  return {
    kind:'actions',
    pageEffects:[...byPage].map(([pageKey, effects]) => ({
      pageKey, effects:[...effects],
    })),
  };
}

function primaryTaskGroup(state, groupOrId) {
  let group = typeof groupOrId === 'string'
    ? state.groups?.find(candidate => candidate?.id === groupOrId) ?? null
    : groupOrId;
  const visited = new Set();
  while (group?.compensation?.entryId && !visited.has(group.id)) {
    visited.add(group.id);
    group = state.groups?.find(
      candidate => candidate?.id === group.compensation.entryId,
    ) ?? group;
    if (visited.has(group.id)) break;
  }
  return group;
}

function completeTask(state, taskId, groupOrId) {
  if (taskId === null) return undefined;
  const task = taskById(state, taskId);
  if (!task) return undefined;
  const changedGroup = typeof groupOrId === 'string'
    ? state.groups?.find(candidate => candidate?.id === groupOrId) ?? null
    : groupOrId;
  const group = primaryTaskGroup(state, changedGroup);
  const groupId = group?.id ?? task.groupId;
  task.status = 'completed';
  delete task.lastError;
  if (groupId) task.groupId = groupId;
  task.entryIds = [...new Set([
    ...(task.entryIds ?? []), groupId, changedGroup?.id,
  ].filter(Boolean))];
  task.effectState = 'active';
  const summary = impactSummary(group);
  if (summary) task.impactSummary = summary;
  task.candidates = [];
  task.updatedAt = new Date().toISOString();
  return task;
}

function markTaskEffectUndone(state, taskId, groupOrId) {
  if (taskId === null) return undefined;
  const task = taskById(state, taskId);
  if (!task) return undefined;
  const changedGroup = typeof groupOrId === 'string'
    ? state.groups?.find(candidate => candidate?.id === groupOrId) ?? null
    : groupOrId;
  const originalGroup = primaryTaskGroup(state, changedGroup);
  const originalGroupId = originalGroup?.id ?? task.groupId;
  task.status = 'completed';
  if (originalGroupId) task.groupId = originalGroupId;
  task.entryIds = [...new Set([
    ...(task.entryIds ?? []), originalGroupId, changedGroup?.id,
  ].filter(Boolean))];
  task.effectState = 'undone';
  task.candidates = [];
  task.updatedAt = new Date().toISOString();
  return task;
}

function runtimeWriteActions(actions) {
  return actions.map(action => ({
    id:action.id,
    taskId:action.taskId ?? null,
    target:structuredClone(action.target),
    kind:action.kind,
    payload:structuredClone(action.payload),
    before:structuredClone(action.before),
    after:structuredClone(action.after),
    ...(typeof action.sourceResizeStyle === 'string' ? {sourceResizeStyle:action.sourceResizeStyle} : {}),
    ...(action.appliedAt === undefined ? {} : { appliedAt:action.appliedAt }),
  }));
}

function diagnosticFailure(code, message, details = {}) {
  return serviceError(code, 409, message, {
    stage:'diagnostics',
    recovery:'打开或重连编辑器，等待页面诊断完成后重试',
    ...details,
  });
}

function locatorIdentity(locator) {
  return `${locator.pageKey}\u0000${locator.path}\u0000${locator.tag ?? ''}`;
}

function normalizeDiagnosticPage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.pageKey !== 'string' || !value.pageKey) {
    throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '页面诊断缺少稳定 pageKey');
  }
  const finiteNonNegative = number => Number.isFinite(number) && number >= 0;
  if (!finiteNonNegative(value.sectionOverflow?.x)
    || !finiteNonNegative(value.sectionOverflow?.y)
    || !Array.isArray(value.nestedClips)) {
    throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '页面诊断包含无效几何值');
  }
  const seen = new Set();
  const nestedClips = value.nestedClips.map(clip => {
    const locator = clip?.locator;
    if (!locator || locator.pageKey !== value.pageKey
      || typeof locator.path !== 'string' || !locator.path
      || !finiteNonNegative(clip.x) || !finiteNonNegative(clip.y)) {
      throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '内层裁切诊断缺少稳定定位器');
    }
    const identity = locatorIdentity(locator);
    if (seen.has(identity)) {
      throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '内层裁切诊断定位器重复');
    }
    seen.add(identity);
    return { locator:structuredClone(locator), x:clip.x, y:clip.y };
  });
  return {
    pageKey:value.pageKey,
    sectionOverflow:{ x:value.sectionOverflow.x, y:value.sectionOverflow.y },
    nestedClips,
  };
}

function diagnosticMap(pages, expectedPageKeys) {
  if (!Array.isArray(pages)) {
    throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '编辑器未返回页面诊断');
  }
  const normalized = pages.map(normalizeDiagnosticPage);
  const byPage = Object.fromEntries(normalized.map(page => [page.pageKey, page]));
  if (Object.keys(byPage).length !== normalized.length
    || expectedPageKeys.some(pageKey => !byPage[pageKey])
    || Object.keys(byPage).some(pageKey => !expectedPageKeys.includes(pageKey))) {
    throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '页面诊断与请求范围不一致');
  }
  return byPage;
}

export function compareDiagnostics(baselineByPage, currentByPage, pageKeys) {
  const blockers = [];
  for (const pageKey of pageKeys) {
    const baseline = baselineByPage?.[pageKey];
    const current = currentByPage?.[pageKey];
    if (!baseline || !current) {
      throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', `缺少 ${pageKey} 的权威诊断`);
    }
    const sectionDelta = {
      x:Math.max(0, current.sectionOverflow.x - baseline.sectionOverflow.x),
      y:Math.max(0, current.sectionOverflow.y - baseline.sectionOverflow.y),
    };
    if (sectionDelta.x > 0 || sectionDelta.y > 0) {
      blockers.push({ pageKey, kind:'section', ...sectionDelta });
    }
    const baselineClips = new Map(
      baseline.nestedClips.map(clip => [locatorIdentity(clip.locator), clip]),
    );
    for (const clip of current.nestedClips) {
      const previous = baselineClips.get(locatorIdentity(clip.locator));
      if (!previous) {
        blockers.push({
          pageKey, kind:'nested-new', locator:clip.locator, x:clip.x, y:clip.y,
        });
        continue;
      }
      const delta = { x:clip.x - previous.x, y:clip.y - previous.y };
      if (delta.x > 2 || delta.y > 2) {
        blockers.push({
          pageKey, kind:'nested-delta', locator:clip.locator,
          x:Math.max(0, delta.x), y:Math.max(0, delta.y),
        });
      }
    }
  }
  return blockers;
}

export class BridgeService {
  constructor({
    sessionStore,
    timeoutMs = 10_000,
    beforeSessionPersist = async () => {},
    getPageIds = () => null,
    reconcileSession = state => state,
  }) {
    if (typeof getPageIds !== 'function') throw new TypeError('getPageIds 必须是函数');
    if (typeof reconcileSession !== 'function') {
      throw new TypeError('reconcileSession 必须是函数');
    }
    this.sessionStore = sessionStore;
    this.timeoutMs = timeoutMs;
    this.beforeSessionPersist = beforeSessionPersist;
    this.getPageIds = getPageIds;
    this.reconcileSession = reconcileSession;
    this.editorSocket = null;
    this.pending = new Map();
    this.socketWaiters = new Set();
    this.journal = new PatchJournal(sessionStore.state);
    this.closed = false;
    this.mutationQueue = Promise.resolve();
    this.pendingMutations = 0;
    this.editorReady = false;
    this.editorPageKeys = [];
    this.readyPromise = null;
    this.recoveryRequired = null;
    this.manualCoalesce = null;
    this.solidifyPreflights = new Map();
  }

  #recoveryError() {
    return serviceError('RECOVERY_REQUIRED', 503, '存在未完成的 durable transaction，当前服务已冻结为只读', {
      stage:'recovery-required',
      recovery:'停止继续修改并重启编辑服务，让 transaction 按磁盘与 session 状态收敛',
      ...(this.recoveryRequired ?? {}),
    });
  }

  #closedError() {
    return serviceError('SERVICE_CLOSED', 503, '服务已关闭');
  }

  #throwIfClosed() {
    if (this.closed) throw this.#closedError();
  }

  #assertMutable() {
    this.#throwIfClosed();
    if (this.recoveryRequired) throw this.#recoveryError();
  }

  #enterRecoveryRequired(details = {}) {
    if (!this.recoveryRequired) this.recoveryRequired = details;
    return this.#recoveryError();
  }

  #publishSessionCandidate(candidate) {
    const published = this.sessionStore.state;
    const next = structuredClone(candidate);
    for (const key of Object.keys(published)) {
      if (!(key in next)) delete published[key];
    }
    Object.assign(published, next);
    this.journal = new PatchJournal(published);
  }

  async #persistCandidate(candidate, recoveryDetails = {}) {
    let persisted;
    try {
      persisted = await this.sessionStore.persistState(candidate);
    } catch (error) {
      this.#throwIfClosed();
      if (isCommittedSession(error)) {
        this.#publishSessionCandidate({...candidate,
          ...(this.sessionStore.state.editScope ? {editScope:this.sessionStore.state.editScope} : {}),
        });
        throw this.#enterRecoveryRequired({
          ...recoveryDetails,
          committed:true,
          commitScope:'session',
          cause:error,
        });
      }
      throw error;
    }
    this.#throwIfClosed();
    this.#publishSessionCandidate(persisted ?? candidate);
    return this.sessionStore.state;
  }

  assertRevision(expectedRevision) {
    if (expectedRevision !== this.sessionStore.state.revision) {
      throw new RevisionConflict(
        `版本号 ${expectedRevision} 与当前版本 ${this.sessionStore.state.revision} 不一致`,
      );
    }
  }

  assertEditRevision(expectedRevision, taskId = null) {
    const state = this.sessionStore.state;
    if (taskId !== null && !taskById(state, taskId)) {
      throw serviceError('TASK_NOT_FOUND', 404, '目标任务已删除；未修改 Deck，请核对任务后重新读取目标');
    }
    const contentRevision = state.editScope?.contentRevision ?? state.revision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < contentRevision
      || expectedRevision > state.revision) {
      throw new RevisionConflict(`Deck 编辑状态已变化（读取版本 ${expectedRevision}，内容边界 ${contentRevision}，当前版本 ${state.revision}），未提交修改，请重新 inspect`);
    }
    if (taskId !== null && expectedRevision < (state.editScope?.taskRevisions?.[taskId] ?? state.revision)) {
      throw serviceError('TASK_CHANGED', 409, '目标任务已修改；未提交修改，请重新 inspect 该任务');
    }
    return state.revision;
  }

  #assertSourceEditInactive() {
    const active = this.sessionStore.state.sourceEdit;
    if (!active) return;
    throw serviceError('SOURCE_EDIT_ACTIVE', 409, '源码事务正在修改工作副本，请等待提交或取消', {
      sourceEditId:active.id,
      taskId:active.taskId,
      startedAt:active.startedAt,
    });
  }

  #requireSourceEdit(sourceEditId) {
    const active = this.sessionStore.state.sourceEdit;
    if (!active) throw serviceError('SOURCE_EDIT_NOT_FOUND', 404, '找不到活动源码事务');
    if (active.id !== sourceEditId) {
      throw serviceError('SOURCE_EDIT_MISMATCH', 409, '源码事务标识与当前活动事务不一致', {
        sourceEditId:active.id,
      });
    }
    return active;
  }

  sourceEditSnapshot() {
    return this.sessionStore.state.sourceEdit
      ? structuredClone(this.sessionStore.state.sourceEdit) : null;
  }

  beginSourceEdit({ expectedRevision, taskId = null, beforeFingerprint, commandId=null, requestDigest=null }) {
    return this.#enqueue(async () => {
      this.#assertMutable();
      this.assertEditRevision(expectedRevision, taskId);
      this.#assertSourceEditInactive();
      if (typeof beforeFingerprint !== 'string'
        || beforeFingerprint !== this.sessionStore.state.workingDeckFingerprint) {
        throw serviceError('WORKING_DECK_CHANGED', 409, '源码事务起始工作副本版本不一致');
      }
      const linkedTask = taskId === null ? null : taskById(this.sessionStore.state, taskId);
      if (taskId !== null && !linkedTask) {
        throw serviceError('TASK_NOT_FOUND', 404, '找不到结构任务');
      }
      if (linkedTask?.groupId || linkedTask?.status === 'completed') {
        throw serviceError('TASK_ALREADY_COMPLETED', 409, '结构任务已经完成，不能重复交给 Agent 处理');
      }
      const sourceEdit = {
        id:randomUUID(), taskId, beforeFingerprint,
        ...(commandId ? {commandId,requestDigest} : {}),
        startedAt:new Date().toISOString(),
      };
      const candidate = structuredClone(this.sessionStore.state);
      candidate.sourceEdit = sourceEdit;
      candidate.revision += 1;
      await this.#persistCandidate(candidate, { operation:'source-edit-begin' });
      this.manualCoalesce = null;
      return {
        sourceEditId:sourceEdit.id,
        taskId,
        beforeFingerprint,
        revision:this.sessionStore.state.revision,
      };
    });
  }

  setEditorSocket(socket) {
    this.editorSocket = socket;
    this.editorReady = false;
    this.editorPageKeys = [];
    this.readyPromise = null;
    for (const waiter of this.socketWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(socket);
    }
    this.socketWaiters.clear();
  }
  hasEditorSocket() { return this.editorSocket?.readyState === 1; }

  async waitUntilReady({ timeoutMs = this.timeoutMs } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError('timeoutMs 必须为正整数');
    }
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (this.hasEditorSocket() && this.editorReady) {
        await this.readyPromise;
        this.#throwIfClosed();
        return { pageKeys:[...this.editorPageKeys] };
      }
      if (Date.now() >= deadline) {
        throw serviceError('EDITOR_OFFLINE', 409, '等待编辑器页面就绪超时');
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(25, deadline - Date.now())));
    }
    throw this.#closedError();
  }

  clearEditorSocket(socket) {
    if (this.editorSocket === socket) {
      this.editorSocket = null;
      this.editorReady = false;
      this.editorPageKeys = [];
      this.readyPromise = null;
    }
    for (const [commandId, pending] of this.pending) {
      if (pending.socket === socket) {
        const error = pending.expectedType === 'diagnostics-result'
          ? diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '页面诊断期间编辑器连接已断开')
          : serviceError('EDITOR_OFFLINE', 409, '编辑器连接已断开');
        this.#settle(commandId, 'reject', error);
      }
    }
  }

  handleMessage(socket, data) {
    let message;
    try { message = JSON.parse(String(data)); } catch { return false; }
    if (message?.type === 'deck-ready' && socket === this.editorSocket) {
      if (!Array.isArray(message.pages) || !Array.isArray(message.diagnostics)) return false;
      const pageKeys = message.pages.map(page => page?.pageKey);
      if (pageKeys.some(pageKey => typeof pageKey !== 'string' || !pageKey)
        || new Set(pageKeys).size !== pageKeys.length) return false;
      let baseline;
      try { baseline = diagnosticMap(message.diagnostics, pageKeys); }
      catch { return false; }
      this.editorReady = true;
      this.editorPageKeys = pageKeys;
      this.readyPromise = this.#enqueue(async () => {
        if (this.closed || socket !== this.editorSocket || !this.editorReady) return;
        const state = this.sessionStore.state;
        if (!Object.keys(state.diagnosticsBaseline ?? {}).length) {
          const candidate = {
            ...structuredClone(state),
            diagnosticsBaseline:baseline,
            diagnosticsCurrent:structuredClone(baseline),
            diagnosticsRevision:state.revision,
          };
          try {
            await this.#persistCandidate(candidate, { operation:'diagnostics-baseline' });
          } catch (error) {
            this.#throwIfClosed();
            if (error?.code === 'RECOVERY_REQUIRED') throw error;
            throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '启动诊断基线无法持久化');
          }
        }
      });
      this.readyPromise.catch(() => {});
      return true;
    }
    if (typeof message?.commandId !== 'string') return false;
    const pending = this.pending.get(message.commandId);
    if (!pending || pending.socket !== socket) return false;
    if (message.type === 'diagnostics-rejected'
      && pending.expectedType === 'diagnostics-result') {
      this.#settle(message.commandId, 'reject', diagnosticFailure(
        'DIAGNOSTICS_UNAVAILABLE', '编辑器无法完成页面诊断', { diagnosticCode:message.code },
      ));
      return true;
    }
    if (message.type === 'text-locations-rejected'
      && pending.expectedType === 'text-locations') {
      this.#settle(message.commandId, 'reject', serviceError(
        message.code ?? 'TEXT_LOCATION_FAILED', 409,
        message.message ?? '编辑器无法定位文字',
      ));
      return true;
    }
    if (message.type === 'actions-rejected' && pending.expectedType === 'actions-prepared') {
      const allowed = new Set(['PAGE_NOT_FOUND', 'TARGET_NOT_FOUND', 'TARGET_AMBIGUOUS', 'INVALID_ACTION', 'EDITOR_INTERACTION_ACTIVE']);
      const code = allowed.has(message.code) ? message.code : 'ACTION_REJECTED';
      this.#settle(message.commandId, 'reject', serviceError(
        code, 409, '编辑器拒绝动作批次', {
          failedActionId: message.failedActionId,
          candidates: Array.isArray(message.candidates) ? message.candidates.slice(0, 5) : [],
        },
      ));
      return true;
    }
    if (message.type !== pending.expectedType) {
      if (message.type === 'actions-applied') {
        this.#settle(message.commandId, 'reject', serviceError(
          'INVALID_ACTION_ACK', 502, '旧版 count-only ACK 不支持事务提交',
        ));
        return true;
      }
      return false;
    }
    if (message.type === 'actions-prepared') {
      if (!Number.isSafeInteger(message.applied)
        || message.applied !== pending.actions.length
        || !this.#validCanonicalResults(pending.actions, message.results)) {
        this.#settle(message.commandId, 'reject', serviceError(
          'INVALID_ACTION_ACK', 502, '编辑器 prepared canonical 回执无效',
        ));
      } else {
        this.#settle(message.commandId, 'resolve', {
          commandId: message.commandId, applied: message.applied, results: message.results,
        });
      }
      return true;
    }
    if (message.type === 'diagnostics-result') {
      try {
        if (message.revision !== pending.revision) {
          throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '诊断 revision 已过期');
        }
        const pages = diagnosticMap(message.pages, pending.pageKeys);
        this.#settle(message.commandId, 'resolve', { revision:message.revision, pages });
      } catch (error) {
        this.#settle(message.commandId, 'reject', error);
      }
      return true;
    }
    if (message.type === 'text-locations') {
      if (!Array.isArray(message.results) || message.results.length > 100
        || message.results.some(item => !item || typeof item.text !== 'string'
          || !Number.isSafeInteger(item.occurrences) || item.occurrences < 1
          || typeof item.pageKey !== 'string' || !item.target
          || item.target.pageKey !== item.pageKey)) {
        this.#settle(message.commandId, 'reject', serviceError(
          'INVALID_TEXT_LOCATION_ACK', 502, '编辑器文字定位回执无效',
        ));
      } else {
        this.#settle(message.commandId, 'resolve', {
          results:structuredClone(message.results),
        });
      }
      return true;
    }
    const booleanFields = {
      'restart-status-result': 'busy',
      'actions-committed': 'committed',
      'actions-rolled-back': 'rolledBack',
    };
    const field = booleanFields[message.type];
    if (field && typeof message[field] !== 'boolean') {
      this.#settle(message.commandId, 'reject', serviceError('INVALID_ACTION_ACK', 502));
    } else {
      this.#settle(message.commandId, 'resolve', message);
    }
    return true;
  }

  captureAgentBatch({ expectedRevision, taskIds, provider, mode }) {
    return this.#enqueue(async () => {
      this.#assertMutable();
      this.#assertSourceEditInactive();
      this.assertRevision(expectedRevision);
      if (!Array.isArray(taskIds) || taskIds.length === 0
        || taskIds.some(id => typeof id !== 'string' || !id)
        || new Set(taskIds).size !== taskIds.length) {
        throw serviceError('INVALID_AGENT_BATCH', 400, '执行批次必须包含不重复的任务 ID');
      }
      if (typeof provider !== 'string' || !provider
        || typeof mode !== 'string' || !mode) {
        throw serviceError('INVALID_AGENT_BATCH', 400, '执行批次缺少 Agent 信息');
      }
      const tasks = new Map(this.sessionStore.state.tasks.map(task => [task.id, task]));
      if (taskIds.some(id => !tasks.has(id))) {
        throw serviceError('TASK_NOT_FOUND', 404, '执行批次包含不存在的任务');
      }
      if (taskIds.some(id => tasks.get(id).targetMissing === true)) {
        throw serviceError(
          'TASK_TARGET_MISSING', 409,
          '执行批次包含原目标当前不可定位的任务，请删除或重新标记后提交',
        );
      }
      if (taskIds.some(id => !['pending', 'failed'].includes(tasks.get(id).status))) {
        throw serviceError('TASK_NOT_PENDING', 409, '执行批次包含无需再次处理的任务');
      }
      const candidate = structuredClone(this.sessionStore.state);
      candidate.agentBatches ??= [];
      const ordinal = Math.max(0, ...candidate.agentBatches.map(batch => batch.ordinal)) + 1;
      const batch = {
        id:randomUUID(), ordinal, provider, mode,
        taskIds:[...taskIds], expectedRevision,
        createdAt:new Date().toISOString(), settlement:null,
      };
      candidate.agentBatches.push(batch);
      candidate.revision += 1;
      await this.#persistCandidate(candidate, { operation:'agent-batch-capture' });
      return { batch:structuredClone(batch), revision:this.sessionStore.state.revision };
    });
  }

  settleAgentBatch({ batchId, outcome, code, message }) {
    return this.#enqueue(async () => {
      this.#assertMutable();
      if (!['succeeded', 'partial', 'failed', 'cancelled'].includes(outcome)) {
        throw serviceError('INVALID_AGENT_BATCH_SETTLEMENT', 400, '执行批次结算状态无效');
      }
      const candidate = structuredClone(this.sessionStore.state);
      const batch = candidate.agentBatches?.find(item => item.id === batchId);
      if (!batch) throw serviceError('AGENT_BATCH_NOT_FOUND', 404, '找不到执行批次');
      if (batch.settlement) {
        if (batch.settlement.outcome !== outcome) {
          throw serviceError('AGENT_BATCH_ALREADY_SETTLED', 409, '执行批次已经按其他结果结算');
        }
        return { batch:structuredClone(batch), revision:this.sessionStore.state.revision };
      }
      batch.settlement = {
        outcome,
        settledAt:new Date().toISOString(),
        ...(typeof code === 'string' && code ? { code:code.slice(0, 160) } : {}),
        ...(typeof message === 'string' && message ? { message:message.slice(0, 500) } : {}),
      };
      candidate.revision += 1;
      await this.#persistCandidate(candidate, { operation:'agent-batch-settlement' });
      return { batch:structuredClone(batch), revision:this.sessionStore.state.revision };
    });
  }

  createTask(input, expectedRevision, options) {
    return this.#enqueue(async () => {
      this.#assertMutable();
      this.#assertSourceEditInactive();
      const state = this.sessionStore.state;
      const snapshot = { revision: state.revision, tasks: structuredClone(state.tasks ?? []) };
      try {
        const result = await this.sessionStore.createTask(input, expectedRevision, options);
        if (this.closed) {
          throw serviceError('SERVICE_CLOSED', 503, 'task session 已提交，但服务关闭前未完成确认', {
            operation:'task',
            committed:true,
            commitScope:'session',
            syncPending:true,
            sessionCandidateCommitted:true,
            revision:result.revision,
          });
        }
        return result;
      }
      catch (error) {
        if (this.closed && isCommittedSession(error)) {
          throw serviceError('SERVICE_CLOSED', 503, 'task session 已提交，但服务关闭前未完成确认', {
            operation:'task',
            committed:true,
            commitScope:'session',
            syncPending:true,
            sessionCandidateCommitted:true,
            revision:this.sessionStore.state.revision,
            cause:error,
          });
        }
        if (error?.sessionCandidateCommitted === true) throw error;
        this.#throwIfClosed();
        if (isCommittedSession(error)) {
          throw this.#enterRecoveryRequired({
            operation:'task', committed:true, commitScope:'session', cause:error,
          });
        }
        state.revision = snapshot.revision;
        state.tasks = snapshot.tasks;
        if (error?.code === 'ATTACHMENT_RECOVERY_REQUIRED'
          || error?.code === 'SNAPSHOT_RECOVERY_REQUIRED'
          || (error?.committed === true
            && ['attachment', 'attachments', 'snapshot'].includes(error?.commitScope))) {
          if (!this.recoveryRequired) {
            this.recoveryRequired = {
              operation:error?.commitScope === 'snapshot'
                ? 'task-snapshot-compensation' : 'task-attachment-compensation',
              committed:error?.committed === true,
              commitScope:error?.commitScope,
              cause:error,
            };
          }
        }
        // 仅兼容不具备可信 I/O 接口的最小测试替身；生产 SessionStore 自行清理 dirfd temp。
        if (!this.sessionStore.sidecarIO) {
          await unlink(`${this.sessionStore.sessionPath}.tmp`).catch(() => {});
        }
        throw error;
      }
    });
  }

  updateTask(taskId, instruction, expectedRevision) {
    return this.#mutateTask(
      'task-update',
      () => this.sessionStore.updateTask(taskId, instruction, expectedRevision),
    );
  }

  deleteTask(taskId, expectedRevision) {
    return this.#mutateTask(
      'task-delete',
      () => this.sessionStore.deleteTask(taskId, expectedRevision),
    );
  }

  replayLocalEdit(commandId, requestDigest) {
    const result=completedCommand(this.sessionStore.state,commandId,requestDigest);
    return result ? {...result,committed:true,idempotent:true,commandRevision:result.revision} : null;
  }

  async reserveEditorMutation(owner, release=false, targets=[]) {
    await this.#waitForEditorSocket();
    const commandId=randomUUID();
    const result=await this.#send(commandId,{type:'editor-lock',commandId,owner,release,targets}, {expectedType:'editor-lock-result'});
    if(result.accepted!==true)throw serviceError('EDITOR_INTERACTION_ACTIVE',409,'右侧正在输入或拖拽，请完成当前操作后重试');
    return result;
  }

  replayCompletedAction({ taskId, actions, coalesceKey=null, commandId=null }) {
    if (commandId === null) return null;
    const requestDigest = commandDigest({ taskId, actions, coalesceKey });
    const duplicate = completedCommand(this.sessionStore.state, commandId, requestDigest);
    if (!duplicate) return null;
    const task = duplicate.taskId === null
      ? null : taskById(this.sessionStore.state, duplicate.taskId);
    return {
      groupId:duplicate.groupId,
      revision:this.sessionStore.state.revision,
      commandRevision:duplicate.revision,
      applied:duplicate.applied,
      committed:true,
      idempotent:true,
      syncPending:true,
      ...(task ? { task:structuredClone(task) } : {}),
    };
  }

  applyActions({ taskId, actions, expectedRevision, coalesceKey = null, commandId = null, signal }) {
    return this.#enqueue(async () => {
      signal?.throwIfAborted();
      const started=Date.now();
      let preparedAt=started,journalAt=started,syncedAt=started;
      this.#assertMutable();
      if (!Array.isArray(actions)
        || actions.some(action => action?.taskId !== taskId)) {
        throw serviceError('INVALID_INPUT', 400, '每个 action.taskId 必须与批次 taskId 严格一致');
      }
      if (commandId !== null && (typeof commandId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(commandId))) {
        throw serviceError('INVALID_INPUT', 400, 'commandId 必须是规范 UUID v4 或 null');
      }
      if (coalesceKey !== null && (taskId !== null || typeof coalesceKey !== 'string'
        || coalesceKey.length === 0 || coalesceKey.length > 256)) {
        throw serviceError('INVALID_INPUT', 400, 'coalesceKey 只允许人工动作使用非空短字符串');
      }
      const requestDigest = commandDigest({ taskId, actions, coalesceKey });
      const duplicate = this.replayCompletedAction({
        taskId, actions, coalesceKey, commandId,
      });
      if (duplicate) {
        return duplicate;
      }
      this.#assertSourceEditInactive();
      const editRevision = this.assertEditRevision(expectedRevision, taskId);
      const linkedTask = taskId === null ? undefined : taskById(this.sessionStore.state, taskId);
      if (taskId !== null && !linkedTask) {
        throw serviceError('TASK_NOT_FOUND', 404, '找不到任务');
      }
      if (linkedTask?.groupId || linkedTask?.status === 'completed') {
        throw serviceError('TASK_ALREADY_COMPLETED', 409, '任务已经完成，不能重复交给 Agent 处理');
      }
      let prepared;
      try {
        prepared = await this.#prepare(actions, editRevision);
        preparedAt=Date.now();
      } catch (error) {
        if (taskId === null || error?.code !== 'TARGET_AMBIGUOUS') throw error;
        const task = await this.#recordTaskNeedsConfirmation(taskId, error.candidates);
        error.revision = this.sessionStore.state.revision;
        error.task = structuredClone(task);
        throw error;
      }
      let group;
      // 提交日志之前取消可以回滚；日志落盘以后以回执为准，不能伪称未提交。
      if(signal?.aborted) {
        await this.#rollbackOrSync(prepared.commandId);
        signal.throwIfAborted();
      }
      const coalesceNow = Date.now();
      const previousCoalesce = this.manualCoalesce;
      const canCoalesce = coalesceKey !== null
        && previousCoalesce?.key === coalesceKey
        && coalesceNow - previousCoalesce.at <= MANUAL_COALESCE_WINDOW_MS;
      try {
        group = await this.#commitJournal(journal => {
          const appended = (canCoalesce
            ? journal.appendToLatestGroup(previousCoalesce.groupId, prepared.results) : null)
            ?? journal.appendGroup(taskId, prepared.results, { commandId });
          completeTask(journal.state, taskId, appended);
          recordCompletedCommand(journal.state, commandId, requestDigest, {
            groupId:appended.id,
            revision:journal.state.revision + 1,
            applied:prepared.applied,
            taskId,
          });
          return appended;
        });
      } catch (error) {
        this.#throwIfClosed();
        if (error?.code === 'RECOVERY_REQUIRED') throw error;
        await this.#rollbackOrSync(prepared.commandId);
        if (['HISTORY_DIVERGED', 'HISTORY_ORDER'].includes(error?.code)) {
          const failedTask = taskId === null ? null : await this.#recordTaskHistoryFailure(taskId, error);
          throw serviceError(error.code, 409, error.message, {
            ...(failedTask ? { task:structuredClone(failedTask), revision:this.sessionStore.state.revision } : {}),
            stage:error.stage ?? 'history-integrity',
            recovery:error.recovery ?? '重新同步编辑器后重试本次操作',
            ...(error.slot ? { slot:error.slot } : {}),
            ...(error.actionId ? { actionId:error.actionId } : {}),
            ...(error.expected !== undefined ? { expected:error.expected } : {}),
            ...(error.actual !== undefined ? { actual:error.actual } : {}),
          });
        }
        throw serviceError('JOURNAL_PERSIST_FAILED', 500, '动作日志持久化失败，浏览器修改已回滚');
      }
      journalAt=Date.now();
      const completedTask = taskId === null
        ? undefined
        : taskById(this.sessionStore.state, taskId);
      const result = {
        groupId:group.id,
        revision:this.sessionStore.state.revision,
        applied:prepared.applied,
        ...(completedTask ? { task:structuredClone(completedTask) } : {}),
      };
      const confirmation = await this.#finalizeCommitted(prepared.commandId);
      syncedAt=Date.now();
      const diagnosticsPending = await this.#refreshDiagnostics(
        this.#pageKeysForActions(prepared.results), result.revision,
      ).then(() => false, error => {
        this.#throwIfClosed();
        if (error?.code === 'RECOVERY_REQUIRED') throw error;
        return true;
      });
      // 合并窗口描述的是用户两次控件操作之间的空闲时间。prepare、commit ACK
      // 与诊断刷新都是内部保存耗时，不能在 UI 尚处于 busy 时提前消耗这 3 秒。
      this.manualCoalesce = coalesceKey === null ? null : {
        key:coalesceKey, groupId:group.id, at:Date.now(),
      };
      const pageKeys=this.#pageKeysForActions(prepared.results);
      const diagnosticsCurrent=this.sessionStore.state.diagnosticsCurrent??{};
      const available=!diagnosticsPending&&pageKeys.every(key=>diagnosticsCurrent[key]);
      const blockers=available?compareDiagnostics(this.sessionStore.state.diagnosticsBaseline,diagnosticsCurrent,pageKeys):[];
      return { ...result, ...confirmation, diagnosticsPending,
        flow:'direct-edit',affectedPages:pageKeys,
        diagnostics:{status:available?(blockers.length?'blocked':'passed'):'pending',pageKeys,blockers},
        timings:{prepareMs:preparedAt-started,persistMs:journalAt-preparedAt,syncMs:syncedAt-journalAt,
          diagnosticsMs:Date.now()-syncedAt,totalMs:Date.now()-started},
      };
    });
  }

  undoGroup(groupId, expectedRevision) { return this.#changeGroup('undo', groupId, expectedRevision); }
  redoGroup(groupId, expectedRevision) { return this.#changeGroup('redo', groupId, expectedRevision); }
  compiledActions() { return this.journal.compile(); }
  sourceRebaseActionIds(actions = this.compiledActions()) {
    return sourceRebaseActionIds(this.journal.state.groups, actions);
  }
  compiledWriteActions() { return this.journal.compileForWrite(); }
  compiledRuntimeWriteActions() { return runtimeWriteActions(this.compiledWriteActions()); }

  preflightSolidify(expectedRevision, { fingerprint, bindingRevision=null } = {}) {
    return this.#enqueue(async () => {
      this.#assertMutable();
      this.#assertSourceEditInactive();
      this.assertRevision(expectedRevision);
      if (typeof fingerprint !== 'function') {
        throw serviceError('INVALID_INPUT', 400, '固化预检缺少文件指纹读取器');
      }
      const state = this.sessionStore.state;
      if (state.groups.length === 0) {
        throw serviceError('NOTHING_TO_SOLIDIFY', 409, '当前没有需要固化的撤销历史');
      }
      const pageIds = this.getPageIds();
      if (Array.isArray(pageIds)) {
        const known = new Set(pageIds);
        const missingPageKeys = [...new Set(this.compiledWriteActions()
          .map(action => action?.target?.pageKey)
          .filter(pageKey => typeof pageKey === 'string' && !known.has(pageKey)))];
        if (missingPageKeys.length > 0) {
          throw serviceError('MISSING_PAGE_TARGETS', 409,
            '已有修改指向当前不存在的页面，请先撤销相关结构修改或清理对应修改', {
              stage:'page-targets', missingPageKeys,
              recovery:'撤销导致目标不可定位的结构修改，或先清理对应页面上的历史动作',
            });
        }
      }
      if (!this.hasEditorSocket() || !this.editorReady) {
        throw diagnosticFailure('EDITOR_OFFLINE', '编辑器未连接或页面尚未就绪');
      }
      await this.readyPromise;
      this.#throwIfClosed();
      let diskFingerprint;
      try { diskFingerprint = await fingerprint(); }
      catch (error) {
        throw serviceError('DECK_CHANGED', 409, '无法读取磁盘 Deck，拒绝固化', {
          stage:'fingerprint', recovery:'恢复或重新绑定 Deck 文件后重试', cause:error,
        });
      }
      if (state.conflict?.code === 'DECK_CHANGED' || diskFingerprint !== state.deckFingerprint) {
        throw serviceError('DECK_CHANGED', 409, '磁盘 Deck 已被外部修改，拒绝固化', {
          stage:'fingerprint',
          expectedFingerprint:state.deckFingerprint,
          actualFingerprint:diskFingerprint,
          recovery:'重新载入外部文件并在新基线上重放补丁，或另存为副本',
        });
      }
      if (!Object.keys(state.diagnosticsBaseline ?? {}).length) {
        throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '会话缺少启动诊断基线');
      }
      const pageKeys = this.#modifiedPageKeys();
      const authoritativeKeys = pageKeys.length ? pageKeys : Object.keys(state.diagnosticsBaseline);
      const current = await this.#diagnose(authoritativeKeys, state.revision);
      const blockers = compareDiagnostics(state.diagnosticsBaseline, current, authoritativeKeys);
      if (blockers.length) {
        throw serviceError('NEW_OVERFLOW', 409, '修改引入了新的页面或内层溢出', {
          stage:'overflow', blockers, recovery:'撤销或修复造成溢出的动作后重试',
        });
      }
      const token = randomUUID();
      const expiresAt = Date.now() + 60_000;
      const actionsDigest = commandDigest(this.compiledRuntimeWriteActions());
      this.solidifyPreflights.set(token, {
        revision:state.revision,
        deckFingerprint:state.deckFingerprint,
        workingDeckFingerprint:state.workingDeckFingerprint ?? null,
        actionsDigest,
        bindingRevision,
        expiresAt,
      });
      return {
        preflightToken:token,
        revision:state.revision,
        bindingRevision,
        projectionDigest:actionsDigest,
        diagnosticsPageCount:authoritativeKeys.length,
        expiresAt:new Date(expiresAt).toISOString(),
      };
    });
  }

  locateText(text, { pageKey=null } = {}) {
    return this.#enqueue(async () => {
      this.#assertMutable();
      if (!this.hasEditorSocket() || !this.editorReady) {
        throw serviceError('EDITOR_OFFLINE', 409, '编辑器未连接或页面尚未就绪');
      }
      const commandId = randomUUID();
      const result = await this.#send(
        commandId,
        { type:'locate-text', commandId, text, ...(pageKey ? { pageKey } : {}) },
        { expectedType:'text-locations' },
      );
      return { revision:this.sessionStore.state.revision, ...result };
    });
  }

  recordSourceMutation(source, {
    restore, taskId = null, solidifiedPatchRepair = null,
  } = {}) {
    return this.#enqueue(async () => {
      this.#assertMutable();
      this.#assertSourceEditInactive();
      return this.#recordSourceMutation(source, {
        restore, taskId, solidifiedPatchRepair,
      });
    });
  }

  commitSourceEdit({
    sourceEditId, expectedRevision, source, restore, finalize = async () => {},
    solidifiedPatchRepair = null,
  }) {
    return this.#enqueue(async () => {
      this.#assertMutable();
      this.assertRevision(expectedRevision);
      const active = this.#requireSourceEdit(sourceEditId);
      if (source?.beforeFingerprint !== active.beforeFingerprint) {
        throw serviceError('WORKING_DECK_CHANGED', 409, '源码事务提交的起始版本与预留版本不一致');
      }
      return this.#recordSourceMutation(source, {
        restore,
        taskId:active.taskId,
        clearSourceEditId:active.id,
        finalize,
        solidifiedPatchRepair,
        command:active.commandId ? {commandId:active.commandId,requestDigest:active.requestDigest} : null,
      });
    });
  }

  cancelSourceEdit({ sourceEditId, expectedRevision, discard = async () => {} }) {
    return this.#enqueue(async () => {
      this.#assertMutable();
      this.assertRevision(expectedRevision);
      const active = this.#requireSourceEdit(sourceEditId);
      await discard(active.beforeFingerprint);
      const candidate = structuredClone(this.sessionStore.state);
      delete candidate.sourceEdit;
      candidate.revision += 1;
      await this.#persistCandidate(candidate, { operation:'source-edit-cancel' });
      this.manualCoalesce = null;
      return {
        sourceEditId, taskId:active.taskId,
        revision:this.sessionStore.state.revision, cancelled:true,
      };
    });
  }

  async #recordSourceMutation(source, {
    restore, taskId = null, clearSourceEditId = null, finalize = async () => {},
    solidifiedPatchRepair = null, command=null,
  } = {}) {
    const state = this.sessionStore.state;
    if (state.workingDeckFingerprint !== source?.beforeFingerprint) {
      throw serviceError('WORKING_DECK_CHANGED', 409, '结构修改的起始工作副本版本已过期');
    }
    const linkedTask = taskId === null ? null : taskById(state, taskId);
    if (taskId !== null && !linkedTask) {
      throw serviceError('TASK_NOT_FOUND', 404, '找不到结构任务');
    }
    if (linkedTask?.groupId || linkedTask?.status === 'completed') {
      throw serviceError('TASK_ALREADY_COMPLETED', 409, '结构任务已经完成，不能重复交给 Agent 处理');
    }
    let candidate = structuredClone(state);
    if (clearSourceEditId !== null) {
      if (candidate.sourceEdit?.id !== clearSourceEditId) {
        throw serviceError('SOURCE_EDIT_MISMATCH', 409, '源码事务在提交前已经改变');
      }
      delete candidate.sourceEdit;
    }
    const patchRepair = normalizeSolidifiedPatchRepair(state, solidifiedPatchRepair);
    const recordedSource = patchRepair
      ? { ...source, solidifiedPatchTransition:patchRepair.transition }
      : source;
    const journal = new PatchJournal(candidate);
    const group = journal.appendSourceGroup(recordedSource, taskId);
    if (patchRepair) {
      candidate.solidifiedActions = patchRepair.effectivePatches;
      candidate.historyRepair = {
        repairedAt:new Date().toISOString(),
        sourceGroupId:group.id,
        reason:'source-replaced-solidified-targets',
        droppedActionIds:[...patchRepair.droppedActionIds],
      };
    }
    completeTask(candidate, taskId, group);
    candidate.revision += 1;
    if(command)recordCompletedCommand(candidate,command.commandId,command.requestDigest,{groupId:group.id,taskId,revision:candidate.revision,applied:1});
    candidate.workingDeckFingerprint = source.afterFingerprint;
    candidate.diagnosticsBaseline = {};
    candidate.diagnosticsCurrent = {};
    candidate.diagnosticsRevision = null;
    candidate = this.reconcileSession(candidate);
    try {
      await this.#persistCandidate(candidate, {
        operation:'source-mutation', groupId:group.id,
      });
    } catch (error) {
      if (error?.code === 'RECOVERY_REQUIRED' || typeof restore !== 'function') throw error;
      try { await restore(source.beforeFingerprint, source.afterFingerprint); }
      catch (restoreError) {
        throw this.#enterRecoveryRequired({
          operation:'source-mutation-compensation', committed:true,
          commitScope:'working-deck', cause:restoreError,
        });
      }
      throw serviceError('JOURNAL_PERSIST_FAILED', 500,
        '结构修改历史持久化失败，工作副本已恢复', { cause:error });
    }
    try { await finalize(source.afterFingerprint); }
    catch (error) {
      throw this.#enterRecoveryRequired({
        operation:'source-mutation-finalize', committed:true,
        commitScope:'session', groupId:group.id, cause:error,
      });
    }
    this.manualCoalesce = null;
    const completedTask = taskId === null ? null : taskById(candidate, taskId);
    return {
      groupId:group.id, revision:candidate.revision, source:group.source,
      ...(patchRepair
        ? { droppedSolidifiedActionIds:[...patchRepair.droppedActionIds] } : {}),
      ...(completedTask ? { task:structuredClone(completedTask) } : {}),
    };
  }

  changeSourceGroup(method, groupId, expectedRevision, { restore } = {}) {
    return this.#enqueue(async () => {
      this.#assertMutable();
      this.#assertSourceEditInactive();
      this.assertRevision(expectedRevision);
      if (!['undo', 'redo'].includes(method) || typeof restore !== 'function') {
        throw serviceError('INVALID_INPUT', 400, '结构历史变更参数无效');
      }
      const state = this.sessionStore.state;
      const originalGroup = sourceGroupById(state, groupId);
      if (!originalGroup) throw serviceError('GROUP_NOT_FOUND', 404, '找不到结构修改组');
      const latestActive = [...state.groups].reverse().find(group => group?.active === true);
      if ((method === 'undo' && latestActive?.id !== groupId)
        || (method === 'redo' && state.redo?.at(-1) !== groupId)) {
        throw serviceError('SOURCE_HISTORY_ORDER', 409, '结构修改必须按历史顺序撤销或重做');
      }
      const draftState = copyJournalState(state);
      const draft = new PatchJournal(draftState);
      try { draft[method](groupId); }
      catch { throw serviceError('GROUP_NOT_FOUND', 404, '找不到结构修改组'); }
      const currentFingerprint = state.workingDeckFingerprint;
      const targetFingerprint = method === 'undo'
        ? originalGroup.source.beforeFingerprint
        : originalGroup.source.afterFingerprint;
      draftState.solidifiedActions=applySolidifiedPatchTransition(state.solidifiedActions,originalGroup.source?.solidifiedPatchTransition,method);
      await restore(targetFingerprint, currentFingerprint, runtimeWriteActions(draft.compileForWrite()));
      let candidate = {
        ...structuredClone(state),
        timeline:structuredClone(draftState.timeline),
        groups:structuredClone(draftState.groups),
        redo:structuredClone(draftState.redo),
        workingDeckFingerprint:targetFingerprint,
        diagnosticsBaseline:{}, diagnosticsCurrent:{}, diagnosticsRevision:null,
        revision:state.revision + 1,
      };
      candidate.solidifiedActions = applySolidifiedPatchTransition(
        state.solidifiedActions,
        originalGroup.source?.solidifiedPatchTransition,
        method,
      );
      let linkedTask = method === 'undo'
        ? markTaskEffectUndone(candidate, originalGroup.taskId ?? null, originalGroup)
        : completeTask(candidate, originalGroup.taskId ?? null, originalGroup);
      candidate = this.reconcileSession(candidate);
      linkedTask = taskById(candidate, originalGroup.taskId ?? null);
      try {
        await this.#persistCandidate(candidate, {
          operation:`source-${method}`, groupId,
        });
      } catch (error) {
        if (error?.code === 'RECOVERY_REQUIRED') throw error;
        try { await restore(currentFingerprint, targetFingerprint); }
        catch (restoreError) {
          throw this.#enterRecoveryRequired({
            operation:`source-${method}-compensation`, committed:true,
            commitScope:'working-deck', cause:restoreError,
          });
        }
        throw serviceError('JOURNAL_PERSIST_FAILED', 500,
          '结构修改历史持久化失败，工作副本已恢复', { cause:error });
      }
      this.manualCoalesce = null;
      return {
        groupId, revision:candidate.revision, applied:0,
        mutationType:'source', workingDeckFingerprint:targetFingerprint,
        ...(linkedTask ? { task:structuredClone(linkedTask) } : {}),
      };
    });
  }

  writeDeck(expectedRevision, {
    fingerprint, writer, restore, finalize = async () => {}, solidify = false,
    scope = 'deck', preflightToken=null, bindingRevision=null,
  }) {
    return this.#enqueue(async () => {
      this.#assertMutable();
      this.#assertSourceEditInactive();
      this.assertRevision(expectedRevision);
      if (solidify && preflightToken !== null) {
        const preflight = this.solidifyPreflights.get(preflightToken);
        this.solidifyPreflights.delete(preflightToken);
        const state = this.sessionStore.state;
        const stale = !preflight
          || preflight.expiresAt < Date.now()
          || preflight.revision !== expectedRevision
          || preflight.deckFingerprint !== state.deckFingerprint
          || preflight.workingDeckFingerprint !== (state.workingDeckFingerprint ?? null)
          || preflight.actionsDigest !== commandDigest(this.compiledRuntimeWriteActions())
          || preflight.bindingRevision !== bindingRevision;
        if (stale) {
          throw serviceError('SOLIDIFY_PREFLIGHT_STALE', 409,
            '固化预检结果已经过期，请重新检查后再固化', {
              stage:'solidify-preflight',
              recovery:'重新执行固化预检',
            });
        }
      }
      if (solidify && this.sessionStore.state.groups.length === 0) {
        throw serviceError('NOTHING_TO_SOLIDIFY', 409, '当前没有需要固化的撤销历史');
      }
      if (solidify) {
        const pageIds = this.getPageIds();
        if (Array.isArray(pageIds)) {
          const known = new Set(pageIds);
          const missingPageKeys = [...new Set(this.compiledWriteActions()
            .map(action => action?.target?.pageKey)
            .filter(pageKey => typeof pageKey === 'string' && !known.has(pageKey)))];
          if (missingPageKeys.length > 0) {
            throw serviceError(
              'MISSING_PAGE_TARGETS', 409,
              '已有修改指向当前不存在的页面，请先撤销相关结构修改或清理对应修改',
              {
                stage:'page-targets',
                recovery:'撤销导致目标不可定位的结构修改，或先清理对应页面上的历史动作',
                missingPageKeys,
              },
            );
          }
        }
      }
      if (!this.hasEditorSocket() || !this.editorReady) {
        throw diagnosticFailure('EDITOR_OFFLINE', '编辑器未连接或页面尚未就绪');
      }
      await this.readyPromise;
      this.#throwIfClosed();
      const state = this.sessionStore.state;
      let diskFingerprint;
      try {
        diskFingerprint = await fingerprint();
        this.#throwIfClosed();
      } catch (error) {
        this.#throwIfClosed();
        const actualFingerprint = `unavailable:${error.code ?? 'READ_ERROR'}`;
        const conflictCreated = await this.#recordDeckConflict(actualFingerprint);
        throw serviceError('DECK_CHANGED', 409, '无法读取磁盘 Deck，拒绝写回', {
          stage:'fingerprint',
          recovery:'恢复或重新载入 Deck 文件后重试',
          expectedFingerprint:state.deckFingerprint,
          actualFingerprint,
          conflictCreated,
        });
      }
      if (state.conflict?.code === 'DECK_CHANGED' || diskFingerprint !== state.deckFingerprint) {
        const conflictCreated = await this.#recordDeckConflict(diskFingerprint);
        throw serviceError('DECK_CHANGED', 409, '磁盘 Deck 已被外部修改，拒绝覆盖', {
          stage:'fingerprint',
          recovery:'重新载入外部文件并在新基线上重放补丁，或另存为副本',
          expectedFingerprint:state.deckFingerprint,
          actualFingerprint:diskFingerprint,
          conflictCreated,
        });
      }
      if (!Object.keys(state.diagnosticsBaseline ?? {}).length) {
        throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '会话缺少启动诊断基线');
      }
      const pageKeys = this.#modifiedPageKeys();
      const authoritativeKeys = pageKeys.length ? pageKeys : Object.keys(state.diagnosticsBaseline);
      const current = await this.#diagnose(authoritativeKeys, state.revision);
      this.#throwIfClosed();
      const blockers = compareDiagnostics(state.diagnosticsBaseline, current, authoritativeKeys);
      if (blockers.length) {
        throw serviceError('NEW_OVERFLOW', 409, '修改引入了新的页面或内层溢出', {
          stage:'overflow',
          recovery:'撤销或修复造成溢出的动作后重试',
          blockers,
        });
      }
      let result;
      try {
        result = await writer(runtimeWriteActions(this.compiledWriteActions()), diskFingerprint);
        this.#throwIfClosed();
      } catch (error) {
        this.#throwIfClosed();
        if (['DECK_CHANGED', 'RESTORE_CONFLICT'].includes(error?.code)
          && typeof error?.actualFingerprint === 'string') {
          error.conflictCreated = await this.#recordDeckConflict(error.actualFingerprint);
          try { await finalize(error); }
          catch (finalizeError) {
            throw this.#enterRecoveryRequired({
              backup:error.backup,
              cause:finalizeError,
            });
          }
        }
        throw error;
      }
      try {
        await this.beforeSessionPersist(result);
        this.#throwIfClosed();
      }
      catch (error) {
        this.#throwIfClosed();
        throw this.#enterRecoveryRequired({
          backup:result.backup,
          cause:error,
        });
      }
      const snapshot = {
        deckFingerprint:state.deckFingerprint,
        workingDeckFingerprint:state.workingDeckFingerprint,
      };
      const candidate = {
        ...structuredClone(state),
        deckFingerprint:scope === 'working' ? state.deckFingerprint : result.fingerprint,
        workingDeckFingerprint:result.fingerprint,
        conflict:null,
        diagnosticsBaseline:{
          ...structuredClone(state.diagnosticsBaseline),
          ...structuredClone(current),
        },
        diagnosticsCurrent:{
          ...structuredClone(state.diagnosticsCurrent),
          ...structuredClone(current),
        },
        diagnosticsRevision:state.revision,
      };
      let solidification = null;
      if (solidify) {
        const candidateJournal = new PatchJournal(candidate);
        solidification = candidateJournal.solidify({
          revision:state.revision + 1,
          fingerprint:result.fingerprint,
          workingFingerprint:result.fingerprint,
        });
        // session 的固化基线必须与 writer 已写进 bundle 的动作 schema 完全相同。
        // 不能把 expectedRevision 等请求期字段留在内存里，否则重开后 JSON
        // 规范化会让同一个已提交状态前后不一致。
        candidate.solidifiedActions = Array.isArray(result.effectivePatches)
          ? structuredClone(result.effectivePatches)
          : runtimeWriteActions(solidification.actions);
        if (Array.isArray(result.droppedActionIds) && result.droppedActionIds.length > 0) {
          candidate.historyRepair = {
            repairedAt:new Date().toISOString(),
            checkpointId:solidification.checkpointId,
            reason:'source-replaced-targets',
            droppedActionIds:[...result.droppedActionIds],
          };
        }
        candidate.revision = state.revision + 1;
        candidate.diagnosticsRevision = candidate.revision;
        const archived = new Set(solidification.archivedEntryIds);
        for (const task of candidate.tasks ?? []) {
          if (typeof task.groupId === 'string' && archived.has(task.groupId)) {
            task.checkpointIds = [...new Set([
              ...(task.checkpointIds ?? []), solidification.checkpointId,
            ])];
            task.effectState = 'solidified';
          }
          delete task.groupId;
        }
      }
      try {
        await this.#persistCandidate(candidate, {
          operation:solidify ? 'solidify-deck' : 'write-deck', backup:result.backup,
        });
      } catch (error) {
        this.#throwIfClosed();
        if (error?.code === 'RECOVERY_REQUIRED') throw error;
        try {
          await restore(
            result,
            scope === 'working' ? result.previousFingerprint : snapshot.deckFingerprint,
          );
        } catch (restoreError) {
          this.#throwIfClosed();
          throw this.#enterRecoveryRequired({
            backup:result.backup,
            committed:true,
            cause:restoreError,
          });
        }
        try { await finalize(result); }
        catch (finalizeError) {
          this.#throwIfClosed();
          throw this.#enterRecoveryRequired({
            backup:result.backup,
            cause:finalizeError,
          });
        }
        throw serviceError('WRITE_FAILED', 500, '会话基线更新失败，Deck 已恢复且事务已安全清理', {
          stage:'session',
          recovery:'检查 sidecar 目录权限后重试',
          backup:result.backup,
          cause:error,
        });
      }
      try { await finalize(result); }
      catch (error) {
        this.#throwIfClosed();
        throw this.#enterRecoveryRequired({
          backup:result.backup,
          committed:true,
          cause:error,
        });
      }
      if (!solidify) return result;
      this.manualCoalesce = null;
      const {
        effectivePatches:_effectivePatches,
        droppedActionIds:_droppedActionIds,
        ...publicResult
      } = result;
      return {
        ...publicResult,
        revision:this.sessionStore.state.revision,
        solidified:true,
        clearedGroupCount:solidification.clearedGroupCount,
        clearedRedoCount:solidification.clearedRedoCount,
        checkpointId:solidification.checkpointId,
        ...(Array.isArray(result.droppedActionIds) && result.droppedActionIds.length > 0
          ? { droppedLegacyActionIds:[...result.droppedActionIds] } : {}),
      };
    });
  }

  noteDeckFingerprint(fingerprintOrProvider) {
    return this.#enqueue(async () => {
      this.#assertMutable();
      const fingerprint = typeof fingerprintOrProvider === 'function'
        ? await fingerprintOrProvider()
        : fingerprintOrProvider;
      this.#throwIfClosed();
      if (fingerprint === this.sessionStore.state.deckFingerprint) return false;
      return this.#recordDeckConflict(fingerprint);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.editorSocket = null;
    this.editorReady = false;
    this.editorPageKeys = [];
    this.readyPromise = null;
    this.solidifyPreflights.clear();
    const error = serviceError('SERVICE_CLOSED', 503, '服务已关闭');
    for (const commandId of [...this.pending.keys()]) this.#settle(commandId, 'reject', error);
    for (const waiter of this.socketWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.socketWaiters.clear();
  }

  /** 只读浏览器瞬态状态，不锁住画布，也不进入写队列。 */
  async inspectRestartStatus() {
    if(!this.editorReady)throw serviceError('EDITOR_OFFLINE',409,'画布尚未就绪');
    const commandId=randomUUID();
    const result=await this.#send(commandId,{type:'restart-status',commandId},{expectedType:'restart-status-result',timeoutMs:1500});
    return {busy:result.busy};
  }

  #enqueue(operation) {
    this.pendingMutations += 1;
    const guarded = async () => {
      this.#throwIfClosed();
      try {
        const result = await operation();
        this.#throwIfClosed();
        return result;
      } catch (error) {
        if (error?.sessionCandidateCommitted === true) throw error;
        this.#throwIfClosed();
        throw error;
      }
    };
    const result = this.mutationQueue.then(guarded, guarded).finally(()=>{this.pendingMutations -= 1;});
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  #mutateTask(operation, mutation) {
    return this.#enqueue(async () => {
      this.#assertMutable();
      this.#assertSourceEditInactive();
      try {
        const result = await mutation();
        if (this.closed) {
          throw serviceError('SERVICE_CLOSED', 503, '任务变更已提交，但服务关闭前未完成确认', {
            operation,
            committed:true,
            commitScope:'session',
            syncPending:true,
            sessionCandidateCommitted:true,
            revision:result.revision,
          });
        }
        return result;
      } catch (error) {
        if (this.closed && isCommittedSession(error)) {
          throw serviceError('SERVICE_CLOSED', 503, '任务变更已提交，但服务关闭前未完成确认', {
            operation,
            committed:true,
            commitScope:'session',
            syncPending:true,
            sessionCandidateCommitted:true,
            revision:this.sessionStore.state.revision,
            cause:error,
          });
        }
        if (error?.sessionCandidateCommitted === true) throw error;
        this.#throwIfClosed();
        if (isCommittedSession(error)) {
          throw this.#enterRecoveryRequired({
            operation, committed:true, commitScope:'session', cause:error,
          });
        }
        throw error;
      }
    });
  }

  async #changeGroup(method, groupId, expectedRevision) {
    return this.#enqueue(async () => {
      this.#assertMutable();
      this.#assertSourceEditInactive();
      this.assertRevision(expectedRevision);
      this.manualCoalesce = null;
      const draftState = copyJournalState(this.sessionStore.state);
      const draft = new PatchJournal(draftState);
      const originalGroup = draft.group(groupId);
      if (!originalGroup) throw serviceError('GROUP_NOT_FOUND', 404, '找不到动作组');
      let compensationGroup = null;
      try { draft[method](groupId); }
      catch (error) {
        const linkedTaskId = originalGroup.taskId ?? originalGroup.compensation?.taskId;
        if (method === 'undo' && error?.code === 'HISTORY_ORDER'
          && originalGroup.mutationType !== 'source'
          && typeof linkedTaskId === 'string') {
          compensationGroup = draft.compensate(groupId);
        } else if (error?.code === 'HISTORY_ORDER') {
          throw serviceError('HISTORY_ORDER', 409, error.message, {
            stage:error.stage,
            expectedGroupId:error.expectedEntryId,
            requestedGroupId:error.requestedEntryId,
          });
        } else if (error?.code === 'COMPENSATION_CONFLICT'
          || error?.code === 'NOTHING_TO_COMPENSATE') {
          throw serviceError(error.code, 409, error.message, {
            stage:error.stage,
            ...(error.slots ? { slots:error.slots } : {}),
          });
        } else {
          throw serviceError('GROUP_NOT_FOUND', 404, '找不到动作组');
        }
      }
      const actions = draft.compile();
      const prepared = await this.#prepare(actions, expectedRevision, { replace:true });
      let linkedTask;
      try {
        await this.#commitJournal(journal => {
          journal.replaceHistory(draft);
          const changedGroup = journal.group(compensationGroup?.id ?? groupId);
          if (compensationGroup) {
            const linkedTaskId = originalGroup.taskId ?? originalGroup.compensation?.taskId;
            linkedTask = originalGroup.compensation
              ? completeTask(journal.state, linkedTaskId, compensationGroup)
              : markTaskEffectUndone(journal.state, linkedTaskId, compensationGroup);
          } else if (changedGroup?.compensation) {
            linkedTask = method === 'undo'
              ? completeTask(journal.state, changedGroup.compensation.taskId ?? null,
                journal.group(changedGroup.compensation.entryId))
              : markTaskEffectUndone(
                journal.state, changedGroup.compensation.taskId ?? null, changedGroup,
              );
          } else {
            linkedTask = method === 'undo'
              ? markTaskEffectUndone(
                journal.state, changedGroup?.taskId ?? null, changedGroup,
              )
              : completeTask(journal.state, changedGroup?.taskId ?? null, changedGroup);
          }
          return { id:compensationGroup?.id ?? groupId };
        });
      } catch (error) {
        this.#throwIfClosed();
        if (error?.code === 'RECOVERY_REQUIRED') throw error;
        await this.#rollbackOrSync(prepared.commandId);
        throw serviceError('JOURNAL_PERSIST_FAILED', 500, '动作日志持久化失败，浏览器修改已回滚');
      }
      const result = {
        groupId:compensationGroup?.id ?? groupId,
        ...(compensationGroup ? { compensatedGroupId:groupId } : {}),
        revision: this.sessionStore.state.revision, applied: prepared.applied,
        ...(linkedTask ? { task:structuredClone(taskById(this.sessionStore.state, linkedTask.id)) } : {}),
      };
      const confirmation = await this.#finalizeCommitted(prepared.commandId);
      const changedGroup = draft.group(compensationGroup?.id ?? groupId);
      const diagnosticsPending = await this.#refreshDiagnostics(
        this.#pageKeysForActions(changedGroup?.actions ?? []), result.revision,
      ).then(() => false, error => {
        this.#throwIfClosed();
        if (error?.code === 'RECOVERY_REQUIRED') throw error;
        return true;
      });
      return { ...result, ...confirmation, diagnosticsPending };
    });
  }

  async #prepare(actions, expectedRevision, { replace=false } = {}) {
    this.#throwIfClosed();
    this.assertRevision(expectedRevision);
    const commandId = randomUUID();
    try {
      return await this.#send(
        commandId, {
          type:'apply-actions', commandId, actions, tentative:true, replace,
          ...(replace ? { rebaseActionIds:this.sourceRebaseActionIds(actions) } : {}),
        },
        { expectedType:'actions-prepared', actions },
      );
    } catch (error) {
      this.#throwIfClosed();
      if (['PAGE_NOT_FOUND', 'TARGET_NOT_FOUND', 'TARGET_AMBIGUOUS',
        'INVALID_ACTION', 'ACTION_REJECTED', 'EDITOR_INTERACTION_ACTIVE', 'EDITOR_OFFLINE',
        'SERVICE_CLOSED', 'REVISION_CONFLICT'].includes(error.code)) throw error;
      await this.#rollbackOrSync(commandId).catch(syncError => { throw syncError; });
      throw error;
    }
  }

  async #finalizeCommitted(commandId) {
    try {
      const result = await this.#send(
        commandId, { type:'commit-actions', commandId },
        { expectedType:'actions-committed' },
      );
      if (result.committed !== true) throw serviceError('INVALID_ACTION_ACK', 502);
      return { commitConfirmed:true, recoveredBySync:false, syncPending:false };
    } catch (error) {
      this.#throwIfClosed();
      try { await this.#forceSync(); }
      catch (syncError) {
        this.#throwIfClosed();
        return { commitConfirmed:false, recoveredBySync:false, syncPending:true };
      }
      return { commitConfirmed:false, recoveredBySync:true, syncPending:false };
    }
  }

  async #rollbackOrSync(commandId) {
    this.#throwIfClosed();
    try {
      const result = await this.#send(
        commandId, { type:'rollback-actions', commandId },
        { expectedType:'actions-rolled-back' },
      );
      if (result.rolledBack !== true) throw serviceError('INVALID_ACTION_ACK', 502);
      return;
    } catch (error) {
      this.#throwIfClosed();
      try { await this.#forceSync(); }
      catch (syncError) {
        this.#throwIfClosed();
        throw serviceError('EDITOR_SYNC_REQUIRED', 503, '无法确认浏览器回滚，请重连以恢复 sidecar 权威状态');
      }
    }
  }

  async #forceSync() {
    this.#throwIfClosed();
    await this.#waitForEditorSocket();
    const commandId = randomUUID();
    await this.#send(
      commandId,
      (() => {
        const actions = this.compiledActions();
        return {
          type:'sync-actions', commandId, actions,
          rebaseActionIds:this.sourceRebaseActionIds(actions),
        };
      })(),
      { expectedType:'actions-synced' },
    );
  }

  async #refreshDiagnostics(pageKeys, revision) {
    this.#throwIfClosed();
    if (!pageKeys.length || !this.editorReady) return;
    const pages = await this.#diagnose(pageKeys, revision);
    if (revision !== this.sessionStore.state.revision) return;
    const state = this.sessionStore.state;
    const candidate = {
      ...structuredClone(state),
      diagnosticsCurrent:{
        ...structuredClone(state.diagnosticsCurrent),
        ...pages,
      },
      diagnosticsRevision:revision,
    };
    await this.#persistCandidate(candidate, { operation:'diagnostics-refresh' });
  }

  async #diagnose(pageKeys, revision) {
    this.#throwIfClosed();
    if (!this.hasEditorSocket() || !this.editorReady) {
      throw diagnosticFailure('EDITOR_OFFLINE', '编辑器未连接或页面尚未就绪');
    }
    const uniquePageKeys = [...new Set(pageKeys)];
    if (!uniquePageKeys.length
      || uniquePageKeys.some(pageKey => !this.editorPageKeys.includes(pageKey))) {
      throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '修改页不在当前编辑器页面集合中');
    }
    const commandId = randomUUID();
    try {
      const result = await this.#send(
        commandId,
        { type:'diagnose-pages', commandId, revision, pageKeys:uniquePageKeys },
        { expectedType:'diagnostics-result', revision, pageKeys:uniquePageKeys },
      );
      this.#throwIfClosed();
      return result.pages;
    } catch (error) {
      this.#throwIfClosed();
      if (error?.code === 'DIAGNOSTICS_UNAVAILABLE') throw error;
      if (error?.code === 'COMMAND_TIMEOUT' || error?.code === 'EDITOR_OFFLINE') {
        throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '编辑器未能返回权威页面诊断', {
          diagnosticCode:error.code,
        });
      }
      throw error;
    }
  }

  #pageKeysForActions(actions) {
    return [...new Set(actions.map(action => action?.target?.pageKey).filter(Boolean))];
  }

  #modifiedPageKeys() {
    return this.#pageKeysForActions(
      (this.sessionStore.state.groups ?? [])
        .filter(group => group?.active === true)
        .flatMap(group => group.actions ?? []),
    );
  }

  async #recordDeckConflict(fingerprint) {
    const state = this.sessionStore.state;
    if (state.conflict?.code === 'DECK_CHANGED') return false;
    const candidate = {
      ...structuredClone(state),
      conflict:{
        code:'DECK_CHANGED',
        expectedFingerprint:state.deckFingerprint,
        actualFingerprint:fingerprint,
        detectedAt:new Date().toISOString(),
      },
    };
    try {
      await this.#persistCandidate(candidate, { operation:'deck-conflict' });
      return true;
    } catch (error) {
      this.#throwIfClosed();
      if (error?.code === 'RECOVERY_REQUIRED') throw error;
      throw serviceError('WRITE_FAILED', 500, 'Deck 冲突状态无法持久化', {
        stage:'session',
        recovery:'检查 sidecar 目录权限后重试',
        cause:error,
      });
    }
  }

  #waitForEditorSocket() {
    if (this.closed) return Promise.reject(this.#closedError());
    if (this.hasEditorSocket()) return Promise.resolve(this.editorSocket);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer:null };
      waiter.timer = setTimeout(() => {
        this.socketWaiters.delete(waiter);
        reject(serviceError('EDITOR_OFFLINE', 409, '等待编辑器重连超时'));
      }, this.timeoutMs);
      waiter.timer.unref?.();
      this.socketWaiters.add(waiter);
    });
  }

  #send(commandId, message, {
    expectedType, actions = [], revision = undefined, pageKeys = [], timeoutMs = this.timeoutMs,
  }) {
    if (this.closed) return Promise.reject(this.#closedError());
    const socket = this.editorSocket;
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(serviceError('EDITOR_OFFLINE', 409, '编辑器未连接'));
    }
    const acknowledgement = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#settle(commandId, 'reject', serviceError('COMMAND_TIMEOUT', 504, '编辑器动作回执超时'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(commandId, {
        resolve, reject, timer, socket, expectedType, actions, revision, pageKeys,
      });
    });
    try { socket.send(JSON.stringify(message)); }
    catch (error) { this.#settle(commandId, 'reject', error); }
    return acknowledgement;
  }

  async #commitJournal(change) {
    const state = this.sessionStore.state;
    const candidate = structuredClone(state);
    const journal = new PatchJournal(candidate);
    const result = change(journal);
    candidate.revision += 1;
    await this.#persistCandidate(candidate, {
      operation:'journal', revision:candidate.revision,
      ...(typeof result?.id === 'string' ? { groupId:result.id } : {}),
    });
    return result;
  }

  async #recordTaskHistoryFailure(taskId, error) {
    const candidate = structuredClone(this.sessionStore.state);
    const task = taskById(candidate, taskId);
    task.status = 'failed';
    task.candidates = [];
    task.lastError = {
      code:error.code, message:'编辑历史与页面状态不同步，本次修改未提交。',
      recovery:'请重新打开工作项后重试；无需重新描述标记对象。',
    };
    task.updatedAt = new Date().toISOString();
    candidate.revision += 1;
    await this.#persistCandidate(candidate, { operation:'task-history-failed', revision:candidate.revision });
    return taskById(this.sessionStore.state, taskId);
  }

  async #recordTaskNeedsConfirmation(taskId, candidates) {
    const state = this.sessionStore.state;
    const candidate = structuredClone(state);
    const task = taskById(candidate, taskId);
    if (!task) throw serviceError('TASK_NOT_FOUND', 404, '找不到任务');
    task.status = 'needs-confirmation';
    delete task.lastError;
    delete task.groupId;
    task.candidates = structuredClone(Array.isArray(candidates) ? candidates.slice(0, 5) : []);
    task.updatedAt = new Date().toISOString();
    candidate.revision += 1;
    await this.#persistCandidate(candidate, {
      operation:'task-needs-confirmation', revision:candidate.revision,
    });
    return taskById(this.sessionStore.state, taskId);
  }

  #settle(commandId, method, value) {
    const pending = this.pending.get(commandId);
    if (!pending) return;
    this.pending.delete(commandId);
    clearTimeout(pending.timer);
    pending[method](value);
  }

  #validCanonicalResults(requested, results) {
    if (!Array.isArray(results) || results.length !== requested.length) return false;
    return results.every((result, index) => {
      const source = requested[index];
      try { validateAction(result); } catch { return false; }
      return result.id === source.id
        && result.taskId === source.taskId
        && result.kind === source.kind
        && isDeepStrictEqual(result.target, source.target)
        && isDeepStrictEqual(result.payload, source.payload)
        && hasCanonicalValues(result);
    });
  }
}
