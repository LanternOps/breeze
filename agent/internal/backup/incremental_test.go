package backup

import (
	"context"
	"os"
	"path"
	pathpkg "path/filepath"
	"strings"
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
	snap, reason := previousManifest(context.Background(), provider, "device-a")
	if snap != nil {
		t.Fatalf("expected nil snapshot for an empty destination, got %+v", snap)
	}
	if reason == "" {
		t.Error("expected a non-empty reason when snap is nil")
	}
}

// TestPreviousManifest_PicksNewest proves previousManifest returns the
// newest of several completed snapshots (by Timestamp) THAT MATCH the
// caller's identity, not just any one.
func TestPreviousManifest_PicksNewest(t *testing.T) {
	provider := newMockProvider()
	const identity = "device-a"
	older := &Snapshot{
		ID:             "snapshot-older",
		Timestamp:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		BackupIdentity: identity,
		Files:          []SnapshotFile{{SourcePath: "/data/a.txt", BackupPath: "snapshots/snapshot-older/files/a.txt.gz", Size: 1}},
	}
	newer := &Snapshot{
		ID:             "snapshot-newer",
		Timestamp:      time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC),
		BackupIdentity: identity,
		Files:          []SnapshotFile{{SourcePath: "/data/b.txt", BackupPath: "snapshots/snapshot-newer/files/b.txt.gz", Size: 2}},
	}
	storeManifest(t, provider, older)
	storeManifest(t, provider, newer)

	snap, reason := previousManifest(context.Background(), provider, identity)
	if snap == nil {
		t.Fatalf("expected a snapshot, got nil (reason: %s)", reason)
	}
	if snap.ID != "snapshot-newer" {
		t.Fatalf("previousManifest picked %q, want the newest (%q)", snap.ID, "snapshot-newer")
	}
}

// TestPreviousManifest_ListFailureFailsOpen proves any fetch/parse problem
// collapses to (nil, reason) rather than propagating an error the caller
// might mistake for a reason to fail the run. Identity is non-empty here so
// the failure exercised is the ListSnapshots error path, not the separate
// empty-identity short-circuit (see TestPreviousManifest_NoCallerIdentityNeverMatches).
func TestPreviousManifest_ListFailureFailsOpen(t *testing.T) {
	provider := newMockProvider()
	provider.listErr = context.DeadlineExceeded

	snap, reason := previousManifest(context.Background(), provider, "device-a")
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

	snap, reason := previousManifest(context.Background(), provider, "device-a")
	if snap != nil {
		t.Fatalf("expected nil snapshot when a manifest fails to decode, got %+v", snap)
	}
	if reason == "" {
		t.Error("expected a non-empty reason describing the failure")
	}
}

// TestPreviousManifest_SkipsForeignIdentity_PicksOwnNewest is D6's core
// unit proof: the newest snapshot in the bucket belongs to a DIFFERENT
// device/destination/run-kind (BackupIdentity mismatch) — exactly the
// proven-live scenario where a Windows device's snapshot sorted last and a
// Linux device's run picked it as its own incremental-dedupe base.
// previousManifest must keep scanning backward and return the newest
// snapshot that actually matches THIS run's identity, never the foreign one.
func TestPreviousManifest_SkipsForeignIdentity_PicksOwnNewest(t *testing.T) {
	provider := newMockProvider()
	const myIdentity = "s3|bucket-1|device-a|file"
	const foreignIdentity = "s3|bucket-1|device-b|file"

	mine := &Snapshot{
		ID:             "snapshot-mine",
		Timestamp:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		BackupIdentity: myIdentity,
		Files:          []SnapshotFile{{SourcePath: "/data/a.txt", BackupPath: "snapshots/snapshot-mine/files/a.txt.gz", Size: 1}},
	}
	foreign := &Snapshot{
		ID:             "snapshot-foreign-newer",
		Timestamp:      time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC),
		BackupIdentity: foreignIdentity,
		Files:          []SnapshotFile{{SourcePath: "/data/b.txt", BackupPath: "snapshots/snapshot-foreign-newer/files/b.txt.gz", Size: 2}},
	}
	storeManifest(t, provider, mine)
	storeManifest(t, provider, foreign)

	snap, reason := previousManifest(context.Background(), provider, myIdentity)
	if snap == nil {
		t.Fatalf("expected a matching snapshot, got nil (reason: %s)", reason)
	}
	if snap.ID != "snapshot-mine" {
		t.Fatalf("previousManifest picked %q, want this run's own snapshot %q (must not pick the newer foreign one)", snap.ID, "snapshot-mine")
	}
}

