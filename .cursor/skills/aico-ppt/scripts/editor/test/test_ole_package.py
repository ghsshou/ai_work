import hashlib
import importlib.util
import io
from pathlib import Path
import struct
import unittest


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("aico_ole_package", ROOT / "scripts" / "html2pptx" / "ole_package.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


@unittest.skipUnless(importlib.util.find_spec("olefile"), "独立容器回读使用已有 olefile")
class OlePackageTest(unittest.TestCase):
    def roundtrip(self, original, label="x.html"):
        import olefile
        blob = module.build_ole_package(original, label)
        with olefile.OleFileIO(io.BytesIO(blob), raise_defects=olefile.DEFECT_INCORRECT) as package:
            raw = package.openstream("\x01Ole10Native").read()
            self.assertEqual(package.root.clsid, "0003000C-0000-0000-C000-000000000046")
        self.assertGreaterEqual(len(raw), 6)
        self.assertEqual(struct.unpack_from("<I", raw)[0], len(raw) - 4)
        cursor = 6
        end = raw.index(b"\0", cursor)
        self.assertEqual(raw[cursor:end].decode("gbk"), label)
        cursor = raw.index(b"\0", end + 1) + 1 + 4
        cursor = raw.index(b"\0", cursor) + 1
        size = struct.unpack_from("<I", raw, cursor)[0]
        self.assertEqual(raw[cursor + 4:cursor + 4 + size], original)
        return blob, raw

    def test_short_html_uses_mini_stream_and_preserves_all_bytes(self):
        original = b"<html>short</html>"
        blob, _ = self.roundtrip(original, "原件.html")
        self.assertEqual(struct.unpack_from("<I", blob, 64)[0], 1)

    def test_empty_attachment_and_mini_stream_cutoff_roundtrip(self):
        # x.html 的 Ole10Native 头部占 54 字节；4096 的分流条件针对整个流。
        for stream_size in (54, 4095, 4096, 4097):
            with self.subTest(stream_size=stream_size):
                blob, raw = self.roundtrip(b"x" * (stream_size - 54))
                self.assertEqual(len(raw), stream_size)
                self.assertEqual(struct.unpack_from("<I", blob, 64)[0], int(stream_size < 4096))

    def test_regular_stream_and_large_difat_output_remain_byte_identical(self):
        # 固定修复前已可正确读取的完整容器，覆盖普通 FAT 与跨首组 FAT 的 DIFAT。
        for size, expected in (
            (4096, "cf593246c1fe3fb1c9cdd7b9ab91d099ad3b7ad2259045f2c444f6f0a8f96603"),
            (8 * 1024 * 1024, "390d941dfa66293e30f7f769a29091e993b9f3a591adc5b59cb8c2030ad558ca"),
        ):
            with self.subTest(size=size):
                blob, _ = self.roundtrip(b"x" * size)
                self.assertEqual(hashlib.sha256(blob).hexdigest(), expected)


if __name__ == "__main__":
    unittest.main()
