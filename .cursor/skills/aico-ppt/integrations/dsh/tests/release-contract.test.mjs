import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('原装 DSH 发布契约携带私有 Python 和浏览器且不要求宿主渲染器', async () => {
  const release = JSON.parse(await readFile(new URL('../../../aico.release.json', import.meta.url), 'utf8'))
  assert.deepEqual(release.components, ['plugin', 'python', 'browser'])
  assert.equal(release.requires, undefined)
  assert.deepEqual(release.paths, {
    python:{ kind:'file', path:'python/python.exe' },
    browser:{ kind:'file', path:'browser/chrome.exe' },
  })
  assert.deepEqual(Object.keys(release.targets), ['win32-x64'])
  assert.deepEqual(release.targets['win32-x64'].paths, {
    python:{ kind:'file', path:'python/python.exe' },
    browser:{ kind:'file', path:'browser/chrome.exe' },
  })
})

test('桌面插件发布包携带 npm 运行依赖，不依赖安装时联网或独立终端依赖', async () => {
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const root = new URL('../../../', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const report = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: fileURLToPath(root), shell: process.platform === 'win32', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }))[0]
  const files = new Set(report.files.map(row => row.path))
  for (const name of Object.keys(manifest.dependencies)) {
    assert.ok(report.bundled.includes(name), `发布包未携带运行依赖：${name}`)
    assert.ok(files.has(`node_modules/${name}/package.json`), `发布包缺少依赖文件：${name}`)
  }
  assert.equal(manifest.optionalDependencies, undefined)
  for (const name of ['node-pty', '@xterm/xterm', '@xterm/headless', '@xterm/addon-serialize']) {
    assert.equal(report.bundled.includes(name), false, `桌面插件不应携带独立终端：${name}`)
  }
})
