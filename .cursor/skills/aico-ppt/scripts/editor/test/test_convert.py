"""转换 CLI 的模式选择与原始输入传递。"""

from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


CONVERTER = Path(__file__).resolve().parents[2] / "html2pptx" / "convert.py"


class ConvertTests(unittest.TestCase):
    def test_explicit_node_does_not_require_path_lookup(self):
        node = shutil.which("node")
        self.assertIsNotNone(node)
        with mock.patch.dict(os.environ, {"AICO_NODE_EXECUTABLE": node, "PATH": ""}):
            result = self.convert("--mode", "image")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.output.read_text())["mode"], "image")

    def test_invalid_explicit_node_never_falls_back_to_path(self):
        with mock.patch.dict(os.environ, {"AICO_NODE_EXECUTABLE": str(self.root / "missing-node")}):
            result = self.convert()
        self.assertEqual(result.returncode, 2)
        self.assertIn("插件 Node 可执行文件无效", result.stderr)
        self.assertFalse(self.output.exists())

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        shutil.copyfile(CONVERTER, self.root / "convert.py")
        self.source = self.root / "演示.html"
        self.source.write_text("<html>原始演示</html>", encoding="utf-8")
        self.output = self.root / "演示.pptx"
        # 子进程夹具记录真实 CLI 收到的参数，不依赖渲染器或组装器的内部实现。
        for script, mode in (("shoot.mjs", "image"), ("extract-editable.mjs", "editable")):
            (self.root / script).write_text(
                "import {writeFileSync} from 'node:fs';\n"
                "import {join} from 'node:path';\n"
                f"writeFileSync(join(process.argv[3], 'input.json'), JSON.stringify({{mode:'{mode}', args:process.argv.slice(2)}}));\n",
                encoding="utf-8",
            )
        for script in ("build_pptx.py", "build_editable_pptx.py"):
            (self.root / script).write_text(
                "import json, sys\nfrom pathlib import Path\n"
                "data=json.loads((Path(sys.argv[1])/'input.json').read_text())\n"
                "data['builder']=Path(__file__).name\n"
                "data['embedded']=Path(sys.argv[3]).read_text() if len(sys.argv)>3 else None\n"
                "Path(sys.argv[2]).write_text(json.dumps(data))\n",
                encoding="utf-8",
            )

    def convert(self, *args):
        return subprocess.run(
            [sys.executable, str(self.root / "convert.py"), str(self.source), str(self.output), *args],
            capture_output=True, text=True, encoding="utf-8",
        )

    def test_editable_mode_extracts_then_builds_with_original_html(self):
        result = self.convert("--mode", "editable", "--scale", "1.5", "--embed-html")
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(self.output.read_text())
        self.assertEqual(output["mode"], "editable")
        self.assertEqual(output["builder"], "build_editable_pptx.py")
        self.assertEqual(output["args"][0], str(self.source))
        self.assertEqual(output["args"][2:], ["1.5"])
        self.assertEqual(output["embedded"], self.source.read_text())
        self.assertFalse(Path(output["args"][1]).exists())

    def test_default_and_explicit_image_preserve_screenshot_arguments(self):
        for args in ((), ("--mode", "image")):
            with self.subTest(args=args):
                result = self.convert(*args, "--scale", "2", "--quality", "88")
                self.assertEqual(result.returncode, 0, result.stderr)
                output = json.loads(self.output.read_text())
                self.assertEqual(output["mode"], "image")
                self.assertEqual(output["builder"], "build_pptx.py")
                self.assertEqual(output["args"][2:], ["2.0", "88"])
                self.assertIsNone(output["embedded"])

    def test_invalid_mode_preserves_existing_output(self):
        self.output.write_bytes(b"existing-pptx")
        result = self.convert("--mode", "unknown")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.output.read_bytes(), b"existing-pptx")

    def test_editable_scale_matches_extractor_range_before_starting_conversion(self):
        for scale in ("0.25", "5", "nan"):
            with self.subTest(scale=scale):
                self.output.write_bytes(b"existing-pptx")
                result = self.convert("--mode", "editable", "--scale", scale)
                self.assertEqual(result.returncode, 2)
                self.assertIn("0.5", result.stderr)
                self.assertEqual(self.output.read_bytes(), b"existing-pptx")
        self.assertEqual(self.convert("--mode", "image", "--scale", "5").returncode, 0)


if __name__ == "__main__":
    unittest.main()
