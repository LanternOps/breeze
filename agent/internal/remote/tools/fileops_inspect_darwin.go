//go:build darwin

package tools

import (
	"errors"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// openInspectHandle opens p for event notification only (no read access),
// without blocking, and refusing a link at any component of the path
// (O_NOFOLLOW_ANY), so the path cannot be redirected to a device after the
// type check. Callers pass paths whose links are already resolved. Systems
// without O_NOFOLLOW_ANY fall back to refusing a link at the leaf.
func openInspectHandle(p string, isDir bool) (*os.File, error) {
	flags := unix.O_EVTONLY | unix.O_NONBLOCK | unix.O_CLOEXEC
	if isDir {
		flags |= unix.O_DIRECTORY
	}
	fd, err := unix.Open(p, flags|unix.O_NOFOLLOW_ANY, 0)
	if errors.Is(err, unix.EINVAL) {
		fd, err = unix.Open(p, flags|unix.O_NOFOLLOW, 0)
	}
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: p, Err: err}
	}
	return os.NewFile(uintptr(fd), p), nil
}

// openScanFile opens a queued scan file for reading, without following a
// link at the leaf and without blocking.
func openScanFile(p string) (*os.File, error) {
	f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
	if errors.Is(err, syscall.ELOOP) {
		return nil, ErrScanSkipped
	}
	return f, err
}
