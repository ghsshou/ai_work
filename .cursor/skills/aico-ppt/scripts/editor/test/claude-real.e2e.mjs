import assert from 'node:assert/strict';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { AgentTerminalSession } from '../agent-terminal-session.mjs';
import { buildAgentPrompt } from '../agent-runner.mjs';

const enabled = process.platform === 'win32'
  && process.env.AICO_PPT_REAL_CLAUDE_E2E === '1';

function count(text, needle) {
  return String(text).split(needle).length - 1;
}

function terminalTail(text) {
  return String(text).replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, '')
    .replace(/\r/g, '').slice(-4_000);
}

async function waitFor(check, message, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(typeof message === 'function' ? message() : message);
}

async function filesBelow(root) {
  const files = [];
  const visit = async directory => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes:true }); }
    catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    }
  };
  await visit(root);
  return files;
}

function userPromptText(record) {
  if (record?.type !== 'user') return '';
  const content = record?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(item => item?.type === 'text' && typeof item.text === 'string')
    .map(item => item.text).join('\n');
}

async function tailText(path, maxBytes = 4 * 1024 * 1024) {
  const info = await stat(path);
  const length = Math.min(info.size, maxBytes);
  const buffer = Buffer.alloc(length);
  const handle = await open(path, 'r');
  try { await handle.read(buffer, 0, length, info.size - length); }
  finally { await handle.close(); }
  return { mtimeMs:info.mtimeMs, text:buffer.toString('utf8') };
}

async function storedClaudePrompt(marker, sinceMs) {
  const files = await filesBelow(join(homedir(), '.claude', 'projects'));
  const recent = [];
  for (const path of files) {
    const info = await stat(path);
    if (info.mtimeMs >= sinceMs - 5_000) recent.push({ path, mtimeMs:info.mtimeMs });
  }
  recent.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of recent.slice(0, 12)) {
    const { text } = await tailText(candidate.path);
    for (const line of text.split(/\r?\n/).reverse()) {
      if (!line.includes(marker)) continue;
      try {
        const prompt = userPromptText(JSON.parse(line));
        if (prompt.includes(marker)) return { path:candidate.path, prompt };
      } catch { /* tail 可能从一行 JSON 中部开始 */ }
    }
  }
  return null;
}

async function waitForStoredClaudePrompt(marker, sinceMs, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await storedClaudePrompt(marker, sinceMs);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Claude Code JSONL 中没有出现任务标记 ${marker}`);
}

test('Windows 真实 Claude Code 自动提交初始指令和完整长任务', {
  skip:!enabled,
  timeout:240_000,
}, async t => {
  const cwd = process.cwd();
  const projectRoot = await realpath(cwd);
  const initialMarker = `HD_INIT_OK_${Date.now()}`;
  const taskBeginMarker = `HD_TASK_BEGIN_${Date.now()}`;
  const taskEndMarker = `HD_TASK_END_${Date.now()}`;
  const startedAt = Date.now();
  const session = new AgentTerminalSession({
    projectRoot,
    cwd,
    provider:'claude-code',
    platform:'win32',
    environment:process.env,
    initialPrompt:() => [
      '这是相邻两批任务的竞态回归测试。',
      `请把 ${initialMarker} 作为回复第一行，`,
      '然后继续输出从 WAIT_001 到 WAIT_200 的 200 行编号，不要提前停止。',
    ].join('\n'),
  });
  t.after(() => session.close());

  await session.start();
  await session.waitUntilReady({ timeoutMs:30_000 });
  await waitFor(
    () => count(session.output, initialMarker) >= 2,
    () => `Claude Code 没有执行自动提交的初始指令：\n${terminalTail(session.output)}`,
    60_000,
  );

  const longContext = '只处理本批 ID；不要读取整份历史；保持 action envelope 完整。'.repeat(120);
  session.submitPrompt([
    taskBeginMarker,
    longContext,
    taskEndMarker,
    '请只逐字回复你实际收到的第一行和倒数第二行，每行一条，不要猜测缺失内容。',
  ].join('\n'));
  // 真实 Editor 会在自动展开右侧终端时从 xterm 回传新尺寸。
  // 刻意让 resize 落在 bracketed-paste 分块期间，覆盖 Windows App 真实时序。
  session.resize(132, 40);
  const resizeTimers = [
    setTimeout(() => session.resize(148, 44), 45),
    setTimeout(() => session.resize(164, 48), 90),
  ];
  t.after(() => resizeTimers.forEach(clearTimeout));
  await waitFor(
    () => count(session.output, taskBeginMarker) >= 2
      && count(session.output, taskEndMarker) >= 2,
    () => `Claude Code 没有同时收到长任务首尾，可能正文缺头、缺尾或 Enter 被吞掉：\n${terminalTail(session.output)}`,
    120_000,
  );
  const stored = await waitForStoredClaudePrompt(taskEndMarker, startedAt);
  assert.ok(
    stored.prompt.startsWith(`${taskBeginMarker}\n`),
    `Claude Code JSONL 中的真实 user message 丢失了前缀：\n${stored.prompt.slice(0, 500)}`,
  );
  assert.ok(stored.prompt.includes(`\n${taskEndMarker}\n`), '真实 user message 必须包含末尾标记');

  const conversationId = basename(stored.path, '.jsonl');
  await session.close();
  const resumedBeginMarker = `HD_RESUMED_BEGIN_${Date.now()}`;
  const resumedEndMarker = `HD_RESUMED_END_${Date.now()}`;
  const resumedStartedAt = Date.now();
  const resumed = new AgentTerminalSession({
    projectRoot,
    cwd,
    provider:'claude-code',
    platform:'win32',
    environment:process.env,
    initialPrompt:() => '',
    resolveConversation:async () => ({
      conversationId,
      resume:true,
      initialPromptConsumed:true,
    }),
  });
  t.after(() => resumed.close());
  await resumed.start();
  await resumed.waitUntilReady({ timeoutMs:30_000 });
  await new Promise(resolve => setTimeout(resolve, 3_000));
  const resumedPrompt = [
    resumedBeginMarker,
    buildAgentPrompt({
      deckPath:String.raw`Y:\aico-ppt\Deck-Projects\demo\.aico-ppt-editor\real-e2e\working\deck.html`,
      serviceUrl:'http://127.0.0.1:54117',
      token:'real-e2e-token',
      taskIds:['task-windows-resume-prefix'],
      sourceThreadId:null,
      loadSkill:false,
      environmentCredentials:true,
    }),
    resumedEndMarker,
    '这是输入完整性测试，不要执行上述任务；请只回复你实际收到的第一行和倒数第二行。',
  ].join('\n');
  resumed.submitPrompt(resumedPrompt);
  resumed.resize(132, 40);
  setTimeout(() => resumed.resize(164, 48), 45);
  const resumedStored = await waitForStoredClaudePrompt(
    resumedEndMarker,
    resumedStartedAt,
  );
  assert.ok(
    resumedStored.prompt.startsWith(`${resumedBeginMarker}\n`),
    `Claude Code resume 后的真实 user message 丢失了前缀：\n${resumedStored.prompt.slice(0, 500)}`,
  );
  assert.ok(
    resumedStored.prompt.includes(`\n${resumedEndMarker}\n`),
    'Claude Code resume 后的真实 user message 必须包含末尾标记',
  );
  assert.equal(resumed.snapshot().state, 'running');
  await resumed.close();
});
