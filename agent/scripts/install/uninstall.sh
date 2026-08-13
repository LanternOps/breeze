#!/usr/bin/env bash
set -euo pipefail

AGENT_BINARY="/usr/local/bin/nu-agent"
WATCHDOG_BINARY="/usr/local/bin/nu-watchdog"
BACKUP_BINARY="/usr/local/bin/nu-backup"

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
  local agent_plist="/Library/LaunchDaemons/com.nodesunlimited.agent.plist"
  local watchdog_plist="/Library/LaunchDaemons/com.nodesunlimited.watchdog.plist"
  local user_plist="/Library/LaunchAgents/com.nodesunlimited.agent-user.plist"

  echo "Uninstalling Breeze Agent for macOS..."

  if command -v launchctl >/dev/null 2>&1; then
    launchctl bootout system/com.nodesunlimited.agent 2>/dev/null || launchctl unload "$agent_plist" 2>/dev/null || true
    launchctl bootout system/com.nodesunlimited.watchdog 2>/dev/null || launchctl unload "$watchdog_plist" 2>/dev/null || true
    launchctl unload "$user_plist" 2>/dev/null || true
  else
    warn "launchctl not found; skipping service stop"
  fi

  rm -f "$agent_plist"
  rm -f "$watchdog_plist"
  rm -f "$user_plist"
  rm -f "$AGENT_BINARY"
  rm -f "$WATCHDOG_BINARY"
  rm -f "$BACKUP_BINARY"

  echo "Breeze Agent uninstalled."
  echo "Config at /Library/Application Support/Nodes Unlimited/ was preserved."
  echo "To remove config: sudo rm -rf '/Library/Application Support/Nodes Unlimited'"
}

uninstall_linux() {
  local agent_service="/etc/systemd/system/nu-agent.service"
  local watchdog_service="/etc/systemd/system/nu-watchdog.service"
  local user_service="/usr/lib/systemd/user/nu-agent-user.service"
  local xdg_autostart="/etc/xdg/autostart/nu-agent-user.desktop"
  local ipc_dir="/var/run/breeze"

  echo "Uninstalling Breeze Agent for Linux..."

  if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet nu-agent 2>/dev/null; then
      systemctl stop nu-agent
      echo "Service stopped."
    fi
    if systemctl is-enabled --quiet nu-agent 2>/dev/null; then
      systemctl disable nu-agent
    fi
    if systemctl is-active --quiet nu-watchdog 2>/dev/null; then
      systemctl stop nu-watchdog
      echo "Watchdog service stopped."
    fi
    if systemctl is-enabled --quiet nu-watchdog 2>/dev/null; then
      systemctl disable nu-watchdog
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
  echo "Config at /etc/nodesunlimited/ was preserved."
  echo "To remove config: sudo rm -rf /etc/nodesunlimited"
}

require_root

uname_s="$(uname -s)"
case "$uname_s" in
  Darwin*) uninstall_macos ;;
  Linux*) uninstall_linux ;;
  *) fatal "unsupported operating system: $uname_s. Only Linux and macOS are supported by this uninstaller." ;;
esac
