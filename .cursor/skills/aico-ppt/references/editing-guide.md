# editing-guide.md — 独立版结构、edit-bundle.py 用法与验证工作流

## DSH 普通修改的短路径

已关联的右侧 Editor 就绪时，用 `aico_ppt` 读取和修改。一次本轮目标快照固定首次执行时的页面；右侧后续翻页只影响浏览。用户明确指定的新目标仍按指令检查。写操作带回 inspect 的 `workId`、`expectedRevision` 和稳定 target，会话切换、旧 revision 或人工正在输入时拒绝写入。

| 任务 | 理解范围 | 工具路径 |
| --- | --- | --- |
| 改文字、颜色、位置、尺寸、显隐 | 目标元素及父容器；仅需本页 | inspect → edit |
| 改形状、换图、插入／复制／删除模块 | 目标与直接关联元素；通常本页 | inspect → structure |
| 替换局部 HTML | 有界目标源码；保留原 data-editor-id | inspect(detail:"source",target) → structure |
| 多页一致化或引用衔接 | catalog + 相关页；按依赖决定邻页 | 分页 inspect → 批量 edit／structure |
| 整页增删排序、共享样式／脚本、复杂动画 | 涉及页面、导航和共享依赖 | 下述源码事务与编辑脚本 |

`structure` 支持 setShape、replaceImage、replaceFragment、insertFragment、duplicateElement、deleteElement，整个 operations 数组成为一个可撤销事务。候选校验、完整历史重放、提交、回执由服务完成；失败或提交前取消恢复工作副本。右侧文字输入／拖拽冲突时等待完成，不能通过刷新消除用户草稿。提交回执为成功且结果图对应相同 revision 时结束；无需再 task／verify。回执不明用 result(commandId)，图片待检查用 view；不要重新执行已提交命令。结果图最多自动返回前三个受影响页，其余由 remainingViewPages 指示。

默认 inspect 只返回 4 个目标候选，必要时通过 query／limit／offset 展开；view 只返回图及版本信息。同一内容版本的检索与看图复用渲染缓存。这里缩小的是 Agent 的读取范围，结构提交仍校验完整有效历史，固化仍执行完整发布校验。


deck 是一个「独立版」单文件 HTML：React 运行时、字体、全部图片都内联在文件里，真离线可用。代价是**不能用普通文本编辑器直接改 bundle 那两行超长 JSON**——结构编辑要经 `scripts/edit-bundle.py`，结构稳定后的细节修改走统一 action。所有命令均在 skill 根目录（`aico-ppt/`）执行。Managed Workspace 自动维护工作副本、版本和发布备份；只有经典直改 fallback 才需要调用者自己先备份目标文件。

## 0. 从零新建与后期可视化微调

产品入口：独立 Skill 不依赖 AICO-Harness，完成第一版后交付 HTML 和验证结果，不自动打开桌面编辑器。可视化编辑统一从 AICO-Harness 的 AICO-PPT 插件进入；`tools/dev-shell/` 中的启动器和下文 PTY 说明仅适用于维护者调试。默认 `scripts/install.py install` 只注册 Skill，调试环境才加 `--dev-shell`。

完整应用通过 AICO-Harness 的配套安装器安装，使用独立 AICO 数据目录与系统分配端口；已有 DSH 和全局 Skill 无需卸载。安装和旧历史导入条件见 [安装指南](../INSTALL.md)。

### DSH 与桌面入口的会话边界

DSH 插件和独立桌面入口共享本章的 Deck / Managed Workspace、frame bridge 与操作逻辑，但不共享对话宿主。DSH 是正式窗口壳；桌面入口是开发、回归和故障排查用的 `dev-shell`，保留自己的 Agent PTY。DSH 插件绝不能导入或实例化 Agent Terminal、加载 xterm、自动启动 `node-pty` 或连接 `/agent-terminal` WebSocket。用户明确创建任务会话时才发送 Skill 引用提示词；已有工作区的区域任务使用带任务 ID、工作副本及受控 CLI 备用入口的简洁编辑协议，由原生 `aico_ppt` 的 inspect 获取 revision 后再 edit，不重复读取完整 Skill。恢复、任务切换和 Session 切换不得再次发送提示词。跨任务恢复可以经过启动器内部路由，但过渡文档必须在首屏前隐藏启动初始页。`$aico-ppt` 只用于使用该语法的独立 Codex 流程。页面栏、三种模式、画布、属性、任务、撤销 / 重做、固化和导出属于 Editor；模型选择、聊天记录、审批、计划和执行状态属于 DSH。

DSH Client 不重写 Editor。它从左侧边栏底部打开通用右侧 workbench，并在其中嵌入原 App Server / Editor Runtime；因此直接文字与富文本、拖移、缩放、删除、区域标记、统一历史、Managed Workspace 固化与 PPTX 导出和桌面入口使用同一实现。嵌入态只改变布局与 Agent Adapter：属性栏固定在画布上方，任务 drawer 仍悬浮在右下角，原 provider 选择器和 PTY 不显示。实现边界见 `../integrations/dsh/README.md`。

### 0.1 什么时候使用

Skill 是否有窗口，与是否使用 Mutation 是两件事。修改已经存在的合法 Deck 时使用以下路由：

| 运行方式 | 进入条件 | 修改目标 | 历史与发布 |
|---|---|---|---|
| 活动 Managed Workspace | 已有 `AICO_PPT_EDITOR_URL` / `AICO_PPT_EDITOR_TOKEN` | action API + `AICO_PPT_WORKING_PATH` | 统一 revision、撤销 / 重做，显式 solidify |
| 无窗口 Managed Workspace | 没有窗口，但本机运行时可用 | 同上；后台 Chrome 只承载 frame bridge | 与窗口模式完全相同 |
| 经典直改 fallback | 用户明确不要后台运行时，或依赖确实不可用 | 真实 Deck，经 `edit-bundle.py` | 无 Mutation、无跨轮撤销、无 solidify；不得静默降级 |

无窗口模式用统一启动器启动；进程首行 JSON 返回 `url`、普通 `token`、`workingDeckPath` 和权限为 0600 的 `capabilityPath`：

```bash
python3 scripts/deck-editor.py /absolute/path/to/deck.html --headless-workspace
export AICO_PPT_WORKSPACE_CAPABILITY_FILE=/absolute/path/to/workspace-capability.json
node scripts/editor/cli.mjs status
```

后台 Chrome 连接的是与可见 Editor 相同的固定前端资源和 frame bridge，不是另一套简化 DOM 引擎；它不打开 UI，也不启动 Agent 终端。因此两种 Managed Workspace 的 locator、diagnostics、Mutation、固化和错误码完全一致。

桌面工作台有两条入口：“新建 Deck”把主题讨论、大纲确认、页面规划和 staging 生成放在同一页面；“打开已有 Deck”直接进入后期微调。新建工作区左侧只有“需求已收敛 / 大纲已形成 / 页面已规划 / Deck 已出现”四个只读里程碑，右侧复用真实 PTY；里程碑不可点击，前三段没有中间表单、章节卡片、页面卡片或确认按钮。`draft.json` 是完整状态的权威记录，四个里程碑文件是耐久回执；Agent 的受控 creation CLI 命令必须携带 `expectedRevision`，终端 ANSI 文本不作为状态来源。已确认需求变化会使大纲与页面规划失效，已确认大纲变化会使页面规划失效，生成中则锁住结构修改。合法 Deck 出现前 PTY 占据主区域；出现后才展开中间画布，并接入 Managed Workspace。

工作项显示名称不等于源文件名。新建页左上角、启动卡片和工作区切换器中的改名只更新 Work Catalog，不修改 HTML 文件。源文件在 Finder 或资源管理器中被改名时，Editor 通过稳定 `deckId` 与文件见证寻找同一物理文件：唯一命中就自动跟随，并继续使用原工作副本、撤销历史、任务和 Agent 会话；无法唯一命中就进入“需要重新绑定”，工作副本继续安全保存但 `solidify` 被阻断。重新绑定必须使用系统文件选择器，成功后原地恢复，不创建重复工作项。若固化已经成功、但 Work Catalog 的新文件见证没有写回，活动 Editor 会重新检查当前物理文件并补写；冷启动只在同一 `deckId`、当前源文件指纹和最近固化检查点完全一致时自动恢复，不能用旧检查点接纳外部替换。固化请求还必须携带当前 binding revision，确保发布目标不是启动时缓存的旧路径。

这两条只是**初始状态入口**，不是两套 Skill 规范：新建入口在合法 bundle 出现前多做需求、大纲和页面规划，已有 Deck 入口从合法 bundle 直接开始；一旦存在合法 bundle，二者原样复用同一质量契约、Managed Workspace、Mutation、验证与固化路径。任何设计、文案、字体、卡片、动画、配图和验收要求都不得按“新建 / 修改”分支维护。

新建流程把 Draft 保存在 `<项目目录>/.aico-ppt-editor/drafts/<draft-id>/`。页面刷新后恢复当前步骤；生成先在 Draft 的 `staging/` 创建模板副本、`plan.md`、只读 `page-plan-contract.json` 与目录契约，随后立即为该 staging 源文件启动与后期编辑器相同的 Managed Workspace。创建页嵌入的是完整 Editor Runtime 的纯画布视图：结构制作经 `scripts/edit-bundle.py` 修改托管 `working/deck.html`，已有元素细节经 Editor CLI action 提交，两类修改共享 revision、编辑时间线、自动刷新与发布闸门。Agent 每次安全保存工作副本后画布自动更新，不得要求用户刷新页面。`generation-ready` 会先 flush 尚未入历史的外部保存，经固化预检后发布到 staging，再由服务逐页核对 PagePlan 的页数、顺序、页型、pageId、chapterId 与 label，并独立执行 `eb.verify`、目录动画契约与 `measure_overflow --all`；任一不一致都停止发布并保留 staging，最终 HTML 或 plan 已存在时也拒绝覆盖。发布前画布以 staging Managed Workspace 为权威；发布成功后关闭 staging 运行时，并立即为最终 Deck 建立标准 Managed Workspace，创建页改为嵌入后者。点击“进入微调编辑器”只把这个既有运行时从创建页移交给修改页，不重新调用 Editor Server，因此两页共享相同 working Deck、WebSocket、revision、编辑时间线和 Agent PTY。Editor session 会生成不含短期 token 的 `creation-context.json`，记录来源 Draft ID、已确认 brief / outline / pagePlan、发布 plan、素材目录与诊断目录。活动 PTY 收到一次不重复加载 Skill 的阶段切换说明和新的受控 CLI 地址；将来旧会话不可恢复而创建新会话时，初始化也必须先加载该上下文。

