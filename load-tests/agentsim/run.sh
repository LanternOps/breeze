#!/usr/bin/env bash
# load-tests/agentsim/run.sh — run the agent simulator from the agent module
# (it imports agent/internal/*). Extra flags pass straight through; a flag given
# twice takes the last value, so --store/--report here are overridable.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
mkdir -p "$HERE/.state" "$HERE/reports"
chmod 700 "$HERE/.state"
STORE="${AGENTSIM_STORE:-$HERE/.state/tokens.json}"
REPORT="$HERE/reports/$(date -u +%Y%m%dT%H%M%SZ).json"
cd "$REPO/agent"
exec go run ./tools/agentsim --store "$STORE" --report "$REPORT" "$@"
