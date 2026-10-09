import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORKSPACE_SCHEMA_VERSION,
  createEmptyWorkspace,
  normalizeConversation,
  normalizeWorkspaceState,
  publicWorkspaceSnapshot,
} from '../agent-workspace/schema.mjs';
import { SKILL_CONTRACT_VERSION } from '../agent-workspace/skill-contract.mjs';

const DECK_SESSION_ID = '97a53b08-b871-4a1a-b203-291aa0fe0818';
const CREATED_AT = '2026-08-09T12:00:00.000Z';

function emptyWorkspace(overrides = {}) {
  return createEmptyWorkspace({
    deckSessionId:DECK_SESSION_ID,
    projectRoot:'/tmp/aico-ppt-project',
    projectRootSource:'deck-directory',
    activeProvider:'codex',
    now:() => CREATED_AT,
    ...overrides,
  });
}

test('空工作区可以规范化 round-trip，且不修改输入对象', () => {
  const source = emptyWorkspace();
  const before = structuredClone(source);
  const normalized = normalizeWorkspaceState(source);

  assert.deepEqual(source, before);
  assert.deepEqual(normalized, before);
  assert.notEqual(normalized, source);
  assert.equal(normalized.version, WORKSPACE_SCHEMA_VERSION);
  assert.equal(normalized.workspaceRevision, 0);
  assert.deepEqual(Object.keys(normalized.providers).sort(), ['claude-code', 'codex', 'opencode']);
});

test('拒绝非法 provider、相对项目路径、换行会话 ID 和错误 schema 版本', () => {
  assert.throws(() => emptyWorkspace({ activeProvider:'openclaw' }), /provider/i);
  assert.throws(() => emptyWorkspace({ projectRoot:'relative/path' }), /绝对路径/);
  assert.throws(() => normalizeConversation({
    id:'bad\nid', ownership:'editor-created', title:null, createdAt:CREATED_AT,
    updatedAt:CREATED_AT, skill:{ status:'uninitialized' }, internal:{},
  }, 'codex'), /会话 ID/);

  const source = emptyWorkspace();
  source.version = 99;
  assert.throws(() => normalizeWorkspaceState(source), /version/);
});

test('activeConversationId 必须引用同 provider 的已知会话', () => {
  const source = emptyWorkspace();
  source.providers.codex.activeConversationId = 'missing-conversation';
  assert.throws(() => normalizeWorkspaceState(source), /activeConversationId/);
});

test('ready Skill 必须带当前 contractVersion 和 initializedAt', () => {
  const base = {
    id:'01912345-6789-7abc-8def-0123456789ab',
    ownership:'editor-created',
    title:'Deck 专用会话',
    createdAt:CREATED_AT,
    updatedAt:CREATED_AT,
    internal:{ providerToken:'secret' },
  };

  assert.throws(() => normalizeConversation({
    ...base,
    skill:{ status:'ready' },
  }, 'codex'), /contractVersion|initializedAt/);
  assert.throws(() => normalizeConversation({
    ...base,
    skill:{ status:'ready', contractVersion:'old', initializedAt:CREATED_AT },
  }, 'codex'), /contractVersion/);

  const normalized = normalizeConversation({
    ...base,
    skill:{
      status:'ready',
      contractVersion:SKILL_CONTRACT_VERSION,
      initializedAt:CREATED_AT,
    },
  }, 'codex');
  assert.equal(normalized.skill.status, 'ready');
});

test('公共快照移除 secrets、内部字段、原始 CLI 参数和错误堆栈', () => {
  const source = emptyWorkspace();
  source.internal = { encryptionKey:'secret' };
  source.providers.codex.conversations.push(normalizeConversation({
    id:'01912345-6789-7abc-8def-0123456789ab',
    ownership:'editor-created',
    title:'Deck 专用会话',
    createdAt:CREATED_AT,
    updatedAt:CREATED_AT,
    skill:{ status:'uninitialized' },
    internal:{ providerToken:'secret', rawArgs:['--dangerous'] },
  }, 'codex'));
  source.providers.codex.activeConversationId = source.providers.codex.conversations[0].id;

  const snapshot = publicWorkspaceSnapshot(source, {
    state:'failed',
    error:{ code:'RUNTIME_FAILED', message:'启动失败', stack:'secret stack' },
    internal:{ childPid:1234 },
  });
  const json = JSON.stringify(snapshot);

  assert.equal(snapshot.workspaceRevision, 0);
  assert.equal(snapshot.runtime.error.code, 'RUNTIME_FAILED');
  assert.equal(snapshot.runtime.error.message, '启动失败');
  assert.equal('stack' in snapshot.runtime.error, false);
  assert.doesNotMatch(json, /providerToken|rawArgs|encryptionKey|childPid|secret/);
});
