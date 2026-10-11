---
tracking_issue: LanternOps/breeze#5493
wave_issue: LanternOps/breeze#5500
---

# Wave 07 — Windows recovery media (WinPE media builder) + console on WinPE; lab proof on lab-hyperv-host — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Breeze operator builds Windows recovery media on one of their own Windows devices (Breeze never ships WinPE). They boot a blank or replacement UEFI machine from it, type a recovery code into the same guided console the Linux ISO uses, confirm the target disk, and get the Windows machine back through the W06 engine's `disk:` target. The recovery completes when the restored device checks in. If the source was BitLocker-protected, the restored agent re-encrypts it on first boot under a new, escrowed recovery password. The proof is a nested Gen2 VM on the lab-hyperv-host Hyper-V lab.

**Architecture:** Five PRs on wave #5500. **W07a (agent, "Part of #5500")** runs `breeze-backup recovery-console` on WinPE. It adds a native disk lister (`windisks`) that needs no PowerShell, Windows host seams for the console (WinPE guard, a baked cmdline file instead of `/proc/cmdline`, `wpeutil` power, `cmd.exe` shell, a single-key countdown), a typed refusal code so the console can offer the engine's existing `ForceDisk` override for a disk that already holds Windows, a refusal when the WinPE build is older than the guest build, a `mediaPlatform` exchange field so the server refuses a mismatched code *before* spending it, and deterministic TLS roots on WinPE. **W07b (agent, "Part of #5500")** adds the media builder `breeze-backup build-recovery-media`. It finds an installed ADK and WinPE add-on, then copies the WinPE template from the ADK, adds the W06-contract optional components with the ADK's own DISM, layers in its own executable plus a console launcher, and writes a UEFI ISO with the ADK's `oscdimg`. The output is a `.sha256` and a build record. The builder runs on the operator's device as a CLI and as the `build_recovery_media` helper command. A hosted Windows CI job builds the media and checks its structure, but never uploads it. **W07c (API + web, "Part of #5500")** adds the `recovery_media_builds` table (shape 1 + device, every cascade list), the build/list routes, a result handler for the command, Windows entries in the boot-media catalog, and the web UI. **W07d (agent + API, "Part of #5500")** adds the first-boot `post-restore-actions.json` executor that W06 deferred (D-BL). **W07e (docs + lab, "Closes #5500")** covers docs, the spec amendment, the ledger rows and the lab-hyperv-host proof.

**Tech Stack:** Go 1.26 (`agent/internal/{recoveryconsole,backup/rebuild,backup/bmr,backup/windisks,backup/winpemedia,heartbeat}`, `agent/cmd/breeze-backup`), `golang.org/x/sys/windows` (+ `registry`); Windows ADK + WinPE add-on tools (`dism.exe`, `oscdimg.exe`, `efisys.bin`) invoked **from the ADK install by absolute path**; WinPE inbox `wpeinit.exe`, `wpeutil.exe`, `cmd.exe`; Hono + zod + Drizzle + Vitest (`apps/api`); PostgreSQL migration; React + Vitest (`apps/web`); GitHub `windows-latest` (build-only gate); lab-hyperv-host Hyper-V lab (nested Gen2 VM).

**Spec:** `docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md`, specifically §2 #3 (Windows media is built on a customer machine, because the ADK/WinPE licence forbids redistribution), #4 (no secrets on media), #6 (identity, check-in completion), §6.1 (Windows offline apply: host `bcdboot` only, no driver injection, BitLocker restored plaintext and the executor ships with W07), §7.2 (media builder), §7.3 (console), §8.1 (codes + state machine, reused unchanged), §9 (wrong-disk protection), §10 (lab: "Windows media built on WIN-A"), §11 wave 7, and the §12 tail notes D-BL / D-ACL. W06 plan Part 0 §4 "W07 contract" and the Part B/C "as built" blocks are binding: `docs/superpowers/plans/backup/2026-09-22-bare-metal-w06-windows-engine.md`.

**Depends on:** W04a (codes, exchange, progress, marker, check-in), W04b (`recoveryconsole`, the `recovery-console` command, the boot-media catalog route), W06 a–d (Windows engine, `disk:` targets gated on WinPE, `bare_metal_recoveries.platform`), W09 (scope widening at exchange). All merged on main.

---

## Decisions (resolved by Todd 2026-10-03: all six defaults accepted)

Each item below is **decided as its default**: (1) refuse without ADK, (2) ISO stays on the builder device, metadata only in Breeze, (3) no operator drivers in W07, (4) no console DC override, (5) build-only hosted CI + manual lab-hyperv-host boot proof, (6) automatic BitLocker re-encryption after check-in + escrow. The original framing is kept below for context.

