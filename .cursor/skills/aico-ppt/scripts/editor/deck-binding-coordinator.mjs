import { createHash } from 'node:crypto';
import { watch as watchFileSystem } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { PROJECT_STATE_DIRECTORIES } from './state-paths.mjs';

const HTML_EXTENSIONS = new Set(['.html', '.htm']);
const IGNORED_DIRECTORIES = new Set([
  '.git', ...PROJECT_STATE_DIRECTORIES, 'node_modules',
]);

function bindingError(code, statusCode, message, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

function isHtmlPath(value) {
  return typeof value === 'string' && HTML_EXTENSIONS.has(extname(value).toLowerCase());
}

function witnessEquals(left, right) {
  if (!left || !right || left.platform !== right.platform) return false;
  if (left.platform === 'windows') {
    return left.volumeSerial === right.volumeSerial && left.fileId === right.fileId;
  }
  return left.device === right.device && left.inode === right.inode;
}

function bigintString(value) {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

async function fingerprintFile(filePath) {
  return 'sha256:' + createHash('sha256').update(await readFile(filePath)).digest('hex');
}

class NodeDeckFileAdapter {
  constructor({ platform = process.platform } = {}) {
    this.platform = platform;
  }

  normalize(value) { return resolve(value); }
  dirname(value) { return dirname(value); }
  basename(value) { return basename(value); }

  isWithin(root, candidate) {
    const pathFromRoot = relative(this.normalize(root), this.normalize(candidate));
    return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
  }

  async inspect(filePath) {
    let info;
    try {
      info = await lstat(filePath, { bigint:true });
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists:false };
      throw error;
    }
    if (info.isSymbolicLink()) {
      return { exists:true, valid:false, reason:'symbolic-link' };
    }
    if (!info.isFile()) return { exists:true, valid:false, reason:'not-file' };
    if (!isHtmlPath(filePath)) {
      return { exists:true, valid:false, reason:'unsupported-file-type' };
    }
    const witness = this.platform === 'win32'
      ? {
          platform:'windows',
          volumeSerial:bigintString(info.dev),
          fileId:bigintString(info.ino),
          creationTime:info.birthtimeNs === undefined ? null : bigintString(info.birthtimeNs),
        }
      : {
          platform:'posix',
          device:bigintString(info.dev),
          inode:bigintString(info.ino),
          birthtimeNs:info.birthtimeNs === undefined ? null : bigintString(info.birthtimeNs),
        };
    return {
      exists:true,
      valid:true,
      witness,
      fingerprint:await fingerprintFile(filePath),
    };
  }

  async listHtmlFiles(directoryPath) {
    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes:true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter(entry => entry.isFile() && isHtmlPath(entry.name))
      .map(entry => resolve(directoryPath, entry.name));
  }

  async findHtmlFiles(root, { maximumEntries = 10_000 } = {}) {
    const matches = [];
    const queue = [this.normalize(root)];
    let visited = 0;
    while (queue.length && visited < maximumEntries) {
      const current = queue.shift();
      let entries;
      try {
        entries = await readdir(current, { withFileTypes:true });
      } catch (error) {
        if (['ENOENT', 'EACCES', 'EPERM'].includes(error?.code)) continue;
        throw error;
      }
      for (const entry of entries) {
        visited += 1;
        if (visited > maximumEntries) break;
        const candidate = resolve(current, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
            queue.push(candidate);
          }
        } else if (entry.isFile() && isHtmlPath(entry.name)) {
          matches.push(candidate);
        }
      }
    }
    return matches;
  }

  watchDirectory(directoryPath, onPossibleChange) {
    const watcher = watchFileSystem(directoryPath, { persistent:false }, () => onPossibleChange());
    watcher.on('error', () => onPossibleChange());
    return watcher;
  }
}

function publicSnapshot(binding) {
  return structuredClone({
    ...binding,
    canPublish:binding.state === 'bound',
  });
}

class DeckBindingCoordinator {
  constructor({
    deckId, binding, fileAdapter, onChange, onBeforeRebind, watch, pollIntervalMs,
  }) {
    this.deckId = deckId;
    this.binding = binding;
    this.fileAdapter = fileAdapter;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.onBeforeRebind = typeof onBeforeRebind === 'function'
      ? onBeforeRebind : async () => {};
    this.watchEnabled = watch;
    this.pollIntervalMs = pollIntervalMs;
    this.closed = false;
    this.queue = Promise.resolve();
    this.watcher = null;
    this.debounceTimer = null;
    this.pollTimer = null;
  }

