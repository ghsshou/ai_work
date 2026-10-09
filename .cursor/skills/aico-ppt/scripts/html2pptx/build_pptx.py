#!/usr/bin/env python3
"""把 manifest 截图按序封装为 16:9 PPTX；仅可选 HTML 附件图标需要 Pillow。

用法: python3 build_pptx.py <imgDir> <output.pptx> [embed.html]
页面 XML 对应 python-pptx 生成的满屏图片与 OLE 对象；固定母版、空白版式及主题见 template/。
本工具不解析或重现任意 PPTX 的文本、图形和版式。
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from xml.sax.saxutils import quoteattr
from zipfile import ZipFile, ZIP_DEFLATED


HERE = Path(__file__).resolve().parent
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
WIDTH, HEIGHT = 12192000, 6858000  # EMU，精确 16:9


def xml(body):
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + body).encode("utf-8")


def relationships(items):
    entries = ''.join(
        f'<Relationship Id="rId{index}" Type="{R}/{kind}" Target={quoteattr(target)}/>'
        for index, kind, target in items
    )
    return xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + entries + '</Relationships>')


def picture(identifier, name, relation, left=0, top=0, width=WIDTH, height=HEIGHT):
    return (
        f'<p:pic><p:nvPicPr><p:cNvPr id="{identifier}" name={quoteattr(name)}/>'
        '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
        f'<p:blipFill><a:blip r:embed="rId{relation}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
        f'<p:spPr><a:xfrm><a:off x="{left}" y="{top}"/><a:ext cx="{width}" cy="{height}"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
    )


def slide_xml(name, has_attachment):
    attachment = ''
    if has_attachment:
        width, height = 1051560, 1234440  # 1.15 × 1.35 英寸
        left, top = WIDTH - width - 228600, HEIGHT - height - 182880
        attachment = (
            '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="原始 HTML"/>'
            '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>'
            f'<p:xfrm><a:off x="{left}" y="{top}"/><a:ext cx="{width}" cy="{height}"/></p:xfrm>'
            f'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole">'
            f'<p:oleObj showAsIcon="1" r:id="rId3" imgW="{width}" imgH="{height}" progId="Package"><p:embed/>'
            + picture(4, "双击打开原件", 4, left, top, width, height)
            + '</p:oleObj></a:graphicData></a:graphic></p:graphicFrame>'
        )
    return xml(
        f'<p:sld xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}"><p:cSld><p:spTree>'
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
        + picture(2, name, 2) + attachment
        + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
    )


def content_types(slide_count, has_attachment):
    defaults = [
        ("rels", "application/vnd.openxmlformats-package.relationships+xml"),
        ("xml", "application/xml"), ("jpg", "image/jpeg"), ("png", "image/png"),
    ]
    overrides = [
        ("ppt/presentation.xml", "presentationml.presentation.main+xml"),
        ("ppt/slideMasters/slideMaster1.xml", "presentationml.slideMaster+xml"),
        ("ppt/slideLayouts/slideLayout1.xml", "presentationml.slideLayout+xml"),
        ("ppt/theme/theme1.xml", "theme+xml"),
    ]
    overrides += [(f"ppt/slides/slide{index}.xml", "presentationml.slide+xml") for index in range(1, slide_count + 1)]
    if has_attachment:
        overrides.append(("ppt/embeddings/oleObject1.bin", "oleObject"))
    return xml(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + ''.join(f'<Default Extension="{extension}" ContentType="{kind}"/>' for extension, kind in defaults)
        + ''.join(f'<Override PartName="/{part}" ContentType="application/vnd.openxmlformats-officedocument.{kind}"/>' for part, kind in overrides)
        + '</Types>'
    )


def base_parts(slide_count, has_attachment):
    slides = ''.join(f'<p:sldId id="{255 + index}" r:id="rId{index + 1}"/>' for index in range(1, slide_count + 1))
    parts = {
        "[Content_Types].xml": content_types(slide_count, has_attachment),
        "_rels/.rels": relationships([(1, "officeDocument", "ppt/presentation.xml")]),
        "ppt/presentation.xml": xml(
            f'<p:presentation xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}" autoCompressPictures="0">'
            '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
            f'<p:sldIdLst>{slides}</p:sldIdLst><p:sldSz cx="{WIDTH}" cy="{HEIGHT}"/>'
            '<p:notesSz cx="6858000" cy="9144000"/></p:presentation>'
        ),
        "ppt/_rels/presentation.xml.rels": relationships(
            [(1, "slideMaster", "slideMasters/slideMaster1.xml")]
            + [(index + 1, "slide", f"slides/slide{index}.xml") for index in range(1, slide_count + 1)]
        ),
        "ppt/slideMasters/_rels/slideMaster1.xml.rels": relationships([
            (1, "slideLayout", "../slideLayouts/slideLayout1.xml"), (2, "theme", "../theme/theme1.xml"),
        ]),
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels": relationships([(1, "slideMaster", "../slideMasters/slideMaster1.xml")]),
    }
    for part, template in [
        ("ppt/slideMasters/slideMaster1.xml", "slideMaster.xml"),
        ("ppt/slideLayouts/slideLayout1.xml", "slideLayout.xml"),
        ("ppt/theme/theme1.xml", "theme.xml"),
    ]:
        parts[part] = (HERE / "template" / template).read_bytes()
    return parts


def make_icon(png_path: Path, label: str):
    """生成一个文档样式图标（带中文标签），供 OLE 对象显示用。"""
    from PIL import Image, ImageDraw, ImageFont
    W, H = 320, 380
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 文档主体（白底 + 折角）
    fold = 78
    body = [(24, 20), (W - 24 - fold, 20), (W - 24, 20 + fold), (W - 24, H - 78), (24, H - 78)]
    d.polygon(body, fill=(255, 255, 255, 255), outline=(210, 210, 210, 255))
    d.polygon([(W - 24 - fold, 20), (W - 24, 20 + fold), (W - 24 - fold, 20 + fold)],
              fill=(232, 232, 232, 255), outline=(210, 210, 210, 255))
    # 顶部品牌红条
    d.rectangle([24, 20, W - 24 - fold, 20 + 40], fill=(197, 32, 42, 255))

    def font(sz):
        for fp in ("/System/Library/Fonts/PingFang.ttc",
                   "/System/Library/Fonts/STHeiti Medium.ttc",
                   "/System/Library/Fonts/Supplemental/Songti.ttc"):
            try:
                return ImageFont.truetype(fp, sz)
            except Exception:
                continue
        return ImageFont.load_default()

    # 文档中央 "HTML"
    f_big = font(72)
    d.text((W / 2, 175), "HTML", font=f_big, fill=(197, 32, 42, 255), anchor="mm")
    # 几条示意文本线
    for i, y in enumerate((250, 282, 314)):
        d.line([(56, y), (W - 56 - (30 if i == 2 else 0), y)], fill=(200, 200, 200, 255), width=6)
    # 底部标签
    f_lbl = font(34)
    d.text((W / 2, H - 40), label, font=f_lbl, fill=(60, 60, 60, 255), anchor="mm")
    img.save(png_path)


def build_pptx(img_dir, out_path, embed_html=None):
    manifest = json.loads((img_dir / "manifest.json").read_text(encoding="utf-8"))
    slides = manifest.get("slides") if isinstance(manifest, dict) else None
    if not isinstance(slides, list) or not slides or not all(isinstance(name, str) and name for name in slides):
        raise ValueError("manifest.json 必须包含非空的截图文件名列表 slides")
    has_attachment = embed_html is not None and embed_html.exists()
    parts = base_parts(len(slides), has_attachment)
    if has_attachment:
        from ole_package import build_ole_package
        label = (re.sub(r"[\s\(\)\[\]\{\}]+", "", embed_html.stem) or "courseware") + ".html"
        icon_png = img_dir / "_ole_icon.png"
        make_icon(icon_png, "双击打开原件")
        parts["ppt/media/oleIcon.png"] = icon_png.read_bytes()
        parts["ppt/embeddings/oleObject1.bin"] = build_ole_package(embed_html.read_bytes(), label)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".pptx-", suffix=".tmp", dir=out_path.parent)
    os.close(descriptor)
    try:
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED) as archive:
            for part, content in parts.items():
                archive.writestr(part, content)
            image_parts = {}
            for index, name in enumerate(slides, 1):
                image = (img_dir / name).read_bytes()
                if image.startswith(b"\x89PNG\r\n\x1a\n"):
                    extension = "png"
                elif image.startswith(b"\xff\xd8\xff"):
                    extension = "jpg"
                else:
                    raise ValueError(f"截图必须是 PNG 或 JPEG：{name}")
                digest = hashlib.sha256(image).digest()
                media_name = image_parts.get(digest)
                if media_name is None:
                    media_name = f"image{len(image_parts) + 1}.{extension}"
                    image_parts[digest] = media_name
                    archive.writestr("ppt/media/" + media_name, image)
                archive.writestr(f"ppt/slides/slide{index}.xml", slide_xml(name, has_attachment and index == 1))
                links = [(1, "slideLayout", "../slideLayouts/slideLayout1.xml"), (2, "image", "../media/" + media_name)]
                if has_attachment and index == 1:
                    links += [(3, "oleObject", "../embeddings/oleObject1.bin"), (4, "image", "../media/oleIcon.png")]
                archive.writestr(f"ppt/slides/_rels/slide{index}.xml.rels", relationships(links))
        os.replace(temporary, out_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    if has_attachment:
        print(f"已在第 1 页嵌入原始 HTML (OLE Package): {label}")
    print(f"已生成 {out_path}  共 {len(slides)} 页")


def main(argv=None):
    parser = argparse.ArgumentParser(description="把截图目录组装成 16:9 PPTX（每页一张满屏图）")
    parser.add_argument("imgDir", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("embed", nargs="?", help="可选的原始 HTML 附件")
    args = parser.parse_args(argv)
    try:
        build_pptx(args.imgDir, args.output, Path(args.embed) if args.embed else None)
    except (OSError, ValueError, ImportError) as error:
        print(f"PPTX 组装失败：{error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
