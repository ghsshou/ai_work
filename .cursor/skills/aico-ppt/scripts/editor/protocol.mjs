import { MAX_ATTACHMENTS, validateAttachmentMetadata } from './attachment-protocol.mjs';

export const ACTION_KINDS = new Set(['setText', 'setStyle', 'translate', 'resize', 'hide', 'show']);
export const TASK_STATUSES = new Set(['pending', 'processing', 'needs-confirmation', 'completed', 'failed']);

export function stableHash(text) {
  let h = 2166136261;
  for (const char of text) {
    h ^= char.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function normalizeBlobAttributesInTag(tag) {
  let cursor = 0;
  let index = 1;
  let normalized = '';
  while (index < tag.length && !/[\s/>]/.test(tag[index])) index += 1;
  while (index < tag.length) {
    while (/\s/.test(tag[index] ?? '')) index += 1;
    if (!tag[index] || tag[index] === '>' || tag[index] === '/') break;
    const nameStart = index;
    while (index < tag.length && !/[\s=/>]/.test(tag[index])) index += 1;
    const name = tag.slice(nameStart, index).toLowerCase();
    while (/\s/.test(tag[index] ?? '')) index += 1;
    if (tag[index] !== '=') continue;
    index += 1;
    while (/\s/.test(tag[index] ?? '')) index += 1;
    const quote = tag[index];
    if (quote !== '"' && quote !== "'") {
      const valueStart = index;
      while (index < tag.length && !/[\s>]/.test(tag[index])) index += 1;
      if ((name === 'src' || name === 'href') && tag.slice(valueStart, index).startsWith('blob:')) {
        normalized += `${tag.slice(cursor, valueStart)}blob:`;
        cursor = index;
      }
      continue;
    }
    const valueStart = index + 1;
    const valueEnd = tag.indexOf(quote, valueStart);
    if (valueEnd < 0) break;
    if ((name === 'src' || name === 'href') && tag.slice(valueStart, valueEnd).startsWith('blob:')) {
      normalized += `${tag.slice(cursor, valueStart)}blob:`;
      cursor = valueEnd;
    }
    index = valueEnd + 1;
  }
  return normalized ? normalized + tag.slice(cursor) : tag;
}

function normalizeBlobResourceAttributes(html) {
  const source = String(html);
  let output = '';
  let cursor = 0;
  let rawTextTag = null;
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start < 0) return output + source.slice(cursor);
    output += source.slice(cursor, start);
    if (rawTextTag) {
      const close = source.toLowerCase().indexOf(`</${rawTextTag}`, start);
      if (close < 0) return output + source.slice(start);
      output += source.slice(start, close);
      cursor = close;
      rawTextTag = null;
      continue;
    }
    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4);
      const next = end < 0 ? source.length : end + 3;
      output += source.slice(start, next);
      cursor = next;
      continue;
    }
    let end = start + 1;
    let quote = '';
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end >= source.length) return output + source.slice(start);
    const tag = source.slice(start, end + 1);
    const match = tag.match(/^<\s*([A-Za-z][\w:-]*)/);
    output += match ? normalizeBlobAttributesInTag(tag) : tag;
    if (match && ['script', 'style'].includes(match[1].toLowerCase()) && !/\/\s*>$/.test(tag)) {
      rawTextTag = match[1].toLowerCase();
    }
    cursor = end + 1;
  }
  return output;
}

export function makePageKey(index, label, html) {
  const structure = normalizeBlobResourceAttributes(html);
  const digest = stableHash(`${index}\0${label}\0${structure}`);
  return `page-${String(index).padStart(3, '0')}-${digest}`;
}

export function normalizeRect(rect, canvas) {
  if (!Number.isFinite(canvas?.width) || !Number.isFinite(canvas?.height) || canvas.width <= 0 || canvas.height <= 0) {
    throw new RangeError('画布尺寸必须为正的有限数');
  }
  if (![rect?.left, rect?.top, rect?.width, rect?.height, canvas?.left, canvas?.top].every(Number.isFinite)) {
    throw new RangeError('屏幕框和画布偏移必须为有限数');
  }
  const sx = 1920 / canvas.width;
  const sy = 1080 / canvas.height;
  const x = Math.max(0, Math.min(1919, Math.round((rect.left - canvas.left) * sx)));
  const y = Math.max(0, Math.min(1079, Math.round((rect.top - canvas.top) * sy)));
  const w = Math.max(1, Math.min(1920 - x, Math.round(rect.width * sx)));
  const h = Math.max(1, Math.min(1080 - y, Math.round(rect.height * sy)));
  return { x, y, w, h };
}

