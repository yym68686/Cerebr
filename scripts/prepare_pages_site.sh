#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

dest_arg="${1:-_site}"
if [[ "${dest_arg}" = /* ]]; then
  dest_dir="${dest_arg}"
else
  dest_dir="${repo_root}/${dest_arg}"
fi

rm -rf "${dest_dir}"
mkdir -p "${dest_dir}"

rsync -a \
  --delete \
  --exclude='.git/' \
  --exclude='.github/' \
  --exclude='.vercel/' \
  --exclude='_site/' \
  --exclude='.DS_Store' \
  --exclude='CLAUDE.md' \
  "${repo_root}/" "${dest_dir}/"

if find "${dest_dir}" -type l -print -quit | grep -q .; then
  echo "Pages artifact still contains symbolic links:" >&2
  find "${dest_dir}" -type l -print >&2
  exit 1
fi

echo "Prepared Pages artifact at ${dest_dir}"
