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
#   2. The `2026-08-06-` date block is CLOSED. It was reserved for the security
#      remediation waves, though two same-day migrations from unrelated work
#      landed in it too (`-e-action-intents-origin-principal`,
#      `-f-m365-comms-delegated`). All eight have shipped and are content-hash
#      immutable, and the files carry ordering dependencies on each other, so a
#      new file wedged into the block replays in the wrong order on a fresh
#      database. Closure is about those dependencies, not about every file in
#      the block being remediation content.
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
# autoMigrate.test.ts, which parses this array and asserts the two copies are
# element-for-element identical ("keeps the commit-time naming guard in sync
# with the reserved-block manifest"). Keep the array literal's shape parseable:
# one quoted filename per line.

set -euo pipefail

# Overridable so the guard's FAILURE path can be exercised against a fixture
# directory (see autoMigrate.test.ts). Nothing in CI or the hook sets it.
MIGRATIONS_DIR="${BREEZE_MIGRATIONS_DIR:-apps/api/migrations}"
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
  #
  # Captured into a variable rather than piped through a process substitution:
  # under `set -e` a failing `git diff` inside <(...) is invisible, and the loop
  # would then read nothing and report OK — a guard passing without checking.
  if ! staged_added="$(git diff --cached --no-renames --diff-filter=A --name-only)"; then
    echo "check-migration-naming: 'git diff --cached' failed; refusing to pass." >&2
    exit 1
  fi
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    case "$file" in
      "$MIGRATIONS_DIR"/*/*) continue ;;         # optional/ is not auto-applied
      "$MIGRATIONS_DIR"/*.sql) ;;                # only .sql is a migration
      *) continue ;;                             # README.md etc. are not
    esac
    check_filename "$(basename "$file")"
  done <<< "$staged_added"
else
  # Without nullglob an unmatched glob expands to the literal pattern, `[ -f ]`
  # rejects it, and the guard exits 0 having inspected nothing. A migrations
  # directory with no migrations means the path is wrong, not that all is well.
  shopt -s nullglob
  sql_files=("$MIGRATIONS_DIR"/*.sql)
  shopt -u nullglob

  if [ "${#sql_files[@]}" -eq 0 ]; then
    echo "check-migration-naming: no .sql files found under '$MIGRATIONS_DIR'." >&2
    echo "Refusing to report OK without checking anything." >&2
    exit 1
  fi

  for file in "${sql_files[@]}"; do
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
