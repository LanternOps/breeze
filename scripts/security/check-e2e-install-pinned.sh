#!/usr/bin/env bash
# Fails when a workflow step installs e2e-tests dependencies without the
# committed package-lock.json (#11197). e2e-tests is outside the pnpm
# workspace and has no pnpm lockfile, so `pnpm install` / `npm install` there
# resolve version ranges at run time; only `npm ci` is lockfile-pinned.
#
# A step is flagged when any non-comment line in it (single-line `run:` or a
# `run: |` block) is a floating install AND the step targets e2e-tests via
# `working-directory:` (quoted / ./ / trailing-slash spellings accepted), a
# job-level `defaults.run.working-directory`, `cd e2e-tests`, `--dir`/`--prefix
# e2e-tests`.
#
# Usage: check-e2e-install-pinned.sh [repo-root]   (default: this repo)
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

[[ -f e2e-tests/package-lock.json ]] || { echo "ERROR: e2e-tests/package-lock.json is missing" >&2; exit 1; }
shopt -s nullglob
files=(.github/workflows/*.yml .github/workflows/*.yaml .github/actions/*/action.yml)
(( ${#files[@]} > 0 )) || { echo "ERROR: no workflow files found" >&2; exit 1; }

# Positive control: the guard must see at least one e2e-tests step, so a
# renamed key or an empty glob cannot turn it into a vacuous pass.
grep -Eq 'working-directory:.*e2e-tests' "${files[@]}" ||
  { echo "ERROR: found no e2e-tests install step to inspect (guard is stale?)" >&2; exit 1; }

bad=0
for f in "${files[@]}"; do
  out="$(awk -v F="$f" '
    function floating(s) {
      return s ~ /(pnpm|yarn)[[:space:]]+(.*[[:space:]])?(install|add|i)([[:space:]]|$)/ || s ~ /npm[[:space:]]+(.*[[:space:]])?(install|i)([[:space:]]|$)/
    }
    function targets(s) {
      return s ~ /(cd|--dir|--prefix)[[:space:]=]+["\x27]?(\.\/)?e2e-tests/
    }
    function flush() {
      if (hit && (wd || filewd || tgt)) print F ":" hitline ": " hittext
      hit=0; wd=0; tgt=0
    }
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*defaults:/ { indef=1 }
    /^[[:space:]]*steps:/ { indef=0 }
    /^[[:space:]]*-[[:space:]]+[A-Za-z_-]+:/ { flush() }
    /working-directory:[[:space:]]*["\x27]?(\.\/)?e2e-tests\/?["\x27]?[[:space:]]*(#.*)?$/ { if (indef) filewd=1; else wd=1 }
    {
      if (floating($0) && !hit) { hit=1; hitline=NR; hittext=$0; sub(/^[[:space:]]+/, "", hittext) }
      if (targets($0)) tgt=1
    }
    END { flush() }
  ' "$f" | sort -u)"
  if [[ -n "$out" ]]; then
    echo "$out" >&2
    bad=1
  fi
done

if (( bad )); then
  echo "ERROR: e2e-tests dependencies must be installed with 'npm ci' (lockfile-pinned), not a floating install (#11197)" >&2
  exit 1
fi
echo "e2e-tests install steps are lockfile-pinned."
