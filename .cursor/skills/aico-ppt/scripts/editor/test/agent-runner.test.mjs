import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AgentBatchCoordinator,
  AgentRunCoordinator,
  buildAgentPrompt,
  buildSessionInitializationPrompt,
} from '../agent-runner.mjs';

test('活动执行批次冻结成员，新标注进入下一批候选任务', async () => {
  let release;
  const completion = new Promise(resolve => { release = resolve; });
  const session = {
    revision:2,
    tasks:[{ id:'task-a', status:'pending' }],
    agentBatches:[],
  };
  const coordinator = new AgentBatchCoordinator({
    provider:'agent-terminal',
    adapter:{
      id:'agent-terminal',
      async run() {
        await completion;
        session.tasks[0].status = 'completed';
        return { summary:'第一批完成' };
      },
    },
    getSession:() => session,
    captureBatch:async ({ taskIds, provider, mode }) => {
      const batch = {
        id:'batch-1', ordinal:1, provider, mode,
        taskIds:[...taskIds], createdAt:'2026-08-21T08:00:00.000Z',
        settlement:null,
      };
      session.agentBatches.push(batch);
      session.revision += 1;
      return { batch, revision:session.revision };
    },
    settleBatch:async () => ({ revision:session.revision }),
    getContext:() => ({ deckPath:'/tmp/deck.html' }),
  });

  const started = await coordinator.submit({ expectedRevision:2, taskIds:['task-a'] });
  assert.deepEqual(started.activeBatch.taskIds, ['task-a']);
  session.tasks.push({ id:'task-b', status:'pending' });
  assert.deepEqual(coordinator.snapshot().activeBatch.taskIds, ['task-a']);
  assert.deepEqual(coordinator.snapshot().nextBatch.taskIds, ['task-b']);
  assert.equal(coordinator.snapshot().canSubmitNext, false);

  release();
  await coordinator.activePromise;
  assert.equal(coordinator.snapshot().activeBatch, null);
  assert.deepEqual(coordinator.snapshot().nextBatch.taskIds, ['task-b']);
  assert.equal(coordinator.snapshot().canSubmitNext, true);
  await coordinator.close();
});

test('服务重启后未完成的持久化批次恢复为批次剩余任务', async () => {
  const session = {
    revision:8,
    tasks:[
      { id:'task-old', status:'pending' },
      { id:'task-new', status:'pending' },
    ],
    agentBatches:[{
      id:'batch-old', ordinal:1, provider:'agent-terminal', mode:'terminal',
      taskIds:['task-old'], createdAt:'2026-08-21T08:00:00.000Z',
      settlement:{
        outcome:'cancelled', settledAt:'2026-08-21T08:01:00.000Z',
        message:'Editor 已重启',
      },
    }],
  };
  const coordinator = new AgentBatchCoordinator({
    provider:'agent-terminal',
    adapter:{ id:'agent-terminal', run:async () => ({}) },
    getSession:() => session,
    getContext:() => ({ deckPath:'/tmp/deck.html' }),
  });

  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.activeBatch, null);
  assert.deepEqual(snapshot.residualBatches.map(batch => ({
    id:batch.id, unfinishedTaskIds:batch.unfinishedTaskIds,
  })), [{ id:'batch-old', unfinishedTaskIds:['task-old'] }]);
  assert.deepEqual(snapshot.nextBatch.taskIds, ['task-new']);
  assert.equal(snapshot.canSubmitNext, true);
  await coordinator.close();
});

test('需要用户补充说明的在途任务不能把批次冒充为成功', async () => {
  const session = {
    revision:3,
    tasks:[{ id:'task-a', status:'pending' }],
  };
  const coordinator = new AgentRunCoordinator({
    provider:'agent-terminal',
    adapter:{
      id:'agent-terminal',
      async run() {
        session.tasks[0].status = 'needs-confirmation';
        return { summary:'需要用户确认目标' };
      },
    },
    getSession:() => session,
    getContext:() => ({ deckPath:'/tmp/deck.html' }),
  });

  coordinator.start({ expectedRevision:3, taskIds:['task-a'] });
  await coordinator.activePromise;
  assert.equal(coordinator.snapshot().status, 'failed');
  assert.equal(coordinator.snapshot().code, 'AGENT_TASKS_NEED_CONFIRMATION');
  assert.match(coordinator.snapshot().message, /1 个任务需要补充说明/);
  await coordinator.close();
});

test('终端任务 Prompt 限定批次、Skill 与写回边界', () => {
  const prompt = buildAgentPrompt({
    deckPath:'/tmp/deck.html', serviceUrl:'http://127.0.0.1:1234',
    token:'secret', taskIds:['task-a'], sourceThreadId:null,
    loadSkill:true, skillRoot:'/skill',
  });
  assert.match(prompt, /^\$aico-ppt/m);
  assert.match(prompt, /完整读取 "[\\/]+skill[\\/]+SKILL\.md"/);
  assert.match(prompt, /只处理本批 ID/);
  assert.match(prompt, /不调用 write-deck/);
  assert.match(prompt, /不调用 \/api\/shutdown/);
  assert.match(prompt, /关闭 \/ 重启当前 Editor/);
  assert.match(prompt, /pageKey[^。\n]*delete_page_by_id/);
  assert.match(prompt, /begin-source-task TASK_ID/);
  assert.match(prompt, /commit-source-edit SOURCE_EDIT_ID/);
  assert.match(prompt, /cancel-source-edit SOURCE_EDIT_ID/);
  assert.match(prompt, /只有 begin 成功后/);
  assert.match(prompt, /已固化 action[^。]*不得提前放弃事务/);
  assert.match(prompt, /PAGE_NOT_FOUND \/ TARGET_NOT_FOUND/);
  assert.match(prompt, /本批任务 ID：\["task-a"\]/);

  const resumed = buildAgentPrompt({
    deckPath:'/tmp/deck.html', serviceUrl:'http://127.0.0.1:1234',
    token:'secret', taskIds:['task-b'], sourceThreadId:null,
    loadSkill:false, skillRoot:'/skill',
  });
  assert.doesNotMatch(resumed, /先完整读取/);
  assert.match(resumed, /不要再次完整读取 SKILL\.md/);
});

