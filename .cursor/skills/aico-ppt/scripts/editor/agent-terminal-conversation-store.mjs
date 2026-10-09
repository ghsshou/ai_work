import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { CodexAppServerClient } from './agent-workspace/codex-app-server-client.mjs';
import { AGENT_PROVIDER_IDS } from './agent-provider-registry.mjs';

const PROVIDERS = new Set(AGENT_PROVIDER_IDS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const execFileAsync = promisify(execFile);

function wslCodexRuntime(environment) {
  const value = name => environment[`AICO_PPT_${name}`]
    ?? environment[`HUAWEI_DECK_${name}`];
  if (value('CODEX_RUNTIME') !== 'wsl') return null;
  const distribution = value('WSL_DISTRO');
  const user = value('WSL_USER');
  const node = value('WSL_NODE');
  const codexHome = value('WSL_CODEX_HOME');
  const helper = value('WSL_SESSION_HELPER');
  if (typeof distribution !== 'string' || !distribution
    || typeof user !== 'string' || !/^[a-z_][a-z0-9_-]{0,63}$/i.test(user)
    || typeof node !== 'string' || !node.startsWith('/')
    || typeof codexHome !== 'string' || !codexHome.startsWith('/')
    || typeof helper !== 'string' || !helper.startsWith('/')
    || [distribution, node, codexHome, helper].some(value => /[\0\r\n]/.test(value))) {
    throw Object.assign(new Error('WSL Codex 会话配置不完整或无效'), {
      code:'INVALID_WSL_CODEX_SESSION_CONFIG',
    });
  }
  return { distribution, user, node, codexHome, helper };
}

async function defaultRunWslCodexHelper(operation, args = [], {
  environment = process.env,
} = {}) {
  const runtime = wslCodexRuntime(environment);
  if (!runtime) throw new TypeError('当前不是 WSL Codex runtime');
  let stdout;
  try {
    ({ stdout } = await execFileAsync('wsl.exe', [
      '-d', runtime.distribution,
      '-u', runtime.user,
      '--exec', runtime.node, runtime.helper,
      operation, runtime.codexHome, ...args,
    ], {
      env:environment,
      encoding:'utf8',
      timeout:10_000,
      maxBuffer:2 * 1024 * 1024,
      windowsHide:true,
    }));
  } catch (error) {
    throw Object.assign(new Error(
      `无法在 WSL 内读取 Codex 会话：${String(error.stderr || error.message).trim()}`,
    ), { code:'WSL_CODEX_SESSION_HELPER_FAILED', cause:error });
  }
  try { return JSON.parse(stdout); }
  catch (error) {
    throw Object.assign(new Error('WSL Codex 会话 helper 返回了无效 JSON'), {
      code:'WSL_CODEX_SESSION_HELPER_INVALID_OUTPUT', cause:error,
    });
  }
}

function emptyState(taskId) {
  return { version:1, taskId, providers:{}, updatedAt:new Date(0).toISOString() };
}

function validConversationId(value) {
  return typeof value === 'string' && value.length >= 3 && value.length <= 512
    && !value.startsWith('-') && !/[\0\r\n]/.test(value);
}

function codexSessionsRoot(environment = process.env) {
  return join(environment.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
}

function sessionDateParts(now = Date.now()) {
  const values = [];
  for (const offset of [-86_400_000, 0, 86_400_000]) {
    const [year, month, day] = new Date(now + offset).toISOString().slice(0, 10).split('-');
    values.push([year, month, day]);
  }
  return values;
}

async function recentRollouts(root, now = Date.now()) {
  const results = [];
  for (const parts of sessionDateParts(now)) {
    const directory = join(root, ...parts);
    let entries;
    try { entries = await readdir(directory, { withFileTypes:true }); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
      const ids = entry.name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig);
      const id = ids?.at(-1) ?? null;
      if (id) results.push({ id, path:join(directory, entry.name) });
    }
  }
  return results;
}

async function filePrefix(path, limit = 4 * 1024 * 1024) {
  const handle = await open(path, 'r');
  try {
    const chunks = [];
    let offset = 0;
    while (offset < limit) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit - offset));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await handle.close();
  }
}

