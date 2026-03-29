package bmr

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path"
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

const (
	snapshotRootDir     = "snapshots"
	snapshotFilesDir    = "files"
	snapshotManifestKey = "manifest.json"
	systemStatePath     = "system-state"
)

// RunRecovery orchestrates a full bare metal recovery.
//
// Steps:
//  1. Download system state manifest from the provider
//  2. Download and apply system state (platform-specific restorer)
//  3. Download and restore all backed-up files
//  4. Run post-restore validation
//  5. Return RecoveryResult
func RunRecovery(cfg RecoveryConfig, provider providers.BackupProvider) (*RecoveryResult, error) {
	if provider == nil {
		return nil, fmt.Errorf("bmr: backup provider is required")
	}
	if cfg.SnapshotID == "" {
		return nil, fmt.Errorf("bmr: snapshotId is required")
	}

	result := &RecoveryResult{Status: "failed"}

	slog.Info("bmr: starting recovery",
		"snapshotId", cfg.SnapshotID,
		"deviceId", cfg.DeviceID,
	)

	// 1. Download snapshot manifest.
	manifest, err := downloadManifest(cfg.SnapshotID, provider)
	if err != nil {
		result.Error = fmt.Sprintf("failed to download manifest: %s", err.Error())
		return result, err
	}

	slog.Info("bmr: manifest downloaded",
		"files", len(manifest.Files),
		"snapshotSize", manifest.Size,
	)

	// 2. Download and apply system state.
	stateApplied, driversInjected, stateWarnings, stateErr := applySystemState(cfg, provider)
	result.StateApplied = stateApplied
	result.DriversInjected = driversInjected
	result.Warnings = append(result.Warnings, stateWarnings...)
	if stateErr != nil {
		slog.Warn("bmr: system state restore had errors", "error", stateErr.Error())
	}

	// 3. Download and restore files.
	filesRestored, bytesRestored, fileWarnings, filesErr := restoreFiles(manifest, cfg, provider)
	result.FilesRestored = filesRestored
	result.BytesRestored = bytesRestored
	result.Warnings = append(result.Warnings, fileWarnings...)
	if filesErr != nil {
		result.Error = fmt.Sprintf("file restore errors: %s", filesErr.Error())
	}

	// 4. Post-restore validation.
	validation, valErr := Validate()
	if valErr != nil {
		result.Warnings = append(result.Warnings, fmt.Sprintf("validation error: %s", valErr.Error()))
	} else {
		result.Validated = validation.Passed
		if !validation.Passed {
			result.Warnings = append(result.Warnings, validation.Failures...)
		}
	}

	// 5. Determine final status.
	switch {
	case filesErr == nil && stateErr == nil:
		result.Status = "completed"
	case filesRestored > 0 || stateApplied:
		result.Status = "partial"
	default:
		result.Status = "failed"
	}

	slog.Info("bmr: recovery complete",
		"status", result.Status,
		"filesRestored", result.FilesRestored,
		"bytesRestored", result.BytesRestored,
		"stateApplied", result.StateApplied,
		"validated", result.Validated,
	)

	return result, nil
}

// snapshotManifest matches the backup.Snapshot structure for deserialization.
type snapshotManifest struct {
	ID    string         `json:"id"`
	Files []manifestFile `json:"files"`
	Size  int64          `json:"size"`
}

type manifestFile struct {
	SourcePath string `json:"sourcePath"`
	BackupPath string `json:"backupPath"`
	Size       int64  `json:"size"`
}

