---
tracking_issue: LanternOps/breeze#5493
---

# Wave 01 — Layout manifest, whole-machine preset, restorability guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `system_image` backup run captures the machine's disk layout as `snapshots/<id>/layout.json`, the server stores the manifest and a `bareMetalRestorable` verdict on the snapshot row, GC keeps the object alive, the UI shows the verdict, and a "Whole machine" profile template exists — so a snapshot that the later rebuild engine (W02) can consume is produced today, and unsupported layouts are named at backup time instead of on recovery day.

**Architecture:** A new cross-platform Go package `agent/internal/backup/layout` (types + guard + OS parsers without build tags; thin tagged collectors that shell out through a `runCommand` seam, mirroring `bmr/restore_linux.go`). The backup run collects the layout next to system state, publishes it before the ordinary manifest (same GC-ordering argument as D15), and carries it in the `BackupJob` JSON. The API adds three snapshot columns, forwards the two new result fields through the Redis queue, marks the key live in `markLiveBackupObjects`, and returns the verdict from the snapshot list. The web adds two profile templates and a snapshot badge. The exclude matcher gains root-anchored patterns (leading `/`) so a whole-machine preset can exclude `/proc` without also excluding every `proc` directory on the box.

**Tech Stack:** Go 1.26 (`agent/`), Hono + Drizzle + zod (`apps/api`), React + i18next + Vitest (`apps/web`), PostgreSQL migration (hand-written SQL).

**Spec:** `docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md` §5 (backup side: 5.1 preset, 5.2 layout manifest, 5.3 guard), §2 decision 5 (UEFI+GPT single disk). Not §6–§8 (engine, media, server state machine — W02+).

**Depends on:** nothing. W02 (rebuild engine) consumes `layout.Manifest` and `snapshots/<id>/layout.json` from this wave.

## Global Constraints

- Object key: `snapshots/<snapshotId>/layout.json` — Go constant `layoutManifestKey = "layout.json"` in `agent/internal/backup/snapshot.go`; TS constant `BACKUP_LAYOUT_MANIFEST_KEY = 'layout.json'` + `backupLayoutManifestKey(snapshotId)` in `apps/api/src/services/backupSnapshotStorage.ts`. They must stay byte-identical (same contract as `system-state/manifest.json`).
- Manifest `schemaVersion` is `1`. Unknown fields must never fail a parse anywhere (agent → API → persistence): all TS schemas for the manifest are `.passthrough()` / open records.
- Layout is collected only when `SystemStateEnabled` is true (the `system_image` source), never on plain file runs — plain file runs must produce byte-identical results to today.
- Publish order per snapshot: system-state artifacts → system-state manifest → **layout.json** → ordinary `manifest.json`. A layout publish failure fails the run (same semantics as a system-state publish failure).
- New columns on `backup_snapshots`: `layout_manifest jsonb NULL`, `bare_metal_restorable boolean NULL` (NULL = never assessed), `bare_metal_reasons text[] NULL`. Migration file: `apps/api/migrations/2026-10-15-160010-backup-snapshots-layout-manifest.sql` (sorts after the newest committed `2026-10-15-150040-…`; re-check with `ls apps/api/migrations/*.sql | sort | tail -1` before committing and bump the time component if something newer landed).
- Export policy (`apps/api/src/services/tenantExportPolicyRegistry.ts`, `backup_snapshots` row): `layout_manifest` → `excludedOpen`; `bare_metal_restorable`, `bare_metal_reasons` → `included`. No cascade-list changes (no new table).
- Guard reasons are the exact strings in Task 1 — they are shown verbatim to operators and asserted by tests; do not reword them elsewhere.
- Exclude patterns: a pattern starting with `/` is root-anchored (gitignore semantics); patterns without a leading `/` keep today's any-depth behaviour. Nothing else in `exclude.go` changes.
- No internal hostnames/IPs in any committed file.

## 0. Ground truth (verified 2026-09-10 against `origin/main` @ `0414a46344`)

