import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';


export function sameMainModulePath(leftPath, rightPath, platform = process.platform) {
  const left = resolve(leftPath);
  const right = resolve(rightPath);
  if (platform === 'win32') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

export function isMainModule(entryPath, moduleUrl, platform = process.platform) {
  if (!entryPath) return false;
  return sameMainModulePath(entryPath, fileURLToPath(moduleUrl), platform);
}
