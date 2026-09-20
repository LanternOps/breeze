#!/usr/bin/env bash
# Reads changed-file paths on stdin (one per line) and prints eleven lines in
# GITHUB_OUTPUT form: `code`, `docs`, `agent`, `app`, the six area flags
# `api`, `web`, `portal`, `addins`, `m365`, `rust`, then `topology_browser` —
# each `true|false`.
#
# A documentation path is docs/**, apps/docs/**, or a *.md / *.mdx file
# anywhere — the exact set `ci.yml` used to `paths-ignore` and `docs-ci.yml`
# used to trigger on. `code=false` means EVERY path is documentation, so the
# code jobs are skipped; `docs=true` means at least one is, so the docs check
# (astro check + build) runs.
#
# `agent=true` gates the Recovery media E2E (QEMU) job: true when a changed
# path is in the job's pinned dependency set (qemu-gate-paths.txt beside this
# script — the two Go commands it builds, their transitive module-internal
# imports, go.mod/go.sum and recovery-media/), OR is `.github/workflows/ci.yml`
# itself, OR is this classifier script or that list — each of which can change
# what the job runs without touching agent/ at all.
#
# `app=false` gates the "tooling-only" class: a PR that touches only CI
# plumbing (workflow YAML other than ci.yml, `.github/scripts/**` other than
# this classifier and prepare-ci-apt-sources.mjs, `scripts/release/**`,
# `scripts/security/**` other than check-agent-binary-signatures.sh, and
# `.github/release-provenance/**`) skips the whole app suite (typecheck,
# test-api, test-web, builds, integration, ...). `app` starts false and only
# flips true when a non-docs path falls OUTSIDE that allowlist, so a
# docs-only PR (code=false) also reports app=false — harmless, since
# code=false already skips everything the app gate would. The explicit
# exceptions carve out files the allowlisted directories contain that a
# HEAVY job (not lint/check-migrations/security-audit) actually consumes:
# ci.yml itself; this classifier; prepare-ci-apt-sources.mjs (used by
# rust-check and guided-setup-smoke); check-agent-binary-signatures.sh (used
# by build-agent); verify-release-images.sh (copied and run by
# scripts/smoke-guided-setup.sh inside guided-setup-smoke — an INDIRECT
# consumer, so grep the scripts heavy jobs call, not just ci.yml);
# mobile-native-ci.test.mjs (listed in mobile-native-changes' paths-filter to
# trigger the native iOS build); qemu-gate-paths.txt (its drift test lives in
# agent/cmd/breeze-backup and runs in test-agent, which is app-gated). `.github/actions/**` is deliberately NOT
# allowlisted. Adding a file under an allowlisted directory that a heavy job
# runs? Add its carve-out here AND to the pinned list in the test.
#
# Area outputs (`api`, `web`, `portal`, `addins`, `m365`, `rust`) gate the
# heavy jobs that exercise exactly one application area (test-api,
# integration-test, test-web, the add-in and M365 suites, rust-check, ...).
# A wrong area gate SILENTLY skips a whole area's tests, so they fail OPEN:
#   - shared/global inputs (packages/**, the root manifests and lockfile,
#     patches/**, root tsconfig*, ci.yml, .github/scripts/**, docker/**,
#     root docker-compose* / Dockerfile*, scripts/**, ee/**) set EVERY area;
#   - a code path that matches no area rule (agent/**, e2e-tests/**, a new
#     top-level dir or app, ...) sets EVERY area;
#   - an area whose tests READ another area's files is also set when those
#     files change (see the cross-area block below). test-api carries the
#     repo-wide contract suites (Dockerfile/manifest enumeration over apps/*,
#     exchangeRateBoundary over apps/web/src + apps/portal/src, tierConfig
#     parity, the viewer input schema), so web/portal/viewer and every app's
#     Dockerfile/package.json also set `api`. `ci-area-gating.test.mjs` scans
#     the sources for such references and fails when one has no rule here.
# Docs paths set no area. apps/mobile/** sets none either: mobile is gated by
# its own `mobile-native-changes` filter and test-mobile rides `app`.
#
# `topology_browser` gates the one job that builds the production web bundle
# and drives it in a real Chromium (`topology-browser-gate` in ci.yml, #6117).
# It is deliberately narrow: only the topology UI, the build/CSP configuration
# that governs how the layout module worker is emitted and allowed to run, the
# shared topology contracts the bundle validates against, the specs/fixtures
# themselves, and this workflow. It is matched only inside the non-docs branch,
# so `topology_browser=true` always implies `code=true` — the gate builds and
# boots the web app, which is meaningless on a PR that skips the code jobs.
# Every path it matches also falls outside the tooling allowlist, so it implies
# `app=true` as well.
#
# Fail-closed: an empty file list is `code=true docs=true agent=true
# app=true topology_browser=true` and every area true. Deciding "nothing
# changed" from no evidence is how a broken listing would green a PR (or
# silently skip a job that should have run).
set -euo pipefail

