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

# ---------------------------------------------------------------------------
# RustDesk relay (NU self-hosted hbbs/hbbr on Titan01)
# ---------------------------------------------------------------------------
# The real values live in agent/installer/macos/.env, which is GITIGNORED.
# They are deliberately NOT hardcoded here: this repository is PUBLIC, and
# CLAUDE.md forbids committing IP addresses, server hostnames or internal infra
# mappings to it. Copy .env.example to .env and fill it in, or export the
# variables directly — an explicit export always wins over the file.
#
#   NU_RUSTDESK_RELAY_HOST  ONE variable for the relay host, no port. Today it
#                           is Titan01's public IP because Coolify env uses the
#                           IP; when DNS moves to a hostname, this is the single
#                           line that changes.
#   NU_RUSTDESK_ID_PORT     hbbs / rendezvous port (default 21116)
#   NU_RUSTDESK_RELAY_PORT  hbbr / relay port (default 21117)
#   NU_RUSTDESK_PUBLIC_KEY  the relay's Ed25519 PUBLIC key (id_ed25519.pub),
#                           base64. Safe to ship. NEVER reference the private
#                           id_ed25519.
#
# Firewall on the relay host must allow 21115-21119/tcp and 21116/udp.
RUSTDESK_ENV_FILE="${RUSTDESK_ENV_FILE:-$HERE/.env}"
if [[ -f "$RUSTDESK_ENV_FILE" ]]; then
  echo "==> loading RustDesk relay config from ${RUSTDESK_ENV_FILE/#$HERE/.}"
  # Existing exports take precedence over the file.
  _pre_host="${NU_RUSTDESK_RELAY_HOST:-}"; _pre_key="${NU_RUSTDESK_PUBLIC_KEY:-}"
  # shellcheck disable=SC1090
  set -a; source "$RUSTDESK_ENV_FILE"; set +a
  [[ -n "$_pre_host" ]] && NU_RUSTDESK_RELAY_HOST="$_pre_host"
  [[ -n "$_pre_key" ]] && NU_RUSTDESK_PUBLIC_KEY="$_pre_key"
fi

NU_RUSTDESK_RELAY_HOST="${NU_RUSTDESK_RELAY_HOST:-}"
NU_RUSTDESK_PUBLIC_KEY="${NU_RUSTDESK_PUBLIC_KEY:-}"
NU_RUSTDESK_ID_PORT="${NU_RUSTDESK_ID_PORT:-21116}"
NU_RUSTDESK_RELAY_PORT="${NU_RUSTDESK_RELAY_PORT:-21117}"

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

# ---------------------------------------------------------------------------
# RustDesk (vendor prebuilt) — staged INTO THE PAYLOAD, deliberately not signed
# ---------------------------------------------------------------------------
# build-rustdesk.sh downloads the vendor's official, already-signed and
# already-notarized RustDesk.app, verifies its pinned SHA-256, its Developer ID
# Application signature and its notarization ticket, and staples that ticket onto
# the extracted bundle. See that script for the full rationale.
#
# CRITICAL: RustDesk.app is NOT in BINARIES and must never be added to it. The
# loop above runs `codesign --force` — running that over a notarized third-party
# bundle would replace the vendor's signature with ours and invalidate the
# stapled ticket, turning a trusted binary into one Gatekeeper rejects. It ships
# with the vendor signature intact, exactly as downloaded.
#
# It goes into the payload root (rather than being installed by postinstall) so
# that it appears in the pkg's BOM / component plist. The uninstaller derives its
# removal list from the payload manifests instead of hardcoding names, so
# manifest membership is what makes RustDesk get cleaned up on uninstall.
if [[ "${SKIP_RUSTDESK:-0}" == "1" ]]; then
  echo "==> SKIP_RUSTDESK=1 — packaging WITHOUT RustDesk (remote access will not work)" >&2
else
  echo "==> staging RustDesk ($ARCH)"
  RUSTDESK_APP="$("$HERE/build-rustdesk.sh" "$ARCH")"
  [[ -d "$RUSTDESK_APP" ]] || { echo "ERROR: build-rustdesk.sh produced no bundle" >&2; exit 1; }
  mkdir -p "$STAGE/root/Applications"
  ditto "$RUSTDESK_APP" "$STAGE/root/Applications/RustDesk.app"
fi

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

# Re-verify the vendor bundle AFTER every staging step has touched the payload
# root. A code signature seals file contents and the bundle's resource layout, so
# any accidental copy/strip/permission change upstream of here shows up now — at
# build time — rather than as a Gatekeeper rejection on a customer's Mac.
if [[ -d "$STAGE/root/Applications/RustDesk.app" ]]; then
  echo "==> re-verifying RustDesk signature after staging"
  codesign --verify --strict --deep "$STAGE/root/Applications/RustDesk.app" \
    || { echo "ERROR: staging broke the RustDesk signature. Aborting." >&2; exit 1; }
  xcrun stapler validate "$STAGE/root/Applications/RustDesk.app" >/dev/null 2>&1 \
    || { echo "ERROR: RustDesk lost its stapled notarization ticket during staging. Aborting." >&2; exit 1; }
fi

cp "$HERE/scripts/preinstall" "$HERE/scripts/postinstall" "$STAGE/scripts/" 2>/dev/null || {
  mkdir -p "$STAGE/scripts"
  cp "$HERE/scripts/preinstall" "$HERE/scripts/postinstall" "$STAGE/scripts/"
}
chmod +x "$STAGE/scripts/preinstall" "$STAGE/scripts/postinstall"

