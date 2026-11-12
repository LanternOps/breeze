//go:build !windows

package tools

import (
	"errors"
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

// identityOfPath returns the identity of the file p names, following links.
func identityOfPath(p string) (fileIdentity, bool) {
	info, err := os.Stat(p)
	if err != nil || !info.Mode().IsRegular() {
		return fileIdentity{}, false
	}
	id, _, err := identityFromInfo(info)
	return id, err == nil
}