1. **ADK install.** Should the builder (a) **refuse** when the Windows ADK + WinPE add-on are not already installed and print where to get them *(default)*, or (b) download and silently install them on the operator's device (≈3–4 GB, `/quiet` install, implies accepting Microsoft's ADK licence on the customer's behalf, Authenticode-verified Microsoft signer)? Option (b) adds one task to Part B.
2. **Where the ISO lives.** Should the built ISO (a) **stay on the builder device** under `%ProgramData%\Breeze\recovery-media\`, with Breeze storing only metadata (hash, size, versions, path) *(default)*, or (b) be uploaded to org backup storage so other techs can download it through Breeze? (b) is a licensing call: Breeze would be moving WinPE bits between machines.
3. **Hardware drivers in the WinPE image.** Should the builder accept an operator-supplied folder of **signed** NIC/storage drivers to add to the boot image at build time (`dism /Add-Driver` without `/ForceUnsigned`)? The default is **no for W07**: WinPE inbox drivers only, plus a follow-up issue. Drivers from the *backup* are never added, whatever the answer (see Global Constraints).
4. **Domain controllers from the console.** The engine refuses a DC source unless `AllowDomainController`. Should the console offer a typed override? The default is **no**: the console shows the refusal, and the `[s]hell` option leaves the CLI path open for an operator who reads the DC guidance.
5. **CI boot gate.** Is a self-hosted Windows runner (on the lab-hyperv-host lab) acceptable for an automated "boot WinPE media → rebuild → boot" gate? The default is **no**: hosted CI does a build-only structure gate, and the boot proof is the manual lab-hyperv-host lab run (spec §10 already calls the self-hosted ADK runner "later wave").
6. **BitLocker re-encryption.** The default follows the spec (§6, D-BL): the executor runs **automatically** on first boot, after check-in and only once the new recovery password is escrowed. A machine with no ready TPM is skipped with a warning on the recovery. The alternative is to wait for an operator "re-encrypt" action in the UI.

---

## Global Constraints

- **Licensing (spec §2 #3).** No WinPE binary, WIM, ISO or ADK file ever lands in the repo, a release asset, a GitHub Actions artifact (the repo is public, so artifacts are publicly downloadable), the API image or Breeze storage (pending Q2). The hosted CI gate builds and inspects the media inside one job and deletes it. Breeze ships only its own inputs: `breeze-backup-windows-amd64.exe` (already in the signed `release-artifact-manifest.json`) and the builder logic compiled into it.
- **Builder tools come from the ADK, by absolute path.** `KitsRoot10` is read from `HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows Kits\Installed Roots` (and also from the 64-bit view). It is refused unless it sits under `%ProgramFiles(x86)%` or `%ProgramFiles%` as the OS reports them. The tools are `<KitsRoot10>Assessment and Deployment Kit\Deployment Tools\amd64\DISM\dism.exe` and `…\Deployment Tools\amd64\Oscdimg\oscdimg.exe` + `efisys.bin`; the WinPE template comes from `…\Windows Preinstallation Environment\amd64\` (`en-us\winpe.wim`, `Media\`, `WinPE_OCs\`). Nothing resolves through `PATH`. A missing tool or template is a refusal naming the path.
- **Never execute image-provided code (W06 rule, extended).** The console in WinPE runs only WinPE-inbox tools, by absolute path from the WinPE Windows directory (`hosttool.SystemTool`): `wpeutil.exe`, `cmd.exe`. The engine is unchanged: host `bcdboot.exe` only (`hostSystemTool`), and `--drivers` / `Options.DriverDirs` is refused (`DriverInjectionUnsupportedReason`). Nothing from the restored tree or the snapshot is executed, `drvload`ed or DISM-serviced. The spec §7.2 phrase "driver artifacts from the source device's system state" is **not** implemented: the system state carries only `drivers/inventory.csv` (no packages), and loading backup content into the WinPE kernel would break this rule. This is deviation **D7-DRV**, recorded in the spec amendment (Task 16).
- **Hive and volume rules stay as built (W06 Part B/C).** `RegLoadKeyW` only under `backup.AcquireHivePrivileges()`, run-scoped `HKLM\BRZ_*` mounts, read-only loads for inspection (`LoadHiveReadOnly`), every read or write of the restored tree through the GUID volume path (`r.rootVolume`) and never through a folder mount. W07 adds one read-only hive inspection (the staged `SOFTWARE` artifact for the build check, Task 4) and follows the same pattern as `isDomainController`.
- **WinPE contract (W06 Part 0 §4).** Optional components `WinPE-WMI`, `WinPE-SecureStartup`, `WinPE-EnhancedStorage` (each + its `en-us` language cab). Scratch space `dism /Set-ScratchSpace:512`. `X:` holds `X:\breeze\` (payload) and `X:\ProgramData\Breeze\rebuild\` (`StateDir`). `disk:` WorkRoot stays `<root>\$breeze-rebuild-work` (engine-owned). Media volume layout keeps `\sources\boot.wim` (what `MediaDiskNumbers` looks for). UEFI only (amd64; arm64 WinPE out of scope). The ISO uses `efisys.bin` (the "press any key" variant), so after the post-restore reboot the machine falls through to the restored disk instead of booting the media again.
- **WinPE build ≥ guest build** for `disk:` targets. The check runs in `winPreflight`, before anything is written (Task 4). `vhdx:` on a live host is untouched.
- **Media payload (`X:\breeze\`)** — `breeze-backup.exe` (a byte copy of the builder's own `os.Executable()`, SHA-256 recorded), `cmdline.txt` (`breeze.media=1`), `recovery-server` (the server URL from the build payload, not secret), `roots.pem` (the builder's `ROOT` store, exported), `media.json`, and `breeze-recovery.cmd`. `X:\Windows\System32\winpeshl.ini` launches `wpeinit.exe`, then `cmd.exe /c X:\breeze\breeze-recovery.cmd`. **No tokens, codes, keys, passwords or recovery material on the media.** A CI/test build may add `breeze.ci=1 …` to `cmdline.txt` only when the binary was linked with the `unattendedCmdlineEnabled=1` ldflag (unchanged W04b gate).
- **Console parity.** The same `recoveryconsole.Console.Run` serves both platforms, with the same prompts, statuses and transcript. Only the host seams differ (`recovery_console_host_{windows,other}.go`). `--unattended` stays parsed and refused.
- **Server state machine unchanged.** `created → media_booted → planned → restoring → validated → rebooted → checked_in | completed | failed | refused`. The one new gate is `mediaPlatform` at exchange (409 `media_platform_mismatch`, before the code is claimed, like `helper_version_too_old`).
- **New table `recovery_media_builds`** (shape 1 + `device_id`). RLS policies go in the creating migration. It is registered in `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`), `CORE_DEVICE_CASCADE_DELETE_TABLES` + `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`routes/devices/core.ts`), `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`) and the org-merge registry (`services/orgMergeRegistry.ts`, travels with its device), all in the same PR. The migration must sort after the newest committed file: `2026-12-05-100000-device-live-session-indexes.sql` as of 2026-10-03, so the slot is `2026-12-06-100000-recovery-media-builds.sql`. **Re-check `ls apps/api/migrations | sort | tail -1` at implementation time.** Never use the closed `2026-08-06` block.
- **New command type `build_recovery_media`.** It goes into every registry that lists `bare_metal_rebuild`: `services/commandTypes.ts`, `services/commandOfflinePolicy.ts` (`BACKUP_AND_RESTORE`), `services/commandTimeouts.ts` (own 2 h ceiling), `services/commandQueue.ts` (audited set), `services/partnerTrust.ts` (`GATED_COMMAND_TYPES`); on the agent side `remote/tools/types.go` (`CmdBuildRecoveryMedia`), `heartbeat/handlers_bmr_forward.go` and `cmd/breeze-backup/main.go` (both dispatch switches). `commandOfflinePolicy.test.ts` "covers every CommandTypes value" fails if one is missed.
- **CI lists.** `.github/workflows/ci.yml` `Test Agent (Windows)` package list (the `go test ./internal/sessionbroker …` line) gains `./internal/backup/windisks ./internal/backup/winpemedia ./internal/recoveryconsole`. `.github/scripts/qemu-gate-paths.txt` gains `agent/internal/backup/windisks/` and `agent/internal/backup/winpemedia/`: `TestQEMUGatePathsMatchBackupDependencySet` names the exact lines.
- **Test commands.** Agent: `cd agent && go test -race ./internal/recoveryconsole/... ./internal/backup/... ./cmd/breeze-backup/... ./internal/heartbeat/...`. Cross-compile: `cd agent && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go vet ./internal/recoveryconsole/... ./internal/backup/... ./cmd/breeze-backup/... ./internal/heartbeat/...`. Lint: `golangci-lint run --new-from-rev=origin/main ./...`. API unit: `cd apps/api && npx vitest run <paths>` (never `pnpm … test -- --run`). API integration: `cd apps/api && npx vitest run -c vitest.integration.config.ts <paths>` (needs a DB). Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=14336 npx tsc --noEmit -p tsconfig.json; echo exit=$?`. Never pipe tsc to tail. Web: `cd apps/web && npx vitest run <paths>`. Red first, every task.
- **Public repo.** No IPs, internal hostnames or per-tool security-gap tables in code, tests or docs. The lab is "the nested Gen2 Hyper-V lab host on lab-hyperv-host"; rig names already in the campaign doc (WIN-A, lab-hyperv-host) are fine.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Implementation branch: `feature/5493-bare-metal-boot-media/wave-5500` (`start_wave` first).

## Review Focus

Inputs the spec implies that no existing test exercises. Each line's test is pinned to its owning task.

1. **A Linux snapshot's code typed into Windows media (or the reverse).** The server refuses with `media_platform_mismatch` *before* `codeUsedAt` is written. The code still works on the right media. *(Task 5 `exchange: mediaPlatform mismatch → 409 before claim`; console prints the message without spending another attempt, `TestConsole_MediaPlatformMismatchIsTerminal`.)*
2. **The target disk is the machine's own original disk and still holds a (broken) Windows.** That is the most common real bare-metal case. The dry-run refusal carries `RefusalCode "disk_has_windows"`, and the console offers a typed `OVERWRITE`, then reruns with `ForceDisk`. Every other refusal stays terminal. *(Task 3 `TestConsole_DiskHasWindowsOffersOverwrite`, `TestConsole_OtherRefusalNoOverwrite`; engine `TestWinPreflight_DiskHasWindowsCarriesCode`.)*
3. **Media built from an older ADK than the guest's Windows build** (for example a WinPE 22621 console restoring a 26100 guest). It is refused in preflight, before provisioning, with both builds named. A missing `SOFTWARE` artifact gives a warning, not a pass. *(Task 4 `TestWinPreflight_RefusesOlderWinPEThanGuest`, `…_MissingSoftwareArtifactWarns`.)*
4. **WinPE cannot validate the server's TLS chain** (minimal root store, no root auto-update). The console uses the builder's exported roots plus the optional pin, and never falls back to `insecure`. *(Task 6 `TestLoadMediaRoots_UsedByEveryRecoveryClient`, `TestLoadMediaRoots_MissingFileKeepsSystemRoots`.)*
5. **A builder device without the ADK, without the WinPE add-on, or with `KitsRoot10` pointing outside Program Files.** Each is refused before any file is written, naming the missing path and the download page. *(Task 7 `TestDiscoverADK_*` table.)*

---

## 0. Ground truth (verified 2026-10-03 on main @ `e88f121351`)

**Console (W04b).** `agent/internal/recoveryconsole/console.go`: `IO` `:25`, `Deps` `:37-80` (`Exchange, Collect, MediaSources, Rebuild, Provider, WidenScope, Progress, Power, Shell, AcquireLock, Version`), `Console{IO, Deps, Cmdline, DefaultServer, AllowHost}` `:82`, `Run` `:147`. The guard is `ParseKernelCmdline(c.Cmdline)` (`cmdline.go`), which needs `breeze.media=1` unless `AllowHost`. `baseOpts` is built at `:309-321` (`Target{Kind: TargetDisk, Path: disk.Path}`, `RegenerateInitramfs: true`, `ExpectSystemState`, `Integrity`). The dry-run/refusal loop `:323-342` posts `refused`/`failed` and offers `[r]etry/[s]hell/[p]oweroff`. `chooseDisk` `:848`, `confirmDisk` `:899` (serial, or `ERASE` when there is none). `CandidateDisks` (`disks.go`) drops `Removable`, `IsSystem` and media-backing disks by name. `buildflags.go`: the `unattendedCmdlineEnabled` ldflag gate. `prompts.go`: `ReadKeyWithTimeout` uses `stty`, so on Windows it degrades to "no key". Command: `agent/cmd/breeze-backup/recovery_console_cmd.go`. It reads `/proc/cmdline`, **returns `rebuild.ErrUnsupportedHost` when `rebuild.NewSystem()` is nil (always, off Linux)**, reads baked `/etc/breeze-recovery-server` and `/etc/breeze-recovery-trust-pin`, and uses `Power` = `systemctl`, `Shell` = `/bin/bash`, `AcquireLock` = `/run/…lock`. `recovery_console_lock_windows.go` is a stub (`processAlive` → true).

**Engine (W06, as built).** `rebuild.WinSystem` (`winsystem.go:24`): `InWinPE()` (MiniNT key), `SystemDiskNumber()` (−1 on WinPE), `MediaDiskNumbers()` (volumes with `\sources\boot.wim`), `DiskInfo`, `VolumesOnDisk`, `HasWindowsTree`, `LoadHiveReadOnly`, and others. `winPreflight` (`win_preflight.go`): a `disk:` target must be in WinPE (`:50`); `parseDiskTargetPath` requires the exact prefix `\\.\PhysicalDrive` (`:252`); it refuses the system disk, the media disk, read-only/offline disks, and a disk with a Windows tree unless `ForceDisk` (`:86-97`, reason `target disk %d contains a Windows installation; pass --force-disk to overwrite it`). `preflightVerify` stages system state, then `isDomainController` (`:131`, `:157-191`, read-only staged-hive pattern). `RefusalError{Reason}` (`types.go:~360`) is mapped in `engine.go:234-237,280-283` to `Result.Refusal`. `DriverDirs` is refused in `Run` (`engine.go:171`). `hostSystemTool` (`win_boot.go:46`) and the twin `hosttool.SystemTool` (`internal/backup/hosttool/hosttool.go`, seam `windowsDir`). `winEncryption` (`win_encryption.go`) writes `<root>\ProgramData\Breeze\data\post-restore-actions.json` = `{"schemaVersion":1,"bitlocker":{"reencrypt":true,"volume":"C:"},"winre":{"enable":false,"reason":"…"}}` for `disk:` targets only. Layout `OSRelease` is a caption with no build number (`layout/windows_parse.go:93`). The Windows layout collector (`layout/collect_windows.go`) shells out to **PowerShell `Get-Disk`**, which WinPE lacks without extra components.

**bmr client.** `ExchangeRecoveryCode(ctx, server, code, helperVersion)` (`bmr/session.go:188`), request struct `exchangeCodeRequest` `:174`. A 409 is a terminal negotiation refusal (`parseRecoveryNegotiationError`). `newHTTPClient` (`session.go:27`) uses default roots + `verifyPinnedServerCert`. `noAuthRedirectClient` (`download_provider.go:162`) uses the default transport. `SetExpectedServerCertPin` (`certpin.go:51`).

**API.** Exchange: `routes/backup/bmrRecoveries.ts:444-560`. The `helper_version_too_old` gate runs before the claim (`:497-513`). `rec.platform` is available (`db/schema/bareMetalRecoveries.ts:47`). `bmrExchangeSchema` is in `routes/backup/schemas.ts:396`. Catalog: `GET /bmr/boot-media` (`routes/backup/bmr.ts:1032-1065`, Linux rows only). The command dispatch pattern is `services/bareMetalRebuildCommand.ts` (`queueCommandForExecution…`, audit). Result post-processing is in `routes/agents/commands.ts:~580-640` and the WebSocket twin `routes/agentWs.ts:~2440-2470`. Heartbeat marker check-in: `routes/agents/heartbeat.ts:1273-1310`. Recovery keys ingest: `routes/agents/recoveryKeys.ts` (schema `routes/agents/schemas.ts:608`, `source: 'snapshot'|'rotation'`). The table pattern to mirror is `migrations/2026-10-15-160200-bare-metal-recoveries.sql` (org + device FKs `ON DELETE CASCADE`, four `breeze_org_isolation_*` policies).

**Agent forwarding.** `heartbeat/handlers_bmr_forward.go` (`handlerRegistry[tools.CmdBareMetalRebuild]`, `forwardToBackupHelper(h, cmd, wait)`). Helper dispatch: `cmd/breeze-backup/main.go:798` (no-manager switch) and `:940`. BitLocker: `security.CollectRecoveryKeys`, `RotateBitLockerKey` (`internal/security/recoverykeys.go`, PowerShell). Escrow: `(*Heartbeat).pushRecoveryKeys(source, keys) error` (`heartbeat.go:4092`). Marker ack: `processHeartbeatResponse` (`heartbeat.go:5144`), `AcknowledgeRecoveryMarker` → `recovery-marker.acked.json`.

**Web.** `components/backup/RecoveryBootstrapTab.tsx`: `RecoveryMediaCatalogEntry` `:122`, catalog fetch `:504-540`, `runAction` already imported (`:20`). `hooks/useDeviceOptions` (`osType: 'windows'` filter, used by `VMRestoreWizard.tsx:203`). Locales `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/backup.json`, namespace `recoveryBootstrapTab`.

**CI/release.** `release.yml` `build-recovery-media` (Linux ISO); `breeze-backup-windows-amd64.exe` is in the manifest with `platformTrust: "none"` (agent family, not Authenticode-signed). `ci.yml` `test-agent-windows` (`:1810`), `recovery-media-e2e` (`:2404`), `changes` classifier.

**Lab (campaign doc §11.1).** W06d proved, on the nested Gen2 Hyper-V lab host on lab-hyperv-host: a whole-machine Windows `system_image` backup (133k files, 2 h 27 m), a Restore-as-VM rebuild (restore phase 5 h 23 m, tracked as #7333) and a boot. The restore throughput is the long pole for this wave's lab run as well.

## 0.1 Deliberate deviations and non-goals (say so in each PR)

- **D7-DRV.** No drivers from the source device's system state go into the media (spec §7.2 text). WinPE inbox drivers only; operator-supplied signed WinPE drivers wait on Q3.
- **D7-LOCAL.** The ISO stays on the builder device (pending Q2). The boot-media page lists the build and where it is, with no download button.
- **D7-NOAUTOINSTALL.** The ADK is not auto-installed (pending Q1).
- **D7-NOLOCK.** The Windows console takes no cross-instance lock. `winpeshl.ini` starts exactly one console. The Linux lock exists because tty1 and ttyS0 both start one. This is documented in the `recovery_console_host_windows.go` doc comment.
- **D7-NOCIBOOT.** Hosted CI builds and inspects the media but cannot boot it (no nested virtualization). The boot proof is the lab-hyperv-host lab (pending Q5).
- **Unchanged and out of scope:** WinRE re-staging; captured driver packages; multi-volume Windows sources; BIOS/MBR; arm64 WinPE; unattended recovery; static-IP prompting in WinPE (DHCP via `wpeinit`; `[s]hell` → `netsh` for static setups, documented).

---

## Part A — W07a: the console on WinPE (PR 1, "Part of #5500")

### Task 1: `windisks` — native physical-disk enumeration (no PowerShell)

**Files:**
- Create: `agent/internal/backup/windisks/windisks.go` (untagged: types + pure decoder), `windisks_windows.go` (real IOCTLs), `windisks_other.go` (`List` returns `ErrUnsupported`), `windisks_test.go`

**Interfaces:**
- Produces:
```go
package windisks

