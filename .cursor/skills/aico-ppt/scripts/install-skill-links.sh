#!/usr/bin/env bash
set -euo pipefail

skill_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

printf '提示：install-skill-links.sh 是兼容入口，实际安装由 scripts/install.py 统一处理。\n'
exec python3 "$skill_root/scripts/install.py" repair --hosts all --skill-only "$@"
