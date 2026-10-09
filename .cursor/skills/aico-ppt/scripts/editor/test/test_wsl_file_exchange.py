"""WSL/Windows 挂载盘发布回归：只使用显式提供目录下的临时文件。"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

EDITOR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EDITOR))
import sidecar_io
import wsl_file_exchange


@unittest.skipUnless(os.environ.get("AICO_WSL_PUBLISH_TEST_ROOT"), "需显式指定隔离的 Windows 挂载盘测试目录")
class WslPublishTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="wsl-publish-", dir=os.environ["AICO_WSL_PUBLISH_TEST_ROOT"])
        self.root = Path(self.temporary.name)
        self.left = self.root / "候选 deck.html"
        self.right = self.root / "原始 deck.html"
        self.left.write_bytes(b"new"); self.right.write_bytes(b"original")
        self.fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)

    def tearDown(self):
        os.close(self.fd); self.temporary.cleanup()

    def test_exchange_and_reverse_keep_both_contents(self):
        for expected in [(b"original", b"new"), (b"new", b"original")]:
            sidecar_io._exchange_file_entries(self.fd, self.left.name, self.right.name)
            self.assertEqual((self.left.read_bytes(), self.right.read_bytes()), expected)

    def test_missing_target_is_not_recreated(self):
        moved = self.right.with_suffix(".moved")
        self.right.rename(moved)
        with self.assertRaises(OSError):
            sidecar_io._exchange_file_entries(self.fd, self.left.name, self.right.name)
        self.assertFalse(self.right.exists())
        self.assertEqual(moved.read_bytes(), b"original")
        self.assertEqual(self.left.read_bytes(), b"new")

    def test_wrong_directory_identity_rejects_before_write(self):
        run = subprocess.run
        def changed(command, **kwargs):
            if command[0].lower().endswith("powershell.exe"):
                value=json.loads(kwargs["input"]); value["directoryId"]="0"
                kwargs["input"]=json.dumps(value).encode("utf-8")
            return run(command, **kwargs)
        with patch.object(wsl_file_exchange.subprocess, "run", side_effect=changed):
            with self.assertRaises(wsl_file_exchange.ExchangeError) as caught:
                wsl_file_exchange.exchange(self.fd, self.left.name, self.right.name)
        self.assertFalse(caught.exception.committed)
        self.assertEqual((self.left.read_bytes(), self.right.read_bytes()), (b"new", b"original"))

    def test_uncertain_transport_preserves_commit_uncertainty(self):
        run = subprocess.run
        def timed_out(command, **kwargs):
            if command[0].lower().endswith("powershell.exe"):
                raise subprocess.TimeoutExpired(command, 15)
            return run(command, **kwargs)
        with patch.object(wsl_file_exchange.subprocess, "run", side_effect=timed_out):
            with self.assertRaises(wsl_file_exchange.ExchangeError) as caught:
                wsl_file_exchange.exchange(self.fd, self.left.name, self.right.name)
        self.assertTrue(caught.exception.committed)
        self.assertEqual(self.right.read_bytes(), b"original")


if __name__ == "__main__": unittest.main()
