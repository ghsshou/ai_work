#!/usr/bin/env python3
"""新建 Deck 工厂的 bundle 验证适配层。"""

from __future__ import annotations

import argparse
import html as html_module
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys


EDITOR_DIR = Path(__file__).resolve().parent
PROJECT_DIR = EDITOR_DIR.parent.parent
EDIT_BUNDLE_PATH = PROJECT_DIR / "scripts" / "edit-bundle.py"


def load_edit_bundle():
    spec = importlib.util.spec_from_file_location("aico_ppt_edit_bundle", EDIT_BUNDLE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 scripts/edit-bundle.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SECTION_PATTERN = re.compile(r"<section\b[^>]*>.*?</section>", re.IGNORECASE | re.DOTALL)
STAMP_ATTRIBUTE_PATTERN = re.compile(
    r"\sdata-template-(?:id|source-page|layout-lock)=(?:\"[^\"]*\"|'[^']*')"
    r"|\sdata-page-type-id=(?:\"[^\"]*\"|'[^']*')",
    re.IGNORECASE,
)


def load_catalog(catalog_path: Path) -> dict:
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    if catalog.get("version") != 2:
        raise ValueError("模板目录版本必须为 2")
    templates = catalog.get("templates")
    if not isinstance(templates, list) or not templates:
        raise ValueError("模板目录缺少 templates")
    ids = [item.get("templateId") for item in templates if isinstance(item, dict)]
    if len(ids) != len(templates) or any(not isinstance(value, str) or not value for value in ids):
        raise ValueError("模板目录包含无效模板")
    if len(set(ids)) != len(ids):
        raise ValueError("模板目录包含重复模板")
    return catalog


def template_source_path(item: dict) -> Path:
    source = item.get("source")
    if not isinstance(source, str) or not source:
        raise ValueError(f"模板缺少 source：{item.get('templateId', '未知')}")
    path = (PROJECT_DIR / source).resolve()
    try:
        path.relative_to(PROJECT_DIR.resolve())
    except ValueError as error:
        raise ValueError(f"模板路径逃逸项目目录：{item.get('templateId', '未知')}") from error
    if not path.is_file():
        raise ValueError(f"模板文件不存在：{item.get('templateId', '未知')}")
    return path


def template_page_count(item: dict) -> int:
    edit_bundle = load_edit_bundle()
    html = edit_bundle.get_template(edit_bundle.load(str(template_source_path(item))))
    count = len(SECTION_PATTERN.findall(html))
    if count <= 0:
        raise ValueError(f"模板没有页面：{item.get('templateId', '未知')}")
    return count


def native_page_types(item: dict, page_count: int) -> dict[str, dict]:
    template_id = item["templateId"]
    configured = {}
    for page in [*item.get("requiredPages", []), *item.get("pageTypes", [])]:
        source_page = page.get("sourcePage")
        if not isinstance(source_page, int) or not 1 <= source_page <= page_count:
            raise ValueError(f"模板页型 sourcePage 无效：{template_id}")
        if source_page in configured:
            raise ValueError(f"模板页型 sourcePage 重复：{template_id} / {source_page}")
        compatible = page.get("compatibleWith", [template_id])
        if (
            not isinstance(compatible, list)
            or any(not isinstance(value, str) or not value for value in compatible)
            or len(set(compatible)) != len(compatible)
        ):
            raise ValueError(f"模板页型 compatibleWith 无效：{template_id} / {source_page}")
        configured[source_page] = page
    page_types = {}
    for source_page in range(1, page_count + 1):
        page = configured.get(source_page, {})
        page_type_id = page.get("pageTypeId") or f"source-page-{source_page:02d}"
        if page_type_id in page_types:
            raise ValueError(f"模板 pageTypeId 重复：{template_id} / {page_type_id}")
        page_types[page_type_id] = {
            **page,
            "pageTypeId": page_type_id,
            "sourcePage": source_page,
            "sourceTemplateId": template_id,
            "compatibleWith": page.get("compatibleWith", [template_id]),
            "repeatable": page.get("repeatable", not bool(page.get("role"))),
        }
    return page_types


def load_contract(
    catalog_path: Path,
    template_id: str,
    page_count: int | None = None,
) -> dict:
    catalog = load_catalog(catalog_path)
    templates = {item["templateId"]: item for item in catalog["templates"]}
    item = templates.get(template_id)
    if item is None:
        raise ValueError(f"模板不在目录中：{template_id}")
    template_ids = set(templates)
    selected_count = template_page_count(item)
    if page_count is not None and page_count != selected_count:
        raise ValueError(
            f"模板页数与目录不一致：{template_id} / 目录 {selected_count} / 实际 {page_count}"
        )
    native_types = native_page_types(item, selected_count)
    page_types = dict(native_types)
    for origin_id, origin in templates.items():
        if origin_id == template_id:
            continue
        origin_count = template_page_count(origin)
        for candidate in native_page_types(origin, origin_count).values():
            unknown = set(candidate["compatibleWith"]) - template_ids
            if unknown:
                raise ValueError(
                    f"页型兼容列表引用未知模板：{origin_id} / {candidate['pageTypeId']}"
                )
            if candidate.get("role") or template_id not in candidate["compatibleWith"]:
                continue
            page_types.setdefault(candidate["pageTypeId"], candidate)
    return {
        "templateId": template_id,
        "pageTypes": page_types,
        "nativePageTypes": native_types,
        "sourcePath": template_source_path(item),
    }


def strip_stamp_attributes(fragment: str) -> str:
    return STAMP_ATTRIBUTE_PATTERN.sub("", fragment)


def layout_fingerprint(fragment: str) -> str:
    clean = strip_stamp_attributes(fragment)
    clean = re.sub(
        r"\sdata-(?:page-id|label|plan-page-id|plan-chapter-id|editor-id)="
        r"(?:\"[^\"]*\"|'[^']*')",
        "",
        clean,
        flags=re.I,
    )
    # 编辑身份与空元素标签的序列化空格不属于版式结构。
    clean = re.sub(r"\s+/>", "/>", clean)
    clean = re.sub(r">[^<]*<", "><", clean)
    clean = re.sub(r"\s+", " ", clean).strip()
    return hashlib.sha256(clean.encode("utf-8")).hexdigest()


def attribute(fragment: str, name: str) -> str | None:
    match = re.search(rf"\b{re.escape(name)}=(?:\"([^\"]*)\"|'([^']*)')", fragment, re.I)
    return None if match is None else (match.group(1) if match.group(1) is not None else match.group(2))


def stamp(path: Path, catalog_path: Path, template_id: str) -> dict:
    edit_bundle = load_edit_bundle()
    lines = edit_bundle.load(str(path))
    html = edit_bundle.get_template(lines)
    sections = list(SECTION_PATTERN.finditer(html))
    contract = load_contract(catalog_path, template_id, len(sections))
    by_source = {page["sourcePage"]: page for page in contract["nativePageTypes"].values()}

    def replace(match: re.Match[str]) -> str:
        source_page = next(index for index, candidate in enumerate(sections, 1) if candidate.start() == match.start())
        page_type = by_source[source_page]
        fragment = strip_stamp_attributes(match.group(0))
        opening_end = fragment.find(">")
        stamps = (
            f' data-template-id="{template_id}"'
            f' data-page-type-id="{page_type["pageTypeId"]}"'
            f' data-template-source-page="{source_page}"'
        )
        if page_type.get("preserveLayout"):
            stamps += f' data-template-layout-lock="{layout_fingerprint(fragment)}"'
        return f"{fragment[:opening_end]}{stamps}{fragment[opening_end:]}"

    stamped = SECTION_PATTERN.sub(replace, html)
    edit_bundle.set_template(lines, stamped)
    edit_bundle.save(str(path), lines)
    edit_bundle.verify(str(path))
    return {"ok": True, "deckPath": str(path.resolve()), "check": "template-contract-stamp"}


def _with_section_attributes(block: str, attributes: dict[str, str]) -> str:
    opening = re.search(r"<section\b[^>]*>", block, re.IGNORECASE)
    if opening is None:
        raise ValueError("页型块缺少 section")
    tag = opening.group(0)
    for name in (
        "data-label", "data-page-id", "data-template-id", "data-page-type-id",
        "data-template-source-page", "data-template-layout-lock",
        "data-plan-page-id", "data-plan-chapter-id",
    ):
        tag = re.sub(
            rf"\s+{re.escape(name)}=(?:\"[^\"]*\"|'[^']*')",
            "",
            tag,
            flags=re.IGNORECASE,
        )
    encoded = "".join(
        f' {name}="{html_module.escape(str(value), quote=True)}"'
        for name, value in attributes.items()
    )
    replacement = f"<section{encoded}{tag[len('<section'):-1]}>"
    return f"{block[:opening.start()]}{replacement}{block[opening.end():]}"


def _merge_page_resources(edit_bundle, target_lines: list[str], source_lines: list[str], block: str) -> str:
    target_manifest = edit_bundle.get_manifest(target_lines)
    source_manifest = edit_bundle.get_manifest(source_lines)
    merged = dict(target_manifest)
    for uid, entry in source_manifest.items():
        if uid not in block:
            continue
        replacement = uid
        if uid in merged and merged[uid] != entry:
            seed = uid + json.dumps(entry, sort_keys=True, ensure_ascii=False)
            replacement = "shared-" + hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]
            while replacement in merged and merged[replacement] != entry:
                replacement += "x"
            block = block.replace(uid, replacement)
        merged[replacement] = entry
    if merged != target_manifest:
        edit_bundle.set_manifest(target_lines, merged)
    return block


