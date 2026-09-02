#!/usr/bin/env bash
# Classify an exact release tag against a main ref and reviewed candidate ledger.

set -euo pipefail

REGISTRY_PATH=".github/release-provenance/candidate-tags.tsv"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SEMVER_TOOL="$SCRIPT_DIR/sort-semver-tags.mjs"

usage() {
  cat >&2 <<'EOF'
usage: check-release-lineage.sh --tag TAG --main-ref REF --candidate-registry-ref REF [--allow-unclassified] [--require-mainline]
EOF
  exit 2
}

fail() {
  echo "release-lineage: error: $*" >&2
  exit 1
}

TAG=""
MAIN_REF=""
CANDIDATE_REGISTRY_REF=""
ALLOW_UNCLASSIFIED=false
REQUIRE_MAINLINE=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag)
      [ "$#" -ge 2 ] || usage
      TAG="$2"
      shift 2
      ;;
    --main-ref)
      [ "$#" -ge 2 ] || usage
      MAIN_REF="$2"
      shift 2
      ;;
    --candidate-registry-ref)
      [ "$#" -ge 2 ] || usage
      CANDIDATE_REGISTRY_REF="$2"
      shift 2
      ;;
    --allow-unclassified)
      ALLOW_UNCLASSIFIED=true
      shift
      ;;
    --require-mainline)
      REQUIRE_MAINLINE=true
      shift
      ;;
    *) usage ;;
  esac
done

[ -n "$TAG" ] || usage
[ -n "$MAIN_REF" ] || usage
[ -n "$CANDIDATE_REGISTRY_REF" ] || usage

SHALLOW=$(git rev-parse --is-shallow-repository 2>/dev/null) || \
  fail "not inside a Git repository"
[ "$SHALLOW" != "true" ] || \
  fail "shallow repository cannot prove release ancestry; fetch full history and tags"

node "$SEMVER_TOOL" --validate "$TAG" || \
  fail "invalid SemVer release tag '$TAG'"

TAG_SHA=$(git rev-parse "$TAG^{commit}" 2>/dev/null) || \
  fail "cannot resolve tag '$TAG' to a commit"
[[ "$TAG_SHA" =~ ^[0-9a-f]{40}$ ]] || \
  fail "tag '$TAG' resolved to invalid commit '$TAG_SHA'"

emit_channel() {
  local channel="$1"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      echo "channel=$channel"
      echo "tag=$TAG"
      echo "tag_sha=$TAG_SHA"
    } >> "$GITHUB_OUTPUT"
  fi
  echo "release-lineage: channel=$channel tag=$TAG tag_sha=$TAG_SHA main_ref=$MAIN_REF"
}

if git merge-base --is-ancestor "$TAG_SHA" "$MAIN_REF" 2>/dev/null; then
  emit_channel mainline
  exit 0
fi

if [[ ! "$TAG" =~ - ]]; then
  if [ "$ALLOW_UNCLASSIFIED" = true ]; then
    emit_channel unclassified
    exit 0
  fi
  fail "stable release tag '$TAG' is not reachable from main ref '$MAIN_REF'"
fi

REGISTRY_CONTENT=$(git show "$CANDIDATE_REGISTRY_REF:$REGISTRY_PATH" 2>/dev/null) || {
  if [ "$ALLOW_UNCLASSIFIED" = true ]; then
    emit_channel unclassified
    exit 0
  fi
  fail "candidate tag '$TAG' is not registered in $CANDIDATE_REGISTRY_REF:$REGISTRY_PATH"
}

SEEN_TAGS=$'\n'
MATCHED_SHA=""
LINE_NUMBER=0
while IFS= read -r line || [ -n "$line" ]; do
  LINE_NUMBER=$((LINE_NUMBER + 1))
  case "$line" in
    ""|'#'*) continue ;;
  esac

  IFS=$'\t' read -r row_tag row_sha row_ref row_note row_extra <<EOF
$line
EOF
  if [ -z "${row_tag:-}" ] || [ -z "${row_sha:-}" ] || \
     [ -z "${row_ref:-}" ] || [ -z "${row_note:-}" ] || \
     [ -n "${row_extra:-}" ]; then
    fail "malformed candidate registry row $LINE_NUMBER: expected four non-empty tab-separated fields"
  fi
  if ! node "$SEMVER_TOOL" --validate "$row_tag" || [[ "$row_tag" != *-* ]]; then
    fail "invalid candidate tag '$row_tag' at registry row $LINE_NUMBER"
  fi
  if [[ ! "$row_sha" =~ ^[0-9a-f]{40}$ ]]; then
    fail "invalid candidate SHA '$row_sha' at registry row $LINE_NUMBER"
  fi
  case "$SEEN_TAGS" in
    *$'\n'"$row_tag"$'\n'*) fail "duplicate candidate tag '$row_tag' in registry" ;;
  esac
  SEEN_TAGS="${SEEN_TAGS}${row_tag}"$'\n'

  row_actual_sha=$(git rev-parse "$row_tag^{commit}" 2>/dev/null) || \
    fail "candidate registry tag '$row_tag' cannot be resolved"
  if [ "$row_actual_sha" != "$row_sha" ]; then
    fail "candidate registry SHA mismatch for '$row_tag': recorded $row_sha, tag peels to $row_actual_sha"
  fi
  if [ "$row_tag" = "$TAG" ]; then
    MATCHED_SHA="$row_sha"
  fi
done <<< "$REGISTRY_CONTENT"

if [ -z "$MATCHED_SHA" ]; then
  if [ "$ALLOW_UNCLASSIFIED" = true ]; then
    emit_channel unclassified
    exit 0
  fi
  fail "candidate tag '$TAG' is not registered in $CANDIDATE_REGISTRY_REF:$REGISTRY_PATH"
fi

[ "$MATCHED_SHA" = "$TAG_SHA" ] || \
  fail "candidate tag '$TAG' does not match its registered SHA"

if [ "$REQUIRE_MAINLINE" = true ]; then
  fail "mainline ancestry is required; candidate '$TAG' cannot be promoted"
fi

emit_channel candidate
