import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { WorkCatalog } from '../work-catalog.mjs';
import { openDeckBinding } from '../deck-binding-coordinator.mjs';

function sequence(values) {
  let index = 0;
  return () => values[index++];
}

test('旧编辑记录迁移为稳定工作项，修改显示名称不修改 Deck 文件', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '技术解析.html');
  const original = '<!doctype html><title>技术解析</title>';
  await writeFile(deckPath, original);
  const legacy = {
    async list() {
      return {
        version:1,
        creation:[],
        editing:[{
          deckPath,
          deckName:basename(deckPath),
          directory:root,
          modifiedAt:'2026-08-16T08:00:00.000Z',
          lastOpenedAt:'2026-08-16T07:00:00.000Z',
          provider:'codex',
          progress:'继续编辑',
        }],
      };
    },
  };
  const catalog = new WorkCatalog({
    filePath:join(root, 'work-catalog.json'),
    legacyHistory:legacy,
    randomUUID:sequence([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]),
  });

  const first = (await catalog.list()).editing[0];
  assert.equal(first.workId, '11111111-1111-4111-8111-111111111111');
  assert.equal(first.deckId, '22222222-2222-4222-8222-222222222222');
  assert.equal(first.displayName, '技术解析.html');
  assert.equal(first.nameSource, 'auto');
  assert.equal(first.binding.state, 'bound');

  const renamed = await catalog.rename({
    workId:first.workId,
    displayName:'昇腾课程最终版',
    expectedRevision:first.revision,
  });
  assert.equal(renamed.displayName, '昇腾课程最终版');
  assert.equal(renamed.nameSource, 'custom');
  assert.equal(await readFile(deckPath, 'utf8'), original);

  const reopened = new WorkCatalog({
    filePath:join(root, 'work-catalog.json'),
    legacyHistory:{ async list() { return { version:1, creation:[], editing:[] }; } },
    randomUUID:() => assert.fail('重新打开不应生成新身份'),
  });
  const persisted = (await reopened.list()).editing[0];
  assert.equal(persisted.workId, first.workId);
  assert.equal(persisted.deckId, first.deckId);
  assert.equal(persisted.displayName, '昇腾课程最终版');
});

test('创建工作项在左上角改名后不再被 Brief 标题覆盖', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-creation-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  let title = '未命名 Deck';
  const legacyHistory = {
    async list() {
      return {
        version:1,
        editing:[],
        creation:[{
          kind:'creation',
          draftId:'draft-creation',
          projectRoot:root,
          title,
          progress:'需求沟通中',
          provider:'codex',
          updatedAt:'2026-08-16T09:00:00.000Z',
        }],
      };
    },
  };
  const catalog = new WorkCatalog({
    filePath:join(root, 'work-catalog.json'),
    legacyHistory,
    randomUUID:sequence(['33333333-3333-4333-8333-333333333333']),
  });

  const first = (await catalog.list()).creation[0];
  assert.equal(first.workId, '33333333-3333-4333-8333-333333333333');
  assert.equal(first.displayName, '未命名 Deck');
  assert.equal(first.nameSource, 'auto');

  const renamed = await catalog.rename({
    workId:first.workId,
    displayName:'客户评审版',
    expectedRevision:first.revision,
  });
  assert.equal(renamed.displayName, '客户评审版');
  assert.equal(renamed.nameSource, 'custom');

  title = 'Brief 已经改名';
  const listed = (await catalog.list()).creation[0];
  assert.equal(listed.displayName, '客户评审版');
  assert.equal(listed.title, '客户评审版');
  assert.equal(listed.briefTitle, 'Brief 已经改名');
});

