package bmr

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

const (
	snapshotRootDir     = "snapshots"
	snapshotFilesDir    = "files"
	snapshotManifestKey = "manifest.json"
	systemStatePath     = "system-state"

	// maxRecoveryWarnings bounds how many individual per-file restore-failure
	// strings restoreFiles will accumulate into RecoveryResult.Warnings
	// before collapsing the rest into a single summary line (D14). See
	// RecoveryResult.FailedFiles for the uncapped true count.
	maxRecoveryWarnings = 50
)

// chmodFile and chtimesFile are seams over os.Chmod/os.Chtimes so tests can
// force deterministic post-restore fidelity failures without depending on
// filesystem-specific chmod/chtimes error behavior.
var (
	chmodFile   = os.Chmod
	chtimesFile = os.Chtimes
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
	return RunRecoveryContext(context.Background(), cfg, provider)
}

func RunRecoveryContext(ctx context.Context, cfg RecoveryConfig, provider providers.BackupProvider) (*RecoveryResult, error) {
	if provider == nil {
		return nil, fmt.Errorf("bmr: backup provider is required")
	}
	if cfg.SnapshotID == "" {
		return nil, fmt.Errorf("bmr: snapshotId is required")
	}

	result := &RecoveryResult{Status: "failed"}
	checkCancelled := func() bool {
		if ctx == nil || ctx.Err() == nil {
			return false
		}
		result.Error = fmt.Sprintf("operation cancelled: %v", ctx.Err())
		if result.FilesRestored > 0 || result.StateApplied {
			result.Status = "partial"
			return true
		}
		result.Status = "failed"
		return true
	}

	slog.Info("bmr: starting recovery",
		"snapshotId", cfg.SnapshotID,
		"deviceId", cfg.DeviceID,
	)

	// 1. Download snapshot manifest.
	if checkCancelled() {
		return result, ctx.Err()
	}
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
	if checkCancelled() {
		return result, ctx.Err()
	}
	stateApplied, driversInjected, stateWarnings, stateErr := applySystemState(ctx, cfg, provider)
	result.StateApplied = stateApplied
	result.DriversInjected = driversInjected
	result.Warnings = append(result.Warnings, stateWarnings...)
	if stateErr != nil {
		slog.Warn("bmr: system state restore had errors", "error", stateErr.Error())
	}
	if checkCancelled() {
		return result, ctx.Err()
	}

	// 3. Download and restore files.
	if checkCancelled() {
		return result, ctx.Err()
	}
	filesRestored, bytesRestored, fileWarnings, failedFiles, filesErr := restoreFiles(ctx, manifest, cfg, provider)
	result.FilesRestored = filesRestored
	result.BytesRestored = bytesRestored
	result.FailedFiles = failedFiles
	result.Warnings = append(result.Warnings, fileWarnings...)
	if filesErr != nil {
		result.Error = fmt.Sprintf("file restore errors: %s", filesErr.Error())
	}
	if checkCancelled() {
		return result, ctx.Err()
	}

	// 4. Post-restore validation.
	if checkCancelled() {
		return result, ctx.Err()
	}
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
		"failedFiles", result.FailedFiles,
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
	// OriginalPath is SourcePath reconstructed back through a VSS
	// shadow-copy rewrite — mirrors backup.SnapshotFile.OriginalPath (see
	// that field's doc comment). Empty except on a Windows run where VSS
	// was active and this file's root was rewritten. Must be preferred over
	// SourcePath everywhere a restore chooses a destination — see
	// restoreSourcePath (D8): before this field existed, BMR's manifestFile
	// silently dropped `originalPath` on decode (no matching struct field),
	// so every VSS-backed BMR recovery restored under the literal
	// \\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyN\... shadow-device
	// path instead of the real location.
	OriginalPath string `json:"originalPath,omitempty"`
	BackupPath   string `json:"backupPath"`
	Size         int64  `json:"size"`
	// Mode and ModTime mirror backup.SnapshotFile's identically-tagged
	// fields (agent/internal/backup/snapshot.go) — bmr's manifestFile is a
	// deliberately independent JSON-shaped mirror (see snapshotManifest's
	// doc comment), so it carries its own copies rather than importing
	// backup for two fields. Before these existed, restoreFiles silently
	// dropped `mode`/`modTime` on decode (no matching struct fields), so
	// every BMR-restored file landed with drifted permissions/mtimes (O20).
	Mode    uint32    `json:"mode,omitempty"`
	ModTime time.Time `json:"modTime"`
}

