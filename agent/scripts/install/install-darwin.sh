#!/bin/bash
set -euo pipefail

BINARY="/usr/local/bin/nu-agent"
PLIST_SRC="$(dirname "$0")/../../service/launchd/com.nodesunlimited.agent.plist"
PLIST_DST="/Library/LaunchDaemons/com.nodesunlimited.agent.plist"
LOG_DIR="/Library/Logs/Nodes Unlimited"
CONFIG_DIR="/Library/Application Support/Nodes Unlimited"

if [ "$(id -u)" -ne 0 ]; then
    echo "Error: must run as root (sudo $0)" >&2
    exit 1
fi

echo "Installing Breeze Agent..."

ensure_breeze_group() {
    if dscl . -read /Groups/breeze &>/dev/null; then
        if ! dscl . -read /Groups/breeze PrimaryGroupID &>/dev/null; then
            echo "Error: existing 'breeze' group has no PrimaryGroupID; refusing to continue" >&2
            exit 1
        fi
        return
    fi

    local gid
    gid=350
    while [ "$gid" -le 499 ]; do
        if ! dscl . -list /Groups PrimaryGroupID 2>/dev/null | awk '{print $2}' | grep -qx "$gid"; then
            dscl . -create /Groups/breeze
            dscl . -create /Groups/breeze PrimaryGroupID "$gid"
            echo "Created 'breeze' group for IPC socket access (gid $gid)."
            return
        fi
        gid=$((gid + 1))
    done

    echo "Error: no free local system GID available for 'breeze' group" >&2
    exit 1
}

# breeze_group_has_member reports whether $1 is in the breeze group.
breeze_group_has_member() {
    dscl . -read /Groups/breeze GroupMembership 2>/dev/null | tr ' ' '\n' | grep -qx "$1"
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
mkdir -p "$CONFIG_DIR" "$LOG_DIR"
chmod 700 "$CONFIG_DIR"
chmod 755 "$LOG_DIR"

# Copy binary
if [ -f bin/nu-agent ]; then
    cp bin/nu-agent "$BINARY"
elif [ -f nu-agent ]; then
    cp nu-agent "$BINARY"
else
    echo "Error: nu-agent binary not found. Run 'make build' first." >&2
    exit 1
fi
chmod 755 "$BINARY"

# Install watchdog
if [ -f "bin/nu-watchdog" ]; then
    echo "Installing watchdog..."
    cp bin/nu-watchdog /usr/local/bin/nu-watchdog
    chmod 755 /usr/local/bin/nu-watchdog
elif [ -f "nu-watchdog" ]; then
    echo "Installing watchdog..."
    cp nu-watchdog /usr/local/bin/nu-watchdog
    chmod 755 /usr/local/bin/nu-watchdog
fi

# Install backup helper. The agent spawns nu-backup from its own directory
# (os.Executable dir), and neither the updater nor the heartbeat delivers it, so
# it MUST be on disk next to nu-agent or every backup fails with
# "backup binary not found at /usr/local/bin/nu-backup". The production .pkg
# (installer/macos/build-pkg.sh) already bundles it; this dev/manual install path
# must match so `make install-service` yields a working backup setup.
if [ -f "bin/nu-backup" ]; then
    echo "Installing backup helper..."
    cp bin/nu-backup /usr/local/bin/nu-backup
    chmod 755 /usr/local/bin/nu-backup
elif [ -f "nu-backup" ]; then
    echo "Installing backup helper..."
    cp nu-backup /usr/local/bin/nu-backup
    chmod 755 /usr/local/bin/nu-backup
else
    echo "Warning: nu-backup binary not found — backups will fail with" \
         "'backup binary not found'. Run 'make build' (or 'make build-backup') first." >&2
fi

# Register watchdog service
if [ -f "/usr/local/bin/nu-watchdog" ]; then
    if [ ! -f "/Library/LaunchDaemons/com.nodesunlimited.watchdog.plist" ]; then
        echo "Registering watchdog service..."
        /usr/local/bin/nu-watchdog service install
    else
        echo "Restarting watchdog service..."
        launchctl kickstart -k system/com.nodesunlimited.watchdog 2>/dev/null || true
    fi
fi

# Install launchd plist
if [ -f "$PLIST_SRC" ]; then
    cp "$PLIST_SRC" "$PLIST_DST"
else
    # Fallback: find plist relative to script location
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    PLIST_ALT="$SCRIPT_DIR/../../service/launchd/com.nodesunlimited.agent.plist"
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
USER_PLIST_SRC="$(dirname "$0")/../../service/launchd/com.nodesunlimited.agent-user.plist"
USER_PLIST_DST="/Library/LaunchAgents/com.nodesunlimited.agent-user.plist"

if [ -f "$USER_PLIST_SRC" ]; then
    cp "$USER_PLIST_SRC" "$USER_PLIST_DST"
    chown root:wheel "$USER_PLIST_DST"
    chmod 644 "$USER_PLIST_DST"
    echo "User helper LaunchAgent installed."
else
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    USER_PLIST_ALT="$SCRIPT_DIR/../../service/launchd/com.nodesunlimited.agent-user.plist"
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
    echo "  1. Enroll:  sudo nu-agent enroll <enrollment-key> --server https://your-server [--enrollment-secret <secret>]"
    echo "  2. Start:   sudo launchctl load $PLIST_DST"
    echo "  3. Status:  sudo launchctl list | grep breeze"
    echo "  4. Logs:    tail -f $LOG_DIR/agent.log"
    echo "  5. Users logged in now were added to the breeze group automatically."
    echo "     Users who log in later are added by the agent when their helper starts."
fi
