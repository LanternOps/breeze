#!/usr/bin/env bash
# Migration filename convention guard — runs at COMMIT time, not just in CI.
#
# Two rules, both of which have cost real time when they were only enforced
# late (or not at all):
#
#   1. The filename must match the runner's discovery pattern
#      `^[0-9]{4}-.*\.sql$` (apps/api/src/db/autoMigrate.ts). A file that does
#      not match is not "rejected" — it is silently never applied. The schema
#      then only exists on whichever database the author ran by hand.
#
#   2. The `2026-08-06-` date block is CLOSED. It was reserved by the security
#      remediation program, one migration per wave; all of those have shipped
#      and are content-hashed immutable, and later migrations re-create objects
#      they define. A new file wedged into the block replays in the wrong order
#      on a fresh database.
#
#      Rule 2 exists because rule-2 violations kept happening. Three separate
#      authors independently reached for `2026-08-06-g-…` (#2995 — merged and
#      reddened main for ~1h; #3008 — caught on the PR; and a plan doc that
#      instructed its executor to do the same). None was being careless: the
#      documented same-day-ordering convention is literally "add an `-a-`/`-b-`
#      infix", so taking the next free letter is the natural reading. Nothing
#      at authoring time said the letters stopped. Now something does. (#3016)
#
# Usage:
#   check-migration-naming.sh --staged   # newly ADDED staged files (pre-commit)
#   check-migration-naming.sh            # every file in the migrations dir (CI)
#
# The reserved-block manifest below is duplicated in apps/api/src/db/
# autoMigrate.test.ts, which asserts the two copies agree ("keeps the
# commit-time naming guard pinned to the same reserved date").

set -euo pipefail

MIGRATIONS_DIR="apps/api/migrations"
RESERVED_DATE="2026-08-06-"

# The complete, shipped contents of the reserved block. Nothing may be added.
RESERVED_BLOCK=(
  "2026-08-06-a-report-site-scope.sql"
  "2026-08-06-b-live-authorization.sql"
  "2026-08-06-c-quote-response-capability.sql"
  "2026-08-06-d-device-mtls-certificate-history.sql"
  "2026-08-06-e-action-intents-origin-principal.sql"
  "2026-08-06-e-agent-outbound-network-capability.sql"
  "2026-08-06-f-m365-comms-delegated.sql"
  "2026-08-06-f-manifest-key-delegations.sql"
)

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

is_reserved_block_member() {
  local candidate="$1" known
  for known in "${RESERVED_BLOCK[@]}"; do
    [ "$candidate" = "$known" ] && return 0
  done
  return 1
}

violations=0

check_filename() {
  local base="$1"

  if ! [[ "$base" =~ ^[0-9]{4}-.*\.sql$ ]]; then
    echo "  VIOLATION  $base — does not match the runner's discovery pattern" >&2
    echo "             ^[0-9]{4}-.*\\.sql\$, so autoMigrate will silently NEVER" >&2
    echo "             apply it. Use YYYY-MM-DD-<slug>.sql." >&2
    violations=$((violations + 1))
    return
  fi

  if [[ "$base" == "$RESERVED_DATE"* ]] && ! is_reserved_block_member "$base"; then
    echo "  VIOLATION  $base — the ${RESERVED_DATE%-} date block is CLOSED." >&2
    echo "             It is not a free namespace and its slot letters do not" >&2
    echo "             run past the shipped set. Use a date AFTER the block —" >&2
    echo "             a plain YYYY-MM-DD-<slug>.sql on today's date already" >&2
    echo "             sorts last, which is normally the property you want." >&2
    violations=$((violations + 1))
    return
  fi
}

if [ "${1:-}" = "--staged" ]; then
  # Pre-commit: only judge migrations this commit is ADDING. Renames surface as
  # A+D with --no-renames, and the added half is what we want to vet.
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    case "$file" in
      "$MIGRATIONS_DIR"/*/*) continue ;;         # optional/ is not auto-applied
      "$MIGRATIONS_DIR"/*.sql) ;;                # only .sql is a migration
      *) continue ;;                             # README.md etc. are not
    esac
    check_filename "$(basename "$file")"
  done < <(git diff --cached --no-renames --diff-filter=A --name-only)
else
  for file in "$MIGRATIONS_DIR"/*.sql; do
    [ -f "$file" ] || continue
    check_filename "$(basename "$file")"
  done
fi

if [ "$violations" -gt 0 ]; then
  echo "" >&2
  echo "check-migration-naming: $violations migration filename violation(s)." >&2
  echo "See $MIGRATIONS_DIR/README.md for the naming rules." >&2
  exit 1
fi

echo "check-migration-naming: OK"
