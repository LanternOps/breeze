#!/usr/bin/env bash
# agent/installer/macos-app/build-app-bundle.sh
#
# Assembles Breeze Installer.app from the SPM-built executable.
# Produces a universal (arm64 + x86_64) .app bundle.
#
# Usage:
#   ./build-app-bundle.sh \
#     --pkg-amd64 /path/to/breeze-agent-darwin-amd64.pkg \
#     --pkg-arm64 /path/to/breeze-agent-darwin-arm64.pkg \
#     --output    /path/to/output/Breeze\ Installer.app
#
# Requires Swift 5.9+ toolchain and macOS 13+ SDK (matches Package.swift target).
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

# Resolve to absolute paths BEFORE we `cd` — these args are typically
# relative to the original CWD (e.g. installer-pkgs/...) and would break
# after switching into the script directory.
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

echo "-> Building universal binary..."
swift build -c release --arch arm64
swift build -c release --arch x86_64
ARM_BIN=".build/arm64-apple-macosx/release/BreezeInstaller"
X86_BIN=".build/x86_64-apple-macosx/release/BreezeInstaller"
[[ -f "$ARM_BIN" && -f "$X86_BIN" ]] || { echo "SPM build did not produce expected binaries" >&2; exit 1; }

UNIVERSAL_BIN="$(mktemp -d)/BreezeInstaller"
lipo -create "$ARM_BIN" "$X86_BIN" -output "$UNIVERSAL_BIN"
file "$UNIVERSAL_BIN"

echo "-> Assembling .app bundle at $OUTPUT..."
rm -rf "$OUTPUT"
mkdir -p "$OUTPUT/Contents/MacOS"
mkdir -p "$OUTPUT/Contents/Resources"

cp "$UNIVERSAL_BIN" "$OUTPUT/Contents/MacOS/BreezeInstaller"
chmod 755 "$OUTPUT/Contents/MacOS/BreezeInstaller"

cp Resources/Info.plist "$OUTPUT/Contents/Info.plist"
if [[ -f Resources/AppIcon.icns ]]; then
    cp Resources/AppIcon.icns "$OUTPUT/Contents/Resources/AppIcon.icns"
fi

cp "$PKG_AMD64" "$OUTPUT/Contents/Resources/breeze-agent-amd64.pkg"
cp "$PKG_ARM64" "$OUTPUT/Contents/Resources/breeze-agent-arm64.pkg"

echo "-> .app bundle assembled:"
ls -la "$OUTPUT/Contents/"
echo "Done. Sign + notarize with the CI workflow or manually:"
echo "    codesign --force --options runtime --entitlements entitlements.plist \\"
echo "      --sign \"Developer ID Application: ...\" --timestamp \"$OUTPUT\""
