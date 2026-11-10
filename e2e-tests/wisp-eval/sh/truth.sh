#!/usr/bin/env bash
# Ground truth from the database: what Wisp really did, not what it said.
#
# truth.sh tools [minutes]   tool calls of the last N minutes (default 5); W=/O= widen input/output columns
# truth.sh state             runs, concerns, check-ins, posts, memory, spend
# truth.sh spend             today's spend and model turns (user messages + agent runs)
# truth.sh world             the planted alerts, tickets and devices
# truth.sh sql '<query>'     any read query against the stack database
set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

case "${1:-state}" in
  tools)
    mins="${2:-5}"; case "$mins" in *[!0-9]*) echo "minutes must be a number" >&2; exit 2 ;; esac
    q "select to_char(created_at,'HH24:MI:SS'), tool_name, status, coalesce(duration_ms::text,'-'),
              left(regexp_replace(tool_input::text,'\s+',' ','g'), ${W:-150}),
              left(regexp_replace(coalesce(error_message, tool_output::text, ''),'\s+',' ','g'), ${O:-110})
         from ai_tool_executions where created_at > now() - interval '$mins minutes' order by created_at" ;;
  state)
    echo "-- runs"
    q "select to_char(r.queued_at,'HH24:MI'), a.kind, o.name, r.trigger_kind, r.profile, r.status, r.turn_count, r.cost_cents, coalesce(r.error_code,''), left(coalesce(r.summary,''),160)
         from ai_agent_runs r left join ai_agents a on a.id = r.agent_id left join organizations o on o.id = r.org_id order by r.queued_at"
    echo "-- concerns"
    q "select o.name, c.severity, c.status, c.subject_kind, left(c.summary,170) from wisp_concerns c left join organizations o on o.id = c.org_id order by c.created_at"
    echo "-- check-ins"
    q "select to_char(due_at,'MM-DD HH24:MI'), status, mode, trigger_kind, coalesce(fire_reason,''), left(instruction,110) from wisp_check_ins order by created_at"
    echo "-- posts"
    q "select to_char(created_at,'HH24:MI'), kind, left(coalesce(title,''),70), left(regexp_replace(coalesce(body,''),'\s+',' ','g'),150) from wisp_thread_posts order by created_at"
    echo "-- spend"
    "$0" spend ;;
  spend)
    q "select 'cost_usd_today', coalesce(round(sum(total_cost_cents)/100.0, 3), 0) from ai_cost_usage where period = 'daily' and period_key = to_char(now() at time zone 'utc','YYYY-MM-DD')"
    q "select 'user_turns_total', count(*) from ai_messages where role = 'user'"
    q "select 'agent_runs_total', count(*) from ai_agent_runs"
    q "select 'agent_run_cost_usd', coalesce(round(sum(cost_cents)/100.0, 3), 0) from ai_agent_runs" ;;
  world)
    echo "-- devices"
    q "select o.name, d.display_name, d.hostname, d.os_type, d.status, to_char(d.last_seen_at,'HH24:MI:SS') from devices d join organizations o on o.id = d.org_id order by o.name, d.display_name"
    echo "-- alerts"
    q "select o.name, coalesce(d.display_name, d.hostname, '-'), a.severity, a.status, a.title from alerts a join organizations o on o.id = a.org_id left join devices d on d.id = a.device_id order by a.created_at"
    echo "-- tickets"
    q "select o.name, t.internal_number, t.ticket_number, t.priority, t.status, t.subject from tickets t join organizations o on o.id = t.org_id where t.deleted_at is null order by t.created_at" ;;
  sql) q "$2" ;;
  *) echo "usage: truth.sh tools [min] | state | spend | world | sql '<query>'" >&2; exit 2 ;;
esac
