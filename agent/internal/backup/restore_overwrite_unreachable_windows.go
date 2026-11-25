//go:build windows

package backup

import (
	"errors"
	"syscall"

	"golang.org/x/sys/windows"
)

// unreachableVolume reports a stat error saying the volume or share itself
// cannot be reached: a drive with no media or a locked volume, or a share
// whose name or server does not answer.
func unreachableVolume(err error) bool {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	switch windows.Errno(errno) {
	case windows.ERROR_NOT_READY, windows.ERROR_BAD_NET_NAME, windows.ERROR_NO_MEDIA_IN_DRIVE,
		windows.ERROR_UNRECOGNIZED_MEDIA, windows.ERROR_UNRECOGNIZED_VOLUME, windows.ERROR_INVALID_DRIVE,
		windows.ERROR_NETWORK_UNREACHABLE, windows.ERROR_BAD_NETPATH, windows.ERROR_NETNAME_DELETED:
		return true
	}
	return false
}
