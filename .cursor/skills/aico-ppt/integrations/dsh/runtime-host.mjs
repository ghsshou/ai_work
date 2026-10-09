/** Host 只持有 Editor 的入口与 Worker 生命周期，不加载 Editor 的模块级默认值。 */
import { Worker } from 'node:worker_threads';
import { resolveRuntime } from './runtime-env.mjs';

const START_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 15_000;

/** 启动原 Editor Worker；done 在退出后完成或报告崩溃，close 可重复并等待实际退出。 */
export async function startRuntimeWorker(runtime, { environment = process.env, stateRoot } = {}) {
  const resolved = await resolveRuntime(runtime, environment);
  // 文件选择能力只经 Worker 私有启动参数传递，不进入通用脚本或子进程环境。
  let desktopDialogs;
  const dialogUrl = environment.AICO_DESKTOP_DIALOG_URL;
  const dialogToken = environment.AICO_DESKTOP_DIALOG_TOKEN;
  if (dialogUrl || dialogToken) {
    let url;
    try { url = new URL(dialogUrl); } catch { throw new Error('桌面文件选择通道地址无效'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.pathname !== '/pick' || url.search || url.hash || url.username || url.password
      || typeof dialogToken !== 'string' || !dialogToken.trim()) {
      throw new Error('桌面文件选择通道必须包含本机地址和认证信息');
    }
    desktopDialogs = { AICO_DESKTOP_DIALOG_URL:url.href, AICO_DESKTOP_DIALOG_TOKEN:dialogToken };
  }
  const worker = new Worker(new URL('./runtime-worker.mjs', import.meta.url), {
    env:resolved.environment, workerData:{ paths:resolved.paths, desktopDialogs, stateRoot }, execArgv:[],
  });
  const requests = new Map();
  let requestSequence = 0;
  let failure;
  let closing = false;
  let closePromise;
  let exited = false;
  let terminated = false;
  let closedAcknowledged = false;
  let resolveReady;
  let rejectReady;
  let resolveDone;
  let rejectDone;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // 崩溃也通过 done 交给调用者；启动失败期间不能出现无人观察的拒绝。
  void done.catch(() => {});
  const recordFailure = error => {
    failure ??= error;
    for (const request of requests.values()) request.reject(failure);
    requests.clear();
    rejectReady(failure);
  };
  worker.on('message', message => {
    if (message?.type === 'views' || message?.type === 'restart-status') {
      const request = requests.get(message.id);
      if (!request) return;
      requests.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else if (message.type === 'restart-status') {
        const value=message.status;
        if(typeof value?.version!=='string'||typeof value.safe!=='boolean'||!Array.isArray(value.reasons))request.reject(new Error('PPT 重启状态无效'));
        else request.resolve(value);
      }
      else if (!Array.isArray(message.views)) request.reject(new Error('Editor Worker 视图列表无效'));
      else request.resolve(message.views);
    } else if (message?.type === 'ready') {
      try {
        const url = new URL(message.appUrl);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || !url.pathname.startsWith('/app/')) {
          throw new Error('Editor Worker 返回了无效本机入口');
        }
        resolveReady(message.appUrl);
      } catch (error) { recordFailure(error); }
    } else if (message?.type === 'closed') {
      closedAcknowledged = true;
    } else if (message?.type === 'failure') {
      recordFailure(new Error(`AICO-PPT Worker 失败：${message.message}`));
    }
  });
  worker.on('error', error => recordFailure(new Error(`AICO-PPT Worker 崩溃：${error.message}`, { cause:error })));
  worker.once('exit', code => {
    exited = true;
    for (const request of requests.values()) request.reject(new Error('Editor Worker 已退出'));
    requests.clear();
    if ((!closing || (!terminated && (!closedAcknowledged || code !== 0))) && !failure) {
      failure = new Error(`AICO-PPT Worker 意外退出（${code}）`);
    }
    if (failure) { rejectReady(failure); rejectDone(failure); }
    else resolveDone();
  });
  let startupTimer;
  try {
    const appUrl = await Promise.race([
      ready,
      new Promise((resolve, reject) => {
        startupTimer = setTimeout(() => reject(new Error('AICO-PPT Editor 启动超时')), START_TIMEOUT_MS);
      }),
    ]);
    return {
      appUrl,
      done,
      /** 通过私有 Worker 协议读取所属视图，不接受调用方传入网络地址。 */
      transportViews() {
        if (closing || exited || failure) return Promise.reject(failure ?? new Error('Editor Worker 已关闭'));
        const id = ++requestSequence;
        let timer;
        const result = new Promise((resolve, reject) => {
          requests.set(id, { resolve, reject });
          timer = setTimeout(() => reject(new Error('Editor Worker 视图查询超时')), START_TIMEOUT_MS);
          worker.postMessage({ type:'views', id });
        });
        return result.finally(() => { clearTimeout(timer); requests.delete(id); });
      },
      /** 私有只读 RPC；超时或 Worker 退出不能被解释为空闲。 */
      restartStatus() {
        if (closing || exited || failure) return Promise.reject(failure ?? new Error('Editor Worker 已关闭'));
        const id=++requestSequence;
        let timer;
        const result=new Promise((resolve,reject)=>{
          requests.set(id,{resolve,reject});
          timer=setTimeout(()=>reject(new Error('PPT 重启状态查询超时')),2500);
          worker.postMessage({type:'restart-status',id});
        });
        return result.finally(()=>{clearTimeout(timer);requests.delete(id);});
      },
      close() {
        if (closePromise) return closePromise;
        closing = true;
        for (const request of requests.values()) request.reject(new Error('Editor Worker 正在关闭'));
        requests.clear();
        closePromise = (async () => {
          if (exited) return done;
          worker.postMessage({ type:'close' });
          let timer;
          let forced = false;
          try {
            await Promise.race([
              done,
              new Promise(resolve => { timer = setTimeout(() => { forced = true; resolve(); }, CLOSE_TIMEOUT_MS); }),
            ]);
          } finally {
            clearTimeout(timer);
            if (!exited) { terminated = true; await worker.terminate(); }
          }
          await done;
          if (forced) throw new Error('AICO-PPT Editor 关闭超时，已终止 Worker');
        })();
        return closePromise;
      },
    };
  } catch (error) {
    closing = true;
    if (!exited) { terminated = true; await worker.terminate(); }
    await done.catch(() => {});
    throw error;
  } finally { clearTimeout(startupTimer); }
}
