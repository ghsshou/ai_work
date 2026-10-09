# ADR-0004：Deck 工作项显式关联 DSH 会话，Editor Workbench 跨会话常驻

- 状态：已接受，Fresh Session 主链路已实施
- 日期：2026-09-03

AICO-PPT 使用 `workId` 持久关联 DSH Workspace 和一个或多个 DSH Session，关联只由明确携带 `workId` 的用户动作建立，不根据当前目录、页面、标题或提示词推断。DSH 左侧“新会话”是唯一可见入口：只要 WorkCatalog 中存在可用 Deck，菜单就显示一行带 `AICO-PPT` 标签的一级入口，并在右侧子菜单中把当前关联项目或最近项目放在首项；普通的不关联会话保留在页脚。该入口直接读取常驻 App Server 的项目目录，不依赖 workbench 或关联会话是否处于活动状态。AICO-PPT 通过 DSH 通用 `ctx.sessionStarts` 注册一个默认优先的精确上下文数组，并以包含绑定 revision 的不透明 key 在执行前双重拒绝过期目标；选择项目后按需打开 workbench，跨任务选择必须先导航到目标页面，只有该页面发布同一 key 后才创建。Editor 顶部选择器只展示和切换关联会话。AICO-PPT 使用 root-scope 持久 workbench 在关联 Session 之间保留同一 iframe；普通 Session 会收起该 workbench，重新选择关联 Session 时再恢复。这样牺牲了“当前 Session 自动就是提交目标”的简单实现，换取多 Deck、多会话和在途任务场景下可验证的路由、恢复与状态连续性。

当前实施覆盖目录选择、Workspace 幂等复用、Fresh Session 预分配与 pending 恢复、创建/修改页统一顶栏任务会话选择器、双向导航、普通 Session 隔离、执行批次固定 `assignedSessionId`，以及 Creation → Editing 保持同一 `workId`。DSH 会话选中不得等待历史窗口连接或标题持久化；中文任务标题先作为乐观展示值返回，再在后台补写。iframe 安装运输监听器以及首个业务订阅时都通过 ready 握手要求父 workbench 重放当前会话，并以只读本地快照轮询兜底宿主漏发的选中态通知。启动页跳转到随机端口的修改 Editor 前，必须先从可信启动页向父 workbench 注册精确的本地 Origin；父级不得接受未注册端口或非本地 Origin 的 Bridge 消息。显式返回初始页时忽略旧当前会话的启动重放，只有后续真实会话变化才驱动任务导航；目标会话本来已选中时不得重复 open。Deck 页内目录或标题重绘只刷新状态，不得重放整页定位；只有 canvas 节点身份确实被替换时才恢复页面锚点。

切换、恢复或 ready 重放只允许激活已关联 Session，不得向会话追加“继续”类 Prompt。用户显式点击 Session 时，即使目标就是当前 Session，DSH 也发出根级打开请求；插件通过带令牌的本机只读接口查询 WorkCatalog，只有命中关联且 AICO-PPT 尚未打开时才调用 `open`。异步查询必须以选择 revision 和当前 Session 双重校验，避免快速切换后旧响应误开 Editor；普通 Session 只在当前活动视图是 AICO-PPT 时调用 `close`，不能关闭其他插件视图。初始上下文只由创建 Session 的明确用户动作发送一次；会话选中和页面导航必须保持无 Agent 消息副作用。

DSH Workspace 的 `archivedSessionIds` 是会话归档的权威状态。归档通知即使发生在非当前会话，也必须触发 Editor 重新描述任务会话；命中的 Link 持久化为 `archived`、从创建与修改页选择器移除，若原来是活动会话则清空活动指针，并停止参与 `sessionId → workId` 反向导航。DSH 暂时没有返回某条 Session 列表行不等于归档，仍保留 Link 和 Work Item 中文兜底标题，避免恢复慢或列表未就绪时误删关联。

显式 Fork 暂不开放：DSH 原生 fork 尚不能接收预分配子 Session ID，在补齐可恢复身份协议前不能以可能产生孤儿会话的非幂等流程冒充已完成能力。
