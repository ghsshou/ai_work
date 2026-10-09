import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
WINDOWS_LAUNCHER = ROOT / "tools/dev-shell/AICO-PPT Dev Shell.cmd"
WINDOWS_ICON = ROOT / "assets/launcher/aico-ppt-editor.ico"
WINDOWS_SHORTCUT_SCRIPT = ROOT / "scripts/create_windows_launcher_shortcut.ps1"


class WindowsLauncherTest(unittest.TestCase):
    def test_windows_launcher_uses_only_crlf_line_endings(self):
        contents = WINDOWS_LAUNCHER.read_bytes()

        self.assertNotIn(
            b"\n",
            contents.replace(b"\r\n", b""),
            "Windows CMD 启动器不能混用 LF 与 CRLF，否则中文分支可能被误解析",
        )
        self.assertTrue(contents.endswith(b"\r\n"))

    def test_windows_launcher_points_to_unified_python_entry(self):
        contents = WINDOWS_LAUNCHER.read_text(encoding="utf-8")

        self.assertIn(r"%CD%\scripts\deck-editor.py", contents)
        self.assertIn("--app", contents)
        self.assertIn("--detach-windows", contents)
        self.assertIn("%*", contents)
        self.assertNotIn("/min", contents)
        self.assertNotIn('start "AICO-PPT 编辑器"', contents)
        for executable in ("py.exe", "python.exe"):
            self.assertIn(executable, contents)
        self.assertIn('pushd "%~dp0..\\.."', contents)

    def test_windows_launcher_installs_a_local_branded_shortcut(self):
        contents = WINDOWS_LAUNCHER.read_text(encoding="utf-8")
        shortcut_bytes = WINDOWS_SHORTCUT_SCRIPT.read_bytes()
        shortcut_script = shortcut_bytes.decode("utf-8-sig")

        self.assertIn(r"scripts\create_windows_launcher_shortcut.ps1", contents)
        self.assertTrue(
            shortcut_bytes.startswith(b"\xef\xbb\xbf"),
            "Windows PowerShell 5.1 需要 UTF-8 BOM 才能稳定解析中文路径",
        )
        self.assertIn("CreateShortcut", shortcut_script)
        self.assertIn('Join-Path $repositoryRoot "tools/dev-shell"', shortcut_script)
        self.assertIn('Join-Path $devShellRoot "AICO-PPT Dev Shell.cmd"', shortcut_script)
        self.assertIn('Join-Path $devShellRoot "AICO-PPT Dev Shell（Windows）.lnk"', shortcut_script)
        self.assertIn("assets/launcher/aico-ppt-editor.ico", shortcut_script)
        self.assertIn("IconLocation", shortcut_script)
        self.assertEqual(WINDOWS_ICON.read_bytes()[:4], b"\x00\x00\x01\x00")

    def test_entry_documents_explain_the_windows_double_click_entry(self):
        for relative_path in (
            "SKILL.md",
            "references/editing-guide.md",
            "docs/architecture.md",
        ):
            with self.subTest(file=relative_path):
                contents = (ROOT / relative_path).read_text(encoding="utf-8")
                self.assertIn("tools/dev-shell/AICO-PPT Dev Shell.cmd", contents)
                self.assertIn("Windows", contents)


if __name__ == "__main__":
    unittest.main()
