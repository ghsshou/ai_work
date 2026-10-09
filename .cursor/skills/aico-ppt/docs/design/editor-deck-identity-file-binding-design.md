# AICO-PPT Editor 工作项命名、Deck 身份与文件重新绑定设计

> 状态：已接受，核心安全闭环已实现；增强项继续开发
> 日期：2026-08-16
> 范围：启动页编辑工作项、已有 Deck 编辑器、编辑会话、工作副本、源文件监控、固化和恢复
> 不包含：模板 Deck 自身格式重构、云同步、多人协作、跨机器同步

## 0. 结论

Editor 不再把 HTML 文件路径当作 Deck 身份。

- 每份逻辑 Deck 获得稳定的 deckId；
- 启动页每条可继续记录获得稳定的 workId；
- 文件路径只存在于可变化的 FileBinding 中；
- 工作项显示名称与文件名分开，用户可以只改工作项名称而不改文件；
- Editor 通过 FileWitness 判断旧路径和新路径是否仍指向同一个物理文件；
- 外部改名可以唯一确认时自动重新绑定，不能唯一确认时进入保护状态；
- 保护状态下继续保存工作副本、历史和 Agent 上下文，但禁止固化；
- 用户完成重新绑定后，原编辑会话无缝继续；
- 固化必须穿过文件绑定闸门，永远不能直接写入启动时缓存的旧路径；
- 编辑租约只保证 AICO-PPT Editor 体系内的独占写入，不承诺在 macOS 上阻止 Finder 或其他程序改名。

这项设计的首要不变量是：

> 外部文件名和路径可以变化，但 Deck、工作项、工作副本和编辑历史不能因此失去身份；无法确认目标时宁可暂停固化，也不能猜测、覆盖或重新创建旧路径。

### 0.1 当前实现边界（2026-08-16）

已经启用：稳定 workId/deckId、独立显示名称、启动页与工作区内联改名、同目录外部改名自动恢复、Editor 关闭期间改名后恢复原 Session、持久重新绑定提醒、系统文件选择器重新绑定、固化绑定闸门、POSIX 原子 exchange、Windows ReplaceFileW、固化后文件见证持久化，以及 macOS/Windows helper 契约测试。

仍属于后续增强：恢复自动名称、另存为新 Deck、跨可信根移动后的项目目录二次授权、按 deckId 拆分编辑租约，以及完整的 staged transaction 可视化。未实现的增强项不得削弱当前“无法确认即禁止固化”的安全语义。

## 1. 背景与问题

启动页目前把已有 Deck 作为“最近文件”管理，路径同时承担了五种职责：

1. 最近记录的主键；
2. 活动 Editor Runtime 的主键；
3. Session 与 Deck 的匹配条件；
4. 文件监控目标；
5. 固化发布目标。

这使得一次普通的 Finder 改名会被系统误解为“旧 Deck 删除”。用户面对的风险包括：

- 启动页任务条目消失；
- 无法从原任务恢复 Agent 上下文；
- 活动 Editor 仍能编辑工作副本，但不知道新文件在哪里；
- 固化只能向旧路径发起，最终失败或产生路径竞争；
- 用户无法判断工作副本是否安全；
- 任务名称和文件名称被迫绑定，不能独立整理任务。

### 1.1 当前代码事实

本设计基于以下现状，不把目标能力误写成已有能力：

- RecentDeckStore v1 只持久化 deckPath，list() 会过滤已经无法 realpath() 的条目；
- WorkHistoryStore 的 editing 列表完全委托给 RecentDeckStore；
- app-server.mjs 以规范化路径作为 editing runtime key；
- SessionStore 持久化 deckPath，并校验持久化文件名和当前文件名是否一致；
- server.mjs 在启动时捕获固定的 absoluteDeckPath，Agent context、源文件 watcher 和固化都继续使用它；
- 当前 watcher 只观察旧路径内容变化，不观察父目录中的 rename；
- 当前固化事务以固定路径为目标，没有文件重新绑定状态机；
- 当前 SESSION_LOCKED 是 Editor 之间的协作锁，不是 macOS 文件改名强制锁。

所以本需求不是给错误提示换一句文案，而是替换“路径就是身份”这一基础模型。

## 2. 目标与非目标

### 2.1 目标

1. 工作项可以独立重命名，不影响物理文件；
2. 同目录外部改名可在本地 2 秒内自动识别并继续编辑；
3. 可信项目目录内移动或改名可自动识别；
4. 无法唯一识别时保留所有编辑成果并引导用户重新绑定；
5. 重新绑定前禁止固化，不能覆盖不确定文件；
6. 重新绑定后保留同一个工作项、Deck、Session、工作副本、撤销历史和 Agent 对话；
7. 固化与外部改名竞争时，结果必须是安全成功或明确失败，不能静默写错目标；
8. 既有最近 Deck 与 Session 可以幂等迁移；
9. macOS 与 Windows 对用户呈现一致的恢复语义，同时允许 Windows 提供更强的系统级限制；
10. 所有路径安全规则继续成立：拒绝符号链接逃逸、拒绝浏览器任意提交本地路径、只在可信目录中写入。

### 2.2 非目标

- 不实现云端文档 ID；
- 不实现多人同时编辑；
- 不保证识别跨磁盘复制后删除原文件的“伪移动”；
- 不在 macOS 上通过权限或 immutable 标记强制禁止外部改名；
- 不让“修改工作项名称”顺带修改 HTML 文件名；
- 不自动把内容不同的文件认作原 Deck；
- 不自动迁移用户的 Agent 项目目录；
- 不把文件内容哈希当作永久 Deck 身份。

## 3. 领域模型

