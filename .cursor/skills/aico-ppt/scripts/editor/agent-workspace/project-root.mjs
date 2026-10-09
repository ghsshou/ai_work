import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve, win32 } from 'node:path';

function projectError(code, statusCode, message) {
  return Object.assign(new Error(message), { code, statusCode });
}

async function existingDirectory(path) {
  if (typeof path !== 'string' || !path) return null;
  try {
    const canonical = await realpath(path);
    const info = await stat(canonical, { bigint:true });
    if (!info.isDirectory()) return null;
    return {
      path:canonical,
      originalPath:resolve(path),
      identity:{ dev:String(info.dev), ino:String(info.ino) },
    };
  } catch {
    return null;
  }
}

function isBroadFallback(path, homeDir) {
  const broad = new Set([
    parse(path).root,
    homeDir,
    join(homeDir, 'Desktop'),
    join(homeDir, 'Downloads'),
    join(homeDir, 'Documents'),
  ].map(value => resolve(value)));
  return broad.has(resolve(path));
}

function result(candidate, source, { needsConfirmation = false, warning = null } = {}) {
  return {
    path:candidate.path,
    source,
    needsConfirmation,
    warning,
    identity:{
      originalPath:candidate.originalPath,
      realPath:candidate.path,
      dev:candidate.identity.dev,
      ino:candidate.identity.ino,
    },
  };
}

