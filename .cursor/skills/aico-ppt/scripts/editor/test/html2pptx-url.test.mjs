import assert from 'node:assert/strict';
import test from 'node:test';

import { deckFileUrl } from '../../html2pptx/path-url.mjs';

test('PPTX 截图入口把 Windows 盘符路径转换成标准 file URL', () => {
  assert.equal(
    deckFileUrl(String.raw`Y:\aico-ppt\测试 deck.html`, 'win32'),
    'file:///Y:/aico-ppt/%E6%B5%8B%E8%AF%95%20deck.html',
  );
});

test('PPTX 截图入口保持 POSIX 绝对路径语义', () => {
  assert.equal(
    deckFileUrl('/tmp/测试 deck.html', 'linux'),
    'file:///tmp/%E6%B5%8B%E8%AF%95%20deck.html',
  );
});
