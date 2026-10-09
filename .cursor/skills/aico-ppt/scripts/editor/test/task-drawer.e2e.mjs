import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer, openEditor } from './test-helpers.mjs';

test('活动批次与下一批新标注分区显示，且只冻结在途任务', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  await page.evaluate(async token => {
    const { renderTaskDrawer } = await import(
      `/editor/task-drawer.mjs?token=${encodeURIComponent(token)}&test=agent-batches`
    );
    const root = document.createElement('aside');
    root.className = 'task-drawer';
    root.dataset.testAgentBatches = '';
    root.dataset.open = 'true';
    document.body.append(root);
    const task = (id, instruction, status = 'pending') => ({
      id, pageKey:`page-${id}`, pageIndex:1, pageLabel:'测试页',
      rect:{ x:10, y:10, w:200, h:120 }, instruction, status,
    });
    const tasks = [
      task('task-a', '批次一任务'),
      task('task-b', '下一批新标注'),
      task('task-c', '已经完成', 'completed'),
    ];
    window.__renderBatchDrawer = agentRun => renderTaskDrawer(root, {
      tasks,
      agentRun,
      onEdit() {}, onDelete() {},
      onProcessAll(selected) {
        window.__submittedBatchTaskIds = selected.map(item => item.id);
      },
    });
    window.__setBatchTaskStatus = (id, status) => {
      const selected = tasks.find(item => item.id === id);
      if (selected) selected.status = status;
    };
    window.__renderBatchDrawer({
      id:'batch-1', status:'running', taskCount:1,
      activeBatch:{ id:'batch-1', ordinal:1, taskIds:['task-a'] },
      nextBatch:{ taskIds:['task-b'], actionableTaskIds:['task-b'], count:1 },
      residualBatches:[],
      batches:[{ id:'batch-1', ordinal:1, taskIds:['task-a'] }],
    });
  }, app.token);

  const root = page.locator('[data-test-agent-batches]');
  const active = root.locator('[data-task-batch-section="active"]');
  const next = root.locator('[data-task-batch-section="next"]');
  assert.match(await active.locator('.task-batch-header').innerText(), /正在处理 · 批次 1/);
  assert.match(await active.innerText(), /批次一任务/);
  assert.match(await next.locator('.task-batch-header').innerText(), /下一批 · 新标注/);
  assert.match(await next.innerText(), /下一批新标注/);
  assert.equal(await active.locator('.task-status').innerText(), '等待 Agent');
  assert.equal(await next.locator('.task-status').innerText(), '未提交');
  assert.equal(await active.locator('[data-task-edit]').isDisabled(), true);
  assert.equal(await next.locator('[data-task-edit]').isDisabled(), false);
  assert.equal(await root.locator('[data-process-all]').isDisabled(), true);
  assert.match(
    await root.locator('[data-process-all] .pill-nav-label-default').innerText(),
    /批次 1 正在处理 · 下一批已积累 1 条/,
  );

  await page.evaluate(() => window.__renderBatchDrawer({
    id:'batch-1', status:'failed', taskCount:1,
    activeBatch:null,
    nextBatch:{ taskIds:['task-b'], actionableTaskIds:['task-b'], count:1 },
    residualBatches:[{
      id:'batch-1', ordinal:1, taskIds:['task-a'],
      unfinishedTaskIds:['task-a'], actionableTaskIds:['task-a'],
    }],
    batches:[{ id:'batch-1', ordinal:1, taskIds:['task-a'] }],
  }));
  const residual = root.locator('[data-task-batch-section="residual"]');
  assert.match(await residual.locator('.task-batch-header').innerText(), /批次 1 · 未完成/);
  assert.equal(await residual.locator('[data-retry-agent-batch]').count(), 1);
  assert.equal(await residual.locator('[data-merge-agent-batch]').count(), 1);
  await residual.locator('[data-retry-agent-batch]').click();
  assert.deepEqual(await page.evaluate(() => window.__submittedBatchTaskIds), ['task-a']);
  await residual.locator('[data-merge-agent-batch]').click();
  assert.deepEqual(await page.evaluate(() => window.__submittedBatchTaskIds), ['task-a', 'task-b']);

  await page.evaluate(() => {
    window.__setBatchTaskStatus('task-b', 'completed');
    window.__renderBatchDrawer({
      id:'batch-1', status:'failed', taskCount:1,
      activeBatch:null,
      nextBatch:{ taskIds:[], actionableTaskIds:[], count:0 },
      residualBatches:[{
        id:'batch-1', ordinal:1, taskIds:['task-a'],
        unfinishedTaskIds:['task-a'], actionableTaskIds:['task-a'],
      }],
      batches:[{ id:'batch-1', ordinal:1, taskIds:['task-a'] }],
    });
  });
  assert.match(
    await root.locator('[data-process-all] .pill-nav-label-default').innerText(),
    /下一批暂无新任务.*上方重新提交按钮/,
  );
  assert.equal(await root.locator('[data-process-all]').isDisabled(), true);
  assert.equal(
    await residual.locator('[data-retry-agent-batch] .pill-nav-label-default').innerText(),
    '重新提交本批未完成任务（1 条）',
  );
  assert.equal(await residual.locator('[data-retry-agent-batch]').isDisabled(), false);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('待确认任务显示原因、补充说明入口与提醒动画', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  await page.evaluate(async token => {
    const { renderTaskDrawer } = await import(
      `/editor/task-drawer.mjs?token=${encodeURIComponent(token)}&test=needs-confirmation`
    );
    const root = document.createElement('aside');
    root.className = 'task-drawer';
    root.dataset.testTaskDrawer = '';
    root.dataset.open = 'true';
    document.body.append(root);
    renderTaskDrawer(root, {
      tasks:[{
        id:'task-needs-confirmation',
        pageKey:'page-002',
        pageIndex:2,
        pageLabel:'目录',
        rect:{ x:10, y:10, w:200, h:120 },
        instruction:'把流程图改成一个完整整体',
        status:'needs-confirmation',
        candidates:[{ path:'0/1' }, { path:'0/2' }],
      }],
      onEdit() {},
      onDelete() {},
    });
  }, app.token);

  const root = page.locator('[data-test-task-drawer]');
  const row = root.locator('[data-task-row="task-needs-confirmation"]');
  const notice = row.locator('[data-task-confirmation-notice]');
  assert.match(await notice.innerText(), /多个可能目标/);
  assert.match(await notice.innerText(), /补充说明/);
  assert.equal(
    await row.locator('[data-task-edit] .pill-nav-label-default').innerText(),
    '补充说明',
  );
  assert.equal(
    await root.locator('[data-process-all] .pill-nav-label-default').innerText(),
    '有 1 条任务需要补充说明',
  );
  assert.equal(await root.locator('[data-process-all]').isDisabled(), true);
  assert.match(await root.locator('[data-process-note]').innerText(), /定位不唯一/);

  const animationName = await row.locator('.task-confirmation-indicator').evaluate(
    node => getComputedStyle(node).animationName,
  );
  assert.equal(animationName, 'task-confirmation-pulse');
  await page.emulateMedia({ reducedMotion:'reduce' });
  const reducedAnimationName = await row.locator('.task-confirmation-indicator').evaluate(
    node => getComputedStyle(node).animationName,
  );
  assert.equal(reducedAnimationName, 'none');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('待处理任务的原目标不可定位时保留记录但不能定位或交给 Agent', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  await page.evaluate(async token => {
    const { renderTaskDrawer } = await import(
      `/editor/task-drawer.mjs?token=${encodeURIComponent(token)}&test=target-missing`
    );
    const root = document.createElement('aside');
    root.className = 'task-drawer';
    root.dataset.testMissingTaskDrawer = '';
    root.dataset.open = 'true';
    document.body.append(root);
    renderTaskDrawer(root, {
      tasks:[{
        id:'task-target-missing',
        pageKey:'page-deleted',
        pageIndex:2,
        pageLabel:'已删除页',
        rect:{ x:10, y:10, w:200, h:120 },
        instruction:'把标题改短',
        status:'pending',
        targetMissing:true,
      }],
      onLocate() { window.__missingTaskLocated = true; },
      onProcessAll() { window.__missingTaskProcessed = true; },
      onEdit() {},
      onDelete() {},
    });
  }, app.token);

  const root = page.locator('[data-test-missing-task-drawer]');
  const row = root.locator('[data-task-row="task-target-missing"]');
  assert.equal(await row.locator('[data-task-locate]').isDisabled(), true);
  assert.match(await row.locator('[data-task-target-missing]').innerText(), /原目标当前无法定位/);
  assert.equal(await row.locator('[data-task-edit]').count(), 0);
  assert.equal(await row.locator('[data-task-delete]').count(), 1);
  assert.equal(await root.locator('[data-process-all]').isDisabled(), true);
  assert.equal(
    await root.locator('[data-process-all] .pill-nav-label-default').innerText(),
    '有 1 条任务的目标不可定位',
  );
  assert.match(await root.locator('[data-process-note]').innerText(), /撤销相关结构修改/);
  assert.deepEqual(await page.evaluate(() => ({
    located:Boolean(window.__missingTaskLocated),
    processed:Boolean(window.__missingTaskProcessed),
  })), { located:false, processed:false });
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('已完成任务的旧目标不可定位时仍显示完成且不触发缺页告警', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  await page.evaluate(async token => {
    const { renderTaskDrawer } = await import(
      `/editor/task-drawer.mjs?token=${encodeURIComponent(token)}&test=completed-target-missing`
    );
    const root = document.createElement('aside');
    root.className = 'task-drawer';
    root.dataset.testCompletedMissingTaskDrawer = '';
    root.dataset.open = 'true';
    root.dataset.completedOpen = 'true';
    document.body.append(root);
    renderTaskDrawer(root, {
      tasks:[{
        id:'task-completed-target-missing',
        pageKey:'page-replaced',
        pageIndex:12,
        pageLabel:'替换前页面',
        rect:{ x:10, y:10, w:200, h:120 },
        instruction:'插入新页后删除旧页',
        status:'completed',
        targetMissing:true,
        groupId:'group-replacement',
      }],
      onLocate() { window.__completedMissingTaskLocated = true; },
      onProcessAll() { window.__completedMissingTaskProcessed = true; },
      onHistory() {},
    });
  }, app.token);

  const root = page.locator('[data-test-completed-missing-task-drawer]');
  const row = root.locator('[data-task-row="task-completed-target-missing"]');
  assert.equal(await row.locator('[data-task-locate]').isDisabled(), true);
  assert.equal(await row.locator('.task-status').innerText(), '已完成');
  assert.equal(await row.locator('[data-task-target-missing]').count(), 0);
  assert.equal(await row.locator('[data-task-undo]').count(), 1);
  assert.equal(
    await root.locator('[data-process-all] .pill-nav-label-default').innerText(),
    '没有待处理任务',
  );
  assert.doesNotMatch(await root.locator('[data-process-note]').innerText(), /页面已删除|目标不可定位/);
  assert.deepEqual(await page.evaluate(() => ({
    located:Boolean(window.__completedMissingTaskLocated),
    processed:Boolean(window.__completedMissingTaskProcessed),
  })), { located:false, processed:false });
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('已完成任务按最近修改时间倒序展示，待处理任务保持原顺序', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  await page.evaluate(async token => {
    const { renderTaskDrawer } = await import(
      `/editor/task-drawer.mjs?token=${encodeURIComponent(token)}&test=completed-recency`
    );
    const root = document.createElement('aside');
    root.className = 'task-drawer';
    root.dataset.testCompletedOrder = '';
    root.dataset.open = 'true';
    root.dataset.completedOpen = 'true';
    document.body.append(root);
    const task = (id, instruction, status, updatedAt) => ({
      id,
      pageKey:`page-${id}`,
      pageIndex:1,
      pageLabel:'测试页',
      rect:{ x:10, y:10, w:200, h:120 },
      instruction,
      status,
      updatedAt,
    });
    renderTaskDrawer(root, {
      tasks:[
        task('completed-latest', '最近完成', 'completed', '2026-08-16T12:00:00.000Z'),
        task('pending-first', '待处理一', 'pending', '2026-08-16T12:05:00.000Z'),
        task('completed-earliest', '最早完成', 'completed', '2026-08-16T10:00:00.000Z'),
        task('pending-second', '待处理二', 'pending', '2026-08-16T12:06:00.000Z'),
        task('completed-middle', '中间完成', 'completed', '2026-08-16T11:00:00.000Z'),
      ],
      onEdit() {},
      onDelete() {},
    });
  }, app.token);

  const root = page.locator('[data-test-completed-order]');
  assert.deepEqual(
    await root.locator('.task-batch-section-next .task-batch-list > [data-task-row]').evaluateAll(
      rows => rows.map(row => row.dataset.taskRow),
    ),
    ['pending-first', 'pending-second'],
  );
  assert.deepEqual(
    await root.locator('.task-completed-list > [data-task-row]').evaluateAll(
      rows => rows.map(row => row.dataset.taskRow),
    ),
    ['completed-latest', 'completed-middle', 'completed-earliest'],
  );
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('历史冲突展示真实原因，不再要求用户补充目标说明', async t => {
  const app=await startFixtureServer();t.after(()=>app.close());
  const {browser,page}=await openEditor(app);t.after(()=>browser.close());
  await page.evaluate(async token=>{
    const {renderTaskDrawer}=await import(`/editor/task-drawer.mjs?token=${encodeURIComponent(token)}`);
    const root=document.createElement('aside');root.id='history-failure-drawer';root.className='task-drawer';root.dataset.open='true';document.body.append(root);
    renderTaskDrawer(root,{tasks:[{
      id:'failure',pageKey:'page-a',pageIndex:1,pageLabel:'目录',rect:{x:1,y:1,w:100,h:100},
      instruction:'不要高亮',status:'failed',candidates:[],
      lastError:{code:'HISTORY_DIVERGED',message:'编辑历史与页面状态不同步，本次修改未提交。',recovery:'请重新打开工作项后重试；无需重新描述标记对象。'},
    }],onEdit(){}});
  },app.token);
  const row=page.locator('#history-failure-drawer');
  assert.match(await row.innerText(),/HISTORY_DIVERGED/);
  assert.doesNotMatch(await row.innerText(),/多个可能目标|补充说明/);
});