test('创建工作项的其他窗口状态只反映当前活锁，不能持久化陈旧锁', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-live-lock-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  let active = true;
  const legacyHistory = {
    async list() {
      return {
        version:1,
        editing:[],
        creation:active ? [{
          kind:'creation',
          draftId:'draft-live-lock',
          projectRoot:root,
          title:'锁状态测试',
          progress:'等待开始对话',
          provider:'codex',
          updatedAt:'2026-08-16T09:00:00.000Z',
          locked:true,
        }] : [],
      };
    },
  };
  const catalog = new WorkCatalog({
    filePath:join(root, 'work-catalog.json'),
    legacyHistory,
  });

  assert.equal((await catalog.list()).creation[0].locked, true);
  active = false;
  assert.equal((await catalog.list()).creation[0].locked, false);

  const persisted = JSON.parse(await readFile(join(root, 'work-catalog.json'), 'utf8'));
  assert.equal(persisted.workItems[0].locked, false);
});

test('删除工作项后即使旧历史仍存在也不会被重新导入', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-dismiss-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, 'legacy.html');
  await writeFile(deckPath, '<!doctype html>');
  const catalog = new WorkCatalog({
    filePath:join(root, 'catalog.json'),
    legacyHistory:{ async list() { return { version:1, creation:[], editing:[{ deckPath }] }; } },
  });

  const initial = await catalog.list();
  await catalog.dismiss({
    workId:initial.editing[0].workId,
    expectedRevision:initial.editing[0].revision,
  });

  assert.deepEqual((await catalog.list()).editing, []);
});

test('用户明确重新打开已隐藏的 Deck 时恢复原工作项身份和首页入口', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-reopen-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '重新打开.html');
  await writeFile(deckPath, '<!doctype html>');
  const catalog = new WorkCatalog({
    filePath:join(root, 'catalog.json'),
    legacyHistory:{ async list() { return { version:1, creation:[], editing:[{ deckPath }] }; } },
  });

  const initial = (await catalog.list()).editing[0];
  await catalog.dismiss({
    workId:initial.workId,
    expectedRevision:initial.revision,
  });
  assert.deepEqual((await catalog.list()).editing, [], '普通历史同步不得复活已隐藏任务');

  const reopened = await catalog.reopenEditing({ deckPath });
  assert.equal(reopened.workId, initial.workId);
  assert.equal(reopened.deckId, initial.deckId);
  assert.equal(reopened.revision, initial.revision + 2);

  const history = await catalog.list();
  assert.equal(history.editing.length, 1);
  assert.equal(history.editing[0].workId, initial.workId);
});

test('Editor 关闭期间 Deck 被外部改名，任务以原 deckId 自动恢复到新路径', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-rebind-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const oldPath = join(root, '旧文件名.html');
  const newPath = join(root, '新文件名.html');
  await writeFile(oldPath, '<!doctype html><title>不变身份</title>');
  const legacyHistory = {
    async list() {
      return { version:1, creation:[], editing:[{ deckPath:oldPath, projectRoot:root }] };
    },
  };
  const filePath = join(root, 'catalog.json');
  const firstCatalog = new WorkCatalog({ filePath, legacyHistory });
  const before = (await firstCatalog.list()).editing[0];
  await rename(oldPath, newPath);

  const reopened = new WorkCatalog({ filePath, legacyHistory });
  const history = await reopened.list();

  assert.equal(history.editing.length, 1);
  assert.equal(history.editing[0].deckId, before.deckId);
  assert.equal(history.editing[0].workId, before.workId);
  assert.equal(history.editing[0].deckPath, await realpath(newPath));
  assert.equal(history.editing[0].displayName, '新文件名.html');
  assert.equal(history.editing[0].binding.reason, 'renamed');
  assert.equal((await reopened.resolve(before.workId)).deckPath, await realpath(newPath));
});

