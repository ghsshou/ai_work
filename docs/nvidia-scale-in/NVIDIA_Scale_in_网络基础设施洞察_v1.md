# NVIDIA Scale-in 网络基础设施洞察（v1）

> **版本：** v1（归档，24 页）。现行修订见 [v2](./NVIDIA_Scale_in_网络基础设施洞察_v2.md)。  
> **用途：** 把 2026-08 连续三天的公开口径钉成一张可对照的工程图：Scale-in 是什么、相对旧前端网络变了什么、原理怎么走、芯片和软件各干什么、对 AI 工厂意味着什么。  
> **日期：** 2026-09-09  
> **口径窗口：** 2026-08-24 NVIDIA Technical Blog；2026-08-25 Hot Chips / Networking 公开表述；2026-08-26 FY2027 Q2 财报电话会。未公布的数字会标明。  
> **配套 PPT：** [`NVIDIA_Scale_in_网络基础设施洞察_v1.pptx`](./NVIDIA_Scale_in_网络基础设施洞察_v1.pptx)

---

## 一句话结论

**Scale-in 不是第六种 GPU 互连，而是把过去叫「前端网络 / 南北向网络」的那一层，做成 AI 工厂里独立加速、独立于租户主机的基础设施域。**

它解决的问题不是「GPU 之间怎么连」，而是：Scale-up / Scale-out 把算力面扩到每托盘数 Tb/s 之后，**用户、Agent、企业数据、外部存储、管控和安全** 还跑在通用宿主机 CPU 上，会先把 GPU 饿死，也会让多租户隔离停在租户 OS 里、可被绕过。

三天口径其实在说同一件事：

| 时间 | 谁 | 工程含义 |
|---|---|---|
| 2026-08-24 | NVIDIA 技术博客 | Scale-in 是 NVIDIA AI 网络 **第五支柱**：给智能体工厂做安全、管理、运营的专用加速 |
| 2026-08-25 | Gilad Shainer / Hot Chips BlueField-4 | **Scale-in 取代过去所谓的前端网络**（世界 ↔ AI 工厂，南北向进出）；现场宣布 BlueField-4 + Spectrum-X Scale-in 网络 |
| 2026-08-26 | 黄仁勋 FY2027 Q2 电话会 | 第一次把 **Scale-in security networking** 和 scale-up / scale-out / scale-across 并列，用来解释每 GW 收入盘从「GPU + 一种网」扩到「五种网络系统」 |

硬件落点是 **BlueField-4 DPU + DOCA + Spectrum-X**。和它容易混的 **Vera BlueField-4 STX** 是同一家族的 **存储处理器**，给 CMX / AI-native 存储用，不是计算托盘上那张 800G 接入卡。

---

## 1. 名字为什么容易读错

「Scale-in」听起来像 Scale-up 的反向，或像把集群往回收。公开材料里它指的是 **工厂边界向内看的接入域**：流量从世界进入 AI 工厂、再落到某一台加速器或 CPU。

| 口头习惯 | NVIDIA 现在的叫法 | 典型流量 |
|---|---|---|
| 前端网、南北向、N-S、frontend | **Scale-in** | 用户请求、Agent 调工具、企业检索、外部存储、开户、遥测、管理 |
| 后端网、东西向、E-W、算力面 | **Scale-out** | 训练/推理 collective、租户 workload、机架间 GPU 通信 |
| 柜内 NVLink | **Scale-up** | 同一超节点里 GPU 当一台用 |
| 跨园区 / 多校园 | **Scale-across** | Spectrum-XGS，工厂和工厂之间 |
| KV / 推理上下文存储 | **CMX（Context Memory）** | 工厂内可共享的 KV cache，不是企业 NAS |

Gilad 的那句「Scale-in 取代前端网络」是定位句，不是说以太网消失了。南北向物理上还是以太网（Spectrum-X），变的是：**谁处理、谁执行策略、还能不能占用宿主机。**

黄仁勋加的限定词是 **security**。Scale-in 被单独拎出来卖的，不只是带宽，而是 **把安全与管控从租户主机里拔出来，做到硅上、线速、主机无关。**

---

## 2. 五支柱：各自解决什么、不解决什么

NVIDIA 把 AI 工厂网络写成五根柱子。前三根扩算力连接，第四根扩推理上下文，第五根管「算力周围的基础设施」。

