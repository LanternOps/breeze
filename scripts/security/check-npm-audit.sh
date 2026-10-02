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
# below are reported but do not block.
#
# Severity is fail-closed. An advisory's rank comes from
# database_specific.severity, else from the numeric CVSS score osv-scanner
# reports in groups[].max_severity (>=9 CRITICAL, >=7 HIGH, >=4 MODERATE,
# else LOW). A record with neither (UNSPECIFIED) blocks at every threshold, and
# so does any MAL-* (malicious package) id: an unrankable advisory is never a
# pass. If one cannot be fixed it goes through the exceptions file below.
#
# Scan integrity: the scan runs with --all-packages and the number of packages
# osv-scanner covered must be at least the number of package entries in
# pnpm-lock.yaml (counted independently of the scanner), and the scanner's own
# exit status must be 0 (clean) or 1 (findings). Anything else fails the run.
#
# Exceptions: an advisory that cannot be fixed by upgrading is suppressed ONLY
# through a reviewed entry in scripts/security/npm-audit-exceptions.json. Its
# header states the bar (no fixed release exists, the package is unreachable
# from every production artifact, a tracking issue exists). The rules this
# script enforces on that file:
#   - an entry suppresses one exact advisory id on one exact package name;
#     the same id on another package, or another id on the same package,
#     still blocks;
#   - every entry is printed on every run, with its status;
#   - an entry is honoured through its `expires` date (UTC, inclusive); from
#     the next day it fails the run, even when the advisory no longer appears
#     in the scan;
#   - an entry may not expire more than MAX_EXCEPTION_DAYS days out, so each
#     one is re-reviewed at least that often;
#   - a missing or malformed file fails the run (it never means "no rules").
# Do not lower AUDIT_THRESHOLD to get past a single advisory; add a reviewed
# entry instead. AUDIT_THRESHOLD=CRITICAL remains for a declared emergency only.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

THRESHOLD="${AUDIT_THRESHOLD:-HIGH}"
LOCKFILE="pnpm-lock.yaml"
EXCEPTIONS_FILE="scripts/security/npm-audit-exceptions.json"
MAX_EXCEPTION_DAYS=30

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

command -v osv-scanner >/dev/null 2>&1 || fail "osv-scanner not found on PATH"
command -v jq >/dev/null 2>&1 || fail "jq not found on PATH"
[ -f "$LOCKFILE" ] || fail "$LOCKFILE not found in $ROOT_DIR"

# --- reviewed exceptions -----------------------------------------------------

[ -f "$EXCEPTIONS_FILE" ] || fail "$EXCEPTIONS_FILE not found — the audit reads its reviewed exceptions from it (an empty \"exceptions\": [] is valid)"
jq -e 'type == "object"' "$EXCEPTIONS_FILE" >/dev/null 2>&1 || fail "$EXCEPTIONS_FILE is not a valid JSON object"

today="$(jq -nr 'now | strftime("%Y-%m-%d")')"
latest_allowed="$(jq -nr --argjson d "$MAX_EXCEPTION_DAYS" '(now + $d * 86400) | strftime("%Y-%m-%d")')"

# Structural validation. Every problem is reported, then the run fails closed.
problems="$(jq -r '
  def nonblank: type == "string" and test("\\S");
  def token: type == "string" and test("^\\S+$");
  def isdate:
    type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
    and ((try (strptime("%Y-%m-%d") | mktime | strftime("%Y-%m-%d")) catch "") == .);
  if (.exceptions | type) != "array" then "\"exceptions\" must be an array"
  else
    (.exceptions | to_entries[] | .key as $i | .value as $e
      | if ($e | type) != "object" then "entry \($i): must be an object"
        else
          (if ($e.id | token) then empty else "entry \($i): \"id\" must be a non-empty advisory id with no whitespace" end),
          (if ($e.package | token) then empty else "entry \($i): \"package\" must be a non-empty package name with no whitespace" end),
          (if ($e.reason | nonblank) then
             (if ($e.reason | test("#[0-9]+")) then empty else "entry \($i): \"reason\" must cite the tracking issue as #<number>" end)
           else "entry \($i): \"reason\" must be a non-empty string" end),
          (if ($e.expires | isdate) then empty else "entry \($i): \"expires\" must be a real YYYY-MM-DD date" end)
        end),
    (.exceptions | map(select(type == "object")) | group_by([.id, .package])[]
      | select(length > 1) | "duplicate entry for \(.[0].id) on \(.[0].package)")
  end
