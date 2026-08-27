# Jalapeño 架构细节：Slice、网络、并行与 Rubin NVL72 对比

> **用途：** 补全系统洞察 PPT 里没展开的几处：为什么切 core/HBM slice、网卡到底是什么、XPU 出不出光、整柜和 Vera Rubin NVL72 怎么比、所谓 PD 融合在公开材料里实际长什么样。  
> **日期：** 2026-08-26  
> **口径：** 2026-08 Hot Chips / OpenAI 博客 / SemiAnalysis 实验室报道。未公布的数字会标明「估计」或「未披露」。  
> **配套：** [`OpenAI_Jalapeno_芯片系统洞察.md`](./OpenAI_Jalapeno_芯片系统洞察.md) · [`PPT`](./OpenAI_Jalapeno_系统洞察.pptx)

---

## 1. 为什么要搞 Core slice / HBM slice

切 slice 不是把 HBM 切碎当卖点，而是让 **小 batch、低延迟的 decode 也能贴着峰值带宽跑**。GPU 那套统一内存是为反向的事准备的：用大 shape、高 occupancy 去藏延迟。

### 1.1 要砍掉什么

LLM 推理里真正贵的往往不是算，是搬：

- Decode 一步只算很少 token，矩阵小，**藏不住长延迟**
- 每步都要读权重、读 KV
- GPU 典型路径长：寄存器 → L1 → L2 → 交叉开关 → HBM 控制器 → 某一堆 HBM。延迟大，必须靠大量 warp / 大 batch / 大 tiling 摊销

OpenAI / SemiAnalysis 把目标写死：去掉 KV 和权重的来回搬，以及 barrier、launch 这类固定开销，让小 batch、奇怪 shape 也能靠近峰值 FLOPS / 带宽。

### 1.2 Slice 具体在干什么

芯片做成「算力 NUMA + 内存 NUMA」，一对一绑死：

```text
  [Core slice 0] ←低延迟直连→ [HBM slice 0]   ← 这堆上的权重 / KV
  [Core slice 1] ←低延迟直连→ [HBM slice 1]
  [Core slice 2] ←低延迟直连→ [HBM slice 2]
        │
        ├─ 专用 collective：slice 间同步（主要是可与计算重叠的 TP）
        └─ 通用 NoC：杂项通信、出芯片去 scale-up
```

物理上也顺：公开口径大约 6 堆 HBM4 围着一颗 reticle。每堆本来就有自己的 phy/控制器，与其做一张全芯片共享的大交叉开关，不如一堆 HBM 配一组核，让常用操作数走最短路径。

Gluon 按这个模型编程：每个物理核当一个 thread block，tensor / SIMD / 标量围着本地内存视图转；TensorInfo / Linear Layout 显式记录数据落在哪片硅上。软件假设数据是「放在某 slice 上」，不是「丢进一块大 HBM 再让硬件去找」。

Hot Chips 现场表述（ServeTheHome 记幻灯片）：每个 core slice 配一个 HBM slice，提供 fast local view；常见跨核图案走专用低延迟 collective；更灵活的通用 NoC 留给不在快路上的流量。

### 1.3 为什么这样反而可行

统一共享内存的好处是任意核都能摸全部 HBM，编程简单。代价是每条访问都可能穿过复杂互连。

Jalapeño 赌的是 LLM serving 的访问很规矩：

1. 权重可以切好放本地（TP 把列/头切到不同 slice）
2. KV 可以钉在产生它的那组核旁边（所以强调 KV local、不拆 P/D 池）
3. slice 之间真正要同步的，主要是已知、高带宽、可与计算重叠的通信——SemiAnalysis 点名就是 tensor parallel 那类 collective

| 网 | 干什么 |
|---|---|
| 专用 collective | 常见跨核图案（TP all-reduce / all-gather），低延迟、高带宽 |
| 通用 NoC | 不在快路上的杂项，以及访问片外 scale-up |

### 1.4 对推理曲线的效果

| | GPU 统一内存 | Jalapeño slice |
|---|---|---|
| 延迟 | 高，靠 occupancy 藏 | 本地视图短，小 batch 也吃得下 |
| 要跑满峰值 | 需要大 shape / 大 batch | 目标是全 Pareto 都靠近 roofline |
| 交互式 decode | 固定开销占比大 | 正是他们要打的点 |
| 编程 | 硬件帮你藏，layout 可以糊 | 必须把权重和 KV **显式放对 slice** |

