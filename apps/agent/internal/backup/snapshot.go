package backup

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"go.uber.org/zap"
)

const (
	snapshotRootDir     = "snapshots"
	snapshotFilesDir    = "files"
	snapshotManifestKey = "manifest.json"
)

// Snapshot represents a point-in-time backup.
type Snapshot struct {
	ID        string         `json:"id"`
	Timestamp time.Time      `json:"timestamp"`
	Files     []SnapshotFile `json:"files"`
	Size      int64          `json:"size"`
}

// SnapshotFile captures metadata for a backed up file.
type SnapshotFile struct {
	SourcePath string    `json:"sourcePath"`
	BackupPath string    `json:"backupPath"`
	Size       int64     `json:"size"`
	ModTime    time.Time `json:"modTime"`
}

// CreateSnapshot creates a new snapshot and uploads files via the provider.
func CreateSnapshot(provider providers.BackupProvider, files []backupFile, logger *zap.Logger) (*Snapshot, error) {
	if provider == nil {
		return nil, errors.New("backup provider is required")
	}
	if len(files) == 0 {
		return nil, errors.New("no files provided for snapshot")
	}
	logger = defaultLogger(logger)

	snapshot := &Snapshot{
		ID:        newSnapshotID(),
		Timestamp: time.Now().UTC(),
	}

	prefix := path.Join(snapshotRootDir, snapshot.ID)
	var errs []error

	for _, file := range files {
		backupPath := path.Join(prefix, snapshotFilesDir, file.snapshotPath)
		backupPath = ensureGzipExtension(backupPath)

		if err := provider.Upload(file.sourcePath, backupPath); err != nil {
			err = fmt.Errorf("failed to upload %s: %w", file.sourcePath, err)
			errs = append(errs, err)
			logger.Warn("backup upload failed", zap.String("path", file.sourcePath), zap.Error(err))
			continue
		}

		snapshot.Files = append(snapshot.Files, SnapshotFile{
			SourcePath: file.sourcePath,
			BackupPath: backupPath,
			Size:       file.size,
			ModTime:    file.modTime,
		})
		snapshot.Size += file.size
	}

	if len(snapshot.Files) == 0 {
		return nil, errors.Join(errs...)
	}

	manifestPath, manifestErr := writeSnapshotManifest(snapshot)
	if manifestErr != nil {
		return snapshot, manifestErr
	}
	defer os.Remove(manifestPath)

	manifestKey := path.Join(prefix, snapshotManifestKey)
	if err := provider.Upload(manifestPath, manifestKey); err != nil {
		return snapshot, fmt.Errorf("failed to upload snapshot manifest: %w", err)
	}

	return snapshot, nil
}

// ListSnapshots returns snapshots available from the provider.
func ListSnapshots(provider providers.BackupProvider, logger *zap.Logger) ([]Snapshot, error) {
	if provider == nil {
		return nil, errors.New("backup provider is required")
	}
	logger = defaultLogger(logger)

	items, err := provider.List(snapshotRootDir)
	if err != nil {
		return nil, err
	}

	var snapshots []Snapshot
	var errs []error

	for _, item := range items {
		if !isManifestPath(item) {
			continue
		}

		tempFile, err := os.CreateTemp("", "snapshot-manifest-*.json")
		if err != nil {
			err = fmt.Errorf("failed to create temp manifest: %w", err)
			errs = append(errs, err)
			logger.Warn("snapshot manifest temp file failed", zap.Error(err))
			continue
		}
		tempPath := tempFile.Name()
		_ = tempFile.Close()
		defer os.Remove(tempPath)

		if err := provider.Download(item, tempPath); err != nil {
			err = fmt.Errorf("failed to download manifest %s: %w", item, err)
			errs = append(errs, err)
			logger.Warn("snapshot manifest download failed", zap.String("path", item), zap.Error(err))
			continue
		}

		manifestFile, err := os.Open(tempPath)
		if err != nil {
			err = fmt.Errorf("failed to open manifest %s: %w", tempPath, err)
			errs = append(errs, err)
			logger.Warn("snapshot manifest open failed", zap.String("path", item), zap.Error(err))
			continue
		}
		var snapshot Snapshot
		if err := json.NewDecoder(manifestFile).Decode(&snapshot); err != nil {
			_ = manifestFile.Close()
			err = fmt.Errorf("failed to decode manifest %s: %w", item, err)
			errs = append(errs, err)
			logger.Warn("snapshot manifest decode failed", zap.String("path", item), zap.Error(err))
			continue
		}
		if err := manifestFile.Close(); err != nil {
			err = fmt.Errorf("failed to close manifest %s: %w", item, err)
			errs = append(errs, err)
			logger.Warn("snapshot manifest close failed", zap.String("path", item), zap.Error(err))
		}

		snapshots = append(snapshots, snapshot)
	}

	sort.Slice(snapshots, func(i, j int) bool {
		return snapshots[i].Timestamp.Before(snapshots[j].Timestamp)
	})

	if len(snapshots) == 0 && len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	return snapshots, errors.Join(errs...)
}

