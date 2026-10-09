import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CreationDraftFileAdapter } from './creation-draft-file-adapter.mjs';
import { CreationDraftStore } from './creation-draft-store.mjs';
import { DeckFactory } from './deck-factory.mjs';
import {
  buildAdaptiveTocInstructions,
  buildSkillContractInstructions,
  buildTemplatePlanInstructions,
} from './deck-quality-contract.mjs';
import { TemplateCatalog } from './template-catalog.mjs';

const EDITOR_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(EDITOR_DIR, '../..');
const CREATION_CLI = join(EDITOR_DIR, 'cli.mjs');
const EDIT_BUNDLE = join(PROJECT_DIR, 'scripts/edit-bundle.py');
const DECK_FACTORY = join(EDITOR_DIR, 'deck_factory.py');
const TEMPLATE_CATALOG = join(EDITOR_DIR, 'template-catalog.json');

function diagnostic(error) {
  return {
    code:error?.code ?? 'GENERATION_FAILED',
    message:error?.message ?? 'Deck 生成失败',
    at:new Date().toISOString(),
  };
}

function quoteCreationArgument(value) {
  const escaped = String(value).replaceAll("'", process.platform === 'win32' ? "''" : "'\\''");
  return `'${escaped}'`;
}

function creationCapabilityArgument(capabilityPath) {
  return capabilityPath ? ` --capability-file ${quoteCreationArgument(capabilityPath)}` : '';
}

export function buildCreationInitializationPrompt({ projectRoot, capabilityPath } = {}) {
  return [
    '/aico-ppt',
    '',
    '你正在 AICO-PPT 编辑器的“新建 Deck”构建工作区中。',
    `项目目录：${projectRoot}`,
    ...buildSkillContractInstructions({ skillRoot:PROJECT_DIR }),
    '当前页面在 Deck 出现前只有对话工作区；请通过自然对话逐步问清主题与标题、听众、场景与时长、期望行动、现有素材、品牌和交付格式。',
    '不要要求用户去页面填写表单或点击阶段按钮。对话负责探索，受控 CLI 和里程碑文件负责持久化共识。',
    '每当用户在对话中确认一层共识，就读取最新 revision，并用受控 CLI 更新、确认对应内容，例如：',
    `node ${quoteCreationArgument(CREATION_CLI)} creation status${creationCapabilityArgument(capabilityPath)}`,
    `node ${quoteCreationArgument(CREATION_CLI)} creation templates${creationCapabilityArgument(capabilityPath)}`,
    `node ${quoteCreationArgument(CREATION_CLI)} creation update-brief${creationCapabilityArgument(capabilityPath)} --json /absolute/path/brief.json`,
    `node ${quoteCreationArgument(CREATION_CLI)} creation confirm-brief${creationCapabilityArgument(capabilityPath)} --expected-revision <最新 revision>`,
    '传给 --json 的文件是命令 payload：update-brief 使用 {"patch":{...}}；propose-outline 使用 {"outline":{"sections":[...]}}；propose-page-plan 使用 {"pagePlan":{"pages":[...]}}。',
    '在确认需求前必须先用 creation templates 读取完整页型目录；availablePageTypes 同时包含当前场景原生页与经过兼容性审核的共享页，并给出 visualFamily、density、rhythmRole、useWhen 和来源模板。把场景外壳选择写入 brief.recommendedTemplateId 后才能规划页面。',
    '用 propose-outline / confirm-outline、propose-page-plan / confirm-page-plan 依次沉淀大纲与页面规划；用户在对话中的明确同意就是确认依据。',
    'pageTypeId 必须来自所选模板目录；封面 cover 排第一、目录 toc 排第二、感谢页 thanks 排最后，三者必须各有且只有一页。',
    '页面不会提供前三步的结构化编辑器或确认按钮。完成页面规划后，由你执行 set-output，再执行 start-generation。',
    'set-output payload 形如 {"output":{"fileName":"主题.html","templateId":"training|tech-share|work-report|qualification|project-review","includePlan":true,"trialPptx":false,"autoOpenEditor":true}}。独立 Deck 一出现，页面会自动显示 Deck 画布。',
    `当前 Draft capability 文件：${capabilityPath}。每次 creation CLI 命令均须加 --capability-file 参数；文件由服务维护，恢复后仍读取同一路径，不要读取、打印或复制其中凭据。`,
    `不要修改内置模板，也不要直接覆盖最终输出文件。独立 Deck 出现后，系统会给出 Editor 托管工作副本；结构制作只编辑该工作副本，并且必须通过 ${EDIT_BUNDLE}。`,
  ].join('\n');
}

