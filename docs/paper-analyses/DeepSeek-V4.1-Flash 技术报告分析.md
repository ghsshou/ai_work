# DeepSeek-V4.1-Flash 技术报告分析

> **论文：** DeepSeek-V4.1-Flash: Pushing the Limits of KV Cache Compression  
> **作者：** DeepSeek-AI（2026）  
> **原文：** [Hugging Face 技术报告 PDF](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/DeepSeek_V41_Tech_Report.pdf) · [模型卡](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash)  
> **整理日期：** 2026-09-15

这篇报告的主线很明确：不是再做一个更大的旗舰模型，而是把长上下文 Agent 的部署瓶颈——Prefill 算力和 KV Cache 存储 / 带宽——压到极限。

---

## 1. 问题设定：Agent 时代的瓶颈已经变了

长程 Agent 的工作负载越来越 **input-heavy**：工具调用频繁、上下文持续累积。稀疏注意力已经把长序列计算压下来，真正卡住吞吐和成本的，变成三件事：

1. **Prefill 仍然很贵**（每次 cache miss 都要把整段 prompt 再算一遍）
2. **HBM 里的 runtime KV**（随上下文线性膨胀）
3. **SSD / host memory 里的 persistent KV**（为了 prefix reuse 必须长期存）

V4 已经把全局注意力 + SWA 做成「压缩全局上下文 + 局部窗口处理」。V4.1-Flash 的策略是：**简化全局分支、保留局部注意力，再在精度和部署上继续压 KV。**

CED 和 CSA2 在报告里被写成互补关系：

| 组件 | 主要打的成本 |
|------|----------------|
| **CED** | Prefill 算力（每来一段新输入要激活多少参数） |
| **CSA2** | KV 存储和索引开销（HBM / SSD） |

### 关键规格

| 项目 | V4.1-Flash |
|------|------------|
| Backbone | 552B MoE |
| Engram 条件记忆 | 196B（稀疏查找，不算进 backbone） |
| 激活量 | Prefill **8B** / Decode **16B** |
| 上下文 | 原生最多 **1M tokens** |
| 模态 | 图文原生多模态，自回归出文本 |
| 全局 KV | **890 bytes/token**（常驻 HBM） |
| vs V4-Flash | 全局 KV ≈ **1/4**，持久 KV ≈ **1/8** |
| vs V1 | 每 token 全局 KV ≈ **1/437** |
| Decode FLOPs | 上下文从 4K 扩到 1M（256×），单 token Decode FLOPs 只增约 **1/4** |

预训练 45T 多模态 token。官方定位：覆盖绝大多数日常 Agent 任务，成本和延迟显著低于同档模型。

---

## 2. Causal Encoder-Decoder（CED）：Prefill 只算一半层

这是整篇报告里最结构性的改动。

40 层 Transformer 被切成：

- **前 20 层：Causal Encoder**
- **后 20 层：Decoder**

灵感来自 YoCo：上半层共享下半层的 KV。CED 把它做实、做深：

- **全局注意力**：Decoder 各层的 global KV **不再从本层 hidden state 投影**，而是从 **encoder 最后一层 hidden state**（第 20 层）用各层自己的 \(W_K, W_V\) 投影出来。
- **局部 SWA**：仍然按层从本层 hidden state 生成，保证局部处理深度。

结果是：Prefill 时大部分 prompt token **只需要跑 encoder**，decoder 的 global KV 几乎「白送」。复杂度从 \(O(NL)\) 降到大约 \(O(NL/2)\)，**Prefill 激活量从 16B 降到 8B**。这对工具调用多、cache miss 多的 Agent 特别值钱。

代价是 decoder 的 SWA KV 仍要本层算。若精确重建，理论上要 replay \(n_{win} \times L/2\) 个 token。他们用 **Decoder SWA Bounded Replay** 只 replay 最近 \(n_{win}\) 个 token，实验显示质量损失可忽略。后训练还会故意模拟这种 replay，让模型适应近似状态。

### 2.1 为什么又用了 Encoder

这里的 encoder **不是 T5/BART 那种双向编码**，也不是把 GPT 路线退回去。Causal Encoder 仍然全程 causal，只是把 40 层拆成「前 20 层专门负责把上下文压成全局 KV，后 20 层负责生成」。再用 encoder，核心原因是 **Agent 场景里 Prefill 太贵**。

