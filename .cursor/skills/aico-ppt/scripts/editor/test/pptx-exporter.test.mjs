import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { exportPptxSnapshot } from '../pptx-exporter.mjs';

test('快照导出将模式传给转换 CLI，并在返回后清理临时 HTML', async () => {
  for (const mode of [undefined, 'image', 'editable']) {
    const bytes = await exportPptxSnapshot({
      htmlBytes:Buffer.from('<html>未固化的中文修改</html>'),
      ...(mode === undefined ? {} : { mode }),
      spawnProcess:(_python, args, options) => spawn(process.execPath, ['-e', `
        const fs = require('node:fs');
        const [, input, output, ...options] = process.argv.slice(1);
        fs.writeFileSync(output, 'PK' + JSON.stringify({
          input, options, html:fs.readFileSync(input, 'utf8'),
        }));
      `, ...args], options),
    });
    const result = JSON.parse(bytes.subarray(2));
    assert.deepEqual(result.options, ['--mode', mode ?? 'image']);
    assert.equal(result.html, '<html>未固化的中文修改</html>');
    await assert.rejects(access(result.input), { code:'ENOENT' });
  }
});
