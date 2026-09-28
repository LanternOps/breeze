package helper

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
)

// Pre-update backup of the helper binary (#7113).
//
// The rollback after a failed update renames the backup over the helper
// binary, so the backup has to be a complete copy of the build that ran before
// the update. A copy written straight to the final name and interrupted part
// way (disk full, AV, a crash) left a truncated file there that a later
// rollback restored as if it were good. The copy is now written to a scratch
// name, synced, and renamed into place, and its size and SHA-256 are recorded
// so the rollback can refuse a file that does not match.

// errBackupMismatch reports a backup whose bytes differ from the copy that was
// recorded: it is damaged or was replaced, and must not be restored.
var errBackupMismatch = errors.New("helper backup does not match the recorded copy")

// backupCopyFunc is a seam for the backup tests.
var backupCopyFunc = io.Copy

// helperBackup is a verified copy of the helper binary taken before an update.
// The zero value means no backup was taken, and verify refuses it.
type helperBackup struct {
	path   string
	size   int64
	sha256 [sha256.Size]byte
}

// backupPartialPath is where the copy is written before it is renamed into
// place. A fixed name, so an interrupted copy leaves at most one stray file and
// the next attempt overwrites it.
func backupPartialPath(backupPath string) string {
	return backupPath + ".partial"
}

// writeHelperBackup copies src to backupPath through a scratch file and returns
// the record the rollback verifies against. On failure the scratch file is
// removed and backupPath is left exactly as it was: a previous rollback that
// could not restore keeps the only good copy there.
func writeHelperBackup(src, backupPath string) (helperBackup, error) {
	in, err := os.Open(src)
	if err != nil {
		return helperBackup{}, err
	}
	defer func() { _ = in.Close() }() // read-only handle
	info, err := in.Stat()
	if err != nil {
		return helperBackup{}, err
	}

	partial := backupPartialPath(backupPath)
	out, err := os.OpenFile(partial, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0755)
	if err != nil {
		return helperBackup{}, err
	}
	hash := sha256.New()
	n, err := backupCopyFunc(io.MultiWriter(out, hash), in)
	if err == nil && n != info.Size() {
		err = fmt.Errorf("copied %d of %d bytes", n, info.Size())
	}
	if err == nil {
		err = out.Sync()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(partial, backupPath)
	}
	if err != nil {
		if rmErr := os.Remove(partial); rmErr != nil && !errors.Is(rmErr, os.ErrNotExist) {
			log.Warn("failed to remove partial helper backup", "path", partial, "error", rmErr.Error())
		}
		return helperBackup{}, err
	}

	b := helperBackup{path: backupPath, size: n}
	copy(b.sha256[:], hash.Sum(nil))
	return b, nil
}

// verify checks the backup on disk against the recorded copy. It returns an
// error wrapping os.ErrNotExist when the file is gone, errBackupMismatch when
// its size or bytes differ, and any other error when it cannot be read.
func (b helperBackup) verify() error {
	if b.path == "" {
		return fmt.Errorf("no helper backup was recorded for this update: %w", os.ErrNotExist)
	}
	f, err := os.Open(b.path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }() // read-only handle
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Size() != b.size {
		return fmt.Errorf("%w: size %d, recorded %d", errBackupMismatch, info.Size(), b.size)
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, f); err != nil {
		return err
	}
	if !bytes.Equal(hash.Sum(nil), b.sha256[:]) {
		return fmt.Errorf("%w: SHA-256 differs", errBackupMismatch)
	}
	return nil
}
