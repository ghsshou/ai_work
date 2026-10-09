import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const PUBLIC = new URL('../public/', import.meta.url);
const APP_PUBLIC = new URL('../app-public/', import.meta.url);

test('启动页、Editor 与画布桥接共用同一份 PillNav 契约', async () => {
  const [appHtml, editorHtml, appCss, editorCss, module, styles, bridge, appServer, editorServer] = await Promise.all([
    readFile(new URL('index.html', APP_PUBLIC), 'utf8'),
    readFile(new URL('index.html', PUBLIC), 'utf8'),
    readFile(new URL('app.css', APP_PUBLIC), 'utf8'),
    readFile(new URL('editor.css', PUBLIC), 'utf8'),
    readFile(new URL('pill-nav.mjs', PUBLIC), 'utf8'),
    readFile(new URL('pill-nav.css', PUBLIC), 'utf8'),
    readFile(new URL('frame-bridge.mjs', PUBLIC), 'utf8'),
    readFile(new URL('../app-server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../server.mjs', import.meta.url), 'utf8'),
  ]);

  assert.match(appHtml, /\/app\/pill-nav\.css/);
  assert.match(editorHtml, /\/editor\/pill-nav\.css/);
  assert.match(appHtml, /data-pill-variant="primary"/);
  assert.match(editorHtml, /data-pill-kind="segment"/);
  assert.match(module, /export function installPillNav/);
  assert.match(module, /export function applyPill/);
  assert.match(module, /const radius = \(\(width \* width\) \/ 4 \+ height \* height\)/);
  assert.match(styles, /300ms/);
  assert.match(styles, /200ms/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(bridge, /installPillNav\(document\)/);
  assert.match(bridge, /applyPill\(control/);
  assert.match(appServer, /\/app\/pill-nav\.mjs/);
  assert.match(appServer, /\/app\/pill-nav\.css/);
  assert.match(editorServer, /\/editor\/pill-nav\.mjs/);
  assert.match(editorServer, /\/editor\/pill-nav\.css/);
  assert.doesNotMatch(appHtml, /pill-action-fill|pill-action-label-hover|topbar-label-hover/);
  assert.doesNotMatch(editorHtml, /mode-hover-circle|mode-label-hover|topbar-label-hover/);
  assert.doesNotMatch(appCss, /\.pill-action-fill|\.work-item-delete-fill/);
  assert.doesNotMatch(editorCss, /\.mode-hover-circle|\.topbar-label-hover/);
});

test('内容条目保持 surface item，不被强制改成 Pill', async () => {
  const [app, editor, tasks, switcher] = await Promise.all([
    readFile(new URL('app.mjs', APP_PUBLIC), 'utf8'),
    readFile(new URL('editor.mjs', PUBLIC), 'utf8'),
    readFile(new URL('task-drawer.mjs', PUBLIC), 'utf8'),
    readFile(new URL('workspace-switcher.mjs', PUBLIC), 'utf8'),
  ]);
  assert.doesNotMatch(app, /applyPill\(button,.*work-item/s);
  assert.doesNotMatch(editor, /applyPill\(button,.*page-item/s);
  assert.doesNotMatch(tasks, /applyPill\(locate/);
  assert.doesNotMatch(switcher, /applyPill\(button/);
});

test('页面与属性抽屉共用单一 PillNav 箭头契约', async () => {
  const [editorHtml, editorModule, styles] = await Promise.all([
    readFile(new URL('index.html', PUBLIC), 'utf8'),
    readFile(new URL('editor.mjs', PUBLIC), 'utf8'),
    readFile(new URL('pill-nav.css', PUBLIC), 'utf8'),
  ]);

  assert.equal(editorHtml.match(/data-pill-arrow(?:\s|>)/g)?.length, 3);
  assert.equal(editorHtml.match(/class="pill-nav-arrow-icon"/g)?.length, 3);
  assert.equal(editorHtml.match(/<svg[^>]*class="pill-nav-arrow-icon"/g)?.length, 3);
  assert.equal(editorHtml.match(/<polyline[^>]*points="6 4 10 8 6 12"/g)?.length, 3);
  assert.equal(editorHtml.match(/stroke-linecap="round"/g)?.length, 3);
  assert.equal(editorHtml.match(/stroke-linejoin="round"/g)?.length, 3);
  assert.doesNotMatch(editorHtml, /data-(?:page-panel-toggle|inspector-collapse|inspector-reopen)[\s\S]{0,300}[←→↑↓‹›]/);
  assert.match(editorModule, /dataset\.pillArrowDirection = collapsed \? 'right' : 'left'/);
  assert.match(editorModule, /collapseDirection = dock === 'top' \? 'up' : 'right'/);
  assert.match(editorModule, /reopenDirection = dock === 'top' \? 'down' : 'left'/);
  assert.match(styles, /\.pill-nav-control\[data-pill-arrow\]/);
  assert.match(styles, /data-pill-arrow-direction="left"/);
  assert.match(styles, /data-pill-arrow-direction="right"/);
  assert.match(styles, /data-pill-arrow-direction="up"/);
  assert.match(styles, /data-pill-arrow-direction="down"/);
  assert.match(styles, /data-pill-arrow[\s\S]{0,500}\.pill-nav-label-hover\s*\{\s*display:\s*none/);
});
