import { createHash, randomUUID } from 'node:crypto';
import { actionKey, compileActionGroups } from './action-compiler.mjs';
import { sameCanonicalActionValue } from './action-canonicalizer.mjs';

export class HistoryIntegrityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HistoryIntegrityError';
    this.code = code;
    this.statusCode = 409;
    this.stage = 'history-integrity';
    this.committed = false;
    Object.assign(this, details);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function entryMutation(entry) {
  if (entry?.mutation?.kind === 'actions') {
    return { kind:'actions', actions:structuredClone(entry.mutation.actions ?? []) };
  }
  if (entry?.mutation?.kind === 'source') {
    return { kind:'source', source:structuredClone(entry.mutation.source) };
  }
  throw new HistoryIntegrityError('INVALID_HISTORY_ENTRY', '历史条目缺少有效 mutation');
}

function groupMutation(group) {
  if (group?.mutationType === 'source') {
    return { kind:'source', source:structuredClone(group.source) };
  }
  return { kind:'actions', actions:structuredClone(group?.actions ?? []) };
}

function originFor(group) {
  if (group?.compensation) return {
    kind:'compensation', taskId:group.compensation.taskId ?? null,
  };
  if (typeof group?.taskId === 'string' && group.taskId) {
    return { kind:'agent', taskId:group.taskId };
  }
  return {
    kind:group?.mutationType === 'source' ? 'source' : 'manual',
    taskId:null,
  };
}

function entryFromGroup(group, sequence, epochId) {
  const mutation = groupMutation(group);
  return {
    entryId:group.id,
    sequence,
    epochId,
    commandId:group.commandId ?? group.id,
    origin:structuredClone(group.origin ?? originFor(group)),
    mutation,
    ...(group.compensation ? { compensation:structuredClone(group.compensation) } : {}),
    ...(group.committedAt ? { committedAt:group.committedAt } : {}),
  };
}

function groupFromEntry(entry, active) {
  const mutation = entryMutation(entry);
  return {
    id:entry.entryId,
    mutationType:mutation.kind === 'source' ? 'source' : 'action',
    taskId:entry.origin?.kind === 'agent' ? entry.origin.taskId ?? null : null,
    actions:mutation.kind === 'actions' ? mutation.actions : [],
    ...(mutation.kind === 'source' ? { source:mutation.source } : {}),
    ...(entry.compensation ? { compensation:structuredClone(entry.compensation) } : {}),
    active,
  };
}

function legacyCursor(groups, redo) {
  let cursor = groups.length;
  for (const [index, group] of groups.entries()) {
    if (group?.active !== true) {
      cursor = index;
      break;
    }
  }
  const prefixIsActive = groups.slice(0, cursor).every(group => group?.active === true);
  const suffixIsInactive = groups.slice(cursor).every(group => group?.active === false);
  const expectedRedo = groups.slice(cursor).reverse().map(group => group.id);
  const redoMatches = Array.isArray(redo)
    && JSON.stringify(redo) === JSON.stringify(expectedRedo);
  return {
    linear:prefixIsActive && suffixIsInactive && redoMatches,
    cursor,
  };
}

function migrationFromLegacy(state) {
  const groups = Array.isArray(state.groups) ? structuredClone(state.groups) : [];
  const redo = Array.isArray(state.redo) ? structuredClone(state.redo) : [];
  const { linear, cursor } = legacyCursor(groups, redo);
  const selected = linear ? groups : groups.filter(group => group?.active === true);
  const selectedCursor = linear ? cursor : selected.length;
  const archived = linear ? [] : groups.filter(group => group?.active !== true);
  let epochId = `epoch-${digest({
    deckFingerprint:state.deckFingerprint ?? null,
    workingDeckFingerprint:state.workingDeckFingerprint ?? null,
    solidifiedActions:state.solidifiedActions ?? [],
  }).slice(0, 24)}`;
  const entries = selected.map((group, index) => {
    const entry = entryFromGroup(group, index, epochId);
    if (entry.mutation.kind === 'source') epochId = `epoch-${entry.entryId}`;
    return entry;
  });
  return {
    timeline:{ cursor:selectedCursor, entries },
    report:{
      mode:linear ? 'linear' : 'linearized-active',
      migratedAt:new Date().toISOString(),
      archivedRedoCount:archived.length,
      ...(archived.length ? { archivedGroups:archived } : {}),
    },
  };
}

