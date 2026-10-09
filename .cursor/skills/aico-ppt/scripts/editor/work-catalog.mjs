import { randomUUID as systemRandomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { openDeckBinding } from './deck-binding-coordinator.mjs';
import { resolveEditorStateRoot } from './editor-state-root.mjs';

const SCHEMA_VERSION = 3;
const PREVIOUS_SCHEMA_VERSION = 2;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DSH_SESSION_ORIGINS = new Set(['fresh', 'fork', 'adopted']);
const DSH_SESSION_STATES = new Set(['available', 'historical', 'missing', 'archived']);

function emptyState() {
  return { version:SCHEMA_VERSION, revision:0, workItems:[] };
}

function emptyDshBinding() {
  return {
    revision:0,
    workspaceId:null,
    activeSessionId:null,
    sessions:[],
    pendingOperation:null,
  };
}

function catalogError(code, statusCode, message, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

function requireUuid(value, label) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw catalogError('INVALID_WORK_IDENTITY', 500, label + ' 必须是规范 UUID v4');
  }
  return value;
}

function requireOpaqueId(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw catalogError('INVALID_DSH_IDENTITY', 400, label + ' 必须是非空标识且不能包含控制字符');
  }
  return value;
}

function requireDshOrigin(value) {
  if (!DSH_SESSION_ORIGINS.has(value)) {
    throw catalogError('INVALID_DSH_SESSION_ORIGIN', 400, 'DSH 会话来源无效');
  }
  return value;
}

function migrateState(parsed) {
  if (parsed?.version !== PREVIOUS_SCHEMA_VERSION || !Array.isArray(parsed.workItems)) {
    return null;
  }
  return {
    version:SCHEMA_VERSION,
    revision:Number.isInteger(parsed.revision) ? parsed.revision + 1 : 1,
    workItems:parsed.workItems.map(item => ({
      ...item,
      dshBinding:emptyDshBinding(),
    })),
  };
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string') {
    throw catalogError('INVALID_WORK_NAME', 400, '工作项名称必须是字符串');
  }
  const displayName = value.trim();
  if (!displayName || [...displayName].length > 80 || /[\u0000-\u001f\u007f]/u.test(displayName)) {
    throw catalogError('INVALID_WORK_NAME', 400, '工作项名称必须为 1–80 个字符且不能包含换行或控制字符');
  }
  return displayName;
}

function isDeckPath(value) {
  return typeof value === 'string' && ['.html', '.htm'].includes(extname(value).toLowerCase());
}

function editingKey(value) {
  return 'editing\0' + resolve(value);
}

function creationKey(projectRoot, draftId) {
  return 'creation\0' + resolve(projectRoot) + '\0' + draftId;
}

async function canonicalDeckPath(value) {
  try { return await realpath(value); }
  catch {
    const parent = await realpath(dirname(value)).catch(() => resolve(dirname(value)));
    return join(parent, basename(value));
  }
}

function publicEditing(item) {
  const path = item.binding.currentPath;
  return {
    kind:'editing',
    workId:item.workId,
    deckId:item.deckId,
    revision:item.revision,
    displayName:item.displayName,
    nameSource:item.nameSource,
    deckPath:path,
    deckName:basename(path),
    directory:dirname(path),
    modifiedAt:item.modifiedAt,
    lastOpenedAt:item.lastOpenedAt,
    provider:item.provider,
    progress:item.progress,
    projectRoot:item.projectRoot,
    runtimeState:item.runtimeState,
    binding:structuredClone(item.binding),
    dshBinding:structuredClone(item.dshBinding),
    lifecycle:item.lifecycle ?? (item.hiddenAt ? 'hidden' : 'active'),
    removal:structuredClone(item.removal ?? null),
    restoreOperation:structuredClone(item.restoreOperation ?? null),
  };
}

function publicCreation(item) {
  return {
    kind:'creation',
    workId:item.workId,
    deckId:item.deckId,
    revision:item.revision,
    displayName:item.displayName,
    nameSource:item.nameSource,
    title:item.displayName,
    briefTitle:item.briefTitle,
    taskId:item.draftId,
    draftId:item.draftId,
    projectRoot:item.projectRoot,
    projectName:item.projectName,
    provider:item.provider,
    phase:item.phase,
    progress:item.progress,
    updatedAt:item.updatedAt,
    lastOpenedAt:item.lastOpenedAt,
    locked:item.locked,
    runtimeState:item.runtimeState,
    dshBinding:structuredClone(item.dshBinding),
    lifecycle:item.lifecycle ?? (item.hiddenAt ? 'hidden' : 'active'),
    removal:structuredClone(item.removal ?? null),
    restoreOperation:structuredClone(item.restoreOperation ?? null),
  };
}

function publicWorkItem(item) {
  return item.kind === 'editing' ? publicEditing(item) : publicCreation(item);
}

function requireBindingRevision(current, expectedBindingRevision) {
  if (!Number.isInteger(expectedBindingRevision) || expectedBindingRevision < 0) {
    throw catalogError('INVALID_DSH_BINDING_REVISION', 400, 'DSH 关联修订号无效');
  }
  if (current.dshBinding.revision !== expectedBindingRevision) {
    throw catalogError('DSH_BINDING_REVISION_CONFLICT', 409, 'DSH 会话关联已更新，请刷新后重试', {
      bindingRevision:current.dshBinding.revision,
    });
  }
}

function locateVisibleWorkItem(state, workId) {
  const index = state.workItems.findIndex(item => item?.workId === workId && item.hiddenAt === null);
  if (index < 0) throw catalogError('WORK_ITEM_NOT_FOUND', 404, '工作项不存在或已隐藏');
  const current = state.workItems[index];
  if (!current.dshBinding) {
    throw catalogError('DSH_BINDING_MISSING', 500, '工作项缺少 DSH 会话关联状态');
  }
  return { index, current };
}

