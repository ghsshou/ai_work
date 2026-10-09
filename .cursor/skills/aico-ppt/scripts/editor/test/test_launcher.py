import base64
import importlib.util
import io
import json
import os
import plistlib
import tempfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
MAC_APP = ROOT / "tools/dev-shell/AICO-PPT Dev Shell.app"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


check_deps = load_module("check_deps", ROOT / "scripts/check_deps.py")
launcher = load_module("launcher", ROOT / "scripts/deck-editor.py")
DECK = ROOT / "assets/training-deck.html"


class LauncherTest(unittest.TestCase):
    def test_dev_launchers_are_outside_product_root_and_resolve_same_skill(self):
        self.assertEqual(list(ROOT.glob("*.app")), [])
        self.assertEqual(list(ROOT.glob("*.cmd")), [])
        executable = MAC_APP / "Contents/MacOS/AICOPPTEditor"
        self.assertEqual((executable.parent / "../../../../..").resolve(), ROOT)
        self.assertIn('$APP_MACOS_DIR/../../../../..', executable.read_text("utf-8"))
        with (MAC_APP / "Contents/Info.plist").open("rb") as source:
            self.assertEqual(plistlib.load(source)["CFBundleDisplayName"], "AICO-PPT Dev Shell")

    def test_macos_app_declares_the_bundled_icon(self):
        plist_path = MAC_APP / "Contents/Info.plist"
        with plist_path.open("rb") as handle:
            info = plistlib.load(handle)

        self.assertEqual(info["CFBundleIconFile"], "AICOPPTEditor")
        icon = MAC_APP / "Contents/Resources/AICOPPTEditor.icns"
        self.assertEqual(icon.read_bytes()[:4], b"icns")

    def test_desktop_instance_url_only_accepts_authenticated_loopback_workspace(self):
        for path in ("app", "editor"):
            url = f"http://127.0.0.1:45678/{path}/?token=secret"
            self.assertEqual(launcher._trusted_local_app_url(url), url)
        for url in (
            "https://127.0.0.1:45678/app/?token=secret",
            "http://example.com:45678/app/?token=secret",
            "http://127.0.0.1:45678/app/",
            "http://127.0.0.1:bad/app/?token=secret",
        ):
            self.assertIsNone(launcher._trusted_local_app_url(url))

    def test_auto_provider_prefers_codex_but_uses_claude_when_it_is_the_only_agent(self):
        with mock.patch.object(
            launcher.shutil, "which", side_effect=lambda value: {
                "claude": r"C:\\Tools\\claude.exe",
                "claude.exe": r"C:\\Tools\\claude.exe",
            }.get(value),
        ):
            self.assertEqual(
                launcher.resolve_agent_provider("auto", platform="win32"),
                "claude-code",
            )

        with mock.patch.object(
            launcher.shutil, "which", side_effect=lambda value: {
                "codex": "/opt/bin/codex", "claude": "/opt/bin/claude",
            }.get(value),
        ):
            self.assertEqual(launcher.resolve_agent_provider("auto", platform="darwin"), "codex")

    def test_auto_provider_without_installed_agent_reports_actionable_error(self):
        with mock.patch.object(launcher, "_find_agent_command", return_value=None):
            with self.assertRaisesRegex(launcher.LauncherError, "Codex、Claude Code 或 OpenCode"):
                launcher.resolve_agent_provider("auto", platform="win32")

    def test_windows_wsl_codex_configuration_selects_codex_without_native_cli(self):
        with mock.patch.object(launcher, "_find_agent_command", return_value=None):
            self.assertEqual(
                launcher.resolve_agent_provider(
                    "auto",
                    platform="win32",
                    runtime_settings={
                        "codexRuntime": "wsl",
                        "wslDistribution": "Ubuntu-26.04",
                        "wslUser": "root",
                    },
                ),
                "codex",
            )

    def test_invalid_local_agent_runtime_configuration_is_actionable(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = Path(directory) / "settings.json"
            settings.write_text('{"codexRuntime":"wsl","wslDistribution":""}', encoding="utf-8")
            with mock.patch.dict(
                os.environ,
                {"AICO_PPT_EDITOR_STATE_ROOT": directory},
                clear=False,
            ):
                with self.assertRaisesRegex(launcher.LauncherError, "WSL 发行版"):
                    launcher.load_agent_runtime_settings()

    def test_windows_auto_provider_finds_claude_in_user_npm_bin_without_path(self):
        with tempfile.TemporaryDirectory() as directory:
            appdata = Path(directory)
            npm = appdata / "npm"
            npm.mkdir()
            (npm / "claude.cmd").touch()
            with mock.patch.dict(os.environ, {
                "APPDATA": str(appdata), "LOCALAPPDATA": "",
                "USERPROFILE": "", "SystemDrive": str(appdata),
            }, clear=False), mock.patch.object(launcher.shutil, "which", return_value=None):
                self.assertEqual(
                    launcher.resolve_agent_provider("auto", platform="win32"),
                    "claude-code",
                )

    def test_required_node_module_probe(self):
        self.assertTrue(check_deps.probe_node_module("node:path")[0])
        self.assertFalse(check_deps.probe_node_module("module-that-does-not-exist")[0])

    def test_direct_path_and_empty_app_use_different_node_entries(self):
        thread_id = "019fc842-816b-7413-bb23-10b0f87e1d4c"
        direct = launcher.build_command(
            DECK, no_open=True, agent_thread_id=thread_id
        )
        empty_app = launcher.build_app_command(no_open=True)
        self.assertEqual(direct[1], str(ROOT / "scripts/editor/server.mjs"))
        self.assertIn(str(DECK.resolve()), direct)
        self.assertEqual(direct[direct.index("--agent-thread-id") + 1], thread_id)
        self.assertEqual(empty_app[1], str(ROOT / "scripts/editor/app-server.mjs"))
        self.assertIn("--python", empty_app)

        headless = launcher.build_command(DECK, headless_workspace=True)
        self.assertIn("--headless-workspace", headless)

    def test_main_routes_without_opening_picker_eagerly(self):
        # 本测试只验证路由，不应扫描宿主机 PATH。Parallels 的临时映射盘若
        # 恰好出现在 PATH 中，Windows 的 shutil.which 可能等待失联网络盘。
        with mock.patch.object(
            launcher, "resolve_agent_provider", return_value="claude-code"
        ):
            with (
                mock.patch.object(launcher, "choose_deck") as choose_deck,
                mock.patch.object(launcher, "prepare_editor_runtime") as prepare,
                mock.patch.object(launcher, "run_editor", return_value=0) as run_editor,
            ):
                self.assertEqual(launcher.main(["--app"]), 0)
            choose_deck.assert_not_called()
            prepare.assert_called_once_with(auto_install=True)
            self.assertIn("app-server.mjs", run_editor.call_args.args[0][1])

            with mock.patch.object(launcher, "run_editor", return_value=0) as run_editor:
                self.assertEqual(launcher.main([str(DECK), "--no-open"]), 0)
            self.assertIn("server.mjs", run_editor.call_args.args[0][1])
            self.assertNotIn("--exit-when-editor-closes", run_editor.call_args.args[0])

            with mock.patch.object(launcher, "run_editor", return_value=0) as run_editor:
                self.assertEqual(launcher.main([
                    str(DECK), "--headless-workspace",
                ]), 0)
            self.assertIn("--headless-workspace", run_editor.call_args.args[0])

    def test_pick_only_has_small_machine_readable_contract(self):
        with mock.patch.object(launcher, "choose_deck", return_value=DECK):
            with mock.patch("sys.stdout") as stdout:
                self.assertEqual(launcher.main(["--pick-only"]), 0)
        payload = json.loads("".join(call.args[0] for call in stdout.write.call_args_list))
        self.assertEqual(payload["deckPath"], str(DECK.resolve()))

        with mock.patch.object(launcher, "choose_deck", return_value=None):
            self.assertEqual(launcher.main(["--pick-only"]), 3)

    def test_save_pptx_defaults_to_project_path_and_supports_cancel(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "演示文稿.pptx"
            with mock.patch.object(launcher, "choose_pptx_save", return_value=path) as choose:
                with mock.patch("sys.stdout") as stdout:
                    self.assertEqual(launcher.main(["--save-pptx-only", "--default-path", str(path)]), 0)
                choose.assert_called_once_with(str(path))
            payload = json.loads("".join(call.args[0] for call in stdout.write.call_args_list))
            self.assertEqual(payload["savePath"], str(path.absolute()))
            with mock.patch.object(launcher, "choose_pptx_save", return_value=None):
                self.assertEqual(launcher.main(["--save-pptx-only", "--default-path", str(path)]), 3)

    def test_save_pptx_system_dialog_receives_directory_and_filename(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "演示文稿.pptx"
            with mock.patch.object(launcher.sys, "platform", "win32"), mock.patch.object(
                launcher, "_choose_with_tk", return_value=str(path)
            ) as choose:
                self.assertEqual(launcher.choose_pptx_save(str(path)), path)
                self.assertEqual(choose.call_args.args, ("asksaveasfilename",))
                self.assertEqual(choose.call_args.kwargs["initialdir"], str(path.parent))
                self.assertEqual(choose.call_args.kwargs["initialfile"], path.name)
                self.assertTrue(choose.call_args.kwargs["confirmoverwrite"])
            with mock.patch.object(launcher.sys, "platform", "darwin"), mock.patch.object(
                launcher, "_run_applescript", return_value=types.SimpleNamespace(returncode=0, stdout="", stderr="")
            ) as choose, mock.patch.object(launcher.Path, "is_file", return_value=True):
                self.assertIsNone(launcher.choose_pptx_save(str(path)))
                self.assertEqual(choose.call_args.args[1:], (path.name, str(path.parent)))

    def test_pick_directory_only_has_small_machine_readable_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(
                launcher, "choose_project_directory", return_value=Path(directory)
            ):
                with mock.patch("sys.stdout") as stdout:
                    self.assertEqual(launcher.main(["--pick-directory-only"]), 0)
            payload = json.loads("".join(
                call.args[0] for call in stdout.write.call_args_list
            ))
            self.assertEqual(payload["directoryPath"], str(Path(directory).resolve()))

        with mock.patch.object(launcher, "choose_project_directory", return_value=None):
            self.assertEqual(launcher.main(["--pick-directory-only"]), 3)

    def test_windows_directory_picker_has_topmost_parent_and_always_destroys_root(self):
        root = mock.Mock()
        filedialog = types.ModuleType("tkinter.filedialog")
        filedialog.askdirectory = mock.Mock(return_value=r"C:\\workspace")
        tkinter = types.ModuleType("tkinter")
        tkinter.Tk = mock.Mock(return_value=root)
        tkinter.filedialog = filedialog

        with (
            mock.patch.dict(
                "sys.modules",
                {"tkinter": tkinter, "tkinter.filedialog": filedialog},
            ),
            mock.patch.object(launcher.sys, "platform", "win32"),
        ):
            selected = launcher.choose_project_directory()

        self.assertEqual(str(selected), r"C:\\workspace")
        root.withdraw.assert_called_once_with()
        root.attributes.assert_called_once_with("-topmost", True)
        root.update_idletasks.assert_called_once_with()
        root.update.assert_called_once_with()
        filedialog.askdirectory.assert_called_once_with(
            parent=root, title="选择 Agent 项目目录", mustexist=True
        )
        root.destroy.assert_called_once_with()

    def test_directory_picker_cli_forwards_configured_path(self):
        with tempfile.TemporaryDirectory(prefix="项目 空格-") as directory:
            with (
                mock.patch.object(launcher, "choose_project_directory", return_value=None) as choose,
                mock.patch("sys.stdout"),
            ):
                self.assertEqual(launcher.main([
                    "--pick-directory-only", "--default-path", directory,
                ]), 3)
            choose.assert_called_once_with(default_path=directory)

    def test_tk_directory_picker_starts_at_configured_path(self):
        directory = r'C:\项目目录\中文 草稿'
        with (
            mock.patch.object(launcher.sys, "platform", "win32"),
            mock.patch.object(launcher, "_choose_with_tk", return_value="") as choose,
        ):
            self.assertIsNone(launcher.choose_project_directory(default_path=directory))
        choose.assert_called_once_with(
            "askdirectory", title="选择 Agent 项目目录", mustexist=True, initialdir=directory,
        )

    def test_macos_directory_picker_passes_current_path_as_data(self):
        directory = '/tmp/项目 "草稿"'
        with (
            mock.patch.object(launcher.sys, "platform", "darwin"),
            mock.patch.object(launcher.Path, "is_file", return_value=True),
            mock.patch.object(launcher, "_run_applescript", return_value=types.SimpleNamespace(returncode=0, stdout="", stderr="")) as run,
        ):
            self.assertIsNone(launcher.choose_project_directory(default_path=directory))
        source, prompt, initial_directory = run.call_args.args
        self.assertEqual(initial_directory, directory)
        self.assertNotIn(directory, source)
        self.assertIn("default location", source)

    def test_finder_argument_and_ctrl_c_are_quiet(self):
        self.assertEqual(launcher.normalize_argv(["-psn_0_123", "deck.html"]), ["deck.html"])
        with mock.patch.object(launcher.subprocess, "call", side_effect=KeyboardInterrupt):
            self.assertEqual(launcher.run_editor(["node", "server.mjs"]), 130)

    def test_app_mode_activates_live_workspace_without_opening_second_page(self):
        with tempfile.TemporaryDirectory() as directory:
            instance_file = Path(directory) / "app-instance.json"
            instance_file.write_text(json.dumps({
                "version": 1,
                "ownerId": "existing-owner",
                "pid": os.getpid(),
                "appUrl": "http://127.0.0.1:45678/app/?token=existing",
                "startedAt": datetime.now(timezone.utc).isoformat(),
            }), encoding="utf-8")
            with (
                mock.patch.object(launcher, "_instance_is_live", return_value=True),
                mock.patch.object(
                    launcher, "_workspace_activation_status",
                    return_value="activated",
                ) as activate_workspace,
                mock.patch.object(
                    launcher, "_open_url",
                    side_effect=AssertionError("已有工作区在线时不得重复打开网页"),
                ),
                mock.patch.object(
                    launcher.subprocess, "Popen",
                    side_effect=AssertionError("不得启动第二个 app-server"),
                ),
            ):
                self.assertEqual(launcher.run_editor(
                    ["node", "app-server.mjs"],
                    app_mode=True,
                    instance_file=instance_file,
                ), 0)
            activate_workspace.assert_called_once_with(
                "http://127.0.0.1:45678/app/?token=existing"
            )

    def test_app_mode_restarts_live_service_when_workspace_tab_was_closed(self):
        class FakeProcess:
            pid = 54321
            returncode = 0
            stdout = io.StringIO(
                '{"appUrl":"http://127.0.0.1:45679/app/?token=fresh"}\n'
            )
            stderr = io.StringIO("")

            def communicate(self):
                return "", ""

        with tempfile.TemporaryDirectory() as directory:
            instance_file = Path(directory) / "app-instance.json"
            instance_file.write_text(json.dumps({
                "version": 1,
                "ownerId": "existing-owner",
                "pid": os.getpid(),
                "servicePid": 87654,
                "appUrl": "http://127.0.0.1:45678/app/?token=existing",
                "startedAt": datetime.now(timezone.utc).isoformat(),
            }), encoding="utf-8")
            def terminate_existing(_instance):
                instance_file.unlink()
                return True
            with (
                mock.patch.object(launcher, "_instance_is_live", return_value=True),
                mock.patch.object(
                    launcher, "_workspace_activation_status", return_value="not-found",
                ),
                mock.patch.object(
                    launcher, "_terminate_existing_service",
                    side_effect=terminate_existing,
                ),
                mock.patch.object(launcher, "_open_url") as open_url,
                mock.patch.object(
                    launcher.subprocess, "Popen", return_value=FakeProcess(),
                ) as popen,
            ):
                self.assertEqual(launcher.run_editor(
                    ["node", "app-server.mjs"],
                    app_mode=True,
                    instance_file=instance_file,
                ), 0)
            popen.assert_called_once()
            open_url.assert_not_called()

    def test_app_mode_reopens_live_workspace_when_browser_detection_is_unavailable(self):
        with tempfile.TemporaryDirectory() as directory:
            instance_file = Path(directory) / "app-instance.json"
            instance_file.write_text(json.dumps({
                "version": 1,
                "ownerId": "existing-owner",
                "pid": os.getpid(),
                "servicePid": 87654,
                "appUrl": "http://127.0.0.1:45678/app/?token=existing",
                "startedAt": datetime.now(timezone.utc).isoformat(),
            }), encoding="utf-8")
            with (
                mock.patch.object(launcher, "_instance_is_live", return_value=True),
                mock.patch.object(
                    launcher, "_workspace_activation_status", return_value="unavailable",
                ),
                mock.patch.object(launcher, "_open_url") as open_url,
                mock.patch.object(
                    launcher, "_terminate_existing_service",
                    side_effect=AssertionError("无法检测浏览器时不得终止现有服务"),
                ),
                mock.patch.object(
                    launcher.subprocess, "Popen",
                    side_effect=AssertionError("无法检测浏览器时不得启动第二个 app-server"),
                ),
            ):
                self.assertEqual(launcher.run_editor(
                    ["node", "app-server.mjs"],
                    app_mode=True,
                    instance_file=instance_file,
                ), 0)
            open_url.assert_called_once_with(
                "http://127.0.0.1:45678/app/?token=existing"
            )

    def test_windows_live_page_never_opens_a_duplicate_when_activation_is_unavailable(self):
        with tempfile.TemporaryDirectory() as directory:
            instance_file = Path(directory) / "app-instance.json"
            instance_file.write_text(json.dumps({
                "version": 1,
                "ownerId": "existing-owner",
                "pid": os.getpid(),
                "servicePid": 87654,
                "appUrl": "http://127.0.0.1:45678/app/?token=existing",
                "startedAt": datetime.now(timezone.utc).isoformat(),
            }), encoding="utf-8")
            with (
                mock.patch.object(launcher.sys, "platform", "win32"),
                mock.patch.object(launcher, "_instance_is_live", return_value=True),
                mock.patch.object(launcher, "_launcher_client_status", return_value={
                    "state": "idle", "activePageCount": 1, "everConnected": True,
                }),
                mock.patch.object(
                    launcher, "_workspace_activation_status", return_value="unavailable",
                ),
                mock.patch.object(
                    launcher, "_open_url",
                    side_effect=AssertionError("活动页面存在时不得打开第二个标签页"),
                ),
                mock.patch.object(
                    launcher.subprocess, "Popen",
                    side_effect=AssertionError("活动页面存在时不得启动第二个服务"),
                ),
            ):
                self.assertEqual(launcher.run_editor(
                    ["node", "app-server.mjs"],
                    app_mode=True,
                    instance_file=instance_file,
                ), 0)

    def test_macos_live_page_reopens_when_registered_window_cannot_be_activated(self):
        with tempfile.TemporaryDirectory() as directory:
            instance_file = Path(directory) / "app-instance.json"
            instance_file.write_text(json.dumps({
                "version": 1,
                "ownerId": "existing-owner",
                "pid": os.getpid(),
                "servicePid": 87654,
                "appUrl": "http://127.0.0.1:45678/app/?token=existing",
                "startedAt": datetime.now(timezone.utc).isoformat(),
            }), encoding="utf-8")
            with (
                mock.patch.object(launcher.sys, "platform", "darwin"),
                mock.patch.object(launcher, "_instance_is_live", return_value=True),
                mock.patch.object(launcher, "_launcher_client_status", return_value={
                    "state": "idle", "activePageCount": 1, "everConnected": True,
                }),
                mock.patch.object(
                    launcher, "_workspace_activation_status", return_value="not-found",
                ),
                mock.patch.object(launcher, "_open_url") as open_url,
                mock.patch.object(
                    launcher.subprocess, "Popen",
                    side_effect=AssertionError("已有服务可复用时不得启动第二个 app-server"),
                ),
            ):
                self.assertEqual(launcher.run_editor(
                    ["node", "app-server.mjs"],
                    app_mode=True,
                    instance_file=instance_file,
                ), 0)
            open_url.assert_called_once_with(
                "http://127.0.0.1:45678/app/?token=existing"
            )

    def test_windows_closed_page_restarts_instead_of_reopening_stale_service(self):
        class FakeProcess:
            pid = 54321
            returncode = 0
            stdout = io.StringIO(
                '{"appUrl":"http://127.0.0.1:45679/app/?token=fresh"}\n'
            )
            stderr = io.StringIO("")

            def communicate(self):
                return "", ""

        with tempfile.TemporaryDirectory() as directory:
            instance_file = Path(directory) / "app-instance.json"
            instance_file.write_text(json.dumps({
                "version": 1,
                "ownerId": "existing-owner",
                "pid": os.getpid(),
                "servicePid": 87654,
                "appUrl": "http://127.0.0.1:45678/app/?token=existing",
                "startedAt": datetime.now(timezone.utc).isoformat(),
            }), encoding="utf-8")

            def terminate_existing(_instance):
                instance_file.unlink()
                return True

            with (
                mock.patch.object(launcher.sys, "platform", "win32"),
                mock.patch.object(launcher, "_instance_is_live", return_value=True),
                mock.patch.object(launcher, "_launcher_client_status", return_value={
                    "state": "idle", "activePageCount": 0, "everConnected": True,
                }),
                mock.patch.object(
                    launcher, "_terminate_existing_service",
                    side_effect=terminate_existing,
                ),
                mock.patch.object(launcher, "_open_url") as open_url,
                mock.patch.object(
                    launcher.subprocess, "Popen", return_value=FakeProcess(),
                ) as popen,
            ):
                self.assertEqual(launcher.run_editor(
                    ["node", "app-server.mjs"],
                    app_mode=True,
                    instance_file=instance_file,
                ), 0)
            popen.assert_called_once()
            open_url.assert_not_called()

    def test_windows_detach_uses_hidden_standard_python_process(self):
        with mock.patch.object(launcher.subprocess, "Popen") as popen:
            self.assertEqual(launcher._detach_windows_app(
                ["--detach-windows", "--app", "--agent-provider", "codex"],
                executable=r"C:\Python311\python.exe",
            ), 0)
        command = popen.call_args.args[0]
        options = popen.call_args.kwargs
        self.assertEqual(command[0], r"C:\Python311\python.exe")
        self.assertNotIn("--detach-windows", command)
        self.assertIn("--app", command)
        self.assertEqual(options["stdin"], launcher.subprocess.DEVNULL)
        self.assertEqual(options["stdout"], launcher.subprocess.DEVNULL)
        self.assertEqual(options["stderr"], launcher.subprocess.DEVNULL)
        self.assertTrue(options["creationflags"] & 0x08000000)

    def test_windows_activation_uses_hidden_browser_ui_automation(self):
        completed = mock.Mock(returncode=0, stdout="activated\n")
        with mock.patch.object(
            launcher.subprocess, "run", return_value=completed,
        ) as run:
            self.assertEqual(launcher._workspace_activation_status(
                "http://127.0.0.1:45678/app/?token=existing",
                platform="win32",
            ), "activated")
        command = run.call_args.args[0]
        options = run.call_args.kwargs
        self.assertEqual(command[0], "powershell.exe")
        self.assertIn("-WindowStyle", command)
        self.assertTrue(options["creationflags"] & 0x08000000)
        script = base64.b64decode(command[-1]).decode("utf-16le")
        self.assertIn("AICO-PPT", script)
        self.assertIn("SelectionItemPattern", script)
        self.assertNotIn("token=existing", script)

    def test_launcher_status_probe_is_authenticated_small_and_proxy_free(self):
        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, limit):
                self.limit = limit
                return b'{"state":"idle","activePageCount":1,"everConnected":true}'

        response = Response()
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(
            launcher.urllib.request, "build_opener", return_value=opener,
        ):
            self.assertEqual(launcher._launcher_client_status(
                "http://127.0.0.1:45678/app/?token=existing"
            ), {
                "state": "idle", "activePageCount": 1, "everConnected": True,
            })
        self.assertEqual(response.limit, 4096)
        status_url = opener.open.call_args.args[0]
        self.assertEqual(
            status_url,
            "http://127.0.0.1:45678/api/launcher-status?token=existing",
        )

    def test_macos_activation_focuses_existing_aico_ppt_tab(self):
        completed = mock.Mock(returncode=0, stdout="activated\n")
        with mock.patch.object(
            launcher.subprocess, "run", return_value=completed,
        ) as run:
            self.assertTrue(launcher._activate_existing_workspace(
                "http://127.0.0.1:45678/app/?token=existing",
                platform="darwin",
            ))
        command = run.call_args.args[0]
        self.assertEqual(command, [
            "/usr/bin/osascript", "-",
            "http://127.0.0.1:45678/app/?token=existing",
        ])
        script = run.call_args.kwargs["input"]
        self.assertIn('application id "com.google.Chrome"', script)
        self.assertIn('candidateTitle is "AICO-PPT"', script)
        self.assertNotIn("token=existing", script)
        self.assertLess(
            script.index("activateSafariWorkspace(targetURL, false)"),
            script.index("activateChromeWorkspace(targetURL, true)"),
        )

    def test_macos_activation_reopens_only_when_no_workspace_tab_exists(self):
        completed = mock.Mock(returncode=0, stdout="not-found\n")
        with mock.patch.object(
            launcher.subprocess, "run", return_value=completed,
        ):
            self.assertEqual(launcher._workspace_activation_status(
                "http://127.0.0.1:45678/app/?token=existing",
                platform="darwin",
            ), "not-found")
            self.assertFalse(launcher._activate_existing_workspace(
                "http://127.0.0.1:45678/app/?token=existing",
                platform="darwin",
            ))

    def test_macos_activation_error_requests_workspace_reopen(self):
        with mock.patch.object(
            launcher.subprocess, "run", side_effect=OSError("automation denied"),
        ):
            self.assertEqual(launcher._workspace_activation_status(
                "http://127.0.0.1:45678/app/?token=existing",
                platform="darwin",
            ), "unavailable")
            self.assertFalse(launcher._activate_existing_workspace(
                "http://127.0.0.1:45678/app/?token=existing",
                platform="darwin",
            ))

    def test_macos_activation_unknown_result_requests_workspace_reopen(self):
        completed = mock.Mock(returncode=0, stdout="unexpected\n")
        with mock.patch.object(
            launcher.subprocess, "run", return_value=completed,
        ):
            self.assertEqual(launcher._workspace_activation_status(
                "http://127.0.0.1:45678/app/?token=existing",
                platform="darwin",
            ), "unavailable")
            self.assertFalse(launcher._activate_existing_workspace(
                "http://127.0.0.1:45678/app/?token=existing",
                platform="darwin",
            ))

    def test_closed_workspace_service_receives_sigterm_before_replacement(self):
        with (
            mock.patch.object(launcher.os, "kill") as kill,
            mock.patch.object(launcher, "_process_is_live", return_value=False),
        ):
            self.assertTrue(launcher._terminate_existing_service({
                "servicePid": 87654,
            }))
        kill.assert_called_once_with(87654, launcher.signal.SIGTERM)

    def test_instance_probe_bypasses_system_proxy_for_loopback(self):
        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                return b"<title>AICO-PPT</title>"

        opener = mock.Mock()
        opener.open.return_value = Response()
        instance = {
            "version":1,
            "pid":os.getpid(),
            "appUrl":"http://127.0.0.1:45678/app/?token=secret",
        }
        with (
            mock.patch.object(
                launcher.urllib.request, "build_opener", return_value=opener,
            ) as build_opener,
            mock.patch.object(
                launcher.urllib.request, "urlopen",
                side_effect=AssertionError("loopback 探测不得继承系统 HTTP 代理"),
            ),
        ):
            self.assertTrue(launcher._instance_is_live(instance))
        build_opener.assert_called_once()
        self.assertIsInstance(
            build_opener.call_args.args[0], launcher.urllib.request.ProxyHandler,
        )

    def test_transient_health_failure_never_duplicates_live_owner_and_service(self):
        with tempfile.TemporaryDirectory() as directory:
            instance_file = Path(directory) / "app-instance.json"
            instance_file.write_text(json.dumps({
                "version":1,
                "ownerId":"live-owner",
                "pid":os.getpid(),
                "servicePid":os.getpid(),
                "appUrl":"http://127.0.0.1:45678/app/?token=existing",
                "startedAt":0,
            }), encoding="utf-8")
            with (
                mock.patch.object(launcher, "_instance_is_live", return_value=False),
                mock.patch.object(
                    launcher, "_workspace_activation_status", return_value="activated",
                ) as activate_workspace,
                mock.patch.object(
                    launcher, "_open_url",
                    side_effect=AssertionError("探测抖动时不得重复打开网页"),
                ),
                mock.patch.object(
                    launcher.subprocess, "Popen",
                    side_effect=AssertionError("健康探测抖动不得启动第二个 app-server"),
                ),
            ):
                self.assertEqual(launcher.run_editor(
                    ["node", "app-server.mjs"], app_mode=True,
                    instance_file=instance_file,
                ), 0)
            activate_workspace.assert_called_once_with(
                "http://127.0.0.1:45678/app/?token=existing"
            )

    def test_app_mode_replaces_stale_registry_and_releases_its_own_entry(self):
        class FakeProcess:
            pid = 54321
            returncode = 0
            stdout = io.StringIO(
                '{"appUrl":"http://127.0.0.1:45679/app/?token=fresh"}\n'
            )
            stderr = io.StringIO("")

            def communicate(self):
                return "", ""

        with tempfile.TemporaryDirectory() as directory:
            instance_file = Path(directory) / "app-instance.json"
            instance_file.write_text(json.dumps({
                "version":1,
                "ownerId":"stale-owner",
                "pid":os.getpid(),
                "appUrl":None,
                "startedAt":0,
            }), encoding="utf-8")
            with mock.patch.object(
                launcher.subprocess, "Popen", return_value=FakeProcess()
            ) as popen:
                self.assertEqual(launcher.run_editor(
                    ["node", "app-server.mjs"],
                    app_mode=True,
                    instance_file=instance_file,
                ), 0)
            popen.assert_called_once()
            self.assertFalse(instance_file.exists())

    def test_dependency_failure_explains_node_requirement(self):
        with mock.patch.object(
            launcher, "editor_dependency_status",
            return_value=(False, "Node.js 未就绪：未安装 node"),
        ):
            with self.assertRaisesRegex(launcher.LauncherError, "Node.js 18"):
                launcher.prepare_editor_runtime(auto_install=True)

    def test_macos_app_bundle_points_to_unified_launcher(self):
        app = ROOT / "tools/dev-shell/AICO-PPT Dev Shell.app"
        executable = app / "Contents/MacOS/AICOPPTEditor"
        with (app / "Contents/Info.plist").open("rb") as source:
            info = plistlib.load(source)
        self.assertEqual(info["CFBundleExecutable"], executable.name)
        self.assertEqual(info["CFBundlePackageType"], "APPL")
        self.assertEqual(info["CFBundleVersion"], "2")
        self.assertTrue(os.access(executable, os.X_OK))
        contents = executable.read_text(encoding="utf-8")
        self.assertIn("scripts/deck-editor.py", contents)
        self.assertIn("/usr/bin/nohup", contents)
        self.assertIn("hw.optional.arm64", contents)
        self.assertIn("/usr/bin/arch -arm64", contents)
        self.assertNotIn("exec python3", contents)
