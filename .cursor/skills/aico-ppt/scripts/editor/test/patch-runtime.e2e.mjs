import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadChromium } from '../../verify/load-playwright.mjs';
import { PatchJournal } from '../patch-journal.mjs';

const RUNTIME_CONTRACT = {
  brand:'com.huawei.deck.visual-editor.patch-runtime',
  schema:1,
  version:'1.0.0',
  api:'pageKey,makeLocator,resolve,applyAction,applyAll,applyTransaction,beginTransaction,suspendTarget,pendingTransactionCount,activeActionCount,suspendedTargetCount',
  features:'textPath,textRangeStyle',
};

test('细粒度 setText 的目标值包含原文时 MutationObserver 重放仍保持幂等', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  await page.evaluate(() => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const heading = document.querySelector('h2');
    heading.innerHTML = '普通文字 <strong>加粗文字</strong>';
    const target = { ...runtime.makeLocator(heading), textPath:'0' };
    runtime.applyAction({
      id:'idempotent-text', target, kind:'setText',
      payload:{ text:'更新后的普通文字 ' },
    });
    // 触发 runtime 的 childList observer，模拟直接编辑恢复 DOM 与动作提交相邻时序。
    const marker = document.createElement('i');
    heading.append(marker);
    marker.remove();
  });
  await page.waitForTimeout(80);
  assert.equal(
    await page.locator('h2').first().evaluate(element => element.innerHTML),
    '更新后的普通文字 <strong>加粗文字</strong>',
  );
});

test('固化后的 active action 被收养为新基线，空同步不会恢复旧内容', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result = await page.evaluate(() => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const heading = document.querySelector('h2');
    const target = runtime.makeLocator(heading);
    runtime.applyAll([{
      id:'solidified-baseline-text', target, kind:'setText', payload:{ text:'固化基线' },
    }]);
    const adopted = runtime.adoptActiveAsBaseline();
    const activeAfterAdopt = runtime.activeActionCount();
    runtime.applyAll([]);
    const afterEmptySync = heading.textContent;
    runtime.applyAll([{
      id:'post-solidify-text', target, kind:'setText', payload:{ text:'本轮临时修改' },
    }]);
    runtime.applyAll([]);
    return {
      adopted, activeAfterAdopt, afterEmptySync, afterUndoNewRound:heading.textContent,
    };
  });
  assert.deepEqual(result, {
    adopted:1,
    activeAfterAdopt:0,
    afterEmptySync:'固化基线',
    afterUndoNewRound:'固化基线',
  });
});

test('会话恢复批量跳过被后续源码修改取代的缺失动作', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);

  const result = await page.evaluate(() => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const heading = document.querySelector('h2');
    const valid = {
      id:'valid-current-action', target:runtime.makeLocator(heading),
      kind:'setText', payload:{ text:'保留的修改' },
    };
    const missing = {
      id:'old-deleted-target',
      target:{
        ...valid.target,
        editorId:'element-ffffffffffffffffffffffffffffffff',
        path:'999',
      },
      kind:'setText', payload:{ text:'目标已经不存在' },
    };
    const repaired = runtime.applyAllDroppingMissing([valid, missing], {
      rebaseActionIds:[missing.id],
    });
    return {
      text:heading.textContent,
      applied:repaired.results.length,
      effectiveIds:repaired.effectiveActions.map(action => action.id),
      droppedActionIds:repaired.droppedActionIds,
    };
  });

  assert.deepEqual(result, {
    text:'保留的修改',
    applied:1,
    effectiveIds:['valid-current-action'],
    droppedActionIds:['old-deleted-target'],
  });
});

