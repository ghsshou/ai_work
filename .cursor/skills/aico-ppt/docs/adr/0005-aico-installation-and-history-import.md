# ADR-0005：AICO 配套安装与旧历史导入

状态：已实现

## 背景

AICO-Harness 需要与原生 DSH 以及独立 AICO-PPT Skill 并存。直接沿用原 DSH 的全局目录会混用工作区和会话；覆盖旧 Skill 注册或搬动项目 sidecar 会损害用户自己维护的安装与未固化工作。

## 决策

发行安装、独立命令、版本选择、端口与进程归 AICO-Harness 管理。PPT 继续作为独立 Skill 和 DSH bundle，规范 Skill 由 Host 插件直接注册。Harness 给 Editor 设置专用 `AICO_PPT_EDITOR_STATE_ROOT`，不改变独立 Skill 的默认解析或项目 sidecar 的原位兼容规则。

[`import-history.mjs`](../../scripts/editor/import-history.mjs) 只负责显式复制 `work-catalog.json`、`recent-work.json`、`recent-decks.json`。来源支持的工作目录版本为 2/3，最近历史版本为 1；未知版本拒绝。工作目录保持工作身份和路径，清空旧 DSH 绑定，让用户在新 Harness 数据目录建立新会话。全局凭据、会话、活动锁、项目文件和 sidecar 不复制、不删除。

调用方停止目标 AICO 实例并持有其独占锁。导入验证所有来源数据，在同级临时目录写入后原子提交到不存在或为空的目标；来源在准备期间变化时拒绝。同一来源快照的导入回执使重复操作不覆盖后续工作；非空目标和不同快照不会自动合并。

## 影响

旧用户无需卸载或覆盖现有安装。导入是一次性历史索引导入，不能迁移旧 DSH 对话。打开导入工作后需要新建关联会话。项目工作副本仍由原有锁、租约和 Managed Workspace 协议保护；格式改变或自动合并需要另行设计。

验证由 [`import-history.test.mjs`](../../scripts/editor/test/import-history.test.mjs) 覆盖来源保留、绑定重置、幂等、非空目标和未知格式拒绝；完整应用试装由 Harness 验证。操作步骤归 [安装指南](../../INSTALL.md) 维护。
