#!/usr/bin/env bash
# Fails when a workflow step installs e2e-tests dependencies without the
# committed package-lock.json (#11197). e2e-tests is outside the pnpm
# workspace and has no pnpm lockfile, so `pnpm install` / `npm install` there
# resolve version ranges at run time; only `npm ci` is lockfile-pinned.
#
# Usage: check-e2e-install-pinned.sh [repo-root]   (default: this repo)
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

[[ -f e2e-tests/package-lock.json ]] || { echo "ERROR: e2e-tests/package-lock.json is missing" >&2; exit 1; }
shopt -s nullglob
files=(.github/workflows/*.yml .github/workflows/*.yaml)
(( ${#files[@]} > 0 )) || { echo "ERROR: no workflow files found" >&2; exit 1; }

bad=0
for f in "${files[@]}"; do
  # Per step (a `- name:`/`- uses:`/`- run:` item): flag a floating install
  # when the step's working-directory is e2e-tests, or when a run line does
  # `cd e2e-tests` first. Only single-line `run:` values are inspected.
  out="$(awk -v F="$f" '
    function floating(s) {
      return s ~ /(pnpm|yarn)[[:space:]]+(install|add|i)([[:space:]]|$)/ || s ~ /npm[[:space:]]+(install|i)([[:space:]]|$)/
    }
    function flush() { if (wd && runfloat) print F ":" runline ": " runtext; wd=0; runfloat=0 }
    /^[[:space:]]*-[[:space:]]+[a-z-]+:/ { flush() }
    /working-directory:[[:space:]]*e2e-tests[[:space:]]*$/ { wd=1 }
    /^[[:space:]]*(-[[:space:]]+)?run:/ {
      line=$0; sub(/^[[:space:]]*(-[[:space:]]+)?run:[[:space:]]*/, "", line)
      if (floating(line)) {
        runfloat=1; runline=NR; runtext=line
        if (line ~ /cd[[:space:]]+e2e-tests/) print F ":" NR ": " line
      }
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
