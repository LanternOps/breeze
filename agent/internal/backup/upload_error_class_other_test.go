//go:build !windows

package backup

import (
	"fmt"
	"io/fs"
	"syscall"
	"testing"
)

// The Win32 codes in windowsUploadErrnos are numerically identical to unrelated
// POSIX errnos, and applying that table off Windows would silently drop files
// from backups on macOS and Linux hosts. upload_error_class_other.go exists
// solely to prevent that, and it is a no-op body — the kind of code that looks
// deletable, or that someone "unifies" cross-platform while tidying up.
//
// This test is the tripwire for that refactor. Each of these errnos, wrapped as
// a SOURCE-attributed *fs.PathError (so it clears the source-attribution guard
// and reaches the platform lookup), must keep its full retry:
//
//	 5  EIO   on Unix / ERROR_ACCESS_DENIED   on Windows -> would become retryAfterShortDelay
//	32  EPIPE on Unix / ERROR_SHARING_VIOLATION         -> would become skipWithoutRetry
//	33  EDOM  on Unix / ERROR_LOCK_VIOLATION            -> would become skipWithoutRetry
//	 2  ENOENT is deliberately absent: it is genuinely permanent on both
//	    platforms and is handled by the PORTABLE fs.ErrNotExist branch, so it
//	    is not evidence of the table leaking.
//
// A skipWithoutRetry verdict here would mean an ordinary I/O error on a Unix
// agent silently drops the file from the backup with no retry at all.
func TestClassifyUploadFailure_Win32CodesAreNeverAppliedToUnixErrnos(t *testing.T) {
	const src = "/home/u/Documents/report.odt"

	tests := []struct {
		name  string
		errno syscall.Errno
	}{
		{name: "EIO (5) collides with ERROR_ACCESS_DENIED", errno: syscall.EIO},
		{name: "EPIPE (32) collides with ERROR_SHARING_VIOLATION", errno: syscall.EPIPE},
		{name: "EDOM (33) collides with ERROR_LOCK_VIOLATION", errno: syscall.EDOM},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := fmt.Errorf("failed to open source file: %w",
				&fs.PathError{Op: "open", Path: src, Err: tc.errno})

			policy, reason := classifyUploadFailure(err, src)
			if policy != retryAfterDefaultDelay {
				t.Fatalf("errno %d (%v) classified as %v (reason %q) off Windows — the Win32 table is leaking onto POSIX errnos; see upload_error_class_other.go",
					uintptr(tc.errno), tc.errno, policy, reason)
			}
		})
	}
}

// The platform hook itself must stay inert off Windows, whatever it is handed.
func TestWindowsUploadErrnoPolicy_IsANoOpOffWindows(t *testing.T) {
	for _, errno := range []syscall.Errno{syscall.EIO, syscall.EPIPE, syscall.EDOM, syscall.EACCES} {
		name, policy, ok := windowsUploadErrnoPolicy(errno)
		if ok {
			t.Fatalf("windowsUploadErrnoPolicy(%v) matched off Windows as %q/%v; it must never consult the Win32 table here",
				errno, name, policy)
		}
		if policy != retryAfterDefaultDelay {
			t.Fatalf("windowsUploadErrnoPolicy(%v) returned %v, want the conservative retryAfterDefaultDelay", errno, policy)
		}
	}
}
