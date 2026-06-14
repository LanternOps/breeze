//go:build !windows

package collectors

// enrichOSInfo is a no-op on non-Windows platforms; gopsutil already reports a
// clean, separated OS version and build there (see normalizeOSVersionBuild).
func enrichOSInfo(info *SystemInfo) {}
