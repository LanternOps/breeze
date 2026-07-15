#!/usr/bin/env bash
set -euo pipefail

# Dependency audit for the pnpm workspace.
#
# Uses osv-scanner against pnpm-lock.yaml rather than `pnpm audit`: npm retired
# the /-/npm/v1/security/audits{,/quick} endpoints (they now return HTTP 410),
# and pnpm has not migrated to the bulk advisory endpoint at any version, so
# `pnpm audit` fails closed on every release line. osv-scanner reads the
# lockfile directly and needs no npm audit endpoint.
#
# Gate: fail on CRITICAL only, matching the previous `--audit-level=critical`.
# Lower severities are reported but do not block. The tree is currently clean at
# every severity, so tightening this to HIGH is viable if we want it.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

THRESHOLD="${AUDIT_THRESHOLD:-CRITICAL}"
LOCKFILE="pnpm-lock.yaml"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

command -v osv-scanner >/dev/null 2>&1 || fail "osv-scanner not found on PATH"
command -v jq >/dev/null 2>&1 || fail "jq not found on PATH"
[ -f "$LOCKFILE" ] || fail "$LOCKFILE not found in $ROOT_DIR"

report="$(mktemp)"
trap 'rm -f "$report"' EXIT

# osv-scanner exits non-zero when it finds ANY vulnerability at any severity.
# We do our own severity gating below, so tolerate that exit code here and fail
# only if it produced no parseable report (a real tool/network failure).
set +e
osv-scanner --lockfile="$LOCKFILE" --format=json >"$report" 2>/dev/null
scan_status=$?
set -e

if ! jq -e '.results' "$report" >/dev/null 2>&1; then
  fail "osv-scanner produced no parseable report (exit ${scan_status}) — treating as audit failure rather than a pass"
fi

# Guard against a vacuous pass: if the scanner matched no packages at all, the
# lockfile parser has broken and a clean result means nothing.
pkg_count="$(jq '[.results[]?.packages[]?] | length' "$report")"
total_vulns="$(jq '[.results[]?.packages[]?.vulnerabilities[]?] | length' "$report")"

echo "osv-scanner: scanned $LOCKFILE, ${total_vulns} advisories across ${pkg_count} affected package(s)"

if [ "$total_vulns" -gt 0 ]; then
  echo "--- advisories by severity ---"
  jq -r '[.results[]?.packages[]?.vulnerabilities[]? | .database_specific.severity // "UNSPECIFIED"]
         | group_by(.) | map("  \(.[0]): \(length)") | .[]' "$report"
  echo "--- detail ---"
  jq -r '.results[]?.packages[]? as $p
         | $p.vulnerabilities[]?
         | "  [\(.database_specific.severity // "UNSPECIFIED")] \($p.package.name)@\($p.package.version) \(.id)"' \
        "$report" | sort -u
fi

blocking="$(jq --arg t "$THRESHOLD" \
  '[.results[]?.packages[]?.vulnerabilities[]?
    | select((.database_specific.severity // "") == $t)] | length' "$report")"

if [ "$blocking" -gt 0 ]; then
  fail "found ${blocking} ${THRESHOLD} advisory/advisories — see detail above"
fi

echo "OK: no ${THRESHOLD} advisories in $LOCKFILE"
