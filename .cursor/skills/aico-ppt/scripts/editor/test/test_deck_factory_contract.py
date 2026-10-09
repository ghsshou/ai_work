"""新建 Deck 模板来源与固定首尾页契约回归测试。"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest


PROJECT_DIR = Path(__file__).resolve().parents[3]
FACTORY_PATH = PROJECT_DIR / "scripts" / "editor" / "deck_factory.py"
CATALOG_PATH = PROJECT_DIR / "scripts" / "editor" / "template-catalog.json"
TEMPLATE_PATH = PROJECT_DIR / "assets" / "training-deck.html"


def load_factory():
    spec = importlib.util.spec_from_file_location("aico_ppt_factory", FACTORY_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 deck_factory.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DeckFactoryContractTest(unittest.TestCase):
    def test_fixed_layout_ignores_managed_identity_and_void_spacing(self):
        factory = load_factory()
        original = '<section style="color:red"><div>标题</div><img src="image"/><br/></section>'
        managed = '<section style="color:red"><div data-editor-id="element-123">新标题</div><img src="image" /><br /></section>'
        self.assertEqual(factory.layout_fingerprint(original), factory.layout_fingerprint(managed))
        self.assertNotEqual(factory.layout_fingerprint(original), factory.layout_fingerprint(managed.replace('color:red', 'color:blue')))
        self.assertNotEqual(factory.layout_fingerprint(original), factory.layout_fingerprint(managed.replace('<br />', '<hr />')))

    def test_imports_compatible_shared_page_without_merging_template_shells(self):
        factory = load_factory()
        with tempfile.TemporaryDirectory(prefix="deck-factory-shared-page-") as temp_dir:
            deck_path = Path(temp_dir) / "deck.html"
            shutil.copyfile(TEMPLATE_PATH, deck_path)
            factory.stamp(deck_path, CATALOG_PATH, "training")

            result = factory.import_page(
                deck_path,
                CATALOG_PATH,
                "training",
                "case-study",
                "客户案例",
                "结语页",
                "案",
                "case-01",
                "evidence",
            )
            self.assertEqual(result["check"], "shared-page-type-import")
            self.assertEqual(result["sourceTemplateId"], "work-report")

            dense_result = factory.import_page(
                deck_path,
                CATALOG_PATH,
                "training",
                "stage-deliverable-map",
                "阶段责任交付",
                "结语页",
                "阶",
                "dense-01",
                "execution",
            )
            self.assertEqual(dense_result["check"], "shared-page-type-import")
            self.assertEqual(dense_result["sourceTemplateId"], "work-report")
            self.assertEqual(
                factory.verify(deck_path, CATALOG_PATH, "training")["check"],
                "template-contract",
            )

            edit_bundle = factory.load_edit_bundle()
            html = edit_bundle.get_template(edit_bundle.load(str(deck_path)))
            imported = next(
                section for section in factory.SECTION_PATTERN.findall(html)
                if factory.attribute(section, "data-label") == "客户案例"
            )
            self.assertEqual(factory.attribute(imported, "data-template-id"), "work-report")
            self.assertEqual(factory.attribute(imported, "data-page-type-id"), "case-study")
            self.assertEqual(factory.attribute(imported, "data-plan-page-id"), "case-01")
            self.assertEqual(factory.attribute(imported, "data-plan-chapter-id"), "evidence")
            dense_imported = next(
                section for section in factory.SECTION_PATTERN.findall(html)
                if factory.attribute(section, "data-label") == "阶段责任交付"
            )
            self.assertEqual(factory.attribute(dense_imported, "data-template-id"), "work-report")
            self.assertEqual(
                factory.attribute(dense_imported, "data-page-type-id"),
                "stage-deliverable-map",
            )

    def test_verify_rejects_page_count_or_identity_different_from_confirmed_plan(self):
        factory = load_factory()
        with tempfile.TemporaryDirectory(prefix="deck-factory-page-plan-") as temp_dir:
            deck_path = Path(temp_dir) / "deck.html"
            contract_path = Path(temp_dir) / "page-plan-contract.json"
            shutil.copyfile(TEMPLATE_PATH, deck_path)
            factory.stamp(deck_path, CATALOG_PATH, "training")

            edit_bundle = factory.load_edit_bundle()
            lines = edit_bundle.load(str(deck_path))
            html = edit_bundle.get_template(lines)
            sections = list(factory.SECTION_PATTERN.finditer(html))
            pages = []
            rewritten = []
            offset = 0
            for index, section in enumerate(sections, 1):
                fragment = section.group(0)
                page_id = f"page-{index:02d}"
                chapter_id = "chapter-01"
                rewritten.append(html[offset:section.start()])
                opening_end = fragment.find(">")
                rewritten.append(
                    f'{fragment[:opening_end]} data-plan-page-id="{page_id}" '
                    f'data-plan-chapter-id="{chapter_id}"{fragment[opening_end:]}'
                )
                offset = section.end()
                pages.append({
                    "pageId": page_id,
                    "chapterId": chapter_id,
                    "pageTypeId": factory.attribute(fragment, "data-page-type-id"),
                    "label": factory.attribute(fragment, "data-label"),
                })
            rewritten.append(html[offset:])
            edit_bundle.set_template(lines, "".join(rewritten))
            edit_bundle.save(str(deck_path), lines)
            contract = {"version": 1, "templateId": "training", "pages": pages}
            contract_path.write_text(
                json.dumps(contract, ensure_ascii=False), encoding="utf-8",
            )

            result = factory.verify(
                deck_path, CATALOG_PATH, "training", contract_path,
            )
            self.assertEqual(result["check"], "template-and-page-plan-contract")

            contract["pages"] = contract["pages"][:-1]
            contract_path.write_text(
                json.dumps(contract, ensure_ascii=False), encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "页面数量与已确认规划不一致"):
                factory.verify(deck_path, CATALOG_PATH, "training", contract_path)

            contract["pages"] = pages
            contract["pages"][2]["pageId"] = "wrong-page"
            contract_path.write_text(
                json.dumps(contract, ensure_ascii=False), encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "页面身份与已确认规划不一致"):
                factory.verify(deck_path, CATALOG_PATH, "training", contract_path)

    def test_stamp_and_verify_then_reject_required_page_structure_change(self):
        factory = load_factory()
        with tempfile.TemporaryDirectory(prefix="deck-factory-contract-") as temp_dir:
            deck_path = Path(temp_dir) / "deck.html"
            shutil.copyfile(TEMPLATE_PATH, deck_path)
            factory.stamp(deck_path, CATALOG_PATH, "training")
            result = factory.verify(deck_path, CATALOG_PATH, "training")
            self.assertEqual(result["check"], "template-contract")

            edit_bundle = factory.load_edit_bundle()
            lines = edit_bundle.load(str(deck_path))
            html = edit_bundle.get_template(lines)
            sections = list(factory.SECTION_PATTERN.finditer(html))
            toc = sections[1].group(0)
            adapted_toc = toc.replace("<div", '<div data-contract-test="adaptive-toc"', 1)
            html = f"{html[:sections[1].start()]}{adapted_toc}{html[sections[1].end():]}"
            edit_bundle.set_template(lines, html)
            edit_bundle.save(str(deck_path), lines)
            self.assertEqual(
                factory.verify(deck_path, CATALOG_PATH, "training")["check"],
                "template-contract",
            )

            lines = edit_bundle.load(str(deck_path))
            html = edit_bundle.get_template(lines)
            sections = list(factory.SECTION_PATTERN.finditer(html))
            thanks = sections[-1].group(0)
            broken = thanks.replace("<div", '<div data-contract-test="broken"', 1)
            html = f"{html[:sections[-1].start()]}{broken}{html[sections[-1].end():]}"
            edit_bundle.set_template(lines, html)
            edit_bundle.save(str(deck_path), lines)

            with self.assertRaisesRegex(ValueError, "原始结构已被改动"):
                factory.verify(deck_path, CATALOG_PATH, "training")


if __name__ == "__main__":
    unittest.main()