这也解释了乱序核 + L1、而不是纯 scratchpad：再砍一层 barrier 税。代价是预取质量交给软件，OpenAI 的答案是 Codex 对着 trace 搜 kernel。

SemiAnalysis 认为相对 Nvidia / Google，更简单的 NoC 和内存子系统还能省电——统一交叉开关本身就很烧。

**一句话：** Core slice + HBM slice = 片上把「谁算、谁的数」钉死，换短延迟和少搬数据。跨 slice 只保留 TP 这类可重叠的集体通信。这和机架上「KV 不在 P/D 池之间搬家」是同一哲学。

未公开：一片里几个核、是不是严格 6 slice 对 6 堆、跨 slice 的一致性到哪一层。

---

## 2. 网卡是什么配置

真正叫「网卡」的只有主机柜上的前端以太网。卡间互联不是网卡，是 ASIC 上的 SerDes 直接进 Tomahawk。NIC 品牌和 SKU 都没公布。

### 2.1 前端网卡（scale-out）

在 **Katsu 主机托盘**上，不在 Jalapeño 封装上。

| 项 | 公开口径 |
|---|---|
| 位置 | 每个 Katsu 托盘（2× AMD EPYC Turin） |
| 带宽 | **400G = 2×200G** |
| 用途 | 北向：接入、请求进出、存储、普通以太网 |
| 数量 | 16 托盘/柜 → 整柜前端 **16×400G = 6.4 Tb/s** |
| 型号 | **未披露** |

模型并行走 scale-up，不走这张前端网卡。

### 2.2 主机 ↔ ASIC：PCIe

每个 Katsu 托盘用 **8 根外部 PCIe Gen5 DAC**，从机柜正面横接到对应 Vindaloo 托盘（8 颗 ASIC，基本一卡一根）。这是控制面和主机 I/O，不承担 TP / EP。

### 2.3 卡间互联（常被当成网卡）

每颗 Jalapeño 的 N3E I/O die：

- 32 lane × 200G 级 SerDes（报道写成 32 lanes of 800G SerDes，按 4×200G=800G 口理解，数字能对上）
- **24 lane → 本地 scale-up：单向 4.8 Tb/s = 600 GB/s**
- **8 lane → 全局 scale-up：单向 1.6 Tb/s = 200 GB/s**

这些 lane 出封装后走铜背板进 **Chana 交换托盘**，不经过主机 NIC。

| | Local（机架 128 卡） | Global（16 柜 / 2048 卡） |
|---|---|---|
| 交换托盘 | 6 个 Chana | 2 个 Chana（柜顶/柜底） |
| 交换芯片 | 每盘 **1× Tomahawk 6 102.4T** | SemiAnalysis 估计每盘 **2× TH6 ≈ 204.8T** |
| 拓扑 | 128 卡对 6 颗 TH6 **all-to-all** | **8-rail、rail-only** |
| 介质 | 无源铜，每卡 48 对差分 | 铜背板出柜 → 面板 **1.6T 光模块** → 柜内 **OCS** |
| 公开用途 | **Tensor Parallel** | **Expert Parallel** |
| 每柜铜缆 | 本地约 6144 对差分 | 本地+全局合计约 8192 对 |

OpenAI 官方点名 Broadcom Tomahawk 进平台；TH6 / 1.6T / OCS 的拆法来自 SemiAnalysis。全局托盘是不是两颗 TH6，原文是 “we think”。

```text
以太网前端（真·网卡）
  每 Katsu 托盘  400G = 2×200G     ← 请求进出，不跑 TP/EP
        │
        │  8× PCIe Gen5 DAC（托盘对托盘）
        ▼
  Vindaloo 8 卡
        │
        │  封装上 32×200G 电 SerDes，不是网卡，也不是光口
        ├─ 24 lane / 4.8 Tb/s ──► 6× TH6 102.4T   全程铜  机架 128 卡（TP）
        └─  8 lane / 1.6 Tb/s ──► 全局 TH6（仍是铜）
                                      │
                                      ▼
                                 面板 1.6T 可插拔光模块   ← 光电转换在这里
                                      │
                                      ▼
                                 柜内 OCS → 光纤 → 对端 OCS → 对端全局 TH6（光→电）
                                      → 铜背板 → 对端 XPU     最多 16 柜 2048 卡（EP）
```

