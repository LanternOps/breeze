#!/usr/bin/env bash
# PR-CI check for changes to .github/release-provenance/server-only-tags.tsv.
#
#   check-server-only-ledger-change.sh --base-ref A --head-ref B --main-ref M
#
# - the ledger at B must parse;
# - a row whose tag already exists may not be added, edited or removed (rows
#   precede their tag and are append-only once it exists);
# - every added row (and every edited row whose tag does not exist yet) is run
#   through the base-executed guard, offline, so a refusal shows up on the
#   ledger PR before any release minutes are spent;
# - each eligible row's agent-facing server changes are appended to
#   $GITHUB_STEP_SUMMARY for the required human review.

set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

usage() {
  echo "usage: check-server-only-ledger-change.sh --base-ref REF --head-ref REF --main-ref REF" >&2
  exit 2
}

BASE_REF=""
HEAD_REF=""
MAIN_REF=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base-ref) [ "$#" -ge 2 ] || usage; BASE_REF="$2"; shift 2 ;;
    --head-ref) [ "$#" -ge 2 ] || usage; HEAD_REF="$2"; shift 2 ;;
    --main-ref) [ "$#" -ge 2 ] || usage; MAIN_REF="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$BASE_REF" ] && [ -n "$HEAD_REF" ] && [ -n "$MAIN_REF" ] || usage

# Every node helper runs with the runner's NODE_OPTIONS removed and warnings
# off: helpers end with a completion trailer that must be the LAST stderr line,
# and this file is frozen into every base release, so a future runner whose
# Node prints a late warning (or preloads something) must not be able to
# refuse every server-only release from then on.
run_node() { env -u NODE_OPTIONS node --no-warnings "$@"; }

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"
  fi
}

REPORT_DIR=$(mktemp -d)
trap 'rm -rf "$REPORT_DIR"' EXIT
TRAILER="$REPORT_DIR/changed.trailer"

run_node "$SCRIPT_DIR/server-only-ledger.mjs" validate --ref "$HEAD_REF"
if ! CHANGES=$(run_node "$SCRIPT_DIR/server-only-ledger.mjs" changed --base-ref "$BASE_REF" --head-ref "$HEAD_REF" 2> "$TRAILER"); then
  cat "$TRAILER" >&2
  echo "::error::cannot diff the server-only ledger between $BASE_REF and $HEAD_REF"
  exit 1
fi
# An empty diff must be proven, not inferred from silence: the ledger tool's
# last stderr line reports how many rows it printed.
CHANGE_COUNT=$(printf '%s' "$CHANGES" | { grep -c . || true; })
TRAILER_LINE=$(sed -n '$p' "$TRAILER")
if [ "$TRAILER_LINE" != "# changed=$CHANGE_COUNT" ]; then
  echo "::error::server-only ledger tool did not confirm its result (expected trailer '# changed=$CHANGE_COUNT', got '${TRAILER_LINE:-nothing}')"
  exit 1
fi
if [ -z "$CHANGES" ]; then
  echo "no server-only ledger changes between $BASE_REF and $HEAD_REF"
  exit 0
fi

failed=0
while IFS=$'\t' read -r kind tag commit base; do
  [ -n "$kind" ] || continue
  tag_exists=false
  if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
    tag_exists=true
  fi

  if [ "$kind" = "added" ] && [ "$tag_exists" = true ]; then
    # Listing an already-pushed (full) release after the fact would make base
    # selection skip it, so the next hotfix would carry an older base's
    # binaries. The row must exist before the tag does.
    echo "::error::server-only ledger row for $tag was added, but $tag already exists; rows must be added before the tag is pushed"
    failed=1
    continue
  fi
  if [ "$kind" != "added" ] && [ "$tag_exists" = true ]; then
    echo "::error::server-only ledger row for $tag was $kind, but $tag already exists; rows are append-only once tagged"
    failed=1
    continue
  fi
  if [ "$kind" = "removed" ]; then
    echo "server-only ledger row for $tag removed before the tag was pushed: allowed"
    continue
  fi

  report="$REPORT_DIR/$tag.json"
  echo "::group::server-only guard for $tag ($commit, base $base)"
  if bash "$SCRIPT_DIR/run-server-only-guard.sh" \
      --tag "$tag" \
      --commit "$commit" \
      --ledger-ref "$HEAD_REF" \
      --main-ref "$MAIN_REF" \
      --report "$report"; then
    echo "::endgroup::"
    summary "### Server-only release $tag (base $base)" "" \
      "#### Agent-facing server changes — required review" \
      "A reviewer must confirm each change stays compatible with $base agents and that emitted scripts still match the $base binaries." ""
    agent_facing=$(run_node -e 'for (const path of JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).agentFacing) console.log(`- \`${path}\``)' "$report")
    summary "${agent_facing:-none}" ""
  else
    echo "::endgroup::"
    echo "::error::server-only ledger row for $tag is not eligible (see the guard output above)"
    failed=1
  fi
done <<< "$CHANGES"

exit "$failed"
