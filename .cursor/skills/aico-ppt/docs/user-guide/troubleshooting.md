# 故障排查

正式用户从 AICO 独立应用使用插件商店安装的 PPT。以下先区分应用内插件问题与独立 Skill / 源码开发问题；普通用户无需启动 Harness 网页调试入口或 PPT Dev Shell。

## Skill 没有被 Agent 发现

运行：

```bash
python3 scripts/install.py inspect
```

确认 `codex` 注册状态为 `ready`，再新开一个 Agent 任务。如果显示 `occupied`，目标目录属于其他安装，安装器不会覆盖。如果显示 `adoption-required`，说明链接已经指向当前仓库，但还没有安装器所有权记录；请在首页“安装与诊断”中点击“接管此安装”并确认，或明确运行：

```bash
python3 scripts/install.py repair --adopt-existing
```

接管只登记这个已经核对为同源的链接，让后续修复和卸载能按所有权安全执行，不会改动仓库或用户 Deck。

## 应用内 PPT 无法启动

先在 AICO 的“设置 → 插件 → 插件商店”确认 AICO-PPT 已安装且激活，再查看插件的“安装与诊断”。私有 Python 或浏览器缺失时，从插件商店重试或重新安装；不在应用资源目录运行 npm/pip。对话、模型与登录由 AICO-Harness 提供。安装过程见[安装指南](../../INSTALL.md)。

### 独立 Skill / 源码开发：Editor Core 无法启动

以下本机依赖命令仅用于独立 Skill 和源码调试：

```bash
python3 scripts/check_deps.py --profile editor-core --check-only
python3 scripts/check_deps.py --profile editor-core --repair
```

源码 Editor 需要 Node.js 与 Editor Core 依赖。对话、模型与登录由 AICO-Harness 提供，无需另装本机 Agent CLI。独立 Skill 注册可以单独用 `python3 scripts/install.py inspect` 检查。

### 维护者 Dev Shell 使用 WSL Codex 时提示找不到 CLI

以下仅适用于 `tools/dev-shell/` 中的调试入口。

本机配置位于 `%USERPROFILE%\.aico-ppt-editor\settings.json`。确认其中的
`wslDistribution`、`wslUser` 与实际环境一致，再在 PowerShell 运行：

```powershell
wsl.exe -d Ubuntu-26.04 -u root --exec bash -lic "command -v codex"
wsl.exe -d Ubuntu-26.04 -u root --exec codex login status
py -3 scripts\check_deps.py --profile dev-shell --check-only
```

诊断应显示 `Codex: WSL <发行版>/<用户> · <版本>`。修改配置或更新 Editor 后要彻底
退出旧后台并重新双击入口；只关掉启动命令窗口不会替换已经运行的 Node 服务。
Codex 登录和会话继续保存在对应 WSL 用户的 `~/.codex`，无需复制到 Windows 用户目录。
若 CLI 能打开但模型请求提示 DNS、证书或连接失败，确认代理变量由该用户的登录 shell
加载；Editor 会通过 `bash -lic` 启动 Codex，以继承同一套代理环境。

## 验证或导出不可用

AICO 应用用户在插件内查看私有能力诊断，并通过插件商店修复安装。以下命令用于独立 Skill 与源码开发；Editor Core、质量验证和导出分别检查：

```bash
python3 scripts/check_deps.py --profile verify --check-only
python3 scripts/check_deps.py --profile pptx-export --check-only
```

PPTX 内容读取只用标准库和随包提取工具，PDF 工具缺失不影响读取 PPTX。

### 开发调试：macOS 显示 Python 包“未就绪”，但终端可以导入

Apple Silicon 上必须通过最新版 `tools/dev-shell/AICO-PPT Dev Shell.app` 启动。入口会显式使用 arm64，避免 LaunchServices 把脚本型 App 放进 Rosetta 进程树，导致 arm64 的 `PyMuPDF` 或 `Pillow` 原生扩展被误判为不可用。更新入口后请彻底退出旧工作台再重新双击；诊断若仍发现架构冲突，会明确显示“已安装但架构不兼容”。

### 读取参考 PPTX

独立 Skill 可运行 `python3 scripts/extract-pptx.py 参考.pptx 输出目录`。AI 直接读取输出的 `slides.md` / `slides.json` 与 `media/` 原图；标题、正文、备注、表格和图片都按页关联。图表、SmartArt 等未提取对象会逐页标出限制，不生成版式预览，也不需要安装 Office。

若 `pptx-read` 诊断报告工具缺失，恢复完整 Skill 文件；桌面版从插件商店重新安装 AICO-PPT。PDF 材料继续单独使用 `materials` Profile。

## 任务显示“待确认”

这表示 Agent 找到多个可能目标。打开任务的“补充说明”，写清页码、栏目、原文字或相对位置，再重新提交。

## 修改无法固化

常见稳定错误：

- `DECK_CHANGED`：源文件在 Editor 外被修改；
- `NEW_OVERFLOW`：修改产生了新的页面溢出；
- `EDITOR_OFFLINE`：受控浏览器 frame 未连接；
- `RECOVERY_REQUIRED`：工作副本需要先恢复；
- `MISSING_PAGE_TARGETS`：结构修改删除了仍被动作引用的页面。

不要绕过固化直接覆盖真实 Deck。保留工作副本，按错误提示重新加载、处理冲突或另存副本。

## 获取结构化诊断

AICO 应用用户使用插件内的“安装与诊断”。独立 Skill 与源码开发可运行：

```bash
python3 scripts/install.py inspect --json
python3 scripts/check_deps.py --profile full --check-only --json
```

分享日志前删除用户名、绝对项目路径、令牌和 Agent 对话内容。