领域词汇的短定义见仓库根目录 CONTEXT.md。本节描述关系和持久化职责。

~~~mermaid
flowchart LR
  W["Work Item<br/>启动页可继续记录"] -->|editing 引用| D["Deck<br/>稳定 deckId"]
  W -->|creation 引用| C["Creation Draft"]
  D --> B["File Binding<br/>当前源文件位置"]
  B --> S["Source File<br/>独立 HTML"]
  D --> E["Edit Session<br/>历史与 Agent 上下文"]
  E --> WC["Working Copy<br/>未固化成果"]
  D --> L["Edit Lease<br/>Editor 内独占写入"]
~~~

### 3.1 Work Item

WorkItem 是启动页的一条可继续记录，不等于 Agent 内部反馈任务。

~~~ts
type WorkItem = {
  version: 2;
  revision: number;
  workId: string;                 // UUID，稳定主键
  kind: 'creation' | 'editing';
  displayName: string;
  nameSource: 'auto' | 'custom';
  deckId: string | null;          // editing 必有；creation 发布后补齐
  creationRef: {
    projectRoot: string;
    draftId: string;
  } | null;
  provider: AgentProviderId;
  lastOpenedAt: string | null;
  hiddenAt: string | null;
  cachedStatus: WorkItemStatus;
};

type WorkItemStatus =
  | 'ready'
  | 'active'
  | 'needs-rebind'
  | 'conflict'
  | 'unavailable';
~~~

规则：

- workId 不使用路径、文件名或内容哈希生成；
- 一个 deckId 最多对应一个未隐藏的 editing Work Item；
- 删除启动页记录仍是“隐藏记录”，不删除 Deck、Session 或源文件；
- displayName 为 auto 时：editing 跟随文件名（含扩展名），creation 跟随 Brief 标题；
- 用户修改后切换为 custom，以后外部文件改名只更新副标题中的文件名；
- 用户可以选择“恢复跟随文件名”，把 nameSource 改回 auto；
- 工作项名称限制为去除首尾空白后的 1–80 个 Unicode 字符，拒绝换行和控制字符；
- 修改工作项名称不调用文件系统 rename。

### 3.2 Deck

Deck 是逻辑文档身份。

~~~ts
type DeckRecord = {
  version: 2;
  deckId: string;                 // UUID，永不因路径变化而改变
  createdAt: string;
  updatedAt: string;
  storageRoot: string;            // Session/工作副本的稳定存储位置
  activeSessionId: string | null;
  binding: FileBinding;
};
~~~

storageRoot 在 Deck 创建或首次迁移时确定。重新绑定源文件不会立即搬迁工作副本和 Session，避免“改名恢复”同时变成一场状态目录迁移。

### 3.3 File Binding

~~~ts
type FileBindingState =
  | 'bound'
  | 'locating'
  | 'needs-rebind'
  | 'conflict';

type FileBindingReason =
  | 'none'
  | 'renamed'
  | 'moved'
  | 'missing'
  | 'replaced'
  | 'ambiguous'
  | 'permission-denied'
  | 'unsupported-file-type'
  | 'outside-trusted-root'
  | 'publish-race';

type FileBinding = {
  revision: number;
  state: FileBindingState;
  reason: FileBindingReason;
  currentPath: string;
  previousPath: string | null;
  trustedRoot: string;
  witness: FileWitness;
  sourceFingerprint: string;
  lastResolvedAt: string;
  pendingCandidates: RebindCandidate[];
};
~~~

不变量：

1. currentPath 只是 locator，不是 Deck 主键；
2. bound 必须同时满足：路径存在、是普通 HTML 文件、路径安全、见证匹配；
3. locating 是短暂内部状态，不能无限持续；
4. needs-rebind 和 conflict 下禁止固化；
5. 每次路径、见证或绑定状态发生变化都增加 revision；
6. pendingCandidates 只保存安全展示信息，不把未确认路径变成写入目标；
7. 外部内容变化与文件绑定变化是两条正交状态：同一物理文件内容变化仍可保持 bound，再交给已有内容冲突机制处理。

### 3.4 File Witness

~~~ts
type FileWitness =
  | {
      platform: 'posix';
      device: string;             // BigInt 序列化
      inode: string;              // BigInt 序列化
      birthtimeNs: string | null;
    }
  | {
      platform: 'windows';
      volumeSerial: string;
      fileId: string;
      creationTime: string | null;
    };
~~~

判断规则：

- 活动会话内，同卷 rename 后见证相同，可以作为强证据；
- sourceFingerprint 用于内容并发校验，不能单独证明文件身份；
- 只有内容哈希相同但见证不同，最多形成“可能是副本”的候选，不能自动重新绑定；
- 路径相同但见证变化，判定为 replaced，不能继续向该路径固化；
- 见证和创建时间都变化时，不允许用文件名相似度兜底；
- 所有数值身份以字符串持久化，避免 JavaScript Number 精度损失。

### 3.5 Edit Session、Working Copy 与 Edit Lease

- EditSession 继续持有 tasks、groups、redo、diagnostics、Agent workspace 和 source edit；
- Session 持久化 deckId，不再以文件名相同作为恢复前提；
- WorkingCopy 继续位于稳定的 Session 存储目录；
- EditLease 以 deckId 为粒度，而不是锁住整个 .aico-ppt-editor 根目录；
- 同一 deckId 同时只允许一个写入 Runtime；第二个 Editor 返回 DECK_LEASE_HELD，后续可以增加只读打开；
- macOS/POSIX adapter 使用带元数据的 advisory lock；Windows adapter 可额外持有不共享 delete/rename 权限的句柄；
- 进程退出或崩溃后操作系统释放锁，租约文件中的旧元数据只用于诊断，不能永久占用；
- Lease 失效时立即禁止固化，但工作副本仍保留。

