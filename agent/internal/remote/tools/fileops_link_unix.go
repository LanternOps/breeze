//go:build !windows

package tools

import "os"

// isReparsePoint is Windows-only. On POSIX, os.ModeSymlink already covers every
// link the cleanup path can meet, and DeleteFile checks that separately.
func isReparsePoint(_ os.FileInfo) bool {
	return false
}

// isSharingViolation is Windows-only. POSIX unlink succeeds on an open file, so
// there is no "locked file" condition to report — and reporting a permission
// error as a lock would tell an operator to close an application that has
// nothing to do with the failure.
func isSharingViolation(_ error) bool {
	return false
}
