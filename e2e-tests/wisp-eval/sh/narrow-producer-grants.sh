#!/usr/bin/env bash
# Simulates a grantor who lost permissions between two analysis steps: removes the frozen
# exportGrants from the newest root (chain depth 0) analysis run. A continuation can then no
# longer prove the producer's grants are covered, so it drops the carried files and withholds
# the seed (reason grants_not_covered; the check fails closed on unreadable grants). Local
# throwaway stack only (common.sh refuses anything else).
set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
id="$(q "select id from ai_agent_runs where profile = 'analysis' and chain_depth = 0 order by queued_at desc limit 1")"
[ -n "$id" ] || { echo "no analysis run to narrow" >&2; exit 1; }
qsys "update ai_agent_runs set staged_inputs = staged_inputs - 'exportGrants' where id = '$id'" >/dev/null
[ "$(q "select (staged_inputs ? 'exportGrants')::text from ai_agent_runs where id = '$id'")" = "false" ] || { echo "exportGrants still present on $id" >&2; exit 1; }
say "narrow-producer-grants: removed exportGrants from $id"
