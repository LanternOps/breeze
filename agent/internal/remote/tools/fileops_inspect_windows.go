//go:build windows

package tools

import (
	"os"
	"strings"

	"golang.org/x/sys/windows"
)

// openInspectHandle opens p for its attributes and final path. Device
// namespaces and reserved device names are refused earlier
// (localPathFormError), and the type is checked before and after the open.
func openInspectHandle(p string, _ bool) (*os.File, error) { return os.Open(p) }

// openScanFile opens a queued scan file for reading without following a
// reparse point at the leaf: the walk queues only plain files, so a file
// that is a reparse point (or a folder) when it is opened has changed since
// and is not read.
func openScanFile(p string) (*os.File, error) {
	long := p
	if len(long) >= 248 && !strings.HasPrefix(long, `\\`) {
		long = `\\?\` + long
	}
	name, err := windows.UTF16PtrFromString(long)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: p, Err: err}
	}
	h, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: p, Err: err}
	}
	var bi windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &bi); err != nil {
		_ = windows.CloseHandle(h)
		return nil, &os.PathError{Op: "stat", Path: p, Err: err}
	}
	if bi.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		_ = windows.CloseHandle(h)
		return nil, ErrScanSkipped
	}
	return os.NewFile(uintptr(h), p), nil
}
