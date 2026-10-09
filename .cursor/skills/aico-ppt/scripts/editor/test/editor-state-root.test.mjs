import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { resolveEditorStateRoot } from '../editor-state-root.mjs';

test('测试进程与显式覆盖都不能落入用户正式状态目录', () => {
  const homeDirectory = resolve('/Users/example');
  const explicitRoot = resolve(tmpdir(), 'aico-ppt-explicit-state');

  assert.equal(resolveEditorStateRoot({
    environment:{ AICO_PPT_EDITOR_STATE_ROOT:explicitRoot },
    homeDirectory,
    processId:101,
  }), explicitRoot);

  assert.equal(resolveEditorStateRoot({
    environment:{ NODE_TEST_CONTEXT:'child-v8' },
    homeDirectory,
    processId:202,
  }), join(tmpdir(), 'aico-ppt-editor-tests-202'));

  assert.equal(resolveEditorStateRoot({
    environment:{},
    homeDirectory,
    processId:303,
  }), join(homeDirectory, '.aico-ppt-editor'));
});

test('统一测试入口为每个子进程注入一次性状态目录', async () => {
  const source = await readFile(resolve('scripts/run-editor-tests.mjs'), 'utf8');
  assert.match(source, /mkdtempSync/);
  assert.match(source, /AICO_PPT_EDITOR_STATE_ROOT/);
  assert.match(source, /rmSync/);
});

test('旧状态目录与旧环境变量继续可读，新安装优先使用 AICO-PPT 名称', async t => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'aico-ppt-state-compat-'));
  t.after(() => rm(homeDirectory, { recursive:true, force:true }));
  await mkdir(join(homeDirectory, '.huawei-deck-editor'));
  assert.equal(resolveEditorStateRoot({ environment:{}, homeDirectory }),
    join(homeDirectory, '.huawei-deck-editor'));

  const explicitLegacy = join(homeDirectory, 'legacy-explicit');
  assert.equal(resolveEditorStateRoot({
    environment:{ HUAWEI_DECK_EDITOR_STATE_ROOT:explicitLegacy }, homeDirectory,
  }), explicitLegacy);

  await mkdir(join(homeDirectory, '.aico-ppt-editor'));
  assert.equal(resolveEditorStateRoot({ environment:{}, homeDirectory }),
    join(homeDirectory, '.aico-ppt-editor'));
});
