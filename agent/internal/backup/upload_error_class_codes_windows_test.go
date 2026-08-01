//go:build windows

package backup

import (
	"fmt"
	"io/fs"
	"syscall"
	"testing"

	"golang.org/x/sys/windows"
)

// The permanent-error codes are declared as plain numbers in
// upload_error_class.go so the table stays unit-testable on macOS/Linux (where
// golang.org/x/sys/windows does not build). This test is the other half of
// that trade: on Windows it pins each literal to the real constant, so a typo
// in the table cannot go unnoticed forever.
func TestPermanentWindowsErrnoConstantsMatchWin32(t *testing.T) {
	tests := []struct {
		name string
		got  uintptr
		want windows.Errno
	}{
		{"ERROR_FILE_NOT_FOUND", winErrFileNotFound, windows.ERROR_FILE_NOT_FOUND},
		{"ERROR_PATH_NOT_FOUND", winErrPathNotFound, windows.ERROR_PATH_NOT_FOUND},
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
// %w wrapping the upload path applies. Windows-only because syscall.Errno
// values are platform-specific.
func TestClassifyPermanentUploadError_RealWindowsErrno(t *testing.T) {
	err := fmt.Errorf("failed to compress file: %w", &fs.PathError{
		Op:   "read",
		Path: `C:\Users\u\AppData\Local\Google\Chrome\User Data\Default\Cache\Cache_Data\f_00a1`,
		Err:  syscall.Errno(windows.ERROR_SHARING_VIOLATION),
	})
	name, ok := classifyPermanentUploadError(err)
	if !ok {
		t.Fatalf("want ERROR_SHARING_VIOLATION classified permanent, got transient")
	}
	if name != "ERROR_SHARING_VIOLATION" {
		t.Fatalf("reason = %q, want ERROR_SHARING_VIOLATION", name)
	}
}
