import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "edit_bundle", ROOT / "scripts/edit-bundle.py"
)
eb = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(eb)


def id_factory(*values):
    values = iter(values)
    return lambda: next(values)


class PersistentPageIdTest(unittest.TestCase):
    def test_save_validates_before_atomic_replace(self):
        template = '''
const nav = [
      { i:0, code:'甲', label:'甲页' },
    ];
const chapters = [{name:'章', start:0}];
<div class="slide-fit" data-idx="0"><div class="slide-canvas"><section data-label="甲页"></section></div></div>
'''
        original = [
            '<script type="__bundler/manifest">', '{}', '</script>',
            '<script type="__bundler/template">', eb.dump_template(template), '</script>',
        ]
        broken = list(original)
        broken[4] = eb.dump_template(template.replace(
            "      { i:0, code:'甲', label:'甲页' },\n", '',
        ))
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'deck.html'
            target.write_text('\n'.join(original), encoding='utf-8')
            with self.assertRaisesRegex(AssertionError, '三处同步'):
                eb.save(target, broken)
            self.assertEqual(target.read_text(encoding='utf-8'), '\n'.join(original))

    def test_dump_template_escapes_only_surrogate_code_units_and_script_end(self):
        source = "中文/" + chr(0xD83D) + "</script>"
        raw = eb.dump_template(source)
        self.assertIn("中文/", raw)
        self.assertIn(r"\ud83d", raw)
        self.assertIn(r"<\u002Fscript>", raw)
        self.assertEqual(eb.json.loads(raw), source)

    def test_ensure_page_ids_preserves_existing_and_fills_missing(self):
        existing = "page-" + "a" * 32
        created = "page-" + "b" * 32
        source = (
            '<section data-label="甲" data-page-id="%s"></section>'
            '<section data-label="乙"></section>'
        ) % existing

        result = eb.ensure_page_ids(source, id_factory(created))

        self.assertEqual(eb.page_ids(result), [existing, created])
        self.assertEqual(eb.ensure_page_ids(result), result)

    def test_duplicate_or_invalid_page_id_is_rejected(self):
        duplicate = "page-" + "c" * 32
        with self.assertRaisesRegex(ValueError, "重复"):
            eb.ensure_page_ids(
                '<section data-label="甲" data-page-id="%s"></section>'
                '<section data-label="乙" data-page-id="%s"></section>'
                % (duplicate, duplicate)
            )
        with self.assertRaisesRegex(ValueError, "格式无效"):
            eb.ensure_page_ids(
                '<section data-label="甲" data-page-id="page-bad"></section>'
            )

    def test_ensure_editor_ids_preserves_existing_and_fills_page_descendants(self):
        existing = "element-" + "a" * 32
        created = ["element-" + value * 32 for value in "bcde"]
        source = (
            '<script>const fake = \'<section data-label="伪"><h2>不要处理</h2></section>\';</script>'
            '<section data-label="甲">'
            '<div data-note="a>b"><h2 data-editor-id="%s">标题<span>强调</span></h2>'
            '<img src="asset.png"></div>'
            '<style>.fake::after{content:"<p>不要处理</p>"}</style>'
            '<script>const fake = "<button>不要处理</button>";</script>'
            '</section>'
        ) % existing

        result = eb.ensure_editor_ids(source, id_factory(*created))

        self.assertEqual(eb.editor_ids(result), [created[0], existing, created[1], created[2]])
        self.assertEqual(eb.ensure_editor_ids(result), result)
        self.assertIn('data-note="a>b"', result)
        self.assertEqual(result.count('data-editor-id='), 4)

    def test_duplicate_or_invalid_editor_id_is_rejected(self):
        duplicate = "element-" + "c" * 32
        with self.assertRaisesRegex(ValueError, "data-editor-id 重复"):
            eb.ensure_editor_ids(
                '<section data-label="甲"><h2 data-editor-id="%s">甲</h2>'
                '<p data-editor-id="%s">乙</p></section>' % (duplicate, duplicate)
            )
        with self.assertRaisesRegex(ValueError, "data-editor-id 格式无效"):
            eb.ensure_editor_ids(
                '<section data-label="甲"><h2 data-editor-id="element-bad">甲</h2></section>'
            )

    def test_ensure_editor_ids_skips_sc_for_template_descendants(self):
        created = ["element-" + value * 32 for value in "abc"]
        source = (
            '<section data-label="循环页"><div>静态容器'
            '<sc-for list="{{ items }}" as="item"><article>'
            '<span>{{ item }}</span></article></sc-for>'
            '<p>静态结尾</p></div></section>'
        )

        result = eb.ensure_editor_ids(source, id_factory(*created))

        self.assertRegex(
            result,
            r'<div data-editor-id="element-a{32}">静态容器'
            r'<sc-for[^>]*data-editor-id="element-b{32}">'
            r'<article><span>{{ item }}</span></article></sc-for>'
            r'<p data-editor-id="element-c{32}">静态结尾</p>',
        )
        self.assertEqual(eb.editor_ids(result), created)
        self.assertEqual(eb.ensure_editor_ids(result), result)

    def test_ensure_editor_ids_removes_legacy_ids_inside_sc_for(self):
        outer = "element-" + "1" * 32
        loop = "element-" + "2" * 32
        legacy = "element-" + "3" * 32
        tail = "element-" + "4" * 32
        source = (
            '<section data-label="循环页">'
            f'<div data-editor-id="{outer}">'
            f'<sc-for list="{{{{ items }}}}" as="item" data-editor-id="{loop}">'
            f'<span data-editor-id="{legacy}">{{{{ item }}}}</span></sc-for>'
            f'<p data-editor-id="{tail}">静态结尾</p></div></section>'
        )

        result = eb.ensure_editor_ids(source)

        self.assertNotIn(legacy, result)
        self.assertEqual(eb.editor_ids(result), [outer, loop, tail])
        self.assertEqual(eb.ensure_editor_ids(result), result)

    def test_insert_page_assigns_fresh_identity_even_when_copy_has_an_id(self):
        first = "page-" + "1" * 32
        second = "page-" + "2" * 32
        inserted = "page-" + "3" * 32
        source = '''
const nav = [
      { i:0, code:'甲', label:'甲页' },
      { i:1, code:'乙', label:'乙页' },
    ];
const chapters = [{name:'章', start:0}];

    <div class="slide-fit" data-idx="0"><div class="slide-canvas"><section data-label="甲页" data-page-id="%s"></section></div></div>

    <div class="slide-fit" data-idx="1"><div class="slide-canvas"><section data-label="乙页" data-page-id="%s"></section></div></div>''' % (first, second)
        copied = (
            '<div class="slide-fit" data-idx="9"><div class="slide-canvas">'
            '<section data-label="插页" data-page-id="%s"></section></div></div>' % first
        )

        result = eb.insert_page(
            source, copied, before_label="乙页", nav_code="插", nav_label="插页",
            id_factory=id_factory(inserted),
        )

        self.assertEqual(eb.page_ids(result), [first, inserted, second])

    def test_move_keeps_page_identity_and_delete_removes_only_target_identity(self):
        first = "page-" + "1" * 32
        second = "page-" + "2" * 32
        third = "page-" + "3" * 32
        source = '''
const nav = [
      { i:0, code:'甲', label:'甲页' },
      { i:1, code:'乙', label:'乙页' },
      { i:2, code:'丙', label:'丙页' },
    ];
const chapters = [{name:'章', start:0}];

    <div class="slide-fit" data-idx="0"><div class="slide-canvas"><section data-label="甲页" data-page-id="%s"></section></div></div>

    <div class="slide-fit" data-idx="1"><div class="slide-canvas"><section data-label="乙页" data-page-id="%s"></section></div></div>

    <div class="slide-fit" data-idx="2"><div class="slide-canvas"><section data-label="丙页" data-page-id="%s"></section></div></div>''' % (first, second, third)

        moved = eb.move_page(source, "甲页", "丙页")
        self.assertEqual(eb.page_ids(moved), [second, third, first])
        deleted = eb.delete_page(moved, "丙页")
        self.assertEqual(eb.page_ids(deleted), [second, first])

    def test_delete_page_by_id_uses_stable_identity(self):
        first = "page-" + "1" * 32
        second = "page-" + "2" * 32
        source = '''
const nav = [
      { i:0, code:'甲', label:'甲页' },
      { i:1, code:'乙', label:'乙页' },
    ];
const chapters = [{name:'章', start:0}];

    <div class="slide-fit" data-idx="0"><div class="slide-canvas"><section data-label="甲页" data-page-id="%s"></section></div></div>

    <div class="slide-fit" data-idx="1"><div class="slide-canvas"><section data-label="乙页" data-page-id="%s"></section></div></div>''' % (first, second)

        deleted = eb.delete_page_by_id(source, second)
        self.assertEqual(eb.page_ids(deleted), [first])
        self.assertIn("label:'甲页'", deleted)
        self.assertNotIn("label:'乙页'", deleted)
        with self.assertRaisesRegex(ValueError, '必须唯一命中'):
            eb.delete_page_by_id(source, "page-" + "f" * 32)


if __name__ == "__main__":
    unittest.main()
