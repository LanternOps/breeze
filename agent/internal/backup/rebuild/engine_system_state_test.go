package rebuild

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

// These tests pin the #5412 contract for the rebuild engine: a snapshot the
// caller says carries system state (Options.ExpectSystemState — a
// system_image backup, or a bootstrap advertising a state manifest) must
// never produce a "completed" Result unless that state was actually
// applied. Before this gate, preflight hardcoded expect=false into
// bmr.DownloadSystemState and restoreTree silently skipped the apply on an
// empty staging dir, so a system_image snapshot whose state collection
// failed rebuilt "completed" with no OS state at all — the same shape
// feature #5439 fixed on the bmr-recover path.

func stateOpts(dir string, p *memProvider, sys *fakeSystem, expect bool) Options {
	return Options{SnapshotID: "snap-1", Provider: p, Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}, Identity: IdentityNew, StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), System: sys, ExpectSystemState: expect}
}

func TestRun_PreflightRefusesWhenSystemStateExpectedAndMissing(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(p *memProvider)
		want   string
	}{
		{"manifest absent", func(p *memProvider) {
			delete(p.files, "snapshots/snap-1/system-state/manifest.json")
			delete(p.files, "snapshots/snap-1/system-state/services/systemd.txt")
		}, "system state expected but system-state/manifest.json is missing from the snapshot"},
		{"manifest lists no artifacts", func(p *memProvider) {
			sm, _ := json.Marshal(systemstate.SystemStateManifest{Platform: "linux", SchemaVersion: 1})
			p.files["snapshots/snap-1/system-state/manifest.json"] = sm
		}, "system state expected but system-state/manifest.json lists no artifacts"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			sys := newFakeSystem(dir, 100*GiB)
			p := seedSnapshot(t, "snap-1", testLayout())
			tt.mutate(p)
			res, err := Run(context.Background(), stateOpts(dir, p, sys, true))
			if err == nil {
				t.Fatalf("expected refusal, got %+v", res)
			}
			var ref *RefusalError
			if !errors.As(err, &ref) {
				t.Fatalf("err = %v, want *RefusalError", err)
			}
			if res == nil || res.Status != "refused" || !strings.Contains(res.Refusal, tt.want) || res.PhaseReached != PhasePreflight {
				t.Fatalf("res = %+v err=%v", res, err)
			}
			if res.StateManifestFound || res.StateApplied {
				t.Fatalf("refused run must not claim state: found=%v applied=%v", res.StateManifestFound, res.StateApplied)
			}
			if sys.has("sgdisk") || sys.has("mkfs") || sys.has("mount") {
				t.Fatalf("refusal must not write: %s", sys.dump())
			}
		})
	}
}

// Not expected + absent keeps the pre-#5412 soft path: a plain file-only
// snapshot still rebuilds, with the warning, and the result says so.
func TestRun_PreflightWarnsWhenSystemStateNotExpectedAndMissing(t *testing.T) {
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	p := seedSnapshot(t, "snap-1", testLayout())
	delete(p.files, "snapshots/snap-1/system-state/manifest.json")
	opts := stateOpts(dir, p, sys, false)
	opts.DryRun = true
	res, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("err = %v res=%+v", err, res)
	}
	if res.Status != "completed" || res.StateManifestFound || res.StateApplied {
		t.Fatalf("res = %+v", res)
	}
	if len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "snapshot has no system state") {
		t.Fatalf("warnings = %v", res.Warnings)
	}
}

// TestRun_StateExpectedNotApplied_NeverCompleted: state is expected, the
// manifest downloads and verifies, but the offline apply fails (systemctl
// enable errors through bmr's exec seam). The run must fail in the restore
// phase, naming it, with StateManifestFound=true and StateApplied=false —
// never "completed".
func TestRun_StateExpectedNotApplied_NeverCompleted(t *testing.T) {
	skipUnlessLinuxSystemState(t)
	resetBmrCalls()
	restore := bmr.SetRunCommandForTest(func(_ context.Context, name string, _ ...string) ([]byte, error) {
		if name == "systemctl" {
			return []byte("Failed to enable unit"), errors.New("exit status 1")
		}
		return []byte("ok"), nil
	})
	t.Cleanup(restore)

	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	p := seedSnapshot(t, "snap-1", testLayout())
	opts := stateOpts(dir, p, sys, true)
	opts.SkipBoot = true
	res, err := Run(context.Background(), opts)
	if err == nil {
		t.Fatalf("expected failure, got %+v", res)
	}
	if res == nil || res.Status != "failed" || res.PhaseReached != PhaseRestore || !strings.Contains(res.Error, "apply system state") {
		t.Fatalf("res = %+v err=%v", res, err)
	}
	if !res.StateManifestFound || res.StateApplied {
		t.Fatalf("found=%v applied=%v, want found=true applied=false", res.StateManifestFound, res.StateApplied)
	}
}

