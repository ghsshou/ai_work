import { randomUUID } from 'node:crypto';
import { compileActionGroups } from './action-compiler.mjs';
import { EditTimeline } from './edit-timeline.mjs';

function inverse(action) {
  let kind = action.kind;
  let payload;
  if (kind === 'setText') payload = { text:action.before };
  if (kind === 'setStyle') payload = {
    property:action.payload.property,
    value:action.before,
    ...(action.payload.textRange ? { textRange:structuredClone(action.payload.textRange) } : {}),
  };
  if (kind === 'translate' || kind === 'resize') payload = action.before;
  if (kind === 'hide') { kind = 'show'; payload = { display:action.before }; }
  else if (kind === 'show') { kind = 'hide'; payload = {}; }
  return { ...action, id:randomUUID(), kind, payload, before:action.after, after:action.before };
}

export class PatchJournal {
  constructor(state = { groups:[], redo:[] }) {
    this.state = state;
    this.timeline = EditTimeline.open(state);
  }

  appendGroup(taskId, actions, { commandId=null } = {}) {
    return this.timeline.appendActions(taskId, actions, { commandId });
  }

  appendSourceGroup(source, taskId = null) {
    if (!source || typeof source !== 'object'
      || !/^[0-9a-f]{64}$/.test(source.beforeFingerprint ?? '')
      || !/^[0-9a-f]{64}$/.test(source.afterFingerprint ?? '')
      || source.beforeFingerprint === source.afterFingerprint) {
      throw new TypeError('source mutation 必须提供不同的前后工作副本指纹');
    }
    if (taskId !== null && (typeof taskId !== 'string' || !taskId)) {
      throw new TypeError('source mutation taskId 必须是非空字符串或 null');
    }
    return this.timeline.appendSource(source, taskId);
  }

  appendToLatestGroup(id, actions) {
    return this.timeline.appendToLatest(id, actions);
  }

  replaceHistory(other) {
    if (!(other instanceof PatchJournal)) {
      throw new TypeError('replaceHistory 需要另一个 PatchJournal');
    }
    this.state.timeline = structuredClone(other.state.timeline);
    this.timeline = EditTimeline.open(this.state);
    return this;
  }

  group(id) {
    return this.timeline.groups().find(group => group.id === id) ?? null;
  }

  compile() {
    return compileActionGroups(this.timeline.groups());
  }

  compileForWrite() {
    const solidifiedActions = Array.isArray(this.state.solidifiedActions)
      ? this.state.solidifiedActions : [];
    return compileActionGroups([
      { id:'solidified-baseline', taskId:null, active:true, actions:solidifiedActions },
      ...this.timeline.groups(),
    ]);
  }

  solidify(checkpoint = {}) {
    const actions = this.compileForWrite();
    const clearedGroupCount = Array.isArray(this.state.groups) ? this.state.groups.length : 0;
    const clearedRedoCount = Array.isArray(this.state.redo) ? this.state.redo.length : 0;
    this.state.solidifiedActions = structuredClone(actions);
    const archive = this.timeline.archiveAndReset(checkpoint);
    return {
      actions, clearedGroupCount, clearedRedoCount,
      checkpointId:archive.checkpointId,
      archivedEntryIds:archive.entries.map(entry => entry.entryId),
    };
  }

  undo(id) {
    const group = this.timeline.undo(id);
    return group.mutationType === 'source'
      ? [] : [...group.actions].reverse().map(inverse);
  }

  redo(id) {
    const group = this.timeline.redo(id);
    return group.mutationType === 'source' ? [] : group.actions;
  }

  compensate(id) {
    return this.timeline.compensate(id);
  }
}
