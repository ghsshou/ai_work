#!/usr/bin/env bash
# Install little-thing/grok-wechat-plugin at the audited commit with security fixes applied.
#   bash install.sh [--force]
# Env: DEST (default /home/box/grok-wechat-plugin), PATCH_URL (default: this repo on main).
set -euo pipefail

UPSTREAM="https://github.com/little-thing/grok-wechat-plugin"
COMMIT="5c02e41b8126d6ae323dbb30565014fc16752763"
PATCH_SHA256="43cbe6d5df11b3056f52f336c5bbe632d94bb77d906346ee95e6a5ee8b5091e9"
PATCH_URL="${PATCH_URL:-https://raw.githubusercontent.com/ghsshou/ai_work/main/tools/grok-wechat-secure/security-fixes.patch}"
VERIFY_URL="${VERIFY_URL:-https://raw.githubusercontent.com/ghsshou/ai_work/main/tools/grok-wechat-secure/verify.mjs}"
DEST="${DEST:-/home/box/grok-wechat-plugin}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

say() { printf '[grok-wechat-secure] %s\n' "$*"; }
die() { printf '[grok-wechat-secure] ERROR: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "node not found"
command -v curl >/dev/null || die "curl not found"
command -v sha256sum >/dev/null || die "sha256sum not found"

if [ -e "$DEST" ]; then
  [ "$FORCE" = 1 ] || die "$DEST already exists; uninstall the old plugin first or rerun with --force"
  say "removing existing $DEST (--force)"
  rm -rf "$DEST"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

say "downloading patch"
curl -fsSL "$PATCH_URL" -o "$work/security-fixes.patch"
echo "$PATCH_SHA256  $work/security-fixes.patch" | sha256sum -c --quiet - || die "patch checksum mismatch"
curl -fsSL "$VERIFY_URL" -o "$work/verify.mjs"

if command -v git >/dev/null; then
  say "fetching upstream at $COMMIT"
  git init -q "$DEST"
  git -C "$DEST" remote add origin "$UPSTREAM"
  git -C "$DEST" fetch -q --depth 1 origin "$COMMIT"
  git -C "$DEST" checkout -q FETCH_HEAD
  [ "$(git -C "$DEST" rev-parse HEAD)" = "$COMMIT" ] || die "upstream commit mismatch"
  git -C "$DEST" apply --whitespace=nowarn "$work/security-fixes.patch"
else
  command -v patch >/dev/null || die "need git or patch"
  say "git not found; using tarball of $COMMIT"
  mkdir -p "$DEST"
  curl -fsSL "https://codeload.github.com/little-thing/grok-wechat-plugin/tar.gz/$COMMIT" \
    | tar -xz -C "$DEST" --strip-components=1
  patch -s -p1 -d "$DEST" < "$work/security-fixes.patch"
fi

for f in index ilink store uninstall; do node --check "$DEST/server/$f.js"; done
grep -q "safeFileName" "$DEST/server/ilink.js" || die "patch not applied"

say "running offline verification"
node "$work/verify.mjs" "$DEST"

cat <<EOF

[grok-wechat-secure] installed at $DEST (upstream $COMMIT + security fixes)
Next: add a custom MCP server named grok-wechat with command:
  node $DEST/server/index.js
then follow $DEST/skills/wechat-channel/SKILL.md to create the routines, scan the QR code and paste the webhook.
EOF
