import { randomUUID } from 'node:crypto';
import {
  lstat, mkdir, open, readFile, realpath, rename, stat, unlink,
} from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { syncDirectory } from './durable-fs.mjs';
import { resolveProjectStateRoot } from './state-paths.mjs';

function adapterError(code, statusCode, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code, statusCode });
}

function contains(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function inspectCreationDraftLock(lockPath, {
  now = () => new Date(),
  lockLeaseMs = 30_000,
  isProcessAlive = processIsAlive,
} = {}) {
  let handle;
  let info;
  try {
    handle = await open(lockPath, 'r');
    info = await handle.stat();
    if (!info.isFile()) return { locked:true, stale:false, unsafe:true };
    const raw = await handle.readFile('utf8');
    const lock = JSON.parse(raw);
    const heartbeat = new Date(lock.heartbeatAt ?? lock.startedAt).getTime();
    const current = now().getTime();
    const alive = isProcessAlive(lock.pid);
    const fresh = Number.isFinite(heartbeat) && Number.isFinite(current)
      && current - heartbeat <= lockLeaseMs;
    return {
      locked:alive && fresh,
      stale:!alive || !fresh,
      pid:lock.pid,
      token:typeof lock.token === 'string' ? lock.token : null,
      dev:String(info.dev),
      ino:String(info.ino),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { locked:false, stale:false };
    if (error instanceof SyntaxError && info?.isFile()) {
      // truncate 与心跳写入之间异常退出会留下空文件。短时间内仍按活锁保护，
      // 防止把正在写入的租约误删；超过租约后则允许按 inode 安全接管。
      const current = now().getTime();
      const fresh = Number.isFinite(current) && Number.isFinite(info.mtimeMs)
        && current - info.mtimeMs <= lockLeaseMs;
      return {
        locked:fresh,
        stale:!fresh,
        corrupt:true,
        dev:String(info.dev),
        ino:String(info.ino),
      };
    }
    return { locked:true, stale:false, unsafe:true };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function canonicalDirectory(path, field) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw adapterError('INVALID_CREATION_PROJECT', 400, `${field} 必须是绝对路径`);
  }
  const canonical = await realpath(path).catch(error => {
    throw adapterError('INVALID_CREATION_PROJECT', 400, `${field} 不存在`, error);
  });
  const info = await stat(canonical);
  if (!info.isDirectory()) throw adapterError('INVALID_CREATION_PROJECT', 400, `${field} 不是目录`);
  return canonical;
}

async function ensureOwnedDirectory(parent, name, { create = true } = {}) {
  const target = join(parent, name);
  if (create) await mkdir(target, { mode:0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  let info;
  try { info = await lstat(target); }
  catch (error) {
    throw adapterError('CREATION_DRAFT_NOT_FOUND', 404, `Draft 目录不存在：${name}`, error);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw adapterError('UNSAFE_CREATION_SIDECAR', 409, `不可信的 Draft 目录：${name}`);
  }
  const canonical = await realpath(target);
  if (!contains(parent, canonical)) {
    throw adapterError('UNSAFE_CREATION_SIDECAR', 409, `Draft 目录逃逸项目范围：${name}`);
  }
  return canonical;
}

const ARTIFACTS = Object.freeze({
  brief:'brief.json',
  outline:'outline.json',
  pagePlan:'page-plan.json',
  deck:'deck-ready.json',
});

function clone(value) {
  return structuredClone(value);
}

async function atomicJson(path, value, directory) {
  const temporary = join(directory, `.${basename(path)}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export class CreationDraftFileAdapter {
  static async create(options) { return CreationDraftFileAdapter.#initialize(options, true); }
  static async open(options) { return CreationDraftFileAdapter.#initialize(options, false); }

  static async #initialize({
    projectRoot,
    draftId,
    now = () => new Date(),
    lockLeaseMs = 30_000,
    heartbeatIntervalMs = 5_000,
    isProcessAlive = processIsAlive,
  } = {}, create) {
    if (typeof draftId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(draftId)) {
      throw adapterError('INVALID_CREATION_DRAFT_ID', 400, 'draftId 无效');
    }
    const root = await canonicalDirectory(projectRoot, '项目目录');
    const sidecar = await ensureOwnedDirectory(
      root, basename(resolveProjectStateRoot(root, {
        existingChild:['drafts', draftId],
      })), { create },
    );
    const drafts = await ensureOwnedDirectory(sidecar, 'drafts', { create });
    const draftDir = await ensureOwnedDirectory(drafts, draftId, { create });
    if (create) {
      await ensureOwnedDirectory(draftDir, 'materials');
      await ensureOwnedDirectory(draftDir, 'staging');
      await ensureOwnedDirectory(draftDir, 'diagnostics');
    }
    const lockPath = join(draftDir, 'active.lock');
    let lockHandle;
    const lockToken = randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        lockHandle = await open(lockPath, 'wx', 0o600);
        const timestamp = now().toISOString();
        await lockHandle.writeFile(`${JSON.stringify({
          version:1, token:lockToken, pid:process.pid,
          startedAt:timestamp, heartbeatAt:timestamp,
        })}\n`);
        await lockHandle.sync();
        break;
      } catch (error) {
        await lockHandle?.close().catch(() => {});
        lockHandle = null;
        if (error.code !== 'EEXIST') throw error;
        const current = await inspectCreationDraftLock(lockPath, {
          now, lockLeaseMs, isProcessAlive,
        });
        if (current.locked || !current.stale || attempt > 0) {
          throw adapterError('CREATION_DRAFT_LOCKED', 409, 'Creation Draft 已由另一服务占用', error);
        }
        const pathInfo = await lstat(lockPath).catch(() => null);
        if (!pathInfo || String(pathInfo.dev) !== current.dev || String(pathInfo.ino) !== current.ino) {
          throw adapterError('CREATION_DRAFT_LOCKED', 409, 'Creation Draft 锁在接管时发生变化', error);
        }
        await unlink(lockPath);
      }
    }
    return new CreationDraftFileAdapter({
      root, draftDir, lockPath, lockHandle, lockToken, now, heartbeatIntervalMs,
    });
  }

  constructor({
    root, draftDir, lockPath, lockHandle, lockToken, now, heartbeatIntervalMs,
  }) {
    this.projectRoot = root;
    this.draftDir = draftDir;
    this.stagingDir = join(draftDir, 'staging');
    this.diagnosticsDir = join(draftDir, 'diagnostics');
    this.path = join(draftDir, 'draft.json');
    this.lockPath = lockPath;
    this.lockHandle = lockHandle;
    this.lockToken = lockToken;
    this.now = now;
    this.closed = false;
    this.lastDraft = null;
    this.completedArtifacts = new Map();
    this.heartbeatTimer = setInterval(() => {
      void this.#heartbeat().catch(() => {});
    }, Math.max(1_000, heartbeatIntervalMs));
    this.heartbeatTimer.unref?.();
  }

  async #heartbeat() {
    if (this.closed || !this.lockHandle) return;
    const timestamp = this.now().toISOString();
    const value = `${JSON.stringify({
      version:1, token:this.lockToken, pid:process.pid,
      startedAt:this.startedAt ?? timestamp, heartbeatAt:timestamp,
    })}\n`;
    this.startedAt ??= timestamp;
    // 先覆盖完整心跳再收缩尾部，避免进程在 truncate 与 write 之间退出时
    // 留下 0 字节锁；即使写入中断，陈旧损坏锁也会在租约后自动回收。
    await this.lockHandle.write(value, 0, 'utf8');
    await this.lockHandle.truncate(Buffer.byteLength(value, 'utf8'));
    await this.lockHandle.sync();
  }

  async load() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      await this.#reconcileArtifacts(value);
      this.lastDraft = clone(value);
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) {
        throw adapterError('CREATION_DRAFT_CORRUPT', 500, 'draft.json 不是有效 JSON', error);
      }
      throw error;
    }
  }

  async save(value) {
    if (this.closed) throw adapterError('SERVICE_CLOSED', 503, 'Creation Draft Adapter 已关闭');
    const temporary = join(this.draftDir, `.draft-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await this.#reconcileArtifacts(value);
      await rename(temporary, this.path);
      await syncDirectory(this.draftDir);
      this.lastDraft = clone(value);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  artifactSnapshot() {
    const draft = this.lastDraft;
    const complete = key => this.completedArtifacts.has(key);
    const item = (key, fallbackState = 'pending') => {
      const artifact = this.completedArtifacts.get(key);
      return {
        state:artifact ? 'complete' : fallbackState,
        complete:Boolean(artifact),
        fileName:ARTIFACTS[key],
        path:join(this.draftDir, ARTIFACTS[key]),
        ...(artifact ? { artifact:clone(artifact) } : {}),
      };
    };
    if (!draft) {
      return Object.fromEntries(Object.keys(ARTIFACTS).map(key => [key, item(key)]));
    }
    const brief = item('brief', 'active');
    const outlineFallback = draft.outlineStatus === 'stale'
      ? 'stale' : complete('brief') ? 'active' : 'pending';
    const outline = item('outline', outlineFallback);
    const pagePlanFallback = draft.pagePlanStatus === 'stale'
      ? 'stale' : complete('outline') ? 'active' : 'pending';
    const pagePlan = item('pagePlan', pagePlanFallback);
    const generationStatus = draft.generation?.status;
    const deckFallback = generationStatus === 'failed' ? 'failed'
      : generationStatus === 'preparing' ? 'working'
        : complete('pagePlan') ? 'active' : 'pending';
    const deck = item('deck', deckFallback);
    return { brief, outline, pagePlan, deck };
  }

  previewDeckPath() {
    return this.completedArtifacts.get('deck')?.deckPath ?? null;
  }

  async #reconcileArtifacts(draft) {
    const desired = new Map();
    if (draft?.briefConfirmedRevision !== null && draft?.briefConfirmedRevision !== undefined) {
      desired.set('brief', {
        version:1, type:'brief', draftId:draft.draftId,
        revision:draft.briefConfirmedRevision, brief:clone(draft.brief),
      });
    }
    if (draft?.outlineStatus === 'confirmed' && draft?.outlineConfirmedRevision !== null) {
      desired.set('outline', {
        version:1, type:'outline', draftId:draft.draftId,
        revision:draft.outlineConfirmedRevision, outline:clone(draft.outline),
      });
    }
    if (draft?.pagePlanStatus === 'confirmed' && draft?.pagePlanConfirmedRevision !== null) {
      desired.set('pagePlan', {
        version:1, type:'page-plan', draftId:draft.draftId,
        revision:draft.pagePlanConfirmedRevision, pagePlan:clone(draft.pagePlan),
      });
    }
    const deckArtifact = await this.#deckArtifact(draft);
    if (deckArtifact) desired.set('deck', deckArtifact);

    for (const [key, fileName] of Object.entries(ARTIFACTS)) {
      const path = join(this.draftDir, fileName);
      const value = desired.get(key);
      if (value) {
        await atomicJson(path, value, this.draftDir);
        this.completedArtifacts.set(key, value);
      } else {
        await unlink(path).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
        this.completedArtifacts.delete(key);
      }
    }
  }

  async #deckArtifact(draft) {
    const generation = draft?.generation;
    if (!generation || !['editing', 'verifying', 'failed', 'published'].includes(generation.status)) return null;
    const candidate = generation.status === 'published' && generation.publishedDeck
      ? generation.publishedDeck
      : generation.stagingDeck;
    if (typeof candidate !== 'string' || !candidate) return null;
    const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(this.draftDir, candidate);
    const allowedRoot = isAbsolute(candidate) ? this.projectRoot : this.draftDir;
    if (!contains(allowedRoot, absolute)) return null;
    let info;
    try { info = await lstat(absolute); } catch { return null; }
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const canonical = await realpath(absolute).catch(() => null);
    if (!canonical || !contains(allowedRoot, canonical)) return null;
    const html = await readFile(canonical, 'utf8').catch(() => null);
    if (!html || !/<html\b/i.test(html)
      || !/<script\s+type=["']__bundler\/manifest["']>/.test(html)
      || !/<script\s+type=["']__bundler\/template["']>/.test(html)) {
      return null;
    }
    return {
      version:1, type:'deck-ready', draftId:draft.draftId,
      revision:draft.revision, status:generation.status, deckPath:canonical,
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    await this.lockHandle?.close().catch(() => {});
    this.lockHandle = null;
    const current = await readFile(this.lockPath, 'utf8').then(
      raw => JSON.parse(raw), () => null,
    ).catch(() => null);
    if (current?.token === this.lockToken) {
      await unlink(this.lockPath).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    await syncDirectory(this.draftDir).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
