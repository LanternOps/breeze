#!/usr/bin/env bash
# agent/installer/macos-app/build-app-bundle.sh
#
# Assembles the universal Nodes Unlimited Installer.app from the SPM-built
# executable and per-architecture .pkg payloads.
#
# Usage:
#   ./build-app-bundle.sh \
#     --pkg-amd64 /path/to/nu-agent-darwin-amd64.pkg \
#     --pkg-arm64 /path/to/nu-agent-darwin-arm64.pkg \
#     --output    /path/to/output/Nodes\ Unlimited\ Installer.app
#
# Optional:
#   SIGN_IDENTITY="Developer ID Application: BLOOMING BRANDS INC" ./build-app-bundle.sh ...
#
# Requires Swift 5.9+ toolchain and macOS 13+ SDK.
set -euo pipefail

PKG_AMD64=""
PKG_ARM64=""
OUTPUT=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --pkg-amd64) PKG_AMD64="$2"; shift 2 ;;
        --pkg-arm64) PKG_ARM64="$2"; shift 2 ;;
        --output)    OUTPUT="$2";    shift 2 ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$PKG_AMD64" || -z "$PKG_ARM64" || -z "$OUTPUT" ]]; then
    echo "Usage: $0 --pkg-amd64 PATH --pkg-arm64 PATH --output PATH" >&2
    exit 1
fi
for f in "$PKG_AMD64" "$PKG_ARM64"; do
    [[ -f "$f" ]] || { echo "Missing PKG: $f" >&2; exit 1; }
done

abspath() {
    local p="$1"
    if [[ "$p" = /* ]]; then
        printf '%s\n' "$p"
    else
        printf '%s/%s\n' "$(pwd)" "$p"
    fi
}
PKG_AMD64="$(abspath "$PKG_AMD64")"
PKG_ARM64="$(abspath "$PKG_ARM64")"
OUTPUT="$(abspath "$OUTPUT")"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "-> Building universal NUAgentInstaller binary..."
swift build -c release --arch arm64
swift build -c release --arch x86_64
ARM_BIN=".build/arm64-apple-macosx/release/NUAgentInstaller"
X86_BIN=".build/x86_64-apple-macosx/release/NUAgentInstaller"
[[ -f "$ARM_BIN" && -f "$X86_BIN" ]] || { echo "SPM build did not produce expected binaries" >&2; exit 1; }

UNIVERSAL_BIN="$(mktemp -d)/NUAgentInstaller"
lipo -create "$ARM_BIN" "$X86_BIN" -output "$UNIVERSAL_BIN"
file "$UNIVERSAL_BIN"

echo "-> Assembling .app bundle at $OUTPUT..."
rm -rf "$OUTPUT"
mkdir -p "$OUTPUT/Contents/MacOS"
mkdir -p "$OUTPUT/Contents/Resources"

cp "$UNIVERSAL_BIN" "$OUTPUT/Contents/MacOS/NUAgentInstaller"
chmod 755 "$OUTPUT/Contents/MacOS/NUAgentInstaller"

cp Resources/Info.plist "$OUTPUT/Contents/Info.plist"
if [[ -f Resources/AppIcon.icns ]]; then
    cp Resources/AppIcon.icns "$OUTPUT/Contents/Resources/AppIcon.icns"
fi

cp "$PKG_AMD64" "$OUTPUT/Contents/Resources/nu-agent-amd64.pkg"
cp "$PKG_ARM64" "$OUTPUT/Contents/Resources/nu-agent-arm64.pkg"

echo "-> .app bundle assembled:"
ls -la "$OUTPUT/Contents/"

SIGN_IDENTITY="${SIGN_IDENTITY:-}"
if [[ -n "$SIGN_IDENTITY" ]]; then
    echo "-> Signing .app with '$SIGN_IDENTITY'"
    codesign --force --options runtime --entitlements entitlements.plist \
      --sign "$SIGN_IDENTITY" --timestamp "$OUTPUT"
    codesign --verify --verbose "$OUTPUT"
else
    echo "WARNING: no SIGN_IDENTITY — .app is ad-hoc signed."
fi

echo "Done: $OUTPUT"
