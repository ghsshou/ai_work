import {
  createEmptyWorkspace,
  normalizeConversation,
} from './schema.mjs';
import { SKILL_CONTRACT_VERSION } from './skill-contract.mjs';

const SOURCE_TO_OWNERSHIP = Object.freeze({
  created:'editor-created',
  launch:'launch-source',
  manual:'manual-attached',
});

export function resolveLegacyConnection({
  provider = 'codex', launchThreadId = null, persistedConnection = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!['codex', 'claude-code', 'opencode'].includes(provider)) {
    throw new TypeError(`Agent provider 不受支持：${String(provider)}`);
  }
  if (launchThreadId !== null) {
    if (typeof launchThreadId !== 'string' || launchThreadId.length < 3
      || launchThreadId.length > 512 || launchThreadId.startsWith('-')
      || /[\0\r\n]/.test(launchThreadId)) {
      throw new TypeError('来源 Agent 会话 ID 无效');
    }
    return {
      version:1, provider, threadId:launchThreadId, title:null, projectPath:null,
      source:'launch', skillStatus:'loaded', updatedAt:now(),
    };
  }
  if (persistedConnection?.threadId) return persistedConnection;
  return {
    version:1, provider, threadId:null, title:null, projectPath:null,
    source:'unbound', skillStatus:'unknown', updatedAt:null,
  };
}

function providerState(workspace, provider) {
  const state = workspace?.providers?.[provider];
  if (!state) throw new TypeError(`Agent provider 不受支持：${String(provider)}`);
  return state;
}

function skillFromConnection(connection, timestamp, { migrated }) {
  if (migrated) return { status:'stale' };
  if (connection.skillStatus === 'loaded') {
    return {
      status:'ready',
      contractVersion:SKILL_CONTRACT_VERSION,
      initializedAt:timestamp,
      lastVerifiedAt:timestamp,
    };
  }
  if (connection.skillStatus === 'detected') return { status:'stale' };
  return { status:'uninitialized' };
}

function migrateWorkspaceConnection(workspace, connection, {
  now = () => new Date().toISOString(),
  migrated = false,
} = {}) {
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
    throw new TypeError('Agent connection 必须是对象');
  }
  const provider = connection.provider;
  const state = providerState(workspace, provider);
  workspace.activeProvider = provider;
  if (connection.threadId === null) {
    state.activeConversationId = null;
    return workspace;
  }

  const timestamp = now();
  const previous = state.conversations.find(item => item.id === connection.threadId) ?? null;
  const conversation = normalizeConversation({
    id:connection.threadId,
    ownership:SOURCE_TO_OWNERSHIP[connection.source]
      ?? previous?.ownership
      ?? 'legacy-imported',
    title:connection.title ?? previous?.title ?? null,
    projectRoot:connection.projectPath ?? previous?.projectRoot ?? workspace.projectRoot,
    createdAt:previous?.createdAt ?? connection.updatedAt ?? timestamp,
    updatedAt:connection.updatedAt ?? timestamp,
    skill:skillFromConnection(connection, timestamp, { migrated }),
  }, provider);
  state.conversations = [
    ...state.conversations.filter(item => item.id !== conversation.id),
    conversation,
  ];
  state.activeConversationId = conversation.id;
  return workspace;
}

export function createWorkspaceFromLegacyConnection({
  deckSessionId,
  projectRoot,
  projectRootSource = 'deck-directory',
  connection,
  activeProvider = connection?.provider ?? 'codex',
  now = () => new Date().toISOString(),
}) {
  const workspace = createEmptyWorkspace({
    deckSessionId,
    projectRoot,
    projectRootSource,
    activeProvider:['codex', 'claude-code', 'opencode'].includes(activeProvider)
      ? activeProvider : 'codex',
    now,
  });
  if (connection?.threadId && workspace.providers[connection.provider]) {
    migrateWorkspaceConnection(workspace, connection, { now, migrated:true });
  }
  return workspace;
}
