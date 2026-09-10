---
tracking_issue: LanternOps/breeze#5493
---

# Wave 03 — Rebuild engine (Linux): disk + raw-image targets, offline state apply, GRUB/EFI boot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Go package `agent/internal/backup/rebuild` that, given a snapshot id, its `layout.json`, a target (block device or raw image file) and an identity mode, provisions GPT partitions, formats them with the recorded filesystems and UUIDs, restores the whole-machine file snapshot into the mounted tree, applies Linux system state offline, installs/refreshes the bootloader, writes the identity marker, validates, and returns a structured `Result` — plus a `breeze-backup rebuild` CLI. Everything is testable without root through a `System` seam; a root-gated loopback test proves provisioning for real.

**Architecture:** Seven idempotent phases (`preflight → provision → restore → boot → identity → encryption → validate`) driven by `rebuild.Run`, each recorded in a resumable state file so a re-run after a failure skips completed destructive phases (provision is never repeated unless `ForceReprovision`). All OS interaction goes through the `System` interface (`system_linux.go` real, `fakeSystem` in tests). Partition planning is pure (`PlanPartitions`). System-state apply gains an offline variant in `bmr` (`RestoreSystemStateOffline(root, …)`), and the artifact download/verification part of `bmr.applySystemState` is extracted into `bmr.DownloadSystemState` so preflight can verify checksums before any write. Restore-as-VM, DR rehearsals and the boot media (W04/W05) call `rebuild.Run` with different targets.

**Tech Stack:** Go 1.26; util-linux (`losetup`, `blockdev`, `findmnt`, `partprobe`), gdisk (`sgdisk`), `dosfstools`, `e2fsprogs`, `xfsprogs`, `grub-efi` tools, `efibootmgr`, `chroot` — all present on the W04 live media and on any Debian/RHEL host used for Restore-as-VM.

**Spec:** `docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md` §6 (engine, all seven phases), §9 (safety: no writes before preflight, wrong-disk protection, resumability), §10 (engine unit tests without hardware). Not §7 (media/console) or §8 (server) — W04.

**Depends on:** W01 (`layout` package, `snapshots/<id>/layout.json`) and W02 (symlink/owner-faithful restore). Both must be merged to main before this wave branches.

## Global Constraints

- Package path `agent/internal/backup/rebuild`; CLI subcommand `breeze-backup rebuild`.
- Targets: `Target{Kind: "disk", Path: "/dev/sdb"}` and `Target{Kind: "image", Path: "/srv/x.img", ImageSizeBytes: N}` (raw image created sparse when missing; attached with `losetup --find --show --partscan`). VHDX is W06 (Windows host); Linux hosts convert with `qemu-img convert -O vhdx` outside the engine.
- Supported source filesystems on the Linux engine: `vfat` (EFI), `ext4`, `xfs`, `swap`. Anything else on the system disk → preflight refusal naming the partition and filesystem.
- Partition plan: recorded order and sizes; the highest-numbered partition with role `root` or `data` absorbs all remaining space; 1 MiB alignment; first usable LBA at 1 MiB; 1 MiB reserved at the end for the backup GPT. Refusal when target < Σ(fixed partitions) + max(growable.UsedBytes × 1.1, 1 GiB) + 2 MiB.
- UUIDs: `mkfs.ext4 -U`, `mkfs.xfs -m uuid=`, `mkswap -U`, `mkfs.vfat -i <8 hex from FSUUID without the dash>`; GPT partition GUIDs via `sgdisk --partition-guid`. So the restored `/etc/fstab` and GRUB config resolve unchanged.
- No write to the target before preflight passes. Preflight downloads and verifies (checksums) the ordinary manifest, `layout.json`, and every system-state artifact into a temp staging dir.
- Restore is strict: any failed file → phase `restore` fails (the run is resumable; the existing restore resume state under `os.TempDir()` is reused). `Options.AllowPartialRestore` (default false) downgrades to a warning.
- Identity `original` writes `<root>/var/lib/breeze/recovery-marker.json` = `{"recoveryId","nonce","snapshotId","completedAt"}` (0600, root) only when `Options.Marker != nil`; identity `new` empties `<root>/etc/machine-id`, sets `<root>/etc/hostname` to `<original>-restored`, removes `<root>/etc/breeze/secrets.yaml`, and deletes the enrollment keys from `<root>/etc/breeze/agent.yaml`.
- Encryption phase on Linux is a recorded no-op (LUKS is refused by the W01 guard); the phase still appears in the result so callers see seven phases on every platform.
- Engine state file: `<StateDir>/rebuild-<snapshotID>-<targetHash>.json` (`StateDir` default `/var/lib/breeze/rebuild`, overridable). Completed phases before `restore` are skipped on re-run; `ForceReprovision` deletes the state and starts over.
- Wrong-disk protection inside the engine (the console adds the serial confirmation in W04): refuse a `disk` target that has any mounted partition, or that backs `/` or `/run/live/medium` of the running system.
- Result JSON is written by the CLI to `--result-json` and printed to stdout; `Result.Status` ∈ `completed | refused | failed`.
- No internal hostnames/IPs in committed files.

## 0. Ground truth (verified 2026-09-10 against `origin/main` @ `0414a46344`; re-verify W01/W02 symbols on the merged main before starting)

- Restore: `agent/internal/backup/restore.go:46` `RestoreFromSnapshotContext(ctx, provider providers.BackupProvider, cfg RestoreConfig, progressFn ProgressFunc) (*RestoreResult, error)`; `RestoreConfig{SnapshotID, TargetPath, SelectedPaths}`; `resolveTargetPath` (`:424`) strips the leading `/` so `/etc/hosts` lands at `<TargetPath>/etc/hosts`; `RestoreResult{Status, FilesRestored, BytesRestored, FilesFailed, FailedFiles, Warnings, StagingDir, Error}`; `ProgressFunc func(phase string, current, total int64, message string)`. After W02 it recreates symlinks/dirs/owners when euid 0.
- Provider interface `agent/internal/backup/providers/interface.go:19` (`Upload/Download/List/Delete`); `providers.NewFallbackProvider(primary, ...)` (`fallback.go:19`); provider construction for a restore command lives in `agent/cmd/breeze-backup/exec_backup.go` (`restoreProviderForCommand(payload json.RawMessage, mgr *backup.BackupManager, vaultState *vaultManagerRef)`), which is how the CLI builds a provider from a `providerConfig` JSON.
- Manifest download: `agent/internal/backup/bmr/bmr.go:256` `downloadManifest(snapshotID string, provider providers.BackupProvider) (*snapshotManifest, error)`; `backup` package has its own `downloadManifest(provider, snapshotID)` used by `restore.go:73`.
- System state: `bmr.go:438-640` `applySystemState(ctx, cfg RecoveryConfig, provider) systemStateResult` downloads `snapshots/<id>/system-state/manifest.json`, checks `RequiredSteps ∩ IncompleteSteps`, downloads each artifact into a temp staging dir with `verifyArtifactIntegrity` (`:639`) + `applyArtifactMetadata` (`:673`), then calls `restorer.RestoreSystemState(stagingDir)` (`:598`). `restore_linux.go` (`//go:build linux`): `restoreEtcTree(stagingDir)` copies `<staging>/etc` → package var `etcTargetDir = "/etc"` (`:37`); `restoreServices` runs `systemctl enable <svc>` (`:392-428`, list at `services/systemd.txt`); `restoreFirewall` runs `iptables-restore < firewall/iptables.rules` (`:431`); `restoreCrontabs` runs `crontab -u <user> <file>` from `crontabs/spool/` (`:454`); `reinstallPackages` from `packages/dpkg.txt|rpm.txt` (`:332-386`); exec seam `var runCommand` (`:29`); tests fake it with `fakeCommands` (`restore_linux_test.go:26`).
- Layout (W01): `agent/internal/backup/layout` — `Manifest{SchemaVersion, Platform, BootMode, Disks[]{Name, SizeBytes, SectorSize, TableType, IsSystem, Partitions[]{Number, TypeGUID, PartUUID, StartBytes, SizeBytes, UsedBytes, Filesystem, FSUUID, Label, MountPoint, Role, Encryption, Kind}}}`, `Assess(*Manifest) Restorability`, `(*Manifest).SystemDisk()`, role/GUID constants; key `snapshots/<id>/layout.json`.
- Fidelity (W02): `backup.SnapshotFile.HasContent()`, `Kind`, `LinkTarget`, `Owner`.
- Agent config on disk: `/etc/breeze/agent.yaml` (0644) + `/etc/breeze/secrets.yaml` (0600), written by `agent/internal/config/config.go:694-760` (`Save`/`SaveTo`); identity fields `AgentID, DeviceID, OrgID, SiteID, AuthToken, WatchdogAuthToken, HelperAuthToken` (`config.go:56-93`). Data dir `/var/lib/breeze` (`config.go:1059`).
- CLI wiring: `agent/cmd/breeze-backup/bmr_recover_cmd.go:35` `rootCmd.AddCommand(newBMRRecoverCommand())`; `:38-92` cobra pattern with `recoveryContext()` signal handling; result printed as indented JSON.
- Test conventions: `snapshot_test.go:46` `newMockProvider()` (in-memory provider with `files` map + `uploadCalls`); root-gated tests use `os.Geteuid()`; exec seams are package vars swapped in tests.
- Go module `github.com/breeze-rmm/agent`, Go 1.26.

---

### Task 1: Types, partition planner, result model

**Files:**
- Create: `agent/internal/backup/rebuild/types.go`, `agent/internal/backup/rebuild/plan.go`
- Test: `agent/internal/backup/rebuild/plan_test.go`

**Interfaces:**
- Produces (used by every later task and by W04/W05):

```go
package rebuild

type TargetKind string
const (
	TargetDisk  TargetKind = "disk"
	TargetImage TargetKind = "image"
)

type Target struct {
	Kind           TargetKind `json:"kind"`
	Path           string     `json:"path"`
	ImageSizeBytes int64      `json:"imageSizeBytes,omitempty"` // image only; created sparse when the file is missing
}

type IdentityMode string
const (
	IdentityOriginal IdentityMode = "original"
	IdentityNew      IdentityMode = "new"
)

// Marker binds the restored device to a pending server-side recovery (W04).
type Marker struct {
	RecoveryID string `json:"recoveryId"`
	Nonce      string `json:"nonce"`
}

type Phase string
const (
	PhasePreflight  Phase = "preflight"
	PhaseProvision  Phase = "provision"
	PhaseRestore    Phase = "restore"
	PhaseBoot       Phase = "boot"
	PhaseIdentity   Phase = "identity"
	PhaseEncryption Phase = "encryption"
	PhaseValidate   Phase = "validate"
)
var AllPhases = []Phase{PhasePreflight, PhaseProvision, PhaseRestore, PhaseBoot, PhaseIdentity, PhaseEncryption, PhaseValidate}

type PhaseStatus string
const (
	PhaseCompleted PhaseStatus = "completed"
	PhaseSkipped   PhaseStatus = "skipped"   // resumed run: already done
	PhaseFailed    PhaseStatus = "failed"
	PhaseRefused   PhaseStatus = "refused"
)

type PhaseResult struct {
	Phase       Phase       `json:"phase"`
	Status      PhaseStatus `json:"status"`
	StartedAt   time.Time   `json:"startedAt"`
	CompletedAt time.Time   `json:"completedAt"`
	Message     string      `json:"message,omitempty"`
}

type PlannedPartition struct {
	Number     int    `json:"number"`
	Role       string `json:"role"`
	TypeGUID   string `json:"typeGuid"`
	PartUUID   string `json:"partUuid,omitempty"`
	Name       string `json:"name,omitempty"`
	StartBytes int64  `json:"startBytes"`
	SizeBytes  int64  `json:"sizeBytes"`
	Filesystem string `json:"filesystem,omitempty"`
	FSUUID     string `json:"fsUuid,omitempty"`
	Label      string `json:"label,omitempty"`
	MountPoint string `json:"mountPoint,omitempty"`
	Grown      bool   `json:"grown"` // absorbed the target's extra space
}

type Plan struct {
	SourceDisk      string             `json:"sourceDisk"`
	SourceSizeBytes int64              `json:"sourceSizeBytes"`
	TargetPath      string             `json:"targetPath"`
	TargetSizeBytes int64              `json:"targetSizeBytes"`
	SectorSize      int                `json:"sectorSize"`
	Partitions      []PlannedPartition `json:"partitions"`
	MinimumBytes    int64              `json:"minimumBytes"` // what the target must offer
}

type Options struct {
	SnapshotID          string
	Provider            providers.BackupProvider
	Target              Target
	Identity            IdentityMode
	Marker              *Marker   // original identity only
	Layout              *layout.Manifest // nil → downloaded from snapshots/<id>/layout.json
	StateDir            string    // default /var/lib/breeze/rebuild
	StagingRoot         string    // default <StateDir>/mnt/<snapshotID>
	DryRun              bool      // preflight only; returns the Plan
	ForceReprovision    bool
	AllowPartialRestore bool
	RegenerateInitramfs bool      // default true; CLI --no-initramfs clears it
	SkipBoot            bool      // tests/CI only: synthetic roots have no bootloader
	System              System    // nil → real system (Task 2)
	Progress            func(phase Phase, message string, current, total int64)
}

type Result struct {
	SnapshotID    string        `json:"snapshotId"`
	Target        Target        `json:"target"`
	Identity      IdentityMode  `json:"identity"`
	Status        string        `json:"status"` // completed | refused | failed
	PhaseReached  Phase         `json:"phaseReached"`
	Phases        []PhaseResult `json:"phases"`
	Plan          *Plan         `json:"plan,omitempty"`
	Refusal       string        `json:"refusal,omitempty"`
	Error         string        `json:"error,omitempty"`
	Warnings      []string      `json:"warnings,omitempty"`
	FilesRestored int           `json:"filesRestored"`
	BytesRestored int64         `json:"bytesRestored"`
	DurationMs    int64         `json:"durationMs"`
	Resumed       bool          `json:"resumed"`
}

// RefusalError carries an operator-facing reason; Run maps it to Status "refused".
type RefusalError struct{ Reason string }
func (e *RefusalError) Error() string { return "refused: " + e.Reason }

const (
	MiB = int64(1) << 20
	GiB = int64(1) << 30
)

func PlanPartitions(src *layout.Disk, targetSizeBytes int64, sectorSize int) (*Plan, error)
```

- [ ] **Step 1: Write the failing planner test**

