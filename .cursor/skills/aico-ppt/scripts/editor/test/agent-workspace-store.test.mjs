import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentWorkspaceStore } from '../agent-workspace/workspace-store.mjs';
import { createEmptyWorkspace } from '../agent-workspace/schema.mjs';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const ROOT = process.platform === 'win32'
  ? String.raw`C:\aico-ppt-project`
  : '/tmp/aico-ppt-project';

function memorySidecar({ persisted = null, failWrite = null } = {}) {
  let disk = persisted === null ? null : structuredClone(persisted);
  let writes = 0;
  return {
    get writes() { return writes; },
    get disk() { return structuredClone(disk); },
    async readAgentWorkspace({ missingOk = false } = {}) {
      if (disk === null && !missingOk) throw Object.assign(new Error('missing'), { code:'ENOENT' });
      return disk === null ? null : structuredClone(disk);
    },
    async writeAgentWorkspace({ sessionId, bytes }) {
      writes += 1;
      assert.equal(sessionId, SESSION_ID);
      const candidate = JSON.parse(Buffer.from(bytes).toString('utf8'));
      const error = failWrite?.({ writes, candidate });
      if (error?.commitFirst) disk = structuredClone(candidate);
      if (error) throw error.error ?? error;
      disk = structuredClone(candidate);
      return { committed:true, commitScope:'agent-workspace' };
    },
  };
}

function openStore(sidecarIO, options = {}) {
  let tick = 0;
  return AgentWorkspaceStore.open({
    deckSessionId:SESSION_ID,
    projectRoot:ROOT,
    sidecarIO,
    now:() => `2026-08-09T12:00:0${tick++}.000Z`,
    ...options,
  });
}

test('首次 open 创建默认状态，reopen 恢复同一 workspaceRevision', async () => {
  const sidecarIO = memorySidecar();
  const first = await openStore(sidecarIO);
  assert.equal(first.snapshot().workspaceRevision, 0);
  assert.equal(first.snapshot().deckSessionId, SESSION_ID);
  assert.equal(sidecarIO.writes, 1);

  await first.update(draft => {
    draft.activeProvider = 'opencode';
  }, 0);
  assert.equal(first.snapshot().workspaceRevision, 1);
  await first.close();

  const reopened = await openStore(sidecarIO);
  assert.equal(reopened.snapshot().workspaceRevision, 1);
  assert.equal(reopened.snapshot().activeProvider, 'opencode');
  assert.equal(sidecarIO.writes, 2, 'reopen 不得重复写入');
});

test('旧会话保存了其他系统的绝对路径时，open 修复为当前已解析目录', async () => {
  const persisted = createEmptyWorkspace({
    deckSessionId:SESSION_ID,
    projectRoot:ROOT,
    projectRootSource:'launch-cwd',
    now:() => '2026-08-09T12:00:00.000Z',
  });
  persisted.projectRoot = process.platform === 'win32'
    ? '/Users/tester/aico-ppt'
    : '\\\\Mac\\Home\\zyq_workspace\\aico-ppt';
  const sidecarIO = memorySidecar({ persisted });

  const store = await openStore(sidecarIO, { projectRootSource:'git-root' });

  assert.equal(store.snapshot().projectRoot, ROOT);
  assert.equal(store.snapshot().projectRootSource, 'git-root');
  assert.equal(store.snapshot().workspaceRevision, 0, '自动迁移不应制造用户编辑版本');
  assert.equal(sidecarIO.writes, 1, '修复后应原子回写，避免每次启动重复修复');
  assert.equal(sidecarIO.disk.projectRoot, ROOT);
});

test('陈旧更新返回独立 WORKSPACE_REVISION_CONFLICT', async () => {
  const store = await openStore(memorySidecar());
  await store.update(draft => { draft.activeProvider = 'claude-code'; }, 0);

  await assert.rejects(
    () => store.update(draft => { draft.activeProvider = 'opencode'; }, 0),
    error => error.code === 'WORKSPACE_REVISION_CONFLICT'
      && error.workspaceRevision === 1
      && error.statusCode === 409,
  );
  assert.equal(store.snapshot().activeProvider, 'claude-code');
});

function legacyDshWorkspace() {
  const value = createEmptyWorkspace({ deckSessionId:SESSION_ID, projectRoot:ROOT });
  value.activeProvider = 'dsh';
  value.providers = { dsh:{ activeConversationId:null, conversations:[] } };
  value.projectRoot = process.platform === 'win32' ? '/Users/old/project' : String.raw`C:\old\project`;
  return value;
}

