package tools

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// cleanupGuard is defence in depth against a FORGED execute body (spec §10.2):
// the API already re-filters through the rule table, and the agent re-checks
// membership before it unlinks anything. These cases drive the pure seam with
// an explicit GOOS so both path grammars are exercised from any host.
func TestCleanupGuardRejection(t *testing.T) {
	tmpDir := t.TempDir()
	regular := filepath.Join(tmpDir, "regular.bin")
	if err := os.WriteFile(regular, []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	info, err := os.Lstat(regular)
	if err != nil {
		t.Fatalf("lstat: %v", err)
	}

	match := matchCleanupRuleFor("linux", "/tmp/build.tmp")
	aged := fakeFileInfo{FileInfo: info, modTime: time.Now().Add(-48 * time.Hour)}
	if err := cleanupGuardRejection(aged, match, false, time.Time{}, time.Now()); err != nil {
		t.Errorf("a path inside a cleanup rule must pass the guard, got %v", err)
	}
	for _, tc := range []struct{ goos, path, reason string }{
		{"darwin", "/Users/alice/Documents/taxes.pdf", "matches no cleanup rule"},
		{"linux", "/etc/passwd", "cleanup-denied root"},
	} {
		target, err := openCleanupTarget(tc.goos, tc.path, "/")
		if target != nil {
			target.close()
		}
		if err == nil || !strings.Contains(err.Error(), tc.reason) {
			t.Errorf("expected %s rejection, got %v", tc.reason, err)
		}
		if err != nil && !strings.HasPrefix(err.Error(), CleanupGuardRejectedPrefix) {
			t.Errorf("rejection must carry the pinned prefix, got %q", err.Error())
		}
	}
}

func TestCleanupGuardRejectsSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX symlink fixture; Windows reparse points are covered by isReparsePoint")
	}
	tmpDir := cleanupTempDir(t)
	target := filepath.Join(tmpDir, "target.bin")
	if err := os.WriteFile(target, []byte("keep me"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	link := filepath.Join(tmpDir, "link.tmp")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	result := DeleteFile(map[string]any{
		"path":         link,
		"permanent":    true,
		"cleanupGuard": true,
	})
	if result.Status != "failed" {
		t.Fatalf("expected the guard to refuse a symlink, got %q", result.Status)
	}
	if !strings.HasPrefix(result.Error, CleanupGuardRejectedPrefix) {
		t.Fatalf("expected the pinned rejection prefix, got %q", result.Error)
	}
	if !strings.Contains(result.Error, "symlink") {
		t.Fatalf("expected the reason to name the symlink, got %q", result.Error)
	}
	if _, err := os.Lstat(link); err != nil {
		t.Error("the symlink itself must survive a refusal")
	}
	if _, err := os.Stat(target); err != nil {
		t.Error("the symlink TARGET must survive")
	}
}

// Spec §6.3: the result gains bytesFreed so the API can report what was really
// reclaimed instead of summing stale snapshot sizes.
// SPEC §13 ROW 1 — the finding this redesign exists for. Preview
// `<anchor>/.cache/sub/x`, then replace `sub` with a symlink to a directory
// outside the tree before execute. A leaf-only Lstat sees an ordinary file and
// deletes the WRONG one. Deleting through an os.Root handle refuses it, because
// the runtime checks every component of the traversal, not just the leaf.
func TestCleanupGuardRefusesAnAncestorSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX symlink fixture; the Windows junction case is fileops_link_windows_test.go")
	}
	outside := t.TempDir()
	victim := filepath.Join(outside, "x")
	if err := os.WriteFile(victim, []byte("do not delete"), 0o644); err != nil {
		t.Fatalf("write victim: %v", err)
	}

	home := cleanupTempDir(t)
	cacheDir := filepath.Join(home, ".cache")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// `sub` is a symlink OUT of the tree, planted between preview and execute.
	if err := os.Symlink(outside, filepath.Join(cacheDir, "sub")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	target, err := openCleanupTarget(runtime.GOOS, filepath.Join(cacheDir, "sub", "x"), string(filepath.Separator))
	if err == nil {
		target.close()
		t.Fatal("expected the handle-based open to refuse a path whose ancestor escapes the anchor")
	}
	if !strings.HasPrefix(err.Error(), CleanupGuardRejectedPrefix) {
		t.Fatalf("expected the pinned rejection prefix, got %q", err.Error())
	}
	if _, statErr := os.Stat(victim); statErr != nil {
		t.Fatal("the file outside the tree must survive")
	}
}