test('可信固化更新后的文件见证持久化，重启不会把正常发布误判为 replaced', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-published-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, 'source.html');
  const replacement = join(root, 'replacement.html');
  await writeFile(deckPath, '<!doctype html><title>before</title>');
  const filePath = join(root, 'catalog.json');
  const legacyHistory = {
    async list() { return { version:1, creation:[], editing:[{ deckPath, projectRoot:root }] }; },
  };
  const catalog = new WorkCatalog({ filePath, legacyHistory });
  const before = (await catalog.list()).editing[0];
  await writeFile(replacement, '<!doctype html><title>after</title>');
  await rename(replacement, deckPath);
  const publishedBinding = await openDeckBinding({
    deckId:before.deckId,
    initialBinding:{ currentPath:deckPath, trustedRoot:root, revision:before.binding.revision },
    storageRoot:root,
    watch:false,
  });
  const snapshot = publishedBinding.snapshot();
  await publishedBinding.close();

  await catalog.updateEditingBinding({
    workId:before.workId,
    deckId:before.deckId,
    binding:snapshot,
  });

  const reopened = new WorkCatalog({ filePath, legacyHistory });
  const after = (await reopened.list()).editing[0];
  assert.equal(after.binding.state, 'bound');
  assert.deepEqual(after.binding.witness, snapshot.witness);
  assert.equal(after.binding.sourceFingerprint, snapshot.sourceFingerprint);
});

test('缺失源文件可由用户确认相同内容副本并保持原工作项和 Deck 身份', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-manual-rebind-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const oldPath = join(root, 'old.html');
  const copyPath = join(root, 'copy.html');
  await writeFile(oldPath, '<!doctype html><title>copy</title>');
  const legacyHistory = {
    async list() { return { version:1, creation:[], editing:[{ deckPath:oldPath }] }; },
  };
  const catalog = new WorkCatalog({ filePath:join(root, 'catalog.json'), legacyHistory });
  const before = (await catalog.list()).editing[0];
  await copyFile(oldPath, copyPath);
  await rm(oldPath);
  const missing = (await catalog.list()).editing[0];
  assert.equal(missing.binding.state, 'needs-rebind');

  const rebound = await catalog.rebindEditing({
    workId:before.workId,
    candidatePath:copyPath,
    confirmation:'verified-copy',
    expectedBindingRevision:missing.binding.revision,
  });

  assert.equal(rebound.workId, before.workId);
  assert.equal(rebound.deckId, before.deckId);
  assert.equal(rebound.deckPath, await realpath(copyPath));
  assert.equal(rebound.binding.state, 'bound');
});

test('Creation 发布后原位转换为 Editing，并保留 workId、名称和 DSH 会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-promote-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, 'published.html');
  await writeFile(deckPath, '<!doctype html><title>published</title>');
  let creationActive = true;
  const legacyHistory = {
    async list() {
      return {
        version:1,
        creation:creationActive ? [{
          draftId:'draft-promote', projectRoot:root, title:'创建中的 Deck', provider:'codex',
        }] : [],
        editing:creationActive ? [] : [{ deckPath, projectRoot:root, provider:'codex' }],
      };
    },
  };
  const catalog = new WorkCatalog({
    filePath:join(root, 'catalog.json'),
    legacyHistory,
    randomUUID:sequence(['49111111-1111-4111-8111-111111111111']),
  });
  let creation = (await catalog.list()).creation[0];
  creation = await catalog.rename({
    workId:creation.workId,
    displayName:'客户评审主任务',
    expectedRevision:creation.revision,
  });
  const operationId = '49222222-2222-4222-8222-222222222222';
  await catalog.beginDshSessionProvision({
    workId:creation.workId,
    operationId,
    workspaceId:'workspace-project',
    sessionId:'session-project',
    origin:'fresh',
    expectedBindingRevision:creation.dshBinding.revision,
  });
  creation = await catalog.completeDshSessionProvision({ workId:creation.workId, operationId });
  creation = await catalog.activateDshSession({
    workId:creation.workId,
    sessionId:'session-project',
    expectedBindingRevision:creation.dshBinding.revision,
  });

  const deckId = '49333333-3333-4333-8333-333333333333';
  const coordinator = await openDeckBinding({
    deckId,
    initialBinding:{
      revision:0, state:'bound', reason:'none', currentPath:deckPath,
      previousPath:null, trustedRoot:root,
    },
    storageRoot:root,
    watch:false,
  });
  const binding = coordinator.snapshot();
  await coordinator.close();
  creationActive = false;

  const promoted = await catalog.promoteCreationToEditing({
    workId:creation.workId,
    deckPath,
    deckId,
    binding,
    provider:'codex',
    projectRoot:root,
  });

  assert.equal(promoted.kind, 'editing');
  assert.equal(promoted.workId, creation.workId);
  assert.equal(promoted.deckId, deckId);
  assert.equal(promoted.displayName, '客户评审主任务');
  assert.equal(promoted.nameSource, 'custom');
  assert.equal(promoted.dshBinding.activeSessionId, 'session-project');
  assert.equal(promoted.dshBinding.sessions[0].sessionId, 'session-project');
  assert.equal((await catalog.resolveByDshSession('session-project')).kind, 'editing');
  const history = await catalog.list();
  assert.equal(history.creation.length, 0);
  assert.deepEqual(history.editing.map(item => item.workId), [creation.workId]);

  const retried = await catalog.promoteCreationToEditing({
    workId:creation.workId, deckPath, deckId, binding,
  });
  assert.equal(retried.revision, promoted.revision);
});

