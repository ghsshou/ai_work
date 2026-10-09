import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadChromium } from '../../verify/load-playwright.mjs';
import { startAppServer } from '../app-server.mjs';


function environmentSnapshot() {
  const checks = [
    { key:'node', label:'Node.js', profiles:['editor-core', 'verify', 'pptx-export'], present:true, optional:false },
    { key:'agent-cli', label:'Agent CLI', profiles:['dev-shell'], present:true, optional:false },
    { key:'pymupdf', label:'PyMuPDF', profiles:['materials'], present:false, optional:false },
  ];
  return {
    schemaVersion:1,
    ready:false,
    checks,
    profiles:{
      'editor-core':{ id:'editor-core', label:'Editor Core', ready:true, state:'ready', missing:[] },
      'dev-shell':{ id:'dev-shell', label:'独立 Dev Shell', ready:true, state:'ready', missing:[] },
      verify:{ id:'verify', label:'质量验证', ready:true, state:'ready', missing:[] },
      'pptx-export':{ id:'pptx-export', label:'PPTX 导出', ready:true, state:'ready', missing:[] },
      'pptx-read':{ id:'pptx-read', label:'PPTX 内容读取', ready:true, state:'ready', missing:[] },
      materials:{
        id:'materials', label:'PDF 材料解析', ready:false,
        state:'repairable', missing:['pymupdf'],
      },
    },
  };
}

test('桌面诊断说明 PPT 插件归插件商店管理，缺失环境通过重新安装插件恢复', async t => {
  const app = await startAppServer({
    token:'support-plugin-copy-secret',
    inspectInstallation:async () => ({ delivery:'desktop', registrations:[{host:'dsh',state:'ready'}] }),
    inspectEnvironment:async () => ({ ...environmentSnapshot(), delivery:'desktop' }),
  });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  await page.goto(app.appUrl);
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  await page.getByRole('button', {name:'安装与诊断',exact:true}).click();
  await page.getByText('已安装 PPT 插件工作流', {exact:true}).waitFor();
  await page.getByText('由 AICO-Harness 插件商店管理', {exact:true}).waitFor();
  const pptx = page.locator('.diagnostic-row', {hasText:'PPTX 内容读取'});
  assert.equal(await pptx.getAttribute('data-state'), 'ready');
  assert.equal(await pptx.getByRole('button').count(), 0);
  const materials = page.locator('.diagnostic-row', {hasText:'PDF 材料解析'});
  await materials.getByRole('button', {name:'查看安装方法'}).click();
  await page.getByText('运行环境随 AICO-PPT 插件提供，请在设置的插件页重新安装 AICO-PPT 插件。', {exact:true}).waitFor();
});


test('开始使用、帮助、诊断与示例副本形成完整首页路径', async t => {
  const sampleParent = await mkdtemp(join(tmpdir(), 'aico-ppt-onboarding-e2e-'));
  t.after(() => rm(sampleParent, { recursive:true, force:true }));
  const installation = {
    schemaVersion:1,
    state:'ready',
    ready:true,
    registrations:[{
      host:'codex', state:'ready', managed:true,
      targetPath:'/test/.agents/skills/aico-ppt',
    }],
  };
  const app = await startAppServer({
    token:'support-center-secret',
    pickAgentProjectDirectory:async () => sampleParent,
    inspectInstallation:async () => installation,
    inspectEnvironment:async () => environmentSnapshot(),
  });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1440, height:900 } });

  await page.goto(app.appUrl);
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  const guidedTourTrigger = page.getByRole('button', { name:'新手引导', exact:true });
  assert.equal(await guidedTourTrigger.getAttribute('title'), '新手引导');
  assert.equal(await guidedTourTrigger.locator('.topbar-control-icon').count(), 1);
  assert.equal(await guidedTourTrigger.locator('circle').count(), 1);
  assert.deepEqual(await guidedTourTrigger.evaluate(node => {
    const style = getComputedStyle(node);
    return { width:style.width, height:style.height, borderRadius:style.borderRadius };
  }), { width:'34px', height:'34px', borderRadius:'50%' });
  await guidedTourTrigger.click();
  await page.getByRole('heading', { name:'从零创建一份 Deck' }).waitFor();
  assert.equal(await page.locator('[data-tour-dots] i').count(), 5);
  await page.waitForFunction(() => (
    document.querySelector('[data-tour-arrow-shape]')
      ?.getAttribute('transform')?.startsWith('translate(')
  ));
  assert.match(
    await page.locator('[data-tour-arrow-shape]').getAttribute('transform'),
    /^translate\(/,
  );
  const spotlight = await page.locator('[data-tour-spotlight]').boundingBox();
  assert.ok(spotlight.width > 100 && spotlight.height > 100);
  await page.getByRole('button', { name:'下一步' }).click();
  await page.getByRole('heading', { name:'继续修改已有 Deck' }).waitFor();
  await page.getByRole('button', { name:'跳过引导' }).click();

  await page.getByRole('button', { name:'帮助', exact:true }).click();
  await page.getByRole('button', { name:/3 分钟开始使用/ }).waitFor();
  await page.getByRole('button', { name:/3 分钟开始使用/ }).click();
  await page.locator('[data-help-article] h1').filter({ hasText:'3 分钟开始使用' }).waitFor();

  await page.locator('[data-support-tab="diagnostics"]').click();
  await page.getByText('未就绪：PyMuPDF').waitFor();
  assert.equal(
    await page.locator('.diagnostic-row', { hasText:'Editor Core' }).getAttribute('data-state'),
    'ready',
  );

  await page.locator('.support-close').click();
  await guidedTourTrigger.click();
  for (let index = 0; index < 4; index += 1) {
    await page.getByRole('button', { name:'下一步' }).click();
  }
  await page.getByRole('heading', { name:'内容始终留在本机' }).waitFor();
  await page.getByRole('button', { name:'创建示例副本' }).click();
  await page.getByRole('heading', { name:'添加 Deck HTML' }).waitFor();
  assert.equal(await page.locator('.support-navigation').isHidden(), true,
    '进入修改 Deck 流程后也只保留初始页的使用与支持入口');
  const deckName = await page.locator('[data-deck-name]').innerText();
  assert.equal(deckName, 'AICO-PPT 示例.html');
  const projectRoot = await page.locator('[data-project-root]').innerText();
  await access(join(projectRoot, deckName));
});


