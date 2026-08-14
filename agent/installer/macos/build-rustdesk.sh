#!/usr/bin/env bash
# Stage the vendor's official RustDesk.app for inclusion in the NU Agent .pkg.
#
#   ./build-rustdesk.sh arm64
#   ./build-rustdesk.sh amd64
#   OUT_DIR=/tmp/x ./build-rustdesk.sh arm64   # writes $OUT_DIR/RustDesk.app
#
# Prints the staged bundle path on stdout (last line) so callers can capture it.
#
# ---------------------------------------------------------------------------
# WHY WE DOWNLOAD INSTEAD OF BUILD
# ---------------------------------------------------------------------------
# RustDesk is a Flutter application. Building it from source requires a full
# Xcode install, CocoaPods, and a from-source vcpkg tree — a multi-day job, and
# full Xcode is not present on the build machines. More importantly, a
# from-source build would be signed by US, which means WE would be asserting the
# trustworthiness of a remote-control binary. The vendor's official release is
# already signed with a Developer ID Application cert AND notarized by Apple, so
# taking it verbatim is both cheaper and a stronger provenance story.
#
# ---------------------------------------------------------------------------
# WHY THE VERSION IS PINNED
# ---------------------------------------------------------------------------
# Never track "latest". An installer that resolves its third-party payload at
# build time has no reproducible output and no way to notice that the upstream
# artifact changed underneath it — that is exactly the shape of a supply-chain
# compromise. The version AND its SHA-256 are pinned below; a mismatch is fatal.
#
# TO BUMP THE VERSION: change RUSTDESK_VERSION, then run this script once per
# arch with EXPECT_SHA256_OVERRIDE=print to have it print the observed digests,
# review the upstream release notes, and paste the digests in below. Do not
# copy a digest from anywhere but a download you performed yourself.
#
# ---------------------------------------------------------------------------
# ARCHITECTURE NOTE
# ---------------------------------------------------------------------------
# RustDesk does NOT need to be a universal binary. The Nodes Unlimited DMG ships
# "Nodes Unlimited Installer.app", which embeds BOTH nu-agent-amd64.pkg and
# nu-agent-arm64.pkg and selects one at runtime (Architecture.swift). The Intel
# pkg therefore carries Intel RustDesk and the ARM pkg carries ARM RustDesk, and
# the DMG as a whole stays universal. Upstream ships separate per-arch DMGs,
# which fits this exactly.
set -euo pipefail

# --------------------------------------------------------------------------
# PINNED UPSTREAM RELEASE — see "WHY THE VERSION IS PINNED" above.
# --------------------------------------------------------------------------
RUSTDESK_VERSION="1.4.9"

# SHA-256 of the official DMGs, verified 2026-08-14 against
# https://github.com/rustdesk/rustdesk/releases/tag/1.4.9
SHA256_arm64="f7935597b247d42c8f2a2ed71176a9f5868018cd9e1a33b8096418a668c8caf0"  # rustdesk-1.4.9-aarch64.dmg
SHA256_amd64="fa1129a0635019f9c5841937942cc2b08be028a192f47c009edde7e53812904e"  # rustdesk-1.4.9-x86_64.dmg

# The signing identity we REQUIRE the vendor artifact to carry. This must stay in
# lockstep with the assertion in verify-dmg-signing.sh, which requires every
# Mach-O in our DMG to be signed 'Developer ID Application'. If a future RustDesk
# release changes team or cert type, this check fails loudly — that is the point.
# Do NOT relax it, and do NOT re-sign the vendor bundle to make it pass:
# re-signing invalidates Apple's notarization ticket.
EXPECT_AUTHORITY="Developer ID Application"
EXPECT_TEAM_ID="HZF9JMC8YN"

RUSTDESK_BASE_URL="${RUSTDESK_BASE_URL:-https://github.com/rustdesk/rustdesk/releases/download}"

