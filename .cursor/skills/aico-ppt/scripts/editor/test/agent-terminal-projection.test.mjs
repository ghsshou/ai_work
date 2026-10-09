import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentTerminalProjection } from '../agent-terminal-projection.mjs';

test('服务端终端投影只序列化最终 framebuffer，不携带恢复 scrollback', async () => {
  const projection = createAgentTerminalProjection({ cols:20, rows:3 });
  projection.write('应被滚出的历史一\r\n');
  projection.write('应被滚出的历史二\r\n');
  projection.write('\u001b[31m最终红色行\u001b[0m\r\n最终输入行');

  const serialized = await projection.snapshot();
  assert.doesNotMatch(serialized, /历史一/);
  assert.match(serialized, /最终红色行/);
  assert.match(serialized, /最终输入行/);
  assert.match(serialized, /\u001b\[31m/);
  projection.dispose();
});
