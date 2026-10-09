import base64
import importlib.util
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "aico_ppt_working_deck", ROOT / "scripts" / "editor" / "working_deck.py"
)
working_deck = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(working_deck)


class WorkingDeckUnicodeTest(unittest.TestCase):
    def test_json_surrogate_pairs_are_combined_before_utf8_bundle_write(self):
        value = {"target": {"text": "标题 \ud83d\ude80"}, "items": ["\ud83d\ude00"]}
        normalized = working_deck.normalize_json_surrogates(value)
        self.assertEqual(normalized, {"target": {"text": "标题 🚀"}, "items": ["😀"]})
        self.assertEqual(normalized["target"]["text"].encode("utf-8").decode(), "标题 🚀")

    def test_lone_json_surrogate_is_preserved_for_json_escape(self):
        lone = chr(0xD83D)
        self.assertEqual(
            working_deck.normalize_json_surrogates({"target": lone}),
            {"target": lone},
        )

    def test_prepare_and_normalize_assign_persistent_editor_ids(self):
        template = '''<!doctype html><body>
<div class="stage"><div class="slide-fit" data-idx="0"><div class="slide-canvas">
<section data-label="测试页"><div class="card"><h2>标题</h2></div></section>
</div></div></div>
<script>const nav = [
      { i:0, code:'测', label:'测试页' },
    ];</script></body>'''
        lines = [
            '<script type="__bundler/manifest">', '{}', '</script>',
            '<script type="__bundler/template">',
            working_deck.eb.dump_template(template), '</script>',
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "deck.html"
            path.write_text("\n".join(lines), encoding="utf-8")
            prepared = working_deck.prepare_working_copy(path)

        prepared_bytes = base64.b64decode(prepared["bytes"])
        prepared_lines = prepared_bytes.decode("utf-8").split("\n")
        prepared_template = working_deck.eb.get_template(prepared_lines)
        first_ids = working_deck.eb.editor_ids(prepared_template)
        self.assertEqual(len(first_ids), 2)
        self.assertTrue(all(item and item.startswith("element-") for item in first_ids))

        changed_template = prepared_template.replace(
            "</section>", "<p>Agent 新增内容</p></section>", 1
        )
        working_deck.eb.set_template(prepared_lines, changed_template)
        normalized = working_deck.normalize_working_copy_bytes(
            "\n".join(prepared_lines).encode("utf-8")
        )
        normalized_template = working_deck.eb.get_template(
            normalized.decode("utf-8").split("\n")
        )
        normalized_ids = working_deck.eb.editor_ids(normalized_template)
        self.assertEqual(normalized_ids[:2], first_ids)
        self.assertEqual(len(normalized_ids), 3)
        self.assertTrue(normalized_ids[2].startswith("element-"))

    def test_prepare_working_copy_does_not_seed_sc_for_descendants(self):
        template = '''<!doctype html><body>
<div class="stage"><div class="slide-fit" data-idx="0"><div class="slide-canvas">
<section data-label="循环页"><sc-for list="{{ items }}" as="item">
<div class="card"><span>{{ item }}</span></div></sc-for></section>
</div></div></div>
<script>const nav = [
      { i:0, code:'循', label:'循环页' },
    ];</script></body>'''
        lines = [
            '<script type="__bundler/manifest">', '{}', '</script>',
            '<script type="__bundler/template">',
            working_deck.eb.dump_template(template), '</script>',
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "deck.html"
            path.write_text("\n".join(lines), encoding="utf-8")
            prepared = working_deck.prepare_working_copy(path)

        prepared_template = working_deck.eb.get_template(
            base64.b64decode(prepared["bytes"]).decode("utf-8").split("\n")
        )
        loop_body = prepared_template[
            prepared_template.index('<sc-for') : prepared_template.index('</sc-for>')
        ]
        self.assertIn('data-editor-id=', loop_body.split('>', 1)[0])
        self.assertNotIn('data-editor-id=', loop_body.split('>', 1)[1])

    def test_normalize_working_copy_removes_legacy_sc_for_descendant_ids(self):
        loop_id = "element-" + "1" * 32
        legacy_id = "element-" + "2" * 32
        template = f'''<!doctype html><body>
<div class="stage"><div class="slide-fit" data-idx="0"><div class="slide-canvas">
<section data-label="循环页"><sc-for list="{{{{ items }}}}" as="item" data-editor-id="{loop_id}">
<div data-editor-id="{legacy_id}">{{{{ item }}}}</div></sc-for></section>
</div></div></div>
<script>const nav = [
      {{ i:0, code:'循', label:'循环页' }},
    ];</script></body>'''
        lines = [
            '<script type="__bundler/manifest">', '{}', '</script>',
            '<script type="__bundler/template">',
            working_deck.eb.dump_template(template), '</script>',
        ]

        normalized = working_deck.normalize_working_copy_bytes(
            "\n".join(lines).encode("utf-8")
        )

        normalized_template = working_deck.eb.get_template(
            normalized.decode("utf-8").split("\n")
        )
        self.assertIn(loop_id, normalized_template)
        self.assertNotIn(legacy_id, normalized_template)
        self.assertEqual(working_deck.eb.editor_ids(normalized_template), [loop_id])


if __name__ == "__main__":
    unittest.main()
