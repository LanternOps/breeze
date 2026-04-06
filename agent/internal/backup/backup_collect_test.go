package backup

import (
	"os"
	pathpkg "path/filepath"
	"strings"
	"testing"
	"time"
)

func TestShouldIncludeFile(t *testing.T) {
	tests := []struct {
		name    string
		modTime time.Time
		cutoff  time.Time
		want    bool
	}{
		{
			name:    "zero cutoff includes everything",
			modTime: time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC),
			cutoff:  time.Time{},
			want:    true,
		},
		{
			name:    "file modified after cutoff is included",
			modTime: time.Date(2026, 3, 13, 12, 0, 0, 0, time.UTC),
			cutoff:  time.Date(2026, 3, 13, 10, 0, 0, 0, time.UTC),
			want:    true,
		},
		{
			name:    "file modified before cutoff is excluded",
			modTime: time.Date(2026, 3, 13, 8, 0, 0, 0, time.UTC),
			cutoff:  time.Date(2026, 3, 13, 10, 0, 0, 0, time.UTC),
			want:    false,
		},
		{
			name:    "file modified exactly at cutoff is excluded",
			modTime: time.Date(2026, 3, 13, 10, 0, 0, 0, time.UTC),
			cutoff:  time.Date(2026, 3, 13, 10, 0, 0, 0, time.UTC),
			want:    false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := shouldIncludeFile(tt.modTime, tt.cutoff)
			if got != tt.want {
				t.Errorf("shouldIncludeFile(%v, %v) = %v, want %v", tt.modTime, tt.cutoff, got, tt.want)
			}
		})
	}
}

func TestCollectBackupFiles_SingleFile(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "collect.txt", "collect test")

	mgr := NewBackupManager(BackupConfig{
		Paths: []string{file1},
	})

	files, err := mgr.collectBackupFiles(time.Time{})
	if err != nil {
		t.Fatalf("collectBackupFiles failed: %v", err)
	}
	if len(files) != 1 {
		t.Fatalf("expected 1 file, got %d", len(files))
	}
	if files[0].sourcePath != file1 {
		t.Errorf("sourcePath = %q, want %q", files[0].sourcePath, file1)
	}
	if !strings.HasPrefix(files[0].snapshotPath, "path_0/") {
		t.Errorf("snapshotPath should start with 'path_0/', got %q", files[0].snapshotPath)
	}
}

