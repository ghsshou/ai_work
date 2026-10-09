import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDITOR_DIR = dirname(fileURLToPath(import.meta.url));
const FONT_SOURCE = resolve(EDITOR_DIR, '../../assets/training-deck.html');
const SOURCE_FAMILY = 'Noto Sans SC';
const UI_FAMILY = 'AICO-PPT UI';

let cachedAssets;

function scriptPayload(source, type) {
  const pattern = new RegExp(
    `<script\\s+type=["']${type.replaceAll('/', '\\/')}["'][^>]*>\\s*([\\s\\S]*?)\\s*<\\/script>`,
    'i',
  );
  const match = source.match(pattern);
  if (!match) throw new Error(`字体来源缺少 ${type} 脚本`);
  return match[1];
}

function uiFontFaces(template) {
  const faces = [...template.matchAll(/@font-face\s*\{[^}]+\}/g)]
    .map(match => match[0])
    .filter(face => new RegExp(
      `font-family:\\s*["']${SOURCE_FAMILY}["']`,
    ).test(face));
  if (faces.length === 0) throw new Error(`字体来源缺少 ${SOURCE_FAMILY}`);
  const ids = new Set();
  const css = faces.map(face => face
    .replace(
      new RegExp(`font-family:\\s*["']${SOURCE_FAMILY}["']`),
      `font-family:'${UI_FAMILY}'`,
    )
    .replace(/url\(["']?([a-f0-9-]+)["']?\)/i, (_match, id) => {
      ids.add(id);
      return `url("/editor/ui-font/${id}.woff2")`;
    }))
    .join('\n');
  return { css, ids };
}

/**
 * 从现有离线模板中复用开源中文字体，避免编辑器在 macOS 与 Windows
 * 分别回退到 PingFang SC / Microsoft YaHei 后产生字号和字面差异。
 */
export async function loadUiFontAssets() {
  if (cachedAssets) return cachedAssets;
  const source = await readFile(FONT_SOURCE, 'utf8');
  const manifest = JSON.parse(scriptPayload(source, '__bundler/manifest'));
  const template = JSON.parse(scriptPayload(source, '__bundler/template'));
  const { css, ids } = uiFontFaces(template);
  const assets = new Map([['/editor/ui-font.css', {
    type:'text/css; charset=utf-8', contents:Buffer.from(css),
  }]]);
  for (const id of ids) {
    const entry = manifest[id];
    if (entry?.mime !== 'font/woff2' || entry.compressed === true
      || typeof entry.data !== 'string') {
      throw new Error(`编辑器字体资源无效：${id}`);
    }
    assets.set(`/editor/ui-font/${id}.woff2`, {
      type:'font/woff2', contents:Buffer.from(entry.data, 'base64'),
    });
  }
  cachedAssets = assets;
  return cachedAssets;
}
