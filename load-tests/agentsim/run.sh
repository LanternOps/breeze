#!/usr/bin/env bash
# load-tests/agentsim/run.sh — run the agent simulator from the agent module
# (it imports agent/internal/*). Extra flags pass straight through; a flag given
# twice takes the last value, so --store/--report here are overridable.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
mkdir -p "$HERE/.state" "$HERE/reports"
chmod 700 "$HERE/.state"
# `lab-setup.sh > .state/lab.env` (0600) is an alternative to eval-ing its output.
if [ -f "$HERE/.state/lab.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$HERE/.state/lab.env"
  set +a
fi
STORE="${AGENTSIM_STORE:-$HERE/.state/tokens.json}"
REPORT="$HERE/reports/$(date -u +%Y%m%dT%H%M%SZ).json"
cd "$REPO/agent"
exec go run ./tools/agentsim --store "$STORE" --report "$REPORT" "$@"
