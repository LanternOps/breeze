//go:build windows

package backup

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func setHiddenForTest(t *testing.T, path string) {
	t.Helper()
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	attrs, err := windows.GetFileAttributes(p)
	if err != nil {
		t.Fatalf("GetFileAttributes(%s): %v", path, err)
	}
	if err := windows.SetFileAttributes(p, attrs|windows.FILE_ATTRIBUTE_HIDDEN); err != nil {
		t.Fatalf("SetFileAttributes(%s): %v", path, err)
	}
}

func isHiddenForTest(t *testing.T, path string) bool {
	t.Helper()
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	attrs, err := windows.GetFileAttributes(p)
	if err != nil {
		t.Fatalf("GetFileAttributes(%s): %v", path, err)
	}
	return attrs&windows.FILE_ATTRIBUTE_HIDDEN != 0
}

// TestCollectBackupFiles_HiddenNonEmptyDirGetsEntry is #6506's backup half
// on a real NTFS walk with security-descriptor capture OFF: a non-empty
// Hidden directory gets a KindDir entry carrying Hidden, while a plain
// non-empty sibling still gets none.
func TestCollectBackupFiles_HiddenNonEmptyDirGetsEntry(t *testing.T) {
	root := t.TempDir()
	hidden := filepath.Join(root, "hdir_full")
	plain := filepath.Join(root, "plain")
	for _, d := range []string{hidden, plain} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "inner.txt"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	setHiddenForTest(t, hidden)

	mgr := NewBackupManager(BackupConfig{CaptureSecurityDescriptors: false})
	files, err := mgr.collectBackupFilesFromPaths(context.Background(), []string{root}, nil, nil)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	var hiddenEntry, plainEntry *backupFile
	for i := range files {
		if files[i].kind != KindDir {
			continue
		}
		switch files[i].sourcePath {
		case hidden:
			hiddenEntry = &files[i]
		case plain:
			plainEntry = &files[i]
		}
	}
	if hiddenEntry == nil {
		t.Fatalf("no KindDir entry for non-empty hidden dir %s", hidden)
	}
	if hiddenEntry.winAttrs&windows.FILE_ATTRIBUTE_HIDDEN == 0 {
		t.Errorf("hidden dir entry winAttrs = %#x, want Hidden set", hiddenEntry.winAttrs)
	}
	if plainEntry != nil {
		t.Errorf("plain non-empty dir %s got an entry (winAttrs %#x); only attribute-bearing dirs should", plain, plainEntry.winAttrs)
	}
}

// TestRestore_HiddenNonEmptyDirComesBackHidden is #6506's restore half on
// the real path: a directory entry carrying Hidden is restored Hidden, and
// the file beneath it is restored too (the attribute went on afterwards).
func TestRestore_HiddenNonEmptyDirComesBackHidden(t *testing.T) {
	provider, snapshotID := setupRestoreTestSnapshotWithSDEntries(t,
		[]sdTestFile{{name: "inner.txt", content: "c", sourcePath: `C:\hdir_full\inner.txt`}},
		[]SnapshotFile{{SourcePath: `C:\hdir_full`, Kind: KindDir, WinAttrs: windows.FILE_ATTRIBUTE_HIDDEN}},
		nil,
	)
	target := t.TempDir()
	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: target}, nil)
	if err != nil {
		t.Fatalf("RestoreFromSnapshot: %v", err)
	}
	if result.FilesRestored != 2 || result.FilesFailed != 0 {
		t.Fatalf("result = %+v, want 2 restored, 0 failed", result)
	}
	if b, err := os.ReadFile(restoredPathForTest(t, target, `C:\hdir_full\inner.txt`)); err != nil || string(b) != "c" {
		t.Fatalf("child not restored: %q, %v", b, err)
	}
	if !isHiddenForTest(t, restoredPathForTest(t, target, `C:\hdir_full`)) {
		t.Errorf("restored directory is not Hidden")
	}
}
