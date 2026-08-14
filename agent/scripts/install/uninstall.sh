#!/usr/bin/env bash
# Nodes Unlimited RMM agent — clean uninstaller (macOS + Linux).
#
# macOS ordering is load-bearing. The watchdog respawns the agent
# (launchctl kickstart -k system/com.nodesunlimited.agent, fallback bootstrap
# from the agent plist). If the agent is stopped while the watchdog is alive,
# the watchdog re-bootstraps it and the uninstall loses the race. So the
# watchdog is fully removed FIRST (bootout + plist + binary + pkill backstop),
# then the agent is `disable`d (so a reboot mid-teardown cannot auto-start it)
# and removed. Config dir is removed LAST, after processes are dead.
#
# Non-disruptive: live launchctl/systemctl stop only — never a reboot.
# Idempotent: every step tolerates already-absent state.
set -uo pipefail

AGENT_BINARY="/usr/local/bin/nu-agent"
WATCHDOG_BINARY="/usr/local/bin/nu-watchdog"
HELPER_BINARY="/usr/local/bin/nu-desktop-helper"
BACKUP_BINARY="/usr/local/bin/nu-backup"

REMOVE_CONFIG=0          # --remove-config to also delete config/enrollment
REMOVE_GROUP=0           # --remove-group to delete the macOS 'breeze' dscl group
for arg in "$@"; do
  case "$arg" in
    --remove-config) REMOVE_CONFIG=1 ;;
    --remove-group)  REMOVE_GROUP=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

fatal() { echo "Error: $*" >&2; exit 1; }
warn()  { echo "Warning: $*" >&2; }
require_root() { [[ "$(id -u)" -eq 0 ]] || fatal "must run as root (sudo $0)"; }

console_uid() {
  local uid; uid="$(stat -f %u /dev/console 2>/dev/null || echo "")"
  [[ -n "$uid" && "$uid" != "0" ]] && echo "$uid" || true
}

uninstall_macos() {
  local agent_label="com.nodesunlimited.agent"
  local watchdog_label="com.nodesunlimited.watchdog"
  local agent_plist="/Library/LaunchDaemons/com.nodesunlimited.agent.plist"
  local watchdog_plist="/Library/LaunchDaemons/com.nodesunlimited.watchdog.plist"
  local helper_user_label="com.nodesunlimited.desktop-helper-user"
  local helper_lw_label="com.nodesunlimited.desktop-helper-loginwindow"
  local agent_user_label="com.nodesunlimited.agent-user"   # legacy/defensive
  local helper_user_plist="/Library/LaunchAgents/com.nodesunlimited.desktop-helper-user.plist"
  local helper_lw_plist="/Library/LaunchAgents/com.nodesunlimited.desktop-helper-loginwindow.plist"
  local agent_user_plist="/Library/LaunchAgents/com.nodesunlimited.agent-user.plist"
  local config_dir="/Library/Application Support/Nodes Unlimited"
  local log_dir="/Library/Logs/Nodes Unlimited"
  local pkg_receipt="com.nodesunlimited.agent"
  local ipc_group="breeze"

  echo "Uninstalling Nodes Unlimited Agent for macOS..."
  if ! command -v launchctl >/dev/null 2>&1; then
    warn "launchctl not found; skipping service stop"
  else
    # 1. WATCHDOG FIRST — stop, remove plist + binary, pkill backstop.
    launchctl bootout "system/${watchdog_label}" 2>/dev/null \
      || launchctl unload "$watchdog_plist" 2>/dev/null || true
    rm -f "$watchdog_plist" "$WATCHDOG_BINARY"
    pkill -x nu-watchdog 2>/dev/null || true

    # 2. Per-user helpers (gui/<UID> + loginwindow domains).
    local uid_console; uid_console="$(console_uid)"
    if [[ -n "$uid_console" ]]; then
      launchctl bootout "gui/${uid_console}/${helper_user_label}" 2>/dev/null || true
      launchctl bootout "gui/${uid_console}/${agent_user_label}"  2>/dev/null || true
    fi
    launchctl bootout "loginwindow/${helper_lw_label}" 2>/dev/null || true

    # 3. AGENT — disable (blocks reboot auto-start) then stop.
    launchctl disable "system/${agent_label}" 2>/dev/null || true
    launchctl bootout "system/${agent_label}" 2>/dev/null \
      || launchctl unload "$agent_plist" 2>/dev/null || true
  fi

  # 4. Remove all plists.
  rm -f "$agent_plist" "$helper_user_plist" "$helper_lw_plist" "$agent_user_plist"

  # 5. Remove binaries (+ inert AppleDouble ._ siblings the pkg ships).
  local b
  for b in "$AGENT_BINARY" "$WATCHDOG_BINARY" "$HELPER_BINARY" "$BACKUP_BINARY"; do
    rm -f "$b" "$(dirname "$b")/._$(basename "$b")"
  done

  # 6. Logs (nothing preserves them).
  rm -rf "$log_dir"

  # 7. Config dir LAST, after processes are dead.
  if [[ "$REMOVE_CONFIG" -eq 1 ]]; then
    rm -rf "$config_dir"
    echo "Removed config: $config_dir"
  else
    echo "Preserved config: $config_dir (pass --remove-config to delete)"
  fi

  # 8. pkg receipt so pkgutil no longer reports the agent as installed.
  pkgutil --forget "$pkg_receipt" >/dev/null 2>&1 || true

  # 9. Optional dscl IPC group.
  if [[ "$REMOVE_GROUP" -eq 1 ]]; then
    dscl . -delete "/Groups/${ipc_group}" 2>/dev/null || true
    echo "Removed group: ${ipc_group}"
  fi

  # 10. Verify. `launchctl bootout` is asynchronous — a service can still be
  # tearing down for a moment after it returns, so poll instead of reporting a
  # false failure the first time we look. A warning that cries wolf reads as a
  # failed uninstall to the technician running it.
  echo "--- verification ---"
  if command -v launchctl >/dev/null 2>&1; then
    local l waited
    for l in "$watchdog_label" "$agent_label"; do
      waited=0
      while launchctl print "system/${l}" >/dev/null 2>&1 && [[ "$waited" -lt 20 ]]; do
        sleep 0.5
        waited=$((waited + 1))
      done
      if launchctl print "system/${l}" >/dev/null 2>&1; then
        warn "${l} still loaded after 10s"
      else
        echo "ok: ${l} not loaded"
      fi
    done
  fi
  # Backstop any process that outlived its job (mirrors the watchdog pkill).
  local p
  for p in nu-agent nu-desktop-helper; do
    pgrep -x "$p" >/dev/null 2>&1 && { pkill -x "$p" 2>/dev/null || true; }
  done
  for b in "$AGENT_BINARY" "$WATCHDOG_BINARY" "$HELPER_BINARY" "$BACKUP_BINARY"; do
    [[ -e "$b" ]] && warn "${b} still present" || true
  done
  if command -v pkgutil >/dev/null 2>&1; then
    pkgutil --pkgs 2>/dev/null | grep -q "^${pkg_receipt}$" \
      && warn "receipt ${pkg_receipt} still present" || echo "ok: receipt cleared"
  fi

  echo "Nodes Unlimited Agent uninstalled."
  echo "(A logged-in user's desktop helper may linger until logout; its plist is gone so it will not relaunch.)"
}

