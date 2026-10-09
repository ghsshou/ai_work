import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';


export const HELP_TOPIC_DEFINITIONS = Object.freeze([
  { id:'quick-start', title:'3 分钟开始使用', summary:'安装完成后，用示例副本走通第一条任务。', file:'docs/user-guide/quick-start.md' },
  { id:'create-deck', title:'创建 Deck', summary:'从项目目录、Draft 和 Agent 对话开始制作。', file:'docs/user-guide/create-deck.md' },
  { id:'edit-deck', title:'修改现有 Deck', summary:'安全打开 HTML，在托管工作副本中继续修改。', file:'docs/user-guide/edit-deck.md' },
  { id:'preview-and-tasks', title:'预览与区域任务', summary:'理解预览、编辑、区域标记和任务批次。', file:'docs/user-guide/preview-and-tasks.md' },
  { id:'verify-and-export', title:'验证与导出', summary:'按需启用验证和 PPTX 导出能力。', file:'docs/user-guide/verify-and-export.md' },
  { id:'shortcuts', title:'快捷键', summary:'Editor 与 Deck 放映的常用键位。', file:'docs/user-guide/shortcuts.md' },
  { id:'install', title:'安装、修复与卸载', summary:'macOS、Windows 的完整安装流程。', file:'INSTALL.md' },
  { id:'troubleshooting', title:'故障排查', summary:'从稳定错误码和结构化诊断恢复。', file:'docs/user-guide/troubleshooting.md' },
]);


export async function buildHelpCatalog({ projectRoot = resolve('.') } = {}) {
  const root = resolve(projectRoot);
  const topics = await Promise.all(HELP_TOPIC_DEFINITIONS.map(async definition => {
    const path = resolve(root, definition.file);
    const relativePath = relative(root, path);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`帮助主题越出项目目录：${definition.file}`);
    }
    const markdown = await readFile(path, 'utf8');
    return { ...definition, markdown };
  }));
  return { schemaVersion:1, topics };
}
