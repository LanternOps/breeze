#!/usr/bin/env bash
# Server-only release eligibility guard.
#
# NEVER run this file from the candidate's tree. run-server-only-guard.sh
# extracts it from the BASE (last full) release and executes that copy, so
# the policy files and helpers below are always the base release's: a
# candidate cannot weaken its own guard.
#
# Exit 0 = eligible, 1 = refused (fail closed), 2 = usage.

set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
POLICY="$SCRIPT_DIR/binary-affecting-paths.txt"
AGENT_FACING="$SCRIPT_DIR/agent-facing-paths.txt"
SEMVER_TOOL="$SCRIPT_DIR/sort-semver-tags.mjs"
LEDGER_TOOL="$SCRIPT_DIR/server-only-ledger.mjs"
PATH_TOOL="$SCRIPT_DIR/release-path-policy.mjs"
MANIFEST_TOOL="$SCRIPT_DIR/release-image-manifest.mjs"
CANDIDATE_LEDGER=".github/release-provenance/candidate-tags.tsv"
SIDE_BRANCH_LEDGER=".github/release-provenance/side-branch-tags.tsv"
STABLE_TAG_RE='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

usage() {
  cat >&2 <<'EOF'
usage: check-server-only-eligibility.sh --repo DIR --tag vX.Y.Z --commit SHA --declared-base vA.B.C
         --main-ref REF --ledger-ref REF [--online --expected-repository OWNER/REPO] [--report FILE]
EOF
  exit 2
}

fail() {
  echo "server-only-guard: REFUSED: $*" >&2
  exit 1
}

REPO=""
TAG=""
COMMIT=""
DECLARED_BASE=""
MAIN_REF=""
LEDGER_REF=""
ONLINE=false
EXPECTED_REPOSITORY=""
REPORT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo|--tag|--commit|--declared-base|--main-ref|--ledger-ref|--expected-repository|--report)
      [ "$#" -ge 2 ] && [ -n "$2" ] || usage
      case "$1" in
        --repo) REPO="$2" ;;
        --tag) TAG="$2" ;;
        --commit) COMMIT="$2" ;;
        --declared-base) DECLARED_BASE="$2" ;;
        --main-ref) MAIN_REF="$2" ;;
        --ledger-ref) LEDGER_REF="$2" ;;
        --expected-repository) EXPECTED_REPOSITORY="$2" ;;
        --report) REPORT="$2" ;;
      esac
      shift 2
      ;;
    --online) ONLINE=true; shift ;;
    *) usage ;;
  esac
done

[ -n "$REPO" ] && [ -n "$TAG" ] && [ -n "$COMMIT" ] && [ -n "$DECLARED_BASE" ] || usage
[ -n "$MAIN_REF" ] && [ -n "$LEDGER_REF" ] || usage
if [ "$ONLINE" = true ] && [ -z "$EXPECTED_REPOSITORY" ]; then usage; fi
for helper in "$POLICY" "$AGENT_FACING" "$SEMVER_TOOL" "$LEDGER_TOOL" "$PATH_TOOL" "$MANIFEST_TOOL"; do
  [ -f "$helper" ] || fail "guard installation is incomplete: missing $helper"
done

g() { git -C "$REPO" "$@"; }
in_repo() { (cd "$REPO" && "$@"); }

CHANGED=$(mktemp)
AGENT_HITS=$(mktemp)
OFFENDING=$(mktemp)
TRAILER=$(mktemp)
MANIFEST_DIR=""
cleanup() {
  rm -f "$CHANGED" "$AGENT_HITS" "$OFFENDING" "$TRAILER"
  if [ -n "$MANIFEST_DIR" ]; then rm -rf "$MANIFEST_DIR"; fi
}
trap cleanup EXIT

