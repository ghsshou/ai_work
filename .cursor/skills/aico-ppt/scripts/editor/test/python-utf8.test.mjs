import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultPythonExecutable,
  pythonUtf8Environment,
  pythonUtf8SpawnOptions,
} from '../python-utf8.mjs';

test('Python 默认可执行文件按平台选择且允许显式环境覆盖', () => {
  assert.equal(defaultPythonExecutable({ platform:'win32', environment:{} }), 'python.exe');
  assert.equal(defaultPythonExecutable({ platform:'darwin', environment:{} }), 'python3');
  assert.equal(defaultPythonExecutable({
    platform:'win32', environment:{ PYTHON:'C:\\Tools\\python.exe' },
  }), 'C:\\Tools\\python.exe');
});

test('Python 子进程统一覆盖 Windows 控制台编码并保留其他环境变量', () => {
  const environment = pythonUtf8Environment({
    CUSTOM_VALUE:'保留',
    PYTHONIOENCODING:'gbk:replace',
    PYTHONUTF8:'0',
  });
  assert.deepEqual(environment, {
    CUSTOM_VALUE:'保留',
    PYTHONDONTWRITEBYTECODE:'1',
    PYTHONIOENCODING:'utf-8',
    PYTHONUTF8:'1',
  });
  assert.deepEqual(
    pythonUtf8SpawnOptions({ cwd:'/tmp', env:{ PYTHONIOENCODING:'cp936' } }),
    {
      cwd:'/tmp',
      windowsHide:true,
      env:{ PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1', PYTHONDONTWRITEBYTECODE:'1' },
    },
  );
});
