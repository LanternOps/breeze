package backup

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// VerifyResult holds the outcome of a backup integrity check.
type VerifyResult struct {
	SnapshotID    string   `json:"snapshotId"`
	Status        string   `json:"status"` // passed, failed, partial
	FilesVerified int      `json:"filesVerified"`
	FilesFailed   int      `json:"filesFailed"`
	SizeBytes     int64    `json:"sizeBytes"`
	DurationMs    int64    `json:"durationMs"`
	FailedFiles   []string `json:"failedFiles,omitempty"`
	Error         string   `json:"error,omitempty"`
}

// TestRestoreResult holds the outcome of a test restore operation.
type TestRestoreResult struct {
	SnapshotID         string   `json:"snapshotId"`
	Status             string   `json:"status"`
	FilesVerified      int      `json:"filesVerified"`
	FilesFailed        int      `json:"filesFailed"`
	SizeBytes          int64    `json:"sizeBytes"`
	RestoreTimeSeconds int      `json:"restoreTimeSeconds"`
	RestorePath        string   `json:"restorePath"`
	CleanedUp          bool     `json:"cleanedUp"`
	FailedFiles        []string `json:"failedFiles,omitempty"`
	Error              string   `json:"error,omitempty"`
}

// VerifyIntegrity checks a snapshot's manifest and validates each file
// can be downloaded and read from the provider.
func VerifyIntegrity(provider providers.BackupProvider, snapshotID string) (*VerifyResult, error) {
	start := time.Now()
	result := &VerifyResult{SnapshotID: snapshotID}

	// Download and parse manifest
	manifestKey := path.Join(snapshotRootDir, snapshotID, snapshotManifestKey)
	tempManifest, err := os.CreateTemp("", "verify-manifest-*.json")
	if err != nil {
		result.Status = "failed"
		result.Error = fmt.Sprintf("failed to create temp file: %v", err)
		result.DurationMs = time.Since(start).Milliseconds()
		return result, nil
	}
	tempManifestPath := tempManifest.Name()
	_ = tempManifest.Close()
	defer os.Remove(tempManifestPath)

	if err := provider.Download(manifestKey, tempManifestPath); err != nil {
		result.Status = "failed"
		result.Error = fmt.Sprintf("manifest not found: %v", err)
		result.DurationMs = time.Since(start).Milliseconds()
		return result, nil
	}

	manifestData, err := os.ReadFile(tempManifestPath)
	if err != nil {
		result.Status = "failed"
		result.Error = fmt.Sprintf("failed to read manifest: %v", err)
		result.DurationMs = time.Since(start).Milliseconds()
		return result, nil
	}

	var snapshot Snapshot
	if err := json.Unmarshal(manifestData, &snapshot); err != nil {
		result.Status = "failed"
		result.Error = fmt.Sprintf("invalid manifest JSON: %v", err)
		result.DurationMs = time.Since(start).Milliseconds()
		return result, nil
	}

	// Verify each file by downloading through the provider
	for _, file := range snapshot.Files {
		tempFile, err := os.CreateTemp("", "verify-file-*")
		if err != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, file.BackupPath)
			log.Printf("[backup-verify] temp file create failed for %s: %v", file.BackupPath, err)
			continue
		}
		tempPath := tempFile.Name()
		_ = tempFile.Close()

		// Download the file from provider (provider validates gzip on .gz files)
		dlErr := provider.Download(file.BackupPath, tempPath)
		if dlErr != nil {
			os.Remove(tempPath)
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, file.BackupPath)
			log.Printf("[backup-verify] download failed for %s: %v", file.BackupPath, dlErr)
			continue
		}

		info, _ := os.Stat(tempPath)
		if info != nil {
			result.SizeBytes += info.Size()
		}
		os.Remove(tempPath)
		result.FilesVerified++
	}

	// Determine status
	total := result.FilesVerified + result.FilesFailed
	switch {
	case total == 0:
		result.Status = "failed"
		result.Error = "no files in snapshot"
	case result.FilesFailed == 0:
		result.Status = "passed"
	case result.FilesVerified == 0:
		result.Status = "failed"
	default:
		result.Status = "partial"
	}

	result.DurationMs = time.Since(start).Milliseconds()
	return result, nil
}

