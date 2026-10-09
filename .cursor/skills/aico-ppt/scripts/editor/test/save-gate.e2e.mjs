import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, copyFile, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { openEditor, startFixtureServer } from './test-helpers.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function session(app) {
  return fetch(`${app.url}/api/session?token=${app.token}`).then(response => response.json());
}

async function waitFor(predicate, { timeout = 4_000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('等待保存闸门状态超时');
}

async function waitForBaseline(app) {
  return waitFor(async () => {
    const state = await session(app);
    return Object.keys(state.diagnosticsBaseline ?? {}).length === 2 ? state : null;
  });
}

async function post(app, pathname, body = {}) {
  const response = await fetch(`${app.url}${pathname}?token=${app.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function solidifyDeck(app, expectedRevision) {
  return post(app, '/api/solidify-deck', { expectedRevision });
}

async function writeDeck(app, expectedRevision) {
  return post(app, '/api/write-deck', { expectedRevision });
}

async function savedPatches(deckPath) {
  const lines = (await readFile(deckPath, 'utf8')).split('\n');
  const marker = lines.findIndex(line => line.trim() === '<script type="__bundler/template">');
  assert.ok(marker >= 0, '保存结果缺少 bundle template');
  const template = JSON.parse(lines[marker + 1]);
  const match = template.match(
    /<script type="application\/json" id="huawei-deck-editor-patches">([\s\S]*?)<\/script>/,
  );
  assert.ok(match, '保存结果缺少离线补丁数据');
  return { patches:JSON.parse(match[1]), template };
}

async function apply(app, expectedRevision, id, target, kind, payload) {
  const result = await post(app, '/api/actions', {
    expectedRevision,
    taskId: null,
    actions: [{ id, taskId:null, target, kind, payload, expectedRevision }],
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function undo(app, expectedRevision, groupId) {
  const result = await post(app, `/api/groups/${groupId}/undo`, { expectedRevision });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function openReadyEditor(t, app) {
  const opened = await openEditor(app);
  t.after(() => opened.browser.close());
  opened.page.setDefaultTimeout(4_000);
  await waitForBaseline(app);
  return opened;
}

function connectObserver(app) {
  const socket = new WebSocket(`${app.wsUrl}?token=${encodeURIComponent(app.token)}`);
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

test('无新增溢出时固化原子发布并更新 fingerprint，服务自身替换不触发冲突', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const { page, browserProblems, resourceProblems } = await openReadyEditor(t, app);
  const card = page.frameLocator('#deck-frame').locator('.card').first();
  const target = await card.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  await apply(app, 0, 'solidify-safe-translate', target, 'translate', { x:20, y:0 });
  const before = await readFile(app.deckPath);
  const observer = await connectObserver(app);
  t.after(() => observer.close());
  const events = [];
  observer.on('message', data => events.push(JSON.parse(data)));

  const result = await solidifyDeck(app, 1);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const after = await readFile(app.deckPath);
  assert.notEqual(sha256(after), sha256(before));
  assert.equal(result.body.fingerprint, sha256(after));
  assert.match(result.body.backup, /backups[\\/]minimal-deck-[a-f0-9]{64}\.html$/);

  await new Promise(resolve => setTimeout(resolve, 750));
  const state = await session(app);
  assert.equal(state.deckFingerprint, result.body.fingerprint);
  assert.equal(state.conflict ?? null, null);
  assert.equal(events.filter(event => event.type === 'deck-conflict').length, 0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('活动 Editor 外部改名后固化只发布到新路径，不重建旧文件名', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const { page } = await openReadyEditor(t, app);
  const card = page.frameLocator('#deck-frame').locator('.card').first();
  const target = await card.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  await apply(app, 0, 'solidify-after-rename', target, 'translate', { x:24, y:0 });
  const oldPath = app.deckPath;
  const newPath = join(dirname(oldPath), 'renamed-deck.html');
  await rename(oldPath, newPath);
  const binding = await waitFor(async () => {
    const value = await fetch(`${app.url}/api/deck-binding?token=${app.token}`)
      .then(response => response.json());
    return value.currentPath === newPath && value.state === 'bound' ? value : null;
  });

  const saved = await post(app, '/api/solidify-deck', {
    expectedRevision:1,
    expectedBindingRevision:binding.revision,
  });

  assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
  assert.equal(app.deckPath, newPath);
  assert.equal(sha256(await readFile(newPath)), saved.body.fingerprint);
  await assert.rejects(() => readFile(oldPath), error => error?.code === 'ENOENT');
});

test('源文件消失时保留工作副本并持续阻断固化', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const { page } = await openReadyEditor(t, app);
  const card = page.frameLocator('#deck-frame').locator('.card').first();
  const target = await card.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  await apply(app, 0, 'working-safe-when-missing', target, 'translate', { x:18, y:0 });
  const sourcePath = app.deckPath;
  await unlink(sourcePath);
  const binding = await waitFor(async () => {
    const value = await fetch(`${app.url}/api/deck-binding?token=${app.token}`)
      .then(response => response.json());
    return value.state === 'needs-rebind' ? value : null;
  });
  const bindingBanner = page.locator('[data-deck-binding-banner]');
  await bindingBanner.waitFor({ state:'visible' });
  assert.match(await bindingBanner.innerText(), /工作副本.*重新绑定前无法固化/s);
  assert.equal(await page.locator('[data-solidify]').isDisabled(), true);

  const blocked = await post(app, '/api/solidify-deck', {
    expectedRevision:1,
    expectedBindingRevision:binding.revision,
  });

  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, 'DECK_REBIND_REQUIRED');
  assert.equal(blocked.body.binding.state, 'needs-rebind');
  assert.ok((await readFile(app.workingDeckPath)).length > 0);
  await assert.rejects(() => readFile(sourcePath), error => error?.code === 'ENOENT');
});

test('持久提醒中的系统选择器可把同一物理文件手动重新绑定', async t => {
  let chooseFile = async () => null;
  const app = await startFixtureServer({
    bundle:true,
    pickDeckFile:() => chooseFile(),
  });
  t.after(() => app.close());
  const { page } = await openReadyEditor(t, app);
  const oldPath = app.deckPath;
  const parkedPath = join(dirname(oldPath), 'parked.tmp');
  const reboundPath = join(dirname(oldPath), 'manually-rebound.html');
  await rename(oldPath, parkedPath);
  await waitFor(async () => {
    const value = await fetch(`${app.url}/api/deck-binding?token=${app.token}`)
      .then(response => response.json());
    return value.state === 'needs-rebind' ? value : null;
  });
  await page.locator('[data-deck-binding-banner]').waitFor({ state:'visible' });
  chooseFile = async () => {
    await rename(parkedPath, reboundPath);
    return reboundPath;
  };

  await page.getByRole('button', { name:'重新绑定文件' }).click();

  await page.locator('[data-deck-binding-banner]').waitFor({ state:'hidden' });
  assert.equal(app.deckPath, reboundPath);
  assert.ok((await readFile(reboundPath)).length > 0);
  await assert.rejects(() => readFile(oldPath), error => error?.code === 'ENOENT');
});

test('内容一致复制件经用户明确确认后可从系统选择器重新绑定', async t => {
  let pickedPath = null;
  let pickCount = 0;
  const app = await startFixtureServer({
    bundle:true,
    pickDeckFile:async () => {
      pickCount += 1;
      return pickedPath;
    },
  });
  t.after(() => app.close());
  const { page } = await openReadyEditor(t, app);
  const oldPath = app.deckPath;
  const copiedPath = join(dirname(oldPath), 'verified-copy.html');
  await copyFile(oldPath, copiedPath);
  await unlink(oldPath);
  await waitFor(async () => {
    const value = await fetch(`${app.url}/api/deck-binding?token=${app.token}`)
      .then(response => response.json());
    return value.state === 'needs-rebind' ? value : null;
  });
  await page.locator('[data-deck-binding-banner]').waitFor({ state:'visible' });
  pickedPath = copiedPath;
  let confirmationText = '';
  page.once('dialog', async dialog => {
    confirmationText = dialog.message();
    await dialog.accept();
  });

  await page.getByRole('button', { name:'重新绑定文件' }).click();

  await page.locator('[data-deck-binding-banner]').waitFor({ state:'hidden' });
  assert.match(confirmationText, /内容一致的副本/);
  assert.equal(pickCount, 1, '确认复制件时不应要求用户重复选择文件');
  assert.equal(app.deckPath, copiedPath);
});

test('section、新 nested clip 与既有 clip 增量均阻断，撤销后恢复保存', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const { page } = await openReadyEditor(t, app);
  const frame = page.frameLocator('#deck-frame');
  const card = frame.locator('.card').first();
  const existingClip = frame.locator('.baseline-clip').first();
  const cardTarget = await card.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  const clipTarget = await existingClip.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));

  let applied = await apply(app, 0, 'overflow-section', cardTarget, 'translate', { x:1900, y:0 });
  let beforeWrite = await readFile(app.deckPath);
  let blocked = await solidifyDeck(app, 1);
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, 'NEW_OVERFLOW');
  assert.ok(blocked.body.blockers.some(item => item.kind === 'section' && item.x > 0));
  assert.equal(sha256(await readFile(app.deckPath)), sha256(beforeWrite));
  await undo(app, 1, applied.groupId);

  applied = await apply(app, 2, 'overflow-new-clip', cardTarget, 'resize', { width:300, height:1 });
  beforeWrite = await readFile(app.deckPath);
  blocked = await solidifyDeck(app, 3);
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, 'NEW_OVERFLOW');
  assert.ok(blocked.body.blockers.some(item => item.kind === 'nested-new'));
  assert.equal(sha256(await readFile(app.deckPath)), sha256(beforeWrite));
  await undo(app, 3, applied.groupId);

  applied = await apply(app, 4, 'overflow-clip-delta', clipTarget, 'resize', { width:300, height:96 });
  beforeWrite = await readFile(app.deckPath);
  blocked = await solidifyDeck(app, 5);
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, 'NEW_OVERFLOW');
  assert.ok(blocked.body.blockers.some(item => item.kind === 'nested-delta' && item.y > 2));
  assert.equal(sha256(await readFile(app.deckPath)), sha256(beforeWrite));
  await undo(app, 5, applied.groupId);

  const saved = await solidifyDeck(app, 6);
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
  const persisted = await savedPatches(app.deckPath);
  assert.deepEqual(persisted.patches, []);
});

test('外部修改只广播一次持久冲突且不得被静默覆盖', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  await openReadyEditor(t, app);
  const observer = await connectObserver(app);
  t.after(() => observer.close());
  const events = [];
  observer.on('message', data => events.push(JSON.parse(data)));

  await appendFile(app.deckPath, '\n<!-- external one -->');
  const blocked = await writeDeck(app, 0);
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, 'DECK_CHANGED');
  assert.equal((await session(app)).conflict.code, 'DECK_CHANGED');
  await waitFor(() => events.find(event => event.type === 'deck-conflict'));
  await appendFile(app.deckPath, '\n<!-- external two -->');
  await new Promise(resolve => setTimeout(resolve, 750));
  assert.equal(events.filter(event => event.type === 'deck-conflict').length, 1);
  const externalHash = sha256(await readFile(app.deckPath));

  const retried = await writeDeck(app, 0);
  assert.equal(retried.response.status, 409, JSON.stringify(retried.body));
  assert.equal(retried.body.code, 'DECK_CHANGED');
  assert.equal(sha256(await readFile(app.deckPath)), externalHash);
  assert.equal((await session(app)).conflict.code, 'DECK_CHANGED');
});

test('editor 离线时检查点返回稳定的恢复信息', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const before = await readFile(app.deckPath);
  const blocked = await writeDeck(app, 0);
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.body));
  assert.deepEqual(
    { code:blocked.body.code, stage:blocked.body.stage },
    { code:'EDITOR_OFFLINE', stage:'diagnostics' },
  );
  assert.match(blocked.body.message, /编辑器/);
  assert.match(blocked.body.recovery, /打开|重连/);
  assert.equal(sha256(await readFile(app.deckPath)), sha256(before));
});

test('工作副本补丁验证失败保留原 deck 并返回具体阶段与恢复动作', async t => {
  const verifierError = Object.assign(new Error('模拟 verify 失败'), {
    code:'VERIFY_FAILED',
    statusCode:500,
    stage:'verify',
    recovery:'检查 bundle 结构后重试',
    diagnostic:'backups/write-error.json',
    candidate:'write-errors/candidate-deck.html',
  });
  const app = await startFixtureServer({
    bundle:true,
    workingPatchVerifier:async () => { throw verifierError; },
  });
  t.after(() => app.close());
  const { page } = await openReadyEditor(t, app);
  const card = page.frameLocator('#deck-frame').locator('.card').first();
  const target = await card.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  await apply(app, 0, 'verify-failure-translate', target, 'translate', { x:20, y:0 });
  const before = await readFile(app.deckPath);
  const failed = await solidifyDeck(app, 1);
  assert.equal(failed.response.status, 500, JSON.stringify(failed.body));
  assert.deepEqual(
    { code:failed.body.code, stage:failed.body.stage },
    { code:'VERIFY_FAILED', stage:'verify' },
  );
  assert.equal(failed.body.message, '模拟 verify 失败');
  assert.match(failed.body.recovery, /重试/);
  assert.equal(failed.body.candidate, 'write-errors/candidate-deck.html');
  assert.equal(sha256(await readFile(app.deckPath)), sha256(before));
});

test('close 解除 watcher，之后的文件变化不再回写会话冲突', async t => {
  const app = await startFixtureServer({ bundle:true, preserveRoot:true });
  t.after(() => app.cleanup());
  const { browser } = await openEditor(app);
  await waitForBaseline(app);
  await browser.close();
  await app.close();
  const conflictBefore = structuredClone(app.session.conflict ?? null);
  await appendFile(app.deckPath, '\n<!-- after close -->');
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.deepEqual(app.session.conflict ?? null, conflictBefore);
});
