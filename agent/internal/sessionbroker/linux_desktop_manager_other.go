//go:build !linux

package sessionbroker

import "errors"

// NewLinuxDesktopHelperManagerForHost exists only on Linux.
func NewLinuxDesktopHelperManagerForHost(*Broker, LinuxDesktopHooks) (*LinuxDesktopHelperManager, error) {
	return nil, errors.New("the Linux desktop helper runs on Linux only")
}
