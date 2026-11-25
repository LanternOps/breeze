//go:build !windows

package backup

// unreachableVolume reports a stat error saying the volume itself cannot be
// reached. POSIX reports an absent mount as not-exist, which the caller
// already treats as absent, so there is nothing to add here.
func unreachableVolume(error) bool { return false }
