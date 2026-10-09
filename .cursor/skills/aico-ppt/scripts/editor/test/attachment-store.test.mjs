import nodeTest from 'node:test';
import assert from 'node:assert/strict';

// 这里故障注入 POSIX attachment_writer.py；Windows 原生 writer 的完整
// stage/publish/verify/delete 闭环由 windows-sidecar-io.test.mjs 覆盖。
const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import {
  lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir,
  unlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AttachmentStore } from '../attachment-store.mjs';
import { createPersistentSidecarIO } from '../sidecar-io.mjs';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const FIXED_ID = '22222222-2222-4222-8222-222222222222';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function directoryIdentity(path) {
  const info = await lstat(path, { bigint:true });
  return { path:resolve(path), realPath:resolve(path), dev:String(info.dev), ino:String(info.ino) };
}

async function fixture(options = {}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'attachment-store-'));
  const root = await realpath(temporaryRoot);
  const session = join(root, 'session');
  const attachments = join(session, 'attachments');
  const staging = join(attachments, '.staging');
  await mkdir(staging, { recursive:true });
  const identities = {
    session:await directoryIdentity(session),
    attachments:await directoryIdentity(attachments),
    attachmentStaging:await directoryIdentity(staging),
  };
  const calls = { publish:[], discard:[], delete:[], verify:[] };
  const sidecarIO = {
    async publishAttachments(payload) {
      calls.publish.push(payload);
      await rename(join(staging, payload.uploadId), join(attachments, payload.taskId));
      return payload.files.map(file => ({
        id:file.id, size:file.size,
        relativePath:`attachments/${payload.taskId}/${file.id}${file.suffix}`,
      }));
    },
    async discardAttachmentUpload(payload) {
      calls.discard.push(payload);
      assert.deepEqual(Object.keys(payload).sort(), ['files', 'uploadId', 'uploadIdentity']);
      const uploadPath = join(staging, payload.uploadId);
      let uploadInfo;
      try { uploadInfo = await lstat(uploadPath, { bigint:true }); }
      catch (error) {
        if (error.code === 'ENOENT') return { removed:false };
        throw error;
      }
      assert.equal(uploadInfo.isDirectory(), true);
      assert.equal(String(uploadInfo.dev), payload.uploadIdentity.dev);
      assert.equal(String(uploadInfo.ino), payload.uploadIdentity.ino);
      const expected = new Map(payload.files.map(file => [
        `${file.id}${file.suffix}`, file,
      ]));
      const names = (await readdir(uploadPath)).sort();
      assert.deepEqual(names, [...expected.keys()].sort());
      for (const name of names) {
        const file = expected.get(name);
        const path = join(uploadPath, name);
        const info = await lstat(path, { bigint:true });
        assert.equal(info.isFile(), true);
        assert.equal(info.nlink, 1n);
        assert.equal(String(info.dev), file.identity.dev);
        assert.equal(String(info.ino), file.identity.ino);
        const bytes = await readFile(path);
        assert.equal(bytes.length, file.size);
        assert.equal(sha256(bytes), file.sha256);
      }
      await Promise.all(names.map(name => unlink(join(uploadPath, name))));
      await rmdir(uploadPath);
      return { removed:true };
    },
    async deleteTaskAttachments({ taskId }) {
      calls.delete.push(taskId);
      await rm(join(attachments, taskId), { recursive:true, force:true });
      return { removed:true };
    },
    async verifyTaskAttachments(payload) {
      calls.verify.push(payload);
      return { safe:true };
    },
    ...options.sidecarIO,
  };
  const sidecarBoundary = {
    sessionDir:session,
    session:identities.session,
    attachments:identities.attachments,
    attachmentStaging:identities.attachmentStaging,
    pythonIdentity:identities,
    guard:async () => {},
  };
  const store = new AttachmentStore({
    sidecarBoundary, sidecarIO,
    spawnAttachmentWriter:options.spawnAttachmentWriter ?? spawn,
    timeoutMs:options.timeoutMs ?? 2_000,
    killGraceMs:options.killGraceMs ?? 20,
    hardTerminationTimeoutMs:options.hardTerminationTimeoutMs ?? 100,
    randomUUID:options.randomUUID,
    now:options.now ?? (() => new Date('2026-08-02T12:00:00.000Z')),
  });
  return {
    root, session, attachments, staging, identities, calls, sidecarIO,
    sidecarBoundary, store,
    cleanup:async () => { await store.close(); await rm(root, { recursive:true, force:true }); },
  };
}