def import_page(
    path: Path,
    catalog_path: Path,
    template_id: str,
    page_type_id: str,
    label: str,
    before_label: str,
    nav_code: str,
    plan_page_id: str,
    plan_chapter_id: str,
) -> dict:
    """把审核兼容的页型导入场景 Deck；三份模板文件本身保持独立。"""
    if not path.is_file():
        raise ValueError("目标 Deck 不存在或不是常规文件")
    if not all(isinstance(value, str) and value.strip() for value in (
        page_type_id, label, before_label, nav_code, plan_page_id, plan_chapter_id,
    )):
        raise ValueError("导入页型的标识、标签和页面规划身份不能为空")
    contract = load_contract(catalog_path, template_id)
    page_type = contract["pageTypes"].get(page_type_id)
    if page_type is None:
        raise ValueError(f"当前场景不允许使用页型：{page_type_id}")
    catalog = load_catalog(catalog_path)
    source_item = next(
        item for item in catalog["templates"]
        if item["templateId"] == page_type["sourceTemplateId"]
    )
    edit_bundle = load_edit_bundle()
    target_lines = edit_bundle.load(str(path))
    target_html = edit_bundle.get_template(target_lines)
    target_sections = SECTION_PATTERN.findall(target_html)
    if not target_sections or attribute(target_sections[0], "data-template-id") != template_id:
        raise ValueError("目标 Deck 尚未按所选场景模板盖章")
    if any(html_module.unescape(attribute(section, "data-label") or "") == label for section in target_sections):
        raise ValueError(f"目标 Deck 已存在同名页面：{label}")

    source_lines = edit_bundle.load(str(template_source_path(source_item)))
    source_html = edit_bundle.get_template(source_lines)
    source_sections = list(SECTION_PATTERN.finditer(source_html))
    source_page = page_type["sourcePage"]
    if source_page < 1 or source_page > len(source_sections):
        raise ValueError(f"共享页型来源页不存在：{page_type_id}")
    source_label = html_module.unescape(
        attribute(source_sections[source_page - 1].group(0), "data-label") or ""
    )
    start, end = edit_bundle._slide_bounds(source_html, source_label)
    block = source_html[start:end]
    block = _merge_page_resources(edit_bundle, target_lines, source_lines, block)
    block = _with_section_attributes(block, {
        "data-label":label,
        "data-template-id":page_type["sourceTemplateId"],
        "data-page-type-id":page_type_id,
        "data-template-source-page":str(source_page),
        "data-plan-page-id":plan_page_id,
        "data-plan-chapter-id":plan_chapter_id,
    })
    target_html = edit_bundle.insert_page(
        target_html,
        block,
        before_label=before_label,
        nav_code=nav_code,
        nav_label=label,
    )
    edit_bundle.set_template(target_lines, target_html)
    edit_bundle.save(str(path), target_lines)
    edit_bundle.verify(str(path))
    return {
        "ok":True,
        "deckPath":str(path.resolve()),
        "check":"shared-page-type-import",
        "pageTypeId":page_type_id,
        "sourceTemplateId":page_type["sourceTemplateId"],
        "sourcePage":source_page,
        "label":label,
    }


