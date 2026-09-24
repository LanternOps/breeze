package backup

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/securefs"
)

// sdTestFile is one file this helper uploads, with the SD-relevant fields a
// test needs to set explicitly (setupRestoreTestSnapshot in restore_test.go
// hardcodes SourcePath = "/original/<name>" and never sets SDIndex, so it
// can't be reused as-is here).
type sdTestFile struct {
	name       string
	content    string
	sourcePath string // defaults to "/original/<name>" when empty, matching setupRestoreTestSnapshot
	sdIndex    int
}

// setupRestoreTestSnapshotWithSD is setupRestoreTestSnapshot (restore_test.go:42)
// generalized to also stamp Snapshot.SecurityDescriptors and each file's
// SDIndex, since that helper's fixed SnapshotFile shape has no room for
// either.
func setupRestoreTestSnapshotWithSD(t *testing.T, files []sdTestFile, secDescs []string) (*providers.LocalProvider, string) {
	t.Helper()
	return setupRestoreTestSnapshotWithSDEntries(t, files, nil, secDescs)
}

// setupRestoreTestSnapshotWithSDEntries additionally appends extra
// content-less manifest entries (directories, symlinks) verbatim.
func setupRestoreTestSnapshotWithSDEntries(t *testing.T, files []sdTestFile, extra []SnapshotFile, secDescs []string) (*providers.LocalProvider, string) {
	t.Helper()

	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)

	snapshotID := "test-snap-sd-001"
	prefix := filepath.Join("snapshots", snapshotID)

	var snapshotFiles []SnapshotFile
	for _, f := range files {
		srcDir := t.TempDir()
		srcPath := filepath.Join(srcDir, f.name)
		if err := os.MkdirAll(filepath.Dir(srcPath), 0o755); err != nil {
			t.Fatalf("create src dir: %v", err)
		}
		if err := os.WriteFile(srcPath, []byte(f.content), 0o644); err != nil {
			t.Fatalf("write src file: %v", err)
		}

		backupPath := filepath.Join(prefix, "files", f.name+".gz")
		if err := provider.Upload(srcPath, backupPath); err != nil {
			t.Fatalf("upload %s: %v", f.name, err)
		}

		sourcePath := f.sourcePath
		if sourcePath == "" {
			sourcePath = filepath.Join("/original", f.name)
		}
		snapshotFiles = append(snapshotFiles, SnapshotFile{
			SourcePath: sourcePath,
			BackupPath: filepath.ToSlash(backupPath),
			Size:       int64(len(f.content)),
			ModTime:    time.Now().UTC(),
			SDIndex:    f.sdIndex,
		})
	}
	snapshotFiles = append(snapshotFiles, extra...)

	snapshot := Snapshot{
		ID:                  snapshotID,
		Timestamp:           time.Now().UTC(),
		Files:               snapshotFiles,
		Size:                totalSize(snapshotFiles),
		SecurityDescriptors: secDescs,
	}
	if len(extra) > 0 {
		snapshot.FormatVersion = manifestFormatFidelity
	}
	manifestData, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	manifestTmp := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(manifestTmp, manifestData, 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	manifestKey := filepath.Join(prefix, "manifest.json")
	if err := provider.Upload(manifestTmp, manifestKey); err != nil {
		t.Fatalf("upload manifest: %v", err)
	}
	return provider, snapshotID
}

func TestDecodeSecurityDescriptors_CorruptEntryWarnsAndDegradesGracefully(t *testing.T) {
	table, warnings := decodeSecurityDescriptors([]string{"AQIDBA==", "not-valid-base64!!"})
	if len(table) != 2 {
		t.Fatalf("table = %d entries, want 2", len(table))
	}
	if table[0] == nil {
		t.Error("table[0] should have decoded")
	}
	if table[1] != nil {
		t.Error("table[1] should be nil after a decode error")
	}
	if len(warnings) != 1 {
		t.Fatalf("warnings = %v, want exactly 1", warnings)
	}
}

// TestDecodeSecurityDescriptors_ZeroLengthIsCorrupt: a slot that decodes to
// zero bytes is a corrupt slot (warned), not a silent no-op.
func TestDecodeSecurityDescriptors_ZeroLengthIsCorrupt(t *testing.T) {
	table, warnings := decodeSecurityDescriptors([]string{"", "AQ=="})
	if len(table) != 2 || table[0] != nil || string(table[1]) != "\x01" {
		t.Fatalf("table = %v, want [nil [1]]", table)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "entry 1 is corrupt") {
		t.Fatalf("warnings = %v, want exactly one for entry 1", warnings)
	}
}

