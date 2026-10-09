import os
import unittest

if os.name == "nt":
    raise unittest.SkipTest("attachment_writer 的 dirfd/锁语义由 Windows sidecar 集成测试覆盖")

import fcntl
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from unittest import mock


EDITOR_DIR = Path(__file__).resolve().parents[1]
WRITER = EDITOR_DIR / "attachment_writer.py"
UPLOAD_ID = "11111111-1111-4111-8111-111111111111"
ATTACHMENT_ID = "22222222-2222-4222-8222-222222222222"
MAXIMUM_BYTES = 25 * 1024 * 1024


def identity(path):
    info = os.lstat(path)
    return {"path": str(path), "dev": str(info.st_dev), "ino": str(info.st_ino)}


class AttachmentWriterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(os.path.realpath(self.temporary.name))
        self.session = self.root / "session"
        self.attachments = self.session / "attachments"
        self.staging = self.attachments / ".staging"
        self.staging.mkdir(parents=True)
        self.config = {
            "session": identity(self.session),
            "attachments": identity(self.attachments),
            "attachmentStaging": identity(self.staging),
            "uploadId": UPLOAD_ID,
            "attachmentId": ATTACHMENT_ID,
            "suffix": ".png",
            "maximumBytes": MAXIMUM_BYTES,
        }

    def tearDown(self):
        self.temporary.cleanup()

    def run_writer(self, contents=b"png-data", config=None):
        completed = subprocess.run(
            [sys.executable, str(WRITER), "--config", json.dumps(config or self.config)],
            input=contents,
            capture_output=True,
            check=False,
        )
        try:
            result = json.loads(completed.stdout)
        except json.JSONDecodeError:
            result = None
        return completed, result

    def target(self):
        return self.staging / UPLOAD_ID / f"{ATTACHMENT_ID}.png"

    def start_writer(self):
        return subprocess.Popen(
            [sys.executable, str(WRITER), "--config", json.dumps(self.config)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def wait_for_target(self):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if self.target().exists():
                return
            time.sleep(0.005)
        self.fail("writer 未创建 staging target")

    def finish_writer(self, process):
        process.stdin.close()
        stdout = process.stdout.read()
        stderr = process.stderr.read()
        returncode = process.wait(timeout=2)
        process.stdout.close()
        process.stderr.close()
        return returncode, json.loads(stdout), stderr

    def test_streams_file_and_returns_bound_receipt(self):
        contents = b"\x89PNG\r\n" + os.urandom(4096)
        completed, result = self.run_writer(contents)
        self.assertEqual(completed.returncode, 0, completed.stderr.decode())
        self.assertTrue(result["ok"])
        self.assertEqual(result["uploadId"], UPLOAD_ID)
        self.assertEqual(result["attachmentId"], ATTACHMENT_ID)
        self.assertEqual(result["suffix"], ".png")
        self.assertEqual(result["path"], str(self.target()))
        self.assertEqual(result["size"], len(contents))
        self.assertEqual(result["sha256"], hashlib.sha256(contents).hexdigest())
        self.assertEqual(
            set(result["uploadIdentity"]),
            {"dev", "ino", "mountDev", "mountId"},
        )
        self.assertEqual(
            set(result["fileIdentity"]),
            {"dev", "ino", "mountDev", "mountId"},
        )
        self.assertEqual(result["uploadIdentity"]["ino"], str(self.target().parent.stat().st_ino))
        self.assertEqual(result["fileIdentity"]["ino"], str(self.target().stat().st_ino))
        self.assertEqual(self.target().read_bytes(), contents)

    def test_rejects_empty_and_oversized_streams_without_file(self):
        completed, result = self.run_writer(b"")
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(result["code"], "ATTACHMENT_EMPTY")
        self.assertFalse(self.target().exists())

        completed, result = self.run_writer(b"x" * (MAXIMUM_BYTES + 1))
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(result["code"], "ATTACHMENT_TOO_LARGE")
        self.assertFalse(self.target().exists())

    def test_rejects_noncanonical_config_and_caller_target_path(self):
        for replacement in (
            {"uploadId": "../outside"},
            {"attachmentId": "22222222-2222-3222-8222-222222222222"},
            {"suffix": ".tar.gz"},
            {"maximumBytes": MAXIMUM_BYTES + 1},
            {"targetPath": str(self.root / "outside")},
        ):
            config = {**self.config, **replacement}
            completed, result = self.run_writer(config=config)
            self.assertNotEqual(completed.returncode, 0, replacement)
            self.assertEqual(result["ok"], False, replacement)
        self.assertFalse((self.root / "outside").exists())

    def test_rejects_identity_mismatch_and_replaced_session(self):
        for key in ("session", "attachments", "attachmentStaging"):
            config = json.loads(json.dumps(self.config))
            config[key]["ino"] = str(int(config[key]["ino"]) + 1)
            completed, result = self.run_writer(config=config)
            self.assertNotEqual(completed.returncode, 0, key)
            self.assertEqual(result["code"], "UNSAFE_SIDECAR_IO")

        original = self.root / "original-session"
        self.session.rename(original)
        self.staging.mkdir(parents=True)
        completed, result = self.run_writer()
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(result["code"], "UNSAFE_SIDECAR_IO")
        self.assertEqual(list(self.staging.iterdir()), [])

    def test_rejects_symlink_ancestor_upload_and_existing_target(self):
        real_root = self.root / "real"
        real_session = real_root / "session"
        real_staging = real_session / "attachments" / ".staging"
        real_staging.mkdir(parents=True)
        linked_root = self.root / "linked"
        linked_root.symlink_to(real_root, target_is_directory=True)
        linked_config = {
            **self.config,
            "session": {**identity(real_session), "path": str(linked_root / "session")},
            "attachments": {
                **identity(real_session / "attachments"),
                "path": str(linked_root / "session" / "attachments"),
            },
            "attachmentStaging": {
                **identity(real_staging),
                "path": str(linked_root / "session" / "attachments" / ".staging"),
            },
        }
        completed, result = self.run_writer(config=linked_config)
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(result["code"], "UNSAFE_SIDECAR_IO")

        upload = self.staging / UPLOAD_ID
        upload.symlink_to(real_staging, target_is_directory=True)
        completed, result = self.run_writer()
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(result["code"], "UNSAFE_SIDECAR_IO")
        upload.unlink()

        upload.mkdir()
        target = self.target()
        target.write_bytes(b"existing")
        completed, result = self.run_writer(b"replacement")
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(result["code"], "ATTACHMENT_WRITE_FAILED")
        self.assertEqual(target.read_bytes(), b"existing")

    def test_mount_identity_mismatch_is_rejected(self):
        spec = importlib.util.spec_from_file_location("attachment_writer", WRITER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        read_fd, write_fd = os.pipe()
        os.write(write_fd, b"data")
        os.close(write_fd)
        original = module._mount_identity
        try:
            def mismatched_mount(fd):
                value = original(fd)
                info = os.fstat(fd)
                if info.st_ino == os.lstat(self.staging).st_ino:
                    return (value[0], f"{value[1]}-different")
                return value

            with mock.patch.object(module, "_mount_identity", side_effect=mismatched_mount):
                with self.assertRaises(module.AttachmentWriterError) as raised:
                    module.write_attachment(self.config, input_fd=read_fd)
            self.assertEqual(raised.exception.code, "UNSAFE_SIDECAR_IO")
            self.assertFalse(self.target().exists())
        finally:
            os.close(read_fd)

    def test_lifecycle_lock_competition_fails_without_staging_file(self):
        fd = os.open(self.attachments, os.O_RDONLY | os.O_DIRECTORY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            completed, result = self.run_writer(b"data")
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(result["code"], "ATTACHMENT_BUSY")
        self.assertFalse(self.target().exists())

    def test_rejects_session_path_replacement_while_streaming(self):
        process = self.start_writer()
        process.stdin.write(b"prefix")
        process.stdin.flush()
        self.wait_for_target()
        original = self.root / "held-session"
        self.session.rename(original)
        self.staging.mkdir(parents=True)
        process.stdin.write(b"suffix")
        returncode, result, stderr = self.finish_writer(process)
        self.assertNotEqual(returncode, 0, stderr.decode())
        self.assertEqual(result["code"], "UNSAFE_SIDECAR_IO")
        self.assertEqual(list(self.staging.iterdir()), [])
        old_upload = original / "attachments" / ".staging" / UPLOAD_ID
        self.assertFalse((old_upload / f"{ATTACHMENT_ID}.png").exists())

    def test_rejects_target_entry_replacement_without_unlinking_replacement(self):
        process = self.start_writer()
        process.stdin.write(b"prefix")
        process.stdin.flush()
        self.wait_for_target()
        self.target().unlink()
        self.target().write_bytes(b"forged")
        process.stdin.write(b"suffix")
        returncode, result, stderr = self.finish_writer(process)
        self.assertNotEqual(returncode, 0, stderr.decode())
        self.assertEqual(result["code"], "UNSAFE_SIDECAR_IO")
        self.assertIs(result["cleanupSafe"], False)
        self.assertEqual(self.target().read_bytes(), b"forged")

    def test_failure_cleanup_does_not_remove_replacement_upload_directory(self):
        process = self.start_writer()
        process.stdin.write(b"prefix")
        process.stdin.flush()
        self.wait_for_target()
        upload = self.staging / UPLOAD_ID
        moved = self.staging / "moved-upload"
        upload.rename(moved)
        upload.mkdir()
        process.stdin.write(b"suffix")
        returncode, result, stderr = self.finish_writer(process)
        self.assertNotEqual(returncode, 0, stderr.decode())
        self.assertEqual(result["code"], "UNSAFE_SIDECAR_IO")
        self.assertIs(result["cleanupSafe"], False)
        self.assertTrue(upload.is_dir(), "失败清理不得删除同名 replacement")
        self.assertTrue(moved.is_dir(), "被移走的 writer upload 也不得按旧名称误删")

    def test_created_upload_is_identity_cleaned_when_parent_fsync_fails(self):
        spec = importlib.util.spec_from_file_location("attachment_writer", WRITER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        read_fd, write_fd = os.pipe()
        os.write(write_fd, b"data")
        os.close(write_fd)
        staging_info = self.staging.stat()
        real_fsync = module.os.fsync

        def fail_staging_fsync(fd):
            info = os.fstat(fd)
            if (info.st_dev, info.st_ino) == (staging_info.st_dev, staging_info.st_ino):
                raise OSError("injected staging fsync failure")
            return real_fsync(fd)

        try:
            with mock.patch.object(module.os, "fsync", side_effect=fail_staging_fsync):
                with self.assertRaises(module.AttachmentWriterError):
                    module.write_attachment(self.config, input_fd=read_fd)
        finally:
            os.close(read_fd)
        self.assertFalse((self.staging / UPLOAD_ID).exists())

    def test_created_upload_is_identity_cleaned_when_initial_open_fails(self):
        spec = importlib.util.spec_from_file_location("attachment_writer", WRITER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        read_fd, write_fd = os.pipe()
        os.write(write_fd, b"data")
        os.close(write_fd)
        real_open = module.os.open

        def fail_upload_open(path, flags, *args, **kwargs):
            if path == UPLOAD_ID and kwargs.get("dir_fd") is not None:
                raise OSError("injected upload open failure")
            return real_open(path, flags, *args, **kwargs)

        try:
            with mock.patch.object(module.os, "open", side_effect=fail_upload_open):
                with self.assertRaises(module.AttachmentWriterError):
                    module.write_attachment(self.config, input_fd=read_fd)
        finally:
            os.close(read_fd)
        self.assertFalse((self.staging / UPLOAD_ID).exists())


if __name__ == "__main__":
    unittest.main()