## 4. 状态机

~~~mermaid
stateDiagram-v2
  state "needs-rebind" as needs_rebind
  [*] --> bound: 打开并确认源文件
  bound --> locating: 路径通知或见证不匹配
  locating --> bound: 唯一候选自动重新绑定
  locating --> needs_rebind: 未找到候选
  locating --> conflict: 多候选或路径已被替换
  needs_rebind --> bound: 用户选择并确认原文件
  conflict --> bound: 用户明确解决冲突
  bound --> conflict: 同路径变成另一物理文件
  needs_rebind --> [*]: 关闭 Editor，状态持久化
  conflict --> [*]: 关闭 Editor，状态持久化
~~~

### 4.1 状态对应能力

| 状态 | 继续编辑工作副本 | Agent 修改工作副本 | 撤销/重做 | 固化 | 启动页继续任务 |
|---|---:|---:|---:|---:|---:|
| bound | 是 | 是 | 是 | 是 | 是 |
| locating | 是 | 是 | 是 | 暂停 | 是 |
| needs-rebind | 是 | 是 | 是 | 否 | 是，先显示恢复提醒 |
| conflict | 是 | 是 | 是 | 否 | 是，先显示冲突提醒 |

### 4.2 状态原因与用户动作

| 原因 | 自动处理 | 用户主动作 |
|---|---|---|
| renamed | 唯一见证匹配后更新路径 | 无，查看轻提示即可 |
| moved | 可信项目范围内唯一匹配后更新路径 | 超出范围时重新选择项目或文件 |
| missing | 短暂搜索后进入保护状态 | 重新绑定、另存为新 Deck |
| replaced | 绝不自动接受路径上的新文件 | 恢复原文件或明确选择新源文件 |
| ambiguous | 展示候选但不猜测 | 用户选择正确文件 |
| permission-denied | 重试有限次数 | 恢复权限或另存为 |
| unsupported-file-type | 不接受非 .html/.htm 目标 | 恢复扩展名或另存为 |
| publish-race | 保留候选与工作副本并重新对账 | 根据对账结果重试或重新绑定 |

## 5. 外部改名的端到端流程

假设当前源文件是：

~~~text
/Deck-Projects/技术解析.html
~~~

用户在 Finder 中把它改成：

~~~text
/Deck-Projects/昇腾技术解析.html
~~~

### 5.1 正常自动重新绑定

1. Editor 打开时，DeckBindingCoordinator 捕获 deckId、当前路径、文件见证、源文件指纹和 binding revision；
2. 父目录 watcher 收到 rename 类通知；通知只表示“可能变化”，不直接提交状态；
3. Coordinator 串行执行 reconcile()，发现旧路径不存在，进入 locating；
4. 首先扫描原父目录中的普通 .html/.htm 文件并比较文件见证；
5. 找到且只找到一个相同见证的候选；
6. Coordinator 原子更新本地 DeckRecord，把 currentPath 改为新路径并增加 binding revision；
7. 全局 Work Catalog 作为缓存随后更新；若第二步失败，下次读取以本地 DeckRecord 修复缓存；
8. Runtime map 仍以 deckId 索引，因此 Runtime、Session、Working Copy 和 Agent terminal 都不重启；
9. watcher 从旧父目录/路径切换到新绑定；
10. Agent context 的 sourceDeckPath 在下次读取时返回新路径，deckPath 仍指向工作副本；
11. nameSource=auto 的工作项显示名称跟随新文件名；custom 名称保持不变；
12. 前端显示一次轻提示；
13. 下一次固化只允许通过 Coordinator 发布到新路径。

目标体验：用户可以继续输入和操作画布，自动重新绑定不刷新页面、不丢选区、不重启 Agent。

### 5.2 无法自动确认

如果没有唯一见证匹配：

1. 状态从 locating 转为 needs-rebind 或 conflict；
2. 工作副本 watcher、历史记录和 Agent terminal 继续工作；
3. Coordinator 拒绝一切 source publish；
4. Editor 顶部显示持久提醒；
5. 启动页 editing 卡片保留，并显示“需要重新绑定”；
6. 关闭 Editor 时状态与工作副本正常持久化；
7. 下次恢复直接打开原 Session，然后进入重新绑定流程；
8. 用户确认文件后更新绑定，不创建新 Deck 或新任务。

### 5.3 外部改名同时伴随内容修改

见证仍相同时先完成路径重新绑定；如果源文件指纹与 Session 已知基线不同，再进入现有 deck-conflict 内容对账。两种状态不能混成一个“文件丢了”错误：

- 文件绑定回答“现在应该写哪一个物理文件”；
- 内容冲突回答“这个物理文件的内容是否仍是预期版本”。

只有两项都通过，固化闸门才开放。

## 6. 用户重新绑定流程

### 6.1 提醒层级

#### 自动重新绑定成功

非阻断 toast，约 3 秒后消失：

> 已检测到文件改名，已更新为「昇腾技术解析.html」

#### 搜索时间超过 800ms

顶部显示非阻断状态，不弹窗抢焦点：

> 正在确认源文件的新位置，编辑内容仍会保存到工作副本…

#### 需要用户重新绑定

Editor 顶部持续显示、不能自动消失：

> 源文件位置已变化。编辑内容已安全保存在工作副本中，重新绑定前无法固化。

操作：

- 重新绑定文件
- 另存为新 Deck
- 查看详情

允许用户关闭选择器继续编辑，但不提供永久“忽略”状态；顶部提醒和固化禁用状态持续存在。

#### 点击固化

