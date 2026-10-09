#!/usr/bin/env python3
"""Framework DAG slide v3: three-stage flow, about four boxes per step, no table grid."""

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
    label,
    new_deck,
    rbox,
    rect,
    shape,
    text,
)

OUT = ROOT / "docs/design-simulator/设计态仿真器_框架DAG仿真能力_v3.pptx"

# AICO-PPT: brand red marks the page focus; slate marks structure.
RED = RGBColor(0xB5, 0x33, 0x3B)
RED_SOFT = RGBColor(0xFD, 0xF0, 0xF1)
RED_LINE = RGBColor(0xE0, 0xA3, 0xA7)
SLATE = RGBColor(0x56, 0x64, 0x72)
INK = RGBColor(0x1A, 0x1A, 0x1C)
BODY = RGBColor(0x58, 0x58, 0x60)
LINE = RGBColor(0xE7, 0xE7, 0xE7)
PAPER = RGBColor(0xFA, 0xFA, 0xFA)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
FIELD = RGBColor(0xF5, 0xF5, 0xF6)

DIAG_LEFT, DIAG_RIGHT = 0.22, 6.56
DIAG_TOP, DIAG_BOTTOM = 2.16, 7.14
TAG_W = 0.68
ARROW = 0.11
INPUT_H, OUTPUT_H = 0.32, 0.34

# Rounded rectangles are nouns. Chevrons are ordered steps.
# Scale and sequence are two side-by-side downward chains, not two more rows.
SOURCES = ["模型结构解析", "源码静态抽取", "框架 IR 抽取", "运行 Trace 回填"]
BIND = ["算子\n实例化", "形状精度\n绑定", "控制流\n展开", "多框架\n归一"]
SCALE = ["小集群映射", "大卡拓扑展开", "并行策略切分", "批次并发扩展"]
SEQ = ["长序列切块", "Prefix 复用", "量化改写", "融合与重计算"]
DOMAINS = ["集合通信图", "点对点流量图", "内存容量图", "数据读取图"]
SCHEDULE = ["依赖\n展开", "算子\n调度", "执行序\n编排", "多场景\n重放"]

INPUTS = ["训练框架", "推理框架", "RL 框架", "模型与源码"]
OUTPUTS = ["场景执行图", "网络流量图", "内存访存图", "吞吐瓶颈对照"]

BANNER = [
    ("面向场景",
     "面向训练、推理、RL 等框架负载的端到端行为仿真，对照不同规模、资源、调度与并行限制下的吞吐、排队及瓶颈"),
    ("竞争力目标",
     "从模型结构与源码导出统一 DAG，按场景动态变换出大卡执行图及网络、内存读取图，形成可复用的框架级泛化仿真"),
    ("技术挑战",
     "训练、推理、RL 框架迭代快，结构、源码与运行图粒度不一；规模、并行、序列、通信和访存一变，静态 DAG 难以统一表征"),
]

TECHS = [
    ("关键技术 1", "先抽出，再收成可仿真 DAG", [
        ("并列抽取：",
         "训练、推理、RL 的结构、源码、框架 IR 与运行 Trace 四路同时进入。"),
        ("顺次收束：",
         "先实例化算子，再绑定形状与精度、展开控制流，收成一套 DAG。"),
    ]),
    ("关键技术 2", "按场景改写执行图，并派生域图", [
        ("两条改写链：", (
            "规模链把小集群扩成大卡，并切分并行；",
            "序列链同时做切块、Prefix、量化与重计算。",
        )),
        ("执行图分叉：", (
            "两链汇合后，从执行图分出集合通信、",
            "点对点流量、内存容量和数据读取。",
        )),
    ]),
    ("关键技术 3", "按约束编排，再对照重放", [
        ("编排顺序：", (
            "先展开依赖，再调度算子、排执行序，",
            "最后按规模、资源和并行限制重放。",
        )),
        ("对照产出：",
         "得到场景执行图、网络流量图、内存访存图，以及吞吐、排队和瓶颈。"),
    ]),
]


def _down_arrow(slide, cx, y, h=0.10) -> None:
    shape(
        slide, MSO_SHAPE.DOWN_ARROW,
        Inches(cx - 0.10), Inches(y), Inches(0.20), Inches(h),
        SLATE, adj=0.5,
    )


def _tag(slide, x, y, h, name, sub, fill) -> None:
    rect(slide, Inches(x), Inches(y), Inches(TAG_W), Inches(h), fill)
    lines = [[(part, 10, True, WHITE)] for part in name.split("\n")]
    if sub:
        lines.append([(sub, 8, False, WHITE)])
    text(slide, Inches(x), Inches(y), Inches(TAG_W), Inches(h), lines,
         align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)


def _cards(slide, x, y, w, h, items, size=10) -> None:
    gap = 0.06
    cw = (w - gap * (len(items) - 1)) / len(items)
    for i, lab in enumerate(items):
        sh = rbox(
            slide, Inches(x + i * (cw + gap)), Inches(y), Inches(cw), Inches(h),
            WHITE, LINE, 0.9, 0.12,
        )
        label(sh, lab, size, False, INK)


