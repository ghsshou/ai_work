import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { resolveEditorStateRoot } from './editor-state-root.mjs';
import { withLegacyAicoPptEnvironment } from './environment-aliases.mjs';

const execFileAsync = promisify(execFile);
const EDITOR_DIR = resolve(fileURLToPath(import.meta.url), '..');
const PROJECT_DIR = resolve(EDITOR_DIR, '../..');
const PATH_ENVIRONMENT_KEYS = Object.freeze([
  'AICO_PPT_SOURCE_PATH',
  'AICO_PPT_WORKING_PATH',
  'AICO_PPT_CREATION_CONTEXT',
  'AICO_PPT_CREATION_MATERIALS',
  'AICO_PPT_CREATION_PLAN',
  'AICO_PPT_CREATION_CAPABILITY_FILE',
]);
const VALUE_ENVIRONMENT_KEYS = Object.freeze([
  'AICO_PPT_EDITOR_URL',
  'AICO_PPT_EDITOR_TOKEN',
  'AICO_PPT_CREATION_URL',
]);
const WSL_PROBE_SCRIPT = [
  'aico_ppt_codex="$(command -v codex)" || exit 127',
  'aico_ppt_node="$(command -v node)" || exit 127',
  'printf "AICO_PPT_CODEX=%s\\nAICO_PPT_NODE=%s\\nAICO_PPT_HOME=%s\\n"'
    + ' "$aico_ppt_codex" "$aico_ppt_node" "$HOME"',
].join('; ');
const WSL_RUNTIME_CACHE = new Map();
const WSL_RUNNER_IDS = new WeakMap();
let nextWslRunnerId = 1;

function runtimeError(code, message, cause = null) {
  return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
}

function normalizeSettings(value) {
  if (value === null || value === undefined) return { codexRuntime:'native' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw runtimeError('INVALID_AGENT_RUNTIME_SETTINGS', '本机 Agent 配置必须是 JSON 对象');
  }
  const codexRuntime = value.codexRuntime ?? 'native';
  if (!['native', 'wsl'].includes(codexRuntime)) {
    throw runtimeError('INVALID_AGENT_RUNTIME_SETTINGS', 'codexRuntime 只支持 native 或 wsl');
  }
  if (codexRuntime === 'native') return { codexRuntime:'native' };
  const distribution = value.wslDistribution;
  const user = value.wslUser;
  if (typeof distribution !== 'string' || !distribution.trim()
    || distribution.length > 128 || /[\0-\x1f\x7f]/.test(distribution)) {
    throw runtimeError('INVALID_AGENT_RUNTIME_SETTINGS', 'WSL 发行版名称无效');
  }
  if (typeof user !== 'string' || !/^[a-z_][a-z0-9_-]{0,63}$/i.test(user)) {
    throw runtimeError('INVALID_AGENT_RUNTIME_SETTINGS', 'WSL 用户名无效');
  }
  return {
    codexRuntime:'wsl',
    wslDistribution:distribution,
    wslUser:user,
  };
}

export function agentRuntimeSettingsPath({ environment = process.env } = {}) {
  return join(resolveEditorStateRoot({ environment }), 'settings.json');
}

export function loadAgentRuntimeSettings({
  environment = process.env,
  settingsPath = agentRuntimeSettingsPath({ environment }),
} = {}) {
  if (!existsSync(settingsPath)) return { codexRuntime:'native' };
  let value;
  try { value = JSON.parse(readFileSync(settingsPath, 'utf8')); }
  catch (error) {
    throw runtimeError(
      'INVALID_AGENT_RUNTIME_SETTINGS',
      `无法读取本机 Agent 配置 ${settingsPath}：${error.message}`,
      error,
    );
  }
  return normalizeSettings(value);
}

async function defaultRunWsl(args, {
  wslExecutable = 'wsl.exe',
  environment = process.env,
} = {}) {
  try {
    const { stdout } = await execFileAsync(wslExecutable, args, {
      env:environment,
      encoding:'utf8',
      timeout:10_000,
      maxBuffer:2 * 1024 * 1024,
      windowsHide:true,
    });
    return stdout;
  } catch (error) {
    throw runtimeError(
      error.code === 'ENOENT' ? 'WSL_NOT_FOUND' : 'WSL_COMMAND_FAILED',
      error.code === 'ENOENT'
        ? '找不到 wsl.exe，请先启用 Windows Subsystem for Linux'
        : `WSL Codex 环境检查失败：${String(error.stderr || error.message).trim()}`,
      error,
    );
  }
}

function outputLine(stdout, predicate, message) {
  const line = String(stdout ?? '').split(/\r?\n/).map(value => value.trim())
    .filter(Boolean).findLast(predicate);
  if (!line) throw runtimeError('WSL_CODEX_INVALID_OUTPUT', message);
  return line;
}

