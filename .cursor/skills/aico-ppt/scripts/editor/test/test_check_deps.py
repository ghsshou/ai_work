import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "aico_ppt_check_deps", ROOT / "scripts" / "check_deps.py"
)
doctor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(doctor)


class CheckDepsTest(unittest.TestCase):
    def test_plugin_browser_cannot_fall_back_to_system_chrome(self):
        with mock.patch.dict(os.environ, {"AICO_RUNTIME_KIND": "plugin"}, clear=True), mock.patch.object(doctor.shutil, "which") as which:
            ready, detail = doctor.probe_chrome()
            self.assertFalse(ready)
            self.assertIn("私有浏览器", detail)
            which.assert_not_called()


    def test_node_supports_unflagged_esm_resolution(self):
        for version, ready in [("v18.18.0", False), ("v18.19.0", True), ("v18.20.8", True), ("v19.9.0", False), ("v20.5.0", False), ("v20.6.0", True), ("v24.19.0", True)]:
            with self.subTest(version=version), mock.patch.object(
                doctor, "run", return_value=doctor.subprocess.CompletedProcess(["node"], 0, version, "")
            ):
                self.assertEqual(doctor.probe_node()[0], ready)

    def test_pptx_export_reports_missing_editable_tools_without_installing_dependencies(self):
        _, checks = doctor.checks_for_profiles(["pptx-export"])
        builder = next(check for check in checks if check["key"] == "pptx-builder")
        self.assertIsNone(builder.get("install"))
        for name in ("extract-editable.mjs", "editable-scene.mjs", "build_editable_pptx.py", "export-ready.mjs"):
            with self.subTest(missing=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                base = root / "scripts" / "html2pptx"
                shutil.copytree(ROOT / "scripts" / "html2pptx", base)
                with mock.patch.object(doctor, "REPO", root), \
                        mock.patch.object(doctor, "run") as run:
                    self.assertTrue(doctor.do_probe(builder)[0])
                    (base / name).unlink()
                    ready, detail = doctor.do_probe(builder)
                    self.assertFalse(ready)
                    self.assertIn(f"scripts/html2pptx/{name}", detail)
                    probe = doctor.do_probe
                    with mock.patch.object(doctor, "do_probe", side_effect=lambda check: (
                        probe(check) if check["key"] == "pptx-builder" else (True, "ok")
                    )):
                        snapshot = doctor.dependency_snapshot(["pptx-export"])
                    self.assertFalse(snapshot["ready"])
                    self.assertEqual(snapshot["profiles"]["pptx-export"]["state"], "manual-action-required")
                    run.assert_not_called()

    def test_desktop_verify_uses_renderer_without_browser_or_playwright(self):
        with mock.patch.dict(os.environ, {"AICO_RUNTIME_KIND": "desktop"}):
            _, checks = doctor.checks_for_profiles(["pptx-export"])
        self.assertEqual({check["key"] for check in checks}, {"node", "desktop-renderer", "pptx-builder", "pillow"})
        with mock.patch.dict(os.environ, {"AICO_RUNTIME_KIND": "standalone"}):
            _, checks = doctor.checks_for_profiles(["pptx-export"])
        self.assertEqual({check["key"] for check in checks}, {"node", "playwright-core", "chrome", "pptx-builder", "pillow"})

    def test_desktop_renderer_probe_reports_disconnected_host(self):
        failure = doctor.subprocess.CompletedProcess(["node"], 1, "", "桌面渲染服务不可用")
        with mock.patch.object(doctor, "run", return_value=failure):
            self.assertEqual(doctor.probe_desktop_renderer(), (False, "桌面渲染服务不可用"))

    def test_pdf_materials_keep_pypdf_only_for_forms_and_do_not_reinstall_upstream_skill(self):
        _, checks = doctor.checks_for_profiles(["materials"])
        self.assertEqual({check["key"] for check in checks}, {"pymupdf", "pypdf"})
        self.assertFalse({"pdfplumber", "reportlab", "pdf-skill"} & {check["key"] for check in doctor.CHECKS})
        self.assertEqual(next(check for check in checks if check["key"] == "pymupdf")["install"], doctor.pip("pymupdf"))
        self.assertIn("表单", next(check for check in checks if check["key"] == "pypdf")["why"])

    def test_three_browser_files_satisfy_editor_without_commonjs_entry(self):
        _, checks = doctor.checks_for_profiles(["editor-core"])
        three = next(check for check in checks if check["key"] == "three")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build = root / "node_modules" / "three" / "build"
            build.mkdir(parents=True)
            for name in ("three.module.min.js", "three.core.min.js"):
                (build / name).write_text("// 浏览器运行时", encoding="utf-8")
            (build.parent / "package.json").write_text(json.dumps({
                "name": "three", "exports": {".": {"import": "./build/three.module.js", "require": "./build/three.cjs"}}
            }), encoding="utf-8")
            plugin = root / "plugins" / "ppt"
            plugin.mkdir(parents=True)
            with mock.patch.object(doctor, "REPO", plugin):
                ready, detail = doctor.do_probe(three)
            self.assertTrue(ready)
            self.assertIn("three.module.min.js", detail)
            self.assertIn("three.core.min.js", detail)

    def test_three_requires_both_browser_files_even_when_commonjs_resolves(self):
        _, checks = doctor.checks_for_profiles(["editor-core"])
        three = next(check for check in checks if check["key"] == "three")
        names = ("three.module.min.js", "three.core.min.js")
        for missing_name in names:
            with self.subTest(missing=missing_name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                build = root / "node_modules" / "three" / "build"
                build.mkdir(parents=True)
                for name in names:
                    if name != missing_name:
                        (build / name).touch()
                (build / "three.cjs").touch()
                success = doctor.subprocess.CompletedProcess(["node"], 0, str(build), "")
                with mock.patch.object(doctor, "REPO", root), \
                        mock.patch.object(doctor, "run", return_value=success):
                    ready, detail = doctor.do_probe(three)
                self.assertFalse(ready)
                self.assertIn(missing_name, detail)

    def test_other_node_modules_still_use_node_resolution(self):
        success = doctor.subprocess.CompletedProcess(["node"], 0, "", "")
        with mock.patch.object(doctor, "run", return_value=success) as run:
            self.assertTrue(doctor.probe_node_module("ws")[0])
        run.assert_called_once_with(
            ["node", "-e", "require.resolve('ws')"],
            cwd=str(doctor.REPO), capture_output=True, text=True,
        )

    def test_desktop_browser_selection_does_not_fall_back_to_host_chrome(self):
        with tempfile.TemporaryDirectory() as directory:
            browser = Path(directory) / "AICO Browser"
            browser.touch()
            with mock.patch.dict(os.environ, {"AICO_BROWSER_EXECUTABLE": str(browser)}):
                self.assertEqual(doctor.probe_chrome(), (True, f"AICO 内置浏览器：{browser}"))
                browser.unlink()
                self.assertFalse(doctor.probe_chrome()[0])

    def test_pptx_read_uses_only_bundled_extractor_and_no_package_installs(self):
        profiles, checks = doctor.checks_for_profiles(["pptx-read"])
        self.assertEqual(profiles, ("pptx-read",))
        self.assertEqual([check["key"] for check in checks], ["pptx-extractor"])
        self.assertIsNone(checks[0].get("install"))
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(doctor, "REPO", Path(directory)), \
                mock.patch.object(doctor, "run") as run:
            missing = doctor.repair_dependencies(["pptx-read"])
            self.assertFalse(missing["ready"])
            self.assertEqual(missing["profiles"]["pptx-read"]["state"], "manual-action-required")
            extractor = Path(directory) / "scripts" / "extract-pptx.py"
            extractor.parent.mkdir()
            extractor.write_text("# 仅使用标准库", encoding="utf-8")
            self.assertTrue(doctor.dependency_snapshot(["pptx-read"])["ready"])
            run.assert_not_called()

    def test_profiles_keep_editor_core_independent_from_dev_shell_and_material_tools(self):
        editor_profiles, editor_checks = doctor.checks_for_profiles(["editor-core"])
        dev_profiles, dev_checks = doctor.checks_for_profiles(["dev-shell"])
        material_profiles, material_checks = doctor.checks_for_profiles(["materials"])

        self.assertEqual(editor_profiles, ("editor-core",))
        self.assertNotIn("node-pty", {check["key"] for check in editor_checks})
        self.assertNotIn("agent-cli", {check["key"] for check in editor_checks})
        self.assertNotIn("soffice", {check["key"] for check in editor_checks})
        self.assertEqual(dev_profiles, ("dev-shell",))
        self.assertIn("node-pty", {check["key"] for check in dev_checks})
        self.assertIn("@xterm/headless", {check["key"] for check in dev_checks})
        self.assertIn("@xterm/addon-serialize", {check["key"] for check in dev_checks})
        self.assertIn("agent-cli", {check["key"] for check in dev_checks})
        self.assertIn("html2canvas", {check["key"] for check in dev_checks})
        self.assertEqual(material_profiles, ("materials",))
        self.assertNotIn("soffice", {check["key"] for check in doctor.CHECKS})
        self.assertIn("pymupdf", {check["key"] for check in material_checks})
        self.assertNotIn("pptx-extractor", {check["key"] for check in material_checks})
        self.assertNotIn("node-pty", {check["key"] for check in material_checks})

    def test_missing_pdf_tools_do_not_block_pptx_read_or_editor(self):
        def fake_probe(check):
            return (False, "未安装 PDF 依赖") if check["key"] == "pymupdf" else (True, "ok")

        with mock.patch.object(doctor, "do_probe", side_effect=fake_probe):
            editor = doctor.dependency_snapshot(["editor-core"])
            pptx_read = doctor.dependency_snapshot(["pptx-read"])
            materials = doctor.dependency_snapshot(["materials"])

        self.assertTrue(editor["ready"])
        self.assertTrue(pptx_read["ready"])
        self.assertFalse(materials["ready"])
        self.assertEqual(materials["profiles"]["materials"]["state"], "repairable")

    def test_missing_agent_cli_does_not_block_editor_core_but_blocks_dev_shell(self):
        def fake_probe(check):
            if check["key"] == "agent-cli":
                return False, "未找到 Agent CLI"
            return True, "ok"

        with mock.patch.object(doctor, "do_probe", side_effect=fake_probe):
            editor = doctor.dependency_snapshot(["editor-core"])
            dev_shell = doctor.dependency_snapshot(["dev-shell"])

        self.assertTrue(editor["ready"])
        self.assertFalse(dev_shell["ready"])
        self.assertEqual(
            dev_shell["profiles"]["dev-shell"]["state"],
            "manual-action-required",
        )

    def test_windows_standard_install_locations_find_chrome(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chrome = root / "Google" / "Chrome" / "Application" / "chrome.exe"
            chrome.parent.mkdir(parents=True)
            chrome.touch()
            environment = {"PROGRAMFILES": directory, "PROGRAMFILES(X86)": "", "LOCALAPPDATA": ""}
            with mock.patch.object(doctor.sys, "platform", "win32"), \
                    mock.patch.dict(os.environ, environment, clear=False), \
                    mock.patch.object(doctor.shutil, "which", return_value=None):
                self.assertEqual(doctor.probe_chrome(), (True, str(chrome)))

    def test_windows_any_supported_agent_satisfies_editor_dependency(self):
        def which(name):
            return r"C:\Users\tester\AppData\Roaming\npm\claude.cmd" if name == "claude.cmd" else None

        with mock.patch.object(doctor.sys, "platform", "win32"), \
                mock.patch.object(doctor.shutil, "which", side_effect=which):
            ready, detail = doctor.probe_agent_cli()
        self.assertTrue(ready)
        self.assertIn("Claude Code", detail)

    def test_windows_doctor_recognizes_configured_wsl_codex(self):
        settings = {
            "codexRuntime": "wsl",
            "wslDistribution": "Ubuntu-26.04",
            "wslUser": "root",
        }
        commands = []

        def fake_run(command, **_kwargs):
            commands.append(command)
            stdout = "/usr/local/bin/codex\n" if "command -v codex" in command else "codex-cli 0.146.0\n"
            return doctor.subprocess.CompletedProcess(command, 0, stdout, "")

        with mock.patch.object(doctor.sys, "platform", "win32"), \
                mock.patch.object(doctor, "load_agent_runtime_settings", return_value=settings), \
                mock.patch.object(doctor, "run", side_effect=fake_run), \
                mock.patch.object(doctor.shutil, "which", return_value=None):
            ready, detail = doctor.probe_agent_cli()
        self.assertTrue(ready)
        self.assertIn("WSL Ubuntu-26.04/root", detail)
        self.assertIn("codex-cli 0.146.0", detail)
        self.assertEqual(commands[1][-2:], ["/usr/local/bin/codex", "--version"])

    def test_configured_wsl_codex_failure_is_not_hidden_by_other_agent(self):
        settings = {
            "codexRuntime": "wsl",
            "wslDistribution": "Ubuntu-26.04",
            "wslUser": "root",
        }

        def which(name):
            return r"C:\Tools\claude.cmd" if name == "claude.cmd" else None

        failure = doctor.subprocess.CompletedProcess(
            ["wsl.exe"], 1, "", "找不到具有所提供名称的分发版"
        )
        with mock.patch.object(doctor.sys, "platform", "win32"), \
                mock.patch.object(doctor, "load_agent_runtime_settings", return_value=settings), \
                mock.patch.object(doctor, "run", return_value=failure), \
                mock.patch.object(doctor.shutil, "which", side_effect=which):
            ready, detail = doctor.probe_agent_cli()
        self.assertFalse(ready)
        self.assertIn("Ubuntu-26.04/root", detail)
        self.assertIn("Claude Code", detail)

    def test_windows_agent_is_found_in_user_npm_bin_when_path_is_incomplete(self):
        with tempfile.TemporaryDirectory() as directory:
            appdata = Path(directory)
            npm = appdata / "npm"
            npm.mkdir()
            claude = npm / "claude.cmd"
            claude.touch()
            with mock.patch.object(doctor.sys, "platform", "win32"), \
                    mock.patch.dict(os.environ, {
                        "APPDATA": str(appdata), "LOCALAPPDATA": "",
                        "USERPROFILE": "", "SystemDrive": str(appdata),
                    }, clear=False), \
                    mock.patch.object(doctor.shutil, "which", return_value=None):
                ready, detail = doctor.probe_agent_cli()
        self.assertTrue(ready)
        self.assertIn(str(claude), detail)

    def test_unencodable_status_symbol_has_ascii_fallback(self):
        fake_stdout = type("FakeStdout", (), {"encoding": "ascii"})()
        with mock.patch.object(doctor.sys, "stdout", fake_stdout):
            self.assertEqual(doctor._symbol("✓", "+"), "+")

    def test_python_module_probe_explains_incompatible_architecture(self):
        failure = doctor.subprocess.CompletedProcess(
            [doctor.sys.executable, "-c", "import pptx"],
            1,
            "",
            "ImportError: incompatible architecture (have 'arm64', need 'x86_64')",
        )
        with mock.patch.object(doctor, "run", return_value=failure):
            ready, detail = doctor.probe_pymod("pptx")()
        self.assertFalse(ready)
        self.assertEqual(detail, "已安装但架构不兼容（扩展 arm64，Editor Python x86_64）")



if __name__ == "__main__":
    unittest.main()