可视化编辑器用于制作后期：页面结构和顺序已经确认，只剩精确位置、字号观感、短文案与跨页修改清单。批量替换、增删页或大范围结构重构仍由 Agent 经 `scripts/edit-bundle.py` 完成。

重复启动不会再打开第二个工作台页面；如果旧页面已经关闭，则先结束无页面的旧服务，再启动加载当前资源快照的新服务。

macOS 可直接在维护者调试时双击 `tools/dev-shell/AICO-PPT Dev Shell.app`。Windows 首次双击 `tools/dev-shell/AICO-PPT Dev Shell.cmd` 会在同目录生成带图标的 `AICO-PPT Dev Shell（Windows）.lnk`，之后可直接使用快捷方式；也可以把一份 deck HTML 拖到 Windows `.cmd` 或快捷方式上直接打开。快捷方式仅保存当前机器的绝对路径并被 Git 忽略，移动仓库后删除旧 `.lnk`、再次运行 `.cmd` 即可重建。两个入口都转交同一个 `scripts/deck-editor.py --app`，不另建编辑或写回实现；Windows `.cmd` 增加 `--detach-windows`，只短时派发隐藏的标准 Python 进程，随后退出，不保留常驻控制台或 Python 任务栏窗口。Python 启动器用进程 ID、随机令牌和 loopback 健康检查维护原子实例登记表。macOS 重复启动时先按原 URL 或“AICO-PPT”标题定位并激活已有 Chrome / Safari 标签页。Windows 重复启动时先读取 App Server 的鉴权页面租约：有活动租约时尽力通过 UI Automation 激活 Chrome / Edge / Firefox，无法激活也绝不新开第二页；页面已经关闭时则结束宽限期内的旧 service，等待 owner 释放登记后重新启动。页面切换产生的瞬时退租会短暂复查，避免在工作台跳转 Editor 时误重启。明确确认标签已经关闭时，先向无页面的旧 service 发送退出信号并等待 owner 释放登记，再启动加载当前固定资源快照的新 App Server。陈旧登记只有在 owner 和 service 确实失效后才允许接管；新旧服务不会同时争抢同一 Deck 锁。健康检查不继承系统 HTTP 代理，避免把可用的 `127.0.0.1` 服务误判为失效并启动第二套服务。应用先打开本地工作台：新建 Deck 通过系统目录选择器确认 Agent 项目目录；打开已有 Deck 使用系统文件选择器添加一份 HTML。区域任务附件也直接调用 macOS / Windows 的系统原生选择器，网页只负责业务确认，不自行浏览本地文件系统。macOS 桌面入口不弹终端；Windows `.cmd` 最多短暂显示派发窗口，常驻 Python / Node、依赖安装与系统选择器子进程都以隐藏窗口运行。首次运行会按 `package-lock.json` 自动补齐 Node 模块。Node.js ^18.19 或 ≥20.6 和 Python 3 不会由应用安装，缺失时会显示原生错误对话框。

工作台顶栏的“开始使用 / 帮助 / 安装与诊断”在未选择 Deck 时也可用。“开始使用”保存一份本机清单，并把 `assets/training-deck.html` 复制到用户选择的新示例目录后再进入现有打开流程；它绝不修改模板原件。“帮助”从 `docs/user-guide/` 读取 Markdown。“安装与诊断”按 `editor-core`、`dev-shell`、`verify`、`pptx-export`、`pptx-read`、`materials` 分组调用 `scripts/check_deps.py` 的结构化结果；本机 Agent CLI、PTY 或材料能力缺失只标记对应 Profile，不得把 DSH Editor Core 判为不可用。

页面租约由一次 HTTP 登记和一条持续 WebSocket 连接组成。正常关页发送 `pagehide` beacon；浏览器崩溃、强制退出或 beacon 丢失时，连接关闭会在 5 秒重连宽限后触发 App Server 的统一 `close()`，连同所有后台 Editor、Agent PTY、writer 与 sidecar helper 一并回收。HTTP 登记后 15 秒未完成 WebSocket 握手也会回收，覆盖浏览器在页面脚本加载前崩溃的窗口。工作台跳转 Editor 时新页面使用相同租约身份重新连接，关闭计时随即取消。

Windows 本地项目可位于任意本地盘符；网络共享或 Parallels 共享目录也不要求固定盘符。编辑器保留可信真实路径用于 identity 校验，同时只把通过同一目录 `dev/ino` 复核的盘符路径交给注册表中 Agent 的 PTY。若看到“UNC 路径不受支持”，说明当前启动仍没有可用盘符映射；先在 Windows 中把共享目录映射为任意盘符，再重新启动编辑器，不能继续让 CMD 使用默认的 `C:\Windows`。

Windows sidecar 的真实文件操作使用 extended-length path，但 identity、registry 和界面仍保存普通盘符 / UNC 形式；因此新建 Deck 的 Draft staging、临时工作副本和原子写入不会再受传统 260 字符路径限制。Editor 的所有 Node → Python 入口统一经 `scripts/editor/python-utf8.mjs` 设置 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8` 与 Windows `windowsHide`：sidecar、附件 writer、新建校验、工作副本 / 固化 adapter 的 stdin、stdout、stderr 都不继承 Windows 控制台 GBK/ACP，也不会额外创建控制台窗口。bundle 写回还会合并合法 surrogate pair，并把孤立 surrogate 重新转成 JSON `\uXXXX`，避免中文、emoji、浏览器 locator 或错误提示在 Windows / macOS 交换操作时损坏。桌面入口默认自动选择本机已安装的 Codex / Claude Code / OpenCode；只有 Claude Code 时直接选择 Claude。Codex 或 Claude Code 恢复持久会话时，若可见 CLI 明确报告会话 ID 不存在，Editor 自动创建并持久化替代会话，保留工作副本和待办；网络、登录或其他启动错误不会误清绑定。三种 CLI 的就绪检测都 fail-closed：Codex 0.148 的早期草稿框要等模型与工作目录完整状态栏，Claude Code 要等 Ink 画出的空 `❯` 输入行和光标，OpenCode 要等 `Ask anything` placeholder 与可见光标；启动 banner、长历史恢复和 PTY `running` 都不会误投任务。恢复旧会话时，首个真实输入框出现前必须持续显示恢复遮罩，同时阻断人工键盘输入与 Agent 任务提交；任务按钮保持禁用，服务端 `POST /api/agent-runs` 也以 `AGENT_TERMINAL_RESUMING` 拒绝绕过界面的请求。若 Codex 恢复时已经画出最终输入占位符和光标、却仍残留陈旧的 `model: loading`，终端只自动执行一次一行尺寸重绘并恢复原尺寸；重绘本身不算就绪，仍须等待后续真实模型状态通过同一输入态闸门。Codex 的普通更新通知继续保持遮罩直到真实输入框出现；只有同时要求按键继续的更新面板才投影为 `interactionRequired: {kind: "codex-update"}`，暂时收起遮罩并仅开放终端输入，Agent 任务仍保持阻断。Codex 恢复会话目录与当前项目根不一致时，目录选择页投影为 `interactionRequired: {kind: "working-directory-selection"}`；其他带明确高亮编号项、至少两个编号选项和操作提示的未知 CLI 选择页走 `terminal-selection` 兜底。两者都撤掉遮罩并开放原始键盘，但继续阻断初始化 Prompt 和 Agent 任务，直到正常输入框出现。Windows ConPTY 对三者都把正文按 UTF-8 字节拆成不超过 512 B 的 bracketed-paste 分块并逐块节流，完整写入、单独关闭 paste 后才延迟发送 Enter，Claude Code 额外保留较长的 Ink 渲染等待。Enter 之后只有 CLI 活动区重绘或处理中信号才是接收回执；1.5 秒无回执重试一次，再失败就明确提示手动提交，并在下一条任务前重新等待真实提示符。

维护者调试入口保留：`python3 scripts/deck-editor.py <deck.html>`。以下可见窗口命令仅用于明确调试；独立 Skill 制作使用前述无窗口 Managed Workspace：

```bash
python3 scripts/check_deps.py --profile dev-shell --check-only
python3 scripts/deck-editor.py <deck.html>

