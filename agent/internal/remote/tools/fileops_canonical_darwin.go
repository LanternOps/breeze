//go:build darwin

package tools

import (
	"bytes"
	"unsafe"

	"golang.org/x/sys/unix"
)

// canonicalExistingPath returns the spelling the filesystem itself uses for
// the existing path p. A case-insensitive APFS or HFS+ volume reaches one
// folder under many spellings ("Keychains", "KEYCHAINS", and others that
// differ only in characters the volume folds together), so a path string that
// went through filepath.EvalSymlinks can still differ from the deny-list's
// spelling. F_GETPATH on a descriptor reports the name stored on disk.
// O_EVTONLY opens without read access and O_NONBLOCK keeps a FIFO from
// blocking. If p cannot be opened, p is returned unchanged.
func canonicalExistingPath(p string) string {
	fd, err := unix.Open(p, unix.O_EVTONLY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return p
	}
	defer unix.Close(fd)
	buf := make([]byte, unix.PathMax)
	if _, _, errno := unix.Syscall(unix.SYS_FCNTL, uintptr(fd), uintptr(unix.F_GETPATH), uintptr(unsafe.Pointer(&buf[0]))); errno != 0 {
		return p
	}
	if i := bytes.IndexByte(buf, 0); i >= 0 {
		buf = buf[:i]
	}
	if len(buf) == 0 {
		return p
	}
	return string(buf)
}
