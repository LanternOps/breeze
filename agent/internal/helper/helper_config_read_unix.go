//go:build !windows

package helper

import (
	"os"
	"syscall"
)

// openNoFollow opens path read-only and refuses a symlink in the final path
// component (ELOOP), so a session user cannot redirect a root-run read.
// O_NONBLOCK makes opening a FIFO return immediately instead of blocking until
// a writer appears; the caller then refuses it as a non-regular file.
func openNoFollow(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
}
