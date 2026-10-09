import test from 'node:test';
import assert from 'node:assert/strict';
import { taskHistoryControl } from '../public/task-drawer.mjs';

test('完成任务的卡片历史按钮只切换修改效果，不改变 Agent 生命周期', () => {
  const activeTask = {
    id:'task-1', status:'completed', groupId:'group-agent', effectState:'active',
  };
  const activeGroups = [{ id:'group-agent', taskId:'task-1', active:true }];
  assert.deepEqual(taskHistoryControl(activeTask, activeGroups), {
    method:'undo', groupId:'group-agent', label:'撤销',
  });

  const directlyUndone = { ...activeTask, effectState:'undone' };
  assert.deepEqual(taskHistoryControl(directlyUndone, [
    { ...activeGroups[0], active:false },
  ]), {
    method:'redo', groupId:'group-agent', label:'重做',
  });

  const compensated = { ...activeTask, effectState:'undone' };
  assert.deepEqual(taskHistoryControl(compensated, [
    activeGroups[0],
    {
      id:'group-compensation', active:true,
      compensation:{ entryId:'group-agent', taskId:'task-1' },
    },
  ]), {
    method:'undo', groupId:'group-compensation', label:'重做',
  });

  assert.equal(taskHistoryControl({ ...activeTask, status:'pending' }, activeGroups), null);
  assert.equal(taskHistoryControl({ ...activeTask, groupId:undefined }, activeGroups), null);
});
