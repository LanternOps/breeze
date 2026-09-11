#!/usr/bin/env bash
# QEMU end-to-end proof for the Breeze recovery media (W04b Task 4): boots
# the built ISO against a fake Breeze server and a seeded Debian snapshot
# in CI-unattended mode (breeze.ci=1), lets the recovery console + rebuild
# engine partition and restore target.img, waits for the guest to power
# off, asserts the fake server recorded every expected progress phase, then
# boots target.img alone and asserts it reaches a login prompt.
#
# Usage: run-qemu.sh <iso> <store-dir> <out-dir>
# Requires root (loop-mountless but xorriso extraction + qemu KVM/TCG need
# it in CI), qemu-system-x86_64, ovmf, xorriso on PATH.
set -euo pipefail

iso="${1:?usage: run-qemu.sh <iso> <store-dir> <out-dir>}"
store_dir="${2:?usage: run-qemu.sh <iso> <store-dir> <out-dir>}"
out_dir="${3:?usage: run-qemu.sh <iso> <store-dir> <out-dir>}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="$(cd "$script_dir/../.." && pwd)"

mkdir -p "$out_dir"
iso="$(cd "$(dirname "$iso")" && pwd)/$(basename "$iso")"
store_dir="$(cd "$store_dir" && pwd)"
out_dir="$(cd "$out_dir" && pwd)"

snapshot_id="e2e-1"
recovery_code="ABCDEFGHJ"
fake_addr="0.0.0.0:18080"
guest_server_url="http://10.0.2.2:18080"

qemu_bin="$(command -v qemu-system-x86_64)"

# --- Locate OVMF (package/path naming has drifted across Debian/Ubuntu
# releases: OVMF_CODE_4M.fd vs OVMF_CODE.fd). ---
find_ovmf() {
  local name="$1"
  local candidates=(
    "/usr/share/OVMF/${name}_4M.fd"
    "/usr/share/OVMF/${name}.fd"
    "/usr/share/ovmf/${name}.fd"
    "/usr/share/qemu/${name}.fd"
  )
  for c in "${candidates[@]}"; do
    if [ -f "$c" ]; then echo "$c"; return 0; fi
  done
  echo "run-qemu: could not locate ${name}.fd (checked: ${candidates[*]})" >&2
  return 1
}
ovmf_code="$(find_ovmf OVMF_CODE)"
ovmf_vars_template="$(find_ovmf OVMF_VARS)"
cp "$ovmf_vars_template" "$out_dir/OVMF_VARS.fd"

# --- Build breeze-recovery-fakeserver + start it ---
fakeserver_bin="$out_dir/breeze-recovery-fakeserver"
echo "run-qemu: building breeze-recovery-fakeserver"
(cd "$agent_dir" && go build -o "$fakeserver_bin" ./cmd/breeze-recovery-fakeserver)

progress_log="$out_dir/progress.json"
rm -f "$progress_log"
fakeserver_log="$out_dir/fakeserver.log"
"$fakeserver_bin" \
  --addr "$fake_addr" \
  --code "$recovery_code" \
  --snapshot-id "$snapshot_id" \
  --store-dir "$store_dir" \
  --progress-log "$progress_log" \
  --identity new \
  > "$fakeserver_log" 2>&1 &
fakeserver_pid=$!
trap 'kill "$fakeserver_pid" 2>/dev/null || true' EXIT

sleep 1
if ! kill -0 "$fakeserver_pid" 2>/dev/null; then
  echo "run-qemu: fakeserver exited immediately; log:" >&2
  cat "$fakeserver_log" >&2
  exit 1
fi

