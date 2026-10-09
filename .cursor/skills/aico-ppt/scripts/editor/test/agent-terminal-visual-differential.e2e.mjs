import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadChromium } from '../../verify/load-playwright.mjs';
import { startAppServer } from '../app-server.mjs';
import { startFixtureServer } from './test-helpers.mjs';

const VISUAL_OUTPUT = [
  'codex READY',
  '\u001b[33m★\u001b[0m 终端视觉基准',
  '普通终端文字',
  '❯ ',
].join('\r\n');

class CreationTerminalFixture {
  constructor(options) {
    this.options = options;
    this.state = 'stopped';
    this.runtimeId = 'creation-visual-terminal';
  }

  snapshot() {
    return {
      runtimeId:this.runtimeId,
      provider:this.options.provider,
      projectRoot:this.options.projectRoot,
      state:this.state,
    };
  }

  async start() { this.state = 'running'; }
  input() {}
  resize() {}
  async restart() { this.state = 'running'; }
  async close() { this.state = 'closed'; }

  attach(socket) {
    socket.send(JSON.stringify({ type:'snapshot', terminal:this.snapshot(), output:VISUAL_OUTPUT }));
    return () => {};
  }
}

class EditorPtyFixture {
  constructor(options, pid) {
    this.options = options;
    this.pid = pid;
    this.events = new EventEmitter();
  }

  onData(listener) { this.events.on('data', listener); return { dispose() {} }; }
  onExit(listener) { this.events.on('exit', listener); return { dispose() {} }; }
  write() {}
  resize() {}
  kill() {}
}

async function terminalVisualSignature(page, rootSelector) {
  await page.locator(`${rootSelector} [data-agent-terminal-host]`).click();
  await page.waitForFunction(selector => {
    const host = document.querySelector(`${selector} [data-agent-terminal-host]`);
    return host?.textContent.includes('普通终端文字')
      && host.querySelector('.xterm-char-measure-element');
  }, rootSelector);
  await page.waitForTimeout(250);
  return page.evaluate(selector => {
    const root = document.querySelector(selector);
    const header = root.querySelector('.agent-terminal-header');
    const host = root.querySelector('[data-agent-terminal-host]');
    const xterm = host.querySelector('.xterm');
    const measure = host.querySelector('.xterm-char-measure-element');
    const screen = host.querySelector('.xterm-screen');
    const plainRow = [...screen.querySelectorAll('.xterm-rows > div')]
      .find(row => row.textContent?.includes('普通终端文字'));
    const plainText = plainRow?.querySelector('span') ?? plainRow;
    const cursor = screen.querySelector('.xterm-cursor');
    const helper = host.querySelector('.xterm-helper-textarea');
    const pick = (node, names) => {
      const style = getComputedStyle(node);
      return Object.fromEntries(names.map(name => [name, style[name]]));
    };
    return {
      root:pick(root, ['backgroundColor', 'color', 'fontFamily', 'borderRadius']),
      header:pick(header, ['backgroundColor', 'color', 'fontFamily']),
      host:pick(host, ['backgroundColor', 'color']),
      xterm:{ className:xterm.className, ...pick(xterm, ['fontFamily', 'fontSize', 'lineHeight']) },
      measure:pick(measure, ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight']),
      plainText:pick(plainText, ['color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight']),
      cursor:cursor ? {
        className:cursor.className,
        ...pick(cursor, ['backgroundColor', 'color', 'outlineColor', 'visibility']),
      } : null,
      focused:document.activeElement === helper,
      stylesheets:[...document.styleSheets]
        .map(sheet => sheet.href ? new URL(sheet.href).pathname : '')
        .filter(path => path.endsWith('.css')),
      dynamicRules:[...document.styleSheets].flatMap(sheet => {
        try {
          return [...sheet.cssRules]
            .map(rule => rule.cssText)
            .filter(rule => rule.includes('xterm-dom-renderer-owner-1 .xterm-rows {')
              || rule.includes('.xterm-cursor.xterm-cursor-block {'));
        } catch { return []; }
      }),
    };
  }, rootSelector);
}

test('新建 Deck 与修改 Deck 的字体、颜色和光标完全一致', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-terminal-visual-diff-'));
  const creationApp = await startAppServer({
    token:'creation-terminal-visual-secret',
    pickAgentProjectDirectory:async () => projectRoot,
    createAgentTerminal:options => new CreationTerminalFixture(options),
  });

  let editorPty;
  let editorApp;
  let browser;
  t.after(async () => {
    await browser?.close();
    await editorApp?.close();
    await creationApp.close();
    await rm(projectRoot, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  });
  editorApp = await startFixtureServer({
    autoStartAgentTerminal:true,
    createAgentTerminalConversation:async () => ({
      conversationId:'codex-terminal-visual-diff',
      resume:true,
      initialPromptConsumed:true,
    }),
    spawnAgentTerminal:(executable, args, options) => {
      editorPty = new EditorPtyFixture(options, 7111);
      queueMicrotask(() => editorPty.events.emit('data', VISUAL_OUTPUT));
      return editorPty;
    },
  });

  const chromium = await loadChromium();
  browser = await chromium.launch({ channel:'chrome', headless:true });
  const context = await browser.newContext({ viewport:{ width:1440, height:900 } });
  const creationPage = await context.newPage();
  const editorPage = await context.newPage();
  const browserProblems = [];
  for (const page of [creationPage, editorPage]) {
    page.on('console', message => {
      if (['error', 'warning'].includes(message.type())
        && /Content Security Policy|Refused to apply inline style/i.test(message.text())) {
        browserProblems.push(message.text());
      }
    });
    page.on('pageerror', error => browserProblems.push(error.message));
  }

  await creationPage.goto(creationApp.appUrl);
  await creationPage.getByRole('button', { name:/从0开始创建一个新的deck/ }).click();
  await creationPage.getByRole('button', { name:/选择项目目录/ }).click();
  const confirmation = creationPage.locator('[data-confirm-creation-project]');
  if (await confirmation.isVisible()) await confirmation.check();
  await creationPage.getByRole('button', { name:/创建 Draft 并开始对话/ }).click();
  await creationPage.locator('[data-builder]').waitFor({ state:'visible' });

  await editorPage.goto(`${editorApp.url}/?token=${encodeURIComponent(editorApp.token)}`
    + `&editorToken=${encodeURIComponent(editorApp.editorToken)}`);
  await editorPage.waitForSelector('[data-page-key]');
  await editorPage.click('[data-agent-status]');
  await editorPage.locator('[data-agent-terminal-panel]').waitFor({ state:'visible' });

  const creation = await terminalVisualSignature(creationPage, '[data-agent-terminal]');
  const editor = await terminalVisualSignature(editorPage, '[data-agent-terminal-panel]');
  assert.deepEqual(
    { ...creation, stylesheets:undefined },
    { ...editor, stylesheets:undefined },
    JSON.stringify({ creation, editor }, null, 2),
  );
  assert.deepEqual(browserProblems, []);
});