test('Creation 发布到新项目根时历史化旧会话并清空 Workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-promote-root-change-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const oldRoot = join(root, 'project-a');
  const newRoot = join(root, 'project-b');
  await mkdir(oldRoot);
  await mkdir(newRoot);
  const deckPath = join(newRoot, 'published.html');
  await writeFile(deckPath, '<!doctype html><title>published</title>');
  const catalog = new WorkCatalog({
    filePath:join(root, 'catalog.json'),
    legacyHistory:{
      async list() {
        return {
          version:1,
          creation:[{
            draftId:'draft-root-change', projectRoot:oldRoot,
            title:'跨项目发布', provider:'codex',
          }],
          editing:[],
        };
      },
    },
    randomUUID:sequence(['49444444-4444-4444-8444-444444444444']),
  });
  let creation = (await catalog.list()).creation[0];
  const operationId = '49555555-5555-4555-8555-555555555555';
  creation = await catalog.beginDshSessionProvision({
    workId:creation.workId,
    operationId,
    workspaceId:'workspace-project-a',
    sessionId:'session-project-a',
    origin:'fresh',
    expectedBindingRevision:creation.dshBinding.revision,
  });
  creation = await catalog.completeDshSessionProvision({
    workId:creation.workId,
    operationId,
  });
  creation = await catalog.activateDshSession({
    workId:creation.workId,
    sessionId:'session-project-a',
    expectedBindingRevision:creation.dshBinding.revision,
  });

  const deckId = '49666666-6666-4666-8666-666666666666';
  const coordinator = await openDeckBinding({
    deckId,
    initialBinding:{
      revision:0, state:'bound', reason:'none', currentPath:deckPath,
      previousPath:null, trustedRoot:newRoot,
    },
    storageRoot:root,
    watch:false,
  });
  const binding = coordinator.snapshot();
  await coordinator.close();

  const promoted = await catalog.promoteCreationToEditing({
    workId:creation.workId,
    deckPath,
    deckId,
    binding,
    projectRoot:newRoot,
  });

  assert.equal(promoted.projectRoot, await realpath(newRoot));
  assert.equal(promoted.dshBinding.workspaceId, null);
  assert.equal(promoted.dshBinding.activeSessionId, null);
  assert.equal(promoted.dshBinding.pendingOperation, null);
  assert.equal(promoted.dshBinding.sessions[0].state, 'historical');
  assert.equal(await catalog.resolveByDshSession('session-project-a'), null);
});

