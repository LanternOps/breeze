#!/usr/bin/env bash
# Reads changed-file paths on stdin (one per line) and prints three lines in
# GITHUB_OUTPUT form: `code=true|false`, `docs=true|false`, `agent=true|false`.
#
# A documentation path is docs/**, apps/docs/**, or a *.md / *.mdx file
# anywhere — the exact set `ci.yml` used to `paths-ignore` and `docs-ci.yml`
# used to trigger on. `code=false` means EVERY path is documentation, so the
# code jobs are skipped; `docs=true` means at least one is, so the docs check
# (astro check + build) runs.
#
# `agent=true` gates the Recovery media E2E (QEMU) job, which only exercises
# `agent/**`: true when any changed path starts with `agent/`, OR is
# `.github/workflows/ci.yml` itself, OR is this classifier script — both of
# which can change what the job runs without touching agent/ at all.
#
# Fail-closed: an empty file list is `code=true docs=true agent=true`.
# Deciding "nothing changed" from no evidence is how a broken listing would
# green a PR (or silently skip a job that should have run).
set -euo pipefail

code=false
docs=false
agent=false
seen=false
while IFS= read -r path; do
  [[ -z "${path}" ]] && continue
  seen=true
  case "${path}" in
    docs/*|apps/docs/*|*.md|*.mdx) docs=true ;;
    *) code=true ;;
  esac
  case "${path}" in
    agent/*|.github/workflows/ci.yml|.github/scripts/classify-pr-paths.sh) agent=true ;;
  esac
done

if [[ "${seen}" != "true" ]]; then
  echo "classify-pr-paths: no changed files listed; treating as a code+docs+agent change (fail-closed)" >&2
  code=true
  docs=true
  agent=true
fi

echo "code=${code}"
echo "docs=${docs}"
echo "agent=${agent}"
