#!/usr/bin/env bash
# Return the mutable parts of the test world to baseline between scenarios.
#
#   - retract every Wisp memory block (remembered facts, standing instructions)
#   - cancel scheduled / running / fired check-ins (API, so their queued jobs go too)
#   - delete active watches; cancel in-flight specialist runs (a pending one blocks a new launch)
#   - clear the thread summary a closed session leaves behind (it is handed to the next session)
#   - planted alerts back to their baseline status
#   - world tickets back to "new" when a scenario changed them; tickets a scenario planted are removed
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

# Watches keep running (and spending) on their cadence; a scenario may create one instead of a check-in.
n=0
while IFS=' ' read -r grant id; do
  [ -n "$id" ] || continue
  api DELETE "/wisp/watches/$id?grantId=$grant" >/dev/null 2>&1 \
    || q "update wisp_watches set status = 'stopped', stopped_reason = 'wisp-eval reset', updated_at = now() where id = '$id'" >/dev/null
  n=$((n + 1))
done <<< "$(q "select grant_id || ' ' || id from wisp_watches where status = 'active'")"
say "reset: stopped $n watches"

# A specialist from an earlier scenario still waiting for approval makes Wisp decline to launch
# another for the same device ("one is already awaiting approval"). Cancel in-flight specialist
# runs; leave assessments alone.
n="$(qsys "with u as (update ai_agent_runs set status = 'cancelled', error_code = 'wisp_eval_reset', finished_at = now()
            where status in ('queued','running','awaiting_approval') and profile <> 'assessment' returning 1)
            select count(*) from u")"
say "reset: cancelled $n in-flight specialist runs"

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

n="$(qsys "with u as (update tickets set deleted_at = now(), updated_at = now()
            where custom_fields->>'wispEval' = 'scenario' and deleted_at is null returning 1)
            select count(*) from u")"
say "reset: removed $n scenario tickets"

for g in nw nwsrv hl; do bash "$HERE/sim.sh" restart "$g" >/dev/null; done
bash "$HERE/sim.sh" stop hlmac >/dev/null
for _ in $(seq 1 60); do
  [ "$(q "select status from devices where display_name = 'HL-PARTNER-MBP'")" = "offline" ] && break
  sleep 2
done

n=0
last=""
for sid in $(q "select s.id from ai_sessions s where s.status = 'active' and s.wisp_grant_id is not null"); do
  api DELETE "/ai/sessions/$sid" >/dev/null 2>&1 || q "update ai_sessions set status = 'closed', updated_at = now() where id = '$sid'" >/dev/null
  n=$((n + 1))
  last="$sid"
done
say "reset: closed $n Wisp chat sessions"

# Closing a session writes its summary onto the thread in the background (a model step), and the
# next session of the thread is handed that summary. Wait for it, then clear it: otherwise the
# previous scenario's conversation leaks into the next one (seen: the attention answer citing a
# ticket that only the injection scenario had discussed).
if [ -n "$last" ]; then
  for _ in $(seq 1 15); do
    [ "$(q "select count(*) from wisp_threads where summary_session_id = '$last'")" != "0" ] && break
    sleep 2
  done
fi
qsys "update wisp_threads set summary = '', summary_session_id = null, summary_updated_at = null where summary <> ''" >/dev/null
say "reset: cleared the thread summary"
