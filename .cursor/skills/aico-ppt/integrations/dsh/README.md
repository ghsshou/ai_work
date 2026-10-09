# DSH 插件集成

这里是 AICO-PPT 在 DeepSeek Harness（DSH）中的适配层，不是第二份 Skill，也不是第二套 Editor。普通用户安装原装 DSH Desktop 和 AICO-Harness 适配插件，再通过原装 DSH Terminal 安装完整的 AICO-PPT Windows Beta 包；正式步骤见[安装指南](../../INSTALL.md)。本文的 Web profile 与本地安装命令只用于开发调试。

插件把 DSH 原生对话与原 AICO-PPT Editor 并排组合：左边始终是当前 DSH 会话，右边是可缩放的通用 workbench；AICO-PPT 使用跨 Session 常驻的 `workbench.persistent-view`。Editor 的页面栏、画布、属性栏、区域任务、时间线、固化和导出全部继续运行仓库内原有实现。

| 文件 | 所属平面 | 责任 |
|---|---|---|
| `index.mjs` | Plugin Host | 注册根目录唯一 `SKILL.md`；按 `aicoRuntime` 配置选择私有 Worker 或源码 Editor；向 Client 注入带随机令牌的入口 URL 和品牌资源 |
| `runtime-env.mjs` | 私有运行时 | 校验插件目录内的 Python 与可选私有浏览器，构造独立环境；Node 复用 Host |
| `runtime-host.mjs` / `runtime-worker.mjs` | Worker 生命周期 | 在独立环境中加载原 `startAppServer({ embeddedMode:'dsh' })`，报告实际 loopback URL，等待关闭并处理超时和崩溃 |
| `runtime-run.mjs` | 模型脚本入口 | 优先读取命令中的运行时描述，兼容旧 `.aico-runtime.json`，用同一私有环境运行 `python3` 或 `node`；保留当前工作目录、标准输入和解释器参数 |
| `client.js` | Plugin Client | 在 `sidebar.footer.action` 注册 AICO-PPT 入口；在 `workbench.persistent-view` 注册 iframe 宿主；通过 `ctx.sessionStarts` 向 Harness 的空白会话项目选择器发布 AICO-PPT 分组及其当前优先的确切 Deck 项目；提供 Workspace / Session 创建、打开、查询和精确发送命令 |
| `../../scripts/editor/public/deck-task-coordinator.mjs` | Editor Client | 用 `workId` 协调 WorkCatalog 持久关系与 DSH 原生 Workspace / Session 副作用；处理预分配身份与 pending 恢复 |
| `../../cordis.patch.yml` | Plugin Bundle | 安装时加入 Host/Client 插件行 |
| `brand-spec.md` | UI 设计源 | 记录 Logo、颜色、字体、间距、圆角、阴影与动效来源 |

## 使用逻辑

1. 用户从 DSH 左侧边栏底部、Settings 上方点击 `AICO-PPT`。
2. DSH 保留左侧原生对话，在右侧打开可拖动宽度的 workbench；再次点击关闭，切换 Session 不销毁 Editor iframe。
3. 如果已有活动 Deck，原 App Server 直接恢复该 Editor；否则显示原工作台的“新建 Deck / 修改 Deck”入口和最近任务。
4. 新建 Deck 先用系统目录选择器确定 `projectRoot`；修改 Deck 使用已确认或恢复的项目根。插件按规范目录幂等解析 DSH Workspace，再为工作项创建独立 Session。
5. 原装 DSH 左侧“新会话”进入空白页，由 Harness 在公开 `conversation.input.dock` 插槽提供“选择业务项目”。项目选择器按 AICO-PPT 等业务分组；普通对话直接在原装输入框输入。顶部按钮不是下拉菜单，左下角不再增加创建会话入口。Editor 关闭或当前会话未关联时，已登记项目仍可出现在选择器。每个项目选项显式携带自己的 `workId` 和绑定 revision key；选择项目后按需打开 workbench，先导航到目标页面，目标页面发布同一 key 后才创建，避免旧页面误接请求。已有 `workspaceId` 时直接复用持久关联，不重复等待远端 Workspace 创建。新 Session 在打开前写入“创建/修改 Deck：任务名”的持久中文标题，多会话追加“会话 2/3”序号，并预加载历史窗口；不能根据目录、标题或 `/aico-ppt` 文本猜测关联。
6. 打开已有 Deck 后进入原 Editor Runtime。预览、编辑、区域标记三种一级模式，以及页序、富文本、拖移、缩放、删除、属性、任务、撤销 / 重做、固化和 PPTX 导出均走原来的 Managed Workspace 与 frame bridge。
7. 区域任务点击“交给 Agent”时，Editor Server 在捕获执行批次时固定 `assignedSessionId`，生成带任务 ID、托管工作副本和受控 CLI 备用入口的简洁编辑提示词，并精确提交到该工作项的活动 DSH Session。Agent 先用原生 `aico_ppt` 工具 inspect 获取 revision，再按该版本 edit；区域任务不重复加载完整 Skill。后续切换页面或会话不会迁移在途批次。
8. 点击已关联 Session 会反向找到 `workId` 并切换对应 Editor 工作项；Editor 已关闭时会先重新打开 workbench，Editor 已经显示 AICO-PPT 时重复事件不会再次调用打开或重载 iframe。点击普通 Session 会自动收起 AICO-PPT Workbench，但不改变任何工作项，也不会把后续请求误投到普通 Session。
9. Creation 发布出 Deck 后，同一 Work Item 原位转为 Editing，不产生重复任务卡；项目根不变时保留 `workId`、Workspace 和全部 Session Link，显式换根时历史化旧 Link 并清空旧 Workspace 与活动指针。

