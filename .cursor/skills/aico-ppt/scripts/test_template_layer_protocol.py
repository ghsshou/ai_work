#!/usr/bin/env python3
"""全部模板的页内多画面协议回归测试。"""

import importlib.util
import re
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parent.parent
TEMPLATES = (
    REPO / "assets" / "training-deck.html",
    REPO / "assets" / "tech-share-deck.html",
    REPO / "assets" / "work-report-deck.html",
    REPO / "assets" / "qualification-deck.html",
    REPO / "assets" / "project-review-deck.html",
)


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


eb = load_module("edit_bundle_layer_contract", REPO / "scripts" / "edit-bundle.py")
up = load_module("upgrade_deck_layer_contract", REPO / "scripts" / "upgrade_deck.py")


class TemplateLayerProtocolTest(unittest.TestCase):
    def test_toc_uses_fixed_layer_dom_in_all_templates(self):
        for path in TEMPLATES:
            with self.subTest(template=path.name):
                count = {"qualification-deck.html": 3, "project-review-deck.html": 10}.get(path.name, 4)
                expected = [f"chapter-{i:02d}" for i in range(1, count + 1)]
                source = eb.get_template(eb.load(path))
                start = source.index('<section data-label="目录"')
                end = source.index("</section>", start)
                toc = source[start:end]
                buttons = re.findall(
                    r'<button\b[^>]*data-layer-btn="([^"]+)"[^>]*data-layer-group="toc"[^>]*>',
                    toc,
                )
                panels = re.findall(
                    r'<div\b[^>]*data-layer-panel="([^"]+)"[^>]*data-layer-group="toc"[^>]*>',
                    toc,
                )
                self.assertEqual(buttons, expected)
                self.assertEqual(panels, expected)
                self.assertEqual(toc.count('data-toc-visual-index="'), count)
                self.assertNotIn("data-mod", toc)
                self.assertNotIn("innerHTML", toc)
                button_tags = re.findall(r'<button\b[^>]+>', toc)
                self.assertEqual(sum("data-active" in tag for tag in button_tags), 1)
                panel_tags = re.findall(
                    r'<div\b[^>]*data-layer-panel="[^"]+"[^>]*>', toc
                )
                self.assertEqual(sum("data-active" in tag for tag in panel_tags), 1)

    def test_runtime_keeps_legacy_adapter_but_version_and_hash_are_current(self):
        for path in TEMPLATES:
            with self.subTest(template=path.name):
                source = eb.get_template(eb.load(path))
                self.assertIn("旧 Deck 兼容", source)
                self.assertIn("hasStandardToc", source)
                self.assertEqual(up.get_version(source), up.CURRENT_VERSION)
                stored = up.HASH_RE.search(source)
                self.assertIsNotNone(stored)
                self.assertEqual(stored.group(1), up.runtime_hash(source))

    def test_skill_forbids_private_view_state_and_switch_time_rebuilds(self):
        skill = (REPO / "SKILL.md").read_text(encoding="utf-8")
        animation = (REPO / "references" / "animation.md").read_text(encoding="utf-8")
        snippets = (REPO / "references" / "page-snippets.md").read_text(encoding="utf-8")
        for name, text in (("SKILL", skill), ("animation", animation), ("snippets", snippets)):
            with self.subTest(document=name):
                self.assertIn("data-layer-btn", text)
                self.assertIn("data-layer-panel", text)
                self.assertRegex(text, r"(?:禁止|不得)[^。\n]{0,120}innerHTML")


if __name__ == "__main__":
    unittest.main()
