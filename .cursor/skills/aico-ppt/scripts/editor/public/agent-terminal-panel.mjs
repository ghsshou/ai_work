import {
  agentProviderDefinition,
  isAgentProviderId,
  publicAgentProviders,
} from './agent-provider-registry.mjs';
import { enhanceSelect } from './native-controls.mjs';
import { applyPill } from './pill-nav.mjs';
import { shouldForwardTerminalKey } from './terminal-keyboard.mjs';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function terminalSocketUrl(token, editorToken) {
  const url = new URL('/agent-terminal', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  url.searchParams.set('editorToken', editorToken);
  return url;
}

function cssPixels(style, property) {
  const value = Number.parseFloat(style[property]);
  return Number.isFinite(value) ? value : 0;
}

function terminalCellSize(host, terminal) {
  // xterm 在隐藏容器内初始化时，screen 高度可能仍是上一轮错误 rows 的结果。
  // 优先使用 renderer 已测得的真实 cell，避免用错误 screen / rows 继续放大误差。
  const renderedCell = terminal?._core?._renderService?.dimensions?.css?.cell;
  if (Number.isFinite(renderedCell?.width) && renderedCell.width > 0
    && Number.isFinite(renderedCell?.height) && renderedCell.height > 0) {
    return { width:renderedCell.width, height:renderedCell.height };
  }
  const measure = host.querySelector('.xterm-char-measure-element')?.getBoundingClientRect();
  const measuredText = host.querySelector('.xterm-char-measure-element')?.textContent ?? '';
  const measuredWidth = measure?.width && measuredText.length ? measure.width / measuredText.length : 0;
  const measuredHeight = measure?.height
    ? measure.height * (Number(terminal?.options?.lineHeight) || 1)
    : 0;
  if (measuredWidth > 0 && measuredHeight > 0) {
    return { width:measuredWidth, height:measuredHeight };
  }
  const screen = host.querySelector('.xterm-screen')?.getBoundingClientRect();
  const cellWidth = screen?.width && terminal?.cols ? screen.width / terminal.cols : 0;
  const cellHeight = screen?.height && terminal?.rows ? screen.height / terminal.rows : 0;
  return {
    width:Number.isFinite(cellWidth) && cellWidth > 0 ? cellWidth : 7.25,
    height:Number.isFinite(cellHeight) && cellHeight > 0 ? cellHeight : 16.2,
  };
}

function terminalSize(host, terminal) {
  const style = getComputedStyle(host);
  const width = Math.max(
    host.clientWidth - cssPixels(style, 'paddingLeft') - cssPixels(style, 'paddingRight'),
    160,
  );
  const height = Math.max(
    host.clientHeight - cssPixels(style, 'paddingTop') - cssPixels(style, 'paddingBottom'),
    100,
  );
  const cell = terminalCellSize(host, terminal);
  return {
    cols:Math.max(20, Math.min(500, Math.floor(width / cell.width))),
    rows:Math.max(6, Math.min(300, Math.floor(height / cell.height))),
  };
}

function providerLabel(provider) {
  try { return agentProviderDefinition(provider).label; }
  catch { return provider; }
}

const TERMINAL_WIDTH_KEY = 'aico-ppt-agent-terminal-width-v2';
const MIN_TERMINAL_WIDTH = 340;
const MIN_CANVAS_COLUMN_WIDTH = 480;

function defaultTerminalWidth() {
  return Math.round(window.innerWidth / 3);
}

function storedTerminalWidth() {
  try {
    const value = Number(localStorage.getItem(TERMINAL_WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? value : defaultTerminalWidth();
  } catch {
    return defaultTerminalWidth();
  }
}

export class AgentTerminalPanel {
  constructor(root, { token, editorToken, onClose = () => {}, onState = () => {} }) {
    if (!root) throw new TypeError('缺少 Agent 终端容器');
    if (typeof globalThis.Terminal !== 'function') throw new Error('xterm.js 未加载');
    this.root = root;
    this.token = token;
    this.editorToken = editorToken;
    this.onClose = onClose;
    this.onState = onState;
    this.provider = 'codex';
    this.socket = null;
    this.opened = false;
    this.reconnectTimer = null;
    this.disposed = false;
    this.width = storedTerminalWidth();
    this.resizeDrag = null;
    this.fitFrame = null;
    this.fitCallbacks = [];
    this.focusAfterFit = false;
    this.scrollAfterFit = false;
    this.restartPending = false;
    this.hasTerminalOutput = false;
    this.loadingCopy = '正在准备 Agent 会话…';
    this.terminalState = { provider:'codex', state:'stopped' };
    this.#build();
  }

  #build() {
    const header = element('header', 'agent-terminal-header');
    const identity = element('div', 'agent-terminal-identity');
    this.presence = element('span', 'agent-terminal-presence');
    this.title = element('strong', '', 'Codex 终端');
    this.detail = element('span', 'agent-terminal-detail', '正在连接本地终端…');
    this.detail.setAttribute('role', 'status');
    this.detail.setAttribute('aria-live', 'assertive');
    identity.append(this.presence, this.title, this.detail);

    const actions = element('div', 'agent-terminal-header-actions');
    this.providerSelect = element('select', 'agent-terminal-provider');
    this.providerSelect.dataset.agentTerminalProvider = '';
    this.providerSelect.setAttribute('aria-label', '选择终端 Agent');
    for (const { id, label } of publicAgentProviders()) {
      const option = element('option', '', label);
      option.value = id;
      this.providerSelect.append(option);
    }
    this.providerSelect.addEventListener('change', () => {
      this.provider = this.providerSelect.value;
      this.#restart(this.provider, { newConversation:false });
    });
    const providerControl = enhanceSelect(this.providerSelect, { minimumMenuWidth:150 }).root;
    const fresh = element('button', 'agent-terminal-command', '新会话');
    fresh.type = 'button';
    fresh.dataset.agentTerminalCommand = 'new-session';
    fresh.title = '结束当前 CLI 并创建全新可恢复会话；以后继续任务会恢复这个新会话';
    fresh.addEventListener('click', () => {
      this.#restart(this.provider, { newConversation:true });
    });
    applyPill(fresh, { variant:'dark', size:'sm', kind:'action' });
    const close = element('button', 'agent-terminal-close', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭 Agent 终端抽屉');
    applyPill(close, { variant:'dark', size:'sm', kind:'icon' });
    close.addEventListener('click', () => this.onClose());
    actions.append(providerControl, fresh, close);
    header.append(identity, actions);

    const commandBar = element('div', 'agent-terminal-commandbar');
    commandBar.append(
      element('span', 'agent-terminal-bypass', 'BYPASS'),
      this.command = element('code', '', 'codex --dangerously-bypass-approvals-and-sandbox'),
    );
    this.host = element('div', 'agent-terminal-host');
    this.host.dataset.agentTerminalHost = '';
    this.resizer = element('div', 'agent-terminal-resizer');
    this.resizer.dataset.agentTerminalResizer = '';
    this.resizer.tabIndex = 0;
    this.resizer.setAttribute('role', 'separator');
    this.resizer.setAttribute('aria-orientation', 'vertical');
    this.resizer.setAttribute('aria-label', '调整 Agent 终端宽度');
    this.resizer.title = '左右拖动调整终端宽度';
    this.resizer.addEventListener('pointerdown', event => this.#startWidthDrag(event));
    this.resizer.addEventListener('pointermove', event => this.#moveWidthDrag(event));
    this.resizer.addEventListener('pointerup', event => this.#finishWidthDrag(event));
    this.resizer.addEventListener('pointercancel', event => this.#finishWidthDrag(event));
    this.resizer.addEventListener('keydown', event => this.#resizeWithKeyboard(event));
    this.root.replaceChildren(this.resizer, header, commandBar, this.host);

    this.terminal = new globalThis.Terminal({
      allowProposedApi:false,
      cursorBlink:true,
      cursorStyle:'block',
      fontFamily:'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize:12,
      lineHeight:1.25,
      scrollback:10_000,
      theme:{
        background:'#15171b', foreground:'#e5e7eb', cursor:'#ef4444',
        cursorAccent:'#15171b', selectionBackground:'#7f1d1d99',
        black:'#15171b', red:'#ef4444', green:'#22c55e', yellow:'#f59e0b',
        blue:'#60a5fa', magenta:'#c084fc', cyan:'#22d3ee', white:'#e5e7eb',
        brightBlack:'#6b7280', brightRed:'#f87171', brightGreen:'#4ade80',
        brightYellow:'#fbbf24', brightBlue:'#93c5fd', brightMagenta:'#d8b4fe',
        brightCyan:'#67e8f9', brightWhite:'#f9fafb',
      },
    });
    this.terminal.open(this.host);
    // xterm 默认会把 Ctrl+V 编码成 0x16 送给 PTY，Codex 会把它解释为
    // “粘贴图片”。Windows / Linux 下让浏览器继续产生 paste 事件，
    // xterm 的既有 paste handler 再把剪贴板文字向 PTY 交付一次。
    this.terminal.attachCustomKeyEventHandler(event => shouldForwardTerminalKey(event, {
      platform:navigator.platform,
      hasSelection:this.terminal.hasSelection(),
    }));
    this.loading = element('div', 'agent-terminal-loading');
    this.loading.dataset.agentTerminalLoading = '';
    this.loading.hidden = true;
    this.loading.setAttribute('role', 'status');
    this.loading.setAttribute('aria-live', 'polite');
    this.loading.append(
      element('span', 'agent-terminal-loading-spinner'),
      this.loadingText = element('span', 'agent-terminal-loading-text', this.loadingCopy),
    );
    this.host.append(this.loading);
    this.terminal.onData(data => this.#send({ type:'input', data }));
    this.resizeObserver = new ResizeObserver(() => this.#requestFit());
    this.resizeObserver.observe(this.host);
    this.onWindowResize = () => this.#setWidth(this.width);
    window.addEventListener('resize', this.onWindowResize);
    this.#setWidth(this.width);
  }

  #widthBounds() {
    const workspace = this.root.parentElement;
    const pagePanel = workspace?.querySelector('.page-panel');
    const style = workspace ? getComputedStyle(workspace) : null;
    const gap = Number.parseFloat(style?.columnGap ?? '8') || 8;
    const pageWidth = pagePanel?.getBoundingClientRect().width ?? 232;
    const available = (workspace?.clientWidth ?? window.innerWidth)
      - pageWidth - MIN_CANVAS_COLUMN_WIDTH - gap * 2;
    const maximum = Math.max(MIN_TERMINAL_WIDTH, Math.min(900, Math.floor(available)));
    return { minimum:Math.min(MIN_TERMINAL_WIDTH, maximum), maximum };
  }

  #setWidth(value, { persist = false } = {}) {
    const { minimum, maximum } = this.#widthBounds();
    this.width = Math.round(Math.max(
      minimum,
      Math.min(maximum, Number(value) || defaultTerminalWidth()),
    ));
    this.root.closest('.editor-shell')?.style.setProperty('--agent-terminal-width', `${this.width}px`);
    this.resizer.setAttribute('aria-valuemin', String(minimum));
    this.resizer.setAttribute('aria-valuemax', String(maximum));
    this.resizer.setAttribute('aria-valuenow', String(this.width));
    this.resizer.setAttribute('aria-valuetext', `${this.width} 像素`);
    if (persist) {
      try { localStorage.setItem(TERMINAL_WIDTH_KEY, String(this.width)); } catch { /* 无持久化权限 */ }
    }
  }

  #startWidthDrag(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    this.resizeDrag = { pointerId:event.pointerId, startX:event.clientX, startWidth:this.width };
    this.root.dataset.resizing = 'true';
    this.resizer.setPointerCapture(event.pointerId);
  }

  #moveWidthDrag(event) {
    if (!this.resizeDrag || event.pointerId !== this.resizeDrag.pointerId) return;
    this.#setWidth(this.resizeDrag.startWidth + this.resizeDrag.startX - event.clientX);
  }

  #finishWidthDrag(event) {
    if (!this.resizeDrag || event.pointerId !== this.resizeDrag.pointerId) return;
    this.resizeDrag = null;
    this.root.dataset.resizing = 'false';
    if (this.resizer.hasPointerCapture(event.pointerId)) this.resizer.releasePointerCapture(event.pointerId);
    this.#setWidth(this.width, { persist:true });
    this.terminal.focus();
  }

  #resizeWithKeyboard(event) {
    const directions = { ArrowLeft:1, ArrowRight:-1 };
    if (event.key === 'Home') {
      event.preventDefault();
      this.#setWidth(this.#widthBounds().minimum, { persist:true });
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      this.#setWidth(this.#widthBounds().maximum, { persist:true });
      return;
    }
    if (!directions[event.key]) return;
    event.preventDefault();
    this.#setWidth(this.width + directions[event.key] * (event.shiftKey ? 48 : 16), { persist:true });
  }

  #size() { return terminalSize(this.host, this.terminal); }

  #fit() {
    if (!this.opened || this.host.clientWidth <= 0 || this.host.clientHeight <= 0) return false;
    const { cols, rows } = this.#size();
    if (this.terminal.cols === cols && this.terminal.rows === rows) return false;
    this.terminal.resize(cols, rows);
    return true;
  }

  #requestFit({ focus = false, scrollToBottom = false, after } = {}) {
    this.focusAfterFit ||= focus;
    // xterm 在 resize 后会异步刷新 viewport；如果调整尺寸前已经位于末端，
    // Windows 的 Chrome 也必须继续跟随输入区，不能把提示符留在可视区下方。
    this.scrollAfterFit ||= scrollToBottom || this.#isAtBottom();
    if (typeof after === 'function') this.fitCallbacks.push(after);
    if (this.fitFrame !== null) return;
    let pass = 0;
    const run = () => {
      this.fitFrame = -1;
      this.#fit();
      pass += 1;
      if (pass < 3 && this.opened) {
        this.fitFrame = requestAnimationFrame(run);
        return;
      }
      this.fitFrame = null;
      const size = { cols:this.terminal.cols, rows:this.terminal.rows };
      this.#send({ type:'resize', ...size });
      if (this.scrollAfterFit) {
        this.#scrollToBottom();
        requestAnimationFrame(() => {
          if (!this.disposed) this.#scrollToBottom();
        });
      }
      if (this.focusAfterFit && this.opened) this.terminal.focus();
      this.scrollAfterFit = false;
      this.focusAfterFit = false;
      const callbacks = this.fitCallbacks.splice(0);
      for (const callback of callbacks) callback(size);
    };
    this.fitFrame = requestAnimationFrame(run);
  }

  #isAtBottom() {
    const viewport = this.host.querySelector('.xterm-viewport');
    if (!viewport) return true;
    return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2;
  }

  #scrollToBottom() {
    this.terminal.scrollToBottom();
    // xterm 在 Windows Chromium 中偶尔先更新 buffer，下一帧才同步
    // viewport；同时钉住原生滚动容器，避免输入行停在可视区下方。
    const viewport = this.host.querySelector('.xterm-viewport');
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }

  #setLoading(active, copy = this.loadingCopy) {
    this.loadingCopy = copy;
    this.loadingText.textContent = copy;
    this.loading.hidden = !active;
    this.root.dataset.terminalLoading = active ? 'true' : 'false';
  }

  #wslUser(state = this.terminalState) {
    if (state?.provider !== 'codex') return null;
    const labelUser = /Codex（WSL [^/）]+\/([^）]+)）/.exec(state.providerLabel ?? '')?.[1];
    if (labelUser) return labelUser;
    const commandUser = /(?:^|\s)-u\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(
      state.command ?? '',
    );
    if (!/^wsl(?:\.exe)?(?:\s|$)/i.test(state.command ?? '') || !commandUser) return null;
    return commandUser[1] ?? commandUser[2] ?? commandUser[3] ?? null;
  }

  #startupPhaseCopy(state = this.terminalState) {
    const user = state.startupPhaseDetail?.user ?? this.#wslUser(state);
    if (state.startupPhase === 'wsl-preparing') {
      return user
        ? `WSL 准备：正在唤醒 ${user} 环境并加载 Codex…`
        : 'WSL 准备：正在唤醒环境并加载 Codex…';
    }
    if (state.startupPhase === 'codex-starting') {
      return 'Codex 启动：正在等待 CLI 输入界面…';
    }
    if (state.startupPhase === 'history-redraw') {
      return '历史重绘：正在恢复最终终端画面…';
    }
    if (state.startupPhase === 'agent-starting') {
      return 'Agent 启动：正在等待 CLI 输入界面…';
    }
    return null;
  }

  #syncLoading() {
    const state = this.terminalState;
    if (state.interactionRequired?.kind) {
      this.#setLoading(false);
      return;
    }
    const startupPromptState = state.startupPromptState;
    if (startupPromptState === 'awaiting-confirmation') {
      this.#setLoading(true, '正在确认初始化指令已发送…');
      return;
    }
    if (startupPromptState === 'submitting') {
      this.#setLoading(true, '正在提交初始化指令…');
      return;
    }
    const phaseCopy = this.#startupPhaseCopy(state);
    if (phaseCopy && state.startupPhase !== 'ready') {
      this.#setLoading(true, phaseCopy);
      return;
    }
    if (state.state === 'starting' || startupPromptState === 'pending') {
      const wslUser = this.#wslUser(state);
      this.#setLoading(true, wslUser
        ? `正在进入 ${wslUser} WSL，等待 Codex 输入界面…`
        : this.loadingCopy);
      return;
    }
    if (state.resumePending === true) {
      const wslUser = this.#wslUser(state);
      this.#setLoading(true, wslUser
        ? `正在恢复 ${wslUser} WSL 会话，等待 Codex 输入界面…`
        : '正在恢复 Codex 会话，正在等待输入界面…');
      return;
    }
    if (state.state === 'running' && !this.hasTerminalOutput) {
      this.#setLoading(true, 'CLI 已启动，正在等待输入界面…');
      return;
    }
    this.#setLoading(false);
  }

  #restart(provider, { newConversation = false } = {}) {
    const switchingProvider = provider !== this.terminalState.provider;
    this.restartPending = true;
    this.hasTerminalOutput = false;
    this.#setLoading(true, newConversation
      ? '正在创建会话并读取项目规则…'
      : switchingProvider
        ? '正在切换 Agent…'
        : '正在恢复之前的会话…');
    this.terminal.reset();
    this.#adoptState({
      ...this.terminalState,
      provider,
      state:'starting',
      pid:null,
      exit:null,
    });
    this.#requestFit({
      scrollToBottom:true,
      after:size => this.#send({ type:'restart', provider, newConversation, ...size }),
    });
  }

  #send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  #connect() {
    if (this.disposed || !this.opened
      || [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.socket?.readyState)) return;
    const socket = new WebSocket(terminalSocketUrl(this.token, this.editorToken));
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      const openingProvider = this.provider;
      if (!this.hasTerminalOutput && this.terminalState.state !== 'running') {
        this.#setLoading(true, '正在连接 Agent 会话…');
      }
      this.#requestFit({
        scrollToBottom:true,
        after:size => {
          // fit 会跨三帧执行。若这期间用户切换了 Provider，#restart 已经排入
          // 同一批回调；旧的重连 start 必须失效，否则会对新 Provider 连续发送
          // start + restart，造成刚创建的会话立刻被杀掉并再次恢复。
          if (this.socket === socket && !this.restartPending && this.provider === openingProvider) {
            this.#send({ type:'start', provider:openingProvider, ...size });
          }
        },
      });
    });
    socket.addEventListener('message', event => {
      if (this.socket !== socket) return;
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === 'snapshot') {
        this.restartPending = false;
        this.terminal.reset();
        this.hasTerminalOutput = Boolean(message.output);
        if (message.output) {
          this.terminal.write(message.output, () => this.#requestFit({ scrollToBottom:true }));
        } else {
          this.#requestFit({ scrollToBottom:true });
        }
        this.#adoptState(message.terminal);
      } else if (message.type === 'projection' && typeof message.data === 'string') {
        if (this.restartPending) return;
        this.terminal.reset();
        this.hasTerminalOutput = Boolean(message.data);
        if (message.data) {
          this.terminal.write(message.data, () => this.#requestFit({ scrollToBottom:true }));
        } else {
          this.#requestFit({ scrollToBottom:true });
        }
      } else if (message.type === 'output' && typeof message.data === 'string') {
        if (this.restartPending) return;
        if (message.data.length > 0) {
          this.hasTerminalOutput = true;
          // PTY 的首段输出可能早于 running/pending 状态到达浏览器。输出只说明
          // shell 有内容，不代表初始化回车已经写入；遮罩必须统一由状态机决定。
          this.#syncLoading();
        }
        const followOutput = this.#isAtBottom();
        this.terminal.write(message.data, () => {
          if (followOutput) this.#scrollToBottom();
        });
      } else if (message.type === 'state') {
        this.#adoptState(message.terminal);
      } else if (message.type === 'error') {
        const errorMessage = message.message || '终端操作失败';
        this.restartPending = false;
        this.#setLoading(false);
        this.detail.textContent = errorMessage;
        this.detail.title = errorMessage;
        this.terminal.write(`\r\n\u001b[31m启动失败：${errorMessage}\u001b[0m\r\n`);
        this.root.dataset.terminalState = 'failed';
        this.onState({ ...this.terminalState, state:'failed', message:errorMessage });
      }
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.opened || this.disposed) return;
      this.detail.textContent = '终端连接中断，正在重连…';
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.#connect(), 500);
    });
  }

  #adoptState(state) {
    if (!state?.provider || !state?.state) return;
    if (this.restartPending && state.state === 'starting') this.terminal.reset();
    if (this.restartPending && ['running', 'failed', 'exited'].includes(state.state)) {
      this.restartPending = false;
      this.#requestFit({ scrollToBottom:true });
    }
    this.terminalState = state;
    this.root.dataset.conversationId = state.conversationId ?? '';
    this.provider = state.provider;
    this.providerSelect.value = state.provider;
    this.providerSelect.__nativeControl?.sync();
    const label = providerLabel(state.provider);
    this.title.textContent = `${label} 终端`;
    this.command.textContent = state.command ?? ({
      codex:'codex --dangerously-bypass-approvals-and-sandbox',
      'claude-code':'claude --dangerously-skip-permissions',
      opencode:'opencode',
    }[state.provider] ?? state.provider);
    const conversationLabel = state.conversationId
      ? ` · 会话 ${state.conversationId.slice(-8)}`
      : '';
    const interactionRequired = state.interactionRequired?.kind
      ? state.interactionRequired
      : null;
    const promptSubmissionError = state.promptSubmission?.state === 'failed'
      ? state.promptSubmission.error || 'Agent 没有确认收到提示词'
      : null;
    const startupPhaseCopy = this.#startupPhaseCopy(state);
    const copies = {
      starting:startupPhaseCopy ?? '正在启动 bypass 会话…', running:promptSubmissionError
        ?? (state.startupPromptState === 'awaiting-confirmation'
          ? '初始化指令已回车，正在等待 Agent 接收…'
          : startupPhaseCopy
            ?? (state.promptReady === false
              ? 'CLI 已启动，正在等待输入界面…'
              : state.conversationError
                ? '会话已启动 · 恢复标识保存失败'
                : `${state.projectRoot?.split('/').filter(Boolean).at(-1) || '项目'}${conversationLabel} · PID ${state.pid ?? '—'}`)),
      exited:state.exit?.message || '会话已退出', failed:state.exit?.message || '启动失败',
      stopped:'尚未启动', closed:'服务已关闭',
    };
    this.#syncLoading();
    this.detail.textContent = interactionRequired?.message ?? copies[state.state] ?? state.state;
    this.detail.title = interactionRequired?.message
      ?? state.conversationError
      ?? this.detail.textContent;
    this.root.dataset.terminalState = state.state;
    this.root.dataset.interactionRequired = interactionRequired?.kind ?? '';
    this.onState(state);
    if (interactionRequired && this.opened) {
      this.#requestFit({ focus:true, scrollToBottom:true });
    }
  }

  open(provider = this.provider) {
    this.opened = true;
    this.#setWidth(this.width);
    this.provider = isAgentProviderId(provider) ? provider : 'codex';
    this.providerSelect.value = this.provider;
    this.providerSelect.__nativeControl?.sync();
    this.root.hidden = false;
    this.#connect();
    this.#requestFit({ focus:true, scrollToBottom:true });
  }

  hide() {
    this.opened = false;
    this.root.hidden = true;
  }

  focus() { this.terminal.focus(); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.reconnectTimer);
    if (this.fitFrame !== null && this.fitFrame !== -1) cancelAnimationFrame(this.fitFrame);
    this.fitFrame = null;
    this.fitCallbacks.length = 0;
    this.resizeObserver.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    this.socket?.close();
    this.socket = null;
    this.terminal.dispose();
  }
}