func downloadManifest(snapshotID string, provider providers.BackupProvider) (*snapshotManifest, error) {
	manifestKey := path.Join(snapshotRootDir, snapshotID, snapshotManifestKey)

	tmpFile, err := os.CreateTemp("", "bmr-manifest-*.json")
	if err != nil {
		return nil, fmt.Errorf("bmr: create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	_ = tmpFile.Close()
	defer os.Remove(tmpPath)

	if err := provider.Download(manifestKey, tmpPath); err != nil {
		return nil, fmt.Errorf("bmr: download manifest: %w", err)
	}

	data, err := os.ReadFile(tmpPath)
	if err != nil {
		return nil, fmt.Errorf("bmr: read manifest: %w", err)
	}

	var manifest snapshotManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, fmt.Errorf("bmr: decode manifest: %w", err)
	}
	return &manifest, nil
}

func applySystemState(cfg RecoveryConfig, provider providers.BackupProvider) (applied bool, drivers int, warnings []string, err error) {
	// Download system state manifest from the snapshot.
	stateManifestKey := path.Join(snapshotRootDir, cfg.SnapshotID, systemStatePath, "manifest.json")

	tmpFile, tmpErr := os.CreateTemp("", "bmr-state-manifest-*.json")
	if tmpErr != nil {
		return false, 0, nil, fmt.Errorf("bmr: create temp: %w", tmpErr)
	}
	tmpPath := tmpFile.Name()
	_ = tmpFile.Close()
	defer os.Remove(tmpPath)

	if dlErr := provider.Download(stateManifestKey, tmpPath); dlErr != nil {
		warnings = append(warnings, "no system state found in snapshot, skipping state restore")
		slog.Info("bmr: no system state manifest found, skipping", "error", dlErr.Error())
		return false, 0, warnings, nil
	}

	data, readErr := os.ReadFile(tmpPath)
	if readErr != nil {
		return false, 0, nil, fmt.Errorf("bmr: read state manifest: %w", readErr)
	}

	var stateManifest systemstate.SystemStateManifest
	if err := json.Unmarshal(data, &stateManifest); err != nil {
		return false, 0, nil, fmt.Errorf("bmr: decode state manifest: %w", err)
	}

	// Download artifacts to staging directory.
	stagingDir, stagingErr := os.MkdirTemp("", "bmr-state-staging-*")
	if stagingErr != nil {
		return false, 0, nil, fmt.Errorf("bmr: create staging dir: %w", stagingErr)
	}
	defer os.RemoveAll(stagingDir)

	for _, artifact := range stateManifest.Artifacts {
		remoteKey := path.Join(snapshotRootDir, cfg.SnapshotID, systemStatePath, artifact.Path)
		localPath := filepath.Join(stagingDir, artifact.Path)
		if mkErr := os.MkdirAll(filepath.Dir(localPath), 0o750); mkErr != nil {
			warnings = append(warnings, fmt.Sprintf("failed to create dir for %s: %s", artifact.Name, mkErr.Error()))
			continue
		}
		if dlErr := provider.Download(remoteKey, localPath); dlErr != nil {
			warnings = append(warnings, fmt.Sprintf("failed to download %s: %s", artifact.Name, dlErr.Error()))
			continue
		}
	}

	// Apply system state via platform-specific restorer.
	restorer := newRestorer()
	if restoreErr := restorer.RestoreSystemState(stagingDir); restoreErr != nil {
		return false, 0, warnings, fmt.Errorf("bmr: restore system state: %w", restoreErr)
	}
	applied = true

	// Inject drivers if present.
	driverDir := filepath.Join(stagingDir, "drivers")
	if info, statErr := os.Stat(driverDir); statErr == nil && info.IsDir() {
		count, dErr := restorer.InjectDrivers(driverDir)
		if dErr != nil {
			warnings = append(warnings, fmt.Sprintf("driver injection errors: %s", dErr.Error()))
		}
		drivers = count
	}

	return applied, drivers, warnings, nil
}

func restoreFiles(
	manifest *snapshotManifest,
	cfg RecoveryConfig,
	provider providers.BackupProvider,
) (filesRestored int, bytesRestored int64, warnings []string, err error) {
	for _, file := range manifest.Files {
		targetPath := file.SourcePath
		if override, ok := cfg.TargetPaths[file.SourcePath]; ok {
			targetPath = override
		}

		dir := filepath.Dir(targetPath)
		if mkErr := os.MkdirAll(dir, 0o750); mkErr != nil {
			warnings = append(warnings, fmt.Sprintf("mkdir failed for %s: %s", dir, mkErr.Error()))
			continue
		}

		if dlErr := provider.Download(file.BackupPath, targetPath); dlErr != nil {
			warnings = append(warnings, fmt.Sprintf("restore failed for %s: %s", file.SourcePath, dlErr.Error()))
			continue
		}

		filesRestored++
		bytesRestored += file.Size
	}

	if filesRestored == 0 && len(manifest.Files) > 0 {
		return 0, 0, warnings, fmt.Errorf("bmr: all %d files failed to restore", len(manifest.Files))
	}
	if filesRestored < len(manifest.Files) {
		return filesRestored, bytesRestored, warnings,
			fmt.Errorf("bmr: %d of %d files failed to restore", len(manifest.Files)-filesRestored, len(manifest.Files))
	}
	return filesRestored, bytesRestored, warnings, nil
}
