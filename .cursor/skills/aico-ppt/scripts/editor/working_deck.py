#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 Editor 托管工作副本；真实 Deck 始终只读。"""

import base64
import importlib.util
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[2]


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


eb = _load("aico_ppt_edit_bundle", ROOT / "scripts/edit-bundle.py")
patch_bundle = _load(
    "aico_ppt_patch_bundle", ROOT / "scripts/editor/patch_bundle.py"
)


LEGACY_PAGE_KEY_RE = re.compile(r"^page-(\d{3})-[0-9a-f]{8}$")


def normalize_json_surrogates(value):
    r"""把 JSON ``\ud83d\ude00`` 形式的合法代理对还原成单个 Unicode 字符。

    浏览器 locator/fingerprint 可能包含表情符号；JSON.parse 与 Python
    ``json.load`` 对 escaped surrogate pair 的内存表示不同。写回 UTF-8
    bundle 前必须组合代理对，孤立代理项仍 fail-closed。
    """
    if isinstance(value, str) and any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        result = []
        index = 0
        while index < len(value):
            current = ord(value[index])
            if 0xD800 <= current <= 0xDBFF and index + 1 < len(value):
                following = ord(value[index + 1])
                if 0xDC00 <= following <= 0xDFFF:
                    result.append(chr(
                        0x10000 + ((current - 0xD800) << 10) + following - 0xDC00
                    ))
                    index += 2
                    continue
            result.append(value[index])
            index += 1
        return "".join(result)
    if isinstance(value, list):
        return [normalize_json_surrogates(item) for item in value]
    if isinstance(value, dict):
        return {
            normalize_json_surrogates(key): normalize_json_surrogates(item)
            for key, item in value.items()
        }
    return value


def _migrate_page_key(value, ids):
    if value in ids:
        return value
    match = LEGACY_PAGE_KEY_RE.fullmatch(value or "")
    if not match:
        raise ValueError(f"无法把历史 pageKey 迁移为持久 pageId：{value}")
    index = int(match.group(1)) - 1
    if index < 0 or index >= len(ids):
        raise ValueError(f"历史 pageKey 页序越界：{value}")
    return ids[index]


def migrate_action_page_ids(actions, ids):
    migrated = []
    mapping = {}
    for action in actions:
        target = action.get("target")
        if not isinstance(target, dict) or not isinstance(target.get("pageKey"), str):
            raise ValueError("离线补丁缺少 target.pageKey")
        old = target["pageKey"]
        new = _migrate_page_key(old, ids)
        mapping[old] = new
        migrated.append({**action, "target": {**target, "pageKey": new}})
    return migrated, mapping


def prepare_working_copy(path):
    source = Path(path)
    lines = eb.load(source)
    try:
        template_with_patches = normalize_json_surrogates(eb.get_template(lines))
    except (RuntimeError, json.JSONDecodeError):
        contents = source.read_bytes()
        return {
            "bytes": base64.b64encode(contents).decode("ascii"),
            "pageIds": [], "pageKeyMap": {}, "patchCount": 0, "managed": False,
        }
    patches = patch_bundle.extract_patches(template_with_patches)
    template = patch_bundle.strip_block(template_with_patches)
    template = eb.ensure_page_ids(template)
    template = eb.ensure_editor_ids(template)
    ids = eb.page_ids(template)
    if not ids or not all(ids) or len(ids) != len(set(ids)):
        raise ValueError("工作副本未建立完整、唯一的 pageId")
    mapping = {}
    if patches is not None:
        patches, mapping = migrate_action_page_ids(patches, ids)
        template = patch_bundle.replace_block(template, patches)
    eb.set_template(lines, template)
    contents = "\n".join(lines).encode("utf-8")
    return {
        "bytes": base64.b64encode(contents).decode("ascii"),
        "pageIds": ids,
        "pageKeyMap": mapping,
        "patchCount": len(patches or []),
        "managed": True,
    }


def apply_patches(contents, patches):
    if not isinstance(patches, list) or any(not isinstance(item, dict) for item in patches):
        raise ValueError("patches 必须是对象数组")
    lines = contents.decode("utf-8").split("\n")
    template = normalize_json_surrogates(eb.get_template(lines))
    template = eb.ensure_page_ids(patch_bundle.strip_block(template))
    template = eb.ensure_editor_ids(template)
    template = patch_bundle.replace_block(template, patches)
    eb.set_template(lines, template)
    return "\n".join(lines).encode("utf-8")


def normalize_working_copy_bytes(contents):
    """补齐工作副本的页面与元素身份，不改变补丁或其他模板字节。"""
    lines = contents.decode("utf-8").split("\n")
    template = normalize_json_surrogates(eb.get_template(lines))
    template = eb.ensure_page_ids(template)
    template = eb.ensure_editor_ids(template)
    eb.set_template(lines, template)
    return "\n".join(lines).encode("utf-8")


def main():
    if sys.argv[1:] == ["--normalize-bytes"]:
        try:
            request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
            contents = base64.b64decode(request["bytes"], validate=True)
            result = normalize_working_copy_bytes(contents)
            print(json.dumps({
                "bytes": base64.b64encode(result).decode("ascii")
            }, ensure_ascii=False))
            return 0
        except Exception as error:
            print(f"工作副本身份规范化失败：{error}", file=sys.stderr)
            return 1
    if sys.argv[1:] == ["--apply-patches"]:
        try:
            # Node 子进程协议固定 UTF-8，不能跟随 Windows 控制台
            # GBK/ACP，否则中文 action payload 会在固化时被误解码。
            request = normalize_json_surrogates(
                json.loads(sys.stdin.buffer.read().decode("utf-8"))
            )
            contents = base64.b64decode(request["bytes"], validate=True)
            result = apply_patches(contents, request["patches"])
            print(json.dumps({
                "bytes": base64.b64encode(result).decode("ascii")
            }, ensure_ascii=False))
            return 0
        except Exception as error:
            print(f"工作副本补丁同步失败：{error}", file=sys.stderr)
            return 1
    if len(sys.argv) != 2:
        print(
            "用法: python3 scripts/editor/working_deck.py <deck.html> | --normalize-bytes | --apply-patches",
            file=sys.stderr,
        )
        return 2
    try:
        print(json.dumps(prepare_working_copy(sys.argv[1]), ensure_ascii=False))
        return 0
    except Exception as error:
        print(f"工作副本准备失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
