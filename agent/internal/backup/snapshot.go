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

// ProgressFn reports snapshot upload progress: files/bytes completed so far
// out of the known totals. Called from the snapshot upload loop, throttled
// (see progressThrottle) except for a final unconditional call after the
// last file.
type ProgressFn func(filesDone, filesTotal int, bytesDone, bytesTotal int64)

// progressThrottle is the minimum interval between ProgressFn invocations
// from the snapshot loop (the final call after the loop always fires
// regardless of this interval).
var progressThrottle = 3 * time.Second

// setProgressThrottleForTest overrides progressThrottle so tests can observe
// a callback on every file instead of waiting out the real interval. Call
// the returned restore func (typically via defer) to put the real value
// back.
func setProgressThrottleForTest(d time.Duration) (restore func()) {
	old := progressThrottle
	progressThrottle = d
	return func() { progressThrottle = old }
}

// uploadMinThroughputBps is the deadline floor: assume >=64 KiB/s or declare
// the link stalled.
const uploadMinThroughputBps = 64 * 1024

var uploadTimeoutFloor = 5 * time.Minute

// setUploadTimeoutFloorForTest overrides uploadTimeoutFloor so tests can
// exercise the per-file deadline path without waiting 5 minutes. Call the
// returned restore func (typically via defer) to put the real floor back.
func setUploadTimeoutFloorForTest(d time.Duration) (restore func()) {
	old := uploadTimeoutFloor
	uploadTimeoutFloor = d
	return func() { uploadTimeoutFloor = old }
}

// uploadDeadline returns the per-file upload deadline for a file of the given
// size, scaled to size at uploadMinThroughputBps with a floor of
// uploadTimeoutFloor. A stalled per-file upload is treated as a per-file
// failure (skip and continue), not a job abort — see CreateSnapshotContext.
func uploadDeadline(size int64) time.Duration {
	d := time.Duration(size/uploadMinThroughputBps) * time.Second
	if d < uploadTimeoutFloor {
		return uploadTimeoutFloor
	}
	return d
}

// uploadRetryDelay is the backoff wait before the single per-file upload
// retry (see the retry loop in createSnapshotWithProgress). It is
// interruptible by job-context cancellation.
var uploadRetryDelay = 30 * time.Second

// setUploadRetryDelayForTest overrides uploadRetryDelay so tests can exercise
// the per-file retry path without waiting out the real backoff. Call the
// returned restore func (typically via defer) to put the real delay back.
func setUploadRetryDelayForTest(d time.Duration) (restore func()) {
	old := uploadRetryDelay
	uploadRetryDelay = d
	return func() { uploadRetryDelay = old }
}

// CreateSnapshot creates a new snapshot and uploads files via the provider.
func CreateSnapshot(provider providers.BackupProvider, files []backupFile) (*Snapshot, error) {
	return CreateSnapshotContext(context.Background(), provider, files)
}

// CreateSnapshotContext creates a new snapshot using the provided context.
// It does not report progress and does not checkpoint to a journal (no
// manager/destination-identity context to key one by); see
// createSnapshotWithProgress for both.
func CreateSnapshotContext(ctx context.Context, provider providers.BackupProvider, files []backupFile) (*Snapshot, error) {
	return createSnapshotWithProgress(ctx, provider, files, nil, nil)
}

