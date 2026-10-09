import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[3]
MODULE_PATH = ROOT / "scripts" / "verify" / "toc_contract.py"
SPEC = importlib.util.spec_from_file_location("toc_contract", MODULE_PATH)
toc_contract = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(toc_contract)


def template_html() -> str:
    return """
<section data-label="目录">
  <button data-layer-btn="chapter-01" data-layer-group="toc" data-active><span class="toc-layer-name">示例一</span></button>
  <button data-layer-btn="chapter-02" data-layer-group="toc" data-step="0"><span class="toc-layer-name">示例二</span></button>
  <div data-layer-panel="chapter-01" data-layer-group="toc" data-active></div>
  <div data-layer-panel="chapter-02" data-layer-group="toc"></div>
</section>
const animNN = () => { return '<svg><circle cx="10" /></svg>'; };
const animAlgo = () => { return '<svg><rect width="10" /></svg>'; };
const tocBuilders = [animNN, animAlgo];
"""


def generated_html(*, inherited: bool = False, duplicate: bool = False) -> str:
    builders = "animNN, animAlgo" if inherited else "tocContext, tocMechanism"
    functions = "" if inherited else f"""
const tocContext = () => {{ return '<svg data-toc-animation-chapter="context" data-toc-animation-topic="明确约束"><path d="M1 2" /></svg>'; }};
const tocMechanism = () => {{ return '<svg data-toc-animation-chapter="mechanism" data-toc-animation-topic="解释机制"><path d="{'M1 2' if duplicate else 'M3 4'}" /></svg>'; }};
"""
    return f"""
<section data-label="目录">
  <button data-layer-btn="chapter-01" data-layer-group="toc" data-toc-chapter-id="context" data-active><span class="toc-layer-name">背景约束</span></button>
  <button data-layer-btn="chapter-02" data-layer-group="toc" data-toc-chapter-id="mechanism" data-step="0"><span class="toc-layer-name">核心机制</span></button>
  <div data-layer-panel="chapter-01" data-layer-group="toc" data-toc-chapter-id="context" data-toc-title="背景约束" data-active>
    <div data-toc-visual-index="0" data-toc-chapter-id="context" data-toc-animation-topic="明确约束"></div>
  </div>
  <div data-layer-panel="chapter-02" data-layer-group="toc" data-toc-chapter-id="mechanism" data-toc-title="核心机制">
    <div data-toc-visual-index="1" data-toc-chapter-id="mechanism" data-toc-animation-topic="解释机制"></div>
  </div>
</section>
const chapters = [{{name:'01 · 背景约束'}}, {{name:'02 · 核心机制'}}];
{functions}
const tocBuilders = [{builders}];
"""


CHAPTERS = [
    {"chapterId": "context", "title": "背景约束", "objective": "明确约束"},
    {"chapterId": "mechanism", "title": "核心机制", "objective": "解释机制"},
]


class TocContractTest(unittest.TestCase):
    def test_accepts_outline_bound_unique_animations(self):
        result = toc_contract.verify_toc_html(generated_html(), CHAPTERS, template_html())
        self.assertEqual(result["chapters"], 2)
        self.assertEqual(result["builders"], ["tocContext", "tocMechanism"])

    def test_rejects_inherited_template_animations(self):
        with self.assertRaisesRegex(ValueError, "继承模板示例动画"):
            toc_contract.verify_toc_html(
                generated_html(inherited=True), CHAPTERS, template_html(),
            )

    def test_rejects_same_animation_for_different_chapters(self):
        with self.assertRaisesRegex(ValueError, "复用了同一份目录动画"):
            toc_contract.verify_toc_html(
                generated_html(duplicate=True), CHAPTERS, template_html(),
            )

    def test_rejects_outline_count_mismatch(self):
        with self.assertRaisesRegex(ValueError, "目录数量必须与实际大纲一致"):
            toc_contract.verify_toc_html(generated_html(), CHAPTERS[:1], template_html())


if __name__ == "__main__":
    unittest.main()
