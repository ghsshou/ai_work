#!/usr/bin/env python3
"""用 Python 标准库按页提取 PPTX 内容和原图，供 AI 阅读；不渲染页面。"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import shutil
import sys
import tempfile
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET
import zipfile


# 限制展开内容，避免意外读取超大或损坏的参考文件。
MAX_PACKAGE_BYTES = 512 * 1024 * 1024
MAX_XML_BYTES = 16 * 1024 * 1024
MAX_MEDIA_BYTES = 128 * 1024 * 1024


def local(tag):
    return tag.rsplit("}", 1)[-1]


def children(element, name):
    return [child for child in element if local(child.tag) == name]


def content_nodes(element):
    """兼容内容只读一个分支，避免新版对象和备用对象被重复计入正文。"""
    yield element
    if element.tag == "{http://schemas.openxmlformats.org/markup-compatibility/2006}AlternateContent":
        branches = children(element, "Fallback") or children(element, "Choice")
        if branches:
            yield from content_nodes(branches[0])
    else:
        for child in element:
            yield from content_nodes(child)


def descendants(element, name):
    return [child for child in content_nodes(element) if local(child.tag) == name]


def attribute(element, name, default=""):
    return next((value for key, value in element.attrib.items() if local(key) == name), default)


def text_body(element):
    """保留段落、软换行与制表符；不把其他 XML 属性当正文。"""
    paragraphs = []
    for paragraph in descendants(element, "p"):
        parts = []
        for node in content_nodes(paragraph):
            kind = local(node.tag)
            if kind == "t":
                parts.append(node.text or "")
            elif kind == "br":
                parts.append("\n")
            elif kind == "tab":
                parts.append("\t")
        paragraphs.append("".join(parts))
    return "\n".join(paragraphs).strip()


class Package:
    def __init__(self, archive):
        self.archive = archive
        infos = archive.infolist()
        self.names = {entry.filename for entry in infos}
        if len(infos) != len(self.names):
            raise ValueError("PPTX 包含重复的内部文件名")
        if sum(entry.file_size for entry in infos) > MAX_PACKAGE_BYTES:
            raise ValueError("PPTX 展开内容超过 512 MiB，请拆分参考文件后重试")
        self.xml_cache = {}
        self.relationship_cache = {}
        types = self.xml("[Content_Types].xml")
        self.defaults = {node.get("Extension", "").lower(): node.get("ContentType", "") for node in children(types, "Default")}
        self.overrides = {unquote(node.get("PartName", "")).lstrip("/"): node.get("ContentType", "") for node in children(types, "Override")}

    def read(self, part, limit):
        if part not in self.names:
            raise ValueError(f"PPTX 引用的文件不存在：{part}")
        if self.archive.getinfo(part).file_size > limit:
            raise ValueError(f"PPTX 内部文件过大：{part}")
        return self.archive.read(part)

    def xml(self, part):
        if part not in self.xml_cache:
            self.xml_cache[part] = ET.fromstring(self.read(part, MAX_XML_BYTES))
        return self.xml_cache[part]

    def relationships(self, part):
        if part not in self.relationship_cache:
            path = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels") if part else "_rels/.rels"
            result = {}
            if path in self.names:
                for node in children(self.xml(path), "Relationship"):
                    identity = node.get("Id")
                    if not identity or identity in result:
                        raise ValueError(f"PPTX 关系编号缺失或重复：{path}")
                    result[identity] = node.attrib
            self.relationship_cache[part] = result
        return self.relationship_cache[part]

    def target(self, part, relation):
        if relation.get("TargetMode") == "External":
            raise ValueError(f"不读取外部关系：{part}")
        target = unquote(relation.get("Target", ""))
        parsed = urlsplit(target)
        if not target or "\\" in target or "\0" in target or parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
            raise ValueError(f"PPTX 内部引用无效：{target}")
        resolved = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join(posixpath.dirname(part), target))
        if resolved in (".", "..") or resolved.startswith("../"):
            raise ValueError(f"PPTX 内部引用越界：{target}")
        return resolved

    def related(self, part, kind):
        return [self.target(part, relation) for relation in self.relationships(part).values() if relation.get("Type", "").rsplit("/", 1)[-1] == kind]

    def content_type(self, part):
        return self.overrides.get(part, self.defaults.get(PurePosixPath(part).suffix[1:].lower(), "application/octet-stream"))


def placeholder(shape, layout_types):
    nodes = descendants(shape, "ph")
    if not nodes:
        return ""
    node = nodes[0]
    return node.get("type") or layout_types.get(node.get("idx", "0"), "")


def extract_tables(slide):
    tables = []
    for table in descendants(slide, "tbl"):
        rows, merged = [], []
        for row_index, row in enumerate(children(table, "tr")):
            values = []
            for column_index, cell in enumerate(children(row, "tc")):
                values.append(text_body(cell))
                row_span, column_span = int(cell.get("rowSpan", "1")), int(cell.get("gridSpan", "1"))
                continuation = any(cell.get(flag) in ("1", "true") for flag in ("hMerge", "vMerge"))
                if not continuation and (row_span > 1 or column_span > 1):
                    merged.append({"row": row_index, "column": column_index, "rowSpan": row_span, "columnSpan": column_span})
            rows.append(values)
        tables.append({"rows": rows, "mergedCells": merged})
    return tables


def extract_images(package, part, origin, media, warnings):
    images = []
    relationships = package.relationships(part)
    seen = set()
    # 原图保留兼容分支内的不同表示（例如 SVG 和备用 PNG），不套用正文分支选择。
    for node in package.xml(part).iter():
        if local(node.tag) not in ("blip", "svgBlip"):
            continue
        identity = attribute(node, "embed") or attribute(node, "link")
        if not identity or identity in seen:
            continue
        seen.add(identity)
        relation = relationships.get(identity)
        if relation is None:
            raise ValueError(f"图片关系不存在：{part} / {identity}")
        if relation.get("TargetMode") == "External":
            warnings.append(f"外部链接图片未下载：{relation.get('Target', '')}")
            continue
        target = package.target(part, relation)
        content = package.read(target, MAX_MEDIA_BYTES)
        digest = hashlib.sha256(content).hexdigest()
        if digest not in media:
            suffix = PurePosixPath(target).suffix.lower()
            if not suffix or not suffix[1:].isascii() or not suffix[1:].isalnum() or len(suffix) > 10:
                suffix = ".bin"
            media[digest] = {"path": f"media/{digest}{suffix}", "content": content}
        images.append({"path": media[digest]["path"], "sha256": digest, "contentType": package.content_type(target), "sourcePart": target, "origin": origin})
    return images


def read_presentation(source):
    media, slides = {}, []
    with zipfile.ZipFile(source) as archive:
        package = Package(archive)
        presentations = package.related("", "officeDocument")
        if len(presentations) != 1:
            raise ValueError("PPTX 必须包含唯一的演示文稿入口")
        presentation = presentations[0]
        tree = package.xml(presentation)
        if local(tree.tag) != "presentation":
            raise ValueError("输入文件不是 PPTX 演示文稿")
        relations = package.relationships(presentation)
        lists = children(tree, "sldIdLst")
        identities = children(lists[0], "sldId") if lists else []
        for number, identity in enumerate(identities, 1):
            # sldId 同时有普通 id 和命名空间 r:id；只读取后者作为关系键。
            key = next((value for name, value in identity.attrib.items() if name.startswith("{") and local(name) == "id"), "")
            if key not in relations:
                raise ValueError(f"第 {number} 页的关系不存在：{key}")
            part = package.target(presentation, relations[key])
            slide = package.xml(part)
            layouts = package.related(part, "slideLayout")
            layout_types = {}
            origins = [(part, "slide")]
            for layout in layouts:
                for node in descendants(package.xml(layout), "ph"):
                    layout_types[node.get("idx", "0")] = node.get("type", "")
                origins.append((layout, "layout"))
                origins.extend((master, "master") for master in package.related(layout, "slideMaster"))
            title, body, warnings = [], [], []
            for shape in descendants(slide, "sp"):
                text = "\n".join(filter(None, (text_body(value) for value in children(shape, "txBody"))))
                kind = placeholder(shape, layout_types)
                if text and kind not in ("sldNum", "dt", "ftr", "hdr"):
                    (title if kind in ("title", "ctrTitle") else body).append(text)
            # 版式 / 母版也可能承载固定文字；占位符中的编辑提示不属于页面正文。
            for inherited_part, _ in dict.fromkeys(origins[1:]):
                for shape in descendants(package.xml(inherited_part), "sp"):
                    if not descendants(shape, "ph"):
                        body.extend(filter(None, (text_body(value) for value in children(shape, "txBody"))))
            notes = []
            for notes_part in package.related(part, "notesSlide"):
                for shape in descendants(package.xml(notes_part), "sp"):
                    if placeholder(shape, {}) not in ("sldImg", "sldNum", "dt", "ftr", "hdr"):
                        notes.extend(filter(None, (text_body(value) for value in children(shape, "txBody"))))
            images = []
            for origin_part, origin in dict.fromkeys(origins):
                images.extend(extract_images(package, origin_part, origin, media, warnings))
            for name, label in (("chart", "图表"), ("relIds", "SmartArt"), ("oleObj", "嵌入对象")):
                if descendants(slide, name):
                    warnings.append(f"本页包含{label}，未提取其内部内容或渲染结果；需要时由 AI 直接读取原文件。")
            slides.append({"number": number, "sourcePart": part, "title": "\n".join(title), "text": "\n".join(body), "notes": "\n".join(notes), "tables": extract_tables(slide), "images": images, "warnings": list(dict.fromkeys(warnings))})
    return {"schemaVersion": 1, "source": str(source), "slides": slides}, media


def markdown(document):
    lines = ["# PPTX 内容提取", "", f"来源：{document['source']}", "", "按文件对象顺序提取文字；图片保留原始字节。该结果不表示页面的实际排版或阅读顺序。", ""]
    for slide in document["slides"]:
        lines.extend([f"## 第 {slide['number']} 页", ""])
        for field, label in (("title", "标题"), ("text", "正文"), ("notes", "备注")):
            if slide[field]:
                lines.extend([f"### {label}", "", slide[field], ""])
        for index, table in enumerate(slide["tables"], 1):
            lines.extend([f"### 表格 {index}", "", "```json", json.dumps(table, ensure_ascii=False, indent=2), "```", ""])
        if slide["images"]:
            lines.extend(["### 原始图片", ""])
            for image in slide["images"]:
                # 图片可由 AI 直接读取；SVG/EMF 等原始格式也不转码。
                lines.append(f"- [{image['sourcePart']}]({image['path']})（来源：{image['origin']}）")
            lines.append("")
        if slide["warnings"]:
            lines.extend(["### 提取范围", ""] + [f"- {warning}" for warning in slide["warnings"]] + [""])
    return "\n".join(lines)


def extract_pptx(source, output):
    source = Path(source).expanduser().resolve()
    output = Path(os.path.abspath(Path(output).expanduser()))
    if source.suffix.lower() != ".pptx":
        raise ValueError("仅支持未加密的 .pptx 文件；旧版 .ppt 请先另存为 .pptx")
    if os.path.lexists(output):
        raise ValueError(f"输出目录已存在，请指定新目录：{output}")
    document, media = read_presentation(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
    try:
        (temporary / "media").mkdir()
        for image in media.values():
            (temporary / image["path"]).write_bytes(image["content"])
        (temporary / "slides.json").write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (temporary / "slides.md").write_text(markdown(document), encoding="utf-8")
        if os.path.lexists(output):
            raise ValueError(f"输出目录已存在，请指定新目录：{output}")
        temporary.rename(output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return document


def main(argv=None):
    parser = argparse.ArgumentParser(description="按页提取 PPTX 的标题、正文、备注、表格和原图，供 AI 阅读。只用 Python 标准库，不渲染页面。")
    parser.add_argument("input", help="未加密的 .pptx 参考文件")
    parser.add_argument("output", help="新的输出目录，生成 slides.json、slides.md 和 media/")
    args = parser.parse_args(argv)
    try:
        document = extract_pptx(args.input, args.output)
    except (OSError, ValueError, ET.ParseError, zipfile.BadZipFile, RuntimeError) as error:
        print(f"PPTX 内容提取失败：{error}", file=sys.stderr)
        return 1
    print(f"已提取 {len(document['slides'])} 页：{Path(args.output).expanduser().absolute()}")
    return 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
