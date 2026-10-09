"""局部结构转换保持页面与元素身份，拒绝跨页和可执行片段。"""
import importlib.util
import subprocess
import sys
import base64
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('local_edit', Path(__file__).resolve().parents[1] / 'local-edit.py')
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)

class LocalEditTests(unittest.TestCase):
    def setUp(self):
        self.html = '<section data-page-id="p"><div data-editor-id="e" style="width:300px;height:300px"><b data-editor-id="b">内容不丢</b></div><img data-editor-id="i" src="old.png"></section>'
        self.target = {'pageKey':'p','editorId':'e','rect':{'h':300}}
    def apply(self, kind, payload=None, target=None):
        return local.apply(self.html,[{'target':target or self.target,'kind':kind,'payload':payload or {}}])
    def test_shape_preserves_content_and_can_change_again(self):
        self.html=self.apply('setShape',{'shape':'triangle'})
        result=self.apply('setShape',{'shape':'ellipse'})
        self.assertIn('内容不丢',result)
        self.assertEqual(result.count('data-aico-shape-outline='),1)
        self.assertIn('<ellipse',result)
        self.assertIn('data-editor-id="b"',result)
    def test_fragment_preserves_identity(self):
        result=self.apply('replaceFragment',{'html':'<div data-editor-id="e"><b data-editor-id="b">新内容</b></div>'})
        self.assertIn('新内容',result)
        with self.assertRaises(ValueError): self.apply('replaceFragment',{'html':'<div data-editor-id="e">丢失子元素</div>'})
    def test_rejects_code_and_wrong_page(self):
        for code in ['<script>alert(1)</script>','<img onerror="x()">','<iframe src="x">','<a href="javascript:alert(1)">x</a>']:
            with self.assertRaises(ValueError): self.apply('insertFragment',{'html':code})
        with self.assertRaises(ValueError): self.apply('deleteElement',target={'pageKey':'other','editorId':'e'})
    def test_bundle_unicode_separators_are_not_physical_lines(self):
        source=self.html.replace('内容不丢','内容\u2028仍在\u2029同一行')
        bundle='<script type="__bundler/template">\n'+json.dumps(source,ensure_ascii=False).replace('</','<\\u002F')+'\n</script>\n'
        request={'bytes':base64.b64encode(bundle.encode()).decode(),'operations':[{'target':self.target,'kind':'setShape','payload':{'shape':'triangle'}}]}
        result=subprocess.run([sys.executable,str(Path(local.__file__))],input=json.dumps(request),text=True,capture_output=True,encoding='utf-8')
        self.assertEqual(result.returncode,0,result.stderr)
        changed=base64.b64decode(json.loads(result.stdout)['bytes']).decode()
        self.assertIn('内容\u2028仍在\u2029同一行',changed)
    def test_insert_delete_duplicate_image(self):
        self.assertIn('<span>新增</span>',self.apply('insertFragment',{'html':'<span>新增</span>'}))
        self.assertNotIn('内容不丢',self.apply('deleteElement'))
        duplicated=self.apply('duplicateElement')
        self.assertEqual(duplicated.count('内容不丢'),2)
        self.assertEqual(duplicated.count('data-editor-id="e"'),1)
        self.assertIn('https://example.test/image.png',self.apply('replaceImage',{'src':'https://example.test/image.png'},{'pageKey':'p','editorId':'i'}))

if __name__=='__main__': unittest.main()
