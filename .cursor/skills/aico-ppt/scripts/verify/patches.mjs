#!/usr/bin/env node
// patches.mjs — 验证单文件 Deck 内嵌 Editor 补丁是否全部成功重放。

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadChromium, chromiumLaunchOptions } from './load-playwright.mjs';

const [deckFile, mode] = process.argv.slice(2);
if (!deckFile) {
  console.error('用法: node scripts/verify/patches.mjs <deck.html> [--repair-missing]');
  process.exit(2);
}
if (mode !== undefined && mode !== '--repair-missing') {
  console.error('补丁验证参数无效');
  process.exit(2);
}
if (!existsSync(deckFile)) {
  console.error(`找不到 deck 文件: ${deckFile}`);
  process.exit(2);
}
let droppableActionIds = [];
if (mode === '--repair-missing') {
  try {
    const request = JSON.parse(readFileSync(0, 'utf8'));
    droppableActionIds = request?.droppableActionIds;
    if (!Array.isArray(droppableActionIds)
      || droppableActionIds.some(id => typeof id !== 'string' || !id)
      || new Set(droppableActionIds).size !== droppableActionIds.length) {
      throw new Error('droppableActionIds 必须是唯一非空字符串数组');
    }
  } catch (error) {
    console.error(`补丁批量修复输入无效：${error.message}`);
    process.exit(2);
  }
}

let chromium;
try {
  chromium = await loadChromium();
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

let browser;
let exitCode = 0;
try {
  browser = await chromium.launch(chromiumLaunchOptions());
  const page = await browser.newPage({
    viewport:{ width:1920, height:1080 }, deviceScaleFactor:1,
  });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push({
    name:error.name, message:error.message, code:error.code ?? null,
  }));
  await page.goto(pathToFileURL(deckFile).href, {
    waitUntil:'load', timeout:180_000,
  });
  const initial = await page.evaluate(() => ({
    hasPatches:Boolean(document.getElementById('huawei-deck-editor-patches')),
    hasStatus:Boolean(window.HuaweiDeckEditorPatchStatus),
  }));
  if (initial.hasPatches && !initial.hasStatus) {
    await page.waitForTimeout(1_000);
    const legacy = await page.evaluate(() => !window.HuaweiDeckEditorPatchStatus);
    if (legacy) {
      console.log(JSON.stringify({
        state:'legacy-unobservable', expected:null, applied:null, adopted:null,
        error:{
          code:'PATCH_STATUS_MISSING',
          message:'旧版补丁区块未公开重放状态；请先用当前共享模块重建候选文件',
        },
        pageErrors,
      }, null, 2));
      exitCode = 1;
      process.exitCode = exitCode;
      throw Object.assign(new Error('PATCH_STATUS_MISSING_REPORTED'), { reported:true });
    }
  }
  await page.waitForFunction(() => (
    !document.getElementById('huawei-deck-editor-patches')
    || ['applied', 'failed'].includes(window.HuaweiDeckEditorPatchStatus?.state)
  ), undefined, { timeout:90_000 });
  let result = await page.evaluate(() => {
    const script = document.getElementById('huawei-deck-editor-patches');
    if (!script) return { state:'absent', expected:0, applied:0, adopted:0, error:null };
    return structuredClone(window.HuaweiDeckEditorPatchStatus ?? {
      state:'missing-status', expected:null, applied:null, adopted:null,
      error:{ code:'PATCH_STATUS_MISSING', message:'补丁区块未公开重放状态' },
    });
  });
  if (mode === '--repair-missing' && result.state === 'failed') {
    result = await page.evaluate(ids => {
      const script = document.getElementById('huawei-deck-editor-patches');
      const runtime = window.HuaweiDeckPatchRuntime;
      if (!script || typeof runtime?.applyAll !== 'function') {
        return {
          state:'failed', expected:null, applied:0, adopted:0,
          error:{ code:'PATCH_REPAIR_UNAVAILABLE', message:'当前补丁运行时不支持批量修复' },
          droppedActionIds:[],
        };
      }
      try {
        const patches = JSON.parse(script.textContent);
        const repaired = typeof runtime.applyAllDroppingMissing === 'function'
          ? runtime.applyAllDroppingMissing(patches, { rebaseActionIds:ids })
          : (() => {
            // 历史候选可能仍内嵌修复前的 runtime。旧 applyAll 已保证失败原子
            // 回滚，因此验证器可在同一页面逐条剔除受控缺失动作，无需重启 Chrome。
            const droppable = new Set(ids);
            const effectiveActions = [...patches];
            const droppedActionIds = [];
            while (true) {
              try {
                return {
                  results:runtime.applyAll(effectiveActions, { rebaseActionIds:ids }),
                  effectiveActions:[...effectiveActions],
                  droppedActionIds:[...droppedActionIds],
                };
              } catch (error) {
                const failedActionId = error?.failedActionId;
                const canDrop = ['PAGE_NOT_FOUND', 'TARGET_NOT_FOUND'].includes(error?.code)
                  && typeof failedActionId === 'string' && droppable.has(failedActionId);
                const failedIndex = canDrop
                  ? effectiveActions.findIndex(action => action?.id === failedActionId) : -1;
                if (failedIndex < 0) throw error;
                effectiveActions.splice(failedIndex, 1);
                droppedActionIds.push(failedActionId);
              }
            }
          })();
        const adopted = runtime.adoptActiveAsBaseline();
        return {
          state:'applied', expected:repaired.effectiveActions.length,
          applied:repaired.results.length, adopted, error:null,
          droppedActionIds:repaired.droppedActionIds,
        };
      } catch (error) {
        return {
          state:'failed', expected:null, applied:0, adopted:0,
          error:{
            code:String(error?.code ?? 'PATCH_APPLY_FAILED'),
            message:String(error?.message ?? error),
            failedActionId:String(error?.failedActionId ?? ''),
          },
          droppedActionIds:[],
        };
      }
    }, droppableActionIds);
  }
  const valid = result.state === 'absent' || (
    result.state === 'applied'
    && result.applied === result.expected
    && result.adopted === result.expected
  );
  console.log(JSON.stringify({
    ...result,
    droppedActionIds:Array.isArray(result.droppedActionIds) ? result.droppedActionIds : [],
    pageErrors,
  }, null, 2));
  if (!valid) exitCode = 1;
} catch (error) {
  if (!error?.reported) {
    console.error(`补丁验证基础设施失败：${error?.message ?? error}`);
    exitCode = 2;
  }
} finally {
  await browser?.close().catch(() => {});
}

process.exit(exitCode);
