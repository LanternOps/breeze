package rebuild

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/layout"
)

// A full Windows vhdx run with SkipBoot completes: validate samples
// checksums via backup.RestoreKey, asserts the partition GUIDs via ReadGPT,
// clears the no-letter attribute on root/data only (Recovery keeps
// 0x8000000000000001), flushes, unmounts and releases the VHDX — in that
// order (Ruling B6): the attribute clear is the last layout write, after
// every flush and unmount, and the handle detach comes after it.
func TestWinValidate_ChecksumsSampleAndClearsNoLetterAttribute(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	res, err := Run(context.Background(), opts)
	if err != nil || res.Status != "completed" {
		t.Fatalf("run: res=%+v err=%v", res, err)
	}
	guid, parts, err := sys.ReadGPT(sys.vhdxDiskNumber[opts.Target.Path])
	if err != nil {
		t.Fatal(err)
	}
	if guid != testLayoutWindows().Disks[0].GUID {
		t.Fatalf("disk GUID = %q, want the recorded %q", guid, testLayoutWindows().Disks[0].GUID)
	}
	for _, p := range parts {
		switch p.Number {
		case 3: // C:
			if p.Attributes&gptAttrNoDriveLetter != 0 {
				t.Fatalf("root partition still carries the no-drive-letter bit: %#x", p.Attributes)
			}
		case 4: // Recovery
			if p.Attributes != 0x8000000000000001 {
				t.Fatalf("recovery attributes = %#x, want 0x8000000000000001", p.Attributes)
			}
		}
	}
	if !sys.has("FlushVolume") {
		t.Fatalf("cmds = %v, want a FlushVolume call", sys.cmds)
	}
	if len(sys.unmounts) < 2 { // root and recovery folder mount points
		t.Fatalf("unmounts = %v, want root and recovery unmounted", sys.unmounts)
	}
	if len(sys.attachedVHDX) != 0 {
		t.Fatalf("attachedVHDX = %v, want empty after a completed run", sys.attachedVHDX)
	}
	if n := len(countCalls(sys.cmds, "SetPartitionAttributes ")); n != 1 {
		t.Fatalf("SetPartitionAttributes calls = %d, want exactly 1 (root only): %v", n, sys.cmds)
	}

	// Ruling B6 call order.
	last := func(prefix string) int {
		at := -1
		for i, c := range sys.cmds {
			if strings.HasPrefix(c, prefix) {
				at = i
			}
		}
		return at
	}
	first := func(prefix string) int {
		for i, c := range sys.cmds {
			if strings.HasPrefix(c, prefix) {
				return i
			}
		}
		return -1
	}
	format, flush := last("format.com"), last("FlushVolume")
	unmountRoot := first("UnmountVolume " + filepath.Join(dir, "mnt", "root"))
	setAttr, detach := first("SetPartitionAttributes "), first("DetachVHDXHandle ")
	if format < 0 || flush < 0 || unmountRoot < 0 || setAttr < 0 || detach < 0 {
		t.Fatalf("missing a call (format=%d flush=%d unmountRoot=%d setAttr=%d detach=%d): %v", format, flush, unmountRoot, setAttr, detach, sys.cmds)
	}
	if format >= flush || flush >= unmountRoot || unmountRoot >= setAttr || setAttr >= detach {
		t.Fatalf("order: format=%d flush=%d unmountRoot=%d setAttr=%d detach=%d, want format < flush < unmount root < SetPartitionAttributes < detach: %v", format, flush, unmountRoot, setAttr, detach, sys.cmds)
	}
}

