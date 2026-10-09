import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile, readdir, utimes} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {startFixtureServer} from './test-helpers.mjs';

test('关闭编辑服务会回收旧孤立完整版本并保留当前可恢复版本', {timeout:30000}, async t => {
  const app = await startFixtureServer({autoStartAgentTerminal:false, preserveRoot:true, bundle:true});
  t.after(async () => { await app.close(); await app.cleanup(); });
  const working = app.session.workingDeckPath;
  const versions = join(dirname(working), 'versions');
  const old = new Date(Date.now() - 7 * 86400_000);
  const candidates = [];
  for (let i = 0; i < 16; i++) {
    const bytes = Buffer.from(`<!doctype html><title>已废弃的中间版本 ${i}</title>`);
    const name = `${createHash('sha256').update(bytes).digest('hex')}.html`;
    await writeFile(join(versions, name), bytes);
    await utimes(join(versions, name), old, old);
    candidates.push(name);
  }
  const before = await readFile(working);
  await app.close();
  const remaining = await readdir(versions);
  assert.ok(remaining.filter(name => candidates.includes(name)).length <= 8,
    '旧孤立完整版本应自动回收，而不是随编辑次数无限积累');
  assert.ok((await readFile(working)).equals(before), '清理不能改写工作副本');
  assert.ok(remaining.includes(`${app.session.workingDeckFingerprint}.html`));
});

test('重启先完成工作副本恢复，再回收旧孤立版本', {timeout:30000}, async t => {
  const {startServer} = await import('../server.mjs');
  const app = await startFixtureServer({autoStartAgentTerminal:false, preserveRoot:true, bundle:true});
  t.after(() => app.cleanup());
  await app.close();
  const working = app.session.workingDeckPath;
  const versions = join(dirname(working), 'versions');
  const original = await readFile(working);
  const old = new Date(Date.now() - 7 * 86400_000);
  const candidates = [];
  for (let i = 0; i < 16; i++) {
    const bytes = Buffer.from(`重启前已废弃的中间版本 ${i}`);
    const name = `${createHash('sha256').update(bytes).digest('hex')}.html`;
    await writeFile(join(versions, name), bytes); await utimes(join(versions, name), old, old);
    candidates.push(name);
  }
  // 模拟写盘中断：启动必须先从持久化指纹对应的版本恢复。
  await writeFile(working, '<script type="__bundler/template">\n损坏的未提交候选\n</script>');
  const reopened = await startServer({deckPath:app.deckPath, port:0, openBrowser:false,
    autoStartAgentTerminal:false, token:'fixture-token', editorToken:'fixture-editor-token'});
  t.after(() => reopened.close());
  assert.ok((await readFile(working)).equals(original), '启动必须恢复原有工作副本');
  assert.equal(reopened.session.sessionId, app.session.sessionId);
  assert.ok((await readdir(versions)).filter(name => candidates.includes(name)).length <= 8);
  await reopened.close();
});