async function persistentFixture(randomUUID) {
  const temporary = await mkdtemp(join(tmpdir(), 'attachment-store-persistent-'));
  const project = await realpath(temporary);
  const root = join(project, '.aico-ppt-editor');
  const deckName = 'deck.html';
  const deckBytes = Buffer.from('deck');
  const fingerprint = sha256(deckBytes);
  const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sessionName = `deck-${fingerprint.slice(0, 8)}`;
  const session = join(root, sessionName);
  for (const name of ['snapshots', 'backups', 'transactions', 'write-errors']) {
    await mkdir(join(session, name), { recursive:true });
  }
  await writeFile(join(project, deckName), deckBytes);
  await writeFile(join(session, 'session.json'), '{}');
  const io = await createPersistentSidecarIO({
    project:await directoryIdentity(project),
    root:await directoryIdentity(root),
  });
  await io.prepareSession({
    deckName, sessionId, initialFingerprint:fingerprint, sessionName, mode:'legacy',
  });
  const core = await io.bindSession({
    deckName, sessionId, sessionName, create:false,
  });
  const attachment = await io.bindAttachments();
  const identities = { ...core.identities, ...attachment.identities };
  const calls = { discard:0 };
  const sidecarIO = {
    publishAttachments:payload => io.publishAttachments(payload),
    discardAttachmentUpload:payload => {
      calls.discard += 1;
      return io.discardAttachmentUpload(payload);
    },
    deleteTaskAttachments:payload => io.deleteTaskAttachments(payload),
    verifyTaskAttachments:payload => io.verifyTaskAttachments(payload),
  };
  const store = new AttachmentStore({
    sidecarBoundary:{
      sessionDir:identities.session.path,
      session:identities.session,
      attachments:identities.attachments,
      attachmentStaging:identities.attachmentStaging,
      pythonIdentity:identities,
      guard:() => io.assertBound(),
    },
    sidecarIO,
    randomUUID,
    timeoutMs:2_000,
    killGraceMs:20,
    hardTerminationTimeoutMs:100,
    now:() => new Date('2026-08-03T12:00:00.000Z'),
  });
  return {
    project, session, staging:identities.attachmentStaging.path,
    io, store, calls,
    cleanup:async () => {
      await store.close().catch(() => {});
      await io.close();
      await rm(project, { recursive:true, force:true });
    },
  };
}

async function waitForPath(path) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { await lstat(path); return; } catch { await new Promise(resolvePromise => setTimeout(resolvePromise, 5)); }
  }
  throw new Error(`等待路径超时：${path}`);
}

