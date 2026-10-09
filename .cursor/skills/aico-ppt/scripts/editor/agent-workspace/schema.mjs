import { isAbsolute, normalize as normalizePath } from 'node:path';

import { SKILL_CONTRACT_VERSION } from './skill-contract.mjs';
import { AGENT_PROVIDER_IDS } from '../agent-provider-registry.mjs';
export { AGENT_PROVIDER_IDS } from '../agent-provider-registry.mjs';

export const WORKSPACE_SCHEMA_VERSION = 1;
const PROVIDER_IDS = new Set(AGENT_PROVIDER_IDS);
const OWNERSHIP_VALUES = new Set([
  'editor-created',
  'launch-source',
  'manual-attached',
  'legacy-imported',
]);
const SKILL_STATUSES = new Set([
  'uninitialized',
  'initializing',
  'ready',
  'stale',
  'failed',
]);
const PROJECT_ROOT_SOURCES = new Set([
  'persisted',
  'explicit',
  'launch-cwd',
  'git-root',
  'workspace-marker',
  'deck-directory',
  'user-selected',
]);
const CONVERSATION_KEYS = new Set([
  'id',
  'conversationId',
  'ownership',
  'title',
  'projectRoot',
  'createdAt',
  'updatedAt',
  'skill',
  // 运行时可把 provider 私有信息放在这里；normalize 会有意丢弃，绝不持久化。
  'internal',
]);
const SKILL_KEYS = new Set([
  'status',
  'contractVersion',
  'initializedAt',
  'lastVerifiedAt',
  'lastError',
]);
const PROVIDER_STATE_KEYS = new Set(['activeConversationId', 'conversations']);
const WORKSPACE_KEYS = new Set([
  'version',
  'workspaceRevision',
  'deckSessionId',
  'projectRoot',
  'projectRootSource',
  'activeProvider',
  'providers',
  'createdAt',
  'updatedAt',
]);

