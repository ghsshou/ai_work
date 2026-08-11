# 昇腾超节点规模需求技术报告 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 撰写一份面向技术大众、服务产品定义与客户选型的昇腾超节点规模需求报告。

**Architecture:** 报告以参数化负载模型为输入，先推导容量与算力下界，再通过 TP、EP、CP 等高频通信域确定超节点边界。正文集中在可理解的因果关系与核心公式，附录承载详细推导和假设。

**Tech Stack:** Markdown、LaTeX 公式、公开技术资料、Python 公式数值复核。

## Global Constraints

- 正文约 30～40 页等效内容。
- 面向具备 AI 系统基础的技术大众，不写成模型结构科普。
- 正文保留约 15～20 个关键公式，并解释变量、直觉和适用边界。
- 同时覆盖产品规格定义和客户负载选型。
- 重点覆盖 Dense、MoE、长序列、在线/离线推理与 PD 分离。
- 不绑定具体 NPU 型号；950 只作公开参数或明确假设的案例。
- 只讨论技术最优规模，不分析成本、功耗、散热和机柜约束。
- 明确区分单超节点规模、模型并行组规模和集群总规模。
- 不把峰值算力、链路速率或工程近似写成可持续实测性能。

---

### Task 1: 资料与公式基线

**Files:**
- Create: `docs/supernode-scale/references.md`

**Interfaces:**
- Consumes: 公开论文、官方资料及设计文档
- Produces: 可供正文引用的事实、公式、假设和来源清单

- [ ] 核验训练内存、训练 FLOPs、Attention 复杂度和并行通信公式。
- [ ] 核验推理 KV Cache、Prefill、Decode 和性能指标公式。
- [ ] 核验 MoE 参数、激活参数、路由容量和 All-to-All 模型。
- [ ] 搜集 Atlas 950 相关官方公开参数，逐项标记“公开事实/工程近似/示例假设”。
- [ ] 记录来源标题、URL、访问日期及其支持的具体结论。

### Task 2: 方法论与基础章节

**Files:**
- Create: `docs/supernode-scale/昇腾超节点规模需求分析.md`

**Interfaces:**
- Consumes: Task 1 的事实与公式基线
- Produces: 报告第 1～5 章及统一符号体系

- [ ] 写执行摘要、问题定义和超节点边界。
- [ ] 用最少必要篇幅定义模型与负载参数。
- [ ] 建立不绑定型号的硬件抽象。
- [ ] 写容量、算力、通信和扩展效率的双层推导方法。
- [ ] 为每个公式补充变量、直觉及适用边界。

### Task 3: 训练负载章节

**Files:**
- Modify: `docs/supernode-scale/昇腾超节点规模需求分析.md`

**Interfaces:**
- Consumes: 统一符号和双层推导方法
- Produces: Dense、MoE和长序列训练的规模结论

- [ ] 推导 Dense 训练的状态内存、Activation、算力和 TP/PP/DP 映射。
- [ ] 推导 MoE 总参数、激活参数、专家负载和 TP×EP 通信域。
- [ ] 推导长序列训练的 Attention、Activation 和 CP 约束。
- [ ] 每类负载给出最小规模、推荐规模和扩展拐点的判断方法。

### Task 4: 推理负载章节

**Files:**
- Modify: `docs/supernode-scale/昇腾超节点规模需求分析.md`

**Interfaces:**
- Consumes: 统一符号和双层推导方法
- Produces: 在线、离线、长上下文、MoE与 PD 分离推理的规模结论

- [ ] 推导权重、KV Cache和并发容量。
- [ ] 分开分析 Prefill 的计算约束与 Decode 的带宽/时延约束。
- [ ] 比较模型并行与多副本对吞吐和时延的影响。
- [ ] 分析 MoE推理及 PD 分离的专家/KV传输需求。

### Task 5: 综合规模与 950 算例

**Files:**
- Modify: `docs/supernode-scale/昇腾超节点规模需求分析.md`

**Interfaces:**
- Consumes: 训练与推理的场景结论、950公开资料
- Produces: 产品规模档位、客户选型流程和四个参数化算例

- [ ] 建立负载—瓶颈—高频并行域—规模建议矩阵。
- [ ] 给出基础型、均衡型和大规模型的技术定义，不预设固定卡数。
- [ ] 完成 Dense训练、MoE训练、长上下文推理和 PD 分离四个 950 算例。
- [ ] 对未公开参数给出示例假设和敏感性区间。

### Task 6: 附录、审校与验证

**Files:**
- Modify: `docs/supernode-scale/昇腾超节点规模需求分析.md`
- Modify: `docs/supernode-scale/references.md`

**Interfaces:**
- Consumes: 完整报告初稿
- Produces: 可交付的报告与可追溯资料

- [ ] 补充符号表、详细公式、计算模板和来源。
- [ ] 使用 Python 对示例公式、单位和数量级进行复算。
- [ ] 检查公式符号前后一致、公开事实均有引用。
- [ ] 检查模型结构篇幅，删除不影响规模推导的科普内容。
- [ ] 检查每章是否有结论、直觉、公式和适用边界。
- [ ] 检查 Markdown 标题、表格、公式和链接。
