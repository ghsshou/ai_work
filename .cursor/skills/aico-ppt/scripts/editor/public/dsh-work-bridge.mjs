function bridgeError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function requestId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `dsh-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function pathBasename(value) {
  if (typeof value !== 'string') return '';
  return value.split(/[\\/]+/).filter(Boolean).at(-1) ?? value;
}

/**
 * 把 WorkCatalog 的公开工作项压缩成跨 iframe 使用的精确会话目标。
 * 修改任务必须优先显示 Deck HTML 文件名，不能把项目目录名冒充 Deck 名称。
 */
export function describeDshWorkSessionTarget(workItem) {
  if (!workItem || typeof workItem !== 'object'
    || typeof workItem.workId !== 'string'
    || typeof workItem.projectRoot !== 'string'
    || !['creation', 'editing'].includes(workItem.kind)) return null;
  const revision = workItem.dshBinding?.revision ?? workItem.revision;
  if (!Number.isInteger(revision) || revision < 0) return null;
  const displayName = workItem.kind === 'editing'
    ? (workItem.deckName || pathBasename(workItem.deckPath) || workItem.displayName || '未命名 Deck')
    : (workItem.displayName || workItem.title || '未命名 Deck');
  return {
    workId:workItem.workId,
    contextKey:`${workItem.workId}:${revision}`,
    kind:workItem.kind,
    displayName,
    projectRoot:workItem.projectRoot,
    projectName:workItem.projectName || pathBasename(workItem.projectRoot) || '未命名项目',
  };
}

/** 当前任务优先，其余可见任务保持工作历史顺序；同一 workId 只发布一次。 */
export function listDshWorkSessionTargets(history, currentWorkId) {
  const rows = [
    ...(Array.isArray(history?.creation) ? history.creation : []),
    ...(Array.isArray(history?.editing) ? history.editing : []),
  ];
  const targets = [];
  const seen = new Set();
  for (const row of rows) {
    const target = describeDshWorkSessionTarget(row);
    if (target === null || seen.has(target.workId)) continue;
    seen.add(target.workId);
    targets.push(target);
  }
  const currentIndex = targets.findIndex(target => target.workId === currentWorkId);
  if (currentIndex > 0) targets.unshift(targets.splice(currentIndex, 1)[0]);
  return targets;
}

/**
 * AICO-PPT iframe 与 DSH Client Context 之间唯一的浏览器运输层。
 * 它不保存 Work Item 关系，只转发带 requestId 的白名单命令与当前会话通知。
 */
export class DshWorkBridge {
  constructor({
    hostWindow = window,
    targetWindow = window.parent,
    targetOrigin,
    timeoutMs = 30_000,
  } = {}) {
    if (!targetOrigin) throw new TypeError('DSH Bridge 缺少 parent Origin');
    this.hostWindow = hostWindow;
    this.targetWindow = targetWindow;
    this.targetOrigin = new URL(targetOrigin).origin;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.listeners = new Set();
    this.workSessionCreator = null;
    this.workSessionTargetNavigator = null;
    this.workSessionRequests = new Map();
    this.workSessionNavigationRequests = new Map();
    this.completedWorkSessionNavigationRequests = new Map();
    this.completedWorkSessionRequests = new Map();
    this.currentSession = undefined;
    this.closed = false;
    this.onMessage = this.onMessage.bind(this);
    this.hostWindow.addEventListener('message', this.onMessage);
    // 由 iframe 主动确认监听器已经安装，父 workbench 收到后会重放当前会话。
    // 这样无论 iframe 先加载还是 React effect 先运行，都不会丢失首条选中态。
    this.targetWindow.postMessage({ type:'aico-ppt:dsh-ready' }, this.targetOrigin);
  }

  onMessage(event) {
    if (event.source !== this.targetWindow || event.origin !== this.targetOrigin
      || !event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'aico-ppt:dsh-session-changed') {
      this.currentSession = event.data.session ?? null;
      for (const listener of this.listeners) listener(this.currentSession);
      return;
    }
    if (event.data.type === 'aico-ppt:create-work-session-request'
      && typeof event.data.requestId === 'string') {
      void this.handleWorkSessionRequest(event.data);
      return;
    }
    if (event.data.type === 'aico-ppt:navigate-work-session-target-request'
      && typeof event.data.requestId === 'string') {
      void this.handleWorkSessionNavigationRequest(event.data);
      return;
    }
    if (event.data.type !== 'aico-ppt:dsh-result'
      || typeof event.data.requestId !== 'string') return;
    const pending = this.pending.get(event.data.requestId);
    if (!pending) return;
    this.pending.delete(event.data.requestId);
    clearTimeout(pending.timer);
    if (event.data.ok === true) pending.resolve(event.data.result);
    else pending.reject(bridgeError(
      event.data.error?.code || 'DSH_COMMAND_FAILED',
      event.data.error?.message || 'DSH 操作失败',
      { command:pending.command },
    ));
  }

  async handleWorkSessionNavigationRequest(message) {
    const id = message.requestId;
    if (this.completedWorkSessionNavigationRequests.has(id)) {
      const completed = this.completedWorkSessionNavigationRequests.get(id);
      if (completed) this.targetWindow.postMessage(completed, this.targetOrigin);
      return;
    }
    if (this.workSessionNavigationRequests.has(id)) return;
    const operation = (async () => {
      let result = null;
      try {
        if (typeof this.workSessionTargetNavigator !== 'function') {
          throw bridgeError('WORK_SESSION_NAVIGATOR_UNAVAILABLE', '当前页面不能切换任务会话目标');
        }
        if (typeof message.workId !== 'string' || typeof message.contextKey !== 'string') {
          throw bridgeError('INVALID_WORK_SESSION_TARGET', '任务会话目标无效');
        }
        await this.workSessionTargetNavigator({
          workId:message.workId,
          contextKey:message.contextKey,
        });
        // 导航成功后页面会卸载；新页面发布完全匹配的 context 后，父级才会发送
        // create 请求。这里不能提前返回成功，否则会在旧任务中误建会话。
      } catch (error) {
        result = {
          type:'aico-ppt:create-work-session-result', requestId:id, ok:false,
          error:{ message:error instanceof Error ? error.message : String(error) },
        };
        this.targetWindow.postMessage(result, this.targetOrigin);
      }
      this.completedWorkSessionNavigationRequests.set(id, result);
      while (this.completedWorkSessionNavigationRequests.size > 64) {
        this.completedWorkSessionNavigationRequests.delete(
          this.completedWorkSessionNavigationRequests.keys().next().value,
        );
      }
    })();
    this.workSessionNavigationRequests.set(id, operation);
    try { await operation; }
    finally {
      // 成功导航通常会销毁本实例；失败则允许同一 requestId 的重复运输重试。
      this.workSessionNavigationRequests.delete(id);
    }
  }

  async handleWorkSessionRequest(message) {
    const id = message.requestId;
    const completed = this.completedWorkSessionRequests.get(id);
    if (completed) {
      this.targetWindow.postMessage(completed, this.targetOrigin);
      return;
    }
    const existing = this.workSessionRequests.get(id);
    if (existing) {
      await existing;
      const result = this.completedWorkSessionRequests.get(id);
      if (result) this.targetWindow.postMessage(result, this.targetOrigin);
      return;
    }
    const operation = (async () => {
      let result;
      try {
        if (typeof this.workSessionCreator !== 'function') {
          throw bridgeError('WORK_SESSION_CREATOR_UNAVAILABLE', '当前页面不能创建任务会话');
        }
        if (typeof message.workId !== 'string' || typeof message.contextKey !== 'string') {
          throw bridgeError('INVALID_WORK_SESSION_TARGET', '任务会话目标无效');
        }
        const created = await this.workSessionCreator({
          workId:message.workId,
          contextKey:message.contextKey,
        });
        result = {
          type:'aico-ppt:create-work-session-result', requestId:id, ok:true, result:created,
        };
      } catch (error) {
        result = {
          type:'aico-ppt:create-work-session-result', requestId:id, ok:false,
          error:{ message:error instanceof Error ? error.message : String(error) },
        };
      }
      this.completedWorkSessionRequests.set(id, result);
      while (this.completedWorkSessionRequests.size > 64) {
        this.completedWorkSessionRequests.delete(this.completedWorkSessionRequests.keys().next().value);
      }
      this.targetWindow.postMessage(result, this.targetOrigin);
    })();
    this.workSessionRequests.set(id, operation);
    try { await operation; }
    finally { this.workSessionRequests.delete(id); }
  }

  request(command, payload = {}) {
    if (this.closed) return Promise.reject(bridgeError('DSH_BRIDGE_CLOSED', 'DSH Bridge 已关闭'));
    if (typeof command !== 'string' || !command) {
      return Promise.reject(bridgeError('INVALID_DSH_COMMAND', 'DSH 命令无效'));
    }
    const id = requestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(bridgeError('DSH_BRIDGE_TIMEOUT', `等待 DSH 命令超时：${command}`, { command }));
      }, this.timeoutMs);
      this.pending.set(id, { command, resolve, reject, timer });
      this.targetWindow.postMessage({
        type:'aico-ppt:dsh-request',
        requestId:id,
        command,
        payload,
      }, this.targetOrigin);
    });
  }

  subscribeCurrentSession(listener) {
    if (typeof listener !== 'function') throw new TypeError('DSH 会话监听器必须是函数');
    this.listeners.add(listener);
    if (this.currentSession !== undefined) listener(this.currentSession);
    else {
      // Bridge 构造时的 ready 可能在业务订阅安装前就完成往返。虽然 onMessage
      // 会缓存正常响应，但 iframe 导航与父级 React effect 同时重建时仍可能漏掉
      // 第一拍；首个订阅安装后再握手一次，确保当前会话至少交付一次。
      this.targetWindow.postMessage({ type:'aico-ppt:dsh-ready' }, this.targetOrigin);
    }
    return () => this.listeners.delete(listener);
  }

  /**
   * 发布当前页面已经稳定落定的 Work Item，供 DSH 左侧统一“新会话”入口显示。
   * contextKey 必须包含会影响关联正确性的版本；父级真正执行前会把它原样带回。
   */
  publishWorkContext(context, targets = context === null ? [] : [context]) {
    if (this.closed) return;
    if (context !== null && (typeof context !== 'object'
      || typeof context.workId !== 'string'
      || typeof context.contextKey !== 'string')) {
      throw new TypeError('DSH Work Context 无效');
    }
    if (!Array.isArray(targets) || targets.some(target => (
      !target || typeof target !== 'object'
      || typeof target.workId !== 'string'
      || typeof target.contextKey !== 'string'
      || !['creation', 'editing'].includes(target.kind)
    ))) throw new TypeError('DSH Work Context 目标列表无效');
    this.targetWindow.postMessage({
      type:'aico-ppt:dsh-work-context',
      context,
      targets,
    }, this.targetOrigin);
  }

  /** 注册本页面唯一的任务会话创建器；返回值用于页面卸载时撤销。 */
  registerWorkSessionCreator(creator) {
    if (typeof creator !== 'function') throw new TypeError('任务会话创建器必须是函数');
    this.workSessionCreator = creator;
    return () => {
      if (this.workSessionCreator === creator) this.workSessionCreator = null;
    };
  }

  /** 注册从当前页面切换到另一精确 Work Item 的导航器。 */
  registerWorkSessionTargetNavigator(navigator) {
    if (typeof navigator !== 'function') throw new TypeError('任务会话目标导航器必须是函数');
    this.workSessionTargetNavigator = navigator;
    return () => {
      if (this.workSessionTargetNavigator === navigator) this.workSessionTargetNavigator = null;
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.targetWindow.postMessage({
      type:'aico-ppt:dsh-work-context', context:null, targets:[],
    }, this.targetOrigin);
    this.hostWindow.removeEventListener('message', this.onMessage);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(bridgeError('DSH_BRIDGE_CLOSED', 'DSH Bridge 已关闭'));
    }
    this.pending.clear();
    this.listeners.clear();
    this.workSessionCreator = null;
    this.workSessionTargetNavigator = null;
    this.workSessionRequests.clear();
    this.workSessionNavigationRequests.clear();
    this.completedWorkSessionNavigationRequests.clear();
    this.completedWorkSessionRequests.clear();
  }
}

export function createDshWorkBridge(options) {
  return new DshWorkBridge(options);
}
