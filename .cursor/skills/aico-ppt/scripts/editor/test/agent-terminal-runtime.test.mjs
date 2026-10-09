import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  loadAgentRuntimeSettings,
  prewarmAgentTerminalRuntime,
  prepareAgentTerminalRuntime,
} from '../agent-terminal-runtime.mjs';

test('本机 Agent 配置严格读取 WSL Codex 目标，缺省保持 native', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aico-ppt-runtime-settings-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  const path = join(directory, 'settings.json');
  assert.deepEqual(loadAgentRuntimeSettings({ settingsPath:path }), {
    codexRuntime:'native',
  });
  await writeFile(path, JSON.stringify({
    codexRuntime:'wsl',
    wslDistribution:'Ubuntu-26.04',
    wslUser:'root',
  }));
  assert.deepEqual(loadAgentRuntimeSettings({ settingsPath:path }), {
    codexRuntime:'wsl',
    wslDistribution:'Ubuntu-26.04',
    wslUser:'root',
  });
  await writeFile(path, JSON.stringify({
    codexRuntime:'wsl',
    wslDistribution:'Ubuntu-26.04\n--exec',
    wslUser:'root',
  }));
  assert.throws(
    () => loadAgentRuntimeSettings({ settingsPath:path }),
    /WSL 发行版名称无效/,
  );
});

test('Windows WSL Codex 使用登录 PATH、wslpath、WSLENV 和固定参数启动', async () => {
  const projectRoot = String.raw`C:\Users\tester\workspace\AICO-PPT`;
  const cwd = String.raw`C:\Users\tester\workspace\Deck 项目`;
  const sourcePath = String.raw`C:\Users\tester\workspace\Deck 项目\演示.html`;
  const calls = [];
  const mappings = new Map([
    [projectRoot, '/mnt/c/Users/tester/workspace/AICO-PPT'],
    [cwd, '/mnt/c/Users/tester/workspace/Deck 项目'],
    [sourcePath, '/mnt/c/Users/tester/workspace/Deck 项目/演示.html'],
  ]);
  const runWsl = async args => {
    calls.push(args);
    if (args.includes('bash')) return args.at(-1) === 'command -v node'
      ? '[profile ready]\n/usr/bin/node\n'
      : '[profile ready]\n/usr/local/bin/codex\n';
    if (args.includes('printenv')) return '/root\n';
    if (args.includes('wslpath')) return `${mappings.get(args.at(-1))}\n`;
    throw new Error(`未覆盖的 WSL 调用：${JSON.stringify(args)}`);
  };
  const runtime = await prepareAgentTerminalRuntime('codex', {
    platform:'win32',
    settings:{
      codexRuntime:'wsl',
      wslDistribution:'Ubuntu-26.04',
      wslUser:'root',
    },
    environment:{
      PATH:String.raw`C:\Windows\System32`,
      WSLENV:'EXISTING_VALUE',
      AICO_PPT_EDITOR_URL:'http://127.0.0.1:45678',
      AICO_PPT_EDITOR_TOKEN:'secret',
      AICO_PPT_SOURCE_PATH:sourcePath,
    },
    projectRoot,
    cwd,
    pathRoots:[projectRoot],
    runWsl,
    wslExecutable:'wsl.exe',
    cache:false,
  });

  assert.equal(runtime.kind, 'wsl');
  assert.equal(runtime.conversationCwd, '/mnt/c/Users/tester/workspace/Deck 项目');
  assert.equal(runtime.environment.AICO_PPT_CODEX_RUNTIME, 'wsl');
  assert.equal(runtime.environment.AICO_PPT_WSL_CODEX_HOME, '/root/.codex');
  assert.equal(runtime.environment.AICO_PPT_WSL_NODE, '/usr/bin/node');
  assert.equal(
    runtime.environment.AICO_PPT_WSL_SESSION_HELPER,
    '/mnt/c/Users/tester/workspace/AICO-PPT/scripts/editor/wsl-codex-session-helper.mjs',
  );
  assert.match(runtime.environment.WSLENV, /(?:^|:)EXISTING_VALUE(?:$|:)/);
  assert.match(runtime.environment.WSLENV, /AICO_PPT_EDITOR_TOKEN/);
  assert.match(runtime.environment.WSLENV, /AICO_PPT_SOURCE_PATH\/p/);
  assert.equal(
    runtime.translateText(`项目：${cwd}\nCLI：${projectRoot}\\scripts\\editor\\cli.mjs`),
    '项目：/mnt/c/Users/tester/workspace/Deck 项目\n'
      + 'CLI：/mnt/c/Users/tester/workspace/AICO-PPT/scripts/editor/cli.mjs',
  );
  assert.deepEqual(runtime.wrapCommand({
    provider:'codex', label:'Codex', executable:'codex.cmd',
    args:['resume', '--dangerously-bypass-approvals-and-sandbox', 'thread-id'],
  }), {
    provider:'codex',
    label:'Codex（WSL Ubuntu-26.04/root）',
    executable:'wsl.exe',
    args:[
      '-d', 'Ubuntu-26.04', '-u', 'root',
      '--cd', '/mnt/c/Users/tester/workspace/Deck 项目',
      '--exec', 'bash', '-lic', 'exec "$@"', 'aico-ppt-codex',
      '/usr/local/bin/codex',
      'resume', '--dangerously-bypass-approvals-and-sandbox', 'thread-id',
    ],
  });
  assert.ok(calls.some(args => args.includes('bash') && args.includes('-lic')));
  assert.ok(calls.some(args => args.includes('wslpath') && args.at(-1) === cwd));
});