// TestPreviousManifest_OnlyForeignIdentities_NoMatch proves the fail-open
// reason text when every candidate belongs to a different identity:
// previousManifest must never fall back to picking a foreign snapshot just
// because it's the only one available — that IS the bug (D6).
func TestPreviousManifest_OnlyForeignIdentities_NoMatch(t *testing.T) {
	provider := newMockProvider()
	foreign := &Snapshot{
		ID:             "snapshot-foreign",
		Timestamp:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		BackupIdentity: "device-b",
		Files:          []SnapshotFile{{SourcePath: "/data/a.txt", BackupPath: "snapshots/snapshot-foreign/files/a.txt.gz", Size: 1}},
	}
	storeManifest(t, provider, foreign)

	snap, reason := previousManifest(context.Background(), provider, "device-a")
	if snap != nil {
		t.Fatalf("expected nil (no matching identity), got %+v", snap)
	}
	if !strings.Contains(reason, "no matching previous snapshot") {
		t.Errorf("reason = %q, want it to mention %q", reason, "no matching previous snapshot")
	}
}

// TestPreviousManifest_LegacyManifestWithoutIdentityNeverMatches proves the
// documented safe default for a manifest written before BackupIdentity
// existed: an empty BackupIdentity must never match a current run's
// identity, no matter what that identity is. Fail-open to a full backup,
// never "assume the unlabeled one is mine".
func TestPreviousManifest_LegacyManifestWithoutIdentityNeverMatches(t *testing.T) {
	provider := newMockProvider()
	legacy := &Snapshot{
		ID:        "snapshot-legacy",
		Timestamp: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		// BackupIdentity intentionally left unset — predates the field.
		Files: []SnapshotFile{{SourcePath: "/data/a.txt", BackupPath: "snapshots/snapshot-legacy/files/a.txt.gz", Size: 1}},
	}
	storeManifest(t, provider, legacy)

	snap, reason := previousManifest(context.Background(), provider, "device-a")
	if snap != nil {
		t.Fatalf("expected nil for a legacy manifest with no BackupIdentity, got %+v", snap)
	}
	if reason == "" {
		t.Error("expected a non-empty reason")
	}
}

// TestPreviousManifest_NoCallerIdentityNeverMatches proves the other half
// of the fail-open contract: when THIS run has no known identity at all
// (empty string — e.g. BackupConfig.AgentID never got wired through),
// previousManifest must never claim any candidate as a match — not even a
// snapshot this same process produced earlier under the same empty
// identity — since an unstamped run cannot prove whose snapshot it is
// either way.
func TestPreviousManifest_NoCallerIdentityNeverMatches(t *testing.T) {
	provider := newMockProvider()
	unstamped := &Snapshot{
		ID:        "snapshot-unstamped",
		Timestamp: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		Files:     []SnapshotFile{{SourcePath: "/data/a.txt", BackupPath: "snapshots/snapshot-unstamped/files/a.txt.gz", Size: 1}},
	}
	storeManifest(t, provider, unstamped)

	snap, reason := previousManifest(context.Background(), provider, "")
	if snap != nil {
		t.Fatalf("expected nil when this run has no known identity, got %+v", snap)
	}
	if reason == "" {
		t.Error("expected a non-empty reason")
	}
}

