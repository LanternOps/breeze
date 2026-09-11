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
	files, err := mgr.collectBackupFilesFromPaths(context.Background(), []string{root}, nil, nil)
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
	// A genuinely empty directory (never itself pattern-excluded) is not a
	// placeholder — see TestCollectBackupFiles_ExcludedDirectoriesStillGetManifestEntries
	// for the pattern-excluded case, which IS (review fix, #5493).
	if empty.placeholder {
		t.Error("a genuinely empty dir must not be marked placeholder")
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

// #5493: found live on the bare-metal boot proof. The whole-machine preset
// excludes /proc/**, /tmp/**, /var/tmp/** (and siblings). Before the fix, an
// excluded directory was pruned via fs.SkipDir without ever being added to
// the walker's candidate-directory list, so it could never get its own
// manifest entry — and any directory whose children were all excluded still
// looked "non-empty" to dirNeedsEntry because childCount counted excluded
// children too. The rebuilt root ended up with no /proc, /tmp, or /var/tmp,
// so systemd couldn't mount its API filesystems and update-initramfs failed
// (mktemp: failed to create directory via template
// '/var/tmp/mkinitramfs_XXXXXX': No such file or directory).
//
// An excluded directory must still be recorded (mode/owner preserved, e.g.
// /tmp's sticky 1777) even though its contents are skipped, and an excluded
// child (file or directory) must never count toward its parent's
// childCount.
func TestCollectBackupFiles_ExcludedDirectoriesStillGetManifestEntries(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix mode bits (sticky 1777) and ownership")
	}
	root := t.TempDir()
	mustMkdir := func(rel string, mode os.FileMode) string {
		p := pathpkg.Join(root, rel)
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, mode); err != nil {
			t.Fatal(err)
		}
		return p
	}
	mustFile := func(rel string) {
		p := pathpkg.Join(root, rel)
		if err := os.MkdirAll(pathpkg.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	const sticky1777 = os.ModeSticky | 0o777
	mustMkdir("proc", 0o755)
	mustFile("proc/x")
	mustMkdir("tmp", sticky1777)
	mustFile("tmp/y")
	mustMkdir("var/tmp", sticky1777)
	mustFile("var/tmp/z")
	mustFile("var/log/syslog")
	mustFile("etc/hosts")

	excl := newExcludeMatcher([]string{"/proc/**", "/tmp/**", "/var/tmp/**"})
	files, err := NewBackupManager(BackupConfig{}).collectBackupFilesFromPaths(context.Background(), []string{root}, excl, nil)
	if err != nil {
		t.Fatal(err)
	}
	byRel := map[string]backupFile{}
	for _, f := range files {
		rel, _ := pathpkg.Rel(root, f.sourcePath)
		byRel[pathpkg.ToSlash(rel)] = f
	}

	// Excluded directories themselves must still be recorded, with their
	// real mode preserved, and marked Placeholder — restore must not
	// re-permission them if they already exist (review fix, #5493).
	proc, ok := byRel["proc"]
	if !ok || proc.kind != KindDir || proc.modeBits != 0o755 || !proc.placeholder {
		t.Errorf("proc entry = %+v (ok=%v), want KindDir mode 0755 placeholder=true", proc, ok)
	}
	tmp, ok := byRel["tmp"]
	if !ok || tmp.kind != KindDir || tmp.modeBits != uint32(sticky1777) || !tmp.placeholder {
		t.Errorf("tmp entry = %+v (ok=%v), want KindDir mode sticky 1777 placeholder=true", tmp, ok)
	}
	varTmp, ok := byRel["var/tmp"]
	if !ok || varTmp.kind != KindDir || varTmp.modeBits != uint32(sticky1777) || !varTmp.placeholder {
		t.Errorf("var/tmp entry = %+v (ok=%v), want KindDir mode sticky 1777 placeholder=true", varTmp, ok)
	}

	// Their contents must never appear.
	if _, ok := byRel["proc/x"]; ok {
		t.Error("proc/x should have been excluded, but is present in the manifest")
	}
	if _, ok := byRel["tmp/y"]; ok {
		t.Error("tmp/y should have been excluded, but is present in the manifest")
	}
	if _, ok := byRel["var/tmp/z"]; ok {
		t.Error("var/tmp/z should have been excluded, but is present in the manifest")
	}

	// var has an included, default-mode child (var/log/syslog) plus the
	// excluded var/tmp — the excluded child must not count, but the
	// included one does, so var itself must NOT get an entry (default
	// MkdirAll 0755 already recreates it correctly).
	if _, ok := byRel["var"]; ok {
		t.Error("var should not get its own entry: it has an included child and default mode")
	}
	// Included files must still be captured normally.
	if _, ok := byRel["var/log/syslog"]; !ok {
		t.Error("var/log/syslog should have been backed up")
	}
	if _, ok := byRel["etc/hosts"]; !ok {
		t.Error("etc/hosts should have been backed up")
	}
}

// #5493: a directory that is not itself excluded, but whose ONLY children
// are excluded by pattern, must still read as empty and get its own
// manifest entry — otherwise it silently vanishes from a rebuild exactly
// like a directly-excluded directory does.
func TestCollectBackupFiles_DirectoryWithOnlyExcludedChildrenBecomesEmptyDirEntry(t *testing.T) {
	root := t.TempDir()
	cache := pathpkg.Join(root, "cache")
	if err := os.MkdirAll(cache, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pathpkg.Join(cache, "a.tmp"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pathpkg.Join(cache, "b.tmp"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	excl := newExcludeMatcher([]string{"*.tmp"})
	files, err := NewBackupManager(BackupConfig{}).collectBackupFilesFromPaths(context.Background(), []string{root}, excl, nil)
	if err != nil {
		t.Fatal(err)
	}
	byRel := map[string]backupFile{}
	for _, f := range files {
		rel, _ := pathpkg.Rel(root, f.sourcePath)
		byRel[pathpkg.ToSlash(rel)] = f
	}

	cacheEntry, ok := byRel["cache"]
	if !ok || cacheEntry.kind != KindDir {
		t.Errorf("cache entry = %+v (ok=%v), want an empty-dir KindDir entry", cacheEntry, ok)
	}
	// cache itself was never pattern-excluded (only its children were), so
	// this is an ordinary "genuinely empty" dir entry, not a placeholder —
	// its mode was legitimately captured and restore must always reapply
	// it, unlike a Placeholder entry (review fix, #5493).
	if cacheEntry.placeholder {
		t.Error("cache is genuinely empty (not itself excluded), must not be marked placeholder")
	}
	if _, ok := byRel["cache/a.tmp"]; ok {
		t.Error("cache/a.tmp should have been excluded")
	}
	if _, ok := byRel["cache/b.tmp"]; ok {
		t.Error("cache/b.tmp should have been excluded")
	}
}