- `agent/internal/backup/systemstate/types.go:10-46` — `SystemStateManifest`; `hw_linux.go:30` runs `lsblk -J -b -o NAME,SIZE,MODEL,TYPE,MOUNTPOINT,FSTYPE,LABEL` (kept as is; the new package runs its own richer lsblk).
- `agent/internal/backup/backup.go:70` — `var collectSystemState = systemstate.CollectSystemState` seam; `:645-665` system-state collection block inside `if m.config.SystemStateEnabled`; `:180-212` `BackupJob` struct (`SystemStateManifest` at `:208`); `:989-996` `snapshotOpts` + `withSystemState(...)`; `:877` system-image-only path calls `publishSystemState` then `publishSnapshotManifest`.
- `agent/internal/backup/snapshot.go:73-75` key constants; `:397-400` `createSnapshotOptions{systemStateStagingDir, systemStateManifest}`; `:426` `withSystemState`; `:488` `createSnapshotWithProgress(ctx, provider, files, onProgress, journal, prevSnapshot, sourceLiveness, opts...)`; `:1023-1035` system-state publish block; `:1037` `publishSnapshotManifest`; `:1144-1168` `publishSnapshotManifest` body (write temp file → `uploadSnapshotFile(attemptCtx, provider, localPath, key)` with `uploadDeadline(size)`); `:1195` `publishSystemState`.
- `agent/internal/backup/exclude.go:38-60` — `newExcludeMatcherForOS` trims leading `/` (`strings.Trim(p, "/")`), so anchoring is impossible today; `:82` `matches(relPath)`; `backup.go:1386-1393` directory pruning via `fs.SkipDir` on `excl.matches(filepath.ToSlash(relPath))` with `relPath` relative to the configured root.
- `agent/internal/backup/backup_test.go:486-487` — seam swap pattern (`t.Cleanup(func(){ collectSystemState = orig })`); `:630-690` `TestRunBackup_SystemState_PublishOrderStateBeforeOrdinaryManifest` uses `newMockProvider()` + `provider.uploadCalls[i].remotePath`.
- `agent/internal/backup/bmr/restore_linux.go:29` — `var runCommand = func(ctx, name, args...) ([]byte, error)` seam; `restore_linux_test.go:26` `fakeCommands` pattern.
- `apps/api/src/routes/backup/resultSchemas.ts:40-49` `backupSystemStateManifestResultSchema`, `:89-90` `backupType` + `systemStateManifest` fields of `backupCommandResultSchema`.
- `apps/api/src/jobs/queueSchemas.ts:56-57` `backupProcessResultSchema` (strict) `backupType`/`systemStateManifest`; `apps/api/src/jobs/backupEnqueue.ts:98-99` payload type.
- `apps/api/src/routes/agentWs.ts:1668-1669` forwards `backupType`/`systemStateManifest` into `enqueueBackupResults`; the inline fallback at `:1683-1688` spreads `backupData` (no change needed there).
- `apps/api/src/services/backupResultPersistence.ts:1134-1160` snapshot insert values (`systemStateManifest`, `hardwareProfile`).
- `apps/api/src/db/schema/backup.ts:280-337` `backupSnapshots`; `:323-324` `hardwareProfile`/`systemStateManifest` jsonb.
- `apps/api/src/services/backupSnapshotStorage.ts:170-179` key helpers; `apps/api/src/jobs/backupRetention.ts:887-980` `markLiveBackupObjects` (`:941` `const stateManifestKey = backupSystemStateManifestKey(snapshotId);`).
- `apps/api/src/routes/backup/snapshots.ts:664-690` `toSnapshotResponse(row)` — list route returns full rows through it.
- `apps/api/src/services/tenantExportPolicyRegistry.ts:124` `backup_snapshots` policy.
- `apps/web/src/components/backup/SnapshotBrowser.tsx:51-62` `Snapshot` type; `:478-487` badges next to `selectedSnapshotDisplayLabel`; `t` from `useTranslation('backup')` (`:132`).
- `apps/web/src/components/backup/BackupProfilesTab.tsx:118-190` `createTemplates()`; `:39-56` `DraftSelections`/`emptySelections`; lucide import block `:3-14`.
- `apps/web/src/components/configurationPolicies/featureTabs/backupTabPresets.ts` — `BackupOsPreset` + `createOsPresets()`.
- `apps/web/src/locales/en/backup.json:806` `profiles.tmplServerTitle` (keys live under `profiles.*` and `snapshotBrowser.*`). Seven locale dirs exist (`de-DE en es-419 fr-CA fr-FR it-IT pt-BR tr-TR`); add new keys to `en` and to every other locale file with the English string (translation follow-up is the localisation team's sweep, but a missing key reds the tr-TR parity check).

---

### Task 1: `layout` package — types and restorability guard

**Files:**
- Create: `agent/internal/backup/layout/types.go`
- Create: `agent/internal/backup/layout/guard.go`
- Test: `agent/internal/backup/layout/guard_test.go`

**Interfaces:**
- Produces: `layout.Manifest`, `layout.Disk`, `layout.Partition`, `layout.EFIEntry`, `layout.Restorability`, `layout.Assess(*Manifest) Restorability`, `(*Manifest).SystemDisk() *Disk`, the `Reason*` string constants, `layout.ErrUnsupportedPlatform`. W02 consumes all of these.

- [ ] **Step 1: Write the failing guard test**

```go
package layout

import (
	"reflect"
	"testing"
)

func uefiGPT(extra ...Partition) *Manifest {
	parts := []Partition{
		{Number: 1, Name: "/dev/sda1", TypeGUID: "c12a7328-f81f-11d2-ba4b-00a0c93ec93b", Filesystem: "vfat", MountPoint: "/boot/efi", SizeBytes: 512 << 20, Role: RoleEFI, Encryption: EncryptionNone},
		{Number: 2, Name: "/dev/sda2", TypeGUID: "0fc63daf-8483-4772-8e79-3d69d8477de4", Filesystem: "ext4", MountPoint: "/", SizeBytes: 40 << 30, Role: RoleRoot, Encryption: EncryptionNone},
	}
	parts = append(parts, extra...)
	return &Manifest{
		SchemaVersion: SchemaVersion, Platform: "linux", BootMode: BootModeUEFI,
		Disks: []Disk{{Name: "/dev/sda", TableType: "gpt", SizeBytes: 64 << 30, IsSystem: true, Partitions: parts}},
	}
}

func TestAssess(t *testing.T) {
	tests := []struct {
		name string
		m    *Manifest
		want Restorability
	}{
		{name: "nil manifest", m: nil, want: Restorability{Restorable: false, Reasons: []string{ReasonNilManifest}}},
		{name: "uefi gpt ext4 single disk", m: uefiGPT(), want: Restorability{Restorable: true, Reasons: []string{}}},
		{name: "xfs root ok", m: func() *Manifest { m := uefiGPT(); m.Disks[0].Partitions[1].Filesystem = "xfs"; return m }(), want: Restorability{Restorable: true, Reasons: []string{}}},
		{name: "bios boot", m: func() *Manifest { m := uefiGPT(); m.BootMode = BootModeBIOS; return m }(), want: Restorability{Reasons: []string{ReasonBIOSBoot}}},
		{name: "mbr table", m: func() *Manifest { m := uefiGPT(); m.Disks[0].TableType = "mbr"; return m }(), want: Restorability{Reasons: []string{ReasonNotGPT}}},
		{name: "no efi partition", m: func() *Manifest { m := uefiGPT(); m.Disks[0].Partitions = m.Disks[0].Partitions[1:]; return m }(), want: Restorability{Reasons: []string{ReasonNoEFIPartition}}},
		{name: "no root", m: func() *Manifest { m := uefiGPT(); m.Disks[0].Partitions = m.Disks[0].Partitions[:1]; m.Disks[0].IsSystem = false; return m }(), want: Restorability{Reasons: []string{ReasonNoSystemDisk}}},
		{name: "btrfs root", m: func() *Manifest { m := uefiGPT(); m.Disks[0].Partitions[1].Filesystem = "btrfs"; return m }(), want: Restorability{Reasons: []string{ReasonUnsupportedRootFS("btrfs"), ReasonBtrfs}}},
		{name: "lvm on system disk", m: uefiGPT(Partition{Number: 3, Name: "/dev/sda3", Filesystem: "LVM2_member", Role: RoleUnknown, Encryption: EncryptionNone}), want: Restorability{Reasons: []string{ReasonLVM}}},
		{name: "luks on system disk", m: uefiGPT(Partition{Number: 3, Name: "/dev/sda3", Filesystem: "crypto_LUKS", Encryption: EncryptionLUKS, Role: RoleUnknown}), want: Restorability{Reasons: []string{ReasonLUKS}}},
		{name: "raid member on system disk", m: uefiGPT(Partition{Number: 3, Name: "/dev/sda3", Filesystem: "linux_raid_member", Role: RoleUnknown, Encryption: EncryptionNone}), want: Restorability{Reasons: []string{ReasonRAID}}},
		{name: "zfs member on system disk", m: uefiGPT(Partition{Number: 3, Name: "/dev/sda3", Filesystem: "zfs_member", Role: RoleUnknown, Encryption: EncryptionNone}), want: Restorability{Reasons: []string{ReasonZFS}}},
		{name: "second disk mounted at /var is multi-disk", m: func() *Manifest {
			m := uefiGPT()
			m.Disks = append(m.Disks, Disk{Name: "/dev/sdb", TableType: "gpt", SizeBytes: 100 << 30, Partitions: []Partition{{Number: 1, Name: "/dev/sdb1", Filesystem: "ext4", MountPoint: "/var", Role: RoleData, Encryption: EncryptionNone}}})
			return m
		}(), want: Restorability{Reasons: []string{ReasonMultiDisk}}},
		{name: "second disk mounted at /srv/media is data, not multi-disk", m: func() *Manifest {
			m := uefiGPT()
			m.Disks = append(m.Disks, Disk{Name: "/dev/sdb", TableType: "gpt", SizeBytes: 100 << 30, Partitions: []Partition{{Number: 1, Name: "/dev/sdb1", Filesystem: "ext4", MountPoint: "/srv/media", Role: RoleData, Encryption: EncryptionNone}}})
			return m
		}(), want: Restorability{Restorable: true, Reasons: []string{}}},
		{name: "removable second disk ignored", m: func() *Manifest {
			m := uefiGPT()
			m.Disks = append(m.Disks, Disk{Name: "/dev/sdc", Removable: true, TableType: "mbr", Partitions: []Partition{{Number: 1, Name: "/dev/sdc1", Filesystem: "vfat", MountPoint: "/media/usb", Role: RoleData, Encryption: EncryptionNone}}})
			return m
		}(), want: Restorability{Restorable: true, Reasons: []string{}}},
		{name: "windows ntfs root with bitlocker is restorable", m: &Manifest{
			SchemaVersion: SchemaVersion, Platform: "windows", BootMode: BootModeUEFI,
			Disks: []Disk{{Name: `\\.\PHYSICALDRIVE0`, TableType: "gpt", IsSystem: true, Partitions: []Partition{
				{Number: 1, TypeGUID: "c12a7328-f81f-11d2-ba4b-00a0c93ec93b", Filesystem: "fat32", Role: RoleEFI, Encryption: EncryptionNone},
				{Number: 2, TypeGUID: "e3c9e316-0b5c-4db8-817d-f92df00215ae", Role: RoleMSR, Encryption: EncryptionNone},
				{Number: 3, TypeGUID: "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7", Filesystem: "ntfs", MountPoint: `C:\`, Role: RoleRoot, Encryption: EncryptionBitLocker},
			}}},
		}, want: Restorability{Restorable: true, Reasons: []string{}}},
		{name: "reasons accumulate in fixed order", m: func() *Manifest {
			m := uefiGPT(Partition{Number: 3, Name: "/dev/sda3", Filesystem: "crypto_LUKS", Encryption: EncryptionLUKS, Role: RoleUnknown})
			m.BootMode = BootModeBIOS
			m.Disks[0].TableType = "mbr"
			return m
		}(), want: Restorability{Reasons: []string{ReasonBIOSBoot, ReasonNotGPT, ReasonLUKS}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Assess(tt.m)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("Assess() = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestSystemDisk(t *testing.T) {
	m := uefiGPT()
	if d := m.SystemDisk(); d == nil || d.Name != "/dev/sda" {
		t.Fatalf("SystemDisk() = %+v, want /dev/sda", d)
	}
	m.Disks[0].IsSystem = false
	if d := m.SystemDisk(); d == nil || d.Name != "/dev/sda" {
		t.Fatalf("SystemDisk() should fall back to the disk holding the root mount, got %+v", d)
	}
	m.Disks[0].Partitions[1].MountPoint = ""
	if d := m.SystemDisk(); d != nil {
		t.Fatalf("SystemDisk() = %+v, want nil when nothing is mounted at /", d)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd agent && go test ./internal/backup/layout/ -run 'TestAssess|TestSystemDisk' 2>&1 | head -5`
Expected: build failure — `undefined: Manifest`, `undefined: Assess`, etc.

- [ ] **Step 3: Write `types.go`**

```go
// Package layout captures a machine's disk layout at backup time
// (snapshots/<id>/layout.json) and decides whether the bare-metal rebuild
// engine can reproduce it. Spec: docs/superpowers/specs/backup/
// 2026-09-10-bare-metal-boot-media-recovery-design.md §5.2-5.3.
package layout

import (
	"errors"
	"time"
)

// SchemaVersion is written into every manifest. Bump on incompatible changes;
// the rebuild engine refuses versions it does not know.
const SchemaVersion = 1

// ErrUnsupportedPlatform is returned by Collect on platforms without a
// collector (darwin, others). The backup run records it as a warning.
var ErrUnsupportedPlatform = errors.New("disk layout capture is not supported on this platform")

// Boot modes.
const (
	BootModeUEFI    = "uefi"
	BootModeBIOS    = "bios"
	BootModeUnknown = "unknown"
)

// Partition roles — how the rebuild engine will treat the partition.
const (
	RoleEFI      = "efi"
	RoleRoot     = "root"
	RoleBoot     = "boot"
	RoleSwap     = "swap"
	RoleData     = "data"
	RoleMSR      = "msr"
	RoleRecovery = "recovery"
	RoleUnknown  = "unknown"
)

// Encryption kinds.
const (
	EncryptionNone      = "none"
	EncryptionLUKS      = "luks"
	EncryptionBitLocker = "bitlocker"
)

// Well-known GPT partition type GUIDs (lower-case, no braces).
const (
	GUIDEFISystem       = "c12a7328-f81f-11d2-ba4b-00a0c93ec93b"
	GUIDMicrosoftMSR    = "e3c9e316-0b5c-4db8-817d-f92df00215ae"
	GUIDMicrosoftBasic  = "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7"
	GUIDWindowsRecovery = "de94bba4-06d1-4d40-a16a-bfd50179d6ac"
	GUIDLinuxFilesystem = "0fc63daf-8483-4772-8e79-3d69d8477de4"
	GUIDLinuxSwap       = "0657fd6d-a4ab-43c4-84e5-0933c84b4f4f"
	GUIDLinuxLVM        = "e6d6d379-f507-44c2-a23c-238f2a3df928"
	GUIDLinuxRAID       = "a19d880f-05fc-4d3b-a006-743f0f84911e"
	GUIDLinuxLUKS       = "ca7d7ccb-63ed-4c53-861c-1742536059cc"
)

// Manifest is the on-disk/JSON shape of snapshots/<id>/layout.json.
type Manifest struct {
	SchemaVersion int        `json:"schemaVersion"`
	CollectedAt   time.Time  `json:"collectedAt"`
	Platform      string     `json:"platform"` // "linux" | "windows"
	OSRelease     string     `json:"osRelease,omitempty"`
	Hostname      string     `json:"hostname,omitempty"`
	BootMode      string     `json:"bootMode"`
	Disks         []Disk     `json:"disks"`
	EFIEntries    []EFIEntry `json:"efiEntries,omitempty"`
	Fstab         string     `json:"fstab,omitempty"` // verbatim /etc/fstab (Linux)
	// Incomplete names optional collection steps that failed ("efi_entries",
	// "fstab", "os_release", "bitlocker"). Diagnostic only — Assess does not
	// consult it, because none of these steps is required to rebuild.
	Incomplete []string `json:"incomplete,omitempty"`
}

// Disk is one physical disk.
type Disk struct {
	Name       string      `json:"name"` // /dev/sda, \\.\PHYSICALDRIVE0
	Model      string      `json:"model,omitempty"`
	Serial     string      `json:"serial,omitempty"`
	SizeBytes  int64       `json:"sizeBytes"`
	SectorSize int         `json:"sectorSize,omitempty"`
	TableType  string      `json:"tableType"` // "gpt" | "mbr" | "none" | "unknown"
	Removable  bool        `json:"removable,omitempty"`
	IsSystem   bool        `json:"isSystem"` // holds the partition mounted at / (Linux) or C:\ (Windows)
	Partitions []Partition `json:"partitions"`
}

// Partition is one partition (or, for Kind != "", a non-partition block child
// such as an LVM logical volume or dm-crypt mapping reported under the disk).
type Partition struct {
	Number     int      `json:"number"`
	Name       string   `json:"name"`
	TypeGUID   string   `json:"typeGuid,omitempty"`
	PartUUID   string   `json:"partUuid,omitempty"`
	StartBytes int64    `json:"startBytes"`
	SizeBytes  int64    `json:"sizeBytes"`
	UsedBytes  int64    `json:"usedBytes,omitempty"` // 0 when not mounted
	Filesystem string   `json:"filesystem,omitempty"`
	FSUUID     string   `json:"fsUuid,omitempty"`
	Label      string   `json:"label,omitempty"`
	MountPoint string   `json:"mountPoint,omitempty"`
	Flags      []string `json:"flags,omitempty"`
	Encryption string   `json:"encryption"`
	Role       string   `json:"role"`
	Kind       string   `json:"kind,omitempty"` // lsblk TYPE for non-"part" children: lvm, crypt, raid1, ...
}

// EFIEntry is one firmware boot entry (efibootmgr -v on Linux).
type EFIEntry struct {
	BootNum string `json:"bootNum"`
	Label   string `json:"label"`
	Path    string `json:"path,omitempty"`
	Active  bool   `json:"active"`
	Current bool   `json:"current"`
}

// Restorability is the guard's verdict, persisted on the snapshot row as
// bare_metal_restorable + bare_metal_reasons and shown in the UI.
type Restorability struct {
	Restorable bool     `json:"restorable"`
	Reasons    []string `json:"reasons"`
}

// SystemDisk returns the disk flagged IsSystem, falling back to the disk that
// holds the partition mounted at / (Linux) or C:\ (Windows). Nil when neither
// exists.
func (m *Manifest) SystemDisk() *Disk {
	if m == nil {
		return nil
	}
	for i := range m.Disks {
		if m.Disks[i].IsSystem {
			return &m.Disks[i]
		}
	}
	for i := range m.Disks {
		for _, p := range m.Disks[i].Partitions {
			if isRootMount(p.MountPoint) {
				return &m.Disks[i]
			}
		}
	}
	return nil
}

func isRootMount(mountPoint string) bool {
	return mountPoint == "/" || mountPoint == `C:\` || mountPoint == "C:"
}

func (d *Disk) partitionWithRole(role string) *Partition {
	for i := range d.Partitions {
		if d.Partitions[i].Role == role {
			return &d.Partitions[i]
		}
	}
	return nil
}
```

- [ ] **Step 4: Write `guard.go`**

```go
package layout

import (
	"fmt"
	"strings"
)

// Reason strings are operator-facing and asserted by tests — never reword
// them in a caller.
const (
	ReasonNilManifest    = "no disk layout was captured"
	ReasonBIOSBoot       = "boot mode is BIOS/MBR; only UEFI with GPT is supported"
	ReasonNoSystemDisk   = "no disk holds the root filesystem"
	ReasonNotGPT         = "system disk is not GPT-partitioned"
	ReasonNoEFIPartition = "no EFI system partition on the system disk"
	ReasonNoRoot         = "no root filesystem found on the system disk"
	ReasonMultiDisk      = "the operating system tree is spread across more than one disk"
	ReasonLVM            = "LVM volumes are not supported"
	ReasonLUKS           = "LUKS/dm-crypt encrypted volumes are not supported"
	ReasonRAID           = "software RAID members are not supported"
	ReasonBtrfs          = "btrfs root filesystem is not supported"
	ReasonZFS            = "ZFS is not supported"
)

// ReasonUnsupportedRootFS formats the root-filesystem reason for fs.
func ReasonUnsupportedRootFS(fs string) string {
	return fmt.Sprintf("root filesystem type %q is not supported (ext4, xfs, ntfs)", fs)
}

var supportedRootFS = map[string]bool{"ext4": true, "xfs": true, "ntfs": true}

// systemMountPoints are the mount points that must live on the system disk
// for a single-disk rebuild to reproduce the OS tree. Anything else on a
// second disk is user data the file backup still captures but the rebuild
// does not have to place.
var systemMountPoints = map[string]bool{
	"/": true, "/boot": true, "/boot/efi": true, "/efi": true,
	"/usr": true, "/var": true, "/etc": true, "/opt": true, "/home": true,
}

// Assess decides whether the rebuild engine (spec §6) can reproduce m.
// Reasons are appended in a fixed order: boot mode, system-disk checks,
// then the feature scan — so the output is deterministic for a given input.
func Assess(m *Manifest) Restorability {
	if m == nil {
		return Restorability{Restorable: false, Reasons: []string{ReasonNilManifest}}
	}
	reasons := []string{}
	if m.BootMode != BootModeUEFI {
		reasons = append(reasons, ReasonBIOSBoot)
	}
	sys := m.SystemDisk()
	if sys == nil {
		reasons = append(reasons, ReasonNoSystemDisk)
	} else {
		if !strings.EqualFold(sys.TableType, "gpt") {
			reasons = append(reasons, ReasonNotGPT)
		}
		if sys.partitionWithRole(RoleEFI) == nil {
			reasons = append(reasons, ReasonNoEFIPartition)
		}
		if root := sys.partitionWithRole(RoleRoot); root == nil {
			reasons = append(reasons, ReasonNoRoot)
		} else if !supportedRootFS[strings.ToLower(root.Filesystem)] {
			reasons = append(reasons, ReasonUnsupportedRootFS(root.Filesystem))
		}
	}

	var lvm, luks, raid, btrfs, zfs, multi bool
	for i := range m.Disks {
		d := &m.Disks[i]
		if d.Removable {
			continue
		}
		onSystemDisk := sys != nil && d == sys
		for _, p := range d.Partitions {
			fs := strings.ToLower(p.Filesystem)
			// A dependency of the OS tree is any partition on the system disk,
			// or any partition anywhere mounted at a system mount point.
			dependency := onSystemDisk || systemMountPoints[p.MountPoint]
			if !onSystemDisk && systemMountPoints[p.MountPoint] {
				multi = true
			}
			if !dependency {
				continue
			}
			switch {
			case p.Kind == "lvm", fs == "lvm2_member", strings.EqualFold(p.TypeGUID, GUIDLinuxLVM):
				lvm = true
			case p.Kind == "crypt", fs == "crypto_luks", p.Encryption == EncryptionLUKS:
				luks = true
			case strings.HasPrefix(p.Kind, "raid"), fs == "linux_raid_member", strings.EqualFold(p.TypeGUID, GUIDLinuxRAID):
				raid = true
			case fs == "btrfs" && isRootMount(p.MountPoint):
				btrfs = true
			case fs == "zfs_member":
				zfs = true
			}
		}
	}
	if multi {
		reasons = append(reasons, ReasonMultiDisk)
	}
	if lvm {
		reasons = append(reasons, ReasonLVM)
	}
	if luks {
		reasons = append(reasons, ReasonLUKS)
	}
	if raid {
		reasons = append(reasons, ReasonRAID)
	}
	if btrfs {
		reasons = append(reasons, ReasonBtrfs)
	}
	if zfs {
		reasons = append(reasons, ReasonZFS)
	}
	return Restorability{Restorable: len(reasons) == 0, Reasons: reasons}
}
```

- [ ] **Step 5: Run the tests**

Run: `cd agent && go test -race ./internal/backup/layout/ -run 'TestAssess|TestSystemDisk' -v 2>&1 | tail -25`
Expected: all subtests PASS. If "btrfs root" fails on ordering, note that `ReasonUnsupportedRootFS("btrfs")` comes from the system-disk block and `ReasonBtrfs` from the feature scan — the test order is intentional.

- [ ] **Step 6: Lint and commit**

Run: `cd agent && go vet ./internal/backup/layout/ && gofmt -l internal/backup/layout/` (expect no output from gofmt)

```bash
git add agent/internal/backup/layout/
git commit -m "feat(backup): layout package — manifest types and bare-metal restorability guard (W01)"
```

---

### Task 2: Root-anchored exclude patterns

**Files:**
- Modify: `agent/internal/backup/exclude.go:38-60` (compile) and `:82` (`matches`)
- Test: `agent/internal/backup/exclude_test.go` (`TestExcludeMatcher` table)

**Interfaces:**
- Consumes: nothing new.
- Produces: pattern semantics — a pattern whose raw form starts with `/` (or `\`) matches only from the selection root. Task 8's whole-machine excludes rely on this.

- [ ] **Step 1: Add failing table rows to `TestExcludeMatcher`**

Append to the `tests` slice in `exclude_test.go` (after the "case-sensitive elsewhere" row):

```go
		// Root-anchored patterns (leading slash) — gitignore semantics.
		{name: "anchored dir matches at root", patterns: []string{"/proc/**"}, relPath: "proc", want: true},
		{name: "anchored dir matches root contents", patterns: []string{"/proc/**"}, relPath: "proc/1/status", want: true},
		{name: "anchored dir does not match nested same-name dir", patterns: []string{"/proc/**"}, relPath: "home/alice/proc", want: false},
		{name: "anchored dir does not match nested same-name contents", patterns: []string{"/dev/**"}, relPath: "home/alice/dev/project/main.go", want: false},
		{name: "anchored file at root", patterns: []string{"/swapfile"}, relPath: "swapfile", want: true},
		{name: "anchored file spares nested", patterns: []string{"/swapfile"}, relPath: "backup/swapfile", want: false},
		{name: "anchored backslash form", patterns: []string{"\\pagefile.sys"}, relPath: "pagefile.sys", caseInsensitive: true, want: true},
		{name: "anchored is case-insensitive on windows", patterns: []string{"/$Recycle.Bin/**"}, relPath: "$RECYCLE.BIN/S-1-5/x", caseInsensitive: true, want: true},
		{name: "unanchored keeps any-depth behaviour", patterns: []string{"proc/**"}, relPath: "home/alice/proc/x", want: true},
```

- [ ] **Step 2: Run to verify the new rows fail**

Run: `cd agent && go test ./internal/backup/ -run TestExcludeMatcher 2>&1 | grep -E "anchored|FAIL|ok" | head -12`
Expected: the "anchored … does not match nested" and "anchored file spares nested" rows FAIL (today a leading slash is trimmed, so `/proc/**` behaves as `proc/**`).

- [ ] **Step 3: Implement anchoring**

In `exclude.go`, change the struct and compile step:

```go
type excludeMatcher struct {
	baseName        []string   // patterns without "/" — base-name globs
	relPath         [][]string // patterns with "/" — pre-split path segments
	anchored        []bool     // parallel to relPath: true when the raw pattern began with "/"
	caseInsensitive bool
}
```

In `newExcludeMatcherForOS`, replace

```go
		p := strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/")
		p = strings.Trim(p, "/")
```

with

```go
		p := strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/")
		anchored := strings.HasPrefix(p, "/")
		p = strings.Trim(p, "/")
```

An anchored pattern with no remaining slash (e.g. `/swapfile`) is a root-relative single segment, so it must go into `relPath` (not `baseName`). Change the branch condition from `if strings.Contains(p, "/")` to `if anchored || strings.Contains(p, "/")` and, where the segments are appended (`m.relPath = append(m.relPath, segs)`), also append `m.anchored = append(m.anchored, anchored)`.

In `matches(relPath string)`, the slash-pattern loop currently tries the pattern at every starting segment (implicit leading `**/`). Make it honour the flag: for `i, segs := range m.relPath`, when `m.anchored[i]` is true only attempt a match starting at segment 0. Concretely, wherever the loop computes candidate start offsets (`for start := 0; start <= len(pathSegs); start++` or equivalent), bound it with `if m.anchored[i] && start > 0 { break }`. Read the existing loop first; keep its `**` handling untouched.

- [ ] **Step 4: Run the whole exclude suite and the walker tests**

Run: `cd agent && go test -race ./internal/backup/ -run 'TestExcludeMatcher|Exclude|SkipDir' -v 2>&1 | grep -E "^(=== RUN|--- FAIL|FAIL|ok|PASS)" | grep -v "=== RUN" | head`
Expected: `ok`; no FAIL lines. Existing rows (unanchored) must still pass unchanged.

- [ ] **Step 5: Update the doc comment at the top of `exclude.go`**

Add one bullet to the pattern-forms comment:

```go
//   - "/proc/**", "/swapfile"            — leading slash: root-anchored, matched
//     only from the selection root (gitignore semantics). Without the slash a
//     pattern matches at any depth.
```

- [ ] **Step 6: Commit**

```bash
git add agent/internal/backup/exclude.go agent/internal/backup/exclude_test.go
git commit -m "feat(backup): root-anchored exclude patterns (leading slash) for whole-machine selections (W01)"
```

---

### Task 3: Linux layout parsing (no build tags)

**Files:**
- Create: `agent/internal/backup/layout/linux_parse.go`
- Test: `agent/internal/backup/layout/linux_parse_test.go`

**Interfaces:**
- Produces: `parseLsblk(data []byte) ([]Disk, error)`, `parseEFIBootMgr(out string) []EFIEntry`, `parseOSRelease(s string) string`, `lsblkColumns` constant, `flexInt64`/`flexBool` JSON helpers, `partitionNumberFromName(name string) int`, `assignLinuxRoles(disks []Disk)`. Task 4's Linux collector calls these.

- [ ] **Step 1: Write the failing parser tests**

```go
package layout

import (
	"reflect"
	"testing"
)

// util-linux ≥ 2.37 emits numbers/bools unquoted; older versions quote them.
const lsblkModern = `{"blockdevices": [
 {"name":"sda","path":"/dev/sda","type":"disk","size":68719476736,"model":"Virtual Disk","serial":"6000c29c","rm":false,"pttype":"gpt","parttype":null,"partuuid":null,"partflags":null,"fstype":null,"uuid":null,"label":null,"mountpoint":null,"fsused":null,"start":null,"log-sec":512,
  "children":[
   {"name":"sda1","path":"/dev/sda1","type":"part","size":536870912,"model":null,"serial":null,"rm":false,"pttype":"gpt","parttype":"c12a7328-f81f-11d2-ba4b-00a0c93ec93b","partuuid":"1111-aaaa","partflags":null,"fstype":"vfat","uuid":"ABCD-1234","label":null,"mountpoint":"/boot/efi","fsused":6291456,"start":2048,"log-sec":512},
   {"name":"sda2","path":"/dev/sda2","type":"part","size":68180508672,"model":null,"serial":null,"rm":false,"pttype":"gpt","parttype":"0fc63daf-8483-4772-8e79-3d69d8477de4","partuuid":"2222-bbbb","partflags":null,"fstype":"ext4","uuid":"9f7a-root","label":"cloudimg-rootfs","mountpoint":"/","fsused":8589934592,"start":1050624,"log-sec":512}
  ]},
 {"name":"sdb","path":"/dev/sdb","type":"disk","size":107374182400,"model":"Data","serial":"6000c2ff","rm":false,"pttype":"gpt","fstype":null,"mountpoint":null,"log-sec":512,
  "children":[
   {"name":"sdb1","path":"/dev/sdb1","type":"part","size":107372085248,"pttype":"gpt","parttype":"0fc63daf-8483-4772-8e79-3d69d8477de4","partuuid":"3333-cccc","fstype":"crypto_LUKS","uuid":"luks-uuid","mountpoint":null,"start":2048,"log-sec":512,
    "children":[{"name":"data_crypt","path":"/dev/mapper/data_crypt","type":"crypt","size":107355308032,"fstype":"ext4","uuid":"inner","mountpoint":"/srv/data","fsused":1024,"log-sec":512}]}
  ]},
 {"name":"sr0","path":"/dev/sr0","type":"rom","size":1073741824,"rm":true,"fstype":null,"mountpoint":null},
 {"name":"loop0","path":"/dev/loop0","type":"loop","size":4096,"fstype":"squashfs","mountpoint":"/snap/core/1"}
]}`

const lsblkLegacyQuoted = `{"blockdevices": [
 {"name":"nvme0n1","path":"/dev/nvme0n1","type":"disk","size":"512110190592","model":"Samsung","serial":"S4EV","rm":"0","pttype":"gpt","log-sec":"512",
  "children":[
   {"name":"nvme0n1p1","path":"/dev/nvme0n1p1","type":"part","size":"1073741824","pttype":"gpt","parttype":"c12a7328-f81f-11d2-ba4b-00a0c93ec93b","partuuid":"p1","fstype":"vfat","uuid":"EFI1","mountpoint":"/boot/efi","fsused":"1048576","start":"2048","log-sec":"512"},
   {"name":"nvme0n1p2","path":"/dev/nvme0n1p2","type":"part","size":"511035342848","pttype":"gpt","parttype":"0fc63daf-8483-4772-8e79-3d69d8477de4","partuuid":"p2","fstype":"xfs","uuid":"ROOT1","mountpoint":"/","fsused":"20000000000","start":"2099200","log-sec":"512"}
  ]}
]}`

func TestParseLsblkModern(t *testing.T) {
	disks, err := parseLsblk([]byte(lsblkModern))
	if err != nil {
		t.Fatal(err)
	}
	if len(disks) != 2 {
		t.Fatalf("got %d disks (%+v), want 2 (rom/loop skipped)", len(disks), disks)
	}
	sda := disks[0]
	if sda.Name != "/dev/sda" || sda.TableType != "gpt" || sda.Model != "Virtual Disk" || sda.Serial != "6000c29c" || sda.SectorSize != 512 || !sda.IsSystem {
		t.Fatalf("sda = %+v", sda)
	}
	want1 := Partition{Number: 1, Name: "/dev/sda1", TypeGUID: GUIDEFISystem, PartUUID: "1111-aaaa", StartBytes: 2048 * 512, SizeBytes: 536870912, UsedBytes: 6291456, Filesystem: "vfat", FSUUID: "ABCD-1234", MountPoint: "/boot/efi", Encryption: EncryptionNone, Role: RoleEFI}
	if !reflect.DeepEqual(sda.Partitions[0], want1) {
		t.Errorf("sda1 = %+v\nwant %+v", sda.Partitions[0], want1)
	}
	if sda.Partitions[1].Role != RoleRoot || sda.Partitions[1].Label != "cloudimg-rootfs" || sda.Partitions[1].StartBytes != 1050624*512 {
		t.Errorf("sda2 = %+v", sda.Partitions[1])
	}
	sdb := disks[1]
	if sdb.IsSystem {
		t.Errorf("sdb must not be the system disk")
	}
	if got := sdb.Partitions[0]; got.Filesystem != "crypto_LUKS" || got.Encryption != EncryptionLUKS {
		t.Errorf("sdb1 = %+v, want LUKS", got)
	}
	// The dm-crypt child is reported as a Kind="crypt" entry under the same disk.
	if len(sdb.Partitions) != 2 || sdb.Partitions[1].Kind != "crypt" || sdb.Partitions[1].MountPoint != "/srv/data" || sdb.Partitions[1].Number != 0 {
		t.Errorf("sdb children = %+v", sdb.Partitions)
	}
}

func TestParseLsblkLegacyQuotedNumbers(t *testing.T) {
	disks, err := parseLsblk([]byte(lsblkLegacyQuoted))
	if err != nil {
		t.Fatal(err)
	}
	if len(disks) != 1 || disks[0].SizeBytes != 512110190592 || disks[0].Removable {
		t.Fatalf("disks = %+v", disks)
	}
	p := disks[0].Partitions
	if p[0].Number != 1 || p[1].Number != 2 {
		t.Errorf("nvme partition numbers = %d,%d want 1,2", p[0].Number, p[1].Number)
	}
	if p[1].Filesystem != "xfs" || p[1].Role != RoleRoot || p[1].UsedBytes != 20000000000 {
		t.Errorf("p2 = %+v", p[1])
	}
}

func TestParseLsblkRejectsGarbage(t *testing.T) {
	if _, err := parseLsblk([]byte("not json")); err == nil {
		t.Fatal("expected error")
	}
}

func TestPartitionNumberFromName(t *testing.T) {
	for name, want := range map[string]int{"sda1": 1, "sda12": 12, "nvme0n1p3": 3, "mmcblk0p2": 2, "sda": 0, "data_crypt": 0} {
		if got := partitionNumberFromName(name); got != want {
			t.Errorf("%s: got %d want %d", name, got, want)
		}
	}
}

func TestParseEFIBootMgr(t *testing.T) {
	out := "BootCurrent: 0001\nTimeout: 1 seconds\nBootOrder: 0001,0000,0002\n" +
		"Boot0000* UiApp\tFvVol(7cb8bdc9-f8eb-4f34-aaea-3ee4af6516a1)/FvFile(462caa21-7614-4503-836e-8ab6f4662331)\n" +
		"Boot0001* ubuntu\tHD(1,GPT,1111-aaaa,0x800,0x100000)/File(\\EFI\\ubuntu\\shimx64.efi)\n" +
		"Boot0002  Windows Boot Manager\tHD(1,GPT,abcd,0x800,0x100000)/File(\\EFI\\Microsoft\\Boot\\bootmgfw.efi)\n"
	got := parseEFIBootMgr(out)
	want := []EFIEntry{
		{BootNum: "0000", Label: "UiApp", Path: "FvVol(7cb8bdc9-f8eb-4f34-aaea-3ee4af6516a1)/FvFile(462caa21-7614-4503-836e-8ab6f4662331)", Active: true},
		{BootNum: "0001", Label: "ubuntu", Path: `HD(1,GPT,1111-aaaa,0x800,0x100000)/File(\EFI\ubuntu\shimx64.efi)`, Active: true, Current: true},
		{BootNum: "0002", Label: "Windows Boot Manager", Path: `HD(1,GPT,abcd,0x800,0x100000)/File(\EFI\Microsoft\Boot\bootmgfw.efi)`, Active: false},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
}

func TestParseOSRelease(t *testing.T) {
	s := "NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nID=ubuntu\n"
	if got := parseOSRelease(s); got != "Ubuntu 24.04.1 LTS" {
		t.Errorf("got %q", got)
	}
	if got := parseOSRelease("ID=alpine\nNAME=Alpine\n"); got != "Alpine" {
		t.Errorf("fallback to NAME, got %q", got)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go test ./internal/backup/layout/ -run 'TestParse|TestPartitionNumber' 2>&1 | head -5`
Expected: build failure — `undefined: parseLsblk` etc.

- [ ] **Step 3: Implement `linux_parse.go`**

```go
package layout

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// lsblkColumns is the exact -o list the Linux collector requests. Every
// column exists in util-linux ≥ 2.33 (Ubuntu 20.04 / RHEL 8 baseline).
const lsblkColumns = "NAME,PATH,TYPE,SIZE,MODEL,SERIAL,RM,PTTYPE,PARTTYPE,PARTUUID,PARTFLAGS,FSTYPE,UUID,LABEL,MOUNTPOINT,FSUSED,START,LOG-SEC"

// flexInt64 decodes a JSON number, a quoted number (util-linux < 2.37) or
// null.
type flexInt64 int64

func (f *flexInt64) UnmarshalJSON(b []byte) error {
	s := strings.Trim(strings.TrimSpace(string(b)), `"`)
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return fmt.Errorf("lsblk numeric field %q: %w", s, err)
	}
	*f = flexInt64(v)
	return nil
}

// flexBool decodes true/false, "0"/"1", "true"/"false" or null.
type flexBool bool

func (f *flexBool) UnmarshalJSON(b []byte) error {
	s := strings.Trim(strings.TrimSpace(string(b)), `"`)
	switch s {
	case "1", "true":
		*f = true
	default:
		*f = false
	}
	return nil
}

type lsblkNode struct {
	Name       string      `json:"name"`
	Path       string      `json:"path"`
	Type       string      `json:"type"`
	Size       flexInt64   `json:"size"`
	Model      *string     `json:"model"`
	Serial     *string     `json:"serial"`
	RM         flexBool    `json:"rm"`
	PTType     *string     `json:"pttype"`
	PartType   *string     `json:"parttype"`
	PartUUID   *string     `json:"partuuid"`
	PartFlags  *string     `json:"partflags"`
	FSType     *string     `json:"fstype"`
	UUID       *string     `json:"uuid"`
	Label      *string     `json:"label"`
	MountPoint *string     `json:"mountpoint"`
	FSUsed     flexInt64   `json:"fsused"`
	Start      flexInt64   `json:"start"`
	LogSec     flexInt64   `json:"log-sec"`
	Children   []lsblkNode `json:"children"`
}

type lsblkDoc struct {
	BlockDevices []lsblkNode `json:"blockdevices"`
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return strings.TrimSpace(*p)
}

// parseLsblk converts `lsblk -J -b -o lsblkColumns` output into Disks.
// Only TYPE=disk nodes become disks (rom/loop/zram are skipped). Partition
// children become Partitions; deeper children (lvm, crypt, raid*) are
// flattened under the same disk with Kind set and Number 0, so the guard can
// see them.
func parseLsblk(data []byte) ([]Disk, error) {
	var doc lsblkDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("decode lsblk json: %w", err)
	}
	if len(doc.BlockDevices) == 0 {
		return nil, errors.New("lsblk reported no block devices")
	}
	var disks []Disk
	for _, dev := range doc.BlockDevices {
		if dev.Type != "disk" {
			continue
		}
		sector := int(dev.LogSec)
		if sector <= 0 {
			sector = 512
		}
		d := Disk{
			Name:       devicePath(dev),
			Model:      str(dev.Model),
			Serial:     str(dev.Serial),
			SizeBytes:  int64(dev.Size),
			SectorSize: sector,
			TableType:  tableType(str(dev.PTType)),
			Removable:  bool(dev.RM),
			Partitions: []Partition{},
		}
		for _, child := range dev.Children {
			appendLinuxChild(&d, child, sector)
		}
		disks = append(disks, d)
	}
	assignLinuxRoles(disks)
	return disks, nil
}

func devicePath(n lsblkNode) string {
	if n.Path != "" {
		return n.Path
	}
	return "/dev/" + n.Name
}

func tableType(pttype string) string {
	switch strings.ToLower(pttype) {
	case "gpt":
		return "gpt"
	case "dos", "mbr":
		return "mbr"
	case "":
		return "none"
	default:
		return "unknown"
	}
}

func appendLinuxChild(d *Disk, n lsblkNode, sector int) {
	p := Partition{
		Name:       devicePath(n),
		TypeGUID:   strings.ToLower(str(n.PartType)),
		PartUUID:   str(n.PartUUID),
		StartBytes: int64(n.Start) * int64(sector),
		SizeBytes:  int64(n.Size),
		UsedBytes:  int64(n.FSUsed),
		Filesystem: str(n.FSType),
		FSUUID:     str(n.UUID),
		Label:      str(n.Label),
		MountPoint: str(n.MountPoint),
		Encryption: EncryptionNone,
		Role:       RoleUnknown,
	}
	if flags := str(n.PartFlags); flags != "" {
		p.Flags = strings.Split(flags, ",")
	}
	if n.Type == "part" {
		p.Number = partitionNumberFromName(n.Name)
	} else {
		p.Kind = n.Type
		p.StartBytes = 0
	}
	if strings.EqualFold(p.Filesystem, "crypto_LUKS") || n.Type == "crypt" {
		p.Encryption = EncryptionLUKS
	}
	d.Partitions = append(d.Partitions, p)
	for _, grand := range n.Children {
		appendLinuxChild(d, grand, sector)
	}
}

var trailingDigits = regexp.MustCompile(`p?(\d+)$`)

// partitionNumberFromName extracts the partition number from a kernel
// name: sda1 → 1, nvme0n1p3 → 3, mmcblk0p2 → 2. Non-partitions → 0.
func partitionNumberFromName(name string) int {
	m := trailingDigits.FindStringSubmatch(name)
	if m == nil {
		return 0
	}
	// Reject a bare disk name whose digits are part of the base (nvme0n1, loop0).
	base := strings.TrimSuffix(name, m[0])
	if base == "" || strings.HasSuffix(base, "nvme0n") || !strings.ContainsAny(base, "abcdefghijklmnopqrstuvwxyz") {
		return 0
	}
	if strings.HasPrefix(name, "nvme") && !strings.Contains(name, "p") {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

// assignLinuxRoles fills Partition.Role and Disk.IsSystem from GPT type
// GUIDs, filesystems and mount points.
func assignLinuxRoles(disks []Disk) {
	for i := range disks {
		d := &disks[i]
		for j := range d.Partitions {
			p := &d.Partitions[j]
			fs := strings.ToLower(p.Filesystem)
			switch {
			case p.TypeGUID == GUIDEFISystem, fs == "vfat" && (p.MountPoint == "/boot/efi" || p.MountPoint == "/efi"):
				p.Role = RoleEFI
			case p.MountPoint == "/":
				p.Role = RoleRoot
				d.IsSystem = true
			case p.MountPoint == "/boot":
				p.Role = RoleBoot
			case fs == "swap", p.TypeGUID == GUIDLinuxSwap:
				p.Role = RoleSwap
			case p.MountPoint != "" || fs != "":
				p.Role = RoleData
			}
		}
	}
}

var efiEntryRe = regexp.MustCompile(`^Boot([0-9A-Fa-f]{4})(\*?)\s+(.*?)\t(.*)$`)

// parseEFIBootMgr parses `efibootmgr -v`. Entries without a tab (no device
// path) still parse with an empty Path.
func parseEFIBootMgr(out string) []EFIEntry {
	var entries []EFIEntry
	current := ""
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.HasPrefix(line, "BootCurrent:") {
			current = strings.TrimSpace(strings.TrimPrefix(line, "BootCurrent:"))
			continue
		}
		if !strings.HasPrefix(line, "Boot") || len(line) < 8 {
			continue
		}
		m := efiEntryRe.FindStringSubmatch(line)
		if m == nil {
			// "Boot0003  Label" with no device path.
			rest := line[4:]
			if len(rest) < 4 {
				continue
			}
			num := rest[:4]
			if _, err := strconv.ParseUint(num, 16, 16); err != nil {
				continue
			}
			rest = rest[4:]
			active := strings.HasPrefix(rest, "*")
			entries = append(entries, EFIEntry{BootNum: num, Label: strings.TrimSpace(strings.TrimPrefix(rest, "*")), Active: active, Current: num == current})
			continue
		}
		entries = append(entries, EFIEntry{BootNum: m[1], Label: strings.TrimSpace(m[3]), Path: strings.TrimSpace(m[4]), Active: m[2] == "*", Current: m[1] == current})
	}
	return entries
}

// parseOSRelease returns PRETTY_NAME, falling back to NAME.
func parseOSRelease(s string) string {
	var name string
	for _, line := range strings.Split(s, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"'`)
		switch k {
		case "PRETTY_NAME":
			return v
		case "NAME":
			name = v
		}
	}
	return name
}
```

- [ ] **Step 4: Run the tests**

Run: `cd agent && go test -race ./internal/backup/layout/ -v 2>&1 | grep -E "^(--- FAIL|FAIL|ok)" `
Expected: `ok`. If `TestPartitionNumberFromName` fails on `nvme0n1` → 0, simplify: return 0 when the name has no letter after the last digit-run boundary; the table in the test is the contract, adjust the helper until it passes all six names.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/backup/layout/linux_parse.go agent/internal/backup/layout/linux_parse_test.go
git commit -m "feat(backup): layout — lsblk/efibootmgr/os-release parsers with role assignment (W01)"
```

---

### Task 4: Collectors — Linux, Windows, other

**Files:**
- Create: `agent/internal/backup/layout/collect_linux.go` (`//go:build linux`)
- Create: `agent/internal/backup/layout/collect_windows.go` (`//go:build windows`)
- Create: `agent/internal/backup/layout/collect_other.go` (`//go:build !linux && !windows`)
- Create: `agent/internal/backup/layout/windows_parse.go` (no tag)
- Test: `agent/internal/backup/layout/collect_linux_test.go` (`//go:build linux`), `agent/internal/backup/layout/windows_parse_test.go` (no tag)

**Interfaces:**
- Produces: `layout.Collect(ctx context.Context) (*Manifest, error)` on every GOOS; `parseWindowsLayout(data []byte) (*Manifest, error)`; `windowsLayoutScript` constant. Task 5 wires `Collect` through a seam.
- Seams (package vars, swapped by tests): `runCommand func(ctx, name string, args ...string) ([]byte, error)`, `readFile func(string) ([]byte, error)`, `statPath func(string) (os.FileInfo, error)`, `hostname func() (string, error)`.

- [ ] **Step 1: Write the failing Linux collector test**

```go
//go:build linux

package layout

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
)

func fakeLinuxHost(t *testing.T, cmds map[string][]byte, files map[string][]byte, efi bool) {
	t.Helper()
	origRun, origRead, origStat, origHost := runCommand, readFile, statPath, hostname
	t.Cleanup(func() { runCommand, readFile, statPath, hostname = origRun, origRead, origStat, origHost })
	runCommand = func(_ context.Context, name string, args ...string) ([]byte, error) {
		key := name + " " + strings.Join(args, " ")
		if out, ok := cmds[key]; ok {
			return out, nil
		}
		return nil, errors.New("exec: " + name + ": not found")
	}
	readFile = func(p string) ([]byte, error) {
		if b, ok := files[p]; ok {
			return b, nil
		}
		return nil, os.ErrNotExist
	}
	statPath = func(p string) (os.FileInfo, error) {
		if p == "/sys/firmware/efi" && efi {
			return nil, nil
		}
		return nil, os.ErrNotExist
	}
	hostname = func() (string, error) { return "srv-1", nil }
}

func TestCollectLinuxUEFI(t *testing.T) {
	fakeLinuxHost(t,
		map[string][]byte{
			"lsblk -J -b -o " + lsblkColumns: []byte(lsblkModern),
			"efibootmgr -v": []byte("BootCurrent: 0001\nBoot0001* ubuntu\tHD(1,GPT,1111-aaaa,0x800,0x100000)/File(\\EFI\\ubuntu\\shimx64.efi)\n"),
		},
		map[string][]byte{
			"/etc/os-release": []byte("PRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n"),
			"/etc/fstab":      []byte("UUID=9f7a-root / ext4 defaults 0 1\n"),
		}, true)
	m, err := Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if m.SchemaVersion != SchemaVersion || m.Platform != "linux" || m.BootMode != BootModeUEFI || m.Hostname != "srv-1" || m.OSRelease != "Ubuntu 24.04.1 LTS" {
		t.Fatalf("manifest header = %+v", m)
	}
	if m.CollectedAt.IsZero() {
		t.Error("CollectedAt not set")
	}
	if len(m.Disks) != 2 || !m.Disks[0].IsSystem {
		t.Fatalf("disks = %+v", m.Disks)
	}
	if len(m.EFIEntries) != 1 || !m.EFIEntries[0].Current {
		t.Errorf("efi entries = %+v", m.EFIEntries)
	}
	if !strings.Contains(m.Fstab, "9f7a-root") || len(m.Incomplete) != 0 {
		t.Errorf("fstab=%q incomplete=%v", m.Fstab, m.Incomplete)
	}
	if v := Assess(m); !v.Restorable {
		t.Errorf("expected restorable, reasons=%v", v.Reasons)
	}
}

func TestCollectLinuxBIOSAndMissingOptionalTools(t *testing.T) {
	fakeLinuxHost(t, map[string][]byte{"lsblk -J -b -o " + lsblkColumns: []byte(lsblkModern)}, nil, false)
	m, err := Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if m.BootMode != BootModeBIOS {
		t.Errorf("bootMode = %q", m.BootMode)
	}
	// No efibootmgr call on BIOS; fstab + os-release missing are recorded, not fatal.
	want := []string{"os_release", "fstab"}
	if strings.Join(m.Incomplete, ",") != strings.Join(want, ",") {
		t.Errorf("incomplete = %v want %v", m.Incomplete, want)
	}
	if v := Assess(m); v.Restorable || v.Reasons[0] != ReasonBIOSBoot {
		t.Errorf("verdict = %+v", v)
	}
}

func TestCollectLinuxLsblkFailureIsFatal(t *testing.T) {
	fakeLinuxHost(t, nil, nil, true)
	if _, err := Collect(context.Background()); err == nil || !strings.Contains(err.Error(), "lsblk") {
		t.Fatalf("err = %v, want lsblk failure", err)
	}
}
```

- [ ] **Step 2: Write the failing Windows parse test** (`windows_parse_test.go`, no build tag)

```go
package layout

import "testing"

const windowsLayoutJSON = `{"firmware":"UEFI","os":"Microsoft Windows Server 2022 Standard","hostname":"WIN-A",
"disks":[{"Number":0,"FriendlyName":"Msft Virtual Disk","SerialNumber":"6002248","Size":137438953472,"PartitionStyle":"GPT","IsSystem":true,"IsBoot":true,"LogicalSectorSize":512,"BusType":"SAS"},
         {"Number":1,"FriendlyName":"USB Flash","SerialNumber":"USB1","Size":32000000000,"PartitionStyle":"MBR","IsSystem":false,"IsBoot":false,"LogicalSectorSize":512,"BusType":"USB"}],
"partitions":[
 {"DiskNumber":0,"PartitionNumber":1,"Guid":"{aaaa-1}","GptType":"{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}","Offset":1048576,"Size":104857600,"DriveLetter":"\u0000","IsSystem":true,"IsBoot":false,"IsActive":false,"IsHidden":true,"Type":"System","AccessPaths":["\\\\?\\Volume{efi-guid}\\"]},
 {"DiskNumber":0,"PartitionNumber":2,"Guid":"{aaaa-2}","GptType":"{e3c9e316-0b5c-4db8-817d-f92df00215ae}","Offset":105906176,"Size":16777216,"DriveLetter":"\u0000","IsSystem":false,"IsBoot":false,"IsActive":false,"IsHidden":true,"Type":"Reserved","AccessPaths":null},
 {"DiskNumber":0,"PartitionNumber":3,"Guid":"{aaaa-3}","GptType":"{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}","Offset":122683392,"Size":136700000000,"DriveLetter":"C","IsSystem":false,"IsBoot":true,"IsActive":false,"IsHidden":false,"Type":"Basic","AccessPaths":["C:\\","\\\\?\\Volume{c-guid}\\"]},
 {"DiskNumber":0,"PartitionNumber":4,"Guid":"{aaaa-4}","GptType":"{de94bba4-06d1-4d40-a16a-bfd50179d6ac}","Offset":136822683392,"Size":600000000,"DriveLetter":"\u0000","IsSystem":false,"IsBoot":false,"IsActive":false,"IsHidden":true,"Type":"Recovery","AccessPaths":["\\\\?\\Volume{rec-guid}\\"]},
 {"DiskNumber":1,"PartitionNumber":1,"Guid":null,"GptType":null,"Offset":1048576,"Size":31000000000,"DriveLetter":"E","IsSystem":false,"IsBoot":false,"IsActive":true,"IsHidden":false,"Type":"IFS","AccessPaths":["E:\\"]}],
"volumes":[
 {"DriveLetter":"C","Path":"\\\\?\\Volume{c-guid}\\","UniqueId":"\\\\?\\Volume{c-guid}\\","FileSystem":"NTFS","FileSystemLabel":"OS","Size":136700000000,"SizeRemaining":90000000000},
 {"DriveLetter":null,"Path":"\\\\?\\Volume{efi-guid}\\","UniqueId":"\\\\?\\Volume{efi-guid}\\","FileSystem":"FAT32","FileSystemLabel":"SYSTEM","Size":104857600,"SizeRemaining":70000000},
 {"DriveLetter":"E","Path":"\\\\?\\Volume{e-guid}\\","UniqueId":"\\\\?\\Volume{e-guid}\\","FileSystem":"exFAT","FileSystemLabel":"USB","Size":31000000000,"SizeRemaining":1000}],
"bitlocker":[{"MountPoint":"C:","ProtectionStatus":1}]}`

func TestParseWindowsLayout(t *testing.T) {
	m, err := parseWindowsLayout([]byte(windowsLayoutJSON))
	if err != nil {
		t.Fatal(err)
	}
	if m.Platform != "windows" || m.BootMode != BootModeUEFI || m.OSRelease != "Microsoft Windows Server 2022 Standard" || m.Hostname != "WIN-A" {
		t.Fatalf("header = %+v", m)
	}
	if len(m.Disks) != 2 {
		t.Fatalf("disks = %+v", m.Disks)
	}
	d0 := m.Disks[0]
	if d0.Name != `\\.\PHYSICALDRIVE0` || d0.TableType != "gpt" || !d0.IsSystem || d0.Serial != "6002248" || d0.SectorSize != 512 || d0.Removable {
		t.Fatalf("disk0 = %+v", d0)
	}
	if m.Disks[1].TableType != "mbr" || !m.Disks[1].Removable || m.Disks[1].IsSystem {
		t.Errorf("disk1 = %+v", m.Disks[1])
	}
	p := d0.Partitions
	if len(p) != 4 {
		t.Fatalf("disk0 partitions = %+v", p)
	}
	if p[0].Role != RoleEFI || p[0].TypeGUID != GUIDEFISystem || p[0].Filesystem != "fat32" || p[0].PartUUID != "aaaa-1" || p[0].StartBytes != 1048576 || p[0].UsedBytes != 104857600-70000000 {
		t.Errorf("efi = %+v", p[0])
	}
	if p[1].Role != RoleMSR || p[1].Filesystem != "" {
		t.Errorf("msr = %+v", p[1])
	}
	if p[2].Role != RoleRoot || p[2].MountPoint != `C:\` || p[2].Filesystem != "ntfs" || p[2].Label != "OS" || p[2].Encryption != EncryptionBitLocker || p[2].UsedBytes != 136700000000-90000000000 {
		t.Errorf("C: = %+v", p[2])
	}
	if p[3].Role != RoleRecovery {
		t.Errorf("recovery = %+v", p[3])
	}
	if v := Assess(m); !v.Restorable {
		t.Errorf("verdict = %+v", v)
	}
}

func TestParseWindowsLayoutLegacyFirmwareAndNoBitLockerModule(t *testing.T) {
	m, err := parseWindowsLayout([]byte(`{"firmware":"Legacy","os":"Windows 10 Pro","hostname":"PC","disks":[{"Number":0,"FriendlyName":"X","SerialNumber":"","Size":1,"PartitionStyle":"MBR","IsSystem":true,"IsBoot":true,"LogicalSectorSize":512,"BusType":"SATA"}],"partitions":[],"volumes":[],"bitlocker":null}`))
	if err != nil {
		t.Fatal(err)
	}
	if m.BootMode != BootModeBIOS || len(m.Incomplete) != 1 || m.Incomplete[0] != "bitlocker" {
		t.Errorf("m = %+v", m)
	}
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd agent && go test ./internal/backup/layout/ 2>&1 | head -5`
Expected: build failure (`undefined: Collect`, `undefined: parseWindowsLayout`).

- [ ] **Step 4: Implement `collect_linux.go`**

```go
//go:build linux

package layout

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"time"
)

// Seams — swapped by tests (see bmr/restore_linux.go:29 for the pattern).
var (
	runCommand = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return exec.CommandContext(ctx, name, args...).Output()
	}
	readFile = os.ReadFile
	statPath = os.Stat
	hostname = os.Hostname
)

const collectTimeout = 30 * time.Second

// Collect captures the Linux disk layout. lsblk is required; every other
// input is optional and recorded in Manifest.Incomplete when missing.
func Collect(ctx context.Context) (*Manifest, error) {
	ctx, cancel := context.WithTimeout(ctx, collectTimeout)
	defer cancel()

	m := &Manifest{SchemaVersion: SchemaVersion, CollectedAt: time.Now().UTC(), Platform: "linux", BootMode: BootModeBIOS}
	m.Hostname, _ = hostname()
	if _, err := statPath("/sys/firmware/efi"); err == nil {
		m.BootMode = BootModeUEFI
	}
	if data, err := readFile("/etc/os-release"); err == nil {
		m.OSRelease = parseOSRelease(string(data))
	} else {
		m.Incomplete = append(m.Incomplete, "os_release")
	}

	out, err := runCommand(ctx, "lsblk", "-J", "-b", "-o", lsblkColumns)
	if err != nil {
		return nil, fmt.Errorf("lsblk: %w", err)
	}
	disks, err := parseLsblk(out)
	if err != nil {
		return nil, fmt.Errorf("lsblk: %w", err)
	}
	m.Disks = disks

	if m.BootMode == BootModeUEFI {
		if out, err := runCommand(ctx, "efibootmgr", "-v"); err == nil {
			m.EFIEntries = parseEFIBootMgr(string(out))
		} else {
			m.Incomplete = append(m.Incomplete, "efi_entries")
		}
	}
	if data, err := readFile("/etc/fstab"); err == nil {
		m.Fstab = string(data)
	} else {
		m.Incomplete = append(m.Incomplete, "fstab")
	}
	return m, nil
}
```

- [ ] **Step 5: Implement `windows_parse.go`** (no build tag)

```go
package layout

import (
	"encoding/json"
	"fmt"
	"strings"
)

// windowsLayoutScript is run by the Windows collector through
// `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`.
// Get-BitLockerVolume is absent on editions without the BitLocker module, so
// it is best-effort and reported as Incomplete "bitlocker".
const windowsLayoutScript = `$ErrorActionPreference='Stop'
$disks = @(Get-Disk | Select-Object Number,FriendlyName,SerialNumber,Size,PartitionStyle,IsSystem,IsBoot,LogicalSectorSize,BusType)
$parts = @(Get-Partition | Select-Object DiskNumber,PartitionNumber,Guid,GptType,Offset,Size,DriveLetter,IsSystem,IsBoot,IsActive,IsHidden,Type,AccessPaths)
$vols  = @(Get-Volume | Select-Object DriveLetter,Path,UniqueId,FileSystem,FileSystemLabel,Size,SizeRemaining)
$bl = $null
try { $bl = @(Get-BitLockerVolume | Select-Object MountPoint,ProtectionStatus) } catch { $bl = $null }
[pscustomobject]@{
  firmware = [string]$env:firmware_type
  os       = (Get-CimInstance Win32_OperatingSystem).Caption
  hostname = $env:COMPUTERNAME
  disks = $disks; partitions = $parts; volumes = $vols; bitlocker = $bl
} | ConvertTo-Json -Depth 6 -Compress`

type winDisk struct {
	Number            int    `json:"Number"`
	FriendlyName      string `json:"FriendlyName"`
	SerialNumber      string `json:"SerialNumber"`
	Size              int64  `json:"Size"`
	PartitionStyle    string `json:"PartitionStyle"`
	IsSystem          bool   `json:"IsSystem"`
	IsBoot            bool   `json:"IsBoot"`
	LogicalSectorSize int    `json:"LogicalSectorSize"`
	BusType           string `json:"BusType"`
}

type winPartition struct {
	DiskNumber      int             `json:"DiskNumber"`
	PartitionNumber int             `json:"PartitionNumber"`
	Guid            *string         `json:"Guid"`
	GptType         *string         `json:"GptType"`
	Offset          int64           `json:"Offset"`
	Size            int64           `json:"Size"`
	DriveLetter     json.RawMessage `json:"DriveLetter"`
	IsSystem        bool            `json:"IsSystem"`
	IsBoot          bool            `json:"IsBoot"`
	IsActive        bool            `json:"IsActive"`
	IsHidden        bool            `json:"IsHidden"`
	Type            string          `json:"Type"`
	AccessPaths     []string        `json:"AccessPaths"`
}

type winVolume struct {
	DriveLetter     json.RawMessage `json:"DriveLetter"`
	Path            string          `json:"Path"`
	UniqueId        string          `json:"UniqueId"`
	FileSystem      string          `json:"FileSystem"`
	FileSystemLabel string          `json:"FileSystemLabel"`
	Size            int64           `json:"Size"`
	SizeRemaining   int64           `json:"SizeRemaining"`
}

type winBitLocker struct {
	MountPoint       string          `json:"MountPoint"`
	ProtectionStatus json.RawMessage `json:"ProtectionStatus"`
}

type winLayoutDoc struct {
	Firmware   string          `json:"firmware"`
	OS         string          `json:"os"`
	Hostname   string          `json:"hostname"`
	Disks      []winDisk       `json:"disks"`
	Partitions []winPartition  `json:"partitions"`
	Volumes    []winVolume     `json:"volumes"`
	BitLocker  json.RawMessage `json:"bitlocker"`
}

// driveLetter decodes PowerShell's [char] DriveLetter: "C", "\u0000", "", null, or 0.
func driveLetter(raw json.RawMessage) string {
	s := strings.Trim(strings.TrimSpace(string(raw)), `"`)
	if s == "" || s == "null" || s == "0" || s == `\u0000` || s == "\x00" {
		return ""
	}
	return strings.ToUpper(s[:1])
}

func normalizeGUID(p *string) string {
	if p == nil {
		return ""
	}
	return strings.ToLower(strings.Trim(strings.TrimSpace(*p), "{}"))
}

func removableBus(bus string) bool {
	switch strings.ToUpper(bus) {
	case "USB", "SD", "MMC", "1394":
		return true
	}
	return false
}

// parseWindowsLayout converts the script's JSON into a Manifest.
func parseWindowsLayout(data []byte) (*Manifest, error) {
	var doc winLayoutDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("decode windows layout json: %w", err)
	}
	m := &Manifest{SchemaVersion: SchemaVersion, Platform: "windows", OSRelease: doc.OS, Hostname: doc.Hostname, BootMode: BootModeBIOS}
	if strings.EqualFold(doc.Firmware, "UEFI") {
		m.BootMode = BootModeUEFI
	}

	volByPath := map[string]winVolume{}
	volByLetter := map[string]winVolume{}
	for _, v := range doc.Volumes {
		if v.Path != "" {
			volByPath[strings.ToLower(v.Path)] = v
		}
		if v.UniqueId != "" {
			volByPath[strings.ToLower(v.UniqueId)] = v
		}
		if l := driveLetter(v.DriveLetter); l != "" {
			volByLetter[l] = v
		}
	}

	bitlocked := map[string]bool{}
	var bl []winBitLocker
	if len(doc.BitLocker) == 0 || string(doc.BitLocker) == "null" {
		m.Incomplete = append(m.Incomplete, "bitlocker")
	} else if err := json.Unmarshal(doc.BitLocker, &bl); err != nil {
		m.Incomplete = append(m.Incomplete, "bitlocker")
	} else {
		for _, b := range bl {
			status := strings.Trim(strings.TrimSpace(string(b.ProtectionStatus)), `"`)
			if status == "1" || strings.EqualFold(status, "On") {
				bitlocked[strings.ToUpper(strings.TrimSuffix(b.MountPoint, ":"))] = true
			}
		}
	}

	byDisk := map[int]*Disk{}
	for _, d := range doc.Disks {
		disk := Disk{
			Name:       fmt.Sprintf(`\\.\PHYSICALDRIVE%d`, d.Number),
			Model:      d.FriendlyName,
			Serial:     strings.TrimSpace(d.SerialNumber),
			SizeBytes:  d.Size,
			SectorSize: d.LogicalSectorSize,
			TableType:  tableType(d.PartitionStyle),
			Removable:  removableBus(d.BusType),
			IsSystem:   d.IsBoot,
			Partitions: []Partition{},
		}
		if disk.SectorSize == 0 {
			disk.SectorSize = 512
		}
		if strings.EqualFold(d.PartitionStyle, "RAW") {
			disk.TableType = "none"
		}
		m.Disks = append(m.Disks, disk)
		byDisk[d.Number] = &m.Disks[len(m.Disks)-1]
	}

	for _, p := range doc.Partitions {
		disk, ok := byDisk[p.DiskNumber]
		if !ok {
			continue
		}
		part := Partition{
			Number:     p.PartitionNumber,
			Name:       fmt.Sprintf(`\\.\PHYSICALDRIVE%d#%d`, p.DiskNumber, p.PartitionNumber),
			TypeGUID:   normalizeGUID(p.GptType),
			PartUUID:   normalizeGUID(p.Guid),
			StartBytes: p.Offset,
			SizeBytes:  p.Size,
			Encryption: EncryptionNone,
			Role:       RoleUnknown,
		}
		letter := driveLetter(p.DriveLetter)
		if letter != "" {
			part.MountPoint = letter + `:\`
		}
		if p.IsActive {
			part.Flags = append(part.Flags, "active")
		}
		if p.IsHidden {
			part.Flags = append(part.Flags, "hidden")
		}
		var vol *winVolume
		if letter != "" {
			if v, ok := volByLetter[letter]; ok {
				vol = &v
			}
		}
		if vol == nil {
			for _, ap := range p.AccessPaths {
				if v, ok := volByPath[strings.ToLower(ap)]; ok {
					vol = &v
					break
				}
			}
		}
		if vol != nil {
			part.Filesystem = strings.ToLower(vol.FileSystem)
			part.Label = vol.FileSystemLabel
			part.FSUUID = strings.Trim(strings.TrimPrefix(strings.ToLower(vol.UniqueId), `\\?\volume{`), `}\`)
			if vol.Size > 0 && vol.Size >= vol.SizeRemaining {
				part.UsedBytes = vol.Size - vol.SizeRemaining
			}
		}
		if letter != "" && bitlocked[letter] {
			part.Encryption = EncryptionBitLocker
		}
		switch {
		case part.TypeGUID == GUIDEFISystem, strings.EqualFold(p.Type, "System") && disk.TableType == "gpt":
			part.Role = RoleEFI
		case part.TypeGUID == GUIDMicrosoftMSR, strings.EqualFold(p.Type, "Reserved"):
			part.Role = RoleMSR
		case part.TypeGUID == GUIDWindowsRecovery, strings.EqualFold(p.Type, "Recovery"):
			part.Role = RoleRecovery
		case p.IsBoot, part.MountPoint == `C:\`:
			part.Role = RoleRoot
			disk.IsSystem = true
		case part.Filesystem != "" || part.MountPoint != "":
			part.Role = RoleData
		}
		disk.Partitions = append(disk.Partitions, part)
	}
	return m, nil
}
```

- [ ] **Step 6: Implement `collect_windows.go` and `collect_other.go`**

```go
//go:build windows

package layout

import (
	"context"
	"fmt"
	"os/exec"
	"time"
)

var runCommand = func(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).Output()
}

const collectTimeout = 60 * time.Second

// Collect captures the Windows disk layout through one PowerShell invocation.
func Collect(ctx context.Context) (*Manifest, error) {
	ctx, cancel := context.WithTimeout(ctx, collectTimeout)
	defer cancel()
	out, err := runCommand(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", windowsLayoutScript)
	if err != nil {
		return nil, fmt.Errorf("powershell disk layout: %w", err)
	}
	m, err := parseWindowsLayout(out)
	if err != nil {
		return nil, err
	}
	m.CollectedAt = time.Now().UTC()
	return m, nil
}
```

```go
//go:build !linux && !windows

package layout

import "context"

// Collect is unsupported on this platform (macOS bare-metal is out of scope,
// spec §12).
func Collect(_ context.Context) (*Manifest, error) {
	return nil, ErrUnsupportedPlatform
}
```

- [ ] **Step 7: Run tests on the host and cross-compile every GOOS**

Run:
```bash
cd agent && go test -race ./internal/backup/layout/ 2>&1 | tail -3
GOOS=linux go vet ./internal/backup/layout/ && GOOS=windows go vet ./internal/backup/layout/ && GOOS=darwin go vet ./internal/backup/layout/ && echo VET-OK
```
Expected: `ok` and `VET-OK`. On macOS the linux-tagged test file is not compiled; CI's `test-agent` job runs on linux and executes it. If `golangci-lint` flags `runCommand` unused on darwin, it is not — darwin has no seam; if it flags `collectTimeout`, move that constant into each tagged file (it already is).

- [ ] **Step 8: Commit**

```bash
git add agent/internal/backup/layout/
git commit -m "feat(backup): layout collectors for Linux (lsblk/efibootmgr) and Windows (Get-Disk/Get-Partition/Get-Volume) (W01)"
```

---

### Task 5: Backup run — collect, assess, publish `layout.json`, carry in the result

**Files:**
- Modify: `agent/internal/backup/backup.go` (`:70` seams, `:180-212` `BackupJob`, `:645-665` collection block, `:877` system-image-only publish path, `:989-996` `snapshotOpts`)
- Modify: `agent/internal/backup/snapshot.go` (`:73-75` constants, `:397-400` options, `:426` add `withLayout`, `:1023-1035` publish block, new `publishLayoutManifest` next to `publishSystemState`)
- Test: `agent/internal/backup/backup_test.go`, `agent/internal/backup/snapshot_test.go`

**Interfaces:**
- Consumes: `layout.Collect`, `layout.Assess`, `layout.Manifest`, `layout.Restorability` (Tasks 1, 4).
- Produces: `BackupJob.LayoutManifest *layout.Manifest` (`json:"layoutManifest,omitempty"`), `BackupJob.BareMetal *layout.Restorability` (`json:"bareMetal,omitempty"`), object `snapshots/<id>/layout.json`, `withLayout(manifest)` option, `publishLayoutManifest(ctx, provider, snapshotID, manifest) error`. Task 6 reads `layoutManifest`/`bareMetal` from the result JSON.

- [ ] **Step 1: Write the failing run tests** (append to `backup_test.go`)

```go
func stubCollectLayout(t *testing.T, fn func(context.Context) (*layout.Manifest, error)) {
	t.Helper()
	orig := collectLayout
	t.Cleanup(func() { collectLayout = orig })
	collectLayout = fn
}

func restorableLayout() *layout.Manifest {
	return &layout.Manifest{
		SchemaVersion: layout.SchemaVersion, Platform: "linux", BootMode: layout.BootModeUEFI,
		Disks: []layout.Disk{{Name: "/dev/sda", TableType: "gpt", SizeBytes: 64 << 30, IsSystem: true, Partitions: []layout.Partition{
			{Number: 1, Name: "/dev/sda1", TypeGUID: layout.GUIDEFISystem, Filesystem: "vfat", MountPoint: "/boot/efi", Role: layout.RoleEFI, Encryption: layout.EncryptionNone},
			{Number: 2, Name: "/dev/sda2", Filesystem: "ext4", MountPoint: "/", Role: layout.RoleRoot, Encryption: layout.EncryptionNone},
		}}},
	}
}

func TestRunBackup_Layout_PublishedBeforeOrdinaryManifestAndCarriedOnJob(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "single.txt", "single file backup")
	stagingDir := t.TempDir()
	if err := os.WriteFile(pathpkg.Join(stagingDir, "services.txt"), []byte("svc"), 0o600); err != nil {
		t.Fatal(err)
	}
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return &systemstate.SystemStateManifest{Platform: "test", Artifacts: []systemstate.Artifact{{Name: "services", Category: "services", Path: "services.txt", SizeBytes: 3, Checksum: "348c658682ae8701d3e9d21f191872491cf15e6acbb1681770b1cb787c1cf7ff"}}}, stagingDir, nil
	})
	stubCollectLayout(t, func(context.Context) (*layout.Manifest, error) { return restorableLayout(), nil })

	provider := newMockProvider()
	mgr := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{file1}, SystemStateEnabled: true})
	job, err := mgr.RunBackup()
	if err != nil {
		t.Fatalf("RunBackup failed: %v", err)
	}
	if job.LayoutManifest == nil || job.BareMetal == nil || !job.BareMetal.Restorable {
		t.Fatalf("job layout=%v bareMetal=%+v", job.LayoutManifest != nil, job.BareMetal)
	}
	if job.Warning != "" {
		t.Errorf("unexpected warning %q", job.Warning)
	}
	layoutKey := path.Join("snapshots", job.Snapshot.ID, "layout.json")
	stateKey := path.Join("snapshots", job.Snapshot.ID, "system-state", "manifest.json")
	ordinaryKey := path.Join("snapshots", job.Snapshot.ID, "manifest.json")
	idx := func(k string) int {
		for i, c := range provider.uploadCalls {
			if c.remotePath == k {
				return i
			}
		}
		return -1
	}
	li, si, oi := idx(layoutKey), idx(stateKey), idx(ordinaryKey)
	if li == -1 || si == -1 || oi == -1 || !(si < li && li < oi) {
		t.Fatalf("publish order state=%d layout=%d ordinary=%d (want state < layout < ordinary); keys=%v", si, li, oi, providerKeys(provider))
	}
	var stored layout.Manifest
	if err := json.Unmarshal(provider.files[layoutKey], &stored); err != nil || stored.SchemaVersion != layout.SchemaVersion || len(stored.Disks) != 1 {
		t.Fatalf("stored layout.json = %s err=%v", provider.files[layoutKey], err)
	}
	// The result JSON the helper ships to the server carries both fields.
	data, _ := json.Marshal(job)
	var wire map[string]json.RawMessage
	_ = json.Unmarshal(data, &wire)
	if _, ok := wire["layoutManifest"]; !ok {
		t.Error("layoutManifest missing from job JSON")
	}
	if _, ok := wire["bareMetal"]; !ok {
		t.Error("bareMetal missing from job JSON")
	}
}

func TestRunBackup_Layout_NotRestorableAppendsWarning(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "a.txt", "x")
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return &systemstate.SystemStateManifest{Platform: "test"}, t.TempDir(), nil
	})
	stubCollectLayout(t, func(context.Context) (*layout.Manifest, error) {
		m := restorableLayout()
		m.BootMode = layout.BootModeBIOS
		return m, nil
	})
	provider := newMockProvider()
	job, err := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{file1}, SystemStateEnabled: true}).RunBackup()
	if err != nil {
		t.Fatal(err)
	}
	if job.BareMetal == nil || job.BareMetal.Restorable || job.BareMetal.Reasons[0] != layout.ReasonBIOSBoot {
		t.Fatalf("bareMetal = %+v", job.BareMetal)
	}
	if !strings.Contains(job.Warning, "not bare-metal restorable: "+layout.ReasonBIOSBoot) {
		t.Errorf("warning = %q", job.Warning)
	}
	if job.Status != jobStatusCompleted {
		t.Errorf("status = %q", job.Status)
	}
}

func TestRunBackup_Layout_CollectFailureIsWarningNotFailure(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "a.txt", "x")
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		return &systemstate.SystemStateManifest{Platform: "test"}, t.TempDir(), nil
	})
	stubCollectLayout(t, func(context.Context) (*layout.Manifest, error) { return nil, errors.New("lsblk: exit 1") })
	provider := newMockProvider()
	job, err := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{file1}, SystemStateEnabled: true}).RunBackup()
	if err != nil {
		t.Fatal(err)
	}
	if job.LayoutManifest != nil || job.BareMetal == nil || job.BareMetal.Restorable || !strings.Contains(job.BareMetal.Reasons[0], "lsblk: exit 1") {
		t.Fatalf("job layout=%v bareMetal=%+v", job.LayoutManifest, job.BareMetal)
	}
	if !strings.Contains(job.Warning, "disk layout was not captured: lsblk: exit 1") {
		t.Errorf("warning = %q", job.Warning)
	}
	for _, c := range provider.uploadCalls {
		if strings.HasSuffix(c.remotePath, "/layout.json") {
			t.Fatalf("layout.json must not be uploaded when collection failed: %v", providerKeys(provider))
		}
	}
}

func TestRunBackup_FileOnlyRunNeverCollectsLayout(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "a.txt", "x")
	called := false
	stubCollectLayout(t, func(context.Context) (*layout.Manifest, error) { called = true; return restorableLayout(), nil })
	provider := newMockProvider()
	job, err := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{file1}}).RunBackup()
	if err != nil {
		t.Fatal(err)
	}
	if called || job.LayoutManifest != nil || job.BareMetal != nil {
		t.Fatalf("file-only run touched layout: called=%v job=%+v", called, job)
	}
}
```

Add imports to `backup_test.go` as needed: `"context"`, `"encoding/json"`, `"errors"`, `"strings"`, `"github.com/breeze-rmm/agent/internal/backup/layout"` (check which already exist at the top of the file).

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go test ./internal/backup/ -run 'TestRunBackup_Layout|TestRunBackup_FileOnlyRunNeverCollectsLayout' 2>&1 | head -5`
Expected: build failure — `undefined: collectLayout`, `job.LayoutManifest undefined`.

- [ ] **Step 3: Implement in `backup.go`**

Import `"github.com/breeze-rmm/agent/internal/backup/layout"`. After the `collectSystemState` seam at `:70` add:

```go
// collectLayout is the seam over layout.Collect (disk layout for bare-metal
// rebuilds, spec §5.2). Same rationale as collectSystemState above.
var collectLayout = layout.Collect
```

Add to `BackupJob` right after `SystemStateManifest` (`:208`):

```go
	// LayoutManifest is the disk layout captured for bare-metal rebuilds
	// (snapshots/<id>/layout.json). nil on file-only runs and when capture
	// failed. BareMetal is the guard verdict for that layout; on capture
	// failure it is non-nil with Restorable=false and the error as the reason,
	// so the server never mistakes "unknown" for "restorable".
	LayoutManifest *layout.Manifest      `json:"layoutManifest,omitempty"`
	BareMetal      *layout.Restorability `json:"bareMetal,omitempty"`
```

Inside `if m.config.SystemStateEnabled {` (`:645`), after the whole system-state `if ssErr != nil {...} else {...}` block and still inside the outer `if`, add:

```go
		// Disk layout — independent of system-state success: a partial state
		// capture with a good layout is still worth knowing about, and vice
		// versa. Never fatal: the run is still a valid file backup.
		if lm, lerr := collectLayout(runCtx); lerr != nil {
			log.Warn("disk layout capture failed", "error", lerr.Error())
			appendWarning(job, "disk layout was not captured: "+lerr.Error())
			job.BareMetal = &layout.Restorability{Restorable: false, Reasons: []string{"disk layout was not captured: " + lerr.Error()}}
		} else {
			job.LayoutManifest = lm
			verdict := layout.Assess(lm)
			job.BareMetal = &verdict
			if !verdict.Restorable {
				appendWarning(job, "not bare-metal restorable: "+strings.Join(verdict.Reasons, "; "))
			}
		}
```

At `:989-996`, after the `withSystemState` append, add:

```go
	if m.config.SystemStateEnabled && job.LayoutManifest != nil {
		snapshotOpts = append(snapshotOpts, withLayout(job.LayoutManifest))
	}
```

At `:877` (system-image-only path), after the `publishSystemState` call succeeds and before `publishSnapshotManifest`:

```go
			if job.LayoutManifest != nil {
				if pubErr := publishLayoutManifest(runCtx, uploadProvider, snapshot.ID, job.LayoutManifest); pubErr != nil {
					job.Status = jobStatusFailed
					job.CompletedAt = time.Now().UTC()
					job.Error = fmt.Errorf("layout manifest publish failed: %w", pubErr)
					return job, job.Error
				}
			}
```

- [ ] **Step 4: Implement in `snapshot.go`**

Constants (`:73-75`): add `layoutManifestKey = "layout.json" // mirrored by apps/api backupSnapshotStorage.ts BACKUP_LAYOUT_MANIFEST_KEY`.

Options struct (`:397-400`): add `layoutManifest *layout.Manifest`. Next to `withSystemState` (`:426`):

```go
// withLayout publishes the disk-layout manifest as snapshots/<id>/layout.json
// after system state and BEFORE the ordinary manifest (same GC-ordering
// argument as withSystemState). No-op when manifest is nil.
func withLayout(manifest *layout.Manifest) createSnapshotOption {
	return func(o *createSnapshotOptions) { o.layoutManifest = manifest }
}
```

In `createSnapshotWithProgress`, immediately after the system-state publish block (`:1023-1035`) and before `publishSnapshotManifest` (`:1037`):

```go
	if options.layoutManifest != nil {
		if err := publishLayoutManifest(ctx, provider, snapshot.ID, options.layoutManifest); err != nil {
			if errors.Is(err, errBackupStopped) {
				return abortStopped()
			}
			return snapshot, fmt.Errorf("layout manifest publish failed: %w", err)
		}
	}
```

Next to `publishSystemState` (`:1195`):

```go
// publishLayoutManifest uploads manifest as snapshots/<snapshotID>/layout.json.
func publishLayoutManifest(ctx context.Context, provider providers.BackupProvider, snapshotID string, manifest *layout.Manifest) error {
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encode layout manifest: %w", err)
	}
	tmp, err := os.CreateTemp("", "breeze-layout-*.json")
	if err != nil {
		return fmt.Errorf("stage layout manifest: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("stage layout manifest: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("stage layout manifest: %w", err)
	}
	key := path.Join(snapshotRootDir, snapshotID, layoutManifestKey)
	attemptCtx, cancel := context.WithTimeout(ctx, uploadDeadline(int64(len(data))))
	defer cancel()
	if err := uploadSnapshotFile(attemptCtx, provider, tmpPath, key); err != nil {
		if errors.Is(err, errBackupStopped) {
			return err
		}
		return fmt.Errorf("upload %s: %w", key, err)
	}
	return nil
}
```

- [ ] **Step 5: Run the backup package tests**

Run: `cd agent && go test -race ./internal/backup/ 2>&1 | tail -5`
Expected: `ok`. All pre-existing system-state order tests still pass (layout sits between state manifest and ordinary manifest).

- [ ] **Step 6: Cross-compile the helper and lint**

Run:
```bash
cd agent && GOOS=windows go build ./cmd/breeze-backup/ && GOOS=darwin go build ./cmd/breeze-backup/ && GOOS=linux go build ./cmd/breeze-backup/ && echo BUILD-OK
gofmt -l internal/backup/ && go vet ./internal/backup/...
```
Expected: `BUILD-OK`, no gofmt output, vet clean.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/backup/backup.go agent/internal/backup/snapshot.go agent/internal/backup/backup_test.go
git commit -m "feat(backup): capture disk layout on system_image runs, publish snapshots/<id>/layout.json, carry verdict on the job (W01)"
```

---

### Task 6: API — columns, migration, export policy, result + queue schemas, persistence

**Files:**
- Create: `apps/api/migrations/2026-10-15-160010-backup-snapshots-layout-manifest.sql`
- Modify: `apps/api/src/db/schema/backup.ts:323-324`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:124`
- Modify: `apps/api/src/routes/backup/resultSchemas.ts` (after `:49` and `:90`)
- Modify: `apps/api/src/jobs/queueSchemas.ts:57`, `apps/api/src/jobs/backupEnqueue.ts:99`
- Modify: `apps/api/src/routes/agentWs.ts:1669`
- Modify: `apps/api/src/services/backupResultPersistence.ts:1134-1160`
- Test: `apps/api/src/routes/backup/resultSchemas.test.ts`, `apps/api/src/jobs/queueSchemas.test.ts`, `apps/api/src/services/backupResultPersistence.test.ts`

**Interfaces:**
- Consumes: result JSON fields `layoutManifest` (object) and `bareMetal` (`{restorable, reasons}`) from Task 5.
- Produces: `backupSnapshots.layoutManifest`, `.bareMetalRestorable`, `.bareMetalReasons` (Drizzle), the same three DB columns, and queue payload fields of the same names. Task 7 reads the columns.

- [ ] **Step 1: Write the failing schema tests**

`resultSchemas.test.ts` — append inside the existing top-level `describe`:

```ts
  it('parses layoutManifest (open) and bareMetal (closed) result fields', () => {
    const parsed = backupCommandResultSchema.parse({
      snapshotId: 'snap-1',
      backupType: 'system_image',
      layoutManifest: { schemaVersion: 1, platform: 'linux', bootMode: 'uefi', disks: [{ name: '/dev/sda' }], futureField: true },
      bareMetal: { restorable: false, reasons: ['LVM volumes are not supported'] },
    });
    expect(parsed.layoutManifest?.schemaVersion).toBe(1);
    expect((parsed.layoutManifest as Record<string, unknown>).futureField).toBe(true);
    expect(parsed.bareMetal).toEqual({ restorable: false, reasons: ['LVM volumes are not supported'] });
  });

  it('rejects a bareMetal verdict without the restorable flag', () => {
    expect(() => backupCommandResultSchema.parse({ snapshotId: 's', bareMetal: { reasons: [] } })).toThrow();
  });
```

`queueSchemas.test.ts` — append inside `describe('backupProcessResultSchema — system_image manifest passthrough')`:

```ts
  it('accepts layoutManifest + bareMetal (strict schema must declare them)', () => {
    const result = backupProcessResultSchema.parse({
      status: 'completed',
      snapshotId: 'snap-1',
      layoutManifest: { schemaVersion: 1, platform: 'linux', disks: [] },
      bareMetal: { restorable: true, reasons: [] },
    });
    expect(result.bareMetal).toEqual({ restorable: true, reasons: [] });
    expect((result.layoutManifest as { platform: string }).platform).toBe('linux');
  });
```

`backupResultPersistence.test.ts` — add next to the test at `:548` (same mock setup lines `:520-528` copied verbatim; only the `result` and assertion differ):

```ts
  it('persists layoutManifest and the bare-metal verdict on the snapshot row', async () => {
    vi.mocked(db.update)
      .mockReturnValueOnce(chainMock([{ id: 'job-1', orgId: 'org-1', configId: 'config-1', backupType: null, backupMode: 'system_image' }]) as any)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([]) as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([{ featureLinkId: 'feature-1', policyId: null, deviceId: 'device-1' }]) as any);
    vi.mocked(db.insert).mockReturnValueOnce(chainMock([{ id: 'snapshot-db-1', jobId: 'job-1', snapshotId: 'provider-snap-1' }]) as any);
    vi.mocked(applyGfsTagsToSnapshot).mockResolvedValue({ daily: true });
    vi.mocked(resolveGfsConfigForJob).mockResolvedValue(null);
    vi.mocked(computeExpiresAt).mockReturnValue(null);

    const layoutManifest = { schemaVersion: 1, platform: 'linux', bootMode: 'uefi', disks: [] };
    await applyBackupCommandResultToJob({
      jobId: 'job-1', orgId: 'org-1', deviceId: 'device-1', resultStatus: 'completed',
      result: { snapshotId: 'provider-snap-1', filesBackedUp: 1, layoutManifest, bareMetal: { restorable: false, reasons: ['boot mode is BIOS/MBR; only UEFI with GPT is supported'] } } as any,
    });
    const insertValues = vi.mocked(db.insert).mock.results[0]?.value?.values;
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      layoutManifest,
      bareMetalRestorable: false,
      bareMetalReasons: ['boot mode is BIOS/MBR; only UEFI with GPT is supported'],
    }));
  });

  it('leaves the bare-metal verdict NULL (unknown) when the result carries none', async () => {
    vi.mocked(db.update)
      .mockReturnValueOnce(chainMock([{ id: 'job-1', orgId: 'org-1', configId: 'config-1', backupType: null, backupMode: 'file' }]) as any)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([]) as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([{ featureLinkId: 'feature-1', policyId: null, deviceId: 'device-1' }]) as any);
    vi.mocked(db.insert).mockReturnValueOnce(chainMock([{ id: 'snapshot-db-1', jobId: 'job-1', snapshotId: 'provider-snap-1' }]) as any);
    vi.mocked(applyGfsTagsToSnapshot).mockResolvedValue({ daily: true });
    vi.mocked(resolveGfsConfigForJob).mockResolvedValue(null);
    vi.mocked(computeExpiresAt).mockReturnValue(null);

    await applyBackupCommandResultToJob({ jobId: 'job-1', orgId: 'org-1', deviceId: 'device-1', resultStatus: 'completed', result: { snapshotId: 'provider-snap-1', filesBackedUp: 1 } as any });
    const insertValues = vi.mocked(db.insert).mock.results[0]?.value?.values;
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ layoutManifest: null, bareMetalRestorable: null, bareMetalReasons: null }));
  });
```

- [ ] **Step 2: Run to verify failure**

Run:
```bash
cd apps/api && npx vitest run src/routes/backup/resultSchemas.test.ts src/jobs/queueSchemas.test.ts src/services/backupResultPersistence.test.ts 2>&1 | tail -15
```
Expected: the three new tests fail (`bareMetal` unknown key stripped / strict-schema `unrecognized_keys` / `objectContaining` mismatch).

- [ ] **Step 3: Migration**

```sql
-- Bare-metal recovery W01: disk-layout manifest + restorability verdict per
-- snapshot. Spec: docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md §5.2-5.3.
-- bare_metal_restorable NULL = never assessed (file-only runs, pre-W01 agents).
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "layout_manifest" jsonb;
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "bare_metal_restorable" boolean;
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "bare_metal_reasons" text[];
```

Run `ls apps/api/migrations/*.sql | sort | tail -1` first; if anything sorts after `2026-10-15-160010`, rename to sort last and update this plan's Global Constraints line.

- [ ] **Step 4: Drizzle schema + export policy**

`backup.ts` after `:324`:

```ts
  // Bare-metal recovery (W01): disk layout captured at run time and the
  // guard verdict. NULL verdict = not assessed (file-only run / old agent).
  layoutManifest: jsonb('layout_manifest'),
  bareMetalRestorable: boolean('bare_metal_restorable'),
  bareMetalReasons: text('bare_metal_reasons').array(),
```

`tenantExportPolicyRegistry.ts:124`: append `"bare_metal_restorable","bare_metal_reasons"` to the `included` array and `"layout_manifest"` to `excludedOpen`.

- [ ] **Step 5: Result/queue schemas, forward, persistence**

`resultSchemas.ts` after `backupSystemStateManifestResultSchema` (`:49`):

```ts
// Disk layout for bare-metal rebuilds (W01). Open for the same F13 reason as
// the system-state manifest: a newer agent must never fail the whole result.
export const backupLayoutManifestResultSchema = z
  .object({
    schemaVersion: z.number().int().optional(),
    platform: z.string().optional(),
    bootMode: z.string().optional(),
    disks: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

export const backupBareMetalResultSchema = z.object({
  restorable: z.boolean(),
  reasons: z.array(z.string().max(1000)).max(64),
});
```

and after `systemStateManifest` (`:90`):

```ts
  layoutManifest: backupLayoutManifestResultSchema.optional(),
  bareMetal: backupBareMetalResultSchema.optional(),
```

`queueSchemas.ts` after `:57`:

```ts
  layoutManifest: z.record(z.string(), z.unknown()).nullish(),
  bareMetal: z.object({ restorable: z.boolean(), reasons: z.array(z.string()) }).nullish(),
```

`backupEnqueue.ts` after `:99`:

```ts
  layoutManifest?: Record<string, unknown> | null;
  bareMetal?: { restorable: boolean; reasons: string[] } | null;
```

`agentWs.ts` after `:1669`:

```ts
            layoutManifest: backupData?.layoutManifest,
            bareMetal: backupData?.bareMetal,
```

`backupResultPersistence.ts` after `:1135`:

```ts
  const layoutManifest = result.layoutManifest ?? null;
  const bareMetalRestorable = result.bareMetal?.restorable ?? null;
  const bareMetalReasons = result.bareMetal?.reasons ?? null;
```

and inside `snapshotValues` after `hardwareProfile,`:

```ts
    layoutManifest,
    bareMetalRestorable,
    bareMetalReasons,
```

If `result`'s TypeScript type in this function is the enqueue payload type, the Step-5 `backupEnqueue.ts` addition covers it; if it is a separate local type, add the same two optional fields there.

- [ ] **Step 6: Run tests, typecheck, drift**

```bash
cd apps/api && npx vitest run src/routes/backup/resultSchemas.test.ts src/jobs/queueSchemas.test.ts src/services/backupResultPersistence.test.ts 2>&1 | tail -8
npx tsc --noEmit -p . 2>&1 | tail -5
cd ../.. && export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:migrate 2>&1 | tail -3 && pnpm db:check-drift 2>&1 | tail -3
```
Expected: tests pass, tsc clean, migrate applies `160010`, no drift.

- [ ] **Step 7: Run the migration-ordering unit test and the export-policy suites**

```bash
cd apps/api && npx vitest run src/db/autoMigrate.test.ts 2>&1 | tail -3
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts 2>&1 | tail -6
```
Expected: pass. (Both integration suites need the local Postgres; they are what fails in CI's Integration Tests job if the export-policy row was missed.)

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-10-15-160010-backup-snapshots-layout-manifest.sql apps/api/src/db/schema/backup.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/routes/backup/resultSchemas.ts apps/api/src/routes/backup/resultSchemas.test.ts apps/api/src/jobs/queueSchemas.ts apps/api/src/jobs/queueSchemas.test.ts apps/api/src/jobs/backupEnqueue.ts apps/api/src/routes/agentWs.ts apps/api/src/services/backupResultPersistence.ts apps/api/src/services/backupResultPersistence.test.ts
git commit -m "feat(api): persist layout manifest + bare-metal verdict on backup_snapshots; forward through result queue (W01)"
```

---

### Task 7: API — storage key helper, GC mark-live, snapshot response

**Files:**
- Modify: `apps/api/src/services/backupSnapshotStorage.ts:170-179`
- Modify: `apps/api/src/jobs/backupRetention.ts:941` (insert before)
- Modify: `apps/api/src/routes/backup/snapshots.ts:664-690` (`toSnapshotResponse`)
- Test: `apps/api/src/jobs/backupRetention.test.ts`, `apps/api/src/services/backupSnapshotStorage.test.ts` (create if absent), `apps/api/src/routes/backup/snapshots.test.ts`

**Interfaces:**
- Produces: `BACKUP_LAYOUT_MANIFEST_KEY`, `backupLayoutManifestKey(snapshotId): string`; snapshot API response fields `bareMetalRestorable: boolean | null`, `bareMetalReasons: string[]`. Task 8 (web) and W02 (engine download) consume them.

- [ ] **Step 1: Write the failing tests**

Key helper (`backupSnapshotStorage.test.ts`; create the file if it does not exist):

```ts
import { describe, expect, it } from 'vitest';
import { backupLayoutManifestKey, backupSystemStateManifestKey } from './backupSnapshotStorage';

describe('backupLayoutManifestKey', () => {
  it('mirrors the agent constant: snapshots/<id>/layout.json', () => {
    expect(backupLayoutManifestKey('snap-1')).toBe('snapshots/snap-1/layout.json');
    expect(backupSystemStateManifestKey('snap-1')).toBe('snapshots/snap-1/system-state/manifest.json');
  });
});
```

GC (`backupRetention.test.ts`, inside `describe('storage identity grouping')` after the fixture at `:610-640`, using the same `selectQueue`/`fetchBackupObjectTextMock`/`listBackupObjectsUnderPrefixMock`/`deleteBackupObjectMock` helpers that test uses):

```ts
    it('marks snapshots/<id>/layout.json live without fetching it, so the sweep never deletes a retained layout manifest', async () => {
      const config = { id: 'cfg-a', provider: 's3', providerConfig: { bucket: 'b', region: 'us-east-1' } };
      selectQueue.push([]); // unattributedRows
      selectQueue.push([config]); // destinations
      selectQueue.push([{ snapshotId: 'A' }]); // retained
      const fetched: string[] = [];
      fetchBackupObjectTextMock.mockImplementation(async (input: { key: string }) => {
        fetched.push(input.key);
        if (input.key === 'snapshots/A/manifest.json') return manifestJson([]);
        if (input.key.endsWith('/system-state/manifest.json')) throw notFoundError();
        throw new Error(`unexpected manifest fetch: ${input.key}`);
      });
      const old = new Date(Date.now() - 10 * DAY_MS);
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/A/manifest.json', lastModified: old },
        { key: 'snapshots/A/layout.json', lastModified: old },
        { key: 'snapshots/ORPHAN/layout.json', lastModified: old },
      ]);

      const result = await sweepUnreferencedBackupObjects();

      expect(fetched).not.toContain('snapshots/A/layout.json');
      expect(deleteBackupObjectMock).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'snapshots/A/layout.json' }));
      expect(deleteBackupObjectMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'snapshots/ORPHAN/layout.json' }));
      expect(result.deleted).toBe(1);
    });
