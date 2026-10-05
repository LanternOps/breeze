#!/bin/bash
set -euo pipefail

# TRUSTED_BIN_DIR is root-owned and Breeze-only, unlike /usr/local/bin,
# which a package manager (Homebrew on Intel is the known case) can chown
# to a local admin account. The privileged agent/watchdog daemons refuse to
# trust a binary sitting in a directory they don't own; installing here
# keeps that true regardless of what else has touched /usr/local/bin.
TRUSTED_BIN_DIR="/Library/Breeze/bin"
BINARY="$TRUSTED_BIN_DIR/breeze-agent"
PLIST_SRC="$(dirname "$0")/../../service/launchd/com.breeze.agent.plist"
PLIST_DST="/Library/LaunchDaemons/com.breeze.agent.plist"
LOG_DIR="/Library/Logs/Breeze"
CONFIG_DIR="/Library/Application Support/Breeze"

if [ "$(id -u)" -ne 0 ]; then
    echo "Error: must run as root (sudo $0)" >&2
    exit 1
fi

echo "Installing Breeze Agent..."

# ensure_breeze_group: create the IPC socket group, or repair one left without
# a PrimaryGroupID (#7829). Shared with the daemon and the .pkg postinstall.
# shellcheck source=../../internal/sessionbroker/ensure_ipc_group.sh
. "$(dirname "$0")/../../internal/sessionbroker/ensure_ipc_group.sh"

# breeze_group_has_member reports whether $1 is in the breeze group. The
# member list is captured before matching: piping it into `grep -q` lets grep
# exit at the first match, and under this script's pipefail a SIGPIPE on the
# rest of a long list reads as "not a member".
breeze_group_has_member() {
    local members
    members=$(dscl . -read /Groups/breeze GroupMembership 2>/dev/null | tr ' ' '\n') || return 1
    grep -qx -- "$1" <<< "$members"
}

# Add every logged-in GUI user to the breeze group so their desktop helper can
# dial the 0660 root:breeze IPC socket. Mirrors the loop in
# scripts/install/install-linux.sh; without it the socket is group-owned by a
# group nobody is in and Standard (non-admin) users' helpers are denied
# (#3133/#3134/#3137).
#
# This script runs under `set -euo pipefail`. The `|| continue` on the id lookup
# is load-bearing: a bare failing assignment would abort the install. (A failing
# `[ ... ] && continue` would NOT — set -e exempts a command that is part of an
# && list other than the last one.)
add_console_users_to_breeze_group() {
    local uid username
    for uid in $(ps -axo uid= -o comm= | grep -i '[lL]oginwindow' | awk '{print $1}' | sort -u); do
        # macOS gives human accounts UIDs from 500 up; below that are system and
        # service accounts, which never run a Breeze desktop helper.
        if ! [ "$uid" -ge 500 ] 2>/dev/null; then
            continue
        fi
        username=$(id -un "$uid" 2>/dev/null) || continue
        if [ -z "$username" ]; then
            continue
        fi
        if breeze_group_has_member "$username"; then
            continue
        fi
        dscl . -append /Groups/breeze GroupMembership "$username" 2>/dev/null || true
        # Verify by re-reading rather than trusting dscl's exit status, so the
        # success line below cannot claim a membership that did not take.
        if breeze_group_has_member "$username"; then
            echo "Added $username to the 'breeze' group for desktop-helper socket access."
        else
            echo "Warning: could not add $username to the 'breeze' group; that user's desktop helper will be denied the agent socket" >&2
        fi
    done
}

# Stop existing service before replacing binary (safe for upgrades).
if [ -f "$PLIST_DST" ]; then
    if launchctl unload "$PLIST_DST" 2>&1; then
        echo "Stopped existing Breeze Agent service."
    else
        echo "Warning: failed to stop existing service cleanly — continuing anyway" >&2
    fi
fi

# Create directories
mkdir -p "$CONFIG_DIR" "$LOG_DIR" "$TRUSTED_BIN_DIR"
chmod 700 "$CONFIG_DIR"
chmod 755 "$LOG_DIR"
chown root:wheel "$TRUSTED_BIN_DIR"
chmod 755 "$TRUSTED_BIN_DIR"

# Copy binary
if [ -f bin/breeze-agent ]; then
    cp bin/breeze-agent "$BINARY"
elif [ -f breeze-agent ]; then
    cp breeze-agent "$BINARY"
else
    echo "Error: breeze-agent binary not found. Run 'make build' first." >&2
    exit 1
fi
chown root:wheel "$BINARY"
chmod 755 "$BINARY"

# Install watchdog
if [ -f "bin/breeze-watchdog" ]; then
    echo "Installing watchdog..."
    cp bin/breeze-watchdog "$TRUSTED_BIN_DIR/breeze-watchdog"
    chown root:wheel "$TRUSTED_BIN_DIR/breeze-watchdog"
    chmod 755 "$TRUSTED_BIN_DIR/breeze-watchdog"
elif [ -f "breeze-watchdog" ]; then
    echo "Installing watchdog..."
    cp breeze-watchdog "$TRUSTED_BIN_DIR/breeze-watchdog"
    chown root:wheel "$TRUSTED_BIN_DIR/breeze-watchdog"
    chmod 755 "$TRUSTED_BIN_DIR/breeze-watchdog"
