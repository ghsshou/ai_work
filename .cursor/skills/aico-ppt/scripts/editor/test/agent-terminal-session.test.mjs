import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  AgentTerminalSession,
  agentTerminalProviders,
  buildAgentTerminalCommand,
  resolveAgentTerminalExecutable,
} from '../agent-terminal-session.mjs';
import { buildAgentPrompt } from '../agent-runner.mjs';

class FakePty {
  constructor(executable, args, options) {
    this.executable = executable;
    this.args = args;
    this.options = options;
    this.pid = 4321;
    this.events = new EventEmitter();
    this.writes = [];
    this.resizes = [];
    this.killed = false;
  }

  onData(listener) { this.events.on('data', listener); return { dispose() {} }; }
  onExit(listener) { this.events.on('exit', listener); return { dispose() {} }; }
  write(data) { this.writes.push(data); }
  resize(cols, rows) { this.resizes.push([cols, rows]); }
  kill() {
    this.killed = true;
    this.events.emit('exit', { exitCode:0, signal:null });
  }
}

class BoundedWritePty extends FakePty {
  constructor(executable, args, options, maxWriteBytes = 512) {
    super(executable, args, options);
    this.maxWriteBytes = maxWriteBytes;
    this.accepted = [];
  }

  write(data) {
    super.write(data);
    const encoded = Buffer.from(data, 'utf8');
    this.accepted.push(encoded.subarray(0, this.maxWriteBytes).toString('utf8'));
  }
}

class TailBoundedWritePty extends FakePty {
  constructor(executable, args, options, maxWriteBytes = 1_024) {
    super(executable, args, options);
    this.maxWriteBytes = maxWriteBytes;
    this.accepted = [];
  }

  write(data) {
    super.write(data);
    const encoded = Buffer.from(data, 'utf8');
    const accepted = encoded.length > this.maxWriteBytes
      ? encoded.subarray(encoded.length - this.maxWriteBytes)
      : encoded;
    this.accepted.push(accepted.toString('utf8'));
  }
}

function drainScheduledCallbacks(queue) {
  while (queue.length) queue.shift().callback();
}

function drainUntilEnter(queue, child) {
  const previous = child.writes.filter(value => value === '\r').length;
  while (queue.length && child.writes.filter(value => value === '\r').length === previous) {
    queue.shift().callback();
  }
  assert.equal(
    child.writes.filter(value => value === '\r').length,
    previous + 1,
    '提交链必须写入一次 Enter',
  );
}

async function waitForSessionState(session, predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = session.snapshot();
    if (predicate(snapshot)) return snapshot;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 5));
  }
  return session.snapshot();
}

const CLAUDE_READY_OUTPUT = '\u001b[5;1H────\r\n❯\u00a0\u001b[7m \u001b[27m';
const CODEX_DRAFT_OUTPUT = '\u001b[11;1H\u001b[1m›\u001b[11;3H\u001b[2mExplain this codebase'
  + '\u001b[?25h\u001b[11;3H\u001b[?2026l';
const CODEX_LOADING_WITH_STATUS_OUTPUT = '\u001b[3;1Hmodel: loading   /model to change'
  + '\u001b[23;1Hgpt-5.6-sol default · /tmp/aico-ppt'
  + CODEX_DRAFT_OUTPUT;
const CODEX_RESUMED_STALE_LOADING_OUTPUT = '\u001b[3;1Hmodel: loading   /model to change'
  + '\u001b[11;1H\u001b[1m›\u001b[11;3H\u001b[2mAsk Codex to do anything'
  + '\u001b[?25h\u001b[11;3H\u001b[?2026l';
const CODEX_UPDATE_NOTICE_OUTPUT = '✨ Update available! 0.148.0 -> 0.149.0\r\n'
  + 'Run npm install -g @openai/codex to update.\r\n'
  + 'See full release notes: https://github.com/openai/codex/releases/latest\r\n';
const CODEX_UPDATE_INTERACTION_OUTPUT = 'Update available! Release notes: '
  + 'https://github.com/openai/codex/releases/latest\r\n'
  + 'Skip until next version\r\nPress \u001b[1mEnter\u001b[0m to continue\u001b[?25h';
const CODEX_RESUME_DIRECTORY_INTERACTION_OUTPUT = '\u001b[1;1H\u001b[J'
  + '\u001b[2;1HChoose\u001b[2;8Hworking\u001b[2;16Hdirectory\u001b[2;26Hto'
  + '\u001b[2;29H\u001b[1mresume\u001b[2;36H\u001b[22mthis\u001b[2;41Hsession'
  + '\u001b[4;3HSession = latest cwd recorded in the resumed session'
  + '\u001b[5;3HCurrent = your current working directory'
  + '\u001b[7;1H› 1. Use session directory'
  + '\u001b[8;6H(/tmp/old-aico-ppt)'
  + '\u001b[9;3H2.\u001b[9;6HUse\u001b[9;10Hcurrent\u001b[9;18Hdirectory'
  + '\u001b[9;28H(/tmp/aico-ppt)'
  + '\u001b[10;3H3.\u001b[10;6HAlways\u001b[10;13Huse\u001b[10;17Hsession'
  + '\u001b[10;25Hdirectory'
  + '\u001b[11;3H4.\u001b[11;6HAlways\u001b[11;13Huse\u001b[11;17Hcurrent'
  + '\u001b[11;25Hdirectory'
  + '\u001b[13;3HPress enter to continue\u001b[?25l';
const CODEX_READY_OUTPUT = '\u001b[3;1Hmodel: gpt-5.6-sol xhigh   /model to change'
  + '\u001b[23;1Hgpt-5.6-sol xhigh · /tmp/aico-ppt'
  + CODEX_DRAFT_OUTPUT;
const OPENCODE_READY_OUTPUT = '\u001b[20;2HAsk anything: Ask a question, move files, explore your code...'
  + '\u001b[?25h';

