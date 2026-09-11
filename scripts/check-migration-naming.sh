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
#   3. A newly added migration must SORT STRICTLY AFTER every migration that
#      is already committed. This is the invariant that actually matters:
#      autoMigrate applies files in `localeCompare` order, so a new file that
#      sorts into the middle replays before migrations it may depend on, and
#      fails on a fresh database while passing on every already-migrated one.
#
#      This rule replaces the old advice that "today's date already sorts
#      last". That stopped being true around 2026-06-12 and is now off by more
#      than two weeks: shipped filenames ran ahead of their commit dates in a
#      compounding ratchet (each author picked one day past the highest
#      existing filename to guarantee sort-last, which raised the ceiling for
#      the next author). 169 of 466 dated migrations are named ahead of the day
#      they landed, the furthest by 16 days. Shipped migrations are content-hash
#      immutable and cannot be renamed to fix it, so the ceiling stands until
#      real time catches up — and until then a file named for today sorts
#      BEFORE the newest shipped ones. Hence: compare against the files, not
#      against the calendar.
#
#      Only checked in --staged mode. The whole-directory pass cannot enforce
#      it, because the existing set violates it by construction.
#
#   4. --against-ref mode extends rule 3 across the fetch boundary. Rule 3
#      (--staged) only ever compares a new migration against migrations
#      already reachable from the branch's own HEAD — it is blind to a
#      migration that lands on origin/main AFTER the branch was cut. That
#      happened for real: a branch carried 2026-10-02-100001-… and passed
#      the commit-time guard clean, while origin/main meanwhile gained
#      2026-10-03-audit-chain-verify-range.sql, which sorts after it. CI's
#      "Check Migrations" job (on the merge commit) would have caught it,
#      but only after a push, a red run, a rename, and a re-push.
#
#      --against-ref <ref> compares every migration new on HEAD relative to
#      <ref> (`git diff --diff-filter=A <ref>...HEAD`) against the greatest
#      migration basename present ON <ref> (not on HEAD) and requires the
#      former to sort strictly after the latter. It is meant to be run from a
#      pre-push hook as `--against-ref origin/main`, AFTER the caller has
#      fetched — this script does not fetch anything itself, so a stale local
#      origin/main makes the check pass vacuously rather than fail; freshness
#      is the hook's job, not this script's.
#
# Filename format: YYYY-MM-DD-HHMMSS-<slug>.sql is preferred for new work — the
# time component orders same-day migrations natively and removes the need for
# the `-a-`/`-b-` infix, whose hand-assigned letters are what produced the
# closed-block confusion in rule 2. Date-only names remain valid.
#
# Usage:
#   check-migration-naming.sh --staged             # newly ADDED staged files (pre-commit)
#   check-migration-naming.sh                      # every file in the migrations dir (CI)
#   check-migration-naming.sh --against-ref <ref>  # HEAD's new migrations vs <ref> (pre-push)
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

# Greatest already-committed migration basename, by the SAME comparator the
# runner uses. Deliberately `node`, not `sort`: autoMigrate orders with
# String.prototype.localeCompare, and shell `sort` (byte or locale collation)
# disagrees with it on exactly the punctuation these filenames are full of.
# A guard that ordered differently from the runner would bless files that then
# replay in a different order than it checked.
committed_max_migration() {
  local ref="${1:-HEAD}"
  git ls-tree --name-only "$ref" "$MIGRATIONS_DIR/" 2>/dev/null \
    | sed 's#.*/##' \
    | grep -E '^[0-9]{4}-.*\.sql$' \
    | node -e '
        const names = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
        if (!names.length) process.exit(0);
        process.stdout.write(names.sort((a, b) => a.localeCompare(b)).pop());
      '
}

