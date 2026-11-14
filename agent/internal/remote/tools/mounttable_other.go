//go:build !linux && !darwin

package tools

// readMountTable: not read on this platform; scans fall back to comparing
// devices (Unix) or anchor by drive letter (Windows).
func readMountTable() ([]string, bool) { return nil, false }
