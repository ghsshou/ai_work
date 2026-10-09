export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_SOURCES = new Set(['selected', 'pasted']);

const isAttachmentSource = source => source === 'selected' || source === 'pasted';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ATTACHMENT_PATH = /^attachments\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(\.[a-z0-9]{1,16})$/;
const ATTACHMENT_METADATA_KEYS = [
  'createdAt', 'id', 'mime', 'name', 'relativePath', 'size', 'source',
];

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isCanonicalUuidV4(value) {
  return typeof value === 'string' && UUID_V4.test(value);
}

function readStrictMetadata(value) {
  if (!isPlainObject(value)) throw new TypeError('附件元数据字段无效');
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== ATTACHMENT_METADATA_KEYS.length
    || ownKeys.some(key => typeof key !== 'string' || !ATTACHMENT_METADATA_KEYS.includes(key))) {
    throw new TypeError('附件元数据字段无效');
  }
  const metadata = {};
  for (const key of ATTACHMENT_METADATA_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('附件元数据字段无效');
    }
    metadata[key] = descriptor.value;
  }
  return metadata;
}

function validateAttachmentName(name) {
  if (typeof name !== 'string' || Array.from(name).length === 0 || Array.from(name).length > 240
    || /[\p{Cc}\p{Cs}\p{Bidi_Control}\u200B\uFEFF]/u.test(name)) {
    throw new TypeError('附件名称必须是不含控制、双向或危险不可见字符的 1–240 个字符');
  }
  return name;
}

function validateAttachmentMime(mime) {
  if (typeof mime !== 'string' || mime.length > 255 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(mime)) {
    throw new TypeError('附件 MIME 类型无效');
  }
  return mime;
}

function validateAttachmentSize(size) {
  if (!Number.isSafeInteger(size)) throw new TypeError('附件大小必须是安全整数');
  if (size <= 0) throw new RangeError('附件不能是空文件');
  if (size > MAX_ATTACHMENT_BYTES) throw new RangeError('单个附件不得超过 25 MiB');
  return size;
}

function validateCreatedAt(createdAt) {
  if (typeof createdAt !== 'string') throw new TypeError('附件创建时间必须是 ISO-8601 时间');
  const time = new Date(createdAt);
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== createdAt) {
    throw new TypeError('附件创建时间必须是 ISO-8601 时间');
  }
  return createdAt;
}

export function parseAttachmentRelativePath(relativePath) {
  if (typeof relativePath !== 'string') throw new TypeError('附件相对路径无效');
  const match = relativePath.match(ATTACHMENT_PATH);
  if (!match) throw new TypeError('附件相对路径无效');
  return { taskId:match[1], attachmentId:match[2], suffix:match[3] };
}

export function validateFileLike(file) {
  if (!file || typeof file.name !== 'string' || !Number.isSafeInteger(file.size)) {
    throw new TypeError('附件不是有效文件');
  }
  validateAttachmentName(file.name);
  validateAttachmentSize(file.size);
  return file;
}

export function validateAttachmentMetadata(value, taskId) {
  const metadata = readStrictMetadata(value);
  if (!isCanonicalUuidV4(taskId) || !isCanonicalUuidV4(metadata.id)) {
    throw new TypeError('附件和任务 ID 必须是规范 UUID v4');
  }
  validateAttachmentName(metadata.name);
  validateAttachmentMime(metadata.mime);
  validateAttachmentSize(metadata.size);
  if (!isAttachmentSource(metadata.source)) throw new TypeError('附件来源无效');
  const parsedPath = parseAttachmentRelativePath(metadata.relativePath);
  if (parsedPath.taskId !== taskId || parsedPath.attachmentId !== metadata.id) {
    throw new TypeError('附件相对路径与任务或附件 ID 不匹配');
  }
  validateCreatedAt(metadata.createdAt);
  return {
    id:metadata.id,
    name:metadata.name,
    mime:metadata.mime,
    size:metadata.size,
    source:metadata.source,
    relativePath:metadata.relativePath,
    createdAt:metadata.createdAt,
  };
}
