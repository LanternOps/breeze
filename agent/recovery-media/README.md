# Breeze recovery media (W04b)

Builds `breeze-recovery-linux-<arch>.iso`: a Debian bookworm live-build
image that boots straight into the guided bare-metal recovery console
(`breeze-backup recovery-console`, `agent/internal/recoveryconsole`).

Spec: `docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md` §7.1.
Plan: `docs/superpowers/plans/backup/2026-09-10-bare-metal-w04b-linux-live-media-console-qemu.md`.

## Layout

- `config/` — live-build configuration (`auto/config`, package lists,
  `includes.chroot/` file overlay, `hooks/normal/` chroot hooks).
- `build.sh` — builds one arch's ISO. Needs root (live-build mounts/chroots)
  and the live-build/debootstrap/squashfs-tools/xorriso/grub-efi toolchain.
- `build_test.sh` — asserts a built ISO is really bootable and carries the
  expected payload (run after `build.sh`).
- `e2e/` — the QEMU end-to-end proof (fake server, seeded Debian snapshot,
  boot-rebuild-reboot). See `e2e/README` inline comments in each script.

## Building locally

```bash
cd agent && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o breeze-backup-linux-amd64 ./cmd/breeze-backup

docker run --rm --privileged -v "$PWD/..":/src -w /src debian:bookworm bash -c '
  apt-get update -qq && apt-get install -y -qq live-build debootstrap squashfs-tools xorriso grub-efi-amd64-bin mtools dosfstools ca-certificates >/dev/null &&
  cd agent && ./recovery-media/build.sh --arch amd64 --breeze-backup ./breeze-backup-linux-amd64 --version dev --out /src/out &&
  bash recovery-media/build_test.sh /src/out/breeze-recovery-linux-amd64.iso'
```

Expected: `ISO-OK <hash prefix>`. Typical size 350-450 MB.

## Media contents / security

No SSH server, no passwords, no secrets are baked into the image. The
console refuses to run unless `breeze.media=1` is on the kernel cmdline (or
`--allow-host` is passed, for development off real media). See the
`recoveryconsole` package for the guided flow itself.
