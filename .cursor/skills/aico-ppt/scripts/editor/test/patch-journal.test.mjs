import test from 'node:test';
import assert from 'node:assert/strict';
import { PatchJournal } from '../patch-journal.mjs';

const target = { pageKey:'page-001-a', path:'0/1', tag:'DIV', fingerprint:'f1', rect:{x:0,y:0,w:10,h:10} };

test('同一属性只编译最终值，整组可撤销重做', () => {
  const journal = new PatchJournal();
  const group = journal.appendGroup('task-1', [
    { id:'a1', taskId:'task-1', target, kind:'setText', payload:{text:'新'}, before:'旧', after:'新', appliedAt:'t1' },
    { id:'a2', taskId:'task-1', target, kind:'setText', payload:{text:'更新'}, before:'新', after:'更新', appliedAt:'t2' }
  ]);
  assert.equal(journal.compile()[0].after, '更新');
  assert.equal(journal.compile()[0].before, '旧');
  assert.deepEqual(journal.undo(group.id).map(x => x.payload.text), ['新','旧']);
  assert.deepEqual(journal.redo(group.id).map(x => x.payload.text), ['新','更新']);
});

test('连续移动只保留最终位置，但固化与撤销仍从最早基线重放', () => {
  const journal = new PatchJournal();
  journal.appendGroup(null, [{
    id:'move-first', taskId:null, target, kind:'translate',
    payload:{ x:85, y:30 }, before:{ x:0, y:0 }, after:{ x:85, y:30 }, appliedAt:'t1',
  }]);
  journal.appendGroup(null, [{
    id:'move-final', taskId:null, target:{ ...target, fingerprint:'after-first-move' },
    kind:'translate', payload:{ x:-5, y:-14 },
    before:{ x:85, y:30 }, after:{ x:-5, y:-14 }, appliedAt:'t2',
  }]);

  const [compiled] = journal.compile();
  assert.deepEqual(compiled.before, { x:0, y:0 });
  assert.deepEqual(compiled.after, { x:-5, y:-14 });
  assert.deepEqual(compiled.payload, { x:-5, y:-14 });
  assert.deepEqual(compiled.target, target);
});

test('连续控件动作追加到最新历史组并保持一次撤销重做', () => {
  const journal = new PatchJournal();
  const makeSize = (id, before, after) => ({
    id, taskId:null, target, kind:'setStyle',
    payload:{ property:'font-size', value:after }, before, after, appliedAt:id,
  });
  const group = journal.appendGroup(null, [makeSize('size-53', '48px', '53px')]);
  assert.equal(
    journal.appendToLatestGroup(group.id, [makeSize('size-52', '53px', '52px')]).id,
    group.id,
  );
  assert.equal(
    journal.appendToLatestGroup(group.id, [makeSize('size-51', '52px', '51px')]).id,
    group.id,
  );
  assert.equal(journal.group(group.id).actions.length, 3);
  assert.equal(journal.compile()[0].after, '51px');
  assert.deepEqual(journal.undo(group.id).map(action => action.after), ['52px', '53px', '48px']);
  assert.deepEqual(journal.redo(group.id).map(action => action.after), ['53px', '52px', '51px']);
});

test('hide 和 show 共享可见性编译槽并保留最后一次公开动作', () => {
  const journal = new PatchJournal();
  journal.appendGroup('task-2', [
    { id:'v1', taskId:'task-2', target, kind:'hide', payload:{}, before:'', after:'none', appliedAt:'t1' },
    { id:'v2', taskId:'task-2', target, kind:'show', payload:{display:''}, before:'none', after:'', appliedAt:'t2' },
    { id:'v3', taskId:'task-2', target, kind:'hide', payload:{}, before:'', after:'none', appliedAt:'t3' }
  ]);

  assert.deepEqual(journal.compile().map(action => action.kind), ['hide']);
});

test('同一富文本元素的不同文本片段分别保留最终动作', () => {
  const journal = new PatchJournal();
  journal.appendGroup(null, [{
    id:'run-0', taskId:null, target:{ ...target, textPath:'0' },
    kind:'setText', payload:{ text:'第一段更新' }, before:'第一段', after:'第一段更新', appliedAt:'t1',
  }]);
  journal.appendGroup(null, [{
    id:'run-2', taskId:null, target:{ ...target, textPath:'2' },
    kind:'setText', payload:{ text:'第二段更新' }, before:'第二段', after:'第二段更新', appliedAt:'t2',
  }]);
  assert.deepEqual(
    journal.compile().map(action => [action.target.textPath, action.after]),
    [['0','第一段更新'], ['2','第二段更新']],
  );
});

test('局部文字样式按字符范围分别编译，同范围同属性只保留最终值', () => {
  const journal = new PatchJournal();
  journal.appendGroup(null, [{
    id:'range-first', taskId:null, target, kind:'setStyle',
    payload:{ property:'color', value:'red', textRange:{ start:0, end:2 } },
    before:'rgb(0, 0, 0)', after:'red', appliedAt:'t1',
  }]);
  journal.appendGroup(null, [
    {
      id:'range-first-update', taskId:null, target, kind:'setStyle',
      payload:{ property:'color', value:'blue', textRange:{ start:0, end:2 } },
      before:'red', after:'blue', appliedAt:'t2',
    },
    {
      id:'range-second', taskId:null, target, kind:'setStyle',
      payload:{ property:'color', value:'green', textRange:{ start:3, end:5 } },
      before:'rgb(0, 0, 0)', after:'green', appliedAt:'t2',
    },
  ]);
  assert.deepEqual(journal.compile().map(action => [
    action.payload.textRange, action.payload.value,
  ]), [[{ start:0, end:2 }, 'blue'], [{ start:3, end:5 }, 'green']]);
});

