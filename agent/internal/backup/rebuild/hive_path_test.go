package rebuild

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Registry hive loads open the hive file by path. Every load from a restored
// volume, the ESP or the system-state staging directory must refuse a hive
// reached through a link.

func TestWinTreeHiveLoadBoundary(t *testing.T) {
	for _, shape := range []string{"directory", "file"} {
		t.Run(shape, func(t *testing.T) {
			sys := newFakeWinSystem(t.TempDir())
			seedFakeHives(sys)
			r := resumedWinRun(t, sys)
			other := t.TempDir()
			for _, hive := range winStateHives {
				mustWriteFile(t, filepath.Join(other, hive), "other")
			}
			config := filepath.Join(r.rootVolume, "Windows", "System32", "config")
			if shape == "directory" {
				mustMkdirAll(t, filepath.Dir(config))
				symlinkOrSkip(t, other, config)
			} else {
				mustMkdirAll(t, config)
				for _, hive := range winStateHives {
					symlinkOrSkip(t, filepath.Join(other, hive), filepath.Join(config, hive))
				}
			}
			if err := r.ensureWinHives(); err == nil {
				t.Fatal("expected an error for a hive outside the volume")
			}
			if sys.has("LoadHive") {
				t.Fatalf("hive loaded through a link: %v", sys.cmds)
			}
			if len(r.hives) != 0 {
				t.Fatalf("hives left loaded: %v", r.hives)
			}
		})
	}
}

func TestWinTreeHiveLoadRegularFile(t *testing.T) {
	sys := newFakeWinSystem(t.TempDir())
	seedFakeHives(sys)
	r := resumedWinRun(t, sys)
	seedWinTreeHives(t, r.rootVolume)
	if err := r.ensureWinHives(); err != nil {
		t.Fatal(err)
	}
	for _, hive := range winStateHives {
		if !sys.has("LoadHive " + filepath.Join(r.rootVolume, "Windows", "System32", "config", hive)) {
			t.Fatalf("%s not loaded: %v", hive, sys.cmds)
		}
	}
}

func TestStagedHiveLoadBoundary(t *testing.T) {
	for _, check := range []string{"domain-controller", "guest-build"} {
		t.Run(check, func(t *testing.T) {
			dir := t.TempDir()
			staging, other := filepath.Join(dir, "state"), t.TempDir()
			mustMkdirAll(t, filepath.Join(staging, "registry"))
			for _, hive := range []string{"SYSTEM", "SOFTWARE"} {
				mustWriteFile(t, filepath.Join(other, hive), "other")
				symlinkOrSkip(t, filepath.Join(other, hive), filepath.Join(staging, "registry", hive))
			}
			sys := newFakeWinSystem(dir)
			r := &run{opts: Options{WinSystem: sys, Target: Target{Kind: TargetVHDX, Path: "x.vhdx"}}, stateStaging: staging, result: &Result{}}
			var err error
			if check == "domain-controller" {
				_, err = r.isDomainController()
			} else {
				_, _, err = r.guestBuild()
			}
			if err == nil {
				t.Fatal("expected an error for a staged hive that is a link")
			}
			for _, c := range sys.cmds {
				if strings.HasPrefix(c, "LoadHive") {
					t.Fatalf("hive loaded through a link: %v", sys.cmds)
				}
			}
		})
	}
}

func TestWinTreeHiveLogLinkBoundary(t *testing.T) {
	sys := newFakeWinSystem(t.TempDir())
	seedFakeHives(sys)
	r := resumedWinRun(t, sys)
	seedWinTreeHives(t, r.rootVolume)
	other := filepath.Join(t.TempDir(), "file")
	mustWriteFile(t, other, "keep")
	symlinkOrSkip(t, other, filepath.Join(r.rootVolume, "Windows", "System32", "config", "SYSTEM.LOG1"))
	if err := r.ensureWinHives(); err == nil {
		t.Fatal("expected an error for a hive log that is a link")
	}
	if sys.has("LoadHive") {
		t.Fatalf("hive loaded next to a linked log: %v", sys.cmds)
	}
	assertFileContent(t, other, "keep")
}

func TestWinRestoreWorkRootTreeBoundary(t *testing.T) {
	r := &run{rootVolume: t.TempDir(), result: &Result{}}
	other := t.TempDir()
	symlinkOrSkip(t, other, filepath.Join(r.rootVolume, winRestoreWorkDir))
	if _, err := winRestoreWorkRoot(r); err == nil {
		t.Fatal("expected an error for a work directory outside the volume")
	}
	assertDirEmpty(t, other)

	r = &run{rootVolume: t.TempDir(), result: &Result{}}
	got, err := winRestoreWorkRoot(r)
	if err != nil || got != filepath.Join(r.rootVolume, winRestoreWorkDir) {
		t.Fatalf("winRestoreWorkRoot = %q, %v", got, err)
	}
}

func TestWinBootTemplateHiveBoundary(t *testing.T) {
	for _, shape := range []string{"template-link", "config-link"} {
		t.Run(shape, func(t *testing.T) {
			r, sys := newBootRun(t, TargetDisk)
			other := t.TempDir()
			mustWriteFile(t, filepath.Join(other, "BCD-Template"), "other")
			config := filepath.Join(r.rootVolume, "Windows", "System32", "config")
			if shape == "template-link" {
				mustMkdirAll(t, config)
				symlinkOrSkip(t, filepath.Join(other, "BCD-Template"), filepath.Join(config, "BCD-Template"))
			} else {
				mustMkdirAll(t, filepath.Dir(config))
				if err := os.RemoveAll(config); err != nil {
					t.Fatal(err)
				}
				symlinkOrSkip(t, other, config)
			}
			if err := winBoot(context.Background(), r); err == nil {
				t.Fatal("expected an error for a boot template hive reached through a link")
			}
			if len(countCalls(sys.cmds, testHostBcdboot)) != 0 {
				t.Fatalf("bcdboot ran: %v", sys.cmds)
			}
		})
	}
	r, sys := newBootRun(t, TargetDisk)
	mustWriteFile(t, filepath.Join(r.rootVolume, "Windows", "System32", "config", "BCD-Template"), "template")
	if err := winBoot(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if len(countCalls(sys.cmds, testHostBcdboot)) != 1 {
		t.Fatalf("bcdboot calls: %v", sys.cmds)
	}
}
