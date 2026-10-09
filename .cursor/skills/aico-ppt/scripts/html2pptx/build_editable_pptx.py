#!/usr/bin/env python3
"""把逻辑像素 manifest 写成原生可编辑 PPTX；图片保持原始字节。

用法：python3 build_editable_pptx.py <manifestDir> <output.pptx> [embed.html]
正文、形状、图片和无合并单元格表格仅使用标准库；可选 HTML 附件图标使用 Pillow。
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path, PureWindowsPath
import re
import sys
import tempfile
from xml.sax.saxutils import escape, quoteattr
from zipfile import ZipFile, ZIP_DEFLATED

from build_pptx import A, P, R, WIDTH, HEIGHT, base_parts, make_icon, picture, relationships, xml


COLOR = re.compile(r"^[0-9a-fA-F]{6}$")
INVALID_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]")
ALIGN = {"left": "l", "center": "ctr", "right": "r"}
VERTICAL = {"top": "t", "center": "ctr", "bottom": "b"}
TABLE_URI = "http://schemas.openxmlformats.org/drawingml/2006/table"
OLE_URI = "http://schemas.openxmlformats.org/presentationml/2006/ole"


def number(value, name, minimum=None):
    """拒绝 JSON 布尔值、非有限数值和越界尺寸。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} 必须是有限数值")
    if minimum is not None and value < minimum:
        raise ValueError(f"{name} 不得小于 {minimum}")
    return value


def string(value, name, nonempty=False):
    if not isinstance(value, str) or INVALID_XML.search(value) or (nonempty and not value):
        raise ValueError(f"{name} 必须是不含非法 XML 字符的字符串")
    return value


def record(value, name):
    if not isinstance(value, dict):
        raise ValueError(f"{name} 必须是对象")
    return value


def sequence(value, name, nonempty=False):
    if not isinstance(value, list) or (nonempty and not value):
        raise ValueError(f"{name} 必须是{'非空' if nonempty else ''}列表")
    return value


def color(value):
    if not isinstance(value, str) or not COLOR.fullmatch(value):
        raise ValueError("颜色必须是六位 RRGGBB 十六进制字符串")
    return value.upper()


def solid_fill(value=None, opacity=1):
    opacity = number(opacity, "透明度", 0)
    if opacity > 1:
        raise ValueError("透明度不得大于 1")
    if value is None:
        return "<a:noFill/>"
    return f'<a:solidFill><a:srgbClr val="{color(value)}"><a:alpha val="{round(opacity * 100000)}"/></a:srgbClr></a:solidFill>'


def local_media(directory, name):
    """素材文件必须使用 manifest 目录内的相对路径，包含软链接时也不得越界。"""
    string(name, "图片路径", True)
    if "\\" in name or PureWindowsPath(name).drive or Path(name).is_absolute() or ".." in Path(name).parts:
        raise ValueError("图片路径必须位于 manifest 目录内")
    path = (directory / name).resolve(strict=True)
    if not path.is_relative_to(directory) or not path.is_file():
        raise ValueError("图片路径必须位于 manifest 目录内")
    image = path.read_bytes()
    if image.startswith(b"\x89PNG\r\n\x1a\n"):
        return image, "png"
    if image.startswith(b"\xff\xd8\xff"):
        return image, "jpg"
    raise ValueError(f"图片必须是 PNG 或 JPEG：{name}")