test('局部文字样式按字符范围重放、替换并恢复原始结构', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result = await page.evaluate(() => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const heading = document.querySelector('h2');
    const target = runtime.makeLocator(heading);
    const action = value => ({
      id:`range-${value}`, target, kind:'setStyle',
      payload:{ property:'color', value, textRange:{ start:1, end:3 } },
    });
    runtime.applyAll([action('red')]);
    const red = {
      html:heading.innerHTML,
      text:heading.querySelector('[data-deck-text-range-style]')?.textContent,
      color:getComputedStyle(heading.querySelector('[data-deck-text-range-style]')).color,
    };
    runtime.applyAll([action('blue')]);
    const blue = {
      count:heading.querySelectorAll('[data-deck-text-range-style]').length,
      text:heading.querySelector('[data-deck-text-range-style]')?.textContent,
      color:getComputedStyle(heading.querySelector('[data-deck-text-range-style]')).color,
    };
    const bold = {
      id:'range-bold', target, kind:'setStyle',
      payload:{ property:'font-weight', value:'400', textRange:{ start:1, end:3 } },
    };
    runtime.applyAll([bold, action('red')]);
    runtime.applyTransaction([{
      ...bold, id:'range-bold-update', payload:{ ...bold.payload, value:'700' },
    }]);
    const combinedRun = [...heading.querySelectorAll('[data-deck-text-range-style]')]
      .find(element => element.textContent === '一页' && element.style.color);
    const combined = {
      wrappers:heading.querySelectorAll('[data-deck-text-range-style]').length,
      color:getComputedStyle(combinedRun).color,
      weight:getComputedStyle(combinedRun).fontWeight,
    };
    runtime.applyAll([]);
    return { red, blue, combined, restored:heading.innerHTML };
  });
  assert.match(result.red.html, /data-deck-text-range-style/);
  assert.deepEqual(result.red.text, '一页');
  assert.equal(result.red.color, 'rgb(255, 0, 0)');
  assert.deepEqual(result.blue, { count:1, text:'一页', color:'rgb(0, 0, 255)' });
  assert.deepEqual(result.combined, { wrappers:2, color:'rgb(255, 0, 0)', weight:'700' });
  assert.equal(result.restored, '第一页标题');
});

test('局部格式键被替换或撤销时不让后续细粒度文字动作丢失目标', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const target = await page.evaluate(() => window.HuaweiDeckPatchRuntime.makeLocator(
    document.querySelector('h2'),
  ));
  const range = { start:1, end:3 };
  const action = (id, value) => ({
    id, taskId:null, target, kind:'setStyle',
    payload:{ property:'font-weight', value, textRange:range },
    before:value === '400' ? '700' : '400', after:value, appliedAt:id,
  });
  const journal = new PatchJournal();
  journal.appendGroup(null, [action('range-original', '700')]);
  const formatted = journal.appendGroup(null, [action('range-formatted', '400')]);
  await page.evaluate(actions => window.HuaweiDeckPatchRuntime.applyAll(actions), journal.compile());
  const textPath = await page.evaluate(() => {
    const heading = document.querySelector('h2');
    const text = heading.querySelector('[data-deck-text-range-style]')?.firstChild;
    if (!text) throw new Error('测试前提失败：局部格式包装未生成');
    const parts = [];
    for (let node=text; node && node!==heading; node=node.parentNode) {
      parts.push([...node.parentNode.childNodes].indexOf(node));
    }
    return parts.reverse().join('/');
  });
  journal.appendGroup(null, [{
    id:'granular-text', taskId:null, target:{ ...target, textPath }, kind:'setText',
    payload:{ text:'两页', sourceRange:range }, before:'一页', after:'两页', appliedAt:'granular-text',
  }]);
  await page.evaluate(actions => window.HuaweiDeckPatchRuntime.applyAll(actions), journal.compile());

  const changed = new PatchJournal(structuredClone(journal.state));
  changed.appendGroup(null, [action('range-restored', '700')]);
  const changedResult = await page.evaluate(actions => {
    try {
      window.HuaweiDeckPatchRuntime.applyAll(actions);
      return { error:null, text:document.querySelector('h2').textContent };
    }
    catch (error) { return error.code || error.message; }
  }, changed.compile());

  const undone = new PatchJournal(structuredClone(journal.state));
  // 后续文字替换已经使旧字符范围失效，严格时间线不会再为它制造空补偿；
  // 直接按当前有效历史重放，验证文字目标没有随旧格式包装一起丢失。
  assert.throws(
    () => undone.compensate(formatted.id),
    error => error.code === 'NOTHING_TO_COMPENSATE',
  );
  const undoneResult = await page.evaluate(actions => {
    try {
      window.HuaweiDeckPatchRuntime.applyAll(actions);
      return { error:null, text:document.querySelector('h2').textContent };
    }
    catch (error) { return error.code || error.message; }
  }, undone.compile());

  assert.deepEqual({ changedResult, undoneResult }, {
    changedResult:{ error:null, text:'第两页标题' },
    undoneResult:{ error:null, text:'第两页标题' },
  });

  const ambiguousFallback = await page.evaluate(() => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const heading = document.querySelectorAll('h2')[1];
    const target = runtime.makeLocator(heading);
    heading.textContent = '重复重复';
    try {
      runtime.applyAction({
        id:'ambiguous-text', target:{ ...target, textPath:'9' }, kind:'setText',
        payload:{ text:'更新' }, before:'重复',
      });
      return null;
    } catch (error) { return error.code || error.message; }
  });
  assert.equal(ambiguousFallback, 'TARGET_AMBIGUOUS');
});

