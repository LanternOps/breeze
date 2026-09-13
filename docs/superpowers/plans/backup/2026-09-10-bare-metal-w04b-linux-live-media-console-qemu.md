---
tracking_issue: LanternOps/breeze#5493
---

# Wave 04b — Linux live recovery media in CI, recovery console, QEMU boot proof — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Breeze ships `breeze-recovery-linux-amd64.iso` as a signed release asset. Booting it on a bare machine starts a guided console: network → enter code → plan (source layout, target disk model/size/serial, partition plan) → type the disk serial or `ERASE` → progress → reboot into the restored OS. CI proves the whole path by building the ISO, booting it in QEMU against a fake Breeze server and a seeded Debian snapshot, letting it rebuild a raw disk, and booting that disk to a login prompt.

**Architecture:** A Debian bookworm live image built with `live-build` in a GitHub Actions job (`build-recovery-media`), containing `breeze-backup` (from the same release build), the partitioning/filesystem/GRUB tools, and a `breeze-recovery.service` that runs `breeze-backup recovery-console` on tty1 and ttyS0. The console is a line-oriented Go program (no TUI library) that drives W04a's exchange/progress endpoints and W03's `rebuild.Run`; a CI-only kernel-cmdline mode (`breeze.ci=1 …`) answers the prompts so QEMU runs unattended. The API serves the ISO through the existing GitHub-release download proxy (`registerComponentDownloadRoute`), replacing the per-token ISO builder, which is deleted. The release manifest lists the ISO like any other asset, so the existing signature covers it.

**Tech Stack:** live-build + debootstrap + squashfs-tools + xorriso + grub-efi-amd64-bin (Debian bookworm, `ubuntu-latest` runner), Go (`agent/cmd/breeze-backup`), Hono (`apps/api`), QEMU + OVMF for the CI proof, `mmdebstrap` to seed a bootable Debian root for the test snapshot.

**Spec:** `docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md` §7.1 (Linux media), §7.3 (console), §9 (wrong-disk protection: serial confirmation), §10 (CI integration boots the ISO in QEMU). Not §7.2 (Windows media — W07).

**Depends on:** W03 (engine) and W04a (`/bmr/recover/exchange`, `/bmr/recover/progress`, token-driven `rebuild`, `RecoveryBinding`). Second PR on wave #5497; closes it.

## Global Constraints

- Asset names: `breeze-recovery-linux-amd64.iso` (+ `.sha256`); arm64 (`breeze-recovery-linux-arm64.iso`) is built by a `continue-on-error: true` matrix leg in this wave and promoted to required in W08 once it is proven stable. Assets are listed in `release-artifact-manifest.json` with `platformTrust: "release-workflow-produced"`, `edition: "self-host"`.
- ISO contents: Debian bookworm, `linux-image-amd64`, `systemd-sysv`, `live-boot`, `gdisk parted dosfstools e2fsprogs xfsprogs util-linux mount grub-efi-amd64-bin grub2-common efibootmgr kbd iproute2 iputils-ping ca-certificates curl jq less`, `systemd-networkd` + `systemd-resolved` with DHCP on every wired interface, `/usr/local/bin/breeze-backup` (the release binary, `0755`), `breeze-recovery.service` (tty1) and a `serial-getty@ttyS0` override running the same console. No SSH server, no passwords, no secrets on the media. Kernel cmdline default `console=tty0 console=ttyS0,115200n8 breeze.media=1`.
- Console command: `breeze-backup recovery-console [--server URL] [--kernel-cmdline /proc/cmdline]`. It refuses to run unless `breeze.media=1` is on the kernel cmdline or `--allow-host` is passed (so nobody runs it on a live server by accident).
- Prompts (in order): server URL (default from `breeze.server=` cmdline, else asks; must be `https://` unless `breeze.insecure=1`), code, target disk (auto-selected when exactly one non-removable disk that is not the media exists; otherwise a numbered list), confirmation (type the disk serial, or `ERASE` when the disk reports no serial), then progress. On refusal/failure: reason stays on screen, `r` retries (engine resumes), `s` opens a root shell, `p` powers off.
- Reboot: after `validated`, the console posts `rebooted` and runs `systemctl reboot` after a 10-second countdown (any key cancels). With `breeze.after=poweroff` (CI) it powers off instead.
- CI-only unattended mode: when `breeze.ci=1` is on the cmdline the console reads `breeze.server=`, `breeze.code=`, `breeze.target=`, `breeze.confirm=` (`ERASE`), `breeze.after=` and never waits for input. `--unattended` stays a parsed-and-refused flag (spec §12).
- Media version gate: the console compares `bootstrap.minHelperVersion` with its own version and refuses older media with "this recovery media (vX) is older than the server requires (vY); download the current ISO".
- The per-token ISO builder is removed: `apps/api/src/services/recoveryBootMediaService.ts`, `apps/api/src/jobs/recoveryBootMediaWorker.ts`, `recoveryBootMediaTemplateManifest.ts` + `recovery-boot-template-manifest.json`, env `RECOVERY_BOOT_MEDIA_BASE_DIR`/`RECOVERY_BOOT_MEDIA_ISO_BIN`, their tests, and the `POST /bmr/boot-media` route. `GET /bmr/boot-media` now returns the release media catalog. The `recovery_boot_media_artifacts` table stays (dropped in W08 after one release) — no migration in this wave.
- No internal hostnames/IPs in committed files (the CI fake server binds `10.0.2.2` only inside the QEMU user-network, which is a QEMU constant, not infrastructure).

