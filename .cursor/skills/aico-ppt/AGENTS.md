# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## 项目是什么

本仓库交付 **独立 Skill + 原装 DSH Desktop 的 PPT 业务插件**，两者共用根目录 `SKILL.md`。交付物 = `SKILL.md`（skill 入口）+ `references/`（使用文档）+ `scripts/`（编辑/验证/导出工具）+ `assets/` 下五套模板 deck（授课 34 页 / 技术分享 37 页 / 工作汇报 46 页 / 任职材料 22 页 / 项目评审 54 页，均为离线单文件）。改动本仓库时，多数工作是维护这套文档与脚本的一致性；当前安装见 `INSTALL.md`，编辑架构见 `docs/architecture.md`；`docs/design/` 仅保留当前契约和未完成增强项。

所有文档、注释、报错信息均为中文，新增内容保持中文。

## 常用命令

```bash
# 安装与依赖体检（退出码：0 就绪 / 1 仍缺 / 2 工具或参数错误）
python3 scripts/install.py inspect                              # 独立 Skill 注册状态
python3 scripts/check_deps.py --profile editor-core --check-only # 动手前基础体检
python3 scripts/check_deps.py --profile full --check-only       # 全能力体检
py -3 scripts\check_deps.py --profile editor-core --check-only  # Windows PowerShell

# verify 三件套（退出码契约：0 通过 / 1 检测到问题 / 2 工具或参数错误）
node scripts/verify/measure_overflow.mjs <deck.html> --all       # 全页溢出检测（也可只传若干 data-label）
node scripts/verify/shot.mjs <deck.html> <页label> /tmp/p.jpg     # 单页 1920×1080 截图（build 全显）
node scripts/verify/steps.mjs <deck.html> <页label> /tmp/steps    # 放映态动画逐拍截图

# HTML → PPTX（跨平台；layer 多标签页自动逐标签展开）
python3 scripts/html2pptx/convert.py <deck.html> [out.pptx]  # macOS / Linux
py -3 scripts\html2pptx\convert.py <deck.html> [out.pptx]  # Windows PowerShell

# 品牌图替换（默认只打印预览，加 --yes 才落盘；target: bg|board|people|logo）
python3 scripts/apply_bg.py <deck.html> <new-image> --target bg --yes

# Editor 回归测试
npm run test:editor:unit    # Node 单元测试
npm run test:editor:python  # Python 单元测试
npm run test:editor:e2e     # 真实 Chrome E2E
npm run test:editor         # 全部串行执行
```

依赖：独立 Skill 使用 Node ^18.19 或 ≥20.6 + 本机 Google Chrome + playwright-core（查找顺序：`PLAYWRIGHT_CORE` 环境变量 → `import('playwright-core')` → openclaw 内置路径）；当前 Windows 桌面完整包携带私有 Python 和浏览器，不依赖旧修改版 Host 的专用渲染服务。edit-bundle.py、extract-pptx.py 与 PPTX 截图组装器只用 Python 标准库，HTML 附件图标另用 Pillow。参考 PPTX 运行 `python3 scripts/extract-pptx.py 参考.pptx 输出目录`，按页提取标题、正文、备注、表格与内嵌原图，供 AI 阅读；不生成版式预览、不转 PDF。`pptx-read` 检查随包提取器；`materials` 仅检查 PyMuPDF 与 pypdf，普通 PDF 操作用 PyMuPDF，AcroForm 字段填写用 pypdf。随包 `.agents/skills/pdf/` 已适配此依赖集，不用上游重装覆盖。当前桌面接口见 [DSH 接入](integrations/dsh/README.md)与 [私有运行时约束](docs/adr/0007-plugin-private-runtime.md)。

仓库没有独立 lint 或构建步骤。Editor 回归测试由 Node 内置 test runner、Python unittest 与真实 Chrome E2E 组成，通过 `package.json` 的 `test:editor:*` 命令统一运行；模板 Deck 改动还必须跑 verify 三件套以及 `eb.verify(path)` 的结构一致性检查。

## 核心架构：单文件 bundle 格式

deck HTML 是「独立版」bundle（当前五套模板均约 223 行），关键在两个 `<script>`：

- `<script type="__bundler/manifest">`：一行 JSON dict `{uuid: {mime, compressed, data(base64)}}`，内联全部图片/字体/React 运行时。
- `<script type="__bundler/template">`：一行 JSON 字符串，内容是**整份 deck 的 HTML**（所有 `<section data-label=...>` 幻灯片、`nav[]` 导航数组、`chapters[]` 章节起点都在这个字符串里）。