// DeleteSnapshot prunes snapshots beyond the retention count.
func DeleteSnapshot(provider providers.BackupProvider, retention int, logger *zap.Logger) error {
	if retention <= 0 {
		return nil
	}
	snapshots, err := ListSnapshots(provider, logger)
	if err != nil && len(snapshots) == 0 {
		return err
	}
	if len(snapshots) <= retention {
		return err
	}

	logger = defaultLogger(logger)
	var errs []error

	toDelete := snapshots[:len(snapshots)-retention]
	for _, snapshot := range toDelete {
		prefix := path.Join(snapshotRootDir, snapshot.ID)
		items, listErr := provider.List(prefix)
		if listErr != nil {
			listErr = fmt.Errorf("failed to list snapshot %s: %w", snapshot.ID, listErr)
			errs = append(errs, listErr)
			logger.Warn("snapshot list failed", zap.String("snapshot", snapshot.ID), zap.Error(listErr))
			continue
		}

		for _, item := range items {
			if delErr := provider.Delete(item); delErr != nil {
				delErr = fmt.Errorf("failed to delete %s: %w", item, delErr)
				errs = append(errs, delErr)
				logger.Warn("snapshot delete failed", zap.String("path", item), zap.Error(delErr))
			}
		}
	}

	return errors.Join(err, errors.Join(errs...))
}

func ensureGzipExtension(path string) string {
	if strings.HasSuffix(path, ".gz") {
		return path
	}
	return path + ".gz"
}

func isManifestPath(item string) bool {
	item = path.Clean(item)
	return strings.HasSuffix(item, "/"+snapshotManifestKey) || path.Base(item) == snapshotManifestKey
}

func writeSnapshotManifest(snapshot *Snapshot) (string, error) {
	tempFile, err := os.CreateTemp("", "snapshot-manifest-*.json")
	if err != nil {
		return "", fmt.Errorf("failed to create snapshot manifest: %w", err)
	}
	encoder := json.NewEncoder(tempFile)
	if err := encoder.Encode(snapshot); err != nil {
		_ = tempFile.Close()
		return "", fmt.Errorf("failed to encode snapshot manifest: %w", err)
	}
	if err := tempFile.Close(); err != nil {
		return "", fmt.Errorf("failed to close snapshot manifest: %w", err)
	}
	return tempFile.Name(), nil
}

func newSnapshotID() string {
	return newID("snapshot")
}

func newJobID() string {
	return newID("job")
}

func newID(prefix string) string {
	random := make([]byte, 4)
	_, _ = rand.Read(random)
	return fmt.Sprintf("%s-%s-%x", prefix, time.Now().UTC().Format("20060102T150405Z"), random)
}