func TestSDBytesAt(t *testing.T) {
	table := [][]byte{{1}, {2}, {3}}
	if got := sdBytesAt(table, 0); got != nil {
		t.Errorf("index 0 = %v, want nil", got)
	}
	if got := sdBytesAt(table, 2); string(got) != "\x02" {
		t.Errorf("index 2 = %v, want [2]", got)
	}
	if got := sdBytesAt(table, 4); got != nil {
		t.Errorf("index 4 (out of range) = %v, want nil", got)
	}
	if got := sdBytesAt(table, -1); got != nil {
		t.Errorf("index -1 = %v, want nil", got)
	}
}

func sdWarnings(warnings []string) []string {
	var out []string
	for _, w := range warnings {
		if strings.Contains(w, "security descriptor") {
			out = append(out, w)
		}
	}
	return out
}

// TestRestoreSecurity_DisabledIgnoresTableEntirely: off Windows the table is
// never decoded (a corrupt slot raises nothing) and no entry resolves (R37).
func TestRestoreSecurity_DisabledIgnoresTableEntirely(t *testing.T) {
	entries := []SnapshotFile{{SourcePath: "/a", SDIndex: 1}, {SourcePath: "/b", SDIndex: 7}, {SourcePath: "/c"}}
	rs, warnings := newRestoreSecurity([]string{"AQIDBA==", "not-base64!!"}, entries, false)
	if len(warnings) != 0 {
		t.Errorf("warnings = %v, want none when disabled", warnings)
	}
	if rs.active() {
		t.Error("active() = true when disabled")
	}
	for _, e := range entries {
		if sd := rs.forEntry(e); sd != nil {
			t.Errorf("forEntry(%s) = %v, want nil when disabled", e.SourcePath, sd)
		}
	}
	if got := rs.finish(); len(got) != 0 {
		t.Errorf("finish() = %v, want none when disabled", got)
	}
}

// TestRestoreSecurity_NoTableNoWarnings: a manifest without a table (every
// pre-W06 manifest) restores exactly as today — no lookups, no warnings.
func TestRestoreSecurity_NoTableNoWarnings(t *testing.T) {
	entries := []SnapshotFile{{SourcePath: "/a"}, {SourcePath: "/b", Kind: KindDir}}
	rs, warnings := newRestoreSecurity(nil, entries, true)
	if len(warnings) != 0 || rs.active() {
		t.Fatalf("warnings = %v active = %v, want none/false", warnings, rs.active())
	}
	for _, e := range entries {
		if rs.forEntry(e) != nil {
			t.Errorf("forEntry(%s) non-nil without a table", e.SourcePath)
		}
	}
	if got := rs.finish(); len(got) != 0 {
		t.Errorf("finish() = %v, want none without a table", got)
	}
}

// TestRestoreSecurity_MissingAndTruncated covers rulings 3 and 4: SDIndex 0
// in a manifest that HAS a table is counted into ONE aggregate warning; an
// index past the table's end raises ONE truncation warning, takes no
// descriptor, and is NOT counted again in the aggregate; a symlink never
// takes a descriptor and is never counted.
func TestRestoreSecurity_MissingAndTruncated(t *testing.T) {
	entries := []SnapshotFile{
		{SourcePath: "/has", SDIndex: 2},
		{SourcePath: "/zero1"},
		{SourcePath: "/zero2", Kind: KindDir},
		{SourcePath: "/past1", SDIndex: 3},
		{SourcePath: "/past2", SDIndex: 9},
		{SourcePath: "/link", Kind: KindSymlink, SDIndex: 1},
		{SourcePath: "/linkzero", Kind: KindSymlink},
	}
	rs, warnings := newRestoreSecurity([]string{"AQ==", "Ag=="}, entries, true)
	if !rs.active() {
		t.Fatal("active() = false with a table and enabled")
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "security descriptor table is truncated") {
		t.Fatalf("warnings = %v, want exactly one truncation warning", warnings)
	}
	if !strings.Contains(warnings[0], "2 entries") {
		t.Errorf("truncation warning %q should count the 2 out-of-range entries", warnings[0])
	}
	got := map[string][]byte{}
	for _, e := range entries {
		got[e.SourcePath] = rs.forEntry(e)
	}
	if string(got["/has"]) != "\x02" {
		t.Errorf("/has = %v, want slot 2 ([2])", got["/has"])
	}
	for _, p := range []string{"/zero1", "/zero2", "/past1", "/past2", "/link", "/linkzero"} {
		if got[p] != nil {
			t.Errorf("%s = %v, want nil", p, got[p])
		}
	}
	fin := rs.finish()
	if len(fin) != 1 {
		t.Fatalf("finish() = %v, want exactly one aggregate warning", fin)
	}
	// The 2 out-of-range entries are counted ONCE, in the truncation warning
	// above — never again in the missing-SD aggregate.
	if !strings.HasPrefix(fin[0], "2 entries had no security descriptor recorded; they were restored with ACLs inherited from the restore target") {
		t.Errorf("aggregate warning = %q, want 2 entries (the SDIndex-0 ones; truncated entries and symlinks excluded)", fin[0])
	}
}

