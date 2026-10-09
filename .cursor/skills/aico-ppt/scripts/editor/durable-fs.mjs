import { open } from 'node:fs/promises';

const PORTABLE_DIRECTORY_SYNC_ERRORS = new Set(['EINVAL', 'ENOTSUP', 'EISDIR']);

export function directorySyncUnsupported(error, platform = process.platform) {
  return PORTABLE_DIRECTORY_SYNC_ERRORS.has(error?.code)
    || (platform === 'win32' && error?.code === 'EPERM');
}

export function fileOpenModeForSync(platform = process.platform) {
  // Node/Windows 的只读句柄在 SMB、Parallels 映射盘上 FlushFileBuffers 会返回
  // EPERM；同一常规文件的可写句柄可以可靠 flush。其他平台保留只读句柄，
  // 这样已经写成只读权限的发布文件仍可完成目录提交前的确认。
  return platform === 'win32' ? 'r+' : 'r';
}

export async function syncFile(path, { platform = process.platform } = {}) {
  const handle = await open(path, fileOpenModeForSync(platform));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectory(path, { platform = process.platform } = {}) {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (!directorySyncUnsupported(error, platform)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}
