import { randomUUID } from 'node:crypto';

import { buildEditorBatchPrompt } from './agent-runner.mjs';

function bridgeError(code, statusCode, message) {
  return Object.assign(new Error(message), { code, statusCode });
}

/**
 * 创建由嵌入页转交给 DSH 原生会话的 Agent 运行适配器。
 *
 * Editor 仍然拥有任务批次、revision 和完成状态；浏览器父页面只负责把
 * 已生成的规范提示词送入当前 DSH 会话，并回传“已接收 / 失败”。
 */
export function createDshAgentRunAdapter({
  getSession,
  getAssignedSessionId,
  publishRequest,
  acknowledgementTimeoutMs = 30_000,
  runTimeoutMs = 20 * 60 * 1_000,
} = {}) {
  if (typeof getSession !== 'function') throw new TypeError('getSession 必须是函数');
  if (typeof getAssignedSessionId !== 'function') {
    throw new TypeError('getAssignedSessionId 必须是函数');
  }
  if (typeof publishRequest !== 'function') throw new TypeError('publishRequest 必须是函数');
  if (!Number.isSafeInteger(acknowledgementTimeoutMs) || acknowledgementTimeoutMs <= 0) {
    throw new TypeError('acknowledgementTimeoutMs 必须为正整数');
  }
  if (!Number.isSafeInteger(runTimeoutMs) || runTimeoutMs <= 0) {
    throw new TypeError('runTimeoutMs 必须为正整数');
  }

  const pending = new Map();
  let closed = false;

  const settle = (requestId, outcome) => {
    const request = pending.get(requestId);
    if (!request) return false;
    pending.delete(requestId);
    clearTimeout(request.timer);
    request.signal?.removeEventListener('abort', request.abort);
    if (outcome.accepted === true) request.resolve();
    else request.reject(bridgeError(
      'DSH_AGENT_SUBMISSION_FAILED', 502,
      typeof outcome.message === 'string' && outcome.message
        ? outcome.message : 'DSH 原生会话未接收本批任务',
    ));
    return true;
  };

  const adapter = {
    id:'dsh',
    submissionAware:true,
    mode:'dsh',

    /** 接收嵌入页对某次 DSH 会话提交的确认。 */
    acknowledge({ requestId, accepted, message = '' } = {}) {
      if (typeof requestId !== 'string' || !requestId) {
        throw bridgeError('INVALID_DSH_REQUEST_ID', 400, 'DSH 请求 ID 无效');
      }
      if (typeof accepted !== 'boolean') {
        throw bridgeError('INVALID_DSH_ACKNOWLEDGEMENT', 400, 'DSH 接收状态必须是布尔值');
      }
      if (!settle(requestId, { accepted, message })) {
        throw bridgeError('DSH_REQUEST_NOT_FOUND', 404, 'DSH 请求已结束或不存在');
      }
      return { accepted:true };
    },

    async run(context) {
      if (closed) throw bridgeError('SERVICE_CLOSED', 503, 'DSH Agent 适配器已关闭');
      const assignedSessionId = await getAssignedSessionId();
      if (closed) throw bridgeError('SERVICE_CLOSED', 503, 'DSH Agent 适配器已关闭');
      if (typeof assignedSessionId !== 'string' || !assignedSessionId) {
        throw bridgeError('DSH_SESSION_REQUIRED', 409, '当前 Deck 工作项没有可用的活动 DSH 会话');
      }
      const requestId = randomUUID();
      const prompt = buildEditorBatchPrompt({
        ...context,
        sourceThreadId:'dsh-native-session',
        loadSkill:false,
        skillInvocation:'/aico-ppt',
        environmentCredentials:false,
      });
      context.onProgress?.({
        status:'queued', mode:'dsh', message:'正在交给此 Deck 的活动 DSH 会话',
      });
      await new Promise((resolve, reject) => {
        const abort = () => {
          settle(requestId, {
            accepted:false,
            message:'DSH Agent 任务已取消',
          });
        };
        const timer = setTimeout(() => {
          settle(requestId, {
            accepted:false,
            message:'等待 DSH 会话接收任务超时，请确认插件窗口仍然打开',
          });
        }, acknowledgementTimeoutMs);
        timer.unref?.();
        pending.set(requestId, { resolve, reject, timer, signal:context.signal, abort });
        context.signal?.addEventListener('abort', abort, { once:true });
        try {
          publishRequest({
            requestId,
            prompt,
            assignedSessionId,
            taskIds:[...context.taskIds],
            createdAt:new Date().toISOString(),
          });
        } catch (error) {
          pending.delete(requestId);
          clearTimeout(timer);
          context.signal?.removeEventListener('abort', abort);
          reject(error);
        }
      });

      context.onProgress?.({
        status:'running', mode:'dsh', message:'已指定的 DSH 会话正在处理本批任务',
      });
      const deadline = Date.now() + runTimeoutMs;
      let heartbeatAt = Date.now();
      for (;;) {
        if (context.signal?.aborted) {
          throw bridgeError('AGENT_RUN_CANCELLED', 409, 'DSH Agent 任务已取消');
        }
        const remaining = new Set(context.taskIds);
        for (const task of getSession()?.tasks ?? []) {
          if (remaining.has(task.id) && !['pending', 'failed'].includes(task.status)) {
            remaining.delete(task.id);
          }
        }
        if (remaining.size === 0) {
          return { mode:'dsh', summary:'DSH Agent 已完成本批处理，请检查页面结果' };
        }
        if (Date.now() >= deadline) {
          throw bridgeError(
            'DSH_AGENT_RUN_TIMEOUT', 504,
            `DSH Agent 处理超时，仍有 ${remaining.size} 个任务可重新提交`,
          );
        }
        if (Date.now() - heartbeatAt >= 15_000) {
          heartbeatAt = Date.now();
          context.onProgress?.({
            mode:'dsh', message:`DSH Agent 仍在处理，剩余 ${remaining.size} 个任务`,
          });
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    },

    close() {
      if (closed) return;
      closed = true;
      for (const requestId of [...pending.keys()]) {
        settle(requestId, { accepted:false, message:'DSH Agent 适配器已关闭' });
      }
    },
  };
  return adapter;
}
