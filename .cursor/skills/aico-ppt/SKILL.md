---
name: aico-ppt
description: Use when creating a new Huawei-red-brand 1920×1080 single-file HTML slide deck — for lectures/training（授课培训）, business reporting（汇报/述职/方案评审）, or self-study learning materials（学习材料）— from the bundled template（华为红品牌网页 PPT 模板：34 页页型画廊含 10 页真实课件示例、点击/方向键放映、离线单文件、刷新续播）, editing pages/animations/branding of such a deck, or converting it to PPTX via the bundled html2pptx (multi-tab pages auto-expand).
---

# AICO-PPT — 华为红品牌单文件 HTML 演示模板

## 这是什么

AICO-PPT 是**可独立使用的 Skill + AICO-Harness 编辑器插件**。独立 Skill 不依赖 AICO-Harness；默认安装只注册 Skill，创建、修改、验证和导出按任务选择依赖。所有面向用户的可视化编辑入口统一放在 AICO-Harness。Skill 完成第一版后交付 HTML 和验证结果，不自动打开独立桌面编辑器；需要可视化微调时，从 AICO-Harness 的 AICO-PPT 插件进入。`tools/dev-shell/` 仅供维护者明确调试使用。

一套**单文件 HTML 演示模板**（1920×1080，华为红品牌设计系统）：React / 字体 / 图片全部内联，拷走一个文件即真离线可用。打开默认滚动模式浏览，左上角侧边预览 glass 胶囊持续显示实时 `x/yy` 页码，右侧 6px 细滑块仅在滚动时显现、停止 800ms 后自动淡出；`Ctrl/Cmd + 滚轮` 或 `Ctrl/Cmd + +/-` 缩放幻灯片内容（刷新保留倍率）。非 100% 时顶部 glass bar 展开四角百分比复位控件；**仅放大到 110% 及以上时**再展开小手按钮，可锁定点击 / 拖动模式，按住空格则临时抓手，松开即恢复。**点右上角显示器图标进入放映模式**（自动全屏）——点击空白、空格、方向键或上下滚轮逐拍推进 / 回退，当前页拍完才翻页；滚轮按手势防抖，触控板惯性不会连续跳页。刷新自动回到上次页，粘贴 bilibili 视频链接可直接弹内嵌播放器。`assets/training-deck.html` 是 34 页**页型画廊**：24 页页型每页既是可复制的版式，占位文案本身又在讲解「这一栏该怎么写」——画廊即文档；另有「05 · 完整示例」章 10 页取自真实课件，展示版式填入真内容后的成品。

本仓库同时提供可选的 DSH 插件适配层，但适配层不会复制这份 Skill。DSH Host 直接把当前 `SKILL.md` 注册进全局 skill 目录并启动原 Editor Runtime，DSH Client 在原生对话右侧的通用 `workbench.persistent-view` 中嵌入它；页面栏、三种模式、属性、任务、历史、固化和导出仍由 Editor Core 拥有。每个 Deck 工作项通过稳定 `workId` 显式关联项目目录、DSH Workspace 和一个或多个 Session；Harness 左侧“新会话”中的 AICO-PPT 项目子菜单显式携带 `workId` 建立关联，普通新会话不关联 Deck；Editor 顶部选择器只展示和切换关联会话。明确创建的任务 Session 首条可见指令必须以 `/aico-ppt` 开头；恢复、切换任务或切换 Session 不得发送任何“继续”Prompt。“交给 Agent”必须固定发送到工作项的活动 DSH Session，不能回退到临时选中的普通 Session，也不得在插件内再启动 Codex / Claude Code / OpenCode PTY。切换普通 Session 不得改变或重载 Editor；点击已关联 Session 才切换对应工作项，内部恢复路由不得短暂显示启动初始页。原独立 Editor 只是带 PTY 的 `dev-shell` 开发/排障壳，不是第二个正式产品。能力边界见 `integrations/dsh/README.md`。

在当前原装 DSH 插件模式（`AICO_RUNTIME_KIND=plugin`）中，完整 Windows 包提供私有 Python、浏览器与材料依赖，Node 使用宿主匹配的可执行文件。沿用注入的运行时包装器、`PYTHON` 与显式浏览器路径，不在宿主或插件安装目录运行 npm/pip 修复。资源缺失时检查完整包及诊断，通过原装插件机制重新安装；不能要求改造宿主或依赖旧 `desktopRenderer` 通道。当前协议见 `docs/adr/0007-plugin-private-runtime.md`。sidecar Python 冷启动握手最多等待 10 秒，普通文件命令与可信路径检查不放宽；Windows 优先使用默认数据目录。

## 从零做一份 PPT？先走流程

用户要**从零做一份新 PPT** 时——授课、汇报、学习材料都算——不要直接开搭页：先走 `references/workflow.md` 的七阶段协作流程（主题讨论 → 大纲规划 → 选择模板 → 初版制定 → 讨论修改 → 终版制作 → 讨论修改），其中三个「讨论」阶段是硬闸门；流程开头的**场景适配表**定授课 / 汇报 / 自读的基调差异（骨架、页数、页型、动画量）。DSH 正式壳先让用户选择项目目录，再在为该 Creation Work Item 明确创建的活动 Session 中完成讨论，右侧只呈现 Editor。独立 Dev Shell 才把前四阶段投影为“需求已收敛 → 大纲已形成 → 页面已规划 → Deck 已出现”四个**只读里程碑**：左侧节点不可点击，前三段没有中间表单、章节卡片、页面卡片或确认按钮，用户只在右侧真实 PTY 中自然对话。`draft.json` 是完整状态的权威记录，`brief.json`、`outline.json`、`page-plan.json` 与 `deck-ready.json` 是供界面和恢复流程读取的耐久回执；里程碑只能由这些文件与 Draft 状态派生，终端自然语言输出不能直接改进度。模板与文件名确定、合法 staging Deck 首次出现后，创建页才展开中间画布，并立即接入与后期编辑器相同的 Managed Workspace；Agent 只修改托管工作副本，ActionMutation / SourceMutation、revision、自动刷新与固化共用一套实现。新建中的批量重构仍由 Agent 经 `scripts/edit-bundle.py` 完成；`generation-ready` 会先把初版历史固化回 staging，再独立验证并不覆盖发布，随后立即为最终 Deck 建立标准 Managed Workspace。创建页和“进入微调编辑器”后的修改页复用这个最终运行时，按钮只切换页面外壳；独立 Dev Shell 的精细调整延续同一 PTY，DSH 模式则延续同一 `workId` 的活动 Session，详见 `references/editing-guide.md`。

### 单一质量契约（所有 Deck 工作原样复用）

本 Skill **不按新建 Deck 和修改 Deck 维护两套规范**。无论从 Creation Draft、Editor 终端、区域任务还是直接调用 Skill 进入，下面同一份质量契约都必须原样生效，不得按入口切换、删减或降级。入口差异只决定当前状态：还没有合法 bundle 时先收集需求、确认大纲与页面规划；已经有合法 bundle 时直接进入 Managed Workspace。合法 bundle 一旦出现，后续创建、续作和修改使用相同的编辑、验证与固化路径。

1. **先识别或选择场景外壳，再从共享页型库选版式**：`training` / `tech-share` / `work-report` / `qualification` / `project-review` 五份 HTML 继续独立，决定封面、目录、感谢页和整套视觉基调；已有 Deck 默认继承现有外壳，除非用户明确要求不得换壳。逐页规划使用目录提供的 `availablePageTypes`（当前外壳原生页 + 明确标记兼容的共享页）。能套用既有页型时必须复用原 DOM 与组件，不另造一套卡片和布局；借用页只能经 `deck_factory.py import-page` 受控导入，不能手工跨 bundle 粘贴。
2. **固定页角色不可丢，目录始终服从当前大纲**：封面必须第一、目录必须第二、感谢页必须最后，三者各一页。封面和感谢页仅替换必要文案并保留原始结构；目录页保留模板外层版式。新建，或修改涉及章数、章名、章节目标、页序、目录 DOM 或目录动画时，内部条目、layer 和动画必须按当前实际大纲重建；无关修改则保持目录结构不变，不能继承或重新带回模板示例内容。
3. **标题就是核心观点**：内容页标题写清对象与主要判断；机制页点名技术，资产 / 计划页点明产物或目标场景，不强套技术句式或塞满全页要点；全部标题连读应形成论证链。
4. **投影可读是硬门槛**：正文散文默认不小于 21px；代码、表格、坐标轴等例外遵循 `design-system.md`，不能靠无上限缩字塞内容。
5. **密集但不拥挤，版式必须换气**：以有效信息而非字数衡量密度，按结论、证据、机制或步骤组织；纵向均衡展开，删去冗余后给核心内容更多空间并保留合理留白，不能补套话填满画布。一页同时包含两个以上耦合维度（如阶段 + 责任 + 交付物、系统 + 结果、代码 + 曲线 + 指标）时，优先选择 `density=dense` 且 `useWhen` 匹配的复合页型，不得拆成多页低信息卡片来回避复杂结构。页面规划必须为每个内容页写明排版理由和配图 / 证据方案；连续三页不得使用同一视觉家族，四页以上的章节不得只有一种视觉家族。
6. **同级卡片必须同构**：同一组、同一层级、同一语义角色的普通卡片统一白底、1px 灰边、14px 圆角，并保持背景、边框、阴影、内边距以及标题 / 正文 / 标签的字体族、字号、字重、行距一致。只有页面文案明确表达选中、推荐、当前、风险或结论差异时，才允许其中一张使用红色、底色、边框、阴影或额外字重；不得为了构图制造默认高亮，也不添加无语义的色块标题和“重点”装饰。
7. **先有事实与信息任务，再写页面**：直接写对象、动作、约束和结果，不写套话或 AI 式比喻；分清已完成、探索与建议、本项目新增与既有积累，核对数字口径。成果汇报要写出可重复方法、成果证据、具体资产，以及有目标对象的后续行动，不用泛化建议代替实际产物，也不编造缺失事实。材料组织与初版 / 终版内容自检见 `references/workflow.md` 第 1.1、2.1、4.1 节。
8. **默认不补无用小字**：导语、页尾总结和装饰标签不是模板必填项；删去不影响理解的重复句与过程说明。必要单位、基线、范围随结论清楚呈现，详细来源实际保存到备注或伴生材料；取舍与来源去向见 `references/design-system.md` 第 4.1 节。

