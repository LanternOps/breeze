#!/usr/bin/env bash
# Build a single signed, notarized, universal DMG for the Nodes Unlimited RMM
# macOS agent. One DMG installs on both Apple Silicon and Intel Macs.
#
# Usage (run on a Mac with Go, Swift, Xcode/CLI tools, and create-dmg):
#   ./build-dmg.sh
#   VERSION=0.104.0-nu2 SIGN_IDENTITY="Developer ID Application: ..." \
#     INSTALLER_SIGN_IDENTITY="Developer ID Installer: ..." ./build-dmg.sh
#
# Outputs:
#   dist/nu-agent/Nodes Unlimited Agent.dmg
#   dist/nu-agent/Nodes Unlimited Installer.app.zip
#
# If create-dmg is missing, install it: brew install create-dmg
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
MACOS_APP_DIR="$AGENT_DIR/installer/macos-app"
OUT="${NU_AGENT_ARTIFACT_DIR:-$AGENT_DIR/dist/nu-agent}"
VERSION="${NU_AGENT_VERSION:-0.104.0-nu1}"

SIGN_IDENTITY="${SIGN_IDENTITY:-}"
# NOTE: INSTALLER_SIGN_IDENTITY is deliberately NOT defaulted here. Defaulting it
# from SIGN_IDENTITY before the auto-discovery block below left it permanently
# empty, which silently disabled productsign and ad-hoc signed every payload
# binary. It is resolved after discovery instead. Env override still wins.
INSTALLER_SIGN_IDENTITY="${INSTALLER_SIGN_IDENTITY:-}"

APPLE_ID="${APPLE_ID:-}"
APPLE_PASSWORD="${APPLE_PASSWORD:-}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"

NOTARIZE="${NOTARIZE:-1}"
# Set to 1 only after notarization actually succeeds, so BUILD.txt reports
# reality rather than intent.
NOTARIZED=0

if ! command -v create-dmg >/dev/null 2>&1; then
    echo "ERROR: create-dmg not found. Install with: brew install create-dmg" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Identity discovery
# ---------------------------------------------------------------------------
if [[ -z "$SIGN_IDENTITY" ]]; then
    if security find-identity -v -p codesigning 2>/dev/null | grep -q 'Developer ID Application: BLOOMING BRANDS INC'; then
        SIGN_IDENTITY="Developer ID Application: BLOOMING BRANDS INC (2JSWDUQ64Z)"
        echo "==> auto-selected signing identity: $SIGN_IDENTITY"
    else
        echo "WARNING: no Developer ID Application identity found; ad-hoc signing." >&2
    fi
fi

# productsign needs a Developer ID *Installer* certificate — a different cert
# type from the Application one used for Mach-O/app signing.
if [[ -z "$INSTALLER_SIGN_IDENTITY" ]]; then
    if security find-identity -v 2>/dev/null | grep -q 'Developer ID Installer: BLOOMING BRANDS INC'; then
        INSTALLER_SIGN_IDENTITY="Developer ID Installer: BLOOMING BRANDS INC (2JSWDUQ64Z)"
        echo "==> auto-selected installer signing identity: $INSTALLER_SIGN_IDENTITY"
    else
        echo "WARNING: no Developer ID Installer identity found; .pkg will be unsigned." >&2
    fi
fi

mkdir -p "$OUT"

# ---------------------------------------------------------------------------
# Package-only mode
# ---------------------------------------------------------------------------
# CI already builds, signs, notarizes and staples "Nodes Unlimited Installer.app"
# in an earlier step. Re-running steps 1-3 there would rebuild the pkgs (needing
# the Go toolchain) and re-sign an already-notarized bundle, which strips the
# stapled ticket. Point NU_DMG_PREBUILT_APP at that bundle to skip straight to
# DMG assembly and keep this script the single source of truth for DMG layout.
PREBUILT_APP="${NU_DMG_PREBUILT_APP:-}"
if [[ -n "$PREBUILT_APP" ]]; then
    [[ -d "$PREBUILT_APP" ]] || { echo "ERROR: NU_DMG_PREBUILT_APP is not a directory: $PREBUILT_APP" >&2; exit 1; }
    APP_NAME="$(basename "$PREBUILT_APP")"
    APP_OUT="$PREBUILT_APP"
    echo "==> package-only mode: using prebuilt $APP_OUT"
fi

if [[ -z "$PREBUILT_APP" ]]; then

# ---------------------------------------------------------------------------
# 1. Build per-arch pkg installers
# ---------------------------------------------------------------------------
echo "==> building pkgs VERSION=$VERSION"
for arch in arm64 amd64; do
    (
        cd "$SCRIPT_DIR"
        # Application identity signs the payload binaries; Installer identity
        # signs the .pkg via productsign. They are NOT interchangeable.
        # RustDesk relay config is consumed by build-pkg.sh, which bakes it into
        # the postinstall. Forward it explicitly — the subshell does not inherit
        # what is not named here, and a silently dropped value ships an installer
        # that points RustDesk at the PUBLIC rustdesk.com relay instead of ours.
        VERSION="$VERSION" \
        SIGN_IDENTITY="$SIGN_IDENTITY" \
        INSTALLER_SIGN_IDENTITY="$INSTALLER_SIGN_IDENTITY" \
        NU_RUSTDESK_RELAY_HOST="${NU_RUSTDESK_RELAY_HOST:-}" \
        NU_RUSTDESK_PUBLIC_KEY="${NU_RUSTDESK_PUBLIC_KEY:-}" \
            ./build-pkg.sh "$arch"
    )
done

