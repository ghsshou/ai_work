# NVIDIA Scale-in 网络基础设施洞察（v2）

> **版本：** v2（现行）。相对 [v1](./NVIDIA_Scale_in_网络基础设施洞察_v1.md) 补充 Spectrum-X 等产品预备知识，改为书面语气，并扩展公开来源。  
> **用途：** 说明 Scale-in 在 NVIDIA AI 工厂网络中的位置、相对传统南北向网络的变化、处理原理、对应芯片与软件，以及对后续部署的影响。  
> **日期：** 2026-09-09  
> **口径窗口：** 2026-08 NVIDIA Technical Blog、Hot Chips 2026、FY2027 Q2 财报电话会，以及 Spectrum-X / DOCA / CMX / ConnectX-9 等既有产品文档。未公布的数字另行标明。  
> **配套 PPT：** [`NVIDIA_Scale_in_网络基础设施洞察_v2.pptx`](./NVIDIA_Scale_in_网络基础设施洞察_v2.pptx)

---

## 一句话结论

**Scale-in 是 NVIDIA 对传统「前端网络 / 南北向网络」的产品化升级：把用户、Agent、企业数据、外部存储、安全与运营从宿主机 CPU 上剥离，放到独立的基础设施处理域中。**

它不替代 NVLink（Scale-up），也不替代 ConnectX SuperNIC 上的 GPU 集体通信（Scale-out）。公开材料中的硬件组合是 **BlueField-4 DPU + DOCA + Spectrum-X Ethernet**。同名产品 **Vera BlueField-4 STX** 是存储处理器，服务于 CMX / AI-native 存储，与计算托盘上的 800G 接入卡不是同一角色。

2026 年 8 月三份口径指向同一层：

| 时间 | 来源 | 口径 |
|---|---|---|
| 2026-08-24 | NVIDIA Technical Blog | Scale-in 为 AI 网络 **第五支柱**，为智能体工厂的安全、管理、运营提供专用加速 |
| 2026-08-25 | Gilad Shainer / Hot Chips BlueField-4 | Scale-in **取代过去所谓的前端网络**（世界与 AI 工厂之间的南北向进出）；宣布 BlueField-4 + Spectrum-X Scale-in 网络 |
| 2026-08-26 | 黄仁勋 FY2027 Q2 电话会 | **Scale-in security networking** 与 scale-up / scale-out / scale-across 并列，作为「五种网络系统」之一 |

---

## 1. 预备知识：产品与分层

Scale-in 的公开表述大量使用既有产品名。若不先固定这些名词，后续「第五支柱」无法落到具体设备。

### 1.1 南北向与东西向

数据中心习惯把流量分成两类：

| 方向 | 含义 | 在 AI 工厂中的典型内容 |
|---|---|---|
| **南北向（north-south）** | 数据中心与外部、或服务器与接入层之间 | 用户请求、API、企业数据、外部存储、开户、遥测、管理 |
| **东西向（east-west）** | 数据中心内部服务器之间 | 训练 / 推理 collective、租户 workload、机架间 GPU 通信 |

传统云把南北向称为 **前端网络（frontend）**，东西向称为后端或算力面。Gilad 的表述是：Scale-in 取代过去所谓的前端网络，物理介质仍是以太网，改变的是处理位置与策略执行点。

### 1.2 NVIDIA 网络产品分层

NVIDIA 公开材料把 AI 工厂连接分成多段，每段对应不同硅与软件。与 Scale-in 同时出现、且必须先分清的产品如下。

#### Spectrum Ethernet 与 Spectrum-X

**Spectrum** 是 NVIDIA 以太网交换机产品族（约 1GbE–800GbE），可配 Cumulus Linux 或 SONiC，覆盖通用数据中心与 AI 交换。

**Spectrum-X Ethernet** 不是单一交换机型号，而是面向生成式 AI / 多租户 AI 工厂的 **端到端以太网平台**。官方产品页将其定位为「第一个为 AI 优化的端到端以太网网络平台」：在数据中心内连接算力面，并用 Spectrum-XGS 跨多个数据中心扩展。它由三部分共设计：

1. **Spectrum 交换机**（Hopper / Blackwell 代为 Spectrum-4，例如 SN5600，单芯片约 **51.2 Tb/s**、64×800G；Vera Rubin 代为 **Spectrum-6**，单芯片 **102.4 Tb/s**、200G SerDes，交换机形态包括 SN6600 / SN6800）
2. **主机侧 SuperNIC**（Hopper 代 **BlueField-3 SuperNIC**，约 400 Gb/s RoCE；Blackwell 代 **ConnectX-8**，合计约 800 Gb/s；Vera Rubin 代 **ConnectX-9**，每 GPU 最高 **1.6 Tb/s**）
3. **软件与线缆**（DOCA、交换机 NOS、NetQ / UFM、LinkX 光模块与线缆）

