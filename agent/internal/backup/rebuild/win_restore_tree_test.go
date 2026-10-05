package rebuild

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

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

// Final-review Imp 1: a resumed run waits for the re-attached disk's
// volumes (a fresh attach surfaces them asynchronously) and rebuilds
// r.volumes from the LIVE disk by partition number — the state file's
// paths are only the expectation. The persisted paths here are stale, so a
// resume that trusted them would validate against the wrong directory.
func TestRun_ResumeWaitsForLiveVolumesAndUsesTheirPaths(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	res1, _ := Run(context.Background(), opts)
	if res1 == nil || !phaseCompleted(res1, PhaseRestore) || res1.Plan == nil {
		t.Fatalf("first run did not get through restore: %+v", res1)
	}
	live := sys.volumePathsForDisk(sys.vhdxDiskNumber[opts.Target.Path])
	stale := map[int]string{}
	for n := range live {
		stale[n] = fmt.Sprintf(`\\?\Volume{stale-%d}\`, n)
	}
	st := runState{
		SnapshotID: "win-1", TargetKey: targetKey(opts.Target),
		Completed: map[Phase]bool{PhasePreflight: true, PhaseProvision: true, PhaseRestore: true},
		Platform:  "windows", HostOS: "windows", Plan: res1.Plan, Volumes: stale,
	}
	b, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "rebuild-win-1-"+targetKey(opts.Target)+".json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	sys.mu.Lock()
	sys.cmds, sys.mountLog = nil, nil
	sys.hideVolumesCalls = 3 // the re-attached disk's volumes are not there yet
	sys.mu.Unlock()

	res2, err := Run(context.Background(), opts)
	if err != nil || res2 == nil || !res2.Resumed || res2.Status != "completed" {
		t.Fatalf("resumed run: res=%+v err=%v", res2, err)
	}
	if len(countCalls(sys.cmds, "WaitForVolumes")) == 0 {
		t.Fatalf("resume must wait for the re-attached volumes: %v", sys.cmds)
	}
	if want := live[3] + " " + filepath.Join(dir, "mnt", "root"); len(countCalls(sys.mountLog, want)) != 1 {
		t.Fatalf("mountLog = %v, want the LIVE root volume mounted (%q)", sys.mountLog, want)
	}
	for _, c := range sys.cmds {
		if strings.Contains(c, "stale-") {
			t.Fatalf("a persisted (stale) volume path reached the seam: %q", c)
		}
	}
}

// Final-review Imp 1: a partition the earlier run recorded that has no
// volume on the live disk fails the resume.
func TestRun_ResumeFailsWhenRecordedPartitionIsMissing(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	res1, _ := Run(context.Background(), opts)
	if res1 == nil || res1.Plan == nil {
		t.Fatalf("first run: %+v", res1)
	}
	vols := sys.volumePathsForDisk(sys.vhdxDiskNumber[opts.Target.Path])
	// Same count as the live disk (so WaitForVolumes is satisfied), but one
	// recorded partition number the disk does not have.
	delete(vols, 4)
	vols[9] = `\\?\Volume{gone}\`
	st := runState{
		SnapshotID: "win-1", TargetKey: targetKey(opts.Target),
		Completed: map[Phase]bool{PhasePreflight: true, PhaseProvision: true, PhaseRestore: true},
		Platform:  "windows", HostOS: "windows", Plan: res1.Plan, Volumes: vols,
	}
	b, _ := json.Marshal(st)
	if err := os.WriteFile(filepath.Join(dir, "rebuild-win-1-"+targetKey(opts.Target)+".json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	res2, err := Run(context.Background(), opts)
	if err == nil || res2 == nil || res2.Status != "failed" || !strings.Contains(res2.Error, "partition 9") {
		t.Fatalf("res=%+v err=%v, want a failed resume naming partition 9", res2, err)
	}
}

// 18b row 1: a resume reclaims drive letters a crashed earlier process left
// attached to the live disk (winBoot's ESP letter, or a Format retry's
// temporary letter) — the resumed process never held r.espLetterRelease
// for them, so they would otherwise leak for the life of the attach.
func TestRun_ResumeReclaimsLeakedDriveLetters(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	opts.SkipBoot = false
	res1, _ := Run(context.Background(), opts)
	if res1 == nil || !phaseCompleted(res1, PhaseRestore) || res1.Plan == nil {
		t.Fatalf("first run did not get through restore: %+v", res1)
	}
	vols := sys.volumePathsForDisk(sys.vhdxDiskNumber[opts.Target.Path])
	st := runState{
		SnapshotID: "win-1", TargetKey: targetKey(opts.Target),
		Completed: map[Phase]bool{PhasePreflight: true, PhaseProvision: true, PhaseRestore: true},
		Platform:  "windows", HostOS: "windows", Plan: res1.Plan, Volumes: vols,
	}
	b, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "rebuild-win-1-"+targetKey(opts.Target)+".json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	// Simulate the earlier (crashed) process's leaked ESP letter: the live
	// disk still has it, but this resumed process never assigned it.
	espGUIDPath := sys.volumeDirForPartition(t, 1)
	sys.mu.Lock()
	sys.letters[espGUIDPath] = "Y"
	sys.cmds = nil // observe only the resumed run
	sys.mountLog = nil
	sys.mu.Unlock()

	res2, err := Run(context.Background(), opts)
	if err != nil || res2 == nil || !res2.Resumed || res2.Status != "completed" {
		t.Fatalf("resumed run: res=%+v err=%v", res2, err)
	}
	sys.mu.Lock()
	cmds := append([]string(nil), sys.cmds...)
	_, stillLeaked := sys.letters[espGUIDPath]
	sys.mu.Unlock()
	if stillLeaked {
		t.Fatalf("cmds = %v, ESP letter Y: was never reclaimed", cmds)
	}
	waitIdx, unmountIdx, bootIdx := -1, -1, -1
	for i, c := range cmds {
		switch {
		case strings.HasPrefix(c, "WaitForVolumes") && waitIdx == -1:
			waitIdx = i
		case c == "UnmountVolume Y:" && unmountIdx == -1:
			unmountIdx = i
		case strings.Contains(c, `\System32\bcdboot.exe`) && bootIdx == -1:
			bootIdx = i
		}
	}
	if waitIdx == -1 || unmountIdx == -1 || bootIdx == -1 {
		t.Fatalf("cmds = %v, want WaitForVolumes, UnmountVolume Y:, and a bcdboot.exe run", cmds)
	}
	if waitIdx >= unmountIdx || unmountIdx >= bootIdx {
		t.Fatalf("cmds = %v, want the leaked letter reclaimed after WaitForVolumes and before bcdboot", cmds)
	}
	// Lab L2: a successful reclaim is observable in the result, one line
	// per letter.
	reclaimed := 0
	for _, w := range res2.Warnings {
		if strings.Contains(w, "reclaimed drive letter Y:") {
			reclaimed++
		}
	}
	if reclaimed != 1 {
		t.Fatalf("warnings = %v, want exactly one line reporting the reclaimed letter Y:", res2.Warnings)
	}
}

// Fix round 1 / MINOR 1: between WaitForVolumes observing a leaked drive
// letter and the reclaim loop running, the OS could reassign that letter to
// a different volume. winReattach must reconfirm on the real seam
// (VolumeForLetter) before unmounting — reclaiming a letter that now maps
// elsewhere would rip that OTHER volume's mount out from under it.
func TestRun_ResumeSkipsLetterReclaimWhenLetterPointsElsewhere(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	opts.SkipBoot = false
	res1, _ := Run(context.Background(), opts)
	if res1 == nil || !phaseCompleted(res1, PhaseRestore) || res1.Plan == nil {
		t.Fatalf("first run did not get through restore: %+v", res1)
	}
	vols := sys.volumePathsForDisk(sys.vhdxDiskNumber[opts.Target.Path])
	st := runState{
		SnapshotID: "win-1", TargetKey: targetKey(opts.Target),
		Completed: map[Phase]bool{PhasePreflight: true, PhaseProvision: true, PhaseRestore: true},
		Platform:  "windows", HostOS: "windows", Plan: res1.Plan, Volumes: vols,
	}
	b, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "rebuild-win-1-"+targetKey(opts.Target)+".json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	espGUIDPath := sys.volumeDirForPartition(t, 1)
	sys.mu.Lock()
	sys.letters[espGUIDPath] = "Y" // WaitForVolumes will report this letter
	// But VolumeForLetter("Y:") answers a DIFFERENT volume — simulating the
	// OS having reassigned Y: to something else in the interim.
	sys.letterOverride = map[string]string{"Y": `\\?\Volume{reassigned}\`}
	sys.cmds = nil
	sys.mountLog = nil
	sys.mu.Unlock()

	res2, err := Run(context.Background(), opts)
	if err != nil || res2 == nil || !res2.Resumed || res2.Status != "completed" {
		t.Fatalf("resumed run: res=%+v err=%v", res2, err)
	}
	sys.mu.Lock()
	cmds := append([]string(nil), sys.cmds...)
	sys.mu.Unlock()
	if len(countCalls(cmds, "UnmountVolume Y:")) != 0 {
		t.Fatalf("cmds = %v, must NOT unmount Y: once it no longer maps to our volume", cmds)
	}
	found := false
	for _, w := range res2.Warnings {
		if strings.Contains(w, "Y:") && strings.Contains(w, "no longer maps") {
			found = true
		}
	}
	if !found {
		t.Fatalf("warnings = %v, want one about Y: no longer mapping to our volume", res2.Warnings)
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

// A rebuild restores the machine the recorded principals belong to, from an
// environment that recognises none of them: descriptors apply as captured.
// A plain restore never does (the flag is never set from a command payload).
func TestWinRestoreTree_AppliesSecurityDescriptorsAsCaptured(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, _ := winFakeOptions(t, dir)
	var asCaptured, called bool
	orig := restoreSnapshotFiles
	restoreSnapshotFiles = func(ctx context.Context, p providers.BackupProvider, cfg backup.RestoreConfig, fn backup.ProgressFunc) (*backup.RestoreResult, error) {
		called, asCaptured = true, cfg.SecurityDescriptorsAsCaptured
		return orig(ctx, p, cfg, fn)
	}
	t.Cleanup(func() { restoreSnapshotFiles = orig })
	if _, err := Run(context.Background(), opts); err != nil && !called {
		t.Fatal(err)
	}
	if !called || !asCaptured {
		t.Fatalf("called=%v asCaptured=%v, want the Windows rebuild to apply descriptors as captured", called, asCaptured)
	}
}

// #7325: a rebuild recreates junctions pointing where they pointed on the
// source machine. The restore writes through a recovery-time volume path, so
// rewriting the target under it would leave every profile junction pointing
// at a drive letter the rebuilt machine does not have.
func TestWinRestoreTree_KeepsJunctionTargetsAsCaptured(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, _ := winFakeOptions(t, dir)
	var asCaptured, called bool
	orig := restoreSnapshotFiles
	restoreSnapshotFiles = func(ctx context.Context, p providers.BackupProvider, cfg backup.RestoreConfig, fn backup.ProgressFunc) (*backup.RestoreResult, error) {
		called, asCaptured = true, cfg.JunctionTargetsAsCaptured
		return orig(ctx, p, cfg, fn)
	}
	t.Cleanup(func() { restoreSnapshotFiles = orig })
	if _, err := Run(context.Background(), opts); err != nil && !called {
		t.Fatal(err)
	}
	if !called || !asCaptured {
		t.Fatalf("called=%v asCaptured=%v, want the Windows rebuild to keep junction targets as captured", called, asCaptured)
	}
}
