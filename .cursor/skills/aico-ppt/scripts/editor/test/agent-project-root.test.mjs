import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertProjectRootIdentity,
  resolveAgentTerminalCwd,
  resolveProjectRoot,
  resolveSelectedProjectRoot,
} from '../agent-workspace/project-root.mjs';

async function fixture(t, name = 'project-root-') {
  const root = await mkdtemp(join(tmpdir(), name));
  t.after(() => rm(root, { recursive:true, force:true }));
  return realpath(root);
}

test('Deck 位于 Git 仓库子目录时默认使用 HTML 的直接父目录', async t => {
  const root = await fixture(t);
  const deckDir = join(root, 'Deck-Projects', 'renzhi');
  await mkdir(join(root, '.git'));
  await mkdir(deckDir, { recursive:true });
  const deckPath = join(deckDir, 'renzhi-deck.html');
  await writeFile(deckPath, 'deck');

  const result = await resolveProjectRoot({ deckPath });
  assert.equal(result.path, deckDir);
  assert.equal(result.source, 'deck-directory');
  assert.equal(result.needsConfirmation, false);
});

test('保留有效的已保存目录，消失后使用 HTML 父目录而不向上查找工作区标记', async t => {
  const root = await fixture(t);
  const persisted = join(root, 'persisted');
  const deckDir = join(root, 'workspace', 'slides');
  await mkdir(persisted);
  await mkdir(deckDir, { recursive:true });
  await writeFile(join(root, 'workspace', 'package.json'), '{}');
  const deckPath = join(deckDir, 'deck.html');
  await writeFile(deckPath, 'deck');

  assert.equal((await resolveProjectRoot({ deckPath, persistedRoot:persisted })).path, persisted);
  await rm(persisted, { recursive:true });
  const fallback = await resolveProjectRoot({ deckPath, persistedRoot:persisted });
  assert.equal(fallback.path, deckDir);
  assert.equal(fallback.source, 'deck-directory');
});

test('显式目录优先于已保存目录，启动目录不改变 HTML 的默认项目目录', async t => {
  const root = await fixture(t);
  const explicit = join(root, 'explicit');
  const persisted = join(root, 'persisted');
  const launch = join(root, 'launch');
  const deckDir = join(launch, 'slides');
  await mkdir(explicit);
  await mkdir(persisted);
  await mkdir(deckDir, { recursive:true });
  const deckPath = join(deckDir, 'deck.html');
  await writeFile(deckPath, 'deck');

  let result = await resolveProjectRoot({
    deckPath, persistedRoot:persisted, explicitRoot:explicit, launchCwd:launch,
  });
  assert.equal(result.path, explicit);
  assert.equal(result.source, 'explicit');
  result = await resolveProjectRoot({ deckPath, launchCwd:launch });
  assert.equal(result.path, deckDir);
  assert.equal(result.source, 'deck-directory');
  result = await resolveProjectRoot({ deckPath, launchCwd:explicit });
  assert.equal(result.path, deckDir);
  assert.equal(result.source, 'deck-directory');
});

test('无 marker 回退 Deck 父目录，HOME/Downloads 等过宽目录要求确认', async t => {
  const home = await fixture(t, 'project-root-home-');
  const downloads = join(home, 'Downloads');
  await mkdir(downloads);
  const ordinary = join(home, 'ordinary');
  await mkdir(ordinary);
  const ordinaryDeck = join(ordinary, 'deck.html');
  const broadDeck = join(downloads, 'deck.html');
  await writeFile(ordinaryDeck, 'deck');
  await writeFile(broadDeck, 'deck');

  assert.equal((await resolveProjectRoot({ deckPath:ordinaryDeck, homeDir:home })).needsConfirmation, false);
  const broad = await resolveProjectRoot({ deckPath:broadDeck, homeDir:home });
  assert.equal(broad.needsConfirmation, true);
  assert.match(broad.warning, /范围过宽|确认/);
});