# Silence is never "clean". A helper CLI whose entry-point check misses loads,
# prints nothing and exits 0, which would read as "no protected path changed"
# or "no server-only tags". Every helper whose empty output is meaningful ends
# with a stderr trailer; it must be the last line and its counts must agree
# with what we fed in and got back.
count_lines() {
  if [ -s "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi
}
require_trailer() {
  local expected="$1" what="$2" actual
  actual=$(sed -n '$p' "$TRAILER")
  [ "$actual" = "$expected" ] || fail "$what did not confirm its result (expected trailer '$expected', got '${actual:-nothing}')"
}
# match_paths POLICY OUT: the CHANGED paths that POLICY protects, proven complete.
match_paths() {
  local policy="$1" out="$2"
  if ! node "$PATH_TOOL" match --policy "$policy" < "$CHANGED" > "$out" 2> "$TRAILER"; then
    cat "$TRAILER" >&2
    fail "path policy tool failed on $policy"
  fi
  require_trailer "# matched=$(count_lines "$out") of $CHANGED_COUNT" "path policy tool ($policy)"
}

# 1. Full history, well-formed identifiers.
SHALLOW=$(g rev-parse --is-shallow-repository 2>/dev/null) || fail "'$REPO' is not a Git repository"
[ "$SHALLOW" != "true" ] || fail "shallow repository cannot prove release ancestry; fetch full history and tags"
[[ "$TAG" =~ $STABLE_TAG_RE ]] || fail "'$TAG' is not a stable release tag; only vMAJOR.MINOR.PATCH may be server-only"
[[ "$DECLARED_BASE" =~ $STABLE_TAG_RE ]] || fail "declared base '$DECLARED_BASE' is not a stable release tag"
[ "$DECLARED_BASE" != "$TAG" ] || fail "base must differ from the tag"
COMMIT=$(g rev-parse --verify --quiet "$COMMIT^{commit}") || fail "cannot resolve commit '$COMMIT'"
g rev-parse --verify --quiet "$MAIN_REF^{commit}" >/dev/null || fail "cannot resolve main ref '$MAIN_REF'"
g rev-parse --verify --quiet "$LEDGER_REF^{commit}" >/dev/null || fail "cannot resolve ledger ref '$LEDGER_REF'"

# 2. The row, read from the ledger ref (never the candidate tree).
in_repo node "$LEDGER_TOOL" validate --ref "$LEDGER_REF" >/dev/null || fail "server-only ledger at '$LEDGER_REF' is invalid"
set +e
ROW=$(in_repo node "$LEDGER_TOOL" row --ref "$LEDGER_REF" --tag "$TAG")
ROW_STATUS=$?
set -e
[ "$ROW_STATUS" -eq 0 ] || fail "'$TAG' is not listed in the server-only ledger at '$LEDGER_REF'"
IFS=$'\t' read -r _ ROW_COMMIT ROW_BASE _ <<< "$ROW"
[ "$ROW_COMMIT" = "$COMMIT" ] || fail "ledger row for '$TAG' names commit $ROW_COMMIT, not $COMMIT"
[ "$ROW_BASE" = "$DECLARED_BASE" ] || fail "ledger row for '$TAG' names base $ROW_BASE, not $DECLARED_BASE"

# 3. An existing tag must peel to exactly the row's commit.
if g rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null; then
  TAG_SHA=$(g rev-parse "refs/tags/$TAG^{commit}")
  [ "$TAG_SHA" = "$COMMIT" ] || fail "tag '$TAG' points at $TAG_SHA, but the ledger row names $COMMIT"
fi

# 4. A server-only tag may not also be a candidate or side-branch release.
for other in "$CANDIDATE_LEDGER" "$SIDE_BRANCH_LEDGER"; do
  if g cat-file -e "$LEDGER_REF:$other" 2>/dev/null; then
    if g show "$LEDGER_REF:$other" | awk -F '\t' -v t="$TAG" '$1 == t { found = 1 } END { exit found ? 0 : 1 }'; then
      fail "'$TAG' is also listed in $other; a tag belongs to exactly one provenance ledger"
    fi
  fi
done

# 5. Globally highest stable version. promote-signed-release-images moves
#    :latest/:X.Y/:X unconditionally, so an older-line server-only release
#    would move them backwards.
# Sorting never runs behind `head` or `|| true`: a sorter failure must refuse,
# not silently yield an empty "highest" and skip the check.
sort_desc() {
  node "$SEMVER_TOOL" --sort-desc || fail "cannot order release tags"
}
first_line() {
  printf '%s\n' "$1" | sed -n '1p'
}
ALL_TAGS=$(g tag -l 'v*') || fail "cannot list release tags"
OTHER_STABLE=$(printf '%s\n' "$ALL_TAGS" | { grep -E "$STABLE_TAG_RE" || true; } | { grep -vxF "$TAG" || true; })
SORTED_OTHERS=$(printf '%s' "$OTHER_STABLE" | sort_desc)
HIGHEST_OTHER=$(first_line "$SORTED_OTHERS")
if [ -n "$HIGHEST_OTHER" ]; then
  SORTED_WITH_TAG=$(printf '%s\n%s\n' "$HIGHEST_OTHER" "$TAG" | sort_desc)
  TOP=$(first_line "$SORTED_WITH_TAG")
  [ "$TOP" = "$TAG" ] || fail "'$TAG' is not the globally highest stable version ($HIGHEST_OTHER exists); server-only releases are only possible on the newest line"
fi

# 6. Mainline.
g merge-base --is-ancestor "$COMMIT" "$MAIN_REF" || fail "commit $COMMIT is not reachable from '$MAIN_REF'"

# 7. The base is the highest stable ancestor tag that is not itself server-only.
LEDGER_TAGS=$(in_repo node "$LEDGER_TOOL" tags --ref "$LEDGER_REF" 2> "$TRAILER") || \
  { cat "$TRAILER" >&2; fail "cannot read server-only ledger tags at '$LEDGER_REF'"; }
LEDGER_TAG_COUNT=$(printf '%s' "$LEDGER_TAGS" | { grep -c . || true; })
require_trailer "# tags=$LEDGER_TAG_COUNT" "server-only ledger tool (tags at '$LEDGER_REF')"
if printf '%s\n' "$LEDGER_TAGS" | grep -qxF "$DECLARED_BASE"; then
  fail "declared base '$DECLARED_BASE' is itself a server-only release; chained hotfixes must name the last FULL release"
fi
g rev-parse --verify --quiet "refs/tags/$DECLARED_BASE" >/dev/null || fail "base tag '$DECLARED_BASE' does not exist"
BASE_SHA=$(g rev-parse "refs/tags/$DECLARED_BASE^{commit}")
g merge-base --is-ancestor "$BASE_SHA" "$COMMIT" || fail "base '$DECLARED_BASE' is not an ancestor of $COMMIT"
MERGED_TAGS=$(g tag --merged "$COMMIT" -l 'v*') || fail "cannot list tags merged into $COMMIT"
CANDIDATE_BASES=$(
  printf '%s\n' "$MERGED_TAGS" \
    | { grep -E "$STABLE_TAG_RE" || true; } \
    | { grep -vxF "$TAG" || true; } \
    | { if [ -n "$LEDGER_TAGS" ]; then grep -vxF -f <(printf '%s\n' "$LEDGER_TAGS") || true; else cat; fi; }
)
SORTED_BASES=$(printf '%s' "$CANDIDATE_BASES" | sort_desc)
COMPUTED_BASE=$(first_line "$SORTED_BASES")
[ -n "$COMPUTED_BASE" ] || fail "no full release is an ancestor of $COMMIT"
[ "$COMPUTED_BASE" = "$DECLARED_BASE" ] || fail "declared base '$DECLARED_BASE' is not the last full release before $COMMIT (computed '$COMPUTED_BASE')"

# 8. Nothing binary-affecting changed since the base. --no-renames reports a
#    move out of a protected directory as a deletion there.
#    Self-test first: the matcher must flag a path the policy is known to
#    protect before an empty result is trusted as "nothing protected changed".
SELF_TEST=$(printf 'agent/go.mod\0apps/web/src/self-test.tsx\0' | node "$PATH_TOOL" match --policy "$POLICY" 2> "$TRAILER") || \
  { cat "$TRAILER" >&2; fail "path policy tool self-test failed to run"; }
[ "$SELF_TEST" = "agent/go.mod" ] || \
  fail "path policy tool self-test: $POLICY did not flag exactly agent/go.mod (got '${SELF_TEST:-nothing}')"
require_trailer "# matched=1 of 2" "path policy tool self-test"
g -c core.quotePath=false diff --no-renames --name-only -z "$BASE_SHA" "$COMMIT" > "$CHANGED" || \
  fail "cannot diff $BASE_SHA..$COMMIT"
CHANGED_COUNT=$(tr -cd '\0' < "$CHANGED" | wc -c | tr -d ' ')
match_paths "$POLICY" "$OFFENDING"
if [ -s "$OFFENDING" ]; then
  echo "server-only-guard: binary-affecting paths changed since $DECLARED_BASE:" >&2
  sed 's/^/  /' "$OFFENDING" >&2
  fail "cut a full release; ${TAG} cannot be server-only"
fi

# 8b. The release trust anchor. The root .env.example is not binary-affecting
#     (it may document new server env vars), but it carries the release-manifest
#     public key and the signing-key-id switch that installs copy from the
#     release tag. A server-only release ships the BASE's signed binaries, so it
#     must not change the key those binaries are verified under. Any active
#     assignment of either variable, in any spelling the env loaders accept,
#     must be byte-identical to the base.
TRUST_ANCHOR_RE='^[[:space:]]*(export[[:space:]]+)?(RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS|AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID)[[:space:]]*='
trust_anchor_lines() {
  if g cat-file -e "$1:.env.example" 2>/dev/null; then
    g show "$1:.env.example" | { grep -E "$TRUST_ANCHOR_RE" || true; }
  fi
}
BASE_ANCHOR=$(trust_anchor_lines "$BASE_SHA") || fail "cannot read .env.example at $DECLARED_BASE"
CANDIDATE_ANCHOR=$(trust_anchor_lines "$COMMIT") || fail "cannot read .env.example at $COMMIT"
if [ "$BASE_ANCHOR" != "$CANDIDATE_ANCHOR" ]; then
  echo "server-only-guard: $DECLARED_BASE:" >&2
  printf '%s\n' "${BASE_ANCHOR:-  (none)}" | sed 's/^/  /' >&2
  echo "server-only-guard: $TAG:" >&2
  printf '%s\n' "${CANDIDATE_ANCHOR:-  (none)}" | sed 's/^/  /' >&2
  fail "the release trust anchor in .env.example changed since $DECLARED_BASE; cut a full release"
fi

match_paths "$AGENT_FACING" "$AGENT_HITS"

# 9. --online: the base must be a published, stable, signed FULL release built
#    from exactly BASE_SHA.
if [ "$ONLINE" = true ]; then
  command -v gh >/dev/null 2>&1 || fail "--online requires the gh CLI"
  RELEASE_JSON=$(gh release view "$DECLARED_BASE" --repo "$EXPECTED_REPOSITORY" --json isDraft,isPrerelease) || \
    fail "cannot read GitHub Release '$DECLARED_BASE'"
  RELEASE_STATE=$(node -e 'const r = JSON.parse(process.argv[1]); console.log(`${r.isDraft} ${r.isPrerelease}`)' "$RELEASE_JSON") || \
    fail "cannot parse GitHub Release '$DECLARED_BASE'"
  [ "$RELEASE_STATE" = "false false" ] || fail "base release '$DECLARED_BASE' must be published and stable (isDraft isPrerelease = $RELEASE_STATE)"
  MANIFEST_DIR=$(mktemp -d)
  gh release download "$DECLARED_BASE" --repo "$EXPECTED_REPOSITORY" --dir "$MANIFEST_DIR" \
    --pattern release-artifact-manifest.json --pattern release-artifact-manifest.json.ed25519 \
    || fail "cannot download the signed manifest of '$DECLARED_BASE'"
  node "$MANIFEST_TOOL" verify \
    --manifest "$MANIFEST_DIR/release-artifact-manifest.json" \
    --signature "$MANIFEST_DIR/release-artifact-manifest.json.ed25519" \
    --expected-repository "$EXPECTED_REPOSITORY" \
    --expected-release "$DECLARED_BASE" \
    --require-kind full \
    --output "$MANIFEST_DIR/identity.json" >/dev/null \
    || fail "the signed manifest of '$DECLARED_BASE' does not verify as a full release"
  MANIFEST_SOURCE=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).sourceCommit)' "$MANIFEST_DIR/identity.json")
  [ "$MANIFEST_SOURCE" = "$BASE_SHA" ] || fail "the signed manifest of '$DECLARED_BASE' names sourceCommit $MANIFEST_SOURCE, but the tag peels to $BASE_SHA"
