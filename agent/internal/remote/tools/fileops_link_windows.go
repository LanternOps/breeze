//go:build windows

package tools

import (
	"errors"
	"os"
	"syscall"
)

// isReparsePoint reports whether info names a reparse point (a junction, a
// mount point, or a OneDrive/cloud placeholder). Go reports a symlink through
// os.ModeSymlink, but a junction is NOT a symlink: without this check a
// contentsOnly delete of a directory containing a junction would recurse into
// the junction's target. Recursing is what we refuse to do (spec §10.4).
func isReparsePoint(info os.FileInfo) bool {
	if info == nil {
		return false
	}
	data, ok := info.Sys().(*syscall.Win32FileAttributeData)
	if !ok {
		return false
	}
	return data.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0
}

// isSharingViolation reports whether err is a Windows file-lock error:
// ERROR_SHARING_VIOLATION (32) or ERROR_LOCK_VIOLATION (33). Cleanup NEVER
// forces a locked file (spec §10.5) — it reports it as skipped_locked so the
// operator can close the application and re-run.
func isSharingViolation(err error) bool {
	if err == nil {
		return false
	}
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	return errno == syscall.Errno(32) || errno == syscall.Errno(33)
}
