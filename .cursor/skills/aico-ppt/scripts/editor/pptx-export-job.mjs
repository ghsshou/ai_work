import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';

// 导出结果先写同目录临时文件，转换或写入失败时保留已有 PPTX。
async function savePptx(path, bytes, signal) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    signal.throwIfAborted();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force:true });
  }
}

// 工作项服务持有任务；页面仅查询状态，断开页面不会取消导出。
export function createPptxExportJob({ prepare, pickPath, convert }) {
  let state = { status:'idle' };
  let active = null;
  let closed = false;
  const snapshot = () => ({ ...state });
  return {
    snapshot,
    get busy() { return active !== null; },
    start({ expectedRevision, mode, defaultPath }) {
      if (closed) throw Object.assign(new Error('导出服务已关闭'), { statusCode:503 });
      if (active) throw Object.assign(new Error('已有一个 PPTX 正在导出，请稍候'), {
        code:'PPTX_EXPORT_BUSY', statusCode:409,
      });
      const controller = new AbortController();
      const { signal } = controller;
      state = { id:randomUUID(), status:'preparing', mode, revision:expectedRevision,
        filename:basename(defaultPath), startedAt:new Date().toISOString() };
      const initial = snapshot();
      const promise = Promise.resolve().then(async () => {
        const htmlBytes = await prepare(expectedRevision);
        signal.throwIfAborted();
        state.status = 'choosing';
        const path = await pickPath({ defaultPath, signal });
        signal.throwIfAborted();
        if (path === null) { state.status = 'cancelled'; return; }
        if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')
          || extname(path).toLowerCase() !== '.pptx') {
          throw new Error('请选择 .pptx 格式的保存路径');
        }
        state.path = path;
        state.filename = basename(path);
        state.status = 'exporting';
        const exported = await convert({ htmlBytes, mode, signal });
        signal.throwIfAborted();
        const bytes = Buffer.from(exported ?? []);
        if (bytes.length < 4 || bytes.subarray(0, 2).toString() !== 'PK') {
          throw new Error('PPTX 导出结果无效');
        }
        state.status = 'saving';
        await savePptx(path, bytes, signal);
        state.status = 'completed';
      }).catch(error => {
        state.status = signal.aborted ? 'cancelled' : 'failed';
        state.message = signal.aborted ? '应用关闭，PPTX 导出已取消' : error.message;
        state.code = error.code ?? 'PPTX_EXPORT_FAILED';
      }).finally(() => {
        state.finishedAt = new Date().toISOString();
        active = null;
      });
      active = { controller, promise };
      return initial;
    },
    async close() {
      closed = true;
      if (!active) return;
      active.controller.abort();
      await active.promise;
    },
  };
}