test('局部文字样式替换只恢复自己的包装，不覆盖同文本框的其他修改', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result = await page.evaluate(() => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const heading = document.querySelector('h2');
    heading.innerHTML = '前文<span data-unrelated>删改前</span>后文';
    const target = runtime.makeLocator(heading);
    const action = value => ({
      id:`weight-${value}`, target, kind:'setStyle',
      payload:{ property:'font-weight', value, textRange:{ start:0, end:2 } },
    });
    runtime.applyAll([action('400')]);
    heading.querySelector('[data-unrelated]').textContent = '删改后必须保留';
    runtime.applyAll([action('700')]);
    return {
      unrelated:heading.querySelector('[data-unrelated]')?.textContent ?? null,
      text:heading.textContent,
    };
  });
  assert.deepEqual(result, {
    unrelated:'删改后必须保留',
    text:'前文删改后必须保留后文',
  });
});

test('公开动作登记后定位第二个同名页并在 DOM 重建后幂等重放', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const initial = await page.evaluate(() => {
    const rt = window.HuaweiDeckPatchRuntime;
    const el = document.querySelectorAll('h2')[1];
    const target = rt.makeLocator(el);
    const applied = rt.applyAction({ target, kind:'setText', payload:{ text:'已修改' } });
    const translate = { target, kind:'translate', payload:{ x:10, y:20 } };
    rt.applyAction(translate);
    rt.applyAction(translate);
    rt.applyAction(translate);
    const sameLocator = target === rt.makeLocator(el);
    el.closest('section').outerHTML = '<section data-label="目录页"><h2>第二页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 B</div></section>';
    return { pageKey:target.pageKey, text:el.textContent, translate:el.style.translate,
      before:applied.before, sameLocator };
  });
  assert.match(initial.pageKey, /^page-002-/);
  assert.deepEqual({ ...initial, pageKey:undefined }, {
    pageKey:undefined, text:'已修改', translate:'10px 20px', before:'第二页标题', sameLocator:true,
  });
  await page.waitForFunction(() => {
    const el = document.querySelectorAll('h2')[1];
    return el.textContent === '已修改' && el.style.translate === '10px 20px';
  }, undefined, { timeout:1000 });
});

test('新节点指纹不符时 applyAll 抛出 TARGET_AMBIGUOUS', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const error = await page.evaluate(() => {
    const rt = window.HuaweiDeckPatchRuntime;
    const el = document.querySelectorAll('h2')[1];
    const target = rt.makeLocator(el);
    el.closest('section').innerHTML = '<h2>指纹不符</h2>';
    try {
      rt.applyAll([{ target, kind:'setText', payload:{ text:'不应应用' } }]);
      return null;
    } catch (caught) {
      return caught.message;
    }
  });
  assert.equal(error, 'TARGET_AMBIGUOUS');
});

test('源码基线重放只对显式旧动作放宽指纹且仍校验几何位置', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result = await page.evaluate(() => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const stableTarget = runtime.makeLocator(document.querySelectorAll('h2')[0]);
    document.querySelectorAll('h2')[0].outerHTML = '<h2 style="font-family:serif">第一页标题</h2>';
    const stableAction = {
      id:'source-rebase-stable', taskId:null, target:stableTarget, kind:'setText',
      payload:{ text:'重放成功' }, before:'第一页标题', after:'重放成功',
    };
    let strict;
    try { runtime.applyAll([stableAction]); strict=null; }
    catch (error) { strict=error.code || error.message; }
    runtime.applyAll([stableAction], { rebaseActionIds:[stableAction.id] });

    const movedTarget = runtime.makeLocator(document.querySelectorAll('h2')[1]);
    document.querySelectorAll('h2')[1].outerHTML = '<h2 style="position:absolute;left:900px;top:700px">第二页标题</h2>';
    const movedAction = {
      id:'source-rebase-moved', taskId:null, target:movedTarget, kind:'setText',
      payload:{ text:'不应误改' }, before:'第二页标题', after:'不应误改',
    };
    let moved;
    try { runtime.applyAll([movedAction], { rebaseActionIds:[movedAction.id] }); moved=null; }
    catch (error) { moved=error.code || error.message; }
    return {
      strict, stable:document.querySelectorAll('h2')[0].textContent,
      moved, movedText:document.querySelectorAll('h2')[1].textContent,
    };
  });
  assert.deepEqual(result, {
    strict:'TARGET_AMBIGUOUS', stable:'重放成功',
    moved:'TARGET_AMBIGUOUS', movedText:'第二页标题',
  });
});