和 GB200/Rubin NVL72 对比：Nvidia 卡间是 NVLink + NVSwitch，北向才是网卡（通常每 GPU 一张 ConnectX）。Jalapeño 把卡间做成以太网交换（Tomahawk 6）当 scale-up，网卡只留在 CPU 柜做前端。

未公开：NIC 品牌/SKU、是不是 RoCE、200G 口封装、有没有 SmartNIC/DPU、PCIe 是 x16 还是分叉。

### 2.4 「铜缆 + OCS」不等于 XPU 出光

**结论：Jalapeño 封装上没有光口。** 32 条 scale-up lane 全是电 SerDes，出封装后一律进铜背板。光电转换发生在 **全局 Chana 交换托盘的面板光模块** 上，不在 Vindaloo 加速器托盘上，更不在 XPU 封装上。

容易混的点：跨框写「铜缆 + OCS」，听起来像卡自己出光。实际是 **两段介质**：

1. **XPU → 本柜全局交换机：全程电。** 8 条 global lane 和 24 条 local lane 一样，走铜背板进 Chana / Tomahawk 6。
2. **本柜交换机 → 别的柜：才变光。** TH6 面板上的 **1.6T 可插拔光模块** 做电→光，再进柜内 **OCS**，光纤出柜连到别的机架。

OCS（optical circuit switch）只能切已经是光的信号。XPU 从不直接连 OCS。

```text
                    ┌─────────────── 本柜（电域）───────────────┐
  Jalapeño XPU      │                                           │
  I/O die           │  铜背板                                    │
  32×200G 电 SerDes─┼──► Chana / TH6 ──► 本地 TH6：不出柜       │
                    │                 │                         │
                    │                 └──► 全局 TH6 面板         │
                    │                      1.6T 光模块          │
                    └──────────────────────┬────────────────────┘
                                           │ 光
                                           ▼
                                      柜内 OCS_A
                                           │ 光纤
                                           ▼
                                      柜内 OCS_B → 对端全局 TH6 面板（光→电）
                                           → 铜背板 → 对端 XPU
```

对端同样是「交换机收光，再铜到卡」，不是光纤落到 XPU 上。完整对称路径见下一节。

| 如果「XPU 出光」会看到什么 | 公开材料实际写的 |
|---|---|
| 封装 CPO / 硅光引擎 | I/O die 是 **N3E + 电 SerDes** |
| Vindaloo 托盘前面板有 QSFP / OSFP | 加速器托盘走 **铜背板**，类似 Nvidia Oberon |
| 全局 8 lane 直接打光纤、绕过 TH6 | 全局仍先铜进 TH6，再 **面板 1.6T 模块** |
| OCS 挂在卡上 | OCS 在 **机架里、交换机之后** |

这和 Nvidia NVL72 / Oberon 是同一类拆法：加速器侧保持短距电互连（功耗、延迟、良率都更好），跨柜才在交换机面板上插光。差别只是 Jalapeño 的交换机是 Tomahawk 6 以太网，不是 NVSwitch。

Local 128 卡 **永远不出光**。跨柜时光电发生在 **两端的全局 Chana 面板模块** 上，不是只在源端做一次。

### 2.5 跨柜「一跳」也不等于光直插对端卡

容易把三件事拧成一件：

| 口头上的「一跳」 | 实际指什么 | 对端还过不过交换机 |
|---|---|---|
| Local 128 | 真·一跳包交换：XPU → 本柜 TH6 → XPU，全程铜 | 过本柜交换机，无光 |
| Global 8-rail rail-only | **同一条 rail 走到底，不再上第三级 spine 换轨** | **过对端全局 TH6** |
| OCS 电路 | 光纤被切成一条直电路，OCS 本身不转发以太包 | 电路两端仍是两柜的交换机光模块 |

公开口径更贴近中间那行，不是「源交换机出光后光纤插到对端 XPU」。

跨柜完整路径是 **对称的交换机对交换机**，不是非对称的交换机对卡：

```text
  柜 A                                      柜 B
  XPU_A                                     XPU_B
    │ 电 SerDes / 铜背板                      │ 电 SerDes / 铜背板
    ▼                                         ▼
  全局 TH6_A                               全局 TH6_B     ← 对端仍要过这颗交换机
    │ 面板 1.6T：电→光                       │ 面板 1.6T：光→电
    ▼                                         ▲
  柜内 OCS_A ──── 光纤 ──── OCS_B ────────────┘
                 （电路交换，不算一跳以太网）
```