function locateDshSessionOwner(state, sessionId) {
  for (const item of state.workItems) {
    if (item?.dshBinding?.sessions?.some(link => link.sessionId === sessionId)) return item;
    if (item?.dshBinding?.pendingOperation?.sessionId === sessionId) return item;
  }
  return null;
}

export class WorkCatalog {
  constructor({
    filePath = join(resolveEditorStateRoot(), 'work-catalog.json'),
    legacyHistory = { async list() { return { version:1, creation:[], editing:[] }; } },
    randomUUID = systemRandomUUID,
    now = () => new Date(),
  } = {}) {
    if (typeof legacyHistory?.list !== 'function') {
      throw new TypeError('legacyHistory 必须提供 list()');
    }
    if (typeof randomUUID !== 'function') throw new TypeError('randomUUID 必须是函数');
    this.filePath = filePath === null ? null : resolve(filePath);
    this.memoryState = this.filePath === null ? emptyState() : null;
    this.legacyHistory = legacyHistory;
    this.randomUUID = randomUUID;
    this.now = now;
    this.operations = Promise.resolve();
    this.pendingList = null;
  }

  #enqueue(operation) {
    const result = this.operations.then(operation);
    this.operations = result.catch(() => {});
    return result;
  }

  async #read() {
    if (this.filePath === null) return structuredClone(this.memoryState);
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      const migrated = migrateState(parsed);
      if (migrated) {
        await this.#write(migrated);
        return migrated;
      }
      if (parsed?.version !== SCHEMA_VERSION || !Array.isArray(parsed.workItems)) {
        return emptyState();
      }
      return parsed;
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return emptyState();
      throw error;
    }
  }

  async #write(state) {
    if (this.filePath === null) {
      this.memoryState = structuredClone(state);
      return;
    }
    await mkdir(dirname(this.filePath), { recursive:true, mode:0o700 });
    const temporary = this.filePath + '.' + process.pid + '.' + systemRandomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', {
        encoding:'utf8',
        mode:0o600,
      });
      await rename(temporary, this.filePath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  #newIdentity(label) {
    return requireUuid(this.randomUUID(), label);
  }

  async #newEditing(entry) {
    const canonicalPath = await canonicalDeckPath(entry.deckPath);
    const exists = await stat(canonicalPath).then(value => value.isFile()).catch(() => false);
    const fileName = basename(canonicalPath);
    const trustedRoot = await realpath(entry.projectRoot ?? dirname(canonicalPath))
      .catch(() => resolve(entry.projectRoot ?? dirname(canonicalPath)));
    const workId = this.#newIdentity('workId');
    const deckId = this.#newIdentity('deckId');
    let binding = {
      revision:0,
      state:exists ? 'bound' : 'needs-rebind',
      reason:exists ? 'none' : 'missing',
      currentPath:canonicalPath,
      previousPath:null,
      trustedRoot,
    };
    if (exists) {
      const coordinator = await openDeckBinding({
        deckId,
        initialBinding:binding,
        storageRoot:dirname(this.filePath ?? canonicalPath),
        watch:false,
      });
      const captured = coordinator.snapshot();
      await coordinator.close();
      const { canPublish, deckId:ignoredDeckId, ...capturedBinding } = captured;
      void canPublish;
      void ignoredDeckId;
      binding = capturedBinding;
    }
    return {
      workId,
      deckId,
      kind:'editing',
      revision:0,
      displayName:normalizeDisplayName(fileName || '未命名 Deck'),
      nameSource:'auto',
      provider:entry.provider ?? 'codex',
      modifiedAt:entry.modifiedAt ?? this.now().toISOString(),
      lastOpenedAt:entry.lastOpenedAt ?? null,
      progress:entry.progress ?? '继续编辑',
      projectRoot:entry.projectRoot ?? null,
      runtimeState:entry.runtimeState,
      hiddenAt:null,
      binding,
      dshBinding:emptyDshBinding(),
    };
  }

  #newCreation(entry) {
    const briefTitle = normalizeDisplayName(entry.title || '未命名 Deck');
    return {
      workId:this.#newIdentity('workId'),
      deckId:null,
      kind:'creation',
      revision:0,
      displayName:briefTitle,
      briefTitle,
      nameSource:'auto',
      draftId:entry.draftId,
      projectRoot:resolve(entry.projectRoot),
      projectName:entry.projectName ?? basename(entry.projectRoot),
      provider:entry.provider ?? 'codex',
      phase:entry.phase,
      progress:entry.progress ?? '等待开始对话',
      updatedAt:entry.updatedAt ?? this.now().toISOString(),
      lastOpenedAt:entry.lastOpenedAt ?? null,
      locked:Boolean(entry.locked),
      runtimeState:entry.runtimeState,
      hiddenAt:null,
      dshBinding:emptyDshBinding(),
    };
  }

  async #refreshEditing(item) {
    const currentPath = item.binding.currentPath;
    const exists = await stat(currentPath).then(value => value.isFile()).catch(() => false);
    if (!item.binding.witness && !exists) {
      if (item.binding.state === 'needs-rebind' && item.binding.reason === 'missing') return item;
      return {
        ...item,
        revision:item.revision + 1,
        binding:{
          ...item.binding,
          revision:item.binding.revision + 1,
          state:'needs-rebind',
          reason:'missing',
        },
      };
    }
    const coordinator = await openDeckBinding({
      deckId:item.deckId,
      initialBinding:item.binding,
      storageRoot:dirname(this.filePath ?? currentPath),
      watch:false,
    });
    const refreshed = await coordinator.reconcile({ cause:'resume' });
    await coordinator.close();
    const { canPublish, deckId, ...nextBinding } = refreshed;
    void canPublish;
    void deckId;
    const nextDisplayName = item.nameSource === 'auto'
      ? basename(nextBinding.currentPath) : item.displayName;
    if (JSON.stringify(item.binding) === JSON.stringify(nextBinding)
      && item.displayName === nextDisplayName) return item;
    return {
      ...item,
      revision:item.revision + 1,
      displayName:nextDisplayName,
      binding:nextBinding,
    };
  }

  async #listUnlocked({ refreshBindings = true } = {}) {
    const [persisted, legacy] = await Promise.all([this.#read(), this.legacyHistory.list()]);
    const items = persisted.workItems.map(item => structuredClone(item));
    let changed = false;
    for (const item of items) {
      if (item?.kind !== 'editing' || typeof item.binding?.currentPath !== 'string') continue;
      const canonical = await canonicalDeckPath(item.binding.currentPath);
      const canonicalRoot = await realpath(item.binding.trustedRoot)
        .catch(() => resolve(item.binding.trustedRoot));
      if (canonical !== item.binding.currentPath) {
        item.binding.currentPath = canonical;
        changed = true;
      }
      if (canonicalRoot !== item.binding.trustedRoot) {
        item.binding.trustedRoot = canonicalRoot;
        changed = true;
      }
    }
    const editingByPath = new Map(
      items.filter(item => item?.kind === 'editing')
        .flatMap(item => [item.binding.currentPath, item.binding.previousPath]
          .filter(Boolean).map(path => [editingKey(path), item])),
    );
    const creationByDraft = new Map(
      items.filter(item => item?.kind === 'creation')
        .map(item => [creationKey(item.projectRoot, item.draftId), item]),
    );
    const liveCreationKeys = new Set();
    for (const entry of Array.isArray(legacy?.creation) ? legacy.creation : []) {
      if (typeof entry?.projectRoot !== 'string' || typeof entry?.draftId !== 'string') continue;
      const key = creationKey(entry.projectRoot, entry.draftId);
      liveCreationKeys.add(key);
      const existing = creationByDraft.get(key);
      if (!existing) {
        const item = this.#newCreation(entry);
        items.push(item);
        creationByDraft.set(key, item);
        changed = true;
        continue;
      }
      const briefTitle = normalizeDisplayName(entry.title || '未命名 Deck');
      const nextDisplayName = existing.nameSource === 'auto' ? briefTitle : existing.displayName;
      const next = {
        ...existing,
        revision:existing.revision
          + (existing.briefTitle !== briefTitle || existing.displayName !== nextDisplayName ? 1 : 0),
        displayName:nextDisplayName,
        briefTitle,
        projectName:entry.projectName ?? existing.projectName,
        provider:entry.provider ?? existing.provider,
        phase:entry.phase,
        progress:entry.progress ?? existing.progress,
        updatedAt:entry.updatedAt ?? existing.updatedAt,
        lastOpenedAt:entry.lastOpenedAt ?? existing.lastOpenedAt,
        locked:Boolean(entry.locked),
        runtimeState:entry.runtimeState,
      };
      if (JSON.stringify(next) !== JSON.stringify(existing)) {
        const index = items.indexOf(existing);
        items[index] = next;
        creationByDraft.set(key, next);
        changed = true;
      }
    }
    for (const item of items) {
      if (item?.kind !== 'creation'
        || liveCreationKeys.has(creationKey(item.projectRoot, item.draftId))) continue;
      if (item.locked || item.runtimeState !== undefined) {
        item.locked = false;
        delete item.runtimeState;
        changed = true;
      }
    }
    for (const entry of Array.isArray(legacy?.editing) ? legacy.editing : []) {
      if (!isDeckPath(entry?.deckPath)) continue;
      const canonicalLegacyPath = await canonicalDeckPath(entry.deckPath);
      const key = editingKey(canonicalLegacyPath);
      const existing = editingByPath.get(key);
      if (existing) {
        existing.provider = entry.provider ?? existing.provider;
        existing.modifiedAt = entry.modifiedAt ?? existing.modifiedAt;
        existing.lastOpenedAt = entry.lastOpenedAt ?? existing.lastOpenedAt;
        existing.progress = entry.progress ?? existing.progress;
        existing.projectRoot = entry.projectRoot ?? existing.projectRoot;
        existing.runtimeState = entry.runtimeState;
        continue;
      }
      const item = await this.#newEditing({ ...entry, deckPath:canonicalLegacyPath });
      items.push(item);
      editingByPath.set(editingKey(item.binding.currentPath), item);
      changed = true;
    }
    for (let index = 0; index < items.length; index += 1) {
      if (!refreshBindings || items[index]?.kind !== 'editing') continue;
      const refreshed = await this.#refreshEditing(items[index]);
      if (refreshed !== items[index]) {
        items[index] = refreshed;
        changed = true;
      }
    }
    if (changed || JSON.stringify(items) !== JSON.stringify(persisted.workItems)) {
      await this.#write({
        version:SCHEMA_VERSION,
        revision:persisted.revision + 1,
        workItems:items,
      });
    }
    return {
      version:SCHEMA_VERSION,
      revision:changed ? persisted.revision + 1 : persisted.revision,
      creation:items.filter(item => item.kind === 'creation' && item.hiddenAt === null)
        .map(publicCreation),
      editing:items.filter(item => item.kind === 'editing' && item.hiddenAt === null)
        .map(publicEditing),
    };
  }

  list() {
    if (this.pendingList?.tail === this.operations) {
      return this.pendingList.result.then(value => structuredClone(value));
    }
    const result = this.#enqueue(() => this.#listUnlocked());
    // 只合并同一队尾的在途读取。任何修改入队都会使旧读取失效，
    // 既避免界面通知重复扫描大 Deck，也保留修改后读取的串行顺序。
    const pending = { result, tail:this.operations };
    this.pendingList = pending;
    const clear = () => {
      if (this.pendingList === pending) this.pendingList = null;
    };
    void result.then(clear, clear);
    return result.then(value => structuredClone(value));
  }

  // 会话菜单只展示已登记的身份，不把展示快照当作文件可写性的证据。
  // 打开、重新绑定与固化仍走实时文件校验。
  listSessionTargets() {
    return this.#enqueue(() => this.#listUnlocked({ refreshBindings:false }));
  }

  reopenEditing({ deckPath }) {
    return this.#enqueue(async () => {
      if (!isDeckPath(deckPath)) {
        throw catalogError('INVALID_DECK_PATH', 400, 'Deck 文件路径必须指向 HTML');
      }
      const canonicalPath = await canonicalDeckPath(deckPath);
      const state = await this.#read();
      const index = state.workItems.findIndex(item => (
        item?.kind === 'editing'
        && [item.binding?.currentPath, item.binding?.previousPath]
          .filter(Boolean)
          .some(path => editingKey(path) === editingKey(canonicalPath))
      ));
      if (index < 0) return null;
      const current = state.workItems[index];
      if (['removing', 'restoring'].includes(current.lifecycle)) throw catalogError('PROJECT_REMOVING', 409, '项目正在移除，请先完成或重试移除');
      if (current.hiddenAt === null) return publicEditing(current);
      const next = {
        ...current,
        revision:current.revision + 1,
        hiddenAt:null,
        lifecycle:'active',
      };
      await this.#write({
        ...state,
        revision:state.revision + 1,
        workItems:state.workItems.map((item, candidate) => candidate === index ? next : item),
      });
      return publicEditing(next);
    });
  }

  rename({ workId, displayName, expectedRevision }) {
    return this.#enqueue(async () => {
      requireUuid(workId, 'workId');
      displayName = normalizeDisplayName(displayName);
      const state = await this.#read();
      const index = state.workItems.findIndex(item => item?.workId === workId);
      if (index < 0) throw catalogError('WORK_ITEM_NOT_FOUND', 404, '工作项不存在');
      const current = state.workItems[index];
      if (current.revision !== expectedRevision) {
        throw catalogError('WORK_ITEM_REVISION_CONFLICT', 409, '工作项已更新，请刷新后重试', {
          revision:current.revision,
        });
      }
      const next = {
        ...current,
        revision:current.revision + 1,
        displayName,
        nameSource:'custom',
      };
      const workItems = state.workItems.map((item, candidate) => (
        candidate === index ? next : item
      ));
      await this.#write({
        ...state,
        revision:state.revision + 1,
        workItems,
      });
      return next.kind === 'editing' ? publicEditing(next) : publicCreation(next);
    });
  }

  listRemoved() {
    return this.#enqueue(async () => (await this.#read()).workItems
      .filter(item => item.restoreOperation || ['removed', 'removing'].includes(item.lifecycle)).map(publicWorkItem));
  }

  beginRemoval({ workId, expectedRevision, ownsCreationLease = false }) {
    return this.#enqueue(async () => {
      const state = await this.#read();
      const current = state.workItems.find(item => item.workId === workId);
      if (!current) throw catalogError('WORK_ITEM_NOT_FOUND', 404, '项目不存在');
      if (current.lifecycle === 'removing' || current.lifecycle === 'removed') return publicWorkItem(current);
      if (current.revision !== expectedRevision) throw catalogError('WORK_ITEM_REVISION_CONFLICT', 409, '项目已更新，请刷新后重试');
      if (current.restoreOperation || current.dshBinding.pendingOperation || (current.locked && !ownsCreationLease)) throw catalogError('PROJECT_BUSY', 409, '项目有未完成的会话创建或编辑，请完成后再移除');
      const next = { ...current, revision:current.revision + 1, lifecycle:'removing', hiddenAt:this.now().toISOString(),
        removal:{ operationId:systemRandomUUID(), sessionIds:current.dshBinding.sessions.map(link => link.sessionId),
          changedSessionIds:[], workspaceId:current.dshBinding.workspaceId } };
      await this.#write({ ...state, revision:state.revision + 1, workItems:state.workItems.map(item => item === current ? next : item) });
      return publicWorkItem(next);
    });
  }

  completeRemoval({ workId, operationId, changedSessionIds }) {
    return this.#enqueue(async () => {
      const state = await this.#read();
      const current = state.workItems.find(item => item.workId === workId);
      if (!current || current.removal?.operationId !== operationId) throw catalogError('PROJECT_OPERATION_CONFLICT', 409, '项目移除操作已过期');
      if (current.lifecycle === 'removed') return publicWorkItem(current);
      if (current.lifecycle !== 'removing') throw catalogError('PROJECT_OPERATION_CONFLICT', 409, '项目不在移除状态');
      if (!Array.isArray(changedSessionIds) || changedSessionIds.some(id => !current.removal.sessionIds.includes(id))) throw catalogError('INVALID_DSH_SESSION_IDS', 400, '归档结果包含其他项目的会话');
      const next = { ...current, revision:current.revision + 1, lifecycle:'removed',
        removal:{ ...current.removal, changedSessionIds:[...new Set(changedSessionIds)] },
        dshBinding:{ ...current.dshBinding, revision:current.dshBinding.revision + 1, activeSessionId:null,
          sessions:current.dshBinding.sessions.map(link => ({ ...link, state:link.state === 'missing' ? 'missing' : 'archived' })) } };
      await this.#write({ ...state, revision:state.revision + 1, workItems:state.workItems.map(item => item === current ? next : item) });
      return publicWorkItem(next);
    });
  }

  cancelRemoval({ workId, operationId, expectedRevision }) {
    return this.#enqueue(async () => {
      const state = await this.#read();
      const current = state.workItems.find(item => item.workId === workId);
      if (!current || current.lifecycle !== 'removing' || current.removal?.operationId !== operationId || current.revision !== expectedRevision) throw catalogError('PROJECT_OPERATION_CONFLICT', 409, '项目移除操作已过期');
      const next = { ...current, revision:current.revision + 1, lifecycle:'active', hiddenAt:null, removal:null };
      await this.#write({ ...state, revision:state.revision + 1, workItems:state.workItems.map(item => item === current ? next : item) });
      return publicWorkItem(next);
    });
  }

  restoreProject({ workId, expectedRevision }) {
    return this.#enqueue(async () => {
      const state = await this.#read();
      const current = state.workItems.find(item => item.workId === workId);
      if (!current || current.lifecycle !== 'removed' || current.revision !== expectedRevision) throw catalogError('PROJECT_OPERATION_CONFLICT', 409, '项目状态已更新，请刷新后重试');
      const next = { ...current, revision:current.revision + 1, lifecycle:'active', hiddenAt:null };
      await this.#write({ ...state, revision:state.revision + 1, workItems:state.workItems.map(item => item === current ? next : item) });
      return publicWorkItem(next);
    });
  }

  dismiss({ workId, expectedRevision }) {
    return this.#enqueue(async () => {
      requireUuid(workId, 'workId');
      const state = await this.#read();
      const index = state.workItems.findIndex(item => item?.workId === workId);
      if (index < 0) throw catalogError('WORK_ITEM_NOT_FOUND', 404, '工作项不存在');
      const current = state.workItems[index];
      if (current.revision !== expectedRevision) {
        throw catalogError('WORK_ITEM_REVISION_CONFLICT', 409, '工作项已更新，请刷新后重试', {
          revision:current.revision,
        });
      }
      const next = {
        ...current,
        revision:current.revision + 1,
        hiddenAt:this.now().toISOString(),
      };
      await this.#write({
        ...state,
        revision:state.revision + 1,
        workItems:state.workItems.map((item, candidate) => candidate === index ? next : item),
      });
      return next.kind === 'editing' ? publicEditing(next) : publicCreation(next);
    });
  }

  updateEditingBinding({ workId, deckId, binding }) {
    return this.#enqueue(async () => {
      requireUuid(workId, 'workId');
      requireUuid(deckId, 'deckId');
      if (!binding || typeof binding !== 'object'
        || binding.deckId !== deckId
        || typeof binding.currentPath !== 'string'
        || typeof binding.trustedRoot !== 'string'
        || !binding.witness
        || typeof binding.sourceFingerprint !== 'string') {
        throw catalogError('INVALID_DECK_BINDING', 400, 'Deck 文件绑定格式无效');
      }
      const state = await this.#read();
      const index = state.workItems.findIndex(item => (
        item?.kind === 'editing' && item.workId === workId && item.deckId === deckId
      ));
      if (index < 0) throw catalogError('WORK_ITEM_NOT_FOUND', 404, '编辑工作项不存在');
      const current = state.workItems[index];
      const { canPublish, deckId:ignoredDeckId, ...storedBinding } = structuredClone(binding);
      void canPublish;
      void ignoredDeckId;
      if (JSON.stringify(current.binding) === JSON.stringify(storedBinding)) {
        return publicEditing(current);
      }
      const next = {
        ...current,
        revision:current.revision + 1,
        binding:storedBinding,
      };
      await this.#write({
        ...state,
        revision:state.revision + 1,
        workItems:state.workItems.map((item, candidate) => candidate === index ? next : item),
      });
      return publicEditing(next);
    });
  }

  rebindEditing({
    workId, candidatePath, confirmation, expectedBindingRevision,
  }) {
    return this.#enqueue(async () => {
      requireUuid(workId, 'workId');
      const state = await this.#read();
      const index = state.workItems.findIndex(item => (
        item?.kind === 'editing' && item.workId === workId && item.hiddenAt === null
      ));
      if (index < 0) throw catalogError('WORK_ITEM_NOT_FOUND', 404, '编辑工作项不存在');
      const current = state.workItems[index];
      const coordinator = await openDeckBinding({
        deckId:current.deckId,
        initialBinding:current.binding,
        storageRoot:dirname(this.filePath ?? current.binding.trustedRoot),
        watch:false,
      });
      let snapshot;
      try {
        const canonicalCandidate = await canonicalDeckPath(candidatePath);
        snapshot = await coordinator.rebind({
          candidatePath:canonicalCandidate,
          expectedBindingRevision,
          confirmation,
        });
      } finally {
        await coordinator.close();
      }
      const { canPublish, deckId, ...storedBinding } = snapshot;
      void canPublish;
      void deckId;
      const next = {
        ...current,
        revision:current.revision + 1,
        displayName:current.nameSource === 'auto'
          ? basename(storedBinding.currentPath) : current.displayName,
        binding:storedBinding,
      };
      await this.#write({
        ...state,
        revision:state.revision + 1,
        workItems:state.workItems.map((item, candidate) => candidate === index ? next : item),
      });
      return publicEditing(next);
    });
  }

  promoteCreationToEditing({
    workId, deckPath, deckId, binding, provider = null, projectRoot = null,
  }) {
    return this.#enqueue(async () => {
      requireUuid(workId, 'workId');
      requireUuid(deckId, 'deckId');
      if (!isDeckPath(deckPath)) {
        throw catalogError('INVALID_DECK_PATH', 400, 'Deck 文件路径必须指向 HTML');
      }
      if (!binding || typeof binding !== 'object'
        || binding.deckId !== deckId
        || typeof binding.currentPath !== 'string'
        || typeof binding.trustedRoot !== 'string'
        || !binding.witness
        || typeof binding.sourceFingerprint !== 'string') {
        throw catalogError('INVALID_DECK_BINDING', 400, 'Deck 文件绑定格式无效');
      }
      const state = await this.#read();
      const index = state.workItems.findIndex(item => item?.workId === workId);
      if (index < 0) throw catalogError('WORK_ITEM_NOT_FOUND', 404, '创建工作项不存在');
      const current = state.workItems[index];
      const canonicalPath = await canonicalDeckPath(deckPath);
      if (current.kind === 'editing') {
        if (current.deckId === deckId && current.binding.currentPath === canonicalPath) {
          return publicEditing(current);
        }
        throw catalogError(
          'WORK_ITEM_ALREADY_PROMOTED', 409,
          '工作项已经转换为另一个 Deck 编辑任务',
        );
      }
      if (current.kind !== 'creation' || current.hiddenAt !== null) {
        throw catalogError('WORK_ITEM_NOT_FOUND', 404, '创建工作项不存在或已隐藏');
      }
      const { canPublish, deckId:ignoredDeckId, ...storedBinding } = structuredClone(binding);
      void canPublish;
      void ignoredDeckId;
      storedBinding.currentPath = canonicalPath;
      const currentProjectRoot = await realpath(current.projectRoot)
        .catch(() => resolve(current.projectRoot));
      const nextProjectRoot = projectRoot === null
        ? current.projectRoot
        : await realpath(projectRoot).catch(() => resolve(projectRoot));
      const projectRootChanged = projectRoot !== null
        && nextProjectRoot !== currentProjectRoot;
      const dshBinding = projectRootChanged
        ? {
          revision:current.dshBinding.revision + 1,
          workspaceId:null,
          activeSessionId:null,
          sessions:current.dshBinding.sessions.map(link => (
            link.state === 'available' ? { ...link, state:'historical' } : link
          )),
          pendingOperation:null,
        }
        : structuredClone(current.dshBinding);
      const next = {
        workId:current.workId,
        deckId,
        kind:'editing',
        revision:current.revision + 1,
        displayName:current.nameSource === 'custom'
          ? current.displayName : basename(canonicalPath),
        nameSource:current.nameSource,
        provider:provider ?? current.provider,
        modifiedAt:this.now().toISOString(),
        lastOpenedAt:current.lastOpenedAt,
        progress:'继续编辑',
        projectRoot:nextProjectRoot,
        hiddenAt:null,
        binding:storedBinding,
        dshBinding,
      };
      await this.#write({
        ...state,
        revision:state.revision + 1,
        workItems:state.workItems.map((item, candidate) => candidate === index ? next : item),
      });
      return publicEditing(next);
    });
  }

  setDshWorkspace({ workId, workspaceId, expectedBindingRevision, repairRegistration = false }) {
    return this.#enqueue(async () => {
      requireUuid(workId, 'workId');
      requireOpaqueId(workspaceId, 'workspaceId');
      const state = await this.#read();
      const { index, current } = locateVisibleWorkItem(state, workId);
      if (current.dshBinding.workspaceId === workspaceId) return publicWorkItem(current);
      requireBindingRevision(current, expectedBindingRevision);
      const sessions = current.dshBinding.sessions.map(link => (
        link.workspaceId !== workspaceId && link.state === 'available'
          ? (repairRegistration ? { ...link, workspaceId } : { ...link, state:'historical' })
          : link
      ));
      const active = sessions.find(link => (
        link.sessionId === current.dshBinding.activeSessionId
        && link.workspaceId === workspaceId
        && link.state === 'available'
      ));
      const next = {
        ...current,
        revision:current.revision + 1,
        dshBinding:{
          revision:current.dshBinding.revision + 1,
          workspaceId,
          activeSessionId:active?.sessionId ?? null,
          sessions,
          pendingOperation:repairRegistration && current.dshBinding.pendingOperation ? { ...current.dshBinding.pendingOperation, workspaceId } : null,
        },
      };
      await this.#write({
        ...state,
        revision:state.revision + 1,
        workItems:state.workItems.map((item, candidate) => candidate === index ? next : item),
      });
      return publicWorkItem(next);
    });
  }

  beginDshSessionProvision({
    workId, operationId, workspaceId, sessionId, origin,
    sourceSessionId = null, expectedBindingRevision,
  }) {
    return this.#enqueue(async () => {
      requireUuid(workId, 'workId');
      requireUuid(operationId, 'operationId');
      requireOpaqueId(workspaceId, 'workspaceId');
      requireOpaqueId(sessionId, 'sessionId');
      requireDshOrigin(origin);
      if (sourceSessionId !== null) requireOpaqueId(sourceSessionId, 'sourceSessionId');
      const state = await this.#read();
      const { index, current } = locateVisibleWorkItem(state, workId);
      const pending = current.dshBinding.pendingOperation;
      if (pending?.operationId === operationId) {
        const sameOperation = pending.workspaceId === workspaceId
          && pending.sessionId === sessionId
          && pending.origin === origin
          && pending.sourceSessionId === sourceSessionId;
        if (!sameOperation) {
          throw catalogError('DSH_OPERATION_ID_CONFLICT', 409, 'DSH 操作标识已用于不同的会话创建请求');
        }
        return publicWorkItem(current);
      }
      requireBindingRevision(current, expectedBindingRevision);
      if (pending) {
        throw catalogError('DSH_OPERATION_IN_PROGRESS', 409, '该工作项已有待恢复的 DSH 会话创建操作', {
          operationId:pending.operationId,
        });
      }
      if (current.dshBinding.workspaceId !== null
        && current.dshBinding.workspaceId !== workspaceId) {
        throw catalogError('DSH_WORKSPACE_MISMATCH', 409, 'DSH Workspace 与工作项当前关联不一致');
      }
      const owner = locateDshSessionOwner(state, sessionId);
      if (owner) {
        throw catalogError('DSH_SESSION_ALREADY_LINKED', 409, '该 DSH 会话已经关联到工作项', {
          ownerWorkId:owner.workId,
        });
      }
      if (origin === 'fork') {
        const source = current.dshBinding.sessions.find(link => (
          link.sessionId === sourceSessionId && link.state === 'available'
        ));
        if (!source) {
          throw catalogError('DSH_FORK_SOURCE_NOT_LINKED', 409, '分叉源会话不是该工作项的可用关联会话');
        }
      }
      const next = {
        ...current,
        revision:current.revision + 1,
        dshBinding:{
          ...current.dshBinding,
          revision:current.dshBinding.revision + 1,
          workspaceId,
          pendingOperation:{
            operationId,
            workspaceId,
            sessionId,
            origin,
            sourceSessionId,
            startedAt:this.now().toISOString(),
          },
        },
      };
      await this.#write({
        ...state,
        revision:state.revision + 1,
        workItems:state.workItems.map((item, candidate) => candidate === index ? next : item),
      });
      return publicWorkItem(next);
    });
  }

  completeDshSessionProvision({ workId, operationId }) {
    return this.#enqueue(async () => {
      requireUuid(workId, 'workId');
      requireUuid(operationId, 'operationId');
      const state = await this.#read();
      const { index, current } = locateVisibleWorkItem(state, workId);
      const completed = current.dshBinding.sessions.find(link => link.operationId === operationId);
      if (completed) return publicWorkItem(current);
      const pending = current.dshBinding.pendingOperation;
      if (!pending || pending.operationId !== operationId) {
        throw catalogError('DSH_OPERATION_NOT_FOUND', 404, '没有找到待完成的 DSH 会话创建操作');
      }
      const owner = locateDshSessionOwner({
        ...state,
        workItems:state.workItems.filter(item => item.workId !== workId),
      }, pending.sessionId);
      if (owner) {
        throw catalogError('DSH_SESSION_ALREADY_LINKED', 409, '该 DSH 会话已经关联到其他工作项', {
          ownerWorkId:owner.workId,
        });
      }
      const link = {
        operationId:pending.operationId,
        sessionId:pending.sessionId,
        workspaceId:pending.workspaceId,
        origin:pending.origin,
        state:'available',
        createdAt:pending.startedAt,
      };
      const next = {
        ...current,
        revision:current.revision + 1,
        dshBinding:{
          ...current.dshBinding,
          revision:current.dshBinding.revision + 1,
          sessions:[...current.dshBinding.sessions, link],
          pendingOperation:null,
        },
      };
      await this.#write({
        ...state,
        revision:state.revision + 1,
        workItems:state.workItems.map((item, candidate) => candidate === index ? next : item),
      });
      return publicWorkItem(next);
    });
  }

  failDshSessionProvision({ workId, operationId, expectedBindingRevision }) {
    return this.#enqueue(async () => {
      requireUuid(workId, 'workId');
      requireUuid(operationId, 'operationId');
      const state = await this.#read();
      const { index, current } = locateVisibleWorkItem(state, workId);
      const pending = current.dshBinding.pendingOperation;
      if (!pending) return publicWorkItem(current);
      if (pending.operationId !== operationId) {
        throw catalogError('DSH_OPERATION_ID_CONFLICT', 409, '待处理的 DSH 会话创建操作与请求不一致');
      }
      requireBindingRevision(current, expectedBindingRevision);
      const next = {
        ...current,
        revision:current.revision + 1,
        dshBinding:{
          ...current.dshBinding,
          revision:current.dshBinding.revision + 1,
          pendingOperation:null,
        },
      };
      await this.#write({
        ...state,
        revision:state.revision + 1,
        workItems:state.workItems.map((item, candidate) => candidate === index ? next : item),
      });
      return publicWorkItem(next);
    });
  }

  activateDshSession({ workId, sessionId, expectedBindingRevision }) {
    return this.#enqueue(async () => {
      requireUuid(workId, 'workId');
      requireOpaqueId(sessionId, 'sessionId');
      const state = await this.#read();
      const { index, current } = locateVisibleWorkItem(state, workId);
      if (current.dshBinding.activeSessionId === sessionId) return publicWorkItem(current);
      requireBindingRevision(current, expectedBindingRevision);
      const link = current.dshBinding.sessions.find(candidate => (
        candidate.sessionId === sessionId
        && candidate.workspaceId === current.dshBinding.workspaceId
        && candidate.state === 'available'
      ));
      if (!link) {
        throw catalogError('DSH_SESSION_NOT_AVAILABLE', 409, '该 DSH 会话不是工作项当前 Workspace 的可用会话');
      }
      const next = {
        ...current,
        revision:current.revision + 1,
        dshBinding:{
          ...current.dshBinding,
          revision:current.dshBinding.revision + 1,
          activeSessionId:sessionId,
        },
      };
      await this.#write({
        ...state,
        revision:state.revision + 1,
        workItems:state.workItems.map((item, candidate) => candidate === index ? next : item),
      });
      return publicWorkItem(next);
    });
  }

  markDshSessionMissing({ workId, sessionId, expectedBindingRevision }) {
    return this.#enqueue(async () => {
      requireUuid(workId, 'workId');
      requireOpaqueId(sessionId, 'sessionId');
      const state = await this.#read();
      const { index, current } = locateVisibleWorkItem(state, workId);
      requireBindingRevision(current, expectedBindingRevision);
      const linkIndex = current.dshBinding.sessions.findIndex(link => link.sessionId === sessionId);
      if (linkIndex < 0) {
        throw catalogError('DSH_SESSION_NOT_LINKED', 404, '该 DSH 会话未关联到工作项');
      }
      if (current.dshBinding.sessions[linkIndex].state === 'missing') return publicWorkItem(current);
      const sessions = current.dshBinding.sessions.map((link, candidate) => (
        candidate === linkIndex ? { ...link, state:'missing' } : link
      ));
      const next = {
        ...current,
        revision:current.revision + 1,
        dshBinding:{
          ...current.dshBinding,
          revision:current.dshBinding.revision + 1,
          activeSessionId:current.dshBinding.activeSessionId === sessionId
            ? null : current.dshBinding.activeSessionId,
          sessions,
        },
      };
      await this.#write({
        ...state,
        revision:state.revision + 1,
        workItems:state.workItems.map((item, candidate) => candidate === index ? next : item),
      });
      return publicWorkItem(next);
    });
  }

  archiveDshSessions({ workId, sessionIds, expectedBindingRevision }) {
    return this.#enqueue(async () => {
      requireUuid(workId, 'workId');
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        throw catalogError('INVALID_DSH_SESSION_IDS', 400, '归档会话列表必须是非空数组');
      }
      const archivedIds = new Set(sessionIds.map(sessionId => (
        requireOpaqueId(sessionId, 'sessionId')
      )));
      const state = await this.#read();
      const { index, current } = locateVisibleWorkItem(state, workId);
      const hasChanges = current.dshBinding.sessions.some(link => (
        archivedIds.has(link.sessionId) && link.state === 'available'
      ));
      // DSH 的归档事件可能重复投递；已对齐时不能因旧 revision 反而报冲突。
      if (!hasChanges) return publicWorkItem(current);
      requireBindingRevision(current, expectedBindingRevision);
      const sessions = current.dshBinding.sessions.map(link => (
        archivedIds.has(link.sessionId) && link.state === 'available'
          ? { ...link, state:'archived' }
          : link
      ));
      const next = {
        ...current,
        revision:current.revision + 1,
        dshBinding:{
          ...current.dshBinding,
          revision:current.dshBinding.revision + 1,
          activeSessionId:archivedIds.has(current.dshBinding.activeSessionId)
            ? null : current.dshBinding.activeSessionId,
          sessions,
        },
      };
      await this.#write({
        ...state,
        revision:state.revision + 1,
        workItems:state.workItems.map((item, candidate) => candidate === index ? next : item),
      });
      return publicWorkItem(next);
    });
  }

  restoreDshSession({ workId, sessionId, workspaceId, expectedRevision }) {
    return this.#enqueue(async () => {
      const state = await this.#read();
      const current = state.workItems.find(item => item.workId === workId);
      if (current?.restoreOperation?.sessionId === sessionId) return publicWorkItem(current);
      if (!current || current.restoreOperation || current.lifecycle === 'removing' || current.revision !== expectedRevision) throw catalogError('PROJECT_OPERATION_CONFLICT', 409, '项目状态已更新，请刷新后重试');
      requireOpaqueId(workspaceId, 'workspaceId');
      if (!current.dshBinding.sessions.some(link => link.sessionId === sessionId)) throw catalogError('DSH_SESSION_NOT_LINKED', 404, '会话不属于此项目');
      const next = { ...current, revision:current.revision + 1, lifecycle:'restoring', hiddenAt:current.hiddenAt ?? this.now().toISOString(),
        restoreOperation:{ operationId:systemRandomUUID(), sessionId, workspaceId },
        dshBinding:{ ...current.dshBinding, revision:current.dshBinding.revision + 1, workspaceId, activeSessionId:sessionId,
          sessions:current.dshBinding.sessions.map(link => link.sessionId === sessionId ? { ...link, state:'available', workspaceId } : link) } };
      await this.#write({ ...state, revision:state.revision + 1, workItems:state.workItems.map(item => item === current ? next : item) });
      return publicWorkItem(next);
    });
  }

  completeDshRestore({ workId, operationId }) {
    return this.#enqueue(async () => {
      const state = await this.#read();
      const current = state.workItems.find(item => item.workId === workId);
      if (current?.lastRestoreOperationId === operationId) return publicWorkItem(current);
      if (!current || current.restoreOperation?.operationId !== operationId) throw catalogError('PROJECT_OPERATION_CONFLICT', 409, '恢复操作已过期');
      const next = { ...current, revision:current.revision + 1, lifecycle:'active', hiddenAt:null, restoreOperation:null, lastRestoreOperationId:operationId };
      await this.#write({ ...state, revision:state.revision + 1, workItems:state.workItems.map(item => item === current ? next : item) });
      return publicWorkItem(next);
    });
  }

  resolveByDshSession(sessionId, { includeRemoved = false } = {}) {
    return this.#enqueue(async () => {
      requireOpaqueId(sessionId, 'sessionId');
      const state = await this.#read();
      const owner = state.workItems.find(item => (
        (includeRemoved || item?.hiddenAt === null)
        && item.dshBinding?.sessions?.some(link => (
          link.sessionId === sessionId && (includeRemoved || link.state === 'available')
        ))
      ));
      return owner ? publicWorkItem(owner) : null;
    });
  }

  async resolve(workId) {
    requireUuid(workId, 'workId');
    return this.#enqueue(async () => {
      const history = await this.#listUnlocked({ refreshBindings:false });
      const item = [...history.creation, ...history.editing].find(entry => entry.workId === workId);
      if (!item) throw catalogError('WORK_ITEM_NOT_FOUND', 404, '工作项不存在或已隐藏');
      if (item.kind !== 'editing') return item;
      const state = await this.#read();
      const index = state.workItems.findIndex(entry => entry.workId === workId);
      const current = state.workItems[index];
      const refreshed = await this.#refreshEditing(current);
      if (refreshed !== current) {
        await this.#write({ ...state, revision:state.revision + 1,
          workItems:state.workItems.map((entry, candidate) => candidate === index ? refreshed : entry) });
      }
      return publicEditing(refreshed);
    });
  }
}

export function createWorkCatalog(options) {
  return new WorkCatalog(options);
}