function sameWindowsPath(left, right) {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

function windowsDrivePath(path) {
  return typeof path === 'string'
    && /^[a-z]:[\\/]/i.test(path)
    && win32.isAbsolute(path);
}

function sameDirectoryIdentity(left, right) {
  if (!left || !right) return false;
  if (left.identity && right.identity
    && left.identity.dev === right.identity.dev
    && left.identity.ino === right.identity.ino) return true;
  return typeof left.path === 'string' && typeof right.path === 'string'
    && sameWindowsPath(left.path, right.path);
}

/**
 * 为 Windows PTY 找到可被 CMD 使用的 cwd。
 *
 * projectRoot 始终保留 realpath 后的可信路径；映射盘只作为进程启动别名，且
 * 必须再次 realpath 到同一个项目目录。盘符不做任何固定假设，普通 C:/D:
 * 本地目录、企业网络映射盘和 Parallels 共享盘使用同一条验证路径。
 */
export async function resolveAgentTerminalCwd({
  projectRoot,
  preferredCwd = null,
  platform = process.platform,
  inspectDirectory = existingDirectory,
  projectIdentity = null,
  driveLetters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
} = {}) {
  if (typeof projectRoot !== 'string' || !projectRoot) {
    throw projectError('PROJECT_ROOT_INVALID', 400, '缺少 Agent 项目目录');
  }
  if (platform !== 'win32') return projectRoot;
  if (!win32.isAbsolute(projectRoot)) {
    throw projectError('PROJECT_ROOT_INVALID', 400, 'Windows Agent 项目目录必须是绝对路径');
  }
  if (windowsDrivePath(projectRoot)) return win32.normalize(projectRoot);

  const project = projectIdentity
    ? { path:projectRoot, identity:projectIdentity }
    : await inspectDirectory(projectRoot);
  if (!project) {
    throw projectError('PROJECT_ROOT_INVALID', 400, 'Windows Agent 项目目录不存在');
  }
  const trustedDriveAlias = async candidate => {
    if (!windowsDrivePath(candidate)) return null;
    const normalized = win32.normalize(candidate);
    const inspected = await inspectDirectory(normalized);
    return sameDirectoryIdentity(inspected, project)
      ? normalized
      : null;
  };
  const preferred = await trustedDriveAlias(preferredCwd);
  if (preferred) return preferred;

  // persisted workspace 可能只剩 UNC realpath；从当前机器已有的任意映射盘
  // 反查同一目录。映射盘既可能指向共享根，也可能直接指向共享内的某个
  // 子目录（Parallels 常见）；最终只接受 identity 完全回到项目目录的候选。
  const uncRoot = await inspectDirectory(win32.parse(projectRoot).root);
  const aliases = await Promise.all(driveLetters.map(async letter => {
    if (typeof letter !== 'string' || !/^[a-z]$/i.test(letter)) return null;
    const driveRoot = `${letter.toUpperCase()}:\\`;
    const root = await inspectDirectory(driveRoot);
    if (!root) return null;
    let suffix = win32.relative(root.path, project.path);
    if (suffix.startsWith('..') || win32.isAbsolute(suffix)) {
      if (!sameDirectoryIdentity(root, uncRoot)) return null;
      suffix = win32.relative(win32.parse(projectRoot).root, projectRoot);
    }
    if (suffix.startsWith('..') || win32.isAbsolute(suffix)) return null;
    return trustedDriveAlias(win32.join(driveRoot, suffix));
  }));
  const alias = aliases.find(Boolean);
  if (alias) return alias;
  throw projectError(
    'WINDOWS_UNC_TERMINAL_CWD',
    409,
    'Windows CMD 不能把 UNC 路径作为当前目录；请先把项目共享目录映射为任意盘符后重试',
  );
}

export async function resolveProjectRoot({
  deckPath,
  persistedRoot = null,
  explicitRoot = null,
  homeDir = homedir(),
} = {}) {
  const deckRealPath = await realpath(deckPath).catch(() => {
    throw projectError('DECK_NOT_FOUND', 404, 'Deck 文件不存在');
  });
  const deckInfo = await stat(deckRealPath);
  if (!deckInfo.isFile()) throw projectError('DECK_NOT_FILE', 400, 'Deck 必须是常规文件');
  const deckDirectory = dirname(deckRealPath);

  const explicit = await existingDirectory(explicitRoot);
  if (explicit) return result(explicit, 'explicit');
  const persisted = await existingDirectory(persistedRoot);
  if (persisted) return result(persisted, 'persisted');
  const fallback = await existingDirectory(deckDirectory);
  const needsConfirmation = isBroadFallback(fallback.path, await realpath(homeDir).catch(() => homeDir));
  return result(fallback, 'deck-directory', {
    needsConfirmation,
    warning:needsConfirmation
      ? '自动识别的项目目录范围过宽，请确认或更改后再启动 Agent。'
      : null,
  });
}

export async function resolveSelectedProjectRoot({
  selectedPath,
  homeDir = homedir(),
} = {}) {
  const selected = await existingDirectory(selectedPath);
  if (!selected) {
    throw projectError('PROJECT_ROOT_INVALID', 400, '选择的项目目录不存在或不是目录');
  }
  const canonicalHome = await realpath(homeDir).catch(() => resolve(homeDir));
  const needsConfirmation = isBroadFallback(selected.path, canonicalHome);
  return result(selected, 'explicit', {
    needsConfirmation,
    warning:needsConfirmation
      ? '所选项目目录范围过宽，请确认 Agent 可以把它作为新 Deck 的项目上下文。'
      : null,
  });
}

export async function assertProjectRootIdentity(projectRoot) {
  if (!projectRoot?.identity) {
    throw projectError('PROJECT_ROOT_INVALID', 400, '缺少项目目录 identity');
  }
  try {
    const currentRealPath = await realpath(projectRoot.identity.originalPath);
    const info = await stat(currentRealPath, { bigint:true });
    if (!info.isDirectory()
      || currentRealPath !== projectRoot.identity.realPath
      || String(info.dev) !== projectRoot.identity.dev
      || String(info.ino) !== projectRoot.identity.ino) {
      throw new Error('项目目录身份已变化');
    }
    return projectRoot.path;
  } catch (error) {
    throw projectError(
      'PROJECT_ROOT_CHANGED',
      409,
      '项目目录在确认后发生变化，请重新选择',
    );
  }
}