def load_page_plan_contract(path: Path, template_id: str) -> list[dict]:
    if not path.is_file():
        raise ValueError("页面规划契约不存在或不是常规文件")
    value = json.loads(path.read_text(encoding="utf-8"))
    pages = value.get("pages") if isinstance(value, dict) else None
    if value.get("version") != 1 or value.get("templateId") != template_id:
        raise ValueError("页面规划契约版本或模板不一致")
    if not isinstance(pages, list) or not pages:
        raise ValueError("页面规划契约必须至少包含一页")
    required = ("pageId", "chapterId", "pageTypeId", "label")
    if any(
        not isinstance(page, dict)
        or any(not isinstance(page.get(key), str) or not page[key] for key in required)
        for page in pages
    ):
        raise ValueError("页面规划契约包含无效页面")
    if len({page["pageId"] for page in pages}) != len(pages):
        raise ValueError("页面规划契约中的 pageId 必须唯一")
    if len({page["label"] for page in pages}) != len(pages):
        raise ValueError("页面规划契约中的 label 必须唯一")
    return pages


def verify(
    path: Path,
    catalog_path: Path | None = None,
    template_id: str | None = None,
    page_plan_contract_path: Path | None = None,
) -> dict:
    if not path.is_file():
        raise ValueError("staging Deck 不存在或不是常规文件")
    edit_bundle = load_edit_bundle()
    edit_bundle.verify(str(path))
    if catalog_path is None or template_id is None:
        return {"ok": True, "deckPath": str(path.resolve()), "check": "edit-bundle.verify"}
    html = edit_bundle.get_template(edit_bundle.load(str(path)))
    sections = SECTION_PATTERN.findall(html)
    contract = load_contract(catalog_path, template_id)
    planned_pages = None
    if page_plan_contract_path is not None:
        planned_pages = load_page_plan_contract(page_plan_contract_path, template_id)
        if len(sections) != len(planned_pages):
            raise ValueError(
                "页面数量与已确认规划不一致："
                f"计划 {len(planned_pages)} 页，实际 {len(sections)} 页，禁止发布"
            )
    counts: dict[str, int] = {}
    required_positions = {}
    for index, section in enumerate(sections):
        page_type_id = attribute(section, "data-page-type-id")
        page_type = contract["pageTypes"].get(page_type_id or "")
        if page_type is None:
            raise ValueError(f"第 {index + 1} 页使用了未登记页型：{page_type_id}")
        if attribute(section, "data-template-id") != page_type["sourceTemplateId"]:
            raise ValueError(f"第 {index + 1} 页缺少或使用了错误的页型来源模板标记")
        source_page = int(attribute(section, "data-template-source-page") or 0)
        if source_page != page_type["sourcePage"]:
            raise ValueError(f"第 {index + 1} 页的模板来源标记不一致")
        if planned_pages is not None:
            planned = planned_pages[index]
            if page_type_id != planned["pageTypeId"]:
                raise ValueError(
                    f"第 {index + 1} 页的页型与已确认规划不一致："
                    f"计划 {planned['pageTypeId']}，实际 {page_type_id}"
                )
            if attribute(section, "data-plan-page-id") != planned["pageId"]:
                raise ValueError(f"第 {index + 1} 页的页面身份与已确认规划不一致")
            if attribute(section, "data-plan-chapter-id") != planned["chapterId"]:
                raise ValueError(f"第 {index + 1} 页的章节身份与已确认规划不一致")
            actual_label = html_module.unescape(attribute(section, "data-label") or "")
            if actual_label != planned["label"]:
                raise ValueError(
                    f"第 {index + 1} 页的标签与已确认规划不一致："
                    f"计划 {planned['label']}，实际 {actual_label or '空'}"
                )
        counts[page_type_id] = counts.get(page_type_id, 0) + 1
        if page_type.get("role"):
            required_positions[page_type["role"]] = index
            if page_type.get("preserveLayout"):
                lock = attribute(section, "data-template-layout-lock")
                if not lock or lock != layout_fingerprint(section):
                    raise ValueError(f"{page_type.get('name', page_type_id)}的原始结构已被改动")
    for page_type in contract["pageTypes"].values():
        if page_type.get("role") and counts.get(page_type["pageTypeId"]) != 1:
            raise ValueError(f"必须且只能保留一个{page_type.get('name', page_type['pageTypeId'])}")
    if required_positions.get("cover") != 0:
        raise ValueError("封面必须是第一页")
    if required_positions.get("toc") != 1:
        raise ValueError("目录必须是第二页")
    if required_positions.get("thanks") != len(sections) - 1:
        raise ValueError("感谢页必须是最后一页")
    return {
        "ok": True,
        "deckPath": str(path.resolve()),
        "check": "template-and-page-plan-contract"
        if planned_pages is not None else "template-contract",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AICO-PPT 新建流程验证适配层")
    subparsers = parser.add_subparsers(dest="command", required=True)
    verify_parser = subparsers.add_parser("verify", help="验证单文件 bundle 结构")
    verify_parser.add_argument("deck")
    verify_parser.add_argument("--catalog")
    verify_parser.add_argument("--template-id")
    verify_parser.add_argument("--page-plan-contract")
    stamp_parser = subparsers.add_parser("stamp", help="写入模板页型来源与固定页结构锁")
    stamp_parser.add_argument("deck")
    stamp_parser.add_argument("--catalog", required=True)
    stamp_parser.add_argument("--template-id", required=True)
    import_parser = subparsers.add_parser("import-page", help="从共享页型库受控导入兼容页面")
    import_parser.add_argument("deck")
    import_parser.add_argument("--catalog", required=True)
    import_parser.add_argument("--template-id", required=True)
    import_parser.add_argument("--page-type-id", required=True)
    import_parser.add_argument("--label", required=True)
    import_parser.add_argument("--before-label", required=True)
    import_parser.add_argument("--nav-code", required=True)
    import_parser.add_argument("--plan-page-id", required=True)
    import_parser.add_argument("--plan-chapter-id", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "stamp":
            result = stamp(Path(args.deck), Path(args.catalog), args.template_id)
        elif args.command == "import-page":
            result = import_page(
                Path(args.deck), Path(args.catalog), args.template_id,
                args.page_type_id, args.label, args.before_label, args.nav_code,
                args.plan_page_id, args.plan_chapter_id,
            )
        else:
            result = verify(
                Path(args.deck),
                Path(args.catalog) if args.catalog else None,
                args.template_id,
                Path(args.page_plan_contract) if args.page_plan_contract else None,
            )
    except Exception as error:  # noqa: BLE001 - CLI 统一返回稳定错误
        print(json.dumps({"ok": False, "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
