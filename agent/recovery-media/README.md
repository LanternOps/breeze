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

### Unattended (`breeze.ci=1`) mode is a build-time opt-in, not a cmdline one

`breeze.ci=1` and every answer that only matters alongside it
(`breeze.server=`, `breeze.insecure=1`, `breeze.code=`, `breeze.target=`,
`breeze.confirm=`, `breeze.after=`) come from the same unauthenticated
kernel cmdline as everything else on this page — anyone with physical or
console access can edit it before the console ever starts. Production
recovery media therefore does not honor `breeze.ci=1` at all: the breeze-backup
binary built for release (`agent/scripts/build-edition.sh`, every
self-host/hosted edition) never links
`internal/recoveryconsole.unattendedCmdlineEnabled`, so `Console.Run` treats
a cmdline `breeze.ci=1` as inert and always falls through to the
interactive, `https://`-required prompt (see `console.go`'s `Run` and
`promptServer`). Only a build that explicitly passes
`-ldflags "-X github.com/breeze-rmm/agent/internal/recoveryconsole.unattendedCmdlineEnabled=1"`
— today, only the CI recovery-media E2E job's QEMU boot (`.github/workflows/ci.yml`)
— honors it, and even then a plaintext (non-`https://`) `breeze.server=`
still requires the explicit `breeze.insecure=1` cmdline token alongside it.

### Server trust

`build.sh` accepts optional `--server-url <https://...>` and `--trust-pin
<base64-sha256-spki>` flags. When supplied, they are baked in as
`/etc/breeze-recovery-server` and `/etc/breeze-recovery-trust-pin` and
become the console's trusted server default and TLS certificate pin (see
`agent/internal/recoveryconsole/console.go`'s `promptServer` and
`agent/internal/backup/bmr/certpin.go`). A kernel-cmdline `breeze.server=`
value is never trusted the same way: outside `breeze.ci=1` unattended mode
it is offered only as a labeled, must-confirm suggestion at the prompt, and
`breeze.insecure=1` no longer has any effect there (`https://` is required
unconditionally once the console is actually prompting an operator).

Without `--server-url`/`--trust-pin`, built media behaves as it always has:
no baked default, no certificate pin, operator prompted every time. A
self-hosted deployment building its own media should pass its own
`--server-url`; a hosted build pipeline should pass the region's URL. This
is a recommended default, not yet wired into the release pipeline. What
remains: GRUB-edit-mode protection (no
password/superusers directive exists yet) and end-to-end manifest/artifact
signing beyond TLS certificate pinning both still need coordination with
the recovery-media and signing-key build pipelines.