```go
package rebuild

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/layout"
)

func srcDisk() *layout.Disk {
	return &layout.Disk{Name: "/dev/sda", SizeBytes: 64 * GiB, SectorSize: 512, TableType: "gpt", IsSystem: true, Partitions: []layout.Partition{
		{Number: 1, Name: "/dev/sda1", TypeGUID: layout.GUIDEFISystem, PartUUID: "1111-aaaa", StartBytes: MiB, SizeBytes: 512 * MiB, Filesystem: "vfat", FSUUID: "ABCD-1234", MountPoint: "/boot/efi", Role: layout.RoleEFI, Encryption: layout.EncryptionNone},
		{Number: 2, Name: "/dev/sda2", TypeGUID: layout.GUIDLinuxFilesystem, PartUUID: "2222-bbbb", StartBytes: 513 * MiB, SizeBytes: 2 * GiB, Filesystem: "ext4", FSUUID: "boot-uuid", MountPoint: "/boot", Role: layout.RoleBoot, Encryption: layout.EncryptionNone},
		{Number: 3, Name: "/dev/sda3", TypeGUID: layout.GUIDLinuxFilesystem, PartUUID: "3333-cccc", StartBytes: (513 + 2048) * MiB, SizeBytes: 64*GiB - (513+2048)*MiB - MiB, UsedBytes: 8 * GiB, Filesystem: "ext4", FSUUID: "9f7a-root", Label: "rootfs", MountPoint: "/", Role: layout.RoleRoot, Encryption: layout.EncryptionNone},
	}}
}

func TestPlanPartitions_GrowsLastRootOnLargerTarget(t *testing.T) {
	p, err := PlanPartitions(srcDisk(), 100*GiB, 512)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Partitions) != 3 {
		t.Fatalf("partitions = %+v", p.Partitions)
	}
	efi, boot, root := p.Partitions[0], p.Partitions[1], p.Partitions[2]
	if efi.StartBytes != MiB || efi.SizeBytes != 512*MiB || efi.FSUUID != "ABCD-1234" || efi.Role != layout.RoleEFI {
		t.Errorf("efi = %+v", efi)
	}
	if boot.StartBytes != efi.StartBytes+efi.SizeBytes || boot.SizeBytes != 2*GiB {
		t.Errorf("boot = %+v", boot)
	}
	if !root.Grown || root.StartBytes != boot.StartBytes+boot.SizeBytes || root.StartBytes+root.SizeBytes != 100*GiB-MiB {
		t.Errorf("root = %+v (want grown to the end minus 1 MiB)", root)
	}
	if root.StartBytes%MiB != 0 || root.SizeBytes%MiB != 0 {
		t.Errorf("root not 1 MiB aligned: %+v", root)
	}
	if p.MinimumBytes != 512*MiB+2*GiB+int64(float64(8*GiB)*1.1)+2*MiB {
		t.Errorf("MinimumBytes = %d", p.MinimumBytes)
	}
}

func TestPlanPartitions_SmallerTargetShrinksRootToUsedPlusMargin(t *testing.T) {
	p, err := PlanPartitions(srcDisk(), 12*GiB, 512)
	if err != nil {
		t.Fatal(err)
	}
	root := p.Partitions[2]
	if root.SizeBytes < int64(float64(8*GiB)*1.1) || root.StartBytes+root.SizeBytes > 12*GiB-MiB {
		t.Errorf("root = %+v", root)
	}
}

func TestPlanPartitions_RefusesTooSmall(t *testing.T) {
	_, err := PlanPartitions(srcDisk(), 10*GiB, 512)
	var ref *RefusalError
	if err == nil || !errorsAs(err, &ref) || !strings.Contains(ref.Reason, "target is too small") {
		t.Fatalf("err = %v", err)
	}
}

func TestPlanPartitions_RefusesUnsupportedFilesystem(t *testing.T) {
	d := srcDisk()
	d.Partitions[1].Filesystem = "btrfs"
	_, err := PlanPartitions(d, 100*GiB, 512)
	if err == nil || !strings.Contains(err.Error(), "partition 2 filesystem \"btrfs\"") {
		t.Fatalf("err = %v", err)
	}
}

func TestPlanPartitions_SkipsNonPartitionChildren(t *testing.T) {
	d := srcDisk()
	d.Partitions = append(d.Partitions, layout.Partition{Kind: "crypt", Name: "/dev/mapper/x", Filesystem: "ext4"})
	p, err := PlanPartitions(d, 100*GiB, 512)
	if err != nil || len(p.Partitions) != 3 {
		t.Fatalf("p=%+v err=%v", p, err)
	}
}
```

(`errorsAs` is `errors.As` — import `errors` and call it directly; the helper name above is only to keep the snippet short.)

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go test ./internal/backup/rebuild/ 2>&1 | head -3`
Expected: build failure (package does not exist).

- [ ] **Step 3: Implement `types.go` (the block above, with imports `time`, `github.com/breeze-rmm/agent/internal/backup/layout`, `github.com/breeze-rmm/agent/internal/backup/providers`) and `plan.go`:**

```go
package rebuild

import (
	"fmt"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/layout"
)

var supportedFilesystems = map[string]bool{"vfat": true, "fat32": true, "ext4": true, "xfs": true, "swap": true}

func alignUp(n, a int64) int64 { return (n + a - 1) / a * a }

// PlanPartitions lays the source disk's partitions onto a target of
// targetSizeBytes. Fixed partitions keep their recorded size; the last
// root/data partition absorbs the remainder (or shrinks to used×1.1 on a
// smaller target). Non-partition children (Kind != "") are ignored — the W01
// guard already refused layouts that depend on them.
func PlanPartitions(src *layout.Disk, targetSizeBytes int64, sectorSize int) (*Plan, error) {
	if src == nil {
		return nil, &RefusalError{Reason: "no source disk in layout"}
	}
	if sectorSize <= 0 {
		sectorSize = 512
	}
	var parts []layout.Partition
	for _, p := range src.Partitions {
		if p.Kind == "" && p.Number > 0 {
			parts = append(parts, p)
		}
	}
	if len(parts) == 0 {
		return nil, &RefusalError{Reason: "source disk has no partitions"}
	}
	growIdx := -1
	for i, p := range parts {
		if p.Role == layout.RoleRoot || p.Role == layout.RoleData {
			growIdx = i
		}
	}
	var fixed, growMin int64
	for i, p := range parts {
		fs := strings.ToLower(p.Filesystem)
		if fs != "" && !supportedFilesystems[fs] && p.Role != layout.RoleMSR {
			return nil, &RefusalError{Reason: fmt.Sprintf("partition %d filesystem %q is not supported by the Linux engine (vfat, ext4, xfs, swap)", p.Number, p.Filesystem)}
		}
		if i == growIdx {
			growMin = alignUp(int64(float64(p.UsedBytes)*1.1), MiB)
			if growMin < GiB {
				growMin = GiB
			}
			continue
		}
		fixed += alignUp(p.SizeBytes, MiB)
	}
	plan := &Plan{SourceDisk: src.Name, SourceSizeBytes: src.SizeBytes, TargetSizeBytes: targetSizeBytes, SectorSize: sectorSize, MinimumBytes: fixed + growMin + 2*MiB}
	if targetSizeBytes < plan.MinimumBytes {
		return nil, &RefusalError{Reason: fmt.Sprintf("target is too small: %d bytes available, %d bytes needed (fixed partitions %d + root data %d + GPT reserve)", targetSizeBytes, plan.MinimumBytes, fixed, growMin)}
	}
	usableEnd := targetSizeBytes - MiB
	cursor := MiB
	for i, p := range parts {
		size := alignUp(p.SizeBytes, MiB)
		grown := false
		if i == growIdx {
			// Everything after this partition is fixed; leave room for it.
			var after int64
			for _, q := range parts[i+1:] {
				after += alignUp(q.SizeBytes, MiB)
			}
			size = usableEnd - after - cursor
			grown = true
		}
		plan.Partitions = append(plan.Partitions, PlannedPartition{
			Number: p.Number, Role: p.Role, TypeGUID: p.TypeGUID, PartUUID: p.PartUUID, Name: p.Label,
			StartBytes: cursor, SizeBytes: size, Filesystem: strings.ToLower(p.Filesystem), FSUUID: p.FSUUID, Label: p.Label, MountPoint: p.MountPoint, Grown: grown,
		})
		cursor += size
	}
	if cursor > usableEnd {
		return nil, &RefusalError{Reason: fmt.Sprintf("target is too small: plan ends at %d bytes but only %d are usable", cursor, usableEnd)}
	}
	return plan, nil
}
```

- [ ] **Step 4: Run tests, commit**

Run: `cd agent && go test -race ./internal/backup/rebuild/ 2>&1 | tail -3`
Expected: `ok`.

```bash
git add agent/internal/backup/rebuild/
git commit -m "feat(rebuild): engine types, result model and pure partition planner (W03)"
```

---

### Task 2: `System` seam — real Linux implementation and test fake

**Files:**
- Create: `agent/internal/backup/rebuild/system.go` (interface, untagged), `agent/internal/backup/rebuild/system_linux.go` (`//go:build linux`), `agent/internal/backup/rebuild/system_other.go` (`//go:build !linux`), `agent/internal/backup/rebuild/system_fake_test.go`
- Test: `agent/internal/backup/rebuild/system_linux_test.go` (`//go:build linux`, pure helpers only)

**Interfaces:**

```go
// System is every interaction with the machine the engine needs. The real
// implementation shells out; tests use fakeSystem.
type System interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
	// Chroot returns a runner that executes inside root (via `chroot root name args…`).
	Chroot(root string) func(ctx context.Context, name string, args ...string) ([]byte, error)
	BlockDeviceSize(path string) (int64, error)            // blockdev --getsize64
	AttachImage(path string, sizeBytes int64) (device string, detach func() error, err error) // creates sparse file if missing; losetup --find --show --partscan
	PartitionDevice(disk string, number int) string         // /dev/sda1, /dev/nvme0n1p1, /dev/loop0p1
	Rescan(ctx context.Context, disk string) error          // partprobe + udevadm settle
	MountedSources() ([]string, error)                      // every SOURCE in /proc/self/mounts
	RootSources() ([]string, error)                         // devices backing / and /run/live/medium (findmnt -no SOURCE)
	Mount(ctx context.Context, device, dir, fstype string, opts ...string) error
	BindMount(ctx context.Context, src, dir string) error
	Unmount(ctx context.Context, dir string) error
	Sync(ctx context.Context) error
	Arch() string                                           // runtime.GOARCH
}

func partitionDevice(disk string, number int) string // exported through the interface; pure, tested
```

- [ ] **Step 1: Write the failing pure-helper test** (`system_linux_test.go`)

```go
//go:build linux

package rebuild

import "testing"

func TestPartitionDevice(t *testing.T) {
	for _, tt := range []struct{ disk string; n int; want string }{
		{"/dev/sda", 2, "/dev/sda2"},
		{"/dev/nvme0n1", 3, "/dev/nvme0n1p3"},
		{"/dev/loop0", 1, "/dev/loop0p1"},
		{"/dev/mmcblk0", 2, "/dev/mmcblk0p2"},
		{"/dev/vda", 1, "/dev/vda1"},
	} {
		if got := partitionDevice(tt.disk, tt.n); got != tt.want {
			t.Errorf("%s #%d = %s want %s", tt.disk, tt.n, got, tt.want)
		}
	}
}

func TestParseMountSources(t *testing.T) {
	in := "sysfs /sys sysfs rw 0 0\n/dev/sda2 / ext4 rw 0 0\n/dev/sda1 /boot/efi vfat rw 0 0\n"
	got := parseMountSources(in)
	if len(got) != 3 || got[1] != "/dev/sda2" || got[2] != "/dev/sda1" {
		t.Errorf("got %v", got)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go test ./internal/backup/rebuild/ -run 'TestPartitionDevice|TestParseMountSources' 2>&1 | head -3` — expected: undefined symbols. (On macOS the linux-tagged test is skipped; run `GOOS=linux go vet ./internal/backup/rebuild/` to at least compile it.)

- [ ] **Step 3: Implement `system.go`** (interface above plus):

```go
func partitionDevice(disk string, number int) string {
	if len(disk) > 0 && disk[len(disk)-1] >= '0' && disk[len(disk)-1] <= '9' {
		return fmt.Sprintf("%sp%d", disk, number)
	}
	return fmt.Sprintf("%s%d", disk, number)
}

func parseMountSources(procMounts string) []string {
	var out []string
	for _, line := range strings.Split(procMounts, "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 {
			out = append(out, f[0])
		}
	}
	return out
}
```

`system_linux.go`:

```go
//go:build linux

package rebuild

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

type realSystem struct{}

// NewSystem returns the real OS implementation.
func NewSystem() System { return realSystem{} }

func (realSystem) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func (s realSystem) Chroot(root string) func(context.Context, string, ...string) ([]byte, error) {
	return func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return s.Run(ctx, "chroot", append([]string{root, name}, args...)...)
	}
}

func (s realSystem) BlockDeviceSize(path string) (int64, error) {
	out, err := s.Run(context.Background(), "blockdev", "--getsize64", path)
	if err != nil {
		return 0, fmt.Errorf("blockdev --getsize64 %s: %s: %w", path, strings.TrimSpace(string(out)), err)
	}
	return strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
}

func (s realSystem) AttachImage(path string, sizeBytes int64) (string, func() error, error) {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		if sizeBytes <= 0 {
			return "", nil, fmt.Errorf("image %s does not exist and no size was given", path)
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return "", nil, err
		}
		if err := f.Truncate(sizeBytes); err != nil {
			f.Close()
			return "", nil, err
		}
		f.Close()
	}
	out, err := s.Run(context.Background(), "losetup", "--find", "--show", "--partscan", path)
	if err != nil {
		return "", nil, fmt.Errorf("losetup %s: %s: %w", path, strings.TrimSpace(string(out)), err)
	}
	dev := strings.TrimSpace(string(out))
	return dev, func() error { _, err := s.Run(context.Background(), "losetup", "-d", dev); return err }, nil
}

func (realSystem) PartitionDevice(disk string, n int) string { return partitionDevice(disk, n) }

func (s realSystem) Rescan(ctx context.Context, disk string) error {
	if out, err := s.Run(ctx, "partprobe", disk); err != nil {
		return fmt.Errorf("partprobe %s: %s: %w", disk, strings.TrimSpace(string(out)), err)
	}
	_, _ = s.Run(ctx, "udevadm", "settle", "--timeout=15")
	return nil
}

func (realSystem) MountedSources() ([]string, error) {
	data, err := os.ReadFile("/proc/self/mounts")
	if err != nil {
		return nil, err
	}
	return parseMountSources(string(data)), nil
}

func (s realSystem) RootSources() ([]string, error) {
	var out []string
	for _, mp := range []string{"/", "/run/live/medium", "/lib/live/mount/medium"} {
		b, err := s.Run(context.Background(), "findmnt", "-no", "SOURCE", mp)
		if err == nil {
			if src := strings.TrimSpace(string(b)); src != "" {
				out = append(out, src)
			}
		}
	}
	return out, nil
}

func (s realSystem) Mount(ctx context.Context, device, dir, fstype string, opts ...string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	args := []string{}
	if fstype != "" {
		args = append(args, "-t", fstype)
	}
	if len(opts) > 0 {
		args = append(args, "-o", strings.Join(opts, ","))
	}
	args = append(args, device, dir)
	if out, err := s.Run(ctx, "mount", args...); err != nil {
		return fmt.Errorf("mount %s %s: %s: %w", device, dir, strings.TrimSpace(string(out)), err)
	}
	return nil
}

func (s realSystem) BindMount(ctx context.Context, src, dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if out, err := s.Run(ctx, "mount", "--bind", src, dir); err != nil {
		return fmt.Errorf("bind mount %s %s: %s: %w", src, dir, strings.TrimSpace(string(out)), err)
	}
	return nil
}

func (s realSystem) Unmount(ctx context.Context, dir string) error {
	if out, err := s.Run(ctx, "umount", dir); err != nil {
		return fmt.Errorf("umount %s: %s: %w", dir, strings.TrimSpace(string(out)), err)
	}
	return nil
}

func (s realSystem) Sync(ctx context.Context) error { _, err := s.Run(ctx, "sync"); return err }
func (realSystem) Arch() string                    { return runtime.GOARCH }
```

