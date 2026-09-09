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

OUT = "docs/nvidia-scale-in/NVIDIA_Scale_in_网络基础设施洞察_v1.pptx"
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
TOTAL = 24


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
                "NVIDIA AI 网络第五支柱  ·  技术洞察  ·  v1", 14, True, GREEN_DK)
    add_textbox(s, Inches(0.7), Inches(1.75), Inches(12), Inches(1.15),
                "Scale-in：把前端网络做成\nAI 工厂的基础设施域", 32, True, INK)
    add_paras(s, Inches(0.7), Inches(3.15), Inches(11.8), Inches(1.35), [
        "它不是第六种 GPU 互连。Gilad 的定位是：Scale-in 取代过去所谓的前端网络——世界与 AI 工厂之间的南北向进出。",
        "黄仁勋在 FY2027 Q2 把它说成 Scale-in security networking：安全与管控从租户主机里拔出来，做到硅上、线速、主机无关。",
        "硬件落点：BlueField-4 DPU + DOCA + Spectrum-X。Vera BlueField-4 STX 是同一家族的存储处理器，给 CMX，不要和 800G 接入卡混。",
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
                "口径：NVIDIA Technical Blog、Hot Chips 2026、FY2027 Q2 电话会、BlueField-4 数据手册。未公布处已标明。",
                11, False, MUTED)
    p += 1
    footer(s, p)

    # 02 thesis
    s = blank(prs)
    title_block(s, "00  先钉结论", "Scale-in 管的是工厂边界，不是 GPU 之间",
                "三天口径同一件事。读错名字会把第五支柱写成第六种 NVLink。")
    card(s, Inches(0.42), Inches(1.18), Inches(12.5), Inches(1.15), GREEN_BG, GREEN)
    add_textbox(s, Inches(0.6), Inches(1.28), Inches(12.15), Inches(0.95),
                "一句话：Scale-up / Scale-out 把算力面扩到每托盘数 Tb/s 之后，用户、Agent、企业数据、外部存储、管控和安全如果还跑在通用宿主机 CPU 上，会先把 GPU 饿死，也会让多租户隔离停在租户 OS 里、可被绕过。Scale-in 给这些功能单独的 CPU、加速器和信任域。",
                13, False, INK)
    add_table(s, Inches(0.42), Inches(2.48), Inches(12.5), Inches(2.55), [
        ["时间", "谁", "原话指向", "工程翻译"],
        ["8/24", "NVIDIA 博客", "AI 网络第五支柱：安全、管理、运营的专用加速", "南北向从 SDN 变成共设计加速域"],
        ["8/25", "Gilad / Hot Chips", "Scale-in 取代过去所谓的前端网络", "世界↔工厂进出；BF-4 + Spectrum-X"],
        ["8/26", "黄仁勋 Q&A", "Scale-in security networking", "安全从主机拔出；五种网络之一，撑每 GW 收入盘"],
    ], [Inches(1.15), Inches(1.85), Inches(5.0), Inches(4.5)], True, 11)
    add_paras(s, Inches(0.42), Inches(5.18), Inches(12.5), Inches(1.9), [
        "解决什么：接入、线速安全、存储协议卸载、开户、遥测——全部主机无关。",
        "不解决什么：柜内 NVLink、柜间 collective、跨园区 Spectrum-XGS、工厂内 KV 共享（那是 CMX）。",
        "芯片不要混：计算托盘上的 BlueField-4 DPU 是 800G 接入卡；Vera BlueField-4 STX 是 CMX 存储处理器。对外都叫 BlueField-4，洞察里必须拆开。",
        "和「多了一根网线」的差别：基础设施有了自己的操作系统（DOCA），和租户 CPU/GPU 分开。",
    ], 13, INK, 6)
    p += 1
    footer(s, p)

    # 03 naming
    s = blank(prs)
    title_block(s, "01  概念", "Scale-in 不是 Scale-up 的反向",
                "名字像「向内扩」。公开材料指工厂边界向内看的接入域。")
    add_table(s, Inches(0.42), Inches(1.18), Inches(12.5), Inches(3.35), [
        ["口头习惯", "NVIDIA 现在的叫法", "典型流量", "典型产品"],
        ["前端 / 南北向 / N-S / frontend", "Scale-in", "用户请求、Agent 调工具、企业检索、外部存储、开户、遥测", "BF-4 DPU + Spectrum-X"],
        ["后端 / 东西向 / 算力面", "Scale-out", "训练/推理 collective、租户 workload、机架间 GPU 通信", "CX9 SuperNIC + Spectrum-X / IB"],
        ["柜内 GPU 当一台", "Scale-up", "同一超节点 GPU↔GPU", "NVLink / NVSwitch"],
        ["跨园区 / 多校园", "Scale-across", "工厂和工厂之间", "Spectrum-XGS"],
        ["KV / 推理上下文", "CMX", "工厂内可共享 KV cache，不是企业 NAS", "STX + DOCA Memos"],
    ], [Inches(3.05), Inches(2.15), Inches(4.55), Inches(2.75)], True, 11)
    card(s, Inches(0.42), Inches(4.68), Inches(6.1), Inches(2.35))
    add_paras(s, Inches(0.58), Inches(4.80), Inches(5.8), Inches(2.1), [
        ("Gilad 那句怎么用", 13, True, GREEN_DK),
        ("「取代前端网络」不是以太网消失。南北向物理上还是 Spectrum-X。变的是：谁处理、谁执行策略、还能不能占用宿主机。", 12, False, INK),
        ("前端仍在，只是从「主机上的一张 NIC / 可选 DPU」变成「标配的基础设施域」。", 12, False, INK),
    ], spacing=5)
    card(s, Inches(6.72), Inches(4.68), Inches(6.2), Inches(2.35), AMBER_BG, AMBER)
    add_paras(s, Inches(6.88), Inches(4.80), Inches(5.9), Inches(2.1), [
        ("黄仁勋为什么加 security", 13, True, AMBER),
        ("Scale-in 被单独拎出来卖的，不只是 800G 带宽，而是把安全与管控做到硅上、线速、租户 OS 外。", 12, False, INK),
        ("后面 Astra 把同一套策略伸到 scale-out 的 CX9——这才是「第五支柱」相对「再插一张 DPU」的增量。", 12, False, INK),
    ], spacing=5)
    p += 1
    footer(s, p)

    # 04 five pillars
    s = blank(prs)
    title_block(s, "01  概念", "五支柱：各自解决什么，不解决什么",
                "前三根扩算力连接，第四根扩推理上下文，第五根管算力周围的基础设施。")
    add_table(s, Inches(0.32), Inches(1.16), Inches(12.7), Inches(3.55), [
        ["支柱", "产品", "连接谁", "不解决什么"],
        ["Scale-up", "NVLink / NVSwitch", "柜内 GPU↔GPU，相干加速器", "用户怎么进来；企业数据怎么来"],
        ["Scale-out", "Spectrum-X 或 IB + CX9", "工厂内服务器↔服务器，租户算力面", "南北向接入、存储协议、租户外安全"],
        ["Scale-across", "Spectrum-XGS", "分布式工厂 / 多校园", "单工厂内部的接入与安全"],
        ["CMX", "STX 模块化存储 + Memos", "工厂内共享 KV、可复用推理状态", "训练数据湖、企业知识库（Scale-in 路径）"],
        ["Scale-in", "BF-4 + DOCA + Spectrum-X", "世界↔工厂：用户、数据、存储、云、安全运营", "GPU 集体通信本身（那是 CX9）"],
    ], [Inches(1.7), Inches(2.85), Inches(4.35), Inches(3.8)], True, 11)
    card(s, Inches(0.42), Inches(4.88), Inches(12.5), Inches(2.15), GREEN_BG, GREEN)
    add_paras(s, Inches(0.6), Inches(5.00), Inches(12.15), Inches(1.9), [
        "博客原话大意：只把 GPU、机架、数据中心做大，如果数据访问、存储、网络安全和运营跟不上，扩出来的算力变不成工厂吞吐。",
        "对照 Jalapeño（点到为止）：Katsu 上 400G=2×200G 才是真前端网卡，scale-up 走 XPU SerDes+Tomahawk。NVIDIA 把「那张前端网」升级成每计算托盘一张 800G BF-4，再用 Astra 把策略伸到 CX9。前端不再是一张普通 NIC。",
        "读五支柱时记住非对称：Scale-out 是 4×1.6T，Scale-in 是 1×800G。NVIDIA 没有把南北向做成和东西向一样宽，而是把 KV 尽量留 CMX、外部存储走优化路径。",
    ], 13, INK, 6)
    p += 1
    footer(s, p)

    # 05 why now
    s = blank(prs)
    title_block(s, "02  变化", "旧前端缺的不是端口，是处理域",
                "传统云按 SDN、可组合、弹性建南北向。Agentic 工厂里这三样仍必要，但不再充分。")
    items = [
        ("一次请求不再是一次推理",
         "一次 Agent 调用会触发多次模型、工具、记忆、策略、存储和网络。基础设施数据路径变成推理流水线的一段，而不是推理旁边的管道。共设计博客把这句话写死：infrastructure is part of the inference pipeline。"),
        ("每服务器从百 G 到多 Tb/s",
         "Vera Rubin 计算托盘聚合约 7.2 Tb/s：800G 南北向 + 四条 1.6T 东西向。线速加密、NVMe-oF、ACL 不能再指望主机 CPU。云 DPU 的 200G 级插卡对不上这个量级。"),
        ("多租户裸金属需要租户够不着的信任域",
         "主机里的 iptables / 软件防火墙和租户同一信任域。主机被突破 = 策略被关。共享 AI 工厂要把隔离做到租户 OS 之外。"),
        ("GPU 会等数据",
         "Scale-up / Scale-out 再快，存储协议和检索如果在主机上排队，GPU 照样空转。安全过滤若再加一跳软件，P99 先坏。"),
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
    title_block(s, "02  变化", "旧前端 vs Scale-in：五处真正改掉的",
                "核心不是多了一根叫 Scale-in 的网线，而是基础设施有了自己的 CPU、内存、加速器和 DOCA。")
    add_table(s, Inches(0.32), Inches(1.16), Inches(12.7), Inches(4.55), [
        ["维度", "旧前端 / 云 DPU 可选插卡", "Scale-in（Vera Rubin 标配）"],
        ["位置", "主机 PCIe 槽里一张 NIC 或可选 DPU", "和 Rubin 共设计进每一台系统。Hot Chips：不再事后插卡"],
        ["处理", "策略和协议多半在宿主机 CPU 或轻量 Arm", "主机无关：64 核 Grace 跑控制面，inline 引擎跑数据面，不回主机"],
        ["信任域", "南北向可走 DPU；东西向 NIC 往往仍在租户侧", "Astra：BF-4 定策略，CX9 在 1.6T 口原地执行；东西向不回流 800G"],
        ["带宽", "Hot Chips 对比云 DPU 约 200G 级", "单卡 800G Scale-in；托盘级宣称 7T 平台级 DPU 视野（含 CX9）"],
        ["软件", "vSwitch、存储驱动、安全 agent 分散", "DOCA 微服务 + 服务功能链：网络/安全/存储/遥测同一套编排"],
    ], [Inches(1.55), Inches(5.35), Inches(5.8)], True, 12)
    add_textbox(s, Inches(0.42), Inches(5.88), Inches(12.5), Inches(1.15),
                "博客的判断可以直接当变化命题用：软件定义、可组合、弹性仍然必要，但不够。安全、多租户网络、数据/存储访问、基础设施运营不能只靠通用宿主机上的软件，也不能继续作为互不相干的一层。它们必须合成一个统一的、被加速的基础设施域——这就是 Scale-in 相对「再买一张智能网卡」的定义差。",
                13, False, INK)
    p += 1
    footer(s, p)

    # 07 principle silicon
    s = blank(prs)
    title_block(s, "03  原理", "两段处理：软件做决定，inline 就地执行",
                "工作不交回主机 CPU。这是「主机无关基础设施域」的物理实现。")
    card(s, Inches(0.42), Inches(1.16), Inches(12.5), Inches(1.35), BLUE_BG, BLUE)
    add_textbox(s, Inches(0.6), Inches(1.28), Inches(12.15), Inches(1.12),
                "软件（Grace 上的 DOCA）做决定：策略、开户、编排、遥测汇聚。\n"
                "Inline 加速引擎就地执行：包、RDMA、存储协议、加密、防火墙、策略命中。\n"
                "两者都可以并发；策略在工厂级协调，执行在每台机器线速落地。",
                13, False, INK)
    add_table(s, Inches(0.32), Inches(2.66), Inches(12.7), Inches(3.35), [
        ["部件", "干什么", "为什么需要这个量"],
        ["64 核 Grace", "策略、开通、遥测、基础设施编排", "相对 BF-3 约 6× 算力，才能并发多路服务"],
        ["Inline 引擎", "包 / RDMA / 存储 / 加密 / 防火墙 / 策略", "最高 800 Gb/s 线速，减轻 Grace 和主机"],
        ["LPDDR5X", "给基础设施软件送数据与状态", "策略表、队列、遥测、元数据要离数据近。Hot Chips ~275 GB/s；手册最多 128 GB"],
        ["PCIe Gen6 x16", "连主机", "主机与 Scale-in 处理域之间的宽通道"],
        ["800 Gb/s 网口", "连 Spectrum-X（Scale-in 交换）", "接入、安全、搬移、存储；不是托盘总带宽"],
    ], [Inches(2.15), Inches(4.35), Inches(6.2)], True, 11)
    add_textbox(s, Inches(0.42), Inches(6.15), Inches(12.5), Inches(0.90),
                "相对 BF-3（16× A78、400G、PCIe Gen5）：网络 2×。内存口径两篇官方博客不完全相同——Scale-in 博文写带宽 4×；共设计博文写容量 4×、带宽 >3×。转述时分开写。Hot Chips：1.7 GHz（现场认为功耗封顶，低于完整 Grace 服务器）、200G PAM4 SerDes、inline 加密。",
                12, False, MUTED)
    p += 1
    footer(s, p)

    # 08 7.2T
    s = blank(prs)
    title_block(s, "03  原理", "7.2 Tb/s 必须分流：800G 不是托盘总带宽",
                "整套原理里最容易写错的数字。租户训练/推理包走 CX9，不走 BF-4。")
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
                "这是刻意非对称，不是还没来得及做宽。",
                13, False, INK)
    add_textbox(s, Inches(0.58), Inches(5.30), Inches(5.85), Inches(1.5),
                "若 7.2T 全挤进 800G，Scale-out 先堵死。NVIDIA 的答案不是把前端做成 6.4T，而是：KV 尽量留 CMX，外部存储走 Spectrum-X 优化路径，集体通信留在 CX9。",
                12, False, MUTED)
    card(s, Inches(6.75), Inches(1.16), Inches(6.15), Inches(2.75), AMBER_BG, AMBER)
    add_paras(s, Inches(6.92), Inches(1.28), Inches(5.85), Inches(2.5), [
        ("三条硬规则", 14, True, AMBER),
        ("1. 租户训练/推理包走 CX9，不走 BF-4 的 800G。", 13, False, INK),
        ("2. 800G 是接入/存储/管控专用。用户请求、外部存储、开户、遥测走这里。", 13, False, INK),
        ("3. Astra 不是把东西向拽回 DPU，而是把策略推到 CX9 的 1.6T 口上执行。", 13, False, INK),
    ], spacing=5)
    card(s, Inches(6.75), Inches(4.06), Inches(6.15), Inches(2.95))
    add_paras(s, Inches(6.92), Inches(4.18), Inches(5.85), Inches(2.7), [
        ("Hot Chips「传统做法」对照", 14, True, INK),
        ("安全不完整：没有 DPU 拥有整条数据路径时，南北向可以隔离，scale-out 隔离不住；GPU 网络无法与租户端到端切断。", 12, False, INK),
        ("功耗约 4×：每张 NIC 若自带 CPU/内存/管理，相对「一张 BF-4 管所有 CX9」更费电。", 12, False, INK),
    ], spacing=5)
    p += 1
    footer(s, p)

    # 09 Astra
    s = blank(prs)
    title_block(s, "03  原理", "Astra：信任控制点扩到 scale-out，流量不必回流",
                "数据手册名 ASTRA（Advanced Secure Trusted Resource Architecture）。这是第五支柱相对「再插一张 DPU」的真增量。")
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
        "闭环怎么转：BF-4 安装/更新策略并采集遥测；CX9 在东西向数据面直接执行。博客原话：同一套 VPC 策略覆盖接入和 Scale-out，不必把所有东西向流量经 800G 口转发。",
        "为什么必须这样：Vera Rubin 东西向 6.4T、南北向 800G。若安全要「看见」租户流量就把包绕回 DPU，等于用 800G 给 6.4T 做防火墙，物理上不成立。Astra 把「看见」做成带外控制 + 网卡原地执行。Hot Chips 演示是「DPU 能看见所有 CX9 上的流量」，现场记录认为管理链路像 PCIe，不是数据面回流。",
        "「7 Tb/s 平台级 DPU」不要读成 BF-4 有 7T 网络口。它是 800G 本卡 + 对四张 1.6T CX9 的策略视野。零信任裸金属：租户拿不到设备管理面。",
        "未写死：Astra 连 CX9 的物理介质官方未钉死；非 Rubin 服务器插 BF-4 PCIe 卡时，对第三方 NIC 管不管，未公布。",
    ], 13, INK, 6)
    p += 1
    footer(s, p)

    # 10 chip
    s = blank(prs)
    title_block(s, "04  芯片", "BlueField-4 DPU：Scale-in 那张卡的规格",
                "数据手册 + Hot Chips 现场。Grace + CX9 级网络，不是「又一个 SuperNIC」。")
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
        "形态：PCIe 卡 + NVIDIA 项目定制形态。Vera Rubin 是共设计进系统，不是可选配件。数据手册写明 ASTRA 用于选定 Rubin 平台上的 CX9。",
        "放哪：Rubin GPU 计算托盘，以及 Vera CPU 节点。CPU 侧同样需要 Scale-in——Agent 的工具调用、检索、校验跑在 Vera 上，基础设施若占主机核，推理环路的 CPU 段会抖。",
        "Hot Chips 存储微基准（Grace 版 DPU，不要和 STX 混）：NVMe-oF 8 核到 1.6 Tb/s，16 核到 2000 万 IOPS，宣传相对无 DPU 路径约 2× 数据到达 GPU。这是卸载存储协议栈的能力，不是 800G 口变成了 1.6T。",
        "Inline 引擎覆盖：包处理、RDMA、存储协议、加密、防火墙、策略。控制面软件可以慢一步决策，数据面不能每包回核。",
        "转载规格（128 GB、512 GB 板载 SSD、114 MB L3）以数据手册「up to 128 GB LPDDR5x」为准；第三方拆解数字不要当官方。",
    ], 13, INK, 6)
    p += 1
    footer(s, p)

    # 11 bf3 vs bf4
    s = blank(prs)
    title_block(s, "04  芯片", "相对 BlueField-3：够跑并发基础设施服务",
                "上代是 16 核云 DPU。这一代是按「多服务同时在卡上跑」加的核、内存和网。")
    add_table(s, Inches(0.32), Inches(1.16), Inches(12.7), Inches(3.55), [
        ["", "BlueField-3", "BlueField-4 DPU", "倍数 / 变化"],
        ["CPU", "最多 16× Cortex-A78", "64× Neoverse V2（Grace）", "官方约 6× 算力"],
        ["网络", "400 Gb/s  Ethernet/IB", "800 Gb/s，CX9 级，200G SerDes", "2×"],
        ["主机", "PCIe Gen5", "PCIe Gen6 x16", "代际翻倍"],
        ["内存", "板载 DDR5，常见 16–32 GB", "LPDDR5X，手册最多 128 GB", "容量口径 4×（共设计博客）；带宽 4× 或 >3×，两篇博客不一致"],
        ["定位", "云基础设施可选插卡", "Vera Rubin 标配信任前端", "从配件到共设计"],
    ], [Inches(1.45), Inches(3.15), Inches(4.15), Inches(3.95)], True, 11)
    add_paras(s, Inches(0.42), Inches(4.88), Inches(12.5), Inches(2.1), [
        "为什么要 6× 算力：Scale-in 不是只做 vSwitch。同一张卡上要并发 HBN、Flow、Argus、Vault、Telemetry、DPF、存储协议。BF-3 的 16 核是为「卸载一块网卡功能」；BF-4 的 64 核是为「跑一套基础设施 OS」。",
        "1.7 GHz 偏低不是笔误。完整 Grace 服务器更高，现场记录认为 DPU 封顶功耗。算力倍数来自核数、微架构和缓存，不完全来自频率。",
        "内存倍数对外引用时分开标注来源，不要合成一个「内存 4×」。",
    ], 13, INK, 6)
    p += 1
    footer(s, p)

    # 12 DPU vs STX
    s = blank(prs)
    title_block(s, "04  芯片", "同一名字，两种角色：DPU ≠ STX",
                "现场记录也抱怨该拆成 Grace 版 / Vera 版。混用会把 1.45× 外部存储和 10× CMX IOPS 写进同一张表。")
    card(s, Inches(0.42), Inches(1.16), Inches(6.15), Inches(5.85), GREEN_BG, GREEN)
    add_paras(s, Inches(0.58), Inches(1.28), Inches(5.85), Inches(5.55), [
        ("BlueField-4 DPU（Scale-in）", 16, True, GREEN_DK),
        ("硅：Grace + CX9 级网络", 13, True, INK),
        ("口：800 Gb/s Ethernet 或 IB", 13, False, INK),
        ("放哪：Rubin 计算托盘、Vera CPU 节点", 13, False, INK),
        ("干什么：前端/南北向、主机卸载、安全、管理、可观测、隔离", 13, False, INK),
        ("存储数字：NVMe-oF 8 核 1.6 Tb/s、16 核 20M IOPS（Hot Chips，本卡卸载）", 12, False, INK),
        ("交换：Spectrum-X 接入路径，相对货架以太网存储最高 1.45×", 12, False, INK),
    ], spacing=7)
    card(s, Inches(6.75), Inches(1.16), Inches(6.15), Inches(5.85), BLUE_BG, BLUE)
    add_paras(s, Inches(6.92), Inches(1.28), Inches(5.85), Inches(5.55), [
        ("Vera BlueField-4 STX（CMX）", 16, True, BLUE),
        ("硅：Vera CPU + ConnectX-9 SuperNIC", 13, True, INK),
        ("口：Spectrum-X 最高 1.6 Tb/s", 13, False, INK),
        ("放哪：STX 模块化存储 / CMX 数据节点", 13, False, INK),
        ("干什么：KV I/O、元数据、放置、安全、控制；不是块设备仿真那么简单", 13, False, INK),
        ("存储数字：两颗 Vera 版 3.2 Tb/s；DOCA Memos 宣传 10× IOPS、5× 效率", 12, False, INK),
        ("路径：GPU HBM → 系统内存 → 本地/网络存储，工厂内上下文层", 12, False, INK),
    ], spacing=7)
    p += 1
    footer(s, p)

    # 13 DOCA
    s = blank(prs)
    title_block(s, "04  软件", "DOCA：把加速器变成可编排的基础设施 OS",
                "硬件不会自动变成「域」。微服务 + 服务功能链，一条流按顺序穿过网络→安全→存储。")
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
        ["Memos", "KV 在计算节点和存储节点间管理/共享", "CMX，不要算进 800G 接入"],
    ], [Inches(1.7), Inches(6.5), Inches(4.5)], True, 11)
    add_textbox(s, Inches(0.42), Inches(6.15), Inches(12.5), Inches(0.90),
                "生产形态是容器化微服务直接跑在 BF-4 上，库/SDK 给自研服务。SFC 的意义：不必在主机上串多跳 vSwitch，流在 DPU 域内完成「先分类再加密再卸存储」。Memos 必须单独标——它服务的是上下文存储，不是南北向 VPC。",
                12, False, MUTED)
    p += 1
    footer(s, p)

    # 14 Spectrum-X
    s = blank(prs)
    title_block(s, "04  交换", "Spectrum-X 在 Scale-in 路径上干什么",
                "Scale-in 没有另做一张专有总线。接入和外部存储走 AI 以太网，Vera Rubin 同代是 Spectrum-6。")
    add_paras(s, Inches(0.42), Inches(1.18), Inches(12.5), Inches(2.2), [
        "分工：BF-4 在每台机器上处理服务（策略、协议、加密、遥测）；Spectrum-X 在工厂和外部之间搬流量。没有交换机，DPU 只是一台加速网卡；没有 DPU，交换机只是把未卸载的主机流量转发出去。",
        "公开能力针对 AI 流量病：哈希极化/负载均衡冲突、incast 拥塞、多流抢带宽。目标是提高有效带宽，并隔离并发流，让接入和存储更可预期——对应博客反复说的 tail，而不只是端口速率。",
        "存储数字要带条件：相对货架以太网最高约 1.45×。Hot Chips 按对象大小拆过：5 GB 文件 1.5×、10 GB 1.4×、50 GB 1.3×。文件越大增益收窄，说明吃到的是小中对象 + 拥塞隔离，不是物理口从 400G 变成 800G 的线性外推。",
    ], 13, INK, 8)
    card(s, Inches(0.42), Inches(3.55), Inches(4.05), Inches(3.45))
    add_paras(s, Inches(0.58), Inches(3.70), Inches(3.75), Inches(3.15), [
        ("和 scale-out 的关系", 14, True, GREEN_DK),
        ("Spectrum-X 同时出现在 Scale-out 和 Scale-in 叙事里。Scale-out 跑 CX9 上的集体通信；Scale-in 跑 BF-4 上的接入/存储。是否共平面、是否独立 leaf，官方未钉死。", 12, False, INK),
    ], spacing=6)
    card(s, Inches(4.65), Inches(3.55), Inches(4.05), Inches(3.45))
    add_paras(s, Inches(4.81), Inches(3.70), Inches(3.75), Inches(3.15), [
        ("和 CMX 的关系", 14, True, BLUE),
        ("CMX 也走以太网附加闪存，处理器是 STX。Scale-in 的 1.45× 是「外部存储路径 vs 货架以太网」；CMX 的 10× IOPS 是上下文层。两张表不要并。", 12, False, INK),
    ], spacing=6)
    card(s, Inches(8.88), Inches(3.55), Inches(4.05), Inches(3.45), AMBER_BG, AMBER)
    add_paras(s, Inches(9.04), Inches(3.70), Inches(3.75), Inches(3.15), [
        ("共设计约束", 14, True, AMBER),
        ("博客强调 BF-4、DOCA、Spectrum-X 与 Vera Rubin 共设计：核、内存带宽、PCIe、网络、加速、软件要互相跟得上。单换一张 800G 网卡复制不了这条路径。", 12, False, INK),
    ], spacing=6)
    p += 1
    footer(s, p)

    # 15 VPC
    s = blank(prs)
    title_block(s, "05  用例", "隔离的 AI 工厂 VPC",
                "多租户共享物理底盘。南北向和东西向若用两套策略，必然漏。")
    card(s, Inches(0.42), Inches(1.16), Inches(4.05), Inches(5.85), AMBER_BG, AMBER)
    add_paras(s, Inches(0.58), Inches(1.32), Inches(3.75), Inches(5.55), [
        ("问题", 14, True, AMBER),
        ("共享 AI 工厂要云一样开租户，但不能把隔离交给租户 OS。", 13, False, INK),
        ("若只在南北向 DPU 上做 VRF，东西向 CX9 仍是一张「租户能看见的网卡」，租户之间的 east-west 会漏。", 13, False, INK),
        ("若把东西向绕回 800G 做防火墙，6.4T 流量没有物理出口。", 13, False, INK),
    ], spacing=8)
    card(s, Inches(4.65), Inches(1.16), Inches(4.05), Inches(5.85), GREEN_BG, GREEN)
    add_paras(s, Inches(4.81), Inches(1.32), Inches(3.75), Inches(5.55), [
        ("机制", 14, True, GREEN_DK),
        ("HBN：BF-4 上加速南北向 L3 和租户隔离，可当 BGP 路由器。", 13, False, INK),
        ("Flow：分类、ACL，下到硬件流水线。", 13, False, INK),
        ("OVS-DOCA：同一套策略落到东西向口。", 13, False, INK),
        ("Astra：再铺到 CX9。7.2 Tb/s 接口同一策略模型，东西向不回流 800G。", 13, False, INK),
    ], spacing=8)
    card(s, Inches(8.88), Inches(1.16), Inches(4.05), Inches(5.85), BLUE_BG, BLUE)
    add_paras(s, Inches(9.04), Inches(1.32), Inches(3.75), Inches(5.55), [
        ("结果", 14, True, BLUE),
        ("运营者中心化开 VPC，租户继续走加速交换。", 13, False, INK),
        ("云一样的弹性，隔离一致，主机 CPU 不做 vSwitch。", 13, False, INK),
        ("裸金属也能卖多租户：设备管理面在 DPU，不在租户。", 13, False, INK),
        ("这是 Scale-in 和 Scale-out 必须被同一控制点管住的原因。", 13, False, INK),
    ], spacing=8)
    p += 1
    footer(s, p)

    # 16 security
    s = blank(prs)
    title_block(s, "05  用例", "硅上执行安全 = 黄仁勋说的 Scale-in security",
                "执行点在硬件、在租户 OS 外。这是第五支柱被放进财报「五种网络」的原因。")
    add_paras(s, Inches(0.42), Inches(1.16), Inches(12.5), Inches(1.55), [
        "问题：主机侧安全与负载同信任域；软件防火墙加一跳；Agent 反复摸数据、模型、工具、KV，攻击面在推理路径上。共设计博客：安全不能只靠主机软件，因为控制边界和被保护的负载是同一台机器。",
        "Agentic 改变安全模型：一次会话里策略检查次数随工具调用线性涨。线速执行不是「更快的 WAF」，而是推理 SLA 的一部分。",
    ], 13, INK, 6)
    add_table(s, Inches(0.32), Inches(2.85), Inches(12.7), Inches(2.55), [
        ["组件", "管什么", "为什么必须在 DPU 域"],
        ["Argus", "运行时威胁检测", "检测器若在租户里，租户可以关"],
        ["Vault", "文件访问策略", "模型和数据文件不能只靠主机 ACL"],
        ["Flow", "网络线速策略", "每包回主机核会先打满 CPU"],
        ["Astra", "南北向+东西向同步加密、隔离、密钥、遥测", "只保护 800G、不保护 6.4T 等于没保护算力面"],
    ], [Inches(1.6), Inches(4.3), Inches(6.8)], True, 12)
    add_textbox(s, Inches(0.42), Inches(5.55), Inches(12.5), Inches(1.45),
                "结果：租户软件关不掉这些控制；主机 CPU 不做安全过滤；共享 AI 服务有一致保护。对应「零信任裸金属」：租户拿到的是加速器，拿不到基础设施控制面。未公开：Argus 的观测语义（syscall / eBPF / 包级）、密钥托管层次。",
                13, False, INK)
    p += 1
    footer(s, p)

    # 17 storage
    s = blank(prs)
    title_block(s, "05  用例", "加速存储接入：外部数据，不是 CMX",
                "GPU 有算力也有 NVLink，仍可能在等数据。这条路径接训练数据、模型资产、企业知识。")
    card(s, Inches(0.42), Inches(1.16), Inches(12.5), Inches(1.25), AMBER_BG, AMBER)
    add_textbox(s, Inches(0.6), Inches(1.32), Inches(12.15), Inches(0.95),
                "边界先写死：Scale-in 存储路径 = 工厂外/企业侧数据进来。CMX = 工厂内 KV / 可复用推理状态。1.45× 和 10× IOPS 不是同一个实验。BF-4 DPU 卸的是 NVMe-oF、文件/对象（RDMA 和 TCP）、存储虚拟化、搬移；STX 卸的是 KV 元数据、放置、召回。",
                13, False, INK)
    add_paras(s, Inches(0.42), Inches(2.55), Inches(12.5), Inches(2.35), [
        "机制：协议栈和虚拟化在 DPU 上跑，主机看到的可以是标准网卡/存储设备模型（VirtIO、DOCA SNAP 一类），后台是加速路径。Spectrum-X 在存储路径上做拥塞管理和流隔离，避免多租户检索把有效带宽打穿。",
        "数字：相对货架以太网最高 1.45× 吞吐；Hot Chips 5/10/50 GB 对象对应 1.5 / 1.4 / 1.3×。Grace 版 DPU 微基准 8 核 1.6 Tb/s NVMe-oF、16 核 20M IOPS，宣传约 2× 数据到达 GPU——对照基线未完全公开，引用时加「宣传口径」。",
        "为什么和 Scale-up 正交：NVLink 解决 GPU 之间的权重/激活；它不把企业对象存储搬进 HBM。Agent 检索、训练数据加载、checkpoint 都走这条南北向存储路径。",
    ], 13, INK, 7)
    card(s, Inches(0.42), Inches(5.05), Inches(12.5), Inches(1.95), GREEN_BG, GREEN)
    add_textbox(s, Inches(0.6), Inches(5.18), Inches(12.15), Inches(1.7),
                "800G 会不会先满：东西向 6.4T vs 南北向 800G 是 8:1。NVIDIA 的产品答案是（1）KV 尽量不走这条 800G，走 CMX；（2）外部存储用 Spectrum-X 把有效带宽做上去；（3）不把 Scale-in 口做成和 Scale-out 对等。Agent 若把大量中间状态当「外部对象」来回打，800G 仍会成为瓶颈——这是架构选择，不是笔误。",
                13, False, INK)
    p += 1
    footer(s, p)

    # 18 control plane
    s = blank(prs)
    title_block(s, "05  用例", "控制面：主机起来之前先开策略",
                "若管控跑在主机上，主机没起来或被租户控制时，工厂无法自举。")
    add_paras(s, Inches(0.42), Inches(1.18), Inches(12.5), Inches(1.7), [
        "AI 工厂节点必须先开通网络和存储、装好策略，才能跑负载。传统 PXE + 主机 agent 的顺序是：主机 OS 起来 → 再下策略。多租户裸金属里，这段窗口里机器是「无策略的加速器」。",
        "Scale-in 把顺序倒过来：DPU 先活，策略先在，再网络启动主机 OS。租户软件启动时，隔离和加密已经在硅上。",
    ], 13, INK, 7)
    add_table(s, Inches(0.32), Inches(3.05), Inches(12.7), Inches(2.35), [
        ["步骤", "谁做", "为什么不能放主机"],
        ["发现 / 开通 DPU", "DPF，把 DPU 当 K8s 节点", "主机还没 OS"],
        ["下发网络、存储、安全策略", "DOCA 微服务 + Astra", "必须在租户能摸设备之前"],
        ["网络启动主机 OS", "BF-4 控制面", "安装镜像也不该走未隔离的网"],
        ["之后的升级、扩容", "DPF 服务部署与滚动", "升级基础设施不能打扰租户 GPU 作业"],
    ], [Inches(3.3), Inches(3.5), Inches(5.9)], True, 12)
    add_textbox(s, Inches(0.42), Inches(5.55), Inches(12.5), Inches(1.45),
                "DPF（DOCA Platform Framework）是 K8s 原生编排：发现、开通、服务部署、升级。意义是运营者按「管理一组基础设施节点」来管 DPU 机群，而不是 SSH 进每张卡。结果：部署更短、配置更一致、主机 CPU 不做管控、新算力更快上线。这和「DPU 是可选加速器」不兼容——控制面依赖它必须在，所以 Vera Rubin 把它共设计进去。",
                13, False, INK)
    p += 1
    footer(s, p)

    # 19 telemetry
    s = blank(prs)
    title_block(s, "05  用例", "可观测：不看租户的脸",
                "五个用例共用一个原理——服务跑在 DPU 域，执行在 inline / CX9，主机只保留 AI 负载。")
    card(s, Inches(0.42), Inches(1.16), Inches(6.15), Inches(3.55))
    add_paras(s, Inches(0.58), Inches(1.28), Inches(5.85), Inches(3.3), [
        ("Telemetry 机制", 15, True, GREEN_DK),
        ("从 BF-4 采集网络、存储访问、服务健康、性能、利用率，导出到监控平台。库给 ISV 接同一路信号。", 13, False, INK),
        ("视野可延伸到 GPU 和网络利用率，用来区分：接入堵、东西向堵、存储等、策略过重、还是作业放置问题。", 13, False, INK),
        ("租户可以关主机 agent、假报指标；DPU 域的指标不经过租户 OS。", 13, False, INK),
    ], spacing=6)
    card(s, Inches(6.75), Inches(1.16), Inches(6.15), Inches(3.55), BLUE_BG, BLUE)
    add_paras(s, Inches(6.92), Inches(1.28), Inches(5.85), Inches(3.3), [
        ("五个用例的同一根骨头", 15, True, BLUE),
        ("VPC：策略在 DPU，执行在 800G + CX9。", 13, False, INK),
        ("安全：检测和强制在租户外。", 13, False, INK),
        ("存储：协议栈在 DPU，GPU 等数据的时间下降。", 13, False, INK),
        ("控制面：主机未起时域已经在。", 13, False, INK),
        ("遥测：观测点同样在域外。", 13, False, INK),
    ], spacing=5)
    card(s, Inches(0.42), Inches(4.88), Inches(12.5), Inches(2.12), GREEN_BG, GREEN)
    add_textbox(s, Inches(0.6), Inches(5.02), Inches(12.15), Inches(1.85),
                "这根骨头决定了 Scale-in 不是「功能清单」。缺 Astra，东西向用例不成立；缺 inline 引擎，安全/存储只能回主机核；缺 DPF，控制面仍在主机上。产品宣传会把五条拆开写，工程上它们是同一台 DPU 上的服务功能链。",
                13, False, INK)
    p += 1
    footer(s, p)

    # 20 CMX vs scale-in
    s = blank(prs)
    title_block(s, "06  边界", "Scale-in 接外部数据，CMX 接内部上下文",
                "BF-4 家族两条数据路径。并表是最常见的误读。")
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
                "博客写死：BF-4 既是 Scale-in 的基础设施处理器，又可以是 CMX 的数据/存储处理器，但是两件事。Scale-in 把工厂数据和外部企业数据接到算力上；CMX 保存并共享上下文，减少反复 prefill。Agent 工厂两样都要：没有 Scale-in，企业知识进不来；没有 CMX，长上下文把 HBM 和前端 800G 一起打满。",
                13, False, INK)
    p += 1
    footer(s, p)

    # 21 impact
    s = blank(prs)
    title_block(s, "07  影响", "网络从一种变成五种，DPU 从配件变成系统",
                "黄仁勋用 Scale-in security networking 解释每 GW 收入盘。基础设施被算进推理 SLA。")
    boxes = [
        (GREEN_BG, GREEN, "五种网络可售",
         "Hopper 大约是 GPU + InfiniBand。Vera Rubin 要 CPU、多种网络才能覆盖数据中心，再加上 Scale-in security 和 Scale-across，「可以说五种网络系统」。电话会把每 GW 收入机会讲到约 400 亿美元。DPU 不再是附件，而是和 NVLink、Spectrum 同级的可售系统。"),
        (BLUE_BG, BLUE, "标配信任前端",
         "Hot Chips：云 DPU 是可替换插卡；BF-4 共设计进每个 Vera Rubin 系统。CSP / neocloud 可以按「策略在 DPU、负载在 GPU」卖裸金属多租户。自建工厂的南北向安全不再是主机里堆 agent。"),
        (AMBER_BG, AMBER, "基础设施进入 SLA",
         "tokens/MW、TTFT、P99 会有一部分来自：800G 有没有堵、存储卸载够不够、策略有没有在 CX9 线速执行、KV 有没有走 CMX。Scale-in 是 NVIDIA 把这些分数收进自家平台的方式。"),
        (WHITE, LINE, "和自研 ASIC 怎么对",
         "Jalapeño 前端仍是主机 400G 网卡，scale-up 自己做。对标不要比谁的前端口更大，要比：策略是否在租户 OS 外；东西向是否同一控制点（Astra）；存储协议是否卸载；前端与多 Tb/s scale-out 是否刻意非对称。"),
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
    title_block(s, "07  影响", "争议、瓶颈、未公开：写进去才完整",
                "SDxCentral 说第五支柱是换皮。工程上要承认「南北向要加速」不是新发明，同时把真增量写清楚。")
    add_table(s, Inches(0.32), Inches(1.16), Inches(12.7), Inches(3.15), [
        ["争议 / 风险", "怎么理解", "不要写成"],
        ["命名换皮", "南北向 DPU 不是新物种。真增量：Rubin 标配、Astra 管 CX9、与 CMX/STX 分工", "NVIDIA 发明了第六种互连"],
        ["800G 瓶颈", "与东西向 8:1 是选择：KV 留 CMX、外部存储走优化路径", "笔误，很快会改成 6.4T 前端"],
        ["「7T 平台级 DPU」", "800G 本卡 + 对四张 1.6T CX9 的策略视野；演示是「看见」不是「穿过」", "BF-4 有 7T 网络口"],
        ["SKU 同名", "DPU=Grace+800G；STX=Vera+最高 1.6T。必须加后缀", "一张卡既是 800G 又是 3.2T"],
    ], [Inches(2.2), Inches(6.3), Inches(4.2)], True, 11)
    add_paras(s, Inches(0.42), Inches(4.48), Inches(12.5), Inches(2.5), [
        "未公开，不要写死：整卡 TDP；每 NVL72 托盘是否严格一张 BF-4；Astra 连 CX9 是 PCIe 还是专用管理网（现场「听起来像 PCIe」）；1.45× / 2× / 10× 的对照基线；Argus 检测语义；Scale-in 与 Scale-out 是否共平面；非 Rubin 服务器上 Astra 对第三方 NIC 管不管。",
        "对外转述内存倍数时分开引两篇博客。Hot Chips 1.7 GHz、275 GB/s 是现场幻灯，以数据手册为准。",
        "能下的判断：Scale-in 是前端网络的产品化升级——处理域独立、信任域扩到 CX9、存储/安全/管控从主机卸载。它不替代 NVLink，也不替代 Spectrum-X 算力面。",
    ], 13, INK, 6)
    p += 1
    footer(s, p)

    # 23 recap
    s = blank(prs)
    title_block(s, "08  收束", "读完应能复述的五句话",
                "概念、变化、原理、产品、影响各一句。")
    recap = [
        ("概念", "Scale-in = 加速后的前端/南北向，不是 Scale-up 的反向，也不替代 CX9 上的算力面。"),
        ("变化", "从「主机 SDN + 可选 DPU 插卡」变成「Vera Rubin 标配的主机无关基础设施域」。"),
        ("原理", "Grace 做决定，inline 就地执行；Astra 把策略推到 CX9，东西向流量不回流 800G。"),
        ("产品", "BF-4 DPU（800G，Scale-in）和 BF-4 STX（CMX 存储）同名不同角色；软件是 DOCA，交换是 Spectrum-X。"),
        ("影响", "五种网络可售、DPU 进入推理 SLA；800G 相对 6.4T 是刻意非对称；命名有换皮成分，Astra+标配才是增量。"),
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
        "NVIDIA Technical Blog，BlueField-4 Powers New Scale-In Network Infrastructure（2026-08-24）。中文镜像 developer.nvidia.cn 同文。第五支柱定义、BF-4 部件表、Astra、五个用例、1.45×、7.2 Tb/s 拆分。",
        "NVIDIA Technical Blog，Scaling Agentic AI Factories Through Extreme Co-Design with NVIDIA BlueField。基础设施即推理流水线；BF-3 对比（6× 算力、4× 容量、>3× 带宽）；STX 1.6T；DOCA Memos / HBN / ASTRA。",
        "Hot Chips 2026 BlueField-4 演讲，ServeTheHome 现场记录。1.7 GHz、275 GB/s、200G PAM4、传统方案安全/功耗对照、7T 演示、NVMe-oF 微基准、两颗 Vera 版 3.2 Tb/s。",
        "Gilad Shainer / NVIDIA Networking：Scale-in 取代前端网络。Hot Interconnects 相关报道见 Converge Digest。",
        "NVIDIA FY2027 Q2 财报电话会，黄仁勋 Q&A：Scale-in security networking、五种网络系统、每 GW 收入盘。",
        "BlueField-4 DPU 数据手册：800G、64× V2、最多 128 GB LPDDR5x、PCIe Gen6 x16、ASTRA、Ethernet/IB。",
        "批评与转述：Converge Digest 第五支柱综述；SDxCentral「shaky ground」——把换皮质疑写进正文，不当主线。",
        "内存倍数两篇官方博客不一致，文中已分开标注。演示数字未给对照基线的，按宣传口径引用。",
    ], 13, INK, 7)
    p += 1
    footer(s, p)

    assert p == TOTAL, p
    prs.save(OUT)
    print(f"Wrote {OUT} ({p} slides)")


if __name__ == "__main__":
    build()
