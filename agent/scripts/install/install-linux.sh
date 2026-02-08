#!/bin/bash
set -euo pipefail

BINARY="/usr/local/bin/breeze-agent"
SERVICE_SRC="$(dirname "$0")/../../service/systemd/breeze-agent.service"
SERVICE_DST="/etc/systemd/system/breeze-agent.service"
CONFIG_DIR="/etc/breeze"
DATA_DIR="/var/lib/breeze"
LOG_DIR="/var/log/breeze"

if [ "$(id -u)" -ne 0 ]; then
    echo "Error: must run as root (sudo $0)" >&2
    exit 1
fi

echo "Installing Breeze Agent..."

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

# Install systemd unit
if [ -f "$SERVICE_SRC" ]; then
    cp "$SERVICE_SRC" "$SERVICE_DST"
else
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    SERVICE_ALT="$SCRIPT_DIR/../../service/systemd/breeze-agent.service"
    if [ -f "$SERVICE_ALT" ]; then
        cp "$SERVICE_ALT" "$SERVICE_DST"
    else
        echo "Error: systemd unit file not found" >&2
        exit 1
    fi
fi
chmod 644 "$SERVICE_DST"

systemctl daemon-reload

# Install user helper systemd user unit
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
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

# Create breeze group for IPC socket access
if ! getent group breeze &>/dev/null; then
    groupadd --system breeze
    echo "Created 'breeze' group for IPC socket access."
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

systemctl daemon-reload

echo "Breeze Agent installed."
echo ""
echo "Next steps:"
echo "  1. Enroll:  sudo breeze-agent enroll <enrollment-key> --server https://your-server"
echo "  2. Enable:  sudo systemctl enable breeze-agent"
echo "  3. Start:   sudo systemctl start breeze-agent"
echo "  4. Status:  sudo systemctl status breeze-agent"
echo "  5. Logs:    journalctl -u breeze-agent -f"
echo "  6. User helper: systemctl --user enable breeze-agent-user (per-user)"
