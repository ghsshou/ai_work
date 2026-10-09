import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSkillContractInstructions } from './deck-quality-contract.mjs';

const EDITOR_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(EDITOR_DIR, '../..');
const CLI_PATH = join(EDITOR_DIR, 'cli.mjs');
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const RETRYABLE_TASK_STATUSES = new Set(['pending', 'failed']);

function runnerError(code, statusCode, message) {
  return Object.assign(new Error(message), { code, statusCode });
}

function publicRun(run) {
  if (!run) return { status:'idle' };
  return structuredClone(run);
}

function taskMap(session) {
  return new Map((session?.tasks ?? []).map(task => [task.id, task]));
}

function persistedBatches(session, current) {
  const batches = Array.isArray(session?.agentBatches)
    ? session.agentBatches.map(batch => structuredClone(batch)) : [];
  if (current && !batches.some(batch => batch.id === current.id)) {
    batches.push({
      id:current.id,
      ordinal:current.ordinal,
      provider:current.provider,
      mode:current.mode,
      taskIds:[...current.taskIds],
      createdAt:current.createdAt,
      settlement:null,
    });
  }
  return batches.sort((left, right) => left.ordinal - right.ordinal);
}

export function buildAgentPrompt({
  deckPath, serviceUrl, token, taskIds, sourceThreadId, loadSkill = false,
  skillRoot = SKILL_ROOT, skillInvocation = '$aico-ppt', environmentCredentials = false,
  creationContextPath = null,
}) {
  const cli = environmentCredentials
    ? `node ${JSON.stringify(CLI_PATH)} --url "$AICO_PPT_EDITOR_URL"`
      + ' --token "$AICO_PPT_EDITOR_TOKEN"'
    : `node ${JSON.stringify(CLI_PATH)} --url ${JSON.stringify(serviceUrl)}`
      + ` --token ${JSON.stringify(token)}`;
  const skillContext = loadSkill
    ? [
        skillInvocation,
        '',
        '这是独立打开编辑器后创建的专用任务；首次处理必须加载 Deck 制作规范。',
        `必须使用 aico-ppt skill，并先完整读取 ${JSON.stringify(join(skillRoot, 'SKILL.md'))}。`,
        '按 SKILL.md 的文件导航读取本次修改所需 references；不得跳过 bundle 编辑不变量和视觉规范。',
      ]
    : [
        sourceThreadId
          ? '这是本 Deck 已绑定的 Agent 任务；请沿用已有制作上下文。'
          : '这是独立编辑器的后续批次；请沿用本专用任务已有上下文。',
        'aico-ppt skill 已在本任务中加载，不要再次完整读取 SKILL.md；只在本批修改确有需要时读取对应 reference。',
      ];
  return [
    ...skillContext,
    '',
    `Deck：${deckPath}`,
    ...(creationContextPath ? [
      `Creation 上下文清单：${creationContextPath}`,
      '本批修改必须延续其中已确认的设计决策，并按需复用原素材库。',
    ] : []),
    `本批任务 ID：${JSON.stringify(taskIds)}`,
    `编辑器 CLI 前缀：${cli}`,
    '',
    '请立即批量处理以上任务：',
    `1. 用 ${cli} revision 只读取权威 revision，再对每个本批 ID 用 ${cli} task TASK_ID 读取任务详情；不要用 status 拉取整份历史，只处理本批 ID。`,
    `2. 结合任务区域、附件、Deck 源文件和 aico-ppt 规范判断修改。先区分修改本质：现有元素的文字、样式、移动、缩放、显隐走 ActionMutation；页面结构和复杂 DOM 走 SourceMutation。动作 envelope 为 {expectedRevision,taskId,actions:[{id,taskId,target,kind,payload}]}；target 优先原样使用任务候选中的 pageKey/path/tag/fingerprint/rect。仅当具体 action 字段不确定时，定点读取 ${JSON.stringify(join(skillRoot, 'scripts/editor/protocol.mjs'))} 的 validateAction 与 ${JSON.stringify(join(skillRoot, 'references/editing-guide.md'))} 的“Agent / CLI”小节，不要完整打印两个文件。`,
    '3. ActionMutation：每个任务生成受控 action JSON，并用 CLI apply 提交；发生 REVISION_CONFLICT 时重新读取 revision 后继续。',
    `4. 页面增删排序、模板升级或复杂 DOM 重构：逐个任务先用 ${cli} begin-source-task TASK_ID 创建源码事务，保存返回的 sourceEditId 与预留 revision；只有 begin 成功后，才用 ${JSON.stringify(join(skillRoot, 'scripts/edit-bundle.py'))} 只修改 Deck 所指向的托管工作副本（deckPath），保持 slide / nav / chapters 同步并一次原子保存。写盘成功后必须用 ${cli} --expected-revision PREPARED_REVISION commit-source-edit SOURCE_EDIT_ID 显式登记 SourceMutation；写盘前或写盘后失败则用同一预留 revision 调用 cancel-source-edit SOURCE_EDIT_ID 回滚。删除区域任务所在整页时必须使用任务的 pageKey 调用 delete_page_by_id，不能按页序猜测，也不能用 hide 代替。即使待删除页仍被旧的已固化 action 引用，也不得提前放弃事务或手工修改补丁块；Editor 会在 commit 时仅对 PAGE_NOT_FOUND / TARGET_NOT_FOUND 的已取代固化动作做受控清理并完整重放。commit 成功后再用 ${cli} task TASK_ID 确认 completed，随后才处理下一项。`,
    '5. 不得手工编辑 bundle 或 huawei-deck-editor-patches 块；不调用 write-deck，不调用 /api/shutdown 或任何关闭 / 重启当前 Editor 的接口，不修改真实 Deck，不处理提交按钮之后新增加的任务。',
    '6. 全部处理完后简洁汇总成功、失败和需要用户确认的任务。',
  ].join('\n');
}

