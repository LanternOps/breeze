#!/usr/bin/env bash
# Verify that EVERY signable artifact shipped inside the Nodes Unlimited DMG is
# signed with a Developer ID, built with the hardened runtime, and notarized.
#
#   ./verify-dmg-signing.sh "dist/nu-agent/Nodes Unlimited Agent.dmg"
#
# This is a release gate, not a diagnostic: it exits non-zero on the first
# artifact that fails, so an unsigned or un-notarized payload can never reach a
# customer machine.
#
# It is deliberately RECURSIVE and discovery-based rather than driven by a
# hand-maintained list of binary names. Anything added to the payload later is
# covered automatically the day it is added — a name list would silently pass
# the new binary through, which is exactly how this class of bug ships.
#
# Set ALLOW_UNNOTARIZED=1 for local dev builds (notarization credentials only
# exist in CI). Signing and hardened-runtime checks still run.
set -euo pipefail

DMG="${1:-}"
if [[ -z "$DMG" || ! -f "$DMG" ]]; then
    echo "usage: $0 <path-to-dmg>" >&2
    exit 2
fi

ALLOW_UNNOTARIZED="${ALLOW_UNNOTARIZED:-0}"
FAILURES=0
CHECKED=0

fail() {
    echo "  FAIL: $*" >&2
    FAILURES=$((FAILURES + 1))
}

# ---------------------------------------------------------------------------
# The DMG itself
# ---------------------------------------------------------------------------
echo "==> verifying DMG container: $DMG"
codesign --verify --verbose=2 "$DMG" 2>&1 | sed 's/^/    /' || fail "DMG is not validly signed"

if [[ "$ALLOW_UNNOTARIZED" != "1" ]]; then
    xcrun stapler validate "$DMG" >/dev/null 2>&1 \
        || fail "DMG has no stapled notarization ticket"
    # A DMG is evaluated under the 'open' policy, not 'exec' — using -t exec here
    # reports a misleading failure on a perfectly good disk image.
    spctl -a -t open --context context:primary-signature -v "$DMG" 2>&1 | sed 's/^/    /' \
        || fail "DMG rejected by Gatekeeper"
fi

