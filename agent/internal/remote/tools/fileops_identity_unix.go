//go:build !windows

package tools

import (
	"errors"
	"io/fs"
	"os"
	"syscall"
)

// fileIdentity names a file independently of its path: device and inode on
// Unix, volume serial and file ID on Windows. Every hard link to a file
// shares it.
type fileIdentity struct {
	volume uint64
	idHigh uint64
	idLow  uint64
}

var errNoIdentity = errors.New("file identity is not available")

func identityFromInfo(info os.FileInfo) (fileIdentity, uint32, error) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fileIdentity{}, 0, errNoIdentity
	}
	links := uint32(st.Nlink)
	if !info.Mode().IsRegular() {
		links = 1 // only a regular file's link count says anything about other names
	}
	return fileIdentity{volume: uint64(st.Dev), idLow: uint64(st.Ino)}, links, nil
}

// identityOfOpenFile returns the identity and link count of an open file
// (the link count is 1 for anything but a regular file).
func identityOfOpenFile(f *os.File) (fileIdentity, uint32, error) {
	info, err := f.Stat()
	if err != nil {
		return fileIdentity{}, 0, err
	}
	return identityFromInfo(info)
}

// identityOfPath returns the identity of the regular file p names,
// following links. ok is false when p does not exist or is not a regular
// file; err reports any other failure to read it.
func identityOfPath(p string) (id fileIdentity, ok bool, err error) {
	info, err := os.Stat(p)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fileIdentity{}, false, nil
		}
		return fileIdentity{}, false, err
	}
	if !info.Mode().IsRegular() {
		return fileIdentity{}, false, nil
	}
	id, _, err = identityFromInfo(info)
	return id, err == nil, err
}

// deviceOfInfo returns the device a file lives on.
func deviceOfInfo(_ string, info fs.FileInfo) (uint64, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return uint64(st.Dev), true
}

// runsPrivileged reports whether the agent runs as root, so that a protected
// folder it cannot read is a gap rather than a folder it could not read
// through any name either.
func runsPrivileged() bool { return os.Geteuid() == 0 }
