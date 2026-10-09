import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { isAgentProviderId } from './agent-provider-registry.mjs';
import { resolveEditorStateRoot } from './editor-state-root.mjs';
import {
  isProjectStateDirectoryName,
  resolveProjectStateRoot,
} from './state-paths.mjs';

const SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 8;

function isDeckPath(value) {
  return typeof value === 'string' && ['.html', '.htm'].includes(extname(value).toLowerCase());
}

function emptyState() {
  return { version:SCHEMA_VERSION, entries:[], dismissed:[] };
}

function contains(root, target) {
  const suffix = relative(root, target);
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
}

export class RecentDeckStore {
  constructor({
    filePath = join(resolveEditorStateRoot(), 'recent-decks.json'),
    discoveryRoots = [],
    limit = DEFAULT_LIMIT,
    now = () => new Date(),
  } = {}) {
    this.filePath = resolve(filePath);
    this.limit = Math.max(1, Math.min(24, Number(limit) || DEFAULT_LIMIT));
    this.now = now;
    this.discoveryRoots = discoveryRoots.map(root => resolve(root));
  }

  async #read() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (parsed?.version !== SCHEMA_VERSION || !Array.isArray(parsed.entries)) return emptyState();
      return {
        ...parsed,
        dismissed:Array.isArray(parsed.dismissed)
          ? parsed.dismissed.filter(isDeckPath)
          : [],
      };
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return emptyState();
      throw error;
    }
  }

  async #write(entries, dismissed = []) {
    await mkdir(dirname(this.filePath), { recursive:true, mode:0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({
        version:SCHEMA_VERSION, entries, dismissed,
      }, null, 2)}\n`, {
        encoding:'utf8', mode:0o600,
      });
      await rename(temporary, this.filePath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async #inspect(entry) {
    if (!isDeckPath(entry?.deckPath)) return null;
    try {
      const deckPath = await realpath(entry.deckPath);
      if (!isDeckPath(deckPath)) return null;
      const detail = await stat(deckPath);
      if (!detail.isFile()) return null;
      const session = await this.#sessionSummary(deckPath);
      let persistedProjectRoot = null;
      if (typeof entry.projectRoot === 'string') {
        try {
          const candidate = await realpath(entry.projectRoot);
          if ((await stat(candidate)).isDirectory()) persistedProjectRoot = candidate;
        } catch { /* 旧记录的项目根失效时仍保留 Deck 入口 */ }
      }
      const activityAtMs = Math.max(detail.mtimeMs, session?.activityAtMs ?? 0);
      return {
        deckPath,
        deckName:basename(deckPath),
        directory:dirname(deckPath),
        modifiedAt:new Date(activityAtMs).toISOString(),
        modifiedAtMs:activityAtMs,
        lastOpenedAt:typeof entry.lastOpenedAt === 'string' ? entry.lastOpenedAt : null,
        provider:isAgentProviderId(session?.provider)
          ? session.provider
          : isAgentProviderId(entry.provider) ? entry.provider : 'codex',
        progress:session?.progress ?? '继续编辑',
        sessionId:session?.sessionId ?? null,
        // 显式记录的项目根代表用户最后一次打开时的选择；
        // sidecar / Creation 上下文只负责为没有新记录的旧任务补齐。
        projectRoot:persistedProjectRoot ?? session?.projectRoot ?? null,
      };
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) return null;
      throw error;
    }
  }

  async #sessionSummary(deckPath) {
    const sidecarRoot = resolveProjectStateRoot(dirname(deckPath));
    const directories = await readdir(sidecarRoot, { withFileTypes:true }).catch(() => []);
    let newest = null;
    for (const directory of directories) {
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.name === 'drafts') continue;
      const sessionDir = join(sidecarRoot, directory.name);
      try {
        const sessionPath = join(sessionDir, 'session.json');
        const state = JSON.parse(await readFile(sessionPath, 'utf8'));
        const candidateDeck = await realpath(state?.deckPath).catch(() => null);
        if (candidateDeck !== deckPath) continue;
        const detail = await stat(sessionPath);
        const pending = Array.isArray(state.tasks)
          ? state.tasks.filter(task => ['pending', 'failed'].includes(task?.status)).length : 0;
        const activeGroups = Array.isArray(state.groups)
          ? state.groups.filter(group => group?.active === true).length : 0;
        let provider = null;
        let projectRoot = null;
        try {
          const context = JSON.parse(await readFile(join(sessionDir, 'creation-context.json'), 'utf8'));
          const contextRoot = await realpath(context?.projectRoot);
          const draftRoot = await realpath(context?.draft?.projectRoot);
          const publishedDeck = await realpath(context?.draft?.generation?.publishedDeck);
          if (context?.version === 1 && context.kind === 'creation-to-editing'
            && contextRoot === draftRoot && publishedDeck === deckPath
            && contains(contextRoot, deckPath)) {
            projectRoot = contextRoot;
          }
        } catch { /* 非 Creation 交接任务没有该上下文 */ }
        try {
          const workspace = JSON.parse(await readFile(join(sessionDir, 'agent-workspace.json'), 'utf8'));
          provider = workspace?.activeProvider ?? null;
          if (projectRoot === null && typeof workspace?.projectRoot === 'string') {
            projectRoot = workspace.projectRoot;
          }
        } catch { /* 旧会话没有 Agent 工作区时继续使用最近列表中的 provider */ }
        const summary = {
          sessionId:typeof state.sessionId === 'string' ? state.sessionId : null,
          provider,
          projectRoot,
          progress:pending > 0 ? `${pending} 项待处理`
            : activeGroups > 0 ? `${activeGroups} 组未固化修改`
              : '继续编辑',
          activityAtMs:detail.mtimeMs,
        };
        if (!newest || summary.activityAtMs > newest.activityAtMs) newest = summary;
      } catch {
        // 损坏或来自其他系统的旧 sidecar 不应阻断启动页。
      }
    }
    return newest;
  }

  async #discoverSidecars(root, depth = 0) {
    if (depth > 5) return [];
    let entries;
    try {
      entries = await readdir(root, { withFileTypes:true });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) return [];
      throw error;
    }
    const discovered = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = join(root, entry.name);
      if (isProjectStateDirectoryName(entry.name)) {
        const sessions = await readdir(child, { withFileTypes:true }).catch(() => []);
        for (const session of sessions) {
          if (!session.isDirectory() || session.isSymbolicLink()) continue;
          try {
            const state = JSON.parse(await readFile(join(child, session.name, 'session.json'), 'utf8'));
            if (isDeckPath(state?.deckPath)) {
              discovered.push({ deckPath:state.deckPath, lastOpenedAt:null, provider:'codex' });
            }
          } catch {
            // 损坏或半写入的旧会话不应阻断启动页。
          }
        }
        continue;
      }
      if (!entry.name.startsWith('.')) {
        discovered.push(...await this.#discoverSidecars(child, depth + 1));
      }
    }
    return discovered;
  }

  async list() {
    const state = await this.#read();
    const discovered = (await Promise.all(
      this.discoveryRoots.map(root => this.#discoverSidecars(root)),
    )).flat();
    const knownPaths = new Set(state.entries.map(entry => entry?.deckPath));
    const candidates = [
      ...state.entries,
      ...discovered.filter(entry => !knownPaths.has(entry.deckPath)),
    ];
    const dismissed = new Set(state.dismissed);
    const ordered = (await Promise.all(candidates.map(entry => this.#inspect(entry))))
      .filter(Boolean)
      .filter(entry => !dismissed.has(entry.deckPath))
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
    const inspected = [...new Map(ordered.map(entry => [entry.deckPath, entry])).values()]
      .slice(0, this.limit);
    const normalized = inspected.map(({ modifiedAtMs:unused, ...entry }) => entry);
    const persisted = normalized.map(({ deckName:unusedName, directory:unusedDirectory,
      modifiedAt:unusedModifiedAt, progress:unusedProgress, sessionId:unusedSessionId,
      ...entry }) => entry);
    const source = state.entries.slice(0, this.limit);
    if (JSON.stringify(persisted) !== JSON.stringify(source)) {
      await this.#write(persisted, state.dismissed);
    }
    return normalized;
  }

  async record({ deckPath, provider = 'codex', projectRoot = null }) {
    const canonicalPath = await realpath(deckPath);
    if (!isDeckPath(canonicalPath) || !(await stat(canonicalPath)).isFile()) {
      throw new Error(`最近 Deck 不是可用的 HTML 文件：${deckPath}`);
    }
    let canonicalProjectRoot = null;
    if (projectRoot !== null) {
      canonicalProjectRoot = await realpath(projectRoot);
      if (!(await stat(canonicalProjectRoot)).isDirectory()) {
        throw new Error(`Agent 项目根不是可用目录：${projectRoot}`);
      }
    }
    const state = await this.#read();
    const entry = {
      deckPath:canonicalPath,
      lastOpenedAt:this.now().toISOString(),
      provider:isAgentProviderId(provider) ? provider : 'codex',
      ...(canonicalProjectRoot ? { projectRoot:canonicalProjectRoot } : {}),
    };
    const entries = [entry, ...state.entries.filter(item => item?.deckPath !== canonicalPath)]
      .slice(0, this.limit);
    await this.#write(entries, state.dismissed.filter(item => item !== canonicalPath));
    return entry;
  }

  async dismiss(deckPath) {
    if (!isDeckPath(deckPath)) throw new TypeError('要删除的最近 Deck 记录不是 HTML 文件');
    const canonicalPath = await realpath(deckPath).catch(() => resolve(deckPath));
    const state = await this.#read();
    await this.#write(
      state.entries.filter(item => item?.deckPath !== canonicalPath),
      [canonicalPath, ...state.dismissed.filter(item => item !== canonicalPath)]
        .slice(0, this.limit * 4),
    );
  }

  async resolve(deckPath) {
    if (!isDeckPath(deckPath)) return null;
    const canonicalPath = await realpath(deckPath).catch(() => null);
    if (!canonicalPath) return null;
    return (await this.list()).find(entry => entry.deckPath === canonicalPath)?.deckPath ?? null;
  }
}

export function createRecentDeckStore(options) {
  return new RecentDeckStore(options);
}
