package systemstate

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// #7367: a shadow copy only holds what the configuration manager has already
// written to the hive files, so the loaded hives are flushed right before the
// registry step takes its own snapshot of the system volume.

// recordHiveFlush swaps the pre-snapshot flush seam for one that appends
// "flush" to events.
func recordHiveFlush(t *testing.T, events *[]string) {
	t.Helper()
	orig := flushHivesBeforeSnapshot
	t.Cleanup(func() { flushHivesBeforeSnapshot = orig })
	flushHivesBeforeSnapshot = func() { *events = append(*events, "flush") }
}

func TestCollectRegistryHivesForRun_OwnSnapshotFlushesHivesFirst(t *testing.T) {
	forbidRegSave(t)
	var events []string
	recordHiveFlush(t, &events)
	root := fakeShadowRoot(t, "SYSTEM", "SOFTWARE", "SAM", "SECURITY", "DEFAULT")
	staging := t.TempDir()
	dir := filepath.Join(staging, "registry")
	_ = os.MkdirAll(dir, 0o700)
	snap := &fakeSnapshot{root: root}
	opts := CollectOptions{SnapshotVolume: func(v string) (map[string]string, func(), error) {
		events = append(events, "snapshot")
		return snap.snapshot(v)
	}}

	if _, err := collectRegistryHivesForRun(dir, staging, `C:\Windows`, opts); err != nil {
		t.Fatalf("collectRegistryHivesForRun: %v", err)
	}
	if want := []string{"flush", "snapshot"}; !reflect.DeepEqual(events, want) {
		t.Errorf("events = %v, want %v (hives flushed once, before the snapshot)", events, want)
	}
}

// No snapshot taken here means nothing to flush for: the run's own snapshot
// was flushed where it was created, and reg.exe reads the live registry.
func TestCollectRegistryHivesForRun_NoOwnSnapshotNoFlush(t *testing.T) {
	origSave := runRegSave
	t.Cleanup(func() { runRegSave = origSave })
	runRegSave = func(hive, outPath string) ([]byte, error) {
		return nil, os.WriteFile(outPath, []byte("hive-"+hive), 0o600)
	}
	root := fakeShadowRoot(t, "SYSTEM", "SOFTWARE", "SAM", "SECURITY", "DEFAULT")
	cases := map[string]CollectOptions{
		"run shadow covers C:":   {ShadowPaths: map[string]string{"C:": root}, SnapshotVolume: (&fakeSnapshot{root: root}).snapshot},
		"skip system snapshot":   {SnapshotVolume: (&fakeSnapshot{root: root}).snapshot, SkipSystemVolumeSnapshot: true},
		"no snapshot configured": {},
	}
	for name, opts := range cases {
		t.Run(name, func(t *testing.T) {
			var events []string
			recordHiveFlush(t, &events)
			staging := t.TempDir()
			dir := filepath.Join(staging, "registry")
			_ = os.MkdirAll(dir, 0o700)
			if _, err := collectRegistryHivesForRun(dir, staging, `C:\Windows`, opts); err != nil {
				t.Fatalf("collectRegistryHivesForRun: %v", err)
			}
			if len(events) != 0 {
				t.Errorf("flushed %d times although no snapshot was taken here", len(events))
			}
		})
	}
}

func TestFlushHiveTargets(t *testing.T) {
	targets := []hiveFlushTarget{
		{Root: "HKLM", Path: "SYSTEM", Required: true},
		{Root: "HKLM", Path: "SAM", Required: true},
		{Root: "HKLM", Path: "SOFTWARE", Required: true},
		{Root: "HKLM", Path: "COMPONENTS"},
		{Root: "HKU", Path: "S-1-5-21-1"},
	}
	var flushed []string
	flushOne := func(tg hiveFlushTarget) error {
		flushed = append(flushed, tg.Path)
		switch tg.Path {
		case "SAM":
			return errors.New("access denied")
		case "COMPONENTS", "SOFTWARE":
			return errHiveNotLoaded
		}
		return nil
	}

	n, err := flushHiveTargets(targets, flushOne)
	// One failure never stops the rest: every target is attempted.
	if want := []string{"SYSTEM", "SAM", "SOFTWARE", "COMPONENTS", "S-1-5-21-1"}; !reflect.DeepEqual(flushed, want) {
		t.Errorf("attempted %v, want every target %v", flushed, want)
	}
	if n != 2 {
		t.Errorf("flushed count = %d, want 2 (SYSTEM + the user hive)", n)
	}
	if err == nil {
		t.Fatal("err = nil, want the SAM failure and the missing required SOFTWARE reported")
	}
	msg := err.Error()
	for _, want := range []string{`HKLM\SAM`, "access denied", `HKLM\SOFTWARE`} {
		if !strings.Contains(msg, want) {
			t.Errorf("err %q does not name %q", msg, want)
		}
	}
	// An optional hive that is not loaded is not an error.
	if strings.Contains(msg, "COMPONENTS") {
		t.Errorf("err %q names the optional, unloaded COMPONENTS hive", msg)
	}
}

func TestFlushHiveTargets_AllGood(t *testing.T) {
	n, err := flushHiveTargets([]hiveFlushTarget{{Root: "HKLM", Path: "SYSTEM", Required: true}}, func(hiveFlushTarget) error { return nil })
	if err != nil || n != 1 {
		t.Fatalf("flushHiveTargets = (%d, %v), want (1, nil)", n, err)
	}
}