type Disk struct {
	Number    int
	Path      string // \\.\PhysicalDrive<n> — exactly the engine's parseDiskTargetPath prefix
	Model     string // vendor + " " + product, trimmed
	Serial    string
	SizeBytes int64
	BusType   uint32
	Removable bool // RemovableMedia || BusType in {USB 7, SD 12, MMC 13}
}
var ErrUnsupported = errors.New("windisks: not supported on this platform")
func List() ([]Disk, error)                                  // probes PhysicalDrive0..63, skips absent
func DecodeDeviceDescriptor(b []byte) (model, serial string, busType uint32, removable bool, err error)
```

- [ ] **Step 1: Write the failing test** (`windisks_test.go`, runs on every OS):

```go
package windisks

import (
	"encoding/binary"
	"testing"
)

// descriptor builds a STORAGE_DEVICE_DESCRIPTOR: header (36 bytes) then the
// NUL-terminated strings at the recorded offsets. Offset 0 = absent.
func descriptor(removable bool, bus uint32, vendor, product, serial string) []byte {
	b := make([]byte, 36)
	binary.LittleEndian.PutUint32(b[0:], 1)
	if removable {
		b[10] = 1
	}
	put := func(off int, s string) {
		if s == "" {
			return
		}
		binary.LittleEndian.PutUint32(b[off:], uint32(len(b)))
		b = append(b, append([]byte(s), 0)...)
	}
	put(12, vendor)
	put(16, product)
	put(24, serial)
	binary.LittleEndian.PutUint32(b[28:], bus)
	binary.LittleEndian.PutUint32(b[4:], uint32(len(b)))
	return b
}

func TestDecodeDeviceDescriptor(t *testing.T) {
	cases := []struct {
		name                  string
		in                    []byte
		model, serial         string
		bus                   uint32
		removable, wantErr    bool
	}{
		{"hyper-v scsi", descriptor(false, 1, "Msft    ", "Virtual Disk    ", "  6002248  "), "Msft Virtual Disk", "6002248", 1, false, false},
		{"nvme no vendor", descriptor(false, 17, "", "Samsung SSD 980", "S64DNX0R"), "Samsung SSD 980", "S64DNX0R", 17, false, false},
		{"usb stick", descriptor(false, 7, "SanDisk", "Ultra", "4C53"), "SanDisk Ultra", "4C53", 7, true, false},
		{"removable flag", descriptor(true, 11, "", "SATA disk", ""), "SATA disk", "", 11, true, false},
		{"no serial", descriptor(false, 11, "", "WDC", ""), "WDC", "", 11, false, false},
		{"short buffer", make([]byte, 20), "", "", 0, false, true},
		{"offset past end", func() []byte { b := descriptor(false, 11, "", "X", ""); binary.LittleEndian.PutUint32(b[16:], 9999); return b }(), "", "", 0, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			model, serial, bus, rem, err := DecodeDeviceDescriptor(tc.in)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if tc.wantErr {
				return
			}
			if model != tc.model || serial != tc.serial || bus != tc.bus || rem != tc.removable {
				t.Fatalf("got (%q,%q,%d,%v) want (%q,%q,%d,%v)", model, serial, bus, rem, tc.model, tc.serial, tc.bus, tc.removable)
			}
		})
	}
}
```

- [ ] **Step 2: Run to verify failure.** `cd agent && go test ./internal/backup/windisks/` → `undefined: DecodeDeviceDescriptor`.

- [ ] **Step 3: Implement.** `windisks.go`:

```go
// Package windisks lists physical disks on Windows with
// IOCTL_STORAGE_QUERY_PROPERTY + IOCTL_DISK_GET_LENGTH_INFO, for the
// recovery console on WinPE, where PowerShell's Get-Disk (the layout
// collector's path) is not available.
package windisks

import (
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
)

type Disk struct {
	Number    int
	Path      string
	Model     string
	Serial    string
	SizeBytes int64
	BusType   uint32
	Removable bool
}

var ErrUnsupported = errors.New("windisks: not supported on this platform")

const (
	busUSB = 7
	busSD  = 12
	busMMC = 13
	descriptorHeader = 36
)

func DecodeDeviceDescriptor(b []byte) (model, serial string, busType uint32, removable bool, err error) {
	if len(b) < descriptorHeader {
		return "", "", 0, false, fmt.Errorf("storage device descriptor is %d bytes, need %d", len(b), descriptorHeader)
	}
	str := func(off int) (string, error) {
		o := binary.LittleEndian.Uint32(b[off:])
		if o == 0 {
			return "", nil
		}
		if int(o) >= len(b) {
			return "", fmt.Errorf("descriptor string offset %d past end (%d)", o, len(b))
		}
		end := int(o)
		for end < len(b) && b[end] != 0 {
			end++
		}
		return strings.TrimSpace(string(b[o:end])), nil
	}
	vendor, err := str(12)
	if err != nil {
		return "", "", 0, false, err
	}
	product, err := str(16)
	if err != nil {
		return "", "", 0, false, err
	}
	serial, err = str(24)
	if err != nil {
		return "", "", 0, false, err
	}
	busType = binary.LittleEndian.Uint32(b[28:])
	removable = b[10] != 0 || busType == busUSB || busType == busSD || busType == busMMC
	model = strings.TrimSpace(strings.TrimSpace(vendor) + " " + product)
	return model, serial, busType, removable, nil
}
```

`windisks_windows.go` (`//go:build windows`): for `n := 0; n < 64; n++`, open `\\.\PhysicalDrive<n>` with access `0` and share read/write (`windows.CreateFile`). Skip on `ERROR_FILE_NOT_FOUND`/`ERROR_PATH_NOT_FOUND`, and return any other error. Send `IOCTL_STORAGE_QUERY_PROPERTY` (`0x2D1400`) with a 12-byte `STORAGE_PROPERTY_QUERY{PropertyId: 0, QueryType: 0}` into a 1024-byte buffer, then `DecodeDeviceDescriptor`. Reopen with `GENERIC_READ` for `IOCTL_DISK_GET_LENGTH_INFO` (`wingpt.IOCTLDiskGetLengthInfo`). Set `Path = fmt.Sprintf(`\\.\PhysicalDrive%d`, n)`. `windisks_other.go` (`//go:build !windows`): `func List() ([]Disk, error) { return nil, ErrUnsupported }`.

- [ ] **Step 4: Run, cross-compile, commit.**

```bash
cd agent && go test -race ./internal/backup/windisks/ && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go vet ./internal/backup/windisks/
git add agent/internal/backup/windisks && git commit -m "feat(backup): windisks — native physical-disk listing for the WinPE console (W07a)"
```

---

### Task 2: Console host seams for Windows/WinPE

**Files:**
- Create: `agent/cmd/breeze-backup/recovery_console_host.go` (untagged `type consoleHost struct`, `newConsoleHost` var seam), `recovery_console_host_windows.go`, `recovery_console_host_other.go`, `recovery_console_host_test.go`
- Create: `agent/internal/recoveryconsole/prompts_windows.go` (`readOneKey` via console input wait) and move the `stty` `readOneKey` into `prompts_unix.go` (`//go:build !windows`)
- Modify: `agent/cmd/breeze-backup/recovery_console_cmd.go` (use `consoleHost`; the `rebuild.NewSystem()` nil check moves into the Linux host)

**Interfaces:**
- Consumes: `windisks.List` (Task 1), `rebuild.NewWinSystem()` (`InWinPE`, `MediaDiskNumbers`), `hosttool.SystemTool`.
- Produces (untagged, so tests run everywhere):
```go
// consoleHost is everything recovery-console needs from the OS it boots on.
type consoleHost struct {
	Cmdline        func() (string, error)      // Linux: /proc/cmdline; Windows: <exeDir>\cmdline.txt, "" unless InWinPE
	BakedServer    string                      // path of the baked server-URL file
	BakedTrustPin  string
	BakedRoots     string                      // Windows: <exeDir>\roots.pem; Linux: "" (system store)
	Collect        func(ctx context.Context) (*layout.Manifest, error)
	MediaSources   func() ([]string, error)
	Power          func(action string) error   // "reboot" | "poweroff"
	Shell          func() error
	AcquireLock    func(ctx context.Context, out io.Writer) (func(), error) // nil on Windows (D7-NOLOCK)
	HostCheck      func() error                // Linux: rebuild.NewSystem()!=nil else ErrUnsupportedHost
}
var newConsoleHost = defaultConsoleHost // per-OS file
func disksToManifest(ds []windisks.Disk) *layout.Manifest // untagged, tested
func winPEPowerArgs(action string) (exe string, args []string, err error)
```

- [ ] **Step 1: Write the failing tests** (`recovery_console_host_test.go`, untagged):

```go
func TestDisksToManifest_PathsAndFlags(t *testing.T) {
	m := disksToManifest([]windisks.Disk{
		{Number: 0, Path: `\\.\PhysicalDrive0`, Model: "Msft Virtual Disk", Serial: "6002248", SizeBytes: 80 << 30},
		{Number: 1, Path: `\\.\PhysicalDrive1`, Model: "SanDisk Ultra", Removable: true, SizeBytes: 16 << 30},
	})
	if m.Platform != "windows" || len(m.Disks) != 2 {
		t.Fatalf("manifest = %+v", m)
	}
	if m.Disks[0].Name != `\\.\PhysicalDrive0` || m.Disks[0].Serial != "6002248" || m.Disks[0].IsSystem {
		t.Fatalf("disk0 = %+v", m.Disks[0])
	}
	if !m.Disks[1].Removable {
		t.Fatal("usb disk must stay removable so CandidateDisks drops it")
	}
	got := recoveryconsole.CandidateDisks(m, []string{`\\.\PhysicalDrive1`})
	if len(got) != 1 || got[0].Path != `\\.\PhysicalDrive0` {
		t.Fatalf("candidates = %+v", got)
	}
}

func TestWinPEPowerArgs(t *testing.T) {
	for _, tc := range []struct{ action, arg string; err bool }{
		{"reboot", "reboot", false}, {"poweroff", "shutdown", false}, {"halt", "", true},
	} {
		exe, args, err := winPEPowerArgs(tc.action)
		if (err != nil) != tc.err {
			t.Fatalf("%s: err=%v", tc.action, err)
		}
		if tc.err {
			continue
		}
		if !strings.HasSuffix(strings.ToLower(exe), `\system32\wpeutil.exe`) || len(args) != 1 || args[0] != tc.arg {
			t.Fatalf("%s → %s %v", tc.action, exe, args)
		}
	}
}

func TestRecoveryConsole_WindowsHostOutsideWinPERefuses(t *testing.T) {
	restore := setConsoleHostForTest(consoleHost{
		Cmdline:   func() (string, error) { return "", nil }, // not WinPE → no media cmdline
		HostCheck: func() error { return nil },
	})
	defer restore()
	cmd := newRecoveryConsoleCommand()
	cmd.SetArgs(nil)
	var out bytes.Buffer
	cmd.SetOut(&out)
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "not recovery media") {
		t.Fatalf("err = %v", err)
	}
}
```

Also in `recoveryconsole`: `prompts_windows_test.go` (`//go:build windows`) asserts that `NewTerminalIO(strings.NewReader(""), io.Discard).ReadKeyWithTimeout(10*time.Millisecond)` returns `(0, false)` within 1 s when stdin is not a console. That is the degrade path; the real keypress is lab-verified.

- [ ] **Step 2: Run to verify failure.** `cd agent && go test ./cmd/breeze-backup/ -run 'DisksToManifest|WinPEPowerArgs|WindowsHostOutsideWinPE'` → undefined symbols.

- [ ] **Step 3: Implement.**

`recovery_console_host.go` (untagged):

```go
func disksToManifest(ds []windisks.Disk) *layout.Manifest {
	m := &layout.Manifest{SchemaVersion: layout.SchemaVersion, Platform: "windows", BootMode: layout.BootModeUEFI}
	for _, d := range ds {
		m.Disks = append(m.Disks, layout.Disk{Name: d.Path, Model: d.Model, Serial: d.Serial, SizeBytes: d.SizeBytes, Removable: d.Removable})
	}
	return m
}

func winPEPowerArgs(action string) (string, []string, error) {
	switch action {
	case "reboot":
		return hosttool.SystemTool("wpeutil.exe"), []string{"reboot"}, nil
	case "poweroff":
		return hosttool.SystemTool("wpeutil.exe"), []string{"shutdown"}, nil
	}
	return "", nil, fmt.Errorf("unknown power action %q", action)
}

func setConsoleHostForTest(h consoleHost) func() {
	orig := newConsoleHost
	newConsoleHost = func() consoleHost { return h }
	return func() { newConsoleHost = orig }
}
```

