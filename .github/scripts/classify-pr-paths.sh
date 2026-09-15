#!/usr/bin/env bash
# Reads changed-file paths on stdin (one per line) and prints three lines in
# GITHUB_OUTPUT form: `code=true|false`, `docs=true|false` and
# `recovery_media=true|false`.
#
# A documentation path is docs/**, apps/docs/**, or a *.md / *.mdx file
# anywhere — the exact set `ci.yml` used to `paths-ignore` and `docs-ci.yml`
# used to trigger on. `code=false` means EVERY path is documentation, so the
# code jobs are skipped; `docs=true` means at least one is, so the docs check
# (astro check + build) runs.
#
# `recovery_media=true` re-arms the recovery-media E2E (a ~30 min QEMU boot of
# a Debian live ISO built from breeze-backup). That job only consumes the agent
# module and the workflow itself, so it fires on any non-docs path under
# agent/, on ci.yml, or on this classifier — never on an api/web/mobile-only
# change. It is a subset of `code`: a docs-only PR skips it with everything
# else.
#
# Fail-closed: an empty file list is `code=true docs=true recovery_media=true`.
# Deciding "nothing changed" from no evidence is how a broken listing would green a PR.
set -euo pipefail

code=false
docs=false
recovery_media=false
seen=false
while IFS= read -r path; do
  [[ -z "${path}" ]] && continue
  seen=true
  case "${path}" in
    docs/*|apps/docs/*|*.md|*.mdx) docs=true ;;
    *)
      code=true
      case "${path}" in
        agent/*|.github/workflows/ci.yml|.github/scripts/classify-pr-paths.sh) recovery_media=true ;;
      esac
      ;;
  esac
done

if [[ "${seen}" != "true" ]]; then
  echo "classify-pr-paths: no changed files listed; treating as a code+docs change (fail-closed)" >&2
  code=true
  docs=true
  recovery_media=true
fi

echo "code=${code}"
echo "docs=${docs}"
echo "recovery_media=${recovery_media}"
