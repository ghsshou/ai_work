# MoE超节点规模需求精华版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于完整版生成一份约8页、兼顾管理汇报和技术评审的MoE超节点规模需求精华版。

**Architecture:** 以MoE负载参数为输入，依次说明容量/算力下界、高频通信域、训练与推理差异、Atlas 950算例和产品选型。Markdown作为内容源，Pandoc生成Word，LibreOffice/PDF工具验证实际页数。

**Tech Stack:** Markdown、LaTeX公式、Pandoc、DOCX、LibreOffice Headless、PDFInfo。

## Global Constraints

- Word版约8页。
- 不讨论Dense模型。
- 同时覆盖MoE训练与推理。
- 保留8～10个核心公式。
- 全文使用陈述式表达，不含问句或问题式标题。
- 不展开模型结构科普。
- 950公开真机、路线图和示例假设严格区分。
- Markdown与Word内容一致。

---

### Task 1: 撰写八页内容

**Files:**
- Create: `docs/supernode-scale/稀疏模型超节点规模需求分析_精华版.md`

**Interfaces:**
- Consumes: 完整版报告与精华版设计
- Produces: 八个内容单元、8～10个核心公式和两组950算例

- [ ] 写核心结论、变量和双层推导框架。
- [ ] 写MoE训练、长序列和TP×EP×CP通信域。
- [ ] 写MoE推理、KV Cache、Prefill/Decode和PD分离。
- [ ] 写Atlas 950算例、产品规格与客户选型建议。
- [ ] 删除详细推导、次要公式和重复背景。

### Task 2: 生成并校准Word

**Files:**
- Create: `docs/supernode-scale/稀疏模型超节点规模需求分析_精华版.docx`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1 Markdown
- Produces: 约8页的Word文档和仓库入口

- [ ] 使用Pandoc生成带目录、表格和原生公式的Word。
- [ ] 使用Headless LibreOffice转为临时PDF并读取页数。
- [ ] 根据页数调整正文或版式至约8页。
- [ ] 在README中增加精华版Markdown和Word入口。

### Task 3: 审校与验证

**Files:**
- Modify: `docs/supernode-scale/稀疏模型超节点规模需求分析_精华版.md`
- Modify: `docs/supernode-scale/稀疏模型超节点规模需求分析_精华版.docx`

**Interfaces:**
- Consumes: Markdown与Word初稿
- Produces: 可交付精华版

- [ ] 扫描Dense、问号和疑问式词语。
- [ ] 复算MoE状态、EP通信、KV和PD带宽。
- [ ] 检查Markdown数学块、代码围栏和本地链接。
- [ ] 检查DOCX ZIP/OOXML、表格和原生公式。
- [ ] 复核Word页数及Markdown/Word标题一致性。
