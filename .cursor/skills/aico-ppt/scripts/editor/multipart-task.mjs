import { TextDecoder } from 'node:util';
import { PassThrough } from 'node:stream';
import Busboy from 'busboy';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
} from './attachment-protocol.mjs';
import { validateTask } from './protocol.mjs';
import { MAX_SNAPSHOT_BYTES } from './session-store.mjs';

export const MAX_TASK_METADATA_BYTES = 64 * 1024;

const TASK_REQUIRED_KEYS = [
  'attachmentSources', 'expectedRevision', 'instruction', 'pageIndex', 'pageKey',
  'pageLabel', 'rect',
];
const TASK_OPTIONAL_KEYS = ['candidates', 'pageState'];
const TASK_KEYS = new Set([...TASK_REQUIRED_KEYS, ...TASK_OPTIONAL_KEYS]);
const RECT_KEYS = ['h', 'w', 'x', 'y'];
const UTF8 = new TextDecoder('utf-8', { fatal:true });
const MAX_PART_HEADER_BYTES = 16 * 1024;
// Busboy 1.6.0 以 `++pairCount < 2000` 保存 header；第 2000 对起会静默丢弃。
const MAX_PART_HEADER_PAIRS = 1999;
const MAX_TRANSPORT_PADDING_BYTES = 1024;
const MAX_BOUNDARY_BYTES = 200;
const MAX_MULTIPART_PARTS = MAX_ATTACHMENTS + 2;
export const MAX_PREAMBLE_BYTES = 64 * 1024;
export const MAX_EPILOGUE_BYTES = 64 * 1024;
export const DEFAULT_MULTIPART_IDLE_TIMEOUT_MS = 120_000;
const MAX_INITIAL_DELIMITER_BYTES = 2 + MAX_BOUNDARY_BYTES
  + MAX_TRANSPORT_PADDING_BYTES + 2;
const MAX_REGULAR_DELIMITER_BYTES = 2 + 2 + MAX_BOUNDARY_BYTES
  + MAX_TRANSPORT_PADDING_BYTES + 2;
const MAX_CLOSING_DELIMITER_BYTES = 2 + 2 + MAX_BOUNDARY_BYTES + 2
  + MAX_TRANSPORT_PADDING_BYTES + 2;
const MAX_MULTIPART_FRAMING_BYTES = MAX_INITIAL_DELIMITER_BYTES
  + ((MAX_MULTIPART_PARTS - 1) * MAX_REGULAR_DELIMITER_BYTES)
  + MAX_CLOSING_DELIMITER_BYTES
  + (MAX_MULTIPART_PARTS * (MAX_PART_HEADER_BYTES + 4));
export const MAX_MULTIPART_WIRE_BYTES = MAX_PREAMBLE_BYTES
  + MAX_TASK_METADATA_BYTES
  + MAX_SNAPSHOT_BYTES
  + (MAX_ATTACHMENTS * MAX_ATTACHMENT_BYTES)
  + MAX_MULTIPART_FRAMING_BYTES
  + MAX_EPILOGUE_BYTES;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MIME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function multipartError(code, statusCode, message, details = {}) {
  return Object.assign(new Error(message), {
    code, statusCode, stage:'multipart', ...details,
  });
}

function invalid(message, details) {
  return multipartError('INVALID_MULTIPART', 400, message, details);
}

function multipartTooLarge(message) {
  return multipartError('MULTIPART_TOO_LARGE', 413, message);
}

function parseParameterizedValue(value, label) {
  if (typeof value !== 'string') throw invalid(`${label} 无效`);
  let index = 0;
  while (index < value.length && value[index] !== ';') index += 1;
  const main = value.slice(0, index).trim().toLowerCase();
  if (!main) throw invalid(`${label} 无效`);
  const parameters = new Map();
  while (index < value.length) {
    index += 1;
    while (index < value.length && /[ \t]/.test(value[index])) index += 1;
    const nameStart = index;
    while (index < value.length && HEADER_NAME.test(value[index])) index += 1;
    const name = value.slice(nameStart, index).toLowerCase();
    if (!name || parameters.has(name)) throw invalid(`${label} 参数重复或无效`);
    while (index < value.length && /[ \t]/.test(value[index])) index += 1;
    if (value[index] !== '=') throw invalid(`${label} 参数缺少等号`);
    index += 1;
    while (index < value.length && /[ \t]/.test(value[index])) index += 1;
    let parameter = '';
    if (value[index] === '"') {
      index += 1;
      let closed = false;
      while (index < value.length) {
        const character = value[index];
        index += 1;
        if (character === '"') {
          closed = true;
          break;
        }
        if (character === '\\') {
          if (index >= value.length) throw invalid(`${label} 引号转义无效`);
          parameter += value[index];
          index += 1;
        } else {
          if (character === '\r' || character === '\n') throw invalid(`${label} 参数换行无效`);
          parameter += character;
        }
      }
      if (!closed) throw invalid(`${label} 引号未闭合`);
      while (index < value.length && /[ \t]/.test(value[index])) index += 1;
      if (index < value.length && value[index] !== ';') {
        throw invalid(`${label} 引号参数后含多余字符`);
      }
    } else {
      const valueStart = index;
      while (index < value.length && value[index] !== ';') index += 1;
      parameter = value.slice(valueStart, index).trim();
    }
    parameters.set(name, parameter);
  }
  return { main, parameters };
}

