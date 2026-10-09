import { isAbsolute, relative, resolve } from 'node:path';
import { parseAttachmentRelativePath } from './attachment-protocol.mjs';

export function resolveAttachmentPath(sessionDir, relativePath) {
  if (typeof sessionDir !== 'string' || sessionDir.length === 0) {
    throw new TypeError('session 目录无效');
  }
  parseAttachmentRelativePath(relativePath);
  const attachmentsDir = resolve(sessionDir, 'attachments');
  const target = resolve(sessionDir, relativePath);
  const contained = relative(attachmentsDir, target);
  if (contained === '' || contained === '..' || contained.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || isAbsolute(contained)) {
    throw new TypeError('附件相对路径逃逸 session 附件目录');
  }
  return target;
}
