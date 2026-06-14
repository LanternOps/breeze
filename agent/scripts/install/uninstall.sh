#!/usr/bin/env bash
set -euo pipefail

AGENT_BINARY="/usr/local/bin/breeze-agent"
WATCHDOG_BINARY="/usr/local/bin/breeze-watchdog"

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

uninstall_macos() {
  local agent_plist="/Library/LaunchDaemons/com.breeze.agent.plist"
  local watchdog_plist="/Library/LaunchDaemons/com.breeze.watchdog.plist"
  local user_plist="/Library/LaunchAgents/com.breeze.agent-user.plist"

  echo "Uninstalling Breeze Agent for macOS..."

  if command -v launchctl >/dev/null 2>&1; then
    launchctl bootout system/com.breeze.agent 2>/dev/null || launchctl unload "$agent_plist" 2>/dev/null || true
    launchctl bootout system/com.breeze.watchdog 2>/dev/null || launchctl unload "$watchdog_plist" 2>/dev/null || true
    launchctl unload "$user_plist" 2>/dev/null || true
  else
    warn "launchctl not found; skipping service stop"
  fi

  rm -f "$agent_plist"
  rm -f "$watchdog_plist"
  rm -f "$user_plist"
  rm -f "$AGENT_BINARY"
  rm -f "$WATCHDOG_BINARY"

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
