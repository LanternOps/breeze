#!/usr/bin/env bash
# load-tests/agentsim/storm.sh — run one storm scenario against THIS worktree's wt-stack.
#   storm.sh <scenario> [run.sh flags...]     e.g. storm.sh api-kill --agents 400 --ramp 20 --duration 15m --start cold
#   storm.sh --dry-run <scenario>             print the resolved docker commands and offsets
# <scenario> is a name under storms/ (api-kill, storm-suite, ...) or a path to a .json file.
# Needs: pnpm wt-stack up with AGENT_ENROLL_RATE_LIMIT and METRICS_SCRAPE_TOKEN exported
# (README "Storm scenarios"); .state/lab.env from lab-setup.sh. Exit 3 = a gate failed.
# STORM_WATCH=0 skips the W08 admission-watch.sh sampler that otherwise runs alongside.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DESC="$REPO/.breeze-stack.json"

DRY=0
if [ "${1:-}" = "--dry-run" ]; then DRY=1; shift; fi
NAME="${1:?usage: storm.sh [--dry-run] <scenario> [run.sh flags...]}"
shift
case "$NAME" in
  *.json) FILE="$NAME" ;;
  *) FILE="$HERE/storms/$NAME.json" ;;
esac
[ -f "$FILE" ] || { echo "storm: no scenario $FILE (have: $(find "$HERE/storms" -maxdepth 1 -name '*.json' -exec basename {} .json \; | sort | tr '\n' ' '))" >&2; exit 2; }
SLUG="$(basename "$FILE" .json)"

if [ -f "$HERE/.state/lab.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$HERE/.state/lab.env"
  set +a
fi
[ -f "$DESC" ] || { echo "storm: no $DESC — run pnpm wt-stack up" >&2; exit 1; }
for bin in jq docker; do command -v "$bin" >/dev/null || { echo "storm: $bin is required" >&2; exit 1; }; done

# Containers are resolved from THIS worktree's compose project, never named in a file.
PROJECT="$(jq -r .project "$DESC")"
svc() { docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | head -n1; }
STORM_API="$(svc api)"
STORM_CADDY="$(svc caddy)"
STORM_CPUS="${STORM_CPUS:-0.5}"
[ -n "$STORM_API" ] || { echo "storm: no running api container for project $PROJECT" >&2; exit 1; }
[ -n "$STORM_CADDY" ] || { echo "storm: no running caddy container for project $PROJECT" >&2; exit 1; }
export STORM_API STORM_CADDY STORM_CPUS

if [ "$DRY" = 1 ]; then
  exec "$HERE/run.sh" --storm "$FILE" --storm-dry-run "$@"
fi

if [ -z "${METRICS_SCRAPE_TOKEN:-}" ]; then
  echo "storm: WARNING METRICS_SCRAPE_TOKEN is unset: the report's pool section will be empty and pool gates will fail" >&2
fi

mkdir -p "$HERE/reports"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="$HERE/reports/storm-$SLUG-$STAMP.json"
MARK="$(mktemp)"
WATCH_PID=""
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  if [ -n "$WATCH_PID" ]; then kill "$WATCH_PID" 2>/dev/null || true; fi
  rm -f "$MARK"
}
trap cleanup EXIT

if [ "${STORM_WATCH:-1}" != 0 ]; then
  STORE="${AGENTSIM_STORE:-$HERE/.state/tokens.json}"
  (
    # admission-watch.sh needs the token store run.sh writes; wait up to 10 min for it.
    for _ in $(seq 1 600); do [ -f "$STORE" ] && break; sleep 1; done
    exec "$HERE/admission-watch.sh" watch
  ) &
  WATCH_PID=$!
fi

rc=0
"$HERE/run.sh" --storm "$FILE" "$@" --report "$REPORT" || rc=$?

if [ -n "$WATCH_PID" ]; then
  kill "$WATCH_PID" 2>/dev/null || true
  wait "$WATCH_PID" 2>/dev/null || true
  WATCH_PID=""
  CSV="$(find "$HERE/reports" -maxdepth 1 -name 'admission-*.csv' -newer "$MARK" | sort | tail -n1)"
  if [ -n "$CSV" ]; then
    POOL_MAX="$(docker exec "$STORM_API" printenv DB_POOL_MAX 2>/dev/null || true)"
    echo "storm: W08 sampler ($CSV):"
    "$HERE/admission-watch.sh" summarize "$CSV" "${POOL_MAX:-30}" || true
  else
    echo "storm: WARNING the admission-watch.sh sampler wrote no CSV" >&2
  fi
fi

# run.sh is `exec go run`, and go run turns the binary's exit 3 into 1, so the
# verdict is read from the report. A missing report, or one without a boolean
# .storm.pass, is a run failure (exit 1), never a pass and never "gate failed".
if [ "$rc" != 0 ] && [ "$rc" != 1 ]; then exit "$rc"; fi
if [ ! -f "$REPORT" ]; then
  echo "storm: no report at $REPORT (simulator exit $rc)" >&2
  exit 1
fi
echo "storm: report $REPORT"
PASS="$(jq -r 'if (.storm.pass | type) == "boolean" then .storm.pass else "missing" end' "$REPORT" 2>/dev/null || echo unreadable)"
case "$PASS" in
  true) exit "$rc" ;;
  false) exit 3 ;;
  *) echo "storm: report has no storm verdict ($PASS)" >&2; exit 1 ;;
esac
