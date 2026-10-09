#!/usr/bin/env python3
"""AICO-PPT 可视化编辑器的统一启动入口。

命令行与桌面应用都只经过这里：传入 deck 路径时直接打开编辑器；没有路径时
先打开一次性导入页，由用户在网页中点击后再唤起系统文件选择器。
"""

from pathlib import Path
import argparse
import base64
import importlib.util
import json
import os
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime

try:
    from editor.product_paths import resolve_user_state_root
except ModuleNotFoundError:  # importlib 测试从仓库根加载脚本
    from scripts.editor.product_paths import resolve_user_state_root


ROOT = Path(__file__).resolve().parent.parent
# Windows 映射盘（包括 Parallels 共享盘）必须保留原始盘符作为子进程 cwd；
# ROOT 仍用于可信资源定位，不能因此放弃 realpath 语义。
LAUNCH_ROOT = Path(__file__).absolute().parent.parent
EDITOR_NODE_MODULES = (
    "ws", "html2canvas", "busboy", "three", "node-pty", "@xterm/xterm",
    "@xterm/headless", "@xterm/addon-serialize",
)
AGENT_PROVIDERS = ("codex", "claude-code", "opencode")
AGENT_COMMANDS = {
    "codex": "codex",
    "claude-code": "claude",
    "opencode": "opencode",
}
APP_INSTANCE_FILE = (
    Path(tempfile.gettempdir()) / "aico-ppt-editor" / "app-instance.json"
)
WINDOWS_CREATE_NO_WINDOW = 0x08000000
WINDOWS_CREATE_NEW_PROCESS_GROUP = 0x00000200


class LauncherError(RuntimeError):
    """可安全展示给用户的启动错误。"""


def _normalize_agent_runtime_settings(value):
    if value is None:
        return {"codexRuntime": "native"}
    if not isinstance(value, dict):
        raise LauncherError("本机 Agent 配置必须是 JSON 对象")
    runtime = value.get("codexRuntime", "native")
    if runtime not in ("native", "wsl"):
        raise LauncherError("codexRuntime 只支持 native 或 wsl")
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
        raise LauncherError("WSL 发行版名称无效")
    if not isinstance(user, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,63}", user):
        raise LauncherError("WSL 用户名无效")
    return {
        "codexRuntime": "wsl",
        "wslDistribution": distribution,
        "wslUser": user,
    }


