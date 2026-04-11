//go:build windows

package sessionbroker

import (
	"strings"

	"golang.org/x/sys/windows"
)

// normalizeBinaryPath converts a Windows file path into a canonical form
// suitable for equality comparison. It expands 8.3 short names via
// GetLongPathNameW and lowercases the result. On failure it falls back to
// a plain lowercased string so the comparison can still succeed for
// already-long paths.
//
// Windows cross-session process spawning (CreateProcessAsUser) can report
// process paths with mixed case or short-name components, which makes naive
// string equality fail even when the underlying file is identical.
func normalizeBinaryPath(path string) string {
	if path == "" {
		return ""
	}
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return strings.ToLower(path)
	}
	// Probe for required length.
	n, err := windows.GetLongPathName(ptr, nil, 0)
	if err != nil || n == 0 {
		return strings.ToLower(path)
	}
	buf := make([]uint16, n)
	n, err = windows.GetLongPathName(ptr, &buf[0], n)
	if err != nil || n == 0 {
		return strings.ToLower(path)
	}
	return strings.ToLower(windows.UTF16ToString(buf[:n]))
}
