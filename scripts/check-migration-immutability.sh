#!/usr/bin/env bash
# Shipped-migration immutability guard.
#
# autoMigrate records a SHA-256 of each applied migration's raw file content
# and refuses to boot on mismatch. So ANY content change to a migration that
# shipped in a release — even a comment edit — bricks the API on every
# existing database (prod droplets + upgrading self-hosters), while CI stays
# green because it migrates from an empty DB with no recorded checksums.
#
# This happened on 2026-07-21: a docs reorg (#2708) rewrote a doc path inside
# an SQL comment across 19 already-shipped migrations. Caught before tagging;
# fixed by #2717 restoring the exact shipped bytes.
#
# This guard makes the freeze mechanical: any migration file that existed at
# an applicable release-lineage baseline must be byte-identical at HEAD.
#
#   - Added files: allowed (that's what migrations are).
#   - Modified files: forbidden, UNLESS the filename has a matching
#     CHECKSUM_RECONCILIATIONS heal entry in autoMigrate.ts (the deliberate,
#     reviewed forward-fix path — see #994, #2622).
#   - Deleted/renamed files: always forbidden. breeze_migrations keys on
#     filename; a rename re-applies under the new name, and a delete makes
#     fresh installs diverge from upgraded DBs.
#
# Scope matches the runner: top-level apps/api/migrations/*.sql only
# (optional/ is not auto-applied).
#
# Usage: check-migration-immutability.sh [base-ref]
#   With no base-ref, full history is required and baselines are resolved from
#   the checked commit's release lineage.

set -euo pipefail

MIGRATIONS_DIR="apps/api/migrations"
AUTOMIGRATE_TS="apps/api/src/db/autoMigrate.ts"
CANDIDATE_REGISTRY=".github/release-provenance/candidate-tags.tsv"
SIDE_BRANCH_REGISTRY=".github/release-provenance/side-branch-tags.tsv"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SEMVER_TOOL="$SCRIPT_DIR/release/sort-semver-tags.mjs"

fail() {
  echo "check-migration-immutability: error: $*" >&2
  exit 1
}

tag_commit() {
  git rev-parse "$1^{commit}" 2>/dev/null || \
    fail "release tag '$1' cannot be peeled to a commit"
}

CANDIDATE_REGISTRY_LOADED=false
CANDIDATE_TAGS=()
CANDIDATE_SHAS=()
CANDIDATE_COUNT=0

load_candidate_registry() {
  [ "$CANDIDATE_REGISTRY_LOADED" = false ] || return 0
  CANDIDATE_REGISTRY_LOADED=true
  [ -f "$CANDIDATE_REGISTRY" ] || return 0

  local line line_number row_tag row_sha row_ref row_note row_extra actual_sha seen_index
  line_number=0
  while IFS= read -r line || [ -n "$line" ]; do
    line_number=$((line_number + 1))
    case "$line" in
      ""|'#'*) continue ;;
    esac
    IFS=$'\t' read -r row_tag row_sha row_ref row_note row_extra <<EOF
$line
EOF
    if [ -z "${row_tag:-}" ] || [ -z "${row_sha:-}" ] || \
       [ -z "${row_ref:-}" ] || [ -z "${row_note:-}" ] || \
       [ -n "${row_extra:-}" ]; then
      fail "malformed candidate registry row $line_number: expected four non-empty tab-separated fields"
    fi
    if ! node "$SEMVER_TOOL" --validate "$row_tag" || [[ "$row_tag" != *-* ]]; then
      fail "invalid candidate tag '$row_tag' at registry row $line_number"
    fi
    if [[ ! "$row_sha" =~ ^[0-9a-f]{40}$ ]]; then
      fail "invalid candidate SHA '$row_sha' at registry row $line_number"
    fi
    for ((seen_index = 0; seen_index < CANDIDATE_COUNT; seen_index++)); do
      [ "${CANDIDATE_TAGS[$seen_index]}" != "$row_tag" ] || \
        fail "duplicate candidate tag '$row_tag' in registry"
    done
    actual_sha=$(tag_commit "$row_tag")
    [ "$actual_sha" = "$row_sha" ] || \
      fail "candidate registry SHA mismatch for '$row_tag': recorded $row_sha, tag peels to $actual_sha"
    CANDIDATE_TAGS[$CANDIDATE_COUNT]="$row_tag"
    CANDIDATE_SHAS[$CANDIDATE_COUNT]="$row_sha"
    CANDIDATE_COUNT=$((CANDIDATE_COUNT + 1))
  done < "$CANDIDATE_REGISTRY"
}

