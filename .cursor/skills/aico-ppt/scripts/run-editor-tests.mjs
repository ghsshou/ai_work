#!/usr/bin/env node
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const testDir = resolve(root, 'scripts/editor/test');
const mode = process.argv[2] ?? 'all';
const allowed = new Set(['unit', 'e2e', 'python', 'all']);
if (!allowed.has(mode)) {
  console.error('用法：node scripts/run-editor-tests.mjs unit|e2e|python|all');
  process.exit(2);
}

function run(command, args) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'aico-ppt-editor-test-state-'));
  let result;
  try {
    result = spawnSync(command, args, {
      cwd:root,
      env:{ ...process.env, AICO_PPT_EDITOR_STATE_ROOT:stateRoot },
      stdio:'inherit',
      shell:false,
    });
  } finally {
    rmSync(stateRoot, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  }
  if (result.error) {
    console.error(`无法启动 ${command}：${result.error.message}`);
    process.exit(result.error.code === 'ENOENT' ? 2 : 1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const files = readdirSync(testDir).sort();
if (mode === 'unit' || mode === 'all') {
  const unit = files.filter(name => name.endsWith('.test.mjs'))
    .map(name => resolve(testDir, name));
  const concurrency = process.platform === 'win32' ? ['--test-concurrency=1'] : [];
  run(process.execPath, ['--test', ...concurrency, ...unit]);
}
if (mode === 'e2e' || mode === 'all') {
  const e2e = files.filter(name => name.endsWith('.e2e.mjs'))
    .map(name => resolve(testDir, name));
  run(process.execPath, ['--test', '--test-concurrency=1', ...e2e]);
}
if (mode === 'python' || mode === 'all') {
  const command = process.env.PYTHON
    || (process.platform === 'win32' ? 'py' : 'python3');
  const prefix = process.platform === 'win32' && !process.env.PYTHON ? ['-3'] : [];
  run(command, [
    ...prefix, '-m', 'unittest', 'discover', '-s', testDir, '-p', 'test_*.py', '-v',
  ]);
}