function hangingChild({ closeOnKill=true, exitCode=0, output=null } = {}) {
  const child = new EventEmitter();
  // EventEmitter 替身没有真实子进程句柄；保留事件循环直到 close/unref，
  // 否则被测代码的 unref 超时器尚未触发，测试进程就提前退出。
  const keepAlive = setInterval(() => {}, 1000);
  child.once('close', () => clearInterval(keepAlive));
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.unrefs = 0;
  child.kill = signal => {
    child.kills.push(signal);
    if (closeOnKill) queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  child.unref = () => { child.unrefs += 1; keepAlive.unref(); };
  if (output !== null) queueMicrotask(() => {
    child.stdout.end(output);
    child.stderr.end();
    child.emit('close', exitCode, null);
  });
  return child;
}

test('真实 writer 流式 stage、publish 并仅在 serialize 派生绝对 path', async t => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const bytes = Buffer.concat([Buffer.from('reference-'), Buffer.alloc(8192, 7)]);
  const upload = fx.store.beginUpload();
  const staged = await upload.stage({
    stream:Readable.from([bytes.subarray(0, 10), bytes.subarray(10)]),
    name:'新版架构.PNG', mime:'image/png', source:'selected',
  });
  assert.equal(staged.size, bytes.length);
  assert.equal(staged.sha256, sha256(bytes));
  assert.equal(staged.suffix, '.png');
  assert.equal(Object.hasOwn(staged, 'path'), false);

  const descriptors = await upload.publish(TASK_ID);
  assert.equal(upload.published, true);
  assert.equal(fx.calls.publish[0].files[0].sha256, sha256(bytes));
  assert.equal(descriptors.length, 1);
  assert.equal(Object.hasOwn(descriptors[0], 'path'), false);
  assert.deepEqual(Object.keys(descriptors[0]).sort(), [
    'createdAt', 'id', 'mime', 'name', 'relativePath', 'size', 'source',
  ]);
  assert.equal(await readFile(join(fx.attachments, TASK_ID, `${staged.id}.png`), 'utf8'), bytes.toString());

  const task = { id:TASK_ID, attachments:descriptors };
  const serialized = fx.store.serializeTask(task);
  assert.equal(
    serialized.attachments[0].path,
    join(fx.attachments, TASK_ID, `${staged.id}.png`),
  );
  assert.equal(Object.hasOwn(task.attachments[0], 'path'), false);
  const verified = await fx.store.serializeTaskVerified(task);
  assert.equal(verified.attachments[0].path, serialized.attachments[0].path);
  assert.deepEqual(fx.calls.verify, [{
    taskId:TASK_ID,
    files:[{
      id:staged.id,
      relativePath:descriptors[0].relativePath,
      size:bytes.length,
    }],
  }]);
});

test('stage 调用独立 spawnAttachmentWriter 注入点并按序执行多文件', async t => {
  let active = 0;
  let maximum = 0;
  const seen = [];
  const spawnAttachmentWriter = (command, args, options) => {
    assert.equal(command, 'python3');
    assert.equal(args[0], '-u');
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(options.env.PYTHONIOENCODING, 'utf-8');
    assert.equal(options.env.PYTHONUTF8, '1');
    const config = JSON.parse(args[args.indexOf('--config') + 1]);
    const child = hangingChild();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) { seen.push(Buffer.from(chunk)); callback(); },
      final(callback) {
        active += 1;
        maximum = Math.max(maximum, active);
        setTimeout(() => {
          const bytes = Buffer.concat(seen.splice(0));
          child.stdout.end(`${JSON.stringify({
            ok:true, uploadId:config.uploadId, attachmentId:config.attachmentId,
            suffix:config.suffix,
            path:join(config.attachmentStaging.path, config.uploadId,
              `${config.attachmentId}${config.suffix}`),
            size:bytes.length, sha256:sha256(bytes),
            uploadIdentity:{ dev:'1', ino:'10', mountDev:'1', mountId:'20' },
            fileIdentity:{
              dev:'1', ino:String(100 + config.attachmentId.charCodeAt(0)),
              mountDev:'1', mountId:'20',
            },
          })}\n`);
          active -= 1;
          child.emit('close', 0, null);
        }, 10);
        callback();
      },
    });
    return child;
  };
  const fx = await fixture({ spawnAttachmentWriter });
  t.after(fx.cleanup);
  const upload = fx.store.beginUpload();
  const first = upload.stage({ stream:Readable.from(['one']), name:'one.txt', mime:'text/plain', source:'selected' });
  const second = upload.stage({ stream:Readable.from(['two']), name:'two.txt', mime:'text/plain', source:'selected' });
  const staged = await Promise.all([first, second]);
  assert.equal(maximum, 1);
  assert.equal(staged.length, 2);
});