test('WSL 配置只作用于 Windows Codex，不改变其他 provider 与 macOS', async () => {
  const settings = {
    codexRuntime:'wsl', wslDistribution:'Ubuntu-26.04', wslUser:'root',
  };
  const base = {
    settings,
    environment:{},
    projectRoot:'/tmp/project',
    cwd:'/tmp/project',
    runWsl:async () => { throw new Error('不应调用 WSL'); },
  };
  assert.equal(await prepareAgentTerminalRuntime('codex', {
    ...base, platform:'darwin',
  }), null);
  assert.equal(await prepareAgentTerminalRuntime('claude-code', {
    ...base,
    platform:'win32',
    projectRoot:String.raw`C:\project`,
    cwd:String.raw`C:\project`,
  }), null);
});

test('WSL runtime 预热并缓存命令、HOME 与路径映射，后续会话不重复探测', async () => {
  const projectRoot = String.raw`C:\Users\tester\workspace\AICO-PPT`;
  const cwd = String.raw`C:\Users\tester\workspace\Deck 项目`;
  const sourcePath = String.raw`C:\Users\tester\workspace\Deck 项目\演示.html`;
  const calls = [];
  const mappings = new Map([
    [projectRoot, '/mnt/c/Users/tester/workspace/AICO-PPT'],
    [cwd, '/mnt/c/Users/tester/workspace/Deck 项目'],
    [sourcePath, '/mnt/c/Users/tester/workspace/Deck 项目/演示.html'],
  ]);
  const runWsl = async args => {
    calls.push(args);
    if (args.includes('bash') && args.includes('-lic')) {
      return 'AICO_PPT_CODEX=/usr/local/bin/codex\n'
        + 'AICO_PPT_NODE=/usr/bin/node\n'
        + 'AICO_PPT_HOME=/root\n';
    }
    if (args.includes('wslpath')) return `${mappings.get(args.at(-1))}\n`;
    throw new Error(`未覆盖的 WSL 调用：${JSON.stringify(args)}`);
  };
  const options = {
    platform:'win32',
    settings:{
      codexRuntime:'wsl', wslDistribution:'Ubuntu-26.04', wslUser:'root',
    },
    environment:{ AICO_PPT_SOURCE_PATH:sourcePath },
    projectRoot,
    cwd,
    pathRoots:[projectRoot],
    runWsl,
  };

  await prewarmAgentTerminalRuntime('codex', options);
  const afterPrewarm = calls.length;
  const runtime = await prepareAgentTerminalRuntime('codex', options);

  assert.equal(calls.length, afterPrewarm, '同一进程后续启动不应重复调用 wsl.exe');
  assert.equal(runtime.environment.AICO_PPT_WSL_NODE, '/usr/bin/node');
  assert.equal(runtime.environment.AICO_PPT_WSL_CODEX_HOME, '/root/.codex');
  assert.equal(runtime.conversationCwd, '/mnt/c/Users/tester/workspace/Deck 项目');
});