# --------------------------------------------------------------------------
ARCH="${1:-arm64}"
case "$ARCH" in
  arm64) UPSTREAM_ARCH="aarch64"; EXPECT_SHA256="$SHA256_arm64"; EXPECT_MACHO="arm64" ;;
  amd64) UPSTREAM_ARCH="x86_64";  EXPECT_SHA256="$SHA256_amd64"; EXPECT_MACHO="x86_64" ;;
  *) echo "usage: $0 [arm64|amd64]" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$HERE/../.." && pwd)"

# Both live under dist/, which is gitignored — the vendor binary must never be
# committed to the repo.
CACHE_DIR="${RUSTDESK_CACHE_DIR:-$AGENT_DIR/dist/rustdesk-cache}"
OUT_DIR="${OUT_DIR:-$AGENT_DIR/dist/rustdesk/$ARCH}"

DMG_NAME="rustdesk-$RUSTDESK_VERSION-$UPSTREAM_ARCH.dmg"
DMG_PATH="$CACHE_DIR/$DMG_NAME"
URL="$RUSTDESK_BASE_URL/$RUSTDESK_VERSION/$DMG_NAME"

die() { echo "ERROR: $*" >&2; exit 1; }
note() { echo "==> $*" >&2; }

need() { command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"; }
need curl; need shasum; need hdiutil; need ditto; need codesign; need spctl; need xcrun

# --------------------------------------------------------------------------
# 1. Fetch (cached)
# --------------------------------------------------------------------------
mkdir -p "$CACHE_DIR"

# The cache is keyed by version+arch, and every cached file is re-digested below
# on EVERY run — a poisoned or truncated cache entry cannot survive a build.
if [[ -f "$DMG_PATH" ]]; then
  note "cache hit: $DMG_PATH"
else
  note "downloading $URL"
  # Download to a temp name and move into place only after a clean transfer, so
  # an interrupted run never leaves a short file that looks like a cache hit.
  tmp_dmg="$DMG_PATH.partial.$$"
  if ! curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 30 -o "$tmp_dmg" "$URL"; then
    rm -f "$tmp_dmg"
    die "download failed: $URL"
  fi
  mv "$tmp_dmg" "$DMG_PATH"
fi

# --------------------------------------------------------------------------
# 2. Verify the digest BEFORE anything mounts or executes
# --------------------------------------------------------------------------
ACTUAL_SHA256="$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"

if [[ "${EXPECT_SHA256_OVERRIDE:-}" == "print" ]]; then
  echo "$ARCH ($DMG_NAME): $ACTUAL_SHA256"
  exit 0
fi

if [[ "$ACTUAL_SHA256" != "$EXPECT_SHA256" ]]; then
  # Do not delete the file — it is evidence. Tell the operator where it is.
  die "SHA-256 mismatch for $DMG_NAME
       expected: $EXPECT_SHA256
       actual:   $ACTUAL_SHA256
       file:     $DMG_PATH
     Either the pinned digest is stale (bump RUSTDESK_VERSION deliberately and
     re-pin) or this download was tampered with. Refusing to package an
     unverified third-party binary."
fi
note "sha256 OK ($ACTUAL_SHA256)"

# --------------------------------------------------------------------------
# 3. Verify the DMG's notarization ticket
# --------------------------------------------------------------------------
# Upstream staples the ticket to the DMG, not to the .app inside it. We check it
# here on the container, then staple it onto the extracted app ourselves in
# step 5 so the packaged bundle validates offline.
if ! xcrun stapler validate "$DMG_PATH" >/dev/null 2>&1; then
  die "vendor DMG has no stapled notarization ticket: $DMG_PATH
     Refusing to package an un-notarized third-party binary."
fi
note "vendor DMG notarization ticket OK"

# --------------------------------------------------------------------------
# 4. Extract
# --------------------------------------------------------------------------
MOUNT_DIR="$(mktemp -d)"
cleanup() {
  hdiutil detach "$MOUNT_DIR" -quiet -force 2>/dev/null || true
  rmdir "$MOUNT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

note "mounting $DMG_NAME"
hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_DIR" -quiet

SRC_APP="$MOUNT_DIR/RustDesk.app"
[[ -d "$SRC_APP" ]] || die "RustDesk.app not found in $DMG_NAME — upstream layout changed"

APP="$OUT_DIR/RustDesk.app"
rm -rf "$APP"
mkdir -p "$OUT_DIR"
# ditto, not cp: it preserves the bundle's resource forks, symlinks and
# permissions exactly. cp -R mangles framework version symlinks and breaks the
# seal, which shows up much later as an unexplained signature failure.
ditto "$SRC_APP" "$APP"
cleanup
trap - EXIT

# --------------------------------------------------------------------------
# 5. Staple the notarization ticket onto the extracted bundle
# --------------------------------------------------------------------------
# This ADDS a ticket resource; it does not re-sign and does not disturb the
# existing signature (re-verified immediately below). Without it, the bundle we
# ship would need a network round-trip to Apple to validate, and any
# stapler-based release gate would reject it.
note "stapling notarization ticket onto RustDesk.app"
xcrun stapler staple "$APP" >/dev/null 2>&1 \
  || die "could not staple the notarization ticket onto $APP"

# --------------------------------------------------------------------------
# 6. Verify the extracted, stapled bundle
# --------------------------------------------------------------------------
note "verifying signature"
codesign --verify --strict --deep "$APP" 2>&1 \
  || die "RustDesk.app failed 'codesign --verify --strict --deep'"

SIGINFO="$(codesign --display --verbose=4 "$APP" 2>&1 || true)"

grep -q "Authority=$EXPECT_AUTHORITY" <<<"$SIGINFO" \
  || die "RustDesk.app is not signed with a '$EXPECT_AUTHORITY' cert.
$(grep '^Authority=' <<<"$SIGINFO" || echo '  (no Authority lines at all)')
     Our release gate (verify-dmg-signing.sh) requires that cert type on every
     Mach-O in the DMG. Do NOT edit the gate and do NOT re-sign the vendor
     bundle — escalate the upstream change instead."

grep -q "TeamIdentifier=$EXPECT_TEAM_ID" <<<"$SIGINFO" \
  || die "RustDesk.app team identifier changed (expected $EXPECT_TEAM_ID).
$(grep '^TeamIdentifier=' <<<"$SIGINFO" || true)
     Treat a signing-team change on a remote-control binary as a supply-chain
     event until proven otherwise. Do not package it."

grep -Eq 'flags=.*runtime' <<<"$SIGINFO" \
  || die "RustDesk.app is not built with the hardened runtime"

grep -q 'Timestamp=' <<<"$SIGINFO" \
  || die "RustDesk.app signature has no secure timestamp"

grep -q "$EXPECT_MACHO" <<<"$(grep '^Format=' <<<"$SIGINFO")" \
  || die "RustDesk.app is not a $EXPECT_MACHO binary: $(grep '^Format=' <<<"$SIGINFO")"

note "verifying Gatekeeper acceptance"
spctl -a -t exec -vv "$APP" 2>&1 | sed 's/^/    /' >&2 \
  || die "RustDesk.app rejected by Gatekeeper (spctl -a -t exec)"

note "verifying stapled ticket"
xcrun stapler validate "$APP" >/dev/null 2>&1 \
  || die "RustDesk.app has no stapled notarization ticket after stapling"

# --------------------------------------------------------------------------
{
  echo
  echo "RustDesk $RUSTDESK_VERSION ($ARCH) staged and verified:"
  grep -E '^(Identifier|Format|TeamIdentifier|Timestamp)=' <<<"$SIGINFO" | sed 's/^/  /'
  grep '^Authority=' <<<"$SIGINFO" | sed 's/^/  /'
  echo
} >&2

echo "$APP"
