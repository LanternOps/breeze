//go:build windows

package tools

import (
	"os"

	"golang.org/x/sys/windows"
)

// volumePathOfFile returns where the open file is on its volume, named by
// the volume's GUID (\\?\Volume{GUID}\path), whatever drive letter or mount
// folder reached it.
func volumePathOfFile(f *os.File) (string, bool) {
	p, err := finalPathOfHandleFlags(windows.Handle(f.Fd()), volumeNameGUID)
	if err != nil || p == "" {
		return "", false
	}
	return `\\?\` + p, true
}
