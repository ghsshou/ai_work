#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""依赖体检 doctor —— 按任务 Profile 检查和修复 AICO-PPT 依赖。

覆盖：
  · PDF 材料：PyMuPDF 负责读取/表格/抽图/页面操作，pypdf 仅用于保留字体填写 AcroForm
  · 本 skill 运行时：Node ^18.19 或 ≥20.6、标准库 PPTX 打包/提取；桌面渲染服务或独立 Chrome
  · Editor Core：ws、html2canvas、busboy、three
  · 独立 Dev Shell：node-pty、@xterm/xterm、@xterm/headless、@xterm/addon-serialize、Agent CLI

Profile：
  editor-core  启动 DSH Editor Runtime 所需的 Node 与前端模块
  dev-shell    独立开发/调试壳所需的 Editor Core、PTY、xterm 和 Agent CLI
  verify       浏览器截图、溢出检查和逐拍验证
  pptx-export  HTML → PPTX 导出
  pptx-read    PPTX 逐页内容与内嵌原图提取（仅标准库）
  materials    PDF 外部材料读取与处理
  full         上述全部能力（兼容旧版默认行为）

行为（默认）：为兼容旧命令，仍检查并修复 full；新文档应显式传 --profile。
  --check-only  只体检并报告，不改动环境
  --repair      修复所选 Profile 中可自动安装的缺失项
  --json        输出供 Editor / 自动化读取的稳定 JSON

退出码契约（与 verify 三件套一致）：0 全部就绪 / 1 仍有缺失（含手动依赖或自动安装失败）/ 2 工具或参数错误。

用法：
  python3 scripts/check_deps.py --profile editor-core --check-only
  python3 scripts/check_deps.py --profile dev-shell --repair
  python3 scripts/check_deps.py --profile full --check-only --json
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from editor.product_paths import resolve_user_state_root
except ModuleNotFoundError:  # importlib 测试从仓库根加载脚本
    from scripts.editor.product_paths import resolve_user_state_root

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

REPO = Path(__file__).resolve().parent.parent
OPENCLAW_PW = "/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core/index.js"

# 输出小工具（TTY 上色，非 TTY 纯文本）
_C = sys.stdout.isatty()
def _c(s, code): return f"\033[{code}m{s}\033[0m" if _C else s
def ok(s):   return _c(s, "32")   # 绿
def bad(s):  return _c(s, "31")   # 红
def warn(s): return _c(s, "33")   # 黄
def dim(s):  return _c(s, "2")

def _symbol(value, fallback):
    encoding = sys.stdout.encoding or "utf-8"
    try:
        value.encode(encoding, errors="strict")
        return value
    except (LookupError, UnicodeEncodeError):
        return fallback

OK_SYMBOL = _symbol("✓", "+")
BAD_SYMBOL = _symbol("✗", "x")
WARN_SYMBOL = _symbol("⚠", "!")
INSTALL_SYMBOL = _symbol("⬇", "v")


def run(cmd, **kw):
    """跑命令，返回 CompletedProcess；找不到可执行文件时返回 rc=127。"""
    environment = kw.get("env")
    node = (os.environ if environment is None else environment).get("AICO_NODE_EXECUTABLE")
    if cmd and cmd[0] == "node" and node is not None:
        if not Path(node).is_absolute() or not Path(node).is_file():
            return subprocess.CompletedProcess(cmd, 127, "", "插件 Node 可执行文件无效")
        cmd = [node, *cmd[1:]]
    try:
        return subprocess.run(cmd, **kw)
    except FileNotFoundError:
        cp = subprocess.CompletedProcess(cmd, 127, "", "")
        return cp