function multipartBoundary(headers) {
  const raw = headers?.['content-type'];
  if (typeof raw !== 'string') throw invalid('multipart Content-Type 无效');
  const parsed = parseParameterizedValue(raw, 'multipart Content-Type');
  if (parsed.main !== 'multipart/form-data'
    || !parsed.parameters.has('boundary')
    || parsed.parameters.size !== 1) {
    throw invalid('multipart Content-Type 必须唯一提供 boundary');
  }
  const boundary = parsed.parameters.get('boundary');
  if (boundary.length === 0 || boundary.length > MAX_BOUNDARY_BYTES
    || /[^\x20-\x7e]/.test(boundary) || /[ \t]$/.test(boundary)) {
    throw invalid('multipart boundary 无效');
  }
  return boundary;
}

function parseRawHeaders(bytes) {
  if (bytes.length === 0 || bytes.length > MAX_PART_HEADER_BYTES) {
    throw invalid('multipart part header block 大小无效');
  }
  const lines = bytes.toString('latin1').split('\r\n');
  if (lines.length > MAX_PART_HEADER_PAIRS) {
    throw invalid('multipart part header 数量超限');
  }
  const headers = new Map();
  for (const line of lines) {
    if (/^[ \t]/.test(line)) throw invalid('multipart part header 不接受折行');
    const separator = line.indexOf(':');
    if (separator <= 0) throw invalid('multipart part header 格式无效');
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^[ \t]*/, '').replace(/[ \t]*$/, '');
    if (!HEADER_NAME.test(name) || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
      throw invalid('multipart part header 格式无效');
    }
    const normalized = name.toLowerCase();
    const values = headers.get(normalized) ?? [];
    values.push(value);
    headers.set(normalized, values);
  }
  return headers;
}

function validateRawPartHeaders(bytes) {
  const headers = parseRawHeaders(bytes);
  const dispositions = headers.get('content-disposition') ?? [];
  const contentTypes = headers.get('content-type') ?? [];
  if (dispositions.length !== 1 || contentTypes.length > 1) {
    throw invalid('multipart part 必须有唯一 Content-Disposition 和至多一个 Content-Type');
  }
  const disposition = parseParameterizedValue(dispositions[0], 'Content-Disposition');
  if (disposition.main !== 'form-data'
    || !disposition.parameters.has('name')
    || disposition.parameters.get('name').length === 0) {
    throw invalid('multipart part 必须是带 name 的 form-data');
  }
  const filenameKeys = ['filename', 'filename*']
    .filter(key => disposition.parameters.has(key));
  if (filenameKeys.length !== 1
    || disposition.parameters.get(filenameKeys[0]).length === 0) {
    throw invalid('multipart file part 必须提供唯一非空 filename');
  }
  let mimeType = null;
  if (contentTypes.length === 1) {
    const contentType = parseParameterizedValue(contentTypes[0], 'Content-Type');
    if (!MIME.test(contentType.main)) throw invalid('multipart part Content-Type 无效');
    mimeType = contentType.main;
  }
  return {
    contentDisposition:dispositions[0],
    contentType:contentTypes[0] ?? null,
    declaredFieldName:disposition.parameters.get('name'),
    declaredMimeType:mimeType,
  };
}