const PAGE_STATE_ELEMENT_KEYS = new Set([
  'target', 'dataActive', 'dataShown', 'dataDemo',
  'ariaPressed', 'ariaExpanded', 'ariaSelected', 'ariaCurrent',
  'open', 'checked', 'dataMod', 'selectedIndex',
]);
const PAGE_STATE_BOOLEAN_KEYS = [
  'dataActive', 'dataShown', 'open', 'checked',
];
const PAGE_STATE_STRING_KEYS = [
  'dataDemo', 'dataMod', 'ariaPressed', 'ariaExpanded', 'ariaSelected', 'ariaCurrent',
];
const EDITOR_ID_RE = /^element-[0-9a-f]{32}$/;

function requirePlainObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(message);
  }
  return value;
}

function validatePageStateTarget(target, pageKey) {
  requirePlainObject(target, '页面状态 target 必须为普通对象');
  if (target.pageKey !== pageKey
    || typeof target.path !== 'string'
    || !/^(?:|0|[1-9]\d{0,3})(?:\/(?:0|[1-9]\d{0,3})){0,31}$/.test(target.path)
    || typeof target.tag !== 'string' || !/^[A-Za-z][A-Za-z0-9:-]{0,63}$/.test(target.tag)
    || typeof target.fingerprint !== 'string' || !/^[0-9a-f]{8}$/.test(target.fingerprint)
    || (target.editorId !== undefined && !EDITOR_ID_RE.test(target.editorId))) {
    throw new TypeError('页面状态 target 无效');
  }
  if (target.rect !== undefined) {
    requirePlainObject(target.rect, '页面状态 target.rect 必须为普通对象');
    if (!['x', 'y', 'w', 'h'].every(key => Number.isFinite(target.rect[key]))) {
      throw new TypeError('页面状态 target.rect 必须为有限数');
    }
  }
}

export function validatePageState(pageState, pageKey) {
  requirePlainObject(pageState, '页面状态必须为普通对象');
  if (pageState.schema !== 1
    || Object.keys(pageState).some(key => !['schema', 'layers', 'elements'].includes(key))) {
    throw new TypeError('页面状态 schema 无效');
  }
  if (!Array.isArray(pageState.layers) || pageState.layers.length > 64
    || !Array.isArray(pageState.elements) || pageState.elements.length > 256) {
    throw new RangeError('页面状态条目过多');
  }
  for (const layer of pageState.layers) {
    requirePlainObject(layer, '页面状态 layer 必须为普通对象');
    if (Object.keys(layer).some(key => !['group', 'key'].includes(key))
      || typeof layer.group !== 'string' || !layer.group || layer.group.length > 256
      || (layer.key !== null && (typeof layer.key !== 'string' || layer.key.length > 256))) {
      throw new TypeError('页面状态 layer 无效');
    }
  }
  for (const item of pageState.elements) {
    requirePlainObject(item, '页面状态元素必须为普通对象');
    if (Object.keys(item).some(key => !PAGE_STATE_ELEMENT_KEYS.has(key))) {
      throw new TypeError('页面状态元素包含未知字段');
    }
    validatePageStateTarget(item.target, pageKey);
    for (const key of PAGE_STATE_BOOLEAN_KEYS) {
      if (key in item && typeof item[key] !== 'boolean') {
        throw new TypeError(`页面状态 ${key} 必须为布尔值`);
      }
    }
    for (const key of PAGE_STATE_STRING_KEYS) {
      if (key in item && (typeof item[key] !== 'string' || item[key].length > 512)) {
        throw new TypeError(`页面状态 ${key} 必须为短字符串`);
      }
    }
    if ('selectedIndex' in item
      && (!Number.isSafeInteger(item.selectedIndex)
        || item.selectedIndex < -1 || item.selectedIndex > 10_000)) {
      throw new TypeError('页面状态 selectedIndex 无效');
    }
  }
  if (JSON.stringify(pageState).length > 64 * 1024) {
    throw new RangeError('页面状态超过 64KB');
  }
  return pageState;
}