candidate_sha_for_tag() {
  local wanted="$1" index
  load_candidate_registry
  for ((index = 0; index < CANDIDATE_COUNT; index++)); do
    if [ "${CANDIDATE_TAGS[$index]}" = "$wanted" ]; then
      echo "${CANDIDATE_SHAS[$index]}"
      return
    fi
  done
  return 0
}

SIDE_REGISTRY_LOADED=false
SIDE_TAGS=()
SIDE_EQUIVALENTS=()
SIDE_COUNT=0

load_side_registry() {
  [ "$SIDE_REGISTRY_LOADED" = false ] || return 0
  SIDE_REGISTRY_LOADED=true
  [ -f "$SIDE_BRANCH_REGISTRY" ] || return 0

  local line line_number row_tag row_sha row_note row_extra seen_index
  line_number=0
  while IFS= read -r line || [ -n "$line" ]; do
    line_number=$((line_number + 1))
    case "$line" in
      ""|'#'*) continue ;;
    esac
    IFS=$'\t' read -r row_tag row_sha row_note row_extra <<EOF
$line
EOF
    if [ -z "${row_tag:-}" ] || [ -z "${row_sha:-}" ] || \
       [ -z "${row_note:-}" ] || [ -n "${row_extra:-}" ]; then
      fail "malformed side-branch registry row $line_number: expected three non-empty tab-separated fields"
    fi
    if ! node "$SEMVER_TOOL" --validate "$row_tag" || [[ "$row_tag" == *-* ]]; then
      fail "invalid stable side-branch tag '$row_tag' at registry row $line_number"
    fi
    if [[ ! "$row_sha" =~ ^[0-9a-f]{40}$ ]]; then
      fail "invalid side-branch equivalent SHA '$row_sha' at registry row $line_number"
    fi
    for ((seen_index = 0; seen_index < SIDE_COUNT; seen_index++)); do
      [ "${SIDE_TAGS[$seen_index]}" != "$row_tag" ] || \
        fail "duplicate side-branch tag '$row_tag' in registry"
    done
    SIDE_TAGS[$SIDE_COUNT]="$row_tag"
    SIDE_EQUIVALENTS[$SIDE_COUNT]="$row_sha"
    SIDE_COUNT=$((SIDE_COUNT + 1))
  done < "$SIDE_BRANCH_REGISTRY"
}

side_equivalent_for_tag() {
  local wanted="$1" index
  load_side_registry
  for ((index = 0; index < SIDE_COUNT; index++)); do
    if [ "${SIDE_TAGS[$index]}" = "$wanted" ]; then
      echo "${SIDE_EQUIVALENTS[$index]}"
      return
    fi
  done
  return 0
}

BASE_REF="${1:-}"
BASELINES=()

if [ -n "$BASE_REF" ]; then
  BASELINES[0]="$BASE_REF"
