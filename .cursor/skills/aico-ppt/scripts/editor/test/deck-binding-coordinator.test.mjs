import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openDeckBinding } from '../deck-binding-coordinator.mjs';

const DECK_ID = '22222222-2222-4222-8222-222222222222';

async function fixture(t, fileName = 'source.html') {
  const root = await mkdtemp(join(tmpdir(), 'deck-binding-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, fileName);
  await writeFile(deckPath, '<!doctype html><title>绑定测试</title>');
  const coordinator = await openDeckBinding({
    deckId:DECK_ID,
    initialBinding:{ currentPath:deckPath, trustedRoot:root, revision:0 },
    storageRoot:join(root, '.state'),
    watch:false,
  });
  t.after(() => coordinator.close());
  return { root, deckPath, coordinator };
}

test('同一目录外部改名后按物理文件见证自动重新绑定', async t => {
  const { root, deckPath, coordinator } = await fixture(t);
  const renamedPath = join(root, 'renamed.html');
  const before = coordinator.snapshot();
  await rename(deckPath, renamedPath);

  const after = await coordinator.reconcile({ cause:'watcher' });

  assert.equal(after.deckId, before.deckId);
  assert.equal(after.state, 'bound');
  assert.equal(after.reason, 'renamed');
  assert.equal(after.currentPath, renamedPath);
  assert.equal(after.previousPath, deckPath);
  assert.deepEqual(after.witness, before.witness);
  assert.ok(after.revision > before.revision);
  assert.equal(after.canPublish, true);
});

test('原路径消失且找不到同一见证时进入需要重新绑定并禁止固化', async t => {
  const { deckPath, coordinator } = await fixture(t);
  await rm(deckPath);

  const after = await coordinator.reconcile({ cause:'watcher' });

  assert.equal(after.state, 'needs-rebind');
  assert.equal(after.reason, 'missing');
  assert.equal(after.canPublish, false);
});

test('原路径被另一物理文件占用时进入 replaced 冲突且不接受同内容副本', async t => {
  const { root, deckPath, coordinator } = await fixture(t);
  const movedPath = join(root, 'moved-out.txt');
  await rename(deckPath, movedPath);
  await writeFile(deckPath, '<!doctype html><title>绑定测试</title>');

  const after = await coordinator.reconcile({ cause:'before-publish' });

  assert.equal(after.state, 'conflict');
  assert.equal(after.reason, 'replaced');
  assert.equal(after.currentPath, deckPath);
  assert.equal(after.canPublish, false);
});

test('可信固化原子替换后刷新文件见证，后续轮询仍保持 bound', async t => {
  const { deckPath, coordinator } = await fixture(t);
  const replacement = deckPath + '.replacement';
  const published = '<!doctype html><title>已固化</title>';
  await writeFile(replacement, published);
  await rename(replacement, deckPath);

  const accepted = await coordinator.acceptPublishedFile({
    expectedPath:deckPath,
    expectedFingerprint:'sha256:'
      + (await import('node:crypto')).createHash('sha256').update(published).digest('hex'),
  });
  const afterPoll = await coordinator.reconcile({ cause:'poll' });

  assert.equal(accepted.state, 'bound');
  assert.equal(accepted.reason, 'none');
  assert.equal(afterPoll.state, 'bound');
  assert.deepEqual(afterPoll.witness, accepted.witness);
});

test('相同内容复制件不会自动绑定，但用户确认 verified-copy 后可重新绑定', async t => {
  const { root, deckPath, coordinator } = await fixture(t);
  const copiedPath = join(root, 'copied.html');
  await copyFile(deckPath, copiedPath);
  await rm(deckPath);
  const missing = await coordinator.reconcile({ cause:'watcher' });
  assert.equal(missing.state, 'needs-rebind');

  const rebound = await coordinator.rebind({
    candidatePath:copiedPath,
    expectedBindingRevision:missing.revision,
    confirmation:'verified-copy',
  });

  assert.equal(rebound.state, 'bound');
  assert.equal(rebound.reason, 'manual-rebound');
  assert.equal(rebound.currentPath, copiedPath);
  assert.equal(rebound.canPublish, true);
});

test('Windows File ID adapter 通过同一 Coordinator 状态机完成改名重绑', async t => {
  const oldPath = 'C:\\Decks\\source.html';
  const newPath = 'C:\\Decks\\renamed.html';
  const witness = {
    platform:'windows', volumeSerial:'12', fileId:'345', creationTime:'678',
  };
  const files = new Map([[oldPath, { witness, fingerprint:'sha256:a' }]]);
  const adapter = {
    normalize:value => value,
    dirname:value => value.slice(0, value.lastIndexOf('\\')),
    basename:value => value.slice(value.lastIndexOf('\\') + 1),
    isWithin:() => true,
    async inspect(value) {
      const file = files.get(value);
      if (!file) return { exists:false };
      return { exists:true, valid:true, ...file };
    },
    async listHtmlFiles() { return [...files.keys()]; },
    async findHtmlFiles() { return [...files.keys()]; },
    watchDirectory() { return { close() {} }; },
  };
  const coordinator = await openDeckBinding({
    deckId:DECK_ID,
    initialBinding:{ currentPath:oldPath, trustedRoot:'C:\\Decks', revision:0 },
    storageRoot:'C:\\State',
    fileAdapter:adapter,
    watch:false,
  });
  t.after(() => coordinator.close());
  files.delete(oldPath);
  files.set(newPath, { witness, fingerprint:'sha256:a' });

  const after = await coordinator.reconcile({ cause:'watcher' });

  assert.equal(after.currentPath, newPath);
  assert.equal(after.witness.platform, 'windows');
  assert.equal(after.state, 'bound');
});
