# AICO-PPT 安装指南

## 本地优化包：0.1.30

2026-10-05：新增配合 Harness dev.62 的只读重启检查与固定运行版本。未提交输入、正在执行或保存的修改会阻止自动重启；已持久化的未固化历史可以保留到重启后。修复无关标注增删改使 Agent 编辑误报版本冲突；保留当前任务变化和真实 Deck 修改的冲突保护。明确未提交的拒绝不再要求查询回执。包含此前局部结构编辑、按需上下文、截图复用与跨页撤销／重做修复。Windows 完整包为 `dist/aico-ppt-skill-0.1.30-win32-x64.tgz`，包含私有 Python、浏览器和运行依赖；本地构建不代表官网已发布，也不代表已完成 Windows 整机验收。

在原装 Desktop 的 DSH Terminal 依次安装本地新包（替换为实际路径）：

```powershell
dsh plugin add "C:\Users\z00633277\workspace\AICO-2.0\AICO-Harness-Plugin\dist\aico-harness-2.0.0-dev.62.tgz" --ignore-scripts
dsh plugin add "C:\Users\z00633277\workspace\AICO-2.0\AICO-PPT\dist\aico-ppt-skill-0.1.30-win32-x64.tgz" --ignore-scripts
```

保存工作，从系统托盘完全退出 DSH Desktop，再重新打开一次以加载新的提醒逻辑。

## 普通用户：已发布 beta0.1

更新：2026-10-03。固定原装社区版 DSH Desktop 2.0.13 + DSH 0.1.5-rc.2。当前只发布 Windows x64 桌面插件，macOS 暂缓。