对端为什么还要过交换机：

1. **对端 XPU 只有电 SerDes。** 光纤到柜，先要变成电，才能进铜背板。公开材料把 1.6T 模块放在 **Chana 面板**，不是 Vindaloo 面板。光→电之后，信号落在 **对端 TH6 的光口 SerDes** 上，再由这颗交换机转发到对着 XPU 的铜口。
2. **每柜都有 2 个全局 Chana（估计带 TH6）。** 若对端只是「光模块直通到卡、交换机不在数据面」，对端这几颗 TH6 在收包时就闲着。更顺的读法是：每柜全局 TH6 都是 **leaf**——朝下 204.8 Tb/s 铜口接本柜 128 卡（128 × 1.6T），朝上大约同等带宽的光口进 OCS。这是 1:1 过订阅的 leaf，跨柜自然是 `XPU → leaf_A → OCS → leaf_B → XPU`。
3. **光电一定成对。** 源端电→光之后，目的端必须光→电。少一次，200G 电 SerDes 接不住光子。少的不是「对端交换机」，而是「对端 XPU 光口」——那一层本来就没有。

rail-only 改变的是 **少一层包交换**，不是取消对端 leaf：

```text
不是这样（那才需要 XPU 收光）：
  XPU_A ─铜─► TH6_A ─光─► OCS ─光─► XPU_B

是这样（8-rail、无第三级 spine）：
  XPU_A.rail_k ─铜─► TH6_A.rail_k ─光─► OCS ─光─► TH6_B.rail_k ─铜─► XPU_B.rail_k
```

包交换跳数：本柜全局 TH6 + 对端全局 TH6，**两跳**。OCS 是电路，不记一跳以太网。和 Local 128 的「一跳」不是同一个「一」。EP 跨柜走这条两跳；TP 尽量留在 Local 铜域里，就是为了不付这两跳和两次光电。

若把光纤真的直落到对端卡上，对端 Vindaloo 必须有光模块或封装光引擎——那才叫 XPU 出光/收光。公开拆法对不上。

未公开：1.6T 模块是 OSFP / OSFP-XD 还是别的封装、有没有 CPO 上交换机（公开口径是 front-panel transceiver，按可插拔理解）、OCS 供应商和端口数、全局到底是 2 跳 leaf–leaf 还是少数场景把 OCS 配成更接近直连的电路。后一项即使更「直」，光电仍在两柜的交换机面板上，不在 XPU 上。

---

## 3. 整柜 vs Vera Rubin NVL72

按「一柜加速器域」比：Jalapeño 是 **128 卡 ASIC 柜**（旁边还有 Katsu 主机柜），Rubin NVL72 是 **72 GPU + 36 Vera CPU 的一柜**。不要拿 Jalapeño 的 2048 卡 Pod 去打 NVL72。

### 3.1 整机三件套

| | Jalapeño 128 卡柜 | Vera Rubin NVL72 | Jalapeño / Rubin |
|---|---|---|---|
| 加速器数量 | 128 | 72 | 1.78× 卡数 |
| **4-bit 算力** | **1.7 EFLOPS MXFP4** | 训练密算 **2.52 EF NVFP4**；推理海报 **3.6 EF**（含 Transformer Engine / 稀疏） | 算力只有 Rubin 的 **约 47%–67%** |
| **HBM 容量** | **27.5 TB HBM4** | **20.7 TB HBM4** | **多约 33%** |
| **HBM 访存带宽** | **约 1.97 PB/s**（15.4 TB/s × 128） | **1.58 PB/s**（官网 1,580 TB/s） | **高约 25%** |

单卡对不上整柜的方向：Rubin 单卡更肥，Jalapeño 靠多 56 张卡把容量和带宽翻上来，峰值 FLOPS 仍翻不过去。

| | Jalapeño 单卡 | Rubin GPU |
|---|---|---|
| 4-bit | 13.4 PF MXFP4（单 reticle） | 35 PF NVFP4 训练 / 50 PF 推理 |
| HBM | 216 GB（约 6 堆） | 288 GB（8 堆 12-Hi） |
| 带宽 | 15.4 TB/s | 22 TB/s |

核对：128 × 13.4 PF = 1.71 EF；72 × 22 TB/s = 1.58 PB/s。

