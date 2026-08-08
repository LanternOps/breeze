//go:build !windows

package backup

// windowsUploadErrnoPolicy is a deliberate no-op off Windows.
//
// The codes in windowsUploadErrnos are Win32 values and collide with unrelated
// POSIX errnos — 5 is EIO, 32 is EPIPE and 33 is EDOM on Linux/darwin, all of
// which are ordinary I/O failures that must keep their full retry. Matching the
// Win32 table against a Unix syscall.Errno would silently drop files from
// backups on macOS and Linux hosts, so it is never attempted here.
//
// Unix permanence and Unix permission denials are covered instead by the
// portable fs.ErrNotExist / fs.ErrPermission branches in classifyUploadFailure;
// the lock/sharing/cloud-placeholder failure modes are Windows-only by nature.
func windowsUploadErrnoPolicy(error) (string, uploadRetryPolicy, bool) {
	return "", retryAfterDefaultDelay, false
}