# 真实项目示例
python3 scripts/deck-editor.py Deck-Projects/renzhi/renzhi-deck.html
```

不传 `deck` 或显式使用 `--choose` 都会打开一次性网页导入页，不会立即弹出文件选择器；`--host`、`--port`、`--no-open` 保持兼容。不要把测试内部的 `--keep-temp` 当作用户参数。默认监听 `127.0.0.1` 并自动打开浏览器。带路径的编辑服务终端会输出一行 JSON，其中的 `url` 与 `token` 供外部 Agent 连接。桌面模式在编辑器浏览器页关闭 10 秒后自动退出；带路径的命令式入口不改变原生命周期，仍由调用者用 `Ctrl+C` 结束。

仅当维护者明确调试 macOS Dev Shell 时才使用：

```bash
open -n "tools/dev-shell/AICO-PPT Dev Shell.app" --args --agent-thread-id "$CODEX_THREAD_ID" "$(pwd)/my-deck.html"
```

添加 Deck 后，先在导入页核对可见的项目根目录，确认后才进入工作台。项目目录优先使用本次显式选择，其次使用有效的历史设置；两者都没有时，默认使用 HTML 实际文件的直接父目录，不按启动器工作目录、Git 根或工作区标记向上查找。点击“更改目录”会从当前已配置目录打开系统选择器；取消保留现配置，再次更改从最新配置目录打开。范围过宽时仍需确认；目录身份校验失败时须重新选择。默认不需要绑定既有会话：Editor 打开时就在后台启动新的 Codex / Claude Code / OpenCode 会话，并在首个 Prompt 中把当前 `aico-ppt` Skill 加载一次；打开终端只是接入已经运行的 runtime。项目根与活动 provider 存放在独立 `agent-workspace.json`，由 `workspaceRevision` 管理；更改它们不增加 Deck revision，也不进入撤销 / 重做和固化队列。其他 Agent 仍可直接使用 Skill 与普通 action capability，只是不进入窗口化自动终端支持范围。

右上角显示真实 PTY 状态，点击后从右侧推出唯一的 Agent 交互终端；没有结构化对话页签、消息气泡或独立消息输入框。终端抽屉与属性面板同高，默认宽度为浏览器窗口的三分之一；左边界可拖动，向左加宽会压缩中间画布，任务 drawer 同步向内避让。Codex 固定使用 `codex --dangerously-bypass-approvals-and-sandbox`，Claude Code 固定使用 `claude --dangerously-skip-permissions`，OpenCode 固定使用 `opencode`；`cc` 在 macOS 上可能是 C 编译器，因此实现不得把它当作 Claude executable。若任一 CLI 首屏询问是否 trust 当前目录，`AgentTerminalSession` 会保持初始 Prompt 为 pending、允许用户操作信任选择，并通过 `interactionRequired: directory-trust` 让新建页和编辑页自动展开右侧终端；Codex 恢复目录选择使用 `working-directory-selection`，其他带明确高亮编号项、至少两个编号选项和操作提示的未知 CLI 选择页使用 `terminal-selection`。这些交互状态都显示“等待确认”且终端标题脉冲提醒，加载遮罩不会挡住选择。只有用户确认后 CLI 绘出正常输入框，初始化 Prompt 或任务才会使用 bracketed paste 写入并单独回车；任务批次的就绪等待也受同一闸门约束。Editor 启动后即在已确认的项目根目录后台创建新 CLI 会话并加载一次 `aico-ppt` Skill；刷新浏览器只重连同一 PTY，任务批次直接写入这个终端。终端是 Editor 的实时交互视图，但任务完成、Deck action、撤销与固化仍以 sidecar 为权威。Windows / Linux 的 `Ctrl+V` 只粘贴一次剪贴板文字；有文字选区时，`Ctrl+C` 由浏览器复制且不向 PTY 发送 `0x03`，没有选区时仍发送终端中断。macOS 继续使用原生 `Cmd+C` / `Cmd+V` 路径。界面不提供高级设置或“连接已有会话”，也不扫描历史会话；旧绑定数据只在首次迁移 sidecar 时静默吸收。

任务关闭后再打开不应重新询问创建时已确认的项目根。最近 Deck 记录会持久化该目录；旧 Creation 记录缺失时从与发布 Deck 相互校验的 `creation-context.json` 补齐。若用户明确改选其他根，Editor 会保留旧会话历史并在新根下创建新会话，不跨目录 resume。Codex 目录选择页只是异常兜底；正常流程不需要再选一次。

### 0.2 三种一级模式

`待确认` 专指 Agent 的修改动作命中多个可能目标、无法安全决定具体对象。drawer 不显示没有实际行为的“确认”按钮，而是在任务行展示“目标定位不唯一”的原因、支持 reduced-motion 的间歇醒目提醒和“补充说明”入口；补充具体位置或对象并保存后，任务回到待处理，可重新交给 Agent。

三种一级模式依次为：预览、编辑、区域标记。原来的文字、移动、缩放已经合并到“编辑”，不需要来回切换工具。

| 模式 | 使用方式 | 结果 |
|---|---|---|
| 预览 | 浏览、切页，不拦截 deck 原有交互 | 不产生动作 |
| 编辑 | 文字内部保持文本光标，单击放置光标、按住拖选；红色选框边缘显示抓取手势并移动整个元素；右下控制点缩放；`Escape` 取消 | 分别创建 `setText`、`translate` 或 `resize` 动作组；边缘移动超过 7 个屏幕像素才启动，过滤点击抖动 |
| 区域标记 | 在 1920×1080 页面上区域拉框，在选区旁侧输入修改说明 | 创建带归一化区域、候选 locator 和可选 PNG 快照的任务 |

处于编辑模式时，可以按住 `R` 临时切换到区域标记；完成拉框后松开 `R` 会自动回到编辑模式，已打开的标注输入框继续保留。临时 `R` 快捷键按物理 `KeyR` 识别，中文输入法组合态也有效；焦点位于直接文字编辑、任务说明或其他真实输入框时，`R` 保持普通输入，不触发临时模式。

区域任务可以跨页连续添加；左侧文字页序列表的 badge 只统计待处理、处理中、失败和待确认任务，完成项不再保留页码标号。右下角 Agent 任务 drawer 负责任务记录、定位和状态展示，可定位回原页和原区域。已完成任务默认收进闭合的“已完成”分组；任务一旦完成就永久保持 `completed`，未固化时展开后显示当前效果对应的“撤销”或“重做”按钮，操作只切换修改效果，不会把任务放回未完成列表、恢复页码 badge 或再次提交给 Agent；固化后完成项仍保留供查看，但历史按钮随固化检查点清除。待处理、失败和待确认任务可在任务行二次编辑说明或经二次确认删除；编辑后回到待处理，删除同步清理对应局部截图与附件。当前执行批次的任务禁止改删；批次运行期间新增的“下一批 · 新标注”仍可继续编辑和删除，未固化完成项保持锁定。直接文字、移动、缩放与 Agent 动作进入同一 `EditTimeline`，因此共享 revision、唯一历史游标和固化边界。

任务完成时把实际关联的 entryId、影响页和修改类型摘要写入任务记录；drawer 展示这份提交时事实，不再根据当前页面能否匹配旧 pageKey 反推“页面已删除”。后续删页、换页或恢复页面只改变当前定位能力；不会把原本的删字、改样式任务批量误标为整页删除。

编辑模式中的文字编辑范围始终复用单击后出现的红色选框。单击框内普通文字或局部加粗 / 着色片段时，唯一的 `contenteditable` 挂在红框对应的整个独立布局盒上，不会因 `strong`、`span` 或运行时局部格式包装拆成多个编辑框；浏览器默认事件负责放置光标和鼠标拖选。对同时包含普通文字、格式片段和 `<br>` 的混排段落，编辑期间保留原 DOM；提交时对结构仍稳定的实际改动文本节点生成 childNodes `textPath` 动作，因此未改片段的格式与换行在刷新、撤销和重做后仍保留。局部格式包装在样式覆盖或撤销时可能拆装；历史 `textPath` 因此失效时，运行时只在同一个红框文字盒内按动作保存的修改前原文做唯一匹配，匹配重复时拒绝猜测，避免把内容改到错误片段。若用户整段替换并改变了富文本结构，则按整个文字盒提交纯文本；全选删除时空字符串也是合法的新内容，不会被提交层当成取消后恢复原文。链接本身、按钮、表单、SVG、iframe、layer 组件与图片内文字不会伪装成普通可编辑文字；这类目标继续使用区域标记交给 Agent。

整框选中文字时，属性面板也会遍历框内全部文字运行段：内部字重、颜色、字体等不一致时显示混合态，下一次整框字形操作按完整字符范围统一，而不是只修改外层盒导致内部 `span` 继续覆盖。结束双击编辑会同步恢复已经记录的权威格式动作，不存在先恢复原 HTML、稍后才补回格式的可交互空窗。Deck 运行时重新就绪时，左侧页序按 page key / 页码复用已有按钮并先保持当前页高亮，不再清空列表后异步重建。

拖选文字后，右侧属性面板与选区旁浮动工具条共享同一个持续编辑会话：修改格式不会结束 `contenteditable`，动作落盘后会按绝对字符范围恢复浏览器原生 Range、焦点和选中高亮，可继续输入或连续修改。属性面板提供字体、字重、斜体、下划线、字号、文字颜色、左 / 中 / 右对齐、项目符号和行距；浮动工具条提供字体、`B/I/U`、字号增减、颜色和对齐。右侧停靠布局把控件归入“文字 / 段落 / 外观 / 更多”四个互斥手风琴，默认展开最相关的一组，对象摘要固定在滚动区上方，恢复操作固定在底部。终端展开后，属性面板停靠到画布上方；字体、字号与 `B/I/U` 保持单行常驻，段落、外观和更多通过互斥下拉抽屉展开，点击外部或按 `Escape` 关闭，所有支持宽度均不产生横向滚动。`Cmd/Ctrl+B`、`Cmd/Ctrl+I`、`Cmd/Ctrl+U` 同时支持局部选区和单击选中的整个文字盒。表格单元格按独立 `TD` 文字盒命中，格式与直接改字不会把整张 `TABLE` 变成目标。跨越不同格式运行段时，按钮显示 mixed 三态；统一格式会按原格式运行段拆分为可逆动作，避免只读取起点样式。局部包装产生的零长度文本节点会立即清理且不参与 mixed 判定；权威动作编译时，同一属性的重叠范围按后写覆盖，并把相邻同值范围合并成互不重叠的最终运行段。字号与行距等同一控件在 3 秒内的连续提交仍增加 revision，但追加到同一个人工历史组，一次撤销回到手势开始前。

页面栏和属性面板只使用一套开合箭头：30px 圆形白底、统一阴影与 CSS chevron。PillNav hover 保留液态填充但禁用箭头的上下翻页副本；页面栏展开 / 收起朝左 / 右，右侧属性面板展开 / 收起朝右 / 左，顶部属性面板展开 / 收起朝上 / 下，并通过旋转同一枚箭头过渡。

顶栏的“撤销 / 重做”只移动编辑时间线的唯一历史游标，覆盖人工文字、移动、缩放、Agent 动作和结构修改；也可使用 `Cmd/Ctrl+Z` 撤销、`Cmd/Ctrl+Shift+Z` 重做，Windows 额外兼容 `Ctrl+Y`。焦点位于文字、任务说明或连接输入框时保留浏览器原生撤销，不会操作 Deck 全局历史。新修改总是从当前游标追加，并截断游标之后的旧重做分支。所有带 revision 的写操作先登记已经写盘的 SourceMutation；如果 Agent 的文件修改先发生，旧人工动作、撤销 / 重做或固化会先返回 revision 冲突，不会跨过真实顺序继续执行。源码基线后的旧 action 只有在几何、语义指纹以及语义规范化后的当前 `before` / `after` 值仍一致时才重放；颜色表示差异不会制造假冲突，同一属性已被 Agent 改写、元素已替换或文字范围变化时则以 `HISTORY_DIVERGED` 安全停止。任务行撤销非末尾 Agent ActionMutation 时追加补偿修改，保留后续仍成立的修改；补偿本身可由顶栏按顺序撤销 / 重做，涉及 SourceMutation 或无法证明安全时返回 `COMPENSATION_CONFLICT`。这些历史操作只更新完成任务的 `effectState=active|undone`，绝不把状态降回 `pending`。区域任务可选择文件（支持多选和连续追加）或粘贴图片，粘贴图片会转为 PNG；每个任务最多 8 个附件，单个文件最大 25 MiB。浏览器无法取得原文件绝对路径，服务会把副本复制到 sidecar 会话的 `attachments/`。只有任务 payload 的序列化出口会派生路径：`GET /api/tasks`、`GET /api/tasks/<TASK_ID>`、`POST /api/tasks` 响应中的 `task`、`task-created` / `task-updated` 等事件或动作响应中的 `task`，以及 CLI `tasks` / `task`；这些出口返回副本绝对 path，供外部 Agent 读取。`GET /api/session` 与磁盘 `session.json` 只含 sidecar 相对 `relativePath`，不保存、也不返回附件绝对路径。附件不进入最终 deck，并随 sidecar 生命周期管理，也不属于 Deck 动作的撤销 / 重做范围。

任何历史连续性或补偿冲突都必须在界面显示，不能静默覆盖当前 Deck，也不能用空 `catch` 隐藏分叉。

固化后的离线补丁与可见 Editor 的实时重放使用同一规则，不会为发布路径放宽 locator、语义指纹或前后值校验。

编辑器打开时默认进入区域标记，左侧页面栏默认折叠为窄页码轨道，可按顶部箭头展开完整标题。区域说明弹窗可选“继续添加任务”只保存当前标记，或选“直接提交任务”将累计的全部待完成任务作为一批交给 Agent。区域标记模式下按住 `R` 会临时进入预览，可直接操作 Deck 内按钮，松开后恢复区域标记；输入控件继续把 `R` 当普通文字。拉框时会把当前页的 layer、分步显示、展开项等交互状态写入任务，定位任务时先恢复标记画面，再显示原区域。历史 Deck 的 `data-mod` 目录仍可兼容恢复，但三套当前模板与新页面统一使用固定 DOM 的 layer 协议。Deck 内导航与主舞台滚动也会主动同步左侧当前页，同页内容重绘不会再触发页面重定位，缩略图副本不参与页面身份。

任务批次执行期间，可以直接在右侧 Agent CLI 按独立的 `Esc` 停止本轮。编辑器会同步退出“Agent 正在处理”状态，把未完成成员保留到“批次 N · 未完成”，并提供“重新提交本批未完成任务”与“合并到下一批”两个显式入口；右侧长期 PTY 不会因此关闭。方向键、功能键等多字节控制序列不算独立 Esc，不会误取消批次。

启动页的两个新任务入口会等待会话恢复完成后启用。画布缩小时，小文字的拖动和缩放热区向外避让文字中心，不缩小手柄的屏幕点击尺寸。宽高调整与 CSS scale 分别保存历史基线，连续使用两者时都保留，并支持独立撤销 / 重做。

### 0.3 外部 Agent 协作与撤销 / 重做

打开已有历史后若第一次快捷键发生在权威 session 尚未返回的窗口，编辑器会保留一个待执行意图并在加载完成后立即撤销或重做，不需要先点一次顶栏按钮。

已完成任务可直接从 drawer 撤销或重做修改效果：时间线末尾任务执行普通 `undo` / `redo`，非末尾 Agent ActionMutation 追加补偿修改；任务始终留在“已完成”且不会重新进入 Agent 队列。全局 `undo` 也可通过 CLI 或 HTTP 执行，`redo` 通过 HTTP 执行。

外部 Codex / Claude Code / Agent 不是内置聊天机器人。drawer 的“交给 Agent 处理下一批”向 `POST /api/agent-runs` 提交当前 revision 和下一批候选任务 ID；服务端先在同一 mutation queue 中持久化成员不可变的执行批次，再启动 Agent，`GET /api/agent-runs/current` 与 `agent-run-updated` 事件同时投影活动批次、下一批候选和历史批次剩余任务。同一时间只允许一批运行；按钮之后新增的任务不会混入当前批次。终端出现 Codex steer 输入框时回合仍是 active，只有真正回到空闲输入态才开放下一批提交；失败、取消或重启后的未完成成员保留原批次归属，不自动并入新标注。

Agent 通过原生 aico_ppt 工具或 CLI / HTTP 调用同一套受控接口：`GET /api/session` 读取 status，`GET /api/tasks` 读取任务，`GET /api/text-locations` 定位文字节点，`POST /api/actions` 提交带 `commandId` 的幂等动作命令，`POST /api/source-edits` 开始源码事务，`POST /api/source-edits/<SOURCE_EDIT_ID>/commit|cancel` 提交或取消事务，`POST /api/groups/<GROUP_ID>/undo` 与 `POST /api/groups/<GROUP_ID>/redo` 执行 undo / redo，`POST /api/verify` 只读验证完整历史候选，旧 `POST /api/write-deck` 保留兼容检查点语义。显式正式发布先调用 `POST /api/solidify-preflight`，再携带一次性令牌调用 `POST /api/solidify-deck`。可见 Editor 由用户点击“固化修改”确认；无窗口 Skill 在用户要求完成 / 保存 / 正式写入时由 Agent 显式调用 `solidify`，若用户要求仅预览则不得固化。相同 `commandId` 和相同 payload 的动作重试返回首次结果；同 ID 不同 payload 返回 `COMMAND_ID_REUSED`。observer WebSocket 使用 `/events`，仅订阅服务事件；唯一 editor capability WebSocket 只在 parent 与服务之间传递 frame 事务命令和 ACK，不对外提交动作。真实 PTY 使用独立 `/agent-terminal` capability WebSocket；浏览器只允许选择产品注册表中的 Codex / Claude Code / OpenCode、发送键盘输入和终端尺寸，不能提交 executable、额外参数、环境变量或历史会话 ID。provider 未安装或未登录时必须返回清晰错误，不能静默切到 Codex。

```bash
# Editor 内嵌 Agent 已自动获得 URL / token；无窗口模式可使用 capabilityPath
export AICO_PPT_WORKSPACE_CAPABILITY_FILE=/absolute/path/to/workspace-capability.json
node scripts/editor/cli.mjs revision  # 只读权威 revision（Agent 批处理优先）
node scripts/editor/cli.mjs status    # 完整会话状态（人工诊断）
node scripts/editor/cli.mjs tasks
node scripts/editor/cli.mjs task TASK_ID
node scripts/editor/cli.mjs locate-text "待查文字"
node scripts/editor/cli.mjs replace-text "旧文字" "新文字"
node scripts/editor/cli.mjs apply actions.json
node scripts/editor/cli.mjs begin-source-edit                # 自由结构修改：返回 sourceEditId / revision
node scripts/editor/cli.mjs begin-source-task TASK_ID        # 区域结构任务：返回 sourceEditId / revision
node scripts/editor/cli.mjs --expected-revision N commit-source-edit SOURCE_EDIT_ID
node scripts/editor/cli.mjs --expected-revision N cancel-source-edit SOURCE_EDIT_ID
node scripts/editor/cli.mjs undo GROUP_ID
node scripts/editor/cli.mjs redo GROUP_ID
node scripts/editor/cli.mjs verify
node scripts/editor/cli.mjs solidify
```

`replace-text` 先通过当前 browser frame 搜索实际文字节点，仅在 locator 与文字出现次数均唯一时自动提交 `setText`；多处同名或跨运行段匹配会返回候选并拒绝猜测。`apply` 的动作类型限于 `setText`、`setStyle`、`translate`、`resize`、`hide`、`show`，并必须带当前 `expectedRevision`（传数组时 CLI 会先读取 revision）。`undo` / `redo`、`verify` / `solidify` 都支持 `--expected-revision`；不传时 CLI 会先读取当前 revision。撤销 / 重做都会让受控 frame 按权威动作集合或工作副本版本恢复，不是单纯反改 DOM。

### 0.4 保存会话不等于正式写回

Editor 启动时通过可信 sidecar 把真实 source deck 复制为 `.aico-ppt-editor/<session>/working/deck.html`；旧 Deck 在这份副本中一次性补齐持久 `data-page-id`，真实 Deck 在整个会话中只读。重开会话时，服务先从工作副本读取唯一、可解析的内嵌补丁块并与 `session.solidifiedActions` 对账，再迁移页面身份；不一致时只修复已固化基线，当前编辑时间线不变，避免旧版编码损坏在下一次固化时覆盖正确补丁。session v2 的权威历史是 `timeline.entries` 与唯一 `timeline.cursor`，`groups / redo` 只作为兼容投影视图；旧版 active 空洞会在加载时线性化，无法证明有效的 redo 放入 `historyMigration` 归档。浏览器中的直接编辑先作用于运行时，并把任务、动作、诊断与工作副本版本自动持久化到 sidecar；`working/versions/<sha256>.html` 是结构历史的恢复源。若当前 `working/deck.html` 因写入中断而无法解析，启动会按 `session.workingDeckFingerprint` 恢复严格匹配的最后有效版本，并保留坏候选供诊断；找不到匹配版本时拒绝猜测。该目录不进入最终交付 deck；本仓库已在 `.gitignore` 忽略提交，若 deck 位于其他仓库，也应加入同名规则。

统一历史包含两类记录：

- `ActionMutation`：已有元素的文字、文字格式、移动、缩放、隐藏和显示。它保存稳定 locator 与 before / after，通过 browser runtime 重放；区域任务、画布直接编辑和终端 `replace-text` / `apply` 最终都走这一类。
- `SourceMutation`：模板升级、复杂 DOM 或动画重构、整页插入 / 删除 / 排序。Agent 必须先创建源码事务，再用 `scripts/edit-bundle.py` 修改 `AICO_PPT_WORKING_PATH`，显式 commit 时读取可信字节、验证 pageId 与 slide / section / nav 三处同步后，以前后 SHA-256 记录整个工作副本版本并刷新 iframe。Agent 不得修改 `AICO_PPT_SOURCE_PATH`，也不得手工编辑离线补丁块。

Agent 结构修改必须先执行 `begin-source-edit`（区域任务使用 `begin-source-task`）取得 `sourceEditId` 与预留 revision，成功后才能写工作副本，写盘完成必须执行 `commit-source-edit`；提交在登记 SourceMutation 前用真实浏览器重放已有固化补丁。若新源码确实删除了更早固化动作的页面或元素，验证器明确返回 `PAGE_NOT_FOUND` / `TARGET_NOT_FOUND` 时只剔除该旧动作并从头重放，同时把补丁转换记入结构历史；其他失败返回 `PATCH_REPLAY_FAILED`、恢复事务前工作副本并保留事务供取消或重试。失败后执行 `cancel-source-edit` 回滚。事务活动期间，人工 action、撤销、重做和固化统一返回 `SOURCE_EDIT_ACTIVE`。源码事务与 revision 一并持久化；服务重开后仍保留开始前基线，只允许同一 `sourceEditId` 继续 commit 提交或 cancel 取消，不由文件监视器猜测提交顺序。文件监视器只兼容旧客户端在事务外直接写入，并执行同一补丁重放闸门；结构历史撤销 / 重做也先验证目标版本，失败时返回重放错误、恢复当前工作副本且不移动历史游标。

`data-editor-id` 是可编辑元素的持久元素身份。Agent 移动或调整层级时必须保留既有 `data-editor-id`；新增元素会在 SourceMutation 之前由工作副本归一化补齐。`sc-for` 循环模板的后代不得携带静态 `data-editor-id`，归一化会跳过新节点并清理旧工作副本中的误注入身份，避免循环实例共享同一目标。格式错误或重复的身份必须安全停止。`data-editor-id` 只定位元素，不放宽 `before` / `after` 与文字范围校验；Agent 改写同一属性或改变字符偏移时仍然冲突关闭。旧 action 没有该身份时继续使用保守的路径、几何与语义锚点，不猜测迁移目标。

区域任务批次中的结构修改要逐个建立事务：先执行 `node scripts/editor/cli.mjs begin-source-task TASK_ID`，保存返回的 `sourceEditId` 与 revision，再对工作副本做一次原子保存并执行 `commit-source-edit SOURCE_EDIT_ID`；提交会把 SourceMutation 关联该任务并标记完成。失败时用 `cancel-source-edit SOURCE_EDIT_ID` 回滚。撤销 / 重做这条结构历史只改变修改效果，任务保持完成。自由终端对话产生的结构修改使用 `begin-source-edit`，不绑定任务。

两类记录共享 revision、编辑时间线、历史游标和固化边界。结构历史按时间顺序恢复文件版本；插页生成新 pageId，移页保留原 pageId，删页只移除目标 ID，所以其他页 action 不依赖页码。SourceMutation 不能用非末尾补偿跨越后续结构版本。源码提交或固化验证若确认某条旧 action 属于更早固化基线、且其页面或元素已被新源码删除，会把它记为“源码已取代”并从补丁中剔除后重新做完整重放；结构撤销恢复旧固化动作，重做再次剔除。同一标识仍存在但语义、几何或当前值冲突时继续 fail-closed，不能借此放宽为猜测匹配。

保存会话不同于正式发布：关闭服务后 session 与托管工作副本可以重开，预览、自动保存和 `Cmd/Ctrl+S` 期间真实 HTML 字节保持不变。顶栏提供“固化修改”，但必须二次确认；它不是普通自动保存，而是唯一会永久写盘、建立固化检查点并归档当前编辑时间线的入口。浏览器标签页的 `×` 会直接关闭，不触发 Chrome 通用离开提醒；网页无法用自定义弹窗接管标签页关闭。要离开编辑器，应点击品牌区右侧、页面左上角独立的“退出编辑”；右侧工作区导航继续保留“初始页”按钮，二者不能互相替换。有未固化历史或 Agent 正在运行时，“退出编辑”会直接打开页面内未固化任务清单，按最新修改倒序列出页码与任务说明，并提供“继续编辑”“暂不固化，退出”“固化并退出”。后者仍走同一固化预检与原子发布流程；未固化历史与工作副本会保留到下次打开。

当前退出交互以“退出编辑器”为唯一文案：初始页、流程页和各编辑页面的品牌区右侧保持同一位置，文字右侧使用品牌红线性的门框与向右退出箭头，不带独立底框。退出会调用同时校验当前浏览器 Origin 与独立 editor capability token 的显式 shutdown，关闭启动器、全部编辑运行时与 Agent 终端；Agent 的通用 API token 无权调用。退出弹窗覆盖游标前全部生效条目，按 `taskId` 分组；任务默认只显示任务说明与下拉箭头，首次展开时才生成页码、条目数和具体 action / source 修改类型。直接编辑 / 结构修改与游标后的重做历史独立显示。

正式发布只能由明确意图触发。可见 Editor 顶栏“固化修改”确认，或无窗口 Skill 在用户要求正式写入时执行 `cli.mjs solidify`，都会先调用 `POST /api/solidify-preflight`，再用返回的一次性令牌调用 `POST /api/solidify-deck`。预检令牌绑定当前 revision、binding revision、真实 / working 双 fingerprint 与最终动作投影，60 秒后过期且只能消费一次；其间任何绑定或历史变化都返回 `SOLIDIFY_PREFLIGHT_STALE`。正式写入在当前工作副本中用最终 action 快照替换唯一的 `huawei-deck-editor-patches` 块，再通过可信事务把整份工作副本原子发布为真实 Deck，并创建固化检查点、归档时间线；因此连续固化既不会覆盖丢失上一轮结果，也不会不断追加脚本块。完成任务关联新的 checkpoint；已固化任务可在 drawer 的已完成分组中直接删除记录，删除只清理任务、局部截图和附件，不会改变 Deck 中已固化的修改。`POST /api/write-deck` / `cli.mjs verify` 只建立受控检查点并保留历史，不发布真实 Deck。对同目标、属性和范围的旧 action 会在固化时折叠为最终值，重叠文字范围会压成互不重叠的最终运行段。发布闸门依次检查：

1. **预检闸门**：revision、文件绑定、页面目标、controlled frame、诊断和双指纹一致；缺页、离线或文件变化分别返回稳定错误码；
2. **令牌重验**：正式写入前再次核对 token 绑定的 revision、binding revision、双 fingerprint 和动作投影，过期、重复使用或变化都要求重新预检；
3. **验证闸门**：修改页相对基线无新增溢出，候选 bundle 通过 `eb.verify`，全部离线补丁在真实浏览器中成功重放。

会话重开与固化先按受控快照证据排除已被源码覆盖的旧静态文字槽位（原历史仍保留）。其余动作使用同一受限恢复规则：只有被后续 SourceMutation 标记为可 rebase 的旧动作，且重放结果为 `PAGE_NOT_FOUND` / `TARGET_NOT_FOUND`，才可作为“源码已取代”跳过；未授权缺失、目标歧义和语义冲突仍会报错。固化验证在同一 Chrome 进程中一次收集全部可清理动作，恢复第一次候选后只重写一次并重新完整验证；写入期间进度条显示为不确定状态，不承诺无法准确测量的百分比。

通过闸门后，`scripts/edit-bundle.py` 只负责 bundle 编解码和三处结构同步；sidecar helper 持有可信目录 identity，负责归档工作版本、真实 Deck 备份、transaction、双 fingerprint 复核、同目录候选与 `os.replace`。会话基线更新失败时会恢复工作副本或真实 Deck；冲突或验证失败不静默覆盖。

### 0.5 写回后的验证

```bash
python3 scripts/edit-bundle.py <deck.html>                         # bundle 结构；等价 eb.verify
node scripts/verify/measure_overflow.mjs <deck.html> --all        # 全页溢出
node scripts/verify/shot.mjs <deck.html> <页label> /tmp/page.jpg  # 改动页 1920×1080 截图
node scripts/verify/steps.mjs <deck.html> <页label> /tmp/steps    # 仅修改动画页时逐拍核对
```

`shot.mjs` 会让 build 全显并输出 1920×1080 逻辑画布截图；`steps.mjs` 按放映规则逐拍输出同尺寸截图。无动画页运行 `steps.mjs` 只打印“此页无动画”并退出 0，不生成逐拍截图；通常只需在修改动画页时使用。

### 0.6 错误恢复与第一版边界

| 错误 | 含义 | 处理 |
|---|---|---|
| `DECK_CHANGED` | source deck 被外部进程改动，文件指纹不再匹配 | 停止写回，重载外部版本并重放动作，或另存副本 |
| `NEW_OVERFLOW` | 当前动作相对启动诊断基线引入新 section / nested clip | 撤销或调整对应动作，再次写回 |
| `EDITOR_OFFLINE` | frame 未连接、未 ready，或诊断超时 | 保持 session，重开 / 重连浏览器后重试 |
| `RECOVERY_REQUIRED` | durable transaction 处于未决恢复状态 | 立即停止修改；重启服务，让磁盘与 session 收敛后再写回 |
| `TARGET_NOT_FOUND` | 目标缺失，页面或 DOM 路径已变化 | 重载页面，重新选择目标并生成 locator |
| `TARGET_AMBIGUOUS` | 目标歧义，路径与指纹无法唯一匹配 | 缩小区域或由 Agent 选择更稳定的候选 locator |
| `WORKING_DECK_CHANGED` | 工作副本被修改但尚未进入 SourceMutation，或写入期间再次变化 | 等待 Editor 记录结构历史；失败时恢复上一归档版本后重试 |
| `SOURCE_HISTORY_ORDER` | 试图跳过后续历史直接恢复结构版本 | 按顶栏时间顺序撤销 / 重做 |
| `COMMAND_TIMEOUT` | HTTP 服务正常，但 parent/frame capability 在 10 秒内没有返回动作回执 | 先用 `revision` 确认服务；连续超时时不绕过 Action、不调用外部浏览器插件。若刚更新 Editor 代码，关闭并重启 Editor 服务以加载新的固定资源快照，仅刷新页面不会更新该快照 |

所有 Agent 动作都受 token、revision、locator 与事务校验；frame 返回的 canonical action 还会与请求逐字段核对。冲突、目标缺失 / 歧义或验证失败都不会留下“看似成功”的静默覆盖。

进入后期编辑器后，iframe 动作层不直接增删页、调整页序或重构复杂动画。需要这些结构能力时，由右侧真实 PTY 中的 Agent 回到本文第 3 节的 `scripts/edit-bundle.py` 工作流，但目标必须是 `AICO_PPT_WORKING_PATH`；Editor 会把结果自动接成 SourceMutation。编辑器本身不另造聊天协议，只保留细节编辑、任务桥与同一 CLI 终端。

## 1. 独立版结构：两行超长 JSON

文件里有两个关键 `<script>`，各自的**下一行**是一整行 JSON：

| 标记行 | 下一行内容 |
|---|---|
| `<script type="__bundler/manifest">` | 一行 JSON dict：`{uid: {mime, compressed, data(base64)}}`——全部图片 / 资源 |
| `<script type="__bundler/template">` | 一行 JSON **字符串**：整份 deck 的 HTML（含每页 `<section>`、导航数组、运行时脚本） |

改内容 = 解码 template 字符串 → 字符串手术 → 重编码回填。`scripts/edit-bundle.py` 封装了这一切。

## 2. 安全编码铁律

1. **改 template 必须经 `get_template` / `set_template` / `save`，绝不手拼、绝不用编辑器 / sed 直改那两行。** `set_template` 负责唯一正确的编码：`json.dumps(s, ensure_ascii=False).replace('</', '<\\u002F')`——只转义 `</`（防字符串里的 `</script>` 提前闭合文档），中文不转义、URL 里的普通 `/` 不动，并内置断言（回填串不含 `</`、不含换行、`json.loads` 后与原字符串相等）。直改几乎必然把整个文件弄坏。
2. **manifest 是一整行 JSON dict，手改容易截断**——嵌图用 `eb.embed_image`，换品牌图用 `scripts/apply_bg.py`（见 `branding.md`）。
3. 改结构（加 / 删 / 移页）必须**三处同步**：slide DOM、`nav[]` 数组、`chapters[].start`——`insert_page` / `delete_page` / `move_page` 已自动做完，别手动改其中一处。

## 3. edit-bundle.py 典型用法

### 3.1 加载（所有片段的公共开头）

```python
import importlib.util
spec = importlib.util.spec_from_file_location('eb', 'scripts/edit-bundle.py')
eb = importlib.util.module_from_spec(spec); spec.loader.exec_module(eb)

