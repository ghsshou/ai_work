import { randomUUID } from 'node:crypto';

function relayError(code, message) {
  return Object.assign(new Error(message), { code, statusCode:502 });
}

/**
 * 把 Creation Managed Workspace 需要追加的提示词转交给已绑定的 DSH 会话。
 * 它只模拟 CreationWorkspace 依赖的窄 Terminal 接口，不创建 PTY。
 */
export function createDshPromptRelay({
  cwd,
  getSessionId,
  publishRequest,
  acknowledgementTimeoutMs = 30_000,
} = {}) {
  if (typeof cwd !== 'string' || !cwd) throw new TypeError('DSH Prompt Relay 缺少 cwd');
  if (typeof getSessionId !== 'function') throw new TypeError('getSessionId 必须是函数');
  if (typeof publishRequest !== 'function') throw new TypeError('publishRequest 必须是函数');
  const pending = new Map();
  let closed = false;

  const settle = (requestId, outcome) => {
    const request = pending.get(requestId);
    if (!request || request.settled) return false;
    request.settled = true;
    clearTimeout(request.timer);
    if (outcome.accepted === true) request.resolve();
    else request.reject(relayError(
      'DSH_PROMPT_SUBMISSION_FAILED',
      outcome.message || 'DSH 会话没有接收 Creation 提示词',
    ));
    return true;
  };

  return {
    cwd,

    snapshot() {
      return {
        provider:'dsh',
        providerLabel:'DSH',
        state:closed ? 'closed' : 'running',
        turnState:'idle',
        promptReady:!closed && Boolean(getSessionId()),
        conversationId:getSessionId() ?? null,
      };
    },

    async waitUntilReady() {
      if (closed) throw relayError('SERVICE_CLOSED', 'DSH Prompt Relay 已关闭');
      if (!getSessionId()) throw relayError('DSH_SESSION_REQUIRED', 'Creation 工作项没有活动 DSH 会话');
    },

    submitPrompt(prompt) {
      if (closed) throw relayError('SERVICE_CLOSED', 'DSH Prompt Relay 已关闭');
      const sessionId = getSessionId();
      if (!sessionId) throw relayError('DSH_SESSION_REQUIRED', 'Creation 工作项没有活动 DSH 会话');
      const requestId = randomUUID();
      const request = { settled:false };
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          settle(requestId, {
            accepted:false,
            message:'等待 DSH 会话接收 Creation 提示词超时',
          });
        }, acknowledgementTimeoutMs);
        timer.unref?.();
        Object.assign(request, { resolve, reject, timer });
      });
      request.promise = promise;
      pending.set(requestId, request);
      try {
        publishRequest({ requestId, sessionId, prompt, createdAt:new Date().toISOString() });
      } catch (error) {
        pending.delete(requestId);
        clearTimeout(request.timer);
        request.settled = true;
        request.resolve();
        throw error;
      }
      return requestId;
    },

    waitUntilPromptSubmission(requestId) {
      const request = pending.get(requestId);
      if (!request) return Promise.resolve();
      return request.promise.finally(() => {
        if (pending.get(requestId) === request) pending.delete(requestId);
      });
    },

    acknowledge({ requestId, accepted, message = '' } = {}) {
      if (typeof requestId !== 'string' || typeof accepted !== 'boolean') {
        throw relayError('INVALID_DSH_ACKNOWLEDGEMENT', 'DSH Creation 接收回执无效');
      }
      if (!settle(requestId, { accepted, message })) {
        throw relayError('DSH_REQUEST_NOT_FOUND', 'DSH Creation 请求已结束或不存在');
      }
      return { accepted:true };
    },

    async start() {},

    async close() {
      if (closed) return;
      closed = true;
      for (const requestId of [...pending.keys()]) {
        settle(requestId, { accepted:false, message:'DSH Prompt Relay 已关闭' });
      }
    },
  };
}