官方定位：把以太网做成 AI 的 Scale-out 交换。传输层使用 RoCE（RDMA over Converged Ethernet）扩展，而不是把 InfiniBand 换成普通 ECMP 以太网。相对货架以太网的宣传口径是约 **1.6×** 网络性能；对应关系是货架以太网有效带宽约 **60%**、Spectrum-X 约 **95%**，并在超过 10 万 GPU 的部署上维持该效率。Israel-1 等早期部署被用来展示该 1.6× 增益。Spectrum-X 的主场景是 **东西向 GPU 到 GPU 通信**；Scale-in 博客把它复用到 **接入与外部存储**。同一平台，两条用途。

货架以太网不适合大规模 AI 的原因（NVIDIA 技术博客 *Giga-Scale AI and the Ethernet Evolution*）：

- AI collective（All-Reduce / All-Gather / All-to-All）是少量超大、同步流，ECMP 静态哈希易碰撞，最慢一条流拖住整次同步；
- 丢包重传对训练 / 推理伤害大；PFC pause 可能把头阻塞扩散到整网；
- DCQCN 一类拥塞控制跟不上微秒级突发。

Spectrum-X 用交换机侧控制环与 SuperNIC 侧配合补这些缺口：

| 机制 | 位置 | 作用 |
|---|---|---|
| **Adaptive Routing（AR）** | 交换机 | 按出口队列深度逐包选路（硬件近似 Join-Shortest-Queue），而不是静态 ECMP 哈希 |
| **Direct Data Placement（DDP）** | SuperNIC | AR 导致乱序到达后，将数据按正确地址写入主机 / GPU 内存，对应用透明 |
| **Congestion Control（CC）** | 交换机 + SuperNIC | 交换机在 AR 仍无法消化时打 ECN；SuperNIC 按 RTT 与带内遥测调节注入速率 |
| **Plane Load Balancer（PLB）** | SuperNIC 硅上 | 把主机带宽切到多个独立两层平面；ConnectX-8 / ConnectX-9 支持硬件 PLB（`hwplb`），故障时约 3 ms 切走故障平面 |

**Spectrum-X Multiplane**：不把集群做成更深的三层 Clos，而是把单主机带宽拆成多个两层 fat-tree 平面（例如 8 条 200G 平面代替一条 1.6T）。操作系统与 NCCL 仍看到一块 RoCE 设备，分流与故障切换在硬件完成。公开评测口径包括：线速约 98%、10% 链路故障时带宽近似按容量比例下降、相对软件负载均衡约 400× 的 failover 速度。arXiv:2605.21187 进一步说明：交换机 AR 与网卡 PLB 是两套可独立调参的控制环；生产遥测中约 97% 的流量可容忍乱序，其余控制面流量走标准以太网栈。

Spectrum-X 也被用于 **AI 存储交换**：自适应路由等机制将存储读写 I/O 相对货架以太网最高约 **1.6×**（NVIDIA 存储交换材料）。Scale-in 路径上的外部存储数字是相对货架以太网约 **1.45×**，实验对象不同，不可与 1.6× 平台数字或 CMX 的 5× TPS 合并。

因此：Spectrum-X 首先是 **Scale-out 算力面以太网**；亦可承载存储与南北向接入。不可把它理解成「只给南北向用的新交换机」，也不可把它理解成 InfiniBand 的改名。

#### Spectrum-XGS 与 Spectrum-6

**Spectrum-XGS Ethernet** 是 Spectrum-X 的跨数据中心扩展（Scale-across，2025-08 作为第三支柱发布）：连接距离通常大于 500 m，可到园区、城市或更远，官方表述包括相距数百公里的多个数据中心作为单一 AI 工厂运行。硬件仍是 Spectrum 交换机 + SuperNIC，但拥塞控制与自适应路由计入站点间距（distance-aware congestion control、精确时延管理、端到端遥测）。公开数字：跨约 10 km 的 NCCL all-reduce 相对货架以太网最高约 **1.9×**，大消息增益更明显。Scale-in 不是这条路径。

**Spectrum-6** 是 Vera Rubin 代的 Spectrum-X 交换机硅：102.4 Tb/s、200G PAM4 SerDes、TSMC 3 nm、共享缓存；端口形态包括 128×800GbE。交换机产品包括 SN6600（128×800G OSFP）与 SN6800（512×800G，5U）。支持可插拔光与共封装光学（CPO），与 ConnectX-9、BlueField-4、NVLink 6 同一平台发布。

#### Quantum InfiniBand

Scale-out 的另一条产品线。Quantum 提供低时延、In-Network Computing，以及后续硅光 CPO 系统，面向 HPC 与部分 AI 训练网。第五支柱表述里，Scale-out 写的是 **Spectrum-X Ethernet 或 Quantum InfiniBand**。Scale-in 接入路径在公开博客中明确走 **Spectrum-X Ethernet**（含外部存储），未把 Quantum 写成南北向默认方案。