### 3.2 怎么读这三个差

- **算力：Rubin 更高。** 即使用更接近密算的 2.52 EF，仍大约是 Jalapeño 的 1.5×。用 3.6 EF 推理海报则约 2.1×。Jalapeño 单 die 13.4 PF；Rubin 单颗封装是双 die，SemiAnalysis 给单颗 Rubin compute die 约 17.5 PF dense NVFP4。
- **内存：Jalapeño 整柜更大。** 27.5 TB vs 20.7 TB。单卡 Rubin 多（288 vs 216），但 72 卡装不满 128 卡的总量。Nvidia 那柜另外还有 54 TB LPDDR5X 在 Vera 上，那是 CPU 内存，不能算进 HBM 工作集。
- **访存带宽：Jalapeño 整柜更高。** 约 2.0 PB/s vs 1.58 PB/s。单卡 Rubin 更快（22 vs 15.4），卡少了，整柜带宽反而落后约两成。Decode、读权重、扫 KV 看的是整 replica 的聚合带宽。

一句话：Rubin 柜是「更少的卡、更高的单卡算力和单卡带宽」；Jalapeño 柜是「更多的卡、更大的 HBM 池、更高的聚合带宽，峰值 FLOPS 更低」。

### 3.3 不要混的两处

1. **4-bit 不是同一种数。** Jalapeño 的 1.7 EF 是 MXFP4 矩阵峰值；Nvidia 的 3.6 EF 是 NVFP4 推理（通常含稀疏），2.52 EF 才是 NVFP4 训练密算。
2. **Jalapeño 2048 卡 Pod** 公开约 27 EF / 432 TiB，对位的是一排 NVL72，不是一柜。

功耗只作背景：Jalapeño 双柜大约 160 kW（ASIC 柜 ~130 kW + 主机 ~31 kW）；Rubin NVL72 大约 190 kW Max-Q / 230 kW Max-P。