' "$EXCEPTIONS_FILE")"

if [ -n "$problems" ]; then
  while IFS= read -r line; do echo "  $line" >&2; done <<<"$problems"
  fail "$EXCEPTIONS_FILE is malformed — see above"
fi

# Classify every entry. Only ACTIVE entries suppress findings.
exceptions_status="$(jq -c --arg today "$today" --arg max "$latest_allowed" '
  [.exceptions[] | . + {status: (
      if .expires < $today then "EXPIRED"
      elif .expires > $max then "TOO_FAR"
      else "ACTIVE" end)}]
' "$EXCEPTIONS_FILE")"
active_json="$(jq -c '[.[] | select(.status == "ACTIVE") | {id, package}]' <<<"$exceptions_status")"

echo "--- reviewed exceptions ($EXCEPTIONS_FILE, today $today UTC) ---"
if [ "$(jq 'length' <<<"$exceptions_status")" -eq 0 ]; then
  echo "  (none)"
else
  jq -r --arg file "$EXCEPTIONS_FILE" --arg max "$latest_allowed" --argjson days "$MAX_EXCEPTION_DAYS" '.[]
    | if .status == "ACTIVE" then "  ACTIVE \(.id) on \(.package), expires \(.expires): \(.reason)"
      elif .status == "EXPIRED" then "  EXPIRED \(.id) on \(.package) on \(.expires) — fix the advisory or re-review and renew the entry in \($file)"
      else "  REFUSED \(.id) on \(.package): expires \(.expires), more than \($days) days out (latest allowed \($max))" end' \
    <<<"$exceptions_status"
fi
exceptions_failed="$(jq '[.[] | select(.status != "ACTIVE")] | length' <<<"$exceptions_status")"

# --- scan ----------------------------------------------------------------------

report="$(mktemp)"

# osv-scanner exits 0 when clean and 1 when it found ANY vulnerability at any
# severity. We do our own severity gating below, so exit 1 is tolerated; any
# other status (127 not found, 128 no packages, >1 tool/network failure) is a
# failed scan even if it happened to print a parseable report. --all-packages
# makes the report list every scanned package, not only the affected ones, so
# coverage can be checked below. stderr is kept so a failure says why.
errlog="$(mktemp)"
trap 'rm -f "$report" "$errlog"' EXIT

set +e
osv-scanner --lockfile="$LOCKFILE" --all-packages --format=json >"$report" 2>"$errlog"
scan_status=$?
set -e

scan_failed() {
  echo "ERROR: $*" >&2
  echo "--- osv-scanner stderr (last 20 lines) ---" >&2
  tail -n 20 "$errlog" >&2
  exit 1
}

[ "$scan_status" -le 1 ] || scan_failed "osv-scanner exited ${scan_status} (expected 0 or 1) — treating as audit failure rather than a pass"
jq -e '.results | type == "array"' "$report" >/dev/null 2>&1 || scan_failed "osv-scanner produced no parseable report (exit ${scan_status}) — treating as audit failure rather than a pass"

# Guard against a vacuous pass. The lockfile's package count is taken straight
# from pnpm-lock.yaml (keys of the top-level `packages:` map, one per
# name@version); the scanner must have covered at least that many. A broken
# lockfile parse that reads zero or too few packages looks identical to a clean
# tree otherwise.
lock_count="$(awk '/^packages:/{f=1;next} /^[^ #]/{f=0} f && /^  [^ ].*:$/{n++} END{print n+0}' "$LOCKFILE")"
[ "$lock_count" -gt 0 ] || fail "found no package entries in $LOCKFILE — cannot verify the scan covered it"
scanned_count="$(jq '[.results[]?.packages[]?] | length' "$report")"
[ "$scanned_count" -ge "$lock_count" ] || fail "osv-scanner covered only ${scanned_count} package(s) but $LOCKFILE lists ${lock_count} — the lockfile parse is incomplete, so a clean result means nothing"

pkg_count="$(jq '[.results[]?.packages[]? | select((.vulnerabilities // []) | length > 0)] | length' "$report")"
total_vulns="$(jq '[.results[]?.packages[]?.vulnerabilities[]?] | length' "$report")"

# Exit 1 means the scanner found something; a report that shows none means the
# report shape changed under us (the selectors above tolerate missing keys).
if [ "$scan_status" -eq 1 ] && [ "$total_vulns" -eq 0 ]; then
  fail "osv-scanner exited 1 (findings) but the report lists no vulnerabilities — report shape unrecognised, treating as audit failure"