// restoreSourcePath returns the path a BMR restore should re-root file
// under: file.OriginalPath when VSS rewrote SourcePath to a per-run
// shadow-copy device path, else file.SourcePath. Mirrors backup's
// (unexported) restoreSourcePath / journalEntryKey rule — bmr's
// manifestFile is a deliberately independent JSON-shaped mirror of
// backup.SnapshotFile (see snapshotManifest's doc comment above), so it
// carries its own copy of the same fallback rule rather than importing
// backup for one function.
func restoreSourcePath(file manifestFile) string {
	if file.OriginalPath != "" {
		return file.OriginalPath
	}
	return file.SourcePath
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

func applySystemState(ctx context.Context, cfg RecoveryConfig, provider providers.BackupProvider) (applied bool, drivers int, warnings []string, err error) {
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
		if ctx != nil && ctx.Err() != nil {
			return applied, drivers, warnings, nil
		}
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
	ctx context.Context,
	manifest *snapshotManifest,
	cfg RecoveryConfig,
	provider providers.BackupProvider,
) (filesRestored int, bytesRestored int64, warnings []string, failedFiles int, err error) {
	// addFailure records a per-file failure. It always increments
	// failedFiles (the true count, reported via RecoveryResult.FailedFiles),
	// but stops appending individual warning strings once maxRecoveryWarnings
	// is reached — see the const's doc comment (D14).
	addFailure := func(format string, args ...any) {
		failedFiles++
		if len(warnings) < maxRecoveryWarnings {
			warnings = append(warnings, fmt.Sprintf(format, args...))
		}
	}

	// addFidelityFailure records a post-restore metadata (chmod/chtimes)
	// failure. Unlike addFailure, it does NOT increment failedFiles: the
	// file's bytes were already downloaded and verified successfully, only
	// the permission/mtime reapply failed, so this is not a restore
	// failure. It still shares the same maxRecoveryWarnings cap on
	// individual warning strings (D14) — a systematic chmod/chtimes failure
	// (e.g. a read-only restore target) must not blow past the API's
	// warnings size limit any more than a wave of download failures may.
	fidelityFailures := 0
	addFidelityFailure := func(format string, args ...any) {
		fidelityFailures++
		if len(warnings) < maxRecoveryWarnings {
			warnings = append(warnings, fmt.Sprintf(format, args...))
		}
	}

	for _, file := range manifest.Files {
		if ctx != nil && ctx.Err() != nil {
			if filesRestored > 0 {
				return filesRestored, bytesRestored, warnings, failedFiles, nil
			}
			return filesRestored, bytesRestored, warnings, failedFiles, fmt.Errorf("bmr: recovery cancelled")
		}
		// TargetPaths overrides are keyed by the ORIGINAL path (see
		// RecoveryConfig.TargetPaths's doc comment: "original -> target
		// path overrides") — under VSS, file.SourcePath is a per-run
		// shadow-copy device path a caller would never know to key an
		// override by (D8).
		origPath := restoreSourcePath(file)
		targetPath := origPath
		if override, ok := cfg.TargetPaths[origPath]; ok {
			targetPath = override
		}

		dir := filepath.Dir(targetPath)
		if mkErr := os.MkdirAll(dir, 0o750); mkErr != nil {
			addFailure("mkdir failed for %s: %s", dir, mkErr.Error())
			continue
		}

		if dlErr := provider.Download(file.BackupPath, targetPath); dlErr != nil {
			addFailure("restore failed for %s: %s", file.SourcePath, dlErr.Error())
			continue
		}
		if ctx != nil && ctx.Err() != nil {
			return filesRestored, bytesRestored, warnings, failedFiles, nil
		}

		// Reapply the manifest's captured mode + mtime, best-effort — exactly
		// like restore.go's post-restore fidelity step (~:241). A
		// chmod/chtimes failure must not fail an otherwise-good restore, but
		// IS surfaced in warnings so the caller knows fidelity was partial.
		// Mode==0 / a zero ModTime means "unknown" (pre-fidelity manifest) →
		// leave the OS default (O20).
		if file.Mode != 0 {
			if chmodErr := chmodFile(targetPath, os.FileMode(file.Mode).Perm()); chmodErr != nil {
				addFidelityFailure("could not reapply mode %o to %s: %s", os.FileMode(file.Mode).Perm(), origPath, chmodErr.Error())
				slog.Warn("bmr: failed to reapply file mode on restore",
					"target", targetPath, "mode", file.Mode, "error", chmodErr.Error())
			}
		}
		if !file.ModTime.IsZero() {
			if chtimesErr := chtimesFile(targetPath, file.ModTime, file.ModTime); chtimesErr != nil {
				addFidelityFailure("could not reapply mtime to %s: %s", origPath, chtimesErr.Error())
				slog.Warn("bmr: failed to reapply mtime on restore",
					"target", targetPath, "error", chtimesErr.Error())
			}
		}

		filesRestored++
		bytesRestored += file.Size
	}

	if failedFiles > maxRecoveryWarnings {
		warnings = append(warnings,
			fmt.Sprintf("... and %d more file restore failures", failedFiles-maxRecoveryWarnings))
	}
	if fidelityFailures > maxRecoveryWarnings {
		warnings = append(warnings,
			fmt.Sprintf("... and %d more metadata failures", fidelityFailures-maxRecoveryWarnings))
	}

	if filesRestored == 0 && len(manifest.Files) > 0 {
		return 0, 0, warnings, failedFiles, fmt.Errorf("bmr: all %d files failed to restore", len(manifest.Files))
	}
	if filesRestored < len(manifest.Files) {
		return filesRestored, bytesRestored, warnings, failedFiles,
			fmt.Errorf("bmr: %d of %d files failed to restore", len(manifest.Files)-filesRestored, len(manifest.Files))
	}
	return filesRestored, bytesRestored, warnings, failedFiles, nil
}
