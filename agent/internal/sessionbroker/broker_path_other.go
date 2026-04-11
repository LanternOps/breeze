//go:build !windows

package sessionbroker

// normalizeBinaryPath is a no-op on non-Windows platforms. Unix paths are
// already canonical after filepath.EvalSymlinks + filepath.Clean.
func normalizeBinaryPath(path string) string {
	return path
}
