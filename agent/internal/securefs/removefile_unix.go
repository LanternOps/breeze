//go:build darwin || linux

package securefs

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"golang.org/x/sys/unix"
)

// RemoveRegularFileNoFollow unlinks dir/name only when name is a regular
// file, without following a symlink at either level: dir is opened with
// O_NOFOLLOW (so a directory swapped for a symlink is refused rather than
// traversed), and name is inspected and unlinked relative to that open
// descriptor. A symlink or anything other than a regular file at name is
// left in place and reported as an error. A missing name returns an error
// satisfying errors.Is(err, os.ErrNotExist).
//
// It exists for cleaning up stale binaries in a directory that a non-root
// identity may be able to write (the macOS /usr/local/bin left behind after
// a relocation, #7211): there, a path-based os.Remove could be steered into
// deleting a same-named file somewhere else.
func RemoveRegularFileNoFollow(dir, name string) error {
	if name == "" || name == "." || name == ".." || strings.ContainsRune(name, '/') {
		return fmt.Errorf("invalid file name %q", name)
	}
	dirFD, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
			return fmt.Errorf("%s is not a real directory; refusing to remove %s from it", dir, name)
		}
		return &os.PathError{Op: "open", Path: dir, Err: err}
	}
	defer unix.Close(dirFD)

	var st unix.Stat_t
	if err := unix.Fstatat(dirFD, name, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return &os.PathError{Op: "lstat", Path: dir + "/" + name, Err: err}
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return fmt.Errorf("%s/%s is not a regular file; refusing to remove it", dir, name)
	}
	if err := unix.Unlinkat(dirFD, name, 0); err != nil {
		return &os.PathError{Op: "unlink", Path: dir + "/" + name, Err: err}
	}
	return nil
}
