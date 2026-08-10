# LLM 推理学习：建议路径与问答梳理

> **学习者背景**  
> - 有 Transformer 理论基础  
> - 几乎没有推理代码实战经验  
> - 目标环境：昇腾（Ascend），主线框架：vLLM / vLLM-Ascend  
> - 环境尚未搭建，当前以读源码 + 概念理解为主  
>
> **最后更新：** 2026-08-10  
> **目录：** `docs/llm-inference-learning/`  
> **配套文档：**  
> - [推理学习进度记录.md](./推理学习进度记录.md)  
> - [CXL_UB_内存池化与_UB_数据路径对比.md](./CXL_UB_内存池化与_UB_数据路径对比.md)  
> - [CXL_UB_内存池化与数据路径对比.pptx](./CXL_UB_内存池化与数据路径对比.pptx)  
> - [本目录 README](./README.md)

---

## 目录

1. [学习建议（规划侧）](#一学习建议规划侧)
2. [源码导读建议](#二源码导读建议)
3. [后续问题与结论（问答侧）](#三后续问题与结论问答侧)
4. [进度与下一步](#四进度与下一步)
5. [资源链接](#五资源链接)

---

## 一、学习建议（规划侧）

### 1.1 总体原则

1. **先直觉，后源码**：先理解 Prefill/Decode、KV Cache、Continuous Batching，再读代码。  
2. **先通用，后昇腾**：调度 / KV 管理在 `vllm/v1/`，昇腾差异主要在 `vllm-ascend/`。  
3. **一条主线深挖**：推荐从 **Scheduler + PagedAttention** 切入，再选 Kernel / 量化 / 投机解码。  
4. **环境可后置**：没硬件时先跟请求调用链；有硬件后再跑 benchmark。

### 1.2 建议的 4 个阶段

| 阶段 | 目标 | 关键动作 | 状态 |
|------|------|----------|------|
| **阶段 0** | 补推理直觉 | Prefill vs Decode、KV Cache、continuous batching；读 PagedAttention 论文 | ✅ 概念已过 |
| **阶段 1** | 昇腾上跑通 | Docker + vLLM-Ascend，小模型离线推理 + API | ⏳ 待环境 |
| **阶段 2** | Benchmark 建直觉 | 调 `max_num_seqs` / `max_num_batched_tokens`，记 tokens/s、TTFT、TPOT | ⏳ 待环境 |
| **阶段 3** | 读源码 | 通用层 → 昇腾插件 →（可选）ATB/AscendC | ✅ 第一轮已开始 |

### 1.3 昇腾环境建议（环境就绪后）

| 项 | 建议 |
|----|------|
| 主线 | **vLLM-Ascend**（社区官方插件） |
| 对照 | MindIE（华为官方栈，概念相通、代码不同） |
| 起步方式 | 优先官方 Docker（CANN / torch-npu / vllm-ascend 版本强绑定） |
| 首模型 | Qwen2.5-0.5B / 1.5B，跑通再上 7B+ |
| 检查命令 | `npu-smi info` |

**概念映射（CUDA → 昇腾）：**

| CUDA 世界 | 昇腾世界 |
|-----------|----------|
| CUDA / cuBLAS | CANN + ATB |
| PyTorch CUDA | torch-npu |
| FlashAttention | NPU 融合 attention（ATB / 自定义算子） |
| CUDA Graph | NPU Graph / npugraph_ex |
| NCCL | HCCL |
| nvidia-smi | npu-smi info |

### 1.4 深挖路线建议（五选一，推荐先 A）

| 路线 | 内容 | 适合时机 |
|------|------|----------|
| **A. 调度与内存** ⭐推荐 | Scheduler、BlockManager、Chunked Prefill、Prefix Caching | 入门首选 |
| B. 计算与 Kernel | Attention backend、NPU Graph、AscendC | 有 CUDA/算子基础后 |
| C. 量化 | AWQ/GPTQ/FP8/W8A8（`vllm_ascend` 量化路径） | 熟悉调度后 |
| D. 投机解码 | Speculative Decoding | 熟悉 placeholder / async 后 |
| E. 分布式 | TP + HCCL、PP | 多卡环境就绪后 |

### 1.5 动手练习建议（环境就绪后）

1. 跑通离线 `LLM.generate()` + OpenAI API  
2. 用 `benchmark_throughput.py` 扫 `max_num_batched_tokens`  
3. 对照 `scheduler.py` 理解吞吐/延迟拐点  
4. 跟一个 `perf` / `attention` 相关 PR  
5. 对比 HF `generate` vs vLLM 加速比  

---

## 二、源码导读建议

### 2.1 一条请求的调用链（必背）

```
LLM.generate()
  → _run_completion() → _run_engine()        # while has_unfinished: step()
    → LLMEngine.step()
      → EngineCore.step()
          ① scheduler.schedule()             # 决定本步算谁、算多少
          ② model_executor.execute_model()   # forward
          ③ scheduler.update_from_output()   # 写回 token、释放资源
```

一句话：**调度 → 执行 → 更新状态**，循环直到请求结束。

### 2.2 第一轮建议阅读的文件（按顺序）

| 顺序 | 文件 | 函数/类 | 学什么 |
|------|------|---------|--------|
| 1 | `vllm/entrypoints/llm.py` | `generate()` | 用户 API 入口 |
| 2 | `vllm/entrypoints/offline_utils.py` | `_run_engine()` | 主循环 |
| 3 | `vllm/v1/engine/core.py` | `EngineCore.step()` | 三步心跳 |
| 4 | `vllm/v1/core/sched/scheduler.py` | `schedule()` 前半 | token 预算、running 队列 |
| 5 | `vllm/v1/core/kv_cache_manager.py` | `allocate_slots()` | PagedAttention 落地 |
| 6 | `vllm/v1/core/sched/output.py` | `SchedulerOutput` | 调度↔Worker 契约 |
| 7 | `vllm-ascend/.../worker/worker.py` | `NPUWorker.execute_model()` | 昇腾执行入口 |
| 8 | `vllm-ascend/.../platform.py` | `NPUPlatform` | 插件如何挂上 NPU |

**插件注册：** `vllm_ascend/__init__.py` → `register()` → `"vllm_ascend.platform.NPUPlatform"`

### 2.3 读代码时建议自问的 5 个问题

1. 这一步算几个 token？→ `num_scheduled_tokens`  
2. KV 存在哪？→ `allocate_slots` 返回的 block  
3. 新请求还是老请求？→ `scheduled_new_reqs` vs `scheduled_cached_reqs`  
4. Prefill 还是 Decode？→ `num_new_tokens` 是很大还是 1  
5. 昇腾特有逻辑在哪？→ `vllm_ascend/`  

### 2.4 当时给出的「下一讲」选项（尚未全部展开）

| 选项 | 内容 | 状态 |
|------|------|------|
| **A** | `scheduler.schedule()` 后半段：waiting 队列、抢占 | ⏳ 推荐继续 |
| **B** | `model_runner_v1.execute_model()` 怎么组 batch | ⏳ |
| **C** | `AscendAttentionBackend` forward | ⏳ |
| **D** | `platform.check_and_update_config()` 昇腾配置改写 | ⏳ |

---

## 三、后续问题与结论（问答侧）

按提问时间顺序整理。

---

### Q1. 基于 vLLM 学推理优化，应该从哪开始？

**建议结论：**
- 补齐 Prefill/Decode、KV Cache、Continuous Batching  
- 先跑服务 + benchmark，再读 `Scheduler` + `BlockManager`  
- 第一条深挖路线：**调度 + PagedAttention（路线 A）**  

---

### Q2. 有 Transformer 基础、没搞过推理代码，想基于昇腾，怎么调整？

**建议结论：**
- 主线用 **vLLM-Ascend**；MindIE 作对照  
- 环境优先 Docker，版本严格配套（CANN / torch-npu / vllm-ascend）  
- 没硬件时先读调用链；有硬件后先跑小模型再上 benchmark  
- 仍推荐从 Scheduler + KV 切入，昇腾特有层（Attention / 量化 / Graph）放后  

---

### Q3. 环境自己搞定，先带读代码

**已完成的导读：**
- 走通 `generate → step → schedule → execute → update`  
- 点名 8 个关键文件（见第二节）  
- 强调 vLLM **v1** 路径在 `vllm/v1/`，不是旧的 `vllm/core/`  

**核心直觉：**
> 训练是一次 forward；推理是多次 `step()`。每个 `step` = 调度一批 token → 跑模型 → 可能产出新 token。

---

### Q4. `num_output_placeholders` 那段 if 是什么意思？

```python
if (
    request.num_output_placeholders > 0
    and request.num_computed_tokens + 2 - request.num_output_placeholders
    >= request.num_prompt_tokens + request.max_tokens
):
    req_index += 1
    continue
```

**结论：**
- 场景：**异步调度 + 投机解码**  
- `num_output_placeholders`：已排上队、输出尚未确认的在途 token（含 draft）  
- `num_computed_tokens`：调度时乐观提前加的「已算位置」  
- 含义：即使 draft **全被拒**、只接受 1 个真实 token，也已到 `max_tokens` → **本步不再调度**，避免多跑一步、破坏 uniform decode  

---

### Q5. 下面三段分别是什么意思？

#### （1）PP decode 节拍

```python
if self.current_step < request.next_decode_eligible_step:
    continue
```

- **V2 + Pipeline Parallel + 异步调度**  
- Worker 侧 sampled-token broadcast 用 **slot ring**，第 T 步结果在 **T + pp_size** 才被消费  
- 调度侧：`next_decode_eligible_step = current_step + pp_size`，保证同一请求两次 decode 至少隔 `pp_size` 步  

#### （2）DP prefill 平衡

```python
if defer_prefills and request.is_prefill_chunk:
    continue
```

- Data Parallel 负载均衡：非 cadence 对齐步，若已有 decode 在跑，则 **延后仍在 prefill 的请求**  
- decode 照常排，避免这一步空转或 prefill 挤占  

#### （3）`num_new_tokens` 公式

```python
num_new_tokens = (
    request.num_tokens_with_spec
    + request.num_output_placeholders
    - request.num_computed_tokens
)
```

- 「还差多少 token 没算完」  
- 调度器**不硬分** prefill/decode，只让 `num_computed_tokens` 追上目标长度  
- 之后还会被 `token_budget`、`long_prefill_token_threshold` 截断  

---

### Q6. Chunked Prefill 是 PagedAttention 里的吗？PagedAttention 原理？

**结论：不是同一层概念。**

| 概念 | 层级 | 解决什么 |
|------|------|----------|
| **PagedAttention** | 内存管理 | KV 按固定 block 分页存，用 block table 映射逻辑→物理 |
| **Chunked Prefill** | 调度策略 | 长 prompt 分多步算，避免一步占满算力堵住 decode |

**PagedAttention 三要素：**
1. **Block Pool** — 全局固定大小的 KV block 池  
2. **Block Allocator** — 按需分配 / 回收  
3. **Block Table** — 每请求 `logical_block → physical_block`  

**互补：** Chunked Prefill 决定「这一步算哪段」；PagedAttention 决定「算完的 KV 占哪些 block」。

---

### Q7. CXL 和 UB 有什么区别？

| | **CXL** | **UB（灵衢）** |
|---|---------|----------------|
| 定位 | 基于 PCIe 的开放标准，CPU 侧内存扩展/一致性 | 华为超节点统一互联协议 |
| 范围 | 机架内为主 | 芯片 → 机柜 → 集群 |
| 中心 | CPU Host | CPU / NPU 对等 |
| AI 集群角色 | 补内存；机间仍靠 IB/RoCE | 内存 + 互联 + 通信一体化 |

**一句话：** CXL 是「给服务器加标准内存扩展」；UB 是「把机房编成一台逻辑计算机的总线」。

---

### Q8. Harness 是什么概念？

**Harness = 把被测/被跑对象包起来的运行壳**（环境 + 输入 + 执行 + 度量），本身通常不包含核心业务逻辑。

常见类型：
- Test harness（单测/集成）  
- Benchmark harness（如 vLLM `benchmarks/`）  
- Eval harness（如 lm-eval-harness）  
- Agent / runtime harness  

---

### Q9. 基于 CXL 与基于 UB 做内存池化的方案对比？

**结论摘要：**

| 方案 | 适用 | 关键组件 |
|------|------|----------|
| **CXL-Pool** | x86 + GPU，渐进扩 KV | Fabric Manager + CXL Switch + Type-3 DIMM |
| **UB-Pool** | 昇腾超节点 | UBS Engine + UB-Mesh + 内存借用/共享 |

- CXL：CPU 可见远端 NUMA，强一致，开放生态  
- UB：NPU/CPU 对等 Load/Store，协议归一，绑定国产栈  

**已输出文档：**
- Markdown：`CXL_UB_内存池化与_UB_数据路径对比.md`  
- PPT（23 页）：`CXL_UB_内存池化与数据路径对比.pptx`  

GitHub：
- https://github.com/ghsshou/ai_work/blob/main/CXL_UB_内存池化与_UB_数据路径对比.md  
- https://github.com/ghsshou/ai_work/blob/main/CXL_UB_内存池化与数据路径对比.pptx  

---

### Q10. 「小包转发 LD/ST 效率高，大包转发 URMA 效率高」对吗？

**大体正确，需收窄表述。**

| 路径 | 适用 |
|------|------|
| **Load/Store（TP Bypass）** | 小包、低延迟、同步 CPU 访问 |
| **URMA Read/Write（Work-Queue）** | 大包、高吞吐、异步 DMA |

关键澄清：
- LD/ST **不是** 与 URMA 对立，而是 URMA 内部的 **fast path**  
- 小包时控制面开销主导 → LD/ST 砍掉 WQE/Doorbell/CQE  
- 大包时吞吐主导 → Work-Queue + DMA 流水线  
- 无固定字节阈值；经验上几 KB 以下偏 LD/ST，需实测  

记忆口诀：
```
小包 → 控制面开销主导 → LD/ST → 延迟赢
大包 → 数据面吞吐主导 → Work-Queue → 带宽赢
```

---

## 四、进度与下一步

### 4.1 已建立的核心直觉（应能复述）

1. 推理是 **`while step()` 迭代**，不是一次 forward  
2. 调度器 **不硬分 prefill/decode**，靠 token 计数追赶  
3. **PagedAttention = 内存**；**Chunked Prefill = 调度**  
4. 昇腾差异主要在 **`vllm_ascend/`**；调度层 largely 通用  
5. CXL/UB 是更底层互联，影响 KV 能否池化，不改变 PagedAttention 算法本身  

### 4.2 进度表

| 模块 | 状态 |
|------|------|
| 学习路径规划（通用 + 昇腾） | ✅ |
| 请求调用链导读 | ✅ |
| Scheduler 三处细节追问 | ✅ |
| PagedAttention / Chunked Prefill | ✅ |
| CXL vs UB / 池化 / LD/ST vs URMA | ✅ |
| 环境搭建 + benchmark | ⏳ |
| Scheduler 后半段 / ModelRunner / Attention | ⏳ |

### 4.3 建议的下一轮阅读顺序

```
✅ 已读
  llm.py → offline_utils._run_engine → core.step → schedule() 前半

⏳ 建议接着读（路线 A）
  1. scheduler.py：allocate_slots + preempt（~575–630 行）
  2. kv_cache_manager.py：allocate_slots docstring + block 布局图
  3. scheduler.py：update_from_output()
  4. async_scheduler.py：placeholder 加减完整流程

⏳ 再往后
  5. model_runner_v1.execute_model()（昇腾组 batch）
  6. AscendAttentionBackend
```

### 4.4 续学入口（直接回复即可）

| 你说 | 接下来做什么 |
|------|----------------|
| **A** / 「继续 Scheduler」 | allocate_slots + 抢占 |
| **B** | ModelRunner 组 batch |
| **C** | AscendAttentionBackend |
| **D** | platform 配置改写 |
| 「环境搭好了」 | 带跑第一个 benchmark |
| 「画调度状态机」 | placeholder / prefill / decode 串图 |

---

## 五、资源链接

| 资源 | URL |
|------|-----|
| vLLM 文档 | https://docs.vllm.ai/ |
| vLLM-Ascend | https://github.com/vllm-project/vllm-ascend |
| vLLM-Ascend 安装 | https://docs.vllm.ai/projects/ascend/en/latest/installation.html |
| PagedAttention 论文 | https://arxiv.org/abs/2309.06180 |
| OpenURMA | https://arxiv.org/html/2605.28717 |
| UB Service Core | https://www.openeuler.org/zh/projects/ub-service-core/ |
| 本仓库 | https://github.com/ghsshou/ai_work |
| 本目录（GitHub） | https://github.com/ghsshou/ai_work/tree/main/docs/llm-inference-learning |
| 本文档 | https://github.com/ghsshou/ai_work/blob/main/docs/llm-inference-learning/LLM推理学习_建议与问答梳理.md |
| 进度记录 | https://github.com/ghsshou/ai_work/blob/main/docs/llm-inference-learning/推理学习进度记录.md |
| CXL/UB 对比 Markdown | https://github.com/ghsshou/ai_work/blob/main/docs/llm-inference-learning/CXL_UB_内存池化与_UB_数据路径对比.md |
| CXL/UB 对比 PPT | https://github.com/ghsshou/ai_work/blob/main/docs/llm-inference-learning/CXL_UB_内存池化与数据路径对比.pptx |

---

*本文件汇总「规划建议 + 后续问答」，作为续学索引。随对话继续更新。*
