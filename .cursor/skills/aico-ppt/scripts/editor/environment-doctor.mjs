import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPythonExecutable, pythonUtf8SpawnOptions } from './python-utf8.mjs';


const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));


export function runJsonProcess(command, args, {
  cwd = PROJECT_ROOT,
  spawnProcess = spawn,
  maximumBytes = 1024 * 1024,
} = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnProcess(command, args, pythonUtf8SpawnOptions({
      cwd, stdio:['ignore', 'pipe', 'pipe'],
    }));
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const collect = target => chunk => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        child.kill();
        reject(Object.assign(new Error('诊断输出超过安全上限'), { code:'DIAGNOSTIC_TOO_LARGE' }));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', reject);
    child.once('close', code => {
      const output = Buffer.concat(stdout).toString('utf8');
      let payload;
      try { payload = JSON.parse(output); }
      catch (error) {
        reject(Object.assign(new Error(
          Buffer.concat(stderr).toString('utf8').trim() || '诊断命令没有返回有效 JSON',
        ), { code:'DIAGNOSTIC_INVALID_OUTPUT', cause:error }));
        return;
      }
      if (![0, 1].includes(code)) {
        reject(Object.assign(new Error(payload.message || '诊断命令执行失败'), {
          code:payload.code || 'DIAGNOSTIC_FAILED', details:payload.details,
        }));
        return;
      }
      resolvePromise(payload);
    });
  });
}


export async function inspectEnvironment({
  pythonExecutable = defaultPythonExecutable(),
  profiles = ['full'],
  repair = false,
  runProcess = runJsonProcess,
  delivery = process.env.AICO_RUNTIME_KIND,
} = {}) {
  if (delivery === 'desktop') {
    if (repair) throw new Error('桌面版运行环境随插件提供，请在设置的插件页重新安装 AICO-PPT 插件。');
    profiles = profiles.includes('full') ? ['editor-core', 'verify', 'pptx-export', 'pptx-read', 'materials'] : profiles;
  }
  const args = [join(PROJECT_ROOT, 'scripts/check_deps.py')];
  for (const profile of profiles) args.push('--profile', profile);
  args.push(repair ? '--repair' : '--check-only', '--json');
  const result = await runProcess(pythonExecutable, args, { cwd:PROJECT_ROOT });
  return delivery === 'desktop' ? { ...result, delivery:'desktop' } : result;
}


export async function inspectInstallation({
  pythonExecutable = defaultPythonExecutable(),
  repair = false,
  adoptExisting = false,
  runProcess = runJsonProcess,
  delivery = process.env.AICO_RUNTIME_KIND,
} = {}) {
  if (delivery === 'desktop') {
    if (repair) throw new Error('桌面版 Skill 随插件更新，请在设置的插件页重新安装 AICO-PPT 插件。');
    await access(join(PROJECT_ROOT, 'SKILL.md'));
    return { delivery:'desktop', registrations:[{ host:'dsh', state:'ready', targetPath:PROJECT_ROOT }] };
  }
  const args = [
    join(PROJECT_ROOT, 'scripts/install.py'),
    repair ? 'repair' : 'inspect',
    '--skill-only', '--json',
  ];
  if (adoptExisting) args.push('--adopt-existing');
  return runProcess(pythonExecutable, args, { cwd:PROJECT_ROOT });
}
