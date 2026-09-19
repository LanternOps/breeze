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

// Keep synthetic bin fixtures under a real cleanup anchor; the live guard
// validates both volume confinement and the temp rule's minimum age.
func contentsOnlyTempDir(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		return t.TempDir()
	}
	return cleanupTempDir(t)
}

func ageContentsOnlyTarget(t *testing.T, path string) {
	t.Helper()
	aged := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(path, aged, aged); err != nil {
		t.Fatalf("age contentsOnly fixture: %v", err)
	}
}

type contentsOnlyPayload struct {
	Path           string   `json:"path"`
	Deleted        bool     `json:"deleted"`
	ContentsOnly   bool     `json:"contentsOnly"`
	BytesFreed     int64    `json:"bytesFreed"`
	SkippedLocked  []string `json:"skippedLocked"`
	SkippedLinks   []string `json:"skippedLinks"`
	FailedChildren []string `json:"failedChildren"`
}

// The recycle-bin fixture from spec §11: the SID directory is emptied, the
// directory itself survives, and desktop.ini (which Explorer needs to render
// the bin) is preserved.
func TestDeleteFileContentsOnlyEmptiesBinAndKeepsDesktopIni(t *testing.T) {
	tmpDir := contentsOnlyTempDir(t)
	sidDir := filepath.Join(tmpDir, "$Recycle.Bin", "S-1-5-21-1")
	if err := os.MkdirAll(filepath.Join(sidDir, "nested"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sidDir, "desktop.ini"), []byte("ini"), 0o644); err != nil {
		t.Fatalf("write desktop.ini: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sidDir, "$RABCDEF.txt"), make([]byte, 2048), 0o644); err != nil {
		t.Fatalf("write bin entry: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sidDir, "nested", "deep.bin"), make([]byte, 1024), 0o644); err != nil {
		t.Fatalf("write nested entry: %v", err)
	}

	ageContentsOnlyTarget(t, sidDir)
	var payload contentsOnlyPayload
	decodeSuccessPayload(t, DeleteFile(map[string]any{
		"path":         sidDir,
		"permanent":    true,
		"recursive":    true,
		"contentsOnly": true,
		"cleanupGuard": true,
		"volumeRoot":   filepath.VolumeName(tmpDir) + string(filepath.Separator),
	}), &payload)

	if !payload.ContentsOnly || !payload.Deleted {
		t.Fatalf("expected a completed contentsOnly delete, got %+v", payload)
	}
	if payload.BytesFreed != 3072 {
		t.Errorf("expected bytesFreed=3072 (2048 + 1024, desktop.ini preserved), got %d", payload.BytesFreed)
	}
	if _, err := os.Stat(sidDir); err != nil {
		t.Fatal("the SID directory itself must survive a contentsOnly delete")
	}
	if _, err := os.Stat(filepath.Join(sidDir, "desktop.ini")); err != nil {
		t.Error("desktop.ini must be preserved")
	}
	if _, err := os.Stat(filepath.Join(sidDir, "$RABCDEF.txt")); !os.IsNotExist(err) {
		t.Error("the bin entry should be gone")
	}
	if _, err := os.Stat(filepath.Join(sidDir, "nested")); !os.IsNotExist(err) {
		t.Error("the nested directory should be gone")
	}
}

// Spec §6.3: "A test plants a symlink two levels deep pointing outside the tree
// and asserts the target survives." RemoveAll unlinks rather than follows, at
// any depth — this pins that, because a regression here destroys user data
// outside the cleanup scope.
func TestDeleteFileContentsOnlyNeverFollowsLinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX symlink fixture; the Windows equivalent is a reparse point, covered by isReparsePoint")
	}
	outside := t.TempDir()
	victim := filepath.Join(outside, "precious.txt")
	if err := os.WriteFile(victim, []byte("do not delete"), 0o644); err != nil {
		t.Fatalf("write victim: %v", err)
	}

	tmpDir := contentsOnlyTempDir(t)
	trash := filepath.Join(tmpDir, "Trash")
	deep := filepath.Join(trash, "one", "two")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Two levels deep, inside a subtree RemoveAll will delete.
	if err := os.Symlink(outside, filepath.Join(deep, "escape")); err != nil {
		t.Fatalf("symlink deep: %v", err)
	}
	// An immediate child link, which must be SKIPPED and reported.
	if err := os.Symlink(outside, filepath.Join(trash, "shortcut")); err != nil {
		t.Fatalf("symlink child: %v", err)
	}
	if err := os.WriteFile(filepath.Join(trash, "junk.bin"), make([]byte, 512), 0o644); err != nil {
		t.Fatalf("write junk: %v", err)
	}

	ageContentsOnlyTarget(t, trash)
	var payload contentsOnlyPayload
	decodeSuccessPayload(t, DeleteFile(map[string]any{
		"path":         trash,
		"permanent":    true,
		"recursive":    true,
		"contentsOnly": true,
		"cleanupGuard": true,
		"volumeRoot":   filepath.VolumeName(tmpDir) + string(filepath.Separator),
	}), &payload)

	if _, err := os.Stat(victim); err != nil {
		t.Fatalf("the symlink TARGET outside the tree must survive: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(trash, "shortcut")); err != nil {
		t.Error("an immediate symlink child must be skipped, not removed")
	}
	if len(payload.SkippedLinks) != 1 || filepath.Base(payload.SkippedLinks[0]) != "shortcut" {
		t.Errorf("expected the skipped link to be reported, got %v", payload.SkippedLinks)
	}
	if _, err := os.Stat(filepath.Join(trash, "one")); !os.IsNotExist(err) {
		t.Error("the nested subtree (including the deep symlink itself) should be gone")
	}
	if payload.BytesFreed != 512 {
		t.Errorf("expected bytesFreed=512 (the symlink contributes nothing), got %d", payload.BytesFreed)
	}
}

// §13 row 13: a contentsOnly run that could not remove every child must NOT
// read as a clean success. The agent reports failedChildren; the API turns that
// into `partial` (Task 8).
func TestDeleteFileContentsOnlyReportsFailedChildren(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("relies on POSIX mode bits that root ignores")
	}
	tmpDir := contentsOnlyTempDir(t)
	trash := filepath.Join(tmpDir, "Trash")
	stuck := filepath.Join(trash, "stuck")
	if err := os.MkdirAll(stuck, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stuck, "child"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.WriteFile(filepath.Join(trash, "junk.bin"), make([]byte, 128), 0o644); err != nil {
		t.Fatalf("write junk: %v", err)
	}
	// A directory with no write permission cannot have its child unlinked.
	if err := os.Chmod(stuck, 0o500); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(stuck, 0o755) })

	ageContentsOnlyTarget(t, trash)
	var payload contentsOnlyPayload
	decodeSuccessPayload(t, DeleteFile(map[string]any{
		"path": trash, "permanent": true, "recursive": true,
		"contentsOnly": true, "cleanupGuard": true, "volumeRoot": filepath.VolumeName(tmpDir) + string(filepath.Separator),
	}), &payload)

	if len(payload.FailedChildren) == 0 {
		t.Fatalf("expected the unremovable child to be reported, got %+v", payload)
	}
	if payload.Deleted {
		t.Error("deleted must be false when a child could not be removed")
	}
	if payload.BytesFreed != 128 {
		t.Errorf("expected the removable child's bytes to still be counted, got %d", payload.BytesFreed)
	}
}

