import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CreationDraftStore, createMemoryCreationDraftAdapter } from '../creation-draft-store.mjs';
import {
  buildCreationInitializationPrompt,
  buildCreationResumePrompt,
  buildGenerationPrompt,
  DeckCreationWorkspace,
} from '../deck-creation-workspace.mjs';

async function preparedStore() {
  const store = await CreationDraftStore.create({
    adapter:createMemoryCreationDraftAdapter(), draftId:'draft-1',
    projectRoot:'/tmp/project', provider:'codex',
  });
  await store.dispatch({
    type:'update-brief', expectedRevision:0,
    patch:{ title:'新 Deck', audience:'研发', durationMinutes:20, objective:'对齐方案' },
  });
  await store.dispatch({ type:'confirm-brief', expectedRevision:1 });
  await store.dispatch({
    type:'propose-outline', expectedRevision:2,
    outline:{ sections:[{ chapterId:'one', title:'第一章', objective:'讲清楚', pageBudget:2, timeBudgetMinutes:10 }] },
  });
  await store.dispatch({ type:'confirm-outline', expectedRevision:3 });
  await store.dispatch({
    type:'propose-page-plan', expectedRevision:4,
    pagePlan:{ pages:[{
      pageId:'p1', chapterId:'one', pageTypeId:'cover', label:'封面',
      coreClaim:'核心观点', layoutRationale:'封面', artwork:'无', steps:0,
    }] },
  });
  await store.dispatch({ type:'confirm-page-plan', expectedRevision:5 });
  await store.dispatch({
    type:'set-output', expectedRevision:6,
    output:{ fileName:'new.html', templateId:'tech-share', includePlan:true, trialPptx:false, autoOpenEditor:true },
  });
  return store;
}

test('Workspace 编排 prepare、Agent 提示、验证与发布', async () => {
  const store = await preparedStore();
  const calls = [];
  const factory = {
    prepare:async () => {
      calls.push('prepare');
      return {
        stagingDeck:'staging/run/new.html',
        stagingPlan:'staging/run/new.plan.md',
        stagingTocContract:'staging/run/new.toc-contract.json',
        stagingPagePlanContract:'staging/run/new.page-plan-contract.json',
      };
    },
    verify:async () => {
      calls.push('verify');
      return { diagnostics:[{ check:'bundle', ok:true }], stagingFingerprint:'abc' };
    },
    publish:async () => {
      calls.push('publish');
      return { publishedDeck:'/tmp/project/new.html', publishedPlan:'/tmp/project/new.plan.md', fingerprint:'def' };
    },
  };
  const prompts = [];
  const terminal = { snapshot:() => ({ state:'running' }), submitPrompt:value => prompts.push(value) };
  const workspace = new DeckCreationWorkspace({ store, factory, terminal });
  const started = await workspace.dispatch({ type:'start-generation', expectedRevision:7 });
  assert.equal(started.snapshot.generation.status, 'editing');
  assert.match(prompts[0], /staging\/run\/new\.html/);
  assert.match(prompts[0], /new\.toc-contract\.json/);
  assert.match(prompts[0], /new\.page-plan-contract\.json/);
  assert.match(prompts[0], /第一章｜动画必须表达：讲清楚/);
  const ready = await workspace.dispatch({
    type:'generation-ready', expectedRevision:started.snapshot.revision,
    diagnostics:{ summary:'初版已完成' },
  });
  assert.equal(ready.snapshot.phase, 'ready');
  assert.equal(ready.snapshot.generation.publishedDeck, '/tmp/project/new.html');
  assert.deepEqual(calls, ['prepare', 'verify', 'publish']);
});

