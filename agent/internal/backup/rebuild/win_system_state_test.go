package rebuild

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

// With the real hook a SkipBoot run applies the state: StateApplied, the
// fake SYSTEM hive's MountedDevices maps C: to the recorded root GUID.
func TestWinRestoreTree_AppliesSystemStateUnderSkipBoot(t *testing.T) {
	withHostPlatformWindows(t)
	opts, sys := winFakeOptions(t, t.TempDir())
	res, err := Run(context.Background(), opts)
	if err != nil || res.Status != "completed" || !res.StateApplied {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	assertRootMapped(t, sys.hives["SYSTEM"])
	for _, w := range res.Warnings {
		if strings.Contains(w, "restored from the system-state artifacts") {
			t.Fatalf("tree had all four hives; unexpected fallback warning %q", w)
		}
	}
}

// Review Focus 2: a Windows snapshot captured WITHOUT VSS (OriginalPath
// empty, SourcePath = C:\...) restores, finds its hives in the tree and
// validates, all keyed by the same stripped path.
func TestHiveSource_TreeWithoutOriginalPath(t *testing.T) {
	withHostPlatformWindows(t)
	opts, sys := winFakeOptions(t, t.TempDir())
	p := opts.Provider.(*memProvider)
	key := "snapshots/win-1/manifest.json"
	var man backup.Snapshot
	if err := json.Unmarshal(p.files[key], &man); err != nil {
		t.Fatal(err)
	}
	for i := range man.Files {
		man.Files[i].SourcePath, man.Files[i].OriginalPath = man.Files[i].OriginalPath, ""
	}
	b, _ := json.Marshal(man)
	p.files[key] = b
	res, err := Run(context.Background(), opts)
	if err != nil || res.Status != "completed" || !res.StateApplied {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	for _, w := range res.Warnings {
		if strings.Contains(w, "restored from the system-state artifacts") {
			t.Fatalf("hives were not found in the no-VSS tree: %q", w)
		}
	}
	assertRootMapped(t, sys.hives["SYSTEM"])
}

// R15 (restore-phase leg through the engine): no staged artifact, a DC in
// the tree → the run fails at restore before any hive edit.
func TestWinRestoreTree_DomainControllerInTreeFails(t *testing.T) {
	withHostPlatformWindows(t)
	opts, sys := winFakeOptions(t, t.TempDir())
	p := opts.Provider.(*memProvider)
	delete(p.files, "snapshots/win-1/system-state/manifest.json") // preflight has no artifact to check
	_, _ = sys.hives["SYSTEM"].CreateKey(`ControlSet001\Services\NTDS`)
	res, err := Run(context.Background(), opts)
	if err == nil || res.Status != "failed" || res.PhaseReached != PhaseRestore || !strings.Contains(res.Error, "source is a domain controller") {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	md, _ := sys.hives["SYSTEM"].OpenKey("MountedDevices")
	if v, _ := md.ValueNames(); len(v) != 0 {
		t.Fatalf("MountedDevices was edited before the DC refusal: %v", v)
	}
}

func assertRootMapped(t *testing.T, system *winhive.Fake) {
	t.Helper()
	md, err := system.OpenKey("MountedDevices")
	if err != nil {
		t.Fatal(err)
	}
	got, err := md.GetBinary(`\DosDevices\C:`)
	if err != nil || len(got) != 24 || string(got[:8]) != "DMIO:ID:" {
		t.Fatalf(`\DosDevices\C: = % x, %v`, got, err)
	}
	// testWindowsRootPartUUID 6a1e0000-0000-4000-8000-000000000003, mixed-endian.
	if want := "\x00\x00\x1e\x6a\x00\x00\x00\x40\x80\x00\x00\x00\x00\x00\x00\x03"; string(got[8:]) != want {
		t.Fatalf("C: GUID bytes = % x", got[8:])
	}
}

// countingHandle is a loaded hive whose Close is counted and may fail.
type countingHandle struct {
	*winhive.Fake
	closes *int
	err    error
}

func (h countingHandle) Close() error { *h.closes++; return h.err }

func hiveRun(t *testing.T) (*run, *fakeWinSystem, string) {
	t.Helper()
	dir := t.TempDir()
	sys := newFakeWinSystem(dir)
	seedFakeHives(sys)
	vol := filepath.Join(dir, "vol-root")
	r := &run{opts: Options{WinSystem: sys, Target: Target{Kind: TargetVHDX, Path: filepath.Join(dir, "out.vhdx")}},
		rootVolume: vol, rootDir: filepath.Join(dir, "mnt", "root"), result: &Result{}}
	return r, sys, vol
}

// Ruling C1/C5: hives load from the root VOLUME path under the run-scoped
// mount name, a second call is a no-op, and a close/ensure cycle (winBoot
// closes before DISM/bcdboot, winIdentity reloads) loads them afresh.
func TestEnsureWinHives_LoadsFromRootVolumeAndIsReentrant(t *testing.T) {
	r, sys, vol := hiveRun(t)
	if err := r.ensureWinHives(); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(vol, "Windows", "System32", "config")
	want := []string{
		"LoadHive " + filepath.Join(cfg, "SYSTEM") + " " + hiveMountName(r, "SYSTEM"),
		"LoadHive " + filepath.Join(cfg, "SOFTWARE") + " " + hiveMountName(r, "SOFTWARE"),
	}
	if got := countCalls(sys.cmds, "LoadHive"); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("loads = %v, want %v", got, want)
	}
	if !strings.HasPrefix(hiveMountName(r, "SYSTEM"), "BRZ_"+targetKey(r.opts.Target)+"_") {
		t.Fatalf("mount name %q is not run-scoped", hiveMountName(r, "SYSTEM"))
	}
	if len(r.controlSets) != 1 || r.controlSets[0] != "ControlSet001" {
		t.Fatalf("controlSets = %v", r.controlSets)
	}
	if err := r.ensureWinHives(); err != nil {
		t.Fatal(err)
	}
	if n := len(countCalls(sys.cmds, "LoadHive")); n != 2 {
		t.Fatalf("second ensureWinHives reloaded loaded hives: %v", sys.cmds)
	}
	if err := r.closeWinHives(); err != nil || r.hives != nil {
		t.Fatalf("closeWinHives = %v, hives = %v", err, r.hives)
	}
	if err := r.ensureWinHives(); err != nil {
		t.Fatal(err)
	}
	if n := len(countCalls(sys.cmds, "LoadHive")); n != 4 || len(r.hives) != 2 {
		t.Fatalf("reload after close: loads=%d hives=%v", n, r.hives)
	}
}

// A partially loaded set loads only what is missing (a second RegLoadKeyW
// of a mounted name would fail on a real host).
func TestEnsureWinHives_LoadsOnlyMissingHive(t *testing.T) {
	r, sys, _ := hiveRun(t)
	r.hives = map[string]winhive.Handle{"SYSTEM": sys.hives["SYSTEM"]}
	if err := r.ensureWinHives(); err != nil {
		t.Fatal(err)
	}
	if got := countCalls(sys.cmds, "LoadHive"); len(got) != 1 || !strings.Contains(got[0], "SOFTWARE") {
		t.Fatalf("loads = %v, want only SOFTWARE", got)
	}
}

// A failed load unloads what this call loaded and leaves nothing behind.
func TestEnsureWinHives_FailureUnloadsWhatItLoaded(t *testing.T) {
	r, sys, vol := hiveRun(t)
	sys.fail["LoadHive "+filepath.Join(vol, "Windows", "System32", "config", "SOFTWARE")] = errors.New("boom")
	closes := 0
	sys.hives["SYSTEM"] = winhive.NewFake()
	r.opts.WinSystem = loadWrapper{sys, func(h winhive.Handle) winhive.Handle {
		return countingHandle{Fake: h.(*winhive.Fake), closes: &closes}
	}}
	if err := r.ensureWinHives(); err == nil || !strings.Contains(err.Error(), "load SOFTWARE hive") {
		t.Fatalf("err = %v", err)
	}
	if closes != 1 || len(r.hives) != 0 {
		t.Fatalf("SYSTEM closes = %d, hives = %v; want SYSTEM unloaded and nothing left", closes, r.hives)
	}
}

// Ruling C5: every hive is closed, the first failure is returned, and
// r.hives is cleared regardless.
func TestCloseWinHives_ClosesAllReturnsFirstErrorAndClears(t *testing.T) {
	r, _, _ := hiveRun(t)
	closes := 0
	r.hives = map[string]winhive.Handle{
		"SOFTWARE": countingHandle{Fake: winhive.NewFake(), closes: &closes, err: errors.New("software leaked")},
		"SYSTEM":   countingHandle{Fake: winhive.NewFake(), closes: &closes, err: errors.New("system leaked")},
	}
	err := r.closeWinHives()
	if err == nil || !strings.Contains(err.Error(), "unload SOFTWARE hive: software leaked") {
		t.Fatalf("err = %v, want the first (sorted) unload failure", err)
	}
	if closes != 2 || r.hives != nil {
		t.Fatalf("closes = %d, hives = %v; want both closed and the map cleared", closes, r.hives)
	}
}

// loadWrapper wraps every LoadHive result.
type loadWrapper struct {
	*fakeWinSystem
	wrap func(winhive.Handle) winhive.Handle
}

func (w loadWrapper) LoadHive(file, mount string) (winhive.Handle, error) {
	h, err := w.fakeWinSystem.LoadHive(file, mount)
	if err != nil {
		return nil, err
	}
	return w.wrap(h), nil
}

func (w loadWrapper) LoadHiveReadOnly(file, mount string) (winhive.Handle, error) {
	h, err := w.fakeWinSystem.LoadHiveReadOnly(file, mount)
	if err != nil {
		return nil, err
	}
	return w.wrap(h), nil
}

// Fix round 1: winTeardown unloads through closeWinHives — every hive is
// closed, the failure is a warning, and r.hives is cleared.
func TestWinTeardown_ClosesHivesThroughCloseWinHives(t *testing.T) {
	r, _, _ := hiveRun(t)
	closes := 0
	r.hives = map[string]winhive.Handle{
		"SOFTWARE": countingHandle{Fake: winhive.NewFake(), closes: &closes},
		"SYSTEM":   countingHandle{Fake: winhive.NewFake(), closes: &closes, err: errors.New("leaked handle")},
	}
	r.rootDir = ""
	r.winTeardown()
	if closes != 2 || r.hives != nil {
		t.Fatalf("closes = %d, hives = %v", closes, r.hives)
	}
	if len(r.warnings) != 1 || !strings.Contains(r.warnings[0], "unload SYSTEM hive: leaked handle") {
		t.Fatalf("warnings = %v", r.warnings)
	}
}