出现阻断式对话框：

> 暂时无法固化
> Editor 不能确认当前源文件。请选择原文件，或把工作副本另存为新的 Deck。

#### 返回启动页或重新启动

工作项不能消失。卡片显示：

~~~text
需要重新绑定 · 工作副本已保存
原位置：…/技术解析.html
~~~

点击卡片恢复原 Session，并优先打开重新绑定引导。

### 6.2 选择与验证

重新绑定必须通过系统文件选择器，浏览器不能提交任意本地路径。

候选分级：

| 候选 | 判断 | 行为 |
|---|---|---|
| 同一文件见证 | 原文件改名或移动 | 直接确认 |
| 见证不同但指纹与最后源版本相同 | 可能是复制件 | 明确提示后允许绑定 |
| 指纹与见证均不同 | 另一份文件 | 默认拒绝覆盖；提供“作为新 Deck 打开” |
| 符号链接、目录、非 HTML | 不可信目标 | 拒绝 |
| 可信根目录之外 | 权限和项目语义变化 | 要求再次确认项目目录 |

重新绑定成功后：

- deckId、workId、sessionId 不变；
- 更新 FileBinding 和 watcher；
- nameSource=auto 时更新显示名称；
- 重新计算源文件指纹并执行内容对账；
- 对账通过后恢复固化；
- 记录一条无正文内容的审计事件。

### 6.3 另存为新 Deck

“另存为新 Deck”发布当前工作副本到用户选择的新文件，并将其绑定为当前 Deck 的新源文件。它不是复制任务：

- 默认保留原 deckId 和工作项；
- 如果用户明确选择“保留原 Deck，同时创建副本”，才生成新的 deckId/workId；
- 不允许覆盖未确认的现有文件；
- 发布成功后才切换绑定。

## 7. 工作项重命名设计

### 7.1 交互

主要入口：

- 新建 Deck 页面左上角标题：点击标题或编辑图标进入改名；
- 已有 Deck 编辑器顶部工作区切换器：当前工作项菜单中改名；
- 启动页工作项卡片菜单：作为通用和恢复入口。

三个入口共享同一 WorkCatalog mutation，不维护页面局部名称。

启动页和工作区菜单增加：

- 重命名任务
- 恢复跟随文件名（仅 nameSource=custom 时显示）
- 从列表隐藏

重命名进入卡片内联输入：

- Enter 或确认按钮提交；
- Escape 取消；
- 空值不提交；
- 保存失败时保留输入并显示原因；
- 辅助文案明确写“仅修改任务名称，不会修改 Deck 文件”。

新建 Deck 左上角显示名称下方继续展示创建进度。改名只改变创建工作项的显示名称，不修改 Brief 标题、draftId、Agent 对话、未来输出文件名或已经生成的 HTML 文件名。

### 7.2 名称跟随规则

| 场景 | auto 名称 | custom 名称 |
|---|---|---|
| 外部文件改名 | 跟随新文件名 | 保持用户名称 |
| 手动重新绑定 | 跟随新文件名 | 保持用户名称 |
| Creation Brief 改名 | 跟随 Brief 标题 | 保持用户名称 |
| 固化 | 不变化 | 不变化 |
| 恢复跟随文件名 | 切换为当前文件名 | 不适用 |

工作项名称不参加文件身份匹配，也不能作为自动重新绑定证据。

## 8. 深模块与接口

文件识别、watcher、重新绑定、租约和安全发布集中在一个深模块 DeckBindingCoordinator。调用者不直接组合 realpath + stat + hash + watcher + publish。

### 8.1 外部接口

~~~ts
type DeckBindingCoordinator = {
  snapshot(): DeckBindingSnapshot;

  reconcile(input?: {
    cause?: 'watcher' | 'resume' | 'before-publish' | 'manual';
  }): Promise<DeckBindingSnapshot>;

  rebind(input: {
    candidatePath: string;
    expectedBindingRevision: number;
    confirmation: 'same-file' | 'verified-copy';
  }): Promise<DeckBindingSnapshot>;

  publishWorkingCopy(input: {
    candidatePath: string;
    expectedBindingRevision: number;
    expectedSourceFingerprint: string;
    expectedWorkingFingerprint: string;
    transactionId: string;
  }): Promise<PublishResult>;

  close(): Promise<void>;
};

type OpenDeckBindingOptions = {
  deckId: string;
  initialBinding: FileBinding;
  storageRoot: string;
  onChange(event: DeckBindingEvent): void;
};
~~~

这个接口隐藏：

- 平台文件身份读取；
- watcher 去抖、丢事件补偿和有界搜索；
- 绑定状态机和 revision；
- 路径安全检查；
- per-Deck 编辑租约；
- 固化前对账、目标 claim、备份、原子发布和崩溃恢复；
- DeckRecord 与 Work Catalog 缓存修复。

调用者只根据快照渲染状态，或提交“重新绑定/发布”的意图。

### 8.2 内部 seam 与 adapter

文件系统差异是一个真实 seam，因为至少存在两套生产行为：

- PosixDeckFileAdapter：macOS/Linux 文件见证、目录 watcher、advisory lease、dir-fd 安全操作；
- WindowsDeckFileAdapter：Windows File ID、目录 watcher、共享模式和安全替换；
- MemoryDeckFileAdapter：状态机和故障注入测试。

这些 adapter 是 Coordinator 的内部 seam，不暴露给 App Server、Editor UI 或 SessionStore。

### 8.3 Work Catalog

启动页使用单独的 WorkCatalog 深模块：