```

If the sibling tests in that `describe` reference the delete mock under a different name, use that name; the assertions are the contract.

Snapshot response (`snapshots.test.ts`): find the existing list-route test that asserts `backupType` in the response and add to its expectation:

```ts
      bareMetalRestorable: false,
      bareMetalReasons: ['LVM volumes are not supported'],
```

with the mocked row carrying `bareMetalRestorable: false, bareMetalReasons: ['LVM volumes are not supported']`; and a second row with both columns `null` expecting `bareMetalRestorable: null, bareMetalReasons: []`.

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/api && npx vitest run src/services/backupSnapshotStorage.test.ts src/jobs/backupRetention.test.ts src/routes/backup/snapshots.test.ts 2>&1 | tail -12
```
Expected: the new tests fail (`backupLayoutManifestKey is not a function`; `snapshots/A/layout.json` deleted; response missing fields).

- [ ] **Step 3: Implement**

`backupSnapshotStorage.ts` after `backupSystemStateArtifactKey`:

```ts
// Mirrors agent/internal/backup/snapshot.go layoutManifestKey exactly
// (bare-metal recovery W01): the disk-layout manifest lives beside the
// ordinary manifest, never inside manifest.files[].
export const BACKUP_LAYOUT_MANIFEST_KEY = 'layout.json';

export function backupLayoutManifestKey(snapshotId: string): string {
  return `${BACKUP_SNAPSHOT_ROOT_DIR}/${snapshotId}/${BACKUP_LAYOUT_MANIFEST_KEY}`;
}
```

