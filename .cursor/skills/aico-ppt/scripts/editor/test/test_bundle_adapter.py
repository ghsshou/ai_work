import hashlib
import importlib.util
import inspect
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock


if os.name == "nt":
    raise unittest.SkipTest("bundle_adapter 的 POSIX dirfd 故障注入仅在 POSIX 运行")


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "bundle_adapter", ROOT / "scripts/editor/bundle_adapter.py"
)
bundle_adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle_adapter)


def minimal_bundle(path, template=None):
    if template is None:
        template = '<!doctype html><body><div class="stage"></div></body>'
    path.write_text(
        '<script type="__bundler/manifest">\n{}\n</script>\n'
        '<script type="__bundler/template">\n'
        + json.dumps(template)
        + "\n</script>",
        encoding="utf-8",
    )


def sidecar_session(deck):
    return deck.parent / ".aico-ppt-editor" / "deck-session"


def directory_identity(path):
    info = path.stat()
    return {
        "path": str(path),
        "realPath": str(path.resolve(strict=True)),
        "dev": str(info.st_dev),
        "ino": str(info.st_ino),
    }


class BundleAdapterTest(unittest.TestCase):
    def test_saved_patches_wait_for_stable_canvas_structure_before_apply(self):
        block = bundle_adapter._block([{"kind": "setText"}])

        self.assertIn("deckEditorApplyWhenStable", block)
        self.assertIn("section?.outerHTML", block)
        self.assertIn("setTimeout(check,100)", block)
        self.assertNotIn(
            ";window.HuaweiDeckPatchRuntime.applyAll?.(JSON.parse(document."
            'getElementById("huawei-deck-editor-patches").textContent));',
            block,
        )

    def test_write_is_idempotent_and_backup_is_exact(self):
        with tempfile.TemporaryDirectory() as td:
            deck = Path(td) / "deck.html"
            minimal_bundle(deck)
            original = hashlib.sha256(deck.read_bytes()).hexdigest()

            result = bundle_adapter.write_patches(
                deck, [{"kind": "setText"}], sidecar_session(deck)
            )
            first = deck.read_text(encoding="utf-8")
            bundle_adapter.write_patches(
                deck, [{"kind": "setText"}], sidecar_session(deck)
            )

            self.assertEqual(first, deck.read_text(encoding="utf-8"))
            self.assertEqual(
                f"deck-{original}.html",
                Path(result["backup"]).name,
            )
            self.assertEqual(
                original,
                hashlib.sha256(Path(result["backup"]).read_bytes()).hexdigest(),
            )

    def test_verification_failure_keeps_original(self):
        with tempfile.TemporaryDirectory() as td:
            deck = Path(td) / "deck.html"
            minimal_bundle(deck)
            original = deck.read_bytes()

            with mock.patch.object(
                bundle_adapter.eb,
                "verify",
                side_effect=AssertionError("bad"),
            ):
                with self.assertRaises(AssertionError):
                    bundle_adapter.write_patches(deck, [], sidecar_session(deck))

            self.assertEqual(original, deck.read_bytes())
            self.assertEqual([], list(deck.parent.glob(f".{deck.name}.*.tmp")))

    def test_invalid_body_insert_points_are_rejected(self):
        cases = {
            "缺失 body 结束标签": "<!doctype html><body></bodyx>",
            "多个 body 结束标签": "<body></body><body></body>",
        }
        for name, template in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as td:
                deck = Path(td) / "deck.html"
                minimal_bundle(deck, template)
                original = deck.read_bytes()

                with self.assertRaisesRegex(ValueError, "必须恰好包含一个"):
                    bundle_adapter.write_patches(deck, [], sidecar_session(deck))

                self.assertEqual(original, deck.read_bytes())

    def test_invalid_marker_shapes_are_rejected(self):
        begin = bundle_adapter.BEGIN
        end = bundle_adapter.END
        cases = {
            "仅 begin": f"<body>{begin}</body>",
            "仅 end": f"<body>{end}</body>",
            "重复 begin": f"<body>{begin}{begin}{end}</body>",
            "重复 end": f"<body>{begin}{end}{end}</body>",
            "逆序": f"<body>{end}{begin}</body>",
        }
        for name, template in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as td:
                deck = Path(td) / "deck.html"
                minimal_bundle(deck, template)
                original = deck.read_bytes()

                with self.assertRaisesRegex(ValueError, "补丁标记"):
                    bundle_adapter.write_patches(deck, [], sidecar_session(deck))

                self.assertEqual(original, deck.read_bytes())

    def test_corrupt_existing_backup_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            deck = Path(td) / "deck.html"
            minimal_bundle(deck)
            original = deck.read_bytes()
            digest = hashlib.sha256(original).hexdigest()
            backups = sidecar_session(deck) / "backups"
            backups.mkdir(parents=True)
            backup = backups / f"deck-{digest}.html"
            backup.write_bytes(b"corrupt")

            with self.assertRaisesRegex(RuntimeError, "备份"):
                bundle_adapter.write_patches(deck, [], sidecar_session(deck))

            self.assertEqual(original, deck.read_bytes())
            self.assertEqual(b"corrupt", backup.read_bytes())

    def test_existing_backup_directory_fsync_failure_blocks_record(self):
        with tempfile.TemporaryDirectory() as td:
            backups = Path(td) / "backups"
            backups.mkdir()
            original = b"stable-deck"
            digest = hashlib.sha256(original).hexdigest()
            name = f"deck-{digest}.html"
            (backups / name).write_bytes(original)
            backup_identity = directory_identity(backups)
            real_fsync = bundle_adapter.os.fsync

            def fail_directory_fsync(fd):
                if stat.S_ISDIR(os.fstat(fd).st_mode):
                    raise OSError("injected existing backup directory fsync failure")
                return real_fsync(fd)

            with mock.patch.object(
                bundle_adapter.os, "fsync", side_effect=fail_directory_fsync
            ):
                with self.assertRaisesRegex(
                    OSError, "existing backup directory fsync failure"
                ):
                    bundle_adapter._ensure_backup(
                        backups, name, original, digest, backup_identity
                    )

    def test_existing_backup_symlink_is_rejected_even_when_target_matches(self):
        with tempfile.TemporaryDirectory() as td:
            deck = Path(td) / "deck.html"
            minimal_bundle(deck)
            original = deck.read_bytes()
            digest = hashlib.sha256(original).hexdigest()
            backups = sidecar_session(deck) / "backups"
            backups.mkdir(parents=True)
            outside = Path(td) / "outside-backup.html"
            outside.write_bytes(original)
            (backups / f"deck-{digest}.html").symlink_to(outside)

            with self.assertRaisesRegex(RuntimeError, "符号链接|常规文件|备份"):
                bundle_adapter.write_patches(deck, [], sidecar_session(deck))

            self.assertEqual(original, deck.read_bytes())
            self.assertEqual(original, outside.read_bytes())

    def test_backup_directory_symlink_cannot_write_outside_session(self):
        with tempfile.TemporaryDirectory() as td:
            deck = Path(td) / "deck.html"
            minimal_bundle(deck)
            original = deck.read_bytes()
            session = sidecar_session(deck)
            session.mkdir(parents=True)
            outside = Path(td) / "outside-backups"
            outside.mkdir()
            (session / "backups").symlink_to(outside, target_is_directory=True)

            result = bundle_adapter.write_patches_safe(deck, [], session)

            self.assertEqual(False, result["ok"])
            self.assertEqual("WRITE_FAILED", result["code"])
            self.assertEqual(original, deck.read_bytes())
            self.assertEqual([], list(outside.iterdir()))

    def test_sidecar_root_or_session_symlink_cannot_write_outside_project(self):
        for level in ("root", "session"):
            with self.subTest(level=level), tempfile.TemporaryDirectory() as td:
                project = Path(td) / "project"
                project.mkdir()
                deck = project / "deck.html"
                minimal_bundle(deck)
                original = deck.read_bytes()
                outside = Path(td) / "outside"
                outside.mkdir()
                sidecar_root = project / ".aico-ppt-editor"
                session = sidecar_root / "deck-session"
                if level == "root":
                    sidecar_root.symlink_to(outside, target_is_directory=True)
                else:
                    sidecar_root.mkdir()
                    session.symlink_to(outside, target_is_directory=True)

                result = bundle_adapter.write_patches_safe(deck, [], session)

                self.assertEqual(False, result["ok"])
                self.assertEqual("WRITE_FAILED", result["code"])
                self.assertEqual(original, deck.read_bytes())
                self.assertEqual([], list(outside.iterdir()))

    def test_runtime_sidecar_identity_replacement_is_rejected_before_any_write(self):
        self.assertIn(
            "sidecar_identity",
            inspect.signature(bundle_adapter.write_patches_safe).parameters,
            "adapter 必须接收 server 启动时捕获的 sidecar identity",
        )
        for level in ("root", "session"):
            with self.subTest(level=level), tempfile.TemporaryDirectory() as td:
                project = Path(td) / "project"
                project.mkdir()
                deck = project / "deck.html"
                minimal_bundle(deck)
                original = deck.read_bytes()
                root = project / ".aico-ppt-editor"
                session = root / "deck-session"
                backups = session / "backups"
                transactions = session / "transactions"
                backups.mkdir(parents=True)
                transactions.mkdir()
                identity = {
                    "root": directory_identity(root),
                    "session": directory_identity(session),
                    "backups": directory_identity(backups),
                    "transactions": directory_identity(transactions),
                }
                target = root if level == "root" else session
                target.rename(target.with_name(f"{target.name}.trusted-original"))
                if level == "root":
                    root.mkdir()
                replacement_session = root / "deck-session"
                (replacement_session / "backups").mkdir(parents=True)
                (replacement_session / "transactions").mkdir()

                result = bundle_adapter.write_patches_safe(
                    deck, [], session, sidecar_identity=identity
                )

                self.assertEqual(False, result["ok"])
                self.assertEqual(original, deck.read_bytes())
                self.assertEqual([], list((replacement_session / "backups").iterdir()))
                self.assertEqual(
                    [], list((replacement_session / "transactions").iterdir())
                )

    def test_success_persists_deck_bound_durable_transaction_record(self):
        with tempfile.TemporaryDirectory() as td:
            project = Path(td) / "project"
            project.mkdir()
            deck = project / "deck.html"
            minimal_bundle(deck)
            original_fingerprint = hashlib.sha256(deck.read_bytes()).hexdigest()
            session = project / ".aico-ppt-editor" / "deck-session"
            transaction_id = "123e4567-e89b-42d3-a456-426614174000"
            session_id = "223e4567-e89b-42d3-a456-426614174000"

            result = bundle_adapter.write_patches(
                deck,
                [],
                session,
                expected_fingerprint=original_fingerprint,
                transaction_id=transaction_id,
                session_id=session_id,
            )

            transaction = session / "transactions" / f"{transaction_id}.json"
            record = json.loads(transaction.read_text(encoding="utf-8"))
            self.assertEqual(transaction_id, record["transactionId"])
            self.assertEqual(session_id, record["sessionId"])
            self.assertEqual(str(deck), record["deckPath"])
            self.assertEqual(str(session), record["sessionDir"])
            self.assertEqual(original_fingerprint, record["oldFingerprint"])
            self.assertEqual(result["fingerprint"], record["candidateFingerprint"])
            self.assertEqual(result["backup"], record["backup"])
            self.assertEqual(str(transaction), result["transaction"])

    def test_external_change_before_replace_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            deck = Path(td) / "deck.html"
            minimal_bundle(deck)
            external = b"external change"
            original_verify = bundle_adapter.eb.verify

            def verify_then_change(path):
                original_verify(path)
                deck.write_bytes(external)

            with mock.patch.object(
                bundle_adapter.eb,
                "verify",
                side_effect=verify_then_change,
            ):
                with self.assertRaisesRegex(RuntimeError, "写入期间"):
                    bundle_adapter.write_patches(deck, [], sidecar_session(deck))

            self.assertEqual(external, deck.read_bytes())
            self.assertEqual([], list(deck.parent.glob(f".{deck.name}.*.tmp")))

    def test_safe_verify_failure_has_stable_stage_and_diagnostic(self):
        with tempfile.TemporaryDirectory() as td:
            deck = Path(td) / "deck.html"
            session = sidecar_session(deck)
            minimal_bundle(deck)
            original = deck.read_bytes()

            with mock.patch.object(
                bundle_adapter.eb,
                "verify",
                side_effect=AssertionError("verify exploded"),
            ):
                result = bundle_adapter.write_patches_safe(deck, [], session)

            self.assertEqual(False, result["ok"])
            self.assertEqual("VERIFY_FAILED", result["code"])
            self.assertEqual("verify", result["stage"])
            self.assertIn("重试", result["recovery"])
            self.assertTrue((session / result["diagnostic"]).is_file())
            self.assertTrue((session / result["candidate"]).is_file())
            self.assertEqual("write-errors", (session / result["candidate"]).parent.name)
            diagnostic = json.loads(
                (session / result["diagnostic"]).read_text(encoding="utf-8")
            )
            self.assertEqual(result["candidate"], diagnostic["candidate"])
            self.assertEqual(original, deck.read_bytes())

    def test_write_errors_symlink_cannot_emit_diagnostics_outside_session(self):
        with tempfile.TemporaryDirectory() as td:
            deck = Path(td) / "deck.html"
            session = sidecar_session(deck)
            outside = Path(td) / "outside-errors"
            minimal_bundle(deck)
            session.mkdir(parents=True)
            outside.mkdir()
            (session / "write-errors").symlink_to(outside, target_is_directory=True)

            with mock.patch.object(
                bundle_adapter.eb,
                "verify",
                side_effect=AssertionError("verify exploded"),
            ):
                result = bundle_adapter.write_patches_safe(deck, [], session)

            self.assertEqual(False, result["ok"])
            self.assertEqual("VERIFY_FAILED", result["code"])
            self.assertNotIn("diagnostic", result)
            self.assertNotIn("candidate", result)
            self.assertEqual([], list(outside.iterdir()))

    def test_write_errors_identity_swap_between_guard_and_open_writes_nothing(self):
        with tempfile.TemporaryDirectory() as td:
            project = Path(td) / "project"
            project.mkdir()
            deck = project / "deck.html"
            minimal_bundle(deck)
            original = deck.read_bytes()
            root = project / ".aico-ppt-editor"
            session = root / "deck-session"
            backups = session / "backups"
            transactions = session / "transactions"
            write_errors = session / "write-errors"
            backups.mkdir(parents=True)
            transactions.mkdir()
            write_errors.mkdir()
            identity = {
                "root": directory_identity(root),
                "session": directory_identity(session),
                "backups": directory_identity(backups),
                "transactions": directory_identity(transactions),
                "writeErrors": directory_identity(write_errors),
            }
            trusted_root = root.with_name(f"{root.name}.trusted-original")
            replacement_errors = session / "write-errors"
            swapped = False

            original_require = bundle_adapter._require_identity

            def require_then_swap(current_identity, name, path):
                nonlocal swapped
                result = original_require(current_identity, name, path)
                if name == "writeErrors" and not swapped:
                    swapped = True
                    root.rename(trusted_root)
                    replacement_errors.mkdir(parents=True)
                    (session / "backups").mkdir()
                    (session / "transactions").mkdir()
                return result

            with mock.patch.object(
                bundle_adapter.eb,
                "verify",
                side_effect=AssertionError("verify exploded"),
            ), mock.patch.object(
                bundle_adapter,
                "_require_identity",
                side_effect=require_then_swap,
            ):
                result = bundle_adapter.write_patches_safe(
                    deck, [], session, sidecar_identity=identity
                )

            self.assertEqual(False, result["ok"])
            self.assertNotIn("diagnostic", result)
            self.assertNotIn("candidate", result)
            self.assertEqual([], list(replacement_errors.iterdir()))
            self.assertEqual(original, deck.read_bytes())

    def test_expected_fingerprint_mismatch_is_conflict_without_write(self):
        with tempfile.TemporaryDirectory() as td:
            deck = Path(td) / "deck.html"
            session = sidecar_session(deck)
            minimal_bundle(deck)
            original = deck.read_bytes()

            result = bundle_adapter.write_patches_safe(
                deck, [], session, expected_fingerprint="0" * 64
            )

            self.assertEqual("DECK_CHANGED", result["code"])
            self.assertEqual("read", result["stage"])
            self.assertEqual(original, deck.read_bytes())
            self.assertEqual([], list((session / "backups").glob("*.html")))

    def test_atomic_replace_failure_keeps_original_and_reports_write_stage(self):
        with tempfile.TemporaryDirectory() as td:
            deck = Path(td) / "deck.html"
            session = sidecar_session(deck)
            minimal_bundle(deck)
            original = deck.read_bytes()

            with mock.patch.object(
                bundle_adapter.os,
                "replace",
                side_effect=OSError("replace denied"),
            ):
                result = bundle_adapter.write_patches_safe(deck, [], session)

            self.assertEqual("WRITE_FAILED", result["code"])
            self.assertEqual("replace", result["stage"])
            self.assertEqual(original, deck.read_bytes())
            self.assertEqual([], list(deck.parent.glob(f".{deck.name}.*.tmp")))
            self.assertTrue((session / result["candidate"]).is_file())
            self.assertEqual("write-errors", (session / result["candidate"]).parent.name)