创建会话和编辑会话由同一个质量契约模块生成初始化指令；`scripts/editor/template-catalog.mjs` 从模板 bundle 自动读取全部 34 / 37 / 46 / 22 / 54 页，并为每个实际页面补齐稳定语义 ID、视觉家族、密度、节奏角色、适用说明和来源模板，不再依赖容易漏页的手写六页清单或 `source-page-NN` 匿名兜底。`availablePageTypes` 在所选场景外壳之上合并经过 `compatibleWith` 审核的共享页型；同名页型优先使用当前外壳原生页。`DeckFactory` 在 staging 阶段给每页写入真实模板来源，并保存已确认 PagePlan 的只读发布契约；借用页由 `deck_factory.py import-page` 连同其 manifest 资源安全导入。发布前逐页核对页数、顺序、页型、页面 / 章节身份和 label，同时验证封面 / 感谢页结构锁、目录自适应契约、排版理由、配图计划与视觉家族节奏。少页、多页、错序、漏掉固定页、使用虚构页型、连续版式雷同、重做封面 / 感谢页或沿用目录示例动画都会拒绝发布。

### 目录页自适应契约（新建与目录结构修改共用）

当前确认的大纲是目录唯一权威。新建 Deck 一律执行；修改已有 Deck 时，只要涉及章数、章名、章节目标、页序、目录 DOM 或目录动画，也必须更新同一份目录契约并执行同一套校验。与目录无关的文字或样式微调不需要重建目录，但不得降低或破坏既有契约。存在 Creation Draft 时以 `outline.sections[]` 为准；直接修改既有 Deck 时，以用户确认后的当前章节清单为准。两种入口都必须满足：

1. 实际章数 = `chapters[]` = 目录 `data-layer-btn` = `data-layer-panel` = `data-toc-visual-index` = `tocBuilders` 数量。
2. 每章有稳定 `chapterId`；对应按钮、面板和动画容器都写 `data-toc-chapter-id`。按钮 `.toc-layer-name`、面板 `data-toc-title` 必须等于真实章名，动画容器 `data-toc-animation-topic` 必须等于本章目标。
3. layer key 按 `chapter-01`、`chapter-02`… 连续生成；首章按钮 / 面板唯一 `data-active` 且不写 `data-step`，后续按钮从 `data-step="0"` 连续编号。
4. 每章新建一个具名动画函数，画面直接表达本章对象、关系或过程；返回的 SVG / HTML 根节点写 `data-toc-animation-chapter` 与 `data-toc-animation-topic`。不得保留模板的 `animNN` / `animAlgo` / `animMethod` / `animInfra`，不得只改函数名，也不得让不同章节复用同一画面。
5. Editor 会从已确认大纲自动生成 `*.toc-contract.json` 并在发布前执行校验。直接使用 Skill 时也要生成同格式契约文件并执行：

   ```bash
   python3 scripts/verify/toc_contract.py my-deck.html \
     --contract my-deck.toc-contract.json \
     --template assets/training-deck.html
   node scripts/verify/steps.mjs my-deck.html 目录 /tmp/toc-steps
   ```

   契约文件格式为 `{"version":1,"chapters":[{"chapterId":"context","title":"背景与约束","objective":"讲清适用边界"}]}`；`--template` 必须传本次实际选中的原始模板。

## 先选择修改运行模式

Skill 与窗口化 Editor 是两层能力。**没有 Editor 窗口也必须能创建和修改 Deck**。AICO-Harness 插件提供可视化画布和区域任务，使用 Harness 原生会话；无窗口 Skill 复用同一 Editor Core，严禁启动第二套 Agent 终端。每次准备修改一份已经存在的合法 bundle 时，按以下固定顺序路由，不能根据 Agent 品牌改变规则：

1. 环境中已有 `AICO_PPT_EDITOR_URL` 与 `AICO_PPT_EDITOR_TOKEN`：复用当前 Managed Workspace。已有元素的细节走 Editor CLI action；结构修改只改 `AICO_PPT_WORKING_PATH`。
2. 没有活动 workspace，且本机具备 Node、Chrome 与依赖：启动**无窗口 Managed Workspace**。它在后台挂载同一受控 frame，不打开 Editor UI，也不启动内嵌 Agent；Mutation、revision、撤销 / 重做、诊断和固化与窗口模式完全相同。
3. 只有用户明确要求不启动后台运行时，或依赖检查确认运行时不可用，才进入**经典直改 fallback**：用 `scripts/edit-bundle.py` 修改目标 HTML 并运行 verify 三件套。该模式不产生 ActionMutation / SourceMutation，没有跨轮撤销队列，也没有后续“固化”动作；必须在动手前明确告诉用户这个差异，不能静默降级。

无窗口入口会持续运行直到 Agent 结束该进程，并在第一行输出普通 action capability：

```bash
python3 scripts/deck-editor.py /absolute/path/to/deck.html --headless-workspace
# 另一个 shell / 工具调用；也可直接使用首行 JSON 中的 url 与 token
export AICO_PPT_WORKSPACE_CAPABILITY_FILE=/absolute/path/to/workspace-capability.json
node scripts/editor/cli.mjs status
```

已有元素的文字、格式、移动、缩放和显隐在 Harness 内优先使用原生 `aico_ppt` 的 `inspect → edit`，其他环境可用 `locate-text` / `replace-text` / `apply`。局部形状、图片、模块增删和 HTML 片段替换用 `inspect → structure`，服务自动完成源码事务、完整历史重放验证和结果图；片段替换前按需 `inspect(detail:"source",target)`，保留原元素身份。写入携带 inspect 的 workId、expectedRevision 和原 target。普通修改只读目标页的相关区域；跨页语义用 catalog 后读取相关页，邻页不是固定必读项。成功回执与同版本结果图足够时结束，不重复 task、verify 或读取完整 Skill；明确 `commitStatus:"rejected"` 时按错误重新 inspect 目标，无需查回执；传输不明时用 result 查询同一 commandId。页面增删排序、模板升级和共享 CSS / 脚本重构先建立源码事务，再用 `scripts/edit-bundle.py` 修改 capability 中的 `workingDeckPath` 并显式提交。手工结构修改与正式发布前执行 `node scripts/editor/cli.mjs verify` 检查完整历史候选；此命令只检查、不推进历史。用户要求完成 / 保存 / 正式写入时执行 `node scripts/editor/cli.mjs solidify`；用户明确要求仅预览或暂不固化时保留 workspace 与历史并报告 capability 路径。`solidify` 成功后才替换真实 Deck 并清空撤销 / 重做队列。

新建 Deck 允许在尚无目标文件时直接复制所选模板；**合法 bundle 第一次落盘后，后续第一版制作立即按上述规则进入 Managed Workspace**。不要把整份第一版制作留在无历史的经典直改路径中。

## 快速上手（5 步）