test('嵌入宿主恢复旧 dsh 空占位记录，同时保留 Deck 身份并修复跨系统目录', async () => {
  const persisted = legacyDshWorkspace();
  const sidecarIO = memorySidecar({ persisted });
  const store = await openStore(sidecarIO, { dshAgentBridge:true });
  assert.equal(store.snapshot().deckSessionId, persisted.deckSessionId);
  assert.equal(store.snapshot().workspaceRevision, persisted.workspaceRevision);
  assert.equal(store.snapshot().createdAt, persisted.createdAt);
  assert.equal(store.snapshot().projectRoot, ROOT);
  assert.equal(store.snapshot().activeProvider, 'codex');
  assert.deepEqual(Object.keys(store.snapshot().providers).sort(), ['claude-code','codex','opencode']);
  assert.equal(sidecarIO.writes, 1);
  await store.close();
  await openStore(sidecarIO, { dshAgentBridge:true });
  assert.equal(sidecarIO.writes, 1, '重启不得重复迁移');
});

test('旧 dsh 占位修复不丢弃会话、未知字段，也不用于独立终端', async () => {
  for (const mutate of [
    value => { value.providers.dsh.conversations = [{ id:'keep-history' }]; },
    value => { value.providers.dsh.activeConversationId = 'keep-history'; },
    value => { value.providers.dsh.extra = 'keep-data'; },
    value => { value.providers.extra = {}; },
    value => { value.extra = 'keep-data'; },
    value => { value.deckSessionId = 'another-deck'; },
  ]) {
    const persisted = legacyDshWorkspace(); mutate(persisted);
    const sidecarIO = memorySidecar({ persisted });
    await assert.rejects(() => openStore(sidecarIO, { dshAgentBridge:true }));
    assert.equal(sidecarIO.writes, 0);
    assert.deepEqual(sidecarIO.disk, persisted);
  }
  const sidecarIO = memorySidecar({ persisted:legacyDshWorkspace() });
  await assert.rejects(() => openStore(sidecarIO), /provider dsh 不受支持/);
  assert.equal(sidecarIO.writes, 0);
});

test('持久化失败不发布 candidate，且不会泄漏可变状态引用', async () => {
  const sidecarIO = memorySidecar({
    failWrite:({ writes }) => writes === 2
      ? Object.assign(new Error('磁盘失败'), {
          code:'AGENT_WORKSPACE_WRITE_FAILED', committed:false,
          commitScope:'agent-workspace',
        })
      : null,
  });
  const store = await openStore(sidecarIO);
  const before = store.snapshot();
  before.activeProvider = 'opencode';
  assert.equal(store.snapshot().activeProvider, 'codex');

  await assert.rejects(
    () => store.update(draft => { draft.activeProvider = 'opencode'; }, 0),
    /磁盘失败/,
  );
  assert.equal(store.snapshot().workspaceRevision, 0);
  assert.equal(store.snapshot().activeProvider, 'codex');
});

test('ACK 丢失后只读核对已提交 candidate，不盲目重写', async () => {
  const sidecarIO = memorySidecar({
    failWrite:({ writes }) => writes === 2 ? {
      commitFirst:true,
      error:Object.assign(new Error('ACK 丢失'), {
        code:'SIDECAR_HELPER_CLOSED', committed:true,
        commitScope:'agent-workspace',
      }),
    } : null,
  });
  const store = await openStore(sidecarIO);
  const result = await store.update(draft => {
    draft.activeProvider = 'opencode';
  }, 0);

  assert.equal(result.workspaceRevision, 1);
  assert.equal(result.activeProvider, 'opencode');
  assert.equal(sidecarIO.writes, 2, '恢复过程只能读取，不能重写 candidate');
});

test('ACK 丢失且无法核对时返回恢复诊断并保持原内存状态', async () => {
  const sidecarIO = memorySidecar({
    failWrite:({ writes }) => writes === 2
      ? Object.assign(new Error('ACK 丢失'), {
          code:'SIDECAR_HELPER_CLOSED', committed:true,
          commitScope:'agent-workspace',
        })
      : null,
  });
  const store = await openStore(sidecarIO);

  await assert.rejects(
    () => store.update(draft => { draft.activeProvider = 'opencode'; }, 0),
    error => error.code === 'WORKSPACE_RECOVERY_REQUIRED'
      && error.committed === true
      && error.commitScope === 'agent-workspace',
  );
  assert.equal(store.snapshot().workspaceRevision, 0);
  assert.equal(store.snapshot().activeProvider, 'codex');
});

test('close 后拒绝更新，Store Interface 不暴露 Deck revision', async () => {
  const store = await openStore(memorySidecar());
  await store.close();
  await assert.rejects(
    () => store.replace(store.snapshot(), 0),
    error => error.code === 'WORKSPACE_STORE_CLOSED',
  );
  assert.equal('revision' in store.snapshot(), false);
});
