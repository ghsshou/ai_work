# OpenAI Jalapeño 芯片系统洞察

> **用途：** Hot Chips 2026 技术拆解，内部学习  
> **日期：** 2026-08-26  
> **配套 PPT：** [`OpenAI_Jalapeno_系统洞察.pptx`](./OpenAI_Jalapeno_系统洞察.pptx)（24 页）  
> **架构细节补充：** [`Jalapeno_架构细节_slice网络与Rubin对比.md`](./Jalapeno_架构细节_slice网络与Rubin对比.md)

---

## 一句话结论

Jalapeño 不是训练 GPU 的缩小版，而是 OpenAI 为 **LLM Serving** 从零做的第一颗推理 ASIC。它真正特别的地方，不是 13.4 PFLOPS 这张海报，而是三件事：

1. **少搬数据**：权重和 KV cache 明确放本地；
2. **同质机池**：故意不做 Prefill / Decode 分离；
3. **电力即吞吐**：在 MW 受限的机房里，先打 tokens / MW。

训练仍然外购 Nvidia / AMD / Cerebras。芯片不外卖。2026 年底小规模部署，2027 年才是放量。

---

## 1. 定位：它是什么，不是什么

| 是 | 不是 |
|---|---|
| OpenAI 第一颗 Intelligence Processor，多代平台 Gen-1 | 训练芯片 |
| 围绕自身模型、kernel、serving 系统和产品路线从零设计 | 对外售卖的商用加速卡 |
| Broadcom 做硅与 Tomahawk 网络，Celestica 做板卡机架 | 只为 OpenAI 模型固化的专用芯（官方强调可跑多种 LLM） |
| Captive silicon，服务 ChatGPT / API / Agent 流量 | 立刻量产的产品（Hot Chips 上是工程样片 / A0） |
| 2026 年底小规模、2027 放量 | 对 Nvidia 的全面替代 |

Hot Chips 演讲题目是 *You Can Just Build Things … Chips*，主讲 Richard Ho、Ravi Narayanaswami、Chris Leary。

**为什么现在做：**

- OpenAI 卡的是数据中心电力，不是预算。tokens / MW 直接等于收入。
- 在线推理已经是持续成本，训练只是一次性高峰。
- 通用 GPU 为训练 / CUDA / 兼容性付了固定延迟税，小 batch decode 最受伤。
- 全栈才能决定 KV 放哪、要不要 PD 分离、哪些延迟必须从硬件里删掉。
- Agent 流量的 I/O 比会持续漂移，固定拆分的异构机池会过时。

时间线（公开口径）：

- 2024 年中组队；OpenAI 称设计到 tape-out 约 9 个月；SemiAnalysis 记从招人到流片约 16 个月。
- 2025-11 CoWoS 流片（不只是顶层 die）。
- 2026-06 与 Broadcom 正式发布。
- 2026-08-25 Hot Chips 首次公开规格、功耗和跑分。
- 2026 年底极小规模部署，2027 年大部分产出。

---

## 2. 架构哲学

### 2.1 推理有三个瓶颈，不是一个

| 阶段 | 主要瓶颈 | Jalapeño 的对策 |
|---|---|---|
| Prefill | 算力 | MXFP 脉动阵列，且支持更小 shape，减少 tiling 掉崖 |
| Decode | HBM 带宽 | HBM4 15.4 TB/s，KV 留本地 |
| 通信 / 调度 | 固定延迟 | 删 barrier / launch 税，slice 间用可重叠的 collective |

OpenAI 原话大意：只擅长其中一个阶段的系统，会在等数据、搬模型状态时把优势输掉。

### 2.2 少搬数据，KV 留本地

核和 HBM 切成 **slice**：每个核低延迟直视自己那块 HBM。slice 之间走专用 collective 网络（典型用途：可与计算重叠的 tensor parallel）。另有通用 NoC 访问 scale-up。

这和 GPU 相反。GPU 访存穿过复杂内存层次，大延迟必须靠更大 shape / 更大 batch 摊销。Jalapeño 把层次压扁，目标是小 batch 也靠近峰值 FLOPS / 带宽。

权重和 KV 精心放置后，核间同步被限制在已知的高带宽通信上。

### 2.3 微架构要点

- **计算：** MXFP + weight-stationary 脉动阵列（像 TPU），但支持更小矩阵维。
- **标量 / 向量：** 64-bit 标量核 + FP32/INT32 向量核。所以能跑 Doom，也能较快搬新模型。
- **控制：** 乱序核 + L1，而不是多数加速器的软件 scratchpad。避开 barrier 固定开销，代价是更依赖预取。策略是：硬件给高上限，Codex 去找贴顶的 kernel。
- **I/O：** N3E I/O chiplet，32×800G SerDes；24 lane 本地 scale-up（600 GB/s），8 lane 全局（200 GB/s）；主机 PCIe Gen5。
- **冗余：** 托盘级冗余，核 / channel 级 yield harvesting。
- **AI 辅助设计：** SIMD 面积约 -8%，矩阵引擎面积约 -10%；B0 相对 A0 约 +25% perf/W。

