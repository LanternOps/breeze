//go:build windows

package helper

import "os"

// openNoFollow: syscall.O_NOFOLLOW does not exist on Windows, and creating a
// symlink there requires a privilege standard users lack, so this is a plain
// open. The size cap in readHelperConfig still bounds the read.
func openNoFollow(path string) (*os.File, error) {
	return os.Open(path)
}
