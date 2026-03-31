package backup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// createTestSnapshot writes a fake snapshot (manifest + one data file) into a
// LocalProvider-backed directory and returns the snapshot ID.
func createTestSnapshot(t *testing.T, basePath string, ts time.Time) string {
	t.Helper()

	provider := providers.NewLocalProvider(basePath)
	snap := &Snapshot{
		ID:        newSnapshotID(),
		Timestamp: ts,
		Files: []SnapshotFile{
			{
				SourcePath: "/etc/hosts",
				BackupPath: "snapshots/" + "",
				Size:       42,
				ModTime:    ts,
			},
		},
		Size: 42,
	}

	// Write a dummy data file
	dataFile, err := os.CreateTemp("", "vault-test-data-*")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dataFile.WriteString("test data content for " + snap.ID); err != nil {
		t.Fatal(err)
	}
	dataFile.Close()
	defer os.Remove(dataFile.Name())

	dataKey := "snapshots/" + snap.ID + "/files/hosts.gz"
	snap.Files[0].BackupPath = dataKey

	if err := provider.Upload(dataFile.Name(), dataKey); err != nil {
		t.Fatalf("failed to upload test data: %v", err)
	}

	// Write manifest
	manifestData, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	manifestFile, err := os.CreateTemp("", "vault-test-manifest-*.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manifestFile.Write(manifestData); err != nil {
		t.Fatal(err)
	}
	manifestFile.Close()
	defer os.Remove(manifestFile.Name())

	manifestKey := "snapshots/" + snap.ID + "/manifest.json"
	if err := provider.Upload(manifestFile.Name(), manifestKey); err != nil {
		t.Fatalf("failed to upload manifest: %v", err)
	}

	return snap.ID
}

func TestVaultSync(t *testing.T) {
	primaryDir := t.TempDir()
	vaultDir := t.TempDir()

	snapID := createTestSnapshot(t, primaryDir, time.Now().UTC())

	primary := providers.NewLocalProvider(primaryDir)
	vm, err := NewVaultManager(VaultConfig{
		VaultPath:      vaultDir,
		RetentionCount: 5,
		Enabled:        true,
	}, primary)
	if err != nil {
		t.Fatalf("failed to create vault manager: %v", err)
	}

	syncResult, err := vm.SyncSnapshot(snapID)
	if err != nil {
		t.Fatalf("sync failed: %v", err)
	}
	if syncResult == nil || syncResult.SnapshotID != snapID {
		t.Fatalf("unexpected sync result: %+v", syncResult)
	}
	if !syncResult.ManifestVerified {
		t.Fatal("expected manifest verification to be true")
	}

	// Verify files exist in vault
	vaultProvider := providers.NewLocalProvider(vaultDir)
	items, err := vaultProvider.List("snapshots/" + snapID)
	if err != nil {
		t.Fatalf("failed to list vault: %v", err)
	}
	if len(items) < 2 {
		t.Errorf("expected at least 2 files in vault (manifest + data), got %d", len(items))
	}

	// Verify manifest exists
	manifestPath := filepath.Join(vaultDir, "snapshots", snapID, "manifest.json")
	if _, err := os.Stat(manifestPath); os.IsNotExist(err) {
		t.Error("manifest not found in vault")
	}
}

func TestVaultSync_Idempotent(t *testing.T) {
	primaryDir := t.TempDir()
	vaultDir := t.TempDir()

	snapID := createTestSnapshot(t, primaryDir, time.Now().UTC())

	primary := providers.NewLocalProvider(primaryDir)
	vm, err := NewVaultManager(VaultConfig{
		VaultPath:      vaultDir,
		RetentionCount: 5,
		Enabled:        true,
	}, primary)
	if err != nil {
		t.Fatal(err)
	}

	// Sync twice; second should be a no-op
	if _, err := vm.SyncSnapshot(snapID); err != nil {
		t.Fatal(err)
	}
	if _, err := vm.SyncSnapshot(snapID); err != nil {
		t.Fatalf("idempotent sync failed: %v", err)
	}
}

func TestVaultRetention(t *testing.T) {
	primaryDir := t.TempDir()
	vaultDir := t.TempDir()

	primary := providers.NewLocalProvider(primaryDir)
	vm, err := NewVaultManager(VaultConfig{
		VaultPath:      vaultDir,
		RetentionCount: 3,
		Enabled:        true,
	}, primary)
	if err != nil {
		t.Fatal(err)
	}

	// Create and sync 5 snapshots with staggered timestamps
	baseTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var snapIDs []string
	for i := 0; i < 5; i++ {
		ts := baseTime.Add(time.Duration(i) * time.Hour)
		snapID := createTestSnapshot(t, primaryDir, ts)
		snapIDs = append(snapIDs, snapID)
		if _, err := vm.SyncSnapshot(snapID); err != nil {
			t.Fatalf("sync %d failed: %v", i, err)
		}
	}

	// Enforce retention (keep 3)
	if err := vm.EnforceRetention(); err != nil {
		t.Fatalf("retention enforcement failed: %v", err)
	}

	// Verify only 3 snapshots remain
	vaultProvider := providers.NewLocalProvider(vaultDir)
	remaining, err := ListSnapshots(vaultProvider)
	if err != nil {
		t.Fatalf("failed to list vault snapshots: %v", err)
	}
	if len(remaining) != 3 {
		t.Errorf("expected 3 remaining snapshots, got %d", len(remaining))
	}
}

func TestVaultStatus(t *testing.T) {
	primaryDir := t.TempDir()
	vaultDir := t.TempDir()

	primary := providers.NewLocalProvider(primaryDir)
	vm, err := NewVaultManager(VaultConfig{
		VaultPath:      vaultDir,
		RetentionCount: 5,
		Enabled:        true,
	}, primary)
	if err != nil {
		t.Fatal(err)
	}

	// Empty vault status
	status, err := vm.GetStatus()
	if err != nil {
		t.Fatalf("status failed: %v", err)
	}
	if status.SnapshotCount != 0 {
		t.Errorf("expected 0 snapshots, got %d", status.SnapshotCount)
	}

	// Add 2 snapshots
	for i := 0; i < 2; i++ {
		ts := time.Now().UTC().Add(time.Duration(i) * time.Hour)
		snapID := createTestSnapshot(t, primaryDir, ts)
		if _, err := vm.SyncSnapshot(snapID); err != nil {
			t.Fatal(err)
		}
	}

	status, err = vm.GetStatus()
	if err != nil {
		t.Fatalf("status failed: %v", err)
	}
	if status.SnapshotCount != 2 {
		t.Errorf("expected 2 snapshots, got %d", status.SnapshotCount)
	}
	if status.TotalSizeBytes <= 0 {
		t.Errorf("expected positive total size, got %d", status.TotalSizeBytes)
	}
	if status.VaultPath != vaultDir {
		t.Errorf("expected vaultPath %s, got %s", vaultDir, status.VaultPath)
	}
	if !status.Enabled {
		t.Error("expected enabled=true")
	}
	if status.LastSyncAt == "" {
		t.Error("expected lastSyncAt to be set")
	}
}

func TestNewVaultManager_Errors(t *testing.T) {
	primary := providers.NewLocalProvider(t.TempDir())

	// Missing vault path
	_, err := NewVaultManager(VaultConfig{}, primary)
	if err == nil {
		t.Error("expected error for empty vault path")
	}

	// Missing primary
	_, err = NewVaultManager(VaultConfig{VaultPath: t.TempDir()}, nil)
	if err == nil {
		t.Error("expected error for nil primary provider")
	}
}