test('新建与生成 Prompt 共享 Skill、模板固定页和质量契约', () => {
  const initialization = buildCreationInitializationPrompt({
    projectRoot:'/tmp/project', capabilityPath:'/tmp/capability.json',
  });
  assert.match(initialization, /^\/aico-ppt\n\n/u);
  assert.match(initialization, /SKILL\.md/);
  assert.match(initialization, /creation templates/);
  assert.match(initialization, /封面 cover 排第一、目录 toc 排第二、感谢页 thanks 排最后/);
  assert.match(initialization, /正文默认不得小于 21px/);
  assert.match(initialization, /同一组、同一层级、同一语义角色的普通信息卡必须同构/);
  assert.match(initialization, /不得为了构图制造默认高亮/);
  const resume = buildCreationResumePrompt({
    snapshot:{ draftId:'draft-1', revision:3, phase:'outline', brief:{ title:'新 Deck' } },
    capabilityPath:'/tmp/capability.json',
  });
  assert.match(resume, /^\/aico-ppt\n\n/u);
  for (const prompt of [initialization, resume]) {
    assert.match(prompt, /creation status --capability-file '\/tmp\/capability.json'/);
    assert.match(prompt, /每次 creation CLI 命令均须加 --capability-file/);
  }
  const generation = buildGenerationPrompt({
    outline:{ sections:[{ chapterId:'one', title:'第一章', objective:'讲清楚' }] },
    pagePlan:{ pages:[{ pageTypeId:'cover', label:'封面' }] },
    generation:{
      stagingDeck:'staging/deck.html', stagingPlan:'staging/deck.plan.md',
      stagingTocContract:'staging/deck.toc-contract.json',
      stagingPagePlanContract:'staging/deck.page-plan-contract.json',
    },
  }, { capabilityPath:'/tmp/capability.json', template:{
    templateId:'tech-share', name:'技术分享', pageCount:37,
    pageTypes:[{ pageTypeId:'cover', sourcePage:1, sourceLabel:'封面' }],
  } });
  assert.match(generation, /当前外壳原生第 1 页「封面」/);
  assert.match(generation, /deck_factory\.py import-page/);
  assert.match(generation, /连续三页同一视觉家族/);
  assert.match(generation, /huawei-style\.md/);
  assert.match(generation, /creation generation-ready --capability-file '\/tmp\/capability.json'/);
  assert.match(generation, /页数、顺序、页型或身份任一不一致都会被发布闸门拒绝/);
  assert.match(generation, /目录页执行自适应契约/);
  assert.match(generation, /不得直接复用模板 tocBuilders/);
  assert.match(generation, /封面与感谢页带有结构锁/);
  assert.match(generation, /标题、正文和标签的字体族、字号、字重、行距一致/);
});

test('Workspace 在生成前执行模板页面规划闸门', async () => {
  const store = await preparedStore();
  let prepared = false;
  const workspace = new DeckCreationWorkspace({
    store,
    catalog:{
      resolve:() => ({ templateId:'tech-share', name:'技术分享', pageCount:37, pageTypes:[] }),
      validatePagePlan:() => {
        throw Object.assign(new Error('缺少感谢页'), { code:'REQUIRED_TEMPLATE_PAGE_MISSING' });
      },
    },
    factory:{
      prepare:async () => { prepared = true; },
      verify:async () => ({}),
      publish:async () => ({}),
    },
  });
  await assert.rejects(
    workspace.dispatch({ type:'start-generation', expectedRevision:7 }),
    error => error.code === 'REQUIRED_TEMPLATE_PAGE_MISSING',
  );
  assert.equal(prepared, false);
});

test('合法 staging Deck 出现后切入 Managed Workspace，发布前固化同一工作副本', async () => {
  const store = await preparedStore();
  store.adapter.draftDir = '/tmp/project/.aico-ppt-editor/drafts/draft-1';
  const calls = [];
  const factory = {
    prepare:async () => ({
      stagingDeck:'staging/run/new.html',
      stagingPlan:'staging/run/new.plan.md',
      stagingTocContract:'staging/run/new.toc-contract.json',
    }),
    verify:async () => { calls.push('verify'); return { diagnostics:[] }; },
    publish:async () => {
      calls.push('publish');
      return { publishedDeck:'/tmp/project/new.html', publishedPlan:null, fingerprint:'def' };
    },
  };
  const prompts = [];
  let finalOpenOptions = null;
  const terminal = {
    cwd:'/tmp/project', snapshot:() => ({ state:'running' }), submitPrompt:value => prompts.push(value),
  };
  const workspace = new DeckCreationWorkspace({
    store, factory, terminal,
    openManagedDeck:async options => {
      calls.push(['open', options.sourceDeckPath, options.projectRoot]);
      const published = options.sourceDeckPath === '/tmp/project/new.html';
      if (published) finalOpenOptions = options;
      const editor = {
        url:published ? 'http://127.0.0.1:60124' : 'http://127.0.0.1:60123',
        token:published ? 'final-token' : 'managed-token',
      };
      let transferred = false;
      return {
        snapshot:() => ({
          sourceDeckPath:options.sourceDeckPath,
          workingDeckPath:published
            ? '/tmp/project/.aico-ppt-editor/final/working/deck.html'
            : '/tmp/project/.aico-ppt-editor/drafts/draft-1/staging/run/.aico-ppt-editor/session/working/deck.html',
          serviceUrl:editor.url, token:editor.token,
          editorUrl:`${editor.url}/editor/?embedded=creation`, revision:published ? 0 : 2,
        }),
        waitUntilReady:async () => calls.push('ready'),
        preparePublish:async () => calls.push('solidify'),
        transfer:() => { transferred = true; return editor; },
        close:async () => calls.push(transferred ? 'close-transferred' : 'close-managed'),
      };
    },
  });
  const started = await workspace.dispatch({ type:'start-generation', expectedRevision:7 });
  assert.equal(started.snapshot.previewDeck.managed, true);
  assert.equal(started.snapshot.previewDeck.editorUrl, 'http://127.0.0.1:60123/editor/?embedded=creation');
  assert.match(prompts[0], /Editor 托管工作副本/);
  assert.match(prompts[0], /managed-token/);
  assert.match(prompts[0], /不要让用户按 Cmd\/Ctrl\+R/);
  const published = await workspace.dispatch({
    type:'generation-ready', expectedRevision:started.snapshot.revision, diagnostics:{},
  });
  assert.equal(published.snapshot.phase, 'ready');
  const publishedView = workspace.snapshot();
  assert.equal(
    publishedView.previewDeck.path,
    '/tmp/project/.aico-ppt-editor/final/working/deck.html',
  );
  assert.equal(publishedView.previewDeck.managed, true);
  assert.match(publishedView.previewDeck.editorUrl, /60124/);
  assert.equal(finalOpenOptions.creationHandoff.draft.phase, 'ready');
  assert.equal(finalOpenOptions.creationHandoff.draft.generation.status, 'published');
  assert.equal(
    finalOpenOptions.creationHandoff.draftDir,
    '/tmp/project/.aico-ppt-editor/drafts/draft-1',
  );
  assert.deepEqual(calls.map(value => Array.isArray(value) ? value[0] : value), [
    'open', 'ready', 'solidify', 'verify', 'publish', 'close-managed', 'open',
  ]);
  const finalEditor = workspace.takePublishedEditor();
  assert.equal(finalEditor.url, 'http://127.0.0.1:60124');
  await workspace.close();
  assert.equal(calls.includes('close-transferred'), false);
});

