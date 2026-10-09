import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const PROJECT_STATE_DIRECTORY = '.aico-ppt-editor';
export const LEGACY_PROJECT_STATE_DIRECTORY = '.huawei-deck-editor';
export const PROJECT_STATE_DIRECTORIES = Object.freeze([
  PROJECT_STATE_DIRECTORY,
  LEGACY_PROJECT_STATE_DIRECTORY,
]);

/**
 * 新项目写入 AICO-PPT 目录；已有项目若只有旧目录则继续原位读取和写入。
 * 不自动搬迁活动 sidecar，避免正在运行的旧 Editor 丢失锁和工作副本。
 */
export function resolveProjectStateRoot(projectRoot, {
  exists = existsSync,
  existingChild = [],
} = {}) {
  const current = join(projectRoot, PROJECT_STATE_DIRECTORY);
  const legacy = join(projectRoot, LEGACY_PROJECT_STATE_DIRECTORY);
  if (existingChild.length > 0) {
    if (exists(join(current, ...existingChild))) return current;
    if (exists(join(legacy, ...existingChild))) return legacy;
  }
  if (exists(current)) return current;
  return exists(legacy) ? legacy : current;
}

export function isProjectStateDirectoryName(name) {
  return PROJECT_STATE_DIRECTORIES.includes(name);
}
