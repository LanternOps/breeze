package rebuild

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/systemstate"
	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

func TestCheckWinPEBuild(t *testing.T) {
	if ref := checkWinPEBuild(26100, 20348); ref != nil {
		t.Fatalf("newer WinPE must pass: %v", ref)
	}
	if ref := checkWinPEBuild(26100, 26100); ref != nil {
		t.Fatalf("equal must pass: %v", ref)
	}
	if ref := checkWinPEBuild(22621, 0); ref != nil {
		t.Fatalf("unknown guest build must pass: %v", ref)
	}
	ref := checkWinPEBuild(22621, 26100)
	if ref == nil || !strings.Contains(ref.Reason, "22621") || !strings.Contains(ref.Reason, "26100") || ref.Code != RefusalCodeWinPETooOld {
		t.Fatalf("ref = %+v", ref)
	}
}

// softwareHiveWithBuild is a SOFTWARE fake carrying CurrentBuildNumber
// (empty build = the key exists without the value).
func softwareHiveWithBuild(build string) *winhive.Fake {
	h := winhive.NewFake()
	cv, _ := h.CreateKey(`Microsoft\Windows NT\CurrentVersion`)
	if build != "" {
		_ = cv.SetString("CurrentBuildNumber", build)
	}
	return h
}

// stageSoftwareArtifact adds a registry/SOFTWARE artifact to the snapshot's
// system-state manifest so preflightVerify stages it next to SYSTEM.
func stageSoftwareArtifact(t *testing.T, p *memProvider, id string) {
	t.Helper()
	b := []byte("software-hive-artifact-bytes")
	p.files["snapshots/"+id+"/system-state/registry/SOFTWARE"] = b
	mk := "snapshots/" + id + "/system-state/manifest.json"
	var m systemstate.SystemStateManifest
	if err := json.Unmarshal(p.files[mk], &m); err != nil {
		t.Fatal(err)
	}
	m.Artifacts = append(m.Artifacts, systemstate.Artifact{Name: "registry_SOFTWARE", Category: "registry", Path: "registry/SOFTWARE", SizeBytes: int64(len(b)), Checksum: sum(b)})
	out, _ := json.Marshal(m)
	p.files[mk] = out
}

func diskTargetOpts(t *testing.T, build uint32, withSoftware bool, guest string) (Options, *fakeWinSystem) {
	t.Helper()
	opts, sys := winFakeOptions(t, t.TempDir())
	opts.Target = Target{Kind: TargetDisk, Path: `\\.\PhysicalDrive1`}
	sys.inWinPE = true
	sys.hostBuild = build
	sys.diskInfo[1] = WinDiskInfo{SizeBytes: 80 * GiB}
	if withSoftware {
		stageSoftwareArtifact(t, opts.Provider.(*memProvider), "win-1")
		sys.hives["SOFTWARE"] = softwareHiveWithBuild(guest)
	}
	return opts, sys
}

func TestWinPreflight_RefusesOlderWinPEThanGuest(t *testing.T) {
	withHostPlatformWindows(t)
	opts, sys := diskTargetOpts(t, 22621, true, "26100")
	res, err := Run(context.Background(), opts)
	if err == nil || res == nil || res.Status != "refused" || res.RefusalCode != RefusalCodeWinPETooOld || sys.has("WipeDisk") || sys.has("WriteGPT") {
		t.Fatalf("res=%+v err=%v cmds=%v", res, err, sys.cmds)
	}
	if !strings.Contains(res.Refusal, "22621") || !strings.Contains(res.Refusal, "26100") {
		t.Fatalf("refusal must name both builds: %q", res.Refusal)
	}
}

