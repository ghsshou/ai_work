#!/usr/bin/env python3
"""ScaleOut network simulation charter slide v6.

Page 1 layout matches v5 (brow + title, 3 banner rows, left layered arch,
right 3 key-tech cards). Formal content (titles, banner, right cards, noun
names) stays as v5.

v6 vs v5 (WeChat feedback — restyle left diagram + backup glossary page):
- Left diagram: dark-gray borders (#5a5a5e) on modules / leaves / in-out / chips.
- Leaf technique boxes + input/output chips: white fill.
- Three core module bands get distinct soft pastel fills (拓扑 / 协议 / 模组).
- Right key-tech cards keep light gray #e7e7e7 borders.
- NEW page 2: pure-text glossary of every leaf technique (backup, not formal).
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / ".cursor/skills/pptx-layered-arch-diagram"))

from pptx.dml.color import RGBColor  # noqa: E402
from pptx.enum.shapes import MSO_SHAPE  # noqa: E402
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN  # noqa: E402
from pptx.util import Inches, Pt  # noqa: E402

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

OUT = ROOT / "docs/design-simulator/设计态仿真器_ScaleOut网络仿真能力_v6.pptx"

# AICO-PPT: brand red marks the page focus; slate marks structure.
RED = RGBColor(0xB5, 0x33, 0x3B)
RED_SOFT = RGBColor(0xFD, 0xF0, 0xF1)
RED_LINE = RGBColor(0xE0, 0xA3, 0xA7)
SLATE = RGBColor(0x56, 0x64, 0x72)
ARROW_GREY = RGBColor(0xC8, 0xC8, 0xCC)
INK = RGBColor(0x1A, 0x1A, 0x1C)
BODY = RGBColor(0x58, 0x58, 0x60)
LINE = RGBColor(0xE7, 0xE7, 0xE7)  # right cards / banner (unchanged)
DIAG_LINE = RGBColor(0x5A, 0x5A, 0x5E)  # left diagram dark borders
PAPER = RGBColor(0xFA, 0xFA, 0xFA)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
CHIP_FILL = RGBColor(0xF5, 0xF5, 0xF6)

# Soft pastel fills for the three core module bands (AICO-friendly, not loud).
BAND_TOPO = RGBColor(0xEE, 0xF2, 0xF6)  # cool slate — 拓扑
BAND_PROTO = RGBColor(0xF7, 0xF0, 0xF1)  # warm rose/cream — 协议
BAND_MOD = RGBColor(0xEE, 0xF5, 0xF0)  # sage/mint-gray — 模组
BAND_FILLS = (BAND_TOPO, BAND_PROTO, BAND_MOD)

DIAG_LEFT, DIAG_RIGHT = 0.22, 6.56
DIAG_TOP, DIAG_BOTTOM = 2.48, 7.14
TAG_W = 0.68
ARROW = 0.09
INPUT_H, OUTPUT_H = 0.30, 0.32

PROBLEMS = [
    "ScaleOut\n带宽设计",
    "收敛比分析",
    "拥塞/丢包\n性能测算",
    "协议路径\n吞吐对照",
    "故障重构影响",
]

INPUTS = ["集群拓扑意图", "并行与通信模式", "协议与拥塞策略", "网卡与模组参数"]
OUTPUTS = ["带宽延迟对照", "集合通信效率", "瓶颈定位图", "RoCE/UBoE/\n网卡方案对比"]

# 8 noun boxes each = 2 rows × 4 (same as v5).
CORE_MODULES = [
    (
        "① 基于拓扑意图图的多路径路由仿真",
        [
            "CLOS/Dragonfly\n意图建模",
            "ECMP 哈希\n多路径",
            "故障域\n重构推演",
            "跨域收敛比\n测算",
            "路由表\n规模外推",
            "多路径\n负载均衡",
            "断链重路由\n时延",
            "Pod/Spine\n分层映射",
        ],
    ),
    (
        "② 基于双栈行为模型的流量仿真",
        [
            "RoCE 拥塞\n控制模型",
            "UBoE 转发\n路径模型",
            "集合通信\n轨迹重放",
            "PFC/ECN\n策略对照",
            "队列深度\n水位",
            "重传与乱序\n模型",
            "AllReduce/\nAlltoAll 模式",
            "跨 ScaleOut\n流量注入",
        ],
    ),
    (
        "③ 基于 CX model 的端网模组仿真",
        [
            "CX 端侧\n延迟链模型",
            "182X DMA\n/门铃映射",
            "交换机队列\n调度模型",
            "端网模组\n插拔接口",
            "CX offload\n路径",
            "主机侧/\nPCIe 延迟",
            "交换机缓冲\n与 VOQ",
            "模组参数\n标定接口",
        ],
    ),
]

NOTE_INPUT = "四类输入同时抽出"
NOTE_CORE = "自上而下三层；协议层双栈可对照，模组层基于 CX model"
NOTE_OUTPUT = "从执行结果分出四类对照"
NOTE_PROBLEMS = "待验证 / 待测算"

BANNER = [
    (
        "面向场景",
        "面向 10T～50T+ 大模型、约 50 万卡量级集群，在设计态仿真 ScaleOut 网络方案与网卡行为，对照吞吐、延迟与瓶颈",
    ),
    (
        "竞争力目标",
        "对照 RoCE 与 UBoE 等协议路径，并以 CX model 刻画网卡模组级行为，给出可量化的方案取舍依据",
    ),
    (
        "技术挑战",
        "超大规模拓扑与路由保真、集合通信与流量跨 ScaleOut 可复现、端侧网卡与网侧交换机行为可插拔",
    ),
]

TECHS = [
    (
        "关键技术 1",
        "基于拓扑意图图的多路径交叉验证",
        [
            (
                "意图构图：",
                (
                    "先从集群拓扑意图生成可扩 CLOS/Dragonfly，",
                    "再注入路由与故障路径",
                ),
            ),
            ("同负载对照：", "同一通信负载下对比不同拓扑与路由配置的瓶颈位置"),
        ],
    ),
    (
        "关键技术 2",
        "基于双栈行为模型的协议路径对照",
        [
            ("双栈回放：", "同一流量意图分别注入 RoCE / UBoE 行为模型"),
            ("事件序重放：", "集合通信与跨 ScaleOut 流量按事件序回放"),
        ],
    ),
    (
        "关键技术 3",
        "基于 CX model 的端/网侧模组级仿真",
        [
            (
                "模组建模：",
                (
                    "用 CX model 刻画端侧 DMA/offload 与网侧交换机",
                    "延迟、吞吐（含 182X 映射）",
                ),
            ),
            ("接口解耦：", "设备接口固定，换网卡或交换机模型不改上层拓扑与协议层"),
        ],
    ),
]

# Page 2 glossary: one short Chinese sentence per leaf (flat name without \\n).
GLOSSARY_INPUTS = [
    ("集群拓扑意图", "描述目标集群的拓扑形态与规模意图，作为构图与路由仿真的输入。"),
    ("并行与通信模式", "给定训练并行策略与集合通信模式，驱动流量生成与轨迹注入。"),
    ("协议与拥塞策略", "指定 RoCE/UBoE 及 PFC/ECN 等策略配置，供双栈行为对照。"),
    ("网卡与模组参数", "提供端侧网卡与模组级延迟/吞吐参数，驱动 CX 模组实例化。"),
]

GLOSSARY_TOPO = [
    ("CLOS/Dragonfly 意图建模", "把集群拓扑意图展开为可扩的 CLOS 或 Dragonfly 图，供路由与收敛比仿真使用。"),
    ("ECMP 哈希多路径", "按哈希分流模拟 ECMP 多路径转发，评估路径利用率与热点分布。"),
    ("故障域重构推演", "在指定故障域失效后重算可达与路由，量化重构对带宽与延迟的影响。"),
    ("跨域收敛比测算", "按 Pod/域边界统计上下行带宽比，支撑 ScaleOut 带宽与过订阅设计。"),
    ("路由表规模外推", "按拓扑规模外推路由表项与查表开销，预估控制面与数据面压力。"),
    ("多路径负载均衡", "在多路径间分配流/报文负载，对照均衡策略对瓶颈位置的影响。"),
    ("断链重路由时延", "模拟链路中断后的重路由收敛过程，给出恢复时延与丢包窗口。"),
    ("Pod/Spine 分层映射", "将逻辑意图映射到 Pod/Spine 分层设备与端口，驱动后续仿真实例化。"),
]

GLOSSARY_PROTO = [
    ("RoCE 拥塞控制模型", "用行为模型刻画 RoCE 拥塞反馈与速率调整，对照吞吐与队列压力。"),
    ("UBoE 转发路径模型", "按 UBoE 转发语义建模报文路径与处理开销，与 RoCE 同负载对照。"),
    ("集合通信轨迹重放", "按事件序重放集合通信轨迹，复现跨 ScaleOut 的通信时序。"),
    ("PFC/ECN 策略对照", "在同一流量下切换 PFC/ECN 策略，比较停等、标记与吞吐差异。"),
    ("队列深度水位", "跟踪交换机/网卡队列占用水位，定位缓冲耗尽与拥塞起点。"),
    ("重传与乱序模型", "刻画丢包重传与乱序到达对有效吞吐和完成时间的影响。"),
    ("AllReduce/AlltoAll 模式", "注入典型集合通信模式，评估模式与拓扑/协议组合下的效率。"),
    ("跨 ScaleOut 流量注入", "在 ScaleOut 边界注入跨域流量，观察带宽争用与路径冲突。"),
]

GLOSSARY_MOD = [
    ("CX 端侧延迟链模型", "用 CX model 串联端侧处理延迟环节，给出端到端延迟分解。"),
    ("182X DMA/门铃映射", "将 182X 网卡的 DMA 与门铃行为映射为 CX 模组参数实例。"),
    ("交换机队列调度模型", "建模交换机队列调度与出队策略，影响转发延迟与公平性。"),
    ("端网模组插拔接口", "固定端/网侧模组接口，使换网卡或交换机模型不改上层。"),
    ("CX offload 路径", "刻画 CX offload 旁路与主机路径的分流，评估 offload 收益。"),
    ("主机侧/PCIe 延迟", "计入主机与 PCIe 传输延迟，补全端侧延迟链。"),
    ("交换机缓冲与 VOQ", "建模交换机缓冲与 VOQ 结构，评估缓冲分配对拥塞的影响。"),
    ("模组参数标定接口", "提供模组参数标定入口，使仿真可用实测或规格参数驱动。"),
]

GLOSSARY_OUTPUTS = [
    ("带宽延迟对照", "输出不同方案下的带宽与延迟对照结果，支撑设计取舍。"),
    ("集合通信效率", "输出集合通信完成时间与效率指标，对照模式与协议组合。"),
    ("瓶颈定位图", "标出拓扑/协议/模组层的瓶颈位置，便于定位根因。"),
    ("RoCE/UBoE/网卡方案对比", "汇总协议路径与网卡方案的量化对比结论。"),
]


def _down_arrow(slide, cx, y, h=0.10) -> None:
    shape(
        slide,
        MSO_SHAPE.DOWN_ARROW,
        Inches(cx - 0.10),
        Inches(y),
        Inches(0.20),
        Inches(h),
        ARROW_GREY,
        adj=0.5,
    )


def _tag(slide, x, y, h, name, sub, fill) -> None:
    rect(slide, Inches(x), Inches(y), Inches(TAG_W), Inches(h), fill)
    lines = [[(part, 10, True, WHITE)] for part in name.split("\n")]
    if sub:
        lines.append([(sub, 8, False, WHITE)])
    text(
        slide,
        Inches(x),
        Inches(y),
        Inches(TAG_W),
        Inches(h),
        lines,
        align=PP_ALIGN.CENTER,
        anchor=MSO_ANCHOR.MIDDLE,
    )


def _cards(slide, x, y, w, h, items, size=9, cols=None, border=None, fill=None) -> None:
    """Draw noun cards. With cols set (e.g. 4), wrap into multiple rows of `cols`."""
    if border is None:
        border = DIAG_LINE
    if fill is None:
        fill = WHITE
    n = len(items)
    if cols is None or n <= cols:
        cols = n
        rows = 1
    else:
        rows = (n + cols - 1) // cols
    gap_x, gap_y = 0.04, 0.035
    cw = (w - gap_x * (cols - 1)) / cols
    row_h = (h - gap_y * (rows - 1)) / rows if rows else h
    for i, lab in enumerate(items):
        r, c = divmod(i, cols)
        sh = rbox(
            slide,
            Inches(x + c * (cw + gap_x)),
            Inches(y + r * (row_h + gap_y)),
            Inches(cw),
            Inches(row_h),
            fill,
            border,
            0.9,
            0.10,
        )
        if "\n" in lab:
            label(
                sh,
                [[(part, size - 0.5, False, INK)] for part in lab.split("\n")],
            )
            for p in sh.text_frame.paragraphs:
                p.space_after = 0
        else:
            label(sh, lab, size, False, INK)


def _problems_strip(slide) -> None:
    """待验证问题 chips between column titles and the input→core→output stack."""
    tag_x = DIAG_LEFT
    x = tag_x + TAG_W + 0.05
    w = DIAG_RIGHT - x
    strip_h = 0.36
    y = DIAG_TOP - strip_h - 0.06
    text(
        slide,
        Inches(tag_x),
        Inches(y),
        Inches(TAG_W),
        Inches(strip_h),
        [[("待验", 9, True, SLATE)], [("证项", 9, True, SLATE)]],
        align=PP_ALIGN.CENTER,
        anchor=MSO_ANCHOR.MIDDLE,
    )
    gap = 0.04
    n = len(PROBLEMS)
    cw = (w - gap * (n - 1)) / n
    for i, lab in enumerate(PROBLEMS):
        sh = rbox(
            slide,
            Inches(x + i * (cw + gap)),
            Inches(y + 0.02),
            Inches(cw),
            Inches(strip_h - 0.04),
            CHIP_FILL,
            DIAG_LINE,  # dark border
            0.85,
            0.12,
        )
        if "\n" in lab:
            label(
                sh,
                [[(part, 8.5, False, INK)] for part in lab.split("\n")],
            )
            for p in sh.text_frame.paragraphs:
                p.space_after = 0
        else:
            label(sh, lab, 8.5, False, INK)


def _core(slide, x, y, w, h) -> None:
    # Outer soft-red envelope + red tag remains; three bands get distinct tints.
    rbox(slide, Inches(x), Inches(y), Inches(w), Inches(h), RED_SOFT, RED_LINE, 1.0, 0.03)
    pad_x, pad_y = 0.06, 0.03
    ix, iw = x + pad_x, w - 2 * pad_x
    note_h = 0.16
    text(
        slide,
        Inches(ix),
        Inches(y + pad_y),
        Inches(iw),
        Inches(note_h),
        NOTE_CORE,
        8,
        False,
        BODY,
        PP_ALIGN.LEFT,
        MSO_ANCHOR.MIDDLE,
    )
    n = len(CORE_MODULES)
    gap = 0.045
    body_top = y + pad_y + note_h + 0.01
    body_h = h - (body_top - y) - pad_y
    mod_h = (body_h - gap * (n - 1)) / n
    title_h = 0.18
    # Inner pad inside each tinted module band.
    band_pad_x, band_pad_y = 0.04, 0.02
    cards_gap = 0.015
    for i, (title, items) in enumerate(CORE_MODULES):
        yy = body_top + i * (mod_h + gap)
        # Tinted rounded container for this core layer band.
        rbox(
            slide,
            Inches(ix),
            Inches(yy),
            Inches(iw),
            Inches(mod_h),
            BAND_FILLS[i],
            DIAG_LINE,
            1.0,
            0.06,
        )
        text(
            slide,
            Inches(ix + band_pad_x),
            Inches(yy + band_pad_y),
            Inches(iw - 2 * band_pad_x),
            Inches(title_h),
            title,
            9.5,
            True,
            RED,
            PP_ALIGN.LEFT,
            MSO_ANCHOR.MIDDLE,
        )
        card_top = yy + band_pad_y + title_h + 0.005
        card_h = mod_h - (card_top - yy) - band_pad_y - 0.01
        _cards(
            slide,
            ix + band_pad_x,
            card_top,
            iw - 2 * band_pad_x,
            card_h,
            items,
            size=8.5,
            cols=4,
            border=DIAG_LINE,
            fill=WHITE,
        )
        if i < n - 1:
            _down_arrow(
                slide,
                x + w / 2,
                yy + mod_h + 0.001,
                max(gap - 0.008, 0.035),
            )


def _diagram(slide) -> None:
    tag_x = DIAG_LEFT
    x = tag_x + TAG_W + 0.05
    w = DIAG_RIGHT - x
    core_h = (DIAG_BOTTOM - DIAG_TOP) - INPUT_H - OUTPUT_H - 2 * ARROW
    y = DIAG_TOP

    _tag(slide, tag_x, y, INPUT_H, "输入层", None, SLATE)
    _cards(slide, x, y, w, INPUT_H, INPUTS, 9, border=DIAG_LINE, fill=WHITE)
    y += INPUT_H
    _down_arrow(slide, x + w / 2, y + 0.004, ARROW - 0.01)
    y += ARROW

    _tag(slide, tag_x, y, core_h, "仿真\n技术", "本页核心", RED)
    _core(slide, x, y, w, core_h)
    y += core_h
    _down_arrow(slide, x + w / 2, y + 0.004, ARROW - 0.01)
    y += ARROW

    text(
        slide,
        Inches(x),
        Inches(y - ARROW + 0.01),
        Inches(w * 0.72),
        Inches(ARROW - 0.02),
        NOTE_OUTPUT,
        8,
        False,
        BODY,
        PP_ALIGN.LEFT,
        MSO_ANCHOR.MIDDLE,
    )
    _tag(slide, tag_x, y, OUTPUT_H, "输出层", None, SLATE)
    _cards(slide, x, y, w, OUTPUT_H, OUTPUTS, 8.5, border=DIAG_LINE, fill=WHITE)


def _banner(slide) -> None:
    top, height = 0.78, 1.08
    rbox(slide, Inches(0.22), Inches(top), Inches(12.88), Inches(height), WHITE, LINE, 0.9, 0.05)
    row_h = height / len(BANNER)
    for i, (name, body) in enumerate(BANNER):
        yy = top + i * row_h
        rect(slide, Inches(0.36), Inches(yy + 0.10), Inches(0.07), Inches(row_h - 0.20), RED)
        text(
            slide,
            Inches(0.52),
            Inches(yy),
            Inches(1.22),
            Inches(row_h),
            name,
            12,
            True,
            RED,
            PP_ALIGN.LEFT,
            MSO_ANCHOR.MIDDLE,
        )
        text(
            slide,
            Inches(1.78),
            Inches(yy),
            Inches(11.10),
            Inches(row_h),
            body,
            12,
            False,
            INK,
            PP_ALIGN.LEFT,
            MSO_ANCHOR.MIDDLE,
        )


def _tech_column(slide) -> None:
    left, right = 6.72, 13.08
    top, bottom = DIAG_TOP, DIAG_BOTTOM
    width = right - left
    gap = 0.07
    card_h = (bottom - top - gap * (len(TECHS) - 1)) / len(TECHS)
    text(
        slide,
        Inches(left),
        Inches(1.88),
        Inches(width),
        Inches(0.16),
        "关键技术",
        12,
        True,
        RED,
        PP_ALIGN.LEFT,
        MSO_ANCHOR.MIDDLE,
    )
    for i, (kicker, title, points) in enumerate(TECHS):
        yy = top + i * (card_h + gap)
        # Right cards keep light gray borders (formal cards stay light).
        rbox(slide, Inches(left), Inches(yy), Inches(width), Inches(card_h), WHITE, LINE, 0.9, 0.06)
        rect(slide, Inches(left), Inches(yy + 0.08), Inches(0.07), Inches(card_h - 0.16), RED)
        text(
            slide,
            Inches(left + 0.18),
            Inches(yy + 0.05),
            Inches(width - 0.30),
            Inches(0.22),
            kicker,
            11,
            True,
            RED,
        )
        text(
            slide,
            Inches(left + 0.18),
            Inches(yy + 0.26),
            Inches(width - 0.30),
            Inches(0.26),
            title,
            13,
            True,
            INK,
        )
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


def _brand_header(slide, title: str, subtitle: str | None = None) -> None:
    rect(slide, 0, 0, slide.part.package.presentation_part.presentation.slide_width, Inches(0.06), RED)
    # Use fixed width from deck (16:9 = 13.333in).
    text(
        slide,
        Inches(0.28),
        Inches(0.12),
        Inches(12.6),
        Inches(0.24),
        "设计态 AI 集群仿真器  ·  ScaleOut 网络仿真",
        12,
        True,
        RED,
    )
    text(
        slide,
        Inches(0.28),
        Inches(0.36),
        Inches(12.7),
        Inches(0.38),
        title,
        20 if subtitle is None else 18,
        True,
        INK,
    )
    if subtitle:
        text(
            slide,
            Inches(0.28),
            Inches(0.72),
            Inches(12.7),
            Inches(0.22),
            subtitle,
            11,
            False,
            BODY,
        )


def _page1(prs) -> None:
    slide = blank(prs)
    rect(slide, 0, 0, prs.slide_width, prs.slide_height, PAPER)
    rect(slide, 0, 0, prs.slide_width, Inches(0.06), RED)
    text(
        slide,
        Inches(0.28),
        Inches(0.12),
        Inches(12.6),
        Inches(0.24),
        "设计态 AI 集群仿真器  ·  ScaleOut 网络仿真",
        12,
        True,
        RED,
    )
    text(
        slide,
        Inches(0.28),
        Inches(0.36),
        Inches(12.7),
        Inches(0.38),
        "以拓扑、协议、模组三层仿真支撑十万～五十万卡 ScaleOut 网络设计决策",
        20,
        True,
        INK,
    )
    _banner(slide)
    text(
        slide,
        Inches(DIAG_LEFT),
        Inches(1.88),
        Inches(1.6),
        Inches(0.16),
        "能力结构",
        12,
        True,
        SLATE,
        PP_ALIGN.LEFT,
        MSO_ANCHOR.MIDDLE,
    )
    text(
        slide,
        Inches(DIAG_LEFT + 1.65),
        Inches(1.88),
        Inches(DIAG_RIGHT - DIAG_LEFT - 1.65),
        Inches(0.16),
        NOTE_INPUT,
        8.5,
        False,
        BODY,
        PP_ALIGN.RIGHT,
        MSO_ANCHOR.MIDDLE,
    )
    _problems_strip(slide)
    _diagram(slide)
    _tech_column(slide)
    kit_footer(slide, "ScaleOut 网络仿真能力  ·  立项讨论稿", 1, 2)
    rect(slide, 0, Inches(7.26), Inches(0.16), Inches(0.24), RED)
    notes = slide.notes_slide.notes_text_frame
    notes.text = (
        "v6：相对 v5——左架构图深灰描边 + 白底末级小块 + 三层分色色带；"
        "正式文案（标题/横幅/右关键技术/名词）保持 v5；新增第 2 页技术点说明备用页。\n"
        "关键技术 1：基于拓扑意图图的多路径交叉验证\n"
        "关键技术 2：基于双栈行为模型的协议路径对照\n"
        "关键技术 3：基于 CX model 的端/网侧模组级仿真\n"
        "配色：左图描边 #5a5a5e；拓扑带 #eef2f6 / 协议带 #f7f0f1 / 模组带 #eef5f0；"
        "右关键技术卡片描边仍为 #e7e7e7。"
    )


def _glossary_section(slide, x, y, w, title, items, title_color, line_h=0.195) -> float:
    """Draw a titled glossary block; return y after the last line."""
    text(
        slide,
        Inches(x),
        Inches(y),
        Inches(w),
        Inches(0.22),
        title,
        12,
        True,
        title_color,
        PP_ALIGN.LEFT,
        MSO_ANCHOR.MIDDLE,
    )
    y += 0.24
    for name, desc in items:
        lines = [[(f"· {name}：", 9.5, True, INK), (desc, 9.5, False, BODY)]]
        text(
            slide,
            Inches(x),
            Inches(y),
            Inches(w),
            Inches(line_h),
            lines,
            anchor=MSO_ANCHOR.TOP,
        )
        y += line_h
    return y + 0.06


def _page2(prs) -> None:
    """Backup pure-text glossary of every leaf technique."""
    slide = blank(prs)
    rect(slide, 0, 0, prs.slide_width, prs.slide_height, PAPER)
    rect(slide, 0, 0, prs.slide_width, Inches(0.06), RED)
    text(
        slide,
        Inches(0.28),
        Inches(0.12),
        Inches(12.6),
        Inches(0.24),
        "设计态 AI 集群仿真器  ·  ScaleOut 网络仿真",
        12,
        True,
        RED,
    )
    text(
        slide,
        Inches(0.28),
        Inches(0.36),
        Inches(12.7),
        Inches(0.32),
        "技术点说明（备用页 · 不进正式稿）",
        18,
        True,
        INK,
    )
    text(
        slide,
        Inches(0.28),
        Inches(0.68),
        Inches(12.7),
        Inches(0.20),
        "对左图每一个末级技术名词给出一句设计态仿真语境下的用途说明，便于后续技术文档引用。",
        10,
        False,
        BODY,
    )

    # Two-column layout: left = 输入 + ①拓扑 + ②协议(部分); right = ②续 + ③模组 + 输出
    # Actually better: left col = 输入 + ① + ②, right = ③ + 输出 — but ①+② is 16 items.
    # Use two columns: left = 输入(4) + ①(8) + ②前4; right = ②后4 + ③(8) + 输出(4)
    # Cleaner: three bands across full width is too tall. Two columns side by side.
    col_gap = 0.28
    col_w = (12.8 - col_gap) / 2
    left_x = 0.28
    right_x = left_x + col_w + col_gap
    y0 = 0.95
    line_h = 0.188

    # Left column: 输入 + ①拓扑
    y = y0
    y = _glossary_section(slide, left_x, y, col_w, "输入层", GLOSSARY_INPUTS, SLATE, line_h)
    y = _glossary_section(
        slide, left_x, y, col_w, "① 拓扑层 — 基于拓扑意图图的多路径路由仿真", GLOSSARY_TOPO, RED, line_h
    )
    # Continue ② on left if room, else right — ② all on left after topo would be tight.
    # After 输入(4)+①(8) ≈ 12 lines + titles ≈ 0.95+0.24+4*0.188+0.06+0.24+8*0.188+0.06 ≈ 3.9
    # Remaining ~3.2 for ② on left — 8 lines fit.
    y = _glossary_section(
        slide, left_x, y, col_w, "② 协议层 — 基于双栈行为模型的流量仿真", GLOSSARY_PROTO, RED, line_h
    )

    # Right column: ③模组 + 输出
    y = y0
    y = _glossary_section(
        slide, right_x, y, col_w, "③ 模组层 — 基于 CX model 的端网模组仿真", GLOSSARY_MOD, RED, line_h
    )
    y = _glossary_section(slide, right_x, y, col_w, "输出层", GLOSSARY_OUTPUTS, SLATE, line_h)

    # Footer note about backup nature
    text(
        slide,
        Inches(0.28),
        Inches(6.95),
        Inches(12.7),
        Inches(0.22),
        "本页为备用说明页，供后续技术文档引用；不纳入正式立项稿版式。",
        9,
        False,
        BODY,
        PP_ALIGN.LEFT,
        MSO_ANCHOR.MIDDLE,
    )

    kit_footer(slide, "ScaleOut 网络仿真能力  ·  技术点说明（备用）", 2, 2)
    rect(slide, 0, Inches(7.26), Inches(0.16), Inches(0.24), RED)
    notes = slide.notes_slide.notes_text_frame
    notes.text = (
        "v6 第 2 页：技术点说明备用页。覆盖左图全部 24 个核心末级名词，以及输入/输出各 4 项。"
        "不进正式立项稿。"
    )


def build() -> None:
    prs = new_deck()
    _page1(prs)
    _page2(prs)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    prs.save(OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    build()