def load_agent_runtime_settings(environment=None):
    """读取不随仓库提交的 Editor 本机 Agent runtime 配置。"""
    environment = os.environ if environment is None else environment
    settings_path = resolve_user_state_root(environment) / "settings.json"
    if not settings_path.is_file():
        return {"codexRuntime": "native"}
    try:
        value = json.loads(settings_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise LauncherError(f"无法读取本机 Agent 配置 {settings_path}：{error}") from error
    return _normalize_agent_runtime_settings(value)


def _windows_agent_directories():
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
    profiles = Path(f"{os.environ.get('SystemDrive', 'C:')}\\Users")
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
    return list(dict.fromkeys(str(value) for value in values))


def _find_agent_command(command, platform=sys.platform):
    names = (
        (f"{command}.exe", f"{command}.cmd", command)
        if platform == "win32" else (command,)
    )
    found = next((shutil.which(name) for name in names if shutil.which(name)), None)
    if not found and platform == "win32":
        found = next((
            str(Path(directory) / name)
            for directory in _windows_agent_directories()
            for name in names
            if (Path(directory) / name).is_file()
        ), None)
    if found and sys.platform == "win32":
        # GUI/Parallels 启动器可能没有加载用户 PATH；后续 Node PTY
        # 仍通过固定命令名启动，因此把已验证的 bin 目录传给子进程。
        directory = str(Path(found).parent)
        current = os.environ.get("PATH", "")
        if directory.casefold() not in {item.casefold() for item in current.split(os.pathsep)}:
            os.environ["PATH"] = directory + (os.pathsep + current if current else "")
    return found


def resolve_agent_provider(
    provider="auto", platform=sys.platform, runtime_settings=None
):
    """把桌面默认值解析为本机实际安装的 Agent，不做静默跨 provider 回退。"""
    if provider != "auto":
        if provider not in AGENT_PROVIDERS:
            raise LauncherError("Agent provider 不受支持：" + str(provider))
        return provider
    settings = _normalize_agent_runtime_settings(
        load_agent_runtime_settings() if runtime_settings is None else runtime_settings
    )
    if platform == "win32" and settings["codexRuntime"] == "wsl":
        # 具体发行版、用户与 CLI 可用性由 doctor 和 Node runtime 在启动时复核。
        return "codex"
    for candidate in AGENT_PROVIDERS:
        command = AGENT_COMMANDS[candidate]
        if _find_agent_command(command, platform=platform):
            return candidate
    raise LauncherError(
        "找不到可用的 Agent CLI，请先安装并登录 Codex、Claude Code 或 OpenCode。"
    )


def build_command(
    deck,
    host="127.0.0.1",
    port=0,
    no_open=False,
    exit_when_editor_closes=False,
    agent_thread_id=None,
    agent_provider="codex",
    headless_workspace=False,
):
    cmd = [
        "node",
        str(ROOT / "scripts/editor/server.mjs"),
        str(Path(deck).resolve()),
        "--host",
        host,
        "--port",
        str(port),
        "--agent-provider",
        agent_provider,
        "--python",
        sys.executable,
    ]
    if agent_thread_id:
        cmd.extend(["--agent-thread-id", agent_thread_id])
    if no_open:
        cmd.append("--no-open")
    if headless_workspace:
        cmd.append("--headless-workspace")
    if exit_when_editor_closes:
        cmd.append("--exit-when-editor-closes")
    return cmd


def build_app_command(
    host="127.0.0.1", port=0, no_open=False, agent_provider="codex"
):
    """构造一次性网页导入入口；成功导入后由它接管编辑器生命周期。"""
    cmd = [
        "node",
        str(ROOT / "scripts/editor/app-server.mjs"),
        "--host",
        host,
        "--port",
        str(port),
        "--python",
        sys.executable,
        "--agent-provider",
        agent_provider,
    ]
    if no_open:
        cmd.append("--no-open")
    return cmd


def _run_applescript(source, *arguments):
    return subprocess.run(
        ["/usr/bin/osascript", "-", *map(str, arguments)],
        input=source,
        capture_output=True,
        text=True,
    )


def _choose_with_tk(dialog_name, **options):
    """打开一个有明确父窗口的 Tk 系统选择器。

    Windows 上隐藏的 Tk 根窗口若不是 topmost，原生对话框可能被
    浏览器压在后面，看起来就像“选择器一直没打开”。
    """
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    try:
        root.withdraw()
        if sys.platform == "win32":
            root.attributes("-topmost", True)
        root.update_idletasks()
        root.update()
        return getattr(filedialog, dialog_name)(parent=root, **options)
    finally:
        root.destroy()


def choose_deck():
    """用系统文件选择器选一份 HTML；用户取消时返回 None。"""
    if sys.platform == "darwin" and Path("/usr/bin/osascript").is_file():
        result = _run_applescript(
            """
            on run argv
              try
                set pickedFile to choose file with prompt (item 1 of argv) of type {"public.html"}
                return POSIX path of pickedFile
              on error number -128
                return ""
              end try
            end run
            """,
            "选择要继续修改的 AICO-PPT HTML",
        )
        if result.returncode != 0:
            raise LauncherError((result.stderr or "无法打开系统文件选择器").strip())
        selected = result.stdout.strip()
        return Path(selected) if selected else None

    try:
        selected = _choose_with_tk(
            "askopenfilename",
            title="选择要继续修改的 AICO-PPT HTML",
            filetypes=[("AICO-PPT HTML", "*.html *.htm"), ("所有文件", "*")],
        )
        return Path(selected) if selected else None
    except Exception as error:
        raise LauncherError("无法打开系统文件选择器，请改用命令行传入 deck 路径") from error


def choose_project_directory(default_path=None):
    """从当前配置目录打开系统目录选择器；用户取消时返回 None。"""
    if sys.platform == "darwin" and Path("/usr/bin/osascript").is_file():
        result = _run_applescript(
            """
            on run argv
              try
                if (count of argv) > 1 then
                  set pickedFolder to choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv))
                else
                  set pickedFolder to choose folder with prompt (item 1 of argv)
                end if
                return POSIX path of pickedFolder
              on error number -128
                return ""
              end try
            end run
            """,
            "选择 Agent 项目目录",
            *([default_path] if default_path else []),
        )
        if result.returncode != 0:
            raise LauncherError((result.stderr or "无法打开系统目录选择器").strip())
        selected = result.stdout.strip()
        return Path(selected) if selected else None

    try:
        selected = _choose_with_tk(
            "askdirectory",
            title="选择 Agent 项目目录",
            mustexist=True,
            **({"initialdir": default_path} if default_path else {}),
        )
        return Path(selected) if selected else None
    except Exception as error:
        raise LauncherError("无法打开系统目录选择器") from error


def choose_pptx_save(default_path):
    """选择 PPTX 保存位置，系统窗口负责覆盖确认。"""
    path = Path(default_path).expanduser().absolute()
    if sys.platform == "darwin" and Path("/usr/bin/osascript").is_file():
        result = _run_applescript(
            """
            on run argv
              try
                set pickedFile to choose file name with prompt "保存 PPTX" default name (item 1 of argv) default location (POSIX file (item 2 of argv))
                return POSIX path of pickedFile
              on error number -128
                return ""
              end try
            end run
            """,
            path.name, str(path.parent),
        )
        if result.returncode != 0:
            raise LauncherError((result.stderr or "无法打开保存窗口").strip())
        selected = result.stdout.strip()
    else:
        try:
            selected = _choose_with_tk(
                "asksaveasfilename", title="保存 PPTX", initialdir=str(path.parent),
                initialfile=path.name, defaultextension=".pptx",
                filetypes=[("PowerPoint", "*.pptx")], confirmoverwrite=True,
            )
        except Exception as error:
            raise LauncherError("无法打开 PPTX 保存窗口") from error
    return Path(selected) if selected else None


def show_native_error(message):
    """桌面模式用原生对话框报告错误；失败时退回 stderr。"""
    detail = str(message).strip() or "未知错误"
    if sys.platform == "darwin" and Path("/usr/bin/osascript").is_file():
        result = _run_applescript(
            """
            on run argv
              display alert (item 1 of argv) message (item 2 of argv) as critical buttons {"好"} default button "好"
            end run
            """,
            "AICO-PPT 编辑器无法启动",
            detail,
        )
        if result.returncode == 0:
            return
    elif sys.platform == "win32":
        try:
            import ctypes

            ctypes.windll.user32.MessageBoxW(
                0, detail, "AICO-PPT 编辑器无法启动", 0x10
            )
            return
        except Exception:
            pass
    print(f"AICO-PPT 编辑器无法启动：{detail}", file=sys.stderr)


def _load_check_deps():
    path = ROOT / "scripts/check_deps.py"
    spec = importlib.util.spec_from_file_location("aico_ppt_check_deps", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def editor_dependency_status():
    """返回独立 Dev Shell 的 (是否就绪, 说明)。"""
    doctor = _load_check_deps()
    snapshot = doctor.dependency_snapshot(["dev-shell"])
    launcher_keys = {"node", *EDITOR_NODE_MODULES}
    missing = [item for item in snapshot["checks"]
               if item["key"] in launcher_keys and not item["present"]]
    if missing:
        detail = "；".join(f"{item['label']}：{item['detail']}" for item in missing)
        return False, detail
    node = next(item for item in snapshot["checks"] if item["key"] == "node")
    return True, node["detail"]


def prepare_editor_runtime(auto_install=False):
    """桌面模式通过统一 Environment Profile 补齐独立 Dev Shell。"""
    ready, detail = editor_dependency_status()
    if ready:
        return
    if "Node.js" in detail:
        raise LauncherError(detail + "。请先安装 Node.js 18.19 系列或 20.6 及以上版本。")
    if not auto_install:
        raise LauncherError(
            detail + "。请运行 python3 scripts/check_deps.py --profile dev-shell --repair。"
        )
    doctor = _load_check_deps()
    result = doctor.repair_dependencies(["dev-shell"], capture_output=True)
    ready, after_detail = editor_dependency_status()
    if not ready:
        failed = [action for action in result.get("actions", [])
                  if action.get("kind") == "automatic" and not action.get("ok")]
        output = "；".join(action.get("output") or action.get("detail", "")
                          for action in failed) or after_detail
        raise LauncherError("首次启动自动准备依赖失败：" + output[-1600:])


def normalize_argv(argv):
    """移除 Finder 可能附加的进程序列号参数。"""
    return [value for value in argv if not value.startswith("-psn_")]


def _windows_hidden_creation_flags(platform=sys.platform):
    """Windows GUI 路径统一隐藏子进程控制台；其他系统必须返回 0。"""
    if platform != "win32":
        return 0
    return (
        getattr(subprocess, "CREATE_NO_WINDOW", WINDOWS_CREATE_NO_WINDOW)
        | getattr(
            subprocess,
            "CREATE_NEW_PROCESS_GROUP",
            WINDOWS_CREATE_NEW_PROCESS_GROUP,
        )
    )


def _detach_windows_app(argv, executable=None):
    """让 .cmd 只做短生命周期分发，后台服务由无控制台 Python 接管。"""
    command = [
        executable or sys.executable,
        str(Path(__file__).resolve()),
        *(value for value in argv if value != "--detach-windows"),
    ]
    try:
        subprocess.Popen(
            command,
            cwd=LAUNCH_ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=_windows_hidden_creation_flags(platform="win32"),
            close_fds=True,
        )
    except OSError as error:
        show_native_error(f"AICO-PPT 编辑器后台启动失败：{error}")
        return 2
    return 0


def resolve_deck(path):
    deck = Path(path).expanduser().resolve()
    if deck.suffix.lower() not in {".html", ".htm"}:
        raise LauncherError(f"只支持 deck HTML 文件：{deck}")
    if not deck.is_file():
        raise LauncherError(f"找不到 deck 文件：{deck}")
    return deck


def _read_app_instance(instance_file):
    try:
        value = json.loads(Path(instance_file).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def _process_is_live(pid):
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def _trusted_local_app_url(value):
    if not isinstance(value, str) or len(value) > 4096:
        return None
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return None
    if parsed.scheme != "http" or parsed.hostname not in {
        "127.0.0.1", "localhost", "::1"
    }:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    if parsed.path not in {"/app/", "/editor/"} or not port:
        return None
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if not query.get("token", [""])[0]:
        return None
    return value


def _instance_is_live(instance):
    """同时核对 owner 进程和带随机令牌的 loopback 工作台。"""
    if not isinstance(instance, dict) or instance.get("version") != 1:
        return False
    if not _process_is_live(instance.get("pid")):
        return False
    app_url = _trusted_local_app_url(instance.get("appUrl"))
    if not app_url:
        return False
    try:
        # macOS 的 urllib 会自动继承“系统设置 → 网络 → 代理”。loopback 若也
        # 经过该代理，活着的工作台会因代理超时被误判为陈旧实例，继而重复启动。
        direct_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with direct_opener.open(app_url, timeout=1.0) as response:
            preview = response.read(8192).decode("utf-8", errors="replace")
            return response.status == 200 and "AICO-PPT" in preview
    except (OSError, ValueError):
        return False


def _write_owned_instance(instance_file, payload, owner_id):
    path = Path(instance_file)
    current = _read_app_instance(path)
    if current and current.get("ownerId") != owner_id:
        raise LauncherError("桌面工作台实例所有权已经变化，请重新打开")
    temporary = path.with_name(f".{path.name}.{owner_id}.tmp")
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    try:
        with temporary.open("x", encoding="utf-8") as output:
            os.chmod(temporary, 0o600)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _release_owned_instance(instance_file, owner_id):
    path = Path(instance_file)
    current = _read_app_instance(path)
    if not current or current.get("ownerId") != owner_id:
        return
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def _claim_app_instance(instance_file=APP_INSTANCE_FILE, wait_seconds=10.0):
    """原子认领桌面入口；已存在时返回其工作台，不再启动第二套服务。"""
    path = Path(instance_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    owner_id = str(uuid.uuid4())
    deadline = time.monotonic() + max(0.0, wait_seconds)
    while True:
        payload = {
            "version": 1,
            "ownerId": owner_id,
            "pid": os.getpid(),
            "appUrl": None,
            "startedAt": time.time(),
        }
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            existing = _read_app_instance(path)
            if existing and _instance_is_live(existing):
                return None, existing
            if (
                existing
                and _process_is_live(existing.get("pid"))
                and _process_is_live(existing.get("servicePid"))
            ):
                # 健康请求可能遇到一瞬间的事件循环繁忙；两个登记进程仍存活时
                # 宁可继续激活已有地址，也绝不能创建会争抢 Deck 锁的第二实例。
                return None, existing
            started_at = existing.get("startedAt") if existing else None
            recently_started = (
                isinstance(started_at, (int, float))
                and not isinstance(started_at, bool)
                and time.time() - started_at < max(30.0, wait_seconds * 2)
            )
            if (
                existing and recently_started
                and _process_is_live(existing.get("pid"))
            ):
                if time.monotonic() < deadline:
                    time.sleep(0.05)
                    continue
                # 首个入口仍在启动时绝不并行创建第二套服务。
                return None, existing
            try:
                path.unlink()
            except FileNotFoundError:
                pass
            continue
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(payload, output, ensure_ascii=False, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        return owner_id, payload


def _open_url(url):
    trusted = _trusted_local_app_url(url)
    if not trusted:
        raise LauncherError("已有桌面工作台地址无效")
    if sys.platform == "darwin":
        command = ["/usr/bin/open", trusted]
    elif sys.platform == "win32":
        command = ["rundll32.exe", "url.dll,FileProtocolHandler", trusted]
    else:
        command = ["xdg-open", trusted]
    opener = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=_windows_hidden_creation_flags(),
    )
    if sys.platform != "win32":
        # opener 本身不属于编辑器生命周期。
        opener.poll()


_MACOS_BROWSER_ACTIVATION_SCRIPT = r'''
on matchesWorkspaceTab(targetURL, candidateURL, candidateTitle, allowTitleFallback)
  if candidateURL is targetURL then return true
  if allowTitleFallback then
    if candidateTitle is "AICO-PPT" then return true
  end if
  return false
end matchesWorkspaceTab

on activateChromeWorkspace(targetURL, allowTitleFallback)
  if application id "com.google.Chrome" is not running then return false
  tell application id "com.google.Chrome"
    repeat with browserWindow in windows
      set tabTotal to count of tabs of browserWindow
      repeat with tabIndex from 1 to tabTotal
        set browserTab to tab tabIndex of browserWindow
        set candidateURL to URL of browserTab as text
        set candidateTitle to title of browserTab as text
        if my matchesWorkspaceTab(targetURL, candidateURL, candidateTitle, allowTitleFallback) then
          set active tab index of browserWindow to tabIndex
          set index of browserWindow to 1
          activate
          return true
        end if
      end repeat
    end repeat
  end tell
  return false
end activateChromeWorkspace

on activateSafariWorkspace(targetURL, allowTitleFallback)
  if application "Safari" is not running then return false
  tell application "Safari"
    repeat with browserWindow in windows
      repeat with browserTab in tabs of browserWindow
        set candidateURL to URL of browserTab as text
        set candidateTitle to name of browserTab as text
        if my matchesWorkspaceTab(targetURL, candidateURL, candidateTitle, allowTitleFallback) then
          set current tab of browserWindow to browserTab
          set index of browserWindow to 1
          activate
          return true
        end if
      end repeat
    end repeat
  end tell
  return false
end activateSafariWorkspace

on run argv
  set targetURL to item 1 of argv
  if my activateChromeWorkspace(targetURL, false) then return "activated"
  if my activateSafariWorkspace(targetURL, false) then return "activated"
  if my activateChromeWorkspace(targetURL, true) then return "activated"
  if my activateSafariWorkspace(targetURL, true) then return "activated"
  return "not-found"
end run
'''


_WINDOWS_BROWSER_ACTIVATION_SCRIPT = r'''
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AicoPptWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
}
'@
$names = @('AICO-PPT')
$browsers = Get-Process chrome, msedge, firefox -ErrorAction SilentlyContinue
foreach ($browser in $browsers) {
  if ($browser.MainWindowHandle -eq 0) { continue }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($browser.MainWindowHandle)
  foreach ($name in $names) {
    $condition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, $name
    )
    $tab = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($null -ne $tab) {
      try {
        $pattern = $tab.GetCurrentPattern(
          [System.Windows.Automation.SelectionItemPattern]::Pattern
        )
        $pattern.Select()
      } catch {}
      [AicoPptWindow]::ShowWindowAsync($browser.MainWindowHandle, 9) | Out-Null
      [AicoPptWindow]::SetForegroundWindow($browser.MainWindowHandle) | Out-Null
      Write-Output 'activated'
      exit 0
    }
  }
  if ($browser.MainWindowTitle -like '*AICO-PPT*') {
    [AicoPptWindow]::ShowWindowAsync($browser.MainWindowHandle, 9) | Out-Null
    [AicoPptWindow]::SetForegroundWindow($browser.MainWindowHandle) | Out-Null
    Write-Output 'activated'
    exit 0
  }
}
Write-Output 'not-found'
'''


def _workspace_activation_status(url, platform=sys.platform):
    """返回已有工作台标签的激活结果，区分“不存在”和“无法检测”。"""
    trusted = _trusted_local_app_url(url)
    if not trusted:
        return "unavailable"
    if platform == "win32":
        encoded = base64.b64encode(
            _WINDOWS_BROWSER_ACTIVATION_SCRIPT.encode("utf-16le")
        ).decode("ascii")
        try:
            result = subprocess.run(
                [
                    "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
                    "-WindowStyle", "Hidden", "-EncodedCommand", encoded,
                ],
                capture_output=True,
                text=True,
                timeout=3.0,
                check=False,
                creationflags=_windows_hidden_creation_flags(platform="win32"),
            )
        except (OSError, subprocess.TimeoutExpired):
            return "unavailable"
        if result.returncode != 0:
            return "unavailable"
        status = result.stdout.strip()
        return status if status in {"activated", "not-found"} else "unavailable"
    if platform != "darwin":
        return "unavailable"
    try:
        result = subprocess.run(
            ["/usr/bin/osascript", "-", trusted],
            input=_MACOS_BROWSER_ACTIVATION_SCRIPT,
            text=True,
            capture_output=True,
            timeout=3.0,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unavailable"
    if result.returncode != 0:
        return "unavailable"
    status = result.stdout.strip()
    return status if status in {"activated", "not-found"} else "unavailable"


def _activate_existing_workspace(url, platform=sys.platform):
    """兼容布尔调用方：仅在确实激活已有标签时返回 True。"""
    return _workspace_activation_status(url, platform=platform) == "activated"


def _launcher_client_status(url):
    """读取 app-server 的页面租约状态；只接受带令牌的本机小型 JSON。"""
    trusted = _trusted_local_app_url(url)
    if not trusted:
        return None
    parsed = urllib.parse.urlsplit(trusted)
    status_url = urllib.parse.urlunsplit(parsed._replace(path="/api/launcher-status"))
    try:
        direct_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with direct_opener.open(status_url, timeout=1.0) as response:
            if response.status != 200:
                return None
            payload = json.loads(response.read(4096).decode("utf-8"))
    except (OSError, UnicodeError, ValueError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    active_page_count = payload.get("activePageCount")
    ever_connected = payload.get("everConnected")
    state = payload.get("state")
    if (
        not isinstance(active_page_count, int)
        or isinstance(active_page_count, bool)
        or active_page_count < 0
        or not isinstance(ever_connected, bool)
        or not isinstance(state, str)
    ):
        return None
    return {
        "state": state,
        "activePageCount": active_page_count,
        "everConnected": ever_connected,
    }


def _instance_started_recently(instance, maximum_age=10.0):
    value = instance.get("startedAt") if isinstance(instance, dict) else None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        started_at = float(value)
    elif isinstance(value, str):
        try:
            started_at = datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return False
    else:
        return False
    return 0 <= time.time() - started_at < maximum_age


def _terminate_existing_service(instance, wait_seconds=5.0):
    """结束已失去浏览器标签的旧服务，等待 owner 回收实例登记。"""
    service_pid = instance.get("servicePid") if isinstance(instance, dict) else None
    if (
        not isinstance(service_pid, int)
        or isinstance(service_pid, bool)
        or service_pid <= 0
        or service_pid == os.getpid()
    ):
        return False
    try:
        os.kill(service_pid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    except OSError:
        return False
    deadline = time.monotonic() + max(0.0, wait_seconds)
    while _process_is_live(service_pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    return not _process_is_live(service_pid)


def _run_single_instance_editor(
    command, instance_file=APP_INSTANCE_FILE, activate_existing=True
):
    owner_id, instance = _claim_app_instance(instance_file)
    if owner_id is None:
        if activate_existing and instance:
            app_url = _trusted_local_app_url(instance.get("appUrl"))
            if app_url:
                client_status = _launcher_client_status(app_url)
                if client_status is not None:
                    if client_status["activePageCount"] > 0:
                        # 页面可能活在内嵌 Chromium 或启动器无法枚举的浏览器中。
                        # macOS 若无法把已登记页面带到前台，必须复用同一服务补开
                        # 一个可见标签；否则 Finder 双击会成功退出却毫无反馈。
                        activation = _workspace_activation_status(app_url)
                        if activation != "activated" and sys.platform == "darwin":
                            _open_url(app_url)
                        return 0
                    if client_status["everConnected"]:
                        # pagehide 与新页面连接之间可能有极短切换窗口，先给页面
                        # 三次机会续租；真正关闭后则立即替换仍在宽限期的旧服务。
                        for _attempt in range(3):
                            time.sleep(0.1)
                            refreshed = _launcher_client_status(app_url)
                            if refreshed and refreshed["activePageCount"] > 0:
                                _workspace_activation_status(app_url)
                                return 0
                        if not _terminate_existing_service(instance):
                            _open_url(app_url)
                            return 0
                        owner_id, instance = _claim_app_instance(instance_file)
                        if owner_id is None:
                            replacement_url = _trusted_local_app_url(instance.get("appUrl"))
                            if replacement_url:
                                _open_url(replacement_url)
                            return 0
                    elif _instance_started_recently(instance):
                        # 首次启动的浏览器还没来得及登记租约；重复双击只等待它，
                        # 不能再打开第二个标签页。
                        return 0
                    else:
                        # 服务从未有页面连入，说明首次拉起浏览器失败；这里恢复
                        # 同一地址属于补开首个页面，不构成重复页。
                        _open_url(app_url)
                        return 0
                if client_status is None:
                    # 兼容旧版 app-server：没有租约状态接口时仍沿用浏览器探测。
                    activation = _workspace_activation_status(app_url)
                    if activation == "activated":
                        return 0
                    if activation != "not-found":
                        _open_url(app_url)
                        return 0
                    if not _terminate_existing_service(instance):
                        _open_url(app_url)
                        return 0
                    owner_id, instance = _claim_app_instance(instance_file)
                    if owner_id is None:
                        replacement_url = _trusted_local_app_url(instance.get("appUrl"))
                        if replacement_url:
                            _open_url(replacement_url)
                        return 0
        if owner_id is None:
            return 0
    process = None
    try:
        process = subprocess.Popen(
            command,
            cwd=LAUNCH_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            creationflags=_windows_hidden_creation_flags(),
        )
        first_line = process.stdout.readline()
        try:
            ready = json.loads(first_line)
        except (TypeError, ValueError):
            ready = {}
        app_url = _trusted_local_app_url(
            ready.get("appUrl") or ready.get("editorUrl")
        )
        if app_url:
            instance = {**instance, "appUrl": app_url, "servicePid": process.pid}
            _write_owned_instance(instance_file, instance, owner_id)
        remaining_stdout, stderr = process.communicate()
        stdout = first_line + remaining_stdout
        if process.returncode != 0:
            show_native_error((stderr or stdout or "编辑服务异常退出").strip())
        return process.returncode
    except KeyboardInterrupt:
        process and process.terminate()
        return 130
    finally:
        _release_owned_instance(instance_file, owner_id)


def run_editor(
    command,
    app_mode=False,
    instance_file=APP_INSTANCE_FILE,
    activate_existing=True,
):
    if not app_mode:
        try:
            return subprocess.call(command, cwd=LAUNCH_ROOT)
        except KeyboardInterrupt:
            return 130
    return _run_single_instance_editor(
        command,
        instance_file=instance_file,
        activate_existing=activate_existing,
    )


def main(argv=None):
    normalized_argv = normalize_argv(list(sys.argv[1:] if argv is None else argv))
    parser = argparse.ArgumentParser(description="启动 AICO-PPT 后期微调编辑器")
    parser.add_argument("deck", nargs="?", help="要直接打开的 deck HTML；省略时打开网页导入入口")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--no-open", action="store_true")
    parser.add_argument(
        "--headless-workspace",
        action="store_true",
        help="为纯 Skill 启动无窗口 Managed Workspace；不打开浏览器或 Agent 终端",
    )
    parser.add_argument("--choose", action="store_true", help="忽略路径并打开网页导入入口")
    parser.add_argument("--app", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--detach-windows", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--pick-only", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--pick-directory-only", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--save-pptx-only", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--default-path", help=argparse.SUPPRESS)
    parser.add_argument("--agent-thread-id", help=argparse.SUPPRESS)
    parser.add_argument(
        "--agent-provider", default="auto",
        help="批处理 Agent provider；默认自动选择已安装的 Codex / Claude Code / OpenCode",
    )
    args = parser.parse_args(normalized_argv)

    if args.detach_windows:
        if sys.platform != "win32":
            parser.error("--detach-windows 仅供 Windows 桌面入口使用")
        return _detach_windows_app(normalized_argv)

    if args.agent_provider not in (*AGENT_PROVIDERS, "auto"):
        parser.error(
            "--agent-provider 只支持 auto、" + "、".join(AGENT_PROVIDERS)
        )

    if sum([args.pick_only, args.pick_directory_only, args.save_pptx_only]) > 1:
        parser.error("文件、目录和 PPTX 保存选择器不能同时使用")

    if args.save_pptx_only:
        if not args.default_path:
            parser.error("PPTX 保存选择器需要 --default-path")
        try:
            selected = choose_pptx_save(args.default_path)
            if selected is None:
                return 3
            path = selected.expanduser().absolute()
            if path.suffix.lower() != ".pptx":
                raise LauncherError("请选择 .pptx 格式的保存路径")
        except LauncherError as error:
            print(str(error), file=sys.stderr)
            return 2
        print(json.dumps({"savePath": str(path)}, ensure_ascii=False))
        return 0

    if args.pick_only:
        try:
            selected = choose_deck()
            if selected is None:
                return 3
            deck = resolve_deck(selected)
        except LauncherError as error:
            print(str(error), file=sys.stderr)
            return 2
        print(json.dumps({"deckPath": str(deck)}, ensure_ascii=False))
        return 0

    if args.pick_directory_only:
        try:
            selected = choose_project_directory(default_path=args.default_path)
            if selected is None:
                return 3
            directory = Path(selected).expanduser().resolve()
            if not directory.is_dir():
                raise LauncherError(f"项目目录不可用：{directory}")
        except LauncherError as error:
            print(str(error), file=sys.stderr)
            return 2
        print(json.dumps({"directoryPath": str(directory)}, ensure_ascii=False))
        return 0

    if args.headless_workspace and (args.choose or not args.deck or args.app):
        parser.error("--headless-workspace 必须与一份 deck 路径一起使用，且不能用于桌面 --app")

    try:
        if args.app:
            prepare_editor_runtime(auto_install=True)
        direct_deck = None if args.choose or not args.deck else resolve_deck(Path(args.deck))
        selected_provider = (
            "codex" if args.headless_workspace and args.agent_provider == "auto"
            else resolve_agent_provider(args.agent_provider)
        )
    except LauncherError as error:
        if args.app:
            show_native_error(error)
            return 2
        parser.error(str(error))
    if direct_deck is None:
        command = build_app_command(
            args.host, args.port, args.no_open, agent_provider=selected_provider
        )
    else:
        source_thread_id = args.agent_thread_id or os.environ.get("CODEX_THREAD_ID")
        command = build_command(
            direct_deck,
            args.host,
            args.port,
            args.no_open,
            exit_when_editor_closes=args.app,
            agent_thread_id=source_thread_id,
            agent_provider=selected_provider,
            headless_workspace=args.headless_workspace,
        )
    return run_editor(
        command,
        app_mode=args.app,
        activate_existing=not args.no_open,
    )


if __name__ == "__main__":
    sys.exit(main())