(Check `layout.Disk`'s exact field names in `layout/types.go:80-100` before writing: `Name`, `Model`, `Serial`, `SizeBytes`, `Removable`, `IsSystem`.)

`recovery_console_host_windows.go` (`//go:build windows`):

```go
// D7-NOLOCK: on WinPE, winpeshl.ini starts exactly one console (no serial
// getty twin, unlike the Linux media), so no cross-instance lock is taken.
func defaultConsoleHost() consoleHost {
	exeDir := executableDir()
	ws := rebuild.NewWinSystem()
	return consoleHost{
		Cmdline: func() (string, error) {
			if ws == nil || !ws.InWinPE() {
				return "", nil // the guard then refuses unless --allow-host
			}
			b, err := os.ReadFile(filepath.Join(exeDir, "cmdline.txt"))
			if errors.Is(err, fs.ErrNotExist) {
				return "", nil
			}
			return string(b), err
		},
		BakedServer:   filepath.Join(exeDir, "recovery-server"),
		BakedTrustPin: filepath.Join(exeDir, "recovery-trust-pin"),
		BakedRoots:    filepath.Join(exeDir, "roots.pem"),
		Collect: func(context.Context) (*layout.Manifest, error) {
			ds, err := windisks.List()
			if err != nil {
				return nil, err
			}
			return disksToManifest(ds), nil
		},
		MediaSources: func() ([]string, error) {
			nums, err := ws.MediaDiskNumbers()
			out := make([]string, 0, len(nums))
			for _, n := range nums {
				out = append(out, fmt.Sprintf(`\\.\PhysicalDrive%d`, n))
			}
			return out, err
		},
		Power: func(action string) error {
			exe, args, err := winPEPowerArgs(action)
			if err != nil {
				return err
			}
			return exec.Command(exe, args...).Run()
		},
		Shell: func() error {
			c := exec.Command(hosttool.SystemTool("cmd.exe"))
			c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
			return c.Run()
		},
		HostCheck: func() error {
			if ws == nil {
				return rebuild.ErrUnsupportedHost
			}
			return nil
		},
	}
}
```

`recovery_console_host_other.go` (`//go:build !windows`): wraps today's behaviour: `Cmdline` reads `--kernel-cmdline` (default `/proc/cmdline`), baked files `/etc/breeze-recovery-server` / `-trust-pin`, `BakedRoots: ""`, `Collect: layout.Collect`, `MediaSources: rebuild.NewSystem().RootSources`, `Power: systemctl`, `Shell: runRecoveryShell`, `AcquireLock: acquireRecoveryConsoleLock`, `HostCheck: NewSystem() != nil`. `--kernel-cmdline`, when set explicitly, overrides `Cmdline` on both OSes (tests).

`recovery_console_cmd.go` `RunE`: replace the direct `/proc/cmdline` read, `rebuild.NewSystem()` check, baked paths and Deps literals with `h := newConsoleHost()`, then `h.HostCheck()`, `raw, err := h.Cmdline()`, `readBakedRecoveryConfig(h.BakedServer)`, and so on. Set `Deps.AcquireLock` only when `h.AcquireLock != nil`. `Rebuild`, `Provider`, `WidenScope`, `Progress`, `Exchange` and `Version` stay as they are.

`prompts_windows.go`: `readOneKey(d)` = `windows.WaitForSingleObject(windows.Stdin, ms)`. On `WAIT_OBJECT_0`, `windows.ReadConsoleInput` until a key-down event and return its rune. On anything else, `(0, false)`. `prompts_unix.go` holds the existing `stty` code unchanged.

- [ ] **Step 4: Run, cross-compile, commit.**

```bash
cd agent && go test -race ./cmd/breeze-backup/ ./internal/recoveryconsole/ && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go vet ./cmd/breeze-backup/ ./internal/recoveryconsole/
git add agent/cmd/breeze-backup agent/internal/recoveryconsole && git commit -m "feat(breeze-backup): recovery-console runs on WinPE — host seams, native disks, wpeutil power (W07a)"
```

---

### Task 3: Typed refusal code + console `OVERWRITE` flow for a disk that already holds Windows

**Files:**
- Modify: `agent/internal/backup/rebuild/types.go` (`RefusalError.Code`, `Result.RefusalCode`, const `RefusalCodeDiskHasWindows = "disk_has_windows"`), `engine.go:234-237,280-283` (copy `ref.Code`), `win_preflight.go:~93` (set `Code`)
- Modify: `agent/internal/recoveryconsole/console.go` (dry-run refusal branch)
- Test: `agent/internal/backup/rebuild/win_preflight_test.go`, `agent/internal/recoveryconsole/console_test.go`

**Interfaces:**
- Produces: `type RefusalError struct{ Reason, Code string }`, `Result.RefusalCode string \`json:"refusalCode,omitempty"\``, `rebuild.RefusalCodeDiskHasWindows`. The console's `baseOpts.ForceDisk` is set only after a typed `OVERWRITE`.

- [ ] **Step 1: Failing tests.**

`win_preflight_test.go` (uses the existing `newFakeWinSystem`, `winFakeOptions` and `withHostPlatformWindows` fixtures; the fake must report `InWinPE: true` and `HasWindowsTree: true` for disk 2):

```go
func TestWinPreflight_DiskHasWindowsCarriesCode(t *testing.T) {
	defer withHostPlatformWindows(t)()
	fs := newFakeWinSystem(t)
	fs.inWinPE = true
	fs.windowsTreeOnDisk[2] = true
	opts := winFakeOptions(t, fs)
	opts.Target = Target{Kind: TargetDisk, Path: `\\.\PhysicalDrive2`}
	opts.DryRun = true
	res, err := Run(context.Background(), opts)
	var ref *RefusalError
	if !errors.As(err, &ref) || ref.Code != RefusalCodeDiskHasWindows {
		t.Fatalf("err = %v", err)
	}
	if res.Status != "refused" || res.RefusalCode != RefusalCodeDiskHasWindows {
		t.Fatalf("result = %+v", res)
	}
}
```

(Name the fake's fields after what `winsystem_fake_test.go` actually exposes: read it first, and add `inWinPE` / `windowsTreeOnDisk` only if no equivalent exists.)

`console_test.go`:

```go
func TestConsole_DiskHasWindowsOffersOverwrite(t *testing.T) {
	var calls []rebuild.Options
	deps := happyDeps(t) // existing fixture
	deps.Rebuild = func(_ context.Context, o rebuild.Options) (*rebuild.Result, error) {
		calls = append(calls, o)
		if o.DryRun && !o.ForceDisk {
			return &rebuild.Result{Status: "refused", Refusal: "target disk 0 contains a Windows installation; pass --force-disk to overwrite it", RefusalCode: rebuild.RefusalCodeDiskHasWindows}, &rebuild.RefusalError{Reason: "x", Code: rebuild.RefusalCodeDiskHasWindows}
		}
		return planOrCompleted(o), nil // existing helper shape
	}
	io := newScriptIO("https://breeze.example", "abc-def-ghj", "OVERWRITE", "6002248")
	c := &Console{IO: io, Deps: deps, Cmdline: "breeze.media=1"}
	_ = c.Run(context.Background())
	if len(calls) < 3 || !calls[1].ForceDisk || !calls[1].DryRun || !calls[2].ForceDisk {
		t.Fatalf("calls = %+v", calls)
	}
	if !strings.Contains(io.out.String(), "already contains a Windows installation") {
		t.Fatal(io.out.String())
	}
}

func TestConsole_OtherRefusalNoOverwrite(t *testing.T) {
	// a refusal without RefusalCode → [r]etry/[s]hell/[p]oweroff only; typing OVERWRITE is "Invalid choice"
}
```

(Write the second test body in the same style. Its script answers are `…, "OVERWRITE", "p"`, and it asserts no `ForceDisk` call and `Power("poweroff")`.)

- [ ] **Step 2: Run to verify failure.** `cd agent && go test ./internal/backup/rebuild/ -run DiskHasWindows ./internal/recoveryconsole/ -run 'Overwrite'` → unknown field `Code` / `RefusalCode`.

- [ ] **Step 3: Implement.** In the console's dry-run failure branch, before `offerFailureOptions`:

```go
if plan != nil && plan.RefusalCode == rebuild.RefusalCodeDiskHasWindows && !baseOpts.ForceDisk && !ci {
	c.IO.Print("Disk %s already contains a Windows installation. Everything on it will be erased.\n", disk.Path)
	line, err := c.IO.ReadLine("Type OVERWRITE to erase it, or press Enter for other options: ")
	if err != nil {
		return err
	}
	if strings.TrimSpace(line) == "OVERWRITE" {
		baseOpts.ForceDisk = true
		continue
	}
}
```

The serial/`ERASE` confirmation still follows. `OVERWRITE` is in addition to it, not instead of it. CI mode never auto-overwrites. Engine: `win_preflight.go` sets `&RefusalError{Reason: …, Code: RefusalCodeDiskHasWindows}`, and `engine.go` copies `ref.Code` into `r.result.RefusalCode` at both mapping sites. `Result.RefusalCode` is bounded like `Refusal` in the result-truncation helper (`types.go:~312`).

- [ ] **Step 4: Run, commit.** `cd agent && go test -race ./internal/backup/rebuild/ ./internal/recoveryconsole/ ./cmd/breeze-backup/` → PASS. `git commit -m "feat(rebuild,console): typed disk_has_windows refusal; console offers OVERWRITE → ForceDisk (W07a)"`.

---

### Task 4: Refuse a WinPE build older than the guest build (`disk:` targets)

**Files:**
- Modify: `agent/internal/backup/rebuild/winsystem.go` (`HostBuild() (uint32, error)`), `winsystem_windows.go` (`windows.RtlGetVersion().BuildNumber`), `winsystem_fake_test.go` (`hostBuild` field)
- Create: `agent/internal/backup/rebuild/win_build_check.go`, `win_build_check_test.go`
- Modify: `agent/internal/backup/rebuild/win_preflight.go` (call after `isDomainController`, `disk:` only)

**Interfaces:**
- Produces: `func (r *run) guestBuild() (build uint32, ok bool, err error)` reads `Microsoft\Windows NT\CurrentVersion\CurrentBuildNumber` from the staged `registry/SOFTWARE` artifact via `LoadHiveReadOnly` (mount `BRZ_<targetKey>_PREB`); `func checkWinPEBuild(host, guest uint32) *RefusalError`.

- [ ] **Step 1: Failing tests** (`win_build_check_test.go`):

```go
func TestCheckWinPEBuild(t *testing.T) {
	if ref := checkWinPEBuild(26100, 20348); ref != nil {
		t.Fatalf("newer WinPE must pass: %v", ref)
	}
	if ref := checkWinPEBuild(26100, 26100); ref != nil {
		t.Fatalf("equal must pass: %v", ref)
	}
	ref := checkWinPEBuild(22621, 26100)
	if ref == nil || !strings.Contains(ref.Reason, "22621") || !strings.Contains(ref.Reason, "26100") || ref.Code != RefusalCodeWinPETooOld {
		t.Fatalf("ref = %+v", ref)
	}
}

func TestWinPreflight_RefusesOlderWinPEThanGuest(t *testing.T) {
	defer withHostPlatformWindows(t)()
	fs := newFakeWinSystem(t)
	fs.inWinPE, fs.hostBuild = true, 22621
	seedFakeHives(t, fs) // existing fixture; set SOFTWARE CurrentBuildNumber = "26100" on the staged artifact hive
	fs.stagedHive("SOFTWARE").Set(`Microsoft\Windows NT\CurrentVersion`, "CurrentBuildNumber", "26100")
	opts := winFakeOptions(t, fs)
	opts.Target = Target{Kind: TargetDisk, Path: `\\.\PhysicalDrive1`}
	res, _ := Run(context.Background(), opts)
	if res.Status != "refused" || res.RefusalCode != RefusalCodeWinPETooOld || countCalls(fs, "WipeDisk") != 0 {
		t.Fatalf("res = %+v wipes=%d", res, countCalls(fs, "WipeDisk"))
	}
}

func TestWinPreflight_MissingSoftwareArtifactWarns(t *testing.T) {
	// no staged SOFTWARE → completes preflight, Result.Warnings contains
	// "could not read the guest Windows build" (fail-open with a warning: the
	// file-tree SOFTWARE is not available until restore, after provision).
}

func TestWinPreflight_VHDXSkipsBuildCheck(t *testing.T) { /* vhdx target, hostBuild 1 → no refusal */ }
```

(Match the fake hive API to `winhive.Fake`'s real setters. If the fixture cannot stage a SOFTWARE artifact, extend `seedFakeHives` with an optional map.)

- [ ] **Step 2: Run to verify failure** → `undefined: checkWinPEBuild`.

- [ ] **Step 3: Implement.**

```go
const RefusalCodeWinPETooOld = "winpe_older_than_guest"

func checkWinPEBuild(host, guest uint32) *RefusalError {
	if guest == 0 || host >= guest {
		return nil
	}
	return &RefusalError{Code: RefusalCodeWinPETooOld, Reason: fmt.Sprintf(
		"this recovery media runs Windows PE build %d, older than the backed-up Windows build %d; rebuild the media with a current Windows ADK", host, guest)}
}
```

In `winPreflight`, after the DC check: `if r.opts.Target.Kind == TargetDisk { host, err := WinSystem.HostBuild(); guest, ok, err := r.guestBuild(); if !ok { r.warn("could not read the guest Windows build from the system-state SOFTWARE artifact; WinPE/guest build compatibility not checked") } else if ref := checkWinPEBuild(host, guest); ref != nil { return ref } }`. `guestBuild` mirrors `isDomainController`. Only `fs.ErrNotExist` means "absent". A failed unload is an error.

- [ ] **Step 4: Run (incl. Windows cross-compile), commit.** `git commit -m "feat(rebuild): refuse disk targets when the WinPE build is older than the guest (W07a)"`.

---

### Task 5: `mediaPlatform` at exchange — refuse a mismatched code before claiming it

**Files:**
- Modify: `agent/internal/backup/bmr/session.go` (`exchangeCodeRequest.MediaPlatform string \`json:"mediaPlatform,omitempty"\``, set to `runtime.GOOS` when it is `linux` or `windows`)
- Modify: `apps/api/src/routes/backup/schemas.ts` (`bmrExchangeSchema.mediaPlatform: z.enum(['linux','windows']).optional()`), `apps/api/src/routes/backup/bmrRecoveries.ts` (gate after the `helperVersion` gate)
- Test: `agent/internal/backup/bmr/session_exchange_test.go`, `apps/api/src/routes/backup/bmrRecoveries.test.ts`, `agent/internal/recoveryconsole/console_exchange_errors_test.go`

- [ ] **Step 1: Failing tests.** API (copy the `#5629` case at `bmrRecoveries.test.ts:630` and adapt):

```ts
it('W07: media platform mismatch — 409 media_platform_mismatch BEFORE the code is claimed', async () => {
  // seed rec { status: 'created', platform: 'linux', codeExpiresAt: future }
  const res = await publicApp.request('/backup/bmr/recover/exchange', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'abc-def-ghj', mediaPlatform: 'windows' }),
  });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.error).toBe('media_platform_mismatch');
  expect(body.message).toContain('The recovery code was not used');
  expect(body.details).toMatchObject({ recoveryPlatform: 'linux', mediaPlatform: 'windows' });
  expect(updateMock).not.toHaveBeenCalled(); // codeUsedAt untouched — use the file's existing db mock name
});
it('W07: mediaPlatform omitted or rec.platform null → no gate (old media / legacy rows)', async () => { /* both proceed to negotiation */ });
```

Agent: `TestExchangeRecoveryCode_SendsMediaPlatform` (httptest server decodes the body, asserts `mediaPlatform == runtime.GOOS` on linux/windows). Console: `TestConsole_MediaPlatformMismatchIsTerminal`: Exchange returns `&bmr.RecoveryNegotiationError{Code: "media_platform_mismatch", Message: "…not used."}`. Assert the message is printed, there is no second `Exchange` call for the same code, and the return is to the code prompt or exit, matching how `helper_version_too_old` is handled today (read `console_exchange_errors_test.go` for that exact behaviour and mirror it).

- [ ] **Step 2: Run to verify failure** (`npx vitest run src/routes/backup/bmrRecoveries.test.ts -t "media platform"`; `go test ./internal/backup/bmr/ -run MediaPlatform`).

- [ ] **Step 3: Implement** the API gate right after the `helper_version_too_old` block:

```ts
const { mediaPlatform } = c.req.valid('json');
if (mediaPlatform !== undefined && rec.platform && rec.platform !== mediaPlatform) {
  writeAuditEvent(c, {
    orgId: rec.orgId, action: 'bmr.recovery.exchange', resourceType: 'bare_metal_recovery', resourceId: rec.id,
    result: 'failure', details: { reason: 'media_platform_mismatch', recoveryPlatform: rec.platform, mediaPlatform },
  });
  const want = rec.platform === 'windows' ? 'Windows' : 'Linux';
  return c.json({
    error: 'media_platform_mismatch',
    message: `This recovery is for a ${want} backup; boot the Breeze ${want} recovery media instead. The recovery code was not used.`,
    details: { recoveryPlatform: rec.platform, mediaPlatform },
  }, 409);
}
```

- [ ] **Step 4: Run both suites + tsc, commit.** `git commit -m "feat(bmr): mediaPlatform at exchange — refuse a mismatched code before claiming it (W07a)"`.

---

### Task 6: Deterministic TLS roots on WinPE

**Files:**
- Create: `agent/internal/backup/bmr/mediaroots.go`, `mediaroots_test.go`
- Modify: `agent/cmd/breeze-backup/recovery_console_cmd.go` (call `bmr.LoadMediaRoots(h.BakedRoots)` before `Console.Run`)
- Modify (Part B, Task 8): the builder writes `roots.pem` and `breeze-recovery.cmd` sets `GODEBUG=x509usefallbackroots=1`

**Interfaces:**
- Produces: `func LoadMediaRoots(pemPath string) (loaded int, err error)`. An empty path or a missing file gives `(0, nil)` (system roots stay). Otherwise it parses every PEM `CERTIFICATE` and calls `x509.SetFallbackRoots(pool)` once. With `GODEBUG=x509usefallbackroots=1` (set by the media launcher), Go then uses this pool instead of the Windows chain engine for **every** client in the process: `newHTTPClient`, `noAuthRedirectClient` and the S3 presigned downloads. A malformed file or zero certificates is an error (fail closed: the console prints "recovery media root store is unreadable; rebuild the media" and exits non-zero).

- [ ] **Step 1: Failing test** (`mediaroots_test.go`). Use `httptest.NewTLSServer` and write its `srv.Certificate()` as PEM to a temp file. In a subprocess (`exec.Command(os.Args[0], "-test.run=TestHelperMediaRoots")` with `GODEBUG=x509usefallbackroots=1` and `BREEZE_ROOTS=<path>`), call `LoadMediaRoots` and then `http.Get(srv.URL)` through `newHTTPClient()`; it must succeed. A second subprocess without the roots file must fail with `x509: certificate signed by unknown authority`. Plus `TestLoadMediaRoots_MissingFileKeepsSystemRoots` (`0, nil`) and `TestLoadMediaRoots_GarbageIsError`. (A subprocess is required because `SetFallbackRoots` panics if called twice in one process.)
- [ ] **Step 2: Run to verify failure** → `undefined: LoadMediaRoots`.
- [ ] **Step 3: Implement** (`x509.NewCertPool`, `AppendCertsFromPEM`, count via `pem.Decode` loop, `x509.SetFallbackRoots`).
- [ ] **Step 4: Run, commit.** `git commit -m "feat(bmr): load recovery-media roots as Go fallback roots on WinPE (W07a)"`.

### Task A-PR: Part A suites + PR

- [ ] Run the full agent suite + Windows cross-compile + lint (Global Constraints commands). Update the `ci.yml` Windows package list (`./internal/backup/windisks ./internal/recoveryconsole`) and `qemu-gate-paths.txt` (`agent/internal/backup/windisks/`), then run `go test ./cmd/breeze-backup/ -run TestQEMUGatePathsMatchBackupDependencySet`.
- [ ] API: `npx vitest run src/routes/backup/bmrRecoveries.test.ts src/routes/backup/schemas.test.ts` + tsc.
- [ ] PR "W07a: recovery console on WinPE" — body `Part of #5500`, deviations D7-NOLOCK, test plan; one Sonnet review round (agent-shipped code). Dispatch CI on the branch if it is stacked: `gh workflow run CI --ref <branch>`.

---

## Part B — W07b: the media builder (PR 2, "Part of #5500")

### Task 7: `winpemedia` — ADK discovery and the build plan (pure, all platforms)

**Files:**
- Create: `agent/internal/backup/winpemedia/adk.go` (discovery, untagged, registry/env seams), `plan.go` (step list), `payload.go` (rendered payload files), `adk_test.go`, `plan_test.go`, `payload_test.go`

**Interfaces:**
- Produces:
```go
package winpemedia

type Env struct { // seams; the real one is in env_windows.go
	KitsRoot10    func() (string, error)       // registry, both views
	ProgramFiles  func() []string              // %ProgramFiles%, %ProgramFiles(x86)% as the OS reports them
	Stat          func(path string) (os.FileInfo, error)
}

type ADK struct {
	Root, DISM, Oscdimg, EfiSys, WinPEWim, MediaDir, OCDir string
}
var ErrADKMissing = errors.New("winpemedia: Windows ADK with the WinPE add-on is not installed")
func DiscoverADK(env Env) (*ADK, error) // *RefusalError-shaped errors name the missing path + https://learn.microsoft.com/windows-hardware/get-started/adk-install

var OptionalComponents = []string{"WinPE-WMI", "WinPE-SecureStartup", "WinPE-EnhancedStorage"}

type Step struct{ Exe string; Args []string; Desc string }
type BuildInput struct { ADK *ADK; WorkDir, OutISO string }
func Plan(in BuildInput) []Step // copy is done in Go, not a Step; DISM/oscdimg steps only

type Payload struct {
	HelperPath, ServerURL, TrustPin, RootsPEM string
	BuildID, HelperVersion, HelperSHA256, WinPEVersion string
	BuiltAt time.Time
	ExtraCmdline string // CI/test builds only; refused unless recoveryconsole unattended ldflag build
}
func RenderFiles(p Payload) (map[string][]byte, error) // keys relative to the mounted image root
```

- [ ] **Step 1: Failing tests.**

`adk_test.go`, a table over a fake `Env`:
- the happy path (`KitsRoot10 = C:\Program Files (x86)\Windows Kits\10\`, every file present) gives absolute paths ending in `\Deployment Tools\amd64\DISM\dism.exe`, `\Oscdimg\oscdimg.exe`, `\Oscdimg\efisys.bin`, `\Windows Preinstallation Environment\amd64\en-us\winpe.wim`
- `TestDiscoverADK_NoKitsRoot` gives `ErrADKMissing`
- `TestDiscoverADK_DeploymentToolsMissing` gives an error naming `dism.exe`
- `TestDiscoverADK_WinPEAddonMissing` gives an error naming `winpe.wim` and "WinPE add-on"
- `TestDiscoverADK_KitsRootOutsideProgramFiles` (`D:\kits\`) gives an error containing "outside Program Files"
- a missing OC cab gives an error naming the cab

`plan_test.go`:

```go
func TestPlan_StepsInOrder(t *testing.T) {
	adk := &ADK{DISM: `C:\K\dism.exe`, Oscdimg: `C:\K\oscdimg.exe`, EfiSys: `C:\K\efisys.bin`, OCDir: `C:\K\WinPE_OCs`}
	steps := Plan(BuildInput{ADK: adk, WorkDir: `C:\W`, OutISO: `C:\O\x.iso`})
	var got []string
	for _, s := range steps {
		got = append(got, s.Exe+" "+strings.Join(s.Args, " "))
	}
	want := []string{
		`C:\K\dism.exe /Mount-Image /ImageFile:C:\W\media\sources\boot.wim /Index:1 /MountDir:C:\W\mount`,
		`C:\K\dism.exe /Image:C:\W\mount /Add-Package /PackagePath:C:\K\WinPE_OCs\WinPE-WMI.cab`,
		`C:\K\dism.exe /Image:C:\W\mount /Add-Package /PackagePath:C:\K\WinPE_OCs\en-us\WinPE-WMI_en-us.cab`,
		// … SecureStartup, EnhancedStorage pairs …
		`C:\K\dism.exe /Image:C:\W\mount /Set-ScratchSpace:512`,
		// payload files are written between these two steps by the runner (not a Step)
		`C:\K\dism.exe /Unmount-Image /MountDir:C:\W\mount /Commit`,
		`C:\K\oscdimg.exe -m -o -u2 -udfver102 -bootdata:1#pEF,e,bC:\K\efisys.bin C:\W\media C:\O\x.iso`,
	}
	// assert full equality (write all 10 lines out in the real test)
}

func TestPlan_NeverUsesPathLookup(t *testing.T) {
	for _, s := range Plan(fixtureInput()) {
		if !filepath.IsAbs(s.Exe) && !(len(s.Exe) > 2 && s.Exe[1] == ':') {
			t.Fatalf("step %q is not absolute", s.Exe)
		}
	}
}

func TestPlan_NoDriverInjection(t *testing.T) {
	for _, s := range Plan(fixtureInput()) {
		for _, a := range s.Args {
			if strings.Contains(strings.ToLower(a), "/add-driver") || strings.Contains(strings.ToLower(a), "forceunsigned") {
				t.Fatalf("D7-DRV: %v", s)
			}
		}
	}
}
```

`payload_test.go`:
- `RenderFiles` yields exactly these keys: `breeze\cmdline.txt` (`breeze.media=1\r\n`), `breeze\recovery-server`, `breeze\roots.pem`, `breeze\media.json`, `breeze\breeze-recovery.cmd`, `Windows\System32\winpeshl.ini`. When `TrustPin` is set, `breeze\recovery-trust-pin` is added.
- `media.json` round-trips with `schemaVersion: 1, platform: "windows", arch: "amd64"`.
- `winpeshl.ini` equals:
  ```
  [LaunchApps]
  %SYSTEMROOT%\System32\wpeinit.exe
  %SYSTEMROOT%\System32\cmd.exe, /c X:\breeze\breeze-recovery.cmd
  ```
- `breeze-recovery.cmd` contains `set GODEBUG=x509usefallbackroots=1`, a `:loop` that runs `X:\breeze\breeze-backup.exe recovery-console`, then `pause` and `goto loop`.
- No rendered file contains `token`, `code=` or `password`.
- `ExtraCmdline` containing `breeze.ci=1` is refused unless `allowUnattended` is true (a package var mirroring the console ldflag).

- [ ] **Step 2: Run to verify failure.** `cd agent && go test ./internal/backup/winpemedia/` → undefined.

- [ ] **Step 3: Implement** to the tests. Paths are built with `\` explicitly, like `hosttool`. The Program-Files containment check uses `strings.EqualFold` on cleaned prefixes plus a trailing separator.

- [ ] **Step 4: Run, commit.** `git commit -m "feat(backup): winpemedia — ADK discovery, WinPE build plan, media payload (W07b)"`.

---

### Task 8: Real builder (`Build`) on Windows

**Files:**
- Create: `agent/internal/backup/winpemedia/build.go` (untagged orchestration over a `Runner` seam), `env_windows.go` (registry, `GetSystemWindowsDirectory`-style Program Files lookup via `windows.KnownFolderPath`), `roots_windows.go` (`ExportRootStore() ([]byte, error)`: `CertOpenSystemStore(0,"ROOT")` → `CertEnumCertificatesInStore` → PEM), `build_other.go` (`Build` → `ErrUnsupported`), `build_test.go` (fake runner), `build_windows_test.go` (real, gated by `BREEZE_WINPE_BUILD_TEST=1`)

**Interfaces:**
- Consumes: Task 7.
- Produces:
```go
type Runner func(ctx context.Context, exe string, args ...string) ([]byte, error)
type Options struct {
	OutDir, ServerURL, TrustPin, BuildID, HelperVersion string
	Env Env; Run Runner; Now func() time.Time
	ExportRoots func() ([]byte, error)
	Executable func() (string, error) // os.Executable
}
type Result struct {
	ISOPath, ISOSHA256 string; ISOSizeBytes int64
	WinPEVersion, HelperVersion, HelperSHA256 string
	Warnings []string
}
func Build(ctx context.Context, o Options) (*Result, error)
```

Behaviour:
1. `DiscoverADK`.
2. Refuse `OutDir` on a volume with < 4 GiB free.
3. `WorkDir = %ProgramData%\Breeze\recovery-media\work\<BuildID>` (removed on every exit path, including a `dism /Unmount-Image /Discard` on failure after mount).
4. Copy `ADK.MediaDir` → `<work>\media`, then `ADK.WinPEWim` → `<work>\media\sources\boot.wim`.
5. Run `Plan` steps up to Set-ScratchSpace.
6. Write `RenderFiles` into `<work>\mount` plus the byte copy of `Executable()` to `<work>\mount\breeze\breeze-backup.exe`, then verify its SHA-256 equals the source's.
7. Unmount `/Commit`.
8. Run `oscdimg`.
9. Hash the ISO and write `<iso>.sha256` and `<iso>.build.json` (= `Result`).
10. Read `WinPEVersion` from `dism /Get-WimInfo /WimFile:<winpe.wim> /Index:1` (parse `Version : 10.0.26100.1`).

Output name: `breeze-recovery-winpe-amd64-<helperVersion>-<buildID[:8]>.iso` in `OutDir` (default `%ProgramData%\Breeze\recovery-media\`).

- [ ] **Step 1: Failing tests** (`build_test.go`, fake `Runner` records calls and creates the files `oscdimg` would; `Env` points at a temp ADK tree):
  - `TestBuild_HappyPath`: the recorded calls equal `Plan(...)` with the Get-WimInfo call first. The mount dir receives every `RenderFiles` key plus `breeze\breeze-backup.exe` whose hash is recorded. The ISO, `.sha256` and `.build.json` exist. The work dir is gone.
  - `TestBuild_DISMFailureDiscardsMount`: `Add-Package` fails, so the next call is `/Unmount-Image /MountDir:… /Discard`, the error names the step, the work dir is removed, and no ISO exists.
  - `TestBuild_LowDiskRefused`.
  - `TestBuild_HelperCopyMismatchFails` (a fake `Executable` whose content changes between hash and copy).
  - `TestBuild_ParsesWinPEVersion` (fixture DISM output incl. localized-label tolerance: match `^\s*Version\s*:\s*(\d+\.\d+\.\d+\.\d+)`).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** `build_windows_test.go`, gated by `BREEZE_WINPE_BUILD_TEST=1`, skips with `t.Skip` when ADK is absent locally (CI's job makes it must-not-skip, Task 10). It runs a real `Build` into a temp dir and asserts: the ISO is > 200 MB; `dism /Get-WimInfo` on the extracted `sources\boot.wim` succeeds; `dism /Image:<mount> /Get-Packages` lists the three OCs; `X:\breeze\breeze-backup.exe` exists in the image (mount read-only via `/ReadOnly`). It then deletes the ISO.
- [ ] **Step 4: Run, cross-compile, commit.** `git commit -m "feat(backup): winpemedia.Build — WinPE recovery ISO from the installed ADK (W07b)"`.

---

### Task 9: `breeze-backup build-recovery-media` CLI + `build_recovery_media` helper command + agent forwarding

**Files:**
- Create: `agent/cmd/breeze-backup/build_recovery_media_cmd.go` (+ `_test.go`), `exec_build_recovery_media.go` (+ `_test.go`)
- Modify: `agent/cmd/breeze-backup/main.go` (register the subcommand; both dispatch switches `case "build_recovery_media"` with `commandCanceller.track`), `agent/internal/remote/tools/types.go` (`CmdBuildRecoveryMedia = "build_recovery_media"`), `agent/internal/heartbeat/handlers_bmr_forward.go` (register, wait `backupipc.BuildRecoveryMediaForwardTimeout`), `agent/internal/backupipc/<budget file>` (`BuildRecoveryMediaRunBudget = 90 * time.Minute`, forward = budget + `HelperResultGrace`)

**Interfaces:**
- CLI: `breeze-backup build-recovery-media --server <https URL> [--out <dir>] [--trust-pin <b64>]`. It refuses `http://` (no `--insecure` on media builds) and refuses off Windows.
- Payload (`json`): `{ "buildId": "<uuid>", "server": "<https URL>" }`. Result `stdout` = `json.Marshal(winpemedia.Result)` plus `"buildId"`. Failure: `fail(reason)` with the refusal text verbatim.

- [ ] **Step 1: Failing tests.** `exec_build_recovery_media_test.go` with a `buildFn` seam: an invalid payload (missing `buildId`, non-https server, non-UUID id) gives `failed` and `invalid build_recovery_media payload`; the happy path passes `Options{BuildID, ServerURL, HelperVersion: version}` and returns stdout JSON with `isoSha256`; `ErrADKMissing` gives a `failed` whose error contains "Windows ADK"; context cancellation is propagated. `build_recovery_media_cmd_test.go`: `--server http://x` is refused, and the flag wiring calls `buildFn`. Agent: `handlers_bmr_forward_test.go` asserts `handlerRegistry[tools.CmdBuildRecoveryMedia] != nil`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** following `exec_bare_metal_rebuild.go`'s structure (payload struct, `validate()`, `fail` helper, `slog` progress lines `build_recovery_media progress`).
- [ ] **Step 4: Run, commit.** `git commit -m "feat(breeze-backup): build-recovery-media CLI and helper command (W07b)"`.

---

### Task 10: CI — hosted Windows build-only gate (never uploads the media)

**Files:**
- Modify: `.github/workflows/ci.yml` (new job `recovery-media-windows-build`, `needs: [changes]`, same `if:` as `recovery-media-e2e`, `runs-on: windows-latest`, `timeout-minutes: 75`; added to `ci-success.needs` and its result check)
- Create: `agent/recovery-media/windows/install-adk.ps1` (downloads the ADK + WinPE add-on bootstrappers from Microsoft's documented `go.microsoft.com/fwlink` links pinned in the script, verifies `Get-AuthenticodeSignature` status `Valid` and signer subject `CN=Microsoft Corporation`, installs `/quiet /norestart /features OptionId.DeploymentTools` and `OptionId.WindowsPreinstallationEnvironment`). CI only: the product builder never runs it (D7-NOAUTOINSTALL).
- Modify: `ci.yml` Windows package list (`./internal/backup/winpemedia`), `.github/scripts/qemu-gate-paths.txt` (`agent/internal/backup/winpemedia/`)

Job steps:
1. checkout
2. setup-go
3. `install-adk.ps1` (cache keyed on the script hash via `actions/cache` of `C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit`, which is a cache, not an artifact upload; still verify the signature after restore)
4. `go build -o breeze-backup.exe ./cmd/breeze-backup`
5. `$env:BREEZE_WINPE_BUILD_TEST='1'; go test ./internal/backup/winpemedia -run '^TestBuildReal$' -v`, with the must-not-skip pattern from `ci.yml` (`:1909-1923` style: fail if the output lacks `--- PASS: TestBuildReal`)
6. `Remove-Item -Recurse -Force $env:RUNNER_TEMP\winpe-*` in an `if: always()` step

**No `actions/upload-artifact` step in this job.** A grep guard in the job asserts that, and `agent/recovery-media/windows/README.md` explains why (licensing).

- [ ] **Step 1:** Write the job and push to the branch. Expected first result: red on `TestBuildReal` only if Task 8 has a real-ADK bug. Fix forward.
- [ ] **Step 2:** Run `gh workflow run CI --ref <branch>` if stacked, and confirm the job ran and PASSed (`gh run view --log | grep 'PASS: TestBuildReal'`).
- [ ] **Step 3: Commit.** `git commit -m "ci: hosted Windows WinPE media build gate (build-only, never uploaded) (W07b)"`.

### Task B-PR: Part B PR

- [ ] Full agent suite, cross-compile, lint, gate-paths test. PR "W07b: Windows recovery media builder" — `Part of #5500`, deviations D7-DRV / D7-NOAUTOINSTALL / D7-NOCIBOOT, licensing note. One Sonnet review round. Ask the reviewer: no PATH resolution, no driver injection, work dir cleaned on every path, nothing secret rendered, and no media in any artifact.

---

## Part C — W07c: API + web (PR 3, "Part of #5500")

### Task 11: `recovery_media_builds` table (shape 1 + device) with every registration

**Files:**
- Create: `apps/api/migrations/2026-12-06-100000-recovery-media-builds.sql` (re-check the slot), `apps/api/src/db/schema/recoveryMediaBuilds.ts`; export it from `apps/api/src/db/schema/index.ts`
- Modify: `services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, alphabetical: after `recovery_boot_media_artifacts`… place by `localeCompare`), `routes/devices/core.ts` (`CORE_DEVICE_CASCADE_DELETE_TABLES` + `CORE_DEVICE_ORG_DENORMALIZED_TABLES`), `services/tenantExportPolicyRegistry.ts`, `services/orgMergeRegistry.ts` (travels with its device, the same treatment as `bare_metal_recoveries`)
- Test: `apps/api/src/routes/devices/cascadeDelete.test.ts`, `moveOrg.coverage.test.ts` (unit, Test API), plus integration `tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts`, `rls-coverage.integration.test.ts` (shape 1, auto-discovered), `orgMergeRegistry.integration.test.ts`

Migration (mirrors `2026-10-15-160200-bare-metal-recoveries.sql`):

```sql
CREATE TABLE IF NOT EXISTS recovery_media_builds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  command_id uuid,
  platform text NOT NULL DEFAULT 'windows' CHECK (platform IN ('windows')),
  arch text NOT NULL DEFAULT 'amd64' CHECK (arch IN ('amd64')),
  status varchar(20) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','completed','failed')),
  server_url text NOT NULL,
  helper_version text,
  helper_sha256 text,
  winpe_version text,
  iso_path text,
  iso_sha256 text,
  iso_size_bytes bigint,
  failure_reason text,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS recovery_media_builds_org_idx ON recovery_media_builds(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS recovery_media_builds_device_idx ON recovery_media_builds(device_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS recovery_media_builds_command_idx ON recovery_media_builds(command_id) WHERE command_id IS NOT NULL;
ALTER TABLE recovery_media_builds ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_media_builds FORCE ROW LEVEL SECURITY;
-- four breeze_org_isolation_{select,insert,update,delete} policies, each in a
-- pg_policies existence check, copied verbatim from the bare_metal_recoveries
-- migration with the table name swapped.
```

`org_id NOT NULL` justification (Partner-Wide First): a build is an artifact record of one org's device, not a config/policy row.

Export policy:

```ts
"recovery_media_builds": tablePolicy("org_id", {"included":["id","org_id","device_id","command_id","platform","arch","status","server_url","helper_version","helper_sha256","winpe_version","iso_path","iso_sha256","iso_size_bytes","failure_reason","requested_by","created_at","completed_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["warnings"]}),
```

(`helper_sha256` and `iso_sha256` contain no `SUSPICIOUS_NAME_PARTS`. If the suite flags `sha` / `hash`, move them to `reviewedIncluded`; they are public content digests.)

- [ ] **Step 1: Failing tests.** Run `npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts`. After adding only the Drizzle schema these go red; that is the red step. Then run the integration suites with `DATABASE_URL` against a migrated DB (`pnpm db:migrate`). They go red on the missing registrations.
- [ ] **Step 2: Implement** the migration and every registration. Grep-verify: `grep -rn recovery_media_builds apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts` → 5 hits (core.ts twice).
- [ ] **Step 3:** `pnpm db:check-drift` clean; forge a cross-tenant insert as `breeze_app` → `new row violates row-level security policy`.
- [ ] **Step 4: Run all five suites green, commit.** `git commit -m "feat(api): recovery_media_builds table with RLS and cascade/export/merge registration (W07c)"`.

### Task 12: Command type + build/list routes + result handler

**Files:**
- Modify: `services/commandTypes.ts` (`BUILD_RECOVERY_MEDIA: 'build_recovery_media'`), `services/commandOfflinePolicy.ts` (`BACKUP_AND_RESTORE`), `services/commandTimeouts.ts` (`if (commandType === CommandTypes.BUILD_RECOVERY_MEDIA) return TWO_HOURS;`, defining `TWO_HOURS` if absent), `services/commandQueue.ts` (audited set, next to `BARE_METAL_REBUILD`), `services/partnerTrust.ts` (`GATED_COMMAND_TYPES`, alphabetical)
- Create: `apps/api/src/services/recoveryMediaBuildService.ts` (`queueRecoveryMediaBuild`, `applyRecoveryMediaBuildResult`, `listRecoveryMediaBuilds`), `apps/api/src/routes/backup/bmrMediaBuilds.ts` (mounted in `routes/backup/index.ts` next to `bmrRecoveryRoutes`), tests for both
- Modify: `routes/agents/commands.ts` (`if (command.type === CommandTypes.BUILD_RECOVERY_MEDIA) await applyRecoveryMediaBuildResult({commandId, deviceId: command.deviceId, status: normalizedData.status, stdout, error: normalizedData.error})`), and the same in `routes/agentWs.ts`

**Interfaces:**
- `POST /backup/bmr/boot-media/windows/builds` `{ deviceId }` → 202 `{ id, status: 'queued', deviceId, commandId }`. Guards: `requireScope('organization','partner','system')`, `BACKUP_WRITE`, `authorizeRouteResilienceResources(c, orgId, [{kind:'device', id: deviceId, role:'target'}], 'token')` (confirm the operation union in `resilienceAuthorization.ts`), device `osType === 'windows'` else 409 `builder_requires_windows`, an existing `queued` build for the device gives 409 `build_in_progress`. `server` = `resolveServerUrl(...)` (`services/recoveryBootstrap.ts`), which must be `https://` else 409 `server_url_not_https`. The row is inserted first, then the command is queued with payload `{buildId: row.id, server}`, and `command_id` is stored. A queue failure gives the row `failed` / `failure_reason` and a 502.
- `GET /backup/bmr/boot-media/windows/builds?deviceId=` → `{ data: RecoveryMediaBuildSummary[] }` (newest first, limit 50, `BACKUP_READ`).
- `applyRecoveryMediaBuildResult`: matches by `command_id` in a system DB context (result path). `completed` parses stdout JSON with a zod schema (`isoPath ≤1024`, `isoSha256 /^[0-9a-f]{64}$/`, `isoSizeBytes int ≥0`, `winpeVersion ≤64`, `helperVersion ≤64`, `helperSha256 hex64`, `warnings string[] ≤20 × ≤500`). A schema failure marks the build `failed` with `invalid_result`. A `failed`/`timeout` command copies the error, truncated to 1000 chars. The handler is idempotent (no-op once terminal). It writes the audit event `bmr.media.build`.

- [ ] **Step 1: Failing tests** (`bmrMediaBuilds.test.ts` using the mock patterns from `bmrRecoveries.test.ts`): Linux device → 409; offline policy queues/rejects as `BACKUP_AND_RESTORE` does (assert via `commandOfflinePolicy.test.ts`'s existing exhaustiveness tests going red first); the happy path inserts a row and queues the payload without secrets; a second POST gives 409 `build_in_progress`; GET lists only the org's rows. `recoveryMediaBuildService.test.ts`: completed / failed / invalid stdout / duplicate result.
- [ ] **Step 2: Run to verify failure.** `npx vitest run src/routes/backup/bmrMediaBuilds.test.ts src/services/recoveryMediaBuildService.test.ts src/services/commandOfflinePolicy.test.ts src/services/partnerTrust.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run + tsc, commit.** `git commit -m "feat(api): build_recovery_media command, build routes and result handler (W07c)"`.

### Task 13: Catalog + web UI + i18n

**Files:**
- Modify: `routes/backup/bmr.ts` `GET /bmr/boot-media` (append `windows` rows from the org's latest `completed` build per device: `{platform:'windows', arch:'amd64', version: helperVersion, filename: basename(isoPath), downloadUrl: null, sha256, size, buildId, deviceId, deviceName, isoPath, winpeVersion, builtAt}`), `bmr.test.ts`
- Modify: `apps/web/src/components/backup/RecoveryBootstrapTab.tsx` (+ test): `RecoveryMediaCatalogEntry` gains the optional fields above. Windows rows render "Built on <device> — <isoPath>" with no download button (D7-LOCAL) and a copy-path button. A "Build Windows recovery media" card holds a `useDeviceOptions({ osType: 'windows' })` picker plus a submit wrapped in `runAction`, and a list of recent builds polled every 15 s while any is `queued`. The note says: "Requires the Windows ADK and WinPE add-on on the selected device" with a link to Microsoft's ADK page.
- Modify: `apps/web/src/locales/*/backup.json` (8 locales, translated) under `recoveryBootstrapTab`: `windowsMediaTitle`, `windowsMediaDescription`, `windowsMediaBuilderDevice`, `windowsMediaBuild`, `windowsMediaBuilding`, `windowsMediaBuiltOn`, `windowsMediaCopyPath`, `windowsMediaRequiresAdk`, `windowsMediaFailed`, `windowsMediaNoBuilds`

- [ ] **Step 1: Failing tests.** `bmr.test.ts`: the catalog includes a Windows row with `downloadUrl: null` when a completed build exists, and none for another org. `RecoveryBootstrapTab.test.tsx`: the Windows row shows the path and no Download link; the submit posts `{deviceId}` through `runAction`; a 409 `build_in_progress` shows the error toast (runAction). `no-silent-mutations.test.ts` stays green.
- [ ] **Step 2: Run to verify failure.** `cd apps/web && npx vitest run src/components/backup/RecoveryBootstrapTab.test.tsx src/lib/__tests__/no-silent-mutations.test.ts src/locales`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, commit.** `git commit -m "feat(web,api): Windows recovery media builds in the boot-media catalog and Recovery tab (W07c)"`.

### Task C-PR

- [ ] API unit + the five integration suites (Task 11) + tsc + web. PR "W07c: Windows media builds — API and UI", `Part of #5500`. This is a new tenant table, so: one Sonnet review round focused on RLS/cascade/export, plus the **advisor quorum** on the table shape before merge (Fable + `codex exec` xhigh, per CLAUDE.md "consequential"). Record the outcome in the PR body.

---

## Part D — W07d: first-boot post-restore actions (BitLocker re-encryption, D-BL) (PR 4, "Part of #5500")

### Task 14: Agent executor for `post-restore-actions.json`

**Files:**
- Create: `agent/internal/heartbeat/post_restore_actions.go` (untagged logic over seams), `post_restore_actions_test.go`
- Modify: `agent/internal/security/recoverykeys.go` (add `EnableBitLockerWithNewRecoveryPassword(mount string) (RecoveryKey, error)` and `TPMReady() (bool, string, error)`, both on the PowerShell pattern already in the file, both validating `mount` with `validBitLockerMount`)
- Modify: `agent/internal/heartbeat/heartbeat.go` (`processHeartbeatResponse`: after the marker-ack block, `go h.maybeRunPostRestoreActions()` guarded by a `sync.Once`-like `atomic.Bool` in-flight flag)

**Interfaces:**
```go
type postRestoreFile struct {
	SchemaVersion int `json:"schemaVersion"`
	BitLocker *struct{ Reencrypt bool `json:"reencrypt"`; Volume string `json:"volume"` } `json:"bitlocker,omitempty"`
}
type postRestoreOutcome struct {
	RecoveryID string `json:"recoveryId,omitempty"` // from recovery-marker.acked.json when present
	BitLocker  string `json:"bitlocker"`              // "enabled" | "skipped" | "failed"
	Reason     string `json:"reason,omitempty"`
	At         time.Time `json:"at"`
}
// seams (package vars) for tests:
var (
	postRestoreGOOS     = runtime.GOOS
	postRestoreTPMReady = security.TPMReady
	postRestoreEnable   = security.EnableBitLockerWithNewRecoveryPassword
)
func (h *Heartbeat) maybeRunPostRestoreActions()
```

Rules, in order:
1. Windows only.
2. The file `<dataDir>/post-restore-actions.json` exists; a malformed file is renamed to `.invalid.json` with outcome `failed`.
3. **No unacked `recovery-marker.json`** (check-in first).
4. The agent is enrolled (`h.config.AgentID != ""`).
5. `TPMReady` false → outcome `skipped` + reason (`"no ready TPM; the volume stays unencrypted"`).
6. `EnableBitLockerWithNewRecoveryPassword("C:")` adds the recovery-password protector **first**, then `h.pushRecoveryKeys("rotation", []RecoveryKey{newKey})` **must succeed**, and only then does `Enable-BitLocker -MountPoint C: -TpmProtector -UsedSpaceOnly -SkipHardwareTest` run. An escrow failure leaves the protector, does not start encryption, and retries on the next beat, so the file stays.
7. On a terminal outcome: rename the file to `post-restore-actions.done.json`, store the outcome in `h.pendingPostRestoreOutcome` for Task 15, and log at Info/Warn with no key material.

The volume must equal `"C:"` exactly (anything else gives `failed`, "unexpected volume"). `winre.enable` is ignored and logged.

- [ ] **Step 1: Failing tests** (all untagged, seams + temp dataDir):
  - `TestPostRestore_WaitsForMarkerAck`: a marker file present means no calls.
  - `TestPostRestore_NotEnrolledWaits`.
  - `TestPostRestore_NoTPMSkips`: outcome `skipped`, file renamed, enable not called.
  - `TestPostRestore_EscrowBeforeEncrypt`: the call order is `addProtector, push, enable`, and a push error means no `enable`, the file remains and no outcome is recorded.
  - `TestPostRestore_Success`: outcome `enabled` with the `RecoveryID` from the acked marker.
  - `TestPostRestore_MalformedFile`.
  - `TestPostRestore_NonWindowsNoop`.
  - `TestPostRestore_OnlyOneInFlight` (two concurrent calls make one enable).

  (Split `EnableBitLockerWithNewRecoveryPassword` into `AddRecoveryPasswordProtector(mount) (RecoveryKey, error)` and `EnableTPMEncryption(mount) error` so the escrow sits between them. Use those two names in the seams.)
- [ ] **Step 2: Run to verify failure.** `cd agent && go test ./internal/heartbeat/ -run PostRestore`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run with `-race`, Windows cross-compile, commit.** `git commit -m "feat(agent): first-boot BitLocker re-encryption from post-restore-actions.json, escrow before encrypt (W07d, D-BL)"`.

### Task 15: Report the outcome on the recovery

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go` (heartbeat payload `PostRestoreOutcome *postRestoreOutcome \`json:"postRestoreOutcome,omitempty"\``, sent until the response carries `postRestoreOutcomeAck: true`)
- Modify: `apps/api/src/routes/agents/schemas.ts` (optional `postRestoreOutcome: z.object({recoveryId: z.string().uuid().optional(), bitlocker: z.enum(['enabled','skipped','failed']), reason: z.string().max(500).optional(), at: z.string().datetime()})`), `apps/api/src/routes/agents/heartbeat.ts` (next to the marker block: when `recoveryId` is a recovery of this device and org, append `"post-restore BitLocker: <bitlocker>[: reason]"` to `bare_metal_recoveries.warnings` (jsonb, already `excludedOpen`), write audit `bmr.recovery.post_restore`, return `postRestoreOutcomeAck: true`; no recoveryId (identity new) → audit only + ack)
- Test: `heartbeat.test.ts` (API), `post_restore_actions_test.go` (ack clears pending)

- [ ] Red → green → commit (`feat(api,agent): surface post-restore BitLocker outcome on the recovery (W07d)`).

### Task D-PR

- [ ] Suites, PR "W07d: BitLocker re-encryption on first boot", `Part of #5500`. This is agent-shipped encryption code, so the review is **Opus** (depth): escrow-before-encrypt ordering, no key material in logs, idempotence across restarts.

---

## Part E — W07e: docs, spec amendment, lab proof (PR 5, "Closes #5500")

### Task 16: Docs + spec amendment + ledger rows

**Files:**
- Modify: `apps/docs/src/content/docs/backup/bare-metal-recovery.mdx`:
  - `:14` stops saying "There is no WinPE/WinRE environment yet".
  - `:251` (`disk:` needs WinPE "which doesn't ship until … (W07)") now points to the new section.
  - `:341` BitLocker intent "ships with W07" becomes the executor behaviour.
  - New section "Recover Windows from Breeze recovery media": prerequisites (the ADK + WinPE add-on installed on a Windows device you manage, ≥ the Windows build you restore; UEFI target; ≥ 2 GB RAM); Backup → Recovery → Build Windows recovery media; where the ISO lands; writing it to USB (Rufus/`diskpart` steps) or attaching it to a Hyper-V Gen2 VM; boot, code, confirm (serial / `ERASE` / `OVERWRITE`), reboot; static IP via `[s]hell` + `netsh`; what is not restored (WinRE, drivers beyond inbox, multi-volume); BitLocker re-encryption on first boot.
- Modify: spec `§7.2`. Rewrite it to the as-built design: builder on the operator's device using an installed ADK; payload; no drivers from system state (D7-DRV); ISO stays local (D7-LOCAL / Q2 answer); `recovery_media_builds`; `mediaPlatform` gate in §8.1. In the §12 tail, mark D-BL as shipped.
- Modify: `docs/testing/backup-assurance/2026-09-09-backup-assurance-campaign.md` §11.1. Pre-draft the rows below, with "(fill from the run — do not commit placeholder numbers)".

```markdown
| W07-L1 Windows media build | WIN-A as builder (ADK + WinPE add-on installed), lab stack | lab stack @ W07 head, agent+helper from the same head | (fill from the run — do not commit placeholder numbers) | (fill from the run — do not commit placeholder numbers) |
| W07-L2 WinPE boot → rebuild (`identity:new`) | new Gen2 VM on the nested lab host, Secure Boot on, blank VHDX, ISO as DVD | same | (fill) | (fill) |
| W07-L3 WinPE rebuild (`identity:original`) → check-in | throwaway Windows source VM (powered off after its backup) → new Gen2 VM | same | (fill) | (fill) |
| W07-L4 refusals | Linux code on Windows media; disk with Windows; too-old media | same | (fill) | (fill) |
| W07-L5 BitLocker re-encryption | vTPM source with BitLocker → restored plaintext → re-encrypted after check-in, new key escrowed | same | (fill) | (fill) |
```

- [ ] Commit (`docs(backup): Windows recovery media docs, spec §7.2 as built, W07 ledger rows (W07e)`).

### Task 17: lab-hyperv-host lab proof (orchestrator runbook; Todd starts the lab host) + PR

Use the campaign's conventions. Evidence goes under the scratchpad (`w07-lab/…`). There are no addresses in committed files.

1. **Stack + agents.** Bring up a `worktree-stack` at the W07 head with MinIO. Build the agent and helper from the same head and `dev-push` them to the lab Windows rigs (restore the production builds afterwards, as in earlier lab-hyperv-host proofs). Make sure no second agent runs on a host that has the installed agent.
2. **L1 build.** On WIN-A (or the nested lab host itself if WIN-A lacks disk space), install the ADK + WinPE add-on manually (D7-NOAUTOINSTALL). In the UI: Recovery → Build Windows recovery media → WIN-A. Expect: the row reaches `completed`; `.iso` + `.sha256` + `.build.json` sit under `C:\ProgramData\Breeze\recovery-media\`; the catalog shows the Windows row with the path and no download button. Record `winpeVersion`, size and duration. Copy the ISO to the nested lab host's VM storage.
3. **L2 `identity:new`.** Use an existing restorable whole-machine snapshot of WIN-A (or take a fresh one). Create a recovery with identity `new`. Create Gen2 VM `w07-target-new`: Secure Boot on (Microsoft Windows template), 4 GB RAM, blank 80 GB VHDX, DVD = ISO, NIC on the lab switch. Boot and press a key at "Press any key to boot from CD". Expect:
   - the console appears without any manual `wpeinit`
   - DHCP works
   - the server URL is pre-filled from `recovery-server`
   - the code is accepted
   - the plan screen shows the Hyper-V disk model/serial and the partition plan
   - type the serial (or `ERASE`)
   - phases are printed, and the recovery timeline shows `media_booted → planned → restoring → validated → rebooted`
   - after the 10 s countdown (check that a key cancels it), the VM reboots, the DVD prompt times out, and Windows boots to the logon screen with hostname `<BASE>-RESTORED`
   - the recovery reaches `completed`

   Record per-phase timings (restore will be hours; see #7333).
4. **L3 `identity:original` → check-in.** Create a throwaway Server 2022 eval VM `w07-src` on the nested host, enrolled to the lab stack, with a whole-machine backup. **Power it off for good.** Create a recovery with identity `original` and boot `w07-target-orig` from the ISO. Expect `rebooted`, then `checked_in` within 30 min of the restored agent starting; the device page shows `recoveredAt` and `recoveredFromSnapshotId`; `icacls C:\Windows\System32\config` shows only TrustedInstaller/SYSTEM/Administrators/CREATOR OWNER (D-ACL still holds through WinPE).
5. **L4 refusals.** (a) Type a code for the lab's Linux snapshot into the Windows media → `media_platform_mismatch` and the code still works on the Linux ISO. (b) Reboot `w07-target-new` into the ISO and start a new recovery against its now-Windows disk → the `OVERWRITE` prompt; `cancel` leaves the disk untouched. (c) Too-old media, if an older ADK is at hand; otherwise mark it N/A in the ledger and do not claim it.
6. **L5 BitLocker.** Give `w07-src-bl` a vTPM and BitLocker (`Enable-BitLocker C: -TpmProtector -UsedSpaceOnly`, then a recovery password escrowed by the agent), take a whole-machine backup, power it off, and recover with identity `original` into a VM **with a vTPM**. Expect: restored plaintext (W06 warning on the recovery); after `checked_in`, the executor runs; a **new** recovery key is escrowed (≠ the source's, visible in the device's recovery keys); `manage-bde -status C:` shows encryption in progress or complete; the recovery's warnings carry `post-restore BitLocker: enabled`. Repeat into a VM **without** a vTPM → `skipped` with the reason.
7. **Teardown.** Delete the lab VMs/VHDXs, restore the production agents, and tear the stack down.

**Explicit gaps (state them in the PR, do not claim them):** physical-hardware WinPE NIC/storage coverage (inbox only; Q3); boot-start driver forcing on a non-`storvsc` source (carried from W06d); Secure Boot media signed under the 2023 CA (`efisys` "EX" variant), which this run does not exercise. File follow-up issues for any that are confirmed to matter.

- [ ] Fill the ledger rows from the run (Task 16's file), commit `docs(backup): W07 lab-hyperv-host lab results`.
- [ ] PR "W07e: Windows recovery media — docs + lab-hyperv-host lab proof", body starting `Closes #5500`. Enqueue only after Parts A–D are merged and L1–L3 PASS. `complete_wave` W07 via feature-lifecycle on merge.

---

## Self-review notes (plan author)

**Spec coverage (§ → task).**
- §2 #3 media built on a customer machine: Tasks 7–9, Global Constraints "Licensing".
- §2 #4 no secrets on media: Task 7 payload test, Task 6 (roots only).
- §2 #6 identity / check-in: Task 17 L3 (W04a path unchanged).
- §6.1 host bcdboot only, no drivers: unchanged engine (Global Constraints), Task 7 `TestPlan_NoDriverInjection`, D7-DRV.
- §6.1 BitLocker executor: Tasks 14–15.
- §7.2 builder: Tasks 7–10 + 11–13 (API stores version, hash, built-on device).
- §7.3 console: Tasks 2–3, plus the existing prompts, version gate and countdown (Task 2 Windows keypress).
- §8.1 state machine: reused; new `mediaPlatform` gate in Task 5.
- §9 wrong-disk protection: serial/`ERASE` unchanged, `OVERWRITE` for a disk carrying Windows (Task 3), system/media disks excluded (Task 2 `MediaSources`, engine).
- §10 lab "Windows media built on WIN-A": Task 17 L1.
- §10 "Windows equivalent on a self-hosted Windows runner with ADK (later wave)": not delivered; build-only hosted gate (Task 10, D7-NOCIBOOT, Q5).
- §11 wave 7: all parts.

**Placeholder scan.** The ledger rows say "(fill from the run …)" by campaign convention. Three spots tell the implementer to confirm a real identifier before writing (fake-fixture field names in Tasks 3–4, `layout.Disk` field names in Task 2, the `authorizeRouteResilienceResources` operation union in Task 12). Each names the file to read. No TBDs.

**Type consistency.**
- `RefusalError{Reason, Code}`, `Result.RefusalCode`, `RefusalCodeDiskHasWindows`, `RefusalCodeWinPETooOld` (Tasks 3–4).
- `windisks.Disk.Path` = `\\.\PhysicalDrive<n>`, matching `parseDiskTargetPath` and `MediaSources` (Tasks 1–2).
- `winpemedia.{ADK, Plan, RenderFiles, Build, Result}` (Tasks 7–9). The `Result` JSON field names match the API zod schema in Task 12 (`isoPath, isoSha256, isoSizeBytes, winpeVersion, helperVersion, helperSha256, warnings`).
- `CmdBuildRecoveryMedia` = `CommandTypes.BUILD_RECOVERY_MEDIA` = `build_recovery_media`.
- `postRestoreOutcome` shape matches the API schema (Task 15).

**Review provenance.** Written from main @ `e88f121351` with every cited path grepped. Not yet reviewed by Codex; the quorum is required on Task 11's table shape before Part C merges.