test('schema v2 原样迁移工作项身份并初始化空 DSH 关联，不猜测旧会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-v2-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '迁移.html');
  const filePath = join(root, 'catalog.json');
  await writeFile(deckPath, '<!doctype html>');
  const seeded = new WorkCatalog({
    filePath,
    legacyHistory:{ async list() { return { version:1, creation:[], editing:[{ deckPath }] }; } },
    randomUUID:sequence([
      '41111111-1111-4111-8111-111111111111',
      '42222222-2222-4222-8222-222222222222',
    ]),
  });
  const before = (await seeded.list()).editing[0];
  const stored = JSON.parse(await readFile(filePath, 'utf8'));
  stored.version = 2;
  delete stored.workItems[0].dshBinding;
  await writeFile(filePath, JSON.stringify(stored, null, 2) + '\n');

  const reopened = new WorkCatalog({
    filePath,
    legacyHistory:{ async list() { return { version:1, creation:[], editing:[] }; } },
    randomUUID:() => assert.fail('迁移不得生成新的工作项身份'),
  });
  const after = (await reopened.list()).editing[0];

  assert.equal(after.workId, before.workId);
  assert.equal(after.deckId, before.deckId);
  assert.deepEqual(after.dshBinding, {
    revision:0,
    workspaceId:null,
    activeSessionId:null,
    sessions:[],
    pendingOperation:null,
  });
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).version, 3);
});

test('DSH 会话创建以 pending operation 固化，完成重试幂等并建立反向索引', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-dsh-provision-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '关联.html');
  await writeFile(deckPath, '<!doctype html>');
  const catalog = new WorkCatalog({
    filePath:join(root, 'catalog.json'),
    legacyHistory:{ async list() { return { version:1, creation:[], editing:[{ deckPath }] }; } },
  });
  const workItem = (await catalog.list()).editing[0];
  const operationId = '43333333-3333-4333-8333-333333333333';

  const pending = await catalog.beginDshSessionProvision({
    workId:workItem.workId,
    operationId,
    workspaceId:'workspace-a',
    sessionId:'session-a',
    origin:'fresh',
    expectedBindingRevision:0,
  });
  assert.equal(pending.dshBinding.revision, 1);
  assert.equal(pending.dshBinding.activeSessionId, null);
  assert.equal(pending.dshBinding.pendingOperation.sessionId, 'session-a');

  const completed = await catalog.completeDshSessionProvision({
    workId:workItem.workId,
    operationId,
  });
  assert.equal(completed.dshBinding.revision, 2);
  assert.equal(completed.dshBinding.activeSessionId, null,
    '完成 Link 只证明会话已关联，必须等 DSH 打开成功后再激活');
  assert.equal(completed.dshBinding.pendingOperation, null);
  assert.deepEqual(completed.dshBinding.sessions[0], {
    operationId,
    sessionId:'session-a',
    workspaceId:'workspace-a',
    origin:'fresh',
    state:'available',
    createdAt:pending.dshBinding.pendingOperation.startedAt,
  });
  assert.equal((await catalog.resolveByDshSession('session-a')).workId, workItem.workId);

  const retried = await catalog.completeDshSessionProvision({
    workId:workItem.workId,
    operationId,
  });
  assert.equal(retried.revision, completed.revision);
  assert.equal(retried.dshBinding.sessions.length, 1);
});

test('一个 DSH 会话不能关联两个 Work Item', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-dsh-unique-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const firstPath = join(root, 'first.html');
  const secondPath = join(root, 'second.html');
  await writeFile(firstPath, '<!doctype html>');
  await writeFile(secondPath, '<!doctype html>');
  const catalog = new WorkCatalog({
    filePath:join(root, 'catalog.json'),
    legacyHistory:{
      async list() {
        return { version:1, creation:[], editing:[{ deckPath:firstPath }, { deckPath:secondPath }] };
      },
    },
  });
  const [first, second] = (await catalog.list()).editing;
  await catalog.beginDshSessionProvision({
    workId:first.workId,
    operationId:'44444444-4444-4444-8444-444444444444',
    workspaceId:'workspace-shared',
    sessionId:'session-unique',
    origin:'fresh',
    expectedBindingRevision:0,
  });
  await catalog.completeDshSessionProvision({
    workId:first.workId,
    operationId:'44444444-4444-4444-8444-444444444444',
  });

  await assert.rejects(() => catalog.beginDshSessionProvision({
    workId:second.workId,
    operationId:'45555555-5555-4555-8555-555555555555',
    workspaceId:'workspace-shared',
    sessionId:'session-unique',
    origin:'adopted',
    expectedBindingRevision:0,
  }), error => error.code === 'DSH_SESSION_ALREADY_LINKED'
    && error.ownerWorkId === first.workId);
});

