#!/usr/bin/env bash
# Install (or update) the scheduled UI QA sweep as a macOS launchd agent.
#
#   scripts/qa/install-schedule.sh [--hours "1 13"] [--agent-token] [--uninstall]
#
# The agent's model calls carry its own long-lived claude.ai token, never your
# login (its sandbox gives it no keychain). Make one with `claude setup-token`
# and pass --agent-token once: the token is read from stdin (or a hidden prompt)
# and stored, mode 600, at $QA_HOME/.agent-auth/oauth-token. The agent never
# holds it: each run pipes it to a loopback model forwarder outside the
# sandbox, which adds it to the agent's model API requests.
#
# Copies the runner (+ sweep-lib.sh, egress-proxy.py, model-forwarder.py, gh-broker.py, qa-gh), MCP config and the ui-qa-sweep skill into ~/.breeze-qa/bin (so the job never depends on
# which branch this checkout happens to be on) and loads a LaunchAgent that fires at
# the given local hours (default: 01:30 nightly). launchd catches up a missed fire on wake.
set -euo pipefail

LABEL="io.lanternops.breeze-qa-sweep"
QA_HOME="${QA_HOME:-$HOME/.breeze-qa}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECKOUT="$(cd "$SRC_DIR/../.." && pwd)"            # checkout we bundle the skill from
# Source repo for fetch/worktree = the MAIN repo behind this checkout, so running
# the installer from a throwaway worktree doesn't point the job at a temp path.
REPO="$(cd "$(git -C "$CHECKOUT" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"
HOURS="1"
SET_TOKEN=0
MINUTE="30"

while [ $# -gt 0 ]; do
  case "$1" in
    --hours) HOURS="$2"; shift 2 ;;
    --agent-token) SET_TOKEN=1; shift ;;
    --uninstall)
      launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
      rm -f "$PLIST"; echo "uninstalled $LABEL (state kept in $QA_HOME)"; exit 0 ;;
    *) echo "unknown arg $1"; exit 2 ;;
  esac
done

mkdir -p "$QA_HOME/bin" "$QA_HOME/runs"
log() { echo "$*" >&2; }
# shellcheck source=sweep-lib.sh
. "$SRC_DIR/sweep-lib.sh"   # agent_token_path, load_agent_token
if [ "$SET_TOKEN" = 1 ]; then
  [ -t 0 ] && printf 'Paste the token from `claude setup-token` (input hidden): ' >&2
  IFS= read -rs TOKEN || true; [ -t 0 ] && echo >&2
  TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
  TF="$(agent_token_path)"
  ( umask 077; mkdir -p "$(dirname "$TF")" && rm -f "$TF" && printf '%s\n' "$TOKEN" > "$TF" ) || { echo "ERROR: could not write $TF"; exit 1; }
  unset TOKEN
fi
[ -x /usr/bin/sandbox-exec ] && [ -x /usr/bin/python3 ] \
  || { echo "ERROR: needs /usr/bin/sandbox-exec and /usr/bin/python3 (agent sandbox + egress proxy)"; exit 1; }
install -m 0755 "$SRC_DIR/scheduled-ui-sweep.sh" "$QA_HOME/bin/scheduled-ui-sweep.sh"
install -m 0644 "$SRC_DIR/sweep-lib.sh" "$QA_HOME/bin/sweep-lib.sh"
install -m 0755 "$SRC_DIR/egress-proxy.py" "$QA_HOME/bin/egress-proxy.py"
install -m 0755 "$SRC_DIR/model-forwarder.py" "$QA_HOME/bin/model-forwarder.py"   # holds the agent token; the agent never does
install -m 0755 "$SRC_DIR/gh-broker.py" "$QA_HOME/bin/gh-broker.py"   # the agent's only GitHub reader (runs outside the sandbox)
install -m 0755 "$SRC_DIR/qa-gh" "$QA_HOME/bin/qa-gh"                 # its client, run by the agent
install -m 0644 "$SRC_DIR/qa-mcp.json" "$QA_HOME/bin/qa-mcp.json"
install -m 0644 "$SRC_DIR/qa-env.overrides" "$QA_HOME/bin/qa-env.overrides"
install -m 0644 "$CHECKOUT/.claude/skills/ui-qa-sweep/SKILL.md" "$QA_HOME/bin/ui-qa-sweep.SKILL.md"   # contract travels with the runner

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
  </dict>
  <key>StartCalendarInterval</key><array>$INTERVALS</array>
  <key>StandardOutPath</key><string>$QA_HOME/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$QA_HOME/launchd.err.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PL
plutil -lint "$PLIST" >/dev/null

# Refuse to install a job that would run logged-out: the agent's own token must
# be in place and shaped like a claude.ai setup-token (sk-ant-oat..). The
# forwarder only ever sends it as a subscription bearer token (never an API
# key), and every run's self-check proves it against the API before the agent
# starts.
if ! load_agent_token; then
  echo "ERROR: no usable agent token at $(agent_token_path). Run: claude setup-token, then $0 --agent-token"
  rm -f "$PLIST"; exit 1
fi
# shellcheck disable=SC2034  # validated only; the installer keeps no copy
AGENT_OAUTH_TOKEN=""
echo "auth: agent token in place ($(agent_token_path))"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL: hours=[$HOURS] minute=$MINUTE, source repo=$REPO, skill from $CHECKOUT"
echo "run now:  launchctl kickstart gui/$(id -u)/$LABEL"