`system_other.go`:

```go
//go:build !linux

package rebuild

import "errors"

// NewSystem is unavailable off Linux in this wave (Windows engine is W06).
func NewSystem() System { return nil }

var ErrUnsupportedHost = errors.New("the rebuild engine runs on Linux only in this release")
```

`system_fake_test.go` (package `rebuild`, `_test.go` so it ships nowhere):

```go
package rebuild

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// fakeSystem records every command, "mounts" devices by creating directories,
// and answers size/mount questions from fields. Files restored under a
// mounted dir land in the real filesystem under fake.dir, so later phases
// and assertions can inspect them.
type fakeSystem struct {
	mu        sync.Mutex
	dir       string   // temp root
	cmds      []string // "name arg1 arg2"
	diskSize  int64
	mounted   []string // devices reported by MountedSources
	rootSrcs  []string
	fail      map[string]error // command prefix → error
	arch      string
	mountLog  []string // "device dir"
	unmounts  []string
}

func newFakeSystem(dir string, diskSize int64) *fakeSystem {
	return &fakeSystem{dir: dir, diskSize: diskSize, fail: map[string]error{}, arch: "amd64"}
}

func (f *fakeSystem) record(name string, args ...string) ([]byte, error) {
	line := strings.TrimSpace(name + " " + strings.Join(args, " "))
	f.mu.Lock()
	f.cmds = append(f.cmds, line)
	f.mu.Unlock()
	for prefix, err := range f.fail {
		if strings.HasPrefix(line, prefix) {
			return []byte("simulated failure"), err
		}
	}
	return nil, nil
}

func (f *fakeSystem) Run(_ context.Context, name string, args ...string) ([]byte, error) { return f.record(name, args...) }
func (f *fakeSystem) Chroot(root string) func(context.Context, string, ...string) ([]byte, error) {
	return func(_ context.Context, name string, args ...string) ([]byte, error) {
		return f.record("chroot", append([]string{root, name}, args...)...)
	}
}
func (f *fakeSystem) BlockDeviceSize(string) (int64, error) { return f.diskSize, nil }
func (f *fakeSystem) AttachImage(path string, size int64) (string, func() error, error) {
	_, _ = f.record("losetup", "--find", "--show", "--partscan", path)
	return "/dev/loop7", func() error { _, _ = f.record("losetup", "-d", "/dev/loop7"); return nil }, nil
}
func (f *fakeSystem) PartitionDevice(disk string, n int) string { return partitionDevice(disk, n) }
func (f *fakeSystem) Rescan(_ context.Context, disk string) error { _, err := f.record("partprobe", disk); return err }
func (f *fakeSystem) MountedSources() ([]string, error)         { return f.mounted, nil }
func (f *fakeSystem) RootSources() ([]string, error)            { return f.rootSrcs, nil }
func (f *fakeSystem) Mount(_ context.Context, device, dir, fstype string, opts ...string) error {
	_, err := f.record("mount", append([]string{"-t", fstype, device, dir}, opts...)...)
	if err != nil {
		return err
	}
	f.mountLog = append(f.mountLog, device+" "+dir)
	return os.MkdirAll(dir, 0o755)
}
func (f *fakeSystem) BindMount(_ context.Context, src, dir string) error {
	_, err := f.record("mount", "--bind", src, dir)
	if err != nil {
		return err
	}
	return os.MkdirAll(dir, 0o755)
}
func (f *fakeSystem) Unmount(_ context.Context, dir string) error {
	f.unmounts = append(f.unmounts, dir)
	_, err := f.record("umount", dir)
	return err
}
func (f *fakeSystem) Sync(context.Context) error { _, err := f.record("sync"); return err }
func (f *fakeSystem) Arch() string                { return f.arch }

func (f *fakeSystem) has(prefix string) bool {
	for _, c := range f.cmds {
		if strings.HasPrefix(c, prefix) {
			return true
		}
	}
	return false
}

func (f *fakeSystem) indexOf(prefix string) int {
	for i, c := range f.cmds {
		if strings.HasPrefix(c, prefix) {
			return i
		}
	}
	return -1
}

func (f *fakeSystem) dump() string { return fmt.Sprintf("commands:\n  %s", strings.Join(f.cmds, "\n  ")) }

var _ System = (*fakeSystem)(nil)

func stagingPath(root string, parts ...string) string { return filepath.Join(append([]string{root}, parts...)...) }
```

- [ ] **Step 4: Compile everywhere, run, commit**

Run: `cd agent && go test -race ./internal/backup/rebuild/ 2>&1 | tail -3 && GOOS=linux go vet ./internal/backup/rebuild/ && GOOS=windows go vet ./internal/backup/rebuild/ && GOOS=darwin go vet ./internal/backup/rebuild/ && echo VET-OK`
Expected: `ok`, `VET-OK`.

```bash
git add agent/internal/backup/rebuild/
git commit -m "feat(rebuild): System seam with real Linux implementation and recording test fake (W03)"
```

---

### Task 3: `bmr` — extract `DownloadSystemState`, add `RestoreSystemStateOffline`

**Files:**
- Modify: `agent/internal/backup/bmr/bmr.go:438-640` (`applySystemState`)
- Modify: `agent/internal/backup/bmr/restore_linux.go` (`restoreEtcTree`, `restoreServices`, `restoreFirewall`, `restoreCrontabs` gain a root parameter; new exported `RestoreSystemStateOffline`)
- Create: `agent/internal/backup/bmr/restore_offline_other.go` (`//go:build !linux`)
- Test: `agent/internal/backup/bmr/bmr_test.go`, `agent/internal/backup/bmr/restore_linux_test.go`

**Interfaces:**
- Produces:

```go
// DownloadSystemState fetches snapshots/<id>/system-state/manifest.json and
// every artifact into stagingDir, verifying each checksum. expect=true makes
// a missing manifest an error (the snapshot advertised state). Returns the
// manifest, non-fatal warnings, and the error. The caller owns stagingDir.
func DownloadSystemState(ctx context.Context, provider providers.BackupProvider, snapshotID string, expect bool, stagingDir string) (*systemstate.SystemStateManifest, []string, error)

// RestoreSystemStateOffline applies a downloaded system state under root (a
// mounted, not-running tree). Packages are NOT reinstalled (the file backup
// already holds them); services are enabled with `systemctl --root`; firewall
// rules and crontabs are placed as files for first boot.
func RestoreSystemStateOffline(ctx context.Context, root, stagingDir string) (warnings []string, err error)
```

- [ ] **Step 1: Write the failing tests**

`bmr_test.go` — a test that seeds a fake provider with a state manifest + one artifact and asserts `DownloadSystemState` returns the manifest, the artifact file exists under `stagingDir` with matching sha256, and a corrupted artifact yields an error naming it (reuse the fixtures the existing `applySystemState` tests build; the assertion shape:)

```go
func TestDownloadSystemState_VerifiesArtifacts(t *testing.T) {
	provider, snapshotID := seedSystemStateSnapshot(t, map[string][]byte{"services/systemd.txt": []byte("ssh.service\n")}) // helper from the existing applySystemState tests; if it has another name, use that one
	dir := t.TempDir()
	m, warnings, err := DownloadSystemState(context.Background(), provider, snapshotID, true, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 || m == nil || len(m.Artifacts) != 1 {
		t.Fatalf("m=%+v warnings=%v", m, warnings)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "services", "systemd.txt")); err != nil || string(b) != "ssh.service\n" {
		t.Fatalf("artifact = %q err=%v", b, err)
	}
	// Tamper → error names the artifact.
	provider.files["snapshots/"+snapshotID+"/system-state/services/systemd.txt"] = []byte("evil\n")
	if _, _, err := DownloadSystemState(context.Background(), provider, snapshotID, true, t.TempDir()); err == nil || !strings.Contains(err.Error(), "services/systemd.txt") {
		t.Fatalf("tamper err = %v", err)
	}
}
```

`restore_linux_test.go`:

```go
func TestRestoreSystemStateOffline_AppliesUnderRootWithoutTouchingHost(t *testing.T) {
	root := t.TempDir()
	staging := t.TempDir()
	mustWrite(t, filepath.Join(staging, "etc", "hostname"), "srv-1\n")
	mustWrite(t, filepath.Join(staging, "services", "systemd.txt"), "ssh.service\ncron.service\n")
	mustWrite(t, filepath.Join(staging, "firewall", "iptables.rules"), "*filter\nCOMMIT\n")
	mustWrite(t, filepath.Join(staging, "crontabs", "spool", "root"), "* * * * * /bin/true\n")
	mustWrite(t, filepath.Join(staging, "packages", "dpkg.txt"), "vim install\n")
	mustWrite(t, filepath.Join(root, "etc", "passwd"), "root:x:0:0:root:/root:/bin/bash\n")
	mustWrite(t, filepath.Join(root, "etc", "group"), "root:x:0:\ncrontab:x:105:\n")
	mustWrite(t, filepath.Join(root, "usr", "sbin", "netfilter-persistent"), "#!/bin/sh\n")
	recorded := fakeCommands(t, map[string]error{})

	warnings, err := RestoreSystemStateOffline(context.Background(), root, staging)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "etc", "hostname")); string(b) != "srv-1\n" {
		t.Errorf("etc tree not applied under root: %q", b)
	}
	if !hasCommand(*recorded, "systemctl --root="+root+" enable ssh.service") || !hasCommand(*recorded, "systemctl --root="+root+" enable cron.service") {
		t.Errorf("services not enabled offline: %+v", *recorded)
	}
	for _, c := range *recorded {
		if strings.HasPrefix(c.name, "iptables-restore") || c.name == "crontab" || c.name == "dpkg" || c.name == "apt-get" || c.name == "bash" {
			t.Errorf("offline apply must not run %q against the host", c.name)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(root, "etc", "iptables", "rules.v4")); !strings.Contains(string(b), "COMMIT") {
		t.Errorf("firewall rules not staged for first boot: %q", b)
	}
	if fi, err := os.Stat(filepath.Join(root, "var", "spool", "cron", "crontabs", "root")); err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("crontab not placed (err=%v mode=%v)", err, fi)
	}
	joined := strings.Join(warnings, "\n")
	if !strings.Contains(joined, "package reinstall skipped") {
		t.Errorf("warnings = %v", warnings)
	}
}
```

(`fakeCommands`/`recordedCommand` exist at `restore_linux_test.go:26`; add `hasCommand` and `mustWrite` helpers if absent.)

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go test ./internal/backup/bmr/ -run 'TestDownloadSystemState|TestRestoreSystemStateOffline' 2>&1 | head -5` — expected: undefined symbols (on macOS the linux test is not compiled; use `GOOS=linux go vet ./internal/backup/bmr/` to see the compile error).

- [ ] **Step 3: Implement**

`bmr.go`: move the body of `applySystemState` from the manifest download through the artifact loop (everything before `restorer := newRestorerFunc()` at `:598`) into `DownloadSystemState`, returning `(&stateManifest, warnings, nil)`; the staging dir becomes the caller's parameter instead of `os.MkdirTemp`. `applySystemState` then becomes: create temp staging, call `DownloadSystemState(ctx, provider, cfg.SnapshotID, cfg.ExpectSystemState, stagingDir)`, map the "manifest missing and not expected" case to the existing soft-skip warning (`DownloadSystemState` returns a sentinel `ErrNoSystemState` for that case; `applySystemState` converts it to the existing warning string `"no system state found in snapshot, skipping state restore"`), then continue exactly as today from `restorer := newRestorerFunc()`. Existing `applySystemState` tests must stay green unchanged.

`restore_linux.go`:
- Change `restoreEtcTree(stagingDir string)` → `restoreEtcTree(stagingDir, targetEtc string)`; the live path passes `etcTargetDir`, offline passes `filepath.Join(root, "etc")`.
- `restoreServices(stagingDir string)` → `restoreServices(stagingDir, root string)`: when `root != ""` run `systemctl --root=<root> enable <svc>`, else `systemctl enable <svc>`.
- `restoreFirewall(stagingDir, root string)`: when `root != ""`, copy `firewall/iptables.rules` to `<root>/etc/iptables/rules.v4` (0640) if `<root>/usr/sbin/netfilter-persistent` or `<root>/usr/sbin/iptables-restore` exists, else to `<root>/etc/breeze/recovery/iptables.rules` and return a warning `"firewall rules staged at /etc/breeze/recovery/iptables.rules (no iptables-persistent in the restored system)"`; live path unchanged.
- `restoreCrontabs(stagingDir, root string)`: when `root != ""`, place each spool file at `<root>/var/spool/cron/crontabs/<user>` if `<root>/var/spool/cron/crontabs` exists (Debian) else `<root>/var/spool/cron/<user>` (RHEL), mode 0600, owner = uid from `<root>/etc/passwd` for `<user>` and gid of group `crontab` from `<root>/etc/group` when present (Debian) else 0 — `os.Lchown` only when `os.Geteuid()==0`; live path unchanged.
- New:

```go
// RestoreSystemStateOffline applies system state under root. Package
// reinstall is skipped on purpose: the whole-machine file backup restored
// the package database and files already, and dpkg/dnf cannot run against a
// tree that is not booted.
func RestoreSystemStateOffline(ctx context.Context, root, stagingDir string) ([]string, error) {
	if root == "" || root == "/" {
		return nil, errors.New("offline apply requires a non-root target tree")
	}
	r := &linuxRestorer{}
	var warnings []string
	var errs []error
	if skipped, err := r.restoreEtcTree(stagingDir, filepath.Join(root, "etc")); err != nil {
		errs = append(errs, fmt.Errorf("etc: %w", err))
	} else if len(skipped) > 0 {
		warnings = append(warnings, fmt.Sprintf("etc: skipped %d excluded path(s)", len(skipped)))
	}
	if _, err := os.Stat(filepath.Join(stagingDir, "packages")); err == nil {
		warnings = append(warnings, "package reinstall skipped in offline mode (files restored from backup)")
	}
	if err := r.restoreServices(stagingDir, root); err != nil {
		errs = append(errs, fmt.Errorf("services: %w", err))
	}
	if w, err := r.restoreFirewallOffline(stagingDir, root); err != nil {
		errs = append(errs, fmt.Errorf("firewall: %w", err))
	} else if w != "" {
		warnings = append(warnings, w)
	}
	if err := r.restoreCrontabs(stagingDir, root); err != nil {
		errs = append(errs, fmt.Errorf("crontabs: %w", err))
	}
	return warnings, errors.Join(errs...)
}
```

(If threading `root` through `restoreFirewall` reads worse than a separate `restoreFirewallOffline(stagingDir, root) (string, error)`, use the separate function — the test only checks the outcome.)

`restore_offline_other.go`:

```go
//go:build !linux