## 0. Ground truth (verified 2026-09-10 on main @ `1ffe9b150b`)

- `.github/workflows/release.yml:105-256` `build-agent` (matrix; linux/amd64 leg at `:111-115`; `breeze-backup` built by `agent/scripts/build-edition.sh --edition self-host --component backup …` and uploaded as artifact `breeze-backup-<goos>-<goarch>` `:182-199`); `create-release` downloads `breeze-backup-*` `:2180`, copies to `release-assets/` `:2199-2204`, builds the manifest inline (Python) `:2340-2376` (fields `name, sha256, size, platformTrust, edition`), signs it `:2508-2596` (`RELEASE_MANIFEST_*` secrets).
- `.github/workflows/ci.yml` — `test-agent` job (Linux runner; W03 added a privileged loopback step there).
- `apps/api/src/services/binarySource.ts:58-65` `githubAssetDownloadUrl`, `:91-95` `getGithubBackupUrl`; `apps/api/src/routes/agents/download.ts:307-314` `registerComponentDownloadRoute({ path, logTag, s3Prefix, entityLabel, filenameFor, githubUrlFor, binaryDir })`.
- Old builder: `apps/api/src/services/recoveryBootMediaService.ts` (`:44-55` xorriso packager, `:264-266` `RECOVERY_BOOT_MEDIA_BASE_DIR`), `apps/api/src/jobs/recoveryBootMediaWorker.ts`, routes in `bmr.ts` (`GET/POST /bmr/boot-media`, `GET /bmr/boot-media/:id`, `/download`, `/signature`), `resilienceSiteAuthorization.ts:329-367` joins, tests `recoveryBootMediaService.authorization.test.ts`, `resilienceRouteCoverage.integration.test.ts`, `resilienceWorkerAuthorization.integration.test.ts`, `bmr.test.ts`.
- `apps/web/src/components/backup/RecoveryBootstrapTab.tsx:493-495` fetches `/backup/bmr/boot-media?limit=100`; `:1010` `POST /backup/bmr/boot-media`.
- No live-build/debootstrap/qemu usage exists anywhere in the repo; Dockerfiles are Alpine/Node — the ISO build is new infrastructure.
- W01 `layout.Collect` lists disks with model/serial/size/removable — reused by the console to pick the target.
- W03 `rebuild.Run`, `Options.DryRun`, `Result.Plan` (partition plan for the plan screen), `Options.Progress`.
- W04a `bmr.AuthenticateRecoverySession`, `bmr.NewRecoveryProvider`, `bmr.PostRecoveryProgress`, `POST /api/v1/backup/bmr/recover/exchange` (`{code}` → `{token, bootstrap}`), `BootstrapResponse.Recovery{ID, Identity, Nonce}`, `BootstrapResponse.MinHelperVersion`.

---

### Task 1: Recovery console (Go)

**Files:**
- Create: `agent/internal/recoveryconsole/console.go`, `prompts.go`, `cmdline.go`, `disks.go`, `console_test.go`, `cmdline_test.go`, `disks_test.go`
- Create: `agent/cmd/breeze-backup/recovery_console_cmd.go` (+ `_test.go`); register in `bmr_recover_cmd.go:35`

**Interfaces:**

```go
package recoveryconsole

type IO interface { // line I/O; tests use bytes.Buffer-backed fakes
	Print(format string, args ...any)
	ReadLine(prompt string) (string, error)
	ReadKeyWithTimeout(d time.Duration) (rune, bool) // countdown cancel; false on timeout
}

type Answers struct { // CI-only unattended answers parsed from the kernel cmdline
	Server, Code, Target, Confirm, After string
	Insecure bool
}
func ParseKernelCmdline(s string) (media bool, ci bool, a Answers)

type DiskChoice struct { Path, Model, Serial string; SizeBytes int64 }
func CandidateDisks(lay *layout.Manifest, mediaSources []string) []DiskChoice // non-removable, not backing the media, not holding /

type Deps struct { // seams for tests
	Exchange     func(ctx context.Context, server, code string) (token string, bs *bmr.BootstrapResponse, err error)
	Collect      func(ctx context.Context) (*layout.Manifest, error)          // layout.Collect
	MediaSources func() ([]string, error)                                     // rebuild.NewSystem().RootSources
	Rebuild      func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error)
	Provider     func(ctx context.Context, server, token string, bs *bmr.BootstrapResponse) (providers.BackupProvider, error)
	Progress     func(ctx context.Context, server, token string, u bmr.ProgressUpdate) error
	Power        func(action string) error                                     // "reboot" | "poweroff"
	Version      string
}

type Console struct { IO IO; Deps Deps; Cmdline string; AllowHost bool }
func (c *Console) Run(ctx context.Context) error
```

