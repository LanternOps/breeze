package backup

import (
	"context"
	"path"
	pathpkg "path/filepath"
	"testing"
	"time"
)

// TestDecideFile is the decision-table unit test: table-driven coverage of
// every branch in decideFile's doc comment (see incremental.go).
func TestDecideFile(t *testing.T) {
	baseTime := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	laterTime := baseTime.Add(time.Hour)

	tmpDir := t.TempDir()

	unchangedPath := createTempFile(t, tmpDir, "unchanged.txt", "same content")
	unchangedSum, err := sha256File(unchangedPath)
	if err != nil {
		t.Fatalf("test setup: sha256File failed: %v", err)
	}

	mtimeSamePath := createTempFile(t, tmpDir, "mtime-same-content.txt", "identical bytes")
	mtimeSameSum, err := sha256File(mtimeSamePath)
	if err != nil {
		t.Fatalf("test setup: sha256File failed: %v", err)
	}

	mtimeDiffPath := createTempFile(t, tmpDir, "mtime-diff-content.txt", "new bytes here")

	missingPath := pathpkg.Join(tmpDir, "does-not-exist.txt")

	tests := []struct {
		name       string
		file       backupFile
		prev       map[string]SnapshotFile
		wantResult referenceDecision
	}{
		{
			name: "unchanged file references",
			file: backupFile{sourcePath: unchangedPath, size: int64(len("same content")), modTime: baseTime},
			prev: map[string]SnapshotFile{
				unchangedPath: {SourcePath: unchangedPath, BackupPath: "snapshots/old/files/unchanged.txt.gz", Size: int64(len("same content")), ModTime: baseTime, Checksum: unchangedSum},
			},
			wantResult: decideReference,
		},
		{
			name: "mtime moved, checksum equal -> reference with refreshed mtime",
			file: backupFile{sourcePath: mtimeSamePath, size: int64(len("identical bytes")), modTime: laterTime},
			prev: map[string]SnapshotFile{
				mtimeSamePath: {SourcePath: mtimeSamePath, BackupPath: "snapshots/old/files/mtime-same.gz", Size: int64(len("identical bytes")), ModTime: baseTime, Checksum: mtimeSameSum},
			},
			wantResult: decideReference,
		},
		{
			name: "mtime moved, checksum differs -> upload",
			file: backupFile{sourcePath: mtimeDiffPath, size: int64(len("new bytes here")), modTime: laterTime},
			prev: map[string]SnapshotFile{
				mtimeDiffPath: {SourcePath: mtimeDiffPath, BackupPath: "snapshots/old/files/mtime-diff.gz", Size: int64(len("new bytes here")), ModTime: baseTime, Checksum: "stale-checksum-does-not-match"},
			},
			wantResult: decideUpload,
		},
		{
			name: "size changed -> upload",
			file: backupFile{sourcePath: unchangedPath, size: 999, modTime: baseTime},
			prev: map[string]SnapshotFile{
				unchangedPath: {SourcePath: unchangedPath, BackupPath: "snapshots/old/files/unchanged.txt.gz", Size: int64(len("same content")), ModTime: baseTime, Checksum: unchangedSum},
			},
			wantResult: decideUpload,
		},
		{
			name:       "new file (no previous entry) -> upload",
			file:       backupFile{sourcePath: unchangedPath, size: int64(len("same content")), modTime: baseTime},
			prev:       map[string]SnapshotFile{},
			wantResult: decideUpload,
		},
		{
			name: "originalPath key match with differing sourcePaths (VSS) -> reference",
			file: backupFile{sourcePath: "SHADOW-RUN2/data/f.txt", originalPath: "/data/f.txt", size: 11, modTime: baseTime},
			prev: map[string]SnapshotFile{
				"/data/f.txt": {SourcePath: "SHADOW-RUN1/data/f.txt", OriginalPath: "/data/f.txt", BackupPath: "snapshots/old/files/f.txt.gz", Size: 11, ModTime: baseTime, Checksum: "run1-checksum"},
			},
			wantResult: decideReference,
		},
		{
			name: "hash error (source unreadable) -> upload",
			file: backupFile{sourcePath: missingPath, size: 5, modTime: laterTime},
			prev: map[string]SnapshotFile{
				missingPath: {SourcePath: missingPath, BackupPath: "snapshots/old/files/missing.gz", Size: 5, ModTime: baseTime, Checksum: "whatever"},
			},
			wantResult: decideUpload,
		},
		{
			name: "system-state staging file never referenced, even with a matching entry",
			file: backupFile{sourcePath: unchangedPath, size: int64(len("same content")), modTime: baseTime, systemState: true},
			prev: map[string]SnapshotFile{
				unchangedPath: {SourcePath: unchangedPath, BackupPath: "snapshots/old/files/unchanged.txt.gz", Size: int64(len("same content")), ModTime: baseTime, Checksum: unchangedSum},
			},
			wantResult: decideUpload,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			decision, entry := decideFile(tt.file, tt.prev)
			if decision != tt.wantResult {
				t.Fatalf("decideFile() decision = %v, want %v", decision, tt.wantResult)
			}
			if decision != decideReference {
				return
			}
			prevEntry := tt.prev[journalLookupKey(tt.file)]
			if entry.BackupPath != prevEntry.BackupPath {
				t.Errorf("reference entry BackupPath = %q, want %q (old entry's)", entry.BackupPath, prevEntry.BackupPath)
			}
			if entry.Checksum != prevEntry.Checksum {
				t.Errorf("reference entry Checksum = %q, want %q (old entry's)", entry.Checksum, prevEntry.Checksum)
			}
			if entry.Size != tt.file.size {
				t.Errorf("reference entry Size = %d, want %d (current stat)", entry.Size, tt.file.size)
			}
			if !entry.ModTime.Equal(tt.file.modTime) {
				t.Errorf("reference entry ModTime = %v, want %v (current stat, refreshed)", entry.ModTime, tt.file.modTime)
			}
			if entry.SourcePath != tt.file.sourcePath {
				t.Errorf("reference entry SourcePath = %q, want %q (current)", entry.SourcePath, tt.file.sourcePath)
			}
			if entry.OriginalPath != tt.file.originalPath {
				t.Errorf("reference entry OriginalPath = %q, want %q (current)", entry.OriginalPath, tt.file.originalPath)
			}
		})
	}
}

