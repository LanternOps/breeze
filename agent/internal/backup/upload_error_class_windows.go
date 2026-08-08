//go:build windows

package backup

import (
	"errors"
	"syscall"
)

// windowsUploadErrnoPolicy matches the Win32 code carried by a failed
// source-file read/open against windowsUploadErrnos. Callers pass the
// *fs.PathError's Err (see classifyUploadFailure), which is normally a
// syscall.Errno directly; errors.As is used rather than a type assertion so a
// provider that wraps it further still classifies.
func windowsUploadErrnoPolicy(err error) (string, uploadRetryPolicy, bool) {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return "", retryAfterDefaultDelay, false
	}
	return lookupWindowsUploadErrno(uintptr(errno))
}
