package backup

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path"
	"sort"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// VaultConfig defines configuration for the local vault.
type VaultConfig struct {
	VaultPath      string
	RetentionCount int
	Enabled        bool
}

// VaultManager manages a local vault (SMB share / USB drive) that mirrors
// snapshots from the primary backup provider for offline or fast-local recovery.
type VaultManager struct {
	config  VaultConfig
	primary providers.BackupProvider
	vault   providers.BackupProvider // LocalProvider pointed at VaultPath
}

// VaultStatus reports the current state of the local vault.
type VaultStatus struct {
	Enabled        bool   `json:"enabled"`
	VaultPath      string `json:"vaultPath"`
	SnapshotCount  int    `json:"snapshotCount"`
	TotalSizeBytes int64  `json:"totalSizeBytes"`
	LastSyncAt     string `json:"lastSyncAt,omitempty"`
}

type VaultSyncResult struct {
	SnapshotID       string `json:"snapshotId"`
	VaultPath        string `json:"vaultPath,omitempty"`
	FileCount        int    `json:"fileCount"`
	TotalBytes       int64  `json:"totalBytes"`
	ManifestVerified bool   `json:"manifestVerified"`
}

// NewVaultManager creates a VaultManager. It creates the vault directory if
// needed and initializes a LocalProvider for it.
func NewVaultManager(cfg VaultConfig, primary providers.BackupProvider) (*VaultManager, error) {
	if cfg.VaultPath == "" {
		return nil, errors.New("vault path is required")
	}
	if primary == nil {
		return nil, errors.New("primary provider is required")
	}
	if cfg.RetentionCount <= 0 {
		cfg.RetentionCount = 3
	}

	if err := os.MkdirAll(cfg.VaultPath, 0o755); err != nil {
		return nil, fmt.Errorf("failed to create vault directory: %w", err)
	}

	return &VaultManager{
		config:  cfg,
		primary: primary,
		vault:   providers.NewLocalProvider(cfg.VaultPath),
	}, nil
}

// SyncSnapshot copies a snapshot from the primary provider into the vault.
//  1. Download manifest from primary
//  2. List files in vault for this snapshot
//  3. Download missing files from primary -> vault
//  4. Copy manifest to vault
func (v *VaultManager) SyncSnapshot(snapshotID string) (*VaultSyncResult, error) {
	prefix := path.Join(snapshotRootDir, snapshotID)
	manifestKey := path.Join(prefix, snapshotManifestKey)
	syncResult := &VaultSyncResult{
		SnapshotID: snapshotID,
		VaultPath:  v.config.VaultPath,
	}

	// 1. Download manifest from primary to a temp file
	manifestTmp, err := os.CreateTemp("", "vault-manifest-*.json")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp manifest: %w", err)
	}
	manifestTmpPath := manifestTmp.Name()
	_ = manifestTmp.Close()
	defer os.Remove(manifestTmpPath)

	if err := v.primary.Download(manifestKey, manifestTmpPath); err != nil {
		return nil, fmt.Errorf("failed to download manifest from primary: %w", err)
	}

	// 2. List all files in the primary snapshot
	primaryFiles, err := v.primary.List(prefix)
	if err != nil {
		return nil, fmt.Errorf("failed to list primary snapshot files: %w", err)
	}
	syncResult.FileCount = len(primaryFiles)

	// 3. Build set of files already in vault
	vaultFiles, vaultListErr := v.vault.List(prefix)
	if vaultListErr != nil {
		slog.Warn("vault: failed to list existing vault files, will re-download all",
			"prefix", prefix, "error", vaultListErr.Error())
	}
	vaultSet := make(map[string]struct{}, len(vaultFiles))
	for _, f := range vaultFiles {
		vaultSet[f] = struct{}{}
	}

	// 4. Download missing files from primary -> temp -> vault
	var errs []error
	for _, file := range primaryFiles {
		if _, exists := vaultSet[file]; exists {
			continue
		}

		tmpFile, tmpErr := os.CreateTemp("", "vault-sync-*")
		if tmpErr != nil {
			errs = append(errs, fmt.Errorf("temp file for %s: %w", file, tmpErr))
			continue
		}
		tmpPath := tmpFile.Name()
		_ = tmpFile.Close()

		if dlErr := v.primary.Download(file, tmpPath); dlErr != nil {
			os.Remove(tmpPath)
			errs = append(errs, fmt.Errorf("download %s: %w", file, dlErr))
			slog.Warn("vault sync: failed to download from primary", "file", file, "error", dlErr.Error())
			continue
		}
		if ulErr := v.vault.Upload(tmpPath, file); ulErr != nil {
			os.Remove(tmpPath)
			errs = append(errs, fmt.Errorf("upload %s to vault: %w", file, ulErr))
			slog.Warn("vault sync: failed to upload to vault", "file", file, "error", ulErr.Error())
			continue
		}

		os.Remove(tmpPath)
	}

	// 5. Ensure manifest is in vault
	if manifestErr := v.vault.Upload(manifestTmpPath, manifestKey); manifestErr != nil {
		slog.Warn("vault: manifest upload failed, cleaning up partial snapshot",
			"snapshotId", snapshotID)
		// Best-effort cleanup of already-uploaded files
		for _, f := range primaryFiles {
			_ = v.vault.Delete(f)
		}
		return nil, fmt.Errorf("vault sync failed at manifest upload: %w", manifestErr)
	}
	syncResult.ManifestVerified = true
	if syncedFiles, listErr := v.vault.List(prefix); listErr == nil {
		var totalSize int64
		for _, syncedFile := range syncedFiles {
			filePath := path.Join(v.config.VaultPath, syncedFile)
			if info, statErr := os.Stat(filePath); statErr == nil {
				totalSize += info.Size()
			}
		}
		syncResult.TotalBytes = totalSize
	}

	if len(errs) > 0 {
		return syncResult, fmt.Errorf("vault sync completed with errors: %w", errors.Join(errs...))
	}

	slog.Info("vault sync completed", "snapshotId", snapshotID)
	return syncResult, nil
}

