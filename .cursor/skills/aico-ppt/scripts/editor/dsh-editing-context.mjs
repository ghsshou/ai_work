import { writeWorkspaceCapability } from './workspace-capability.mjs';

/** 按持久会话关联解析现有写入方，绝不按当前 UI 或项目路径猜测。 */
export async function resolveEditingContext({ sessionId, workCatalog, findEditingRuntime, findCreationRuntime }) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw Object.assign(new Error('缺少有效会话标识'), { statusCode:400 });
  }
  const workItem = await workCatalog.resolveByDshSession(sessionId);
  if (!workItem || !['editing','creation'].includes(workItem.kind)) return { status:'unlinked' };
  const app = workItem.kind === 'creation'
    ? findCreationRuntime?.(workItem)?.workspace?.managedDeck?.editor
    : findEditingRuntime({ deckId:workItem.deckId, deckPath:workItem.deckPath })?.app;
  const identity = { workId:workItem.workId, deckPath:app?.deckPath ?? workItem.deckPath, kind:workItem.kind };
  if (!app?.sessionDir || !app.workingDeckPath) return { status:'unavailable', ...identity };
  const capabilityPath = await writeWorkspaceCapability(app.sessionDir, {
    url:app.url, token:app.token, mode:'visible',
    deckPath:app.deckPath, workingDeckPath:app.workingDeckPath,
    sessionDir:app.sessionDir, pid:process.pid,
  });
  // 只投影关联判断所需的任务信息，不加载截图、候选元素或整份修改历史。
  const feedbackTasks = (app.session?.tasks ?? []).filter(task => task.status !== 'completed').map(task => {
    const batch = [...(app.session?.agentBatches ?? [])].reverse().find(item => item.taskIds.includes(task.id));
    return {taskId:task.id, instruction:task.instruction, pageKey:task.pageKey, pageLabel:task.pageLabel,
      rect:task.rect, status:task.status, batchId:batch?.id ?? null, batchSettled:!!batch?.settlement};
  });
  const handoff = app.creationHandoff;
  const draft = handoff?.context?.draft;
  const summary = draft ? {
    brief:Object.fromEntries(Object.entries(draft.brief ?? {}).filter(([,v]) =>
      typeof v === 'string' || typeof v === 'number').slice(0,12)
      .map(([key,value]) => [key,String(value).slice(0,300)])),
    sections:(draft.outline?.sections ?? []).slice(0,30).map(row => String(row.title ?? row.name ?? '').slice(0,120)),
    pageCount:draft.pagePlan?.pages?.length ?? 0,
  } : null;
  const project = { projectRoot:workItem.projectRoot ?? app.agentWorkspace?.snapshot?.().projectRoot,
    ...(handoff ? {title:handoff.context.title,contextPath:handoff.path,
      artifacts:handoff.context.artifacts,summary} : {}) };
  return { status:'ready', ...identity, capabilityPath, workingDeckPath:app.workingDeckPath,
    revision:app.session?.revision, view:app.viewContext ?? null, project,
    agentRun:app.agentRuns?.snapshot?.(), feedbackTasks };
}
