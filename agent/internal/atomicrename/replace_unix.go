//go:build !windows

package atomicrename

import "os"

// Replace atomically replaces newpath with oldpath. On Unix os.Rename
// (rename(2)) already replaces an open destination atomically.
func Replace(oldpath, newpath string) error {
	return os.Rename(oldpath, newpath)
}
