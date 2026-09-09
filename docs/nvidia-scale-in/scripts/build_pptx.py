#!/usr/bin/env python3
"""Build NVIDIA Scale-in insight deck — light theme, dense slides."""

from __future__ import annotations

from lxml import etree
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

OUT = "docs/nvidia-scale-in/NVIDIA_Scale_in_网络基础设施洞察.pptx"
FONT = "微软雅黑"

BG = RGBColor(0xF3, 0xF5, 0xF8)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
CARD = RGBColor(0xFF, 0xFF, 0xFF)
CARD2 = RGBColor(0xEB, 0xF1, 0xE6)
INK = RGBColor(0x1B, 0x24, 0x30)
MUTED = RGBColor(0x5C, 0x6B, 0x7A)
DIM = RGBColor(0x7A, 0x88, 0x96)
LINE = RGBColor(0xD0, 0xD8, 0xE0)
GREEN = RGBColor(0x5A, 0xA8, 0x12)
GREEN_DK = RGBColor(0x3D, 0x76, 0x0C)
GREEN_BG = RGBColor(0xE8, 0xF3, 0xD6)
BLUE = RGBColor(0x1A, 0x6F, 0xB5)
BLUE_BG = RGBColor(0xE3, 0xEF, 0xF8)
AMBER = RGBColor(0xC4, 0x7E, 0x10)
AMBER_BG = RGBColor(0xFB, 0xF0, 0xD8)
RED = RGBColor(0xC6, 0x28, 0x28)
HEAD = RGBColor(0x2E, 0x45, 0x2A)
ROW_ALT = RGBColor(0xF7, 0xF9, 0xFB)

W = Inches(13.333)
H = Inches(7.5)
TOTAL = 28


def _set_solid(shape, color):
    shape.fill.solid()
    shape.fill.fore_color.rgb = color
    shape.line.fill.background()


def _line(shape, color, pt=1.0):
    shape.line.color.rgb = color
    shape.line.width = Pt(pt)


def _ea_font(run, name=FONT):
    rPr = run._r.get_or_add_rPr()
    for tag in ("a:latin", "a:ea", "a:cs"):
        node = rPr.find(qn(tag))
        if node is None:
            node = etree.SubElement(rPr, qn(tag))
        node.set("typeface", name)


def _style(run, size, bold=False, color=INK, name=FONT):
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    run.font.name = name
    run.font.italic = False
    _ea_font(run, name)


def add_textbox(slide, l, t, w, h, text, size=13, bold=False, color=INK,
                align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, wrap=True):
    box = slide.shapes.add_textbox(l, t, w, h)
    tf = box.text_frame
    tf.word_wrap = wrap
    tf.auto_size = None
    try:
        tf._txBody.bodyPr.set("anchor", {
            MSO_ANCHOR.TOP: "t",
            MSO_ANCHOR.MIDDLE: "ctr",
            MSO_ANCHOR.BOTTOM: "b",
        }.get(anchor, "t"))
    except Exception:
        pass
    p = tf.paragraphs[0]
    p.alignment = align
    p.space_after = Pt(0)
    p.space_before = Pt(0)
    run = p.add_run()
    run.text = text
    _style(run, size, bold, color)
    return box


def add_paras(slide, l, t, w, h, items, size=12, color=INK, spacing=5,
              align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, bold=False):
    box = slide.shapes.add_textbox(l, t, w, h)
    tf = box.text_frame
    tf.word_wrap = True
    try:
        tf._txBody.bodyPr.set("anchor", {
            MSO_ANCHOR.TOP: "t",
            MSO_ANCHOR.MIDDLE: "ctr",
            MSO_ANCHOR.BOTTOM: "b",
        }.get(anchor, "t"))
    except Exception:
        pass
    for i, item in enumerate(items):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.space_after = Pt(spacing)
        p.space_before = Pt(0)
        if isinstance(item, tuple):
            text, sz, bd, col = item
        else:
            text, sz, bd, col = item, size, bold, color
        run = p.add_run()
        run.text = text
        _style(run, sz, bd, col)
    return box


def rect(slide, l, t, w, h, fill, line=None, line_pt=0.75):
    sh = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, l, t, w, h)
    _set_solid(sh, fill)
    if line:
        _line(sh, line, line_pt)
    else:
        sh.line.fill.background()
    sh.shadow.inherit = False
    return sh


def round_rect(slide, l, t, w, h, fill, line=None, adj=0.06, line_pt=0.75):
    sh = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, l, t, w, h)
    _set_solid(sh, fill)
    try:
        sh.adjustments[0] = adj
    except Exception:
        pass
    if line:
        _line(sh, line, line_pt)
    else:
        sh.line.fill.background()
    sh.shadow.inherit = False
    return sh


def blank(prs):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    rect(slide, 0, 0, W, H, BG)
    return slide


def footer(slide, page):
    rect(slide, 0, Inches(7.26), W, Inches(0.24), RGBColor(0xE6, 0xEB, 0xF0))
    rect(slide, 0, Inches(7.26), Inches(0.16), Inches(0.24), GREEN)
    add_textbox(slide, Inches(0.36), Inches(7.26), Inches(10.6), Inches(0.24),
                "NVIDIA Scale-in 网络基础设施  ·  2026-08 公开口径  ·  内部学习",
                9, False, DIM, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)
    add_textbox(slide, Inches(11.3), Inches(7.26), Inches(1.7), Inches(0.24),
                f"{page:02d}  /  {TOTAL:02d}",
                9, False, MUTED, PP_ALIGN.RIGHT, MSO_ANCHOR.MIDDLE)


def title_block(slide, kicker, title, subtitle=None):
    rect(slide, 0, 0, W, Inches(0.07), GREEN)
    add_textbox(slide, Inches(0.42), Inches(0.14), Inches(12.5), Inches(0.24),
                kicker, 11, True, GREEN_DK)
    add_textbox(slide, Inches(0.42), Inches(0.36), Inches(12.5), Inches(0.40),
                title, 20, True, INK)
    if subtitle:
        add_textbox(slide, Inches(0.42), Inches(0.76), Inches(12.5), Inches(0.30),
                    subtitle, 12, False, MUTED)
        return Inches(1.10)
    return Inches(0.82)


def card(slide, l, t, w, h, fill=CARD, line=LINE):
    return round_rect(slide, l, t, w, h, fill, line, 0.05, 0.9)


def _set_cell(cell, text, size, bold, fill, color, align=PP_ALIGN.LEFT):
    cell.fill.solid()
    cell.fill.fore_color.rgb = fill
    tf = cell.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.alignment = align
    p.clear()
    run = p.add_run()
    run.text = text
    _style(run, size, bold, color)
    for border in ("lnL", "lnR", "lnT", "lnB"):
        ln = cell._tc.get_or_add_tcPr().find(qn(f"a:{border}"))
        # leave default; python-pptx sets some borders


def add_table(slide, l, t, w, h, data, col_w=None, header=True, size=10):
    rows, cols = len(data), len(data[0])
    ts = slide.shapes.add_table(rows, cols, l, t, w, h)
    table = ts.table
    if col_w:
        for i, cw in enumerate(col_w):
            table.columns[i].width = cw
    for r, row in enumerate(data):
        for c, val in enumerate(row):
            cell = table.cell(r, c)
            is_h = header and r == 0
            fill = HEAD if is_h else (WHITE if r % 2 else ROW_ALT)
            color = WHITE if is_h else INK
            _set_cell(cell, val, size if not is_h else size, is_h, fill, color)
    return table