export function buildCreationResumePrompt({ snapshot, capabilityPath } = {}) {
  const milestones = snapshot?.milestones ?? fallbackMilestones(snapshot ?? {});
  const completed = Object.entries(milestones)
    .filter(([, value]) => value?.complete)
    .map(([key]) => ({ brief:'需求', outline:'大纲', pagePlan:'页面规划', deck:'Deck' })[key] ?? key);
  const managed = snapshot?.managedDeck;
  const lines = [
    '/aico-ppt',
    '',
    `继续 AICO-PPT Creation Draft：${snapshot?.draftId ?? '未知 Draft'}。`,
    `当前标题：${snapshot?.brief?.title || '未命名 Deck'}`,
    `当前阶段：${snapshot?.phase ?? 'brief'}；revision：${snapshot?.revision ?? 0}。`,
    `已完成里程碑：${completed.length ? completed.join('、') : '暂无'}。`,
    '你正在恢复同一个 Agent 会话和同一份 Draft。先读取最新状态与已有过程文件，再从未完成的位置继续；不要重复询问已经明确的信息。',
    `node ${quoteCreationArgument(CREATION_CLI)} creation status${creationCapabilityArgument(capabilityPath)}`,
    `当前 Draft capability 文件：${capabilityPath}。每次 creation CLI 命令均须加 --capability-file 参数；文件由服务维护，恢复后仍读取同一路径，不要读取、打印或复制其中凭据。`,
    `后续仍必须通过受控 creation CLI 更新 Draft；生成阶段的结构制作必须通过 ${EDIT_BUNDLE} 修改 Editor 托管工作副本。`,
  ];
  if (managed) {
    lines.push(
      `Editor 托管工作副本：${managed.workingDeckPath}`,
      `Editor CLI URL：${managed.serviceUrl}`,
      `Editor CLI token：${managed.token}`,
      '不要修改 staging 源文件或真实输出 Deck；每次安全保存工作副本后，创建页画布会自动刷新。',
    );
  }
  return lines.join('\n');
}

function fallbackMilestones(snapshot) {
  const item = (complete, state) => ({ complete, state:complete ? 'complete' : state });
  const briefComplete = snapshot.briefConfirmedRevision !== null;
  const outlineComplete = snapshot.outlineStatus === 'confirmed'
    && snapshot.outlineConfirmedRevision !== null;
  const pagePlanComplete = snapshot.pagePlanStatus === 'confirmed'
    && snapshot.pagePlanConfirmedRevision !== null;
  const deckComplete = Boolean(
    snapshot.generation?.stagingDeck
    && ['editing', 'verifying', 'published'].includes(snapshot.generation.status),
  );
  return {
    brief:item(briefComplete, 'active'),
    outline:item(outlineComplete, snapshot.outlineStatus === 'stale'
      ? 'stale' : briefComplete ? 'active' : 'pending'),
    pagePlan:item(pagePlanComplete, snapshot.pagePlanStatus === 'stale'
      ? 'stale' : outlineComplete ? 'active' : 'pending'),
    deck:item(deckComplete, snapshot.generation?.status === 'failed'
      ? 'failed' : snapshot.generation?.status === 'preparing'
        ? 'working' : pagePlanComplete ? 'active' : 'pending'),
  };
}