func TestDeleteFileContentsOnlyRefusesANonDirectory(t *testing.T) {
	tmpDir := contentsOnlyTempDir(t)
	file := filepath.Join(tmpDir, "regular.bin")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	ageContentsOnlyTarget(t, file)
	result := DeleteFile(map[string]any{
		"path": file, "permanent": true, "contentsOnly": true, "cleanupGuard": true, "volumeRoot": filepath.VolumeName(tmpDir) + string(filepath.Separator),
	})
	if result.Status != "failed" || !strings.Contains(result.Error, "not a directory") {
		t.Fatalf("expected a not-a-directory refusal, got %q / %q", result.Status, result.Error)
	}
	if _, err := os.Stat(file); err != nil {
		t.Error("the file must survive the refusal")
	}
}

func TestDeleteFileContentsOnlyRequiresPermanent(t *testing.T) {
	tmpDir := t.TempDir()
	result := DeleteFile(map[string]any{"path": tmpDir, "contentsOnly": true})
	if result.Status != "failed" || !strings.Contains(result.Error, "contentsOnly requires permanent") {
		t.Fatalf("expected the flag combination to be refused, got %q / %q", result.Status, result.Error)
	}
}

// The depth check applies to the DIRECTORY, so the bin root stays refused while
// a SID directory one level down is reachable (spec §6.3).
func TestDeleteFileContentsOnlyStillHonoursTheBoundary(t *testing.T) {
	result := DeleteFile(map[string]any{
		"path":         string(filepath.Separator) + "home",
		"permanent":    true,
		"recursive":    true,
		"contentsOnly": true,
	})
	if result.Status != "failed" {
		t.Fatalf("a top-level directory must stay refused under contentsOnly, got %q", result.Status)
	}
}

// SPEC §13 ROW 1, second half. os.Root confines the traversal to the ANCHOR,
// and the anchor is the rule's wildcard-free literal prefix — `/tmp`, `/home`,
// `C:\Users`. A symlink whose target also lives under that anchor therefore
// does not escape the Root and is happily followed, so
// `/home/alice/.cache/sub -> ../../bob/Documents` deletes bob's files from
// inside alice's own rule match. Confinement to the anchor is NOT confinement
// to the previewed path: every component is checked by identity.
func TestCleanupGuardRefusesAnIntraAnchorSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX symlink fixture; the Windows junction case is fileops_link_windows_test.go")
	}
	// A sibling directory under the SAME anchor (/tmp), standing in for another
	// user's home under /home.
	sibling := cleanupTempDir(t)
	victim := filepath.Join(sibling, "victim.tmp")
	if err := os.WriteFile(victim, []byte("do not delete"), 0o644); err != nil {
		t.Fatalf("write victim: %v", err)
	}
	aged := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(victim, aged, aged); err != nil {
		t.Fatalf("age victim: %v", err)
	}

	home := cleanupTempDir(t)
	nested := filepath.Join(home, "nested")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// RELATIVE, so the Root resolves it instead of refusing it outright, and it
	// lands two levels below the anchor on a sibling inside the same anchor.
	relToSibling, err := filepath.Rel(nested, sibling)
	if err != nil {
		t.Fatalf("rel: %v", err)
	}
	if err := os.Symlink(relToSibling, filepath.Join(nested, "sub")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	result := DeleteFile(map[string]any{
		"path":         filepath.Join(nested, "sub", "victim.tmp"),
		"permanent":    true,
		"cleanupGuard": true,
	})
	if result.Status != "failed" {
		t.Fatalf("expected the guard to refuse a path traversing an intra-anchor symlink, got %q", result.Status)
	}
	if !strings.HasPrefix(result.Error, CleanupGuardRejectedPrefix) {
		t.Fatalf("expected the pinned rejection prefix, got %q", result.Error)
	}
	if _, statErr := os.Stat(victim); statErr != nil {
		t.Fatal("the sibling directory's file must survive")
	}
}
