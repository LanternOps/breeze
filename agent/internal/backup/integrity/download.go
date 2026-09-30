package integrity

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// VaultCopyDiffersWarning is the result warning when a vault copy failed its
// checks and the object was read from primary storage instead.
func VaultCopyDiffersWarning(key string) string {
	return fmt.Sprintf("vault copy differs from backup; restored from primary storage: %s", key)
}

// StagingPrefix names every staging file this package creates, so a restore
// that is interrupted leaves recognisable leftovers.
const StagingPrefix = ".breeze-staging-"

// Downloader fetches key from p into dest. Callers with their own transfer
// policy (per-file deadlines, stall detection) pass it to the Via functions
// so every attempt, including a re-read from primary storage, uses it.
type Downloader func(ctx context.Context, p providers.BackupProvider, key, dest string) error

// DefaultDownloader uses the provider's cancellable download when it has one.
func DefaultDownloader(ctx context.Context, p providers.BackupProvider, key, dest string) error {
	if cd, ok := p.(providers.ContextDownloader); ok {
		return cd.DownloadContext(ctx, key, dest)
	}
	return p.Download(key, dest)
}

// laterSources is a provider view of a SourceSkipper that reads from every
// source after the first: primary storage behind a vault copy.
type laterSources struct {
	providers.BackupProvider
	skipper providers.SourceSkipper
}

func (l laterSources) Download(key, dest string) error {
	return l.skipper.DownloadSkipping(context.Background(), key, dest, 1)
}

func (l laterSources) DownloadContext(ctx context.Context, key, dest string) error {
	return l.skipper.DownloadSkipping(ctx, key, dest, 1)
}

// primaryBehindVault returns the view of p that skips its first source, or
// false when p serves from one source only.
func primaryBehindVault(p providers.BackupProvider) (providers.BackupProvider, bool) {
	skipper, ok := p.(providers.SourceSkipper)
	if !ok || skipper.SourceCount() < 2 {
		return nil, false
	}
	return laterSources{BackupProvider: p, skipper: skipper}, true
}

// DownloadChecked downloads key into dest and runs CheckStoredBytes on it.
// With an expectation present and a provider that reads from several sources
// (a vault copy first), a copy that fails a content check is replaced once by
// the same object read from the next source, and a warning says so. dest is
// left holding the last attempt's bytes; the caller removes it on error.
func DownloadChecked(ctx context.Context, p providers.BackupProvider, key, dest string, want Stored, e *Expectation) (CheckResult, []string, error) {
	return DownloadCheckedVia(ctx, DefaultDownloader, p, key, dest, want, e)
}

// DownloadCheckedVia is DownloadChecked with a caller-supplied Downloader.
func DownloadCheckedVia(ctx context.Context, dl Downloader, p providers.BackupProvider, key, dest string, want Stored, e *Expectation) (CheckResult, []string, error) {
	return downloadAndCheck(ctx, dl, p, key, dest, e, func(path string) (CheckResult, error) {
		return CheckStoredBytes(path, want, e)
	})
}

// downloadAndCheck runs one download + check, and with an expectation
// present re-reads from primary storage once when a vault copy fails a
// content check.
func downloadAndCheck(ctx context.Context, dl Downloader, p providers.BackupProvider, key, dest string, e *Expectation, check func(string) (CheckResult, error)) (CheckResult, []string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if dl == nil {
		dl = DefaultDownloader
	}
	if err := dl(ctx, p, key, dest); err != nil {
		return CheckResult{}, nil, err
	}
	res, err := check(dest)
	if err == nil || !e.Present() || !Retryable(err) {
		return res, nil, err
	}
	primary, ok := primaryBehindVault(p)
	if !ok {
		return res, nil, err
	}
	if dlErr := dl(ctx, primary, key, dest); dlErr != nil {
		return CheckResult{}, nil, fmt.Errorf("%w; reading primary storage instead also failed: %v", err, dlErr)
	}
	res, err = check(dest)
	if err != nil {
		return CheckResult{}, nil, err
	}
	return res, []string{VaultCopyDiffersWarning(key)}, nil
}

