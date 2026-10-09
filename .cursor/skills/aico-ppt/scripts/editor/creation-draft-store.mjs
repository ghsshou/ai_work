import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { AGENT_PROVIDER_IDS } from './agent-provider-registry.mjs';

const PHASES = new Set(['brief', 'outline', 'page-plan', 'generating', 'ready', 'failed']);
const PROVIDERS = new Set(AGENT_PROVIDER_IDS);
const SCENES = new Set(['授课培训', '技术分享', '工作汇报', '学习材料', '任职材料', '项目评审']);
const STRUCTURE_COMMANDS = new Set([
  'update-brief', 'confirm-brief', 'propose-outline', 'confirm-outline',
  'propose-page-plan', 'confirm-page-plan', 'set-output',
]);
const BRIEF_FIELDS = new Set([
  'title', 'scene', 'audience', 'durationMinutes', 'objective', 'materials',
  'brandRequirements', 'deliveryRequirements', 'recommendedTemplateId', 'suggestedPageCount',
]);

function creationError(code, statusCode, message, details) {
  return Object.assign(new Error(message), { code, statusCode, ...(details ? { details } : {}) });
}

function clone(value) {
  return structuredClone(value);
}

function text(value, field, { required = false, maximum = 4000 } = {}) {
  if (value === undefined && !required) return value;
  if (typeof value !== 'string') throw creationError('INVALID_CREATION_COMMAND', 400, `${field} 必须是字符串`);
  const result = value.trim();
  if (required && !result) throw creationError('CREATION_GATE_UNMET', 409, `${field} 尚未填写`);
  if (result.length > maximum) throw creationError('INVALID_CREATION_COMMAND', 400, `${field} 内容过长`);
  return result;
}

function positiveInteger(value, field, { allowZero = false, maximum = 10_000 } = {}) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > maximum) {
    throw creationError('INVALID_CREATION_COMMAND', 400, `${field} 必须是有效整数`);
  }
  return value;
}

function normalizeBriefPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw creationError('INVALID_CREATION_COMMAND', 400, 'patch 必须是对象');
  }
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!BRIEF_FIELDS.has(key)) throw creationError('INVALID_CREATION_COMMAND', 400, `未知需求字段：${key}`);
    if (key === 'durationMinutes' || key === 'suggestedPageCount') {
      result[key] = value === null || value === '' ? null : positiveInteger(value, key, { maximum:1000 });
    } else if (key === 'scene') {
      if (!SCENES.has(value)) throw creationError('INVALID_CREATION_COMMAND', 400, 'scene 不受支持');
      result[key] = value;
    } else {
      result[key] = text(value, key, { maximum:8000 });
    }
  }
  return result;
}

function normalizeOutline(outline) {
  if (!outline || typeof outline !== 'object' || !Array.isArray(outline.sections)
    || outline.sections.length === 0 || outline.sections.length > 50) {
    throw creationError('INVALID_CREATION_COMMAND', 400, 'outline.sections 必须是非空数组');
  }
  const ids = new Set();
  return {
    sections:outline.sections.map((section, index) => {
      if (!section || typeof section !== 'object' || Array.isArray(section)) {
        throw creationError('INVALID_CREATION_COMMAND', 400, `第 ${index + 1} 个章节无效`);
      }
      const chapterId = text(section.chapterId, 'chapterId', { required:true, maximum:80 });
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(chapterId) || ids.has(chapterId)) {
        throw creationError('INVALID_CREATION_COMMAND', 400, `chapterId 无效或重复：${chapterId}`);
      }
      ids.add(chapterId);
      return {
        chapterId,
        title:text(section.title, '章节标题', { required:true, maximum:160 }),
        objective:text(section.objective, '章节目标', { required:true, maximum:1000 }),
        pageBudget:positiveInteger(section.pageBudget, '页数预算', { maximum:100 }),
        timeBudgetMinutes:positiveInteger(section.timeBudgetMinutes, '时间预算', { maximum:1000 }),
      };
    }),
  };
}