function baselineDigest(state) {
  return digest({
    deckFingerprint:state.deckFingerprint ?? null,
    workingDeckFingerprint:state.workingDeckFingerprint ?? null,
    solidifiedActions:state.solidifiedActions ?? [],
  });
}

function actionContinuityIssues(groups) {
  const previous = new Map();
  const issues = [];
  for (const group of groups) {
    if (group?.active !== true) continue;
    if (group.mutationType === 'source') {
      previous.clear();
      continue;
    }
    for (const action of group.actions ?? []) {
      const key = actionKey(action);
      const before = previous.get(key);
      if (before && Object.hasOwn(action, 'before')
        && !sameCanonicalActionValue(action, action.before, before.after)) {
        issues.push({
          entryId:group.id,
          actionId:action.id,
          slot:key,
          expected:structuredClone(before.after),
          actual:structuredClone(action.before),
        });
      }
      previous.set(key, action);
    }
  }
  return issues;
}

function rebuildDigests(state) {
  let previous = baselineDigest(state);
  for (const [index, entry] of state.timeline.entries.entries()) {
    entry.sequence = index;
    entry.beforeProjectionDigest = previous;
    entry.afterProjectionDigest = digest({ previous, mutation:entry.mutation });
    previous = entry.afterProjectionDigest;
  }
}

function assertTimeline(timeline) {
  if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)
    || !Array.isArray(timeline.entries)
    || !Number.isSafeInteger(timeline.cursor)
    || timeline.cursor < 0 || timeline.cursor > timeline.entries.length) {
    throw new HistoryIntegrityError('INVALID_HISTORY_TIMELINE', '编辑时间线格式无效');
  }
  const ids = new Set();
  for (const [index, entry] of timeline.entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.entryId !== 'string' || !entry.entryId
      || ids.has(entry.entryId)) {
      throw new HistoryIntegrityError('INVALID_HISTORY_ENTRY', '历史条目标识无效或重复');
    }
    ids.add(entry.entryId);
    entryMutation(entry);
    entry.sequence = index;
  }
}

function payloadFor(action, value) {
  if (action.kind === 'setText') return { text:value };
  if (action.kind === 'setStyle') return {
    property:action.payload.property,
    value,
    ...(action.payload.textRange
      ? { textRange:structuredClone(action.payload.textRange) } : {}),
  };
  if (action.kind === 'translate' || action.kind === 'resize') {
    return structuredClone(value);
  }
  if (value === 'none') return {};
  return { display:value };
}

function actionWithValue(source, before, after) {
  let kind = source.kind;
  if (source.kind === 'hide' || source.kind === 'show') {
    kind = after === 'none' ? 'hide' : 'show';
  }
  return {
    ...structuredClone(source),
    id:randomUUID(),
    taskId:null,
    kind,
    payload:payloadFor({ ...source, kind }, after),
    before:structuredClone(before),
    after:structuredClone(after),
    appliedAt:new Date().toISOString(),
  };
}

function compensationActions(currentGroups, removedEntryId) {
  const current = compileActionGroups(currentGroups);
  const counterfactualGroups = currentGroups.map(group => (
    group.id === removedEntryId ? { ...group, active:false } : group
  ));
  const counterfactual = compileActionGroups(counterfactualGroups);
  const currentByKey = new Map(current.map(action => [actionKey(action), action]));
  const counterfactualByKey = new Map(counterfactual.map(action => [actionKey(action), action]));
  const actions = [];
  for (const [key, active] of currentByKey) {
    const desired = counterfactualByKey.get(key);
    const desiredValue = desired?.after ?? active.before;
    if (sameCanonicalActionValue(active, active.after, desiredValue)) continue;
    actions.push(actionWithValue(desired ?? active, active.after, desiredValue));
  }
  const resurrected = [...counterfactualByKey.keys()].filter(key => !currentByKey.has(key));
  if (resurrected.length) {
    throw new HistoryIntegrityError(
      'COMPENSATION_CONFLICT',
      '该任务与后续文字或局部格式修改存在依赖，无法安全单独撤销',
      { slots:resurrected },
    );
  }
  return actions;
}