fi

BINARIES_VERSION="${DECLARED_BASE#v}"
if [ -n "$REPORT" ]; then
  node - "$REPORT" "$AGENT_HITS" "$TAG" "$COMMIT" "$DECLARED_BASE" "$BASE_SHA" "$BINARIES_VERSION" "$CHANGED_COUNT" "$ONLINE" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [reportPath, hitsPath, tag, commit, base, baseSha, binariesVersion, changed, online] = process.argv.slice(2);
const agentFacing = readFileSync(hitsPath, 'utf8').split('\n').filter(Boolean);
writeFileSync(reportPath, `${JSON.stringify({
  tag,
  commit,
  base,
  baseSha,
  binariesVersion,
  changedPathCount: Number(changed),
  online: online === 'true',
  agentFacing,
}, null, 2)}\n`);
NODE
fi

echo "server-only-guard: ELIGIBLE: $TAG ($COMMIT) is server-only against $DECLARED_BASE ($BASE_SHA); $CHANGED_COUNT path(s) changed"
if [ -s "$AGENT_HITS" ]; then
  echo "server-only-guard: agent-facing server changes (required review — must stay compatible with $DECLARED_BASE agents):"
  sed 's/^/  /' "$AGENT_HITS"
else
  echo "server-only-guard: agent-facing server changes: none"
fi