# Exit 0 when `candidate` sorts strictly after `reference`.
sorts_strictly_after() {
  BREEZE_CANDIDATE="$1" BREEZE_REFERENCE="$2" node -e '
    const a = process.env.BREEZE_CANDIDATE, b = process.env.BREEZE_REFERENCE;
    process.exit(a.localeCompare(b) > 0 ? 0 : 1);
  '
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
    echo "             run past the shipped set. Use a plain" >&2
    echo "             YYYY-MM-DD-HHMMSS-<slug>.sql that sorts AFTER every" >&2
    echo "             shipped migration — note that is not necessarily" >&2
    echo "             today's date; see rule 3." >&2
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
  max_committed="$(committed_max_migration)"

  while IFS= read -r file; do
    [ -n "$file" ] || continue
    case "$file" in
      "$MIGRATIONS_DIR"/*/*) continue ;;         # optional/ is not auto-applied
      "$MIGRATIONS_DIR"/*.sql) ;;                # only .sql is a migration
      *) continue ;;                             # README.md etc. are not
    esac
    base="$(basename "$file")"
    check_filename "$base"
    if [ -n "$max_committed" ] && ! sorts_strictly_after "$base" "$max_committed"; then
      echo "  VIOLATION  $base — sorts BEFORE an already-committed migration." >&2
      echo "             Newest committed: $max_committed" >&2
      echo "             autoMigrate applies files in localeCompare order, so" >&2
      echo "             this replays before migrations that already shipped —" >&2
      echo "             fine on your already-migrated database, a failure on a" >&2
      echo "             fresh one if it depends on anything newer." >&2
      echo "             NOTE: today's date is NOT guaranteed to sort last."  >&2
      echo "             Shipped filenames ran ahead of real time and cannot be" >&2
      echo "             renamed. Pick a name after the one above, e.g." >&2
      echo "             YYYY-MM-DD-HHMMSS-<slug>.sql dated past it." >&2
      violations=$((violations + 1))
    fi
  done <<< "$staged_added"
elif [ "${1:-}" = "--against-ref" ]; then
  ref="${2:-}"
  if [ -z "$ref" ]; then
    echo "check-migration-naming: --against-ref requires a ref argument, e.g. --against-ref origin/main." >&2
    exit 1
  fi

  if ! git rev-parse --verify -q "${ref}^{commit}" >/dev/null; then
    echo "check-migration-naming: ref '$ref' does not exist locally." >&2
    echo "                        Fetch it first (e.g. 'git fetch origin main')" >&2
    echo "                        — this script does not fetch on its own." >&2
    exit 1
  fi

  # Migrations new on HEAD relative to $ref — i.e. what THIS branch is
  # introducing that $ref does not have. Triple-dot diffs against the merge
  # base, so a $ref that has since moved past a common ancestor doesn't turn
  # every migration $ref lacks on a divergent history into a false positive.
  if ! new_on_head="$(git diff --no-renames --diff-filter=A --name-only "$ref"...HEAD -- "$MIGRATIONS_DIR")"; then
    echo "check-migration-naming: 'git diff $ref...HEAD' failed; refusing to pass." >&2
    exit 1
  fi

  max_on_ref="$(committed_max_migration "$ref")"

  while IFS= read -r file; do
    [ -n "$file" ] || continue
    case "$file" in
      "$MIGRATIONS_DIR"/*/*) continue ;;         # optional/ is not auto-applied
      "$MIGRATIONS_DIR"/*.sql) ;;                # only .sql is a migration
      *) continue ;;                             # README.md etc. are not
    esac
    base="$(basename "$file")"
    if [ -n "$max_on_ref" ] && ! sorts_strictly_after "$base" "$max_on_ref"; then
      echo "  VIOLATION  $base — sorts before or equal to the newest migration on $ref." >&2
      echo "             Newest on $ref: $max_on_ref" >&2
      echo "             $ref gained a migration after this branch was cut that" >&2
      echo "             this new file would replay ahead of on a fresh database." >&2
      echo "             Remedy: rename $base to sort after $max_on_ref, e.g. a" >&2
      echo "             YYYY-MM-DD-HHMMSS-<slug>.sql dated past it." >&2
      violations=$((violations + 1))
    fi
  done <<< "$new_on_head"
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
