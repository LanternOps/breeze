package backup

import (
	"errors"
	"fmt"
	"path"
	"strings"
	"testing"
	"time"
)

func TestListSnapshots_Empty(t *testing.T) {
	provider := newMockProvider()
	snapshots, err := ListSnapshots(provider)
	if err != nil {
		t.Fatalf("ListSnapshots failed: %v", err)
	}
	if len(snapshots) != 0 {
		t.Fatalf("expected 0 snapshots, got %d", len(snapshots))
	}
}

func TestListSnapshots_NilProvider(t *testing.T) {
	_, err := ListSnapshots(nil)
	if err == nil {
		t.Fatal("expected error for nil provider")
	}
}

func TestListSnapshots_ReturnsSnapshotsSortedByTimestamp(t *testing.T) {
	provider := newMockProvider()

	// Create two snapshots with different timestamps
	older := &Snapshot{
		ID:        "snapshot-older",
		Timestamp: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		Files:     []SnapshotFile{{SourcePath: "/a", BackupPath: "a.gz", Size: 1}},
		Size:      1,
	}
	newer := &Snapshot{
		ID:        "snapshot-newer",
		Timestamp: time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC),
		Files:     []SnapshotFile{{SourcePath: "/b", BackupPath: "b.gz", Size: 2}},
		Size:      2,
	}

	// Store manifests in mock provider
	storeManifest(t, provider, older)
	storeManifest(t, provider, newer)

	snapshots, err := ListSnapshots(provider)
	if err != nil {
		t.Fatalf("ListSnapshots failed: %v", err)
	}
	if len(snapshots) != 2 {
		t.Fatalf("expected 2 snapshots, got %d", len(snapshots))
	}

	// Should be sorted oldest first
	if snapshots[0].ID != "snapshot-older" {
		t.Errorf("first snapshot should be older, got %s", snapshots[0].ID)
	}
	if snapshots[1].ID != "snapshot-newer" {
		t.Errorf("second snapshot should be newer, got %s", snapshots[1].ID)
	}
}

func TestListSnapshots_ListError(t *testing.T) {
	provider := newMockProvider()
	provider.listErr = errors.New("storage error")

	_, err := ListSnapshots(provider)
	if err == nil {
		t.Fatal("expected error when list fails")
	}
}

func TestListSnapshots_CorruptManifest(t *testing.T) {
	provider := newMockProvider()

	// Store a corrupt manifest
	manifestKey := path.Join(snapshotRootDir, "snap-corrupt", snapshotManifestKey)
	provider.files[manifestKey] = []byte("{invalid json!!")

	// Store a valid one
	valid := &Snapshot{
		ID:        "snap-valid",
		Timestamp: time.Now().UTC(),
		Files:     []SnapshotFile{{SourcePath: "/v", BackupPath: "v.gz", Size: 1}},
		Size:      1,
	}
	storeManifest(t, provider, valid)

	snapshots, err := ListSnapshots(provider)
	// Should return the valid snapshot even though one was corrupt
	if len(snapshots) != 1 {
		t.Fatalf("expected 1 valid snapshot, got %d", len(snapshots))
	}
	if snapshots[0].ID != "snap-valid" {
		t.Errorf("expected snap-valid, got %s", snapshots[0].ID)
	}
	// err should be non-nil because of the corrupt manifest
	if err == nil {
		t.Error("expected error for corrupt manifest")
	}
}

func TestDeleteSnapshot_NothingToDelete(t *testing.T) {
	provider := newMockProvider()

	err := DeleteSnapshot(provider, 5)
	if err != nil {
		t.Fatalf("DeleteSnapshot should succeed when no snapshots: %v", err)
	}
}

func TestDeleteSnapshot_ZeroRetention(t *testing.T) {
	provider := newMockProvider()
	err := DeleteSnapshot(provider, 0)
	if err != nil {
		t.Fatalf("DeleteSnapshot with zero retention should be no-op: %v", err)
	}
}

func TestDeleteSnapshot_NegativeRetention(t *testing.T) {
	provider := newMockProvider()
	err := DeleteSnapshot(provider, -1)
	if err != nil {
		t.Fatalf("DeleteSnapshot with negative retention should be no-op: %v", err)
	}
}

func TestDeleteSnapshot_PrunesOldSnapshots(t *testing.T) {
	provider := newMockProvider()

	// Create 3 snapshots
	for i := 0; i < 3; i++ {
		snap := &Snapshot{
			ID:        fmt.Sprintf("snapshot-%d", i),
			Timestamp: time.Date(2026, 1, 1+i, 0, 0, 0, 0, time.UTC),
			Files:     []SnapshotFile{{SourcePath: "/f", BackupPath: "f.gz", Size: 1}},
			Size:      1,
		}
		storeManifest(t, provider, snap)
		// Add a fake data file for each snapshot
		dataKey := path.Join(snapshotRootDir, snap.ID, snapshotFilesDir, "data.gz")
		provider.files[dataKey] = []byte("data")
	}

	// Retain only 1, should delete 2 oldest
	err := DeleteSnapshot(provider, 1)
	if err != nil {
		t.Fatalf("DeleteSnapshot failed: %v", err)
	}

	// Verify delete was called for the older snapshots' files
	if len(provider.deleteCalls) == 0 {
		t.Fatal("expected delete calls for pruned snapshots")
	}

	// snapshot-2 should survive (newest)
	for _, key := range provider.deleteCalls {
		if strings.Contains(key, "snapshot-2") {
			t.Errorf("should not delete newest snapshot, but deleted %s", key)
		}
	}
}

func TestDeleteSnapshot_RetentionExceedsCount(t *testing.T) {
	provider := newMockProvider()

	snap := &Snapshot{
		ID:        "snapshot-only",
		Timestamp: time.Now().UTC(),
		Files:     []SnapshotFile{{SourcePath: "/f", BackupPath: "f.gz", Size: 1}},
		Size:      1,
	}
	storeManifest(t, provider, snap)

	err := DeleteSnapshot(provider, 5)
	if err != nil {
		t.Fatalf("DeleteSnapshot should not fail when retention > count: %v", err)
	}

	if len(provider.deleteCalls) != 0 {
		t.Errorf("should not delete anything when retention exceeds count, got %d deletes", len(provider.deleteCalls))
	}
}

func TestDeleteSnapshot_DeleteError(t *testing.T) {
	provider := newMockProvider()
	provider.deleteErr = errors.New("permission denied")

	// Create 2 snapshots
	for i := 0; i < 2; i++ {
		snap := &Snapshot{
			ID:        fmt.Sprintf("snapshot-%d", i),
			Timestamp: time.Date(2026, 1, 1+i, 0, 0, 0, 0, time.UTC),
			Files:     []SnapshotFile{{SourcePath: "/f", BackupPath: "f.gz", Size: 1}},
			Size:      1,
		}
		storeManifest(t, provider, snap)
		dataKey := path.Join(snapshotRootDir, snap.ID, snapshotFilesDir, "data.gz")
		provider.files[dataKey] = []byte("data")
	}

	err := DeleteSnapshot(provider, 1)
	if err == nil {
		t.Fatal("expected error when delete fails")
	}
}
