package backup

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

// TestWindowsDirNeedsEntry pins #6506: a NON-empty Windows directory needs
// its own manifest entry whenever it carries a preserved attribute (Hidden,
// System, ReadOnly, …), not only when security-descriptor capture is on —
// without an entry nothing on the restore side can put the attribute back,
// and a hidden %APPDATA%-style tree comes back visible.
func TestWindowsDirNeedsEntry(t *testing.T) {
	const hidden = uint32(0x2)
	tests := []struct {
		name      string
		sdCapture bool
		winAttrs  uint32
		want      bool
	}{
		{"plain dir, no sd capture", false, 0, false},
		{"hidden dir, no sd capture", false, hidden, true},
		{"plain dir, sd capture on", true, 0, true},
		{"hidden dir, sd capture on", true, hidden, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := windowsDirNeedsEntry(tt.sdCapture, tt.winAttrs); got != tt.want {
				t.Errorf("windowsDirNeedsEntry(sdCapture=%v, winAttrs=%#x) = %v, want %v", tt.sdCapture, tt.winAttrs, got, tt.want)
			}
		})
	}
}

// TestRestore_DirWinAttrsAppliedAfterContents drives the real
// RestoreFromSnapshotContext with the attribute apply swapped for a recorder
// (#6506). Directory attributes are a post-pass: every directory's apply
// sees every file and every directory entry already in place, the deepest
// directory goes first, a directory with no preserved attributes gets no
// call at all, and every attribute apply precedes the directory
// security-descriptor post-pass (a restrictive DACL could otherwise deny
// the FILE_WRITE_ATTRIBUTES the attribute apply needs).
func TestRestore_DirWinAttrsAppliedAfterContents(t *testing.T) {
	const hidden = uint32(0x2)
	enc := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	files := []sdTestFile{
		{name: "f1.txt", content: "one", sourcePath: "/original/top/f1.txt"},
		{name: "f2.txt", content: "two", sourcePath: "/original/top/sub/f2.txt"},
	}
	extra := []SnapshotFile{
		{SourcePath: "/original/top", Kind: KindDir, ModeBits: uint32(os.ModeDir | 0o755), WinAttrs: hidden, SDIndex: 1},
		{SourcePath: "/original/top/sub", Kind: KindDir, ModeBits: uint32(os.ModeDir | 0o755), WinAttrs: hidden},
		{SourcePath: "/original/top/sub/deep", Kind: KindDir, ModeBits: uint32(os.ModeDir | 0o755), WinAttrs: hidden},
		{SourcePath: "/original/top/plain", Kind: KindDir, ModeBits: uint32(os.ModeDir | 0o755)},
	}
	provider, snapshotID := setupRestoreTestSnapshotWithSDEntries(t, files, extra, []string{enc("sd-top")})
	target := t.TempDir()

	finalPath := func(p string) string {
		r, err := restoreRelativePath(p)
		if err != nil {
			t.Fatalf("restoreRelativePath(%q): %v", p, err)
		}
		return filepath.Join(target, r)
	}
	present := func() (filesPresent, dirsPresent int) {
		for _, f := range files {
			if b, err := os.ReadFile(finalPath(f.sourcePath)); err == nil && string(b) == f.content {
				filesPresent++
			}
		}
		for _, d := range extra {
			if info, err := os.Stat(finalPath(d.SourcePath)); err == nil && info.IsDir() {
				dirsPresent++
			}
		}
		return filesPresent, dirsPresent
	}

	type attrCall struct {
		path                      string
		attrs                     uint32
		filesPresent, dirsPresent int
		sdAppliesBefore           int
	}
	var attrCalls []attrCall
	sdCalls := recordingSecurityApplier(t, func() sdApplyCall { return sdApplyCall{} })
	origApply := restoreApplyWinAttrs
	t.Cleanup(func() { restoreApplyWinAttrs = origApply })
	restoreApplyWinAttrs = func(path string, attrs uint32) error {
		fp, dp := present()
		attrCalls = append(attrCalls, attrCall{path: path, attrs: attrs, filesPresent: fp, dirsPresent: dp, sdAppliesBefore: len(*sdCalls)})
		return nil
	}
	origEnabled := restoreAppliesSecurityDescriptors
	t.Cleanup(func() { restoreAppliesSecurityDescriptors = origEnabled })
	restoreAppliesSecurityDescriptors = true

	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: target}, nil)
	if err != nil {
		t.Fatalf("RestoreFromSnapshot: %v", err)
	}
	if result.FilesRestored != len(files)+len(extra) || result.FilesFailed != 0 {
		t.Fatalf("result = %+v, want %d restored, 0 failed", result, len(files)+len(extra))
	}

	wantOrder := []string{
		finalPath("/original/top/sub/deep"),
		finalPath("/original/top/sub"),
		finalPath("/original/top"),
	}
	if len(attrCalls) != len(wantOrder) {
		t.Fatalf("attribute applies = %+v, want exactly %d (none for the attribute-less dir)", attrCalls, len(wantOrder))
	}
	for i, c := range attrCalls {
		if c.path != wantOrder[i] {
			t.Errorf("attribute apply %d = %s, want %s (deepest first)", i, c.path, wantOrder[i])
		}
		if c.attrs != hidden {
			t.Errorf("attribute apply %d (%s) attrs = %#x, want %#x", i, c.path, c.attrs, hidden)
		}
		if c.filesPresent != len(files) || c.dirsPresent != len(extra) {
			t.Errorf("attribute apply %d (%s) saw %d/%d files and %d/%d dirs — directory attributes must be applied after every entry is placed",
				i, c.path, c.filesPresent, len(files), c.dirsPresent, len(extra))
		}
		if c.sdAppliesBefore != 0 {
			t.Errorf("attribute apply %d (%s) ran after %d directory security-descriptor applies — attributes must go first", i, c.path, c.sdAppliesBefore)
		}
	}
	if len(*sdCalls) != 1 {
		t.Errorf("directory security-descriptor applies = %d, want 1 (sd-top)", len(*sdCalls))
	}
}