~~~ts
type WorkCatalog = {
  list(): Promise<WorkItemView[]>;
  recordOpened(ref: WorkReference): Promise<WorkItemView>;
  rename(input: {
    workId: string;
    displayName: string;
    expectedRevision: number;
  }): Promise<WorkItemView>;
  followAutomaticName(input: {
    workId: string;
    expectedRevision: number;
  }): Promise<WorkItemView>;
  hide(input: { workId: string; expectedRevision: number }): Promise<void>;
  resolve(workId: string): Promise<WorkResolution>;
};
~~~

RecentDeckStore 和 WorkHistoryStore 的路径拼装、去重和缺失过滤收进这个模块。App Server 不再自行按路径 join 两套历史。

## 9. 监控与识别算法

### 9.1 监控范围

- 始终观察当前源文件的父目录，而不只是源文件路径；
- 同时保留低频轮询作为 watcher 丢事件补偿；
- 收到事件后 150–300ms 去抖，所有 reconcile 串行执行；
- watcher 回调不能直接修改 binding revision；
- 自动重新绑定后关闭旧 watcher，再观察新父目录；
- 工作副本 watcher 与源文件 binding watcher 分离，不能互相阻塞。

### 9.2 搜索顺序

1. 检查当前路径及见证；
2. 检查原父目录中同见证的 HTML 文件；
3. 检查已观察到的 rename 事件候选；
4. 在可信项目根内进行有界搜索；
5. 对见证不同但指纹相同的候选只做提示，不自动绑定；
6. 超过时间、文件数或权限边界后进入 needs-rebind，不无限扫描。

建议约束：

- 同目录目标 2 秒内完成；
- 项目搜索最多检查 10,000 个目录项或 3 秒，以先到者为准；
- 忽略 .git、node_modules、.aico-ppt-editor 和其他隐藏状态目录；
- 先比见证，再只对少量候选计算 SHA-256；
- 大小写不敏感文件系统仍使用目录返回的实际拼写更新 UI；
- case-only rename 必须视为合法路径变化。

### 9.3 分类规则

~~~text
当前路径存在 + witness 相同          => bound
当前路径不存在 + 唯一同 witness 候选 => renamed/moved，自动 rebind
当前路径存在 + witness 不同          => conflict/replaced
无 witness 候选                     => needs-rebind/missing
多个同 witness 候选                 => conflict/ambiguous
仅有同 fingerprint 候选             => needs-rebind，等待用户确认副本
~~~

## 10. 固化安全协议

### 10.1 固化闸门

任何固化必须同时满足：

1. Edit Lease 有效；
2. binding state 为 bound；
3. 调用方的 expectedBindingRevision 等于当前 revision；
4. 当前路径见证仍匹配；
5. 源文件指纹等于 expectedSourceFingerprint；
6. 工作副本指纹等于 expectedWorkingFingerprint；
7. 工作副本验证通过；
8. 没有未解决的内容冲突或 source edit transaction。

任一条件失败都不发布，并返回可恢复错误。

### 10.2 不能直接 os.replace(candidate, oldPath)

“先 stat 旧路径，再 replace”仍存在竞态：外部 rename 可能在两步之间先完成，随后 Editor 会把 candidate 写回旧文件名，制造用户没有要求的新文件。

目标协议使用“原文件仍存在才允许原子替换”的 claim 语义。当前实现按平台采用 POSIX 原子 exchange 和 Windows ReplaceFileW：

1. 在当前绑定的源文件父目录内准备唯一 candidate，写入、校验并 fsync；
2. 记录 transaction prepared；
3. POSIX 把 candidate 与当前绑定路径原子 exchange；Windows 用 ReplaceFileW 将当前绑定路径原子换成 candidate，并把旧目标移到唯一 exchange backup；
4. 校验交换后保留的旧目标见证/指纹仍是预期源文件，同时校验新目标是 candidate；
5. 如果外部 rename 先发生，第 3 步因旧路径不存在而失败，Editor 不会创建旧路径；
6. 如果路径上的文件已被替换，见证校验失败，优先恢复被误 claim 的文件并进入 conflict；
7. 校验通过后删除临时 exchange 文件；交换本身已经完成 candidate 发布；
8. candidate 的见证提前记录，因此即使发布后立刻被外部改名，恢复流程仍可定位它；
9. fsync 目录，记录 published；
10. 更新新源指纹、文件见证和 binding revision；
11. 固化 Session 历史，把需要长期保留的 backup 归档到 storageRoot，清理源目录 transaction 文件并记录 finalized。

外部操作和 Editor commit 的顺序由文件系统原子操作决定：

- 外部 rename 先赢：固化安全失败并重新定位；
- Editor claim 先赢：外部对旧路径的 rename 失败或发生在发布完成之后，随后 watcher 正常重新绑定；
- 不存在“外部 rename 已成功，Editor 又悄悄重建旧路径”的允许结果。

### 10.3 崩溃恢复

transaction 记录至少包含：

~~~ts
type BindingPublishTransaction = {
  transactionId: string;
  deckId: string;
  bindingRevision: number;
  sourcePath: string;
  expectedSourceWitness: FileWitness;
  expectedSourceFingerprint: string;
  candidatePath: string;
  candidateWitness: FileWitness;
  candidateFingerprint: string;
  backupPath: string;
  stage: 'prepared' | 'source-claimed' | 'published' | 'finalized';
};
~~~

恢复规则：

- prepared：删除未发布 candidate，源文件不变；
- source-claimed 且目标为空：验证 backup 后恢复源文件；
- source-claimed 且目标已有其他文件：不覆盖，进入人工恢复；
- published：验证目标或按 candidate witness 定位，补写 binding/session 状态；
- 无法确认是否提交：标记 RECOVERY_REQUIRED，保留 backup、candidate 和工作副本。

