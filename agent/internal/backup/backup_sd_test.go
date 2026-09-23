package backup

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestDirNeedsEntry_SDCaptureForcesWindowsNonEmptyDirEntry(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(dir) // a real 0755 directory: the non-Windows branch's "mode matches the default" case
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name       string
		empty      bool
		sdCapture  bool
		wantOnWin  bool
		wantOnUnix bool
	}{
		{"empty dir always gets an entry", true, false, true, true},
		{"empty dir with sd capture on still true", true, true, true, true},
		{"non-empty dir, no sd capture", false, false, false, false},
		{"non-empty dir, sd capture on", false, true, true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := dirNeedsEntry(info, nil, tt.empty, tt.sdCapture)
			want := tt.wantOnUnix
			if runtime.GOOS == "windows" {
				want = tt.wantOnWin
			}
			if got != want {
				t.Errorf("dirNeedsEntry(empty=%v, sdCapture=%v) = %v, want %v", tt.empty, tt.sdCapture, got, want)
			}
		})
	}
}

// TestCollectBackupFiles_SDCaptureRecordsEveryWindowsDir is the walker-level
// R40 check: with CaptureSecurityDescriptors on, a Windows run records a
// KindDir entry for EVERY walked directory (not just empty ones) and every
// entry carries a captured descriptor; with it off, non-empty directories
// get no entry and nothing carries a descriptor. Off Windows fileSecurity is
// a no-op and dirNeedsEntry's Unix branch ignores sdCapture, so the same
// tree yields no directory entries and no descriptors either way.
func TestCollectBackupFiles_SDCaptureRecordsEveryWindowsDir(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "a", "b")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{filepath.Join(root, "a"), nested} {
		if err := os.Chmod(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(nested, "f.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	for _, capture := range []bool{false, true} {
		mgr := NewBackupManager(BackupConfig{CaptureSecurityDescriptors: capture})
		files, err := mgr.collectBackupFilesFromPaths(context.Background(), []string{root}, nil, nil)
		if err != nil {
			t.Fatalf("capture=%v: collect: %v", capture, err)
		}
		byPath := map[string]backupFile{}
		for _, f := range files {
			byPath[f.snapshotPath] = f
		}
		wantSD := capture && runtime.GOOS == "windows"
		file, ok := byPath["path_0/a/b/f.txt"]
		if !ok {
			t.Fatalf("capture=%v: regular file missing from %v", capture, byPath)
		}
		if (len(file.sd) > 0) != wantSD {
			t.Errorf("capture=%v: file sd len=%d, want captured=%v", capture, len(file.sd), wantSD)
		}
		for _, rel := range []string{"path_0/a", "path_0/a/b"} {
			d, ok := byPath[rel]
			if ok != wantSD {
				t.Errorf("capture=%v: dir entry %s present=%v, want %v", capture, rel, ok, wantSD)
				continue
			}
			if !ok {
				continue
			}
			if d.kind != KindDir {
				t.Errorf("capture=%v: %s kind=%q, want %q", capture, rel, d.kind, KindDir)
			}
			if len(d.sd) == 0 {
				t.Errorf("capture=%v: dir %s has no captured sd", capture, rel)
			}
		}
	}
}

// TestCreateSnapshot_StampsSDIndexAtEveryAppendSite pins that every one of
// createSnapshotWithProgress's four entry-append sites (content-less,
// journal-resumed, incremental reference, uploaded) stamps SDIndex from THIS
// run's dedup table, that a resumed entry's stale SDIndex (a slot in the
// interrupted run's table) is overwritten, and that the table is attached to
// the manifest deduplicated in first-seen order.
func TestCreateSnapshot_StampsSDIndexAtEveryAppendSite(t *testing.T) {
	tmpDir := t.TempDir()
	modTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	sdA, sdB, sdC := []byte("descriptor-A"), []byte("descriptor-B"), []byte("descriptor-C")

	journal, _, err := openSnapshotJournal(t.TempDir(), "test-sd-stamp", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal: %v", err)
	}
	resPath := createTempFile(t, tmpDir, "res.txt", "resumed")
	if err := journal.Record(SnapshotFile{
		SourcePath: resPath, Size: int64(len("resumed")), ModTime: modTime, Checksum: "resumed", SDIndex: 9,
	}); err != nil {
		t.Fatalf("Record: %v", err)
	}
	refPath := createTempFile(t, tmpDir, "ref.txt", "ref")
	prev := &Snapshot{ID: "prev", Files: []SnapshotFile{{
		SourcePath: refPath, BackupPath: "snapshots/prev/files/ref.txt.gz", Size: 3, ModTime: modTime, Checksum: "c",
	}}}

	files := []backupFile{
		{sourcePath: tmpDir, snapshotPath: "path_0/d", kind: KindDir, modTime: modTime, sd: sdA},
		{sourcePath: resPath, snapshotPath: "path_0/res.txt", size: int64(len("resumed")), modTime: modTime, sd: sdB},
		{sourcePath: refPath, snapshotPath: "path_0/ref.txt", size: 3, modTime: modTime, sd: sdA},
		{sourcePath: createTempFile(t, tmpDir, "up.txt", "up"), snapshotPath: "path_0/up.txt", size: 2, modTime: modTime, sd: sdC},
	}
	snapshot, err := createSnapshotWithProgress(context.Background(), newMockProvider(), files, nil, journal, prev, nil)
	if err != nil {
		t.Fatalf("createSnapshotWithProgress: %v", err)
	}
	want := map[string]int{"path_0/d": 1, "res.txt": 2, "ref.txt": 1, "up.txt": 3}
	if len(snapshot.Files) != len(want) {
		t.Fatalf("got %d entries, want %d: %+v", len(snapshot.Files), len(want), snapshot.Files)
	}
	for _, f := range snapshot.Files {
		key := filepath.Base(f.SourcePath)
		if f.Kind == KindDir {
			key = "path_0/d"
		}
		if f.SDIndex != want[key] {
			t.Errorf("%s: SDIndex = %d, want %d", key, f.SDIndex, want[key])
		}
	}
	wantTable := []string{
		base64.StdEncoding.EncodeToString(sdA),
		base64.StdEncoding.EncodeToString(sdB),
		base64.StdEncoding.EncodeToString(sdC),
	}
	if strings.Join(snapshot.SecurityDescriptors, ",") != strings.Join(wantTable, ",") {
		t.Errorf("SecurityDescriptors = %v, want %v", snapshot.SecurityDescriptors, wantTable)
	}
	if snapshot.FormatVersion != manifestFormatFidelity {
		t.Errorf("FormatVersion = %d, want %d", snapshot.FormatVersion, manifestFormatFidelity)
	}
}

// TestCreateSnapshot_NoSDCaptureLeavesManifestUnchanged pins backward
// compatibility: a run that captured no descriptors emits neither the
// securityDescriptors table nor any sdIndex key, and keeps its format version.
func TestCreateSnapshot_NoSDCaptureLeavesManifestUnchanged(t *testing.T) {
	files := []backupFile{
		{sourcePath: writeTempFile(t, "a"), snapshotPath: "a", size: 1},
	}
	snapshot, err := createSnapshotWithProgress(context.Background(), newMockProvider(), files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("createSnapshotWithProgress: %v", err)
	}
	if snapshot.SecurityDescriptors != nil {
		t.Errorf("SecurityDescriptors = %v, want nil", snapshot.SecurityDescriptors)
	}
	if snapshot.FormatVersion != 0 {
		t.Errorf("FormatVersion = %d, want 0", snapshot.FormatVersion)
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"securityDescriptors", "sdIndex"} {
		if strings.Contains(string(raw), key) {
			t.Errorf("manifest JSON unexpectedly carries %q: %s", key, raw)
		}
	}
}

// TestCreateSnapshot_SourceGoneWithoutJournal_PartialManifestCarriesSDTable
// pins that the journal-less abortSourceGone path — which publishes a
// PARTIAL manifest mid-loop — finalizes the manifest exactly like the normal
// end-of-run path: every published SDIndex resolves in the published
// securityDescriptors table, and the fidelity format version is stamped.
// Without that, a restore would see SDIndex > 0 with no table and silently
// fall back to inherited ACLs.
func TestCreateSnapshot_SourceGoneWithoutJournal_PartialManifestCarriesSDTable(t *testing.T) {
	defer setShortUploadRetryDelayForTest(0)()
	defer setUploadRetryDelayForTest(0)()

	f := newFakeStat()
	f.install(t)
	root, files := filesUnderCommonRoot(t, 5)
	f.set(root, true)
	for i := range files {
		files[i].sd = []byte{byte('A' + i%2)} // two distinct descriptors, deduplicated
	}

	backing := newMockProvider()
	provider := &snapshotKillingProvider{
		backing: backing,
		target:  files[2].sourcePath,
		srcRoot: root,
		onDeath: func() { f.set(root, false) },
	}
	liveness := newShadowRootLiveness(map[string]string{`C:`: root})
	_, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, liveness)
	if !errors.Is(err, errSourceSnapshotGone) {
		t.Fatalf("want errSourceSnapshotGone, got %v", err)
	}

	backing.mu.Lock()
	var raw []byte
	for key, data := range backing.files {
		if strings.HasSuffix(key, "/"+snapshotManifestKey) {
			raw = data
		}
	}
	backing.mu.Unlock()
	if raw == nil {
		t.Fatal("no partial manifest was published")
	}
	var published Snapshot
	if err := json.Unmarshal(raw, &published); err != nil {
		t.Fatalf("decode published manifest: %v", err)
	}
	if len(published.Files) == 0 {
		t.Fatal("published manifest has no entries")
	}
	for _, e := range published.Files {
		if e.SDIndex < 1 || e.SDIndex > len(published.SecurityDescriptors) {
			t.Errorf("%s: SDIndex %d does not resolve in a table of %d descriptors", e.SourcePath, e.SDIndex, len(published.SecurityDescriptors))
		}
	}
	if published.FormatVersion != manifestFormatFidelity {
		t.Errorf("partial manifest FormatVersion = %d, want %d", published.FormatVersion, manifestFormatFidelity)
	}
}
