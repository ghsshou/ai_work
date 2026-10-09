#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""upgrade_deck 的快速回归：用户页面 profile 不得被公共外壳覆盖。"""

import importlib.util
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parent.parent


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


eb = load_module("edit_bundle_test", REPO / "scripts" / "edit-bundle.py")
up = load_module("upgrade_deck_test", REPO / "scripts" / "upgrade_deck.py")
patch_bundle = load_module(
    "patch_bundle_upgrade_test", REPO / "scripts" / "editor" / "patch_bundle.py"
)


class UpgradeDeckProfileTest(unittest.TestCase):
    def setUp(self):
        self.latest_lines = eb.load(up.LATEST_TEMPLATES["teaching"])
        self.latest = eb.get_template(self.latest_lines)

    def customised_deck(self):
        old = self.latest
        profile = up._profile_style(old)
        custom_profile = profile.replace(
            'section[data-label="黑板·题卡A"], section[data-label="黑板·金框题卡"]',
            'section[data-label="本章小结"], section[data-label*="巩固"]',
        )
        old = old.replace(profile, custom_profile, 1)
        brand = up._profile_element(
            old, r'<button\b[^>]*\bid="brandbtn"[^>]*>.*?</button>'
        )
        old = old.replace(brand, brand.replace("大模型训练与微调", "用户课程标题"), 1)
        old = old.replace(".railpage-current {", ".railpage-current-legacy {", 1)
        lines = list(self.latest_lines)
        eb.set_template(lines, old)
        return lines, old, custom_profile

    def test_profile_does_not_change_runtime_hash(self):
        _, old, _ = self.customised_deck()
        profile_only = old.replace(
            ".railpage-current-legacy {", ".railpage-current {", 1
        )
        self.assertEqual(up.runtime_hash(profile_only), up.runtime_hash(self.latest))

    def test_legacy_brand_markers_preserve_user_slots_without_duplication(self):
        current = up.canonicalize_metadata(self.latest)
        current = up._replace_slot(current, up.USER_STYLE_START, up.USER_STYLE_END,
                                   '<style>.user-evidence{color:red}</style>')
        legacy = current.replace('aico-ppt-version', 'huawei-deck-version').replace(
            'aico-ppt-runtime-hash', 'huawei-deck-runtime-hash').replace(
            'aico-ppt-template-kind', 'huawei-deck-template-kind').replace(
            'AICO_PPT_USER_', 'HUAWEI_DECK_USER_')
        self.assertEqual(up.runtime_hash(current), up.runtime_hash(legacy))
        lines = list(self.latest_lines)
        eb.set_template(lines, legacy)
        upgraded, _, _ = up.build_upgrade(lines, self.latest_lines, 'teaching')
        self.assertIn('.user-evidence{color:red}', upgraded)
        self.assertEqual(upgraded.count(up.USER_STYLE_START), 1)
        self.assertEqual(upgraded.count(up.USER_SCRIPT_START), 1)
        self.assertEqual(up.runtime_hash(current), up.runtime_hash(upgraded))

    def test_recompose_preserves_page_profile_and_brand(self):
        old_lines, old, custom_profile = self.customised_deck()
        upgraded, manifest, target_hash = up.build_upgrade(
            old_lines, self.latest_lines, "teaching"
        )
        self.assertIn(custom_profile, upgraded)
        self.assertIn("用户课程标题", upgraded)
        self.assertIn(".railpage-current-legacy {", upgraded)
        self.assertNotEqual(target_hash, up.runtime_hash(upgraded))
        for uid, entry in eb.get_manifest(old_lines).items():
            self.assertEqual(entry, manifest[uid])

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "upgraded.html"
            result_lines = list(old_lines)
            eb.set_template(result_lines, upgraded)
            eb.set_manifest(result_lines, manifest)
            eb.save(output, result_lines)
            eb.verify(output)

    def test_legacy_three_way_merge_keeps_course_js_and_adds_latest_runtime(self):
        raw = up._git("show", "7c9773e8:assets/template-deck.html")
        old_lines = raw.split('\n')
        old = eb.get_template(old_lines)
        profile = up._profile_style(old)
        old = old.replace(
            profile,
            profile.replace(
                'section[data-label="黑板·题卡A"], section[data-label="黑板·金框题卡"]',
                'section[data-label="本章小结"], section[data-label*="巩固"]',
            ),
            1,
        )
        old = old.replace("FROM TOKEN TO MODEL", "CUSTOM COURSE PIPELINE", 1)
        old = old.replace("'动画·多组切换'", "'芯片架构三大特性'")
        eb.set_template(old_lines, old)

        upgraded, _, target_hash = up.build_upgrade(
            old_lines, self.latest_lines, "teaching"
        )
        self.assertIn('section[data-label*="巩固"]', upgraded)
        self.assertIn("CUSTOM COURSE PIPELINE", upgraded)
        self.assertIn("'芯片架构三大特性'", upgraded)
        self.assertIn('id="panlock"', upgraded)
        self.assertIn("this._presentWheelH = (e) =>", upgraded)
        self.assertEqual(up.HASH_RE.search(upgraded).group(1), target_hash)

    def test_recompose_preserves_patches_and_rebuilds_current_runtime(self):
        action = {
            "id": "patch-a",
            "taskId": None,
            "target": {
                "pageKey": "page-001-test",
                "path": "0",
                "tag": "DIV",
                "fingerprint": "01234567",
                "rect": {"x": 10, "y": 20, "w": 30, "h": 40},
            },
            "kind": "setText",
            "payload": {"text": "升级后仍保留"},
        }
        old = patch_bundle.replace_block(
            self.latest, [action], runtime_source="/* deliberately-old-runtime */"
        )
        old_lines = list(self.latest_lines)
        eb.set_template(old_lines, old)

        upgraded, _, _ = up.build_upgrade(old_lines, self.latest_lines, "teaching")

        self.assertEqual([action], patch_bundle.extract_patches(upgraded))
        self.assertEqual(1, upgraded.count(patch_bundle.BEGIN))
        self.assertNotIn("deliberately-old-runtime", upgraded)
        self.assertIn("com.huawei.deck.visual-editor.patch-runtime", upgraded)
        self.assertIn("HuaweiDeckEditorPatchStatus", upgraded)
        self.assertEqual(up.runtime_hash(self.latest), up.runtime_hash(upgraded))

    def test_only_known_toc_shell_conflict_prefers_business_renderer(self):
        conflict_head = "<" * 7
        conflict_split = "=" * 7
        conflict_tail = ">" * 7
        conflict = f"""{conflict_head} user
    const tocRender = () => {{ return 'business'; }};
    this._tocRender = tocRender;
    this._tocH = (e) => {{ return e; }};
{conflict_split}
    const tocBuilders = [animNN];
    if (!hasStandardToc) {{ useLegacyToc(); }}
{conflict_tail} latest
"""
        resolved = up.resolve_known_shell_conflicts(conflict)
        self.assertNotIn(conflict_head, resolved)
        self.assertIn("return 'business'", resolved)
        unknown = conflict.replace("const tocRender = () =>", "const other = () =>")
        self.assertIn(conflict_head, up.resolve_known_shell_conflicts(unknown))


if __name__ == "__main__":
    unittest.main()