function normalizePagePlan(pagePlan, outline) {
  if (!pagePlan || typeof pagePlan !== 'object' || !Array.isArray(pagePlan.pages)
    || pagePlan.pages.length === 0 || pagePlan.pages.length > 200) {
    throw creationError('INVALID_CREATION_COMMAND', 400, 'pagePlan.pages 必须是非空数组');
  }
  const pageIds = new Set();
  const labels = new Set();
  const chapterIds = new Set(outline?.sections?.map(section => section.chapterId) ?? []);
  return {
    pages:pagePlan.pages.map((page, index) => {
      if (!page || typeof page !== 'object' || Array.isArray(page)) {
        throw creationError('INVALID_CREATION_COMMAND', 400, `第 ${index + 1} 页无效`);
      }
      const pageId = text(page.pageId, 'pageId', { required:true, maximum:100 });
      const label = text(page.label, 'label', { required:true, maximum:120 });
      const chapterId = text(page.chapterId, 'chapterId', { required:true, maximum:80 });
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(pageId) || pageIds.has(pageId)) {
        throw creationError('INVALID_CREATION_COMMAND', 400, `pageId 无效或重复：${pageId}`);
      }
      if (labels.has(label)) throw creationError('INVALID_CREATION_COMMAND', 400, `页面别名重复：${label}`);
      if (!chapterIds.has(chapterId)) throw creationError('INVALID_CREATION_COMMAND', 400, `页面引用了未知章节：${chapterId}`);
      pageIds.add(pageId);
      labels.add(label);
      return {
        pageId,
        chapterId,
        pageTypeId:text(page.pageTypeId, 'pageTypeId', { required:true, maximum:100 }),
        label,
        coreClaim:text(page.coreClaim, '核心观点', { required:true, maximum:1200 }),
        layoutRationale:text(page.layoutRationale, '页型理由', { required:true, maximum:1200 }),
        artwork:text(page.artwork, '配图规格', { required:true, maximum:2000 }),
        steps:positiveInteger(page.steps ?? 0, '讲解拍数', { allowZero:true, maximum:30 }),
      };
    }),
  };
}

function normalizeOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw creationError('INVALID_CREATION_COMMAND', 400, 'output 必须是对象');
  }
  const fileName = text(output.fileName, '输出文件名', { required:true, maximum:180 });
  if (fileName !== fileName.split(/[\\/]/).at(-1)
    || !/^[^\0<>:"|?*]+\.html$/i.test(fileName)
    || fileName === '.' || fileName === '..') {
    throw creationError('INVALID_OUTPUT_NAME', 400, '输出文件名必须是不含路径的 .html 文件名');
  }
  const templateId = text(output.templateId, '模板', { required:true, maximum:80 });
  for (const field of ['includePlan', 'trialPptx', 'autoOpenEditor']) {
    if (typeof output[field] !== 'boolean') {
      throw creationError('INVALID_CREATION_COMMAND', 400, `${field} 必须是布尔值`);
    }
  }
  return {
    fileName, templateId,
    includePlan:output.includePlan,
    trialPptx:output.trialPptx,
    autoOpenEditor:output.autoOpenEditor,
  };
}

function validateBrief(brief) {
  text(brief.title, '标题', { required:true });
  if (!SCENES.has(brief.scene)) throw creationError('CREATION_GATE_UNMET', 409, '尚未选择场景');
  text(brief.audience, '听众', { required:true });
  positiveInteger(brief.durationMinutes, '时长', { maximum:1000 });
  text(brief.objective, '目标', { required:true });
}

function validateState(state) {
  if (!state || state.version !== 1 || typeof state.draftId !== 'string'
    || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !PHASES.has(state.phase) || !PROVIDERS.has(state.provider)) {
    throw creationError('CREATION_DRAFT_CORRUPT', 500, 'Creation Draft 状态无效');
  }
  return state;
}

export function createMemoryCreationDraftAdapter(initial = null) {
  let value = initial ? clone(initial) : null;
  return {
    async load() { return value ? clone(value) : null; },
    async save(next) { value = clone(next); },
    async close() {},
  };
}

