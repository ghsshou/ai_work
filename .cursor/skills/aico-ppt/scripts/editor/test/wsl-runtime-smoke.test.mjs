import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import { AgentTerminalSession } from '../agent-terminal-session.mjs';
import {
  loadAgentRuntimeSettings,
  prepareAgentTerminalRuntime,
} from '../agent-terminal-runtime.mjs';

const execFileAsync = promisify(execFile);
const PROJECT_DIR = resolve(fileURLToPath(import.meta.url), '../../../..');
const ENABLED = process.platform === 'win32' && process.env.AICO_PPT_WSL_SMOKE === '1';

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  return null;
}

test('本机 Windows Editor 可通过 WSL runtime 启动 Codex', { skip:!ENABLED }, async () => {
  const settings = loadAgentRuntimeSettings({
    settingsPath:join(homedir(), '.aico-ppt-editor', 'settings.json'),
  });
  const runtime = await prepareAgentTerminalRuntime('codex', {
    settings,
    projectRoot:PROJECT_DIR,
    cwd:PROJECT_DIR,
    pathRoots:[PROJECT_DIR],
  });
  assert.equal(runtime?.kind, 'wsl');
  assert.ok(runtime.conversationCwd.startsWith('/'));

  const versionCommand = runtime.wrapCommand({
    provider:'codex', label:'Codex', executable:'codex.cmd', args:['--version'],
  });
  const version = await execFileAsync(versionCommand.executable, versionCommand.args, {
    cwd:runtime.spawnCwd,
    env:runtime.environment,
    encoding:'utf8',
    timeout:15_000,
    windowsHide:true,
  });
  assert.match(version.stdout, /codex-cli\s+\d+/);

  const helper = await execFileAsync('wsl.exe', [
    '-d', runtime.environment.AICO_PPT_WSL_DISTRO,
    '-u', runtime.environment.AICO_PPT_WSL_USER,
    '--exec', runtime.environment.AICO_PPT_WSL_NODE,
    runtime.environment.AICO_PPT_WSL_SESSION_HELPER,
    'list-rollouts', runtime.environment.AICO_PPT_WSL_CODEX_HOME,
  ], { encoding:'utf8', timeout:15_000, windowsHide:true });
  assert.ok(Array.isArray(JSON.parse(helper.stdout).ids));

  const terminal = new AgentTerminalSession({
    projectRoot:PROJECT_DIR,
    cwd:PROJECT_DIR,
    runtimePathRoots:[PROJECT_DIR],
    provider:'codex',
    prepareRuntime:(provider, options) => prepareAgentTerminalRuntime(provider, {
      ...options, settings,
    }),
    initialPrompt:() => '',
    resolveConversation:async () => null,
  });
  try {
    await terminal.start({ cols:100, rows:30 });
    await new Promise(resolveDelay => setTimeout(resolveDelay, 2_000));
    const snapshot = terminal.snapshot();
    assert.equal(snapshot.state, 'running');
    assert.match(snapshot.providerLabel, /Codex（WSL Ubuntu-26\.04\/root）/);
    assert.match(snapshot.command, /^wsl\.exe /i);
  } finally {
    await terminal.close();
  }
});

test('真实 WSL Codex 目录信任提示会解除 Agent 切换遮罩', {
  skip:!ENABLED,
}, async t => {
  const trustProject = await mkdtemp(join(tmpdir(), 'deck-wsl-trust-'));
  t.after(() => rm(trustProject, { recursive:true, force:true }));
  const settings = loadAgentRuntimeSettings({
    settingsPath:join(homedir(), '.aico-ppt-editor', 'settings.json'),
  });
  const terminal = new AgentTerminalSession({
    projectRoot:trustProject,
    cwd:trustProject,
    runtimePathRoots:[PROJECT_DIR],
    provider:'codex',
    prepareRuntime:(provider, options) => prepareAgentTerminalRuntime(provider, {
      ...options, settings,
    }),
    initialPrompt:() => '等待目录信任确认后才允许提交这条初始化任务',
    resolveConversation:async () => null,
    // 不执行延迟 Enter，确保识别失败时真实信任提示仍留在屏幕上。
    scheduleSubmit:() => 1,
    cancelScheduledSubmit:() => {},
  });
  try {
    await terminal.start({ cols:100, rows:30 });
    const interaction = await waitFor(
      () => terminal.snapshot().interactionRequired,
      10_000,
    );
    assert.deepEqual(interaction, {
      kind:'directory-trust',
      message:'请在右侧终端确认是否信任当前项目目录',
    });
  } finally {
    await terminal.close();
  }
});