type sdApplyCall struct {
	sd string
	// filesPresent is how many of the test's content files were published
	// under their final names (with their final content) at this apply.
	filesPresent int
	// dirsPresent is how many of the test's directory entries existed.
	dirsPresent int
	// tempPresent is how many .breeze-restore-* temporaries existed anywhere
	// under the target — the pinned temporary a file's descriptor must be
	// applied to before publication.
	tempPresent int
}

// recordingSecurityApplier swaps restoreSecurityApplier for one whose hook
// records each apply (and the tree's state at that moment) instead of
// touching the handle. Descriptors named "sd-INVALID" are refused at build
// time; "sd-FAIL" fail at apply time.
func recordingSecurityApplier(t *testing.T, snapshot func() sdApplyCall) *[]sdApplyCall {
	t.Helper()
	var calls []sdApplyCall
	orig := restoreSecurityApplier
	t.Cleanup(func() { restoreSecurityApplier = orig })
	restoreSecurityApplier = func(sd []byte) (*securefs.SecurityApplier, error) {
		if string(sd) == "sd-INVALID" {
			return nil, errors.New("injected invalid descriptor")
		}
		return &securefs.SecurityApplier{Apply: func(uintptr) error {
			c := snapshot()
			c.sd = string(sd)
			calls = append(calls, c)
			if string(sd) == "sd-FAIL" {
				return errors.New("injected apply failure")
			}
			return nil
		}}, nil
	}
	return &calls
}