package bmr

import (
	"context"
	"errors"
)

func RestoreSystemStateOffline(_ context.Context, _, _ string) ([]string, error) {
	return nil, errors.New("offline system-state apply is Linux-only in this release")
}
```

- [ ] **Step 4: Run bmr tests on host + linux vet, commit**

Run: `cd agent && go test -race ./internal/backup/bmr/ 2>&1 | tail -3 && GOOS=linux go vet ./internal/backup/bmr/ && GOOS=windows go vet ./internal/backup/bmr/ && echo VET-OK`

```bash
git add agent/internal/backup/bmr/
git commit -m "feat(bmr): extract DownloadSystemState; add RestoreSystemStateOffline for mounted trees (W03)"
```

---

### Task 4: Engine — preflight, provision, restore tree

**Files:**
- Create: `agent/internal/backup/rebuild/engine.go` (Run, state file, phase runner), `agent/internal/backup/rebuild/preflight.go`, `agent/internal/backup/rebuild/provision.go`, `agent/internal/backup/rebuild/restore_tree.go`, `agent/internal/backup/rebuild/fetch.go`
- Test: `agent/internal/backup/rebuild/engine_test.go`

**Interfaces:**
- Produces: `func Run(ctx context.Context, opts Options) (*Result, error)`; internal `type run struct` carrying `opts, sys, plan, disk (device path), detach, staging, mounts []string, state *runState, result *Result`; `type runState struct { SnapshotID, TargetKey string; Plan *Plan; Completed map[Phase]bool; UpdatedAt time.Time }` persisted at `<StateDir>/rebuild-<snapshotID>-<sha256(target.Kind+target.Path)[:12]>.json`; `fetchLayout(ctx, provider, snapshotID) (*layout.Manifest, error)`; `fetchAndVerify(ctx, r) error` (ordinary manifest + system state into `r.stateStaging`).

- [ ] **Step 1: Write the failing engine tests** (fake system, mock provider; the `newMockProvider` helper lives in package `backup`'s tests, so give `rebuild` its own tiny in-memory provider in `engine_test.go`):

```go
package rebuild

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

type memProvider struct{ files map[string][]byte }

func (m *memProvider) Upload(local, remote string) error {
	b, err := os.ReadFile(local)
	if err != nil {
		return err
	}
	m.files[remote] = b
	return nil
}
func (m *memProvider) Download(remote, local string) error {
	b, ok := m.files[remote]
	if !ok {
		return os.ErrNotExist
	}
	if err := os.MkdirAll(filepath.Dir(local), 0o755); err != nil {
		return err
	}
	return os.WriteFile(local, b, 0o600)
}
func (m *memProvider) List(prefix string) ([]string, error) {
	var out []string
	for k := range m.files {
		if strings.HasPrefix(k, prefix) {
			out = append(out, k)
		}
	}
	return out, nil
}
func (m *memProvider) Delete(remote string) error { delete(m.files, remote); return nil }

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

// seedSnapshot builds a whole-machine-shaped snapshot: files, a symlink, the
// restored EFI tree, fstab with the recorded UUIDs, a Debian-style
// update-grub, plus layout.json and a system-state manifest.
func seedSnapshot(t *testing.T, id string, lay *layout.Manifest) *memProvider {
	t.Helper()
	p := &memProvider{files: map[string][]byte{}}
	content := map[string][]byte{
		"/etc/hostname":                     []byte("srv-1\n"),
		"/etc/fstab":                        []byte("UUID=9f7a-root / ext4 defaults 0 1\nUUID=ABCD-1234 /boot/efi vfat umask=0077 0 1\n"),
		"/etc/machine-id":                   []byte("0123456789abcdef0123456789abcdef\n"),
		"/etc/breeze/agent.yaml":            []byte("server_url: https://example.invalid\nagent_id: a1\ndevice_id: d1\nauth_token: t\n"),
		"/etc/breeze/secrets.yaml":          []byte("auth_token: t\n"),
		"/usr/sbin/update-grub":             []byte("#!/bin/sh\n"),
		"/usr/bin/tool":                     []byte("#!/bin/sh\n"),
		"/boot/efi/EFI/ubuntu/shimx64.efi":  []byte("shim"),
		"/boot/efi/EFI/ubuntu/grubx64.efi":  []byte("grub"),
		"/boot/efi/EFI/BOOT/BOOTX64.EFI":    []byte("shim"),
		"/boot/grub/grub.cfg":               []byte("set default=0\n"),
	}
	var files []backup.SnapshotFile
	for src, b := range content {
		key := "snapshots/" + id + "/files/path_0" + src
		p.files[key] = b
		files = append(files, backup.SnapshotFile{SourcePath: src, BackupPath: key, Size: int64(len(b)), Checksum: sum(b), Mode: 0o644, ModTime: time.Now().UTC()})
	}
	files = append(files, backup.SnapshotFile{SourcePath: "/bin", Kind: backup.KindSymlink, LinkTarget: "usr/bin", ModTime: time.Now().UTC()})
	man, _ := json.Marshal(backup.Snapshot{ID: id, Timestamp: time.Now().UTC(), Files: files})
	p.files["snapshots/"+id+"/manifest.json"] = man
	lb, _ := json.Marshal(lay)
	p.files["snapshots/"+id+"/layout.json"] = lb
	svc := []byte("ssh.service\n")
	p.files["snapshots/"+id+"/system-state/services/systemd.txt"] = svc
	sm, _ := json.Marshal(systemstate.SystemStateManifest{Platform: "linux", SchemaVersion: 1, Artifacts: []systemstate.Artifact{{Name: "services", Category: "services", Path: "services/systemd.txt", SizeBytes: int64(len(svc)), Checksum: sum(svc)}}})
	p.files["snapshots/"+id+"/system-state/manifest.json"] = sm
	return p
}

func testLayout() *layout.Manifest {
	d := srcDisk()
	return &layout.Manifest{SchemaVersion: layout.SchemaVersion, Platform: "linux", BootMode: layout.BootModeUEFI, OSRelease: "Ubuntu 24.04", Hostname: "srv-1", Disks: []layout.Disk{*d}}
}

func TestRun_DryRunProducesPlanWithoutWrites(t *testing.T) {
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	p := seedSnapshot(t, "snap-1", testLayout())
	res, err := Run(context.Background(), Options{SnapshotID: "snap-1", Provider: p, Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}, Identity: IdentityNew, StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), DryRun: true, System: sys})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "completed" || res.Plan == nil || len(res.Plan.Partitions) != 3 || res.PhaseReached != PhasePreflight {
		t.Fatalf("res = %+v", res)
	}
	for _, c := range sys.cmds {
		if strings.HasPrefix(c, "sgdisk") || strings.HasPrefix(c, "mkfs") || strings.HasPrefix(c, "mount") {
			t.Fatalf("dry run wrote: %s\n%s", c, sys.dump())
		}
	}
}

func TestRun_PreflightRefusals(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(sys *fakeSystem, p *memProvider, lay *layout.Manifest)
		want   string
	}{
		{"unsupported layout", func(_ *fakeSystem, _ *memProvider, lay *layout.Manifest) { lay.BootMode = layout.BootModeBIOS }, layout.ReasonBIOSBoot},
		{"target mounted", func(sys *fakeSystem, _ *memProvider, _ *layout.Manifest) { sys.mounted = []string{"/dev/sdb2"} }, "target disk /dev/sdb is in use"},
		{"target is the running system", func(sys *fakeSystem, _ *memProvider, _ *layout.Manifest) { sys.rootSrcs = []string{"/dev/sdb1"} }, "running system"},
		{"target too small", func(sys *fakeSystem, _ *memProvider, _ *layout.Manifest) { sys.diskSize = 4 * GiB }, "target is too small"},
		{"layout schema from the future", func(_ *fakeSystem, _ *memProvider, lay *layout.Manifest) { lay.SchemaVersion = 99 }, "layout schema version 99"},
		{"missing layout.json", func(_ *fakeSystem, p *memProvider, _ *layout.Manifest) { delete(p.files, "snapshots/snap-1/layout.json") }, "no disk layout was captured"},
		{"tampered system state", func(_ *fakeSystem, p *memProvider, _ *layout.Manifest) { p.files["snapshots/snap-1/system-state/services/systemd.txt"] = []byte("evil") }, "services/systemd.txt"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			sys := newFakeSystem(dir, 100*GiB)
			lay := testLayout()
			p := seedSnapshot(t, "snap-1", lay)
			tt.mutate(sys, p, lay)
			lb, _ := json.Marshal(lay)
			if _, ok := p.files["snapshots/snap-1/layout.json"]; ok {
				p.files["snapshots/snap-1/layout.json"] = lb
			}
			res, err := Run(context.Background(), Options{SnapshotID: "snap-1", Provider: p, Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}, Identity: IdentityNew, StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), System: sys})
			if err == nil {
				t.Fatalf("expected refusal, got %+v", res)
			}
			if res == nil || res.Status != "refused" || !strings.Contains(res.Refusal, tt.want) || res.PhaseReached != PhasePreflight {
				t.Fatalf("res = %+v err=%v", res, err)
			}
			if sys.has("sgdisk") || sys.has("mkfs") {
				t.Fatalf("refusal must not write: %s", sys.dump())
			}
		})
	}
}

func TestRun_FullLinuxFlowOnFakeSystem(t *testing.T) {
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	p := seedSnapshot(t, "snap-1", testLayout())
	staging := filepath.Join(dir, "mnt")
	var phases []Phase
	res, err := Run(context.Background(), Options{
		SnapshotID: "snap-1", Provider: p, Target: Target{Kind: TargetImage, Path: filepath.Join(dir, "t.img"), ImageSizeBytes: 100 * GiB},
		Identity: IdentityOriginal, Marker: &Marker{RecoveryID: "rec-1", Nonce: "n-1"}, StateDir: dir, StagingRoot: staging, System: sys,
		Progress: func(ph Phase, _ string, _, _ int64) { if len(phases) == 0 || phases[len(phases)-1] != ph { phases = append(phases, ph) } },
	})
	if err != nil {
		t.Fatalf("err=%v\n%s", err, sys.dump())
	}
	if res.Status != "completed" || res.PhaseReached != PhaseValidate || len(res.Phases) != 7 {
		t.Fatalf("res = %+v\n%s", res, sys.dump())
	}
	// Provision: zap, three partitions with type GUIDs + partition GUIDs, rescan, formats with UUIDs.
	for _, want := range []string{
		"sgdisk --zap-all /dev/loop7",
		"sgdisk --new=1:2048:", "--typecode=1:" + layout.GUIDEFISystem, "--partition-guid=1:1111-aaaa",
		"sgdisk --new=3:",
		"partprobe /dev/loop7",
		"mkfs.vfat -F 32 -i ABCD1234 /dev/loop7p1",
		"mkfs.ext4 -F -q -U boot-uuid /dev/loop7p2",
		"mkfs.ext4 -F -q -U 9f7a-root -L rootfs /dev/loop7p3",
	} {
		if !sys.has(want) && !strings.Contains(strings.Join(sys.cmds, "\n"), want) {
			t.Errorf("missing command containing %q\n%s", want, sys.dump())
		}
	}
	if sys.indexOf("sgdisk --zap-all") < 0 || sys.indexOf("mkfs.ext4 -F -q -U 9f7a-root") < sys.indexOf("partprobe") {
		t.Errorf("format must follow rescan\n%s", sys.dump())
	}
	// Mount order: root, then /boot, then /boot/efi.
	if len(sys.mountLog) < 3 || !strings.HasSuffix(sys.mountLog[0], " "+staging) || !strings.HasSuffix(sys.mountLog[1], filepath.Join(staging, "boot")) || !strings.HasSuffix(sys.mountLog[2], filepath.Join(staging, "boot", "efi")) {
		t.Errorf("mount order = %v", sys.mountLog)
	}
	// Restore landed under the staging root, including the symlink.
	if b, err := os.ReadFile(filepath.Join(staging, "etc", "hostname")); err != nil || string(b) != "srv-1\n" {
		t.Errorf("hostname = %q err=%v", b, err)
	}
	if got, err := os.Readlink(filepath.Join(staging, "bin")); err != nil || got != "usr/bin" {
		t.Errorf("symlink = %q err=%v", got, err)
	}
	// System state applied offline.
	if !sys.has("systemctl --root=" + staging + " enable ssh.service") {
		t.Errorf("services not enabled offline\n%s", sys.dump())
	}
	// Boot: bind mounts, grub-install in chroot with the EFI target, config regen, initramfs.
	for _, want := range []string{
		"mount --bind /dev " + filepath.Join(staging, "dev"),
		"mount --bind /proc " + filepath.Join(staging, "proc"),
		"mount --bind /sys " + filepath.Join(staging, "sys"),
		"chroot " + staging + " grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=ubuntu --recheck --no-nvram --force-extra-removable",
		"chroot " + staging + " update-grub",
		"chroot " + staging + " update-initramfs -u -k all",
	} {
		if !sys.has(want) {
			t.Errorf("missing %q\n%s", want, sys.dump())
		}
	}
	// Identity original: marker written, machine-id untouched.
	var marker map[string]string
	mb, err := os.ReadFile(filepath.Join(staging, "var", "lib", "breeze", "recovery-marker.json"))
	if err != nil || json.Unmarshal(mb, &marker) != nil || marker["recoveryId"] != "rec-1" || marker["nonce"] != "n-1" || marker["snapshotId"] != "snap-1" {
		t.Errorf("marker = %s err=%v", mb, err)
	}
	if b, _ := os.ReadFile(filepath.Join(staging, "etc", "machine-id")); !strings.HasPrefix(string(b), "0123456789abcdef") {
		t.Errorf("machine-id changed on original identity: %q", b)
	}
	// Validate: sync, unmounts in reverse order, loop detached, no warnings.
	if !sys.has("sync") || len(sys.unmounts) < 3 || sys.unmounts[0] != filepath.Join(staging, "boot", "efi") || !sys.has("losetup -d /dev/loop7") {
		t.Errorf("teardown = unmounts %v\n%s", sys.unmounts, sys.dump())
	}
	if res.FilesRestored < 11 || len(res.Warnings) != 0 {
		t.Errorf("files=%d warnings=%v", res.FilesRestored, res.Warnings)
	}
	if strings.Join(phaseNames(phases), ",") != "preflight,provision,restore,boot,identity,encryption,validate" {
		t.Errorf("progress phases = %v", phases)
	}
}