function parseMetadataWithBusboy(raw) {
  return new Promise((resolve, reject) => {
    const boundary = 'deck-header-metadata-boundary';
    let metadata = null;
    let failed = false;
    const fail = error => {
      if (failed) return;
      failed = true;
      reject(normalizeParserError(error));
    };
    let parser;
    try {
      parser = Busboy({
        headers:{ 'content-type':`multipart/form-data; boundary=${boundary}` },
        defParamCharset:'utf8',
        preservePath:true,
      });
    } catch (error) {
      fail(error);
      return;
    }
    parser.on('file', (fieldName, stream, info) => {
      if (metadata !== null) fail(invalid('multipart header metadata 不唯一'));
      metadata = {
        fieldName,
        filename:info.filename,
        mimeType:info.mimeType,
      };
      stream.resume();
    });
    parser.on('field', () => fail(invalid('multipart file part 缺少 filename')));
    parser.once('error', fail);
    parser.once('close', () => {
      if (failed) return;
      if (metadata === null) fail(invalid('Busboy 无法解析 multipart header metadata'));
      else resolve(metadata);
    });
    const lines = [
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: ${raw.contentDisposition}\r\n`, 'latin1'),
    ];
    if (raw.contentType !== null) {
      lines.push(Buffer.from(`Content-Type: ${raw.contentType}\r\n`, 'latin1'));
    }
    lines.push(Buffer.from(`\r\n\r\n--${boundary}--\r\n`));
    parser.end(Buffer.concat(lines));
  });
}

async function parsePartMetadata(bytes) {
  const raw = validateRawPartHeaders(bytes);
  const metadata = await parseMetadataWithBusboy(raw);
  if (metadata.fieldName !== raw.declaredFieldName
    || (raw.declaredMimeType !== null && metadata.mimeType !== raw.declaredMimeType)) {
    throw invalid('Busboy header metadata 与原始 header 不一致');
  }
  return metadata;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isSafeText(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !/[\p{Cc}\p{Cs}\p{Bidi_Control}\u200B\uFEFF]/u.test(value);
}

function cloneJsonValue(value, depth = 0) {
  if (depth > 16) throw invalid('task candidates 嵌套过深');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid('task candidates 含非有限数');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw invalid('task candidates 数组过长');
    return value.map(item => cloneJsonValue(item, depth + 1));
  }
  if (!isPlainObject(value)) throw invalid('task candidates 必须是 JSON 值');
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw invalid('task candidates 含危险字段');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw invalid('task candidates 字段无效');
    }
    Object.defineProperty(result, key, {
      value:cloneJsonValue(descriptor.value, depth + 1),
      enumerable:true, configurable:true, writable:true,
    });
  }
  return result;
}

function sanitizeTask(value) {
  if (!isPlainObject(value)) throw invalid('task part 必须是 JSON 普通对象');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !TASK_KEYS.has(key))
    || TASK_REQUIRED_KEYS.some(key => !Object.hasOwn(value, key))) {
    throw invalid('task part 字段无效');
  }
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) {
    throw invalid('expectedRevision 必须为非负安全整数');
  }
  if (!isSafeText(value.pageKey, 512)
    || !Number.isSafeInteger(value.pageIndex) || value.pageIndex <= 0
    || !isSafeText(value.pageLabel, 512)
    || typeof value.instruction !== 'string'
    || value.instruction.trim().length === 0) {
    throw invalid('task 缺少有效区域字段');
  }
  if (!isPlainObject(value.rect)
    || Reflect.ownKeys(value.rect).length !== RECT_KEYS.length
    || RECT_KEYS.some(key => !Object.hasOwn(value.rect, key))) {
    throw invalid('task rect 字段无效');
  }
  if (!Array.isArray(value.attachmentSources)
    || value.attachmentSources.some(source => source !== 'selected' && source !== 'pasted')) {
    throw invalid('attachmentSources 只能按顺序包含 selected 或 pasted');
  }
  if (value.attachmentSources.length > MAX_ATTACHMENTS) {
    throw multipartError(
      'TOO_MANY_ATTACHMENTS', 413, `每个任务最多 ${MAX_ATTACHMENTS} 个附件`,
    );
  }
  if (value.candidates !== undefined
    && (!Array.isArray(value.candidates) || value.candidates.length > 12)) {
    throw invalid('task candidates 必须是至多 12 项的数组');
  }

  const input = {
    expectedRevision:value.expectedRevision,
    pageKey:value.pageKey,
    pageIndex:value.pageIndex,
    pageLabel:value.pageLabel,
    rect:Object.fromEntries(RECT_KEYS.map(key => [key, value.rect[key]])),
    instruction:value.instruction.trim(),
  };
  if (value.candidates !== undefined) input.candidates = cloneJsonValue(value.candidates);
  if (value.pageState !== undefined) input.pageState = cloneJsonValue(value.pageState);
  try { validateTask(input); }
  catch (cause) { throw invalid(cause.message || 'task 区域字段无效', { cause }); }
  return {
    input,
    attachmentSources:[...value.attachmentSources],
  };
}

function parseTaskBytes(bytes) {
  let source;
  try { source = UTF8.decode(bytes); }
  catch (cause) { throw invalid('task part 不是有效 UTF-8', { cause }); }
  let value;
  try { value = JSON.parse(source); }
  catch (cause) { throw invalid('task part 不是有效 JSON', { cause }); }
  return sanitizeTask(value);
}

function fileNameIsValid(filename) {
  return typeof filename === 'string' && filename.length > 0 && filename.length <= 1024
    && !/[\\/\0\r\n]/.test(filename)
    && filename !== '.' && filename !== '..';
}

function writeStreamChunk(stream, bytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => stream.removeListener('error', onError);
    const finish = error => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = error => finish(error);
    stream.once('error', onError);
    stream.write(bytes, finish);
  });
}

function endStream(stream) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => stream.removeListener('error', onError);
    const finish = error => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = error => finish(error);
    stream.once('error', onError);
    stream.end(finish);
  });
}

function createMultipartFramer(boundary, upload, { debugCounters } = {}) {
  const initialBoundary = Buffer.from(`--${boundary}`);
  const bodyBoundary = Buffer.from(`\r\n--${boundary}`);
  const headerEnd = Buffer.from('\r\n\r\n');
  let mode = 'initial';
  let initialProbe = Buffer.alloc(0);
  let searchTail = Buffer.alloc(0);
  let candidate = null;
  let header = Buffer.alloc(0);
  let currentPart = null;
  let partCount = 0;
  let attachmentCount = 0;
  let taskSeen = false;
  let snapshotSeen = false;
  let preambleBytes = 0;
  let epilogueBytes = 0;
  let parsedTask = null;
  let snapshot = null;
  let aborted = false;
  let abortReason = null;
  let completed = false;
  let failureHandler = null;
  let pendingAsyncFailure = null;
  const staged = [];
  const stagePromises = [];
  if (debugCounters) debugCounters.candidateSteps = 0;

  const ensureActive = () => {
    if (aborted) throw abortReason ?? invalid('multipart framing 已取消');
    if (completed) throw invalid('multipart framing 已结束');
  };

  const writeBody = async bytes => {
    if (bytes.length === 0) return;
    if (!currentPart) throw invalid('multipart 正文缺少对应 part header');
    currentPart.size += bytes.length;
    if (currentPart.kind === 'task' && currentPart.size > MAX_TASK_METADATA_BYTES) {
      throw invalid('task 元数据超过 64 KiB');
    }
    if (currentPart.kind === 'snapshot' && currentPart.size > MAX_SNAPSHOT_BYTES) {
      throw multipartError('SNAPSHOT_TOO_LARGE', 413, 'snapshot 超过 512 KiB');
    }
    if (currentPart.kind === 'attachment' && currentPart.size > MAX_ATTACHMENT_BYTES) {
      throw multipartError('ATTACHMENT_TOO_LARGE', 413, '单个附件不得超过 25 MiB');
    }
    if (currentPart.kind === 'attachment') {
      const part = currentPart;
      try {
        await writeStreamChunk(part.stream, bytes);
      } catch (cause) {
        // destroy(error) 可能先让 write callback 得到通用 ERR_STREAM_DESTROYED，
        // 随后一拍才结算 stage；保留 writer 的稳定业务错误为首错。
        await new Promise(resolve => setImmediate(resolve));
        throw part.stageError ?? part.streamError ?? cause;
      }
    } else {
      currentPart.chunks.push(Buffer.from(bytes));
    }
  };

  const finishPart = async () => {
    if (!currentPart) throw invalid('multipart delimiter 前缺少 part');
    const part = currentPart;
    if (part.kind === 'task') {
      parsedTask = parseTaskBytes(Buffer.concat(part.chunks, part.size));
    } else if (part.kind === 'snapshot') {
      snapshot = Buffer.concat(part.chunks, part.size);
    } else {
      await endStream(part.stream);
      try {
        staged.push(await part.stagePromise);
        await part.closePromise;
      }
      finally { part.stream.removeListener('error', part.rememberStreamError); }
    }
    currentPart = null;
  };

  const startPart = async bytes => {
    const metadata = await parsePartMetadata(bytes);
    partCount += 1;
    if (!fileNameIsValid(metadata.filename)) {
      throw invalid('multipart file part 必须提供非目录 filename');
    }
    if (!['task', 'snapshot', 'attachment'].includes(metadata.fieldName)) {
      throw invalid(`不支持的 multipart part：${metadata.fieldName}`);
    }
    if (partCount === 1 && metadata.fieldName !== 'task') {
      throw invalid('task 必须是物理首个 multipart part');
    }
    if (metadata.fieldName === 'task') {
      if (partCount !== 1 || taskSeen || metadata.mimeType !== 'application/json') {
        throw invalid('task 必须是首个且唯一的 application/json file part');
      }
      taskSeen = true;
      currentPart = { kind:'task', chunks:[], size:0 };
      return;
    }
    if (!taskSeen || parsedTask === null) {
      throw invalid('所有文件 part 之前必须先完成 task');
    }
    if (metadata.fieldName === 'snapshot') {
      if (snapshotSeen || metadata.mimeType !== 'image/png') {
        throw invalid('snapshot 必须是唯一的 image/png file part');
      }
      snapshotSeen = true;
      currentPart = { kind:'snapshot', chunks:[], size:0 };
      return;
    }
    if (attachmentCount >= MAX_ATTACHMENTS) {
      throw multipartError(
        'TOO_MANY_ATTACHMENTS', 413, `每个任务最多 ${MAX_ATTACHMENTS} 个附件`,
      );
    }
    if (partCount > MAX_ATTACHMENTS + 2) {
      throw invalid('multipart part 数量超限');
    }
    const source = parsedTask.attachmentSources[attachmentCount];
    if (source !== 'selected' && source !== 'pasted') {
      throw invalid('attachmentSources 与附件 part 顺序不一致');
    }
    attachmentCount += 1;
    const stream = new PassThrough({ highWaterMark:64 * 1024 });
    const part = {
      kind:'attachment', stream, stagePromise:null, stageError:null, streamError:null, size:0,
      rememberStreamError:null, closePromise:null,
    };
    part.rememberStreamError = error => {
      part.streamError ??= error;
    };
    stream.once('error', part.rememberStreamError);
    part.closePromise = new Promise(resolve => stream.once('close', resolve));
    const stagePromise = Promise.resolve().then(() => upload.stage({
      stream,
      name:metadata.filename,
      mime:metadata.mimeType || 'application/octet-stream',
      source,
    }));
    part.stagePromise = stagePromise;
    stagePromise.catch(error => {
      part.stageError ??= error;
      if (!stream.destroyed) stream.destroy(error);
      pendingAsyncFailure ??= error;
      failureHandler?.(error);
    });
    stagePromises.push(stagePromise);
    currentPart = part;
  };

  const emitSearchBytes = async (origin, bytes) => {
    if (bytes.length === 0) return;
    if (origin === 'body') {
      await writeBody(bytes);
      return;
    }
    if (origin !== 'preamble') throw invalid('multipart ignored bytes 状态无效');
    preambleBytes += bytes.length;
    if (preambleBytes > MAX_PREAMBLE_BYTES) {
      throw multipartTooLarge(`multipart preamble 不得超过 ${MAX_PREAMBLE_BYTES} 字节`);
    }
  };

  const startCandidate = (origin, prefix, leadingIgnoredBytes = 0) => {
    candidate = {
      origin,
      prefix,
      suffix:[],
      leadingIgnoredBytes,
      phase:'start',
      closing:false,
      paddingCount:0,
    };
    mode = 'candidate';
  };

  const advanceCandidate = byte => {
    candidate.suffix.push(byte);
    if (debugCounters) debugCounters.candidateSteps += 1;
    if (candidate.phase === 'start') {
      if (byte === 0x2d) {
        candidate.phase = 'closing-dash';
        return 'incomplete';
      }
      if (byte === 0x20 || byte === 0x09) {
        candidate.phase = 'padding';
        candidate.paddingCount = 1;
        return 'incomplete';
      }
      if (byte === 0x0d) {
        candidate.phase = 'line-feed';
        return 'incomplete';
      }
      return 'invalid';
    }
    if (candidate.phase === 'closing-dash') {
      if (byte !== 0x2d) return 'invalid';
      candidate.closing = true;
      candidate.phase = 'after-closing';
      return 'incomplete';
    }
    if (candidate.phase === 'after-closing') {
      if (byte === 0x20 || byte === 0x09) {
        candidate.phase = 'padding';
        candidate.paddingCount = 1;
        return 'incomplete';
      }
      if (byte === 0x0d) {
        candidate.phase = 'line-feed';
        return 'incomplete';
      }
      return 'invalid';
    }
    if (candidate.phase === 'padding') {
      if (byte === 0x20 || byte === 0x09) {
        candidate.paddingCount += 1;
        return candidate.paddingCount > MAX_TRANSPORT_PADDING_BYTES
          ? 'invalid' : 'incomplete';
      }
      if (byte === 0x0d) {
        candidate.phase = 'line-feed';
        return 'incomplete';
      }
      return 'invalid';
    }
    if (candidate.phase === 'line-feed') {
      if (byte !== 0x0a) return 'invalid';
      return candidate.closing ? 'closing' : 'regular';
    }
    throw invalid('multipart candidate 状态无效');
  };

  const candidateStatusAtEof = () => (
    candidate.closing
      && (candidate.phase === 'after-closing' || candidate.phase === 'padding')
      ? 'closing'
      : 'invalid'
  );

  const searchChunk = async (chunk, offset, origin) => {
    const available = chunk.length - offset;
    if (searchTail.length) {
      const take = Math.min(available, bodyBoundary.length - 1);
      const bridge = Buffer.concat([
        searchTail,
        chunk.subarray(offset, offset + take),
      ]);
      const match = bridge.indexOf(bodyBoundary);
      if (match >= 0 && match < searchTail.length) {
        await emitSearchBytes(origin, searchTail.subarray(0, match));
        const consumed = match + bodyBoundary.length - searchTail.length;
        searchTail = Buffer.alloc(0);
        startCandidate(origin, bodyBoundary, origin === 'preamble' ? 2 : 0);
        return offset + consumed;
      }
      if (available < bodyBoundary.length - 1) {
        const safeLength = Math.max(0, bridge.length - (bodyBoundary.length - 1));
        await emitSearchBytes(origin, bridge.subarray(0, safeLength));
        searchTail = Buffer.from(bridge.subarray(safeLength));
        return chunk.length;
      }
      await emitSearchBytes(origin, searchTail);
      searchTail = Buffer.alloc(0);
    }
    const match = chunk.indexOf(bodyBoundary, offset);
    if (match >= 0) {
      await emitSearchBytes(origin, chunk.subarray(offset, match));
      startCandidate(origin, bodyBoundary, origin === 'preamble' ? 2 : 0);
      return match + bodyBoundary.length;
    }
    const keep = Math.min(bodyBoundary.length - 1, chunk.length - offset);
    const safeEnd = chunk.length - keep;
    await emitSearchBytes(origin, chunk.subarray(offset, safeEnd));
    searchTail = Buffer.from(chunk.subarray(safeEnd));
    return chunk.length;
  };

  const resolveCandidate = async status => {
    const resolved = candidate;
    candidate = null;
    searchTail = Buffer.alloc(0);
    if (status === 'invalid') {
      mode = resolved.origin;
      await emitSearchBytes(
        resolved.origin,
        Buffer.concat([resolved.prefix, Buffer.from(resolved.suffix)]),
      );
      return;
    }
    if (resolved.leadingIgnoredBytes > 0) {
      await emitSearchBytes(
        'preamble', resolved.prefix.subarray(0, resolved.leadingIgnoredBytes),
      );
    }
    if (resolved.origin === 'body') await finishPart();
    if (status === 'regular') {
      header = Buffer.alloc(0);
      mode = 'headers';
    } else {
      mode = 'epilogue';
    }
  };

  const push = async input => {
    ensureActive();
    const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
    let offset = 0;
    while (offset < chunk.length) {
      ensureActive();
      if (mode === 'epilogue') {
        epilogueBytes += chunk.length - offset;
        if (epilogueBytes > MAX_EPILOGUE_BYTES) {
          throw multipartTooLarge(`multipart epilogue 不得超过 ${MAX_EPILOGUE_BYTES} 字节`);
        }
        return;
      }
      if (mode === 'initial') {
        const take = Math.min(initialBoundary.length - initialProbe.length, chunk.length - offset);
        initialProbe = Buffer.concat([initialProbe, chunk.subarray(offset, offset + take)]);
        offset += take;
        if (!initialProbe.equals(initialBoundary.subarray(0, initialProbe.length))) {
          const replay = initialProbe;
          initialProbe = Buffer.alloc(0);
          mode = 'preamble';
          await push(replay);
        } else if (initialProbe.length === initialBoundary.length) {
          initialProbe = Buffer.alloc(0);
          startCandidate('preamble', initialBoundary);
        }
        continue;
      }
      if (mode === 'preamble' || mode === 'body') {
        offset = await searchChunk(chunk, offset, mode);
        continue;
      }
      if (mode === 'candidate') {
        const status = advanceCandidate(chunk[offset]);
        offset += 1;
        if (status === 'invalid') await resolveCandidate('invalid');
        else if (status === 'regular' || status === 'closing') {
          await resolveCandidate(status);
        }
        continue;
      }
      if (mode === 'headers') {
        const capacity = MAX_PART_HEADER_BYTES + headerEnd.length - header.length;
        const take = Math.min(capacity, chunk.length - offset);
        const previousLength = header.length;
        const candidateHeader = Buffer.concat([
          header,
          chunk.subarray(offset, offset + take),
        ]);
        const end = candidateHeader.indexOf(headerEnd);
        if (end >= 0) {
          if (end > MAX_PART_HEADER_BYTES) {
            throw invalid('multipart part header block 超过 16 KiB');
          }
          const consumed = Math.max(0, end + headerEnd.length - previousLength);
          const bytes = candidateHeader.subarray(0, end);
          header = Buffer.alloc(0);
          await startPart(bytes);
          mode = 'body';
          searchTail = Buffer.alloc(0);
          offset += consumed;
          continue;
        }
        if (candidateHeader.length >= MAX_PART_HEADER_BYTES + headerEnd.length) {
          throw invalid('multipart part header block 超过 16 KiB');
        }
        header = candidateHeader;
        offset += take;
        continue;
      }
      throw invalid('multipart framing 状态无效');
    }
  };

  const finish = async () => {
    ensureActive();
    if (mode === 'candidate') {
      const status = candidateStatusAtEof();
      if (status === 'closing') await resolveCandidate('closing');
      else await resolveCandidate('invalid');
    }
    if (mode === 'body') {
      await writeBody(searchTail);
      searchTail = Buffer.alloc(0);
    }
    if (mode !== 'epilogue') {
      throw invalid('multipart 请求缺少完整 closing boundary');
    }
    if (!taskSeen || parsedTask === null) throw invalid('缺少 task part');
    if (parsedTask.attachmentSources.length !== attachmentCount) {
      throw invalid('attachmentSources 数量与 attachment part 不匹配');
    }
    completed = true;
    return Object.freeze({
      input:Object.freeze(parsedTask.input),
      snapshot,
      upload,
      staged:Object.freeze(staged.map(record => Object.freeze({ ...record }))),
    });
  };

  const abort = async reason => {
    if (aborted) {
      await Promise.allSettled(stagePromises);
      return;
    }
    aborted = true;
    abortReason = normalizeParserError(reason);
    const closingPart = currentPart?.kind === 'attachment' ? currentPart : null;
    if (closingPart && !closingPart.stream.destroyed) {
      closingPart.stream.destroy(abortReason);
    }
    await Promise.allSettled(stagePromises);
    if (closingPart) {
      await closingPart.closePromise;
      closingPart.stream.removeListener('error', closingPart.rememberStreamError);
    }
  };

  const setFailureHandler = handler => {
    failureHandler = typeof handler === 'function' ? handler : null;
    if (failureHandler && pendingAsyncFailure) failureHandler(pendingAsyncFailure);
  };

  return { push, finish, abort, setFailureHandler };
}

function normalizeParserError(error) {
  if (error?.code && Number.isInteger(error?.statusCode)) return error;
  return invalid(error?.message ? `multipart 解析失败：${error.message}` : 'multipart 解析失败', {
    cause:error,
  });
}

function prioritizeCleanupError(primaryError, cleanupError) {
  if (cleanupError?.committed === true) {
    if (cleanupError && typeof cleanupError === 'object' && cleanupError.cause === undefined) {
      try { cleanupError.cause = primaryError; } catch { /* 冻结错误对象仍原样优先传播 */ }
    }
    return cleanupError;
  }
  if (primaryError && typeof primaryError === 'object') {
    try { primaryError.cleanupError = cleanupError; } catch { /* 保留首个错误 */ }
  }
  return primaryError;
}


export async function parseTaskMultipart(request, {
  attachmentStore,
  debugCounters,
  idleTimeoutMs=DEFAULT_MULTIPART_IDLE_TIMEOUT_MS,
} = {}) {
  if (!request || typeof request.pipe !== 'function' || !request.headers) {
    throw new TypeError('multipart request 必须是带 headers 的 Node Readable');
  }
  if (!attachmentStore || typeof attachmentStore.beginUpload !== 'function') {
    throw new TypeError('parseTaskMultipart 缺少 AttachmentStore');
  }
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new TypeError('multipart idleTimeoutMs 必须是正安全整数');
  }
  if (debugCounters !== undefined
    && (debugCounters === null || typeof debugCounters !== 'object')) {
    throw new TypeError('multipart debugCounters 必须是对象');
  }

  const upload = attachmentStore.beginUpload();
  if (!upload || typeof upload.stage !== 'function' || typeof upload.discard !== 'function') {
    throw new TypeError('AttachmentStore.beginUpload() 接口无效');
  }
  let discardPromise = null;
  const discardOnce = () => {
    if (!discardPromise) {
      discardPromise = Promise.resolve().then(() => upload.discard());
      discardPromise.catch(() => {});
    }
    return discardPromise;
  };

  let drainCleanup = null;
  const drainRequestInBackground = () => {
    if (drainCleanup || request.readableEnded === true || request.closed === true) return;
    let cleaned = false;
    const absorbLateError = () => {};
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      request.removeListener('error', absorbLateError);
      request.removeListener('end', cleanup);
      request.removeListener('close', cleanup);
      drainCleanup = null;
    };
    drainCleanup = cleanup;
    request.on('error', absorbLateError);
    request.once('end', cleanup);
    request.once('close', cleanup);
    try { request.resume(); } catch { cleanup(); }
    if (request.readableEnded === true || request.closed === true) cleanup();
  };

  let framer;
  try {
    framer = createMultipartFramer(multipartBoundary(request.headers), upload, { debugCounters });
  } catch (cause) {
    const primary = normalizeParserError(cause);
    drainRequestInBackground();
    try { await discardOnce(); } catch (cleanupError) {
      throw prioritizeCleanupError(primary, cleanupError);
    }
    throw primary;
  }

  try {
    return await new Promise((resolve, reject) => {
      let processing = Promise.resolve();
      let firstError = null;
      let failing = false;
      let settled = false;
      let wireBytes = 0;
      let idleTimer = null;

      const clearIdleTimer = () => {
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = null;
      };
      const armIdleTimer = () => {
        clearIdleTimer();
        idleTimer = setTimeout(() => {
          fail(invalid(`multipart 请求空闲超时（${idleTimeoutMs}ms）`));
        }, idleTimeoutMs);
      };

      const removeBusinessListeners = () => {
        request.removeListener('data', onData);
        request.removeListener('end', onEnd);
        request.removeListener('aborted', onAborted);
        request.removeListener('error', onRequestError);
        request.removeListener('close', onClose);
      };

      const succeed = result => {
        if (settled || failing) return;
        settled = true;
        clearIdleTimer();
        framer.setFailureHandler(null);
        removeBusinessListeners();
        resolve(result);
      };

      const fail = error => {
        firstError ??= normalizeParserError(error);
        if (failing || settled) return;
        failing = true;
        clearIdleTimer();
        framer.setFailureHandler(null);
        removeBusinessListeners();
        drainRequestInBackground();
        const processingAtFailure = processing;
        const discardAtFailure = discardOnce();
        const abortAtFailure = framer.abort(firstError);
        void (async () => {
          await Promise.allSettled([processingAtFailure, abortAtFailure]);
          let cleanupError = null;
          try { await discardAtFailure; } catch (cause) { cleanupError = cause; }
          settled = true;
          reject(cleanupError
            ? prioritizeCleanupError(firstError, cleanupError)
            : firstError);
        })();
      };

      const onData = chunk => {
        if (failing || settled) return;
        clearIdleTimer();
        request.pause();
        const chunkBytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        if (chunkBytes > MAX_MULTIPART_WIRE_BYTES - wireBytes) {
          fail(multipartTooLarge(
            `multipart 请求总字节数不得超过 ${MAX_MULTIPART_WIRE_BYTES}`,
          ));
          return;
        }
        wireBytes += chunkBytes;
        processing = processing.then(() => framer.push(chunk));
        processing.then(
          () => {
            if (!failing && !settled) {
              armIdleTimer();
              request.resume();
            }
          },
          fail,
        );
      };
      const onEnd = () => {
        if (failing || settled) return;
        clearIdleTimer();
        processing = processing.then(() => framer.finish());
        processing.then(succeed, fail);
      };
      const onAborted = () => fail(invalid('multipart 请求在完成前中断'));
      const onRequestError = cause => fail(invalid('multipart 请求流失败', { cause }));
      const onClose = () => {
        if (request.readableEnded === true || request.complete === true) return;
        fail(invalid('multipart 请求在完成前关闭'));
      };

      framer.setFailureHandler(fail);
      request.on('data', onData);
      request.once('end', onEnd);
      request.once('aborted', onAborted);
      request.once('error', onRequestError);
      request.once('close', onClose);
      if (request.aborted === true || request.readableAborted === true
        || (request.destroyed === true && request.readableEnded !== true)) {
        fail(invalid('multipart 请求在解析前已经中断'));
      } else {
        armIdleTimer();
        request.resume();
      }
    });
  } catch (primaryError) {
    let cleanupError = null;
    try { await discardOnce(); } catch (error) { cleanupError = error; }
    throw cleanupError
      ? prioritizeCleanupError(primaryError, cleanupError)
      : primaryError;
  }
}
