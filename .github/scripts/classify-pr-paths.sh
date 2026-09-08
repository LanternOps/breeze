#!/usr/bin/env bash
# Reads changed-file paths on stdin (one per line) and prints two lines in
# GITHUB_OUTPUT form: `code=true|false` and `docs=true|false`.
#
# A documentation path is docs/**, apps/docs/**, or a *.md / *.mdx file
# anywhere — the exact set `ci.yml` used to `paths-ignore` and `docs-ci.yml`
# used to trigger on. `code=false` means EVERY path is documentation, so the
# code jobs are skipped; `docs=true` means at least one is, so the docs check
# (astro check + build) runs.
#
# Fail-closed: an empty file list is `code=true docs=true`. Deciding "nothing
# changed" from no evidence is how a broken listing would green a PR.
set -euo pipefail

code=false
docs=false
seen=false
while IFS= read -r path; do
  [[ -z "${path}" ]] && continue
  seen=true
  case "${path}" in
    docs/*|apps/docs/*|*.md|*.mdx) docs=true ;;
    *) code=true ;;
  esac
done

if [[ "${seen}" != "true" ]]; then
  echo "classify-pr-paths: no changed files listed; treating as a code+docs change (fail-closed)" >&2
  code=true
  docs=true
fi

echo "code=${code}"
echo "docs=${docs}"
