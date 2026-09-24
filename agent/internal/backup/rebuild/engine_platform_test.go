package rebuild

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// R1: a Windows snapshot on a Linux host is refused before any manifest
// download or write.
func TestRun_RefusesPlatformHostMismatch_WindowsOnLinux(t *testing.T) {
	withHostPlatform(t, "linux")
	dir := t.TempDir()
	opts, _ := winFakeOptions(t, dir)
	opts.System = newFakeSystem(dir, 100*GiB)
	res, err := Run(context.Background(), opts)
	if err == nil || res == nil || res.Status != "refused" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if !strings.Contains(res.Refusal, `snapshot platform "windows" cannot be rebuilt on a linux host`) {
		t.Fatalf("refusal = %q", res.Refusal)
	}
	if res.PhaseReached != PhasePreflight {
		t.Fatalf("phaseReached = %v", res.PhaseReached)
	}
}

// R2: a Linux snapshot on a Windows host is refused (mirror of R1).
func TestRun_RefusesPlatformHostMismatch_LinuxOnWindows(t *testing.T) {
	withHostPlatform(t, "windows")
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	p := seedSnapshot(t, "lin-1", testLayout())
	res, err := Run(context.Background(), Options{SnapshotID: "lin-1", Provider: p, Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}, Identity: IdentityNew, StateDir: dir, StagingRoot: dir + "/mnt", System: sys})
	if err == nil || res == nil || res.Status != "refused" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if !strings.Contains(res.Refusal, `snapshot platform "linux" cannot be rebuilt on a windows host`) {
		t.Fatalf("refusal = %q", res.Refusal)
	}
}

// R3: darwin (or any unmapped GOOS) host returns ErrUnsupportedHost with no
// Result, before anything is fetched — matches the pre-W06 contract.
func TestRun_DarwinHostReturnsErrUnsupportedHost(t *testing.T) {
	withHostPlatform(t, "")
	dir := t.TempDir()
	p := seedSnapshot(t, "lin-1", testLayout())
	p.failKey = map[string]error{"snapshots/lin-1/layout.json": errors.New("layout must not be fetched on an unsupported host")}
	res, err := Run(context.Background(), Options{SnapshotID: "lin-1", Provider: p, Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}, Identity: IdentityNew, StateDir: dir, StagingRoot: dir + "/mnt", System: newFakeSystem(dir, 100*GiB)})
	if res != nil || !errors.Is(err, ErrUnsupportedHost) {
		t.Fatalf("res=%+v err=%v, want (nil, ErrUnsupportedHost)", res, err)
	}
}

// R4: a resume state file written on a different host/platform is refused.
func TestRun_RefusesResumeStateFromDifferentPlatform(t *testing.T) {
	withHostPlatform(t, "windows")
	dir := t.TempDir()
	opts, _ := winFakeOptions(t, dir)
	// Build the state file the way loadState/saveState would, but with a
	// stale Platform/HostOS pair.
	sPath := filepath.Join(dir, "rebuild-win-1-"+targetKey(opts.Target)+".json")
	// loadState only accepts a state file that carries a Plan (engine.go:212).
	stale := runState{SnapshotID: "win-1", TargetKey: targetKey(opts.Target), Plan: &Plan{}, Completed: map[Phase]bool{PhasePreflight: true}, Platform: "linux", HostOS: "linux"}
	b, _ := json.Marshal(stale)
	if err := os.WriteFile(sPath, b, 0o600); err != nil {
		t.Fatal(err)
	}
	res, err := Run(context.Background(), opts)
	if err == nil || res == nil || res.Status != "refused" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if !strings.Contains(res.Refusal, "resume state was written on a linux host for platform") {
		t.Fatalf("refusal = %q", res.Refusal)
	}
}

// R30: a stale HKLM\BRZ_* mount and an attached VHDX from a crashed run are
// released before preflight, with a warning, on a subsequent successful run.
func TestRun_CleanupLeftovers_UnloadsStaleHivesAndDetachesVHDX(t *testing.T) {
	withHostPlatform(t, "windows")
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	sys.staleHiveCount = 2
	sPath := filepath.Join(dir, "rebuild-win-1-"+targetKey(opts.Target)+".json")
	stale := runState{SnapshotID: "win-1", TargetKey: targetKey(opts.Target), Plan: &Plan{}, Completed: map[Phase]bool{PhaseProvision: true}, Platform: "windows", HostOS: "windows", Volumes: map[int]string{3: filepath.Join(dir, "stale-vol")}}
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
	res, _ := Run(context.Background(), opts) // at this task's commit the run stops at the staged winPreflight; only cleanup is under test
	if res == nil {
		t.Fatalf("expected a Result even on later failure, got nil")
	}
	var hiveWarn, vhdxWarn bool
	for _, w := range res.Warnings {
		hiveWarn = hiveWarn || strings.Contains(w, "unloaded 2 stale registry hive mount")
		vhdxWarn = vhdxWarn || strings.Contains(w, "detached a VHDX left attached")
	}
	if !hiveWarn || !vhdxWarn {
		t.Fatalf("warnings = %v, want both the stale-hive and the stale-VHDX cleanup warnings", res.Warnings)
	}
	if len(sys.staleHivesUnloaded) == 0 {
		t.Fatalf("UnloadStaleHives was not called")
	}
	if len(sys.detachedVHDXPaths) == 0 || sys.detachedVHDXPaths[0] != opts.Target.Path {
		t.Fatalf("detachedVHDXPaths = %v", sys.detachedVHDXPaths)
	}
}

// Existing Linux behavior must be unaffected: resolvePlatform runs Assess
// nowhere — a plain dry run still produces a Plan exactly as before.
func TestRun_LinuxDryRunUnaffectedByPlatformTable(t *testing.T) {
	withHostPlatform(t, "linux")
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	p := seedSnapshot(t, "snap-1", testLayout())
	res, err := Run(context.Background(), Options{SnapshotID: "snap-1", Provider: p, Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}, Identity: IdentityNew, StateDir: dir, StagingRoot: dir + "/mnt", DryRun: true, System: sys})
	if err != nil || res.Status != "completed" || res.Plan == nil || res.Platform != "linux" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}
