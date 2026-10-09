import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RecentDeckStore } from '../recent-deck-store.mjs';

test('最近 Deck 按文件修改时间排序，并自动剔除已删除文件', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-recents-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const first = join(root, 'first.html');
  const second = join(root, 'second.html');
  await writeFile(first, '<!doctype html><title>first</title>');
  await writeFile(second, '<!doctype html><title>second</title>');
  await utimes(first, new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z'));
  await utimes(second, new Date('2026-08-02T00:00:00Z'), new Date('2026-08-02T00:00:00Z'));

  const statePath = join(root, 'state', 'recent-decks.json');
  const store = new RecentDeckStore({
    filePath:statePath,
    now:() => new Date('2026-08-03T00:00:00Z'),
  });
  await store.record({ deckPath:first, provider:'codex' });
  await store.record({ deckPath:second, provider:'claude-code' });
  const listed = await store.list();
  assert.deepEqual(listed.map(entry => entry.deckName), ['second.html', 'first.html']);
  assert.equal(listed[0].provider, 'claude-code');
  assert.equal(await store.resolve(second), await realpath(second));
  assert.equal(await store.resolve(join(root, 'unknown.html')), null);

  await unlink(second);
  assert.deepEqual((await store.list()).map(entry => entry.deckName), ['first.html']);
  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual(persisted.entries.map(entry => entry.deckPath), [await realpath(first)]);
});

test('记录 Deck 时持久化已选项目根，重开不回退到启动器工作目录', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-recents-project-root-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const projectRoot = join(root, 'project');
  const deck = join(projectRoot, 'deck.html');
  await mkdir(projectRoot);
  await writeFile(deck, '<!doctype html><title>project root</title>');
  const statePath = join(root, 'state', 'recent-decks.json');
  const store = new RecentDeckStore({ filePath:statePath });

  await store.record({ deckPath:deck, provider:'codex', projectRoot });

  assert.equal((await store.list())[0].projectRoot, await realpath(projectRoot));
  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(persisted.entries[0].projectRoot, await realpath(projectRoot));
});

test('Creation 交接的旧 Deck 从上下文恢复原项目根，不采信漂移的 Agent 工作区', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-recents-creation-root-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const projectRoot = join(root, 'project');
  const deck = join(projectRoot, 'created.html');
  const sessionDir = join(projectRoot, '.aico-ppt-editor', 'created-session');
  await mkdir(sessionDir, { recursive:true });
  await writeFile(deck, '<!doctype html><title>created</title>');
  await writeFile(join(sessionDir, 'session.json'), JSON.stringify({ deckPath:deck }));
  await writeFile(join(sessionDir, 'agent-workspace.json'), JSON.stringify({
    activeProvider:'codex', projectRoot:root,
  }));
  await writeFile(join(sessionDir, 'creation-context.json'), JSON.stringify({
    version:1,
    kind:'creation-to-editing',
    projectRoot,
    draft:{
      projectRoot,
      generation:{ status:'published', publishedDeck:deck },
    },
  }));

  const store = new RecentDeckStore({
    filePath:join(root, 'state', 'recent-decks.json'),
    discoveryRoots:[root],
  });

  assert.equal((await store.list())[0].projectRoot, await realpath(projectRoot));
});

test('首次使用时从旧编辑会话迁移最近 Deck', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-recents-migrate-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deck = join(root, 'project', 'legacy.html');
  const sessionDir = join(root, 'project', '.aico-ppt-editor', 'legacy-session');
  await mkdir(sessionDir, { recursive:true });
  await writeFile(deck, '<!doctype html><title>legacy</title>');
  await writeFile(join(sessionDir, 'session.json'), JSON.stringify({ deckPath:deck }));

  const store = new RecentDeckStore({
    filePath:join(root, 'state', 'recent-decks.json'),
    discoveryRoots:[root],
  });
  const [migrated] = await store.list();
  assert.equal(migrated.deckName, 'legacy.html');
  assert.equal(migrated.deckPath, await realpath(deck));
});

test('删除最近任务记录后自动发现不会把它重新加回，重新打开时才恢复', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-recents-dismiss-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deck = join(root, 'project', 'dismiss.html');
  const sessionDir = join(root, 'project', '.aico-ppt-editor', 'session-dismiss');
  await mkdir(sessionDir, { recursive:true });
  await writeFile(deck, '<!doctype html><title>dismiss</title>');
  await writeFile(join(sessionDir, 'session.json'), JSON.stringify({ deckPath:deck }));

  const store = new RecentDeckStore({
    filePath:join(root, 'state', 'recent-decks.json'),
    discoveryRoots:[root],
  });
  assert.equal((await store.list()).length, 1);

  await store.dismiss(deck);
  assert.deepEqual(await store.list(), [], '删除记录后 sidecar 自动发现不得立即恢复该条目');
  assert.equal(await readFile(deck, 'utf8'), '<!doctype html><title>dismiss</title>');

  await store.record({ deckPath:deck, provider:'codex' });
  assert.equal((await store.list())[0].deckPath, await realpath(deck));
});
