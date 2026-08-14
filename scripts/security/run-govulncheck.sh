#!/usr/bin/env bash
# Run govulncheck over the agent Go module with a reviewed allowlist of
# unfixable advisories (govulncheck-allowlist.txt documents the bar an entry
# must clear: no fixed release exists + code-level mitigation + tracking
# issue). Fails on any symbol-level finding not in the allowlist, and warns
# when an allowlist entry has gone stale so it gets removed.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
allowlist_file="$repo_root/scripts/security/govulncheck-allowlist.txt"
out_file="$(mktemp)"
trap 'rm -f "$out_file"' EXIT

cd "$repo_root/agent"
# JSON mode exits 0 even with findings; a non-zero exit here is an
# operational failure (build error, network), which set -e propagates.
CGO_ENABLED=0 govulncheck -format json ./... > "$out_file"

# Symbol-level findings only (a trace entry with a function) — the same set
# plain `govulncheck ./...` fails on ("Your code is affected by ...").
found="$(jq -r 'select(.finding != null) | .finding | select(.trace[0].function != null) | .osv' "$out_file" | sort -u)"
allow="$(grep -vE '^[[:space:]]*(#|$)' "$allowlist_file" | sort -u || true)"

fail=0
while IFS= read -r id; do
  [ -z "$id" ] && continue
  if grep -qxF "$id" <<<"$allow"; then
    echo "ALLOWLISTED $id — reviewed exception, see scripts/security/govulncheck-allowlist.txt"
  else
    echo "FAIL $id — symbol-level vulnerability not in the allowlist" >&2
    # Print the call trace, not just the id. Without this the log proves only
    # THAT something is reachable, so any later claim about WHICH agent path
    # reaches it has to be re-derived by hand — and source reading is a weaker
    # instrument than govulncheck's own symbol analysis, so that re-derivation
    # can fail to confirm a real finding.
    #
    # trace[0] is the VULNERABLE symbol; the LAST element is the frame in our
    # own code that reaches it. Both halves matter: the first says what is
    # broken, the last says which agent path exposes us to it.
    jq -r --arg id "$id" \
      'select(.finding != null) | .finding
       | select(.osv == $id) | select(.trace[0].function != null)
       | (.trace[0] | "\(.package // .module).\(.function)") as $vuln
       | (.trace[-1]) as $ours
       | "     \($vuln)  <-  \($ours.package // $ours.module).\($ours.function)"
         + ($ours.position | if . then " (\(.filename):\(.line))" else "" end)' \
      "$out_file" | sort -u >&2
    fail=1
  fi
done <<<"$found"

# Stale allowlist entries are noise that erodes trust in the list — surface
# them (non-fatal) so they get removed once the underlying advisory is fixed.
while IFS= read -r id; do
  [ -z "$id" ] && continue
  if ! grep -qxF "$id" <<<"$found"; then
    echo "WARN stale allowlist entry $id no longer reported — remove it from govulncheck-allowlist.txt"
  fi
done <<<"$allow"

if [ "$fail" -ne 0 ]; then
  echo "govulncheck found unallowlisted vulnerabilities; run 'govulncheck ./...' in agent/ for detail" >&2
  exit 1
fi
echo "govulncheck: no unallowlisted symbol-level vulnerabilities."
