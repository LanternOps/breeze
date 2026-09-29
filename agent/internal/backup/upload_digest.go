package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// uploadWithDigest uploads localPath to remotePath and returns the SHA-256
// and length of the bytes the stored object holds — never a separate read of
// localPath, which may have changed in between.
//
// A provider (or wrapper) implementing providers.DigestUploader reports the
// digest of the stream it read. Otherwise — or when it answers
// providers.ErrDigestUnavailable — localPath is first copied into a private
// file under stagingDir ("" = the OS temp dir) while hashing, and that
// immutable copy is what gets uploaded. Either way the digest belongs to the
// attempt that succeeded.
//
// Errors follow uploadSnapshotFile: a cancelled or expired ctx is
// errBackupStopped, anything else is returned as is.
func uploadWithDigest(ctx context.Context, provider providers.BackupProvider, stagingDir, localPath, remotePath string) (providers.UploadDigest, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return providers.UploadDigest{}, errBackupStopped
	}
	_, brokered := snapshotIDIssuerOf(provider)
	du, ok := provider.(providers.DigestUploader)
	if ok {
		d, err := du.UploadWithDigest(ctx, localPath, remotePath)
		if err == nil {
			return d, nil
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return providers.UploadDigest{}, errBackupStopped
		}
		if !errors.Is(err, providers.ErrDigestUnavailable) || brokered {
			return providers.UploadDigest{}, err
		}
		log.Debug("provider cannot report an upload digest, uploading a staged copy",
			"remotePath", remotePath)
	}
	if brokered {
		// A brokered writer always reports the digest of what it sent; a
		// second, staged upload through it would only hide a fault.
		return providers.UploadDigest{}, fmt.Errorf("%w: the storage session writer reported no digest for %s", providers.ErrDigestUnavailable, remotePath)
	}
	return uploadStagedCopy(ctx, provider, stagingDir, localPath, remotePath)
}

// UploadWithDigest is uploadWithDigest for callers outside this package (the
// helper's database and VM backup commands). A cancelled ctx surfaces as
// ctx.Err() rather than this package's internal stop sentinel.
func UploadWithDigest(ctx context.Context, provider providers.BackupProvider, stagingDir, localPath, remotePath string) (providers.UploadDigest, error) {
	d, err := uploadWithDigest(ctx, provider, stagingDir, localPath, remotePath)
	if errors.Is(err, errBackupStopped) {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return d, ctxErr
		}
		return d, fmt.Errorf("upload of %s stopped", remotePath)
	}
	return d, err
}

// UploadImmutableWithDigest is UploadWithDigest for a source that cannot
// change while the backup runs (a database backup file or VM export the
// helper itself wrote): the provider may then hash it in one read and upload
// it without buffering, failing if it changed after all.
func UploadImmutableWithDigest(ctx context.Context, provider providers.BackupProvider, stagingDir, localPath, remotePath string) (providers.UploadDigest, error) {
	return UploadWithDigest(providers.WithImmutableSource(ctx), provider, stagingDir, localPath, remotePath)
}

// stagedCopyPrefix names the private copies uploadStagedCopy writes:
// "breeze-upload-<pid>-<random>", naming the process that owns the copy.
const stagedCopyPrefix = "breeze-upload-"

// staleStagingAge is how old a leftover staged copy or temporary upload file
// must be before it is removed: far beyond any upload still in progress.
const staleStagingAge = 24 * time.Hour

// stagedCopyOwner returns the process id a staged copy's name carries.
func stagedCopyOwner(name string) (int, bool) {
	rest, ok := strings.CutPrefix(name, stagedCopyPrefix)
	if !ok {
		return 0, false
	}
	pidText, _, found := strings.Cut(rest, "-")
	if !found {
		return 0, false
	}
	pid, err := strconv.Atoi(pidText)
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, true
}

// sweepStaleStagedCopies removes staged upload copies left behind when a
// helper process stopped mid-upload, from dir ("" = the OS temp dir). A copy
// whose owning process is still running is never removed, whatever its age
// (its upload may still be reading it); one whose owner has exited is removed
// once older than olderThan; one whose name carries no owner is removed only
// once older than the checkpoint journal's maximum age. Only files named like
// a staged copy are touched.
func sweepStaleStagedCopies(dir string, olderThan time.Duration) int {
	if dir == "" {
		dir = os.TempDir()
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	now := time.Now()
	removed := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), stagedCopyPrefix) {
			continue
		}
		minAge := journalMaxAge
		if pid, ok := stagedCopyOwner(e.Name()); ok {
			if processAlive(pid) {
				continue
			}
			minAge = olderThan
		}
		info, err := e.Info()
		if err != nil || !info.ModTime().Before(now.Add(-minAge)) {
			continue
		}
		if os.Remove(filepath.Join(dir, e.Name())) == nil {
			removed++
		}
	}
	if removed > 0 {
		log.Info("removed stale staged upload copies", "dir", dir, "count", removed)
	}
	return removed
}