长程 Agent 的典型节奏是：读很长的历史 → 调工具 → 把工具结果再塞进上下文 → 再读一遍。工具一多，**cache miss 的 Prefill 会反复发生**。对 decoder-only 模型来说，每一层都要给每个新 token 算一遍 hidden state 和 KV，prompt 有多长、层有多深，Prefill 就有多贵。

V4 已经把长序列的 **注意力计算** 压下来了，但 Prefill 的 **层间计算量** 还在。所以 encoder 不是为了「理解得更深」，而是为了 **输入很重、输出相对轻的 Agent 负载**。

### 2.2 Encoder 具体带来什么

**Prefill 只跑一半层，激活量腰斩。** Decoder 各层的全局 KV 不再从本层 hidden state 投影，而是从 encoder 最后一层用各层自己的投影矩阵得到。Prefill 时整段 prompt 只需要跑完 encoder；decoder 的全局 KV 几乎是「从 encoder 输出直接投出来」。激活量：Prefill 8B，Decode 仍是 16B。序列远长于 SWA 窗口时，Prefill 复杂度从 \(O(NL)\) 变成大约 \(O(NL/2)\)。

**全局 KV 的计算深度集中在前半段，容量反而更好控。** 这是相对 YoCo 的改进。YoCo 更粗：上半层直接复用下半层已经算好的 KV。CED 没有简单共享同一份 KV，而是：

- encoder 用完整 20 层把上下文编码成一份高质量 hidden state
- decoder 每一层再用 **自己的投影** 从这份状态生成 KV

这样全局 KV 的生成深度集中在 encoder，同时 decoder 各层仍有独立的 KV 子空间，全局缓存容量和表示能力比「整段直接共享 KV」更强。

**局部能力没有被砍掉。** 如果 decoder 也完全不跑，局部依赖会变弱。所以 SWA 仍然逐层、从本层 hidden state 生成：

| | 全局注意力 | 滑动窗口注意力 |
|---|---|---|
| Encoder | 本层算 | 本层算 |
| Decoder | 从 encoder 末层投影 | 仍从本层算 |

全局上下文走「encode once, project many times」；局部窗口仍保持层间深度。这是他们敢砍掉一半 Prefill 却不明显掉点的关键折中。Decoder 的 SWA 还要一点 replay（Bounded Replay 只重放最近 128 token），相对「整段再跑 20 层 decoder」便宜得多。

**和 Flash 定位匹配：更大模型，反而更便宜。** V4.1-Flash backbone 是 552B，比 V4-Flash 的 284B 大不少，但 Prefill 激活只有 8B（V4-Flash 是 13B）。没有 CED，把模型做大，Prefill 会同比变贵，Agent 场景立刻不划算。Encoder 让他们可以 **把总参数做大、把输入侧激活做小**。

### 2.3 为什么叫 encoder，却不是「又回到 encoder-decoder」

经典 encoder-decoder（Transformer 原文、T5）的 encoder 是 **双向** 的：源句子可以看到未来 token，适合翻译这种「源和目标不对称、源可以一次性看完」。GPT 路线把它丢掉，是因为对话 / 生成本质是从左到右，decoder-only 更简单、也更好 scale。

V4.1 捡回来的是 **Causal Encoder**：

- 仍然不能看未来 token
- 仍然是自回归语言模型，不是 seq2seq
- 「encode」的对象是已经发生的上下文（prompt、工具结果、历史对话）
- 「decode」才真正按 token 往后续写

可以把它想成部署视角的拆分，而不是任务视角的拆分：

- Encoder = **上下文压缩机 / 全局 KV 工厂**（只在 Prefill 或 cache miss 时全力跑）
- Decoder = **生成器**（decode 时 20 层全开，但全局 KV 已经备好）

所以「又用了 encoder」，不是学术上否定 decoder-only，而是发现：在 1M 上下文、工具调用密集的时候，**把「读上下文」和「写下一个 token」做成不对称计算**更划算。输入走 8B，输出走 16B，专门打 Agent 的成本结构。

一句话：**用前半段模型把整段上下文编成一份可投影的全局 KV，让 Prefill 不必再把后 20 层跑一遍。** Causal Encoder 就是为这个不对称负载加的。

### 2.4 例子：4 层、6 个 token

真正的模型是 40 层、上万 token；下面用 **4 层、6 个 token**，机制完全一样。前 2 层叫 encoder，后 2 层叫 decoder。

#### 普通 decoder-only 在干什么

Prompt：`巴黎 是 法国 的 首都 吗`（6 个 token）。每一层都对自己的 hidden state 做：注意力 → FFN/MoE → 再投影出这一层的 K、V。

