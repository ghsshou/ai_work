import { createHash, randomUUID as systemRandomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, parse } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateTask } from './protocol.mjs';
import { EditTimeline } from './edit-timeline.mjs';
import { localDurableIO } from './sidecar-io.mjs';
import { resolveProjectStateRoot } from './state-paths.mjs';

export class RevisionConflict extends Error {}

const sha256 = data => createHash('sha256').update(data).digest('hex');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
export const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MUTABLE_TASK_STATUSES = new Set(['pending', 'failed', 'needs-confirmation']);
const MAX_TASK_INSTRUCTION_LENGTH = 10_000;

function normalizeEditScope(state) {
  const valid = revision => Number.isSafeInteger(revision) && revision >= 0 && revision <= state.revision;
  const scope = state.editScope;
  if (!valid(scope?.contentRevision)) return {contentRevision:state.revision, taskRevisions:{}};
  return {
    contentRevision:scope.contentRevision,
    taskRevisions:Object.fromEntries((state.tasks ?? []).map(task => [task.id,
      valid(scope.taskRevisions?.[task.id]) ? scope.taskRevisions[task.id] : state.revision])),
  };
}

function portableDeckName(path) {
  return String(path ?? '').replaceAll('\\', '/').split('/').at(-1);
}

function isDeletableTask(task) {
  if (task.groupId) return false;
  return MUTABLE_TASK_STATUSES.has(task.status) || task.status === 'completed';
}

function snapshotError(code, statusCode, message) {
  return Object.assign(new Error(message), { code, statusCode });
}

const isCommittedSession = error => error?.committed === true
  && error?.commitScope === 'session';
const isCommittedSnapshot = error => error?.committed === true
  && error?.commitScope === 'snapshot';
const isCommittedAttachments = error => error?.committed === true
  && error?.commitScope === 'attachments';

function normalizePersistedTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)
    || Object.getPrototypeOf(task) !== Object.prototype) {
    return validateTask(task, { persisted:true });
  }
  if (typeof task.id !== 'string' || !UUID_V4.test(task.id)) {
    throw new TypeError('持久化任务 id 必须是规范 UUID v4');
  }
  const descriptor = Object.getOwnPropertyDescriptor(task, 'attachments');
  if ('attachments' in task && !descriptor) {
    return validateTask(task, { persisted:true });
  }
  const normalized = {
    ...task,
    attachments:descriptor ? descriptor.value : [],
  };
  return validateTask(normalized, { persisted:true });
}

function normalizePersistedTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).map(normalizePersistedTask);
}

function migrateCompletedTaskHistoryState(state) {
  let changed = false;
  for (const task of state.tasks ?? []) {
    if (task?.effectState !== 'compensated') continue;
    const primaryGroup = state.groups?.find(group => group?.taskId === task.id)
      ?? (task.entryIds ?? [])
        .map(entryId => state.groups?.find(group => group?.id === entryId))
        .find(group => group?.taskId === task.id);
    task.status = 'completed';
    task.effectState = 'undone';
    task.candidates = [];
    if (primaryGroup?.id) task.groupId = primaryGroup.id;
    changed = true;
  }
  return changed;
}

const AGENT_BATCH_OUTCOMES = new Set(['succeeded', 'partial', 'failed', 'cancelled']);

function normalizePersistedAgentBatches(values) {
  const batches = Array.isArray(values) ? values : [];
  const ids = new Set();
  const ordinals = new Set();
  return batches.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || !UUID_V4.test(value.id)
      || !Number.isSafeInteger(value.ordinal) || value.ordinal < 1
      || typeof value.provider !== 'string' || !value.provider
      || typeof value.mode !== 'string' || !value.mode
      || !Array.isArray(value.taskIds) || value.taskIds.length === 0
      || value.taskIds.some(id => !UUID_V4.test(id))
      || new Set(value.taskIds).size !== value.taskIds.length
      || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
      throw new TypeError('持久化 Agent 执行批次格式无效');
    }
    if (ids.has(value.id) || ordinals.has(value.ordinal)) {
      throw new TypeError('持久化 Agent 执行批次标识或序号重复');
    }
    ids.add(value.id);
    ordinals.add(value.ordinal);
    let settlement = null;
    if (value.settlement !== undefined && value.settlement !== null) {
      const candidate = value.settlement;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
        || Object.getPrototypeOf(candidate) !== Object.prototype
        || !AGENT_BATCH_OUTCOMES.has(candidate.outcome)
        || typeof candidate.settledAt !== 'string'
        || Number.isNaN(Date.parse(candidate.settledAt))
        || (candidate.code !== undefined && typeof candidate.code !== 'string')
        || (candidate.message !== undefined && typeof candidate.message !== 'string')) {
        throw new TypeError('持久化 Agent 执行批次结算格式无效');
      }
      settlement = structuredClone(candidate);
    }
    return {
      id:value.id,
      ordinal:value.ordinal,
      provider:value.provider,
      mode:value.mode,
      taskIds:[...value.taskIds],
      expectedRevision:Number.isSafeInteger(value.expectedRevision)
        ? value.expectedRevision : 0,
      createdAt:value.createdAt,
      settlement,
    };
  });
}

