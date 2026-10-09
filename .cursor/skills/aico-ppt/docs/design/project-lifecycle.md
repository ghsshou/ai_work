# AICO-PPT 项目生命周期

客户端通过 AICO-Harness 公共适配服务使用原装宿主，当前能力为分步归档，原会话恢复尚未支持。共同约束见[当前生命周期契约](../../../AICO-Harness-Plugin/docs/extension-design/project-lifecycle.md)；不再依赖旧修改版宿主文档。

## 身份与会话

一份 Deck 工作项以稳定 `workId` 表示，可显式关联多个会话，活动会话只有一个。多个项目可共享目录，目录不是所有权证据。原始 Deck、工作副本和编辑历史不因项目移除而删除；源文件暂时不可用只改变绑定状态。

任务批次固定所属会话，切换页面不能转移任务。创建会话先持久化 pending 和预分配 ID，重试沿用相同身份；创建成功但关联写入失败时补写，不能再创建第二个会话。普通导航、恢复页面和 ready 重放不发送初始化消息。

首次打开未关联项目时确认是否新建项目会话；取消没有导航、会话或模型副作用。已有显式关联则复用。跨页面选择按 workId 等待目标就绪，迟到事件不能将前一项目当成当前目标。更多当前会话约束与待完成 Fork/修复交互见[会话管理](dsh-deck-workspace-session-management-design.md)。

## 分步移除

`beginRemoval` 保存 removing、稳定 operationId 与精确会话集合；未完成会话创建或编辑锁会拒绝操作。随后调用 `projectSessions({action:'archive',operationId,sessionIds})`。Harness 检查运行、排队和后台任务，逐项归档并保存进度；全部确认后 `completeRemoval` 才更新业务目录。

明确尚未开始的拒绝可以回退当前目录状态；超时或部分完成保留同一操作供重试。已移除项目退出新会话入口，最后一项移除发布空列表，迟到 iframe/目录响应不能复活旧项目。PPT 不声明 ownedWorkspace，不级联注销共享工作区。

忙碌检查不是跨窗口输入锁，固定原装宿主没有旧版批量事务接纳屏障。归档回执也不证明每个动作独占执行，不取消正在运行的任务，不修改原装 registry 文件。

## 重新打开与恢复限制

重新打开原 Deck 可以恢复项目身份并新建会话，旧会话继续归档。恢复原会话先检查能力，当前 `restore: false` 必须在写入 restoring 前拒绝；不能根据旧宿主实现承诺恢复已可用。

创建/打开会话核对宿主就绪、归档集合和工作区登记。缺少列表行不等于会话已删；明确失效登记按版本和原身份修复。普通会话点击不恢复已移除项目。

## 兼容与验证

旧 sidecar 中的空 dsh 占位仅在唯一 provider、空会话/活动指针且无额外字段时受控转换；保留 Deck 历史和身份，未知字段或其他 Agent 会话不自动转换。跨系统路径按现有目录修复，不删除原文件。

使用临时数据验证重复操作、失败回退、部分归档重试、异项目会话拒绝、空列表、迟到消息、重新打开、pending 恢复及打开失败。运行 `npm run test:editor:unit`、`npm run test:dsh-plugin` 和 `node --test scripts/editor/test/dsh-session-navigation.e2e.mjs`。这些分层测试不能替代当前最终包的真实 Desktop 和两种模型连接联合验收。
