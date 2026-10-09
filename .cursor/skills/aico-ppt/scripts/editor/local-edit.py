#!/usr/bin/env python3
"""在内存中生成有界局部结构候选；不执行模型脚本、不接触真实文件。"""
import base64
import html
import importlib.util
import json
from pathlib import Path
import re
import sys
from html.parser import HTMLParser

spec = importlib.util.spec_from_file_location('eb', Path(__file__).resolve().parents[1] / 'edit-bundle.py')
eb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(eb)
VOID = set('area base br col embed hr img input link meta param source track wbr'.split())

class Tree(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=False)
        self.source, self.nodes, self.stack = source, [], []
        self.lines = [0]
        self.lines += [m.end() for m in re.finditer('\n', source)]
        self.feed(source)
        self.close()

    def pos(self):
        row, col = self.getpos()
        return self.lines[row - 1] + col

    def handle_starttag(self, tag, attrs):
        start = self.pos()
        node = dict(tag=tag, attrs=dict(attrs), start=start, openEnd=start + len(self.get_starttag_text()), parent=self.stack[-1] if self.stack else None)
        if tag in VOID:
            node.update(end=node['openEnd'], closeStart=node['openEnd'])
        else:
            self.stack.append(node)
        self.nodes.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        node = self.nodes[-1]
        node.update(end=node['openEnd'], closeStart=node['openEnd'])
        if self.stack and self.stack[-1] is node:
            self.stack.pop()

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i]['tag'] == tag:
                node = self.stack[i]
                node.update(closeStart=self.pos(), end=self.source.index('>', self.pos()) + 1)
                del self.stack[i:]
                return


def opening(node, changes):
    attrs = {**node['attrs'], **changes}
    return '<' + node['tag'] + ''.join(' ' + k + ('="' + html.escape(str(v), quote=True) + '"' if v is not None else '') for k, v in attrs.items()) + '>'