// TestRestore_SDWiring drives the real RestoreFromSnapshotContext with the
// Windows gate forced on and the securefs hook swapped for a recorder, so
// the wiring is proven on every host (the Windows-tagged tests prove the
// real apply). Asserts: each file's own slot is applied to the pinned
// temporary BEFORE publication (its final name does not exist yet);
// directories are applied through securefs's pinned walk in a post-pass
// after EVERY entry is in place, deepest first; SDIndex-0 entries collapse
// into one aggregate warning; an apply failure and an invalid descriptor are
// warnings and the file still counts restored (R39); symlinks get nothing.
func TestRestore_SDWiring(t *testing.T) {
	enc := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	files := []sdTestFile{
		{name: "f1.txt", content: "one", sourcePath: "/original/top/f1.txt", sdIndex: 1},
		{name: "f2.txt", content: "two", sourcePath: "/original/top/sub/f2.txt", sdIndex: 2},
		{name: "f3.txt", content: "three", sourcePath: "/original/top/sub/f3.txt"}, // SDIndex 0
		{name: "f4.txt", content: "four", sourcePath: "/original/top/f4.txt", sdIndex: 3},
		{name: "f5.txt", content: "five", sourcePath: "/original/top/f5.txt", sdIndex: 6},
	}
	extra := []SnapshotFile{
		{SourcePath: "/original/top", Kind: KindDir, ModeBits: uint32(os.ModeDir | 0o755), SDIndex: 4},
		{SourcePath: "/original/top/sub", Kind: KindDir, ModeBits: uint32(os.ModeDir | 0o755), SDIndex: 5},
		{SourcePath: "/original/top/empty", Kind: KindDir, ModeBits: uint32(os.ModeDir | 0o755)}, // SDIndex 0
	}
	provider, snapshotID := setupRestoreTestSnapshotWithSDEntries(t, files, extra,
		[]string{enc("sd-f1"), enc("sd-f2"), enc("sd-FAIL"), enc("sd-top"), enc("sd-sub"), enc("sd-INVALID")})
	target := t.TempDir()

	finalPath := func(p string) string {
		r, err := restoreRelativePath(p)
		if err != nil {
			t.Fatalf("restoreRelativePath(%q): %v", p, err)
		}
		return filepath.Join(target, r)
	}
	calls := recordingSecurityApplier(t, func() sdApplyCall {
		var c sdApplyCall
		for _, f := range files {
			if b, err := os.ReadFile(finalPath(f.sourcePath)); err == nil && string(b) == f.content {
				c.filesPresent++
			}
		}
		for _, d := range extra {
			if info, err := os.Stat(finalPath(d.SourcePath)); err == nil && info.IsDir() {
				c.dirsPresent++
			}
		}
		_ = filepath.WalkDir(target, func(_ string, d os.DirEntry, err error) error {
			if err == nil && strings.HasPrefix(d.Name(), ".breeze-restore-") {
				c.tempPresent++
			}
			return nil
		})
		return c
	})
	origEnabled := restoreAppliesSecurityDescriptors
	t.Cleanup(func() { restoreAppliesSecurityDescriptors = origEnabled })
	restoreAppliesSecurityDescriptors = true

	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: target}, nil)
	if err != nil {
		t.Fatalf("RestoreFromSnapshot: %v", err)
	}
	if result.FilesRestored != len(files)+len(extra) || result.FilesFailed != 0 {
		t.Fatalf("result = %+v, want %d restored, 0 failed (SD failures are warnings)", result, len(files)+len(extra))
	}

	// Files in manifest order, each BEFORE its own publication: the i-th
	// file's apply sees exactly the i files published before it, plus its
	// own pinned temporary. Then directories, deepest first, with every
	// entry in place and no temporary left.
	want := []struct {
		sd           string
		filesPresent int
		isDir        bool
	}{
		{"sd-f1", 0, false},
		{"sd-f2", 1, false},
		{"sd-FAIL", 3, false}, // f3 (SDIndex 0) published in between
		{"sd-sub", len(files), true},
		{"sd-top", len(files), true},
	}
	if len(*calls) != len(want) {
		t.Fatalf("applies = %+v, want %d", *calls, len(want))
	}
	for i, w := range want {
		c := (*calls)[i]
		if c.sd != w.sd {
			t.Errorf("apply %d = %q, want %q", i, c.sd, w.sd)
		}
		if c.filesPresent != w.filesPresent {
			t.Errorf("apply %d (%s) saw %d files published, want %d", i, c.sd, c.filesPresent, w.filesPresent)
		}
		if w.isDir {
			if c.dirsPresent != len(extra) || c.tempPresent != 0 {
				t.Errorf("dir apply %s ran with %d/%d dirs and %d temporaries — the post-pass must run after every entry is placed", c.sd, c.dirsPresent, len(extra), c.tempPresent)
			}
		} else if c.tempPresent != 1 {
			t.Errorf("file apply %s saw %d pinned temporaries, want 1 — the descriptor must go on the temporary before publication", c.sd, c.tempPresent)
		}
	}

	var failWarn, invalidWarn, aggWarn int
	for _, w := range sdWarnings(result.Warnings) {
		switch {
		case strings.Contains(w, "f4.txt") && strings.Contains(w, "apply security descriptor: injected apply failure"):
			failWarn++
		case strings.Contains(w, "f5.txt") && strings.Contains(w, "could not reapply security descriptor: injected invalid descriptor"):
			invalidWarn++
		case strings.HasPrefix(w, "2 entries had no security descriptor recorded; they were restored with ACLs inherited from the restore target"):
			aggWarn++
		default:
			t.Errorf("unexpected security-descriptor warning %q", w)
		}
	}
	if failWarn != 1 || invalidWarn != 1 || aggWarn != 1 {
		t.Errorf("SD warnings = %v, want one apply failure (f4), one invalid descriptor (f5), one aggregate (2 entries)", sdWarnings(result.Warnings))
	}
	for _, f := range files {
		if b, err := os.ReadFile(finalPath(f.sourcePath)); err != nil || string(b) != f.content {
			t.Errorf("%s not restored: %q, %v", f.sourcePath, b, err)
		}
	}
}

// TestRestore_SDWiring_NoTableNoApply: a manifest without a table restores
// as today even with the Windows gate on — no apply calls, no warnings.
func TestRestore_SDWiring_NoTableNoApply(t *testing.T) {
	provider, snapshotID := setupRestoreTestSnapshotWithSD(t,
		[]sdTestFile{{name: "a.txt", content: "a"}, {name: "b.txt", content: "b"}}, nil)
	origEnabled, origApplier := restoreAppliesSecurityDescriptors, restoreSecurityApplier
	t.Cleanup(func() { restoreAppliesSecurityDescriptors, restoreSecurityApplier = origEnabled, origApplier })
	restoreAppliesSecurityDescriptors = true
	calls := 0
	restoreSecurityApplier = func([]byte) (*securefs.SecurityApplier, error) { calls++; return nil, nil }

	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: t.TempDir()}, nil)
	if err != nil {
		t.Fatalf("RestoreFromSnapshot: %v", err)
	}
	if result.FilesRestored != 2 || result.FilesFailed != 0 {
		t.Fatalf("result = %+v, want 2 restored", result)
	}
	if calls != 0 {
		t.Errorf("applySecurity called %d times for a manifest without a table", calls)
	}
	if w := sdWarnings(result.Warnings); len(w) != 0 {
		t.Errorf("SD warnings %v for a manifest without a table", w)
	}
}
