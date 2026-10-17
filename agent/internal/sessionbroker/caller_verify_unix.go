//go:build !windows

package sessionbroker

// callerOwnsLoginOS is unused on Unix, where selection compares the helper's
// kernel-verified peer UID with the detected login's UID instead.
func callerOwnsLoginOS(string, string) bool { return false }
