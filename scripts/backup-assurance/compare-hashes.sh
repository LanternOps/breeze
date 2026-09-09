#!/usr/bin/env bash
# Compare two hash-tree TSVs (pre-backup vs post-restore).
#
#   compare-hashes.sh <pre.tsv> <post.tsv> [--expect-skipped <regex>]
#
# Exit 0 only when every F entry in pre has a byte-identical F entry in post and
# nothing extra appeared. Metadata (mtime / mode|attrs) drift and symlink / empty
# directory differences are reported separately and do NOT fail the run unless
# --strict-metadata is given — the campaign records them per cell.
# --expect-skipped <regex>: paths matching are allowed to be absent in post
# (documented skips such as symlinks or permission-denied files).
set -uo pipefail
PRE=${1:?pre.tsv}; POST=${2:?post.tsv}; shift 2
SKIP='^$'; STRICT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --expect-skipped) SKIP=$2; shift ;;
    --strict-metadata) STRICT=1 ;;
  esac
  shift
done
LC_ALL=C; export LC_ALL

# Normalise CRLF just in case a Windows TSV came through a text mode transfer.
norm() { tr -d '\r' < "$1"; }
files() { norm "$1" | awk -F'\t' '$1=="F"{print $2"\t"$3"\t"$4}' | sort; }
meta()  { norm "$1" | awk -F'\t' '$1=="F"{print $2"\t"$5"\t"$6}' | sort; }
links() { norm "$1" | awk -F'\t' '$1=="L"{print $2"\t"$4}' | sort; }
edirs() { norm "$1" | awk -F'\t' '$1=="D"{print $2}' | sort; }

pre_f=$(files "$PRE"); post_f=$(files "$POST")
missing=$(comm -23 <(echo "$pre_f") <(echo "$post_f") | cut -f1 | grep -v -E "$SKIP" || true)
extra=$(comm -13 <(echo "$pre_f") <(echo "$post_f") | cut -f1 || true)
# A path present in both but with a different size/hash shows up in both lists above.
changed=$(comm -12 <(echo "$missing") <(echo "$extra") || true)
missing_only=$(comm -23 <(echo "$missing") <(echo "$changed") || true)
extra_only=$(comm -13 <(echo "$changed") <(echo "$extra") || true)
skipped=$(comm -23 <(echo "$pre_f") <(echo "$post_f") | cut -f1 | grep -E "$SKIP" || true)

total_pre=$(echo "$pre_f" | grep -c . || true)
echo "files in pre: $total_pre"
echo "byte-identical: $(( total_pre - $(echo "$missing" | grep -c . || true) - $(echo "$skipped" | grep -c . || true) ))"
report() { local title=$1 body=$2; local n; n=$(echo "$body" | grep -c . || true); echo "$title: $n"; [ "$n" -gt 0 ] && echo "$body" | sed 's/^/  /' | head -50; }
report "CHANGED (content differs)" "$changed"
report "MISSING in post" "$missing_only"
report "EXTRA in post" "$extra_only"
report "SKIPPED (expected)" "$skipped"

# Metadata drift for files that ARE byte-identical.
pre_m=$(meta "$PRE"); post_m=$(meta "$POST")
mdrift=$(comm -3 <(echo "$pre_m") <(echo "$post_m") | sed 's/^\t//' | cut -f1 | sort -u | grep -v -E "$SKIP" || true)
# Only count drift on paths that exist in both.
both=$(comm -12 <(echo "$pre_f" | cut -f1) <(echo "$post_f" | cut -f1))
mdrift=$(comm -12 <(echo "$mdrift") <(echo "$both") || true)
report "METADATA drift (mtime/mode|attrs)" "$mdrift"
if [ -n "$mdrift" ]; then
  echo "  detail (path pre-mtime pre-meta | post-mtime post-meta):"
  join -t$'\t' <(echo "$pre_m") <(echo "$post_m") | awk -F'\t' '$2!=$4||$3!=$5{print "  "$1"\t"$2" "$3"\t| "$4" "$5}' | head -30
fi

report "SYMLINKS only in pre" "$(comm -23 <(links "$PRE") <(links "$POST") | cut -f1)"
report "SYMLINKS only in post" "$(comm -13 <(links "$PRE") <(links "$POST") | cut -f1)"
report "EMPTY DIRS only in pre" "$(comm -23 <(edirs "$PRE") <(edirs "$POST"))"

rc=0
[ -n "$changed" ] && rc=1
[ -n "$missing_only" ] && rc=1
[ -n "$extra_only" ] && rc=1
[ "$STRICT" = 1 ] && [ -n "$mdrift" ] && rc=1
[ $rc = 0 ] && echo "RESULT: BYTE-EXACT" || echo "RESULT: MISMATCH"
exit $rc
