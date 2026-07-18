#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="/usr/local/bin/breeze-agent"
SERVICE_SRC="$SCRIPT_DIR/../../service/systemd/breeze-agent.service"
SERVICE_DST="/etc/systemd/system/breeze-agent.service"
CONFIG_DIR="/etc/breeze"
DATA_DIR="/var/lib/breeze"
LOG_DIR="/var/log/breeze"

if [ "$(id -u)" -ne 0 ]; then
    echo "Error: must run as root (sudo $0)" >&2
    exit 1
fi

echo "Installing Breeze Agent..."

# Stop existing service before replacing binary (safe for upgrades).
if [ -f "$SERVICE_DST" ]; then
    if systemctl stop breeze-agent 2>&1; then
        echo "Stopped existing Breeze Agent service."
    else
        echo "Warning: failed to stop existing service cleanly — continuing anyway" >&2
    fi
fi

# Create directories
mkdir -p "$CONFIG_DIR" "$DATA_DIR" "$LOG_DIR"
chmod 700 "$CONFIG_DIR"
chmod 755 "$DATA_DIR" "$LOG_DIR"

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

# Install backup helper. The agent spawns breeze-backup from its own directory
# (os.Executable dir), and neither the updater nor the heartbeat delivers it, so
# it MUST be on disk next to breeze-agent or every backup fails with
# "backup binary not found at /usr/local/bin/breeze-backup". The macOS .pkg and
# Windows MSI already bundle it; this shell-script install path is the Linux
# install path, so it has to install it too.
if [ -f "bin/breeze-backup" ]; then
    echo "Installing backup helper..."
    cp bin/breeze-backup /usr/local/bin/breeze-backup
    chmod 755 /usr/local/bin/breeze-backup
elif [ -f "breeze-backup" ]; then
    echo "Installing backup helper..."
    cp breeze-backup /usr/local/bin/breeze-backup
    chmod 755 /usr/local/bin/breeze-backup
else
    echo "Warning: breeze-backup binary not found — backups will fail with" \
         "'backup binary not found'. Run 'make build' (or 'make build-backup') first." >&2
fi

# (Re)install the watchdog systemd unit on EVERY install/upgrade.
#
# `breeze-watchdog service install` always rewrites the unit file (and runs
# daemon-reload + enable). Re-running it on an existing host is how unit changes
# — e.g. the RuntimeDirectory=breeze / RuntimeDirectoryPreserve=yes additions
# for #1297 — reach already-deployed watchdogs. The old "rewrite only when
# absent, else just restart" path silently skipped those edits, so an upgraded
# host kept its stale watchdog unit and stayed one reboot away from a
# 226/NAMESPACE wedge. `service install` is idempotent, so always calling it is
# safe. It stops the service while writing the unit but does not start it, so we
# (re)start explicitly afterward.
if [ -f "/usr/local/bin/breeze-watchdog" ]; then
    echo "Registering watchdog service..."
    /usr/local/bin/breeze-watchdog service install
    echo "Starting watchdog service..."
    systemctl restart breeze-watchdog || true
fi

# Install systemd unit
if [ -f "$SERVICE_SRC" ]; then
    cp "$SERVICE_SRC" "$SERVICE_DST"
else
    echo "Error: systemd unit file not found at $SERVICE_SRC" >&2
    exit 1
fi
chmod 644 "$SERVICE_DST"

systemctl daemon-reload
systemctl enable breeze-agent

# Install user helper systemd user unit
USER_SERVICE_SRC="$SCRIPT_DIR/../../service/systemd/breeze-agent-user.service"
USER_SERVICE_DST="/usr/lib/systemd/user/breeze-agent-user.service"

if [ -f "$USER_SERVICE_SRC" ]; then
    mkdir -p "$(dirname "$USER_SERVICE_DST")"
    cp "$USER_SERVICE_SRC" "$USER_SERVICE_DST"
    chmod 644 "$USER_SERVICE_DST"
    echo "User helper systemd user unit installed."
fi

