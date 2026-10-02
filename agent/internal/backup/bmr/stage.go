package bmr

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// attestedStager restores the content entries of an attested recovery. Each
// object is written into a staging file this helper creates itself beside
// the target (same directory, so the same volume), checked exactly against
// its manifest entry, given the target's ownership, permissions and times
// through the open handle, and only then renamed over the target.
//
// The staging file is created exclusively (O_EXCL; never through a link)
// and private from the first byte: mode 0600 on Unix, a protected DACL
// granting SYSTEM and Administrators only on Windows. The provider then
// downloads into that same path: every provider opens its destination with
// os.Create, which opens and truncates an existing file (on Windows,
// OPEN_ALWAYS followed by a truncate), so the file keeps the mode and
// security descriptor it was created with. After every download attempt,
// before the check, and after the rename, the path is confirmed to still be
// the file behind the handle, so a staging file replaced in between is
// never checked or reported as restored.
//
// Downloading straight into the staging path (rather than into a private
// temporary file elsewhere and copying) needs no second copy of the object
// on another volume — which during an offline recovery may be a small RAM
// disk — and no second pass over the bytes.
type attestedStager struct {
	provider providers.BackupProvider
	e        *integrity.Expectation
	swept    map[string]bool
}

func newAttestedStager(provider providers.BackupProvider, e *integrity.Expectation) *attestedStager {
	return &attestedStager{provider: provider, e: e, swept: map[string]bool{}}
}

// errStagingReplaced reports that the staging path no longer names the file
// this helper created.
var errStagingReplaced = errors.New("staging file was replaced during the restore")

// restore stages, checks and publishes one attested manifest entry. warnings
// are result warnings from the download (a vault copy that had to be re-read
// from primary storage); fidelity lists ownership/permission/time/security
// descriptor steps that could not be applied — the object itself was still
// published. On error the target is left as it was and no staging file
// remains.
func (s *attestedStager) restore(ctx context.Context, file manifestFile, targetPath string) (warnings, fidelity []string, err error) {
	dir := filepath.Dir(targetPath)
	s.sweep(dir)

	stagingPath, err := integrity.StagingPath(dir)
	if err != nil {
		return nil, nil, err
	}
	f, err := createStagingFile(stagingPath)
	if err != nil {
		return nil, nil, fmt.Errorf("create staging file: %w", err)
	}
	published := false
	defer func() {
		_ = f.Close()
		if !published {
			if rmErr := os.Remove(stagingPath); rmErr != nil && !errors.Is(rmErr, os.ErrNotExist) {
				slog.Warn("bmr: could not remove staging file", "path", stagingPath, "error", rmErr.Error())
			}
		}
	}()

	dl := func(ctx context.Context, p providers.BackupProvider, key, dest string) error {
		if err := integrity.DefaultDownloader(ctx, p, key, dest); err != nil {
			return err
		}
		return sameFileAsHandle(f, dest)
	}
	want := integrity.Stored{Size: file.Size, SHA256: file.Checksum, Volatile: file.Volatile}
	_, warnings, err = integrity.DownloadCheckedVia(ctx, dl, s.provider, file.BackupPath, stagingPath, want, s.e)
	if err != nil {
		return nil, nil, err
	}
	if err := f.Sync(); err != nil {
		return nil, nil, fmt.Errorf("flush staged object: %w", err)
	}

	fidelity = applyStagedMetadata(f, targetPath, file)

	if err := sameFileAsHandle(f, stagingPath); err != nil {
		return nil, nil, err
	}
	if err := publishStaged(stagingPath, targetPath); err != nil {
		return nil, nil, err
	}
	published = true
	if err := sameFileAsHandle(f, targetPath); err != nil {
		return nil, nil, fmt.Errorf("publish restored object: %w", err)
	}
	return warnings, fidelity, nil
}

// publishStaged renames the staged file over targetPath. An existing target
// with its read-only bit set (the Windows ReadOnly attribute) refuses to be
// replaced there; the bit is cleared and the rename tried once more — the
// same single retry the unattested path makes (D19b) — and put back if the
// rename still fails.
func publishStaged(stagingPath, targetPath string) error {
	err := os.Rename(stagingPath, targetPath)
	if err == nil {
		return nil
	}
	prior, statErr := os.Lstat(targetPath)
	restored, clearErr := clearReadOnly(targetPath)
	if clearErr != nil || !restored {
		return fmt.Errorf("publish restored object: %w", err)
	}
	slog.Debug("bmr: cleared read-only attribute on restore target before retrying", "target", targetPath)
	if err := os.Rename(stagingPath, targetPath); err != nil {
		if statErr == nil {
			_ = os.Chmod(targetPath, prior.Mode().Perm())
		}
		return fmt.Errorf("publish restored object: %w", err)
	}
	return nil
}

// sameFileAsHandle confirms path (not followed if it is a link) is the file
// behind f.
func sameFileAsHandle(f *os.File, path string) error {
	held, err := f.Stat()
	if err != nil {
		return fmt.Errorf("inspect staging file: %w", err)
	}
	named, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("%w: %v", errStagingReplaced, err)
	}
	if !os.SameFile(held, named) {
		return errStagingReplaced
	}
	return nil
}

// sweep removes staging files an interrupted earlier recovery left in dir —
// once per directory per recovery. Only regular files named with
// integrity.StagingPrefix that this process's account owns are removed;
// links, directories and anything else are left alone and never followed.
func (s *attestedStager) sweep(dir string) {
	if s.swept[dir] {
		return
	}
	s.swept[dir] = true
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, integrity.StagingPrefix) {
			continue
		}
		p := filepath.Join(dir, name)
		info, err := os.Lstat(p)
		if err != nil || !info.Mode().IsRegular() || !stagingLeftoverOwned(p, info) {
			continue
		}
		if err := os.Remove(p); err != nil {
			slog.Warn("bmr: could not remove leftover staging file", "path", p, "error", err.Error())
			continue
		}
		slog.Info("bmr: removed leftover staging file", "path", p)
	}
}
