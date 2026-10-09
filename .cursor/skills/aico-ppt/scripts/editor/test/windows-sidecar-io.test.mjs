import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AttachmentStore } from '../attachment-store.mjs';
import { createPersistentSidecarIO } from '../sidecar-io.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WINDOWS_HELPER = join(HERE, '..', 'sidecar_io_windows.py');
const WINDOWS_WRITER = join(HERE, '..', 'attachment_writer_windows.py');

async function identity(path) {
  const { lstat } = await import('node:fs/promises');
  const info = await lstat(path, { bigint:true });
  return {
    path, realPath:await realpath(path), dev:String(info.dev), ino:String(info.ino),
  };
}

test('Windows sidecar helper 按 file ID 接受外部改名并迁移 registry v2', async t => {
  const project = await mkdtemp(join(tmpdir(), 'deck-windows-rebind-'));
  t.after(() => rm(project, { recursive:true, force:true, maxRetries:10, retryDelay:100 }));
  const oldPath = join(project, 'before.html');
  const newPath = join(project, 'after.html');
  const bytes = Buffer.from('<!doctype html><title>windows rebind</title>');
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  const sessionName = `before-${fingerprint.slice(0, 8)}`;
  const pythonExecutable = process.env.PYTHON
    ?? (process.platform === 'win32' ? 'py.exe' : 'python3');
  await writeFile(oldPath, bytes);
  const io = await createPersistentSidecarIO({
    project:await identity(project), pythonExecutable, helperPath:WINDOWS_HELPER,
  });
  try {
    await io.ensureRoot();
    await io.prepareSession({
      deckName:'before.html', sessionId, initialFingerprint:fingerprint,
      sessionName, mode:'fresh',
    });
    await io.bindSession({ deckName:'before.html', sessionId, sessionName, create:true });
    await rename(oldPath, newPath);
    const fileIdentity = await identity(newPath);
    await io.rebindDeck({
      deckName:'after.html', expectedWitness:{ dev:fileIdentity.dev, ino:fileIdentity.ino },
    });
    assert.deepEqual(await io.hashDeck(), { fingerprint });
  } finally {
    await io.close();
  }

  const reopened = await createPersistentSidecarIO({
    project:await identity(project), pythonExecutable, helperPath:WINDOWS_HELPER,
  });
  try {
    await reopened.ensureRoot();
    const discovery = await reopened.discover({ deckName:'after.html' });
    assert.equal(discovery.registry.version, 2);
    assert.equal(discovery.sessions[0].sessionId, sessionId);
  } finally {
    await reopened.close();
  }
});

