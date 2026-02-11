#!/bin/bash
set -euo pipefail

BINARY="/usr/local/bin/breeze-agent"
PLIST="/Library/LaunchDaemons/com.breeze.agent.plist"
USER_PLIST="/Library/LaunchAgents/com.breeze.agent-user.plist"

if [ "$(id -u)" -ne 0 ]; then
    echo "Error: must run as root (sudo $0)" >&2
    exit 1
fi

echo "Uninstalling Breeze Agent..."

# Stop the service
if launchctl list | grep -q com.breeze.agent; then
    launchctl unload "$PLIST" 2>/dev/null || true
    echo "Service stopped."
fi

# Remove plist
rm -f "$PLIST"

# Stop and remove user helper launch agent
if launchctl list | grep -q com.breeze.agent-user; then
    launchctl unload "$USER_PLIST" 2>/dev/null || true
fi
rm -f "$USER_PLIST"

# Remove binary
rm -f "$BINARY"

echo "Breeze Agent uninstalled."
echo "Config at /Library/Application Support/Breeze/ was preserved."
echo "To remove config: sudo rm -rf '/Library/Application Support/Breeze'"
