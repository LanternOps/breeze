#!/usr/bin/env bash
# Server-only release bootstrap: classify a tag against the server-only ledger
# and, when it is listed, run the eligibility guard FROM THE BASE RELEASE'S
# TREE.
#
# This file comes from the candidate's tree, so it is deliberately tiny (bash +
# git only) and trusts nothing it could weaken: the policy, the guard and every
# helper are extracted from the declared base commit.
#
#   run-server-only-guard.sh --tag vX.Y.Z --commit SHA --ledger-ref REF --main-ref REF
#                            [--online --expected-repository OWNER/REPO] [--report FILE]
#
# Exit 0 = listed and eligible (server-only), 3 = not listed (full release),
# 1 = listed but refused, or any error. Never 3 for an error.

set -uo pipefail

LEDGER=".github/release-provenance/server-only-tags.tsv"
GUARD="scripts/release/check-server-only-eligibility.sh"

usage() {
  echo "usage: run-server-only-guard.sh --tag TAG --commit SHA --ledger-ref REF --main-ref REF [--online --expected-repository OWNER/REPO] [--report FILE]" >&2
  exit 1
}

fail() {
  echo "server-only-guard: REFUSED: $*" >&2
  exit 1
}

TAG=""
COMMIT=""
LEDGER_REF=""
MAIN_REF=""
PASSTHROUGH=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) [ "$#" -ge 2 ] || usage; TAG="$2"; shift 2 ;;
    --commit) [ "$#" -ge 2 ] || usage; COMMIT="$2"; shift 2 ;;
    --ledger-ref) [ "$#" -ge 2 ] || usage; LEDGER_REF="$2"; shift 2 ;;
    --main-ref) [ "$#" -ge 2 ] || usage; MAIN_REF="$2"; shift 2 ;;
    --online) PASSTHROUGH+=("$1"); shift ;;
    --expected-repository|--report) [ "$#" -ge 2 ] || usage; PASSTHROUGH+=("$1" "$2"); shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$TAG" ] && [ -n "$COMMIT" ] && [ -n "$LEDGER_REF" ] && [ -n "$MAIN_REF" ] || usage

REPO=$(git rev-parse --show-toplevel 2>/dev/null) || fail "not inside a Git repository"
[ "$(git rev-parse --is-shallow-repository)" != "true" ] || \
  fail "shallow repository cannot prove release ancestry; fetch full history and tags"
LEDGER_SHA=$(git rev-parse --verify --quiet "$LEDGER_REF^{commit}") || fail "cannot resolve ledger ref '$LEDGER_REF'"
COMMIT=$(git rev-parse --verify --quiet "$COMMIT^{commit}") || fail "cannot resolve commit '$COMMIT'"

# 1. The row. An absent ledger or an unlisted tag is a full release.
if ! git cat-file -e "$LEDGER_SHA:$LEDGER" 2>/dev/null; then
  echo "server-only-guard: $TAG is not listed ($LEDGER absent at $LEDGER_REF): full release"
  exit 3
fi
LEDGER_TEXT=$(git show "$LEDGER_SHA:$LEDGER") || fail "cannot read $LEDGER at '$LEDGER_REF'"
ROWS=$(printf '%s\n' "$LEDGER_TEXT" | awk -F '\t' -v t="$TAG" '$1 == t')
if [ -z "$ROWS" ]; then
  echo "server-only-guard: $TAG is not listed in $LEDGER at $LEDGER_REF: full release"
  exit 3
fi
[ "$(printf '%s\n' "$ROWS" | wc -l | tr -d ' ')" -eq 1 ] || fail "'$TAG' is listed more than once"
IFS=$'\t' read -r _ ROW_COMMIT BASE _ <<< "$ROWS"
[ "$ROW_COMMIT" = "$COMMIT" ] || fail "ledger row for '$TAG' names commit '$ROW_COMMIT', but the release commit is $COMMIT"
[[ "$BASE" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "ledger row for '$TAG' names an invalid base '$BASE'"
BASE_SHA=$(git rev-parse --verify --quiet "refs/tags/$BASE^{commit}") || fail "base tag '$BASE' does not exist"

# 2. The base must carry the guard at all.
git cat-file -e "$BASE_SHA:$GUARD" 2>/dev/null || \
  fail "base $BASE predates server-only support (no $GUARD in its tree) — cut a full release"

# 3. Belt and braces: the release machinery must be byte-identical between the
#    base and the candidate. This bootstrap itself is covered by it.
MACHINERY=$(git diff --no-renames --name-only "$BASE_SHA" "$COMMIT" -- \
  scripts/release \
  '.github/workflows/release*.yml' \
  '.github/workflows/promote-*.yml' \
  .github/release-provenance \
  ":(exclude)$LEDGER") || fail "cannot diff $BASE..$COMMIT"
if [ -n "$MACHINERY" ]; then
  printf '%s\n' "$MACHINERY" | sed 's/^/  /' >&2
  fail "release machinery changed since $BASE — cut a full release"
fi

# 4. Execute the BASE's guard with the BASE's policy files.
WORK=$(mktemp -d) || fail "cannot create a temporary directory"
trap 'rm -rf "$WORK"' EXIT
WORK=$(cd "$WORK" && pwd -P) || fail "cannot resolve the temporary directory"
git archive --format=tar "$BASE_SHA" scripts/release | tar -x -C "$WORK" || fail "cannot extract the guard from $BASE"
[ -f "$WORK/$GUARD" ] || fail "base $BASE predates server-only support — cut a full release"

bash "$WORK/$GUARD" \
  --repo "$REPO" \
  --tag "$TAG" \
  --commit "$COMMIT" \
  --declared-base "$BASE" \
  --main-ref "$MAIN_REF" \
  --ledger-ref "$LEDGER_SHA" \
  "${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}"
STATUS=$?
if [ "$STATUS" -eq 0 ]; then
  exit 0
fi
# Never let a guard failure read as "not listed".
exit 1
