import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CreationDraftStore } from '../creation-draft-store.mjs';
import {
  CreationDraftFileAdapter, inspectCreationDraftLock,
} from '../creation-draft-file-adapter.mjs';

test('文件 Adapter 原子持久化 Draft，并在关闭后释放会话锁', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-creation-'));
  t.after(() => rm(projectRoot, { recursive:true, force:true }));
  const adapter = await CreationDraftFileAdapter.create({ projectRoot, draftId:'draft-a' });
  const store = await CreationDraftStore.create({
    adapter, draftId:'draft-a', projectRoot, provider:'codex',
  });
  await store.dispatch({
    type:'update-brief', expectedRevision:0,
    patch:{ title:'新 Deck', audience:'研发团队', durationMinutes:20, objective:'对齐方案' },
  });
  const persisted = JSON.parse(await readFile(join(adapter.draftDir, 'draft.json'), 'utf8'));
  assert.equal(persisted.revision, 1);
  assert.equal(persisted.brief.title, '新 Deck');
  await store.close();

  const reopenedAdapter = await CreationDraftFileAdapter.open({ projectRoot, draftId:'draft-a' });
  const reopened = await CreationDraftStore.open({ adapter:reopenedAdapter });
  assert.equal(reopened.snapshot().revision, 1);
  await reopened.close();
});

test('已有旧 sidecar 的 Creation Draft 原位恢复，不创建空的新目录', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-creation-legacy-'));
  t.after(() => rm(projectRoot, { recursive:true, force:true }));
  await mkdir(join(projectRoot, '.huawei-deck-editor'));

  const adapter = await CreationDraftFileAdapter.create({
    projectRoot, draftId:'legacy-draft',
  });
  assert.equal(adapter.draftDir,
    join(await realpath(projectRoot), '.huawei-deck-editor', 'drafts', 'legacy-draft'));
  await adapter.close();
  await assert.rejects(
    readFile(join(projectRoot, '.aico-ppt-editor', 'drafts', 'legacy-draft', 'draft.json')),
    error => error.code === 'ENOENT',
  );
});

test('同一 Draft 的活动锁拒绝第二个服务', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-creation-lock-'));
  t.after(() => rm(projectRoot, { recursive:true, force:true }));
  const first = await CreationDraftFileAdapter.create({ projectRoot, draftId:'draft-a' });
  await assert.rejects(
    CreationDraftFileAdapter.open({ projectRoot, draftId:'draft-a' }),
    error => error.code === 'CREATION_DRAFT_LOCKED',
  );
  await first.close();
});

test('已失去浏览器窗口的陈旧锁即使宿主进程仍活着也可安全接管', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-creation-stale-lock-'));
  t.after(() => rm(projectRoot, { recursive:true, force:true }));
  const first = await CreationDraftFileAdapter.create({ projectRoot, draftId:'draft-a' });
  const lockPath = first.lockPath;
  await first.close();
  await writeFile(lockPath, `${JSON.stringify({
    version:1,
    pid:process.pid,
    startedAt:'2026-08-11T00:00:00.000Z',
    heartbeatAt:'2026-08-11T00:00:00.000Z',
  })}\n`);

  const reopened = await CreationDraftFileAdapter.open({
    projectRoot,
    draftId:'draft-a',
    now:() => new Date('2026-08-11T00:02:00.000Z'),
    lockLeaseMs:30_000,
  });
  await reopened.close();
});

test('异常中断留下的空锁在租约内保持保护，过期后可安全接管', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-creation-empty-lock-'));
  t.after(() => rm(projectRoot, { recursive:true, force:true }));
  const first = await CreationDraftFileAdapter.create({ projectRoot, draftId:'draft-a' });
  const lockPath = first.lockPath;
  await first.close();
  await writeFile(lockPath, '');
  const lockTime = new Date('2026-08-11T00:00:00.000Z');
  await utimes(lockPath, lockTime, lockTime);

  const fresh = await inspectCreationDraftLock(lockPath, {
    now:() => new Date('2026-08-11T00:00:10.000Z'),
    lockLeaseMs:30_000,
  });
  assert.equal(fresh.locked, true);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.corrupt, true);
  assert.equal(typeof fresh.dev, 'string');
  assert.equal(typeof fresh.ino, 'string');

  const expired = await inspectCreationDraftLock(lockPath, {
    now:() => new Date('2026-08-11T00:02:00.000Z'),
    lockLeaseMs:30_000,
  });
  assert.equal(expired.locked, false);
  assert.equal(expired.stale, true);
  assert.equal(expired.corrupt, true);
  assert.equal(typeof expired.dev, 'string');
  assert.equal(typeof expired.ino, 'string');

  const reopened = await CreationDraftFileAdapter.open({
    projectRoot,
    draftId:'draft-a',
    now:() => new Date('2026-08-11T00:02:00.000Z'),
    lockLeaseMs:30_000,
  });
  await reopened.close();
});