// createSnapshotWithProgress creates a new snapshot using the provided
// context, invoking onProgress (if non-nil) as files upload. Calls are
// throttled to at most once per progressThrottle interval, except for a
// final unconditional call after the last file so the server always learns
// the true end state even if the throttle window swallowed the last delta.
//
// journal, if non-nil, is this run's checkpoint (see journal.go):
//   - Its snapshotID (fresh or resumed) becomes this snapshot's ID.
//   - Each walked file matching a journal entry on (sourcePath, size,
//     modTime) is treated as already uploaded — skipped, but still carried
//     into this run's manifest — with filesDone/bytesDone pre-seeded from
//     the matched set before the loop starts, so the very first progress
//     emission reflects the resume instead of a slow trickle of
//     skip-iterations.
//   - Every freshly uploaded file is appended to the journal as it lands.
//   - On a full success (manifest uploaded), the journal is completed
//     (closed + removed) — the checkpoint is no longer needed. On every
//     other exit — stopped, per-file exhaustion, manifest failure — the
//     journal is merely abandoned (closed, left on disk): the partial
//     remote prefix plus the journal together ARE the resume state for the
//     next run, so cleanupSnapshotPrefix is skipped for all of them.
func createSnapshotWithProgress(ctx context.Context, provider providers.BackupProvider, files []backupFile, onProgress ProgressFn, journal *snapshotJournal) (*Snapshot, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	// Register the journal's fd cleanup before any other return path so
	// every exit — including the validation errors just below — closes it.
	// completed flips true only after a successful journal.Complete(); every
	// other path falls through to Abandon (close, keep the file).
	completed := false
	if journal != nil {
		defer func() {
			if !completed {
				journal.Abandon()
			}
		}()
	}

	if provider == nil {
		return nil, errors.New("backup provider is required")
	}
	if len(files) == 0 {
		return nil, errors.New("no files provided for snapshot")
	}

	snapshotID := newSnapshotID()
	if journal != nil {
		snapshotID = journal.snapshotID
	}
	snapshot := &Snapshot{
		ID:        snapshotID,
		Timestamp: time.Now().UTC(),
	}

	prefix := path.Join(snapshotRootDir, snapshot.ID)
	var errs []error

	var bytesTotal int64
	for _, file := range files {
		bytesTotal += file.size
	}
	filesTotal := len(files)
	var filesDone int
	var bytesDone int64
	lastProgressAt := time.Now()
	emitProgress := func(force bool) {
		if onProgress == nil {
			return
		}
		if !force && time.Since(lastProgressAt) < progressThrottle {
			return
		}
		lastProgressAt = time.Now()
		onProgress(filesDone, filesTotal, bytesDone, bytesTotal)
	}

	// Resume matching: build the full matched set up front (rather than
	// deciding file-by-file inside the loop below) so filesDone/bytesDone
	// can be pre-seeded with the resumed totals and reported in one jump
	// before any real upload work happens.
	resumedFiles := make(map[string]SnapshotFile)
	if journal != nil {
		for _, file := range files {
			if entry, ok := journal.Lookup(file.sourcePath, file.size, file.modTime); ok {
				resumedFiles[file.sourcePath] = entry
				filesDone++
				bytesDone += entry.Size
			}
		}
		if len(resumedFiles) > 0 {
			log.Printf("[backup] resuming snapshot %s: %d file(s) / %d bytes already uploaded in a prior run",
				snapshot.ID, len(resumedFiles), bytesDone)
			emitProgress(true)
		}
	}

	// abortStopped is the single exit point for every errBackupStopped
	// return. See the journal parameter doc above for why cleanup is
	// conditional on journal == nil.
	abortStopped := func() (*Snapshot, error) {
		if journal == nil {
			cleanupSnapshotPrefix(provider, snapshot.ID)
		}
		return nil, errBackupStopped
	}

	for _, file := range files {
		if err := ctx.Err(); err != nil {
			return abortStopped()
		}
		if entry, ok := resumedFiles[file.sourcePath]; ok {
			// Already uploaded in a prior (interrupted) run with identical
			// (size, modTime) — filesDone/bytesDone already reflect this
			// file via the pre-loop seed above; do not double count.
			snapshot.Files = append(snapshot.Files, entry)
			snapshot.Size += entry.Size
			continue
		}
		backupPath := path.Join(prefix, snapshotFilesDir, file.snapshotPath)
		backupPath = ensureGzipExtension(backupPath)

		uploadErr := attemptFileUpload(ctx, provider, file, backupPath)
		if uploadErr != nil && !errors.Is(uploadErr, errBackupStopped) {
			// Exactly one retry, only for a non-cancel failure (including a
			// per-file deadline expiry, which attemptFileUpload has already
			// converted to a plain error). Job-context cancel during the
			// backoff wait aborts immediately — never retried.
			select {
			case <-ctx.Done():
				uploadErr = errBackupStopped
			case <-time.After(uploadRetryDelay):
				uploadErr = attemptFileUpload(ctx, provider, file, backupPath)
			}
		}
		if uploadErr != nil {
			if errors.Is(uploadErr, errBackupStopped) {
				return abortStopped()
			}
			err := fmt.Errorf("failed to upload %s: %w", file.sourcePath, uploadErr)
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

		entry := SnapshotFile{
			SourcePath: file.sourcePath,
			BackupPath: backupPath,
			Size:       file.size,
			ModTime:    file.modTime,
			Checksum:   checksum,
			Mode:       uint32(file.mode.Perm()),
		}
		snapshot.Files = append(snapshot.Files, entry)
		snapshot.Size += file.size
		filesDone++
		bytesDone += file.size
		emitProgress(false)
		if journal != nil {
			// Record logs and swallows its own write failures — a dead
			// journal degrades resume for next time, it never fails this
			// backup, whose file upload already succeeded.
			_ = journal.Record(entry)
		}
	}
	// Unconditional final call: guarantees the server observes the true end
	// state even if the last file(s) landed inside the throttle window and
	// were swallowed by the `!force` check above.
	emitProgress(true)

	if len(snapshot.Files) == 0 {
		return nil, errors.Join(errs...)
	}

	if err := ctx.Err(); err != nil {
		return abortStopped()
	}

	manifestPath, manifestErr := writeSnapshotManifest(snapshot)
	if manifestErr != nil {
		return snapshot, manifestErr
	}
	defer os.Remove(manifestPath)

	manifestKey := path.Join(prefix, snapshotManifestKey)
	manifestInfo, statErr := os.Stat(manifestPath)
	var manifestSize int64
	if statErr == nil {
		manifestSize = manifestInfo.Size()
	}
	attemptCtx, cancelAttempt := context.WithTimeout(ctx, uploadDeadline(manifestSize))
	manifestUploadErr := uploadSnapshotFile(attemptCtx, provider, manifestPath, manifestKey)
	cancelAttempt()
	if manifestUploadErr != nil {
		if errors.Is(manifestUploadErr, errBackupStopped) {
			// A manifest-upload deadline expiry is fatal for the snapshot too
			// (unlike a per-file data upload): without the manifest the
			// snapshot isn't restorable, so there's nothing to keep going for.
			return abortStopped()
		}
		return snapshot, fmt.Errorf("failed to upload snapshot manifest: %w", manifestUploadErr)
	}

	if journal != nil {
		if err := journal.Complete(); err != nil {
			log.Printf("[backup] failed to remove completed checkpoint journal: %v", err)
		}
		completed = true
	}

	return snapshot, nil
}

// attemptFileUpload runs a single upload attempt for file against a fresh
// per-attempt context scoped to ctx with a size-scaled deadline (see
// uploadDeadline). A deadline expiry that is not also a job-context cancel is
// converted to a plain error so the caller can distinguish "this file
// stalled" (retry / skip-and-continue) from "the job was cancelled" (abort).
func attemptFileUpload(ctx context.Context, provider providers.BackupProvider, file backupFile, backupPath string) error {
	attemptCtx, cancelAttempt := context.WithTimeout(ctx, uploadDeadline(file.size))
	defer cancelAttempt()
	uploadErr := uploadSnapshotFile(attemptCtx, provider, file.sourcePath, backupPath)
	if errors.Is(uploadErr, errBackupStopped) && ctx.Err() == nil {
		// The per-file deadline fired, not a job cancel.
		uploadErr = fmt.Errorf("upload stalled: no completion within %s", uploadDeadline(file.size))
	}
	return uploadErr
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

// backupIdentity returns the material used to derive a checkpoint journal's
// identity (see journal.go) for a given provider + backup path set: enough
// to distinguish two different destinations — so a journal from one
// destination is never mistaken for another's after a reconfiguration —
// without encoding credentials. Concrete providers optionally implement
// providers.JournalIdentity to supply their own kind/endpoint/bucket
// material; providers that don't (test fakes) fall back to a generic
// per-Go-type identity, which is still stable within a single provider
// instance and only risks a false-positive resume match across two
// same-Go-type fake providers in a test — never in production, where every
// real provider implements JournalIdentity.
func backupIdentity(provider providers.BackupProvider, paths []string) string {
	material := fmt.Sprintf("%T", provider)
	if idp, ok := provider.(providers.JournalIdentity); ok {
		material = idp.BackupIdentity()
	}
	sortedPaths := append([]string(nil), paths...)
	sort.Strings(sortedPaths)
	return material + "|" + strings.Join(sortedPaths, ",")
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
