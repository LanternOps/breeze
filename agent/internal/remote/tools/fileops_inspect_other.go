//go:build !linux && !darwin && !windows

package tools

import (
	"errors"
	"os"
	"syscall"
)

// openInspectHandle opens p without blocking and without following a link
// at the leaf.
func openInspectHandle(p string, _ bool) (*os.File, error) {
	return os.OpenFile(p, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
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