#### NVLink（Scale-up）

机柜 / 超节点内 GPU 之间的专有互连，使多颗 GPU 作为相干加速器工作。Vera Rubin 为 NVLink 6 + NVLink Switch。Scale-up 不承担用户接入、企业对象存储或租户开户。

#### SuperNIC、NIC 与 DPU

| 类别 | 代表 | 主要职责 |
|---|---|---|
| **NIC** | 早期 ConnectX | 主机网络适配，卸载有限 |
| **SuperNIC** | ConnectX-8 / ConnectX-9、BlueField-3 SuperNIC | 为 GPU 间 RoCE 通信优化的网络加速器：自适应路由配合、**Direct Data Placement** 乱序重排、PLB、租户性能隔离。Hopper 代 BF-3 约 400 Gb/s；Blackwell 代 ConnectX-8 合计约 800 Gb/s；**ConnectX-9 每 GPU 最高 1.6 Tb/s**（Vera Rubin 东西向） |
| **DPU** | BlueField-3 / **BlueField-4** | SuperNIC 级网络 **加上** 可编程 CPU、内存、inline 存储/安全引擎，可在主机 OS 外运行基础设施服务 |

BlueField-4 DPU **集成 ConnectX-9 级网络**，但角色不是「第四张 CX9」。CX9 SuperNIC 承载租户 Scale-out 流量；BF-4 承载南北向基础设施，并通过 Astra 向 CX9 下发策略。

#### DOCA

**DOCA（Data Center Infrastructure-on-a-Chip Architecture）** 是 BlueField 与 ConnectX 的统一软件平台：SDK、库、可部署微服务、以及以 Kubernetes 为中心的生命周期管理。官方说明其覆盖网络、AI-native 存储、运行时安全、遥测与编排。没有 DOCA，BlueField 只是一颗带 Arm 核的网卡；有 DOCA，才构成可编排的基础设施服务域。

**DPF（DOCA Platform Framework）** 把 DPU 作为 Kubernetes 节点发现、开通、部署与升级。

#### CMX 与 STX

**CMX（Context Memory Storage）** 是面向长上下文 / 多轮 / Agent 推理的 **工厂内 KV cache 层**，用以太网附加闪存扩展 GPU 内存，官方宣传相对传统存储约 **5× tokens/s** 与更高能效。网络仍走 Spectrum-X RoCE；软件走 **DOCA Memos**。

**STX** 是该存储层的模块化底座。**Vera BlueField-4 STX** 为存储处理器：Vera CPU + ConnectX-9，Spectrum-X 最高约 **1.6 Tb/s**。CMX 保存可重算的推理状态；Scale-in 存储路径连接训练数据、模型资产与企业知识。二者都出现 Spectrum-X 与 BlueField-4 字样，数据对象不同。

#### RoCE

RDMA over Converged Ethernet。Spectrum-X、CMX 访问与部分存储路径均建立在 RoCE 上，使 GPU / DPU 绕过主机协议栈直接访问远端内存或闪存。Scale-in 的 NVMe-oF、文件/对象卸载也依赖这条语义。

### 1.3 产品地图（阅读后文时对照）

```text
世界 / 用户 / 企业数据 / 外部存储
        │  南北向  Scale-in
        │  BlueField-4 DPU（800G）+ Spectrum-X
        ▼
  Vera Rubin 计算托盘
        ├─ Scale-up     NVLink 6
        └─ Scale-out    4 × ConnectX-9（1.6T）+ Spectrum-X 或 Quantum
                │
                ▼  跨园区
           Scale-across  Spectrum-XGS

  工厂内 KV / 可复用上下文
        │  CMX = STX 存储 + BlueField-4 STX + DOCA Memos + Spectrum-X
```

---

## 2. Scale-in 的定义与边界

公开材料中，Scale-in 指 **工厂边界向内的接入域**：流量从外部进入 AI 工厂，再落到加速器或 CPU。物理层仍是 Spectrum-X 以太网；变化在于由 BlueField-4 在租户主机之外完成处理，并由 DOCA 统一编排。

| 既有称呼 | NVIDIA 现行称呼 | 典型流量 | 主要产品 |
|---|---|---|---|
| 前端 / 南北向 | **Scale-in** | 用户请求、Agent 工具调用、企业检索、外部存储、开户、遥测 | BlueField-4 DPU + Spectrum-X |
| 算力面 / 东西向 | **Scale-out** | 集体通信、租户 workload | ConnectX-9 + Spectrum-X 或 Quantum |
| 柜内 GPU 互连 | **Scale-up** | 超节点内 GPU↔GPU | NVLink / NVLink Switch |
| 跨园区 | **Scale-across** | 工厂与工厂 | Spectrum-XGS |
| KV / 推理上下文 | **CMX** | 工厂内可共享 KV cache | STX + DOCA Memos |

