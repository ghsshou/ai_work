import test from 'node:test';
import assert from 'node:assert/strict';
import { pythonUtf8Environment } from '../python-utf8.mjs';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('编辑器 Python 禁止在插件目录生成缓存，即使父进程覆盖环境', () => {
  assert.equal(pythonUtf8Environment({ PYTHONDONTWRITEBYTECODE:'0' }).PYTHONDONTWRITEBYTECODE,'1');
});

test('真实 Python 导入辅助模块不产生包内缓存', async t => {
  const root = await mkdtemp(join(tmpdir(),'ppt-no-cache-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'helper.py'),'value = 42\n');
  await promisify(execFile)(process.platform === 'win32' ? 'python.exe' : 'python3',
    ['-c','import helper; assert helper.value == 42'],
    { cwd:root, env:pythonUtf8Environment(), timeout:10000 });
  assert.deepEqual(await readdir(root),['helper.py']);
});
