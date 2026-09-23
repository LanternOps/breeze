//go:build !windows && !darwin

package helper

// readBinaryVersion is unsupported off Windows/macOS: the Linux helper binary
// carries no version metadata, so callers fall back to the status file.
func readBinaryVersion(string) (string, error) {
	return "", errBinaryVersionUnsupported
}