test('stream 截断错误会杀死 writer，并冻结无 receipt partial 留给 reconcile', async t => {
  const ids = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  ];
  const fx = await fixture({ randomUUID:() => ids.shift() });
  t.after(fx.cleanup);
  const upload = fx.store.beginUpload();
  await upload.stage({ stream:Readable.from(['first']), name:'first.txt', mime:'text/plain', source:'selected' });
  const broken = new PassThrough();
  const staging = upload.stage({ stream:broken, name:'broken.txt', mime:'text/plain', source:'selected' });
  broken.write('partial');
  const partial = join(fx.staging, upload.id, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc.txt');
  // 先证明 writer 已写入，再注入截断；无界 _read 推送会把测试变成背压/进程启动竞速。
  await waitForPath(partial);
  broken.destroy(Object.assign(new Error('truncated'), { code:'ECONNRESET' }));
  await assert.rejects(staging, error => error.code === 'ATTACHMENT_STREAM_ERROR');
  assert.equal(await readFile(partial, 'utf8'), 'partial');
  assert.deepEqual(await lstat(join(fx.staging, upload.id)).then(() => 'exists', () => 'missing'), 'exists');
  assert.equal(fx.calls.discard.length, 0);
  assert.deepEqual(await upload.discard(), {
    removed:false, retained:true, reason:'untrusted-baseline',
  });
});