// CheckControlObjectFile checks a downloaded control object against the
// expectation: in attested mode key must be the attested key for role and the
// file's size and SHA-256 must match; a role the expectation does not carry
// fails with ErrObjectNotAttested. Outside attested mode it checks nothing.
func CheckControlObjectFile(e *Expectation, role, key, path string) error {
	if !e.Attested() {
		return nil
	}
	obj, ok := e.Object(role)
	if !ok {
		return fmt.Errorf("%w: %s", ErrObjectNotAttested, role)
	}
	if key != obj.Key {
		return fmt.Errorf("%w: control object key %q is not the attested key %q", ErrIntegrityMismatch, key, obj.Key)
	}
	_, err := CheckStoredBytes(path, Stored{Size: obj.Size, SHA256: obj.SHA256}, e)
	return err
}

// DownloadVerifiedControlObject downloads a snapshot control object to a
// private temporary file under workDir and returns its path; the caller
// removes it.
//
// In attested mode key must be the attested object's key for role, and the
// bytes must match its size and SHA-256 before the caller parses any of them;
// a role the expectation does not carry fails with ErrObjectNotAttested.
// Outside attested mode the object is downloaded unchecked, as before.
func DownloadVerifiedControlObject(ctx context.Context, p providers.BackupProvider, e *Expectation, role, key, workDir string) (string, []string, error) {
	return DownloadVerifiedControlObjectVia(ctx, DefaultDownloader, p, e, role, key, workDir)
}

// DownloadVerifiedControlObjectVia is DownloadVerifiedControlObject with a
// caller-supplied Downloader.
func DownloadVerifiedControlObjectVia(ctx context.Context, dl Downloader, p providers.BackupProvider, e *Expectation, role, key, workDir string) (string, []string, error) {
	if e.Attested() {
		// Refuse before any transfer when the request itself cannot pass.
		obj, ok := e.Object(role)
		if !ok {
			return "", nil, fmt.Errorf("%w: %s", ErrObjectNotAttested, role)
		}
		if key != obj.Key {
			return "", nil, fmt.Errorf("%w: control object key %q is not the attested key %q", ErrIntegrityMismatch, key, obj.Key)
		}
	}
	tmp, err := os.CreateTemp(workDir, "control-object-*")
	if err != nil {
		return "", nil, fmt.Errorf("create temporary file for %s: %w", role, err)
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()

	_, warnings, err := downloadAndCheck(ctx, dl, p, key, tmpPath, e, func(path string) (CheckResult, error) {
		return CheckResult{}, CheckControlObjectFile(e, role, key, path)
	})
	if err != nil {
		_ = os.Remove(tmpPath)
		if e.Attested() {
			return "", nil, fmt.Errorf("%s %s: %w", role, key, err)
		}
		return "", nil, err
	}
	return tmpPath, warnings, nil
}

// FetchControlObject is DownloadVerifiedControlObject returning the bytes.
func FetchControlObject(ctx context.Context, p providers.BackupProvider, e *Expectation, role, key, workDir string) ([]byte, []string, error) {
	tmpPath, warnings, err := DownloadVerifiedControlObject(ctx, p, e, role, key, workDir)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = os.Remove(tmpPath) }()
	data, err := os.ReadFile(tmpPath)
	if err != nil {
		return nil, nil, fmt.Errorf("read %s: %w", role, err)
	}
	return data, warnings, nil
}

// StageAndPublish downloads key into a staging file beside finalPath (same
// directory, so the same volume), checks it with CheckStoredBytes and only
// then renames it onto finalPath. On any failure the staging file is removed
// and finalPath is left as it was. Never downloads into finalPath itself.
func StageAndPublish(ctx context.Context, p providers.BackupProvider, key, finalPath string, want Stored, e *Expectation) (CheckResult, []string, error) {
	staging, err := StagingPath(filepath.Dir(finalPath))
	if err != nil {
		return CheckResult{}, nil, err
	}
	res, warnings, err := DownloadChecked(ctx, p, key, staging, want, e)
	if err != nil {
		_ = os.Remove(staging)
		return CheckResult{}, nil, err
	}
	if err := os.Rename(staging, finalPath); err != nil {
		_ = os.Remove(staging)
		return CheckResult{}, nil, fmt.Errorf("publish restored object: %w", err)
	}
	return res, warnings, nil
}

// StagingPath returns a new, unused staging file name in dir (the file is
// not created).
func StagingPath(dir string) (string, error) {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("staging name: %w", err)
	}
	return filepath.Join(dir, StagingPrefix+hex.EncodeToString(b[:])), nil
}