黄仁勋在电话会中的限定词是 **security**：Scale-in 被单独列出，重点不仅是 800G 带宽，而是将安全与管控置于硅上、线速、且独立于租户操作系统。

五支柱的职责划分：

| 支柱 | 产品 | 连接对象 | 不覆盖 |
|---|---|---|---|
| Scale-up | NVLink | 柜内 GPU | 用户接入、企业数据 |
| Scale-out | Spectrum-X 或 IB + CX9 | 工厂内服务器 | 南北向接入、存储协议、租户操作系统外的安全执行 |
| Scale-across | Spectrum-XGS | 分布式工厂 | 单工厂内部接入 |
| CMX | STX + Memos | 工厂内共享 KV | 训练数据湖、企业知识库 |
| Scale-in | BF-4 + DOCA + Spectrum-X | 世界与工厂之间 | GPU 集体通信（由 CX9 承担） |

官方表述：仅扩大 GPU、机架与数据中心，若数据访问、存储、网络安全与运营不能同步扩展，算力无法转化为工厂吞吐。

与 captive 推理 ASIC（如 Jalapeño）的对照仅作定位：后者前端仍是主机侧 400G 以太网卡，scale-up 由加速器 SerDes 承担。NVIDIA Scale-in 将前端做成可编程 DPU 服务域，并用 Astra 将策略扩展到 Scale-out 网卡。比较端口速率没有意义，应比较策略执行点、东西向是否纳入同一控制域、存储协议是否卸载。

---

## 3. 相对传统南北向网络的变化

### 3.1 传统做法

传统数据中心南北向按软件定义、可组合、弹性构建：接入交换机 + 主机 vSwitch / SDN + 宿主机上的存储协议栈、防火墙与遥测进程。安全策略主要位于主机操作系统或旁路设备。

该模型适用于可预期的通用负载。智能体工厂的负载形态使其不再充分：

1. **单次请求包含多次模型、工具、检索、策略与存储访问。** 基础设施数据路径成为推理流水线的一段（NVIDIA 共设计博客原文：infrastructure is part of the inference pipeline）。
2. **单服务器接口达到数 Tb/s。** Vera Rubin 计算托盘聚合约 **7.2 Tb/s**（800G 南北向 + 四条 1.6T 东西向）。线速加密、NVMe-oF 与 ACL 无法继续依赖主机 CPU。Hot Chips 将早期云 DPU 对比为约 200G 量级插卡。
3. **多租户裸金属要求隔离位于租户操作系统之外。** 主机防火墙与租户处于同一信任域。
4. **存储与检索延迟直接表现为 GPU 空闲。** Scale-up / Scale-out 带宽充足并不能替代南北向协议处理。

官方判断：软件定义、可组合与弹性仍然必要，但不足够。安全、多租户网络、数据与存储访问、基础设施运营必须作为统一的加速域，而不能继续作为互不相干、且主要运行在通用 CPU 上的层次。

### 3.2 变化对照

| 维度 | 传统前端 / 可选云 DPU | Scale-in（Vera Rubin） |
|---|---|---|
| 位置 | PCIe 插卡，可选用 | 与 Rubin 平台共设计，Hot Chips 表述为不再事后加装 |
| 处理 | 策略与协议多在宿主机或轻量 Arm 核 | 主机无关：Grace 运行控制面，inline 引擎运行数据面 |
| 信任域 | 南北向可经 DPU；东西向网卡常仍在租户侧 | Astra：BF-4 下发策略，CX9 在 1.6T 口执行；东西向流量不经 800G 转发 |
| 带宽 | 云 DPU 约 200G 级（Hot Chips 对照） | Scale-in 单卡 800G；平台级策略视野覆盖托盘约 7 Tb/s 接口 |
| 软件 | vSwitch、存储驱动、安全进程分散 | DOCA 微服务与服务功能链 |

变化的实质是：基础设施获得独立的 CPU、内存、加速器与软件平台（DOCA），与租户 CPU / GPU 分离。

---

## 4. 原理

### 4.1 控制面与数据面分离

```text
DOCA（运行于 Grace）     决策：策略、开通、编排、遥测汇聚
inline 加速引擎          执行：包、RDMA、存储协议、加密、防火墙、策略命中
二者均不把上述工作交回主机 CPU
```

| 部件 | 功能 | 公开规格 |
|---|---|---|
| 64 核 Grace CPU | 策略、开通、遥测、编排 | 相对 BlueField-3 约 **6×** 算力 |
| Inline 加速引擎 | 包 / RDMA / 存储 / 加密 / 防火墙 / 策略 | 最高 **800 Gb/s** |
| LPDDR5X | 策略表、队列、遥测、元数据 | Hot Chips 约 **275 GB/s**；数据手册最多 **128 GB** |
| PCIe Gen6 x16 | 连接主机 | 相对 BF-3 的 Gen5 |
| 800 Gb/s 网络口 | 连接 Spectrum-X | 接入、安全、搬移、存储；不是托盘总带宽 |

