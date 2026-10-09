# 项目评审通用模板

模板 ID：`project-review`。文件：`assets/project-review-deck.html`。54 页、10 章。已逐页查看原参考的 53 页；每页均有对应模板，原第 4 页目录前移至第 2 页，重复目录转为章扉，另增一页 DRB 决策事项。组织、交易流、技术架构、业务与管理网络、布线、运维链路、机房平面及实施计划使用可编辑图形；配置、责任、条款与风险等继续使用表格。

## 使用方式

复制模板后按本次材料填写全角方括号占位。证据占位需换成当前材料的截图、图表或附件；不能把占位当成评审结论。保持封面、第二页目录和末页感谢页的固定契约，按实际大纲重建目录与章节。

图中节点、链路、带宽、设备、产品版本、组织角色和阶段安排均是待替换的结构占位，不构成预设方案。原件中“不涉及”或“通过”的结论不继承，须按当前范围判定。表格行可以增删，必须检查数据完整性及溢出。

原参考保存在 `assets/project-review-refs/DRB-AI算力平台项目-V5.3.pptx`，仅供核对页型与字段；参考案例中的规则、数据和审批结论不是当前项目事实。

## 逐页对应

| 模板页 | 页型 | 页面 | 参考页 |
|---|---|---|---|
| 1 | `cover` | 封面 | 1 |
| 2 | `toc` | 目录 | 4 |
| 3 | `review-entry` | DRB评审要求 | 2 |
| 4 | `decision-inputs` | DRB决策输入件 | 3 |
| 5 | `project-profile` | 项目背景及概况 | 5 |
| 6 | `customer-value` | 客户价值与主张 | 6 |
| 7 | `customer-organization` | 客户组织架构与沟通矩阵 | 7 |
| 8 | `delivery-organization` | 交付组织架构与沟通机制 | 8 |
| 9 | `contract-divider` | 章节·标书与合同分析 | 9 |
| 10 | `transaction-flow` | 交易模式与合同界面 | 10 |
| 11 | `project-scenario` | 项目场景与系统范围 | 11 |
| 12 | `service-scope` | 项目范围·服务 | 12 |
| 13 | `equipment-scope` | 项目范围·本期设备 | 13 |
| 14 | `expansion-scope` | 项目范围·扩容与分期 | 14 |
| 15 | `responsibility-matrix` | 责任矩阵 | 15 |
| 16 | `contract-terms` | 其他关键条款分析 | 16 |
| 17 | `solution-divider` | 章节·解决方案可交付性评审 | 17 |
| 18 | `solution-architecture` | 智算集群整体技术架构 | 18 |
| 19 | `deliverability-conclusion` | 解决方案可交付性评审结论 | 19 |
| 20 | `network-overview` | 项目整体组网拓扑 | 20 |
| 21 | `business-network` | 业务网络设计 | 21 |
| 22 | `management-network` | 管理网络设计 | 22 |
| 23 | `port-cabling` | 端口布线与实施责任 | 23 |
| 24 | `operations-architecture` | 运维方案设计与告警链路 | 24 |
| 25 | `room-layout` | 机房布局设计 | 25 |
| 26 | `site-survey` | 工勘报告与关键环境检查 | 26 |
| 27 | `security-compliance` | 网络安全与合规分析 | 27 |
| 28 | `integration-validation` | 集成验证与准入证据 | 28 |
| 29 | `delivery-divider` | 章节·项目交付方案 | 29 |
| 30 | `delivery-strategy` | 项目交付策略 | 30 |
| 31 | `integrated-plan` | 分泳道集成实施计划 | 31 |
| 32 | `resource-plan` | 人力资源计划 | 32 |
| 33 | `procurement-strategy` | 采购需求与采购策略 | 33 |
| 34 | `resale-procurement` | 第三方产品转售采购需求 | 34 |
| 35 | `cooperation-cost` | 研发合作及其他服务成本 | 35 |
| 36 | `supply-chain` | 供应链管理计划 | 36 |
| 37 | `quality-ehs` | 质量与EHS管理计划 | 37 |
| 38 | `cybersecurity-plan` | 网络安全管理计划 | 38 |
| 39 | `acceptance-plan` | 验收管理 | 39 |
| 40 | `revenue-plan` | 收入管理 | 40 |
| 41 | `inventory-plan` | 存货管理计划 | 41 |
| 42 | `partner-divider` | 章节·分包与伙伴能力评估 | 42 |
| 43 | `partner-assessment` | 伙伴能力与交付边界 | 43 |
| 44 | `assumption-divider` | 章节·项目假设 | 44 |
| 45 | `assumption-register` | 项目关键假设 | 45 |
| 46 | `risk-divider` | 章节·项目交付风险 | 46 |
| 47 | `risk-register` | 项目交付风险 | 47 |
| 48 | `operations-divider` | 章节·运营运维方案 | 48 |
| 49 | `maintenance-plan` | 运维方案 | 49 |
| 50 | `operations-plan` | 运营方案 | 50 |
| 51 | `cost-divider` | 章节·项目服务成本测算 | 51 |
| 52 | `service-cost` | 项目服务成本测算 | 52 |
| 53 | `review-decisions` | DRB待决策事项 | 新增 |
| 54 | `thanks` | 感谢页 | 53 |

完整映射见 [project-review-page-map.json](project-review-page-map.json)。

## 维护与验证

页面定义在 `scripts/build-business-templates.py`，修改后运行该脚本，经 `edit-bundle.py` 同步页面、导航、章节与资源，并刷新模板目录。两套模板共用当前工作汇报运行时，无历史补丁。重建后检查全部页面的离线渲染、溢出、目录及 layer 切换，并运行模板目录、创建流程和升级器回归测试。
