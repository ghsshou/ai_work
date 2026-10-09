---
name: charter-maker
description: Use when the user asks for a 立项, charter, or proposal slide, a one-page 面向场景 / 竞争力目标 / 技术挑战 banner beside three 关键技术, or when technique boxes on an architecture slide look like a table or a pile of nouns. Also use when they name charter-maker.
---

# 立项单页

一页 16:9。标题下是三行横幅，左半页是有先后的框图，右半页是三项关键技术。框里只写技术点名称，先后写在框外。

绘图用 `pptx-layered-arch-diagram` 的 `arch_kit.py` 和 `render.sh`。配色用 AICO-PPT，不要蓝 / 橙 / 绿彩虹。框架侧这一页的文字在 `docs/design-simulator/框架侧DAG仿真能力.md`，生成脚本是 `docs/design-simulator/scripts/build_framework_dag_v3.py`。负载引擎那一页仍是 `设计态仿真器_负载引擎立项_*.pptx` 和 `scripts/build_pptx.py`，两套名字不要混用。

## 页面分区

| 区域 | 位置与内容 |
|---|---|
| 眉题 + 标题 | 顶上红线。眉题一行，主标题一句结论 |
| 横幅 | 三行：面向场景、竞争力目标、技术挑战。按本题重写这三行 |
| 栏题 | 横幅**下面**再写「能力结构」「关键技术」。栏题不能压进横幅 |
| 左图 | x 约 0.22–6.56，y 约 2.16–7.14。输入层 → 核心层 → 输出层 |
| 右栏 | x 约 6.72–13.08，三张卡，和左图的三段对齐 |

用户没有把「已具备」算进这一页时，不画仿真核，也不画灰色已具备层。输入层下面就是核心层。

左图层名写在窄色条上。两个字以上的层名用 `\n` 拆开，例如 `DAG\n引擎`，避免一个汉字被折成两行。

## 框图怎么表达逻辑

先写顺序，再画框。每组大约 4 个名称，一行不要排到 6 个。

| 关系 | 画法 |
|---|---|
| 同时抽出、互不合并 | 一排圆角矩形 |
| 有先后的动作 | 横向 chevron，从左到右 |
| 两条链同时进行 | 两张并排的纵向泳道，每条泳道自上而下，步与步之间用向下箭头 |
| 汇合后再分出 | 泳道下方一个枢纽框（如「执行图」），再指向约 4 个名词框 |

圆角矩形放名词（来源、图）。chevron 和泳道里的步骤放动作。框外一句短话写这一步在干什么，例如「四条来源同时抽出」「两链汇合后，从执行图分出四张域图」。

模块标题写成「方法 + 对象」，并带 ①②③。

## 右栏三张卡

每张卡固定成：

```
关键技术 N
一句标题（和左图这一段是同一件事）
1）引导词：一句有先后的话
2）引导词：一句有先后的话
```

句子写顺序，不把名词逗号堆成一行。一行放不下时在分句处断开，不要把「重放」「映射」「同一」拆到下一行。

## 配色

| 用途 | 色 |
|---|---|
| 核心层、栏目标记 | `#b5333b` |
| 核心层浅底 | `#fdf0f1` |
| 输入 / 输出层名 | `#566472` |
| 页底 | `#fafafa` |
| 正文 | `#585860` |
| 标题字 | `#1a1a1c` |
| 卡片边 | `#e7e7e7` |

字体用微软雅黑。红色只标这一页的核心，不要大面积红底。

## 改版

版本只增不删。新的 PPT 和生成脚本用下一个编号，旧文件留着，并更新 `docs/design-simulator/README.md` 的版本表。改框架侧这一页的文字时，先改 `docs/design-simulator/框架侧DAG仿真能力.md`，再改 `build_framework_dag_v*.py`。不要改到 `build_pptx.py` 或 `设计态仿真器_负载引擎立项_*.pptx`。

生成后运行：

```bash
bash .cursor/skills/pptx-layered-arch-diagram/render.sh <pptx> /tmp/charter
```

看 PNG：文字不溢出、栏题不压横幅、没有一行 6 个等宽格子、同时进行的两条链是并排泳道。