# ---------------------------------------------------------------------------
# 2. Assemble universal .app
# ---------------------------------------------------------------------------
APP_NAME="Nodes Unlimited Installer.app"
APP_OUT="$OUT/$APP_NAME"
echo "==> assembling universal .app"
(
    cd "$MACOS_APP_DIR"
    SIGN_IDENTITY="$SIGN_IDENTITY" ./build-app-bundle.sh \
        --pkg-amd64 "$AGENT_DIR/dist/nu-agent-amd64.pkg" \
        --pkg-arm64 "$AGENT_DIR/dist/nu-agent-arm64.pkg" \
        --output "$APP_OUT"
)

# ---------------------------------------------------------------------------
# 3. Zip the .app for upload / serving
# ---------------------------------------------------------------------------
ZIP_NAME="Nodes Unlimited Installer.app.zip"
ZIP_OUT="$OUT/$ZIP_NAME"
echo "==> zipping $APP_NAME"
(
    cd "$(dirname "$APP_OUT")"
    rm -f "$ZIP_OUT"
    zip -qry "$ZIP_OUT" "$APP_NAME"
)
ls -lh "$ZIP_OUT"
# ---------------------------------------------------------------------------
# 3b. Stage raw Darwin binaries for agent self-update / component downloads
# ---------------------------------------------------------------------------
echo "==> copying raw darwin binaries"
for bin in nu-agent nu-watchdog nu-desktop-helper nu-backup; do
    for arch in arm64 amd64; do
        src="$AGENT_DIR/bin/${bin}-darwin-${arch}"
        if [[ -f "$src" ]]; then
            cp "$src" "$OUT/"
        fi
    done
done

fi  # end of "not package-only mode"

# ---------------------------------------------------------------------------
# 4. Build DMG with create-dmg
# ---------------------------------------------------------------------------
DMG_NAME="Nodes Unlimited Agent.dmg"
DMG_OUT="$OUT/$DMG_NAME"
DMG_TMP="$(mktemp -d)"
trap 'rm -rf "$DMG_TMP"' EXIT

mkdir -p "$DMG_TMP/dmgroot"
cp -a "$APP_OUT" "$DMG_TMP/dmgroot/$APP_NAME"

# Window/icon layout is tuned to the 1280x760 background image.
# The DMG carries ONE icon — the installer — centered in the right (white) half at
# x=875, y=215. There is deliberately no --app-drop-link: no Applications folder
# alias and no drag arrow. The installer relocates itself into /Applications and
# relaunches on first run (InstallerApp.swift), which is what actually avoids
# Gatekeeper app translocation, so the drag step was never load-bearing.
create-dmg \
    --volname "Nodes Unlimited Agent" \
    --background "$SCRIPT_DIR/dmg-assets/background.png" \
    --window-size 1280 760 \
    --window-pos 200 120 \
    --icon-size 110 \
    --icon "$APP_NAME" 875 215 \
    --hide-extension "$APP_NAME" \
    --volicon "$MACOS_APP_DIR/Resources/AppIcon.icns" \
    --format UDZO \
    --overwrite \
    --no-internet-enable \
    "$DMG_OUT" \
    "$DMG_TMP/dmgroot"

# ---------------------------------------------------------------------------
# 5. Sign DMG
# ---------------------------------------------------------------------------
if [[ -n "$SIGN_IDENTITY" ]]; then
    echo "==> signing DMG"
    codesign --force --sign "$SIGN_IDENTITY" --timestamp "$DMG_OUT"
fi

# ---------------------------------------------------------------------------
# 6. Notarize + staple (optional but required for Gatekeeper on macOS 10.15+)
# ---------------------------------------------------------------------------
if [[ "$NOTARIZE" == "1" && -n "$APPLE_ID" && -n "$APPLE_PASSWORD" && -n "$APPLE_TEAM_ID" ]]; then
    echo "==> notarizing DMG"
    xcrun notarytool submit "$DMG_OUT" \
        --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" \
        --wait --timeout 30m --output-format json > "$OUT/notarization-dmg.json"
    if ! python3 -c "import json,sys; d=json.load(open('$OUT/notarization-dmg.json')); sys.exit(0 if d.get('status')=='Accepted' else 1)"; then
        echo "ERROR: DMG notarization failed" >&2
        cat "$OUT/notarization-dmg.json" >&2
        exit 1
    fi
    xcrun stapler staple "$DMG_OUT"

    # In package-only mode the .app arrives already notarized and stapled from an
    # earlier CI step, and no .app zip is produced here — nothing left to submit.
    if [[ -z "$PREBUILT_APP" ]]; then
        echo "==> notarizing .app zip"
        xcrun notarytool submit "$ZIP_OUT" \
            --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" \
            --wait --timeout 30m --output-format json > "$OUT/notarization-zip.json"
        if ! python3 -c "import json,sys; d=json.load(open('$OUT/notarization-zip.json')); sys.exit(0 if d.get('status')=='Accepted' else 1)"; then
            echo "ERROR: .app zip notarization failed" >&2
            cat "$OUT/notarization-zip.json" >&2
            exit 1
        fi
    fi
    NOTARIZED=1
else
    echo "==> skipping notarization (set APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID, NOTARIZE=1)"
fi

# ---------------------------------------------------------------------------
# 7. Build manifest
# ---------------------------------------------------------------------------
{
    echo "version=$VERSION"
    echo "built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "sign_identity=${SIGN_IDENTITY:-none}"
    echo "installer_sign_identity=${INSTALLER_SIGN_IDENTITY:-none}"
    echo "notarized=${NOTARIZED}"
} > "$OUT/BUILD.txt"

echo "==> artifacts"
ls -lh "$OUT/" | grep -E 'dmg|zip|pkg|BUILD'
echo "BUILD_OK $OUT"
