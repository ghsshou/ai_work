import pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, win32 } from 'node:path';
import {
  agentProviderDefinition,
  buildRegisteredTerminalCommand,
  publicAgentProviders,
} from './agent-provider-registry.mjs';
import { createAgentTerminalProjection } from './agent-terminal-projection.mjs';
import { prepareAgentTerminalRuntime } from './agent-terminal-runtime.mjs';

const MAX_BUFFER_CHARS = 1024 * 1024;
const MAX_INPUT_CHARS = 64 * 1024;
const WINDOWS_PROMPT_CHUNK_BYTES = 512;
const WINDOWS_PROMPT_CHUNK_DELAY_MS = 30;
const PROMPT_ACK_TIMEOUT_MS = 1_500;
const PROMPT_ACK_MAX_ATTEMPTS = 2;
const MISSING_AGENT_SESSION = Object.freeze({
  codex:/No saved session found|no rollout found for thread id/i,
  'claude-code':/No conversation found with session ID/i,
});
const INTERACTION_SCAN_CHARS = 8 * 1024;
const DIRECTORY_TRUST_MESSAGE = '请在右侧终端确认是否信任当前项目目录';
const CODEX_UPDATE_MESSAGE = '请在右侧终端处理 Codex 更新提示';
const WORKING_DIRECTORY_SELECTION_MESSAGE = '请在右侧终端选择恢复会话使用的工作目录';
const TERMINAL_SELECTION_MESSAGE = '请在右侧终端完成 CLI 选项确认';

