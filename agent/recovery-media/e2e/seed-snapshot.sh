#!/usr/bin/env bash
# Seeds a whole-machine file snapshot the QEMU recovery-media end-to-end
# proof (W04b Task 4) can rebuild: mmdebstrap builds a small, real, bootable
# Debian bookworm root; `breeze-backup snapshot-dir` (agent/cmd/breeze-backup/
# snapshot_dir_cmd.go — test-support only) walks it into a snapshot manifest
# + content store; this script writes the matching layout.json by hand (a
# synthetic single-disk UEFI layout describing the QEMU target image's
# geometry, which has nothing to do with the seed root's own filesystem).
#
# Usage: seed-snapshot.sh <store-dir>
# Requires root (mmdebstrap installs packages via a real chroot) and
# mmdebstrap on PATH. Needs a linux/amd64 `breeze-backup` binary; builds one
# with `go build` if BREEZE_BACKUP_BIN is not set.
#
# Produces <store-dir>/snapshots/e2e-1/{manifest.json,layout.json,files/...}.
set -euo pipefail

store_dir="${1:?usage: seed-snapshot.sh <store-dir>}"
snapshot_id="e2e-1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="$(cd "$script_dir/../.." && pwd)"

mkdir -p "$store_dir"
store_dir="$(cd "$store_dir" && pwd)"

seed_root="$(mktemp -d)"
trap 'rm -rf "$seed_root"' EXIT

echo "seed-snapshot: mmdebstrap building seed root at $seed_root"
mmdebstrap \
  --variant=minbase \
  --include=linux-image-amd64,systemd-sysv,grub-efi-amd64,initramfs-tools,e2fsprogs,dosfstools,util-linux,ifupdown,isc-dhcp-client \
  bookworm "$seed_root" http://deb.debian.org/debian

echo "e2e-restored-src" > "$seed_root/etc/hostname"

cat > "$seed_root/etc/fstab" <<'FSTAB'
# Written by agent/recovery-media/e2e/seed-snapshot.sh for the QEMU e2e
# proof. The rebuild engine generates fresh filesystem UUIDs at mkfs time
# (an empty FSUUID in layout.json is a supported, non-fatal case — see
# rebuild/plan.go's validateFSUUID) — device paths are stable and simpler
# here since the only disk QEMU ever attaches this image as is /dev/vda.
/dev/vda2 / ext4 errors=remount-ro 0 1
/dev/vda1 /boot/efi vfat umask=0077 0 1
FSTAB

# No password for root — this is a disposable e2e fixture booted only
# inside an isolated QEMU guest; getty on the serial console (ttyS0) is
# what run-qemu.sh's second-boot assertion waits for ("login:" banner).
sed -i 's/^root:[^:]*:/root::/' "$seed_root/etc/shadow" 2>/dev/null || true
chroot "$seed_root" systemctl enable serial-getty@ttyS0.service >/dev/null 2>&1 || \
  ln -sf /lib/systemd/system/serial-getty@.service \
    "$seed_root/etc/systemd/system/getty.target.wants/serial-getty@ttyS0.service"

breeze_backup_bin="${BREEZE_BACKUP_BIN:-}"
if [ -z "$breeze_backup_bin" ]; then
  breeze_backup_bin="$(mktemp -d)/breeze-backup-linux-amd64"
  echo "seed-snapshot: building breeze-backup (linux/amd64) at $breeze_backup_bin"
  (cd "$agent_dir" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o "$breeze_backup_bin" ./cmd/breeze-backup)
fi

echo "seed-snapshot: walking seed root into $store_dir/snapshots/$snapshot_id"
"$breeze_backup_bin" snapshot-dir \
  --root "$seed_root" \
  --out "$store_dir" \
  --snapshot-id "$snapshot_id" \
  --exclude proc --exclude sys --exclude dev --exclude run --exclude tmp

# Synthetic single-disk UEFI layout matching target.img's geometry
# (8 GiB, created by run-qemu.sh). FSUUID is deliberately empty on both
# partitions — the engine mkfs's fresh ones (a supported, warning-only
# case) and /etc/fstab above references /dev/vda1 / /dev/vda2 directly
# rather than depending on them resolving.
layout_path="$store_dir/snapshots/$snapshot_id/layout.json"
cat > "$layout_path" <<JSON
{
  "schemaVersion": 1,
  "collectedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platform": "linux",
  "osRelease": "Debian GNU/Linux 12 (bookworm)",
  "hostname": "e2e-restored-src",
  "bootMode": "uefi",
  "disks": [
    {
      "name": "/dev/vda",
      "model": "QEMU HARDDISK",
      "serial": "",
      "sizeBytes": 8589934592,
      "sectorSize": 512,
      "tableType": "gpt",
      "removable": false,
      "isSystem": true,
      "partitions": [
        {
          "number": 1,
          "name": "EFI",
          "typeGuid": "c12a7328-f81f-11d2-ba4b-00a0c93ec93b",
          "startBytes": 1048576,
          "sizeBytes": 536870912,
          "filesystem": "vfat",
          "fsUuid": "",
          "label": "EFI",
          "mountPoint": "/boot/efi",
          "encryption": "none",
          "role": "efi"
        },
        {
          "number": 2,
          "name": "root",
          "typeGuid": "0fc63daf-8483-4772-8e79-3d69d8477de4",
          "startBytes": 537919488,
          "sizeBytes": 8046311424,
          "filesystem": "ext4",
          "fsUuid": "",
          "label": "root",
          "mountPoint": "/",
          "encryption": "none",
          "role": "root"
        }
      ]
    }
  ],
  "fstab": "/dev/vda2 / ext4 errors=remount-ro 0 1\n/dev/vda1 /boot/efi vfat umask=0077 0 1\n"
}
JSON

