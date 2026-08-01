//go:build windows

package backup

import (
	"errors"
	"syscall"
)

// permanentUploadErrno matches the Win32 code carried by a failed source-file
// read/open against permanentWindowsErrnos. os.File operations surface as
// *fs.PathError wrapping a syscall.Errno, and the upload path wraps that with
// %w (CompressFile, attemptFileUpload), so errors.As reaches the errno through
// the whole chain.
func permanentUploadErrno(err error) (string, bool) {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return "", false
	}
	return lookupPermanentWindowsErrno(uintptr(errno))
}
