#!/bin/bash
set -euo pipefail

BINARY="/usr/local/bin/breeze-agent"
SERVICE="/etc/systemd/system/breeze-agent.service"

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

# Remove binary
rm -f "$BINARY"

echo "Breeze Agent uninstalled."
echo "Config at /etc/breeze/ was preserved."
echo "To remove config: sudo rm -rf /etc/breeze"
