//go:build windows

package backup

import (
	"errors"
	"syscall"
)

// permanentUploadErrno matches the Win32 code carried by a failed source-file
// read/open against permanentWindowsErrnos. Callers pass the *fs.PathError's
// Err (see classifyPermanentUploadError), which is normally a syscall.Errno
// directly; errors.As is used rather than a type assertion so a provider that
// wraps it further still classifies.
func permanentUploadErrno(err error) (string, bool) {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return "", false
	}
	return lookupPermanentWindowsErrno(uintptr(errno))
}
