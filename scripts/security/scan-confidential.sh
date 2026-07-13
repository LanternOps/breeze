#!/usr/bin/env bash
#
# Breeze confidential-info guard.
#
# Blocks known confidential infrastructure identifiers and a few high-signal
# patterns that generic secret scanners (gitleaks, in secret-scan.yml) miss,
# before they reach the public repo. Motivated by the 2026-07 leak of prod
# droplet IPs + DB cluster IDs in tracked docs.
#
# Usage:
#   scripts/security/scan-confidential.sh --staged   # staged additions (pre-commit hook; default)
#   scripts/security/scan-confidential.sh --all       # all tracked files (CI backstop)
#
# What it detects:
#   1. Exact-match DENYLIST of real confidential values. Never stored in this
#      public repo. Source, first that exists:
#        $CONFIDENTIAL_DENYLIST_FILE   (CI: written from the CONFIDENTIAL_DENYLIST secret)
#        internal/security/denylist.txt (local dev; gitignored via /internal/*)
#      One value per line; blank lines and lines starting with # are ignored.
#   2. SSH access to a literal IP        e.g.  ssh root@203.0.113.9
#   3. DigitalOcean managed-DB cluster id (a UUID next to a region/"cluster")
#   4. PGPASSWORD=<value>
#
# gitleaks still handles generic credential formats (API keys, tokens, private
# keys), so this stays narrow to avoid false positives in a networking codebase.
#
# Escape hatch: add a `confidential-ok` marker in a comment on the same line to
# suppress a single reviewed line.
#
set -uo pipefail

MODE="${1:---staged}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# Paths that legitimately contain IP-ish / credential-ish content: examples,
# lockfiles, test fixtures, the gitignored internal tree, and this script.
EXCLUDE_RE='(^|/)(pnpm-lock\.yaml|package-lock\.json)$|\.example($|\.)|(^|/)\.env\.example$|(^|/)(__tests__|testdata|tests?)/|_test\.(go|ts|tsx|py)$|\.(test|spec)\.[a-z]+$|^internal/|^scripts/security/scan-confidential\.sh$'

# High-signal patterns. name|extended-regex (case-insensitive).
PATTERN_NAMES=(ssh-to-ip do-cluster-id pgpassword)
PATTERN_RES=(
  '(^|[^A-Za-z0-9])root@([0-9]{1,3}\.){3}[0-9]{1,3}'
  '(cluster|fra1|sfo3|nyc3|ams3|blr1|lon1|tor1|sgp1)[^A-Za-z0-9]{0,12}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}'
  "PGPASSWORD=[^ <\$'\"]"
)

# ---- denylist source -------------------------------------------------------
DENY_TERMS=()
DENY_SRC=""
if [[ -n "${CONFIDENTIAL_DENYLIST_FILE:-}" && -f "${CONFIDENTIAL_DENYLIST_FILE}" ]]; then
  DENY_SRC="${CONFIDENTIAL_DENYLIST_FILE}"
elif [[ -f internal/security/denylist.txt ]]; then
  DENY_SRC="internal/security/denylist.txt"
fi
if [[ -n "$DENY_SRC" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line// }" || "$line" == \#* ]] && continue
    DENY_TERMS+=("$line")
  done < "$DENY_SRC"
fi

# ---- build the file set + a root to read content from ----------------------
SCAN_ROOT="."
declare -a FILES=()
CLEANUP_TMP=""
cleanup() { [[ -n "$CLEANUP_TMP" ]] && rm -rf "$CLEANUP_TMP"; }
trap cleanup EXIT

if [[ "$MODE" == "--all" ]]; then
  while IFS= read -r f; do FILES+=("$f"); done < <(git ls-files | grep -vE "$EXCLUDE_RE" || true)
else
  # Staged additions/modifications; scan the *staged* blob, not the worktree.
  staged=()
  while IFS= read -r f; do staged+=("$f"); done \
    < <(git diff --cached --name-only --diff-filter=ACM | grep -vE "$EXCLUDE_RE" || true)
  [[ ${#staged[@]} -eq 0 ]] && exit 0
  CLEANUP_TMP="$(mktemp -d)"
  SCAN_ROOT="$CLEANUP_TMP"
  for f in "${staged[@]}"; do
    mkdir -p "$SCAN_ROOT/$(dirname "$f")"
    git show ":$f" > "$SCAN_ROOT/$f" 2>/dev/null || continue
    FILES+=("$f")
  done
fi
[[ ${#FILES[@]} -eq 0 ]] && exit 0

# Absolute-ish paths to hand to grep, and a way back to the repo-relative name.
declare -a PATHS=()
for f in "${FILES[@]}"; do PATHS+=("$SCAN_ROOT/$f"); done

findings=0
mask() { # redact the middle so CI logs don't re-expose the value
  sed -E 's/([^[:space:]]{2})[^[:space:]]{2,}([^[:space:]]{2})/\1…\2/g' <<<"$1" | cut -c1-100
}
report() { # relpath lineno category linetext
  echo "  ✗ ${1}:${2}  [${3}]  $(mask "$4")" >&2
  findings=$((findings + 1))
}

emit() { # category ; reads "file:ln:text" grep output on stdin
  local category="$1" hit fp ln text
  while IFS= read -r hit; do
    fp="${hit%%:*}"; hit="${hit#*:}"
    ln="${hit%%:*}"; text="${hit#*:}"
    [[ "$text" == *confidential-ok* ]] && continue
    report "${fp#"$SCAN_ROOT"/}" "$ln" "$category" "$text"
  done
}

# NUL-delimited path list, fed through xargs so a large tree can't overflow the
# arg list (or get the grep killed).
paths_nul() { local p; for p in "${PATHS[@]}"; do printf '%s\0' "$p"; done; }

# Pattern passes (one grep per pattern so the category name is precise).
i=0
while [[ $i -lt ${#PATTERN_NAMES[@]} ]]; do
  emit "${PATTERN_NAMES[$i]}" \
    < <(paths_nul | xargs -0 grep -HnEi -- "${PATTERN_RES[$i]}" 2>/dev/null || true)
  i=$((i + 1))
done

# Denylist pass (exact substring match, single grep -f pass).
if [[ ${#DENY_TERMS[@]} -gt 0 ]]; then
  denyfile="$(mktemp)"
  printf '%s\n' "${DENY_TERMS[@]}" > "$denyfile"
  emit "denylist" \
    < <(paths_nul | xargs -0 grep -HnF -f "$denyfile" 2>/dev/null || true)
  rm -f "$denyfile"
fi

if [[ "$findings" -gt 0 ]]; then
  echo "" >&2
  echo "✖ confidential-info guard: ${findings} match(es) blocked." >&2
  echo "  Remove the value (infra IPs/hostnames/cluster-ids/secrets belong in .env or internal/)," >&2
  echo "  or, if it is genuinely safe, add a 'confidential-ok' comment marker on that line." >&2
  echo "  Bypass in an emergency with: git commit --no-verify   (CI will still flag it)." >&2
  exit 1
fi
exit 0
