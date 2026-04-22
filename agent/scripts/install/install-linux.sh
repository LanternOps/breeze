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

# Install watchdog systemd unit if not already present
if [ -f "/usr/local/bin/breeze-watchdog" ]; then
    if [ ! -f "/etc/systemd/system/breeze-watchdog.service" ]; then
        echo "Registering watchdog service..."
        /usr/local/bin/breeze-watchdog service install
    else
        echo "Restarting watchdog service..."
        systemctl restart breeze-watchdog || true
    fi
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
# /run is tmpfs-backed and wiped across reboots; without this the service
# fails sandbox setup (ProtectSystem=strict + ReadWritePaths=/var/run/breeze)
# and does not auto-start after reboot. Runs AFTER groupadd because the
# snippet references the breeze group for ownership.
TMPFILES_SRC="$SCRIPT_DIR/../../service/tmpfiles.d/breeze-agent.conf"
TMPFILES_DST="/usr/lib/tmpfiles.d/breeze-agent.conf"
if [ -f "$TMPFILES_SRC" ]; then
    cp "$TMPFILES_SRC" "$TMPFILES_DST"
    chmod 644 "$TMPFILES_DST"
    if ! systemd-tmpfiles --create "$TMPFILES_DST"; then
        echo "Warning: systemd-tmpfiles --create failed; /run/breeze will be created on next boot" >&2
    fi
    echo "tmpfiles.d snippet installed (recreates /run/breeze on reboot)."
fi

# Create IPC socket directory
IPC_DIR="/var/run/breeze"
mkdir -p "$IPC_DIR"
chown root:breeze "$IPC_DIR"
chmod 770 "$IPC_DIR"

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
