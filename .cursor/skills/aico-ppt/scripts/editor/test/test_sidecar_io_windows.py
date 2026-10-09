import base64
import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


EDITOR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EDITOR_DIR))
import sidecar_io_windows  # noqa: E402


SESSION_ID = "123e4567-e89b-42d3-a456-426614174000"
TRANSACTION_ID = "823e4567-e89b-42d3-a456-426614174000"


def directory_identity(path):
    info = os.lstat(path)
    return {
        "path": str(path), "realPath": str(path.resolve()),
        "dev": str(info.st_dev), "ino": str(info.st_ino),
    }


class WindowsPublishRaceContractTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name)
        self.deck = self.project / "deck.html"
        self.deck.write_bytes(b"original-deck")
        self.original_fingerprint = hashlib.sha256(self.deck.read_bytes()).hexdigest()
        self.session_name = f"deck-{self.original_fingerprint[:8]}"
        self.helper = sidecar_io_windows.WindowsPersistentHelper()
        self.addCleanup(self.helper.close)
        self.helper.initialize({"project": directory_identity(self.project)})
        self.helper.prepare_session({
            "deckName": "deck.html", "sessionId": SESSION_ID,
            "initialFingerprint": self.original_fingerprint,
            "sessionName": self.session_name, "mode": "fresh",
        })
        self.helper.bind_session({
            "deckName": "deck.html", "sessionId": SESSION_ID,
            "sessionName": self.session_name, "create": True,
        })

    def test_publish_does_not_recreate_old_path_when_source_is_renamed(self):
        working = b"published-working-deck"
        working_fingerprint = hashlib.sha256(working).hexdigest()
        self.helper.write_working_deck({
            "sessionId": SESSION_ID,
            "bytes": base64.b64encode(working).decode("ascii"),
            "expectedFingerprint": None,
        })
        moved = self.project / "renamed.html"
        real_replace = sidecar_io_windows._replace_existing_file

        def rename_before_replace(replaced, replacement, backup):
            self.deck.rename(moved)
            return real_replace(replaced, replacement, backup)

        with mock.patch.object(
            sidecar_io_windows, "_replace_existing_file", side_effect=rename_before_replace
        ):
            with self.assertRaises(sidecar_io_windows.SidecarIOError) as caught:
                self.helper.publish_working_deck({
                    "sessionId": SESSION_ID,
                    "transactionId": TRANSACTION_ID,
                    "expectedDeckFingerprint": self.original_fingerprint,
                    "expectedWorkingFingerprint": working_fingerprint,
                })

        self.assertEqual(caught.exception.code, "DECK_CHANGED")
        self.assertFalse(self.deck.exists())
        self.assertEqual(moved.read_bytes(), b"original-deck")
        transaction = (
            self.project / ".aico-ppt-editor" / self.session_name
            / "transactions" / f"{TRANSACTION_ID}.json"
        )
        self.assertFalse(transaction.exists())

    def test_native_backend_calls_replace_file_w_with_existing_target_contract(self):
        calls = []

        class ReplaceFileCall:
            argtypes = None
            restype = None

            def __call__(self, *args):
                calls.append(args)
                return 1

        replace_file = ReplaceFileCall()
        kernel32 = type("Kernel32", (), {"ReplaceFileW": replace_file})()
        with mock.patch.object(sidecar_io_windows.os, "name", "nt"), mock.patch.object(
            sidecar_io_windows.ctypes, "WinDLL", return_value=kernel32, create=True
        ):
            sidecar_io_windows._replace_existing_file(
                "C:\\Decks\\source.html",
                "C:\\Decks\\candidate.tmp",
                "C:\\Decks\\source.exchanged",
            )

        self.assertEqual(len(calls), 1)
        replaced, replacement, backup, flags, exclude, reserved = calls[0]
        self.assertTrue(str(replaced).endswith("source.html"))
        self.assertTrue(str(replacement).endswith("candidate.tmp"))
        self.assertTrue(str(backup).endswith("source.exchanged"))
        self.assertEqual((flags, exclude, reserved), (0, None, None))


if __name__ == "__main__":
    unittest.main()
