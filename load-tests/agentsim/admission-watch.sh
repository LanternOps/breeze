#!/usr/bin/env bash
# load-tests/agentsim/admission-watch.sh — W08 acceptance sampler.
#   admission-watch.sh watch                      sample every $INTERVAL s (default 5) until Ctrl-C
#   admission-watch.sh summarize <csv> <poolMax>  print the W08 gates for a finished run
# Reads /metrics/scrape INSIDE the api container (needs METRICS_SCRAPE_TOKEN set
# for the stack) and pg_stat_activity / devices from the stack's Postgres.
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"
DESC="$REPO/.breeze-stack.json"
if [ -f "$REPO/load-tests/agentsim/.state/lab.env" ]; then set -a; . "$REPO/load-tests/agentsim/.state/lab.env"; set +a; fi

case "${1:-}" in
watch)
  [ -f "$DESC" ] || { echo "admission-watch: no $DESC — run pnpm wt-stack up" >&2; exit 1; }
  PROJECT="$(jq -r .project "$DESC")"; PG="$(jq -r .pgContainer "$DESC")"
  # lab-setup.sh names the store tokens-<project>.json; .state/lab.env (sourced above) sets it.
  STORE="${AGENTSIM_STORE:-$REPO/load-tests/agentsim/.state/tokens-$PROJECT.json}"
  [ -f "$STORE" ] || { echo "admission-watch: no simulator store $STORE — start run.sh first" >&2; exit 1; }
  BASE="$(jq -r .hostnameBase "$STORE")"
  API="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=api --format '{{.Names}}' | head -n1)"
  [ -n "$API" ] || { echo "admission-watch: no api container for $PROJECT" >&2; exit 1; }
  OUT="$REPO/load-tests/agentsim/reports/admission-$(date -u +%Y%m%dT%H%M%SZ).csv"
  mkdir -p "$(dirname "$OUT")"
  echo "ts,level,mode,shed_total,would_shed_total,db_waiting,db_in_use,db_wait_s,lag_s,ws_tokens,api_backends,stuck_backends,max_heartbeat_gap_s,scrape_ok" >"$OUT"
  echo "admission-watch: writing $OUT" >&2
  while true; do
    SCRAPE="$(docker exec "$API" node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/metrics/scrape',{headers:{authorization:'Bearer '+process.env.METRICS_SCRAPE_TOKEN}}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>{})" 2>/dev/null || true)"
    # A failed/empty scrape must not read as healthy: mark the row so `summarize` FAILs it.
    case "$SCRAPE" in *breeze_admission_level*) SCRAPE_OK=1 ;; *) SCRAPE_OK=0 ;; esac
    m() { awk -v n="$1" '$1==n {print $2; f=1} END {if(!f) print "NaN"}' <<<"$SCRAPE"; }
    msum() { awk -v n="$1" -v want="$2" 'index($1, n"{")==1 && index($1, want)>0 {s+=$2} END {print s+0}' <<<"$SCRAPE"; }
    MODE="$(awk 'index($1,"breeze_admission_mode{")==1 && $2==1 {match($1,/mode="[a-z]+"/); print substr($1,RSTART+6,RLENGTH-7)}' <<<"$SCRAPE")"
    PGROW="$(docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -F, -v base="$0"' "$BASE" <<'SQL'
SELECT
  (SELECT count(*) FROM pg_stat_activity WHERE application_name = 'breeze-api'),
  (SELECT count(*) FROM pg_stat_activity WHERE application_name = 'breeze-api' AND (
     (state = 'idle in transaction' AND now() - state_change > interval '5 seconds')
     OR (state = 'active' AND wait_event = 'ClientRead' AND now() - query_start > interval '15 seconds'))),
  (SELECT coalesce(round(max(extract(epoch FROM now() - last_seen_at))), -1) FROM devices
     WHERE hostname LIKE :'base' || '-%' AND status <> 'decommissioned');
SQL
)"
    echo "$(date -u +%FT%TZ),$(m breeze_admission_level),${MODE:-unknown},$(msum breeze_admission_decisions_total 'outcome="shed"'),$(msum breeze_admission_decisions_total 'outcome="would_shed"'),$(m breeze_db_pool_admission_waiting),$(m breeze_db_pool_admission_in_use),$(m breeze_admission_signal_db_wait_seconds),$(m breeze_admission_signal_lag_seconds),$(m breeze_admission_ws_bucket_tokens),$PGROW,$SCRAPE_OK" >>"$OUT"
    sleep "${INTERVAL:-5}"
  done
  ;;
summarize)
  CSV="${2:?usage: admission-watch.sh summarize <csv> <poolMax>}"; POOL="${3:?poolMax (DB_POOL_MAX, default 30)}"
  awk -F, -v pool="$POOL" '
    function isnum(v) { return v ~ /^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$/ }
    NR==1 {next}
    { rows++
      # A failed scrape (scrape_ok=0), a short row or a non-numeric field (NaN) is never healthy.
      bad_row = (NF != 14 || $14 != 1)
      for (i = 2; i <= 13 && !bad_row; i++) if (i != 3 && !isnum($i)) bad_row = 1
      if (bad_row) invalid++
      if ($2+0 > maxlvl) maxlvl=$2+0
      if ($6+0 > 0) { waiting++; if ($11+0 < 0.8*pool) short++ }
      if ($12+0 > 0) stuck++
      if ($13+0 > maxgap) maxgap=$13+0 }
    END {
      printf "rows=%d max_level=%d rows_with_waiters=%d\n", rows, maxlvl, waiting
      printf "%s  every row has a successful scrape and numeric fields: %d bad rows\n", (invalid==0 && rows>0?"PASS":"FAIL"), invalid
      printf "%s  usable pool: rows with waiters and < 80%% of %d backends = %d\n", (short==0?"PASS":"FAIL"), pool, short
      printf "%s  no stuck backends (idle-in-tx > 5 s / ClientRead > 15 s): %d rows\n", (stuck==0?"PASS":"FAIL"), stuck
      printf "%s  max heartbeat gap %ds < 180 s (agent watchdog threshold)\n", (maxgap<180?"PASS":"FAIL"), maxgap
      exit (invalid>0 || rows==0 || short>0 || stuck>0 || maxgap>=180) }' "$CSV"
  ;;
*)
  echo "usage: $0 watch | summarize <csv> <poolMax>" >&2; exit 2 ;;
esac
