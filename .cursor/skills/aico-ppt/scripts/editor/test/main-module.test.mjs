import test from 'node:test';
import assert from 'node:assert/strict';
import { sameMainModulePath } from '../main-module.mjs';


test('Windows UNC 主机名大小写不同仍识别为同一个主模块', () => {
  const argvPath = String.raw`\\Mac\Home\zyq_workspace\aico-ppt\scripts\editor\app-server.mjs`;
  const modulePath = String.raw`\\mac\Home\zyq_workspace\aico-ppt\scripts\editor\app-server.mjs`;

  assert.equal(sameMainModulePath(argvPath, modulePath, 'win32'), true);
  assert.equal(sameMainModulePath(argvPath, modulePath, 'linux'), false);
});

test('Windows 下不同入口文件不能误判为主模块', () => {
  const argvPath = String.raw`Y:\aico-ppt\scripts\editor\app-server.mjs`;
  const modulePath = String.raw`Y:\aico-ppt\scripts\editor\server.mjs`;

  assert.equal(sameMainModulePath(argvPath, modulePath, 'win32'), false);
});
