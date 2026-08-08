//go:build windows

package backup

import (
	"fmt"
	"io/fs"
	"syscall"
	"testing"

	"golang.org/x/sys/windows"
)

// The Win32 codes are declared as plain numbers in upload_error_class.go so the
// table stays unit-testable on macOS/Linux (where golang.org/x/sys/windows does
// not build). This test is the other half of that trade: on Windows it pins
// each literal to the real constant, so a typo in the table cannot go unnoticed
// forever.
func TestWindowsUploadErrnoConstantsMatchWin32(t *testing.T) {
	tests := []struct {
		name string
		got  uintptr
		want windows.Errno
	}{
		{"ERROR_FILE_NOT_FOUND", winErrFileNotFound, windows.ERROR_FILE_NOT_FOUND},
		{"ERROR_PATH_NOT_FOUND", winErrPathNotFound, windows.ERROR_PATH_NOT_FOUND},
		{"ERROR_ACCESS_DENIED", winErrAccessDenied, windows.ERROR_ACCESS_DENIED},
		{"ERROR_SHARING_VIOLATION", winErrSharingViolation, windows.ERROR_SHARING_VIOLATION},
		{"ERROR_LOCK_VIOLATION", winErrLockViolation, windows.ERROR_LOCK_VIOLATION},
		{"ERROR_CLOUD_FILE_ACCESS_DENIED", winErrCloudFileAccessDenied, windows.ERROR_CLOUD_FILE_ACCESS_DENIED},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.got != uintptr(tc.want) {
				t.Fatalf("%s = %d, want %d", tc.name, tc.got, uintptr(tc.want))
			}
		})
	}
}

// A real Windows errno must reach the classifier through the *fs.PathError +
// %w wrapping the upload path applies, and come out with the right policy.
// Windows-only because syscall.Errno values are platform-specific.
func TestClassifyUploadFailure_RealWindowsErrno(t *testing.T) {
	const src = `C:\Users\u\AppData\Local\Google\Chrome\User Data\Default\Cache\Cache_Data\f_00a1`
	for _, tc := range []struct {
		name       string
		errno      windows.Errno
		wantPolicy uploadRetryPolicy
	}{
		{"ERROR_SHARING_VIOLATION", windows.ERROR_SHARING_VIOLATION, skipWithoutRetry},
		{"ERROR_LOCK_VIOLATION", windows.ERROR_LOCK_VIOLATION, skipWithoutRetry},
		{"ERROR_CLOUD_FILE_ACCESS_DENIED", windows.ERROR_CLOUD_FILE_ACCESS_DENIED, skipWithoutRetry},
		// #3259. Note the ordering guarantee this asserts: Go maps BOTH
		// ERROR_ACCESS_DENIED and ERROR_SHARING_VIOLATION onto fs.ErrPermission,
		// so the Win32 table must be consulted before the portable
		// fs.ErrPermission branch — otherwise a sharing violation would
		// downgrade from skipWithoutRetry to retryAfterShortDelay and start
		// paying a backoff again. The ERROR_SHARING_VIOLATION row above is what
		// catches that regression.
		{"ERROR_ACCESS_DENIED", windows.ERROR_ACCESS_DENIED, retryAfterShortDelay},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := fmt.Errorf("failed to compress file: %w", &fs.PathError{
				Op:   "read",
				Path: src,
				Err:  syscall.Errno(tc.errno),
			})
			policy, name := classifyUploadFailure(err, src)
			if policy != tc.wantPolicy {
				t.Fatalf("classifyUploadFailure(%s) policy = %v, want %v", tc.name, policy, tc.wantPolicy)
			}
			if name != tc.name {
				t.Fatalf("reason = %q, want %q", name, tc.name)
			}
		})
	}
}