相对 BlueField-3（最多 16× Cortex-A78、400G、PCIe Gen5）：网络 **2×**。内存口径在两篇官方博客中不完全相同——Scale-in 博文写带宽 **4×**；共设计博文写容量 **4×**、带宽 **>3×**。引用时应分开标注。Hot Chips：核频约 **1.7 GHz**（低于完整 Grace 服务器，现场记录认为受功耗约束）、200G PAM4 SerDes、inline 加密。

### 4.2 托盘带宽分配

Vera Rubin 每个计算托盘：

```text
约 7.2 Tb/s 聚合接口
  Scale-in    1 × 800 Gb/s     BlueField-4     南北向：请求、存储、管控、安全
  Scale-out   4 × 1.6 Tb/s     ConnectX-9      东西向：租户 workload / collective
```

南北向与东西向约为 **1 : 8**。这是平台设计，而不是尚未拓宽的缺口：

- 租户训练与推理报文走 ConnectX-9，不走 BlueField-4 的 800G。
- 800G 用于接入、外部存储与管控。
- Astra 将策略、密钥、隔离与遥测推送到 CX9，而不是把东西向流量回流 DPU。博客原文：同一套 VPC 策略覆盖接入与 Scale-out，无需将全部东西向流量经 800G 口转发。

Hot Chips 对「无平台级 DPU」的对照：

1. 仅隔离南北向时，Scale-out 无法与租户切断，GPU 网络不能端到端受控。
2. 若每张 NIC 各自配备 CPU、内存与管理，相对「由一张 BF-4 管理全部 CX9」功耗约高 **4×**。

Astra 闭环：

```text
运营者 / DOCA DPF
        │  开通、策略、密钥
        ▼
   BlueField-4（租户 OS 外的控制点）
        ├─ 本卡 800G 数据面（Scale-in）→ inline 引擎执行
        └─ Astra → ConnectX-9 数据面（Scale-out）→ 在 1.6T 口执行
                   东西向流量不回流 DPU
```

数据手册名称：**ASTRA（Advanced Secure Trusted Resource Architecture）**，用于选定 Rubin 平台上的 CX9，提供零信任裸金属隔离与软件定义基础设施控制。Hot Chips 演示为 DPU 可见全部 CX9 流量；现场记录认为管理链路类似 PCIe。公开材料中的「7 Tb/s 平台级 DPU」指 800G 本卡加上对四张 1.6T CX9 的策略覆盖，并非 BF-4 具备 7T 网络端口。

### 4.3 DOCA 服务

| 模块 | 作用 | 主要路径 |
|---|---|---|
| HBN | 主机侧 L3；BF-4 可作为 BGP 路由器 | Scale-in 接入 |
| Flow | 硬件包处理流水线：分类、ACL | Scale-in 数据面 |
| OVS-DOCA | 东西向接口应用同一策略 | Scale-out，配合 Astra |
| Argus | 运行时威胁检测 | 安全 |
| Vault | 文件访问策略 | 安全 / 数据访问 |
| PCC | 可编程拥塞 | 接入与存储 |
| Telemetry | 设备与服务健康 | 运营（不依赖租户主机） |
| DPF | 将 DPU 作为 K8s 节点管理 | 控制面 |
| Astra | BF-4 与多张 CX9 的统一控制点 | 控制面 → Scale-out 执行 |
| Memos | KV 在计算节点与 CMX 节点间管理 | **CMX**，不属于 800G 接入路径 |

生产形态为容器化微服务。服务功能链使流量在 DPU 域内按序经过网络、安全、存储等服务，无需在主机上串联多级 vSwitch。

### 4.4 Spectrum-X 在 Scale-in 路径上的角色

Scale-in 未引入第三种专有交换总线。接入与外部存储仍由 Spectrum-X 承载：BF-4 在节点上处理服务，Spectrum-X 在工厂与外部之间转发。§1.2 所述 AR / CC / 性能隔离在此用于接入与存储流，而不是 NCCL collective。

存储路径相对货架以太网最高约 **1.45×** 吞吐。Hot Chips 按对象大小给出 5 GB **1.5×**、10 GB **1.4×**、50 GB **1.3×**。增益随对象增大而收窄，说明收益来自拥塞隔离与中小对象，而不是把物理口从 400G 线性外推到 800G。

Scale-in 与 Scale-out 是否共用同一 leaf 平面，官方未说明。Vera Rubin 同代交换机为 Spectrum-6。

---

## 5. 芯片：BlueField-4 DPU 与 STX

对外名称均为 BlueField-4，现场记录指出存在 Grace 版与 Vera 版之别，本文按角色分开。

### 5.1 BlueField-4 DPU（Scale-in）