`backupRetention.ts` — import `backupLayoutManifestKey`; immediately before `const stateManifestKey = backupSystemStateManifestKey(snapshotId);` (`:941`) add:

```ts
    // layout.json (W01) is a single object with nothing to enumerate, so it is
    // marked live unconditionally — marking a key that does not exist is
    // harmless, fetching it would only add a round-trip and a failure mode.
    live.add(backupLayoutManifestKey(snapshotId));
```

`snapshots.ts` `toSnapshotResponse` — add after `backupType`:

```ts
    bareMetalRestorable: row.bareMetalRestorable ?? null,
    bareMetalReasons: row.bareMetalReasons ?? [],
```

- [ ] **Step 4: Run tests + typecheck**

```bash
cd apps/api && npx vitest run src/services/backupSnapshotStorage.test.ts src/jobs/backupRetention.test.ts src/routes/backup/snapshots.test.ts 2>&1 | tail -6 && npx tsc --noEmit -p . 2>&1 | tail -3
```
Expected: pass, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/backupSnapshotStorage.ts apps/api/src/services/backupSnapshotStorage.test.ts apps/api/src/jobs/backupRetention.ts apps/api/src/jobs/backupRetention.test.ts apps/api/src/routes/backup/snapshots.ts apps/api/src/routes/backup/snapshots.test.ts
git commit -m "feat(api): keep snapshots/<id>/layout.json live in GC and expose the bare-metal verdict on snapshots (W01)"
```

---

### Task 8: Web — whole-machine templates and snapshot badge

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/backupTabPresets.ts`
- Modify: `apps/web/src/components/backup/BackupProfilesTab.tsx:3-14` (icon import) and `:118-190` (`createTemplates`)
- Modify: `apps/web/src/components/backup/SnapshotBrowser.tsx:51-62`, `:478-487`
- Modify: `apps/web/src/locales/en/backup.json` (+ the same keys in `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR` `backup.json` with the English strings)
- Test: `apps/web/src/components/configurationPolicies/featureTabs/backupTabPresets.test.ts` (create), `apps/web/src/components/backup/SnapshotBrowser.test.tsx`

