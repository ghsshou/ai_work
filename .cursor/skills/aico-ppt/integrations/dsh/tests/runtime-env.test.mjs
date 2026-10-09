import assert from 'node:assert/strict';
import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { resolveRuntime } from '../runtime-env.mjs';
import { runtimeFixture } from './runtime-fixture.mjs';

test('插件私有浏览器经过资源目录校验，不继承旧宿主渲染通道', async t => {
  const runtime = await runtimeFixture(t);
  const browser = join(runtime.root, 'browser');
  await writeFile(browser, '测试浏览器文件');
  const configured = { ...runtime, paths:{ ...runtime.paths, browser } };
  const result = await resolveRuntime(configured, { AICO_HOME:'/old-host', AICO_BROWSER_EXECUTABLE:'/old/browser' });
  assert.equal(result.environment.AICO_RUNTIME_KIND, 'plugin');
  assert.equal(result.environment.AICO_BROWSER_EXECUTABLE, browser);
  assert.equal(result.environment.AICO_HOME, undefined);
  await assert.rejects(resolveRuntime({ ...configured, paths:{ ...configured.paths, browser:process.execPath } }), /目录/);
  await assert.rejects(resolveRuntime({ ...configured, paths:{ ...configured.paths, browser:runtime.root } }), /目录/);
});

test('私有运行时只使用声明的工具，保留数据目录且不修改调用者环境', async t => {
  const runtime = await runtimeFixture(t);
  const inherited = {
    PATH:'/other-plugin/bin', PYTHON:'/old/python', PYTHONPATH:'/old/modules',
    PLAYWRIGHT_CORE:'/old/playwright', AICO_BROWSER_EXECUTABLE:'/old/browser',
    AICO_SOFFICE_EXECUTABLE:'/old/office', AICO_RUNTIME_KIND:'old', NODE_OPTIONS:'--inspect',
    AICO_NODE_EXECUTABLE:'/old/node', ELECTRON_RUN_AS_NODE:'untrusted',
    AICO_HOME:'/my/aico', AICO_PPT_EDITOR_STATE_ROOT:'/my/aico/ppt',
    AICO_PLUGIN_BRIDGE_TOKEN:'private-token', DEEPSEEK_API_KEY:'private-key',
    AICO_DESKTOP_DIALOG_URL:'http://127.0.0.1:45001/pick', AICO_DESKTOP_DIALOG_TOKEN:'dialog-private',
  };
  const before = structuredClone(inherited);
  const actual = await resolveRuntime(runtime, inherited);
  assert.equal(actual.environment.PYTHON, runtime.paths.python);
  assert.equal(actual.environment.AICO_NODE_EXECUTABLE, process.execPath);
  assert.equal(actual.environment.ELECTRON_RUN_AS_NODE, process.versions.electron ? '1' : undefined);
  assert.equal(actual.environment.AICO_BROWSER_EXECUTABLE, undefined);
  assert.equal(actual.environment.AICO_SOFFICE_EXECUTABLE, undefined);
  assert.equal(actual.environment.AICO_RUNTIME_KIND, 'desktop');
  assert.equal(actual.environment.AICO_HOME, inherited.AICO_HOME);
  assert.equal(actual.environment.AICO_PPT_EDITOR_STATE_ROOT, inherited.AICO_PPT_EDITOR_STATE_ROOT);
  assert.doesNotMatch(actual.environment.PATH, /other-plugin/);
  for (const key of ['PYTHONPATH', 'PLAYWRIGHT_CORE', 'NODE_OPTIONS', 'AICO_PLUGIN_BRIDGE_TOKEN', 'DEEPSEEK_API_KEY', 'AICO_DESKTOP_DIALOG_URL', 'AICO_DESKTOP_DIALOG_TOKEN']) {
    assert.equal(actual.environment[key], undefined, key);
  }
  assert.deepEqual(inherited, before);
});

test('运行时拒绝缺失文件、目录外路径、外部软链接和额外凭据字段', async t => {
  const runtime = await runtimeFixture(t);
  await assert.rejects(resolveRuntime({ ...runtime, token:'secret' }), /字段/);
  await assert.rejects(resolveRuntime({ ...runtime, paths:{ ...runtime.paths, office:runtime.paths.python } }), /字段/);
  await assert.rejects(resolveRuntime({ ...runtime, paths:{ ...runtime.paths, python:'python3' } }), /绝对路径/);
  await assert.rejects(resolveRuntime({ ...runtime, paths:{ ...runtime.paths, python:process.execPath } }), /目录/);
  await assert.rejects(resolveRuntime({ ...runtime, paths:{ ...runtime.paths, python:join(runtime.root, 'missing') } }), /不存在/);
  if (process.platform !== 'win32') {
    const alias = join(runtime.root, 'outside-python');
    await symlink(process.execPath, alias);
    await assert.rejects(resolveRuntime({ ...runtime, paths:{ ...runtime.paths, python:alias } }), /目录/);
  }
});
