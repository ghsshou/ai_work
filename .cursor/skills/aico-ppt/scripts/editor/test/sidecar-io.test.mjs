import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 本文件专门故障注入 POSIX dirfd helper；Windows 由
// windows-sidecar-io.test.mjs 覆盖原生 handle/映射盘闭环。
const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;

// 模拟真实子进程的活动句柄，避免 unref 请求超时器使测试提前退出。
function keepMockProcessAlive(child, t) {
  const timer = setInterval(() => {}, 1000);
  child.once('close', () => clearInterval(timer));
  t.after(() => clearInterval(timer));
}

async function identity(path) {
  const { lstat } = await import('node:fs/promises');
  const info = await lstat(path, { bigint:true });
  return {
    path,
    realPath:await realpath(path),
    dev:String(info.dev),
    ino:String(info.ino),
  };
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('持久 helper 在同目录外部改名后按文件见证重新绑定且保留原 session', async t => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  const project = await mkdtemp(join(tmpdir(), 'deck-sidecar-rebind-'));
  t.after(() => rm(project, { recursive:true, force:true }));
  const oldPath = join(project, 'before.html');
  const newPath = join(project, 'after.html');
  const contents = Buffer.from('<!doctype html><title>rebind</title>');
  const fingerprint = sha256(contents);
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  const sessionName = `before-${fingerprint.slice(0, 8)}`;
  await writeFile(oldPath, contents);
  const io = await createPersistentSidecarIO({ project:await identity(project) });
  try {
    await io.ensureRoot();
    await io.prepareSession({
      deckName:'before.html', sessionId, initialFingerprint:fingerprint,
      sessionName, mode:'fresh',
    });
    await io.bindSession({ deckName:'before.html', sessionId, sessionName, create:true });
    await rename(oldPath, newPath);
    const fileIdentity = await identity(newPath);

    const rebound = await io.rebindDeck({
      deckName:'after.html',
      expectedWitness:{ dev:fileIdentity.dev, ino:fileIdentity.ino },
    });

    assert.equal(rebound.deckName, 'after.html');
    assert.deepEqual(await io.hashDeck(), { fingerprint });
  } finally {
    await io.close();
  }

  const reopened = await createPersistentSidecarIO({ project:await identity(project) });
  try {
    await reopened.ensureRoot();
    const discovery = await reopened.discover({ deckName:'after.html' });
    assert.equal(discovery.registry.version, 2);
    assert.equal(discovery.sessions[0].sessionId, sessionId);
    assert.equal(discovery.sessions[0].sessionName, sessionName);
  } finally {
    await reopened.close();
  }
});

test('持久 helper 长期持有 root dirfd，换根后 discover 仍只读取原目录', async () => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  assert.equal(typeof createPersistentSidecarIO, 'function');

  const project = await mkdtemp(join(tmpdir(), 'deck-sidecar-persistent-'));
  const root = join(project, '.aico-ppt-editor');
  await mkdir(root);
  const io = await createPersistentSidecarIO({
    project:await identity(project),
    root:await identity(root),
  });
  const trusted = `${root}.trusted`;
  await rename(root, trusted);
  await mkdir(join(root, 'deck-deadbeef', 'transactions'), { recursive:true });
  await writeFile(
    join(root, 'deck-deadbeef', 'transactions', '123e4567-e89b-42d3-a456-426614174000.json'),
    '{}',
  );

  try {
    const result = await io.discover({ deckName:'deck.html' });
    assert.deepEqual(result, { registry:null, sessions:[] });
  } finally {
    await io.close();
  }
});

test('session/transaction/backup/deck 的实际读取只走已绑定 dirfd 且 API 无通用文件能力', async () => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  const project = await mkdtemp(join(tmpdir(), 'deck-sidecar-bound-'));
  const root = join(project, '.aico-ppt-editor');
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  const transactionId = '123e4567-e89b-42d3-a456-426614174000';
  const deckBytes = Buffer.from('trusted-deck');
  const fingerprint = sha256(deckBytes);
  const sessionName = `deck-${fingerprint.slice(0, 8)}`;
  const session = join(root, sessionName);
  const backupName = `deck-${fingerprint}.html`;
  const sessionState = { source:'trusted-session' };
  const transaction = { source:'trusted-transaction' };
  await mkdir(join(session, 'snapshots'), { recursive:true });
  await mkdir(join(session, 'backups'));
  await mkdir(join(session, 'transactions'));
  await mkdir(join(session, 'write-errors'));
  await writeFile(join(project, 'deck.html'), deckBytes);
  await writeFile(join(session, 'session.json'), JSON.stringify(sessionState));
  await writeFile(join(session, 'transactions', `${transactionId}.json`), JSON.stringify(transaction));
  await writeFile(join(session, 'backups', backupName), deckBytes);

  const io = await createPersistentSidecarIO({
    project:await identity(project),
    root:await identity(root),
  });
  try {
    await io.prepareSession({
      deckName:'deck.html', sessionId, initialFingerprint:fingerprint,
      sessionName, mode:'legacy',
    });
    const binding = await io.bindSession({ deckName:'deck.html', sessionId, sessionName, create:false });
    assert.deepEqual(Object.keys(binding.identities).sort(), [
      'backups', 'session', 'snapshots', 'transactions', 'working', 'workingVersions',
      'writeErrors',
    ]);
    assert.deepEqual((await readdir(session)).sort(), [
      'backups', 'session.json', 'snapshots', 'transactions', 'working', 'write-errors',
    ]);
    const attachmentBinding = await io.bindAttachments();
    assert.deepEqual(Object.keys(attachmentBinding.identities).sort(), [
      'attachmentStaging', 'attachments',
    ]);
    assert.deepEqual(
      (await readdir(join(session, 'attachments'))).sort(),
      ['.staging'],
    );
    assert.equal(io.atomicWrite, undefined);
    assert.equal(io.read, undefined);
    assert.equal(io.ensureBackup, undefined);

    const movedProject = `${project}.trusted`;
    await rename(project, movedProject);
    const forgedSession = join(project, '.aico-ppt-editor', sessionName);
    await mkdir(join(forgedSession, 'backups'), { recursive:true });
    await mkdir(join(forgedSession, 'transactions'));
    await writeFile(join(project, 'deck.html'), 'forged-deck');
    await writeFile(join(forgedSession, 'session.json'), JSON.stringify({ source:'forged' }));
    await writeFile(
      join(forgedSession, 'transactions', `${transactionId}.json`),
      JSON.stringify({ source:'forged' }),
    );
    await writeFile(join(forgedSession, 'backups', backupName), 'forged-backup');

    assert.deepEqual(await io.readSession(), sessionState);
    assert.deepEqual(await io.readTransaction({ transactionId }), transaction);
    assert.deepEqual(await io.listTransactions(), [transactionId]);
    assert.deepEqual(
      await io.verifyBackup({ backupName, expectedFingerprint:fingerprint }),
      { fingerprint },
    );
    assert.deepEqual(await io.hashDeck(), { fingerprint });
  } finally {
    await io.close();
  }
});