test('sidecar 目录是符号链接时拒绝创建 Draft', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-creation-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'deck-creation-outside-'));
  t.after(() => Promise.all([
    rm(projectRoot, { recursive:true, force:true }),
    rm(outside, { recursive:true, force:true }),
  ]));
  await mkdir(join(outside, 'drafts'));
  try {
    await symlink(outside, join(projectRoot, '.aico-ppt-editor'));
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Windows 未启用 Developer Mode，当前用户不能创建 symlink');
      return;
    }
    throw error;
  }
  await assert.rejects(
    CreationDraftFileAdapter.create({ projectRoot, draftId:'draft-a' }),
    error => error.code === 'UNSAFE_CREATION_SIDECAR',
  );
});

test('确认结果写成独立里程碑文件，独立 Deck 出现后才生成 deck-ready 回执', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-creation-artifacts-'));
  const adapter = await CreationDraftFileAdapter.create({ projectRoot, draftId:'draft-artifacts' });
  const store = await CreationDraftStore.create({
    adapter, draftId:'draft-artifacts', projectRoot, provider:'codex',
  });
  t.after(async () => {
    await store.close();
    await rm(projectRoot, { recursive:true, force:true });
  });

  await store.dispatch({
    type:'update-brief', expectedRevision:0,
    patch:{ title:'文件驱动流程', audience:'研发', durationMinutes:20, objective:'形成初版' },
  });
  await assert.rejects(readFile(join(adapter.draftDir, 'brief.json')), error => error.code === 'ENOENT');
  await store.dispatch({ type:'confirm-brief', expectedRevision:1 });
  assert.equal(JSON.parse(await readFile(join(adapter.draftDir, 'brief.json'), 'utf8')).type, 'brief');

  await store.dispatch({
    type:'propose-outline', expectedRevision:2,
    outline:{ sections:[{
      chapterId:'one', title:'第一章', objective:'讲清楚', pageBudget:1, timeBudgetMinutes:10,
    }] },
  });
  await store.dispatch({ type:'confirm-outline', expectedRevision:3 });
  assert.equal(JSON.parse(await readFile(join(adapter.draftDir, 'outline.json'), 'utf8')).type, 'outline');

  await store.dispatch({
    type:'propose-page-plan', expectedRevision:4,
    pagePlan:{ pages:[{
      pageId:'p1', chapterId:'one', pageTypeId:'cover', label:'封面',
      coreClaim:'核心观点', layoutRationale:'封面', artwork:'无', steps:0,
    }] },
  });
  await store.dispatch({ type:'confirm-page-plan', expectedRevision:5 });
  assert.equal(
    JSON.parse(await readFile(join(adapter.draftDir, 'page-plan.json'), 'utf8')).type,
    'page-plan',
  );
  await store.dispatch({
    type:'set-output', expectedRevision:6,
    output:{
      fileName:'new.html', templateId:'tech-share', includePlan:true,
      trialPptx:false, autoOpenEditor:true,
    },
  });
  await store.dispatch({ type:'start-generation', expectedRevision:7 });
  await assert.rejects(readFile(join(adapter.draftDir, 'deck-ready.json')), error => error.code === 'ENOENT');

  const runDir = join(adapter.stagingDir, 'run-test');
  await mkdir(runDir);
  const deckPath = join(runDir, 'new.html');
  await writeFile(deckPath, '<!doctype html><html><body><script type="__bundler/manifest">{}</script><script type="__bundler/template">"<section></section>"</script></body></html>');
  await store.updateGeneration({ status:'editing', stagingDeck:'staging/run-test/new.html' });
  const deckReceipt = JSON.parse(await readFile(join(adapter.draftDir, 'deck-ready.json'), 'utf8'));
  assert.equal(deckReceipt.type, 'deck-ready');
  assert.equal(deckReceipt.deckPath, deckPath);
  assert.equal(adapter.artifactSnapshot().deck.complete, true);
  assert.equal(adapter.previewDeckPath(), deckPath);

  await store.updateGeneration({ status:'failed' });
  assert.equal(adapter.artifactSnapshot().deck.complete, true, '失败后仍应保留可讨论的 Deck 画布');
});

test('上游需求变化会删除已经失效的下游里程碑回执', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-creation-invalidation-'));
  const adapter = await CreationDraftFileAdapter.create({ projectRoot, draftId:'draft-invalidated' });
  const store = await CreationDraftStore.create({
    adapter, draftId:'draft-invalidated', projectRoot, provider:'codex',
  });
  t.after(async () => {
    await store.close();
    await rm(projectRoot, { recursive:true, force:true });
  });
  await store.dispatch({
    type:'update-brief', expectedRevision:0,
    patch:{ title:'旧标题', audience:'研发', durationMinutes:20, objective:'形成初版' },
  });
  await store.dispatch({ type:'confirm-brief', expectedRevision:1 });
  assert.equal(adapter.artifactSnapshot().brief.complete, true);
  await store.dispatch({ type:'update-brief', expectedRevision:2, patch:{ title:'新标题' } });
  assert.equal(adapter.artifactSnapshot().brief.complete, false);
  await assert.rejects(readFile(join(adapter.draftDir, 'brief.json')), error => error.code === 'ENOENT');
});
