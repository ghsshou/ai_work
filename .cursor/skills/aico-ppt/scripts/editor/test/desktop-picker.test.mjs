import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickDeckWithSystemPicker, pickProjectDirectoryWithSystemPicker, pickPptxSaveWithSystemPicker } from '../system-picker.mjs';

test('桌面文件选择通过私有对话框通道，不启动 Python GUI', async () => {
  const result = await pickDeckWithSystemPicker({
    environment:{ AICO_DESKTOP_DIALOG_URL:'http://127.0.0.1:45001/pick', AICO_DESKTOP_DIALOG_TOKEN:'private' },
    spawnProcess:() => { throw new Error('桌面不应启动外部选择器'); },
    fetchRequest:async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:45001/pick');
      assert.equal(options.headers.Authorization, 'Bearer private');
      assert.equal(JSON.parse(options.body).kind, 'deck');
      return { ok:true, json:async () => ({ path:'/tmp/测试 Deck.html' }) };
    },
  });
  assert.equal(result, '/tmp/测试 Deck.html');
});

test('PPTX 保存选择器向 Host 传递项目内文件名，不启动 Python GUI', async () => {
  const defaultPath = '/tmp/项目目录/演示 文稿.pptx';
  for (const selected of [defaultPath, null]) {
    const result = await pickPptxSaveWithSystemPicker({
      defaultPath,
      environment:{ AICO_DESKTOP_DIALOG_URL:'http://127.0.0.1:45001/pick', AICO_DESKTOP_DIALOG_TOKEN:'private' },
      spawnProcess:() => assert.fail('桌面保存不启动 Python GUI'),
      fetchRequest:async (_url, options) => {
        assert.deepEqual(JSON.parse(options.body), { kind:'pptx', defaultPath });
        assert.equal(options.headers.Authorization, 'Bearer private');
        return { ok:true, json:async () => ({ path:selected }) };
      },
    });
    assert.equal(result, selected);
  }
});

test('桌面目录选择器向 Host 传递当前目录，取消后仍返回 null', async () => {
  const defaultPath = '/tmp/项目目录/演示 文稿';
  const result = await pickProjectDirectoryWithSystemPicker({
    defaultPath,
    environment:{ AICO_DESKTOP_DIALOG_URL:'http://127.0.0.1:45001/pick', AICO_DESKTOP_DIALOG_TOKEN:'private' },
    spawnProcess:() => assert.fail('桌面目录选择不启动 Python GUI'),
    fetchRequest:async (url, options) => {
      assert.deepEqual(JSON.parse(options.body), { kind:'directory', defaultPath });
      return { ok:true, json:async () => ({ path:null }) };
    },
  });
  assert.equal(result, null);
});
