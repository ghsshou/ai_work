import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPythonExecutable, pythonUtf8SpawnOptions } from './python-utf8.mjs';

const EDITOR_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(EDITOR_DIR, '../..');

function pickerError(message, code = 'PICK_FAILED') {
  return Object.assign(new Error(message), { code });
}

function pickPathWithSystemPicker({
  pythonExecutable = defaultPythonExecutable(),
  pickerFlag,
  resultKey,
  resultLabel,
  kind = pickerFlag === '--pick-only' ? 'deck' : 'directory',
  defaultPath,
  signal,
  spawnProcess = spawn,
  environment = process.env,
  fetchRequest = fetch,
} = {}) {
  if (environment.AICO_DESKTOP_DIALOG_URL) {
    return (async () => {
      const response = await fetchRequest(environment.AICO_DESKTOP_DIALOG_URL, {
        method:'POST', signal, redirect:'error',
        headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${environment.AICO_DESKTOP_DIALOG_TOKEN}` },
        body:JSON.stringify({ kind, defaultPath }),
      });
      const result = await response.json();
      if (!response.ok && kind === 'pptx' && result.error === 'Invalid picker') {
        throw pickerError('当前 AICO 桌面版本不支持 PPTX 保存窗口，请更新桌面应用');
      }
      if (!response.ok) throw pickerError(result.error || '原生文件选择器不可用');
      if (result.path !== null && (typeof result.path !== 'string' || !result.path)) throw pickerError('原生文件选择器返回路径无效');
      return result.path;
    })();
  }
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(pickerError('文件选择器已取消', 'PICK_ABORTED'));
      return;
    }
    const child = spawnProcess(
      pythonExecutable,
      [join(PROJECT_DIR, 'scripts/deck-editor.py'), pickerFlag, ...(defaultPath ? ['--default-path', defaultPath] : [])],
      pythonUtf8SpawnOptions({ cwd:PROJECT_DIR, stdio:['ignore', 'pipe', 'pipe'] }),
    );
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const settle = (method, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abortPicker);
      method(value);
    };
    const abortPicker = () => {
      try { child.kill(); } catch { /* Promise 仍必须立即收敛。 */ }
      settle(reject, pickerError('文件选择器已取消', 'PICK_ABORTED'));
    };
    signal?.addEventListener('abort', abortPicker, { once:true });
    const collect = target => chunk => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) {
        child.kill();
        settle(reject, pickerError('文件选择器返回内容过大'));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', error => settle(reject, error));
    child.once('close', code => {
      if (code === 3) {
        settle(resolvePromise, null);
        return;
      }
      if (code !== 0) {
        settle(reject, pickerError(
          Buffer.concat(stderr).toString('utf8').trim() || '系统文件选择器异常退出',
        ));
        return;
      }
      try {
        const payload = JSON.parse(Buffer.concat(stdout).toString('utf8'));
        if (typeof payload[resultKey] !== 'string' || !payload[resultKey]) {
          throw new Error(`缺少 ${resultKey}`);
        }
        settle(resolvePromise, payload[resultKey]);
      } catch (error) {
        settle(reject, pickerError(`无法解析${resultLabel}选择结果：${error.message}`));
      }
    });
  });
}

export function pickDeckWithSystemPicker(options = {}) {
  return pickPathWithSystemPicker({
    ...options,
    pickerFlag:'--pick-only',
    resultKey:'deckPath',
    resultLabel:'文件',
  });
}

export function pickProjectDirectoryWithSystemPicker(options = {}) {
  return pickPathWithSystemPicker({
    ...options,
    pickerFlag:'--pick-directory-only',
    resultKey:'directoryPath',
    resultLabel:'目录',
  });
}

export function pickPptxSaveWithSystemPicker(options = {}) {
  return pickPathWithSystemPicker({
    ...options, kind:'pptx', pickerFlag:'--save-pptx-only',
    resultKey:'savePath', resultLabel:'保存位置',
  });
}