# The QEMU job's dependency set, pinned beside this script (see that file's
# header). Missing or empty means we cannot tell what the job depends on, so
# every agent/ change runs it (fail closed).
QEMU_GATE_FILE="$(dirname "${BASH_SOURCE[0]}")/qemu-gate-paths.txt"
qemu_gate_entries=()
if [[ -r "${QEMU_GATE_FILE}" ]]; then
  while IFS= read -r line; do
    line="${line%%#*}"; line="${line//[[:space:]]/}"
    [[ -n "${line}" ]] && qemu_gate_entries+=("${line}")
  done < "${QEMU_GATE_FILE}"
fi
if [[ ${#qemu_gate_entries[@]} -eq 0 ]]; then
  echo "classify-pr-paths: qemu-gate-paths.txt missing or empty beside the classifier; every agent/ change will run the QEMU job (fail-closed)" >&2
fi
# qemu_gate_hit PATH — true when PATH is one of the pinned files or lies under
# one of the pinned directories. A pinned directory ends with '/', so
# 'agent/internal/backup/' cannot match 'agent/internal/backup2/x.go'.
qemu_gate_hit() {
  local p="$1" e
  [[ ${#qemu_gate_entries[@]} -eq 0 ]] && return 0
  for e in "${qemu_gate_entries[@]}"; do
    if [[ "${e}" == */ ]]; then
      [[ "${p}" == "${e}"* ]] && return 0
    else
      [[ "${p}" == "${e}" ]] && return 0
    fi
  done
  return 1
}

code=false
docs=false
agent=false
app=false
api=false
web=false
portal=false
addins=false
m365=false
rust=false
topology_browser=false
seen=false
all_areas() {
  api=true; web=true; portal=true; addins=true; m365=true; rust=true
}
while IFS= read -r path; do
  [[ -z "${path}" ]] && continue
  seen=true
  case "${path}" in
    docs/*|apps/docs/*|*.md|*.mdx) docs=true; continue ;;
    *) code=true ;;
  esac
  # Area (first match wins). In a case pattern `*` also matches '/', so the
  # root-only globals below are anchored by their leading literal.
  case "${path}" in
    packages/*|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|.npmrc|.node-version|.nvmrc|patches/*|tsconfig*.json) all_areas ;;
    .github/workflows/ci.yml|.github/scripts/*|docker/*|docker-compose*|Dockerfile*|scripts/*|ee/*) all_areas ;;
    apps/api/*) api=true ;;
    apps/web/*) web=true ;;
    apps/portal/*) portal=true ;;
    apps/excel-addin/*|apps/word-addin/*|apps/powerpoint-addin/*|apps/outlook-addin/*) addins=true ;;
    apps/m365-graph-read-executor/*|apps/m365-graph-actions-executor/*|apps/m365-communications-executor/*) m365=true ;;
    apps/viewer/*|apps/helper/*|Cargo.*|rust-toolchain*) rust=true ;;
    apps/mobile/*) : ;;
    *) all_areas ;;
  esac
  # Cross-area reads: the READING area must also run when these change.
  case "${path}" in
    apps/*/Dockerfile*|apps/*/package.json) api=true ;;
  esac
  case "${path}" in
    apps/web/*|apps/portal/*|apps/viewer/src/*) api=true ;;
    apps/api/src/routes/portal/*) portal=true ;;
  esac
  case "${path}" in
    .github/workflows/ci.yml|.github/scripts/classify-pr-paths.sh|.github/scripts/qemu-gate-paths.txt) agent=true ;;
    agent/*) qemu_gate_hit "${path}" && agent=true ;;
  esac
  case "${path}" in
    .github/workflows/ci.yml) app=true ;;
    .github/workflows/*.yml) : ;;
    .github/scripts/classify-pr-paths.sh) app=true ;;
    .github/scripts/prepare-ci-apt-sources.mjs) app=true ;;
    .github/scripts/mobile-native-ci.test.mjs) app=true ;;
    .github/scripts/qemu-gate-paths.txt) app=true ;;
    .github/scripts/*) : ;;
    scripts/security/check-agent-binary-signatures.sh) app=true ;;
    scripts/security/*) : ;;
    scripts/release/verify-release-images.sh) app=true ;;
    scripts/release/*) : ;;
    .github/release-provenance/*) : ;;
    *) app=true ;;
  esac
  # Topology production-browser gate (#6117): the topology UI, the web
  # build/CSP config that governs the layout module worker, the shared topology
  # contracts, the Chromium specs/fixtures and this workflow. Reached only on a
  # non-docs path (the docs branch above `continue`s), so it implies code=true.
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
    .github/workflows/ci.yml) topology_browser=true ;;
  esac
done

if [[ "${seen}" != "true" ]]; then
  echo "classify-pr-paths: no changed files listed; treating as a code+docs+agent+app+topology_browser change in every area (fail-closed)" >&2
  code=true
  docs=true
  agent=true
  app=true
  all_areas
  topology_browser=true
fi

echo "code=${code}"
echo "docs=${docs}"
echo "agent=${agent}"
echo "app=${app}"
echo "api=${api}"
echo "web=${web}"
echo "portal=${portal}"
echo "addins=${addins}"
echo "m365=${m365}"
echo "rust=${rust}"
echo "topology_browser=${topology_browser}"
