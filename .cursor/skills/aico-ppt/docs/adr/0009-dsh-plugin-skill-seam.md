# ADR-0009：DSH 插件与 AICO-PPT Skill 的边界

- 状态：已接受并实现
- 日期：2026-09-02
- 分支：`codex/dsh-web-plugin`

## 背景

AICO-PPT 仓库同时包含 Skill、模板与脚本、Managed Workspace、可视化 Editor，以及供独立桌面入口使用的 Agent PTY。接入 DSH 时必须同时满足两点：保留原 Editor 的全部成熟操作逻辑；对话、模型和审批只能由 DSH 当前会话拥有，不能再出现第二套聊天和第二个 Agent。

初版曾计划在 `conversation.view` 里重写一个只读 Editor 外壳。该方案会复制页面状态和操作逻辑，也会用整页切换替换对话，无法满足“左侧对话、右侧 Editor”和完整复用的要求，因此被放弃。

## 决策

仓库继续以根目录 `SKILL.md` 为唯一 Skill 真源，同时让根 `package.json` 成为可安装的 DSH Bundle。DSH 新增通用根级 `sidecar` 与 `workbench.view` 扩展点；AICO-PPT 插件启动原 App Server，并把原 Editor Runtime 嵌入该 workbench。

| 模块 | 分类 | 责任 | 不负责 |
|---|---|---|---|
| `SKILL.md` + `references/` | Skill | 制作流程、质量契约、编辑与验证指令 | UI、会话、运行时几何 |
| `scripts/` + `assets/` | Skill 资源 / Editor Core | bundle 编辑、模板、Managed Workspace、frame bridge、任务、历史、验证、固化、导出 | DSH 对话和布局 |
| `integrations/dsh/index.mjs` | Plugin Host Adapter | 注册唯一 Skill；以 DSH 嵌入模式启动原 App Server；注入入口 | 启动第二个 Agent |
| `integrations/dsh/client.js` | Plugin Client Adapter | 注册侧栏入口和 `workbench.view`；承载原 Editor iframe；桥接当前会话 | 复制 Editor 业务状态、渲染第二套聊天 |
| DSH `ui-workbench` | DSH 通用 UI 基础 | 管理右 sidecar 的活动视图、宽度、开关和 Session 切换生命周期 | AICO-PPT 事务和品牌 UI |
| `cordis.patch.yml` | Plugin Bundle | 安装 Host/Client 双面插件行 | 业务状态 |

## 关键不变量

1. Skill 的内容和相对资源只有仓库根目录一份；Plugin Host 的 `resourceBase` 必须指向该根目录。
2. DSH 对话与 Editor 同时可见：对话在左，通用 workbench 在右；AICO-PPT 不再占据 `conversation.view`。
3. DSH 嵌入的是原 App/Editor Runtime。页面栏、三种模式、画布、属性、任务、动作历史、固化和导出不能在 Client Adapter 中重写。
4. DSH 嵌入态不导入或实例化 Agent Terminal、不自动启动 PTY、不加载 xterm、不连接 `/agent-terminal`；桌面独立入口仅作为 Dev Shell 保留原 PTY 能力。
5. 属性栏在嵌入态停靠于画布上方；任务 drawer 仍浮在 Editor 右下角。它们属于 Editor，不属于 DSH workbench chrome。
6. “交给 Agent”通过当前 Session scope 的 `conversation.send()` 提交区域编辑协议，携带本批任务 ID、工作副本与受控 Editor CLI；Agent 使用原生 `aico_ppt` 的 inspect 获取 revision，再按该版本 edit。已有工作区不重复加载完整 Skill；创建任务会话时仍可通过 `/aico-ppt` 引用 Skill，`$aico-ppt` 只用于使用该语法的独立 Codex 流程。任务与修改完成状态仍由 Editor Server 判断。
7. 用户关闭或再次点击 AICO-PPT 只改变 sidecar 可见性，不终止 Host 持有的 Editor Runtime；重新打开应恢复当前 Deck。Session 切换同样不销毁 workbench。
8. 只有用户显式固化，Editor 才把工作副本安全发布回真实 Deck；打开、预览和交给 DSH Agent 都不能绕过原发布闸门。

## 被否决的方案

- **在 DSH Client 重写 Editor**：会产生第二套选择、任务、history 和固化逻辑，难以保持行为一致。
- **把整个 DSH 会话页替换成 Editor**：用户无法同时对话和观察修改结果。
- **在插件中保留原 PTY**：造成两个模型入口、两个审批边界和两份对话记录。
- **复制一份 Skill 到插件目录**：形成两份质量契约并产生版本漂移。

## 结果

Codex、Claude Code 等工具可以只安装 Skill，通过脚本和无窗口 Managed Workspace 创建或修改 Deck；需要窗口交互时再安装 DSH Plugin。插件增加的是入口、右侧窗口和 DSH 会话桥，所有 Deck 操作仍来自同一 Editor Core。独立 Editor 的产品定位由 ADR-0002 收敛为开发、回归和故障排查用 Dev Shell。代价是当前实现仅面向本机 loopback DSH Web，并且 Host 在插件生命周期内持有一个本地 Editor App Server。