test('持久元素身份允许 Agent 调整 DOM 层级后继续安全重放', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result = await page.evaluate(() => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const heading = document.querySelectorAll('h2')[0];
    heading.dataset.editorId = 'element-11111111111111111111111111111111';
    const target = runtime.makeLocator(heading);
    const action = {
      id:'stable-editor-id-style', taskId:null, target, kind:'setStyle',
      payload:{ property:'color', value:'red' }, before:'', after:'red',
    };
    heading.outerHTML = [
      '<div class="agent-layout-wrapper">',
      '  <h2 data-editor-id="element-11111111111111111111111111111111" style="font-family:serif">第一页标题</h2>',
      '</div>',
    ].join('');
    try {
      runtime.applyAll([action], { rebaseActionIds:[action.id] });
      const moved = document.querySelector('[data-editor-id="element-11111111111111111111111111111111"]');
      return {
        error:null,
        editorId:target.editorId ?? null,
        color:moved.style.color,
        family:moved.style.fontFamily,
      };
    } catch (error) {
      return { error:error.code || error.message, editorId:target.editorId ?? null };
    }
  });
  assert.deepEqual(result, {
    error:null,
    editorId:'element-11111111111111111111111111111111',
    color:'red',
    family:'serif',
  });
});

test('源码基线把同路径同几何的新语义元素视为冲突而不是旧目标', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result = await page.evaluate(() => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const heading = document.querySelectorAll('h2')[0];
    heading.dataset.editorId = 'element-22222222222222222222222222222222';
    const target = runtime.makeLocator(heading);
    const action = {
      id:'source-rebase-semantic-replacement', taskId:null, target, kind:'setText',
      payload:{ text:'人工旧标题' }, before:'第一页标题', after:'人工旧标题',
    };
    heading.outerHTML = '<h2 data-editor-id="element-22222222222222222222222222222222">Agent 新语义标题</h2>';
    try {
      runtime.applyAll([action], { rebaseActionIds:[action.id] });
      return { error:null, text:document.querySelectorAll('h2')[0].textContent };
    } catch (error) {
      return { error:error.code || error.message, text:document.querySelectorAll('h2')[0].textContent };
    }
  });
  assert.deepEqual(result, {
    error:'TARGET_AMBIGUOUS', text:'Agent 新语义标题',
  });
});

test('Agent 后写同一样式属性时旧人工动作不得覆盖新值', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result = await page.evaluate(() => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const heading = document.querySelectorAll('h2')[0];
    heading.dataset.editorId = 'element-33333333333333333333333333333333';
    const target = runtime.makeLocator(heading);
    const action = {
      id:'source-style-conflict', taskId:null, target, kind:'setStyle',
      payload:{ property:'color', value:'red' }, before:'', after:'red',
    };
    heading.outerHTML = '<h2 data-editor-id="element-33333333333333333333333333333333" style="color:blue">第一页标题</h2>';
    try {
      runtime.applyAll([action], { rebaseActionIds:[action.id] });
      return { error:null, color:document.querySelectorAll('h2')[0].style.color };
    } catch (error) {
      return {
        error:error.code || error.message,
        color:document.querySelectorAll('h2')[0].style.color,
      };
    }
  });
  assert.deepEqual(result, { error:'TARGET_AMBIGUOUS', color:'blue' });
});

test('Agent 插字后旧局部格式必须冲突关闭而不能漂移到其他字符', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result = await page.evaluate(() => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const heading = document.querySelectorAll('h2')[0];
    heading.dataset.editorId = 'element-44444444444444444444444444444444';
    const target = runtime.makeLocator(heading);
    const action = {
      id:'source-range-drift', taskId:null, target, kind:'setStyle',
      payload:{ property:'color', value:'red', textRange:{ start:0, end:1 } },
      before:'rgb(25, 25, 25)', after:'red',
    };
    heading.outerHTML = '<h2 data-editor-id="element-44444444444444444444444444444444">新第一页标题</h2>';
    try {
      runtime.applyAll([action], { rebaseActionIds:[action.id] });
      return { error:null, styled:document.querySelector('[data-deck-text-range-style]')?.textContent ?? '' };
    } catch (error) {
      return {
        error:error.code || error.message,
        styled:document.querySelector('[data-deck-text-range-style]')?.textContent ?? '',
      };
    }
  });
  assert.deepEqual(result, { error:'TARGET_AMBIGUOUS', styled:'' });
});

