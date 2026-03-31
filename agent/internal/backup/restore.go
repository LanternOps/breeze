package backup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// RestoreConfig configures a restore operation.
type RestoreConfig struct {
	SnapshotID    string
	TargetPath    string   // where to restore files
	SelectedPaths []string // if non-empty, only restore files matching these prefixes
}

// RestoreResult tracks the outcome of a restore.
type RestoreResult struct {
	SnapshotID    string   `json:"snapshotId"`
	Status        string   `json:"status"` // completed, partial, failed
	FilesRestored int      `json:"filesRestored"`
	BytesRestored int64    `json:"bytesRestored"`
	FilesFailed   int      `json:"filesFailed"`
	FailedFiles   []string `json:"failedFiles,omitempty"`
	Warnings      []string `json:"warnings,omitempty"`
	StagingDir    string   `json:"stagingDir,omitempty"`
}

// ProgressFunc is called after each file is restored.
type ProgressFunc func(phase string, current, total int64, message string)

// RestoreFromSnapshot downloads files from a backup snapshot and restores them
// to the target path or original source paths.
func RestoreFromSnapshot(provider providers.BackupProvider, cfg RestoreConfig, progressFn ProgressFunc) (*RestoreResult, error) {
	if provider == nil {
		return nil, errors.New("backup provider is required")
	}
	if cfg.SnapshotID == "" {
		return nil, errors.New("snapshot ID is required")
	}

	result := &RestoreResult{SnapshotID: cfg.SnapshotID}

	// 1. Download and parse manifest
	snapshot, err := downloadManifest(provider, cfg.SnapshotID)
	if err != nil {
		result.Status = "failed"
		return result, fmt.Errorf("download manifest: %w", err)
	}

	// 2. Filter files by selected paths
	files := filterFiles(snapshot.Files, cfg.SelectedPaths)
	if len(files) == 0 {
		result.Status = "completed"
		if len(cfg.SelectedPaths) > 0 {
			result.Warnings = append(result.Warnings, "no files matched the selected paths")
		}
		return result, nil
	}

	// 3. Create or reuse a deterministic staging directory so partial restores
	// can resume on a subsequent attempt.
	stagingDir, err := restoreStagingDir(cfg)
	if err != nil {
		result.Status = "failed"
		return result, fmt.Errorf("resolve staging dir: %w", err)
	}
	if err := os.MkdirAll(stagingDir, 0o755); err != nil {
		result.Status = "failed"
		return result, fmt.Errorf("create staging dir: %w", err)
	}
	result.StagingDir = stagingDir

	// 4. Load resume state if it exists
	resumeState, err := LoadResumeState(stagingDir)
	if err != nil {
		slog.Warn("failed to load resume state, starting fresh", "error", err.Error())
	}
	if resumeState == nil {
		resumeState = &ResumeState{
			SnapshotID:     cfg.SnapshotID,
			CompletedFiles: make(map[string]bool),
		}
	}

	total := int64(len(files))
	if progressFn != nil {
		progressFn("starting", 0, total, fmt.Sprintf("restoring %d files", total))
	}

	// 5. Restore each file
	for i, file := range files {
		current := int64(i + 1)
		targetPath := resolveTargetPath(cfg.TargetPath, file.SourcePath)

		// Skip already-completed files (resume)
		if resumeState.CompletedFiles[file.BackupPath] {
			if info, statErr := os.Stat(targetPath); statErr == nil && info.Size() == file.Size {
				result.FilesRestored++
				result.BytesRestored += file.Size
				if progressFn != nil {
					progressFn("restoring", current, total,
						fmt.Sprintf("skipped (resumed): %s", file.SourcePath))
				}
				continue
			}
			delete(resumeState.CompletedFiles, file.BackupPath)
		}

		// Download to staging
		stagingFile := filepath.Join(stagingDir, sanitizeFileName(file.BackupPath))
		if err := os.MkdirAll(filepath.Dir(stagingFile), 0o755); err != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, file.SourcePath)
			slog.Warn("failed to create staging subdir",
				"file", file.SourcePath, "error", err.Error())
			continue
		}

		dlErr := provider.Download(file.BackupPath, stagingFile)
		if dlErr != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, file.SourcePath)
			slog.Warn("failed to download file",
				"backupPath", file.BackupPath, "error", dlErr.Error())
			continue
		}

		// Path containment check
		{
			base := cfg.TargetPath
			if base == "" {
				base = filepath.Join(os.TempDir(), "breeze-restore")
			}
			cleaned := filepath.Clean(targetPath)
			cleanBase := filepath.Clean(base)
			if !strings.HasPrefix(cleaned, cleanBase+string(filepath.Separator)) && cleaned != cleanBase {
				result.Warnings = append(result.Warnings, fmt.Sprintf("path traversal blocked: %s", file.SourcePath))
				result.FilesFailed++
				os.Remove(stagingFile)
				continue
			}
		}

		// Create target directory
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, file.SourcePath)
			os.Remove(stagingFile)
			slog.Warn("failed to create target dir",
				"target", targetPath, "error", err.Error())
			continue
		}

		// Move from staging to target
		if err := moveFile(stagingFile, targetPath); err != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, file.SourcePath)
			os.Remove(stagingFile)
			slog.Warn("failed to move file to target",
				"staging", stagingFile, "target", targetPath, "error", err.Error())
			continue
		}

		result.FilesRestored++
		result.BytesRestored += file.Size
		resumeState.CompletedFiles[file.BackupPath] = true
		resumeState.BytesRestored += file.Size

		// Save resume state after each successful file
		if saveErr := SaveResumeState(stagingDir, resumeState); saveErr != nil {
			slog.Warn("failed to save resume state", "error", saveErr.Error())
		}

		if progressFn != nil {
			progressFn("restoring", current, total,
				fmt.Sprintf("restored: %s", file.SourcePath))
		}
	}

	// 6. Determine status
	switch {
	case result.FilesFailed == 0 && result.FilesRestored > 0:
		result.Status = "completed"
	case result.FilesRestored == 0:
		result.Status = "failed"
	default:
		result.Status = "partial"
	}

	// 7. Clean up staging on success
	if result.Status == "completed" {
		if err := os.RemoveAll(stagingDir); err != nil {
			slog.Warn("failed to clean up staging dir", "dir", stagingDir, "error", err.Error())
		} else {
			result.StagingDir = ""
		}
	}

	return result, nil
}

