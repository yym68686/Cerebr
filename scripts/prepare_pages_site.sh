#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

dest_arg="${1:-pages-site}"
if [[ "${dest_arg}" = /* ]]; then
  dest_dir="${dest_arg}"
else
  dest_dir="${repo_root}/${dest_arg}"
fi

dest_dir="$(
  python3 - "${dest_dir}" <<'PY'
import os
import sys

print(os.path.abspath(sys.argv[1]))
PY
)"

if [[ "${dest_dir}" = "${repo_root}" ]]; then
  echo "Refusing to use repository root as Pages output directory: ${dest_dir}" >&2
  exit 1
fi

rsync_excludes=(
  "--exclude=.git/"
  "--exclude=.github/"
  "--exclude=.vercel/"
  "--exclude=_site/"
  "--exclude=pages-site/"
  "--exclude=.DS_Store"
  "--exclude=CLAUDE.md"
)

case "${dest_dir}" in
  "${repo_root}"/*)
    dest_rel="${dest_dir#${repo_root}/}"
    rsync_excludes+=("--exclude=${dest_rel%/}/")
    ;;
esac

rm -rf "${dest_dir}"
mkdir -p "${dest_dir}"

rsync -a \
  --delete \
  "${rsync_excludes[@]}" \
  "${repo_root}/" "${dest_dir}/"

if find "${dest_dir}" -type l -print -quit | grep -q .; then
  echo "Pages artifact still contains symbolic links:" >&2
  find "${dest_dir}" -type l -print >&2
  exit 1
fi

echo "Prepared Pages artifact at ${dest_dir}"
