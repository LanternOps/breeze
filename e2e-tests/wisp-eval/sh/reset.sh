#!/usr/bin/env bash
# Return the mutable parts of the test world to baseline between scenarios.
#
#   - retract every Wisp memory block (remembered facts, standing instructions)
#   - cancel scheduled / running / fired check-ins (API, so their queued jobs go too)
#   - planted alerts back to their baseline status
#   - world tickets back to "new" when a scenario changed them
#   - sim groups: nw, nwsrv, hl running; hlmac stopped and HL-PARTNER-MBP offline
#   - close the Wisp thread's open chat sessions, so the next page load binds a fresh one
#
# It does not delete messages, posts, concerns or runs: the thread keeps its history,
# only the live session (what the model remembers) starts over.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$HERE/common.sh"

n=0
for id in $(q "select id from ai_memory_blocks where status <> 'retracted'"); do
  api POST "/wisp/memory/$id/retract" >/dev/null 2>&1 || q "update ai_memory_blocks set status = 'retracted', updated_at = now() where id = '$id'" >/dev/null
  n=$((n + 1))
done
say "reset: retracted $n memory blocks"

n=0
while IFS=' ' read -r thread id; do
  [ -n "$id" ] || continue
  api DELETE "/wisp/thread/$thread/check-ins/$id" >/dev/null 2>&1 \
    || q "update wisp_check_ins set status = 'cancelled', cancelled_at = now(), cancel_reason = 'wisp-eval reset' where id = '$id'" >/dev/null
  n=$((n + 1))
done <<< "$(q "select thread_id || ' ' || id from wisp_check_ins where status in ('scheduled','running','fired')")"
say "reset: cancelled $n check-ins"

n="$(qsys "with u as (update alerts set status = (context->>'baselineStatus')::alert_status,
              acknowledged_at = null, acknowledged_by = null, suppressed_until = null, dismissed_at = null, dismissed_by = null,
              resolved_at = case when context->>'baselineStatus' = 'resolved' then coalesce(resolved_at, now()) else null end,
              resolved_by = null, resolution_reason = null
            where context->>'source' = 'wisp-eval' and status::text <> context->>'baselineStatus' returning 1)
            select count(*) from u")"
say "reset: restored $n planted alerts"

n="$(qsys "with u as (update tickets set status = 'new', resolved_at = null, closed_at = null, updated_at = now()
            where custom_fields->>'wispEval' = 'world' and status <> 'new' and deleted_at is null returning 1)
            select count(*) from u")"
say "reset: reopened $n world tickets"

for g in nw nwsrv hl; do bash "$HERE/sim.sh" restart "$g" >/dev/null; done
bash "$HERE/sim.sh" stop hlmac >/dev/null
for _ in $(seq 1 60); do
  [ "$(q "select status from devices where display_name = 'HL-PARTNER-MBP'")" = "offline" ] && break
  sleep 2
done

n=0
for sid in $(q "select s.id from ai_sessions s where s.status = 'active' and s.wisp_grant_id is not null"); do
  api DELETE "/ai/sessions/$sid" >/dev/null 2>&1 || q "update ai_sessions set status = 'closed', updated_at = now() where id = '$sid'" >/dev/null
  n=$((n + 1))
done
say "reset: closed $n Wisp chat sessions"
