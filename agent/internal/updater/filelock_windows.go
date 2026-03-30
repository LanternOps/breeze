//go:build windows

package updater

import (
	"errors"
	"syscall"
)

// isFileLocked returns true if the error indicates the file is locked by
// another process (ERROR_SHARING_VIOLATION or ERROR_LOCK_VIOLATION).
func isFileLocked(err error) bool {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return errno == 32 || errno == 33 // ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
	}
	return false
}