项目子菜单根据当前 DSH Session 的持久 `workId` 关联为唯一的对应项显示“当前”徽标；普通会话不会标记任何项目。

## UI 边界

- DSH 拥有：左侧会话、模型选择、审批、计划、消息记录、右 workbench 几何和插件入口。
- AICO-PPT Editor 拥有：顶栏、页序、三种模式、16:9 画布、顶部属性栏、右下角悬浮任务 drawer、Managed Workspace、动作历史、固化和导出。
- Editor 顶部任务会话控件只展示和切换关联会话，不再放第二个创建按钮；修改页在同一区域显示当前 Deck HTML 文件名，完整路径放在悬停说明中。新任务会话统一从 DSH 左侧入口创建。
- DSH 嵌入态不导入或实例化 Agent Terminal，不下发 xterm 资源，不自动启动 `node-pty`，也不连接 `/agent-terminal`；顶栏不再保留重复的机器人 / Agent 入口，执行状态由左侧 DSH 会话与右下任务 drawer 表达。
- WorkCatalog 是 Work Item ↔ Session Link 的唯一权威；DSH 仍是 Workspace、Session 和对话内容的唯一权威。一个 Session 最多关联一个 Work Item，一个 Work Item 可关联多个 Session，但同时只有一个活动 Session。
- WorkCatalog 先写入带预分配 Session 身份的 pending operation，再调用 DSH 创建 Session；响应丢失时重试采用同一身份。`complete-session` 只固化 Link，目标 Session 在 DSH 打开成功后才通过 `activate-session` 切换活动指针；打开失败保留原活动会话。
- Session 创建与打开命令同时携带不超过 DSH 80 字节上限的稳定中文标题；pending 恢复或旧 Link 激活只为尚未命名的 Session 补名，不覆盖用户或 DSH 已经持久化的标题。打开命令非阻塞预加载 Session history window，并立即切换 DSH 当前选择；标题补写和历史连接都不能阻塞 Editor 导航。
- 属性栏在 DSH 嵌入态固定停靠于画布上方，避免占用画布横向空间；任务 drawer 保持原来的右下角悬浮位置。
- Client 只嵌入原 App/Editor 页面，不复制 Editor DOM、业务状态或事务代码。
- 会话提示词单独限制为非空白文本、最多 262144 个 UTF-16 代码单元，以容纳安装目录与页面规划；会话、路径及标题等字段仍保留原有限制。

## 原装宿主中的 Windows 业务运行时

Host 通过公开 Cordis 服务注册 `aicoPptRuntime`，提供 `appUrl`、`views()` 和 `signal`。视图目录由应用维护，包含启动器、编辑器与创建预览，已关闭实例不再列出。私有 Worker 使用关联请求读取同一目录，关闭或崩溃拒绝未完成请求；Host 卸载先撤销提供者生命周期。`apply` 可指定绝对路径 `stateRoot`，源码和 Worker 模式均将最近记录、工作历史与工作目录放在该后端的目录中，不修改全局环境。