class Drawing:
    """将同一逻辑画布的几何和文本映射到固定 16:9 幻灯片。"""
    def __init__(self, width, height):
        self.sx = WIDTH / number(width, "画布宽度", 1)
        self.sy = HEIGHT / number(height, "画布高度", 1)

    def x(self, value):
        return round(number(value, "横向坐标或尺寸") * self.sx)

    def y(self, value):
        return round(number(value, "纵向坐标或尺寸") * self.sy)

    def points(self, value, name):
        # 字号与几何共用画布比例，单位为 1/100 pt；1920px→960pt 时 64px=32pt。
        # 不能再次按浏览器截图倍率缩小，也不能只把字号按 72/96 换算而保留页面尺寸。
        return round(number(value, name, 0) * self.sy / 127)

    def box(self, element, line=False):
        left, top = self.x(element.get("x")), self.y(element.get("y"))
        width = number(element.get("width"), "元素宽度", 0)
        height = number(element.get("height"), "元素高度", 0)
        if (not line and (width == 0 or height == 0)) or (width == 0 and height == 0):
            raise ValueError("元素尺寸必须大于零；直线允许一边为零")
        return left, top, self.x(width), self.y(height)

    def transform(self, box, prefix="a"):
        left, top, width, height = box
        return f'<{prefix}:xfrm><a:off x="{left}" y="{top}"/><a:ext cx="{width}" cy="{height}"/></{prefix}:xfrm>'

    def line(self, border=None, tag="ln"):
        if border is None:
            return f"<a:{tag}><a:noFill/></a:{tag}>"
        record(border, "边框")
        width = self.y(number(border.get("width"), "边框宽度", 0))
        fill = solid_fill(color(border.get("color")), border.get("opacity", 1))
        return f'<a:{tag} w="{width}">{fill}<a:prstDash val="solid"/></a:{tag}>'

    def paragraphs(self, paragraphs):
        result = []
        for paragraph in sequence(paragraphs, "段落"):
            record(paragraph, "段落")
            alignment = paragraph.get("align")
            if not isinstance(alignment, str) or alignment not in ALIGN:
                raise ValueError("段落对齐必须是 left、center 或 right")
            spacing = ""
            if "lineHeight" in paragraph:
                height = self.points(paragraph["lineHeight"], "行高")
                if height <= 0:
                    raise ValueError("行高必须大于零")
                spacing = f'<a:lnSpc><a:spcPts val="{height}"/></a:lnSpc>'
            runs = []
            for run in sequence(paragraph.get("runs"), "文字片段"):
                record(run, "文字片段")
                text = string(run.get("text"), "文字")
                font = string(run.get("fontFamily"), "字体名称", True)
                size = self.points(run.get("fontSize"), "字号")
                if not 100 <= size <= 400000:
                    raise ValueError("转换后的字号必须位于 1–4000 pt")
                for key in ("bold", "italic", "underline"):
                    if key in run and not isinstance(run[key], bool):
                        raise ValueError(f"{key} 必须是布尔值")
                attributes = f'sz="{size}" b="{int(run.get("bold", False))}" i="{int(run.get("italic", False))}" u="{"sng" if run.get("underline", False) else "none"}"'
                # a:rPr/@spc 的整数单位是 1/100 pt，负数表示缩紧字间距。
                if "charSpacing" in run:
                    character_spacing = round(number(run["charSpacing"], "字间距") * self.sx / 127)
                    if not -400000 <= character_spacing <= 400000:
                        raise ValueError("转换后的字间距必须位于 -4000–4000 pt")
                    attributes += f' spc="{character_spacing}"'
                formatting = f'<a:rPr {attributes}>{solid_fill(color(run.get("color")), run.get("opacity", 1))}<a:latin typeface={quoteattr(font)}/><a:ea typeface={quoteattr(font)}/><a:cs typeface={quoteattr(font)}/></a:rPr>'
                # 软换行使用独立 br 元素，保留同一段落内的字体样式。
                for index, line in enumerate(text.replace("\r\n", "\n").replace("\r", "\n").split("\n")):
                    if index:
                        runs.append(f"<a:br>{formatting}</a:br>")
                    runs.append(f'<a:r>{formatting}<a:t xml:space="preserve">{escape(line)}</a:t></a:r>')
            result.append(f'<a:p><a:pPr algn="{ALIGN[alignment]}" marL="0" marR="0" indent="0">{spacing}<a:spcBef><a:spcPts val="0"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft><a:buNone/></a:pPr>{"".join(runs)}<a:endParaRPr/></a:p>')
        return "".join(result) or "<a:p><a:endParaRPr/></a:p>"

    def text_body(self, paragraphs, cell=False, wrap=True, top_inset=0):
        if not isinstance(wrap, bool):
            raise ValueError("文字 wrap 必须是布尔值")
        inset = self.y(number(top_inset, "文字顶部内边距", 0))
        properties = '' if cell else f' anchor="t" lIns="0" tIns="{inset}" rIns="0" bIns="0"'
        return f'<a:bodyPr wrap="{"square" if wrap else "none"}"{properties}><a:noAutofit/></a:bodyPr><a:lstStyle/>{self.paragraphs(paragraphs)}'

    def text(self, element, identifier):
        return (
            f'<p:sp><p:nvSpPr><p:cNvPr id="{identifier}" name="文字 {identifier}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            f'<p:spPr>{self.transform(self.box(element))}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>{self.line()}</p:spPr>'
            f'<p:txBody>{self.text_body(element.get("paragraphs"), wrap=element.get("wrap", True), top_inset=element.get("topInset", 0))}</p:txBody></p:sp>'
        )

    def shape(self, element, identifier):
        geometry = element.get("geometry")
        if geometry not in ("rect", "roundRect", "ellipse", "line"):
            raise ValueError("形状必须是 rect、roundRect、ellipse 或 line")
        box = self.box(element, line=geometry == "line")
        adjustment = ""
        if "radius" in element:
            radius = number(element["radius"], "圆角半径", 0)
            if geometry == "roundRect":
                smallest = min(element["width"], element["height"])
                adjustment = f'<a:gd name="adj" fmla="val {round(min(radius / smallest, 0.5) * 100000)}"/>'
        properties = self.transform(box) + f'<a:prstGeom prst="{geometry}"><a:avLst>{adjustment}</a:avLst></a:prstGeom>'
        properties += solid_fill(element.get("fill"), element.get("opacity", 1)) + self.line(element.get("border"))
        if geometry == "line":
            return f'<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="{identifier}" name="直线 {identifier}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>{properties}</p:spPr></p:cxnSp>'
        return f'<p:sp><p:nvSpPr><p:cNvPr id="{identifier}" name="形状 {identifier}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>{properties}</p:spPr></p:sp>'

    def table(self, element, identifier):
        box = self.box(element)
        columns = sequence(element.get("columns"), "表格列", True)
        grid = "".join(f'<a:gridCol w="{self.x(number(width, "表格列宽", 1))}"/>' for width in columns)
        rows = []
        for row in sequence(element.get("rows"), "表格行", True):
            record(row, "表格行")
            cells = sequence(row.get("cells"), "表格单元格")
            if len(cells) != len(columns):
                raise ValueError("表格每行单元格数量必须与列数一致")
            height = self.y(number(row.get("height"), "表格行高", 1))
            contents = []
            for cell in cells:
                record(cell, "表格单元格")
                if any(key in cell for key in ("rowSpan", "colSpan", "columnSpan", "merge")):
                    raise ValueError("可编辑表格不支持合并单元格")
                margin = number(cell.get("margin", 0), "单元格内边距", 0)
                vertical = cell.get("verticalAlign", "top")
                if not isinstance(vertical, str) or vertical not in VERTICAL:
                    raise ValueError("单元格垂直对齐必须是 top、center 或 bottom")
                properties = " ".join(
                    f'{attribute}="{convert(number(cell.get(key, margin), key, 0))}"'
                    for attribute, key, convert in [("marL", "marginLeft", self.x), ("marR", "marginRight", self.x), ("marT", "marginTop", self.y), ("marB", "marginBottom", self.y)]
                ) + f' anchor="{VERTICAL[vertical]}"'
                # 单边配置覆盖共享边框；显式 null 表示该边不绘制。
                borders = "".join(
                    self.line(cell.get(key, cell.get("border")), tag)
                    for tag, key in (("lnL", "borderLeft"), ("lnR", "borderRight"), ("lnT", "borderTop"), ("lnB", "borderBottom"))
                )
                contents.append(f'<a:tc><a:txBody>{self.text_body(cell.get("paragraphs"), cell=True, wrap=cell.get("wrap", True))}</a:txBody><a:tcPr {properties}>{borders}{solid_fill(cell.get("fill"))}</a:tcPr></a:tc>')
            rows.append(f'<a:tr h="{height}">{"".join(contents)}</a:tr>')
        return (
            f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="{identifier}" name="表格 {identifier}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
            f'{self.transform(box, "p")}<a:graphic><a:graphicData uri="{TABLE_URI}"><a:tbl><a:tblPr firstRow="0" bandRow="0"/>'
            f'<a:tblGrid>{grid}</a:tblGrid>{"".join(rows)}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
        )