| 支柱 | 产品 | 连接谁 | 不解决什么 |
|---|---|---|---|
| **Scale-up** | NVLink / NVLink Switch | 柜内 GPU↔GPU，相干加速器 | 用户怎么进来；企业数据怎么来 |
| **Scale-out** | Spectrum-X Ethernet 或 Quantum InfiniBand + **ConnectX-9 SuperNIC** | 工厂内服务器↔服务器，租户算力面 | 南北向接入、存储协议、租户外安全 |
| **Scale-across** | Spectrum-XGS Ethernet | 分布式工厂 / 多校园 | 单工厂内部的接入与安全 |
| **Context Memory** | **CMX**，底座是 STX 模块化存储 | 工厂内共享 KV cache、可复用推理状态 | 训练数据湖、企业知识库（那是 Scale-in 的存储路径） |
| **Scale-in** | **BlueField-4 + DOCA + Spectrum-X** | 世界↔工厂：用户、应用、数据源、外部存储、云服务、安全与运营 | GPU 集体通信本身（那是 CX9 的 scale-out） |

博客原话大意：只把 GPU、机架、数据中心做大，如果数据访问、存储、网络安全和运营跟不上，扩出来的算力变不成工厂吞吐。

和 Jalapeño 对照（点到为止）：OpenAI 那套里，Katsu 主机托盘上的 **400G = 2×200G** 才是真正的前端网卡，scale-up 走 XPU SerDes + Tomahawk。NVIDIA 现在把「那张前端网」升级成 **每计算托盘一张 800G BlueField-4**，并且用 Astra 把策略伸到 scale-out 的 CX9 上——前端不再是一张普通 NIC。

---

## 3. 概念：旧前端网络缺的不是端口，是处理域

### 3.1 传统云南北向怎么做

传统数据中心的南北向按 **软件定义、可组合、弹性** 来建：接入交换机 + 主机 vSwitch / SDN + 宿主机上的存储协议栈、防火墙、遥测 agent。资源可以按需开通，安全策略主要在主机 OS 或旁边的设备里。

这对「可预期的通用负载、标准接口」够用。Agentic AI 工厂不够用，原因不是交换机 radix 忽然不够，而是 **负载形态变了**：

1. **一次请求不再是一次推理。** 一次 Agent 调用会触发多次模型调用、工具调用、记忆查找、策略检查、存储访问和网络传输。基础设施数据路径变成推理流水线的一部分，而不是推理旁边的管道。
2. **每服务器带宽从百 G 级到多 Tb/s。** Vera Rubin 计算托盘聚合约 **7.2 Tb/s** 接口：800G 南北向 + 四条 1.6T 东西向。线速加密、存储协议、ACL 不能再指望主机 CPU。
3. **多租户 + 裸金属。** 共享 AI 工厂要把隔离做到租户 OS 够不着的地方。主机里的 iptables / 软件防火墙和租户同一信任域，主机被突破就等于策略被关。
4. **GPU 会等数据。** Scale-up / Scale-out 再快，NVMe-oF、文件/对象、检索数据如果在主机上排队，GPU 照样空转。

博客的判断：SDN、可组合、弹性 **仍然必要，但不再充分**。安全、多租户网络、数据/存储访问、基础设施运营不能只靠通用宿主机上的软件，也不能继续作为互不相干的一层。它们必须合成 **一个统一的、被加速的基础设施域**。

### 3.2 Scale-in 相对旧前端的三处变化

| | 旧前端 / 云 DPU 可选插卡 | Scale-in（Vera Rubin 标配） |
|---|---|---|
| **位置** | 主机 PCIe 槽里的一张网卡或可选 DPU | 和 Rubin **共设计进每一台系统**，Hot Chips 原话：不再是事后插一张卡 |
| **处理** | 策略和协议多半在宿主机 CPU 或轻量 Arm 核 | **主机无关**：64 核 Grace 跑控制面，inline 引擎跑数据面，工作不回主机 |
| **信任域** | 南北向可以走 DPU；东西向 CX/NIC 往往仍在租户侧 | **Astra**：BF-4 定策略、采遥测，CX9 在 scale-out 数据面 **原地执行**；东西向不必回流 800G DPU |
| **带宽量级** | Hot Chips 对比：云 DPU 约 200G 级 | AI-native：单卡 800G Scale-in，托盘级宣称 **7 Tb/s 平台级 DPU 视野**（含 CX9） |
| **软件** | 各家 agent、vSwitch、存储驱动分散 | **DOCA** 微服务 + SFC：网络、安全、存储、遥测同一套编排 |

