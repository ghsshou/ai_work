import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolveProjectStateRoot } from './state-paths.mjs';

export const CREATION_HANDOFF_FILENAME = 'creation-context.json';
const LEGACY_FILENAME = 'creation.json';

function handoffError(code, message, cause) {
  return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
}

function contains(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function safeAbsolutePath(value, root, label, { optional = true } = {}) {
  if ((value === null || value === undefined || value === '') && optional) return null;
  if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw handoffError('INVALID_CREATION_HANDOFF', `${label} 必须是绝对路径`);
  }
  const path = resolve(value);
  if (!contains(root, path)) {
    throw handoffError('INVALID_CREATION_HANDOFF', `${label} 超出项目目录`);
  }
  return path;
}

function safeArtifactPath(value, { projectRoot, draftDir }, label) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) {
    throw handoffError('INVALID_CREATION_HANDOFF', `${label} 路径无效`);
  }
  const path = resolve(value);
  if (!contains(projectRoot, path) && !contains(draftDir, path)) {
    throw handoffError('INVALID_CREATION_HANDOFF', `${label} 超出 Creation 工作区`);
  }
  return path;
}

function optionalText(value, maximum = 512) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw handoffError('INVALID_CREATION_HANDOFF', 'Creation 交接文本无效');
  }
  return value;
}

function confirmedArtifactPath(draft, key) {
  return draft?.milestones?.[key]?.complete === true
    ? draft.milestones[key].path ?? null
    : null;
}

function durableDraftSnapshot(draft) {
  return structuredClone({
    version:draft.version,
    draftId:draft.draftId,
    revision:draft.revision,
    phase:draft.phase,
    projectRoot:draft.projectRoot,
    provider:draft.provider,
    brief:draft.brief ?? null,
    briefConfirmedRevision:draft.briefConfirmedRevision ?? null,
    outline:draft.outline ?? null,
    outlineStatus:draft.outlineStatus ?? 'empty',
    outlineConfirmedRevision:draft.outlineConfirmedRevision ?? null,
    pagePlan:draft.pagePlan ?? null,
    pagePlanStatus:draft.pagePlanStatus ?? 'empty',
    pagePlanConfirmedRevision:draft.pagePlanConfirmedRevision ?? null,
    output:draft.output ?? null,
    generation:draft.generation ? {
      status:draft.generation.status,
      publishedDeck:draft.generation.publishedDeck ?? null,
      publishedPlan:draft.generation.publishedPlan ?? null,
      diagnostics:draft.generation.diagnostics ?? [],
    } : null,
    createdAt:draft.createdAt ?? null,
    updatedAt:draft.updatedAt ?? null,
  });
}

export function createCreationHandoffContext({
  draft,
  draftDir,
  conversationId = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!draft || draft.version !== 1 || typeof draft.draftId !== 'string'
    || typeof draft.projectRoot !== 'string' || !isAbsolute(draft.projectRoot)) {
    throw handoffError('INVALID_CREATION_HANDOFF', 'Creation Draft 快照无效');
  }
  const projectRoot = resolve(draft.projectRoot);
  const safeDraftDir = safeAbsolutePath(draftDir, projectRoot, 'Draft 目录', { optional:false });
  const artifacts = {
    briefPath:safeArtifactPath(confirmedArtifactPath(draft, 'brief'), {
      projectRoot, draftDir:safeDraftDir,
    }, '需求文稿'),
    outlinePath:safeArtifactPath(confirmedArtifactPath(draft, 'outline'), {
      projectRoot, draftDir:safeDraftDir,
    }, '大纲文稿'),
    pagePlanPath:safeArtifactPath(confirmedArtifactPath(draft, 'pagePlan'), {
      projectRoot, draftDir:safeDraftDir,
    }, '页面规划文稿'),
    planPath:safeArtifactPath(
      draft.generation?.publishedPlan ?? draft.generation?.stagingPlanPath ?? null,
      { projectRoot, draftDir:safeDraftDir },
      '设计文稿',
    ),
    materialsDirectory:join(safeDraftDir, 'materials'),
    diagnosticsDirectory:join(safeDraftDir, 'diagnostics'),
  };
  return {
    version:1,
    kind:'creation-to-editing',
    draftId:draft.draftId,
    projectRoot,
    draftDirectory:safeDraftDir,
    provider:optionalText(draft.provider, 80) ?? 'codex',
    conversationId:optionalText(conversationId, 512),
    title:optionalText(draft.brief?.title, 500),
    handedOffAt:now(),
    artifacts,
    draft:durableDraftSnapshot(draft),
  };
}

