import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  ATTACHMENT_SOURCES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  validateAttachmentMetadata,
  validateFileLike,
} from '../attachment-protocol.mjs';
import { resolveAttachmentPath } from '../attachment-paths.mjs';

const taskId = '11111111-1111-4111-8111-111111111111';
const attachmentId = '22222222-2222-4222-8222-222222222222';
const metadata = {
  id: attachmentId,
  name: '新版架构.png',
  mime: 'image/png',
  size: 8,
  source: 'selected',
  relativePath: `attachments/${taskId}/${attachmentId}.png`,
  createdAt: '2026-08-02T12:00:00.000Z',
};

test('附件元数据严格接受 session 相对路径', () => {
  const value = validateAttachmentMetadata(metadata, taskId);
  assert.equal(value.name, '新版架构.png');
  assert.notEqual(value, metadata);
  assert.deepEqual(Object.keys(value).sort(), [
    'createdAt', 'id', 'mime', 'name', 'relativePath', 'size', 'source',
  ]);
});

test('附件元数据 fail-closed 拒绝隐藏键、Symbol 与访问器', () => {
  const hiddenPath = { ...metadata };
  Object.defineProperty(hiddenPath, 'path', { value: '/tmp/secret', enumerable: false });
  const symbolPath = { ...metadata, [Symbol('path')]: '/tmp/secret' };
  const accessor = { ...metadata };
  let getterCalls = 0;
  Object.defineProperty(accessor, 'name', {
    enumerable: true,
    get() { getterCalls += 1; return 'getter.png'; },
  });
  for (const value of [hiddenPath, symbolPath, accessor]) {
    assert.throws(() => validateAttachmentMetadata(value, taskId), /字段/);
  }
  assert.equal(getterCalls, 0);
});

test('附件 name 保留语义 ZWJ/ZWNJ，但拒绝控制、双向和危险不可见 Unicode', () => {
  for (const safe of ['家庭👨‍👩‍👧‍👦.png', 'گزارش‌نهایی.png']) {
    assert.equal(validateAttachmentMetadata({ ...metadata, name: safe }, taskId).name, safe);
  }
  for (const unsafe of [
    'normal\u0000.png', 'report\u202Egnp.exe', 'scope\u2066name', 'scope\u2069name',
    'zero\u200Bwidth.png', 'bom\uFEFFname.png', 'surrogate\uD800.png',
  ]) {
    assert.throws(() => validateAttachmentMetadata({ ...metadata, name: unsafe }, taskId));
  }
  for (const unsafe of ['text/\u202Eplain', 'text/\u2066plain', 'text/\u200Bplain', 'text/\uD800plain']) {
    assert.throws(() => validateAttachmentMetadata({ ...metadata, mime: unsafe }, taskId));
  }
});

test('附件 source 白名单不信任公开可变集合', () => {
  ATTACHMENT_SOURCES.add('remote');
  try {
    assert.throws(() => validateAttachmentMetadata({ ...metadata, source: 'remote' }, taskId), /来源/);
  } finally {
    ATTACHMENT_SOURCES.delete('remote');
  }
});

test('附件元数据拒绝伪造 ID、非法显示名、时间、来源和路径', () => {
  for (const value of [
    { ...metadata, id: '22222222-2222-3222-8222-222222222222' },
    { ...metadata, name: 'bad\u0000name.png' },
    { ...metadata, name: 'a'.repeat(241) },
    { ...metadata, source: 'remote' },
    { ...metadata, createdAt: 'not-a-time' },
    { ...metadata, relativePath: `attachments/${taskId}/33333333-3333-4333-8333-333333333333.png` },
    { ...metadata, relativePath: `attachments/33333333-3333-4333-8333-333333333333/${attachmentId}.png` },
    { ...metadata, relativePath: `attachments/${taskId}/${attachmentId}.png/../outside` },
    { ...metadata, relativePath: `attachments\\${taskId}\\${attachmentId}.png` },
    { ...metadata, path: '/tmp/should-not-persist' },
  ]) {
    assert.throws(() => validateAttachmentMetadata(value, taskId));
  }
});

test('附件元数据拒绝空文件、超限文件和非精确 DTO', () => {
  for (const value of [
    { ...metadata, size: 0 },
    { ...metadata, size: MAX_ATTACHMENT_BYTES + 1 },
    { ...metadata, size: 1.5 },
    { ...metadata, mime: 1 },
    { ...metadata, relativePath: `attachments/${taskId}/${attachmentId}.tar.gz` },
    Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'mime')),
  ]) {
    assert.throws(() => validateAttachmentMetadata(value, taskId));
  }
});

test('File-like 校验维持附件限额与允许来源', () => {
  assert.equal(MAX_ATTACHMENTS, 8);
  assert.equal(MAX_ATTACHMENT_BYTES, 25 * 1024 * 1024);
  assert.deepEqual([...ATTACHMENT_SOURCES], ['selected', 'pasted']);
  assert.equal(validateFileLike({ name: 'normal.txt', size: 1, type: 'text/plain' }).size, 1);
  assert.throws(() => validateFileLike({ name: 'empty.txt', size: 0, type: 'text/plain' }), /空文件/);
  assert.throws(() => validateFileLike({ name: 'large.bin', size: MAX_ATTACHMENT_BYTES + 1, type: 'application/octet-stream' }), /25 MiB/);
  assert.throws(() => validateFileLike({ name: 'fraction.bin', size: 1.5, type: '' }), /有效文件/);
});

test('Node 路径解析仅允许匹配的 attachments 相对路径', () => {
  const sessionDir = '/tmp/deck-editor-session';
  assert.equal(
    resolveAttachmentPath(sessionDir, metadata.relativePath),
    resolve(sessionDir, metadata.relativePath),
  );
  for (const relativePath of [
    '../outside',
    '/tmp/outside',
    `attachments/${taskId}/../${attachmentId}.png`,
    `attachments/${taskId}/${attachmentId}.png/`,
    `attachments/${taskId}\\${attachmentId}.png`,
    `attachments/${taskId}/${attachmentId}.png%2f..`,
  ]) {
    assert.throws(() => resolveAttachmentPath(sessionDir, relativePath), /相对路径/);
  }
});