test('Windows sidecar helper 完成编辑服务启动所需的可信会话闭环', async t => {
  const project = await mkdtemp(join(tmpdir(), 'deck-windows-sidecar-'));
  t.after(() => rm(project, { recursive:true, force:true, maxRetries:10, retryDelay:100 }));
  const deckPath = join(project, 'deck.html');
  const deckBytes = Buffer.from('<!doctype html><title>deck</title>');
  const fingerprint = createHash('sha256').update(deckBytes).digest('hex');
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  const sessionName = `deck-${fingerprint.slice(0, 8)}`;
  const pythonExecutable = process.env.PYTHON
    ?? (process.platform === 'win32' ? 'py.exe' : 'python3');
  await writeFile(deckPath, deckBytes);

  const io = await createPersistentSidecarIO({
    project:await identity(project),
    pythonExecutable,
    helperPath:WINDOWS_HELPER,
    spawnHelper:(command, args, options) => spawn(command, args, {
      ...options,
      env:{
        ...process.env,
        PYTHONIOENCODING:'gbk:replace',
        PYTHONUTF8:'0',
        ...options.env,
      },
    }),
  });
  try {
    const root = await io.ensureRoot();
    assert.equal(root.backend, 'windows-path');
    assert.deepEqual(await io.discover({ deckName:'deck.html' }), {
      registry:null, sessions:[],
    });
    assert.deepEqual(await io.hashDeck(), { fingerprint });
    const entry = await io.prepareSession({
      deckName:'deck.html', sessionId, initialFingerprint:fingerprint,
      sessionName, mode:'fresh',
    });
    assert.equal(entry.status, 'preparing');
    const binding = await io.bindSession({
      deckName:'deck.html', sessionId, sessionName, create:true,
    });
    assert.equal(binding.sessionName, sessionName);
    assert.deepEqual(Object.keys(binding.identities).sort(), [
      'backups', 'session', 'snapshots', 'transactions', 'working', 'workingVersions',
      'writeErrors',
    ]);
    const attachments = await io.bindAttachments();
    assert.deepEqual(Object.keys(attachments.identities).sort(), [
      'attachmentStaging', 'attachments',
    ]);
    const state = {
      version:1, sessionId, deckPath, deckFingerprint:fingerprint,
      revision:0, tasks:[], groups:[], redo:[], unicodeProbe:'Ԥ',
    };
    await io.writeSession({ sessionId, bytes:Buffer.from(JSON.stringify(state)) });
    assert.deepEqual(await io.readSession(), state);
    await io.activateSession({ sessionId });
    const working = Buffer.from('<!doctype html><title>working</title>');
    const workingFingerprint = createHash('sha256').update(working).digest('hex');
    assert.equal((await io.writeWorkingDeck({
      sessionId, bytes:working, expectedFingerprint:null,
    })).fingerprint, workingFingerprint);
    assert.equal((await io.readWorkingDeck()).fingerprint, workingFingerprint);
    assert.deepEqual(await io.reconcileAttachments({ referencedTaskIds:[] }), {
      discardedUploads:0, deletedTasks:0,
    });
    const ids = [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ];
    const store = new AttachmentStore({
      sidecarBoundary:{
        guard:() => io.assertBound(),
        sessionDir:binding.identities.session.path,
        pythonIdentity:{ ...binding.identities, ...attachments.identities },
      },
      sidecarIO:io,
      pythonExecutable,
      writerPath:WINDOWS_WRITER,
      randomUUID:() => ids.shift(),
    });
    const upload = store.beginUpload();
    const staged = await upload.stage({
      stream:Readable.from(['Windows 附件闭环']),
      name:'probe.txt', mime:'text/plain', source:'selected',
    });
    const published = await upload.publish('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    assert.equal(published.length, 1);
    assert.equal(
      await readFile(join(binding.identities.session.path, published[0].relativePath), 'utf8'),
      'Windows 附件闭环',
    );
    const verified = await store.serializeTaskVerified({
      id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc', attachments:published,
    });
    assert.equal(verified.attachments[0].path.endsWith(`${staged.id}.txt`), true);
    assert.deepEqual(
      await store.deleteTask('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
      { removed:true },
    );
    await store.close();
    assert.deepEqual(await io.assertBound(), { safe:true });
  } finally {
    await io.close();
  }
});

test('Windows sidecar 深层 Draft 使用 extended-length path 原子写入', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-windows-long-path-'));
  t.after(() => rm(root, { recursive:true, force:true, maxRetries:10, retryDelay:100 }));
  let project = root;
  while (project.length < 225) project = join(project, 'draft-staging-segment');
  await mkdir(project, { recursive:true });
  const deckPath = join(project, 'deep-deck.html');
  const deckBytes = Buffer.from('<!doctype html><title>deep</title>');
  const fingerprint = createHash('sha256').update(deckBytes).digest('hex');
  const sessionId = '123e4567-e89b-42d3-a456-426614174001';
  const sessionName = `deep-deck-${fingerprint.slice(0, 8)}`;
  const pythonExecutable = process.env.PYTHON
    ?? (process.platform === 'win32' ? 'py.exe' : 'python3');
  await writeFile(deckPath, deckBytes);
  const io = await createPersistentSidecarIO({
    project:await identity(project), pythonExecutable, helperPath:WINDOWS_HELPER,
  });
  try {
    await io.ensureRoot();
    await io.discover({ deckName:'deep-deck.html' });
    await io.prepareSession({
      deckName:'deep-deck.html', sessionId, initialFingerprint:fingerprint,
      sessionName, mode:'fresh',
    });
    const binding = await io.bindSession({
      deckName:'deep-deck.html', sessionId, sessionName, create:true,
    });
    await io.bindAttachments();
    assert.ok(
      join(binding.identities.working.path, `.deck.html.${sessionId}.tmp`).length > 260,
      '测试路径必须实际超过传统 MAX_PATH',
    );
    const working = Buffer.from('<!doctype html><title>deep working</title>');
    const result = await io.writeWorkingDeck({
      sessionId, bytes:working, expectedFingerprint:null,
    });
    assert.equal(result.path.startsWith('\\\\?\\'), false, 'API 不应泄漏 extended path 前缀');
    assert.equal((await io.readWorkingDeck()).bytes, working.toString('base64'));
  } finally {
    await io.close();
  }
});