# ---------------------------------------------------------------------------
# Mount and walk the contents
# ---------------------------------------------------------------------------
MOUNT_DIR="$(mktemp -d)"
cleanup() {
    hdiutil detach "$MOUNT_DIR" -quiet -force 2>/dev/null || true
    rmdir "$MOUNT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> mounting"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT_DIR" -quiet

# Every Mach-O and every bundle, at any depth. `find -perm` is not enough:
# unsigned libraries are frequently non-executable, and they still need signing.
check_macho() {
    local path="$1"
    CHECKED=$((CHECKED + 1))
    echo "  - ${path#"$MOUNT_DIR"/}"

    if ! codesign --verify --strict --deep "$path" 2>/dev/null; then
        fail "not validly signed: ${path#"$MOUNT_DIR"/}"
        return
    fi

    local info
    info="$(codesign --display --verbose=4 "$path" 2>&1 || true)"

    grep -q 'Authority=Developer ID Application' <<<"$info" \
        || fail "not signed with a Developer ID Application cert: ${path#"$MOUNT_DIR"/}"

    # Hardened runtime is required for notarization. The runtime bit shows up in
    # the CodeDirectory flags.
    grep -Eq 'flags=.*runtime' <<<"$info" \
        || fail "hardened runtime not enabled: ${path#"$MOUNT_DIR"/}"

    grep -q 'Timestamp=' <<<"$info" \
        || fail "no secure timestamp: ${path#"$MOUNT_DIR"/}"
}

echo "==> walking bundles"
while IFS= read -r bundle; do
    check_macho "$bundle"
    if [[ "$ALLOW_UNNOTARIZED" != "1" ]]; then
        xcrun stapler validate "$bundle" >/dev/null 2>&1 \
            || fail "bundle has no stapled ticket: ${bundle#"$MOUNT_DIR"/}"
    fi
done < <(find "$MOUNT_DIR" \( -name '*.app' -o -name '*.framework' -o -name '*.xpc' \) -maxdepth 4 -print 2>/dev/null)

echo "==> walking loose Mach-O files"
while IFS= read -r f; do
    # `file` is the reliable discriminator; extensions are not.
    if file -b "$f" 2>/dev/null | grep -q 'Mach-O'; then
        check_macho "$f"
    fi
done < <(find "$MOUNT_DIR" -type f ! -path '*/.*' -print 2>/dev/null)

# ---------------------------------------------------------------------------
# Embedded .pkg payloads (the agent binaries ride inside these)
# ---------------------------------------------------------------------------
echo "==> checking embedded .pkg payloads"
while IFS= read -r pkg; do
    CHECKED=$((CHECKED + 1))
    echo "  - ${pkg#"$MOUNT_DIR"/}"
    # pkgutil --check-signature reports the cert chain; productsign uses a
    # "Developer ID Installer" cert, NOT the Application one.
    if ! pkgutil --check-signature "$pkg" 2>&1 | grep -q 'Developer ID Installer'; then
        fail "pkg not productsigned with a Developer ID Installer cert: ${pkg#"$MOUNT_DIR"/}"
    fi
    if [[ "$ALLOW_UNNOTARIZED" != "1" ]]; then
        xcrun stapler validate "$pkg" >/dev/null 2>&1 \
            || fail "pkg has no stapled ticket: ${pkg#"$MOUNT_DIR"/}"
    fi

    # A signed wrapper says nothing about what is INSIDE it. The agent binaries
    # and the bundled RustDesk.app live compressed in the payload, so without
    # expanding it they would pass this gate purely by being invisible to it —
    # which is not a check, it is a blind spot. Expand and verify the contents.
    EXPANDED="$(mktemp -d)"
    rmdir "$EXPANDED"
    if pkgutil --expand-full "$pkg" "$EXPANDED" >/dev/null 2>&1; then
        while IFS= read -r inner; do
            [[ -e "$inner" ]] || continue
            CHECKED=$((CHECKED + 1))
            iname="${inner#"$EXPANDED"/}"
            if ! codesign --verify --strict --deep "$inner" 2>/dev/null; then
                fail "payload artifact not validly signed: $iname (in ${pkg##*/})"
                continue
            fi
            iinfo="$(codesign --display --verbose=4 "$inner" 2>&1 || true)"
            grep -q 'Authority=Developer ID Application' <<<"$iinfo" \
                || fail "payload artifact not Developer ID signed: $iname (in ${pkg##*/})"
            grep -Eq 'flags=.*runtime' <<<"$iinfo" \
                || fail "payload artifact missing hardened runtime: $iname (in ${pkg##*/})"
        done < <(
            find "$EXPANDED" \( -name '*.app' -o -name '*.framework' \) -print 2>/dev/null
            find "$EXPANDED" -type f -print 2>/dev/null | while IFS= read -r f; do
                file -b "$f" 2>/dev/null | grep -q 'Mach-O' && echo "$f"
            done
        )
    else
        fail "could not expand pkg payload for inspection: ${pkg#"$MOUNT_DIR"/}"
    fi
    rm -rf "$EXPANDED"
done < <(find "$MOUNT_DIR" -name '*.pkg' -print 2>/dev/null)

# ---------------------------------------------------------------------------
echo
if (( CHECKED == 0 )); then
    echo "ERROR: nothing was checked — the DMG appears empty, which means this gate proved nothing." >&2
    exit 1
fi

if (( FAILURES > 0 )); then
    echo "SIGNING GATE FAILED: $FAILURES problem(s) across $CHECKED artifact(s)." >&2
    exit 1
fi

echo "SIGNING GATE PASSED: $CHECKED artifact(s) signed, hardened$( [[ "$ALLOW_UNNOTARIZED" == "1" ]] && echo "" || echo ", notarized and stapled" )."
