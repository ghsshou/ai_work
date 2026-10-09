import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWorkspaceFromLegacyConnection,
  resolveLegacyConnection,
} from '../agent-workspace/legacy-migration.mjs';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const THREAD_ID = '019fc842-816b-7413-bb23-10b0f87e1d4c';
const NOW = '2026-08-09T12:00:00.000Z';

function legacy(source = 'created') {
  return {
    version:1,
    provider:'codex',
    threadId:THREAD_ID,
    title:'旧 Deck 会话',
    projectPath:'/tmp/project',
    source,
    skillStatus:'loaded',
    updatedAt:NOW,
  };
}

test('旧 created/launch/manual 只迁移一次，并一律要求刷新 Skill 契约', () => {
  for (const [source, ownership] of [
    ['created', 'editor-created'],
    ['launch', 'launch-source'],
    ['manual', 'manual-attached'],
  ]) {
    const workspace = createWorkspaceFromLegacyConnection({
      deckSessionId:SESSION_ID,
      projectRoot:'/tmp/project',
      connection:legacy(source),
      now:() => NOW,
    });
    const conversation = workspace.providers.codex.conversations[0];
    assert.equal(conversation.ownership, ownership);
    assert.equal(conversation.skill.status, 'stale');
    assert.equal(workspace.providers.codex.activeConversationId, THREAD_ID);
  }
});

test('启动来源会话只用于首次建立 workspace，之后不再提供旧连接 API', () => {
  const connection = resolveLegacyConnection({
    provider:'codex', launchThreadId:THREAD_ID, now:() => NOW,
  });
  assert.equal(connection.threadId, THREAD_ID);
  assert.equal(connection.source, 'launch');
  assert.equal(connection.skillStatus, 'loaded');
});
