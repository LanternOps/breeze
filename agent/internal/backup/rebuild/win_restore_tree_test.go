package rebuild

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// With SkipBoot the staged applyWindowsSystemState hook warns, the restore
// phase completes, and StateApplied stays false. Part C Task 14 replaces
// this test when the hook becomes real.
func TestWinRestoreTree_SkipBootToleratesStagedSystemState(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, _ := winFakeOptions(t, dir)
	res, _ := Run(context.Background(), opts) // stops at the staged winValidate until Task 13
	if res == nil || res.StateApplied || !phaseCompleted(res, PhaseRestore) {
		t.Fatalf("res = %+v, want restore completed with StateApplied=false", res)
	}
	found := false
	for _, w := range res.Warnings {
		found = found || strings.Contains(w, "system state not applied (SkipBoot)")
	}
	if !found {
		t.Fatalf("warnings = %v, want the SkipBoot system-state warning", res.Warnings)
	}
}

// Ruling B1: the restore targets the root VOLUME path (r.volumes[root]),
// never the <staging>\root folder mount point — securefs refuses every
// reparse point below the volume root, and a folder mount point is one.
// The fake's volume path is the volume's backing directory (Ruling B1a),
// separate from the mount dir, so this discriminates the two.
func TestWinRestoreTree_RestoresIntoRootVolumeNotFolderMount(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	res, _ := Run(context.Background(), opts)
	if res == nil || !phaseCompleted(res, PhaseRestore) {
		t.Fatalf("res = %+v, want restore completed", res)
	}
	rootVol := sys.volumeDirForPartition(t, 3)
	if _, err := os.Stat(filepath.Join(rootVol, "ProgramData", "Breeze", "agent.yaml")); err != nil {
		t.Fatalf("restored file missing under the root volume %s: %v", rootVol, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "mnt", "root", "ProgramData")); !os.IsNotExist(err) {
		t.Fatalf("restore wrote through the folder mount point (err=%v); it must target the volume path", err)
	}
	// The folder mounts still exist for Part C's external tools.
	var rootMounted, recoveryMounted bool
	for _, m := range sys.mountLog {
		rootMounted = rootMounted || strings.HasSuffix(m, " "+filepath.Join(dir, "mnt", "root"))
		recoveryMounted = recoveryMounted || strings.HasSuffix(m, " "+filepath.Join(dir, "mnt", "recovery"))
	}
	if !rootMounted || !recoveryMounted {
		t.Fatalf("mountLog = %v, want root and recovery folder mounts", sys.mountLog)
	}
}

// Without SkipBoot the staged hook fails the restore phase. Part C Task 14
// deletes this test (the hook is real from then on).
func TestWinRestoreTree_FailsOnStagedSystemStateWithoutSkipBoot(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, _ := winFakeOptions(t, dir)
	opts.SkipBoot = false
	res, err := Run(context.Background(), opts)
	if err == nil || res == nil || res.Status != "failed" || res.PhaseReached != PhaseRestore {
		t.Fatalf("res=%+v err=%v, want a failed run at restore", res, err)
	}
	if !strings.Contains(res.Error, "arrive in W06c") {
		t.Fatalf("res.Error = %q", res.Error)
	}
}

// R29: resume after a failure in boot remounts from runState.Volumes and
// re-attaches the VHDX without re-running CreateVHDX/WriteGPT/Format.
func TestRun_ResumeAfterBootFailureRemountsFromPersistedVolumes(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	res1, _ := Run(context.Background(), opts)
	if res1 == nil || !phaseCompleted(res1, PhaseRestore) || res1.Plan == nil {
		t.Fatalf("first run did not get through restore: %+v", res1)
	}
	// Write the state a run that died in boot would have left behind
	// (whatever the first run saved is overwritten).
	vols := sys.volumePathsForDisk(sys.vhdxDiskNumber[opts.Target.Path])
	stale := runState{
		SnapshotID: "win-1", TargetKey: targetKey(opts.Target),
		Completed: map[Phase]bool{PhasePreflight: true, PhaseProvision: true, PhaseRestore: true},
		Platform:  "windows", HostOS: "windows", Plan: res1.Plan, Volumes: vols,
	}
	b, err := json.Marshal(stale)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "rebuild-win-1-"+targetKey(opts.Target)+".json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	sys.mu.Lock()
	sys.cmds = nil // observe only the resumed run
	sys.mountLog = nil
	sys.mu.Unlock()

	res2, _ := Run(context.Background(), opts)
	if res2 == nil || !res2.Resumed {
		t.Fatalf("resumed run: res=%+v", res2)
	}
	for _, c := range []string{"CreateVHDX", "WipeDisk", "WriteGPT", "format.com"} {
		if len(countCalls(sys.cmds, c)) != 0 {
			t.Fatalf("resume must not re-provision (%s ran): %v", c, sys.cmds)
		}
	}
	if len(countCalls(sys.cmds, "AttachVHDX")) != 1 {
		t.Fatalf("resume must re-attach the VHDX exactly once: %v", sys.cmds)
	}
	if want := vols[3] + " " + filepath.Join(dir, "mnt", "root"); len(countCalls(sys.mountLog, want)) != 1 {
		t.Fatalf("mountLog = %v, want the persisted root volume remounted once (%q)", sys.mountLog, want)
	}
}

func phaseCompleted(res *Result, ph Phase) bool {
	for _, p := range res.Phases {
		if p.Phase == ph && p.Status == PhaseCompleted {
			return true
		}
	}
	return false
}