因此**绝不能用编辑器/Edit 工具直改 deck 文件**——必须经 `scripts/edit-bundle.py`：

```python
import importlib.util
spec = importlib.util.spec_from_file_location('eb', 'scripts/edit-bundle.py')
eb = importlib.util.module_from_spec(spec); spec.loader.exec_module(eb)

lines = eb.load('my-deck.html')
s = eb.get_template(lines)        # 解码出 deck HTML 字符串
s = s.replace('旧文案', '新文案')
eb.set_template(lines, s)         # 回填，自动做转义与断言
eb.save('my-deck.html', lines); eb.verify('my-deck.html')
```

edit-bundle 的不变量（改该脚本时必须保持）：

1. 编码只走 `dump_template()`：`json.dumps(s, ensure_ascii=False).replace('</', '<\\u002F')` —— 只转义 `</`（防 `</script>` 提前闭合），CJK 与 URL 中的 `/` 不动；回填后断言 `'</' not in raw` 且 `json.loads(raw) == s`。
2. 增删移页必须三处同步：slide DOM / `nav[]` / `chapters[]`。`insert_page` / `delete_page` / `move_page` 已封装好，勿绕过。
3. `data-idx` 必须是数字。

动画引擎规则（steps.mjs 与 deck 运行时保持一致，改一处须同步另一处）：`build` 元素按 `data-step` 与点击计数 level 显隐；`layer` 按钮/面板同 key 同 group 联动 `data-active`；总拍数 = 页内最大 `data-step` + 2。

通用外壳的缩放运行时保持一致：`Ctrl/Cmd + 滚轮` / `+/-` 只缩放 slide canvas，倍率写入 `deck-template-zoom-v1` 并在刷新后恢复；非 100% 时 navbar 用 `data-zoomed` 液态展开无底色四角百分比复位控件。用户点击右上角播放 / 滚动按钮时复位 100%，但初始化 `setMode()` 不得清倍率。滚动态必须锚定当前页，缩放与 `scrollTop` 校正在同一帧完成，连续输入每帧最多应用一次。`ResizeObserver` 只缓存 `contentRect`，再经 `requestAnimationFrame(fit)` 写样式；外层 bundle error sink 仅忽略两种已知的 ResizeObserver loop 无害告警，不能吞掉其他错误。

## 文档一致性

`SKILL.md` 与 `references/*.md` 互相交叉引用（每条设计铁律指向对应 reference，README 复述了目录结构与快速上手）。改脚本行为、命令用法、页数（授课 34 / 技术分享 37 / 汇报 46 / 任职 22 / 评审 54）或铁律时，检查并同步 `SKILL.md`、`README.md` 与相关 reference。各 reference 分工见 `SKILL.md` 的「文件导航」表。

## 本地试装

Codex 的标准用户级注册位置是 `~/.agents/skills/aico-ppt`。开发时运行 `python3 scripts/install.py install --skill-only` 建立受控软链接；Windows PowerShell 使用 `py -3 scripts\install.py install --skill-only` 建立 junction。改动会即时同步。

## 插件项目与会话生命周期

新增或修改项目导入、移除、恢复、会话绑定、工作区登记时，必须遵循 Harness 的[插件项目生命周期规范](../AICO-Harness-Plugin/docs/extension-design/project-lifecycle.md)。发布包不包含相邻仓库时，到 AICO-Harness-Plugin 仓库读取 `docs/extension-design/project-lifecycle.md`。PPT 的适配细节与验证记录见 [项目生命周期](docs/design/project-lifecycle.md)。不要根据目录相同推断会话归属，不要以隐藏首页记录代替归档关联会话。

任职材料模板新增 `assets/qualification-deck.html`（22 页通用占位模板），目录 ID 为 `qualification`，使用边界和页型索引见 `references/qualification-template.md`。运行时升级必须按此模板类型解析，不能误判为授课模板。新模板不包含个人案例图片或历史编辑补丁，使用当前公共运行时。

项目评审模板新增 `assets/project-review-deck.html`（54 页、10 章可填写页型），目录 ID 为 `project-review`。原始 53 页 PPTX 位于 `assets/project-review-refs/`，字段及来源映射见 `references/project-review-template.md`。模板不预置真实项目数据或通过结论。
