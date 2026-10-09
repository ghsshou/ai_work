import { isAbsolute, posix, win32 } from 'node:path';

import {
  createEmptyWorkspace,
  normalizeWorkspaceState,
  AGENT_PROVIDER_IDS,
} from './schema.mjs';

function storeError(code, statusCode, message, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

function sameState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isForeignAbsolutePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
    || /[\0\r\n]/.test(value)) return false;
  if (process.platform === 'win32') {
    // win32.isAbsolute('/Users/x') 为 true，但它只是当前盘根相对路径，不是
    // 可持久化的 Windows 绝对身份；这是从 macOS sidecar 迁入的典型形式。
    const nativeWindows = /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value);
    return posix.isAbsolute(value) && !nativeWindows;
  }
  return !isAbsolute(value) && win32.isAbsolute(value);
}

function repairForeignPersistedPaths(value, { projectRoot, projectRootSource }) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { value, repaired:false };
  }
  const candidate = structuredClone(value);
  let repaired = false;
  if (isForeignAbsolutePath(candidate.projectRoot)) {
    candidate.projectRoot = projectRoot;
    candidate.projectRootSource = projectRootSource;
    repaired = true;
  }
  if (candidate.providers && typeof candidate.providers === 'object') {
    for (const providerState of Object.values(candidate.providers)) {
      if (!Array.isArray(providerState?.conversations)) continue;
      for (const conversation of providerState.conversations) {
        if (isForeignAbsolutePath(conversation?.projectRoot)) {
          // 旧系统的会话路径不能在当前系统上安全授权，保留会话但清空路径。
          conversation.projectRoot = null;
          repaired = true;
        }
      }
    }
  }
  return { value:candidate, repaired };
}

function repairEmptyDshPlaceholder(value, enabled, activeProvider) {
  const legacy = value?.providers?.dsh;
  if (!enabled || value?.activeProvider !== 'dsh'
    || Object.keys(value.providers ?? {}).length !== 1
    || legacy === null || typeof legacy !== 'object' || Array.isArray(legacy)
    || Object.keys(legacy).sort().join(',') !== 'activeConversationId,conversations'
    || legacy.activeConversationId !== null
    || !Array.isArray(legacy.conversations) || legacy.conversations.length !== 0) {
    return { value, repaired:false };
  }
  // 旧嵌入模式的 dsh 只是空占位，不是可转成 Codex 的终端会话。
  // 含有历史或未知字段的记录继续拒绝；其余字段仍经完整 schema 校验。
  return { repaired:true, value:{ ...value, activeProvider,
    providers:Object.fromEntries(AGENT_PROVIDER_IDS.map(id => [id, {
      activeConversationId:null, conversations:[],
    }])),
  } };
}

export class AgentWorkspaceStore {
  static async open({
    deckSessionId,
    sidecarIO,
    initialState,
    projectRoot,
    projectRootSource = 'deck-directory',
    activeProvider = 'codex',
    dshAgentBridge = false,
    now = () => new Date().toISOString(),
  }) {
    if (!sidecarIO
      || typeof sidecarIO.readAgentWorkspace !== 'function'
      || typeof sidecarIO.writeAgentWorkspace !== 'function') {
      throw new TypeError('AgentWorkspaceStore 需要可信 sidecarIO');
    }

    const persisted = await sidecarIO.readAgentWorkspace({ missingOk:true });
    const repairedProvider = repairEmptyDshPlaceholder(persisted, dshAgentBridge, activeProvider);
    const repairedPersisted = repairForeignPersistedPaths(repairedProvider.value, {
      projectRoot,
      projectRootSource,
    });
    const candidate = normalizeWorkspaceState(repairedPersisted.value ?? initialState ?? createEmptyWorkspace({
      deckSessionId,
      projectRoot,
      projectRootSource,
      activeProvider,
      now,
    }));
    if (candidate.deckSessionId !== deckSessionId) {
      throw storeError(
        'WORKSPACE_SESSION_MISMATCH',
        409,
        'Agent 工作区与当前 Deck session 不匹配',
      );
    }

    const store = new AgentWorkspaceStore({
      deckSessionId,
      sidecarIO,
      state:candidate,
      now,
    });
    if (persisted === null || repairedPersisted.repaired || repairedProvider.repaired) {
      await store.#persistAndPublish(candidate, { publish:false });
    }
    return store;
  }

  constructor({ deckSessionId, sidecarIO, state, now }) {
    this.deckSessionId = deckSessionId;
    this.sidecarIO = sidecarIO;
    this.state = structuredClone(state);
    this.now = now;
    this.closed = false;
  }

  snapshot() {
    return structuredClone(this.state);
  }

  #assertOpen() {
    if (this.closed) {
      throw storeError('WORKSPACE_STORE_CLOSED', 409, 'Agent 工作区已关闭');
    }
  }

  #assertRevision(expectedWorkspaceRevision) {
    if (!Number.isSafeInteger(expectedWorkspaceRevision)
      || expectedWorkspaceRevision !== this.state.workspaceRevision) {
      throw storeError(
        'WORKSPACE_REVISION_CONFLICT',
        409,
        `Agent 工作区版本冲突：当前为 ${this.state.workspaceRevision}`,
        {
          expectedWorkspaceRevision,
          workspaceRevision:this.state.workspaceRevision,
        },
      );
    }
  }

  #candidateFrom(value) {
    const normalized = normalizeWorkspaceState({
      ...value,
      version:this.state.version,
      deckSessionId:this.deckSessionId,
      workspaceRevision:this.state.workspaceRevision + 1,
      createdAt:this.state.createdAt,
      updatedAt:this.now(),
    });
    return normalized;
  }

  async #persistAndPublish(candidate, { publish = true } = {}) {
    try {
      await this.sidecarIO.writeAgentWorkspace({
        sessionId:this.deckSessionId,
        bytes:Buffer.from(JSON.stringify(candidate), 'utf8'),
      });
    } catch (error) {
      if (error?.committed !== true || error?.commitScope !== 'agent-workspace') throw error;

      let durable = null;
      try {
        durable = normalizeWorkspaceState(
          await this.sidecarIO.readAgentWorkspace({ missingOk:false }),
        );
      } catch {
        // 下方统一返回恢复诊断；不能对未知提交状态盲目重写。
      }
      if (!durable || !sameState(durable, candidate)) {
        throw storeError(
          'WORKSPACE_RECOVERY_REQUIRED',
          503,
          'Agent 工作区写入结果未确认，需要重启编辑服务恢复',
          {
            committed:true,
            commitScope:'agent-workspace',
            stage:'agent-workspace-recovery',
            cause:error,
          },
        );
      }
    }
    if (publish) this.state = structuredClone(candidate);
    return this.snapshot();
  }

  async update(mutator, expectedWorkspaceRevision) {
    this.#assertOpen();
    this.#assertRevision(expectedWorkspaceRevision);
    if (typeof mutator !== 'function') throw new TypeError('mutator 必须是函数');

    const draft = this.snapshot();
    const returned = mutator(draft);
    if (returned && typeof returned.then === 'function') {
      throw new TypeError('AgentWorkspaceStore mutator 必须是同步纯函数');
    }
    const candidate = this.#candidateFrom(returned === undefined ? draft : returned);
    return this.#persistAndPublish(candidate);
  }

  async replace(value, expectedWorkspaceRevision) {
    this.#assertOpen();
    this.#assertRevision(expectedWorkspaceRevision);
    const candidate = this.#candidateFrom(structuredClone(value));
    return this.#persistAndPublish(candidate);
  }

  async close() {
    this.closed = true;
  }
}