## 11. 持久化布局与权威性

### 11.1 全局 Work Catalog

~~~text
~/.aico-ppt-editor/
  work-catalog.json    # schema v2，Work Item 权威记录 + Deck binding 缓存
~~~

Work Catalog 是 displayName、nameSource、隐藏状态和最近打开顺序的权威来源。它保存 binding cache，目的是启动时能定位本地 DeckRecord，但不是固化的最终权威。

### 11.2 本地 Deck 状态

~~~text
<storage-root>/.aico-ppt-editor/
  decks.json
  leases/
    deck-<deckId>.lock
  sessions/
    <sessionId>/
      session.json
      working/deck.html
      working/versions/
      backups/
      transactions/
      snapshots/
      attachments/
~~~

decks.json 是 deckId 与 FileBinding 的本地权威。session.json 引用 deckId，不再要求目录名或源文件 basename 匹配。

既有 Session 首次迁移时可以继续留在旧目录；registry 记录 sessionRelativePath。第一阶段不批量搬迁大型工作副本、备份和附件，以降低迁移风险。

### 11.3 双记录修复顺序

1. 活动 Editor 以本地 decks.json 为 binding 权威；
2. 绑定事务先提交本地 DeckRecord；
3. 再更新全局 Work Catalog cache；
4. 如果第 3 步失败，Editor 仍可继续安全工作；
5. 下次 WorkCatalog.list() 读取本地记录并修复 cache；
6. 如果本地记录不可访问，只展示最后已知状态并要求用户定位，不能从 cache 直接固化。

## 12. 浏览器接口与事件

### 12.1 App Server

~~~text
GET   /api/work-items
PATCH /api/work-items/:workId
POST  /api/work-items/:workId/follow-auto-name
POST  /api/work-items/:workId/hide
POST  /api/work-items/:workId/resume
POST  /api/work-items/:workId/choose-rebind-file
POST  /api/work-items/:workId/save-as
~~~

PATCH 请求示例：

~~~json
{
  "expectedRevision": 7,
  "displayName": "昇腾技术解析"
}
~~~

文件选择接口由服务端调用系统 picker，不接受网页传入任意绝对路径。

### 12.2 Editor Server

~~~text
GET  /api/deck-binding
POST /api/deck-binding/reconcile
POST /api/deck-binding/choose-file
POST /api/deck-binding/save-as
~~~

固化继续使用现有 /api/solidify-deck，但请求增加 expectedBindingRevision，后端改为调用 DeckBindingCoordinator.publishWorkingCopy()。

### 12.3 WebSocket 事件

~~~ts
type DeckBindingEvent = {
  type: 'deck-binding-changed';
  deckId: string;
  binding: FileBindingPublicView;
  transition:
    | 'locating'
    | 'auto-rebound'
    | 'rebind-required'
    | 'conflict'
    | 'manual-rebound'
    | 'publish-reconciled';
};
~~~

事件必须带 binding revision。前端忽略旧 revision，避免 watcher 延迟消息覆盖新状态。

### 12.4 稳定错误码

| 错误码 | HTTP | 含义 |
|---|---:|---|
| DECK_LEASE_HELD | 409 | 另一 Editor 持有写入租约 |
| DECK_LEASE_LOST | 409 | 当前 Runtime 已失去租约 |
| DECK_BINDING_REVISION_CONFLICT | 409 | 使用了陈旧 binding revision |
| DECK_REBIND_REQUIRED | 409 | 源文件未定位，禁止固化 |
| DECK_BINDING_AMBIGUOUS | 409 | 存在多个候选 |
| DECK_SOURCE_REPLACED | 409 | 当前路径已是另一物理文件 |
| DECK_BINDING_UNSAFE | 400 | 候选路径不可信 |
| DECK_PUBLISH_RACE | 409 | 外部文件操作赢得发布竞争 |
| DECK_BINDING_RECOVERY_REQUIRED | 503 | 发布状态无法自动确认 |

错误响应同时返回最新 public binding snapshot，前端不需要再猜测下一步。

## 13. 现有模块改造映射

| 当前位置 | 当前职责 | 目标变化 |
|---|---|---|
| recent-deck-store.mjs | path-keyed 最近文件 | 迁移进 WorkCatalog，以 workId/deckId 管理 |
| work-history-store.mjs | 拼接 creation/editing | 改为 WorkCatalog 的兼容入口或删除浅代理 |
| app-server.mjs | 以 real path 索引 Runtime | 以 deckId 索引，路径从 binding snapshot 读取 |
| session-store.mjs | session 持有固定 deckPath | 持有 deckId + binding revision 快照 |
| server.mjs | 捕获 absoluteDeckPath | 注入 DeckBindingCoordinator，所有源文件操作穿过其接口 |
| working-deck-store.mjs | 托管工作副本 | 保持职责，不负责寻找源文件 |
| sidecar-io.mjs/.py | 固定 deck name 的可信 I/O | 成为平台 adapter 的底层实现，增加 witness/claim/rebind 命令 |
| public/editor.mjs | 固化与临时 notice | 渲染持久 binding banner、阻断固化和重绑定流程 |
| app-public/app.mjs | 以 deckPath 操作任务 | 改为 workId，增加任务改名和绑定状态 |

实现时禁止出现以下退化：

- UI 自己调用 stat() 或判断候选；
- App Server 和 Editor Server 各维护一套 binding 状态机；
- watcher 回调直接修改 Session JSON；
- 固化代码在 Coordinator 外读取 currentPath 后自行写文件；
- 用 displayName 或文件 stem 作为身份；
- 为通过测试把不可信路径检查降级。

## 14. 迁移设计