function invalid(message) {
  throw new TypeError(`Agent 工作区无效：${message}`);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) invalid(`${label} 必须是普通对象`);
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${label} 包含未知字段 ${key}`);
  }
}

function normalizeTimestamp(value, label, { optional = false } = {}) {
  if (optional && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || value.length > 64 || /[\0\r\n]/.test(value)) {
    invalid(`${label} 必须是 ISO 时间戳`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    invalid(`${label} 必须是规范 ISO 时间戳`);
  }
  return value;
}

function normalizeAbsolutePath(value, label, { optional = false } = {}) {
  if (optional && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
    || /[\0\r\n]/.test(value) || !isAbsolute(value)) {
    invalid(`${label} 必须是绝对路径`);
  }
  return normalizePath(value);
}

function normalizeProviderId(provider) {
  if (!PROVIDER_IDS.has(provider)) invalid(`provider ${String(provider)} 不受支持`);
  return provider;
}

function normalizeConversationId(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 512
    || value.startsWith('-') || /[\0\r\n]/.test(value)) {
    invalid('会话 ID 不合法');
  }
  return value;
}

function normalizeNullableTitle(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 160 || /[\0\r\n]/.test(value)) {
    invalid('会话标题不合法');
  }
  return value.trim() || null;
}

function normalizeSafeError(value, label = '错误') {
  if (value === null || value === undefined) return null;
  requirePlainObject(value, label);
  const code = typeof value.code === 'string' && value.code.length <= 96
    && !/[\0\r\n]/.test(value.code) ? value.code : null;
  const message = typeof value.message === 'string' && value.message.length <= 1000
    && !/[\0]/.test(value.message) ? value.message : null;
  if (!code && !message) invalid(`${label} 缺少安全的 code 或 message`);
  return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
}

function normalizeSkill(value) {
  requirePlainObject(value, 'Skill 状态');
  rejectUnknownKeys(value, SKILL_KEYS, 'Skill 状态');
  if (!SKILL_STATUSES.has(value.status)) invalid(`Skill status ${String(value.status)} 不合法`);

  const contractVersion = value.contractVersion === undefined || value.contractVersion === null
    ? null : value.contractVersion;
  if (contractVersion !== null
    && (typeof contractVersion !== 'string' || contractVersion.length > 32
      || /[\0\r\n]/.test(contractVersion))) {
    invalid('Skill contractVersion 不合法');
  }
  const initializedAt = normalizeTimestamp(value.initializedAt, 'Skill initializedAt', {
    optional:true,
  });
  const lastVerifiedAt = normalizeTimestamp(value.lastVerifiedAt, 'Skill lastVerifiedAt', {
    optional:true,
  });

  if (value.status === 'ready'
    && (contractVersion !== SKILL_CONTRACT_VERSION || initializedAt === null)) {
    invalid('ready Skill 必须带当前 contractVersion 和 initializedAt');
  }

  return {
    status:value.status,
    ...(contractVersion === null ? {} : { contractVersion }),
    ...(initializedAt === null ? {} : { initializedAt }),
    ...(lastVerifiedAt === null ? {} : { lastVerifiedAt }),
    ...(value.lastError === undefined || value.lastError === null
      ? {} : { lastError:normalizeSafeError(value.lastError, 'Skill lastError') }),
  };
}

export function normalizeConversation(value, provider) {
  normalizeProviderId(provider);
  requirePlainObject(value, '会话');
  rejectUnknownKeys(value, CONVERSATION_KEYS, '会话');

  const id = normalizeConversationId(value.id ?? value.conversationId);
  if (!OWNERSHIP_VALUES.has(value.ownership)) {
    invalid(`会话 ownership ${String(value.ownership)} 不合法`);
  }
  const projectRoot = normalizeAbsolutePath(value.projectRoot, '会话 projectRoot', {
    optional:true,
  });

  return {
    id,
    ownership:value.ownership,
    title:normalizeNullableTitle(value.title),
    projectRoot,
    createdAt:normalizeTimestamp(value.createdAt, '会话 createdAt'),
    updatedAt:normalizeTimestamp(value.updatedAt, '会话 updatedAt'),
    skill:normalizeSkill(value.skill),
  };
}

function normalizeProviderState(value, provider) {
  requirePlainObject(value, `${provider} provider 状态`);
  rejectUnknownKeys(value, PROVIDER_STATE_KEYS, `${provider} provider 状态`);
  if (!Array.isArray(value.conversations)) invalid(`${provider} conversations 必须是数组`);

  const conversations = value.conversations.map(conversation => (
    normalizeConversation(conversation, provider)
  ));
  const seen = new Set();
  for (const conversation of conversations) {
    if (seen.has(conversation.id)) invalid(`${provider} 存在重复会话 ID`);
    seen.add(conversation.id);
  }
  const activeConversationId = value.activeConversationId === null
    || value.activeConversationId === undefined
    ? null : normalizeConversationId(value.activeConversationId);
  if (activeConversationId !== null && !seen.has(activeConversationId)) {
    invalid(`${provider} activeConversationId 未引用已知会话`);
  }
  return { activeConversationId, conversations };
}

export function createEmptyWorkspace({
  deckSessionId,
  projectRoot,
  projectRootSource = 'deck-directory',
  activeProvider = 'codex',
  now = () => new Date().toISOString(),
}) {
  const timestamp = now();
  return normalizeWorkspaceState({
    version:WORKSPACE_SCHEMA_VERSION,
    workspaceRevision:0,
    deckSessionId,
    projectRoot,
    projectRootSource,
    activeProvider,
    providers:Object.fromEntries(AGENT_PROVIDER_IDS.map(provider => [provider, {
      activeConversationId:null,
      conversations:[],
    }])),
    createdAt:timestamp,
    updatedAt:timestamp,
  });
}

export function normalizeWorkspaceState(value) {
  requirePlainObject(value, '根状态');
  rejectUnknownKeys(value, WORKSPACE_KEYS, '根状态');
  if (value.version !== WORKSPACE_SCHEMA_VERSION) {
    invalid(`version 必须为 ${WORKSPACE_SCHEMA_VERSION}`);
  }
  if (!Number.isSafeInteger(value.workspaceRevision) || value.workspaceRevision < 0) {
    invalid('workspaceRevision 必须是非负安全整数');
  }
  if (typeof value.deckSessionId !== 'string' || value.deckSessionId.length < 3
    || value.deckSessionId.length > 160 || /[\0\r\n]/.test(value.deckSessionId)) {
    invalid('deckSessionId 不合法');
  }
  if (!PROJECT_ROOT_SOURCES.has(value.projectRootSource)) {
    invalid(`projectRootSource ${String(value.projectRootSource)} 不合法`);
  }
  const activeProvider = normalizeProviderId(value.activeProvider);
  requirePlainObject(value.providers, 'providers');
  const providerKeys = Object.keys(value.providers).sort();
  if (providerKeys.length !== AGENT_PROVIDER_IDS.length
    || providerKeys.some((provider, index) => provider !== [...AGENT_PROVIDER_IDS].sort()[index])) {
    invalid('providers 必须且只能包含 codex、claude-code、opencode');
  }

  return {
    version:WORKSPACE_SCHEMA_VERSION,
    workspaceRevision:value.workspaceRevision,
    deckSessionId:value.deckSessionId,
    projectRoot:normalizeAbsolutePath(value.projectRoot, 'projectRoot'),
    projectRootSource:value.projectRootSource,
    activeProvider,
    providers:Object.fromEntries(AGENT_PROVIDER_IDS.map(provider => [
      provider,
      normalizeProviderState(value.providers[provider], provider),
    ])),
    createdAt:normalizeTimestamp(value.createdAt, 'createdAt'),
    updatedAt:normalizeTimestamp(value.updatedAt, 'updatedAt'),
  };
}

function publicRuntime(runtime) {
  const value = isPlainObject(runtime) ? runtime : {};
  const safe = {
    state:typeof value.state === 'string' ? value.state : 'stopped',
  };
  for (const key of ['provider', 'conversationId', 'turnId']) {
    if (typeof value[key] === 'string') safe[key] = value[key];
  }
  for (const key of ['sequence']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) safe[key] = value[key];
  }
  if (isPlainObject(value.capabilities)) safe.capabilities = structuredClone(value.capabilities);
  if (value.error) safe.error = normalizeSafeError(value.error, 'runtime error');
  return safe;
}

export function publicWorkspaceSnapshot(state, runtime = { state:'stopped' }) {
  // public snapshot 只投影允许字段，不序列化调用方可能附加的 runtime/internal 数据。
  const safeState = normalizeWorkspaceState(Object.fromEntries(
    Object.entries(state).filter(([key]) => WORKSPACE_KEYS.has(key)),
  ));
  return {
    ...safeState,
    runtime:publicRuntime(runtime),
  };
}
