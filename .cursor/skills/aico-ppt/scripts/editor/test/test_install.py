import importlib.util
import contextlib
import io
import json
import shutil
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "aico_ppt_install", ROOT / "scripts" / "install.py"
)
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallationManagerTest(unittest.TestCase):
    def test_registered_skill_can_edit_and_verify_all_templates_without_harness(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            manager = self.make_manager(ROOT, home)
            manager.apply(manager.plan("install"))
            target = home / ".agents/skills/aico-ppt"
            code = r"""
import importlib.util, re, sys
spec = importlib.util.spec_from_file_location('eb', sys.argv[1])
eb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(eb)
lines = eb.load(sys.argv[2])
source = eb.get_template(lines)
modified, count = re.subn(r'(<h2\b[^>]*>)[^<]*(</h2>)', r'\1独立 Skill 回归\2', source, count=1)
assert count == 1
eb.set_template(lines, modified)
eb.save(sys.argv[2], lines)
eb.verify(sys.argv[2])
assert eb.get_template(eb.load(sys.argv[2])) == modified
"""
            for template in ("training-deck.html", "tech-share-deck.html", "work-report-deck.html"):
                with self.subTest(template=template):
                    original = target / "assets" / template
                    before = original.read_bytes()
                    output = home / template
                    shutil.copyfile(original, output)
                    result = subprocess.run([
                        sys.executable, "-c", code, str(target / "scripts/edit-bundle.py"), str(output),
                    ], cwd=home, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertNotEqual(output.read_bytes(), before)
                    self.assertEqual(original.read_bytes(), before)

    def test_default_cli_installs_and_repairs_skill_without_editor_or_agent_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            shared = ["--root", str(ROOT), "--home", str(home),
                      "--state-file", str(home / "install-state.json"), "--json"]
            with patch.object(installer, "_load_doctor", side_effect=AssertionError(
                "独立 Skill 安装不得加载 Editor 或 Agent 依赖检查"
            )):
                for operation in ("install", "inspect", "repair"):
                    with self.subTest(operation=operation), contextlib.redirect_stdout(io.StringIO()) as output:
                        self.assertEqual(installer.main([operation, *shared]), 0)
                        self.assertNotIn("environment", json.loads(output.getvalue()))
                target = home / ".agents/skills/aico-ppt"
                self.assertEqual(target.resolve(), ROOT.resolve())
                for relative in ("SKILL.md", "references/workflow.md", "scripts/edit-bundle.py",
                                 "scripts/deck-editor.py", "assets/training-deck.html",
                                 "assets/tech-share-deck.html", "assets/work-report-deck.html"):
                    self.assertTrue((target / relative).is_file(), relative)
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(installer.main(["install", "--skill-only", *shared]), 0)
                    self.assertEqual(installer.main(["uninstall", *shared]), 0)
                self.assertFalse(target.exists())
                self.assertTrue((ROOT / "SKILL.md").is_file())

    def test_dev_shell_dependency_check_requires_explicit_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            with patch.object(installer, "_load_doctor") as load_doctor:
                doctor = load_doctor.return_value
                doctor.repair_dependencies.return_value = {"ready":True}
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(installer.main([
                        "install", "--dev-shell", "--json", "--root", str(ROOT),
                        "--home", str(home), "--state-file", str(home / "state.json"),
                    ]), 0)
                doctor.repair_dependencies.assert_called_once_with(["dev-shell"], capture_output=True)

    def make_manager(self, root, home, *, hosts=("codex",)):
        return installer.InstallationManager(
            root=root,
            home=home,
            hosts=hosts,
            state_file=home / "state" / "install-state.json",
            platform="darwin",
        )

    def test_install_is_idempotent_and_records_owned_link(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "repo"
            home = base / "home"
            root.mkdir()
            (root / "SKILL.md").write_text("---\nname: aico-ppt\n---\n", encoding="utf-8")
            manager = self.make_manager(root, home)

            first = manager.apply(manager.plan("install"))
            second = manager.apply(manager.plan("repair"))

            target = home / ".agents" / "skills" / "aico-ppt"
            self.assertTrue(target.is_symlink())
            self.assertEqual(target.resolve(), root.resolve())
            self.assertTrue(first["snapshot"]["ready"])
            self.assertTrue(second["snapshot"]["ready"])
            record = json.loads((home / "state" / "install-state.json").read_text("utf-8"))
            self.assertEqual(record["ownedPaths"], [str(manager.target_for("codex"))])

    def test_install_atomically_migrates_managed_legacy_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "repo"
            home = base / "home"
            root.mkdir()
            (root / "SKILL.md").write_text("---\nname: aico-ppt\n---\n", encoding="utf-8")
            legacy_target = home / ".agents" / "skills" / "huawei-deck"
            legacy_target.parent.mkdir(parents=True)
            legacy_target.symlink_to(root, target_is_directory=True)
            legacy_state = installer.legacy_state_file(platform="darwin", home=home)
            legacy_state.parent.mkdir(parents=True)
            legacy_state.write_text(json.dumps({
                "schemaVersion":installer.SCHEMA_VERSION,
                "installId":"legacy-install",
                "channel":"developer",
                "productVersion":"0.1.0-dev",
                "installRoot":str(root.resolve()),
                "registrations":[{
                    "host":"codex", "targetPath":str(legacy_target), "method":"symlink",
                }],
                "ownedPaths":[str(legacy_target)],
                "installedAt":"2026-08-01T00:00:00+00:00",
                "updatedAt":"2026-08-01T00:00:00+00:00",
            }), encoding="utf-8")
            manager = installer.InstallationManager(
                root=root, home=home, hosts=("codex",), platform="darwin",
            )

            result = manager.apply(manager.plan("install"))

            current_target = home / ".agents" / "skills" / "aico-ppt"
            self.assertTrue(result["snapshot"]["ready"])
            self.assertTrue(current_target.is_symlink())
            self.assertEqual(current_target.resolve(), root.resolve())
            self.assertFalse(legacy_target.exists())
            self.assertFalse(legacy_state.exists())
            current_state = installer.default_state_file(platform="darwin", home=home)
            record = json.loads(current_state.read_text("utf-8"))
            self.assertEqual(record["installId"], "legacy-install")
            self.assertEqual(record["ownedPaths"], [str(manager.target_for("codex"))])

    def test_unknown_existing_target_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "repo"
            home = base / "home"
            root.mkdir()
            (root / "SKILL.md").write_text("skill", encoding="utf-8")
            target = home / ".agents" / "skills" / "aico-ppt"
            target.mkdir(parents=True)
            (target / "user-file.txt").write_text("keep", encoding="utf-8")
            manager = self.make_manager(root, home)

            with self.assertRaises(installer.InstallError) as raised:
                manager.plan("install")

            self.assertEqual(raised.exception.code, "INSTALL_TARGET_OCCUPIED")
            self.assertEqual((target / "user-file.txt").read_text("utf-8"), "keep")

    def test_matching_unmanaged_link_requires_explicit_adoption(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "repo"
            home = base / "home"
            root.mkdir()
            (root / "SKILL.md").write_text("skill", encoding="utf-8")
            target = home / ".agents" / "skills" / "aico-ppt"
            target.parent.mkdir(parents=True)
            target.symlink_to(root, target_is_directory=True)
            manager = self.make_manager(root, home)

            snapshot = manager.inspect()
            self.assertFalse(snapshot["ready"])
            self.assertEqual(snapshot["state"], "manual-action-required")
            self.assertEqual(snapshot["registrations"][0]["state"], "adoption-required")
            self.assertFalse(snapshot["registrations"][0]["managed"])
            with self.assertRaises(installer.InstallError) as raised:
                manager.plan("install")
            self.assertEqual(raised.exception.code, "INSTALL_ADOPTION_REQUIRED")
            self.assertFalse((home / "state" / "install-state.json").exists())

            result = manager.apply(manager.plan("install", adopt_existing=True))

            self.assertTrue(result["snapshot"]["ready"])
            self.assertTrue(result["snapshot"]["registrations"][0]["managed"])
            record = json.loads((home / "state" / "install-state.json").read_text("utf-8"))
            self.assertEqual(record["ownedPaths"], [str(manager.target_for("codex"))])

    def test_uninstall_only_removes_recorded_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "repo"
            home = base / "home"
            root.mkdir()
            (root / "SKILL.md").write_text("skill", encoding="utf-8")
            manager = self.make_manager(root, home)
            manager.apply(manager.plan("install"))

            result = manager.apply(manager.plan("uninstall"))

            target = home / ".agents" / "skills" / "aico-ppt"
            self.assertFalse(target.exists())
            self.assertFalse((home / "state" / "install-state.json").exists())
            self.assertEqual(result["status"], "uninstalled")
            self.assertTrue(root.exists())

    def test_uninstall_does_not_remove_registration_missing_from_owned_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "repo"
            home = base / "home"
            root.mkdir()
            (root / "SKILL.md").write_text("skill", encoding="utf-8")
            manager = self.make_manager(root, home)
            target = manager.target_for("codex")
            target.parent.mkdir(parents=True)
            target.symlink_to(root, target_is_directory=True)
            manager.state_file.parent.mkdir(parents=True)
            manager.state_file.write_text(json.dumps({
                "schemaVersion":installer.SCHEMA_VERSION,
                "installRoot":str(root.resolve()),
                "registrations":[{
                    "host":"codex", "targetPath":str(target), "method":"symlink",
                }],
                "ownedPaths":[],
            }), encoding="utf-8")

            manager.apply(manager.plan("uninstall"))

            self.assertTrue(target.is_symlink())
            self.assertEqual(target.resolve(), root.resolve())
            self.assertFalse(manager.state_file.exists())

    def test_uninstall_refuses_changed_target(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "repo"
            other = base / "other"
            home = base / "home"
            root.mkdir()
            other.mkdir()
            (root / "SKILL.md").write_text("skill", encoding="utf-8")
            manager = self.make_manager(root, home)
            manager.apply(manager.plan("install"))
            target = home / ".agents" / "skills" / "aico-ppt"
            target.unlink()
            target.symlink_to(other, target_is_directory=True)

            with self.assertRaises(installer.InstallError) as raised:
                manager.plan("uninstall")

            self.assertEqual(raised.exception.code, "UNINSTALL_TARGET_CHANGED")
            self.assertEqual(target.resolve(), other.resolve())

    def test_uninstall_failure_restores_removed_registrations_and_state(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "repo"
            home = base / "home"
            root.mkdir()
            (root / "SKILL.md").write_text("skill", encoding="utf-8")
            manager = self.make_manager(root, home, hosts=("codex", "claude-code"))
            manager.apply(manager.plan("install"))
            state_before = (home / "state" / "install-state.json").read_bytes()
            targets = [manager.target_for(host) for host in ("codex", "claude-code")]
            original_remove = installer._remove_registration
            removals = 0

            def fail_second_removal(target, method):
                nonlocal removals
                removals += 1
                if removals == 2:
                    raise OSError("模拟第二个注册项删除失败")
                original_remove(target, method)

            with patch.object(installer, "_remove_registration", side_effect=fail_second_removal):
                with self.assertRaises(OSError):
                    manager.apply(manager.plan("uninstall"))

            self.assertEqual((home / "state" / "install-state.json").read_bytes(), state_before)
            for target in targets:
                self.assertTrue(target.is_symlink())
                self.assertEqual(target.resolve(), root.resolve())


if __name__ == "__main__":
    unittest.main()
