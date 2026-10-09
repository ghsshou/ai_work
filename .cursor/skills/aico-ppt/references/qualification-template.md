# 任职材料通用模板

模板 ID：`qualification`。文件：`assets/qualification-deck.html`。22 页、3 章。参考任职材料的页面结构，重建为通用中文占位。保留灰底、蓝色表头与密集举证布局；不包含原作者姓名、工号、客户、项目、绩效、结果数字、证明人、截图或历史编辑补丁。

## 使用方式

复制模板后按本次材料填写全角方括号占位。证据占位需换成当前材料的截图、图表或附件；不能把占位当成评审结论。保持封面、第二页目录和末页感谢页的固定契约，按实际大纲重建目录与章节。

能力举证应写清背景与约束、本人判断与动作、结果和证明材料，区分个人贡献与团队成果。性能与结果数字必须给出口径、基线、单位和范围。训战体系页含六个可切换能力模块。

## 逐页对应

| 模板页 | 页型 | 页面 | 参考页 |
|---|---|---|---|
| 1 | `cover` | 封面 | 1 |
| 2 | `toc` | 目录 | 2 |
| 3 | `experience-table` | 工作经历 | 3 |
| 4 | `project-portfolio` | 主要项目 | 4 |
| 5 | `evaluation-divider` | 专业能力自评 | 5 |
| 6 | `skill-assessment` | 专业知识与技能 | 6 |
| 7 | `knowledge-themes` | 专业知识主题 | 7 |
| 8 | `delivery-model` | 职责与协同交付模式 | 8 |
| 9 | `solution-architecture` | 技术方案与架构设计 | 9 |
| 10 | `technical-leadership` | 技术领导力与工程挑战 | 10 |
| 11 | `issue-reconstruction` | 复杂问题处理与工程实现 | 11 |
| 12 | `issue-root-cause` | 问题定位与根因闭环 | 12 |
| 13 | `performance-evidence` | 性能优化与对比证据 | 13 |
| 14 | `solution-resource-plan` | 方案论证与资源规划 | 14 |
| 15 | `customer-alignment` | 客户沟通与跨团队对齐 | 15 |
| 16 | `project-retrospective` | 项目复盘与可重复方法 | 16 |
| 17 | `training-curriculum` | 训战体系与能力传递 | 17 |
| 18 | `professional-giveback` | 专业回馈与知识资产 | 18 |
| 19 | `reflection-divider` | 业务思考与能力改进 | 19 |
| 20 | `business-reflection` | 业务思考与专业判断 | 20 |
| 21 | `improvement-plan` | 个人能力改进计划 | 21 |
| 22 | `thanks` | 感谢页 | 22 |

完整映射见 [qualification-page-map.json](qualification-page-map.json)。

## 维护与验证

页面定义在 `scripts/build-business-templates.py`，修改后运行该脚本，经 `edit-bundle.py` 同步页面、导航、章节与资源，并刷新模板目录。两套模板共用当前工作汇报运行时，无历史补丁。重建后检查全部页面的离线渲染、溢出、目录及 layer 切换，并运行模板目录、创建流程和升级器回归测试。
