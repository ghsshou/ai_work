import assert from 'node:assert/strict';
import test from 'node:test';

import { createDshPromptRelay } from '../dsh-prompt-relay.mjs';

test('DSH Prompt Relay 在同步成功回执后仍可结算对应提交', async () => {
  let relay;
  relay = createDshPromptRelay({
    cwd:'/project',
    getSessionId:() => 'session-a',
    publishRequest:request => relay.acknowledge({
      requestId:request.requestId,
      accepted:true,
    }),
  });

  const requestId = relay.submitPrompt('生成 Deck');
  await relay.waitUntilPromptSubmission(requestId);
  assert.equal(relay.snapshot().conversationId, 'session-a');
});

test('DSH Prompt Relay 不丢失同步拒绝回执', async () => {
  let relay;
  relay = createDshPromptRelay({
    cwd:'/project',
    getSessionId:() => 'session-a',
    publishRequest:request => relay.acknowledge({
      requestId:request.requestId,
      accepted:false,
      message:'会话不可写',
    }),
  });

  const requestId = relay.submitPrompt('生成 Deck');
  await assert.rejects(
    () => relay.waitUntilPromptSubmission(requestId),
    error => error.code === 'DSH_PROMPT_SUBMISSION_FAILED' && /会话不可写/u.test(error.message),
  );
});

test('DSH Prompt Relay 发布失败不遗留假 pending，且关闭结算在途请求', async () => {
  const publishError = new Error('广播已关闭');
  const failed = createDshPromptRelay({
    cwd:'/project',
    getSessionId:() => 'session-a',
    publishRequest:() => { throw publishError; },
  });
  assert.throws(() => failed.submitPrompt('生成 Deck'), error => error === publishError);

  const pending = createDshPromptRelay({
    cwd:'/project',
    getSessionId:() => 'session-a',
    publishRequest:() => {},
  });
  const requestId = pending.submitPrompt('生成 Deck');
  const settled = pending.waitUntilPromptSubmission(requestId);
  await pending.close();
  await assert.rejects(
    () => settled,
    error => error.code === 'DSH_PROMPT_SUBMISSION_FAILED' && /已关闭/u.test(error.message),
  );
});