export function validateTask(task, { persisted=false } = {}) {
  if (!task || typeof task !== 'object' || Array.isArray(task)
    || Object.getPrototypeOf(task) !== Object.prototype) {
    throw new TypeError('任务必须为普通对象');
  }
  if (!task.pageKey || !task.instruction?.trim()) {
    throw new TypeError('任务缺少页面或修改说明');
  }
  const { x, y, w, h } = task.rect ?? {};
  if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1920 || y + h > 1080) {
    throw new RangeError('区域必须位于 1920×1080 画布内');
  }
  if (!persisted && 'attachments' in task) {
    throw new TypeError('请求任务不得直接提供 attachments');
  }
  if (!persisted && 'targetMissing' in task) {
    throw new TypeError('请求任务不得声明 targetMissing');
  }
  if (persisted && 'targetMissing' in task && task.targetMissing !== true) {
    throw new TypeError('持久化 targetMissing 只能为 true');
  }
  if ('pageState' in task) validatePageState(task.pageState, task.pageKey);
  if (persisted && 'attachments' in task) {
    const descriptor = Object.getOwnPropertyDescriptor(task, 'attachments');
    if (!descriptor || !descriptor.enumerable || !descriptor.writable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('持久化 attachments 必须是自有、可枚举、可写的数据属性');
    }
    const storedAttachments = descriptor.value;
    if (!Array.isArray(storedAttachments)) throw new TypeError('持久化 attachments 必须是数组');
    if (storedAttachments.length > MAX_ATTACHMENTS) {
      throw new RangeError(`每个任务最多 ${MAX_ATTACHMENTS} 个附件`);
    }
    const ids = new Set();
    const paths = new Set();
    const attachments = storedAttachments.map(attachment => validateAttachmentMetadata(attachment, task.id));
    for (const attachment of attachments) {
      if (ids.has(attachment.id) || paths.has(attachment.relativePath)) {
        throw new TypeError('持久化 attachments 不得重复');
      }
      ids.add(attachment.id);
      paths.add(attachment.relativePath);
    }
    Object.defineProperty(task, 'attachments', { value:attachments });
  }
  return task;
}