def load_agent_runtime_settings(environment=None):
    """读取 Editor 本机配置；doctor 与启动器必须使用同一契约。"""
    environment = os.environ if environment is None else environment
    settings_path = resolve_user_state_root(environment) / "settings.json"
    if not settings_path.is_file():
        return {"codexRuntime": "native"}
    try:
        value = json.loads(settings_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"无法读取本机 Agent 配置 {settings_path}：{error}") from error
    if not isinstance(value, dict):
        raise ValueError("本机 Agent 配置必须是 JSON 对象")
    runtime = value.get("codexRuntime", "native")
    if runtime not in ("native", "wsl"):
        raise ValueError("codexRuntime 只支持 native 或 wsl")
    if runtime == "native":
        return {"codexRuntime": "native"}
    distribution = value.get("wslDistribution")
    user = value.get("wslUser")
    if (
        not isinstance(distribution, str)
        or not distribution.strip()
        or len(distribution) > 128
        or any(ord(char) < 32 or ord(char) == 127 for char in distribution)
    ):
        raise ValueError("WSL 发行版名称无效")
    if not isinstance(user, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,63}", user):
        raise ValueError("WSL 用户名无效")
    return {
        "codexRuntime": "wsl",
        "wslDistribution": distribution,
        "wslUser": user,
    }


# ---- 各依赖的探测函数：返回 (present: bool, detail: str) ----

def probe_pymod(mod):
    def _p():
        cp = run([sys.executable, "-c", f"import {mod}"],
                 capture_output=True, text=True)
        if cp.returncode == 0:
            return True, f"import {mod}"
        output = (cp.stderr or cp.stdout or "").strip()
        architecture = re.search(
            r"incompatible architecture \(have ['\"]([^'\"]+)['\"], need ['\"]([^'\"]+)['\"]\)",
            output,
        )
        if architecture:
            return False, (
                "已安装但架构不兼容"
                f"（扩展 {architecture.group(1)}，Editor Python {architecture.group(2)}）"
            )
        last_line = output.splitlines()[-1] if output else "未知导入错误"
        if "ModuleNotFoundError" in output:
            return False, f"当前 Python 未安装（{sys.executable}）"
        return False, f"已安装但导入失败：{last_line[:500]}"
    return _p

def probe_node_module(mod):
    cp = run(["node", "-e", f"require.resolve({mod!r})"],
             cwd=str(REPO), capture_output=True, text=True)
    return cp.returncode == 0, f"require.resolve('{mod}')"

def probe_nodemod(mod):
    return lambda: probe_node_module(mod)

def probe_three_browser_files():
    """检查 Editor 实际加载的浏览器文件，兼容不带 CommonJS 入口的精简包。"""
    files = ("three.module.min.js", "three.core.min.js")
    script = "import {fileURLToPath} from 'node:url'; import {dirname} from 'node:path'; console.log(dirname(fileURLToPath(import.meta.resolve('three'))))"
    result = run(["node", "--input-type=module", "-e", script],
                 cwd=str(REPO), capture_output=True, text=True)
    if result.returncode != 0:
        return False, "无法按 Node 包解析规则定位 Three.js"
    build = Path(result.stdout.strip())
    missing = [name for name in files if not (build / name).is_file()]
    if missing:
        return False, "缺少 Three.js 浏览器文件：" + "、".join(missing)
    return True, "Node 包解析定位浏览器文件：" + "、".join(files)

def probe_node_pty():
    """不仅检查模块存在，还真实创建一次 PTY，捕获 macOS spawn-helper 权限问题。"""
    script = r"""
const pty = require('node-pty');
const windows = process.platform === 'win32';
const file = windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/echo';
const args = windows ? ['/d', '/s', '/c', 'echo pty-ready'] : ['pty-ready'];
let output = '';
let child;
try {
  child = pty.spawn(file, args, {
    name:'xterm-256color', cols:80, rows:24, cwd:process.cwd(), env:process.env,
  });
} catch (error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}
const timeout = setTimeout(() => {
  try { child.kill(); } catch {}
  console.error('PTY 启动超时');
  process.exit(1);
}, 3000);
child.onData(data => { output += data; });
child.onExit(({ exitCode }) => {
  clearTimeout(timeout);
  if (exitCode === 0 && output.includes('pty-ready')) process.exit(0);
  console.error(`PTY 输出或退出码异常：${exitCode} ${JSON.stringify(output)}`);
  process.exit(1);
});
"""
    cp = run(["node", "-e", script], cwd=str(REPO), capture_output=True, text=True)
    detail = (cp.stderr or cp.stdout or "真实 PTY 可启动").strip()
    return cp.returncode == 0, detail