function normalizePersistedSourceEdit(value) {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || ((value.commandId !== undefined || value.requestDigest !== undefined)
      && (!UUID_V4.test(value.commandId) || !FINGERPRINT.test(value.requestDigest)))
    || Object.keys(value).some(key => ![
      'id', 'taskId', 'beforeFingerprint', 'startedAt', 'commandId', 'requestDigest',
    ].includes(key))
    || !UUID_V4.test(value.id)
    || (value.taskId !== null && !UUID_V4.test(value.taskId))
    || !FINGERPRINT.test(value.beforeFingerprint)
    || typeof value.startedAt !== 'string'
    || Number.isNaN(Date.parse(value.startedAt))) {
    throw new TypeError('持久化源码事务格式无效');
  }
  return structuredClone(value);
}

function compensatedSnapshotError(error) {
  return Object.assign(new Error(error?.message ?? 'snapshot 持久化失败'), {
    code:typeof error?.code === 'string' && error.code.startsWith('SNAPSHOT_')
      ? error.code : 'SNAPSHOT_WRITE_FAILED',
    statusCode:Number.isInteger(error?.statusCode) ? error.statusCode : 500,
    stage:error?.stage ?? 'snapshot-write',
    committed:false,
    commitScope:'snapshot',
    compensated:true,
    cause:error,
  });
}

function snapshotRecoveryError(writeError, compensationError) {
  return Object.assign(new Error('snapshot 已发布但补偿删除失败，需要重启服务恢复'), {
    code:'SNAPSHOT_RECOVERY_REQUIRED',
    statusCode:503,
    stage:'snapshot-compensation',
    committed:false,
    commitScope:'snapshot',
    sessionCandidateCommitted:false,
    cause:compensationError,
    writeError,
  });
}

function compensatedAttachmentError(error) {
  return Object.assign(new Error(error?.message ?? '附件发布失败'), {
    code:typeof error?.code === 'string' ? error.code : 'ATTACHMENT_PUBLISH_FAILED',
    statusCode:Number.isInteger(error?.statusCode) ? error.statusCode : 500,
    stage:error?.stage ?? 'attachment-publish',
    committed:false,
    commitScope:'attachments',
    compensated:true,
    cause:error,
  });
}

function attachmentRecoveryError(originalError, compensationError, details = {}) {
  return Object.assign(new Error('附件已发布但补偿删除失败，需要重启服务恢复'), {
    code:'ATTACHMENT_RECOVERY_REQUIRED',
    statusCode:503,
    stage:'attachment-compensation',
    committed:false,
    commitScope:'attachment',
    sessionCandidateCommitted:false,
    cause:compensationError,
    originalError,
    ...details,
  });
}

function committedCompensationError(originalError, compensationError, details = {}) {
  return Object.assign(new Error(compensationError?.message ?? '资源补偿结果未确认'),
    compensationError, {
      code:compensationError?.code ?? 'RESOURCE_RECOVERY_REQUIRED',
      statusCode:Number.isInteger(compensationError?.statusCode)
        ? compensationError.statusCode : 503,
      stage:compensationError?.stage ?? 'resource-compensation',
      committed:true,
      commitScope:compensationError?.commitScope ?? 'attachment',
      cause:originalError,
      compensationError,
      sessionCandidateCommitted:false,
      ...details,
    });
}