def fragment(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 100000:
        raise ValueError('局部片段为空或过大')
    tree = Tree(value)
    for node in tree.nodes:
        if node['tag'] in {'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'section'}:
            raise ValueError('局部片段不能引入脚本、共享样式、嵌入页面或整页结构')
        for key, val in node['attrs'].items():
            if key.startswith('on') or key in {'srcdoc', 'data-page-id'}:
                raise ValueError('局部片段包含不允许的属性')
            if val and (re.search(r'(?:javascript|vbscript|file)\s*:', val, re.I) or re.search(r'expression\s*\(|@import', val, re.I)):
                raise ValueError('局部片段包含不允许的资源或表达式')
    return tree


def apply(source, operations, computed=None):
    if not isinstance(operations, list) or not 1 <= len(operations) <= 32:
        raise ValueError('局部操作数量必须为 1 到 32')
    for op in operations:
        target, payload = op.get('target', {}), op.get('payload', {})
        tree = Tree(source)
        matches = [n for n in tree.nodes if n['attrs'].get('data-editor-id') == target.get('editorId') and target.get('editorId')]
        if len(matches) != 1:
            raise ValueError('目标元素不存在或身份不唯一')
        node = matches[0]
        parent = node
        while parent and 'data-page-id' not in parent['attrs']:
            parent = parent['parent']
        if not parent or parent['attrs']['data-page-id'] != target.get('pageKey'):
            raise ValueError('目标不属于指定页面')
        if node is parent or 'end' not in node or 'data-page-id' in source[node['openEnd']:node['end']]:
            raise ValueError('局部操作不能替换整页或未闭合目标')
        old = source[node['start']:node['end']]
        kind = op.get('kind')
        if kind == 'setShape':
            shape = payload.get('shape')
            if shape not in {'triangle', 'rectangle', 'ellipse', 'diamond'} or node['tag'] != 'div':
                raise ValueError('形状替换仅支持 div 容器及 triangle/rectangle/ellipse/diamond')
            styles = dict(x.split(':', 1) for x in node['attrs'].get('data-aico-shape-style', node['attrs'].get('style', '')).split(';') if ':' in x)
            styles = {k.strip(): v.strip() for k, v in styles.items()}
            stroke = payload.get('stroke', '#566472')
            fill = payload.get('fill', '#fff')
            for color in (stroke, fill):
                if not isinstance(color, str) or not re.fullmatch(r'#[0-9a-fA-F]{3,8}|[a-zA-Z]+|rgba?\([0-9.,% ]+\)', color):
                    raise ValueError('形状颜色格式无效')
            width = payload.get('strokeWidth', 3)
            if not isinstance(width, (int, float)) or isinstance(width, bool) or not 0 <= width <= 20:
                raise ValueError('线宽必须为 0 到 20')
            points = {'triangle': '150,3 297,297 3,297', 'diamond': '150,3 297,150 150,297 3,150'}
            geometry = ('<polygon points="' + points[shape] + '"' if shape in points else '<ellipse cx="150" cy="150" rx="147" ry="147"' if shape == 'ellipse' else '<rect x="3" y="3" width="294" height="294"')
            svg = '<svg data-aico-shape-outline="true" aria-hidden="true" viewBox="0 0 300 300" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:-1">' + geometry + ' fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + str(width) + '" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>'
            # 只让旧轮廓透明，保留边框宽度与盒模型，避免形状变化造成尺寸和文字位移。
            styles.update({'border-color': 'transparent', 'border-radius': '0', 'background': 'transparent', 'box-shadow': 'none', 'isolation': 'isolate'})
            layout = (computed or {}).get(target['editorId'], {})
            position = layout.get('position', styles.get('position', 'static'))
            if position == 'static': styles['position'] = 'relative'
            # 竖排居中的文字移入三角形宽腹部；只调整已有固定外框，其他布局交由结果图检查。
            if shape == 'triangle' and layout.get('display') == 'flex' and layout.get('flexDirection') == 'column' and layout.get('boxSizing') == 'border-box':
                height = re.fullmatch(r'([0-9.]+)px', layout.get('height', ''))
                padding = re.fullmatch(r'([0-9.]+)px', layout.get('paddingBottom', ''))
                if height and padding:
                    styles.update({'justify-content': 'flex-end', 'padding-bottom': str(max(float(padding[1]), float(height[1]) * .08)) + 'px'})
            content = source[node['openEnd']:node['closeStart']]
            for child in reversed([n for n in tree.nodes if n['parent'] is node and n['attrs'].get('data-aico-shape-outline') == 'true']):
                content = content[:child['start'] - node['openEnd']] + content[child['end'] - node['openEnd']:]
            new = opening(node, {'style': ';'.join(k + ':' + v for k, v in styles.items()), 'data-aico-shape': shape,
                'data-aico-shape-style': node['attrs'].get('data-aico-shape-style', node['attrs'].get('style', ''))}) + svg + content + '</div>'
        elif kind == 'replaceFragment':
            new = payload.get('html')
            parsed = fragment(new)
            old_ids = {n['attrs']['data-editor-id'] for n in Tree(old).nodes if n['attrs'].get('data-editor-id')}
            new_ids = [n['attrs']['data-editor-id'] for n in parsed.nodes if n['attrs'].get('data-editor-id')]
            if not old_ids.issubset(set(new_ids)) or len(new_ids) != len(set(new_ids)):
                raise ValueError('替换片段必须保留原元素身份；删除请用 deleteElement')
        elif kind == 'insertFragment':
            inserted = payload.get('html')
            parsed = fragment(inserted)
            if any('data-editor-id' in n['attrs'] for n in parsed.nodes):
                raise ValueError('新增片段不要指定持久身份，由编辑器分配')
            if node['tag'] in VOID: raise ValueError('不能向空元素插入子节点')
            new = source[node['start']:node['closeStart']] + inserted + source[node['closeStart']:node['end']]
        elif kind == 'deleteElement':
            new = ''
        elif kind == 'duplicateElement':
            duplicate = re.sub(r'\sdata-editor-id=(?:"[^"]*"|\x27[^\x27]*\x27)', '', old)
            new = old + duplicate
        elif kind == 'replaceImage':
            src = payload.get('src')
            if node['tag'] != 'img' or not isinstance(src, str) or not re.match(r'^(https?://|data:image/(?:png|jpeg|webp|gif);base64,)', src):
                raise ValueError('图片替换需要 img 目标和 HTTP(S) 或受支持的图片 data URL')
            new = opening(node, {'src': src})
        else:
            raise ValueError('不支持的局部操作')
        source = source[:node['start']] + new + source[node['end']:]
    return source


def main():
    data = json.load(sys.stdin)
    # 模板 JSON 可包含 U+2028/U+2029；仅物理换行分隔 bundle，不能用 splitlines。
    lines = base64.b64decode(data['bytes']).decode('utf-8').split('\n')
    source = eb.get_template(lines)
    if data.get('mode') == 'inspect':
        target = data['target']
        nodes = [n for n in Tree(source).nodes if n['attrs'].get('data-editor-id') == target.get('editorId') and target.get('editorId')]
        if len(nodes) != 1: raise ValueError('源码目标不存在或身份不唯一')
        node = nodes[0]
        parent = node
        while parent and 'data-page-id' not in parent['attrs']: parent = parent['parent']
        if not parent or parent['attrs']['data-page-id'] != target.get('pageKey') or 'end' not in node: raise ValueError('源码目标不属于指定页面')
        snippet = source[node['start']:node['end']]
        if len(snippet) > 100000: raise ValueError('目标片段过大，请选择更小的区域')
        sys.stdout.write(json.dumps({'sourceHtml': snippet, 'sourceMode': '工作副本源码，未固化动作继续独立重放；保留原元素身份'}))
        return
    changed = apply(source, data['operations'], data.get('styles'))
    if source == changed: raise ValueError('操作没有产生修改')
    eb.set_template(lines, changed)
    sys.stdout.write(json.dumps({'bytes': base64.b64encode(('\n'.join(lines) + '\n').encode()).decode()}))

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
