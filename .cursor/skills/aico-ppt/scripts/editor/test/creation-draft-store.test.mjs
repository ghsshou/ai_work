import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CreationDraftStore,
  createMemoryCreationDraftAdapter,
} from '../creation-draft-store.mjs';

function validBrief() {
  return {
    title:'昇腾推理优化实践',
    scene:'技术分享',
    audience:'平台与算法工程师',
    durationMinutes:30,
    objective:'让听众能够定位并优化推理瓶颈',
    materials:'已有性能数据与架构图',
    brandRequirements:'华为红品牌',
    deliveryRequirements:'HTML，后续导出 PPTX',
    recommendedTemplateId:'tech-share',
    suggestedPageCount:18,
  };
}

function validOutline() {
  return {
    sections:[
      { chapterId:'context', title:'背景与目标', objective:'建立问题共识', pageBudget:3, timeBudgetMinutes:5 },
      { chapterId:'method', title:'方法与实践', objective:'讲清优化路径', pageBudget:10, timeBudgetMinutes:20 },
      { chapterId:'summary', title:'总结', objective:'形成行动建议', pageBudget:2, timeBudgetMinutes:5 },
    ],
  };
}

function validPagePlan() {
  return {
    pages:[
      {
        pageId:'page-cover', chapterId:'context', pageTypeId:'cover', label:'封面',
        coreClaim:'昇腾推理优化是一套可复用的工程方法', layoutRationale:'开场建立主题',
        artwork:'抽象算力网络背景', steps:0,
      },
      {
        pageId:'page-method', chapterId:'method', pageTypeId:'three-columns', label:'优化方法',
        coreClaim:'定位、改造、验证构成闭环', layoutRationale:'三栏并列呈现方法',
        artwork:'三阶段图标', steps:3,
      },
    ],
  };
}

async function createStore(adapter = createMemoryCreationDraftAdapter()) {
  return CreationDraftStore.create({
    adapter,
    draftId:'draft-1',
    projectRoot:'/tmp/deck-project',
    provider:'codex',
    now:() => '2026-08-11T00:00:00.000Z',
  });
}

test('Draft 从 brief 开始，所有命令使用同一 revision', async () => {
  const store = await createStore();
  assert.equal(store.snapshot().phase, 'brief');
  assert.equal(store.snapshot().revision, 0);

  const updated = await store.dispatch({
    type:'update-brief', expectedRevision:0, patch:validBrief(),
  });
  assert.equal(updated.snapshot.revision, 1);
  await assert.rejects(
    store.dispatch({ type:'confirm-brief', expectedRevision:0 }),
    error => error.code === 'REVISION_CONFLICT' && error.statusCode === 409,
  );
  const confirmed = await store.dispatch({ type:'confirm-brief', expectedRevision:1 });
  assert.equal(confirmed.snapshot.phase, 'outline');
  assert.equal(confirmed.snapshot.briefConfirmedRevision, 2);
});

test('确认闸门按 brief、outline、page plan 逐级开放', async () => {
  const store = await createStore();
  await assert.rejects(
    store.dispatch({ type:'confirm-outline', expectedRevision:0 }),
    error => error.code === 'CREATION_GATE_UNMET',
  );
  await store.dispatch({ type:'update-brief', expectedRevision:0, patch:validBrief() });
  await store.dispatch({ type:'confirm-brief', expectedRevision:1 });
  await store.dispatch({ type:'propose-outline', expectedRevision:2, outline:validOutline() });
  await store.dispatch({ type:'confirm-outline', expectedRevision:3 });
  await store.dispatch({ type:'propose-page-plan', expectedRevision:4, pagePlan:validPagePlan() });
  const planned = await store.dispatch({ type:'confirm-page-plan', expectedRevision:5 });
  assert.equal(planned.snapshot.phase, 'page-plan');
  assert.equal(planned.snapshot.outlineStatus, 'confirmed');
  assert.equal(planned.snapshot.pagePlanStatus, 'confirmed');

  await assert.rejects(
    store.dispatch({ type:'start-generation', expectedRevision:6 }),
    error => error.code === 'CREATION_GATE_UNMET',
  );
  await store.dispatch({
    type:'set-output', expectedRevision:6,
    output:{
      fileName:'ascend-inference.html', templateId:'tech-share', includePlan:true,
      trialPptx:false, autoOpenEditor:true,
    },
  });
  const generating = await store.dispatch({ type:'start-generation', expectedRevision:7 });
  assert.equal(generating.snapshot.phase, 'generating');
  assert.equal(generating.snapshot.generation.status, 'preparing');
});