function visibleTerminalText(output) {
  return String(output ?? '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    // Codex TUI 用 CSI n C/a 表示单词之间的水平空白；若直接删掉，
    // `Do you trust` 会塌成 `Doyoutrust`，目录信任闸门无法识别。
    .replace(/\u001b\[\d{0,4}[Ca]/g, ' ')
    // Codex 0.149 的恢复目录菜单用绝对 row/column 定位逐词绘制，并隐藏
    // 真实光标；保留一个边界空格，避免 `Choose`、`working` 等词粘连。
    .replace(/\u001b\[(?:\d{0,4};)?\d{0,4}[Hf]/g, ' ')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n');
}

function directoryTrustRequested(output) {
  const text = visibleTerminalText(output).replace(/[ \t]+/g, ' ').toLowerCase();
  if (!text.trim()) return false;
  return [
    /do\s+you\s+trust[\s\S]{0,180}(?:directory|folder|project|workspace|files?|contents?|codebase)/,
    /do\s+you\s+trust\b/,
    /(?:trust|trusted)\s+(?:the\s+contents\s+of\s+)?(?:this|the|current)?\s*(?:directory|folder|project|workspace|codebase)/,
    /is\s+this[\s\S]{0,120}(?:project|folder|directory)[\s\S]{0,120}(?:you\s+trust|trusted)/,
    /(?:是否|请)[\s\S]{0,40}信任[\s\S]{0,80}(?:目录|文件夹|项目|工作区)/,
    /(?:目录|文件夹|项目|工作区)[\s\S]{0,80}(?:是否|请)[\s\S]{0,40}信任/,
  ].some(pattern => pattern.test(text));
}

function codexUpdateInteractionRequested(output) {
  const text = visibleTerminalText(output).replace(/[ \t]+/g, ' ');
  if (!/update available!/i.test(text)) return false;
  // 普通版本通知只打印安装命令，不需要用户输入。只有更新面板同时给出
  // “跳过到下一版本”和“按键继续”时才开放终端交互，避免遮罩拦住回车。
  return /skip until next version/i.test(text)
    && /press(?:\s+\S+)?\s+to continue/i.test(text);
}

function workingDirectorySelectionRequested(output) {
  const text = visibleTerminalText(output).replace(/[ \t]+/g, ' ');
  if (!text.trim()) return false;
  return /choose\s+(?:the\s+)?working\s+directory\s+to\s+resume\s+(?:this|the)\s+session/i
    .test(text)
    || (/use\s+session\s+directory/i.test(text)
      && /use\s+current\s+directory/i.test(text)
      && /press(?:\s+\S+)?\s+to continue/i.test(text));
}

function terminalSelectionRequested(output) {
  const text = visibleTerminalText(output).replace(/[ \t]+/g, ' ');
  if (!text.trim()) return false;
  // TUI 菜单通常隐藏真实光标，以 `›` 标记当前项。要求高亮编号项、至少两个
  // 编号选项和明确操作提示三者同时存在；普通编号日志以及 Codex 的
  // `› Ask ...` 空输入框都不能命中这个兜底规则。
  const numberedChoices = text.match(/(?:^|\s)(?:›\s*)?\d+[.)]\s+\S/g) ?? [];
  if (numberedChoices.length < 2 || !/(?:^|\s)›\s*\d+[.)]\s+\S/.test(text)) return false;
  return /(?:press\s+(?:enter|return)|use\s+(?:the\s+)?(?:arrow|up|down)|\bchoose\b|\bselect\b)/i
    .test(text);
}

function terminalInteractionRequested(provider, output) {
  if (directoryTrustRequested(output)) {
    return { kind:'directory-trust', message:DIRECTORY_TRUST_MESSAGE };
  }
  if (provider === 'codex' && workingDirectorySelectionRequested(output)) {
    return {
      kind:'working-directory-selection',
      message:WORKING_DIRECTORY_SELECTION_MESSAGE,
    };
  }
  if (provider === 'codex' && codexUpdateInteractionRequested(output)) {
    return { kind:'codex-update', message:CODEX_UPDATE_MESSAGE };
  }
  if (terminalSelectionRequested(output)) {
    return { kind:'terminal-selection', message:TERMINAL_SELECTION_MESSAGE };
  }
  return null;
}

function missingAgentSession(provider, output) {
  return MISSING_AGENT_SESSION[provider]?.test(visibleTerminalText(output)) === true;
}

function splitUtf8(text, maxBytes) {
  const chunks = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const symbol of text) {
    const symbolBytes = Buffer.byteLength(symbol, 'utf8');
    if (chunk && chunkBytes + symbolBytes > maxBytes) {
      chunks.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += symbol;
    chunkBytes += symbolBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function terminalAcceptsPrompt(provider, output, {
  codexModelConfirmed = false,
  codexResumed = false,
  codexResumedHistoryFallback = false,
} = {}) {
  const visibleOutput = visibleTerminalText(output);
  if (!visibleOutput.trim()) return false;
  if (provider === 'claude-code') {
    // Claude Code/Ink 在启动、恢复长会话和重绘历史时都会输出
    // 大量 ANSI，但只有真正的空输入行会画出“❯ + 反色空格光标”。
    // 不能再用“有任意输出”作为 ready；Windows 恢复长会话时会因此
    // 把任务前几个分块灌进尚未接管键盘的启动画面。
    return /❯(?:\u00a0| )?(?:\u001b\[[0-?]*[ -/]*[@-~])*\u001b\[7m /.test(output);
  }
  if (provider === 'opencode') {
    // OpenCode 启动后会先输出标题、同步状态和模型加载进度；只有真正的
    // prompt placeholder 与可见光标同时出现时才允许自动注入。保留明确的
    // ready 文本供兼容终端和确定性测试使用。
    return /opencode ready/i.test(visibleOutput)
      || (/(?:Ask anything|随便问点什么)/i.test(visibleOutput)
        && output.includes('\u001b[?25h'));
  }
  if (provider !== 'codex') return false;
  // Codex 启动时会先输出终端模式、标题和模型加载信息；这些首批字节并不代表
  // Ink 输入框已经接管键盘。真正可输入的屏幕会绘制粗体 ›，并在它之后显示
  // 光标。测试和不带完整 ANSI 能力的兼容终端可使用明确的 ready 文本。
  if (/codex ready/i.test(visibleOutput)) return true;
  const promptMarker = output.lastIndexOf('›');
  if (promptMarker < 0 || output.indexOf('\u001b[?25h', promptMarker) < 0) return false;
  const promptLine = visibleTerminalText(output.slice(promptMarker, promptMarker + 240))
    .split('\n', 1)[0]
    .trim();
  // 目录信任页也用 `› 1. Yes` 表示当前选项；它不是任务输入框。恢复历史
  // 时若前面还残留模型状态栏，只看“› + 光标”会把确认页误判成 ready。
  if (/^›\s*(?:\d+[.)]|yes\b|no\b|trust\b|exit\b)/i.test(promptLine)) return false;
  const readyStatusMatches = [...visibleOutput.matchAll(
    /([^\n]{1,120}?)\s[·•]\s(?:\/|~\/|[A-Za-z]:[\\/])/gm,
  )];
  const readyStatusPrefix = readyStatusMatches.at(-1)?.[1]?.trim() ?? '';
  if (!readyStatusPrefix) return false;
  // 同一进程已经通过过一次完整 model 闸门后，长任务输出可能把启动时的
  // `model:` 行挤出短扫描窗口。此后再次出现“输入框 + 光标 + 模型/目录状态栏”
  // 就足以证明 CLI 已回到空闲态，不能让下一批任务永久等待。
  if (codexModelConfirmed) return true;
  // Codex 0.148 起会在模型和 MCP 尚未完成初始化时提前画出可编辑草稿框，
  // 并刻意忽略启动阶段缓存的 Enter；此时底部状态栏甚至可能已经出现，但
  // 顶部 model 仍是 loading。以最后一次 model 绘制为准，必须同时看到
  // 非 loading 模型和“模型 · 工作目录”状态栏，不能只认“› + 光标”。
  const modelMatches = [...visibleOutput.matchAll(/model:\s*(\S{1,80})/gim)];
  const currentModel = modelMatches.at(-1)?.[1] ?? '';
  if (currentModel.trim()) return !/^loading\b/i.test(currentModel.trim());
  // Codex 恢复普通长度历史时可能只重绘最终输入区，不再重放启动卡片中的
  // `model:` 行。此时不能要求缓冲先膨胀到 1 MiB：新版空输入框的固定
  // placeholder、可见光标，以及同一终端画面中的非 loading 模型/目录状态栏
  // 已共同构成足够强的恢复就绪证据。新会话和旧版普通草稿仍保持严格闸门。
  if (codexResumed
    && /^›\s*Ask Codex to do anything\b/i.test(promptLine)
    && !/\bloading\b/i.test(readyStatusPrefix)) return true;
  // 恢复超长历史时 node-pty 的 1 MiB 环形缓冲会把启动 model 行裁掉。
  // 只有已确认是 resume、缓冲确实满载，且最终输入框与模型/目录状态栏都在
  // 尾部成立时才启用兜底；短输出中的显式 loading 仍走上面的严格闸门。
  return codexResumedHistoryFallback;
}

function codexResumePromptVisible(output) {
  const promptMarker = output.lastIndexOf('›');
  if (promptMarker < 0 || output.indexOf('\u001b[?25h', promptMarker) < 0) return false;
  const promptLine = visibleTerminalText(output.slice(promptMarker, promptMarker + 240))
    .split('\n', 1)[0]
    .trim();
  return /^›\s*Ask Codex to do anything\b/i.test(promptLine);
}

function terminalAcknowledgesPrompt(provider, output) {
  if (!String(output ?? '').trim()) return false;
  const visibleOutput = visibleTerminalText(output);
  if (provider === 'codex') {
    return /(?:^|\n)\s*[•◦]\s|esc to interrupt|working|thinking|stream disconnected|error sending request/i
      .test(visibleOutput);
  }
  // Claude Code 与 OpenCode 都会在接受 Enter 后立刻重绘输入区或活动区。
  // 提交前已经经过各自的空输入框闸门，因此此后的首段 PTY 输出就是接收回执；
  // 若完全没有输出，超时状态机会重试 Enter 并最终显式失败。
  return true;
}

function terminalReportsTurnFinished(provider, output) {
  if (provider !== 'codex') return false;
  const visibleOutput = visibleTerminalText(output);
  if (/codex ready/i.test(visibleOutput)) return true;
  const activeMatches = [...visibleOutput.matchAll(
    /(?:^|\n)[^\n]{0,160}\b(?:working|thinking)\b[^\n]{0,160}|esc to interrupt/gim,
  )];
  const finishedMatches = [...visibleOutput.matchAll(
    /worked for\b|conversation interrupted|stream disconnected|error sending request/gim,
  )];
  const lastActive = activeMatches.at(-1)?.index ?? -1;
  const lastFinished = finishedMatches.at(-1)?.index ?? -1;
  return lastFinished > lastActive;
}

function terminalError(code, message) {
  return Object.assign(new Error(message), { code });
}

function providerConfig(provider) {
  try { return agentProviderDefinition(provider); }
  catch (error) { throw terminalError(error.code, error.message); }
}

export function agentTerminalProviders() {
  return publicAgentProviders();
}

export function buildAgentTerminalCommand(provider, {
  platform = process.platform, conversationId = null, resume = false,
} = {}) {
  providerConfig(provider);
  if (conversationId !== null && (typeof conversationId !== 'string'
    || conversationId.length < 3 || conversationId.length > 512
    || conversationId.startsWith('-') || /[\0\r\n]/.test(conversationId))) {
    throw terminalError('INVALID_AGENT_CONVERSATION_ID', 'Agent 会话 ID 无效');
  }
  return buildRegisteredTerminalCommand(provider, { platform, conversationId, resume });
}

export function resolveAgentTerminalExecutable(provider, {
  platform = process.platform,
  environment = process.env,
  exists = existsSync,
} = {}) {
  const definition = providerConfig(provider);
  const base = definition.terminal.executable;
  if (platform !== 'win32') return base;
  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  const directories = String(environment.PATH ?? environment.Path ?? '')
    .split(pathDelimiter).map(value => value.replace(/^"|"$/g, '')).filter(Boolean);
  // native installer 优先于 npm shim；候选名固定来自注册表，浏览器不能注入路径。
  for (const suffix of ['.exe', '.cmd', '.bat', '']) {
    const name = `${base}${suffix}`;
    for (const directory of directories) {
      const candidate = win32.join(directory, name);
      if (exists(candidate)) return candidate;
    }
  }
  // 保留既有错误体验：未安装时让 node-pty 报 ENOENT，并转成 AGENT_NOT_FOUND。
  return `${base}.cmd`;
}

function socketOpen(socket) {
  return socket?.readyState === undefined || socket.readyState === 1;
}

export class AgentTerminalSession {
  constructor({
    projectRoot,
    cwd = projectRoot,
    provider = 'codex',
    platform = process.platform,
    environment = process.env,
    spawnPty = pty.spawn,
    initialPrompt = () => '',
    resolveConversation = async () => null,
    identifyConversation = async () => null,
    onConversationStarted = async () => {},
    onProviderChange = async () => {},
    onStateChange = () => {},
    scheduleSubmit = setTimeout,
    cancelScheduledSubmit = clearTimeout,
    resolveExecutable = resolveAgentTerminalExecutable,
    prepareRuntime = prepareAgentTerminalRuntime,
    createTerminalProjection = createAgentTerminalProjection,
    runtimePathRoots = [],
  }) {
    const absolutePath = platform === 'win32' ? win32.isAbsolute : isAbsolute;
    if (typeof projectRoot !== 'string' || !absolutePath(projectRoot)) {
      throw new TypeError('Agent 终端项目目录必须是绝对路径');
    }
    if (typeof cwd !== 'string' || !absolutePath(cwd)) {
      throw new TypeError('Agent 终端启动目录必须是绝对路径');
    }
    providerConfig(provider);
    if (typeof platform !== 'string' || !platform) throw new TypeError('终端平台无效');
    if (typeof spawnPty !== 'function') throw new TypeError('spawnPty 必须是函数');
    if (typeof initialPrompt !== 'function') throw new TypeError('initialPrompt 必须是函数');
    if (typeof resolveConversation !== 'function') throw new TypeError('resolveConversation 必须是函数');
    if (typeof identifyConversation !== 'function') throw new TypeError('identifyConversation 必须是函数');
    if (typeof onConversationStarted !== 'function') throw new TypeError('onConversationStarted 必须是函数');
    if (typeof onProviderChange !== 'function') throw new TypeError('onProviderChange 必须是函数');
    if (typeof onStateChange !== 'function') throw new TypeError('onStateChange 必须是函数');
    if (typeof scheduleSubmit !== 'function') throw new TypeError('scheduleSubmit 必须是函数');
    if (typeof cancelScheduledSubmit !== 'function') throw new TypeError('cancelScheduledSubmit 必须是函数');
    if (typeof resolveExecutable !== 'function') throw new TypeError('resolveExecutable 必须是函数');
    if (typeof prepareRuntime !== 'function') throw new TypeError('prepareRuntime 必须是函数');
    if (typeof createTerminalProjection !== 'function') {
      throw new TypeError('createTerminalProjection 必须是函数');
    }
    if (!Array.isArray(runtimePathRoots)
      || runtimePathRoots.some(value => typeof value !== 'string')) {
      throw new TypeError('runtimePathRoots 必须是路径数组');
    }
    this.projectRoot = projectRoot;
    this.cwd = cwd;
    this.provider = provider;
    this.platform = platform;
    this.environment = { ...environment };
    this.spawnPty = spawnPty;
    this.initialPrompt = initialPrompt;
    this.resolveConversation = resolveConversation;
    this.identifyConversation = identifyConversation;
    this.onConversationStarted = onConversationStarted;
    this.onProviderChange = onProviderChange;
    this.onStateChange = onStateChange;
    this.scheduleSubmit = scheduleSubmit;
    this.cancelScheduledSubmit = cancelScheduledSubmit;
    this.resolveExecutable = resolveExecutable;
    this.prepareRuntime = prepareRuntime;
    this.createTerminalProjection = createTerminalProjection;
    this.runtimePathRoots = [...runtimePathRoots];
    this.providerChangeListeners = new Set();
    this.stateListeners = new Set();
    this.interruptListeners = new Set();
    this.runtimeId = randomUUID();
    this.process = null;
    this.state = 'stopped';
    this.output = '';
    this.clientOutput = '';
    this.startedAt = null;
    this.conversationId = null;
    this.conversationResumed = false;
    this.conversationError = null;
    this.startupPromptState = null;
    this.promptReady = false;
    this.inputVisible = false;
    this.turnState = 'stopped';
    this.startupPhase = null;
    this.startupPhaseDetail = null;
    this.interactionRequired = null;
    this.interactionResponsePending = false;
    this.interactionScanOutput = '';
    this.exit = null;
    this.sockets = new Set();
    this.generation = 0;
    this.startPromise = null;
    this.pendingSubmitTimer = null;
    this.promptSubmissionSequence = 0;
    this.promptSubmission = null;
    this.activePromptSubmissionId = null;
    this.completedPromptSubmissionId = null;
    this.turnCompletionSeen = false;
    this.promptCapabilityConfirmed = false;
    this.terminalCols = 80;
    this.terminalRows = 24;
    this.discoveryController = null;
    this.closed = false;
    this.activeCommand = null;
    this.activeRuntime = null;
    this.historyProjection = null;
    this.historyProjectionPending = false;
    this.historyProjectionFlushing = false;
    this.historyProjectionTail = '';
    this.historyProjectionCallbacks = [];
  }

  snapshot() {
    const command = this.activeCommand
      ?? buildAgentTerminalCommand(this.provider, { platform:this.platform });
    const initialInputPending = ['starting', 'running'].includes(this.state)
      && !this.promptCapabilityConfirmed;
    return {
      runtimeId:this.runtimeId,
      provider:this.provider,
      providerLabel:command.label,
      state:this.state,
      projectRoot:this.projectRoot,
      command:[command.executable, ...command.args].join(' '),
      pid:this.process?.pid ?? null,
      conversationId:this.conversationId,
      conversationResumed:this.conversationResumed,
      initialInputPending,
      resumePending:this.conversationResumed
        && (initialInputPending || this.historyProjectionPending),
      startupPhase:this.startupPhase,
      startupPhaseDetail:this.startupPhaseDetail ? { ...this.startupPhaseDetail } : null,
      historyProjectionPending:this.historyProjectionPending,
      conversationError:this.conversationError,
      startupPromptState:this.startupPromptState,
      promptSubmission:this.promptSubmission ? { ...this.promptSubmission } : null,
      activePromptSubmissionId:this.activePromptSubmissionId,
      completedPromptSubmissionId:this.completedPromptSubmissionId,
      promptReady:this.promptReady,
      inputVisible:this.inputVisible,
      turnState:this.turnState,
      interactionRequired:this.interactionRequired ? { ...this.interactionRequired } : null,
      startedAt:this.startedAt,
      exit:this.exit ? { ...this.exit } : null,
      providers:agentTerminalProviders(),
    };
  }

  #send(socket, message) {
    if (!socketOpen(socket)) return;
    socket.send(JSON.stringify(message));
  }

  #broadcast(message) {
    for (const socket of this.sockets) this.#send(socket, message);
  }

  #publishState() {
    const terminal = this.snapshot();
    this.#broadcast({ type:'state', terminal });
    try {
      const pending = this.onStateChange(terminal);
      pending?.catch?.(() => {});
    } catch { /* 状态投影失败不能破坏 PTY 生命周期 */ }
    for (const listener of this.stateListeners) {
      try {
        const pending = listener(terminal);
        pending?.catch?.(() => {});
      } catch { /* 状态投影失败不能破坏 PTY 生命周期 */ }
    }
  }

  addStateListener(listener) {
    if (typeof listener !== 'function') throw new TypeError('状态 listener 必须是函数');
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  addProviderChangeListener(listener) {
    if (typeof listener !== 'function') throw new TypeError('provider listener 必须是函数');
    this.providerChangeListeners.add(listener);
    return () => this.providerChangeListeners.delete(listener);
  }

  addInterruptListener(listener) {
    if (typeof listener !== 'function') throw new TypeError('interrupt listener 必须是函数');
    this.interruptListeners.add(listener);
    return () => this.interruptListeners.delete(listener);
  }

  updateConversationLifecycle({
    resolveConversation,
    identifyConversation = this.identifyConversation,
    onConversationStarted,
  } = {}) {
    if (typeof resolveConversation !== 'function') {
      throw new TypeError('resolveConversation 必须是函数');
    }
    if (typeof onConversationStarted !== 'function') {
      throw new TypeError('onConversationStarted 必须是函数');
    }
    if (typeof identifyConversation !== 'function') {
      throw new TypeError('identifyConversation 必须是函数');
    }
    this.resolveConversation = resolveConversation;
    this.identifyConversation = identifyConversation;
    this.onConversationStarted = onConversationStarted;
  }

  updateEnvironment(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('终端环境变量 patch 必须是对象');
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) delete this.environment[key];
      else this.environment[key] = String(value);
    }
  }

  attach(socket) {
    if (!socket || typeof socket.send !== 'function') throw new TypeError('终端 socket 无效');
    this.sockets.add(socket);
    this.#send(socket, { type:'snapshot', terminal:this.snapshot(), output:this.clientOutput });
    return () => this.sockets.delete(socket);
  }

  async start({
    provider = this.provider, cols = 80, rows = 24, initialPrompt, newConversation = false,
  } = {}) {
    if (this.closed) throw terminalError('SERVICE_CLOSED', '编辑服务已关闭');
    providerConfig(provider);
    if (this.process && this.state === 'running' && this.provider === provider) {
      this.resize(cols, rows);
      return this.snapshot();
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start({ provider, cols, rows, initialPrompt, newConversation })
      .finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async #start({ provider, cols, rows, initialPrompt, newConversation }) {
    await this.stop({ clear:false });
    await this.onProviderChange(provider);
    for (const listener of this.providerChangeListeners) await listener(provider);
    if (this.closed) throw terminalError('SERVICE_CLOSED', '编辑服务已关闭');
    this.provider = provider;
    this.output = '';
    this.clientOutput = '';
    this.exit = null;
    this.conversationId = null;
    this.conversationResumed = false;
    this.conversationError = null;
    this.startupPromptState = null;
    this.promptSubmission = null;
    this.activePromptSubmissionId = null;
    this.completedPromptSubmissionId = null;
    this.turnCompletionSeen = false;
    this.promptReady = false;
    this.inputVisible = false;
    this.turnState = 'starting';
    this.startupPhase = 'runtime-preparing';
    this.startupPhaseDetail = null;
    this.promptCapabilityConfirmed = false;
    this.interactionRequired = null;
    this.interactionResponsePending = false;
    this.interactionScanOutput = '';
    this.state = 'starting';
    this.#publishState();
    let runtime = null;
    try {
      runtime = await this.prepareRuntime(provider, {
        platform:this.platform,
        environment:this.environment,
        projectRoot:this.projectRoot,
        cwd:this.cwd,
        pathRoots:this.runtimePathRoots,
        onPhase:(phase, detail = null) => {
          if (this.closed || this.state !== 'starting') return;
          this.startupPhase = phase;
          this.startupPhaseDetail = detail && typeof detail === 'object'
            ? { ...detail }
            : null;
          this.#publishState();
        },
      });
    } catch (error) {
      this.state = 'failed';
      this.exit = { code:null, signal:null, message:error?.message || 'Agent 运行环境准备失败' };
      this.#publishState();
      throw terminalError(
        error?.code ?? 'AGENT_RUNTIME_PREPARE_FAILED',
        error?.message ?? 'Agent 运行环境准备失败',
      );
    }
    this.startupPhase = provider === 'codex' ? 'codex-starting' : 'agent-starting';
    this.startupPhaseDetail = null;
    this.#publishState();
    const runtimeEnvironment = runtime?.environment ?? this.environment;
    const hasExplicitPrompt = initialPrompt !== undefined;
    const prompt = initialPrompt ?? await this.initialPrompt(provider);
    let conversation = null;
    try {
      conversation = await this.resolveConversation(provider, {
        newConversation:newConversation === true,
        initialPrompt:prompt,
        environment:runtimeEnvironment,
      });
      const hasConversationId = typeof conversation?.conversationId === 'string';
      const hasDiscoveryToken = conversation?.conversationId === null
        && typeof conversation?.discoveryToken === 'string'
        && conversation.discoveryToken.length >= 3
        && conversation.discoveryToken.length <= 512
        && !/[\0\r\n]/.test(conversation.discoveryToken);
      if (conversation !== null && (typeof conversation !== 'object'
        || (!hasConversationId && !hasDiscoveryToken))) {
        throw terminalError('INVALID_AGENT_CONVERSATION', 'Agent 会话恢复信息无效');
      }
    } catch (error) {
      this.state = 'failed';
      this.exit = { code:null, signal:null, message:error?.message || 'Agent 会话恢复失败' };
      this.#publishState();
      throw terminalError(
        error?.code ?? 'AGENT_CONVERSATION_RESOLVE_FAILED',
        error?.message ?? 'Agent 会话恢复失败',
      );
    }
    if (this.closed) throw terminalError('SERVICE_CLOSED', '编辑服务已关闭');
    const discoveryPrompt = conversation?.discoveryToken
      ? `[AICO-PPT 会话标识：${conversation.discoveryToken}]\n${prompt}`
      : prompt;
    const startupPromptSource = conversation?.initialPromptConsumed === true
        || (conversation?.resume === true && !hasExplicitPrompt)
      ? ''
      : discoveryPrompt;
    const startupPrompt = runtime?.translateText
      ? runtime.translateText(startupPromptSource)
      : startupPromptSource;
    const registeredCommand = buildAgentTerminalCommand(provider, {
      // 先让 CLI 显示并接管输入框，再由 PTY 统一粘贴初始指令并回车。
      platform:this.platform,
      conversationId:conversation?.conversationId ?? null,
      resume:conversation?.resume === true,
    });
    const command = runtime?.wrapCommand
      ? runtime.wrapCommand(registeredCommand)
      : {
          ...registeredCommand,
          executable:this.resolveExecutable(provider, {
            platform:this.platform,
            environment:this.environment,
          }),
        };
    this.activeCommand = command;
    this.activeRuntime = runtime;
    const generation = ++this.generation;
    this.terminalCols = Number.isInteger(cols) && cols > 0 ? Math.min(cols, 500) : 80;
    this.terminalRows = Number.isInteger(rows) && rows > 0 ? Math.min(rows, 300) : 24;
    if (conversation?.resume === true) {
      try {
        this.historyProjection = this.createTerminalProjection({
          cols:this.terminalCols,
          rows:this.terminalRows,
        });
        this.historyProjectionPending = true;
        this.historyProjectionFlushing = false;
        this.historyProjectionTail = '';
      } catch {
        // 投影器不可用时回退到既有实时输出，不能阻断 Agent 会话本身。
        this.historyProjection = null;
        this.historyProjectionPending = false;
      }
    }
    let child;
    try {
      child = this.spawnPty(command.executable, command.args, {
        name:'xterm-256color',
        cols:this.terminalCols,
        rows:this.terminalRows,
        cwd:runtime?.spawnCwd ?? this.cwd,
        env:{
          ...runtimeEnvironment,
          TERM:'xterm-256color',
          COLORTERM:'truecolor',
        },
      });
    } catch (error) {
      this.state = 'failed';
      this.exit = { code:null, signal:null, message:error?.message || 'Agent 终端启动失败' };
      this.activeRuntime = null;
      this.#discardHistoryProjection();
      this.#publishState();
      throw terminalError(
        error?.code === 'ENOENT' ? 'AGENT_NOT_FOUND' : 'AGENT_START_FAILED',
        error?.code === 'ENOENT'
          ? `找不到 ${command.executable} 命令，请先安装并登录 ${command.label}`
          : `${command.label} 启动失败：${error?.message || '未知错误'}`,
      );
    }
    this.process = child;
    this.conversationId = conversation?.conversationId ?? null;
    this.conversationResumed = conversation?.resume === true;
    this.startupPromptState = startupPrompt ? 'pending' : null;
    this.state = 'running';
    this.startupPhase = this.historyProjectionPending
      ? 'history-redraw'
      : (provider === 'codex' ? 'codex-starting' : 'agent-starting');
    this.startedAt = new Date().toISOString();
    let resumeRedrawRequested = false;
    child.onData(data => {
      if (generation !== this.generation || this.process !== child) return;
      const chunk = String(data);
      this.output = `${this.output}${chunk}`.slice(-MAX_BUFFER_CHARS);
      this.interactionScanOutput = `${this.interactionScanOutput}${chunk}`
        .slice(-INTERACTION_SCAN_CHARS);
      if (this.historyProjectionPending && this.historyProjection) {
        this.historyProjection.write(chunk);
        if (this.historyProjectionFlushing) {
          this.historyProjectionTail = `${this.historyProjectionTail}${chunk}`
            .slice(-MAX_BUFFER_CHARS);
        }
      } else {
        this.#deliverOutput(chunk);
      }
      let acknowledgedPrompt = false;
      if (this.promptSubmission?.state === 'awaiting-confirmation'
        && terminalAcknowledgesPrompt(provider, chunk)) {
        if (this.pendingSubmitTimer !== null) {
          this.cancelScheduledSubmit(this.pendingSubmitTimer);
          this.pendingSubmitTimer = null;
        }
        this.promptSubmission = {
          ...this.promptSubmission,
          state:'submitted',
          acceptedAt:new Date().toISOString(),
          error:null,
        };
        if (this.promptSubmission.startup) this.startupPromptState = 'submitted';
        this.promptReady = false;
        this.inputVisible = false;
        this.turnState = 'active';
        this.activePromptSubmissionId = this.promptSubmission.id;
        this.turnCompletionSeen = false;
        acknowledgedPrompt = true;
        this.#publishState();
      }
      if (this.turnState === 'active'
        && this.activePromptSubmissionId
        && terminalReportsTurnFinished(provider, this.interactionScanOutput || this.output)) {
        this.turnCompletionSeen = true;
      }
      const acceptsPrompt = terminalAcceptsPrompt(
        provider,
        this.interactionScanOutput || this.output,
        {
          codexModelConfirmed:this.promptCapabilityConfirmed,
          codexResumed:this.conversationResumed,
          codexResumedHistoryFallback:provider === 'codex'
            && this.conversationResumed
            && this.output.length >= MAX_BUFFER_CHARS,
        },
      );
      const inputVisible = acceptsPrompt;
      if (inputVisible !== this.inputVisible) {
        this.inputVisible = inputVisible;
        this.#publishState();
      }
      if (!acceptsPrompt && provider === 'codex' && this.conversationResumed
        && !resumeRedrawRequested && codexResumePromptVisible(this.output)) {
        // Codex 0.148 恢复完成时偶尔只画出输入框和光标，却把启动卡片留在
        // `model: loading`，直到下一次 SIGWINCH 才补画真实模型状态栏。遮罩下
        // 轻微改变一行再恢复，促使 TUI 交付最终屏幕；仍由后续输出的严格
        // provider 闸门决定是否就绪，不能因这次重绘本身提前放行。
        resumeRedrawRequested = true;
        const redrawRows = this.terminalRows > 2 ? this.terminalRows - 1 : this.terminalRows + 1;
        try {
          child.resize(this.terminalCols, redrawRows);
          child.resize(this.terminalCols, this.terminalRows);
        } catch { /* 重绘失败只保持现有加载闸门，不改变终端生命周期 */ }
      }
      const interactionRequested = (!this.promptReady || this.interactionRequired)
        && !acceptsPrompt
        && terminalInteractionRequested(provider, this.interactionScanOutput);
      if (interactionRequested
        && interactionRequested.kind !== this.interactionRequired?.kind) {
        this.interactionRequired = interactionRequested;
        this.interactionResponsePending = false;
        this.#publishState();
        this.#flushHistoryProjection();
      }
      if (this.interactionRequired) {
        if (interactionRequested || !acceptsPrompt) return;
        this.interactionRequired = null;
        this.interactionResponsePending = false;
        this.#publishState();
      }
      // Codex 工作期间也会绘制可输入的 steer 框。活动回合必须保持锁存，
      // 直到当前 Prompt 之后出现明确结束信号；不能再用 Working 与输入框之间
      // 的字符距离推断，否则长工具输出会把仍在执行的批次误判为空闲。
      const activeTurnLocked = this.turnState === 'active'
        && provider === 'codex'
        && !this.turnCompletionSeen;
      const idlePrompt = acceptsPrompt && !activeTurnLocked;
      if (!acknowledgedPrompt && !this.promptReady && idlePrompt) {
        if (this.turnState === 'active' && this.activePromptSubmissionId) {
          this.completedPromptSubmissionId = this.activePromptSubmissionId;
          this.activePromptSubmissionId = null;
          this.turnCompletionSeen = false;
        }
        this.promptReady = true;
        this.turnState = 'idle';
        this.promptCapabilityConfirmed = true;
        const finishStartup = () => {
          if (this.startupPromptState === 'pending') {
            this.#queuePrompt(startupPrompt, { startup:true });
          } else {
            this.#publishState();
          }
        };
        if (this.historyProjectionPending) {
          this.#flushHistoryProjection(finishStartup);
        } else {
          this.startupPhase = 'ready';
          finishStartup();
        }
      }
    });
    child.onExit(({ exitCode = null, signal = null } = {}) => {
      if (generation !== this.generation || this.process !== child) return;
      this.process = null;
      this.#discardHistoryProjection();
      if (conversation?.resume === true && missingAgentSession(provider, this.output)) {
        this.state = 'starting';
        this.exit = null;
        this.#publishState();
        setTimeout(() => {
          if (this.closed || generation !== this.generation || this.process) return;
          void this.restart({ provider, cols, rows, initialPrompt:prompt, newConversation:true });
        }, 0);
        return;
      }
      this.state = 'exited';
      this.promptReady = false;
      this.inputVisible = false;
      this.turnState = 'exited';
      this.activePromptSubmissionId = null;
      this.turnCompletionSeen = false;
      this.promptCapabilityConfirmed = false;
      this.interactionRequired = null;
      this.interactionResponsePending = false;
      this.exit = { code:exitCode, signal, message:`${command.label} 会话已退出` };
      this.#publishState();
    });
    this.#publishState();
    if (conversation?.conversationId) {
      try {
        await this.onConversationStarted(provider, conversation.conversationId);
      } catch { /* 会话已经启动，身份回执失败不能杀掉 PTY */ }
    } else if (conversation?.discoveryToken) {
      const identifyConversation = this.identifyConversation;
      const onConversationStarted = this.onConversationStarted;
      const discoveryController = new AbortController();
      this.discoveryController = discoveryController;
      void identifyConversation(provider, {
        discoveryToken:conversation.discoveryToken,
        discoveryStartedAt:conversation.discoveryStartedAt,
        knownConversationIds:conversation.knownConversationIds,
        projectRoot:runtime?.projectRoot ?? this.projectRoot,
        cwd:runtime?.conversationCwd ?? this.cwd,
        environment:runtimeEnvironment,
        signal:discoveryController.signal,
        startedAt:this.startedAt,
      }).then(async conversationId => {
        if (generation !== this.generation || this.process !== child || this.closed) return;
        if (typeof conversationId !== 'string' || conversationId.length < 3
          || conversationId.length > 512 || conversationId.startsWith('-')
          || /[\0\r\n]/.test(conversationId)) {
          throw terminalError('INVALID_AGENT_CONVERSATION_ID', 'Agent 会话 ID 无效');
        }
        this.conversationId = conversationId;
        this.conversationError = null;
        if (this.discoveryController === discoveryController) this.discoveryController = null;
        this.#publishState();
        await onConversationStarted(provider, conversationId);
      }).catch(error => {
        if (generation !== this.generation || this.process !== child || this.closed) return;
        if (this.discoveryController === discoveryController) this.discoveryController = null;
        this.conversationError = error?.message || 'Agent 会话标识保存失败';
        this.#publishState();
      });
    }
    return this.snapshot();
  }

  #deliverOutput(chunk) {
    if (typeof chunk !== 'string' || !chunk) return;
    this.clientOutput = `${this.clientOutput}${chunk}`.slice(-MAX_BUFFER_CHARS);
    this.#broadcast({ type:'output', data:chunk });
  }

  #discardHistoryProjection() {
    this.historyProjection?.dispose?.();
    this.historyProjection = null;
    this.historyProjectionPending = false;
    this.historyProjectionFlushing = false;
    this.historyProjectionTail = '';
    this.historyProjectionCallbacks.length = 0;
  }

  #flushHistoryProjection(onComplete = null) {
    if (typeof onComplete === 'function') this.historyProjectionCallbacks.push(onComplete);
    if (!this.historyProjectionPending || !this.historyProjection
      || this.historyProjectionFlushing) return;
    this.historyProjectionFlushing = true;
    this.historyProjectionTail = '';
    const projection = this.historyProjection;
    const generation = this.generation;
    Promise.resolve(projection.snapshot()).then(serialized => {
      if (generation !== this.generation || projection !== this.historyProjection) return;
      const projected = String(serialized ?? '').slice(-MAX_BUFFER_CHARS);
      const tail = this.historyProjectionTail;
      this.clientOutput = projected;
      this.#broadcast({ type:'projection', data:projected });
      this.historyProjectionPending = false;
      this.historyProjectionFlushing = false;
      this.historyProjectionTail = '';
      this.historyProjection = null;
      projection.dispose?.();
      if (tail) this.#deliverOutput(tail);
      this.startupPhase = this.promptCapabilityConfirmed ? 'ready' : this.startupPhase;
      this.#publishState();
      const callbacks = this.historyProjectionCallbacks.splice(0);
      for (const callback of callbacks) callback();
    }).catch(() => {
      if (generation !== this.generation || projection !== this.historyProjection) return;
      // 极少数序列化失败时一次性回放环形缓冲，仍避免历史按 PTY chunk
      // 逐块触发浏览器渲染；Agent 会话与交互状态保持可用。
      const fallback = this.output.slice(-MAX_BUFFER_CHARS);
      this.clientOutput = fallback;
      this.#broadcast({ type:'projection', data:fallback });
      this.historyProjectionPending = false;
      this.historyProjectionFlushing = false;
      this.historyProjectionTail = '';
      this.historyProjection = null;
      projection.dispose?.();
      this.startupPhase = this.promptCapabilityConfirmed ? 'ready' : this.startupPhase;
      this.#publishState();
      const callbacks = this.historyProjectionCallbacks.splice(0);
      for (const callback of callbacks) callback();
    });
  }

  input(data) {
    if (!this.process || this.state !== 'running') {
      throw terminalError('AGENT_TERMINAL_STOPPED', 'Agent 终端尚未启动');
    }
    if (typeof data !== 'string' || data.length === 0 || data.length > MAX_INPUT_CHARS) {
      throw terminalError('INVALID_TERMINAL_INPUT', '终端输入长度无效');
    }
    // 当前进程第一次确认真实输入框之前一律锁住键盘，覆盖新建和恢复会话；
    // 后续 Agent turn 工作时 promptReady 虽会暂时为 false，但能力闸门已经确认，
    // Esc/Ctrl+C 等交互仍可正常传给 CLI。目录信任、Codex 更新和启动选择页是
    // 输入框之前的显式交互，必须例外允许用户作答。
    if ((!this.promptCapabilityConfirmed
      || this.historyProjectionPending
      || ['pending', 'submitting', 'awaiting-confirmation'].includes(this.startupPromptState))
      && !this.interactionRequired) return;
    this.process.write(data);
    if (this.interactionRequired && /[\r\nyYnN12]/.test(data)) {
      this.interactionResponsePending = true;
      this.interactionScanOutput = '';
    }
    // xterm 的独立 Escape 键是单字节 ESC；方向键等控制序列以 ESC 开头但
    // 长度大于 1，不能误判为用户中断当前 Agent 批次。
    if (data === '\u001b') {
      const event = Object.freeze({ source:'escape-key', at:new Date().toISOString() });
      for (const listener of this.interruptListeners) {
        try {
          const pending = listener(event);
          pending?.catch?.(() => {});
        } catch { /* 批次状态同步失败不能阻断 ESC 传给 CLI */ }
      }
    }
  }

  submitPrompt(text) {
    return this.#queuePrompt(text);
  }

  waitUntilReady({ timeoutMs = 10_000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('等待终端就绪的超时时间无效');
    }
    const ready = () => this.state === 'running'
      && this.promptReady
      && !this.historyProjectionPending
      && this.turnState === 'idle'
      && !this.interactionRequired
      && !['pending', 'submitting', 'awaiting-confirmation'].includes(this.startupPromptState)
      && !['writing', 'awaiting-confirmation'].includes(this.promptSubmission?.state);
    if (ready()) return Promise.resolve(this.snapshot());
    if (['failed', 'exited', 'closed'].includes(this.state)) {
      return Promise.reject(terminalError(
        'AGENT_TERMINAL_UNAVAILABLE',
        this.exit?.message || 'Agent 终端不可用',
      ));
    }
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        this.stateListeners.delete(onState);
      };
      const onState = state => {
        if (state.state === 'running'
          && state.promptReady
          && state.resumePending !== true
          && state.turnState === 'idle'
          && !state.interactionRequired
          && !['pending', 'submitting', 'awaiting-confirmation'].includes(state.startupPromptState)
          && !['writing', 'awaiting-confirmation'].includes(state.promptSubmission?.state)) {
          cleanup();
          resolve(state);
        } else if (['failed', 'exited', 'closed'].includes(state.state)) {
          cleanup();
          reject(terminalError(
            'AGENT_TERMINAL_UNAVAILABLE',
            state.exit?.message || 'Agent 终端不可用',
          ));
        }
      };
      this.stateListeners.add(onState);
      timer = setTimeout(() => {
        cleanup();
        if (this.interactionRequired) {
          reject(terminalError(
            'AGENT_TERMINAL_INTERACTION_REQUIRED',
            this.interactionRequired.message,
          ));
          return;
        }
        reject(terminalError(
          'AGENT_TERMINAL_INITIALIZING',
          '等待 Agent 初始指令自动回车超时',
        ));
      }, timeoutMs);
      // 注册 listener 后再复核一次，封住“检查状态”和“注册监听”之间的竞态。
      onState(this.snapshot());
    });
  }

  waitUntilStartupPromptSubmitted({ timeoutMs = 10_000 } = {}) {
    return this.#waitForPromptSubmission({ startup:true, timeoutMs });
  }

  waitUntilPromptSubmission(submissionId, { timeoutMs = 10_000 } = {}) {
    if (typeof submissionId !== 'string' || !submissionId) {
      throw new TypeError('Agent Prompt 提交标识无效');
    }
    return this.#waitForPromptSubmission({ submissionId, timeoutMs });
  }

  #waitForPromptSubmission({ submissionId = null, startup = false, timeoutMs }) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('等待 Agent Prompt 提交的超时时间无效');
    }
    const matches = state => state.promptSubmission
      && (startup ? state.promptSubmission.startup === true : state.promptSubmission.id === submissionId);
    const settle = state => {
      if (!matches(state)) return null;
      if (state.promptSubmission.state === 'submitted') return { status:'resolved', state };
      if (state.promptSubmission.state === 'failed') {
        return {
          status:'rejected',
          error:terminalError(
            'AGENT_PROMPT_NOT_SUBMITTED',
            state.promptSubmission.error || 'Agent 没有确认收到提示词',
          ),
        };
      }
      return null;
    };
    const immediate = settle(this.snapshot());
    if (immediate?.status === 'resolved') return Promise.resolve(immediate.state);
    if (immediate?.status === 'rejected') return Promise.reject(immediate.error);
    if (['failed', 'exited', 'closed'].includes(this.state)) {
      return Promise.reject(terminalError(
        'AGENT_TERMINAL_UNAVAILABLE',
        this.exit?.message || 'Agent 终端不可用',
      ));
    }
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        this.stateListeners.delete(onState);
      };
      const onState = state => {
        const result = settle(state);
        if (result?.status === 'resolved') {
          cleanup();
          resolve(result.state);
        } else if (result?.status === 'rejected') {
          cleanup();
          reject(result.error);
        } else if (['failed', 'exited', 'closed'].includes(state.state)) {
          cleanup();
          reject(terminalError(
            'AGENT_TERMINAL_UNAVAILABLE',
            state.exit?.message || 'Agent 终端不可用',
          ));
        }
      };
      this.stateListeners.add(onState);
      timer = setTimeout(() => {
        cleanup();
        reject(terminalError(
          'AGENT_PROMPT_SUBMIT_TIMEOUT',
          '等待 Agent 确认收到提示词超时',
        ));
      }, timeoutMs);
      onState(this.snapshot());
    });
  }

  #queuePrompt(text, { startup = false } = {}) {
    if (!this.process || this.state !== 'running') {
      throw terminalError('AGENT_TERMINAL_STOPPED', 'Agent 终端尚未启动');
    }
    if (this.interactionRequired) {
      throw terminalError(
        'AGENT_TERMINAL_INTERACTION_REQUIRED',
        this.interactionRequired.message,
      );
    }
    if (!startup && !this.promptReady) {
      throw terminalError(
        this.turnState === 'active' ? 'AGENT_TERMINAL_BUSY' : 'AGENT_TERMINAL_INITIALIZING',
        this.turnState === 'active' ? 'Agent 当前回合仍在处理，不能提交下一批任务' : 'Agent 终端输入框尚未就绪',
      );
    }
    if (!startup && this.historyProjectionPending) {
      throw terminalError(
        'AGENT_TERMINAL_INITIALIZING',
        'Agent 终端正在投影恢复后的最终画面',
      );
    }
    if (!startup && this.turnState !== 'idle') {
      throw terminalError('AGENT_TERMINAL_BUSY', 'Agent 当前回合仍在处理，不能提交下一批任务');
    }
    if (!startup && ['pending', 'submitting', 'awaiting-confirmation'].includes(
      this.startupPromptState,
    )) {
      throw terminalError('AGENT_TERMINAL_INITIALIZING', 'Agent 终端正在提交初始指令');
    }
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_INPUT_CHARS) {
      throw terminalError('INVALID_AGENT_PROMPT', 'Agent 任务提示长度无效');
    }
    if (this.pendingSubmitTimer !== null
      || ['writing', 'awaiting-confirmation'].includes(this.promptSubmission?.state)) {
      throw terminalError('AGENT_PROMPT_PENDING', '上一条 Agent 任务仍在提交中');
    }
    const runtimeText = this.activeRuntime?.translateText
      ? this.activeRuntime.translateText(text)
      : text;
    const safeText = runtimeText.replaceAll('\u001b', '');
    const child = this.process;
    const generation = this.generation;
    const submissionId = `prompt-${this.promptSubmissionSequence += 1}`;
    this.promptSubmission = {
      id:submissionId,
      state:'writing',
      startup,
      attempts:0,
      createdAt:new Date().toISOString(),
      acceptedAt:null,
      error:null,
    };
    this.activePromptSubmissionId = null;
    this.turnCompletionSeen = false;
    this.turnState = 'submitting';
    if (startup) {
      this.startupPromptState = 'submitting';
      this.#publishState();
    }
    const windowsClaude = this.platform === 'win32' && this.provider === 'claude-code';
    const submitDelay = windowsClaude
      ? Math.min(6_000, 3_000 + Math.ceil(Buffer.byteLength(safeText, 'utf8') / 4_000) * 500)
      : (this.platform === 'win32'
          ? Math.min(4_000, 1_000 + Math.ceil(Buffer.byteLength(safeText, 'utf8') / 4_000) * 500)
          : 120);
    const submissionActive = () => this.process === child
      && this.generation === generation
      && this.state === 'running'
      && this.promptSubmission?.id === submissionId;
    const failSubmission = () => {
      this.pendingSubmitTimer = null;
      if (!submissionActive()) return;
      this.promptSubmission = {
        ...this.promptSubmission,
        state:'failed',
        error:'自动回车后 Agent 没有确认收到提示词，请在终端中检查并手动提交',
      };
      if (startup) this.startupPromptState = 'failed';
      this.#publishState();
    };
    const sendEnter = () => {
      this.pendingSubmitTimer = null;
      if (!submissionActive()) return;
      const attempts = this.promptSubmission.attempts + 1;
      this.promptReady = false;
      this.inputVisible = false;
      this.turnState = 'submitting';
      this.interactionScanOutput = '';
      this.promptSubmission = {
        ...this.promptSubmission,
        state:'awaiting-confirmation',
        attempts,
      };
      if (startup) this.startupPromptState = 'awaiting-confirmation';
      this.pendingSubmitTimer = this.scheduleSubmit(() => {
        this.pendingSubmitTimer = null;
        if (!submissionActive() || this.promptSubmission.state !== 'awaiting-confirmation') return;
        if (this.promptSubmission.attempts < PROMPT_ACK_MAX_ATTEMPTS) sendEnter();
        else failSubmission();
      }, PROMPT_ACK_TIMEOUT_MS);
      this.#publishState();
      child.write('\r');
    };
    const beginSubmit = () => {
      this.pendingSubmitTimer = null;
      if (!submissionActive()) return;
      sendEnter();
    };
    const windowsPty = this.platform === 'win32';
    if (!windowsPty) {
      child.write(`\u001b[200~${safeText}\u001b[201~`);
      this.pendingSubmitTimer = this.scheduleSubmit(beginSubmit, submitDelay);
      return submissionId;
    }

    // Windows ConPTY 没有 write drain 回执。三种 TUI 都可能在一次大块
    // bracketed paste 中丢掉头尾或紧随其后的 Enter，因此统一按 UTF-8
    // 字节分块；Claude Code 保留更长的渲染等待，Codex / OpenCode 则使用
    // 同一可靠写入边界和较短的 settle 时间。
    const chunks = splitUtf8(safeText, WINDOWS_PROMPT_CHUNK_BYTES);
    let chunkIndex = 0;
    const writeNext = () => {
      this.pendingSubmitTimer = null;
      if (!submissionActive()) return;
      if (chunkIndex < chunks.length) {
        child.write(chunks[chunkIndex]);
        chunkIndex += 1;
        this.pendingSubmitTimer = this.scheduleSubmit(writeNext, WINDOWS_PROMPT_CHUNK_DELAY_MS);
        return;
      }
      child.write('\u001b[201~');
      this.pendingSubmitTimer = this.scheduleSubmit(beginSubmit, submitDelay);
    };
    child.write('\u001b[200~');
    this.pendingSubmitTimer = this.scheduleSubmit(writeNext, WINDOWS_PROMPT_CHUNK_DELAY_MS);
    return submissionId;
  }

  resize(cols, rows) {
    if (!this.process || this.state !== 'running') return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)
      || cols < 2 || cols > 500 || rows < 2 || rows > 300) return;
    this.terminalCols = cols;
    this.terminalRows = rows;
    this.historyProjection?.resize?.(cols, rows);
    this.process.resize(cols, rows);
  }

  async stop({ clear = false } = {}) {
    this.discoveryController?.abort();
    this.discoveryController = null;
    if (this.pendingSubmitTimer !== null) {
      this.cancelScheduledSubmit(this.pendingSubmitTimer);
      this.pendingSubmitTimer = null;
    }
    const child = this.process;
    if (child) {
      let exitTimer;
      let exitSubscription;
      const exited = new Promise(resolve => {
        const settle = () => {
          if (exitTimer !== undefined) clearTimeout(exitTimer);
          exitSubscription?.dispose?.();
          resolve();
        };
        try { exitSubscription = child.onExit(settle); }
        catch { resolve(); return; }
        // Windows ConPTY 需要给 native handle 一个确定的回收窗口；超时后仍继续
        // 关闭服务，避免坏掉的第三方 CLI 永久卡住 Editor。
        exitTimer = setTimeout(settle, this.platform === 'win32' ? 2_000 : 500);
      });
      this.generation += 1;
      this.process = null;
      try { child.kill(); } catch { /* 进程可能已经退出 */ }
      await exited;
    }
    this.#discardHistoryProjection();
    if (clear) {
      this.output = '';
      this.clientOutput = '';
    }
    this.startupPromptState = null;
    this.promptSubmission = null;
    this.activePromptSubmissionId = null;
    this.completedPromptSubmissionId = null;
    this.turnCompletionSeen = false;
    this.promptReady = false;
    this.inputVisible = false;
    this.turnState = this.closed ? 'exited' : 'stopped';
    this.startupPhase = null;
    this.startupPhaseDetail = null;
    this.interactionRequired = null;
    this.interactionResponsePending = false;
    this.interactionScanOutput = '';
    this.activeCommand = null;
    this.activeRuntime = null;
    if (!this.closed) this.state = 'stopped';
    this.exit = null;
    this.#publishState();
  }

  async restart(options = {}) {
    await this.stop({ clear:true });
    return this.start(options);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.stop({ clear:false });
    this.state = 'closed';
    this.#publishState();
    this.sockets.clear();
    this.providerChangeListeners.clear();
    this.stateListeners.clear();
    this.interruptListeners.clear();
  }
}
