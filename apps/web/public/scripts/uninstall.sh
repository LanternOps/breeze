#!/usr/bin/env bash
set -euo pipefail

AGENT_BINARY="/usr/local/bin/breeze-agent"
WATCHDOG_BINARY="/usr/local/bin/breeze-watchdog"
BACKUP_BINARY="/usr/local/bin/breeze-backup"

fatal() {
  echo "Error: $*" >&2
  exit 1
}

warn() {
  echo "Warning: $*" >&2
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    fatal "must run as root (sudo $0)"
  fi
}

# Package-owned macOS teardown. Embedded in Go; copied into download scripts.
# BEGIN BREEZE MACOS UNINSTALL FUNCTIONS
breeze_bootout() {
  target="$1"
  command -v launchctl >/dev/null 2>&1 || return 1
  if launchctl bootout "$target" 2>/dev/null; then
    return 0
  fi
  # An absent job is already stopped; a job that remains loaded is a failure.
  status=0
  launchctl print "$target" >/dev/null 2>&1 || status=$?
  # launchctl uses 113 (service not found) for an absent service target.
  if [ "$status" -ne 113 ]; then
    echo "Error: could not confirm $target stopped (launchctl status $status)" >&2
    return 1
  fi
}

breeze_stop_watchdog() {
  breeze_bootout system/com.breeze.watchdog
}

breeze_stop_helpers() {
  # Include fast-user-switched sessions, not just the foreground console user.
  sessions="$(ps -axo pid=,uid=,comm=)" || return 1
  uids="$(printf '%s\n' "$sessions" | awk '$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $2 >= 500 && $NF ~ /(^|\/)loginwindow$/ {print $2}' | sort -u)"
  for uid in $uids; do
    breeze_bootout "gui/$uid/com.breeze.desktop-helper-user" || return 1
  done
  # LoginWindow is a session type, not a launchctl domain name. Address each
  # actual loginwindow process's domain, including the root login-screen session.
  pids="$(printf '%s\n' "$sessions" | awk '$1 ~ /^[0-9]+$/ && $1 > 0 && $2 ~ /^[0-9]+$/ && $NF ~ /(^|\/)loginwindow$/ {print $1}' | sort -u)"
  for pid in $pids; do
    breeze_bootout "pid/$pid/com.breeze.desktop-helper-loginwindow" || return 1
  done
}

breeze_remove_auxiliary() {
  rm -f /Library/LaunchDaemons/com.breeze.watchdog.plist \
    /Library/LaunchAgents/com.breeze.desktop-helper-user.plist \
    /Library/LaunchAgents/com.breeze.desktop-helper-loginwindow.plist \
    /usr/local/bin/breeze-watchdog /usr/local/bin/breeze-desktop-helper \
    /usr/local/bin/breeze-backup \
    "/Library/Application Support/Breeze/agent.sock" || return 1
  # Only forget this package's receipt; configuration and logs retain their policy.
  receipts="$(pkgutil --pkgs)" || return 1
  if printf '%s\n' "$receipts" | grep -Fxq com.breeze.agent; then
    pkgutil --forget com.breeze.agent || return 1
  fi
}
# END BREEZE MACOS UNINSTALL FUNCTIONS

uninstall_macos() {
  echo "Uninstalling Breeze Agent for macOS..."
  breeze_stop_watchdog || return 1
  breeze_stop_helpers || return 1
  breeze_bootout system/com.breeze.agent || return 1
  rm -f /Library/LaunchDaemons/com.breeze.agent.plist "$AGENT_BINARY" || return 1
  breeze_remove_auxiliary || return 1

  echo "Breeze Agent uninstalled."
  echo "Config at /Library/Application Support/Breeze/ was preserved."
  echo "To remove config: sudo rm -rf '/Library/Application Support/Breeze'"
}

uninstall_linux() {
  local agent_service="/etc/systemd/system/breeze-agent.service"
  local watchdog_service="/etc/systemd/system/breeze-watchdog.service"
  local user_service="/usr/lib/systemd/user/breeze-agent-user.service"
  local xdg_autostart="/etc/xdg/autostart/breeze-agent-user.desktop"
  local ipc_dir="/var/run/breeze"

  echo "Uninstalling Breeze Agent for Linux..."

  if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet breeze-agent 2>/dev/null; then
      systemctl stop breeze-agent
      echo "Service stopped."
    fi
    if systemctl is-enabled --quiet breeze-agent 2>/dev/null; then
      systemctl disable breeze-agent
    fi
    if systemctl is-active --quiet breeze-watchdog 2>/dev/null; then
      systemctl stop breeze-watchdog
      echo "Watchdog service stopped."
    fi
    if systemctl is-enabled --quiet breeze-watchdog 2>/dev/null; then
      systemctl disable breeze-watchdog
    fi
  else
    warn "systemctl not found; skipping service stop and disable"
  fi

  rm -f "$agent_service"
  rm -f "$watchdog_service"
  rm -f "$user_service"
  rm -f "$xdg_autostart"
  rm -f "$AGENT_BINARY"
  rm -f "$WATCHDOG_BINARY"
  rm -f "$BACKUP_BINARY"
  rmdir "$ipc_dir" 2>/dev/null || true

  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload
  fi

  echo "Breeze Agent uninstalled."
  echo "Config at /etc/breeze/ was preserved."
  echo "To remove config: sudo rm -rf /etc/breeze"
}

require_root

uname_s="$(uname -s)"
case "$uname_s" in
  Darwin*) uninstall_macos ;;
  Linux*) uninstall_linux ;;
  *) fatal "unsupported operating system: $uname_s. Only Linux and macOS are supported by this uninstaller." ;;
esac
