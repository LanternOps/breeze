#!/usr/bin/env bash
# Install (or update) the scheduled UI QA sweep as a macOS launchd agent.
#
#   scripts/qa/install-schedule.sh [--hours "1 13"] [--auth-dir ~/.claude-auth/<profile>] [--uninstall]
#
# Copies the runner + MCP config into ~/.breeze-qa/bin (so the job never depends on
# which branch this checkout happens to be on) and loads a LaunchAgent that fires at
# the given local hours (default: 01:30 nightly). launchd catches up a missed fire on wake.
set -euo pipefail

LABEL="io.lanternops.breeze-qa-sweep"
QA_HOME="${QA_HOME:-$HOME/.breeze-qa}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SRC_DIR/../.." && pwd)"
HOURS="1"
AUTH_DIR="${CLAUDE_SECURESTORAGE_CONFIG_DIR:-}"   # pin the login profile this is run from
MINUTE="30"

while [ $# -gt 0 ]; do
  case "$1" in
    --hours) HOURS="$2"; shift 2 ;;
    --auth-dir) AUTH_DIR="$2"; shift 2 ;;
    --uninstall)
      launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
      rm -f "$PLIST"; echo "uninstalled $LABEL (state kept in $QA_HOME)"; exit 0 ;;
    *) echo "unknown arg $1"; exit 2 ;;
  esac
done

mkdir -p "$QA_HOME/bin" "$QA_HOME/runs"
install -m 0755 "$SRC_DIR/scheduled-ui-sweep.sh" "$QA_HOME/bin/scheduled-ui-sweep.sh"
install -m 0644 "$SRC_DIR/qa-mcp.json" "$QA_HOME/bin/qa-mcp.json"

INTERVALS=""
for h in $HOURS; do
  INTERVALS="$INTERVALS<dict><key>Hour</key><integer>$h</integer><key>Minute</key><integer>$MINUTE</integer></dict>"
done

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$QA_HOME/bin/scheduled-ui-sweep.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>QA_HOME</key><string>$QA_HOME</string>
    <key>QA_SOURCE_REPO</key><string>$REPO</string>
    <key>HOME</key><string>$HOME</string>
    <key>QA_CLAUDE_AUTH_DIR</key><string>$AUTH_DIR</string>
  </dict>
  <key>StartCalendarInterval</key><array>$INTERVALS</array>
  <key>StandardOutPath</key><string>$QA_HOME/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$QA_HOME/launchd.err.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PL
plutil -lint "$PLIST" >/dev/null

# Refuse to install a job that would bill the API or run logged-out.
AUTH="$(env -i HOME="$HOME" PATH="$HOME/.local/bin:/usr/bin:/bin" ${AUTH_DIR:+CLAUDE_SECURESTORAGE_CONFIG_DIR="$AUTH_DIR"} \
        claude auth status --json 2>/dev/null | jq -r '"\(.authMethod) \(.email // "-") \(.subscriptionType // "-")"')"
case "$AUTH" in claude.ai*) echo "auth: $AUTH" ;; *) echo "ERROR: no claude.ai subscription login for profile '${AUTH_DIR:-default}' ($AUTH)"; rm -f "$PLIST"; exit 1 ;; esac

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL: hours=[$HOURS] minute=$MINUTE, runner=$QA_HOME/bin/scheduled-ui-sweep.sh"
echo "run now:  launchctl kickstart gui/$(id -u)/$LABEL"