export class CreationDraftStore {
  static async create({
    adapter,
    draftId = randomUUID(),
    projectRoot,
    provider = 'codex',
    now = () => new Date().toISOString(),
  } = {}) {
    if (!adapter?.load || !adapter?.save) throw new TypeError('缺少 CreationDraft Adapter');
    if (await adapter.load()) throw creationError('CREATION_DRAFT_EXISTS', 409, 'Creation Draft 已存在');
    if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) {
      throw new TypeError('projectRoot 必须是绝对路径');
    }
    if (!PROVIDERS.has(provider)) throw creationError('INVALID_AGENT_PROVIDER', 400, 'Agent provider 不受支持');
    const timestamp = now();
    const state = {
      version:1,
      draftId,
      revision:0,
      phase:'brief',
      projectRoot,
      provider,
      brief:{
        title:'', scene:'技术分享', audience:'', durationMinutes:null, objective:'',
        materials:'', brandRequirements:'华为红品牌', deliveryRequirements:'HTML',
        recommendedTemplateId:'tech-share', suggestedPageCount:null,
      },
      briefConfirmedRevision:null,
      outline:null,
      outlineStatus:'empty',
      outlineConfirmedRevision:null,
      pagePlan:null,
      pagePlanStatus:'empty',
      pagePlanConfirmedRevision:null,
      output:null,
      generation:null,
      invalidationReason:null,
      createdAt:timestamp,
      updatedAt:timestamp,
    };
    await adapter.save(state);
    return new CreationDraftStore({ adapter, state, now });
  }

  static async open({ adapter, now = () => new Date().toISOString() } = {}) {
    if (!adapter?.load || !adapter?.save) throw new TypeError('缺少 CreationDraft Adapter');
    const state = await adapter.load();
    if (!state) throw creationError('CREATION_DRAFT_NOT_FOUND', 404, 'Creation Draft 不存在');
    return new CreationDraftStore({ adapter, state:validateState(state), now });
  }

  constructor({ adapter, state, now }) {
    this.adapter = adapter;
    this.state = clone(state);
    this.now = now;
    this.listeners = new Set();
    this.closed = false;
    this.queue = Promise.resolve();
  }

  snapshot() { return clone(this.state); }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener 必须是函数');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(eventType = 'creation-runtime-updated') {
    if (this.closed) return null;
    const event = {
      type:eventType,
      revision:this.state.revision,
      snapshot:this.snapshot(),
    };
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* observer 不能破坏运行时状态 */ }
    }
    return event;
  }

  #assertRevision(command) {
    if (!Number.isSafeInteger(command?.expectedRevision) || command.expectedRevision < 0) {
      throw creationError('INVALID_CREATION_COMMAND', 400, 'expectedRevision 必须是非负整数');
    }
    if (command.expectedRevision !== this.state.revision) {
      throw creationError('REVISION_CONFLICT', 409, 'Creation Draft 已更新，请读取最新状态后重试', {
        expectedRevision:command.expectedRevision,
        actualRevision:this.state.revision,
      });
    }
  }

  #invalidateAfterBrief(draft) {
    if (draft.outline) draft.outlineStatus = 'stale';
    if (draft.pagePlan) draft.pagePlanStatus = 'stale';
    draft.briefConfirmedRevision = null;
    draft.outlineConfirmedRevision = null;
    draft.pagePlanConfirmedRevision = null;
    draft.generation = null;
    draft.phase = 'brief';
    draft.invalidationReason = '需求已变化，请重新确认需求、大纲与页面规划';
  }

  #invalidateAfterOutline(draft) {
    if (draft.pagePlan) draft.pagePlanStatus = 'stale';
    draft.outlineConfirmedRevision = null;
    draft.pagePlanConfirmedRevision = null;
    draft.generation = null;
    draft.phase = 'outline';
    draft.invalidationReason = '大纲已变化，请重新确认大纲与页面规划';
  }

  #apply(command) {
    if (!command || typeof command !== 'object' || Array.isArray(command)
      || typeof command.type !== 'string') {
      throw creationError('INVALID_CREATION_COMMAND', 400, 'CreationCommand 无效');
    }
    this.#assertRevision(command);
    if (this.state.phase === 'ready') {
      throw creationError('CREATION_PUBLISHED', 409, 'Deck 已发布，Draft 不能再修改');
    }
    if (this.state.phase === 'generating' && STRUCTURE_COMMANDS.has(command.type)) {
      throw creationError('GENERATION_ACTIVE', 409, '正在生成 Deck；请先取消本次生成再修改结构');
    }
    const draft = clone(this.state);
    const previousPhase = draft.phase;
    const previousConfirmation = {
      brief:draft.briefConfirmedRevision,
      outline:draft.outlineConfirmedRevision,
      pagePlan:draft.pagePlanConfirmedRevision,
    };

    if (command.type === 'update-brief') {
      const patch = normalizeBriefPatch(command.patch);
      const changed = Object.entries(patch).some(([key, value]) => draft.brief[key] !== value);
      draft.brief = { ...draft.brief, ...patch };
      if (changed && draft.briefConfirmedRevision !== null) this.#invalidateAfterBrief(draft);
    } else if (command.type === 'confirm-brief') {
      validateBrief(draft.brief);
      draft.phase = 'outline';
      draft.invalidationReason = null;
    } else if (command.type === 'propose-outline') {
      if (draft.briefConfirmedRevision === null) {
        throw creationError('CREATION_GATE_UNMET', 409, '请先确认主题与场景');
      }
      const next = normalizeOutline(command.outline);
      if (draft.outlineStatus === 'confirmed') this.#invalidateAfterOutline(draft);
      else {
        draft.phase = 'outline';
        if (draft.pagePlan) draft.pagePlanStatus = 'stale';
        draft.pagePlanConfirmedRevision = null;
      }
      draft.outline = next;
      draft.outlineStatus = 'proposed';
    } else if (command.type === 'confirm-outline') {
      if (draft.briefConfirmedRevision === null || !draft.outline
        || !['proposed', 'confirmed'].includes(draft.outlineStatus)) {
        throw creationError('CREATION_GATE_UNMET', 409, '请先确认需求并应用一份大纲方案');
      }
      draft.outlineStatus = 'confirmed';
      draft.phase = 'page-plan';
      draft.invalidationReason = null;
    } else if (command.type === 'propose-page-plan') {
      if (draft.outlineStatus !== 'confirmed' || draft.outlineConfirmedRevision === null) {
        throw creationError('CREATION_GATE_UNMET', 409, '请先确认大纲');
      }
      draft.pagePlan = normalizePagePlan(command.pagePlan, draft.outline);
      draft.pagePlanStatus = 'proposed';
      draft.pagePlanConfirmedRevision = null;
      draft.generation = null;
      draft.phase = 'page-plan';
    } else if (command.type === 'confirm-page-plan') {
      if (draft.outlineStatus !== 'confirmed' || !draft.pagePlan
        || !['proposed', 'confirmed'].includes(draft.pagePlanStatus)) {
        throw creationError('CREATION_GATE_UNMET', 409, '请先提交并检查页面规划');
      }
      draft.pagePlanStatus = 'confirmed';
      draft.phase = 'page-plan';
      draft.invalidationReason = null;
    } else if (command.type === 'set-output') {
      if (draft.pagePlanStatus !== 'confirmed' || draft.pagePlanConfirmedRevision === null) {
        throw creationError('CREATION_GATE_UNMET', 409, '请先确认页面规划');
      }
      draft.output = normalizeOutput(command.output);
      draft.generation = null;
    } else if (command.type === 'start-generation') {
      if (draft.pagePlanStatus !== 'confirmed' || draft.pagePlanConfirmedRevision === null || !draft.output) {
        throw creationError('CREATION_GATE_UNMET', 409, '请先确认页面规划和输出设置');
      }
      draft.phase = 'generating';
      draft.generation = {
        runId:randomUUID(), status:'preparing', stagingDeck:null, stagingPlan:null,
        stagingTocContract:null, stagingPagePlanContract:null,
        diagnostics:[], publishedDeck:null, publishedPlan:null,
        startedAt:this.now(), completedAt:null,
      };
    } else if (command.type === 'retry-generation') {
      if (!draft.generation || !['failed', 'cancelled'].includes(draft.generation.status)) {
        throw creationError('CREATION_GATE_UNMET', 409, '当前没有可重试的生成任务');
      }
      draft.phase = 'generating';
      draft.generation = {
        ...draft.generation, runId:randomUUID(), status:'preparing',
        diagnostics:[], stagingDeck:null, stagingPlan:null, stagingTocContract:null,
        stagingPagePlanContract:null,
        publishedDeck:null, publishedPlan:null,
        startedAt:this.now(), completedAt:null,
      };
    } else if (command.type === 'cancel-generation') {
      if (!draft.generation || draft.phase !== 'generating') {
        throw creationError('CREATION_GATE_UNMET', 409, '当前没有正在运行的生成任务');
      }
      draft.generation.status = 'cancelled';
      draft.generation.completedAt = this.now();
      draft.phase = 'page-plan';
    } else if (command.type === 'generation-ready') {
      const recoverable = draft.phase === 'failed'
        && draft.generation?.status === 'failed' && draft.generation.stagingDeck
        && draft.pagePlanStatus === 'confirmed' && draft.pagePlanConfirmedRevision !== null;
      if (!draft.generation || (draft.phase !== 'generating' && !recoverable)) {
        throw creationError('CREATION_GATE_UNMET', 409, '当前没有等待验证的生成任务');
      }
      // 对原工作副本重新执行完整验证，不通过新建 run 丢弃已完成的内容。
      draft.phase = 'generating';
      draft.generation.completedAt = null;
      draft.generation.status = 'verifying';
      if (command.diagnostics !== undefined) {
        draft.generation.agentReceipt = clone(command.diagnostics);
      }
    } else {
      throw creationError('INVALID_CREATION_COMMAND', 400, `未知 CreationCommand：${command.type}`);
    }

    const nextRevision = draft.revision + 1;
    if (command.type === 'confirm-brief') draft.briefConfirmedRevision = nextRevision;
    if (command.type === 'confirm-outline') draft.outlineConfirmedRevision = nextRevision;
    if (command.type === 'confirm-page-plan') draft.pagePlanConfirmedRevision = nextRevision;
    draft.revision = nextRevision;
    draft.updatedAt = this.now();
    return {
      draft,
      eventType:previousPhase !== draft.phase ? 'creation-phase-changed' : 'creation-draft-updated',
      invalidated:previousConfirmation.brief !== null && draft.briefConfirmedRevision === null
        || previousConfirmation.outline !== null && draft.outlineConfirmedRevision === null
        || previousConfirmation.pagePlan !== null && draft.pagePlanConfirmedRevision === null,
    };
  }

  dispatch(command) {
    const operation = this.queue.then(async () => {
      if (this.closed) throw creationError('SERVICE_CLOSED', 503, 'Creation Draft 已关闭');
      const { draft, eventType, invalidated } = this.#apply(command);
      await this.adapter.save(draft);
      this.state = draft;
      const event = {
        type:invalidated ? 'creation-confirmation-invalidated' : eventType,
        revision:draft.revision,
        snapshot:this.snapshot(),
      };
      for (const listener of this.listeners) {
        try { listener(event); } catch { /* observer 不能破坏状态提交 */ }
      }
      return { revision:draft.revision, event:event.type, snapshot:this.snapshot() };
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async updateGeneration(patch, eventType = 'creation-generation-progress') {
    const operation = this.queue.then(async () => {
      if (this.closed) throw creationError('SERVICE_CLOSED', 503, 'Creation Draft 已关闭');
      if (!this.state.generation) throw creationError('CREATION_GATE_UNMET', 409, '生成任务不存在');
      const draft = clone(this.state);
      draft.generation = { ...draft.generation, ...clone(patch) };
      if (patch.status === 'failed') draft.phase = 'failed';
      if (patch.status === 'published') draft.phase = 'ready';
      draft.revision += 1;
      draft.updatedAt = this.now();
      await this.adapter.save(draft);
      this.state = draft;
      const event = { type:eventType, revision:draft.revision, snapshot:this.snapshot() };
      for (const listener of this.listeners) {
        try { listener(event); } catch { /* observer 不能破坏状态提交 */ }
      }
      return { revision:draft.revision, event:event.type, snapshot:this.snapshot() };
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    this.listeners.clear();
    await this.adapter.close?.();
  }
}
