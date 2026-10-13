#!/usr/bin/env bash
# load-tests/perf/sample.sh — KPI sampler for one perf run (scaling W07, #8146).
#   sample.sh <out.csv>
# Every ${INTERVAL:-10} s until killed (or ${MAX_SAMPLES} rows when set) appends:
#   ts,cpu_seconds,xact_commit,ws_connections,elu,lag_max,pool_waiting,scrape_ok
# Reads /metrics/scrape INSIDE the stack's api container (needs METRICS_SCRAPE_TOKEN
# set for the stack) and xact_commit from the stack's Postgres, the same way
# agentsim/admission-watch.sh does. A failed scrape or query writes scrape_ok=0
# (missing values are NaN); the comparator rejects a window edge on such a row.
set -euo pipefail

OUT="${1:-}"
[ -n "$OUT" ] || { echo "usage: sample.sh <out.csv>" >&2; exit 64; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DESC="$REPO/.breeze-stack.json"
[ -f "$DESC" ] || { echo "sample.sh: no $DESC; run pnpm wt-stack up" >&2; exit 1; }
PROJECT="$(jq -r .project "$DESC")"
PG="$(jq -r .pgContainer "$DESC")"
API="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=api --format '{{.Names}}' | head -n1)"
[ -n "$API" ] || { echo "sample.sh: no api container for $PROJECT" >&2; exit 1; }

INTERVAL="${INTERVAL:-10}"
MAX_SAMPLES="${MAX_SAMPLES:-}"
SLEEP_PID=""
trap '[ -n "$SLEEP_PID" ] && kill "$SLEEP_PID" 2>/dev/null; exit 0' TERM INT

echo "ts,cpu_seconds,xact_commit,ws_connections,elu,lag_max,pool_waiting,scrape_ok" >"$OUT"

n=0
while true; do
  SCRAPE="$(docker exec "$API" node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/metrics/scrape',{headers:{authorization:'Bearer '+process.env.METRICS_SCRAPE_TOKEN}}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>{})" 2>/dev/null || true)"
  XACT="$(docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA' 2>/dev/null <<'SQL' | tr -d '[:space:]' || true
SELECT xact_commit FROM pg_stat_database WHERE datname = current_database();
SQL
)"
  # Value of an unlabelled series, or NaN.
  m() { awk -v n="$1" '$1==n {print $2; f=1; exit} END {if(!f) print "NaN"}' <<<"$SCRAPE"; }
  # Sum of every labelled sample of a series, or NaN when none is present.
  msum() { awk -v n="$1" 'index($1, n"{")==1 {s+=$2; f=1} END {if(f) print s+0; else print "NaN"}' <<<"$SCRAPE"; }
  CPU="$(msum breeze_process_cpu_seconds_total)"
  case "$XACT" in ''|*[!0-9]*) XACT="NaN" ;; esac
  FIELDS="$CPU,$XACT,$(m breeze_agent_ws_connections),$(m breeze_nodejs_eventloop_utilization),$(m breeze_nodejs_eventloop_lag_max_seconds),$(m breeze_db_pool_admission_waiting)"
  # Any missing value makes the row unusable at a window edge.
  case "$FIELDS" in *NaN*) OK=0 ;; *) OK=1 ;; esac
  echo "$(date -u +%FT%TZ),$FIELDS,$OK" >>"$OUT"
  n=$((n + 1))
  if [ -n "$MAX_SAMPLES" ] && [ "$n" -ge "$MAX_SAMPLES" ]; then break; fi
  sleep "$INTERVAL" &
  SLEEP_PID=$!
  wait "$SLEEP_PID" || true
  SLEEP_PID=""
done