function normalizePersistedContext(value) {
  if (!value || value.version !== 1 || value.kind !== 'creation-to-editing') {
    throw handoffError('CREATION_HANDOFF_CORRUPT', 'Creation 交接上下文格式无效');
  }
  return createCreationHandoffContext({
    draft:{ ...value.draft, milestones:{
      brief:{ complete:Boolean(value.artifacts?.briefPath), path:value.artifacts?.briefPath },
      outline:{ complete:Boolean(value.artifacts?.outlinePath), path:value.artifacts?.outlinePath },
      pagePlan:{ complete:Boolean(value.artifacts?.pagePlanPath), path:value.artifacts?.pagePlanPath },
    }, generation:{
      ...(value.draft?.generation ?? {}),
      publishedPlan:value.artifacts?.planPath ?? value.draft?.generation?.publishedPlan ?? null,
    } },
    draftDir:value.draftDirectory,
    conversationId:value.conversationId,
    now:() => value.handedOffAt,
  });
}

async function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding:'utf8', mode:0o600, flag:'wx',
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function persistCreationHandoffContext(sessionDir, input) {
  const context = createCreationHandoffContext(input);
  const path = join(resolve(sessionDir), CREATION_HANDOFF_FILENAME);
  await atomicWrite(path, context);
  return { path, context };
}

function legacyDraftDirectory(draft) {
  const milestonePath = ['brief', 'outline', 'pagePlan']
    .map(key => draft?.milestones?.[key]?.path)
    .find(path => typeof path === 'string' && isAbsolute(path));
  if (milestonePath) return dirname(milestonePath);
  if (typeof draft?.projectRoot === 'string' && typeof draft?.draftId === 'string') {
    return join(resolveProjectStateRoot(draft.projectRoot, {
      existingChild:['drafts', draft.draftId],
    }), 'drafts', draft.draftId);
  }
  return null;
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw handoffError('CREATION_HANDOFF_CORRUPT', 'Creation 交接上下文不是有效 JSON', error);
    }
    throw error;
  }
}

export async function loadCreationHandoffContext(sessionDir) {
  const root = resolve(sessionDir);
  const path = join(root, CREATION_HANDOFF_FILENAME);
  const current = await readJson(path);
  if (current) return { path, context:normalizePersistedContext(current) };

  const legacyPath = join(root, LEGACY_FILENAME);
  const legacy = await readJson(legacyPath);
  if (!legacy) return null;
  const draftDir = legacyDraftDirectory(legacy);
  if (!draftDir) throw handoffError('CREATION_HANDOFF_CORRUPT', '旧版 Creation 上下文缺少 Draft 目录');
  const migrated = createCreationHandoffContext({ draft:legacy, draftDir });
  await atomicWrite(path, migrated);
  return { path, context:migrated, migratedFrom:legacyPath };
}

export async function inspectCreationHandoffArtifacts(context) {
  const result = {};
  for (const [key, path] of Object.entries(context?.artifacts ?? {})) {
    if (!path) {
      result[key] = false;
      continue;
    }
    result[key] = await lstat(path).then(info => (
      key.endsWith('Directory') ? info.isDirectory() : info.isFile()
    )).catch(() => false);
  }
  return result;
}

export function buildCreationHandoffPrompt({ path, context, editor = null } = {}) {
  if (!path || !context) return '';
  return [
    '当前 Deck 已从“新建 Deck”进入“修改 Deck”微调阶段；这是同一个任务，不是新的制作项目。',
    '沿用当前 Agent 对话与已经加载的 aico-ppt Skill，不要再次完整读取 SKILL.md，也不要重复询问已确认的信息。',
    `Creation 上下文清单：${path}`,
    `原 Draft：${context.draftId}`,
    `设计文稿：${context.artifacts.planPath ?? '未单独生成'}`,
    `素材库：${context.artifacts.materialsDirectory}`,
    ...(editor ? [
      `Editor 托管工作副本：${editor.workingDeckPath}`,
      `真实 Deck（只读）：${editor.sourceDeckPath}`,
      `Editor CLI 前缀：node ${JSON.stringify(editor.cliPath)} --url ${JSON.stringify(editor.serviceUrl)} --token ${JSON.stringify(editor.token)}`,
    ] : []),
    '修改前按需读取该清单中的 brief、outline、pagePlan 和素材路径；已确认的设计决策是本 Deck 的默认约束。',
    '后续只通过当前 Editor 的托管工作副本和受控 CLI 修改，真实 Deck 仍保持只读，直到用户点击“固化修改”。',
  ].join('\n');
}
