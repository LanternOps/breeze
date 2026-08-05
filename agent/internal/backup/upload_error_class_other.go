//go:build !windows

package backup

// permanentUploadErrno is a deliberate no-op off Windows.
//
// The codes in permanentWindowsErrnos are Win32 values and collide with
// unrelated POSIX errnos — 32 is EPIPE and 33 is EDOM on Linux/darwin, both of
// which are ordinary I/O failures that must keep their retry. Matching the
// Win32 table against a Unix syscall.Errno would silently drop files from
// backups on macOS and Linux hosts, so it is never attempted here.
//
// Unix permanence is covered by the portable fs.ErrNotExist branch in
// classifyPermanentUploadError; the lock/sharing/cloud-placeholder failure
// modes this fix targets are Windows-only by nature.
func permanentUploadErrno(error) (string, bool) { return "", false }
