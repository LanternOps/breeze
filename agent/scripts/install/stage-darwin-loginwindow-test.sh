#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

HELPER_SRC_DEFAULT="/tmp/breeze-desktop-helper"
HELPER_DST="/usr/local/bin/breeze-desktop-helper"
USER_PLIST_SRC="$AGENT_DIR/service/launchd/com.breeze.desktop-helper-user.plist"
USER_PLIST_DST="/Library/LaunchAgents/com.breeze.desktop-helper-user.plist"
LOGIN_PLIST_SRC="$AGENT_DIR/service/launchd/com.breeze.desktop-helper-loginwindow.plist"
LOGIN_PLIST_DST="/Library/LaunchAgents/com.breeze.desktop-helper-loginwindow.plist"
LOG_DIR="/Library/Logs/Breeze"

BUILD_HELPER=1
BOOTSTRAP_USER_HELPER=1
HELPER_SRC=""

usage() {
    cat <<EOF
Usage: sudo $0 [--helper-src /path/to/breeze-desktop-helper] [--skip-build] [--skip-bootstrap-user]

Stages the dedicated macOS desktop helper and LaunchAgents for login-window testing.

Options:
  --helper-src PATH        Use an existing helper binary instead of building to /tmp.
  --skip-build             Do not run 'go build' when --helper-src is not provided.
  --skip-bootstrap-user    Install the Aqua LaunchAgent but do not bootstrap it for the current console user.
  -h, --help               Show this help text.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --helper-src)
            HELPER_SRC="${2:-}"
            shift 2
            ;;
        --skip-build)
            BUILD_HELPER=0
            shift
            ;;
        --skip-bootstrap-user)
            BOOTSTRAP_USER_HELPER=0
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if [ "$(id -u)" -ne 0 ]; then
    echo "Error: must run as root (sudo $0)" >&2
    exit 1
fi

if [ ! -f "$USER_PLIST_SRC" ] || [ ! -f "$LOGIN_PLIST_SRC" ]; then
    echo "Error: expected launchd plists were not found under $AGENT_DIR/service/launchd" >&2
    exit 1
fi

if [ -z "$HELPER_SRC" ]; then
    HELPER_SRC="$HELPER_SRC_DEFAULT"
    if [ "$BUILD_HELPER" -eq 1 ]; then
        echo "Building breeze-desktop-helper to $HELPER_SRC ..."
        (
            cd "$AGENT_DIR"
            go build -o "$HELPER_SRC" ./cmd/breeze-desktop-helper
        )
    fi
fi

if [ ! -x "$HELPER_SRC" ]; then
    echo "Error: helper binary not found or not executable at $HELPER_SRC" >&2
    exit 1
fi

echo "Installing desktop helper binary ..."
cp "$HELPER_SRC" "$HELPER_DST"
chown root:wheel "$HELPER_DST"
chmod 755 "$HELPER_DST"

mkdir -p "$LOG_DIR"
chown root:wheel "$LOG_DIR"
chmod 755 "$LOG_DIR"

echo "Installing LaunchAgents ..."
cp "$USER_PLIST_SRC" "$USER_PLIST_DST"
cp "$LOGIN_PLIST_SRC" "$LOGIN_PLIST_DST"
chown root:wheel "$USER_PLIST_DST" "$LOGIN_PLIST_DST"
chmod 644 "$USER_PLIST_DST" "$LOGIN_PLIST_DST"

echo "Validating LaunchAgents ..."
plutil -lint "$USER_PLIST_DST"
plutil -lint "$LOGIN_PLIST_DST"

CONSOLE_USER="$(stat -f '%Su' /dev/console 2>/dev/null || true)"
CONSOLE_UID=""
if [ -n "$CONSOLE_USER" ] && [ "$CONSOLE_USER" != "root" ] && [ "$CONSOLE_USER" != "loginwindow" ]; then
    CONSOLE_UID="$(id -u "$CONSOLE_USER" 2>/dev/null || true)"
fi

if [ "$BOOTSTRAP_USER_HELPER" -eq 1 ] && [ -n "$CONSOLE_UID" ]; then
    echo "Bootstrapping Aqua helper for console user $CONSOLE_USER (uid $CONSOLE_UID) ..."
    launchctl bootout "gui/$CONSOLE_UID/com.breeze.desktop-helper-user" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$CONSOLE_UID" "$USER_PLIST_DST" || true
    launchctl kickstart -k "gui/$CONSOLE_UID/com.breeze.desktop-helper-user" || true
else
    echo "Skipping Aqua helper bootstrap."
fi

cat <<EOF

Desktop helper staging complete.

Installed:
  Binary:      $HELPER_DST
  Aqua plist:  $USER_PLIST_DST
  Login plist: $LOGIN_PLIST_DST

Current console user:
  Username:    ${CONSOLE_USER:-unknown}
  UID:         ${CONSOLE_UID:-unknown}

Suggested checks now:
  1. tail -f /Library/Logs/Breeze/desktop-helper.log
  2. launchctl print gui/${CONSOLE_UID:-<uid>}/com.breeze.desktop-helper-user
  3. /usr/local/bin/breeze-desktop-helper probe --context user_session
  4. /usr/local/bin/breeze-desktop-helper probe --context login_window

For the real login-window test, log out or reboot this Mac and then inspect:
  - /Library/Logs/Breeze/desktop-helper.log
  - /tmp/breeze-desktop-helper-loginwindow.log
  - Breeze device desktopAccess state
EOF
