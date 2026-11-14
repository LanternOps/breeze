//go:build !windows

package tools

// isVolumeMountPoint: a filesystem mounted at a folder is an ordinary
// directory here, so no root needs this treatment.
func isVolumeMountPoint(string) bool { return false }