def _flow(slide, x, y, w, h, items, size=9) -> None:
    """Ordered steps. Later chevrons cover the previous tip, so the row reads left to right."""
    n = len(items)
    overlap = 0.04
    cw = (w - overlap) / n
    for i, lab in enumerate(items):
        kind = MSO_SHAPE.PENTAGON if i == 0 else MSO_SHAPE.CHEVRON
        extra = overlap if i < n - 1 else 0.0
        sh = shape(
            slide, kind,
            Inches(x + i * cw), Inches(y), Inches(cw + extra), Inches(h),
            WHITE, LINE, 0.9, adj=0.20,
        )
        label(sh, lab, size, False, INK)


def _caption(slide, x, y, w, h, body) -> None:
    text(slide, Inches(x), Inches(y), Inches(w), Inches(h), body,
         9, False, BODY, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)


def _title(slide, x, y, w, h, body) -> None:
    text(slide, Inches(x), Inches(y), Inches(w), Inches(h), body,
         11, True, RED, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)


def _lane(slide, x, y, w, h, kicker, hint, items) -> None:
    """One downward chain inside its own card, so the two chains do not form a grid."""
    rbox(slide, Inches(x), Inches(y), Inches(w), Inches(h), WHITE, LINE, 0.9, 0.06)
    text(
        slide, Inches(x + 0.08), Inches(y + 0.03), Inches(w - 0.14), Inches(0.20),
        [[(kicker, 10, True, RED), (f"  {hint}", 9, False, BODY)]],
        align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE,
    )
    pad = 0.08
    inner_x, inner_w = x + pad, w - 2 * pad
    top = y + 0.26
    bottom = y + h - 0.06
    gaps = len(items) - 1
    arrow_h = 0.08
    box_h = (bottom - top - gaps * arrow_h) / len(items)
    yy = top
    for i, lab in enumerate(items):
        sh = rbox(
            slide, Inches(inner_x), Inches(yy), Inches(inner_w), Inches(box_h),
            FIELD, LINE, 0.8, 0.18,
        )
        label(sh, lab, 10, False, INK)
        yy += box_h
        if i < gaps:
            _down_arrow(slide, x + w / 2, yy + 0.008, arrow_h - 0.014)
            yy += arrow_h


def _fork(slide, x, y, w, h, items) -> None:
    hub_w, arrow_w = 0.78, 0.20
    sh = rbox(slide, Inches(x), Inches(y), Inches(hub_w), Inches(h), WHITE, RED, 1.25, 0.14)
    label(sh, "执行图", 10, True, RED)
    shape(
        slide, MSO_SHAPE.RIGHT_ARROW,
        Inches(x + hub_w + 0.02), Inches(y + h * 0.28),
        Inches(arrow_w - 0.04), Inches(h * 0.44),
        SLATE, adj=0.5,
    )
    _cards(slide, x + hub_w + arrow_w, y, w - hub_w - arrow_w, h, items, 9)


def _core(slide, x, y, w, h) -> None:
    rbox(slide, Inches(x), Inches(y), Inches(w), Inches(h), RED_SOFT, RED_LINE, 1.0, 0.03)
    pad_x, pad_y = 0.07, 0.05
    ix, iw = x + pad_x, w - 2 * pad_x
    blocks = [
        ("title", 0.16, "① 先并列抽出，再顺次收成一张 DAG"),
        ("cap", 0.13, "四条来源同时抽出"),
        ("cards", 0.32, SOURCES),
        ("arrow", 0.10, None),
        ("cap", 0.13, "再按顺序收成一套可仿真 DAG"),
        ("flow", 0.34, BIND),
        ("gap", 0.10, None),
        ("title", 0.16, "② 两条链同时改写，汇合后再分出域图"),
        ("lanes", 1.38, None),
        ("cap", 0.14, "两链汇合后，从执行图分出四张域图"),
        ("fork", 0.30, DOMAINS),
        ("gap", 0.10, None),
        ("title", 0.16, "③ 按约束排好序，再对照重放"),
        ("cap", 0.13, "依赖排定之后才调度，调度之后才重放"),
        ("flow", 0.32, SCHEDULE),
    ]
    used = sum(b[1] for b in blocks) + pad_y * 2
    slack = h - used
    if slack < -0.02:
        raise RuntimeError(f"DAG engine overflow by {-slack:.3f} in")
    gap_extra = max(slack, 0) / 2
    cursor = y + pad_y
    mid = x + w / 2
    lane_gap = 0.10
    lane_w = (iw - lane_gap) / 2
    for kind, bh, payload in blocks:
        if kind == "gap":
            bh += gap_extra
            _down_arrow(slide, mid, cursor + 0.015, max(bh - 0.03, 0.06))
        elif kind == "title":
            _title(slide, ix, cursor, iw, bh, payload)
        elif kind == "cap":
            _caption(slide, ix, cursor, iw, bh, payload)
        elif kind == "cards":
            _cards(slide, ix, cursor, iw, bh, payload, 10)
        elif kind == "flow":
            _flow(slide, ix, cursor, iw, bh, payload)
        elif kind == "arrow":
            _down_arrow(slide, mid, cursor + 0.008, bh - 0.016)
        elif kind == "lanes":
            _lane(slide, ix, cursor, lane_w, bh, "规模链", "小集群扩到大卡", SCALE)
            _lane(slide, ix + lane_w + lane_gap, cursor, lane_w, bh, "序列链", "长上下文与精度", SEQ)
        elif kind == "fork":
            _fork(slide, ix, cursor, iw, bh, payload)
        else:
            raise RuntimeError(kind)
        cursor += bh