变化的核心不是「多了一根叫 Scale-in 的网线」，而是 **基础设施有了自己的 CPU、内存、加速器和操作系统（DOCA），和租户 CPU/GPU 分开。**

---

## 4. 原理：控制面在 DPU，数据面就近执行

### 4.1 两段处理，不要合成一段

BlueField-4 的处理模型是：

```text
软件（Grace 上的 DOCA）     做决定：策略、开户、编排、遥测汇聚
inline 加速引擎            就地执行：包、RDMA、存储协议、加密、防火墙、策略
两者都不把工作交回主机 CPU
```

博客表 1 把硅拆成五块，对应这条路径：

| 部件 | 干什么 | 为什么需要 |
|---|---|---|
| **64 核 Grace CPU** | 策略、开通、遥测、基础设施编排 | 相对上代约 **6× 算力**，才能并发跑多路基础设施服务 |
| **Inline 加速引擎** | 包 / RDMA / 存储协议 / 加密 / 防火墙 / 策略 | 最高 **800 Gb/s** 线速，减轻 Grace 和主机 |
| **LPDDR5X** | 给基础设施软件送数据和状态 | 高带宽、偏省电；策略表、队列、遥测、元数据要离数据近。Hot Chips：**~275 GB/s**；数据手册 **最多 128 GB** |
| **PCIe Gen6 主机口** | 连主机 | 主机与 Scale-in 处理域之间的宽通道 |
| **800 Gb/s 网络口** | 连 Scale-in 交换（Spectrum-X） | 接入、安全、数据搬移、存储流量 |

相对 BlueField-3（16× Cortex-A78、400G、PCIe Gen5、约 16–32 GB DDR5）：网络 **2×**（400G→800G）。内存口径两篇官方博客略有出入——Scale-in 博文写带宽 **4×**；共设计博文写容量 **4×**、带宽 **>3×**。对外转述时分开写，不要合成一个「4×」。

Hot Chips 补充：核频 **1.7 GHz**（比完整 Grace 服务器偏低，现场记录认为是功耗封顶）；200G PAM4 SerDes；inline 加密。

### 4.2 流量必须分流，800G 不是托盘总带宽

Vera Rubin **每个计算托盘**：

```text
约 7.2 Tb/s 聚合接口
  ├─ Scale-in   1 × 800 Gb/s    BlueField-4     南北向：请求、存储、管控、安全
  └─ Scale-out  4 × 1.6 Tb/s    ConnectX-9      东西向：租户 workload / collective
```

这是整套原理里最容易写错的数字：

- **租户训练/推理包走 CX9，不走 BF-4 的 800G。** 若 7.2T 全挤进 800G，Scale-out 先把自己堵死。
- **800G 是接入/存储/管控专用。** 用户请求、外部存储、开户、遥测走这里。
- **Astra 不是把东西向流量拽回 DPU。** 它把 **策略、密钥、隔离、遥测** 从 BF-4 推到 CX9，在 1.6T 口上执行。博客原话：同一套 VPC 策略覆盖接入和 Scale-out，**不必把所有东西向流量经 800G 口转发。**

Hot Chips 对比「传统做法」：

1. **安全不完整：** 没有 DPU 拥有整条数据路径时，南北向可以隔离，scale-out 隔离不住；GPU 网络无法端到端与租户切断。
2. **功耗约 4×：** 每张 NIC 若自带一套 CPU/内存/管理，相对「BF-4 挡在主机前面、管所有 CX9」更费电。

Astra 的闭环：

```text
运营者 / DOCA DPF
        │  开通、策略、密钥
        ▼
   BlueField-4（信任控制点，在租户 OS 外）
        │  安装/更新策略、采集遥测
        ├──────────────────────────────► 本卡 800G 数据面（Scale-in）
        │                                 inline 引擎线速执行
        └─ Astra ──────────────────────► ConnectX-9 数据面（Scale-out）
                                         策略在 1.6T 口原地执行
                                         东西向流量不回流 DPU
```

数据手册把这套叫 **ASTRA（Advanced Secure Trusted Resource Architecture）**：在选定的 Rubin 平台上，配合 CX9，做零信任裸金属隔离和软件定义基础设施控制。

### 4.3 软件：DOCA 把加速器变成可编排服务

硬件加速器不会自动变成「基础设施域」。DOCA 提供：