1. **按场景复制模板**（所有命令都在本 skill 根目录执行）：授课 `cp assets/training-deck.html my-deck.html`；技术分享用 `assets/tech-share-deck.html`；汇报 / 述职用 `assets/work-report-deck.html`；任职资格评审用 `assets/qualification-deck.html`，先读 `references/qualification-template.md`；项目评审用 `assets/project-review-deck.html`，先读 `references/project-review-template.md`（五套差异与逐页索引见 `references/template-pages.md`）
2. **建立 Managed Workspace 后挑页改占位**：浏览器滚一遍场景外壳，对照 `references/template-pages.md`（五套模板逐页索引）从 `availablePageTypes` 选择原生或兼容共享页型；已有元素细节走 ActionMutation，原生页型结构走工作副本上的 `edit-bundle.py`，共享页型走 `deck_factory.py import-page`（见 `references/editing-guide.md`）；品牌图 / 口号 / 品牌色替换见 `references/branding.md`。
3. **增删复制页**：用 `scripts/edit-bundle.py` 的 `insert_page` / `delete_page` / `move_page`——slide DOM、导航数组、章节起点**三处同步全自动**；从零拼页参考 `references/page-snippets.md`。
4. **按实际影响验证**：普通文字、样式、移动、缩放、显隐使用 Editor 提交结果中的身份和版本校验、受影响页诊断及同版本截图，不默认重复全页和动画验证。DOM 修改必须通过完整历史候选重放；增删页、共享 CSS/脚本与影响范围不明时扩展全局检查。涉及制作、布局或动画时按影响页执行 verify 三件套，退出码 0 = 过：

   ```bash
   node scripts/verify/measure_overflow.mjs my-deck.html --all      # 溢出检测
   node scripts/verify/shot.mjs my-deck.html <页label> /tmp/p.jpg    # 单页截图目检
   node scripts/verify/steps.mjs my-deck.html <页label> /tmp/steps   # 动画逐拍核对
   ```

   新建 Deck，或本次修改涉及目录 / 章节结构时，还必须按上一节运行 `toc_contract.py`；目录页不能只通过通用溢出检查。

5. **用户明确要求 PPTX 时才导出**：macOS / Linux 用 `python3 scripts/html2pptx/convert.py my-deck.html --mode editable`，Windows 用 `py -3 scripts\html2pptx\convert.py my-deck.html --mode editable`。可编辑模式生成可修改的文字、常见图形和表格；原生文字统一微软雅黑，字号按 HTML 画布比例和局部缩放换算并对齐真实文字基线；复杂视觉保留图片，不保证全部元素或动画可编辑；`--mode image` 生成注重外观还原的高清图片页，CLI 不传模式仍默认 `image`。Editor 导出图标提供这两种选择，默认推荐可编辑，取消不启动导出。两种模式均使用当前工作副本快照（含尚未固化的预览修改，不触发固化），等待全部补丁应用并校验数量后才导出；失败或超时则中止并提示补丁错误，不生成回滚后的旧内容。layer 多标签页自动逐标签展开；后续只改 HTML 时不自动重导，除非用户再次要求。

## 旧 Deck 升级

本次会话加载 skill 后，首次接触一个已有 deck 目录时，对目录内目标 deck 各无感检查一次模板版本；不要等用户提醒，也不要先询问。同一会话、同一目录、同一批文件后续编辑不得重复检查。先完成上面的运行模式选择：Managed Workspace 中只允许执行 `python3 scripts/upgrade_deck.py "$AICO_PPT_WORKING_PATH" --yes`，绝不能升级 `AICO_PPT_SOURCE_PATH`；文件监视器会把升级登记为 SourceMutation。只有经典直改 fallback 才把真实 Deck 作为升级目标。仅在 skill 更新后首次加载、切换目录、出现新 deck、文件被外部替换，或用户明确要求时重新检查。脚本把页面 / 导航 / 章节 / 用户扩展与公共外壳分离，通过 hash 对照同类型最新模板；声明 hash 与实际外壳不一致时也必须走 Git 基线三方合并，避免覆盖页面 profile、品牌元素和课程专属外壳逻辑。升级候选会保留唯一补丁块，为页面补齐持久 `data-page-id`，严格迁移每个 locator，并在真实浏览器中确认全部补丁重放成功后才替换目标；无法可靠识别、三方合并冲突、locator 不唯一或补丁重放失败时安全停止。有变更时生成 `.before-upgrade.html` 备份并合并 manifest。完成后告诉用户是否升级、目标版本和备份路径。加 `--audit` 输出逐页视觉复核清单；完整用法见 `references/editing-guide.md` 第 7 节。

## 后期可视化微调

### 独立 Dev Shell（开发与排障）

以下桌面工作台、真实 PTY、重复启动和单实例说明只适用于独立 `dev-shell`，不属于 DSH 正式壳。独立页面顶栏必须显示 `DEV SHELL`；DSH 嵌入页必须隐藏该标识并继续使用左侧原生会话。

重复双击不会再打开第二个工作台页面；如果旧页面已经关闭，则先结束无页面的旧服务，再启动加载当前资源快照的新服务。

启动页完成会话恢复和初始导航后才开放“新建 Deck / 修改 Deck”入口，避免首次点击被迟到响应覆盖。小文字的拖动与缩放手柄保持屏幕尺寸，但热区向外避让文字中心，缩小画布后仍可直接编辑。宽高调整与 CSS scale 分别保存历史基线，连续使用两者时都保留，并支持独立撤销 / 重做。

`待确认` 不是等待用户点击一个确认按钮：它表示 Agent 匹配到多个可能修改目标，因而拒绝猜测对象。任务 drawer 必须显示“目标定位不唯一”的原因、支持 reduced-motion 的间歇醒目提醒和“补充说明”入口；用户补充具体位置或对象并保存后，任务回到待处理，才可重新提交。

打开已有编辑历史后，首次撤销 / 重做快捷键即使早于权威会话加载完成，也会排队一次并在加载后立即执行，不要求先点击顶栏按钮。

macOS 用户可直接在维护者调试时双击 `tools/dev-shell/AICO-PPT Dev Shell.app`，Windows 用户可直接双击 `tools/dev-shell/AICO-PPT Dev Shell.cmd`，也可把一份 deck HTML 拖到 `.cmd` 上直接打开；两个入口共用 `scripts/deck-editor.py` 与同一套工作台实现。Windows `.cmd` 只做短时派发：标准 `python.exe` 隐藏接管后台生命周期后 CMD 立即退出，常驻 Python / Node 与文件选择器子进程都不创建任务栏控制台窗口。启动页以左右两张“新建 Deck / 修改 Deck”工作卡展示可继续任务，其中“修改 Deck”就是原“打开已有 Deck”入口；打开已有 Deck 使用系统文件选择器添加一份 HTML，Agent 项目目录与区域任务附件也全部调用 macOS / Windows 的系统原生选择器，不在网页内复刻文件管理器。点击历史任务直接恢复 Draft/工作副本、进度和任务专属 Agent 会话；每张卡右下角的小加号用于新建 Draft 或添加 HTML。桌面入口由原子实例登记表保证只有一套 App Server；macOS 重复双击时先按 URL 或“AICO-PPT”标题定位并激活已有 Chrome / Safari 标签页。Windows 以 App Server 的鉴权页面租约作为单页依据，有活动租约时只尽力激活 Chrome / Edge / Firefox 中的已有标签，激活失败也不重复开页；租约已经关闭时会结束宽限期内的旧服务并重新启动。若明确没有现存标签页，启动器会先结束无页面的旧服务，再启动加载当前固定资源快照的新 App Server；浏览器自动化权限不可用时则保守复用已有 URL，避免误关仍在工作的页面。Creation Draft 由 `projectRoot + draftId` 唯一定位，同一项目目录中的多份 Deck 不会混用过程文件；活动锁使用进程租约，页面关闭后的孤儿服务会在重连宽限期后回收，陈旧锁不再永久占用。进入编辑器前可返回首页重新选择，取消选择也可直接重试。从“新建 Deck”发布后，创建页中间画布已经嵌入最终 Deck 的标准 Editor Managed Workspace；点击“进入微调编辑器”只移交该运行时并切换页面外壳，不再另建 Editor。同一个 PTY 和 conversation ID 继续使用；最终 Deck 的 Editor session 还会持久化 `creation-context.json`，继承已确认 brief、大纲、页面规划、设计文稿和 Draft 素材目录，保证重开任务或点击“新会话”后仍能恢复制作依据。首次桌面启动会按锁定版本自动补齐 `ws`、`html2canvas`、`busboy`、`node-pty` 与 `@xterm/xterm`，但仍要求机器已安装 Node.js ≥18 与 Python 3。

桌面图标保持同一品牌源：macOS `.app` 内置 `AICOPPTEditor.icns`；Windows `.cmd` 因格式本身不能携带图标，首次运行时会生成本机专用、带 `.ico` 的 `AICO-PPT Dev Shell（Windows）.lnk`。该快捷方式被 Git 忽略；仓库移动后删除旧 `.lnk` 并再次运行 `.cmd` 即可按新绝对路径重建。

启动页顶栏持续提供“开始使用”“帮助”“安装与诊断”：开始使用以可恢复清单引导用户复制示例副本，示例只写入用户选择的新目录，不修改内置模板；帮助中心直接读取 `docs/user-guide/` 的 Markdown；诊断页调用与 CLI 相同的 Profile 快照，分别显示 Skill、Editor Core、独立 `dev-shell`、质量验证、PPTX 导出和材料解析状态。`dev-shell` 或其他可选 Profile 缺失不能阻止 DSH Editor Core 使用。

