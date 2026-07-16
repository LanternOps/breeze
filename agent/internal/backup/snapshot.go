package backup

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"os"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// sha256File streams a file through SHA-256 and returns the lowercase-hex
// digest. Streaming keeps memory flat for large files.
func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// checksumMatches reports whether the file at path hashes to want. A hashing
// error counts as a mismatch (fail-closed) so verification never passes a file
// it could not read.
func checksumMatches(path, want string) bool {
	got, err := sha256File(path)
	return err == nil && got == want
}

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
//
// Checksum + Mode were added so integrity/test-restore can detect silent
// corruption and so restore can reapply Unix permissions. Both are
// `omitempty`: manifests written before this change carry neither, and the
// verify/restore paths treat an absent value as "not available" and fall back
// gracefully (size-only check on verify, default mode on restore).
type SnapshotFile struct {
	SourcePath string    `json:"sourcePath"`
	BackupPath string    `json:"backupPath"`
	Size       int64     `json:"size"`
	ModTime    time.Time `json:"modTime"`
	// Checksum is the lowercase-hex SHA-256 of the ORIGINAL (uncompressed)
	// source bytes. Verify/restore compare it against the bytes returned by
	// provider.Download(), which yields the original source bytes for every
	// provider: the cloud providers (S3/B2/Azure/GCS) store the object verbatim,
	// and LocalProvider stores it gzip-compressed (the .gz suffix) but
	// decompresses on download. Do NOT assume the *stored* object equals the
	// source bytes — that holds only for the cloud providers, not LocalProvider.
	Checksum string `json:"checksum,omitempty"`
	// Mode is the file's Unix permission bits (os.FileMode.Perm(), low 9 bits
	// only — setuid/setgid/sticky are intentionally NOT captured or restored),
	// reapplied on restore. 0 means "unknown" (an older manifest) → restore
	// leaves the OS default. Caveat: a file legitimately at mode 0000 also
	// stores as 0 and is therefore treated as "unknown" (left at the OS default
	// rather than restored to 0000) — an accepted limitation.
	Mode uint32 `json:"mode,omitempty"`
}

type contextUploader interface {
	UploadContext(ctx context.Context, localPath, remotePath string) error
}

// CreateSnapshot creates a new snapshot and uploads files via the provider.
func CreateSnapshot(provider providers.BackupProvider, files []backupFile) (*Snapshot, error) {
	return CreateSnapshotContext(context.Background(), provider, files)
}

// CreateSnapshotContext creates a new snapshot using the provided context.
func CreateSnapshotContext(ctx context.Context, provider providers.BackupProvider, files []backupFile) (*Snapshot, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if provider == nil {
		return nil, errors.New("backup provider is required")
	}
	if len(files) == 0 {
		return nil, errors.New("no files provided for snapshot")
	}

	snapshot := &Snapshot{
		ID:        newSnapshotID(),
		Timestamp: time.Now().UTC(),
	}

	prefix := path.Join(snapshotRootDir, snapshot.ID)
	var errs []error

	for _, file := range files {
		if err := ctx.Err(); err != nil {
			cleanupSnapshotPrefix(provider, snapshot.ID)
			return nil, errBackupStopped
		}
		backupPath := path.Join(prefix, snapshotFilesDir, file.snapshotPath)
		backupPath = ensureGzipExtension(backupPath)

		if err := uploadSnapshotFile(ctx, provider, file.sourcePath, backupPath); err != nil {
			if errors.Is(err, errBackupStopped) {
				cleanupSnapshotPrefix(provider, snapshot.ID)
				return nil, errBackupStopped
			}
			err = fmt.Errorf("failed to upload %s: %w", file.sourcePath, err)
			errs = append(errs, err)
			log.Printf("[backup] upload failed: %s: %v", file.sourcePath, err)
			continue
		}

		// Checksum the source bytes so integrity/test-restore can detect silent
		// corruption of the stored object. A hash failure here is non-fatal —
		// the file is still backed up; it just won't carry a checksum (verify
		// falls back to a size check for it).
		//
		// NOTE: this re-reads the source after the upload above. On a host with
		// no snapshotting (Unix has no VSS), a file that mutates between the
		// upload read and this hash read yields a checksum that won't match the
		// stored object, so a later verify raises a false "corruption" alert.
		// That's the safe direction (a false alarm, not a silent pass) and is
		// consistent with the pre-existing size-from-collection vs content-from-
		// upload race. Eliminating it fully requires hashing the bytes as they
		// stream to the provider (a provider-interface change) — left as future work.
		checksum, sumErr := sha256File(file.sourcePath)
		if sumErr != nil {
			log.Printf("[backup] checksum failed for %s: %v", file.sourcePath, sumErr)
		}

		snapshot.Files = append(snapshot.Files, SnapshotFile{
			SourcePath: file.sourcePath,
			BackupPath: backupPath,
			Size:       file.size,
			ModTime:    file.modTime,
			Checksum:   checksum,
			Mode:       uint32(file.mode.Perm()),
		})
		snapshot.Size += file.size
	}

	if len(snapshot.Files) == 0 {
		return nil, errors.Join(errs...)
	}

	if err := ctx.Err(); err != nil {
		cleanupSnapshotPrefix(provider, snapshot.ID)
		return nil, errBackupStopped
	}

	manifestPath, manifestErr := writeSnapshotManifest(snapshot)
	if manifestErr != nil {
		return snapshot, manifestErr
	}
	defer os.Remove(manifestPath)

	manifestKey := path.Join(prefix, snapshotManifestKey)
	if err := uploadSnapshotFile(ctx, provider, manifestPath, manifestKey); err != nil {
		if errors.Is(err, errBackupStopped) {
			cleanupSnapshotPrefix(provider, snapshot.ID)
			return nil, errBackupStopped
		}
		return snapshot, fmt.Errorf("failed to upload snapshot manifest: %w", err)
	}

	return snapshot, nil
}

