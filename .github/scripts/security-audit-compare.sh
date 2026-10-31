#!/usr/bin/env bash
# ci.yml security-audit: the dependency audit blocks only on advisories the
# change introduces (W1, #10744). A newly published advisory against a package
# already on the base would otherwise fail every PR and queue entry at once
# (3 merge-queue ejections in one sampled week); here it is a warning, and it
# surfaces on main through security.yml's daily npm-audit tracking issue.
#
# Decision tree (tested end to end by security-audit-compare.test.mjs):
#   - head passes → pass (the base is never scanned);
#   - head wrote no findings document → scan integrity / tooling failure →
#     block, whatever the base says;
#   - no usable base (no CI_BASE_SHA, base commit missing, base files
#     unreadable, base scan wrote no document) → block on every blocking
#     advisory, as before this gate existed;
#   - else new-findings.mjs: block on blocking findings the head adds; findings
#     on both warn; an expired / out-of-policy exception blocks only when the
#     change edits the exceptions file (a failed diff counts as an edit).
#
# Env: CI_BASE_SHA (empty → no base), RUNNER_TEMP (scratch dir; a fresh temp
# dir when unset), GITHUB_EVENT_NAME (messages only). Runs from the repo root.
#
# NOTE: no -e. Every exit status below is handled explicitly; the script's
# own exit is always one of the decisions listed above.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
gate=scripts/security/check-npm-audit.sh
exceptions=scripts/security/npm-audit-exceptions.json
base_sha="${CI_BASE_SHA:-}"
work="${RUNNER_TEMP:-}"
if [ -z "$work" ]; then
  work="$(mktemp -d)" || exit 1
fi
head_json="${work}/npm-audit-head.json"
base_json="${work}/npm-audit-base.json"

bash "$gate" --findings-json "$head_json"
head_status=$?
if [ "$head_status" -eq 0 ]; then
  exit 0
fi
# The gate writes its findings document only after every integrity check
# passed, so a missing one is never compared away.
if [ ! -s "$head_json" ]; then
  echo "::error title=Dependency audit failed::The head scan failed before producing findings (scanner exit, package-count mismatch, or an unusable exceptions file) — see the log above. This blocks regardless of the base."
  exit 1
fi
if [ -z "$base_sha" ]; then
  echo "::notice title=Dependency audit::No base commit for a ${GITHUB_EVENT_NAME:-local} run; every blocking advisory blocks."
  exit "$head_status"
fi
base_dir="${work}/npm-audit-base"
rm -rf "$base_dir" && mkdir -p "$base_dir" || exit "$head_status"
# The lockfile keeps its basename: osv-scanner picks the parser by it.
if ! git cat-file -e "${base_sha}^{commit}" 2>/dev/null \
  || ! git show "${base_sha}:pnpm-lock.yaml" > "$base_dir/pnpm-lock.yaml" \
  || ! git show "${base_sha}:${exceptions}" > "$base_dir/npm-audit-exceptions.json"; then
  echo "::warning title=Audit comparison disabled::Could not read the lockfile and exceptions file at base ${base_sha}; every blocking advisory blocks."
  exit "$head_status"
fi

echo "Head audit failed on advisories or exceptions (exit ${head_status}); comparing against base ${base_sha} — only what this change introduces blocks."
echo "::group::Dependency audit at base ${base_sha}"
bash "$gate" --lockfile "$base_dir/pnpm-lock.yaml" --exceptions "$base_dir/npm-audit-exceptions.json" --findings-json "$base_json"
base_status=$?
echo "::endgroup::"
if [ ! -s "$base_json" ]; then
  echo "::warning title=Audit comparison disabled::The base scan failed before producing findings (exit ${base_status}); every blocking advisory blocks."
  exit "$head_status"
fi

compare=(--base "$base_json" --head "$head_json")
# Unknown → touched (fail closed: an out-of-policy exception blocks).
if touched=$(git diff --name-only --no-renames "$base_sha" HEAD -- "$exceptions"); then
  if [ -n "$touched" ]; then
    compare+=(--exceptions-touched)
  fi
else
  echo "::warning::Could not diff ${exceptions} against base; treating it as edited."
  compare+=(--exceptions-touched)
fi
node .github/scripts/new-findings.mjs "${compare[@]}"
compare_status=$?
if [ "$compare_status" -eq 0 ]; then
  echo "::notice title=Dependency audit::The head audit's errors above are all already on base ${base_sha} (or are exceptions out of policy in a file this change does not edit); nothing this change introduces blocks."
fi
exit "$compare_status"
