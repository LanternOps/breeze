package rebuild

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

// The fake's SystemRoot-less default: the host tools' absolute paths.
const (
	testHostBcdboot = `C:\Windows\System32\bcdboot.exe`
	testHostDism    = `C:\Windows\System32\dism.exe`
)

// newBootRun: a fake disk whose ESP (partition 1) is a real volume, so the
// fake bcdboot (ruling C7) can find it by its /s letter and seed it.
// r.rootDir is only ever a tool argument (ruling C1).
func newBootRun(t *testing.T, kind TargetKind) (*run, *fakeWinSystem) {
	t.Helper()
	t.Setenv("SystemRoot", "")
	sys := newFakeWinSystem(t.TempDir())
	if err := sys.WriteGPT(1, "disk-guid", []WinGPTPartition{
		{Number: 1, TypeGUID: layout.GUIDEFISystem, PartGUID: "esp", SizeBytes: 100 * MiB},
		{Number: 3, TypeGUID: layout.GUIDMicrosoftBasic, PartGUID: "root", SizeBytes: 60 * GiB},
	}); err != nil {
		t.Fatal(err)
	}
	sys.cmds = nil
	staging := t.TempDir()
	r := &run{
		opts:    Options{WinSystem: sys, Target: Target{Kind: kind}},
		staging: staging, rootDir: filepath.Join(staging, "root"), result: &Result{},
		rootVolume: sys.volumeDirForPartition(t, 3),
		espVolume:  sys.volumeDirForPartition(t, 1),
	}
	return r, sys
}

func TestBcdbootArgs(t *testing.T) {
	root := filepath.Join("mnt", "root")
	if got := strings.Join(bcdbootArgs(root, "Z", false), " "); got != filepath.Join(root, "Windows")+" /s Z: /f UEFI /v" {
		t.Fatalf("disk args = %q", got)
	}
	if got := strings.Join(bcdbootArgs(root, "Z", true), " "); got != filepath.Join(root, "Windows")+" /s Z: /f UEFI /v /p" {
		t.Fatalf("vhdx args = %q (R27: /p on vhdx only)", got)
	}
}

