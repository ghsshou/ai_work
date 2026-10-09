#!/usr/bin/env bash
# convert.sh — POSIX 兼容入口；实际工作由跨平台 convert.py 完成
# 用法:
#   ./convert.sh "课件.html"                 # 输出同名 .pptx
#   ./convert.sh "课件.html" "输出.pptx"      # 指定输出
#   SCALE=2 QUALITY=92 ./convert.sh ...      # 调清晰度/压缩
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$HERE/convert.py" "$@"
