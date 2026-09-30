//go:build !windows

package securefs

// checkPlatformComponents is a no-op off Windows: ':' and a trailing dot or
// space are ordinary filename characters there.
func checkPlatformComponents(string) error { return nil }
