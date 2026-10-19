#!/bin/sh
# All paths are separate arguments from the trusted main process, never shell source.
set -eu
parent_pid=$1
target=$2
staged=$3
backup=$4
log=$5
profile=$6
update_id=$7
version=$8
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
exec >> "$log" 2>&1
attempt=0
while kill -0 "$parent_pid" 2>/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 120 ]; then
        echo 'Update cancelled: Cerebr did not exit.'
        exit 1
    fi
    sleep 1
done
# Both renames stay on the application's volume. Keep the old bundle until
# replacement succeeds, and roll back on installation or launch failure.
if ! mv "$target" "$backup"; then
    /usr/bin/open -n "$target" --args "--profile=$profile"
    exit 1
fi
if ! mv "$staged" "$target"; then
    mv "$backup" "$target"
    /usr/bin/open -n "$target" --args "--profile=$profile"
    exit 1
fi
if ! /usr/bin/open -n "$target" --args "--profile=$profile" "--cerebr-update-id=$update_id"; then
    mv "$target" "$staged"
    mv "$backup" "$target"
    /usr/bin/open -n "$target" --args "--profile=$profile"
    exit 1
fi
# A successful `open` does not prove the renderer started. Keep the old bundle
# until the new React session confirms it is ready.
attempt=0
receipt="$profile/updates/$update_id/restarted"
while [ ! -f "$receipt" ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 120 ]; then
        echo "No startup confirmation; previous app retained at $backup"
        exit 1
    fi
    sleep 1
done
[ "$(cat "$receipt")" = "$version" ] || exit 1
rm -rf "$backup"
rmdir "$(dirname "$staged")"
echo 'Update installed and Cerebr relaunched.'