test('托管工作副本按指纹写入、归档并可恢复历史版本', async () => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  const project = await mkdtemp(join(tmpdir(), 'deck-working-copy-'));
  const deckBytes = Buffer.from('real-deck');
  const fingerprint = sha256(deckBytes);
  const root = join(project, '.aico-ppt-editor');
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  const sessionName = `deck-${fingerprint.slice(0, 8)}`;
  await writeFile(join(project, 'deck.html'), deckBytes);
  const io = await createPersistentSidecarIO({ project:await identity(project) });
  try {
    await io.ensureRoot();
    await io.prepareSession({
      deckName:'deck.html', sessionId, initialFingerprint:fingerprint,
      sessionName, mode:'fresh',
    });
    await io.bindSession({ deckName:'deck.html', sessionId, sessionName, create:true });
    const first = Buffer.from('working-a');
    const second = Buffer.from('working-b');
    const firstFingerprint = sha256(first);
    const secondFingerprint = sha256(second);
    assert.deepEqual(await io.writeWorkingDeck({
      sessionId, bytes:first, expectedFingerprint:null,
    }), { committed:true, commitScope:'working-deck', fingerprint:firstFingerprint });
    assert.equal((await io.readWorkingDeck()).fingerprint, firstFingerprint);
    assert.deepEqual(await io.readWorkingDeck({ ifFingerprint:firstFingerprint }), {
      unchanged:true, fingerprint:firstFingerprint,
    }, '未变更的工作副本不能重复传输整份 HTML');
    const changedRead = await io.readWorkingDeck({ ifFingerprint:secondFingerprint });
    assert.equal(Buffer.from(changedRead.bytes, 'base64').toString(), 'working-a');

    assert.deepEqual(await io.writeWorkingDeck({
      sessionId, bytes:second, expectedFingerprint:firstFingerprint,
    }), { committed:true, commitScope:'working-deck', fingerprint:secondFingerprint });
    const historical = await io.readWorkingDeck({ versionFingerprint:firstFingerprint });
    assert.equal(Buffer.from(historical.bytes, 'base64').toString(), 'working-a');
    assert.equal((await io.readWorkingDeck()).fingerprint, secondFingerprint, '读取归档不得切换当前工作副本');
    await assert.rejects(io.readWorkingDeck({ versionFingerprint:'../deck' }));
    assert.deepEqual(await io.restoreWorkingDeck({
      fingerprint:firstFingerprint, expectedFingerprint:secondFingerprint,
    }), { fingerprint:firstFingerprint });
    const restored = await io.readWorkingDeck();
    assert.equal(Buffer.from(restored.bytes, 'base64').toString(), 'working-a');
    const transactionId = '223e4567-e89b-42d3-a456-426614174000';
    const published = await io.publishWorkingDeck({
      sessionId, transactionId,
      expectedDeckFingerprint:fingerprint,
      expectedWorkingFingerprint:firstFingerprint,
    });
    assert.equal(published.ok, true);
    assert.equal(published.fingerprint, firstFingerprint);
    assert.equal((await readFile(join(project, 'deck.html'))).toString(), 'working-a');
    assert.equal((await io.readTransaction({ transactionId })).candidateFingerprint,
      firstFingerprint);
  } finally {
    await io.close();
  }
});