// EnforceRetention deletes the oldest snapshots from the vault beyond the
// configured retention count.
func (v *VaultManager) EnforceRetention() error {
	snapshots, err := ListSnapshots(v.vault)
	if err != nil && len(snapshots) == 0 {
		return err
	}

	if len(snapshots) <= v.config.RetentionCount {
		return nil
	}

	// Snapshots are sorted oldest-first by ListSnapshots
	toDelete := snapshots[:len(snapshots)-v.config.RetentionCount]
	var errs []error

	for _, snap := range toDelete {
		prefix := path.Join(snapshotRootDir, snap.ID)
		items, listErr := v.vault.List(prefix)
		if listErr != nil {
			errs = append(errs, fmt.Errorf("list snapshot %s: %w", snap.ID, listErr))
			continue
		}

		for _, item := range items {
			if delErr := v.vault.Delete(item); delErr != nil {
				errs = append(errs, fmt.Errorf("delete %s: %w", item, delErr))
			}
		}
		slog.Info("vault retention: deleted snapshot", "snapshotId", snap.ID)
	}

	return errors.Join(errs...)
}

// SyncAfterBackup syncs a snapshot to vault and enforces retention.
func (v *VaultManager) SyncAfterBackup(snapshotID string) (*VaultSyncResult, error) {
	result, err := v.SyncSnapshot(snapshotID)
	if err != nil {
		return result, err
	}
	if err := v.EnforceRetention(); err != nil {
		return result, err
	}
	return result, nil
}

// GetStatus returns the current vault status including snapshot count and
// total size.
func (v *VaultManager) GetStatus() (*VaultStatus, error) {
	status := &VaultStatus{
		Enabled:   v.config.Enabled,
		VaultPath: v.config.VaultPath,
	}

	snapshots, err := ListSnapshots(v.vault)
	if err != nil && len(snapshots) == 0 {
		// Return status with zero counts if listing fails
		return status, err
	}

	status.SnapshotCount = len(snapshots)

	// Sort by timestamp descending to find last sync
	if len(snapshots) > 0 {
		sort.Slice(snapshots, func(i, j int) bool {
			return snapshots[i].Timestamp.After(snapshots[j].Timestamp)
		})
		status.LastSyncAt = snapshots[0].Timestamp.Format(time.RFC3339)
	}

	// Compute total size from all snapshot files
	allFiles, listErr := v.vault.List(snapshotRootDir)
	if listErr == nil {
		for _, f := range allFiles {
			filePath := path.Join(v.config.VaultPath, f)
			if info, statErr := os.Stat(filePath); statErr == nil {
				status.TotalSizeBytes += info.Size()
			}
		}
	}

	return status, nil
}

// GetProvider returns the vault's LocalProvider, useful for constructing
// a FallbackProvider that tries vault before cloud.
func (v *VaultManager) GetProvider() providers.BackupProvider {
	return v.vault
}
