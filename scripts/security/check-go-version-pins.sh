#!/usr/bin/env bash
#
# check-go-version-pins.sh — keep every Go toolchain pin in the repo agreeing.
#
# The Go pin is not stored in one place. It lives in:
#   - GO_VERSION env in .github/workflows/{ci,security,release,dev-build-agent}.yml
#   - a HARD-CODED go-version literal in .github/workflows/codeql.yml
#     (that job sets no GO_VERSION env, so it silently keeps its own pin)
#   - the `go` directive in agent/go.mod
#   - two public docs pages that tell self-hosters what to install
#
# Why this guard exists: the pin was bumped 1.25.12 -> 1.26.6 to clear six
# stdlib advisories (GO-2026-5026/5942/5972/6088/6090/6218). Five of the six
# are also fixed in 1.25.13, but GO-2026-5942 (dnsmessage SVCB/HTTPS RR panic,
# reachable from heartbeat.handleNetworkDnsCheck -> net.Resolver.LookupCNAME)
# has NO fix on the 1.25 branch — stdlib fixed it only in 1.26.6. So a pin
# that drifts backward to any 1.25.x silently reintroduces a remote panic in
# the agent that ships to customer machines, and the Go Vulnerability Check
# job is the only thing that would notice.
#
# A stale pin in ONE of these files is invisible: CI stays green on the files
# that agree, and the disagreeing one either builds a release binary with the
# wrong toolchain (release.yml) or scans a different stdlib than it ships
# (security.yml). Same failure shape as the Node pin, which drifted across
# four locations undetected.
#
# The `go` directive is the load-bearing one for anybody building from source:
# with the default GOTOOLCHAIN=auto it makes Go fetch >= the pinned toolchain
# instead of building a vulnerable binary on whatever is installed.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

fail=0
note() { echo "FAIL $*" >&2; fail=1; }

# --- source of truth: agent/go.mod -----------------------------------------
pinned="$(sed -nE 's/^go ([0-9]+\.[0-9]+\.[0-9]+)$/\1/p' agent/go.mod)"
if [ -z "$pinned" ]; then
  echo "FAIL agent/go.mod has no fully-qualified 'go X.Y.Z' directive." >&2
  echo "     A two-part directive (go 1.26) permits any patch release, which" >&2
  echo "     defeats the point: the advisories above are patch-level fixes." >&2
  exit 1
fi
echo "pinned Go toolchain (agent/go.mod): $pinned"

# --- every GO_VERSION env in workflows -------------------------------------
for file in .github/workflows/*.yml; do
  while IFS= read -r v; do
    [ "$v" = "$pinned" ] || note "$file GO_VERSION=$v != $pinned (agent/go.mod)"
  done < <(sed -nE "s/^[[:space:]]*GO_VERSION:[[:space:]]*['\"]?([^'\"[:space:]]+)['\"]?.*/\1/p" "$file")
done

# --- literal go-version: pins that bypass GO_VERSION entirely ---------------
# `go-version: ${{ env.GO_VERSION }}` is fine; a bare literal is its own pin.
for file in .github/workflows/*.yml; do
  while IFS= read -r v; do
    [[ "$v" == *'{{'* ]] && continue
    [ "$v" = "$pinned" ] || note "$file hard-codes go-version: $v != $pinned"
  done < <(sed -nE "s/^[[:space:]]*go-version:[[:space:]]*['\"]?([^'\"[:space:]]+)['\"]?.*/\1/p" "$file")
done

# --- public docs telling self-hosters which toolchain to install ------------
for doc in \
  apps/docs/src/content/docs/agents/building.mdx \
  apps/docs/src/content/docs/getting-started/prerequisites.mdx
do
  grep -qF "$pinned" "$doc" \
    || note "$doc does not mention $pinned — self-hosters would install an unpatched toolchain"
done

if [ "$fail" -ne 0 ]; then
  echo "Go toolchain pins disagree. Update every location above together." >&2
  exit 1
fi
echo "check-go-version-pins: all Go toolchain pins agree on $pinned."