const restoreTestPrefix = "breeze-restore-test"

// TestRestore downloads a snapshot to a temp directory and verifies each file.
// progressFn is called after each file with (current, total) counts. Can be nil.
func TestRestore(provider providers.BackupProvider, snapshotID string, progressFn func(current, total int)) (*TestRestoreResult, error) {
	start := time.Now()
	result := &TestRestoreResult{SnapshotID: snapshotID}

	// Download and parse manifest
	manifestKey := path.Join(snapshotRootDir, snapshotID, snapshotManifestKey)
	tempManifest, err := os.CreateTemp("", "restore-manifest-*.json")
	if err != nil {
		result.Status = "failed"
		result.Error = fmt.Sprintf("failed to create temp file: %v", err)
		return result, nil
	}
	tempManifestPath := tempManifest.Name()
	_ = tempManifest.Close()
	defer os.Remove(tempManifestPath)

	if err := provider.Download(manifestKey, tempManifestPath); err != nil {
		result.Status = "failed"
		result.Error = fmt.Sprintf("manifest not found: %v", err)
		return result, nil
	}

	manifestData, err := os.ReadFile(tempManifestPath)
	if err != nil {
		result.Status = "failed"
		result.Error = fmt.Sprintf("failed to read manifest: %v", err)
		return result, nil
	}

	var snapshot Snapshot
	if err := json.Unmarshal(manifestData, &snapshot); err != nil {
		result.Status = "failed"
		result.Error = fmt.Sprintf("invalid manifest JSON: %v", err)
		return result, nil
	}

	// Create isolated restore directory
	restoreDir := filepath.Join(os.TempDir(), restoreTestPrefix, snapshotID)
	if err := os.MkdirAll(restoreDir, 0o755); err != nil {
		result.Status = "failed"
		result.Error = fmt.Sprintf("failed to create restore dir: %v", err)
		return result, nil
	}
	result.RestorePath = restoreDir

	// Restore each file
	total := len(snapshot.Files)
	for i, file := range snapshot.Files {
		destPath := resolveTargetPath(restoreDir, file.SourcePath)
		if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, file.BackupPath)
			log.Printf("[backup-restore] create target dir failed for %s: %v", destPath, err)
			if progressFn != nil {
				progressFn(i+1, total)
			}
			continue
		}

		dlErr := provider.Download(file.BackupPath, destPath)
		if dlErr != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, file.BackupPath)
			log.Printf("[backup-restore] download failed for %s: %v", file.BackupPath, dlErr)
		} else {
			info, statErr := os.Stat(destPath)
			if statErr != nil {
				result.FilesFailed++
				result.FailedFiles = append(result.FailedFiles, file.BackupPath)
			} else {
				result.FilesVerified++
				result.SizeBytes += info.Size()
			}
		}

		if progressFn != nil {
			progressFn(i+1, total)
		}
	}

	// Determine status
	switch {
	case result.FilesVerified+result.FilesFailed == 0:
		result.Status = "failed"
		result.Error = "no files in snapshot"
	case result.FilesFailed == 0:
		result.Status = "passed"
	case result.FilesVerified == 0:
		result.Status = "failed"
	default:
		result.Status = "partial"
	}

	result.RestoreTimeSeconds = int(time.Since(start).Seconds())

	// Cleanup
	if cleanErr := os.RemoveAll(restoreDir); cleanErr != nil {
		log.Printf("[backup-restore] cleanup failed for %s: %v", restoreDir, cleanErr)
		result.CleanedUp = false
	} else {
		result.CleanedUp = true
	}

	return result, nil
}

// CleanupRestoreDir removes a test restore directory after validating the path
// is within the expected prefix to prevent path traversal.
func CleanupRestoreDir(dirPath string) error {
	expectedPrefix := filepath.Join(os.TempDir(), restoreTestPrefix) + string(filepath.Separator)
	if !strings.HasPrefix(dirPath, expectedPrefix) {
		return fmt.Errorf("path %q is outside allowed restore prefix %q", dirPath, expectedPrefix)
	}
	return os.RemoveAll(dirPath)
}
