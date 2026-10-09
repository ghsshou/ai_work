"""真实 PDF 回归：普通材料只用 PyMuPDF，AcroForm 填写另用 pypdf。"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import pymupdf as fitz


ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = ROOT / ".agents" / "skills" / "pdf" / "scripts"
BOOTSTRAP = r'''
import importlib.util, runpy, sys
# -S 不加载 site-packages，只开放临时目录中的 PyMuPDF 包。
sys.path.insert(0, sys.argv[1])
for name in ['pdfplumber','pdfminer','reportlab','pdf2image','pypdfium2','PIL','numpy','pandas','cryptography']:
    assert importlib.util.find_spec(name) is None, name
script = sys.argv[2]
sys.argv = sys.argv[2:]
sys.path.insert(0, __import__('os').path.dirname(script))
runpy.run_path(script, run_name='__main__')
'''


def widget(page, name, kind, rect, choices=None):
    item = fitz.Widget()
    item.field_name, item.field_type, item.rect = name, kind, fitz.Rect(rect)
    item.text_fontsize = 12
    if choices:
        item.choice_values = choices
    return page.add_widget(item).xref


class PdfMaterialsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aico-pdf-materials-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.packages = self.root / "仅PyMuPDF"
        self.packages.mkdir()
        (self.packages / "pymupdf").symlink_to(Path(fitz.__file__).parent, target_is_directory=True)
        self.form_packages = self.root / "表单专用依赖"
        self.form_packages.mkdir()
        (self.form_packages / "pymupdf").symlink_to(Path(fitz.__file__).parent, target_is_directory=True)
        (self.form_packages / "pypdf").symlink_to(Path(__import__('pypdf').__file__).parent, target_is_directory=True)
        if sys.version_info < (3, 10):
            # pypdf 在 Python 3.9 上声明此兼容依赖；隔离环境仍禁止其他 PDF 工具。
            import typing_extensions
            (self.form_packages / "typing_extensions.py").symlink_to(Path(typing_extensions.__file__))
        self.source = self.root / "参考.pdf"
        with fitz.open() as doc:
            page = doc.new_page(width=400, height=500)
            page.insert_text((30, 35), "Name Quantity")
            for x in (30, 160, 300):
                page.draw_line((x, 60), (x, 140))
            for y in (60, 100, 140):
                page.draw_line((30, y), (300, y))
            for x, y, text in ((35, 80, "Item"), (165, 80, "Count"), (35, 120, "Book"), (165, 120, "42")):
                page.insert_text((x, y), text)
            page.draw_rect(fitz.Rect(30, 170, 40, 180))
            text = widget(page, "name", fitz.PDF_WIDGET_TYPE_TEXT, (50, 200, 250, 225))
            check = widget(page, "consent", fitz.PDF_WIDGET_TYPE_CHECKBOX, (50, 240, 65, 255))
            choice = widget(page, "country", fitz.PDF_WIDGET_TYPE_COMBOBOX, (50, 270, 200, 295), ["China", "France"])
            doc.xref_set_key(choice, "Opt", "[[(CN)(China)][(FR)(France)]]")
            radios = [widget(page, "red", fitz.PDF_WIDGET_TYPE_CHECKBOX, (50, 320, 65, 335)), widget(page, "blue", fitz.PDF_WIDGET_TYPE_CHECKBOX, (100, 320, 115, 335))]
            parent = doc.get_new_xref()
            doc.update_object(parent, f"<< /FT /Btn /Ff 32768 /T (color) /Kids [{' '.join(f'{x} 0 R' for x in radios)}] /V /Off >>")
            for xref, name in zip(radios, ["Red", "Blue"]):
                on = doc.xref_get_key(xref, "AP/N/Yes")[1]
                off = doc.xref_get_key(xref, "AP/N/Off")[1]
                doc.xref_set_key(xref, "AP/N", f"<< /Off {off} /{name} {on} >>")
                doc.xref_set_key(xref, "T", "null")
                doc.update_object(xref, doc.xref_object(xref).replace("/T null", ""))
                doc.xref_set_key(xref, "Parent", f"{parent} 0 R")
                doc.xref_set_key(xref, "Ff", "32768")
            doc.xref_set_key(doc.pdf_catalog(), "AcroForm/Fields", f"[{' '.join(f'{x} 0 R' for x in [text, check, choice, parent])}]")
            doc.new_page(width=400, height=500).insert_text((30, 35), "Second page")
            doc.save(self.source)
        self.original_hash = hashlib.sha256(self.source.read_bytes()).hexdigest()

    def run_script(self, name, *args, succeeds=True):
        packages = self.form_packages if name == "fill_fillable_fields.py" else self.packages
        result = subprocess.run([sys.executable, "-S", "-c", BOOTSTRAP, str(packages), str(SCRIPTS / name), *map(str, args)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr) if succeeds else self.assertNotEqual(result.returncode, 0)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), self.original_hash)
        return result

    def test_structure_reads_text_tables_and_boxes_with_only_mupdf(self):
        output = self.root / "结构.json"
        self.run_script("extract_form_structure.py", self.source, output)
        data = json.loads(output.read_text())
        self.assertEqual(len(data["pages"]), 2)
        self.assertIn("Name", [label["text"] for label in data["labels"]])
        self.assertIn({"page": 1, "x0": 30.0, "top": 170.0, "x1": 40.0, "bottom": 180.0, "center_x": 35.0, "center_y": 175.0}, data["checkboxes"])
        self.assertEqual(data["tables"][0]["rows"], [["Item", "Count"], ["Book", "42"]])

    def test_field_info_and_fill_preserve_widget_values_appearances_and_choice_exports(self):
        self.run_script("check_fillable_fields.py", self.source)
        info_path = self.root / "fields.json"
        self.run_script("extract_form_field_info.py", self.source, info_path)
        fields = {field["field_id"]: field for field in json.loads(info_path.read_text())}
        self.assertEqual(fields["name"]["rect"], [50, 275, 250, 300])
        self.assertEqual(fields["consent"]["checked_value"], "/Yes")
        self.assertEqual(fields["country"]["choice_options"], [{"value": "CN", "text": "China"}, {"value": "FR", "text": "France"}])
        self.assertEqual([option["value"] for option in fields["color"]["radio_options"]], ["/Red", "/Blue"])
        values = self.root / "values.json"
        values.write_text(json.dumps([{"field_id": name, "page": 1, "value": value} for name, value in [("name", "Ada"), ("consent", "/Yes"), ("country", "FR"), ("color", "/Blue")]]))
        output = self.root / "filled.pdf"
        self.run_script("fill_fillable_fields.py", self.source, values, output)
        with fitz.open(output) as doc:
            page = doc[0]
            widgets = list(page.widgets())
            by_name = {w.field_name: w for w in widgets}
            self.assertEqual(by_name["name"].field_value, "Ada")
            self.assertEqual(by_name["consent"].field_value, "Yes")
            self.assertEqual(by_name["country"].field_value, "FR")
            self.assertEqual(doc.xref_get_key(by_name["country"].xref, "Opt")[1], "[[(CN)(China)][(FR)(France)]]")
            radios = [w for w in widgets if w.field_name == "color"]
            self.assertEqual([doc.xref_get_key(w.xref, "AS")[1] for w in radios], ["/Off", "/Blue"])
            parent = int(doc.xref_get_key(radios[0].xref, "Parent")[1].split()[0])
            self.assertEqual(doc.xref_get_key(parent, "V")[1], "/Blue")
            self.assertGreater(len(page.get_pixmap().tobytes("png")), 1000)
            self.assertNotEqual(doc.xref_get_key(by_name["name"].xref, "AP/N")[0], "null")
            self.assertTrue(doc.is_form_pdf)

    def test_invalid_form_value_is_rejected_before_publishing(self):
        values = self.root / "bad.json"
        values.write_text(json.dumps([{"field_id": "country", "page": 1, "value": "missing"}]))
        output = self.root / "bad.pdf"
        result = self.run_script("fill_fillable_fields.py", self.source, values, output, succeeds=False)
        self.assertIn("值无效", result.stderr)
        self.assertFalse(output.exists())

    def test_chinese_fill_is_visible_and_remains_interactive(self):
        # 表单原本带中文字体；迁移必须保留，不能强制替换为西文字体。
        with fitz.open(self.source) as doc:
            page = doc[0]
            font = page.insert_font(fontname="F0", fontbuffer=fitz.Font("cjk").buffer)
            doc.xref_set_key(doc.pdf_catalog(), "AcroForm/DR/Font/F0", f"{font} 0 R")
            doc.xref_set_key(next(page.widgets()).xref, "DA", fitz.get_pdf_str("/F0 12 Tf 0 g"))
            doc.saveIncr()
        self.original_hash = hashlib.sha256(self.source.read_bytes()).hexdigest()
        values = self.root / "中文.json"
        values.write_text(json.dumps([{"field_id": "name", "page": 1, "value": "审核通过"}]))
        output = self.root / "中文.pdf"
        self.run_script("fill_fillable_fields.py", self.source, values, output)
        with fitz.open(output) as doc:
            page = doc[0]
            self.assertEqual(next(page.widgets()).field_value, "审核通过")
            self.assertIn("审核通过", page.get_text())
            self.assertTrue(doc.is_form_pdf)
            self.assertFalse(list(page.annots() or []))

    def test_form_writes_cannot_overwrite_source_or_hardlink(self):
        values = self.root / "values.json"
        values.write_text(json.dumps([{"field_id": "name", "page": 1, "value": "Ada"}]))
        alias = self.root / "alias.pdf"
        __import__('os').link(self.source, alias)
        for destination in [self.source, alias]:
            result = self.run_script("fill_fillable_fields.py", self.source, values, destination, succeeds=False)
            self.assertIn("不能覆盖原 PDF", result.stderr)

    def test_shared_text_field_updates_all_widgets_and_logical_parent(self):
        with fitz.open(self.source) as doc:
            first_page, second_page = doc[0], doc[1]
            first = next(first_page.widgets()).xref
            second = widget(second_page, "repeated", fitz.PDF_WIDGET_TYPE_TEXT, (50, 70, 250, 95))
            parent = doc.get_new_xref()
            doc.update_object(parent, f"<< /FT /Tx /T (name) /Kids [{first} 0 R {second} 0 R] >>")
            for xref in [first, second]:
                doc.xref_set_key(xref, "T", "null")
                doc.update_object(xref, doc.xref_object(xref).replace("/T null", ""))
                doc.xref_set_key(xref, "Parent", f"{parent} 0 R")
            fields = doc.xref_get_key(doc.pdf_catalog(), "AcroForm/Fields")[1]
            fields = fields.replace(f"{first} 0 R", f"{parent} 0 R", 1).replace(f"{second} 0 R", "")
            doc.xref_set_key(doc.pdf_catalog(), "AcroForm/Fields", fields)
            doc.saveIncr()
        self.original_hash = hashlib.sha256(self.source.read_bytes()).hexdigest()
        values = self.root / "shared.json"
        values.write_text(json.dumps([{"field_id": "name", "page": 1, "value": "Shared"}]))
        output = self.root / "shared.pdf"
        self.run_script("fill_fillable_fields.py", self.source, values, output)
        with fitz.open(output) as doc:
            for page in doc:
                self.assertEqual(next(page.widgets()).field_value, "Shared")
                self.assertIn("Shared", page.get_text())

    def test_images_merge_and_split_with_only_mupdf_preserve_page_content_and_widgets(self):
        # 执行文档中的原图/页面操作接口，子进程中确实没有 pypdf 或图像包。
        code = self.root / "页面能力.py"
        code.write_text('''import importlib.util, pathlib, sys, pymupdf
assert importlib.util.find_spec("pypdf") is None
source, root = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 8, 8), False)
pix.clear_with(128)
raw = pix.tobytes("png")
with pymupdf.open(source) as doc:
    doc[1].insert_image(pymupdf.Rect(30, 60, 70, 100), stream=raw)
    doc.save(root / "with-image.pdf")
with pymupdf.open(root / "with-image.pdf") as doc:
    page = doc[1]
    image = doc.extract_image(page.get_images(full=True)[0][0])
    assert pymupdf.Pixmap(image["image"]).samples == pix.samples
    with pymupdf.open() as selected:
        selected.insert_pdf(doc, from_page=1, to_page=1, widgets=True)
        selected.save(root / "split.pdf")
    with pymupdf.open() as merged:
        merged.insert_pdf(doc, widgets=True)
        with pymupdf.open(root / "split.pdf") as selected:
            merged.insert_pdf(selected, widgets=True)
        merged.save(root / "merged.pdf")
with pymupdf.open(root / "merged.pdf") as doc:
    assert len(doc) == 3
    assert doc.is_form_pdf and len(list(doc[0].widgets())) == 5
    assert doc[0].find_tables().tables[0].extract() == [["Item", "Count"], ["Book", "42"]]
    assert "Second page" in doc[2].get_text()
    assert len(doc[2].get_images()) == 1
''', encoding="utf-8")
        self.run_script(str(code), self.source, self.root)

    def test_render_and_annotation_workflow_without_pillow_or_poppler(self):
        images = self.root / "images"
        self.run_script("convert_pdf_to_images.py", self.source, images)
        pix = fitz.Pixmap(str(images / "page_1.png"))
        self.assertEqual((pix.width, pix.height), (800, 1000))
        fields = self.root / "annotations.json"
        fields.write_text(json.dumps({"pages": [{"page_number": 1, "pdf_width": 400, "pdf_height": 500}], "form_fields": [{"page_number": 1, "description": "备注", "label_bounding_box": [20, 370, 45, 395], "entry_bounding_box": [50, 370, 250, 395], "entry_text": {"text": "审核通过", "font_size": 12}}]}))
        output = self.root / "annotated.pdf"
        self.run_script("fill_pdf_form_with_annotations.py", self.source, fields, output)
        with fitz.open(output) as doc:
            page = doc[0]
            annot = next(page.annots())
            self.assertEqual(annot.info["content"], "审核通过")
            self.assertIn("审核通过", annot.get_text())
            self.assertEqual(list(annot.rect), [50, 370, 250, 395])
            self.assertTrue(doc.is_form_pdf)
        validation = self.root / "validation.png"
        self.run_script("create_validation_image.py", 1, fields, images / "page_1.png", validation)
        marked = fitz.Pixmap(str(validation))
        self.assertEqual((marked.width, marked.height), (800, 1000))

    def test_rotated_page_image_coordinates_and_render_size(self):
        with fitz.open(self.source) as doc:
            doc[0].set_rotation(90)
            doc.saveIncr()
        self.original_hash = hashlib.sha256(self.source.read_bytes()).hexdigest()
        images = self.root / "rotated"
        structure = self.root / "rotated-structure.json"
        self.run_script("extract_form_structure.py", self.source, structure)
        self.assertEqual(json.loads(structure.read_text())["tables"][0]["bbox"], [360, 30, 440, 300])
        self.run_script("convert_pdf_to_images.py", self.source, images, 500)
        pix = fitz.Pixmap(str(images / "page_1.png"))
        self.assertEqual((pix.width, pix.height), (500, 400))
        fields = self.root / "rotated.json"
        fields.write_text(json.dumps({"pages": [{"page_number": 1, "image_width": 1000, "image_height": 800}], "form_fields": [{"page_number": 1, "description": "备注", "entry_bounding_box": [100, 600, 500, 650], "entry_text": {"text": "位置核对", "font_size": 12}}]}))
        output = self.root / "rotated.pdf"
        self.run_script("fill_pdf_form_with_annotations.py", self.source, fields, output)
        with fitz.open(output) as doc:
            page = doc[0]
            annotation = next(page.annots())
            self.assertEqual(list(annotation.rect * page.rotation_matrix), [50, 300, 250, 325])
            self.assertIn("位置核对", annotation.get_text())


if __name__ == "__main__":
    unittest.main()
