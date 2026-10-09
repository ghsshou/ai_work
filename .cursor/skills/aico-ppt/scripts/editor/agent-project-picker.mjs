import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';

function pickerError(code, statusCode, message) {
  return Object.assign(new Error(message), { code, statusCode });
}

export function pickAgentProject({
  platform = process.platform,
  spawnProcess = spawn,
  timeoutMs = 5 * 60 * 1000,
} = {}) {
  if (platform !== 'darwin') {
    throw pickerError(
      'PROJECT_PICKER_UNAVAILABLE', 501,
      '当前系统暂不支持项目目录选择器，请先从已有会话项目中新建',
    );
  }
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawnProcess('/usr/bin/osascript', [
      '-', '选择或新建 Agent 项目目录',
    ], { stdio:['pipe', 'pipe', 'pipe'] });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(value);
    };
    const append = target => chunk => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 64 * 1024) {
        child.kill('SIGTERM');
        finish(pickerError('PROJECT_PICKER_FAILED', 500, '项目目录选择器输出过大'));
        return;
      }
      if (target === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', append('stdout'));
    child.stderr.on('data', append('stderr'));
    child.stdin.on('error', error => finish(pickerError(
      'PROJECT_PICKER_FAILED', 500, `无法启动项目目录选择器：${error.message}`,
    )));
    child.once('error', error => finish(pickerError(
      'PROJECT_PICKER_FAILED', 500, `无法打开项目目录选择器：${error.message}`,
    )));
    child.once('close', async code => {
      if (settled) return;
      if (code !== 0) {
        if (/cancel|取消|-128/i.test(stderr)) finish(null, null);
        else finish(pickerError(
          'PROJECT_PICKER_FAILED', 500,
          stderr.trim() || `项目目录选择器异常退出（code ${code}）`,
        ));
        return;
      }
      try {
        const selected = stdout.trim();
        const path = await realpath(selected.length > 1 ? selected.replace(/\/$/, '') : selected);
        if (!(await stat(path)).isDirectory()) throw new Error('选择结果不是目录');
        finish(null, path);
      } catch (error) {
        finish(pickerError(
          'PROJECT_PICKER_FAILED', 500, `项目目录不可用：${error.message}`,
        ));
      }
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(pickerError('PROJECT_PICKER_TIMEOUT', 504, '项目目录选择器等待超时'));
    }, timeoutMs);
    timer.unref?.();
    child.stdin.end([
      'on run argv',
      '  set pickedFolder to choose folder with prompt (item 1 of argv)',
      '  return POSIX path of pickedFolder',
      'end run',
    ].join('\n'));
  });
}