// The anchor's own real path must sit on the dispatched volume, so a junction
// or symlink AT the anchor cannot relocate the whole operation.
func TestOpenCleanupTargetRejectsAnchorOffTheVolume(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fixture")
	}
	home := cleanupTempDir(t)
	elsewhere := t.TempDir()
	cacheDir := filepath.Join(home, ".cache")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(cacheDir, "blob"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	target, err := openCleanupTarget(runtime.GOOS, filepath.Join(cacheDir, "blob"), elsewhere)
	if err == nil {
		target.close()
		t.Fatal("expected the volume check to refuse an anchor outside the dispatched volumeRoot")
	}
	if !strings.Contains(err.Error(), "volume") {
		t.Fatalf("expected the reason to name the volume check, got %q", err.Error())
	}
}

// §13 row 2: identity, type, age and freshness are re-checked at EXECUTE.
func TestCleanupGuardRejectionLiveChecks(t *testing.T) {
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	tmpDir := t.TempDir()
	regular := filepath.Join(tmpDir, "regular.bin")
	if err := os.WriteFile(regular, []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	fileInfo, err := os.Lstat(regular)
	if err != nil {
		t.Fatalf("lstat: %v", err)
	}
	dirInfo, err := os.Lstat(tmpDir)
	if err != nil {
		t.Fatalf("lstat dir: %v", err)
	}
	tempMatch := &cleanupRuleMatch{Category: "temp_files", Granularity: "file", MinAge: 24 * time.Hour}
	trashMatch := &cleanupRuleMatch{Category: "trash", Granularity: "contents"}

	// A file-granularity target that has BECOME a directory is refused: those
	// rules dispatch recursive:false and a subtree delete is not what was
	// previewed.
	if err := cleanupGuardRejection(dirInfo, tempMatch, false, time.Time{}, now); err == nil ||
		!strings.Contains(err.Error(), "not a regular file") {
		t.Errorf("expected a not-a-regular-file rejection, got %v", err)
	}
	if err := cleanupGuardRejection(dirInfo, trashMatch, true, time.Time{}, now); err != nil {
		t.Errorf("a contents rule must accept a directory, got %v", err)
	}

	// Min-age is re-evaluated against the CURRENT mtime, not the snapshot's.
	fresh := fakeFileInfo{FileInfo: fileInfo, modTime: now.Add(-1 * time.Hour)}
	if err := cleanupGuardRejection(fresh, tempMatch, false, time.Time{}, now); err == nil ||
		!strings.Contains(err.Error(), "newer than the rule's minimum age") {
		t.Errorf("expected a min-age rejection, got %v", err)
	}
	aged := fakeFileInfo{FileInfo: fileInfo, modTime: now.Add(-48 * time.Hour)}
	if err := cleanupGuardRejection(aged, tempMatch, false, time.Time{}, now); err != nil {
		t.Errorf("an aged temp file must pass, got %v", err)
	}

	// A file modified AFTER the operator previewed it is a different file now.
	previewedAt := now.Add(-2 * time.Hour)
	touched := fakeFileInfo{FileInfo: fileInfo, modTime: now.Add(-1 * time.Hour)}
	if err := cleanupGuardRejection(touched, trashMatch, true, previewedAt, now); err == nil ||
		!strings.Contains(err.Error(), "modified after the preview") {
		t.Errorf("expected a freshness rejection, got %v", err)
	}
	stable := fakeFileInfo{FileInfo: fileInfo, modTime: now.Add(-6 * time.Hour)}
	if err := cleanupGuardRejection(stable, trashMatch, true, previewedAt, now); err != nil {
		t.Errorf("an untouched target must pass, got %v", err)
	}
}

// fakeFileInfo overrides ModTime so the age and freshness gates are driven
// deterministically without sleeping or back-dating real files.
type fakeFileInfo struct {
	os.FileInfo
	modTime time.Time
}

func (f fakeFileInfo) ModTime() time.Time { return f.modTime }

func TestDeleteFilePermanentReportsBytesFreed(t *testing.T) {
	tmpDir := t.TempDir()
	file := filepath.Join(tmpDir, "blob.bin")
	if err := os.WriteFile(file, make([]byte, 4096), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	var payload struct {
		Path          string   `json:"path"`
		Deleted       bool     `json:"deleted"`
		Permanent     bool     `json:"permanent"`
		BytesFreed    int64    `json:"bytesFreed"`
		SkippedLocked []string `json:"skippedLocked"`
	}
	decodeSuccessPayload(t, DeleteFile(map[string]any{"path": file, "permanent": true}), &payload)
	if !payload.Deleted || payload.BytesFreed != 4096 {
		t.Fatalf("expected deleted with bytesFreed=4096, got %+v", payload)
	}
	if len(payload.SkippedLocked) != 0 {
		t.Fatalf("expected no locked paths, got %v", payload.SkippedLocked)
	}
}

func TestDeleteFilePermanentRecursiveSumsTreeSize(t *testing.T) {
	tmpDir := t.TempDir()
	tree := filepath.Join(tmpDir, "a", "b")
	if err := os.MkdirAll(tree, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tree, "one"), make([]byte, 1000), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tmpDir, "a", "two"), make([]byte, 24), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	var payload struct {
		BytesFreed int64 `json:"bytesFreed"`
	}
	decodeSuccessPayload(t, DeleteFile(map[string]any{
		"path":      filepath.Join(tmpDir, "a"),
		"permanent": true,
		"recursive": true,
	}), &payload)
	if payload.BytesFreed != 1024 {
		t.Fatalf("expected bytesFreed=1024 for the whole tree, got %d", payload.BytesFreed)
	}
}

func TestIsSharingViolationIsFalseOnPosix(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("covered by fileops_link_windows_test.go")
	}
	if isSharingViolation(os.ErrPermission) {
		t.Error("POSIX has no sharing violation; a permission error must not be reported as a lock")
	}
	if isSharingViolation(nil) {
		t.Error("nil is not a sharing violation")
	}
}

