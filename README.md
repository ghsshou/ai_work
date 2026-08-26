# ai_work

LLM 推理学习笔记与基础设施对比资料。

## 学习资料目录（推荐从这里进）

📁 [`docs/llm-inference-learning/`](./docs/llm-inference-learning/)

| 文件 | 说明 |
|------|------|
| [LLM推理学习_建议与问答梳理.md](./docs/llm-inference-learning/LLM推理学习_建议与问答梳理.md) | **主索引**：学习建议 + 后续问答 |
| [推理学习进度记录.md](./docs/llm-inference-learning/推理学习进度记录.md) | 进度快照与续学入口 |

## UB / CXL 技术资料

📁 [`docs/ub-cxl/`](./docs/ub-cxl/)

- [`CXL与UB内存池化及数据路径对比`](./docs/ub-cxl/CXL_UB_内存池化与_UB_数据路径对比.md)
- [`配套PPT（23页）`](./docs/ub-cxl/CXL_UB_内存池化与数据路径对比.pptx)

## OpenAI Jalapeño 芯片洞察

📁 [`docs/jalapeno/`](./docs/jalapeno/)

Hot Chips 2026 上 OpenAI 第一颗推理芯片的系统拆解：Serving 定位、KV 局部性、不做 PD 分离、128/2048 机架网络、Gluon/Codex 软件栈，以及跑分口径。

- [`配套PPT（24页）`](./docs/jalapeno/OpenAI_Jalapeno_系统洞察.pptx)
- [`Markdown 文字版`](./docs/jalapeno/OpenAI_Jalapeno_芯片系统洞察.md)
- [`架构细节：slice / 网络 / Rubin 对比`](./docs/jalapeno/Jalapeno_架构细节_slice网络与Rubin对比.md)

## 超节点技术报告

**完整版：** [`Markdown`](./docs/supernode-scale/昇腾超节点规模需求分析.md) · [`Word`](./docs/supernode-scale/昇腾超节点规模需求分析.docx)

从 Dense/MoE 训练、长序列、在线/离线推理和 PD 分离负载出发，推导容量、算力、通信与高频并行域对昇腾超节点规模的要求，并包含 Atlas 950 参数化算例。

**MoE精华版（约8页）：** [`Markdown`](./docs/supernode-scale/稀疏模型超节点规模需求分析_精华版.md) · [`Word`](./docs/supernode-scale/稀疏模型超节点规模需求分析_精华版.docx)

聚焦稀疏模型训练与推理，保留核心公式、通信边界、Atlas 950算例和产品选型建议。

## 本地同步

```bash
# 首次
git clone https://github.com/ghsshou/ai_work.git
cd ai_work

# 之后更新
cd ai_work && git pull origin main
```

GitHub 资料目录：https://github.com/ghsshou/ai_work/tree/main/docs