```
token:  巴黎   是   法国   的   首都   吗
        │     │     │     │     │     │
L1      ●     ●     ●     ●     ●     ●   → 存 K1,V1
L2      ●     ●     ●     ●     ●     ●   → 存 K2,V2
L3      ●     ●     ●     ●     ●     ●   → 存 K3,V3
L4      ●     ●     ●     ●     ●     ●   → 存 K4,V4，最后预测下一个词
```

6 个 token × 4 层 = **24 次「整层计算」**。Agent 上下文变成 10 万 token 时，每一次 cache miss 都要把这 10 万 token 完整过完所有层。贵的就是这个。

#### CED Prefill：6 个 token 大部分只跑前 2 层

**第 1 步：encoder 正常跑完**

```
L1  ● ● ● ● ● ●
L2  ● ● ● ● ● ●   ← 每个 token 得到一份 h₂
```

到这里，每个 token 都有一个经过 2 层算出来的向量 \(h_2\)。可以把它想成：「这段上下文已经被前半模型读完，浓缩成一份笔记」。

**第 2 步：decoder 的全局 KV 不再「再跑一层」，只做矩阵乘**

普通模型里，L3 的 K、V 来自 L3 自己的 hidden state，所以必须先把 6 个 token 全部过完 L3。CED 改成：

\[
K_3 = h_2 W_K^{(3)},\quad V_3 = h_2 W_V^{(3)}
\]
\[
K_4 = h_2 W_K^{(4)},\quad V_4 = h_2 W_V^{(4)}
\]

\(W_K^{(3)}\) 和 \(W_K^{(4)}\) 是 **两套不同的权重**。计算量就是两次线性投影，**没有 L3/L4 的注意力，也没有 L3/L4 的 MoE**。

所以 Prefill 变成：

```
encoder:           6 token × 2 层 = 12 次整层计算
decoder 全局 KV:   6 token × 两次小矩阵乘   ← 几乎免费
decoder SWA:       只把最后窗口里那几个 token 过 L3/L4
                   （真模型窗口是 128，不是全部 6 个）
```

激活量腰斩就是这个意思：真正吃参数的 MoE 层，Prefill 时大部分 token 只激活前 20 层（8B），不会把后 20 层（再 8B）也跑一遍。

生成下一个 token 时（Decode）就不一样了：新词必须过完 4 层才能出 logits，所以 Decode 仍是 16B。

#### 「从 \(h_2\) 投影」到底在干什么

把 \(h_2\) 想成一份已经写好的会议纪要。

- L3 的 \(W_K^{(3)}, W_V^{(3)}\)：按「事实核对」这个角度，从纪要里抽出一套 K、V
- L4 的 \(W_K^{(4)}, W_V^{(4)}\)：按「怎么回答用户」这个角度，从 **同一份纪要** 里再抽出另一套 K、V

两层看到的「原材料」相同（都是 \(h_2\)），但抽出来的 KV **不一样**。后面生成时：

- L3 用自己的 Q，去跟 \(K_3, V_3\) 做全局注意力
- L4 用自己的 Q，去跟 \(K_4, V_4\) 做全局注意力

没有让 6 个 prompt token 再过 L3、L4，却仍然给每一层准备了「看起来像是该层自己的」全局缓存。真模型就是这件事乘 10：encoder 末层是第 20 层的 \(h_{20}\)，decoder 的 L21…L40 各自拿一套 \(W_K, W_V\) 去投。

#### 和 YoCo 差在哪：共用一本笔记 vs 各自摘抄

YoCo 更粗：上半层 **直接复用下半层已经算好的 K、V**。

| | L3 全局 KV | L4 全局 KV |
|---|---|---|
| YoCo | 就是 L2 的 \(K_2, V_2\) | 还是 L2 的 \(K_2, V_2\) |
| CED | \(h_2 W^{(3)}\)，一套新的 | \(h_2 W^{(4)}\)，又一套新的 |

YoCo 等于 20 个 decoder 层共用 **同一份** KV 缓存。省事，但所有层在全局注意力里看到的 key/value 完全一样，表达空间只有一份。

CED 等于：

1. encoder 20 层先把上下文编成一份比较深的 \(h_{20}\)（计算深度集中在前半段）
2. decoder 20 层各自做一次投影，得到 **20 份不同的 KV**（容量更大）

所以不是「KV 变深了所以更好」，而是：

- **深度**：全局 KV 的信息来自完整 20 层 encoder，不是某一层随手吐出来的 K、V
- **容量**：decoder 每一层仍有自己的 KV 子空间，不是 20 层复印同一份