# Install XDG autostart desktop file (fallback for non-systemd)
XDG_SRC="$SCRIPT_DIR/../../service/xdg/breeze-agent-user.desktop"
XDG_DST="/etc/xdg/autostart/breeze-agent-user.desktop"

if [ -f "$XDG_SRC" ]; then
    mkdir -p "$(dirname "$XDG_DST")"
    cp "$XDG_SRC" "$XDG_DST"
    chmod 644 "$XDG_DST"
    echo "XDG autostart desktop file installed."
fi

# Create breeze group for IPC socket access (idempotent)
if ! getent group breeze &>/dev/null; then
    groupadd --system breeze 2>/dev/null || true
    echo "Created 'breeze' group for IPC socket access."
fi

# Install tmpfiles.d snippet so /run/breeze is recreated on every boot.
# /run is tmpfs-backed and wiped across reboots. The breeze-agent.service and
# breeze-watchdog.service units now declare RuntimeDirectory=breeze, so systemd
# recreates /run/breeze before each ExecStart even without this snippet — that
# is the primary, self-contained fix for #1297. The snippet remains as defense-
# in-depth so /run/breeze also exists for tooling that runs before the units
# start. Runs AFTER groupadd because the snippet references the breeze group.
TMPFILES_SRC="$SCRIPT_DIR/../../service/tmpfiles.d/breeze-agent.conf"
TMPFILES_DST="/usr/lib/tmpfiles.d/breeze-agent.conf"
if [ -f "$TMPFILES_SRC" ]; then
    cp "$TMPFILES_SRC" "$TMPFILES_DST"
    chmod 644 "$TMPFILES_DST"
    if ! systemd-tmpfiles --create "$TMPFILES_DST"; then
        echo "Warning: systemd-tmpfiles --create failed; relying on RuntimeDirectory=breeze in the unit to recreate /run/breeze on next start" >&2
    fi
    echo "tmpfiles.d snippet installed (recreates /run/breeze on reboot)."
fi

# Create IPC socket directory
IPC_DIR="/var/run/breeze"
mkdir -p "$IPC_DIR"
chown root:breeze "$IPC_DIR"
chmod 770 "$IPC_DIR"

# Verify /run/breeze exists post-install. With RuntimeDirectory=breeze on both
# units this is normally redundant, but a failed mkdir/chown above (e.g. a
# read-only /run) would otherwise ship a host one reboot away from a silent
# 226/NAMESPACE wedge (#1297 / #502). Fail loudly instead of warn-and-continue.
if [ ! -d "$IPC_DIR" ]; then
    echo "Error: $IPC_DIR does not exist after install — the service will fail to start." >&2
    echo "       Check that /run is writable and re-run the installer." >&2
    exit 1
fi

# Add all logged-in users to the breeze group
for user in $(who | awk '{print $1}' | sort -u); do
    if ! id -nG "$user" 2>/dev/null | grep -qw breeze; then
        usermod -aG breeze "$user" 2>/dev/null || true
        echo "  Added $user to breeze group"
    fi
done

echo "Breeze Agent installed."
echo ""

# If the agent is already enrolled, skip the enrollment step in Next Steps.
if [ -f "$CONFIG_DIR/agent.yaml" ] && grep -q 'agent_id:' "$CONFIG_DIR/agent.yaml" 2>/dev/null; then
    echo "Next steps:"
    echo "  1. Start:   sudo systemctl start breeze-agent"
    echo "  2. Status:  sudo systemctl status breeze-agent"
    echo "  3. Logs:    journalctl -u breeze-agent -f"
    echo "  4. User helper: systemctl --user enable breeze-agent-user (per-user)"
else
    echo "Next steps:"
    echo "  1. Enroll:  sudo breeze-agent enroll <enrollment-key> --server https://your-server [--enrollment-secret <secret>]"
    echo "  2. Start:   sudo systemctl start breeze-agent"
    echo "  3. Status:  sudo systemctl status breeze-agent"
    echo "  4. Logs:    journalctl -u breeze-agent -f"
    echo "  5. User helper: systemctl --user enable breeze-agent-user (per-user)"
fi
