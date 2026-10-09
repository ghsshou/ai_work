import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HELPER = resolve('scripts/editor/wsl-codex-session-helper.mjs');

test('WSL helper 能在含空格和中文的工作目录中列出并发现 Codex rollout', async t => {
  const codexHome = await mkdtemp(join(tmpdir(), 'deck-wsl 会话-'));
  t.after(() => rm(codexHome, { recursive:true, force:true }));
  const [year, month, day] = new Date().toISOString().slice(0, 10).split('-');
  const directory = join(codexHome, 'sessions', year, month, day);
  await mkdir(directory, { recursive:true });
  const id = '019ff4b7-0622-7272-b0e2-394f6316b52c';
  const token = '019ff4b7-0622-7272-b0e2-394f6316b52a';
  const cwd = '/mnt/c/Users/测试 用户/演示 项目';
  const timestamp = new Date().toISOString();
  const meta = JSON.stringify({
    timestamp,
    type:'session_meta',
    payload:{ id, session_id:id, timestamp, cwd, source:'cli' },
  });
  await writeFile(join(directory, `rollout-now-${id}.jsonl`), `${meta}\n发现标识：${token}\n`);

  const listed = await execFileAsync(process.execPath, [HELPER, 'list-rollouts', codexHome]);
  assert.deepEqual(JSON.parse(listed.stdout), { ids:[id] });

  const found = await execFileAsync(process.execPath, [
    HELPER, 'find-rollout', codexHome, token,
    new Date(Date.now() - 100).toISOString(), cwd, '[]',
  ]);
  assert.deepEqual(JSON.parse(found.stdout), { conversationId:id });
});