Flow inside `Run` (each step is a small function so tests can cover branches): guard (`breeze.media=1` or `AllowHost`), server prompt (validate `https://` unless insecure), code prompt → `Exchange` (retry up to 3 bad codes, then back to prompt), version gate (`bs.MinHelperVersion` vs `Deps.Version` using the same semver compare the helper already uses for `minHelperVersion`… it has none — add `versionAtLeast(have, want string) bool` with a table test), `Collect` + `CandidateDisks` → choose, `Rebuild(DryRun)` → print plan (source disk, target model/size/serial, per-partition role/size/filesystem; refusal reason if refused → post `refused`, offer retry/shell/poweroff), confirmation (`serial` or `ERASE`) → post `planned` → post `restoring` → `Rebuild` with `Progress` printing `[phase] message (n/m)` → on success post `validated`, print "Restored. Rebooting in 10 s (press any key to stay)", post `rebooted`, `Power("reboot")` (or `poweroff` when `After == "poweroff"`); on failure print the phase + reason, offer `r`/`s`/`p`.

- [ ] **Step 1: Write the failing tests**

`cmdline_test.go`: table over `"console=tty0 breeze.media=1"` → media true, ci false; `"breeze.media=1 breeze.ci=1 breeze.server=http://10.0.2.2:8080 breeze.code=ABC-DEF-GHJ breeze.target=/dev/sda breeze.confirm=ERASE breeze.after=poweroff breeze.insecure=1"` → all fields; `""` → media false.

`disks_test.go`: layout with `/dev/sda` (system, holds `/`), `/dev/sdb` (data), `/dev/sdc` removable, media sources `["/dev/sdc1"]` → candidates `[sdb]`; media on `/dev/sr0` → `[sda? no — sda holds "/" of the LIVE system? In the live environment "/" is the squashfs overlay; `layout.Collect` on the media host reports the target machine's disks with no `/` mount on them]` — model the live case: no partition mounted at `/`, sources `["/dev/sr0"]` → both `sda` and `sdb` are candidates, sorted by path.

`console_test.go` (fake IO with scripted answers; fake Deps recording calls):
- `TestConsole_RefusesOutsideMedia`: cmdline without `breeze.media=1`, `AllowHost=false` → error contains "recovery media".
- `TestConsole_HappyPathSingleDisk`: answers `["https://breeze.example", "abc-def-ghj", "6002248"]`, Deps.Exchange returns token + bootstrap `{MinHelperVersion:"0.100.0", Recovery:{ID:"rec-1", Identity:"original", Nonce:"n"}}`, Collect returns one disk `\`/dev/sda\`` serial `6002248` 100 GiB, Rebuild dry-run returns a Plan with 3 partitions, Rebuild real returns completed → assert progress statuses posted in order `planned, restoring, validated, rebooted`, Power called with `reboot`, the printed transcript contains the model, serial, `100 GiB`, each partition's role, and "Rebooting in 10 s"; the `rebuild.Options` passed have `Marker{rec-1, n}`, `Target{disk,/dev/sda}`, `Identity original`.
- `TestConsole_ConfirmationMustMatchSerial`: answer `"wrong"` twice then the serial → no Rebuild call until the third; `ERASE` accepted only when `Serial == ""`.
- `TestConsole_RefusedPlanPostsRefusedAndOffersRetry`: dry-run returns `Status refused` → progress `refused` posted with the reason, prompt shows `[r]etry`, answer `p` → Power `poweroff`.
- `TestConsole_OldMediaRefused`: `MinHelperVersion "0.120.0"`, `Deps.Version "0.111.1"` → message contains both versions; no Rebuild.
- `TestConsole_CIModeAnswersEverything`: cmdline with `breeze.ci=1 …` and an IO that fails on any ReadLine → full happy path, Power `poweroff`.
- `TestConsole_ProgressPostFailureIsNonFatal`: Progress returns an error → rebuild still runs; transcript contains "not recorded".

- [ ] **Step 2: Run to verify failure** — `cd agent && go test ./internal/recoveryconsole/ 2>&1 | head -3`.