function decodeSnapshot(snapshot) {
  if (snapshot === undefined || snapshot === null) return null;
  let bytes;
  if (Buffer.isBuffer(snapshot)) {
    bytes = Buffer.from(snapshot);
  } else if (typeof snapshot === 'string') {
    const match = snapshot.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || match[1].length % 4 !== 0) {
      throw snapshotError('INVALID_SNAPSHOT', 400, 'snapshot 不是有效的 PNG base64');
    }
    bytes = Buffer.from(match[1], 'base64');
    if (bytes.toString('base64') !== match[1]) {
      throw snapshotError('INVALID_SNAPSHOT', 400, 'snapshot 不是规范 base64');
    }
  } else {
    throw snapshotError('INVALID_SNAPSHOT', 400, 'snapshot 必须为 PNG Buffer、data URL 或 null');
  }
  if (bytes.length < PNG_SIGNATURE.length
    || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw snapshotError('INVALID_SNAPSHOT', 400, 'snapshot 缺少有效 PNG 签名');
  }
  if (bytes.length > MAX_SNAPSHOT_BYTES) {
    throw snapshotError('SNAPSHOT_TOO_LARGE', 413, `snapshot 不得超过 ${MAX_SNAPSHOT_BYTES} 字节`);
  }
  return bytes;
}

export class SessionStore {
  static async open({
    deckPath,
    rootDir = resolveProjectStateRoot(dirname(deckPath)),
    sessionDir: selectedSessionDir,
    sidecarGuard = async () => {},
    sidecarIO = localDurableIO,
    directoriesPrepared = false,
    deckFingerprint: selectedDeckFingerprint,
    sessionId: selectedSessionId,
    persistedState,
    randomUUID: taskIdFactory = systemRandomUUID,
  }) {
    await sidecarGuard();
    const deckFingerprint = selectedDeckFingerprint ?? sha256(await readFile(deckPath));
    const sessionDir = selectedSessionDir
      ?? join(rootDir, `${parse(deckPath).name}-${deckFingerprint.slice(0, 8)}`);
    if (!directoriesPrepared) {
      await sidecarGuard();
      await mkdir(join(sessionDir, 'snapshots'), { recursive: true });
      await mkdir(join(sessionDir, 'backups'), { recursive: true });
    }

    let persisted = persistedState;
    if (persisted === undefined) {
      try {
        persisted = JSON.parse((await readFile(join(sessionDir, 'session.json'))).toString('utf8'));
      } catch {
        persisted = null;
      }
    }
    const sessionId = selectedSessionId ?? persisted?.sessionId ?? systemRandomUUID();
    const store = new SessionStore(
      deckPath, deckFingerprint, sessionDir, sidecarGuard, sidecarIO, sessionId, taskIdFactory,
    );
    const applyPersisted = persisted => {
      if (persisted.sessionId !== undefined && persisted.sessionId !== sessionId) {
        throw new Error('session.json 的 sessionId 与 registry 不一致');
      }
      if (persisted.deckPath !== undefined
        && portableDeckName(persisted.deckPath) !== portableDeckName(deckPath)) {
        throw new Error('session.json 的 deckPath 与当前 Deck 不一致');
      }
      store.state = {
        ...store.state,
        ...persisted,
        // 旧会话缺少分域版本，迁移时保守地以当前版本作为内容边界。
        editScope:normalizeEditScope({...persisted, revision:persisted.revision ?? 0}),
        deckPath,
        sessionId,
        tasks:normalizePersistedTasks(persisted.tasks),
        groups:Array.isArray(persisted.groups) ? persisted.groups : [],
        redo:Array.isArray(persisted.redo) ? persisted.redo : [],
        solidifiedActions:Array.isArray(persisted.solidifiedActions)
          ? persisted.solidifiedActions : [],
        diagnosticsBaseline:persisted.diagnosticsBaseline ?? {},
        diagnosticsCurrent:persisted.diagnosticsCurrent ?? {},
        conflict:persisted.conflict ?? null,
        agentConnection:persisted.agentConnection ?? null,
        agentBatches:normalizePersistedAgentBatches(persisted.agentBatches),
        sourceEdit:normalizePersistedSourceEdit(persisted.sourceEdit),
      };
      EditTimeline.open(store.state);
      return migrateCompletedTaskHistoryState(store.state);
    };
    await sidecarGuard();
    if (persisted === null) await store.#persist();
    else if (applyPersisted(persisted)) await store.persistState(store.state);
    return store;
  }