OUT="$store_dir"

# e2e-2: one changed file (uploaded fresh under e2e-2), everything else
# references e2e-1 verbatim (backupPath unchanged from e2e-1's manifest).
# snapshot-dir has no diffing/"--only-changed" mode (it emits one full
# manifest per invocation) — hand-write e2e-2/manifest.json instead
# (simpler and matches how layout.json is already hand-written by this
# script): copy e2e-1/manifest.json, change "id" to "e2e-2", and for
# exactly one file entry (etc/debian_version — base-files guarantees this
# file in an mmdebstrap minbase chroot, unlike /etc/motd) recompute its
# backupPath under snapshots/e2e-2/files/<sha256 of sourcePath> and
# re-upload that one file's bytes to that key; every other file entry's
# backupPath stays "snapshots/e2e-1/files/...".
python3 - "$OUT" <<'PYEOF'
import json, hashlib, os, sys, shutil

out = sys.argv[1]
with open(f"{out}/snapshots/e2e-1/manifest.json") as f:
    gen1 = json.load(f)

gen2 = json.loads(json.dumps(gen1))
gen2["id"] = "e2e-2"
for entry in gen2["files"]:
    if entry.get("sourcePath") == "/etc/debian_version":
        key = "snapshots/e2e-2/files/" + hashlib.sha256(entry["sourcePath"].encode()).hexdigest()
        entry["backupPath"] = key
        os.makedirs(os.path.dirname(f"{out}/{key}"), exist_ok=True)
        with open(f"{out}/{key}", "wb") as fh:
            fh.write(b"e2e-2-changed-debian-version\n")
        break
else:
    raise SystemExit("expected /etc/debian_version in the e2e-1 manifest to mark as changed in e2e-2")

os.makedirs(f"{out}/snapshots/e2e-2", exist_ok=True)
with open(f"{out}/snapshots/e2e-2/manifest.json", "w") as f:
    json.dump(gen2, f, indent=2)
# The console refuses without a captured disk layout ("no disk layout was
# captured for snapshot ..."), so every generation carries the same
# synthetic layout.json as e2e-1 (a hard copy, not optional).
shutil.copy(f"{out}/snapshots/e2e-1/layout.json", f"{out}/snapshots/e2e-2/layout.json")
PYEOF

# e2e-3: references into BOTH e2e-1 (unchanged files) and e2e-2 (the
# changed /etc/debian_version), plus its own newly changed file (/etc/hostname).
python3 - "$OUT" <<'PYEOF'
import json, hashlib, os, sys, shutil

out = sys.argv[1]
with open(f"{out}/snapshots/e2e-2/manifest.json") as f:
    gen2 = json.load(f)

gen3 = json.loads(json.dumps(gen2))
gen3["id"] = "e2e-3"
for entry in gen3["files"]:
    if entry.get("sourcePath") == "/etc/hostname":
        key = "snapshots/e2e-3/files/" + hashlib.sha256(entry["sourcePath"].encode()).hexdigest()
        entry["backupPath"] = key
        os.makedirs(os.path.dirname(f"{out}/{key}"), exist_ok=True)
        with open(f"{out}/{key}", "wb") as fh:
            fh.write(b"e2e-3-changed-hostname\n")
        break
else:
    raise SystemExit("expected /etc/hostname in the manifest to mark as changed in e2e-3")

os.makedirs(f"{out}/snapshots/e2e-3", exist_ok=True)
with open(f"{out}/snapshots/e2e-3/manifest.json", "w") as f:
    json.dump(gen3, f, indent=2)
shutil.copy(f"{out}/snapshots/e2e-1/layout.json", f"{out}/snapshots/e2e-3/layout.json")
PYEOF

# One unrelated, unreferenced object under e2e-1's own prefix, so the fake
# server's refusal path (handleDownload / not_authorized) is exercised by
# a real request during the run — R7/R8 in Part 0 §4.
mkdir -p "$OUT/snapshots/e2e-1/files"
echo "not part of any manifest" > "$OUT/snapshots/e2e-1/files/not-referenced.gz"

echo "seed-snapshot: done — $layout_path (plus e2e-2, e2e-3 generations and one unreferenced object)"
