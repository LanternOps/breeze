#!/usr/bin/env bash
# Asserts a built breeze-recovery-linux-<arch>.iso is a real, bootable
# Breeze recovery image: El Torito hybrid boot, the live-boot payload
# files, and (inside the squashfs) breeze-backup plus the partitioning/
# filesystem/bootloader tools the rebuild engine needs. Run after
# build.sh; see plan Task 2 Step 1.
set -euo pipefail

iso="$1"
test -s "$iso"

# Arch comes from an optional second argument, else from the
# breeze-recovery-linux-<arch>.iso filename build.sh always produces. It
# selects the UEFI removable-media loader name checked below.
arch="${2:-}"
if [ -z "$arch" ]; then
  case "$(basename "$iso")" in
    *-amd64.iso) arch=amd64 ;;
    *-arm64.iso) arch=arm64 ;;
    *) echo "cannot infer arch from $iso; pass it as the second argument"; exit 1 ;;
  esac
fi
case "$arch" in
  amd64) efi_loader=bootx64.efi ;;
  arm64) efi_loader=bootaa64.efi ;;
  *) echo "unsupported arch: $arch"; exit 1 ;;
esac

xorriso -indev "$iso" -report_el_torito plain 2>/dev/null | grep -q "El Torito boot img" || { echo "not El Torito bootable"; exit 1; }

xorriso -indev "$iso" -find / -type f 2>/dev/null > /tmp/iso-files.txt
# live-build (bookworm) names the live payload's kernel/initrd with the
# installed kernel's version suffix (/live/vmlinuz-6.1.0-53-amd64), not the
# unversioned /live/vmlinuz some live-build configs symlink — confirmed by
# inspecting a real build. Match either form; the invariant that matters is
# "a kernel and an initrd exist under /live", not the exact filename.
grep -qE "^'/live/vmlinuz'\$|^'/live/vmlinuz-" /tmp/iso-files.txt || { echo "missing /live/vmlinuz*"; exit 1; }
grep -qE "^'/live/initrd\.img'\$|^'/live/initrd\.img-" /tmp/iso-files.txt || { echo "missing /live/initrd.img*"; exit 1; }
grep -qx "'/live/filesystem.squashfs'" /tmp/iso-files.txt || { echo "missing /live/filesystem.squashfs"; exit 1; }
# grub-efi's ISO9660 tree uses lowercase (EFI/boot/bootx64.efi,
# EFI/boot/bootaa64.efi), not the fallback-name case UEFI firmware itself
# accepts case-insensitively on the FAT ESP image — confirmed by inspecting
# real amd64 and arm64 builds.
grep -qixF "'/EFI/boot/$efi_loader'" /tmp/iso-files.txt || { echo "missing /EFI/boot/$efi_loader"; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
xorriso -osirrox on -indev "$iso" -extract /live/filesystem.squashfs "$tmp/fs.squashfs" 2>/dev/null
unsquashfs -l "$tmp/fs.squashfs" > "$tmp/list.txt"
# bookworm is usr-merged: /sbin and /bin are symlinks to their usr/
# counterparts, so the real files live under usr/sbin, usr/bin — confirmed
# by inspecting a real build's squashfs listing.
for f in usr/local/bin/breeze-backup etc/systemd/system/breeze-recovery.service usr/sbin/sgdisk usr/sbin/grub-install usr/bin/efibootmgr usr/sbin/mkfs.ext4 usr/sbin/mkfs.xfs usr/sbin/mkfs.vfat; do
  grep -q "squashfs-root/$f\$" "$tmp/list.txt" || { echo "squashfs missing $f"; exit 1; }
done

echo "ISO-OK $(sha256sum "$iso" | cut -c1-16)"
