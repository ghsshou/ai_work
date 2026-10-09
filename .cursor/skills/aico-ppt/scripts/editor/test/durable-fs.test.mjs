import assert from 'node:assert/strict';
import test from 'node:test';

import {
  directorySyncUnsupported,
  fileOpenModeForSync,
} from '../durable-fs.mjs';

test('Windows 只把目录 fsync 的 EPERM 视为平台不支持', () => {
  assert.equal(directorySyncUnsupported({ code:'EPERM' }, 'win32'), true);
  assert.equal(directorySyncUnsupported({ code:'EPERM' }, 'darwin'), false);
  assert.equal(directorySyncUnsupported({ code:'EACCES' }, 'win32'), false);
  for (const code of ['EINVAL', 'ENOTSUP', 'EISDIR']) {
    assert.equal(directorySyncUnsupported({ code }, 'linux'), true);
  }
});

test('Windows 用可写句柄 flush 映射盘普通文件，其他平台保留只读句柄', () => {
  assert.equal(fileOpenModeForSync('win32'), 'r+');
  assert.equal(fileOpenModeForSync('darwin'), 'r');
  assert.equal(fileOpenModeForSync('linux'), 'r');
});
