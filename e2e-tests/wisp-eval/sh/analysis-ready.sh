#!/usr/bin/env bash
# Precondition for the analysis scenarios: sandboxed analysis is runnable on this stack.
# Prints one line per failed check to stderr and exits 1 if any fails (run.cjs treats a
# non-zero exit as a harness error, never as "still red"). Fix with `setup.sh analysis`,
# or make-env.sh plus a stack restart for the two env checks.
set -uo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

bad=0
fail() { printf 'analysis-ready: %s\n' "$*" >&2; bad=1; }

[ "$(docker exec "$APIC" printenv BREEZE_AI_WORKSPACE_ENABLED 2>/dev/null)" = "true" ] || fail "BREEZE_AI_WORKSPACE_ENABLED is not true in $APIC"
[ "$(docker exec "$APIC" printenv AI_WORKSPACE_BACKEND 2>/dev/null)" = "fake" ] || fail "AI_WORKSPACE_BACKEND is not fake in $APIC"
docker exec "$APIC" python3 --version >/dev/null 2>&1 || fail "python3 is missing in $APIC (setup.sh analysis installs it)"

# Each query's own failure is reported as such: an empty answer must never read as a pass.
nw="$(org_id 'Northwind Dental')" || nw=""
if [ -z "$nw" ]; then
  fail "Northwind Dental not found (or the database query failed); run setup.sh world"
else
  ext="$(q "select ai_external_processing from organizations where id = '$nw'")" || ext="query-failed"
  [ "$ext" = "t" ] || fail "Northwind Dental does not allow external AI processing (got: ${ext:-nothing})"
fi

partner="$(partner_id)" || partner=""
if [ -z "$partner" ]; then
  fail "partner not found (or the database query failed)"
else
  for tool in workspace_stage workspace_run workspace_collect workspace_cancel export_dataset; do
    n="$(q "select count(*) from ai_agents where partner_id = '$partner' and org_id is null and kind = 'triage' and tool_allowlist ? '$tool'")" || n=""
    [[ "$n" =~ ^[1-9][0-9]*$ ]] || fail "the Triage agent's allowlist lacks $tool (count: ${n:-query failed})"
  done
fi
exit "$bad"