- [ ] **Step 3: Implement** (`console.go` per the flow; `prompts.go` = `termIO` implementing `IO` over `os.Stdin/os.Stdout` with `bufio.Scanner` and a raw-mode single-key read via `golang.org/x/term` — check `agent/go.mod` for `golang.org/x/term`; if absent use `stty -echo -icanon min 0 time N` via `exec` and document it; `cmdline.go` parses `key=value` tokens; `disks.go` per the interface). CLI:

```go
func newRecoveryConsoleCommand() *cobra.Command {
	var server, cmdlinePath string
	var allowHost, unattended bool
	cmd := &cobra.Command{
		Use:   "recovery-console",
		Short: "Guided bare-metal recovery console (runs on Breeze recovery media)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if unattended {
				return errors.New("--unattended is reserved and not supported in this release")
			}
			raw, _ := os.ReadFile(cmdlinePath)
			sys := rebuild.NewSystem()
			if sys == nil {
				return rebuild.ErrUnsupportedHost
			}
			c := &recoveryconsole.Console{
				IO: recoveryconsole.NewTerminalIO(os.Stdin, os.Stdout), Cmdline: string(raw), AllowHost: allowHost,
				Deps: recoveryconsole.Deps{
					Exchange: bmr.ExchangeRecoveryCode, Collect: layout.Collect, MediaSources: sys.RootSources,
					Rebuild: rebuild.Run, Provider: bmr.NewRecoveryProvider, Progress: bmr.PostRecoveryProgress,
					Power: func(a string) error { return exec.Command("systemctl", a).Run() }, Version: version,
				},
			}
			if server != "" { c.DefaultServer = server }
			ctx, stop := recoveryContext()
			defer stop()
			return c.Run(ctx)
		},
	}
	cmd.Flags().StringVar(&server, "server", "", "Breeze server URL (default: breeze.server= on the kernel cmdline, else prompted)")
	cmd.Flags().StringVar(&cmdlinePath, "kernel-cmdline", "/proc/cmdline", "kernel cmdline file (tests)")
	cmd.Flags().BoolVar(&allowHost, "allow-host", false, "run outside recovery media (development only)")
	cmd.Flags().BoolVar(&unattended, "unattended", false, "reserved")
	return cmd
}
```

`bmr.ExchangeRecoveryCode(ctx, server, code) (string, *BootstrapResponse, error)` — add to `session.go` (POST `/api/v1/backup/bmr/recover/exchange`, decode `{token, bootstrap}`; 404 → `ErrCodeInvalid`).

- [ ] **Step 4: Run, lint, commit**

```bash
cd agent && go test -race -count=1 ./internal/recoveryconsole/ ./internal/backup/bmr/ ./cmd/breeze-backup/ 2>&1 | tail -4 && GOOS=windows go build ./cmd/breeze-backup/ && GOOS=darwin go build ./cmd/breeze-backup/ && golangci-lint run --new-from-rev=origin/main ./... | tail -1
git add agent/internal/recoveryconsole/ agent/cmd/breeze-backup/ agent/internal/backup/bmr/session.go
git commit -m "feat(breeze-backup): recovery-console — guided code→plan→confirm→rebuild→reboot flow with CI answer mode (W04b)"
```

---

### Task 2: Live media build (live-build config + script + CI job + release asset)

**Files:**
- Create: `agent/recovery-media/build.sh`, `agent/recovery-media/config/` (live-build `auto/config`, `config/package-lists/breeze.list.chroot`, `config/includes.chroot/etc/systemd/system/breeze-recovery.service`, `…/etc/systemd/system/serial-getty@ttyS0.service.d/override.conf`, `…/etc/systemd/system/getty@tty1.service.d/override.conf`, `…/etc/systemd/network/20-wired.network`, `…/etc/motd`, `config/bootloaders/grub-pc/grub.cfg` fragment for the default kernel cmdline), `agent/recovery-media/README.md`
- Modify: `.github/workflows/release.yml` (new job `build-recovery-media` after `build-agent`; `create-release` downloads `breeze-recovery-*` and copies into `release-assets/`; manifest builder gets `platform_trust` for `.iso`)
- Test: `agent/recovery-media/build_test.sh` (bash; asserts the ISO is hybrid-bootable via `xorriso -indev … -report_el_torito` and lists `/live/vmlinuz`, `/live/initrd.img`, `/live/filesystem.squashfs`, `EFI/BOOT/BOOTX64.EFI`, and that `unsquashfs -l` shows `/usr/local/bin/breeze-backup` and `/etc/systemd/system/breeze-recovery.service`)

**Interfaces:**
- `build.sh --arch amd64|arm64 --breeze-backup <path to binary> --version <v> --out <dir>` → `<dir>/breeze-recovery-linux-<arch>.iso` + `.sha256`.

- [ ] **Step 1: Write `build_test.sh` first** (it fails until the ISO exists):