export function buildGenerationPrompt(snapshot, { template = null, capabilityPath = null } = {}) {
  const managed = snapshot.managedDeck ?? null;
  const deckPath = managed?.workingDeckPath
    ?? snapshot.generation.stagingDeckPath ?? snapshot.generation.stagingDeck;
  const planPath = snapshot.generation.stagingPlanPath ?? snapshot.generation.stagingPlan;
  const tocContractPath = snapshot.generation.stagingTocContractPath
    ?? snapshot.generation.stagingTocContract;
  const pagePlanContractPath = snapshot.generation.stagingPagePlanContractPath
    ?? snapshot.generation.stagingPagePlanContract;
  const instructions = [
    '页面规划已经由用户确认，现在开始制作初版 Deck。',
    ...buildSkillContractInstructions({ skillRoot:PROJECT_DIR }),
    ...buildTemplatePlanInstructions({
      template, pagePlan:snapshot.pagePlan, pagePlanContractPath,
    }),
    ...buildAdaptiveTocInstructions({
      outline:snapshot.outline,
      tocContractPath,
    }),
    `Editor 托管工作副本：${deckPath}`,
    `staging 源文件（禁止直接修改）：${snapshot.generation.stagingDeckPath ?? snapshot.generation.stagingDeck}`,
    `plan.md：${planPath}`,
    `结构制作、模板升级和页面增删排序必须经 ${EDIT_BUNDLE} 修改上述托管工作副本，保持 slide DOM、nav[]、chapters[] 同步。`,
    `页面规划使用“借自”其他模板的共享页型时，必须调用受控导入：python3 "${DECK_FACTORY}" import-page <工作副本> --catalog "${TEMPLATE_CATALOG}" --template-id ${snapshot.output?.templateId ?? '<场景模板>'} --page-type-id <页型> --label <新标签> --before-label <后页标签> --nav-code <两字码> --plan-page-id <pageId> --plan-chapter-id <chapterId>。该命令会复制页面、补齐来源标记并合并所需 manifest 资源。`,
    '已有元素的文字、样式、移动、缩放和显隐优先通过 Editor CLI action 提交；不要修改真实输出 Deck，也不要手工改补丁块。',
    '封面与感谢页带有结构锁，只替换必要文字；目录页只锁定位置和模板身份，内部条目与动画必须按目录契约重建。',
    '按页面或小批次安全保存工作副本；每次保存都会进入统一历史并自动刷新创建页画布，不要让用户按 Cmd/Ctrl+R。',
  ];
  if (managed) {
    instructions.push(
      `Editor CLI URL：${managed.serviceUrl}`,
      `Editor CLI token：${managed.token}`,
      `查看 revision：node "${CREATION_CLI}" --url "${managed.serviceUrl}" --token "${managed.token}" revision`,
      `唯一文字替换示例：node "${CREATION_CLI}" --url "${managed.serviceUrl}" --token "${managed.token}" replace-text "旧文字" "新文字"`,
    );
  }
  instructions.push(
    '完成后先自行检查，再执行：',
    `node ${quoteCreationArgument(CREATION_CLI)} creation status${creationCapabilityArgument(capabilityPath)}`,
    `node ${quoteCreationArgument(CREATION_CLI)} creation generation-ready${creationCapabilityArgument(capabilityPath)} --expected-revision <最新 revision>`,
    '服务会先固化 Managed Workspace，再独立执行 bundle verify、全页 overflow 检查和不覆盖发布。终端中的自然语言“完成”不算回执。',
  );
  return instructions.join('\n');
}

