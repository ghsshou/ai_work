import { applyPill, setPillLabel } from './pill-nav.mjs';

const STATUS_LABELS = {
  pending: '待处理',
  processing: '处理中',
  'needs-confirmation': '待确认',
  completed: '已完成',
  failed: '失败',
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatSize(size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(1).replace(/\.0$/, '')} ${unit}`;
}

function taskRecency(task) {
  for (const value of [task?.updatedAt, task?.createdAt]) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.NEGATIVE_INFINITY;
}

function runMessage(run) {
  if (!run || run.status === 'idle') return '';
  const defaults = {
    queued:'反馈已提交，正在启动 Agent',
    running:'Agent 正在处理本批反馈',
    succeeded:'Agent 已完成本批处理，请检查结果',
    failed:'Agent 批处理失败',
    cancelled:'Agent 任务已取消',
  };
  return run.message || defaults[run.status] || '';
}

export function taskHistoryControl(task, groups = []) {
  if (task?.status !== 'completed' || typeof task.groupId !== 'string') return null;
  const safeGroups = Array.isArray(groups) ? groups : [];
  const originalGroup = safeGroups.find(group => group?.id === task.groupId) ?? null;
  const effectUndone = ['undone', 'compensated'].includes(task.effectState);
  if (!effectUndone) {
    return { method:'undo', groupId:originalGroup?.id ?? task.groupId, label:'撤销' };
  }
  const activeCompensation = [...safeGroups].reverse().find(group => (
    group?.active === true && group?.compensation?.taskId === task.id
  ));
  if (activeCompensation) {
    return { method:'undo', groupId:activeCompensation.id, label:'重做' };
  }
  if (originalGroup?.active === false) {
    return { method:'redo', groupId:originalGroup.id, label:'重做' };
  }
  return null;
}

function drawerBatchProjection(tasks, agentRun) {
  const activeBatch = agentRun?.activeBatch ?? null;
  const activeIds = new Set(activeBatch?.taskIds ?? []);
  const batches = Array.isArray(agentRun?.batches) ? agentRun.batches : [];
  const latestBatchByTask = new Map();
  for (const batch of [...batches].sort((left, right) => left.ordinal - right.ordinal)) {
    for (const taskId of batch.taskIds ?? []) latestBatchByTask.set(taskId, batch);
  }
  const residualSnapshots = new Map(
    (agentRun?.residualBatches ?? []).map(batch => [batch.id, batch]),
  );
  const residualByTask = new Map();
  for (const task of tasks) {
    if (task.status === 'completed' || activeIds.has(task.id)) continue;
    const batch = latestBatchByTask.get(task.id);
    if (batch) residualByTask.set(task.id, residualSnapshots.get(batch.id) ?? batch);
  }
  // nextBatch.taskIds 是服务端事件时刻的便利投影；任务创建、撤销或完成可能
  // 先于下一次批次事件到达。浏览器必须用不可变批次成员和当前任务状态重算，
  // 不能把旧的派生数组当成权威列表。
  const nextIds = new Set(tasks.filter(task => (
    task.status !== 'completed' && !activeIds.has(task.id) && !latestBatchByTask.has(task.id)
  )).map(task => task.id));
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const residualBatches = [...new Map(
    [...residualByTask.values()].map(batch => [batch.id, batch]),
  ).values()].map(batch => {
    const unfinishedTaskIds = [...residualByTask]
      .filter(([, candidate]) => candidate.id === batch.id)
      .map(([taskId]) => taskId);
    return {
      ...batch,
      unfinishedTaskIds,
      actionableTaskIds:unfinishedTaskIds.filter(taskId => {
        const task = taskById.get(taskId);
        return task?.targetMissing !== true && ['pending', 'failed'].includes(task?.status);
      }),
    };
  }).sort((left, right) => right.ordinal - left.ordinal);
  return { activeBatch, activeIds, residualByTask, residualBatches, nextIds };
}

function appendTaskSection(list, {
  kind, title, detail = '', rows, batchId = '', actions = [],
}) {
  if (!rows.length) return;
  const section = element('section', `task-batch-section task-batch-section-${kind}`);
  section.dataset.taskBatchSection = kind;
  if (batchId) section.dataset.agentBatchId = batchId;
  const header = element('header', 'task-batch-header');
  header.append(element('strong', '', title));
  if (detail) header.append(element('span', '', detail));
  section.append(header);
  const body = element('div', 'task-batch-list');
  body.append(...rows);
  section.append(body);
  if (actions.length) {
    const controls = element('div', 'task-batch-actions');
    controls.append(...actions);
    section.append(controls);
  }
  list.append(section);
}

export function setTaskDrawerOpen(root, open) {
  const next = open === true;
  root.dataset.open = String(next);
  const toggle = root.querySelector('[data-task-drawer-toggle]');
  toggle?.setAttribute('aria-expanded', String(next));
  const chevron = toggle?.querySelector('.task-drawer-chevron');
  if (chevron) chevron.textContent = next ? '收起' : '展开';
}

export function renderTaskDrawer(root, {
  tasks, groups = [], agentRun = { status:'idle' },
  submissionBlocked = false, submissionBlockedMessage = '',
  onLocate, onProcessAll, onHistory, onEdit, onDelete, onCancelBatch,
}) {
  const completedCount = tasks.filter(task => task.status === 'completed').length;
  const pendingCount = tasks.length - completedCount;
  const needsConfirmationCount = tasks.filter(
    task => task.status === 'needs-confirmation',
  ).length;
  const unresolvedTargetMissingCount = tasks.filter(task => (
    task.targetMissing === true && task.status !== 'completed'
  )).length;
  const batchProjection = drawerBatchProjection(tasks, agentRun);
  const {
    activeBatch, activeIds, residualByTask, residualBatches, nextIds,
  } = batchProjection;
  const activeUnfinishedCount = activeBatch?.taskIds?.filter(id => (
    tasks.find(task => task.id === id)?.status !== 'completed'
  )).length ?? 0;
  const nextCount = [...nextIds].length;
  const residualCount = residualByTask.size;
  const wasOpen = root.dataset.open === 'true';
  const previousCount = Number(root.dataset.taskCount ?? 0);
  const shouldOpen = wasOpen || (previousCount === 0 && tasks.length > 0);
  root.dataset.rendered = 'true';
  root.dataset.taskCount = String(tasks.length);
  root.dataset.needsConfirmationCount = String(needsConfirmationCount);
  root.dataset.open = String(shouldOpen);
  root.replaceChildren();

  const toggle = element('button', 'task-drawer-toggle');
  toggle.type = 'button';
  toggle.dataset.taskDrawerToggle = '';
  toggle.setAttribute('aria-expanded', String(shouldOpen));
  toggle.setAttribute(
    'aria-label',
    `Agent 修改任务：待完成 ${pendingCount}，`
      + `其中待确认 ${needsConfirmationCount}，已完成 ${completedCount}`,
  );
  toggle.append(element('span', 'task-drawer-agent', 'AGENT'));
  const counts = element('span', 'task-drawer-counts');
  const pendingLabel = activeBatch
    ? `处理中 ${activeUnfinishedCount}`
    : residualCount > 0
      ? `待重试 ${residualCount}`
      : `下一批 ${nextCount}`;
  const pending = element('span', 'task-drawer-count task-drawer-count-pending', pendingLabel);
  pending.dataset.taskPendingCount = String(pendingCount);
  if (needsConfirmationCount > 0) {
    pending.classList.add('task-drawer-count-attention');
    pending.title = `${needsConfirmationCount} 条任务需要补充信息`;
  }
  const completed = element(
    'span',
    'task-drawer-count task-drawer-count-completed',
    `已完成 ${completedCount}`,
  );
  completed.dataset.taskCompletedCount = String(completedCount);
  counts.append(pending);
  if (activeBatch || residualCount > 0) {
    const next = element('span', 'task-drawer-count task-drawer-count-next', `下一批 ${nextCount}`);
    next.dataset.taskNextCount = String(nextCount);
    counts.append(next);
  }
  counts.append(completed);
  toggle.append(counts);
  toggle.append(element('span', 'task-drawer-chevron', shouldOpen ? '收起' : '展开'));
  const setOpen = open => setTaskDrawerOpen(root, open);
  toggle.addEventListener('click', () => setOpen(root.dataset.open !== 'true'));
  root.append(toggle);

  const panel = element('section', 'task-drawer-panel deck-notespanel');
  panel.dataset.taskDrawerPanel = '';
  panel.setAttribute('aria-label', 'Agent 修改任务');
  const panelHeader = element('header', 'task-panel-header');
  panelHeader.append(element('span', 'deck-panel-dot'));
  panelHeader.append(element('strong', 'deck-panel-title', 'Agent 修改任务'));
  panelHeader.append(element('span', 'task-panel-count', String(tasks.length)));
  const close = element('button', 'deck-panel-close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭 Agent 修改任务面板');
  applyPill(close, { variant:'neutral', size:'sm', kind:'icon' });
  close.addEventListener('click', () => {
    setOpen(false);
    toggle.focus();
  });
  panelHeader.append(close);
  panel.append(panelHeader);
  const list = element('div', 'task-list');
  const activeRun = ['queued', 'running'].includes(agentRun.status);
  const completedRows = [];
  const activeRows = [];
  const nextRows = [];
  const residualRows = new Map();
  if (!tasks.length) {
    list.append(element('p', 'task-empty', '拉框标记页面区域后，任务会记录在这里。'));
  }
  for (const [taskIndex, task] of tasks.entries()) {
    const row = element('article', 'task-row');
    row.dataset.taskRow = task.id;
    const needsConfirmation = task.status === 'needs-confirmation';
    const effectUndone = task.status === 'completed'
      && ['undone', 'compensated'].includes(task.effectState);
    const targetMissing = task.targetMissing === true;
    const unresolvedTargetMissing = targetMissing && task.status !== 'completed';
    const residualBatch = residualByTask.get(task.id) ?? null;
    const membership = activeIds.has(task.id)
      ? 'active' : residualBatch ? 'residual' : nextIds.has(task.id) ? 'next' : 'other';
    row.dataset.taskBatchMembership = membership;
    if (activeIds.has(task.id)) row.dataset.agentBatchId = activeBatch.id;
    else if (residualBatch) row.dataset.agentBatchId = residualBatch.id;
    if (needsConfirmation) row.dataset.needsConfirmation = '';
    if (unresolvedTargetMissing) row.dataset.targetMissing = '';
    const locate = element('button', 'task-locate');
    locate.type = 'button';
    locate.dataset.taskLocate = task.id;
    locate.disabled = targetMissing;
    locate.setAttribute('aria-label', targetMissing
      ? `原目标当前不可定位：${task.instruction}`
      : `定位第 ${task.pageIndex} 页：${task.instruction}`);
    const meta = element('div', 'task-meta');
    meta.append(element('span', 'task-page', `${String(task.pageIndex).padStart(2, '0')} · ${task.pageLabel}`));
    const membershipStatus = membership === 'active' && ['pending', 'failed'].includes(task.status)
      ? '等待 Agent'
      : membership === 'next' && ['pending', 'failed'].includes(task.status)
        ? '未提交'
        : membership === 'residual' && ['pending', 'failed'].includes(task.status)
          ? '未完成'
          : null;
    const status = element(
      'span',
      `task-status ${unresolvedTargetMissing
        ? 'task-status-target-missing' : `task-status-${task.status}`}`,
      unresolvedTargetMissing
        ? '目标不可定位'
        : effectUndone
          ? '已完成 · 修改已撤销'
          : (membershipStatus ?? STATUS_LABELS[task.status] ?? task.status),
    );
    meta.append(status);
    locate.append(meta, element('p', 'task-instruction', task.instruction));
    locate.addEventListener('click', () => {
      if (!targetMissing) onLocate?.(task);
    });
    row.append(locate);
    if (unresolvedTargetMissing) {
      const notice = element('aside', 'task-target-missing-notice');
      notice.dataset.taskTargetMissing = task.id;
      notice.setAttribute('role', 'status');
      notice.append(
        element('strong', '', '这个任务的原目标当前无法定位。'),
        element('span', '', '页面结构可能已经变化；请撤销相关结构修改，或删除任务后重新标记。'),
      );
      row.append(notice);
    } else if (needsConfirmation) {
      const notice = element('aside', 'task-confirmation-notice');
      notice.dataset.taskConfirmationNotice = task.id;
      notice.setAttribute('role', 'alert');
      const indicator = element('span', 'task-confirmation-indicator');
      indicator.setAttribute('aria-hidden', 'true');
      const copy = element('span', 'task-confirmation-copy');
      copy.append(
        element('strong', '', '检测到多个可能目标，Agent 无法安全确定修改对象。'),
        element('span', '', '请点击“补充说明”，写清具体位置或对象后重新提交。'),
      );
      notice.append(indicator, copy);
      row.append(notice);
    }
    if (task.status === 'failed' && task.lastError?.code) {
      const notice = element('aside', 'task-confirmation-notice');
      notice.dataset.taskFailureNotice = task.id;
      notice.setAttribute('role', 'alert');
      const copy = element('span', 'task-confirmation-copy');
      copy.append(
        element('strong', '', `${task.lastError.message}（${task.lastError.code}）`),
        element('span', '', task.lastError.recovery ?? ''),
      );
      notice.append(copy);
      row.append(notice);
    }
    const mutable = !targetMissing
      && ['pending', 'failed', 'needs-confirmation'].includes(task.status)
      && !task.groupId;
    const solidified = task.status === 'completed' && !task.groupId;
    const missingTargetDeletable = targetMissing && !task.groupId
      && ['pending', 'failed', 'needs-confirmation', 'completed'].includes(task.status);
    const deletable = mutable || solidified || missingTargetDeletable;
    if ((mutable && onEdit) || (deletable && onDelete)) {
      const actions = element('div', 'task-row-actions');
      if (mutable && onEdit) {
        const edit = element(
          'button',
          `task-edit${needsConfirmation ? ' task-edit-attention' : ''}`,
          needsConfirmation ? '补充说明' : '编辑',
        );
        edit.type = 'button';
        edit.dataset.taskEdit = task.id;
        edit.disabled = activeIds.has(task.id);
        applyPill(edit, { variant:'neutral', size:'sm', kind:'action' });
        edit.addEventListener('click', () => {
          const originalChildren = [...row.childNodes];
          const form = element('form', 'task-edit-form');
          form.dataset.taskEditForm = task.id;
          const input = element('textarea', 'task-edit-input');
          input.dataset.taskEditInput = task.id;
          input.rows = 3;
          input.maxLength = 10_000;
          input.value = task.instruction;
          input.setAttribute('aria-label', '修改任务说明');
          const note = element('p', 'task-edit-note');
          note.dataset.taskEditNote = '';
          note.setAttribute('role', 'status');
          const controls = element('div', 'task-edit-controls');
          const cancel = element('button', 'task-edit-cancel', '取消');
          cancel.type = 'button';
          cancel.dataset.taskEditCancel = task.id;
          const save = element('button', 'task-edit-save', '保存');
          save.type = 'submit';
          save.dataset.taskEditSave = task.id;
          applyPill(cancel, { variant:'secondary', size:'sm', kind:'action' });
          applyPill(save, { variant:'primary', size:'sm', kind:'action' });
          controls.append(cancel, save);
          form.append(input, note, controls);
          const restore = () => row.replaceChildren(...originalChildren);
          cancel.addEventListener('click', restore);
          form.addEventListener('submit', async event => {
            event.preventDefault();
            const instruction = input.value.trim();
            if (!instruction) {
              note.textContent = '修改说明不能为空';
              input.focus();
              return;
            }
            input.disabled = true;
            cancel.disabled = true;
            save.disabled = true;
            note.textContent = '正在保存…';
            try {
              await onEdit(task, instruction);
            } catch (error) {
              if (!form.isConnected) return;
              input.disabled = false;
              cancel.disabled = false;
              save.disabled = false;
              note.textContent = `保存失败：${error?.message || '未知错误'}`;
              input.focus();
            }
          });
          row.replaceChildren(form);
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        });
        actions.append(edit);
      }
      if (deletable && onDelete) {
        const remove = element('button', 'task-delete', solidified ? '删除记录' : '删除');
        remove.type = 'button';
        remove.dataset.taskDelete = task.id;
        remove.title = activeIds.has(task.id) ? '取消本批等待并删除此任务' : '删除此任务';
        applyPill(remove, { variant:'danger', size:'sm', kind:'action' });
        remove.addEventListener('click', () => {
          if (row.querySelector('[data-task-delete-confirmation]')) return;
          const confirmation = element('div', 'task-delete-confirmation');
          confirmation.dataset.taskDeleteConfirmation = task.id;
          confirmation.append(element('p', '', solidified
            ? '确定删除这条已固化任务记录？Deck 中已固化的修改不会改变，区域截图和附件会一并清理。'
            : activeIds.has(task.id) ? '取消本批等待并删除此任务？其余任务保留，已完成的 Deck 修改不会撤销。' : '确定删除这条任务？区域截图和附件也会一并清理。'));
          const controls = element('div', 'task-delete-controls');
          const cancel = element('button', 'task-delete-cancel', '取消');
          cancel.type = 'button';
          cancel.dataset.taskDeleteCancel = task.id;
          const confirm = element('button', 'task-delete-confirm', '确认删除');
          confirm.type = 'button';
          confirm.dataset.taskDeleteConfirm = task.id;
          applyPill(cancel, { variant:'secondary', size:'sm', kind:'action' });
          applyPill(confirm, { variant:'danger', size:'sm', kind:'action' });
          cancel.addEventListener('click', () => confirmation.remove());
          confirm.addEventListener('click', async () => {
            cancel.disabled = true;
            confirm.disabled = true;
            setPillLabel(confirm, '正在删除…');
            try {
              await onDelete(task);
            } catch (error) {
              if (!confirmation.isConnected) return;
              cancel.disabled = false;
              confirm.disabled = false;
              setPillLabel(confirm, '确认删除');
              confirmation.querySelector('p').textContent = `删除失败：${error?.message || '未知错误'}`;
            }
          });
          controls.append(cancel, confirm);
          confirmation.append(controls);
          row.append(confirmation);
          confirm.focus();
        });
        actions.append(remove);
      }
      row.append(actions);
    }
    const historyControl = taskHistoryControl(task, groups);
    if (historyControl && onHistory) {
      const history = element(
        'button', `task-history task-${historyControl.method}`, historyControl.label,
      );
      history.type = 'button';
      history.dataset[historyControl.label === '重做' ? 'taskRedo' : 'taskUndo'] = task.id;
      history.dataset.groupId = historyControl.groupId;
      history.dataset.historyMethod = historyControl.method;
      history.dataset.taskHistoryLocked = String(activeIds.has(task.id));
      history.disabled = activeIds.has(task.id);
      applyPill(history, { variant:'neutral', size:'sm', kind:'action' });
      history.addEventListener('click', () => onHistory(task, historyControl));
      row.append(history);
    }
    if (Array.isArray(task.attachments) && task.attachments.length > 0) {
      const attachmentsId = `task-attachments-${taskIndex}`;
      const attachmentsToggle = element(
        'button',
        'task-attachments-toggle',
        `附件 ${task.attachments.length}`,
      );
      attachmentsToggle.type = 'button';
      attachmentsToggle.dataset.taskAttachmentsToggle = task.id;
      attachmentsToggle.setAttribute('aria-controls', attachmentsId);
      attachmentsToggle.setAttribute('aria-expanded', 'false');

      const attachments = element('div', 'task-attachments');
      attachments.id = attachmentsId;
      attachments.hidden = true;
      for (const attachment of task.attachments) {
        const item = element('article', 'task-attachment');
        item.dataset.taskAttachment = '';
        const summary = element('div', 'task-attachment-summary');
        summary.append(element('strong', '', attachment.name));
        const size = element('span', '', formatSize(attachment.size));
        size.dataset.attachmentSize = '';
        summary.append(size);

        const path = element('code', 'task-attachment-path', attachment.path);
        path.dataset.attachmentPath = '';
        const copy = element('button', 'task-copy-attachment', '复制路径');
        copy.type = 'button';
        copy.dataset.copyAttachmentPath = '';
        applyPill(copy, { variant:'neutral', size:'sm', kind:'action' });
        copy.addEventListener('click', async () => {
          copy.disabled = true;
          try {
            if (!navigator.clipboard?.writeText) throw new Error('浏览器剪贴板不可用');
            await navigator.clipboard.writeText(attachment.path);
            setPillLabel(copy, '已复制');
          } catch {
            setPillLabel(copy, '复制失败，请手动选择路径');
          }
          window.setTimeout(() => {
            if (!copy.isConnected) return;
            setPillLabel(copy, '复制路径');
            copy.disabled = false;
          }, 1_500);
        });
        item.append(summary, path, copy);
        attachments.append(item);
      }
      attachmentsToggle.addEventListener('click', () => {
        const expanded = attachmentsToggle.getAttribute('aria-expanded') !== 'true';
        attachmentsToggle.setAttribute('aria-expanded', String(expanded));
        attachments.hidden = !expanded;
      });
      row.append(attachmentsToggle, attachments);
    }
    if (membership === 'active') activeRows.push(row);
    else if (membership === 'residual') {
      const rows = residualRows.get(residualBatch.id) ?? [];
      rows.push(row);
      residualRows.set(residualBatch.id, rows);
    } else if (task.status === 'completed') completedRows.push({ row, task, taskIndex });
    else nextRows.push(row);
  }
  appendTaskSection(list, {
    kind:'active',
    title:`正在处理 · 批次 ${activeBatch?.ordinal ?? ''}`,
    detail:activeBatch
      ? `已完成 ${activeBatch.taskIds.length - activeUnfinishedCount}/${activeBatch.taskIds.length}`
      : '',
    rows:activeRows,
    batchId:activeBatch?.id ?? '',
  });
  appendTaskSection(list, {
    kind:'next',
    title:'下一批 · 新标注',
    detail:`${nextRows.length} 条`,
    rows:nextRows,
  });
  const taskById = new Map(tasks.map(task => [task.id, task]));
  for (const batch of residualBatches) {
    const rows = residualRows.get(batch.id) ?? [];
    if (!rows.length) continue;
    const retryTasks = (batch.actionableTaskIds ?? [])
      .map(id => taskById.get(id)).filter(Boolean);
    const nextActionableTasks = [...nextIds]
      .map(id => taskById.get(id))
      .filter(task => task && task.targetMissing !== true
        && ['pending', 'failed'].includes(task.status));
    const actions = [];
    if (retryTasks.length) {
      const retry = element(
        'button', 'task-batch-retry',
        `重新提交本批未完成任务（${retryTasks.length} 条）`,
      );
      retry.type = 'button';
      retry.dataset.retryAgentBatch = batch.id;
      retry.disabled = activeRun || submissionBlocked === true;
      applyPill(retry, { variant:'secondary', size:'sm', kind:'action' });
      retry.addEventListener('click', () => void onProcessAll?.(retryTasks));
      actions.push(retry);
      if (nextActionableTasks.length) {
        const merge = element(
          'button', 'task-batch-merge',
          `合并到下一批 · 共 ${retryTasks.length + nextActionableTasks.length} 条`,
        );
        merge.type = 'button';
        merge.dataset.mergeAgentBatch = batch.id;
        merge.disabled = activeRun || submissionBlocked === true;
        applyPill(merge, { variant:'neutral', size:'sm', kind:'action' });
        merge.addEventListener('click', () => void onProcessAll?.([
          ...retryTasks, ...nextActionableTasks,
        ]));
        actions.push(merge);
      }
    }
    appendTaskSection(list, {
      kind:'residual',
      title:`批次 ${batch.ordinal} · 未完成`,
      detail:`${rows.length} 条`,
      rows,
      batchId:batch.id,
      actions,
    });
  }
  if (completedRows.length > 0) {
    const orderedCompletedRows = [...completedRows]
      .sort((left, right) => (
        taskRecency(right.task) - taskRecency(left.task)
        || right.taskIndex - left.taskIndex
      ))
      .map(item => item.row);
    const completedGroup = element('details', 'task-completed-group');
    completedGroup.dataset.taskCompletedGroup = '';
    completedGroup.open = root.dataset.completedOpen === 'true';
    const completedSummary = element('summary', 'task-completed-summary');
    const undoableCompleted = orderedCompletedRows.some(
      row => row.querySelector('[data-task-undo], [data-task-redo]'),
    );
    completedSummary.append(
      element('strong', '', `已完成 ${completedRows.length} 条`),
      element('span', '', undoableCompleted ? '可展开查看、撤销与重做' : '已固化，可删除记录'),
    );
    const completedList = element('div', 'task-completed-list');
    completedList.append(...orderedCompletedRows);
    completedGroup.append(completedSummary, completedList);
    completedGroup.addEventListener('toggle', () => {
      root.dataset.completedOpen = String(completedGroup.open);
    });
    list.append(completedGroup);
  } else {
    root.dataset.completedOpen = 'false';
  }
  panel.append(list);

  const footer = element('div', 'task-drawer-footer');
  const actionableTasks = [...nextIds]
    .map(id => taskById.get(id))
    .filter(task => task && task.targetMissing !== true
      && ['pending', 'failed'].includes(task.status));
  const idleSubmissionBlocked = submissionBlocked === true && !activeRun;
  const hasRetryableResidual = residualBatches.some(
    batch => (batch.actionableTaskIds?.length ?? 0) > 0,
  );
  const buttonText = agentRun.status === 'queued'
    ? `批次 ${activeBatch?.ordinal ?? ''} 正在提交 · 下一批已积累 ${nextCount} 条`
    : agentRun.status === 'running'
      ? `批次 ${activeBatch?.ordinal ?? ''} 正在处理 · 下一批已积累 ${nextCount} 条`
    : actionableTasks.length === 0 && unresolvedTargetMissingCount > 0
      ? `有 ${unresolvedTargetMissingCount} 条任务的目标不可定位`
    : actionableTasks.length === 0 && needsConfirmationCount > 0
      ? `有 ${needsConfirmationCount} 条任务需要补充说明`
    : actionableTasks.length === 0 && hasRetryableResidual
      ? '下一批暂无新任务；请使用上方重新提交按钮'
    : actionableTasks.length === 0
      ? '没有待处理任务'
    : idleSubmissionBlocked
      ? 'Agent 暂不可接收下一批…'
    : `交给 Agent 处理下一批 ${actionableTasks.length} 条`;
  const process = element('button', 'task-process-all', buttonText);
  process.type = 'button';
  process.dataset.processAll = '';
  process.disabled = actionableTasks.length === 0 || activeRun || submissionBlocked === true;
  process.setAttribute('aria-busy', String(activeRun));
  applyPill(process, { variant:'primary', size:'md', kind:'action' });
  const note = element('p', 'task-process-note');
  note.dataset.processNote = '';
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  const confirmationMessage = needsConfirmationCount > 0
    ? `${needsConfirmationCount} 条任务因修改目标定位不唯一而暂停，补充说明后可重新提交。`
    : '';
  const targetMissingMessage = unresolvedTargetMissingCount > 0
    ? `${unresolvedTargetMissingCount} 条任务的原目标当前无法定位；`
      + '请撤销相关结构修改，或删除任务后重新标记。'
    : '';
  const blockedMessage = idleSubmissionBlocked
    ? submissionBlockedMessage || 'Agent 输入界面尚未就绪，请稍候再提交任务。'
    : '';
  note.textContent = [runMessage(agentRun), blockedMessage, targetMissingMessage, confirmationMessage]
    .filter(Boolean).join('；');
  if (needsConfirmationCount > 0 || unresolvedTargetMissingCount > 0) {
    note.dataset.attention = '';
  }
  process.addEventListener('click', () => {
    process.disabled = true;
    note.textContent = '正在把本批反馈交给 Agent…';
    Promise.resolve(onProcessAll?.(actionableTasks)).then(message => {
      if (note.isConnected && message) note.textContent = message;
    }).catch(error => {
      if (!note.isConnected) return;
      note.textContent = `提交失败：${error?.message || '未知错误'}`;
      process.disabled = false;
    });
  });
  if (activeRun && onCancelBatch) {
    const cancelBatch = element('button','task-cancel-batch','取消本批等待');
    cancelBatch.type = 'button';
    cancelBatch.dataset.cancelBatch = '';
    applyPill(cancelBatch,{variant:'secondary',size:'md',kind:'action'});
    cancelBatch.addEventListener('click',async () => {
      cancelBatch.disabled = true;
      try { await onCancelBatch(activeBatch); }
      catch(error) { note.textContent = `取消失败：${error.message}`; cancelBatch.disabled = false; }
    });
    footer.append(cancelBatch);
  }
  footer.append(process, note);
  panel.append(footer);
  root.append(panel);
}
