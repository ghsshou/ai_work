import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CreationDraftFileAdapter } from '../creation-draft-file-adapter.mjs';
import { CreationDraftStore } from '../creation-draft-store.mjs';
import { WorkHistoryStore } from '../work-history-store.mjs';

async function createDraft(projectRoot, draftId, title, now) {
  const adapter = await CreationDraftFileAdapter.create({ projectRoot, draftId });
  const store = await CreationDraftStore.create({
    adapter,
    draftId,
    projectRoot:adapter.projectRoot,
    provider:'codex',
    now:() => now,
  });
  await store.dispatch({
    type:'update-brief',
    expectedRevision:0,
    patch:{ title, audience:'研发团队', durationMinutes:30, objective:'形成共识' },
  });
  return store;
}

test('同一项目下多个 Creation Draft 通过 draftId 独立列出和恢复', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-history-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot);
  const first = await createDraft(projectRoot, 'draft-one', '第一份 Deck', '2026-08-10T10:00:00.000Z');
  const second = await createDraft(projectRoot, 'draft-two', '第二份 Deck', '2026-08-11T10:00:00.000Z');
  await first.close();
  await second.close();

  const deckStore = { async list() { return []; }, async record() {}, async resolve() { return null; } };
  const statePath = join(root, 'state', 'recent-work.json');
  const history = new WorkHistoryStore({
    filePath:statePath,
    discoveryRoots:[root],
    recentDeckStore:deckStore,
  });
  const listed = await history.list();
  assert.deepEqual(listed.creation.map(item => item.draftId), ['draft-two', 'draft-one']);
  assert.deepEqual(listed.creation.map(item => item.title), ['第二份 Deck', '第一份 Deck']);
  assert.equal(listed.creation[0].progress, '需求沟通中');
  assert.equal(listed.creation[0].locked, false);

  const resolved = await history.resolveCreation({ projectRoot, draftId:'draft-one' });
  assert.equal(resolved.title, '第一份 Deck');
  assert.equal(await history.resolveCreation({ projectRoot, draftId:'forged' }), null);
});

test('记录、继续和完成 Creation Draft 只更新索引指针，不混淆过程文件', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-record-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot);
  const draft = await createDraft(projectRoot, 'draft-recorded', '可继续任务', '2026-08-11T12:00:00.000Z');
  await draft.close();
  const statePath = join(root, 'state', 'recent-work.json');
  const history = new WorkHistoryStore({
    filePath:statePath,
    recentDeckStore:{
      async list() { return []; }, async record() {}, async resolve() { return null; },
    },
    now:() => new Date('2026-08-11T13:00:00.000Z'),
  });
  await history.recordCreation({ projectRoot, draftId:'draft-recorded', provider:'codex' });
  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(persisted.creation[0].draftId, 'draft-recorded');
  assert.equal(persisted.creation[0].lastOpenedAt, '2026-08-11T13:00:00.000Z');
  assert.equal((await history.listCreation())[0].title, '可继续任务');

  await history.completeCreation({ projectRoot, draftId:'draft-recorded' });
  assert.deepEqual((await history.listCreation()), []);
  assert.equal(JSON.parse(await readFile(
    join(projectRoot, '.aico-ppt-editor', 'drafts', 'draft-recorded', 'draft.json'),
    'utf8',
  )).brief.title, '可继续任务');
});

test('首页不把陈旧的 Creation Draft 租约显示为另一窗口占用', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-stale-lock-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot);
  const draft = await createDraft(
    projectRoot, 'draft-stale', '陈旧占用', '2026-08-11T00:00:00.000Z',
  );
  const lockPath = join(
    projectRoot, '.aico-ppt-editor', 'drafts', 'draft-stale', 'active.lock',
  );
  await draft.close();
  await writeFile(lockPath, `${JSON.stringify({
    version:1,
    pid:process.pid,
    startedAt:'2026-08-11T00:00:00.000Z',
    heartbeatAt:'2026-08-11T00:00:00.000Z',
  })}\n`);
  const history = new WorkHistoryStore({
    filePath:join(root, 'recent-work.json'),
    discoveryRoots:[root],
    recentDeckStore:{
      async list() { return []; }, async record() {}, async resolve() { return null; },
    },
    now:() => new Date('2026-08-11T00:02:00.000Z'),
    lockLeaseMs:30_000,
  });
  assert.equal((await history.listCreation())[0].locked, false);
});

test('首页不把异常中断留下的陈旧空锁显示为另一窗口占用', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-empty-lock-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot);
  const draft = await createDraft(
    projectRoot, 'draft-empty-lock', '异常中断', '2026-08-11T00:00:00.000Z',
  );
  const lockPath = join(
    projectRoot, '.aico-ppt-editor', 'drafts', 'draft-empty-lock', 'active.lock',
  );
  await draft.close();
  await writeFile(lockPath, '');
  const lockTime = new Date('2026-08-11T00:00:00.000Z');
  await utimes(lockPath, lockTime, lockTime);

  const history = new WorkHistoryStore({
    filePath:join(root, 'recent-work.json'),
    discoveryRoots:[root],
    recentDeckStore:{
      async list() { return []; }, async record() {}, async resolve() { return null; },
    },
    now:() => new Date('2026-08-11T00:02:00.000Z'),
    lockLeaseMs:30_000,
  });
  assert.equal((await history.listCreation())[0].locked, false);
});

test('删除 Creation 任务记录只隐藏首页条目，不删除 Draft，并可在再次记录时恢复', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-dismiss-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot);
  const draft = await createDraft(
    projectRoot, 'draft-dismissed', '暂时隐藏', '2026-08-11T00:00:00.000Z',
  );
  await draft.close();
  const history = new WorkHistoryStore({
    filePath:join(root, 'state', 'recent-work.json'),
    discoveryRoots:[root],
    recentDeckStore:{
      async list() { return []; }, async record() {}, async resolve() { return null; },
    },
  });
  assert.equal((await history.listCreation()).length, 1);

  await history.dismissCreation({ projectRoot, draftId:'draft-dismissed' });
  assert.deepEqual(await history.listCreation(), []);
  assert.equal(JSON.parse(await readFile(
    join(projectRoot, '.aico-ppt-editor', 'drafts', 'draft-dismissed', 'draft.json'),
    'utf8',
  )).brief.title, '暂时隐藏');

  await history.recordCreation({ projectRoot, draftId:'draft-dismissed', provider:'codex' });
  assert.equal((await history.listCreation())[0].draftId, 'draft-dismissed');
});