# --- Extract the kernel/initrd the ISO's live-boot payload carries, so
# -append can set breeze.ci=1 et al. directly (bookworm live-build names
# these with a kernel-version suffix — see build_test.sh's own comment). ---
extract_dir="$out_dir/extracted"
mkdir -p "$extract_dir"
kernel_iso_path="$(xorriso -indev "$iso" -find /live -type f 2>/dev/null | grep -oE "/live/vmlinuz[^']*" | head -1)"
initrd_iso_path="$(xorriso -indev "$iso" -find /live -type f 2>/dev/null | grep -oE "/live/initrd\.img[^']*" | head -1)"
if [ -z "$kernel_iso_path" ] || [ -z "$initrd_iso_path" ]; then
  echo "run-qemu: could not find /live/vmlinuz* or /live/initrd.img* in $iso" >&2
  exit 1
fi
xorriso -osirrox on -indev "$iso" -extract "$kernel_iso_path" "$extract_dir/vmlinuz" 2>/dev/null
xorriso -osirrox on -indev "$iso" -extract "$initrd_iso_path" "$extract_dir/initrd.img" 2>/dev/null

# --- Fresh 8 GiB sparse target disk ---
target_img="$out_dir/target.img"
rm -f "$target_img"
qemu-img create -f raw "$target_img" 8G >/dev/null

serial1_log="$out_dir/serial-1.log"
rm -f "$serial1_log"

cmdline="boot=live components console=ttyS0,115200n8 breeze.media=1 breeze.ci=1 breeze.server=${guest_server_url} breeze.insecure=1 breeze.code=${recovery_code} breeze.target=/dev/vda breeze.confirm=ERASE breeze.after=poweroff"

echo "run-qemu: boot 1 — recovery ISO (CI-unattended), cmdline: $cmdline"
timeout 1200 "$qemu_bin" \
  -machine q35,accel=tcg -cpu max -m 3G -smp 2 \
  -drive if=pflash,format=raw,readonly=on,file="$ovmf_code" \
  -drive if=pflash,format=raw,file="$out_dir/OVMF_VARS.fd" \
  -drive file="$target_img",format=raw,if=virtio \
  -cdrom "$iso" \
  -kernel "$extract_dir/vmlinuz" -initrd "$extract_dir/initrd.img" \
  -append "$cmdline" \
  -nographic -serial file:"$serial1_log" -monitor none \
  -netdev user,id=n0 -device virtio-net-pci,netdev=n0 \
  || echo "run-qemu: boot 1 qemu exited non-zero (expected on a clean guest poweroff under some QEMU versions) — checked below"

echo "----- serial-1.log (last 80 lines) -----"
tail -80 "$serial1_log" || true
echo "-----------------------------------------"

if [ ! -f "$progress_log" ]; then
  echo "run-qemu: FAIL — fakeserver never received any /recover/progress calls (progress.json missing)" >&2
  exit 1
fi
echo "run-qemu: progress.json = $(cat "$progress_log")"

expected='["media_booted","planned","restoring","validated","rebooted"]'
actual="$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))))' "$progress_log")"
if [ "$actual" != "$expected" ]; then
  echo "run-qemu: FAIL — progress.json = $actual, want $expected" >&2
  exit 1
fi
echo "run-qemu: PASS — progress phases match: $actual"

# --- Boot 2: target.img alone, expect a login prompt on serial ---
serial2_log="$out_dir/serial-2.log"
rm -f "$serial2_log"
cp "$ovmf_vars_template" "$out_dir/OVMF_VARS_boot2.fd"

echo "run-qemu: boot 2 — target.img alone, waiting for login prompt"
"$qemu_bin" \
  -machine q35,accel=tcg -cpu max -m 2G -smp 2 \
  -drive if=pflash,format=raw,readonly=on,file="$ovmf_code" \
  -drive if=pflash,format=raw,file="$out_dir/OVMF_VARS_boot2.fd" \
  -drive file="$target_img",format=raw,if=virtio \
  -boot c \
  -nographic -serial file:"$serial2_log" -monitor none \
  -netdev user,id=n1 -device virtio-net-pci,netdev=n1 \
  &
boot2_pid=$!

deadline=$((SECONDS + 300))
found=0
while [ "$SECONDS" -lt "$deadline" ]; do
  if [ -f "$serial2_log" ] && grep -q "login:" "$serial2_log"; then
    found=1
    break
  fi
  if ! kill -0 "$boot2_pid" 2>/dev/null; then
    break
  fi
  sleep 5
done
kill "$boot2_pid" 2>/dev/null || true
wait "$boot2_pid" 2>/dev/null || true

echo "----- serial-2.log (last 80 lines) -----"
tail -80 "$serial2_log" || true
echo "-----------------------------------------"

if [ "$found" != "1" ]; then
  echo "run-qemu: FAIL — target.img did not reach a login prompt within 5 minutes" >&2
  exit 1
fi

if ! grep -q "e2e-restored-src login:" "$serial2_log"; then
  echo "run-qemu: WARNING — login prompt found but hostname banner does not read 'e2e-restored-src login:' (checked loosely above); see serial-2.log" >&2
fi

echo "E2E-OK"