export class DeckCreationWorkspace {
  static async create({
    projectRoot,
    provider = 'codex',
    draftId = randomUUID(),
    catalog = null,
    pythonExecutable = 'python3',
    commandRunner,
    capabilityToken = randomUUID(),
    serviceUrl,
    openManagedDeck = null,
  } = {}) {
    return DeckCreationWorkspace.#open({
      create:true, projectRoot, provider, draftId, catalog, pythonExecutable,
      commandRunner, capabilityToken, serviceUrl, openManagedDeck,
    });
  }

  static async open({
    projectRoot,
    draftId,
    catalog = null,
    pythonExecutable = 'python3',
    commandRunner,
    capabilityToken = randomUUID(),
    serviceUrl,
    openManagedDeck = null,
  } = {}) {
    return DeckCreationWorkspace.#open({
      create:false, projectRoot, draftId, catalog, pythonExecutable,
      commandRunner, capabilityToken, serviceUrl, openManagedDeck,
    });
  }

  static async #open({
    create,
    projectRoot,
    provider = 'codex',
    draftId,
    catalog,
    pythonExecutable,
    commandRunner,
    capabilityToken,
    serviceUrl,
    openManagedDeck,
  }) {
    const adapter = await (create
      ? CreationDraftFileAdapter.create({ projectRoot, draftId })
      : CreationDraftFileAdapter.open({ projectRoot, draftId }));
    try {
      const store = create
        ? await CreationDraftStore.create({
            adapter, draftId, projectRoot:adapter.projectRoot, provider,
          })
        : await CreationDraftStore.open({ adapter });
      const templateCatalog = catalog ?? await TemplateCatalog.open();
      const factory = await DeckFactory.create({
        projectRoot:adapter.projectRoot,
        draftDir:adapter.draftDir,
        catalog:templateCatalog,
        pythonExecutable,
        ...(commandRunner ? { commandRunner } : {}),
      });
      const capabilityPath = join(adapter.draftDir, 'agent-capability.json');
      if (!create) await unlink(capabilityPath).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      await writeFile(capabilityPath, `${JSON.stringify({
        version:1, scope:'creation-draft', token:capabilityToken,
        ...(serviceUrl ? { url:serviceUrl } : {}),
      })}\n`, { encoding:'utf8', mode:0o600, flag:'wx' });
      return new DeckCreationWorkspace({
        store, factory, catalog:templateCatalog, capabilityToken, capabilityPath,
        openManagedDeck, pythonExecutable,
      });
    } catch (error) {
      await adapter.close().catch(() => {});
      throw error;
    }
  }

  constructor({
    store, factory, catalog = null, terminal = null, capabilityToken = null,
    capabilityPath = null, openManagedDeck = null, pythonExecutable = 'python3',
  }) {
    if (!store?.snapshot || !store?.dispatch || !factory?.prepare) {
      throw new TypeError('DeckCreationWorkspace 依赖无效');
    }
    this.store = store;
    this.factory = factory;
    this.catalog = catalog;
    this.terminal = terminal;
    this.capabilityToken = capabilityToken;
    this.capabilityPath = capabilityPath;
    this.openManagedDeck = openManagedDeck;
    this.pythonExecutable = pythonExecutable;
    this.managedDeck = null;
    this.closed = false;
  }

  snapshot() {
    const snapshot = this.store.snapshot();
    if (snapshot.generation) {
      const draftDir = this.store.adapter?.draftDir;
      if (draftDir && snapshot.generation.stagingDeck) {
        snapshot.generation.stagingDeckPath = join(draftDir, snapshot.generation.stagingDeck);
      }
      if (draftDir && snapshot.generation.stagingPlan) {
        snapshot.generation.stagingPlanPath = join(draftDir, snapshot.generation.stagingPlan);
      }
      if (draftDir && snapshot.generation.stagingTocContract) {
        snapshot.generation.stagingTocContractPath = join(
          draftDir,
          snapshot.generation.stagingTocContract,
        );
      }
      if (draftDir && snapshot.generation.stagingPagePlanContract) {
        snapshot.generation.stagingPagePlanContractPath = join(
          draftDir,
          snapshot.generation.stagingPagePlanContract,
        );
      }
    }
    snapshot.milestones = this.store.adapter?.artifactSnapshot?.()
      ?? fallbackMilestones(snapshot);
    const managed = this.managedDeck?.snapshot?.() ?? null;
    if (managed) snapshot.managedDeck = managed;
    const publishedPreview = snapshot.generation?.status === 'published'
      && snapshot.generation?.publishedDeck
      ? snapshot.generation.publishedDeck
      : null;
    const previewPath = managed?.workingDeckPath ?? publishedPreview ?? this.previewDeckPath();
    snapshot.previewDeck = previewPath ? {
      path:previewPath,
      revision:managed?.revision
        ?? (publishedPreview ? snapshot.generation.fingerprint : null)
        ?? snapshot.milestones.deck?.artifact?.revision
        ?? snapshot.revision,
      status:snapshot.generation?.status ?? 'editing',
      ...(managed ? { editorUrl:managed.editorUrl, managed:true } : {}),
    } : null;
    return snapshot;
  }

  previewDeckPath() {
    const snapshot = this.store.snapshot();
    if (snapshot.generation?.status === 'published' && snapshot.generation?.publishedDeck) {
      return snapshot.generation.publishedDeck;
    }
    return this.store.adapter?.previewDeckPath?.() ?? null;
  }

  get draftDir() { return this.store.adapter?.draftDir ?? null; }
  get draftId() { return this.store.snapshot().draftId; }

  templates() { return this.catalog?.snapshot?.() ?? { version:2, templates:[] }; }

  async attachTerminal(terminal) {
    this.terminal = terminal;
    const snapshot = this.snapshot();
    if (snapshot.generation?.stagingDeck
      && ['editing', 'failed', 'published'].includes(snapshot.generation.status)) {
      await this.#ensureManagedDeck();
    }
  }

  subscribe(listener) { return this.store.subscribe(listener); }

  async #ensureManagedDeck() {
    if (!this.openManagedDeck || !this.terminal) return this.managedDeck;
    const snapshot = this.snapshot();
    const published = snapshot.generation?.status === 'published'
      && snapshot.generation?.publishedDeck;
    const sourceDeckPath = published
      ? snapshot.generation.publishedDeck
      : snapshot.generation?.stagingDeckPath;
    if (!sourceDeckPath) return null;
    if (this.managedDeck?.snapshot?.().sourceDeckPath === sourceDeckPath) return this.managedDeck;
    await this.#closeManagedDeck();
    this.managedDeck = await this.openManagedDeck({
      sourceDeckPath,
      projectRoot:snapshot.projectRoot,
      creationDraft:snapshot,
      provider:snapshot.provider,
      terminal:this.terminal,
      terminalCwd:this.terminal.cwd ?? snapshot.projectRoot,
      pythonExecutable:this.pythonExecutable,
      ...(published ? {
        creationHandoff:{
          draft:snapshot,
          draftDir:this.draftDir,
          conversationId:this.terminal.snapshot?.().conversationId ?? null,
        },
      } : {}),
    });
    return this.managedDeck;
  }

  takePublishedEditor() {
    const snapshot = this.snapshot();
    if (snapshot.generation?.status !== 'published' || !snapshot.generation.publishedDeck) {
      throw Object.assign(new Error('最终 Deck 尚未发布'), {
        code:'CREATION_GATE_UNMET', statusCode:409,
      });
    }
    if (!this.managedDeck
      || this.managedDeck.snapshot?.().sourceDeckPath !== snapshot.generation.publishedDeck
      || typeof this.managedDeck.transfer !== 'function') {
      throw Object.assign(new Error('最终 Deck 的标准编辑工作区尚未就绪'), {
        code:'CREATION_EDITOR_NOT_READY', statusCode:409,
      });
    }
    const editor = this.managedDeck.transfer();
    this.managedDeck = null;
    return editor;
  }

  async #closeManagedDeck() {
    const managed = this.managedDeck;
    this.managedDeck = null;
    await managed?.close?.();
  }

  async #prepare(command) {
    let receipt = await this.store.dispatch(command);
    try {
      await this.#closeManagedDeck();
      const prepared = await this.factory.prepare(receipt.snapshot);
      receipt = await this.store.updateGeneration({ ...prepared, status:'editing' }, 'creation-generation-started');
      const managed = await this.#ensureManagedDeck();
      const view = this.snapshot();
      const template = this.catalog?.resolve?.(view.output?.templateId);
      const prompt = buildGenerationPrompt(view, { template, capabilityPath:this.capabilityPath });
      await this.store.updateGeneration({
        agentTask:managed
          ? '通过 Editor Managed Workspace 制作初版 Deck'
          : '在 staging Deck 制作初版 Deck',
      }, 'creation-generation-progress');
      await managed?.waitUntilReady?.({ timeoutMs:20_000 });
      if (this.terminal?.snapshot?.().state === 'running') {
        try {
          await this.terminal.waitUntilReady?.({ timeoutMs:10_000 });
          const submissionId = this.terminal.submitPrompt(prompt);
          if (typeof this.terminal.waitUntilPromptSubmission === 'function') {
            await this.terminal.waitUntilPromptSubmission(submissionId, { timeoutMs:10_000 });
          }
        }
        catch { /* PTY 失败不丢失已经持久化的生成任务 */ }
      }
      return { ...receipt, snapshot:this.snapshot() };
    } catch (error) {
      await this.store.updateGeneration({
        status:'failed', diagnostics:[diagnostic(error)], completedAt:new Date().toISOString(),
      }, 'creation-failed');
      throw error;
    }
  }

  async #verifyAndPublish(command) {
    await this.store.dispatch(command);
    try {
      const managed = await this.#ensureManagedDeck();
      await managed?.preparePublish?.();
      const verified = await this.factory.verify(this.snapshot());
      await this.store.updateGeneration(verified, 'creation-verification-updated');
      const published = await this.factory.publish(this.snapshot());
      const receipt = await this.store.updateGeneration({
        ...published,
        status:'published',
        completedAt:new Date().toISOString(),
      }, 'creation-published');
      await this.#ensureManagedDeck();
      this.store.notify?.('creation-final-editor-ready');
      return { ...receipt, snapshot:this.snapshot() };
    } catch (error) {
      const current = this.snapshot();
      if (current.generation?.status === 'published') throw error;
      await this.store.updateGeneration({
        status:'failed',
        diagnostics:[...(current.generation?.diagnostics ?? []), diagnostic(error)],
        completedAt:new Date().toISOString(),
      }, 'creation-failed');
      throw error;
    }
  }

  async dispatch(command) {
    if (this.closed) throw Object.assign(new Error('Deck 创建工作区已关闭'), { code:'SERVICE_CLOSED', statusCode:503 });
    const current = this.snapshot();
    const selectedTemplateId = current.brief?.recommendedTemplateId;
    if (command?.type === 'confirm-brief' && this.catalog?.resolve) {
      this.catalog.resolve(selectedTemplateId);
    }
    if (command?.type === 'propose-page-plan' && this.catalog?.validatePagePlan) {
      this.catalog.validatePagePlan(selectedTemplateId, command.pagePlan);
    }
    if (command?.type === 'set-output' && this.catalog?.validatePagePlan) {
      if (command.output?.templateId !== selectedTemplateId) {
        throw Object.assign(new Error('输出模板必须与需求阶段确认的模板一致'), {
          code:'TEMPLATE_SELECTION_CHANGED', statusCode:422,
        });
      }
      this.catalog.validatePagePlan(selectedTemplateId, current.pagePlan);
    }
    if (['start-generation', 'retry-generation'].includes(command?.type)
      && this.catalog?.validatePagePlan) {
      this.catalog.validatePagePlan(current.output?.templateId, current.pagePlan);
    }
    if (command?.type === 'start-generation' || command?.type === 'retry-generation') {
      return this.#prepare(command);
    }
    if (command?.type === 'generation-ready') return this.#verifyAndPublish(command);
    if (command?.type === 'cancel-generation') {
      const receipt = await this.store.dispatch(command);
      await this.#closeManagedDeck();
      return { ...receipt, snapshot:this.snapshot() };
    }
    return this.store.dispatch(command);
  }

  async close({ reason = 'server-stop' } = {}) {
    if (this.closed) return;
    this.closed = true;
    await this.#closeManagedDeck();
    if (this.capabilityPath) await unlink(this.capabilityPath).catch(() => {});
    await this.store.close();
    void reason;
  }
}
