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
# DELIBERATELY EXCLUDED: selfhost-signing-template/.github/workflows/ci.yml
# pins go-version 1.24. That file is a template copied into a SELF-HOSTER'S
# own repository, where it only installs actionlint — it never builds the
# Breeze agent, so it is not one of "our" toolchain pins and is out of the
# .github/workflows/*.yml glob on purpose, not by oversight.
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

# --- required declarations -------------------------------------------------
# The loops below only compare values they FIND. A workflow that loses its
# declaration yields zero values, nothing is compared, and the guard would
# still report "all pins agree" — fail-open (#8283). So the files that MUST
# carry a pin are listed explicitly and a file yielding zero values fails.
# Add a workflow here when it starts building/scanning Go.
GO_VERSION_ENV_FILES=(
  .github/workflows/ci.yml
  .github/workflows/security.yml
  .github/workflows/release.yml
  .github/workflows/dev-build-agent.yml
  .github/workflows/yara-pack.yml
)
GO_VERSION_LITERAL_FILES=(
  .github/workflows/codeql.yml
)

env_values()     { sed -nE "s/^[[:space:]]*GO_VERSION:[[:space:]]*['\"]?([^'\"[:space:]]+)['\"]?.*/\1/p" "$1"; }
literal_values() { sed -nE "s/^[[:space:]]*go-version:[[:space:]]*['\"]?([^'\"[:space:]]+)['\"]?.*/\1/p" "$1"; }

for file in "${GO_VERSION_ENV_FILES[@]}"; do
  [ -f "$file" ] || { note "$file is missing — it must declare GO_VERSION=$pinned"; continue; }
  [ -n "$(env_values "$file")" ] \
    || note "$file declares no GO_VERSION — its toolchain is no longer held to agent/go.mod"
done
for file in "${GO_VERSION_LITERAL_FILES[@]}"; do
  [ -f "$file" ] || { note "$file is missing — it must pin go-version: $pinned"; continue; }
  [ -n "$(literal_values "$file" | grep -vF '{{' || true)" ] \
    || note "$file declares no literal go-version — its toolchain is no longer held to agent/go.mod"
done

# A templated go-version must read the pinned env var exactly; a typo such as
# `${{ env.GOVERSION }}` expands to empty and would otherwise be skipped below.
for file in .github/workflows/*.yml; do
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    note "$file go-version templates something other than \${{ env.GO_VERSION }}: $line"
  done < <(grep -E '^[[:space:]]*go-version:[[:space:]]*.*\{\{' "$file" \
    | grep -vE '\{\{[[:space:]]*env\.GO_VERSION[[:space:]]*\}\}' || true)
done

# --- every GO_VERSION env in workflows -------------------------------------
for file in .github/workflows/*.yml; do
  while IFS= read -r v; do
    [ "$v" = "$pinned" ] || note "$file GO_VERSION=$v != $pinned (agent/go.mod)"
  done < <(env_values "$file")
done

# --- literal go-version: pins that bypass GO_VERSION entirely ---------------
# `go-version: ${{ env.GO_VERSION }}` is fine; a bare literal is its own pin.
for file in .github/workflows/*.yml; do
  while IFS= read -r v; do
    [[ "$v" == *'{{'* ]] && continue
    [ "$v" = "$pinned" ] || note "$file hard-codes go-version: $v != $pinned"
  done < <(literal_values "$file")
done

# --- other Go modules (#6263 W03b: the built-in YARA pack filter) ----------
# Each extra go.mod is its own toolchain pin for anyone running `go test` /
# `go build` in that directory (release.yml builds the pack with it).
EXTRA_GO_MODS=(
  scripts/security/yara-pack/go.mod
)
for file in "${EXTRA_GO_MODS[@]}"; do
  [ -f "$file" ] || { note "$file is missing — it must declare go $pinned"; continue; }
  v="$(sed -nE 's/^go ([0-9]+\.[0-9]+\.[0-9]+)$/\1/p' "$file")"
  if [ -z "$v" ]; then
    note "$file has no fully-qualified 'go X.Y.Z' directive (want go $pinned)"
  elif [ "$v" != "$pinned" ]; then
    note "$file go $v != $pinned (agent/go.mod)"
  fi
done

# --- golang build stages in Dockerfiles (#6263 W03a: breeze-yarac) ----------
# The API images build the agent's YARA compiler from agent/ sources; that
# stage must use the same toolchain as the agent and be digest-pinned.
GO_DOCKERFILES=(
  apps/api/Dockerfile
  docker/Dockerfile.api
)
for file in "${GO_DOCKERFILES[@]}"; do
  [ -f "$file" ] || { note "$file is missing — it must build breeze-yarac with golang:$pinned"; continue; }
  froms="$(grep -E '^FROM[[:space:]].*golang:' "$file" || true)"
  [ -n "$froms" ] || note "$file has no golang build stage — expected golang:$pinned-alpine@sha256:… for breeze-yarac"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    v="$(sed -nE 's/.*golang:([0-9]+\.[0-9]+\.[0-9]+)-alpine@sha256:[0-9a-f]{64}.*/\1/p' <<<"$line")"
    if [ -z "$v" ]; then
      note "$file golang stage is not a digest-pinned golang:X.Y.Z-alpine@sha256 image: $line"
    elif [ "$v" != "$pinned" ]; then
      note "$file golang:$v != $pinned (agent/go.mod)"
    fi
  done <<<"$froms"
done

# --- public docs telling self-hosters which toolchain to install ------------
# Presence alone is not enough: a page that says "install Go 1.25.12" while
# mentioning the current pin somewhere else would pass a grep -q and still
# hand self-hosters an unpatched toolchain. Require the pin AND the absence
# of any older 1.25.x reference.
for doc in \
  apps/docs/src/content/docs/agents/building.mdx \
  apps/docs/src/content/docs/getting-started/prerequisites.mdx
do
  grep -qF "$pinned" "$doc" \
    || note "$doc does not mention $pinned — self-hosters would install an unpatched toolchain"
  # Trailing char must be non-DIGIT, not non-[digit-or-dot]: "Go 1.25.12." at
  # the end of a sentence ends in '.', and excluding '.' here made this check
  # silently miss the very case it exists for.
  stale="$(grep -nE '(^|[^0-9.])(go)?1\.25(\.[0-9]+)?([^0-9]|$)' "$doc" || true)"
  [ -z "$stale" ] || note "$doc still references Go 1.25: $(head -1 <<<"$stale")"
done

if [ "$fail" -ne 0 ]; then
  echo "Go toolchain pins disagree. Update every location above together." >&2
  exit 1
fi
echo "check-go-version-pins: all Go toolchain pins agree on $pinned."
