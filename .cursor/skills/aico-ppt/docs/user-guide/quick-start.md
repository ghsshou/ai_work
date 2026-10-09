# 3 分钟开始使用

预计时间：3—5 分钟。

## 前置状态

- AICO-PPT Skill 已注册；
- 使用独立 Skill：在支持 Skill 和本地工具的 Agent 中加载 `aico-ppt`；
- 使用可视化编辑：AICO-Harness 已安装 AICO-PPT 插件，Editor Core 已就绪。

## 操作步骤

1. 在 AICO-Harness 左侧点击 `AICO-PPT`，打开右侧编辑工作台。
2. 第一次使用先点击“安装与诊断”，确认“基础使用”没有阻塞项。
3. 点击“开始使用”，再点击“创建示例副本”。
4. 选择一个空目录；Editor 会复制一份示例 Deck，不修改内置模板。
5. 确认项目目录并打开编辑器，通过 Harness 左侧“新会话”的 AICO-PPT 项目选项创建关联会话。
6. 在左侧关联会话输入：“把封面标题改成我的第一个 AICO-PPT”。
7. 在画布中确认变化；需要永久写回时点击“固化修改”。

## 完成标志

- 示例 Deck 能在中间画布显示；
- 左侧显示该 Deck 的关联会话；
- 修改后可撤销、重做和固化。

## 下一步

无需窗口时，运行 `python3 scripts/install.py install`（Windows：`py -3 scripts\install.py install`），新开 Agent 任务并使用 `aico-ppt`。独立 Skill 可以制作、修改、验证和导出 Deck；完成后交付 HTML，不自动打开 Dev Shell。基础安装不要求 AICO-Harness 或额外 Agent 终端。

- 从零制作：阅读“创建 Deck”；
- 修改已有文件：阅读“修改现有 Deck”；
- 环境报错：进入“安装与诊断”或阅读“故障排查”。