工作台与独立 Editor 页面都持有 App Server 的持续 WebSocket 页面租约。正常 `pagehide` 通过 beacon 主动退租；浏览器崩溃、强制结束或 beacon 丢失时由连接断开触发 5 秒重连宽限，随后统一关闭 Editor、Agent PTY、helper 与本地服务。HTTP 页面登记后 15 秒仍未完成持续租约握手也会自动回收。App → Editor 导航沿用同一租约身份，新页面接管会取消关闭计时，因此不能用仅依赖 `pagehide` 的实现替代这条连接生命周期。

启动页 Work Item 的显示名称必须与 HTML 文件名解耦：新建页左上角、启动卡片和工作区切换器只修改显示名称，不得隐式改磁盘文件。已有 Deck 用稳定 `deckId` 和平台 FileWitness 识别；源文件在 Editor 内外被改名后，可唯一确认时自动重新绑定并恢复原 Session，无法确认时仍保留工作副本、历史、任务和 Agent 上下文，但必须持续提醒并禁止 `solidify`。用户只能通过受控系统文件选择器重新绑定；重新绑定不得新建第二个工作项。若原子固化已成功而 Work Catalog 的 FileWitness 写回遗漏，活动 Editor 必须重新检查当前物理文件后补写；冷启动只能在同一 `deckId`、当前源文件指纹和最近成功固化检查点完全一致时恢复绑定，任一证据不一致仍保持冲突。固化必须携带当前 binding revision，并通过 POSIX 原子 exchange 或 Windows `ReplaceFileW` 写入当前绑定文件，不能向启动时缓存的旧路径写回或重建旧文件名。

Windows 启动 Agent 时，目录 identity 继续绑定可信真实路径，PTY cwd 则使用经过同一 `dev/ino` 复核的本地或映射盘符；盘符不固定为某个字母。只有 UNC 且没有可验证盘符映射时会拒绝启动并提示先映射，不能让 CMD 静默回退到 `C:\Windows`。

Editor 启动的全部 Python 子进程必须经 `scripts/editor/python-utf8.mjs` 固定 `PYTHONUTF8=1` 与 `PYTHONIOENCODING=utf-8`；sidecar、附件 writer、新建校验、工作副本 / 固化 adapter 的 stdin、stdout、stderr 都不得继承 Windows 控制台 GBK/ACP。这样跨 Windows / macOS 轮流操作时，任务文字、locator、中文文件名与用户可见错误保持同一 UTF-8 契约。

Codex、Claude Code 与 OpenCode 的自动任务提交同时遵守 provider 输入态、字节边界和接收回执：启动 banner、历史恢复输出、PTY `running`，以及 Codex 0.148 在初始化期间提前画出的草稿输入框都不算就绪；Codex 要等模型与工作目录完整状态栏，Claude/Ink 要等空 `❯` 输入行与光标，OpenCode 要等 `Ask anything` placeholder 与可见光标。恢复旧会话时，首个真实输入框出现前必须持续显示恢复遮罩，同时阻断人工键盘输入与 Agent 任务提交；任务按钮保持禁用，服务端 `POST /api/agent-runs` 也以 `AGENT_TERMINAL_RESUMING` 拒绝绕过界面的请求。若 Codex 恢复时已经画出最终输入占位符和光标、却仍残留陈旧的 `model: loading`，终端只自动执行一次一行尺寸重绘并恢复原尺寸；重绘本身不算就绪，仍须等待后续真实模型状态通过同一输入态闸门。Codex 的普通更新通知继续保持遮罩直到真实输入框出现；只有同时要求按键继续的更新面板才投影为 `interactionRequired: {kind: "codex-update"}`，暂时收起遮罩并仅开放终端输入，Agent 任务仍保持阻断。Codex 恢复会话目录与当前项目根不一致时，目录选择页投影为 `interactionRequired: {kind: "working-directory-selection"}`；其他带明确高亮编号项、至少两个编号选项和操作提示的未知 CLI 选择页走 `terminal-selection` 兜底。两者都撤掉遮罩并开放原始键盘，但继续阻断初始化 Prompt 和 Agent 任务，直到正常输入框出现。Windows 下三者的正文统一按 UTF-8 拆成不超过 512 B 的 bracketed-paste 分块并逐块节流，完整写入且单独关闭 paste 后才延迟发送 Enter；Claude Code 保留更长的 Ink 渲染等待。发送 Enter 后先进入 `awaiting-confirmation`，只有 CLI 输出活动区重绘或处理中信号才记为已提交；1.5 秒无回执只重试一次，仍无回执就显式失败并提示手动提交，不再把停在输入框里的文字误报成已发送。每次成功提交后重新等待下一个真实输入提示符；切换或重启会话会取消整条未完成提交链。

Windows WSL Codex 会在启动器阶段预热，并在同一进程缓存 Codex / Node 命令、HOME 与路径映射；终端依次显示 WSL 准备、Codex 启动和历史重绘。恢复历史只写入服务端 headless xterm，浏览器在真实输入态与最终画面投影均完成后才解除遮罩，不得逐块渲染历史 ANSI。该路径使用随 `package-lock.json` 安装的 `@xterm/headless` 与 `@xterm/addon-serialize`，不要求 native Windows Codex。

维护者调试命令保留：`python3 scripts/deck-editor.py <deck.html>`。以下可见窗口命令仅供明确调试使用；独立 Skill 正常制作使用前述无窗口流程：

```bash
python3 scripts/check_deps.py
python3 scripts/deck-editor.py <deck.html>
# 真实项目示例
python3 scripts/deck-editor.py Deck-Projects/renzhi/renzhi-deck.html
```

仅当维护者明确调试 macOS Dev Shell 时，才使用以下命令：

```bash
open -n "tools/dev-shell/AICO-PPT Dev Shell.app" --args --agent-thread-id "$CODEX_THREAD_ID" "$(pwd)/my-deck.html"
```

导入 Deck 时会展示项目根目录，用户确认后再进入编辑器：本次显式选择优先，其次保留有效的历史设置，否则默认使用 HTML 实际文件的直接父目录。“更改目录”从当前已配置目录打开系统选择器；取消保留现配置，再次更改使用最新目录。目录确认与身份校验仍按 `references/editing-guide.md` 执行。默认流程不再要求手动绑定：Editor 打开新任务时在后台为当前 Deck 启动 CLI 会话；Codex 必须通过持久化的 `codex exec --json` 完成首个初始化 turn，并以真实 `thread.started` ID 确认本地 session 可恢复后才写入 sidecar，不能把短生命周期 App Server 的内存 thread ID 交给 `codex resume`。启动页点击“继续任务”时，以该 conversation ID 恢复原 CLI 会话与工作副本；若 Codex 或 Claude Code 的可见 CLI 明确报告该会话 ID 不存在，PTY 会自动创建并持久化新的可恢复会话，同时保留当前工作副本和全部待办，其他启动错误不得误清绑定。首个 Prompt 对当前 `aico-ppt` Skill 只初始化一次，打开终端只是接入已经启动的 PTY。活动 provider、项目根目录与会话标识写入独立的 `agent-workspace.json`，使用 `workspaceRevision`；这些设置不增加 Deck revision，不进入撤销 / 重做或固化历史。旧 `CODEX_THREAD_ID` 与 `session.json.agentConnection` 只用于一次兼容迁移，不再是默认权威状态。

右上角显示真实终端状态（准备中、处理中、等待确认、空闲或失败），点击后从画面右侧推出唯一的 Agent 交互终端；不再提供结构化对话页签、消息气泡或独立消息输入框。终端抽屉与属性面板同高，默认宽度为浏览器窗口的三分之一；左边界可拖动，向左加宽时同步压缩中间画布，任务 drawer 也自动向内避让。窗口化 Agent Host 的 provider 注册表只提供 Codex、Claude Code 与 OpenCode：前两者分别固定执行 `codex --dangerously-bypass-approvals-and-sandbox` 和 `claude --dangerously-skip-permissions`，OpenCode 使用固定 `opencode` TUI；浏览器不能指定 executable 或附加参数。不存在或未登录的 provider 返回自身错误，不能静默回退到 Codex。bypass 进程启动不等于输入框已就绪：三种 CLI 若先询问是否信任当前目录，会发布 `interactionRequired: directory-trust`；Codex 恢复目录选择发布 `working-directory-selection`，其他可判定的编号选择页发布 `terminal-selection`。这些状态都会自动展开或重新展开右侧终端并闪烁提示，解除加载遮罩但保持初始任务锁定；用户在终端确认、正常输入框真正出现后才自动粘贴任务并回车。Editor 启动后即在已确认的项目根目录后台创建 CLI 会话并加载一次 `aico-ppt` Skill；同一编辑服务内刷新页面只重连原 PTY，Agent 任务也写入这个终端。终端是 Editor 的实时交互视图，但任务完成、Deck action、撤销与固化仍以 sidecar 为权威。界面不提供高级设置或“连接已有会话”，也不扫描历史会话；旧绑定数据只在打开 sidecar 时静默迁移一次。

