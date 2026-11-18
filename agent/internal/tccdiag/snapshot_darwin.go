//go:build darwin && cgo

package tccdiag

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// TCC.db is a WAL-mode database, and SQLite cannot read one in place without
// writing beside it: a read-only connection fails with SQLITE_CANTOPEN when
// the -wal is absent (tccd not holding the database open), creates the -shm
// when only that is absent, and writes reader marks into a live -shm. The
// reader therefore copies the database and its journals into a private
// temporary directory and opens the copy, so the TCC directory is only ever
// read.

// snapshotFiles are the database (suffix "") and the journals SQLite reads
// beside it. The -shm is not copied: SQLite rebuilds it from the -wal when
// the copy is opened.
var snapshotFiles = [...]string{"", "-wal", "-journal"}

// snapshotAttempts bounds the retries when tccd writes during the copy.
const snapshotAttempts = 3

// snapshotDatabase copies path and its -wal and -journal into a new 0700
// directory. The caller must call cleanup, which removes the copy, whenever
// it is non-nil. A copy whose sources changed while being read is discarded
// and retried, so the copy is one consistent version of the database.
func snapshotDatabase(path string) (copyPath string, cleanup func(), err error) {
	dir, err := os.MkdirTemp("", "breeze-tccdiag-")
	if err != nil {
		return "", nil, fmt.Errorf("snapshot directory: %w", err)
	}
	cleanup = func() { _ = os.RemoveAll(dir) }
	copyPath = filepath.Join(dir, filepath.Base(path))

	for attempt := 0; attempt < snapshotAttempts; attempt++ {
		before, err := sourceState(path)
		if err != nil {
			cleanup()
			return "", nil, err
		}
		if err := copySources(path, copyPath, before); err != nil {
			cleanup()
			return "", nil, err
		}
		after, err := sourceState(path)
		if err != nil {
			cleanup()
			return "", nil, err
		}
		if before == after {
			return copyPath, cleanup, nil
		}
		for _, suffix := range snapshotFiles {
			_ = os.Remove(copyPath + suffix)
		}
	}
	cleanup()
	return "", nil, fmt.Errorf("snapshot %s: the database changed during each of %d copies", path, snapshotAttempts)
}

type fileState struct {
	exists bool
	size   int64
	mtime  time.Time
}

// sourceStates is the state of each of snapshotFiles.
type sourceStates [len(snapshotFiles)]fileState

func sourceState(path string) (sourceStates, error) {
	var out sourceStates
	for i, suffix := range snapshotFiles {
		info, err := os.Stat(path + suffix)
		switch {
		case err == nil:
			out[i] = fileState{exists: true, size: info.Size(), mtime: info.ModTime()}
		case suffix != "" && errors.Is(err, os.ErrNotExist):
			// A missing sidecar is normal; a missing database is an error.
		default:
			return out, sourceError(err)
		}
	}
	return out, nil
}

func copySources(path, copyPath string, state sourceStates) error {
	for i, suffix := range snapshotFiles {
		if !state[i].exists {
			continue
		}
		err := copyFile(path+suffix, copyPath+suffix)
		if suffix != "" && errors.Is(err, os.ErrNotExist) {
			continue // removed since the stat; the state check catches it
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return sourceError(err)
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("snapshot copy: %w", err)
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return fmt.Errorf("snapshot copy %s: %w", src, err)
	}
	if err := out.Close(); err != nil {
		return fmt.Errorf("snapshot copy: %w", err)
	}
	return nil
}

// sourceError maps the OS refusing a TCC file (EPERM without Full Disk
// Access, or EACCES) to ErrNotReadable; every other error passes through.
func sourceError(err error) error {
	if errors.Is(err, os.ErrPermission) {
		return ErrNotReadable
	}
	return err
}
