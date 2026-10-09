import { randomUUID } from 'node:crypto';
import {
  mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { createRecentDeckStore } from './recent-deck-store.mjs';
import { inspectCreationDraftLock } from './creation-draft-file-adapter.mjs';
import { isAgentProviderId } from './agent-provider-registry.mjs';
import { resolveEditorStateRoot } from './editor-state-root.mjs';
import {
  isProjectStateDirectoryName,
  resolveProjectStateRoot,
} from './state-paths.mjs';

const SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 12;
const DRAFT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/;

function emptyState() {
  return { version:SCHEMA_VERSION, creation:[], completedCreation:[], dismissedCreation:[] };
}

function contains(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function pointerKey(value) {
  return `${value.projectRoot}\0${value.draftId}`;
}

function creationProgress(draft) {
  const generation = draft.generation;
  if (draft.phase === 'ready' || generation?.status === 'published') return 'Deck 已生成';
  if (draft.phase === 'failed' || generation?.status === 'failed') return '生成失败，可继续修复';
  if (generation && ['preparing', 'editing', 'verifying'].includes(generation.status)) {
    return '正在制作 Deck';
  }
  if (draft.pagePlanStatus === 'confirmed' && draft.pagePlanConfirmedRevision !== null) {
    return '页面规划已确认';
  }
  if (draft.outlineStatus === 'confirmed' && draft.outlineConfirmedRevision !== null) {
    return '大纲已确认';
  }
  if (draft.briefConfirmedRevision !== null) return '需求已收敛';
  return draft.brief?.title ? '需求沟通中' : '等待开始对话';
}

export class WorkHistoryStore {
  constructor({
    filePath = join(resolveEditorStateRoot(), 'recent-work.json'),
    discoveryRoots = [],
    recentDeckStore = createRecentDeckStore({ discoveryRoots }),
    limit = DEFAULT_LIMIT,
    now = () => new Date(),
    lockLeaseMs = 30_000,
  } = {}) {
    this.filePath = resolve(filePath);
    this.discoveryRoots = discoveryRoots.map(root => resolve(root));
    this.recentDeckStore = recentDeckStore;
    this.limit = Math.max(1, Math.min(40, Number(limit) || DEFAULT_LIMIT));
    this.now = now;
    this.lockLeaseMs = lockLeaseMs;
  }

  async #read() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (parsed?.version !== SCHEMA_VERSION || !Array.isArray(parsed.creation)) return emptyState();
      return {
        ...parsed,
        completedCreation:Array.isArray(parsed.completedCreation) ? parsed.completedCreation : [],
        dismissedCreation:Array.isArray(parsed.dismissedCreation) ? parsed.dismissedCreation : [],
      };
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return emptyState();
      throw error;
    }
  }

  async #write(creation, completedCreation = [], dismissedCreation = []) {
    await mkdir(dirname(this.filePath), { recursive:true, mode:0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({
        version:SCHEMA_VERSION, creation, completedCreation, dismissedCreation,
      }, null, 2)}\n`, {
        encoding:'utf8', mode:0o600,
      });
      await rename(temporary, this.filePath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async #discover(root, depth = 0) {
    if (depth > 5) return [];
    let entries;
    try { entries = await readdir(root, { withFileTypes:true }); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) return [];
      throw error;
    }
    const found = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = join(root, entry.name);
      if (isProjectStateDirectoryName(entry.name)) {
        const canonicalRoot = await realpath(root).catch(() => root);
        const drafts = await readdir(join(child, 'drafts'), { withFileTypes:true }).catch(() => []);
        for (const draft of drafts) {
          if (draft.isDirectory() && !draft.isSymbolicLink() && DRAFT_ID_PATTERN.test(draft.name)) {
            found.push({ projectRoot:canonicalRoot, draftId:draft.name, lastOpenedAt:null });
          }
        }
        continue;
      }
      if (!entry.name.startsWith('.')) found.push(...await this.#discover(child, depth + 1));
    }
    return found;
  }

  async #inspectCreation(entry) {
    if (typeof entry?.projectRoot !== 'string' || !isAbsolute(entry.projectRoot)
      || typeof entry?.draftId !== 'string' || !DRAFT_ID_PATTERN.test(entry.draftId)) return null;
    try {
      const projectRoot = await realpath(entry.projectRoot);
      const rootInfo = await stat(projectRoot);
      if (!rootInfo.isDirectory()) return null;
      const draftDir = await realpath(join(
        resolveProjectStateRoot(projectRoot, {
          existingChild:['drafts', entry.draftId],
        }), 'drafts', entry.draftId,
      ));
      if (!contains(projectRoot, draftDir)) return null;
      const draftPath = join(draftDir, 'draft.json');
      const draft = JSON.parse(await readFile(draftPath, 'utf8'));
      const detail = await stat(draftPath);
      if (draft?.version !== 1 || draft.draftId !== entry.draftId
        || draft.projectRoot !== projectRoot || typeof draft.updatedAt !== 'string') return null;
      const locked = (await inspectCreationDraftLock(join(draftDir, 'active.lock'), {
        now:this.now,
        lockLeaseMs:this.lockLeaseMs,
      })).locked;
      const updatedAt = new Date(draft.updatedAt);
      const updatedAtMs = Number.isFinite(updatedAt.getTime())
        ? updatedAt.getTime() : detail.mtimeMs;
      return {
        kind:'creation',
        taskId:draft.draftId,
        draftId:draft.draftId,
        projectRoot,
        projectName:basename(projectRoot),
        title:draft.brief?.title?.trim() || '未命名 Deck',
        provider:isAgentProviderId(draft.provider) ? draft.provider : 'codex',
        phase:draft.phase,
        progress:creationProgress(draft),
        revision:draft.revision,
        updatedAt:new Date(updatedAtMs).toISOString(),
        updatedAtMs,
        lastOpenedAt:typeof entry.lastOpenedAt === 'string' ? entry.lastOpenedAt : null,
        locked,
      };
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code) || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async #creationCandidates() {
    const state = await this.#read();
    const discovered = (await Promise.all(
      this.discoveryRoots.map(root => this.#discover(root)),
    )).flat();
    const known = new Set(state.creation.map(pointerKey));
    const completed = new Set(state.completedCreation.map(pointerKey));
    const dismissed = new Set(state.dismissedCreation.map(pointerKey));
    return {
      state,
      candidates:[
        ...state.creation,
        ...discovered.filter(item => !known.has(pointerKey(item))
          && !completed.has(pointerKey(item))
          && !dismissed.has(pointerKey(item))),
      ],
    };
  }

  async listCreation() {
    const { state, candidates } = await this.#creationCandidates();
    const inspected = (await Promise.all(candidates.map(entry => this.#inspectCreation(entry))))
      .filter(Boolean)
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    const unique = [...new Map(inspected.map(entry => [pointerKey(entry), entry])).values()]
      .slice(0, this.limit);
    const result = unique.map(({ updatedAtMs:unused, ...entry }) => entry);
    const persisted = result.map(({ kind:unusedKind, taskId:unusedTaskId, projectName:unusedProjectName,
      title:unusedTitle, phase:unusedPhase, progress:unusedProgress, revision:unusedRevision,
      updatedAt:unusedUpdatedAt, locked:unusedLocked, provider, projectRoot, draftId, lastOpenedAt }) => ({
      projectRoot, draftId, provider, lastOpenedAt,
    }));
    if (JSON.stringify(persisted) !== JSON.stringify(state.creation.slice(0, this.limit))) {
      await this.#write(persisted, state.completedCreation, state.dismissedCreation);
    }
    return result;
  }

  async list() {
    const [creation, editing] = await Promise.all([
      this.listCreation(),
      this.recentDeckStore.list(),
    ]);
    return { version:SCHEMA_VERSION, creation, editing };
  }

  async recordCreation({ projectRoot, draftId, provider = 'codex' }) {
    const inspected = await this.#inspectCreation({ projectRoot, draftId, provider });
    if (!inspected) throw new Error('Creation Draft 不是可恢复的本地任务');
    const state = await this.#read();
    const entry = {
      projectRoot:inspected.projectRoot,
      draftId:inspected.draftId,
      provider:isAgentProviderId(provider) ? provider : inspected.provider,
      lastOpenedAt:this.now().toISOString(),
    };
    await this.#write([
      entry,
      ...state.creation.filter(item => pointerKey(item) !== pointerKey(entry)),
    ].slice(0, this.limit), state.completedCreation.filter(
      item => pointerKey(item) !== pointerKey(entry),
    ), state.dismissedCreation.filter(item => pointerKey(item) !== pointerKey(entry)));
    return inspected;
  }

  async resolveCreation({ projectRoot, draftId }) {
    const canonicalRoot = await realpath(projectRoot).catch(() => null);
    if (!canonicalRoot) return null;
    const { candidates } = await this.#creationCandidates();
    const requested = { projectRoot:canonicalRoot, draftId };
    if (!candidates.some(entry => pointerKey(entry) === pointerKey(requested))) return null;
    return this.#inspectCreation(requested);
  }

  async completeCreation({ projectRoot, draftId }) {
    const canonicalRoot = await realpath(projectRoot).catch(() => resolve(projectRoot));
    const target = { projectRoot:canonicalRoot, draftId };
    const state = await this.#read();
    const next = state.creation.filter(item => pointerKey(item) !== pointerKey(target));
    const completed = [
      target,
      ...state.completedCreation.filter(item => pointerKey(item) !== pointerKey(target)),
    ].slice(0, this.limit * 4);
    await this.#write(
      next,
      completed,
      state.dismissedCreation.filter(item => pointerKey(item) !== pointerKey(target)),
    );
  }

  async dismissCreation({ projectRoot, draftId }) {
    if (typeof draftId !== 'string' || !DRAFT_ID_PATTERN.test(draftId)) {
      throw new TypeError('要删除的 Creation 任务记录缺少有效 draftId');
    }
    const canonicalRoot = await realpath(projectRoot).catch(() => resolve(projectRoot));
    const target = { projectRoot:canonicalRoot, draftId };
    const state = await this.#read();
    await this.#write(
      state.creation.filter(item => pointerKey(item) !== pointerKey(target)),
      state.completedCreation,
      [target, ...state.dismissedCreation.filter(item => pointerKey(item) !== pointerKey(target))]
        .slice(0, this.limit * 4),
    );
  }

  recordDeck(value) { return this.recentDeckStore.record(value); }
  resolveDeck(value) { return this.recentDeckStore.resolve(value); }
  dismissDeck(deckPath) { return this.recentDeckStore.dismiss(deckPath); }
}

export function createWorkHistoryStore(options) {
  return new WorkHistoryStore(options);
}
