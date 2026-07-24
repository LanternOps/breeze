//go:build !windows

package state

import "os"

// renameReplace atomically replaces newpath with oldpath. On Unix os.Rename
// (rename(2)) already replaces an open destination atomically.
func renameReplace(oldpath, newpath string) error {
	return os.Rename(oldpath, newpath)
}
