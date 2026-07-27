package backup

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// VerifyResult holds the outcome of a backup integrity check.
type VerifyResult struct {
	SnapshotID    string `json:"snapshotId"`
	Status        string `json:"status"` // passed, failed, partial
	FilesVerified int    `json:"filesVerified"`
	// FilesSizeOnly counts files verified by size only because the manifest
	// carried no checksum for them (an older manifest, or a checksum that
	// failed to compute at backup time). Non-zero means "passed" is weaker than
	// a full checksum verification — size-only can't catch same-size bit-rot.
	FilesSizeOnly int      `json:"filesSizeOnly,omitempty"`
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
			log.Warn("temp file create failed", "phase", "verify", "backupPath", file.BackupPath, "error", err.Error())
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
			log.Warn("download failed", "phase", "verify", "backupPath", file.BackupPath, "error", dlErr.Error())
			continue
		}

		// Validate the downloaded object against the manifest so SILENT
		// corruption (bit-rot, truncation, tampering) is caught — not just a
		// missing object. Downloading proves presence; without this a wrong-bytes
		// object passed as "verified" (the remote/cloud providers, unlike
		// LocalProvider, do not gzip-validate, and the manifest previously stored
		// no checksum). Size is always checked; the SHA-256 is checked whenever
		// the manifest carries one (manifests written before checksums were added
		// do not — those are counted as size-only via FilesSizeOnly).
		info, statErr := os.Stat(tempPath)
		if statErr != nil || info == nil {
			os.Remove(tempPath)
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, file.BackupPath)
			log.Warn("stat failed", "phase", "verify", "backupPath", file.BackupPath, "error", errString(statErr))
			continue
		}
		if info.Size() != file.Size {
			os.Remove(tempPath)
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, file.BackupPath)
			log.Warn("size mismatch", "phase", "verify", "backupPath", file.BackupPath,
				"expectedBytes", file.Size, "actualBytes", info.Size())
			continue
		}
		if file.Checksum != "" {
			if !checksumMatches(tempPath, file.Checksum) {
				os.Remove(tempPath)
				result.FilesFailed++
				result.FailedFiles = append(result.FailedFiles, file.BackupPath)
				log.Warn("checksum mismatch", "phase", "verify", "backupPath", file.BackupPath,
					"expected", file.Checksum)
				continue
			}
		} else {
			result.FilesSizeOnly++
		}
		result.SizeBytes += info.Size()
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

// errString renders an error for a structured log attribute. The log shipper
// JSON-marshals attrs and a raw error marshals to {}, so errors are logged as
// strings. Used where the error may be nil (a stat that returned nil info
// without an error), which err.Error() would panic on.
func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
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
			log.Warn("create target dir failed", "phase", "restore", "destPath", destPath, "error", err.Error())
			if progressFn != nil {
				progressFn(i+1, total)
			}
			continue
		}

		dlErr := provider.Download(file.BackupPath, destPath)
		info, statErr := os.Stat(destPath)
		switch {
		case dlErr != nil:
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, file.BackupPath)
			log.Warn("download failed", "phase", "restore", "backupPath", file.BackupPath, "error", dlErr.Error())
		case statErr != nil || info == nil:
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, file.BackupPath)
			log.Warn("stat failed", "phase", "restore", "backupPath", file.BackupPath, "error", errString(statErr))
		case info.Size() != file.Size:
			// A real test-restore must confirm the bytes came back intact, not
			// just that a file appeared (same blind spot as VerifyIntegrity).
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, file.BackupPath)
			log.Warn("size mismatch", "phase", "restore", "backupPath", file.BackupPath,
				"expectedBytes", file.Size, "actualBytes", info.Size())
		case file.Checksum != "" && !checksumMatches(destPath, file.Checksum):
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, file.BackupPath)
			log.Warn("checksum mismatch", "phase", "restore", "backupPath", file.BackupPath,
				"expected", file.Checksum)
		default:
			result.FilesVerified++
			result.SizeBytes += info.Size()
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
		log.Warn("cleanup failed", "phase", "restore", "path", restoreDir, "error", cleanErr.Error())
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