fi

# Install backup helper. The agent spawns breeze-backup from its own directory
# (os.Executable dir), and neither the updater nor the heartbeat delivers it, so
# it MUST be on disk next to breeze-agent or every backup fails with
# "backup binary not found". The production .pkg keeps a safe, existing
# /usr/local/bin install where it is (installer/macos/install-location.sh,
# #7211); this dev/manual install path always targets TRUSTED_BIN_DIR, and a
# later .pkg install keeps an install it finds there.
if [ -f "bin/breeze-backup" ]; then
    echo "Installing backup helper..."
    cp bin/breeze-backup "$TRUSTED_BIN_DIR/breeze-backup"
    chown root:wheel "$TRUSTED_BIN_DIR/breeze-backup"
    chmod 755 "$TRUSTED_BIN_DIR/breeze-backup"
elif [ -f "breeze-backup" ]; then
    echo "Installing backup helper..."
    cp breeze-backup "$TRUSTED_BIN_DIR/breeze-backup"
    chown root:wheel "$TRUSTED_BIN_DIR/breeze-backup"
    chmod 755 "$TRUSTED_BIN_DIR/breeze-backup"
else
    echo "Warning: breeze-backup binary not found — backups will fail with" \
         "'backup binary not found'. Run 'make build' (or 'make build-backup') first." >&2
fi

# Register watchdog service
if [ -f "$TRUSTED_BIN_DIR/breeze-watchdog" ]; then
    if [ ! -f "/Library/LaunchDaemons/com.breeze.watchdog.plist" ]; then
        echo "Registering watchdog service..."
        "$TRUSTED_BIN_DIR/breeze-watchdog" service install
    else
        echo "Restarting watchdog service..."
        launchctl kickstart -k system/com.breeze.watchdog 2>/dev/null || true
    fi
fi

# Install launchd plist
if [ -f "$PLIST_SRC" ]; then
    cp "$PLIST_SRC" "$PLIST_DST"
else
    # Fallback: find plist relative to script location
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    PLIST_ALT="$SCRIPT_DIR/../../service/launchd/com.breeze.agent.plist"
    if [ -f "$PLIST_ALT" ]; then
        cp "$PLIST_ALT" "$PLIST_DST"
    else
        echo "Error: launchd plist not found" >&2
        exit 1
    fi
fi
chown root:wheel "$PLIST_DST"
chmod 644 "$PLIST_DST"

# Install user helper LaunchAgent (runs per-user in GUI sessions)
USER_PLIST_SRC="$(dirname "$0")/../../service/launchd/com.breeze.agent-user.plist"
USER_PLIST_DST="/Library/LaunchAgents/com.breeze.agent-user.plist"

if [ -f "$USER_PLIST_SRC" ]; then
    cp "$USER_PLIST_SRC" "$USER_PLIST_DST"
    chown root:wheel "$USER_PLIST_DST"
    chmod 644 "$USER_PLIST_DST"
    echo "User helper LaunchAgent installed."
else
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    USER_PLIST_ALT="$SCRIPT_DIR/../../service/launchd/com.breeze.agent-user.plist"
    if [ -f "$USER_PLIST_ALT" ]; then
        cp "$USER_PLIST_ALT" "$USER_PLIST_DST"
        chown root:wheel "$USER_PLIST_DST"
        chmod 644 "$USER_PLIST_DST"
        echo "User helper LaunchAgent installed."
    else
        echo "Warning: user helper LaunchAgent plist not found (optional)"
    fi
fi

# Create breeze group for IPC socket access
ensure_breeze_group
add_console_users_to_breeze_group

# Create IPC socket directory
mkdir -p "$CONFIG_DIR"
chmod 770 "$CONFIG_DIR"
chown root:breeze "$CONFIG_DIR" 2>/dev/null || true

echo "Breeze Agent installed."
echo ""

# If the agent is already enrolled, skip the enrollment step in Next Steps.
if [ -f "$CONFIG_DIR/agent.yaml" ] && grep -q 'agent_id:' "$CONFIG_DIR/agent.yaml" 2>/dev/null; then
    echo "Next steps:"
    echo "  1. Start:   sudo launchctl load $PLIST_DST"
    echo "  2. Status:  sudo launchctl list | grep breeze"
    echo "  3. Logs:    tail -f $LOG_DIR/agent.log"
    echo "  4. Users logged in now were added to the breeze group automatically."
    echo "     Users who log in later are added by the agent when their helper starts."
else
    echo "Next steps:"
    echo "  1. Enroll:  sudo breeze-agent enroll <enrollment-key> --server https://your-server [--enrollment-secret <secret>]"
    echo "  2. Start:   sudo launchctl load $PLIST_DST"
    echo "  3. Status:  sudo launchctl list | grep breeze"
    echo "  4. Logs:    tail -f $LOG_DIR/agent.log"
    echo "  5. Users logged in now were added to the breeze group automatically."
    echo "     Users who log in later are added by the agent when their helper starts."
fi