fi

echo "osv-scanner: scanned ${scanned_count} package(s) from $LOCKFILE (lockfile lists ${lock_count}): ${total_vulns} advisories across ${pkg_count} affected package(s)"

# Every finding as {package, version, id, severity, excepted}. `excepted` is an
# exact match of BOTH the advisory id and the package name against an ACTIVE
# entry — never a prefix, alias, or package-only match.
findings="$(jq -c --argjson active "$active_json" '
  [.results[]?.packages[]? as $p
   | $p.vulnerabilities[]?
   | {package: $p.package.name, version: $p.package.version, id: .id,
      severity: (
        def known: ["CRITICAL","HIGH","MODERATE","LOW"];
        def band: (tonumber? // 0) | if . >= 9 then "CRITICAL" elif . >= 7 then "HIGH" elif . >= 4 then "MODERATE" elif . > 0 then "LOW" else "UNSPECIFIED" end;
        . as $v
        | if ($v.id | startswith("MAL-")) then "MALICIOUS"
          else (($v.database_specific.severity // "" | tostring | ascii_upcase | if . == "MEDIUM" then "MODERATE" else . end) as $s
            | if (known | index($s)) then $s
              else ([$p.groups[]? | select(.ids | index($v.id)) | .max_severity | band] | first // "UNSPECIFIED") end)
          end)}
   | . as $f
   | . + {excepted: any($active[]; .id == $f.id and .package == $f.package)}]
' "$report")"

if [ "$total_vulns" -gt 0 ]; then
  echo "--- advisories by severity ---"
  jq -r 'map(.severity) | group_by(.) | map("  \(.[0]): \(length)") | .[]' <<<"$findings"
  echo "--- detail ---"
  jq -r '.[] | "  [\(.severity)] \(.package)@\(.version) \(.id)\(if .excepted then " (excepted)" else "" end)"' \
    <<<"$findings" | sort -u
fi

# An active entry that matched nothing is noise that erodes trust in the list —
# surface it (non-fatal) so it gets removed once the advisory is fixed.
# (Findings go on stdin, not --argjson: a large report would overflow the
# per-argument size limit.)
jq -r --argjson active "$active_json" --arg file "$EXCEPTIONS_FILE" '
  . as $findings
  | $active[] | . as $e
  | select(any($findings[]; .id == $e.id and .package == $e.package) | not)
  | "WARN exception \(.id) on \(.package) matched no advisory in this scan — remove it from \($file) once its tracking issue confirms the fix"
' <<<"$findings"

# Severities at or above the threshold block. Ranks: CRITICAL=4 HIGH=3
# MODERATE=2 LOW=1. MALICIOUS and UNSPECIFIED (see header) block regardless of
# the threshold.
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

read -r blocking suppressed < <(jq -r --argjson min "$threshold_rank" '
  [.[]
   | ({"CRITICAL":4,"HIGH":3,"MODERATE":2,"LOW":1}[.severity] // 0) as $r
   | select($r >= $min or .severity == "UNSPECIFIED" or .severity == "MALICIOUS")]
  | "\(map(select(.excepted | not)) | length) \(map(select(.excepted)) | length)"
' <<<"$findings") || true
[ -n "$blocking" ] && [ -n "$suppressed" ] || fail "could not compute the blocking advisory count — treating as audit failure"

if [ "$exceptions_failed" -gt 0 ] && [ "$blocking" -gt 0 ]; then
  fail "${exceptions_failed} exception(s) in $EXCEPTIONS_FILE expired or out of policy, and found ${blocking} unexcepted advisory/advisories at or above ${THRESHOLD} — see above"
fi
if [ "$exceptions_failed" -gt 0 ]; then
  fail "${exceptions_failed} exception(s) in $EXCEPTIONS_FILE expired or out of policy — see above"
fi
if [ "$blocking" -gt 0 ]; then
  fail "found ${blocking} advisory/advisories at or above ${THRESHOLD} — see detail above"
fi

if [ "$suppressed" -gt 0 ]; then
  echo "OK: no unexcepted advisories at or above ${THRESHOLD} in $LOCKFILE (${suppressed} suppressed by reviewed exceptions listed above)"
else
  echo "OK: no advisories at or above ${THRESHOLD} in $LOCKFILE"
fi
