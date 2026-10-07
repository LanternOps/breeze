//go:build linux

package tools

import (
	"fmt"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// finalPathOfFile reads the kernel's record of where an open descriptor
// points, which follows every symlink and bind mount already resolved by the
// open itself.
func finalPathOfFile(f *os.File) (string, error) {
	return os.Readlink(fmt.Sprintf("/proc/self/fd/%d", f.Fd()))
}

func linkCountOfFile(_ *os.File, info os.FileInfo) (uint32, error) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, errDiagUnsupported
	}
	return uint32(st.Nlink), nil
}

// mountIdentityOfFile names the mount an open descriptor lives on. A bind
// mount keeps the path spelling of its mountpoint in /proc/self/fd, so final
// path equality alone cannot see it; comparing the mount of the target with
// the mount of the approved root does. It needs statx's mount id (Linux 5.8+):
// the device number cannot tell two bind mounts of one filesystem apart, so a
// kernel without it refuses grant mode rather than falling back.
func mountIdentityOfFile(f *os.File) (string, error) {
	var stx unix.Statx_t
	if err := unix.Statx(int(f.Fd()), "", unix.AT_EMPTY_PATH, unix.STATX_MNT_ID, &stx); err != nil {
		return "", errDiagUnsupported
	}
	if stx.Mask&unix.STATX_MNT_ID == 0 {
		return "", errDiagUnsupported
	}
	return fmt.Sprintf("mnt:%d", stx.Mnt_id), nil
}

// diagOpenFlags is OR'd into the read-only open. O_NONBLOCK keeps a FIFO
// planted at an approved path (or swapped in after the listing) from blocking
// the open until a writer appears; the handle is then refused as a special
// file. It has no effect on regular files or directories.
const diagOpenFlags = unix.O_NONBLOCK
