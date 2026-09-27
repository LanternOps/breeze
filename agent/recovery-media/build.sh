#!/usr/bin/env bash
# Builds breeze-recovery-linux-<arch>.iso: a Debian bookworm live-build
# image carrying the given breeze-backup binary and the breeze-recovery
# console service. See docs/superpowers/specs/backup/
# 2026-09-10-bare-metal-boot-media-recovery-design.md §7.1 and plan
# docs/superpowers/plans/backup/2026-09-10-bare-metal-w04b-linux-live-media-console-qemu.md
# Task 2.
#
# Usage: build.sh --arch amd64|arm64 --breeze-backup <path> --version <v> --out <dir>
#          [--server-url <https://...>] [--trust-pin <base64-sha256-spki>[,<pin2>,...]]
# Requires root (live-build's `lb build` does actual mounting/chrooting)
# and the live-build/debootstrap/squashfs-tools/xorriso/grub-efi toolchain
# on PATH. Produces <out>/breeze-recovery-linux-<arch>.iso and .sha256.
#
# --server-url and --trust-pin are optional. When supplied, they are baked
# into the image (/etc/breeze-recovery-server, /etc/breeze-recovery-trust-pin)
# and become the recovery console's TRUSTED server default and TLS
# certificate pin — see agent/internal/recoveryconsole/console.go's
# promptServer and agent/internal/backup/bmr/certpin.go. Without them, the
# built media behaves exactly as before: no baked default, no pinning, and
# the operator is prompted (a boot-cmdline breeze.server= value is offered
# only as an unverified, must-confirm suggestion). A self-hosted deployment
# building its own media should pass its own --server-url; a hosted build
# pipeline should pass the region's URL and, once the recovery signing
# infrastructure exists, its pin.
#
# --trust-pin should be the SPKI pin of the ISSUING (intermediate or root)
# CA certificate, not the leaf: certpin.go checks every certificate the
# server presents (leaf and any intermediates) against every configured
# pin, so an intermediate/root pin survives the server's next leaf
# rotation (a leaf-only pin breaks on every renewal, typically every
# 60-90 days on a Let's Encrypt-style setup). --trust-pin also accepts a
# comma-separated SET of pins, so a planned CA rotation can be covered by
# pinning both the outgoing and incoming intermediate at once.
set -euo pipefail

arch=""
breeze_backup=""
version=""
out=""
server_url=""
trust_pin=""

while [ $# -gt 0 ]; do
  case "$1" in
    --arch) arch="$2"; shift 2 ;;
    --breeze-backup) breeze_backup="$2"; shift 2 ;;
    --version) version="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --server-url) server_url="$2"; shift 2 ;;
    --trust-pin) trust_pin="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ -n "$server_url" ] && [ "${server_url#https://}" = "$server_url" ]; then
  echo "--server-url must start with https://: $server_url" >&2
  exit 1
fi

if [ -z "$arch" ] || [ -z "$breeze_backup" ] || [ -z "$version" ] || [ -z "$out" ]; then
  echo "usage: build.sh --arch amd64|arm64 --breeze-backup <path> --version <v> --out <dir>" >&2
  exit 1
fi
if [ ! -s "$breeze_backup" ]; then
  echo "breeze-backup binary not found or empty: $breeze_backup" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config_src="$script_dir/config"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -a "$config_src" "$work/config"

mkdir -p "$work/config/config/includes.chroot/usr/local/bin"
cp "$breeze_backup" "$work/config/config/includes.chroot/usr/local/bin/breeze-backup"
chmod 0755 "$work/config/config/includes.chroot/usr/local/bin/breeze-backup"
echo "$version" > "$work/config/config/includes.chroot/etc/breeze-recovery-version"

if [ -n "$server_url" ]; then
  printf '%s' "$server_url" > "$work/config/config/includes.chroot/etc/breeze-recovery-server"
fi
if [ -n "$trust_pin" ]; then
  printf '%s' "$trust_pin" > "$work/config/config/includes.chroot/etc/breeze-recovery-trust-pin"
fi

# The package list and --linux-flavours option are amd64-oriented by
# default (matches the base image); swap in the arm64 kernel/bootloader
# packages when cross-building that leg. Only one arch is ever built per
# invocation (the release workflow runs amd64 and arm64 as separate matrix
# jobs), so a straight substitution is enough — no runtime arch branching
# needed inside the chroot itself.
if [ "$arch" = "arm64" ]; then
  sed -i \
    -e 's/^linux-image-amd64$/linux-image-arm64/' \
    -e 's/^grub-efi-amd64-bin$/grub-efi-arm64-bin/' \
    "$work/config/config/package-lists/breeze.list.chroot"
fi

mkdir -p "$out"
out="$(cd "$out" && pwd)"

(
  cd "$work/config"
  export BREEZE_ARCH="$arch"
  lb clean --purge
  ./auto/config
  lb build
)

hybrid_iso=$(find "$work/config" -maxdepth 1 -name '*.hybrid.iso' -print -quit)
if [ -z "$hybrid_iso" ] || [ ! -s "$hybrid_iso" ]; then
  echo "live-build did not produce a .hybrid.iso" >&2
  exit 1
fi

dest="$out/breeze-recovery-linux-$arch.iso"
mv "$hybrid_iso" "$dest"
(cd "$out" && sha256sum "$(basename "$dest")" > "$(basename "$dest").sha256")

echo "built $dest ($(du -h "$dest" | cut -f1))"