用数字感受一下：YoCo 全局缓存大约 1 份；CED 是 20 份「同源但不同投影」的 KV。多出来的只是投影权重和多份缓存，**没有** 20 层 decoder 的注意力和 MoE。

#### 和生成连起来看一轮

用户问完「巴黎是法国的首都吗」之后，模型要生成「是」。

**Prefill（读这 6 个字）**

1. 6 个 token 过 L1、L2 → 得到 6 个 \(h_2\)
2. 用 \(W^{(3)}\)、\(W^{(4)}\) 投出 L3、L4 的全局 KV，放进缓存
3. 最后 128 个 token（这个玩具例子里就是末尾几个）过一下 L3、L4，填 SWA 小窗口

**Decode（写出「是」）**

1. 新 token 从 L1 一路跑到 L4（整模型，16B）
2. L3/L4 做全局注意力时，Q 来自当前层，K/V 来自刚才那份「从 \(h_2\) 投出来的缓存」
3. 局部 SWA 仍看本层最近 128 个 token

读很长、写一个词：钱主要花在「读」。CED 把「读」从 4 层变成大约 2 层，所以 Agent 那种「历史超长、每轮新输出不一定长」的场景会明显便宜。

对应前面两句：

- **「Prefill 只跑一半层」**：不是 decoder 完全消失，而是 prompt 上那些 token **不必再过 decoder 的注意力和 MoE**；decoder 全局 KV 用 encoder 末层做几次矩阵乘就得到了。
- **「计算深度集中在前半段，容量反而更好控」**：YoCo 后半层直接拿前半层的 KV，省，但只有一份缓存；CED 前 20 层把上下文编扎实（深度），后 20 层各自投影成自己的 KV（容量），既不用把后 20 层 Prefill 跑满，又不会变成「20 层共用一本复印件」。

---

## 3. CSA2：把 KV 压缩做到「条目大小 × 序列 × 层」三个维度

V4 是 **CSA + HCA 混合**；V4.1-Flash 改成 **纯 CSA2**。CSA2 同时压三个乘法维度：

1. **条目大小**：GQA / 压缩 latent（沿用 MLA 思路）
2. **序列维**：每 \(r\) 个 token 压成一个 main KV entry
3. **层维**：跨层共享 KV 和 Top-K 索引（这是 CSA2 的新轴）

一句话：每一层不再「全序列、自己存一份 KV」，而是 **先用一个小 indexer 选出最相关的若干条全局 KV，再和本层局部窗口一起做注意力；相邻层还可以共用这份全局 KV，甚至共用「选了谁」。**

### 一层 CSA2 里其实有三样东西

对当前 token 的 query 来说，注意力不是扫完全文，而是两路拼接：

| 东西 | 干什么 | 贵在哪 |
|------|--------|--------|
| **Indexer** | 用很小的 \(Q_{idx}, K_{idx}\) 给每条 main KV 打分，取出 Top-K | 打分次数随上下文变长 |
| **Main KV** | 被选中的全局压缩 KV，给真正的注意力用 | 存储随层数 × 序列变长 |
| **SWA KV** | 本层最近 \(n_{win}=128\) 个 token 的局部 KV | 窗口固定，不随总长度涨 |

真正的注意力是：

\[
\text{Attn}(Q_{\text{本层}},\; \underbrace{\text{Top-K 选中的 main KV}}_{\text{全局稀疏}} \;\cup\; \underbrace{\text{本层 SWA KV}}_{\text{局部窗口}})
\]

三种模式 **都自己算** \(Q_{\text{本层}}\) 和本层 SWA；差别只在 main KV、indexer K、Top-K 从哪来。

### 三种静态模式

- **Full**：本层算 main KV、indexer Q；indexer K 从 main KV 投影；跑 indexer 得到新 Top-K。
- **Reindex**：复用最近 Full 层的 main KV 和 indexer K，但用本层 indexer Q **重新打分**，选出新的 Top-K。KV 共享，选择可变。
- **Reuse**：main KV 和 Top-K 都复用，**完全不算 indexer**，直接稀疏注意力。这是最便宜的层。

实际排布：

- Encoder 后 18 层：压缩比 \(r=2\)，每 6 层一组（1 Full + 5 Reuse）
- Decoder 20 层：压缩比 \(r=1\)（不压序列），5 组；第一组 1 Full + 3 Reuse，后面四组 1 Reindex + 3 Reuse