桌面模式在编辑器浏览器页关闭 10 秒后自动回收本地服务；命令式入口仍由调用者用 `Ctrl+C` 结束。

任务删除规则以历史边界判断：仍有 `groupId` 的未固化完成任务不可删除；已固化任务可删除记录，删除不会改变 Deck 中已经固化的修改，但仍会清理对应局部截图与附件。

工作台只有预览、编辑、区域标记三种一级模式：编辑模式统一承担文字、移动和缩放；文字内部保持文本光标，单击即可放置光标并编辑，按住拖动可选择文字；红色选框边缘显示抓取手势，只有拖动边缘才移动整个元素，超过 7 个屏幕像素才启动位移；右下控制点继续缩放，不再要求先切换工具。模式栏左侧花形按钮是“全屏播放”入口：点击后先切到预览，再直接调用 Deck 原生放映模式；沿用原 Deck 的逐拍、翻页与 `Esc` 退出逻辑。编辑模式下可按住 `R` 临时进入区域标记，拉框后松开即回到编辑模式并保留标注输入框；临时 `R` 快捷键按物理 `KeyR` 识别，中文输入法组合态也有效，直接文字编辑和其他真实输入控件仍保留输入语义。区域拉框后在旁侧输入修改说明，任务会跨页累积到 Agent 任务 drawer；左侧页码 badge 只显示待处理、处理中、失败和待确认任务，完成项默认收进闭合的“已完成”分组。Agent 任务一旦完成就永久保持 `completed`；撤销 / 重做只切换修改效果，任务行按钮在“撤销”和“重做”间切换，不会恢复 badge、进入未完成列表或再次提交给 Agent。固化后完成项保留供查看，但不再提供历史控制。待处理、失败和待确认任务可二次编辑或确认删除；只有已经进入当前执行批次的任务锁定，运行期间新增的下一批标注仍可编辑或删除；未固化完成项不能编辑或删除。删除同步清理该任务的局部截图与附件。文字编辑范围始终复用单击后出现的红色选框：单击框内普通文字或局部加粗 / 着色片段，都只把红框对应的整个独立布局盒设为统一编辑区，不会因 `span` / `strong` 或局部格式包装拆成多个编辑框。混排段落提交时为实际改动的文本节点生成 `textPath` 动作，保留未改片段的格式与 `<br>` 结构；局部格式包装因覆盖或撤销重建后，旧 `textPath` 只在同一文字盒内按修改前原文唯一恢复，重复内容不猜测目标。单击只放置光标，不自动全选，可按住鼠标拖选；双击沿用浏览器原生按词选择，点击别处或按 `Cmd/Ctrl+Enter` 提交；全选后删除会提交合法的空字符串，不会因空内容被当作取消而恢复原文。移动命中不依赖 class，并把普通内联文字提升到最近的独立布局盒。图片内文字、SVG、链接与交互组件继续走区域标记，避免破坏结构。任何能读取本 Skill 并执行本地命令的 Agent 都可使用同一 workspace / Mutation 契约；窗口化 Editor 的自动会话与内嵌终端目前只支持 Codex、Claude Code 与 OpenCode，OpenClaw、Hermes 等仍可直接使用 Skill 或普通 action capability，但不宣称具备内嵌终端自动化。点击“交给 Agent”会把点击瞬间仍未完成的任务 ID 与 revision 原子捕获为持久化的不可变执行批次，再由 `AgentBatchCoordinator` 提交；按钮之后新增的标注进入“下一批 · 新标注”。当前批次失败、取消或 Editor 重启后，未完成成员保留为“批次 N · 未完成”，只有用户明确选择“重新提交本批未完成任务”或“合并到下一批”才会再次提交。运行状态经 observer WebSocket 实时回显；长步骤每 15 秒发送带用时的运行心跳。批处理先用 CLI `revision` 读取最小版本信息，再逐个读取本批任务，避免把完整动作历史送入 Agent。Agent 只通过受控 CLI / HTTP 调用 `GET /api/session`、`GET /api/tasks`、`PATCH|DELETE /api/tasks/<TASK_ID>`、`POST /api/actions`、`POST /api/groups/<GROUP_ID>/undo|redo` 和作为检查点的 `POST /api/write-deck`；真实发布只允许显式 `solidify`。observer WebSocket 使用 `/events`，仅订阅服务事件；唯一 editor capability WebSocket 只在 parent 与服务之间传递 frame 事务命令和 ACK，不对外提交动作。

文字拖选后，右侧属性面板和选区旁浮动工具条共享持续编辑会话；格式动作完成后恢复原生 Range、焦点和继续输入状态。面板支持字体、字重、斜体、下划线、字号、颜色、左 / 中 / 右对齐、项目符号和行距；`Cmd/Ctrl+B/I/U` 同时支持局部选区与整个文字盒。右侧面板把控件归入“文字 / 段落 / 外观 / 更多”四个互斥手风琴，对象摘要固定在顶部，恢复操作固定在底部；右侧终端展开后，面板停靠到画布上方，字体、字号与 `B/I/U` 保持单行常驻，段落、外观和更多使用互斥下拉抽屉，任何窗口宽度都不依赖横向滚动。表格单元格按独立 `TD` 文字盒命中，格式与直接改字都不会把整张表变成目标。局部选区和含富文本运行段的整框选中都会显示混合三态；整框字形修改覆盖完整字符范围，不会被内部 `span` 的旧格式挡住。退出直接编辑时同步恢复权威格式动作，消除恢复原 HTML 后的短暂无格式窗口。零长度文本节点不参与判定；统一格式先按运行段生成可逆动作，再把重叠范围编译成互不重叠的最终快照。同一字号或行距控件 3 秒内连续调整合并为一个撤销步骤。

页面栏与属性面板的开合控件共用 30px 圆形白底 PillNav 箭头：hover 只运行液态圆形填充，不克隆箭头参与文字翻页；页面栏展开 / 收起朝左 / 右，右侧属性面板展开 / 收起朝右 / 左，顶部属性面板展开 / 收起朝上 / 下，方向变化只旋转同一枚 CSS chevron。

顶栏的“撤销 / 重做”只移动同一条权威编辑时间线的唯一历史游标。历史按修改本质分为两类：`ActionMutation` 覆盖人工或 Agent 提交的文字、样式、移动、缩放与显隐，重放稳定 locator；`SourceMutation` 覆盖模板升级、复杂 DOM / 动画重构和整页增删排序，保存托管工作副本的前后 SHA-256 版本。两类共用 revision、历史游标和固化边界；新修改截断游标后的旧重做分支，结构修改必须按时间顺序撤销 / 重做，不能伪装成文字 action。所有带 revision 的写操作都会先登记已经写盘但尚未被文件通知处理的 SourceMutation，再拒绝过期请求；因此人工动作、撤销 / 重做和固化不能越过 Agent 的实际写盘顺序。源码基线后的旧 action 只在几何、语义指纹和语义规范化后的 `before` / `after` 当前值仍一致时重放；若受控源码前后归档能证明同一持久元素的静态文字已被覆盖，先将旧文字及失效字符范围样式记入源码事务的投影取代清单，保留原历史以支持撤销；其他无法证明的属性、语义或范围冲突仍以 `HISTORY_DIVERGED` 安全报冲突，界面必须可见提示，固化补丁也执行同一规则。`Cmd/Ctrl+Z` 撤销，`Cmd/Ctrl+Shift+Z` 重做，Windows 也可用 `Ctrl+Y`。焦点位于文字或其他输入框时快捷键保留原生输入撤销，不触发 Deck 全局历史。任务行撤回非末尾 Agent ActionMutation 时追加可逆的补偿修改，保留后续仍成立的修改；涉及 SourceMutation 或无法证明安全时返回 `COMPENSATION_CONFLICT`。区域任务可选择文件（支持多选和连续追加）或粘贴图片，粘贴图片会转为 PNG；每个任务最多 8 个附件，单个文件最大 25 MiB。浏览器无法取得原文件绝对路径，服务会把副本复制到 sidecar 会话的 `attachments/`。只有任务 payload 的序列化出口会派生路径：`GET /api/tasks`、`GET /api/tasks/<TASK_ID>`、`POST /api/tasks` 响应中的 `task`、`task-created` / `task-updated` 等事件或动作响应中的 `task`，以及 CLI `tasks` / `task`；这些出口返回副本绝对 path，供外部 Agent 读取。`GET /api/session` 与磁盘 `session.json` 只含 sidecar 相对 `relativePath`，不保存、也不返回附件绝对路径。附件不进入最终 deck，并随 sidecar 生命周期管理，也不属于 Deck 动作的撤销 / 重做范围。

