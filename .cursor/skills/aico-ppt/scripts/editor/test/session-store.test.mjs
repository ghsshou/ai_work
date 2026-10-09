import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, RevisionConflict } from '../session-store.mjs';
import { EditTimeline } from '../edit-timeline.mjs';

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0,
]).toString('base64')}`;
const PNG_BYTES = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0,
]);
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const ATTACHMENT_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_EDIT_ID = '33333333-3333-4333-8333-333333333333';
const AGENT_BATCH_ID = '44444444-4444-4444-8444-444444444444';
const WORKING_FINGERPRINT = 'a'.repeat(64);
const TASK_INPUT = {
  pageKey:'page-001-a', pageIndex:1, pageLabel:'A',
  rect:{ x:1, y:2, w:30, h:40 }, instruction:'改 A',
};

function attachmentFor(taskId = TASK_ID) {
  return {
    id:ATTACHMENT_ID,
    name:'新版架构.png',
    mime:'image/png',
    size:PNG_BYTES.length,
    source:'selected',
    relativePath:`attachments/${taskId}/${ATTACHMENT_ID}.png`,
    createdAt:'2026-08-02T12:00:00.000Z',
  };
}

async function injectedStore(prefix, sidecarIO, options = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const deck = join(root, 'deck.html');
  const sessionDir = join(root, '.aico-ppt-editor', 'deck-session');
  await writeFile(deck, 'deck-v1');
  const store = await SessionStore.open({
    deckPath:deck,
    sessionDir,
    sidecarIO,
    sessionId:options.sessionId,
    randomUUID:options.randomUUID,
    persistedState:options.persistedState,
  });
  return { root, deck, sessionDir, store };
}

test('跨页任务写入后可恢复且 revision 单调递增', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck-v1');
  const store = await SessionStore.open({ deckPath: deck, rootDir: join(root, '.aico-ppt-editor') });
  const t1 = await store.createTask({ pageKey:'page-001-a', pageIndex:1, pageLabel:'A', rect:{x:1,y:2,w:3,h:4}, instruction:'改 A' }, 0);
  const t2 = await store.createTask({ pageKey:'page-002-b', pageIndex:2, pageLabel:'B', rect:{x:5,y:6,w:7,h:8}, instruction:'改 B' }, 1);
  assert.equal(t1.revision, 1); assert.equal(t2.revision, 2);
  const reopened = await SessionStore.open({ deckPath: deck, rootDir: join(root, '.aico-ppt-editor') });
  assert.equal(reopened.state.tasks.length, 2);
  assert.deepEqual(reopened.state.tasks.map(task => task.attachments), [[], []]);
  await assert.rejects(() => reopened.createTask({ ...t1.task, id:undefined }, 0), RevisionConflict);
  assert.match(await readFile(reopened.sessionPath, 'utf8'), /改 B/);
});

test('任务版本独立持久化，其他任务增删不改变内容边界；真正内容改变仍推进边界', async () => {
  const {store, deck, sessionDir} = await injectedStore('deck-edit-scope-', undefined);
  const original = await store.createTask(TASK_INPUT, 0);
  const extra = await store.createTask({...TASK_INPUT, instruction:'其他标注'}, 1);
  await store.updateTask(extra.task.id, '更改其他标注', 2);
  await store.deleteTask(extra.task.id, 3);
  assert.deepEqual(store.state.editScope, {contentRevision:0, taskRevisions:{[original.task.id]:1}});
  const reopened = await SessionStore.open({deckPath:deck, sessionDir});
  assert.deepEqual(reopened.state.editScope, store.state.editScope);
  await reopened.updateTask(original.task.id, '新的要求', 4);
  assert.equal(reopened.state.editScope.taskRevisions[original.task.id], 5);
  const changed = structuredClone(reopened.state);
  changed.revision = 6; changed.workingDeckFingerprint = WORKING_FINGERPRINT;
  await reopened.persistState(changed, {taskMetadataOnly:true});
  assert.equal(reopened.state.editScope.contentRevision, 6, '携带内容变化不能谎报为任务元数据');
  await reopened.createTask({...TASK_INPUT, instruction:'又一标注'}, 6);
  assert.equal(reopened.state.editScope.contentRevision, 6);
});

test('旧会话或损坏的分域版本采用保守边界，任务增删不能重新放行旧内容', async () => {
  const {store, deck, sessionDir} = await injectedStore('deck-legacy-edit-scope-', undefined);
  for (const editScope of [undefined, {contentRevision:-1}, {contentRevision:99}]) {
    const legacy = {...structuredClone(store.state), revision:12, editScope};
    await writeFile(store.sessionPath, JSON.stringify(legacy));
    const reopened = await SessionStore.open({deckPath:deck, sessionDir});
    assert.equal(reopened.state.editScope.contentRevision, 12);
    await reopened.createTask(TASK_INPUT, 12);
    assert.equal(reopened.state.editScope.contentRevision, 12);
  }
});

test('旧版撤销记录重开后恢复为永久完成且不会重新进入 Agent 队列', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-completed-task-migration-'));
  const deck = join(root, 'deck.html');
  const rootDir = join(root, '.aico-ppt-editor');
  await writeFile(deck, 'deck-v1');
  const store = await SessionStore.open({ deckPath:deck, rootDir });
  const created = await store.createTask(TASK_INPUT, 0);
  const candidate = structuredClone(store.state);
  const timeline = EditTimeline.open(candidate);
  const group = timeline.appendActions(created.task.id, [{
    id:'legacy-action', taskId:created.task.id, kind:'setText',
    target:{ pageKey:TASK_INPUT.pageKey, path:'section:nth-of-type(1) h1' },
    payload:{ text:'新标题' }, before:'旧标题', after:'新标题',
  }]);
  const task = candidate.tasks.find(item => item.id === created.task.id);
  task.status = 'pending';
  task.effectState = 'compensated';
  task.entryIds = [group.id];
  delete task.groupId;
  candidate.revision = 2;
  await store.persistState(candidate);

  const reopened = await SessionStore.open({ deckPath:deck, rootDir });
  const migrated = reopened.state.tasks[0];
  assert.equal(migrated.status, 'completed');
  assert.equal(migrated.effectState, 'undone');
  assert.equal(migrated.groupId, group.id);
  assert.equal(reopened.state.revision, 2);
  const persisted = JSON.parse(await readFile(reopened.sessionPath, 'utf8'));
  assert.equal(persisted.tasks[0].status, 'completed');
  assert.equal(persisted.tasks[0].effectState, 'undone');
});

test('活动源码事务严格持久化并在重开后恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-source-edit-'));
  const deck = join(root, 'deck.html');
  const rootDir = join(root, '.aico-ppt-editor');
  await writeFile(deck, 'deck-v1');
  const store = await SessionStore.open({ deckPath:deck, rootDir });
  const candidate = structuredClone(store.state);
  candidate.workingDeckFingerprint = WORKING_FINGERPRINT;
  candidate.sourceEdit = {
    id:SOURCE_EDIT_ID,
    taskId:null,
    beforeFingerprint:WORKING_FINGERPRINT,
    startedAt:'2026-08-16T00:00:00.000Z',
    commandId:SOURCE_EDIT_ID,requestDigest:WORKING_FINGERPRINT,
  };
  candidate.revision = 1;
  await store.persistState(candidate);

  const reopened = await SessionStore.open({ deckPath:deck, rootDir });
  assert.deepEqual(reopened.state.sourceEdit, candidate.sourceEdit);
  assert.equal(reopened.state.workingDeckFingerprint, WORKING_FINGERPRINT);
  assert.equal(reopened.state.revision, 1);
});

test('Agent 执行批次成员与结算结果在重开后保持不变', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-agent-batch-'));
  const deck = join(root, 'deck.html');
  const rootDir = join(root, '.aico-ppt-editor');
  await writeFile(deck, 'deck-v1');
  const store = await SessionStore.open({ deckPath:deck, rootDir });
  const created = await store.createTask(TASK_INPUT, 0);
  const candidate = structuredClone(store.state);
  candidate.agentBatches = [{
    id:AGENT_BATCH_ID,
    ordinal:1,
    provider:'codex',
    mode:'terminal',
    taskIds:[created.task.id],
    expectedRevision:created.revision,
    createdAt:'2026-08-21T08:00:00.000Z',
    settlement:{
      outcome:'failed',
      code:'AGENT_TASKS_INCOMPLETE',
      message:'仍有一个任务未完成',
      settledAt:'2026-08-21T08:05:00.000Z',
    },
  }];
  candidate.revision += 1;
  await store.persistState(candidate);

  const reopened = await SessionStore.open({ deckPath:deck, rootDir });
  assert.deepEqual(reopened.state.agentBatches, candidate.agentBatches);
  assert.equal(reopened.state.revision, 2);
});

test('持久化源码事务拒绝未知字段和无效身份', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-invalid-source-edit-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck-v1');
  const base = await SessionStore.open({
    deckPath:deck,
    rootDir:join(root, '.aico-ppt-editor'),
  });
  const valid = {
    id:SOURCE_EDIT_ID,
    taskId:null,
    beforeFingerprint:WORKING_FINGERPRINT,
    startedAt:'2026-08-16T00:00:00.000Z',
  };
  for (const sourceEdit of [
    { ...valid, id:'not-a-uuid' },
    { ...valid, beforeFingerprint:'bad' },
    { ...valid, unexpected:true },
    { ...valid, commandId:'invalid',requestDigest:WORKING_FINGERPRINT },
    { ...valid, commandId:SOURCE_EDIT_ID,requestDigest:'invalid' },
    { ...valid, requestDigest:WORKING_FINGERPRINT },
  ]) {
    await assert.rejects(
      SessionStore.open({
        deckPath:deck,
        sessionDir:base.sessionDir,
        sessionId:base.state.sessionId,
        persistedState:{ ...base.state, sourceEdit },
      }),
      /持久化源码事务格式无效/,
    );
  }
});

test('待处理任务可改说明、删除并清理快照', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-task-edit-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck-v1');
  const store = await SessionStore.open({ deckPath:deck, rootDir:join(root, '.aico-ppt-editor') });
  const created = await store.createTask({ ...TASK_INPUT, snapshot:PNG_DATA_URL }, 0);
  const updated = await store.updateTask(created.task.id, '  更新后的说明  ', 1);
  assert.equal(updated.task.instruction, '更新后的说明');
  assert.equal(updated.revision, 2);
  const deleted = await store.deleteTask(created.task.id, 2);
  assert.equal(deleted.revision, 3);
  assert.equal(deleted.cleanupPending, false);
  assert.deepEqual(store.state.tasks, []);
  assert.deepEqual(await readdir(join(store.sessionDir, 'snapshots')), []);
});

test('已固化完成任务可删除记录，仍关联撤销组的完成任务保持锁定', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-solidified-task-delete-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck-v1');
  const store = await SessionStore.open({
    deckPath:deck,
    rootDir:join(root, '.aico-ppt-editor'),
  });
  const created = await store.createTask({ ...TASK_INPUT, snapshot:PNG_DATA_URL }, 0);
  const task = store.state.tasks.find(item => item.id === created.task.id);
  task.status = 'completed';
  task.groupId = 'group-still-undoable';

  await assert.rejects(
    () => store.deleteTask(task.id, 1),
    error => error.code === 'TASK_LOCKED' && /撤销或固化/.test(error.message),
  );
  assert.equal(store.state.tasks.length, 1);

  delete task.groupId;
  const deleted = await store.deleteTask(task.id, 1);
  assert.equal(deleted.revision, 2);
  assert.deepEqual(store.state.tasks, []);
  assert.deepEqual(await readdir(join(store.sessionDir, 'snapshots')), []);
});

test('合法 PNG 快照原子落盘且 session JSON 不保存 base64', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-snapshot-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck-v1');
  const store = await SessionStore.open({ deckPath: deck, rootDir: join(root, '.aico-ppt-editor') });
  const result = await store.createTask({
    pageKey: 'page-001-a',
    pageIndex: 1,
    pageLabel: 'A',
    rect: { x: 1, y: 2, w: 30, h: 40 },
    instruction: '改 A',
    snapshot: PNG_DATA_URL,
  }, 0);

  assert.equal(result.task.snapshot, undefined);
  assert.equal(result.task.snapshotPath, `snapshots/${result.task.id}.png`);
  assert.deepEqual(
    [...(await readFile(join(store.sessionDir, result.task.snapshotPath))).subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  const sessionJson = await readFile(store.sessionPath, 'utf8');
  assert.doesNotMatch(sessionJson, /data:image\/png|iVBOR/);
});

test('非法、伪 PNG 和超限快照在改变状态前拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-invalid-snapshot-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck-v1');
  const store = await SessionStore.open({ deckPath: deck, rootDir: join(root, '.aico-ppt-editor') });
  const base = {
    pageKey: 'page-001-a', pageIndex: 1, pageLabel: 'A',
    rect: { x: 1, y: 2, w: 30, h: 40 }, instruction: '改 A',
  };

  for (const snapshot of [
    'data:image/jpeg;base64,AAAA',
    'data:image/png;base64,%%%=',
    `data:image/png;base64,${Buffer.from('not-png').toString('base64')}`,
  ]) {
    await assert.rejects(() => store.createTask({ ...base, snapshot }, 0), error => (
      error.code === 'INVALID_SNAPSHOT' && error.statusCode === 400
    ));
  }
  const oversized = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.alloc(512 * 1024, 1),
  ]).toString('base64');
  await assert.rejects(
    () => store.createTask({ ...base, snapshot: `data:image/png;base64,${oversized}` }, 0),
    error => error.code === 'SNAPSHOT_TOO_LARGE' && error.statusCode === 413,
  );
  assert.equal(store.state.revision, 0);
  assert.deepEqual(store.state.tasks, []);
  assert.deepEqual(await readdir(join(store.sessionDir, 'snapshots')), []);
});

test('session 持久化失败会回滚 task/revision 并清理快照和临时文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-persist-failure-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck-v1');
  const store = await SessionStore.open({ deckPath: deck, rootDir: join(root, '.aico-ppt-editor') });
  store.sessionPath = join(root, 'missing-parent', 'session.json');
  await assert.rejects(() => store.createTask({
    pageKey: 'page-001-a', pageIndex: 1, pageLabel: 'A',
    rect: { x: 1, y: 2, w: 30, h: 40 }, instruction: '改 A', snapshot: PNG_DATA_URL,
  }, 0), /ENOENT/);

  assert.equal(store.state.revision, 0);
  assert.deepEqual(store.state.tasks, []);
  assert.deepEqual(await readdir(join(store.sessionDir, 'snapshots')), []);
});

test('task 的 session 写已 committed 后保留候选内存并由重启收敛', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-committed-task-'));
  const deck = join(root, 'deck.html');
  const sessionDir = join(root, '.aico-ppt-editor', 'deck-session');
  await writeFile(deck, 'deck-v1');
  let sessionWrites = 0;
  let store;
  let observedRevisionDuringWrite = null;
  const sidecarIO = {
    async writeSession({ bytes }) {
      sessionWrites += 1;
      await writeFile(join(sessionDir, 'session.json'), bytes);
      if (sessionWrites === 2) {
        observedRevisionDuringWrite = store.state.revision;
        throw Object.assign(new Error('directory fsync failed after rename'), {
          committed:true,
          commitScope:'session',
        });
      }
    },
  };
  store = await SessionStore.open({
    deckPath:deck,
    rootDir:join(root, '.aico-ppt-editor'),
    sessionDir,
    sidecarIO,
  });

  await assert.rejects(() => store.createTask({
    pageKey:'page-001-a', pageIndex:1, pageLabel:'A',
    rect:{ x:1, y:2, w:30, h:40 }, instruction:'已提交任务',
  }, 0), error => error.committed === true);

  const disk = JSON.parse(await readFile(store.sessionPath, 'utf8'));
  assert.equal(observedRevisionDuringWrite, 0, '持久化完成前不得发布候选 task 状态');
  assert.equal(store.state.revision, 1);
  assert.equal(store.state.tasks.length, 1);
  assert.equal(disk.revision, 1);
  assert.deepEqual(disk.tasks, store.state.tasks);

  const reopened = await SessionStore.open({
    deckPath:deck,
    rootDir:join(root, '.aico-ppt-editor'),
    sessionDir,
  });
  assert.equal(reopened.state.revision, 1);
  assert.deepEqual(reopened.state.tasks, store.state.tasks);
});

test('SessionStore 的 session 与 snapshot 只通过可信 atomic I/O 层提交', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-secure-io-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck-v1');
  const writes = [];
  const sidecarIO = {
    async atomicWrite({ directory, name, bytes }) {
      writes.push({ directory, name, bytes:Buffer.from(bytes) });
      await writeFile(join(directory, name), bytes);
    },
    async unlink({ directory, name }) {
      writes.push({ directory, name, unlink:true });
    },
  };
  const store = await SessionStore.open({
    deckPath:deck,
    rootDir:join(root, '.aico-ppt-editor'),
    sidecarIO,
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].directory, store.sessionDir);
  assert.equal(writes[0].name, 'session.json');
  writes.length = 0;

  const result = await store.createTask({
    pageKey:'page-001-a', pageIndex:1, pageLabel:'A',
    rect:{ x:1, y:2, w:30, h:40 }, instruction:'改 A', snapshot:PNG_DATA_URL,
  }, 0);

  assert.deepEqual(writes.map(write => [write.directory, write.name]), [
    [join(store.sessionDir, 'snapshots'), `${result.task.id}.png`],
    [store.sessionDir, 'session.json'],
  ]);
});

test('snapshot rename 后目录 fsync 失败会补偿删除，且绝不提交 session 候选', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-snapshot-compensated-'));
  const deck = join(root, 'deck.html');
  const sessionDir = join(root, '.aico-ppt-editor', 'deck-session');
  await writeFile(deck, 'deck-v1');
  let sessionWrites = 0;
  let snapshotDeletes = 0;
  const sidecarIO = {
    async writeSession() { sessionWrites += 1; },
    async writeSnapshot() {
      throw Object.assign(new Error('snapshot directory fsync failed after rename'), {
        code:'SNAPSHOT_WRITE_FAILED',
        statusCode:500,
        stage:'snapshot-directory-fsync',
        committed:true,
        commitScope:'snapshot',
      });
    },
    async deleteSnapshot() { snapshotDeletes += 1; },
  };
  const store = await SessionStore.open({
    deckPath:deck,
    rootDir:join(root, '.aico-ppt-editor'),
    sessionDir,
    sidecarIO,
  });

  await assert.rejects(() => store.createTask({
    pageKey:'page-001-a', pageIndex:1, pageLabel:'A',
    rect:{ x:1, y:2, w:30, h:40 }, instruction:'改 A', snapshot:PNG_DATA_URL,
  }, 0), error => error.code === 'SNAPSHOT_WRITE_FAILED'
    && error.commitScope === 'snapshot'
    && error.committed === false
    && error.compensated === true);

  assert.equal(sessionWrites, 1, '只能存在 open 时的初始 session 写，task 候选不得写入');
  assert.equal(snapshotDeletes, 1);
  assert.equal(store.state.revision, 0);
  assert.deepEqual(store.state.tasks, []);
});

test('snapshot rename 后补偿删除失败返回独立恢复错误，且不声称 session 已提交', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-snapshot-recovery-'));
  const deck = join(root, 'deck.html');
  const sessionDir = join(root, '.aico-ppt-editor', 'deck-session');
  await writeFile(deck, 'deck-v1');
  let sessionWrites = 0;
  const sidecarIO = {
    async writeSession() { sessionWrites += 1; },
    async writeSnapshot() {
      throw Object.assign(new Error('snapshot directory fsync failed after rename'), {
        code:'SNAPSHOT_WRITE_FAILED',
        statusCode:500,
        stage:'snapshot-directory-fsync',
        committed:true,
        commitScope:'snapshot',
      });
    },
    async deleteSnapshot() {
      throw Object.assign(new Error('snapshot compensation fsync failed'), {
        code:'SNAPSHOT_DELETE_FAILED',
        commitScope:'snapshot',
        stage:'snapshot-delete-directory-fsync',
      });
    },
  };
  const store = await SessionStore.open({
    deckPath:deck,
    rootDir:join(root, '.aico-ppt-editor'),
    sessionDir,
    sidecarIO,
  });

  await assert.rejects(() => store.createTask({
    pageKey:'page-001-a', pageIndex:1, pageLabel:'A',
    rect:{ x:1, y:2, w:30, h:40 }, instruction:'改 A', snapshot:PNG_DATA_URL,
  }, 0), error => error.code === 'SNAPSHOT_RECOVERY_REQUIRED'
    && error.statusCode === 503
    && error.commitScope === 'snapshot'
    && error.committed === false
    && error.sessionCandidateCommitted === false);

  assert.equal(sessionWrites, 1, 'snapshot 恢复失败也不得开始 session 候选写入');
  assert.equal(store.state.revision, 0);
  assert.deepEqual(store.state.tasks, []);
});

test('附件发布、Buffer 快照与 task/revision 按同一候选一次提交', async () => {
  const events = [];
  let persisted;
  const sidecarIO = {
    async writeSession({ bytes }) {
      events.push('session');
      persisted = JSON.parse(bytes.toString('utf8'));
    },
    async writeSnapshot({ snapshotId, bytes }) {
      events.push(`snapshot:${snapshotId}`);
      assert.deepEqual(bytes, PNG_BYTES);
    },
    async deleteSnapshot() { events.push('delete-snapshot'); },
    async deleteTaskAttachments({ taskId }) { events.push(`delete-attachments:${taskId}`); },
  };
  const { store } = await injectedStore('deck-session-attachments-success-', sidecarIO, {
    sessionId:'session-attachments-success', randomUUID:() => TASK_ID,
  });
  events.length = 0;
  const lifecycle = {
    async publish(taskId) {
      events.push(`publish:${taskId}`);
      return [attachmentFor(taskId)];
    },
    async discard() { events.push('discard'); },
  };

  const result = await store.createTask({ ...TASK_INPUT, snapshot:PNG_BYTES }, 0, {
    attachmentsLifecycle:lifecycle,
  });

  assert.equal(result.task.id, TASK_ID);
  assert.deepEqual(result.task.attachments, [attachmentFor()]);
  assert.equal(result.revision, 1);
  assert.deepEqual(events, [`publish:${TASK_ID}`, `snapshot:${TASK_ID}`, 'session']);
  assert.equal(persisted.revision, 1);
  assert.deepEqual(persisted.tasks[0].attachments, [attachmentFor()]);
  assert.doesNotMatch(JSON.stringify(persisted), /"path"\s*:/);
});

test('PNG data URL 与 Buffer 共用签名、类型和 512 KiB 上限校验', async () => {
  const snapshots = [];
  const makeStore = async prefix => (await injectedStore(prefix, {
    async writeSession() {},
    async writeSnapshot({ bytes }) { snapshots.push(Buffer.from(bytes)); },
    async deleteSnapshot() {},
  }, { sessionId:`session-${prefix}`, randomUUID:() => TASK_ID })).store;
  const dataUrlStore = await makeStore('snapshot-data-url-');
  const bufferStore = await makeStore('snapshot-buffer-');
  const dataUrlResult = await dataUrlStore.createTask({ ...TASK_INPUT, snapshot:PNG_DATA_URL }, 0);
  const bufferResult = await bufferStore.createTask({ ...TASK_INPUT, snapshot:PNG_BYTES }, 0);

  assert.equal(dataUrlResult.task.snapshotPath, bufferResult.task.snapshotPath);
  assert.deepEqual(snapshots, [PNG_BYTES, PNG_BYTES]);
  for (const snapshot of [Buffer.from('not-png'), new Uint8Array(PNG_BYTES)]) {
    const store = await makeStore(`snapshot-invalid-${snapshots.length}-`);
    await assert.rejects(
      () => store.createTask({ ...TASK_INPUT, snapshot }, 0),
      error => error.code === 'INVALID_SNAPSHOT' && error.statusCode === 400,
    );
  }
  const oversized = Buffer.concat([PNG_BYTES.subarray(0, 8), Buffer.alloc(512 * 1024, 1)]);
  const oversizedStore = await makeStore('snapshot-buffer-oversized-');
  await assert.rejects(
    () => oversizedStore.createTask({ ...TASK_INPUT, snapshot:oversized }, 0),
    error => error.code === 'SNAPSHOT_TOO_LARGE' && error.statusCode === 413,
  );
});

test('附件 publish 未提交失败时不写 snapshot/session，且不误删 task 目录', async () => {
  const events = [];
  const publishError = Object.assign(new Error('publish no-replace failed'), {
    code:'ATTACHMENT_EXISTS', committed:false, commitScope:'attachments',
  });
  const sidecarIO = {
    async writeSession() { events.push('session'); },
    async writeSnapshot() { events.push('snapshot'); },
    async deleteSnapshot() { events.push('delete-snapshot'); },
    async deleteTaskAttachments() { events.push('delete-attachments'); },
  };
  const { store } = await injectedStore('deck-session-publish-failed-', sidecarIO, {
    sessionId:'session-publish-failed', randomUUID:() => TASK_ID,
  });
  events.length = 0;
  const lifecycle = {
    published:false,
    async publish() { events.push('publish'); throw publishError; },
    async discard() { events.push('discard'); },
  };

  await assert.rejects(
    () => store.createTask({ ...TASK_INPUT, snapshot:PNG_BYTES }, 0, {
      attachmentsLifecycle:lifecycle,
    }),
    error => error === publishError,
  );
  assert.deepEqual(events, ['publish']);
  assert.equal(store.state.revision, 0);
  assert.deepEqual(store.state.tasks, []);
});

test('publish 已 committed 但回执未确认时只做 task 附件补偿，不误 discard staging', async () => {
  const events = [];
  const publishError = Object.assign(new Error('publish ack lost'), {
    code:'ATTACHMENT_PUBLISH_PROTOCOL',
    committed:true,
    commitScope:'attachments',
    stage:'attachment-publish-protocol',
  });
  const sidecarIO = {
    async writeSession() { events.push('session'); },
    async deleteTaskAttachments({ taskId }) { events.push(`delete:${taskId}`); },
  };
  const { store } = await injectedStore('deck-session-publish-unknown-', sidecarIO, {
    sessionId:'session-publish-unknown', randomUUID:() => TASK_ID,
  });
  events.length = 0;
  const lifecycle = {
    published:true,
    async publish() { events.push('publish'); throw publishError; },
    async discard() { events.push('discard'); },
  };

  await assert.rejects(
    () => store.createTask(TASK_INPUT, 0, { attachmentsLifecycle:lifecycle }),
    error => error.code === 'ATTACHMENT_PUBLISH_PROTOCOL'
      && error.committed === false && error.compensated === true
      && error.cause === publishError,
  );
  assert.deepEqual(events, ['publish', `delete:${TASK_ID}`]);
  assert.equal(store.state.revision, 0);
  assert.deepEqual(store.state.tasks, []);
});

test('snapshot 写失败时补偿已发布附件，不提交 task/revision', async () => {
  const events = [];
  const snapshotError = Object.assign(new Error('snapshot write failed'), {
    code:'SNAPSHOT_WRITE_FAILED', committed:false, commitScope:'snapshot',
  });
  const sidecarIO = {
    async writeSession() { events.push('session'); },
    async writeSnapshot() { events.push('snapshot'); throw snapshotError; },
    async deleteSnapshot() { events.push('delete-snapshot'); },
    async deleteTaskAttachments({ taskId }) { events.push(`delete-attachments:${taskId}`); },
  };
  const { store } = await injectedStore('deck-session-snapshot-attachment-rollback-', sidecarIO, {
    sessionId:'session-snapshot-attachment-rollback', randomUUID:() => TASK_ID,
  });
  events.length = 0;

  await assert.rejects(
    () => store.createTask({ ...TASK_INPUT, snapshot:PNG_BYTES }, 0, {
      attachmentsLifecycle:{ async publish() { events.push('publish'); return [attachmentFor()]; } },
    }),
    error => error === snapshotError,
  );
  assert.deepEqual(events, [
    'publish', 'snapshot', 'delete-snapshot', `delete-attachments:${TASK_ID}`,
  ]);
  assert.equal(store.state.revision, 0);
  assert.deepEqual(store.state.tasks, []);
});

test('snapshot committed 写回执失败时仍按逆序同时补偿 snapshot 与附件', async () => {
  const events = [];
  const snapshotError = Object.assign(new Error('snapshot fsync ack lost'), {
    code:'SNAPSHOT_WRITE_FAILED', committed:true, commitScope:'snapshot',
    stage:'snapshot-directory-fsync',
  });
  const sidecarIO = {
    async writeSession() { events.push('session'); },
    async writeSnapshot() { events.push('snapshot'); throw snapshotError; },
    async deleteSnapshot() { events.push('delete-snapshot'); },
    async deleteTaskAttachments({ taskId }) { events.push(`delete-attachments:${taskId}`); },
  };
  const { store } = await injectedStore('deck-session-snapshot-committed-attachments-', sidecarIO, {
    sessionId:'session-snapshot-committed-attachments', randomUUID:() => TASK_ID,
  });
  events.length = 0;

  await assert.rejects(
    () => store.createTask({ ...TASK_INPUT, snapshot:PNG_BYTES }, 0, {
      attachmentsLifecycle:{ async publish() { events.push('publish'); return [attachmentFor()]; } },
    }),
    error => error.code === 'SNAPSHOT_WRITE_FAILED'
      && error.committed === false && error.compensated === true
      && error.cause === snapshotError,
  );
  assert.deepEqual(events, [
    'publish', 'snapshot', 'delete-snapshot', `delete-attachments:${TASK_ID}`,
  ]);
  assert.equal(store.state.revision, 0);
  assert.deepEqual(store.state.tasks, []);
});

test('snapshot 写未 committed 但清理已 committed 时顶层保留清理 scope/details', async () => {
  const writeError = Object.assign(new Error('snapshot write failed before commit'), {
    code:'SNAPSHOT_WRITE_FAILED', committed:false, commitScope:'snapshot',
  });
  const cleanupError = Object.assign(new Error('snapshot delete fsync ack lost'), {
    code:'SNAPSHOT_DELETE_FAILED', statusCode:503,
    committed:true, commitScope:'snapshot', stage:'snapshot-delete-directory-fsync',
    details:{ removed:true },
  });
  const events = [];
  const sidecarIO = {
    async writeSession() {},
    async writeSnapshot() { throw writeError; },
    async deleteSnapshot() { throw cleanupError; },
    async deleteTaskAttachments() { events.push('delete-attachments'); },
  };
  const { store } = await injectedStore('deck-session-snapshot-cleanup-committed-', sidecarIO, {
    sessionId:'session-snapshot-cleanup-committed', randomUUID:() => TASK_ID,
  });

  await assert.rejects(
    () => store.createTask({ ...TASK_INPUT, snapshot:PNG_BYTES }, 0, {
      attachmentsLifecycle:{ async publish() { return [attachmentFor()]; } },
    }),
    error => error.code === cleanupError.code
      && error.stage === cleanupError.stage
      && error.committed === true
      && error.commitScope === cleanupError.commitScope
      && error.details === cleanupError.details
      && error.cause === writeError
      && error.compensationError === cleanupError,
  );
  assert.deepEqual(events, ['delete-attachments']);
  assert.equal(store.state.revision, 0);
});

test('session 未 committed 失败时按 snapshot→attachments 逆序补偿', async () => {
  const events = [];
  const sessionError = Object.assign(new Error('session write failed'), {
    code:'SESSION_WRITE_FAILED', committed:false, commitScope:'session',
  });
  let sessionWrites = 0;
  const sidecarIO = {
    async writeSession() {
      sessionWrites += 1;
      events.push('session');
      if (sessionWrites === 2) throw sessionError;
    },
    async writeSnapshot() { events.push('snapshot'); },
    async deleteSnapshot() { events.push('delete-snapshot'); },
    async deleteTaskAttachments({ taskId }) { events.push(`delete-attachments:${taskId}`); },
  };
  const { store } = await injectedStore('deck-session-attachment-persist-failed-', sidecarIO, {
    sessionId:'session-attachment-persist-failed', randomUUID:() => TASK_ID,
  });
  events.length = 0;

  await assert.rejects(
    () => store.createTask({ ...TASK_INPUT, snapshot:PNG_BYTES }, 0, {
      attachmentsLifecycle:{ async publish() { events.push('publish'); return [attachmentFor()]; } },
    }),
    error => error === sessionError,
  );
  assert.deepEqual(events, [
    'publish', 'snapshot', 'session', 'delete-snapshot', `delete-attachments:${TASK_ID}`,
  ]);
  assert.equal(store.state.revision, 0);
  assert.deepEqual(store.state.tasks, []);
});

test('session 已 committed 失败时保留候选 task、snapshot 与附件', async () => {
  const events = [];
  const committedError = Object.assign(new Error('session directory fsync lost ack'), {
    code:'SESSION_WRITE_FAILED', committed:true, commitScope:'session',
    stage:'session-directory-fsync',
  });
  let sessionWrites = 0;
  const sidecarIO = {
    async writeSession() {
      sessionWrites += 1;
      if (sessionWrites === 2) throw committedError;
    },
    async writeSnapshot() { events.push('snapshot'); },
    async deleteSnapshot() { events.push('delete-snapshot'); },
    async deleteTaskAttachments() { events.push('delete-attachments'); },
  };
  const { store } = await injectedStore('deck-session-attachment-committed-', sidecarIO, {
    sessionId:'session-attachment-committed', randomUUID:() => TASK_ID,
  });

  await assert.rejects(
    () => store.createTask({ ...TASK_INPUT, snapshot:PNG_BYTES }, 0, {
      attachmentsLifecycle:{ async publish() { events.push('publish'); return [attachmentFor()]; } },
    }),
    error => error === committedError,
  );
  assert.deepEqual(events, ['publish', 'snapshot']);
  assert.equal(store.state.revision, 1);
  assert.deepEqual(store.state.tasks[0].attachments, [attachmentFor()]);
});

test('附件补偿未 committed 失败转为 ATTACHMENT_RECOVERY_REQUIRED', async () => {
  const sessionError = Object.assign(new Error('session write failed'), {
    code:'SESSION_WRITE_FAILED', committed:false, commitScope:'session',
  });
  const cleanupError = Object.assign(new Error('delete failed before unlink'), {
    code:'ATTACHMENT_DELETE_FAILED', committed:false, commitScope:'attachments',
  });
  let sessionWrites = 0;
  const sidecarIO = {
    async writeSession() { if (++sessionWrites === 2) throw sessionError; },
    async deleteTaskAttachments() { throw cleanupError; },
  };
  const { store } = await injectedStore('deck-session-attachment-recovery-', sidecarIO, {
    sessionId:'session-attachment-recovery', randomUUID:() => TASK_ID,
  });

  await assert.rejects(
    () => store.createTask(TASK_INPUT, 0, {
      attachmentsLifecycle:{ async publish() { return [attachmentFor()]; } },
    }),
    error => error.code === 'ATTACHMENT_RECOVERY_REQUIRED'
      && error.statusCode === 503
      && error.stage === 'attachment-compensation'
      && error.committed === false
      && error.commitScope === 'attachment'
      && error.sessionCandidateCommitted === false
      && error.cause === cleanupError
      && error.originalError === sessionError,
  );
  assert.equal(store.state.revision, 0);
  assert.deepEqual(store.state.tasks, []);
});

test('附件补偿已部分 committed 的错误优先传播 scope/details，原失败作为 cause', async () => {
  const sessionError = Object.assign(new Error('session write failed'), {
    code:'SESSION_WRITE_FAILED', committed:false, commitScope:'session',
  });
  const cleanupError = Object.assign(new Error('delete fsync ack lost'), {
    code:'ATTACHMENT_DELETE_FAILED', statusCode:503,
    committed:true, commitScope:'attachments', stage:'attachment-delete-directory-fsync',
    details:{ removedFiles:1, target:TASK_ID },
  });
  let sessionWrites = 0;
  const sidecarIO = {
    async writeSession() { if (++sessionWrites === 2) throw sessionError; },
    async deleteTaskAttachments() { throw cleanupError; },
  };
  const { store } = await injectedStore('deck-session-attachment-partial-delete-', sidecarIO, {
    sessionId:'session-attachment-partial-delete', randomUUID:() => TASK_ID,
  });

  await assert.rejects(
    () => store.createTask(TASK_INPUT, 0, {
      attachmentsLifecycle:{ async publish() { return [attachmentFor()]; } },
    }),
    error => error.code === cleanupError.code
      && error.statusCode === cleanupError.statusCode
      && error.stage === cleanupError.stage
      && error.committed === true
      && error.commitScope === cleanupError.commitScope
      && error.details === cleanupError.details
      && error.cause === sessionError
      && error.compensationError === cleanupError
      && error.sessionCandidateCommitted === false,
  );
  assert.equal(store.state.revision, 0);
  assert.deepEqual(store.state.tasks, []);
});

test('附件 lifecycle 自带 deleteTask 时只补偿一次，不再调用 sidecar 删除', async () => {
  const events = [];
  const sessionError = Object.assign(new Error('session write failed'), {
    committed:false, commitScope:'session',
  });
  let sessionWrites = 0;
  const sidecarIO = {
    async writeSession() { if (++sessionWrites === 2) throw sessionError; },
    async deleteTaskAttachments() { events.push('sidecar-delete'); },
  };
  const { store } = await injectedStore('deck-session-lifecycle-delete-once-', sidecarIO, {
    sessionId:'session-lifecycle-delete-once', randomUUID:() => TASK_ID,
  });
  const lifecycle = {
    async publish(taskId) { events.push(`publish:${taskId}`); return [attachmentFor(taskId)]; },
    async deleteTask(taskId) { events.push(`lifecycle-delete:${taskId}`); },
    async discard() { events.push('discard'); },
  };

  await assert.rejects(
    () => store.createTask(TASK_INPUT, 0, { attachmentsLifecycle:lifecycle }),
    error => error === sessionError,
  );
  assert.deepEqual(events, [`publish:${TASK_ID}`, `lifecycle-delete:${TASK_ID}`]);
  assert.equal(store.state.revision, 0);
});

test('revision conflict 在生成/发布资源前拒绝，upload 仍由调用方结算', async () => {
  const events = [];
  const { store } = await injectedStore('deck-session-revision-before-publish-', {
    async writeSession() {},
    async deleteTaskAttachments() { events.push('delete'); },
  }, { sessionId:'session-revision-before-publish', randomUUID:() => TASK_ID });
  store.state.revision = 1;

  await assert.rejects(
    () => store.createTask(TASK_INPUT, 0, {
      attachmentsLifecycle:{
        async publish() { events.push('publish'); return [attachmentFor()]; },
        async discard() { events.push('discard'); },
      },
    }),
    RevisionConflict,
  );
  assert.deepEqual(events, []);
  assert.equal(store.state.revision, 1);
});

test('旧 session 缺 attachments 归一化为空数组，伪造持久化附件则拒绝启动', async () => {
  const legacyTask = {
    ...TASK_INPUT, id:TASK_ID, status:'pending', candidates:[], snapshotPath:null,
    createdAt:'2026-08-02T12:00:00.000Z', updatedAt:'2026-08-02T12:00:00.000Z',
  };
  const persistedState = {
    version:1, sessionId:'session-legacy', deckPath:undefined, deckFingerprint:'deck',
    revision:1, tasks:[legacyTask], groups:[], redo:[],
    diagnosticsBaseline:{}, diagnosticsCurrent:{}, diagnosticsRevision:null, conflict:null,
  };
  const { store } = await injectedStore('deck-session-legacy-attachments-', {}, {
    sessionId:'session-legacy', persistedState,
  });
  assert.deepEqual(store.state.tasks[0].attachments, []);
  assert.ok(Object.hasOwn(store.state.tasks[0], 'attachments'));

  const forged = {
    ...persistedState,
    tasks:[{ ...legacyTask, attachments:[{ ...attachmentFor(), path:'/tmp/escape.png' }] }],
  };
  await assert.rejects(
    () => injectedStore('deck-session-forged-attachments-', {}, {
      sessionId:'session-legacy', persistedState:forged,
    }),
    /附件元数据字段无效/,
  );
  await assert.rejects(
    () => injectedStore('deck-session-forged-task-id-', {}, {
      sessionId:'session-legacy',
      persistedState:{ ...persistedState, tasks:[{ ...legacyTask, id:'../../escape' }] },
    }),
    /持久化任务 id/,
  );
});

test('重复 taskId 在 publish 之前拒绝，不触碰任何资源', async () => {
  const events = [];
  const { store } = await injectedStore('deck-session-duplicate-task-id-', {
    async writeSession() {},
    async deleteTaskAttachments() { events.push('delete'); },
  }, { sessionId:'session-duplicate-task-id', randomUUID:() => TASK_ID });
  store.state.tasks.push({ ...TASK_INPUT, id:TASK_ID, attachments:[] });

  await assert.rejects(
    () => store.createTask(TASK_INPUT, 0, {
      attachmentsLifecycle:{ async publish() { events.push('publish'); return []; } },
    }),
    error => error.code === 'TASK_ID_COLLISION'
      && error.committed === false && error.stage === 'task-id',
  );
  assert.deepEqual(events, []);
  assert.equal(store.state.revision, 0);
});