**Interfaces:**
- Consumes: snapshot response fields from Task 7; root-anchored excludes from Task 2.
- Produces: `createWholeMachinePresets(): WholeMachinePreset[]`, `LINUX_WHOLE_MACHINE_EXCLUDES`, `WINDOWS_WHOLE_MACHINE_EXCLUDES`.

- [ ] **Step 1: Write the failing preset test**

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/i18n', () => ({ i18n: { t: (k: string) => k } }));

import { createWholeMachinePresets, LINUX_WHOLE_MACHINE_EXCLUDES, WINDOWS_WHOLE_MACHINE_EXCLUDES } from './backupTabPresets';

describe('createWholeMachinePresets', () => {
  it('backs up the whole root with root-anchored excludes for virtual and volatile trees', () => {
    const presets = createWholeMachinePresets();
    const linux = presets.find((p) => p.id === 'whole-machine-linux')!;
    const windows = presets.find((p) => p.id === 'whole-machine-windows')!;
    expect(linux.paths).toEqual(['/']);
    expect(windows.paths).toEqual(['C:\\']);
    expect(linux.excludes).toBe(LINUX_WHOLE_MACHINE_EXCLUDES);
    expect(windows.excludes).toBe(WINDOWS_WHOLE_MACHINE_EXCLUDES);
    // Every Linux exclude is root-anchored so "/dev/**" cannot swallow ~/dev.
    for (const e of LINUX_WHOLE_MACHINE_EXCLUDES) expect(e.startsWith('/') || e.startsWith('**/')).toBe(true);
    for (const must of ['/proc/**', '/sys/**', '/dev/**', '/run/**', '/tmp/**', '/mnt/**', '/media/**']) expect(LINUX_WHOLE_MACHINE_EXCLUDES).toContain(must);
    for (const must of ['/pagefile.sys', '/hiberfil.sys', '/swapfile.sys', '/$Recycle.Bin/**', '/System Volume Information/**']) expect(WINDOWS_WHOLE_MACHINE_EXCLUDES).toContain(must);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/backupTabPresets.test.ts 2>&1 | tail -5`
Expected: FAIL — `createWholeMachinePresets` is not exported.

- [ ] **Step 3: Implement the presets**

Append to `backupTabPresets.ts`:

```ts
// Whole-machine presets (bare-metal recovery W01, spec §5.1). Root-anchored
// excludes (leading "/") only match from the selection root — see
// agent/internal/backup/exclude.go. Pseudo/virtual filesystems, volatile
// trees, and foreign mounts are excluded; everything else on the root
// filesystem is captured so the rebuild engine can put it back.
export const LINUX_WHOLE_MACHINE_EXCLUDES: string[] = [
  "/proc/**",
  "/sys/**",
  "/dev/**",
  "/run/**",
  "/tmp/**",
  "/var/tmp/**",
  "/mnt/**",
  "/media/**",
  "/snap/**",
  "/var/cache/apt/archives/**",
  "/swapfile",
  "/swap.img",
  "**/lost+found/**",
];

export const WINDOWS_WHOLE_MACHINE_EXCLUDES: string[] = [
  "/pagefile.sys",
  "/hiberfil.sys",
  "/swapfile.sys",
  "/$Recycle.Bin/**",
  "/System Volume Information/**",
  "/Windows/Temp/**",
  "/Windows/SoftwareDistribution/Download/**",
  "**/AppData/Local/Temp/**",
];

export type WholeMachinePreset = {
  id: "whole-machine-linux" | "whole-machine-windows";
  title: string;
  summary: string;
  paths: string[];
  excludes: string[];
};

export const createWholeMachinePresets = (): WholeMachinePreset[] => [
  {
    id: "whole-machine-linux",
    title: i18n.t("backup:profiles.tmplWholeLinuxTitle"),
    summary: i18n.t("backup:profiles.tmplWholeLinuxDesc"),
    paths: ["/"],
    excludes: LINUX_WHOLE_MACHINE_EXCLUDES,
  },
  {
    id: "whole-machine-windows",
    title: i18n.t("backup:profiles.tmplWholeWindowsTitle"),
    summary: i18n.t("backup:profiles.tmplWholeWindowsDesc"),
    paths: ["C:\\"],
    excludes: WINDOWS_WHOLE_MACHINE_EXCLUDES,
  },
];
```

- [ ] **Step 4: Wire the templates into `BackupProfilesTab.tsx`**

Add `HardDrive` to the lucide import block (`:3-14`) and `createWholeMachinePresets` to the presets import (`:23`). In `createTemplates()` add, as the first two entries of the returned array:

```tsx
    ...createWholeMachinePresets().map((preset) => ({
      id: preset.id,
      icon: HardDrive,
      title: preset.title,
      description: preset.summary,
      build: (): DraftSelections => ({
        ...emptySelections(),
        file: { enabled: true, paths: [...preset.paths], excludes: [...preset.excludes] },
        system_image: { enabled: true, includeSystemState: true },
      }),
    })),
```

If `Template.id` is a string-literal union, widen it to `string` (it is only used as a React key and for the selected-template state).

- [ ] **Step 5: Write the failing snapshot-badge test**

In `SnapshotBrowser.test.tsx`, add to the `GET /backup/snapshots` fixture a second row:

```ts
            {
              id: 'snap-2',
              label: 'Whole machine',
              createdAt: '2026-04-01T00:00:00Z',
              backupType: 'system_image',
              sizeBytes: 5000000000,
              fileCount: 120000,
              location: 'snapshots/provider-snap-2',
              expiresAt: null,
              legalHold: false,
              legalHoldReason: null,
              isImmutable: false,
              immutableUntil: null,
              immutabilityEnforcement: null,
              requestedImmutabilityEnforcement: null,
              immutabilityFallbackReason: null,
              bareMetalRestorable: false,
              bareMetalReasons: ['LVM volumes are not supported'],
            },
```

and a test:

```tsx
  it('shows the bare-metal verdict badge with reasons for the selected snapshot', async () => {
    render(<SnapshotBrowser />);
    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'snap-2' } });
    const badge = await screen.findByTestId('snapshot-bare-metal-no');
    expect(badge).toHaveAttribute('title', 'LVM volumes are not supported');
    expect(screen.queryByTestId('snapshot-bare-metal-ok')).toBeNull();
  });
```

(If the select is not the only `combobox`, use `screen.getAllByRole('combobox')[0]`; the existing test at `:95+` shows how this file selects snapshots — follow it.)

- [ ] **Step 6: Implement the badge**

`SnapshotBrowser.tsx` `Snapshot` type: add

```ts
  bareMetalRestorable?: boolean | null;
  bareMetalReasons?: string[] | null;
```

After the `backupType` badge (`:480-484`):

```tsx
                {selectedSnapshot.bareMetalRestorable === true && (
                  <span data-testid="snapshot-bare-metal-ok" className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700">
                    {t('snapshotBrowser.bareMetalRestorable')}
                  </span>
                )}
                {selectedSnapshot.bareMetalRestorable === false && (
                  <span
                    data-testid="snapshot-bare-metal-no"
                    title={(selectedSnapshot.bareMetalReasons ?? []).join('; ')}
                    className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700"
                  >
                    {t('snapshotBrowser.bareMetalNotRestorable')}
                  </span>
                )}
```

- [ ] **Step 7: Locale keys**

`en/backup.json` — under `profiles`:

```json
    "tmplWholeLinuxTitle": "Whole machine (Linux)",
    "tmplWholeLinuxDesc": "Everything on the root filesystem plus system state and disk layout — bare-metal restorable.",
    "tmplWholeWindowsTitle": "Whole machine (Windows)",
    "tmplWholeWindowsDesc": "All of C:\\ under VSS plus system state and disk layout — bare-metal restorable.",
```

under `snapshotBrowser`:

```json
    "bareMetalRestorable": "Bare-metal restorable",
    "bareMetalNotRestorable": "Not bare-metal restorable",
```

Add the same six keys (English strings) to `backup.json` in every other locale directory so the locale-parity check stays green.

- [ ] **Step 8: Run web tests, typecheck, lint**

```bash
cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/backupTabPresets.test.ts src/components/backup/SnapshotBrowser.test.tsx 2>&1 | tail -8
npx tsc --noEmit -p . 2>&1 | tail -3
cd ../.. && pnpm --filter @breeze/web lint 2>&1 | tail -3
```
Expected: pass, clean, clean.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/backupTabPresets.ts apps/web/src/components/configurationPolicies/featureTabs/backupTabPresets.test.ts apps/web/src/components/backup/BackupProfilesTab.tsx apps/web/src/components/backup/SnapshotBrowser.tsx apps/web/src/components/backup/SnapshotBrowser.test.tsx apps/web/src/locales/*/backup.json
git commit -m "feat(web): whole-machine backup templates and bare-metal verdict badge on snapshots (W01)"
```

---

### Task 9: Whole-wave verification and PR

**Files:** none new.

- [ ] **Step 1: Full agent suite and cross-OS lint**

```bash
cd agent && go test -race ./... 2>&1 | grep -v "^ok" | head -20
GOOS=windows go vet ./... && GOOS=darwin go vet ./... && echo VET-ALL-OK
golangci-lint run ./internal/backup/... 2>&1 | tail -5
```
Expected: no failures; `VET-ALL-OK`; lint clean (a darwin "unused" finding means a helper landed in an untagged file that only tagged code calls — move it into the tagged file).

- [ ] **Step 2: API + web suites**

```bash
cd apps/api && npx vitest run src/routes/backup src/jobs/backupRetention.test.ts src/jobs/queueSchemas.test.ts src/services/backupResultPersistence.test.ts src/db/autoMigrate.test.ts 2>&1 | tail -6
cd ../web && npx vitest run src/components/backup src/components/configurationPolicies/featureTabs 2>&1 | tail -6
```
Expected: all green.

- [ ] **Step 3: Live proof on the Linux lab rig (evidence, not a unit test)**

With the wt-stack up and a Linux device enrolled on the lab build (campaign harness in `docs/testing/backup-assurance/`): create a profile from the "Whole machine (Linux)" template, run it manually, then:

```bash
mc ls lab/<bucket>/snapshots/<id>/ | grep layout.json
mc cat lab/<bucket>/snapshots/<id>/layout.json | jq '.bootMode, .disks[0].tableType, [.disks[0].partitions[].role]'
```
Expected: `layout.json` present; on the lab VM (UEFI+GPT) the snapshot list shows the green "Bare-metal restorable" badge; the job shows no warning. Record the snapshot id and the badge screenshot path in the PR body. If the rig is BIOS, the amber badge with the BIOS reason is the expected evidence instead.

- [ ] **Step 4: Open the PR**

Branch `feature/<parent#>-bare-metal/wave-<W01 sub-issue#>` (see feature-lifecycle). PR body: what changed per area, the migration name, the export-policy row, the lab evidence, and `Closes #<W01 sub-issue>`. Run `/review-pr` (one round), fix confirmed findings, then `gh pr merge <N> --squash` (merge queue; never `--admin`).

---

## Self-review notes (plan author)

- Spec §5.1 preset → Task 8; §5.2 manifest → Tasks 1, 3, 4, 5 (agent) + 6, 7 (server, GC); §5.3 guard → Task 1 + warnings in Task 5 + badge in Task 8. §2 decision 5 (UEFI+GPT single disk) → guard reasons in Task 1.
- Type names are consistent across tasks: `layout.Manifest/Disk/Partition/EFIEntry/Restorability`, `Assess`, `Collect`, `collectLayout`, `withLayout`, `publishLayoutManifest`, `layoutManifestKey`/`BACKUP_LAYOUT_MANIFEST_KEY`, `backupLayoutManifestKey`, DB columns `layout_manifest`/`bare_metal_restorable`/`bare_metal_reasons`, JSON fields `layoutManifest`/`bareMetal`, response fields `bareMetalRestorable`/`bareMetalReasons`.
- Known limitation carried to a follow-up issue (file it when opening the PR): the walker still crosses filesystem boundaries under `/` other than the excluded trees, so a network mount outside `/mnt`/`/media` is backed up as ordinary files. A `oneFileSystem` walk option is the right fix and belongs with W02's engine work, not here.