def build():
    prs = Presentation()
    prs.slide_width = W
    prs.slide_height = H
    p = 0

    # 01 cover
    s = blank(prs)
    rect(s, 0, 0, Inches(0.18), H, GREEN)
    rect(s, 0, 0, W, Inches(0.08), GREEN)
    add_textbox(s, Inches(0.7), Inches(1.35), Inches(12), Inches(0.32),
                "NVIDIA AI 网络第五支柱  ·  技术洞察", 14, True, GREEN_DK)
    add_textbox(s, Inches(0.7), Inches(1.75), Inches(12), Inches(1.15),
                "Scale-in：南北向网络的\n加速基础设施域", 32, True, INK)
    add_paras(s, Inches(0.7), Inches(3.15), Inches(11.8), Inches(1.35), [
        "Gilad Shainer：Scale-in 取代过去所谓的前端网络，即世界与 AI 工厂之间的南北向进出。物理介质仍为 Spectrum-X 以太网。",
        "黄仁勋 FY2027 Q2：Scale-in security networking，将安全与管控置于硅上、线速、且独立于租户操作系统。",
        "硬件组合：BlueField-4 DPU + DOCA + Spectrum-X。Vera BlueField-4 STX 为 CMX 存储处理器，与 800G 接入卡角色不同。",
    ], 14, INK, 8)
    card(s, Inches(0.7), Inches(4.75), Inches(3.7), Inches(1.55), GREEN_BG, GREEN)
    add_paras(s, Inches(0.88), Inches(4.88), Inches(3.4), Inches(1.35), [
        ("2026-08-24", 11, True, GREEN_DK),
        ("技术博客：第五支柱，专用加速安全、管理、运营", 12, False, INK),
    ], spacing=4)
    card(s, Inches(4.6), Inches(4.75), Inches(3.7), Inches(1.55), BLUE_BG, BLUE)
    add_paras(s, Inches(4.78), Inches(4.88), Inches(3.4), Inches(1.35), [
        ("2026-08-25", 11, True, BLUE),
        ("Hot Chips / Networking：Scale-in 取代前端网；宣布 BF-4 + Spectrum-X", 12, False, INK),
    ], spacing=4)
    card(s, Inches(8.5), Inches(4.75), Inches(3.95), Inches(1.55), AMBER_BG, AMBER)
    add_paras(s, Inches(8.68), Inches(4.88), Inches(3.65), Inches(1.35), [
        ("2026-08-26", 11, True, AMBER),
        ("财报 Q&A：Scale-in security networking，五种网络系统之一", 12, False, INK),
    ], spacing=4)
    add_textbox(s, Inches(0.7), Inches(6.55), Inches(12), Inches(0.35),
                "口径：NVIDIA Technical Blog、Hot Chips 2026、FY2027 Q2 电话会、Spectrum-X / BlueField-4 产品页与数据手册。未公布处已标明。",
                11, False, MUTED)
    p += 1
    footer(s, p)

    # 02 thesis
    s = blank(prs)
    title_block(s, "00  结论", "Scale-in 覆盖工厂边界接入，不覆盖 GPU 互连",
                "2026-08 三份口径指向同一层：传统南北向前端网络的加速与独立控制。")
    card(s, Inches(0.42), Inches(1.18), Inches(12.5), Inches(1.15), GREEN_BG, GREEN)
    add_textbox(s, Inches(0.6), Inches(1.28), Inches(12.15), Inches(0.95),
                "Scale-up / Scale-out 将算力面扩展到每托盘数 Tb/s 之后，用户、Agent、企业数据、外部存储、管控与安全若仍运行在通用宿主机 CPU 上，会限制 GPU 利用率，并使多租户隔离停留在租户操作系统内部。Scale-in 为上述功能提供独立的 CPU、加速器与信任域。",
                13, False, INK)
    add_table(s, Inches(0.42), Inches(2.48), Inches(12.5), Inches(2.55), [
        ["时间", "来源", "公开口径", "工程含义"],
        ["8/24", "NVIDIA 博客", "AI 网络第五支柱：安全、管理、运营的专用加速", "南北向由 SDN 升级为共设计加速域"],
        ["8/25", "Gilad / Hot Chips", "Scale-in 取代过去所谓的前端网络", "世界与工厂之间的进出；BF-4 + Spectrum-X"],
        ["8/26", "黄仁勋 Q&A", "Scale-in security networking", "安全独立于主机；五种网络系统之一"],
    ], [Inches(1.15), Inches(2.05), Inches(5.0), Inches(4.3)], True, 11)
    add_paras(s, Inches(0.42), Inches(5.18), Inches(12.5), Inches(1.9), [
        "覆盖：接入、线速安全、存储协议卸载、开通、遥测，全部主机无关。",
        "不覆盖：柜内 NVLink、柜间 collective、跨园区 Spectrum-XGS、工厂内 KV 共享（CMX）。",
        "BlueField-4 DPU（800G 接入）与 Vera BlueField-4 STX（CMX 存储处理器）名称相同、角色不同。",
        "与「增加一条网线」的差别：基础设施获得独立软件平台 DOCA，与租户 CPU / GPU 分离。",
    ], 13, INK, 6)
    p += 1
    footer(s, p)

    # 03 prereq map
    s = blank(prs)
    title_block(s, "01  预备知识", "南北向、东西向，以及 NVIDIA 产品分层",
                "Scale-in 表述建立在既有产品之上。以下名词在后文直接使用。")
    add_table(s, Inches(0.32), Inches(1.16), Inches(12.7), Inches(2.15), [
        ["方向", "含义", "AI 工厂中的典型内容"],
        ["南北向 north-south", "数据中心与外部，或服务器与接入层之间", "用户请求、API、企业数据、外部存储、开通、遥测、管理"],
        ["东西向 east-west", "数据中心内部服务器之间", "训练 / 推理 collective、租户 workload、机架间 GPU 通信"],
    ], [Inches(2.6), Inches(4.4), Inches(5.7)], True, 12)
    add_textbox(s, Inches(0.42), Inches(3.45), Inches(12.5), Inches(0.40),
                "传统云称南北向为前端网络。Gilad：Scale-in 取代该前端；物理层仍为以太网。", 13, False, INK)
    add_table(s, Inches(0.32), Inches(3.90), Inches(12.7), Inches(3.10), [
        ["分层", "产品", "职责"],
        ["Scale-up", "NVLink / NVLink Switch", "柜内 GPU 相干互连"],
        ["Scale-out", "Spectrum-X 或 Quantum IB + SuperNIC", "工厂内 GPU 服务器之间的 RoCE / IB 通信"],
        ["Scale-across", "Spectrum-XGS", "跨园区 / 跨数据中心，距离通常 >500 m"],
        ["CMX", "STX + BlueField-4 STX + DOCA Memos", "工厂内 KV cache 层"],
        ["Scale-in", "BlueField-4 DPU + DOCA + Spectrum-X", "南北向接入、安全、存储协议、运营"],
    ], [Inches(2.15), Inches(4.55), Inches(6.0)], True, 11)
    p += 1
    footer(s, p)

    # 04 Spectrum-X
    s = blank(prs)
    title_block(s, "01  预备知识", "Spectrum-X：面向 AI 的端到端以太网平台",
                "不是单一交换机型号。Scale-out 是其主场景；Scale-in 将其复用到接入与外部存储。")
    add_paras(s, Inches(0.42), Inches(1.16), Inches(12.5), Inches(1.55), [
        "Spectrum 是以太网交换机产品族（约 1GbE–800GbE）。Spectrum-X Ethernet 是交换机 + SuperNIC + 软件 / 线缆的共设计平台，用 RoCE 扩展承载 AI 流量。官方产品页：面向多租户生成式 AI 工厂的端到端以太网。主场景是东西向 GPU 通信；Scale-in 将其复用到接入与外部存储。",
        "官方口径：相对货架以太网约 1.6× 网络性能（有效带宽约 60% → 95%），十万 GPU 级维持约 95%。Vera Rubin 同代交换机为 Spectrum-6（102.4 Tb/s）；上代 Spectrum-4 约 51.2 Tb/s。Spectrum-XGS 为跨数据中心扩展，跨约 10 km 的 NCCL all-reduce 最高约 1.9×。",
    ], 13, INK, 6)
    add_table(s, Inches(0.32), Inches(2.85), Inches(12.7), Inches(2.35), [
        ["机制", "位置", "解决的问题"],
        ["Adaptive Routing", "交换机", "按出口队列深度逐包选路；AI collective 低熵，ECMP 静态哈希易碰撞"],
        ["Direct Data Placement", "SuperNIC", "AR 导致乱序到达后，按正确地址写入主机 / GPU 内存，对应用透明"],
        ["Congestion Control / PLB", "交换机 + SuperNIC", "ECN 与 RTT 调节注入；PLB 多平面分流，故障约 3 ms 切换"],
    ], [Inches(2.5), Inches(2.6), Inches(7.6)], True, 12)
    add_textbox(s, Inches(0.42), Inches(5.35), Inches(12.5), Inches(1.65),
                "货架以太网不适合大规模 AI 的原因：collective 为少量超大同步流、丢包重传代价高、DCQCN 跟不上微秒突发。Spectrum-X Multiplane 将单主机带宽拆成多个两层 fat-tree 平面（例如 8×200G 代替 1×1.6T），操作系统与 NCCL 仍看到一块 RoCE 设备。公开评测：约 98% 线速；10% 链路故障时带宽近似按容量比例下降。后文出现的 Spectrum-X 需区分算力面、存储交换与南北向接入。存储路径另有最高约 1.6× I/O 口径，与 Scale-in 的 1.45× 不是同一实验。",
                12, False, INK)
    p += 1
    footer(s, p)

    # 05 SuperNIC DPU
    s = blank(prs)
    title_block(s, "01  预备知识", "SuperNIC、DPU 与 ConnectX-9",
                "BlueField-4 集成 ConnectX-9 级网络，但在托盘上不替代四张 Scale-out SuperNIC。")
    add_table(s, Inches(0.32), Inches(1.16), Inches(12.7), Inches(3.15), [
        ["类别", "代表", "主要职责"],
        ["NIC", "早期 ConnectX", "主机网络适配，卸载能力有限"],
        ["SuperNIC", "BF-3 / CX8 / CX9", "GPU 间 RoCE：DDP 乱序重排、PLB、租户隔离。Hopper 代 BF-3 约 400G；Blackwell 代 CX8 约 800G；Rubin 代 CX9 每 GPU 最高 1.6 Tb/s"],
        ["DPU", "BlueField-3 / BlueField-4", "SuperNIC 级网络 + 可编程 CPU、内存、存储/安全 inline 引擎"],
    ], [Inches(1.7), Inches(3.3), Inches(7.7)], True, 12)
    add_paras(s, Inches(0.42), Inches(4.48), Inches(12.5), Inches(2.5), [
        "Vera Rubin 计算托盘：四张 ConnectX-9 承担东西向租户流量（4×1.6T）；一张 BlueField-4 DPU 承担南北向 800G，并通过 Astra 向 CX9 下发策略。",
        "DOCA 是 BlueField 与 ConnectX 的统一软件平台（SDK、微服务、Kubernetes 生命周期）。无 DOCA 则 BlueField 仅为带 Arm 核的网卡。DPF 将 DPU 作为 Kubernetes 节点管理。",
        "Quantum InfiniBand 是 Scale-out 的另一产品线。第五支柱表述中 Scale-out 为 Spectrum-X 或 Quantum；Scale-in 接入在公开博客中明确为 Spectrum-X Ethernet。",
    ], 13, INK, 7)
    p += 1
    footer(s, p)

    # 06 CMX NVLink
    s = blank(prs)
    title_block(s, "01  预备知识", "NVLink、CMX / STX 与 RoCE",
                "后文「存储」同时出现 1.45× 与 5× TPS 时，对应两条不同路径。")
    card(s, Inches(0.42), Inches(1.16), Inches(4.05), Inches(5.85))
    add_paras(s, Inches(0.58), Inches(1.32), Inches(3.75), Inches(5.55), [
        ("NVLink（Scale-up）", 14, True, GREEN_DK),
        ("超节点内 GPU 专有互连。Vera Rubin 为 NVLink 6 + NVLink Switch。", 13, False, INK),
        ("不承担用户接入、企业对象存储或租户开通。", 13, False, INK),
        ("与 Scale-in 正交：权重与激活走 NVLink；企业数据走南北向。", 13, False, INK),
    ], spacing=8)
    card(s, Inches(4.65), Inches(1.16), Inches(4.05), Inches(5.85), BLUE_BG, BLUE)
    add_paras(s, Inches(4.81), Inches(1.32), Inches(3.75), Inches(5.55), [
        ("CMX / STX", 14, True, BLUE),
        ("CMX：工厂内 KV cache 层，以太网附加闪存扩展 GPU 内存。宣传约 5× tokens/s。", 13, False, INK),
        ("STX 为模块化底座。Vera BlueField-4 STX：Vera CPU + CX9，最高约 1.6 Tb/s。", 13, False, INK),
        ("软件：DOCA Memos。网络：Spectrum-X RoCE。数据对象是可重算的推理状态，不是企业 NAS。", 13, False, INK),
    ], spacing=7)
    card(s, Inches(8.88), Inches(1.16), Inches(4.05), Inches(5.85), AMBER_BG, AMBER)
    add_paras(s, Inches(9.04), Inches(1.32), Inches(3.75), Inches(5.55), [
        ("RoCE", 14, True, AMBER),
        ("RDMA over Converged Ethernet。Spectrum-X、CMX 访问与部分存储路径均基于 RoCE。", 13, False, INK),
        ("GPU / DPU 可绕过主机协议栈访问远端内存或闪存。Scale-in 的 NVMe-oF 卸载依赖该语义。", 13, False, INK),
    ], spacing=8)
    p += 1
    footer(s, p)

    # 07 naming
    s = blank(prs)
    title_block(s, "02  定义", "Scale-in 指工厂边界接入域",
                "公开名称易与 Scale-up 的方向性产生联想；材料中的含义是南北向，而非收缩集群。")
    add_table(s, Inches(0.42), Inches(1.18), Inches(12.5), Inches(3.35), [
        ["既有称呼", "现行称呼", "典型流量", "主要产品"],
        ["前端 / 南北向", "Scale-in", "用户请求、Agent 工具调用、企业检索、外部存储、开通、遥测", "BF-4 DPU + Spectrum-X"],
        ["算力面 / 东西向", "Scale-out", "集体通信、租户 workload", "CX9 SuperNIC + Spectrum-X / IB"],
        ["柜内 GPU 互连", "Scale-up", "超节点内 GPU↔GPU", "NVLink / NVSwitch"],
        ["跨园区", "Scale-across", "工厂与工厂", "Spectrum-XGS"],
        ["KV / 推理上下文", "CMX", "工厂内可共享 KV cache", "STX + DOCA Memos"],
    ], [Inches(2.35), Inches(1.85), Inches(5.15), Inches(3.15)], True, 11)
    card(s, Inches(0.42), Inches(4.68), Inches(6.1), Inches(2.35))
    add_paras(s, Inches(0.58), Inches(4.80), Inches(5.8), Inches(2.1), [
        ("「取代前端网络」的含义", 13, True, GREEN_DK),
        ("以太网并未取消。南北向物理层仍为 Spectrum-X。改变的是处理位置、策略执行点，以及是否占用宿主机。", 12, False, INK),
        ("由主机 NIC 或可选 DPU 插卡，转为平台标配的基础设施域。", 12, False, INK),
    ], spacing=5)
    card(s, Inches(6.72), Inches(4.68), Inches(6.2), Inches(2.35), AMBER_BG, AMBER)
    add_paras(s, Inches(6.88), Inches(4.80), Inches(5.9), Inches(2.1), [
        ("security 限定词", 13, True, AMBER),
        ("黄仁勋将其与带宽并列提出，重点是安全与管控位于硅上、线速、租户操作系统之外。", 12, False, INK),
        ("Astra 将同一策略扩展到 Scale-out 的 CX9，是相对「仅增加一张 DPU」的主要增量。", 12, False, INK),
    ], spacing=5)
    p += 1
    footer(s, p)

    # 08 five pillars
    s = blank(prs)
    title_block(s, "02  定义", "五支柱的职责与不覆盖范围",
                "前三项扩展算力连接，第四项扩展推理上下文，第五项覆盖算力周围的基础设施。")
    add_table(s, Inches(0.32), Inches(1.16), Inches(12.7), Inches(3.55), [
        ["支柱", "产品", "连接对象", "不覆盖"],
        ["Scale-up", "NVLink / NVSwitch", "柜内 GPU↔GPU", "用户接入、企业数据"],
        ["Scale-out", "Spectrum-X 或 IB + CX9", "工厂内服务器，租户算力面", "南北向接入、存储协议、租户外安全执行"],
        ["Scale-across", "Spectrum-XGS", "分布式工厂 / 多校园", "单工厂内部接入"],
        ["CMX", "STX + Memos", "工厂内共享 KV", "训练数据湖、企业知识库"],
        ["Scale-in", "BF-4 + DOCA + Spectrum-X", "世界与工厂：用户、数据、存储、安全运营", "GPU 集体通信（CX9）"],
    ], [Inches(1.7), Inches(2.85), Inches(4.0), Inches(4.15)], True, 11)
    card(s, Inches(0.42), Inches(4.88), Inches(12.5), Inches(2.15), GREEN_BG, GREEN)
    add_paras(s, Inches(0.6), Inches(5.00), Inches(12.15), Inches(1.9), [
        "官方表述：仅扩大 GPU、机架与数据中心，若数据访问、存储、网络安全与运营不能同步扩展，算力无法转化为工厂吞吐。",
        "带宽非对称：Scale-out 为 4×1.6T，Scale-in 为 1×800G。平台将 KV 优先放在 CMX，外部存储走 Spectrum-X 优化路径，而不是将南北向做成与东西向等宽。",
        "与 captive 推理 ASIC 对照：若前端仍为主机侧普通以太网卡，则不具备租户操作系统外的策略域与存储协议卸载。比较端口速率意义有限。",
    ], 13, INK, 6)
    p += 1
    footer(s, p)

    # 09 why now
    s = blank(prs)
    title_block(s, "02  变化", "传统前端缺少的是独立处理域，而不是端口速率",
                "传统云按软件定义、可组合、弹性构建南北向。智能体工厂中这三项仍必要，但不再充分。")
    items = [
        ("单次请求包含多次推理与工具调用",
         "一次 Agent 调用会触发多次模型、工具、记忆、策略、存储与网络访问。基础设施数据路径成为推理流水线的一段。共设计博客原文：infrastructure is part of the inference pipeline。"),
        ("单服务器接口达到数 Tb/s",
         "Vera Rubin 计算托盘聚合约 7.2 Tb/s：800G 南北向 + 四条 1.6T 东西向。线速加密、NVMe-oF 与 ACL 无法继续依赖主机 CPU。Hot Chips 将早期云 DPU 对照为约 200G 量级插卡。"),
        ("多租户裸金属要求隔离位于租户操作系统之外",
         "主机防火墙与租户处于同一信任域。主机被突破即策略失效。共享 AI 工厂需要将隔离置于租户操作系统之外。"),
        ("存储与检索延迟直接表现为 GPU 空闲",
         "Scale-up / Scale-out 带宽充足并不能替代南北向协议处理。安全过滤若增加软件一跳，尾部时延会先于平均吞吐恶化。"),
    ]
    for i, (h, b) in enumerate(items):
        col, row = i % 2, i // 2
        l = Inches(0.42 + col * 6.35)
        t = Inches(1.18 + row * 2.85)
        card(s, l, t, Inches(6.15), Inches(2.70))
        rect(s, l, t, Inches(0.10), Inches(2.70), GREEN if i < 2 else BLUE)
        add_textbox(s, l + Inches(0.28), t + Inches(0.16), Inches(5.7), Inches(0.40),
                    f"{i+1}.  {h}", 14, True, INK)
        add_textbox(s, l + Inches(0.28), t + Inches(0.60), Inches(5.7), Inches(1.95),
                    b, 13, False, INK)
    p += 1
    footer(s, p)

    # 06 old vs new
    s = blank(prs)
    title_block(s, "02  变化", "传统前端与 Scale-in：五处结构差异",
                "变化的实质是基础设施获得独立的 CPU、内存、加速器与 DOCA，而不是增加一条名为 Scale-in 的网线。")
    add_table(s, Inches(0.32), Inches(1.16), Inches(12.7), Inches(4.55), [
        ["维度", "传统前端 / 可选云 DPU", "Scale-in（Vera Rubin 标配）"],
        ["位置", "主机 PCIe 槽中的 NIC 或可选 DPU", "与 Rubin 共设计。Hot Chips：不再事后加装"],
        ["处理", "策略与协议多在宿主机 CPU 或轻量 Arm", "主机无关：64 核 Grace 运行控制面，inline 引擎运行数据面"],
        ["信任域", "南北向可经 DPU；东西向网卡常仍在租户侧", "Astra：BF-4 下发策略，CX9 在 1.6T 口执行；东西向不经 800G 转发"],
        ["带宽", "Hot Chips 对照云 DPU 约 200G 级", "单卡 800G Scale-in；平台级策略视野覆盖托盘约 7 Tb/s 接口"],
        ["软件", "vSwitch、存储驱动、安全进程分散", "DOCA 微服务与服务功能链：网络 / 安全 / 存储 / 遥测统一编排"],
    ], [Inches(1.55), Inches(5.35), Inches(5.8)], True, 12)
    add_textbox(s, Inches(0.42), Inches(5.88), Inches(12.5), Inches(1.15),
                "官方判断：软件定义、可组合与弹性仍然必要，但不足够。安全、多租户网络、数据与存储访问、基础设施运营必须作为统一的加速域，而不能继续作为互不相干、且主要运行在通用 CPU 上的层次。这是 Scale-in 相对「再采购一张智能网卡」的定义差。",
                13, False, INK)
    p += 1
    footer(s, p)

    # 07 principle silicon
    s = blank(prs)
    title_block(s, "03  原理", "控制面与数据面分离：DOCA 决策，inline 执行",
                "上述工作不交回主机 CPU。这是主机无关基础设施域的物理实现。")
    card(s, Inches(0.42), Inches(1.16), Inches(12.5), Inches(1.35), BLUE_BG, BLUE)
    add_textbox(s, Inches(0.6), Inches(1.28), Inches(12.15), Inches(1.12),
                "软件（Grace 上的 DOCA）决策：策略、开通、编排、遥测汇聚。\n"
                "Inline 加速引擎执行：包、RDMA、存储协议、加密、防火墙、策略命中。\n"
                "二者可并发；策略在工厂级协调，执行在每台机器线速落地。",
                13, False, INK)
    add_table(s, Inches(0.32), Inches(2.66), Inches(12.7), Inches(3.35), [
        ["部件", "功能", "公开规格"],
        ["64 核 Grace", "策略、开通、遥测、基础设施编排", "相对 BF-3 约 6× 算力，以并发多路服务"],
        ["Inline 引擎", "包 / RDMA / 存储 / 加密 / 防火墙 / 策略", "最高 800 Gb/s 线速，减轻 Grace 与主机负担"],
        ["LPDDR5X", "为基础设施软件提供数据与状态", "策略表、队列、遥测、元数据。Hot Chips 约 275 GB/s；手册最多 128 GB"],
        ["PCIe Gen6 x16", "连接主机", "主机与 Scale-in 处理域之间的宽通道"],
        ["800 Gb/s 网口", "连接 Spectrum-X（Scale-in 交换）", "接入、安全、搬移、存储；不是托盘总带宽"],
    ], [Inches(2.15), Inches(4.35), Inches(6.2)], True, 11)
    add_textbox(s, Inches(0.42), Inches(6.15), Inches(12.5), Inches(0.90),
                "相对 BF-3（16× A78、400G、PCIe Gen5）：网络 2×。内存口径两篇官方博客不完全相同——Scale-in 博文写带宽 4×；共设计博文写容量 4×、带宽 >3×。引用时应分开标注。Hot Chips：约 1.7 GHz（低于完整 Grace 服务器，现场记录认为受功耗约束）、200G PAM4 SerDes、inline 加密。",
                12, False, MUTED)
    p += 1
    footer(s, p)

    # 08 7.2T
    s = blank(prs)
    title_block(s, "03  原理", "7.2 Tb/s 必须分流：800G 不是托盘总带宽",
                "租户训练与推理报文走 ConnectX-9，不走 BlueField-4。该数字最易被误读为单口总带宽。")
    card(s, Inches(0.42), Inches(1.16), Inches(6.15), Inches(5.85))
    add_textbox(s, Inches(0.58), Inches(1.28), Inches(5.85), Inches(0.32),
                "Vera Rubin 每个计算托盘", 14, True, GREEN_DK)
    add_textbox(s, Inches(0.58), Inches(1.62), Inches(5.85), Inches(3.6),
                "约 7.2 Tb/s 聚合接口\n\n"
                "  Scale-in    1 × 800 Gb/s     BlueField-4\n"
                "               南北向：请求、存储、管控、安全\n\n"
                "  Scale-out   4 × 1.6 Tb/s     ConnectX-9\n"
                "               东西向：租户 workload / collective\n\n"
                "南北向 : 东西向 ≈ 1 : 8\n"
                "该比例为平台设计，而不是尚未拓宽的缺口。",
                13, False, INK)
    add_textbox(s, Inches(0.58), Inches(5.30), Inches(5.85), Inches(1.5),
                "若将 7.2T 全部经 800G 转发，Scale-out 会先饱和。平台对策不是把前端做成 6.4T，而是：KV 优先留在 CMX，外部存储走 Spectrum-X 优化路径，集体通信留在 ConnectX-9。",
                12, False, MUTED)
    card(s, Inches(6.75), Inches(1.16), Inches(6.15), Inches(2.75), AMBER_BG, AMBER)
    add_paras(s, Inches(6.92), Inches(1.28), Inches(5.85), Inches(2.5), [
        ("三条约束", 14, True, AMBER),
        ("1. 租户训练 / 推理报文走 CX9，不走 BF-4 的 800G。", 13, False, INK),
        ("2. 800G 专用于接入、外部存储与管控。用户请求、开户、遥测走该路径。", 13, False, INK),
        ("3. Astra 将策略下发至 CX9 的 1.6T 口执行，而不是把东西向流量回流 DPU。", 13, False, INK),
    ], spacing=5)
    card(s, Inches(6.75), Inches(4.06), Inches(6.15), Inches(2.95))
    add_paras(s, Inches(6.92), Inches(4.18), Inches(5.85), Inches(2.7), [
        ("Hot Chips 对无平台级 DPU 的对照", 14, True, INK),
        ("仅隔离南北向时，Scale-out 无法与租户切断，GPU 网络不能端到端受控。", 12, False, INK),
        ("若每张 NIC 各自配备 CPU、内存与管理，相对由一张 BF-4 管理全部 CX9，功耗约高 4×。", 12, False, INK),
    ], spacing=5)
    p += 1
    footer(s, p)

    # 09 Astra
    s = blank(prs)
    title_block(s, "03  原理", "Astra：将信任控制点扩展到 Scale-out，流量不必回流",
                "数据手册名称 ASTRA（Advanced Secure Trusted Resource Architecture）。相对「再安装一张 DPU」，这是可核对的增量。")
    card(s, Inches(0.42), Inches(1.16), Inches(12.5), Inches(2.55), GREEN_BG, GREEN)
    add_textbox(s, Inches(0.6), Inches(1.28), Inches(12.15), Inches(2.3),
                "运营者 / DOCA DPF\n"
                "        │  开通、策略、密钥\n"
                "        ▼\n"
                "   BlueField-4（信任控制点，在租户 OS 外）\n"
                "        ├─ 本卡 800G 数据面（Scale-in）→ inline 引擎线速执行\n"
                "        └─ Astra → ConnectX-9 数据面（Scale-out）→ 策略在 1.6T 口原地执行，东西向不回流 DPU",
                13, False, INK)
    add_paras(s, Inches(0.42), Inches(3.85), Inches(12.5), Inches(3.15), [
        "闭环：BF-4 安装或更新策略并采集遥测；CX9 在东西向数据面直接执行。博客原文：同一套 VPC 策略覆盖接入与 Scale-out，无需将全部东西向流量经 800G 口转发。",
        "必要性：Vera Rubin 东西向 6.4T、南北向 800G。若为「看见」租户流量而将报文绕回 DPU，等于用 800G 为 6.4T 做防火墙，物理上不成立。Astra 将「看见」实现为带外控制加网卡原地执行。Hot Chips 演示为 DPU 可见全部 CX9 流量；现场记录认为管理链路类似 PCIe，而非数据面回流。",
        "「7 Tb/s 平台级 DPU」指 800G 本卡加上对四张 1.6T CX9 的策略覆盖，并非 BF-4 具备 7T 网络端口。零信任裸金属：租户无法取得设备管理面。",
        "未公开：Astra 连接 CX9 的物理介质；在非 Rubin 服务器上以 PCIe 卡形式安装 BF-4 时，对第三方网卡是否生效。",
    ], 13, INK, 6)
    p += 1
    footer(s, p)

    # 10 chip
    s = blank(prs)
    title_block(s, "04  芯片", "BlueField-4 DPU：Scale-in 接入卡规格",
                "数据手册与 Hot Chips 现场记录。Grace + ConnectX-9 级网络，角色不是第四张 SuperNIC。")
    kpis = [
        ("800 Gb/s", "Ethernet 或 InfiniBand", "200G PAM4 SerDes；Scale-in 口，不是托盘总和"),
        ("64 核 Grace", "Neoverse V2 @ ~1.7 GHz", "相对 BF-3 约 6× 算力；1.7 GHz 低于完整 Grace 服务器"),
        ("≤128 GB", "LPDDR5X", "Hot Chips 带宽 ~275 GB/s；给策略/队列/遥测/元数据"),
        ("PCIe Gen6", "x16 主机口", "相对 BF-3 的 Gen5；连主机但不走租户数据面主路径"),
    ]
    for i, (v, l1, l2) in enumerate(kpis):
        x = Inches(0.42 + i * 3.18)
        card(s, x, Inches(1.16), Inches(3.05), Inches(2.15), GREEN_BG if i % 2 == 0 else BLUE_BG)
        add_textbox(s, x + Inches(0.14), Inches(1.28), Inches(2.78), Inches(0.50),
                    v, 20, True, GREEN_DK if i % 2 == 0 else BLUE)
        add_textbox(s, x + Inches(0.14), Inches(1.80), Inches(2.78), Inches(0.32),
                    l1, 13, True, INK)
        add_textbox(s, x + Inches(0.14), Inches(2.14), Inches(2.78), Inches(0.95),
                    l2, 11, False, MUTED)
    add_paras(s, Inches(0.42), Inches(3.50), Inches(12.5), Inches(3.5), [
        "形态：PCIe 卡及项目定制形态。Vera Rubin 为平台共设计，而非可选配件。数据手册写明 ASTRA 用于选定 Rubin 平台上的 ConnectX-9。",
        "部署位置：Rubin GPU 计算托盘，以及 Vera CPU 节点。CPU 侧同样需要 Scale-in——智能体的工具调用、检索与校验运行在 Vera 上；若基础设施占用主机核，将增加推理环路中 CPU 段的抖动。",
        "Hot Chips 存储微基准（Grace 版 DPU，不可与 STX 混用）：NVMe-oF 8 核约 1.6 Tb/s，16 核约 2000 万 IOPS，相对无 DPU 路径宣传约 2× 的数据到达 GPU 速度。这是协议卸载能力，不表示 800G 端口变为 1.6T。",
        "Inline 引擎覆盖包处理、RDMA、存储协议、加密、防火墙与策略。控制面可以异步决策，数据面不能每包回核。",
        "转载规格（128 GB、512 GB 板载 SSD、114 MB L3）以数据手册「up to 128 GB LPDDR5x」为准；第三方拆解数字不作官方依据。",
    ], 13, INK, 6)
    p += 1
    footer(s, p)

    # 11 bf3 vs bf4
    s = blank(prs)
    title_block(s, "04  芯片", "相对 BlueField-3：按并发基础设施服务扩核与带宽",
                "上代最多 16 核，面向云基础设施插卡。本代按多服务同时在卡上运行扩核、内存与网络。")
    add_table(s, Inches(0.32), Inches(1.16), Inches(12.7), Inches(3.55), [
        ["", "BlueField-3", "BlueField-4 DPU", "倍数 / 变化"],
        ["CPU", "最多 16× Cortex-A78", "64× Neoverse V2（Grace）", "官方约 6× 算力"],
        ["网络", "400 Gb/s  Ethernet/IB", "800 Gb/s，CX9 级，200G SerDes", "2×"],
        ["主机", "PCIe Gen5", "PCIe Gen6 x16", "代际翻倍"],
        ["内存", "板载 DDR5，常见 16–32 GB", "LPDDR5X，手册最多 128 GB", "容量口径 4×（共设计博客）；带宽 4× 或 >3×，两篇博客不一致"],
        ["定位", "云基础设施可选插卡", "Vera Rubin 标配信任前端", "从配件到共设计"],
    ], [Inches(1.45), Inches(3.15), Inches(4.15), Inches(3.95)], True, 11)
    add_paras(s, Inches(0.42), Inches(4.88), Inches(12.5), Inches(2.1), [
        "约 6× 算力的原因：Scale-in 不是仅做 vSwitch。同一张卡上需并发 HBN、Flow、Argus、Vault、Telemetry、DPF 与存储协议。BF-3 的 16 核面向卸载单张网卡功能；BF-4 的 64 核面向运行一套基础设施操作系统。",
        "约 1.7 GHz 低于完整 Grace 服务器。现场记录认为受 DPU 功耗约束。算力倍数来自核数、微架构与缓存，不完全来自频率。",
        "内存倍数对外引用时应分开标注两篇博客来源，不宜合并为单一「内存 4×」。",
    ], 13, INK, 6)
    p += 1
    footer(s, p)

    # 12 DPU vs STX
    s = blank(prs)
    title_block(s, "04  芯片", "同一名称，两种角色：DPU 与 STX 不可混用",
                "现场记录亦指出应区分为 Grace 版与 Vera 版。混用会将 1.45× 外部存储与 10× CMX IOPS 写入同一张表。")
    card(s, Inches(0.42), Inches(1.16), Inches(6.15), Inches(5.85), GREEN_BG, GREEN)
    add_paras(s, Inches(0.58), Inches(1.28), Inches(5.85), Inches(5.55), [
        ("BlueField-4 DPU（Scale-in）", 16, True, GREEN_DK),
        ("硅：Grace + CX9 级网络", 13, True, INK),
        ("口：800 Gb/s Ethernet 或 IB", 13, False, INK),
        ("放哪：Rubin 计算托盘、Vera CPU 节点", 13, False, INK),
        ("职责：南北向接入、主机卸载、安全、管理、可观测、隔离", 13, False, INK),
        ("存储数字：NVMe-oF 8 核 1.6 Tb/s、16 核 20M IOPS（Hot Chips，本卡卸载）", 12, False, INK),
        ("交换：Spectrum-X 接入路径，相对货架以太网存储最高 1.45×", 12, False, INK),
    ], spacing=7)
    card(s, Inches(6.75), Inches(1.16), Inches(6.15), Inches(5.85), BLUE_BG, BLUE)
    add_paras(s, Inches(6.92), Inches(1.28), Inches(5.85), Inches(5.55), [
        ("Vera BlueField-4 STX（CMX）", 16, True, BLUE),
        ("硅：Vera CPU + ConnectX-9 SuperNIC", 13, True, INK),
        ("口：Spectrum-X 最高 1.6 Tb/s", 13, False, INK),
        ("放哪：STX 模块化存储 / CMX 数据节点", 13, False, INK),
        ("职责：KV I/O、元数据、放置、安全、控制；不是简单的块设备仿真", 13, False, INK),
        ("存储数字：两颗 Vera 版 3.2 Tb/s；DOCA Memos 宣传 10× IOPS、5× 效率", 12, False, INK),
        ("路径：GPU HBM → 系统内存 → 本地/网络存储，工厂内上下文层", 12, False, INK),
    ], spacing=7)
    p += 1
    footer(s, p)

    # 13 DOCA
    s = blank(prs)
    title_block(s, "04  软件", "DOCA：将加速器编排为基础设施操作系统",
                "硬件本身不构成处理域。微服务与服务功能链使一条流按序经过网络、安全与存储。")
    add_table(s, Inches(0.32), Inches(1.16), Inches(12.7), Inches(4.85), [
        ["模块", "作用", "落在哪条路径"],
        ["HBN", "主机侧 L3；BF-4 可当 BGP 路由器，多租户南北向", "Scale-in 接入"],
        ["Flow", "编程硬件包处理流水线：分类、ACL、线速执行", "Scale-in 数据面"],
        ["OVS-DOCA", "东西向接口套同一套策略", "Scale-out 口，配合 Astra"],
        ["Argus", "运行时威胁检测", "安全，租户 OS 外"],
        ["Vault", "文件访问策略", "安全 / 数据访问"],
        ["PCC", "可编程拥塞", "接入与存储路径"],
        ["Telemetry", "设备与服务健康，不依赖租户主机", "运营"],
        ["DPF", "K8s 原生：DPU 当节点来发现、开通、部署、升级", "控制面"],
        ["Astra", "跨 BF-4 与多张 CX9 的统一控制点", "Scale-in 控制 → Scale-out 执行"],
        ["Memos", "KV 在计算节点和存储节点间管理 / 共享", "CMX，不属于 800G 接入路径"],
    ], [Inches(1.7), Inches(6.5), Inches(4.5)], True, 11)
    add_textbox(s, Inches(0.42), Inches(6.15), Inches(12.5), Inches(0.90),
                "生产形态为容器化微服务，直接运行于 BlueField-4；库与 SDK 供自研服务使用。服务功能链的意义是：不必在主机上串联多级 vSwitch，流在 DPU 域内完成分类、加密与存储卸载。Memos 须单独标注——它服务于上下文存储，不是南北向 VPC。",
                12, False, MUTED)
    p += 1
    footer(s, p)

    # 14 Spectrum-X
    s = blank(prs)
    title_block(s, "04  交换", "Spectrum-X 在 Scale-in 路径上的角色",
                "Scale-in 未引入第三种专有交换总线。接入与外部存储仍由 AI 以太网承载；Vera Rubin 同代为 Spectrum-6。")
    add_paras(s, Inches(0.42), Inches(1.18), Inches(12.5), Inches(2.2), [
        "分工：BlueField-4 在节点上处理服务（策略、协议、加密、遥测）；Spectrum-X 在工厂与外部之间转发。没有交换机，DPU 只是加速网卡；没有 DPU，交换机只是转发未经卸载的主机流量。",
        "公开能力针对 AI 流量特征：哈希极化与负载不均、incast 拥塞、多流争用。目标是提高有效带宽并隔离并发流，使接入与存储更可预期——对应尾部时延，而不只是端口速率。§1 所述 AR / DDP / CC / PLB 在此用于接入与存储流，而不是 NCCL collective。",
        "存储数字须带条件：相对货架以太网最高约 1.45×。Hot Chips 按对象大小给出 5 GB 1.5×、10 GB 1.4×、50 GB 1.3×。增益随对象增大而收窄，说明收益来自拥塞隔离与中小对象，而不是把物理口从 400G 线性外推到 800G。",
    ], 13, INK, 8)
    card(s, Inches(0.42), Inches(3.55), Inches(4.05), Inches(3.45))
    add_paras(s, Inches(0.58), Inches(3.70), Inches(3.75), Inches(3.15), [
        ("与 Scale-out 的关系", 14, True, GREEN_DK),
        ("Spectrum-X 同时出现在 Scale-out 与 Scale-in 表述中。Scale-out 承载 CX9 上的集体通信；Scale-in 承载 BF-4 上的接入与存储。是否共用 leaf 平面，官方未说明。", 12, False, INK),
    ], spacing=6)
    card(s, Inches(4.65), Inches(3.55), Inches(4.05), Inches(3.45))
    add_paras(s, Inches(4.81), Inches(3.70), Inches(3.75), Inches(3.15), [
        ("与 CMX 的关系", 14, True, BLUE),
        ("CMX 亦走以太网附加闪存，处理器为 STX。Scale-in 的 1.45× 是外部存储路径相对货架以太网；CMX 的 10× IOPS 属于上下文层。两套数字不可合并。", 12, False, INK),
    ], spacing=6)
    card(s, Inches(8.88), Inches(3.55), Inches(4.05), Inches(3.45), AMBER_BG, AMBER)
    add_paras(s, Inches(9.04), Inches(3.70), Inches(3.75), Inches(3.15), [
        ("共设计约束", 14, True, AMBER),
        ("官方强调 BF-4、DOCA、Spectrum-X 与 Vera Rubin 共设计：核、内存带宽、PCIe、网络、加速与软件需互相匹配。仅更换一张 800G 网卡无法复制该路径。", 12, False, INK),
    ], spacing=6)
    p += 1
    footer(s, p)

    # 15 VPC
    s = blank(prs)
    title_block(s, "05  用例", "隔离的 AI 工厂 VPC",
                "多租户共享物理资源。南北向与东西向若使用两套策略，隔离不完整。")
    card(s, Inches(0.42), Inches(1.16), Inches(4.05), Inches(5.85), AMBER_BG, AMBER)
    add_paras(s, Inches(0.58), Inches(1.32), Inches(3.75), Inches(5.55), [
        ("问题", 14, True, AMBER),
        ("共享 AI 工厂需要按云的方式开通租户，但不能把隔离交给租户操作系统。", 13, False, INK),
        ("若仅在南北向 DPU 上划分 VRF，东西向 CX9 仍对租户可见，租户之间的东西向隔离不完整。", 13, False, INK),
        ("若将东西向回流 800G 做防火墙，6.4T 流量没有物理容量。", 13, False, INK),
    ], spacing=8)
    card(s, Inches(4.65), Inches(1.16), Inches(4.05), Inches(5.85), GREEN_BG, GREEN)
    add_paras(s, Inches(4.81), Inches(1.32), Inches(3.75), Inches(5.55), [
        ("机制", 14, True, GREEN_DK),
        ("HBN：在 BF-4 上加速南北向 L3 与租户隔离，可作为 BGP 路由器。", 13, False, INK),
        ("Flow：分类与 ACL，下发到硬件流水线。", 13, False, INK),
        ("OVS-DOCA：将同一策略应用到东西向接口。", 13, False, INK),
        ("Astra：再下发到 CX9。7.2 Tb/s 接口处于同一策略模型，东西向不经 800G 转发。", 13, False, INK),
    ], spacing=8)
    card(s, Inches(8.88), Inches(1.16), Inches(4.05), Inches(5.85), BLUE_BG, BLUE)
    add_paras(s, Inches(9.04), Inches(1.32), Inches(3.75), Inches(5.55), [
        ("结果", 14, True, BLUE),
        ("运营侧集中开通 VPC，租户继续使用加速交换。", 13, False, INK),
        ("隔离一致，主机 CPU 不承担 vSwitch。", 13, False, INK),
        ("裸金属亦可多租户：设备管理面在 DPU，不在租户。", 13, False, INK),
        ("因此 Scale-in 与 Scale-out 须由同一控制点管理。", 13, False, INK),
    ], spacing=8)
    p += 1
    footer(s, p)

    # 16 security
    s = blank(prs)
    title_block(s, "05  用例", "硅上安全：黄仁勋所称的 Scale-in security networking",
                "执行点在硬件，且位于租户操作系统之外。这是第五支柱进入财报「五种网络系统」的原因。")
    add_paras(s, Inches(0.42), Inches(1.16), Inches(12.5), Inches(1.55), [
        "问题：主机侧安全与负载同信任域；软件防火墙增加一跳；智能体反复访问数据、模型、工具与 KV，使攻击面位于推理路径上。共设计博客：安全不能只依赖主机软件，因为控制边界与被保护的负载是同一台机器。",
        "智能体改变安全模型：一次会话内策略检查次数随工具调用线性增加。线速执行不是「更快的 WAF」，而是推理 SLA 的一部分。",
    ], 13, INK, 6)
    add_table(s, Inches(0.32), Inches(2.85), Inches(12.7), Inches(2.55), [
        ["组件", "管什么", "为什么必须在 DPU 域"],
        ["Argus", "运行时威胁检测", "检测器若位于租户内，租户可以关闭"],
        ["Vault", "文件访问策略", "模型与数据文件不能仅依赖主机 ACL"],
        ["Flow", "网络线速策略", "每包回主机核会先耗尽 CPU"],
        ["Astra", "南北向与东西向同步加密、隔离、密钥、遥测", "仅保护 800G、不保护 6.4T，等于未保护算力面"],
    ], [Inches(1.6), Inches(4.3), Inches(6.8)], True, 12)
    add_textbox(s, Inches(0.42), Inches(5.55), Inches(12.5), Inches(1.45),
                "结果：租户软件无法关闭上述控制；主机 CPU 不承担安全过滤；共享 AI 服务具备一致保护。对应零信任裸金属：租户获得加速器，无法获得基础设施控制面。未公开：Argus 的观测语义（系统调用 / eBPF / 包级）与密钥托管层次。",
                13, False, INK)
    p += 1
    footer(s, p)

    # 17 storage
    s = blank(prs)
    title_block(s, "05  用例", "加速存储接入：外部数据，不是 CMX",
                "GPU 具备算力与 NVLink，仍可能因存储协议在主机上排队而空闲。该路径连接训练数据、模型资产与企业知识。")
    card(s, Inches(0.42), Inches(1.16), Inches(12.5), Inches(1.25), AMBER_BG, AMBER)
    add_textbox(s, Inches(0.6), Inches(1.32), Inches(12.15), Inches(0.95),
                "边界：Scale-in 存储路径 = 工厂外部 / 企业侧数据进入。CMX = 工厂内 KV / 可复用推理状态。1.45× 与 10× IOPS 不是同一实验。BF-4 DPU 卸载 NVMe-oF、文件 / 对象（RDMA 与 TCP）、存储虚拟化与搬移；STX 卸载 KV 元数据、放置与召回。",
                13, False, INK)
    add_paras(s, Inches(0.42), Inches(2.55), Inches(12.5), Inches(2.35), [
        "机制：协议栈与虚拟化在 DPU 上运行，主机可继续看到标准网卡或存储设备模型（VirtIO、DOCA SNAP 一类），后台为加速路径。Spectrum-X 在该路径上提供拥塞管理与流隔离，避免多租户检索降低有效带宽。",
        "数字：相对货架以太网最高约 1.45× 吞吐；Hot Chips 5 / 10 / 50 GB 对象对应 1.5 / 1.4 / 1.3×。Grace 版 DPU 微基准 8 核 1.6 Tb/s NVMe-oF、16 核 20M IOPS，宣传约 2× 数据到达 GPU——对照基线未完全公开，引用时应标明宣传口径。",
        "与 Scale-up 正交：NVLink 解决 GPU 之间的权重与激活搬运，不把企业对象存储搬入 HBM。智能体检索、训练数据加载与 checkpoint 走南北向存储路径。",
    ], 13, INK, 7)
    card(s, Inches(0.42), Inches(5.05), Inches(12.5), Inches(1.95), GREEN_BG, GREEN)
    add_textbox(s, Inches(0.6), Inches(5.18), Inches(12.15), Inches(1.7),
                "800G 是否先饱和：东西向 6.4T 与南北向 800G 为 8:1。平台对策是（1）KV 尽量留在 CMX，不走该 800G；（2）外部存储依赖 Spectrum-X 提高有效带宽；（3）不将 Scale-in 口做成与 Scale-out 对等。若智能体把大量中间状态当作外部对象往返传输，800G 仍可能成为瓶颈——这是架构选择。",
                13, False, INK)
    p += 1
    footer(s, p)

    # 18 control plane
    s = blank(prs)
    title_block(s, "05  用例", "控制面：主机可用之前先下发策略",
                "若管控运行在主机上，主机尚未启动或已被租户控制时，工厂无法自举。")
    add_paras(s, Inches(0.42), Inches(1.18), Inches(12.5), Inches(1.7), [
        "AI 工厂节点须先开通网络与存储、装好策略，才能运行负载。传统 PXE 加主机进程的顺序是：主机操作系统启动后再下发策略。多租户裸金属在此窗口内处于无策略状态。",
        "Scale-in 将顺序倒置：DPU 先于主机可用，策略先行，再通过网络启动主机操作系统。租户软件启动时，隔离与加密已在硅上生效。",
    ], 13, INK, 7)
    add_table(s, Inches(0.32), Inches(3.05), Inches(12.7), Inches(2.35), [
        ["步骤", "谁做", "为什么不能放主机"],
        ["发现 / 开通 DPU", "DPF，把 DPU 当 K8s 节点", "主机还没 OS"],
        ["下发网络、存储、安全策略", "DOCA 微服务 + Astra", "必须在租户可访问设备之前"],
        ["网络启动主机 OS", "BF-4 控制面", "安装镜像也不应走未经隔离的网络"],
        ["之后的升级、扩容", "DPF 服务部署与滚动", "升级基础设施不能打扰租户 GPU 作业"],
    ], [Inches(3.3), Inches(3.5), Inches(5.9)], True, 12)
    add_textbox(s, Inches(0.42), Inches(5.55), Inches(12.5), Inches(1.45),
                "DPF（DOCA Platform Framework）是 Kubernetes 原生编排：发现、开通、服务部署与升级。运营者按基础设施节点机群管理 DPU，而不是逐卡远程登录。结果是部署更短、配置更一致、主机 CPU 不承担管控、新算力更快上线。这与「DPU 为可选加速器」不兼容——控制面依赖其常驻，因此 Vera Rubin 将其纳入共设计。",
                13, False, INK)
    p += 1
    footer(s, p)

    # 19 telemetry
    s = blank(prs)
    title_block(s, "05  用例", "可观测：观测点位于租户操作系统之外",
                "五个用例共用同一结构：服务运行于 DPU 域，执行位于 inline 引擎或 CX9，主机保留 AI 负载。")
    card(s, Inches(0.42), Inches(1.16), Inches(6.15), Inches(3.55))
    add_paras(s, Inches(0.58), Inches(1.28), Inches(5.85), Inches(3.3), [
        ("Telemetry 机制", 15, True, GREEN_DK),
        ("从 BlueField-4 采集网络、存储访问、服务健康、性能与利用率，导出到监控平台。库供 ISV 接入同一信号。", 13, False, INK),
        ("视野可延伸到 GPU 与网络利用率，用于区分接入拥塞、东西向拥塞、存储等待、策略开销或作业放置问题。", 13, False, INK),
        ("租户可以停止主机侧采集进程或提供不准确的指标；DPU 域指标不经过租户操作系统。", 13, False, INK),
    ], spacing=6)
    card(s, Inches(6.75), Inches(1.16), Inches(6.15), Inches(3.55), BLUE_BG, BLUE)
    add_paras(s, Inches(6.92), Inches(1.28), Inches(5.85), Inches(3.3), [
        ("五个用例的共同结构", 15, True, BLUE),
        ("VPC：策略在 DPU，执行在 800G 与 CX9。", 13, False, INK),
        ("安全：检测与强制在租户操作系统之外。", 13, False, INK),
        ("存储：协议栈在 DPU，缩短 GPU 等待数据的时间。", 13, False, INK),
        ("控制面：主机尚未启动时处理域已经存在。", 13, False, INK),
        ("遥测：观测点同样位于该域之外。", 13, False, INK),
    ], spacing=5)
    card(s, Inches(0.42), Inches(4.88), Inches(12.5), Inches(2.12), GREEN_BG, GREEN)
    add_textbox(s, Inches(0.6), Inches(5.02), Inches(12.15), Inches(1.85),
                "该结构决定了 Scale-in 不是功能清单。缺少 Astra，东西向用例不成立；缺少 inline 引擎，安全与存储只能回到主机核；缺少 DPF，控制面仍在主机上。产品材料将五条分开陈述，工程上它们是同一台 DPU 上的服务功能链。",
                13, False, INK)
    p += 1
    footer(s, p)

    # 20 CMX vs scale-in
    s = blank(prs)
    title_block(s, "06  边界", "Scale-in 连接外部数据，CMX 连接内部上下文",
                "BlueField-4 家族两条数据路径。将两套性能数字写入同一张表是最常见的误读。")
    add_textbox(s, Inches(0.42), Inches(1.16), Inches(12.5), Inches(1.55),
                "企业数据 / 训练数据 / 用户请求\n"
                "        │  Scale-in（Spectrum-X + BF-4 DPU 800G）\n"
                "        ▼  Rubin / Vera 计算   ── Scale-up NVLink / Scale-out CX9\n"
                "        │  KV 放不下 HBM 时\n"
                "        ▼  CMX（STX 存储处理器 + DOCA Memos）→ 工厂内可共享上下文层",
                13, False, INK)
    add_table(s, Inches(0.32), Inches(2.85), Inches(12.7), Inches(2.55), [
        ["", "Scale-in 存储路径", "CMX"],
        ["数据是什么", "训练数据、模型、企业知识、应用对象", "KV cache、可复用推理状态"],
        ["处理器", "BF-4 DPU（Grace + 800G）", "BF-4 STX（Vera + 最高 1.6T）"],
        ["丢了会怎样", "业务数据损坏，要持久化/复制", "部分 KV 可重算，经济模型不同"],
        ["公开数字", "vs 货架以太网最高 1.45×", "两颗 Vera 版 3.2 Tb/s；宣传 10× IOPS"],
    ], [Inches(1.9), Inches(5.4), Inches(5.4)], True, 12)
    add_textbox(s, Inches(0.42), Inches(5.55), Inches(12.5), Inches(1.45),
                "官方表述：BlueField-4 既可作为 Scale-in 的基础设施处理器，也可作为 CMX 的存储处理器，二者职责不同。Scale-in 把工厂数据与外部企业数据接到算力上；CMX 保存并共享上下文，减少反复 prefill。智能体工厂两者都需要：没有 Scale-in，企业知识无法进入；没有 CMX，长上下文会同时占满 HBM 与前端 800G。",
                13, False, INK)
    p += 1
    footer(s, p)

    # 21 impact
    s = blank(prs)
    title_block(s, "07  影响", "网络从单一种类扩展为多种系统，DPU 从配件变为平台",
                "黄仁勋用 Scale-in security networking 解释每 GW 收入机会。基础设施进入推理 SLA。")
    boxes = [
        (GREEN_BG, GREEN, "多种网络系统可售",
         "Hopper 时期大约为 GPU 加 InfiniBand。Vera Rubin 需要 CPU 以及多种网络才能覆盖数据中心，再加上 Scale-in security networking 与 Scale-across，可视为五种网络系统。电话会将每 GW 收入机会表述为约 400 亿美元。DPU 不再是附件，而是与 NVLink、Spectrum 同级的可售系统。"),
        (BLUE_BG, BLUE, "标配信任前端",
         "Hot Chips：云 DPU 是可替换插卡；BlueField-4 共设计进入每个 Vera Rubin 系统。云与 neocloud 可按「策略在 DPU、负载在 GPU」提供裸金属多租户。自建工厂的南北向安全不再主要依赖主机进程。"),
        (AMBER_BG, AMBER, "基础设施进入 SLA",
         "tokens/MW、TTFT、P99 将部分取决于：800G 接入是否拥塞、存储卸载是否足够、CX9 上策略是否线速执行、以及 KV 是否由 CMX 复用。Scale-in 是 NVIDIA 将这些因素纳入自家平台的方式。"),
        (WHITE, LINE, "与自研 ASIC 的对照维度",
         "Jalapeño 前端仍是主机侧 400G 以太网卡，scale-up 由加速器承担。不宜比较前端端口谁更大，应比较：策略执行点是否在租户操作系统之外；东西向是否纳入同一控制点（Astra）；存储协议是否卸载；前端与多 Tb/s Scale-out 是否刻意保持非对称。"),
    ]
    for i, (fill, ln, h, b) in enumerate(boxes):
        col, row = i % 2, i // 2
        l = Inches(0.42 + col * 6.35)
        t = Inches(1.16 + row * 2.90)
        card(s, l, t, Inches(6.15), Inches(2.75), fill, ln)
        add_textbox(s, l + Inches(0.18), t + Inches(0.12), Inches(5.8), Inches(0.36),
                    h, 14, True, INK)
        add_textbox(s, l + Inches(0.18), t + Inches(0.50), Inches(5.8), Inches(2.1),
                    b, 12, False, INK)
    p += 1
    footer(s, p)

    # 22 controversy
    s = blank(prs)
    title_block(s, "07  影响", "争议、瓶颈与未公开项",
                "SDxCentral 认为第五支柱是南北向 DPU 的重新包装。工程上应承认「南北向需要加速」并非新命题，同时把可核对的增量写清楚。")
    add_table(s, Inches(0.32), Inches(1.16), Inches(12.7), Inches(3.15), [
        ["争议 / 风险", "如何理解", "不宜推论为"],
        ["命名重新包装", "南北向 DPU 不是新物种。可核对增量：Rubin 标配、Astra 覆盖 CX9、与 CMX / STX 分工", "NVIDIA 发明了第六种互连"],
        ["800G 容量", "与东西向 8:1 是选择：KV 留 CMX、外部存储走优化路径", "该比例将很快改为 6.4T 前端"],
        ["「7T 平台级 DPU」", "800G 本卡 + 对四张 1.6T CX9 的策略覆盖；演示是可见，不是全部流量穿过", "BF-4 具备 7T 网络端口"],
        ["SKU 同名", "DPU = Grace + 800G；STX = Vera + 最高 1.6T。对外表述须加后缀", "一张卡同时是 800G 与 3.2T"],
    ], [Inches(2.2), Inches(6.3), Inches(4.2)], True, 11)
    add_paras(s, Inches(0.42), Inches(4.48), Inches(12.5), Inches(2.5), [
        "未公开，不宜当作已定规格：整卡 TDP；每个 NVL72 托盘是否固定一张 BF-4；Astra 连接 CX9 的物理介质（现场记录为可能的 PCIe）；1.45× / 2× / 10× 的对照基线；Argus 检测语义；Scale-in 与 Scale-out 是否共用 leaf；非 Rubin 服务器上 Astra 对第三方网卡是否生效。",
        "对外转述内存倍数时分开引用两篇官方博客。Hot Chips 1.7 GHz、275 GB/s 为现场幻灯，以数据手册为准。",
        "可确定的判断：Scale-in 是前端网络的产品化升级——处理域独立、信任域扩展到 CX9、存储 / 安全 / 管控从主机卸载。它不替代 NVLink，也不替代 Spectrum-X 算力面。",
    ], 13, INK, 6)
    p += 1
    footer(s, p)

    # 23 recap
    s = blank(prs)
    title_block(s, "08  收束", "读完应能复述的五句话",
                "概念、变化、原理、产品、影响各一句。")
    recap = [
        ("概念", "Scale-in 是加速后的前端 / 南北向接入域，不是 Scale-up 的反向，也不替代 ConnectX-9 上的算力面。"),
        ("变化", "从「主机 SDN + 可选 DPU 插卡」变为「Vera Rubin 标配的主机无关基础设施域」。"),
        ("原理", "Grace 决策，inline 执行；Astra 将策略下发至 CX9，东西向流量不经 800G 转发。"),
        ("产品", "BF-4 DPU（800G，Scale-in）与 BF-4 STX（CMX 存储）同名不同角色；软件是 DOCA，交换是 Spectrum-X。"),
        ("影响", "多种网络系统可售、DPU 进入推理 SLA；800G 相对 6.4T 为刻意非对称；可核对增量是 Astra 与平台标配。"),
    ]
    for i, (k, v) in enumerate(recap):
        y = Inches(1.16 + i * 1.08)
        card(s, Inches(0.42), y, Inches(12.5), Inches(0.98))
        rect(s, Inches(0.42), y, Inches(0.12), Inches(0.98), GREEN)
        add_textbox(s, Inches(0.72), y + Inches(0.12), Inches(1.5), Inches(0.74),
                    k, 16, True, GREEN_DK, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)
        add_textbox(s, Inches(2.30), y + Inches(0.12), Inches(10.4), Inches(0.74),
                    v, 14, False, INK, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)
    p += 1
    footer(s, p)

    # 24 sources
    s = blank(prs)
    title_block(s, "09  来源", "公开材料与引用边界",
                "2026-08/09 口径。后续 Rubin 量产 SKU 和 DOCA 版本还会变。")
    add_paras(s, Inches(0.42), Inches(1.18), Inches(12.5), Inches(5.8), [
        "Scale-in / BlueField-4：NVIDIA Technical Blog《BlueField-4 Powers New Scale-In…》（2026-08-24）与共设计博文；Hot Chips 2026 / ServeTheHome；BlueField-4 数据手册；Gilad / Converge Digest；FY2027 Q2 电话会；SDxCentral 质疑。",
        "Spectrum-X 产品：nvidia.com/spectrumx 与 Ethernet 产品页——端到端 AI 以太网平台；相对货架以太网约 1.6×、十万 GPU 级约 95% 有效带宽。数据手册：AR、可编程拥塞控制、性能隔离、硬件多平面。",
        "Spectrum-X 机制：技术博客 Giga-Scale Ethernet Evolution（AR / CC / PLB）；Optimize Large-Scale AI Workloads（乱序由 SuperNIC 重排；Israel-1 约 1.6×）；架构白皮书（DDP：有效带宽约 60% → 95%）。",
        "Spectrum-6：102.4 Tb/s ASIC 数据手册。Spectrum-XGS：2025-08 新闻稿与 scale-across 博客，跨约 10 km NCCL 最高约 1.9×。SuperNIC：Hopper BF-3、Blackwell CX8、Rubin CX9；CX8/CX9 支持硬件 PLB。",
        "存储交换材料：Spectrum-X 存储路径自适应路由最高约 1.6× I/O，与 Scale-in 的 1.45×、CMX 的 5× TPS 分开引用。arXiv:2605.21187 描述多平面控制环。",
        "DOCA / CMX：DOCA 产品页；CMX 博客与产品页；Converge Digest：BlueField-4 STX。",
        "内存倍数两篇官方博客不一致，文中已分开标注。演示数字未给对照基线的，按宣传口径引用。完整 URL 见同目录 Markdown「来源」节。",
    ], 13, INK, 7)
    p += 1
    footer(s, p)

    assert p == TOTAL, p
    prs.save(OUT)
    print(f"Wrote {OUT} ({p} slides)")


if __name__ == "__main__":
    build()
