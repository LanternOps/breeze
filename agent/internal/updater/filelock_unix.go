//go:build !windows

package updater

// isFileLocked always returns false on Unix — file locking is advisory,
// so writes are not blocked by other processes holding the file open.
func isFileLocked(_ error) bool { return false }
