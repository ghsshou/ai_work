/** 桌面插件的显式工具路径与独立环境；不修改 Host 的 process.env。 */
import { realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';

function fields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))
    || allowed.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`${label} 字段无效`);
  }
}

function within(root, path) {
  const suffix = relative(root, path);
  return suffix !== '' && suffix !== '..' && !suffix.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(suffix);
}

async function absolutePath(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new Error(`${label} 必须是绝对路径`);
  }
  try { return await realpath(path); }
  catch (error) { throw new Error(`${label} 路径不存在或不可访问`, { cause:error }); }
}

/** 校验发布目录内的工具文件，并构造供 Worker 与脚本包装器共同使用的环境。 */
export async function resolveRuntime(runtime, inherited = process.env) {
  fields(runtime, ['root', 'paths'], 'aicoRuntime');
  const tools = Object.hasOwn(runtime.paths ?? {}, 'browser') ? ['python', 'browser'] : ['python'];
  fields(runtime.paths, tools, 'aicoRuntime.paths');
  const root = await absolutePath(runtime.root, '运行时根目录');
  if (!(await stat(root)).isDirectory()) throw new Error('运行时根目录必须是目录');
  const paths = {};
  for (const name of tools) {
    const path = await absolutePath(runtime.paths[name], name);
    if (!within(root, path)) throw new Error(`${name} 必须位于插件运行时目录内`);
    if (!(await stat(path)).isFile()) throw new Error(`${name} 必须是普通文件`);
    paths[name] = path;
  }
  const environment = {};
  for (const [key, value] of Object.entries(inherited)) {
    const upper = key.toUpperCase();
    if (upper === 'PATH' || /KEY|SECRET|TOKEN|PASSWORD/.test(upper)
      || /^(?:PYTHON|CONDA|VIRTUAL_ENV|PLAYWRIGHT|CHROME|CHROMIUM|NODE_|AICO_PLUGIN_BRIDGE_|AICO_DESKTOP_DIALOG_)/.test(upper)
      || ['AICO_NODE_EXECUTABLE', 'ELECTRON_RUN_AS_NODE', 'AICO_BROWSER_EXECUTABLE', 'AICO_SOFFICE_EXECUTABLE', 'AICO_RUNTIME_KIND', 'AICO_RUNTIME_ROOT', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES'].includes(upper)) continue;
    if (value !== undefined) environment[key] = value;
  }
  const systemRoot = inherited.SystemRoot || inherited.SYSTEMROOT || 'C:\\Windows';
  const systemPaths = process.platform === 'win32'
    ? [join(systemRoot, 'System32'), systemRoot]
    : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  environment.PATH = [...new Set([dirname(process.execPath), ...Object.values(paths).map(dirname), ...systemPaths])].join(delimiter);
  Object.assign(environment, {
    PYTHON:paths.python, PYTHONUTF8:'1', PYTHONIOENCODING:'utf-8', PYTHONNOUSERSITE:'1', PYTHONDONTWRITEBYTECODE:'1',
    AICO_RUNTIME_KIND:paths.browser ? 'plugin' : 'desktop',
    AICO_NODE_EXECUTABLE:process.execPath,
  });
  if (process.versions.electron) environment.ELECTRON_RUN_AS_NODE = '1';
  if (paths.browser) {
    environment.AICO_BROWSER_EXECUTABLE = paths.browser;
    delete environment.AICO_HOME;
  }
  return { root, paths, environment };
}
