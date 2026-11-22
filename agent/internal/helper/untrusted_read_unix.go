//go:build !windows

package helper

import (
	"os"
	"syscall"
)

// openUntrustedFile opens path read-only. O_NOFOLLOW refuses a symlink in the
// final path component (ELOOP), so a session user cannot redirect a root-run
// read. O_NONBLOCK stops the open from waiting for a writer when path is a FIFO;
// readUntrustedFile then rejects it by type. It does not change how a regular
// file reads.
func openUntrustedFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
}