# ---------------------------------------------------------------------------
# Bake the RustDesk deployment values into the postinstall script
# ---------------------------------------------------------------------------
# A .pkg postinstall runs under `installer` and inherits none of the build
# environment, so these have to be substituted here, at build time.
#
#   NU_RUSTDESK_RELAY_HOST  hostname (or host:port) of the NU hbbs/hbbr relay.
#   NU_RUSTDESK_PUBLIC_KEY  that relay's Ed25519 PUBLIC key, base64 (the
#                           `id_ed25519.pub` hbbs generates in its data dir).
#
# Left unset, the placeholders survive into the shipped script and postinstall
# logs a loud warning instead of configuring RustDesk — RustDesk then falls back
# to the PUBLIC rustdesk.com relay. That is a deliberate fail-visible default:
# guessing a relay host would be worse than not setting one.
subst_placeholder() {
  # sed with | as the delimiter: base64 and hostnames never contain it.
  # & and \ are the only replacement-side metacharacters that matter.
  local escaped
  escaped="$(printf '%s' "$2" | sed -e 's/[\\&|]/\\&/g')"
  sed -i '' -e "s|__$1__|$escaped|g" "$STAGE/scripts/postinstall"
}

if [[ -n "$NU_RUSTDESK_RELAY_HOST" && -n "$NU_RUSTDESK_PUBLIC_KEY" ]]; then
  # RustDesk 1.4.9 resolves both of these through check_port(), which appends a
  # default port when none is given. We write host:port explicitly on both so the
  # shipped config is unambiguous and greppable on a customer machine, and so a
  # future non-default port needs no code change.
  #
  # Key names verified against the pinned 1.4.9 binary (all three appear as
  # option keys in liblibrustdesk.dylib): custom-rendezvous-server, relay-server,
  # key. api-server is deliberately left unset — the rustdesk-api domain is not
  # published, and a wrong value there breaks the client's address book.
  echo "==> baking RustDesk relay config (host: $NU_RUSTDESK_RELAY_HOST)"
  subst_placeholder NU_RUSTDESK_RENDEZVOUS "$NU_RUSTDESK_RELAY_HOST:$NU_RUSTDESK_ID_PORT"
  subst_placeholder NU_RUSTDESK_RELAY "$NU_RUSTDESK_RELAY_HOST:$NU_RUSTDESK_RELAY_PORT"
  subst_placeholder NU_RUSTDESK_PUBLIC_KEY "$NU_RUSTDESK_PUBLIC_KEY"
elif [[ -n "$NU_RUSTDESK_RELAY_HOST" || -n "$NU_RUSTDESK_PUBLIC_KEY" ]]; then
  # Half-configured is worse than unconfigured: a relay host with no key means
  # RustDesk connects to our relay with authentication disabled.
  echo "ERROR: NU_RUSTDESK_RELAY_HOST and NU_RUSTDESK_PUBLIC_KEY must be set together." >&2
  exit 1
elif [[ "${SKIP_RUSTDESK:-0}" != "1" ]]; then
  echo "==> WARNING: NU_RUSTDESK_RELAY_HOST / NU_RUSTDESK_PUBLIC_KEY not set." >&2
  echo "    RustDesk ships UNCONFIGURED and will use the PUBLIC rustdesk.com relay." >&2
fi

mkdir -p "$OUT_DIR"
PKG="$OUT_DIR/nu-agent-$ARCH.pkg"

# A payload containing an .app bundle needs an explicit component plist.
# pkgbuild's default for a discovered bundle is BundleIsRelocatable=true, which
# tells the installer to look up the bundle id (com.carriez.rustdesk) in
# Launch Services and write to WHEREVER a copy already lives — a user's
# ~/Downloads, an external volume, anywhere. That would put our managed RustDesk
# at an unpredictable path, defeat the postinstall config write, and leave the
# uninstaller unable to find it. Pin it to /Applications.
COMPONENT_PLIST=""
if [[ -d "$STAGE/root/Applications/RustDesk.app" ]]; then
  COMPONENT_PLIST="$STAGE/component.plist"
  pkgbuild --analyze --root "$STAGE/root" "$COMPONENT_PLIST" >/dev/null

  # Walk the top-level entries by index rather than assuming a count: RustDesk
  # ships ~19 nested framework bundles today and upstream adds and drops them
  # between releases, so anything that hardcodes a number will break on a bump.
  # Nested ChildBundles inherit the parent's placement, so only the top level
  # needs the flags.
  idx=0
  while plutil -extract "$idx.RootRelativeBundlePath" raw -o - "$COMPONENT_PLIST" >/dev/null 2>&1; do
    plutil -replace "$idx.BundleIsRelocatable" -bool NO "$COMPONENT_PLIST"
    plutil -replace "$idx.BundleIsVersionChecked" -bool NO "$COMPONENT_PLIST"
    idx=$((idx + 1))
  done
  if (( idx == 0 )); then
    echo "ERROR: pkgbuild --analyze found no bundles, but RustDesk.app is staged." >&2
    exit 1
  fi
  echo "==> pinned $idx bundle(s) to their payload path (BundleIsRelocatable=NO)"
fi

echo "==> pkgbuild $PKG"
COPYFILE_DISABLE=1 COPYFILE_DISABLE=1 pkgbuild \
  --root "$STAGE/root" \
  --scripts "$STAGE/scripts" \
  ${COMPONENT_PLIST:+--component-plist "$COMPONENT_PLIST"} \
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
