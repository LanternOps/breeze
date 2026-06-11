#!/bin/bash
set -euo pipefail

BINARY="/usr/local/bin/breeze-agent"
PLIST_SRC="$(dirname "$0")/../../service/launchd/com.breeze.agent.plist"
PLIST_DST="/Library/LaunchDaemons/com.breeze.agent.plist"
LOG_DIR="/Library/Logs/Breeze"
CONFIG_DIR="/Library/Application Support/Breeze"

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
if [ -f bin/breeze-agent ]; then
    cp bin/breeze-agent "$BINARY"
elif [ -f breeze-agent ]; then
    cp breeze-agent "$BINARY"
else
    echo "Error: breeze-agent binary not found. Run 'make build' first." >&2
    exit 1
fi
chmod 755 "$BINARY"

# Install watchdog
if [ -f "bin/breeze-watchdog" ]; then
    echo "Installing watchdog..."
    cp bin/breeze-watchdog /usr/local/bin/breeze-watchdog
    chmod 755 /usr/local/bin/breeze-watchdog
elif [ -f "breeze-watchdog" ]; then
    echo "Installing watchdog..."
    cp breeze-watchdog /usr/local/bin/breeze-watchdog
    chmod 755 /usr/local/bin/breeze-watchdog
fi

# Register watchdog service
if [ -f "/usr/local/bin/breeze-watchdog" ]; then
    if [ ! -f "/Library/LaunchDaemons/com.breeze.watchdog.plist" ]; then
        echo "Registering watchdog service..."
        /usr/local/bin/breeze-watchdog service install
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
    echo "  4. Add users to breeze group:  sudo dscl . -append /Groups/breeze GroupMembership <username>"
else
    echo "Next steps:"
    echo "  1. Enroll:  sudo breeze-agent enroll <enrollment-key> --server https://your-server [--enrollment-secret <secret>]"
    echo "  2. Start:   sudo launchctl load $PLIST_DST"
    echo "  3. Status:  sudo launchctl list | grep breeze"
    echo "  4. Logs:    tail -f $LOG_DIR/agent.log"
    echo "  5. Add users to breeze group:  sudo dscl . -append /Groups/breeze GroupMembership <username>"
fi
