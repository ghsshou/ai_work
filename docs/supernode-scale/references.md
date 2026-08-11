# 昇腾超节点规模需求报告：资料与口径基线

> 核验截止日期：2026-08-11。正文中的“公开事实”应能由本清单追溯；无法公开核验的数据必须标记为“示例假设”。

## 1. 昇腾与 Atlas 950

### 华为：计算产业战略及新品发布会主题演讲

- URL：https://www.huawei.com/cn/news/2025/9/hc-xu-keynote-speech
- 支持内容：
  - Atlas 950 SuperPoD 路线图规模为 8192 张 Ascend 950DT 卡；
  - 路线图口径 FP8 8 EFLOPS、FP4 16 EFLOPS、互联总带宽约 16 PB/s；
  - 路线图口径总内存容量 1152 TB；
  - Ascend 950DT 路线图口径为 144 GB HBM、4 TB/s HBM 带宽、2 TB/s 芯片互联带宽；
  - Atlas 950 SuperCluster 由 64 个 SuperPoD 组成，FP8 总算力 524 EFLOPS；
  - Atlas 950 和 Ascend 950DT 的计划上市时间为 2026 年第四季度。
- 使用限制：以上是路线图/计划参数，不应表述为已交付系统的实测值。

### 华为：超节点架构创新

- URL：https://www.huawei.com/cn/news/2025/9/hc-superpod-innovation
- 支持内容：
  - UB-Mesh 递归直连；
  - 以 64 卡为步长扩展；
  - 路线图最大 8192 卡无收敛全互联。

### 华为：Atlas 950 SuperPoD 1024 卡真机

- URL：https://www.huawei.com/cn/news/2026/7/atlas-950-superpod
- 支持内容：
  - 2026-07-17 公开 1024 卡真机；
  - 1 EFLOPS FP8、2 EFLOPS FP4；
  - 256 TB 全局统一内存编址空间；
  - TB 级 NPU 互联、RTT 小于 3 μs。
- 使用限制：
  - “256 TB 统一编址空间”不能直接等同于 HBM 容量；
  - 新闻稿没有给出该真机的精确总互联带宽或可持续性能。

### 昇腾：Atlas 350 加速卡

- 产品页：https://www.hiascend.com/hardware/accelerator-card?tag=150
- 上市新闻：https://www.hiascend.com/activities/dynamic-news/20260320-3
- 支持内容：
  - Atlas 350 采用 Ascend 950PR；
  - 112 GB HBM、1.4 TB/s；
  - 4 卡全互联双向 318 GB/s/卡，2 卡互联双向 424 GB/s/卡；
  - 官方页面列出的各精度算力。
- 使用限制：Atlas 350/950PR 参数不能代替 Atlas 950 SuperPoD/950DT 参数。

## 2. Transformer 参数与训练计算

### PaLM

- URL：https://www.jmlr.org/papers/volume24/22-1144/22-1144.pdf
- 支持内容：
  - 参数矩阵前向约 2 FLOPs/参数/token；
  - 反向约 4 FLOPs/参数/token；
  - 训练主项约 6 FLOPs/参数/token；
  - MFU 的定义与使用。

### Chinchilla

- URL：https://proceedings.neurips.cc/paper/2022/file/c1e2faff6f588870935f114ebe04a3e5-Paper-Conference.pdf
- 支持内容：计算量近似 \(C\approx6PT\) 的使用口径。

### SwiGLU

- URL：https://arxiv.org/abs/2002.05202
- 支持内容：门控 FFN 的结构；SwiGLU 有 gate、up、down 三个矩阵。

### LLaMA

- URL：https://arxiv.org/abs/2302.13971
- 支持内容：RMSNorm、SwiGLU 等现代 Decoder-only Transformer 配置参考。

### Megatron 3D Parallelism

- URL：https://arxiv.org/pdf/2104.04473
- 支持内容：
  - TP、PP、DP 的组合；
  - 模型参数/FLOPs 估算；
  - 流水线气泡和通信分析。

## 3. 训练内存与长序列

### ZeRO

- URL：https://arxiv.org/pdf/1910.02054
- DeepSpeed 文档：https://deepspeed.readthedocs.io/en/stable/memory.html
- 支持内容：优化器状态、梯度、参数分片及训练内存估算。

### Activation 重计算

- URL：https://proceedings.mlsys.org/paper_files/paper/2023/file/80083951326cf5b35e5100260d64ed81-Paper-mlsys2023.pdf
- 支持内容：Transformer Activation 内存模型、选择性重计算与完整重计算。
- 使用限制：文中的 34、5 等常数属于特定实现，不是所有框架的普适常数。

### FlashAttention

