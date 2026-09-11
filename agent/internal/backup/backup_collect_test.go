package backup

import (
	"context"
	"os"
	pathpkg "path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestCollectBackupFiles_SingleFile(t *testing.T) {
	tmpDir := t.TempDir()
	file1 := createTempFile(t, tmpDir, "collect.txt", "collect test")

	mgr := NewBackupManager(BackupConfig{
		Paths: []string{file1},
	})

	files, err := mgr.collectBackupFiles()
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

	files, err := mgr.collectBackupFiles()
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

	files, err := mgr.collectBackupFiles()
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

	files, err := mgr.collectBackupFiles()
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

	files, err := mgr.collectBackupFiles()
	if err == nil {
		t.Fatal("expected error for nonexistent path")
	}
	if len(files) != 0 {
		t.Errorf("expected 0 files, got %d", len(files))
	}
}

// W02: the walker used to drop symlinks entirely; it now records them as a
// content-less backupFile (kind=KindSymlink, the verbatim readlink target,
// zero size) alongside the real file — see TestCollectBackupFiles_FidelityEntries
// for the fuller fidelity coverage (modes/owner/directories). This test keeps
// its original, narrower shape: a real file plus one symlink to it, both
// captured, the symlink never followed.
func TestCollectBackupFiles_CapturesSymlinks(t *testing.T) {
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

	files, err := mgr.collectBackupFiles()
	if err != nil {
		t.Fatalf("collectBackupFiles failed: %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("expected 2 entries (real file + symlink), got %d", len(files))
	}
	var real, link *backupFile
	for i := range files {
		switch {
		case strings.Contains(files[i].sourcePath, "real.txt"):
			real = &files[i]
		case strings.Contains(files[i].sourcePath, "link.txt"):
			link = &files[i]
		}
	}
	if real == nil || real.kind != "" {
		t.Fatalf("real file entry = %+v", real)
	}
	if link == nil || link.kind != KindSymlink || link.linkTarget != realFile || link.size != 0 {
		t.Fatalf("symlink entry = %+v", link)
	}
}

// A file's snapshot from a prior run must not silently exclude files that
// haven't changed since — every snapshot is a complete restore point (no
// mtime-cutoff filtering; see backup.go collectBackupFilesFromPaths).
func TestCollectBackupFiles_UnmodifiedFileStillIncluded(t *testing.T) {
	tmpDir := t.TempDir()
	subDir := pathpkg.Join(tmpDir, "unmodified_test")
	os.MkdirAll(subDir, 0755)

	oldFile := createTempFile(t, subDir, "old.txt", "old")
	oldTime := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	os.Chtimes(oldFile, oldTime, oldTime)

	mgr := NewBackupManager(BackupConfig{
		Paths: []string{subDir},
	})

	files, err := mgr.collectBackupFiles()
	if err != nil {
		t.Fatalf("collectBackupFiles failed: %v", err)
	}

	if len(files) != 1 {
		t.Fatalf("expected 1 file (old mtime must not be filtered out), got %d", len(files))
	}
	if !strings.Contains(files[0].sourcePath, "old.txt") {
		t.Errorf("expected old.txt, got %q", files[0].sourcePath)
	}
}

func TestCollectBackupFiles_MixedValidAndInvalid(t *testing.T) {
	tmpDir := t.TempDir()
	validFile := createTempFile(t, tmpDir, "valid.txt", "valid data")

	mgr := NewBackupManager(BackupConfig{
		Paths: []string{validFile, "/nonexistent/invalid_path"},
	})

	files, err := mgr.collectBackupFiles()
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

	files, err := mgr.collectBackupFiles()
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

// W02: the walker now records symlinks (never followed), empty directories,
// and directories whose mode/owner differ from the MkdirAll default — plus
// full mode bits and owner on every regular file (Unix only; Windows still
// skips modeBits/owner but keeps symlinks + empty dirs).
func TestCollectBackupFiles_FidelityEntries(t *testing.T) {
	root := t.TempDir()
	mk := func(rel string, mode os.FileMode) string {
		p := pathpkg.Join(root, rel)
		if err := os.MkdirAll(pathpkg.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, mode); err != nil {
			t.Fatal(err)
		}
		return p
	}
	// os.Chmod's mode argument is a Go os.FileMode, whose setuid/setgid/sticky
	// bits live at different bit positions than the traditional unix
	// 04000/02000/01000 encoding — passing the traditional literal straight
	// through (e.g. 0o4755) silently sets ONLY the permission bits (Go's
	// syscallMode only adds the special bits when os.ModeSetuid etc. is
	// actually set in the FileMode value). Use the os.Mode* constants so the
	// fixture matches what a real `chmod 4755`'d file decodes to via
	// os.Lstat (the kernel's raw st_mode IS correctly mapped back to
	// os.ModeSetuid/Sticky on read — this quirk is Chmod-argument-only).
	const setuidSticky = os.ModeSetuid | 0o755
	const stickyDir = os.ModeSticky | 0o730
	mk("usr/bin/tool", 0o755)
	mk("usr/bin/sudo", setuidSticky)
	if err := os.Symlink("usr/bin", pathpkg.Join(root, "bin")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := os.MkdirAll(pathpkg.Join(root, "var", "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(pathpkg.Join(root, "var", "spool", "cron"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(pathpkg.Join(root, "var", "spool", "cron"), stickyDir); err != nil {
		t.Fatal(err)
	}
	mk("var/spool/cron/root", 0o600)

	mgr := NewBackupManager(BackupConfig{Paths: []string{root}})
	files, err := mgr.collectBackupFilesFromPaths(context.Background(), []string{root}, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	byRel := map[string]backupFile{}
	for _, f := range files {
		rel, _ := pathpkg.Rel(root, f.sourcePath)
		byRel[pathpkg.ToSlash(rel)] = f
	}
	link, ok := byRel["bin"]
	if !ok || link.kind != KindSymlink || link.linkTarget != "usr/bin" || link.size != 0 {
		t.Fatalf("symlink entry = %+v (ok=%v)", link, ok)
	}
	empty, ok := byRel["var/empty"]
	if !ok || empty.kind != KindDir {
		t.Fatalf("empty dir entry = %+v (ok=%v)", empty, ok)
	}
	if _, ok := byRel["usr"]; ok {
		t.Error("a plain non-empty 0755 directory must not get an entry")
	}
	if runtime.GOOS != "windows" {
		cron := byRel["var/spool/cron"]
		if cron.kind != KindDir || cron.modeBits != uint32(stickyDir) {
			t.Errorf("sticky dir entry = %+v", cron)
		}
		sudo := byRel["usr/bin/sudo"]
		if sudo.modeBits != uint32(setuidSticky) || sudo.owner == nil || sudo.owner.UID != os.Getuid() {
			t.Errorf("setuid file = %+v", sudo)
		}
		tool := byRel["usr/bin/tool"]
		if tool.kind != "" || tool.modeBits != 0o755 {
			t.Errorf("regular file = %+v", tool)
		}
	}
	// Symlinked directories are recorded as links, never descended.
	if _, ok := byRel["bin/tool"]; ok {
		t.Error("walker followed a directory symlink")
	}
}