test('终端初始化 Prompt 继承 Creation 上下文且不直接修改真实 Deck', () => {
  const initialized = buildSessionInitializationPrompt({
    deckPath:'/tmp/working.html', sourceDeckPath:'/tmp/source.html',
    projectPath:'/tmp', creationContextPath:'/tmp/session/creation-context.json',
  });
  assert.match(initialized, /Creation 上下文清单：\/tmp\/session\/creation-context\.json/);
  assert.match(initialized, /brief、大纲、页面规划、设计文稿与素材库/);
  assert.match(initialized, /绝不能改真实 Deck/);
  assert.match(initialized, /不得调用 \/api\/shutdown/);
  assert.match(initialized, /begin-source-edit/);
  assert.match(initialized, /commit-source-edit/);
  assert.match(initialized, /cancel-source-edit/);
  assert.match(initialized, /删页若取代了旧的已固化 action[^。]*仍应正常提交事务/);
  assert.match(initialized, /同一组、同一层级、同一语义角色的普通信息卡必须同构/);
  assert.match(initialized, /不得为了构图制造默认高亮/);
});

test('任务协调器拒绝并发，并在任务确实完成后发布成功', async () => {
  let release;
  const completion = new Promise(resolve => { release = resolve; });
  const session = {
    revision:2,
    tasks:[{ id:'task-a', status:'pending' }, { id:'task-done', status:'completed' }],
  };
  const coordinator = new AgentRunCoordinator({
    provider:'agent-terminal',
    adapter:{
      id:'agent-terminal',
      async run() {
        await completion;
        session.tasks[0].status = 'completed';
        return { summary:'处理完成' };
      },
    },
    getSession:() => session,
    getContext:() => ({ deckPath:'/tmp/deck.html' }),
  });

  assert.equal(coordinator.start({ expectedRevision:2, taskIds:['task-a'] }).status, 'queued');
  assert.throws(
    () => coordinator.start({ expectedRevision:2, taskIds:['task-a'] }),
    error => error.code === 'AGENT_RUN_ACTIVE',
  );
  release();
  await coordinator.activePromise;
  assert.equal(coordinator.snapshot().status, 'succeeded');
  assert.equal(coordinator.snapshot().message, '处理完成');
  await coordinator.close();
});

test('感知提交回执的 Agent 在提示词真正发出前保持排队态', async () => {
  let publishProgress;
  let finish;
  const completion = new Promise(resolve => { finish = resolve; });
  const session = { revision:5, tasks:[{ id:'task-a', status:'pending' }] };
  const coordinator = new AgentRunCoordinator({
    provider:'agent-terminal',
    adapter:{
      id:'agent-terminal', submissionAware:true,
      async run({ onProgress }) {
        publishProgress = onProgress;
        await completion;
        session.tasks[0].status = 'completed';
        return { summary:'处理完成' };
      },
    },
    getSession:() => session,
    getContext:() => ({ deckPath:'/tmp/deck.html' }),
  });

  coordinator.start({ expectedRevision:5, taskIds:['task-a'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(coordinator.snapshot().status, 'queued');
  publishProgress({ status:'running', message:'任务已确认提交到终端' });
  assert.equal(coordinator.snapshot().status, 'running');
  finish();
  await coordinator.activePromise;
  assert.equal(coordinator.snapshot().status, 'succeeded');
  await coordinator.close();
});

test('任务协调器拒绝把正常退出冒充任务完成', async () => {
  const session = {
    revision:4,
    tasks:[{ id:'task-a', status:'pending' }, { id:'task-b', status:'failed' }],
  };
  const coordinator = new AgentRunCoordinator({
    provider:'agent-terminal',
    adapter:{ id:'agent-terminal', run:async () => ({ summary:'进程退出但没有写回' }) },
    getSession:() => session,
    getContext:() => ({ deckPath:'/tmp/deck.html' }),
  });

  coordinator.start({ expectedRevision:4, taskIds:['task-a', 'task-b'] });
  await coordinator.activePromise;
  assert.equal(coordinator.snapshot().status, 'failed');
  assert.equal(coordinator.snapshot().code, 'AGENT_TASKS_UNCHANGED');
  assert.match(coordinator.snapshot().message, /2 个任务仍未处理/);
  await coordinator.close();
});

test('任务协调器可由终端 Esc 取消并保留任务供重试', async () => {
  const session = { revision:3, tasks:[{ id:'task-a', status:'pending' }] };
  const coordinator = new AgentRunCoordinator({
    provider:'agent-terminal',
    adapter:{
      id:'agent-terminal',
      async run({ signal }) {
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(
            new Error('Agent 任务已取消'), { code:'AGENT_RUN_CANCELLED' },
          )), { once:true });
        });
      },
    },
    getSession:() => session,
    getContext:() => ({ deckPath:'/tmp/deck.html' }),
  });

  coordinator.start({ expectedRevision:3, taskIds:['task-a'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(coordinator.cancel('用户在 Agent CLI 中按 Esc 中断本批任务'), true);
  await coordinator.activePromise;
  assert.equal(coordinator.snapshot().status, 'cancelled');
  assert.equal(session.tasks[0].status, 'pending');
  await coordinator.close();
});