func uploadSnapshotFile(ctx context.Context, provider providers.BackupProvider, localPath, remotePath string) error {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return errBackupStopped
		}
	}
	if uploader, ok := provider.(contextUploader); ok {
		if err := uploader.UploadContext(ctx, localPath, remotePath); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return errBackupStopped
			}
			return err
		}
		return nil
	}
	if err := provider.Upload(localPath, remotePath); err != nil {
		return err
	}
	return nil
}

func cleanupSnapshotPrefix(provider providers.BackupProvider, snapshotID string) {
	items, err := listSnapshotPrefixItems(provider, snapshotID)
	if err != nil {
		slog.Error("failed to list aborted snapshot for cleanup", "snapshotId", snapshotID, "error", err.Error())
		return
	}
	for _, item := range items {
		if err := provider.Delete(item); err != nil {
			slog.Error("failed to clean up aborted snapshot file", "item", item, "error", err.Error())
		}
	}
}

// ListSnapshots returns snapshots available from the provider.
func ListSnapshots(provider providers.BackupProvider) ([]Snapshot, error) {
	if provider == nil {
		return nil, errors.New("backup provider is required")
	}

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
			log.Printf("[backup] snapshot manifest temp file failed: %v", err)
			continue
		}
		tempPath := tempFile.Name()
		_ = tempFile.Close()

		if err := provider.Download(item, tempPath); err != nil {
			os.Remove(tempPath)
			err = fmt.Errorf("failed to download manifest %s: %w", item, err)
			errs = append(errs, err)
			log.Printf("[backup] snapshot manifest download failed: %s: %v", item, err)
			continue
		}

		manifestFile, err := os.Open(tempPath)
		if err != nil {
			os.Remove(tempPath)
			err = fmt.Errorf("failed to open manifest %s: %w", tempPath, err)
			errs = append(errs, err)
			log.Printf("[backup] snapshot manifest open failed: %s: %v", item, err)
			continue
		}
		var snapshot Snapshot
		if err := json.NewDecoder(manifestFile).Decode(&snapshot); err != nil {
			_ = manifestFile.Close()
			os.Remove(tempPath)
			err = fmt.Errorf("failed to decode manifest %s: %w", item, err)
			errs = append(errs, err)
			log.Printf("[backup] snapshot manifest decode failed: %s: %v", item, err)
			continue
		}
		if err := manifestFile.Close(); err != nil {
			err = fmt.Errorf("failed to close manifest %s: %w", item, err)
			errs = append(errs, err)
			log.Printf("[backup] snapshot manifest close failed: %s: %v", item, err)
		}
		os.Remove(tempPath)

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
func DeleteSnapshot(provider providers.BackupProvider, retention int) error {
	return DeleteSnapshotContext(context.Background(), provider, retention)
}

// DeleteSnapshotContext prunes snapshots beyond the retention count.
func DeleteSnapshotContext(ctx context.Context, provider providers.BackupProvider, retention int) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if retention <= 0 {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return errBackupStopped
	}
	snapshots, err := ListSnapshots(provider)
	if err != nil && len(snapshots) == 0 {
		return err
	}
	if len(snapshots) <= retention {
		return err
	}

	var errs []error

	toDelete := snapshots[:len(snapshots)-retention]
	for _, snapshot := range toDelete {
		if err := ctx.Err(); err != nil {
			return errBackupStopped
		}
		items, listErr := listSnapshotPrefixItems(provider, snapshot.ID)
		if listErr != nil {
			listErr = fmt.Errorf("failed to list snapshot %s: %w", snapshot.ID, listErr)
			errs = append(errs, listErr)
			log.Printf("[backup] snapshot list failed: %s: %v", snapshot.ID, listErr)
			continue
		}

		for _, item := range items {
			if err := ctx.Err(); err != nil {
				return errBackupStopped
			}
			if delErr := provider.Delete(item); delErr != nil {
				delErr = fmt.Errorf("failed to delete %s: %w", item, delErr)
				errs = append(errs, delErr)
				log.Printf("[backup] snapshot delete failed: %s: %v", item, delErr)
			}
		}
	}

	return errors.Join(err, errors.Join(errs...))
}

func listSnapshotPrefixItems(provider providers.BackupProvider, snapshotID string) ([]string, error) {
	prefix := path.Join(snapshotRootDir, snapshotID)
	items, err := provider.List(prefix + "/")
	if err != nil {
		return nil, err
	}

	scoped := make([]string, 0, len(items))
	for _, item := range items {
		cleaned := path.Clean(item)
		if cleaned == prefix || strings.HasPrefix(cleaned, prefix+"/") {
			scoped = append(scoped, item)
		}
	}
	return scoped, nil
}

func ensureGzipExtension(p string) string {
	if strings.HasSuffix(p, ".gz") {
		return p
	}
	return p + ".gz"
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
