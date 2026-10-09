import { pathToFileURL } from 'node:url';
import { posix, resolve, win32 } from 'node:path';

function encodeWindowsParts(parts) {
  return parts.filter(Boolean).map(encodeURIComponent).join('/');
}

export function deckFileUrl(path, platform = process.platform) {
  if (platform !== 'win32') {
    if (process.platform !== 'win32') return pathToFileURL(resolve(path)).href;
    const absolute = posix.resolve(path);
    return `file://${absolute.split('/').map(encodeURIComponent).join('/')}`;
  }
  const normalized = win32.normalize(path);
  if (normalized.startsWith('\\\\')) {
    const [host, ...parts] = normalized.slice(2).split('\\');
    if (!host || parts.length === 0) throw new TypeError('UNC Deck 路径无效');
    return `file://${host}/${encodeWindowsParts(parts)}`;
  }
  const match = /^([A-Za-z]):\\(.*)$/.exec(normalized);
  if (!match) throw new TypeError('Windows Deck 路径必须是盘符或 UNC 绝对路径');
  return `file:///${match[1].toUpperCase()}:/${encodeWindowsParts(match[2].split('\\'))}`;
}