内置 `structure` 自动封装下述事务；超出局部操作范围时，Agent 结构修改必须先执行 `begin-source-edit`（区域任务使用 `begin-source-task`）取得 `sourceEditId` 与预留 revision，成功后才能写工作副本，写盘完成必须执行 `commit-source-edit`；提交在登记 SourceMutation 前用真实浏览器重放已有固化补丁。若新源码确实删除了更早固化动作的页面或元素，验证器明确返回 `PAGE_NOT_FOUND` / `TARGET_NOT_FOUND` 时只剔除该旧动作并从头重放，同时把补丁转换记入 SourceMutation，撤销 / 重做会同步恢复 / 再次剔除；其他失败拒绝候选、恢复事务前工作副本并保留事务供取消或重试。失败后执行 `cancel-source-edit` 回滚。事务活动期间，人工 action、撤销、重做和固化统一返回 `SOURCE_EDIT_ACTIVE`，不能插入 Agent 写盘的中间。源码事务与 revision 一并持久化；服务重开后仍保留开始前基线，只允许同一 `sourceEditId` 继续 commit 提交或 cancel 取消，不由文件监视器猜测提交顺序。文件监视器只兼容旧客户端在事务外直接写入的路径，并执行同一补丁重放闸门；结构历史撤销 / 重做也先验证目标版本，失败时恢复当前工作副本且不移动历史游标。

`data-editor-id` 是可编辑元素的持久元素身份。Agent 移动或调整层级时必须保留既有 `data-editor-id`；新增元素会在 SourceMutation 之前由工作副本归一化补齐。`sc-for` 循环模板的后代不得携带静态 `data-editor-id`，归一化会跳过新节点并清理旧工作副本中的误注入身份，避免循环实例共享同一目标。格式错误或重复的身份必须安全停止。`data-editor-id` 只定位元素，不放宽 `before` / `after` 与文字范围校验；Agent 改写同一属性或改变字符偏移时仍然冲突关闭。旧 action 没有该身份时继续使用保守的路径、几何与语义锚点，不猜测迁移目标。

右侧 Codex / Claude Code / OpenCode CLI 执行本批反馈时，用户按独立 `Esc` 会同时中断 CLI turn 与当前 `AgentRun`；本批进入 cancelled，未完成任务仍为 pending / failed，可重新点击提交，长期 PTY 不退出。方向键等多字节终端转义序列不得触发该同步。

使用 CLI 的区域任务结构修改必须逐项建立源码事务：执行 `node scripts/editor/cli.mjs begin-source-task TASK_ID` 后保存返回的 `sourceEditId` 与 revision，再用 `scripts/edit-bundle.py` 对 `AICO_PPT_WORKING_PATH` 做一次原子保存，最后按该 revision 执行 `commit-source-edit SOURCE_EDIT_ID`。提交会把 SourceMutation 关联任务并标记完成；失败时执行 `cancel-source-edit SOURCE_EDIT_ID`。结构历史撤销 / 重做只切换修改效果，任务永久保持完成且不会再次进入 Agent 队列。自由终端对话产生结构修改时用 `begin-source-edit` 建立不绑定任务的事务。

Editor 启动时把真实 Deck 复制到 sidecar 的 `working/deck.html`，并为旧页面一次性补齐稳定 `data-page-id`；会话期间真实 Deck 始终只读。重开会话时，工作副本内嵌且可解析的补丁块是浏览器实际使用的固化基线；若它与历史 `session.solidifiedActions` 因旧版编码或中断不一致，必须先以内嵌补丁对账，再迁移页面身份，并保留当前编辑时间线。session v2 以 `timeline.entries + timeline.cursor` 为权威，`groups / redo` 只是兼容投影视图；旧版 active 空洞在加载时线性化，无法证明有效的 redo 进入迁移归档。若上次写入中断导致当前工作副本无法解析，启动器会把坏候选留在 `working/versions`，按 `session.workingDeckFingerprint` 自动恢复最后有效版本并在 Editor 提示；不能找到严格匹配版本时仍安全停止。预览、区域标记、ActionMutation 和自动会话保存都只读取工作副本与 session。终端自由对话时，已有元素的单一文字替换优先用 CLI `locate-text` / `replace-text`，其他细节修改用 `apply`，最终都进入 ActionMutation；`POST /api/actions` 的 `commandId` 保证相同命令重试幂等。模板升级、复杂 DOM / 动画重构和整页增删排序必须经 `scripts/edit-bundle.py` 修改 `AICO_PPT_WORKING_PATH`，该脚本会先在内存验证 bundle，再同目录临时写入、fsync 并原子替换；源码提交与兼容文件监视器都在验证 bundle、补齐元素身份并通过已有固化补丁的真实浏览器重放后，才记录 SourceMutation 并刷新 iframe。绝不能直接修改真实 Deck，也不能手工编辑 `huawei-deck-editor-patches` 块。正式发布先调用 `POST /api/solidify-preflight`，再携带绑定 revision、双 fingerprint、动作投影和 60 秒有效期的一次性令牌调用唯一写入 API `POST /api/solidify-deck`；可见 Editor 由用户在顶栏点击“固化修改”并二次确认，无窗口 Skill 仅在用户明确要求完成、保存或正式写入时由 Agent 调用。写入通过 bundle verify 与补丁重放闸门后由可信 sidecar 原子替换真实 Deck，创建固化检查点并归档旧时间线。连续固化不会丢掉上一轮结果，也不会按轮次追加脚本块。浏览器标签页的 `×` 会直接关闭，不触发 Chrome 通用离开提醒；网页无法用自定义弹窗接管标签页关闭。要离开编辑器，应点击品牌区右侧、页面左上角独立的“退出编辑”；右侧工作区导航继续保留“初始页”按钮，二者不能互相替换。有未固化历史或 Agent 正在运行时，“退出编辑”会直接打开页面内未固化任务清单，按最新修改倒序列出页码与任务说明，并提供“继续编辑”“暂不固化，退出”“固化并退出”。后者仍调用同一个预检与安全固化流程；未固化历史与工作副本会保留到下次打开。`Cmd/Ctrl+S` 与 `POST /api/write-deck` 只做受控检查点，不发布真实 Deck。冲突或验证失败一律拒绝覆盖。

重开预览与固化验证遇到被后续 SourceMutation 明确取代的旧动作时，只允许对历史标记为可 rebase 的动作批量跳过 `PAGE_NOT_FOUND` / `TARGET_NOT_FOUND`；未授权缺失、歧义和语义冲突仍立即失败。固化验证器在同一浏览器进程内收集全部可清理动作，恢复候选后只重写一次并做最终完整复验，不能按失效动作数重复写整份 Deck。原子写入阶段使用不确定进度提示，不显示长期停在某个百分比的伪进度。

当前退出交互以“退出编辑器”为唯一文案：初始页、流程页和各编辑页面的品牌区右侧保持同一位置，文字右侧使用品牌红线性的门框与向右退出箭头，不带独立底框，也不再使用返回箭头或圆圈 `×`。退出会调用同时校验当前浏览器 Origin 与独立 editor capability token 的显式 shutdown，关闭启动器、全部编辑运行时与 Agent 终端；Agent 的通用 API token 无权调用该接口。退出弹窗必须覆盖游标前全部生效条目，按 `taskId` 分组；每个任务默认只显示任务说明与下拉箭头，首次展开时才生成页码、条目数和具体修改类型。`taskId:null` 的直接编辑 / 结构修改单列，游标后的重做历史另行提示，不得把不同任务的修改混成一个列表。

进入后期编辑器后，iframe 动作层不直接增删页、调整页序或重构复杂动画；这些结构工作由右侧真实 PTY 中的 Agent 经 `scripts/edit-bundle.py` 修改托管工作副本。插页必须获得全新 `data-page-id`，移页保留原 ID，删页只删除目标 ID；因此其他页面的既有 action 不因页序变化漂移。任务原 `pageKey` 在当前工作副本中不存在时保留 `targetMissing` 作为不可定位安全标记，不得据此断言页面一定被删除；只有待处理、失败或待确认任务显示“原目标不可定位”并停止交给 Agent，已完成历史仍显示“已完成”且不进入告警计数。未固化结构修改可直接重开并撤销，撤销后仅修改效果恢复到历史前态，任务仍永久保持完成。若删除 / 重构了仍有 active action 的目标，Editor 必须允许启动和撤销，但固化必须以 `MISSING_PAGE_TARGETS` 明确拒绝并要求先处理冲突。编辑器不另造聊天协议，而是承接新建阶段同一个 CLI 终端。所有 Agent 动作都要经过 token、revision、locator 与事务校验。session 可在关闭后重开；若出现 `RECOVERY_REQUIRED`，未决恢复状态会阻断继续写回。

CLI 出现 `COMMAND_TIMEOUT` 时不得绕过 Action 直接修改真实 Deck，也不得转用外部浏览器插件猜测页面状态。先用 `revision` 确认 HTTP 服务；若只读命令正常而 `locate-text` / `apply` 连续超时，说明 parent/frame capability 未回执。当前编辑服务会在启动时固定前端资源快照，刚更新 Editor 代码后仅 `Cmd/Ctrl+R` 仍是同一快照，必须关闭并重新启动 Editor 服务再重试；未固化工作副本与历史会从 sidecar 恢复。

