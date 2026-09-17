#!/usr/bin/env bash
# Reads changed-file paths on stdin (one per line) and prints four lines in
# GITHUB_OUTPUT form: `code=true|false`, `docs=true|false`, `agent=true|false`,
# `app=true|false`.
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
# by build-agent). `.github/actions/**` is deliberately NOT allowlisted.
#
# Fail-closed: an empty file list is `code=true docs=true agent=true
# app=true`. Deciding "nothing changed" from no evidence is how a broken
# listing would green a PR (or silently skip a job that should have run).
set -euo pipefail

code=false
docs=false
agent=false
app=false
seen=false
while IFS= read -r path; do
  [[ -z "${path}" ]] && continue
  seen=true
  case "${path}" in
    docs/*|apps/docs/*|*.md|*.mdx) docs=true; continue ;;
    *) code=true ;;
  esac
  case "${path}" in
    agent/*|.github/workflows/ci.yml|.github/scripts/classify-pr-paths.sh) agent=true ;;
  esac
  case "${path}" in
    .github/workflows/ci.yml) app=true ;;
    .github/workflows/*.yml) : ;;
    .github/scripts/classify-pr-paths.sh) app=true ;;
    .github/scripts/prepare-ci-apt-sources.mjs) app=true ;;
    .github/scripts/*) : ;;
    scripts/security/check-agent-binary-signatures.sh) app=true ;;
    scripts/security/*) : ;;
    scripts/release/*) : ;;
    .github/release-provenance/*) : ;;
    *) app=true ;;
  esac
done

if [[ "${seen}" != "true" ]]; then
  echo "classify-pr-paths: no changed files listed; treating as a code+docs+agent+app change (fail-closed)" >&2
  code=true
  docs=true
  agent=true
  app=true
fi

echo "code=${code}"
echo "docs=${docs}"
echo "agent=${agent}"
echo "app=${app}"
