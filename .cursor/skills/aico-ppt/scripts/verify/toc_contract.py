#!/usr/bin/env python3
"""验证新建 Deck 的目录数量、章节文字和逐章动画是否与实际大纲一致。"""

from __future__ import annotations

import argparse
from html.parser import HTMLParser
import html as html_lib
import importlib.util
import json
from pathlib import Path
import re
import sys


PROJECT_DIR = Path(__file__).resolve().parents[2]
EDIT_BUNDLE_PATH = PROJECT_DIR / "scripts" / "edit-bundle.py"
IDENTIFIER = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")


def load_edit_bundle():
    spec = importlib.util.spec_from_file_location("aico_ppt_edit_bundle", EDIT_BUNDLE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 scripts/edit-bundle.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def normalized_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


class TocHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.toc_found = False
        self.toc_depth: int | None = None
        self.buttons: list[dict] = []
        self.panels: list[dict] = []
        self.visuals: list[dict] = []
        self._button: dict | None = None
        self._button_depth: int | None = None
        self._name_depth: int | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        self.stack.append(tag)
        if tag == "section" and values.get("data-label") == "目录":
            if self.toc_found:
                raise ValueError("Deck 中存在多个目录页")
            self.toc_found = True
            self.toc_depth = len(self.stack)
        if self.toc_depth is None:
            return
        group = values.get("data-layer-group")
        if group == "toc" and "data-layer-btn" in values:
            self._button = {"attrs": values, "name": ""}
            self._button_depth = len(self.stack)
            self.buttons.append(self._button)
        if group == "toc" and "data-layer-panel" in values:
            self.panels.append({"attrs": values})
        if "data-toc-visual-index" in values:
            self.visuals.append({"attrs": values})
        classes = set((values.get("class") or "").split())
        if self._button is not None and "toc-layer-name" in classes:
            self._name_depth = len(self.stack)

    def handle_data(self, data: str) -> None:
        if self._button is not None and self._name_depth is not None:
            self._button["name"] += data

    def handle_endtag(self, tag: str) -> None:
        depth = len(self.stack)
        if self._name_depth == depth:
            self._name_depth = None
        if self._button_depth == depth:
            self._button = None
            self._button_depth = None
        if self.toc_depth == depth and tag == "section":
            self.toc_depth = None
        if self.stack:
            self.stack.pop()


def parse_toc(html: str) -> TocHTMLParser:
    parser = TocHTMLParser()
    parser.feed(html)
    if not parser.toc_found:
        raise ValueError("Deck 缺少 data-label=目录 的目录页")
    return parser


def extract_array_identifiers(html: str) -> list[str]:
    declarations = list(re.finditer(r"\bconst\s+tocBuilders\s*=\s*\[([^\]]*)\]\s*;", html, re.S))
    if len(declarations) != 1:
        raise ValueError("必须且只能声明一个 const tocBuilders 数组")
    values = [item.strip() for item in declarations[0].group(1).split(",") if item.strip()]
    if not values or not all(IDENTIFIER.fullmatch(item) for item in values):
        raise ValueError("tocBuilders 只能按章节顺序引用具名动画函数")
    return values


def function_body(html: str, name: str) -> str:
    patterns = [
        rf"\bconst\s+{re.escape(name)}\s*=\s*\([^)]*\)\s*=>\s*\{{",
        rf"\bfunction\s+{re.escape(name)}\s*\([^)]*\)\s*\{{",
    ]
    opening = None
    for pattern in patterns:
        match = re.search(pattern, html)
        if match:
            opening = match.end() - 1
            break
    if opening is None:
        raise ValueError(f"目录动画函数不存在：{name}")
    depth = 0
    quote = None
    escaped = False
    index = opening
    while index < len(html):
        char = html[index]
        next_char = html[index + 1] if index + 1 < len(html) else ""
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
        elif char in "'\"`":
            quote = char
        elif char == "/" and next_char == "/":
            newline = html.find("\n", index + 2)
            index = len(html) if newline < 0 else newline
            continue
        elif char == "/" and next_char == "*":
            closing = html.find("*/", index + 2)
            index = len(html) if closing < 0 else closing + 2
            continue
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return html[opening + 1:index]
        index += 1
    raise ValueError(f"目录动画函数未闭合：{name}")


def semantic_animation(body: str) -> str:
    value = re.sub(r"data-toc-animation-(?:chapter|topic)=['\"][^'\"]*['\"]", "", body)
    value = re.sub(r"/\*.*?\*/|//[^\n]*", "", value, flags=re.S)
    return re.sub(r"\s+", "", value)


def animation_attribute(body: str, name: str) -> str | None:
    match = re.search(
        rf"\b{re.escape(name)}\s*=\s*(['\"])(.*?)\1",
        body,
        re.S,
    )
    return None if match is None else normalized_text(html_lib.unescape(match.group(2)))


def load_contract(path: Path) -> list[dict]:
    value = json.loads(path.read_text(encoding="utf-8"))
    chapters = value.get("chapters") if value.get("version") == 1 else None
    if not isinstance(chapters, list) or not chapters:
        raise ValueError("目录契约必须是 version=1 且包含非空 chapters")
    normalized = []
    ids = set()
    for index, chapter in enumerate(chapters):
        chapter_id = chapter.get("chapterId") if isinstance(chapter, dict) else None
        title = chapter.get("title") if isinstance(chapter, dict) else None
        objective = chapter.get("objective") if isinstance(chapter, dict) else None
        if not isinstance(chapter_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", chapter_id):
            raise ValueError(f"第 {index + 1} 章 chapterId 无效")
        if chapter_id in ids or not isinstance(title, str) or not title.strip() \
                or not isinstance(objective, str) or not objective.strip():
            raise ValueError(f"第 {index + 1} 章目录契约无效或重复")
        ids.add(chapter_id)
        normalized.append({
            "chapterId": chapter_id,
            "title": normalized_text(title),
            "objective": normalized_text(objective),
        })
    return normalized


def javascript_chapter_titles(html: str) -> list[str]:
    match = re.search(r"\bconst\s+chapters\s*=\s*\[([\s\S]*?)\]\s*;", html)
    if not match:
        raise ValueError("Deck 缺少 chapters[] 导航数据")
    titles = re.findall(r"\bname\s*:\s*(['\"])(.*?)\1", match.group(1), re.S)
    return [re.sub(r"^\s*\d+\s*[·.．、-]\s*", "", normalized_text(title)) for _, title in titles]


def verify_toc_html(html: str, chapters: list[dict], template_html: str) -> dict:
    toc = parse_toc(html)
    count = len(chapters)
    if len(toc.buttons) != count or len(toc.panels) != count or len(toc.visuals) != count:
        raise ValueError(
            f"目录数量必须与实际大纲一致：大纲 {count} 章，按钮 {len(toc.buttons)}、面板 {len(toc.panels)}、动画 {len(toc.visuals)}",
        )
    nav_titles = javascript_chapter_titles(html)
    expected_titles = [chapter["title"] for chapter in chapters]
    if nav_titles != expected_titles:
        raise ValueError("chapters[] 的数量或章名与已确认大纲不一致")

    for index, chapter in enumerate(chapters):
        key = f"chapter-{index + 1:02d}"
        button = toc.buttons[index]
        panel = toc.panels[index]
        visual = toc.visuals[index]
        button_attrs = button["attrs"]
        panel_attrs = panel["attrs"]
        visual_attrs = visual["attrs"]
        if button_attrs.get("data-layer-btn") != key or panel_attrs.get("data-layer-panel") != key:
            raise ValueError(f"第 {index + 1} 章目录按钮与面板 key 不配对")
        if button_attrs.get("data-toc-chapter-id") != chapter["chapterId"] \
                or panel_attrs.get("data-toc-chapter-id") != chapter["chapterId"] \
                or visual_attrs.get("data-toc-chapter-id") != chapter["chapterId"]:
            raise ValueError(f"第 {index + 1} 章目录项未绑定 chapterId={chapter['chapterId']}")
        if normalized_text(button["name"]) != chapter["title"] \
                or normalized_text(panel_attrs.get("data-toc-title") or "") != chapter["title"]:
            raise ValueError(f"第 {index + 1} 章目录标题与已确认大纲不一致")
        if normalized_text(visual_attrs.get("data-toc-animation-topic") or "") != chapter["objective"]:
            raise ValueError(f"第 {index + 1} 章目录动画没有绑定本章目标")
        try:
            visual_index = int(visual_attrs.get("data-toc-visual-index") or "")
        except ValueError as error:
            raise ValueError(f"第 {index + 1} 章目录动画索引无效") from error
        if visual_index != index:
            raise ValueError(f"第 {index + 1} 章目录动画索引必须连续")
        if index == 0:
            if "data-active" not in button_attrs or "data-active" not in panel_attrs \
                    or "data-step" in button_attrs:
                raise ValueError("目录第一章必须是唯一默认层，且不写 data-step")
        else:
            if button_attrs.get("data-step") != str(index - 1) \
                    or "data-active" in button_attrs or "data-active" in panel_attrs:
                raise ValueError("目录后续章节必须按 0、1、2… 连续编号 data-step")

    builders = extract_array_identifiers(html)
    inherited = set(extract_array_identifiers(template_html))
    if len(builders) != count or len(set(builders)) != count:
        raise ValueError("tocBuilders 数量必须等于实际章数，且每章使用独立动画函数")
    if inherited.intersection(builders):
        raise ValueError("目录仍在直接继承模板示例动画，必须按每章内容重新制作")
    source_bodies = {semantic_animation(function_body(template_html, name)) for name in inherited}
    generated_bodies = []
    for chapter, builder in zip(chapters, builders):
        body = function_body(html, builder)
        if animation_attribute(body, "data-toc-animation-chapter") != chapter["chapterId"] \
                or animation_attribute(body, "data-toc-animation-topic") != chapter["objective"]:
            raise ValueError(f"目录动画 {builder} 缺少本章 ID 或目标语义标记")
        semantic = semantic_animation(body)
        if semantic in source_bodies:
            raise ValueError(f"目录动画 {builder} 只改了名字，仍继承模板示例内容")
        generated_bodies.append(semantic)
    if len(set(generated_bodies)) != count:
        raise ValueError("不同章节复用了同一份目录动画，必须逐章表达不同内容")
    return {"ok": True, "chapters": count, "builders": builders}


def verify(deck_path: Path, contract_path: Path, template_path: Path) -> dict:
    edit_bundle = load_edit_bundle()
    html = edit_bundle.get_template(edit_bundle.load(str(deck_path)))
    template_html = edit_bundle.get_template(edit_bundle.load(str(template_path)))
    result = verify_toc_html(html, load_contract(contract_path), template_html)
    return {**result, "deckPath": str(deck_path.resolve()), "check": "toc-contract"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="验证目录数量、章节绑定和逐章动画")
    parser.add_argument("deck")
    parser.add_argument("--contract", required=True, help="version=1 的章节契约 JSON")
    parser.add_argument("--template", required=True, help="所选原始模板 Deck")
    args = parser.parse_args(argv)
    try:
        result = verify(Path(args.deck), Path(args.contract), Path(args.template))
    except Exception as error:  # noqa: BLE001 - CLI 统一返回稳定错误
        print(json.dumps({"ok": False, "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
