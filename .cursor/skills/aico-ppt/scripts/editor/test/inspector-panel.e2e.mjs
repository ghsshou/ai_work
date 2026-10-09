import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer, openEditor } from './test-helpers.mjs';

async function session(app) {
  return fetch(`${app.url}/api/session?token=${app.token}`).then(response => response.json());
}

function inertAgentPty() {
  return {
    pid:4321,
    onData() { return { dispose() {} }; },
    onExit() { return { dispose() {} }; },
    write() {}, resize() {}, kill() {},
  };
}

test('编辑模式点击画布元素不会同时触发 Deck 自身的点击切版', async t => {
  const app = await startFixtureServer({
    fixtureTransform:html => html
      .replace(
        '<h2>第一页标题</h2>',
        '<h2 data-test-layout-trigger>第一页标题</h2><div data-test-layout-state="base">基线版面</div>',
      )
      .replace(
        '<script src="../../runtime/patch-runtime.js"></script>',
        `<script>
document.addEventListener('click', event => {
  if (!event.target.closest('[data-test-layout-trigger]')) return;
  const state = document.querySelector('[data-test-layout-state]');
  state.dataset.testLayoutState = state.dataset.testLayoutState === 'base' ? 'alternate' : 'base';
  state.textContent = state.dataset.testLayoutState === 'base' ? '基线版面' : '切换版面';
});
</script><script src="../../runtime/patch-runtime.js"></script>`,
      ),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('.stage .slide-canvas').first().locator('h2');
  const layout = frame.locator('[data-test-layout-state]');

  await page.click('[data-mode="edit"]');
  await heading.click({ position:{ x:20, y:10 } });
  assert.equal(await heading.getAttribute('data-direct-editing'), '');
  assert.equal(await layout.getAttribute('data-test-layout-state'), 'base');
  assert.equal(await layout.textContent(), '基线版面');

  await page.click('[data-mode="preview"]');
  await heading.click({ position:{ x:20, y:10 } });
  assert.equal(await layout.getAttribute('data-test-layout-state'), 'alternate');
  assert.equal(await layout.textContent(), '切换版面');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

async function assertArrowVisibleOnHover(page, selector) {
  const button = page.locator(selector);
  await button.hover();
  await page.waitForTimeout(340);
  assert.equal(await button.locator('.pill-nav-label-default')
    .evaluate(element => getComputedStyle(element).opacity), '1');
  await page.mouse.move(0, 0);
}

test('顶部属性工具栏常驻高频文字操作并以互斥抽屉展开分类', async t => {
  const app = await startFixtureServer({ spawnAgentTerminal:inertAgentPty });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();

  await page.click('[data-mode="edit"]');
  await heading.click();
  await page.waitForSelector('.inspector-body');
  await page.click('[data-agent-status]');
  await page.locator('[data-agent-terminal-panel]').waitFor({ state:'visible' });
  await page.waitForFunction(() => document.querySelector('.editor-shell')?.dataset.inspectorDock
    === 'top');

  const inspector = page.locator('.inspector-panel');
  const body = page.locator('.inspector-body');
  const textGroup = body.locator('[data-inspector-group="text"]');
  const visibleTriggers = body.locator('[data-inspector-group-trigger]:visible');
  assert.deepEqual(await visibleTriggers.evaluateAll(buttons => buttons.map(button => ({
    title:button.querySelector('.inspector-group-title')?.textContent,
    summary:button.querySelector('.inspector-group-summary')?.textContent,
  }))), [
    { title:'段落', summary:'对齐 · 列表 · 行距' },
    { title:'外观', summary:'文字色 · 填充' },
    { title:'更多', summary:'边框 · 透明度 · 恢复' },
  ]);
  assert.equal(await textGroup.getByRole('combobox', { name:'字体' }).isVisible(), true);
  assert.equal(await textGroup.locator('[data-value-property="font-size"]').isVisible(), true);
  assert.equal(await textGroup.locator('[data-style-property="font-weight"]').isVisible(), true);
  assert.equal(await textGroup.locator('[data-style-property="font-style"]').isVisible(), true);
  assert.equal(await textGroup.locator('[data-style-property="text-decoration-line"]').isVisible(), true);

  const paragraphTrigger = body.locator('[data-inspector-group-trigger="paragraph"]');
  const appearanceTrigger = body.locator('[data-inspector-group-trigger="appearance"]');
  const paragraphPanel = body.locator('[data-inspector-group-panel="paragraph"]');
  const appearancePanel = body.locator('[data-inspector-group-panel="appearance"]');
  assert.equal(await paragraphPanel.isHidden(), true);
  await paragraphTrigger.click();
  assert.equal(await paragraphTrigger.getAttribute('aria-expanded'), 'true');
  assert.equal(await paragraphPanel.isVisible(), true);
  await appearanceTrigger.click();
  assert.equal(await paragraphPanel.isHidden(), true);
  assert.equal(await appearancePanel.isVisible(), true);
  assert.equal(await body.locator('[data-inspector-group][data-open="true"]').count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await appearancePanel.isHidden(), true);
  assert.equal(await appearanceTrigger.getAttribute('aria-expanded'), 'false');
  await paragraphTrigger.click();
  await page.locator('.frame-viewport').click({ position:{ x:20, y:20 } });
  assert.equal(await paragraphPanel.isHidden(), true);

  for (const viewport of [
    { width:1280, height:800 },
    { width:1440, height:900 },
    { width:1920, height:1080 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(80);
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector('.inspector-panel').getBoundingClientRect();
      const inspectorBody = document.querySelector('.inspector-body');
      const textPanel = document.querySelector('[data-inspector-group-panel="text"]')
        .getBoundingClientRect();
      const controls = [...document.querySelectorAll(
        '[data-inspector-group="text"] .inspector-field, [data-inspector-group-trigger]:not([hidden])',
      )].filter(element => getComputedStyle(element).display !== 'none')
        .map(element => {
          const rect = element.getBoundingClientRect();
          return { top:rect.top, bottom:rect.bottom, name:element.getAttribute('data-inspector-group-trigger')
            ?? element.textContent.trim() };
        });
      return {
        panelHeight:panel.height,
        bodyClientWidth:inspectorBody.clientWidth,
        bodyScrollWidth:inspectorBody.scrollWidth,
        rows:new Set(controls.map(rect => Math.round(rect.top))).size,
        controls,
        textPanelHeight:textPanel.height,
      };
    });
    assert.ok(geometry.panelHeight <= 92, `${viewport.width}: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.bodyScrollWidth <= geometry.bodyClientWidth + 1,
      `${viewport.width} 不应横向滚动：${JSON.stringify(geometry)}`);
    assert.equal(geometry.rows, 1, `${viewport.width} 应保持单行：${JSON.stringify(geometry)}`);
    assert.ok(geometry.textPanelHeight <= 42, `${viewport.width}: ${JSON.stringify(geometry)}`);
  }
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('右侧属性面板以互斥手风琴组织分类并固定对象摘要与恢复操作', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);

  await page.click('[data-mode="edit"]');
  await page.frameLocator('#deck-frame').locator('h2').first().click();
  await page.waitForSelector('.inspector-body[data-dock="right"]');
  const body = page.locator('.inspector-body');
  const textTrigger = body.locator('[data-inspector-group-trigger="text"]');
  const paragraphTrigger = body.locator('[data-inspector-group-trigger="paragraph"]');
  const textPanel = body.locator('[data-inspector-group-panel="text"]');
  const paragraphPanel = body.locator('[data-inspector-group-panel="paragraph"]');

  assert.equal(await textTrigger.getAttribute('aria-expanded'), 'true');
  assert.equal(await textPanel.isVisible(), true);
  assert.equal(await paragraphPanel.isHidden(), true);
  assert.equal(await body.locator('[data-inspector-group][data-open="true"]').count(), 1);
  await paragraphTrigger.click();
  assert.equal(await textPanel.isHidden(), true);
  assert.equal(await paragraphPanel.isVisible(), true);
  assert.equal(await body.locator('[data-inspector-group][data-open="true"]').count(), 1);

  for (const viewport of [
    { width:1280, height:800 },
    { width:1440, height:900 },
    { width:1920, height:1080 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(60);
    const geometry = await body.evaluate(element => {
      const object = element.querySelector('.inspector-object').getBoundingClientRect();
      const groups = element.querySelector('.inspector-groups').getBoundingClientRect();
      const footer = element.querySelector('.inspector-footer').getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      return {
        clientWidth:element.clientWidth,
        scrollWidth:element.scrollWidth,
        bodyOverflow:getComputedStyle(element).overflow,
        groupsOverflowY:getComputedStyle(element.querySelector('.inspector-groups')).overflowY,
        objectAboveGroups:object.bottom <= groups.top + 1,
        footerBelowGroups:footer.top >= groups.bottom - 1,
        contained:object.top >= bounds.top && footer.bottom <= bounds.bottom + 1,
      };
    });
    assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1,
      `${viewport.width} 不应横向溢出：${JSON.stringify(geometry)}`);
    assert.equal(geometry.bodyOverflow, 'hidden');
    assert.equal(geometry.groupsOverflowY, 'auto');
    assert.equal(geometry.objectAboveGroups, true);
    assert.equal(geometry.footerBelowGroups, true);
    assert.equal(geometry.contained, true);
  }
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('终端展开时属性面板停靠到画布上方，关闭后恢复右侧边栏', async t => {
  const app = await startFixtureServer({ spawnAgentTerminal:inertAgentPty });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();

  assert.equal(await page.locator('.inspector-panel').isHidden(), true);
  await page.click('[data-mode="edit"]');
  assert.equal(await page.locator('.inspector-panel').isVisible(), true);
  await heading.click();
  await page.waitForSelector('.inspector-body');
  const closed = await page.evaluate(() => {
    const inspector = document.querySelector('.inspector-panel').getBoundingClientRect();
    const canvas = document.querySelector('.canvas-column').getBoundingClientRect();
    return { inspector:{ x:inspector.x, y:inspector.y }, canvas:{ right:canvas.right, y:canvas.y } };
  });
  assert.ok(closed.inspector.x - closed.canvas.right >= 7, JSON.stringify(closed));
  assert.ok(Math.abs(closed.inspector.y - closed.canvas.y) <= 1, JSON.stringify(closed));
  assert.equal(await page.locator('[data-inspector-collapse]')
    .getAttribute('data-pill-arrow-direction'), 'right');
  await assertArrowVisibleOnHover(page, '[data-inspector-collapse]');
  if (process.env.INSPECTOR_RIGHT_SCREENSHOT) {
    await page.screenshot({ path:process.env.INSPECTOR_RIGHT_SCREENSHOT, fullPage:true });
  }

  await page.click('[data-inspector-collapse]');
  assert.equal(await page.locator('.inspector-panel').isHidden(), true);
  assert.equal(await page.locator('[data-inspector-reopen]').isVisible(), true);
  assert.equal(await page.locator('[data-inspector-reopen]')
    .getAttribute('data-pill-arrow-direction'), 'left');
  assert.deepEqual(await page.locator('[data-inspector-reopen]').evaluate(button => {
    const style = getComputedStyle(button);
    return { width:style.width, height:style.height, borderRadius:style.borderRadius };
  }), { width:'30px', height:'30px', borderRadius:'999px' });
  await assertArrowVisibleOnHover(page, '[data-inspector-reopen]');
  await page.click('[data-inspector-reopen]');
  assert.equal(await page.locator('.inspector-panel').isVisible(), true);

  await page.click('[data-agent-status]');
  await page.locator('[data-agent-terminal-panel]').waitFor({ state:'visible' });
  await page.waitForTimeout(260);
  const opened = await page.evaluate(() => {
    const inspector = document.querySelector('.inspector-panel').getBoundingClientRect();
    const canvas = document.querySelector('.canvas-column').getBoundingClientRect();
    const terminal = document.querySelector('[data-agent-terminal-panel]').getBoundingClientRect();
    const body = document.querySelector('.inspector-body');
    const fields = [...body.querySelector('.inspector-section').querySelectorAll('.inspector-field')]
      .map(field => {
        const rect = field.getBoundingClientRect();
        return { left:rect.left, right:rect.right, top:rect.top, bottom:rect.bottom };
      });
    return {
      inspector:{ x:inspector.x, right:inspector.right, top:inspector.top,
        bottom:inspector.bottom, height:inspector.height },
      canvas:{ x:canvas.x, top:canvas.top },
      terminal:{ left:terminal.left },
      bodyDisplay:getComputedStyle(body).display,
      bodyClientWidth:body.clientWidth,
      bodyScrollWidth:body.scrollWidth,
      sectionCount:body.querySelectorAll('.inspector-section').length,
      fields,
    };
  });
  assert.ok(Math.abs(opened.inspector.x - opened.canvas.x) <= 1, JSON.stringify(opened));
  assert.ok(opened.canvas.top - opened.inspector.bottom >= 7, JSON.stringify(opened));
  assert.ok(opened.terminal.left - opened.inspector.right >= 7, JSON.stringify(opened));
  assert.equal(opened.bodyDisplay, 'flex');
  assert.ok(opened.sectionCount > 0);
  assert.ok(opened.inspector.height <= 92, JSON.stringify(opened));
  assert.equal(opened.fields.length, 5, JSON.stringify(opened));
  assert.equal(await page.locator('[data-inspector-collapse]')
    .getAttribute('data-pill-arrow-direction'), 'up');
  await assertArrowVisibleOnHover(page, '[data-inspector-collapse]');
  assert.ok(opened.bodyScrollWidth <= opened.bodyClientWidth + 1,
    `横版属性面板不应依赖横向拖动：${JSON.stringify(opened)}`);
  assert.equal(new Set(opened.fields.map(field => Math.round(field.top))).size, 1,
    `高频文字工具应保持单行：${JSON.stringify(opened)}`);
  assert.ok(opened.fields.every(field => field.top >= opened.inspector.top
    && field.bottom <= opened.inspector.bottom), JSON.stringify(opened));
  if (process.env.INSPECTOR_DOCK_SCREENSHOT) {
    await page.screenshot({ path:process.env.INSPECTOR_DOCK_SCREENSHOT, fullPage:true });
  }
  for (const viewport of [
    { width:1280, height:800 },
    { width:1920, height:1080 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(80);
    const responsive = await page.evaluate(() => {
      const body = document.querySelector('.inspector-body');
      const inspector = document.querySelector('.inspector-panel').getBoundingClientRect();
      const fields = [...body.querySelector('.inspector-section').querySelectorAll('.inspector-field')]
        .map(field => field.getBoundingClientRect());
      return {
        clientWidth:body.clientWidth,
        scrollWidth:body.scrollWidth,
        inspector:{ top:inspector.top, bottom:inspector.bottom },
        rows:new Set(fields.map(field => Math.round(field.top))).size,
        textFieldsVisible:fields.every(field => field.top >= inspector.top
          && field.bottom <= inspector.bottom),
      };
    });
    assert.ok(responsive.scrollWidth <= responsive.clientWidth + 1,
      `${viewport.width}×${viewport.height} 不应出现横向拖动：${JSON.stringify(responsive)}`);
    assert.equal(responsive.rows, 1, `${viewport.width}×${viewport.height} 应保持单行`);
    assert.equal(responsive.textFieldsVisible, true,
      `${viewport.width}×${viewport.height} 的文字控件应完整可见`);
  }

  await page.click('[data-inspector-collapse]');
  assert.equal(await page.locator('.inspector-panel').isHidden(), true);
  assert.equal(await page.locator('[data-inspector-reopen]').isVisible(), true);
  assert.equal(await page.locator('[data-inspector-reopen]')
    .getAttribute('data-pill-arrow-direction'), 'down');
  await assertArrowVisibleOnHover(page, '[data-inspector-reopen]');
  await page.click('[data-inspector-reopen]');
  assert.equal(await page.locator('.inspector-panel').isVisible(), true);

  await page.click('[data-mode="preview"]');
  assert.equal(await page.locator('.inspector-panel').isHidden(), true);
  assert.equal(await page.locator('[data-inspector-reopen]').isHidden(), true);
  await page.click('[data-mode="edit"]');
  assert.equal(await page.locator('.inspector-panel').isVisible(), true);

  await page.locator('.agent-terminal-close').click();
  await page.locator('[data-agent-terminal-panel]').waitFor({ state:'hidden' });
  await page.waitForFunction(() => {
    const inspector = document.querySelector('.inspector-panel')?.getBoundingClientRect();
    const canvas = document.querySelector('.canvas-column')?.getBoundingClientRect();
    return inspector && canvas && inspector.left - canvas.right >= 7;
  });
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('属性面板识别文字和图形，并将样式修改与恢复写入统一历史', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture
      .replace('<h2>第一页标题</h2>', '<h2 style="color:#123456;font-weight:500">第一页标题</h2>')
      .replace('</section></div>', '<div class="shape" aria-label="测试图形" style="position:absolute;left:900px;top:180px;width:160px;height:100px;background:#ddd"></div></section></div>'),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();

  await page.click('[data-mode="edit"]');
  await heading.click();
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.textContent === '文字');
  assert.match(await page.locator('.inspector-object').innerText(), /第一页标题/);
  assert.equal(await page.locator('[data-inspector-group="text"]').count(), 1);

  const textColorField = page.locator('.inspector-field').filter({ hasText:'文字颜色' });
  await page.locator('[data-inspector-group-trigger="appearance"]').click();
  await textColorField.getByRole('button', { name:'文字颜色' }).click();
  await page.getByRole('dialog', { name:'文字颜色' })
    .getByRole('button', { name:'#C7000B' }).click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  assert.equal(await heading.evaluate(element => element.style.color), 'rgb(199, 0, 11)');
  assert.equal((await session(app)).groups[0].actions[0].payload.property, 'color');

  await textColorField.locator('.inspector-reset').click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  assert.equal(await heading.evaluate(element => element.style.color), 'rgb(18, 52, 86)');
  await page.waitForFunction(() => [...document.querySelectorAll('.inspector-field')]
    .find(row => row.textContent.includes('文字颜色'))
    ?.querySelector('.inspector-reset')?.disabled === true);

  const shape = frame.locator('.shape').first();
  await shape.click();
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.textContent === '图形');
  assert.match(await page.locator('.inspector-object').innerText(), /测试图形/);
  assert.equal(await page.locator('.inspector-field').filter({ hasText:'文字颜色' }).count(), 0);
  assert.equal(await page.locator('.inspector-field').filter({ hasText:'显示边框' }).count(), 1);
  await page.locator('[data-inspector-group-trigger="more"]').click();
  const inspectorBody = await page.locator('.inspector-body').elementHandle();
  const borderSwitch = page.locator('.inspector-field').filter({ hasText:'显示边框' })
    .locator('.inspector-switch');
  const switchBefore = await borderSwitch.evaluate(label => {
    const track = label.getBoundingClientRect();
    const thumb = label.querySelector('span').getBoundingClientRect();
    return { width:track.width, left:thumb.left - track.left, right:track.right - thumb.right };
  });
  await borderSwitch.click();
  const inspectorBodyConnected = await inspectorBody.evaluate(element => element.isConnected);
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '3');
  assert.equal(await shape.evaluate(element => element.style.borderStyle), 'solid');
  assert.equal(await shape.evaluate(element => element.style.borderWidth), '1px');
  await page.waitForFunction(() => {
    const body = document.querySelector('.inspector-body');
    return body?.dataset.busy === 'false'
      && document.querySelector('[data-border-toggle]')?.checked === true;
  });
  await page.waitForFunction(() => {
    const label = document.querySelector('.inspector-switch');
    const track = label?.getBoundingClientRect();
    const thumb = label?.querySelector('span')?.getBoundingClientRect();
    return track && thumb && thumb.left - track.left >= 15.5;
  });
  const switchAfter = await borderSwitch.evaluate(label => {
    const track = label.getBoundingClientRect();
    const thumb = label.querySelector('span').getBoundingClientRect();
    return { left:thumb.left - track.left, right:track.right - thumb.right };
  });
  assert.deepEqual({
    compact:switchBefore.width <= 40,
    bodyStable:inspectorBodyConnected,
    thumbStartedAtEnd:Math.abs(switchBefore.left - switchBefore.right) >= 10,
    thumbFinishedAtEnd:Math.abs(switchAfter.left - switchAfter.right) >= 10,
    thumbChangedEnd:Math.sign(switchBefore.left - switchBefore.right)
      !== Math.sign(switchAfter.left - switchAfter.right),
  }, {
    compact:true,
    bodyStable:true,
    thumbStartedAtEnd:true,
    thumbFinishedAtEnd:true,
    thumbChangedEnd:true,
  }, `开关前后几何：${JSON.stringify({ switchBefore, switchAfter })}`);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('编辑选框在 stage 滚动时始终跟随被选元素', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture.replace('</style>', `
html,body{height:100%;overflow:hidden}.stage{position:absolute;inset:0;overflow-y:auto}
</style>`),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  const frame = page.frameLocator('#deck-frame');

  await page.click('[data-mode="edit"]');
  await frame.locator('h2').first().click();
  await frame.locator('[data-transform-selection]').waitFor({ state:'visible' });
  await page.locator('#deck-frame').evaluate(async frameElement => {
    const frameWindow = frameElement.contentWindow;
    const stage = frameElement.contentDocument.querySelector('.stage');
    stage.scrollTop = 1080;
    stage.dispatchEvent(new Event('scroll'));
    await new Promise(resolve => frameWindow.requestAnimationFrame(
      () => frameWindow.requestAnimationFrame(resolve),
    ));
  });

  const alignment = await frame.locator('body').evaluate(body => {
    const target = body.querySelector('h2').getBoundingClientRect();
    const overlay = body.querySelector('[data-transform-selection]').getBoundingClientRect();
    return {
      target:{ left:target.left, top:target.top, width:target.width, height:target.height },
      overlay:{ left:overlay.left, top:overlay.top, width:overlay.width, height:overlay.height },
    };
  });
  for (const property of ['left', 'top', 'width', 'height']) {
    assert.ok(Math.abs(alignment.target[property] - alignment.overlay[property]) <= 1,
      `${property} 未对齐：${JSON.stringify(alignment)}`);
  }
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('表格单元格使用独立文字选框并可连续格式化与编辑', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture.replace(
      '<h2>第一页标题</h2>',
      '<h2>第一页标题</h2><table data-edit-table style="position:absolute;left:80px;top:260px;'
        + 'border-collapse:collapse"><tbody><tr>'
        + '<td data-edit-cell style="font-size:28px;border:1px solid #222;padding:12px">单元格文本</td>'
        + '<td style="font-size:28px;border:1px solid #222;padding:12px">相邻单元格</td>'
        + '</tr></tbody></table>',
    ),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const frame = page.frameLocator('#deck-frame');
  const cell = frame.locator('[data-edit-cell]');

  await page.click('[data-mode="edit"]');
  await cell.click();
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.textContent
    === '文字');
  assert.match(await page.locator('.inspector-object').innerText(), /TD/,
    '单击单元格时红框和属性面板必须定位到 TD，而不是整张 TABLE');

  await page.locator('[data-style-property="font-weight"]').click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  assert.equal(await cell.evaluate(element => element.style.fontWeight), '700');

  await cell.dblclick({ position:{ x:18, y:18 } });
  assert.equal(await cell.getAttribute('data-direct-editing'), '',
    '双击单元格文字应进入单元格自身的持续编辑会话');
  await cell.evaluate(element => {
    const range = document.createRange();
    range.setStart(element.firstChild, 0);
    range.setEnd(element.firstChild, 3);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  const toolbar = frame.locator('[data-text-format-toolbar]');
  await toolbar.waitFor();
  await toolbar.getByRole('button', { name:'斜体' }).click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument
    ?.getSelection()?.toString() === '单元格');
  assert.equal(await cell.locator(
    '[data-deck-text-range-style][data-deck-text-range-property="font-style"]',
  ).evaluate(element => element.style.fontStyle), 'italic');
  await cell.evaluate(element => {
    element.textContent = '已更新的单元格文本';
    element.dispatchEvent(new InputEvent('input', {
      bubbles:true, inputType:'insertText', data:'已更新的单元格文本',
    }));
  });
  await cell.press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '3');
  assert.deepEqual(await frame.locator('[data-edit-table]').evaluate(table => ({
    cells:table.querySelectorAll('td').length,
    text:table.querySelector('[data-edit-cell]').textContent,
    sibling:table.querySelectorAll('td')[1].textContent,
  })), {
    cells:2, text:'已更新的单元格文本', sibling:'相邻单元格',
  });
  const state = await session(app);
  assert.equal(state.groups[0].actions[0].target.tag, 'TD');
  assert.equal(state.groups[1].actions[0].target.tag, 'TD');
  assert.equal(state.groups[2].actions[0].target.tag, 'TD');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('编辑器按钮使用随应用加载的跨平台统一字体', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  const typography = await page.locator('[data-mode="preview"]').evaluate(async () => {
    await document.fonts.load('13px "AICO-PPT UI"', '预览编辑区域标记');
    const installed = [...document.fonts].some(face => (
      face.family.replaceAll('"', '').replaceAll("'", '') === 'AICO-PPT UI'
    ));
    return {
      loaded:installed && document.fonts.check('13px "AICO-PPT UI"', '预览编辑区域标记'),
      families:[...new Set([...document.querySelectorAll('.topbar button,.mode-button')]
        .map(element => getComputedStyle(element).fontFamily
          .split(',')[0].replaceAll('"', '').trim()))],
    };
  });
  assert.deepEqual(typography, { loaded:true, families:['AICO-PPT UI'] });
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('鼠标选中的局部文字可单独设置格式并撤销重做', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture
      .replace('</style>', '.range-layout-probe{display:inline-flex;gap:24px}</style>')
      .replace('<h2>第一页标题</h2>', '<h2 class="range-layout-probe">第一页标题</h2>'),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const card = page.frameLocator('#deck-frame').locator('.card').first();

  const cardTarget = await card.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  const unrelated = await fetch(`${app.url}/api/actions?token=${app.token}`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      expectedRevision:0,
      taskId:null,
      actions:[{
        id:'unrelated-text-edit', taskId:null, target:cardTarget,
        kind:'setText', payload:{ text:'无关内容保留' },
      }],
    }),
  });
  assert.equal(unrelated.status, 200, await unrelated.text());
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument
    ?.querySelector('.card')?.textContent === '无关内容保留');

  await page.click('[data-mode="edit"]');
  await heading.dblclick();
  await heading.evaluate(element => {
    const textNode = element.firstChild;
    const range = document.createRange();
    range.setStart(textNode, 1);
    range.setEnd(textNode, 3);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.textContent
    === '选中文字');
  assert.match(await page.locator('.inspector-object').innerText(), /“一页”/);
  assert.equal(await page.locator('[data-inspector-group="appearance"]').count(), 1);
  assert.equal(await page.locator('[data-inspector-group="more"]').count(), 0);
  assert.equal(await page.locator('[data-style-property="color"]').count(), 1);
  assert.equal(await page.locator('[data-border-toggle]').count(), 0);
  assert.equal(await page.locator('[data-value-property="opacity"]').count(), 0);

  const bold = page.locator('[data-style-property="font-weight"]');
  assert.equal(await bold.getAttribute('aria-pressed'), 'true');
  await bold.click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  await heading.locator('[data-deck-text-range-style]').waitFor();
  assert.equal(await heading.locator('[data-deck-text-range-style]').textContent(), '一页');
  assert.equal(await heading.locator('[data-deck-text-range-style]')
    .evaluate(element => element.style.fontWeight), '400');
  await page.waitForFunction(() => {
    const editor = document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2');
    const selection = document.querySelector('#deck-frame')?.contentDocument?.getSelection();
    return editor?.hasAttribute('data-direct-editing')
      && selection?.rangeCount === 1 && !selection.isCollapsed
      && selection.toString() === '一页'
      && editor.ownerDocument.activeElement === editor;
  });
  const afterApply = await session(app);
  assert.deepEqual(afterApply.groups[1].actions[0].payload.textRange, { start:1, end:3 });

  const selectedRunGap = await heading.evaluate(element => {
    const run = element.querySelector('[data-deck-text-range-style]');
    const before = document.createRange();
    before.setStart(element.firstChild, element.firstChild.length - 1);
    before.setEnd(element.firstChild, element.firstChild.length);
    const selected = document.createRange();
    selected.setStart(run.firstChild, 0);
    selected.setEnd(run.firstChild, 1);
    return selected.getBoundingClientRect().left - before.getBoundingClientRect().right;
  });

  await heading.locator('[data-deck-text-range-style]').dblclick();
  assert.equal(await heading.getAttribute('data-direct-editing'), '',
    '局部格式不应把文字盒拆成独立编辑范围');
  await heading.evaluate(element => {
    const textNode = element.querySelector('[data-deck-text-range-style]').firstChild;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.length);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.textContent
    === '选中文字');
  await bold.click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '3');
  const afterRepeatedFormat = await session(app);
  assert.equal(afterRepeatedFormat.groups[2].actions[0].target.tag, 'H2');
  assert.deepEqual(afterRepeatedFormat.groups[2].actions[0].payload.textRange, { start:1, end:3 });
  const repeatedFormat = {
    selectedRunGap,
    cardText:await card.textContent(),
    headingText:await heading.textContent(),
    runCount:await heading.locator('[data-deck-text-range-style]').count(),
    weight:await heading.evaluate(element => getComputedStyle(
      element.querySelector('[data-deck-text-range-style]') ?? element,
    ).fontWeight),
  };
  assert.deepEqual(repeatedFormat, {
    selectedRunGap:0,
    cardText:'无关内容保留',
    headingText:'第一页标题',
    runCount:0,
    weight:'700',
  });

  await page.locator('[data-history-undo]').click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '4');
  assert.equal(await heading.locator('[data-deck-text-range-style]')
    .evaluate(element => element.style.fontWeight), '400');

  await page.locator('[data-history-redo]').click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '5');
  await page.waitForFunction(() => {
    const headingElement = document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2');
    return headingElement && !headingElement.querySelector('[data-deck-text-range-style]')
      && getComputedStyle(headingElement).fontWeight === '700';
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '5');
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument
    ?.querySelector('.card')?.textContent === '无关内容保留');
  const restoredHeading = page.frameLocator('#deck-frame').locator('h2').first();
  await restoredHeading.waitFor();
  assert.equal(await restoredHeading.locator('[data-deck-text-range-style]').count(), 0);
  assert.equal(await restoredHeading.evaluate(element => getComputedStyle(element).fontWeight), '700');
  assert.equal(await page.frameLocator('#deck-frame').locator('.card').first().textContent(), '无关内容保留');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('历史中以局部格式包装为目标的动作可在重开后恢复且撤销不展开 Agent 面板', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const rootTarget = await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));

  const postAction = async (expectedRevision, action) => {
    const response = await fetch(`${app.url}/api/actions?token=${app.token}`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ expectedRevision, taskId:null, actions:[action] }),
    });
    assert.equal(response.status, 200, await response.text());
  };
  await postAction(0, {
    id:'root-range-weight', taskId:null, target:rootTarget, kind:'setStyle',
    payload:{ property:'font-weight', value:'400', textRange:{ start:0, end:2 } },
  });
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  const wrapper = heading.locator('[data-deck-text-range-style]');
  await wrapper.waitFor();
  const wrapperTarget = await wrapper.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  await postAction(1, {
    id:'nested-range-weight', taskId:null, target:wrapperTarget, kind:'setStyle',
    payload:{ property:'font-weight', value:'700', textRange:{ start:0, end:2 } },
  });
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');

  await page.reload();
  await page.waitForSelector('[data-page-key]');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  await page.waitForTimeout(150);
  const frameError = await page.frameLocator('#deck-frame').locator('[data-direct-status]').textContent()
    .catch(() => '');

  await page.locator('[data-current-page]').click();
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '3');
  await page.waitForFunction(() => document.querySelector('.history-controls')?.dataset.busy === 'false');
  assert.deepEqual({
    frameError,
    taskDrawerOpen:await page.locator('[data-task-drawer]').getAttribute('data-open'),
  }, {
    frameError:'',
    taskDrawerOpen:'false',
  });
});

test('真实 bundle 等固化基线落稳后再恢复局部格式动作', async t => {
  const app = await startFixtureServer({
    bundle:true,
    fixtureTransform:fixture => fixture.replace('</body>', `<script>
window.HuaweiDeckEditorPatchStatus={state:'waiting',expected:1,applied:0,adopted:0,error:null};
setTimeout(()=>{
  const runtime=window.HuaweiDeckPatchRuntime;
  const heading=document.querySelector('h2');
  const target=runtime.makeLocator(heading);
  const results=runtime.applyAll([{
    id:'solidified-font-baseline',taskId:null,target,kind:'setStyle',
    payload:{property:'font-family',value:'serif'},
  }]);
  window.HuaweiDeckEditorPatchStatus.applied=results.length;
  window.HuaweiDeckEditorPatchStatus.adopted=runtime.adoptActiveAsBaseline();
  window.HuaweiDeckEditorPatchStatus.state='applied';
},260);
</script></body>`),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();

  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentWindow
    ?.HuaweiDeckEditorPatchStatus?.state === 'applied');
  const target = await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  const response = await fetch(`${app.url}/api/actions?token=${app.token}`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      expectedRevision:0,
      taskId:null,
      actions:[{
        id:'active-range-color', taskId:null, target, kind:'setStyle',
        payload:{ property:'color', value:'red', textRange:{ start:1, end:3 } },
      }],
    }),
  });
  assert.equal(response.status, 200, await response.text());
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  await heading.locator('[data-deck-text-range-style]').waitFor();

  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentWindow
    ?.HuaweiDeckEditorPatchStatus?.state === 'applied');
  await page.waitForTimeout(120);

  const restored = await page.locator('#deck-frame').evaluate(frame => {
    const status = frame.contentDocument.querySelector('[data-direct-status]');
    const range = frame.contentDocument.querySelector('[data-deck-text-range-style]');
    return {
      error:status?.textContent ?? '',
      color:range ? frame.contentWindow.getComputedStyle(range).color : null,
    };
  });
  assert.deepEqual(restored, { error:'', color:'rgb(255, 0, 0)' });
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('文字格式快捷键支持局部选区和整个文本框', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture.replace(
      '<h2>第一页标题</h2>',
      '<h2 style="font-weight:400;font-style:normal;text-decoration-line:none">第一页标题</h2>',
    ),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();

  await page.click('[data-mode="edit"]');
  await heading.dblclick();
  await heading.evaluate(element => {
    const range = document.createRange();
    range.setStart(element.firstChild, 0);
    range.setEnd(element.firstChild, 2);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.textContent
    === '选中文字');
  for (const [shortcut, revision] of [['Control+b', 1], ['Control+i', 2], ['Control+u', 3]]) {
    await heading.press(shortcut);
    await page.waitForFunction(expected => (
      document.querySelector('[data-revision]')?.textContent === String(expected)
    ), revision);
    await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument
      ?.getSelection()?.toString() === '第一');
  }
  assert.deepEqual(await heading.evaluate(element => ({
    editing:element.hasAttribute('data-direct-editing'),
    selected:document.getSelection()?.toString(),
    rangeStyles:Object.fromEntries([...element.querySelectorAll('[data-deck-text-range-style]')]
      .map(wrapper => [wrapper.dataset.deckTextRangeProperty,
        wrapper.style.getPropertyValue(wrapper.dataset.deckTextRangeProperty)])),
  })), {
    editing:true,
    selected:'第一',
    rangeStyles:{
      'font-weight':'700',
      'font-style':'italic',
      'text-decoration-line':'underline',
    },
  });

  await heading.press('Escape');
  await heading.click();
  await heading.press('Control+i');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '4');
  assert.deepEqual(await heading.evaluate(element => {
    const values = new Set();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (walker.currentNode.data.length) {
        values.add(getComputedStyle(walker.currentNode.parentElement ?? element).fontStyle);
      }
    }
    return [...values];
  }), ['italic']);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('跨越不同格式的文字选区显示混合态并可统一格式', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture.replace(
      '<h2>第一页标题</h2>',
      '<h2 style="font-weight:400">第一页标题</h2>',
    ),
  });
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();

  await page.click('[data-mode="edit"]');
  await heading.dblclick();
  const selectRange = (start, end) => heading.evaluate((element, offsets) => {
    const nodes = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const point = absolute => {
      let consumed = 0;
      for (const node of nodes) {
        if (absolute <= consumed + node.data.length) {
          return { node, offset:absolute - consumed };
        }
        consumed += node.data.length;
      }
      throw new Error('选区越界');
    };
    const from = point(offsets.start);
    const to = point(offsets.end);
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, { start, end });
  await selectRange(0, 2);
  await heading.press('Control+b');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument
    ?.getSelection()?.toString() === '第一');

  await selectRange(0, 5);
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.textContent
    === '选中文字');
  const bold = page.locator('[data-style-property="font-weight"]');
  assert.equal(await bold.getAttribute('aria-pressed'), 'mixed');
  await bold.click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  const unified = await heading.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const runs = [];
    while (walker.nextNode()) {
      if (walker.currentNode.data.length === 0) continue;
      runs.push({
        text:walker.currentNode.data,
        weight:getComputedStyle(walker.currentNode.parentElement).fontWeight,
      });
    }
    return { weights:[...new Set(runs.map(run => run.weight))].join(','), runs, html:element.innerHTML };
  });
  const mixedState = await session(app);
  assert.equal(unified.weights, '700', JSON.stringify({
    html:unified.html, runs:unified.runs,
    actions:mixedState.groups.map(group => group.actions.map(action => action.payload)),
  }));
});

test('局部混合格式后重新选中整个文本框仍可连续修改全部文字格式', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture.replace(
      '<h2>第一页标题</h2>',
      '<h2 style="font-family:Arial;font-size:48px;font-style:normal;font-weight:400;'
        + 'text-decoration-line:none;color:#111111;text-align:left;line-height:1.2">第一页标题</h2>',
    ),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();

  await page.click('[data-mode="edit"]');
  await heading.dblclick();
  await heading.evaluate(element => {
    const range = document.createRange();
    range.setStart(element.firstChild, 0);
    range.setEnd(element.firstChild, 2);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.textContent
    === '选中文字');
  await page.locator('[data-style-property="font-weight"]').click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  await page.locator('[data-style-property="color"]').evaluate(input => {
    input.value = '#c7000b';
    input.dispatchEvent(new Event('change', { bubbles:true }));
  });
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  await page.waitForFunction(() => document.querySelector('.inspector-body')?.dataset.busy === 'false');
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument
    ?.getSelection()?.toString() === '第一');

  await heading.press('Escape');
  await heading.click();
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.textContent
    === '文字');
  assert.equal(await page.locator('[data-style-property="font-weight"]').getAttribute('aria-pressed'),
    'mixed', '整框选中时也必须识别内部混合字重');
  const applyAndWait = async (revision, callback) => {
    await callback();
    await page.waitForFunction(expected => (
      document.querySelector('[data-revision]')?.textContent === String(expected)
    ), revision);
    await page.waitForFunction(() => document.querySelector('.inspector-body')?.dataset.busy === 'false');
  };
  const selectInspectorFont = async name => {
    await page.getByRole('combobox', { name:'字体' }).click();
    await page.getByRole('option', { name }).click();
  };
  await applyAndWait(3, () => page.locator('[data-style-property="font-weight"]').click());
  await applyAndWait(4, () => page.locator('[data-style-property="color"]').evaluate(input => {
    input.value = '#123456';
    input.dispatchEvent(new Event('change', { bubbles:true }));
  }));
  await applyAndWait(5, () => selectInspectorFont('Times New Roman'));
  await applyAndWait(6, () => page.locator('[data-style-property="font-style"]').click());
  await applyAndWait(7, () => page.locator('[data-style-property="text-decoration-line"]').click());
  await page.locator('[data-inspector-group-trigger="paragraph"]').click();
  await applyAndWait(8, () => page.locator('[data-paragraph-align="center"]').click());
  await applyAndWait(9, () => page.locator('[data-value-property="font-size"]').evaluate(input => {
    input.value = '54';
    input.dispatchEvent(new Event('change', { bubbles:true }));
  }));
  await applyAndWait(10, () => page.locator('[data-value-property="line-height"]').evaluate(input => {
    input.value = '1.5';
    input.dispatchEvent(new Event('change', { bubbles:true }));
  }));

  const wholeBoxStyles = await heading.evaluate(element => {
    const runs = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!walker.currentNode.data.length) continue;
      const computed = getComputedStyle(walker.currentNode.parentElement ?? element);
      let decorated = false;
      for (let owner = walker.currentNode.parentElement; owner; owner = owner.parentElement) {
        decorated ||= getComputedStyle(owner).textDecorationLine.split(/\s+/).includes('underline');
        if (owner === element) break;
      }
      runs.push({
        weight:computed.fontWeight, color:computed.color,
        family:computed.fontFamily.split(',')[0].replaceAll('"', '').trim(),
        size:computed.fontSize, style:computed.fontStyle,
        decoration:decorated ? 'underline' : 'none',
      });
    }
    return {
      runs:[...new Set(runs.map(run => JSON.stringify(run)))].map(run => JSON.parse(run)),
      align:element.style.textAlign, lineHeight:element.style.lineHeight,
      text:element.textContent,
    };
  });
  assert.deepEqual(wholeBoxStyles, {
    runs:[{
      weight:'700', color:'rgb(18, 52, 86)', family:'Times New Roman',
      size:'54px', style:'italic', decoration:'underline',
    }],
    align:'center', lineHeight:'1.5', text:'第一页标题',
  });
  assert.equal(await page.frameLocator('#deck-frame')
    .locator('[data-direct-status][data-state="error"]').count(), 0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('文字选区浮动工具条的色块显示当前选区颜色', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture.replace(
      '<h2>第一页标题</h2>',
      '<h2 style="color:#123456">第一页标题</h2>',
    ),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();

  await page.click('[data-mode="edit"]');
  await heading.dblclick();
  await heading.evaluate(element => {
    const range = document.createRange();
    range.setStart(element.firstChild, 0);
    range.setEnd(element.firstChild, 2);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  const color = page.frameLocator('#deck-frame')
    .locator('[data-text-format-toolbar]')
    .getByRole('button', { name:'文字颜色' });
  await color.waitFor();
  assert.deepEqual(await color.evaluate(element => ({
    inputValue:element.parentElement.querySelector('input').value,
    inlineColor:element.style.getPropertyValue('--ui-color'),
    computedVariable:getComputedStyle(element).getPropertyValue('--ui-color').trim(),
    backgroundColor:getComputedStyle(element).backgroundColor,
  })), {
    inputValue:'#123456',
    inlineColor:'#123456',
    computedVariable:'#123456',
    backgroundColor:'rgb(18, 52, 86)',
  });
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('文字选区浮动工具条可连续调节字号并合并为一次撤销', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture.replace(
      '<h2>第一页标题</h2>',
      '<h2 style="font-size:22px">From individual troubleshooting to a reusable delivery system</h2>',
    ),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(8_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();

  await page.click('[data-mode="edit"]');
  await heading.dblclick();
  await heading.evaluate(element => {
    const range = document.createRange();
    range.setStart(element.firstChild, 0);
    range.setEnd(element.firstChild, element.firstChild.data.length);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  const decrease = frame.getByRole('button', { name:'字号减小' });
  await decrease.waitFor();

  // 用户可以连续点按，三次应从 22px 依次变成 21/20/19px，而不是重复提交 21px。
  await decrease.click();
  await decrease.click();
  await decrease.click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '3');
  await page.waitForFunction(() => document.querySelector('.inspector-body')?.dataset.busy === 'false');

  const current = await session(app);
  assert.deepEqual({
    groups:current.groups.length,
    actions:current.groups[0]?.actions.length,
    size:await heading.evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.data.length > 0) {
          return getComputedStyle(walker.currentNode.parentElement ?? element).fontSize;
        }
      }
      return getComputedStyle(element).fontSize;
    }),
    text:await heading.textContent(),
  }, {
    groups:1,
    actions:3,
    size:'19px',
    text:'From individual troubleshooting to a reusable delivery system',
  });
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('文字选区格式化后快捷撤销走编辑器历史且不破坏文字结构', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture.replace(
      '<h2>第一页标题</h2>',
      '<h2 style="font-size:22px"><span>From individual troubleshooting</span> to a reusable delivery system</h2>',
    ),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(8_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();

  await page.click('[data-mode="edit"]');
  await heading.dblclick();
  await heading.evaluate(element => {
    const range = document.createRange();
    const text = element.querySelector('span').firstChild;
    range.setStart(text, 0);
    range.setEnd(text, text.data.length);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await frame.getByRole('button', { name:'字号减小' }).click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');

  await heading.press('Control+z');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  const current = await session(app);
  assert.deepEqual({
    groups:current.groups.length,
    redo:current.redo.length,
    text:await heading.textContent(),
    childText:await heading.locator('span').first().textContent(),
  }, {
    groups:1,
    redo:1,
    text:'From individual troubleshooting to a reusable delivery system',
    childText:'From individual troubleshooting',
  });
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('富文本结构变化只提交差异范围且撤销可恢复原节点', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture.replace(
      '<h2>第一页标题</h2>',
      '<h2><span>CAPABILITY FORMED</span><strong>From individual troubleshooting</strong><em>Platform coordinates work</em></h2>',
    ),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(8_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();

  await page.click('[data-mode="edit"]');
  await heading.dblclick();
  await heading.evaluate(element => {
    element.textContent = 'CAPABILITY FORMEDPlatform coordinates work';
    element.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'deleteContentBackward' }));
  });
  await heading.press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');

  const afterEdit = await session(app);
  assert.deepEqual({
    text:await heading.textContent(),
    sourceRange:afterEdit.groups[0]?.actions[0]?.payload?.sourceRange,
    wholeText:afterEdit.groups[0]?.actions[0]?.payload?.text,
  }, {
    text:'CAPABILITY FORMEDPlatform coordinates work',
    sourceRange:{ start:17, end:48 },
    wholeText:'',
  });

  await page.locator('[data-history-undo]').click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  assert.deepEqual(await heading.evaluate(element => ({
    text:element.textContent,
    children:[...element.children].map(child => ({ tag:child.tagName, text:child.textContent })),
  })), {
    text:'CAPABILITY FORMEDFrom individual troubleshootingPlatform coordinates work',
    children:[
      { tag:'SPAN', text:'CAPABILITY FORMED' },
      { tag:'STRONG', text:'From individual troubleshooting' },
      { tag:'EM', text:'Platform coordinates work' },
    ],
  });
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('连续调整同一字号合并为一个可撤销历史组', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture.replace(
      '<h2>第一页标题</h2>', '<h2 style="font-size:48px">第一页标题</h2>',
    ),
  });
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();

  await page.click('[data-mode="edit"]');
  await heading.click();
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.textContent
    === '文字');
  for (const [revision, size] of ['53', '52', '51'].entries()) {
    await page.locator('[data-value-property="font-size"]').evaluate((input, value) => {
      input.value = value;
      input.dispatchEvent(new Event('change', { bubbles:true }));
    }, size);
    await page.waitForFunction(expected => (
      document.querySelector('[data-revision]')?.textContent === String(expected)
    ), revision + 1);
    await page.waitForFunction(() => document.querySelector('.inspector-body')?.dataset.busy === 'false');
  }
  const afterSizes = await session(app);
  assert.deepEqual({
    groups:afterSizes.groups.length,
    actions:afterSizes.groups[0]?.actions.length,
    size:await heading.evaluate(element => element.style.fontSize),
  }, { groups:1, actions:3, size:'51px' });

  await page.locator('[data-history-undo]').click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '4');
  assert.equal(await heading.evaluate(element => element.style.fontSize), '48px');
  await page.locator('[data-history-redo]').click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '5');
  assert.equal(await heading.evaluate(element => element.style.fontSize), '51px');
});

test('文字面板提供常用字形与段落控件，选区旁显示快捷工具条', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture.replace(
      '<h2>第一页标题</h2>',
      '<h2 style="font-style:normal;text-decoration-line:none;text-align:left;line-height:1.2">第一页标题</h2>',
    ),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();

  await page.click('[data-mode="edit"]');
  await heading.click();
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.textContent
    === '文字');
  await page.getByRole('combobox', { name:'字体' }).click();
  await page.getByRole('option', { name:'Arial' }).click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  await page.locator('[data-style-property="font-style"]').click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  await page.locator('[data-style-property="text-decoration-line"]').click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '3');
  await page.locator('[data-inspector-group-trigger="paragraph"]').click();
  await page.locator('[data-paragraph-align="center"]').click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '4');
  await page.locator('[data-list-toggle]').click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '5');
  await page.locator('[data-value-property="line-height"]').evaluate(input => {
    input.value = '1.5';
    input.dispatchEvent(new Event('change', { bubbles:true }));
  });
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '6');
  assert.deepEqual(await heading.evaluate(element => ({
    fontFamily:element.style.fontFamily,
    fontStyle:element.style.fontStyle,
    decoration:element.style.textDecorationLine,
    align:element.style.textAlign,
    display:element.style.display,
    listStyle:element.style.listStyleType,
    listPosition:element.style.listStylePosition,
    lineHeight:element.style.lineHeight,
  })), {
    fontFamily:'Arial', fontStyle:'italic', decoration:'underline', align:'center',
    display:'list-item', listStyle:'disc', listPosition:'inside', lineHeight:'1.5',
  });

  await heading.dblclick();
  await heading.evaluate(element => {
    const range = document.createRange();
    range.setStart(element.firstChild, 0);
    range.setEnd(element.firstChild, 2);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.textContent
    === '选中文字');
  const toolbar = page.frameLocator('#deck-frame').locator('[data-text-format-toolbar]');
  await toolbar.waitFor();
  assert.deepEqual(await toolbar.locator('button').evaluateAll(buttons => (
    buttons.map(button => button.getAttribute('aria-label'))
  )), ['字体', '加粗', '斜体', '下划线', '字号减小', '字号增大', '文字颜色', '左对齐', '居中', '右对齐']);
  assert.equal(await toolbar.getByRole('combobox', { name:'字体' }).count(), 1);
  assert.equal(await toolbar.getByRole('button', { name:'文字颜色' }).count(), 1);
  await toolbar.getByRole('button', { name:'文字颜色' }).click();
  const colorDialog = page.frameLocator('#deck-frame').getByRole('dialog', { name:'文字颜色' });
  await colorDialog.waitFor();
  await page.waitForTimeout(80);
  assert.equal(await toolbar.isVisible(), true);
  assert.equal(await colorDialog.isVisible(), true);
  await toolbar.getByRole('button', { name:'文字颜色' }).click();
  await colorDialog.waitFor({ state:'hidden' });
  assert.equal(await toolbar.isVisible(), true);
  await toolbar.locator('button[aria-label="加粗"]').click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '7');
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument
    ?.getSelection()?.toString() === '第一');
  assert.equal(await heading.locator(
    '[data-deck-text-range-style][data-deck-text-range-property="font-weight"]',
  ).evaluate(element => element.style.fontWeight), '400');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});