Reuse 层推理时非常干净：Prefill **15 个 kernel**，Decode **11 个 kernel**。

### 相对 CSA 的简化

- 压缩不再 overlap，也不再给压缩窗口加绝对位置编码：\(r=2\) 就是每 2 个 token 收成 1 条，互不重叠
- indexer K **直接从 main KV 投影**，不再另开一条从 hidden state 压缩的路径

实现更简单，训练也更高效。

### 例子：8 个 token，看「吗」这一层在看谁

还用上一节那句 prompt，当成 8 个 token：

```
T1 用户  T2 问  T3 巴黎  T4 是  T5 法国  T6 的  T7 首都  T8 吗
```

玩具参数（真模型只是数字变大，流程一样）：

- 压缩比 \(r=2\) → 8 个 token 收成 **4 条** main KV
- Top-K = **2**（真模型是 512）
- SWA 窗口 = **3**（真模型是 128）
- 先看 encoder 里一组 3 层：L3 Full，L4 Reuse，L5 Reuse（真模型是 1 Full + 5 Reuse）

4 条压缩后的全局条目：

```
E0 = (用户, 问)
E1 = (巴黎, 是)
E2 = (法国, 的)
E3 = (首都, 吗)
```

当前 query 是最后一个 token「吗」。局部窗口 SWA 永远是最近 3 个：`的, 首都, 吗`。

#### L3 Full：自己造库、自己检索

1. 用本层 hidden state 生成 4 条 main KV，再从 main KV 投影出 indexer K。这两份都要写入全局缓存。
2. 用本层很小的 indexer Q 去给 4 条打分，假设得到：

   | 条目 | 分数 | 含义 |
   |------|------|------|
   | E0 (用户,问) | 0.10 | 和「首都吗」关系不大 |
   | E1 (巴黎,是) | 0.95 | 很相关 |
   | E2 (法国,的) | 0.40 | 一般 |
   | E3 (首都,吗) | 0.80 | 相关 |

   Top-2 = **E1, E3**。记下这两个下标，这就是 Top-K 索引。

3. 本层真正的注意力 Q 不去扫 8 个 token，只看：

   ```
   全局稀疏:  E1 (巴黎,是) + E3 (首都,吗)
   局部窗口:  的, 首都, 吗
   ```

Full 层干了三件贵的事：写出全局 KV、全量打分、选出 Top-K。后面的 Reuse 层都在吃这三样的饭。

#### L4 / L5 Reuse：库和检索结果都不重做

Reuse **不再写** 自己的 main KV，**也不跑** indexer。

L4 做的只有：

- 用 **自己的** Q（L4 的表示已经和 L3 不同）
- 去注意 **同一份** `{E1, E3}`
- 再拼上 **L4 自己的** 最近 3 个 SWA KV

L5 同理。直觉是：邻近几层要找的「长程相关 token」往往还是那几个（这里还是「巴黎是」「首都吗」），不必每层重新建库、重新搜；但每层的 Q 和局部窗口不同，所以变换仍然在发生。

存储上：这一组 3 层只存 **1 份** 全局 KV，不是 3 份。真模型 encoder 每 6 层存 1 份，全局 KV 大约能降到原来的 1/6（再叠 FP4 和 decoder 的层间共享）。

#### Decoder 的 Reindex：库不变，换一个问题再搜一次

Encoder 组里没有 Reindex；Reindex 出现在 decoder。另外 decoder 的压缩比 \(r=1\)，main KV 和 token 一一对应，8 个 token 就是 8 条，不再两两合并。

接上 CED：decoder 的这份 main KV **不是 decoder 自己一层层算出来的**，而是从 encoder 末层 \(h_{20}\) 投影出来的。所以 decoder 的 Full 仍然要做一次「全序列检索」，但不必再为全局 KV 跑 decoder 的注意力和 MoE。

玩具 decoder 一组 4 层：L21 Full，L22–L24 Reuse。下一组：L25 Reindex，L26–L28 Reuse。

L21 Full 对 8 条逐条打分，假设 Top-2 = `巴黎, 首都`，后面三层 Reuse 都盯着这两个词。

到了 L25，模型更深了，可能更想核对「法国」而不是「巴黎」。Reindex 的做法是：

- **main KV、indexer K 仍用 L21 那一份**（不新建库）
- 用 **L25 自己的 indexer Q** 重新打分
- 选出新的 Top-2，比如 `法国, 首都`
- L26–L28 Reuse 就改用这组新下标，KV 还是 L21 的

这就是报告说的「cache sharing 和 index reuse 解耦」：