export function buildSessionInitializationPrompt({
  deckPath, sourceDeckPath = null, projectPath, skillRoot = SKILL_ROOT,
  skillInvocation = '$aico-ppt', creationContextPath = null,
}) {
  return [
    skillInvocation,
    '',
    '这是 AICO-PPT 编辑器刚创建的专用会话。',
    `项目目录：${projectPath}`,
    `Editor 托管工作副本：${deckPath}`,
    ...(sourceDeckPath ? [`真实 Deck（会话内只读）：${sourceDeckPath}`] : []),
    ...buildSkillContractInstructions({ skillRoot }),
    ...(creationContextPath ? [
      `本 Deck 由“新建 Deck”流程交接而来，Creation 上下文清单：${creationContextPath}`,
      '先读取这份清单，继承其中已确认的 brief、大纲、页面规划、设计文稿与素材库；不要重复询问已经明确的信息。',
    ] : []),
    '后续用户直接在终端提出修改时：现有元素的文字、样式、移动、缩放、显隐必须通过 Editor CLI action 提交；模板升级、页面增删排序和复杂 DOM 重构必须先用 begin-source-edit 取得 sourceEditId 与预留 revision，再用 edit-bundle.py 修改上述托管工作副本，成功后 commit-source-edit，失败时 cancel-source-edit 回滚。删页若取代了旧的已固化 action，仍应正常提交事务，由 Editor 受控清理明确缺页或缺目标的旧补丁。',
    '绝不能改真实 Deck，也不能手工改 huawei-deck-editor-patches 块，不得调用 /api/shutdown 或关闭 / 重启当前 Editor；源码事务显式提交后才会形成可撤销结构历史，只有用户点击“固化修改”才会发布到真实 Deck。',
    '本轮只建立后续编辑上下文，不修改任何文件，不执行任务，也不启动编辑器。',
    '准备完成后只需简洁回复“Deck 编辑会话已准备好”。',
  ].join('\n');
}

export class AgentBatchCoordinator {
  constructor({
    provider, adapter, getSession, getContext,
    captureBatch = null, settleBatch = null,
    onUpdate = () => {},
  }) {
    if (!adapter || adapter.id !== provider || typeof adapter.run !== 'function') {
      throw new TypeError('Agent adapter 与 provider 不匹配');
    }
    this.provider = provider;
    this.adapter = adapter;
    this.getSession = getSession;
    this.getContext = getContext;
    this.captureBatch = captureBatch;
    this.settleBatch = settleBatch;
    this.onUpdate = onUpdate;
    this.current = null;
    this.activePromise = null;
    this.abortController = null;
    this.closed = false;
    this.runGeneration = 0;
    this.cancelMessage = null;
    this.submissionPending = false;
  }

