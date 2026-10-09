import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { importHistory } from '../import-history.mjs';

test('导入保留工作身份和文件路径，清空旧 DSH 会话绑定，原数据不变且重复操作幂等', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aico-import-'));
  const source = join(root, 'old');
  const target = join(root, 'new');
  await mkdir(source);
  const catalog = { version:3, revision:4, workItems:[{ workId:'keep-id', deckId:'keep-deck', projectRoot:'/my/project', dshBinding:{ activeSessionId:'old-session' }, binding:{ currentPath:'/my/project/deck.html' } }] };
  await writeFile(join(source, 'work-catalog.json'), JSON.stringify(catalog));
  await writeFile(join(source, 'recent-decks.json'), JSON.stringify({ version:1, entries:[{ path:'/my/deck.html' }], dismissed:[] }));
  await writeFile(join(source, 'credentials.json'), 'never-copy');
  try {
    assert.equal((await importHistory({ source, target })).alreadyImported, false);
    const actual = JSON.parse(await readFile(join(target, 'work-catalog.json'), 'utf8'));
    assert.equal(actual.workItems[0].workId, 'keep-id');
    assert.deepEqual(actual.workItems[0].binding, catalog.workItems[0].binding);
    assert.equal(actual.workItems[0].dshBinding.activeSessionId, null);
    assert.deepEqual(actual.workItems[0].dshBinding.sessions, []);
    assert.deepEqual(JSON.parse(await readFile(join(source, 'work-catalog.json'), 'utf8')), catalog);
    await assert.rejects(readFile(join(target, 'credentials.json')), { code:'ENOENT' });
    await writeFile(join(target, 'user-new-work'), 'keep');
    assert.equal((await importHistory({ source, target })).alreadyImported, true);
    assert.equal(await readFile(join(target, 'user-new-work'), 'utf8'), 'keep');
    catalog.revision++;
    await writeFile(join(source, 'work-catalog.json'), JSON.stringify(catalog));
    await assert.rejects(importHistory({ source, target }), /已存在|非空/);
  } finally { await rm(root, { recursive:true, force:true }); }
});

test('目标非空、未知格式和来源相同均拒绝，失败时不留下半份目标', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aico-import-invalid-'));
  const source = join(root, 'old');
  const target = join(root, 'new');
  await mkdir(source);
  try {
    await writeFile(join(source, 'work-catalog.json'), JSON.stringify({ version:99, workItems:[] }));
    await assert.rejects(importHistory({ source, target }), /版本/);
    await assert.rejects(readFile(join(target, 'work-catalog.json')), { code:'ENOENT' });
    await assert.rejects(importHistory({ source, target:source }), /相同/);
    await writeFile(join(source, 'work-catalog.json'), JSON.stringify({ version:2, revision:0, workItems:[] }));
    await mkdir(target);
    await writeFile(join(target, 'existing'), 'keep');
    await assert.rejects(importHistory({ source, target }), /非空/);
    assert.equal(await readFile(join(target, 'existing'), 'utf8'), 'keep');
  } finally { await rm(root, { recursive:true, force:true }); }
});

test('真实工作目录导入后可直接列出同一 Deck，并保留项目副本', async () => {
  const { WorkCatalog } = await import('../work-catalog.mjs');
  const root = await mkdtemp(join(tmpdir(), 'aico-import-catalog-'));
  const source = join(root, 'old');
  const target = join(root, 'new');
  const deckPath = join(root, 'deck.html');
  await writeFile(deckPath, '<!doctype html><title>保留的作品</title>');
  const legacyHistory = { async list() { return { version:1, creation:[], editing:[{ deckPath, deckName:'deck.html', directory:root, modifiedAt:'2026-09-06T00:00:00.000Z', lastOpenedAt:'2026-09-06T00:00:00.000Z', provider:'codex', progress:'继续编辑' }] }; } };
  try {
    const original = new WorkCatalog({ filePath:join(source, 'work-catalog.json'), legacyHistory });
    const before = (await original.list()).editing[0];
    await importHistory({ source, target });
    const imported = new WorkCatalog({ filePath:join(target, 'work-catalog.json'), legacyHistory:{ async list() { return { version:1, creation:[], editing:[] }; } } });
    const after = (await imported.list()).editing[0];
    assert.equal(after.workId, before.workId);
    assert.equal(after.deckId, before.deckId);
    assert.equal(after.deckPath, before.deckPath);
    assert.equal(after.dshBinding.activeSessionId, null);
    assert.equal(await readFile(deckPath, 'utf8'), '<!doctype html><title>保留的作品</title>');
  } finally { await rm(root, { recursive:true, force:true }); }
});

test('目标父目录的链接不能把导入写回来源内部', async () => {
  const { symlink } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'aico-import-alias-'));
  const source = join(root, 'old');
  await mkdir(source);
  await writeFile(join(source, 'work-catalog.json'), JSON.stringify({ version:3, revision:0, workItems:[] }));
  try {
    await symlink(source, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(importHistory({ source, target:join(root, 'alias/new') }), /内部/);
    await assert.rejects(readFile(join(source, 'new/work-catalog.json')), { code:'ENOENT' });
  } finally { await rm(root, { recursive:true, force:true }); }
});