test('DSH 归档会话持久化为不可用关联，活动指针与反向导航同步清理', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-dsh-archive-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '归档.html');
  await writeFile(deckPath, '<!doctype html>');
  const catalog = new WorkCatalog({
    filePath:join(root, 'catalog.json'),
    legacyHistory:{ async list() { return { version:1, creation:[], editing:[{ deckPath }] }; } },
  });
  let current = (await catalog.list()).editing[0];
  for (const [operationId, sessionId] of [
    ['45111111-1111-4111-8111-111111111111', 'session-a'],
    ['45222222-2222-4222-8222-222222222222', 'session-b'],
  ]) {
    current = await catalog.beginDshSessionProvision({
      workId:current.workId,
      operationId,
      workspaceId:'workspace-a',
      sessionId,
      origin:'fresh',
      expectedBindingRevision:current.dshBinding.revision,
    });
    current = await catalog.completeDshSessionProvision({
      workId:current.workId,
      operationId,
    });
    current = await catalog.activateDshSession({
      workId:current.workId,
      sessionId,
      expectedBindingRevision:current.dshBinding.revision,
    });
  }
  assert.equal(current.dshBinding.activeSessionId, 'session-b');

  const archivedInactive = await catalog.archiveDshSessions({
    workId:current.workId,
    sessionIds:['session-a'],
    expectedBindingRevision:current.dshBinding.revision,
  });
  assert.equal(archivedInactive.dshBinding.sessions[0].state, 'archived');
  assert.equal(archivedInactive.dshBinding.activeSessionId, 'session-b');
  assert.equal(await catalog.resolveByDshSession('session-a'), null);

  const archivedActive = await catalog.archiveDshSessions({
    workId:current.workId,
    sessionIds:['session-b'],
    expectedBindingRevision:archivedInactive.dshBinding.revision,
  });
  assert.equal(archivedActive.dshBinding.sessions[1].state, 'archived');
  assert.equal(archivedActive.dshBinding.activeSessionId, null);
  assert.equal(await catalog.resolveByDshSession('session-b'), null);

  const retried = await catalog.archiveDshSessions({
    workId:current.workId,
    sessionIds:['session-b'],
    expectedBindingRevision:current.dshBinding.revision,
  });
  assert.equal(retried.dshBinding.revision, archivedActive.dshBinding.revision,
    '重复归档必须幂等，不能因旧 revision 报错或重复写入');
});

test('更换 DSH Workspace 会历史化旧会话并清除活动指针', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-dsh-workspace-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '换目录.html');
  await writeFile(deckPath, '<!doctype html>');
  const catalog = new WorkCatalog({
    filePath:join(root, 'catalog.json'),
    legacyHistory:{ async list() { return { version:1, creation:[], editing:[{ deckPath }] }; } },
  });
  const initial = (await catalog.list()).editing[0];
  await catalog.beginDshSessionProvision({
    workId:initial.workId,
    operationId:'46666666-6666-4666-8666-666666666666',
    workspaceId:'workspace-old',
    sessionId:'session-old',
    origin:'fresh',
    expectedBindingRevision:0,
  });
  const linked = await catalog.completeDshSessionProvision({
    workId:initial.workId,
    operationId:'46666666-6666-4666-8666-666666666666',
  });

  const moved = await catalog.setDshWorkspace({
    workId:initial.workId,
    workspaceId:'workspace-new',
    expectedBindingRevision:linked.dshBinding.revision,
  });
  assert.equal(moved.dshBinding.workspaceId, 'workspace-new');
  assert.equal(moved.dshBinding.activeSessionId, null);
  assert.equal(moved.dshBinding.sessions[0].state, 'historical');

  await assert.rejects(() => catalog.activateDshSession({
    workId:initial.workId,
    sessionId:'session-old',
    expectedBindingRevision:moved.dshBinding.revision,
  }), error => error.code === 'DSH_SESSION_NOT_AVAILABLE');
});