| 模式 | 全局 KV | 选谁（Top-K） | 本层 Q / SWA |
|------|---------|---------------|--------------|
| Full | 新建 | 新建 | 本层 |
| Reindex | 复用 Full | 新建 | 本层 |
| Reuse | 复用 Full | 复用最近一次 Full/Reindex | 本层 |

如果只有 Reuse，20 层 decoder 会盯死同一批 token；穿插 Reindex，等于「同一座图书馆，换个检索词再查一遍」，不必为每一层复制整座图书馆。

### Hierarchical Sparse Indexer（仅 Decoder）

跨层 reuse 减少了 indexer 次数，但剩下的 Full / Reindex 若仍对 **全上下文** 打分，1M 长度时打分本身又会爆。Decoder 因此加了分层检索，而且是 train-aware 的：训练和推理用同一套候选限制。

还用 8 个 token 把数字缩小：

1. L21 Full 先对全部 8 条打分，选出自己的 Top-2，同时按 **block 内最高分** 挑出几个 block，把里面的位置收成 **候选池**（真模型：最多 2048 个 block × 8 位置 = **16384** 个候选；Top-K 仍是 512）。
2. 玩具里假设池子是 `{巴黎, 是, 法国, 首都}`，丢掉了 `{用户, 问, 的, 吗}`。
3. 后面的 L25 / L29 / … Reindex **只在这 4 个候选上打分**，再各自选出 Top-2。它们不能突然翻出池子外的「用户」，检索成本与总长度无关。

对应到 1M 上下文：

- 第一个 Full：仍然扫完全程，\(O(T)\)
- 之后每个 Reindex：只打 16384 分，**常数开销**
- 中间的 Reuse：连这 16384 也不打

所以长上下文 decode 时，真正随长度线性变贵的，主要只剩 decoder 里那一次 Full 检索；后面层被 CSA2 的复用和候选池一起按住。

### 和 CED 叠在一起时，Prefill 在干什么

对很长的 prompt：

1. Encoder 的 Full 层写出压缩 main KV，Reuse 层共享它
2. CED 用 \(h_{20}\) 给 decoder 投影出 decoder 的全局 KV（decoder Full 的那一份）
3. Decoder 第一个 Full 做一次全量索引，并建好 16384 候选池
4. Decoder 其余 Reindex / Reuse 不再建库；绝大多数 token 也不跑 decoder 的 MoE

CSA2 管的是「KV 存几份、检索扫多宽」；CED 管的是「后 20 层还要不要为 prompt 做整层计算」。两件事打的是不同账单。

---

## 4. FP4 Main KV + SWA Bounded Replay：HBM 1/4、SSD 1/8

### FP4 主 KV（精度层）

V4 已经对 indexer Q/K 做 FP4 QAT。V4.1 把 **main KV 也做成 FP4**：

- 格式：**E2M1 + 每 16 channel 一个 E4M3 scale**（接近 NVFP4，但去掉二级 global scale）
- 在 **RoPE 之后**量化；推理时先反量化再做 attention，所以不依赖硬件原生 FP4 GEMM
- SWA KV 对量化更敏感，仍用 **FP8**
- 相对 V4 的 FP8 main KV，存储大约再减半

他们论证过动态范围足够：RMSNorm 后 512-d latent 的最大绝对值大约 \(\sqrt{512} \approx 22.6\)，训练中观察到约 10，而该格式上限约 2688。

**CSA2 跨层共享 + FP4** 一起，把常驻 HBM 的全局 KV 压到 **890 B/token**。

### SWA Bounded Replay（部署层）

V4 持久缓存里，SWA KV 几乎占一半。问题是 SWA 的复用寿命只有 **分钟级会话内**，却按 72 小时 LRU 去存，又贵又低效。精确重建又要 replay \(L \times n_{win}\) 个 token，生产上扛不住。

V4.1 的新存储-计算折中：

1. **持久 KV 不再存 SWA**，只长期存全局 KV（≥72 小时）
2. SWA 放到各机 **10% host DRAM 的分布式内存池**，TTL 只有几分钟，靠高周转服务活跃会话
3. miss 时用 **Encoder SWA Bounded Replay**：只 replay 最近 \(n_{win}\)（窗口=128）个 token，截断 SWA 感受野，接受近似状态

再加上「不再持久化 SWA」本身接近减半，持久 KV 相对 V4-Flash 到 **约 1/8**。

