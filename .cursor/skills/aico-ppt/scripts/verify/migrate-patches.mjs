#!/usr/bin/env node
// migrate-patches.mjs — 在未应用补丁的候选 Deck 上严格迁移 locator.pageKey。

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadChromium, chromiumLaunchOptions } from './load-playwright.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const [deckFile, inputFile, outputFile] = process.argv.slice(2);
if (![deckFile, inputFile, outputFile].every(Boolean)) {
  console.error('用法: node scripts/verify/migrate-patches.mjs <deck.html> <patches.json> <out.json>');
  process.exit(2);
}
if (!existsSync(deckFile) || !existsSync(inputFile)) {
  console.error('候选 Deck 或补丁 JSON 不存在');
  process.exit(2);
}

let patches;
try {
  patches = JSON.parse(await readFile(inputFile, 'utf8'));
  if (!Array.isArray(patches) || patches.some(action => !action || typeof action !== 'object')) {
    throw new Error('顶层必须是对象数组');
  }
} catch (error) {
  console.error(`补丁 JSON 无效：${error.message}`);
  process.exit(2);
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
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(pathToFileURL(deckFile).href, { waitUntil:'load', timeout:180_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.stage .slide-canvas').length > 0,
    undefined,
    { timeout:60_000 },
  );
  await page.addScriptTag({
    path:resolve(SCRIPT_DIR, '../editor/runtime/patch-runtime.js'),
  });
  const result = await page.evaluate(actions => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const canvases = [...document.querySelectorAll('.stage .slide-canvas')];
    const pages = canvases.map((canvas, index) => ({
      index:index + 1,
      pageKey:runtime.pageKey(canvas),
      label:canvas.querySelector('section[data-label]')?.dataset.label ?? '',
    }));
    const cache = new Map();
    const failures = [];
    let migratedCount = 0;
    const migrated = actions.map(action => {
      const target = action.target;
      if (!target || typeof target.pageKey !== 'string') {
        failures.push({ actionId:action.id ?? null, code:'INVALID_TARGET' });
        return action;
      }
      const identity = [
        target.pageKey,
        target.editorId ?? '',
        target.path,
        target.tag,
        target.fingerprint,
      ].join('\0');
      if (cache.has(identity)) {
        const pageKey = cache.get(identity);
        if (pageKey !== target.pageKey) migratedCount += 1;
        return { ...action, target:{ ...target, pageKey } };
      }
      const matches = [];
      for (const candidatePage of pages) {
        const candidate = { ...target, pageKey:candidatePage.pageKey };
        try {
          runtime.resolve(candidate);
          matches.push(candidatePage);
        } catch { /* 严格 path/tag/fingerprint 不匹配。 */ }
      }
      if (matches.length !== 1) {
        failures.push({
          actionId:action.id ?? null,
          oldPageKey:target.pageKey,
          path:target.path,
          tag:target.tag,
          fingerprint:target.fingerprint,
          code:matches.length ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND',
          candidates:matches,
        });
        return action;
      }
      const pageKey = matches[0].pageKey;
      cache.set(identity, pageKey);
      if (pageKey !== target.pageKey) migratedCount += 1;
      return { ...action, target:{ ...target, pageKey } };
    });
    return { migrated, migratedCount, failures, pages };
  }, patches);
  if (pageErrors.length) {
    console.error(JSON.stringify({ code:'CANDIDATE_PAGE_ERROR', pageErrors }, null, 2));
    exitCode = 1;
  } else if (result.failures.length) {
    console.error(JSON.stringify({
      code:'PATCH_MIGRATION_FAILED', failures:result.failures, pages:result.pages,
    }, null, 2));
    exitCode = 1;
  } else {
    await writeFile(outputFile, JSON.stringify(result.migrated), 'utf8');
    console.log(JSON.stringify({
      state:'migrated', total:result.migrated.length,
      changed:result.migratedCount, pages:result.pages.length,
    }));
  }
} catch (error) {
  console.error(`补丁迁移基础设施失败：${error?.message ?? error}`);
  exitCode = 2;
} finally {
  await browser?.close().catch(() => {});
}

process.exit(exitCode);
