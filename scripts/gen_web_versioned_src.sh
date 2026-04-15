#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

version="$(
  python3 - <<'PY'
import json
from pathlib import Path
print(json.loads(Path("manifest.json").read_text(encoding="utf-8")).get("version","").strip())
PY
)"

if [[ -z "${version}" ]]; then
  echo "[gen] ERROR: manifest.json missing version" >&2
  exit 1
fi

if [[ ! "${version}" =~ ^[0-9A-Za-z._-]+$ ]]; then
  echo "[gen] ERROR: unsafe version string: ${version}" >&2
  exit 1
fi

target_dir="v/${version}"

mkdir -p "${target_dir}"
rm -rf "${target_dir}/src"
cp -R "src" "${target_dir}/"
rm -rf "${target_dir}/styles"
cp -R "styles" "${target_dir}/"

# Fix cross-root import paths for the versioned copy (src -> v/<version>/src)
msg_handler="${target_dir}/src/handlers/message-handler.js"
if [[ -f "${msg_handler}" ]]; then
  perl -pi -e "s#'\\.\\./\\.\\./htmd/latex\\.js'#'\\.\\./\\.\\./\\.\\./\\.\\./htmd/latex.js'#g" "${msg_handler}"
fi

message_renderer="${target_dir}/src/render/message/message-renderer.js"
if [[ -f "${message_renderer}" ]]; then
  perl -pi -e "s#'\\.\\./\\.\\./\\.\\./htmd/latex\\.js'#'\\.\\./\\.\\./\\.\\./\\.\\./\\.\\./htmd/latex.js'#g" "${message_renderer}"
fi

# Fix cross-root imports for the versioned styles copy (styles -> v/<version>/styles)
styles_main="${target_dir}/styles/main.css"
if [[ -f "${styles_main}" ]]; then
  perl -pi -e "s#@import '\\.\\./htmd/#@import '\\.\\./\\.\\./\\.\\./htmd/#g" "${styles_main}"
fi

styles_code="${target_dir}/styles/components/code.css"
if [[ -f "${styles_code}" ]]; then
  perl -pi -e "s#@import '\\.\\./\\.\\./htmd/#@import '\\.\\./\\.\\./\\.\\./\\.\\./htmd/#g" "${styles_code}"
fi

echo "[gen] OK: generated ${target_dir}/src + ${target_dir}/styles (from src/ + styles/)"