  snapshot() {
    const session = this.getSession();
    const current = publicRun(this.current);
    const batches = persistedBatches(session, this.current);
    const tasks = taskMap(session);
    const active = this.current && ACTIVE_STATUSES.has(this.current.status)
      ? structuredClone(this.current) : null;
    const activeIds = new Set(active?.taskIds ?? []);
    const latestBatchByTask = new Map();
    for (const batch of batches) {
      for (const taskId of batch.taskIds) latestBatchByTask.set(taskId, batch);
    }
    const retryable = [...tasks.values()].filter(task => (
      task.status !== 'completed' && !task.groupId
    ));
    const nextTasks = retryable.filter(task => (
      !activeIds.has(task.id) && !latestBatchByTask.has(task.id)
    ));
    const residualByBatch = new Map();
    for (const task of retryable) {
      if (activeIds.has(task.id)) continue;
      const batch = latestBatchByTask.get(task.id);
      if (!batch) continue;
      const group = residualByBatch.get(batch.id) ?? {
        ...structuredClone(batch), unfinishedTaskIds:[], actionableTaskIds:[],
      };
      group.unfinishedTaskIds.push(task.id);
      if (RETRYABLE_TASK_STATUSES.has(task.status) && task.targetMissing !== true) {
        group.actionableTaskIds.push(task.id);
      }
      residualByBatch.set(batch.id, group);
    }
    const activeBatch = active ? {
      ...active,
      completedCount:active.taskIds.filter(id => tasks.get(id)?.status === 'completed').length,
      unfinishedTaskIds:active.taskIds.filter(id => tasks.get(id)?.status !== 'completed'),
    } : null;
    const nextActionableTaskIds = nextTasks.filter(task => (
      RETRYABLE_TASK_STATUSES.has(task.status) && task.targetMissing !== true
    )).map(task => task.id);
    return {
      ...current,
      sessionRevision:session?.revision,
      activeBatch,
      nextBatch:{
        taskIds:nextTasks.map(task => task.id),
        actionableTaskIds:nextActionableTaskIds,
        count:nextTasks.length,
      },
      residualBatches:[...residualByBatch.values()].sort((left, right) => (
        right.ordinal - left.ordinal
      )),
      canSubmitNext:active === null && nextActionableTaskIds.length > 0,
      batches,
    };
  }