test('Deck 重绘让 active action 失效时必须发布可观察冲突事件', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  await page.evaluate(() => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const heading = document.querySelectorAll('h2')[0];
    const target = runtime.makeLocator(heading);
    window.__patchReplayFailures = [];
    document.addEventListener('huawei-deck-patch-replay-error', event => {
      window.__patchReplayFailures.push(event.detail);
    });
    runtime.applyAll([{
      id:'repaint-conflict-action', taskId:null, target, kind:'setText',
      payload:{ text:'人工标题' }, before:'第一页标题', after:'人工标题',
    }]);
    heading.outerHTML = '<h2>Deck 重绘标题</h2>';
  });
  await page.waitForTimeout(100);
  const result = await page.evaluate(() => ({
    failures:window.__patchReplayFailures,
    text:document.querySelectorAll('h2')[0].textContent,
    active:window.HuaweiDeckPatchRuntime.activeActionCount(),
  }));
  assert.deepEqual(result, {
    failures:[{
      code:'TARGET_AMBIGUOUS', actionId:'repaint-conflict-action',
      failedActionId:'repaint-conflict-action',
    }],
    text:'Deck 重绘标题',
    active:1,
  });
});

test('hide 和 show 共享 display 状态并以最后一次公开动作为准', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const target = await page.evaluate(() => {
    const rt = window.HuaweiDeckPatchRuntime;
    const el = document.querySelectorAll('h2')[1];
    const locator = rt.makeLocator(el);
    rt.applyAction({ target:locator, kind:'hide', payload:{} });
    rt.applyAction({ target:locator, kind:'show', payload:{ display:'' } });
    rt.applyAction({ target:locator, kind:'hide', payload:{} });
    el.closest('section').outerHTML = '<section data-label="目录页"><h2>第二页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 B</div></section>';
    return locator;
  });
  await page.waitForFunction(() => document.querySelectorAll('h2')[1].style.display === 'none',
    undefined, { timeout:1000 });

  await page.evaluate(locator => {
    const rt = window.HuaweiDeckPatchRuntime;
    rt.applyAction({ target:locator, kind:'show', payload:{ display:'' } });
    rt.applyAction({ target:locator, kind:'hide', payload:{} });
    rt.applyAction({ target:locator, kind:'show', payload:{ display:'' } });
    document.querySelectorAll('h2')[1].closest('section').outerHTML = '<section data-label="目录页"><h2>第二页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 B</div></section>';
  }, target);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('h2').nth(1).evaluate(el => el.style.display), '');
});

test('动作日志可见性编译和撤销重做在 DOM 重建后保持最终状态', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const target = await page.evaluate(() => window.HuaweiDeckPatchRuntime.makeLocator(document.querySelectorAll('h2')[1]));
  const journal = new PatchJournal();
  const group = journal.appendGroup('task-visibility', [
    { id:'v1', taskId:'task-visibility', target, kind:'hide', payload:{}, before:'', after:'none', appliedAt:'t1' },
    { id:'v2', taskId:'task-visibility', target, kind:'show', payload:{display:''}, before:'none', after:'', appliedAt:'t2' },
    { id:'v3', taskId:'task-visibility', target, kind:'hide', payload:{}, before:'', after:'none', appliedAt:'t3' }
  ]);
  const applyAndRebuild = async actions => {
    await page.evaluate(nextActions => {
      window.HuaweiDeckPatchRuntime.applyAll(nextActions);
      document.querySelectorAll('.slide-canvas')[1].innerHTML = '<section data-label="目录页"><h2>第二页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 B</div></section>';
    }, actions);
    await page.waitForTimeout(100);
    return page.locator('h2').nth(1).evaluate(el => el.style.display);
  };

  assert.equal(await applyAndRebuild(journal.compile()), 'none');
  assert.equal(await applyAndRebuild(journal.undo(group.id)), '');
  assert.equal(await applyAndRebuild(journal.redo(group.id)), 'none');
});

test('applyAll 失败后恢复旧 authoritative 集合且不产生异步 pageerror', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const error = await page.evaluate(() => {
    const rt = window.HuaweiDeckPatchRuntime;
    const headings = document.querySelectorAll('h2');
    const goodTarget = rt.makeLocator(headings[1]);
    const ambiguousTarget = rt.makeLocator(headings[0]);
    rt.applyAction({ target:goodTarget, kind:'setText', payload:{ text:'保留动作' } });
    headings[0].closest('section').innerHTML = '<h2>指纹不符</h2>';
    try {
      rt.applyAll([{ target:ambiguousTarget, kind:'setText', payload:{ text:'失败批次' } }]);
      return null;
    } catch (caught) {
      return caught.message;
    }
  });
  assert.equal(error, 'TARGET_AMBIGUOUS');
  await page.waitForTimeout(100);

  await page.evaluate(() => {
    const canvases = document.querySelectorAll('.slide-canvas');
    canvases[0].innerHTML = '<section data-label="目录页"><h2>第一页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 A</div></section>';
    canvases[1].innerHTML = '<section data-label="目录页"><h2>第二页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 B</div></section>';
  });
  await page.waitForTimeout(100);
  const texts = await page.locator('h2').allTextContents();
  assert.deepEqual(texts, ['第一页标题', '保留动作']);
  assert.deepEqual(pageErrors, []);
});

