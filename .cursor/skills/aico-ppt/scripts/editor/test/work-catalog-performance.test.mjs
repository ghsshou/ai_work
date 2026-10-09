import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkCatalog } from '../work-catalog.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('打开一个工作项只刷新该 Deck 的文件绑定，菜单不重读其他大文件', async t => {
  const root = await mkdtemp(join(tmpdir(), 'catalog-selected-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const paths = [join(root,'one.html'), join(root,'two.html')];
  await Promise.all(paths.map(path => writeFile(path, 'original')));
  const catalog = new WorkCatalog({ filePath:join(root,'catalog.json'), legacyHistory:{
    async list() { return { creation:[], editing:paths.map(deckPath => ({ deckPath, projectRoot:root })) }; },
  } });
  const original = (await catalog.list()).editing;
  await Promise.all(paths.map(path => writeFile(path, 'changed')));
  const metadata = (await catalog.listSessionTargets()).editing;
  assert.deepEqual(metadata.map(item => item.binding.sourceFingerprint), original.map(item => item.binding.sourceFingerprint));
  const selected = await catalog.resolve(original[0].workId);
  assert.notEqual(selected.binding.observedSourceFingerprint, original[0].binding.observedSourceFingerprint);
  const remaining = (await catalog.listSessionTargets()).editing.find(item => item.workId === original[1].workId);
  assert.equal(remaining.binding.observedSourceFingerprint, original[1].binding.observedSourceFingerprint);
  const refreshed = (await catalog.list()).editing.find(item => item.workId === original[1].workId);
  assert.notEqual(refreshed.binding.observedSourceFingerprint, original[1].binding.observedSourceFingerprint);
});

test('会话菜单查询兼容读取旧记录元数据', async () => {
  const catalog = new WorkCatalog({ filePath:null, legacyHistory:{
    async list() { return { creation:[], editing:[] }; },
  } });
  const result = await catalog.listSessionTargets();
  assert.deepEqual(result.creation, []);
  assert.deepEqual(result.editing, []);
});

test('并发目录刷新共享同一次扫描，但返回相互独立的快照', async () => {
  let scans = 0;
  const catalog = new WorkCatalog({ filePath:null, legacyHistory:{
    async list() { scans += 1; return { creation:[], editing:[] }; },
  } });
  const results = await Promise.all(Array.from({ length:20 }, () => catalog.list()));
  assert.equal(scans, 1, '重复刷新不能把同一轮文件扫描排队执行二十遍');
  results[0].creation.push({ test:true });
  assert.deepEqual(results[1].creation, []);
  await catalog.list();
  assert.equal(scans, 2, '已完成的结果不缓存，后续刷新重新检查文件');
});

test('目录修改插入队列后，后续刷新不能复用修改之前的快照', async () => {
  let scans = 0;
  const catalog = new WorkCatalog({ filePath:null, legacyHistory:{
    async list() { scans += 1; return { creation:[], editing:[] }; },
  } });
  const before = catalog.list();
  const mutation = catalog.reopenEditing({ deckPath:'/tmp/catalog-performance-missing.html' });
  const after = catalog.list();
  await Promise.all([before, mutation, after]);
  assert.equal(scans, 2);
});