- 可直接跑在 BF-4 上的 **容器化微服务**
- 给自研服务用的库 / SDK
- **原生服务功能链（SFC）**：一条流按顺序穿过网络→安全→存储等服务，不必在主机上串多跳 vSwitch

和 Scale-in 直接相关的模块：

| 模块 | 作用 |
|---|---|
| **DOCA HBN** | 主机侧 L3 路由；BF-4 可当 BGP 路由器，做多租户南北向 |
| **DOCA Flow** | 编程硬件包处理流水线：分类、ACL、线速执行 |
| **OVS-DOCA** | 东西向接口上套同一套策略 |
| **DOCA Argus** | 运行时威胁检测 |
| **DOCA Vault** | 文件访问策略 |
| **DOCA PCC** | 可编程拥塞 |
| **DOCA Telemetry** | 设备与服务健康，不依赖租户主机 |
| **DOCA DPF** | K8s 原生：把 DPU 当节点来发现、开通、部署、升级 |
| **BlueField Astra** | 跨 BF-4 与多张 CX9 的统一控制点 |
| **DOCA Memos** | KV cache 在计算节点和存储节点间管理/共享——主要服务 **CMX**，不要算进「800G 接入」 |

### 4.4 Spectrum-X 在 Scale-in 路径上干什么

Scale-in 的交换不是另做一张专有总线，而是 **Spectrum-X Ethernet** 扛接入和外部存储。BF-4 在每台机器上处理服务，Spectrum-X 在工厂和外部之间搬流量。公开能力：负载均衡冲突与拥塞处理、提高有效带宽、并发流隔离，让接入和存储更可预期。存储路径相对普通以太网最高约 **1.45×** 吞吐（Hot Chips 按文件大小给过 5 GB **1.5×**、10 GB **1.4×**、50 GB **1.3×**）。Vera Rubin 同代交换是 **Spectrum-6**。

---

## 5. 芯片产品：一张谱，两种角色

NVIDIA 对外都叫 BlueField-4，现场记录也抱怨过该拆成 Grace 版 / Vera 版。洞察里必须拆开。

### 5.1 BlueField-4 DPU（Scale-in 的那张）

- **计算：** Grace，64× Arm Neoverse V2 @ 约 1.7 GHz（Hot Chips）
- **网络：** ConnectX-9 级，**800 Gb/s** Ethernet 或 InfiniBand，200G SerDes
- **内存：** LPDDR5X，数据手册最多 **128 GB**；Hot Chips 带宽 **~275 GB/s**
- **主机：** PCIe Gen6 x16
- **形态：** PCIe 卡 + NVIDIA 项目定制形态；Vera Rubin **每系统共设计进去**
- **放哪：** GPU 计算托盘（Rubin）和 Vera CPU 节点的基础设施处理器
- **干什么：** 前端/南北向、主机卸载、安全数据访问、管理、可观测、隔离

Hot Chips 存储微基准（Grace 版 BF-4，不要和 STX 混）：NVMe-oF **8 核到 1.6 Tb/s**，**16 核到 2000 万 IOPS**，宣传相对「无 DPU 路径」约 2× 数据到达 GPU 的速度。

### 5.2 Vera BlueField-4 STX（CMX 的存储处理器）

共设计博客：

- **Vera CPU + ConnectX-9 SuperNIC**
- Spectrum-X 最高 **1.6 Tb/s**
- 加速 NVMe、数据搬移、硅上安全、DOCA
- 给 **CMX 上下文存储、AI 数据平台、工厂存储基础设施**

Hot Chips「Storage-Scale」：两颗 Vera 版 BlueField-4，**3.2 Tb/s** 存储访问，DOCA Memos，宣传 10× IOPS、5× 效率；KV 从 GPU HBM → 系统内存 → 本地/网络存储。这是 **工厂内上下文存储路径**，不是南北向 800G。

### 5.3 同一颗硅家族，两条数据路径

```text
企业数据 / 训练数据 / 用户请求
        │  Scale-in（Spectrum-X + BF-4 DPU 800G）
        ▼
   Rubin / Vera 计算
        │  Scale-up NVLink / Scale-out CX9
        ▼
   KV cache 放不下 HBM 时
        │  CMX（STX 存储处理器 + DOCA Memos）
        ▼
   工厂内可共享的上下文层
```

博客写死：**BF-4 既是 Scale-in 的基础设施处理器，又可以是 CMX 的数据/存储处理器，但是两件事。** Scale-in 把工厂数据和外部企业数据接到算力上；CMX 保存并共享上下文，让推理更快。不要把 1.45× 外部存储和 10× CMX IOPS 写进同一张「Scale-in 性能」表。

