import test from 'node:test';
import assert from 'node:assert/strict';
import { EditTimeline, HistoryIntegrityError } from '../edit-timeline.mjs';
import { compileActionGroups } from '../action-compiler.mjs';

const target = {
  pageKey:'page-001-a', path:'0/1', tag:'DIV', fingerprint:'f1',
  rect:{ x:0, y:0, w:10, h:10 },
};

const move = (id, before, after, taskId=null) => ({
  id, taskId, target, kind:'translate', payload:after,
  before, after, appliedAt:id,
});

const text = (id, before, after, taskId=null) => ({
  id, taskId, target, kind:'setText', payload:{ text:after },
  before, after, appliedAt:id,
});

test('严格 cursor 只允许撤销上一条、重做下一条，新提交截断 redo 分支', () => {
  const state = { groups:[], redo:[], solidifiedActions:[] };
  const timeline = EditTimeline.open(state);
  const first = timeline.appendActions(null, [text('a1', '旧', '一')]);
  const second = timeline.appendActions(null, [text('a2', '一', '二')]);

  assert.throws(
    () => timeline.undo(first.id),
    error => error instanceof HistoryIntegrityError && error.code === 'HISTORY_ORDER',
  );
  timeline.undo(second.id);
  assert.equal(state.timeline.cursor, 1);
  assert.deepEqual(state.redo, [second.id]);

  const branch = timeline.appendActions(null, [text('a3', '一', '三')]);
  assert.equal(state.timeline.cursor, 2);
  assert.deepEqual(state.redo, []);
  assert.deepEqual(state.groups.map(group => group.id), [first.id, branch.id]);
});

test('颜色表示先做语义规范化，真实 before 链断裂则拒绝写入', () => {
  const state = { groups:[], redo:[], solidifiedActions:[] };
  const timeline = EditTimeline.open(state);
  timeline.appendActions(null, [{
    id:'color-1', taskId:null, target, kind:'setStyle',
    payload:{ property:'color', value:'#666666' },
    before:'#000', after:'#666666', appliedAt:'t1',
  }]);
  assert.doesNotThrow(() => timeline.appendActions(null, [{
    id:'color-2', taskId:null, target, kind:'setStyle',
    payload:{ property:'color', value:'#777' },
    before:'rgb(102, 102, 102)', after:'#777', appliedAt:'t2',
  }]));
  assert.throws(() => timeline.appendActions(null, [{
    id:'color-3', taskId:null, target, kind:'setStyle',
    payload:{ property:'color', value:'#888' },
    before:'#123456', after:'#888', appliedAt:'t3',
  }]), error => error.code === 'HISTORY_DIVERGED');
});

test('长度单位只对长度属性规范化，不把字重误判为 px', () => {
  const state = { groups:[], redo:[], solidifiedActions:[] };
  const timeline = EditTimeline.open(state);
  timeline.appendActions(null, [{
    id:'size-1', taskId:null, target, kind:'setStyle',
    payload:{ property:'font-size', value:'48px' },
    before:'32px', after:'48px', appliedAt:'t1',
  }]);
  assert.doesNotThrow(() => timeline.appendActions(null, [{
    id:'size-2', taskId:null, target, kind:'setStyle',
    payload:{ property:'font-size', value:'56px' },
    before:'48', after:'56px', appliedAt:'t2',
  }]));

  const weightState = { groups:[], redo:[], solidifiedActions:[] };
  const weightTimeline = EditTimeline.open(weightState);
  weightTimeline.appendActions(null, [{
    id:'weight-1', taskId:null, target, kind:'setStyle',
    payload:{ property:'font-weight', value:'700' },
    before:'400', after:'700', appliedAt:'t1',
  }]);
  assert.throws(() => weightTimeline.appendActions(null, [{
    id:'weight-2', taskId:null, target, kind:'setStyle',
    payload:{ property:'font-weight', value:'800' },
    before:'700px', after:'800', appliedAt:'t2',
  }]), error => error.code === 'HISTORY_DIVERGED');
});

test('非末尾 Agent 任务通过补偿条目撤销，后续人工修改保持生效', () => {
  const state = { groups:[], redo:[], solidifiedActions:[] };
  const timeline = EditTimeline.open(state);
  const agent = timeline.appendActions('task-red', [{
    id:'red', taskId:'task-red', target, kind:'setStyle',
    payload:{ property:'color', value:'red' },
    before:'black', after:'red', appliedAt:'t1',
  }]);
  timeline.appendActions(null, [{
    id:'size', taskId:null, target, kind:'setStyle',
    payload:{ property:'font-size', value:'48px' },
    before:'32px', after:'48px', appliedAt:'t2',
  }]);

  const compensation = timeline.compensate(agent.id);
  assert.equal(compensation.compensation.entryId, agent.id);
  const compiled = compileActionGroups(timeline.groups());
  assert.deepEqual(compiled.map(action => [action.payload.property, action.after]), [
    ['color', 'black'],
    ['font-size', '48px'],
  ]);
});

test('旧 active 孔洞迁移时只保留当前生效历史并归档不可安全重做的条目', () => {
  const state = {
    version:1,
    groups:[
      { id:'g1', taskId:null, active:true, actions:[move('m1', {x:0,y:0}, {x:1,y:1})] },
      { id:'g2', taskId:null, active:false, actions:[move('m2', {x:1,y:1}, {x:2,y:2})] },
      { id:'g3', taskId:null, active:true, actions:[move('m3', {x:1,y:1}, {x:3,y:3})] },
    ],
    redo:['g2'], solidifiedActions:[],
  };
  EditTimeline.open(state);
  assert.equal(state.historyMigration.mode, 'linearized-active');
  assert.deepEqual(state.groups.map(group => group.id), ['g1', 'g3']);
  assert.deepEqual(state.redo, []);
  assert.equal(state.historyMigration.archivedRedoCount, 1);
});
