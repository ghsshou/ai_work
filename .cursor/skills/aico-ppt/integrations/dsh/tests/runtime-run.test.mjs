import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runtimeFixture } from './runtime-fixture.mjs';

async function wrapperFixture(t) {
  const runtime = await runtimeFixture(t);
  const packageRoot = join(runtime.root, 'package');
  const integration = join(packageRoot, 'integrations', 'dsh');
  const project = join(runtime.root, '用户项目');
  await mkdir(integration, { recursive:true });
  await mkdir(project);
  for (const name of ['runtime-run.mjs', 'runtime-env.mjs']) {
    await copyFile(new URL('../' + name, import.meta.url), join(integration, name));
  }
  await writeFile(join(packageRoot, '.aico-runtime.json'), JSON.stringify(runtime));
  return { runtime, packageRoot, project, entry:join(integration, 'runtime-run.mjs') };
}

test('模型 Node 脚本复用 Host Node、调用方目录与私有环境，参数不经 shell 解释', async t => {
  const { runtime, project, entry } = await wrapperFixture(t);
  const code = 'console.log(JSON.stringify({node:process.execPath,cwd:process.cwd(),args:process.argv.slice(1),python:process.env.PYTHON,browser:process.env.AICO_BROWSER_EXECUTABLE,office:process.env.AICO_SOFFICE_EXECUTABLE,kind:process.env.AICO_RUNTIME_KIND,secret:process.env.AICO_PLUGIN_BRIDGE_TOKEN}))';
  const result = spawnSync(process.execPath, [entry, 'node', '-e', code, 'value & untouched'], {
    cwd:project, encoding:'utf8', env:{ ...process.env, PYTHON:'/other/python', AICO_SOFFICE_EXECUTABLE:'/old/soffice', AICO_PLUGIN_BRIDGE_TOKEN:'do-not-copy' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    node:process.execPath, cwd:project, args:['value & untouched'], python:runtime.paths.python,
    kind:'desktop',
  });
  const rejected = spawnSync(process.execPath, [entry, 'sh', '-c', 'exit 0'], { encoding:'utf8' });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /python3.*node/);
});

test('包装器保留 Node stdin 与非零退出码，不限制项目脚本', async t => {
  const { project, entry } = await wrapperFixture(t);
  const fromStdin = spawnSync(process.execPath, [entry, 'node', '-'], {
    cwd:project, input:'console.log("stdin-kept")', encoding:'utf8',
  });
  assert.equal(fromStdin.status, 0, fromStdin.stderr);
  assert.equal(fromStdin.stdout.trim(), 'stdin-kept');
  await writeFile(join(project, '用户脚本.mjs'), 'process.exit(7)');
  const script = spawnSync(process.execPath, [entry, 'node', '用户脚本.mjs'], { cwd:project, encoding:'utf8' });
  assert.equal(script.status, 7, script.stderr);
});

test('Python 包装器保留原有 heredoc 标准输入与项目目录', { skip:process.platform === 'win32' }, async t => {
  const python = spawnSync('python3', ['-c', 'import sys;print(sys.executable)'], { encoding:'utf8' });
  if (python.status !== 0) return t.skip('该宿主未提供用于测试的 Python');
  const { runtime, project, entry } = await wrapperFixture(t);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(runtime.paths.python, `#!/bin/sh\nexec ${quote(python.stdout.trim())} "$@"\n`, { mode:0o755 });
  const result = spawnSync(process.execPath, [entry, 'python3', '-'], {
    cwd:project, input:'import json, os\nprint(json.dumps({"cwd":os.getcwd(), "python":os.environ["PYTHON"]}))\n', encoding:'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cwd:project, python:runtime.paths.python });
});

test('显式运行时无效时拒绝执行，不回退包内有效描述', async t => {
  const { runtime, entry } = await wrapperFixture(t);
  const invalid = { ...runtime, paths:{ python:process.execPath } };
  const encoded = Buffer.from(JSON.stringify(invalid)).toString('base64url');
  const result = spawnSync(process.execPath, [entry, '--runtime-base64', encoded, 'node', '-e', 'console.log("不应执行")'], { encoding:'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /必须位于插件运行时目录内/);
  assert.equal(result.stdout, '');
});