// Ruling C4: host tools resolve from %SystemRoot%\System32 by absolute
// path, never PATH; an empty or non-drive-absolute SystemRoot falls back to
// C:\Windows.
func TestHostSystemTool(t *testing.T) {
	for _, tc := range []struct{ env, want string }{
		{"", `C:\Windows\System32\bcdboot.exe`},
		{`X:\Windows`, `X:\Windows\System32\bcdboot.exe`},
		{`D:\WinNT\`, `D:\WinNT\System32\bcdboot.exe`},
		{`Windows`, `C:\Windows\System32\bcdboot.exe`},
		{`\\server\share\Windows`, `C:\Windows\System32\bcdboot.exe`},
	} {
		t.Setenv("SystemRoot", tc.env)
		if got := hostSystemTool("bcdboot.exe"); got != tc.want {
			t.Errorf("SystemRoot=%q: got %q, want %q", tc.env, got, tc.want)
		}
	}
}

// Ruling C4 (SECURITY): the restored tree's bcdboot.exe is NEVER executed,
// even when present; the host's absolute System32 binary is, with no /p on
// a disk target. bootx64.efi is ensured through the ESP VOLUME (ruling C1).
func TestWinBoot_HostBcdbootNeverTreeCopy(t *testing.T) {
	r, sys := newBootRun(t, TargetDisk)
	for _, base := range []string{r.rootDir, r.rootVolume} {
		inTree := filepath.Join(base, "Windows", "System32", "bcdboot.exe")
		if err := os.MkdirAll(filepath.Dir(inTree), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(inTree, []byte("exe"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := winBoot(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	for _, c := range sys.cmds {
		if strings.Contains(c, "bcdboot.exe") && !strings.HasPrefix(c, testHostBcdboot+" ") {
			t.Fatalf("a non-host bcdboot ran: %q (all: %v)", c, sys.cmds)
		}
	}
	calls := countCalls(sys.cmds, testHostBcdboot)
	want := testHostBcdboot + " " + filepath.Join(r.rootDir, "Windows") + " /s Z: /f UEFI /v"
	if len(calls) != 1 || calls[0] != want {
		t.Fatalf("bcdboot calls = %v, want [%q]", calls, want)
	}
	got, err := os.ReadFile(filepath.Join(r.espVolume, "EFI", "Boot", "bootx64.efi"))
	if err != nil {
		t.Fatalf("bootx64.efi not ensured on the ESP volume: %v", err)
	}
	mgr, _ := os.ReadFile(filepath.Join(r.espVolume, "EFI", "Microsoft", "Boot", "bootmgfw.efi"))
	if string(got) != string(mgr) || len(got) == 0 {
		t.Fatalf("bootx64.efi = %q, want a copy of bootmgfw.efi %q", got, mgr)
	}
	for _, w := range r.warnings {
		if strings.Contains(w, "host bcdboot") {
			t.Fatalf("no fallback concept exists any more (C4): %v", r.warnings)
		}
	}
}

// R27 vhdx: /p present; the ESP folder mount is never used (C1).
func TestWinBoot_VhdxAddsP(t *testing.T) {
	r, sys := newBootRun(t, TargetVHDX)
	if err := winBoot(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	calls := countCalls(sys.cmds, testHostBcdboot)
	if len(calls) != 1 || !strings.HasSuffix(calls[0], " /s Z: /f UEFI /v /p") {
		t.Fatalf("bcdboot calls = %v", sys.cmds)
	}
	for _, c := range sys.cmds {
		if strings.HasPrefix(c, "bcdedit") || strings.Contains(c, `\bcdedit`) {
			t.Fatalf("bcdedit must never run (C6): %v", sys.cmds)
		}
	}
}

// Ruling C4: a host without bcdboot.exe fails with a clear error naming the
// host path; no other binary is tried.
func TestWinBoot_MissingHostBcdbootFails(t *testing.T) {
	r, sys := newBootRun(t, TargetDisk)
	sys.fail[testHostBcdboot] = &fs.PathError{Op: "exec", Path: testHostBcdboot, Err: fs.ErrNotExist}
	err := winBoot(context.Background(), r)
	if err == nil || !strings.Contains(err.Error(), "rebuild host has no bcdboot.exe at "+testHostBcdboot) {
		t.Fatalf("err = %v", err)
	}
	if got := countCalls(sys.cmds, testHostBcdboot); len(got) != 1 {
		t.Fatalf("bcdboot calls = %v", sys.cmds)
	}
}

// A bcdboot failure carries its output.
func TestWinBoot_BcdbootFailureCarriesOutput(t *testing.T) {
	r, sys := newBootRun(t, TargetDisk)
	sys.fail[testHostBcdboot] = errors.New("exit status 1")
	err := winBoot(context.Background(), r)
	if err == nil || !strings.Contains(err.Error(), "bcdboot") || !strings.Contains(err.Error(), "simulated failure") {
		t.Fatalf("err = %v", err)
	}
}

// Ruling F9: the ESP letter's release is kept in r.espLetterRelease (the
// letter stays assigned) and winTeardown releases it.
func TestWinBoot_LetterReleasedByTeardown(t *testing.T) {
	r, sys := newBootRun(t, TargetDisk)
	if err := winBoot(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if r.espLetterRelease == nil || sys.letters[r.espVolume] != "Z" {
		t.Fatalf("release=%v letters=%v; want the ESP letter still assigned and its release stored", r.espLetterRelease != nil, sys.letters)
	}
	r.rootDir = "" // not mounted in this unit test
	r.winTeardown()
	if len(sys.letters) != 0 || r.espLetterRelease != nil {
		t.Fatalf("letters after teardown = %v", sys.letters)
	}
}

// Ruling C5: the hives are unloaded BEFORE bcdboot and DISM run.
func TestWinBoot_ClosesHivesFirst(t *testing.T) {
	r, sys := newBootRun(t, TargetDisk)
	r.opts.DriverDirs = []string{`X:\drv`}
	var order []string
	r.hives = map[string]winhive.Handle{"SYSTEM": closeHook{Fake: winhive.NewFake(), fn: func() { order = append(order, "close cmds="+strings.Join(sys.cmds, "|")) }}}
	if err := winBoot(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if len(order) != 1 || order[0] != "close cmds=" || r.hives != nil {
		t.Fatalf("hive close order = %v, hives = %v; want closed before any command", order, r.hives)
	}
}

type closeHook struct {
	*winhive.Fake
	fn func()
}

func (h closeHook) Close() error { h.fn(); return nil }

// R25: no driver dirs → warning; one host-DISM call per dir; a DISM
// failure fails the phase with its output and the dir.
func TestWinBoot_Drivers(t *testing.T) {
	r, _ := newBootRun(t, TargetDisk)
	if err := winBoot(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if !hasWarning(r.warnings, "no driver packages supplied; inbox drivers only") {
		t.Fatalf("warnings = %v", r.warnings)
	}

	r, sys := newBootRun(t, TargetDisk)
	r.opts.DriverDirs = []string{`X:\breeze\drivers`, `X:\more`}
	if err := winBoot(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	got := countCalls(sys.cmds, testHostDism)
	if len(got) != 2 || got[0] != testHostDism+" /Image:"+r.rootDir+` /Add-Driver /Driver:X:\breeze\drivers /Recurse` ||
		got[1] != testHostDism+" /Image:"+r.rootDir+` /Add-Driver /Driver:X:\more /Recurse` {
		t.Fatalf("dism calls = %v", got)
	}
	if hasWarning(r.warnings, "no driver packages supplied; inbox drivers only") {
		t.Fatalf("unexpected inbox-only warning: %v", r.warnings)
	}
	for _, c := range sys.cmds {
		if strings.HasPrefix(c, "dism.exe") {
			t.Fatalf("DISM resolved through PATH (C4): %v", sys.cmds)
		}
	}

	r, sys = newBootRun(t, TargetDisk)
	r.opts.DriverDirs = []string{`X:\breeze\drivers`, `X:\more`}
	sys.fail[testHostDism] = errors.New("exit status 2")
	err := winBoot(context.Background(), r)
	if err == nil || !strings.Contains(err.Error(), "simulated failure") || !strings.Contains(err.Error(), `X:\breeze\drivers`) {
		t.Fatalf("err = %v, want the dism output and dir", err)
	}
	if got := countCalls(sys.cmds, testHostDism); len(got) != 1 {
		t.Fatalf("dism calls = %v", got)
	}
}

// Global "ESP and boot": a planned Recovery partition gets the warning; no
// reagentc runs.
func TestWinBoot_RecoveryWarning(t *testing.T) {
	r, sys := newBootRun(t, TargetDisk)
	r.result.Plan = &Plan{Partitions: []PlannedPartition{{Number: 1, Role: layout.RoleEFI}, {Number: 3, Role: layout.RoleRoot}, {Number: 4, Role: layout.RoleRecovery}}}
	if err := winBoot(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if !hasWarning(r.warnings, "Windows RE partition contents were not backed up") {
		t.Fatalf("warnings = %v", r.warnings)
	}
	for _, c := range sys.cmds {
		if strings.Contains(strings.ToLower(c), "reagentc") {
			t.Fatalf("reagentc must never run: %v", sys.cmds)
		}
	}

	r, _ = newBootRun(t, TargetDisk)
	r.result.Plan = &Plan{Partitions: []PlannedPartition{{Number: 1, Role: layout.RoleEFI}, {Number: 3, Role: layout.RoleRoot}}}
	if err := winBoot(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if hasWarning(r.warnings, "Windows RE partition contents were not backed up") {
		t.Fatalf("no Recovery partition planned, unexpected warning: %v", r.warnings)
	}
}

// Ruling C7: the fake bcdboot seeds the ESP volume's BCD (a loadable fake
// hive with the default boot-manager entry) and bootmgfw.efi.
func TestFakeWinSystem_BcdbootSeedsESP(t *testing.T) {
	r, sys := newBootRun(t, TargetDisk)
	if err := winBoot(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{`EFI\Microsoft\Boot\BCD`, `EFI\Microsoft\Boot\bootmgfw.efi`} {
		if _, err := os.Stat(filepath.Join(r.espVolume, filepath.Join(strings.Split(rel, `\`)...))); err != nil {
			t.Fatalf("%s not seeded on the ESP volume: %v", rel, err)
		}
	}
	h, err := sys.LoadHive(filepath.Join(r.espVolume, "EFI", "Microsoft", "Boot", "BCD"), "BRZ_x_BCD")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.Root().OpenKey(`Objects\{9dea862c-5cdd-4e70-acc1-f32b344d4795}\Elements\23000003`); err != nil {
		t.Fatalf("seeded BCD lacks the default entry: %v", err)
	}
}

func TestWinBoot_SkipBoot(t *testing.T) {
	r, sys := newBootRun(t, TargetDisk)
	r.opts.SkipBoot = true
	if err := winBoot(context.Background(), r); err != nil || len(sys.cmds) != 0 || !r.recorded(PhaseBoot) {
		t.Fatalf("err=%v cmds=%v", err, sys.cmds)
	}
}

// Ruling C5 through the engine: a full fake run with --drivers and
// SkipBoot:false unloads every hive before the first DISM (and bcdboot)
// command, identity reloads them afterwards, and teardown releases the ESP
// letter. Until Task 17 deletes winPreflight's SkipBoot=false refusal, the
// preflight entry is wrapped to run with SkipBoot set.
func TestRun_WindowsBootClosesHivesBeforeDism(t *testing.T) {
	withHostPlatformWindows(t)
	t.Setenv("SystemRoot", "")
	orig := platformPhases["windows"][0]
	platformPhases["windows"][0] = phaseFn{PhasePreflight, func(ctx context.Context, r *run) error {
		r.opts.SkipBoot = true
		defer func() { r.opts.SkipBoot = false }()
		return winPreflight(ctx, r)
	}}
	t.Cleanup(func() { platformPhases["windows"][0] = orig })

	opts, sys := winFakeOptions(t, t.TempDir())
	opts.SkipBoot = false
	opts.DriverDirs = []string{`X:\drv`}
	opts.WinSystem = loadWrapper{sys, func(h winhive.Handle) winhive.Handle {
		return closeHook{Fake: h.(*winhive.Fake), fn: func() {
			sys.mu.Lock()
			sys.cmds = append(sys.cmds, "UnloadHive")
			sys.mu.Unlock()
		}}
	}}
	res, err := Run(context.Background(), opts)
	if err != nil || res.Status != "completed" || !phaseCompleted(res, PhaseBoot) {
		t.Fatalf("res=%+v err=%v\n%s", res, err, sys.dumpForTest())
	}
	loaded, sawUnload, checked := 0, false, 0
	for _, c := range sys.cmds {
		switch {
		case strings.HasPrefix(c, "LoadHive"):
			loaded++
		case c == "UnloadHive":
			loaded--
			sawUnload = true
		case strings.HasPrefix(c, testHostDism), strings.HasPrefix(c, testHostBcdboot):
			if loaded != 0 || !sawUnload {
				t.Fatalf("%q ran with %d hive(s) loaded:\n%s", c, loaded, sys.dumpForTest())
			}
			checked++
		}
	}
	if checked != 2 {
		t.Fatalf("want one bcdboot and one dism, checked %d:\n%s", checked, sys.dumpForTest())
	}
	if loaded != 0 {
		t.Fatalf("%d hive(s) still loaded at the end", loaded)
	}
	iDism := indexOfPrefix(sys.cmds, testHostDism)
	if reload := indexOfPrefix(sys.cmds[iDism:], "LoadHive"); reload < 0 {
		t.Fatalf("identity did not reload the hives after boot:\n%s", sys.dumpForTest())
	}
	if len(sys.letters) != 0 {
		t.Fatalf("ESP letter not released by teardown: %v", sys.letters)
	}
	if !hasWarning(res.Warnings, "Windows RE partition contents were not backed up") {
		t.Fatalf("warnings = %v", res.Warnings)
	}
}

func indexOfPrefix(cmds []string, prefix string) int {
	for i, c := range cmds {
		if strings.HasPrefix(c, prefix) {
			return i
		}
	}
	return -1
}

func hasWarning(ws []string, want string) bool {
	for _, w := range ws {
		if w == want {
			return true
		}
	}
	return false
}