```bash
#!/usr/bin/env bash
set -euo pipefail
iso="$1"
test -s "$iso"
xorriso -indev "$iso" -report_el_torito plain 2>/dev/null | grep -q "El Torito boot img" || { echo "not El Torito bootable"; exit 1; }
xorriso -indev "$iso" -find / -type f 2>/dev/null > /tmp/iso-files.txt
for f in /live/vmlinuz /live/initrd.img /live/filesystem.squashfs /EFI/BOOT/BOOTX64.EFI; do
  grep -qx "'$f'" /tmp/iso-files.txt || { echo "missing $f"; exit 1; }
done
tmp=$(mktemp -d); xorriso -osirrox on -indev "$iso" -extract /live/filesystem.squashfs "$tmp/fs.squashfs" 2>/dev/null
unsquashfs -l "$tmp/fs.squashfs" > "$tmp/list.txt"
for f in usr/local/bin/breeze-backup etc/systemd/system/breeze-recovery.service usr/sbin/sgdisk usr/sbin/grub-install usr/bin/efibootmgr sbin/mkfs.ext4 sbin/mkfs.xfs sbin/mkfs.vfat; do
  grep -q "squashfs-root/$f\$" "$tmp/list.txt" || { echo "squashfs missing $f"; exit 1; }
done
echo "ISO-OK $(sha256sum "$iso" | cut -c1-16)"
```

- [ ] **Step 2: Write the live-build config**

`auto/config`:
```bash
#!/bin/sh
set -e
lb config noauto \
  --mode debian --distribution bookworm --architectures "${BREEZE_ARCH:-amd64}" \
  --archive-areas "main contrib non-free-firmware" \
  --binary-images iso-hybrid --bootloaders "grub-efi" \
  --debian-installer none --apt-recommends false --memtest none \
  --linux-flavours "${BREEZE_ARCH:-amd64}" \
  --bootappend-live "boot=live components quiet console=tty0 console=ttyS0,115200n8 breeze.media=1 ${BREEZE_EXTRA_CMDLINE:-}" \
  --iso-application "Breeze Recovery" --iso-publisher "Breeze RMM" --iso-volume "BREEZE_RECOVERY" \
  "${@}"
```

`config/package-lists/breeze.list.chroot`:
```
linux-image-amd64
live-boot
systemd-sysv
systemd-resolved
gdisk
parted
dosfstools
e2fsprogs
xfsprogs
util-linux
mount
grub-efi-amd64-bin
grub2-common
efibootmgr
kbd
iproute2
iputils-ping
ca-certificates
curl
jq
less
firmware-linux-free
```
(arm64 leg: `linux-image-arm64`, `grub-efi-arm64-bin` via a second list selected by `BREEZE_ARCH`.)

`config/includes.chroot/etc/systemd/system/breeze-recovery.service`:
```ini
[Unit]
Description=Breeze bare-metal recovery console (tty1)
After=systemd-networkd-wait-online.service getty.target
Wants=systemd-networkd-wait-online.service
ConditionKernelCommandLine=breeze.media=1
[Service]
ExecStart=/usr/local/bin/breeze-backup recovery-console
StandardInput=tty
StandardOutput=tty
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
```
Plus `serial-getty@ttyS0.service.d/override.conf` replacing `ExecStart` with `/usr/local/bin/breeze-backup recovery-console` (so serial users get the same console) and `getty@tty1.service.d/override.conf` masking the login getty on tty1 (`ExecStart=` + `ExecStart=/bin/true`… simpler: `systemctl mask getty@tty1` in a `config/hooks/normal/0100-breeze.hook.chroot` that also `systemctl enable breeze-recovery.service systemd-networkd systemd-resolved`). `20-wired.network`: `[Match] Name=en* eth*` `[Network] DHCP=yes`.

`build.sh`: installs nothing itself (CI does); copies the given `breeze-backup` binary into `config/includes.chroot/usr/local/bin/breeze-backup` (chmod 755), writes `/etc/breeze-recovery-version` with `--version`, runs `lb clean --purge && lb config && sudo lb build`, renames `live-image-<arch>.hybrid.iso` to the asset name, writes `.sha256`.

- [ ] **Step 3: CI job** (`release.yml`, after `build-agent`):