lines = eb.load('my-deck.html')     # 整个文件按行读入
s = eb.get_template(lines)          # 解码出 deck HTML 字符串
```

### 3.2 改文字 = section 切片手术

**改前先看目标文本**——先把该页 section 片段打出来（去掉标签更好读），确认要替换的占位文案原文一字不差，再做替换：

```python
import re
i = s.find('<section data-label="版式·流程条"'); j = s.find('</section>', i)
print(re.sub(r'<[^>]+>', ' ', s[i:j])[:1500])   # 去标签打印该页文本，核对占位原文
```

然后把手术范围收窄到目标页的 `<section>`，在片内替换，避免误伤其他页的同词：

```python
i = s.find('<section data-label="版式·流程条"')
j = s.find('</section>', i) + len('</section>')
blk = s[i:j]

OLD, NEW = '页面标题 = 一句话概括流程', '数据准备四步走'
assert blk.count(OLD) == 1, '目标文本应恰有 1 处，实际 %d' % blk.count(OLD)
s = s[:i] + blk.replace(OLD, NEW) + s[j:]

eb.set_template(lines, s)
eb.save('my-deck.html', lines)
eb.verify('my-deck.html')
```

替换前 `assert count == 1`（或预期处数）是习惯动作——0 处说明找错了，多处说明会误伤。

### 3.3 加 / 删 / 移页（自动三处同步）

```python
# 复制章扉页为第二章扉页，插到「问题页」之前
i = s.find('<section data-label="章扉页"')
st = s.rfind('<div class="slide-fit"', 0, i)
end = s.find('</div></div>', s.find('</section>', i)) + len('</div></div>')
new_block = s[st:end].replace('data-label="章扉页"', 'data-label="章扉页2"')
s = eb.insert_page(s, new_block, before_label='问题页', nav_code='章2', nav_label='章扉页2')