test('真实 Store+PersistentSidecarIO 对无 receipt partial 冻结并留给 reconcile', async t => {
  const ids = [
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  ];
  const fx = await persistentFixture(() => ids.shift());
  t.after(fx.cleanup);
  const upload = fx.store.beginUpload();
  await upload.stage({
    stream:Readable.from(['trusted']), name:'first.txt', mime:'text/plain', source:'selected',
  });
  const second = new PassThrough();
  const staging = upload.stage({
    stream:second, name:'second.txt', mime:'text/plain', source:'selected',
  });
  second.write('partial');
  const partial = join(fx.staging, upload.id, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd.txt');
  await waitForPath(partial);
  second.destroy(new Error('truncated'));
  await assert.rejects(staging, error => error.code === 'ATTACHMENT_STREAM_ERROR');
  assert.equal(fx.calls.discard, 0, '无 writer cleanup receipt 时不得尝试 helper discard');
  assert.equal(await readFile(partial, 'utf8'), 'partial');

  await fx.store.close();
  assert.deepEqual((await readdir(fx.staging)).sort(), [upload.id]);
  assert.deepEqual(
    await fx.io.reconcileAttachments({ referencedTaskIds:[] }),
    { discardedUploads:1, deletedTasks:0 },
  );
  assert.deepEqual(await readdir(fx.staging), []);
});

test('真实 Store+writer 遇到 upload/target replacement 不按旧 uploadId 补偿删除', async t => {
  const ids = [
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
  ];
  const fx = await fixture({ randomUUID:() => ids.shift() });
  t.after(fx.cleanup);
  const upload = fx.store.beginUpload();
  const input = new PassThrough();
  const staged = upload.stage({ stream:input, name:'race.txt', mime:'text/plain', source:'selected' });
  input.write('prefix');
  const target = join(fx.staging, upload.id, '44444444-4444-4444-8444-444444444444.txt');
  await waitForPath(target);
  await rm(target);
  await writeFile(target, 'target-replacement');
  input.end('suffix');
  await assert.rejects(staged, error => error.code === 'UNSAFE_SIDECAR_IO');
  assert.equal(await readFile(target, 'utf8'), 'target-replacement');
  assert.equal(fx.calls.discard.length, 0, '不可信 writer cleanup 不得仅凭 uploadId 调 helper');

  const uploadIds = [
    '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666',
  ];
  const replacementFx = await fixture({ randomUUID:() => uploadIds.shift() });
  t.after(replacementFx.cleanup);
  const replacementUpload = replacementFx.store.beginUpload();
  const replacementInput = new PassThrough();
  const replacementStage = replacementUpload.stage({
    stream:replacementInput, name:'race.txt', mime:'text/plain', source:'selected',
  });
  replacementInput.write('prefix');
  const uploadPath = join(replacementFx.staging, replacementUpload.id);
  const uploadTarget = join(uploadPath, '66666666-6666-4666-8666-666666666666.txt');
  await waitForPath(uploadTarget);
  await rename(uploadPath, `${uploadPath}.held`);
  await mkdir(uploadPath);
  const marker = join(uploadPath, 'replacement-marker');
  await writeFile(marker, 'keep');
  replacementInput.end('suffix');
  await assert.rejects(replacementStage, error => error.code === 'UNSAFE_SIDECAR_IO');
  assert.equal(await readFile(marker, 'utf8'), 'keep');
  assert.equal(replacementFx.calls.discard.length, 0);
});

test('真实 store 保留 writer 的空文件与 25 MiB 超限稳定错误码', async t => {
  const fx = await fixture();
  t.after(fx.cleanup);
  await assert.rejects(
    fx.store.beginUpload().stage({
      stream:Readable.from([]), name:'empty.bin', mime:'', source:'selected',
    }),
    error => error.code === 'ATTACHMENT_EMPTY',
  );
  async function* oversized() {
    const chunk = Buffer.alloc(1024 * 1024, 3);
    for (let index = 0; index < 26; index += 1) yield chunk;
  }
  await assert.rejects(
    fx.store.beginUpload().stage({
      stream:Readable.from(oversized()), name:'large.bin', mime:'', source:'selected',
    }),
    error => error.code === 'ATTACHMENT_TOO_LARGE',
  );
});

test('重复 attachment ID fail-closed 并清理已暂存文件', async t => {
  const fx = await fixture({ randomUUID:() => FIXED_ID });
  t.after(fx.cleanup);
  const upload = fx.store.beginUpload();
  await upload.stage({ stream:Readable.from(['first']), name:'first.txt', mime:'text/plain', source:'selected' });
  await assert.rejects(
    upload.stage({ stream:Readable.from(['second']), name:'second.txt', mime:'text/plain', source:'selected' }),
    error => error.code === 'ATTACHMENT_ID_COLLISION',
  );
  assert.equal(fx.calls.discard.length, 1);
});

test('writer timeout、非零 exit 与超量 stdout 各自只 settle 一次并杀死 child', async t => {
  const children = [];
  const fx = await fixture({
    timeoutMs:20,
    spawnAttachmentWriter:() => {
      const child = hangingChild({ closeOnKill:true });
      children.push(child);
      return child;
    },
  });
  t.after(fx.cleanup);
  await assert.rejects(
    fx.store.beginUpload().stage({ stream:Readable.from(['data']), name:'a.bin', mime:'', source:'selected' }),
    error => error.code === 'ATTACHMENT_WRITER_TIMEOUT',
  );
  assert.deepEqual(children[0].kills, ['SIGKILL']);

  const exited = await fixture({
    spawnAttachmentWriter:() => hangingChild({ output:'writer failed', exitCode:7 }),
  });
  t.after(exited.cleanup);
  await assert.rejects(
    exited.store.beginUpload().stage({ stream:Readable.from(['x']), name:'b.bin', mime:'', source:'selected' }),
    error => error.code === 'ATTACHMENT_WRITE_FAILED',
  );

  const overflow = await fixture({
    spawnAttachmentWriter:() => hangingChild({ output:'x'.repeat(64 * 1024 + 1), exitCode:0 }),
  });
  t.after(overflow.cleanup);
  await assert.rejects(
    overflow.store.beginUpload().stage({ stream:Readable.from(['x']), name:'c.bin', mime:'', source:'selected' }),
    error => error.code === 'ATTACHMENT_WRITER_OUTPUT_LIMIT',
  );
});

test('child error 必须 kill 并等待真实 close 后才注销 active writer', async t => {
  const child = hangingChild({ closeOnKill:false });
  const fx = await fixture({
    killGraceMs:20,
    spawnAttachmentWriter:() => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('child error'), {
        code:'ECHILD',
      })));
      setTimeout(() => child.emit('close', null, 'SIGKILL'), 30);
      return child;
    },
  });
  t.after(fx.cleanup);
  await assert.rejects(
    fx.store.beginUpload().stage({
      stream:Readable.from(['data']), name:'error.bin', mime:'', source:'selected',
    }),
    error => error.code === 'ATTACHMENT_WRITE_FAILED',
  );
  assert.ok(child.kills.length >= 1);
  assert.ok(child.kills.every(signal => signal === 'SIGKILL'));
  assert.equal(fx.store.activeWriters.size, 0);
});

