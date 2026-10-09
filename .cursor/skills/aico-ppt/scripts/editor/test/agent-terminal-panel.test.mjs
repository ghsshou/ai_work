import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldForwardTerminalKey } from '../public/terminal-keyboard.mjs';

const keyEvent = (key, patch = {}) => ({
  key,
  ctrlKey:false,
  metaKey:false,
  altKey:false,
  shiftKey:false,
  ...patch,
});

test('Windows 终端有文字选区时 Ctrl+C 交给浏览器复制，不向 PTY 发送中断', () => {
  assert.equal(shouldForwardTerminalKey(keyEvent('c', { ctrlKey:true }), {
    platform:'Win32',
    hasSelection:true,
  }), false);
});

test('Windows 终端没有文字选区时 Ctrl+C 仍可中断当前 CLI turn', () => {
  assert.equal(shouldForwardTerminalKey(keyEvent('c', { ctrlKey:true }), {
    platform:'Win32',
    hasSelection:false,
  }), true);
});

test('Windows Ctrl+V 继续走浏览器原生 paste，macOS Cmd+C 路径不变', () => {
  assert.equal(shouldForwardTerminalKey(keyEvent('v', { ctrlKey:true }), {
    platform:'Win32',
  }), false);
  assert.equal(shouldForwardTerminalKey(keyEvent('c', { metaKey:true }), {
    platform:'MacIntel',
    hasSelection:true,
  }), true);
});
