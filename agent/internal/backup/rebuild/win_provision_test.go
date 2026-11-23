package rebuild

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

var errDeviceBusyForTest = errors.New("device busy")

func TestWinRunWithRetry_RetriesDeviceBusyThenSucceeds(t *testing.T) {
	sys := newFakeWinSystem(t.TempDir())
	sys.failTimes["format.com"] = &failTimesEntry{remaining: 2, out: []byte("Cannot lock current drive."), err: errDeviceBusyForTest}
	out, err := winRunWithRetry(context.Background(), sys, "format.com", `\\?\Volume{x}\`, "/FS:NTFS", "/Q", "/Y")
	if err != nil {
		t.Fatalf("expected eventual success, got err=%v out=%s", err, out)
	}
	if n := len(countCalls(sys.cmds, "format.com")); n != 3 {
		t.Fatalf("format.com ran %d times, want 3 (two busy failures, then success)", n)
	}
}

func TestWinRunWithRetry_DoesNotRetryNonBusyFailure(t *testing.T) {
	sys := newFakeWinSystem(t.TempDir())
	sys.failTimes["format.com"] = &failTimesEntry{remaining: 5, out: []byte("Invalid media or Track 0 bad - disk unusable."), err: errDeviceBusyForTest}
	if _, err := winRunWithRetry(context.Background(), sys, "format.com", `\\?\Volume{x}\`); err == nil {
		t.Fatal("expected the non-busy failure to surface")
	}
	if n := len(countCalls(sys.cmds, "format.com")); n != 1 {
		t.Fatalf("format.com ran %d times, want 1 (non-busy failures are not retried)", n)
	}
}

func TestWinProvision_WritesGPTFormatsAndRecordsVolumes(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	atRestore := captureAfterProvision(t, &opts, sys)
	res, _ := Run(context.Background(), opts)
	if res == nil {
		t.Fatalf("expected a Result")
	}
	if !sys.has("CreateVHDX") || !sys.has("AttachVHDX") || !sys.has("WipeDisk") || !sys.has("WriteGPT") {
		t.Fatalf("cmds = %v", sys.cmds)
	}
	formats := countCalls(sys.cmds, "format.com")
	if len(formats) != 3 { // ESP, C:, Recovery — the MSR has no filesystem
		t.Fatalf("format.com calls = %d, want 3", len(formats))
	}
	wantFS := map[int]string{1: "/FS:FAT32", 3: "/FS:NTFS", 4: "/FS:NTFS"}
	for n, fs := range wantFS {
		vol := sys.volumeDirForPartition(t, n)
		if len(countCalls(formats, "format.com "+vol+" "+fs+" ")) != 1 {
			t.Fatalf("partition %d not formatted %s: %v", n, fs, formats)
		}
	}
	diskGUID, parts := atRestore.diskGUID, atRestore.parts
	if want := testLayoutWindows().SystemDisk().GUID; diskGUID != want {
		t.Fatalf("disk GUID = %q, want the recorded %q", diskGUID, want)
	}
	// Source attributes preserved, no-drive-letter bit OR-ed in on every
	// partition (winValidate, Task 13, clears it on root/data later), and
	// platform-required on ESP/MSR/Recovery.
	wantAttrs := map[int]uint64{1: 0x8000000000000001, 2: 0x8000000000000001, 3: 0x8000000000000000, 4: 0x8000000000000001}
	wantNames := map[int]string{1: "EFI system partition", 2: "Microsoft reserved partition", 3: "Basic data partition", 4: ""}
	if len(parts) != 4 {
		t.Fatalf("parts = %+v, want 4", parts)
	}
	for _, p := range parts {
		if p.PartGUID == "" {
			t.Fatalf("partition %d written without a GUID", p.Number)
		}
		if p.Number == 3 && p.PartGUID != testWindowsRootPartUUID {
			t.Fatalf("root partition GUID = %s, want the recorded %s", p.PartGUID, testWindowsRootPartUUID)
		}
		if p.Attributes != wantAttrs[p.Number] {
			t.Fatalf("partition %d attributes = %#x, want %#x", p.Number, p.Attributes, wantAttrs[p.Number])
		}
		if p.Name != wantNames[p.Number] {
			t.Fatalf("partition %d name = %q, want the plan's role default %q", p.Number, p.Name, wantNames[p.Number])
		}
	}
	// The volumes are persisted for resume (R29): every formatted partition.
	var st runState
	if err := json.Unmarshal(atRestore.state, &st); err != nil {
		t.Fatal(err)
	}
	if len(st.Volumes) != 3 || st.Volumes[2] != "" || st.Volumes[3] == "" {
		t.Fatalf("persisted volumes = %v, want partitions 1, 3, 4", st.Volumes)
	}
}

// The platform-required bit (0x1) is added by ROLE at write time for
// ESP/MSR/Recovery even when the source lacked it; root/data never gain it.
func TestWinProvision_AddsPlatformRequiredByRoleOnly(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	lay := testLayoutWindows()
	for i := range lay.Disks[0].Partitions {
		lay.Disks[0].Partitions[i].Attributes = 0 // source carries no bits at all
	}
	opts.Layout = lay
	atRestore := captureAfterProvision(t, &opts, sys)
	if res, _ := Run(context.Background(), opts); res == nil {
		t.Fatal("expected a Result")
	}
	parts := atRestore.parts
	want := map[int]uint64{1: 0x8000000000000001, 2: 0x8000000000000001, 3: 0x8000000000000000, 4: 0x8000000000000001}
	if len(parts) != 4 {
		t.Fatalf("parts = %+v", parts)
	}
	for _, p := range parts {
		if p.Attributes != want[p.Number] {
			t.Fatalf("partition %d attributes = %#x, want %#x", p.Number, p.Attributes, want[p.Number])
		}
	}
}

func TestIsWindowsVolumeBusyOutput(t *testing.T) {
	for in, want := range map[string]bool{
		"Cannot lock current drive.":                                                      true,
		"The volume is in use by another process.":                                        true,
		"The process cannot access the file because it is being used by another process.": true,
		"Invalid media or Track 0 bad - disk unusable.":                                   false,
	} {
		if got := isWindowsVolumeBusyOutput([]byte(in)); got != want {
			t.Errorf("isWindowsVolumeBusyOutput(%q) = %v, want %v", in, got, want)
		}
	}
}

// Carry-over from Task 8: with ForceReprovision, a VHDX a crashed run left
// attached (recorded in the state file's Volumes) is detached BEFORE the
// state file is removed and provisioning recreates the image.
func TestRun_ForceReprovisionDetachesStaleVHDXBeforeProvisioning(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	opts.ForceReprovision = true
	sPath := filepath.Join(dir, "rebuild-win-1-"+targetKey(opts.Target)+".json")
	stale := runState{SnapshotID: "win-1", TargetKey: targetKey(opts.Target), Plan: &Plan{}, Completed: map[Phase]bool{PhaseProvision: true},
		Platform: "windows", HostOS: "windows", Volumes: map[int]string{3: filepath.Join(dir, "stale-vol")}}
	b, _ := json.Marshal(stale)
	if err := os.WriteFile(sPath, b, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := sys.CreateVHDX(opts.Target.Path, opts.Target.ImageSizeBytes, 512); err != nil {
		t.Fatal(err)
	}
	if _, _, err := sys.AttachVHDX(opts.Target.Path); err != nil {
		t.Fatal(err)
	}
	sys.mu.Lock()
	sys.cmds = nil
	sys.mu.Unlock()

	res, _ := Run(context.Background(), opts)
	if res == nil {
		t.Fatal("expected a Result")
	}
	detachAt, createAt := -1, -1
	for i, c := range sys.cmds {
		if strings.HasPrefix(c, "DetachVHDXByPath "+opts.Target.Path) && detachAt == -1 {
			detachAt = i
		}
		if strings.HasPrefix(c, "CreateVHDX") && createAt == -1 {
			createAt = i
		}
	}
	if detachAt == -1 || createAt == -1 || detachAt > createAt {
		t.Fatalf("want DetachVHDXByPath before CreateVHDX; cmds = %v", sys.cmds)
	}
	if len(sys.detachedVHDXPaths) == 0 || sys.detachedVHDXPaths[0] != opts.Target.Path {
		t.Fatalf("stale VHDX not detached: %v", sys.detachedVHDXPaths)
	}
}

type closeCountingHandle struct {
	winhive.Handle
	closed *int
}

func (h closeCountingHandle) Close() error { *h.closed++; return nil }

// winTeardown is the failure-path backstop: hives closed, ESP letter
// released, the recovery folder mount removed before root (the ESP is
// never folder-mounted, ruling C1, so there is nothing to remove for it);
// the run's VHDX detach stays teardown's job (after winTeardown).
func TestWinTeardown_ReleasesEverythingRootLast(t *testing.T) {
	dir := t.TempDir()
	sys := newFakeWinSystem(dir)
	closed, released := 0, 0
	detached := false
	r := &run{opts: Options{WinSystem: sys}, winSys: sys,
		rootDir: filepath.Join(dir, "root"), recoveryDir: filepath.Join(dir, "recovery"),
		hives:            map[string]winhive.Handle{"SYSTEM": closeCountingHandle{winhive.NewFake(), &closed}},
		espLetterRelease: func() error { released++; return nil },
		detach: func() error {
			if len(sys.unmounts) != 2 {
				t.Errorf("detach ran before every folder mount was removed: %v", sys.unmounts)
			}
			detached = true
			return nil
		},
	}
	r.teardown()
	if closed != 1 || released != 1 || !detached {
		t.Fatalf("closed=%d released=%d detached=%v", closed, released, detached)
	}
	if len(sys.unmounts) != 2 || sys.unmounts[1] != filepath.Join(dir, "root") {
		t.Fatalf("unmounts = %v, want root last", sys.unmounts)
	}
	if r.rootDir != "" || r.recoveryDir != "" || r.hives != nil || r.espLetterRelease != nil {
		t.Fatalf("teardown left state behind: %+v", r)
	}
	r.teardown() // idempotent: nothing is released twice
	if closed != 1 || released != 1 || len(sys.unmounts) != 2 {
		t.Fatalf("second teardown released again: closed=%d released=%d unmounts=%v", closed, released, sys.unmounts)
	}
}

func countCalls(cmds []string, prefix string) []string {
	var out []string
	for _, c := range cmds {
		if strings.HasPrefix(c, prefix) {
			out = append(out, c)
		}
	}
	return out
}

// provisionSnapshot is what the disk and the state file held when the
// restore phase started — i.e. exactly what winProvision wrote, before
// winValidate clears the no-drive-letter bit and Run removes the state file
// on completion.
type provisionSnapshot struct {
	diskGUID string
	parts    []WinGPTPartition
	state    []byte
}

// captureAfterProvision installs an opts.Progress hook that records a
// provisionSnapshot at the restore phase's "starting" report.
func captureAfterProvision(t *testing.T, opts *Options, sys *fakeWinSystem) *provisionSnapshot {
	t.Helper()
	snap := &provisionSnapshot{}
	opts.Progress = func(ph Phase, msg string, _, _ int64) {
		if ph != PhaseRestore || msg != "starting" {
			return
		}
		guid, parts, err := sys.ReadGPT(sys.vhdxDiskNumber[opts.Target.Path])
		if err != nil {
			t.Fatalf("ReadGPT at restore start: %v", err)
		}
		snap.diskGUID, snap.parts = guid, parts
		b, err := os.ReadFile(filepath.Join(opts.StateDir, "rebuild-"+opts.SnapshotID+"-"+targetKey(opts.Target)+".json"))
		if err != nil {
			t.Fatalf("state file at restore start: %v", err)
		}
		snap.state = b
	}
	return snap
}

// #12576: a Server 2016 snapshot records its ESP with no filesystem. The
// rebuild formats it FAT32 (the plan defaults it), leaves the MSR alone, and
// waits for exactly the partitions it formats — before the fix, the ESP was
// skipped like the MSR, never formatted, and the count-based wait could
// return before C:'s volume existed ("volume for partition 4 did not appear
// after WriteGPT").
func TestWinProvision_ESPWithNoRecordedFilesystemIsFormattedFAT32(t *testing.T) {
	for _, tc := range []struct {
		name      string
		espNumber int
		msr       int
		wantFS    map[int]string
		wantWait  string
	}{
		{"reported Server 2016 layout (ESP at 2)", 2, 3, map[int]string{1: "/FS:NTFS", 2: "/FS:FAT32", 4: "/FS:NTFS"}, "partitions=1,2,4"},
		{"ESP at partition 4", 4, 2, map[int]string{1: "/FS:NTFS", 3: "/FS:NTFS", 4: "/FS:FAT32"}, "partitions=1,3,4"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withHostPlatformWindows(t)
			dir := t.TempDir()
			opts, sys := winFakeOptions(t, dir)
			lay := testLayoutWindows()
			lay.Disks[0] = *windowsUnlinkedESPDisk(tc.espNumber)
			opts.Layout = lay
			opts.SkipBoot = false // the boot phase needs the provisioned ESP ("no EFI system partition was provisioned" otherwise)
			atRestore := captureAfterProvision(t, &opts, sys)
			res, err := Run(context.Background(), opts)
			if res == nil || res.Status != "completed" || !phaseCompleted(res, PhaseBoot) {
				t.Fatalf("run did not complete through boot: err=%v res=%+v", err, res)
			}
			formats := countCalls(sys.cmds, "format.com")
			if len(formats) != len(tc.wantFS) {
				t.Fatalf("format.com calls = %v, want one each for partitions %v (never the MSR)", formats, tc.wantFS)
			}
			for n, fs := range tc.wantFS {
				vol := sys.volumeDirForPartition(t, n)
				if len(countCalls(formats, "format.com "+vol+" "+fs+" ")) != 1 {
					t.Fatalf("partition %d not formatted %s: %v", n, fs, formats)
				}
			}
			disk := sys.vhdxDiskNumber[opts.Target.Path]
			want := fmt.Sprintf("WaitForVolumes %d %s", disk, tc.wantWait)
			if waits := countCalls(sys.cmds, "WaitForVolumes"); len(waits) != 1 || waits[0] != want {
				t.Fatalf("WaitForVolumes calls = %v, want exactly %q", waits, want)
			}
			var st runState
			if err := json.Unmarshal(atRestore.state, &st); err != nil {
				t.Fatal(err)
			}
			if st.Volumes[tc.espNumber] == "" || st.Volumes[tc.msr] != "" {
				t.Fatalf("persisted volumes = %v, want the ESP (partition %d) recorded and the MSR (partition %d) absent", st.Volumes, tc.espNumber, tc.msr)
			}
		})
	}
}

// #12576: the provision wait asks for the partitions it formats, not for a
// number of volumes. Here the host surfaces a volume the plan never asked
// for (partition 7) at once and C:'s volume (partition 4) only after a few
// polls; a count-based wait returns on {1, 2, 7} and provision then fails
// with "volume for partition 4 did not appear after WriteGPT".
func TestWinProvision_UnrelatedVolumeAppearingFirstDoesNotSatisfyTheWait(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	lay := testLayoutWindows()
	lay.Disks[0] = *windowsUnlinkedESPDisk(2)
	opts.Layout = lay
	sys.strayVolumePartitions = []int{7}
	sys.volumeDelay[4] = 3
	res, _ := Run(context.Background(), opts)
	if res == nil || !phaseCompleted(res, PhaseProvision) {
		t.Fatalf("provision did not complete: %+v", res)
	}
	root := sys.volumeDirForPartition(t, 4)
	if len(countCalls(sys.cmds, "format.com "+root+" /FS:NTFS ")) != 1 {
		t.Fatalf("C: (partition 4) not formatted: %v", countCalls(sys.cmds, "format.com"))
	}
	stray := sys.volumeDirForPartition(t, 7)
	if len(countCalls(sys.cmds, "format.com "+stray+" ")) != 0 {
		t.Fatalf("the unrelated volume was formatted: %v", countCalls(sys.cmds, "format.com"))
	}
}