test('绝对终止超时只结算 stage，真实 close 前 discard/store.close 不成功且 active 保留', async t => {
  for (const operation of ['discard', 'close']) {
    await t.test(operation, async () => {
      const child = hangingChild({ closeOnKill:false });
      const fx = await fixture({
        timeoutMs:5_000,
        killGraceMs:5,
        hardTerminationTimeoutMs:20,
        spawnAttachmentWriter:() => child,
      });
      const upload = fx.store.beginUpload();
      const stageOutcome = upload.stage({
        stream:Readable.from(['data']), name:'pending.bin', mime:'', source:'selected',
      }).then(
        () => ({ ok:true }),
        error => ({ ok:false, error }),
      );
      await new Promise(resolvePromise => setImmediate(resolvePromise));
      let lifecycleSettled = false;
      const lifecycle = (operation === 'discard' ? upload.discard() : fx.store.close())
        .finally(() => { lifecycleSettled = true; });
      const outcome = await stageOutcome;
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error.code, 'ATTACHMENT_WRITER_TERMINATION_TIMEOUT');
      assert.equal(lifecycleSettled, false);
      assert.equal(fx.store.activeWriters.size, 1);
      assert.ok(child.kills.includes('SIGKILL'));
      assert.equal(child.unrefs, 0, 'sync-pending child 必须继续保持 event-loop 跟踪');
      child.emit('close', null, 'SIGKILL');
      await lifecycle;
      assert.equal(fx.store.activeWriters.size, 0);
      if (operation === 'discard') await fx.store.close();
      await rm(fx.root, { recursive:true, force:true });
    });
  }
});

test('stage 已终止超时后并发 discard 共享 drain 并等待真实 close', async t => {
  const child = hangingChild({ closeOnKill:false });
  const fx = await fixture({
    timeoutMs:5,
    killGraceMs:5,
    hardTerminationTimeoutMs:20,
    spawnAttachmentWriter:() => child,
  });
  t.after(async () => {
    child.emit('close', null, 'SIGKILL');
    await fx.store.close().catch(() => {});
    await rm(fx.root, { recursive:true, force:true });
  });
  const upload = fx.store.beginUpload();
  await assert.rejects(
    upload.stage({
      stream:Readable.from(['data']), name:'pending.bin', mime:'', source:'selected',
    }),
    error => error.code === 'ATTACHMENT_WRITER_TERMINATION_TIMEOUT',
  );
  assert.equal(fx.store.activeWriters.size, 1);
  const killsBeforeDiscard = child.kills.length;
  let settled = 0;
  const discards = [upload.discard(), upload.discard()].map(promise => promise.then(result => {
    settled += 1;
    return result;
  }));
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(settled, 0);
  assert.equal(fx.store.activeWriters.size, 1);
  assert.equal(child.kills.length, killsBeforeDiscard, '幂等 cancel 不得重复 kill');

  child.emit('close', null, 'SIGKILL');
  assert.deepEqual(await Promise.all(discards), [
    { removed:false, retained:true, reason:'untrusted-baseline' },
    { removed:false, retained:true, reason:'untrusted-baseline' },
  ]);
  assert.equal(fx.store.activeWriters.size, 0);
  assert.equal(child.kills.length, killsBeforeDiscard);
});

test('discard 和 store.close 会中止 active writer 并等待资源收敛', async t => {
  const children = [];
  const fx = await fixture({
    timeoutMs:5_000,
    spawnAttachmentWriter:() => {
      const child = hangingChild();
      children.push(child);
      return child;
    },
  });
  t.after(async () => { await rm(fx.root, { recursive:true, force:true }); });
  const upload = fx.store.beginUpload();
  const pending = upload.stage({ stream:Readable.from(['data']), name:'a.txt', mime:'text/plain', source:'selected' });
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  await upload.discard();
  await assert.rejects(pending, error => error.code === 'ATTACHMENT_UPLOAD_ABORTED');
  assert.deepEqual(children[0].kills, ['SIGKILL']);

  const other = fx.store.beginUpload();
  const otherPending = other.stage({ stream:Readable.from(['data']), name:'b.txt', mime:'text/plain', source:'selected' });
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  await fx.store.close();
  await assert.rejects(otherPending, error => error.code === 'ATTACHMENT_STORE_CLOSED');
  assert.deepEqual(children[1].kills, ['SIGKILL']);
});