test('authoritative replace 按 key 恢复基线并隔离 resize 分支', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result = await page.evaluate(() => {
    const rt=window.HuaweiDeckPatchRuntime;
    const heading=document.querySelector('h2');
    const card=document.querySelector('.card');
    const headingTarget=rt.makeLocator(heading);
    const cardTarget=rt.makeLocator(card);
    rt.applyAll([
      { id:'move',target:headingTarget,kind:'translate',payload:{x:40,y:20} },
      { id:'red',target:headingTarget,kind:'setStyle',payload:{property:'color',value:'red'} },
    ]);
    rt.applyAll([
      { id:'blue',target:headingTarget,kind:'setStyle',payload:{property:'color',value:'blue'} },
    ]);
    const oneKey = { translate:heading.style.translate,color:heading.style.color };
    rt.applyAll([]);
    const empty = { translate:heading.style.translate,color:heading.style.color };

    rt.applyAll([{ id:'size',target:cardTarget,kind:'resize',payload:{width:500,height:200} }]);
    rt.applyAll([{ id:'scale',target:cardTarget,kind:'resize',payload:{scale:1.5} }]);
    const scale = { width:card.style.width,height:card.style.height,scale:card.style.scale };
    rt.applyAll([{ id:'size-2',target:cardTarget,kind:'resize',payload:{width:450,height:150} }]);
    const size = { width:card.style.width,height:card.style.height,scale:card.style.scale };
    return { oneKey,empty,scale,size,pending:rt.pendingTransactionCount() };
  });
  assert.deepEqual(result, {
    oneKey:{ translate:'',color:'blue' },
    empty:{ translate:'',color:'' },
    scale:{ width:'300px',height:'100px',scale:'1.5' },
    size:{ width:'450px',height:'150px',scale:'' },
    pending:0,
  });
});

test('定位失败候选最多五个且排除隐藏祖先下的同标签元素', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result = await page.evaluate(() => {
    const rt = window.HuaweiDeckPatchRuntime;
    const canvas = document.querySelector('.slide-canvas');
    const section = canvas.querySelector('section');
    const hiddenParent = document.createElement('div');
    hiddenParent.style.opacity = '0';
    const hidden = document.createElement('h2');
    hidden.textContent = '隐藏候选';
    Object.assign(hidden.style, { position:'absolute', left:'100px', top:'100px', width:'200px', height:'80px' });
    hiddenParent.append(hidden);
    section.append(hiddenParent);
    for (let index=0; index<8; index+=1) {
      const visible = document.createElement('h2');
      visible.textContent = `可见候选 ${index}`;
      Object.assign(visible.style, {
        position:'absolute', left:`${400+index*30}px`, top:'100px', width:'200px', height:'80px',
      });
      section.append(visible);
    }
    const hiddenPath = rt.makeLocator(hidden).path;
    const base = rt.makeLocator(document.querySelector('h2'));
    try {
      rt.applyTransaction([{
        id:'missing', target:{ ...base, path:'999', rect:{ x:100,y:100,w:200,h:80 } },
        kind:'setText', payload:{ text:'不应用' },
      }]);
      return null;
    } catch (error) {
      return { code:error.code, hiddenPath, candidates:error.candidates };
    }
  });
  assert.equal(result.code, 'TARGET_NOT_FOUND');
  assert.ok(result.candidates.length <= 5);
  assert.ok(result.candidates.every(candidate => candidate.tag === 'H2'));
  assert.ok(!result.candidates.some(candidate => candidate.path === result.hiddenPath));
});

test('同一页面二次加载 patch runtime 复用对象身份与已有动作状态', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  await page.evaluate(() => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const heading = document.querySelector('h2');
    const target = runtime.makeLocator(heading);
    runtime.applyAll([{ id:'before-second-load', target, kind:'setText', payload:{ text:'保留状态' } }]);
    window.__runtimeBeforeSecondLoad = runtime;
  });

  await page.addScriptTag({ path:resolve('scripts/editor/runtime/patch-runtime.js') });
  const result = await page.evaluate(() => ({
    same:window.HuaweiDeckPatchRuntime === window.__runtimeBeforeSecondLoad,
    active:window.HuaweiDeckPatchRuntime.activeActionCount(),
    text:document.querySelector('h2').textContent,
    contract:window.HuaweiDeckPatchRuntime.contract,
  }));
  assert.deepEqual(result, { same:true, active:1, text:'保留状态', contract:RUNTIME_CONTRACT });
});

