//go:build linux

package tools

import (
	"errors"
	"fmt"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// openInspectHandle opens p with O_PATH, which names the object without
// opening it: no device driver is called, whatever p turns out to be.
func openInspectHandle(p string, _ bool) (*os.File, error) {
	fd, err := unix.Open(p, unix.O_PATH|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: p, Err: err}
	}
	return os.NewFile(uintptr(fd), p), nil
}

// openScanFile opens a queued scan file for reading. It first takes an
// O_PATH handle on p (not following a link at the leaf) and checks that it
// is a regular file, then opens that same object for reading through
// /proc/self/fd, so a device swapped in along the path is never opened.
// Without /proc it falls back to a direct non-blocking open.
func openScanFile(p string) (*os.File, error) {
	fd, err := unix.Open(p, unix.O_PATH|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: p, Err: err}
	}
	defer func() { _ = unix.Close(fd) }()
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return nil, &os.PathError{Op: "fstat", Path: p, Err: err}
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return nil, ErrScanSkipped
	}
	f, err := os.OpenFile(fmt.Sprintf("/proc/self/fd/%d", fd), os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err == nil {
		return f, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	f, err = os.OpenFile(p, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
	if errors.Is(err, syscall.ELOOP) {
		return nil, ErrScanSkipped
	}
	return f, err
}