test('生产 node-pty 可以真实创建子进程且不遗留测试句柄', () => {
  // ConPTY 的 native handle 必须隔离在短进程内；否则 Windows test worker 即使
  // 收到 onExit 也可能继续存活，掩盖真正的孤儿进程问题。
  const script = String.raw`
    const pty = require('node-pty');
    const windows = process.platform === 'win32';
    const file = windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/echo';
    const args = windows ? ['/d','/s','/c','echo pty-ready'] : ['pty-ready'];
    let output = '';
    let exitCode;
    const child = pty.spawn(file, args, {
      name:'xterm-256color', cols:80, rows:24, cwd:process.cwd(), env:process.env,
    });
    const timeout = setTimeout(() => {
      process.stderr.write(JSON.stringify({ exitCode, output }));
      process.exit(2);
    }, 3000);
    // 并发测试中退出通知可能先于最后一段输出；两项证据都到达再完成。
    function finish() {
      if (exitCode === undefined || !output.includes('pty-ready')) return;
      clearTimeout(timeout);
      process.stdout.write(output);
      process.exit(exitCode === 0 ? 0 : 1);
    }
    child.onData(data => { output += data; finish(); });
    child.onExit(event => { exitCode = event.exitCode; finish(); });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd:process.cwd(), encoding:'utf8', timeout:5_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /pty-ready/);
});

test('终端 provider 暴露 Codex、Claude Code 与 OpenCode，并使用固定参数', () => {
  assert.deepEqual(agentTerminalProviders(), [
    { id:'codex', label:'Codex' },
    { id:'claude-code', label:'Claude Code' },
    { id:'opencode', label:'OpenCode' },
  ]);
  assert.deepEqual(buildAgentTerminalCommand('codex', {
    initialPrompt:'准备 Deck', platform:'linux',
  }), {
    provider:'codex', label:'Codex', executable:'codex',
    args:['--dangerously-bypass-approvals-and-sandbox'],
  });
  assert.deepEqual(buildAgentTerminalCommand('claude-code', { platform:'linux' }), {
    provider:'claude-code', label:'Claude Code', executable:'claude',
    args:['--dangerously-skip-permissions'],
  });
  assert.deepEqual(buildAgentTerminalCommand('claude-code', { platform:'win32' }), {
    provider:'claude-code', label:'Claude Code', executable:'claude.cmd',
    args:['--dangerously-skip-permissions'],
  });
  assert.deepEqual(buildAgentTerminalCommand('codex', {
    platform:'linux',
    conversationId:'019fcac9-3fbe-7a81-817b-a00f88d2b7ed',
    resume:true,
    initialPrompt:'继续 Deck',
  }), {
    provider:'codex', label:'Codex', executable:'codex',
    args:[
      'resume', '--dangerously-bypass-approvals-and-sandbox',
      '019fcac9-3fbe-7a81-817b-a00f88d2b7ed',
    ],
  });
  assert.deepEqual(buildAgentTerminalCommand('claude-code', {
    platform:'linux',
    conversationId:'bad74b80-1b7d-415b-bd6f-645c7deed723',
    resume:true,
    initialPrompt:'继续 Deck',
  }), {
    provider:'claude-code', label:'Claude Code', executable:'claude',
    args:[
      '--dangerously-skip-permissions', '--resume',
      'bad74b80-1b7d-415b-bd6f-645c7deed723',
    ],
  });
  assert.deepEqual(buildAgentTerminalCommand('opencode', { platform:'linux' }), {
    provider:'opencode', label:'OpenCode', executable:'opencode', args:[],
  });
  assert.deepEqual(buildAgentTerminalCommand('opencode', {
    platform:'win32', conversationId:'ses_aico_ppt_1', resume:true,
  }), {
    provider:'opencode', label:'OpenCode', executable:'opencode.cmd',
    args:['--session', 'ses_aico_ppt_1'],
  });
  assert.throws(() => buildAgentTerminalCommand('openclaw'), /不支持的终端 Agent/);
});

test('三种 Agent 遇到目录信任提示时等待用户确认且不误投初始任务', async t => {
  const scenarios = [
    {
      name:'codex',
      provider:'codex',
      output:'Do you trust the contents of this directory?\r\n› 1. Yes, proceed\r\n  2. No, quit\u001b[?25h',
      readyOutput:'Codex ready',
    },
    {
      name:'codex-wsl-cursor-positioned',
      provider:'codex',
      output:'\u001b[3;3HDo\u001b[1Cyou\u001b[1Ctrust\u001b[1Cthe\u001b[1Ccontents'
        + '\u001b[1Cof\u001b[1Cthis\u001b[1Cdirectory?\r\n› 1. Yes, continue\r\n'
        + '2.\u001b[1CNo,\u001b[1Cquit\u001b[?25h',
      readyOutput:'Codex ready',
    },
    {
      name:'claude-code',
      provider:'claude-code',
      output:'Do you trust the files in this folder?\r\n  Yes, proceed\r\n  No, exit',
      readyOutput:CLAUDE_READY_OUTPUT,
    },
    {
      name:'opencode',
      provider:'opencode',
      output:'Do you trust this project directory?\r\n  Trust\r\n  Exit',
      readyOutput:'OpenCode ready',
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const children = [];
      const session = new AgentTerminalSession({
        projectRoot:'/tmp/aico-ppt',
        provider:scenario.provider,
        initialPrompt:() => '这条任务必须等目录信任确认后再提交',
        spawnPty:(executable, args, options) => {
          const child = new FakePty(executable, args, options);
          children.push(child);
          return child;
        },
      });
      await session.start();
      children[0].events.emit('data', scenario.output);
      assert.deepEqual(session.snapshot().interactionRequired, {
        kind:'directory-trust',
        message:'请在右侧终端确认是否信任当前项目目录',
      });
      assert.equal(session.snapshot().promptReady, false);
      assert.equal(session.snapshot().startupPromptState, 'pending');
      assert.deepEqual(children[0].writes, [], '信任提示不能被初始任务覆盖');
      session.input('\r');
      assert.deepEqual(children[0].writes, ['\r'], '等待确认时必须允许用户操作终端');
      children[0].events.emit('data', scenario.readyOutput);
      assert.equal(session.snapshot().interactionRequired, null);
      assert.equal(session.snapshot().promptReady, true);
      assert.equal(session.snapshot().startupPromptState, 'submitting');
      assert.deepEqual(children[0].writes, [
        '\r',
        '\u001b[200~这条任务必须等目录信任确认后再提交\u001b[201~',
      ]);
      await session.close();
    });
  }
});

test('Claude Code 启动输出不能误当成可输入提示符', async () => {
  const children = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    provider:'claude-code',
    initialPrompt:() => '必须等到 Claude 输入框再提交',
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  children[0].events.emit('data', '\u001b]0;Claude Code\u0007Claude Code v2.1.108');
  assert.equal(session.snapshot().promptReady, false);
  assert.equal(session.snapshot().startupPromptState, 'pending');
  assert.deepEqual(children[0].writes, []);
  children[0].events.emit('data', CLAUDE_READY_OUTPUT);
  assert.equal(session.snapshot().promptReady, true);
  assert.equal(session.snapshot().startupPromptState, 'submitting');
  await session.close();
});

test('Codex 0.148 初始化草稿框不算就绪，自动回车收到终端回执后才算提交', async () => {
  const children = [];
  const scheduledSubmits = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    provider:'codex',
    initialPrompt:() => '这是必须自动发出的初始化说明',
    scheduleSubmit:(callback, delayMs) => {
      const entry = { callback, delayMs, handle:scheduledSubmits.length + 1 };
      scheduledSubmits.push(entry);
      return entry.handle;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });

  await session.start();
  children[0].events.emit('data', CODEX_DRAFT_OUTPUT);
  assert.equal(session.snapshot().startupPromptState, 'pending');
  assert.equal(session.snapshot().promptReady, false);
  assert.deepEqual(children[0].writes, [], '初始化期间可编辑的草稿框不能触发自动任务');

  children[0].events.emit('data', CODEX_LOADING_WITH_STATUS_OUTPUT);
  assert.equal(session.snapshot().startupPromptState, 'pending');
  assert.equal(session.snapshot().promptReady, false);
  assert.deepEqual(children[0].writes, [], '底部状态栏已出现但 model 仍为 loading 时也不能触发任务');

  children[0].events.emit('data', CODEX_READY_OUTPUT);
  assert.equal(session.snapshot().startupPromptState, 'submitting');
  assert.deepEqual(children[0].writes, [
    '\u001b[200~这是必须自动发出的初始化说明\u001b[201~',
  ]);
  scheduledSubmits.shift().callback();
  assert.equal(session.snapshot().startupPromptState, 'awaiting-confirmation');
  assert.equal(session.snapshot().promptReady, false);
  assert.equal(children[0].writes.at(-1), '\r');

  children[0].events.emit('data', '\u001b[?25l\u001b[2K• Working');
  assert.equal(session.snapshot().startupPromptState, 'submitted');
  assert.equal(session.snapshot().promptSubmission?.state, 'submitted');
  await session.close();
});

test('Codex 完成长输出后再次出现输入框即可接收下一批任务', async () => {
  const children = [];
  const scheduledSubmits = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    provider:'codex',
    initialPrompt:() => '',
    scheduleSubmit:(callback, delayMs) => {
      const entry = { callback, delayMs, handle:scheduledSubmits.length + 1 };
      scheduledSubmits.push(entry);
      return entry.handle;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });

  await session.start();
  children[0].events.emit('data', CODEX_READY_OUTPUT);
  assert.equal(session.snapshot().promptReady, true);
  session.submitPrompt('处理第一批任务');
  drainUntilEnter(scheduledSubmits, children[0]);
  children[0].events.emit('data', '\u001b[?25l\u001b[2K• Working');
  assert.equal(session.snapshot().promptReady, false);

  // 长输出会把启动时的 `model:` 行挤出短扫描窗口；返回输入框本身仍应恢复 ready。
  children[0].events.emit('data', `\r\n${'处理过程 '.repeat(1_500)}`);
  children[0].events.emit(
    'data',
    '\r\nWorked for 4m 12s'
      + '\u001b[23;1Hgpt-5.6-sol xhigh · /tmp/aico-ppt'
      + CODEX_DRAFT_OUTPUT,
  );
  assert.equal(session.snapshot().promptReady, true);
  assert.doesNotThrow(() => session.submitPrompt('处理第二批任务'));
  assert.equal(children[0].writes.at(-1), '\u001b[200~处理第二批任务\u001b[201~');
  await session.close();
});

test('Codex 工作期间出现 steer 输入框仍保持活动回合，不能接收下一批任务', async () => {
  const children = [];
  const scheduledSubmits = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    provider:'codex',
    initialPrompt:() => '',
    scheduleSubmit:(callback, delayMs) => {
      const entry = { callback, delayMs, handle:scheduledSubmits.length + 1 };
      scheduledSubmits.push(entry);
      return entry.handle;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });

  await session.start();
  children[0].events.emit('data', CODEX_READY_OUTPUT);
  session.submitPrompt('处理第一批任务');
  drainUntilEnter(scheduledSubmits, children[0]);
  children[0].events.emit('data', '\u001b[?25l\u001b[2K• Working');
  children[0].events.emit('data', '\r\nWorking (1s • esc to interrupt) · /tmp/aico-ppt'
    + CODEX_DRAFT_OUTPUT);

  assert.equal(session.snapshot().inputVisible, true);
  assert.equal(session.snapshot().turnState, 'active');
  assert.equal(session.snapshot().promptReady, false);
  session.input('人工 steer 补充');
  assert.equal(children[0].writes.at(-1), '人工 steer 补充',
    '活动回合只阻止自动注入下一批，不能锁住用户键盘输入');
  assert.throws(
    () => session.submitPrompt('不能注入的第二批任务'),
    error => error.code === 'AGENT_TERMINAL_BUSY',
  );
  await session.close();
});

test('Codex 长步骤挤远活动标记后出现 steer 输入框仍保持活动，明确结束后才空闲', async () => {
  const children = [];
  const scheduledSubmits = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    provider:'codex',
    initialPrompt:() => '',
    scheduleSubmit:(callback, delayMs) => {
      const entry = { callback, delayMs, handle:scheduledSubmits.length + 1 };
      scheduledSubmits.push(entry);
      return entry.handle;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });

  await session.start();
  children[0].events.emit('data', CODEX_READY_OUTPUT);
  const submissionId = session.submitPrompt('处理一个会产生长输出的任务');
  drainUntilEnter(scheduledSubmits, children[0]);
  children[0].events.emit(
    'data',
    '\r\nWorked for 30s（上一回合）\r\n\u001b[?25l\u001b[2K• Working',
  );
  assert.equal(session.snapshot().promptSubmission.id, submissionId);
  assert.equal(session.snapshot().turnState, 'active');

  children[0].events.emit('data', `\r\n${'工具执行输出 '.repeat(420)}`);
  children[0].events.emit(
    'data',
    '\u001b[23;1Hgpt-5.6-sol xhigh · /tmp/aico-ppt' + CODEX_DRAFT_OUTPUT,
  );
  assert.equal(session.snapshot().inputVisible, true);
  assert.equal(session.snapshot().turnState, 'active');
  assert.equal(session.snapshot().promptReady, false);
  assert.throws(
    () => session.submitPrompt('不能重复注入的同一任务'),
    error => error.code === 'AGENT_TERMINAL_BUSY',
  );

  children[0].events.emit(
    'data',
    '\r\nWorked for 2m 10s'
      + '\u001b[23;1Hgpt-5.6-sol xhigh · /tmp/aico-ppt'
      + CODEX_DRAFT_OUTPUT,
  );
  assert.equal(session.snapshot().turnState, 'idle');
  assert.equal(session.snapshot().promptReady, true);
  assert.equal(session.snapshot().completedPromptSubmissionId, submissionId);
  await session.close();
});

test('OpenCode 启动 banner 不算就绪，必须等到真实输入框再注入提示词', async () => {
  const children = [];
  const scheduledSubmits = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    provider:'opencode',
    initialPrompt:() => 'OpenCode 初始化说明',
    scheduleSubmit:(callback, delayMs) => {
      const entry = { callback, delayMs, handle:scheduledSubmits.length + 1 };
      scheduledSubmits.push(entry);
      return entry.handle;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  children[0].events.emit('data', '\u001b]0;OpenCode\u0007OpenCode 1.17 starting');
  assert.equal(session.snapshot().promptReady, false);
  assert.equal(session.snapshot().startupPromptState, 'pending');
  assert.deepEqual(children[0].writes, []);
  children[0].events.emit('data', OPENCODE_READY_OUTPUT);
  assert.equal(session.snapshot().promptReady, true);
  assert.equal(session.snapshot().startupPromptState, 'submitting');
  assert.deepEqual(children[0].writes, [
    '\u001b[200~OpenCode 初始化说明\u001b[201~',
  ]);
  drainUntilEnter(scheduledSubmits, children[0]);
  assert.equal(session.snapshot().startupPromptState, 'awaiting-confirmation');
  children[0].events.emit('data', '\u001b[2KOpenCode accepted');
  assert.equal(session.snapshot().startupPromptState, 'submitted');
  await session.close();
});

test('自动回车没有终端回执时只重试一次并显式失败', async () => {
  const children = [];
  const scheduledSubmits = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    provider:'codex',
    initialPrompt:() => '不能静默留在输入框里的初始化说明',
    scheduleSubmit:(callback, delayMs) => {
      const entry = { callback, delayMs, handle:scheduledSubmits.length + 1 };
      scheduledSubmits.push(entry);
      return entry.handle;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  children[0].events.emit('data', 'Codex ready');
  const submitted = session.waitUntilStartupPromptSubmitted({ timeoutMs:1_000 });
  drainUntilEnter(scheduledSubmits, children[0]);
  scheduledSubmits.shift().callback();
  scheduledSubmits.shift().callback();

  assert.equal(children[0].writes.filter(value => value === '\r').length, 2);
  assert.equal(session.snapshot().startupPromptState, 'failed');
  await assert.rejects(submitted, error => (
    error.code === 'AGENT_PROMPT_NOT_SUBMITTED'
      && /手动提交/.test(error.message)
  ));
  await session.close();
});

test('恢复会话的 PTY 已运行但输入框未出现时仍不算就绪', async () => {
  const children = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    resolveConversation:async () => ({
      conversationId:'codex-resumed-trust-session',
      resume:true,
      initialPromptConsumed:true,
    }),
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start({ provider:'codex' });
  let readyResolved = false;
  const ready = session.waitUntilReady({ timeoutMs:1_000 }).then(value => {
    readyResolved = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(session.snapshot().state, 'running');
  assert.equal(session.snapshot().promptReady, false);
  assert.equal(readyResolved, false);
  children[0].events.emit(
    'data',
    'Do you trust the contents of this directory?\r\n› 1. Yes\r\n  2. No\u001b[?25h',
  );
  assert.equal(readyResolved, false);
  session.input('\r');
  children[0].events.emit('data', 'Codex ready');
  await ready;
  assert.equal(session.snapshot().promptReady, true);
  await session.close();
});

test('恢复历史中的旧目录信任提示不能覆盖最终空输入框', async () => {
  const children = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    provider:'codex',
    resolveConversation:async () => ({
      conversationId:'codex-resumed-history-trust-session',
      resume:true,
      initialPromptConsumed:true,
    }),
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start({ provider:'codex' });
  children[0].events.emit(
    'data',
    'Do you trust the contents of this directory?\r\n› 1. Yes\r\n  2. No\r\n'
      + '历史会话内容已经恢复\r\n'
      + CODEX_READY_OUTPUT,
  );
  assert.equal(session.snapshot().interactionRequired, null);
  assert.equal(session.snapshot().promptReady, true);
  await session.close();
});

test('恢复超长 Codex 历史时模型标题被裁掉仍可识别最终输入框', async () => {
  const children = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    provider:'codex',
    resolveConversation:async () => ({
      conversationId:'codex-resumed-long-history-session',
      resume:true,
      initialPromptConsumed:true,
    }),
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start({ provider:'codex' });
  children[0].events.emit(
    'data',
    `${'历史内容 '.repeat(220_000)}\u001b[23;1Hgpt-5.6-sol xhigh · /tmp/aico-ppt`
      + CODEX_DRAFT_OUTPUT,
  );
  assert.equal(session.snapshot().interactionRequired, null);
  assert.equal(session.snapshot().promptReady, true);
  await session.close();
});

test('恢复普通长度 Codex 历史时最终输入框不因缺少启动 model 行而永久锁定', async () => {
  const children = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    provider:'codex',
    resolveConversation:async () => ({
      conversationId:'codex-resumed-visible-input-session',
      resume:true,
      initialPromptConsumed:true,
    }),
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start({ provider:'codex' });
  children[0].events.emit(
    'data',
    '历史会话内容已经恢复\r\n'
      + '\u001b[23;1Hgpt-5.6-sol xhigh · /tmp/aico-ppt'
      + '\u001b[11;1H\u001b[1m›\u001b[11;3H\u001b[2mAsk Codex to do anything'
      + '\u001b[?25h\u001b[11;3H\u001b[?2026l',
  );
  await waitForSessionState(session, snapshot => snapshot.resumePending === false);
  assert.equal(session.snapshot().resumePending, false);
  assert.equal(session.snapshot().promptReady, true);
  await session.close();
});

test('恢复 Codex 已画出输入框但状态栏仍陈旧时只触发一次尺寸重绘', async () => {
  const children = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    provider:'codex',
    resolveConversation:async () => ({
      conversationId:'codex-resumed-stale-loading-session',
      resume:true,
      initialPromptConsumed:true,
    }),
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start({ provider:'codex', cols:90, rows:30 });
  children[0].events.emit('data', CODEX_RESUMED_STALE_LOADING_OUTPUT);
  assert.equal(session.snapshot().promptReady, false);
  assert.deepEqual(children[0].resizes, [[90, 29], [90, 30]]);

  children[0].events.emit('data', CODEX_READY_OUTPUT);
  await waitForSessionState(session, snapshot => snapshot.resumePending === false);
  assert.equal(session.snapshot().promptReady, true);
  assert.equal(session.snapshot().resumePending, false);
  await session.close();
});

test('Codex 恢复时升级通知不误放行，交互升级页开放键盘并继续阻断任务', async t => {
  await t.test('纯通知继续等待真实输入框', async () => {
    const children = [];
    const session = new AgentTerminalSession({
      projectRoot:'/tmp/aico-ppt',
      provider:'codex',
      resolveConversation:async () => ({
        conversationId:'codex-update-notice-session',
        resume:true,
        initialPromptConsumed:true,
      }),
      spawnPty:(executable, args, options) => {
        const child = new FakePty(executable, args, options);
        children.push(child);
        return child;
      },
    });
    await session.start({ provider:'codex' });
    children[0].events.emit('data', CODEX_UPDATE_NOTICE_OUTPUT);
    assert.equal(session.snapshot().interactionRequired, null);
    assert.equal(session.snapshot().resumePending, true);
    session.input('\r');
    assert.deepEqual(children[0].writes, [], '纯通知期间仍禁止误输入');

    children[0].events.emit('data', CODEX_READY_OUTPUT);
    await waitForSessionState(session, snapshot => snapshot.resumePending === false);
    assert.equal(session.snapshot().resumePending, false);
    assert.equal(session.snapshot().promptReady, true);
    await session.close();
  });

  await t.test('需要按键的升级页进入受控交互态', async () => {
    const children = [];
    const session = new AgentTerminalSession({
      projectRoot:'/tmp/aico-ppt',
      provider:'codex',
      resolveConversation:async () => ({
        conversationId:'codex-update-interaction-session',
        resume:true,
        initialPromptConsumed:true,
      }),
      spawnPty:(executable, args, options) => {
        const child = new FakePty(executable, args, options);
        children.push(child);
        return child;
      },
    });
    await session.start({ provider:'codex' });
    children[0].events.emit('data', CODEX_UPDATE_INTERACTION_OUTPUT);
    assert.deepEqual(session.snapshot().interactionRequired, {
      kind:'codex-update',
      message:'请在右侧终端处理 Codex 更新提示',
    });
    assert.equal(session.snapshot().promptReady, false);
    assert.equal(session.snapshot().resumePending, true);
    session.input('\r');
    assert.deepEqual(children[0].writes, ['\r'], '升级交互页必须允许用户按键继续');

    children[0].events.emit('data', CODEX_READY_OUTPUT);
    await waitForSessionState(session, snapshot => snapshot.resumePending === false);
    assert.equal(session.snapshot().interactionRequired, null);
    assert.equal(session.snapshot().resumePending, false);
    assert.equal(session.snapshot().promptReady, true);
    await session.close();
  });
});

test('Codex 恢复目录不一致时开放目录选择页且继续阻断任务', async () => {
  const children = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    provider:'codex',
    resolveConversation:async () => ({
      conversationId:'codex-resume-directory-session',
      resume:true,
      initialPromptConsumed:true,
    }),
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start({ provider:'codex' });
  children[0].events.emit('data', CODEX_RESUME_DIRECTORY_INTERACTION_OUTPUT);
  assert.deepEqual(session.snapshot().interactionRequired, {
    kind:'working-directory-selection',
    message:'请在右侧终端选择恢复会话使用的工作目录',
  });
  assert.equal(session.snapshot().promptReady, false);
  assert.equal(session.snapshot().resumePending, true);
  session.input('\r');
  assert.deepEqual(children[0].writes, ['\r'], '目录选择页必须允许用户按键继续');

  children[0].events.emit('data', CODEX_READY_OUTPUT);
  await waitForSessionState(session, snapshot => snapshot.resumePending === false);
  assert.equal(session.snapshot().interactionRequired, null);
  assert.equal(session.snapshot().resumePending, false);
  assert.equal(session.snapshot().promptReady, true);
  await session.close();
});

test('未知 CLI 编号选择页走通用交互闸门，普通编号日志不误开放键盘', async () => {
  const children = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    provider:'codex',
    initialPrompt:() => '选择完成前不能提交',
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  children[0].events.emit('data', '启动日志\r\n1. 扫描项目\r\n2. 加载配置\r\nPress Enter 只是历史说明');
  assert.equal(session.snapshot().interactionRequired, null);
  session.input('\r');
  assert.deepEqual(children[0].writes, [], '没有高亮选项的编号日志必须继续锁住键盘');

  children[0].events.emit(
    'data',
    '\u001b[2;1HChoose\u001b[2;8Hstartup\u001b[2;16Hprofile'
      + '\u001b[4;1H› 1. Safe profile\u001b[5;1H2. Custom profile'
      + '\u001b[7;1HUse arrow keys, then press Enter\u001b[?25l',
  );
  assert.deepEqual(session.snapshot().interactionRequired, {
    kind:'terminal-selection',
    message:'请在右侧终端完成 CLI 选项确认',
  });
  assert.equal(session.snapshot().promptReady, false);
  session.input('\u001b[B');
  session.input('\r');
  assert.deepEqual(children[0].writes, ['\u001b[B', '\r'], '通用选择页必须允许方向键和回车');
  assert.equal(session.snapshot().startupPromptState, 'pending');

  children[0].events.emit('data', CODEX_READY_OUTPUT);
  assert.equal(session.snapshot().interactionRequired, null);
  assert.equal(session.snapshot().promptReady, true);
  assert.ok(children[0].writes.some(value => value.includes('选择完成前不能提交')));
  await session.close();
});

test('恢复 Codex 会话时显式 model loading 仍不能提前接收任务', async () => {
  const children = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    provider:'codex',
    resolveConversation:async () => ({
      conversationId:'codex-resumed-loading-session',
      resume:true,
      initialPromptConsumed:true,
    }),
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start({ provider:'codex' });
  children[0].events.emit('data', CODEX_LOADING_WITH_STATUS_OUTPUT);
  assert.equal(session.snapshot().promptReady, false);
  await session.close();
});

test('Windows 优先使用 native exe，并兼容 npm cmd shim', () => {
  const native = resolveAgentTerminalExecutable('claude-code', {
    platform:'win32',
    environment:{ PATH:String.raw`C:\Native;C:\Npm`, PATHEXT:'.EXE;.CMD' },
    exists:path => path === String.raw`C:\Native\claude.exe`
      || path === String.raw`C:\Npm\claude.cmd`,
  });
  assert.equal(native, String.raw`C:\Native\claude.exe`);

  const shim = resolveAgentTerminalExecutable('claude-code', {
    platform:'win32',
    environment:{ PATH:String.raw`C:\Npm`, PATHEXT:'.EXE;.CMD' },
    exists:path => path === String.raw`C:\Npm\claude.cmd`,
  });
  assert.equal(shim, String.raw`C:\Npm\claude.cmd`);
});

test('Windows PTY 使用 npm 的 .cmd shim 启动 Agent', async () => {
  const children = [];
  const scheduledSubmits = [];
  const scheduledDelays = [];
  const session = new AgentTerminalSession({
    projectRoot:String.raw`C:\aico-ppt`,
    provider:'claude-code',
    platform:'win32',
    resolveExecutable:() => 'claude.cmd',
    scheduleSubmit:(callback, delayMs) => {
      scheduledDelays.push(delayMs);
      scheduledSubmits.push({ callback, delayMs });
      return scheduledSubmits.length;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  assert.equal(children[0].executable, 'claude.cmd');
  children[0].events.emit('data', CLAUDE_READY_OUTPUT);
  session.submitPrompt('第一行\n第二行');
  assert.deepEqual(children[0].writes, ['\u001b[200~']);
  assert.equal(scheduledSubmits[0].delayMs, 30);
  drainUntilEnter(scheduledSubmits, children[0]);
  assert.deepEqual(children[0].writes, [
    '\u001b[200~', '第一行\n第二行', '\u001b[201~', '\r',
  ]);
  assert.deepEqual(scheduledDelays, [30, 30, 3_500, 1_500]);
  children[0].events.emit('data', '\u001b[?25lClaude accepted prompt');
  assert.equal(session.snapshot().promptSubmission.state, 'submitted');
  await session.close();
});

test('Windows Claude Code 长任务分块穿过 ConPTY 后再自动回车', async () => {
  const children = [];
  const scheduledSubmits = [];
  const session = new AgentTerminalSession({
    projectRoot:String.raw`Y:\aico-ppt`,
    provider:'claude-code',
    platform:'win32',
    resolveExecutable:() => 'claude.exe',
    scheduleSubmit:(callback, delayMs) => {
      scheduledSubmits.push({ callback, delayMs });
      return scheduledSubmits.length;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new BoundedWritePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  children[0].events.emit('data', CLAUDE_READY_OUTPUT);
  const prompt = [
    String.raw`Deck：Y:\aico-ppt\Deck-Projects\demo\working\deck.html`,
    '只处理本批 ID；不要读取整份历史；保持 action envelope 完整。'.repeat(120),
    '如果收到这里，说明任务指令完整。',
  ].join('\n');

  session.submitPrompt(prompt);
  drainUntilEnter(scheduledSubmits, children[0]);

  assert.equal(
    children[0].accepted.join(''),
    `\u001b[200~${prompt}\u001b[201~\r`,
    '任一单次 PTY 写入受限时，也必须完整交付正文、paste 结束符和回车',
  );
  assert.ok(children[0].writes.length > 3, '长 Prompt 必须拆成多个 PTY write');
  assert.ok(
    children[0].writes.every(data => Buffer.byteLength(data, 'utf8') <= 512),
    '每次正文写入不得超过保守的 512 B ConPTY 边界',
  );
  assert.equal(children[0].writes.at(-1), '\r');
  children[0].events.emit('data', '\u001b[?25lClaude accepted prompt');
  assert.equal(session.snapshot().promptSubmission.state, 'submitted');
  await session.close();
});

test('Windows Claude Code 在单次写入只保留末尾 1 KiB 时不得丢失任务开头', async () => {
  const children = [];
  const scheduledSubmits = [];
  const session = new AgentTerminalSession({
    projectRoot:String.raw`Y:\aico-ppt`,
    provider:'claude-code',
    platform:'win32',
    resolveExecutable:() => 'claude.exe',
    scheduleSubmit:(callback, delayMs) => {
      scheduledSubmits.push({ callback, delayMs });
      return scheduledSubmits.length;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new TailBoundedWritePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  children[0].events.emit('data', CLAUDE_READY_OUTPUT);
  const prompt = buildAgentPrompt({
    deckPath:String.raw`Y:\aico-ppt\Deck-Projects\demo\.aico-ppt-editor\test\working\deck.html`,
    serviceUrl:'http://127.0.0.1:54117',
    token:'secret',
    taskIds:['task-windows-prefix'],
    sourceThreadId:null,
    loadSkill:false,
    environmentCredentials:true,
  });

  session.submitPrompt(prompt);
  drainUntilEnter(scheduledSubmits, children[0]);

  assert.equal(
    children[0].accepted.join(''),
    `\u001b[200~${prompt}\u001b[201~\r`,
    '接收端保留大块写入的末尾时，任务第一行和第 1 点仍必须完整',
  );
  children[0].events.emit('data', '\u001b[?25lClaude accepted prompt');
  assert.equal(session.snapshot().promptSubmission.state, 'submitted');
  await session.close();
});

test('Windows Claude Code 分块提交中重启会取消整条旧写入链', async () => {
  const children = [];
  const scheduledSubmits = [];
  const cancelled = [];
  let nextHandle = 0;
  const session = new AgentTerminalSession({
    projectRoot:String.raw`C:\aico-ppt`,
    provider:'claude-code',
    platform:'win32',
    scheduleSubmit:(callback, delayMs) => {
      const entry = { callback, delayMs, handle:nextHandle += 1 };
      scheduledSubmits.push(entry);
      return entry.handle;
    },
    cancelScheduledSubmit:handle => cancelled.push(handle),
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  children[0].events.emit('data', CLAUDE_READY_OUTPUT);
  session.submitPrompt('长任务正文'.repeat(1_000));
  assert.deepEqual(children[0].writes, ['\u001b[200~']);
  scheduledSubmits.shift().callback();
  const staleStep = scheduledSubmits.shift();
  assert.ok(staleStep, '首块正文之后应继续调度下一块');

  await session.restart({ provider:'claude-code' });
  assert.deepEqual(cancelled, [staleStep.handle]);
  staleStep.callback();
  assert.deepEqual(children[1].writes, [], '旧回调不得把正文或回车写入新会话');
  await session.close();
});

test('Windows PTY 对外保留可信 UNC 项目身份，但用映射盘 cwd 启动 Agent', async () => {
  const children = [];
  const session = new AgentTerminalSession({
    projectRoot:String.raw`\\server\share\aico-ppt`,
    cwd:String.raw`R:\aico-ppt`,
    provider:'claude-code',
    platform:'win32',
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  assert.equal(session.snapshot().projectRoot, String.raw`\\server\share\aico-ppt`);
  assert.equal(children[0].options.cwd, String.raw`R:\aico-ppt`);
  await session.close();
});

test('Windows Codex 通过 WSL runtime 启动并用 WSL 路径提交与发现会话', async () => {
  const children = [];
  const resolutions = [];
  const discoveries = [];
  const scheduled = [];
  const session = new AgentTerminalSession({
    projectRoot:String.raw`C:\Users\tester\workspace\project`,
    cwd:String.raw`C:\Users\tester\workspace\project`,
    provider:'codex',
    platform:'win32',
    environment:{ AICO_PPT_EDITOR_TOKEN:'secret' },
    runtimePathRoots:[String.raw`C:\Users\tester\workspace\AICO-PPT`],
    prepareRuntime:async () => ({
      kind:'wsl',
      conversationCwd:'/mnt/c/Users/tester/workspace/project',
      spawnCwd:String.raw`C:\Users\tester\workspace\project`,
      environment:{
        AICO_PPT_EDITOR_TOKEN:'secret',
        AICO_PPT_CODEX_RUNTIME:'wsl',
      },
      translateText:text => text
        .replaceAll(String.raw`C:\Users\tester\workspace\project`, '/mnt/c/Users/tester/workspace/project'),
      wrapCommand:command => ({
        ...command,
        label:'Codex（WSL Ubuntu-26.04/root）',
        executable:'wsl.exe',
        args:['-d', 'Ubuntu-26.04', '--exec', 'codex', ...command.args],
      }),
    }),
    initialPrompt:() => String.raw`读取 C:\Users\tester\workspace\project 中的 Skill`,
    resolveConversation:async (provider, options) => {
      resolutions.push([provider, options]);
      return {
        conversationId:null,
        resume:false,
        discoveryToken:'019ff4b7-0622-7272-b0e2-394f6316b52a',
        discoveryStartedAt:'2026-08-17T00:00:00.000Z',
        knownConversationIds:[],
      };
    },
    identifyConversation:async (provider, options) => {
      discoveries.push([provider, options]);
      return 'wsl-codex-session';
    },
    scheduleSubmit:(callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return scheduled.length;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  assert.equal(children[0].executable, 'wsl.exe');
  assert.equal(children[0].options.cwd, String.raw`C:\Users\tester\workspace\project`);
  assert.deepEqual(resolutions[0][1].environment, {
    AICO_PPT_EDITOR_TOKEN:'secret',
    AICO_PPT_CODEX_RUNTIME:'wsl',
  });
  children[0].events.emit('data', 'Codex ready');
  drainUntilEnter(scheduled, children[0]);
  assert.match(children[0].writes.join(''), /\/mnt\/c\/Users\/tester\/workspace\/project/);
  assert.match(children[0].writes.join(''), /\u001b\[201~\r$/);
  children[0].events.emit('data', '\u001b[?25l\u001b[2K• Working');
  assert.equal(session.snapshot().startupPromptState, 'submitted');
  assert.equal(discoveries[0][1].cwd, '/mnt/c/Users/tester/workspace/project');
  assert.equal(discoveries[0][1].environment.AICO_PPT_CODEX_RUNTIME, 'wsl');
  await session.close();
});

test('WSL Codex 启动依次投影准备、CLI 启动和历史重绘阶段', async () => {
  const children = [];
  let releaseRuntime;
  const runtimeReady = new Promise(resolveReady => { releaseRuntime = resolveReady; });
  const session = new AgentTerminalSession({
    projectRoot:String.raw`C:\Users\tester\workspace\project`,
    cwd:String.raw`C:\Users\tester\workspace\project`,
    provider:'codex',
    platform:'win32',
    prepareRuntime:async (_provider, options) => {
      options.onPhase('wsl-preparing');
      await runtimeReady;
      return {
        kind:'wsl',
        conversationCwd:'/mnt/c/Users/tester/workspace/project',
        spawnCwd:String.raw`C:\Users\tester\workspace\project`,
        environment:{},
        wrapCommand:command => ({ ...command, executable:'wsl.exe' }),
      };
    },
    resolveConversation:async () => ({
      conversationId:'codex-history-phase', resume:true, initialPromptConsumed:true,
    }),
    initialPrompt:() => '',
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });

  const starting = session.start();
  await new Promise(resolveDelay => setImmediate(resolveDelay));
  assert.equal(session.snapshot().startupPhase, 'wsl-preparing');
  releaseRuntime();
  await starting;
  assert.equal(session.snapshot().startupPhase, 'history-redraw');
  children[0].events.emit('data', CODEX_READY_OUTPUT);
  await waitForSessionState(session, snapshot => snapshot.startupPhase === 'ready');
  assert.equal(session.snapshot().startupPhase, 'ready');
  await session.close();
});

test('恢复会话只向浏览器投影最终终端画面，后续输出恢复实时传输', async () => {
  const children = [];
  const sockets = [];
  const projectedChunks = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    provider:'codex',
    initialPrompt:() => '',
    resolveConversation:async () => ({
      conversationId:'codex-projection', resume:true, initialPromptConsumed:true,
    }),
    createTerminalProjection:() => ({
      write:data => projectedChunks.push(data),
      resize:() => {},
      snapshot:async () => '\u001b[2J\u001b[H最终终端画面',
      dispose:() => {},
    }),
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  const socket = {
    readyState:1,
    send:value => sockets.push(JSON.parse(value)),
  };
  session.attach(socket);
  await session.start();
  sockets.length = 0;

  children[0].events.emit('data', '\u001b[2J第一段历史 ANSI');
  children[0].events.emit('data', '\u001b[3;1H第二段历史 ANSI');
  assert.equal(sockets.some(message => message.type === 'output'), false);
  children[0].events.emit('data', CODEX_READY_OUTPUT);
  await new Promise(resolveDelay => setImmediate(resolveDelay));

  const projection = sockets.find(message => message.type === 'projection');
  assert.equal(projection?.data, '\u001b[2J\u001b[H最终终端画面');
  assert.match(projectedChunks.join(''), /第一段历史 ANSI/);
  assert.match(projectedChunks.join(''), /第二段历史 ANSI/);
  assert.equal(session.snapshot().resumePending, false);

  sockets.length = 0;
  children[0].events.emit('data', '\r\n就绪后的实时输出');
  assert.deepEqual(
    sockets.filter(message => message.type === 'output').map(message => message.data),
    ['\r\n就绪后的实时输出'],
  );
  await session.close();
});

test('独立 Escape 输入发布批次中断事件，方向键转义序列不误触发', async () => {
  const children = [];
  const interrupts = [];
  const projectRoot = process.platform === 'win32'
    ? String.raw`C:\aico-ppt`
    : '/tmp/aico-ppt';
  const session = new AgentTerminalSession({
    projectRoot,
    initialPrompt:() => '',
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  session.addInterruptListener(value => interrupts.push(value));
  await session.start();
  session.input('\u001b[A');
  session.input('\u001b');
  assert.deepEqual(children[0].writes, [], '首次输入框就绪前必须拦住所有误输入');
  assert.equal(interrupts.length, 0, '被闸门拦下的 Escape 不能误中断 Agent 批次');

  children[0].events.emit('data', 'Codex ready');
  session.input('\u001b[A');
  session.input('\u001b');
  assert.deepEqual(children[0].writes, ['\u001b[A', '\u001b']);
  assert.equal(interrupts.length, 1);
  assert.equal(interrupts[0].source, 'escape-key');
  assert.equal(session.snapshot().state, 'running');
  await session.close();
});

test('重启会话会取消待发送回车，旧回调不能提交到新 Agent', async () => {
  const children = [];
  const cancelled = [];
  let scheduled;
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    platform:'linux',
    scheduleSubmit:(callback, delayMs) => {
      scheduled = { callback, delayMs };
      return 99;
    },
    cancelScheduledSubmit:handle => cancelled.push(handle),
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  children[0].events.emit('data', 'Codex ready');
  session.submitPrompt('不会误发');
  assert.deepEqual(children[0].writes, ['\u001b[200~不会误发\u001b[201~']);
  assert.equal(scheduled.delayMs, 120);

  await session.restart();
  assert.deepEqual(cancelled, [99]);
  scheduled.callback();
  assert.deepEqual(children[1].writes, []);
  await session.close();
});

test('Codex 初始化指令等待真实输入框就绪，添加任务和新会话都不抢跑', async () => {
  const children = [];
  const resolutions = [];
  const scheduledSubmits = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    platform:'linux',
    initialPrompt:() => '这是新建 Deck 的初始化说明',
    resolveConversation:async (_provider, options) => {
      resolutions.push(options.newConversation);
      return { conversationId:'codex-visible-session', resume:false };
    },
    scheduleSubmit:(callback, delayMs) => {
      scheduledSubmits.push({ callback, delayMs });
      return scheduledSubmits.length;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  const emitBanner = child => child.events.emit(
    'data',
    '\u001b[?2004h\u001b[?2026h\u001b[2;1HOpenAI Codex\u001b[5;1Hmodel: loading',
  );
  const emitInputReady = child => child.events.emit('data', CODEX_READY_OUTPUT);

  await session.start({ provider:'codex' });
  emitBanner(children[0]);
  assert.equal(session.snapshot().startupPromptState, 'pending');
  assert.deepEqual(children[0].writes, [], 'Codex 仍在初始化时不得提前粘贴指令');
  emitInputReady(children[0]);
  assert.equal(session.snapshot().startupPromptState, 'submitting');
  assert.deepEqual(children[0].writes, [
    '\u001b[200~这是新建 Deck 的初始化说明\u001b[201~',
  ]);
  drainUntilEnter(scheduledSubmits, children[0]);
  assert.equal(session.snapshot().startupPromptState, 'awaiting-confirmation');
  children[0].events.emit('data', '\u001b[?25l\u001b[2K• Working');
  assert.equal(session.snapshot().startupPromptState, 'submitted');

  await session.restart({ provider:'codex', newConversation:true });
  emitBanner(children[1]);
  assert.equal(session.snapshot().startupPromptState, 'pending');
  assert.deepEqual(children[1].writes, [], '新会话同样必须等待输入框就绪');
  emitInputReady(children[1]);
  assert.deepEqual(children[1].writes, [
    '\u001b[200~这是新建 Deck 的初始化说明\u001b[201~',
  ]);
  drainUntilEnter(scheduledSubmits, children[1]);
  assert.equal(session.snapshot().startupPromptState, 'awaiting-confirmation');
  children[1].events.emit('data', '\u001b[?25l\u001b[2K• Working');
  assert.equal(session.snapshot().startupPromptState, 'submitted');
  assert.deepEqual(resolutions, [false, true]);
  await session.close();
});

test('PTY 会话在项目目录启动、回放输出并支持输入、缩放和重启', async () => {
  const children = [];
  const providerChanges = [];
  const scheduledSubmits = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    platform:'linux',
    initialPrompt:provider => `初始化 ${provider}`,
    onProviderChange:async provider => providerChanges.push(provider),
    scheduleSubmit:(callback, delayMs) => {
      scheduledSubmits.push({ callback, delayMs });
      return scheduledSubmits.length;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  const runtimeId = session.snapshot().runtimeId;
  const listenerProviders = [];
  const listenerStates = [];
  session.addProviderChangeListener(value => listenerProviders.push(value));
  session.addStateListener(value => listenerStates.push(value.state));
  session.updateEnvironment({ AICO_PPT_CREATION_URL:'http://127.0.0.1:1234' });
  const sent = [];
  const socket = { readyState:1, send:value => sent.push(JSON.parse(value)) };
  session.attach(socket);
  await session.start({ cols:100, rows:32 });
  const first = children[0];
  assert.equal(first.executable, 'codex');
  assert.deepEqual(first.args, [
    '--dangerously-bypass-approvals-and-sandbox',
  ]);
  assert.equal(first.options.cwd, '/tmp/aico-ppt');
  assert.equal(first.options.env.TERM, 'xterm-256color');
  assert.equal(first.options.env.AICO_PPT_CREATION_URL, 'http://127.0.0.1:1234');
  first.events.emit('data', '\u001b[31mCodex ready\u001b[0m');
  assert.ok(sent.some(message => message.type === 'output'));
  assert.equal(session.snapshot().startupPromptState, 'submitting');
  assert.deepEqual(first.writes, ['\u001b[200~初始化 codex\u001b[201~']);
  session.input('初始化期间不得写入');
  assert.deepEqual(first.writes, ['\u001b[200~初始化 codex\u001b[201~']);
  assert.equal(scheduledSubmits.length, 1);
  assert.equal(scheduledSubmits[0].delayMs, 120);
  drainUntilEnter(scheduledSubmits, first);
  assert.equal(session.snapshot().startupPromptState, 'awaiting-confirmation');
  first.events.emit('data', '\u001b[?25l\u001b[2K• Working');
  assert.equal(session.snapshot().startupPromptState, 'submitted');
  first.events.emit('data', 'Codex ready');
  assert.equal(session.snapshot().promptReady, true);
  session.input('hello');
  session.submitPrompt('处理任务');
  session.resize(120, 40);
  assert.deepEqual(first.writes, [
    '\u001b[200~初始化 codex\u001b[201~', '\r',
    'hello', '\u001b[200~处理任务\u001b[201~',
  ]);
  assert.equal(scheduledSubmits.at(-1).delayMs, 120);
  drainUntilEnter(scheduledSubmits, first);
  assert.deepEqual(first.writes, [
    '\u001b[200~初始化 codex\u001b[201~', '\r',
    'hello', '\u001b[200~处理任务\u001b[201~', '\r',
  ]);
  first.events.emit('data', '\u001b[?25l\u001b[2K• Working');
  assert.deepEqual(first.resizes, [[120, 40]]);

  const replay = [];
  session.attach({ readyState:1, send:value => replay.push(JSON.parse(value)) });
  assert.match(replay[0].output, /Codex ready/);
  await session.restart({ provider:'claude-code', initialPrompt:'Claude 初始化' });
  assert.equal(first.killed, true);
  assert.equal(children[1].executable, 'claude');
  assert.deepEqual(children[1].args, ['--dangerously-skip-permissions']);
  children[1].events.emit('data', CLAUDE_READY_OUTPUT);
  assert.equal(session.snapshot().startupPromptState, 'submitting');
  assert.deepEqual(children[1].writes, ['\u001b[200~Claude 初始化\u001b[201~']);
  assert.deepEqual(providerChanges, ['codex', 'claude-code']);
  assert.deepEqual(listenerProviders, ['codex', 'claude-code']);
  assert.ok(listenerStates.includes('running'));
  assert.equal(session.snapshot().runtimeId, runtimeId);
  await session.close();
  assert.equal(children[1].killed, true);
});

test('PTY 启动前解析任务专属会话，启动后持久化回执', async () => {
  const children = [];
  const started = [];
  const resolutions = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    environment:{ AICO_PPT_TEST:'conversation-env' },
    resolveConversation:async (provider, options) => {
      resolutions.push([provider, options]);
      return {
        conversationId:provider === 'codex' ? 'codex-task-session' : 'claude-task-session',
        resume:provider === 'codex',
      };
    },
    onConversationStarted:async (provider, conversationId) => started.push([provider, conversationId]),
    initialPrompt:() => '继续当前任务',
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start({ provider:'codex' });
  assert.deepEqual(children[0].args, [
    'resume', '--dangerously-bypass-approvals-and-sandbox',
    'codex-task-session',
  ]);
  await session.restart({ provider:'codex', initialPrompt:'处理新任务' });
  assert.deepEqual(children[1].args, [
    'resume', '--dangerously-bypass-approvals-and-sandbox',
    'codex-task-session',
  ]);
  children[1].events.emit('data', 'Codex ready');
  await waitForSessionState(session, () => children[1].writes.length > 0);
  assert.deepEqual(children[1].writes, ['\u001b[200~处理新任务\u001b[201~']);
  assert.equal(session.snapshot().conversationId, 'codex-task-session');
  assert.equal(session.snapshot().conversationResumed, true);
  await session.restart({ provider:'claude-code', newConversation:true });
  assert.deepEqual(children[2].args, [
    '--dangerously-skip-permissions', '--session-id',
    'claude-task-session',
  ]);
  children[2].events.emit('data', CLAUDE_READY_OUTPUT);
  assert.deepEqual(children[2].writes, ['\u001b[200~继续当前任务\u001b[201~']);
  assert.deepEqual(started, [
    ['codex', 'codex-task-session'],
    ['codex', 'codex-task-session'],
    ['claude-code', 'claude-task-session'],
  ]);
  assert.deepEqual(resolutions, [
    ['codex', {
      newConversation:false,
      initialPrompt:'继续当前任务',
      environment:{ AICO_PPT_TEST:'conversation-env' },
    }],
    ['codex', {
      newConversation:false,
      initialPrompt:'处理新任务',
      environment:{ AICO_PPT_TEST:'conversation-env' },
    }],
    ['claude-code', {
      newConversation:true,
      initialPrompt:'继续当前任务',
      environment:{ AICO_PPT_TEST:'conversation-env' },
    }],
  ]);
  await session.close();
});

test('Codex 新会话先显示 PTY，再异步发现并持久化真实 ID', async () => {
  const children = [];
  const started = [];
  let releaseIdentity;
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    initialPrompt:() => '读取 Skill 并建立编辑上下文',
    resolveConversation:async () => ({
      conversationId:null,
      resume:false,
      initialPromptConsumed:false,
      discoveryToken:'019ff4b7-0622-7272-b0e2-394f6316b52a',
    }),
    identifyConversation:async () => new Promise(resolve => { releaseIdentity = resolve; }),
    onConversationStarted:async (provider, conversationId) => started.push([provider, conversationId]),
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });

  await session.start({ provider:'codex' });
  assert.equal(children.length, 1, '异步身份发现不得阻塞 PTY 显示');
  assert.equal(session.snapshot().state, 'running');
  assert.equal(session.snapshot().conversationId, null);
  assert.deepEqual(children[0].args.slice(0, 1), [
    '--dangerously-bypass-approvals-and-sandbox',
  ]);
  children[0].events.emit('data', 'Codex ready');
  assert.match(children[0].writes[0], /019ff4b7-0622-7272-b0e2-394f6316b52a/);
  assert.match(children[0].writes[0], /读取 Skill/);

  releaseIdentity('019ff4b7-0622-7272-b0e2-394f6316b52b');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.snapshot().conversationId, '019ff4b7-0622-7272-b0e2-394f6316b52b');
  assert.deepEqual(started, [[
    'codex', '019ff4b7-0622-7272-b0e2-394f6316b52b',
  ]]);
  await session.close();
});

test('Codex 恢复 ID 已失效时由可见 CLI 失败信号自动切换新会话', async () => {
  const children = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    initialPrompt:() => '读取 Skill',
    resolveConversation:async (_provider, { newConversation }) => newConversation
      ? {
          conversationId:null,
          resume:false,
          initialPromptConsumed:false,
          discoveryToken:'019ff4b7-0622-7272-b0e2-394f6316b52a',
        }
      : { conversationId:'missing-codex-session', resume:true },
    identifyConversation:async () => 'replacement-codex-session',
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });

  await session.start({ provider:'codex' });
  children[0].events.emit('data', 'ERROR: No saved session found with ID missing-codex-session.');
  children[0].events.emit('exit', { exitCode:1, signal:null });
  for (let attempt = 0; attempt < 50 && children.length < 2; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(children.length, 2);
  assert.deepEqual(children[1].args.slice(0, 1), [
    '--dangerously-bypass-approvals-and-sandbox',
  ]);
  children[1].events.emit('data', 'Codex ready');
  assert.match(children[1].writes[0], /019ff4b7-0622-7272-b0e2-394f6316b52a/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.snapshot().conversationId, 'replacement-codex-session');
  await session.close();
});

test('Claude Code 恢复 ID 已失效时由可见 CLI 失败信号自动切换新会话', async () => {
  const children = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/aico-ppt',
    initialPrompt:() => '读取 Skill',
    resolveConversation:async (_provider, { newConversation }) => newConversation
      ? {
          conversationId:'replacement-claude-session',
          resume:false,
          initialPromptConsumed:false,
        }
      : { conversationId:'missing-claude-session', resume:true },
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });

  await session.start({ provider:'claude-code' });
  assert.deepEqual(children[0].args, [
    '--dangerously-skip-permissions', '--resume', 'missing-claude-session',
  ]);
  children[0].events.emit(
    'data',
    'No conversation found with session ID: missing-claude-session',
  );
  children[0].events.emit('exit', { exitCode:1, signal:null });
  for (let attempt = 0; attempt < 50 && children.length < 2; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(children.length, 2);
  assert.deepEqual(children[1].args, [
    '--dangerously-skip-permissions', '--session-id', 'replacement-claude-session',
  ]);
  children[1].events.emit('data', CLAUDE_READY_OUTPUT);
  assert.deepEqual(children[1].writes, ['\u001b[200~读取 Skill\u001b[201~']);
  assert.equal(session.snapshot().conversationId, 'replacement-claude-session');
  assert.equal(session.snapshot().conversationResumed, false);
  await session.close();
});
