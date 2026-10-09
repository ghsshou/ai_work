import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';


const ROOT = new URL('../../../', import.meta.url);


test('安装入口文档统一使用跨平台安装器和 Codex 标准 Skill 路径', async () => {
  const files = ['INSTALL.md', 'SKILL.md', 'AGENTS.md', 'docs/architecture.md'];
  for (const file of files) {
    const contents = await readFile(new URL(file, ROOT), 'utf8');
    assert.match(contents, /scripts[\\/]install\.py/, `${file} 缺少统一安装器入口`);
    assert.match(contents, /\.agents\/skills\/aico-ppt/, `${file} 缺少标准 Skill 注册位置`);
  }
});

test('依赖文档按 editor-core、dev-shell、verify、pptx-export、pptx-read、materials 分层', async () => {
  const files = [
    'INSTALL.md', 'SKILL.md',
    'references/editing-guide.md', 'docs/architecture.md',
  ];
  for (const file of files) {
    const contents = await readFile(new URL(file, ROOT), 'utf8');
    for (const profile of ['editor-core', 'dev-shell', 'verify', 'pptx-export', 'pptx-read', 'materials']) {
      assert.match(contents, new RegExp(profile), `${file} 缺少 ${profile} Profile`);
    }
  }
});


test('Editor 用户指南覆盖首用、创建、修改、任务、验证、快捷键和排障', async () => {
  const files = [
    'docs/user-guide/quick-start.md',
    'docs/user-guide/create-deck.md',
    'docs/user-guide/edit-deck.md',
    'docs/user-guide/preview-and-tasks.md',
    'docs/user-guide/verify-and-export.md',
    'docs/user-guide/shortcuts.md',
    'docs/user-guide/troubleshooting.md',
  ];
  for (const file of files) {
    const contents = await readFile(new URL(file, ROOT), 'utf8');
    assert.match(contents, /^# /, `${file} 缺少一级标题`);
    assert.ok(contents.length > 180, `${file} 内容过短`);
  }
});

test('仓库首页将安装和依赖明细交给安装指南',async()=>{
 const text=await readFile(new URL('README.md',ROOT),'utf8');
 assert.match(text,/\(INSTALL\.md\)/);assert.match(text,/scripts\/install\.py install --skill-only/);
});
