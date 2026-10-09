import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { buildHelpCatalog } from '../help-catalog.mjs';


test('帮助 catalog 从用户指南 Markdown 构建且 topic id 唯一', async () => {
  const catalog = await buildHelpCatalog({ projectRoot:resolve('.') });
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.topics.length, 8);
  assert.equal(new Set(catalog.topics.map(topic => topic.id)).size, catalog.topics.length);
  assert.ok(catalog.topics.every(topic => topic.markdown.startsWith('# ')));
  assert.match(catalog.topics.find(topic => topic.id === 'install').markdown, /Windows 安装/);
});