### 2.4 最反直觉的决定：不做 PD 分离

GPU 上 Prefill / Decode 分离几乎是标配。Jalapeño 明确不用。

原因：

1. 生产流量的 I/O 比、cache hit、投机接受率会变。拆成两个池，就会一边排队、一边空转。
2. Prefill 产出的 KV 立刻被 Decode 需要。搬走它等于拆掉局部性，再买一次网络、同步、排队和故障域。
3. Draft 模型和主模型若再拆开，投机解码会变成分布式协议，把延迟优势吃掉。
4. 同质池里，某个阶段可能利用率不满，但每张卡都能接下一个请求。拆池后，整卡可能只因为「分错池」而空闲。

**对超节点路线的含义：** PD 分离在「流量稳定、必须靠很大 phase-specific batch 才能喂饱 GPU」时划算。一旦芯片本身就能在小 batch / 全曲线贴近 roofline，再拆池反而损失 KV 局部性。超节点应优先保证 KV 与 TP/EP 的高频域，而不是先把 P 和 D 在拓扑上切开。

---

## 3. 硅与系统

### 3.1 单芯片（B0 / 对外口径）

| 项目 | 数字 | 备注 |
|---|---|---|
| 峰值算力 | 13.4 PFLOPS MXFP4 | TSMC N3P 整幅计算 die |
| 内存 | 216 GB HBM4 | 约 6 堆 12-Hi，pin 速约 10 Gbps（可能三星） |
| 带宽 | 15.4 TB/s | 高于在役 HBM3E 加速器 |
| 功耗 | TDP 700 W，测试持续 ≤ 550 W | 不按训练卡去追峰值 TDP |
| 对照 | Rubin 计算 die 约 17.5 PF dense NVFP4 | 同节点，但 TDP 约 900–1150 W |

公开跑分来自 **A0**；B0 已在 fab。

### 3.2 机架与 Pod

| 层级 | 规模 | 关键数字 |
|---|---|---|
| 机架 | 128 卡 | 1.7 EFLOPS（4-bit）、27.5 TB HBM4、约 2 PB/s 带宽 |
| Pod | 2048 卡 = 16 机架 | 一个全局 scale-up 域 |
| 双柜功耗 | Host + ASIC | 生产约 31 kW + 130 kW ≈ 160 kW |

形态对标 NVL72 / Helios，不是单卡单打。公开对比称：相对 GB200/GB300，Jalapeño 机架内存带宽更高、峰值算力更低、功耗更克制。同代真正对手是 Rubin。

### 3.3 机架解剖

整柜菜谱式命名，Celestica 做系统：

- **Katsu（主机柜）：** 16 托盘，每盘 2× AMD EPYC Turin、1.5 TB DRAM、400G 前端网；8 根外部 PCIe DAC 横连对应 ASIC 托盘。
- **Vindaloo（ASIC 柜）：** 16 托盘 × 8 卡 = 128 Jalapeño；铜缆背板类似 Nvidia Oberon。
- **Chana（交换托盘）：** 6 个本地 + 2 个全局。本地各 1× Tomahawk 6 102.4T；全局托盘可能 2× TH6。

### 3.4 Scale-up 网络

- **Local：** 机架内 128 卡 all-to-all，每卡单向 4.8 Tb/s，6× 102.4T TH6；每柜约 6144 对无源铜差分。全程电，XPU 不出光。
- **Global：** 16 柜 / 2048 卡，每卡单向 1.6 Tb/s，8-rail、rail-only。路径是 `XPU → 本柜全局 TH6（铜）→ 面板 1.6T 光模块 → OCS → 对端同样的 TH6 → 对端 XPU（铜）`。光电在 **两端交换机面板**，不是光直插对端卡；rail-only 省的是第三级 spine，不是对端 leaf。

SemiAnalysis 的判断：scale-up 网络大约只占系统成本 10%，却买到未来 10–20T 参数 / 百万级上下文的期权。这和「超节点优先容纳高频并行组」是同一类判断。

下一步目标是 100 MW 级部署。瓶颈会从芯片转向制造、上架、监控和弹性。OpenAI 在和 neocloud 收集可靠性数据。

---

## 4. 软件栈

SemiAnalysis 的判断：硬件未必强过 Rubin，但软件 bring-up 明显更快。从零软件栈起步，硅上约 3 个月就能打公开基准。

