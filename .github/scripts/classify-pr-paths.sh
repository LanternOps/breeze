#!/usr/bin/env bash
# Reads changed-file paths on stdin (one per line) and prints three lines in
# GITHUB_OUTPUT form: `code=true|false`, `docs=true|false` and
# `topology_browser=true|false`.
#
# A documentation path is docs/**, apps/docs/**, or a *.md / *.mdx file
# anywhere — the exact set `ci.yml` used to `paths-ignore` and `docs-ci.yml`
# used to trigger on. `code=false` means EVERY path is documentation, so the
# code jobs are skipped; `docs=true` means at least one is, so the docs check
# (astro check + build) runs.
#
# `topology_browser` gates the one job that builds the production web bundle
# and drives it in a real Chromium (`topology-browser-gate` in ci.yml, #6117).
# It is deliberately narrow: only the topology UI, the build/CSP configuration
# that governs how the layout module worker is emitted and allowed to run, the
# shared topology contracts the bundle validates against, the specs/fixtures
# themselves, and this workflow. It is matched only inside the non-docs branch,
# so `topology_browser=true` always implies `code=true` — the gate builds and
# boots the web app, which is meaningless on a PR that skips the code jobs.
#
# Fail-closed: an empty file list is `code=true docs=true topology_browser=true`.
# Deciding "nothing changed" from no evidence is how a broken listing would
# green a PR.
set -euo pipefail

code=false
docs=false
topology_browser=false
seen=false
while IFS= read -r path; do
  [[ -z "${path}" ]] && continue
  seen=true
  case "${path}" in
    docs/*|apps/docs/*|*.md|*.mdx) docs=true ;;
    *)
      code=true
      case "${path}" in
        apps/web/src/components/topology/*|\
        apps/web/src/middleware.*|\
        apps/web/astro.config.*|\
        apps/web/vite.config.*|\
        apps/web/package.json|\
        pnpm-lock.yaml|\
        packages/shared/src/validators/topology*|\
        packages/shared/src/types/topology*|\
        e2e-tests/playwright.topology-worker.config.ts|\
        e2e-tests/tests/topology-*.spec.ts|\
        e2e-tests/helpers/topology*|\
        e2e-tests/pages/TopologyPage.ts|\
        .github/workflows/ci.yml)
          topology_browser=true
          ;;
      esac
      ;;
  esac
done

if [[ "${seen}" != "true" ]]; then
  echo "classify-pr-paths: no changed files listed; treating as a code+docs change (fail-closed)" >&2
  code=true
  docs=true
  topology_browser=true
fi

echo "code=${code}"
echo "docs=${docs}"
echo "topology_browser=${topology_browser}"