func phaseNames(ps []Phase) []string {
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = string(p)
	}
	return out
}

func TestRun_ResumeSkipsProvisionAndReusesPlan(t *testing.T) {
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	sys.fail["chroot"] = os.ErrPermission // first run dies in boot
	p := seedSnapshot(t, "snap-1", testLayout())
	opts := Options{SnapshotID: "snap-1", Provider: p, Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}, Identity: IdentityNew, StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), System: sys}
	res, err := Run(context.Background(), opts)
	if err == nil || res.Status != "failed" || res.PhaseReached != PhaseBoot {
		t.Fatalf("first run = %+v err=%v", res, err)
	}
	sys2 := newFakeSystem(dir, 100*GiB)
	opts.System = sys2
	res2, err := Run(context.Background(), opts)
	if err != nil || res2.Status != "completed" || !res2.Resumed {
		t.Fatalf("second run = %+v err=%v\n%s", res2, err, sys2.dump())
	}
	if sys2.has("sgdisk") || sys2.has("mkfs") {
		t.Fatalf("resume re-provisioned the disk\n%s", sys2.dump())
	}
	if res2.Phases[1].Status != PhaseSkipped || res2.Phases[2].Status != PhaseSkipped {
		t.Errorf("phases = %+v", res2.Phases)
	}
	// State file is removed after success.
	if m, _ := filepath.Glob(filepath.Join(dir, "rebuild-snap-1-*.json")); len(m) != 0 {
		t.Errorf("state file left behind: %v", m)
	}
}

func TestRun_StrictRestoreFailsOnMissingObject(t *testing.T) {
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	p := seedSnapshot(t, "snap-1", testLayout())
	delete(p.files, "snapshots/snap-1/files/path_0/usr/bin/tool")
	res, err := Run(context.Background(), Options{SnapshotID: "snap-1", Provider: p, Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}, Identity: IdentityNew, StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), System: sys})
	if err == nil || res.Status != "failed" || res.PhaseReached != PhaseRestore || !strings.Contains(res.Error, "/usr/bin/tool") {
		t.Fatalf("res = %+v err=%v", res, err)
	}
}
```

- [ ] **Step 2: Run to verify failure** — `cd agent && go test ./internal/backup/rebuild/ 2>&1 | head -3` — expected: `undefined: Run`.

- [ ] **Step 3: Implement `engine.go`**

```go
package rebuild

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type runState struct {
	SnapshotID string          `json:"snapshotId"`
	TargetKey  string          `json:"targetKey"`
	Plan       *Plan           `json:"plan"`
	Disk       string          `json:"disk,omitempty"` // attached device (disk targets); images re-attach on resume
	Completed  map[Phase]bool  `json:"completed"`
	UpdatedAt  time.Time       `json:"updatedAt"`
}

type run struct {
	opts         Options
	sys          System
	result       *Result
	state        *runState
	statePath    string
	disk         string       // block device under provisioning (/dev/sdb or /dev/loopN)
	detach       func() error // image targets
	staging      string
	mounts       []string     // mounted dirs in mount order
	stateStaging string       // downloaded system-state artifacts
	layout       *layout.Manifest
	manifest     *backup.Snapshot
	warnings     []string
}

func targetKey(t Target) string {
	h := sha256.Sum256([]byte(string(t.Kind) + ":" + t.Path))
	return hex.EncodeToString(h[:])[:12]
}

// Run executes the seven phases. It returns (result, nil) on success and
// (result, err) on refusal or failure — result is never nil once options
// validate.
func Run(ctx context.Context, opts Options) (*Result, error) {
	start := time.Now()
	if opts.SnapshotID == "" || opts.Provider == nil {
		return nil, errors.New("rebuild: snapshot id and provider are required")
	}
	if opts.Target.Kind != TargetDisk && opts.Target.Kind != TargetImage {
		return nil, fmt.Errorf("rebuild: unknown target kind %q", opts.Target.Kind)
	}
	if opts.Identity == "" {
		opts.Identity = IdentityOriginal
	}
	if opts.StateDir == "" {
		opts.StateDir = "/var/lib/breeze/rebuild"
	}
	if opts.StagingRoot == "" {
		opts.StagingRoot = filepath.Join(opts.StateDir, "mnt", opts.SnapshotID)
	}
	if opts.System == nil {
		opts.System = NewSystem()
		if opts.System == nil {
			return nil, ErrUnsupportedHost
		}
	}
	if !opts.RegenerateInitramfs && !opts.SkipBoot {
		// zero value means "not set" for CLI callers; the flag sets it explicitly.
		opts.RegenerateInitramfs = true
	}
	r := &run{opts: opts, sys: opts.System, staging: opts.StagingRoot,
		result: &Result{SnapshotID: opts.SnapshotID, Target: opts.Target, Identity: opts.Identity, Status: "failed"}}
	r.statePath = filepath.Join(opts.StateDir, fmt.Sprintf("rebuild-%s-%s.json", opts.SnapshotID, targetKey(opts.Target)))
	if opts.ForceReprovision {
		_ = os.Remove(r.statePath)
	}
	r.loadState()
	defer r.teardown()

	type phaseFn struct {
		phase Phase
		fn    func(context.Context, *run) error
	}
	phases := []phaseFn{
		{PhasePreflight, preflight}, {PhaseProvision, provision}, {PhaseRestore, restoreTree},
		{PhaseBoot, boot}, {PhaseIdentity, identity}, {PhaseEncryption, encryption}, {PhaseValidate, validate},
	}
	for _, p := range phases {
		r.result.PhaseReached = p.phase
		pr := PhaseResult{Phase: p.phase, StartedAt: time.Now().UTC()}
		if r.state.Completed[p.phase] && p.phase != PhasePreflight && p.phase != PhaseValidate {
			pr.Status, pr.Message, pr.CompletedAt = PhaseSkipped, "already completed by an earlier run", time.Now().UTC()
			r.result.Phases = append(r.result.Phases, pr)
			r.result.Resumed = true
			if p.phase == PhaseProvision || p.phase == PhaseRestore {
				if err := r.reattach(ctx); err != nil { // mounts the already-provisioned partitions
					return r.fail(start, pr, err)
				}
			}
			continue
		}
		r.progress(p.phase, "starting", 0, 0)
		err := p.fn(ctx, r)
		pr.CompletedAt = time.Now().UTC()
		if err != nil {
			var ref *RefusalError
			if errors.As(err, &ref) {
				pr.Status, pr.Message = PhaseRefused, ref.Reason
				r.result.Phases = append(r.result.Phases, pr)
				r.result.Status, r.result.Refusal = "refused", ref.Reason
				r.result.DurationMs = time.Since(start).Milliseconds()
				return r.result, err
			}
			return r.fail(start, pr, err)
		}
		pr.Status = PhaseCompleted
		r.result.Phases = append(r.result.Phases, pr)
		r.state.Completed[p.phase] = true
		if p.phase != PhasePreflight {
			r.saveState()
		}
		if opts.DryRun && p.phase == PhasePreflight {
			break
		}
	}
	r.result.Status = "completed"
	r.result.Warnings = r.warnings
	r.result.DurationMs = time.Since(start).Milliseconds()
	if !opts.DryRun {
		_ = os.Remove(r.statePath)
	}
	return r.result, nil
}

func (r *run) fail(start time.Time, pr PhaseResult, err error) (*Result, error) {
	pr.Status, pr.Message, pr.CompletedAt = PhaseFailed, err.Error(), time.Now().UTC()
	r.result.Phases = append(r.result.Phases, pr)
	r.result.Status, r.result.Error = "failed", err.Error()
	r.result.Warnings = r.warnings
	r.result.DurationMs = time.Since(start).Milliseconds()
	r.saveState() // keeps completed phases for resume
	return r.result, err
}

func (r *run) progress(ph Phase, msg string, cur, total int64) {
	if r.opts.Progress != nil {
		r.opts.Progress(ph, msg, cur, total)
	}
}

func (r *run) warn(format string, args ...any) { r.warnings = append(r.warnings, fmt.Sprintf(format, args...)) }

func (r *run) loadState() {
	r.state = &runState{SnapshotID: r.opts.SnapshotID, TargetKey: targetKey(r.opts.Target), Completed: map[Phase]bool{}}
	data, err := os.ReadFile(r.statePath)
	if err != nil {
		return
	}
	var s runState
	if json.Unmarshal(data, &s) == nil && s.SnapshotID == r.opts.SnapshotID && s.TargetKey == r.state.TargetKey && s.Plan != nil {
		if s.Completed == nil {
			s.Completed = map[Phase]bool{}
		}
		r.state = &s
		r.result.Plan = s.Plan
	}
}

func (r *run) saveState() {
	r.state.UpdatedAt = time.Now().UTC()
	r.state.Plan = r.result.Plan
	if err := os.MkdirAll(filepath.Dir(r.statePath), 0o700); err != nil {
		return
	}
	data, _ := json.MarshalIndent(r.state, "", "  ")
	tmp := r.statePath + ".tmp"
	if os.WriteFile(tmp, data, 0o600) == nil {
		_ = os.Rename(tmp, r.statePath)
	}
}

// teardown unmounts in reverse order, detaches the loop device, and removes
// the system-state staging dir. Errors are warnings: the result already
// carries the outcome.
func (r *run) teardown() {
	ctx := context.Background()
	for i := len(r.mounts) - 1; i >= 0; i-- {
		if err := r.sys.Unmount(ctx, r.mounts[i]); err != nil {
			r.warn("unmount %s: %v", r.mounts[i], err)
		}
	}
	r.mounts = nil
	if r.detach != nil {
		if err := r.detach(); err != nil {
			r.warn("detach image: %v", err)
		}
		r.detach = nil
	}
	if r.stateStaging != "" {
		_ = os.RemoveAll(r.stateStaging)
	}
}
```

- [ ] **Step 4: Implement `fetch.go` and `preflight.go`**

```go
// fetch.go
package rebuild

func fetchLayout(ctx context.Context, provider providers.BackupProvider, snapshotID string) (*layout.Manifest, error) {
	tmp, err := os.CreateTemp("", "breeze-layout-*.json")
	if err != nil {
		return nil, err
	}
	tmpPath := tmp.Name()
	tmp.Close()
	defer os.Remove(tmpPath)
	if err := provider.Download(path.Join("snapshots", snapshotID, "layout.json"), tmpPath); err != nil {
		return nil, &RefusalError{Reason: layout.ReasonNilManifest + " for snapshot " + snapshotID + " (was the backup taken with the whole-machine profile?)"}
	}
	data, err := os.ReadFile(tmpPath)
	if err != nil {
		return nil, err
	}
	var m layout.Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("decode layout.json: %w", err)
	}
	if m.SchemaVersion != layout.SchemaVersion {
		return nil, &RefusalError{Reason: fmt.Sprintf("layout schema version %d is not supported by this helper (supports %d)", m.SchemaVersion, layout.SchemaVersion)}
	}
	return &m, nil
}

