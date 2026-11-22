#!/bin/bash
# ============================================
# Breeze Agent macOS .pkg Builder
# ============================================
# Usage:
#   ./build-pkg.sh <agent-binary> <desktop-helper-binary> <backup-binary> <watchdog-binary> <version> <arch> <output-path> <min-macos>
#
# <min-macos> is the minimum macOS this package installs on (#12169), e.g.
# "$(jq -r .macos agent/platform-floors.json)". It must match
# ^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$ and is rendered into the shipped preinstall.
# When omitted or empty, it is read from agent/platform-floors.json in this
# checkout: a self-hoster's signing repo copied from selfhost-signing-template
# before this argument existed still passes 7 arguments.
#
# Example:
#   ./build-pkg.sh ./breeze-agent-darwin-amd64 ./breeze-desktop-helper-darwin-amd64 ./breeze-backup-darwin-amd64 ./breeze-watchdog-darwin-amd64 0.13.3 amd64 ./dist/breeze-agent-darwin-amd64.pkg 12.0
# ============================================

set -euo pipefail

if [ "$#" -lt 7 ] || [ "$#" -gt 8 ]; then
    echo "usage: build-pkg.sh <agent-binary> <desktop-helper-binary> <backup-binary> <watchdog-binary> <version> <arch> <output-path> [<min-macos>]" >&2
    exit 64
fi

AGENT_BIN="$1"
DESKTOP_HELPER_BIN="$2"
BACKUP_BIN="$3"
WATCHDOG_BIN="$4"
VERSION="$5"
ARCH="$6"
OUTPUT="$7"
MIN_MACOS="${8:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLATFORM_FLOORS="$SCRIPT_DIR/../../platform-floors.json"
if [ -z "$MIN_MACOS" ]; then
    if [ ! -f "$PLATFORM_FLOORS" ]; then
        echo "build-pkg.sh: no <min-macos> argument and $PLATFORM_FLOORS is missing" >&2
        exit 64
    fi
    # No jq dependency: the file is a flat, checked-in JSON object.
    MIN_MACOS="$(sed -n 's/^[[:space:]]*"macos"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PLATFORM_FLOORS" | head -n 1)"
fi

# Validate before any work: a malformed floor must never reach a shipped pkg.
if ! [[ "$MIN_MACOS" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$ ]]; then
    echo "build-pkg.sh: <min-macos> '$MIN_MACOS' is malformed; expected e.g. 12.0 (^[0-9]{1,3}(\\.[0-9]{1,3}){0,2}\$)" >&2
    exit 64
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Building Breeze Agent .pkg"
echo "  Agent:    $AGENT_BIN"
echo "  Desktop:  $DESKTOP_HELPER_BIN"
echo "  Backup:   $BACKUP_BIN"
echo "  Watchdog: $WATCHDOG_BIN"
echo "  Version:  $VERSION"
echo "  Arch:     $ARCH"
echo "  Output:   $OUTPUT"
echo "  Min macOS: $MIN_MACOS"
echo ""

# ----- Build payload root -----
# The root-daemon binaries (agent, watchdog) and breeze-backup are STAGED in
# a root-only directory; postinstall copies them to /usr/local/bin or
# /Library/Breeze/bin per install-location.sh (#7211). Staging them straight
# into /usr/local/bin would write root binaries into a directory a non-root
# identity controls on exactly the hosts that need the trusted directory.
# The desktop helper is not relocated and still installs to /usr/local/bin.
PAYLOAD="$WORK_DIR/payload"
STAGING="$PAYLOAD/Library/Breeze/pkg-staging"
mkdir -p "$PAYLOAD/usr/local/bin"
mkdir -p "$STAGING"
mkdir -p "$PAYLOAD/Library/LaunchDaemons"
mkdir -p "$PAYLOAD/Library/LaunchAgents"

cp "$AGENT_BIN" "$STAGING/breeze-agent"
chmod 755 "$STAGING/breeze-agent"