function sessionMeta(text) {
  const newline = text.indexOf('\n');
  try {
    const entry = JSON.parse(newline >= 0 ? text.slice(0, newline) : text);
    return entry?.type === 'session_meta' ? entry.payload : null;
  } catch { return null; }
}

export async function createTerminalConversation(provider, {
  idFactory = randomUUID,
  environment = process.env,
  projectRoot = process.cwd(),
  listOpenCodeSessions = defaultOpenCodeSessions,
  runWslCodexHelper = defaultRunWslCodexHelper,
} = {}) {
  if (!PROVIDERS.has(provider)) throw new TypeError(`Agent provider 不受支持：${String(provider)}`);
  if (provider === 'claude-code') {
    return { conversationId:idFactory(), resume:false };
  }
  const discoveryToken = idFactory();
  if (!UUID.test(discoveryToken)) throw new TypeError('Agent 会话发现标识无效');
  if (provider === 'opencode') {
    let knownConversationIds = [];
    try {
      knownConversationIds = (await listOpenCodeSessions({
        cwd:projectRoot, environment,
      })).map(item => item.id);
    } catch { /* 基线失败不阻止可见 TUI 启动 */ }
    return {
      conversationId:null,
      resume:false,
      initialPromptConsumed:false,
      discoveryToken,
      discoveryStartedAt:new Date().toISOString(),
      knownConversationIds,
    };
  }
  let knownConversationIds = [];
  try {
    if (wslCodexRuntime(environment)) {
      const value = await runWslCodexHelper('list-rollouts', [], { environment });
      knownConversationIds = Array.isArray(value?.ids) ? value.ids.filter(id => UUID.test(id)) : [];
    } else {
      knownConversationIds = (await recentRollouts(codexSessionsRoot(environment))).map(item => item.id);
    }
  } catch { /* 基线只用于加速，失败时仍可用标识发现 */ }
  // 不再先跑一轮隐藏的 `codex exec`。PTY 立即启动交互式 Codex，
  // 真实 ID 在首个可见 turn 落盘后异步发现并持久化。
  return {
    conversationId:null,
    resume:false,
    initialPromptConsumed:false,
    discoveryToken,
    discoveryStartedAt:new Date().toISOString(),
    knownConversationIds,
  };
}

async function defaultOpenCodeSessions({ cwd = process.cwd(), environment = process.env } = {}) {
  const { stdout } = await execFileAsync(
    process.platform === 'win32' ? 'opencode.cmd' : 'opencode',
    ['session', 'list', '--format', 'json', '--max-count', '100'],
    { cwd, env:environment, timeout:5_000, maxBuffer:2 * 1024 * 1024 },
  );
  const value = JSON.parse(stdout);
  const rows = Array.isArray(value) ? value : value?.sessions ?? [];
  return rows.map(session => ({
    id:String(session.id ?? session.sessionID ?? session.sessionId ?? ''),
    title:String(session.title ?? session.name ?? ''),
    cwd:session.directory ?? session.cwd ?? null,
  })).filter(session => validConversationId(session.id));
}

export async function resumeTerminalConversation(provider, {
  conversationId,
} = {}) {
  if (!PROVIDERS.has(provider)) throw new TypeError(`Agent provider 不受支持：${String(provider)}`);
  if (!validConversationId(conversationId)) throw new TypeError('Agent 会话 ID 无效');
  // 可恢复性由即将显示的 CLI 自己验证，不再先冷启动一个
  // App Server 验证后又启动第二个 CLI。
  return { conversationId, resume:true };
}