# 门面页型的背景由 <style id="tpl-bg-950"> 按 data-label 精确匹配，新 label 要补选择器：
OLD_SEL = 'section[data-label="章扉页"],'
assert s.count(OLD_SEL) == 1
s = s.replace(OLD_SEL, 'section[data-label="章扉页"], section[data-label="章扉页2"],')

# 删页 / 同章内移页
s = eb.delete_page(s, '版式·动手实验')                        # 人工脚本可按 data-label 删
s = eb.delete_page_by_id(s, 'page-0123456789abcdef0123456789abcdef')  # 区域任务按 pageKey 删
s = eb.move_page(s, '版式·流程条', after_label='版式·对比两栏')  # 同章内移到某页之后

eb.set_template(lines, s); eb.save('my-deck.html', lines); eb.verify('my-deck.html')
```

`new_block` 必须是完整的 `<div class="slide-fit"...>…</div></div>` 块；`nav_code` 是导航条上显示的短码（模板里多为两字，如「章扉」「对比」），`nav_label` 必须与页面 data-label 完全一致（增删移页都靠它对上号）。

- **插入的章归属约定**：插到某章**首页之前** = 新页成为该章新首页（该章 start 不动）；插到章中 / 章尾页之前 = 新页归入该章，下一章起 start 全部 +1。
- **删除的对应规则**：删页后，被删页所在章**之后**各章 start 自动 −1（本章 start 不变）。
- ⚠ **`move_page` 只在同章内移动是安全的**（chapters 不需要变，它也不会去调整）；跨章移动后 `chapters.start` 不会自动修正，需按 3.5 节手工修。
- 插删页后都跑一下 `verify`，看打印出的 `chapters` start 是否符合预期。

### 3.3.1 借入其他模板的兼容页型（受控导入）

三套模板 HTML 保持独立。只有 `template-catalog.json` 中来源页明确把当前场景列入 `compatibleWith`，该页型才会出现在当前模板的 `availablePageTypes`；目录同时提供视觉家族、密度和节奏角色，供 PagePlan 避免连续雷同。不要用上面的字符串切片方式跨 bundle 复制，因为目标 manifest 未必包含来源页引用的资源，来源元数据也会丢失。

目标 Deck 必须已经由 `DeckFactory` 按当前场景外壳盖章。导入命令会从目录解析真实来源页、只合并该页引用的 manifest 项、处理 UUID 冲突、调用 `insert_page` 同步 DOM / nav / chapters，并写入 `data-template-id`、`data-page-type-id`、`data-template-source-page`、`data-plan-page-id` 与 `data-plan-chapter-id`：

```bash
python3 scripts/editor/deck_factory.py import-page my-deck.html \
  --catalog scripts/editor/template-catalog.json \
  --template-id training \
  --page-type-id case-study \
  --label 案例复盘 \
  --before-label 结语页 \
  --nav-code 案例 \
  --plan-page-id case-review \
  --plan-chapter-id practice