uninstall_linux() {
  local agent_service="/etc/systemd/system/nu-agent.service"
  local watchdog_service="/etc/systemd/system/nu-watchdog.service"
  local user_service="/usr/lib/systemd/user/nu-agent-user.service"
  local xdg_autostart="/etc/xdg/autostart/nu-agent-user.desktop"
  local ipc_dir="/var/run/breeze"
  local config_dir="/etc/nodesunlimited"

  echo "Uninstalling Nodes Unlimited Agent for Linux..."
  if command -v systemctl >/dev/null 2>&1; then
    # Watchdog first so it cannot restart the agent mid-teardown.
    systemctl stop nu-watchdog 2>/dev/null || true
    systemctl disable nu-watchdog 2>/dev/null || true
    systemctl stop nu-agent 2>/dev/null || true
    systemctl disable nu-agent 2>/dev/null || true
  else
    warn "systemctl not found; skipping service stop and disable"
  fi

  # `systemctl stop` returns once the job is queued; a unit still in
  # 'deactivating' keeps the process alive. Removing the unit file and binary
  # out from under a live process leaves an orphan holding a deleted binary
  # (which on Debian/Ubuntu also makes needrestart flag the unit). Wait for a
  # real exit, then SIGKILL what refuses to go.
  local proc waited
  for proc in nu-watchdog nu-agent; do
    waited=0
    while pgrep -x "$proc" >/dev/null 2>&1 && [[ "$waited" -lt 20 ]]; do
      sleep 0.5
      waited=$((waited + 1))
    done
    if pgrep -x "$proc" >/dev/null 2>&1; then
      warn "$proc did not exit after stop; sending SIGTERM"
      pkill -x "$proc" 2>/dev/null || true
      sleep 2
      pgrep -x "$proc" >/dev/null 2>&1 && pkill -9 -x "$proc" 2>/dev/null || true
    fi
  done

  rm -f "$agent_service" "$watchdog_service" "$user_service" "$xdg_autostart"
  rm -f "$AGENT_BINARY" "$WATCHDOG_BINARY" "$HELPER_BINARY" "$BACKUP_BINARY"
  rmdir "$ipc_dir" 2>/dev/null || true

  command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload || true

  if [[ "$REMOVE_CONFIG" -eq 1 ]]; then
    rm -rf "$config_dir"
    echo "Removed config: $config_dir"
  else
    echo "Preserved config: $config_dir (pass --remove-config to delete)"
  fi
  echo "Nodes Unlimited Agent uninstalled."
}

require_root
uname_s="$(uname -s)"
case "$uname_s" in
  Darwin*) uninstall_macos ;;
  Linux*)  uninstall_linux ;;
  *) fatal "unsupported operating system: $uname_s. Only Linux and macOS are supported by this uninstaller." ;;
esac
