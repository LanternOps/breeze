package rebuild

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
)

// TestRestoreTree_BoundsFailedFilesMessageAndCounts proves a mass-failure
// restore (98,411 of 105,953 files fail to download) still reports a
// bounded message/sample on Result while keeping the internal failedFiles
// map (which validate.go consumes) unbounded. restoreTree is exercised
// directly rather than through the full eight-phase Run: mountTree is
// skipped by pre-setting r.rootMount, so this stays a restore-phase unit
// test and doesn't need real disk provisioning via fakeSystem.
func TestRestoreTree_BoundsFailedFilesMessageAndCounts(t *testing.T) {
	dir := t.TempDir()
	staging := filepath.Join(dir, "mnt")
	if err := os.MkdirAll(staging, 0o755); err != nil {
		t.Fatal(err)
	}

	const snapID = "snap-1"
	const total = 105953
	const failed = 98411
	prov := &memProvider{files: map[string][]byte{}, failKey: map[string]error{}}
	var files []backup.SnapshotFile
	for i := 0; i < total; i++ {
		key := fmt.Sprintf("snapshots/%s/files/%06d.gz", snapID, i)
		src := fmt.Sprintf("/src/%06d", i)
		files = append(files, backup.SnapshotFile{SourcePath: src, BackupPath: key, Size: 1, Checksum: sum([]byte("x"))})
		if i < failed {
			prov.failKey[key] = fmt.Errorf("simulated download failure")
		} else {
			prov.files[key] = []byte("x")
		}
	}
	man := backup.Snapshot{ID: snapID, Files: files}
	manBytes, err := json.Marshal(man)
	if err != nil {
		t.Fatal(err)
	}
	prov.files["snapshots/"+snapID+"/manifest.json"] = manBytes

	r := &run{
		opts: Options{
			SnapshotID:          snapID,
			Provider:            prov,
			AllowPartialRestore: true,
			StateDir:            dir,
		},
		staging:   staging,
		rootMount: staging, // pre-set so restoreTree skips mountTree
		result:    &Result{},
	}

	if err := restoreTree(context.Background(), r); err != nil {
		t.Fatalf("partial restore is a warning, not a hard error, when AllowPartialRestore is set: %v", err)
	}

	if r.result.FilesFailed != failed {
		t.Errorf("FilesFailed = %d, want %d", r.result.FilesFailed, failed)
	}
	if len(r.result.FailedFilesSample) != 50 {
		t.Errorf("len(FailedFilesSample) = %d, want 50", len(r.result.FailedFilesSample))
	}
	if r.result.FailedFilesOmitted != failed-50 {
		t.Errorf("FailedFilesOmitted = %d, want %d", r.result.FailedFilesOmitted, failed-50)
	}
	if len(r.failedFiles) != failed {
		t.Errorf("len(r.failedFiles) = %d, want %d — the internal failedFiles map is never truncated (validate.go needs every entry)", len(r.failedFiles), failed)
	}

	// engine.go's Run() assembles r.result.Warnings from r.warnings only at
	// the very end of a full run; restoreTree is called directly here, so
	// mirror that assembly step before asserting on it.
	r.result.Warnings = r.warnings

	found := false
	want := fmt.Sprintf("%d file(s) failed to restore (first 50 shown)", failed)
	for _, w := range r.result.Warnings {
		if strings.Contains(w, want) {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected a warning containing %q, got %v", want, r.result.Warnings)
	}
}

// #6664: a restore cut short by its context (the helper's stall watchdog or
// time budget, or an operator cancel) must fail the restore phase. The file
// restore returns a partial result and a nil error when cancelled between
// files; before this guard restoreTree then returned nil, the engine marked
// PhaseRestore completed in its resume state, and a resumed run skipped the
// files that were never restored.
func TestRestoreTree_CancelledRestoreFailsThePhase(t *testing.T) {
	dir := t.TempDir()
	staging := filepath.Join(dir, "mnt")
	if err := os.MkdirAll(staging, 0o755); err != nil {
		t.Fatal(err)
	}
	const snapID = "snap-1"
	prov := &memProvider{files: map[string][]byte{}, failKey: map[string]error{}}
	var files []backup.SnapshotFile
	for i := 0; i < 5; i++ {
		key := fmt.Sprintf("snapshots/%s/files/%02d.gz", snapID, i)
		files = append(files, backup.SnapshotFile{SourcePath: fmt.Sprintf("/src/%02d", i), BackupPath: key, Size: 1, Checksum: sum([]byte("x"))})
		prov.files[key] = []byte("x")
	}
	manBytes, err := json.Marshal(backup.Snapshot{ID: snapID, Files: files})
	if err != nil {
		t.Fatal(err)
	}
	prov.files["snapshots/"+snapID+"/manifest.json"] = manBytes

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := &run{
		opts: Options{
			SnapshotID: snapID,
			Provider:   prov,
			StateDir:   dir,
			Progress: func(_ Phase, msg string, _, _ int64) {
				if strings.HasPrefix(msg, "restored:") && strings.HasSuffix(msg, "/src/02") {
					cancel() // stop after the third file lands
				}
			},
		},
		staging:   staging,
		rootMount: staging,
		result:    &Result{},
	}

	err = restoreTree(ctx, r)
	if err == nil {
		t.Fatalf("a cancelled restore returned nil (restored %d of %d files); the phase must fail so resume re-runs it", r.result.FilesRestored, len(files))
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want it to wrap context.Canceled", err)
	}
	// The counts still reach the result, so a stopped rebuild reports how
	// far it got.
	if r.result.FilesRestored != 3 {
		t.Fatalf("FilesRestored = %d, want 3 (the files restored before the cancel)", r.result.FilesRestored)
	}
}

// A restore that finished is not failed because ctx ended after it returned
// (e.g. the watchdog's ceiling during the restore's staging cleanup).
func TestRestoreInterrupted_TrustsACompletedRestore(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := restoreInterrupted(ctx, &backup.RestoreResult{Status: "completed", FilesRestored: 5}); err != nil {
		t.Fatalf("completed restore reported interrupted: %v", err)
	}
	if err := restoreInterrupted(ctx, &backup.RestoreResult{Status: "partial", FilesRestored: 2}); err == nil {
		t.Fatal("a partial restore under a cancelled ctx must be reported interrupted")
	}
	if err := restoreInterrupted(context.Background(), &backup.RestoreResult{Status: "partial"}); err != nil {
		t.Fatalf("a live ctx is never an interruption: %v", err)
	}
}