cp "$DESKTOP_HELPER_BIN" "$PAYLOAD/usr/local/bin/breeze-desktop-helper"
chmod 755 "$PAYLOAD/usr/local/bin/breeze-desktop-helper"

# Backup binary (installed next to the agent; the agent resolves it there)
cp "$BACKUP_BIN" "$STAGING/breeze-backup"
chmod 755 "$STAGING/breeze-backup"

# Watchdog binary
cp "$WATCHDOG_BIN" "$STAGING/breeze-watchdog"
chmod 755 "$STAGING/breeze-watchdog"

cp "$SCRIPT_DIR/../../service/launchd/com.breeze.agent.plist" \
   "$PAYLOAD/Library/LaunchDaemons/com.breeze.agent.plist"

cp "$SCRIPT_DIR/../../service/launchd/com.breeze.desktop-helper-user.plist" \
   "$PAYLOAD/Library/LaunchAgents/com.breeze.desktop-helper-user.plist"

cp "$SCRIPT_DIR/../../service/launchd/com.breeze.desktop-helper-loginwindow.plist" \
   "$PAYLOAD/Library/LaunchAgents/com.breeze.desktop-helper-loginwindow.plist"

# Install watchdog launchd plist
cp "$SCRIPT_DIR/com.breeze.watchdog.plist" \
   "$PAYLOAD/Library/LaunchDaemons/com.breeze.watchdog.plist"

# ----- Prepare install scripts -----
SCRIPTS="$WORK_DIR/scripts"
mkdir -p "$SCRIPTS"
# Render the minimum-macOS floor into the shipped copy only (the source file
# keeps the literal placeholder). Plain s///, so BSD and GNU sed both work; the
# value is regex-validated above and contains only digits and dots.
sed "s/__BREEZE_MIN_MACOS__/$MIN_MACOS/g" "$SCRIPT_DIR/preinstall" > "$SCRIPTS/preinstall"
if grep -q '__BREEZE_MIN_MACOS__' "$SCRIPTS/preinstall"; then
    echo "build-pkg.sh: failed to render the macOS floor into preinstall" >&2
    exit 1
fi
# Sourced by preinstall from its own directory (the floor comparison).
cp "$SCRIPT_DIR/os-floor.sh" "$SCRIPTS/os-floor.sh"
cp "$SCRIPT_DIR/postinstall" "$SCRIPTS/postinstall"
# Sourced by postinstall from its own directory.
cp "$SCRIPT_DIR/install-location.sh" "$SCRIPTS/install-location.sh"
# Also sourced by postinstall: the breeze-group create/repair rule, shared with
# the daemon, which go:embeds the same file (#7829).
cp "$SCRIPT_DIR/../../internal/sessionbroker/ensure_ipc_group.sh" "$SCRIPTS/ensure_ipc_group.sh"
# The network-isolation recovery daemon's template (#10099). It travels with
# the scripts, not in the payload: launchd would load a payload LaunchDaemon at
# every boot. postinstall renders it only when a recovery binary was staged.
cp "$SCRIPT_DIR/../../service/launchd/com.breeze.isolation.plist" "$SCRIPTS/com.breeze.isolation.plist"
chmod 755 "$SCRIPTS/preinstall" "$SCRIPTS/postinstall"
chmod 644 "$SCRIPTS/os-floor.sh" "$SCRIPTS/install-location.sh" "$SCRIPTS/ensure_ipc_group.sh" "$SCRIPTS/com.breeze.isolation.plist"

# ----- Build component package -----
mkdir -p "$(dirname "$OUTPUT")"

pkgbuild \
    --root "$PAYLOAD" \
    --scripts "$SCRIPTS" \
    --identifier "com.breeze.agent" \
    --version "$VERSION" \
    --install-location "/" \
    "$OUTPUT"

echo ""
echo "Package built: $OUTPUT"
ls -lh "$OUTPUT"