  #publish(patch = {}) {
    Object.assign(this.current, patch, {
      sequence:(this.current.sequence ?? 0) + 1,
      updatedAt:new Date().toISOString(),
    });
    const snapshot = this.snapshot();
    this.onUpdate(snapshot);
    return snapshot;
  }

  #validate({ expectedRevision, taskIds }) {
    if (this.closed) throw runnerError('SERVICE_CLOSED', 503, '编辑服务已关闭');
    if (this.submissionPending || (this.current && ACTIVE_STATUSES.has(this.current.status))) {
      throw runnerError('AGENT_RUN_ACTIVE', 409, '已有一批反馈正在交给 Agent 处理');
    }
    const session = this.getSession();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('expectedRevision 必须为非负整数');
    }
    if (expectedRevision !== session.revision) {
      const error = runnerError('REVISION_CONFLICT', 409, '任务列表已经变化，请刷新后重试');
      error.revision = session.revision;
      throw error;
    }
    if (!Array.isArray(taskIds) || taskIds.length === 0
      || taskIds.some(id => typeof id !== 'string' || !id)
      || new Set(taskIds).size !== taskIds.length) {
      throw new TypeError('taskIds 必须是非空且不重复的字符串数组');
    }
    const tasks = new Map(session.tasks.map(task => [task.id, task]));
    if (taskIds.some(id => !tasks.has(id))) {
      throw runnerError('TASK_NOT_FOUND', 404, '本批任务中包含不存在的任务');
    }
    if (taskIds.some(id => tasks.get(id).targetMissing === true)) {
      throw runnerError(
        'TASK_TARGET_MISSING', 409,
        '本批任务中包含原目标当前不可定位的任务；请撤销相关结构修改或删除任务后重新标记',
      );
    }
    if (taskIds.some(id => !RETRYABLE_TASK_STATUSES.has(tasks.get(id).status))) {
      throw runnerError('TASK_NOT_PENDING', 409, '本批任务中包含无需再次处理的任务');
    }
  }

  async submit({ expectedRevision, taskIds }) {
    this.#validate({ expectedRevision, taskIds });
    if (typeof this.captureBatch !== 'function') {
      return this.start({ expectedRevision, taskIds });
    }
    this.submissionPending = true;
    try {
      const captured = await this.captureBatch({
        expectedRevision,
        taskIds:[...taskIds],
        provider:this.provider,
        mode:this.adapter.mode ?? 'terminal',
      });
      return this.#launch(captured.batch, captured.revision);
    } finally {
      this.submissionPending = false;
    }
  }

  start({ expectedRevision, taskIds }) {
    this.#validate({ expectedRevision, taskIds });
    const now = new Date().toISOString();
    const ordinals = persistedBatches(this.getSession(), null).map(batch => batch.ordinal);
    const batch = {
      id:randomUUID(), ordinal:Math.max(0, ...ordinals) + 1,
      provider:this.provider, mode:this.adapter.mode ?? 'terminal',
      taskIds:[...taskIds], expectedRevision, createdAt:now, settlement:null,
    };
    return this.#launch(batch, expectedRevision);
  }

  #launch(batch, sessionRevision) {
    const now = batch.createdAt ?? new Date().toISOString();
    this.cancelMessage = null;
    this.current = {
      id:batch.id, ordinal:batch.ordinal, provider:this.provider, status:'queued',
      generation:this.runGeneration += 1,
      mode:this.adapter.mode ?? 'terminal',
      taskIds:[...batch.taskIds], taskCount:batch.taskIds.length,
      expectedRevision:batch.expectedRevision ?? sessionRevision,
      sessionRevision,
      createdAt:now, updatedAt:now,
      sequence:0,
      message:'反馈已提交，正在启动 Agent',
    };
    this.onUpdate(this.snapshot());
    this.abortController = new AbortController();
    const runId = this.current.id;
    this.activePromise = Promise.resolve().then(async () => {
      if (this.closed || this.abortController.signal.aborted) {
        throw runnerError('AGENT_RUN_CANCELLED', 409, 'Agent 任务已取消');
      }
      this.#publish({
        ...(this.adapter.submissionAware === true ? {} : { status:'running' }),
        startedAt:new Date().toISOString(),
      });
      const result = await this.adapter.run({
        ...this.getContext(),
        taskIds:[...batch.taskIds],
        signal:this.abortController.signal,
        onProgress:progress => {
          if (this.current?.id !== runId || this.closed) return;
          const progressStatus = ['queued', 'running'].includes(progress?.status)
            ? progress.status : null;
          this.#publish({
            ...(progressStatus ? { status:progressStatus } : {}),
            ...(progress?.mode ? { mode:progress.mode } : {}),
            ...(progress?.message ? { message:String(progress.message).slice(0, 500) } : {}),
          });
        },
      });
      if (this.current?.id !== runId) return;
      const latestTasks = new Map(this.getSession().tasks.map(task => [task.id, task]));
      const unfinishedTaskIds = batch.taskIds.filter(id => (
        latestTasks.get(id)?.status !== 'completed'
      ));
      if (unfinishedTaskIds.length) {
        const needsConfirmationCount = unfinishedTaskIds.filter(id => (
          latestTasks.get(id)?.status === 'needs-confirmation'
        )).length;
        if (needsConfirmationCount > 0) {
          throw runnerError(
            'AGENT_TASKS_NEED_CONFIRMATION', 502,
            `${needsConfirmationCount} 个任务需要补充说明，批次尚未完成`,
          );
        }
        const unchanged = unfinishedTaskIds.length === batch.taskIds.length;
        throw runnerError(
          unchanged ? 'AGENT_TASKS_UNCHANGED' : 'AGENT_TASKS_INCOMPLETE',
          502,
          unchanged
            ? `Agent 进程已结束，但 ${unfinishedTaskIds.length} 个任务仍未处理，可直接重试`
            : `Agent 仅完成部分任务，仍有 ${unfinishedTaskIds.length} 个任务可重试`,
        );
      }
      if (typeof this.settleBatch === 'function') {
        const settled = await this.settleBatch({
          batchId:batch.id,
          outcome:'succeeded',
          message:result?.summary || 'Agent 已完成本批处理',
        });
        if (Number.isSafeInteger(settled?.revision)) this.current.sessionRevision = settled.revision;
      }
      this.#publish({
        status:'succeeded', finishedAt:new Date().toISOString(),
        message:result?.summary || 'Agent 已完成本批处理',
      });
    }).catch(error => {
      if (this.current?.id !== runId) return;
      const cancelled = error?.code === 'AGENT_RUN_CANCELLED' || this.closed;
      const status = cancelled ? 'cancelled' : 'failed';
      const message = cancelled
        ? (this.cancelMessage || 'Agent 任务已取消')
        : (error?.message || 'Agent 批处理失败');
      return Promise.resolve(typeof this.settleBatch === 'function'
        ? this.settleBatch({
            batchId:batch.id,
            outcome:['AGENT_TASKS_INCOMPLETE', 'AGENT_TASKS_NEED_CONFIRMATION'].includes(error?.code)
              ? 'partial' : status,
            code:error?.code ?? 'AGENT_RUN_FAILED',
            message,
          })
        : null).catch(settlementError => ({ settlementError })).then(settled => {
        if (Number.isSafeInteger(settled?.revision)) this.current.sessionRevision = settled.revision;
        this.#publish({
          status,
          finishedAt:new Date().toISOString(),
          code:error?.code ?? 'AGENT_RUN_FAILED',
          message,
          ...(settled?.settlementError ? { settlementPending:true } : {}),
        });
      });
    }).finally(() => {
      if (this.current?.id === runId) {
        this.abortController = null;
        this.cancelMessage = null;
      }
    });
    return this.snapshot();
  }

  cancel(message = 'Agent 任务已取消，可重新提交未完成任务') {
    if (!this.current || !ACTIVE_STATUSES.has(this.current.status)
      || !this.abortController || this.abortController.signal.aborted) return false;
    this.cancelMessage = String(message).slice(0, 500);
    this.abortController.abort();
    return true;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.cancel('编辑服务关闭，Agent 任务已取消');
    await this.activePromise?.catch(() => {});
  }
}