func TestCollectBackupFiles_Directory(t *testing.T) {
	tmpDir := t.TempDir()
	subDir := pathpkg.Join(tmpDir, "collect_dir")
	os.MkdirAll(subDir, 0755)
	createTempFile(t, subDir, "a.txt", "a")
	createTempFile(t, subDir, "b.txt", "b")

	mgr := NewBackupManager(BackupConfig{
		Paths: []string{subDir},
	})

	files, err := mgr.collectBackupFiles(time.Time{})
	if err != nil {
		t.Fatalf("collectBackupFiles failed: %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("expected 2 files, got %d", len(files))
	}
}

func TestCollectBackupFiles_SortedBySnapshotPath(t *testing.T) {
	tmpDir := t.TempDir()
	subDir := pathpkg.Join(tmpDir, "sorted")
	os.MkdirAll(subDir, 0755)
	createTempFile(t, subDir, "z.txt", "z")
	createTempFile(t, subDir, "a.txt", "a")
	createTempFile(t, subDir, "m.txt", "m")

	mgr := NewBackupManager(BackupConfig{
		Paths: []string{subDir},
	})

	files, err := mgr.collectBackupFiles(time.Time{})
	if err != nil {
		t.Fatalf("collectBackupFiles failed: %v", err)
	}
	if len(files) != 3 {
		t.Fatalf("expected 3 files, got %d", len(files))
	}

	for i := 1; i < len(files); i++ {
		if files[i-1].snapshotPath >= files[i].snapshotPath {
			t.Errorf("files not sorted: %q >= %q", files[i-1].snapshotPath, files[i].snapshotPath)
		}
	}
}

func TestCollectBackupFiles_EmptyPath(t *testing.T) {
	mgr := NewBackupManager(BackupConfig{
		Paths: []string{""},
	})

	files, err := mgr.collectBackupFiles(time.Time{})
	if err == nil {
		t.Fatal("expected error for empty path")
	}
	if len(files) != 0 {
		t.Errorf("expected 0 files for empty path, got %d", len(files))
	}
}

func TestCollectBackupFiles_NonexistentPath(t *testing.T) {
	mgr := NewBackupManager(BackupConfig{
		Paths: []string{"/nonexistent/path/for/backup"},
	})

	files, err := mgr.collectBackupFiles(time.Time{})
	if err == nil {
		t.Fatal("expected error for nonexistent path")
	}
	if len(files) != 0 {
		t.Errorf("expected 0 files, got %d", len(files))
	}
}

func TestCollectBackupFiles_SkipsSymlinks(t *testing.T) {
	tmpDir := t.TempDir()
	subDir := pathpkg.Join(tmpDir, "symlink_test")
	os.MkdirAll(subDir, 0755)

	realFile := createTempFile(t, subDir, "real.txt", "real content")
	linkPath := pathpkg.Join(subDir, "link.txt")
	if err := os.Symlink(realFile, linkPath); err != nil {
		t.Skipf("symlinks not supported: %v", err)
	}

	mgr := NewBackupManager(BackupConfig{
		Paths: []string{subDir},
	})

	files, err := mgr.collectBackupFiles(time.Time{})
	if err != nil {
		t.Fatalf("collectBackupFiles failed: %v", err)
	}
	// Should only include the real file, not the symlink
	if len(files) != 1 {
		t.Fatalf("expected 1 file (real only, symlink skipped), got %d", len(files))
	}
	if !strings.Contains(files[0].sourcePath, "real.txt") {
		t.Errorf("expected real.txt, got %q", files[0].sourcePath)
	}
}

func TestCollectBackupFiles_WithCutoff(t *testing.T) {
	tmpDir := t.TempDir()
	subDir := pathpkg.Join(tmpDir, "cutoff_test")
	os.MkdirAll(subDir, 0755)

	oldFile := createTempFile(t, subDir, "old.txt", "old")
	newFile := createTempFile(t, subDir, "new.txt", "new")

	// Set old file's mod time to the past
	oldTime := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	os.Chtimes(oldFile, oldTime, oldTime)

	cutoff := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)

	mgr := NewBackupManager(BackupConfig{
		Paths: []string{subDir},
	})

	files, err := mgr.collectBackupFiles(cutoff)
	if err != nil {
		t.Fatalf("collectBackupFiles failed: %v", err)
	}

	// Only new file should be included
	if len(files) != 1 {
		t.Fatalf("expected 1 file (old excluded by cutoff), got %d", len(files))
	}
	if !strings.Contains(files[0].sourcePath, "new.txt") {
		t.Errorf("expected new.txt, got %q", files[0].sourcePath)
	}
	_ = newFile
}

func TestCollectBackupFiles_MixedValidAndInvalid(t *testing.T) {
	tmpDir := t.TempDir()
	validFile := createTempFile(t, tmpDir, "valid.txt", "valid data")

	mgr := NewBackupManager(BackupConfig{
		Paths: []string{validFile, "/nonexistent/invalid_path"},
	})

	files, err := mgr.collectBackupFiles(time.Time{})
	// Should still collect valid file even though one path is invalid
	if len(files) != 1 {
		t.Fatalf("expected 1 valid file, got %d", len(files))
	}
	if err == nil {
		t.Error("expected error for invalid path")
	}
}

func TestCollectBackupFiles_PathLabeling(t *testing.T) {
	tmpDir := t.TempDir()
	dir1 := pathpkg.Join(tmpDir, "first")
	dir2 := pathpkg.Join(tmpDir, "second")
	os.MkdirAll(dir1, 0755)
	os.MkdirAll(dir2, 0755)

	createTempFile(t, dir1, "a.txt", "a")
	createTempFile(t, dir2, "b.txt", "b")

	mgr := NewBackupManager(BackupConfig{
		Paths: []string{dir1, dir2},
	})

	files, err := mgr.collectBackupFiles(time.Time{})
	if err != nil {
		t.Fatalf("collectBackupFiles failed: %v", err)
	}

	// Check that files are labeled with path_0 and path_1
	hasPath0 := false
	hasPath1 := false
	for _, f := range files {
		if strings.HasPrefix(f.snapshotPath, "path_0/") {
			hasPath0 = true
		}
		if strings.HasPrefix(f.snapshotPath, "path_1/") {
			hasPath1 = true
		}
	}
	if !hasPath0 {
		t.Error("expected a file with path_0 prefix")
	}
	if !hasPath1 {
		t.Error("expected a file with path_1 prefix")
	}
}
