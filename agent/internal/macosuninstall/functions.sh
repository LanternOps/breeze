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
  # Consume all input: grep -q can SIGPIPE printf under Bash pipefail.
  if printf '%s\n' "$receipts" | grep -Fx com.breeze.agent >/dev/null; then
    pkgutil --forget com.breeze.agent || return 1
  fi
}
# END BREEZE MACOS UNINSTALL FUNCTIONS