### 14.1 Work Catalog v1 → v2

对于每个可访问的 v1 deckPath：

1. 读取真实路径、普通文件状态、见证和指纹；
2. 从匹配 Session registry 中复用或生成 deckId；
3. 生成 workId；
4. displayName 使用文件名（含扩展名），nameSource=auto；
5. 写入本地 DeckRecord；
6. 写入 v2 Work Catalog；
7. 保留 provider、lastOpenedAt 和隐藏记录语义。

对于已经缺失的 v1 路径：

- 不再直接从列表删除；
- 若能找到关联 Session，生成 needs-rebind Work Item；
- 若完全没有 Session 或本地记录，保留 legacy unresolved 指针并提示定位；
- 用户隐藏后才从可见列表移除。

### 14.2 Session 迁移

- 给 registry entry 和 session.json 增加 deckId；
- 初次迁移记录当前 binding revision；
- 移除“持久化 basename 必须等于当前 basename”的恢复前提；
- 旧 Session 目录原地使用，通过 registry 的相对路径定位；
- migration 使用同目录临时文件、fsync 和 rename；
- migration 带版本号且幂等，崩溃后重复执行得到同一 deckId/workId；
- 迁移失败时保留 v1 文件并停止进入可写 Editor，不做半迁移固化。

### 14.3 兼容期

- v2 读取器兼容 v1；
- 一旦成功写入 v2，不再由旧路径扫描覆盖 v2 binding；
- /api/recent-decks 在一个版本周期内可以从 WorkCatalog 投影视图，内部不再使用它作为权威；
- 完成所有入口切换后再删除 v1 写路径。

## 15. 安全与隐私

1. 服务仍只监听 loopback，并验证 browser token；
2. 文件 picker 返回值在服务端验证，页面不能构造绝对路径；
3. 绑定候选必须是普通文件，拒绝符号链接和路径逃逸；
4. 自动搜索不离开 trusted root；
5. “确认项目目录”与“确认源文件”是两个不同授权，不能互相替代；
6. 日志可以记录 deckId、状态原因、耗时和脱敏 basename，不记录 Deck 正文；
7. 错误信息默认只显示用户可理解的短路径，详情页再显示完整路径；
8. Work Catalog 权限保持仅当前用户可读写；
9. backup、candidate 和 working copy 继续使用可信 sidecar I/O 与 no-follow 校验。

## 16. 性能与流畅性要求

- watcher 和 hash 不运行在浏览器主线程；
- 正常文字编辑、拖动和工具栏操作不等待源文件 reconcile；
- 同目录 rename 从通知到 UI 更新目标 P95 ≤ 2 秒；
- binding 处于 locating 时，工作副本编辑延迟不增加；
- 不为每个文件系统事件递归扫描整个项目；
- 同一时间最多一个 reconcile 和一个 publish transaction；
- 重复事件合并，状态不变时不增加 revision、不广播；
- 哈希只用于有限候选和固化并发校验；
- 关闭 Editor 时等待已经开始的状态持久化，但不等待新的项目扫描。

## 17. 可观测性

结构化事件：

~~~text
deck_binding_opened
deck_binding_locating
deck_binding_auto_rebound
deck_binding_rebind_required
deck_binding_conflict
deck_binding_manual_rebound
deck_publish_blocked
deck_publish_race
deck_publish_recovered
deck_lease_acquired
deck_lease_released
~~~

每条事件包含：deckId、binding revision、reason、platform、durationMs；路径只记录 basename 或 hash。UI 不依赖日志驱动状态。

## 18. 测试策略

测试面是 DeckBindingCoordinator 和 WorkCatalog 的公开接口，不测试内部 watcher 函数或私有扫描步骤。

### 18.1 WorkCatalog 测试

- v1 路径记录幂等迁移为稳定 workId/deckId；
- 编辑工作项改名后文件名不变；
- custom 名称不跟随外部文件改名；
- 恢复自动命名后跟随当前文件名；
- 缺失路径的工作项仍被列出并标记 needs-rebind；
- 隐藏工作项不删除 Session/Working Copy；
- 并发 rename 使用 revision conflict 防止旧写覆盖新写。

### 18.2 Coordinator 状态测试

- 同目录普通 rename 自动重新绑定；
- Unicode、空格和 case-only rename；
- 可信项目内移动；
- 移到项目外进入 needs-rebind；
- 删除源文件进入 needs-rebind；
- 原路径被另一文件占用进入 replaced conflict；
- 复制为新文件后删除原文件不自动猜测；
- 多个内容相同候选进入 ambiguous；
- 权限临时失败不会丢失工作副本；
- watcher 重复、乱序和丢事件仍由 reconcile 收敛；
- 重新绑定使用陈旧 revision 被拒绝；
- 关闭重启后恢复同一状态。

### 18.3 固化竞争与故障注入

- rename 发生在固化 preflight 前：自动重新绑定后发布新路径；
- rename 发生在 preflight 后、claim 前：固化返回 race，不创建旧路径；
- Editor claim 先完成：外部 rename 不会破坏 transaction；
- 路径被替换后固化：不覆盖替换文件；
- 崩溃发生在 prepared/source-claimed/published 每个阶段；
- fsync、rename、registry 写入、Work Catalog cache 写入分别失败；
- ACK 丢失但实际已提交时可以通过 transaction 对账；
- backup 恢复不能覆盖新出现的其他文件；
- Windows delete-sharing 和 POSIX advisory lease 行为分别验证。

### 18.4 浏览器 E2E