// The positive half of the contract: expected + applied ⇒ completed, and
// the result JSON carries both fields under their wire names.
func TestRun_StateExpectedAndApplied_CompletesWithFieldsInJSON(t *testing.T) {
	skipUnlessLinuxSystemState(t)
	resetBmrCalls()
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	p := seedSnapshot(t, "snap-1", testLayout())
	opts := stateOpts(dir, p, sys, true)
	opts.SkipBoot = true
	res, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("err = %v res=%+v\n%s", err, res, sys.dump())
	}
	if res.Status != "completed" || !res.StateManifestFound || !res.StateApplied {
		t.Fatalf("res = %+v", res)
	}
	b, _ := json.Marshal(res)
	var wire map[string]any
	if err := json.Unmarshal(b, &wire); err != nil {
		t.Fatal(err)
	}
	if wire["stateManifestFound"] != true || wire["stateApplied"] != true {
		t.Fatalf("wire = %s", b)
	}
}

// A resumed run skips the restore phase, so StateApplied must be carried
// over from the earlier run's persisted state — otherwise an expected-state
// rebuild that died in boot could never validate on resume.
func TestRun_StateAppliedSurvivesResume(t *testing.T) {
	skipUnlessLinuxSystemState(t)
	resetBmrCalls()
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	sys.fail["chroot"] = errors.New("boom") // first run dies in boot
	p := seedSnapshot(t, "snap-1", testLayout())
	opts := stateOpts(dir, p, sys, true)
	res, err := Run(context.Background(), opts)
	if err == nil || res.Status != "failed" || res.PhaseReached != PhaseBoot || !res.StateApplied {
		t.Fatalf("first run = %+v err=%v", res, err)
	}
	sys2 := newFakeSystem(dir, 100*GiB)
	opts.System = sys2
	res2, err := Run(context.Background(), opts)
	if err != nil || res2.Status != "completed" || !res2.Resumed || !res2.StateApplied || !res2.StateManifestFound {
		t.Fatalf("second run = %+v err=%v\n%s", res2, err, sys2.dump())
	}
}

// TestValidate_StateExpectedNotApplied_Fails exercises the validate-phase
// gate in isolation: the run reached validate with state expected but not
// applied (whatever let it get that far), so validation must fail with the
// named check rather than sampling files and declaring success.
func TestValidate_StateExpectedNotApplied_Fails(t *testing.T) {
	tests := []struct {
		name    string
		expect  bool
		applied bool
		wantErr bool
	}{
		{"expected, not applied", true, false, true},
		{"expected, applied", true, true, false},
		{"not expected, not applied", false, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			sys := newFakeSystem(dir, 100*GiB)
			r := &run{opts: Options{ExpectSystemState: tt.expect, SkipBoot: true}, sys: sys, staging: filepath.Join(dir, "mnt"), result: &Result{StateApplied: tt.applied, Plan: &Plan{}}}
			err := validate(context.Background(), r)
			if tt.wantErr {
				if err == nil || !strings.Contains(err.Error(), "system state not applied") {
					t.Fatalf("err = %v, want 'system state not applied'", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("err = %v", err)
			}
		})
	}
}

func TestSnapshotAdvertisesSystemState(t *testing.T) {
	tests := []struct {
		name    string
		mutate  func(p *memProvider)
		want    bool
		wantErr string
	}{
		{"state manifest and layout", func(*memProvider) {}, true, ""},
		{"layout only", func(p *memProvider) { delete(p.files, "snapshots/snap-1/system-state/manifest.json") }, true, ""},
		{"state manifest only", func(p *memProvider) { delete(p.files, "snapshots/snap-1/layout.json") }, true, ""},
		{"neither", func(p *memProvider) {
			delete(p.files, "snapshots/snap-1/system-state/manifest.json")
			delete(p.files, "snapshots/snap-1/layout.json")
		}, false, ""},
		{"transport error is not absence", func(p *memProvider) {
			p.failKey = map[string]error{"snapshots/snap-1/system-state/manifest.json": errors.New("timeout")}
		}, false, "timeout"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := seedSnapshot(t, "snap-1", testLayout())
			tt.mutate(p)
			got, err := SnapshotAdvertisesSystemState(context.Background(), p, "snap-1")
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want containing %q", err, tt.wantErr)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("got %v err=%v, want %v", got, err, tt.want)
			}
		})
	}
}