func TestIsReparsePointIsFalseOnPosix(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("covered by fileops_link_windows_test.go")
	}
	tmpDir := t.TempDir()
	file := filepath.Join(tmpDir, "x")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	info, err := os.Lstat(file)
	if err != nil {
		t.Fatalf("lstat: %v", err)
	}
	if isReparsePoint(info) {
		t.Error("POSIX has no reparse points")
	}
}

// Use a rule-matched POSIX temp root, independent of the host's TMPDIR setting.
func cleanupTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "breeze-cleanup-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func TestCleanupGuardRequiresPermanent(t *testing.T) {
	result := DeleteFile(map[string]any{"path": filepath.Join(t.TempDir(), "unused"), "cleanupGuard": true})
	if result.Status != "failed" || !strings.Contains(result.Error, "cleanupGuard requires permanent") {
		t.Fatalf("guarded deletes must not enter pathname-based trash operations: %+v", result)
	}
}

func TestCleanupGuardPermanentReportsBytesFreed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX temp fixture")
	}
	file := filepath.Join(cleanupTempDir(t), "aged.tmp")
	if err := os.WriteFile(file, make([]byte, 4096), 0o600); err != nil {
		t.Fatal(err)
	}
	aged := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(file, aged, aged); err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Deleted    bool  `json:"deleted"`
		BytesFreed int64 `json:"bytesFreed"`
	}
	decodeSuccessPayload(t, DeleteFile(map[string]any{
		"path": file, "permanent": true, "cleanupGuard": true,
		"volumeRoot": "/", "previewedAt": time.Now().Add(-time.Hour).Format(time.RFC3339),
	}), &payload)
	if !payload.Deleted || payload.BytesFreed != 4096 {
		t.Fatalf("unexpected result: %+v", payload)
	}
	if _, err := os.Lstat(file); !os.IsNotExist(err) {
		t.Fatalf("target survived: %v", err)
	}
}
