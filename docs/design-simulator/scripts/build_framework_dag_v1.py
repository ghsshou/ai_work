#!/usr/bin/env python3
"""One proposal slide: framework-oriented DAG simulation (left 1/2 diagram, right 3 techniques)."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / ".cursor/skills/pptx-layered-arch-diagram"))

from pptx.enum.text import MSO_ANCHOR, PP_ALIGN  # noqa: E402
from pptx.util import Inches  # noqa: E402

from arch_kit import (  # noqa: E402
    BLUE,
    CORE,
    INK,
    LINE,
    MUTED,
    WHITE,
    blank,
    draw_layered_arch,
    footer,
    new_deck,
    rbox,
    rect,
    text,
    title_block,
)

OUT = ROOT / "docs/design-simulator/设计态仿真器_框架DAG仿真能力_v1.pptx"

# Left half of a 13.333in slide. Heights must fit top..bottom (arrows add 0.20in each).
DIAG_LEFT, DIAG_RIGHT = 0.26, 6.52
DIAG_TOP, DIAG_BOTTOM = 2.28, 7.14

SPEC = [
    {"name": "输入层", "tone": "blue", "h": 0.46, "size": 9,
     "items": ["训练框架源码", "推理框架源码", "RL 框架源码", "模型结构配置"]},
    {"name": "DAG引擎", "sub": "本页核心", "tone": "core", "h": 2.88,
     "rows": [
         {"title": "① 基于多源抽取的\n框架 DAG 构建", "items": [
             "模型结构\n转计算图", "源码 / IR\n抽取", "算子实例化\n与形状绑定", "多框架\n图归一"]},
         {"title": "② 面向场景变换的\n动态 DAG 改写", "items": [
             "小集群到\n大卡映射", "并行与\n长序列展开", "量化与\nPrefix 改写", "通信与\n访存图衍生"]},
         {"title": "③ 面向资源约束的\nDAG 编排执行", "items": [
             "依赖展开与\n算子调度", "执行序与\n流水编排", "设备流与\n队列绑定", "多场景\n重放对照"]},
     ]},
    {"name": "仿真核", "sub": "已具备", "tone": "gray", "h": 0.40, "size": 9,
     "items": ["NPU 仿真", "内存 / 存储仿真", "网络仿真"]},
    {"name": "输出层", "tone": "green", "h": 0.46, "size": 9,
     "items": ["多场景执行图", "网络流量图", "内存访存图", "吞吐排队与瓶颈"]},
]

BANNER = [
    (BLUE, "面向场景",
     "面向训练、推理、RL 等框架负载的端到端行为仿真，对照不同规模、资源、调度与并行限制下的吞吐、排队及瓶颈"),
    (CORE, "竞争力目标",
     "从模型结构与源码导出统一 DAG，按场景动态变换出大卡执行图及网络、内存读取图，形成可复用的框架级泛化仿真"),
    (MUTED, "技术挑战",
     "训练、推理、RL 框架迭代快，结构、源码与运行图粒度不一；规模、并行、序列、通信和访存一变，静态 DAG 难以统一表征"),
]

TECHS = [
    ("关键技术 1", "基于多源抽取的框架 DAG 构建", [
        ("模型结构与源码双通路：",
         "由当前模型结构转换成计算图，并从训练、推理、RL 框架源码与 IR 采集算子级 DAG。"),
        ("算子实例化与图归一：",
         "按形状、精度和批次实例化算子，并归一成一套可仿真 DAG。"),
    ]),
    ("关键技术 2", "面向场景变换的动态 DAG 改写", [
        ("规模与策略泛化：",
         "把小集群 DAG 映射到大卡规模，同步展开并行切分、长序列、Prefix 复用与量化融合。"),
        ("网络与访存图衍生：",
         "由执行图派生集合通信与点对点流量图，以及内存层级上的数据读取图，供给网络和内存仿真。"),
    ]),
    ("关键技术 3", "面向资源约束的 DAG 编排执行", [
        ("调度与执行编排：",
         "沿依赖完成算子调度与执行序编排，组织流水，并把算子绑定到设备、流与队列。"),
        ("多场景重放对照：",
         "在同一 DAG 族上切换集群规模、资源、调度策略和并行限制，比较吞吐、排队与瓶颈。"),
    ]),
]


def _banner(slide) -> None:
    top, height = 0.84, 1.08
    rbox(slide, Inches(0.26), Inches(top), Inches(12.80), Inches(height), WHITE, LINE, 0.9, 0.05)
    row_h = height / len(BANNER)
    for i, (color, name, body) in enumerate(BANNER):
        y = top + i * row_h
        rect(slide, Inches(0.40), Inches(y + 0.10), Inches(0.08), Inches(row_h - 0.20), color)
        text(slide, Inches(0.56), Inches(y), Inches(1.28), Inches(row_h), name,
             12, True, color, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)
        text(slide, Inches(1.88), Inches(y), Inches(10.95), Inches(row_h), body,
             12, False, INK, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)


def _tech_column(slide) -> None:
    left, right = 6.70, 13.06
    top, bottom = DIAG_TOP, DIAG_BOTTOM
    width = right - left
    gap = 0.08
    card_h = (bottom - top - gap * (len(TECHS) - 1)) / len(TECHS)
    text(slide, Inches(left), Inches(top - 0.24), Inches(width), Inches(0.22),
         "关键技术", 11, True, CORE, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)
    for i, (kicker, title, points) in enumerate(TECHS):
        y = top + i * (card_h + gap)
        rbox(slide, Inches(left), Inches(y), Inches(width), Inches(card_h), WHITE, LINE, 0.9, 0.06)
        rect(slide, Inches(left), Inches(y), Inches(0.08), Inches(card_h), CORE)
        text(slide, Inches(left + 0.18), Inches(y + 0.06), Inches(width - 0.30), Inches(0.24),
             kicker, 11, True, CORE)
        text(slide, Inches(left + 0.18), Inches(y + 0.28), Inches(width - 0.30), Inches(0.26),
             title, 13, True, INK)
        slot_top = y + 0.56
        slot_h = (card_h - 0.64) / 2
        for n, (lead, desc) in enumerate(points):
            text(
                slide,
                Inches(left + 0.18),
                Inches(slot_top + n * slot_h),
                Inches(width - 0.32),
                Inches(slot_h),
                [[(f"{n + 1}）{lead}", 11.5, True, INK), (desc, 11.5, False, MUTED)]],
                anchor=MSO_ANCHOR.TOP,
            )


def build() -> None:
    prs = new_deck()
    slide = blank(prs)
    title_block(
        slide,
        "设计态 AI 集群仿真器  ·  框架侧仿真能力",
        "从多框架导出统一 DAG，并按场景变换为大规模执行图与网络、访存图",
    )
    _banner(slide)
    text(slide, Inches(DIAG_LEFT), Inches(DIAG_TOP - 0.24), Inches(3.2), Inches(0.22),
         "能力结构", 11, True, BLUE, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)
    draw_layered_arch(slide, SPEC, left=DIAG_LEFT, right=DIAG_RIGHT, top=DIAG_TOP, bottom=DIAG_BOTTOM)
    _tech_column(slide)
    footer(slide, "框架侧仿真能力  ·  立项讨论稿", 1, 1)
    notes = slide.notes_slide.notes_text_frame
    notes.text = (
        "相对旧材料的三块浅层描述，本页把同一条链路写完整。\n"
        "DAG 创建：模型结构转计算图、源码与 IR 抽取、算子实例化与形状绑定、训练/推理/RL 图归一。\n"
        "DAG 变换：小集群到大卡映射；并行、长序列、Prefix 复用、量化；并由执行图衍生通信流量图与内存数据读取图。\n"
        "DAG 编排：依赖展开与算子调度、执行序与流水、设备/流/队列绑定，以及多场景重放对照。\n"
        "左侧框图只写技术点名称；右侧三条是同一编号的展开。仿真核（NPU / 内存存储 / 网络）为已具备能力。"
    )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    prs.save(OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    build()
