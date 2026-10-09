import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PREFIX_BYTES = 4 * 1024 * 1024;

function fail(message) {
  throw Object.assign(new Error(message), { code:'INVALID_WSL_CODEX_SESSION_REQUEST' });
}

function sessionDateParts(now = Date.now()) {
  const values = [];
  for (const offset of [-86_400_000, 0, 86_400_000]) {
    values.push(new Date(now + offset).toISOString().slice(0, 10).split('-'));
  }
  return values;
}

async function recentRollouts(codexHome, now = Date.now()) {
  const results = [];
  for (const parts of sessionDateParts(now)) {
    const directory = join(codexHome, 'sessions', ...parts);
    let entries;
    try { entries = await readdir(directory, { withFileTypes:true }); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
      const ids = entry.name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig);
      const id = ids?.at(-1) ?? null;
      if (id) results.push({ id, path:join(directory, entry.name) });
    }
  }
  return results;
}

async function filePrefix(path, limit = MAX_PREFIX_BYTES) {
  const handle = await open(path, 'r');
  try {
    const chunks = [];
    let offset = 0;
    while (offset < limit) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit - offset));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await handle.close();
  }
}

function sessionMeta(text) {
  const newline = text.indexOf('\n');
  try {
    const entry = JSON.parse(newline >= 0 ? text.slice(0, newline) : text);
    return entry?.type === 'session_meta' ? entry.payload : null;
  } catch { return null; }
}

async function listRollouts(codexHome) {
  const rows = await recentRollouts(codexHome);
  return { ids:[...new Set(rows.map(row => row.id))] };
}

async function findRollout(codexHome, discoveryToken, startedAtText, cwd, knownText = '[]') {
  if (!UUID.test(discoveryToken)) fail('Codex 会话发现标识无效');
  const startedAt = Date.parse(startedAtText);
  if (!Number.isFinite(startedAt)) fail('Codex 会话发现时间无效');
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || /[\0\r\n]/.test(cwd)) {
    fail('Codex 会话工作目录无效');
  }
  let knownValues;
  try { knownValues = JSON.parse(knownText); }
  catch { fail('Codex 已知会话列表不是合法 JSON'); }
  if (!Array.isArray(knownValues) || knownValues.some(value => !UUID.test(value))) {
    fail('Codex 已知会话列表无效');
  }
  const known = new Set(knownValues);
  const rollouts = await recentRollouts(codexHome, startedAt);
  for (const rollout of rollouts) {
    if (known.has(rollout.id)) continue;
    const text = await filePrefix(rollout.path);
    const meta = sessionMeta(text);
    const timestamp = Date.parse(meta?.timestamp ?? '');
    if (meta?.source !== 'cli' || !Number.isFinite(timestamp) || timestamp < startedAt - 2_000) continue;
    if (meta.cwd !== cwd || !text.includes(discoveryToken)) continue;
    return { conversationId:rollout.id };
  }
  return { conversationId:null };
}

async function main([operation, codexHome, ...args]) {
  if (typeof codexHome !== 'string' || !codexHome.startsWith('/') || /[\0\r\n]/.test(codexHome)) {
    fail('Codex HOME 无效');
  }
  if (operation === 'list-rollouts') return listRollouts(codexHome);
  if (operation === 'find-rollout') return findRollout(codexHome, ...args);
  fail(`不支持的 WSL Codex 会话操作：${String(operation)}`);
}

main(process.argv.slice(2)).then(
  result => process.stdout.write(`${JSON.stringify(result)}\n`),
  error => {
    process.stderr.write(`WSL Codex 会话 helper 失败：${error.message}\n`);
    process.exitCode = 2;
  },
);
