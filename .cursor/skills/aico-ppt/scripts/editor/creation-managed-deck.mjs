import { startHeadlessEditorRuntime } from './headless-editor-runtime.mjs';
import { startServer } from './server.mjs';

function managedError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, statusCode:409, ...details });
}

async function responseJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw managedError(
      body.error ?? body.code ?? 'CREATION_MANAGED_DECK_FAILED',
      body.message ?? `Managed Deck 请求失败：HTTP ${response.status}`,
      { response:body },
    );
  }
  return body;
}

/**
 * 新建流程对 Editor Managed Workspace 的窄接口。
 * Creation Draft 不需要知道 sidecar、补丁或浏览器桥接细节。
 */
export class CreationManagedDeck {
  static async open({
    sourceDeckPath,
    projectRoot,
    provider = 'codex',
    terminal,
    terminalCwd = projectRoot,
    pythonExecutable = 'python3',
    editorCloseGraceMs = 10_000,
    creationHandoff = null,
    workspaceHistoryProvider = null,
    dshAgentBridge = false,
    workId = null,
    dshWorkItemProvider = null,
    dshWorkItemCommand = null,
    onEditorClose = null,
    startEditor = options => startServer(options),
  } = {}) {
    if (!sourceDeckPath || !projectRoot || !terminal) {
      throw new TypeError('Creation Managed Deck 缺少 sourceDeckPath、projectRoot 或 terminal');
    }
    let editor = null;
    editor = await startEditor({
      deckPath:sourceDeckPath,
      host:'127.0.0.1',
      port:0,
      openBrowser:false,
      exitWhenEditorCloses:false,
      editorCloseGraceMs,
      agentProvider:provider,
      agentThreadId:terminal.snapshot?.().conversationId ?? null,
      agentProjectRoot:projectRoot,
      agentProjectRootSource:'explicit',
      agentTerminalCwd:terminalCwd,
      autoStartAgentTerminal:false,
      ...(dshAgentBridge ? {} : {
        agentTerminalSession:terminal,
        closeAgentTerminalOnShutdown:false,
      }),
      ...(creationHandoff ? { creationHandoff } : {}),
      ...(workspaceHistoryProvider ? { workspaceHistoryProvider } : {}),
      ...(dshAgentBridge ? {
        dshAgentBridge:true,
        workId,
        dshWorkItemProvider,
        dshWorkItemCommand,
      } : {}),
      ...(onEditorClose ? {
        onClose:() => onEditorClose({ sourceDeckPath, editor }),
      } : {}),
      pythonExecutable,
    });
    try {
      return new CreationManagedDeck({ editor, sourceDeckPath });
    } catch (error) {
      await editor?.close?.().catch(() => {});
      throw error;
    }
  }

  constructor({ editor, sourceDeckPath }) {
    if (!editor?.url || !editor?.token || !editor?.editorToken || !editor?.workingDeckPath) {
      throw new TypeError('Editor Runtime 未返回完整 Managed Workspace capability');
    }
    this.editor = editor;
    this.sourceDeckPath = sourceDeckPath;
    this.closed = false;
  }

  snapshot() {
    return {
      sourceDeckPath:this.sourceDeckPath,
      workingDeckPath:this.editor.workingDeckPath,
      serviceUrl:this.editor.url,
      token:this.editor.token,
      revision:this.editor.session?.revision ?? 0,
      editorUrl:`${this.editor.url}/editor/?token=${encodeURIComponent(this.editor.token)}`
        + `&editorToken=${encodeURIComponent(this.editor.editorToken)}`
        + '&embedded=creation&mode=preview',
    };
  }

  async waitUntilReady(options) {
    if (this.closed) throw managedError('SERVICE_CLOSED', 'Creation Managed Deck 已关闭');
    await this.editor.waitUntilReady?.(options);
  }

  preparePublish() {
    if (this.closed) return Promise.reject(managedError('SERVICE_CLOSED', 'Creation Managed Deck 已关闭'));
    this.publishing ??= this.#publishWithRenderer().finally(() => { this.publishing = null; });
    return this.publishing;
  }

  async #publishWithRenderer() {
    let renderer;
    try {
      if (this.editor.hasEditorConnection?.() === false) {
        renderer = await startHeadlessEditorRuntime({ editorUrl:this.snapshot().editorUrl });
      }
      return await this.#preparePublish();
    } finally { await renderer?.close(); }
  }

  async #preparePublish() {
    if (this.closed) throw managedError('SERVICE_CLOSED', 'Creation Managed Deck 已关闭');
    await this.editor.flushWorkingDeckChanges?.();
    await this.waitUntilReady({ timeoutMs:20_000 });
    const state = this.editor.session;
    if (!state || !Array.isArray(state.groups)) {
      throw managedError('CREATION_MANAGED_DECK_INVALID', 'Managed Deck 缺少权威修改历史');
    }
    if (state.groups.length === 0) {
      return { solidified:false, revision:state.revision, clearedGroupCount:0 };
    }
    const authorization = `Bearer ${this.editor.token}`;
    const preflightResponse = await fetch(`${this.editor.url}/api/solidify-preflight`, {
      method:'POST',
      headers:{
        authorization,
        'content-type':'application/json',
      },
      body:JSON.stringify({ expectedRevision:state.revision }),
    });
    const preflight = await responseJson(preflightResponse);
    const response = await fetch(`${this.editor.url}/api/solidify-deck`, {
      method:'POST',
      headers:{ authorization, 'content-type':'application/json' },
      body:JSON.stringify({
        expectedRevision:state.revision,
        expectedBindingRevision:preflight.bindingRevision,
        preflightToken:preflight.preflightToken,
      }),
    });
    return { solidified:true, ...await responseJson(response) };
  }

  transfer() {
    if (this.publishing) throw managedError('PUBLISH_BUSY', '发布准备尚未结束，不能交接 Editor');
    if (this.closed || !this.editor) {
      throw managedError('SERVICE_CLOSED', 'Creation Managed Deck 已关闭或已经交接');
    }
    const editor = this.editor;
    this.editor = null;
    this.closed = true;
    return editor;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.publishing?.catch(() => {});
    await this.editor?.close?.();
    this.editor = null;
  }
}
