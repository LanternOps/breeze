---
title: Bare-metal recovery from Breeze boot media — design
status: draft for review
date: 2026-09-10
owner: Todd
supersedes: docs/superpowers/plans/backup/2026-09-10-bmr-windows-offline-hive-decision.md (Option B remains the contract for the reinstall-then-recover mode; boot-media mode applies Windows state offline, see §6.4)
tracking_issue: LanternOps/breeze#5493
related: feature #5439 (Linux system state), campaign doc docs/testing/backup-assurance/2026-09-09-backup-assurance-campaign.md, issues #5470 #5479 #5460
---

# Bare-metal recovery from Breeze boot media

## 1. Goal

Boot a blank or replacement machine from Breeze recovery media, type a short code, confirm the plan, and get the original server back: same disk layout, same files, same OS state, same identity, and Breeze marks the recovery complete only when that device checks in from the restored OS. Linux first, Windows second, on one shared engine that also powers Restore-as-VM and DR plans.

## 2. Decisions taken (2026-09-10)

| # | Decision | Choice |
|---|---|---|
| 1 | OS scope | Both, one program; Linux waves first as the proving ground |
| 2 | Source of truth for a rebuild | Whole-machine **file** backup + system state + a layout manifest; no block-level imaging |
| 3 | Who builds the media | Breeze ships Linux media from CI; Windows media is built on a customer Windows machine by a Breeze media builder (ADK/WinPE licence forbids redistribution) |
| 4 | Operator experience | One-time recovery code typed at a guided console; single confirmation of the plan; no secrets on media |
| 5 | Supported layouts (first release) | UEFI + GPT, single system disk, plain ext4/xfs/NTFS; LVM, LUKS, RAID, BIOS/MBR, multi-disk are detected and refused with a reason |
| 6 | Identity after restore | The original device (hostname, machine identity, enrollment); recovery completes on first check-in; `new` identity available for rehearsals/cloning |
| 7 | Relationship to Restore-as-VM and DR plans | One rebuild engine with physical-disk and VHDX targets; three fronts (boot media, Restore-as-VM/Instant Boot, DR plan step) |

## 3. What exists today and is reused

