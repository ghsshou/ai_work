import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runtimeCommand } from '../runtime-command.mjs';
import { runtimeFixture } from './runtime-fixture.mjs';

async function exercise(t, executable, electron) {
  const runtime = await runtimeFixture(t);
  const project = join(runtime.root, "资料 O'Brien & project");
  await mkdir(project);
  const wrapper = join(project, 'runtime-run.mjs');
  for (const name of ['runtime-run.mjs', 'runtime-env.mjs']) {
    await copyFile(new URL('../' + name, import.meta.url), join(project, name));
  }
  await writeFile(join(project, 'probe.mjs'), `console.log(JSON.stringify({cwd:process.cwd(),node:process.execPath,python:process.env.PYTHON,mode:process.env.ELECTRON_RUN_AS_NODE}));process.exit(Number(process.argv[2]));`);
  const command = runtimeCommand(runtime, { executable, electron, wrapper });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let result;
  if (process.platform === 'win32') {
    const script = join(project, 'probe.ps1');
    // PowerShell 5 使用 UTF-8 BOM 读取中文脚本。
    await writeFile(script, '\ufeff' + `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n${command} node ./probe.mjs 7\n$aicoPptExit = $LASTEXITCODE\nif (Test-Path Env:ELECTRON_RUN_AS_NODE) { throw '调用方环境未恢复' }\nexit $aicoPptExit\n`);
    result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { cwd:project, env, encoding:'utf8', timeout:30000 });
  } else {
    result = spawnSync('/bin/sh', ['-c', `${command} node ./probe.mjs 7`], { cwd:project, env, encoding:'utf8', timeout:30000 });
  }
  assert.equal(result.status, 7, JSON.stringify({stderr:result.stderr,stdout:result.stdout,error:String(result.error)}));
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    cwd:project, node:executable, python:runtime.paths.python, ...(electron ? { mode:'1' } : {}),
  });
}

test('模型命令在无描述文件、中文和引号目录中首次启动并传回脚本退出码', t => exercise(t, process.execPath, false));
test('Windows Electron 模型命令从未设置 Node 模式的 PowerShell 首次启动并恢复调用方环境', {
  skip:process.platform !== 'win32' || !process.env.AICO_ELECTRON_EXECUTABLE,
}, t => exercise(t, process.env.AICO_ELECTRON_EXECUTABLE, true));