test('Node helper wrapper 精确透传附件事务与只读验证命令', async () => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  const requests = [];
  child.stdin.write = data => {
    const request = JSON.parse(String(data));
    requests.push({ command:request.command, payload:request.payload });
    queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({
      id:request.id, ok:true, result:request.command === 'publish-attachments' ? [] : { removed:false },
    })}\n`));
    return true;
  };
  child.kill = () => queueMicrotask(() => child.emit('close', null));
  const io = await createPersistentSidecarIO({
    project:{ path:'/tmp/project', realPath:'/tmp/project', dev:'1', ino:'2' },
    spawnHelper:() => child,
    skipReadyHandshake:true,
  });
  const uploadId = '223e4567-e89b-42d3-a456-426614174000';
  const taskId = '423e4567-e89b-42d3-a456-426614174000';
  const files = [{
    id:'623e4567-e89b-42d3-a456-426614174000', suffix:'.png', size:8,
    sha256:sha256('png-data'),
  }];
  const uploadIdentity = { dev:'1', ino:'9', mountDev:'1', mountId:'10' };
  const discardFiles = files.map(file => ({
    ...file, identity:{ dev:'1', ino:'11', mountDev:'1', mountId:'10' },
  }));
  const metadata = files.map(file => ({
    id:file.id,
    relativePath:`attachments/${taskId}/${file.id}${file.suffix}`,
    size:file.size,
  }));
  try {
    await io.publishAttachments({ uploadId, taskId, files });
    await io.discardAttachmentUpload({ uploadId, uploadIdentity, files:discardFiles });
    await io.deleteTaskAttachments({ taskId });
    await io.reconcileAttachments({ referencedTaskIds:[taskId] });
    await io.verifyTaskAttachments({ taskId, files:metadata });
    assert.deepEqual(requests, [
      { command:'publish-attachments', payload:{ uploadId, taskId, files } },
      {
        command:'discard-attachment-upload',
        payload:{ uploadId, uploadIdentity, files:discardFiles },
      },
      { command:'delete-task-attachments', payload:{ taskId } },
      { command:'reconcile-attachments', payload:{ referencedTaskIds:[taskId] } },
      { command:'verify-task-attachments', payload:{ taskId, files:metadata } },
    ]);
  } finally {
    await io.close();
  }
});

test('registry 原子发布后 discovery 只接受注册 session，未注册伪造目录保持只读', async () => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  const project = await mkdtemp(join(tmpdir(), 'deck-sidecar-registry-'));
  const root = join(project, '.aico-ppt-editor');
  const initialFingerprint = sha256('deck');
  const sessionName = `deck-${initialFingerprint.slice(0, 8)}`;
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  await mkdir(join(root, sessionName, 'snapshots'), { recursive:true });
  await mkdir(join(root, sessionName, 'backups'));
  await mkdir(join(root, sessionName, 'transactions'));
  await mkdir(join(root, sessionName, 'write-errors'));
  await writeFile(join(project, 'deck.html'), 'deck');
  const io = await createPersistentSidecarIO({
    project:await identity(project), root:await identity(root),
  });
  try {
    const before = await readdir(root, { recursive:true });
    assert.deepEqual(
      await io.discover({ deckName:'deck.html' }),
      { registry:null, sessions:[] },
    );
    assert.deepEqual(await readdir(root, { recursive:true }), before);
    await io.prepareSession({
      deckName:'deck.html', sessionId, initialFingerprint, sessionName, mode:'legacy',
    });
    await io.bindSession({ deckName:'deck.html', sessionId, sessionName, create:false });
    await io.writeSession({
      sessionId,
      bytes:Buffer.from(JSON.stringify({
        sessionId,
        deckPath:join(project, 'deck.html'),
        deckFingerprint:initialFingerprint,
        source:'migrated',
      })),
    });
    await io.activateSession({ sessionId });
    assert.deepEqual(await io.discover({ deckName:'deck.html' }), {
      registry:{
        version:1,
        sessions:{
          [sessionId]:{
            sessionId,
            deckRealPath:join(await realpath(project), 'deck.html'),
            initialFingerprint,
            sessionName,
            mode:'legacy',
            status:'active',
          },
        },
      },
      sessions:[{
        sessionId,
        deckRealPath:join(await realpath(project), 'deck.html'),
        initialFingerprint,
        sessionName,
        mode:'legacy',
        status:'active',
        kind:'directory',
      }],
    });
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'sessions.json'))),
      (await io.discover({ deckName:'deck.html' })).registry,
    );
  } finally {
    await io.close();
  }
});

test('registry preparing 在两处崩溃后都可由重启安全完成而非遗留未注册 session', async () => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  const project = await mkdtemp(join(tmpdir(), 'deck-sidecar-preparing-'));
  const root = join(project, '.aico-ppt-editor');
  const deckName = 'deck.html';
  const initialFingerprint = sha256('deck');
  const sessionName = `deck-${initialFingerprint.slice(0, 8)}`;
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  await mkdir(root);
  await writeFile(join(project, deckName), 'deck');

  let io = await createPersistentSidecarIO({
    project:await identity(project), root:await identity(root),
  });
  await io.prepareSession({
    deckName, sessionId, initialFingerprint, sessionName, mode:'fresh',
  });
  await io.close(); // crash point 1: registry preparing durable，session 尚未创建

  io = await createPersistentSidecarIO({
    project:await identity(project), root:await identity(root),
  });
  assert.equal((await io.discover({ deckName })).sessions[0].status, 'preparing');
  assert.equal((await io.discover({ deckName })).sessions[0].kind, 'missing');
  await io.bindSession({ deckName, sessionId, sessionName, create:true });
  await io.writeSession({
    sessionId,
    bytes:Buffer.from(JSON.stringify({
      sessionId, deckPath:join(project, deckName), deckFingerprint:initialFingerprint,
    })),
  });
  await io.close(); // crash point 2: session durable，registry 仍 preparing

  io = await createPersistentSidecarIO({
    project:await identity(project), root:await identity(root),
  });
  try {
    const pending = (await io.discover({ deckName })).sessions[0];
    assert.equal(pending.status, 'preparing');
    assert.equal(pending.kind, 'directory');
    await io.bindSession({ deckName, sessionId, sessionName, create:false });
    assert.equal((await io.readSession()).sessionId, sessionId);
    await io.activateSession({ sessionId });
    assert.equal((await io.discover({ deckName })).sessions[0].status, 'active');
  } finally {
    await io.close();
  }
});

test('bind-session 必须携带并匹配 registry sessionId', async () => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  const project = await mkdtemp(join(tmpdir(), 'deck-sidecar-bind-id-'));
  const root = join(project, '.aico-ppt-editor');
  const deckName = 'deck.html';
  const fingerprint = sha256('deck');
  const sessionName = `deck-${fingerprint.slice(0, 8)}`;
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  const wrongSessionId = '223e4567-e89b-42d3-a456-426614174000';
  await mkdir(root);
  await writeFile(join(project, deckName), 'deck');
  const io = await createPersistentSidecarIO({
    project:await identity(project), root:await identity(root),
  });
  try {
    await io.prepareSession({
      deckName, sessionId, initialFingerprint:fingerprint, sessionName, mode:'fresh',
    });
    await assert.rejects(
      () => io.bindSession({ deckName, sessionId:wrongSessionId, sessionName, create:true }),
      error => error.code === 'UNSAFE_SIDECAR_IO',
    );
    assert.deepEqual(await readdir(root), ['sessions.json']);
  } finally {
    await io.close();
  }
});

test('transactions 中任意非 UUID .json 都按不可信 record 拒绝', async () => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  const project = await mkdtemp(join(tmpdir(), 'deck-sidecar-invalid-transaction-'));
  const root = join(project, '.aico-ppt-editor');
  const deckName = 'deck.html';
  const fingerprint = sha256('deck');
  const sessionName = `deck-${fingerprint.slice(0, 8)}`;
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  await mkdir(root);
  await writeFile(join(project, deckName), 'deck');
  const io = await createPersistentSidecarIO({
    project:await identity(project), root:await identity(root),
  });
  try {
    await io.prepareSession({
      deckName, sessionId, initialFingerprint:fingerprint, sessionName, mode:'fresh',
    });
    await io.bindSession({ deckName, sessionId, sessionName, create:true });
    await writeFile(join(root, sessionName, 'transactions', 'notes.json'), '{}');
    await assert.rejects(
      () => io.listTransactions(),
      error => error.code === 'UNSAFE_SIDECAR_IO',
    );
  } finally {
    await io.close();
  }
});

test('session JSON 可跨过 1MiB 旧限制并可完整读回', async () => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  const project = await mkdtemp(join(tmpdir(), 'deck-sidecar-large-session-'));
  const root = join(project, '.aico-ppt-editor');
  const deckName = 'deck.html';
  const fingerprint = sha256('deck');
  const sessionName = `deck-${fingerprint.slice(0, 8)}`;
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  const state = {
    sessionId, deckPath:join(project, deckName), deckFingerprint:fingerprint,
    payload:'x'.repeat(2 * 1024 * 1024),
  };
  await mkdir(root);
  await writeFile(join(project, deckName), 'deck');
  const io = await createPersistentSidecarIO({
    project:await identity(project), root:await identity(root), timeoutMs:5_000,
  });
  try {
    await io.prepareSession({
      deckName, sessionId, initialFingerprint:fingerprint, sessionName, mode:'fresh',
    });
    await io.bindSession({ deckName, sessionId, sessionName, create:true });
    await io.writeSession({ sessionId, bytes:Buffer.from(JSON.stringify(state)) });
    assert.deepEqual(await io.readSession(), state);
    await assert.rejects(
      () => io.writeSession({
        sessionId, bytes:Buffer.alloc(32 * 1024 * 1024 + 1, 0x78),
      }),
      error => error.code === 'SIDECAR_SESSION_TOO_LARGE' && error.statusCode === 413,
    );
    assert.deepEqual(await io.readSession(), state, '超硬上限请求不得覆盖已有 session');
  } finally {
    await io.close();
  }
});

test('Agent Workspace 通过固定命令原子写入并完整读回', async () => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  const project = await mkdtemp(join(tmpdir(), 'deck-sidecar-agent-workspace-'));
  const root = join(project, '.aico-ppt-editor');
  const deckName = 'deck.html';
  const fingerprint = sha256('deck');
  const sessionName = `deck-${fingerprint.slice(0, 8)}`;
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  const state = {
    version:1,
    workspaceRevision:0,
    deckSessionId:sessionId,
    projectRoot:project,
  };
  await mkdir(root);
  await writeFile(join(project, deckName), 'deck');
  const io = await createPersistentSidecarIO({
    project:await identity(project), root:await identity(root), timeoutMs:5_000,
  });
  try {
    await io.prepareSession({
      deckName, sessionId, initialFingerprint:fingerprint, sessionName, mode:'fresh',
    });
    await io.bindSession({ deckName, sessionId, sessionName, create:true });
    assert.equal(await io.readAgentWorkspace({ missingOk:true }), null);

    assert.deepEqual(
      await io.writeAgentWorkspace({
        sessionId,
        bytes:Buffer.from(JSON.stringify(state)),
      }),
      { committed:true, commitScope:'agent-workspace' },
    );
    assert.deepEqual(await io.readAgentWorkspace(), state);

    await assert.rejects(
      () => io.writeAgentWorkspace({
        sessionId:'223e4567-e89b-42d3-a456-426614174000',
        bytes:Buffer.from(JSON.stringify({ ...state, deckSessionId:'wrong' })),
      }),
      /sessionId|deckSessionId/,
    );
    assert.deepEqual(await io.readAgentWorkspace(), state, '失败写入不得覆盖权威工作区');
    assert.equal(io.readFile, undefined, 'wrapper 不得提供任意文件读取');
    assert.equal(io.writeFile, undefined, 'wrapper 不得提供任意文件写入');
  } finally {
    await io.close();
  }
});

test('Agent Workspace 写请求已 dispatch 后 helper 崩溃，错误保留独立 commit scope', async () => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.stdin.write = () => {
    queueMicrotask(() => child.emit('close', 1));
    return true;
  };
  child.kill = () => queueMicrotask(() => child.emit('close', null));
  const io = await createPersistentSidecarIO({
    project:{ path:'/tmp/project', realPath:'/tmp/project', dev:'1', ino:'2' },
    spawnHelper:() => child,
    skipReadyHandshake:true,
  });

  await assert.rejects(
    () => io.writeAgentWorkspace({
      sessionId:'123e4567-e89b-42d3-a456-426614174000',
      bytes:Buffer.from('{}'),
    }),
    error => error.committed === true && error.commitScope === 'agent-workspace',
  );
  await io.close();
});

test('持久 helper 对超时、输出上限和 close 都只 settle 一次并回收 child', async t => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');

  const fakeChild = (onWrite, { closesOnKill=true } = {}) => {
    const child = new EventEmitter();
    keepMockProcessAlive(child, t);
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.write = data => { onWrite?.(child, data); return true; };
    child.stdin.end = () => {};
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      if (closesOnKill) queueMicrotask(() => child.emit('close', null));
    };
    return child;
  };
  const baseIdentity = { path:'/tmp/project', realPath:'/tmp/project', dev:'1', ino:'2' };

  await t.test('initialize 独立等待冷启动，普通请求仍受原时限约束', async () => {
    const child = fakeChild((current, line) => {
      const request = JSON.parse(String(line));
      if (request.command !== 'initialize') return;
      setTimeout(() => current.stdout.emit('data', `${JSON.stringify({
        id:request.id, ok:true, result:{ initialized:true },
      })}\n`), 125);
    });
    const io = await createPersistentSidecarIO({
      project:baseIdentity, spawnHelper:() => child,
      timeoutMs:50, startupTimeoutMs:500,
    });
    await assert.rejects(() => io.discover({ deckName:'deck.html' }), error => (
      error.code === 'SIDECAR_HELPER_TIMEOUT'
    ));
    assert.equal(child.killed, true);
    await io.close();
  });

  await t.test('initialize 超过独立启动时限仍终止并回收 helper', async () => {
    const child = fakeChild((current, line) => {
      const request = JSON.parse(String(line));
      setTimeout(() => current.stdout.emit('data', `${JSON.stringify({
        id:request.id, ok:true, result:{ initialized:true },
      })}\n`), 125);
    });
    await assert.rejects(() => createPersistentSidecarIO({
      project:baseIdentity, spawnHelper:() => child,
      timeoutMs:500, startupTimeoutMs:30,
    }), error => error.code === 'SIDECAR_HELPER_TIMEOUT' && error.committed === false);
    assert.equal(child.killed, true);
  });

  await t.test('request timeout 终止 helper', async () => {
    const child = fakeChild();
    const io = await createPersistentSidecarIO({
      project:baseIdentity,
      spawnHelper:() => child,
      timeoutMs:20,
      maxOutputBytes:1024,
      skipReadyHandshake:true,
    });
    await assert.rejects(() => io.discover({ deckName:'deck.html' }), error => (
      error.code === 'SIDECAR_HELPER_TIMEOUT'
    ));
    assert.equal(child.killed, true);
    await io.close();
  });

  await t.test('大 working Deck 命令使用独立长时限而不被普通 1s 预算误杀', async () => {
    const child = fakeChild((current, line) => {
      const request = JSON.parse(String(line));
      setTimeout(() => current.stdout.emit('data', `${JSON.stringify({
        id:request.id,
        ok:true,
        result:{ bytes:'ZA==', fingerprint:'0'.repeat(64) },
      })}\n`), 35);
    });
    const io = await createPersistentSidecarIO({
      project:baseIdentity,
      spawnHelper:() => child,
      timeoutMs:10,
      workingDeckTimeoutMs:100,
      maxWorkingDeckOutputBytes:1024,
      skipReadyHandshake:true,
    });
    const result = await io.readWorkingDeck();
    assert.equal(result.bytes, 'ZA==');
    assert.equal(child.killed, false);
    await io.close();
  });

  await t.test('源文件和备份哈希读取使用完整 Deck 的时限', async () => {
    const child = fakeChild((current, line) => {
      const request = JSON.parse(String(line));
      setTimeout(() => current.stdout.emit('data', `${JSON.stringify({
        id:request.id, ok:true, result:{ fingerprint:'0'.repeat(64) },
      })}\n`), 35);
    });
    const io = await createPersistentSidecarIO({
      project:baseIdentity, spawnHelper:() => child, timeoutMs:10,
      workingDeckTimeoutMs:100, skipReadyHandshake:true,
    });
    try {
      assert.equal((await io.hashDeck()).fingerprint, '0'.repeat(64));
      assert.equal((await io.verifyBackup({ backupName:'deck.html', expectedFingerprint:'0'.repeat(64) })).fingerprint, '0'.repeat(64));
    } finally { await io.close(); }
  });

  await t.test('oversized stdout 终止 helper', async () => {
    const child = fakeChild(current => queueMicrotask(() => {
      current.stdout.emit('data', 'x'.repeat(65));
    }));
    const io = await createPersistentSidecarIO({
      project:baseIdentity,
      spawnHelper:() => child,
      timeoutMs:100,
      maxInputBytes:1024,
      maxOutputBytes:64,
      skipReadyHandshake:true,
    });
    await assert.rejects(() => io.discover({ deckName:'deck.html' }), error => (
      error.code === 'SIDECAR_HELPER_OUTPUT_LIMIT'
    ));
    assert.equal(child.killed, true);
    await io.close();
  });

  await t.test('oversized input 在写入 child 前只拒绝本地调用', async () => {
    const child = fakeChild();
    const io = await createPersistentSidecarIO({
      project:baseIdentity,
      spawnHelper:() => child,
      timeoutMs:100,
      maxInputBytes:64,
      maxOutputBytes:1024,
      skipReadyHandshake:true,
    });
    await assert.rejects(
      () => io.bindSession({
        deckName:'deck.html', sessionName:`deck-${'a'.repeat(80)}`, create:false,
      }),
      error => error.code === 'SIDECAR_HELPER_INPUT_LIMIT',
    );
    assert.equal(child.killed, false);
    await io.close();
  });

  await t.test('stdin error 会立即终止 child', async () => {
    const child = fakeChild();
    const io = await createPersistentSidecarIO({
      project:baseIdentity,
      spawnHelper:() => child,
      timeoutMs:1_000,
      skipReadyHandshake:true,
    });
    const pending = io.discover({ deckName:'deck.html' });
    child.stdin.emit('error', Object.assign(new Error('stdin EPIPE'), { code:'EPIPE' }));
    await assert.rejects(pending, { code:'EPIPE' });
    assert.equal(child.killed, true);
    await io.close();
  });

  await t.test('child 不发 close 时 close 仍在 50ms 内 settle', async () => {
    const child = fakeChild(undefined, { closesOnKill:false });
    const io = await createPersistentSidecarIO({
      project:baseIdentity,
      spawnHelper:() => child,
      timeoutMs:1_000,
      skipReadyHandshake:true,
    });
    const settled = await Promise.race([
      io.close().then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 40)),
    ]);
    assert.equal(settled, true);
  });
});

test('附件 publish 使用专用有界超时且未知 ACK 一律保守标记已提交', async t => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  const baseIdentity = { path:'/tmp/project', realPath:'/tmp/project', dev:'1', ino:'2' };
  const uploadId = '223e4567-e89b-42d3-a456-426614174000';
  const taskId = '423e4567-e89b-42d3-a456-426614174000';
  const files = [{
    id:'623e4567-e89b-42d3-a456-426614174000', suffix:'.png', size:8,
    sha256:sha256('png-data'),
  }];
  const payload = { uploadId, taskId, files };

  const fakeChild = onWrite => {
    const child = new EventEmitter();
    keepMockProcessAlive(child, t);
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.stdin.write = data => { onWrite?.(child, JSON.parse(String(data))); return true; };
    child.killed = false;
    child.kill = signal => {
      child.killed = signal;
      queueMicrotask(() => child.emit('close', null));
    };
    return child;
  };

  await t.test('普通 1s 上限不截断附件专用预算内的延迟 ACK', async () => {
    const child = fakeChild((current, request) => setTimeout(() => {
      current.stdout.emit('data', `${JSON.stringify({
        id:request.id, ok:true, result:[],
      })}\n`);
    }, 35));
    const io = await createPersistentSidecarIO({
      project:baseIdentity,
      spawnHelper:() => child,
      timeoutMs:10,
      attachmentTimeoutMs:100,
      skipReadyHandshake:true,
    });
    try {
      assert.deepEqual(await io.publishAttachments(payload), []);
      assert.equal(child.killed, false);
    } finally {
      await io.close();
    }
  });

  await t.test('真实 child rename 后不发 ACK，超时错误仍标记 attachments 已提交', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-sidecar-publish-timeout-'));
    const source = join(root, 'source');
    const target = join(root, 'target');
    await mkdir(source);
    await writeFile(join(source, 'attachment.bin'), 'bytes');
    const script = `
      const fs = require('node:fs');
      require('node:readline').createInterface({ input:process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.command === 'initialize') {
          process.stdout.write(JSON.stringify({ id:request.id, ok:true, result:{} }) + '\\n');
          return;
        }
        fs.renameSync(${JSON.stringify(source)}, ${JSON.stringify(target)});
        setTimeout(() => {}, 10_000);
      });
    `;
    const io = await createPersistentSidecarIO({
      project:baseIdentity,
      spawnHelper:() => spawnProcess(process.execPath, ['-e', script], {
        stdio:['pipe', 'pipe', 'pipe'],
      }),
      timeoutMs:10,
      attachmentTimeoutMs:300,
    });
    await assert.rejects(() => io.publishAttachments(payload), error => (
      error.code === 'SIDECAR_HELPER_TIMEOUT'
        && error.stage === 'sidecar-helper'
        && error.committed === true
        && error.commitScope === 'attachments'
    ));
    assert.equal(await readFile(join(target, 'attachment.bin'), 'utf8'), 'bytes');
    await io.close();
  });

  await t.test('close 等待 publish ACK 后才回收 helper', async () => {
    let request;
    const child = fakeChild((current, incoming) => {
      request = incoming;
      setTimeout(() => current.stdout.emit('data', `${JSON.stringify({
        id:incoming.id, ok:true, result:[],
      })}\n`), 30);
    });
    const io = await createPersistentSidecarIO({
      project:baseIdentity,
      spawnHelper:() => child,
      timeoutMs:10,
      attachmentTimeoutMs:100,
      skipReadyHandshake:true,
    });
    const publishing = io.publishAttachments(payload);
    assert.equal(request.command, 'publish-attachments');
    const closing = io.close();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(child.killed, false, '未收敛 publish 不得被 close 立即 SIGKILL');
    assert.deepEqual(await publishing, []);
    await closing;
    assert.equal(child.killed, 'SIGKILL');
  });

  await t.test('close 等待到 publish 硬超时并保留 recovery-required 语义', async () => {
    const child = fakeChild();
    const io = await createPersistentSidecarIO({
      project:baseIdentity,
      spawnHelper:() => child,
      timeoutMs:10,
      attachmentTimeoutMs:25,
      skipReadyHandshake:true,
    });
    const publishing = io.publishAttachments(payload);
    const closing = io.close();
    await assert.rejects(publishing, error => (
      error.code === 'SIDECAR_HELPER_TIMEOUT'
        && error.committed === true
        && error.commitScope === 'attachments'
    ));
    await closing;
    assert.equal(child.killed, 'SIGKILL');
  });

  for (const [label, trigger, expectedCode] of [
    ['helper death', child => queueMicrotask(() => child.emit('close', 7)), 'SIDECAR_HELPER_CLOSED'],
    ['protocol corruption', child => queueMicrotask(() => child.stdout.emit('data', '{bad}\n')), 'SIDECAR_HELPER_PROTOCOL'],
  ]) {
    await t.test(`${label} 未 ACK 不得返回未提交`, async () => {
      const child = fakeChild(trigger);
      const io = await createPersistentSidecarIO({
        project:baseIdentity,
        spawnHelper:() => child,
        timeoutMs:100,
        attachmentTimeoutMs:100,
        skipReadyHandshake:true,
      });
      await assert.rejects(() => io.publishAttachments(payload), error => (
        error.code === expectedCode
          && error.committed === true
          && error.commitScope === 'attachments'
      ));
      await io.close();
    });
  }
});

test('持久 helper 以 FIFO 单活动请求隔离排队预算与提交状态', async t => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  const baseIdentity = { path:'/tmp/project', realPath:'/tmp/project', dev:'1', ino:'2' };
  const uploadId = '223e4567-e89b-42d3-a456-426614174000';
  const taskId = '423e4567-e89b-42d3-a456-426614174000';
  const files = [{
    id:'623e4567-e89b-42d3-a456-426614174000', suffix:'.png', size:8,
    sha256:sha256('png-data'),
  }];
  const publishPayload = { uploadId, taskId, files };
  const verifyPayload = {
    taskId,
    files:files.map(file => ({
      id:file.id,
      relativePath:`attachments/${taskId}/${file.id}${file.suffix}`,
      size:file.size,
    })),
  };
  const discardPayload = {
    uploadId,
    uploadIdentity:{ dev:'1', ino:'9', mountDev:'1', mountId:'10' },
    files:files.map(file => ({
      ...file, identity:{ dev:'1', ino:'11', mountDev:'1', mountId:'10' },
    })),
  };

  const fakeChild = onWrite => {
    const child = new EventEmitter();
    keepMockProcessAlive(child, t);
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.requestsWritten = [];
    child.stdin.write = (data, callback) => {
      const request = JSON.parse(String(data));
      child.requestsWritten.push(request.command);
      onWrite?.(child, request, callback);
      return true;
    };
    child.killed = false;
    child.kill = signal => {
      child.killed = signal;
      queueMicrotask(() => child.emit('close', null));
    };
    return child;
  };

  const emitResponse = (child, request, result) => child.stdout.emit(
    'data', `${JSON.stringify({ id:request.id, ok:true, result })}\n`,
  );

  const serialChild = handler => {
    const inbox = [];
    let busy = false;
    let child;
    const pump = () => {
      if (busy || inbox.length === 0) return;
      busy = true;
      const request = inbox.shift();
      handler(child, request, result => {
        emitResponse(child, request, result);
        busy = false;
        pump();
      });
    };
    child = fakeChild((current, request, callback) => {
      callback?.();
      inbox.push(request);
      pump();
    });
    return child;
  };

  await t.test('延迟 publish 不会被并发普通命令的短预算中止', async () => {
    const writes = [];
    const child = serialChild((current, request, done) => {
      writes.push(request.command);
      setTimeout(
        () => done(request.command === 'publish-attachments' ? [] : { bound:true }),
        request.command === 'publish-attachments' ? 35 : 1,
      );
    });
    const io = await createPersistentSidecarIO({
      project:baseIdentity, spawnHelper:() => child,
      timeoutMs:10, attachmentTimeoutMs:80, skipReadyHandshake:true,
    });
    try {
      const publishing = io.publishAttachments(publishPayload);
      const asserting = io.assertBound();
      assert.deepEqual(
        child.requestsWritten, ['publish-attachments'],
        'active 未 ACK 前不得把 queued 普通请求写入 stdin',
      );
      assert.deepEqual(await publishing, []);
      assert.deepEqual(await asserting, { bound:true });
      assert.deepEqual(writes, ['publish-attachments', 'assert-bound']);
      assert.equal(child.killed, false);
    } finally {
      await io.close();
    }
  });

  await t.test('普通命令只在 publish 完成并 dispatch 后启动自己的短预算', async () => {
    const dispatchAt = new Map();
    const started = Date.now();
    const child = serialChild((current, request, done) => {
      dispatchAt.set(request.command, Date.now() - started);
      if (request.command === 'publish-attachments') setTimeout(() => done([]), 25);
    });
    const io = await createPersistentSidecarIO({
      project:baseIdentity, spawnHelper:() => child,
      timeoutMs:12, attachmentTimeoutMs:80, skipReadyHandshake:true,
    });
    const publishing = io.publishAttachments(publishPayload);
    const asserting = io.assertBound();
    assert.deepEqual(await publishing, []);
    await assert.rejects(asserting, error => (
      error.code === 'SIDECAR_HELPER_TIMEOUT' && error.committed === false
    ));
    assert.ok(dispatchAt.get('assert-bound') >= 20, '普通命令必须在 publish ACK 后才 dispatch');
    await io.close();
  });

  await t.test('第二个附件命令仅在 FIFO dispatch 后启动独立附件预算', async () => {
    const writes = [];
    const child = serialChild((current, request, done) => {
      writes.push(request.command);
      setTimeout(
        () => done(request.command === 'publish-attachments' ? [] : { removed:true }),
        20,
      );
    });
    const io = await createPersistentSidecarIO({
      project:baseIdentity, spawnHelper:() => child,
      timeoutMs:5, attachmentTimeoutMs:30, skipReadyHandshake:true,
    });
    try {
      const first = io.publishAttachments(publishPayload);
      const second = io.discardAttachmentUpload(discardPayload);
      assert.deepEqual(
        child.requestsWritten, ['publish-attachments'],
        '第二个附件请求必须留在本地 FIFO',
      );
      assert.deepEqual(await first, []);
      assert.deepEqual(await second, { removed:true });
      assert.deepEqual(writes, [
        'publish-attachments', 'discard-attachment-upload',
      ]);
    } finally {
      await io.close();
    }
  });

  await t.test('close 将 queued 附件结算为未提交并等待 active 附件硬预算', async () => {
    const child = fakeChild((current, request, callback) => callback?.());
    const io = await createPersistentSidecarIO({
      project:baseIdentity, spawnHelper:() => child,
      timeoutMs:10, attachmentTimeoutMs:25, skipReadyHandshake:true,
    });
    const active = io.publishAttachments(publishPayload);
    const queued = io.deleteTaskAttachments({ taskId });
    const queuedResult = assert.rejects(queued, error => (
      error.code === 'SIDECAR_HELPER_CLOSED'
        && error.committed === false
        && error.commitScope === undefined
    ));
    const closing = io.close();
    await queuedResult;
    await assert.rejects(active, error => (
      error.code === 'SIDECAR_HELPER_TIMEOUT'
        && error.committed === true
        && error.commitScope === 'attachments'
    ));
    await closing;
  });

  await t.test('close 快速中止普通 active 且绝不 dispatch queued 附件', async () => {
    const child = fakeChild((current, request, callback) => callback?.());
    const io = await createPersistentSidecarIO({
      project:baseIdentity, spawnHelper:() => child,
      timeoutMs:100, attachmentTimeoutMs:100, skipReadyHandshake:true,
    });
    const active = io.assertBound();
    const queued = io.deleteTaskAttachments({ taskId });
    const activeResult = assert.rejects(active, error => (
      error.code === 'SIDECAR_HELPER_CLOSED' && error.committed === false
    ));
    const queuedResult = assert.rejects(queued, error => (
      error.code === 'SIDECAR_HELPER_CLOSED'
        && error.committed === false
        && error.commitScope === undefined
    ));
    const closedQuickly = await Promise.race([
      io.close().then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 40)),
    ]);
    await Promise.all([activeResult, queuedResult]);
    assert.equal(closedQuickly, true);
    assert.deepEqual(child.requestsWritten, ['assert-bound']);
  });

  await t.test('只读附件验证遇 helper death 保持未提交语义', async () => {
    const child = fakeChild((current, request, callback) => callback?.());
    const io = await createPersistentSidecarIO({
      project:baseIdentity, spawnHelper:() => child,
      timeoutMs:50, attachmentTimeoutMs:100, skipReadyHandshake:true,
    });
    const active = io.verifyTaskAttachments(verifyPayload);
    queueMicrotask(() => child.emit('close', 7));
    await assert.rejects(active, error => (
      error.code === 'SIDECAR_HELPER_CLOSED'
        && error.committed === false
        && error.commitScope === undefined
    ));
    await io.close();
  });

  await t.test('close 快速中止只读附件验证且返回未提交', async () => {
    const child = fakeChild((current, request, callback) => callback?.());
    const io = await createPersistentSidecarIO({
      project:baseIdentity, spawnHelper:() => child,
      timeoutMs:100, attachmentTimeoutMs:100, skipReadyHandshake:true,
    });
    const active = io.verifyTaskAttachments(verifyPayload);
    const activeResult = assert.rejects(active, error => (
      error.code === 'SIDECAR_HELPER_CLOSED'
        && error.committed === false
        && error.commitScope === undefined
    ));
    const closedQuickly = await Promise.race([
      io.close().then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 40)),
    ]);
    await activeResult;
    assert.equal(closedQuickly, true);
    assert.deepEqual(child.requestsWritten, ['verify-task-attachments']);
  });

  await t.test('child death 只把 active 附件标为未知提交，queued 附件保持未提交', async () => {
    const child = fakeChild((current, request, callback) => callback?.());
    const io = await createPersistentSidecarIO({
      project:baseIdentity, spawnHelper:() => child,
      timeoutMs:50, attachmentTimeoutMs:50, skipReadyHandshake:true,
    });
    const active = io.publishAttachments(publishPayload);
    const queued = io.deleteTaskAttachments({ taskId });
    queueMicrotask(() => child.emit('close', 7));
    const [activeResult, queuedResult] = await Promise.allSettled([active, queued]);
    assert.equal(activeResult.status, 'rejected');
    assert.equal(activeResult.reason.code, 'SIDECAR_HELPER_CLOSED');
    assert.equal(activeResult.reason.committed, true);
    assert.equal(activeResult.reason.commitScope, 'attachments');
    assert.equal(queuedResult.status, 'rejected');
    assert.equal(queuedResult.reason.code, 'SIDECAR_HELPER_CLOSED');
    assert.equal(queuedResult.reason.committed, false);
    assert.equal(queuedResult.reason.commitScope, undefined);
    await io.close();
  });

  await t.test('同步 stdin EPIPE 证明附件命令未 dispatch，必须标记未提交', async () => {
    const epipe = Object.assign(new Error('stdin EPIPE'), { code:'EPIPE' });
    const child = fakeChild();
    child.stdin.write = () => { throw epipe; };
    const io = await createPersistentSidecarIO({
      project:baseIdentity, spawnHelper:() => child,
      timeoutMs:50, attachmentTimeoutMs:50, skipReadyHandshake:true,
    });
    await assert.rejects(() => io.publishAttachments(publishPayload), error => (
      error.code === 'EPIPE'
        && error.committed === false
        && error.commitScope === undefined
    ));
    await io.close();
  });

  await t.test('异步 write callback error 只结算一次 active 并保留未知提交语义', async () => {
    const epipe = Object.assign(new Error('write callback EPIPE'), { code:'EPIPE' });
    const child = fakeChild((current, request, callback) => {
      queueMicrotask(() => callback?.(epipe));
    });
    const io = await createPersistentSidecarIO({
      project:baseIdentity, spawnHelper:() => child,
      timeoutMs:20, attachmentTimeoutMs:40, skipReadyHandshake:true,
    });
    await assert.rejects(() => io.publishAttachments(publishPayload), error => (
      error.code === 'EPIPE'
        && error.committed === true
        && error.commitScope === 'attachments'
    ));
    await io.close();
  });

  await t.test('未知 response ID fail-closed：active 附件未知提交、queued 普通命令未提交', async () => {
    const child = fakeChild((current, request, callback) => {
      callback?.();
      if (request.command === 'publish-attachments') queueMicrotask(() => {
        current.stdout.emit('data', `${JSON.stringify({
          id:'823e4567-e89b-42d3-a456-426614174000', ok:true, result:[],
        })}\n`);
      });
    });
    const io = await createPersistentSidecarIO({
      project:baseIdentity, spawnHelper:() => child,
      timeoutMs:30, attachmentTimeoutMs:30, skipReadyHandshake:true,
    });
    const active = io.publishAttachments(publishPayload);
    const queued = io.assertBound();
    const [activeResult, queuedResult] = await Promise.allSettled([active, queued]);
    assert.equal(activeResult.status, 'rejected');
    assert.equal(activeResult.reason.code, 'SIDECAR_HELPER_PROTOCOL');
    assert.equal(activeResult.reason.committed, true);
    assert.equal(queuedResult.status, 'rejected');
    assert.equal(queuedResult.reason.code, 'SIDECAR_HELPER_PROTOCOL');
    assert.equal(queuedResult.reason.committed, false);
    await io.close();
  });

  await t.test('迟到重复 response 不得被忽略或错误匹配后续 active', async () => {
    let publishRequest;
    const child = fakeChild((current, request, callback) => {
      callback?.();
      if (request.command === 'publish-attachments') {
        publishRequest = request;
        setTimeout(() => emitResponse(current, request, []), 2);
      } else {
        setTimeout(() => emitResponse(current, publishRequest, []), 2);
      }
    });
    const io = await createPersistentSidecarIO({
      project:baseIdentity, spawnHelper:() => child,
      timeoutMs:20, attachmentTimeoutMs:40, skipReadyHandshake:true,
    });
    const publishing = io.publishAttachments(publishPayload);
    const asserting = io.assertBound();
    assert.deepEqual(await publishing, []);
    await assert.rejects(asserting, error => (
      error.code === 'SIDECAR_HELPER_PROTOCOL' && error.committed === false
    ));
    await io.close();
  });

  await t.test('active publish 不受后续 oversized 普通请求影响且 helper 可继续服务', async () => {
    const child = fakeChild((current, request, callback) => {
      callback?.();
      setTimeout(() => emitResponse(
        current,
        request,
        request.command === 'publish-attachments' ? [] : { bound:true },
      ), request.command === 'publish-attachments' ? 30 : 1);
    });
    const io = await createPersistentSidecarIO({
      project:baseIdentity, spawnHelper:() => child,
      timeoutMs:20, attachmentTimeoutMs:80,
      maxInputBytes:700, skipReadyHandshake:true,
    });
    const publishing = io.publishAttachments(publishPayload);
    await assert.rejects(
      () => io.bindSession({
        deckName:'x'.repeat(2_000), sessionId:taskId,
        sessionName:'deck-deadbeef', create:false,
      }),
      error => error.code === 'SIDECAR_HELPER_INPUT_LIMIT'
        && error.committed === false
        && error.commitScope === undefined,
    );
    assert.deepEqual(child.requestsWritten, ['publish-attachments']);
    assert.deepEqual(await publishing, []);
    assert.deepEqual(await io.assertBound(), { bound:true });
    assert.equal(child.killed, false);
    await io.close();
  });

  await t.test('oversized 附件自身未送达且不影响后续 helper 请求', async () => {
    const child = fakeChild((current, request, callback) => {
      callback?.();
      queueMicrotask(() => emitResponse(current, request, { bound:true }));
    });
    const io = await createPersistentSidecarIO({
      project:baseIdentity, spawnHelper:() => child,
      maxInputBytes:300, skipReadyHandshake:true,
    });
    await assert.rejects(
      () => io.publishAttachments({ ...publishPayload, padding:'x'.repeat(2_000) }),
      error => error.code === 'SIDECAR_HELPER_INPUT_LIMIT'
        && error.committed === false
        && error.commitScope === undefined,
    );
    assert.deepEqual(child.requestsWritten, []);
    assert.deepEqual(await io.assertBound(), { bound:true });
    assert.equal(child.killed, false);
    await io.close();
  });

  await t.test('本地 JSON 序列化失败返回未提交 Promise 且 helper 保持可用', async () => {
    const child = fakeChild((current, request, callback) => {
      callback?.();
      queueMicrotask(() => emitResponse(current, request, { bound:true }));
    });
    const io = await createPersistentSidecarIO({
      project:baseIdentity, spawnHelper:() => child,
      skipReadyHandshake:true,
    });
    const circular = { ...publishPayload };
    circular.self = circular;
    let localFailure;
    assert.doesNotThrow(() => { localFailure = io.publishAttachments(circular); });
    await assert.rejects(
      localFailure,
      error => error.code === 'SIDECAR_HELPER_SERIALIZE'
        && error.committed === false
        && error.commitScope === undefined,
    );
    assert.deepEqual(child.requestsWritten, []);
    assert.deepEqual(await io.assertBound(), { bound:true });
    assert.equal(child.killed, false);
    await io.close();
  });
});

test('Node helper wrapper 原样透传原子写的 commitScope 与 stage', async () => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.stdin.write = data => {
    const request = JSON.parse(String(data));
    queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({
      id:request.id,
      ok:false,
      code:'SNAPSHOT_WRITE_FAILED',
      statusCode:500,
      message:'snapshot directory fsync failed',
      stage:'snapshot-directory-fsync',
      committed:true,
      commitScope:'snapshot',
      details:{ target:'snapshot.png', completed:1 },
    })}\n`));
    return true;
  };
  child.kill = () => queueMicrotask(() => child.emit('close', null));
  const io = await createPersistentSidecarIO({
    project:{ path:'/tmp/project', realPath:'/tmp/project', dev:'1', ino:'2' },
    spawnHelper:() => child,
    skipReadyHandshake:true,
  });
  try {
    await assert.rejects(
      () => io.writeSnapshot({ snapshotId:'123e4567-e89b-42d3-a456-426614174000', bytes:Buffer.from('x') }),
      error => error.code === 'SNAPSHOT_WRITE_FAILED'
        && error.commitScope === 'snapshot'
        && error.stage === 'snapshot-directory-fsync'
        && error.committed === true
        && error.details?.target === 'snapshot.png'
        && error.details?.completed === 1,
    );
  } finally {
    await io.close();
  }
});
