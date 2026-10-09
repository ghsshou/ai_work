import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { startHeadlessEditorRuntime } from '../headless-editor-runtime.mjs';
import { startFixtureServer } from './test-helpers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = join(ROOT, 'scripts/editor/cli.mjs');

function runCli(app, args) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd:ROOT,
    stdio:['ignore', 'pipe', 'pipe'],
    env:{
      ...process.env,
      AICO_PPT_EDITOR_URL:app.url,
      AICO_PPT_EDITOR_TOKEN:app.token,
      AICO_PPT_WORKSPACE_CAPABILITY_FILE:'',
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) reject(new Error(`CLI ${args[0]} 失败：${stderr}`));
      else resolvePromise(JSON.parse(stdout));
    });
  });
}

test('无窗口 Skill 修改实时进入统一历史，只有 solidify 才发布真实 Deck', async t => {
  const app = await startFixtureServer({ bundle:true, preserveRoot:true, dshAgentBridge:process.env.AICO_RUNTIME_KIND === 'desktop' });
  t.after(async () => { await app.close(); await app.cleanup(); });
  const editorUrl = `${app.url}/editor/?token=${encodeURIComponent(app.token)}`
    + `&editorToken=${encodeURIComponent(app.editorToken)}`
    + (process.env.AICO_RUNTIME_KIND === 'desktop' ? `&embedded=dsh&parentOrigin=${encodeURIComponent(new URL(app.url).origin)}` : '');
  const runtime = await startHeadlessEditorRuntime({ editorUrl });
  t.after(() => runtime.close());
  await app.waitUntilReady({ timeoutMs:20_000 });

  const sourceBefore = await readFile(app.deckPath, 'utf8');
  const replaced = await runCli(app, ['replace-text', '第一页标题', '无窗口新标题']);
  assert.equal(replaced.revision, 1);
  assert.equal((await runCli(app, ['status'])).groups.length, 1);
  assert.equal(await runtime.page.evaluate(() => [...document.querySelector('#deck-frame').contentDocument.querySelectorAll('h2')]
    .filter(node => node.textContent === '无窗口新标题').length), 1);
  assert.equal(await readFile(app.deckPath, 'utf8'), sourceBefore);

  const verified = await runCli(app, ['verify']);
  assert.equal(verified.ok, true);
  assert.equal(await readFile(app.deckPath, 'utf8'), sourceBefore);

  const solidified = await runCli(app, ['solidify']);
  assert.equal(solidified.solidified, true);
  assert.equal((await runCli(app, ['status'])).groups.length, 0);
  assert.match(await readFile(app.deckPath, 'utf8'), /无窗口新标题/);
});
