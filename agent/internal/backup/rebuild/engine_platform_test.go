package rebuild

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	// A fake WinSystem, never nil: with WinSystem unset, Run on the real
	// Windows CI runner would build the real NewWinSystem and sweep the
	// runner's own HKLM\BRZ_* mounts before refusing.
	winSys := newFakeWinSystem(dir)
	res, err := Run(context.Background(), Options{SnapshotID: "lin-1", Provider: p, Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}, Identity: IdentityNew, StateDir: dir, StagingRoot: dir + "/mnt", System: sys, WinSystem: winSys})
	if err == nil || res == nil || res.Status != "refused" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if len(winSys.staleHivesUnloaded) == 0 {
		t.Fatalf("cleanupLeftovers did not reach the injected fake WinSystem")
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
	res, _ := Run(context.Background(), opts) // only cleanupLeftovers is under test; whatever the run does after it is not
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

// D20: driver injection is not supported yet. A non-empty DriverDirs is
// refused before the run does anything at all — no leftover cleanup, no
// state-file removal (even with ForceReprovision), no layout fetch, no
// WinSystem call — on every host platform, with one operator-facing reason.
func TestRun_RefusesDriverDirsBeforeAnything(t *testing.T) {
	for _, host := range []string{"windows", "linux"} {
		t.Run(host, func(t *testing.T) {
			withHostPlatform(t, host)
			dir := t.TempDir()
			opts, sys := winFakeOptions(t, dir)
			opts.System = newFakeSystem(dir, 100*GiB)
			opts.DriverDirs = []string{`X:\drv`}
			opts.ForceReprovision = true
			sys.staleHiveCount = 1
			p := opts.Provider.(*memProvider)
			p.failKey = map[string]error{"snapshots/win-1/layout.json": errors.New("layout must not be fetched when driver injection is refused")}
			sPath := filepath.Join(dir, "rebuild-win-1-"+targetKey(opts.Target)+".json")
			if err := os.WriteFile(sPath, []byte(`{"snapshotId":"win-1"}`), 0o600); err != nil {
				t.Fatal(err)
			}

			res, err := Run(context.Background(), opts)
			var ref *RefusalError
			if !errors.As(err, &ref) || res == nil || res.Status != "refused" {
				t.Fatalf("res=%+v err=%v, want a refusal", res, err)
			}
			if res.Refusal != DriverInjectionUnsupportedReason || ref.Reason != DriverInjectionUnsupportedReason {
				t.Fatalf("refusal = %q, want %q", res.Refusal, DriverInjectionUnsupportedReason)
			}
			if res.PhaseReached != PhasePreflight || len(res.Phases) != 1 || res.Phases[0].Status != PhaseRefused {
				t.Fatalf("phases = %+v, want one refused preflight row", res.Phases)
			}
			if len(sys.cmds) != 0 || len(sys.staleHivesUnloaded) != 0 || len(sys.detachedVHDXPaths) != 0 {
				t.Fatalf("WinSystem touched before the refusal: cmds=%v hives=%v detached=%v", sys.cmds, sys.staleHivesUnloaded, sys.detachedVHDXPaths)
			}
			if _, err := os.Stat(sPath); err != nil {
				t.Fatalf("state file removed before the refusal: %v", err)
			}
		})
	}
}

func withStateStagingParent(t *testing.T, dir string) {
	t.Helper()
	prev := stateStagingParent
	stateStagingParent = func() string { return dir }
	t.Cleanup(func() { stateStagingParent = prev })
}

func withProcessAlive(t *testing.T, fn func(pid int) bool) {
	t.Helper()
	prev := processAlive
	processAlive = fn
	t.Cleanup(func() { processAlive = prev })
}

// Lab L2: a hard-killed run leaves its system-state staging dir (a copy of
// the backup's registry hives) in TEMP, and nothing removed it. The next
// run's startup cleanup removes staging dirs this engine created whose
// owning process is gone (legacy unowned names only once they are a day
// old) — never a live process's, never this process's, never anything
// else in TEMP — and says so in the result.
func TestRun_CleanupLeftovers_RemovesStaleStateStaging(t *testing.T) {
	withHostPlatform(t, "windows")
	dir := t.TempDir()
	tmp := t.TempDir()
	withStateStagingParent(t, tmp)
	const deadPID, livePID = 999991, 999992
	withProcessAlive(t, func(pid int) bool { return pid == livePID })
	mk := func(name string, age time.Duration) string {
		t.Helper()
		p := filepath.Join(tmp, name)
		if err := os.MkdirAll(filepath.Join(p, "registry"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(p, "registry", "SYSTEM"), []byte("hive"), 0o600); err != nil {
			t.Fatal(err)
		}
		if age > 0 {
			old := time.Now().Add(-age)
			if err := os.Chtimes(p, old, old); err != nil {
				t.Fatal(err)
			}
		}
		return p
	}
	dead := mk(fmt.Sprintf("breeze-rebuild-state-%d-111", deadPID), 0)
	legacyOld := mk("breeze-rebuild-state-303156243", 48*time.Hour)
	keep := []string{
		mk(fmt.Sprintf("breeze-rebuild-state-%d-222", livePID), 48*time.Hour),     // owner still running
		mk(fmt.Sprintf("breeze-rebuild-state-%d-333", os.Getpid()), 48*time.Hour), // this process
		mk("breeze-rebuild-state-404", 0),                                         // legacy, too recent to call stale
		mk("breeze-rebuild-state-abc", 48*time.Hour),                              // not a name this engine makes
		mk("breeze-rebuild-other-1-1", 48*time.Hour),                              // different prefix
	}
	file := filepath.Join(tmp, fmt.Sprintf("breeze-rebuild-state-%d-444", deadPID)) // a file, not a dir
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	keep = append(keep, file)

	opts, _ := winFakeOptions(t, dir)
	res, _ := Run(context.Background(), opts) // only cleanupLeftovers is under test
	if res == nil {
		t.Fatal("expected a Result")
	}
	for _, p := range []string{dead, legacyOld} {
		if _, err := os.Stat(p); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("stale staging dir %s survived startup cleanup (stat err %v)", p, err)
		}
	}
	for _, p := range keep {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("%s must be left alone: %v", p, err)
		}
	}
	found := false
	for _, w := range res.Warnings {
		found = found || strings.Contains(w, "removed 2 stale system-state staging dir(s)")
	}
	if !found {
		t.Fatalf("warnings = %v, want the stale-staging cleanup reported", res.Warnings)
	}
}

// The staging dir name carries the creating process's id — the property the
// startup sweep relies on to never touch a live run's dir.
func TestNewStateStagingDir_NameCarriesOwnerPID(t *testing.T) {
	withStateStagingParent(t, t.TempDir())
	d, err := newStateStagingDir()
	if err != nil {
		t.Fatal(err)
	}
	pid, ok := stateStagingOwner(filepath.Base(d))
	if !ok || pid != os.Getpid() {
		t.Fatalf("stateStagingOwner(%q) = %d, %v; want %d, true", filepath.Base(d), pid, ok, os.Getpid())
	}
}

// processAlive (the real, per-OS seam): this process is alive; a child that
// has exited is not.
func TestProcessAlive(t *testing.T) {
	if !processAlive(os.Getpid()) {
		t.Fatal("processAlive(self) = false")
	}
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	if processAlive(cmd.Process.Pid) {
		t.Fatalf("processAlive(%d) = true for an exited child", cmd.Process.Pid)
	}
}
