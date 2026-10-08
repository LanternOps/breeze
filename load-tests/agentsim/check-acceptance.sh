#!/usr/bin/env bash
# load-tests/agentsim/check-acceptance.sh — W0a acceptance checks.
#   check-acceptance.sh live <expectedAgents>           run DURING the steady window
#   check-acceptance.sh report <report.json> [expRpm]   run after the simulator exits
# live: distinct device rows for this store's hostnames, and live presence leases
#       (agent-presence:<agentId>, 90 s TTL, cleared on socket close — so only
#       while the simulator is running).
# report: the ±10 % mix against the code-derived model (and against expRpm,
#         the production figure, when given), zero non-2xx outside crawl-config,
#         zero transport errors, one WS connect per agent, and ≥ 99 % of
#         dispatched commands answered.
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"
DESC="$REPO/.breeze-stack.json"
if [ -f "$REPO/load-tests/agentsim/.state/lab.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$REPO/load-tests/agentsim/.state/lab.env"
  set +a
fi
STORE="${AGENTSIM_STORE:-$REPO/load-tests/agentsim/.state/tokens.json}"
fail=0
check() { if [ "$1" = ok ]; then echo "PASS  $2"; else echo "FAIL  $2"; fail=1; fi; }
stackval() { grep -h "^$1=" "$REPO/.env" "$REPO/.env.stack" 2>/dev/null | tail -n1 | cut -d= -f2-; }

case "${1:-}" in
live)
  WANT="${2:?usage: check-acceptance.sh live <expectedAgents>}"
  PG="$(jq -r .pgContainer "$DESC")"; REDIS="$(jq -r .redisContainer "$DESC")"
  BASE="$(jq -r .hostnameBase "$STORE")"
  DEVICES="$(docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -v base="$0"' "$BASE" <<'SQL'
SELECT count(DISTINCT id) FROM devices WHERE hostname LIKE :'base' || '-%' AND status <> 'decommissioned';
SQL
)"
  LEASES="$(docker exec "$REDIS" redis-cli -a "$(stackval REDIS_PASSWORD)" --no-auth-warning \
    --scan --pattern 'agent-presence:*' | wc -l | tr -d ' ')"
  [ "$DEVICES" -ge "$WANT" ] && r=ok || r=bad; check "$r" "distinct device rows for $BASE-*: $DEVICES (want >= $WANT)"
  [ "$LEASES" -ge "$WANT" ] && r=ok || r=bad; check "$r" "live presence leases: $LEASES (want >= $WANT)"
  ;;
report)
  R="${2:?usage: check-acceptance.sh report <report.json> [expectedRpm]}"; PROD="${3:-}"
  jq -e '.schema == "breeze.agentsim.report/v1"' "$R" >/dev/null && r=ok || r=bad; check "$r" "schema"
  N="$(jq .config.agents "$R")"
  dev="$(jq '.totals.deviationPct | fabs' "$R")"
  jq -e '(.totals.deviationPct | fabs) <= 10' "$R" >/dev/null && r=ok || r=bad
  check "$r" "mix vs model: $(jq .totals.requestsPerAgentMinute "$R") vs $(jq .totals.expectedRequestsPerAgentMinute "$R") req/agent-min ($dev %)"
  if [ -n "$PROD" ]; then
    jq -e --argjson p "$PROD" '((.totals.requestsPerAgentMinute - $p) / $p | fabs) <= 0.10' "$R" >/dev/null && r=ok || r=bad
    check "$r" "mix vs production $PROD req/agent-min"
  fi
  BAD="$(jq '[.routes[] | select(.route != "GET /workspace/agent/crawl-config" and .route != "GET /agent-ws/:id/ws")
              | (.status // {}) | to_entries[] | select(.key | test("^2") | not) | .value] | add // 0' "$R")"
  [ "$BAD" -eq 0 ] && r=ok || r=bad; check "$r" "non-2xx outside crawl-config: $BAD"
  TE="$(jq .totals.transportErrors "$R")"; [ "$TE" -eq 0 ] && r=ok || r=bad; check "$r" "transport errors: $TE"
  jq -e --argjson n "$N" '.agents.started == $n and .ws.connects >= $n' "$R" >/dev/null && r=ok || r=bad
  check "$r" "agents started $(jq .agents.started "$R")/$N, ws connects $(jq .ws.connects "$R")"
  jq -e '.commands.dispatched == 0 or (([.commands.resultsSent[]] | add // 0) >= .commands.dispatched * 0.99)' "$R" >/dev/null && r=ok || r=bad
  check "$r" "command results $(jq '[.commands.resultsSent[]] | add // 0' "$R") for $(jq .commands.dispatched "$R") dispatched"
  ;;
*) echo "usage: check-acceptance.sh live <n> | report <report.json> [expectedRpm]" >&2; exit 2 ;;
esac
exit "$fail"