func TestWinPreflight_NewerWinPEPassesBuildCheck(t *testing.T) {
	withHostPlatformWindows(t)
	opts, _ := diskTargetOpts(t, 26100, true, "22621")
	opts.DryRun = true
	res, err := Run(context.Background(), opts)
	if err != nil || res == nil || res.RefusalCode != "" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

func TestWinPreflight_MissingSoftwareArtifactWarns(t *testing.T) {
	withHostPlatformWindows(t)
	opts, _ := diskTargetOpts(t, 22621, false, "")
	opts.DryRun = true
	res, err := Run(context.Background(), opts)
	if err != nil || res == nil || res.RefusalCode != "" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if !strings.Contains(strings.Join(res.Warnings, "\n"), "could not read the guest Windows build") {
		t.Fatalf("warnings = %v", res.Warnings)
	}
}

func TestWinPreflight_VHDXSkipsBuildCheck(t *testing.T) {
	withHostPlatformWindows(t)
	opts, sys := winFakeOptions(t, t.TempDir())
	stageSoftwareArtifact(t, opts.Provider.(*memProvider), "win-1")
	sys.hives["SOFTWARE"] = softwareHiveWithBuild("26100")
	sys.hostBuild = 1
	res, err := Run(context.Background(), opts)
	if err != nil || res == nil || res.Status == "refused" {
		t.Fatalf("vhdx must skip the build check: res=%+v err=%v", res, err)
	}
	if strings.Contains(strings.Join(sys.cmds, "\n"), "_PREB") {
		t.Fatalf("vhdx must not load the SOFTWARE artifact: %v", sys.cmds)
	}
}

func TestWinPreflight_HostBuildErrorWarns(t *testing.T) {
	withHostPlatformWindows(t)
	opts, sys := diskTargetOpts(t, 0, true, "26100")
	sys.hostBuildErr = errors.New("rtl failed")
	opts.DryRun = true
	res, err := Run(context.Background(), opts)
	if err != nil || res == nil || res.RefusalCode != "" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if !strings.Contains(strings.Join(res.Warnings, "\n"), "could not read the WinPE build") {
		t.Fatalf("warnings = %v", res.Warnings)
	}
}

func guestRun(t *testing.T, sys *fakeWinSystem, withArtifact bool) *run {
	t.Helper()
	staging := t.TempDir()
	if withArtifact {
		if err := os.MkdirAll(filepath.Join(staging, "registry"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(staging, "registry", "SOFTWARE"), []byte("hive"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return &run{opts: Options{WinSystem: sys, Target: Target{Kind: TargetDisk, Path: `\\.\PhysicalDrive1`}}, stateStaging: staging}
}

func TestGuestBuild(t *testing.T) {
	t.Run("reads the build read-only under the PREB mount", func(t *testing.T) {
		sys := newFakeWinSystem(t.TempDir())
		sys.hives["SOFTWARE"] = softwareHiveWithBuild("26100")
		r := guestRun(t, sys, true)
		b, ok, err := r.guestBuild()
		if err != nil || !ok || b != 26100 {
			t.Fatalf("b=%d ok=%v err=%v", b, ok, err)
		}
		joined := strings.Join(sys.cmds, "\n")
		if !strings.Contains(joined, "LoadHiveReadOnly") || !strings.Contains(joined, "_PREB") {
			t.Fatalf("cmds = %v", sys.cmds)
		}
		if strings.Contains(joined, "LoadHive ") {
			t.Fatalf("must not load read-write: %v", sys.cmds)
		}
	})
	t.Run("absent artifact is not an error", func(t *testing.T) {
		r := guestRun(t, newFakeWinSystem(t.TempDir()), false)
		if _, ok, err := r.guestBuild(); ok || err != nil {
			t.Fatalf("ok=%v err=%v", ok, err)
		}
	})
	t.Run("missing or non-numeric value is unusable with a warning", func(t *testing.T) {
		for _, v := range []string{"", "abc", "-5", "26100.1"} {
			sys := newFakeWinSystem(t.TempDir())
			sys.hives["SOFTWARE"] = softwareHiveWithBuild(v)
			r := guestRun(t, sys, true)
			if _, ok, err := r.guestBuild(); ok || err != nil || len(r.warnings) == 0 {
				t.Fatalf("value %q: ok=%v err=%v warnings=%v", v, ok, err, r.warnings)
			}
		}
	})
	t.Run("unload failure is an error", func(t *testing.T) {
		sys := newFakeWinSystem(t.TempDir())
		sys.hives["SOFTWARE"] = softwareHiveWithBuild("26100")
		sys.hiveCloseErr = errors.New("RegUnLoadKeyW: access denied")
		r := guestRun(t, sys, true)
		if _, _, err := r.guestBuild(); err == nil || !strings.Contains(err.Error(), "access denied") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("no staging dir is an error", func(t *testing.T) {
		r := &run{opts: Options{WinSystem: newFakeWinSystem(t.TempDir())}}
		if _, _, err := r.guestBuild(); err == nil {
			t.Fatal("want an error")
		}
	})
}
