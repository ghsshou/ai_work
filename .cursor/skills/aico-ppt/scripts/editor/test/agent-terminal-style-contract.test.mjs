import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const PUBLIC = new URL('../public/', import.meta.url);
const APP_PUBLIC = new URL('../app-public/', import.meta.url);

test('新建与修改 Deck 终端使用同一组件类和同一份视觉样式', async () => {
  const [editorHtml, appHtml, editorCss, appCss, component] = await Promise.all([
    readFile(new URL('index.html', PUBLIC), 'utf8'),
    readFile(new URL('index.html', APP_PUBLIC), 'utf8'),
    readFile(new URL('editor.css', PUBLIC), 'utf8'),
    readFile(new URL('app.css', APP_PUBLIC), 'utf8'),
    readFile(new URL('agent-terminal-panel.mjs', PUBLIC), 'utf8'),
  ]);

  assert.match(editorHtml, /agent-terminal-panel\.css/);
  assert.match(appHtml, /agent-terminal-panel\.css/);
  assert.ok(
    editorHtml.indexOf('editor.css') < editorHtml.indexOf('agent-terminal-panel.css'),
    '修改页必须让共享终端样式覆盖页面级样式',
  );
  assert.ok(
    appHtml.indexOf('agent-terminal-panel.css') < appHtml.indexOf('app.css'),
    '新建页只允许在共享样式之后追加布局定位',
  );
  assert.match(editorHtml, /class="agent-terminal-panel"/);
  assert.match(appHtml, /class="agent-terminal-panel creation-agent-terminal-panel"/);
  assert.doesNotMatch(appCss, /\.agent-terminal-header\s*\{/);
  assert.doesNotMatch(appCss, /\.agent-terminal-host\s*\{/);
  assert.match(editorCss, /\.agent-terminal-panel\s*\{/);
  assert.match(component, /fontSize:12/);
  assert.match(component, /lineHeight:1\.25/);
});