- 自动改名只显示 toast，不抢输入焦点；
- 手动重新绑定显示持久 banner；
- 保护状态下编辑、Undo/Redo、Agent terminal 可用；
- 保护状态下固化按钮禁用，直接请求也被后端拒绝；
- 首页卡片保留并显示“工作副本已保存”；
- 重新绑定后 iframe、当前页、选区和任务抽屉不重置；
- 任务重命名、取消、错误恢复和“恢复跟随文件名”；
- 关闭并重开后提醒仍在，完成绑定后消失。

### 18.5 验收不变量

以下任一失败都阻止发布该功能：

1. 外部改名后旧路径不得被 Editor 静默重新创建；
2. 无法确定源文件时不得固化；
3. 工作副本、历史、附件和 Agent 上下文不得因改名丢失；
4. 用户重新绑定不得创建第二个编辑工作项；
5. 修改工作项名称不得修改源文件；
6. 同一 Deck 不得出现两个同时可写的 Runtime；
7. 绑定状态必须在后端权威校验，不能只靠按钮禁用；
8. v1 migration 必须可重复执行且不改变源 Deck 内容。

### 18.6 跨平台执行矩阵

| 层级 | macOS | Windows |
|---|---|---|
| WorkCatalog / Coordinator 状态机 | Node 全量单元测试 | 同一套 Node 测试，串行执行 |
| 文件身份 | dev/inode + birthtime | volume serial + File ID + creation time |
| 安全发布 | renameatx_np 原子 exchange 故障注入 | ReplaceFileW 调用契约 + Windows helper 集成 |
| Python/编码 | UTF-8 helper 全量 | UTF-8/GBK、长路径、launcher 与 helper 测试 |
| 浏览器交互 | Chrome E2E 全量 | Chrome E2E 全量，真实 Windows 验收机执行 |

两端统一执行：

~~~text
npm run test:editor:unit
npm run test:editor:python
npm run test:editor:e2e
~~~

Windows 原生验收不能由 macOS 上的兼容后端冒充。合并前必须在 Windows 机器再次执行上述三条命令；macOS 本机结果与 Windows 契约结果分别记录。

## 19. 开发分期

### Phase 1：身份与目录模型

- 实现 WorkCatalog v2；
- 引入 workId/deckId；
- 完成 v1 最近记录和 Session lazy migration；
- Runtime map 从 path key 切换为 deckId；
- 实现工作项独立改名；
- 保持旧路径行为，但所有固化请求开始携带 binding revision。

完成标准：路径不再是工作项和 Runtime 主键，既有任务无损迁移。

### Phase 2：DeckBindingCoordinator 基础

- 实现平台 FileWitness adapter；
- per-Deck Edit Lease；
- 当前路径验证、状态持久化和 resume reconcile；
- 父目录 watcher、同目录 rename 自动重新绑定；
- WebSocket binding 事件。

完成标准：Editor 打开期间，同目录外部改名可无刷新继续工作。

### Phase 3：安全固化协议

- 所有固化穿过 Coordinator；
- 实现 claim-before-publish；
- transaction 分阶段记录和崩溃恢复；
- 移除对启动时 absoluteDeckPath 的写入依赖；
- 完成 rename/publish race 故障注入测试。

完成标准：外部 rename 赢得竞争时，Editor 不会重新创建旧路径。

### Phase 4：重新绑定与完整提醒

- 持久 banner、固化阻断对话框；
- 系统文件 picker 和候选验证；
- 首页 needs-rebind/conflict 状态；
- 另存为新 Deck；
- 关闭、重启和恢复体验。

完成标准：任何无法自动识别的场景都有明确恢复入口，用户无需寻找工作副本。

### Phase 5：项目内移动、Windows 与兼容收口

- 可信项目根有界搜索；
- Windows File ID 与共享模式；
- legacy API 只读投影并最终移除旧写路径；
- 性能、跨平台、全量 Editor 回归；
- 同步 docs/architecture.md、README 和相关用户文档。

完成标准：macOS/Windows 的恢复语义一致，全部验收不变量通过。

## 20. 开发顺序与提交边界

建议每个阶段至少拆成“状态模型/持久化”“后端行为”“前端交互”“迁移/回归”四类小提交。功能在 Phase 3 完成前不得默认开启自动重新绑定，因为只更新 UI 路径而固化仍写旧路径会形成更危险的半实现。

推荐的最小安全启用顺序：

~~~text
稳定身份
  → binding 状态与固化阻断
  → 安全 publish
  → 自动重新绑定
  → 手动恢复 UI
  → 项目范围搜索
~~~

实现期间保留一条显式兼容开关，只用于开发和回滚；v2 schema 一旦写入必须仍能被关闭开关后的版本安全识别为“不可写”，不能退回 v1 覆盖。

## 21. 评审清单

开发开始前确认以下决策：

- [x] Deck 身份采用稳定 deckId，路径只作为 FileBinding；
- [x] 工作项名称独立于文件名，改任务名称不改文件；
- [x] auto 名称跟随文件名，custom 名称不跟随；
- [x] 同一文件见证的外部改名自动重新绑定；
- [x] 只有内容哈希相同但见证不同的文件需要用户确认；
- [x] 无法确认时允许继续编辑工作副本，但禁止固化；
- [x] 手动重新绑定提醒持续存在，不能永久忽略；
- [x] macOS 不承诺阻止外部改名；
- [x] 固化使用 claim 语义，外部 rename 先完成时不重建旧路径；
- [x] 第一阶段不搬迁既有大型 Session 目录；
- [x] 核心功能通过对应闸门后启用；增强项继续按分期推进。

以上决策已于 2026-08-16 确认，ADR-0001 已同步为 accepted；Phase 1–3 的核心安全闭环与 Phase 4 的重新绑定提醒已落地，剩余增强项见 0.1。