```

未列入兼容白名单、外壳盖章不一致、页型不存在或目标 label 冲突都会拒绝导入。导入后仍要按 3.5 节运行结构验证，并对新页执行 overflow 与截图目检。

### 3.4 嵌入图片

```python
uid = eb.embed_image(lines, '你的图.png', mime='image/png', prefix='img')  # 写入 manifest，返回 uid
s = s.replace('src="旧图uid或占位"', 'src="%s"' % uid)                     # template 里用 uid 引用
eb.set_template(lines, s); eb.save('my-deck.html', lines)
```

jpg 用 `mime='image/jpeg'`。大图先压缩（1MB 内为宜），deck 体积直接跟着涨。替换四类品牌图（背景画 / 黑板 / 人像 / logo）不用手写这些——`apply_bg.py` 全自动（含旧条目清理），见 `branding.md`。

### 3.5 结构验证与 chapters 手工修正

```bash
python3 scripts/edit-bundle.py my-deck.html
```

打印 slide-fit / section / nav 三者数量与章节起点，`nav` 编号不连续会直接 assert 失败——每次保存后都跑一下。

若 `chapters` 的 start 与预期不符（例如做了跨章 `move_page`），用 `bump_chapters` 助手手工修正后再验：

```python
s = eb.bump_chapters(s, +1, 13)   # 把 start > 13 的所有章起点 +1（delta 可为负）
eb.set_template(lines, s); eb.save('my-deck.html', lines); eb.verify('my-deck.html')
```

## 4. 同名 data-label 警告

`data-label` 是 verify 三件套与 `edit-bundle.py` 的**工具侧页名**，不是 Managed Editor 的稳定页面身份；Editor 的 locator 以持久且全局唯一的 `data-page-id` 作为 page key，页序或标题变化不会改变它。传统脚本仍要求目标 label 唯一：deck 里出现同名 label 时，**verify 三件套会打印警告并只处理第一个**；而 **edit-bundle 的按 label 定位函数（insert/delete/move、切片手术的 `find`）同样只取第一个、且不打印任何警告**——插删改之前先确认目标 label 唯一（`s.count('<section data-label="某页"') == 1`）。复制页面务必改成新名字；区域结构任务删除页面时优先使用 `delete_page_by_id`。万一已有同名页，`measure_overflow.mjs --all` 是唯一能把同名页各测各的模式（显示为 `label #2`）。

## 5. 踩坑表

