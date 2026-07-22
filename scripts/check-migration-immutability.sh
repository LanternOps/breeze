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
# the latest release tag must be byte-identical at HEAD.
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
#   base-ref defaults to the latest v* tag (fetched shallowly if absent).

set -euo pipefail

MIGRATIONS_DIR="apps/api/migrations"
AUTOMIGRATE_TS="apps/api/src/db/autoMigrate.ts"

BASE_REF="${1:-}"
if [ -z "$BASE_REF" ]; then
  # CI checkouts are shallow and tagless; fetch just the release tag refs.
  git fetch --quiet --depth=1 origin "+refs/tags/v*:refs/tags/v*" 2>/dev/null || true
  BASE_REF=$(git tag --list 'v*' --sort=-v:refname | head -1)
fi
if [ -z "$BASE_REF" ]; then
  echo "check-migration-immutability: no v* release tag found; skipping (nothing shipped yet)."
  exit 0
fi

echo "check-migration-immutability: comparing $MIGRATIONS_DIR against $BASE_REF"

# --no-renames so a rename surfaces as D + A (we must flag the D).
violations=0
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
        echo "  VIOLATION  M $base — shipped in $BASE_REF, content changed."
        violations=$((violations + 1))
      fi
      ;;
    D)
      echo "  VIOLATION  D $base — shipped in $BASE_REF, deleted (or renamed)."
      violations=$((violations + 1))
      ;;
    *)
      echo "  VIOLATION  $status $base — unexpected change to a shipped migration."
      violations=$((violations + 1))
      ;;
  esac
# Diff tag -> working tree (== HEAD in CI; lets the guard be tested locally
# against uncommitted edits too).
done < <(git diff --no-renames --name-status "$BASE_REF" -- "$MIGRATIONS_DIR")

if [ "$violations" -gt 0 ]; then
  cat >&2 <<EOF

check-migration-immutability: $violations shipped migration file(s) changed since $BASE_REF.

Shipped migrations are content-hashed by autoMigrate; ANY edit (even a
comment) makes the API refuse to boot on every database that already
applied them. Fix forward with a NEW migration instead. If this is a
deliberate, provably-equivalent forward-fix, add an exact from->to
CHECKSUM_RECONCILIATIONS entry in $AUTOMIGRATE_TS (see #994, #2622).
EOF
  exit 1
fi

echo "check-migration-immutability: OK"
