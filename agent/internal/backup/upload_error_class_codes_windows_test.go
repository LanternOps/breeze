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
		// #3259. Two regressions this row and the ones above jointly catch:
		//
		//  1. The Win32 table being dropped or dead-coded. syscall.Errno.Is
		//     maps only ERROR_ACCESS_DENIED / EACCES / EPERM to
		//     fs.ErrPermission — NOT ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
		//     or ERROR_CLOUD_FILE_ACCESS_DENIED. Those three have no portable
		//     branch to fall back on, so if the table stops being consulted
		//     they silently regain the 30s backoff. The rows above are the
		//     canary for that.
		//  2. The table being consulted AFTER the portable branch. Policy
		//     would still come out right for ERROR_ACCESS_DENIED, but the
		//     reason string would degrade from the precise
		//     "ERROR_ACCESS_DENIED" to the generic "permission denied" — which
		//     is what support reads. The exact-name assertion below catches it.
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
