//go:build unix

package backup

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// A FIFO is the closest thing a Unix filesystem has to a Windows junction as
// far as the collector is concerned: an entry that is neither a directory,
// a regular file, nor a symlink, so it falls through to the "skip" branch.
// Stubbing skippedReparsePointFor lets this test drive the recording path
// (#7051) on any CI host; the real Windows classifier is covered by
// reparse_skip_windows_test.go.
func TestCollectBackupFiles_RecordsSkippedIrregularEntry(t *testing.T) {
	root := t.TempDir()
	createTempFile(t, root, "data.txt", "payload")
	onlyLinkDir := filepath.Join(root, "profile")
	if err := os.Mkdir(onlyLinkDir, 0o755); err != nil {
		t.Fatal(err)
	}
	fifo := filepath.Join(onlyLinkDir, "My Music")
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Skipf("mkfifo unsupported here: %v", err)
	}

	var classified []string
	orig := skippedReparsePointFor
	skippedReparsePointFor = func(path string, info os.FileInfo) (skippedReparsePoint, bool) {
		classified = append(classified, path)
		return skippedReparsePoint{path: path, kind: reparseKindJunction, target: `C:\Users\Public\Music`}, true
	}
	t.Cleanup(func() { skippedReparsePointFor = orig })

	files, skips, err := NewBackupManager(BackupConfig{}).collectBackupFilesWithSkips(context.Background(), []string{root}, nil, nil)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if len(classified) != 1 || classified[0] != fifo {
		t.Fatalf("classifier should be consulted exactly for the irregular entry, got %v", classified)
	}
	if skips == nil || skips.total != 1 || len(skips.sample) != 1 || skips.sample[0].path != fifo {
		t.Fatalf("skipped entry not recorded: %+v", skips)
	}
	if skips.byKind[reparseKindJunction] != 1 {
		t.Fatalf("byKind = %v", skips.byKind)
	}

	var sawData, sawDirEntry bool
	for _, f := range files {
		switch f.snapshotPath {
		case "path_0/data.txt":
			sawData = true
		case "path_0/profile":
			sawDirEntry = f.kind == KindDir
		case "path_0/profile/My Music":
			t.Fatalf("the skipped entry itself must not be in the manifest: %+v", f)
		}
	}
	if !sawData {
		t.Fatal("regular file missing from the manifest")
	}
	// The skipped entry does not make it into the backup, so it must not
	// count as a child: a directory whose only child was a junction is
	// otherwise empty and needs its own entry, or a restore never recreates it.
	if !sawDirEntry {
		t.Fatal("directory whose only child was skipped must get its own KindDir entry")
	}
}

// End-to-end wiring: a run whose walk skips a reparse point completes green
// with the skip named on job.Warning and no ErrorCount contribution.
func TestRunBackupContext_SkippedReparsePointSetsWarningNotErrors(t *testing.T) {
	root := t.TempDir()
	createTempFile(t, root, "data.txt", "payload that uploads fine")
	fifo := filepath.Join(root, "My Music")
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Skipf("mkfifo unsupported here: %v", err)
	}
	orig := skippedReparsePointFor
	skippedReparsePointFor = func(path string, info os.FileInfo) (skippedReparsePoint, bool) {
		return skippedReparsePoint{path: path, kind: reparseKindJunction, target: `C:\Users\Public\Music`}, true
	}
	t.Cleanup(func() { skippedReparsePointFor = orig })

	mgr := NewBackupManager(BackupConfig{
		Provider:   newMockProvider(),
		Paths:      []string{root},
		StagingDir: t.TempDir(),
	})
	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("a skipped junction must not downgrade the run, status = %q", job.Status)
	}
	if job.ErrorCount != 0 {
		t.Fatalf("ErrorCount = %d, want 0", job.ErrorCount)
	}
	want := fifo + ` (junction -> C:\Users\Public\Music)`
	if !strings.Contains(job.Warning, "1 reparse point(s) were not backed up") || !strings.Contains(job.Warning, want) {
		t.Fatalf("Warning must name the skipped junction, got: %q", job.Warning)
	}
	if job.FilesBackedUp != 1 {
		t.Fatalf("FilesBackedUp = %d, want 1", job.FilesBackedUp)
	}
}

func TestCollectBackupFiles_UnclassifiedIrregularEntryNotRecorded(t *testing.T) {
	root := t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(root, "pipe"), 0o644); err != nil {
		t.Skipf("mkfifo unsupported here: %v", err)
	}
	// The real non-Windows classifier: a FIFO is not a reparse point.
	_, skips, err := NewBackupManager(BackupConfig{}).collectBackupFilesWithSkips(context.Background(), []string{root}, nil, nil)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if skips.total != 0 {
		t.Fatalf("a FIFO on a non-Windows host is not a reparse point; got %+v", skips)
	}
}