def probe_node():
    cp = run(["node", "--version"], capture_output=True, text=True)
    if cp.returncode != 0:
        return False, "未安装 node"
    v = (cp.stdout or "").strip()
    try:
        version = tuple(int(part) for part in v.lstrip("v").split(".")[:2])
    except ValueError:
        return False, f"无法解析版本 {v!r}"
    return (18, 19) <= version < (19, 0) or version >= (20, 6), f"{v}（需 ^18.19 或 ≥20.6）"

def probe_playwright():
    # 三级查找，与 scripts/verify/*.mjs 口径一致
    env = os.environ.get("PLAYWRIGHT_CORE")
    if env and Path(env).is_file():
        return True, f"PLAYWRIGHT_CORE={env}"
    cp = run(["node", "-e", "require.resolve('playwright-core')"],
             cwd=str(REPO), capture_output=True, text=True)
    if cp.returncode == 0:
        return True, "require.resolve('playwright-core')"
    if Path(OPENCLAW_PW).is_file():
        return True, "openclaw 内置"
    return False, "三级查找均未命中"

def probe_chrome():
    bundled = os.environ.get("AICO_BROWSER_EXECUTABLE")
    if os.environ.get("AICO_RUNTIME_KIND") == "plugin" and bundled is None:
        return False, "插件渲染缺少私有浏览器路径，请修复 PPT 资源安装"
    if bundled is not None:
        return Path(bundled).is_file(), f"AICO 内置浏览器：{bundled}"
    if sys.platform == "darwin":
        for p in ("/Applications/Google Chrome.app",
                  str(Path.home() / "Applications/Google Chrome.app")):
            if Path(p).exists():
                return True, p
    if sys.platform == "win32":
        roots = [
            os.environ.get("PROGRAMFILES"),
            os.environ.get("PROGRAMFILES(X86)"),
            os.environ.get("LOCALAPPDATA"),
        ]
        for root in filter(None, roots):
            candidate = Path(root) / "Google" / "Chrome" / "Application" / "chrome.exe"
            if candidate.is_file():
                return True, str(candidate)
    for exe in ("google-chrome", "google-chrome-stable", "chromium", "chrome"):
        w = shutil.which(exe)
        if w:
            return True, w
    return False, "未找到 Google Chrome"

def probe_pptx_extractor():
    extractor = REPO / "scripts" / "extract-pptx.py"
    present = extractor.is_file()
    return present, "scripts/extract-pptx.py（仅 Python 标准库）" if present else "未找到 scripts/extract-pptx.py"

def probe_pptx_builder():
    base = REPO / "scripts" / "html2pptx"
    files = (
        *(base / name for name in (
            "build_pptx.py", "build_editable_pptx.py", "extract-editable.mjs", "editable-scene.mjs", "export-ready.mjs",
        )),
        *(base / "template" / name for name in ("slideMaster.xml", "slideLayout.xml", "theme.xml")),
    )
    missing = [str(path.relative_to(REPO)) for path in files if not path.is_file()]
    return not missing, "缺少 " + "、".join(missing) if missing else "图片与可编辑 PPTX 工具及 XML 模板"

