import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromiumLaunchOptions } from './load-playwright.mjs';

test('独立 Skill 使用 Chrome；桌面运行时选择宿主渲染服务', () => {
  assert.deepEqual(chromiumLaunchOptions({}), { channel:'chrome', headless:true });
  assert.deepEqual(chromiumLaunchOptions({ AICO_RUNTIME_KIND:'desktop', AICO_BROWSER_EXECUTABLE:'/obsolete' }), {});
  assert.deepEqual(chromiumLaunchOptions({ AICO_BROWSER_EXECUTABLE:'/AICO App/chrome' }), { executablePath:'/AICO App/chrome', headless:true });
  assert.throws(() => chromiumLaunchOptions({ AICO_BROWSER_EXECUTABLE:' ' }), /浏览器/);
  assert.deepEqual(chromiumLaunchOptions({ AICO_RUNTIME_KIND:'plugin', AICO_BROWSER_EXECUTABLE:'/private/browser' }), { executablePath:'/private/browser', headless:true });
  assert.throws(() => chromiumLaunchOptions({ AICO_RUNTIME_KIND:'plugin' }), /私有浏览器/);
  assert.throws(() => chromiumLaunchOptions({ AICO_RUNTIME_KIND:'plugin', AICO_BROWSER_EXECUTABLE:' ' }), /浏览器/);
});
