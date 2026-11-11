#!/usr/bin/env bash
# Simulated agents (agent/tools/agentsim) for the Wisp test world.
#
# sim.sh start <group> <orgId> <siteId> <agents> <os> <prefix>
#     Enrol <agents> devices on first use and keep them online. A group that
#     already enrolled (its token store exists) is restarted, never re-enrolled.
#     <prefix> must be lowercase (it becomes the hostname prefix).
# sim.sh stop <group>      stop that group (its devices go offline)
# sim.sh restart <group>   bring the same devices back online
# sim.sh stop-all          stop every group
# sim.sh ls                list groups and whether they are running
#
# Every simulated device answers every command "completed, exit 0, stdout agentsim".
set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
SIM="$STATE/sim"
mkdir -p "$SIM" && chmod 700 "$SIM"
BIN="$SIM/agentsim"

build() {
  [ -x "$BIN" ] && return 0
  command -v go >/dev/null || { echo "go is required to build agentsim" >&2; exit 1; }
  say "building agentsim (once)…"
  (cd "$ROOT/agent" && go build -o "$BIN" ./tools/agentsim)
}

running() { [ -f "$SIM/$1.pid" ] && kill -0 "$(cat "$SIM/$1.pid")" 2>/dev/null; }

run() {
  local n="$1" secret
  [ -f "$SIM/$n.env" ] || { echo "unknown sim group $n (start it first)" >&2; exit 1; }
  if running "$n"; then echo "$n already running (pid $(cat "$SIM/$n.pid"))"; return 0; fi
  build
  # shellcheck disable=SC1090
  . "$SIM/$n.env"
  secret="$(docker exec "$APIC" printenv AGENT_ENROLLMENT_SECRET 2>/dev/null || true)"
  # shellcheck disable=SC2153  # AGENTS/OS/PREFIX/KEY come from the group's .env
  AGENTSIM_SERVER="$BASE" AGENTSIM_ENROLLMENT_KEY="$KEY" BREEZE_AGENT_ENROLLMENT_SECRET="$secret" \
    nohup "$BIN" --agents "$AGENTS" --os "$OS" --hostname-prefix "$PREFIX" --duration 72h --ramp 2 \
    --store "$SIM/$n.tokens.json" --report "$SIM/$n.report.json" > "$SIM/$n.log" 2>&1 &
  echo $! > "$SIM/$n.pid"
  echo "started $n pid $(cat "$SIM/$n.pid")"
}

case "${1:-}" in
  start)
    [ $# -eq 7 ] || { echo "usage: sim.sh start <group> <orgId> <siteId> <agents> <os> <prefix>" >&2; exit 2; }
    n="$2"; org="$3"; site="$4"; agents="$5"; os="$6"; prefix="$7"
    case "$prefix" in *[[:upper:]]*) echo "prefix must be lowercase: $prefix" >&2; exit 2 ;; esac
    if [ ! -f "$SIM/$n.env" ]; then
      key="$(api POST /enrollment-keys "$(jq -n --arg o "$org" --arg s "$site" --arg n "sim-$n" '{orgId:$o,siteId:$s,name:$n,maxUsage:50}')" | jq -r '.key // empty')"
      [ -n "$key" ] || { echo "could not create an enrollment key for $n" >&2; exit 1; }
      (umask 077; printf 'KEY=%q\nAGENTS=%q\nOS=%q\nPREFIX=%q\n' "$key" "$agents" "$os" "$prefix" > "$SIM/$n.env")
    fi
    run "$n" ;;
  stop)
    n="$2"
    if running "$n"; then kill "$(cat "$SIM/$n.pid")" && echo "stopped $n"; else echo "$n not running"; fi
    rm -f "$SIM/$n.pid" ;;
  restart) run "$2" ;;
  stop-all)
    for f in "$SIM"/*.env; do [ -e "$f" ] || continue; "$0" stop "$(basename "$f" .env)"; done ;;
  ls)
    for f in "$SIM"/*.env; do
      [ -e "$f" ] || continue
      n="$(basename "$f" .env)"
      if running "$n"; then echo "$n up (pid $(cat "$SIM/$n.pid"))"; else echo "$n down"; fi
    done ;;
  *) echo "usage: sim.sh start|stop|restart|stop-all|ls" >&2; exit 2 ;;
esac
