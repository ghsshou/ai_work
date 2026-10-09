#!/usr/bin/env python3
"""通用业务模板回归：来源覆盖、图形页型、无原案例补丁和身份契约。"""
import importlib.util
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('business_templates', ROOT / 'scripts/build-business-templates.py')
bt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bt)

class BusinessTemplatesTest(unittest.TestCase):
    def load(self, kind):
        lines = bt.eb.load(ROOT / f'assets/{kind}-deck.html')
        return lines, bt.eb.get_template(lines)

    def test_reference_pages_are_covered_once_in_ordered_catalog(self):
        for kind, count, reference_count in [('qualification', 22, 22), ('project-review', 54, 53)]:
            with self.subTest(template=kind):
                mapping = json.loads((ROOT / f'references/{kind}-page-map.json').read_text())
                self.assertEqual(list(range(1, count + 1)), [p['page'] for p in mapping['pages']])
                self.assertEqual(list(range(1, reference_count + 1)), sorted(p['referencePage'] for p in mapping['pages'] if p.get('referencePage')))
                _, source = self.load(kind)
                self.assertEqual(count, len(re.findall(r'<section data-label=', source)))
                ids = re.findall(r'data-page-id="([^"]+)"', source)
                self.assertEqual(count, len(ids))
                self.assertEqual(count, len(set(ids)))

    def test_templates_have_current_runtime_and_no_historical_actions(self):
        for kind in ['qualification', 'project-review']:
            with self.subTest(template=kind):
                _, source = self.load(kind)
                self.assertIsNone(bt.up.patch_bundle.extract_patches(source))
                self.assertEqual(bt.up.HASH_RE.search(source).group(1), bt.up.runtime_hash(source))
                self.assertEqual(bt.up.KIND_RE.search(source).group(1), kind)
                self.assertNotRegex(source, r'z00633277|武汉公共数智|eSpace_Desktop|renzhi-deck')

    def test_reference_diagrams_are_not_flattened_to_tables(self):
        _, source = self.load('project-review')
        for label in ['客户组织架构与沟通矩阵', '交易模式与合同界面', '智算集群整体技术架构', '项目整体组网拓扑', '业务网络设计', '管理网络设计', '端口布线与实施责任', '机房布局设计', '分泳道集成实施计划']:
            with self.subTest(page=label):
                start, end = bt.eb._slide_bounds(source, label)
                page = source[start:end]
                self.assertIn('<svg', page)
                self.assertIn('<text', page)
                self.assertNotIn('<img', page)
        _, source = self.load('qualification')
        # 任职内容页仅含可编辑图形与证据占位，不嵌入旧作者的案例截图。
        for label in re.findall(r'<section data-label="([^"]+)"', source)[2:-1]:
            start, end = bt.eb._slide_bounds(source, label)
            self.assertNotIn('<img', source[start:end])

if __name__ == '__main__':
    unittest.main()