1. 从[官网安装页](https://openx.huawei.com/project/7665/AICO-Plugin-Web_master/install.html)下载 Harness 与 PPT，核对大小和 SHA-256。
2. 在原装 Desktop 托盘打开 DSH Terminal，使用实际下载目录依次执行：

```powershell
dsh plugin add "C:\Downloads\aico-harness-beta0.1-win32-x64.tgz" --ignore-scripts
dsh plugin add "C:\Downloads\aico-ppt-skill-beta0.1-win32-x64.tgz" --ignore-scripts
```

3. 保存工作并重启，在原装模型页配置模型，从侧边栏打开 AICO-PPT。

PPT 包内版本为 `0.1.26`。完整包包含私有 Windows Python、浏览器及运行依赖，不需要另装资源包，不要求 Agent CLI、PTY 或旧宿主的专用渲染接口。手动 Beta 已公开发布；签名自动安装渠道及最终包两种模型连接联合验收仍未完成。

业务、文件和工具始终留在 Windows；WSL 只提供可选模型通信。升级、卸载均使用原装插件机制，先保存工作；`dsh plugin remove aico-ppt-skill` 移除插件后重启，保留 Deck 与业务数据。不能整目录删除 `.aico-ppt-editor` 或旧 `.huawei-deck-editor`，其中包含工作副本与恢复历史。

插件诊断日志位于运行用户的 `~/.aico/diagnostics/ppt-editor-*.jsonl`，按大小轮转，只记白名单连接状态。反馈故障时保留时间和对应日志；浏览器断线时可能无法上报，不能仅凭没有日志认定没有重连。

当前运行时与工具接口见[DSH 接入](integrations/dsh/README.md)，初次使用见[快速开始](docs/user-guide/quick-start.md)。

## 独立 Skill 安装（按需）

AICO-PPT 的产品定位是独立 Skill 与 AICO-Harness 编辑器插件：

- **Skill**：让 Codex、Claude Code 等 Agent 能发现 AICO-PPT 的工作流；
- **AICO-Harness Plugin**：桌面可视化编辑入口位于原装 DSH Desktop 中的 AICO 工作台，提供左侧原生对话与右侧 Editor。

只想在 Codex、Claude Code 等 Agent 中直接使用制作能力时，可以按本节注册独立 Skill。Skill 不依赖 AICO-Harness，可独立使用；默认安装不检查或修复本机 Agent PTY。需要可视化编辑时仍从原装 DSH Desktop 的 AICO-PPT 入口进入。开发者的网页联调、源码安装和独立 Dev Shell 见[开发调试](#开发调试)。

插件与独立 Skill 共用同一份 `SKILL.md`，编辑路径复用 Editor Core 和 Managed Workspace。AICO-Harness 插件不要求本机 Codex / Claude Code / OpenCode CLI，也不会加载 `node-pty`；独立 Skill 的导出和材料解析能力按任务准备；应用内插件由 AICO 安装流程准备相应私有能力。

### 准备仓库

独立 Skill 从完整的 AICO-PPT 仓库注册 Developer Link，无需同时获取 Harness 源码。

基础要求：

- Python 3.9 或更高版本；
- 使用 Editor Core 的制作与编辑工具需要 Node.js 18+；
- 只有独立 Dev Shell 才要求至少安装并登录 Codex、Claude Code 或 OpenCode 中的一个。

### macOS / Linux 安装独立 Skill

在仓库根目录运行：

```bash
python3 scripts/install.py install
```

默认行为：

1. 把当前仓库注册到 `~/.agents/skills/aico-ppt`；
2. 不检查或安装 AICO-Harness、Agent CLI、PTY 或 xterm；
3. 制作时按任务准备 `editor-core`、`verify`、`pptx-export`、`pptx-read` 或 `materials` 依赖。

安装后新开 Agent 任务使用 `aico-ppt`。制作、修改与验证可独立完成，无需启动 AICO-Harness 或 Dev Shell。需要可视化微调时，从 AICO-Harness 的 AICO-PPT 插件打开 Deck。

若机器上已有旧版注册，安装器会先创建并验证 `~/.agents/skills/aico-ppt`，写入新的安装记录后，才删除由旧安装记录明确拥有的注册。来源不明的同名目录或链接一律不会被覆盖或删除。旧项目 sidecar 与旧本机状态目录继续原位兼容读取，避免 Draft、工作副本或会话绑定失联。

### Windows 安装独立 Skill

在仓库根目录打开 PowerShell：

```powershell
py -3 scripts\install.py install
```

安装器会使用目录 junction 注册 Skill，不要求开启 Windows Developer Mode；默认只注册 Skill，不安装独立桌面入口或本机 Agent 终端。

如果系统没有 `py`，可改用：

```powershell
python scripts\install.py install
```

### 只安装 Skill

如果只在 Codex / Claude Code 中调用 Skill，或窗口化操作全部交给 DSH：

```bash
python3 scripts/install.py install --skill-only
```

Windows：

```powershell
py -3 scripts\install.py install --skill-only
```

### 兼容其他 Agent

默认只注册 Codex 当前使用的通用目录 `~/.agents/skills/aico-ppt`。

同时注册 Claude Code：

```bash
python3 scripts/install.py repair --hosts codex,claude-code
```

同时建立全部兼容链接：

```bash
python3 scripts/install.py repair --hosts all
```

对应位置：

| Host | 注册位置 |
|---|---|
| Codex | `~/.agents/skills/aico-ppt` |
| Claude Code | `~/.claude/skills/aico-ppt` |
| 旧版 Codex 兼容 | `~/.codex/skills/aico-ppt` |

### 独立 Skill 检查和修复

检查独立 Skill（维护者检查 Dev Shell 时显式加 `--dev-shell`）：

```bash
python3 scripts/install.py inspect
```

安全修复：

```bash
python3 scripts/install.py repair
```

查看将发生的文件变化：

```bash
python3 scripts/install.py repair --dry-run
```

给自动化读取：

```bash
python3 scripts/install.py inspect --json
```

如果注册目标已经存在且不指向当前仓库，安装器会返回 `INSTALL_TARGET_OCCUPIED` 并停止，不会覆盖原目录。请先确认旧目录来源，再手工移动或删除；不要对不明目录执行递归删除。

如果注册目标已经指向当前仓库，但没有本安装器的所有权记录，检查结果会显示 `adoption-required`，普通安装或修复会返回 `INSTALL_ADOPTION_REQUIRED`，不会静默接管。确认该链接确实应由 AICO-PPT 管理后运行：

```bash
python3 scripts/install.py repair --adopt-existing
```

Windows PowerShell 使用 `py -3 scripts\install.py repair --adopt-existing`。Editor 首页的“安装与诊断”也会显示“接管此安装”，并在写入所有权记录前要求明确确认。

### 独立 Skill 与源码开发：按任务准备能力

DSH Editor Core（不含本机 PTY 和 Agent CLI）：

```bash
python3 scripts/check_deps.py --profile editor-core --repair
```

独立 Dev Shell：

```bash
python3 scripts/check_deps.py --profile dev-shell --repair
```

截图、溢出和逐拍验证：

```bash
python3 scripts/check_deps.py --profile verify --repair
```

PPTX 导出：

```bash
python3 scripts/check_deps.py --profile pptx-export --repair
```

PPTX 参考内容读取只用标准库，无需修复第三方依赖：

```bash
python3 scripts/check_deps.py --profile pptx-read --check-only
python3 scripts/extract-pptx.py 参考.pptx 输出目录
```

输出 `slides.json`、`slides.md` 和 `media/`，供 AI 按页直接阅读文字、备注、表格和原始图片。工具不渲染 PPTX，也不转换 PDF；不支持的对象会标出限制，详见 [配图工作流](references/artwork.md#21-从-pptx-提取内容与原图)。

PDF 外部材料解析只需随包适配的 PDF Skill、PyMuPDF 与 pypdf；文字、表格、原图、渲染、批注和页面操作使用 PyMuPDF，pypdf 仅用于 AcroForm 填写：

```bash
python3 scripts/check_deps.py --profile materials --repair
```

Windows 把 `python3` 换成 `py -3`。Chrome 和 Node.js 需要用户按诊断提示手工安装；Agent CLI 只属于 `dev-shell` Profile。

### 卸载独立 Skill

```bash
python3 scripts/install.py uninstall
```

卸载只移除安装器登记、并且仍指向当前仓库的 Skill 注册。它不会删除：

- 当前仓库；
- 用户创建的 Deck；
- `.aico-ppt-editor` 中的工作副本和会话；
- Python、Node.js、Chrome 或 Agent CLI。

如果注册目标在安装后被改到别处，卸载会返回 `UNINSTALL_TARGET_CHANGED` 并拒绝删除。

多 Host 卸载按事务执行；任一注册项删除失败时，安装器会恢复此前已经移除的链接和原安装记录，避免留下半卸载状态。

## 开发调试

以下仅供维护者开发、回归与故障排查，不作为普通用户的并列安装方式。底层 DSH Web 与 Editor Core 继续保留；当前桌面入口为原装 DSH Desktop 中的 AICO-PPT 插件。

### 当前原装宿主联调

使用固定原装 Desktop、当前 AICO-Harness 适配插件和 PPT 的 DSH 入口，在隔离的 Windows Profile／测试数据中检查真实 Editor 与会话流程。依赖与命令入口见[Harness 本地开发](../AICO-Harness-Plugin/docs/extension-design/local-development.md)和[DSH 集成](integrations/dsh/README.md)。不要用旧修改版 Harness 启动结果证明兼容原装宿主。

旧修改版 Harness 启动和配套源码安装流程已停止使用。以下独立 Dev Shell 只验证 Editor 自身，不代表桌面插件整机验收。

### 启动 PPT 独立 Dev Shell

本小节只启动原独立 Editor 与本机 Agent PTY，不会安装或打开正式 AICO 应用。

先运行 `python3 scripts/install.py install --dev-shell`（Windows：`py -3 scripts\install.py install --dev-shell`）准备调试依赖；默认安装只注册 Skill。

macOS：双击 `tools/dev-shell/AICO-PPT Dev Shell.app`，或：

```bash
python3 scripts/deck-editor.py --app
```

Windows：首次双击 `tools/dev-shell/AICO-PPT Dev Shell.cmd` 会生成带图标的 `AICO-PPT Dev Shell（Windows）.lnk`；之后可双击快捷方式，也可以把一份 deck HTML 拖到 `.cmd` 或快捷方式上。快捷方式保存当前机器的绝对路径，移动仓库后删除旧 `.lnk` 并重新运行 `.cmd` 即可重建。

命令行直接打开一份 Deck：

```bash
python3 scripts/deck-editor.py /absolute/path/to/deck.html
```

Windows：

```powershell
py -3 scripts\deck-editor.py C:\absolute\path\to\deck.html
```

### 维护者专用：Dev Shell 使用 WSL2 Codex

本小节仅用于维护者显式调试。先运行 `py -3 scripts\install.py install --dev-shell`；启动器位于 `tools/dev-shell/`，不用于普通 Skill 或 AICO-Harness 插件安装。

如果 Editor 在 Windows 启动，而 Codex CLI 只安装在 WSL2，可在
`%USERPROFILE%\.aico-ppt-editor\settings.json` 写入本机配置：

```json
{
  "codexRuntime": "wsl",
  "wslDistribution": "Ubuntu-26.04",
  "wslUser": "root"
}
```

先在对应 WSL 用户中完成一次登录并确认命令可用：

```powershell
wsl.exe -d Ubuntu-26.04 -u root --exec bash -lic "command -v codex"
wsl.exe -d Ubuntu-26.04 -u root --exec codex login status
```

Editor 会进入该发行版用户的登录 shell，继承其 `PATH`、代理等环境后启动 Codex，
并把 Windows 项目路径转换为 WSL 路径。会话继续从该 WSL 用户的 `~/.codex`
发现和恢复；配置只在
Windows 的 Codex provider 上生效，不改变 macOS、Linux、Claude Code 或 OpenCode。
启动器会在用户打开任务前预热 WSL；同一 Editor 进程会缓存该发行版 / 用户对应的
Codex、Node、HOME 与 Windows→WSL 路径映射。任务终端依次显示“WSL 准备 / Codex
启动 / 历史重绘”；恢复历史只在服务端无界面终端中解析，真实输入态成立后才把最终
终端画面一次性投影到浏览器，避免长会话逐块重绘。
修改配置或更新 Editor 代码后，需要彻底退出旧 Editor 后台再重新双击启动。

## 常见问题

### Skill 安装后没有触发

先运行 `scripts/install.py inspect`，确认 Codex 注册状态为 `ready`，然后新开一个 Agent 任务。已有任务不会总是自动重新扫描 Skill。

### Editor 能打开，但验证或导出不可用

桌面插件用户先查看插件内“安装与诊断”，核对完整 Windows 包自带的私有 Python／浏览器资源；缺失时检查包的完整性并通过原装支持的插件流程修复，不在宿主目录运行 npm／pip。旧 `desktopRenderer: 1` 不属于当前原装交付前提。独立 Skill 或源码开发者按本机依赖检查结果修复 `verify`、`pptx-export` 等能力。

### 开发调试：macOS 已安装 Python 包，Editor 却显示未就绪

本仓库最新版 `tools/dev-shell/AICO-PPT Dev Shell.app` 会在 Apple Silicon 上显式使用 arm64，避免 Rosetta Python 无法载入 arm64 扩展。更新后请彻底退出旧工作台并重新双击；“安装与诊断”会把真正的架构冲突显示为“已安装但架构不兼容”，不会再笼统写成缺少。

PPTX 读取不依赖 LibreOffice 或 PDF 库；`pptx-read` 若提示提取工具缺失，应恢复完整 Skill 文件，桌面版通过 AICO 安装入口检查并修复 AICO-PPT。

### 开发调试：macOS 阻止打开 Dev Shell `.app`

当前仓库入口属于开发版本，尚未作为签名安装包发布。内部使用时应由管理员确认仓库来源；正式外部分发需要完成签名和 notarization。

### 开发调试：Windows Dev Shell 窗口一闪而过

在 PowerShell 中运行 `py -3 scripts\install.py inspect` 查看结构化错误。若找不到 Python，请先安装 Python 3 并启用 `py` launcher。

### 开发调试：Windows 已配置 WSL Codex，但 Editor 仍无法启动 Agent

运行 `py -3 scripts\check_deps.py --profile dev-shell --check-only`。诊断结果应显示
`Codex: WSL <发行版>/<用户> · <版本>`。如果提示发行版、用户或 Codex 不可用，请先用
上面的 `wsl.exe` 命令核对名称、登录状态和登录 `PATH`；不要在 Windows 侧复制
`/root/.codex` 或登录凭据。

如果 Codex 能打开但请求模型时提示 DNS、证书或连接失败，确认代理配置在登录 shell
中生效，而不只是某个已经打开的终端会话中生效：

```powershell
wsl.exe -d Ubuntu-26.04 -u root --exec bash -lic "curl -I --max-time 12 https://chatgpt.com"
```



## 发布后仍需完成的工作

- 同一最终包在干净 Windows 环境的安装、升级、卸载、本机/WSL 模型连接及完整制作导出验收。
- 生产签名渠道、代码签名与完整离线首次安装支持需分别核验；macOS 签名和 notarization 随 macOS 产品线暂缓。
- 教程的版本化录制、字幕/文本 fallback、过期检查及可选离线媒体仍需持续维护；已有官网实操视频不等于所有安装/核心任务教程齐全。
- 安装与修复成功率、冷启动、首次可用时间及编辑耗时预算需实测，不将设计目标表述为实测结果。

已完成的旧安装提案和实施计划已删除，当前的独立 Skill 注册、原装桌面插件安装和开发调试分别按本文件对应章节执行。