Client 检测 AICO 自有准备入口后，等待所选工作台就绪，再同时绑定 iframe 与项目/会话查询；准备失败不会退回本地，准备期间卸载会取消请求。编辑器 HTTP/WebSocket、返回工作台及异步预览地址由适配插件通过自有 Origin 转发；编辑事务和业务进程继续由 PPT 持有。完整传输配置与验证范围见 [适配插件说明](../../../AICO-Harness-Plugin/README.zh.md)。这些入口、目录和生命周期绑定属于必要接入修改，不承诺业务包字节不变。

业务运行时固定在 Windows；工作区路径不转换为 Linux 路径。WSL 模型网关只影响原装模型请求，不承载 Editor、Deck、Agent 工具或插件资源。Chrome 已验证真实 Deck 加载；完整创建预览、文件选择和 Windows 导出仍按独立门禁验收。

## 应用内插件运行时

AICO 2.0 使用原装 DSH Desktop 与配套原装 DSH，先用原版 `dsh plugin` 安装 AICO-Harness 适配插件，再在适配插件提供的 AICO 设置页安装 AICO-PPT。适配层和业务插件分别发布，不再交付 AICO 修改版 Host。当前业务包只发布 Windows Python／浏览器资源；WSL 不安装 AICO-PPT 或其运行时。独立 Skill 与源码安装不要求桌面运行时描述文件。

原装宿主的私有渲染模式调用 `apply(ctx, { aicoRuntime:{ root, paths:{ python, browser } } })`。`aico.release.json` 同步声明这两个平台资源角色，不再依赖旧 Host 的 `desktopRenderer`。Python 和 Chromium 兼容浏览器均为绝对路径，真实普通文件须位于同一资源根目录内。描述对象不接受凭据或任意环境变量。模型命令用 `--runtime-base64` 传递该描述的 JSON 编码，避免 PowerShell 5 原生命令参数丢失 JSON 引号；这只是路径传输编码，不是加密。包装器执行前重新验证描述，不写入插件包目录。未传此参数时才读取旧 `.aico-runtime.json`；显式参数无效时直接失败。Node 使用 `process.execPath`，插件不安装第二份 Node。

Electron 脚本命令在自身进程树内设置 Node 模式。PowerShell 通过管道等待 GUI 子系统的可执行文件结束，传回输出和退出码，并在 finally 中恢复调用方环境；POSIX shell 使用单命令环境。省略 browser 仅保留旧桌面渲染通道兼容，不能证明原装宿主具备该通道。旧 `aico.release.json` 的 `desktopRenderer` 要求不能作为原装发布契约。PPTX 参考材料由标准库工具 `scripts/extract-pptx.py` 提取；运行时拒绝 office 角色并过滤旧 `AICO_SOFFICE_EXECUTABLE`。

Host 在创建 Worker 时传入独立环境，Worker 收到环境后才导入 Editor 模块，并显式传入 `pythonExecutable`。私有 PATH 包含声明的工具、Host Node 和基本系统工具目录；继承的 Python / Node / Playwright 运行时覆盖与凭据变量被移除。私有浏览器模式设置 `AICO_RUNTIME_KIND=plugin` 与受控 `AICO_BROWSER_EXECUTABLE`，移除旧 `AICO_HOME`；`AICO_PPT_EDITOR_STATE_ROOT`、项目 sidecar 和工作副本仍由现有状态解析器管理，插件不修改全局 `process.env`。没有 `aicoRuntime` 时，`apply(ctx)` 沿用源码 Editor 行为。

只有配置桌面运行时的 Skill 定义会在规范正文后追加包装器说明，磁盘上的 `SKILL.md` 不变。包装器允许 `python3` / `node` 的普通参数、`-m` / `-c` / `-e`、stdin 和项目脚本；它只选择环境，命令审批与沙箱仍归 Harness。调用保持原工作目录，文档中的 `scripts/` 相对路径须解析到本 Skill 根目录，输出继续指向用户项目。