| 项 | 公开口径 |
|---|---|
| 计算 | Grace，64× Neoverse V2，Hot Chips 约 1.7 GHz |
| 网络 | ConnectX-9 级，**800 Gb/s** Ethernet 或 InfiniBand，200G SerDes |
| 内存 | LPDDR5X，手册最多 128 GB；Hot Chips 约 275 GB/s |
| 主机 | PCIe Gen6 x16 |
| 部署 | PCIe 卡及项目定制形态；Vera Rubin 平台共设计 |
| 位置 | Rubin 计算托盘、Vera CPU 节点 |
| 职责 | 南北向接入、主机卸载、安全、管理、可观测、隔离 |

Hot Chips 存储微基准（Grace 版，不可与 STX 混用）：NVMe-oF **8 核约 1.6 Tb/s**，**16 核约 2000 万 IOPS**，相对无 DPU 路径宣传约 2× 的数据到达 GPU 速度。1.6 Tb/s 是协议卸载能力，不表示 800G 端口变为 1.6T。

Vera CPU 节点同样配置 Scale-in：智能体的工具调用、检索与校验运行在 Vera 上，若基础设施占用主机核，将增加推理环路中 CPU 段的抖动。

### 5.2 Vera BlueField-4 STX（CMX）

- Vera CPU + ConnectX-9 SuperNIC
- Spectrum-X 最高约 **1.6 Tb/s**
- 加速 NVMe、数据搬移、硅上安全、DOCA
- 用于 CMX、AI 数据平台与工厂存储基础设施

Hot Chips Storage-Scale：两颗 Vera 版 BlueField-4，**3.2 Tb/s** 存储访问；DOCA Memos 宣传 10× IOPS、5× 效率。路径为 GPU HBM → 系统内存 → 本地或网络存储，属于工厂内上下文层。

CMX 产品页与 GTC 材料另给出相对传统存储约 5× TPS、更高能效、约 2× 摄入；与 Scale-in 的 1.45× 外部存储吞吐不是同一实验。

### 5.3 两条数据路径

```text
企业数据 / 训练数据 / 用户请求
        │  Scale-in：Spectrum-X + BF-4 DPU 800G
        ▼
   Rubin / Vera 计算  ── Scale-up NVLink / Scale-out CX9
        │  KV 超出 HBM 时
        ▼
   CMX：STX + DOCA Memos + Spectrum-X
```

官方表述：BlueField-4 既可作为 Scale-in 的基础设施处理器，也可作为 CMX 的存储处理器，二者职责不同。外部存储与 KV 共享的性能数字不可写入同一张表。

---

## 6. 五个官方用例

五个用例共享同一结构：服务运行于 DPU 域，执行位于 inline 引擎或 CX9，主机保留 AI 负载。

### 6.1 AI 工厂 VPC

多租户共享物理资源时，若南北向与东西向策略不一致，隔离不完整。仅在南北向 DPU 上划分 VRF，东西向 CX9 仍对租户可见；若将东西向回流 800G 做防火墙，则 6.4T 流量没有物理容量。

机制：HBN 在 BF-4 上加速南北向 L3 与租户隔离（可作为 BGP 路由器）；Flow 下发分类与 ACL；OVS-DOCA 将同一策略应用到东西向接口；Astra 再下发到 CX9。结果是 7.2 Tb/s 接口处于同一策略模型，东西向不经 800G 转发。运营侧集中开通 VPC，租户继续使用加速交换。

### 6.2 硅上安全（Scale-in security networking）

主机侧安全与负载同信任域；软件防火墙增加一跳；智能体反复访问数据、模型、工具与 KV，使攻击面位于推理路径上。

机制：执行点在硬件、位于租户操作系统之外。Argus 负责运行时检测，Vault 负责文件策略，Flow 负责网络线速策略。Astra 在南北向与东西向之间同步加密、隔离、密钥与遥测。租户软件无法关闭上述控制；主机 CPU 不承担安全过滤。

Argus 的具体观测语义（系统调用、eBPF 或包级）未公开。

### 6.3 外部存储接入

NVLink 解决 GPU 之间的权重与激活搬运，不把企业对象存储搬入 HBM。训练数据、模型资产、企业知识与应用数据走 Scale-in。

机制：BF-4 卸载 NVMe-oF、文件与对象（RDMA 与 TCP）、存储虚拟化与数据搬移；主机可继续看到标准网卡或存储设备模型（VirtIO、DOCA SNAP 一类）。Spectrum-X 在该路径上提供拥塞管理与流隔离。公开数字见 §4.4。KV 共享走 CMX，不走这条 1.45× 口径。

南北向 800G 相对东西向 6.4T 为 8:1。平台侧的处理方式是：KV 尽量留在 CMX；外部存储依赖 Spectrum-X 提高有效带宽；不将 Scale-in 口做成与 Scale-out 对等。若智能体把大量中间状态当作外部对象往返传输，800G 仍可能成为瓶颈。

