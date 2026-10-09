#!/usr/bin/env python3
"""Example: design-time simulator workload-engine slide, diagram in the left 2/3."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from arch_kit import blank, draw_layered_arch, footer, new_deck, title_block  # noqa: E402

SPEC = [
    {"name": "输入层", "tone": "blue", "h": 0.46, "items": [
        "生产 Trace\nmsprof / HCCL / 服务日志", "模型结构与并行配置",
        "业务流量预测与 SLO 分级", "未来模型与集群规模假设"]},
    {"name": "负载引擎", "sub": "本项目核心", "tone": "core", "h": 3.92, "columns_h": 1.86,
     "columns": [
         {"title": "① 基于计算图展开的\n模型负载画像", "items": [
             "计算图抽取与并行策略展开", "多级算子代价模型", "通信量与访存量推导", "MoE 路由与 KV 动态建模"]},
         {"title": "② 基于随机过程的\n到达与请求建模", "items": [
             "突发到达与日周期建模", "输入/输出长度联合建模", "会话与前缀复用建模", "训练作业规模与故障建模"]},
         {"title": "③ 基于统计拟合的\nTrace 重构与外推", "items": [
             "多源 Trace 对齐与依赖重建", "混合分布拟合与检验", "rank 对称规模外推", "跨硬件重定向与 what-if"]},
     ],
     "rows": [
         {"title": "④ 面向 DSE 的\n负载数据工厂", "chevron": True, "items": [
             "多源采集\n与脱敏", "负载特征化\n抽取", "参数化/生成式\n负载合成", "场景化负载库\n版本管理"]},
         {"title": "⑤ 统一负载 IR\n与多保真导入", "items": [
             "硬件无关执行图 IR\n兼容 Chakra ET", "L0/L1/L2\n多保真切换", "集合通信\n分解为网络流", "访存与 KV 流量\n映射内存仿真"]},
         {"title": "⑥ 基于实测对标的\n闭环校准", "items": [
             "小规模集群\n实测对标", "分层误差归因", "代价模型\n系数回灌", "分布 + 效用\n双保真评估"]},
     ]},
    {"name": "仿真内核", "sub": "已具备", "tone": "gray", "h": 0.44, "feedback": True, "size": 9.5,
     "items": ["NPU 仿真", "内存 / 存储仿真", "网络仿真"]},
    {"name": "设计输出", "sub": "DSE", "tone": "green", "h": 0.5, "items": [
        "超节点规模\n与组网拓扑", "Scale-up/out\n带宽配比", "内存/存储\n层级容量",
        "PD 配比\n与并行策略", "瓶颈定位\n与 TCO 评估"]},
]

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/arch_example.pptx"
    prs = new_deck()
    s = blank(prs)
    title_block(s, "设计态 AI 集群仿真器  ·  立项核心",
                "以「负载引擎」为核心的设计态仿真器：负载刻画准，系统设计才可信",
                "底层仿真已具备；本项目补齐负载的画像、生成与导入。")
    draw_layered_arch(s, SPEC, left=0.36, right=8.86, top=1.2, bottom=7.2)
    footer(s, "示例  ·  内部讨论稿", 1, 1)
    prs.save(out)
    print(f"wrote {out}")
