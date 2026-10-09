/** 显式复制测试浏览器与 Python 目录到私有资源根，再执行真实图片 PPTX 导出。 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveRuntime } from '../runtime-env.mjs';

const run = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const browserSource = process.env.AICO_TEST_BROWSER_DIRECTORY;
const pythonDirectory = process.env.AICO_TEST_PYTHON_DIRECTORY;
const pythonSource = process.env.AICO_TEST_PYTHON_EXECUTABLE;
if (!browserSource || (!pythonDirectory && !pythonSource) || (pythonDirectory && pythonSource) || !['linux', 'win32'].includes(process.platform)) throw new Error('需要显式 Windows/Linux 测试浏览器目录，以及 Python 目录或可执行文件（二选一）');

test('私有浏览器经真实导出脚本生成两页图片 PPTX，不连接旧 Desktop 渲染通道', { timeout:180000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'aico-private-render-'));
  t.after(() => rm(root, { recursive:true, force:true, maxRetries:20, retryDelay:100 }));
  await cp(browserSource, join(root, 'browser'), { recursive:true });
  const windows = process.platform === 'win32';
  const python = join(root, windows ? 'python/python.exe' : 'python/bin/python3');
  if (pythonDirectory) await cp(pythonDirectory, join(root, 'python'), { recursive:true });
  else if (windows) await cp(dirname(pythonSource), join(root, 'python'), { recursive:true });
  else {
    await mkdir(dirname(python), { recursive:true });
    await copyFile(pythonSource, python);
  }
  const runtime = await resolveRuntime({ root, paths:{ python, browser:join(root, windows ? 'browser/chrome.exe' : 'browser/chrome') } }, {
    ...process.env, AICO_HOME:join(root, 'nonexistent-old-host'), AICO_BROWSER_EXECUTABLE:'/unusable-inherited-browser',
  });
  assert.equal(runtime.environment.AICO_HOME, undefined);
  const deck = join(root, '测试 deck.html');
  await writeFile(deck, (await readFile(join(source, 'scripts/editor/test/fixtures/minimal-deck.html'), 'utf8'))
    .replace('<script src="../../runtime/patch-runtime.js"></script>', ''));
  const output = join(root, '测试 export.pptx');
  await run(python, [join(source, 'scripts/html2pptx/convert.py'), deck, output, '--mode', 'image', '--scale', '1'], {
    cwd:root, env:runtime.environment, timeout:120000, maxBuffer:1024 * 1024,
  });
  const { stdout } = await run(python, ['-c', [
    'import json,sys,zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' names=z.namelist()',
    ' assert z.testzip() is None',
    ' print(json.dumps({"slides":[n for n in names if n.startswith("ppt/slides/slide") and n.endswith(".xml")],"images":[n for n in names if n.startswith("ppt/media/")]}))',
  ].join('\n'), output], { env:runtime.environment, timeout:10000 });
  const contents = JSON.parse(stdout);
  assert.equal(contents.slides.length, 2);
  assert.equal(contents.images.length, 2);
  t.diagnostic(`${process.platform} 私有浏览器与 Python 完成两页 PPTX；来源审计、归档安装、Desktop UI 和 WSL 切换由各自发布门禁验证`);
});
