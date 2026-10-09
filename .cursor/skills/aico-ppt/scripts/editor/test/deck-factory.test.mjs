import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DeckFactory } from '../deck-factory.mjs';
import { TemplateCatalog } from '../template-catalog.mjs';

function snapshot(runId = 'run-1') {
  return {
    draftId:'draft-1', phase:'generating', pagePlanStatus:'confirmed',
    brief:{ title:'测试 Deck', scene:'技术分享', audience:'研发', durationMinutes:20, objective:'验证流程' },
    outline:{ sections:[{ chapterId:'one', title:'第一章', objective:'讲清背景', pageBudget:2, timeBudgetMinutes:5 }] },
    pagePlan:{ pages:[{
      pageId:'p1', chapterId:'one', pageTypeId:'cover', label:'封面', coreClaim:'测试',
      layoutRationale:'封面', artwork:'无', steps:0,
    }] },
    output:{ fileName:'test-deck.html', templateId:'test', includePlan:true, trialPptx:false, autoOpenEditor:true },
    generation:{
      runId, status:'preparing', stagingDeck:null, stagingPlan:null,
      stagingTocContract:null, stagingPagePlanContract:null,
    },
  };
}

test('模板目录只公开五套白名单模板，路径仅在服务端解析', async () => {
  const catalog = await TemplateCatalog.open();
  const publicCatalog = catalog.snapshot();
  assert.deepEqual(publicCatalog.templates.map(item => item.templateId), [
    'training', 'tech-share', 'work-report', 'qualification', 'project-review',
  ]);
  assert.deepEqual(publicCatalog.templates.map(item => item.pageTypes.length), [34, 37, 46, 22, 54]);
  for (const template of publicCatalog.templates) {
    assert.deepEqual(template.requiredPages, ['cover', 'toc', 'thanks']);
    assert.equal(template.pageTypes.at(0).pageTypeId, 'cover');
    assert.equal(template.pageTypes.at(1).pageTypeId, 'toc');
    assert.equal(template.pageTypes.at(-1).pageTypeId, 'thanks');
    assert.equal(template.pageTypes.find(item => item.pageTypeId === 'toc').adaptiveToc, true);
    assert.notEqual(template.pageTypes.find(item => item.pageTypeId === 'toc').preserveLayout, true);
    assert.equal(template.pageTypes.some(item => item.pageTypeId.startsWith('source-page-')), false);
    assert.equal(template.pageTypes.some(item => item.visualFamily === 'custom'), false);
    assert.ok(template.pageTypes.every(item => item.defaultSteps >= 1));
    assert.ok(template.availablePageTypes.length >= template.pageTypes.length);
  }
  const borrowedCase = publicCatalog.templates
    .find(item => item.templateId === 'tech-share')
    .availablePageTypes.find(item => item.pageTypeId === 'case-study');
  assert.equal(borrowedCase.borrowed, true);
  assert.equal(borrowedCase.sourceTemplateId, 'work-report');
  assert.equal(borrowedCase.visualFamily, 'evidence');
  for (const pageTypeId of [
    'code-curve-metrics',
    'strategy-capability-portfolio',
    'system-map-output-rail',
    'layered-platform-ops-rail',
    'method-pipeline-guardrails',
    'stage-deliverable-map',
  ]) {
    const pages = publicCatalog.templates.filter(template => ['training', 'tech-share', 'work-report'].includes(template.templateId)).map(template => (
      template.availablePageTypes.find(page => page.pageTypeId === pageTypeId)
    ));
    assert.ok(pages.every(Boolean), `${pageTypeId} 应对三套场景外壳可用`);
    assert.ok(pages.every(page => page.density === 'dense'));
  }
  assert.equal(JSON.stringify(publicCatalog).includes('sourcePath'), false);
  assert.throws(() => catalog.resolve('../../etc/passwd'), /不允许使用模板/);
});

test('模板目录拒绝漏掉固定首尾页或使用虚构页型的页面规划', async () => {
  const catalog = await TemplateCatalog.open();
  assert.throws(
    () => catalog.validatePagePlan('tech-share', { pages:[
      { pageTypeId:'cover', label:'封面' },
      { pageTypeId:'toc', label:'目录' },
      { pageTypeId:'not-in-template', label:'虚构页型' },
      { pageTypeId:'thanks', label:'感谢页' },
    ] }),
    error => error.code === 'PAGE_TYPE_NOT_ALLOWED',
  );
  assert.throws(
    () => catalog.validatePagePlan('tech-share', { pages:[
      { pageTypeId:'cover', label:'封面' },
      { pageTypeId:'toc', label:'目录' },
      { pageTypeId:'architecture', label:'架构', layoutRationale:'解释系统分层', artwork:'自绘架构图' },
    ] }),
    error => error.code === 'REQUIRED_TEMPLATE_PAGE_MISSING',
  );
  assert.doesNotThrow(() => catalog.validatePagePlan('tech-share', { pages:[
    { pageTypeId:'cover', label:'封面' },
    { pageTypeId:'toc', label:'目录' },
    { pageTypeId:'architecture', label:'架构', layoutRationale:'解释系统分层', artwork:'自绘架构图' },
    { pageTypeId:'thanks', label:'感谢页' },
  ] }));
});

