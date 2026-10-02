//go:build linux || darwin

package securefs

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func openFileRead(base, relative string) (*os.File, error) {
	baseFD, err := openAbsoluteDir(base, false, 0)
	if err != nil {
		return nil, err
	}
	defer func() { _ = unix.Close(baseFD) }()
	parentFD, err := openRelativeDir(baseFD, filepath.Dir(relative), false, 0)
	if err != nil {
		return nil, err
	}
	defer func() { _ = unix.Close(parentFD) }()
	fd, err := unix.Openat(parentFD, filepath.Base(relative), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), filepath.Join(base, relative))
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	if !info.Mode().IsRegular() {
		_ = f.Close()
		return nil, fmt.Errorf("target is not a regular file: %q", relative)
	}
	return f, nil
}