test('修改已确认 brief 会使大纲和页面规划失效', async () => {
  const store = await createStore();
  await store.dispatch({ type:'update-brief', expectedRevision:0, patch:validBrief() });
  await store.dispatch({ type:'confirm-brief', expectedRevision:1 });
  await store.dispatch({ type:'propose-outline', expectedRevision:2, outline:validOutline() });
  await store.dispatch({ type:'confirm-outline', expectedRevision:3 });
  await store.dispatch({ type:'propose-page-plan', expectedRevision:4, pagePlan:validPagePlan() });
  await store.dispatch({ type:'confirm-page-plan', expectedRevision:5 });

  const changed = await store.dispatch({
    type:'update-brief', expectedRevision:6, patch:{ audience:'业务与技术负责人' },
  });
  assert.equal(changed.snapshot.phase, 'brief');
  assert.equal(changed.snapshot.briefConfirmedRevision, null);
  assert.equal(changed.snapshot.outlineStatus, 'stale');
  assert.equal(changed.snapshot.pagePlanStatus, 'stale');
  assert.match(changed.snapshot.invalidationReason, /需求已变化/);
});

test('修改已确认大纲只使页面规划失效，生成中拒绝结构变更', async () => {
  const store = await createStore();
  await store.dispatch({ type:'update-brief', expectedRevision:0, patch:validBrief() });
  await store.dispatch({ type:'confirm-brief', expectedRevision:1 });
  await store.dispatch({ type:'propose-outline', expectedRevision:2, outline:validOutline() });
  await store.dispatch({ type:'confirm-outline', expectedRevision:3 });
  await store.dispatch({ type:'propose-page-plan', expectedRevision:4, pagePlan:validPagePlan() });
  await store.dispatch({ type:'confirm-page-plan', expectedRevision:5 });

  const nextOutline = validOutline();
  nextOutline.sections[1].title = '优化闭环';
  const changed = await store.dispatch({
    type:'propose-outline', expectedRevision:6, outline:nextOutline,
  });
  assert.equal(changed.snapshot.phase, 'outline');
  assert.equal(changed.snapshot.outlineStatus, 'proposed');
  assert.equal(changed.snapshot.pagePlanStatus, 'stale');

  await store.dispatch({ type:'confirm-outline', expectedRevision:7 });
  await store.dispatch({ type:'propose-page-plan', expectedRevision:8, pagePlan:validPagePlan() });
  await store.dispatch({ type:'confirm-page-plan', expectedRevision:9 });
  await store.dispatch({
    type:'set-output', expectedRevision:10,
    output:{ fileName:'deck.html', templateId:'tech-share', includePlan:true, trialPptx:false, autoOpenEditor:true },
  });
  await store.dispatch({ type:'start-generation', expectedRevision:11 });
  await assert.rejects(
    store.dispatch({ type:'update-brief', expectedRevision:12, patch:{ title:'新标题' } }),
    error => error.code === 'GENERATION_ACTIVE',
  );
});

test('持久化 Adapter 可恢复完整确认状态，事件 revision 与快照一致', async () => {
  const adapter = createMemoryCreationDraftAdapter();
  const store = await createStore(adapter);
  const events = [];
  store.subscribe(event => events.push(event));
  await store.dispatch({ type:'update-brief', expectedRevision:0, patch:validBrief() });
  await store.dispatch({ type:'confirm-brief', expectedRevision:1 });
  const restored = await CreationDraftStore.open({ adapter, now:() => '2026-08-11T00:00:00.000Z' });
  assert.deepEqual(restored.snapshot(), store.snapshot());
  assert.equal(events.length, 2);
  assert.equal(events.at(-1).revision, store.snapshot().revision);
  assert.equal(events.at(-1).snapshot.revision, store.snapshot().revision);
});

// 场景必须通过需求确认闸门，不能只在模板目录中显示。
test('任职材料与项目评审场景能够确认需求并进入大纲', async () => {
  for (const [scene, templateId] of [['任职材料', 'qualification'], ['项目评审', 'project-review']]) {
    const store = await createStore();
    await store.dispatch({ type:'update-brief', expectedRevision:0, patch:{ ...validBrief(), scene, recommendedTemplateId:templateId } });
    const confirmed = await store.dispatch({ type:'confirm-brief', expectedRevision:1 });
    assert.equal(confirmed.snapshot.phase, 'outline');
    assert.equal(confirmed.snapshot.brief.scene, scene);
    assert.equal(confirmed.snapshot.brief.recommendedTemplateId, templateId);
  }
});
