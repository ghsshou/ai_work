# 任职与项目评审通用模板验证

2026-09-14。本次修订移除任职示例的个人与项目事实，并恢复项目评审参考材料中的多种图形页型。

## 页面与来源

- 任职材料：22 页、3 章，个人信息、项目成果、证据图片全部为通用占位；无历史编辑补丁。
- 项目评审：54 页、10 章；原 PPTX 的 53 页逐页对应，目录前移，重复目录改章扉，额外增加 DRB 待决策事项。
- 已检查原参考每页，以及生成后全部 76 页的离线截图；组织、交易流、架构、网络、布线、机房和泳道计划均为可编辑图形。
- 逐页索引见 `references/qualification-page-map.json` 和 `references/project-review-page-map.json`。

## 验证结果

| 检查 | 结果 |
|---|---|
| `edit-bundle.py verify` | 两套模板的页面 / 导航 / 章节 / 唯一页面身份一致 |
| `measure_overflow.mjs … --all` | 76 页，横纵溢出及嵌套裁剪均为 0 |
| `shot.mjs` 与全部页面离线截图 | 版式及字体检查通过，浏览器脚本异常为 0 |
| `steps.mjs` | 项目评审 10 章目录及任职 6 个训战模块逐拍检查通过 |
| `node scripts/verify/business-templates.mjs` | 76 页、19 个实际点击状态；离线资源、活动文字、面板、溢出与脚本检查通过 |
| `node --test scripts/editor/test/creation-draft-store.test.mjs scripts/editor/test/deck-factory.test.mjs` | 10 项通过 |
| `python3 scripts/test_business_templates.py` | 3 项通过 |
| `python3 scripts/test_template_layer_protocol.py` | 3 项通过，覆盖五套模板 |
| `python3 -m unittest discover -s scripts -p test_upgrade_deck.py` | 6 项通过 |

## 修复的回归

升级器原先只识别 `aico-ppt-*` 元数据与扩展槽，旧模板仍使用 `huawei-deck-*` / `HUAWEI_DECK_USER_*`，相同运行时因此被误判并进入历史合并。现在统一解析两种标记，保留用户槽及补丁；原三套模板仅同步标记与指纹。升级测试覆盖旧命名、用户样式保留、补丁重放代码重建与运行时指纹一致性。

任职训战页的活动按钮曾出现白底白字；已改为深红活动文字，并通过真实点击回归验证。

以上为本次模板及关联功能的验证范围，不代表运行了整个仓库全部端到端测试。