写回后仍按完整工具链验证：`python3 scripts/edit-bundle.py <deck.html>`（等价调用 `eb.verify`）、`node scripts/verify/measure_overflow.mjs <deck.html> --all`、改动页 `shot.mjs`；只有修改了动画页才需要运行 `steps.mjs`。`shot.mjs` 与动画页的 `steps.mjs` 均按 1920×1080 逻辑画布截图；无动画页运行 `steps.mjs` 只打印“此页无动画”并退出 0，不生成逐拍截图。详细操作、错误恢复和外部 Agent 命令见 `references/editing-guide.md`，组件与信任边界见 `docs/architecture.md`。

编辑模式中，从红框边缘点选整个元素后按 `Delete` / `Backspace` 以可撤销的 `hide` ActionMutation 删除；直接文字编辑中的删除键仍只修改文字。Windows / Linux 内嵌终端的 `Ctrl+V` 放回浏览器原生文字粘贴，不向 Codex 发送图片粘贴控制字符；有文字选区时，`Ctrl+C` 由浏览器复制且不向 PTY 发送 `0x03`，没有选区时仍发送终端中断。macOS 继续使用原生 `Cmd+C` / `Cmd+V` 路径。

恢复历史任务时，最近 Deck 记录必须携带已确认项目根；Creation 旧记录缺失时只能从与当前发布 Deck 相互校验通过的 `creation-context.json` 补齐，不能回退为启动器 cwd。持久化根可修复旧版漂移的会话绑定；用户显式换根时则保留旧会话历史、清空其活动指针，新根下创建新会话。`working-directory-selection` 仅是异常兜底，不是正常恢复流程。

## 设计铁律（细则见对应 reference）

1. **中文绝不只挂 JetBrains Mono**（无中文字形会回退成细体）——中文一律 Noto Sans SC → `references/design-system.md`
2. **给听众读的散文最小 21px**；图表 / 表格按阅读任务选择字号，承担主体解释的段落不能借图元豁免，截图目检可读性 → `references/design-system.md`
3. **去花花绿绿**：只用 品牌红 + 灰蓝 + 中性灰 三色体系，红只给真警示 / 重点 → `references/design-system.md`
4. **动画只靠讲者手动推进，绝不自动循环**；页面上**绝不写「点击查看」「点击切换」类操作提示**——操作逻辑是讲者的事，页面只放内容 → `references/animation.md`
5. **改 template 必须经 edit-bundle.py**（转义有铁律），绝不用编辑器直改文件 → `references/editing-guide.md`
6. **每页内容必须塞进 1080 高**（超出被无声裁切），改完必跑 measure_overflow → `references/design-system.md` 第 7 节
7. **从零起新 deck 先对齐再动手**：主题与大纲没经用户确认前不碰模板 → `references/workflow.md`
8. **字不如表，表不如图**：方法论 / 原理 / 流程页用图表做主表达——初版放类型化占位块，终版抽原图 / 自绘 / 制表落地、`data-todo` 归零 → `references/artwork.md`
9. **文字朴实专业、标题即观点且点明对象**：机制页写技术与效果，资产页写具体产物，计划页写对象与行动；不堆术语、泛化建议或重复导语。先整理事实与来源，再按页面问题组织，初版即做内容与删字自检 → `references/workflow.md` 第 1.1、2.1、4.1 节
10. **表格统一用标准样式**：品牌红表头 + 白色居中粗体、全黑边框、分组范围 3px 黑色粗外框、正文黑字且同级字号统一；按观看尺寸保证可读，不盲用紧凑示例的 15px。列宽直接写到 `th` / `td`，从 `15% / 19% / 66%` 按信息量调整，主要空间给具体产物与证据；空间不足时自然换行，表格用 `flex:1;min-height:0` 吃满可用高度 → `references/artwork.md` 第 4 节
11. **卡片只用统一白卡体系**：同组同角色的大卡片统一白底 + 浅灰细边 + 14px 圆角，标题 / 正文 / 标签的字体层级与留白完全一致；默认黑色标题，只有文案明确说明选中、推荐、当前、风险或结论差异时才允许单卡红色高亮；删除不承载业务信息的胶囊、角标和版式说明标签 → `references/design-system.md` 第 5～6 节
12. **异构架构必须展开差异单元**：当不同层 / Block / 模块的执行路径不同，不能只画抽象层列表；必须依据项目源码或正式规格展开代表单元，标清输入输出、状态、缓存、分支与选择策略 → `references/artwork.md` 第 3 节
13. **自绘图按工程图验收**：红色只标真正关键节点，不画无意义红框；所有 SVG / HTML 图逐项检查文字不越框、箭头方向正确、线条接在框边而非穿框或悬空，普通 overflow 检测不能替代截图目检 → `references/artwork.md` 第 5 节
14. **导航 / 缩放 / 放映运行时维护**：左上侧边预览统一为 `图标 + x/yy`；放大后统一支持空格临时抓手、glass 小手锁定；放映态普通滚轮统一复用方向键节拍且按手势防抖。修改公共运行时同步通用外壳并更新版本标记；外壳 hash 会自动触发旧 Deck 重组。只有用户内容 seam 或 bundle 格式变化时才改升级器 → `references/animation.md`
15. **页内多画面只用 layer 协议**：目录、标签页、方案切换、阶段视图等互斥画面统一使用固定 DOM 的 `data-layer-btn` / `data-layer-panel` / `data-layer-group` / `data-active`；禁止再造 `_cur` / `data-mod` 状态机，也禁止在切换时用 `innerHTML` 重建按钮或面板 → `references/animation.md` 第 3 节
16. **目录动画始终服从当前大纲**：新建，或修改涉及章数、章名、章节目标、页序、目录 DOM 或目录动画时，都必须逐章重建；不得原样继承模板 `tocBuilders`，发布前必须通过 `toc_contract.py` 与目录逐拍截图 → `references/animation.md` 第 3.2 节

## 文件导航

| 文件 | 用途 |
|---|---|
| `assets/training-deck.html` | 34 页授课模板 deck（复制后再改） |
| `assets/tech-share-deck.html` | 37 页技术分享模板（深色 KV 封面 / 选型 / 原理 / 性能 / 代码曲线指标 / 精读 / 跟读 / 踩坑 / Takeaway） |
| `assets/work-report-deck.html` | 46 页工作汇报模板（TL;DR / KPI / 战略能力组合 / 系统交付侧栏 / 分层运维架构 / 双层方法管线 / 阶段责任交付 / 甘特 / 风险） |
| `assets/qualification-deck.html` | 22 页通用任职模板，保留举证页型，个人信息与图片均为占位 |
| `assets/project-review-deck.html` | 54 页 DRB 项目评审模板（组织、架构、组网、计划与表格） |
| `references/qualification-template.md` | 任职材料填写边界与页型索引 |
| `references/project-review-template.md` | DRB 填写要求与原 PPTX 页码映射 |
| `references/workflow.md` | 七阶段协作流程；材料事实整理、按页面问题组织、初版与终版内容自检 |
| `references/template-pages.md` | 五套模板逐页索引：怎么选模板 + 每页长什么样 / 常用于 / 怎么改 / 动画拍数 |
| `references/design-system.md` | 颜色、字体、可读性、排版与卡片；导语 / 小字取舍和来源去向 |
| `references/animation.md` | build / layer / SMIL 三机制写法、节拍设计与验证 |
| `references/page-snippets.md` | 可直接粘贴的页面骨架与构件（每段注明模板活例） |
| `references/editing-guide.md` | 从零新建、后期微调、独立版结构、edit-bundle 用法、错误恢复、验证与 PPTX 导出 |
| `references/artwork.md` | 配图工作流：初版类型化占位 → 终版 PDF 抽原图（PyMuPDF）/ 自绘流程架构图 / 表格 |
| `references/branding.md` | 品牌替换：背景画 / 黑板 / 人像 / logo / 口号 / 品牌色 |
| `references/huawei-style.md` | 华为官方胶片风格分析：两套配色公式、页型清单、标题句式、数字用法、高复用组件 |
| `assets/huawei-refs/` | 官方 PPT 提取素材库：封面 KV / logo / 图标 / 装饰组件 + 官方空白模板 pptx（内附 README 索引） |
| `scripts/edit-bundle.py` | 安全编辑工具函数库（load / get·set_template / insert·delete·move_page / embed_image / verify） |
| `INSTALL.md` | Skill、DSH Plugin 与独立 Dev Shell 的安装、修复与卸载指南 |
| `tools/dev-shell/AICO-PPT Dev Shell.app` | macOS 独立 Dev Shell；开发、回归或排障时打开，也可接收 Skill 传入的 HTML |
| `tools/dev-shell/AICO-PPT Dev Shell.cmd` | Windows 独立 Dev Shell；短时转交 `scripts/deck-editor.py --detach-windows --app` 后退出 |
| `scripts/create_windows_launcher_shortcut.ps1` | 为 Windows `.cmd` 生成带品牌图标的本机 `.lnk`；快捷方式本身不进入 Git |
| `scripts/install.py` | 跨平台 Developer Link 安装器；安全注册、检查、修复和卸载 Skill |
| `scripts/extract-pptx.py` | 用标准库按页提取 PPTX 标题、正文、备注、表格与内嵌原图，输出内容文件供 AI 直接阅读 |
| `scripts/check_deps.py` | 按 `editor-core` / `dev-shell` / `verify` / `pptx-export` / `pptx-read` / `materials` Profile 诊断与修复依赖 |
| `scripts/deck-editor.py` | 桌面与命令式入口共用的启动模块（默认只监听 127.0.0.1，并自动打开浏览器工作台） |
| `scripts/editor/` | CreationDraft、DeckFactory、真实 PTY、浏览器 parent/frame、sidecar、动作日志与安全写回实现 |
| `scripts/apply_bg.py` | 品牌图一键替换（默认预览模式，`--yes` 落盘） |
| `scripts/upgrade_deck.py` | 公共外壳 hash 对比、历史模板三方合并、最新模板重组、manifest 合并、自动备份与视觉审计 |
| `scripts/test_upgrade_deck.py` | 升级器的 profile、品牌元素、历史模板与最新版运行时回归测试 |
| `scripts/verify/*.mjs` | verify 三件套（measure_overflow / shot / steps） |
| `scripts/verify/toc_contract.py` | 新建 Deck 的目录章数、chapterId、章名、目标与逐章动画强校验 |
| `scripts/html2pptx/convert.py` | macOS / Windows / Linux 共用的 HTML → PPTX 入口；`convert.sh` 仅为 POSIX 薄包装 |
| `scripts/react*.umd.js` | 离线 React 备件（模板已内联，仅修复用） |