可信 sidecar helper 的 Python 冷启动握手单独等待最多 10 秒；握手成功后，普通文件命令仍使用原来的 1 秒预算。启动时限可显式配置，但最多 30 秒；超时仍终止并回收 helper，未得到可信 ACK 不继续打开编辑器。

发行资源验收可设置 `AICO_TEST_BROWSER_DIRECTORY`，并在 `AICO_TEST_PYTHON_DIRECTORY` 与 `AICO_TEST_PYTHON_EXECUTABLE` 中二选一运行 `integrations/dsh/tests/private-browser.integration.mjs`。目录模式复制完整的自包含 Python，适用于最终资源归档；单文件模式只保留轻量开发兼容检查。来源与许可证审计、资源归档安装和 Desktop／WSL 安装流程分别由适配仓库门禁覆盖。

启动失败直接拒绝插件激活；启动后的 Worker 崩溃写入 Host 日志，并使后续页面注入报告失败。移除插件时先请求 `app.close()`，随后等待 Worker 退出；超过 15 秒仍未退出时，等待强制终止完成并报告关闭超时。启动超过 30 秒也会终止并拒绝激活。

### 源码联调（仅开发）

配套 Harness 网页启动器位于其 `tools/dev-web/`，默认使用 `~/.aico-harness-dev-web`，与正式 AICO 应用数据隔离。源码配套安装和启动命令统一见[开发调试说明](../../INSTALL.md#开发调试)。

需要单独验证 DSH 的本地插件安装协议时，从本仓库根目录执行；为此次调试显式指定独立 `DSH_HOME`：

```bash
DSH_HOME="$HOME/.aico-ppt-dsh-dev" dsh plugin --profile web add .
```

这是不带桌面运行时配置的高级源码测试。安装后重新构建，并使用同一开发 `DSH_HOME` 重启 `web` profile；当前 `package.json` 保留 `private: true`，不代表已经发布到公共 registry。

当前适配只支持浏览器与 Editor 都位于同一台机器的 loopback DSH Web；Editor 服务不会暴露到局域网。

DSH 运行时对应 `editor-core` 依赖 Profile；它不因本机缺少 Agent CLI、`node-pty` 或 xterm 而失败。原桌面入口对应 `dev-shell` Profile，仅供开发、回归和故障排查。两者的定位决策见 `../../docs/adr/0010-dsh-primary-and-standalone-dev-shell.md`；Work Item / Workspace / Session 关系见 `../../docs/adr/0004-explicit-dsh-session-links-and-persistent-workbench.md`。

## 验证

```bash
npm run test:dsh-plugin
node --test scripts/editor/test/dsh-embedded-renzhi.e2e.mjs
```

第二条测试复制 `Deck-Projects/renzhi/renzhi-deck.html` 到临时目录，验证 21 页加载、三种模式、顶部属性栏、原任务 drawer、任务转交、历史、固化和导出，并确认源文件字节没有变化。

业务材料缺失时专项测试明确跳过；可用 `AICO_PPT_RENZHI_FIXTURE` 指定实际 Deck，用 `AICO_PPT_RENZHI_PAGE_COUNT` 指定嵌入态专项测试预期页数（默认 21），测试仍只操作副本。

`test:dsh-plugin` 同时验证源码回退、桌面 Skill 追加说明、实际 Worker HTTP 启停、私有环境诊断、异常退出、关闭超时、模型 Node 参数和 Python stdin。运行时描述与子进程夹具全部位于测试独占临时目录；测试不会写入用户插件描述文件。设计决策见 [ADR-0007](../../docs/adr/0007-plugin-private-runtime.md)。

桌面文件与目录选择能力通过 Host 到 Worker 的私有启动参数传递，仅注入系统选择器回调；地址与认证令牌不进入 Worker 通用环境、模型脚本或运行时描述文件。启动时验证通道必须是带认证信息的本机 `/pick` 地址。真实 Worker 到 Electron 对话框桥的回归覆盖 HTML 选择和创建项目目录选择，同时保留无令牌及带浏览器 Origin 请求的拒绝检查。

Creation CLI 每次通过 `--capability-file` 读取 Draft 的本机服务 URL 与凭据；恢复 Draft 时以 0600 权限更新同一路径的动态端口与凭据，无需把秘密写入会话提示或 Host 环境。


### Harness 会话直接编辑

已明确关联 Deck 的 Harness 会话会在每次模型调用前获得当前 Editor 工作区连接，包含受限 action capability 文件与托管工作副本路径；恢复旧会话或重启后重新解析，不依赖固定措辞。用户可直接在左侧讨论或要求修改，讨论只读，明确修改复用右侧同一工作区，无需先提交区域任务或退出 Editor。结构修改按 begin-source-edit / commit-source-edit 事务提交，每批成功后更新预览；事务期间人工写入保持串行保护。未关联会话不注入 Deck 能力，已关联但 Editor 不可用时提示重新打开对应工作区，不另起 headless 编辑器抢占租约。

## 简洁编辑与视觉确认

左侧补充说明的任务归属由 Agent 根据最近追问、原任务描述、标注区域和新消息判断，不按“最近一条”或区域重叠自动绑定。每步上下文提供当前未完成反馈任务的精简列表；补充原任务时 `edit` 传 `taskRelation:"supplement"` 和原 `taskId`，独立新修改传 `taskRelation:"new"` 且不传 `taskId`。有待办却缺少归属选择时，工具返回候选信息且不写入；Agent 能判断就自行选择，歧义才询问用户。新修改不完成旧任务，也不自动把下一批标注并入当前批次。补充的源码修改沿用 `begin-source-task TASK_ID`，不能因消息来自左侧就改用无关联事务。关联修改提交后沿用 Editor 的任务与批次结算；失败、取消和等待澄清不冒充成功。

Harness 中使用原生 `aico_ppt` 工具：`inspect` 返回当前版本、任务、目标、父容器和页面图；`edit` 原样使用 locator、expectedRevision 与稳定 commandId，返回提交状态、受影响页诊断及结果图。普通修改不重读完整 Skill，不额外扩宽或重排版式。`hide` 只隐藏、不补位；DOM 删除与补位走源码事务。

`view` 提供包含未固化动作的 1920×1080、build 全显标准图，不改变用户画布的页码或缩放。它不是现场窗口截图，返回 stateId、revision、renderMode；内容变化使缓存失效。多页提交先返回首个受影响页，其余页按需 view。截图失败时保留已提交状态；使用 `result` 查询原 commandId 后补充 view，不用新命令重交。

CLI 对应 `inspect TASK_ID OUT.png`、`view PAGE_KEY OUT.png`、`result COMMAND_ID`。`verify` 通过只读 `/api/verify` 检查完整历史候选，不推进历史；普通动作诊断及同版本截图通过后无需重复验证。源码事务在提交、撤销和重做时检查有效历史，真实文件仅在固化成功后替换。页面、共享 CSS/脚本的实际差异决定局部结构或完整流程，不能由模型自称“简单”来绕过校验。

普通查看不传 `taskId`；工作项 `workId` 不能当成区域任务 ID。固化期间读取返回明确忙碌状态，避免暴露中间副本。上下文探测的超时或断连不会终止普通问答，但本步禁止使用历史凭据操作 Deck；用户主动取消仍按 Host 的取消语义处理。这些逻辑与分块消息接收优化均为三平台共用实现。

桌面区域任务使用简短说明，同轮相同编辑上下文去重，换工作项、新轮与压缩后恢复必要说明；连接与凭据即时读取。PPT 插件承载协议，Host 只提供通用工具、图片附件和隐藏渲染能力。

私有渲染不修改宿主代码或服务。验证、截图和导出沿用原 PPT Playwright 调用，插件模式缺少浏览器路径时明确报错，不退回系统 Chrome。显式 Windows/Linux 验证命令为 `AICO_TEST_BROWSER_DIRECTORY=<浏览器安装目录> AICO_TEST_PYTHON_EXECUTABLE=<Python可执行文件> node --test integrations/dsh/tests/private-browser.integration.mjs`（Windows 在 PowerShell 设置同名环境变量），只复制测试安装文件到临时目录并调用真实图片导出。它不代表浏览器可再发行、Python 自包含、Windows/WSL 依赖齐全或完整桌面导出验收。

运行时同时固定 `AICO_NODE_EXECUTABLE=process.execPath`；Electron 子进程环境使用 `ELECTRON_RUN_AS_NODE=1`。Python 导出与体检显式使用该可执行文件，避免依赖系统 PATH 中的 node.exe，不修改 Host 环境。


## 2026-09-19：未关联历史项目的显式选择

首页历史项目及 Editor 的“切换项目”先检查同一 Workspace 内的可用会话关联。存在关联则恢复；不存在时显示“此项目尚未关联会话”，取消保持原项目及会话，确认后通过协调器确保 Workspace、创建并持久绑定 Session，再打开项目。初始上下文只发一次。不把正在选中的普通会话当成项目会话。

Editor 的确认意图携带精确 workId 进入启动页，由全局 WorkCatalog 创建目标项目会话。显式导航完成之前忽略旧会话 ready 重放，防止刚选中的目标被旧页面覆盖。顶部空白页主动创建专属会话的导航协议继续单独处理，不弹第二次确认或重复创建。

### 0.1.20：当前视图上下文与任务取消

Editor 将当前页、选区与滚动位置上报到自身服务（变化时更新，空闲时保活；15 秒未更新失效）。`agent/pre-step` 按持久会话绑定注入工作项的最新视图，以及 Creation 交接中的需求摘要、章节与资料路径。显式页码和任务目标优先于当前页；视图不可用且未指定目标时仅返回页面目录，不默认读取第一页。选区在编辑 revision 变化后失效，需重新 inspect。这里提供执行时的最新状态，不承诺原装输入框发送瞬间的快照；不会扫描或全文注入项目。

活动批次的待处理任务仍可点击删除。确认后取消 PPT 本批等待，保留其余任务及现有 Deck 修改，再删除指定记录。面板也提供“取消本批等待”。`aico_ppt` 新增 `tasks`、`delete_task` 和 `cancel_batch`，支持左侧对话执行同样操作。删除必须携带最新 revision，活动任务还需 `cancelActiveBatch:true`。取消不会停止整个 DSH 会话；携带已删除 taskId 的迟到修改会被拒绝。源码事务未结束或任务已有可撤销修改时仍保留原保护，不能以删记录代替撤销修改。

## 0.1.28 编辑性能与协作

`aico_ppt` 新增 `structure`、`catalog` 及局部源码 inspect。局部结构由内置转换器在托管副本中执行，不需要模型生成临时脚本；命令号持久化到 SourceMutation 回执，重复请求不重复提交。原生 action 在准备阶段取消会回滚，日志已提交后保留可查询的成功回执。

首次 agent/pre-step 的目标快照按 workId 和 turn/start 固定，不声称捕获用户发送瞬间。每步仍通过原装公开接口重新解析关联会话；静态操作指令只在每轮或压缩后注入一次，动态版本与任务信息按变化更新。写操作校验 workId，防止工具在途期间转写其他工作项。未提供公开 snapshotEvents 的宿主保留逐步注入和当前视图兼容行为。

右侧 directEdit／transformDrag 优先，结构编辑在短事务期间保留编辑锁；提交前再次确认连接和人工输入状态。工作副本、统一历史、真实源文件和 viewport 保持各自职责，取消不会假装撤销已经提交的内容。隐藏截图服务复用浏览器，每次渲染使用隔离页面；缓存按完整内容和动作失效，查询条件不重新渲染。

## 0.1.29 标注并发修复

无关标注增删改只推进同步 revision，不使 inspect → edit/structure 的内容前提过期。SessionStore 持久化内容边界与逐任务边界，Bridge 在修改队列内再次检查；旧会话按当前版本保守迁移。检查进行中的标注变化同样允许，实际内容变化仍拒绝旧结果。明确拒绝与传输未知分开返回，前者不再要求额外 result 查询。

## 0.1.30 重启协同

`aicoPptRuntime.version` 在模块加载时固定，`restartStatus()` 通过私有 Worker 消息读取业务状态，返回 `{version,safe,reasons}`。Harness 比较 Host 和 Worker 的版本；磁盘包升级不能冒充运行版本升级。

检查不锁画布、不提交输入、不写历史。外层编辑器与画布合并输入、框选说明、属性修改、暂存事务状态；后端检查 Agent 批次、写入、源码事务、固化、导出与恢复。已持久化而未固化的历史允许重启，连接中断或超时则不能确认安全。创建或导入流程暂按整个工作项保守拦截。

该查询是点击前的状态检查；原装系统确认框弹出后发生的新任务不受此查询锁定。仍需先保存、结束任务，再确认重启。
