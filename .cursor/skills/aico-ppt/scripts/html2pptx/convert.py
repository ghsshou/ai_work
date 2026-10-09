#!/usr/bin/env python3
"""跨平台 HTML → PPTX 入口；Windows/macOS/Linux 共用。"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass


HERE = Path(__file__).resolve().parent


def run(command: list[str]) -> None:
    print(">> " + subprocess.list2cmdline(command), flush=True)
    subprocess.run(command, check=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="把 AICO-PPT HTML 转成 PPTX")
    parser.add_argument("input", help="输入单文件 HTML")
    parser.add_argument("output", nargs="?", help="输出 PPTX；默认与输入同名")
    parser.add_argument("--mode", choices=("image", "editable"), default="image",
                        help="image：高清图片（默认）；editable：可编辑文字、常见图形和表格")
    parser.add_argument("--scale", type=float, default=float(os.environ.get("SCALE", "2")),
                        help="截图倍率；可编辑模式为 0.5–4，默认 2")
    parser.add_argument("--quality", type=int, default=int(os.environ.get("QUALITY", "92")),
                        help="图片模式的 JPEG 质量，默认 92")
    parser.add_argument("--embed-html", action="store_true", default=os.environ.get("EMBED_HTML") == "1")
    args = parser.parse_args(argv)

    source = Path(args.input).expanduser().resolve()
    output = Path(args.output).expanduser().resolve() if args.output else source.with_suffix(".pptx")
    if not source.is_file():
        parser.error(f"找不到输入文件：{source}")
    node = os.environ.get("AICO_NODE_EXECUTABLE")
    if node is not None and (not Path(node).is_absolute() or not Path(node).is_file()):
        parser.error("插件 Node 可执行文件无效，请修复运行时配置")
    node = node if node is not None else shutil.which("node")
    if node is None:
        parser.error("找不到 Node.js，请先安装 Node ≥ 18")
    if not 1 <= args.quality <= 100 or args.scale <= 0:
        parser.error("--scale 必须为正数，--quality 必须在 1 到 100 之间")
    if args.mode == "editable" and not 0.5 <= args.scale <= 4:
        parser.error("可编辑模式的 --scale 必须位于 0.5 到 4 之间")

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="html2pptx-") as temporary:
        image_dir = Path(temporary)
        if args.mode == "editable":
            print(f">> 提取可编辑内容：{source}", flush=True)
            run([
                node, str(HERE / "extract-editable.mjs"), str(source), str(image_dir),
                str(args.scale),
            ])
            builder = "build_editable_pptx.py"
        else:
            print(f">> 截图：{source}", flush=True)
            run([
                node, str(HERE / "shoot.mjs"), str(source), str(image_dir),
                str(args.scale), str(args.quality),
            ])
            builder = "build_pptx.py"
        print(">> 组装 PPTX", flush=True)
        command = [sys.executable, str(HERE / builder), str(image_dir), str(output)]
        if args.embed_html:
            command.append(str(source))
        run(command)
    size_mib = output.stat().st_size / (1024 * 1024)
    print(f"完成：{output}（{size_mib:.1f} MiB）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