| Feature | State | Reuse |
|---|---|---|
| Recovery tokens, bundles, `bmr-recover` (reinstall-then-recover) | shipped, proven Linux + Windows | token issuance, download descriptor, complete endpoint, retry/circuit breaker, D21 redirect handling |
| Linux system state (feature #5439) | shipped, proven incl. tamper | collector, checksummed manifest, W02 verifier, W03 restorer (gains a `root` parameter) |
| Restore-as-VM / Instant Boot (`agent/internal/backup/hyperv/vmrestore.go`) | shipped, Windows-only | provisioning + DISM driver-injection logic is generalised into the engine; `New-VM` stays in the Hyper-V front |
| DR plans (`apps/api/src/routes/dr.ts`, `drExecutionService.ts`) | shipped | new `BARE_METAL_REBUILD` step; rehearsal mode uses VHDX + new identity |
| Vault mirror + fallback provider (`exec_backup.go` `resolveRestoreProvider`) | shipped | engine restores vault-first, cloud second, unchanged |
| Recovery keys escrow (`device_recovery_keys`, access events) | shipped | engine fetches the escrowed key for encrypted sources; reveal is audited |
| Re-enrollment by identity (`routes/agents/enrollment.ts`) | shipped | restored agent resumes as the same `device_id`; hardware-change acceptance keyed by the recovery marker |
| Boot media build (`recoveryBootMediaService.ts`, template manifest) | shell (no template, no autorun) | replaced by release media + media builder; routes/table repurposed |
| Recovery readiness (`recovery_readiness`) | table only | fed by real rebuild results in the last wave |
| Immutability / legal hold / verification | shipped | respected read-only; verification model reused for post-rebuild validation |

## 4. Architecture

Three fronts, one engine, one server state machine.

- **Backup side** (agent/helper): "whole machine" profile preset + system state + **layout manifest** per run.
- **Rebuild engine** (`agent/internal/backup/rebuild`): snapshot + layout + target → provision, restore, apply state, boot, identity, encryption, validate. Targets: `disk:<device>` (physical, from boot media) and `vhdx:<path>` (Restore-as-VM, DR rehearsal, CI tests).
- **Fronts**: boot media console; Restore-as-VM / Instant Boot; DR plan step.
- **Server**: recovery codes, `bare_metal_recoveries` state machine, completion on first check-in, UI and DR integration.

Data flow: profile run → files + `system-state/` + `layout.json` in the snapshot prefix → operator creates a recovery (code) → media boots, exchanges code for token, downloads bootstrap + manifests → engine rebuilds the disk → reboot → restored agent heartbeats with the recovery marker → recovery `checked_in`, device `recoveredAt`.

## 5. Backup side

### 5.1 Whole-machine preset
Profile editor preset "Whole machine (bare-metal restorable)": `file` selection `/` (Linux) or `C:\` under VSS (Windows) with default excludes (`/proc`, `/sys`, `/dev`, `/run`, `/tmp`, `/var/tmp`, swap files, `/var/cache/apt/archives`; `pagefile.sys`, `hiberfil.sys`, `swapfile.sys`, `$Recycle.Bin`, `System Volume Information`, `Windows\Temp`), stored as ordinary `file` selections; enables `system_image`. Nothing downstream (dedupe, GC, verification, vault) changes.

### 5.2 Layout manifest (`snapshots/<id>/layout.json`)
Captured by the helper at run start, uploaded with the snapshot, referenced from the snapshot row (`layout_manifest_key`), marked live by retention like the system-state manifest. Contents: schema version; OS release; boot mode (UEFI/BIOS); disks (model, serial, size, table type); partitions (number, type GUID, start/size, filesystem, UUID, label, mount point, flags, encryption: none/luks/bitlocker/filevault); EFI boot entries; `/etc/fstab` (verbatim); Windows: volume GUIDs, BCD export (already collected), drive letters. Checksummed like other artifacts.

### 5.3 Restorability guard
The run computes `bareMetalRestorable` (boolean + reasons) from the layout: unsupported features in the first release are LVM, LUKS/dm-crypt, mdraid, BIOS/MBR, multiple system disks, btrfs subvolume roots, ZFS. Reasons are surfaced as run warnings and on the snapshot, so operators learn before the day they need it.

### 5.4 File fidelity (added 2026-09-10 during planning)
The `file` mode today skips symbolic links, drops ownership, keeps only the low 9 permission bits, and never records empty or non-default directories. A Linux root restored that way does not boot (`/bin → usr/bin`, systemd `.wants/` links, `sudo`'s setuid bit, `/var/log` ownership). Wave 2 closes this: the manifest gains optional per-entry `kind` (`symlink` | `dir`), `linkTarget`, `modeBits` (full Unix mode) and `owner` (uid/gid); the walker records symlinks (never followed), empty directories and directories with non-default mode/owner; restore recreates links and directories and, when running as root, reapplies owner and setuid/setgid/sticky bits. Manifests without such entries stay byte-identical to today. Hard links, extended attributes/capabilities and Windows ACLs remain out of scope for the first release and are listed in §12.

## 6. Rebuild engine

Package `agent/internal/backup/rebuild`. Inputs: snapshot id, layout manifest, target, identity mode (`original` | `new`), optional escrowed key, options (target-disk override, dry-run). Output: a structured `RebuildResult` (phase reached, per-phase timings, counts, warnings, refusal reason) that every front reports verbatim.

Phases (idempotent, resumable, logged by name):

1. **Preflight** — verify manifests and checksums (W02 verifier); target size ≥ source used size + 10 %; layout supported (else `refused` with the feature named); target disk not carrying the device's current live identity unless explicitly overridden; nothing written before this passes.
2. **Provision** — write GPT from the layout: every partition keeps its recorded size except the last data partition (normally the root/`C:` volume), which absorbs any extra space on a larger target; no partition is ever made smaller than its recorded used size. Format with the recorded filesystem types; reuse recorded UUIDs and labels so `fstab`, GRUB and BCD keep resolving.
3. **Restore tree** — mount under a staging root; restore the file snapshot through the provider chain (vault first) with the existing journal, retry and circuit breaker; apply system state against the staging root (Linux restorer takes `root`; Windows applies hives, BCD, drivers, certs, firewall offline — legitimate here because the volume is not the running OS).
4. **Boot** — Linux: chroot, `grub-install --target=<arch>-efi`, regenerate GRUB config, ensure an EFI boot entry; Windows: `bcdboot <root>\Windows /s <efi> /f UEFI`, DISM driver injection for the target's storage/network devices (reuse of the Hyper-V injector, generalised).
5. **Identity** — `original`: restore hostname, machine identity, agent enrollment state and secrets, and write the recovery marker (`recoveryId` + one-time nonce issued with the token) into the agent state directory; `new`: regenerate hostname suffix and machine identity, strip enrollment state so the agent starts unenrolled, no marker (the recovery completes at Validate, see §8.1).
6. **Encryption** — if the source volume was encrypted, re-apply with the escrowed key (BitLocker: enable on first boot via a one-shot task; LUKS: refused in the first release).
7. **Validate** — sample restored files against checksums, confirm bootloader files and EFI entry, unmount, report.

Targets: `disk` (block device on the booted media) and `vhdx` (attached and partitioned on a Windows host, or a loop-mounted image on Linux for tests).

## 7. Boot media and console

### 7.1 Linux media (Breeze-built)
CI builds `breeze-recovery-linux-{amd64,arm64}.iso` per release: Debian-based live image (kernel, initramfs, squashfs) with `breeze-backup`, `sgdisk`, `mkfs.ext4/xfs`, `grub-install`, `efibootmgr`, `dosfstools`, network (DHCP; static/proxy prompt), serial console, and a `breeze-recovery` service running the console on tty1 and ttyS0. Signed with the release-manifest key and published as a release asset; the API's boot-media endpoint serves the asset (download proxy or redirect) and records which version each org downloaded. Per-token ISO builds, the template manifest and `RECOVERY_BOOT_MEDIA_BASE_DIR` are removed.

### 7.2 Windows media (media builder)
Because the ADK/WinPE licence does not permit redistribution, Breeze ships a **media builder**: an agent command (and CLI) run on a customer Windows machine that downloads the ADK WinPE add-on, layers `breeze-backup.exe`, the console, and driver artifacts from the source device's system state, and writes an ISO/USB. The API stores the builder result (version, hash, built-on device) for the boot-media page.

### 7.3 Console
Boot → network → "Enter recovery code" → exchange → plan screen (device, snapshot time, source layout, detected target disk with model/size/serial, partition plan, identity mode) → confirm by typing the disk serial (or `ERASE`) → phases with progress → "Restored. Rebooting in 10 s". Refusals and failures stay on screen with the phase and reason; each phase can be retried. Media older than the server's `minHelperVersion` is refused with a clear message. An `--unattended` flag is reserved (parsed, refused) so the CLI surface is stable; unattended recovery is out of scope (§12).

## 8. Server side

### 8.1 Recovery codes and state
- `POST /backup/bmr/recoveries` `{deviceId, snapshotId, identity: original|new, target?: {disk?}}` → creates a `bare_metal_recoveries` row and a recovery token; returns a 9-character one-time code (15 min TTL, rate-limited like `/bmr/tokens`).
- `bare_metal_recoveries` carries `org_id` (shape 1 RLS, auto-discovered by the coverage test) plus `device_id`: RLS policy in the creating migration; registered in `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, and `CORE_TENANT_EXPORT_POLICY` (`result` jsonb → `excludedOpen`). The new `backup_snapshots.layout_manifest_key` and `bare_metal_restorable`/`bare_metal_reasons` columns get export-policy entries in the same PR. Migrations are named to sort after the newest committed file (currently a `2026-10-15-…` name).
- Public `POST /backup/bmr/recover/exchange` `{code}` → recovery token + bootstrap (reuses `recoveryBootstrap`); the code is consumed.
- Transitions posted by the console/helper with the `RebuildResult`: `created → media_booted → planned → restoring → validated → rebooted`, terminal `checked_in | completed | failed | refused`. For `identity: original`, the heartbeat handler sets `checked_in` when the restored device's first heartbeat carries the marker nonce that matches this pending recovery; the nonce is consumed and the device gets `recovered_at` and `recovered_from_snapshot_id`. For `identity: new`, `validated` moves straight to `completed` (no check-in is expected; a rehearsal VM enrolls, if at all, as a brand-new device).
- Failure reason and warnings are persisted on the recovery row (closes the gap in #5479).

### 8.2 Identity resumption
The restored agent authenticates with the restored credentials. Hardware changes (serials, MACs) are accepted for the same `device_id` when the recovery marker matches a pending recovery; otherwise the existing re-adoption rules apply.

### 8.3 DR plans and Restore-as-VM
- New group step `BARE_METAL_REBUILD`: creates the recovery, shows the code in the execution view, waits for `checked_in` (timeout configurable). Rehearsal mode forces `identity: new` and a VHDX target on a chosen Hyper-V host.
- Restore-as-VM / Instant Boot call the engine with a `vhdx` target and gain Linux guests.

### 8.4 UI and docs
Recovery bootstrap tab gains "Bare-metal recovery" (pick snapshot → code → live status); boot-media page lists release media (Linux) and builder results (Windows); device page shows recovery history; `bare-metal-recovery.mdx` rewritten around this flow with reinstall-then-recover as the fallback mode.

## 9. Safety and failure handling

- Nothing is written before preflight passes; refusals name the feature/disk/size.
- Wrong-disk protection: plan shows model/size/serial; confirmation types the serial; disks carrying a recognisable OS or the device's own live identity are flagged.
- Codes are one-time and short-lived, bound to org + device + snapshot; tokens keep single-use semantics; no secrets on media.
- Rehearsals cannot resume the production identity.
- Every phase is resumable; network loss retries with the existing backoff and circuit breaker; the console keeps the reason on screen.
- If an `original`-identity device does not check in within 30 minutes after `rebooted`, the recovery row is flagged `overdue` (not failed: the row stays pending and the marker nonce stays valid for 7 days) so the operator looks at the console.

## 10. Testing

- **Engine unit tests** on every platform against fake mount/exec seams and raw image files (VHDX on Windows in wave 6): provisioning from recorded layouts, UUID reuse, refusal matrix, identity modes, resumability.
- **CI integration**: build the Linux ISO, boot it in QEMU on the runner, restore a seeded snapshot from a MinIO service, reboot, assert the agent checks in and the recovery reaches `checked_in`. Windows equivalent on a self-hosted Windows runner with ADK (later wave).
- **Lab** (campaign harness): KIT Hyper-V VMs boot the ISO (Linux first, then Windows media built on WIN-A); a new `cells-bmr-media.sh` records evidence like the existing cells.

## 11. Waves

1. Layout manifest + whole-machine preset + restorability guard (agent + API + UI preset).
2. File-backup fidelity: symlinks, directories, ownership, full mode bits (§5.4).
3. Rebuild engine, Linux: disk + raw-image (loop) targets, offline system-state apply, GRUB/EFI boot, unit tests without root, root-gated loopback test.
4. Linux live media in CI, console, recovery codes and state machine, heartbeat completion; QEMU integration test; lab proof on KIT.
5. Restore-as-VM / Instant Boot and DR plans on the engine (rehearsal mode); raw image → VHDX conversion for Hyper-V.
6. Windows engine: offline hives, `bcdboot`, DISM injection, `vhdx` target with tests.
7. Windows media builder (WinPE) + console; lab proof on KIT via WIN-A.
8. Docs, UI polish, recovery readiness fed from real results.

## 12. Out of scope (first release)

Block-level imaging; LVM, LUKS, RAID, BIOS/MBR, multi-disk targets (refused, not silently attempted); macOS bare-metal; dissimilar-boot-mode conversion; unattended fleet recovery (reserved flag only); hard links, extended attributes/capabilities and Windows ACLs in the file backup (§5.4); crossing filesystem boundaries under `/` beyond the preset's excluded trees (a one-filesystem walk option is a follow-up).
