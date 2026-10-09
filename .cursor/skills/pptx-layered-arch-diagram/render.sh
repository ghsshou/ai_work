#!/usr/bin/env bash
# Render a .pptx to PNG pages for visual checking: render.sh deck.pptx [outdir]
set -euo pipefail
deck="$1"
out="${2:-/tmp/pptx-render}"
mkdir -p "$out"
soffice --headless --convert-to pdf --outdir "$out" "$deck" >/dev/null 2>&1
pdf="$out/$(basename "${deck%.*}").pdf"
python3 - "$pdf" "$out" <<'EOF'
import sys, pymupdf
pdf, out = sys.argv[1], sys.argv[2]
for i, page in enumerate(pymupdf.open(pdf)):
    path = f"{out}/page{i + 1}.png"
    page.get_pixmap(dpi=110).save(path)
    print(path)
EOF
