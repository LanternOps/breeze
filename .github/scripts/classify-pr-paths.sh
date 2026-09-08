#!/usr/bin/env bash
# Reads changed-file paths on stdin (one per line) and prints `code=true` or
# `code=false` in GITHUB_OUTPUT form.
#
# `code=false` means EVERY path is documentation: docs/**, apps/docs/**, or a
# *.md / *.mdx file anywhere. This is the exact path set `ci.yml` used to
# `paths-ignore` (and `ci-docs-only.yml` used to own), so a docs-only PR skips
# the code jobs and a PR touching anything else runs the full suite.
#
# Fail-closed: an empty file list is `code=true`. Deciding "nothing changed"
# from no evidence is how a broken listing would green a PR.
set -euo pipefail

code=false
seen=false
while IFS= read -r path; do
  [[ -z "${path}" ]] && continue
  seen=true
  case "${path}" in
    docs/*|apps/docs/*|*.md|*.mdx) ;;
    *) code=true; break ;;
  esac
done

if [[ "${seen}" != "true" ]]; then
  echo "classify-pr-paths: no changed files listed; treating as a code change (fail-closed)" >&2
  code=true
fi

echo "code=${code}"
