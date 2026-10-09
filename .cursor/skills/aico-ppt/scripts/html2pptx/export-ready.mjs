/** 图片与可编辑导出共用同一就绪条件；补丁失败时禁止导出回滚后的旧内容。 */
export async function prepareExportPage(page, { patchTimeoutMs = 90_000 } = {}) {
  await page.waitForSelector('.stage .slide-canvas', { timeout:30_000 });
  let timedOut = false;
  try {
    await page.waitForFunction(() => (
      !document.getElementById('huawei-deck-editor-patches')
      || ['applied', 'failed'].includes(window.HuaweiDeckEditorPatchStatus?.state)
    ), undefined, { timeout:patchTimeoutMs });
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    timedOut = true;
  }
  const replay = await page.evaluate(() => {
    const script = document.getElementById('huawei-deck-editor-patches');
    if (!script) return null;
    try {
      const patches = JSON.parse(script.textContent);
      if (!Array.isArray(patches)) throw new Error('补丁必须是数组');
      return { count:patches.length, status:window.HuaweiDeckEditorPatchStatus ?? null };
    } catch (error) { return { count:null, status:{ state:'failed', error:{ message:error.message } } }; }
  });
  if (replay && (timedOut || replay.status?.state !== 'applied'
    || replay.status.expected !== replay.count || replay.status.applied !== replay.count
    || replay.status.adopted !== replay.count)) {
    const error = replay.status?.error;
    const reason = error?.message || (timedOut ? '等待补丁应用超时' : '补丁应用数量不完整');
    throw Object.assign(new Error(`PPTX 导出已中止：补丁未完整应用（${reason}${error?.failedActionId ? `；补丁 ${error.failedActionId}` : ''}）。请在编辑器中修复后重试。`), { code:'PPTX_PATCH_REPLAY_FAILED' });
  }
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.addStyleTag({ content:`
    .glassbar.railtoggle,.glassbar.navbar,.glassbar.modebar,.railpanel,.railfoot,.hint,.noteschip,#__deck_loading_overlay,#__bundler_loading{display:none!important}
    img[alt="HUAWEI"],img[data-brand-logo]{right:30px!important}
    .slide-canvas *{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}
    /* 普通渐显展示终态；不用 !important，保留补丁写入的内联透明度与变换。 */
    .slide-canvas .build{opacity:1;transform:none;filter:none}
  ` });
  await page.evaluate(() => {
    document.querySelectorAll('.slide-canvas .build').forEach(el => el.classList.add('in', 'show', 'visible'));
    document.querySelectorAll('.slide-canvas svg').forEach(svg => svg.pauseAnimations?.());
  });
}
