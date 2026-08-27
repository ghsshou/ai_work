# OpenAI Jalapeño 技术资料

Hot Chips 2026 上 OpenAI 第一颗推理芯片 Jalapeño 的系统洞察，与大模型推理学习笔记、超节点规模报告对照阅读。

| 文件 | 内容 |
|---|---|
| [OpenAI_Jalapeno_系统洞察.pptx](./OpenAI_Jalapeno_系统洞察.pptx) | 24 页演示文稿：定位、架构、机架网络、软件、跑分口径、战略 |
| [OpenAI_Jalapeno_芯片系统洞察.md](./OpenAI_Jalapeno_芯片系统洞察.md) | 同结构的文字版，便于检索和对照 |
| [Jalapeno_架构细节_slice网络与Rubin对比.md](./Jalapeno_架构细节_slice网络与Rubin对比.md) | 补充：core/HBM slice、网卡与 scale-up、XPU 不出光、TH6 静态时延、整柜 vs Rubin NVL72、PD 与 TP/EP |
| [scripts/build_pptx.py](./scripts/build_pptx.py) | PPT 生成脚本 |

## 相关目录

- [LLM 推理学习](../llm-inference-learning/)
- [超节点规模需求报告](../supernode-scale/)
- [UB / CXL 技术资料](../ub-cxl/)

## 重新生成 PPT

```bash
python3 docs/jalapeno/scripts/build_pptx.py
```