### 6.4 控制面

节点需在运行负载前完成网络、存储与策略开通。传统顺序是主机操作系统启动后再下发策略，裸金属多租户在此窗口内处于无策略状态。

Scale-in 将顺序倒置：DPU 先于主机可用，策略先行，再通过网络启动主机操作系统。DPF 将 DPU 作为 Kubernetes 节点管理发现、开通、服务部署与滚动升级。策略在租户软件启动前生效；主机 CPU 不承担管控。这也解释了为何 Vera Rubin 将 DPU 纳入共设计，而不是保持为可选加速卡。

### 6.5 可观测性

租户可以停止主机侧采集进程或提供不准确的指标。DOCA Telemetry 从 BlueField-4 采集网络、存储访问、服务健康与利用率，导出到监控平台，并允许 ISV 接入同一信号。视野可延伸到 GPU 与网络利用率，用于区分接入拥塞、东西向拥塞、存储等待、策略开销或作业放置问题。观测点位于租户操作系统之外。

---

## 7. 影响与边界

### 7.1 网络产品从单一种类扩展为多种系统

黄仁勋在 FY2027 Q2 电话会中：Hopper 时期大约为 GPU 加 InfiniBand；Vera Rubin 需要 CPU 以及多种网络才能覆盖数据中心，再加上 Scale-in security networking 与 Scale-across，可视为 **五种网络系统**。每 GW 收入机会被表述为约 **400 亿美元**。Scale-in 在该叙事中与 NVLink、Spectrum 同级，而不是附件。

Spectrum-X 本身已是可售的 Scale-out 以太网平台（相对货架以太网约 1.6×、十万卡级约 95% 有效带宽）。Scale-in 把它延伸到接入、存储与安全运营，并绑定 BlueField-4。

### 7.2 DPU 成为平台信任前端

Hot Chips：云 DPU 是通用计算的可替换插卡；BlueField-4 共设计进入每个 Vera Rubin 系统。云与 neocloud 可按「策略在 DPU、负载在 GPU」提供裸金属多租户。自建工厂的南北向安全不再主要依赖主机进程。

### 7.3 基础设施进入推理指标

共设计博客：基础设施不再仅邻接推理，而是推理流水线的一段。tokens/MW、TTFT、P99 将部分取决于 800G 接入是否拥塞、存储卸载是否足够、CX9 上策略是否线速执行、以及 KV 是否由 CMX 复用。Scale-in 是 NVIDIA 将这些因素纳入自家平台的方式。

### 7.4 与自研 ASIC 工厂的对照维度

不宜比较「前端端口谁更大」。更有效的维度：

- 策略执行点是否在租户操作系统之外；
- 东西向是否纳入同一控制点（Astra）；
- 存储协议是否从主机卸载；
- 前端与多 Tb/s Scale-out 是否刻意保持非对称，以及 KV 是否另有一层（CMX）。

### 7.5 争议与需单独标注的口径

- **命名。** SDxCentral 认为第五支柱是南北向 DPU 的重新包装。南北向需要加速并非新命题。相对可选 DPU 插卡，可核对的增量是：Vera Rubin 标配、Astra 将信任域扩展到 CX9、以及与 CMX / STX 的分工。
- **800G 容量。** 与东西向 8:1。智能体若将检索与存储大量打到前端，800G 将先于 Scale-out 饱和。平台对策是 Spectrum-X 优化存储路径、KV 留在 CMX，而不是把 800G 做成 6.4T。
- **「7 Tb/s 平台级 DPU」。** 指策略覆盖范围，不是 BF-4 的网络端口速率。演示含义是可见 CX9 流量，不是全部流量穿过 DPU。
- **同名 SKU。** DPU 为 Grace + 800G；STX 为 Vera + 最高 1.6T。对外表述需加后缀。

---

## 8. 未公开项

- BlueField-4 DPU 整卡 TDP；1.7 GHz 是否适用于全部 SKU。
- 每个 NVL72 托盘是否固定一张 BF-4；Astra 连接 CX9 的物理介质（现场记录为可能的 PCIe）。
- 1.45× / 2× / 10× / 1.6× / 5× TPS 等数字的对照基线、IO 模型及是否包含 GPU 直通。
- DOCA 服务链的强制顺序；Argus 检测语义。
- Scale-in 与 Scale-out 是否共用 Spectrum-X leaf。
- 在非 Rubin 服务器上以 PCIe 卡形式安装 BF-4 时，Astra 对第三方网卡是否生效。

---

## 9. 来源

**Scale-in 与 BlueField-4**