export async function discoverTerminalConversation(provider, {
  discoveryToken,
  discoveryStartedAt = null,
  knownConversationIds = null,
  projectRoot = null,
  cwd = null,
  environment = process.env,
  signal = null,
  codexClientFactory = options => CodexAppServerClient.start(options),
  timeoutMs = 45_000,
  pollMs = 150,
  listOpenCodeSessions = defaultOpenCodeSessions,
  runWslCodexHelper = defaultRunWslCodexHelper,
} = {}) {
  if (!['codex', 'opencode'].includes(provider)) {
    throw new TypeError('只有 Codex 与 OpenCode 需要异步发现会话 ID');
  }
  if (!UUID.test(discoveryToken)) throw new TypeError('Agent 会话发现标识无效');
  const assertActive = () => {
    if (signal?.aborted) throw Object.assign(new Error('Agent 会话 ID 发现已取消'), {
      code:'AGENT_SESSION_DISCOVERY_CANCELLED',
    });
  };
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  const known = Array.isArray(knownConversationIds) ? new Set(knownConversationIds) : null;
  if (provider === 'opencode') {
    while (Date.now() < deadline) {
      assertActive();
      try {
        const sessions = await listOpenCodeSessions({
          cwd:cwd ?? projectRoot ?? process.cwd(), environment,
        });
        const candidates = sessions.filter(session => !known?.has(session.id)
          && (!cwd || !session.cwd || session.cwd === cwd));
        const marked = candidates.find(session => session.title.includes(discoveryToken));
        if (marked) return marked.id;
      } catch (error) {
        lastError = error;
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    throw Object.assign(new Error(lastError
      ? `OpenCode 会话 ID 发现超时：${lastError.message}`
      : 'OpenCode 会话 ID 发现超时'), {
      code:'AGENT_SESSION_DISCOVERY_TIMEOUT', cause:lastError,
    });
  }
  const startedAt = Date.parse(discoveryStartedAt ?? '');
  if (wslCodexRuntime(environment)) {
    if (!Number.isFinite(startedAt) || typeof cwd !== 'string' || !cwd.startsWith('/')) {
      throw Object.assign(new Error('WSL Codex 会话发现缺少有效的开始时间或工作目录'), {
        code:'INVALID_WSL_CODEX_SESSION_DISCOVERY',
      });
    }
    while (Date.now() < deadline) {
      assertActive();
      try {
        const response = await runWslCodexHelper('find-rollout', [
          discoveryToken,
          discoveryStartedAt,
          cwd,
          JSON.stringify(known ? [...known] : []),
        ], { environment });
        if (validConversationId(response?.conversationId)) return response.conversationId;
      } catch (error) {
        lastError = error;
      }
      await new Promise(resolve => setTimeout(resolve, Math.max(250, pollMs)));
    }
    throw Object.assign(new Error(lastError
      ? `WSL Codex 会话 ID 发现超时：${lastError.message}`
      : 'WSL Codex 会话 ID 发现超时'), {
      code:'AGENT_SESSION_DISCOVERY_TIMEOUT', cause:lastError,
    });
  }
  if (known && Number.isFinite(startedAt)) {
    while (Date.now() < Math.min(deadline, startedAt + 30_000)) {
      assertActive();
      try {
        const rollouts = await recentRollouts(codexSessionsRoot(environment), startedAt);
        const candidates = [];
        for (const rollout of rollouts) {
          if (known.has(rollout.id)) continue;
          const text = await filePrefix(rollout.path);
          const meta = sessionMeta(text);
          const timestamp = Date.parse(meta?.timestamp ?? '');
          if (meta?.source !== 'cli' || !Number.isFinite(timestamp) || timestamp < startedAt - 2_000) continue;
          if (cwd && meta.cwd !== cwd) continue;
          candidates.push({ ...rollout, text });
        }
        const marked = candidates.find(item => item.text.includes(discoveryToken));
        if (marked) return marked.id;
      } catch (error) {
        lastError = error;
      }
      await new Promise(resolve => {
        const timer = setTimeout(resolve, pollMs);
        timer.unref?.();
      });
    }
  }

  assertActive();
  const client = await codexClientFactory();
  try {
    while (Date.now() < deadline) {
      assertActive();
      try {
        const response = await client.request('thread/list', {
          limit:100,
          sortKey:'updated_at',
          sortDirection:'desc',
        });
        const thread = (response?.data ?? []).find(item => (
          validConversationId(item?.id)
          && `${item?.name ?? ''}\n${item?.preview ?? ''}`.includes(discoveryToken)
        ));
        if (thread) return thread.id;
      } catch (error) {
        lastError = error;
      }
      await new Promise(resolve => {
        const timer = setTimeout(resolve, pollMs);
        timer.unref?.();
      });
    }
    throw Object.assign(new Error(lastError
      ? `Codex 会话 ID 发现超时：${lastError.message}`
      : 'Codex 会话 ID 发现超时'), {
      code:'AGENT_SESSION_DISCOVERY_TIMEOUT', cause:lastError,
    });
  } finally {
    await client.close().catch(() => {});
  }
}

export class DraftAgentConversationStore {
  constructor({
    draftDir,
    taskId,
    projectRoot,
    now = () => new Date().toISOString(),
    createConversation = (provider, options) => createTerminalConversation(provider, options),
    resumeConversation = (provider, options) => resumeTerminalConversation(provider, options),
  } = {}) {
    if (typeof draftDir !== 'string' || !draftDir) throw new TypeError('缺少 Draft 目录');
    if (typeof taskId !== 'string' || !taskId) throw new TypeError('缺少 Draft taskId');
    this.path = join(draftDir, 'agent-conversations.json');
    this.taskId = taskId;
    this.projectRoot = projectRoot;
    this.now = now;
    this.createConversation = createConversation;
    this.resumeConversation = resumeConversation;
    this.queue = Promise.resolve();
    this.pendingDiscovery = new Set();
  }

  async #read() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (value?.version !== 1 || value.taskId !== this.taskId
        || !value.providers || typeof value.providers !== 'object') return emptyState(this.taskId);
      return value;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return emptyState(this.taskId);
      throw error;
    }
  }

  async #write(state) {
    await mkdir(dirname(this.path), { recursive:true, mode:0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding:'utf8', mode:0o600,
      });
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  resolve(provider, {
    newConversation = false, initialPrompt = '', environment = process.env,
  } = {}) {
    const operation = this.queue.then(async () => {
      if (!PROVIDERS.has(provider)) throw new TypeError(`Agent provider 不受支持：${String(provider)}`);
      const state = await this.#read();
      const existing = state.providers[provider];
      if (!newConversation && validConversationId(existing?.conversationId)) {
        if (existing.started !== true) {
          return { conversationId:existing.conversationId, resume:false };
        }
        try {
          return await this.resumeConversation(provider, {
            projectRoot:this.projectRoot,
            conversationId:existing.conversationId,
          });
        } catch { /* 已保存 ID 不可恢复时在下方创建替代会话 */ }
      }
      const created = await this.createConversation(provider, {
        projectRoot:this.projectRoot,
        initialPrompt,
        environment,
      });
      if (created?.conversationId === null && UUID.test(created?.discoveryToken)) {
        this.pendingDiscovery.add(provider);
        return created;
      }
      if (!validConversationId(created?.conversationId)) {
        throw new TypeError('Agent 会话 ID 无效');
      }
      state.providers[provider] = {
        conversationId:created.conversationId,
        started:created.resume === true,
        createdAt:this.now(),
      };
      state.updatedAt = this.now();
      await this.#write(state);
      return created;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  markStarted(provider, conversationId) {
    const operation = this.queue.then(async () => {
      const state = await this.#read();
      const current = state.providers[provider];
      if (this.pendingDiscovery.delete(provider)) {
        state.providers[provider] = {
          conversationId,
          started:true,
          createdAt:this.now(),
          startedAt:this.now(),
        };
        state.updatedAt = this.now();
        await this.#write(state);
        return;
      }
      if (!current || current.conversationId !== conversationId) return;
      current.started = true;
      current.startedAt ??= this.now();
      state.updatedAt = this.now();
      await this.#write(state);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