  snapshot() { return publicSnapshot({ deckId:this.deckId, ...this.binding }); }

  #commit(patch) {
    const current = JSON.stringify(this.binding);
    const candidate = { ...this.binding, ...patch };
    if (JSON.stringify(candidate) === current) return this.snapshot();
    this.binding = { ...candidate, revision:this.binding.revision + 1 };
    const snapshot = this.snapshot();
    this.onChange({ type:'deck-binding-changed', revision:snapshot.revision, binding:snapshot });
    return snapshot;
  }

  async #candidatePaths() {
    const currentDirectory = this.fileAdapter.dirname(this.binding.currentPath);
    const direct = await this.fileAdapter.listHtmlFiles(currentDirectory);
    const trusted = this.fileAdapter.normalize(this.binding.trustedRoot);
    const nested = trusted === this.fileAdapter.normalize(currentDirectory)
      ? [] : await this.fileAdapter.findHtmlFiles(trusted);
    return [...new Set([...direct, ...nested].map(value => this.fileAdapter.normalize(value)))];
  }

  async #reconcile() {
    if (this.closed) throw bindingError('DECK_BINDING_CLOSED', 410, 'Deck 文件绑定已关闭');
    let current;
    try {
      current = await this.fileAdapter.inspect(this.binding.currentPath);
    } catch (error) {
      if (['EACCES', 'EPERM'].includes(error?.code)) {
        return this.#commit({ state:'needs-rebind', reason:'permission-denied' });
      }
      throw error;
    }
    if (current.exists) {
      if (!current.valid) {
        return this.#commit({
          state:'conflict',
          reason:current.reason === 'unsupported-file-type'
            ? 'unsupported-file-type' : 'replaced',
          pendingCandidates:[],
        });
      }
      if (witnessEquals(current.witness, this.binding.witness)) {
        if (this.binding.state === 'bound') return this.snapshot();
        return this.#commit({
          state:'bound', reason:'none', pendingCandidates:[],
          observedSourceFingerprint:current.fingerprint,
        });
      }
      return this.#commit({ state:'conflict', reason:'replaced', pendingCandidates:[] });
    }

    const sameWitness = [];
    const verifiedCopies = [];
    for (const candidatePath of await this.#candidatePaths()) {
      const candidate = await this.fileAdapter.inspect(candidatePath).catch(() => ({ exists:false }));
      if (!candidate.exists || !candidate.valid) continue;
      if (witnessEquals(candidate.witness, this.binding.witness)) {
        sameWitness.push({ path:candidatePath, candidate });
      } else if (candidate.fingerprint === this.binding.sourceFingerprint) {
        verifiedCopies.push(candidatePath);
      }
    }
    if (sameWitness.length === 1) {
      const match = sameWitness[0];
      const oldPath = this.binding.currentPath;
      const nextReason = this.fileAdapter.dirname(oldPath) === this.fileAdapter.dirname(match.path)
        ? 'renamed' : 'moved';
      const nextBinding = {
        state:'bound',
        reason:nextReason,
        currentPath:match.path,
        previousPath:oldPath,
        witness:match.candidate.witness,
        observedSourceFingerprint:match.candidate.fingerprint,
        pendingCandidates:[],
      };
      await this.onBeforeRebind({
        deckId:this.deckId,
        previousPath:oldPath,
        nextPath:match.path,
        witness:match.candidate.witness,
        reason:nextReason,
      });
      const snapshot = this.#commit(nextBinding);
      this.#restartWatcher();
      return snapshot;
    }
    if (sameWitness.length > 1) {
      return this.#commit({
        state:'conflict', reason:'ambiguous',
        pendingCandidates:sameWitness.map(item => ({
          fileName:this.fileAdapter.basename(item.path), path:item.path, match:'same-file',
        })),
      });
    }
    return this.#commit({
      state:'needs-rebind', reason:'missing',
      pendingCandidates:verifiedCopies.map(path => ({
        fileName:this.fileAdapter.basename(path), path, match:'verified-copy',
      })),
    });
  }

  reconcile() {
    const operation = this.queue.then(() => this.#reconcile());
    this.queue = operation.catch(() => {});
    return operation;
  }

  rebind({ candidatePath, expectedBindingRevision, confirmation }) {
    const operation = this.queue.then(async () => {
      if (this.closed) throw bindingError('DECK_BINDING_CLOSED', 410, 'Deck 文件绑定已关闭');
      if (expectedBindingRevision !== this.binding.revision) {
        throw bindingError(
          'DECK_BINDING_REVISION_CONFLICT', 409, '文件绑定已更新，请刷新后重试',
          { binding:this.snapshot() },
        );
      }
      const normalized = this.fileAdapter.normalize(candidatePath);
      if (!this.fileAdapter.isWithin(this.binding.trustedRoot, normalized)) {
        throw bindingError('DECK_BINDING_OUTSIDE_TRUSTED_ROOT', 409, '候选文件不在可信项目目录内');
      }
      const candidate = await this.fileAdapter.inspect(normalized);
      if (!candidate.exists || !candidate.valid) {
        throw bindingError('DECK_BINDING_INVALID_CANDIDATE', 422, '请选择普通 HTML 文件');
      }
      if (confirmation === 'same-file') {
        if (!witnessEquals(candidate.witness, this.binding.witness)) {
          if (candidate.fingerprint === this.binding.sourceFingerprint) {
            throw bindingError(
              'DECK_BINDING_VERIFIED_COPY_CONFIRMATION_REQUIRED',
              409,
              '所选文件是内容一致的副本，需要明确确认后才能重新绑定',
              { binding:this.snapshot(), candidate:normalized },
            );
          }
          throw bindingError('DECK_BINDING_WITNESS_MISMATCH', 409, '所选文件不是原来的物理文件');
        }
      } else if (confirmation === 'verified-copy') {
        if (candidate.fingerprint !== this.binding.sourceFingerprint) {
          throw bindingError('DECK_BINDING_FINGERPRINT_MISMATCH', 409, '所选文件内容与最后源版本不一致');
        }
      } else {
        throw bindingError('DECK_BINDING_INVALID_CONFIRMATION', 400, '重新绑定确认类型无效');
      }
      const oldPath = this.binding.currentPath;
      await this.onBeforeRebind({
        deckId:this.deckId,
        previousPath:oldPath,
        nextPath:normalized,
        witness:candidate.witness,
        reason:'manual-rebound',
      });
      const snapshot = this.#commit({
        state:'bound', reason:'manual-rebound',
        currentPath:normalized, previousPath:oldPath,
        witness:candidate.witness,
        sourceFingerprint:candidate.fingerprint,
        observedSourceFingerprint:candidate.fingerprint,
        pendingCandidates:[],
      });
      this.#restartWatcher();
      return snapshot;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  acceptPublishedFile({ expectedPath, expectedFingerprint }) {
    const operation = this.queue.then(async () => {
      if (this.closed) throw bindingError('DECK_BINDING_CLOSED', 410, 'Deck 文件绑定已关闭');
      const normalized = this.fileAdapter.normalize(expectedPath);
      if (normalized !== this.binding.currentPath) {
        throw bindingError(
          'DECK_BINDING_PATH_CHANGED', 409,
          '固化期间 Deck 文件路径已变化，拒绝接受新的文件见证',
          { binding:this.snapshot() },
        );
      }
      const current = await this.fileAdapter.inspect(normalized);
      if (!current.exists || !current.valid || current.fingerprint !== expectedFingerprint) {
        throw bindingError(
          'DECK_BINDING_PUBLISH_MISMATCH', 409,
          '固化结果与预期文件不一致，文件绑定保持冻结',
          { binding:this.snapshot() },
        );
      }
      return this.#commit({
        state:'bound', reason:'none', pendingCandidates:[],
        witness:current.witness,
        sourceFingerprint:current.fingerprint,
        observedSourceFingerprint:current.fingerprint,
      });
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  recoverPublishedCheckpoint({
    expectedPath, expectedFingerprint, expectedBindingRevision,
  }) {
    const operation = this.queue.then(async () => {
      if (this.closed) throw bindingError('DECK_BINDING_CLOSED', 410, 'Deck 文件绑定已关闭');
      if (expectedBindingRevision !== this.binding.revision) {
        throw bindingError(
          'DECK_BINDING_REVISION_CONFLICT', 409, '文件绑定已更新，请刷新后重试',
          { binding:this.snapshot() },
        );
      }
      if (this.binding.state !== 'conflict' || this.binding.reason !== 'replaced') {
        throw bindingError(
          'DECK_BINDING_RECOVERY_STATE_INVALID', 409,
          '只有被同路径文件替换的绑定才能按固化检查点恢复',
          { binding:this.snapshot() },
        );
      }
      const normalized = this.fileAdapter.normalize(expectedPath);
      if (normalized !== this.binding.currentPath) {
        throw bindingError(
          'DECK_BINDING_PATH_CHANGED', 409,
          '固化检查点对应的 Deck 路径已变化，拒绝恢复文件见证',
          { binding:this.snapshot() },
        );
      }
      const current = await this.fileAdapter.inspect(normalized);
      if (!current.exists || !current.valid || current.fingerprint !== expectedFingerprint) {
        throw bindingError(
          'DECK_BINDING_CHECKPOINT_MISMATCH', 409,
          '当前 Deck 与最近成功固化检查点不一致，文件绑定保持冻结',
          { binding:this.snapshot() },
        );
      }
      return this.#commit({
        state:'bound', reason:'recovered-published-checkpoint', pendingCandidates:[],
        witness:current.witness,
        sourceFingerprint:current.fingerprint,
        observedSourceFingerprint:current.fingerprint,
      });
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  #scheduleReconcile() {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.reconcile().catch(() => {}), 200);
    this.debounceTimer.unref?.();
  }

  #restartWatcher() {
    if (!this.watchEnabled || this.closed) return;
    this.watcher?.close?.();
    this.watcher = this.fileAdapter.watchDirectory(
      this.fileAdapter.dirname(this.binding.currentPath),
      () => this.#scheduleReconcile(),
    );
  }

  start() {
    this.#restartWatcher();
    if (this.watchEnabled && this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => void this.reconcile().catch(() => {}), this.pollIntervalMs);
      this.pollTimer.unref?.();
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.debounceTimer);
    clearInterval(this.pollTimer);
    this.watcher?.close?.();
    await this.queue;
  }
}