| 层 | 作用 |
|---|---|
| **Gluon** | 基于 Triton 的 kernel 语言。保留 SPMD，暴露更低层抽象。核心是 Linear Layouts：用代数描述硬件资源与 tensor 元素的映射，可证明的 layout 变换和最优 swizzle。 |
| **Teacup** | 内部 serving 引擎。Persistent thread：程序员而不是硬件调度器分配 tile。 |
| **Gigakernel** | 单 mega-kernel 在设备上循环，砍 CPU launch 税。 |
| **Codex** | 内部加强版写 kernel。早期人在环，随后自动化。kernel 可到约 3000 行汇编级代码。InferenceX 上的 MLA kernel 甚至是无人介入写出的。 |
| **chilisim** | 仿真器，与硅误差约 5%。 |

可编程模型暗示 Jalapeño 适合 persistent kernel：每个程序跑多个 tile。核上有数据预取和解耦乱序单元。

速度样本：不到两周，某些交互性点位吞吐翻倍以上；8 天从 TP8 打到 TP32，扩到整柜大规模模型。演示包括 Doom 36 FPS、内部模型 Raiku / GPT-5.3-Codex-Spark 的 1.2 ms TPOT。

---

## 5. 成绩怎么读

Benchmark：SemiAnalysis InferenceX。模型：GPT-OSS-120B、DeepSeek R1、Kimi K2.5。对比主要是 Nvidia GB200 / GB300 NVL72。

公开宣称（需连口径一起读）：

- 峰值吞吐：1.5–1.9× 更多 AI work；
- 端到端延迟：1.7–3.6× 更低；
- 超低延迟档：2.1–4.1×；
- DeepSeek R1、concurrency=1：超过 700 tok/s/user；
- GPT-OSS：约 1400 tok/s/user；
- Kimi K2.5：接近 700 tok/s/user，在 100 tok/s/user 点位约 9× 次优芯片。

这些数字是 **STP、无 speculative decoding、无 PD 分离** 拿到的。对手常用 MTP 和 PDD。这让对比更干净，也让 Jalapeño 的数字偏保守。GSM8k 与 Nvidia 持平。

**必须打折的地方：**

1. 真正的同代对手是 Rubin（HBM4，已开始出货），不是 Blackwell。SA 认为 Jalapeño 的 STP tok/s/MW 仍能打过 Rubin 公开的 MTP 数字；tokens / $ 与 Rubin 接近。
2. 当前是 8k1k 单轮，没有 AgentX（多轮、长上下文、prefix cache、路由、KV offload）。
3. 模型不是开放前沿最大的那些。
4. 成绩来自 A0；量产爬坡在 2027。
5. 数字由 OpenAI 提供，SA 现场核对了部分，但未跑全套。
6. 一部分 TCO 优势来自 Broadcom 毛利低于 Nvidia，不只是微架构。投机解码若补上，SA 估还可再降 3–5× 每 token 成本。

---

## 6. 战略含义与风险

**对 OpenAI：** 产品、模型、芯片、内存多代共设计。Gen-2 深入开发，Gen-3 已启动。不外卖——内部算力都不够。

**对 Nvidia / AMD：** 训练盘仍稳。推理盘出现一个不卖卡、只服务自己流量的顶级客户自研芯。CUDA 若只靠生态惯性，会被「Codex 写 kernel + 干净架构」打薄。OpenAI 自己也说不会单押一家。

**对 ASIC 玩家：** Meta / Microsoft 做了更久却没做成，说明便宜不是充分条件。差异是真实 serving 负载、kernel 团队、以及用模型写代码。

**对超节点路线，可迁移三条：**

1. 高频域做大（128 本地 / 2048 全局）；
2. 优先保 KV 局部性，而不是先 PD 切开；
3. 用软件迭代速度，而不是一次把 ISA 做完美。

**风险：** 量产与 HBM4 / CoWoS / OCS 供应链；OoO+预取把上限交给软件，换模型能否稳定贴顶；Agent 负载未验证；与 Rubin 的同代窗口；没有外部客户帮着找软件 bug；训练仍外购。

---

## 带走五条

1. 这是 Serving 芯片，不是训练 GPU，也不外卖。
2. 局部性大于高峰 FLOPS：KV 和权重留本地，删固定延迟。
3. 同质机池是有意的：流量形状会变，拆池会牺牲 KV 局部性。
4. 软件速度是真护城河：9 个月流片、3 个月 bring-up、Codex 写 kernel。
5. 成绩很强，口径要保守：打赢 Blackwell 可信；对 Rubin 有方向性优势，量产和 Agent 负载还没闭环。

---

## 来源

- OpenAI，*Jalapeño’s first results show industry-leading speed and efficiency in AI inference*
- OpenAI / Broadcom，Jalapeño 发布稿
- Hot Chips 2026，*You Can Just Build Things … Chips*
- SemiAnalysis，*OpenAI Jalapeño: Better Than Nvidia Blackwell*（2026-08-25）
- The Register、TechCrunch、Data Center Dynamics 对 Hot Chips 的报道
- Broadcom 产品发布稿

数字均为 2026-08 公开口径，后续软件与 B0 硅还会变。
