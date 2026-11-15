//go:build windows

package security

import (
	"errors"
	"os"
	"syscall"
)

// isPerFileError reports an error the system returns for one file that the
// scan may not read: access denied, a sharing or lock violation, or an
// antivirus product blocking the open (ERROR_VIRUS_INFECTED,
// ERROR_VIRUS_DELETED).
func isPerFileError(err error) bool {
	if os.IsPermission(err) {
		return true
	}
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	switch errno {
	case 5, 32, 33, 225, 226: // ACCESS_DENIED, SHARING_VIOLATION, LOCK_VIOLATION, VIRUS_INFECTED, VIRUS_DELETED
		return true
	}
	return false
}
