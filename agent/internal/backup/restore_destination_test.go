package backup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// #12736: a restore's result names the folder it wrote under, so a restore
// with no target path does not read as "completed" with nothing saying the
// files are in the helper's staging folder rather than at their originals.
func TestRestoreFromSnapshot_ReportsStagingFolderWhenNoTarget(t *testing.T) {
	provider, snapshotID, original := setupOriginalTestSnapshot(t)
	workRoot := t.TempDir()

	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, WorkRoot: workRoot}, nil)
	if err != nil || result.Status != "completed" {
		t.Fatalf("staging restore = %+v, %v; want completed", result, err)
	}
	want := filepath.Join(workRoot, "restore-work", "restored", snapshotID)
	if result.RestoredTo != want {
		t.Fatalf("RestoredTo = %q, want the staging folder %q", result.RestoredTo, want)
	}
	if got, err := os.ReadFile(resolveTargetPath(result.RestoredTo, original)); err != nil || string(got) != "backed up" {
		t.Fatalf("no restored copy under RestoredTo: %q, %v", got, err)
	}
	if got, _ := os.ReadFile(original); string(got) != "live" {
		t.Fatalf("original now holds %q", got)
	}
}

func TestRestoreFromSnapshot_ReportsTargetPath(t *testing.T) {
	provider, snapshotID, _ := setupOriginalTestSnapshot(t)
	target := t.TempDir()

	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: target, WorkRoot: t.TempDir()}, nil)
	if err != nil || result.Status != "completed" {
		t.Fatalf("restore = %+v, %v; want completed", result, err)
	}
	if result.RestoredTo != target {
		t.Fatalf("RestoredTo = %q, want the target %q", result.RestoredTo, target)
	}
}

func TestRestoreFromSnapshot_InPlaceReportsVolumeRoot(t *testing.T) {
	provider, snapshotID, original := setupOriginalTestSnapshot(t)
	root := volumeRootOf(original)

	result, err := RestoreFromSnapshot(provider, RestoreConfig{
		SnapshotID: snapshotID, TargetPath: root, WorkRoot: t.TempDir(), AllowOverwriteOriginals: true,
	}, nil)
	if err != nil || result.Status != "completed" {
		t.Fatalf("in-place restore = %+v, %v; want completed", result, err)
	}
	if result.RestoredTo != root {
		t.Fatalf("RestoredTo = %q, want the volume root %q", result.RestoredTo, root)
	}
}

// A refused restore wrote nothing, so it names no destination.
func TestRestoreFromSnapshot_RefusedRestoreReportsNoDestination(t *testing.T) {
	provider, snapshotID, original := setupOriginalTestSnapshot(t)

	result, err := RestoreFromSnapshot(provider, RestoreConfig{
		SnapshotID: snapshotID, TargetPath: volumeRootOf(original), WorkRoot: t.TempDir(),
	}, nil)
	if err != nil {
		t.Fatalf("restore returned an error, want a result body: %v", err)
	}
	if result.Code != ResultCodeRestoreWouldOverwriteOriginals {
		t.Fatalf("result = %+v; want refused with %s", result, ResultCodeRestoreWouldOverwriteOriginals)
	}
	if result.RestoredTo != "" {
		t.Fatalf("RestoredTo = %q on a refused restore, want empty", result.RestoredTo)
	}
}

// The server reads the field as `restoredTo`.
func TestRestoreResult_RestoredToJSONName(t *testing.T) {
	raw, err := json.Marshal(RestoreResult{SnapshotID: "s", Status: "completed", RestoredTo: "/x"})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["restoredTo"] != "/x" {
		t.Fatalf("encoded result %s has no restoredTo", raw)
	}
}
