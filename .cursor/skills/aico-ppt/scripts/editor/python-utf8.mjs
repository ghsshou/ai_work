/**
 * Node 会把所有 Python helper 的 stdout / stderr 按 UTF-8 解码，因此启动
 * Python 时也必须固定相同编码，不能继承 Windows 控制台的 GBK/ACP。
 */
export function defaultPythonExecutable({
  platform=process.platform,
  environment=process.env,
} = {}) {
  const configured = environment?.PYTHON;
  if (typeof configured === 'string' && configured.trim()) return configured;
  return platform === 'win32' ? 'python.exe' : 'python3';
}

export function pythonUtf8Environment(environment = process.env) {
  return {
    ...environment,
    PYTHONUTF8:'1',
    PYTHONDONTWRITEBYTECODE:'1',
    PYTHONIOENCODING:'utf-8',
  };
}

export function pythonUtf8SpawnOptions(options = {}) {
  return {
    ...options,
    windowsHide:true,
    env:pythonUtf8Environment(options.env ?? process.env),
  };
}