// downloadManifest fetches and parses the manifest for a snapshot.
func downloadManifest(provider providers.BackupProvider, snapshotID string) (*Snapshot, error) {
	manifestKey := path.Join(snapshotRootDir, snapshotID, snapshotManifestKey)

	tmpFile, err := os.CreateTemp("", "restore-manifest-*.json")
	if err != nil {
		return nil, fmt.Errorf("create temp manifest: %w", err)
	}
	tmpPath := tmpFile.Name()
	_ = tmpFile.Close()
	defer os.Remove(tmpPath)

	if err := provider.Download(manifestKey, tmpPath); err != nil {
		return nil, fmt.Errorf("download manifest: %w", err)
	}

	data, err := os.ReadFile(tmpPath)
	if err != nil {
		return nil, fmt.Errorf("read manifest: %w", err)
	}

	var snapshot Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return nil, fmt.Errorf("decode manifest: %w", err)
	}
	return &snapshot, nil
}

// filterFiles returns only the files whose SourcePath matches at least one of
// the selected path prefixes. If selectedPaths is empty, all files are returned.
func filterFiles(files []SnapshotFile, selectedPaths []string) []SnapshotFile {
	if len(selectedPaths) == 0 {
		return files
	}

	var matched []SnapshotFile
	for _, f := range files {
		for _, prefix := range selectedPaths {
			if strings.HasPrefix(f.SourcePath, prefix) {
				matched = append(matched, f)
				break
			}
		}
	}
	return matched
}

// resolveTargetPath determines where to restore a file. If targetBase is set,
// the full relative source path is preserved under targetBase to maintain
// directory structure and prevent name collisions. Otherwise the original
// source path is used.
func resolveTargetPath(targetBase, sourcePath string) string {
	if targetBase == "" {
		// Use a safe temp directory instead of the original absolute path
		return filepath.Join(os.TempDir(), "breeze-restore", sourcePath)
	}
	// Preserve full path structure under the target base
	// e.g., targetBase="/restore", sourcePath="path_0/reports/config.json"
	// → "/restore/path_0/reports/config.json"
	return filepath.Join(targetBase, sourcePath)
}

func restoreStagingDir(cfg RestoreConfig) (string, error) {
	keyData, err := json.Marshal(struct {
		TargetPath    string   `json:"targetPath"`
		SelectedPaths []string `json:"selectedPaths"`
	}{
		TargetPath:    cfg.TargetPath,
		SelectedPaths: cfg.SelectedPaths,
	})
	if err != nil {
		return "", fmt.Errorf("encode staging key: %w", err)
	}

	sum := sha256.Sum256(keyData)
	stagingKey := hex.EncodeToString(sum[:8])
	return filepath.Join(os.TempDir(), "breeze-restore-staging", cfg.SnapshotID, stagingKey), nil
}

// moveFile attempts os.Rename first (fast, same filesystem), then falls back
// to copy+delete for cross-filesystem moves.
func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	// Cross-filesystem fallback: copy then delete
	return copyAndDelete(src, dst)
}

// copyAndDelete copies src to dst then removes src.
func copyAndDelete(src, dst string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open source: %w", err)
	}

	dstFile, err := os.Create(dst)
	if err != nil {
		_ = srcFile.Close()
		return fmt.Errorf("create destination: %w", err)
	}

	_, err = io.Copy(dstFile, srcFile)
	closeErr := dstFile.Close()
	if err == nil {
		err = closeErr
	}
	closeErr = srcFile.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("copy file: %w", err)
	}

	if err := os.Remove(src); err != nil {
		slog.Warn("failed to remove staging file after copy", "path", src, "error", err.Error())
	}
	return nil
}

// sanitizeFileName converts a backup path to a safe local filename by
// replacing path separators and removing leading dots.
func sanitizeFileName(backupPath string) string {
	safe := strings.ReplaceAll(backupPath, "/", "_")
	safe = strings.ReplaceAll(safe, "\\", "_")
	safe = strings.TrimLeft(safe, ".")
	if safe == "" {
		safe = "unnamed"
	}
	return safe
}