function appendWslenv(environment) {
  const additions = [];
  for (const key of VALUE_ENVIRONMENT_KEYS) {
    if (typeof environment[key] === 'string' && environment[key]) additions.push(key);
  }
  for (const key of PATH_ENVIRONMENT_KEYS) {
    if (typeof environment[key] === 'string' && environment[key]) additions.push(`${key}/p`);
  }
  const entries = String(environment.WSLENV ?? '').split(':').filter(Boolean);
  const known = new Set(entries.map(entry => entry.split('/')[0]));
  for (const entry of additions) {
    const key = entry.split('/')[0];
    if (!known.has(key)) {
      entries.push(entry);
      known.add(key);
    }
  }
  return entries.join(':');
}

function translatePrompt(text, mappings) {
  let translated = String(text);
  const ordered = [...mappings.entries()].sort((left, right) => right[0].length - left[0].length);
  for (const [windowsPath, wslPath] of ordered) {
    translated = translated.replaceAll(windowsPath, wslPath);
    translated = translated.replaceAll(windowsPath.replaceAll('\\', '/'), wslPath);
    // 根路径替换后，后续文件片段仍可能沿用 Windows 反斜杠。
    const escaped = wslPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    translated = translated.replace(
      new RegExp(`${escaped}[^\\s\\r\\n"'，。；：）】]*`, 'g'),
      value => value.replaceAll('\\', '/'),
    );
  }
  return translated;
}

function wslArguments(settings, ...tail) {
  return [
    '-d', settings.wslDistribution,
    '-u', settings.wslUser,
    ...tail,
  ];
}

function wslRunnerId(runWsl) {
  if (!WSL_RUNNER_IDS.has(runWsl)) WSL_RUNNER_IDS.set(runWsl, nextWslRunnerId++);
  return WSL_RUNNER_IDS.get(runWsl);
}

function wslRuntimeCache(settings, { runWsl, wslExecutable }) {
  const key = [
    wslExecutable,
    settings.wslDistribution,
    settings.wslUser,
    wslRunnerId(runWsl),
  ].join('\0');
  let entry = WSL_RUNTIME_CACHE.get(key);
  if (!entry) {
    entry = { probe:null, paths:new Map() };
    WSL_RUNTIME_CACHE.set(key, entry);
  }
  return entry;
}

async function probeWslRuntime(settings, callWsl, cacheEntry = null) {
  const execute = async () => {
    if (!cacheEntry) {
      const codexOutput = await callWsl(wslArguments(
        settings,
        '--exec', 'bash', '-lic', 'command -v codex',
      ));
      const nodeOutput = await callWsl(wslArguments(
        settings,
        '--exec', 'bash', '-lic', 'command -v node',
      ));
      const homeOutput = await callWsl(wslArguments(
        settings,
        '--exec', 'printenv', 'HOME',
      ));
      return {
        codexExecutable:outputLine(
          codexOutput,
          line => line.startsWith('/') && !/[\0\r\n]/.test(line),
          `WSL ${settings.wslDistribution}/${settings.wslUser} 的登录环境中找不到 codex`,
        ),
        nodeExecutable:outputLine(
          nodeOutput,
          line => line.startsWith('/') && !/[\0\r\n]/.test(line),
          `WSL ${settings.wslDistribution}/${settings.wslUser} 的登录环境中找不到 node`,
        ),
        wslHome:outputLine(
          homeOutput,
          line => line.startsWith('/') && !/[\0\r\n]/.test(line),
          '无法确定 WSL 用户 HOME',
        ),
      };
    }
    const output = await callWsl(wslArguments(
      settings,
      '--exec', 'bash', '-lic', WSL_PROBE_SCRIPT,
    ));
    const readTaggedPath = (tag, message) => outputLine(
      output,
      line => line.startsWith(tag)
        && line.slice(tag.length).startsWith('/')
        && !/[\0\r\n]/.test(line),
      message,
    ).slice(tag.length);
    return {
      codexExecutable:readTaggedPath(
        'AICO_PPT_CODEX=',
        `WSL ${settings.wslDistribution}/${settings.wslUser} 的登录环境中找不到 codex`,
      ),
      nodeExecutable:readTaggedPath(
        'AICO_PPT_NODE=',
        `WSL ${settings.wslDistribution}/${settings.wslUser} 的登录环境中找不到 node`,
      ),
      wslHome:readTaggedPath('AICO_PPT_HOME=', '无法确定 WSL 用户 HOME'),
    };
  };
  if (!cacheEntry) return execute();
  if (!cacheEntry.probe) {
    cacheEntry.probe = execute().catch(error => {
      cacheEntry.probe = null;
      throw error;
    });
  }
  return cacheEntry.probe;
}