def _io_row(slide, x, y, w, h, items) -> None:
    _cards(slide, x, y, w, h, items, 10)


def _diagram(slide) -> None:
    tag_x = DIAG_LEFT
    x = tag_x + TAG_W + 0.05
    w = DIAG_RIGHT - x
    core_h = (DIAG_BOTTOM - DIAG_TOP) - INPUT_H - OUTPUT_H - 2 * ARROW
    y = DIAG_TOP
    _tag(slide, tag_x, y, INPUT_H, "输入层", None, SLATE)
    _io_row(slide, x, y, w, INPUT_H, INPUTS)
    y += INPUT_H
    _down_arrow(slide, x + w / 2, y + 0.005, ARROW - 0.01)
    y += ARROW
    _tag(slide, tag_x, y, core_h, "DAG\n引擎", "本页核心", RED)
    _core(slide, x, y, w, core_h)
    y += core_h
    _down_arrow(slide, x + w / 2, y + 0.005, ARROW - 0.01)
    y += ARROW
    _tag(slide, tag_x, y, OUTPUT_H, "输出层", None, SLATE)
    _io_row(slide, x, y, w, OUTPUT_H, OUTPUTS)


def _banner(slide) -> None:
    top, height = 0.78, 1.08
    rbox(slide, Inches(0.22), Inches(top), Inches(12.88), Inches(height), WHITE, LINE, 0.9, 0.05)
    row_h = height / len(BANNER)
    for i, (name, body) in enumerate(BANNER):
        yy = top + i * row_h
        rect(slide, Inches(0.36), Inches(yy + 0.10), Inches(0.07), Inches(row_h - 0.20), RED)
        text(slide, Inches(0.52), Inches(yy), Inches(1.22), Inches(row_h), name,
             12, True, RED, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)
        text(slide, Inches(1.78), Inches(yy), Inches(11.10), Inches(row_h), body,
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
        yy = top + i * (card_h + gap)
        rbox(slide, Inches(left), Inches(yy), Inches(width), Inches(card_h), WHITE, LINE, 0.9, 0.06)
        rect(slide, Inches(left), Inches(yy + 0.08), Inches(0.07), Inches(card_h - 0.16), RED)
        text(slide, Inches(left + 0.18), Inches(yy + 0.05), Inches(width - 0.30), Inches(0.22),
             kicker, 11, True, RED)
        text(slide, Inches(left + 0.18), Inches(yy + 0.26), Inches(width - 0.30), Inches(0.26),
             title, 13, True, INK)
        slot_top = yy + 0.54
        slot_h = (card_h - 0.62) / 2
        for n, (lead, desc) in enumerate(points):
            parts = desc if isinstance(desc, tuple) else (desc,)
            lines = [[(f"{n + 1}）{lead}", 11, True, INK), (parts[0], 11, False, BODY)]]
            lines += [[(part, 11, False, BODY)] for part in parts[1:]]
            text(
                slide,
                Inches(left + 0.18),
                Inches(slot_top + n * slot_h),
                Inches(width - 0.32),
                Inches(slot_h),
                lines,
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
    rect(slide, 0, Inches(7.26), Inches(0.16), Inches(0.24), RED)
    notes = slide.notes_slide.notes_text_frame
    notes.text = (
        "中间不是分类表，而是三段顺序。\n"
        "① 四条来源（结构、源码、框架 IR、运行 Trace）先并列抽出，再顺着做算子实例化、"
        "形状精度绑定、控制流展开、多框架归一，收成一套可仿真 DAG。\n"
        "② 规模链与序列链并排向下、同时改写。规模链：小集群映射、大卡拓扑展开、并行策略切分、批次并发扩展。"
        "序列链：长序列切块、Prefix 复用、量化改写、融合与重计算。"
        "两链汇合后，执行图再分出集合通信、点对点流量、内存容量、数据读取四张域图。\n"
        "③ 依赖展开之后做算子调度和执行序编排，最后按规模、资源、并行限制重放，对照吞吐、排队和瓶颈。\n"
        "输入直接进入 DAG 引擎，下面是输出层，本页不接仿真核。"
        "圆角矩形是名词（来源或图），箭头块是有顺序的动作。每组约 4 个框。\n"
        "配色遵循 AICO-PPT：品牌红 #b5333b 只标 DAG 引擎，结构用灰蓝 #566472。"
    )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    prs.save(OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    build()