```yaml
  build-recovery-media:
    name: Build recovery media (${{ matrix.arch }})
    needs: build-agent
    runs-on: ubuntu-latest
    continue-on-error: ${{ matrix.arch == 'arm64' }}
    strategy:
      fail-fast: false
      matrix:
        arch: [amd64, arm64]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: breeze-backup-linux-${{ matrix.arch }}
          path: dist/
      - name: Install live-build toolchain
        run: |
          sudo apt-get update -qq
          sudo apt-get install -y --no-install-recommends live-build debootstrap squashfs-tools xorriso grub-efi-amd64-bin grub-efi-arm64-bin mtools dosfstools qemu-user-static binfmt-support
      - name: Build ISO
        run: |
          chmod +x dist/breeze-backup-linux-${{ matrix.arch }}
          agent/recovery-media/build.sh --arch ${{ matrix.arch }} --breeze-backup dist/breeze-backup-linux-${{ matrix.arch }} --version "${{ needs.build-agent.outputs.version || github.ref_name }}" --out out/
          bash agent/recovery-media/build_test.sh out/breeze-recovery-linux-${{ matrix.arch }}.iso
      - uses: actions/upload-artifact@v4
        with:
          name: breeze-recovery-linux-${{ matrix.arch }}
          path: out/breeze-recovery-linux-${{ matrix.arch }}.iso*
          retention-days: 30
```
(Confirm how `build-agent` exposes the version — `BUILD_VERSION` at `:182` — and reuse the same expression; `needs.build-agent.outputs.version` is illustrative.) In `create-release`: add `breeze-recovery-*` to the download pattern (`:2180`) and a copy loop like `:2199-2204`; in the manifest builder (`:2340-2376`) make `platform_trust()` return `release-workflow-produced` for names ending `.iso`.

- [ ] **Step 4: Prove locally in Docker before pushing** (live-build needs root):

```bash
docker run --rm --privileged -v "$PWD":/src -w /src debian:bookworm bash -c '
  apt-get update -qq && apt-get install -y -qq live-build debootstrap squashfs-tools xorriso grub-efi-amd64-bin mtools dosfstools ca-certificates >/dev/null &&
  cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 true &&
  ./recovery-media/build.sh --arch amd64 --breeze-backup /src/agent/breeze-backup-linux-amd64 --version dev --out /src/out && bash recovery-media/build_test.sh /src/out/breeze-recovery-linux-amd64.iso'
```
(Build `agent/breeze-backup-linux-amd64` first with `cd agent && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o breeze-backup-linux-amd64 ./cmd/breeze-backup`.) Expected: `ISO-OK …`. Typical size 350–450 MB.

- [ ] **Step 5: Commit**

```bash
git add agent/recovery-media/ .github/workflows/release.yml
git commit -m "feat(release): build and publish breeze-recovery-linux-{amd64,arm64}.iso live media with the recovery console (W04b)"
```

---

### Task 3: API serves release media; old per-token builder removed

**Files:**
- Modify: `apps/api/src/services/binarySource.ts` (`getGithubRecoveryIsoUrl(arch)` → `breeze-recovery-linux-<arch>.iso`), `apps/api/src/routes/agents/download.ts` (register `/download/recovery-iso/linux/:arch` via `registerComponentDownloadRoute`, `s3Prefix: 'recovery-iso'`, `entityLabel: 'Recovery media'`), `apps/api/src/routes/backup/bmr.ts` (`GET /bmr/boot-media` returns the catalog; delete `POST /bmr/boot-media`, `/bmr/boot-media/:id`, `/download`, `/signature`)
- Delete: `apps/api/src/services/recoveryBootMediaService.ts`, `apps/api/src/jobs/recoveryBootMediaWorker.ts` (+ its registration in the worker bootstrap), `apps/api/src/services/recoveryBootMediaTemplateManifest.ts`, `recovery-boot-template-manifest.json`, `recoveryBootMediaService.authorization.test.ts`; remove `RECOVERY_BOOT_MEDIA_BASE_DIR`/`RECOVERY_BOOT_MEDIA_ISO_BIN` from config validation, `.env.example`, docs
- Modify: `apps/api/src/services/resilienceSiteAuthorization.ts:329-367` (drop the boot-media artifact branch), `resilienceRouteCoverage.integration.test.ts` / `resilienceWorkerAuthorization.integration.test.ts` (remove the boot-media expectations), `bmr.test.ts` (boot-media route tests → catalog test)
- Modify: `apps/web/src/components/backup/RecoveryBootstrapTab.tsx` (`:493-495`, `:1010`: catalog rendering — one row per `{platform, arch, version, filename, downloadUrl, sha256}` with a Download button; remove the "build boot ISO" form) + its test + locale keys (translated)

**Interfaces:**
- `GET /backup/bmr/boot-media` → `{ data: [{ platform: 'linux', arch: 'amd64'|'arm64', version, filename, downloadUrl: '/api/v1/agents/download/recovery-iso/linux/<arch>', sha256: string|null, size: number|null }] }` (sha256/size from the release manifest when `BINARY_SOURCE=github` via the existing manifest loader; null otherwise), plus `{ windows: { builder: 'coming in W07' } }` placeholder omitted — return only Linux entries.

