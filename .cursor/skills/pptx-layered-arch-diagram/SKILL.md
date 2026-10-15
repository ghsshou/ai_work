---
name: pptx-layered-arch-diagram
description: >-
  Draw a top-to-bottom layered architecture diagram (nested boxes, technique
  names only) on a 16:9 PowerPoint slide with python-pptx. Use when the user
  asks for an architecture / 框图 / 架构图 / 方框图 slide, a 立项 or proposal slide
  showing system layers and core technologies, or wants to reuse the 设计态仿真器负载引擎
  diagram style.
---
# PPT 分层架构框图

用 python-pptx 画「自上而下分层 + 方框嵌套」的架构图。配套文件和本 SKILL.md 放在同一目录（下文记作 `$SKILL_DIR`，即 `/home/box/agent-data/workflows/pptx-layered-arch-diagram`；仓库内原始位置是 `.cursor/skills/pptx-layered-arch-diagram`）：

- `arch_kit.py`：按配置（SPEC）绘图的库，含配色、分层色块、模块嵌套、流水线箭头和反馈箭头
- `example.py`：完整示例（设计态仿真器负载引擎，架构图占左侧 2/3）
- `render.sh`：用 LibreOffice 渲染成 PNG，便于检查

## 版式规则（来自用户反馈，必须遵守）

1. **从上到下排版**：输入层 → 核心层（高亮） → 已具备能力层（灰色） → 输出层，层间用向下箭头连接；左侧用色块标出层名。立项页若用户未要求「已具备」，可省略灰色层，输入直接到核心再到输出。
2. **框图只放方框，不写描述**：子框只写技术点名称，不写展开说明、不用 bullet。解释性文字放到备份页或演讲者备注。
3. **方框可以嵌套**：层 → 模块框 → 子框。模块标题写成「方法 + 对象/作用」，例如「基于计算图展开的模型负载画像」「统一负载 IR 与多保真导入」。「负载画像」这类笼统的名字必须加上做法前缀，或在子框里写出具体做法。
4. **每个模块约 4 个子框（默认）**：超过 4 个就合并相近的项，不要堆到一行 6 个。用户要求更高密度时，可用约 **8** 个子框排成 **2×4** 网格，名称保持短词。
5. **模块编号 ①②③…**。**新立项 / charter 页**用 AICO-PPT：核心层标签 `#b5333b`、外层浅底 `#fdf0f1`，不要橙/蓝/绿彩虹。旧负载引擎示例仍可用 `tone: "core"|"blue"|"gray"|"green"` 兼容色。
6. **左图描边与末级填充（立项新页）**：模块容器、末级技术点、输入/输出小块描边用深灰 `#5a5a5e`；末级技术点与输入/输出小块白底 `#FFFFFF`。多个并列核心子层/模块带可用低饱和分带底（示例 `#eef2f6` / `#f7f0f1` / `#eef5f0`）。右栏关键技术卡片可用浅边 `#e7e7e7`。
7. **按要求留白**：用户要给右侧留位置时，用 `right=8.86` 把图收进左 2/3，右侧不放占位框。
8. **版本只增不删**：迭代时把旧版另存为 `_v1`、`_v2`…（PPT 和生成脚本都保留），新版用下一个编号，并在 README 里列出版本表。
9. **备用纯文字页（可选）**：末级点很多时可加一页纯文字技术点列表（含输入/输出项与短注），标「备用页 · 不进正式稿」，页码 `01/N`。

`arch_kit` 常量：`DIAG_LINE`（深灰描边）、`LEAF_FILL`（白底）、`BAND_FILLS`（分带浅底示例）、`aico_tones()`（红/灰立项配色）。`grid(..., cols=4)` 可画 2×4。

## 用法

```python
import sys; sys.path.insert(0, "/home/box/agent-data/workflows/pptx-layered-arch-diagram")  # 或仓库内 .cursor/skills/pptx-layered-arch-diagram
from arch_kit import new_deck, blank, title_block, footer, draw_layered_arch

SPEC = [
    {"name": "输入层", "tone": "blue", "h": 0.46, "items": ["A", "B", "C", "D"]},
    {"name": "核心引擎", "sub": "本项目核心", "tone": "core", "h": 3.92, "columns_h": 1.86,
     "columns": [{"title": "① 基于X的\nY建模", "items": ["t1", "t2", "t3", "t4"]}, ...],  # 纵向模块；密度版 items 可 8 个并用 cols=4
     "rows": [{"title": "④ 流水线", "items": [...], "chevron": True}, ...]},             # 横向模块
    {"name": "已有内核", "sub": "已具备", "tone": "gray", "h": 0.44, "feedback": True, "items": [...]},
    {"name": "设计输出", "tone": "green", "h": 0.5, "items": [...]},
]
prs = new_deck(); s = blank(prs)
title_block(s, "眉题", "主标题：结论式一句话", "副标题")
draw_layered_arch(s, SPEC, left=0.36, right=8.86, top=1.2, bottom=7.2)  # 全宽用 right=12.97
footer(s, "页脚说明", 1, 2)
prs.save("out.pptx")
```

- 标签里的 `\n` 表示强制换行，换行后仍居中。子框较窄时，每行控制在约 8 个汉字。
- `chevron: True` 把这一行画成流水线箭头（适合「采集 → 清洗 → … → 入库」这类流程）。
- `feedback: True` 在该层上方右侧画一个向上的橙色箭头，表示结果回流（如校准）。
- 各层 `h` 之和加层间距超出 `top..bottom` 时会抛出 ValueError，此时调小 `h` 或精简层级。

## 流程

1. 先列出层级和模块，每个模块写出「方法 + 对象」式标题和默认 4（或密度版 8 / 2×4）个子框名称，再写 SPEC。
2. 生成 PPT，然后运行 `bash /home/box/agent-data/workflows/pptx-layered-arch-diagram/render.sh out.pptx /tmp/r`，并用读图工具检查 PNG：不能有文字溢出、意外折行或错位。如果有，缩短标签或手动加 `\n`。
3. 依赖：`pip install python-pptx pymupdf`；渲染需要 LibreOffice（`apt-get install libreoffice-impress`）以及中文字体（如 `fonts-wqy-microhei`）。