test('确认后符号链接换目标会被 identity 复核拒绝', async t => {
  const root = await fixture(t);
  const first = join(root, 'first');
  const second = join(root, 'second');
  const link = join(root, 'selected');
  await mkdir(first);
  await mkdir(second);
  try {
    await symlink(first, link, 'dir');
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') {
      t.skip('Windows 未启用开发者模式，无法创建目录符号链接');
      return;
    }
    throw error;
  }
  const deck = join(first, 'deck.html');
  await writeFile(deck, 'deck');
  const selected = await resolveProjectRoot({ deckPath:deck, explicitRoot:link });
  await rm(link);
  await symlink(second, link, 'dir');

  await assert.rejects(
    () => assertProjectRootIdentity(selected),
    error => error.code === 'PROJECT_ROOT_CHANGED',
  );
});

test('新建 Deck 可直接校验用户选择的项目目录', async t => {
  const root = await fixture(t, 'deck-new-project-');
  const selected = await resolveSelectedProjectRoot({ selectedPath:root });
  assert.equal(selected.path, root);
  assert.equal(selected.source, 'explicit');
  assert.equal(selected.needsConfirmation, false);
  assert.equal(await assertProjectRootIdentity(selected), selected.path);
});

test('Windows 终端保留任意可信盘符路径，真实 UNC 仅用于 identity', async () => {
  const canonical = String.raw`\\Mac\Home\zyq_workspace\aico-ppt`;
  const mapped = String.raw`Y:\aico-ppt`;
  const inspected = new Map([
    [canonical, { path:canonical, originalPath:canonical }],
    [mapped, { path:canonical, originalPath:mapped }],
  ]);
  const cwd = await resolveAgentTerminalCwd({
    projectRoot:canonical,
    preferredCwd:mapped,
    platform:'win32',
    inspectDirectory:async path => inspected.get(path) ?? null,
  });
  assert.equal(cwd, mapped);
});

test('Windows 普通本地目录直接作为终端 cwd，不依赖 Parallels 盘符', async () => {
  const local = String.raw`C:\work\aico-ppt`;
  assert.equal(await resolveAgentTerminalCwd({
    projectRoot:local,
    platform:'win32',
    inspectDirectory:async () => null,
  }), local);
});

test('Windows 可从现有任意映射盘恢复 UNC 项目的终端 cwd', async () => {
  const canonical = String.raw`\\server\share\team\deck`;
  const root = 'R:\\';
  const mapped = String.raw`R:\team\deck`;
  const shareRoot = "\\\\server\\share\\";
  const inspected = new Map([
    [shareRoot, {
      path:shareRoot, originalPath:shareRoot,
      identity:{ dev:'7', ino:'10' },
    }],
    [root, { path:root, originalPath:root, identity:{ dev:'7', ino:'10' } }],
    [mapped, { path:mapped, originalPath:mapped, identity:{ dev:'7', ino:'20' } }],
    [canonical, { path:canonical, originalPath:canonical, identity:{ dev:'7', ino:'20' } }],
  ]);
  assert.equal(await resolveAgentTerminalCwd({
    projectRoot:canonical,
    platform:'win32',
    driveLetters:['R'],
    inspectDirectory:async path => inspected.get(path) ?? null,
  }), mapped);
});

test('Windows 映射盘指向 UNC 子目录时仍可恢复项目终端 cwd', async () => {
  const canonical = String.raw`\\Mac\Home\zyq_workspace\aico-ppt`;
  const shareRoot = '\\\\Mac\\Home\\';
  const driveRoot = 'Y:\\';
  const driveCanonical = String.raw`\\Mac\Home\zyq_workspace`;
  const mapped = String.raw`Y:\aico-ppt`;
  const inspected = new Map([
    [canonical, {
      path:canonical, originalPath:canonical,
      identity:{ dev:'0', ino:'20' },
    }],
    [shareRoot, {
      path:shareRoot, originalPath:shareRoot,
      identity:{ dev:'0', ino:'10' },
    }],
    [driveRoot, {
      path:driveCanonical, originalPath:driveRoot,
      identity:{ dev:'0', ino:'15' },
    }],
    [mapped, {
      path:canonical, originalPath:mapped,
      identity:{ dev:'0', ino:'20' },
    }],
  ]);
  assert.equal(await resolveAgentTerminalCwd({
    projectRoot:canonical,
    platform:'win32',
    driveLetters:['Y'],
    inspectDirectory:async path => inspected.get(path) ?? null,
  }), mapped);
});
