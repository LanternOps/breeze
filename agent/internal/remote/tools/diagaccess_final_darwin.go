//go:build darwin

package tools

import (
	"bytes"
	"fmt"
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// finalPathOfFile uses fcntl(F_GETPATH), which reports the path of the vnode
// the descriptor is open on, with every symlink already resolved.
func finalPathOfFile(f *os.File) (string, error) {
	buf := make([]byte, unix.PathMax)
	_, _, errno := unix.Syscall(unix.SYS_FCNTL, f.Fd(), uintptr(unix.F_GETPATH), uintptr(unsafe.Pointer(&buf[0])))
	if errno != 0 {
		return "", errno
	}
	if i := bytes.IndexByte(buf, 0); i >= 0 {
		buf = buf[:i]
	}
	return string(buf), nil
}

func linkCountOfFile(_ *os.File, info os.FileInfo) (uint32, error) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, errDiagUnsupported
	}
	return uint32(st.Nlink), nil
}

// mountIdentityOfFile names the filesystem an open descriptor lives on, so a
// mounted volume inside an approved tree is not treated as part of it.
func mountIdentityOfFile(f *os.File) (string, error) {
	var st unix.Stat_t
	if err := unix.Fstat(int(f.Fd()), &st); err != nil {
		return "", err
	}
	return fmt.Sprintf("dev:%d", st.Dev), nil
}

// diagOpenFlags is OR'd into the read-only open. O_NONBLOCK keeps a FIFO
// planted at an approved path (or swapped in after the listing) from blocking
// the open until a writer appears; the handle is then refused as a special
// file. It has no effect on regular files or directories.
const diagOpenFlags = unix.O_NONBLOCK