test('明确失败只清除对应 pending，不改变原活动会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-dsh-fail-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '失败恢复.html');
  await writeFile(deckPath, '<!doctype html>');
  const catalog = new WorkCatalog({
    filePath:join(root, 'catalog.json'),
    legacyHistory:{ async list() { return { version:1, creation:[], editing:[{ deckPath }] }; } },
  });
  const initial = (await catalog.list()).editing[0];
  await catalog.beginDshSessionProvision({
    workId:initial.workId,
    operationId:'47777777-7777-4777-8777-777777777777',
    workspaceId:'workspace-a',
    sessionId:'session-a',
    origin:'fresh',
    expectedBindingRevision:0,
  });
  let first = await catalog.completeDshSessionProvision({
    workId:initial.workId,
    operationId:'47777777-7777-4777-8777-777777777777',
  });
  first = await catalog.activateDshSession({
    workId:initial.workId,
    sessionId:'session-a',
    expectedBindingRevision:first.dshBinding.revision,
  });
  const pending = await catalog.beginDshSessionProvision({
    workId:initial.workId,
    operationId:'48888888-8888-4888-8888-888888888888',
    workspaceId:'workspace-a',
    sessionId:'session-b',
    origin:'fresh',
    expectedBindingRevision:first.dshBinding.revision,
  });

  const recovered = await catalog.failDshSessionProvision({
    workId:initial.workId,
    operationId:'48888888-8888-4888-8888-888888888888',
    expectedBindingRevision:pending.dshBinding.revision,
  });
  assert.equal(recovered.dshBinding.activeSessionId, 'session-a');
  assert.equal(recovered.dshBinding.pendingOperation, null);
  assert.equal(recovered.dshBinding.sessions.length, 1);
});

test('项目移除持久记录归档集合，明确恢复保留身份且不会恢复旧活动会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ppt-lifecycle-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '项目.html');
  await writeFile(deckPath, '<!doctype html>');
  const catalog = new WorkCatalog({ filePath:join(root, 'catalog.json'),
    legacyHistory:{ async list() { return { creation:[], editing:[{ deckPath }] }; } } });
  let item = (await catalog.list()).editing[0];
  item = await catalog.setDshWorkspace({ workId:item.workId, workspaceId:'workspace-a', expectedBindingRevision:0 });
  item = await catalog.beginDshSessionProvision({ workId:item.workId, workspaceId:'workspace-a', sessionId:'session-a', operationId:'13333333-3333-4333-8333-333333333333', origin:'fresh', expectedBindingRevision:item.dshBinding.revision });
  item = await catalog.completeDshSessionProvision({ workId:item.workId, operationId:'13333333-3333-4333-8333-333333333333' });
  const pending = await catalog.beginRemoval({ workId:item.workId, expectedRevision:item.revision });
  assert.deepEqual(pending.removal.sessionIds, ['session-a']);
  assert.equal((await catalog.list()).editing.length, 0);
  await assert.rejects(catalog.reopenEditing({ deckPath }), { code:'PROJECT_REMOVING' });
  await catalog.completeRemoval({ workId:item.workId, operationId:pending.removal.operationId, changedSessionIds:['session-a'] });
  const removed = (await catalog.listRemoved())[0];
  assert.equal(removed.lifecycle, 'removed');
  const restored = await catalog.reopenEditing({ deckPath });
  assert.equal(restored.workId, item.workId);
  assert.equal(restored.dshBinding.activeSessionId, null);
  assert.equal(restored.dshBinding.sessions[0].state, 'archived');
  assert.equal(await readFile(deckPath, 'utf8'), '<!doctype html>');
});

