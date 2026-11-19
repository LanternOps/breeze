//go:build windows

package sessionbroker

import (
	"errors"
	"io/fs"
)

// fileIdentity is unavailable on Windows, where no Linux desktop endpoint
// is ever opened.
func fileIdentity(fs.FileInfo) (dev, ino uint64, uid uint32, ok bool) { return 0, 0, 0, false }

func defaultLinuxDesktopChown(string, uint32) error {
	return errors.New("linux desktop endpoints are not supported on Windows")
}