// TestDecideFile_NilPrevAlwaysUploads pins down decideFile's behavior when
// no previous manifest was usable at all (nil map, not just an empty one) —
// matches createSnapshotWithProgress's own nil-prevSnapshot=full-run
// contract via buildPreviousIndex(nil) == nil.
func TestDecideFile_NilPrevAlwaysUploads(t *testing.T) {
	f := backupFile{sourcePath: "/data/whatever.txt", size: 10, modTime: time.Now()}
	decision, entry := decideFile(f, nil)
	if decision != decideUpload {
		t.Fatalf("decideFile with nil prev = %v, want decideUpload", decision)
	}
	if entry != (SnapshotFile{}) {
		t.Errorf("decideUpload entry should be the zero value, got %+v", entry)
	}
}

// TestPreviousManifest_NoSnapshots covers the ordinary first-run case: an
// empty destination is not an error, just "nothing to dedupe against yet".
func TestPreviousManifest_NoSnapshots(t *testing.T) {
	provider := newMockProvider()
	snap, reason := previousManifest(context.Background(), provider)
	if snap != nil {
		t.Fatalf("expected nil snapshot for an empty destination, got %+v", snap)
	}
	if reason == "" {
		t.Error("expected a non-empty reason when snap is nil")
	}
}

// TestPreviousManifest_PicksNewest proves previousManifest returns the
// newest of several completed snapshots (by Timestamp), not just any one.
func TestPreviousManifest_PicksNewest(t *testing.T) {
	provider := newMockProvider()
	older := &Snapshot{
		ID:        "snapshot-older",
		Timestamp: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		Files:     []SnapshotFile{{SourcePath: "/data/a.txt", BackupPath: "snapshots/snapshot-older/files/a.txt.gz", Size: 1}},
	}
	newer := &Snapshot{
		ID:        "snapshot-newer",
		Timestamp: time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC),
		Files:     []SnapshotFile{{SourcePath: "/data/b.txt", BackupPath: "snapshots/snapshot-newer/files/b.txt.gz", Size: 2}},
	}
	storeManifest(t, provider, older)
	storeManifest(t, provider, newer)

	snap, reason := previousManifest(context.Background(), provider)
	if snap == nil {
		t.Fatalf("expected a snapshot, got nil (reason: %s)", reason)
	}
	if snap.ID != "snapshot-newer" {
		t.Fatalf("previousManifest picked %q, want the newest (%q)", snap.ID, "snapshot-newer")
	}
}

