#!/usr/bin/env bash
# Hash a tree for byte-exact + metadata comparison (Linux / macOS).
#
#   hash-tree.sh <root> > out.tsv
#
# One line per entry, sorted by path, tab-separated:
#   F <relpath> <size> <sha256> <mtime-epoch> <mode-octal>
#   L <relpath> SYMLINK <target>
#   D <relpath>                      (only for EMPTY directories)
# Unreadable files are recorded as `F <relpath> <size> UNREADABLE ...` so a
# permission problem shows up as a diff rather than a silent omission.
set -uo pipefail
ROOT=${1:?usage: hash-tree.sh <root>}
cd "$ROOT" || exit 2

if stat -f '%z' . >/dev/null 2>&1; then
  statfmt() { stat -f '%z	%m	%OLp' "$1"; }       # macOS/BSD
else
  statfmt() { stat -c '%s	%Y	%a' "$1"; }         # GNU
fi
if command -v sha256sum >/dev/null 2>&1; then
  hasher() { sha256sum "$1" | cut -d' ' -f1; }
else
  hasher() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

{
  find . -type f -print0 | while IFS= read -r -d '' f; do
    rel=${f#./}
    IFS=$'\t' read -r size mtime mode < <(statfmt "$f")
    if [ -r "$f" ]; then h=$(hasher "$f"); else h=UNREADABLE; fi
    printf 'F\t%s\t%s\t%s\t%s\t%s\n' "$rel" "$size" "$h" "$mtime" "$mode"
  done
  find . -type l -print0 | while IFS= read -r -d '' f; do
    printf 'L\t%s\tSYMLINK\t%s\n' "${f#./}" "$(readlink "$f")"
  done
  find . -mindepth 1 -type d -empty -print0 | while IFS= read -r -d '' d; do
    printf 'D\t%s\n' "${d#./}"
  done
} | LC_ALL=C sort -t$'\t' -k2,2
