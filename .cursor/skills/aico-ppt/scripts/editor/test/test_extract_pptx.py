"""参考 PPTX 的内容提取回归；夹具直接保存 OOXML，不依赖 Office。"""
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "scripts" / "extract-pptx.py"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")


def xml(body):
    return f'<p:sld xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}"><p:cSld><p:spTree>{body}</p:spTree></p:cSld></p:sld>'


def shape(text, placeholder=""):
    return f'<p:sp><p:nvSpPr><p:cNvPr id="1" name="文本"/><p:nvPr>{placeholder}</p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>'


def relationships(*items):
    rows = "".join(f'<Relationship Id="{i}" Type="{R}/{kind}" Target="{target}"{external}/>' for i, kind, target, external in items)
    return f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rows}</Relationships>'


def package():
    table = '<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc gridSpan="2"><a:txBody><a:p><a:r><a:t>合并表头</a:t></a:r></a:p></a:txBody></a:tc><a:tc hMerge="1"/></a:tr><a:tr><a:tc><a:txBody><a:p><a:r><a:t>数量</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>42</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
    image = '<p:pic><p:nvPicPr><p:cNvPr id="2" name="原始图片"/></p:nvPicPr><p:blipFill><a:blip r:embed="image"/></p:blipFill></p:pic>'
    return {
        "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="xml" ContentType="application/xml"/></Types>',
        "_rels/.rels": relationships(("document", "officeDocument", "ppt/presentation.xml", "")),
        "ppt/presentation.xml": f'<p:presentation xmlns:p="{P}" xmlns:r="{R}"><p:sldIdLst><p:sldId id="260" r:id="first"/><p:sldId id="256" r:id="second"/></p:sldIdLst></p:presentation>',
        "ppt/_rels/presentation.xml.rels": relationships(("first", "slide", "slides/slide7.xml", ""), ("second", "slide", "slides/slide2.xml", "")),
        "ppt/slides/slide7.xml": xml(shape("第一张标题", '<p:ph idx="2"/>') + '<p:grpSp>' + shape("中文正文 &amp; 原文") + '</p:grpSp>' + table + image),
        "ppt/slides/_rels/slide7.xml.rels": relationships(("layout", "slideLayout", "../slideLayouts/slideLayout1.xml", ""), ("notes", "notesSlide", "../notesSlides/notesSlide1.xml", ""), ("image", "image", "../media/原图.png", "")),
        "ppt/slides/slide2.xml": xml(shape("第二页正文") + image),
        "ppt/slides/_rels/slide2.xml.rels": relationships(("image", "image", "../media/原图.png", "")),
        "ppt/slideLayouts/slideLayout1.xml": xml(shape("不要提取占位提示", '<p:ph type="title" idx="2"/>')),
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels": relationships(("master", "slideMaster", "../slideMasters/slideMaster1.xml", "")),
        "ppt/slideMasters/slideMaster1.xml": xml('<p:pic><p:blipFill><a:blip r:embed="logo"/></p:blipFill></p:pic>'),
        "ppt/slideMasters/_rels/slideMaster1.xml.rels": relationships(("logo", "image", "../media/logo.png", "")),
        "ppt/notesSlides/notesSlide1.xml": xml(shape("讲者备注", '<p:ph type="body"/>') + shape("7", '<p:ph type="sldNum"/>') + shape("页脚", '<p:ph type="ftr"/>')),
        "ppt/media/原图.png": PNG,
        "ppt/media/logo.png": PNG,
    }


class ExtractPptxTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "中文 参考.pptx"
        self.output = self.root / "读取结果"

    def write_package(self, files):
        with zipfile.ZipFile(self.source, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in files.items():
                archive.writestr(name, data)

    def run_extractor(self):
        return subprocess.run([sys.executable, str(SCRIPT), str(self.source), str(self.output)], capture_output=True, text=True)

    def test_extracts_in_presentation_order_with_notes_tables_and_original_images(self):
        self.write_package(package())
        original = self.source.read_bytes()
        result = self.run_extractor()
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads((self.output / "slides.json").read_text())
        self.assertEqual(data["schemaVersion"], 1)
        self.assertEqual(data["source"], str(self.source.resolve()))
        first, second = data["slides"]
        self.assertEqual([first["number"], second["number"]], [1, 2])
        self.assertEqual(first["title"], "第一张标题")
        self.assertEqual(first["text"], "中文正文 & 原文")
        self.assertEqual(first["notes"], "讲者备注")
        self.assertEqual(first["tables"][0]["rows"], [["合并表头", ""], ["数量", "42"]])
        self.assertEqual(first["tables"][0]["mergedCells"], [{"row": 0, "column": 0, "rowSpan": 1, "columnSpan": 2}])
        self.assertEqual(second["title"], "")
        self.assertEqual(second["text"], "第二页正文")
        self.assertEqual(second["notes"], "")
        self.assertTrue(first["images"])
        self.assertEqual(len(list((self.output / "media").iterdir())), 1)
        for slide in data["slides"]:
            for picture in slide["images"]:
                self.assertEqual((self.output / picture["path"]).read_bytes(), PNG)
                self.assertEqual(picture["sha256"], hashlib.sha256(PNG).hexdigest())
                self.assertEqual(picture["contentType"], "image/png")
        markdown = (self.output / "slides.md").read_text()
        self.assertIn("第一张标题", markdown)
        self.assertIn("讲者备注", markdown)
        self.assertIn("42", markdown)
        self.assertIn(first["images"][0]["path"], markdown)
        self.assertNotIn("不要提取占位提示", markdown)
        self.assertEqual(self.source.read_bytes(), original)

    def test_external_images_and_unrendered_objects_are_reported_without_fetching(self):
        files = package()
        files["ppt/slides/slide2.xml"] = xml('<p:pic><p:blipFill><a:blip r:link="web"/></p:blipFill></p:pic><p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><a:chart/></a:graphicData></a:graphic></p:graphicFrame>')
        files["ppt/slides/_rels/slide2.xml.rels"] = relationships(("web", "image", "https://example.invalid/private.png", ' TargetMode="External"'))
        self.write_package(files)
        result = self.run_extractor()
        self.assertEqual(result.returncode, 0, result.stderr)
        second = json.loads((self.output / "slides.json").read_text())["slides"][1]
        self.assertEqual(second["images"], [])
        self.assertTrue(any("外部" in warning for warning in second["warnings"]))
        self.assertTrue(any("图表" in warning for warning in second["warnings"]))

    def test_static_layout_and_master_text_is_read_without_placeholder_prompts(self):
        files = package()
        files["ppt/slideLayouts/slideLayout1.xml"] = xml(shape("不要提取占位提示", '<p:ph type="title" idx="2"/>') + shape("固定目录文字"))
        files["ppt/slideMasters/slideMaster1.xml"] = xml(shape("固定声明"))
        self.write_package(files)
        result = self.run_extractor()
        self.assertEqual(result.returncode, 0, result.stderr)
        first = json.loads((self.output / "slides.json").read_text())["slides"][0]
        self.assertEqual(first["text"], "中文正文 & 原文\n固定目录文字\n固定声明")
        self.assertEqual(first["title"], "第一张标题")

    def test_merged_cell_continuations_are_not_reported_as_new_merge_origins(self):
        files = package()
        files["ppt/slides/slide2.xml"] = xml('<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc gridSpan="2" rowSpan="2"><a:txBody><a:p><a:r><a:t>跨两行两列</a:t></a:r></a:p></a:txBody></a:tc><a:tc hMerge="1" rowSpan="2"/></a:tr><a:tr><a:tc vMerge="true" gridSpan="2"/><a:tc hMerge="true" vMerge="1"/></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>')
        self.write_package(files)
        result = self.run_extractor()
        self.assertEqual(result.returncode, 0, result.stderr)
        table = json.loads((self.output / "slides.json").read_text())["slides"][1]["tables"][0]
        self.assertEqual(table["rows"], [["跨两行两列", ""], ["", ""]])
        self.assertEqual(table["mergedCells"], [{"row": 0, "column": 0, "rowSpan": 2, "columnSpan": 2}])

    def test_alternate_content_reads_one_compatible_branch(self):
        files = package()
        content = shape("同一文本框")
        files["ppt/slides/slide2.xml"] = xml(f'<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="p">{content}</mc:Choice><mc:Fallback>{content}</mc:Fallback></mc:AlternateContent>')
        self.write_package(files)
        result = self.run_extractor()
        self.assertEqual(result.returncode, 0, result.stderr)
        second = json.loads((self.output / "slides.json").read_text())["slides"][1]
        self.assertEqual(second["text"], "同一文本框")

    def test_strict_ooxml_namespaces_and_escaped_media_paths(self):
        files = package()
        for key, value in files.items():
            if isinstance(value, str):
                files[key] = value.replace(P, "http://purl.oclc.org/ooxml/presentationml/main").replace(A, "http://purl.oclc.org/ooxml/drawingml/main").replace(R, "http://purl.oclc.org/ooxml/officeDocument/relationships").replace("../media/原图.png", "../media/%E5%8E%9F%E5%9B%BE.png")
        self.write_package(files)
        result = self.run_extractor()
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads((self.output / "slides.json").read_text())
        self.assertEqual(data["slides"][0]["title"], "第一张标题")
        self.assertEqual((self.output / data["slides"][1]["images"][0]["path"]).read_bytes(), PNG)

    def test_existing_output_is_not_overwritten(self):
        self.write_package(package())
        self.output.mkdir()
        keep = self.output / "已有内容.txt"
        keep.write_text("保留")
        result = self.run_extractor()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("已存在", result.stderr)
        self.assertEqual(keep.read_text(), "保留")
        self.assertEqual(list(self.output.iterdir()), [keep])

    def test_svg_original_is_preserved_alongside_its_png_fallback(self):
        files = package()
        files["ppt/slides/slide2.xml"] = xml('<p:pic><p:blipFill><a:blip r:embed="image"><a:extLst><a:ext><a:svgBlip r:embed="vector"/></a:ext></a:extLst></a:blip></p:blipFill></p:pic>')
        files["ppt/slides/_rels/slide2.xml.rels"] = relationships(("image", "image", "../media/原图.png", ""), ("vector", "image", "../media/vector.svg", ""))
        svg = b'<svg xmlns="http://www.w3.org/2000/svg"><text>original</text></svg>'
        files["ppt/media/vector.svg"] = svg
        self.write_package(files)
        result = self.run_extractor()
        self.assertEqual(result.returncode, 0, result.stderr)
        images = json.loads((self.output / "slides.json").read_text())["slides"][1]["images"]
        self.assertEqual(len(images), 2)
        self.assertEqual({(self.output / image["path"]).read_bytes() for image in images}, {PNG, svg})

    def test_missing_referenced_media_does_not_publish_partial_results(self):
        files = package()
        del files["ppt/media/原图.png"]
        self.write_package(files)
        result = self.run_extractor()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("原图.png", result.stderr)
        self.assertFalse(self.output.exists())

    def test_invalid_reference_is_refused_without_writing_outside_output(self):
        files = package()
        files["ppt/slides/_rels/slide2.xml.rels"] = relationships(("image", "image", "../../../outside.png", ""))
        self.write_package(files)
        result = self.run_extractor()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("引用越界", result.stderr)
        self.assertFalse(self.output.exists())
        self.assertFalse((self.root / "outside.png").exists())


if __name__ == "__main__":
    unittest.main()
