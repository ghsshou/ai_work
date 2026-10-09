const COLOR_PROPERTIES = new Set([
  'color', 'background', 'background-color', 'border-color',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'outline-color', 'text-decoration-color', 'fill', 'stroke',
]);

const LENGTH_PROPERTIES = new Set([
  'font-size', 'border-width', 'border-top-width', 'border-right-width',
  'border-bottom-width', 'border-left-width', 'outline-width', 'stroke-width',
  'letter-spacing', 'word-spacing',
]);

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseHexColor(value) {
  const match = value.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!match) return null;
  const hex = match[1].toLowerCase();
  const expanded = hex.length <= 4
    ? [...hex].map(char => `${char}${char}`).join('') : hex;
  const alpha = expanded.length === 8 ? parseInt(expanded.slice(6, 8), 16) : 255;
  return {
    r:parseInt(expanded.slice(0, 2), 16),
    g:parseInt(expanded.slice(2, 4), 16),
    b:parseInt(expanded.slice(4, 6), 16),
    a:alpha,
  };
}

function parseRgbColor(value) {
  const match = value.match(/^rgba?\(\s*([^)]*)\s*\)$/i);
  if (!match) return null;
  const parts = match[1].split(',').map(part => part.trim());
  if (![3, 4].includes(parts.length)) return null;
  const channels = parts.slice(0, 3).map(part => {
    if (part.endsWith('%')) return clampByte(Number.parseFloat(part) * 2.55);
    return clampByte(Number.parseFloat(part));
  });
  if (channels.some(channel => !Number.isFinite(channel))) return null;
  let alpha = 255;
  if (parts.length === 4) {
    const source = parts[3];
    const parsed = source.endsWith('%')
      ? Number.parseFloat(source) / 100 : Number.parseFloat(source);
    if (!Number.isFinite(parsed)) return null;
    alpha = clampByte(parsed * 255);
  }
  return { r:channels[0], g:channels[1], b:channels[2], a:alpha };
}

function canonicalColor(value) {
  const color = parseHexColor(value) ?? parseRgbColor(value);
  if (!color) return null;
  return `rgba(${color.r},${color.g},${color.b},${color.a})`;
}

function canonicalNumber(value) {
  if (!Number.isFinite(value)) return value;
  return Object.is(value, -0) ? 0 : value;
}

function canonicalString(value, property) {
  const trimmed = value.trim();
  const normalizedProperty = String(property ?? '').toLowerCase();
  if (COLOR_PROPERTIES.has(normalizedProperty)) {
    return canonicalColor(trimmed) ?? trimmed.toLowerCase();
  }
  if (LENGTH_PROPERTIES.has(normalizedProperty)) {
    const length = trimmed.match(/^(-?(?:\d+\.?\d*|\.\d+))(px)?$/i);
    if (length) return `${canonicalNumber(Number(length[1]))}px`;
  }
  return trimmed.replace(/\s+/g, ' ');
}

export function canonicalizeActionValue(value, { property=null } = {}) {
  if (typeof value === 'string') return canonicalString(value, property);
  if (typeof value === 'number') return canonicalNumber(value);
  if (Array.isArray(value)) {
    return value.map(item => canonicalizeActionValue(item, { property }));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [
    key,
    canonicalizeActionValue(value[key], { property:key }),
  ]));
}

export function sameCanonicalActionValue(action, left, right) {
  const property = action?.kind === 'setStyle' ? action.payload?.property : null;
  return JSON.stringify(canonicalizeActionValue(left, { property }))
    === JSON.stringify(canonicalizeActionValue(right, { property }));
}