| 症状 | 根因 / 修法 |
|---|---|
| 整页灰屏 / 加载死循环 | `data-idx` 必须是**数字**（如 `"45b"` 直接灰屏）。它是装饰性的，可重复，但必须是数字。 |
| 中文显示成细体、看不清 | 该元素只挂了 `JetBrains Mono`（无中文字形，回退细体）。中文一律 `'Noto Sans SC'`，要粗用 `font-weight:700`。 |
| 点按钮 / 链接报 React #231（onClick 是字符串） | 写了内联 `onclick="fn()"`——运行时会把它当 React 的 `onClick` 字符串。**别用内联 on\***，用事件委托：`document.addEventListener('click', e => { const t = e.target.closest('.你的class'); if (!t) return; /* 处理 */ }, true)`（capture + `stopPropagation`）。模板的复制链接、bilibili 播放器都是这么实现的，可直接复用。 |
| 改完后整个文件打不开 / JSON 报错 | 没走 `set_template` 的编码铁律（第 2 节），`</script>` 提前闭合或转义损坏。从备份恢复，重做并只经 edit-bundle。 |
| 加页后导航乱 / 某页掉出章节 | 三处同步没做全。用 `insert_page` / `delete_page` / `move_page`，并用 `verify` 检查 `nav` 连续、`chapters.start` 正确。手插 HTML 块时还要注意 `</div>` 配平。 |
| 任务显示“目标不可定位” | 任务原 `pageKey` 已不在当前工作副本中，可能来自删页、页面替换或结构重建。待处理任务不会再次交给 Agent；可撤销相关结构修改，或删除任务后重新标记。已完成历史保持“已完成”，不进入红色告警计数。 |
| 上次写入中断，重开提示已恢复 | 当前工作副本未通过 bundle 解析，Editor 已从 `working/versions` 恢复 session 指纹对应的最后有效版本；真实 Deck 未被覆盖。 |
| 动作返回 `HISTORY_DIVERGED` | 当前元素值与该历史条目的 `before` / `after` 语义都不一致，通常是 Agent 或外部结构修改改写了同一目标。刷新确认实际内容，再撤销冲突结构修改或重新提交新动作；不要强制覆盖。 |
| 撤销返回 `HISTORY_ORDER` | 请求试图跳过历史游标直接撤销结构修改。先按顶栏顺序撤销后续条目；Agent ActionMutation 若适合定向撤回，应从任务行生成补偿修改。 |
| 任务撤回返回 `COMPENSATION_CONFLICT` | 目标任务包含 SourceMutation，或无法在保留后续修改的前提下生成安全反事实动作。按时间顺序撤销，或在当前状态上手工提交新的修正。 |
| 动作返回 `COMMAND_ID_REUSED` | 客户端把同一个 `commandId` 用于不同 payload。为新命令生成新的 UUID；仅网络重试可以复用原 ID 与原 payload。 |
| 固化返回 `SOLIDIFY_PREFLIGHT_STALE` | 预检后 revision、文件绑定、双指纹或动作投影发生变化，或者令牌已过期 / 已消费。重新点击固化或重新执行 `cli.mjs solidify`。 |
| 固化返回 `MISSING_PAGE_TARGETS` | 仍有有效 action 指向当前不存在的页面。先撤销导致目标不可定位的结构修改，或清理对应页面上的历史动作后再固化。 |
| 新建 Deck 的目录仍是模板四章 / 改章数后左侧空白或跑题 | 目录页按固定 `toc` layer 按钮 / 面板配对，但数量和动画必须来自已确认大纲。同步 `chapters[]`、按钮、面板、`data-toc-visual-index` 与全新的 `tocBuilders`，并运行 `toc_contract.py`；只改模板占位文字不算完成，见 `animation.md` 第 3.2 节。 |
| 页内切换在编辑器任务、逐拍截图或 PPTX 导出中丢状态 | 自建了 `_cur` / `data-mod` 状态机，或点击时用 `innerHTML` 重建按钮/面板。改为固定 DOM 的 `data-layer-btn` / `data-layer-panel` 同 key 同组配对，切换只改 `data-active`，见 `animation.md` 第 3 节。 |
| 浏览器缩放时报 `ResizeObserver loop...` / 页面缩放被自动适配抵消 | 不要在 `ResizeObserver` 回调里同步读取尺寸并写缩放 CSS；缓存 `contentRect` 后用 `requestAnimationFrame(fit)`。内容缩放复用模板内置的 `Ctrl/Cmd + 滚轮` / `+/-`，外层 bundle 错误面板只忽略两种已知的 ResizeObserver 无害告警，其他错误必须保留。 |
| 缩放时当前页跳走或画面闪烁 | 滚动态缩放会改变前面所有页面的高度。缩放前后用当前 `.slide-fit` 的 `getBoundingClientRect().top` 校正 `stage.scrollTop`；缩放与校正必须在同一动画帧完成，并把连续输入合并为每帧最多一次。 |
| 刷新后倍率丢失 / 点模式按钮仍保持放大 | 倍率统一写入 `deck-template-zoom-v1`；初始化时读取，但只在用户点击 `#seg button` 时调用 `_setUserZoom(1)`。不要把复位写进 `setMode()`，否则刷新初始化滚动模式会立即覆盖已保存倍率。非 100% 时同步 navbar 的 `data-zoomed` 与四角百分比控件，复位后移出 tab 顺序。 |

放映态动画的坑（`:has()`、SVG transform、外层框漏挂 build）见 `animation.md` 第 5 节。

## 6. 验证工作流（改完一批必做）

```bash
node scripts/verify/measure_overflow.mjs my-deck.html --all          # 1) 全页溢出检测
node scripts/verify/shot.mjs my-deck.html 版式·流程条 /tmp/p.jpg      # 2) 改过的页截图目检
node scripts/verify/steps.mjs my-deck.html 版式·流程条 /tmp/steps     # 3) 动过动画的页逐拍核对
```

- **退出码契约（三个脚本一致）**：`0` = 通过 / 成功；`1` = 检出问题（存在溢出 / label 不存在）；`2` = 工具或参数错误（浏览器起不来、参数缺失）。可以直接接进 CI / 脚本判断。
- `measure_overflow` 不传 label 等价 `--all`；报告分两层——section 级溢出（Y/X 像素，>0 即失败）和内层 `overflow:hidden` 裁切（只报告不判失败，逐条截图目检）。
- 已知基线：模板出厂时「版式·左图右文」页自带 3 处 nested clip（图占位框裁切自身的提示文字，+38px）——属预期表现，不是问题，换成真图后自然消失。
- 依赖：桌面版沿用注入的运行时包装器与 `AICO_HOME`，使用 Host 的 Node 和 Electron 渲染服务；服务不可用时启动或升级兼容 Host。独立 Skill 才需要 Node ^18.19 或 ≥20.6、本机 Google Chrome 和 playwright-core，后者按环境变量 `PLAYWRIGHT_CORE`（指向其 index.js）→ 裸 `import('playwright-core')`（在 Skill 根目录 `npm i playwright-core` 即可满足）→ openclaw 全局安装的内置路径依次查找。都找不到时脚本会以退出码 2 报错并给出提示。
- 首次加载等待较长是正常的（脚本内置了等待 React mount 的 settle 时间）。
- `measure_overflow` 无法可靠发现 SVG `<text>` 越界、箭头悬空、连线方向错误和线条穿框。改过架构图时必须另跑 `shot`，以原尺寸或放大截图逐项目检文字边界与连线端点。

## 7. 升级旧 Deck

更新本 skill 后，已有 Deck 不需要重新复制模板。三套当前模板在 template 中带版本标记：

```html
<meta name="aico-ppt-version" content="2026.08.3">
<meta name="aico-ppt-template-kind" content="teaching">
<meta name="aico-ppt-runtime-hash" content="…">
```

用升级器识别旧版本并迁移公共运行时：

```bash
python3 scripts/upgrade_deck.py old-deck.html                    # 默认预览，不修改
python3 scripts/upgrade_deck.py old-deck.html --check            # 只检查；有待升级项时退出码 1
python3 scripts/upgrade_deck.py old-deck.html --yes              # 自动备份后落盘
python3 scripts/upgrade_deck.py old-deck.html --audit            # 逐页打印视觉复核清单
python3 scripts/upgrade_deck.py old-deck.html --audit --report audit.md
```

Agent 每次加载本 skill 后，首次接触一个已有 deck 目录时，对目标 deck 批量运行一次 `--yes`：最新版不会写盘；旧版自动备份并升级，完成后向用户报告。同一会话、同一目录、同一批文件后续编辑不重复检查。若存在 `AICO_PPT_WORKING_PATH`，说明当前处于 Editor 托管会话，只能升级该工作副本，不能升级 `AICO_PPT_SOURCE_PATH`。skill 更新后首次加载、切换目录、出现新 deck、文件被外部替换，或用户明确要求时才重新检查。默认预览命令保留给人工排查与脚本调试，不作为日常协作闸门。

升级边界：

- 升级器不逐项理解功能。它移除页面、导航、章节、标题、页面 profile、品牌元素和用户扩展槽后计算公共外壳 hash，并与同类型最新模板对照。
- 已带运行时 hash 和用户扩展槽、且声明 hash 与实际规范化外壳一致的 Deck，通过稳定 seam 用最新外壳重组；声明 hash 与实际外壳不一致代表业务 Deck 曾直接定制公共脚本，也必须从 Git 历史寻找基线并做三方合并。未接入 seam 的历史 Deck 同样走三方合并。已知旧目录渲染器与新版 layer 兼容模块的单点冲突会保留业务渲染器；任何未知冲突仍安全停止。
- 用户拥有区包括页面 `<section>`、`nav[]`、`chapters[]`、标题，以及 `AICO_PPT_USER_STYLE` / `AICO_PPT_USER_SCRIPT` 两个扩展槽；这些内容原样保留。
- manifest 以旧 Deck 资源为基础，补入最新公共外壳实际引用的资源；UUID 冲突且内容不同时自动重命名旧资源并同步用户内容引用。
- 模板类型由 `aico-ppt-template-kind` 标记；历史 Deck 无标记时按旧外壳相似度在 teaching / tech-share / work-report 中选择。
- 升级先剥离补丁块建立未应用补丁的候选，为所有页面补齐或校验唯一持久 `data-page-id`，再以严格 path / tag / fingerprint 唯一匹配迁移旧 pageKey。迁移后重新生成当前共享补丁块，并用真实 Chrome 要求 `expected == applied == adopted`；任一 action 无法唯一定位或重放失败都会停止写入。
- `--yes` 仅在 bundle 结构与补丁重放全部通过后生成 `文件名.before-upgrade.html` 并原子替换；同名备份已存在时自动追加序号，不覆盖旧备份。
- 重组只接受同时具备 app / stage / slide-fit / section / nav / chapters / railtoggle，且页面区与两个数组边界均可唯一解析的结构。核心结构无法可靠识别、历史模板 Git 数据不可用或三方合并冲突时以退出码 2 停止，不写入目标文件。
- 卡片、标题色块、说明标签、红色描边和 SVG 工程图属于内容层；升级器只列出候选问题，必须结合业务含义逐页判断。
- 升级完成前自动运行 `eb.verify()` 与 `scripts/verify/patches.mjs`；仍要按第 6 节执行 overflow、截图和动画逐拍验证。

脚本退出码：`0` = 已是最新或升级成功；`1` = `--check` 检测到待升级项；`2` = 参数、bundle 结构或安全迁移条件不满足。

新增或修改公共运行时功能时，同步更新三套模板并提升版本标记即可；模板外壳变化会自然产生新 hash，`upgrade_deck.py` 无需增加功能探测。只有页面 / nav / chapters / 页面 profile / 品牌元素 / 用户扩展槽 / manifest 等 seam、历史合并规则或 bundle 编码格式变化时才修改升级器。历史三方合并只在 Deck 首次接入新版 seam 时发生，写入目标 hash 后，日常编辑和同一 skill 版本下的再次检查不会扫描 Git 历史。

### 7.1 用户明确要求“整页直接出现”

这是内容偏好，不属于版本升级：只在目标 deck 的各 `<section>` 内移除 `class` 中的 `build` token 与 `data-step`，必要时再把该 deck 的循环 SMIL 改为静态；必须经 `edit-bundle.py` 操作并重新跑 `measure_overflow --all`。升级器不得默认删除动画，因为模板 03 章本身是 build / layer / SMIL 的活教材，也有大量既有 deck 依赖逐拍讲解。

## 8. 导出 PPTX（html2pptx）

**授权边界：只有用户明确要求生成 / 更新 PPTX 时才运行导出。** 用户要求继续修改 HTML deck，不代表授权同步覆盖现有 `.pptx`；一次导出完成后，后续修改默认只更新 HTML，直到用户再次要求导出。

