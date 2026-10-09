import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const WORKSPACE_CAPABILITY_FILENAME = 'workspace-capability.json';
export const WORKSPACE_CAPABILITY_SCOPE = 'managed-deck-workspace';

function validateCapability(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || value.scope !== WORKSPACE_CAPABILITY_SCOPE
    || typeof value.url !== 'string' || !value.url
    || typeof value.token !== 'string' || !value.token) {
    throw new TypeError('capability 文件不是有效的 Managed Deck Workspace 凭据');
  }
  return value;
}

export async function readWorkspaceCapability(path) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`无法读取 Workspace capability: ${error.message}`);
  }
  try {
    return validateCapability(JSON.parse(contents));
  } catch (error) {
    throw new Error(`Workspace capability 无效: ${error.message}`);
  }
}

export async function writeWorkspaceCapability(sessionDir, capability) {
  const path = join(sessionDir, WORKSPACE_CAPABILITY_FILENAME);
  const temporaryPath = join(
    sessionDir,
    `.${WORKSPACE_CAPABILITY_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  const value = validateCapability({
    version:1,
    scope:WORKSPACE_CAPABILITY_SCOPE,
    ...capability,
  });
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding:'utf8', mode:0o600, flag:'wx',
  });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return path;
}

export async function removeWorkspaceCapability(path) {
  if (!path) return;
  await unlink(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}