// TestPreviousManifest_ListFailureFailsOpen proves any fetch/parse problem
// collapses to (nil, reason) rather than propagating an error the caller
// might mistake for a reason to fail the run.
func TestPreviousManifest_ListFailureFailsOpen(t *testing.T) {
	provider := newMockProvider()
	provider.listErr = context.DeadlineExceeded

	snap, reason := previousManifest(context.Background(), provider)
	if snap != nil {
		t.Fatalf("expected nil snapshot on a list failure, got %+v", snap)
	}
	if reason == "" {
		t.Error("expected a non-empty reason describing the failure")
	}
}

// TestPreviousManifest_CorruptManifestFailsOpen proves a corrupt manifest
// among the listed items fails the WHOLE lookup open (never partially
// trusts the snapshot list), per the design's "any previous-manifest
// problem -> full run" rule.
func TestPreviousManifest_CorruptManifestFailsOpen(t *testing.T) {
	provider := newMockProvider()
	provider.files[path.Join(snapshotRootDir, "snapshot-bad", snapshotManifestKey)] = []byte("not json")

	snap, reason := previousManifest(context.Background(), provider)
	if snap != nil {
		t.Fatalf("expected nil snapshot when a manifest fails to decode, got %+v", snap)
	}
	if reason == "" {
		t.Error("expected a non-empty reason describing the failure")
	}
}

// TestIsReferenceEntry proves the "no isRef flag" signal: a BackupPath
// under the snapshot's own prefix is NOT a reference; a BackupPath under
// any other prefix IS.
func TestIsReferenceEntry(t *testing.T) {
	tests := []struct {
		name       string
		backupPath string
		snapshotID string
		want       bool
	}{
		{"own prefix -> not a reference", "snapshots/snap-A/files/f.txt.gz", "snap-A", false},
		{"older prefix -> reference", "snapshots/snap-OLD/files/f.txt.gz", "snap-A", true},
		{"unrelated prefix -> reference", "snapshots/snap-B/files/f.txt.gz", "snap-A", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isReferenceEntry(SnapshotFile{BackupPath: tt.backupPath}, tt.snapshotID)
			if got != tt.want {
				t.Errorf("isReferenceEntry(%q, %q) = %v, want %v", tt.backupPath, tt.snapshotID, got, tt.want)
			}
		})
	}
}

// TestMarkSystemStateFiles proves the staging-dir exclusion flags exactly
// the files under stagingDir, leaving everything else untouched.
func TestMarkSystemStateFiles(t *testing.T) {
	tmpDir := t.TempDir()
	stagingDir := pathpkg.Join(tmpDir, "staging")
	files := []backupFile{
		{sourcePath: pathpkg.Join(stagingDir, "registry.dat")},
		{sourcePath: pathpkg.Join(stagingDir, "sub", "boot.cfg")},
		{sourcePath: pathpkg.Join(tmpDir, "unrelated", "doc.txt")},
		// A sibling directory that merely shares stagingDir as a string
		// prefix must NOT match (path-boundary correctness).
		{sourcePath: stagingDir + "-not-actually-inside" + string(pathpkg.Separator) + "f.txt"},
	}

	markSystemStateFiles(files, stagingDir)

	if !files[0].systemState {
		t.Error("file directly under stagingDir should be marked systemState")
	}
	if !files[1].systemState {
		t.Error("file nested under stagingDir should be marked systemState")
	}
	if files[2].systemState {
		t.Error("file outside stagingDir must not be marked systemState")
	}
	if files[3].systemState {
		t.Error("a path that merely shares stagingDir as a string prefix must not be marked systemState")
	}
}

// TestMarkSystemStateFiles_EmptyStagingDirNoOp proves the common case (no
// system-state collection this run) leaves every file untouched.
func TestMarkSystemStateFiles_EmptyStagingDirNoOp(t *testing.T) {
	files := []backupFile{{sourcePath: "/data/a.txt"}}
	markSystemStateFiles(files, "")
	if files[0].systemState {
		t.Error("markSystemStateFiles with an empty stagingDir must not mark anything")
	}
}