// A partition whose GUID differs from the plan fails validation (the
// Part 0 §2 string).
func TestWinValidate_RefusesChangedPartitionGUID(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	// Rewrite the fake disk's root GUID just before validate starts (Run
	// reports "starting" for every phase through Options.Progress).
	opts.Progress = func(ph Phase, msg string, _, _ int64) {
		if ph == PhaseValidate && msg == "starting" {
			sys.mu.Lock()
			d := sys.disks[sys.vhdxDiskNumber[opts.Target.Path]]
			for i := range d.parts {
				if d.parts[i].Number == 3 {
					d.parts[i].PartGUID = "deadbeef-0000-4000-8000-000000000000"
				}
			}
			sys.mu.Unlock()
		}
	}
	res, err := Run(context.Background(), opts)
	if err == nil || res.Status != "failed" || !strings.Contains(res.Error, "partition 3 GUID changed during the run ("+testWindowsRootPartUUID+" → deadbeef-0000-4000-8000-000000000000)") {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

// Ruling B4: the checksum sample reads the restored files through the root
// VOLUME path — corrupting the one sampled file there must fail validate.
// (The fixture's only sampled file is Users/Administrator/NTUSER.DAT: the
// hives and ProgramData/Breeze are skip-listed.)
func TestWinValidate_ChecksumMismatchFails(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	opts.Progress = func(ph Phase, msg string, _, _ int64) {
		if ph == PhaseValidate && msg == "starting" {
			target := filepath.Join(sys.volumeDirForPartition(t, 3), "Users", "Administrator", "NTUSER.DAT")
			if err := os.WriteFile(target, []byte("tampered"), 0o644); err != nil {
				t.Fatalf("tamper: %v", err)
			}
		}
	}
	res, err := Run(context.Background(), opts)
	if err == nil || res.Status != "failed" || res.PhaseReached != PhaseValidate || !strings.Contains(res.Error, "sampled files differ") {
		t.Fatalf("res=%+v err=%v, want a failed validate naming the sampled mismatch", res, err)
	}
}

// Ruling B3: a VSS-style entry (OriginalPath set) that failed under
// AllowPartialRestore is skipped by the sample — r.failedFiles is keyed by
// backup.RestoreSourceKey (the OriginalPath), not the shadow SourcePath.
func TestWinValidate_SkipsFailedVSSFileUnderPartialRestore(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, _ := winFakeOptions(t, dir)
	p := opts.Provider.(*memProvider)
	delete(p.files, "snapshots/win-1/files/path_0/Users/Administrator/NTUSER.DAT")
	opts.AllowPartialRestore = true
	res, err := Run(context.Background(), opts)
	if err != nil || res.Status != "completed" {
		t.Fatalf("res=%+v err=%v, want completed (the failed file is already a warning, not a mismatch)", res, err)
	}
	if res.FilesFailed != 1 || len(res.FailedFilesSample) != 1 || res.FailedFilesSample[0] != "C:/Users/Administrator/NTUSER.DAT" {
		t.Fatalf("FilesFailed=%d sample=%v, want the one VSS entry under its OriginalPath", res.FilesFailed, res.FailedFilesSample)
	}
}

// Ruling B1: a disk: target's default work dir lives under the root VOLUME
// (<rootVolume>\$breeze-rebuild-work) and validate removes it from there
// before release.
func TestWinValidate_DiskTargetRemovesWorkDirFromRootVolume(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	opts.Target = Target{Kind: TargetDisk, Path: `\\.\PhysicalDrive1`}
	sys.inWinPE = true
	sys.diskInfo[1] = WinDiskInfo{SizeBytes: 80 * GiB, LogicalSectorSize: 512}
	res, err := Run(context.Background(), opts)
	if err != nil || res.Status != "completed" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	rootVol := sys.volumeDirForPartition(t, 3)
	if _, err := os.Stat(filepath.Join(rootVol, "Users", "Administrator", "NTUSER.DAT")); err != nil {
		t.Fatalf("restored file missing under the root volume: %v", err)
	}
	if _, err := os.Stat(filepath.Join(rootVol, "$breeze-rebuild-work")); !os.IsNotExist(err) {
		t.Fatalf("work dir under the root volume not removed (err=%v)", err)
	}
}

// winConvert always records skipped on the Windows engine — the VHDX is
// written natively, never staged as a raw image (R12).
func TestWinConvert_AlwaysSkipped(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	res, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	last := res.Phases[len(res.Phases)-1]
	if last.Phase != PhaseConvert || last.Status != PhaseSkipped || last.Message != "vhdx written natively; no conversion" {
		t.Fatalf("last phase = %+v, want PhaseConvert/skipped", last)
	}
	if len(res.Phases) != len(AllPhases) {
		t.Fatalf("phases = %d, want %d (one row per phase)", len(res.Phases), len(AllPhases))
	}
	if strings.Contains(sys.dumpForTest(), "qemu-img") {
		t.Fatalf("the Windows engine must never invoke qemu-img: %v", sys.cmds)
	}
}

// Final-review minor: the GUID read-back also fails when a planned
// partition is missing from the disk, not only when a GUID changed.
func TestWinValidate_RefusesMissingPlannedPartition(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	opts.Progress = func(ph Phase, msg string, _, _ int64) {
		if ph == PhaseValidate && msg == "starting" {
			sys.mu.Lock()
			d := sys.disks[sys.vhdxDiskNumber[opts.Target.Path]]
			var kept []WinGPTPartition
			for _, p := range d.parts {
				if p.Number != 4 {
					kept = append(kept, p)
				}
			}
			d.parts = kept
			sys.mu.Unlock()
		}
	}
	res, err := Run(context.Background(), opts)
	if err == nil || res.Status != "failed" || !strings.Contains(res.Error, "planned partition 4 is missing from the disk") {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if sys.has("SetPartitionAttributes") {
		t.Fatalf("no attribute write on a disk whose layout moved: %v", sys.cmds)
	}
}

// Ruling (Task 13): a failed FlushVolume fails validation — an unflushed
// volume before detach risks a torn image.
func TestWinValidate_FlushFailureFailsValidation(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	sys.fail["FlushVolume"] = errors.New("FlushFileBuffers: the device is not ready")
	res, err := Run(context.Background(), opts)
	if err == nil || res.Status != "failed" || res.PhaseReached != PhaseValidate || !strings.Contains(res.Error, "flush volume for partition") {
		t.Fatalf("res=%+v err=%v, want a failed validate naming the flush", res, err)
	}
}

// Final-review Imp 3: a data partition on the system disk is recreated and
// formatted but nothing is restored into it — the run says so, once.
func TestWinRun_WarnsOncePerEmptyDataPartition(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, _ := winFakeOptions(t, dir)
	lay := testLayoutWindows()
	d := &lay.Disks[0]
	d.Partitions = append(d.Partitions, layout.Partition{Number: 5, Name: "data", TypeGUID: layout.GUIDMicrosoftBasic, PartUUID: "6a1e0000-0000-4000-8000-000000000005",
		StartBytes: 61 * GiB, SizeBytes: 10 * GiB, Filesystem: "ntfs", Label: "Data", MountPoint: `D:\`, Role: layout.RoleData, Encryption: layout.EncryptionNone})
	opts.Provider = seedWindowsSnapshot(t, "win-1", lay)
	res, err := Run(context.Background(), opts)
	if err != nil || res.Status != "completed" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	want := "data partition 5 (Data) was recreated empty; its contents were not restored"
	n := 0
	for _, w := range res.Warnings {
		if w == want {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("warnings = %q, want %q exactly once", res.Warnings, want)
	}
}
