"""只比较源码快照中有持久身份的静态文字与行内样式，不猜测动态 DOM。"""
import json
import sys
from html.parser import HTMLParser


class Tree(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = {"tag": "root", "attrs": {}, "children": []}
        self.stack = [self.root]
        self.ids = {}
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        node = {"tag": tag, "attrs": dict(attrs), "children": []}
        self.stack[-1]["children"].append(node)
        identity = node["attrs"].get("data-editor-id")
        if identity:
            self.ids.setdefault(identity, []).append(node)
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index]["tag"] == tag:
                del self.stack[index:]
                return

    def handle_data(self, data):
        children = self.stack[-1]["children"]
        if children and isinstance(children[-1], str):
            children[-1] += data
        else:
            children.append(data)


def text(node):
    return node if isinstance(node, str) else "".join(text(child) for child in node["children"])


def target_node(tree, target):
    nodes = tree.ids.get(target.get("editorId"), [])
    if len(nodes) != 1 or nodes[0]["tag"] != target.get("tag", "").lower():
        return None
    node = nodes[0]
    if "textPath" in target:
        try:
            for part in target["textPath"].split("/"):
                node = node["children"][int(part)]
        except (KeyError, IndexError, ValueError, TypeError):
            return None
    return node


def source_impact(left, right):
    def extract(tree):
        pages = []
        def exterior(node):
            if isinstance(node, str):
                return node
            identity = node["attrs"].get("data-page-id")
            if node["tag"] == "section" and identity:
                pages.append((identity, node))
                return {"page": identity}
            return {"tag": node["tag"], "attrs": node["attrs"], "children": [exterior(c) for c in node["children"]]}
        shell = exterior(tree.root)
        return shell, pages
    # 页面内的 style/script 也可能影响其他页，无法证明局部作用域时升级完整流程。
    def shared(node):
        if isinstance(node, str):
            return []
        if node["tag"] in {"script", "style", "link"}:
            return [node]
        return [item for child in node["children"] for item in shared(child)]
    shell_a, pages_a = extract(left)
    shell_b, pages_b = extract(right)
    if not pages_a or shell_a != shell_b or shared(left.root) != shared(right.root) or [p[0] for p in pages_a] != [p[0] for p in pages_b]:
        return {"flow": "full-edit", "pageKeys": [p[0] for p in pages_b]}
    return {"flow": "page-structure", "pageKeys": [a[0] for a, b in zip(pages_a, pages_b) if a[1] != b[1]]}


def compare(before, after, actions):
    left, right = Tree(before), Tree(after)
    superseded, resize_baselines = [], {}
    for action in actions:
        target = action.get("target", {})
        a, b = target_node(left, target), target_node(right, target)
        if action.get("kind") == "resize" and "scale" not in action.get("payload", {}):
            # 原始声明完全一致才证明没有覆盖尺寸意图；布局计算值不参与证据。
            resize_baselines[action["id"]] = (
                a["attrs"].get("style", "")
                if isinstance(a, dict) and isinstance(b, dict)
                and a["attrs"] == b["attrs"] else None
            )
        if a is None or b is None:
            continue  # 缺失、重复或动态目标继续由真实浏览器验证。
        kind, payload = action.get("kind"), action.get("payload", {})
        changed = False
        if kind == "setText":
            changed = text(a) != text(b)
        elif kind == "setStyle" and payload.get("textRange"):
            changed = text(a) != text(b)
        # 样式不做字符串切分：CSS 可包含分号、变量及继承，无法证明时保持冲突。
        if changed:
            superseded.append(action["id"])
    return {"superseded": superseded, "resizeBaselines": resize_baselines, "impact": source_impact(left, right)}


if __name__ == "__main__":
    request = json.load(sys.stdin)
    print(json.dumps(compare(request["before"], request["after"], request["actions"])))
