import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';


const ROOT = new URL('../../../', import.meta.url);


test('初始、新建和修改页面统一只显示 AICO-PPT 品牌名', async () => {
  const pages = [
    'scripts/editor/app-public/index.html',
    'scripts/editor/public/index.html',
  ];
  for (const path of pages) {
    const html = await readFile(new URL(path, ROOT), 'utf8');
    assert.match(html, /<title>AICO-PPT<\/title>/, `${path} 浏览器标题未统一`);
    assert.match(html, />AICO-PPT<\//, `${path} 左上角缺少统一品牌名`);
    assert.doesNotMatch(
      html,
      /AICO-PPT 工作台|Deck 可视化编辑器|从想法到可编辑初版|本地协作工作台/,
      `${path} 仍显示旧产品名或副标题`,
    );
  }

  const landing = await readFile(new URL('scripts/editor/app-public/index.html', ROOT), 'utf8');
  assert.doesNotMatch(
    landing,
    /恢复 Agent 对话与制作进度|恢复工作副本与 Agent 上下文/,
    '初始页任务卡仍显示恢复说明',
  );
});