---

## 6. 五个官方用例：机制，不只是口号

### 6.1 隔离的 AI 工厂 VPC

- **问题：** 多租户共享物理底盘，南北向和东西向若用两套策略，必然漏。
- **机制：** HBN 在 BF-4 上加速南北向 L3 和租户隔离；Flow 编程分类/ACL；OVS-DOCA 把同一策略落到东西向口；Astra 再铺到 CX9。
- **结果：** 7.2 Tb/s 接口都在同一策略模型下，东西向不回流 800G。运营者中心化开 VPC，租户继续走加速交换。

### 6.2 硅上执行安全（黄仁勋说的 Scale-in security）

- **问题：** 主机侧安全与负载同信任域；软件防火墙加一跳；Agent 反复摸数据、模型、工具、KV，攻击面在推理路径上。
- **机制：** 执行点在硬件、在租户 OS 外。Argus 运行时检测，Vault 管文件，Flow 管网络线速。Astra 同步南北向和东西向的加密、隔离、密钥、遥测。
- **结果：** 租户软件关不掉这些控制；主机 CPU 不做安全过滤；共享 AI 服务有一致保护。

### 6.3 加速存储接入（外部数据，不是 CMX）

- **问题：** 存储协议、虚拟化、数据搬移跟不上，GPU 有算力也有 NVLink 仍在等数据。
- **机制：** BF-4 卸载 NVMe-oF、文件/对象（RDMA 和 TCP）、存储虚拟化、搬移；Spectrum-X 做拥塞管理和流隔离。
- **数字：** 相对货架以太网最高 **1.45×** 存储吞吐；Hot Chips 按对象大小 1.5 / 1.4 / 1.3×。
- **边界：** 这条路径接训练数据、模型资产、企业知识、应用数据。KV 共享走 CMX。

### 6.4 控制面：主机起来之前先开策略

- **问题：** 节点要先开通网络和存储、装好策略，才能跑 AI；若控制面在主机上，主机没起来或被租户控制时，工厂无法自举。
- **机制：** BF-4 独立于主机：发现节点、开通网和存储、网络启动主机 OS。**DPF** 把 DPU 当 K8s 节点管理：发现、开通、服务部署、升级。
- **结果：** 策略在租户软件启动前就位；部署更短、配置更一致、主机 CPU 不做管控。

### 6.5 可观测：不看租户的脸

- **问题：** 租户可以关 agent、假报指标；工厂级排障需要网络、存储、服务健康、利用率。
- **机制：** Telemetry 从 BF-4 采，导出到监控平台；库给 ISV 接同一路信号。视野可延伸到 GPU 和网络利用率。
- **结果：** 接入、流量、存储、策略、放置哪一段卡住，可以在租户之外定位。

五个用例共用一个原理：**服务跑在 DPU 域，执行在 inline / CX9，主机只保留 AI 负载。**

---

## 7. 对未来的影响

### 7.1 网络从「一种」变成「五种」，每 GW 收入盘变大

黄仁勋在 FY2027 Q2：Hopper 时代大约是 GPU + InfiniBand；Vera Rubin 要 CPU、三种以上网络，才能覆盖数据中心，**再加上 Scale-in security networking 和 Scale-across 多校园**，「可以说五种网络系统」，每 GW 收入机会讲到约 **400 亿美元**。Scale-in 被放进这个叙事，说明 NVIDIA 不把 DPU 当附件，而当 **和 NVLink、Spectrum 同级的可售系统**。

### 7.2 DPU 从可选卡变成工厂信任前端

Hot Chips：云 DPU 是通用计算的可替换插卡；Agentic 需要 AI-native 基础设施，BF-4 **共设计进每个 Vera Rubin 系统**。对 CSP / neocloud：裸金属多租户可以按「策略在 DPU、负载在 GPU」卖；对自建工厂：南北向安全不再是另招一队人在主机里堆 agent。

### 7.3 基础设施被算进推理 SLA

共设计博客把这句话写死：基础设施不再邻接推理，**就是推理流水线的一段。** 以后比 tokens/MW、TTFT、P99，会有一部分分数来自：前端 800G 有没有堵、存储卸载够不够、策略有没有在 CX9 上线速执行、KV 有没有走 CMX 而不是重算。Scale-in 是 NVIDIA 把这些分数收进自家平台的方式。

