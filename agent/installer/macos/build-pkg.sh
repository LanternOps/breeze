#!/usr/bin/env bash
# Build the NU Agent macOS installer package.
#
# Upstream ships no macOS packaging — the Makefile only produces raw binaries and
# a Windows MSI; the .pkg and Installer.app come from LanternOps' private release
# pipeline. This is our replacement.
#
#   ./build-pkg.sh arm64
#   VERSION=0.104.0-nu2 SIGN_IDENTITY="NU Agent Signing" ./build-pkg.sh amd64
#
# Signing: pass SIGN_IDENTITY to sign with our self-signed identity. That does NOT
# make the package Apple-notarised — the user still gets the "unidentified
# developer" prompt and chooses to proceed. What it buys is a STABLE code-signing
# identity, so macOS keeps the TCC grants (Full Disk Access, Accessibility, Screen
# Recording) across agent self-updates. Ad-hoc signing re-randomises identity on
# every build and silently drops those grants, which would break remote control
# after the first update.
set -euo pipefail

ARCH="${1:-arm64}"
case "$ARCH" in
  arm64|amd64) ;;
  *) echo "usage: $0 [arm64|amd64]" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$HERE/../.." && pwd)"
VERSION="${VERSION:-0.104.0-nu1}"
IDENTIFIER="${IDENTIFIER:-com.nodesunlimited.agent}"
OUT_DIR="${OUT_DIR:-$AGENT_DIR/dist}"
SIGN_IDENTITY="${SIGN_IDENTITY:-}"
INSTALLER_SIGN_IDENTITY="${INSTALLER_SIGN_IDENTITY:-}"

BINARIES=(nu-agent nu-watchdog nu-desktop-helper nu-backup)

echo "==> building binaries ($ARCH, CGO off)"
cd "$AGENT_DIR"
for b in "${BINARIES[@]}"; do
  CGO_ENABLED=0 GOOS=darwin GOARCH="$ARCH" \
    go build -ldflags "-X main.version=$VERSION" -o "bin/$b-darwin-$ARCH" "./cmd/$b"
done

# Sign the binaries IN bin/ — not just the staging copies. build-dmg.sh ships
# bin/<name>-darwin-<arch> verbatim as the agent self-update / component
# download artifacts, so signing only the pkg staging copies left every
# published raw binary ad-hoc (and therefore un-notarizable).
# A Mach-O signature lives inside the file, so the later `install` into the pkg
# staging root carries it through.
if [[ -n "$SIGN_IDENTITY" ]]; then
  echo "==> signing binaries as '$SIGN_IDENTITY'"
  # --options runtime (hardened runtime) and a secure --timestamp are BOTH
  # mandatory for notarization. Do not weaken either. set -e makes any failure
  # here abort the build loudly.
  for b in "${BINARIES[@]}"; do
    codesign --force --options runtime --timestamp \
      --sign "$SIGN_IDENTITY" "bin/$b-darwin-$ARCH"
  done
else
  echo "==> WARNING: no SIGN_IDENTITY — binaries are ad-hoc signed." >&2
  echo "    macOS will drop TCC permissions on every agent update," >&2
  echo "    and notarization will reject these artifacts." >&2
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/root/usr/local/bin"

for b in "${BINARIES[@]}"; do
  install -m 0755 "bin/$b-darwin-$ARCH" "$STAGE/root/usr/local/bin/$b"
done

# Strip extended attributes LAST — after signing, never before. codesign writes
# its own xattrs, so stripping first accomplishes nothing.
#
# KNOWN COSMETIC ISSUE, do not burn time re-fixing it: the built pkg still
# contains AppleDouble "._name" siblings, which install into /usr/local/bin.
# They are inert metadata files, ignored by launchd and by the agent.
#
# The cause is com.apple.provenance (macOS 14+), which pkgbuild materialises as
# AppleDouble. It is PROTECTED — `xattr -c` cannot remove it — and macOS re-adds
# it to every newly created file, including a plain `cat >` copy. Verified
# 2026-08-13: strip-before-sign, strip-after-sign, and COPYFILE_DISABLE=1 on
# pkgbuild ALL still produce them. Eliminating them needs a payload root on a
# filesystem without xattr support (e.g. a purpose-built disk image), which is
# not worth it for inert files.
#
# Left in place, pkgbuild materialises them as AppleDouble "._name" siblings
# that ship inside the payload and land in /usr/local/bin on the customer's
# machine. Stripping before codesign does not work: codesign writes its own
# xattrs, so the "._" files come back. Safe to do after signing because a
# Mach-O signature lives INSIDE the binary, not in an extended attribute.
xattr -cr "$STAGE/root" 2>/dev/null || true

cp "$HERE/scripts/preinstall" "$HERE/scripts/postinstall" "$STAGE/scripts/" 2>/dev/null || {
  mkdir -p "$STAGE/scripts"
  cp "$HERE/scripts/preinstall" "$HERE/scripts/postinstall" "$STAGE/scripts/"
}
chmod +x "$STAGE/scripts/preinstall" "$STAGE/scripts/postinstall"

mkdir -p "$OUT_DIR"
PKG="$OUT_DIR/nu-agent-$ARCH.pkg"

echo "==> pkgbuild $PKG"
COPYFILE_DISABLE=1 COPYFILE_DISABLE=1 pkgbuild \
  --root "$STAGE/root" \
  --scripts "$STAGE/scripts" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --install-location / \
  "$PKG"

# productsign REQUIRES a "Developer ID Installer" certificate. Falling back to
# the Application identity here can only fail, so we do not fall back: if an
# installer identity was resolved we sign and any failure is fatal; if none was
# resolved we degrade gracefully (unsigned dev build) with a loud warning.
if [[ -n "$INSTALLER_SIGN_IDENTITY" ]]; then
  echo "==> productsign as '$INSTALLER_SIGN_IDENTITY'"
  if ! productsign --sign "$INSTALLER_SIGN_IDENTITY" "$PKG" "$PKG.signed"; then
    echo "ERROR: productsign failed with identity '$INSTALLER_SIGN_IDENTITY'." >&2
    echo "       The pkg would ship UNSIGNED and fail notarization. Aborting." >&2
    rm -f "$PKG.signed"
    exit 1
  fi
  mv "$PKG.signed" "$PKG"
  echo "==> package signed as '$INSTALLER_SIGN_IDENTITY'"
else
  echo "==> WARNING: no INSTALLER_SIGN_IDENTITY — .pkg is UNSIGNED." >&2
  echo "    This build is NOT notarization-ready (dev-only)." >&2
fi

echo
echo "built: $PKG"
pkgutil --payload-files "$PKG" | sed 's/^/  /'
