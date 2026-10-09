const LABELS = {
  setText:'文字修改',
  translate:'移动',
  resize:'缩放',
  setStyle:'样式修改',
  hide:'隐藏',
  show:'显示',
};

export function historyCandidates(groups = [], redo = []) {
  const safeGroups = Array.isArray(groups) ? groups : [];
  const undoGroup = [...safeGroups].reverse().find(group => group?.active === true) ?? null;
  const redoId = Array.isArray(redo) ? redo.at(-1) : undefined;
  const redoGroup = typeof redoId === 'string'
    ? safeGroups.find(group => group?.id === redoId && group.active === false) ?? null
    : null;
  return { undoGroup, redoGroup };
}

export function historyLabel(group, tasks = [], verb = 'undo') {
  const prefix = verb === 'redo' ? '重做' : '撤销';
  if (!group) return prefix;
  if (group.compensation) {
    const task = tasks.find(candidate => candidate?.id === group.compensation.taskId);
    const detail = task?.instruction ? `：${task.instruction.slice(0, 36)}` : '';
    return verb === 'redo'
      ? `再次撤销 Agent 任务${detail}`
      : `恢复已撤销的 Agent 任务${detail}`;
  }
  if (group.mutationType === 'source') {
    const summary = typeof group.source?.summary === 'string'
      ? group.source.summary.trim().slice(0, 36) : '';
    return summary ? `${prefix}结构修改：${summary}` : `${prefix}结构修改`;
  }
  const task = group.taskId === null
    ? null : tasks.find(candidate => candidate?.id === group.taskId);
  if (task?.instruction) return `${prefix} Agent 任务：${task.instruction.slice(0, 36)}`;
  const actions = Array.isArray(group.actions) ? group.actions : [];
  if (actions.length === 1 && LABELS[actions[0]?.kind]) {
    return `${prefix}${LABELS[actions[0].kind]}`;
  }
  return `${prefix}一组修改（${actions.length} 项）`;
}
