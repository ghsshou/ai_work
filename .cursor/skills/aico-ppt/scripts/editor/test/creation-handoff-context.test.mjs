import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildCreationHandoffPrompt,
  inspectCreationHandoffArtifacts,
  loadCreationHandoffContext,
  persistCreationHandoffContext,
} from '../creation-handoff-context.mjs';

function draft(projectRoot, draftDir) {
  const planPath = join(projectRoot, '连续性.plan.md');
  return {
    version:1,
    draftId:'draft-continuity',
    revision:12,
    phase:'ready',
    projectRoot,
    provider:'codex',
    brief:{
      title:'连续性交接 Deck', audience:'研发', objective:'丝滑进入修改',
      materials:'架构图、访谈纪要', recommendedTemplateId:'tech-share',
    },
    briefConfirmedRevision:2,
    outline:{ sections:[{ chapterId:'one', title:'背景', objective:'建立共识' }] },
    outlineStatus:'confirmed',
    outlineConfirmedRevision:4,
    pagePlan:{ pages:[{ pageId:'p1', chapterId:'one', pageTypeId:'cover', label:'封面' }] },
    pagePlanStatus:'confirmed',
    pagePlanConfirmedRevision:6,
    output:{ fileName:'连续性.html', templateId:'tech-share' },
    generation:{
      status:'published',
      publishedDeck:join(projectRoot, '连续性.html'),
      publishedPlan:planPath,
      diagnostics:[{ code:'ok' }],
    },
    milestones:{
      brief:{ complete:true, path:join(draftDir, 'brief.json') },
      outline:{ complete:true, path:join(draftDir, 'outline.json') },
      pagePlan:{ complete:true, path:join(draftDir, 'page-plan.json') },
    },
    createdAt:'2026-08-12T12:00:00.000Z',
    updatedAt:'2026-08-12T12:10:00.000Z',
  };
}

test('Creation 交接持久化设计文稿、素材库和已确认上下文', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-creation-handoff-'));
  t.after(() => rm(projectRoot, { recursive:true, force:true }));
  const draftDir = join(projectRoot, '.aico-ppt-editor', 'drafts', 'draft-continuity');
  const sessionDir = join(projectRoot, '.aico-ppt-editor', 'sessions', 'editing');
  await Promise.all([
    mkdir(join(draftDir, 'materials'), { recursive:true }),
    mkdir(join(draftDir, 'diagnostics'), { recursive:true }),
    mkdir(sessionDir, { recursive:true }),
  ]);
  const value = draft(projectRoot, draftDir);
  await Promise.all([
    writeFile(join(draftDir, 'brief.json'), '{}'),
    writeFile(join(draftDir, 'outline.json'), '{}'),
    writeFile(join(draftDir, 'page-plan.json'), '{}'),
    writeFile(join(projectRoot, '连续性.plan.md'), '# 设计文稿'),
  ]);

  const persisted = await persistCreationHandoffContext(sessionDir, {
    draft:value,
    draftDir,
    conversationId:'019ff3bd-3f52-7f91-8ee6-61da2977a39f',
    now:() => '2026-08-12T12:20:00.000Z',
  });
  const loaded = await loadCreationHandoffContext(sessionDir);

  assert.equal(loaded.path, persisted.path);
  assert.equal(loaded.context.draftId, 'draft-continuity');
  assert.equal(loaded.context.draft.brief.title, '连续性交接 Deck');
  assert.deepEqual(loaded.context.draft.outline, value.outline);
  assert.deepEqual(loaded.context.draft.pagePlan, value.pagePlan);
  assert.equal(loaded.context.artifacts.planPath, join(projectRoot, '连续性.plan.md'));
  assert.equal(loaded.context.artifacts.materialsDirectory, join(draftDir, 'materials'));
  assert.doesNotMatch(await readFile(persisted.path, 'utf8'), /token/i);
  assert.deepEqual(await inspectCreationHandoffArtifacts(loaded.context), {
    briefPath:true,
    outlinePath:true,
    pagePlanPath:true,
    planPath:true,
    materialsDirectory:true,
    diagnosticsDirectory:true,
  });
  assert.match(buildCreationHandoffPrompt(loaded), /不要再次完整读取 SKILL\.md/);
  assert.match(buildCreationHandoffPrompt(loaded), /素材库/);
});

test('Creation 交接拒绝引用项目目录之外的素材与设计文件', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-creation-handoff-unsafe-'));
  t.after(() => rm(projectRoot, { recursive:true, force:true }));
  const draftDir = join(projectRoot, '.aico-ppt-editor', 'drafts', 'draft-continuity');
  const sessionDir = join(projectRoot, '.aico-ppt-editor', 'sessions', 'editing');
  await Promise.all([mkdir(draftDir, { recursive:true }), mkdir(sessionDir, { recursive:true })]);
  const value = draft(projectRoot, draftDir);
  value.generation.publishedPlan = '/tmp/foreign.plan.md';

  await assert.rejects(
    persistCreationHandoffContext(sessionDir, { draft:value, draftDir }),
    error => error.code === 'INVALID_CREATION_HANDOFF' && /设计文稿/.test(error.message),
  );
});

test('旧版 creation.json 在首次打开修改任务时迁移为正式上下文', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-creation-handoff-legacy-'));
  t.after(() => rm(projectRoot, { recursive:true, force:true }));
  const draftDir = join(projectRoot, '.aico-ppt-editor', 'drafts', 'draft-continuity');
  const sessionDir = join(projectRoot, '.aico-ppt-editor', 'sessions', 'editing');
  await Promise.all([mkdir(draftDir, { recursive:true }), mkdir(sessionDir, { recursive:true })]);
  const value = draft(projectRoot, draftDir);
  await writeFile(join(sessionDir, 'creation.json'), `${JSON.stringify(value)}\n`);

  const migrated = await loadCreationHandoffContext(sessionDir);

  assert.equal(migrated.migratedFrom, join(sessionDir, 'creation.json'));
  assert.equal(migrated.context.draft.brief.title, '连续性交接 Deck');
  assert.equal(migrated.context.artifacts.materialsDirectory, join(draftDir, 'materials'));
  assert.equal(
    JSON.parse(await readFile(migrated.path, 'utf8')).kind,
    'creation-to-editing',
  );
});
