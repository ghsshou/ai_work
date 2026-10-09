#!/usr/bin/env python3
"""Framework DAG slide v2: AICO-PPT palette, more technique boxes, no sim-kernel layer."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / ".cursor/skills/pptx-layered-arch-diagram"))

from pptx.dml.color import RGBColor  # noqa: E402
from pptx.enum.shapes import MSO_SHAPE  # noqa: E402
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN  # noqa: E402
from pptx.util import Inches  # noqa: E402

from arch_kit import (  # noqa: E402
    blank,
    footer as kit_footer,
    grid,
    new_deck,
    rbox,
    rect,
    shape,
    text,
)

OUT = ROOT / "docs/design-simulator/设计态仿真器_框架DAG仿真能力_v2.pptx"

# AICO-PPT design-system.md: red for the focus, gray-blue for structure.
RED = RGBColor(0xB5, 0x33, 0x3B)
RED_SOFT = RGBColor(0xFD, 0xF0, 0xF1)
SLATE = RGBColor(0x56, 0x64, 0x72)
INK = RGBColor(0x1A, 0x1A, 0x1C)
BODY = RGBColor(0x58, 0x58, 0x60)
LINE = RGBColor(0xE7, 0xE7, 0xE7)
PAPER = RGBColor(0xFA, 0xFA, 0xFA)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
FIELD = RGBColor(0xF5, 0xF5, 0xF6)

DIAG_LEFT, DIAG_RIGHT = 0.22, 6.56
DIAG_TOP, DIAG_BOTTOM = 2.12, 7.14
TAG_W = 0.68
ARROW = 0.15

INPUTS = ["训练框架", "推理框架", "RL 框架", "模型结构", "框架源码", "运行 Trace"]
OUTPUTS = ["训练执行图", "推理执行图", "RL 闭环图", "网络流量图", "内存访存图", "吞吐瓶颈对照"]

MODULES = [
    ("① 基于多源的\n图抽取", [
        "模型结构\n解析", "源码静态\n抽取", "框架 IR\n抽取",
        "运行 Trace\n回填", "算子库\n映射", "子图模板\n导入",
    ]),
    ("② 面向仿真的\n实例化", [
        "算子\n实例化", "张量形状\n绑定", "精度类型\n绑定",
        "控制流\n展开", "动态 Shape\n展开", "多框架\n图归一",
    ]),
    ("③ 面向规模的\n并行改写", [
        "小集群\n映射", "大卡拓扑\n展开", "数据并行\n切分",
        "张量并行\n切分", "流水并行\n切段", "专家并行\n展开",
    ]),
    ("④ 面向序列的\n精度改写", [
        "长序列\n切块", "Prefix\n复用", "KV 缓存\n图",
        "量化\n改写", "算子\n融合", "重计算\n插入",
    ]),
    ("⑤ 网络与\n访存图衍生", [
        "集合通信\n图", "点对点\n流量图", "内存容量\n图",
        "数据读取\n图", "访存带宽\n图", "存储层级\n图",
    ]),
    ("⑥ 面向约束的\n编排对照", [
        "依赖\n展开", "算子\n调度", "执行序\n编排",
        "流水\n微批次", "设备流\n绑定", "多场景\n重放",
    ]),
]

BANNER = [
    ("面向场景",
     "面向训练、推理、RL 等框架负载的端到端行为仿真，对照不同规模、资源、调度与并行限制下的吞吐、排队及瓶颈"),
    ("竞争力目标",
     "从模型结构与源码导出统一 DAG，按场景动态变换出大卡执行图及网络、内存读取图，形成可复用的框架级泛化仿真"),
    ("技术挑战",
     "训练、推理、RL 框架迭代快，结构、源码与运行图粒度不一；规模、并行、序列、通信和访存一变，静态 DAG 难以统一表征"),
]

TECHS = [
    ("关键技术 1", "多源抽取与可仿真 DAG 实例化", [
        ("多源成图：",
         "结构解析、源码抽取、框架 IR、Trace 回填、算子映射和模板导入。"),
        ("实例化对齐：",
         "实例化算子，绑定形状与精度，展开控制流和动态 Shape，归一成一套 DAG。"),
    ]),
    ("关键技术 2", "按场景改写执行图并派生域图", [
        ("规模与序列：",
         "小集群映射到大卡，展开数据、张量、流水、专家并行，以及长序列、Prefix、KV、量化、融合和重计算。"),
        ("域图衍生：",
         "集合通信、点对点流量、内存容量、数据读取、访存带宽、存储层级。"),
    ]),
    ("关键技术 3", "资源约束下的编排与场景对照", [
        ("执行编排：",
         "依赖展开、算子调度、执行序、流水微批次，并把算子绑定到设备与流。"),
        ("场景对照：",
         "在同一 DAG 族上切换规模、资源、调度和并行限制，重放并比较吞吐、排队与瓶颈。"),
    ]),
]


def _down_arrow(slide, x, y) -> None:
    shape(slide, MSO_SHAPE.DOWN_ARROW, x - Inches(0.13), y, Inches(0.26), Inches(0.11), SLATE, adj=0.5)


def _tag(slide, x, y, h, name, sub, fill) -> None:
    rect(slide, x, y, Inches(TAG_W), h, fill)
    lines = [[(part, 10, True, WHITE)] for part in name.split("\n")]
    if sub:
        lines.append([(sub, 8, False, WHITE)])
    text(slide, x, y, Inches(TAG_W), h, lines, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)


def _simple_row(slide, x, y, w, h, items) -> None:
    rbox(slide, x, y, w, h, FIELD, LINE, 0.9, 0.04)
    pad = Inches(0.05)
    grid(slide, x + pad, y + pad, w - 2 * pad, h - 2 * pad, items, len(items), WHITE, LINE, 8.5, 0.04)


def _core(slide, x, y, w, h) -> None:
    rbox(slide, x, y, w, h, RED_SOFT, RGBColor(0xE0, 0xA3, 0xA7), 1.0, 0.03)
    pad, gap = Inches(0.05), Inches(0.04)
    inner_h = h - 2 * pad - gap * (len(MODULES) - 1)
    row_h = inner_h / len(MODULES)
    title_w = Inches(1.18)
    for i, (title, items) in enumerate(MODULES):
        yy = y + pad + i * (row_h + gap)
        rbox(slide, x + pad, yy, w - 2 * pad, row_h, WHITE, LINE, 0.8, 0.08)
        text(slide, x + pad + Inches(0.04), yy, title_w, row_h, title,
             9, True, RED, PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
        gx = x + pad + title_w + Inches(0.02)
        gw = w - 2 * pad - title_w - Inches(0.06)
        gpad = Inches(0.04)
        grid(slide, gx, yy + gpad, gw, row_h - 2 * gpad, items, 6, RED_SOFT, LINE, 7.5, 0.03)


def _diagram(slide) -> None:
    tag_x = Inches(DIAG_LEFT)
    x = tag_x + Inches(TAG_W + 0.05)
    right = Inches(DIAG_RIGHT)
    w = right - x
    top = DIAG_TOP
    bottom = DIAG_BOTTOM
    input_h, core_h, output_h = 0.36, 0, 0.40
    core_h = (bottom - top) - input_h - output_h - 2 * ARROW
    y = top
    _tag(slide, tag_x, Inches(y), Inches(input_h), "输入层", None, SLATE)
    _simple_row(slide, x, Inches(y), w, Inches(input_h), INPUTS)
    y += input_h
    _down_arrow(slide, x + w / 2, Inches(y + 0.02))
    y += ARROW
    _tag(slide, tag_x, Inches(y), Inches(core_h), "DAG\n引擎", "本页核心", RED)
    _core(slide, x, Inches(y), w, Inches(core_h))
    y += core_h
    _down_arrow(slide, x + w / 2, Inches(y + 0.02))
    y += ARROW
    _tag(slide, tag_x, Inches(y), Inches(output_h), "输出层", None, SLATE)
    _simple_row(slide, x, Inches(y), w, Inches(output_h), OUTPUTS)


def _banner(slide) -> None:
    top, height = 0.78, 1.16
    rbox(slide, Inches(0.22), Inches(top), Inches(12.88), Inches(height), WHITE, LINE, 0.9, 0.05)
    row_h = height / len(BANNER)
    for i, (name, body) in enumerate(BANNER):
        y = top + i * row_h
        rect(slide, Inches(0.36), Inches(y + 0.10), Inches(0.07), Inches(row_h - 0.20), RED)
        text(slide, Inches(0.52), Inches(y), Inches(1.22), Inches(row_h), name,
             12, True, RED, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)
        text(slide, Inches(1.78), Inches(y), Inches(11.10), Inches(row_h), body,
             12, False, INK, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)


def _tech_column(slide) -> None:
    left, right = 6.72, 13.08
    top, bottom = DIAG_TOP, DIAG_BOTTOM
    width = right - left
    gap = 0.07
    card_h = (bottom - top - gap * (len(TECHS) - 1)) / len(TECHS)
    text(slide, Inches(left), Inches(top - 0.22), Inches(width), Inches(0.20),
         "关键技术", 12, True, RED, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)
    for i, (kicker, title, points) in enumerate(TECHS):
        y = top + i * (card_h + gap)
        rbox(slide, Inches(left), Inches(y), Inches(width), Inches(card_h), WHITE, LINE, 0.9, 0.06)
        rect(slide, Inches(left), Inches(y + 0.08), Inches(0.07), Inches(card_h - 0.16), RED)
        text(slide, Inches(left + 0.18), Inches(y + 0.05), Inches(width - 0.30), Inches(0.22),
             kicker, 11, True, RED)
        text(slide, Inches(left + 0.18), Inches(y + 0.26), Inches(width - 0.30), Inches(0.26),
             title, 13, True, INK)
        slot_top = y + 0.54
        slot_h = (card_h - 0.62) / 2
        for n, (lead, desc) in enumerate(points):
            text(
                slide,
                Inches(left + 0.18),
                Inches(slot_top + n * slot_h),
                Inches(width - 0.32),
                Inches(slot_h),
                [[(f"{n + 1}）{lead}", 11, True, INK), (desc, 11, False, BODY)]],
                anchor=MSO_ANCHOR.TOP,
            )


def build() -> None:
    prs = new_deck()
    slide = blank(prs)
    rect(slide, 0, 0, prs.slide_width, prs.slide_height, PAPER)
    rect(slide, 0, 0, prs.slide_width, Inches(0.06), RED)
    text(slide, Inches(0.28), Inches(0.12), Inches(12.6), Inches(0.24),
         "设计态 AI 集群仿真器  ·  框架侧仿真能力", 12, True, RED)
    text(slide, Inches(0.28), Inches(0.36), Inches(12.7), Inches(0.38),
         "从多框架导出统一 DAG，并按场景变换为大规模执行图与网络、访存图",
         20, True, INK)
    _banner(slide)
    text(slide, Inches(DIAG_LEFT), Inches(DIAG_TOP - 0.22), Inches(3.4), Inches(0.20),
         "能力结构", 12, True, SLATE, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)
    _diagram(slide)
    _tech_column(slide)
    kit_footer(slide, "框架侧仿真能力  ·  立项讨论稿", 1, 1)
    # Recolor the kit footer accent to brand red.
    rect(slide, 0, Inches(7.26), Inches(0.16), Inches(0.24), RED)
    notes = slide.notes_slide.notes_text_frame
    notes.text = (
        "本页不接仿真核。输入直接进入 DAG 引擎，引擎之后是输出层。\n"
        "DAG 创建拆成抽取与实例化：结构、源码、IR、Trace、算子库、模板；"
        "再做算子实例化、形状、精度、控制流、动态 Shape、多框架归一。\n"
        "DAG 变换拆成三条：规模与四种并行；长序列、Prefix、KV、量化、融合、重计算；"
        "以及通信、流量、内存容量、数据读取、访存带宽、存储层级六张派生图。\n"
        "DAG 编排拆成依赖、调度、执行序、流水微批次、设备流绑定和多场景重放。\n"
        "配色遵循 AICO-PPT：品牌红 #b5333b 只标本页核心，结构用灰蓝 #566472。"
    )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    prs.save(OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    build()
