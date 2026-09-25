package rebuild

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

// newValidateOSRun is a run whose ESP volume (a fake volume's backing dir ==
// its GUID path, ruling B1a) holds files, whose fake BCD hive has the
// default boot-manager entry, and whose SYSTEM/SOFTWARE hives are loaded as
// counting handles. *closes counts hive unloads.
func newValidateOSRun(t *testing.T, files ...string) (*run, *fakeWinSystem, *int) {
	t.Helper()
	sys := newFakeWinSystem(t.TempDir())
	seedFakeHives(sys)
	bcd := winhive.NewFake()
	el, _ := bcd.CreateKey(fakeDefaultBootEntry)
	_ = el.SetString("Element", "{7619dcc9-fafe-11d9-b411-000476eba25f}")
	sys.hives["BCD"] = bcd
	esp := t.TempDir()
	for _, rel := range files {
		p := filepath.Join(esp, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	closes := 0
	r := &run{
		opts:    Options{WinSystem: sys, Target: Target{Kind: TargetVHDX, Path: "x.vhdx"}},
		staging: t.TempDir(), result: &Result{}, espVolume: esp,
		hives: map[string]winhive.Handle{
			"SYSTEM":   countingHandle{Fake: sys.hives["SYSTEM"], closes: &closes},
			"SOFTWARE": countingHandle{Fake: sys.hives["SOFTWARE"], closes: &closes},
		},
	}
	return r, sys, &closes
}

var allESPFiles = []string{"EFI/Microsoft/Boot/BCD", "EFI/Microsoft/Boot/bootmgfw.efi", "EFI/Boot/bootx64.efi"}

// Global Constraint "ESP and boot" + ruling C1: the hives are unloaded
// FIRST, then the BCD is loaded from the ESP VOLUME path (never a folder
// mount) and its handle closed.
func TestValidateOSState_ClosesHivesThenChecksESPAndBCD(t *testing.T) {
	r, sys, closes := newValidateOSRun(t, allESPFiles...)
	closedAtBCDLoad, bcdClosed := -1, false
	r.opts.WinSystem = loadWrapper{sys, func(h winhive.Handle) winhive.Handle {
		closedAtBCDLoad = *closes
		return closeHook{Fake: h.(*winhive.Fake), fn: func() { bcdClosed = true }}
	}}
	if err := validateOSState(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if r.hives != nil || *closes != 2 {
		t.Fatalf("hives must be closed and cleared: hives=%v closes=%d", r.hives, *closes)
	}
	if closedAtBCDLoad != 2 {
		t.Fatalf("BCD loaded with %d of 2 hives unloaded; the hives must close first", closedAtBCDLoad)
	}
	// Read-only: a bcdboot-built store (from BCD-Template) grants
	// Administrators only ReadKey, so a read-write load is denied.
	want := "LoadHiveReadOnly " + filepath.Join(r.espVolume, "EFI", "Microsoft", "Boot", "BCD") + " " + hiveMountName(r, "BCD")
	if loads := countCalls(sys.cmds, "LoadHive"); len(loads) != 1 || loads[0] != want {
		t.Fatalf("hive loads = %v, want exactly %q", loads, want)
	}
	if !bcdClosed {
		t.Fatal("BCD hive handle not closed")
	}
	if r.espDir != "" || len(sys.mountLog) != 0 {
		t.Fatalf("validate must not folder-mount the ESP: espDir=%q mounts=%v", r.espDir, sys.mountLog)
	}
	for _, c := range sys.cmds {
		if !strings.HasPrefix(c, "LoadHive") {
			t.Fatalf("validate ran %q; it executes nothing (ruling C4)", c)
		}
	}
}

// R28 (ESP files): each required file missing fails with its name, before
// the BCD is loaded.
func TestValidateOSState_MissingESPFileFails(t *testing.T) {
	for _, missing := range allESPFiles {
		t.Run(missing, func(t *testing.T) {
			var present []string
			for _, f := range allESPFiles {
				if f != missing {
					present = append(present, f)
				}
			}
			r, sys, _ := newValidateOSRun(t, present...)
			err := validateOSState(context.Background(), r)
			want := "ESP is missing " + filepath.FromSlash(missing) + " after boot phase"
			if err == nil || err.Error() != want {
				t.Fatalf("err = %v, want %q", err, want)
			}
			if len(countCalls(sys.cmds, "LoadHive")) != 0 {
				t.Fatalf("BCD loaded despite a missing ESP file: %v", sys.cmds)
			}
			if r.hives != nil {
				t.Fatal("hives must be closed even when the ESP check fails")
			}
		})
	}
}

// R28 (BCD): no default entry fails, and the BCD handle is still closed.
func TestValidateOSState_NoDefaultBCDEntryFails(t *testing.T) {
	r, sys, _ := newValidateOSRun(t, allESPFiles...)
	sys.hives["BCD"] = winhive.NewFake()
	bcdClosed := false
	r.opts.WinSystem = loadWrapper{sys, func(h winhive.Handle) winhive.Handle {
		return closeHook{Fake: h.(*winhive.Fake), fn: func() { bcdClosed = true }}
	}}
	if err := validateOSState(context.Background(), r); err == nil || err.Error() != "BCD store has no default boot entry" {
		t.Fatalf("err = %v", err)
	}
	if !bcdClosed {
		t.Fatal("BCD hive handle not closed on the failure path")
	}
}

func TestValidateOSState_BCDLoadFailureFails(t *testing.T) {
	r, sys, _ := newValidateOSRun(t, allESPFiles...)
	sys.fail["LoadHiveReadOnly"] = errors.New("access denied")
	err := validateOSState(context.Background(), r)
	if err == nil || !strings.HasPrefix(err.Error(), "load BCD store: ") || !strings.Contains(err.Error(), "access denied") {
		t.Fatalf("err = %v", err)
	}
}

// A hive that will not unload is a validation error, surfaced before any
// ESP/BCD work — not a teardown warning.
func TestValidateOSState_HiveUnloadFailureFailsFirst(t *testing.T) {
	r, sys, closes := newValidateOSRun(t, allESPFiles...)
	r.hives["SYSTEM"] = countingHandle{Fake: sys.hives["SYSTEM"], closes: closes, err: errors.New("key still open")}
	err := validateOSState(context.Background(), r)
	if err == nil || !strings.Contains(err.Error(), "unload SYSTEM hive: key still open") {
		t.Fatalf("err = %v", err)
	}
	if r.hives != nil || *closes != 2 {
		t.Fatalf("every hive must still be closed: hives=%v closes=%d", r.hives, *closes)
	}
	if len(countCalls(sys.cmds, "LoadHive")) != 0 {
		t.Fatalf("BCD loaded after a failed hive unload: %v", sys.cmds)
	}
}

func TestValidateOSState_NoESPVolumeFails(t *testing.T) {
	r, _, _ := newValidateOSRun(t, allESPFiles...)
	r.espVolume = ""
	if err := validateOSState(context.Background(), r); err == nil || err.Error() != "validate: no EFI system partition volume recorded for this run" {
		t.Fatalf("err = %v", err)
	}
}

func TestValidateOSState_SkipBootOnlyClosesHives(t *testing.T) {
	r, sys, closes := newValidateOSRun(t)
	r.opts.SkipBoot = true
	if err := validateOSState(context.Background(), r); err != nil || r.hives != nil || *closes != 2 || len(countCalls(sys.cmds, "LoadHive")) != 0 {
		t.Fatalf("err=%v hives=%v closes=%d cmds=%v", err, r.hives, *closes, sys.cmds)
	}
}

// Ruling C3/F4 + F7: a Windows run WITHOUT SkipBoot completes on the fake
// end to end — provision → restore (state apply) → boot (host bcdboot /p)
// → identity → encryption → validate (hives closed first, ESP files, BCD
// default entry) — with convert the only skipped phase, nothing left
// loaded or lettered, and the identity edits on the restored volume.
func TestRun_WindowsVhdxFullChainCompletes(t *testing.T) {
	withHostPlatformWindows(t)
	t.Setenv("SystemRoot", testSystemRoot)
	opts, sys := winFakeOptions(t, t.TempDir())
	opts.SkipBoot = false
	opts.Identity = IdentityNew
	opts.DriverDirs = nil
	loaded, bcdLoads := 0, 0
	bcdMount := "BRZ_" + targetKey(opts.Target) + "_BCD"
	opts.WinSystem = loadWrapper{sys, func(h winhive.Handle) winhive.Handle {
		sys.mu.Lock()
		last := sys.cmds[len(sys.cmds)-1]
		sys.mu.Unlock()
		if strings.HasSuffix(last, " "+bcdMount) {
			bcdLoads++
			if loaded != 0 {
				t.Errorf("BCD loaded with %d hive(s) still loaded; validate must close them first", loaded)
			}
		}
		loaded++
		return closeHook{Fake: h.(*winhive.Fake), fn: func() { loaded-- }}
	}}

	res, err := Run(context.Background(), opts)
	if err != nil || res == nil || res.Status != "completed" {
		t.Fatalf("res=%+v err=%v\n%s", res, err, sys.dumpForTest())
	}
	// convert is skipped (no VM requested) and so is encryption: a vhdx:
	// rehearsal image is never encrypted, and this source was not
	// BitLocker-protected (R23/R24). Every other phase ran.
	for _, ph := range res.Phases {
		want := PhaseCompleted
		if ph.Phase == PhaseConvert || ph.Phase == PhaseEncryption {
			want = PhaseSkipped
		}
		if ph.Status != want {
			t.Fatalf("phase %s = %s, want %s: %+v", ph.Phase, ph.Status, want, res.Phases)
		}
	}
	if len(res.Phases) != len(AllPhases) {
		t.Fatalf("phases = %+v, want %d", res.Phases, len(AllPhases))
	}
	bcdboot := countCalls(sys.cmds, testHostBcdboot)
	if len(bcdboot) != 1 || !strings.HasSuffix(bcdboot[0], " /f UEFI /v /p") {
		t.Fatalf("bcdboot argv = %v, want one host bcdboot with /p", bcdboot)
	}
	if bcdLoads != 1 {
		t.Fatalf("BCD default-entry check ran %d times, want 1:\n%s", bcdLoads, sys.dumpForTest())
	}
	if loaded != 0 {
		t.Fatalf("%d hive(s) still loaded after the run", loaded)
	}
	if len(sys.letters) != 0 {
		t.Fatalf("drive letters left after the run: %v", sys.letters)
	}
	if v := computerName(t, sys, "ControlSet001"); v != "FILESE-RESTORED" {
		t.Fatalf("ComputerName = %q", v)
	}
	b, err := os.ReadFile(filepath.Join(sys.volumeDirForPartition(t, 3), "ProgramData", "Breeze", "agent.yaml"))
	if err != nil || strings.Contains(string(b), "agent_id") {
		t.Fatalf("restored agent.yaml = %q, %v; want enrollment stripped", b, err)
	}
}
