function coordinatorError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function freshUuid() {
  const value = globalThis.crypto?.randomUUID?.();
  if (!value) throw coordinatorError('UUID_UNAVAILABLE', '当前浏览器不能生成可靠的任务标识');
  return value;
}

function requireWorkItem(workItem) {
  if (!workItem?.workId || !workItem?.projectRoot || !workItem?.dshBinding) {
    throw coordinatorError('INVALID_WORK_ITEM', '工作项缺少 DSH 关联所需的身份或项目目录');
  }
  return workItem;
}

function truncateUtf8(value, maxBytes) {
  const encoder = new TextEncoder();
  let result = '';
  let used = 0;
  for (const character of value) {
    const bytes = encoder.encode(character).byteLength;
    if (used + bytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}

function sessionTitleFor(workItem, sessionId = null) {
  const prefix = `${workItem.kind === 'creation' ? '创建 Deck' : '修改 Deck'}：`;
  const displayName = typeof workItem.displayName === 'string'
    ? workItem.displayName.replace(/\s+/gu, ' ').trim()
    : '';
  const links = workItem.dshBinding.sessions.filter(link => (
    link.state === 'available'
    && link.workspaceId === workItem.dshBinding.workspaceId
  ));
  const linkedIndex = sessionId === null
    ? -1
    : links.findIndex(link => link.sessionId === sessionId);
  const ordinal = linkedIndex >= 0 ? linkedIndex + 1 : links.length + 1;
  const suffix = ordinal > 1 ? ` · 会话 ${ordinal}` : '';
  const encoder = new TextEncoder();
  const nameBudget = Math.max(0, 80
    - encoder.encode(prefix).byteLength
    - encoder.encode(suffix).byteLength);
  return `${prefix}${truncateUtf8(displayName || '未命名 Deck', nameBudget)}${suffix}`;
}

/**
 * 协调 WorkCatalog 的持久关系与 DSH 原生 Workspace/Session 副作用。
 * UI 只提交明确 workId；目录复用、pending 恢复和活动会话切换都封装在这里。
 */
export class DeckTaskCoordinator {
  constructor({ bridge, catalogCommand } = {}) {
    if (!bridge?.request) throw new TypeError('DeckTaskCoordinator 缺少 DSH Bridge');
    if (typeof catalogCommand !== 'function') throw new TypeError('DeckTaskCoordinator 缺少 WorkCatalog 命令入口');
    this.bridge = bridge;
    this.catalogCommand = catalogCommand;
  }

  async #ensureWorkspace(workItem) {
    const workspace = await this.bridge.request('ensure-workspace', { path:workItem.projectRoot });
    if (!workspace?.workspaceId) {
      throw coordinatorError('DSH_WORKSPACE_INVALID', 'DSH 没有返回有效 Workspace');
    }
    if (workItem.dshBinding.workspaceId === workspace.workspaceId) {
      return { workItem, workspace };
    }
    const result = await this.catalogCommand('set-workspace', {
      workId:workItem.workId,
      workspaceId:workspace.workspaceId,
      repairRegistration:true,
      expectedBindingRevision:workItem.dshBinding.revision,
    });
    return { workItem:result.workItem, workspace };
  }

  async #recoverPending(workItem) {
    const pending = workItem.dshBinding.pendingOperation;
    if (!pending) return null;
    if (pending.origin === 'fork') {
      throw coordinatorError(
        'DSH_FORK_RECOVERY_REQUIRED',
        '分叉会话创建尚未完成，请在会话菜单中重试',
        { operationId:pending.operationId },
      );
    }
    if (pending.origin === 'fresh') {
      await this.bridge.request('create-session', {
        workspaceId:pending.workspaceId,
        sessionId:pending.sessionId,
        title:sessionTitleFor(workItem, pending.sessionId),
      });
    } else {
      const rows = await this.bridge.request('describe-sessions', {
        sessionIds:[pending.sessionId],
      });
      if (!rows?.[0]) throw coordinatorError('DSH_SESSION_MISSING', '待关联的 DSH 会话不存在');
    }
    const completed = await this.catalogCommand('complete-session', {
      workId:workItem.workId,
      operationId:pending.operationId,
    });
    await this.bridge.request('open-session', { sessionId:pending.sessionId });
    const activated = await this.catalogCommand('activate-session', {
      workId:workItem.workId,
      sessionId:pending.sessionId,
      expectedBindingRevision:completed.workItem.dshBinding.revision,
    });
    return { workItem:activated.workItem, session:activated.workItem.dshBinding.sessions.find(
      link => link.sessionId === pending.sessionId,
    ) };
  }

  async createSession({ workItem, mode = 'fresh', sourceSessionId = null } = {}) {
    workItem = requireWorkItem(workItem);
    const ensured = await this.#ensureWorkspace(workItem);
    workItem = ensured.workItem;
    const recovered = await this.#recoverPending(workItem);
    if (recovered) return recovered;
    if (mode !== 'fresh') {
      throw coordinatorError('DSH_FORK_NOT_IMPLEMENTED', '当前版本只支持为此 Deck 新建独立会话');
    }
    const operationId = freshUuid();
    const sessionId = `session-${freshUuid()}`;
    const begun = await this.catalogCommand('begin-session', {
      workId:workItem.workId,
      operationId,
      workspaceId:ensured.workspace.workspaceId,
      sessionId,
      origin:mode,
      sourceSessionId,
      expectedBindingRevision:workItem.dshBinding.revision,
    });
    await this.bridge.request('create-session', {
      workspaceId:ensured.workspace.workspaceId,
      sessionId,
      workspaceId:workItem.dshBinding.workspaceId,
      title:sessionTitleFor(workItem, sessionId),
    });
    const completed = await this.catalogCommand('complete-session', {
      workId:workItem.workId,
      operationId,
    });
    await this.bridge.request('open-session', { sessionId });
    const activated = await this.catalogCommand('activate-session', {
      workId:workItem.workId,
      sessionId,
      expectedBindingRevision:completed.workItem.dshBinding.revision,
    });
    return {
      workItem:activated.workItem,
      session:activated.workItem.dshBinding.sessions.find(link => link.sessionId === sessionId),
      sessionId,
    };
  }

  async activate({ workItem, sessionId = workItem?.dshBinding?.activeSessionId } = {}) {
    workItem = requireWorkItem(workItem);
    if (!sessionId) return { workItem, session:null };
    workItem = (await this.#ensureWorkspace(workItem)).workItem;
    const session = await this.bridge.request('open-session', {
      sessionId,
      workspaceId:workItem.dshBinding.workspaceId,
      title:sessionTitleFor(workItem, sessionId),
    });
    let next = workItem;
    if (workItem.dshBinding.activeSessionId !== sessionId) {
      const result = await this.catalogCommand('activate-session', {
        workId:workItem.workId,
        sessionId,
        expectedBindingRevision:workItem.dshBinding.revision,
      });
      next = result.workItem;
    }
    return { workItem:next, session };
  }

  sessionTitle({ workItem, sessionId = workItem?.dshBinding?.activeSessionId } = {}) {
    workItem = requireWorkItem(workItem);
    return sessionTitleFor(workItem, sessionId);
  }

  resolveBySession(sessionId) {
    return this.catalogCommand('resolve-session', { sessionId });
  }

  reconcileArchivedSessions({ workItem, sessionIds } = {}) {
    workItem = requireWorkItem(workItem);
    const archivedIds = new Set(Array.isArray(sessionIds) ? sessionIds : []);
    const linkedIds = workItem.dshBinding.sessions
      .filter(link => link.state === 'available' && archivedIds.has(link.sessionId))
      .map(link => link.sessionId);
    if (linkedIds.length === 0) return Promise.resolve({ workItem });
    return this.catalogCommand('archive-sessions', {
      workId:workItem.workId,
      sessionIds:linkedIds,
      expectedBindingRevision:workItem.dshBinding.revision,
    });
  }

  send(sessionId, prompt) {
    if (!sessionId) throw coordinatorError('DSH_SESSION_REQUIRED', '工作项没有可用的活动 DSH 会话');
    return this.bridge.request('send-to-session', { sessionId, prompt });
  }
}

export function createDeckTaskCoordinator(options) {
  return new DeckTaskCoordinator(options);
}
