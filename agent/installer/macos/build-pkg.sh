#!/bin/bash
# ============================================
# Breeze Agent macOS .pkg Builder
# ============================================
# Usage:
#   ./build-pkg.sh <agent-binary> <backup-binary> <version> <arch> <output-path>
#
# Example:
#   ./build-pkg.sh ./breeze-agent-darwin-amd64 ./breeze-backup-darwin-amd64 0.13.3 amd64 ./dist/breeze-agent-darwin-amd64.pkg
# ============================================

set -euo pipefail

AGENT_BIN="$1"
BACKUP_BIN="$2"
VERSION="$3"
ARCH="$4"
OUTPUT="$5"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Building Breeze Agent .pkg"
echo "  Agent:   $AGENT_BIN"
echo "  Backup:  $BACKUP_BIN"
echo "  Version: $VERSION"
echo "  Arch:    $ARCH"
echo "  Output:  $OUTPUT"
echo ""

# ----- Build payload root -----
# Mirror the on-disk layout the installer will create
PAYLOAD="$WORK_DIR/payload"
mkdir -p "$PAYLOAD/usr/local/bin"
mkdir -p "$PAYLOAD/Library/LaunchDaemons"
mkdir -p "$PAYLOAD/Library/LaunchAgents"

cp "$AGENT_BIN" "$PAYLOAD/usr/local/bin/breeze-agent"
chmod 755 "$PAYLOAD/usr/local/bin/breeze-agent"

# Install backup binary
cp "$BACKUP_BIN" "$PAYLOAD/usr/local/bin/breeze-backup"
chmod 755 "$PAYLOAD/usr/local/bin/breeze-backup"

cp "$SCRIPT_DIR/../../service/launchd/com.breeze.agent.plist" \
   "$PAYLOAD/Library/LaunchDaemons/com.breeze.agent.plist"

cp "$SCRIPT_DIR/../../service/launchd/com.breeze.agent-user.plist" \
   "$PAYLOAD/Library/LaunchAgents/com.breeze.agent-user.plist"

# ----- Prepare install scripts -----
SCRIPTS="$WORK_DIR/scripts"
mkdir -p "$SCRIPTS"
cp "$SCRIPT_DIR/preinstall" "$SCRIPTS/preinstall"
cp "$SCRIPT_DIR/postinstall" "$SCRIPTS/postinstall"
chmod 755 "$SCRIPTS/preinstall" "$SCRIPTS/postinstall"

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