func fetchManifest(ctx context.Context, provider providers.BackupProvider, snapshotID string) (*backup.Snapshot, error) // same pattern for snapshots/<id>/manifest.json; a missing manifest is a RefusalError "snapshot manifest not found"
```

`preflight.go`:

```go
func preflight(ctx context.Context, r *run) error {
	// 1. Layout + guard.
	lay := r.opts.Layout
	if lay == nil {
		var err error
		if lay, err = fetchLayout(ctx, r.opts.Provider, r.opts.SnapshotID); err != nil {
			return err
		}
	} else if lay.SchemaVersion != layout.SchemaVersion {
		return &RefusalError{Reason: fmt.Sprintf("layout schema version %d is not supported by this helper (supports %d)", lay.SchemaVersion, layout.SchemaVersion)}
	}
	if v := layout.Assess(lay); !v.Restorable {
		return &RefusalError{Reason: "layout is not bare-metal restorable: " + strings.Join(v.Reasons, "; ")}
	}
	if lay.Platform != "linux" {
		return &RefusalError{Reason: fmt.Sprintf("snapshot platform %q cannot be rebuilt by the Linux engine", lay.Platform)}
	}
	r.layout = lay
	src := lay.SystemDisk()

	// 2. Target sizing and safety. Nothing below writes.
	var targetSize int64
	switch r.opts.Target.Kind {
	case TargetDisk:
		mounted, err := r.sys.MountedSources()
		if err != nil {
			return err
		}
		for _, m := range mounted {
			if m == r.opts.Target.Path || strings.HasPrefix(m, r.opts.Target.Path) {
				return &RefusalError{Reason: fmt.Sprintf("target disk %s is in use (%s is mounted)", r.opts.Target.Path, m)}
			}
		}
		roots, _ := r.sys.RootSources()
		for _, m := range roots {
			if m == r.opts.Target.Path || strings.HasPrefix(m, r.opts.Target.Path) {
				return &RefusalError{Reason: fmt.Sprintf("target disk %s backs the running system (%s)", r.opts.Target.Path, m)}
			}
		}
		size, err := r.sys.BlockDeviceSize(r.opts.Target.Path)
		if err != nil {
			return err
		}
		targetSize = size
	case TargetImage:
		targetSize = r.opts.Target.ImageSizeBytes
		if fi, err := os.Stat(r.opts.Target.Path); err == nil {
			targetSize = fi.Size()
		}
		if targetSize <= 0 {
			return &RefusalError{Reason: "image target needs a size (--image-size) when the file does not exist"}
		}
	}
	sector := src.SectorSize
	if sector == 0 {
		sector = 512
	}
	plan, err := PlanPartitions(src, targetSize, sector)
	if err != nil {
		return err
	}
	plan.TargetPath = r.opts.Target.Path
	r.result.Plan = plan
	r.progress(PhasePreflight, "plan ready", 1, 3)

	// 3. Verify what we will restore: ordinary manifest + system state (checksums).
	man, err := fetchManifest(ctx, r.opts.Provider, r.opts.SnapshotID)
	if err != nil {
		return err
	}
	r.manifest = man
	staging, err := os.MkdirTemp("", "breeze-rebuild-state-*")
	if err != nil {
		return err
	}
	r.stateStaging = staging
	if _, warnings, err := bmr.DownloadSystemState(ctx, r.opts.Provider, r.opts.SnapshotID, false, staging); err != nil {
		if errors.Is(err, bmr.ErrNoSystemState) {
			r.warn("snapshot has no system state; only files will be restored")
		} else {
			return &RefusalError{Reason: "system state verification failed: " + err.Error()}
		}
	} else {
		r.warnings = append(r.warnings, warnings...)
	}
	r.progress(PhasePreflight, "verified", 3, 3)
	return nil
}
```

- [ ] **Step 5: Implement `provision.go`**

```go
func provision(ctx context.Context, r *run) error {
	if err := r.attach(ctx); err != nil {
		return err
	}
	plan := r.result.Plan
	sector := int64(plan.SectorSize)
	if out, err := r.sys.Run(ctx, "sgdisk", "--zap-all", r.disk); err != nil {
		return fmt.Errorf("sgdisk --zap-all: %s: %w", strings.TrimSpace(string(out)), err)
	}
	for _, p := range plan.Partitions {
		startSector := p.StartBytes / sector
		endSector := (p.StartBytes+p.SizeBytes)/sector - 1
		args := []string{fmt.Sprintf("--new=%d:%d:%d", p.Number, startSector, endSector)}
		if p.TypeGUID != "" {
			args = append(args, fmt.Sprintf("--typecode=%d:%s", p.Number, p.TypeGUID))
		}
		if p.PartUUID != "" {
			args = append(args, fmt.Sprintf("--partition-guid=%d:%s", p.Number, p.PartUUID))
		}
		if p.Name != "" {
			args = append(args, fmt.Sprintf("--change-name=%d:%s", p.Number, p.Name))
		}
		args = append(args, r.disk)
		if out, err := r.sys.Run(ctx, "sgdisk", args...); err != nil {
			return fmt.Errorf("sgdisk partition %d: %s: %w", p.Number, strings.TrimSpace(string(out)), err)
		}
	}
	if err := r.sys.Rescan(ctx, r.disk); err != nil {
		return err
	}
	for i, p := range plan.Partitions {
		dev := r.sys.PartitionDevice(r.disk, p.Number)
		var name string
		var args []string
		switch p.Filesystem {
		case "vfat", "fat32":
			name = "mkfs.vfat"
			args = []string{"-F", "32"}
			if id := strings.ReplaceAll(strings.ToUpper(p.FSUUID), "-", ""); len(id) == 8 {
				args = append(args, "-i", id)
			}
			if p.Label != "" {
				args = append(args, "-n", strings.ToUpper(p.Label))
			}
		case "ext4":
			name = "mkfs.ext4"
			args = []string{"-F", "-q"}
			if p.FSUUID != "" {
				args = append(args, "-U", p.FSUUID)
			}
			if p.Label != "" {
				args = append(args, "-L", p.Label)
			}
		case "xfs":
			name = "mkfs.xfs"
			args = []string{"-f", "-q"}
			if p.FSUUID != "" {
				args = append(args, "-m", "uuid="+p.FSUUID)
			}
			if p.Label != "" {
				args = append(args, "-L", p.Label)
			}
		case "swap":
			name = "mkswap"
			if p.FSUUID != "" {
				args = append(args, "-U", p.FSUUID)
			}
			if p.Label != "" {
				args = append(args, "-L", p.Label)
			}
		case "":
			continue // MSR-style partitions carry no filesystem
		default:
			return fmt.Errorf("unsupported filesystem %q reached provision (preflight bug)", p.Filesystem)
		}
		args = append(args, dev)
		if out, err := r.sys.Run(ctx, name, args...); err != nil {
			return fmt.Errorf("%s %s: %s: %w", name, dev, strings.TrimSpace(string(out)), err)
		}
		r.progress(PhaseProvision, "formatted "+dev, int64(i+1), int64(len(plan.Partitions)))
	}
	return nil
}

// attach resolves r.disk: the block device itself, or the loop device for an image.
func (r *run) attach(ctx context.Context) error {
	switch r.opts.Target.Kind {
	case TargetDisk:
		r.disk = r.opts.Target.Path
	case TargetImage:
		dev, detach, err := r.sys.AttachImage(r.opts.Target.Path, r.opts.Target.ImageSizeBytes)
		if err != nil {
			return err
		}
		r.disk, r.detach = dev, detach
	}
	r.state.Disk = r.disk
	return nil
}

// reattach is used on resume: attach (images) and mount the planned
// partitions without touching the partition table or filesystems.
func (r *run) reattach(ctx context.Context) error {
	if r.disk == "" {
		if err := r.attach(ctx); err != nil {
			return err
		}
	}
	if len(r.mounts) == 0 && r.state.Completed[PhaseProvision] {
		return mountTree(ctx, r)
	}
	return nil
}
```

- [ ] **Step 6: Implement `restore_tree.go`**

```go
// mountTree mounts every planned partition with a mount point under the
// staging root, shallowest first (/ then /boot then /boot/efi).
func mountTree(ctx context.Context, r *run) error {
	parts := make([]PlannedPartition, 0, len(r.result.Plan.Partitions))
	for _, p := range r.result.Plan.Partitions {
		if p.MountPoint != "" && p.Filesystem != "swap" && p.Filesystem != "" {
			parts = append(parts, p)
		}
	}
	sort.Slice(parts, func(i, j int) bool { return strings.Count(parts[i].MountPoint, "/") < strings.Count(parts[j].MountPoint, "/") || (strings.Count(parts[i].MountPoint, "/") == strings.Count(parts[j].MountPoint, "/") && parts[i].MountPoint < parts[j].MountPoint) })
	if len(parts) == 0 || parts[0].MountPoint != "/" {
		return errors.New("plan has no root mount point")
	}
	for _, p := range parts {
		dir := filepath.Join(r.staging, filepath.FromSlash(strings.TrimPrefix(p.MountPoint, "/")))
		fstype := p.Filesystem
		if fstype == "fat32" {
			fstype = "vfat"
		}
		if err := r.sys.Mount(ctx, r.sys.PartitionDevice(r.disk, p.Number), dir, fstype); err != nil {
			return err
		}
		r.mounts = append(r.mounts, dir)
	}
	return nil
}

func restoreTree(ctx context.Context, r *run) error {
	if len(r.mounts) == 0 {
		if err := mountTree(ctx, r); err != nil {
			return err
		}
	}
	res, err := backup.RestoreFromSnapshotContext(ctx, r.opts.Provider, backup.RestoreConfig{SnapshotID: r.opts.SnapshotID, TargetPath: r.staging}, func(phase string, cur, total int64, msg string) {
		r.progress(PhaseRestore, msg, cur, total)
	})
	if err != nil {
		return fmt.Errorf("restore files: %w", err)
	}
	r.result.FilesRestored, r.result.BytesRestored = res.FilesRestored, res.BytesRestored
	r.warnings = append(r.warnings, res.Warnings...)
	if res.FilesFailed > 0 {
		msg := fmt.Sprintf("%d file(s) failed to restore: %s", res.FilesFailed, strings.Join(res.FailedFiles, ", "))
		if !r.opts.AllowPartialRestore {
			return errors.New(msg)
		}
		r.warn("%s", msg)
	}
	if r.stateStaging != "" {
		if entries, _ := os.ReadDir(r.stateStaging); len(entries) > 0 {
			warnings, err := bmr.RestoreSystemStateOffline(ctx, r.staging, r.stateStaging)
			r.warnings = append(r.warnings, warnings...)
			if err != nil {
				return fmt.Errorf("apply system state: %w", err)
			}
		}
	}
	return nil
}
```

(`RestoreFromSnapshotContext` keeps its own resume state keyed by target path, so a resumed run skips already-restored files. Note for the reviewer: `bmr.RestoreSystemStateOffline` shells `systemctl --root=…` through `bmr.runCommand`, not through `System`; the fake in the engine test therefore cannot see it — so the engine test's `systemctl` assertion must go through `bmr`'s own seam. Concretely, in `engine_test.go` swap `bmr`'s seam using an exported test hook `bmr.SetRunCommandForTest(fn) (restore func())` added in Task 3 (a one-line exported wrapper around the package var, `_test`-only callers) and assert on the recorded call there instead of on `fakeSystem`. Adjust `TestRun_FullLinuxFlowOnFakeSystem` accordingly.)

- [ ] **Step 7: Run the engine tests that can pass now**

Run: `cd agent && go test -race ./internal/backup/rebuild/ -run 'TestRun_DryRun|TestRun_PreflightRefusals|TestRun_StrictRestore' 2>&1 | tail -6` — expected: the three pass once `boot/identity/encryption/validate` exist as stubs; add temporary stubs returning `nil` in `engine.go` so the package compiles, then replace them in Task 5.

- [ ] **Step 8: Commit**

```bash
git add agent/internal/backup/rebuild/
git commit -m "feat(rebuild): Run with resumable state; preflight, provision and restore-tree phases (W03)"
```

---

### Task 5: Engine — boot, identity, encryption, validate

**Files:**
- Create: `agent/internal/backup/rebuild/boot_linux.go` (untagged logic file named for clarity — keep it untagged so the fake-system tests run on macOS; it only uses `System` and the filesystem), `agent/internal/backup/rebuild/identity.go`, `agent/internal/backup/rebuild/validate.go`
- Test: `agent/internal/backup/rebuild/identity_test.go`, plus the full-flow test from Task 4 now passing

**Interfaces:**
- Produces: `boot(ctx, r)`, `identity(ctx, r)`, `encryption(ctx, r)`, `validate(ctx, r)`, `detectBootFamily(root string) (family string, err error)` (`"debian"` when `<root>/usr/sbin/update-grub` exists, `"rhel"` when `<root>/usr/sbin/grub2-mkconfig` exists), `bootloaderID(root) string` (from `<root>/etc/os-release` `ID`, default `"linux"`), `stripEnrollment(root string) error`, `enrollmentKeys` (YAML keys removed for identity `new`).

- [ ] **Step 1: Write the failing identity test**

```go
func TestStripEnrollment_RemovesIdentityKeysKeepsServer(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "etc", "breeze")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "agent.yaml"), []byte("server_url: https://example.invalid\nagent_id: a1\ndevice_id: d1\norg_id: o1\nsite_id: s1\nauth_token: t1\nwatchdog_auth_token: w1\nhelper_auth_token: h1\nlog_level: info\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "secrets.yaml"), []byte("auth_token: t1\n"), 0o600)
	os.MkdirAll(filepath.Join(root, "etc"), 0o755)
	os.WriteFile(filepath.Join(root, "etc", "machine-id"), []byte("abc\n"), 0o644)
	os.WriteFile(filepath.Join(root, "etc", "hostname"), []byte("srv-1\n"), 0o644)

	if err := applyNewIdentity(root); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "agent.yaml"))
	for _, gone := range []string{"agent_id", "device_id", "auth_token", "watchdog_auth_token", "helper_auth_token"} {
		if strings.Contains(string(b), gone+":") {
			t.Errorf("%s still present:\n%s", gone, b)
		}
	}
	for _, kept := range []string{"server_url: https://example.invalid", "log_level: info"} {
		if !strings.Contains(string(b), kept) {
			t.Errorf("%s lost:\n%s", kept, b)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "secrets.yaml")); !os.IsNotExist(err) {
		t.Error("secrets.yaml must be removed")
	}
	if mid, _ := os.ReadFile(filepath.Join(root, "etc", "machine-id")); len(strings.TrimSpace(string(mid))) != 0 {
		t.Errorf("machine-id = %q, want empty (systemd regenerates on first boot)", mid)
	}
	if hn, _ := os.ReadFile(filepath.Join(root, "etc", "hostname")); string(hn) != "srv-1-restored\n" {
		t.Errorf("hostname = %q", hn)
	}
}
```

Confirm the YAML key names against `agent/internal/config/config.go` (`mapstructure`/`yaml` tags of `AgentID, DeviceID, OrgID, SiteID, AuthToken, WatchdogAuthToken, HelperAuthToken`) and put them in `enrollmentKeys`; keep `org_id`/`site_id` (they let the fresh enrollment land in the same org/site) — the test above only asserts the five identity/secret keys.

- [ ] **Step 2: Run to verify failure** — `cd agent && go test ./internal/backup/rebuild/ -run TestStripEnrollment 2>&1 | head -3`.

- [ ] **Step 3: Implement `boot_linux.go`**

```go
package rebuild

func detectBootFamily(root string) (string, error) {
	if _, err := os.Stat(filepath.Join(root, "usr", "sbin", "update-grub")); err == nil {
		return "debian", nil
	}
	if _, err := os.Stat(filepath.Join(root, "usr", "sbin", "grub2-mkconfig")); err == nil {
		return "rhel", nil
	}
	return "", errors.New("restored tree has neither update-grub (Debian family) nor grub2-mkconfig (RHEL family)")
}

func bootloaderID(root string) string {
	data, err := os.ReadFile(filepath.Join(root, "etc", "os-release"))
	if err != nil {
		return "linux"
	}
	for _, line := range strings.Split(string(data), "\n") {
		if k, v, ok := strings.Cut(line, "="); ok && k == "ID" {
			if id := strings.Trim(v, `"'`); id != "" {
				return id
			}
		}
	}
	return "linux"
}

func grubTarget(arch string) (target, efiFile string) {
	if arch == "arm64" {
		return "arm64-efi", "BOOTAA64.EFI"
	}
	return "x86_64-efi", "BOOTX64.EFI"
}

var pseudoMounts = []string{"/dev", "/dev/pts", "/proc", "/sys", "/run"}

