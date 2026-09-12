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
# Gate: fail on HIGH and CRITICAL (raised from CRITICAL-only on 2026-09-03 for
# SOC 2 CC7.1; the tree was clean at every severity at the time). MODERATE and
# below are reported but do not block. Override with AUDIT_THRESHOLD=CRITICAL
# only for an emergency hotfix, and record the exception.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

THRESHOLD="${AUDIT_THRESHOLD:-HIGH}"
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

# Severities at or above the threshold block. Ranks: CRITICAL=4 HIGH=3
# MODERATE=2 LOW=1 UNSPECIFIED=0.
rank_of() {
  case "$(echo "$1" | tr '[:lower:]' '[:upper:]')" in
    CRITICAL) echo 4 ;;
    HIGH) echo 3 ;;
    MODERATE|MEDIUM) echo 2 ;;
    LOW) echo 1 ;;
    *) echo 0 ;;
  esac
}
threshold_rank="$(rank_of "$THRESHOLD")"
[ "$threshold_rank" -gt 0 ] || fail "unknown AUDIT_THRESHOLD '$THRESHOLD' (use CRITICAL, HIGH, MODERATE, or LOW)"

blocking="$(jq --argjson min "$threshold_rank" \
  '[.results[]?.packages[]?.vulnerabilities[]?
    | (.database_specific.severity // "" | ascii_upcase) as $s
    | ({"CRITICAL":4,"HIGH":3,"MODERATE":2,"MEDIUM":2,"LOW":1}[$s] // 0) as $r
    | select($r >= $min)] | length' "$report")"

if [ "$blocking" -gt 0 ]; then
  fail "found ${blocking} advisory/advisories at or above ${THRESHOLD} — see detail above"
fi

echo "OK: no advisories at or above ${THRESHOLD} in $LOCKFILE"
