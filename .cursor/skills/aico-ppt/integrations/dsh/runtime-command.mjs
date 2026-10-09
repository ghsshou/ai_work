/** 生成模型可执行的命令；配置随参数传入，Electron 模式仅作用于本次子进程。 */
import { fileURLToPath } from 'node:url';

export function runtimeCommand(runtime, {
  platform = process.platform,
  executable = process.execPath,
  electron = Boolean(process.versions.electron),
  wrapper = fileURLToPath(new URL('./runtime-run.mjs', import.meta.url)),
} = {}) {
  const windows = platform === 'win32';
  const quote = windows
    ? value => `'${value.replaceAll("'", "''")}'`
    : value => `'${value.replaceAll("'", "'\\''")}'`;
  const argv = [executable, wrapper, '--runtime-base64', Buffer.from(JSON.stringify({ root:runtime.root, paths:runtime.paths })).toString('base64url')];
  const command = argv.map(quote).join(' ');
  if (!electron) return `${windows ? '& ' : ''}${command}`;
  if (!windows) return `env ELECTRON_RUN_AS_NODE=1 ${command}`;
  // 用脚本块参数保留调用方脚本参数；finally 恢复 PowerShell 进程原有环境。
  return `& { $aicoPptPreviousMode = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE'); try { $env:ELECTRON_RUN_AS_NODE = '1'; & ${command} @args | ForEach-Object { $_ } } finally { [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $aicoPptPreviousMode); Set-Variable -Name LASTEXITCODE -Value $LASTEXITCODE -Scope 1 } }`;
}