// SweepStaleStagedCopies is sweepStaleStagedCopies for the helper's other
// backup commands, with the standard age.
func SweepStaleStagedCopies(dir string) int {
	return sweepStaleStagedCopies(dir, staleStagingAge)
}

// uploadStagedCopy copies localPath into a private staged file while hashing
// it, uploads the staged file, and removes it. The digest describes the
// staged bytes, which nothing else writes, so it is exactly what was sent.
func uploadStagedCopy(ctx context.Context, provider providers.BackupProvider, stagingDir, localPath, remotePath string) (providers.UploadDigest, error) {
	stagedPath, d, err := stageCopy(ctx, stagingDir, localPath)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return providers.UploadDigest{}, errBackupStopped
		}
		return providers.UploadDigest{}, err
	}
	// Best-effort: a staged copy left behind is clutter in a private temp
	// file, not a correctness problem.
	defer func() { _ = os.Remove(stagedPath) }()
	if err := uploadSnapshotFile(ctx, provider, stagedPath, remotePath); err != nil {
		return providers.UploadDigest{}, err
	}
	return d, nil
}

// stageCopy copies src into a new 0600 temp file under dir, hashing the bytes
// it writes. The source's open/read errors are returned wrapped (%w), so the
// caller's upload-failure classification still sees the underlying error.
func stageCopy(ctx context.Context, dir, src string) (string, providers.UploadDigest, error) {
	in, err := os.Open(src)
	if err != nil {
		return "", providers.UploadDigest{}, fmt.Errorf("failed to open source file: %w", err)
	}
	defer func() { _ = in.Close() }()
	out, err := os.CreateTemp(dir, stagedCopyPrefix+strconv.Itoa(os.Getpid())+"-*")
	if err != nil {
		return "", providers.UploadDigest{}, fmt.Errorf("failed to create staged upload copy: %w", err)
	}
	stagedPath := out.Name()
	h := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(out, h), &ctxReader{ctx: ctx, r: in})
	closeErr := out.Close()
	if copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		_ = os.Remove(stagedPath)
		return "", providers.UploadDigest{}, fmt.Errorf("failed to stage source file for upload: %w", copyErr)
	}
	return stagedPath, providers.UploadDigest{SHA256: hex.EncodeToString(h.Sum(nil)), Size: n}, nil
}

// ctxReader stops a copy between reads once ctx is done.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c *ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// digestBytes returns the SHA-256 and length of b.
func digestBytes(b []byte) providers.UploadDigest {
	sum := sha256.Sum256(b)
	return providers.UploadDigest{SHA256: hex.EncodeToString(sum[:]), Size: int64(len(b))}
}

// digestLocalFile returns the SHA-256 and length of a local file.
func digestLocalFile(path string) (providers.UploadDigest, error) {
	f, err := os.Open(path)
	if err != nil {
		return providers.UploadDigest{}, err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return providers.UploadDigest{}, err
	}
	return providers.UploadDigest{SHA256: hex.EncodeToString(h.Sum(nil)), Size: n}, nil
}

// controlRecorder remembers the control objects (manifest, layout manifest,
// system-state manifest) a run publishes, and checkpoints each one to the
// run's journal before its upload starts. A later run that finds the object
// already in storage can then tell whether the stored bytes are the ones this
// run was publishing (see resumeAttestation).
type controlRecorder struct {
	journal *snapshotJournal
	objects map[string]PublishedObject
}

func newControlRecorder(journal *snapshotJournal) *controlRecorder {
	return &controlRecorder{journal: journal, objects: map[string]PublishedObject{}}
}

// publishControlObject uploads the control object at localPath (a temp file
// the caller just wrote and nothing else touches) as role's key, and records
// it. The recorded digest is the upload's; it must equal the file's own.
func publishControlObject(ctx context.Context, provider providers.BackupProvider, stagingDir string, rec *controlRecorder, role, snapshotID, localPath string) (PublishedObject, error) {
	key, err := ControlObjectKey(snapshotID, role)
	if err != nil {
		return PublishedObject{}, err
	}
	local, err := digestLocalFile(localPath)
	if err != nil {
		return PublishedObject{}, fmt.Errorf("digest %s before upload: %w", key, err)
	}
	intended := PublishedObject{Role: role, Key: key, SHA256: local.SHA256, Size: local.Size}
	if rec != nil && rec.journal != nil {
		// Best effort, like every journal write: a failed checkpoint only
		// costs the attestation of a later resumed run.
		_ = rec.journal.RecordPublishedObject(intended)
	}
	d, err := uploadWithDeadline(ctx, provider, stagingDir, localPath, key, local.Size)
	if err != nil {
		return PublishedObject{}, err
	}
	if d.SHA256 != local.SHA256 || d.Size != local.Size {
		return PublishedObject{}, fmt.Errorf("control object %s changed while it was uploaded", key)
	}
	if rec != nil {
		rec.objects[role] = intended
	}
	return intended, nil
}