def attachment_xml(identifier, ole_relation, image_relation):
    """附件置于首屏对象之后，并使用该页面未占用的对象与关系编号。"""
    width, height = 1051560, 1234440
    left, top = WIDTH - width - 228600, HEIGHT - height - 182880
    return (
        f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="{identifier}" name="原始 HTML"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
        f'<p:xfrm><a:off x="{left}" y="{top}"/><a:ext cx="{width}" cy="{height}"/></p:xfrm>'
        f'<a:graphic><a:graphicData uri="{OLE_URI}"><p:oleObj showAsIcon="1" r:id="rId{ole_relation}" imgW="{width}" imgH="{height}" progId="Package"><p:embed/>'
        + picture(identifier + 1, "双击打开原件", image_relation, left, top, width, height)
        + '</p:oleObj></a:graphicData></a:graphic></p:graphicFrame>'
    )


def build_editable_pptx(manifest_dir, output, embed_html=None):
    """完整校验和组装后原子替换输出；输入素材与原始 HTML 不作修改。"""
    directory = Path(manifest_dir).resolve(strict=True)
    manifest = record(json.loads((directory / "manifest.json").read_text(encoding="utf-8")), "manifest")
    if type(manifest.get("schema")) is not int or manifest["schema"] != 1 or manifest.get("mode") != "editable":
        raise ValueError("manifest 必须声明 schema: 1 和 mode: editable")
    drawing = Drawing(manifest.get("width"), manifest.get("height"))
    slides = sequence(manifest.get("slides"), "幻灯片", True)
    attached = embed_html is not None
    parts = base_parts(len(slides), attached)
    if attached:
        from ole_package import build_ole_package
        html = Path(embed_html)
        label = (re.sub(r"[\s\(\)\[\]\{\}]+", "", html.stem) or "courseware") + ".html"
        parts["ppt/embeddings/oleObject1.bin"] = build_ole_package(html.read_bytes(), label)
        with tempfile.TemporaryDirectory(prefix="aico-pptx-icon-") as temporary:
            icon = Path(temporary) / "icon.png"
            make_icon(icon, "双击打开原件")
            parts["ppt/media/oleIcon.png"] = icon.read_bytes()
    images = {}
    for index, slide in enumerate(slides, 1):
        record(slide, "幻灯片")
        name = string(slide.get("name"), "幻灯片名称")
        if "warnings" in slide:
            for warning in sequence(slide["warnings"], "幻灯片警告"):
                string(warning, "幻灯片警告")
        elements = sequence(slide.get("elements"), "幻灯片元素")
        relationships_list = [(1, "slideLayout", "../slideLayouts/slideLayout1.xml")]
        objects = []
        for identifier, element in enumerate(elements, 2):
            record(element, "幻灯片元素")
            kind = element.get("type")
            if kind in ("text", "shape", "table"):
                objects.append(getattr(drawing, kind)(element, identifier))
            elif kind == "image":
                data, extension = local_media(directory, element.get("file"))
                digest = hashlib.sha256(data).digest()
                if digest not in images:
                    images[digest] = f"image{len(images) + 1}.{extension}"
                    parts["ppt/media/" + images[digest]] = data
                relation = len(relationships_list) + 1
                relationships_list.append((relation, "image", "../media/" + images[digest]))
                objects.append(picture(identifier, element["file"], relation, *drawing.box(element)))
            else:
                raise ValueError(f"不支持的幻灯片元素类型：{kind}")
        if attached and index == 1:
            relation = len(relationships_list) + 1
            objects.append(attachment_xml(len(elements) + 2, relation, relation + 1))
            relationships_list += [(relation, "oleObject", "../embeddings/oleObject1.bin"), (relation + 1, "image", "../media/oleIcon.png")]
        parts[f"ppt/slides/slide{index}.xml"] = xml(
            f'<p:sld xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}"><p:cSld name={quoteattr(name)}><p:spTree>'
            '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
            + "".join(objects) + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
        )
        parts[f"ppt/slides/_rels/slide{index}.xml.rels"] = relationships(relationships_list)
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".pptx-", suffix=".tmp", dir=output.parent)
    os.close(descriptor)
    try:
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED) as archive:
            for name, data in parts.items():
                archive.writestr(name, data)
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(f"已生成 {output}  共 {len(slides)} 页（可编辑对象）")


def main(argv=None):
    parser = argparse.ArgumentParser(description="把逻辑像素 manifest 写为可编辑 PPTX")
    parser.add_argument("manifestDir", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("embed", nargs="?", type=Path, help="可选的原始 HTML 附件")
    args = parser.parse_args(argv)
    try:
        build_editable_pptx(args.manifestDir, args.output, args.embed)
    except (OSError, ValueError, ImportError) as error:
        print(f"可编辑 PPTX 组装失败：{error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