test('修复操作立即显示进度，复检后明确区分已修复和手动安装项', async t => {
  let repair;
  let repaired = false;
  const repairStarted = new Promise(resolve => { repair = resolve; });
  let releaseRepair;
  const repairGate = new Promise(resolve => { releaseRepair = resolve; });
  t.after(() => releaseRepair());
  const snapshot = () => ({
    schemaVersion:1,
    ready:repaired,
    checks:[
      {
        key:'python-pptx', label:'python-pptx', profiles:['pptx-export'],
        present:repaired, optional:false,
        state:repaired ? 'ready' : 'repairable',
        detail:repaired ? 'import pptx' : '未安装或当前 Python 不可用',
        remediation:repaired ? null : { kind:'automatic', command:['python3', '-m', 'pip', 'install', 'python-pptx'] },
      },
      {
        key:'chrome', label:'Google Chrome', profiles:['verify'],
        present:false, optional:false, state:'manual-action-required', detail:'未找到 Google Chrome',
        remediation:{ kind:'manual', command:null, hint:'安装 Google Chrome' },
      },
    ],
    profiles:{
      'editor-core':{ id:'editor-core', label:'Editor Core', ready:true, state:'ready', missing:[] },
      'dev-shell':{ id:'dev-shell', label:'独立 Dev Shell', ready:true, state:'ready', missing:[] },
      verify:{ id:'verify', label:'质量验证', ready:false, state:'manual-action-required', missing:['chrome'] },
      'pptx-export':{
        id:'pptx-export', label:'PPTX 导出', ready:repaired,
        state:repaired ? 'ready' : 'repairable', missing:repaired ? [] : ['python-pptx'],
      },
      'pptx-read':{ id:'pptx-read', label:'PPTX 内容读取', ready:true, state:'ready', missing:[] },
      materials:{ id:'materials', label:'PDF 材料解析', ready:true, state:'ready', missing:[] },
    },
  });
  const app = await startAppServer({
    token:'support-repair-feedback-secret',
    inspectInstallation:async () => ({
      schemaVersion:1, ready:true, state:'ready',
      registrations:[{ host:'codex', state:'ready', targetPath:'/test/aico-ppt' }],
    }),
    inspectEnvironment:async ({ repair:shouldRepair } = {}) => {
      if (shouldRepair) {
        repair();
        await repairGate;
        repaired = true;
      }
      return snapshot();
    },
  });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1440, height:900 } });
  page.setDefaultTimeout(2_000);

  await page.goto(app.appUrl);
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  await page.getByRole('button', { name:'安装与诊断', exact:true }).click();
  const exportRow = page.locator('.diagnostic-row', { hasText:'PPTX 导出' });
  await exportRow.getByRole('button', { name:'修复并复检' }).click();
  await repairStarted;
  await exportRow.getByRole('button', { name:'正在修复…' }).waitFor();
  releaseRepair();
  await page.getByText('PPTX 导出已修复并通过复检。').waitFor();
  assert.equal(await exportRow.getAttribute('data-state'), 'ready');

  const verifyRow = page.locator('.diagnostic-row', { hasText:'质量验证' });
  await verifyRow.getByRole('button', { name:'查看安装方法' }).click();
  await page.getByText(/Google Chrome：安装 Google Chrome/).waitFor();
});


test('已有同源 Skill 链接必须由用户明确确认后才接管', async t => {
  let adopted = false;
  let repairOptions = null;
  const installationSnapshot = () => ({
    schemaVersion:1,
    ready:adopted,
    state:adopted ? 'ready' : 'manual-action-required',
    registrations:[{
      host:'codex',
      state:adopted ? 'ready' : 'adoption-required',
      managed:adopted,
      targetPath:'/test/.agents/skills/aico-ppt',
    }],
  });
  const app = await startAppServer({
    token:'support-adopt-install-secret',
    inspectInstallation:async options => {
      if (options?.repair) {
        repairOptions = options;
        adopted = true;
      }
      return installationSnapshot();
    },
    inspectEnvironment:async () => environmentSnapshot(),
  });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1440, height:900 } });
  let confirmationText = '';
  page.once('dialog', async dialog => {
    confirmationText = dialog.message();
    await dialog.accept();
  });

  await page.goto(app.appUrl);
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  await page.getByRole('button', { name:'安装与诊断', exact:true }).click();
  const row = page.locator('.diagnostic-row', { hasText:'AICO-PPT Skill' });
  await row.getByRole('button', { name:'接管此安装' }).click();

  await page.getByText('AICO-PPT Skill已修复并通过复检。').waitFor();
  assert.match(confirmationText, /由安装器接管/);
  assert.equal(repairOptions?.adoptExisting, true);
  assert.equal(await row.getAttribute('data-state'), 'ready');
});
