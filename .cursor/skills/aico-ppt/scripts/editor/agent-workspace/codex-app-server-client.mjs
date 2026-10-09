import { spawn } from 'node:child_process';

function clientError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

export class CodexAppServerClient {
  static async start(options = {}) {
    const client = new CodexAppServerClient(options);
    await client.#start();
    return client;
  }

  constructor({
    executable = 'codex',
    spawnProcess = spawn,
    requestTimeoutMs = 15_000,
    maxOutputBytes = 64 * 1024 * 1024,
    closeGraceMs = 500,
  } = {}) {
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw new TypeError('Codex App Server requestTimeoutMs 无效');
    }
    this.executable = executable;
    this.spawnProcess = spawnProcess;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.closeGraceMs = closeGraceMs;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationListeners = new Set();
    this.serverRequestListeners = new Set();
    this.stdout = '';
    this.outputBytes = 0;
    this.closed = false;
    this.finished = false;
    this.closePromise = null;
  }

  async #start() {
    const child = this.spawnProcess(
      this.executable,
      ['app-server', '--listen', 'stdio://'],
      { env:process.env, stdio:['pipe', 'pipe', 'pipe'] },
    );
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => this.#onStdout(String(chunk)));
    child.stderr.on('data', () => {});
    child.stdin.on('error', error => this.#fatal(clientError(
      'CODEX_APP_SERVER_DISCONNECTED',
      `Codex App Server stdin 失败：${error.message}`,
      { cause:error },
    )));
    child.once('error', error => this.#fatal(clientError(
      error.code === 'ENOENT' ? 'CODEX_NOT_INSTALLED' : 'CODEX_APP_SERVER_START_FAILED',
      error.code === 'ENOENT' ? '未安装 codex' : `Codex App Server 启动失败：${error.message}`,
      { cause:error },
    )));
    child.once('close', (code, signal) => {
      this.finished = true;
      this.resolveChildClosed?.();
      if (!this.closed) this.#fatal(clientError(
        'CODEX_APP_SERVER_DISCONNECTED',
        `Codex App Server 意外退出（${signal ? `signal ${signal}` : `code ${code}`}）`,
      ), { kill:false });
    });
    this.childClosed = new Promise(resolve => { this.resolveChildClosed = resolve; });

    await this.request('initialize', {
      clientInfo:{
        name:'aico_ppt_editor',
        title:'AICO-PPT 编辑器',
        version:'1',
      },
      capabilities:{ experimentalApi:true },
    });
    this.#send({ method:'initialized', params:{} });
  }

  #send(message) {
    if (this.closed || this.finished) {
      throw clientError('CODEX_APP_SERVER_CLOSED', 'Codex App Server 已关闭');
    }
    const line = `${JSON.stringify(message)}\n`;
    try {
      this.child.stdin.write(line, error => {
        if (error) this.#fatal(clientError(
          'CODEX_APP_SERVER_DISCONNECTED',
          `Codex App Server 写入失败：${error.message}`,
          { cause:error },
        ));
      });
    } catch (error) {
      this.#fatal(clientError(
        'CODEX_APP_SERVER_DISCONNECTED',
        `Codex App Server 写入失败：${error.message}`,
        { cause:error },
      ));
      throw error;
    }
  }

  request(method, params = {}) {
    if (this.closed || this.finished) {
      return Promise.reject(clientError('CODEX_APP_SERVER_CLOSED', 'Codex App Server 已关闭'));
    }
    if (typeof method !== 'string' || !method) {
      return Promise.reject(new TypeError('Codex App Server method 无效'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(clientError(
          'CODEX_APP_SERVER_TIMEOUT',
          `Codex App Server 请求超时：${method}`,
          { method },
        ));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.#send({ method, id, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  onNotification(listener) {
    if (typeof listener !== 'function') throw new TypeError('notification listener 必须是函数');
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener) {
    if (typeof listener !== 'function') throw new TypeError('server request listener 必须是函数');
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  #onStdout(chunk) {
    if (this.closed) return;
    this.outputBytes += Buffer.byteLength(chunk);
    if (this.outputBytes > this.maxOutputBytes) {
      this.#fatal(clientError(
        'CODEX_APP_SERVER_OUTPUT_LIMIT',
        'Codex App Server 输出超过安全上限',
      ));
      return;
    }
    this.stdout += chunk;
    let newline;
    while ((newline = this.stdout.indexOf('\n')) >= 0) {
      const line = this.stdout.slice(0, newline);
      this.stdout = this.stdout.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch {
        this.#fatal(clientError(
          'CODEX_APP_SERVER_PROTOCOL',
          'Codex App Server 返回无效 JSONL',
        ));
        return;
      }
      this.#onMessage(message);
    }
  }

  #onMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.#fatal(clientError('CODEX_APP_SERVER_PROTOCOL', 'Codex App Server 消息格式无效'));
      return;
    }
    if ('id' in message && typeof message.method === 'string') {
      void this.#handleServerRequest(message);
      return;
    }
    if ('id' in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(clientError(
        'CODEX_APP_SERVER_REQUEST_FAILED',
        message.error.message ?? `${pending.method} 请求失败`,
        { method:pending.method, rpcCode:message.error.code, data:message.error.data },
      ));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string') {
      for (const listener of this.notificationListeners) {
        try { listener(structuredClone(message)); } catch { /* listener 不影响 client */ }
      }
      return;
    }
    this.#fatal(clientError('CODEX_APP_SERVER_PROTOCOL', 'Codex App Server 消息缺少 method/id'));
  }

  async #handleServerRequest(message) {
    const listener = this.serverRequestListeners.values().next().value;
    if (!listener) {
      this.#send({
        id:message.id,
        error:{ code:-32601, message:`未处理 server request：${message.method}` },
      });
      return;
    }
    try {
      const result = await listener(structuredClone(message));
      this.#send({ id:message.id, result:result ?? {} });
    } catch (error) {
      this.#send({
        id:message.id,
        error:{ code:-32000, message:error?.message ?? 'server request 处理失败' },
      });
    }
  }

  #fatal(error, { kill = true } = {}) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (kill && !this.finished) this.child?.kill?.('SIGTERM');
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (!this.closed) {
        this.closed = true;
        const error = clientError('CODEX_APP_SERVER_CLOSED', 'Codex App Server 已关闭');
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
      }
      if (this.finished) return;
      try { this.child.stdin.end(); } catch { /* 继续 kill */ }
      const timer = setTimeout(() => this.child.kill?.('SIGTERM'), this.closeGraceMs);
      timer.unref?.();
      await this.childClosed;
      clearTimeout(timer);
    })();
    return this.closePromise;
  }
}