test('store.close 等待 active 与排队 stage 都完成单次拒绝', async t => {
  const child = hangingChild();
  const fx = await fixture({
    timeoutMs:5_000,
    spawnAttachmentWriter:() => child,
  });
  t.after(async () => { await rm(fx.root, { recursive:true, force:true }); });
  const upload = fx.store.beginUpload();
  let firstSettled = false;
  let secondSettled = false;
  const first = upload.stage({
    stream:Readable.from(['first']), name:'first.txt', mime:'text/plain', source:'selected',
  }).finally(() => { firstSettled = true; });
  const second = upload.stage({
    stream:Readable.from(['second']), name:'second.txt', mime:'text/plain', source:'selected',
  }).finally(() => { secondSettled = true; });
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  await fx.store.close();
  assert.equal(firstSettled, true);
  assert.equal(secondSettled, true);
  await assert.rejects(first, error => error.code === 'ATTACHMENT_STORE_CLOSED');
  await assert.rejects(second, error => error.code === 'ATTACHMENT_STORE_CLOSED');
  assert.deepEqual(child.kills, ['SIGKILL']);
});

test('publish no-replace 与 committed 错误原样透传且补偿语义明确', async t => {
  const noReplace = Object.assign(new Error('exists'), {
    code:'UNSAFE_SIDECAR_IO', stage:'attachment-publish', committed:false,
  });
  const fx = await fixture({ sidecarIO:{ publishAttachments:async () => { throw noReplace; } } });
  t.after(fx.cleanup);
  const upload = fx.store.beginUpload();
  await upload.stage({ stream:Readable.from(['data']), name:'a.txt', mime:'text/plain', source:'selected' });
  await assert.rejects(upload.publish(TASK_ID), error => error === noReplace);
  assert.equal(upload.published, false);
  await upload.discard();

  const committed = Object.assign(new Error('fsync lost ack'), {
    code:'ATTACHMENT_PUBLISH_FAILED', stage:'attachment-directory-fsync',
    committed:true, commitScope:'attachments', details:{ renamed:true },
  });
  const committedFx = await fixture({ sidecarIO:{ publishAttachments:async () => { throw committed; } } });
  t.after(committedFx.cleanup);
  const committedUpload = committedFx.store.beginUpload();
  await committedUpload.stage({ stream:Readable.from(['data']), name:'b.txt', mime:'text/plain', source:'selected' });
  await assert.rejects(committedUpload.publish(TASK_ID), error => error === committed);
  assert.equal(committedUpload.published, true);
  await committedUpload.discard();
  assert.equal(committedFx.calls.discard.length, 0);
});

test('stage 失败后的 committed cleanup 包装保留 helper 语义并以原错误为 cause', async t => {
  const cleanup = Object.assign(new Error('unlink 后 upload fsync 失败'), {
    code:'ATTACHMENT_DELETE_FAILED', statusCode:500, stage:'attachment-delete',
    committed:true, commitScope:'attachments',
    details:{ target:'upload', unlinkedFiles:1, directoryRemoved:false },
  });
  let spawnCalls = 0;
  const fx = await fixture({
    spawnAttachmentWriter:(command, args, options) => {
      spawnCalls += 1;
      if (spawnCalls === 1) return spawn(command, args, options);
      return hangingChild({
        exitCode:1,
        output:`${JSON.stringify({
          ok:false, code:'ATTACHMENT_EMPTY', stage:'attachment-limit',
          message:'empty', committed:false, cleanupSafe:true,
        })}\n`,
      });
    },
    sidecarIO:{ discardAttachmentUpload:async () => { throw cleanup; } },
  });
  t.after(async () => { await fx.store.close().catch(() => {}); await rm(fx.root, { recursive:true, force:true }); });
  const upload = fx.store.beginUpload();
  await upload.stage({ stream:Readable.from(['first']), name:'first.txt', mime:'text/plain', source:'selected' });
  await assert.rejects(
    upload.stage({
      stream:Readable.from([]), name:'empty.txt', mime:'text/plain', source:'selected',
    }),
    error => (
      error !== cleanup
      && error.code === cleanup.code
      && error.stage === cleanup.stage
      && error.committed === true
      && error.commitScope === cleanup.commitScope
      && error.details === cleanup.details
      && error.cause?.code === 'ATTACHMENT_EMPTY'
    ),
  );
});

