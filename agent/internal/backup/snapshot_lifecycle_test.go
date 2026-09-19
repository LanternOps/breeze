package backup

import (
	"errors"
	"path"
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
