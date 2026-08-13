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

BINARIES=(nu-agent nu-watchdog nu-desktop-helper nu-backup)

echo "==> building binaries ($ARCH, CGO off)"
cd "$AGENT_DIR"
for b in "${BINARIES[@]}"; do
  CGO_ENABLED=0 GOOS=darwin GOARCH="$ARCH" \
    go build -ldflags "-X main.version=$VERSION" -o "bin/$b-darwin-$ARCH" "./cmd/$b"
done

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/root/usr/local/bin"

for b in "${BINARIES[@]}"; do
  install -m 0755 "bin/$b-darwin-$ARCH" "$STAGE/root/usr/local/bin/$b"
done

# Strip extended attributes (quarantine, provenance, resource forks). Left in
# place, pkgbuild materialises them as AppleDouble "._name" siblings that ship
# inside the payload and land in /usr/local/bin on the customer's machine.
xattr -cr "$STAGE/root" 2>/dev/null || true

if [[ -n "$SIGN_IDENTITY" ]]; then
  echo "==> signing binaries as '$SIGN_IDENTITY'"
  for b in "${BINARIES[@]}"; do
    codesign --force --options runtime --timestamp=none \
      --sign "$SIGN_IDENTITY" "$STAGE/root/usr/local/bin/$b"
  done
else
  echo "==> WARNING: no SIGN_IDENTITY — binaries are ad-hoc signed."
  echo "    macOS will drop TCC permissions on every agent update."
fi

cp "$HERE/scripts/preinstall" "$HERE/scripts/postinstall" "$STAGE/scripts/" 2>/dev/null || {
  mkdir -p "$STAGE/scripts"
  cp "$HERE/scripts/preinstall" "$HERE/scripts/postinstall" "$STAGE/scripts/"
}
chmod +x "$STAGE/scripts/preinstall" "$STAGE/scripts/postinstall"

mkdir -p "$OUT_DIR"
PKG="$OUT_DIR/nu-agent-$ARCH.pkg"

echo "==> pkgbuild $PKG"
pkgbuild \
  --root "$STAGE/root" \
  --scripts "$STAGE/scripts" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --install-location / \
  "$PKG"

if [[ -n "$SIGN_IDENTITY" ]]; then
  INSTALLER_IDENTITY="${INSTALLER_SIGN_IDENTITY:-$SIGN_IDENTITY}"
  if productsign --sign "$INSTALLER_IDENTITY" "$PKG" "$PKG.signed" 2>/dev/null; then
    mv "$PKG.signed" "$PKG"
    echo "==> package signed as '$INSTALLER_IDENTITY'"
  else
    echo "==> note: productsign skipped (needs an installer-type identity); payload is still signed"
  fi
fi

echo
echo "built: $PKG"
pkgutil --payload-files "$PKG" | sed 's/^/  /'