Rubin 规格来自 [NVIDIA Vera Rubin NVL72](https://www.nvidia.com/en-us/data-center/vera-rubin-nvl72/)（官网标注 preliminary，subject to change）。

---

## 4. 「PD 融合」原话是什么，部署具体怎样

OpenAI **没有用「PD 融合部署」这个词**。原话更接近：一张同质、可切换的卡，同时打 prefill 和 decode，KV 不要搬走。

### 4.1 官方怎么说

[Jalapeño first results](https://openai.com/index/jalapeno-first-results/)：

- Prefill 算力密集，decode 吃内存带宽
- 只擅长其中一个阶段的系统，会在等数据、搬模型状态时把优势输掉
- KV cache 可以显式放本地，系统按推理阶段激活计算 / 内存 / 网络的组合
- 结果是 **balanced and fungible accelerator**：prefill 和 decode 都要强，并能随着两者比例变化而适应（agentic 负载的特征）

Hot Chips 更硬（ServeTheHome 记幻灯片）：

- Slide 20：prefill / draft / verify 比例会变，**specialized heterogeneous fleets 会闲置还耗底电**
- Slide 21：选择题——**KV 在专用系统之间搬家，还是在同一颗芯片里改活跃硅的配比**。OpenAI 选后者

把这话说成 “chose not to disaggregate prefill and decode across separate chip pools” 的是 [SemiAnalysis](https://newsletter.semianalysis.com/p/openai-jalapeno-better-than-nvidia)。他们还注明公开跑分是 STP、无投机解码、无 PD 分离。

| 说法 | 谁说的 |
|---|---|
| 平衡、可互换的加速器；KV 留本地；按阶段开关硅 | OpenAI 博客 + Hot Chips |
| 异构专用机池不划算 | Hot Chips Slide 20–21 |
| 不把 PD 拆到两套芯片池 | SemiAnalysis 归纳 |

### 4.2 一次请求实际怎么走

不是 P 卡和 D 卡焊在一起，而是：

1. 没有两套池。Prefill 和 Decode 用同一组 Jalapeño；设计上 draft 和主模型也走同一套芯片和 fabric
2. 一次请求不换卡。Prefill 写出的 KV 就在这组卡的本地 HBM，Decode 继续读
3. 卡内按阶段开关资源。闲着的计算 / 内存 / 网络单元关掉
4. Teacup + persistent / gigakernel：同一组核上可以混 prefill tile 和 decode tile

```text
请求进来
    │
    ▼
同质 replica（TP × EP 那一组卡）
    │
    ├─ Prefill：吃矩阵引擎，把 KV 写进本卡 HBM
    ├─ （可选）Draft：超小 batch，还在这组卡上
    └─ Decode / Verify：吃 HBM 带宽，KV 不搬
```

### 4.3 并行被网络拓扑钉死

| 域 | 规模 | 每卡带宽 | 公开用途 |
|---|---|---|---|
| 托盘 Vindaloo | **8 卡** | 铜背板进机架交换 | 起步的 **TP8** |
| Local 机架 | **128 卡** | **600 GB/s** | **Tensor Parallel** |
| Global 16 柜 | **2048 卡** | **200 GB/s** | **Expert Parallel** |

SemiAnalysis 现场看到的旋钮：

- 先跑 **TP8**（一盘 8 卡）
- 8 天扩到 **TP32**，离开单系统、上到机架 fabric 跑大模型。TP32 = **32 卡**，是 4 个托盘，还在 128 卡机架里
- GPT-OSS 高并发点用 **EP8**
- 公开跑分：STP、无投机解码、无 PD 分离
- **没人提 PP。** 单卡 216 GB，权重侧不太需要流水线；未披露之前按 PP=1 理解

```text
replica ≈ TP（放 local 128 域） × EP（可放到 global 2048 域）
副本之间再 DP 扩吞吐
P 和 D 共用这个 replica，不拆
```

### 4.4 三个公开模型：能钉死的和只能估的

InferenceX：GPT-OSS-120B、DeepSeek R1 670B、Kimi K2.5 1T，全是 MoE。单卡 216 GB，MXFP4。

| 模型 | 规模 | 专家 | 权重大概 | 公开说过的并行 | 卡数 |
|---|---|---|---|---|---|
| GPT-OSS-120B | 117B 总 / 5.1B 激活，checkpoint **60.8 GiB** | 128 expert，top-4 | 1 卡就装得下 | 高并发点 **EP8** | **能钉：高并发 replica ≥ 8 卡**。低并发可以 1 卡 |
| DeepSeek R1 670B | ~671B 总 / ~37B 激活 | 256 routed，top-8 | MXFP4 权重约 330+ GB | 当作 draft-model 用例；TP32 更像给这类大模型 | **权重下限约 2 卡**；EP8 也能装。正式 world size **未报** |
| Kimi K2.5 1T | 1T 总 / 32B 激活 | 384 expert，top-8 + 1 shared | MXFP4 权重约 500 GB | 「跨很多设备 scale」；和 TP32 对得上 | **权重下限约 3 卡**；TP32 = 32 卡是唯一对上号的大模型机架配置。EP 几路未报 |

GPT-OSS 高并发上 EP8 不是装不下，是把 128 个 expert 切开换吞吐：EP8 → 每卡 16 个 expert。

```text
一个 replica 的典型拼法（公开能支撑的）：
  小模型高并发：  TP1～8  × EP8      例如 GPT-OSS 高并发
  大 MoE 机架级： TP32     × EP?      Kimi / R1 这一档，EP 未公布
  再放大：        多个 replica 做 DP，而不是再拆一套 P 柜、一套 D 柜
```

明确没公开的：三条 InferenceX 曲线各自的精确 TP×EP×DP；生产 ChatGPT / 内部模型卡数；混 batch 比例；投机解码上线后 draft 占多少算力；有没有 CP。

---

## 5. 来源

- OpenAI，[Jalapeño’s first results](https://openai.com/index/jalapeno-first-results/)
- Hot Chips 2026，*You Can Just Build Things … Chips*；现场记录见 [ServeTheHome](https://www.servethehome.com/openai-jalapeno-asic-at-hot-chips-2026/)
- SemiAnalysis，[OpenAI Jalapeño: Better Than Nvidia Blackwell](https://newsletter.semianalysis.com/p/openai-jalapeno-better-than-nvidia)（2026-08-25）
- NVIDIA，[Vera Rubin NVL72](https://www.nvidia.com/en-us/data-center/vera-rubin-nvl72/)
- The Register / WCCFTech 对机架规格的转述
- GPT-OSS 参数来自 OpenAI model card；Kimi K2.5 参数来自 Moonshot 公开 README

数字均为 2026-08 公开口径，后续软件、B0 硅和 Rubin 量产规格还会变。