test('共享页型可借入场景外壳，并拒绝缺理由或连续雷同的页面规划', async () => {
  const catalog = await TemplateCatalog.open();
  assert.doesNotThrow(() => catalog.validatePagePlan('tech-share', { pages:[
    { pageTypeId:'cover', label:'封面' },
    { pageTypeId:'toc', label:'目录' },
    {
      pageTypeId:'case-study', label:'客户案例', chapterId:'one',
      layoutRationale:'用完整案例串起背景、过程与结果', artwork:'客户截图与数据',
    },
    { pageTypeId:'thanks', label:'感谢页' },
  ] }));
  assert.throws(
    () => catalog.validatePagePlan('tech-share', { pages:[
      { pageTypeId:'cover', label:'封面' },
      { pageTypeId:'toc', label:'目录' },
      { pageTypeId:'card-grid', label:'第一页', chapterId:'one', artwork:'无' },
      { pageTypeId:'thanks', label:'感谢页' },
    ] }),
    error => error.code === 'PAGE_LAYOUT_RATIONALE_REQUIRED',
  );
  assert.throws(
    () => catalog.validatePagePlan('tech-share', { pages:[
      { pageTypeId:'cover', label:'封面' },
      { pageTypeId:'toc', label:'目录' },
      ...['一', '二', '三'].map(label => ({
        pageTypeId:'card-grid', label:`卡片${label}`, chapterId:'one',
        layoutRationale:'并列概念需要网格承载', artwork:'无',
      })),
      { pageTypeId:'thanks', label:'感谢页' },
    ] }),
    error => error.code === 'PAGE_VISUAL_FAMILY_REPETITION',
  );
});

test('DeckFactory 准备 staging、验证并以不覆盖方式发布', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-factory-'));
  t.after(() => rm(projectRoot, { recursive:true, force:true }));
  const draftDir = join(projectRoot, '.aico-ppt-editor', 'drafts', 'draft-1');
  await mkdir(join(draftDir, 'staging'), { recursive:true });
  const templatePath = join(projectRoot, 'template.html');
  await writeFile(templatePath, '<html>template</html>');
  const catalog = {
    catalogPath:'/tmp/template-catalog.json',
    resolve:id => {
      assert.equal(id, 'test');
      return { templateId:'test', name:'测试模板', sourcePath:templatePath };
    },
  };
  const commands = [];
  const factory = await DeckFactory.create({
    projectRoot, draftDir, catalog,
    commandRunner:async (command, args, options) => {
      commands.push([command, args, options]);
      return { code:0, stdout:'ok', stderr:'' };
    },
  });
  const preparing = snapshot();
  const prepared = await factory.prepare(preparing);
  assert.match(prepared.stagingDeck, /^staging\/run-run-1\/test-deck\.html$/);
  assert.match(prepared.stagingTocContract, /^staging\/run-run-1\/test-deck\.toc-contract\.json$/);
  assert.match(
    prepared.stagingPagePlanContract,
    /^staging\/run-run-1\/test-deck\.page-plan-contract\.json$/,
  );
  const contract = JSON.parse(await readFile(join(draftDir, prepared.stagingTocContract), 'utf8'));
  assert.deepEqual(contract, {
    version:1,
    chapters:[{ chapterId:'one', title:'第一章', objective:'讲清背景' }],
  });
  const pagePlanContract = JSON.parse(await readFile(
    join(draftDir, prepared.stagingPagePlanContract),
    'utf8',
  ));
  assert.deepEqual(pagePlanContract, {
    version:1,
    templateId:'test',
    pages:[{
      pageId:'p1', chapterId:'one', pageTypeId:'cover', label:'封面',
    }],
  });
  const tamperedVerifying = {
    ...preparing,
    generation:{ ...preparing.generation, ...prepared, status:'verifying' },
  };
  await writeFile(
    join(draftDir, prepared.stagingPagePlanContract),
    `${JSON.stringify({ ...pagePlanContract, pages:[] }, null, 2)}\n`,
  );
  await assert.rejects(
    factory.verify(tamperedVerifying),
    error => error.code === 'STAGING_UNSAFE' && /契约已被改动/.test(error.message),
  );
  await writeFile(
    join(draftDir, prepared.stagingPagePlanContract),
    `${JSON.stringify(pagePlanContract, null, 2)}\n`,
  );
  assert.equal(await readFile(templatePath, 'utf8'), '<html>template</html>');
  await unlink(join(draftDir, prepared.stagingTocContract));
  const { stagingTocContract:ignoredLegacyField, ...legacyPrepared } = prepared;
  assert.ok(ignoredLegacyField);
  const verifying = {
    ...preparing,
    generation:{ ...preparing.generation, ...legacyPrepared, status:'verifying' },
  };
  const verified = await factory.verify(verifying);
  assert.deepEqual(verified.diagnostics.map(item => item.check), [
    'template-contract', 'toc-animation', 'overflow',
  ]);
  assert.equal(commands.length, 4);
  for (const index of [0, 1, 2]) {
    assert.equal(commands[index][2].env.PYTHONIOENCODING, 'utf-8');
    assert.equal(commands[index][2].env.PYTHONUTF8, '1');
  }
  assert.equal(commands[3][2].env, undefined, 'Node overflow 校验不需要 Python 编码环境');
  assert.equal(commands[1][1].at(-2), '--page-plan-contract');
  assert.ok(commands[1][1].at(-1).endsWith(prepared.stagingPagePlanContract));
  assert.deepEqual(
    JSON.parse(await readFile(join(draftDir, prepared.stagingTocContract), 'utf8')),
    contract,
  );
  const published = await factory.publish(verifying);
  assert.equal(await readFile(published.publishedDeck, 'utf8'), '<html>template</html>');
  assert.match(await readFile(published.publishedPlan, 'utf8'), /# 测试 Deck/);
  await assert.rejects(factory.publish(verifying), error => error.code === 'OUTPUT_EXISTS');
});
