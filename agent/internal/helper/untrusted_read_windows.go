//go:build windows

package helper

import "os"

// openUntrustedFile: syscall.O_NOFOLLOW does not exist on Windows, and creating
// a symlink there normally requires a privilege standard users lack (Developer
// Mode relaxes this), so this is a plain open. Windows has no FIFO that lives at
// a filesystem path, so the open has nothing to wait on. readUntrustedFile's
// type check and size cap still apply.
func openUntrustedFile(path string) (*os.File, error) {
	return os.Open(path)
}
