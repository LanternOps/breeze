//go:build !windows

package security

import (
	"errors"
	"os"
	"syscall"
)

// isPerFileError reports an error the system returns for one file that the
// scan may not read: permission denied, or a busy or locked file.
func isPerFileError(err error) bool {
	return os.IsPermission(err) || errors.Is(err, syscall.EBUSY) || errors.Is(err, syscall.ETXTBSY) || errors.Is(err, syscall.EAGAIN)
}