test('旧历史中以运行时局部格式 span 为目标的动作会归一到原文本框', () => {
  const journal = new PatchJournal();
  journal.appendGroup(null, [{
    id:'range-root', taskId:null, target, kind:'setStyle',
    payload:{ property:'font-weight', value:'400', textRange:{ start:10, end:28 } },
    before:'700', after:'400', appliedAt:'t1',
  }]);
  journal.appendGroup(null, [{
    id:'range-generated-span', taskId:null,
    target:{ ...target, path:`${target.path}/0`, tag:'SPAN', fingerprint:'generated' },
    kind:'setStyle',
    payload:{ property:'font-weight', value:'700', textRange:{ start:0, end:18 } },
    before:'400', after:'700', appliedAt:'t2',
  }]);
  assert.deepEqual(journal.compile().map(action => ({
    id:action.id,
    target:action.target,
    range:action.payload.textRange,
    value:action.payload.value,
  })), [{
    id:'range-generated-span',
    target,
    range:{ start:10, end:28 },
    value:'700',
  }]);
});

test('已被后续修改完全覆盖的旧条目不制造空补偿', () => {
  const journal = new PatchJournal();
  const first = journal.appendGroup('task-stable-target', [{
    id:'stable-text-first', taskId:'task-stable-target', target,
    kind:'setText', payload:{text:'第一次'}, before:'旧', after:'第一次', appliedAt:'t1',
  }]);
  const modifiedTextTarget = { ...target, fingerprint:'after-first-text' };
  journal.appendGroup('task-stable-target', [{
    id:'stable-text-second', taskId:'task-stable-target', target:modifiedTextTarget,
    kind:'setText', payload:{text:'第二次'}, before:'第一次', after:'第二次', appliedAt:'t2',
  }]);
  const modifiedAgainTarget = { ...target, fingerprint:'after-second-text' };
  journal.appendGroup('task-stable-target', [{
    id:'stable-translate', taskId:'task-stable-target', target:modifiedAgainTarget,
    kind:'translate', payload:{x:20,y:10}, before:{x:0,y:0}, after:{x:20,y:10}, appliedAt:'t3',
  }]);
  assert.throws(
    () => journal.compensate(first.id),
    error => error.code === 'NOTHING_TO_COMPENSATE',
  );

  const compiled = journal.compile();
  assert.deepEqual(compiled.map(action => action.kind), ['setText','translate']);
  assert.deepEqual(compiled.map(action => action.target), [target,target]);
  assert.equal(compiled[0].after, '第二次');
});

test('固化会把当前最终动作折叠进基线并清空撤销重做，后续固化继续覆盖基线', () => {
  const journal = new PatchJournal({ groups:[], redo:[], solidifiedActions:[] });
  journal.appendGroup(null, [{
    id:'solidify-first', taskId:null, target,
    kind:'setText', payload:{ text:'第一次' }, before:'旧', after:'第一次', appliedAt:'t1',
  }]);

  const first = journal.solidify();
  assert.equal(first.clearedGroupCount, 1);
  assert.equal(first.clearedRedoCount, 0);
  assert.deepEqual(journal.state.groups, []);
  assert.deepEqual(journal.state.redo, []);
  assert.equal(journal.state.solidifiedActions[0].after, '第一次');
  assert.deepEqual(journal.compile(), []);

  journal.appendGroup(null, [{
    id:'solidify-second', taskId:null, target:{ ...target, fingerprint:'after-first' },
    kind:'setText', payload:{ text:'第二次' }, before:'第一次', after:'第二次', appliedAt:'t2',
  }]);
  assert.equal(journal.compileForWrite()[0].after, '第二次');
  assert.deepEqual(journal.compileForWrite()[0].target, target);

  journal.solidify();
  assert.equal(journal.state.solidifiedActions.length, 1);
  assert.equal(journal.state.solidifiedActions[0].after, '第二次');
  assert.deepEqual(journal.state.groups, []);
  assert.deepEqual(journal.state.redo, []);
});

test('结构修改只进入统一历史，不会被编译成元素动作', () => {
  const journal = new PatchJournal({ groups:[], redo:[], solidifiedActions:[] });
  const source = journal.appendSourceGroup({
    beforeFingerprint:'a'.repeat(64), afterFingerprint:'b'.repeat(64),
    origin:'agent-cli', summary:'删除第 3 页',
  }, 'task-delete-page');
  assert.equal(source.mutationType, 'source');
  assert.equal(source.taskId, 'task-delete-page');
  assert.deepEqual(journal.compile(), []);
  assert.deepEqual(journal.undo(source.id), []);
  assert.equal(journal.group(source.id).active, false);
  assert.deepEqual(journal.redo(source.id), []);
  assert.equal(journal.group(source.id).active, true);
  assert.throws(() => journal.appendSourceGroup({
    beforeFingerprint:'a'.repeat(64), afterFingerprint:'a'.repeat(64),
  }), /不同的前后/);
});