test('publish 同步封存 upload，重复调用只执行一次 helper', async t => {
  const fx = await fixture();
  t.after(fx.cleanup);
  let publishCalls = 0;
  let releasePublish;
  const publishGate = new Promise(resolvePromise => { releasePublish = resolvePromise; });
  fx.sidecarIO.publishAttachments = async payload => {
    publishCalls += 1;
    await publishGate;
    return payload.files.map(file => ({
      id:file.id, size:file.size,
      relativePath:`attachments/${payload.taskId}/${file.id}${file.suffix}`,
    }));
  };
  const upload = fx.store.beginUpload();
  await upload.stage({
    stream:Readable.from(['first']), name:'first.txt', mime:'text/plain', source:'selected',
  });
  const firstPublish = upload.publish(TASK_ID);
  const repeatedPublish = upload.publish(TASK_ID);
  await assert.rejects(
    upload.stage({
      stream:Readable.from(['late']), name:'late.txt', mime:'text/plain', source:'selected',
    }),
    error => error.code === 'ATTACHMENT_UPLOAD_CLOSED',
  );
  releasePublish();
  const [first, repeated] = await Promise.all([firstPublish, repeatedPublish]);
  assert.deepEqual(repeated, first);
  assert.equal(publishCalls, 1);
});

test('helper 已提交但 relativePath suffix 不匹配时进入 publish-uncertain 且不返回 DTO', async t => {
  const fx = await fixture();
  t.after(fx.cleanup);
  fx.sidecarIO.publishAttachments = async payload => payload.files.map(file => ({
    id:file.id, size:file.size,
    relativePath:`attachments/${payload.taskId}/${file.id}.forged`,
  }));
  const upload = fx.store.beginUpload();
  await upload.stage({ stream:Readable.from(['data']), name:'a.txt', mime:'text/plain', source:'selected' });
  await assert.rejects(
    upload.publish(TASK_ID),
    error => error.code === 'ATTACHMENT_PUBLISH_PROTOCOL'
      && error.committed === true && error.commitScope === 'attachments',
  );
  assert.equal(upload.state, 'publish-uncertain');
  assert.equal(upload.descriptors, null);
  assert.equal(upload.published, true);
});

test('queued stage 在状态检查失败时也释放 reservedIds', async t => {
  const ids = [
    '77777777-7777-4777-8777-777777777777',
    '88888888-8888-4888-8888-888888888888',
    '99999999-9999-4999-8999-999999999999',
  ];
  const child = hangingChild();
  const fx = await fixture({ randomUUID:() => ids.shift(), spawnAttachmentWriter:() => child });
  t.after(async () => { await rm(fx.root, { recursive:true, force:true }); });
  const upload = fx.store.beginUpload();
  const first = upload.stage({ stream:Readable.from(['first']), name:'first.txt', mime:'text/plain', source:'selected' });
  const second = upload.stage({ stream:Readable.from(['second']), name:'second.txt', mime:'text/plain', source:'selected' });
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  await upload.discard();
  await assert.rejects(first);
  await assert.rejects(second);
  assert.equal(upload.reservedIds.size, 0);
  await fx.store.close();
});

test('serializeTask 重新净化 DTO 并拒绝不可信 relativePath', async t => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const base = {
    id:FIXED_ID, name:'a.png', mime:'image/png', size:4, source:'selected',
    relativePath:`attachments/${TASK_ID}/${FIXED_ID}.png`,
    createdAt:'2026-08-02T12:00:00.000Z',
  };
  assert.throws(() => fx.store.serializeTask({
    id:TASK_ID,
    attachments:[{ ...base, relativePath:'../../outside' }],
  }), /相对路径/);
  assert.throws(() => fx.store.serializeTask({
    id:TASK_ID,
    attachments:[{ ...base, path:'/tmp/forged' }],
  }), /字段/);
});