### 7.4 和自研 ASIC 工厂怎么对

Jalapeño 一类 captive 推理工厂：前端仍是主机上的普通 400G 网卡，scale-up 自己做。NVIDIA 的 Scale-in 是把前端做成 **可编程 DPU 操作系统**。对标时不要比「谁的前端端口更大」，要比：

- 策略是否在租户 OS 外；
- 东西向是否也被同一控制点管住（Astra vs 只管南北向）；
- 存储协议是否从主机卸载；
- 前端带宽是否和单机多 Tb/s scale-out 匹配（800G vs 6.4T+ 东西向，本身就是刻意的非对称）。

### 7.5 争议和边界（写进去才完整）

- **命名换皮：** SDxCentral 认为第五支柱是南北向 DPU 的重打包。工程上「南北向要加速」不是新发明；**真增量**是 Vera Rubin 标配、Astra 把信任域扩到 CX9、以及和 CMX/STX 的分工。
- **800G 会不会成为南北向瓶颈：** 托盘东西向 6.4T、南北向 800G，是 8:1。Agent 若大量把检索/存储打到前端，800G 会先满。NVIDIA 的答案是存储走 Spectrum-X 优化路径、KV 尽量留 CMX，而不是把 800G 做成 6.4T。
- **「7 Tb/s 平台级 DPU」容易被读成 BF-4 有 7T 口。** 实际是 800G 本卡 + Astra 视野覆盖四张 1.6T CX9。演示是「DPU 能看见所有 CX9 上的流量」，不是「所有流量穿过 DPU」。
- **SKU 同名：** BlueField-4 既指 Grace+800G DPU，也指 Vera+多 CX9 的 STX。对外沟通必须加「DPU / STX」。

---

## 8. 未公开 / 不要写死

- BF-4 DPU 整卡 TDP、1.7 GHz 是否全 SKU。
- 每 NVL72 托盘是否严格一张 BF-4、Astra 连 CX9 的物理链路是 PCIe 还是专用管理网（现场记录「听起来像 PCIe」）。
- 1.45× / 2× / 10× 的对照基线、IO 模型和是否含 GPU 直通。
- DOCA 服务链的强制顺序、Argus 检测的语义（syscall？eBPF？）。
- Scale-in 交换是否与 scale-out 共平面、还是独立 leaf。
- 非 Rubin 服务器插 BF-4 PCIe 卡时，Astra 对第三方 NIC 管不管。

---

## 9. 来源

- NVIDIA Technical Blog，[BlueField-4 Powers New Scale-In Network Infrastructure](https://developer.nvidia.com/blog/nvidia-bluefield-4-powers-new-scale-in-network-infrastructure-for-agentic-ai-factories/)（2026-08-24）；中文：[developer.nvidia.cn 同文](https://developer.nvidia.cn/blog/nvidia-bluefield-4-powers-new-scale-in-network-infrastructure-for-agentic-ai-factories/)
- NVIDIA Technical Blog，[Scaling Agentic AI Factories Through Extreme Co-Design with NVIDIA BlueField](https://developer.nvidia.com/blog/scaling-agentic-ai-factories-through-extreme-co-design-with-nvidia-bluefield/)
- Hot Chips 2026 BlueField-4 演讲现场记录：[ServeTheHome](https://www.servethehome.com/nvidia-bluefield-4-processor-at-hot-chips-2026/)
- NVIDIA Networking / Gilad Shainer 公开架构表述（前端网络 → Scale-in）；Hot Interconnects 相关报道见 [Converge Digest](https://convergedigest.com/hot-interconnects-nvidia-gilad-shainer-gigascale-ai-factory-network-architecture/)
- NVIDIA FY2027 Q2 财报电话会，黄仁勋 Q&A：Scale-in security networking、五种网络系统、每 GW 收入盘
- NVIDIA，[BlueField-4 DPU 数据手册](https://resources.nvidia.com/en-us-accelerated-networking-resource-library/bluefield-4-dpu-datasheet)
- 转述与批评：[Converge Digest Scale-in 第五支柱](https://convergedigest.com/nvidia-bluefield-4-scale-in-ai-factory-networking/)；[SDxCentral 对「第五支柱」的质疑](https://www.sdxcentral.com/news/scale-in-nvidias-fifth-pillar-of-ai-networking-rests-on-shaky-ground/)

数字均为 2026-08/09 公开口径。BF-3→BF-4 的内存倍数两篇官方博客不完全相同，引用时分开标注。