// TestIncrementalDedupeBase_ScopedToBackupIdentity is D6's end-to-end proof,
// exercising the real createSnapshotWithProgress + previousManifest
// pipeline: two devices (identities A and B) share one bucket. Run 1
// (identity A) backs up a file; a foreign run (identity B) lands strictly
// after it — the exact scenario where "just take the newest snapshot"
// would have picked the foreign run as identity A's dedupe base. Run 2
// (identity A again, the same file unchanged) must still resolve run 1 as
// its base, referencing the file rather than re-uploading it.
func TestIncrementalDedupeBase_ScopedToBackupIdentity(t *testing.T) {
	provider := newMockProvider()
	tmpDir := t.TempDir()
	modTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	const identityA = "s3|bucket|device-a|file"
	const identityB = "s3|bucket|device-b|file"

	f1 := createTempFile(t, tmpDir, "f1.txt", "one")
	if err := os.Chtimes(f1, modTime, modTime); err != nil {
		t.Fatalf("test setup: Chtimes failed: %v", err)
	}
	run1Files := []backupFile{{sourcePath: f1, snapshotPath: "path_0/f1.txt", size: 3, modTime: modTime}}

	snapshot1, err := createSnapshotWithProgress(context.Background(), provider, run1Files, nil, nil, nil, nil, withRunIdentity(identityA))
	if err != nil {
		t.Fatalf("run 1 (identity A) failed: %v", err)
	}
	if snapshot1.BackupIdentity != identityA {
		t.Fatalf("run 1 BackupIdentity = %q, want %q", snapshot1.BackupIdentity, identityA)
	}

	// A foreign device's run lands strictly after run 1 — ListSnapshots now
	// reports it as the newest snapshot in the whole bucket.
	fB := createTempFile(t, tmpDir, "fb.txt", "foreign-device-file")
	runBFiles := []backupFile{{sourcePath: fB, snapshotPath: "path_0/fb.txt", size: int64(len("foreign-device-file")), modTime: modTime}}
	snapshotB, err := createSnapshotWithProgress(context.Background(), provider, runBFiles, nil, nil, nil, nil, withRunIdentity(identityB))
	if err != nil {
		t.Fatalf("foreign run (identity B) failed: %v", err)
	}

	prev, reason := previousManifest(context.Background(), provider, identityA)
	if prev == nil {
		t.Fatalf("expected run 2 (identity A) to find run 1 as its base, got none: %s", reason)
	}
	if prev.ID != snapshot1.ID {
		t.Fatalf("previousManifest picked %q, want run 1's snapshot %q (must not pick the newer foreign run %q)", prev.ID, snapshot1.ID, snapshotB.ID)
	}

	run2Files := []backupFile{{sourcePath: f1, snapshotPath: "path_0/f1.txt", size: 3, modTime: modTime}} // unchanged
	snapshot2, err := createSnapshotWithProgress(context.Background(), provider, run2Files, nil, nil, prev, nil, withRunIdentity(identityA))
	if err != nil {
		t.Fatalf("run 2 (identity A) failed: %v", err)
	}
	if snapshot2.BaseSnapshotID != snapshot1.ID {
		t.Fatalf("run 2 BaseSnapshotID = %q, want %q", snapshot2.BaseSnapshotID, snapshot1.ID)
	}

	referencedFiles := 0
	for _, f := range snapshot2.Files {
		if isReferenceEntry(f, snapshot2.ID) {
			referencedFiles++
		}
	}
	if referencedFiles != len(run2Files) {
		t.Fatalf("run 2 referencedFiles = %d, want %d (every unchanged file referenced from run 1, none re-uploaded / referenced from the foreign run)", referencedFiles, len(run2Files))
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

// NOTE: TestMarkSystemStateFiles/TestMarkSystemStateFiles_EmptyStagingDirNoOp/
// TestSystemStateArtifactsMissing used to live here, covering
// markSystemStateFiles/isUnderDir/systemStateArtifactsMissing — all removed
// in incremental.go (see the NOTE there) now that system-state artifacts are
// published directly from the manifest (snapshot.go's publishSystemState)
// rather than discovered via the ordinary file walk.

func TestFetchServerOwnedBase(t *testing.T) {
	const myIdentity = "s3|bucket-1|device-a|file"

	t.Run("valid base with matching identity", func(t *testing.T) {
		provider := newMockProvider()
		base := &Snapshot{
			ID:             "snap-base",
			Timestamp:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
			BackupIdentity: myIdentity,
			Files:          []SnapshotFile{{SourcePath: "/data/a.txt", BackupPath: "snapshots/snap-base/files/a.txt.gz", Size: 1}},
		}
		storeManifest(t, provider, base)

		snap, reason := fetchServerOwnedBase(context.Background(), provider, "snap-base", myIdentity)
		if snap == nil {
			t.Fatalf("expected a matching snapshot, got nil (reason: %s)", reason)
		}
		if snap.ID != "snap-base" {
			t.Fatalf("fetchServerOwnedBase picked %q, want %q", snap.ID, "snap-base")
		}
	})

	t.Run("identity mismatch falls back to full run", func(t *testing.T) {
		provider := newMockProvider()
		base := &Snapshot{
			ID:             "snap-base",
			Timestamp:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
			BackupIdentity: "s3|bucket-1|device-b|file",
			Files:          []SnapshotFile{{SourcePath: "/data/a.txt", BackupPath: "snapshots/snap-base/files/a.txt.gz", Size: 1}},
		}
		storeManifest(t, provider, base)

		snap, reason := fetchServerOwnedBase(context.Background(), provider, "snap-base", myIdentity)
		if snap != nil {
			t.Fatalf("expected nil on identity mismatch, got %+v", snap)
		}
		if reason == "" {
			t.Error("expected a non-empty reason")
		}
	})

	t.Run("empty baseSnapshotId means full run", func(t *testing.T) {
		provider := newMockProvider()
		snap, reason := fetchServerOwnedBase(context.Background(), provider, "", myIdentity)
		if snap != nil {
			t.Fatalf("expected nil for empty baseSnapshotId, got %+v", snap)
		}
		if reason == "" {
			t.Error("expected a non-empty reason")
		}
	})

	t.Run("404 (manifest never uploaded) falls back to full run", func(t *testing.T) {
		provider := newMockProvider()
		snap, reason := fetchServerOwnedBase(context.Background(), provider, "snap-missing", myIdentity)
		if snap != nil {
			t.Fatalf("expected nil on download failure, got %+v", snap)
		}
		if reason == "" {
			t.Error("expected a non-empty reason")
		}
	})
}
