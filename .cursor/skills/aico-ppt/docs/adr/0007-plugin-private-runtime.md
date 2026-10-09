---
status: accepted
---
# ADR-0007：插件私有运行时

原装 DSH Desktop 不提供旧修改版 Harness 的专用 Electron 渲染通道。PPT 因此使用完整包中的私有 Windows Python/浏览器，通过显式运行时描述和 Worker 隔离资源，不修改宿主、不向全局 PATH 注入插件依赖。

工具路径经 realpath 和普通文件检查，必须在资源根内；描述不携带凭据。Worker 与模型包装器使用同一运行时，Node 取宿主 process.execPath，缺失私有浏览器时明确拒绝而不静默借用系统安装。

Python 启动环境设置 PYTHONDONTWRITEBYTECODE=1，包装器加 -B，避免修改安装目录。卸载等待服务和 Worker 清理，业务数据保留；独立 Skill 继续使用自己的按需依赖。代价是发行包较大，需要独立更新和核验 Python/浏览器来源。

## 原装宿主的私有浏览器模式

原装 Desktop 的 `desktopActions` 仅公开终端打开与重启，没有旧 AICO Electron renderer 私有通道。原装插件模式因此允许资源描述声明 `paths.browser`；它与 Python 一起通过 realpath 和普通文件校验，位于同一资源根目录。适配插件的资源配置映射接受该角色，Worker 与模型脚本包装器共同使用 `AICO_RUNTIME_KIND=plugin` 和显式浏览器路径，移除旧 `AICO_HOME`。截图、验证、导出使用现有 Playwright 路径，不加载或改写宿主原生主进程。

当前原装模式必须使用明确的 Python/浏览器资源。省略 browser 的旧描述仍使用原来的桌面渲染通道，不能用于证明原装宿主具备导出能力。插件模式缺少显式浏览器路径时不回退本机 Chrome。`aico.release.json` 只声明 Windows 的 Python 和浏览器文件，不再要求 `desktopRenderer`；WSL 仅承担模型通信，不安装 PPT 业务运行时。beta0.1 已发布包含匹配 Windows Python/浏览器的完整包；后续版本仍须校验资源与最终包。

显式集成测试已在 Linux 与 Windows 用临时复制的浏览器／Python 执行真实两页图片导出，检查 PPTX ZIP 完整性、两页及两张图片，随后删除测试目录。Windows 文件占用仅有限重试，不吞掉清理失败。该测试父进程为 Node；不证明原装 Electron Utility Host 的脚本入口、导出 UI、WSL 切换或正式资源发行可用。

Worker 和包装器的独立环境显式记录当前 `process.execPath` 为 `AICO_NODE_EXECUTABLE`，过滤继承覆盖；Electron 中仅给子进程设置 `ELECTRON_RUN_AS_NODE=1`。Python 转换器与体检使用该绝对路径，路径无效时拒绝执行，不因宿主目录没有 node.exe 而错误回退系统 Node。Windows Electron 43.3.0 的 Node 模式已完成相同真实图片导出；原装 Utility Host 内完整 Worker/UI 验收仍独立进行。

原装 Windows Desktop 2.0.10-beta.1 / DSH 0.1.5-rc.2 的实际 Utility Host + 私有 Worker 联合检查已通过：编辑保留原始运行时的授课模板前两页、固化，再通过导出 UI 和真实原生保存窗口生成图片 PPTX。封面及目录四个标签按既有规则展开为五页；退出后验证 ZIP、五页和五张图片，卸载并重启后文件保留。此处的 Python／浏览器仍是本机安装目录的测试副本；可编辑 PPTX、正式资源、模型脚本首次启动和完整 WSL 切换仍须独立验证。

## 模型命令的首次启动

Skill provider 把当前 aicoRuntime 的根目录及工具路径编码到包装器参数，调用方不必在只读包目录创建描述文件。包装器校验显式描述；只有未提供参数才读取旧描述文件。Windows PowerShell 5 的原生命令引号规则要求 JSON 使用 base64url 传输，内容只包含路径；Electron 的 Node 模式仅在调用期间设置并恢复，管道保证等待 GUI 子系统的进程且保留输出，脚本块显式传回 LASTEXITCODE。POSIX shell 使用单命令环境。

Linux shell 与 Windows Node／Electron 实测覆盖无包内描述文件、中文及单引号路径、原工作目录、私有环境和非零退出码。显式无效描述的检查证明不会回退包内文件。该验证不调用真实模型，也不代表 Agent 的完整新建、导出和 WSL 任务已验收。