- [ ] **Step 1: Write the failing tests** — `bmr.test.ts`: `GET /bmr/boot-media` returns the two Linux rows with `downloadUrl`s; `download.test.ts` (or the file that tests `registerComponentDownloadRoute` routes): `/agents/download/recovery-iso/linux/amd64` redirects/streams like `/download/backup/linux/amd64` does (copy its test and swap names); `binarySource.test.ts`: `getGithubRecoveryIsoUrl('amd64')` ends with `/breeze-recovery-linux-amd64.iso`.
- [ ] **Step 2: Run to verify failure**, **Step 3: implement + delete**, **Step 4:**

```bash
cd apps/api && npx vitest run src/routes/backup/bmr.test.ts src/routes/agents/download src/services/binarySource 2>&1 | tail -4 && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p . 2>&1 | tail -2
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/resilienceRouteCoverage.integration.test.ts src/__tests__/integration/resilienceWorkerAuthorization.integration.test.ts 2>&1 | tail -4
grep -rn "RECOVERY_BOOT_MEDIA\|recoveryBootMediaService\|recoveryBootMediaWorker" apps/ docs/ .env.example docker-compose*.yml deploy/ 2>/dev/null | grep -v node_modules   # expect nothing
cd ../web && npx vitest run src/components/backup/RecoveryBootstrapTab.test.tsx src/lib/i18n 2>&1 | tail -3
git add -A apps/api apps/web docs .env.example && git commit -m "feat(api,web): serve release recovery media; remove the per-token ISO builder (W04b)"
```

---

### Task 4: QEMU end-to-end proof in CI