async function mapWindowsPath(settings, windowsPath, callWsl, cacheEntry = null) {
  const execute = async () => {
    const stdout = await callWsl(wslArguments(
      settings,
      '--exec', 'wslpath', '-a', '-u', windowsPath,
    ));
    return outputLine(
      stdout,
      line => line.startsWith('/') && !/[\0\r\n]/.test(line),
      `无法把 Windows 路径转换为 WSL 路径：${windowsPath}`,
    );
  };
  if (!cacheEntry) return execute();
  let mapped = cacheEntry.paths.get(windowsPath);
  if (!mapped) {
    mapped = execute().catch(error => {
      cacheEntry.paths.delete(windowsPath);
      throw error;
    });
    cacheEntry.paths.set(windowsPath, mapped);
  }
  return mapped;
}

export async function prepareAgentTerminalRuntime(provider, {
  platform = process.platform,
  settings = loadAgentRuntimeSettings(),
  environment = process.env,
  projectRoot = process.cwd(),
  cwd = projectRoot,
  pathRoots = [PROJECT_DIR],
  runWsl = defaultRunWsl,
  wslExecutable = 'wsl.exe',
  cache = true,
  onPhase = () => {},
} = {}) {
  const normalized = normalizeSettings(settings);
  if (provider !== 'codex' || platform !== 'win32' || normalized.codexRuntime !== 'wsl') {
    return null;
  }
  if (typeof cache !== 'boolean') throw new TypeError('WSL runtime cache 必须是布尔值');
  if (typeof onPhase !== 'function') throw new TypeError('WSL runtime phase listener 必须是函数');
  onPhase('wsl-preparing', {
    distribution:normalized.wslDistribution,
    user:normalized.wslUser,
  });
  const callWsl = args => runWsl(args, { wslExecutable, environment });
  const cacheEntry = cache
    ? wslRuntimeCache(normalized, { runWsl, wslExecutable })
    : null;
  const { codexExecutable, nodeExecutable, wslHome } = await probeWslRuntime(
    normalized,
    callWsl,
    cacheEntry,
  );

  const candidates = new Set([projectRoot, cwd, ...pathRoots]);
  for (const key of PATH_ENVIRONMENT_KEYS) {
    if (typeof environment[key] === 'string' && environment[key]) candidates.add(environment[key]);
  }
  const mappings = new Map();
  await Promise.all([...candidates].map(async windowsPath => {
    if (typeof windowsPath !== 'string' || !win32.isAbsolute(windowsPath)) return;
    const mapped = await mapWindowsPath(normalized, windowsPath, callWsl, cacheEntry);
    mappings.set(windowsPath, mapped);
  }));
  const wslCwd = mappings.get(cwd);
  const wslProjectRoot = mappings.get(projectRoot);
  const wslEditorRoot = [...pathRoots].map(value => mappings.get(value)).find(Boolean);
  if (!wslCwd || !wslProjectRoot || !wslEditorRoot) {
    throw runtimeError('WSL_PATH_MAPPING_FAILED', 'WSL Codex 缺少项目目录或 Editor 路径映射');
  }
  const runtimeEnvironment = withLegacyAicoPptEnvironment({
    ...environment,
    AICO_PPT_CODEX_RUNTIME:'wsl',
    AICO_PPT_WSL_DISTRO:normalized.wslDistribution,
    AICO_PPT_WSL_USER:normalized.wslUser,
    AICO_PPT_WSL_NODE:nodeExecutable,
    AICO_PPT_WSL_CODEX_HOME:posix.join(wslHome, '.codex'),
    AICO_PPT_WSL_CWD:wslCwd,
    AICO_PPT_WSL_SESSION_HELPER:posix.join(
      wslEditorRoot,
      'scripts/editor/wsl-codex-session-helper.mjs',
    ),
  });
  runtimeEnvironment.WSLENV = appendWslenv(runtimeEnvironment);

  return {
    kind:'wsl',
    conversationCwd:wslCwd,
    projectRoot:wslProjectRoot,
    spawnCwd:cwd,
    environment:runtimeEnvironment,
    translateText:text => translatePrompt(text, mappings),
    wrapCommand:command => ({
      ...command,
      label:`Codex（WSL ${normalized.wslDistribution}/${normalized.wslUser}）`,
      executable:wslExecutable,
      args:[
        ...wslArguments(normalized),
        '--cd', wslCwd,
        // 实际 Codex 也必须进入该 WSL 用户的登录环境，才能继承其代理等配置。
        // CLI 与参数全部经位置参数传入，不拼接到 shell 命令字符串。
        '--exec', 'bash', '-lic', 'exec "$@"', 'aico-ppt-codex',
        codexExecutable,
        ...command.args,
      ],
    }),
  };
}

export function prewarmAgentTerminalRuntime(provider, options = {}) {
  return prepareAgentTerminalRuntime(provider, options);
}