test('移除失败可恢复活动项目，移除重试不更换操作身份或归档其他会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ppt-remove-retry-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '项目.html');
  await writeFile(deckPath, '<!doctype html>');
  const catalog = new WorkCatalog({ filePath:join(root, 'catalog.json'),
    legacyHistory:{ async list() { return { creation:[], editing:[{ deckPath }] }; } } });
  const item = (await catalog.list()).editing[0];
  const pending = await catalog.beginRemoval({ workId:item.workId, expectedRevision:item.revision });
  assert.equal((await catalog.beginRemoval({ workId:item.workId, expectedRevision:item.revision })).removal.operationId, pending.removal.operationId);
  await assert.rejects(catalog.completeRemoval({ workId:item.workId, operationId:pending.removal.operationId, changedSessionIds:['foreign-session'] }), { code:'INVALID_DSH_SESSION_IDS' });
  await catalog.cancelRemoval({ workId:item.workId, operationId:pending.removal.operationId, expectedRevision:pending.revision });
  assert.equal((await catalog.list()).editing[0].lifecycle, 'active');
});

test('会话恢复持久锁阻止并发移除，重启重试复用操作身份', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ppt-restore-fence-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '恢复.html');
  await writeFile(deckPath, '<!doctype html>');
  const options = { filePath:join(root, 'catalog.json'), legacyHistory:{ async list() { return { creation:[], editing:[{ deckPath, projectRoot:root }] }; } } };
  let catalog = new WorkCatalog(options);
  let work = (await catalog.list()).editing[0];
  work = await catalog.beginDshSessionProvision({ workId:work.workId, workspaceId:'workspace-a', sessionId:'session-a', operationId:'83333333-3333-4333-8333-333333333333', origin:'fresh', expectedBindingRevision:0 });
  work = await catalog.completeDshSessionProvision({ workId:work.workId, operationId:work.dshBinding.pendingOperation.operationId });
  const pending = await catalog.restoreDshSession({ workId:work.workId, sessionId:'session-a', workspaceId:'workspace-a', expectedRevision:work.revision });
  assert.equal(pending.lifecycle, 'restoring');
  await assert.rejects(catalog.beginRemoval({ workId:work.workId, expectedRevision:pending.revision }), { code:'PROJECT_BUSY' });
  assert.equal((await catalog.list()).editing.length, 0);
  catalog = new WorkCatalog(options);
  const retried = await catalog.restoreDshSession({ workId:work.workId, sessionId:'session-a', workspaceId:'workspace-a', expectedRevision:work.revision });
  assert.equal(retried.restoreOperation.operationId, pending.restoreOperation.operationId);
  await catalog.completeDshRestore({ workId:work.workId, operationId:pending.restoreOperation.operationId });
  await catalog.completeDshRestore({ workId:work.workId, operationId:pending.restoreOperation.operationId });
  assert.equal((await catalog.list()).editing[0].lifecycle, 'active');
});


test('迟到的忙碌回包不能撤销另一窗口已完成的项目移除，取消要求开始时版本', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ppt-remove-late-busy-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '并发移除.html');
  await writeFile(deckPath, '<!doctype html>');
  const options = { filePath:join(root, 'catalog.json'), legacyHistory:{ async list() { return { creation:[], editing:[{ deckPath, projectRoot:root }] }; } } };
  const catalog = new WorkCatalog(options);
  const item = (await catalog.list()).editing[0];
  const pending = await catalog.beginRemoval({ workId:item.workId, expectedRevision:item.revision });
  await assert.rejects(catalog.cancelRemoval({ workId:item.workId, operationId:pending.removal.operationId, expectedRevision:item.revision }), { code:'PROJECT_OPERATION_CONFLICT' });
  const anotherWindow = new WorkCatalog(options);
  await anotherWindow.completeRemoval({ workId:item.workId, operationId:pending.removal.operationId, changedSessionIds:[] });
  await assert.rejects(catalog.cancelRemoval({ workId:item.workId, operationId:pending.removal.operationId, expectedRevision:pending.revision }), { code:'PROJECT_OPERATION_CONFLICT' });
  assert.equal((await catalog.listRemoved())[0].lifecycle, 'removed');
  assert.equal((await catalog.list()).editing.length, 0);
});