// 兼容既有调用名；新的领域名称统一使用 AgentBatchCoordinator。
export const AgentRunCoordinator = AgentBatchCoordinator;

/** 桌面区域编辑每批只携带必要信息，不再次触发全量 Skill 加载。 */
export function buildEditorBatchPrompt({taskIds,deckPath,serviceUrl,token}) {
  return [
    'AICO-PPT 区域编辑任务：'+JSON.stringify(taskIds),
    '托管工作副本：'+deckPath,
    '先用 aico_ppt({operation:"inspect",taskId}) 读取任务、当前 revision、目标与父容器和截图。已有文字/样式/位置/尺寸/显隐用 operation:"edit"，workId 和 expectedRevision 使用 inspect 返回值，target 原样使用，actions 为 {target,kind,payload} 数组。',
    '区域任务的 edit 必须带原 taskId 和 taskRelation:"supplement"，否则修改不能回写该任务。若用户随后在左侧补充，结合最近追问和任务语义自主判断；属于原任务则继续携带原 taskId，独立新修改用 taskRelation:"new" 且不传 taskId，不结束原任务；多个任务无法区分时才澄清。',
    '形状替换、图片替换、模块增删和局部 HTML 优先 aico_ppt structure，operations 为 {target,kind,payload} 数组，携带 workId、expectedRevision、taskId、taskRelation。插件自动事务、完整重放验证和结果图，不调用 CLI 或写临时 Python；页面整体增删排序、共享样式与脚本才走源码事务。',
    '普通修改不重新读取完整 Skill、设计规范、创建背景或协议源码，不写临时定位/截图脚本。不擅自扩宽或重排无关内容。目标不明确时补查父容器，仍不明确才澄清。',
    'edit 已含提交、局部诊断与结果图。结果成功就无需重复 task/verify；先看图确认。若 visualStatus 待检查用 view；传输不明用 result 查询 commandId，不能重复执行已提交修改。',
    '复杂 DOM、整页删除/增删排序和全局模板变更才读取相应编辑规范，使用 CLI begin-source-task TASK_ID → edit-bundle.py → commit-source-edit；失败 cancel-source-edit，禁止直改真实源文件、手工补丁或退出 Editor。',
    `CLI 备用入口：node ${JSON.stringify(CLI_PATH)} --url ${JSON.stringify(serviceUrl)} --token ${JSON.stringify(token)}。无 aico_ppt 工具时用 inspect TASK_ID OUT.png、apply FILE、view PAGE OUT.png、result COMMAND_ID，图片用 read_image 查看。`,
    '批次结束只报告实际完成与未完成项；未固化修改保持可撤销，不能冒充已发布。',
  ].join('\n');
}