## 编辑独立版的最小代码块

deck 的 HTML 藏在一行 JSON 字符串里，必须经 edit-bundle 读写（直改文件必坏）：

```python
import importlib.util
spec = importlib.util.spec_from_file_location('eb', 'scripts/edit-bundle.py')
eb = importlib.util.module_from_spec(spec); spec.loader.exec_module(eb)

lines = eb.load('my-deck.html')
s = eb.get_template(lines)          # 解码出整份 deck HTML 字符串
s = s.replace('旧文案', '新文案')     # …字符串手术（先切片到目标 section，见 editing-guide）
eb.set_template(lines, s)           # 回填（自动做转义与断言）
eb.save('my-deck.html', lines)
eb.verify('my-deck.html')           # 页数 / 导航 / 章节一致性检查
```

### 区域任务的交互画面绑定

编辑器打开时默认进入区域标记，左侧页面栏默认折叠为窄页码轨道，可按顶部箭头展开完整标题。区域说明弹窗可选“继续添加任务”只保存当前标记，或选“直接提交任务”将累计的全部待完成任务作为一批交给 Agent。区域标记模式下按住 `R` 会临时进入预览，可直接操作 Deck 内按钮，松开后恢复区域标记；输入控件继续把 `R` 当普通文字。区域拉框时把当前页的 layer、分步显示、展开项等交互状态写入受限 `pageState`，任务定位会先恢复标记时的画面，再显示原区域；编辑器仍能读取历史 Deck 的 `data-mod` 目录状态，但新模板和新页面不得继续生成该结构。Deck 内导航与主 `.stage` 的滚动结果会同步回左侧页序，同页内容重绘不会再触发页面重定位，缩略图副本不参与页面身份。

## 性能与依赖

- **桌面应用安装**：安装兼容的 AICO Host，再从内置商店安装 AICO-PPT；插件下载只包含插件与私有 Python 两个组件，截图和验证复用 Host 的 Electron。源码配对安装和旧历史迁移属于开发调试入口，条件与命令见 [安装指南](INSTALL.md)。
- **Skill 注册**：Codex 的标准用户级位置是 `~/.agents/skills/aico-ppt`。独立使用 Skill 时运行 `python3 scripts/install.py install --skill-only`（Windows：`py -3 scripts\install.py install --skill-only`）；默认不带参数也只注册 Skill；只有显式加 `--dev-shell` 才准备维护者调试依赖。已有冲突目标不会被覆盖，已有同源但无记录的链接也必须通过诊断页“接管此安装”或 `repair --adopt-existing` 明确确认后才登记所有权。完整说明见 `INSTALL.md`。
- **按任务体检**：桌面运行时沿用注入的 Python 包装器，按当前任务选择 Profile 并使用 `--check-only`。独立 Skill 在源码目录运行 `python3 scripts/check_deps.py --profile verify --check-only`（Windows：`py -3 scripts\check_deps.py --profile verify --check-only`），按需要将 `verify` 换成 `editor-core`、`pptx-export`、`pptx-read` 或 `materials`；`dev-shell` 仅供维护者调试壳，`full` 检查全部能力。独立 Skill 加 `--repair` 可修复可自动安装项，`--json` 输出结构化结果；无 `--profile` 的旧命令仍按 `full` 自动修复，桌面运行时不使用该入口。退出码：0 所选能力就绪 / 1 仍缺 / 2 工具或参数错误。
- 性能以当前渲染引擎和 Deck 实测为准；layer 标签展开会增加导出页数，导出用时同时受页面数量、截图倍率及图片大小影响。
- 依赖：Editor Core 需 Node.js、`ws`、`html2canvas`、`busboy` 与 `three`；独立 `dev-shell` 才增加 `node-pty`、浏览器 / headless xterm 与一个本机 Agent CLI。桌面质量验证复用 Host 的 Electron 渲染服务，正式插件只携带私有 Python；独立 Skill 使用 Google Chrome + playwright-core（三级查找：`PLAYWRIGHT_CORE` 环境变量 → 根目录 `npm i playwright-core` → openclaw 内置路径）。PPTX 截图组装只用 Python 标准库，`--embed-html` 的附件图标另用 Pillow。桌面脚本沿用 `AICO_HOME` 与运行时包装器，能力不可用时启动或升级 AICO，不安装第二份浏览器。
- **读取参考 PPTX**：运行 `python3 scripts/extract-pptx.py 参考.pptx 输出目录`（Windows 将 `python3` 换成 `py -3`），只用 Python 标准库，`pptx-read` Profile 只检查随包提取工具。输出 `slides.json`、`slides.md` 和 `media/`：按页提取标题、正文、备注、表格与内嵌原图，图片保留页关联。AI 直接阅读内容文件和需要的原图；结合原文件理解内容，不生成版式预览、不转 PDF、不安装 Office。图表、SmartArt 等未提取对象会逐页提示限制，不能把提取结果当作原文件全部内容。字段和操作见 [artwork.md](references/artwork.md#21-从-pptx-提取内容与原图)。
- **读取 PDF 材料**：`materials` Profile 只检查 PyMuPDF 与 pypdf。文字、表格、原图、合并 / 拆分、渲染和普通批注用 PyMuPDF；AcroForm 字段填写用 pypdf，以保留中文字体外观。按随包 `.agents/skills/pdf/` 的适配方法执行，不用上游重装覆盖本地适配。PDF 工具缺失不影响 PPTX 内容读取。


### Harness 会话直接编辑

已明确关联 Deck 的 Harness 会话会在每次模型调用前获得当前 Editor 工作区连接，包含受限 action capability 文件与托管工作副本路径；恢复旧会话或重启后重新解析，不依赖固定措辞。用户可直接在左侧讨论或要求修改，讨论只读，明确修改复用右侧同一工作区，无需先提交区域任务或退出 Editor。结构修改按 begin-source-edit / commit-source-edit 事务提交，每批成功后更新预览；事务期间人工写入保持串行保护。未关联会话不注入 Deck 能力，已关联但 Editor 不可用时提示重新打开对应工作区，不另起 headless 编辑器抢占租约。

创建画布由外层宿主管理对话，不初始化独立终端；模板预览与编辑桥接分别就绪。若生成因编辑器离线或验证失败而保留 staging，修复后使用原 Draft 的 `generation-ready` 和最新 `expectedRevision` 重新执行完整验证与发布，保留同一 run 和工作副本；`retry-generation` 会重新创建模板，仅用于明确重新生成。固定页结构校验忽略托管元素 `data-editor-id` 和空元素标签序列化空格，仍校验布局属性与 DOM 结构。

### 任职资格评审

用户要写任职材料时，优先选 `qualification`（22 页），按 [任职材料模板](references/qualification-template.md) 收集申请专业、级别与举证材料。沿用页型并填写当前申请人的事实与举证材料，姓名、项目、结果、证明人与图片均需来自当前材料。目录按当前大纲重建。

### 项目评审与 DRB

用户要写项目评审材料时，优先选 `project-review`（54 页），先读 [项目评审模板](references/project-review-template.md)。按本次评审范围填写输入件、合同与责任边界、方案可交付性、实施与资源计划、伙伴、假设、风险、运维、成本和待决策事项。原参考文件为历史案例，当前流程及结论必须重新核实。