- NVIDIA Technical Blog，[BlueField-4 Powers New Scale-In Network Infrastructure](https://developer.nvidia.com/blog/nvidia-bluefield-4-powers-new-scale-in-network-infrastructure-for-agentic-ai-factories/)（2026-08-24）；[中文](https://developer.nvidia.cn/blog/nvidia-bluefield-4-powers-new-scale-in-network-infrastructure-for-agentic-ai-factories/)
- NVIDIA Technical Blog，[Scaling Agentic AI Factories Through Extreme Co-Design with NVIDIA BlueField](https://developer.nvidia.com/blog/scaling-agentic-ai-factories-through-extreme-co-design-with-nvidia-bluefield/)
- Hot Chips 2026 BlueField-4，[ServeTheHome 现场记录](https://www.servethehome.com/nvidia-bluefield-4-processor-at-hot-chips-2026/)
- NVIDIA，[BlueField-4 DPU 数据手册](https://resources.nvidia.com/en-us-accelerated-networking-resource-library/bluefield-4-dpu-datasheet)
- Gilad Shainer / Hot Interconnects 架构表述，[Converge Digest](https://convergedigest.com/hot-interconnects-nvidia-gilad-shainer-gigascale-ai-factory-network-architecture/)
- NVIDIA FY2027 Q2 财报电话会，黄仁勋 Q&A
- [Converge Digest：第五支柱综述](https://convergedigest.com/nvidia-bluefield-4-scale-in-ai-factory-networking/)；[SDxCentral 质疑](https://www.sdxcentral.com/news/scale-in-nvidias-fifth-pillar-of-ai-networking-rests-on-shaky-ground/)

**Spectrum-X / SuperNIC / Scale-across**

- NVIDIA，[Spectrum-X Ethernet 平台](https://www.nvidia.com/en-us/networking/spectrumx/)；[Spectrum Ethernet 产品页](https://www.nvidia.com/en-us/networking/products/ethernet/)；[Spectrum-X 数据手册](https://resources.nvidia.com/en-us-networking-ai/networking-ethernet-1)
- NVIDIA Technical Blog，[Giga-Scale AI and the Ethernet Evolution](https://developer.nvidia.com/blog/giga-scale-ai-ethernet-evolution-spectrum-x-ethernet-rewrites-rules/)（AR / CC / PLB）
- NVIDIA Technical Blog，[Optimize Large-Scale AI Workloads with NVIDIA Spectrum-X](https://developer.nvidia.com/blog/optimize-large-scale-ai-workloads-with-nvidia-spectrum-x/)（AR 导致乱序；SuperNIC 重排并对应用透明；Israel-1 约 1.6×）
- NVIDIA，[Spectrum-X Ethernet Network Platform Architecture 白皮书](https://resources.nvidia.com/en-us-networking-ai/nvidia-spectrum-x)（DDP 逐步说明；有效带宽约 60% → 95%）
- NVIDIA Technical Blog，[Scale-Across Networking / Spectrum-XGS](https://developer.nvidia.com/blog/how-to-connect-distributed-data-centers-into-large-ai-factories-with-scale-across-networking/)；[投资者新闻稿 2025-08-22](https://investor.nvidia.com/news/press-release-details/2025/NVIDIA-Introduces-Spectrum-XGS-Ethernet-to-Connect-Distributed-Data-Centers-Into-Giga-Scale-AI-Super-Factories/default.aspx)
- NVIDIA Blog，[Spectrum-6](https://blogs.nvidia.com/blog/nvidia-spectrum-six-arrives-in-gigascale-ai-factories/)；[Spectrum-6 ASIC 数据手册](https://resources.nvidia.com/en-us-accelerated-networking-resource-library/ethernet-datasheet-spectrum-6-asic)
- NVIDIA，[Ethernet SuperNIC](https://www.nvidia.com/en-us/networking/products/ethernet/supernic/)（ConnectX-9 1.6 Tb/s）；[Spectrum-X NIC 配置](https://docs.nvidia.com/networking/display/kubernetes2670/spectrum-x/spectrum-x-configuration.html)（CX8/CX9 硬件 PLB）
- NVIDIA 产品页列出的 Spectrum-X Ethernet for Storage 白皮书（存储路径自适应路由最高约 1.6× I/O）
- Khashab et al.，[High-speed Networking for Giga-Scale AI Factories](https://arxiv.org/abs/2605.21187)

**DOCA / CMX / STX**

- NVIDIA，[DOCA](https://www.nvidia.com/en-us/networking/products/software/doca/)
- NVIDIA Technical Blog，[CMX Context Memory Storage](https://developer.nvidia.com/blog/introducing-nvidia-bluefield-4-powered-inference-context-memory-storage-platform-for-the-next-frontier-of-ai/)
- NVIDIA，[CMX 产品页](https://www.nvidia.com/en-us/data-center/ai-storage/cmx/)
- [Converge Digest：BlueField-4 STX](https://convergedigest.com/nvidia-bluefield-4-stx-redefines-ai/)

数字均为 2026-08/09 前后公开口径。BlueField-3 至 BlueField-4 的内存倍数在两篇官方博客中不一致，正文已分开标注。