**Files:**
- Create: `agent/internal/backup/bmr/fakeserver/fakeserver.go` (a `net/http` server implementing `POST /api/v1/backup/bmr/recover/exchange`, `POST …/authenticate`, `GET …/download?key=` (serves objects from a directory, using the same download descriptor format the real API returns), `POST …/progress` (records statuses to a JSON file), `main` under `agent/cmd/breeze-recovery-fakeserver/` (test-only binary, not released — add it to the `build-edition.sh` exclusion list if the script builds `./cmd/...` wildcard)
- Create: `agent/recovery-media/e2e/seed-snapshot.sh` (mmdebstrap a bootable bookworm root → run `breeze-backup` file backup of it with `--paths / --system-state` semantics into a local provider dir + write `layout.json` for a 1-disk UEFI layout matching the image geometry) and `agent/recovery-media/e2e/run-qemu.sh`
- Modify: `.github/workflows/ci.yml` — new job `recovery-media-e2e` (needs the ISO: on PRs build it in-job from the current tree using the same `build.sh`; ~15 min; mark `continue-on-error: false` — this is the assurance gate)

**Interfaces:**
- `seed-snapshot.sh <store-dir>` produces `<store-dir>/snapshots/e2e-1/{manifest.json,layout.json,system-state/…,files/…}` from an mmdebstrap root (`--variant=minbase --include=linux-image-amd64,systemd-sysv,grub-efi-amd64,initramfs-tools,e2fsprogs,dosfstools,util-linux,ifupdown,isc-dhcp-client` with `/etc/hostname = e2e-restored-src`, `/etc/fstab` using the UUIDs from the seeded `layout.json`, root password disabled, a `getty@ttyS0` enabled so the second boot shows `login:` on serial). Run the real `breeze-backup` against that root (`breeze-backup backup-run …` — use whatever command the helper exposes for a one-shot file backup to a `local` provider; if none exists as a CLI, add `breeze-backup snapshot-dir --root <dir> --out <store> --snapshot-id e2e-1` as a small test-support command).
- `run-qemu.sh <iso> <store-dir> <out-dir>`: starts the fake server on `0.0.0.0:18080` with a code `ABCDEFGHJ`, creates `target.img` (8 GiB sparse), runs

```bash
qemu-system-x86_64 -machine q35,accel=tcg -cpu max -m 3G -smp 2 \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
  -drive if=pflash,format=raw,file=$out/OVMF_VARS.fd \
  -drive file=$out/target.img,format=raw,if=virtio \
  -cdrom "$iso" -boot d -nographic -serial file:$out/serial-1.log -monitor none \
  -netdev user,id=n0 -device virtio-net-pci,netdev=n0 \
  -kernel <extracted /live/vmlinuz> -initrd <extracted /live/initrd.img> \
  -append "boot=live components console=ttyS0,115200n8 breeze.media=1 breeze.ci=1 breeze.server=http://10.0.2.2:18080 breeze.insecure=1 breeze.code=ABCDEFGHJ breeze.target=/dev/vda breeze.confirm=ERASE breeze.after=poweroff"
```
  (kernel/initrd passed directly so the cmdline is controllable; the ISO is still the root medium), waits for poweroff (timeout 20 min), asserts `progress.json` == `["media_booted","planned","restoring","validated","rebooted"]`, then boots `target.img` alone (`-boot c`, no cdrom, serial to `serial-2.log`) for up to 5 min and asserts `serial-2.log` contains `e2e-restored-src login:` (Debian getty banner). Prints `E2E-OK`.

- [ ] **Step 1: Write `run-qemu.sh` with its assertions first** (fails without the ISO/fakeserver).
- [ ] **Step 2: Implement the fake server + seed script; run the whole thing locally in Docker** (`--privileged`, packages `qemu-system-x86 ovmf mmdebstrap` — ~20 minutes on a laptop; TCG is slow but sufficient).
- [ ] **Step 3: CI job**

```yaml
  recovery-media-e2e:
    name: Recovery media E2E (QEMU)
    needs: [test-agent]
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version-file: agent/go.mod }
      - name: Toolchain
        run: sudo apt-get update -qq && sudo apt-get install -y --no-install-recommends live-build debootstrap squashfs-tools xorriso grub-efi-amd64-bin mtools dosfstools qemu-system-x86 ovmf mmdebstrap
      - name: Build helper + ISO
        run: |
          cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o breeze-backup-linux-amd64 ./cmd/breeze-backup && go build -o breeze-recovery-fakeserver ./cmd/breeze-recovery-fakeserver
          sudo ./recovery-media/build.sh --arch amd64 --breeze-backup ./breeze-backup-linux-amd64 --version ci --out out/ && bash recovery-media/build_test.sh out/breeze-recovery-linux-amd64.iso
      - name: Seed snapshot + boot + rebuild + reboot
        run: cd agent && sudo ./recovery-media/e2e/seed-snapshot.sh e2e-store && sudo ./recovery-media/e2e/run-qemu.sh out/breeze-recovery-linux-amd64.iso e2e-store e2e-out
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: recovery-media-e2e-logs, path: agent/e2e-out/*.log }
```
Add `recovery-media-e2e` to `ci-success`'s `needs` so it gates merges.

- [ ] **Step 4: Commit**

```bash
git add agent/internal/backup/bmr/fakeserver/ agent/cmd/breeze-recovery-fakeserver/ agent/recovery-media/e2e/ .github/workflows/ci.yml
git commit -m "test(recovery-media): QEMU end-to-end — boot ISO, rebuild a disk from a seeded Debian snapshot, boot it to login (W04b)"
```

---

### Task 5: Lab proof on KIT, docs, PR

- [ ] **Step 1: KIT** — upload `breeze-recovery-linux-amd64.iso` to `D:\lab\`, create a Gen2 VM (Secure Boot off, 4 GB, empty 60 GB VHDX, DVD = ISO, network on the lab switch), create a recovery in the lab stack UI for the Ubuntu rig's whole-machine snapshot (identity `new` — the rig stays in service), boot, type the code on the VM console, confirm with `ERASE` (fresh VHDX has no serial), watch the timeline reach `validated → rebooted`; the VM reboots into Ubuntu with hostname `<rig>-restored`. Then repeat with identity `original` against a snapshot of a throwaway lab VM and confirm `checked_in` + `recoveredAt` on the device page. Screenshots + recovery ids into the campaign doc §11 (`W04b-kit-linux-media-boot`, `W04b-kit-checkin`).
- [ ] **Step 2: Docs** — `apps/docs/src/content/docs/backup/bare-metal-recovery.mdx`: new "Recover from Breeze recovery media" section (download ISO from Backup → Recovery, write to USB, boot, code, confirm, reboot), reinstall-then-recover demoted to "Alternative: recover into a freshly installed OS".
- [ ] **Step 3: PR** — `Closes #5497`; one review round (Sonnet; questions: console guard, confirmation logic, CI-mode not reachable outside `breeze.ci=1`, nothing secret baked into the ISO, deleted-builder sweep complete), `gh pr merge <N> --squash`.

---

## Self-review notes (plan author)

- Spec §7.1 → Task 2 (media contents, CI build, signed via the release manifest, served by Task 3); §7.3 → Task 1 (every prompt, refusal/retry/shell/poweroff, version gate, reboot countdown); §9 wrong-disk protection → serial/`ERASE` confirmation (Task 1) on top of the engine's own in-use/root-device refusals (W03); §10 CI integration → Task 4 (ISO in QEMU + fake server + seeded Debian root + second boot to `login:`); lab proof → Task 5.
- The CI-only cmdline answer mode is gated on `breeze.ci=1` and lives in the console; `--unattended` remains refused (§12).
- Names consistent with W04a: `bmr.ExchangeRecoveryCode` (new here), `bmr.AuthenticateRecoverySession`, `bmr.NewRecoveryProvider`, `bmr.PostRecoveryProgress`, `bmr.ProgressUpdate`; with W03: `rebuild.Run/Options/Result/NewSystem`, `RootSources`; with W01: `layout.Collect`.
- Deliberate: arm64 ISO is `continue-on-error` until proven (cross-arch live-build under qemu-user-static is slow and occasionally flaky); the e2e gate is amd64 only.
