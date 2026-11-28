//go:build unix

package patching

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

// maxRecordBytes bounds the read: a real record is well under a kilobyte.
const maxRecordBytes = 64 << 10

// readTrustedRecordFile reads a pending-restart record only if no other
// account could have written, replaced or removed it. The agent runs as root
// and writes the record 0600 inside its 0700 data dir.
//
// The directory and then the file are each opened once without following a
// link (the file relative to the directory's descriptor), and every check
// runs on those descriptors before the read, so neither a linked directory
// nor a link or a swapped file can slip in between the check and the read.
// The directory must be owned by the agent and writable by nobody else
// (neither group nor others): anyone who could write it could swap or delete
// the record, which would let a local user schedule, or cancel, a restart. A
// refusal is an *untrustedRecordError.
func readTrustedRecordFile(path string) ([]byte, error) {
	dirPath := filepath.Dir(path)
	dirFd, err := unix.Open(dirPath, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil, os.ErrNotExist
		}
		if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
			return nil, &untrustedRecordError{fmt.Errorf("directory %s is a link or not a directory", dirPath)}
		}
		return nil, &os.PathError{Op: "open", Path: dirPath, Err: err}
	}
	dirFile := os.NewFile(uintptr(dirFd), dirPath)
	defer func() { _ = dirFile.Close() }()
	dir, err := dirFile.Stat()
	if err != nil {
		return nil, err
	}
	if !dir.IsDir() {
		return nil, &untrustedRecordError{fmt.Errorf("directory %s is not a directory", dirPath)}
	}
	if err := ownedAndPrivate(dir); err != nil {
		return nil, &untrustedRecordError{fmt.Errorf("directory %s: %w", dirPath, err)}
	}

	fd, err := unix.Openat(dirFd, filepath.Base(path), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil, os.ErrNotExist
		}
		if errors.Is(err, unix.ELOOP) {
			return nil, &untrustedRecordError{errors.New("the record is a link")}
		}
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	f := os.NewFile(uintptr(fd), path)
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, &untrustedRecordError{fmt.Errorf("not a regular file (mode %s)", info.Mode())}
	}
	if err := ownedAndPrivate(info); err != nil {
		return nil, &untrustedRecordError{fmt.Errorf("record: %w", err)}
	}
	data, err := io.ReadAll(io.LimitReader(f, maxRecordBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxRecordBytes {
		return nil, &untrustedRecordError{errors.New("the record is implausibly large")}
	}
	return data, nil
}

// ownedAndPrivate requires info to be owned by this process's user and not
// writable by group or others.
func ownedAndPrivate(info os.FileInfo) error {
	if perm := info.Mode().Perm(); perm&0o022 != 0 {
		return fmt.Errorf("writable by other accounts (mode %o)", perm)
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("owner unavailable")
	}
	if euid := os.Geteuid(); int(st.Uid) != euid {
		return fmt.Errorf("owned by uid %d, not %d", st.Uid, euid)
	}
	return nil
}