test('旧 branded runtime 不兼容时稳定拒绝且不覆盖全局对象', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto('about:blank');
  const source = await readFile(resolve('scripts/editor/runtime/patch-runtime.js'), 'utf8');
  const result = await page.evaluate(({ runtimeSource, contract }) => {
    const oldRuntime = { contract:{ ...contract, schema:0, version:'0.9.0' } };
    window.HuaweiDeckPatchRuntime = oldRuntime;
    try {
      (0, eval)(runtimeSource);
      return { code:null, preserved:window.HuaweiDeckPatchRuntime === oldRuntime };
    } catch (error) {
      return { code:error.code, preserved:window.HuaweiDeckPatchRuntime === oldRuntime };
    }
  }, { runtimeSource:source, contract:RUNTIME_CONTRACT });
  assert.deepEqual(result, { code:'RUNTIME_INCOMPATIBLE', preserved:true });
});

test('foreign truthy runtime 全局冲突时稳定拒绝且不盲目覆盖', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto('about:blank');
  const source = await readFile(resolve('scripts/editor/runtime/patch-runtime.js'), 'utf8');
  const result = await page.evaluate(runtimeSource => {
    const foreignRuntime = { pageKey:'foreign' };
    window.HuaweiDeckPatchRuntime = foreignRuntime;
    try {
      (0, eval)(runtimeSource);
      return { code:null, preserved:window.HuaweiDeckPatchRuntime === foreignRuntime };
    } catch (error) {
      return { code:error.code, preserved:window.HuaweiDeckPatchRuntime === foreignRuntime };
    }
  }, source);
  assert.deepEqual(result, { code:'RUNTIME_GLOBAL_CONFLICT', preserved:true });
});

test('pageKey 保留 script raw-text 内 blob 字符串差异', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result = await page.evaluate(() => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const stage = document.querySelector('.stage');
    const original = stage.querySelector('.slide-canvas');
    const script = document.createElement('script');
    script.type = 'application/json';
    script.textContent = String.raw`{"template":"<img src=\"blob:a\">"}`;
    original.querySelector('section').append(script);
    const first = runtime.pageKey(original);
    const replacement = original.cloneNode(true);
    replacement.querySelector('script').textContent = String.raw`{"template":"<img src=\"blob:b\">"}`;
    original.replaceWith(replacement);
    const second = runtime.pageKey(replacement);
    return { first, second };
  });
  assert.notEqual(result.first, result.second);
});

test('持久 data-page-id 不随页面内容、标题和顺序变化', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result = await page.evaluate(() => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const canvases = [...document.querySelectorAll('.slide-canvas')];
    const id = `page-${'a'.repeat(32)}`;
    canvases[0].querySelector('section').dataset.pageId = id;
    const before = runtime.pageKey(canvases[0]);
    canvases[0].querySelector('section').dataset.label = '已经改名';
    canvases[0].querySelector('h2').textContent = '已经改文案';
    canvases[0].parentElement.append(canvases[0]);
    const after = runtime.pageKey(canvases[0]);
    return { before, after };
  });
  assert.deepEqual(result, {
    before:`page-${'a'.repeat(32)}`,
    after:`page-${'a'.repeat(32)}`,
  });
});

test('重复或畸形 data-page-id 明确拒绝而不是串页', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll('.slide-canvas')];
    const runtime = window.HuaweiDeckPatchRuntime;
    const codes = [];
    canvases[0].querySelector('section').dataset.pageId = 'page-bad';
    try { runtime.pageKey(canvases[0]); } catch (error) { codes.push(error.code); }
    const duplicate = `page-${'b'.repeat(32)}`;
    for (const canvas of canvases) canvas.querySelector('section').dataset.pageId = duplicate;
    try { runtime.pageKey(canvases[1]); } catch (error) { codes.push(error.code); }
    return codes;
  });
  assert.deepEqual(result, ['PAGE_ID_INVALID', 'PAGE_ID_AMBIGUOUS']);
});