  constructor(
    deckPath,
    deckFingerprint,
    sessionDir,
    sidecarGuard = async () => {},
    sidecarIO = localDurableIO,
    sessionId = systemRandomUUID(),
    taskIdFactory = systemRandomUUID,
  ) {
    if (typeof taskIdFactory !== 'function') throw new TypeError('taskId 随机数生成器必须是函数');
    this.deckPath = deckPath;
    this.sessionDir = sessionDir;
    this.sessionPath = join(sessionDir, 'session.json');
    this.sidecarGuard = sidecarGuard;
    this.sidecarIO = sidecarIO;
    this.taskIdFactory = taskIdFactory;
    this.state = {
      version: 2,
      sessionId,
      deckPath,
      deckFingerprint,
      revision: 0,
      editScope:{contentRevision:0, taskRevisions:{}},
      tasks: [],
      groups: [],
      redo: [],
      timeline:{ cursor:0, entries:[] },
      checkpoints:[],
      historyArchives:[],
      completedCommands:{},
      solidifiedActions: [],
      diagnosticsBaseline: {},
      diagnosticsCurrent: {},
      diagnosticsRevision: null,
      conflict: null,
      agentConnection: null,
      agentBatches: [],
    };
  }

  #expect(revision) {
    if (revision !== this.state.revision) {
      throw new RevisionConflict(`版本号 ${revision} 与当前版本 ${this.state.revision} 不一致`);
    }
  }

  async #persist(state = this.state) {
    const persistedState = {
      ...state,
      tasks:normalizePersistedTasks(state.tasks),
      agentBatches:normalizePersistedAgentBatches(state.agentBatches),
    };
    await this.sidecarGuard();
    if (typeof this.sidecarIO.writeSession === 'function') {
      await this.sidecarIO.writeSession({
        sessionId:persistedState.sessionId,
        bytes:Buffer.from(JSON.stringify(persistedState, null, 2)),
      });
      return;
    }
    await this.sidecarIO.atomicWrite({
      directory:dirname(this.sessionPath),
      name:basename(this.sessionPath),
      bytes:Buffer.from(JSON.stringify(persistedState, null, 2)),
      commitScope:'session',
    });
  }

  #publish(state) {
    const candidate = structuredClone(state);
    for (const key of Object.keys(this.state)) {
      if (!(key in candidate)) delete this.state[key];
    }
    Object.assign(this.state, candidate);
    return this.state;
  }

  async persistState(state = this.state, { taskMetadataOnly=false } = {}) {
    const candidate = structuredClone(state);
    candidate.tasks = normalizePersistedTasks(candidate.tasks);
    candidate.agentBatches = normalizePersistedAgentBatches(candidate.agentBatches);
    EditTimeline.open(candidate);
    const sourceEdit = normalizePersistedSourceEdit(candidate.sourceEdit);
    if (sourceEdit) candidate.sourceEdit = sourceEdit;
    else delete candidate.sourceEdit;
    // 仅任务增删改可以沿用内容边界；其他持久化默认关闭旧编辑窗口。
    // 不让调用方自行声明“内容未变”，同时保留每个任务的独立变更边界。
    const previous = this.state;
    const scope = previous.editScope;
    const withoutTasks = value => Object.fromEntries(Object.entries(value)
      .filter(([key, item]) => !['tasks', 'revision', 'editScope'].includes(key) && item !== undefined));
    const metadataOnly = taskMetadataOnly && isDeepStrictEqual(withoutTasks(previous), withoutTasks(state));
    const previousTasks = new Map((previous.tasks ?? []).map(task => [task.id, task]));
    candidate.editScope = {
      contentRevision:metadataOnly ? scope?.contentRevision ?? previous.revision : candidate.revision,
      taskRevisions:Object.fromEntries(candidate.tasks.map(task => [task.id,
        isDeepStrictEqual(previousTasks.get(task.id), task)
          ? scope?.taskRevisions?.[task.id] ?? previous.revision : candidate.revision])),
    };
    try {
      await this.#persist(candidate);
    } catch (error) {
      if (isCommittedSession(error)) this.#publish(candidate);
      throw error;
    }
    return this.#publish(candidate);
  }

  async createTask(input, expectedRevision, { attachmentsLifecycle=null } = {}) {
    this.#expect(expectedRevision);
    const id = this.taskIdFactory();
    if (typeof id !== 'string' || !UUID_V4.test(id)) {
      throw Object.assign(new Error('taskId 必须是规范 UUID v4'), {
        code:'INVALID_TASK_ID', statusCode:500, stage:'task-id', committed:false,
      });
    }
    if (this.state.tasks.some(task => task?.id === id)) {
      throw Object.assign(new Error('生成的 taskId 与现有任务重复'), {
        code:'TASK_ID_COLLISION', statusCode:500, stage:'task-id', committed:false,
      });
    }
    const snapshotBytes = decodeSnapshot(input.snapshot);
    if (attachmentsLifecycle !== null
      && (typeof attachmentsLifecycle !== 'object'
        || typeof attachmentsLifecycle.publish !== 'function')) {
      throw new TypeError('attachmentsLifecycle 必须提供 publish(taskId)');
    }
    const now = new Date().toISOString();
    const snapshotPath = snapshotBytes ? `snapshots/${id}.png` : null;
    const snapshotsDirectory = join(this.sessionDir, 'snapshots');
    const snapshotName = snapshotBytes ? `${id}.png` : null;
    const cleanupSnapshot = () => {
      if (!snapshotName) return Promise.resolve();
      return typeof this.sidecarIO.deleteSnapshot === 'function'
        ? this.sidecarIO.deleteSnapshot({ snapshotId:id })
        : this.sidecarIO.unlink({
          directory:snapshotsDirectory, name:snapshotName, missingOk:true,
        });
    };
    const cleanupAttachments = async () => {
      if (typeof attachmentsLifecycle?.deleteTask === 'function') {
        await attachmentsLifecycle.deleteTask(id);
        return;
      }
      if (typeof this.sidecarIO.deleteTaskAttachments === 'function') {
        await this.sidecarIO.deleteTaskAttachments({ taskId:id });
        return;
      }
      throw Object.assign(new Error('缺少已发布附件补偿接口'), {
        code:'ATTACHMENT_DELETE_UNAVAILABLE', committed:false,
        commitScope:'attachments', stage:'attachment-compensation',
      });
    };
    let attachmentsPublished = false;
    let snapshotPublished = false;
    let snapshotWriteAttempted = false;
    try {
      let attachments = [];
      if (attachmentsLifecycle) {
        try {
          attachments = await attachmentsLifecycle.publish(id);
          attachmentsPublished = true;
        } catch (error) {
          if (isCommittedAttachments(error) || attachmentsLifecycle.published === true) {
            attachmentsPublished = true;
          }
          throw error;
        }
      }
      if (snapshotBytes) {
        snapshotWriteAttempted = true;
        await this.sidecarGuard();
        if (typeof this.sidecarIO.writeSnapshot === 'function') {
          await this.sidecarIO.writeSnapshot({ snapshotId:id, bytes:snapshotBytes });
        } else {
          await this.sidecarIO.atomicWrite({
            directory:snapshotsDirectory,
            name:snapshotName,
            bytes:snapshotBytes,
            commitScope:'snapshot',
          });
        }
        snapshotPublished = true;
      }
      const {
        snapshot: _snapshot,
        snapshotPath: _snapshotPath,
        attachments: _attachments,
        ...taskInput
      } = input;
      const task = validateTask({
        ...taskInput,
        id,
        status:'pending',
        candidates:input.candidates ?? [],
        snapshotPath,
        attachments,
        createdAt:now,
        updatedAt:now,
      }, { persisted:true });
      const candidate = structuredClone(this.state);
      candidate.tasks.push(task);
      candidate.revision += 1;
      await this.persistState(candidate, {taskMetadataOnly:true});
      return { task, revision: this.state.revision };
    } catch (error) {
      if (isCommittedSession(error)) throw error;
      if (isCommittedSnapshot(error)) snapshotPublished = true;
      if (isCommittedAttachments(error) || attachmentsLifecycle?.published === true) {
        attachmentsPublished = true;
      }
      let snapshotCleanupError;
      let attachmentCleanupError;
      if (snapshotPublished) {
        try { await cleanupSnapshot(); }
        catch (cleanupError) { snapshotCleanupError = cleanupError; }
      } else if (snapshotWriteAttempted) {
        try { await cleanupSnapshot(); }
        catch (cleanupError) {
          if (cleanupError?.committed === true) snapshotCleanupError = cleanupError;
        }
      }
      if (attachmentsPublished) {
        try { await cleanupAttachments(); }
        catch (cleanupError) { attachmentCleanupError = cleanupError; }
      }
      const committedCleanupError = [snapshotCleanupError, attachmentCleanupError]
        .find(cleanupError => cleanupError?.committed === true);
      if (committedCleanupError) {
        throw committedCompensationError(error, committedCleanupError, {
          ...(snapshotCleanupError ? { snapshotCleanupError } : {}),
          ...(attachmentCleanupError ? { attachmentCleanupError } : {}),
        });
      }
      if (attachmentCleanupError) {
        throw attachmentRecoveryError(error, attachmentCleanupError, {
          ...(snapshotCleanupError ? { snapshotCleanupError } : {}),
        });
      }
      if (snapshotCleanupError) throw snapshotRecoveryError(error, snapshotCleanupError);
      if (isCommittedSnapshot(error)) throw compensatedSnapshotError(error);
      if (isCommittedAttachments(error)) throw compensatedAttachmentError(error);
      throw error;
    }
  }

  async updateTask(taskId, instruction, expectedRevision) {
    this.#expect(expectedRevision);
    const normalizedInstruction = typeof instruction === 'string' ? instruction.trim() : '';
    if (!normalizedInstruction) {
      throw snapshotError('INVALID_TASK_INSTRUCTION', 400, '修改说明不能为空');
    }
    if (normalizedInstruction.length > MAX_TASK_INSTRUCTION_LENGTH) {
      throw snapshotError(
        'TASK_INSTRUCTION_TOO_LONG', 413,
        `修改说明不得超过 ${MAX_TASK_INSTRUCTION_LENGTH} 个字符`,
      );
    }
    const candidate = structuredClone(this.state);
    const task = candidate.tasks.find(item => item.id === taskId);
    if (!task) throw snapshotError('TASK_NOT_FOUND', 404, '找不到任务');
    if (task.targetMissing === true) {
      throw snapshotError(
        'TASK_TARGET_MISSING', 409,
        '任务原目标当前不可定位；请撤销相关结构修改或删除该任务后重新标记',
      );
    }
    if (!MUTABLE_TASK_STATUSES.has(task.status) || task.groupId) {
      throw snapshotError('TASK_LOCKED', 409, '处理中或已完成的任务不能编辑');
    }
    task.instruction = normalizedInstruction;
    task.status = 'pending';
    task.candidates = [];
    task.updatedAt = new Date().toISOString();
    candidate.revision += 1;
    await this.persistState(candidate, {taskMetadataOnly:true});
    return {
      task:structuredClone(this.state.tasks.find(item => item.id === taskId)),
      revision:this.state.revision,
    };
  }

  async deleteTask(taskId, expectedRevision) {
    this.#expect(expectedRevision);
    const candidate = structuredClone(this.state);
    const taskIndex = candidate.tasks.findIndex(item => item.id === taskId);
    if (taskIndex < 0) throw snapshotError('TASK_NOT_FOUND', 404, '找不到任务');
    const [task] = candidate.tasks.splice(taskIndex, 1);
    if (!isDeletableTask(task)) {
      throw snapshotError('TASK_LOCKED', 409, '处理中或仍可撤销的已完成任务不能删除；请先撤销或固化修改');
    }
    candidate.revision += 1;
    await this.persistState(candidate, {taskMetadataOnly:true});

    // session.json 是权威状态。先持久化删除，再清理旁路资源；清理失败只会留下孤儿文件，
    // 不会让已删除任务重新出现或让存量任务引用缺失文件。
    const cleanupErrors = [];
    try {
      await this.sidecarGuard();
      if (task.snapshotPath) {
        if (typeof this.sidecarIO.deleteSnapshot === 'function') {
          await this.sidecarIO.deleteSnapshot({ snapshotId:task.id });
        } else {
          await this.sidecarIO.unlink({
            directory:join(this.sessionDir, 'snapshots'),
            name:`${task.id}.png`,
            missingOk:true,
          });
        }
      }
      if (Array.isArray(task.attachments) && task.attachments.length > 0) {
        if (typeof this.sidecarIO.deleteTaskAttachments !== 'function') {
          throw new Error('缺少任务附件清理接口');
        }
        await this.sidecarIO.deleteTaskAttachments({ taskId:task.id });
      }
    } catch (error) { cleanupErrors.push(error); }
    return {
      taskId:task.id,
      revision:this.state.revision,
      cleanupPending:cleanupErrors.length > 0,
    };
  }
}