test('验证失败保留 staging 并把 Draft 标记为 failed', async () => {
  const store = await preparedStore();
  const factory = {
    prepare:async () => ({
      stagingDeck:'staging/run/new.html',
      stagingPlan:'staging/run/new.plan.md',
      stagingTocContract:'staging/run/new.toc-contract.json',
    }),
    verify:async () => { throw Object.assign(new Error('页面溢出'), { code:'GENERATION_VERIFY_FAILED' }); },
    publish:async () => assert.fail('验证失败不得发布'),
  };
  const workspace = new DeckCreationWorkspace({ store, factory });
  const started = await workspace.dispatch({ type:'start-generation', expectedRevision:7 });
  await assert.rejects(
    workspace.dispatch({
      type:'generation-ready', expectedRevision:started.snapshot.revision, diagnostics:{},
    }),
    /页面溢出/,
  );
  const failed = workspace.snapshot();
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.generation.status, 'failed');
  assert.equal(failed.generation.stagingDeck, 'staging/run/new.html');
  assert.match(failed.generation.diagnostics[0].message, /页面溢出/);
});

test('Workspace 可按 projectRoot + draftId 重新打开同一份持久 Draft', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-workspace-resume-'));
  const catalog = {
    resolve:() => null,
    snapshot:() => ({ version:1, templates:[] }),
  };
  const created = await DeckCreationWorkspace.create({
    projectRoot,
    draftId:'resume-draft',
    provider:'claude-code',
    catalog,
  });
  await created.dispatch({
    type:'update-brief', expectedRevision:0,
    patch:{ title:'恢复测试', audience:'团队', durationMinutes:20, objective:'验证上下文' },
  });
  await created.close();

  const reopened = await DeckCreationWorkspace.open({
    projectRoot,
    draftId:'resume-draft',
    catalog,
  });
  t.after(async () => {
    await reopened.close();
    await rm(projectRoot, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  });
  assert.equal(reopened.snapshot().brief.title, '恢复测试');
  assert.equal(reopened.snapshot().provider, 'claude-code');
  assert.equal(reopened.snapshot().revision, 1);
  assert.match(reopened.capabilityPath, /resume-draft[\\/]agent-capability\.json$/);
});


test('就绪失败后在原 run 重新验证发布，不丢弃已有工作副本', async () => {
  const store = await preparedStore();
  store.adapter.draftDir = '/tmp/project/.aico-ppt-editor/drafts/draft-1';
  let online = false;
  let prepared = 0;
  const workspace = new DeckCreationWorkspace({
    store, terminal:{ snapshot:() => ({ state:'stopped' }) },
    factory:{
      prepare:async () => { prepared++; return { stagingDeck:'staging/run/new.html' }; },
      verify:async () => ({ diagnostics:[] }),
      publish:async () => ({ publishedDeck:'/tmp/project/new.html' }),
    },
    openManagedDeck:async options => ({
      snapshot:() => ({ sourceDeckPath:options.sourceDeckPath }),
      waitUntilReady:async () => { if (!online) throw Object.assign(new Error('等待编辑器页面就绪超时'), { code:'EDITOR_OFFLINE' }); },
      preparePublish:async () => { assert.equal(online, true); },
      close:async () => {},
    }),
  });
  await assert.rejects(workspace.dispatch({ type:'start-generation', expectedRevision:7 }), /就绪超时/);
  const failed = workspace.snapshot();
  assert.equal(failed.phase, 'failed');
  const runId = failed.generation.runId;
  online = true;
  const result = await workspace.dispatch({ type:'generation-ready', expectedRevision:failed.revision });
  assert.equal(result.snapshot.phase, 'ready');
  assert.equal(result.snapshot.generation.runId, runId);
  assert.equal(prepared, 1);
  await workspace.close();
});