export class EditTimeline {
  static open(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new TypeError('编辑时间线需要可变 session state');
    }
    const timelineMissingLegacyChanges = state.timeline
      && Array.isArray(state.timeline.entries)
      && state.timeline.entries.length === 0
      && Array.isArray(state.groups)
      && state.groups.length > 0;
    if (!state.timeline || timelineMissingLegacyChanges) {
      const migration = migrationFromLegacy(state);
      state.timeline = migration.timeline;
      state.historyMigration = {
        ...migration.report,
        ...(timelineMissingLegacyChanges ? { recoveredLegacyView:true } : {}),
      };
    }
    assertTimeline(state.timeline);
    state.version = Math.max(2, Number(state.version) || 0);
    const timeline = new EditTimeline(state);
    rebuildDigests(state);
    timeline.syncCompatibilityViews();
    const continuityIssues = actionContinuityIssues(state.groups);
    state.historyAudit = {
      checkedAt:new Date().toISOString(),
      healthy:continuityIssues.length === 0,
      continuityIssues,
    };
    return timeline;
  }

  constructor(state) {
    this.state = state;
  }

  syncCompatibilityViews() {
    const { entries, cursor } = this.state.timeline;
    this.state.groups = entries.map((entry, index) => groupFromEntry(entry, index < cursor));
    this.state.redo = entries.slice(cursor).reverse().map(entry => entry.entryId);
  }

  groups() {
    this.syncCompatibilityViews();
    return this.state.groups;
  }

  entry(id) {
    return this.state.timeline.entries.find(entry => entry.entryId === id) ?? null;
  }

  appendActions(taskId, actions, { compensation=null, commandId=null } = {}) {
    if (!Array.isArray(actions)) throw new TypeError('actions 必须为数组');
    this.#assertContinuity(actions);
    this.#truncateRedo();
    const id = randomUUID();
    const previousEntry = this.state.timeline.entries.at(-1);
    const epochId = previousEntry?.mutation?.kind === 'source'
      ? `epoch-${previousEntry.entryId}`
      : previousEntry?.epochId ?? `epoch-${baselineDigest(this.state).slice(0, 24)}`;
    const entry = {
      entryId:id,
      sequence:this.state.timeline.entries.length,
      epochId,
      commandId:commandId ?? id,
      origin:compensation
        ? { kind:'compensation', taskId:compensation.taskId ?? null }
        : { kind:taskId === null ? 'manual' : 'agent', taskId },
      mutation:{ kind:'actions', actions:structuredClone(actions) },
      ...(compensation ? { compensation:structuredClone(compensation) } : {}),
      committedAt:new Date().toISOString(),
    };
    this.state.timeline.entries.push(entry);
    this.state.timeline.cursor = this.state.timeline.entries.length;
    rebuildDigests(this.state);
    this.syncCompatibilityViews();
    return this.state.groups.at(-1);
  }

  appendSource(source, taskId=null, { commandId=null } = {}) {
    this.#truncateRedo();
    const id = randomUUID();
    const previousEntry = this.state.timeline.entries.at(-1);
    const epochId = previousEntry?.mutation?.kind === 'source'
      ? `epoch-${previousEntry.entryId}`
      : previousEntry?.epochId ?? `epoch-${baselineDigest(this.state).slice(0, 24)}`;
    const entry = {
      entryId:id,
      sequence:this.state.timeline.entries.length,
      epochId,
      commandId:commandId ?? id,
      origin:{ kind:taskId === null ? 'source' : 'agent', taskId },
      mutation:{ kind:'source', source:structuredClone(source) },
      committedAt:new Date().toISOString(),
    };
    this.state.timeline.entries.push(entry);
    this.state.timeline.cursor = this.state.timeline.entries.length;
    rebuildDigests(this.state);
    this.syncCompatibilityViews();
    return this.state.groups.at(-1);
  }

  appendToLatest(id, actions) {
    const { entries, cursor } = this.state.timeline;
    const entry = entries.at(-1);
    if (cursor !== entries.length || !entry || entry.entryId !== id
      || entry.mutation.kind !== 'actions' || entry.compensation) return null;
    this.#assertContinuity(actions);
    entry.mutation.actions.push(...structuredClone(actions));
    rebuildDigests(this.state);
    this.syncCompatibilityViews();
    return this.state.groups.at(-1);
  }

  undo(id) {
    const { entries, cursor } = this.state.timeline;
    const candidate = cursor > 0 ? entries[cursor - 1] : null;
    if (!candidate || candidate.entryId !== id) {
      throw new HistoryIntegrityError(
        'HISTORY_ORDER', '只能撤销编辑时间线中最新的一条修改',
        { expectedEntryId:candidate?.entryId ?? null, requestedEntryId:id },
      );
    }
    this.state.timeline.cursor -= 1;
    this.syncCompatibilityViews();
    return groupFromEntry(candidate, false);
  }

  redo(id) {
    const { entries, cursor } = this.state.timeline;
    const candidate = cursor < entries.length ? entries[cursor] : null;
    if (!candidate || candidate.entryId !== id) {
      throw new HistoryIntegrityError(
        'HISTORY_ORDER', '只能重做编辑时间线中下一条修改',
        { expectedEntryId:candidate?.entryId ?? null, requestedEntryId:id },
      );
    }
    this.state.timeline.cursor += 1;
    this.syncCompatibilityViews();
    return groupFromEntry(candidate, true);
  }

  compensate(id) {
    const { entries, cursor } = this.state.timeline;
    const index = entries.findIndex(entry => entry.entryId === id);
    if (index < 0 || index >= cursor) {
      throw new HistoryIntegrityError('GROUP_NOT_FOUND', '找不到可补偿的历史条目');
    }
    const target = entries[index];
    if (target.mutation.kind === 'source') {
      throw new HistoryIntegrityError(
        'COMPENSATION_CONFLICT', '结构修改只能按全局历史顺序撤销',
      );
    }
    const actions = compensationActions(this.groups(), id);
    if (actions.length === 0) {
      throw new HistoryIntegrityError(
        'NOTHING_TO_COMPENSATE', '该任务的效果已经被后续修改完全覆盖',
      );
    }
    return this.appendActions(null, actions, {
      compensation:{
        entryId:id,
        taskId:target.origin?.taskId ?? null,
      },
    });
  }

  archiveAndReset(checkpoint = {}) {
    const archive = {
      checkpointId:checkpoint.checkpointId ?? randomUUID(),
      createdAt:checkpoint.createdAt ?? new Date().toISOString(),
      cursor:this.state.timeline.cursor,
      entries:structuredClone(this.state.timeline.entries),
      ...structuredClone(checkpoint),
    };
    this.state.historyArchives ??= [];
    this.state.historyArchives.push(archive);
    this.state.checkpoints ??= [];
    this.state.checkpoints.push({
      checkpointId:archive.checkpointId,
      createdAt:archive.createdAt,
      revision:checkpoint.revision ?? null,
      fingerprint:checkpoint.fingerprint ?? null,
      entryCount:archive.entries.length,
    });
    this.state.timeline = { cursor:0, entries:[] };
    rebuildDigests(this.state);
    this.syncCompatibilityViews();
    return archive;
  }

  #truncateRedo() {
    const { entries, cursor } = this.state.timeline;
    if (cursor < entries.length) entries.splice(cursor);
  }

  #assertContinuity(actions) {
    const active = this.groups().filter(group => group.active === true);
    const lastSource = active.findLastIndex(group => group.mutationType === 'source');
    const currentEpoch = active.slice(lastSource + 1);
    const previous = new Map(compileActionGroups(currentEpoch)
      .map(action => [actionKey(action), action]));
    for (const action of actions) {
      const key = actionKey(action);
      const before = previous.get(key);
      if (before && Object.hasOwn(action, 'before')
        && !sameCanonicalActionValue(action, action.before, before.after)) {
        throw new HistoryIntegrityError(
          'HISTORY_DIVERGED',
          '动作起始值与编辑时间线当前值不一致，已拒绝写入历史',
          {
            actionId:action.id,
            slot:key,
            expected:structuredClone(before.after),
            actual:structuredClone(action.before),
            recovery:'重新同步编辑器后重试本次操作',
          },
        );
      }
      previous.set(key, action);
    }
  }
}
