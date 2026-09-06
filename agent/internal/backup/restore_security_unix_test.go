//go:build !windows

package backup

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRestoreFromSnapshot_DoesNotFollowTargetSymlink(t *testing.T) {
	provider, snapshotID := setupRestoreTestSnapshot(t, map[string]string{
		"nested/secret.txt": "synthetic restore bytes\n",
	})

	targetRoot := t.TempDir()
	outside := t.TempDir()
	if err := os.Mkdir(filepath.Join(targetRoot, "original"), 0o755); err != nil {
		t.Fatalf("create target prefix: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(targetRoot, "original", "nested")); err != nil {
		t.Fatalf("plant target symlink: %v", err)
	}

	result, err := RestoreFromSnapshot(provider, RestoreConfig{
		SnapshotID: snapshotID,
		TargetPath: targetRoot,
		WorkRoot:   t.TempDir(),
	}, nil)
	if err != nil {
		t.Fatalf("restore returned error: %v", err)
	}
	if result.FilesRestored != 0 || result.FilesFailed != 1 {
		t.Fatalf("result = restored %d, failed %d; want 0, 1", result.FilesRestored, result.FilesFailed)
	}
	if _, err := os.Stat(filepath.Join(outside, "secret.txt")); !os.IsNotExist(err) {
		t.Fatalf("restore escaped through target symlink: stat error = %v", err)
	}
}

func TestTestRestore_DoesNotReusePredictableTempTree(t *testing.T) {
	provider, snapshotID := setupRestoreTestSnapshot(t, map[string]string{
		"probe.txt": "synthetic test-restore bytes\n",
	})

	sharedTemp := t.TempDir()
	t.Setenv("TMPDIR", sharedTemp)
	outside := t.TempDir()
	fixedRoot := filepath.Join(sharedTemp, restoreTestPrefix)
	if err := os.Mkdir(fixedRoot, 0o755); err != nil {
		t.Fatalf("create predictable test-restore root: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(fixedRoot, snapshotID)); err != nil {
		t.Fatalf("plant predictable test-restore symlink: %v", err)
	}

	result, err := TestRestore(provider, snapshotID, t.TempDir(), nil)
	if err != nil {
		t.Fatalf("test restore returned error: %v", err)
	}
	if result.Status != "passed" {
		t.Fatalf("status = %q, want passed", result.Status)
	}
	if _, err := os.Stat(filepath.Join(outside, "original", "probe.txt")); !os.IsNotExist(err) {
		t.Fatalf("test restore escaped through predictable symlink: stat error = %v", err)
	}
}
