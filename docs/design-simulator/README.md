# 设计态 AI 集群仿真器：负载引擎立项

面向 AI 集群整体系统设计（设计态，离线、无实时约束）的仿真器立项材料。底层 NPU / 内存存储 / 网络仿真已具备，本材料聚焦核心：**负载的画像、生成与导入**。

| 版本 | 文件 | 说明 |
|---|---|---|
| **v2（现行）** | [PPT](./设计态仿真器_负载引擎立项_v2.pptx) · [build_pptx.py](./scripts/build_pptx.py) | 架构图收至左侧 2/3 版面（右侧预留）；每个模块精简为 4 个子框 |
| v1（归档） | [PPT](./设计态仿真器_负载引擎立项_v1.pptx) · [build_pptx_v1.py](./scripts/build_pptx_v1.py) | 全幅分层架构图，模块 5–6 个子框 |

后续迭代按 v3、v4… 新增文件，旧版本保留不删。

## 框架侧仿真能力（单页）

训练、推理、RL 等框架的 DAG 导出与场景泛化。左 1/2 为分层框图，右 1/2 为三项关键技术；标题下为面向场景、竞争力目标、技术挑战。v2 把创建、变换、编排拆成 6 个模块、共 36 个子框，输入层直接到输出层。配色按 AICO-PPT：品牌红只标 DAG 引擎，输入和输出用灰蓝。

| 版本 | 文件 | 说明 |
|---|---|---|
| **v2（现行）** | [PPT](./设计态仿真器_框架DAG仿真能力_v2.pptx) · [build_framework_dag_v2.py](./scripts/build_framework_dag_v2.py) | 左半页六个模块、各 6 个子框；输入直达输出，不含仿真核。配色用 AICO-PPT 品牌红 + 灰蓝 |
| v1（归档） | [PPT](./设计态仿真器_框架DAG仿真能力_v1.pptx) · [build_framework_dag_v1.py](./scripts/build_framework_dag_v1.py) | 三模块各 4 子框，含仿真核层 |

## 主页结构

自上而下的分层架构，嵌套方框只写技术点名称：

输入层 → **负载引擎（本项目核心）** → 仿真内核（NPU / 内存存储 / 网络，已具备） → 设计输出（DSE）

负载引擎内六个模块：

1. 基于计算图展开的模型负载画像
2. 基于随机过程的到达与请求建模
3. 基于统计拟合的 Trace 重构与外推
4. 面向 DSE 的流水线化负载数据工厂
5. 统一负载 IR 与多保真导入
6. 基于实测对标的闭环校准（接收仿真内核结果回流）

v2 中①②③为三列、各 4 个纵向子框；④⑤⑥为横向行，各 4 个子框。

备份页为六项技术展开表（关键问题 / 技术路线 / 业界参考 / 难点）与立项目标。

## 待确认

- 「DSX」按 NVIDIA Omniverse DSX（AI 工厂数字孪生蓝图）理解；若指其他仿真器需替换对标项。
- 立项目标中的 KPI（≤10% 误差、1K→100K 外推、6 类 30+ 负载、≥1000 配置/轮）为建议值，需按实测平台规模与项目周期对齐。
- 训练与推理负载的优先级、可获得的生产 Trace 来源（msprof、HCCL 日志、推理服务日志）会影响①②③的投入比重。

## 重新生成

```bash
pip install python-pptx
python3 docs/design-simulator/scripts/build_pptx.py      # v2
python3 docs/design-simulator/scripts/build_pptx_v1.py   # v1
python3 docs/design-simulator/scripts/build_framework_dag_v2.py
python3 docs/design-simulator/scripts/build_framework_dag_v1.py
```
