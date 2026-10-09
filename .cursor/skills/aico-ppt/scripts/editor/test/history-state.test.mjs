import test from 'node:test';
import assert from 'node:assert/strict';
import { historyCandidates, historyLabel } from '../history-state.mjs';

const groups = [
  { id:'g-text', taskId:null, active:true, actions:[{ kind:'setText' }] },
  { id:'g-agent', taskId:'t-1', active:false, actions:[{ kind:'translate' }, { kind:'resize' }] },
  { id:'g-move', taskId:null, active:true, actions:[{ kind:'translate' }] },
];

test('候选跳过 inactive group 并使用 redo 栈尾', () => {
  const result = historyCandidates(groups, ['g-agent']);
  assert.equal(result.undoGroup.id, 'g-move');
  assert.equal(result.redoGroup.id, 'g-agent');
});

test('摘要区分人工动作和 Agent 任务', () => {
  const tasks = [{ id:'t-1', instruction:'替换为附件中的新版架构图' }];
  assert.equal(historyLabel(groups[0], tasks, 'undo'), '撤销文字修改');
  assert.equal(historyLabel(groups[1], tasks, 'redo'), '重做 Agent 任务：替换为附件中的新版架构图');
  assert.equal(historyLabel(groups[2], tasks, 'undo'), '撤销移动');
});

test('无候选时返回 null', () => {
  assert.deepEqual(historyCandidates([], []), { undoGroup:null, redoGroup:null });
});

test('结构修改显示来源摘要而不是零项动作', () => {
  assert.equal(historyLabel({
    mutationType:'source', taskId:null, active:true, actions:[],
    source:{ summary:'模板升级并保留页面 ID' },
  }, [], 'undo'), '撤销结构修改：模板升级并保留页面 ID');
});

test('补偿条目的全局撤销明确表示恢复任务效果', () => {
  const compensation = {
    id:'compensation', taskId:null, active:true, actions:[],
    compensation:{ entryId:'g-agent', taskId:'t-1' },
  };
  const tasks = [{ id:'t-1', instruction:'把标题改为红色' }];
  assert.equal(
    historyLabel(compensation, tasks, 'undo'),
    '恢复已撤销的 Agent 任务：把标题改为红色',
  );
  assert.equal(
    historyLabel(compensation, tasks, 'redo'),
    '再次撤销 Agent 任务：把标题改为红色',
  );
});
