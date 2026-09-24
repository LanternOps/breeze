package rebuild

import (
	"context"
	"encoding/json"
	"errors"
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
	res, _ := Run(context.Background(), opts)
	if res == nil {
		t.Fatalf("expected a Result")
	}
	if !sys.has("CreateVHDX") || !sys.has("AttachVHDX") || !sys.has("WipeDisk") || !sys.has("WriteGPT") {
		t.Fatalf("cmds = %v", sys.cmds)
	}
	if n := len(countCalls(sys.cmds, "format.com")); n != 3 { // ESP, C:, Recovery — the MSR has no filesystem
		t.Fatalf("format.com calls = %d, want 3", n)
	}
	diskGUID, parts, err := sys.ReadGPT(sys.vhdxDiskNumber[opts.Target.Path])
	if err != nil {
		t.Fatal(err)
	}
	if want := testLayoutWindows().SystemDisk().GUID; diskGUID != want {
		t.Fatalf("disk GUID = %q, want the recorded %q", diskGUID, want)
	}
	// Source attributes preserved, no-drive-letter bit OR-ed in on every
	// partition (winValidate, Task 13, clears it on root/data later).
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
	b, err := os.ReadFile(filepath.Join(dir, "rebuild-win-1-"+targetKey(opts.Target)+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var st runState
	if err := json.Unmarshal(b, &st); err != nil {
		t.Fatal(err)
	}
	if len(st.Volumes) != 3 || st.Volumes[2] != "" || st.Volumes[3] == "" {
		t.Fatalf("persisted volumes = %v, want partitions 1, 3, 4", st.Volumes)
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
// released, recovery/ESP folder mounts removed before root; the run's
// VHDX detach stays teardown's job (after winTeardown).
func TestWinTeardown_ReleasesEverythingRootLast(t *testing.T) {
	dir := t.TempDir()
	sys := newFakeWinSystem(dir)
	closed, released := 0, 0
	detached := false
	r := &run{opts: Options{WinSystem: sys}, winSys: sys,
		rootDir: filepath.Join(dir, "root"), recoveryDir: filepath.Join(dir, "recovery"), espDir: filepath.Join(dir, "esp"),
		hives:            map[string]winhive.Handle{"SYSTEM": closeCountingHandle{winhive.NewFake(), &closed}},
		espLetterRelease: func() error { released++; return nil },
		detach: func() error {
			if len(sys.unmounts) != 3 {
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
	if len(sys.unmounts) != 3 || sys.unmounts[2] != filepath.Join(dir, "root") {
		t.Fatalf("unmounts = %v, want root last", sys.unmounts)
	}
	if r.rootDir != "" || r.espDir != "" || r.recoveryDir != "" || r.hives != nil || r.espLetterRelease != nil {
		t.Fatalf("teardown left state behind: %+v", r)
	}
	r.teardown() // idempotent: nothing is released twice
	if closed != 1 || released != 1 || len(sys.unmounts) != 3 {
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