export async function openDeckBinding({
  deckId,
  initialBinding,
  storageRoot,
  onChange,
  onBeforeRebind,
  fileAdapter = new NodeDeckFileAdapter(),
  watch = true,
  pollIntervalMs = 2_000,
} = {}) {
  if (typeof deckId !== 'string' || !deckId) {
    throw new TypeError('deckId 不能为空');
  }
  if (!initialBinding || typeof initialBinding.currentPath !== 'string'
    || typeof initialBinding.trustedRoot !== 'string') {
    throw new TypeError('initialBinding 必须包含 currentPath 和 trustedRoot');
  }
  if (typeof storageRoot !== 'string' || !storageRoot) {
    throw new TypeError('storageRoot 不能为空');
  }
  const currentPath = fileAdapter.normalize(initialBinding.currentPath);
  const trustedRoot = fileAdapter.normalize(initialBinding.trustedRoot);
  if (!fileAdapter.isWithin(trustedRoot, currentPath)) {
    throw bindingError('DECK_BINDING_OUTSIDE_TRUSTED_ROOT', 409, 'Deck 不在可信项目目录内');
  }
  const current = await fileAdapter.inspect(currentPath);
  const hasPersistedIdentity = initialBinding.witness && initialBinding.sourceFingerprint;
  if ((!current.exists || !current.valid) && !hasPersistedIdentity) {
    throw bindingError('DECK_BINDING_INVALID_SOURCE', 422, 'Deck 源文件必须是普通 HTML 文件');
  }
  const expectedWitness = initialBinding.witness ?? current.witness;
  const matched = Boolean(current.exists && current.valid
    && witnessEquals(expectedWitness, current.witness));
  const coordinator = new DeckBindingCoordinator({
    deckId,
    fileAdapter,
    onChange,
    onBeforeRebind,
    watch,
    pollIntervalMs,
    binding:{
      revision:Number.isSafeInteger(initialBinding.revision) ? initialBinding.revision : 0,
      state:matched ? 'bound' : current.exists ? 'conflict' : 'needs-rebind',
      reason:matched ? (initialBinding.reason ?? 'none') : current.exists ? 'replaced' : 'missing',
      currentPath,
      previousPath:initialBinding.previousPath ?? null,
      trustedRoot,
      witness:expectedWitness,
      sourceFingerprint:initialBinding.sourceFingerprint ?? current.fingerprint,
      observedSourceFingerprint:current.fingerprint ?? null,
      pendingCandidates:[],
    },
  });
  coordinator.start();
  return coordinator;
}
