//go:build !windows

package userhelper

// lookupSIDWithRetry is a no-op on non-Windows platforms: there's no SID on
// Unix. Callers should use the UID from user.Current() directly instead.
// Kept to satisfy cross-platform calling code without build tags at the
// call site.
func lookupSIDWithRetry() (string, error) {
	return "", nil
}