func boot(ctx context.Context, r *run) error {
	if r.opts.SkipBoot {
		r.warn("boot phase skipped by request (SkipBoot)")
		return nil
	}
	family, err := detectBootFamily(r.staging)
	if err != nil {
		return err
	}
	for _, m := range pseudoMounts {
		dir := filepath.Join(r.staging, filepath.FromSlash(strings.TrimPrefix(m, "/")))
		if err := r.sys.BindMount(ctx, m, dir); err != nil {
			return err
		}
		r.mounts = append(r.mounts, dir)
	}
	efivars := "/sys/firmware/efi/efivars"
	haveNVRAM := false
	if fi, err := os.Stat(efivars); err == nil && fi.IsDir() && r.opts.Target.Kind == TargetDisk {
		if err := r.sys.BindMount(ctx, efivars, filepath.Join(r.staging, "sys", "firmware", "efi", "efivars")); err == nil {
			r.mounts = append(r.mounts, filepath.Join(r.staging, "sys", "firmware", "efi", "efivars"))
			haveNVRAM = true
		}
	}
	inRoot := r.sys.Chroot(r.staging)
	target, efiFile := grubTarget(r.sys.Arch())
	id := bootloaderID(r.staging)
	switch family {
	case "debian":
		args := []string{"--target=" + target, "--efi-directory=/boot/efi", "--bootloader-id=" + id, "--recheck"}
		if !haveNVRAM {
			args = append(args, "--no-nvram")
		}
		args = append(args, "--force-extra-removable")
		if out, err := inRoot(ctx, "grub-install", args...); err != nil {
			// Older grub without the Debian-only flag: retry without it and ensure the fallback path by hand.
			if strings.Contains(string(out), "unrecognized option") || strings.Contains(string(out), "force-extra-removable") {
				if out2, err2 := inRoot(ctx, "grub-install", args[:len(args)-1]...); err2 != nil {
					return fmt.Errorf("grub-install: %s: %w", strings.TrimSpace(string(out2)), err2)
				}
			} else {
				return fmt.Errorf("grub-install: %s: %w", strings.TrimSpace(string(out)), err)
			}
		}
		if out, err := inRoot(ctx, "update-grub"); err != nil {
			return fmt.Errorf("update-grub: %s: %w", strings.TrimSpace(string(out)), err)
		}
		if r.opts.RegenerateInitramfs {
			if out, err := inRoot(ctx, "update-initramfs", "-u", "-k", "all"); err != nil {
				r.warn("update-initramfs failed (the restored initramfs is kept): %s", strings.TrimSpace(string(out)))
			}
		}
	case "rhel":
		cfg := "/boot/grub2/grub.cfg"
		if _, err := os.Stat(filepath.Join(r.staging, "boot", "efi", "EFI", id, "grub.cfg")); err == nil {
			if _, err := os.Stat(filepath.Join(r.staging, "boot", "grub2", "grub.cfg")); err != nil {
				cfg = "/boot/efi/EFI/" + id + "/grub.cfg"
			}
		}
		if out, err := inRoot(ctx, "grub2-mkconfig", "-o", cfg); err != nil {
			return fmt.Errorf("grub2-mkconfig: %s: %w", strings.TrimSpace(string(out)), err)
		}
		if r.opts.RegenerateInitramfs {
			if out, err := inRoot(ctx, "dracut", "--regenerate-all", "--force"); err != nil {
				r.warn("dracut failed (the restored initramfs is kept): %s", strings.TrimSpace(string(out)))
			}
		}
		if haveNVRAM {
			efiNum := 0
			for _, p := range r.result.Plan.Partitions {
				if p.Role == layout.RoleEFI {
					efiNum = p.Number
				}
			}
			loader := `\EFI\` + id + `\shimx64.efi`
			if r.sys.Arch() == "arm64" {
				loader = `\EFI\` + id + `\shimaa64.efi`
			}
			if out, err := r.sys.Run(ctx, "efibootmgr", "--create", "--disk", r.disk, "--part", strconv.Itoa(efiNum), "--label", id, "--loader", loader); err != nil {
				r.warn("efibootmgr entry not created (firmware fallback path will be used): %s", strings.TrimSpace(string(out)))
			}
		}
	}
	// Fallback boot path: firmware with empty NVRAM (fresh VM, replaced board)
	// boots EFI/BOOT/BOOT<ARCH>.EFI. Ensure it exists.
	efiBoot := filepath.Join(r.staging, "boot", "efi", "EFI", "BOOT")
	if _, err := os.Stat(filepath.Join(efiBoot, efiFile)); err != nil {
		distroDir := filepath.Join(r.staging, "boot", "efi", "EFI", id)
		for _, cand := range []string{"shimx64.efi", "shimaa64.efi", "grubx64.efi", "grubaa64.efi"} {
			if src := filepath.Join(distroDir, cand); fileExists(src) {
				if err := copyFile(src, filepath.Join(efiBoot, efiFile)); err != nil {
					return fmt.Errorf("install fallback bootloader: %w", err)
				}
				if strings.HasPrefix(cand, "shim") {
					grub := strings.Replace(cand, "shim", "grub", 1)
					_ = copyFile(filepath.Join(distroDir, grub), filepath.Join(efiBoot, grub))
				}
				break
			}
		}
	}
	if !fileExists(filepath.Join(efiBoot, efiFile)) {
		return fmt.Errorf("no fallback bootloader at EFI/BOOT/%s after install", efiFile)
	}
	return nil
}
```

Add `fileExists(p string) bool` and `copyFile(src, dst string) error` (creates parent dir, 0644) helpers.

- [ ] **Step 4: Implement `identity.go`**

```go
package rebuild

var enrollmentKeys = []string{"agent_id", "device_id", "auth_token", "watchdog_auth_token", "helper_auth_token"}

func identity(ctx context.Context, r *run) error {
	switch r.opts.Identity {
	case IdentityOriginal:
		if r.opts.Marker == nil {
			r.warn("no recovery marker given; the server will not auto-complete this recovery")
			return nil
		}
		dir := filepath.Join(r.staging, "var", "lib", "breeze")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
		data, _ := json.MarshalIndent(map[string]string{
			"recoveryId": r.opts.Marker.RecoveryID, "nonce": r.opts.Marker.Nonce,
			"snapshotId": r.opts.SnapshotID, "completedAt": time.Now().UTC().Format(time.RFC3339),
		}, "", "  ")
		return os.WriteFile(filepath.Join(dir, "recovery-marker.json"), data, 0o600)
	case IdentityNew:
		return applyNewIdentity(r.staging)
	default:
		return fmt.Errorf("unknown identity mode %q", r.opts.Identity)
	}
}

// applyNewIdentity makes the tree boot as a fresh machine: empty machine-id
// (systemd regenerates it), "-restored" hostname, no enrollment or secrets.
func applyNewIdentity(root string) error {
	_ = os.WriteFile(filepath.Join(root, "etc", "machine-id"), []byte{}, 0o644)
	_ = os.Remove(filepath.Join(root, "var", "lib", "dbus", "machine-id"))
	if hn, err := os.ReadFile(filepath.Join(root, "etc", "hostname")); err == nil {
		name := strings.TrimSpace(string(hn))
		if name != "" && !strings.HasSuffix(name, "-restored") {
			_ = os.WriteFile(filepath.Join(root, "etc", "hostname"), []byte(name+"-restored\n"), 0o644)
		}
	}
	_ = os.Remove(filepath.Join(root, "etc", "breeze", "secrets.yaml"))
	return stripEnrollment(filepath.Join(root, "etc", "breeze", "agent.yaml"))
}

func stripEnrollment(agentYAML string) error {
	data, err := os.ReadFile(agentYAML)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var doc map[string]any
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return fmt.Errorf("parse %s: %w", agentYAML, err)
	}
	for _, k := range enrollmentKeys {
		delete(doc, k)
	}
	out, err := yaml.Marshal(doc)
	if err != nil {
		return err
	}
	return os.WriteFile(agentYAML, out, 0o644)
}

func encryption(_ context.Context, r *run) error {
	// LUKS sources are refused at preflight (W01 guard); BitLocker is the
	// Windows engine's job (W06). Recorded so every platform reports 7 phases.
	return nil
}
```

(`yaml` = `gopkg.in/yaml.v3`, already in `agent/go.mod`.)

- [ ] **Step 5: Implement `validate.go`**

```go
package rebuild

const validateSampleSize = 64

func validate(ctx context.Context, r *run) error {
	// 1. Sample checksums of restored files.
	var withSum []backup.SnapshotFile
	for _, f := range r.manifest.Files {
		if f.HasContent() && f.Checksum != "" {
			withSum = append(withSum, f)
		}
	}
	step := 1
	if len(withSum) > validateSampleSize {
		step = len(withSum) / validateSampleSize
	}
	checked, mismatched := 0, []string{}
	for i := 0; i < len(withSum); i += step {
		f := withSum[i]
		target := filepath.Join(r.staging, filepath.FromSlash(strings.TrimPrefix(f.SourcePath, "/")))
		sum, err := sha256File(target)
		if err != nil || sum != f.Checksum {
			mismatched = append(mismatched, f.SourcePath)
		}
		checked++
	}
	if len(mismatched) > 0 {
		return fmt.Errorf("%d of %d sampled files differ from the snapshot: %s", len(mismatched), checked, strings.Join(mismatched, ", "))
	}
	// 2. Boot artefacts.
	if !r.opts.SkipBoot {
		_, efiFile := grubTarget(r.sys.Arch())
		if !fileExists(filepath.Join(r.staging, "boot", "efi", "EFI", "BOOT", efiFile)) {
			return fmt.Errorf("EFI/BOOT/%s missing after boot phase", efiFile)
		}
		if !fileExists(filepath.Join(r.staging, "boot", "grub", "grub.cfg")) && !fileExists(filepath.Join(r.staging, "boot", "grub2", "grub.cfg")) && !fileExists(filepath.Join(r.staging, "boot", "efi", "EFI", bootloaderID(r.staging), "grub.cfg")) {
			return errors.New("no grub.cfg found in the restored tree")
		}
	}
	// 3. fstab UUIDs resolve to planned partitions.
	if fstab, err := os.ReadFile(filepath.Join(r.staging, "etc", "fstab")); err == nil {
		known := map[string]bool{}
		for _, p := range r.result.Plan.Partitions {
			known[strings.ToLower(p.FSUUID)] = true
		}
		for _, line := range strings.Split(string(fstab), "\n") {
			f := strings.Fields(line)
			if len(f) == 0 || strings.HasPrefix(f[0], "#") {
				continue
			}
			if u, ok := strings.CutPrefix(f[0], "UUID="); ok && !known[strings.ToLower(u)] {
				r.warn("fstab references UUID %s which is not on the rebuilt disk (%s)", u, line)
			}
		}
	}
	// 4. Flush and release.
	if err := r.sys.Sync(ctx); err != nil {
		return err
	}
	r.teardown()
	return nil
}
```

(`sha256File` — copy the 12-line helper from `backup/snapshot.go:26` or export it there as `backup.SHA256File`; exporting is preferred so the two never drift.)

- [ ] **Step 6: Run the full package**

Run: `cd agent && go test -race ./internal/backup/rebuild/ 2>&1 | tail -8`
Expected: all tests pass, including `TestRun_FullLinuxFlowOnFakeSystem` and `TestRun_ResumeSkipsProvisionAndReusesPlan`. Then `GOOS=linux go vet ./internal/backup/rebuild/ && GOOS=windows go vet ./internal/backup/rebuild/ && GOOS=darwin go vet ./internal/backup/rebuild/`.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/backup/rebuild/ agent/internal/backup/snapshot.go
git commit -m "feat(rebuild): boot (GRUB/EFI + fallback path), identity (marker / fresh), validate phases (W03)"
```

---

### Task 6: `breeze-backup rebuild` CLI + root-gated loopback test

**Files:**
- Create: `agent/cmd/breeze-backup/rebuild_cmd.go`, `agent/cmd/breeze-backup/rebuild_cmd_test.go`
- Create: `agent/internal/backup/rebuild/loopback_linux_test.go` (`//go:build linux`)
- Modify: `agent/cmd/breeze-backup/bmr_recover_cmd.go:35` (register the command next to `newBMRRecoverCommand`)

**Interfaces:**
- CLI: `breeze-backup rebuild --snapshot <id> --target disk:/dev/sdb|image:/path.img [--image-size 40G] --provider-config <file.json> --identity original|new [--marker-file <json>] [--result-json <path>] [--dry-run] [--force-reprovision] [--allow-partial] [--no-initramfs] [--skip-boot] [--state-dir <dir>]`. `--provider-config` is a JSON file `{"provider":"s3","providerConfig":{...}}` in the same shape the backup command payload carries; built through the same code path `exec_backup.go` uses for a restore command (`restoreProviderForCommand`), with no vault. W04 adds `--token/--server` (bootstrap-driven provider) on top of this command.

- [ ] **Step 1: Write the failing CLI tests**

```go
func TestParseTargetFlag(t *testing.T) {
	for _, tt := range []struct{ in, size string; want rebuild.Target; wantErr bool }{
		{"disk:/dev/sdb", "", rebuild.Target{Kind: rebuild.TargetDisk, Path: "/dev/sdb"}, false},
		{"image:/tmp/x.img", "40G", rebuild.Target{Kind: rebuild.TargetImage, Path: "/tmp/x.img", ImageSizeBytes: 40 << 30}, false},
		{"image:/tmp/x.img", "512M", rebuild.Target{Kind: rebuild.TargetImage, Path: "/tmp/x.img", ImageSizeBytes: 512 << 20}, false},
		{"/dev/sdb", "", rebuild.Target{}, true},
		{"vhdx:/x", "", rebuild.Target{}, true},
		{"image:/tmp/x.img", "lots", rebuild.Target{}, true},
	} {
		got, err := parseTargetFlag(tt.in, tt.size)
		if (err != nil) != tt.wantErr || got != tt.want {
			t.Errorf("%s/%s = %+v err=%v", tt.in, tt.size, got, err)
		}
	}
}

func TestRebuildCommand_DryRunWritesResultJSON(t *testing.T) {
	dir := t.TempDir()
	provFile := filepath.Join(dir, "prov.json")
	os.WriteFile(provFile, []byte(`{"provider":"local","providerConfig":{"path":"`+filepath.Join(dir, "store")+`"}}`), 0o600)
	// Seed a local-provider store with layout.json + manifest via the rebuild test helpers is package-private;
	// here assert only the wiring: an unknown snapshot must yield a refused result file, exit non-zero.
	out := filepath.Join(dir, "result.json")
	cmd := newRebuildCommand()
	cmd.SetArgs([]string{"--snapshot", "nope", "--target", "image:" + filepath.Join(dir, "t.img"), "--image-size", "1G", "--provider-config", provFile, "--identity", "new", "--dry-run", "--result-json", out, "--state-dir", dir})
	err := cmd.Execute()
	if err == nil {
		t.Fatal("expected error for missing snapshot")
	}
	b, rerr := os.ReadFile(out)
	if rerr != nil {
		t.Fatalf("result file missing: %v", rerr)
	}
	var res rebuild.Result
	if json.Unmarshal(b, &res) != nil || res.Status != "refused" || !strings.Contains(res.Refusal, "no disk layout was captured") {
		t.Fatalf("result = %s", b)
	}
}
```

(This test needs `NewSystem()` to be non-nil, so on macOS it must skip: `if runtime.GOOS != "linux" { t.Skip("rebuild engine host is Linux-only") }`. The refusal happens before any System call, so alternatively inject a no-op `System` through an unexported package hook `rebuildSystemForTest`; prefer the skip — CI's `test-agent` runs on Linux.)

- [ ] **Step 2: Run to verify failure** — `cd agent && go test ./cmd/breeze-backup/ -run 'TestParseTargetFlag|TestRebuildCommand' 2>&1 | head -3`.

- [ ] **Step 3: Implement `rebuild_cmd.go`**

```go
func newRebuildCommand() *cobra.Command {
	var (
		snapshot, target, imageSize, providerConfig, identityFlag, markerFile, resultJSON, stateDir string
		dryRun, force, allowPartial, noInitramfs, skipBoot bool
	)
	cmd := &cobra.Command{
		Use:   "rebuild",
		Short: "Rebuild a whole machine from a snapshot onto a disk or raw image (bare-metal recovery engine)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			tgt, err := parseTargetFlag(target, imageSize)
			if err != nil {
				return err
			}
			provider, err := providerFromConfigFile(providerConfig) // exec_backup.go's restoreProviderForCommand on the file's JSON, no vault
			if err != nil {
				return err
			}
			opts := rebuild.Options{
				SnapshotID: snapshot, Provider: provider, Target: tgt, Identity: rebuild.IdentityMode(identityFlag),
				StateDir: stateDir, DryRun: dryRun, ForceReprovision: force, AllowPartialRestore: allowPartial,
				RegenerateInitramfs: !noInitramfs, SkipBoot: skipBoot,
				Progress: func(ph rebuild.Phase, msg string, cur, total int64) {
					fmt.Fprintf(cmd.ErrOrStderr(), "[%s] %s", ph, msg)
					if total > 0 {
						fmt.Fprintf(cmd.ErrOrStderr(), " (%d/%d)", cur, total)
					}
					fmt.Fprintln(cmd.ErrOrStderr())
				},
			}
			if markerFile != "" {
				var m rebuild.Marker
				b, err := os.ReadFile(markerFile)
				if err != nil {
					return err
				}
				if err := json.Unmarshal(b, &m); err != nil || m.RecoveryID == "" || m.Nonce == "" {
					return fmt.Errorf("marker file must be JSON {\"recoveryId\",\"nonce\"}: %v", err)
				}
				opts.Marker = &m
			}
			ctx, stop := recoveryContext()
			defer stop()
			res, runErr := rebuild.Run(ctx, opts)
			if res != nil {
				encoded, _ := json.MarshalIndent(res, "", "  ")
				_, _ = cmd.OutOrStdout().Write(append(encoded, '\n'))
				if resultJSON != "" {
					_ = os.WriteFile(resultJSON, encoded, 0o600)
				}
			}
			return runErr
		},
	}
	cmd.Flags().StringVar(&snapshot, "snapshot", "", "snapshot id")
	cmd.Flags().StringVar(&target, "target", "", "disk:/dev/sdX or image:/path/to/file.img")
	cmd.Flags().StringVar(&imageSize, "image-size", "", "size for a new image file, e.g. 40G")
	cmd.Flags().StringVar(&providerConfig, "provider-config", "", "JSON file {provider, providerConfig}")
	cmd.Flags().StringVar(&identityFlag, "identity", "original", "original|new")
	cmd.Flags().StringVar(&markerFile, "marker-file", "", "JSON {recoveryId, nonce} for original identity")
	cmd.Flags().StringVar(&resultJSON, "result-json", "", "write the result JSON here as well as stdout")
	cmd.Flags().StringVar(&stateDir, "state-dir", "", "engine state dir (default /var/lib/breeze/rebuild)")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "preflight only; print the plan")
	cmd.Flags().BoolVar(&force, "force-reprovision", false, "discard resume state and start from provisioning")
	cmd.Flags().BoolVar(&allowPartial, "allow-partial", false, "continue when some files fail to restore")
	cmd.Flags().BoolVar(&noInitramfs, "no-initramfs", false, "do not regenerate the initramfs")
	cmd.Flags().BoolVar(&skipBoot, "skip-boot", false, "tests only: skip bootloader installation")
	_ = cmd.MarkFlagRequired("snapshot")
	_ = cmd.MarkFlagRequired("target")
	_ = cmd.MarkFlagRequired("provider-config")
	return cmd
}

func parseTargetFlag(v, size string) (rebuild.Target, error) {
	kind, p, ok := strings.Cut(v, ":")
	if !ok || p == "" {
		return rebuild.Target{}, fmt.Errorf("--target must be disk:<device> or image:<file>, got %q", v)
	}
	switch kind {
	case "disk":
		return rebuild.Target{Kind: rebuild.TargetDisk, Path: p}, nil
	case "image":
		t := rebuild.Target{Kind: rebuild.TargetImage, Path: p}
		if size != "" {
			n, err := parseSize(size)
			if err != nil {
				return rebuild.Target{}, err
			}
			t.ImageSizeBytes = n
		}
		return t, nil
	}
	return rebuild.Target{}, fmt.Errorf("unsupported target kind %q (disk|image)", kind)
}

func parseSize(s string) (int64, error) // "40G" / "512M" / "1T" / plain bytes; error otherwise
```

Register in `bmr_recover_cmd.go:35`: `rootCmd.AddCommand(newBMRRecoverCommand(), newRebuildCommand())`.

- [ ] **Step 4: Root-gated loopback test** (`loopback_linux_test.go`)

```go
//go:build linux

package rebuild

// Runs only as root with BREEZE_REBUILD_LOOP_TEST=1 (CI: a privileged step in
// the test-agent job; locally: sudo). Proves sgdisk/mkfs/mount/restore on a
// real loop device; boot is skipped because the synthetic root has no GRUB.
func TestRun_LoopbackRealSystem(t *testing.T) {
	if os.Getenv("BREEZE_REBUILD_LOOP_TEST") != "1" || os.Geteuid() != 0 {
		t.Skip("needs root and BREEZE_REBUILD_LOOP_TEST=1")
	}
	for _, tool := range []string{"sgdisk", "losetup", "mkfs.vfat", "mkfs.ext4", "partprobe", "blkid"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s not installed", tool)
		}
	}
	dir := t.TempDir()
	lay := testLayout()
	// Shrink the source so a 3 GiB image is enough: EFI 64 MiB, boot 256 MiB, root used 512 MiB.
	d := &lay.Disks[0]
	d.Partitions[0].SizeBytes = 64 * MiB
	d.Partitions[1].SizeBytes = 256 * MiB
	d.Partitions[2].UsedBytes = 512 * MiB
	p := seedSnapshot(t, "loop-1", lay)
	img := filepath.Join(dir, "disk.img")
	res, err := Run(context.Background(), Options{SnapshotID: "loop-1", Provider: p, Target: Target{Kind: TargetImage, Path: img, ImageSizeBytes: 3 * GiB}, Identity: IdentityNew, StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), SkipBoot: true})
	if err != nil {
		t.Fatalf("run: %v\n%+v", err, res)
	}
	dev, detach, err := NewSystem().AttachImage(img, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer detach()
	out, _ := exec.Command("blkid", "-o", "export", partitionDevice(dev, 3)).CombinedOutput()
	if !strings.Contains(string(out), "UUID=9f7a-root") || !strings.Contains(string(out), "TYPE=ext4") {
		t.Fatalf("root partition: %s", out)
	}
	out, _ = exec.Command("blkid", "-o", "export", partitionDevice(dev, 1)).CombinedOutput()
	if !strings.Contains(string(out), "UUID=ABCD-1234") || !strings.Contains(string(out), "TYPE=vfat") {
		t.Fatalf("efi partition: %s", out)
	}
	mnt := filepath.Join(dir, "verify")
	os.MkdirAll(mnt, 0o755)
	if out, err := exec.Command("mount", partitionDevice(dev, 3), mnt).CombinedOutput(); err != nil {
		t.Fatalf("mount: %s", out)
	}
	defer exec.Command("umount", mnt).Run()
	if b, err := os.ReadFile(filepath.Join(mnt, "etc", "hostname")); err != nil || string(b) != "srv-1-restored\n" {
		t.Fatalf("hostname = %q err=%v", b, err)
	}
	if got, err := os.Readlink(filepath.Join(mnt, "bin")); err != nil || got != "usr/bin" {
		t.Fatalf("symlink = %q err=%v", got, err)
	}
}
```

Wire it into CI: in `.github/workflows/ci.yml`'s `test-agent` job add a step after the normal tests:

```yaml
      - name: Rebuild engine loopback test (root)
        if: runner.os == 'Linux'
        run: |
          sudo apt-get install -y --no-install-recommends gdisk dosfstools e2fsprogs
          cd agent && sudo -E env "PATH=$PATH" BREEZE_REBUILD_LOOP_TEST=1 go test -run TestRun_LoopbackRealSystem ./internal/backup/rebuild/ -v
```

- [ ] **Step 5: Run everything**

```bash
cd agent && go test -race ./internal/backup/... ./cmd/breeze-backup/ 2>&1 | tail -6
GOOS=windows go build ./cmd/breeze-backup/ && GOOS=darwin go build ./cmd/breeze-backup/ && GOOS=linux go build ./cmd/breeze-backup/ && echo BUILD-OK
golangci-lint run ./internal/backup/... ./cmd/breeze-backup/ 2>&1 | tail -5
```
On a Linux box with root (the lab Ubuntu rig or a `docker run --privileged golang:1.26` container with the tools installed): `sudo BREEZE_REBUILD_LOOP_TEST=1 go test -run TestRun_LoopbackRealSystem ./internal/backup/rebuild/ -v` → PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/cmd/breeze-backup/rebuild_cmd.go agent/cmd/breeze-backup/rebuild_cmd_test.go agent/cmd/breeze-backup/bmr_recover_cmd.go agent/internal/backup/rebuild/loopback_linux_test.go .github/workflows/ci.yml
git commit -m "feat(breeze-backup): rebuild CLI; root-gated loopback proof of provisioning + restore (W03)"
```

---

### Task 7: Live proof on the lab and PR

- [ ] **Step 1: End-to-end on the Ubuntu lab rig** (agent as root, lab stack up, whole-machine snapshot from W01 present):

```bash
sudo breeze-backup rebuild --snapshot <id> --target image:/var/tmp/rebuild.img --image-size 40G \
  --provider-config /root/prov.json --identity new --result-json /var/tmp/rebuild-result.json
jq '.status, .phaseReached, [.phases[] | .phase + ":" + .status], .warnings' /var/tmp/rebuild-result.json
```
Expected: `completed`, `validate`, seven `…:completed`, warnings only about `package reinstall skipped` (and initramfs if the rig lacks the kernel package in the tree).

- [ ] **Step 2: Boot the image** — convert and boot on KIT (Hyper-V Gen2, Secure Boot off for this proof):

```bash
qemu-img convert -O vhdx -o subformat=dynamic /var/tmp/rebuild.img /var/tmp/rebuild.vhdx
# scp to KIT D:\lab\, then on KIT (kit-vm-from-vhdx.ps1 from the campaign harness): New-VM -Generation 2 … ; Start-VM
```
Expected: the VM boots to a login prompt with hostname `<orig>-restored`; `systemctl is-enabled ssh` → enabled; `cat /etc/machine-id` differs from the source. Record the console screenshot path and the result JSON in the PR body and in the campaign doc `docs/testing/backup-assurance/2026-09-09-backup-assurance-campaign.md` §11 as row `W03-linux-image-boot`.

- [ ] **Step 3: PR** — branch `feature/5493-bare-metal-boot-media/wave-5496`; body: per-task summary, the CLI synopsis, the loopback + boot evidence, `Closes #5496`. One `/review-pr` round (this is agent-shipped code on the recovery path — use a Sonnet or Opus reviewer per CLAUDE.md model routing), fix confirmed findings, `gh pr merge <N> --squash`.

---

## Self-review notes (plan author)

- Spec §6 phases: preflight (Task 4: guard, size, in-use/root-device refusal, manifest + state checksum verification before any write), provision (Task 4: sgdisk with type/partition GUIDs, mkfs with UUIDs/labels, last partition grows), restore tree (Task 4: mount order, strict restore, offline state apply via Task 3), boot (Task 5: Debian/RHEL, chroot, `--no-nvram` for images, fallback `EFI/BOOT` path, initramfs), identity (Task 5: marker / fresh identity incl. enrollment strip), encryption (recorded no-op), validate (Task 5: sampled checksums, bootloader files, fstab UUIDs, sync/unmount/detach). Result persisted by the CLI (`--result-json`) for W04's `complete` call.
- Spec §9: no writes before preflight (asserted by `TestRun_PreflightRefusals`), wrong-disk protection inside the engine (in-use and running-system refusals; serial confirmation is W04's console), resumability (`TestRun_ResumeSkipsProvisionAndReusesPlan`).
- Spec §10: engine unit tests without hardware (fake `System`), root-gated loopback proof in CI.
- Names consistent across tasks: `Run`, `Options`, `Result`, `Plan`, `PlannedPartition`, `PlanPartitions`, `System`/`NewSystem`/`fakeSystem`, `Target{Kind, Path, ImageSizeBytes}`, `IdentityOriginal/New`, `Marker`, `RefusalError`, `bmr.DownloadSystemState`, `bmr.ErrNoSystemState`, `bmr.RestoreSystemStateOffline`, `applyNewIdentity`, `stripEnrollment`, `detectBootFamily`, `bootloaderID`, `grubTarget`, `mountTree`, `partitionDevice`.
- Deliberate deviations from the spec text: "vhdx target" for Linux is realised as raw image + `qemu-img convert` (VHDX creation on Windows hosts is W06); `System` is an interface rather than the package-var seam used elsewhere because the engine needs eleven distinct OS operations, not one.