报告强调：这会让 suffix 上新算出的 KV **不再与 cache-hit 位置数学上完全一致**，但实验和质量监控显示几乎不影响回复质量。这是整篇里最「工程上好用、理论上不严谨」的创新，他们自己也在 Limitations 里把它列为潜在鲁棒性边界。

---

## 5. 其它架构扩展：把 V4 变薄、变快

### Single-Pass mHC + Mega-mHC

V4 的 mHC 维护多条 residual stream。原实现因数据依赖要 3 个 kernel 串行，激活内存流量是理论下界的 **2 倍**。

Single-Pass mHC 把 **input-mixing 系数错后一层**：本层用上一层算出的系数。依赖被拆掉后，residual update、input mixing、系数预测可以融进一个 **Mega-mHC** kernel：residual 只读一次、写一次，达到理想流量，相对原实现 **激活带宽减半**。错一层带来的质量损失可忽略；预训练仍用多 kernel，部署才上 Mega-mHC。

### Engram：196B 条件记忆

把「记忆」从「计算」里拆出来。两处模块（第 1、14 层）均分 196B，n-gram 阶 \(\{2,3,4\}\)，每阶 8 个 hash head，表大约 16M 项（质数表大小防碰撞）。相对原 Engram：

- 去掉短因果卷积（收益不抵推理复杂度）
- 表用 **momentum + Sinkhorn balancing** 更新，避免 Adam 优化器状态爆显存
- 表和 K/V 投影都是 FP8；地址由 token 决定，可从 host 用 RDMA 预取

这是第三条稀疏轴：MoE 是专家稀疏，CSA2 是注意力稀疏，Engram 是 **查表稀疏**。

### DSpark：投机解码

三个 Transformer block、SWA 窗口 128。一次前向并行出 **5 个 draft 位置**，Markov head 建模 draft 依赖，confidence head 估前缀存活概率，再按引擎吞吐曲线动态选验证长度。

和 V3 的 MTP 不同：**backbone 预训练不含 MTP**，DSpark 在预训练后单独训、backbone 冻结；后训练继续跟 backbone 对齐，但 **不把 DSpark loss 回传到 backbone**。它同时加速在线 serving 和 RL/OPD 的 rollout。

### MoE 与多模态

- 每层：1 个 shared expert + **384 routed**，每 token 激活 **6** 个；expert 中间维 2304
- 图像 / 文本用 **分模态的 auxiliary-loss-free load balancing**（两套 expert bias 独立更新），避免两种 token 的路由偏好互相掩盖
- **DeepSeek-ViT** 从零训：2D-RoPE 支持任意分辨率；patch embedding 改线性投影以适配 Muon；RMSNorm + SwiGLU；**3×3 pixel-unshuffle** 把视觉 token 数降到 1/9，大约支持到 1344×1344
- 视觉从语言模型预训练一开始就和文本 jointly train，不是后期贴上去的

---

## 6. 预训练与优化器

- 45T 多模态语料，全程稳定，无 instability
- **从零用稀疏注意力、64K 序列训练**，没有 dense attention warmup；34T 时扩到 1M
- 文本 : 多模态 token 比约 **7:1**；packing padding rate ≤ \(10^{-4}\)
- 数据侧更强调 corpus 之间的 information gain，过滤低信息增益的模型生成内容和低质量机翻（视为隐式重复）
- 视觉编码器先 SigLIP 对比学习（约 47B 图文对，224²），再接到 4B MoE 上做自回归微调（236B token，544–1344），然后丢掉那个小 LLM，只保留 ViT 接入正式预训练

优化器分层：

- 线性层：**Muon**（Q/K 用 **head-wise Muon**，给不同头不同 preconditioner）
- RMSNorm / bias / scale：**AdamW**
- Embedding、预测头、Engram 表：**Nesterov momentum + Sinkhorn**，按行 / 列 RMS 均衡更新，只要一份 momentum，比 Adam 省大量 optimizer state

Base 模型用约 V4-Pro **1/3 总参数、1/4 激活量**，世界知识 / 推理 / 代码接近甚至局部超过 V4-Pro-Base，held-out 内部语料 BPB 全面更好。报告把这同时归因于架构效率和数据管线。

---

## 7. 后训练：算法几乎没创新，数据和环境才是主战场

报告写得很直白：**SFT → RL → On-Policy Distillation，算法不改；所有实质变化在数据。** 他们的判断是：现阶段数据和环境管线的边际收益，明显高于再发明 RL 算法。

### 大规模任务合成

