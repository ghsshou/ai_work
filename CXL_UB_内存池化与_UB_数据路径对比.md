# CXL vs UB 内存池化方案对比 & UB 数据路径（LD/ST vs URMA）

> 整理自技术讨论，适用于 LLM 推理基础设施选型参考。  
> 生成日期：2026-08-05

---

## 目录

1. [CXL 与 UB 是什么](#1-cxl-与-ub-是什么)
2. [内存池化三种模式](#2-内存池化三种模式)
3. [方案 A：基于 CXL 的内存池化](#3-方案-a基于-cxl-的内存池化)
4. [方案 B：基于 UB（灵衢）的内存池化](#4-方案-b基于-ub灵衢的内存池化)
5. [核心设计哲学差异](#5-核心设计哲学差异)
6. [内存池化能力拆解对比](#6-内存池化能力拆解对比)
7. [性能与规模预期](#7-性能与规模预期)
8. [面向 LLM 推理的池化方案](#8-面向-llm-推理的池化方案)
9. [软件栈与运维对比](#9-软件栈与运维对比)
10. [部署形态与成本](#10-部署形态与成本)
11. [优劣势总结](#11-优劣势总结)
12. [选型决策矩阵](#12-选型决策矩阵)
13. [两套可落地方案摘要](#13-两套可落地方案摘要)
14. [UB 数据路径：小包 LD/ST vs 大包 URMA](#14-ub-数据路径小包-ldst-vs-大包-urma)
15. [参考资料](#15-参考资料)

---

## 1. CXL 与 UB 是什么

| | **CXL** | **UB（灵衢）** |
|---|---------|----------------|
| **全称** | Compute Express Link | Unified Bus |
| **定位** | 基于 PCIe 的**开放行业标准**，主打 CPU 侧内存扩展与缓存一致性 | 华为面向超节点的**统一互联协议栈**，一套协议覆盖机内 + 机间 |
| **解决什么** | 服务器内「内存不够、想池化、加速器挂内存」 | 整机房里「PCIe / NVLink / IB 各管一段，系统太碎」 |
| **典型范围** | 单机、机架内为主 | 芯片 → 机柜 → 集群，统一编址与互联 |
| **生态** | CXL 联盟，全球生态 | 灵衢互联社区，主要围绕昇腾/国产算力栈 |

**一句话：**

- **CXL** = 在现有服务器架构上，给内存和加速器加一条标准扩展总线
- **UB** = 从零设计一台逻辑上的大计算机，用一套总线把所有东西连起来

---

## 2. 内存池化三种模式

| 模式 | 含义 | CXL | UB |
|------|------|-----|-----|
| **内存扩展（Expansion）** | 给某台主机「借」更多容量 | ✅ 主战场 | ✅ 支持 |
| **内存池化（Pooling）** | 多主机共享一池，按需分配/回收 | ✅ CXL 2.0+ Switch | ✅ UBS Mem / 内存借用 |
| **内存共享（Sharing）** | 多主机**同时**访问同一块内存 | CXL 3.0 硬件一致共享 | UB 共享内存区（最终一致为主） |

---

## 3. 方案 A：基于 CXL 的内存池化

### 3.1 参考架构

```
┌─────────────────────────────────────────────────────────┐
│                    机架 / POD                            │
│                                                          │
│  Host-1 ──┐                                              │
│  Host-2 ──┼──► CXL Switch ──► Memory Box (Type-3 DIMM) │
│  Host-N ──┘         ▲                                    │
│                     │                                    │
│              Fabric Manager（池化编排）                   │
│                                                          │
│  OS: CXL 内存 = NUMA 远端节点                             │
│  App: tiered memory / vLLM KV offload                    │
└─────────────────────────────────────────────────────────┘
```

### 3.2 典型拓扑（CXL 2.0 量产形态）

- 多台 **CPU 服务器** 经 PCIe/CXL 适配器连 **CXL Switch**
- Switch 后侧挂 **Memory Chassis**（多块 Type-3 CXL 内存条）
- 例：Beluga 架构 — 最多 16 台 server 共享约 **8TB** 池，总带宽约 **1TB/s**

### 3.3 软件栈

```
Fabric Manager（发现拓扑、分配内存给 host）
    ↓
CXL 驱动 → OS 呈现为 CPUless NUMA node / 设备内存(HDM)
    ↓
Tiering 层：Linux DAMON / memtiering / 自研 KV tier
    ↓
应用（vLLM KV offload、数据库 buffer pool 等）
```

---

## 4. 方案 B：基于 UB（灵衢）的内存池化

### 4.1 参考架构

```
┌────────────────── 超节点 SuperPoD ──────────────────┐
│                                                      │
│  节点-1: CPU ←UB→ NPU ←UB→ DDR                       │
│  节点-2: CPU ←UB→ NPU ←UB→ DDR                       │
│           ↕ UB Switch / UB-Mesh ↕                    │
│                                                      │
│  UBS Engine / UBFM（去中心化资源编排）                 │
│  UBS Mem（lease / share API）                        │
│  UB OS Component（远端内存映射）                     │
└──────────────────────────────────────────────────────┘
```

### 4.2 典型拓扑（Atlas 超节点）

- **CPU、NPU、DDR、NIC、交换机** 全部 UB 互联，无主从
- 每台节点的 DDR 既可本地用，也可被邻居 **借用（lease）** 或 **共享（share）**
- 控制面：**UBS Engine**（openEuler UB Service Core），去中心化，支持 N-1 高可用

### 4.3 软件栈

```
UBFM / UBS Engine（池化调度、借用/归还、故障域）
    ↓
UB OS Component（远端内存热插拔、NUMA 距离、映射）
    ↓
UBS Mem（ubsmem_lease_malloc / 共享内存区 API）
    ↓
应用（数据库、虚拟化、AI KV Cache）
```

### 4.4 UB 两种池化模式

| 模式 | 说明 | CXL 近似做法 |
|------|------|-------------|
| **内存借用（Borrow/Lease）** | 节点 A 空闲 DDR 映射给节点 B，用完归还 | Host 从池里分配一段，独占使用 |
| **内存共享（Share）** | 多节点同时 map，用于 RTO/共享缓存 | CXL 3.0 hardware sharing 或软件模拟 |
| **削峰填谷** | UBS Virt/RMRS 按负载动态借还 | 需自研 orchestrator + FM |

---

## 5. 核心设计哲学差异

| 维度 | CXL 方案 | UB 方案 |
|------|----------|---------|
| **设计起点** | 在 PCIe 生态上扩展「CPU 可见内存」 | 为超节点设计「整机房一台逻辑计算机」 |
| **中心节点** | **CPU Host** 发起访问、OS 管理 NUMA | **对等**：CPU/NPU 都可 Load/Store 远端内存 |
| **互联范围** | 机架内为主，CXL 3/4 向多机架演进 | 机内 + 机间统一 UB 协议（UB-Mesh） |
| **一致性** | CXL 域内**强一致**（cache coherency） | **最终一致**为主，利于大规模 |
| **与 AI 集群关系** | 补内存容量；机间通信仍靠 IB/RoCE | 内存池 + NPU 互联 + 集群通信一体化 |
| **标准化** | CXL Consortium，全球生态 | 灵衢社区开放，绑定华为/国产栈 |

---

## 6. 内存池化能力拆解对比

### 6.1 资源发现与分配

| 能力 | CXL | UB |
|------|-----|-----|
| 拓扑发现 | Fabric Manager 扫描 Switch + Type-3 设备 | UBFM / UBS Engine 扫描 UB 域内节点 |
| 分配粒度 | 按 host 分配 CXL 内存区域 | **内存借用**：按 region/大小 lease |
| 动态回收 | FM 回收后 host unmap | `ubsmem_lease_free` 归还 |
| 多租户 | FM 策略 + OS cgroup/numa | UBS Engine + 云管北向 API |

### 6.2 应用访问方式

| 访问路径 | CXL | UB |
|----------|-----|-----|
| **透明扩展** | OS 把 CXL 内存当远端 NUMA | OS 热插拔远端内存 + `ubsmem_lease_malloc` |
| **显式管理** | `mmap` HDM、tiering | `ubs_mem.h` API、共享内存 create/attach |
| **NPU 直访** | 需 NPU 支持 CXL/PCIe 路径 | **原生**：NPU 经 UB 直访池化 DDR |
| **零拷贝共享** | CXL 3.0 memory sharing | UB 共享内存区，多节点 attach |

---

## 7. 性能与规模预期

> 以下为工程预期量级，非厂商承诺值，实际需 POC 验证。

| 指标 | CXL 池化（2.0 量产级） | UB 池化（超节点 1.0/2.0） |
|------|------------------------|---------------------------|
| **单跳延迟** | ~750ns–1µs+（经 Switch） | ~150ns 量级（机内，架构目标） |
| **池化带宽** | Switch 级 ~1–2 TB/s | 单链路 ~1.25 TB/s 级 |
| **池容量** | 单机架 TB 级（如 8TB 池） | 超节点内多节点 DDR 聚合 |
| **跨机架** | CXL 4.0 规划 multi-rack（2027+） | UB-Mesh + Clos，协议内支持 |
| **尾延迟** | 页错误、冷缓存、Switch 争用敏感 | 远端映射 + 最终一致，需应用适配 |
| **一致性开销** | 强一致，跨 host 共享成本高 | 最终一致，扩展性好 |

**关键结论：**

- CXL 池化内存 **比本地 DDR 慢**，但比「走网络 RDMA 拉 KV」往往更简单
- UB 池化在 **NPU 为中心的超节点** 里路径更短

---

## 8. 面向 LLM 推理的池化方案

### 8.1 KV Cache 分层

| 层级 | CXL 方案 | UB 方案 |
|------|----------|---------|
| **热 KV** | GPU HBM | NPU HBM |
| **温 KV** | 本机 DDR | 本机 DDR |
| **冷 KV / 溢出** | **CXL 池** | **UB 池化 DDR** |
| **跨节点 KV** | 通常还要 **RDMA/IB** | **UB 统一 fabric** |
| **软件参考** | Beluga、vLLM KV offload | vLLM-Ascend KV connector、Mooncake |

### 8.2 CXL 推理池化架构

```
[NPU/GPU] ←PCIe→ [CPU] ←CXL→ [CXL Switch] ←→ [Memory Pool]
                      ↑
              vLLM: 热 KV on device
              冷 KV page 到 CXL NUMA node
```

### 8.3 UB 推理池化架构

```
[NPU-1] ←UB→ [NPU-2]
   ↓ UB        ↓ UB
[DDR-1] ←UB→ [DDR-2]  ← 池化，互为 lease
   ↑
vLLM-Ascend + KV connector 经 UB 访问远端 DDR
```

### 8.4 推理场景对比

| 评估项 | CXL | UB |
|--------|-----|-----|
| **与 vLLM 生态** | 通用，有学术/原型 | 绑定 vLLM-Ascend / MindIE |
| **NPU 直访池化内存** | 路径长 | **原生优势** |
| **PagedAttention 兼容** | 冷 KV 放 CXL 区 | block 可放 UB lease 区 |
| **PD 分离** | KV 仍要网络 | 可走 UB fabric |
| **成熟度** | 2025–2026 硬件量产中 | 超节点已商用（华为口径） |

---

## 9. 软件栈与运维对比

| 层级 | CXL | UB |
|------|-----|-----|
| **编排** | CXL Fabric Manager | UBS Engine + UBFM |
| **OS** | Linux CXL 驱动、HDM、NUMA | UB OS Component、`ub-pkg-mem` |
| **监控** | FM + 自研 | Prometheus 兼容北向 |
| **故障域** | Switch/DIMM 故障 → 失去 NUMA 段 | N-1 节点失效设计目标 |
| **开发接口** | 标准 NUMA + tiering | `ubsmem_lease_malloc` + 共享内存 API |

**UB 内存借用示例：**

```c
// 从邻居节点 lease 4MB 池化内存
ubsmem_lease_malloc("default", 0x400000, DISTANCE_DIRECT_NODE, 0, &addr);
// ... 使用 addr ...
ubsmem_lease_free(addr);
```

**CXL 侧示例：**

```bash
# OS 已把 CXL 内存列为 NUMA node 2
numactl --membind=2 ./vllm_server
```

---

## 10. 部署形态与成本

| 形态 | CXL | UB |
|------|-----|-----|
| **最小起步** | 单机 + CXL Type-3 内存条 | 需 UB 超节点环境 |
| **真正池化** | CXL Switch + Memory Box + 多 Host | 买超节点即带 UB fabric |
| **与现有机房** | 可渐进部署 | 通常新建超节点 |
| **供应商** | Samsung/Micron、XConn Switch 等 | 华为 Atlas 950/960 |
| **锁定风险** | 标准开放 | 硬件+软件栈绑定国产路线 |
| **适用客户** | 互联网/cloud x86+NVIDIA | 政务、运营商、昇腾集群 |

---

## 11. 优劣势总结

### CXL 内存池化

**优势：**
- 开放标准，CPU 生态成熟，可渐进部署
- 强一致性，NUMA + mmap 编程模型友好
- 与 x86/GPU 推理栈兼容，不绑单一厂商

**劣势：**
- CPU 中心，NPU 直访路径绕
- 机间 scale-out 仍依赖 IB/RoCE
- 尾延迟、Fabric 争用需大量调优
- 多 rack 池化（CXL 4.0）仍在规划期

### UB 内存池化

**优势：**
- 协议归一：内存池 + NPU 互联 + 跨节点通信同一套 UB
- NPU/CPU 对等访问池化 DDR
- 超节点内 lease/share 原生，UBS Engine 开箱池化
- 面向万卡「一台计算机」

**劣势：**
- 生态封闭在国产/华为栈
- 最终一致性，共享内存应用要自己做同步
- 非昇腾/鲲鹏客户难以采用

---

## 12. 选型决策矩阵

| 你的情况 | 更倾向 |
|----------|--------|
| x86 + NVIDIA GPU，想扩 KV/内存容量 | **CXL** |
| 昇腾 Atlas 超节点已立项 | **UB** |
| 要多云/多厂商、怕锁定 | **CXL** |
| Prefill/Decode 分离 + KV 跨节点 | **UB** |
| 数据库/虚拟化内存削峰 | 两者都可 |
| 机架内 8–16 台 CPU 共享 DDR 池 | **CXL 2.0** |
| 万卡级统一内存编址愿景 | **UB** |

---

## 13. 两套可落地方案摘要

### 方案 CXL-Pool-A：机架级 KV 温冷分层（通用 GPU 推理）

| 项 | 内容 |
|----|------|
| **硬件** | 8× GPU 服务器 + CXL Switch + 8TB Memory Box |
| **连接** | 每 server 2× PCIe5 x16 CXL 适配器 → Switch |
| **池化** | FM 按 job 分配 1–2TB/节点，独占 lease |
| **软件** | Linux memtiering + vLLM KV offload 到 CXL NUMA |
| **SLA** | 热 KV HBM；冷 KV CXL |
| **适合** | 已有 NVIDIA 集群，KV 内存成为瓶颈 |

### 方案 UB-Pool-A：超节点内 NPU KV 池（昇腾推理）

| 项 | 内容 |
|----|------|
| **硬件** | Atlas 950 SuperPoD，多节点 NPU + DDR |
| **连接** | 机柜内 UB-Mesh，DDR 全池化 |
| **池化** | UBS Engine 内存借用；NPU 经 UB 访问邻居 DDR |
| **软件** | openEuler + UBS Mem + vLLM-Ascend KV connector |
| **SLA** | 热 KV HBM；溢出/共享 KV 走 UB 池 |
| **适合** | 国产算力、超节点已采购、长上下文高并发 |

---

## 14. UB 数据路径：小包 LD/ST vs 大包 URMA

### 14.1 结论（先给答案）

**大体正确，但需收窄表述：**

| 口语版（基本正确） | 技术版（更严谨） |
|-------------------|-----------------|
| 小包转发 LD/ST 效率高，大包转发 URMA 效率高 | **同步 Load/Store（TP Bypass）** 适合小 payload、低延迟、CPU 同步访问；**异步 Read/Write（Work-Queue）** 适合大 payload、高吞吐、可流水线化的 bulk 传输 |

**关键澄清：LD/ST 不是和 URMA 对立，而是 URMA 内部的 fast path。**

### 14.2 概念关系

| 概念 | 说明 |
|------|------|
| **UB** | 底层互联协议 |
| **URMA** | UB 对上层的统一远程内存访问抽象（编程模型） |
| **LD/ST 路径** | URMA 内的同步、CPU 指令 fast path（TP Bypass） |
| **Read/Write 路径** | URMA 内走 Work Queue + 传输层的异步路径 |

OpenURMA 论文原话：

> *load/store wins on short, latency-tight operations; the work-queue path on long, throughput-bound ones.*

### 14.3 为什么小包 LD/ST 更高效？

**Work-Queue / Read-Write 路径：**
```
CPU 写 WQE → Doorbell → NIC DMA 读 WQE → 组包 → 对端处理 → DMA 写 CQE → CPU 轮询
```
约 10 级 pipeline + 序列号/重传/拥塞控制。

**Load/Store 路径（TP Bypass）：**
```
CPU 一条 ld/st → 片上 UB 控制器 → 组包发网 → 数据回寄存器
```
约 5 级 pipeline，可绕过传输层状态机。

**64B 远端读实测（OpenURMA）：**

| 路径 | 端到端延迟 |
|------|-----------|
| UB Load/Store | ~500 ns |
| RoCEv2 READ（对照） | ~2200 ns（慢约 4.5×） |

**延迟量级对比（brpc OBMM 方案）：**

| 方式 | 典型延迟 | 语义 |
|------|----------|------|
| OBMM Load/Store | ~几百 ns | 同步内存访问 |
| URMA Read/Write | ~2–5 μs | 异步 |
| RDMA Verbs | ~2–5 μs | 异步 |

### 14.4 为什么大包 URMA（Work-Queue）更合适？

**LD/ST 硬限制：**
- 只适用于小的 load/store、同路径原子操作
- 同步、阻塞 CPU
- **不适合** bulk 传输、异步 pipeline、需要完整可靠传输层的场景

**大包时：**
- LD/ST 每次只能搬 cache line 量级，CPU 成为瓶颈
- Work-Queue 可 DMA 流水线：一次提交、批量传输、多 outstanding

**类似 crossover（CXL Beluga 论文）：**
- **< 4KB**：CPU load/store 更优
- **更大**：用 DSA/DMA 引擎

### 14.5 工程决策表

| 场景 | 推荐路径 | 原因 |
|------|----------|------|
| 64B–256B 远端读（元数据） | **LD/ST** | 延迟最低 |
| 细粒度 KV block、原子更新 | **LD/ST / Atomic** | 同步语义简单 |
| RPC 小请求 | **LD/ST** | 避免 WQE 开销 |
| MB 级 KV 迁移 | **URMA Read/Write** | 吞吐、DMA |
| 异步 pipeline | **URMA Read/Write** | 非阻塞 |
| 单边消息 Send/Recv | **URMA Jetty** | LD/ST 不支持 |

### 14.6 注意事项（Caveats）

1. **没有固定字节阈值**：crossover 取决于 QD、缓存策略、链路延迟等；经验上 **几 KB 以下偏 LD/ST，更大偏 Read/Write**，需实测。
2. **LD/ST 会阻塞 CPU**：大包全用 LD/ST 可能更慢。
3. **URMA 是总称**：准确说法是「URMA 的两条 data path」。

### 14.7 一句话记忆

```
小包 → 控制面开销主导 → LD/ST 砍掉 WQE/Doorbell/CQE → 延迟赢
大包 → 数据面吞吐主导 → Work-Queue + DMA 流水线 → 带宽赢
```

---

## 15. 参考资料

- [CXL Consortium 官网](https://computeexpresslink.org/)
- [CXL 3.0 White Paper](https://computeexpresslink.org/wp-content/uploads/2023/12/CXL_3.0_white-paper_FINAL.pdf)
- [Beluga: CXL-Based LLM KVCache Management](https://arxiv.org/pdf/2511.20172)
- [OpenURMA: Clean-Room UB Implementation](https://arxiv.org/html/2605.28717)
- [灵衢系统高阶服务软件架构参考设计 2.0](https://www.openeuler.org/projects/ub-service-core/white-paper/UB-Service-Core-SW-Arch-RD-2.0-zh.pdf)
- [UB Service Core（openEuler）](https://www.openeuler.org/zh/projects/ub-service-core/)
- [超节点技术体系白皮书 - 链路层与事务协议](https://deeplink-org.github.io/superpod-whitepaper/01-architecture/04-protocols/)
- [The Thinking Behind Unified Bus（Bojie Li）](https://01.me/en/2025/09/a-story-of-unified-bus/)
- [vLLM-Ascend 文档](https://docs.vllm.ai/projects/ascend/en/latest/)

---

*文档结束*
