#!/bin/bash
set -euo pipefail

BINARY="/usr/local/bin/breeze-agent"
SERVICE="/etc/systemd/system/breeze-agent.service"
USER_SERVICE="/usr/lib/systemd/user/breeze-agent-user.service"
XDG_AUTOSTART="/etc/xdg/autostart/breeze-agent-user.desktop"
IPC_DIR="/var/run/breeze"

if [ "$(id -u)" -ne 0 ]; then
    echo "Error: must run as root (sudo $0)" >&2
    exit 1
fi

echo "Uninstalling Breeze Agent..."

# Stop and disable the service
if systemctl is-active --quiet breeze-agent 2>/dev/null; then
    systemctl stop breeze-agent
    echo "Service stopped."
fi
if systemctl is-enabled --quiet breeze-agent 2>/dev/null; then
    systemctl disable breeze-agent
fi

# Remove unit file
rm -f "$SERVICE"
systemctl daemon-reload

# Remove user-helper service definitions
rm -f "$USER_SERVICE"
rm -f "$XDG_AUTOSTART"

# Remove binary
rm -f "$BINARY"

# Remove IPC directory only when no other process is using it
rmdir "$IPC_DIR" 2>/dev/null || true

echo "Breeze Agent uninstalled."
echo "Config at /etc/breeze/ was preserved."
echo "To remove config: sudo rm -rf /etc/breeze"