def probe_desktop_renderer():
    """实际连接当前宿主并验证隔离页面；能力文件存在不等于服务可用。"""
    try:
        cp = run(["node", str(REPO / "scripts" / "verify" / "desktop-renderer.mjs"), "--check"], capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return False, "桌面渲染服务检查超时，请重启 AICO 桌面版"
    return cp.returncode == 0, (cp.stdout if cp.returncode == 0 else cp.stderr or "桌面渲染服务不可用").strip()


def _windows_cli_directories():
    """Windows GUI/远程启动时 PATH 可能缺少交互用户的 npm bin。"""
    values = []
    appdata = os.environ.get("APPDATA")
    localappdata = os.environ.get("LOCALAPPDATA")
    userprofile = os.environ.get("USERPROFILE")
    if appdata:
        values.append(Path(appdata) / "npm")
    if localappdata:
        values.append(Path(localappdata) / "Microsoft" / "WinGet" / "Links")
    if userprofile:
        profile = Path(userprofile)
        values.extend((profile / "AppData" / "Roaming" / "npm", profile / ".local" / "bin"))
    system_drive = os.environ.get("SystemDrive", "C:")
    profiles = Path(f"{system_drive}\\Users")
    try:
        for profile in list(profiles.iterdir())[:256]:
            if profile.is_dir():
                values.extend((
                    profile / "AppData" / "Roaming" / "npm",
                    profile / "AppData" / "Local" / "Microsoft" / "WinGet" / "Links",
                    profile / ".local" / "bin",
                ))
    except OSError:
        pass
    unique = []
    seen = set()
    for value in values:
        key = str(value).casefold()
        if key not in seen:
            seen.add(key)
            unique.append(value)
    return unique


def probe_agent_cli():
    try:
        runtime = load_agent_runtime_settings()
    except ValueError as error:
        return False, str(error)

    wsl_failure = None
    found = []
    if sys.platform == "win32" and runtime["codexRuntime"] == "wsl":
        target = f'{runtime["wslDistribution"]}/{runtime["wslUser"]}'
        prefix = [
            "wsl.exe", "-d", runtime["wslDistribution"],
            "-u", runtime["wslUser"],
        ]
        try:
            located = run(
                [*prefix, "--exec", "bash", "-lic", "command -v codex"],
                capture_output=True, text=True, timeout=10,
            )
        except subprocess.TimeoutExpired:
            located = subprocess.CompletedProcess(prefix, 124, "", "WSL 环境检查超时")
        codex_path = next((
            line.strip() for line in reversed((located.stdout or "").splitlines())
            if line.strip().startswith("/")
        ), None)
        if located.returncode != 0 or not codex_path:
            reason = (located.stderr or located.stdout or "登录环境中找不到 codex").strip()
            wsl_failure = f"Codex WSL {target} 不可用：{reason}"
        else:
            try:
                version = run(
                    [*prefix, "--exec", codex_path, "--version"],
                    capture_output=True, text=True, timeout=10,
                )
            except subprocess.TimeoutExpired:
                version = subprocess.CompletedProcess(prefix, 124, "", "codex --version 超时")
            if version.returncode != 0:
                reason = (version.stderr or version.stdout or "codex --version 失败").strip()
                wsl_failure = f"Codex WSL {target} 不可用：{reason}"
            else:
                detail = (version.stdout or codex_path).strip().splitlines()[-1]
                found.append(f"Codex: WSL {target} · {detail}")

    if sys.platform == "win32":
        candidates = []
        if runtime["codexRuntime"] == "native":
            candidates.append(("Codex", ("codex.exe", "codex.cmd", "codex")))
        candidates.extend((
            ("Claude Code", ("claude.exe", "claude.cmd", "claude")),
            ("OpenCode", ("opencode.exe", "opencode.cmd", "opencode")),
        ))
    else:
        candidates = (
            ("Codex", ("codex",)),
            ("Claude Code", ("claude",)),
            ("OpenCode", ("opencode",)),
        )
    for label, names in candidates:
        executable = next((shutil.which(name) for name in names if shutil.which(name)), None)
        if not executable and sys.platform == "win32":
            executable = next((
                str(directory / name)
                for directory in _windows_cli_directories()
                for name in names
                if (directory / name).is_file()
            ), None)
        if executable:
            found.append(f"{label}: {executable}")
    if wsl_failure:
        suffix = f"；另已找到：{'；'.join(found)}" if found else ""
        return False, wsl_failure + suffix
    return (bool(found), "；".join(found) if found else "未找到 Codex、Claude Code 或 OpenCode")

def probe_which(name):
    def _p():
        w = shutil.which(name)
        return (w is not None), (w or f"未找到 {name}")
    return _p


# ---- 依赖清单 ----
# install: 可自动安装时给命令（list）；否则 None
# hint:    手动安装提示
# optional: True 时缺失不计入失败退出码
def pip(*pkgs):
    return [sys.executable, "-m", "pip", "install", *pkgs]

CHECKS = [
    dict(key="pypdf", label="pypdf", why="AcroForm 表单填写：保留原有字体与交互",
         probe=probe_pymod("pypdf"), install=pip("pypdf")),
    dict(key="node", label="Node.js", why="verify 三件套 / html2pptx",
         probe=probe_node, install=None,
         hint="安装 Node ^18.19 或 ≥20.6（nodejs.org 或 brew install node）"),
    dict(key="ws", label="ws", why="可视化编辑器 WebSocket 协作桥",
         probe=probe_nodemod("ws"), install=["npm", "i", "ws@8.21.1"], install_cwd=str(REPO)),
    dict(key="html2canvas", label="html2canvas", why="区域标记局部截图",
         probe=probe_nodemod("html2canvas"), install=["npm", "i", "html2canvas@1.4.1"], install_cwd=str(REPO)),
    dict(key="busboy", label="busboy", why="可视化编辑器任务附件上传",
         probe=probe_nodemod("busboy"), install=["npm", "i", "busboy@1.6.0"], install_cwd=str(REPO)),
    dict(key="node-pty", label="node-pty", why="可视化编辑器真实 Agent 终端",
         probe=probe_node_pty, install=["npm", "i", "--no-save", "--save-exact", "node-pty@1.2.0-beta.15"],
         install_cwd=str(REPO)),
    dict(key="@xterm/xterm", label="@xterm/xterm", why="浏览器 ANSI 终端渲染与输入",
         probe=probe_nodemod("@xterm/xterm"), install=["npm", "i", "--no-save", "@xterm/xterm@5.5.0"], install_cwd=str(REPO)),
    dict(key="@xterm/headless", label="@xterm/headless", why="独立 Dev Shell 终端状态投影",
         probe=probe_nodemod("@xterm/headless"), install=["npm", "i", "--no-save", "@xterm/headless@5.5.0"], install_cwd=str(REPO)),
    dict(key="@xterm/addon-serialize", label="@xterm/addon-serialize", why="独立 Dev Shell 终端快照",
         probe=probe_nodemod("@xterm/addon-serialize"),
         install=["npm", "i", "--no-save", "@xterm/addon-serialize@0.13.0"], install_cwd=str(REPO)),
    dict(key="three", label="three", why="启动页红白流体交互背景",
         probe=probe_three_browser_files, install=["npm", "i", "three@0.185.1"], install_cwd=str(REPO)),
    dict(key="agent-cli", label="Agent CLI", why="可视化编辑器 Agent 终端",
         probe=probe_agent_cli, install=None,
         hint="安装并登录 Codex、Claude Code 或 OpenCode（任意一个即可）"),
    dict(key="playwright-core", label="playwright-core", why="截图 / 溢出检测 / 逐拍",
         probe=probe_playwright, install=["npm", "i", "playwright-core"],
         install_cwd=str(REPO),
         hint="在仓库根 npm i playwright-core，或设 PLAYWRIGHT_CORE 指向其 index.js"),
    dict(key="chrome", label="Google Chrome", why="playwright channel:chrome",
         probe=probe_chrome, install=None,
         hint="安装 Google Chrome（google.com/chrome）"),
    dict(key="desktop-renderer", label="桌面渲染服务", why="复用 AICO Electron 截图与验证",
         probe=probe_desktop_renderer, install=None, hint="启动或升级 AICO 桌面版，无需另装浏览器"),
    dict(key="pptx-builder", label="PPTX 打包工具", why="图片与可编辑 PPTX 组装（标准库）",
         probe=probe_pptx_builder, install=None, hint="恢复完整 AICO-PPT 文件或重新安装插件"),
    dict(key="pillow", label="Pillow", why="PPTX 中内嵌 HTML 附件的图标",
         probe=probe_pymod("PIL"), install=pip("pillow")),
    dict(key="pymupdf", label="pymupdf", why="PDF 文本/表格/原图/合并拆分/批注与渲染",
         probe=probe_pymod("pymupdf"), install=pip("pymupdf")),
    dict(key="pptx-extractor", label="PPTX 内容提取工具", why="按页提取标题、正文、备注、表格及内嵌原图",
         probe=probe_pptx_extractor, install=None,
         hint="恢复完整 AICO-PPT Skill 文件；桌面版请重新安装 AICO-PPT 插件，无需另装第三方依赖"),
]


PROFILE_ORDER = ("editor-core", "dev-shell", "verify", "pptx-export", "pptx-read", "materials")
PROFILE_LABELS = {
    "editor-core": "Editor Core",
    "dev-shell": "独立 Dev Shell",
    "verify": "质量验证",
    "pptx-export": "PPTX 导出",
    "pptx-read": "PPTX 内容读取",
    "materials": "PDF 材料解析",
    "full": "全部能力",
}
PROFILE_MEMBERS = {
    "editor-core": {
        "node", "ws", "html2canvas", "busboy", "three",
    },
    "dev-shell": {
        "node", "ws", "html2canvas", "busboy", "three", "node-pty",
        "@xterm/xterm", "@xterm/headless", "@xterm/addon-serialize", "agent-cli",
    },
    "verify": {"node", "playwright-core", "chrome", "desktop-renderer"},
    "pptx-export": {"node", "playwright-core", "chrome", "desktop-renderer", "pptx-builder", "pillow"},
    "pptx-read": {"pptx-extractor"},
    "materials": {
        "pymupdf", "pypdf",
    },
}

for _check in CHECKS:
    _check["profiles"] = tuple(
        profile for profile in PROFILE_ORDER
        if _check["key"] in PROFILE_MEMBERS[profile]
    )


def normalize_profiles(profile_names):
    """校验并规范化 Profile；full 展开为全部具体 Profile。"""
    requested = list(profile_names or ["full"])
    unknown = [name for name in requested if name not in PROFILE_LABELS]
    if unknown:
        raise ValueError("未知 Profile：" + "、".join(unknown))
    expanded = PROFILE_ORDER if "full" in requested else tuple(
        profile for profile in PROFILE_ORDER if profile in requested
    )
    return tuple(expanded)


def checks_for_profiles(profile_names):
    selected_profiles = normalize_profiles(profile_names)
    excluded = {"playwright-core", "chrome"} if os.environ.get("AICO_RUNTIME_KIND") == "desktop" else {"desktop-renderer"}
    selected = [
        check for check in CHECKS
        if check["key"] not in excluded and any(profile in check["profiles"] for profile in selected_profiles)
    ]
    return selected_profiles, selected


def dependency_snapshot(profile_names):
    """返回 Editor 与 CLI 共用的只读诊断快照。"""
    selected_profiles, selected_checks = checks_for_profiles(profile_names)
    results = []
    for check in selected_checks:
        present, detail = do_probe(check)
        if present:
            state = "ready"
        elif check.get("optional"):
            state = "optional-missing"
        elif check.get("install"):
            state = "repairable"
        else:
            state = "manual-action-required"
        results.append({
            "key": check["key"],
            "label": check["label"],
            "why": check["why"],
            "profiles": list(check["profiles"]),
            "optional": bool(check.get("optional")),
            "present": present,
            "state": state,
            "detail": detail,
            "remediation": {
                "kind": "automatic" if check.get("install") else "manual",
                "command": check.get("install"),
                "hint": check.get("hint", ""),
            } if not present else None,
        })
    profile_results = {}
    for profile in selected_profiles:
        members = [item for item in results if profile in item["profiles"]]
        missing = [item for item in members if not item["present"] and not item["optional"]]
        profile_results[profile] = {
            "id": profile,
            "label": PROFILE_LABELS[profile],
            "ready": not missing,
            "state": "ready" if not missing else (
                "repairable" if all(item["state"] == "repairable" for item in missing)
                else "manual-action-required"
            ),
            "missing": [item["key"] for item in missing],
        }
    return {
        "schemaVersion": 1,
        "repository": str(REPO),
        "requestedProfiles": list(selected_profiles),
        "ready": all(profile["ready"] for profile in profile_results.values()),
        "profiles": profile_results,
        "checks": results,
    }


def repair_dependencies(profile_names, *, capture_output=False):
    """修复可自动安装项并返回修复后的快照与动作记录。"""
    before = dependency_snapshot(profile_names)
    selected_by_key = {check["key"]: check for check in checks_for_profiles(profile_names)[1]}
    actions = []
    for item in before["checks"]:
        if item["present"]:
            continue
        check = selected_by_key[item["key"]]
        command = check.get("install")
        if not command:
            actions.append({
                "key": item["key"], "kind": "manual", "ok": False,
                "hint": check.get("hint", ""),
            })
            continue
        completed = run(
            command,
            cwd=check.get("install_cwd"),
            **({"capture_output": True, "text": True} if capture_output else {}),
        )
        present, detail = do_probe(check)
        actions.append({
            "key": item["key"], "kind": "automatic", "command": command,
            "returnCode": completed.returncode, "ok": completed.returncode == 0 and present,
            "detail": detail,
            **({
                "output": (completed.stderr or completed.stdout or "")[-1600:],
            } if capture_output and completed.returncode != 0 else {}),
        })
    after = dependency_snapshot(profile_names)
    after["actions"] = actions
    return after


def do_probe(chk):
    present, detail = chk["probe"]()
    return present, detail


def _print_snapshot(snapshot):
    print(dim(f"依赖体检 · {REPO}"))
    for item in snapshot["checks"]:
        tag = "（可选）" if item["optional"] else ""
        if item["present"]:
            print(f"  {ok(OK_SYMBOL)} {item['label']}{tag}  {dim(item['detail'])}")
        else:
            print(f"  {bad(BAD_SYMBOL)} {item['label']}{tag}  {dim(item['why'])} — {item['detail']}")


def main(argv=None):
    ap = argparse.ArgumentParser(description="aico-ppt 依赖体检")
    ap.add_argument("--profile", action="append", choices=tuple(PROFILE_LABELS),
                    help="要检查的能力 Profile；可重复传入，默认 full")
    ap.add_argument("--check-only", action="store_true",
                    help="只体检并报告，不安装任何东西")
    ap.add_argument("--repair", action="store_true",
                    help="修复所选 Profile 中可自动安装的缺失项")
    ap.add_argument("--json", action="store_true",
                    help="输出供 Editor / 自动化读取的 JSON")
    ap.add_argument("--list-profiles", action="store_true", help="列出 Profile 后退出")
    args = ap.parse_args(argv)
    if args.check_only and args.repair:
        ap.error("--check-only 与 --repair 不能同时使用")
    if args.list_profiles:
        if args.json:
            print(json.dumps({"profiles": PROFILE_LABELS}, ensure_ascii=False))
        else:
            for key, label in PROFILE_LABELS.items():
                print(f"{key:12} {label}")
        return 0

    profiles = args.profile or ["full"]
    # 不带新参数时保留旧版自动修复行为；显式 --profile 默认只检查，避免 UI
    # 或文档读操作意外安装软件。
    should_repair = args.repair or (not args.check_only and not args.profile)
    before = dependency_snapshot(profiles)
    snapshot = repair_dependencies(profiles, capture_output=args.json) if should_repair else before
    if args.json:
        print(json.dumps(snapshot, ensure_ascii=False, indent=2))
        return 0 if snapshot["ready"] else 1

    _print_snapshot(before)
    if before["ready"]:
        print(ok("\n所选能力已就绪。"))
        return 0

    print()
    if should_repair:
        action_by_key = {action["key"]: action for action in snapshot.get("actions", [])}
        for item in before["checks"]:
            if item["present"]:
                continue
            action = action_by_key.get(item["key"])
            if not action or action["kind"] == "manual":
                print(f"  {warn(WARN_SYMBOL)} {item['label']}：需手动安装 → {item['remediation']['hint']}")
            elif action["ok"]:
                print(f"  {ok(OK_SYMBOL)} {item['label']} 修复完成  {dim(action['detail'])}")
            else:
                print(f"  {bad(BAD_SYMBOL)} {item['label']} 修复后仍未就绪（rc={action['returnCode']}）")
    else:
        for item in before["checks"]:
            if item["present"]:
                continue
            remediation = item["remediation"]
            if remediation["kind"] == "automatic":
                print(f"  {warn(INSTALL_SYMBOL)} {item['label']}：可自动修复 → {dim(' '.join(remediation['command']))}")
            else:
                print(f"  {warn(WARN_SYMBOL)} {item['label']}：需手动安装 → {remediation['hint']}")

    missing = [
        item for item in snapshot["checks"]
        if not item["present"] and not item["optional"]
    ]
    optional = [
        item for item in snapshot["checks"]
        if not item["present"] and item["optional"]
    ]
    print()
    if missing:
        print(bad(f"所选能力仍有 {len(missing)} 项依赖缺失：")
              + " " + "、".join(item["label"] for item in missing))
        return 1
    if optional:
        print(warn("可选依赖缺失（不影响所选能力）：")
              + " " + "、".join(item["label"] for item in optional))
    print(ok("所选能力已就绪。"))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(2)