test('源码覆盖旧标题后重开可恢复其他样式并继续修改、撤销和重做', async t => {
  const {compileActionGroups,sourceRebaseActionIds,actionKey}=await import('../action-compiler.mjs');
  const {sameCanonicalActionValue}=await import('../action-canonicalizer.mjs');
  const chromium=await loadChromium();
  const browser=await chromium.launch({channel:'chrome',headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const original=await page.evaluate(()=>{
    const rt=window.HuaweiDeckPatchRuntime;
    const title=document.querySelector('h2');
    title.closest('section').dataset.pageId='page-11111111111111111111111111111111';
    title.dataset.editorId='element-11111111111111111111111111111111';
    const target=rt.makeLocator(title);
    return rt.applyTransaction([
      {id:'title',target,kind:'setText',payload:{text:'旧编辑标题'}},
      {id:'color',target,kind:'setStyle',payload:{property:'color',value:'#20252b'}},
    ]);
  });
  const groups=[{active:true,actions:original},{active:true,mutationType:'source',source:{actionReconciliation:{version:1,supersededKeys:[actionKey(original[0])]}},actions:[]}];
  await page.reload();
  await page.evaluate(()=>{
    const title=document.querySelector('h2');
    title.closest('section').dataset.pageId='page-11111111111111111111111111111111';
    title.dataset.editorId='element-11111111111111111111111111111111';
    title.textContent='新的源码标题';
  });
  const actions=compileActionGroups(groups);
  const outcome=await page.evaluate(({actions,ids})=>{
    const rt=window.HuaweiDeckPatchRuntime;
    rt.applyAllDroppingMissing(actions,{rebaseActionIds:ids});
    const title=document.querySelector('h2');
    const applied=rt.applyTransaction([{id:'next',target:rt.makeLocator(title),kind:'setStyle',payload:{property:'color',value:'#000000'}}])[0];
    const text=title.textContent;
    rt.applyAll(actions,{rebaseActionIds:ids});
    const undo=getComputedStyle(title).color;
    rt.applyTransaction([applied]);
    return {applied,text,undo,redo:getComputedStyle(title).color};
  },{actions,ids:sourceRebaseActionIds(groups,actions)});
  assert.equal(outcome.text,'新的源码标题');
  assert.ok(sameCanonicalActionValue(outcome.applied,outcome.applied.before,original[1].after));
  assert.equal(outcome.undo,'rgb(32, 37, 43)');
  assert.equal(outcome.redo,'rgb(0, 0, 0)');
});

test('非整数缩放下连续调整尺寸保持历史连续，撤销重放不丢失尺寸', async t => {
  const browser = await (await loadChromium()).launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result = await page.evaluate(() => {
    const rt = window.HuaweiDeckPatchRuntime;
    document.documentElement.style.zoom = '0.8333333333333333';
    const el = document.querySelector('h2');
    const target = rt.makeLocator(el);
    const first = rt.applyTransaction([{ id:'resize-first', target, kind:'resize', payload:{width:308,height:168} }])[0];
    const second = rt.applyTransaction([{ id:'resize-second', target, kind:'resize', payload:{width:320,height:175} }])[0];
    rt.applyAll([first]);
    const undone = {width:el.style.width,height:el.style.height};
    rt.applyAll([second]);
    const redone = {width:el.style.width,height:el.style.height};
    return {first,second,undone,redone};
  });
  assert.deepEqual(result.second.before, result.first.after);
  assert.deepEqual(result.undone, {width:'308px',height:'168px'});
  assert.deepEqual(result.redone, {width:'320px',height:'175px'});
});

test('布局变化后 resize 仅凭源码声明证据重放，声明冲突仍拒绝', async t => {
  const browser=await(await loadChromium()).launch({channel:'chrome',headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result=await page.evaluate(()=>{
    const rt=window.HuaweiDeckPatchRuntime;
    let el=document.querySelector('.card');
    const section=el.closest('section');section.dataset.pageId='page-11111111111111111111111111111111';
    el.dataset.editorId='element-11111111111111111111111111111111';
    el.parentElement.style.width='300px';
    el.style.cssText='width:100%;height:100px;overflow:hidden';
    const target=rt.makeLocator(el);
    const a={id:'resize',target,kind:'resize',payload:{width:400,height:200},before:{width:300,height:100},after:{width:400,height:200},sourceResizeStyle:el.style.cssText};
    el.textContent='源码调整了内容';
    el.parentElement.style.width='600px';
    el.replaceWith(el.cloneNode(true));el=document.querySelector('.card');
    let unproven;try{const {sourceResizeStyle,...without}=a;rt.applyAll([without],{rebaseActionIds:[a.id]});}catch(e){unproven=e.code;}
    const applied=rt.applyAll([a],{rebaseActionIds:[a.id]});
    rt.applyAll([]);
    const restored=el.style.width;
    el.style.width='500px';
    el.replaceWith(el.cloneNode(true));el=document.querySelector('.card');
    let error;try{rt.applyAll([a],{rebaseActionIds:[a.id]});}catch(e){error=e.code;}
    return {applied:applied.length,restored,error,unproven};
  });
  assert.equal(result.applied,1);
  assert.equal(result.restored,'100%');
  assert.equal(result.unproven,'TARGET_AMBIGUOUS');
  assert.equal(result.error,'TARGET_AMBIGUOUS');
});
