import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "patch_bundle_test", ROOT / "scripts/editor/patch_bundle.py"
)
patch_bundle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(patch_bundle)


class PatchBundleTest(unittest.TestCase):
    def test_roundtrip_and_replace_keep_one_observable_block(self):
        patches = [{"id": "a", "kind": "setText", "payload": {"text": "新文字"}}]
        template = "<!doctype html><body><main></main></body>"

        first = patch_bundle.replace_block(template, patches, runtime_source="/* runtime-a */")
        second = patch_bundle.replace_block(first, patches, runtime_source="/* runtime-b */")

        self.assertEqual(patches, patch_bundle.extract_patches(second))
        self.assertEqual(1, second.count(patch_bundle.BEGIN))
        self.assertEqual(1, second.count(patch_bundle.END))
        self.assertNotIn("runtime-a", second)
        self.assertIn("runtime-b", second)
        self.assertIn("HuaweiDeckEditorPatchStatus", second)
        self.assertIn('state="applied"', second)

    def test_json_script_end_is_escaped(self):
        block = patch_bundle.build_block(
            [{"id": "a", "kind": "setText", "payload": {"text": "</script>"}}],
            runtime_source="/* runtime */",
        )

        script = block.split('id="huawei-deck-editor-patches">', 1)[1].split(
            "</script>", 1
        )[0]
        self.assertNotIn("</", script)
        self.assertIn("<\\u002Fscript>", script)

    def test_malformed_existing_block_is_rejected_instead_of_erased(self):
        malformed = (
            "<body>"
            f"{patch_bundle.BEGIN}"
            '<script id="huawei-deck-editor-patches" type="application/json">bad</script>'
            f"{patch_bundle.END}"
            "</body>"
        )

        with self.assertRaisesRegex(patch_bundle.PatchBundleError, "JSON 无效"):
            patch_bundle.replace_block(malformed, [])

    def test_solidified_patch_replay_uses_the_same_source_rebase_contract(self):
        block = patch_bundle.build_block(
            [{"id": "solidified-action", "kind": "setText", "payload": {"text": "新文字"}}],
            runtime_source="/* runtime */",
        )

        self.assertIn(
            "applyAll(patches,{rebaseActionIds:patches.map(patch=>patch.id)})",
            block,
        )
        self.assertIn("failedActionId", block)


if __name__ == "__main__":
    unittest.main()
