/** 只导入受支持的全局历史索引；项目 sidecar、凭据及原 DSH 会话保持原位。 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const FILES = ['work-catalog.json', 'recent-work.json', 'recent-decks.json'];
const digest = value => createHash('sha256').update(value).digest('hex');

async function canonicalTarget(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await canonicalTarget(parent), relative(parent, path));
  }
}

function convert(name, parsed) {
  if (name === 'work-catalog.json') {
    if (![2, 3].includes(parsed.version) || !Array.isArray(parsed.workItems)) throw new Error('工作目录版本不受支持，未导入任何数据');
    return {
      ...parsed, version:3, revision:(Number.isInteger(parsed.revision) ? parsed.revision : 0) + 1,
      workItems:parsed.workItems.map(item => {
        if (!item || typeof item !== 'object' || typeof item.workId !== 'string') throw new Error('工作目录记录无效');
        return { ...item, dshBinding:{ revision:0, workspaceId:null, activeSessionId:null, sessions:[], pendingOperation:null } };
      }),
    };
  }
  const list = name === 'recent-work.json' ? 'creation' : 'entries';
  if (parsed.version !== 1 || !Array.isArray(parsed[list])) throw new Error(`${name} 版本不受支持，未导入任何数据`);
  return parsed;
}

/**
 * 导入到不存在或为空的目标目录；相同来源快照的重复导入不覆盖目标的新工作。
 * 调用者必须先停止使用目标目录的 AICO 实例。来源快照变化、未知格式及非空目标均拒绝。
 */
export async function importHistory({ source, target }) {
  source = await realpath(resolve(source));
  target = resolve(target);
  let targetInfo;
  try { targetInfo = await lstat(target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (targetInfo?.isSymbolicLink()) throw new Error('目标不能是符号链接');
  target = await canonicalTarget(target);
  const suffix = relative(source, target);
  if (!suffix) throw new Error('来源和目标不能相同');
  if (suffix !== '..' && !suffix.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(suffix)) throw new Error('目标不能位于来源目录内部');
  const raw = {};
  const converted = {};
  for (const name of FILES) {
    const path = join(source, name);
    try {
      if (!(await lstat(path)).isFile()) throw new Error(`来源索引必须是普通文件：${name}`);
      raw[name] = await readFile(path, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    converted[name] = convert(name, JSON.parse(raw[name]));
  }
  if (!Object.keys(raw).length) throw new Error('来源目录没有可导入的 PPT 历史索引');
  const fingerprint = digest(JSON.stringify({ source, raw }));
  const marker = '.aico-history-import.json';
  try {
    const receipt = JSON.parse(await readFile(join(target, marker), 'utf8'));
    if (receipt.version === 1 && receipt.fingerprint === fingerprint) return { alreadyImported:true, files:Object.keys(raw) };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (targetInfo && (await readdir(target)).length) throw new Error('目标目录已存在且非空；请在首次启动前导入，或使用新的 AICO_HOME');
  await mkdir(dirname(target), { recursive:true, mode:0o700 });
  const stage = join(dirname(target), `.aico-history-${randomUUID()}`);
  await mkdir(stage, { mode:0o700 });
  try {
    for (const [name, value] of Object.entries(converted)) {
      await writeFile(join(stage, name), JSON.stringify(value, null, 2) + '\n', { mode:0o600, flag:'wx' });
    }
    for (const [name, original] of Object.entries(raw)) {
      if (await readFile(join(source, name), 'utf8') !== original) throw new Error('来源历史在导入期间发生变化，请关闭旧编辑器后重试');
    }
    await writeFile(join(stage, marker), JSON.stringify({ version:1, source, fingerprint, files:Object.keys(raw) }) + '\n', { mode:0o600, flag:'wx' });
    if (targetInfo) await rmdir(target);
    await rename(stage, target);
    return { alreadyImported:false, files:Object.keys(raw) };
  } finally { await rm(stage, { recursive:true, force:true }); }
}
