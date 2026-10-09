import assert from 'node:assert/strict';
import test from 'node:test';

import { isRegionShortcutKey } from '../public/editor-shortcuts.mjs';

test('中文输入法组合态仍按物理 R 键触发临时模式', () => {
  assert.equal(isRegionShortcutKey({ key:'Process', code:'KeyR', isComposing:true }), true);
});

test('英文输入法 R 键和非 R 物理键保持原语义', () => {
  assert.equal(isRegionShortcutKey({ key:'r', code:'KeyR', isComposing:false }), true);
  assert.equal(isRegionShortcutKey({ key:'Process', code:'KeyT', isComposing:true }), false);
});