任务被形式化成三元组 `(problem, environment, verification)`，用 **难度 + 正确性** 当奖励，迭代训练模型自己出题。通用 Agent 用真实工作流接口做 mock tool；Coding Agent 用内部会话 + GitHub 仓库，多 agent 协作：能否容器化、选起点、写 fail-to-pass / pass-to-pass 评测点、自测、质检、防泄漏、防 hackable。

### DSec：百万级沙箱

强化学习需要同时跑百万级异构 sandbox。自研调度，用 **分片 + 最终一致性** 换扩展性：中心只做「够好的放置」，节点本地硬约束拒绝超额。单机密度从约 1000 提到 **2500+** 活容器。另有延迟敏感队列、AppArmor / eBPF 网络策略，防止 agent 搞坏环境或 reward hacking；环境崩溃会作为失败轨迹回传。

### 连续可控 reasoning effort（1–100）

系统提示里加 `Reasoning Effort: {n}`。同一 prompt 在不同 effort 下采样，**只在同 effort 组内做 group-relative advantage**；长度惩罚系数随 effort **指数衰减**。训练只用离散档，部署可插值。

API 三档：`max=100` / `high=75` / `low=50`。effort 25→100：八个推理基准平均 Pass@1 从 67.1% 到 76.3%，DeepSWE 66.0%→74.2%，Terminal-Bench 2.1 82.4%→90.6%，输出大约 2.5×。收益主要在 60–80，再拉到 100 往往 1.6–1.8× token 只换边际提升。这个控制从单轮推理 **迁移到了多轮 Agent 轨迹**。

### 异步 RL 基础设施

同卡时分 rollout/train；**sample-level dispatch** 维持并发；token 级打断；KV 和 expert routing 按 token 持久化，换 checkpoint 后直接续跑。用 dataset 级并发限制 + 丢弃过早返回的短样本缓解长度偏差；用 off-policy 比例上限 + 过期 token mask 处理陈旧样本。OPD 最后用 **40+ 个异构 teacher** 做全词表蒸馏。

跨 scaffold / 配置的 checkpoint **model merging** 用来把多次 RL run 接起来继续涨。

### Multi-Agent（初步）

DeepSeek Harness 的 Agent Team：lead 异步 spawn 队友，共享仓库，mailbox 通信，任务板管理依赖。奖励 = 任务分 + 协作奖励 − **关键路径延迟**（把协作依赖建成 DAG）。在 ProgramBench / FrontierSWE v2 上，同样墙钟 deadline 下多智能体全面高于单智能体。

---

## 8. 效果与边界

Instruct（max effort）上，相对自家 V4-Flash 是全面跃升，部分 Agent 榜甚至压过 V4-Pro 和若干闭源前沿：

- Codeforces **3471**（V4-Pro 3348，V4-Flash 3289）
- Terminal-Bench 2.1 **90.6**（Opus-5.0 89.1）
- DeepSWE v1.1 **74.2**（Opus-5.0 74.0，GPT-5.6 Sol 73.0）
- AutomationBench **54.8**，Agents’ Last Exam **31.8**

能力画像：日常编码和白领工作流已经很强；科学向、高专家知识的 Terminal-Bench 4.0 等仍落后巨型模型；视觉 Agent 强于开源竞品，但整体仍落后顶尖闭源。跨 8 套 scaffold 迁移良好，说明没有过拟合某一套 harness。

**Limitation（报告自己承认的）：**

- CSA2 选错 token、SWA Bounded Replay 的近似重建，在未测到的极端边界上仍可能掉能力
- 日常体验接近顶尖闭源，但最难推理和边角案例仍有差距
- 评测基础设施本身开始被更强 agent「钻空子」，需要社区一起防 reward hacking

未来方向：以 V4.1-Flash 为新起点，**架构、预训练、后训练联合放大**；数据和 RL 规模继续涨；模型和 harness 共同设计。

---

## 9. 一句话抓住这篇报告

V4.1-Flash 的创新不是「更大的脑」，而是一套把长上下文 Agent 成本打下来的组合拳：

**CED 让 Prefill 只激活 8B → CSA2 跨层复用 KV/索引 → Hierarchical Indexer 把深层检索变成常数 → FP4 再砍主 KV → Bounded Replay 把 SWA 从 SSD 里拿掉。**

叠加 Engram 记忆、DSpark 投机解码、原生多模态，以及「算法不动、数据和沙箱狂堆」的后训练，用大约半个 V4-Pro 的激活量，把 KV 压到上一代 Flash 的 1/4–1/8，同时把 Agent 能力推过很多更贵的模型。