窗口化 Editor 的模式栏左侧花形按钮用于“全屏播放”：点击后先切到预览，再触发 Deck 原生放映入口，逐拍、翻页与 `Esc` 退出均沿用 Deck 自身逻辑；画布状态区只保留导出图标，不再放置第二个全屏入口。DSH / Creation 父 iframe 与 Editor 内 Deck iframe 必须用 `allow="fullscreen *"` 显式向跨源后代委托权限。导出会把当前工作副本连同尚未固化、正在预览的 ActionMutation 临时物化为独立快照，再交给同一个 `convert.py` 下载 PPTX；该过程不写回源 Deck、不固化历史，也不清空撤销记录。

Editor 弹层默认推荐“可编辑 PPTX”，可切换为“高清图片 PPTX”，确认前可取消。CLI 的 `--mode editable` 生成可修改的文字、常见图形和表格，复杂视觉保留图片；不传模式或 `--mode image` 沿用逐页高清图片导出。

```bash
python3 scripts/html2pptx/convert.py my-deck.html --mode editable # 可编辑 PPTX
python3 scripts/html2pptx/convert.py my-deck.html             # 默认图片，输出同名 my-deck.pptx
python3 scripts/html2pptx/convert.py my-deck.html 出货版.pptx   # 指定输出名
python3 scripts/html2pptx/convert.py my-deck.html --scale 2 --quality 92
python3 scripts/html2pptx/convert.py my-deck.html --embed-html # 第一页嵌原始 HTML（OLE）
```

Windows PowerShell 使用相同实现：

```powershell
py -3 scripts\html2pptx\convert.py .\my-deck.html .\出货版.pptx --scale 2 --quality 92
py -3 scripts\html2pptx\convert.py .\my-deck.html --embed-html
```

macOS / Linux 仍可使用 `bash scripts/html2pptx/convert.sh ...`；该脚本只转交 `convert.py`，不维护第二套转换逻辑。

可编辑模式的 `--scale` 范围为 0.5–4，控制保留图片的截图倍率；`--quality` 仅控制图片模式的 JPEG 质量。

文字按浏览器实际视觉行生成独立文本框，统一使用微软雅黑（Microsoft YaHei），保留粗体、斜体、下划线、颜色及原始字号比例。CSS `zoom` 与编辑器 `scale` 的等比缩放纳入字号、字距和单元格边距，外层预览倍率不改变逻辑字号；文本框对齐实际字体基线而非 Range 顶部。字号与几何使用同一个画布换算，不开启 Office 自动缩小。简单表格生成原生单元格，合并单元格或带复杂视觉的表格使用图片。字体不嵌入 PPTX，接收方未安装微软雅黑时，替代字体仍可能影响字宽与表格换行。桌面透明图片依赖 Host 的 `features.screenshotOmitBackground: 1` 能力，旧 Host 会明确提示升级，不会静默生成白底图片。

- 补丁一致性：图片与可编辑模式共用就绪校验，等待 `HuaweiDeckEditorPatchStatus` 为 `applied`，并确认 `expected / applied / adopted` 均等于内嵌补丁数后才读取页面。失败、缺少状态、计数不完整或超时均中止导出，向 Editor 传回失败原因和补丁 ID；`.build` 全显规则不覆盖补丁的内联透明度或变换。

- 原理：浏览器读取实际渲染页面（桌面复用 Electron，独立 Skill 使用 headless Chrome；自动隐藏导航条等 UI 外壳、`.build` 全显），标准库 ZIP/XML 组装器按序生成 16:9 页面。图片模式每页一张满屏原图，共用截图只保存一份；可编辑模式提取支持的文字、形状、表格与图片，复杂视觉以图片保留。两种模式均不生成可编辑动画或网页交互，不承诺所有元素均可编辑，导出后应复核字体及排版。
- **layer 页自动展开**：带 `[data-layer-btn]` 的页会逐标签各截一张、按顺序全部进 PPTX（一页 N 个标签 → N 张）；一页有多个 layer 组时逐组展开、其余组停在首标签，全默认态只截一张不重复（共 ΣN − (组数 − 1) 张）。所以模板 34 页导出为 **55 张**（`动画·layer切换` 4 张、`动画·混合链` 5 张、`动画·多组切换` 2 组共 5 张、`SFT vs LoRA` 6 张、`找问题·六层级` 6 张）。该页数示例来自图片模式；当前导出用时和体积以具体文稿与模式实测为准。
- 已知限制：靠 React 内部 state 切换的自制交互页无法程序化展开，只能截到默认状态（模板自带页没有这种页；自己加页时若做了这类交互，导出前心里有数）。
- 依赖：桌面使用 Host 的 Node 和 Electron 及插件私有 Python；独立 Skill 使用 Node + Chrome + playwright-core（同第 6 节三级查找）及 Python。组装器不依赖 python-pptx；可选 `--embed-html` 图标需要 Pillow。

## 9. 性能守则

- **别删内联的 React / 字体**。运行时默认从 CDN 拉 React——正因模板把 react / react-dom UMD 内联在运行时脚本之前才真离线；删了它，断网 / 代理环境整页起不来。`scripts/react.umd.js` / `react-dom.umd.js` 是备件，误删后可用 `eb.inline_react(lines, 'scripts/react.umd.js', 'scripts/react-dom.umd.js')` 修复。
- iframe 一律 `loading="lazy"`；能重画成矢量 / HTML 的图别贴低清大截图。
- **大改用 Python 切片，别开编辑器**——那两行 JSON 每行数 MB，多数编辑器会卡死或悄悄截断。
- 参考基线：模板 12MB，headless Chrome 首开约 2.6 秒；桌面浏览器首次打开多等几秒属正常，不是卡死。用 `file://` 直开时控制台可能有 2 条 CORS 报错，良性，忽略即可。

## 10. AICO 桌面运行环境

当前原装宿主提供匹配的 Node，PPT 完整 Windows 包提供私有 Python 与浏览器。截图、验证和导出通过 Worker 与运行时包装器使用显式资源路径，不依赖旧 `AICO_HOME/desktop-renderer.json`，不改动宿主目录或全局依赖。参考 PPTX 用 `scripts/extract-pptx.py` 按页提取内容与原图，只需标准库；PDF 的 materials 依赖单独检查。独立 Skill 按本机任务准备依赖。运行时约束见 [ADR-0007](../docs/adr/0007-plugin-private-runtime.md)。


### Harness 会话直接编辑

已明确关联 Deck 的 Harness 会话会在每次模型调用前获得当前 Editor 工作区连接，包含受限 action capability 文件与托管工作副本路径；恢复旧会话或重启后重新解析，不依赖固定措辞。用户可直接在左侧讨论或要求修改，讨论只读，明确修改复用右侧同一工作区，无需先提交区域任务或退出 Editor。结构修改按 begin-source-edit / commit-source-edit 事务提交，每批成功后更新预览；事务期间人工写入保持串行保护。未关联会话不注入 Deck 能力，已关联但 Editor 不可用时提示重新打开对应工作区，不另起 headless 编辑器抢占租约。

顶部、快捷键和任务卡片的撤销 / 重做共用忙状态：一次请求及其会话同步完成前禁用所有历史入口，重复点击不排队；版本冲突后只允许重试同方向、同一历史组，不能把撤销自动改成重做。

创建画布由外层宿主管理对话，不初始化独立终端；模板预览与编辑桥接分别就绪。若生成因编辑器离线或验证失败而保留 staging，修复后使用原 Draft 的 `generation-ready` 和最新 `expectedRevision` 重新执行完整验证与发布，保留同一 run 和工作副本；`retry-generation` 会重新创建模板，仅用于明确重新生成。固定页结构校验忽略托管元素 `data-editor-id` 和空元素标签序列化空格，仍校验布局属性与 DOM 结构。

源码修改与既有文字动作冲突时，Editor 会根据前后归档快照保留源码的新文字，停止重放已被覆盖的旧文字动作，同时恢复不相关的样式；历史条目仍保留以支持撤销。`HISTORY_DIVERGED` 表示页面与历史不同步，并不等同于标记对象不明确；应重新打开工作项同步后重试，不要求用户改写标注说明。

## 简洁编辑与视觉确认

Harness 中使用原生 `aico_ppt` 工具：`inspect` 返回当前版本、任务、目标、父容器和页面图；`edit` 原样使用 locator、expectedRevision 与稳定 commandId，返回提交状态、受影响页诊断及结果图。普通修改不重读完整 Skill，不额外扩宽或重排版式。`hide` 只隐藏、不补位；DOM 删除与补位走源码事务。

`view` 提供包含未固化动作的 1920×1080、build 全显标准图，不改变用户画布的页码或缩放。它不是现场窗口截图，返回 stateId、revision、renderMode；内容变化使缓存失效。多页提交先返回首个受影响页，其余页按需 view。截图失败时保留已提交状态；使用 `result` 查询原 commandId 后补充 view，不用新命令重交。

CLI 对应 `inspect TASK_ID OUT.png`、`view PAGE_KEY OUT.png`、`result COMMAND_ID`。`verify` 通过只读 `/api/verify` 检查完整历史候选，不推进历史；普通动作诊断及同版本截图通过后无需重复验证。源码事务在提交、撤销和重做时检查有效历史，真实文件仅在固化成功后替换。页面、共享 CSS/脚本的实际差异决定局部结构或完整流程，不能由模型自称“简单”来绕过校验。

普通会话查看使用 `aico_ppt({operation:"inspect"})`，不要把工作项 `workId` 填成区域任务 `taskId`；误填会返回 `WORK_ID_NOT_TASK_ID` 和重试说明。固化期间查看或验证返回 `EDITOR_SOLIDIFYING`，工具会说明稍后读取稳定版本，不自动重复固化。插件上下文暂不可达时仍可普通问答，但不得复用旧端口或凭据执行 Deck 操作。

桌面区域任务使用简短说明，同轮相同编辑上下文去重，换工作项、新轮与压缩后恢复必要说明；连接与凭据即时读取。PPT 插件承载协议，Host 只提供通用工具、图片附件和隐藏渲染能力。

### 标注与内容版本

Agent 原样使用 inspect 的 expectedRevision。其他反馈任务的新增、说明修改和删除只更新会话同步版本，不使当前编辑过期；当前目标任务改写返回 TASK_CHANGED，删除返回 TASK_NOT_FOUND。Deck 内容、撤销重做、源码事务或其他控制状态改变仍保留版本检查，不能直接把请求改成最新版本重交。明确 commitStatus:rejected 时本次未提交，按错误重新检查目标；只有提交结果未知才用 result 查同一 commandId。