else
  if git remote get-url origin >/dev/null 2>&1; then
    # CI checks out full history and tags. This best-effort refresh also keeps
    # long-lived local clones current without making private-origin credentials
    # a prerequisite for using an already-complete checkout.
    git fetch --quiet --tags origin 2>/dev/null || true
  fi

  SHALLOW=$(git rev-parse --is-shallow-repository 2>/dev/null) || \
    fail "not inside a Git repository"
  [ "$SHALLOW" != "true" ] || \
    fail "shallow repository cannot prove migration release ancestry; fetch full history and tags"

  RAW_TAGS=$(git tag --list 'v*')
  SORTED_TAGS=$(printf '%s\n' "$RAW_TAGS" | node "$SEMVER_TOOL" --sort-desc) || \
    fail "invalid SemVer release tag set"
  TAGS=()
  TAG_COUNT=0
  while IFS= read -r release_tag; do
    [ -n "$release_tag" ] || continue
    TAGS[$TAG_COUNT]="$release_tag"
    TAG_COUNT=$((TAG_COUNT + 1))
  done <<< "$SORTED_TAGS"

  if [ "$TAG_COUNT" -eq 0 ]; then
    echo "check-migration-immutability: no v* release tag found; skipping (nothing shipped yet)."
    exit 0
  fi

  PRIMARY_BASELINE=""
  for release_tag in "${TAGS[@]}"; do
    release_sha=$(tag_commit "$release_tag")
    if git merge-base --is-ancestor "$release_sha" HEAD 2>/dev/null; then
      PRIMARY_BASELINE="$release_tag"
      break
    fi
  done
  [ -n "$PRIMARY_BASELINE" ] || \
    fail "v* tags exist, but this checked lineage has no reachable release baseline"

  BASELINES[0]="$PRIMARY_BASELINE"
  echo "check-migration-immutability: selected primary baseline $PRIMARY_BASELINE"

  MAIN_REF_AVAILABLE=false
  if git rev-parse --verify --quiet 'origin/main^{commit}' >/dev/null; then
    MAIN_REF_AVAILABLE=true
  fi

  for release_tag in "${TAGS[@]}"; do
    [ "$release_tag" != "$PRIMARY_BASELINE" ] || break
    release_sha=$(tag_commit "$release_tag")

    # Ordering is intentional: once an exact tag commit reaches origin/main,
    # a retained candidate row must not let an older branch ignore it.
    if [ "$MAIN_REF_AVAILABLE" = true ] && \
       git merge-base --is-ancestor "$release_sha" origin/main 2>/dev/null; then
      fail "checked lineage is behind mainline release '$release_tag'; merge or rebase onto main, or pass an explicit base ref"
    fi

    registered_candidate_sha=$(candidate_sha_for_tag "$release_tag")
    if [ -n "$registered_candidate_sha" ]; then
      [ "$registered_candidate_sha" = "$release_sha" ] || \
        fail "candidate registry SHA mismatch for '$release_tag': recorded $registered_candidate_sha, tag peels to $release_sha"
      echo "check-migration-immutability: classified higher candidate $release_tag; excluding it from this lineage"
      continue
    fi

    side_equivalent=$(side_equivalent_for_tag "$release_tag")
    if [ -n "$side_equivalent" ]; then
      if ! git merge-base --is-ancestor "$side_equivalent" HEAD 2>/dev/null; then
        fail "recorded equivalent for side-branch release '$release_tag' is not reachable from HEAD"
      fi
      BASELINES[${#BASELINES[@]}]="$release_tag"
      echo "check-migration-immutability: added additional side-branch baseline $release_tag"
      continue
    fi

    fail "unclassified higher release tag '$release_tag' is outside this lineage; resolve its reviewed provenance"
  done
fi

# --no-renames so a rename surfaces as D + A (we must flag the D).
violations=0
for baseline in "${BASELINES[@]}"; do
  echo "check-migration-immutability: comparing $MIGRATIONS_DIR against $baseline"
  while IFS=$'\t' read -r status file _; do
    [ -n "$status" ] || continue
    # Top-level .sql only — subdirs (optional/) are not auto-applied.
    case "$file" in
      "$MIGRATIONS_DIR"/*/*) continue ;;
      *.sql) ;;
      *) continue ;;
    esac
    base=$(basename "$file")
    case "$status" in
      A) ;; # new migration — the normal case
      M)
        if grep -qF "'$base'" "$AUTOMIGRATE_TS"; then
          echo "  ALLOWED  M $base (has a CHECKSUM_RECONCILIATIONS heal entry)"
        else
          echo "  VIOLATION  M $base — shipped in $baseline, content changed."
          violations=$((violations + 1))
        fi
        ;;
      D)
        echo "  VIOLATION  D $base — shipped in $baseline, deleted (or renamed)."
        violations=$((violations + 1))
        ;;
      *)
        echo "  VIOLATION  $status $base — unexpected change against shipped baseline $baseline."
        violations=$((violations + 1))
        ;;
    esac
  # Diff baseline -> working tree (== HEAD in CI; lets the guard be tested
  # locally against uncommitted edits too).
  done < <(git diff --no-renames --name-status "$baseline" -- "$MIGRATIONS_DIR")
done

if [ "$violations" -gt 0 ]; then
  cat >&2 <<EOF

check-migration-immutability: $violations shipped migration violation(s) found against applicable release baselines.

Shipped migrations are content-hashed by autoMigrate; ANY edit (even a
comment) makes the API refuse to boot on every database that already
applied them. Fix forward with a NEW migration instead. If this is a
deliberate, provably-equivalent forward-fix, add an exact from->to
CHECKSUM_RECONCILIATIONS entry in $AUTOMIGRATE_TS (see #994, #2622).
EOF
  exit 1
fi

echo "check-migration-immutability: OK"