- URL：https://papers.nips.cc/paper_files/paper/2022/file/67d57c32e20fd0a7a302cb81d36e40d5-Paper-Conference.pdf
- 支持内容：精确 Attention 的 IO-aware 算法；避免在 HBM 中物化完整 \(S^2\) 中间矩阵。
- 使用限制：存储复杂度降低不等于 Attention 数学计算量从平方变成线性。

### Context Parallelism

- Megatron Core 文档：https://docs.nvidia.com/megatron-core/developer-guide/nightly/user-guide/features/context_parallel.html
- Ring Attention：https://proceedings.iclr.cc/paper_files/paper/2024/file/1119587863e78451f080da2a768c4935-Paper-Conference.pdf
- 支持内容：按序列维切分及 KV 交换。

## 4. MoE

### Switch Transformer

- URL：https://jmlr.org/papers/volume23/21-0998/21-0998.pdf
- 支持内容：Top-1 路由、capacity factor、专家容量。

### GShard

- URL：https://arxiv.org/abs/2006.16668
- 支持内容：Top-2 路由、专家容量、跨设备 All-to-All。

### MegaBlocks

- URL：https://proceedings.mlsys.org/paper_files/paper/2023/file/5a54f79333768effe7e8927bcccffe40-Paper-mlsys2023.pdf
- 支持内容：Dropless MoE、负载不均与动态稀疏计算。

### DeepSeekMoE

- URL：https://aclanthology.org/2024.acl-long.70/
- 支持内容：细粒度 routed experts 与 shared experts。

### DeepSeek-V3

- URL：https://arxiv.org/abs/2412.19437
- 支持内容：负载均衡、受限路由与冗余专家部署。

### Megatron Core MoE

- MoE 指南：https://docs.nvidia.com/megatron-core/developer-guide/latest/user-guide/features/moe.html
- Token dispatcher：https://docs.nvidia.com/megatron-core/developer-guide/latest/apidocs/core/core.transformer.moe.token_dispatcher.html
- 支持内容：EP、TP及 All-to-All dispatcher 的工程流程。

## 5. 推理

### MQA 与 GQA

- MQA：https://arxiv.org/pdf/1911.02150
- GQA：https://arxiv.org/abs/2305.13245
- 支持内容：KV Head 数减少及对 KV 容量/带宽的影响。

### PagedAttention / vLLM

- URL：https://dl.acm.org/doi/10.1145/3600006.3613165
- 支持内容：分页 KV Cache、碎片和连续批处理。

### 推理算力、内存与并行

- URL：https://proceedings.mlsys.org/paper_files/paper/2023/file/c4be71ab8d24cdfb45e3d06dbfca2780-Paper-mlsys2023.pdf
- 支持内容：Transformer 推理中的权重、计算、内存带宽和分片分析。

### Roofline

- URL：https://doi.org/10.1145/1498765.1498785
- 支持内容：计算吞吐与内存带宽上界模型。

### 连续批处理

- Orca：https://www.usenix.org/system/files/osdi22-yu.pdf
- 支持内容：迭代级调度、请求动态加入和退出 Batch。

### 指标定义

- GenAI-Perf：https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/perf_analyzer/genai-perf/README.html
- NVIDIA 指标说明：https://developer.nvidia.com/blog/llm-benchmarking-fundamental-concepts/
- 支持内容：TTFT、TPOT/ITL、吞吐的定义和统计口径。

### Prefill/Decode 分离

- DistServe：https://arxiv.org/abs/2401.09670
- Splitwise：https://arxiv.org/abs/2311.18677
- 支持内容：Prefill/Decode 分离、KV 传输及独立扩容。

## 6. 通信模型

### Hockney \(\alpha\)-\(\beta\) 模型

- DOI：https://doi.org/10.1016/S0167-8191(06)80021-9
- 支持内容：\(T=\alpha+\beta M\) 的消息通信时间模型。

### HCCL

- 概述：https://www.hiascend.com/document/detail/en/canncommercial/800/hcclug/hcclug/hcclug_000001.html
- 性能测试：https://www.hiascend.com/document/detail/zh/CANNCommunityEdition/900beta2/devaids/hccltool/HCCLpertest_16_0001.html
- 支持内容：昇腾集合通信能力和性能测试工具。

## 7. 统一使用规则

1. \(6PT\)、\(2PS\)、\(2P\) 等是主项近似，不是精确执行 FLOPs。
2. 每 rank 权重不能无条件写成 \(Pb/p\)，需考虑复制参数和量化元数据。
3. 每 rank KV 不能无条件除以 TP；当 TP 大于 KV Head 数时可能复制。
4. MoE All-to-All 必须说明是组级逻辑 payload、实际远端流量、单 rank 注入量还是链路 byte-hop。
5. 物理峰值带宽必须乘以由目标算子/消息规模实测得到的效率系数。
6. 平均值用于解释趋势，容量和 SLA 规划应使用高分位或高水位。
7. Atlas 950 的 8192 卡数据标为路线图口径，1024 卡数据标为公开真机口径。