export function validateAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new TypeError('动作必须为对象');
  }
  if (typeof action.id !== 'string' || action.id.length === 0) {
    throw new TypeError('动作缺少 id');
  }
  if (!ACTION_KINDS.has(action.kind)) {
    throw new TypeError(`不支持的动作: ${action.kind}`);
  }
  if (!action.target?.pageKey || !action.target?.path) {
    throw new TypeError('动作缺少目标定位器');
  }
  if (action.target.editorId !== undefined && !EDITOR_ID_RE.test(action.target.editorId)) {
    throw new TypeError('动作 target.editorId 格式无效');
  }
  if (action.target.textPath !== undefined) {
    const validTextPath = typeof action.target.textPath === 'string'
      && /^(0|[1-9]\d{0,3})(\/(0|[1-9]\d{0,3})){0,31}$/.test(action.target.textPath);
    if (action.kind !== 'setText' || !validTextPath) {
      throw new TypeError('textPath 只允许 setText 使用规范的文本节点路径');
    }
  }
  const payload = action.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.getPrototypeOf(payload) !== Object.prototype) {
    throw new TypeError('动作 payload 必须为对象');
  }
  if (action.kind === 'setText') {
    const sourceRange = payload.sourceRange;
    const validSourceRange = sourceRange === undefined || (
      action.target.textPath !== undefined
      && sourceRange && typeof sourceRange === 'object' && !Array.isArray(sourceRange)
      && Object.getPrototypeOf(sourceRange) === Object.prototype
      && Object.keys(sourceRange).length === 2
      && Object.keys(sourceRange).every(key => ['start', 'end'].includes(key))
      && Number.isSafeInteger(sourceRange.start) && Number.isSafeInteger(sourceRange.end)
      && sourceRange.start >= 0 && sourceRange.end > sourceRange.start
      && sourceRange.end <= 1_000_000
    );
    const allowedKeys = sourceRange === undefined ? ['text'] : ['text', 'sourceRange'];
    if (typeof payload.text !== 'string' || !validSourceRange
      || Object.keys(payload).length !== allowedKeys.length
      || Object.keys(payload).some(key => !allowedKeys.includes(key))) {
      throw new TypeError('setText.text 必须为字符串，sourceRange 必须为有效原字符范围');
    }
  }
  if (action.kind === 'translate'
    && (![payload.x, payload.y].every(Number.isFinite)
      || Object.keys(payload).some(key => !['x', 'y'].includes(key)))) {
    throw new TypeError('translate 只接受有限数 x/y');
  }
  if (action.kind === 'resize') {
    const keys = Object.keys(payload);
    const scaleOnly = keys.length === 1 && Number.isFinite(payload.scale) && payload.scale > 0;
    const sizeOnly = keys.length === 2
      && keys.every(key => ['width', 'height'].includes(key))
      && Number.isFinite(payload.width) && payload.width > 0
      && Number.isFinite(payload.height) && payload.height > 0;
    if (!scaleOnly && !sizeOnly) {
      throw new TypeError('resize 只接受正数 scale 或 width/height');
    }
  }
  if (action.kind === 'setStyle') {
    const allowed = new Set([
      'color', 'background-color', 'font-family', 'font-size', 'font-style', 'font-weight',
      'text-decoration-line', 'text-align', 'line-height',
      'list-style-type', 'list-style-position', 'display', 'opacity',
      'border-color', 'border-width', 'border-style', 'fill', 'stroke', 'stroke-width',
    ]);
    const rangeAllowed = new Set([
      'color', 'font-family', 'font-size', 'font-style', 'font-weight', 'text-decoration-line',
    ]);
    const textRange = payload.textRange;
    const validTextRange = textRange === undefined || (
      textRange && typeof textRange === 'object' && !Array.isArray(textRange)
      && Object.getPrototypeOf(textRange) === Object.prototype
      && Object.keys(textRange).length === 2
      && Object.keys(textRange).every(key => ['start', 'end'].includes(key))
      && Number.isSafeInteger(textRange.start) && Number.isSafeInteger(textRange.end)
      && textRange.start >= 0 && textRange.end > textRange.start
      && textRange.end <= 1_000_000
    );
    const allowedKeys = textRange === undefined
      ? ['property', 'value'] : ['property', 'value', 'textRange'];
    if (!allowed.has(payload.property) || typeof payload.value !== 'string'
      || !validTextRange || (textRange && !rangeAllowed.has(payload.property))
      || Object.keys(payload).length !== allowedKeys.length
      || Object.keys(payload).some(key => !allowedKeys.includes(key))) {
      throw new TypeError('setStyle 属性不在白名单内');
    }
  }
  if (action.kind === 'hide' && Object.keys(payload).length !== 0) {
    throw new TypeError('hide payload 必须为空对象');
  }
  if (action.kind === 'show'
    && (Object.keys(payload).some(key => key !== 'display')
      || (payload.display !== undefined && typeof payload.display !== 'string'))) {
    throw new TypeError('show.display 必须为字符串');
  }
  return action;
}

export function hasCanonicalValues(action) {
  if (!Object.hasOwn(action, 'before') || !Object.hasOwn(action, 'after')) return false;
  if (action.kind === 'setText' || action.kind === 'setStyle'
    || action.kind === 'hide' || action.kind === 'show') {
    if (typeof action.before !== 'string' || typeof action.after !== 'string') return false;
    if (action.kind === 'setText') return action.after === action.payload.text;
    if (action.kind === 'setStyle') return action.after === action.payload.value;
    if (action.kind === 'hide') return action.after === 'none';
    return action.after === (action.payload.display ?? '');
  }
  if (action.kind === 'translate') {
    const valid = value => (
      value && typeof value === 'object' && !Array.isArray(value)
      && Number.isFinite(value.x) && Number.isFinite(value.y)
      && Object.keys(value).every(key => ['x', 'y'].includes(key))
    );
    return valid(action.before) && valid(action.after)
      && action.after.x === action.payload.x && action.after.y === action.payload.y;
  }
  if (action.kind === 'resize') {
    const branch = value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === 'scale'
        && Number.isFinite(value.scale) && value.scale > 0) return 'scale';
      if (keys.length === 2 && keys.every(key => ['width', 'height'].includes(key))
        && Number.isFinite(value.width) && value.width > 0
        && Number.isFinite(value.height) && value.height > 0) return 'size';
      return null;
    };
    const payloadBranch = branch(action.payload);
    if (!payloadBranch || branch(action.before) !== payloadBranch
      || branch(action.after) !== payloadBranch) return false;
    return payloadBranch === 'scale'
      ? action.after.scale === action.payload.scale
      : action.after.width === action.payload.width && action.after.height === action.payload.height;
  }
  return false;
}
